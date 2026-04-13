import type {
  ActorSetGrounding,
  ClarifyAnswer,
  ClarifyCategoryKey,
  ClarifyQuestion,
  DiscoveryProfile,
  Feature,
  GenerationResult,
  GenerationStageDurationsMs,
  TenantConfig,
  TokenUsageSummary,
  SimilarStory,
  WorkInstructionInsightArtifact,
} from '../types';
import { getTierModel } from '../services/billing';
import { callLlmJsonWithUsage } from './llm';
import {
  buildStoryAssistantArSystemPrompt,
  buildStoryAssistantClarifySystemPrompt,
  buildStoryAssistantDecompositionSystemPrompt,
  buildStoryAssistantSufficiencySystemPrompt,
} from './prompts';
import { validateFeatures } from './quality-validator';
import { buildDiscoveryCoverageArtifact } from './discovery';
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

  const lines = [
    `EXACT ACTOR VOCABULARY: ${roleVocabulary.join(', ')}`,
    extractedRoles.length
      ? 'Use only these actor labels verbatim in feature descriptions unless the requirement itself names a different exact role.'
      : 'If you use a configured workspace role, use it verbatim and do not paraphrase or combine role labels.',
    'Choose exactly one actor label per feature description unless the exact label is already collective.',
    'Never use referential phrases like "the plan creator" or non-actor answers like approval states as role labels.',
  ];

  return lines.join('\n');
}

function buildActorSetHints(actorSets: ActorSetGrounding): string[] {
  const lines: string[] = [];
  if (actorSets.eligibleActors?.length) {
    lines.push(`ELIGIBLE ACTORS: ${actorSets.eligibleActors.join(', ')}`);
  }
  if (actorSets.approverActors?.length) {
    lines.push(`APPROVER ACTORS: ${actorSets.approverActors.join(', ')}`);
  }
  if (actorSets.viewerActors?.length) {
    lines.push(`VIEWER ACTORS: ${actorSets.viewerActors.join(', ')}`);
  }
  return lines;
}

function formatWiEvidence(
  wiInsightsArtifact: WorkInstructionInsightArtifact | null | undefined,
  wiContextText: string,
): string {
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
            .slice(0, 3)
            .map((item) => cleanText(item.text))
            .filter(Boolean);
          return lines.length ? `${label}:\n- ${lines.join('\n- ')}` : '';
        })
        .filter(Boolean)
    : [];

  if (insightSections.length) {
    return trimPromptText(insightSections.join('\n\n'), 5000);
  }
  return trimPromptText(wiContextText, 5000);
}

function formatDiscoveryBacklogEvidence(similarStories: SimilarStory[] = []): string {
  if (!similarStories.length) return '';
  const formatted = formatSimilarStoriesText(similarStories, 3);
  return trimPromptText(formatted, 3200);
}

function formatGenerationBacklogEvidence(similarStories: SimilarStory[] = []): string {
  if (!similarStories.length) return '';
  const formatted = formatSimilarStoriesText(similarStories, 4);
  return trimPromptText(formatted, 4200);
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
  const parts = ['DISCOVERY HANDOFF:'];
  if (coverageArtifact?.askedThemes?.length) {
    parts.push(`- Discovery themes actually asked: ${coverageArtifact.askedThemes.join(', ')}`);
  }
  buildActorSetHints(input.actorSets).forEach((line) => parts.push(`- ${line}`));
  const mustCarryRules = extractMustCarryRules(input.answers);
  if (mustCarryRules.length) {
    parts.push('- Must-carry rules and workflow details from answered discovery:');
    mustCarryRules.forEach((rule) => parts.push(`  - ${rule}`));
  }
  if (coverageArtifact?.openNonBlockingDecisions?.length) {
    parts.push('- Explicit open decisions that must remain open rather than silently assumed:');
    coverageArtifact.openNonBlockingDecisions.slice(0, 6).forEach((decision) => parts.push(`  - ${decision}`));
  }
  return parts.length > 1 ? parts.join('\n') : '';
}

