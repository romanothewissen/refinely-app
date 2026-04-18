import type {
  ActorSetGrounding,
  ClarifyAnswer,
  ClarifyContextMeta,
  ClarifyCategoryKey,
  ClarifyQuestion,
  DiscoveryAssessment,
  DiscoveryDimensionLevel,
  DiscoveryDepth,
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
import { buildStoryAssistantModelRoute, getStoryAssistantPipelineProfileConfig, resolveStoryAssistantPipelineProfile } from '../services/model-strategy';
import { callLlmJsonWithUsage } from './llm';
import {
  buildAddFeatureSystemPrompt,
  buildStoryAssistantArSystemPrompt,
  buildStoryAssistantClarifySystemPrompt,
  buildStoryAssistantDecompositionSystemPrompt,
  buildStoryAssistantSufficiencySystemPrompt,
} from './prompts';
import { validateFeatures } from './quality-validator';
import { buildDiscoveryCoverageArtifact } from './discovery';
import {
  findGoldConfigForProject,
  formatGoldStoryExemplars,
  formatSimilarStoriesText,
  getGoldStoryPool,
  resolveGoldKeys,
  resolveGoldKeysFromBacklog,
} from './similar-stories';
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
  'state & lifecycle': 'state_lifecycle',
  'state and lifecycle': 'state_lifecycle',
  'lifecycle': 'state_lifecycle',
  'business rules & exceptions': 'business_rules',
  'business rules and exceptions': 'business_rules',
  'business rules': 'business_rules',
  'success & measurement': 'success_measurement',
  'success and measurement': 'success_measurement',
  'success': 'success_measurement',
};

const DISCOVERY_CATEGORY_ORDER: ClarifyCategoryKey[] = [
  'context_trigger',
  'user_personas',
  'functional_flow',
  'state_lifecycle',
  'business_rules',
  'success_measurement',
];

function normalizeDiscoveryCategoryKey(categoryKey: ClarifyCategoryKey): ClarifyCategoryKey {
  return categoryKey;
}

// Extract 4-grams from the question stem for overlap detection.
function extractQuestionNgrams(question: string, n = 4): Set<string> {
  const tokens = cleanText(question)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i <= tokens.length - n; i += 1) {
    grams.add(tokens.slice(i, i + n).join(' '));
  }
  return grams;
}

function sortDiscoveryQuestions(questions: ClarifyQuestion[]): ClarifyQuestion[] {
  const order = new Map(DISCOVERY_CATEGORY_ORDER.map((key, index) => [key, index]));
  const sorted = [...questions].sort((left, right) => {
    const leftOrder = order.get(left.categoryKey) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right.categoryKey) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.question.localeCompare(right.question);
  });

  // Drop questions that share a 4-gram with a previously kept question. Keep
  // the first occurrence (category order + length-sorted) as the canonical one.
  const kept: ClarifyQuestion[] = [];
  const seenGrams = new Set<string>();
  for (const question of sorted) {
    const grams = extractQuestionNgrams(question.question);
    let overlap = false;
    for (const gram of grams) {
      if (seenGrams.has(gram)) {
        overlap = true;
        break;
      }
    }
    if (overlap) continue;
    for (const gram of grams) seenGrams.add(gram);
    kept.push(question);
  }
  return kept;
}

