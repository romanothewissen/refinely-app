import type {
  ActorSetGrounding,
  ClarifyAnswer,
  ClarifyContextMeta,
  ClarifyCategoryKey,
  ClarifyQuestion,
  DiscoveryAssessment,
  DiscoveryDepth,
  DiscoveryDimensionLevel,
  DiscoveryProfile,
  Feature,
  GenerationResult,
  GenerationStageDurationsMs,
  PipelineProfile,
  TenantConfig,
  TokenUsageSummary,
  SimilarStory,
  WorkInstructionInsightArtifact,
} from '../types';
import { getTierModel } from '../services/billing';
import { callLlmJsonWithUsage, mapReasoningDepthToEffort } from './llm';
import {
  buildCoverageMapSystemPrompt,
  buildPerFeatureArSystemPrompt,
  buildStoryAssistantArSystemPrompt,
  buildStoryAssistantClarifySystemPrompt,
  buildStoryAssistantDecompositionSystemPrompt,
  buildStoryAssistantSufficiencySystemPrompt,
} from './prompts';
import { validateFeatures } from './quality-validator';
import { buildDiscoveryCoverageArtifact, selectDiverseInitialQuestions } from './discovery';
import { buildStoryAssistantModelRoute, resolveStoryAssistantPipelineProfile } from '../services/model-strategy';
import { formatSimilarStoriesText } from './similar-stories';
import {
  annotateFailedAcceptanceRequirementFeatures,
  findFeaturesMissingCompleteAcceptanceRequirements,
  GenerationCancelledError,
  normaliseFeature,
} from './feature-output';

interface RawFeature {
  id?: string;
  summary?: string;
  description?: string;
  acceptance_requirements?: unknown[];
  acceptanceRequirements?: unknown[];
  suggested_story_points?: number;
  process_code?: string;
}

interface RawQuestionCandidate {
  category?: unknown;
  categoryKey?: unknown;
  intent?: unknown;
  question?: unknown;
  details?: unknown;
  suggestions?: unknown[];
}

export interface StoryAssistantClarifyResult {
  questions: ClarifyQuestion[];
  tokenUsage: TokenUsageSummary;
  discoveryProfile: DiscoveryProfile;
  discoveryAssessment: DiscoveryAssessment;
  coverageQualityScore?: number;
  coverageRetryTriggered?: boolean;
  ambiguityAssessment: {
    level: 'clear' | 'medium' | 'vague';
    score: number;
    reasons: string[];
    questionPlan: { min: number; max: number; target: number };
    generatedQuestions: number;
  };
}

export interface StoryAssistantSufficiencyResult {
  sufficient: boolean;
  status: 'ask_followup' | 'ready_to_generate' | 'ready_with_open_decisions';
  questions?: ClarifyQuestion[];
  missingCategoryKeys: ClarifyQuestion['categoryKey'][];
  reasonCodes: string[];
  coverageArtifact: ReturnType<typeof buildDiscoveryCoverageArtifact>;
  warning?: string;
  tokenUsage: TokenUsageSummary;
  durationMs: number;
}

export interface StoryAssistantGenerationResult {
  features: Feature[];
  tokenUsage: TokenUsageSummary;
  stageDurationsMs: GenerationStageDurationsMs;
  failedFeatureIds?: string[];
}

const STORY_ASSISTANT_CATEGORY_LABELS: Record<string, ClarifyCategoryKey> = {
  'roles & personas': 'user_personas',
  'roles and personas': 'user_personas',
  'roles': 'user_personas',
  'personas': 'user_personas',
  'trigger & context': 'context_trigger',
  'trigger and context': 'context_trigger',
  'context & trigger': 'context_trigger',
  'context and trigger': 'context_trigger',
  'functional flow': 'functional_flow',
  'business rules & exceptions': 'business_rules',
  'business rules and exceptions': 'business_rules',
  'business rules': 'business_rules',
  'success & measurement': 'success_measurement',
  'success and measurement': 'success_measurement',
  'success': 'success_measurement',
};

function storyAssistantQuestionRange(
  pipelineProfile: PipelineProfile,
  complexity: DiscoveryDimensionLevel = 'medium',
): { targetMin: number; targetMax: number; lowerBound: number; hardCap: number } {
  const base = (() => {
    switch (pipelineProfile) {
      case 'fast':
        return { targetMin: 4, targetMax: 7, lowerBound: 3, hardCap: 8 };
      case 'quality':
        return { targetMin: 14, targetMax: 18, lowerBound: 10, hardCap: 20 };
      default:
        return { targetMin: 8, targetMax: 12, lowerBound: 6, hardCap: 14 };
    }
  })();
  const mult = complexity === 'high' ? 1.5 : complexity === 'low' ? 0.75 : 1.0;
  return {
    lowerBound: base.lowerBound,
    targetMin: Math.round(base.targetMin * mult),
    targetMax: Math.round(base.targetMax * mult),
    hardCap: Math.min(24, Math.round(base.hardCap * mult)),
  };
}

function storyAssistantFollowupCap(pipelineProfile: PipelineProfile): number {
  switch (pipelineProfile) {
    case 'quality':
      return 5;
    case 'fast':
      return 2;
    default:
      return 3;
  }
}

type GenericDiscoveryCoverageKey =
  | 'scope_trigger'
  | 'actors_handoffs'
  | 'flow_dependencies'
  | 'rules_exceptions'
  | 'state_progress'
  | 'success_validation';

const GENERIC_DISCOVERY_COVERAGE_ORDER: GenericDiscoveryCoverageKey[] = [
  'scope_trigger',
  'actors_handoffs',
  'flow_dependencies',
  'rules_exceptions',
  'state_progress',
  'success_validation',
];

const GENERIC_DISCOVERY_COVERAGE_LABELS: Record<GenericDiscoveryCoverageKey, string> = {
  scope_trigger: 'scope or trigger',
  actors_handoffs: 'actors or handoffs',
  flow_dependencies: 'flow or dependencies',
  rules_exceptions: 'rules or exceptions',
  state_progress: 'state or progress',
  success_validation: 'success or validation',
};

function buildProviderOpts(config: TenantConfig) {
  return {
    provider: config.generatorConfig.provider,
    geminiApiKey: config.generatorConfig.geminiApiKey,
    geminiBaseUrl: config.generatorConfig.geminiBaseUrl,
    openaiApiKey: config.generatorConfig.openaiApiKey,
    openaiBaseUrl: config.generatorConfig.openaiBaseUrl,
    azureOpenAIApiKey: config.generatorConfig.azureOpenAIApiKey,
    azureOpenAIBaseUrl: config.generatorConfig.azureOpenAIBaseUrl,
    azureOpenAIApiVersion: config.generatorConfig.azureOpenAIApiVersion,
    modelCatalogs: config.generatorConfig.modelCatalogs,
    piiMaskingEnabled: Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled),
  } as const;
}

function toStageUsage(usage: { input: number; output: number }) {
  return {
    input: usage.input,
    output: usage.output,
    total: usage.input + usage.output,
  };
}

function buildTokenUsageSummary(stages: Record<string, { input: number; output: number }>): TokenUsageSummary {
  const input = Object.values(stages).reduce((sum, stage) => sum + stage.input, 0);
  const output = Object.values(stages).reduce((sum, stage) => sum + stage.output, 0);
  return {
    input,
    output,
    total: input + output,
    byStage: Object.fromEntries(
      Object.entries(stages).map(([stage, usage]) => [stage, toStageUsage(usage)]),
    ),
  };
}

function cleanText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value: unknown): string {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function ensureQuestionMark(value: string): string {
  const trimmed = cleanText(value).replace(/[?.!]+$/g, '');
  return trimmed ? `${trimmed}?` : '';
}

function isLikelyTruncatedQuestion(value: string): boolean {
  const trimmed = cleanText(value);
  if (!trimmed) return true;
  if (trimmed.length < 12) return true;
  if (!/[?.!]$/.test(trimmed)) return true;
  return /\b(and|or|to|for|with|about|when|where|must|should)\?$/.test(trimmed.toLowerCase());
}

function isLikelyTruncatedSuggestion(value: string): boolean {
  const trimmed = cleanText(value);
  if (!trimmed) return true;
  if (trimmed.length < 2) return true;
  if (!/[a-z]/i.test(trimmed)) return true;
  return /\b(of|to|for|with|from|by|when|where|if|and|or|the|a|an)$/i.test(trimmed);
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const cleaned = cleanText(value);
    if (!cleaned) return;
    const key = normalizeKey(cleaned);
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(cleaned);
  });
  return result;
}