function buildClarifyUserMessage(input: {
  requirement: string;
  attachmentText: string;
  wiEvidenceText: string;
  similarStoriesText?: string;
}) {
  const mergedRequirement = mergeRequirementAndAttachment(input.requirement, input.attachmentText);
  const parts = [`Requirement: ${trimPromptText(mergedRequirement, 16000)}`];
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
    parts.push(`Clarification answers:\n${formatClarifyAnswers(input.clarifyAnswers)}`);
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

function mapCategoryKey(category: unknown, question: string): ClarifyCategoryKey {
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

function normalizeSuggestions(values: unknown[]): string[] {
  return uniqueStrings(values)
    .map((value) => cleanText(value).replace(/[?.!]+$/g, ''))
    .filter(Boolean)
    .slice(0, 4);
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
      const suggestions = normalizeSuggestions(Array.isArray(candidate.suggestions) ? candidate.suggestions : []);
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
    .filter((question) => question.question.length > 0);
}

function shouldRetryDiscoveryQuestions(questions: ClarifyQuestion[]): boolean {
  if (questions.length < 4) return true;
  return questions.some((question) => (
    question.suggestions.length < 2
    || question.suggestions.length > 4
    || question.question.length > 240
  ));
}

function buildMinimalDiscoveryProfile(questions: ClarifyQuestion[]): DiscoveryProfile {
  const questionCount = questions.length;
  const askedCategoryKeys = uniqueStrings(questions.map((question) => question.categoryKey))
    .map((key) => key as ClarifyCategoryKey);
  const scope = questionCount >= 9 ? 'broad' : questionCount >= 6 ? 'moderate' : 'narrow';
  const complexity = questionCount >= 9 ? 'high' : questionCount >= 6 ? 'medium' : 'low';
  const ambiguity = questionCount >= 6 ? 'high' : questionCount >= 3 ? 'medium' : 'low';
  return {
    scope,
    complexity,
    ambiguity,
    missingCategoryKeys: [],
    recommendedInitialCount: questionCount,
    followupCap: 2,
    plannedQuestionBudget: questionCount + 2,
    actualQuestionsAsked: questionCount,
    softQuestionBudget: questionCount,
    hardQuestionCap: questionCount + 2,
    coverageArtifact: buildDiscoveryCoverageArtifact({
      missingCategoryKeys: [],
      plannedQuestionBudget: questionCount + 2,
      actualQuestionsAsked: questionCount,
      actualAnswersReceived: 0,
      askedCategoryKeys,
    }),
  };
}

function mergePass2IntoPass1(pass1: RawFeature[], pass2: RawFeature[]): RawFeature[] {
  return pass1.map((feature, index) => {
    const next = pass2[index];
    if (!next) return feature;
    return {
      ...feature,
      ...next,
      acceptance_requirements: next.acceptance_requirements ?? next.acceptanceRequirements ?? [],
    };
  });
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
  const wiEvidenceText = formatWiEvidence(opts.wiInsightsArtifact, opts.wiContextText);
  const similarStoriesText = formatDiscoveryBacklogEvidence(opts.similarStories ?? []);

  for (const attempt of [1, 2]) {
    const promptAssemblyStartedAt = Date.now();
    const baseUserMessage = buildClarifyUserMessage({
      requirement: opts.requirement,
      attachmentText: opts.attachmentText,
      wiEvidenceText,
      similarStoriesText,
    });
    promptAssemblyMs += Date.now() - promptAssemblyStartedAt;
    const result = await callLlmJsonWithUsage<unknown>({
      model: getTierModel(opts.config.generatorConfig.clarifyModel, opts.config.tier),
      systemPrompt: buildStoryAssistantClarifySystemPrompt({
        domainContext: opts.config.domainContext,
        domainRoles: opts.config.domainRoles,
        questionPlan: { min: 0, max: 0, target: 0 },
      }),
      userMessage: attempt === 1
        ? baseUserMessage
        : `${baseUserMessage}\n\nIMPORTANT: Re-run discovery and return a richer question set. Keep each question focused on one business decision, and give every question 3 or 4 grounded suggestions with enough detail to help the user choose.`,
      maxTokens: 4096,
      reasoningEffort: 'low',
      ...providerOpts,
    });
    usageByStage[attempt === 1 ? 'clarify' : 'clarifyRetry'] = result.usage;
    questions = parseStoryAssistantQuestionCandidates(result.data);
    if (!shouldRetryDiscoveryQuestions(questions) || attempt === 2) break;
  }

  const discoveryProfile = buildMinimalDiscoveryProfile(questions);
  return {
    questions,
    tokenUsage: buildTokenUsageSummary(usageByStage),
    promptAssemblyMs,
    discoveryProfile,
    ambiguityAssessment: {
      level: questions.length >= 8 ? 'vague' : questions.length >= 4 ? 'medium' : 'clear',
      score: questions.length >= 8 ? 8 : questions.length >= 4 ? 5 : 3,
      reasons: ['Discovery is asking every ambiguity that would materially change what gets built.'],
      questionPlan: {
        min: questions.length,
        max: questions.length,
        target: questions.length,
      },
      generatedQuestions: questions.length,
    },
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
  const userMessage = buildSufficiencyUserMessage({
    requirement: opts.requirement,
    answers: opts.answers,
    attachmentText: opts.attachmentText,
    wiEvidenceText,
    similarStoriesText,
  });
  const promptAssemblyMs = Date.now() - promptAssemblyStartedAt;
  try {
    const result = await callLlmJsonWithUsage<unknown>({
      model: getTierModel(opts.config.generatorConfig.evaluateModel, opts.config.tier),
      systemPrompt: buildStoryAssistantSufficiencySystemPrompt({
        domainContext: opts.config.domainContext,
        domainRoles: opts.config.domainRoles,
      }),
      userMessage,
      maxTokens: 1600,
      reasoningEffort: 'low',
      ...providerOpts,
    });

    const payload = (result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : {});
    const sufficient = payload.sufficient === true;
    const reasonCodes = Array.isArray(payload.reasonCodes)
      ? payload.reasonCodes.map((value) => cleanText(value)).filter(Boolean)
      : [];
    const parsedQuestions = parseStoryAssistantQuestionCandidates(payload).slice(0, 2);
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
        plannedQuestionBudget: opts.answers.length + 2,
        actualQuestionsAsked: opts.answers.length,
        actualAnswersReceived: opts.answers.length,
        askedCategoryKeys,
        openNonBlockingDecisions: status === 'ready_with_open_decisions' ? reasonCodes : [],
      }),
      tokenUsage: buildTokenUsageSummary({ clarifyEvaluate: result.usage }),
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
        plannedQuestionBudget: opts.answers.length + 2,
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
  const stageDurationsMs = { ...(opts.priorStageDurationsMs ?? {}) } as Record<string, number>;
  const stageUsage: Record<string, { input: number; output: number }> = {};
  const actorSets = extractActorSets(opts.requirement, opts.clarifyAnswers);
  const roleHint = buildRoleHint(opts.config.domainRoles, opts.requirement, opts.clarifyAnswers, actorSets);
  const wiEvidenceText = formatWiEvidence(opts.wiInsightsArtifact, opts.wiContextText);
  const similarStoriesText = formatGenerationBacklogEvidence(opts.similarStories ?? []);
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
      similarStoriesText,
    })}\n\nDecompose this requirement into the distinct features needed to deliver it. Leave acceptance_requirements as empty arrays.`;
    promptAssemblyMs += Date.now() - decompositionPromptStartedAt;
    const pass1Result = await callLlmJsonWithUsage<{ features?: RawFeature[] }>({
      model: getTierModel(opts.config.generatorConfig.decompositionModel, opts.config.tier),
      systemPrompt: buildStoryAssistantDecompositionSystemPrompt({
        domainContext: opts.config.domainContext,
        domainRoles: opts.config.domainRoles,
        processTaxonomy: opts.config.processTaxonomy,
        processTaxonomyEnabled: opts.config.processTaxonomyEnabled,
      }),
      userMessage: decompositionUserMessage,
      maxTokens: opts.config.generatorConfig.maxTokens,
      reasoningEffort: 'medium',
      ...providerOpts,
    });
    stageUsage.decomposition = pass1Result.usage;
    pass1Raw = Array.isArray(pass1Result.data.features) ? pass1Result.data.features : [];
    if (!pass1Raw.length) {
      throw new Error('Feature decomposition returned no features.');
    }
    pass1Features = pass1Raw.map((feature) => normaliseFeature({
      ...feature,
      acceptance_requirements: [],
    }));
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
  const arUserMessage = `${buildGenerationContextMessage({
    requirement: opts.requirement,
    clarifyAnswers: opts.clarifyAnswers,
    attachmentText: opts.attachmentText,
    wiEvidenceText,
    roleHint,
    discoveryProfile: opts.discoveryProfile,
    actorSets,
    similarStoriesText,
    arPatternLibraryText: opts.arPatternLibraryText,
  })}\n\nFeatures to write acceptance requirements for:\n${JSON.stringify({
    features: pass1Raw.map((feature) => ({
      ...feature,
      acceptance_requirements: [],
    })),
  }, null, 2)}\n\nFor each feature, write GIVEN/WHEN/THEN acceptance requirements that preserve concrete scenarios, gates, dependencies, validation safeguards, downstream actions, status visibility, and active-plan change handling where supported by the requirement, discovery answers, work instructions, or grounded backlog patterns.`;
  promptAssemblyMs += Date.now() - arPromptStartedAt;
  const pass2Result = await callLlmJsonWithUsage<{ features?: RawFeature[] }>({
    model: getTierModel(opts.config.generatorConfig.arModel, opts.config.tier),
    systemPrompt: buildStoryAssistantArSystemPrompt({
      domainContext: opts.config.domainContext,
      domainRoles: opts.config.domainRoles,
    }),
    userMessage: arUserMessage,
    maxTokens: Math.max(opts.config.generatorConfig.maxTokens, 16384),
    reasoningEffort: 'medium',
    ...providerOpts,
  });
  stageUsage.acceptanceRequirements = pass2Result.usage;
  stageDurationsMs.acceptanceRequirements = Date.now() - pass2StartedAt;

  const pass2Raw = Array.isArray(pass2Result.data.features) ? pass2Result.data.features : [];
  const mergedRaw = pass2Raw.length >= pass1Raw.length
    ? mergePass2IntoPass1(pass1Raw, pass2Raw)
    : pass1Raw;
  let features = mergedRaw.map((feature) => normaliseFeature(feature));
  const repairedOutput = dedupeExactAcceptanceRequirements(features);
  features = repairedOutput.features;
  const failedIndexes = findFeaturesMissingCompleteAcceptanceRequirements(features);
  const failedIds = new Set(failedIndexes.map((index) => features[index]?.id).filter(Boolean) as string[]);
  if (failedIds.size > 0) {
    features = annotateFailedAcceptanceRequirementFeatures(features, failedIds) as Feature[];
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
      failedFeatureIds: [...failedIds],
      partialSuccess: failedIds.size > 0,
      partialSuccessMessage: failedIds.size > 0
        ? `Acceptance requirements could not be completed for ${failedIds.size} feature${failedIds.size === 1 ? '' : 's'}.`
        : undefined,
      autoRepairedIssues: repairedOutput.notes,
      actorSets,
      pass2ArPatternStoryKeys: opts.arPatternStoryKeys,
      latencyMs: {
        promptAssemblyMs,
      },
      tokenUsage,
    } as any,
  };
}