function buildProviderOpts(config: TenantConfig) {
  return {
    provider: config.generatorConfig.provider,
    anthropicApiKey: config.generatorConfig.anthropicApiKey,
    anthropicBaseUrl: config.generatorConfig.anthropicBaseUrl,
    geminiApiKey: config.generatorConfig.geminiApiKey,
    geminiBaseUrl: config.generatorConfig.geminiBaseUrl,
    openaiApiKey: config.generatorConfig.openaiApiKey,
    openaiBaseUrl: config.generatorConfig.openaiBaseUrl,
    azureOpenAIApiKey: config.generatorConfig.azureOpenAIApiKey,
    azureOpenAIBaseUrl: config.generatorConfig.azureOpenAIBaseUrl,
    azureOpenAIApiVersion: config.generatorConfig.azureOpenAIApiVersion,
    ollamaApiKey: config.generatorConfig.ollamaApiKey,
    ollamaBaseUrl: config.generatorConfig.ollamaBaseUrl,
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
    .replace(/^[*-]\s*/, '')
    .replace(/^[("'`\[]+/, '')
    .replace(/[)"'`\]]+$/, '');
}

function normalizeQuestionContext(value: string): string {
  return normalizeKey(value).replace(/\s+/g, ' ');
}

function splitRoleValue(value: string): string[] {
  return stripChoicePrefix(value)
    .split(/\s*(?:\n|,|;|\||\bor\b|(?:[-–—]\s+))\s*/gi)
    .map((part) => cleanText(part))
    .filter(Boolean);
}

function isNegativeRolePhrase(value: string): boolean {
  return /^(?:none|no one|nobody|not applicable|n\/a|na|never|unknown|no formal approval is typically needed)$/i.test(value);
}

function isGenericRolePhrase(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return true;
  return /^(?:(?:any\s+|an?\s+|the\s+)?authori[sz]ed\s+users?|various\s+roles?|different\s+roles?|a\s+different\s+role|anyone|someone|everyone|no\s+specific\s+role|any\s+user|a\s+user|the\s+user|users?)$/i.test(normalized);
}

function isReferentialRolePhrase(value: string): boolean {
  return /\b(?:same person|same role|person who|role that|creator|plan creator|case owner|record owner|owner of the case)\b/i.test(value);
}

// Rejects strings that look like metrics, sentences, or non-actor entities.
// Applied as an additional guard inside looksLikeRolePhrase and at storage
// normalization to stop things like "Plan creation cycle time" leaking as actors.
export function isPlausibleRoleLabel(value: string): boolean {
  const v = value.trim();
  // Reject if it contains standalone metric vocabulary
  if (/\b(rate|latency|percent|percentage|ratio|throughput|accuracy|volume|duration|count|cycle time|lead time|response time|turn(?:around)?\s+time)\b/i.test(v)) return false;
  // Reject sentence-like strings (contains a full stop followed by a space, or more than 8 words)
  if (/\.\s/.test(v) || v.split(/\s+/).length > 8) return false;
  // Require at least one alpha token of 2+ chars (accepts short acronyms like "TSS")
  if (!(v.match(/\b[A-Za-z]{2,}\b/))) return false;
  return true;
}

function looksLikeRolePhrase(value: string): boolean {
  const cleaned = stripChoicePrefix(value).replace(/\.$/, '');
  if (!cleaned || cleaned.length < 3 || cleaned.length > 80) return false;
  if (/[?!]/.test(cleaned)) return false;
  if (isNegativeRolePhrase(cleaned)) return false;
  if (isGenericRolePhrase(cleaned)) return false;
  if (isReferentialRolePhrase(cleaned)) return false;
  if (!isPlausibleRoleLabel(cleaned)) return false;
  if (/^(?:the\s+)?(?:case|plan|service)?\s*(?:owners?|users?|teams?)$/i.test(cleaned)) return false;
  if (/\bto\s+(?:initiate|create|generate|define|specify|modify|view|manage|perform|track)\b/i.test(cleaned)) return false;
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
    const role = stripChoicePrefix(match[1] ?? '')
      .replace(/^the\s+/i, '')
      .replace(/\.$/, '');
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
    const cleaned = stripChoicePrefix(value)
      .replace(/^the\s+/i, '')
      .replace(/\.$/, '');
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
    `ROLE CONSTRAINT: ${roleVocabulary.join(', ')}`,
    extractedRoles.length
      ? 'These are the human actor labels grounded in the requirement or answered discovery. Prefer them when naming actors in feature descriptions; match them verbatim when a feature is clearly about one of these roles, and only introduce a different named role when the scenario genuinely requires one.'
      : 'These are the configured workspace roles. Use them verbatim when a feature clearly fits one of them; otherwise prefer the most specific actor that evidence supports.',
    'Choose one actor label per feature description unless the label is already collective.',
    'Never use referential phrases like "the plan creator", generic placeholders like "any authorized user", or non-actor answers (e.g. approval states) as role labels.',
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
            .slice(0, 6)
            .map((item) => cleanText(item.text))
            .filter(Boolean);
          return lines.length ? `${label}:\n- ${lines.join('\n- ')}` : '';
        })
        .filter(Boolean)
    : [];

  if (insightSections.length) {
    return trimPromptText(insightSections.join('\n\n'), 5200);
  }
  return trimPromptText(wiContextText, 5200);
}

// Lightweight token-overlap score: counts shared 4+ char non-stopword tokens
// relative to the insight's own token count. Threshold 0.2 = 20% of insight
// tokens appear in the requirement — enough to confirm domain relevance.
const WI_STOPWORDS = new Set([
  'that', 'this', 'with', 'from', 'will', 'have', 'been', 'when', 'then',
  'than', 'they', 'them', 'their', 'there', 'what', 'which', 'where', 'were',
  'each', 'also', 'into', 'such', 'only', 'both', 'most', 'some', 'more',
  'over', 'other', 'after', 'before', 'during', 'through', 'between', 'about',
  'under', 'should', 'would', 'could', 'must', 'shall', 'need', 'used', 'using',
]);

function wiTokenSet(text: string): string[] {
  return (text.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? []).filter(w => !WI_STOPWORDS.has(w));
}

function wiInsightRelevanceScore(insightText: string, requirementText: string): number {
  const insightTokens = wiTokenSet(insightText);
  if (!insightTokens.length) return 0;
  const reqSet = new Set(wiTokenSet(requirementText));
  const shared = insightTokens.filter(t => reqSet.has(t)).length;
  return shared / insightTokens.length;
}

function buildResolvedEvidenceBullets(
  wiInsightsArtifact: WorkInstructionInsightArtifact | null | undefined,
  requirement: string,
): string {
  if (!wiInsightsArtifact) return '';
  const candidates = [
    ...wiInsightsArtifact.mustCoverBehaviors,
    ...wiInsightsArtifact.sequencingRules,
    ...wiInsightsArtifact.splitVsSingleCaseRules,
    ...wiInsightsArtifact.businessRules,
  ];
  const relevant = candidates
    .map(item => ({ text: cleanText(item.text), score: wiInsightRelevanceScore(item.text, requirement) }))
    .filter(({ text, score }) => text.length >= 20 && score >= 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ text }) => `- ${text}`);

  if (!relevant.length) return '';
  return trimPromptText(
    `RESOLVED EVIDENCE (do not re-ask — already known from work instructions):\n${relevant.join('\n')}`,
    800,
  );
}

function formatDiscoveryBacklogEvidence(similarStories: SimilarStory[] = []): string {
  if (!similarStories.length) return '';
  const formatted = formatSimilarStoriesText(similarStories, 3);
  return trimPromptText(formatted, 3200);
}

function formatGenerationBacklogEvidence(similarStories: SimilarStory[] = []): string {
  if (!similarStories.length) return '';
  const formatted = formatSimilarStoriesText(similarStories, 3);
  return trimPromptText(formatted, 3000);
}

function buildBacklogPatternSummary(similarStories: SimilarStory[] = []): string {
  if (!similarStories.length) return '';
  return 'features tend to separate business capabilities, grounded role ownership, workflow gates, and concrete downstream effects into distinct scenarios';
}

function extractMustCarryRules(answers: ClarifyAnswer[]): string[] {
  return answers
    .filter((answer) => {
      const answerText = cleanText(answer.answer);
      if (!answerText) return false;
      return ['functional_flow', 'business_rules', 'success_measurement'].includes(answer.categoryKey ?? '');
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
  wiInsightsArtifact?: WorkInstructionInsightArtifact | null;
  similarStoriesText?: string;
}) {
  const mergedRequirement = mergeRequirementAndAttachment(input.requirement, input.attachmentText);
  const parts = [`Requirement: ${trimPromptText(mergedRequirement, 16000)}`];
  const resolvedBullets = buildResolvedEvidenceBullets(input.wiInsightsArtifact, input.requirement);
  if (resolvedBullets) {
    parts.push(resolvedBullets);
  }
  if (input.wiEvidenceText.trim()) {
    parts.push(`Operational evidence from Work Instructions (use to ask sharper, process-grounded questions; treat as already-known domain context):\n${input.wiEvidenceText}`);
  }
  if (input.similarStoriesText?.trim()) {
    parts.push(`Relevant backlog references from this workspace (use as evidence of what this requirement likely implies — domain norms, vocabulary, typical scope. Ask follow-ups only where they leave ambiguity):\n${input.similarStoriesText}`);
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
    parts.push(`Operational evidence from Work Instructions (treat as already-known domain context):\n${input.wiEvidenceText}`);
  }
  if (input.similarStoriesText?.trim()) {
    parts.push(`Relevant backlog references from this workspace (use as evidence of what this requirement likely implies; ask follow-ups only where they leave ambiguity):\n${input.similarStoriesText}`);
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
    parts.push(`Relevant backlog references from this workspace (use as evidence of domain vocabulary, scope, and typical feature structure — do not copy actor labels or business rules that differ from this requirement):\n${input.similarStoriesText}`);
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

function normalizeSuggestions(values: unknown[], min = 0, max = 4): string[] {
  return uniqueStrings(values)
    .map((value) => cleanText(value).replace(/[?.!]+$/g, ''))
    .filter(Boolean)
    .slice(0, Math.max(min, max));
}

const DISCOVERY_DEPTH_ORDER: Record<DiscoveryDepth, number> = {
  light: 1,
  standard: 2,
  deep: 3,
};

const OBLIGATION_CATEGORY_MAP: Record<string, ClarifyCategoryKey[]> = {
  ownership: ['user_personas'],
  actors: ['user_personas'],
  approvals: ['user_personas', 'business_rules'],
  prerequisites: ['context_trigger'],
  trigger: ['context_trigger'],
  sequencing: ['functional_flow'],
  dependencies: ['functional_flow', 'business_rules'],
  downstream_initiation: ['functional_flow'],
  quote_and_billing: ['business_rules'],
  entitlement_and_contract: ['business_rules'],
  disruption_and_exceptions: ['business_rules', 'functional_flow'],
  validation: ['business_rules'],
  status_visibility: ['success_measurement', 'functional_flow'],
  active_change_handling: ['functional_flow', 'business_rules'],
  success_measurement: ['success_measurement'],
  linked_assets: ['functional_flow'],
};

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
    ? { min: 5, max: 7 }
    : depth === 'deep'
      ? { min: 12, max: 16 }
      : { min: 8, max: 12 };
  if (!value || typeof value !== 'object') return fallback;
  const candidate = value as { min?: unknown; max?: unknown };
  const min = Number.isFinite(candidate.min) ? Math.max(1, Math.round(Number(candidate.min))) : fallback.min;
  const max = Number.isFinite(candidate.max) ? Math.max(min, Math.round(Number(candidate.max))) : fallback.max;
  return {
    min: Math.min(min, 18),
    max: Math.min(Math.max(max, min), 18),
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
    parts.push(`Work instruction evidence summary:\n${trimPromptText(wiEvidenceText, 2400)}`);
  }
  if (similarStoriesText.trim()) {
    parts.push(`Backlog theme summary:\n${trimPromptText(similarStoriesText, 1800)}`);
  }
  if (domainContext.trim()) {
    parts.push(`Business context:\n${trimPromptText(domainContext, 1200)}`);
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

function storyAssistantQuestionPlan(
  profile: PipelineProfile,
  complexity: DiscoveryDimensionLevel,
  assessed: { min: number; max: number },
): { min: number; max: number; target: number } {
  const profileBounds = profile === 'fast'
    ? { min: 4, max: 8 }
    : profile === 'quality'
      ? { min: 12, max: 18 }
      : { min: 8, max: 14 };
  const complexityBias = complexity === 'high' ? 2 : complexity === 'low' ? -1 : 0;
  const min = Math.max(profileBounds.min, Math.min(profileBounds.max, assessed.min + complexityBias));
  const max = Math.max(min, Math.min(profileBounds.max, assessed.max + complexityBias));
  const target = Math.max(min, Math.min(max, Math.round((min + max) / 2)));
  return { min, max, target };
}

export function mergeDiscoveryAssessments(
  llmAssessment: DiscoveryAssessment | null,
  heuristicAssessment: DiscoveryAssessment,
): DiscoveryAssessment {
  if (!llmAssessment) return heuristicAssessment;
  const discoveryDepth = DISCOVERY_DEPTH_ORDER[heuristicAssessment.discoveryDepth] > DISCOVERY_DEPTH_ORDER[llmAssessment.discoveryDepth]
    ? heuristicAssessment.discoveryDepth
    : llmAssessment.discoveryDepth;
  const reasoningLevel = DISCOVERY_DEPTH_ORDER[heuristicAssessment.reasoningLevel] > DISCOVERY_DEPTH_ORDER[llmAssessment.reasoningLevel]
    ? heuristicAssessment.reasoningLevel
    : llmAssessment.reasoningLevel;
  return {
    ...llmAssessment,
    discoveryDepth,
    reasoningLevel,
    coverageObligations: uniqueStrings([
      ...llmAssessment.coverageObligations,
      ...heuristicAssessment.coverageObligations,
    ]),
    recommendedQuestionRange: {
      min: Math.max(llmAssessment.recommendedQuestionRange.min, heuristicAssessment.recommendedQuestionRange.min),
      max: Math.max(llmAssessment.recommendedQuestionRange.max, heuristicAssessment.recommendedQuestionRange.max),
    },
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
  const categoryKeys = new Set(questions.map((question) => question.categoryKey));
  const missingObligations = assessment.coverageObligations.filter((obligation) => {
    const requiredCategories = OBLIGATION_CATEGORY_MAP[obligation] ?? [];
    if (requiredCategories.some((categoryKey) => categoryKeys.has(categoryKey))) return false;
    return !new RegExp(obligation.replace(/_/g, '[ _-]?'), 'i').test(questionText);
  });

  let score = 100;
  if (questions.length < assessment.recommendedQuestionRange.min) {
    score -= 25;
    reasons.push('Returned fewer questions than the assessed discovery range suggests.');
  }
  if (missingObligations.length) {
    score -= Math.min(40, missingObligations.length * 8);
    reasons.push(`Missing discovery obligation coverage: ${missingObligations.join(', ')}.`);
  }
  const weakSuggestions = questions.filter((question) => question.suggestions.length < 3).length;
  if (weakSuggestions > 0) {
    score -= Math.min(15, weakSuggestions * 4);
    reasons.push('Some questions did not provide enough grounded suggestions.');
  }
  const longQuestions = questions.filter((question) => question.question.length > 220).length;
  if (longQuestions > 0) {
    score -= Math.min(10, longQuestions * 2);
    reasons.push('Some discovery questions were too broad or overpacked.');
  }
  if (questions.length >= 8) {
    const byCategory = questions.reduce<Map<ClarifyQuestion['categoryKey'], number>>((acc, question) => {
      acc.set(question.categoryKey, (acc.get(question.categoryKey) ?? 0) + 1);
      return acc;
    }, new Map());
    const dominantCategoryCount = Math.max(...Array.from(byCategory.values()));
    const dominantRatio = dominantCategoryCount / questions.length;
    if (dominantRatio > 0.55) {
      score -= Math.min(18, Math.round((dominantRatio - 0.55) * 40));
      reasons.push('Discovery questions were over-concentrated in one category, reducing obligation coverage balance.');
    }
  }
  const sequencingRequired = assessment.coverageObligations.includes('sequencing') || assessment.coverageObligations.includes('dependencies');
  if (sequencingRequired && !/sequence|dependency|order|before|after|prerequisite/.test(questionText)) {
    score -= 12;
    reasons.push('No explicit sequencing or dependency question was asked for a workflow that implies ordering.');
  }
  const gatesRequired = assessment.coverageObligations.includes('quote_and_billing')
    || assessment.coverageObligations.includes('entitlement_and_contract')
    || assessment.coverageObligations.includes('approvals');
  if (gatesRequired && !/quote|bill|contract|entitlement|approval|authori[sz]|covered/.test(questionText)) {
    score -= 12;
    reasons.push('No explicit gate, billing, entitlement, or approval question was asked where one is implied.');
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
  const parsed = extractQuestionCandidates(rawData)
    .flatMap((candidate) => {
      const rawQuestion = cleanText(candidate.question);
      if (!rawQuestion) return [];
      const categoryKey = normalizeDiscoveryCategoryKey(mapCategoryKey(candidate.categoryKey ?? candidate.category, rawQuestion));
      const category = cleanText(candidate.category)
        || (categoryKey === 'user_personas' ? 'Roles & Personas'
          : categoryKey === 'context_trigger' ? 'Context & Trigger'
          : categoryKey === 'functional_flow' ? 'Functional Flow'
          : categoryKey === 'state_lifecycle' ? 'State & Lifecycle'
          : categoryKey === 'business_rules' ? 'Business Rules & Exceptions'
          : 'Success & Measurement');
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
  return sortDiscoveryQuestions(parsed);
}

function normalizeSufficiencyFollowupQuestions(rawData: unknown): ClarifyQuestion[] {
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
  return parsed.slice(0, 2);
}

function shouldRetryDiscoveryQuestions(questions: ClarifyQuestion[]): boolean {
  if (questions.length < 4) return true;
  return questions.some((question) => (
    question.suggestions.length < 2
    || question.suggestions.length > 4
    || question.question.length > 240
  ));
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
  const followupCap = 1;
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
  llmAmbiguity?: { level?: string; score?: number; rationale?: string },
): NonNullable<ClarifyContextMeta['ambiguityAssessment']> {
  // Prefer LLM-provided level/score when the model returned a valid ambiguity envelope.
  // Fall back to the deterministic depth-enum mapping if the envelope is absent or malformed.
  const llmLevel = llmAmbiguity?.level === 'vague' || llmAmbiguity?.level === 'medium' || llmAmbiguity?.level === 'clear'
    ? llmAmbiguity.level as 'vague' | 'medium' | 'clear'
    : undefined;
  const llmScore = typeof llmAmbiguity?.score === 'number' && llmAmbiguity.score >= 1 && llmAmbiguity.score <= 10
    ? llmAmbiguity.score
    : undefined;

  const level = llmLevel ?? (
    assessment.ambiguityLevel === 'high'
      ? 'vague'
      : assessment.ambiguityLevel === 'medium'
        ? 'medium'
        : 'clear'
  );
  const score = llmScore ?? Math.max(
    1,
    Math.min(
      10,
      assessment.discoveryDepth === 'deep' ? 8 : assessment.discoveryDepth === 'standard' ? 6 : 3,
    ),
  );
  const reasons = qualityReasons.length
    ? qualityReasons
    : llmAmbiguity?.rationale
      ? [llmAmbiguity.rationale]
      : ['Discovery depth was calibrated from semantic workflow ambiguity rather than prompt length.'];
  return {
    level,
    score,
    reasons,
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

// ─── Multi-activity coverage probe ────────────────────────────────────────────

const MULTI_ACTIVITY_KEYWORDS = [
  'sequence', 'sequenced', 'sequential', 'sequencing',
  'dependency', 'dependencies', 'dependent',
  'de-install', 'deinstall', 'reinstall', 're-install',
  'loaner', 'loan',
  'in-house', 'off-site', 'offsite',
  'multi-activity', 'multi activity',
  'multiple activities', 'multiple work orders',
  'phased', 'phase',
  'follow-up actions', 'follow-on',
];

const DEPENDENCY_SUMMARIES_RE = /\b(enforc|sequen|depend|order|prerequisite|block|prevent)\b/i;
const VALIDATION_SUMMARIES_RE = /\b(valid|logical|illogical|detect|warn|alert|check sequence)\b/i;
const STATUS_SUMMARIES_RE = /\b(status|progress|visib|consolidat|overview|track|monitor)\b/i;

/**
 * Returns true when the requirement + WI sequencing signals strongly suggest
 * a multi-step orchestration workflow that could have missing coverage.
 */
function isMultiActivityRequirement(
  requirement: string,
  wiInsightsArtifact?: WorkInstructionInsightArtifact | null,
): boolean {
  const text = requirement.toLowerCase();
  if (MULTI_ACTIVITY_KEYWORDS.some((kw) => text.includes(kw))) return true;
  // Also flag when WI sequencing rules are present — they indicate dependency ordering matters
  const seqRules = wiInsightsArtifact?.sequencingRules ?? [];
  return seqRules.length >= 2;
}

/**
 * Check whether the pass-1 feature set already covers the three key dimensions
 * of a multi-activity workflow: dependency enforcement, sequence validation,
 * and consolidated status visibility.
 */
function checkMultiActivityCoverage(features: Feature[]): {
  missingDependencyEnforcement: boolean;
  missingSequenceValidation: boolean;
  missingConsolidatedStatus: boolean;
} {
  const summaries = features.map((f) => (f.summary ?? '') + ' ' + (f.description ?? ''));
  const combined = summaries.join(' ');
  return {
    missingDependencyEnforcement: !DEPENDENCY_SUMMARIES_RE.test(combined),
    missingSequenceValidation: !VALIDATION_SUMMARIES_RE.test(combined),
    missingConsolidatedStatus: !STATUS_SUMMARIES_RE.test(combined),
  };
}

/**
 * Run a targeted LLM call to add only the missing multi-activity coverage features.
 * Budget-gated: skips on fast profile or when no gaps are detected.
 * Returns any new features to be appended to the pass-1 set, or [] if nothing needed.
 */
async function runMultiActivityCoverageProbe(opts: {
  features: Feature[];
  requirement: string;
  wiInsightsArtifact?: WorkInstructionInsightArtifact | null;
  config: TenantConfig;
  model: string;
  pipelineProfile: PipelineProfile;
  providerOpts: Record<string, unknown>;
}): Promise<{ newRaw: RawFeature[]; probeNote: string | null }> {
  if (opts.pipelineProfile === 'fast') return { newRaw: [], probeNote: null };
  if (!isMultiActivityRequirement(opts.requirement, opts.wiInsightsArtifact)) {
    return { newRaw: [], probeNote: null };
  }

  const { missingDependencyEnforcement, missingSequenceValidation, missingConsolidatedStatus } =
    checkMultiActivityCoverage(opts.features);

  const gaps: string[] = [];
  if (missingDependencyEnforcement) gaps.push('dependency enforcement between sequenced activities (preventing a later step from being initiated before its prerequisite is complete)');
  if (missingSequenceValidation) gaps.push('logical sequence validation (detecting and warning when activities are ordered illogically, e.g. a re-installation before a de-installation)');
  if (missingConsolidatedStatus) gaps.push('consolidated status visibility across all activities in the plan for a managing role');

  if (!gaps.length) return { newRaw: [], probeNote: null };

  const existingSummaries = opts.features.map((f, i) => `${i + 1}. ${f.summary}`).join('\n');
  const gapList = gaps.map((g, i) => `${i + 1}. ${g}`).join('\n');
  const userMessage = `Original requirement:\n${opts.requirement}\n\nExisting features already decomposed:\n${existingSummaries}\n\nThe following multi-activity workflow coverage is missing:\n${gapList}\n\nAdd only the features needed to cover these specific gaps. Return an empty array if any gap is already covered by the existing features. Do not rewrite or rename existing features.`;

  try {
    const result = await callLlmJsonWithUsage<{ features?: RawFeature[] }>({
      model: opts.model,
      systemPrompt: buildAddFeatureSystemPrompt({
        domainContext: opts.config.domainContext,
        domainRoles: opts.config.domainRoles ?? [],
        processTaxonomy: opts.config.processTaxonomy ?? [],
        processTaxonomyEnabled: opts.config.processTaxonomyEnabled ?? false,
      }),
      userMessage,
      maxTokens: 4096,
      reasoningEffort: 'medium',
      ...opts.providerOpts,
    });
    const newRaw = extractRawFeaturesFromPayload(result.data);
    if (!newRaw.length) return { newRaw: [], probeNote: 'Coverage probe: no gaps found after LLM review.' };
    return {
      newRaw,
      probeNote: `Coverage probe added ${newRaw.length} feature(s) for: ${gaps.join('; ')}.`,
    };
  } catch {
    return { newRaw: [], probeNote: 'Coverage probe failed silently; continuing without additions.' };
  }
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
    const candidate = payload as { features?: unknown; items?: unknown };
    if (Array.isArray(candidate.features)) {
      return candidate.features.filter((feature): feature is RawFeature => Boolean(feature && typeof feature === 'object'));
    }
    if (Array.isArray(candidate.items)) {
      return candidate.items.filter((feature): feature is RawFeature => Boolean(feature && typeof feature === 'object'));
    }
  }
  return [];
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
  const pipelineProfile = resolveStoryAssistantPipelineProfile(opts.config.generatorConfig);
  const profileConfig = getStoryAssistantPipelineProfileConfig(opts.config.generatorConfig);
  const modelRoute = buildStoryAssistantModelRoute(opts.config.generatorConfig);
  let promptAssemblyMs = 0;
  const wiEvidenceText = formatWiEvidence(opts.wiInsightsArtifact, opts.wiContextText);
  const similarStoriesText = formatDiscoveryBacklogEvidence(opts.similarStories ?? []);
  const heuristicAssessment = buildHeuristicDiscoveryAssessment({
    requirement: opts.requirement,
    attachmentText: opts.attachmentText,
    wiEvidenceText,
    similarStoriesText,
  });
  const questionPlan = storyAssistantQuestionPlan(
    pipelineProfile,
    heuristicAssessment.ambiguityLevel,
    heuristicAssessment.recommendedQuestionRange,
  );
  const discoveryAssessment: DiscoveryAssessment = {
    ...heuristicAssessment,
    recommendedQuestionRange: { min: questionPlan.min, max: questionPlan.max },
    rationale: `Discovery depth inferred from requirement complexity with ${pipelineProfile} profile bounds.`,
  };
  const baseUserMessageStartedAt = Date.now();
  const baseUserMessage = buildClarifyUserMessage({
    requirement: opts.requirement,
    attachmentText: opts.attachmentText,
    wiEvidenceText,
    wiInsightsArtifact: opts.wiInsightsArtifact,
    similarStoriesText,
  });
  promptAssemblyMs += Date.now() - baseUserMessageStartedAt;

  const clarifyModel = getTierModel(modelRoute.clarify ?? opts.config.generatorConfig.clarifyModel, opts.config.tier);
  let clarifyResult = await callLlmJsonWithUsage<unknown>({
    model: clarifyModel,
    systemPrompt: buildStoryAssistantClarifySystemPrompt({
      domainContext: opts.config.domainContext,
      domainRoles: opts.config.domainRoles,
      questionPlan,
    }),
    userMessage: baseUserMessage,
    maxTokens: 4600,
    reasoningEffort: profileConfig.clarifyReasoning,
    ...providerOpts,
  });
  usageByStage.clarify = clarifyResult.usage;
  let questions = parseStoryAssistantQuestionCandidates(clarifyResult.data);

  const needsStructuralRetry = questions.length === 0 || clarifyResult.parseOutcome === 'repaired_parse';
  let coverageRetryTriggered = false;
  if (needsStructuralRetry) {
    coverageRetryTriggered = true;
    clarifyResult = await callLlmJsonWithUsage<unknown>({
      model: clarifyModel,
      systemPrompt: buildStoryAssistantClarifySystemPrompt({
        domainContext: opts.config.domainContext,
        domainRoles: opts.config.domainRoles,
        questionPlan,
      }),
      userMessage: `${baseUserMessage}\n\nReturn strict JSON only. Each question must be complete, requirement-specific, and include 3 concise grounded suggestions.`,
      maxTokens: 4600,
      reasoningEffort: profileConfig.clarifyReasoning,
      ...providerOpts,
    });
    usageByStage.clarifyRetry = clarifyResult.usage;
    questions = parseStoryAssistantQuestionCandidates(clarifyResult.data);
  }
  const missingDiscoveryCategories = DISCOVERY_CATEGORY_ORDER.filter(
    (categoryKey) => !questions.some((question) => question.categoryKey === categoryKey),
  );
  const needsCoverageRetry = questions.length < questionPlan.min
    || (questionPlan.min >= 5 && missingDiscoveryCategories.length > 0);
  if (needsCoverageRetry) {
    coverageRetryTriggered = true;
    const missingLabels = missingDiscoveryCategories
      .map((categoryKey) => (
        categoryKey === 'user_personas'
          ? 'Roles & Personas'
          : categoryKey === 'context_trigger'
            ? 'Trigger & Context'
            : categoryKey === 'functional_flow'
              ? 'Functional Flow'
              : categoryKey === 'state_lifecycle'
                ? 'State & Lifecycle'
              : categoryKey === 'business_rules'
                ? 'Business Rules & Exceptions'
                : 'Success & Measurement'
      ))
      .join(', ');
    clarifyResult = await callLlmJsonWithUsage<unknown>({
      model: clarifyModel,
      systemPrompt: buildStoryAssistantClarifySystemPrompt({
        domainContext: opts.config.domainContext,
        domainRoles: opts.config.domainRoles,
        questionPlan,
      }),
      userMessage: `${baseUserMessage}\n\nReturn strict JSON only. Provide ${questionPlan.min}-${questionPlan.max} specific questions and cover categories in this order: Context & Trigger, Roles & Personas, Functional Flow, State & Lifecycle, Business Rules & Exceptions, Success & Measurement.${missingLabels ? ` Missing in prior attempt: ${missingLabels}.` : ''}`,
      maxTokens: 5200,
      reasoningEffort: profileConfig.clarifyReasoning,
      ...providerOpts,
    });
    usageByStage.clarifyCoverageRetry = clarifyResult.usage;
    questions = parseStoryAssistantQuestionCandidates(clarifyResult.data);
  }
  const quality = evaluateClarifyQuestionSetQuality(questions, discoveryAssessment);
  const coverageQualityScore = quality.score;
  const qualityReasons = quality.reasons;

  // Extract the ambiguity envelope returned by the new clarify output schema.
  // The envelope is {"ambiguity":{level,score,rationale},"questions":[...]} — if present,
  // prefer its level/score over the deterministic depth-enum fallback.
  const llmAmbiguity = (clarifyResult.data && typeof clarifyResult.data === 'object' && !Array.isArray(clarifyResult.data))
    ? (clarifyResult.data as Record<string, unknown>).ambiguity as { level?: string; score?: number; rationale?: string } | undefined
    : undefined;

  const discoveryProfile = buildMinimalDiscoveryProfile(questions, discoveryAssessment);
  const ambiguityAssessment = buildClarifyAmbiguityAssessment(
    questions,
    discoveryAssessment,
    coverageQualityScore,
    qualityReasons,
    llmAmbiguity,
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
    let parsedQuestions = normalizeSufficiencyFollowupQuestions(payload);
    const looksMalformedFollowup = payload.sufficient === false
      && (!Array.isArray(payload.questions) || parsedQuestions.length === 0);
    if (looksMalformedFollowup) {
      const retry = await evaluateOnce(
        'Your previous follow-up output was malformed. Return strict JSON only. If sufficient is false and you provide questions, include exactly one complete question with 1-3 grounded suggestions.',
      );
      result = retry;
      usageByStage.clarifyEvaluateRetry = retry.usage;
      payload = (retry.data && typeof retry.data === 'object' ? retry.data as Record<string, unknown> : {});
      parsedQuestions = normalizeSufficiencyFollowupQuestions(payload);
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
        plannedQuestionBudget: opts.answers.length + 2,
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
  projectKey?: string;
  projectKeys?: string[];
  discoveryProfile?: DiscoveryProfile;
  config: TenantConfig;
  precomputedDraftFeatures?: Feature[];
  priorStageDurationsMs?: GenerationStageDurationsMs;
  onPass1DraftFeatures?: (draftFeatures: Feature[]) => Promise<void>;
  shouldCancel?: () => Promise<boolean> | boolean;
}): Promise<GenerationResult> {
  const providerOpts = buildProviderOpts(opts.config);
  const pipelineProfile = resolveStoryAssistantPipelineProfile(opts.config.generatorConfig);
  const profileConfig = getStoryAssistantPipelineProfileConfig(opts.config.generatorConfig);
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
  const wiEvidenceText = formatWiEvidence(opts.wiInsightsArtifact, opts.wiContextText);
  const similarStoriesText = formatGenerationBacklogEvidence(opts.similarStories ?? []);
  const arPatternLibraryText = pipelineProfile === 'fast' ? undefined : opts.arPatternLibraryText;
  const backlogPatternSummary = buildBacklogPatternSummary(opts.similarStories ?? []);
  let promptAssemblyMs = 0;
  let pass1Raw: RawFeature[] = [];
  let pass1Features: Feature[] = opts.precomputedDraftFeatures ?? [];
  let goldExampleIssueKeys: string[] = [];
  let goldExampleLabel: string | undefined;
  let goldExamplesText = '';

  const maybeCancelled = async () => Boolean(await opts.shouldCancel?.());

  if (!opts.precomputedDraftFeatures?.length) {
    const activeProjectKey = opts.projectKeys?.[0] ?? opts.projectKey;
    if (activeProjectKey) {
      try {
        const goldPool = await getGoldStoryPool(activeProjectKey);
        if (goldPool?.entries?.length) {
          const configuredGold = findGoldConfigForProject(activeProjectKey, opts.config.goldExampleConfigs);
          const resolvedKeys = await resolveGoldKeysFromBacklog(activeProjectKey, opts.config.goldExampleConfigs)
            ?? resolveGoldKeys(activeProjectKey, opts.config.goldExampleConfigs, goldPool);
          goldExampleIssueKeys = (resolvedKeys?.length ? resolvedKeys : goldPool.entries.map((entry) => entry.key)).slice(0, 8);
          goldExampleLabel = configuredGold?.label?.trim() || undefined;
          goldExamplesText = formatGoldStoryExemplars(goldPool, resolvedKeys ?? undefined);
        }
      } catch {
        // Non-blocking: gold exemplars sharpen output but should not stop generation.
      }
    }
  }

  // Build the shared evidence block once so both pass 1 and pass 2 user
  // messages share a byte-identical leading prefix, enabling Gemini implicit
  // prefix caching on pass 2 (which sees the same content + a new trailing task).
  const sharedEvidenceBlock = buildGenerationContextMessage({
    requirement: opts.requirement,
    clarifyAnswers: opts.clarifyAnswers,
    attachmentText: opts.attachmentText,
    wiEvidenceText,
    roleHint,
    discoveryProfile: opts.discoveryProfile,
    actorSets,
    similarStoriesText,
    arPatternLibraryText,
  });

  if (!pass1Features.length) {
    const startedAt = Date.now();
    const decompositionPromptStartedAt = Date.now();
    const decompositionUserMessage = `${sharedEvidenceBlock}\n\nDecompose this requirement into the distinct features needed to deliver it. Leave acceptance_requirements as empty arrays.`;
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
      maxTokens: Math.min(Math.max(opts.config.generatorConfig.maxTokens, 4096), profileConfig.generationOutputMaxTokens),
      reasoningEffort: profileConfig.decompositionReasoning,
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

  // ── Multi-activity coverage probe ─────────────────────────────────────────
  // Runs only when sequencing/multi-step signals are detected and not on fast
  // profile. Adds missing dependency-enforcement, sequence-validation, or
  // consolidated-status features without re-running full decomposition.
  const probeNotes: string[] = [];
  if (profileConfig.enableCoverageProbe) {
    const probeResult = await runMultiActivityCoverageProbe({
      features: pass1Features,
      requirement: opts.requirement,
      wiInsightsArtifact: opts.wiInsightsArtifact,
      config: opts.config,
      model: getTierModel(modelRoute.decomposition ?? opts.config.generatorConfig.decompositionModel, opts.config.tier),
      pipelineProfile,
      providerOpts: providerOpts as Record<string, unknown>,
    });
    if (probeResult.newRaw.length) {
      const newFeatures = probeResult.newRaw.map((f) => normaliseFeature({ ...f, acceptance_requirements: [] }, roleGrounding));
      pass1Raw = [...pass1Raw, ...probeResult.newRaw];
      pass1Features = [...pass1Features, ...newFeatures];
    }
    if (probeResult.probeNote) probeNotes.push(probeResult.probeNote);
  }

  let features: Feature[];
  let pass2CoverageNotes: string[] = [];
  let failedIds = new Set<string>();
  let autoRepairedIssues: string[] = [];
  const pass2StartedAt = Date.now();
  const arPromptStartedAt = Date.now();
  const arReferenceExamplesText = goldExamplesText ? `\n\n${goldExamplesText}` : '';
  const arUserMessage = `${sharedEvidenceBlock}\n\nFeatures to write acceptance requirements for:\n${JSON.stringify({
    features: pass1Raw.map((feature) => ({
      ...feature,
      acceptance_requirements: [],
    })),
  })}${arReferenceExamplesText}\n\nFor each feature, write GIVEN/WHEN/THEN acceptance requirements that preserve concrete scenarios, gates, dependencies, validation safeguards, downstream actions, status visibility, and active-plan change handling where supported by the requirement, discovery answers, work instructions, or grounded backlog patterns.`;
  promptAssemblyMs += Date.now() - arPromptStartedAt;
  const pass2Result = await callLlmJsonWithUsage<{ features?: RawFeature[] }>({
    model: getTierModel(modelRoute.ar ?? opts.config.generatorConfig.arModel, opts.config.tier),
    systemPrompt: buildStoryAssistantArSystemPrompt({
      domainContext: opts.config.domainContext,
      domainRoles: opts.config.domainRoles,
      wiInsights: opts.wiInsightsArtifact
        ? {
            sequencingRules: opts.wiInsightsArtifact.sequencingRules,
            splitVsSingleCaseRules: opts.wiInsightsArtifact.splitVsSingleCaseRules,
            mustCoverBehaviors: opts.wiInsightsArtifact.mustCoverBehaviors,
            businessRules: opts.wiInsightsArtifact.businessRules,
          }
        : undefined,
      backlogPatternSummary,
    }),
    userMessage: arUserMessage,
    maxTokens: profileConfig.generationOutputMaxTokens,
    reasoningEffort: profileConfig.arReasoning,
    ...providerOpts,
  });
  stageUsage.acceptanceRequirements = pass2Result.usage;
  stageDurationsMs.acceptanceRequirements = Date.now() - pass2StartedAt;

  const pass2Raw = extractRawFeaturesFromPayload(pass2Result.data);
  const mergedRaw = mergePass2IntoPass1(pass1Raw, pass2Raw);
  let twoPassFeatures = mergedRaw.map((feature) => normaliseFeature(feature, roleGrounding));
  const repairedOutput = dedupeExactAcceptanceRequirements(twoPassFeatures);
  autoRepairedIssues = repairedOutput.notes;
  pass2CoverageNotes = pass2Raw.length === 0
    ? ['Acceptance requirements pass returned no feature array; preserved pass-1 features for targeted retries.']
    : pass2Raw.length < pass1Raw.length
      ? ['Acceptance requirements pass returned fewer features than decomposition; merged by id/summary and index fallback.']
      : [];
  features = repairedOutput.features;
  const failedIndexes = findFeaturesMissingCompleteAcceptanceRequirements(features);
  failedIds = new Set(failedIndexes.map((index) => features[index]?.id).filter(Boolean) as string[]);

  if (failedIds.size > 0) {
    features = annotateFailedAcceptanceRequirementFeatures(features, failedIds) as Feature[];
  }
  const acceptanceRequirementCount = features.reduce(
    (sum, feature) => sum + (feature.acceptanceRequirements?.length ?? 0),
    0,
  );
  const completeFeatureCount = features.length - failedIds.size;

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
        ...(stageDurationsMs.coverageCheck ? { coverageCheck: stageDurationsMs.coverageCheck } : {}),
        total: stageDurationsMs.total,
      },
      pipelineProfile,
      failedFeatureIds: [...failedIds],
      partialSuccess: failedIds.size > 0,
      partialSuccessMessage: failedIds.size > 0
        ? `Acceptance requirements could not be completed for ${failedIds.size} feature${failedIds.size === 1 ? '' : 's'}.`
        : undefined,
      autoRepairedIssues,
      ...(pass2CoverageNotes.length ? { mergeDiagnostics: pass2CoverageNotes } : {}),
      ...(probeNotes.length ? { coverageProbeNotes: probeNotes } : {}),
      actorSets,
      pass2ArPatternStoryKeys: opts.arPatternStoryKeys,
      goldExampleIssueKeys: goldExampleIssueKeys.length ? goldExampleIssueKeys : undefined,
      goldExampleLabel,
      selectedEvidenceSummary: {
        wiDocCount: opts.wiInsightsArtifact?.sourceSpans?.length ?? 0,
        similarStoryCount: opts.similarStories?.length ?? 0,
        arPatternStoryCount: opts.arPatternStoryKeys?.length ?? 0,
        ...(goldExampleIssueKeys.length ? { goldExampleIssueKeys } : {}),
        ...(goldExampleLabel ? { goldExampleLabel } : {}),
      },
      latencyMs: {
        promptAssemblyMs,
      },
      tokenUsage,
      arCoverageStats: {
        featureCount: features.length,
        completeFeatureCount,
        incompleteFeatureCount: failedIds.size,
        acceptanceRequirementCount,
        averageAcceptanceRequirementsPerFeature: features.length
          ? Number((acceptanceRequirementCount / features.length).toFixed(2))
          : 0,
      },
    } as any,
  };
}