function trimPromptText(text: string, maxChars: number): string {
  const normalized = String(text ?? '').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}\n...[truncated for speed]`;
}

function trimPromptTextAtBoundary(text: string, maxChars: number): string {
  const normalized = String(text ?? '').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  const sliced = normalized.slice(0, maxChars);
  const boundary = Math.max(
    sliced.lastIndexOf('\n\n'),
    sliced.lastIndexOf('. '),
    sliced.lastIndexOf('? '),
    sliced.lastIndexOf('! '),
  );
  if (boundary > Math.floor(maxChars * 0.6)) {
    return `${sliced.slice(0, boundary + 1).trimEnd()}\n...[truncated for speed]`;
  }
  return `${sliced.trimEnd()}\n...[truncated for speed]`;
}

function normalizeEvidenceMultiline(text: string): string {
  const cleaned = String(text ?? '')
    .replace(/\r/g, '')
    .replace(/-\n\s*/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!cleaned) return '';
  const seen = new Set<string>();
  const lines = cleaned
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const key = normalizeKey(line);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return lines.join('\n');
}

function mergeRequirementAndAttachment(requirement: string, attachmentText: string): string {
  const cleanedRequirement = cleanText(requirement);
  const cleanedAttachment = String(attachmentText ?? '').trim();
  if (!cleanedAttachment) return cleanedRequirement;
  return `Context from attachment:\n\n${cleanedAttachment}\n\nRequirement: ${cleanedRequirement}`;
}

function formatClarifyAnswers(answers: ClarifyAnswer[]): string {
  if (!answers.length) return '';
  return answers
    .map((answer) => `Q: ${cleanText(answer.question)}\nA: ${cleanText(answer.answer) || '(not answered)'}`)
    .join('\n\n');
}

function stripChoicePrefix(value: string): string {
  return cleanText(value)
    .replace(/^chosen answer:\s*/i, '')
    .replace(/^selected answer:\s*/i, '')
    .replace(/^[*-]\s*/, '');
}

function normalizeQuestionContext(value: string): string {
  return normalizeKey(value).replace(/\s+/g, ' ');
}

function splitRoleValue(value: string): string[] {
  return stripChoicePrefix(value)
    .split(/\s*(?:\n|,|;|\||\bor\b)\s*/gi)
    .map((part) => cleanText(part))
    .filter(Boolean);
}

function isNegativeRolePhrase(value: string): boolean {
  return /^(?:none|no one|nobody|not applicable|n\/a|na|never|unknown|no formal approval is typically needed)$/i.test(value);
}

function isReferentialRolePhrase(value: string): boolean {
  return /\b(?:same person|same role|person who|role that|creator|plan creator|case owner|record owner|owner of the case)\b/i.test(value);
}

function looksLikeRolePhrase(value: string): boolean {
  const cleaned = stripChoicePrefix(value).replace(/\.$/, '');
  if (!cleaned || cleaned.length < 3 || cleaned.length > 80) return false;
  if (/[?!]/.test(cleaned)) return false;
  if (/^(?:just|only|simply|merely|primarily|mainly|n\/a|na|not needed|nothing|no\s)/i.test(cleaned)) return false;
  if (isNegativeRolePhrase(cleaned)) return false;
  if (isReferentialRolePhrase(cleaned)) return false;
  if (/^(?:only if|if |when |unless |because |after |before |during |while |depends\b)/i.test(cleaned)) return false;
  if (/^(?:no |not |without |none )/i.test(cleaned)) return false;
  if (/\b(?:approval|approvals?)\b/i.test(cleaned) && !/\b(?:manager|lead|owner|team|specialist|coordinator|administrator|reviewer)\b/i.test(cleaned)) return false;
  if (/\b(?:formal approval|payment authorization|required approval|billable)\b/i.test(cleaned)) return false;
  if (/\b(?:billable|workflow|sequence|step|save|complete|required information|conditions?)\b/i.test(cleaned) && !/\bteam\b/i.test(cleaned)) return false;
  if (!/[A-Za-z]/.test(cleaned)) return false;
  return true;
}

function buildActorAliasMap(requirement: string, answers: ClarifyAnswer[]): Map<string, string> {
  const aliasMap = new Map<string, string>();
  const requirementRoles: string[] = [];
  const roleRegex = /\bas\s+an?\s+([A-Za-z][A-Za-z ,/-]{2,60}?)(?:\s*[,.]|\s+(?:i|we|they|who|that|the)\b)/gi;
  for (const match of requirement.matchAll(roleRegex)) {
    const role = stripChoicePrefix(match[1] ?? '').replace(/\.$/, '');
    if (looksLikeRolePhrase(role)) {
      requirementRoles.push(role);
    }
  }
  if (requirementRoles.length === 1) {
    aliasMap.set('creator', requirementRoles[0]!);
  }

  answers.forEach((answer) => {
    const questionContext = normalizeQuestionContext(`${answer.categoryKey ?? ''} ${answer.question}`);
    const directRoles = [
      ...(answer.selectedSuggestions ?? []),
      String(answer.customAnswer ?? '').trim(),
      cleanText(answer.answer),
    ]
      .flatMap((value) => splitRoleValue(String(value ?? '')))
      .map((value) => stripChoicePrefix(value).replace(/\.$/, ''))
      .filter(looksLikeRolePhrase);

    if (!directRoles.length) return;
    const primaryRole = directRoles[0]!;

    if (/\bcreate(?:s|d|r)?\b.*\bplan\b|\bplan\b.*\bcreate(?:s|d|r)?\b/.test(questionContext)) {
      aliasMap.set('plan creator', primaryRole);
      aliasMap.set('the plan creator', primaryRole);
      aliasMap.set('same person who created the plan', primaryRole);
      aliasMap.set('person who created the plan', primaryRole);
      aliasMap.set('creator', primaryRole);
    }
    if (/\bcase owner\b|\bowner of the case\b|\bwho owns the case\b/.test(questionContext)) {
      aliasMap.set('case owner', primaryRole);
      aliasMap.set('the case owner', primaryRole);
      aliasMap.set('owner of the case', primaryRole);
    }
  });

  return aliasMap;
}

function resolveReferentialRoleValue(value: string, aliasMap: Map<string, string>): string | null {
  const cleaned = stripChoicePrefix(value).replace(/\.$/, '');
  if (!cleaned || !isReferentialRolePhrase(cleaned)) return null;

  const normalized = normalizeKey(cleaned);
  const direct = aliasMap.get(normalized);
  if (direct) return direct;

  if (normalized.includes('same person who created the plan') || normalized.includes('plan creator')) {
    return aliasMap.get('same person who created the plan') ?? aliasMap.get('plan creator') ?? aliasMap.get('creator') ?? null;
  }

  if (normalized.includes('case owner') || normalized.includes('owner of the case')) {
    return aliasMap.get('case owner') ?? aliasMap.get('owner of the case') ?? null;
  }

  return null;
}

function extractRoleValues(answer: ClarifyAnswer, aliasMap: Map<string, string>): string[] {
  const structuredRoleValues = [
    ...(answer.selectedSuggestions ?? []),
    String(answer.customAnswer ?? '').trim(),
  ]
    .flatMap((value) => splitRoleValue(String(value ?? '')))
    .map((value) => resolveReferentialRoleValue(String(value ?? ''), aliasMap) ?? stripChoicePrefix(String(value ?? '')).replace(/\.$/, ''))
    .filter(looksLikeRolePhrase);

  if (structuredRoleValues.length) return structuredRoleValues;
  return splitRoleValue(cleanText(answer.answer))
    .map((value) => resolveReferentialRoleValue(value, aliasMap) ?? value)
    .filter(looksLikeRolePhrase);
}

export function extractRoles(requirement: string, answers: ClarifyAnswer[] = []): string[] {
  const seen = new Set<string>();
  const roles: string[] = [];
  const aliasMap = buildActorAliasMap(requirement, answers);

  const addRole = (value: string) => {
    const cleaned = stripChoicePrefix(value).replace(/\.$/, '');
    if (!looksLikeRolePhrase(cleaned)) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    roles.push(cleaned);
  };

  answers.forEach((answer) => {
    const question = `${answer.categoryKey ?? ''} ${answer.question}`.toLowerCase();
    if (!/role|persona|who\b|actor/.test(question)) return;
    extractRoleValues(answer, aliasMap).forEach(addRole);
  });

  const roleRegex = /\bas\s+an?\s+([A-Za-z][A-Za-z ,/-]{2,60}?)(?:\s*[,.]|\s+(?:i|we|they|who|that|the)\b)/gi;
  for (const match of requirement.matchAll(roleRegex)) {
    addRole(match[1] ?? '');
  }

  return roles;
}

export function extractActorSets(requirement: string, answers: ClarifyAnswer[] = []): ActorSetGrounding {
  const eligibleActors: string[] = [];
  const approverActors: string[] = [];
  const viewerActors: string[] = [];
  const aliasMap = buildActorAliasMap(requirement, answers);

  answers.forEach((answer) => {
    const question = `${answer.categoryKey ?? ''} ${answer.question}`.toLowerCase();
    if (!/role|persona|who\b|actor|approve|review|view|see|track|receive|monitor/.test(question)) return;
    const values = extractRoleValues(answer, aliasMap);
    if (!values.length) return;
    if (/\bapprove|approval|review|sign off|authori[sz]/.test(question)) {
      approverActors.push(...values);
      return;
    }
    if (/\bview|see|track|receive|monitor|notification|status/.test(question)) {
      viewerActors.push(...values);
      return;
    }
    eligibleActors.push(...values);
  });

  const mentionedActors = uniqueStrings([
    ...extractRoles(requirement, answers),
    ...eligibleActors,
    ...approverActors,
    ...viewerActors,
  ]);

  return {
    ...(eligibleActors.length ? { eligibleActors: uniqueStrings(eligibleActors) } : {}),
    ...(approverActors.length ? { approverActors: uniqueStrings(approverActors) } : {}),
    ...(viewerActors.length ? { viewerActors: uniqueStrings(viewerActors) } : {}),
    ...(mentionedActors.length ? { mentionedActors } : {}),
  };
}

function buildRoleHint(
  domainRoles: string[] | undefined,
  requirement: string,
  answers: ClarifyAnswer[],
  actorSets: ActorSetGrounding,
): string {
  const extractedRoles = uniqueStrings(actorSets.mentionedActors ?? extractRoles(requirement, answers)).filter(looksLikeRolePhrase);
  const fallbackRoles = uniqueStrings(domainRoles ?? []).filter(looksLikeRolePhrase);
  const roleVocabulary = extractedRoles.length ? extractedRoles : fallbackRoles;

  if (!roleVocabulary.length) return '';

  const quoted = roleVocabulary.map((role) => `"${role}"`).join(', ');
  if (roleVocabulary.length === 1) {
    return `ROLE CONSTRAINT: Every feature description must use exactly ${quoted} as the role — verbatim, no paraphrasing or abbreviation.`;
  }
  return `ROLE CONSTRAINT: Assign the most appropriate role to each feature from this exact list: ${quoted}. Use these names verbatim — do not invent, paraphrase, or combine role names. Different features may use different roles from this list.`;
}

function formatWiEvidence(
  wiInsightsArtifact: WorkInstructionInsightArtifact | null | undefined,
  wiContextText: string,
  maxChars = 8200,
): string {
  const sourceExcerptCap = Math.min(5200, Math.max(1600, Math.floor(maxChars * 0.6)));
  const normalizedContext = normalizeEvidenceMultiline(wiContextText);
  const insightSections = wiInsightsArtifact
    ? ([
        ['Workflow signals', wiInsightsArtifact.workflowSteps],
        ['Business rules', wiInsightsArtifact.businessRules],
        ['Sequencing', wiInsightsArtifact.sequencingRules],
        ['Exceptions', wiInsightsArtifact.exceptions],
        ['Must-cover behaviors', wiInsightsArtifact.mustCoverBehaviors],
      ] as Array<[string, WorkInstructionInsightArtifact['workflowSteps']]>)
        .map(([label, items]) => {
          const lines = items
            .slice(0, 5)
            .map((item) => cleanText(item.text))
            .filter(Boolean);
          return lines.length ? `${label}:\n- ${lines.join('\n- ')}` : '';
        })
        .filter(Boolean)
    : [];

  const parts: string[] = [];
  if (insightSections.length) {
    parts.push(insightSections.join('\n\n'));
  }
  if (normalizedContext) {
    parts.push(`Source excerpts from Work Instructions:\n${trimPromptTextAtBoundary(normalizedContext, sourceExcerptCap)}`);
  }
  if (!parts.length) return '';
  return trimPromptTextAtBoundary(parts.join('\n\n'), maxChars);
}

function formatDiscoveryBacklogEvidence(similarStories: SimilarStory[] = []): string {
  if (!similarStories.length) return '';
  const deduped: SimilarStory[] = [];
  const seen = new Set<string>();
  for (const story of similarStories) {
    const key = normalizeKey(`${story.summary} ${story.description ?? ''}`);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(story);
  }
  const formatted = formatSimilarStoriesText(deduped, 4);
  return trimPromptTextAtBoundary(normalizeEvidenceMultiline(formatted), 4200);
}

function formatGenerationBacklogEvidence(similarStories: SimilarStory[] = []): string {
  if (!similarStories.length) return '';
  const formatted = formatSimilarStoriesText(similarStories, 3);
  return trimPromptText(formatted, 3000);
}

function extractMustCarryRules(answers: ClarifyAnswer[]): string[] {
  return answers
    .filter((answer) => {
      const answerText = cleanText(answer.answer);
      if (!answerText) return false;
      return ['functional_flow', 'business_rules', 'state_lifecycle', 'success_measurement'].includes(answer.categoryKey ?? '');
    })
    .map((answer) => `${cleanText(answer.question)} => ${cleanText(answer.answer)}`)
    .filter(Boolean)
    .slice(0, 8);
}

function buildDiscoveryHandoff(input: {
  answers: ClarifyAnswer[];
  actorSets: ActorSetGrounding;
  discoveryProfile?: DiscoveryProfile;
}): string {
  const coverageArtifact = input.discoveryProfile?.coverageArtifact;
  const parts: string[] = [];
  const mustCarryRules = extractMustCarryRules(input.answers);
  if (mustCarryRules.length) {
    parts.push('Must-carry rules and workflow details from answered discovery:');
    mustCarryRules.forEach((rule) => parts.push(`- ${rule}`));
  }
  if (coverageArtifact?.openNonBlockingDecisions?.length) {
    parts.push('Open decisions that must remain open rather than silently assumed:');
    coverageArtifact.openNonBlockingDecisions.slice(0, 6).forEach((decision) => parts.push(`- ${decision}`));
  }
  return parts.length ? parts.join('\n') : '';
}

function buildClarifyUserMessage(input: {
  requirement: string;
  attachmentText: string;
  wiEvidenceText: string;
  similarStoriesText?: string;
  domainRoles?: string[];
}) {
  const mergedRequirement = mergeRequirementAndAttachment(input.requirement, input.attachmentText);
  const parts = [`Requirement: ${trimPromptText(mergedRequirement, 16000)}`];
  const roleVocabulary = uniqueStrings(input.domainRoles ?? []).slice(0, 10);
  if (roleVocabulary.length) {
    parts.push(`Runtime role vocabulary (reuse these labels verbatim when relevant): ${roleVocabulary.join(', ')}`);
  }
  if (input.wiEvidenceText.trim()) {
    parts.push(`Operational evidence from Work Instructions (use to ask sharper, process-grounded questions):\n${input.wiEvidenceText}`);
  }
  if (input.similarStoriesText?.trim()) {
    parts.push(`Relevant backlog references from this workspace (use to understand how this team usually frames good scope; do not copy unrelated details):\n${input.similarStoriesText}`);
  }
  return parts.join('\n\n');
}

function buildSufficiencyUserMessage(input: {
  requirement: string;
  answers: ClarifyAnswer[];
  attachmentText?: string;
  wiEvidenceText?: string;
  similarStoriesText?: string;
}) {
  const mergedRequirement = mergeRequirementAndAttachment(input.requirement, input.attachmentText ?? '');
  const parts = [
    `Requirement: ${trimPromptText(mergedRequirement, 12000)}`,
    `Questions and answers so far:\n${formatClarifyAnswers(input.answers) || '(none)'}`,
  ];
  if (input.wiEvidenceText?.trim()) {
    parts.push(`Operational evidence from Work Instructions:\n${input.wiEvidenceText}`);
  }
  if (input.similarStoriesText?.trim()) {
    parts.push(`Relevant backlog references from this workspace:\n${input.similarStoriesText}`);
  }
  return parts.join('\n\n');
}

function buildGenerationContextMessage(input: {
  requirement: string;
  clarifyAnswers: ClarifyAnswer[];
  attachmentText: string;
  wiEvidenceText: string;
  roleHint: string;
  discoveryProfile?: DiscoveryProfile;
  actorSets: ActorSetGrounding;
  similarStoriesText?: string;
  arPatternLibraryText?: string;
}) {
  const mergedRequirement = mergeRequirementAndAttachment(input.requirement, input.attachmentText);
  const parts = [`Requirement: ${trimPromptText(mergedRequirement, 16000)}`];
  if (input.roleHint.trim()) {
    parts.push(input.roleHint);
  }
  const discoveryHandoff = buildDiscoveryHandoff({
    answers: input.clarifyAnswers,
    actorSets: input.actorSets,
    discoveryProfile: input.discoveryProfile,
  });
  if (discoveryHandoff.trim()) {
    parts.push(discoveryHandoff);
  }
  if (input.clarifyAnswers.length) {
    parts.push(`Stakeholder clarifications — use these to sharpen feature scope and user roles. Translate answers into business capabilities; do not copy answer text verbatim into descriptions or acceptance requirements:\n${formatClarifyAnswers(input.clarifyAnswers)}`);
  }
  if (input.wiEvidenceText.trim()) {
    parts.push(`Operational evidence from Work Instructions:\n${input.wiEvidenceText}`);
  }
  if (input.similarStoriesText?.trim()) {
    parts.push(`Relevant backlog references from this workspace (scope and phrasing calibration only):\n${input.similarStoriesText}`);
  }
  if (input.arPatternLibraryText?.trim()) {
    parts.push(input.arPatternLibraryText);
  }
  return parts.join('\n\n');
}

function inferCategoryKey(question: string): ClarifyCategoryKey {
  const normalized = cleanText(question).toLowerCase();
  if (/\bwho\b|\brole\b|\bpersona\b|\bowner\b|\bapproval\b|\bescalation\b/.test(normalized)) {
    return 'user_personas';
  }
  if (/\bmeasure\b|\bmetric\b|\bsuccess\b|\btester\b|\buat\b|\bworking correctly\b/.test(normalized)) {
    return 'success_measurement';
  }
  if (/\bstatus\b|\blifecycle\b|\btransition\b|\breopen\b|\bretry\b/.test(normalized)) {
    return 'state_lifecycle';
  }
  if (/\bsequence\b|\border\b|\bstep\b|\bbranch\b|\bpath\b|\bfinal output\b|\bstate after\b/.test(normalized)) {
    return 'functional_flow';
  }
  if (/\bvalidation\b|\brule\b|\bexception\b|\bthreshold\b|\bconstraint\b|\bcontract\b|\bcompliance\b/.test(normalized)) {
    return 'business_rules';
  }
  return 'context_trigger';
}

const STRONG_CATEGORY_SIGNALS: Array<[ClarifyCategoryKey, RegExp]> = [
  ['success_measurement', /\b(success|successful|how (would|will) we know|measure|metric|uat|acceptance test|definition of done|kpi|validate( success)?)\b/i],
  ['state_lifecycle', /\b(status|lifecycle|state (machine|transition)|reopen|resume|retry( logic)?)\b/i],
];

function mapCategoryKey(category: unknown, question: string): ClarifyCategoryKey {
  for (const [key, re] of STRONG_CATEGORY_SIGNALS) {
    if (re.test(question)) return key;
  }
  const normalizedCategory = normalizeKey(category);
  if (normalizedCategory && STORY_ASSISTANT_CATEGORY_LABELS[normalizedCategory]) {
    return STORY_ASSISTANT_CATEGORY_LABELS[normalizedCategory];
  }
  return inferCategoryKey(question);
}

export function splitClearlyNumberedStoryAssistantQuestion(question: string): string[] {
  const normalized = cleanText(question);
  if (!normalized) return [];

  const markerRegex = /(?:^|\s)(\d+)\.\s*/g;
  const markers = [...normalized.matchAll(markerRegex)];
  if (markers.length < 2) return [normalized];

  const firstMatch = markers[0];
  if (!firstMatch || firstMatch.index == null) return [normalized];
  const prefix = cleanText(normalized.slice(0, firstMatch.index));
  const segments: string[] = [];

  markers.forEach((match, index) => {
    if (match.index == null) return;
    const segmentStart = match.index + match[0].length;
    const nextStart = index + 1 < markers.length && markers[index + 1].index != null
      ? markers[index + 1].index
      : normalized.length;
    const segmentBody = cleanText(normalized.slice(segmentStart, nextStart));
    if (!segmentBody) return;
    const combined = cleanText(`${prefix ? `${prefix} ` : ''}${segmentBody}`);
    if (combined) segments.push(combined);
  });

  return segments.length >= 2 ? segments : [normalized];
}

function normalizeSuggestions(values: unknown[], min = 0, max = 3): string[] {
  return uniqueStrings(values)
    .map((value) => cleanText(value).replace(/[?.!]+$/g, ''))
    .filter((value) => !isLikelyTruncatedSuggestion(value))
    .filter(Boolean)
    .slice(0, Math.max(min, max));
}

function questionMatchesRegex(question: ClarifyQuestion, pattern: RegExp): boolean {
  return pattern.test(`${question.question} ${(question.details ?? '')} ${(question.suggestions ?? []).join(' ')}`.toLowerCase());
}

function questionMatchesGenericCoverage(question: ClarifyQuestion, coverageKey: GenericDiscoveryCoverageKey): boolean {
  switch (coverageKey) {
    case 'scope_trigger':
      return question.categoryKey === 'context_trigger'
        || questionMatchesRegex(question, /\b(trigger|start|begin|when should|what makes|precondition|must already|before.*act|scope|in scope|out of scope|applies)\b/);
    case 'actors_handoffs':
      return question.categoryKey === 'user_personas'
        || questionMatchesRegex(question, /\b(who|role|team|actor|approval|approve|handoff|escalation|notification|consult|input from|responsible|authorized)\b/);
    case 'flow_dependencies':
      return question.categoryKey === 'functional_flow'
        || question.categoryKey === 'state_lifecycle'
        || questionMatchesRegex(question, /\b(sequence|dependency|dependent|order|before|after|step|branch|path|triggered as|all at once|preceding|downstream)\b/);
    case 'rules_exceptions':
      return question.categoryKey === 'business_rules'
        || questionMatchesRegex(question, /\b(rule|validation|allowed|prevent|warning|constraint|exception|unavailable|blocked|hold|contract|entitlement|covered|billable|mixed)\b/);
    case 'state_progress':
      return question.categoryKey === 'state_lifecycle'
        || questionMatchesRegex(question, /\b(status|progress|track|visibility|visible|stage|lifecycle|reopen|retry|reverse)\b/);
    case 'success_validation':
      return question.categoryKey === 'success_measurement'
        || questionMatchesRegex(question, /\b(success|tester|uat|working correctly|measure|metric|improvement|confirm)\b/);
    default:
      return false;
  }
}

function requiredGenericCoverageKeys(assessment: DiscoveryAssessment): GenericDiscoveryCoverageKey[] {
  const required = new Set<GenericDiscoveryCoverageKey>();
  if (assessment.ambiguityLevel !== 'low' || assessment.discoveryDepth !== 'light') required.add('scope_trigger');
  if (assessment.actorComplexity !== 'low' || assessment.discoveryDepth === 'deep') required.add('actors_handoffs');
  if (assessment.workflowComplexity !== 'low' || assessment.lifecycleComplexity !== 'low') required.add('flow_dependencies');
  if (assessment.ruleDensity !== 'low' || assessment.exceptionDensity !== 'low') required.add('rules_exceptions');
  if (assessment.lifecycleComplexity !== 'low') required.add('state_progress');
  if (assessment.discoveryDepth !== 'light' || assessment.ambiguityLevel !== 'low') required.add('success_validation');
  return GENERIC_DISCOVERY_COVERAGE_ORDER.filter((key) => required.has(key));
}

function missingGenericCoverageKeys(
  questions: ClarifyQuestion[],
  assessment: DiscoveryAssessment,
): GenericDiscoveryCoverageKey[] {
  const required = requiredGenericCoverageKeys(assessment);
  return required.filter((coverageKey) => !questions.some((question) => questionMatchesGenericCoverage(question, coverageKey)));
}

export function finalizeStoryAssistantDiscoveryQuestions(
  questions: ClarifyQuestion[],
  assessment: DiscoveryAssessment,
): ClarifyQuestion[] {
  const hardCap = 25;
  const softMax = Math.max(1, assessment.recommendedQuestionRange.max);
  const keepUpTo = Math.min(hardCap, softMax + 2);
  if (questions.length <= keepUpTo) return questions;
  return selectDiverseInitialQuestions(questions, keepUpTo);
}

function normalizeDiscoveryDepth(value: unknown): DiscoveryDepth {
  const normalized = normalizeKey(value);
  if (normalized === 'light' || normalized === 'standard' || normalized === 'deep') {
    return normalized;
  }
  return 'standard';
}

function normalizeDimensionLevel(value: unknown): 'low' | 'medium' | 'high' {
  const normalized = normalizeKey(value);
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') return normalized;
  return 'medium';
}

function normalizeRecommendedQuestionRange(
  value: unknown,
  depth: DiscoveryDepth,
): { min: number; max: number } {
  const fallback = depth === 'light'
    ? { min: 3, max: 5 }
    : depth === 'deep'
      ? { min: 10, max: 20 }
      : { min: 6, max: 12 };
  if (!value || typeof value !== 'object') return fallback;
  const candidate = value as { min?: unknown; max?: unknown };
  const min = Number.isFinite(candidate.min) ? Math.max(1, Math.round(Number(candidate.min))) : fallback.min;
  const max = Number.isFinite(candidate.max) ? Math.max(min, Math.round(Number(candidate.max))) : fallback.max;
  return {
    min: Math.min(min, 25),
    max: Math.min(Math.max(max, min), 25),
  };
}

function normalizeCoverageObligations(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [];
  return uniqueStrings(raw)
    .map((item) => normalizeKey(item).replace(/\s+/g, '_'))
    .filter(Boolean)
    .slice(0, 10);
}

function buildEvidenceThemeSummary(
  requirement: string,
  attachmentText: string,
  wiEvidenceText: string,
  similarStoriesText: string,
  domainContext: string,
): string {
  const parts = [
    `Requirement: ${trimPromptText(mergeRequirementAndAttachment(requirement, attachmentText), 6000)}`,
  ];
  if (wiEvidenceText.trim()) {
    parts.push(`Work instruction evidence summary:\n${trimPromptTextAtBoundary(wiEvidenceText, 3600)}`);
  }
  if (similarStoriesText.trim()) {
    parts.push(`Backlog theme summary:\n${trimPromptTextAtBoundary(similarStoriesText, 2600)}`);
  }
  if (domainContext.trim()) {
    parts.push(`Business context:\n${trimPromptTextAtBoundary(domainContext, 1600)}`);
  }
  return parts.join('\n\n');
}

export function buildHeuristicDiscoveryAssessment(input: {
  requirement: string;
  attachmentText: string;
  wiEvidenceText: string;
  similarStoriesText: string;
}): DiscoveryAssessment {
  const corpus = [
    input.requirement,
    input.attachmentText,
    input.wiEvidenceText,
    input.similarStoriesText,
  ].join('\n').toLowerCase();
  const hasSequence = /\b(sequence|sequen|step|de-?install|re-?install|dependency|followed by|multi-activity|multi activity)\b/.test(corpus);
  const hasMultipleTeams = /\b(teams?|field|in-house|logistics|coordinator|manager|specialist|approv|review)\b/.test(corpus);
  const hasRules = /\b(quote|billable|billing|contract|entitlement|approval|authorization|threshold|validation|rule|prevent)\b/.test(corpus);
  const hasExceptions = /\b(exception|unless|cannot|fail|delay|cancel|disruption|warning|hold|illogical)\b/.test(corpus);
  const hasLifecycle = /\b(status|track|visibility|overall status|in progress|completed|modify|change|shipment|work order|initiat)\b/.test(corpus);
  const highSignals = [hasSequence, hasMultipleTeams, hasRules, hasExceptions, hasLifecycle].filter(Boolean).length;
  const depth: DiscoveryDepth = highSignals >= 4 ? 'deep' : highSignals >= 2 ? 'standard' : 'light';

  const obligations = [
    hasMultipleTeams ? 'ownership' : '',
    /\bapproval|authori[sz]/.test(corpus) ? 'approvals' : '',
    /\btrigger|start|begin|when\b/.test(corpus) ? 'trigger' : '',
    /\bprecondition|required before|must already\b/.test(corpus) ? 'prerequisites' : '',
    hasSequence ? 'sequencing' : '',
    /\bdepend/.test(corpus) ? 'dependencies' : '',
    /\bquote|billing|billable/.test(corpus) ? 'quote_and_billing' : '',
    /\bcontract|entitlement|covered/.test(corpus) ? 'entitlement_and_contract' : '',
    /\bshipment|work order|follow-on|follow on|initiat/.test(corpus) ? 'downstream_initiation' : '',
    /\bstatus|track|visible|view/.test(corpus) ? 'status_visibility' : '',
    /\bmodify|change|remove|add.*activity|in progress/.test(corpus) ? 'active_change_handling' : '',
    hasExceptions ? 'disruption_and_exceptions' : '',
    /\bloaner|equipment|asset/.test(corpus) ? 'linked_assets' : '',
    /\bmetric|measure|success|outcome/.test(corpus) ? 'success_measurement' : '',
  ].filter(Boolean);

  return {
    discoveryDepth: depth,
    reasoningLevel: depth,
    workflowComplexity: hasSequence ? 'high' : /\bworkflow|flow|process/.test(corpus) ? 'medium' : 'low',
    actorComplexity: hasMultipleTeams ? 'high' : /\brole|user|actor/.test(corpus) ? 'medium' : 'low',
    ruleDensity: hasRules ? 'high' : /\bpolicy|rule/.test(corpus) ? 'medium' : 'low',
    exceptionDensity: hasExceptions ? 'high' : /\bexception|edge case/.test(corpus) ? 'medium' : 'low',
    lifecycleComplexity: hasLifecycle ? 'high' : /\bstatus|state/.test(corpus) ? 'medium' : 'low',
    ambiguityLevel: highSignals >= 4 ? 'high' : highSignals >= 2 ? 'medium' : 'low',
    coverageObligations: uniqueStrings(obligations),
    recommendedQuestionRange: normalizeRecommendedQuestionRange(undefined, depth),
    rationale: highSignals >= 4
      ? 'The requirement implies a coordinated workflow with multiple unresolved business dimensions.'
      : highSignals >= 2
        ? 'The requirement has meaningful ambiguity across workflow, rules, or ownership and needs structured discovery.'
        : 'The requirement appears focused with limited ambiguity and can use a lighter discovery pass.',
  };
}

export function parseDiscoveryAssessment(rawData: unknown): DiscoveryAssessment | null {
  if (!rawData || typeof rawData !== 'object') return null;
  const payload = rawData as Record<string, unknown>;
  const discoveryDepth = normalizeDiscoveryDepth(payload.discoveryDepth);
  const reasoningLevel = normalizeDiscoveryDepth(payload.reasoningLevel ?? payload.discoveryDepth);
  return {
    discoveryDepth,
    reasoningLevel,
    workflowComplexity: normalizeDimensionLevel(payload.workflowComplexity),
    actorComplexity: normalizeDimensionLevel(payload.actorComplexity),
    ruleDensity: normalizeDimensionLevel(payload.ruleDensity),
    exceptionDensity: normalizeDimensionLevel(payload.exceptionDensity),
    lifecycleComplexity: normalizeDimensionLevel(payload.lifecycleComplexity),
    ambiguityLevel: normalizeDimensionLevel(payload.ambiguityLevel),
    coverageObligations: normalizeCoverageObligations(payload.coverageObligations),
    recommendedQuestionRange: normalizeRecommendedQuestionRange(payload.recommendedQuestionRange, discoveryDepth),
    rationale: cleanText(payload.rationale) || 'Discovery depth inferred from semantic complexity and unresolved business ambiguity.',
  };
}

export function evaluateClarifyQuestionSetQuality(
  questions: ClarifyQuestion[],
  assessment: DiscoveryAssessment,
): { score: number; missingObligations: string[]; reasons: string[] } {
  const reasons: string[] = [];
  const questionText = questions
    .map((question) => `${question.categoryKey} ${question.question} ${(question.suggestions ?? []).join(' ')}`.toLowerCase())
    .join('\n');
  const normalizedQuestions = questions.map((question) => normalizeKey(`${question.categoryKey} ${question.question}`)).filter(Boolean);
  const duplicateQuestionCount = normalizedQuestions.length - new Set(normalizedQuestions).size;
  const missingObligations = assessment.coverageObligations.filter((obligation) => {
    const obligationPattern = new RegExp(obligation.replace(/_/g, '[ _-]?'), 'i');
    return !obligationPattern.test(questionText);
  });
  const missingGenericCoverage = missingGenericCoverageKeys(questions, assessment);
  const distinctCategoryCount = new Set(questions.map((question) => question.categoryKey)).size;
  const minimumDistinctCategories = assessment.discoveryDepth === 'deep'
    ? 4
    : assessment.discoveryDepth === 'standard'
      ? 3
      : 2;

  let score = 100;
  if (questions.length < assessment.recommendedQuestionRange.min) {
    score -= 30;
    reasons.push('Returned fewer questions than the assessed discovery range suggests.');
  }
  if (missingObligations.length) {
    score -= Math.min(15, missingObligations.length * 5);
    reasons.push(`Missing assessed ambiguity themes: ${missingObligations.join(', ')}.`);
  }
  if (missingGenericCoverage.length) {
    score -= Math.min(10, missingGenericCoverage.length * 2);
    reasons.push(`Missing generic discovery coverage: ${missingGenericCoverage.map((key) => GENERIC_DISCOVERY_COVERAGE_LABELS[key]).join(', ')}.`);
  }
  if (questions.length > 0 && distinctCategoryCount < minimumDistinctCategories) {
    score -= Math.min(12, (minimumDistinctCategories - distinctCategoryCount) * 4);
    reasons.push('Question set did not spread across enough distinct discovery themes.');
  }
  const weakSuggestions = questions.filter((question) => question.suggestions.length < 2).length;
  if (weakSuggestions > 0) {
    score -= Math.min(12, weakSuggestions * 4);
    reasons.push('Some questions did not provide enough grounded suggestions.');
  }
  const truncatedSuggestions = questions.filter((question) => question.suggestions.some((suggestion) => isLikelyTruncatedSuggestion(suggestion))).length;
  if (truncatedSuggestions > 0) {
    score -= Math.min(18, truncatedSuggestions * 6);
    reasons.push('Some answer suggestions appear truncated or incomplete.');
  }
  const longQuestions = questions.filter((question) => question.question.length > 220).length;
  if (longQuestions > 0) {
    score -= Math.min(10, longQuestions * 2);
    reasons.push('Some discovery questions were too broad or overpacked.');
  }
  if (duplicateQuestionCount > 0) {
    score -= Math.min(12, duplicateQuestionCount * 6);
    reasons.push('Some discovery questions are repetitive.');
  }
  if (questions.length > assessment.recommendedQuestionRange.max + 5) {
    score -= 8;
    reasons.push('The question set is materially larger than the assessed range.');
  }

  return {
    score: Math.max(0, score),
    missingObligations,
    reasons,
  };
}

function extractQuestionCandidates(rawData: unknown): RawQuestionCandidate[] {
  if (Array.isArray(rawData)) {
    return rawData.filter((item): item is RawQuestionCandidate => typeof item === 'object' && item !== null);
  }
  if (rawData && typeof rawData === 'object') {
    const candidateObject = rawData as { questions?: unknown; items?: unknown };
    if (Array.isArray(candidateObject.questions)) {
      return candidateObject.questions.filter((item): item is RawQuestionCandidate => typeof item === 'object' && item !== null);
    }
    if (Array.isArray(candidateObject.items)) {
      return candidateObject.items.filter((item): item is RawQuestionCandidate => typeof item === 'object' && item !== null);
    }
  }
  return [];
}

export function parseStoryAssistantQuestionCandidates(rawData: unknown): ClarifyQuestion[] {
  return extractQuestionCandidates(rawData)
    .flatMap((candidate) => {
      const rawQuestion = cleanText(candidate.question);
      if (!rawQuestion) return [];
      const categoryKey = mapCategoryKey(candidate.categoryKey ?? candidate.category, rawQuestion);
      const category = cleanText(candidate.category)
        || (categoryKey === 'user_personas' ? 'Roles & Personas'
          : categoryKey === 'context_trigger' ? 'Trigger & Context'
          : categoryKey === 'functional_flow' ? 'Functional Flow'
          : categoryKey === 'business_rules' ? 'Business Rules & Exceptions'
          : categoryKey === 'success_measurement' ? 'Success & Measurement'
          : 'State & Lifecycle');
      const intent = cleanText(candidate.intent).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
        || `story_assistant_${categoryKey}`;
      const suggestions = normalizeSuggestions(Array.isArray(candidate.suggestions) ? candidate.suggestions : [], 0, 3);
      const details = cleanText(candidate.details);

      return splitClearlyNumberedStoryAssistantQuestion(rawQuestion).map((segment, index) => ({
        categoryKey,
        category,
        intent: index === 0 ? intent : `${intent}_part_${index + 1}`,
        question: ensureQuestionMark(segment),
        ...(index === 0 && details ? { details } : {}),
        suggestions,
      }));
    })
    .filter((question) => question.question.length > 0)
    .filter((question) => !isLikelyTruncatedQuestion(question.question));
}

function normalizeSufficiencyFollowupQuestions(rawData: unknown, maxQuestions: number): ClarifyQuestion[] {
  const parsed = parseStoryAssistantQuestionCandidates(rawData)
    .map((question) => {
      const suggestions = normalizeSuggestions(question.suggestions, 0, 3);
      return {
        ...question,
        suggestions,
        question: ensureQuestionMark(question.question),
      };
    })
    .filter((question) => !isLikelyTruncatedQuestion(question.question))
    .filter((question) => question.suggestions.length >= 1);
  return parsed.slice(0, Math.max(1, maxQuestions));
}

function buildMinimalDiscoveryProfile(
  questions: ClarifyQuestion[],
  assessment?: DiscoveryAssessment,
): DiscoveryProfile {
  const questionCount = questions.length;
  const askedCategoryKeys = uniqueStrings(questions.map((question) => question.categoryKey))
    .map((key) => key as ClarifyCategoryKey);
  const scope = assessment?.discoveryDepth === 'deep'
    ? 'broad'
    : assessment?.discoveryDepth === 'standard'
      ? 'moderate'
      : questionCount >= 8
        ? 'broad'
        : questionCount >= 5
          ? 'moderate'
          : 'narrow';
  const complexity = assessment?.workflowComplexity === 'high' || assessment?.ruleDensity === 'high' || assessment?.lifecycleComplexity === 'high'
    ? 'high'
    : assessment?.workflowComplexity === 'medium' || assessment?.ruleDensity === 'medium' || assessment?.lifecycleComplexity === 'medium'
      ? 'medium'
      : questionCount >= 6
        ? 'medium'
        : 'low';
  const ambiguity = assessment?.ambiguityLevel ?? (questionCount >= 6 ? 'high' : questionCount >= 3 ? 'medium' : 'low');
  const followupCap = storyAssistantFollowupCap(
    assessment?.discoveryDepth === 'deep'
      ? 'quality'
      : assessment?.discoveryDepth === 'light'
        ? 'fast'
        : 'balanced',
  );
  const plannedQuestionBudget = assessment
    ? assessment.recommendedQuestionRange.max + followupCap
    : questionCount + 2;
  return {
    scope,
    complexity,
    ambiguity,
    missingCategoryKeys: [],
    recommendedInitialCount: questionCount,
    followupCap,
    plannedQuestionBudget,
    actualQuestionsAsked: questionCount,
    softQuestionBudget: assessment?.recommendedQuestionRange.max ?? questionCount,
    hardQuestionCap: plannedQuestionBudget,
    coverageArtifact: buildDiscoveryCoverageArtifact({
      missingCategoryKeys: [],
      plannedQuestionBudget,
      actualQuestionsAsked: questionCount,
      actualAnswersReceived: 0,
      askedCategoryKeys,
    }),
  };
}

function buildClarifyAmbiguityAssessment(
  questions: ClarifyQuestion[],
  assessment: DiscoveryAssessment,
  qualityScore: number,
  qualityReasons: string[],
): NonNullable<ClarifyContextMeta['ambiguityAssessment']> {
  const level = assessment.ambiguityLevel === 'high'
    ? 'vague'
    : assessment.ambiguityLevel === 'medium'
      ? 'medium'
      : 'clear';
  return {
    level,
    score: Math.max(
      1,
      Math.min(
        10,
        assessment.discoveryDepth === 'deep' ? 8 : assessment.discoveryDepth === 'standard' ? 6 : 3,
      ),
    ),
    reasons: qualityReasons.length
      ? qualityReasons
      : ['Discovery depth was calibrated from semantic workflow ambiguity rather than prompt length.'],
    questionPlan: {
      min: assessment.recommendedQuestionRange.min,
      max: assessment.recommendedQuestionRange.max,
      target: Math.min(
        assessment.recommendedQuestionRange.max,
        Math.max(assessment.recommendedQuestionRange.min, questions.length),
      ),
    },
    generatedQuestions: questions.length || Math.max(assessment.recommendedQuestionRange.min, Math.round(qualityScore / 20)),
  };
}

function mergePass2IntoPass1(pass1: RawFeature[], pass2: RawFeature[]): RawFeature[] {
  const byStableIdentity = new Map<string, RawFeature>();
  pass2.forEach((feature) => {
    const rawId = cleanText(feature.id);
    if (rawId) {
      byStableIdentity.set(`id:${normalizeKey(rawId)}`, feature);
    }
    const summary = cleanText(feature.summary);
    if (summary) {
      byStableIdentity.set(`summary:${normalizeKey(summary)}`, feature);
    }
  });

  return pass1.map((feature, index) => {
    const lookupId = cleanText(feature.id);
    const lookupSummary = cleanText(feature.summary);
    const next =
      (lookupId ? byStableIdentity.get(`id:${normalizeKey(lookupId)}`) : undefined)
      ?? (lookupSummary ? byStableIdentity.get(`summary:${normalizeKey(lookupSummary)}`) : undefined)
      ?? pass2[index];
    if (!next) return feature;
    return {
      ...feature,
      ...next,
      acceptance_requirements: next.acceptance_requirements ?? next.acceptanceRequirements ?? [],
    };
  });
}

function extractFeatureActor(description: string): string {
  return cleanText(description.match(/^As an?\s+(.+?),\s*I need(?:\s+to)?\s+/i)?.[1] ?? '');
}

function findCoveredActors(features: Feature[], eligibleActors: string[]): string[] {
  const eligibleKeys = new Set(eligibleActors.map((actor) => normalizeKey(actor)));
  return uniqueStrings(features
    .map((feature) => extractFeatureActor(feature.description))
    .filter((role) => eligibleKeys.has(normalizeKey(role))));
}

function shouldRetryForActorCollapse(features: Feature[], actorSets: ActorSetGrounding): boolean {
  const eligibleActors = uniqueStrings(actorSets.eligibleActors ?? actorSets.mentionedActors ?? []).filter(looksLikeRolePhrase);
  if (eligibleActors.length < 2 || features.length < 2) return false;
  return findCoveredActors(features, eligibleActors).length <= 1;
}

function featureToRaw(feature: Feature): RawFeature {
  return {
    id: feature.id,
    summary: feature.summary,
    description: feature.description,
    acceptance_requirements: [],
    suggested_story_points: feature.storyPoints,
    process_code: feature.processCode,
  };
}

function normalizeArKey(ar: { given: string; when: string; then: string }): string {
  return [ar.given, ar.when, ar.then].map((value) => normalizeKey(value)).join('||');
}

function dedupeExactAcceptanceRequirements(features: Feature[]): { features: Feature[]; notes: string[] } {
  let exactDuplicatesRemoved = 0;

  const nextFeatures = features.map((feature) => {
    const acceptanceRequirements = feature.acceptanceRequirements.filter((ar, index, list) => {
      const firstIndex = list.findIndex((candidate) => normalizeArKey(candidate) === normalizeArKey(ar));
      const keep = firstIndex === index;
      if (!keep) exactDuplicatesRemoved += 1;
      return keep;
    });

    return {
      ...feature,
      acceptanceRequirements,
    };
  });

  return {
    features: nextFeatures,
    notes: exactDuplicatesRemoved > 0
      ? [`Removed ${exactDuplicatesRemoved} exact duplicate acceptance requirement${exactDuplicatesRemoved === 1 ? '' : 's'} inside feature outputs.`]
      : [],
  };
}

function extractRawFeaturesFromPayload(payload: unknown): RawFeature[] {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload.filter((feature): feature is RawFeature => Boolean(feature && typeof feature === 'object'));
  }
  if (typeof payload === 'object') {
    const candidate = payload as { features?: unknown; items?: unknown; feature?: unknown };
    if (Array.isArray(candidate.features)) {
      return candidate.features.filter((feature): feature is RawFeature => Boolean(feature && typeof feature === 'object'));
    }
    if (Array.isArray(candidate.items)) {
      return candidate.items.filter((feature): feature is RawFeature => Boolean(feature && typeof feature === 'object'));
    }
    if (candidate.feature && typeof candidate.feature === 'object') {
      return [candidate.feature as RawFeature];
    }
  }
  return [];
}

interface CoverageMapEntry {
  id: string;
  ownsRuleAreas: string[];
  doesNotCover: string[];
}

function formatCoverageMapForPrompt(coverage: CoverageMapEntry[], focalId: string): string {
  const lines = coverage.map((entry) => {
    const marker = entry.id === focalId ? '→ FOCAL FEATURE' : 'sibling';
    const owns = entry.ownsRuleAreas.length ? entry.ownsRuleAreas.join('; ') : '(none)';
    const avoid = entry.doesNotCover.length ? entry.doesNotCover.join('; ') : '(none)';
    return `- [${marker}] ${entry.id}\n  owns: ${owns}\n  does not cover: ${avoid}`;
  });
  return `Coverage map — sibling ownership for this requirement:\n${lines.join('\n')}`;
}

function jaccardSimilarity(a: string, b: string): number {
  const toSet = (value: string) => new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
  const sa = toSet(a);
  const sb = toSet(b);
  if (!sa.size || !sb.size) return 0;
  let intersection = 0;
  sa.forEach((token) => { if (sb.has(token)) intersection += 1; });
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function measureCrossFeatureArOverlap(features: Feature[]): { overlapRate: number; duplicatePairs: number; totalPairs: number } {
  const arsByFeature = features.map((feature) => feature.acceptanceRequirements.map((ar) => `${ar.given} ${ar.when} ${ar.then}`));
  let duplicatePairs = 0;
  let totalPairs = 0;
  for (let i = 0; i < arsByFeature.length; i++) {
    for (let j = i + 1; j < arsByFeature.length; j++) {
      for (const arA of arsByFeature[i]) {
        for (const arB of arsByFeature[j]) {
          totalPairs += 1;
          if (jaccardSimilarity(arA, arB) >= 0.7) duplicatePairs += 1;
        }
      }
    }
  }
  return {
    overlapRate: totalPairs === 0 ? 0 : duplicatePairs / totalPairs,
    duplicatePairs,
    totalPairs,
  };
}

async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const PARALLEL_AR_MIN_FEATURES = 4;
const PARALLEL_AR_CONCURRENCY = 4;

function isParallelArEnabled(): boolean {
  const raw = (process.env.GENERATION_PARALLEL_AR_ENABLED ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

export async function generateStoryAssistantDefaultClarifyingQuestions(opts: {
  requirement: string;
  attachmentText: string;
  wiContextText: string;
  wiInsightsArtifact?: WorkInstructionInsightArtifact | null;
  similarStories?: SimilarStory[];
  config: TenantConfig;
}): Promise<StoryAssistantClarifyResult & { promptAssemblyMs: number }> {
  const providerOpts = buildProviderOpts(opts.config);
  const usageByStage: Record<string, { input: number; output: number }> = {};
  let questions: ClarifyQuestion[] = [];
  let promptAssemblyMs = 0;
  const pipelineProfile = resolveStoryAssistantPipelineProfile(opts.config.generatorConfig);
  const modelRoute = buildStoryAssistantModelRoute(opts.config.generatorConfig);
  const wiEvidenceText = formatWiEvidence(opts.wiInsightsArtifact, opts.wiContextText);
  const heuristicAssessment = buildHeuristicDiscoveryAssessment({
    requirement: opts.requirement,
    attachmentText: opts.attachmentText,
    wiEvidenceText,
    similarStoriesText: '',
  });
  const complexity = heuristicAssessment.ambiguityLevel;
  const questionRange = storyAssistantQuestionRange(pipelineProfile, complexity);
  const discoveryAssessment: DiscoveryAssessment = {
    ...heuristicAssessment,
    discoveryDepth: pipelineProfile === 'quality' ? 'deep' : pipelineProfile === 'fast' ? 'light' : 'standard',
    reasoningLevel: pipelineProfile === 'quality' ? 'deep' : pipelineProfile === 'fast' ? 'light' : 'standard',
    recommendedQuestionRange: { min: questionRange.targetMin, max: questionRange.targetMax },
    rationale: `Question volume scales with heuristic complexity (${complexity}) bounded by the selected pipeline profile; the clarifier judges semantic ambiguity directly, and heuristics validate structural coverage only.`,
  };

  let coverageQualityScore = 0;
  let coverageRetryTriggered = false;
  let qualityReasons: string[] = [];
  const baseUserMessageStartedAt = Date.now();
  const baseUserMessage = buildClarifyUserMessage({
    requirement: opts.requirement,
    attachmentText: opts.attachmentText,
    wiEvidenceText,
    domainRoles: opts.config.domainRoles,
  });
  promptAssemblyMs += Date.now() - baseUserMessageStartedAt;

  const clarifyModel = getTierModel(modelRoute.clarify ?? opts.config.generatorConfig.clarifyModel, opts.config.tier);
  const runClarify = async (extraInstruction?: string) => callLlmJsonWithUsage<unknown>({
    model: clarifyModel,
    systemPrompt: buildStoryAssistantClarifySystemPrompt({
      domainContext: opts.config.domainContext,
      domainRoles: opts.config.domainRoles,
      pipelineProfile,
      questionRange,
      complexity,
    }),
    userMessage: extraInstruction ? `${baseUserMessage}\n\n${extraInstruction}` : baseUserMessage,
    maxTokens: Math.max(opts.config.generatorConfig.maxTokens, 8192),
    reasoningEffort: mapReasoningDepthToEffort(discoveryAssessment.reasoningLevel),
    ...providerOpts,
  });
  let result = await runClarify();
  usageByStage.clarify = result.usage;
  questions = finalizeStoryAssistantDiscoveryQuestions(parseStoryAssistantQuestionCandidates(result.data), discoveryAssessment);
  let quality = evaluateClarifyQuestionSetQuality(questions, discoveryAssessment);
  const shouldRetryClarify = result.parseOutcome === 'repaired_parse'
    || questions.length < questionRange.lowerBound
    || quality.score < 72;
  if (shouldRetryClarify) {
    coverageRetryTriggered = true;
    result = await runClarify(
      `Your previous output was too thin or structurally unreliable. Return a requirement-specific JSON array only. Cover the unresolved ambiguity that materially affects feature boundaries or acceptance requirements. Stay within a healthy range of ${questionRange.targetMin}-${questionRange.targetMax} questions for this run, and never exceed ${questionRange.hardCap}.`,
    );
    usageByStage.clarifyRetry = result.usage;
    questions = finalizeStoryAssistantDiscoveryQuestions(parseStoryAssistantQuestionCandidates(result.data), discoveryAssessment);
    quality = evaluateClarifyQuestionSetQuality(questions, discoveryAssessment);
  }
  coverageQualityScore = quality.score;
  qualityReasons = quality.reasons;

  const discoveryProfile = buildMinimalDiscoveryProfile(questions, discoveryAssessment);
  const ambiguityAssessment = buildClarifyAmbiguityAssessment(
    questions,
    discoveryAssessment,
    coverageQualityScore,
    qualityReasons,
  );
  return {
    questions,
    tokenUsage: buildTokenUsageSummary(usageByStage),
    promptAssemblyMs,
    discoveryProfile,
    discoveryAssessment,
    coverageQualityScore,
    coverageRetryTriggered,
    ambiguityAssessment,
  };
}

export async function evaluateStoryAssistantDefaultSufficiency(opts: {
  requirement: string;
  answers: ClarifyAnswer[];
  askedQuestions?: Array<string | Pick<ClarifyQuestion, 'categoryKey' | 'intent' | 'question'>>;
  attachmentText?: string;
  wiContextText?: string;
  wiInsightsArtifact?: WorkInstructionInsightArtifact | null;
  similarStories?: SimilarStory[];
  config: TenantConfig;
}): Promise<StoryAssistantSufficiencyResult & { promptAssemblyMs: number }> {
  const startedAt = Date.now();
  const providerOpts = buildProviderOpts(opts.config);
  const askedCategoryKeys = uniqueStrings((opts.askedQuestions ?? [])
    .map((item) => typeof item === 'string' ? '' : item.categoryKey ?? '')
    .filter(Boolean))
    .map((key) => key as ClarifyCategoryKey);
  const wiEvidenceText = formatWiEvidence(opts.wiInsightsArtifact, opts.wiContextText ?? '');
  const similarStoriesText = formatDiscoveryBacklogEvidence(opts.similarStories ?? []);
  const promptAssemblyStartedAt = Date.now();
  const pipelineProfile = resolveStoryAssistantPipelineProfile(opts.config.generatorConfig);
  const followupCap = storyAssistantFollowupCap(pipelineProfile);
  const userMessage = buildSufficiencyUserMessage({
    requirement: opts.requirement,
    answers: opts.answers,
    attachmentText: opts.attachmentText,
    wiEvidenceText,
    similarStoriesText,
  });
  const promptAssemblyMs = Date.now() - promptAssemblyStartedAt;
  try {
    const evaluateOnce = async (extraInstruction?: string) => callLlmJsonWithUsage<unknown>({
      model: getTierModel(opts.config.generatorConfig.evaluateModel, opts.config.tier),
      systemPrompt: buildStoryAssistantSufficiencySystemPrompt({
        domainContext: opts.config.domainContext,
        domainRoles: opts.config.domainRoles,
        followupCap,
      }),
      userMessage: extraInstruction ? `${userMessage}\n\n${extraInstruction}` : userMessage,
      maxTokens: 2400,
      reasoningEffort: 'low',
      ...providerOpts,
    });
    const usageByStage: Record<string, { input: number; output: number }> = {};
    let result = await evaluateOnce();
    usageByStage.clarifyEvaluate = result.usage;
    let payload = (result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : {});
    let parsedQuestions = normalizeSufficiencyFollowupQuestions(payload, followupCap);
    const looksMalformedFollowup = payload.sufficient === false
      && (!Array.isArray(payload.questions) || parsedQuestions.length === 0);
    if (looksMalformedFollowup) {
      const retry = await evaluateOnce(
        `Your previous follow-up output was malformed. Return strict JSON only. If sufficient is false and you provide questions, include 1-${followupCap} complete follow-up questions with 1-3 grounded suggestions each.`,
      );
      result = retry;
      usageByStage.clarifyEvaluateRetry = retry.usage;
      payload = (retry.data && typeof retry.data === 'object' ? retry.data as Record<string, unknown> : {});
      parsedQuestions = normalizeSufficiencyFollowupQuestions(payload, followupCap);
    }
    const sufficient = payload.sufficient === true;
    const reasonCodes = Array.isArray(payload.reasonCodes)
      ? payload.reasonCodes.map((value) => cleanText(value)).filter(Boolean)
      : [];
    const missingCategoryKeys = parsedQuestions
      .map((question) => question.categoryKey)
      .filter((value, index, values) => values.indexOf(value) === index);
    const status =
      sufficient ? 'ready_to_generate'
      : parsedQuestions.length > 0 ? 'ask_followup'
      : 'ready_with_open_decisions';

    return {
      sufficient,
      status,
      ...(status === 'ask_followup' ? { questions: parsedQuestions } : {}),
      missingCategoryKeys,
      reasonCodes,
      coverageArtifact: buildDiscoveryCoverageArtifact({
        missingCategoryKeys,
        plannedQuestionBudget: opts.answers.length + followupCap,
        actualQuestionsAsked: opts.answers.length,
        actualAnswersReceived: opts.answers.length,
        askedCategoryKeys,
        openNonBlockingDecisions: status === 'ready_with_open_decisions' ? reasonCodes : [],
      }),
      tokenUsage: buildTokenUsageSummary(usageByStage),
      durationMs: Date.now() - startedAt,
      promptAssemblyMs,
    };
  } catch {
    return {
      sufficient: false,
      status: 'ready_with_open_decisions',
      missingCategoryKeys: [],
      reasonCodes: ['SUFFICIENCY_EVAL_FAILED'],
      coverageArtifact: buildDiscoveryCoverageArtifact({
        missingCategoryKeys: [],
        plannedQuestionBudget: opts.answers.length + followupCap,
        actualQuestionsAsked: opts.answers.length,
        actualAnswersReceived: opts.answers.length,
        askedCategoryKeys,
        openNonBlockingDecisions: ['SUFFICIENCY_EVAL_FAILED'],
      }),
      tokenUsage: {
        input: 0,
        output: 0,
        total: 0,
        byStage: {},
      },
      durationMs: Date.now() - startedAt,
      promptAssemblyMs,
      warning: 'Sufficiency evaluation failed; proceeding with explicit open decisions instead of silently marking discovery complete.',
    };
  }
}

export async function generateStoryAssistantDefaultFeatures(opts: {
  requirement: string;
  clarifyAnswers: ClarifyAnswer[];
  attachmentText: string;
  wiContextText: string;
  wiInsightsArtifact?: WorkInstructionInsightArtifact | null;
  similarStories?: SimilarStory[];
  arPatternLibraryText?: string;
  arPatternStoryKeys?: string[];
  discoveryProfile?: DiscoveryProfile;
  config: TenantConfig;
  precomputedDraftFeatures?: Feature[];
  priorStageDurationsMs?: GenerationStageDurationsMs;
  onPass1DraftFeatures?: (draftFeatures: Feature[]) => Promise<void>;
  shouldCancel?: () => Promise<boolean> | boolean;
}): Promise<GenerationResult> {
  const providerOpts = buildProviderOpts(opts.config);
  const pipelineProfile = resolveStoryAssistantPipelineProfile(opts.config.generatorConfig);
  const modelRoute = buildStoryAssistantModelRoute(opts.config.generatorConfig);
  const stageDurationsMs = { ...(opts.priorStageDurationsMs ?? {}) } as Record<string, number>;
  const stageUsage: Record<string, { input: number; output: number }> = {};
  const actorSets = extractActorSets(opts.requirement, opts.clarifyAnswers);
  const roleGrounding = {
    requirement: opts.requirement,
    clarifyAnswers: opts.clarifyAnswers,
    domainRoles: opts.config.domainRoles,
  };
  const roleHint = buildRoleHint(opts.config.domainRoles, opts.requirement, opts.clarifyAnswers, actorSets);
  const wiEvidenceText = formatWiEvidence(opts.wiInsightsArtifact, opts.wiContextText, 4000);
  const arPatternLibraryText = pipelineProfile === 'quality' ? opts.arPatternLibraryText : undefined;
  let promptAssemblyMs = 0;
  let pass1Raw: RawFeature[] = [];
  let pass1Features: Feature[] = opts.precomputedDraftFeatures ?? [];

  const maybeCancelled = async () => Boolean(await opts.shouldCancel?.());

  if (!pass1Features.length) {
    const startedAt = Date.now();
    const decompositionPromptStartedAt = Date.now();
    const decompositionUserMessage = `${buildGenerationContextMessage({
      requirement: opts.requirement,
      clarifyAnswers: opts.clarifyAnswers,
      attachmentText: opts.attachmentText,
      wiEvidenceText,
      roleHint,
      discoveryProfile: opts.discoveryProfile,
      actorSets,
    })}\n\nDecompose the following requirement into the distinct features needed to deliver it. Think through the decomposition framework and return the right set of features with accurate descriptions. When multiple eligible roles genuinely own different parts of the workflow, preserve that role diversity across the feature set instead of defaulting every feature to one role. Leave acceptance_requirements as empty arrays in this pass.`;
    promptAssemblyMs += Date.now() - decompositionPromptStartedAt;
    const pass1Result = await callLlmJsonWithUsage<{ features?: RawFeature[] }>({
      model: getTierModel(modelRoute.decomposition ?? opts.config.generatorConfig.decompositionModel, opts.config.tier),
      systemPrompt: buildStoryAssistantDecompositionSystemPrompt({
        domainContext: opts.config.domainContext,
        domainRoles: opts.config.domainRoles,
        processTaxonomy: opts.config.processTaxonomy,
        processTaxonomyEnabled: opts.config.processTaxonomyEnabled,
      }),
      userMessage: decompositionUserMessage,
      maxTokens: Math.max(opts.config.generatorConfig.maxTokens, 8192),
      reasoningEffort: 'medium',
      ...providerOpts,
    });
    stageUsage.decomposition = pass1Result.usage;
    pass1Raw = extractRawFeaturesFromPayload(pass1Result.data);
    if (!pass1Raw.length) {
      throw new Error('Feature decomposition returned no features.');
    }
    pass1Features = pass1Raw.map((feature) => normaliseFeature({
      ...feature,
      acceptance_requirements: [],
    }, roleGrounding));
    if (shouldRetryForActorCollapse(pass1Features, actorSets)) {
      const decompositionRetry = await callLlmJsonWithUsage<{ features?: RawFeature[] }>({
        model: getTierModel(modelRoute.decomposition ?? opts.config.generatorConfig.decompositionModel, opts.config.tier),
        systemPrompt: buildStoryAssistantDecompositionSystemPrompt({
          domainContext: opts.config.domainContext,
          domainRoles: opts.config.domainRoles,
          processTaxonomy: opts.config.processTaxonomy,
          processTaxonomyEnabled: opts.config.processTaxonomyEnabled,
        }),
        userMessage: `${decompositionUserMessage}\n\nYour previous output collapsed multiple eligible creator roles into one. Re-run the decomposition and preserve role diversity where the workflow genuinely spans different creators. Keep role names verbatim from the discovered role list.`,
        maxTokens: Math.max(opts.config.generatorConfig.maxTokens, 8192),
        reasoningEffort: 'medium',
        ...providerOpts,
      });
      stageUsage.decompositionRetry = decompositionRetry.usage;
      const retriedPass1Raw = extractRawFeaturesFromPayload(decompositionRetry.data);
      if (retriedPass1Raw.length) {
        pass1Raw = retriedPass1Raw;
        pass1Features = pass1Raw.map((feature) => normaliseFeature({
          ...feature,
          acceptance_requirements: [],
        }, roleGrounding));
      }
    }
    stageDurationsMs.decomposition = Date.now() - startedAt;
    if (opts.onPass1DraftFeatures) {
      await opts.onPass1DraftFeatures(pass1Features);
    }
  } else {
    pass1Raw = pass1Features.map((feature) => featureToRaw(feature));
  }

  if (await maybeCancelled()) {
    throw new GenerationCancelledError();
  }

  const pass2StartedAt = Date.now();
  const arPromptStartedAt = Date.now();
  const baseContextMessage = buildGenerationContextMessage({
    requirement: opts.requirement,
    clarifyAnswers: opts.clarifyAnswers,
    attachmentText: opts.attachmentText,
    wiEvidenceText,
    roleHint,
    discoveryProfile: opts.discoveryProfile,
    actorSets,
    arPatternLibraryText,
  });
  const arUserMessage = `${baseContextMessage}\n\nFeatures to write acceptance requirements for:\n${JSON.stringify({
    features: pass1Raw.map((feature) => ({
      ...feature,
      acceptance_requirements: [],
    })),
  })}\n\nFor each feature, write GIVEN/WHEN/THEN acceptance requirements. Preserve the role wording already present in each feature description. For each feature, consider:\n- What is the primary business scenario? (this always gets an AR)\n- What key business rules must hold? (each distinct rule gets an AR)\n- What is the most likely failure or edge case a tester would actually run?\n\nKeep all other fields (summary, description, process_code, suggested_story_points) unchanged.`;
  promptAssemblyMs += Date.now() - arPromptStartedAt;
  const arModel = getTierModel(modelRoute.ar ?? opts.config.generatorConfig.arModel, opts.config.tier);
  const runArPass = async (extraInstruction?: string) => callLlmJsonWithUsage<{ features?: RawFeature[] }>({
    model: arModel,
    systemPrompt: buildStoryAssistantArSystemPrompt({
      domainContext: opts.config.domainContext,
      domainRoles: opts.config.domainRoles,
    }),
    userMessage: extraInstruction ? `${arUserMessage}\n\n${extraInstruction}` : arUserMessage,
    maxTokens: Math.max(opts.config.generatorConfig.maxTokens, 24576),
    reasoningEffort: pipelineProfile === 'quality' ? 'high' : 'medium',
    ...providerOpts,
  });

  const parallelArEligible = isParallelArEnabled() && pass1Raw.length >= PARALLEL_AR_MIN_FEATURES;
  let pass2Result: Awaited<ReturnType<typeof runArPass>>;
  let pass2Raw: RawFeature[];
  let parallelArDiagnostics: string[] = [];

  if (parallelArEligible) {
    try {
      const coverageStartedAt = Date.now();
      const coverageModel = getTierModel(opts.config.generatorConfig.themeModel, opts.config.tier);
      const featureBrief = pass1Raw.map((feature) => ({
        id: feature.id,
        summary: feature.summary,
        description: feature.description,
      }));
      const coverageUserMessage = `Requirement: ${trimPromptText(opts.requirement, 4000)}\n\nFeatures (write coverage map covering ALL of them):\n${JSON.stringify({ features: featureBrief })}`;
      const coverageResult = await callLlmJsonWithUsage<{ coverage?: CoverageMapEntry[] }>({
        model: coverageModel,
        systemPrompt: buildCoverageMapSystemPrompt(),
        userMessage: coverageUserMessage,
        maxTokens: 2048,
        reasoningEffort: 'low',
        ...providerOpts,
      });
      stageUsage.coverageMap = coverageResult.usage;
      stageDurationsMs.coverageMap = Date.now() - coverageStartedAt;
      const coverageRaw = Array.isArray(coverageResult.data?.coverage) ? coverageResult.data!.coverage! : [];
      const coverageById = new Map<string, CoverageMapEntry>();
      for (const entry of coverageRaw) {
        if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
          coverageById.set(entry.id, {
            id: entry.id,
            ownsRuleAreas: Array.isArray(entry.ownsRuleAreas) ? entry.ownsRuleAreas.filter((v): v is string => typeof v === 'string') : [],
            doesNotCover: Array.isArray(entry.doesNotCover) ? entry.doesNotCover.filter((v): v is string => typeof v === 'string') : [],
          });
        }
      }
      const coverageEntries: CoverageMapEntry[] = pass1Raw.map((feature) => {
        const id = feature.id ?? '';
        return coverageById.get(id) ?? { id, ownsRuleAreas: [], doesNotCover: [] };
      });

      const perFeatureSystemPrompt = buildPerFeatureArSystemPrompt({
        domainContext: opts.config.domainContext,
        domainRoles: opts.config.domainRoles,
      });
      const parallelResults = await runWithConcurrencyLimit(pass1Raw, PARALLEL_AR_CONCURRENCY, async (feature) => {
        const focalId = feature.id ?? '';
        const coverageBlock = formatCoverageMapForPrompt(coverageEntries, focalId);
        const userMessage = `${baseContextMessage}\n\n${coverageBlock}\n\nFocal feature (write ARs only for this one):\n${JSON.stringify({ feature: { ...feature, acceptance_requirements: [] } })}\n\nWrite GIVEN/WHEN/THEN acceptance requirements only for the focal feature. Respect the sibling ownership above — do not write ARs that duplicate behaviors owned by siblings.`;
        const result = await callLlmJsonWithUsage<{ feature?: RawFeature; features?: RawFeature[] }>({
          model: arModel,
          systemPrompt: perFeatureSystemPrompt,
          userMessage,
          maxTokens: Math.max(Math.floor((opts.config.generatorConfig.maxTokens || 24576) / 4), 4096),
          reasoningEffort: pipelineProfile === 'quality' ? 'high' : 'medium',
          ...providerOpts,
        });
        const extracted = extractRawFeaturesFromPayload(result.data);
        return { raw: extracted[0], usage: result.usage, parseOutcome: result.parseOutcome };
      });

      const aggregatedRaw: RawFeature[] = [];
      let aggregateInput = 0;
      let aggregateOutput = 0;
      let repairedCount = 0;
      parallelResults.forEach((entry, index) => {
        const source = pass1Raw[index];
        const merged = entry.raw
          ? { ...source, ...entry.raw, id: source.id, summary: source.summary, description: source.description }
          : { ...source, acceptance_requirements: [] };
        aggregatedRaw.push(merged);
        aggregateInput += entry.usage.input;
        aggregateOutput += entry.usage.output;
        if (entry.parseOutcome === 'repaired_parse') repairedCount += 1;
      });
      stageUsage.acceptanceRequirements = { input: aggregateInput, output: aggregateOutput };

      pass2Raw = aggregatedRaw;
      pass2Result = {
        data: { features: aggregatedRaw } as { features?: RawFeature[] },
        usage: stageUsage.acceptanceRequirements,
        parseOutcome: repairedCount > 0 ? 'repaired_parse' : 'strict',
      } as Awaited<ReturnType<typeof runArPass>>;
      parallelArDiagnostics.push(`Parallel AR pass used (${pass1Raw.length} features, concurrency ${PARALLEL_AR_CONCURRENCY}).`);
    } catch (error) {
      console.warn('[storyAssistant] parallel AR pass failed; falling back to single AR call', error);
      parallelArDiagnostics.push('Parallel AR pass failed; fell back to single AR call.');
      pass2Result = await runArPass();
      stageUsage.acceptanceRequirements = pass2Result.usage;
      pass2Raw = extractRawFeaturesFromPayload(pass2Result.data);
    }
  } else {
    pass2Result = await runArPass();
    stageUsage.acceptanceRequirements = pass2Result.usage;
    pass2Raw = extractRawFeaturesFromPayload(pass2Result.data);
  }
  stageDurationsMs.acceptanceRequirements = Date.now() - pass2StartedAt;

  let mergedRaw = mergePass2IntoPass1(pass1Raw, pass2Raw);
  let features = mergedRaw.map((feature) => normaliseFeature(feature, roleGrounding));
  let repairedOutput = dedupeExactAcceptanceRequirements(features);
  let pass2CoverageNotes = pass2Raw.length === 0
    ? ['Acceptance requirements pass returned no feature array; preserved pass-1 features for targeted retries.']
    : pass2Raw.length < pass1Raw.length
      ? ['Acceptance requirements pass returned fewer features than decomposition; merged by id/summary and index fallback.']
      : [];
  features = repairedOutput.features;
  let failedIndexes = findFeaturesMissingCompleteAcceptanceRequirements(features);
  let failedIds = new Set(failedIndexes.map((index) => features[index]?.id).filter(Boolean) as string[]);

  const shouldRetryArPass = pass2Result.parseOutcome === 'repaired_parse'
    || pass2Raw.length === 0
    || pass2Raw.length < pass1Raw.length
    || failedIds.size > 0;
  if (shouldRetryArPass) {
    const retry = await runArPass(
      'Your previous output was incomplete or structurally unreliable. Return strict JSON only. Preserve the same feature count, order, summaries, descriptions, process codes, and story points from the input. Fill every feature with complete GIVEN/WHEN/THEN acceptance requirements.',
    );
    stageUsage.acceptanceRequirementsRetry = retry.usage;
    pass2Result = retry;
    pass2Raw = extractRawFeaturesFromPayload(retry.data);
    mergedRaw = mergePass2IntoPass1(pass1Raw, pass2Raw);
    features = mergedRaw.map((feature) => normaliseFeature(feature, roleGrounding));
    repairedOutput = dedupeExactAcceptanceRequirements(features);
    pass2CoverageNotes = pass2Raw.length === 0
      ? ['Acceptance requirements retry returned no feature array; preserved pass-1 features.']
      : pass2Raw.length < pass1Raw.length
        ? ['Acceptance requirements retry returned fewer features than decomposition; preserved pass-1 features.']
        : [];
    features = repairedOutput.features;
    failedIndexes = findFeaturesMissingCompleteAcceptanceRequirements(features);
    failedIds = new Set(failedIndexes.map((index) => features[index]?.id).filter(Boolean) as string[]);
  }

  const preservePass1Only = pass2Result.parseOutcome === 'repaired_parse'
    || pass2Raw.length === 0
    || pass2Raw.length < pass1Raw.length
    || failedIds.size > 0;
  if (preservePass1Only) {
    features = annotateFailedAcceptanceRequirementFeatures(pass1Features.map((feature) => ({
      ...feature,
      acceptanceRequirements: [],
    })), new Set(pass1Features.map((feature) => feature.id).filter(Boolean))) as Feature[];
    failedIds = new Set(features.map((feature) => feature.id).filter(Boolean));
    pass2CoverageNotes = uniqueStrings([
      ...pass2CoverageNotes,
      'Acceptance requirements could not be completed reliably after retry; preserved pass-1 features instead of mixing partial AR output into the final result.',
    ]);
  } else if (failedIds.size > 0) {
    features = annotateFailedAcceptanceRequirementFeatures(features, failedIds) as Feature[];
  }

  if (parallelArDiagnostics.length) {
    const overlap = measureCrossFeatureArOverlap(features);
    if (overlap.totalPairs > 0) {
      parallelArDiagnostics.push(`Cross-feature AR overlap: ${(overlap.overlapRate * 100).toFixed(1)}% (${overlap.duplicatePairs}/${overlap.totalPairs} AR pairs).`);
      if (overlap.overlapRate > 0.15) {
        console.warn('[storyAssistant] parallel AR overlap above 15% threshold', overlap);
      }
    }
    pass2CoverageNotes = uniqueStrings([...pass2CoverageNotes, ...parallelArDiagnostics]);
  }

  stageDurationsMs.total = Object.values(stageDurationsMs).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const tokenUsage = buildTokenUsageSummary(stageUsage);

  return {
    features,
    violations: validateFeatures(features, opts.config),
    similarStories: [],
    sessionId: '',
    tokenUsage,
    generationContext: {
      pipelineMode: 'story_assistant_default',
      projectKey: '*',
      domainRolesUsed: opts.config.domainRoles ?? [],
      stageDurationsMs: {
        decomposition: stageDurationsMs.decomposition,
        acceptanceRequirements: stageDurationsMs.acceptanceRequirements,
        total: stageDurationsMs.total,
      },
      pipelineProfile,
      failedFeatureIds: [...failedIds],
      partialSuccess: failedIds.size > 0,
      partialSuccessMessage: failedIds.size > 0
        ? preservePass1Only
          ? `Acceptance requirements could not be completed reliably for ${failedIds.size} feature${failedIds.size === 1 ? '' : 's'}. Draft features were preserved without ARs so you can retry them from the canvas.`
          : `Acceptance requirements could not be completed for ${failedIds.size} feature${failedIds.size === 1 ? '' : 's'}.`
        : undefined,
      autoRepairedIssues: repairedOutput.notes,
      ...(pass2CoverageNotes.length
        ? { mergeDiagnostics: pass2CoverageNotes }
        : {}),
      actorSets,
      pass2ArPatternStoryKeys: opts.arPatternStoryKeys,
      latencyMs: {
        promptAssemblyMs,
      },
      tokenUsage,
    } as any,
  };
}
