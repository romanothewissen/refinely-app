/**
 * Two-pass feature generation pipeline.
 *
 * Pass 1: Decompose requirement into features (summary, description, process_code, story_points)
 * Pass 2: Write GIVEN/WHEN/THEN acceptance requirements for each feature
 *
 * Both passes use Forge LLMs (Claude) — no external API calls.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  AcceptanceRequirement,
  Feature,
  ClarifyQuestion,
  ClarifyAnswer,
  ClarifyCategoryKey,
  ClarifyFailureReasonCode,
  TenantConfig,
  GenerationResult,
  GenerationSizingAssessment,
  EffectiveSizingContract,
  SizingAssessmentArDepth,
  SizingAssessmentArchetype,
  SizingAssessmentConfidence,
  SizingAssessmentReason,
  SizingAssessmentSnapshot,
  SizingAssessmentVerdict,
  TokenUsageSummary,
  DiscoveryProfile,
  GenerationStageDurationsMs,
} from '../types';
import { callLlm, callLlmJson, callLlmJsonWithUsage } from './llm';
import { getTierModel } from '../services/billing';
import {
  buildDecompositionSystemPrompt,
  buildArSystemPrompt,
  buildArPerFeatureUserMessage,
  buildTriageSystemPrompt,
  buildClarifySystemPrompt,
  buildEvaluateSystemPrompt,
  buildRefineSystemPrompt,
  buildSizingRepairSystemPrompt,
  buildSingleFeatureRefineSystemPrompt,
  buildRefineSufficiencyPrompt,
} from './prompts';
import { validateFeatures } from './quality-validator';
import { hasIncompleteAcceptanceRequirements } from './ar-validation';
import {
  allowsZeroQuestionDiscovery,
  extractDiscoverySignals,
  expandRawQuestionCandidate,
  calibrateDiscoveryProfile,
  finalizeFollowupDiscoveryQuestions,
  labelForCategoryKey,
  normalizeCategoryKey,
  normalizeDiscoveryProfile,
  validateAndRepairInitialDiscovery,
} from './discovery';

// ─── Types from LLM response ──────────────────────────────────────────────────

interface RawFeature {
  summary?: string;
  description?: string;
  /** Snake_case (preferred in prompts) */
  acceptance_requirements?: unknown[];
  /** Some models return camelCase — we merge both */
  acceptanceRequirements?: unknown[];
  suggested_story_points?: number;
  process_code?: string;
}

interface ClarifyQuestionPlan {
  min: number;
  max: number;
  target: number;
  clarity: 'clear' | 'medium' | 'vague';
}

interface FeaturePlan {
  min: number;
  max: number;
  target: number;
  shape: 'minimal' | 'narrow' | 'balanced' | 'broad' | 'epic';
  complexity: 'trivial' | 'low' | 'medium' | 'high' | 'very_high';
}

interface ArPlan {
  min: number;
  max: number;
  target: number;
  depth: 'minimal' | 'lean' | 'standard' | 'thorough' | 'comprehensive';
}

type SizingStage = 'decomposition' | 'final';

interface SizingAssessmentComputation {
  assessment: SizingAssessmentSnapshot;
  oversizeScore: number;
}

interface ExplicitSplitEvidence {
  code: string;
  detail: string;
  minimumFeatureCount: number;
}

interface SizingGuidance {
  archetype: SizingAssessmentArchetype;
  preferredFeatureRange: { min: number; max: number };
  preferredArDepth: SizingAssessmentArDepth;
  minimumPreservedFeatureCount: number;
  explicitSplitSignals: string[];
  explicitSplitEvidence: ExplicitSplitEvidence[];
}

export interface RequirementAssessment {
  questionPlan: ClarifyQuestionPlan;
  featurePlan: FeaturePlan;
  arPlan: ArPlan;
  ambiguityScore: number;
  ambiguityReasons: string[];
}

interface ClarifyAmbiguityAssessment {
  level: 'clear' | 'medium' | 'vague';
  score: number;
  reasons: string[];
  questionPlan: { min: number; max: number; target: number };
  generatedQuestions: number;
}

interface ClarifyDiscoveryResult {
  questions: ClarifyQuestion[];
  tokenUsage: TokenUsageSummary;
  ambiguityAssessment: ClarifyAmbiguityAssessment;
  discoveryProfile: DiscoveryProfile;
  sizingContract?: EffectiveSizingContract;
}

interface DiscoverySufficiencyEvaluation {
  sufficient: boolean;
  questions?: ClarifyQuestion[];
  missingCategoryKeys: ClarifyCategoryKey[];
  reasonCodes: string[];
  tokenUsage: TokenUsageSummary;
  durationMs: number;
}

const AR_GENERATION_ATTEMPTS = 2;
const AR_RETRY_DELAY_MS = 600;

export class AcceptanceRequirementsGenerationError extends Error {
  draftFeatures: Feature[];
  failedFeatureIndexes: number[];

  constructor(message: string, draftFeatures: Feature[], failedFeatureIndexes: number[]) {
    super(message);
    this.name = 'AcceptanceRequirementsGenerationError';
    this.draftFeatures = draftFeatures;
    this.failedFeatureIndexes = failedFeatureIndexes;
  }
}

export class Pass1DraftReviewRequiredError extends Error {
  draftFeatures: Feature[];
  sizingAssessment: SizingAssessmentSnapshot;
  triage: EffectiveSizingContract;
  stageDurationsMs: GenerationStageDurationsMs;

  constructor(
    draftFeatures: Feature[],
    sizingAssessment: SizingAssessmentSnapshot,
    triage: EffectiveSizingContract,
    stageDurationsMs: GenerationStageDurationsMs,
  ) {
    super('Generation paused for draft review.');
    this.name = 'Pass1DraftReviewRequiredError';
    this.draftFeatures = draftFeatures;
    this.sizingAssessment = sizingAssessment;
    this.triage = triage;
    this.stageDurationsMs = stageDurationsMs;
  }
}

function trimForPrompt(text: string, maxChars: number): string {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export class GenerationCancelledError extends Error {
  constructor() {
    super('Generation cancelled');
    this.name = 'GenerationCancelledError';
  }
}

export class ClarifyDiscoveryError extends Error {
  reasonCode: ClarifyFailureReasonCode;

  constructor(reasonCode: ClarifyFailureReasonCode, message?: string) {
    super(message ?? 'Clarifying question discovery failed');
    this.name = 'ClarifyDiscoveryError';
    this.reasonCode = reasonCode;
  }
}

const GENERIC_ROLE_WORDS = new Set([
  'user',
  'person',
  'individual',
  'professional',
  'worker',
  'staff',
  'member',
  'associate',
  'resource',
  'agent',
  'operator',
  'representative',
  'specialist',
  'technician',
  'engineer',
]);

const SIZING_STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'i', 'in', 'is', 'it',
  'its', 'need', 'of', 'on', 'or', 'so', 'that', 'the', 'their', 'this', 'to', 'when', 'with',
]);

const SUPPORTING_BEHAVIOR_TERMS = [
  'audit', 'notification', 'visibility', 'report', 'reporting', 'reason', 'policy', 'status',
  'monitor', 'monitoring', 'history', 'log', 'logging',
];

const OVERRIDE_TERMS = ['override', 'exempt', 'exception', 'allow', 'reason', 'approval'];

const PASS1_CONTEXT_LIMITS = {
  requirement: 5000,
  clarify: 5000,
  // Attachment is capped at ~25K chars (~6K tokens) — generous enough to cover most real documents
  // while preventing very large PDFs from inflating Pass 1 context and slowing decomposition.
  attachment: 25000,
  wi: 8000,
  similar: 5000,
} as const;

const PASS1_CONTEXT_LIMITS_COMPACT = {
  requirement: 4000,
  clarify: 3000,
  attachment: 25000,
  wi: 8000,
  similar: 3000,
} as const;

const PASS2_CONTEXT_LIMITS = {
  requirement: 4000,
  clarify: 4000,
  attachment: 25000,
  wi: 5000,
  similar: 3000,
} as const;

const MAX_CLARIFY_QUESTION_CHARS = 250;
const MAX_CLARIFY_DETAILS_CHARS = 280;
const MAX_CLARIFY_SUGGESTION_CHARS = 130;
const FOLLOWUP_GROUNDING_STOPWORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'first', 'for',
  'from', 'handling', 'how', 'if', 'improve', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or',
  'process', 'request', 'requests', 'should', 'system', 'team', 'that', 'the', 'their', 'this',
  'those', 'to', 'what', 'when', 'which', 'who', 'workflow',
]);
const GENERIC_FOLLOWUP_PATTERNS = [
  /\bwhat should automatic .* handling improve first\?/i,
  /\bwhat business outcome should .* improve first\?/i,
  /\bwhat should count as a successful .* outcome\?/i,
];

function trimPromptText(text: string, maxChars: number): string {
  const normalized = (text || '').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}\n...[truncated for speed]`;
}

export function collectDiscoveryGroundingTerms(parts: string[]): Set<string> {
  const terms = new Set<string>();
  const rawSignals = extractDiscoverySignals(parts);

  [...parts, ...rawSignals].forEach((part) => {
    const matches = String(part ?? '').match(/\b[A-Za-z][A-Za-z0-9/-]{2,}\b/g) ?? [];
    matches.forEach((token) => {
      const normalized = token.toLowerCase().replace(/[^a-z0-9/-]/g, '').trim();
      if (!normalized || normalized.length < 4 || FOLLOWUP_GROUNDING_STOPWORDS.has(normalized)) return;
      terms.add(normalized);
    });
  });

  return terms;
}

function countGroundingHits(text: string, groundingTerms: Set<string>): number {
  const seen = new Set<string>();
  let hits = 0;
  const tokens = String(text ?? '').match(/\b[A-Za-z][A-Za-z0-9/-]{2,}\b/g) ?? [];

  tokens.forEach((token) => {
    const normalized = token.toLowerCase().replace(/[^a-z0-9/-]/g, '').trim();
    if (!normalized || normalized.length < 4 || seen.has(normalized)) return;
    seen.add(normalized);
    if (groundingTerms.has(normalized)) hits += 1;
  });

  return hits;
}

type DiscoveryQuestionStrength = {
  hits: number;
  isBroadGenericPattern: boolean;
  questionLooksGeneric: boolean;
  weakForFollowup: boolean;
  strongForInitial: boolean;
};

function assessDiscoveryQuestionStrength(
  question: ClarifyQuestion,
  groundingTerms: Set<string>,
): DiscoveryQuestionStrength {
  const normalizedQuestion = question.question.trim();
  if (!normalizedQuestion) {
    return {
      hits: 0,
      isBroadGenericPattern: false,
      questionLooksGeneric: true,
      weakForFollowup: true,
      strongForInitial: false,
    };
  }

  const isBroadGenericPattern = GENERIC_FOLLOWUP_PATTERNS.some((pattern) => pattern.test(normalizedQuestion));
  const hits = countGroundingHits(normalizedQuestion, groundingTerms);
  const questionLooksGeneric = /\b(capability|process|system|workflow|handling|business outcome)\b/i.test(normalizedQuestion);

  return {
    hits,
    isBroadGenericPattern,
    questionLooksGeneric,
    weakForFollowup: isBroadGenericPattern || hits === 0 || (questionLooksGeneric && hits < 2),
    strongForInitial: hits >= 2 || (hits >= 1 && !questionLooksGeneric && !isBroadGenericPattern),
  };
}

export function followupQuestionsLookWeak(
  questions: ClarifyQuestion[],
  groundingTerms: Set<string>,
): boolean {
  if (!questions.length) return true;

  return questions.some((question) => assessDiscoveryQuestionStrength(question, groundingTerms).weakForFollowup);
}

export function initialQuestionsLookWeak(
  questions: ClarifyQuestion[],
  groundingTerms: Set<string>,
): boolean {
  if (!questions.length) return false;

  const assessments = questions.map((question) => assessDiscoveryQuestionStrength(question, groundingTerms));
  const groundedQuestionCount = assessments.filter((assessment) => assessment.hits > 0).length;
  const strongQuestionCount = assessments.filter((assessment) => assessment.strongForInitial).length;
  const allQuestionsWeak = assessments.every((assessment) => assessment.weakForFollowup);

  return allQuestionsWeak
    || groundedQuestionCount < Math.min(2, questions.length)
    || strongQuestionCount === 0;
}

function pushPromptSection(parts: string[], heading: string, text: string, maxChars: number) {
  const trimmed = trimPromptText(text, maxChars);
  if (!trimmed) return;
  parts.push(`${heading}:\n${trimmed}`);
}

function buildGenerationUserMessage(input: {
  requirement: string;
  clarifyAnswers: ClarifyAnswer[];
  attachmentText: string;
  wiContextText: string;
  similarStoriesText: string;
  limits: typeof PASS1_CONTEXT_LIMITS | typeof PASS1_CONTEXT_LIMITS_COMPACT | typeof PASS2_CONTEXT_LIMITS;
}): string {
  const parts = [`REQUIREMENT: ${trimPromptText(input.requirement, input.limits.requirement)}`];

  if (input.clarifyAnswers.length) {
    const qaText = input.clarifyAnswers
      .map(a => `Q: ${a.question}\nA: ${a.answer}`)
      .join('\n\n');
    pushPromptSection(parts, 'CLARIFICATION Q&A', qaText, input.limits.clarify);
  }

  pushPromptSection(parts, 'ATTACHMENT CONTEXT', input.attachmentText, input.limits.attachment);
  pushPromptSection(parts, 'WORK INSTRUCTIONS / OPERATIONAL GUIDANCE (treat relevant rules here as higher-authority business guidance than similar backlog stories)', input.wiContextText, input.limits.wi);
  pushPromptSection(parts, 'SIMILAR STORIES FROM BACKLOG (use these for business context only; never copy actor labels or scope when the requirement already specifies them)', input.similarStoriesText, input.limits.similar);

  return parts.join('\n\n---\n\n');
}

async function runDecompositionPass(input: {
  userMessage: string;
  systemPrompt: string;
  shape: FeaturePlan['shape'];
  generatorConfig: TenantConfig['generatorConfig'];
  tier: TenantConfig['tier'];
  providerOpts: {
    provider: TenantConfig['generatorConfig']['provider'];
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    azureOpenAIApiKey?: string;
    azureOpenAIBaseUrl?: string;
    azureOpenAIApiVersion?: string;
    modelCatalogs?: TenantConfig['generatorConfig']['modelCatalogs'];
    piiMaskingEnabled?: boolean;
  };
}): Promise<{ features: RawFeature[]; usage: { input: number; output: number } }> {
  // Use high reasoning only for broad/epic shapes where multi-workflow decomposition
  // benefits from extended thinking. Simpler shapes use medium to reduce latency.
  const reasoningEffort = (input.shape === 'broad' || input.shape === 'epic') ? 'high' : 'medium';
  const firstAttempt = await callLlmJsonWithUsage<{ features: RawFeature[] }>({
    model: getTierModel(input.generatorConfig.decompositionModel, input.tier),
    systemPrompt: input.systemPrompt,
    userMessage: input.userMessage,
    maxTokens: input.generatorConfig.maxTokens,
    reasoningEffort,
    ...input.providerOpts,
  });

  const initialFeatures = firstAttempt.data.features ?? [];
  if (initialFeatures.length > 0) {
    return { features: initialFeatures, usage: firstAttempt.usage };
  }

  const retryAttempt = await callLlmJsonWithUsage<{ features: RawFeature[] }>({
    model: getTierModel(input.generatorConfig.decompositionModel, input.tier),
    systemPrompt: `${input.systemPrompt}\n\nFINAL REMINDER: Return at least 1 feature. Never return an empty features array.`,
    userMessage: `${input.userMessage}\n\nIMPORTANT: The previous result contained zero features. Return at least one well-scoped feature in valid JSON.`,
    maxTokens: input.generatorConfig.maxTokens,
    reasoningEffort,
    ...input.providerOpts,
  });

  const retryFeatures = retryAttempt.data.features ?? [];
  if (!retryFeatures.length) {
    throw new Error('Feature breakdown returned no features. Please tighten the requirement or switch to a faster, more reliable model for feature breakdown.');
  }

  return {
    features: retryFeatures,
    usage: {
      input: firstAttempt.usage.input + retryAttempt.usage.input,
      output: firstAttempt.usage.output + retryAttempt.usage.output,
    },
  };
}

// ─── Parallel AR Generation (one LLM call per feature) ──────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function featureHasCompleteAcceptanceRequirements(feature: Pick<Feature, 'acceptanceRequirements'>): boolean {
  return Array.isArray(feature.acceptanceRequirements)
    && feature.acceptanceRequirements.length > 0
    && !hasIncompleteAcceptanceRequirements(feature.acceptanceRequirements);
}

export function findFeaturesMissingCompleteAcceptanceRequirements(
  features: Array<Pick<Feature, 'acceptanceRequirements'>>,
): number[] {
  return features.reduce<number[]>((indexes, feature, index) => {
    if (!featureHasCompleteAcceptanceRequirements(feature)) indexes.push(index);
    return indexes;
  }, []);
}

function rawFeatureHasCompleteAcceptanceRequirements(feature: RawFeature): boolean {
  const rawArs = getRawAcceptanceArray(feature);
  return rawArs.length > 0
    && !hasIncompleteAcceptanceRequirements(rawArs as Array<{ given?: string; when?: string; then?: string } | string>);
}

async function generateAcceptanceRequirementsForFeature(input: {
  feature: RawFeature;
  systemPrompt: string;
  userMessage: string;
  model: string;
  maxTokens: number;
  providerOpts: {
    provider: TenantConfig['generatorConfig']['provider'];
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    azureOpenAIApiKey?: string;
    azureOpenAIBaseUrl?: string;
    azureOpenAIApiVersion?: string;
    modelCatalogs?: TenantConfig['generatorConfig']['modelCatalogs'];
    piiMaskingEnabled?: boolean;
  };
}): Promise<{ feature: RawFeature; usage: { input: number; output: number } }> {
  let usage = { input: 0, output: 0 };

  for (let attempt = 1; attempt <= AR_GENERATION_ATTEMPTS; attempt++) {
    try {
      const result = await callLlmJsonWithUsage<{ features: RawFeature[] }>({
        model: input.model,
        systemPrompt: input.systemPrompt,
        userMessage: input.userMessage,
        maxTokens: input.maxTokens,
        reasoningEffort: 'low',
        ...input.providerOpts,
      });

      usage = {
        input: usage.input + result.usage.input,
        output: usage.output + result.usage.output,
      };

      const arFeature = result.data.features?.[0];
      const nextFeature = arFeature
        ? {
            ...input.feature,
            acceptance_requirements: arFeature.acceptance_requirements ?? arFeature.acceptanceRequirements ?? [],
          }
        : input.feature;

      if (rawFeatureHasCompleteAcceptanceRequirements(nextFeature)) {
        return { feature: nextFeature, usage };
      }
    } catch (err) {
      if (attempt >= AR_GENERATION_ATTEMPTS) {
        break;
      }
      // Delay only on exceptions (API/network errors) — give the provider time to recover.
      // Incomplete-but-successful responses retry immediately.
      await delay(AR_RETRY_DELAY_MS * attempt);
      continue;
    }
  }

  return { feature: input.feature, usage };
}

async function runParallelArPass(input: {
  features: RawFeature[];
  requirement: string;
  clarifyAnswers?: ClarifyAnswer[];
  attachmentText?: string;
  wiContextText?: string;
  similarStoriesText?: string;
  domainContext: string;
  arPlan: ArPlan;
  generatorConfig: TenantConfig['generatorConfig'];
  tier: TenantConfig['tier'];
  providerOpts: {
    provider: TenantConfig['generatorConfig']['provider'];
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    azureOpenAIApiKey?: string;
    azureOpenAIBaseUrl?: string;
    azureOpenAIApiVersion?: string;
    modelCatalogs?: TenantConfig['generatorConfig']['modelCatalogs'];
    piiMaskingEnabled?: boolean;
  };
  onArProgress?: (completed: number, total: number, completedFeatureIndex?: number) => Promise<void>;
}): Promise<{ features: RawFeature[]; usage: { input: number; output: number } }> {
  const systemPrompt = buildArSystemPrompt({
    domainContext: input.domainContext,
    arPlan: input.arPlan,
  });

  const model = getTierModel(input.generatorConfig.arModel, input.tier);
  const maxTokens = 3072;

  // Build per-feature tasks
  const tasks = input.features.map((feature) => ({
      feature,
      userMessage: buildArPerFeatureUserMessage({
        requirement: input.requirement,
        clarifyAnswers: input.clarifyAnswers?.map(a => ({
          question: a.question,
          answer: a.answer,
        })),
        attachmentText: input.attachmentText,
        wiContextText: input.wiContextText,
        similarStoriesText: input.similarStoriesText,
        feature: {
          summary: feature.summary ?? '',
          description: feature.description ?? '',
        suggested_story_points: feature.suggested_story_points,
        process_code: feature.process_code,
      },
    }),
  }));

  // Run all features in parallel — no artificial concurrency cap
  const allResults = await Promise.allSettled(
    tasks.map(async (task, i) => {
      const result = await generateAcceptanceRequirementsForFeature({
        feature: task.feature,
        systemPrompt,
        userMessage: task.userMessage,
        model,
        maxTokens,
        providerOpts: input.providerOpts,
      });
      if (input.onArProgress) await input.onArProgress(i + 1, tasks.length, i);
      return result;
    }),
  );

  const results: { feature: RawFeature; usage: { input: number; output: number } }[] = allResults.map(
    (settled, i) => settled.status === 'fulfilled'
      ? { feature: settled.value.feature, usage: settled.value.usage }
      : { feature: tasks[i].feature, usage: { input: 0, output: 0 } },
  );

  const totalUsage = results.reduce(
    (acc, r) => ({ input: acc.input + r.usage.input, output: acc.output + r.usage.output }),
    { input: 0, output: 0 },
  );

  return { features: results.map(r => r.feature), usage: totalUsage };
}

async function backfillMissingAcceptanceRequirements(input: {
  features: RawFeature[];
  requirement: string;
  clarifyAnswers?: ClarifyAnswer[];
  attachmentText?: string;
  wiContextText?: string;
  similarStoriesText?: string;
  domainContext: string;
  arPlan: ArPlan;
  generatorConfig: TenantConfig['generatorConfig'];
  tier: TenantConfig['tier'];
  providerOpts: {
    provider: TenantConfig['generatorConfig']['provider'];
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    azureOpenAIApiKey?: string;
    azureOpenAIBaseUrl?: string;
    azureOpenAIApiVersion?: string;
    modelCatalogs?: TenantConfig['generatorConfig']['modelCatalogs'];
    piiMaskingEnabled?: boolean;
  };
}): Promise<{ features: RawFeature[]; usage: { input: number; output: number } }> {
  const missingIndexes = input.features
    .map((feature, index) => ({ feature, index }))
    .filter(({ feature }) => {
      const rawArs = getRawAcceptanceArray(feature);
      return rawArs.length === 0 || hasIncompleteAcceptanceRequirements(rawArs as Array<{ given?: string; when?: string; then?: string } | string>);
    });

  if (!missingIndexes.length) {
    return { features: input.features, usage: { input: 0, output: 0 } };
  }

  const systemPrompt = buildArSystemPrompt({
    domainContext: input.domainContext,
    arPlan: input.arPlan,
  });
  const model = getTierModel(input.generatorConfig.arModel, input.tier);
  const nextFeatures = [...input.features];

  const backfillResults = await Promise.allSettled(
    missingIndexes.map(({ feature, index }) =>
      generateAcceptanceRequirementsForFeature({
        feature,
        systemPrompt,
        userMessage: buildArPerFeatureUserMessage({
          requirement: input.requirement,
          clarifyAnswers: input.clarifyAnswers?.map(a => ({
            question: a.question,
            answer: a.answer,
          })),
          attachmentText: input.attachmentText,
          wiContextText: input.wiContextText,
          similarStoriesText: input.similarStoriesText,
          feature: {
            summary: feature.summary ?? '',
            description: feature.description ?? '',
            suggested_story_points: feature.suggested_story_points,
            process_code: feature.process_code,
          },
        }),
        model,
        maxTokens: 3072,
        providerOpts: input.providerOpts,
      }).then(result => ({ result, index })),
    ),
  );

  let usage = { input: 0, output: 0 };
  for (const settled of backfillResults) {
    if (settled.status === 'fulfilled') {
      const { result, index } = settled.value;
      usage = { input: usage.input + result.usage.input, output: usage.output + result.usage.output };
      if (rawFeatureHasCompleteAcceptanceRequirements(result.feature)) {
        nextFeatures[index] = result.feature;
      }
    }
  }

  return { features: nextFeatures, usage };
}

// ─── LLM-based Requirement Triage ────────────────────────────────────────────

export interface TriageResult {
  estimatedFeatures: number;
  estimatedQuestions: number;
  shape: FeaturePlan['shape'];
  complexity: FeaturePlan['complexity'];
  arDepth: ArPlan['depth'];
}

export const DEFAULT_GENERATION_TRIAGE_FALLBACK: RequirementAssessment = {
  questionPlan: { min: 0, max: 0, target: 0, clarity: 'medium' },
  featurePlan: { min: 1, max: 1, target: 1, shape: 'minimal', complexity: 'low' },
  arPlan: { min: 0, max: 0, target: 0, depth: 'standard' },
  ambiguityScore: 2,
  ambiguityReasons: ['Triage could not be completed; using operational fallback metadata only.'],
};

const VALID_SHAPES = new Set<FeaturePlan['shape']>(['minimal', 'narrow', 'balanced', 'broad', 'epic']);
const VALID_COMPLEXITIES = new Set<FeaturePlan['complexity']>(['trivial', 'low', 'medium', 'high', 'very_high']);
const VALID_AR_DEPTHS = new Set<ArPlan['depth']>(['minimal', 'lean', 'standard', 'thorough', 'comprehensive']);

function parseTriageResult(raw: unknown): TriageResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const estimatedFeatures = typeof obj.estimatedFeatures === 'number' ? obj.estimatedFeatures : null;
  const shape = typeof obj.shape === 'string' && VALID_SHAPES.has(obj.shape as FeaturePlan['shape'])
    ? obj.shape as FeaturePlan['shape'] : null;
  const complexity = typeof obj.complexity === 'string' && VALID_COMPLEXITIES.has(obj.complexity as FeaturePlan['complexity'])
    ? obj.complexity as FeaturePlan['complexity'] : null;
  const arDepth = typeof obj.arDepth === 'string' && VALID_AR_DEPTHS.has(obj.arDepth as ArPlan['depth'])
    ? obj.arDepth as ArPlan['depth'] : null;
  if (estimatedFeatures == null || !shape || !complexity || !arDepth) return null;
  const estimatedQuestions = typeof obj.estimatedQuestions === 'number'
    ? Math.max(0, Math.round(obj.estimatedQuestions))
    : 0;
  return {
    estimatedFeatures: Math.max(1, Math.round(estimatedFeatures)),
    estimatedQuestions,
    shape,
    complexity,
    arDepth,
  };
}

export function triageToAssessment(triage: TriageResult): { featurePlan: FeaturePlan; arPlan: ArPlan; questionPlan: ClarifyQuestionPlan } {
  const est = Math.max(1, triage.estimatedFeatures);
  const isHighComplexity = triage.complexity === 'high' || triage.complexity === 'very_high';
  const upwardBuffer = isHighComplexity
    ? Math.max(4, Math.ceil(est * 0.8))
    : Math.max(2, Math.ceil(est * 0.5));
  const featurePlan: FeaturePlan = {
    min: Math.max(1, est - 1),
    max: est + upwardBuffer,
    target: est,
    shape: triage.shape,
    complexity: triage.complexity,
  };

  const arPlan: ArPlan = {
    min: 0,
    max: 0,
    target: 0,
    depth: triage.arDepth,
  };

  const q = Math.max(0, triage.estimatedQuestions);
  const isHighQ = triage.complexity === 'high' || triage.complexity === 'very_high';
  const qMin = Math.max(0, q - 2);
  const qMax = isHighQ ? Math.min(q + 8, 20) : Math.min(q + 4, 16);
  const questionPlan: ClarifyQuestionPlan = {
    min: qMin,
    max: qMax,
    target: q,
    clarity: q >= 10 ? 'vague' : q >= 7 ? 'medium' : 'clear',
  };

  return { featurePlan, arPlan, questionPlan };
}

export function triageToSizingContract(triage: TriageResult): EffectiveSizingContract {
  return {
    shape: triage.shape,
    complexity: triage.complexity,
    featureTarget: Math.max(1, triage.estimatedFeatures),
    arDepth: triage.arDepth,
    estimatedQuestions: Math.max(0, triage.estimatedQuestions),
  };
}

export async function assessRequirementWithLlm(input: {
  requirement: string;
  clarifyAnswers?: ClarifyAnswer[];
  generatorConfig: TenantConfig['generatorConfig'];
  tier: TenantConfig['tier'];
  providerOpts: {
    provider: TenantConfig['generatorConfig']['provider'];
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    azureOpenAIApiKey?: string;
    azureOpenAIBaseUrl?: string;
    azureOpenAIApiVersion?: string;
    modelCatalogs?: TenantConfig['generatorConfig']['modelCatalogs'];
    piiMaskingEnabled?: boolean;
  };
}): Promise<TriageResult | null> {
  const result = await assessRequirementWithLlmWithUsage(input);
  return result.triage;
}

export async function assessRequirementWithLlmWithUsage(input: {
  requirement: string;
  clarifyAnswers?: ClarifyAnswer[];
  generatorConfig: TenantConfig['generatorConfig'];
  tier: TenantConfig['tier'];
  providerOpts: {
    provider: TenantConfig['generatorConfig']['provider'];
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    azureOpenAIApiKey?: string;
    azureOpenAIBaseUrl?: string;
    azureOpenAIApiVersion?: string;
    modelCatalogs?: TenantConfig['generatorConfig']['modelCatalogs'];
    piiMaskingEnabled?: boolean;
  };
}): Promise<{ triage: TriageResult | null; usage: { input: number; output: number } | null }> {
  try {
    const userMessage = input.clarifyAnswers?.length
      ? `REQUIREMENT:\n${input.requirement}\n\nCLARIFYING Q&A:\n${input.clarifyAnswers.map(a => `Q: ${a.question}\nA: ${a.answer}`).join('\n')}`
      : `REQUIREMENT:\n${input.requirement}`;

    const result = await callLlmJsonWithUsage<Record<string, unknown>>({
      model: getTierModel(input.generatorConfig.triageModel, input.tier),
      systemPrompt: buildTriageSystemPrompt(),
      userMessage,
      reasoningEffort: 'medium',
      ...input.providerOpts,
    });
    return {
      triage: parseTriageResult(result.data),
      usage: result.usage,
    };
  } catch {
    return {
      triage: null,
      usage: null,
    };
  }
}

const TRIAGE_SHAPE_ORDER: FeaturePlan['shape'][] = ['minimal', 'narrow', 'balanced', 'broad', 'epic'];
const TRIAGE_COMPLEXITY_ORDER: FeaturePlan['complexity'][] = ['trivial', 'low', 'medium', 'high', 'very_high'];
const SIZING_AR_DEPTH_ORDER: SizingAssessmentArDepth[] = ['minimal', 'lean', 'standard', 'thorough', 'comprehensive'];
const MANUAL_PATH_TERMS = ['manual', 'manually', 'agent-assisted', 'user-entered', 'user initiated'];
const AUTOMATED_PATH_TERMS = ['automated', 'automatically', 'automatic', 'system generated', 'system-generated', 'scheduled', 'batch', 'integration', 'api', 'event-driven'];
const SEPARATE_EXCEPTION_WORKFLOW_TERMS = ['approval workflow', 'approval path', 'exception workflow', 'exception path', 'manual review', 'exception request', 'exemption request'];

function tokensForSimilarity(text: string): Set<string> {
  const tokens = String(text ?? '')
    .toLowerCase()
    .match(/\b[a-z][a-z0-9/-]{2,}\b/g) ?? [];

  return new Set(
    tokens.filter((token) => !SIZING_STOPWORDS.has(token)),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  left.forEach((token) => {
    if (right.has(token)) overlap += 1;
  });
  return overlap / (left.size + right.size - overlap);
}

function countDistinctRoleMentions(text: string): number {
  const roleMatches = (String(text ?? '').match(
    /\b(admin|administrator|manager|planner|dispatcher|technician|fse|field service engineer|customer|analyst|qa|developer|operator|supervisor|coordinator|lead|director|reviewer|approver|scheduler|engineer)\b/gi,
  ) ?? []);

  return new Set(
    roleMatches.map((role) => role.toLowerCase()).filter((role) => !GENERIC_ROLE_WORDS.has(role)),
  ).size;
}

function countCapabilityAreas(requirement: string): number {
  const matches = String(requirement ?? '').match(
    /\b(view|raise|track|manage|update|create|edit|approve|reject|route|assign|dispatch|schedule|monitor|report|notify|sync|export|import)\b/gi,
  ) ?? [];
  return new Set(matches.map((match) => match.toLowerCase())).size;
}

function combinedSizingText(requirement: string, clarifyAnswers?: ClarifyAnswer[]): string {
  return [
    String(requirement ?? '').trim(),
    ...(clarifyAnswers ?? []).map((answer) => String(answer.answer ?? '').trim()),
  ]
    .filter(Boolean)
    .join(' ');
}

function textMentionsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
}

function deriveExplicitSplitEvidence(input: {
  requirement: string;
  clarifyAnswers?: ClarifyAnswer[];
}): ExplicitSplitEvidence[] {
  const combined = combinedSizingText(input.requirement, input.clarifyAnswers);
  const evidence: ExplicitSplitEvidence[] = [];

  if (textMentionsAny(combined, MANUAL_PATH_TERMS) && textMentionsAny(combined, AUTOMATED_PATH_TERMS)) {
    evidence.push({
      code: 'manual_vs_automated_workflows',
      detail: 'The requirement explicitly distinguishes manual and automated handling paths.',
      minimumFeatureCount: 2,
    });
  }

  if (
    /\b(override|exception|exempt|approval)\b/i.test(combined)
    && textMentionsAny(combined, SEPARATE_EXCEPTION_WORKFLOW_TERMS)
  ) {
    evidence.push({
      code: 'separate_exception_or_approval_workflow',
      detail: 'The requirement explicitly calls out a separate approval or exception workflow.',
      minimumFeatureCount: 2,
    });
  }

  return evidence;
}

function deriveMinimumPreservedFeatureCount(evidence: ExplicitSplitEvidence[]): number {
  return evidence.reduce((max, item) => Math.max(max, item.minimumFeatureCount), 1);
}

function expectedAverageArLimit(depth: SizingAssessmentArDepth): number {
  switch (depth) {
    case 'minimal': return 2;
    case 'lean': return 3;
    case 'standard': return 4;
    case 'thorough': return 5;
    case 'comprehensive': return 6;
    default: return 4;
  }
}

function cappedByOrder<T extends string>(value: T, cap: T, order: readonly T[]): T {
  return order.indexOf(value) <= order.indexOf(cap) ? value : cap;
}

function featureNarrative(feature: Pick<Feature, 'summary' | 'description' | 'acceptanceRequirements'>): string {
  return [
    feature.summary,
    feature.description,
    ...(feature.acceptanceRequirements ?? []).flatMap((ar) => [ar.given, ar.when, ar.then]),
  ].join(' ');
}

function countNearDuplicateFeaturePairs(features: Feature[]): number {
  let duplicates = 0;
  for (let i = 0; i < features.length; i += 1) {
    for (let j = i + 1; j < features.length; j += 1) {
      const titleSimilarity = jaccard(
        tokensForSimilarity(features[i]?.summary ?? ''),
        tokensForSimilarity(features[j]?.summary ?? ''),
      );
      const narrativeSimilarity = jaccard(
        tokensForSimilarity(featureNarrative(features[i])),
        tokensForSimilarity(featureNarrative(features[j])),
      );
      if (titleSimilarity >= 0.58 || narrativeSimilarity >= 0.72) {
        duplicates += 1;
      }
    }
  }
  return duplicates;
}

function countFeaturesMatchingTerms(features: Feature[], terms: string[]): number {
  const pattern = new RegExp(`\\b(${terms.join('|')})\\b`, 'i');
  return features.filter((feature) => pattern.test(`${feature.summary} ${feature.description}`)).length;
}

function requirementMentionsAny(requirement: string, terms: string[]): boolean {
  const pattern = new RegExp(`\\b(${terms.join('|')})\\b`, 'i');
  return pattern.test(requirement);
}

function determinePreferredFeatureRange(input: {
  archetype: SizingAssessmentArchetype;
  requirement: string;
  clarifyAnswers?: ClarifyAnswer[];
  triage?: TriageResult | null;
  minimumPreservedFeatureCount: number;
}): { min: number; max: number } {
  const combined = combinedSizingText(input.requirement, input.clarifyAnswers);
  const roleCount = countDistinctRoleMentions(combined);
  const hasExplicitExceptionFlow = /\b(override|exception|exempt|approval|reason|grace period|manual review)\b/i.test(combined);
  const capabilityAreas = countCapabilityAreas(input.requirement);

  switch (input.archetype) {
    case 'guard_rule': {
      const min = input.minimumPreservedFeatureCount;
      const max = min > 1
        ? min
        : Math.max(min, hasExplicitExceptionFlow ? 2 : 1);
      return { min, max };
    }
    case 'focused_capability': {
      const min = input.minimumPreservedFeatureCount;
      const max = Math.max(min, Math.min(3, Math.max(2, min + (roleCount >= 2 ? 1 : 0))));
      return { min, max };
    }
    case 'workflow_area': {
      const highComplexity = input.triage?.complexity === 'high' || input.triage?.complexity === 'very_high';
      const baseRange = highComplexity ? { min: 3, max: 6 } : { min: 2, max: 4 };
      return {
        min: Math.max(baseRange.min, input.minimumPreservedFeatureCount),
        max: Math.max(baseRange.max, input.minimumPreservedFeatureCount),
      };
    }
    case 'broad_platform':
    default: {
      const min = Math.max(Math.max(4, capabilityAreas || 4), input.minimumPreservedFeatureCount);
      return { min, max: Math.max(min + 2, Math.min(9, min + 4)) };
    }
  }
}

function determinePreferredArDepth(input: {
  archetype: SizingAssessmentArchetype;
  requirement: string;
  clarifyAnswers?: ClarifyAnswer[];
  triage?: TriageResult | null;
}): SizingAssessmentArDepth {
  const combined = combinedSizingText(input.requirement, input.clarifyAnswers);
  const hasExplicitExceptions = /\b(override|exception|exempt|approval|reason|grace period|manual review)\b/i.test(combined);

  switch (input.archetype) {
    case 'guard_rule':
      return hasExplicitExceptions ? 'standard' : 'lean';
    case 'focused_capability':
      return input.triage?.complexity === 'high' ? 'standard' : 'lean';
    case 'workflow_area':
      return input.triage?.complexity === 'high' || input.triage?.complexity === 'very_high'
        ? 'thorough'
        : 'standard';
    case 'broad_platform':
    default:
      return input.triage?.complexity === 'very_high' ? 'comprehensive' : 'thorough';
  }
}

export function deriveSizingGuidance(input: {
  requirement: string;
  clarifyAnswers?: ClarifyAnswer[];
  triage?: TriageResult | null;
}): SizingGuidance {
  const archetype = classifyRequirementArchetype({
    requirement: input.requirement,
    clarifyAnswers: input.clarifyAnswers,
  });
  const explicitSplitEvidence = deriveExplicitSplitEvidence(input);
  const minimumPreservedFeatureCount = deriveMinimumPreservedFeatureCount(explicitSplitEvidence);
  const preferredFeatureRange = determinePreferredFeatureRange({
    archetype,
    requirement: input.requirement,
    clarifyAnswers: input.clarifyAnswers,
    triage: input.triage,
    minimumPreservedFeatureCount,
  });
  const preferredArDepth = determinePreferredArDepth({
    archetype,
    requirement: input.requirement,
    clarifyAnswers: input.clarifyAnswers,
    triage: input.triage,
  });

  return {
    archetype,
    preferredFeatureRange,
    preferredArDepth,
    minimumPreservedFeatureCount,
    explicitSplitSignals: explicitSplitEvidence.map((item) => item.code),
    explicitSplitEvidence,
  };
}

export function classifyRequirementArchetype(input: {
  requirement: string;
  clarifyAnswers?: ClarifyAnswer[];
}): SizingAssessmentArchetype {
  const requirement = String(input.requirement ?? '').trim();
  const combined = combinedSizingText(requirement, input.clarifyAnswers);
  const wordCount = requirement ? requirement.split(/\s+/).length : 0;
  const sentenceCount = requirement
    ? requirement.split(/[.!?]\s+/).map((part) => part.trim()).filter(Boolean).length
    : 0;
  const roleCount = countDistinctRoleMentions(combined);
  const capabilityAreaCount = countCapabilityAreas(requirement);
  const hasGuardLanguage = /\b(prevent|ensure no|must ensure no|must not|cannot|can't|should not|block|disallow|only allow|no .+ can be created)\b/i
    .test(requirement);
  const hasWorkflowAreaLanguage = /\b(one place|workflow|manage incoming|incoming communications|channels|triage|onboarding|portal|end[- ]to[- ]end|create or update)\b/i
    .test(requirement);
  const commaSeparatedClauses = (requirement.match(/,\s/g) ?? []).length;

  if (capabilityAreaCount >= 4 || (capabilityAreaCount >= 3 && commaSeparatedClauses >= 2)) {
    return 'broad_platform';
  }

  if (hasGuardLanguage && wordCount <= 45 && sentenceCount <= 2 && roleCount <= 2) {
    return 'guard_rule';
  }

  if (hasWorkflowAreaLanguage && !hasGuardLanguage) {
    return 'workflow_area';
  }

  return 'focused_capability';
}
function buildSizingReason(code: string, detail: string): SizingAssessmentReason {
  return { code, detail };
}

function computeSizingHeuristics(input: {
  stage: SizingStage;
  requirement: string;
  features: Feature[];
  clarifyAnswers?: ClarifyAnswer[];
  triage?: TriageResult | null;
}): SizingAssessmentComputation {
  const guidance = deriveSizingGuidance({
    requirement: input.requirement,
    clarifyAnswers: input.clarifyAnswers,
    triage: input.triage,
  });
  const {
    archetype,
    preferredFeatureRange,
    preferredArDepth,
    minimumPreservedFeatureCount,
    explicitSplitSignals,
  } = guidance;

  const featureCount = input.features.length;
  const acceptanceRequirementCount = input.features.reduce((sum, feature) => sum + (feature.acceptanceRequirements?.length ?? 0), 0);
  const averageAcceptanceRequirementsPerFeature = featureCount > 0 ? acceptanceRequirementCount / featureCount : 0;
  const averageArLimit = expectedAverageArLimit(preferredArDepth);
  const reasonItems: SizingAssessmentReason[] = [];
  let oversizeScore = 0;
  let undersizeScore = 0;

  if (minimumPreservedFeatureCount > 1) {
    reasonItems.push(buildSizingReason(
      'explicit_workflow_split_evidence',
      `The requirement explicitly supports keeping at least ${minimumPreservedFeatureCount} independently meaningful workflow feature${minimumPreservedFeatureCount === 1 ? '' : 's'}.`,
    ));
  }

  if (featureCount > preferredFeatureRange.max) {
    oversizeScore += 2;
    reasonItems.push(buildSizingReason(
      'feature_count_above_preferred_range',
      `Generated ${featureCount} features where this ask archetype usually fits within ${preferredFeatureRange.min}-${preferredFeatureRange.max}.`,
    ));
  }

  if (featureCount >= preferredFeatureRange.max + 2) {
    oversizeScore += 1;
    reasonItems.push(buildSizingReason(
      'feature_count_far_above_preferred_range',
      'The feature count is materially above the preferred range for this kind of ask.',
    ));
  }

  if (featureCount < preferredFeatureRange.min && preferredFeatureRange.min > 1) {
    undersizeScore += 2;
    reasonItems.push(buildSizingReason(
      'feature_count_below_preferred_range',
      `Generated ${featureCount} features where this ask archetype usually needs at least ${preferredFeatureRange.min}.`,
    ));
  }

  if (featureCount < minimumPreservedFeatureCount) {
    undersizeScore += 2;
    reasonItems.push(buildSizingReason(
      'below_explicitly_supported_workflow_floor',
      `Generated ${featureCount} features even though the requirement explicitly supports at least ${minimumPreservedFeatureCount} separate workflow feature${minimumPreservedFeatureCount === 1 ? '' : 's'}.`,
    ));
  }

  if (input.stage === 'final' && averageAcceptanceRequirementsPerFeature > averageArLimit + 0.75) {
    oversizeScore += averageAcceptanceRequirementsPerFeature >= averageArLimit + 1.5 ? 2 : 1;
    reasonItems.push(buildSizingReason(
      'average_acceptance_requirements_high',
      `The average of ${averageAcceptanceRequirementsPerFeature.toFixed(1)} ARs per feature is high for a ${preferredArDepth} depth target.`,
    ));
  }

  if (input.stage === 'final' && acceptanceRequirementCount > (Math.max(featureCount, preferredFeatureRange.max) * averageArLimit) + 2) {
    oversizeScore += 1;
    reasonItems.push(buildSizingReason(
      'acceptance_requirements_excessive',
      `The total of ${acceptanceRequirementCount} acceptance requirements is high relative to the feature count and preferred depth.`,
    ));
  }

  const duplicatePairs = countNearDuplicateFeaturePairs(input.features);
  if (duplicatePairs > 0) {
    oversizeScore += duplicatePairs >= 2 ? 2 : 1;
    reasonItems.push(buildSizingReason(
      'duplicate_guard_features',
      `${duplicatePairs} pair${duplicatePairs === 1 ? '' : 's'} of features appear to cover nearly the same business behavior.`,
    ));
  }

  const overrideSplitCount = countFeaturesMatchingTerms(input.features, OVERRIDE_TERMS);
  if (archetype === 'guard_rule' && overrideSplitCount >= 1 && featureCount >= 2) {
    oversizeScore += 1;
    reasonItems.push(buildSizingReason(
      'override_split_without_independent_scope',
      'Override or exception handling appears to have been split into sibling features instead of staying inside the parent guard rule.',
    ));
  }

  const supportSplitCount = countFeaturesMatchingTerms(input.features, SUPPORTING_BEHAVIOR_TERMS);
  if (archetype !== 'broad_platform' && supportSplitCount >= 2 && !requirementMentionsAny(input.requirement, SUPPORTING_BEHAVIOR_TERMS)) {
    oversizeScore += 1;
    reasonItems.push(buildSizingReason(
      'supporting_behavior_split_out',
      'Support behavior like visibility, audit, reporting, or reason capture appears to have become standalone features without being asked for explicitly.',
    ));
  }

  let verdict: SizingAssessmentVerdict;
  let confidence: SizingAssessmentConfidence;

  if (oversizeScore >= 5) {
    verdict = 'oversized';
    confidence = 'high';
  } else if (oversizeScore >= 2) {
    verdict = 'oversized';
    confidence = 'medium';
  } else if (undersizeScore >= 2) {
    verdict = 'undersized';
    confidence = 'medium';
  } else if (featureCount >= preferredFeatureRange.min
    && featureCount <= preferredFeatureRange.max
    && (input.stage === 'decomposition' || averageAcceptanceRequirementsPerFeature <= averageArLimit + 0.75)) {
    verdict = 'ok';
    confidence = 'high';
    reasonItems.push(buildSizingReason(
      'counts_within_expected_range',
      'The feature count and acceptance depth fit the expected range for this kind of ask.',
    ));
  } else {
    verdict = 'uncertain';
    confidence = 'low';
  }

  return {
    oversizeScore,
    assessment: {
      stage: input.stage,
      archetype,
      verdict,
      confidence,
      preferredFeatureRange,
      preferredArDepth,
      minimumPreservedFeatureCount,
      explicitSplitSignals,
      featureCount,
      acceptanceRequirementCount,
      averageAcceptanceRequirementsPerFeature,
      reasonCodes: reasonItems.map((reason) => reason.code),
      reasons: reasonItems,
    },
  };
}

export function assessSizingHeuristics(input: {
  stage: SizingStage;
  requirement: string;
  features: Feature[];
  clarifyAnswers?: ClarifyAnswer[];
  triage?: TriageResult | null;
}): SizingAssessmentSnapshot {
  return computeSizingHeuristics(input).assessment;
}

export function applySmallAskTriageGuardrails(input: {
  requirement: string;
  clarifyAnswers?: ClarifyAnswer[];
  triage: TriageResult | null;
}): TriageResult | null {
  if (!input.triage) return null;

  const guidance = deriveSizingGuidance({
    requirement: input.requirement,
    clarifyAnswers: input.clarifyAnswers,
    triage: input.triage,
  });

  if (guidance.archetype !== 'guard_rule') {
    return input.triage;
  }

  const cappedFeatureMax = Math.max(guidance.minimumPreservedFeatureCount, guidance.preferredFeatureRange.max);
  const shapeCap: FeaturePlan['shape'] = cappedFeatureMax <= 1 ? 'minimal' : 'narrow';

  return {
    estimatedFeatures: Math.min(input.triage.estimatedFeatures, cappedFeatureMax),
    estimatedQuestions: Math.min(input.triage.estimatedQuestions, 6),
    shape: cappedByOrder(input.triage.shape, shapeCap, TRIAGE_SHAPE_ORDER),
    complexity: cappedByOrder(input.triage.complexity, 'medium', TRIAGE_COMPLEXITY_ORDER),
    arDepth: cappedByOrder(input.triage.arDepth, 'standard', SIZING_AR_DEPTH_ORDER) as ArPlan['depth'],
  };
}

export function capDiscoveryProfileFloorForSmallAsk(input: {
  requirement: string;
  clarifyAnswers?: ClarifyAnswer[];
  triage: TriageResult | null;
}): TriageResult | null {
  if (!input.triage) return null;

  const guidance = deriveSizingGuidance({
    requirement: input.requirement,
    clarifyAnswers: input.clarifyAnswers,
    triage: input.triage,
  });

  if (guidance.archetype !== 'guard_rule') {
    return input.triage;
  }

  const cappedFeatureMax = Math.max(guidance.minimumPreservedFeatureCount, guidance.preferredFeatureRange.max);
  const shapeCap: FeaturePlan['shape'] = cappedFeatureMax <= 1 ? 'minimal' : 'narrow';

  return {
    ...input.triage,
    estimatedFeatures: Math.min(input.triage.estimatedFeatures, cappedFeatureMax),
    shape: cappedByOrder(input.triage.shape, shapeCap, TRIAGE_SHAPE_ORDER),
  };
}

function shouldAutoRepairOversizedAssessment(assessment: SizingAssessmentSnapshot): boolean {
  return assessment.verdict === 'oversized'
    && assessment.confidence === 'high'
    && assessment.featureCount >= Math.max(assessment.preferredFeatureRange.max + 3, assessment.minimumPreservedFeatureCount + 2);
}

function buildGenerationSizingAssessment(input: {
  decomposition: SizingAssessmentSnapshot;
  final: SizingAssessmentSnapshot;
  repairApplied: boolean;
  repairRejectedReason?: string;
  preRepairFeatureCount?: number;
  preRepairAcceptanceRequirementCount?: number;
}): GenerationSizingAssessment {
  return {
    archetype: input.final.archetype,
    verdict: input.final.verdict,
    confidence: input.final.confidence,
    preferredFeatureRange: input.final.preferredFeatureRange,
    preferredArDepth: input.final.preferredArDepth,
    minimumPreservedFeatureCount: input.final.minimumPreservedFeatureCount,
    explicitSplitSignals: input.final.explicitSplitSignals,
    reasonCodes: input.final.reasonCodes,
    reasons: input.final.reasons,
    repairApplied: input.repairApplied,
    repairRejectedReason: input.repairRejectedReason,
    preRepairFeatureCount: input.preRepairFeatureCount,
    preRepairAcceptanceRequirementCount: input.preRepairAcceptanceRequirementCount,
    decomposition: input.decomposition,
    final: input.final,
  };
}

export function shouldPauseForDraftReview(input: {
  draftFeatureCount: number;
  triageFeatureTarget?: number;
  sizingAssessment: SizingAssessmentSnapshot;
}): boolean {
  const triageTarget = Math.max(1, Math.round(input.triageFeatureTarget ?? 0));
  const exceedsForecast = triageTarget > 0 && input.draftFeatureCount > Math.ceil(triageTarget * 1.5);
  const assessmentSignalsInflation =
    input.sizingAssessment.verdict === 'oversized'
    && (input.sizingAssessment.confidence === 'high' || input.sizingAssessment.confidence === 'medium')
    && input.sizingAssessment.featureCount > input.sizingAssessment.preferredFeatureRange.max;

  return exceedsForecast || assessmentSignalsInflation;
}

function toRawFeature(feature: Feature): RawFeature {
  return {
    summary: feature.summary,
    description: feature.description,
    acceptance_requirements: feature.acceptanceRequirements.map((ar) => `GIVEN ${ar.given} WHEN ${ar.when} THEN ${ar.then}`),
    suggested_story_points: feature.storyPoints,
    process_code: feature.processCode,
  };
}

function repairedOutputViolatesExplicitSplitEvidence(features: Feature[], evidence: ExplicitSplitEvidence[]): string | null {
  for (const item of evidence) {
    if (features.length < item.minimumFeatureCount) {
      return 'below_explicit_workflow_floor';
    }

    if (item.code === 'manual_vs_automated_workflows') {
      const featureTexts = features.map((feature) => featureNarrative(feature));
      const manualIndexes = featureTexts
        .map((text, index) => (textMentionsAny(text, MANUAL_PATH_TERMS) ? index : -1))
        .filter((index) => index >= 0);
      const automatedIndexes = featureTexts
        .map((text, index) => (textMentionsAny(text, AUTOMATED_PATH_TERMS) ? index : -1))
        .filter((index) => index >= 0);

      const preservesSplit = manualIndexes.some((manualIndex) => automatedIndexes.some((autoIndex) => autoIndex !== manualIndex));
      if (!preservesSplit) {
        return 'merged_explicit_manual_and_automated_paths';
      }
    }

    if (item.code === 'separate_exception_or_approval_workflow') {
      const hasSeparateExceptionFeature = features.some((feature) =>
        /\b(override|exception|exempt|approval|manual review)\b/i.test(featureNarrative(feature)),
      );
      if (!hasSeparateExceptionFeature) {
        return 'merged_explicit_exception_or_approval_path';
      }
    }
  }

  return null;
}

async function repairOversizedFeatureSet(opts: {
  requirement: string;
  clarifyAnswers: ClarifyAnswer[];
  attachmentText: string;
  similarStoriesText: string;
  wiContextText: string;
  features: Feature[];
  sizingAssessment: SizingAssessmentSnapshot;
  config: TenantConfig;
  providerOpts: {
    provider: TenantConfig['generatorConfig']['provider'];
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    azureOpenAIApiKey?: string;
    azureOpenAIBaseUrl?: string;
    azureOpenAIApiVersion?: string;
    modelCatalogs?: TenantConfig['generatorConfig']['modelCatalogs'];
    piiMaskingEnabled?: boolean;
  };
  shouldCancel?: () => Promise<boolean> | boolean;
}): Promise<{ features: Feature[]; usage: { input: number; output: number }; applied: boolean; rejectedReason?: string }> {
  const {
    requirement,
    clarifyAnswers,
    attachmentText,
    similarStoriesText,
    wiContextText,
    features,
    sizingAssessment,
    config,
    providerOpts,
    shouldCancel,
  } = opts;
  const guidance = deriveSizingGuidance({
    requirement,
    clarifyAnswers,
  });

  const userMessage = [
    buildGenerationUserMessage({
      requirement,
      clarifyAnswers,
      attachmentText,
      wiContextText,
      similarStoriesText,
      limits: PASS2_CONTEXT_LIMITS,
    }),
    `SIZING SIGNAL:\nArchetype: ${sizingAssessment.archetype}\nPreferred feature range: ${sizingAssessment.preferredFeatureRange.min}-${sizingAssessment.preferredFeatureRange.max}\nMinimum preserved feature count: ${sizingAssessment.minimumPreservedFeatureCount}\nPreferred AR depth: ${sizingAssessment.preferredArDepth}\nExplicit split evidence:\n${guidance.explicitSplitEvidence.length ? guidance.explicitSplitEvidence.map((item) => `- ${item.detail}`).join('\n') : '- None'}\nReasons:\n${sizingAssessment.reasons.map((reason) => `- ${reason.detail}`).join('\n')}`,
    `CURRENT FEATURES:\n${JSON.stringify(features, null, 2)}`,
  ].join('\n\n---\n\n');

  const result = await callLlmJsonWithUsage<{ features: RawFeature[] }>({
    model: getTierModel(config.generatorConfig.evaluateModel, config.tier),
    systemPrompt: buildSizingRepairSystemPrompt({
      domainContext: config.domainContext,
      processTaxonomy: config.processTaxonomy,
      processTaxonomyEnabled: config.processTaxonomyEnabled,
    }),
    userMessage,
    maxTokens: Math.max(config.generatorConfig.maxTokens ?? 8192, 4096),
    reasoningEffort: 'medium',
    ...providerOpts,
  });

  if (await maybeCancelled(shouldCancel)) throw new GenerationCancelledError();

  const rawFeatures = result.data.features ?? [];
  if (rawFeatures.length === 0) {
    return {
      features,
      usage: { input: result.usage.input, output: result.usage.output },
      applied: false,
      rejectedReason: undefined,
    };
  }

  const backfilled = await backfillMissingAcceptanceRequirements({
    features: rawFeatures,
    requirement,
    clarifyAnswers,
    attachmentText,
    wiContextText,
    similarStoriesText,
    domainContext: config.domainContext,
    arPlan: {
      min: 0,
      max: 0,
      target: 0,
      depth: sizingAssessment.preferredArDepth as ArPlan['depth'],
    },
    generatorConfig: config.generatorConfig,
    tier: config.tier,
    providerOpts,
  });

  if (await maybeCancelled(shouldCancel)) throw new GenerationCancelledError();

  const repairedFeatures = backfilled.features.map((feature) => normaliseFeature(feature, {
    requirement,
    clarifyAnswers,
    domainRoles: config.domainRoles,
  }));
  const originalArCount = features.reduce((sum, feature) => sum + feature.acceptanceRequirements.length, 0);
  const repairedArCount = repairedFeatures.reduce((sum, feature) => sum + feature.acceptanceRequirements.length, 0);
  const improved = repairedFeatures.length < features.length || repairedArCount < originalArCount;
  const rejectedReason = repairedOutputViolatesExplicitSplitEvidence(repairedFeatures, guidance.explicitSplitEvidence);

  return {
    features: improved && !rejectedReason ? repairedFeatures : features,
    usage: {
      input: result.usage.input + backfilled.usage.input,
      output: result.usage.output + backfilled.usage.output,
    },
    applied: improved && !rejectedReason,
    rejectedReason: rejectedReason ?? undefined,
  };
}

async function consolidateDraftFeatureSet(opts: {
  requirement: string;
  clarifyAnswers: ClarifyAnswer[];
  attachmentText: string;
  similarStoriesText: string;
  wiContextText: string;
  features: Feature[];
  sizingAssessment: SizingAssessmentSnapshot;
  config: TenantConfig;
  providerOpts: {
    provider: TenantConfig['generatorConfig']['provider'];
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    azureOpenAIApiKey?: string;
    azureOpenAIBaseUrl?: string;
    azureOpenAIApiVersion?: string;
    modelCatalogs?: TenantConfig['generatorConfig']['modelCatalogs'];
    piiMaskingEnabled?: boolean;
  };
  shouldCancel?: () => Promise<boolean> | boolean;
}): Promise<{ features: Feature[]; usage: { input: number; output: number }; applied: boolean; rejectedReason?: string }> {
  const {
    requirement,
    clarifyAnswers,
    attachmentText,
    similarStoriesText,
    wiContextText,
    features,
    sizingAssessment,
    config,
    providerOpts,
    shouldCancel,
  } = opts;
  const guidance = deriveSizingGuidance({
    requirement,
    clarifyAnswers,
  });

  const userMessage = [
    buildGenerationUserMessage({
      requirement,
      clarifyAnswers,
      attachmentText,
      wiContextText,
      similarStoriesText,
      limits: PASS1_CONTEXT_LIMITS,
    }),
    `SIZING SIGNAL:\nArchetype: ${sizingAssessment.archetype}\nPreferred feature range: ${sizingAssessment.preferredFeatureRange.min}-${sizingAssessment.preferredFeatureRange.max}\nMinimum preserved feature count: ${sizingAssessment.minimumPreservedFeatureCount}\nReasons:\n${sizingAssessment.reasons.map((reason) => `- ${reason.detail}`).join('\n')}`,
    `CURRENT DRAFT FEATURES:\n${JSON.stringify(features.map((feature) => ({
      summary: feature.summary,
      description: feature.description,
      suggested_story_points: feature.storyPoints,
      process_code: feature.processCode,
    })), null, 2)}`,
  ].join('\n\n---\n\n');

  const systemPrompt = [
    buildDecompositionSystemPrompt({
      domainContext: config.domainContext,
      domainRoles: config.domainRoles,
      processTaxonomy: config.processTaxonomy,
      processTaxonomyEnabled: config.processTaxonomyEnabled,
      clarifyAnswerCount: clarifyAnswers.length,
      featurePlan: {
        min: sizingAssessment.preferredFeatureRange.min,
        max: sizingAssessment.preferredFeatureRange.max,
        target: Math.min(sizingAssessment.preferredFeatureRange.max, Math.max(sizingAssessment.preferredFeatureRange.min, features.length)),
        shape: sizingAssessment.featureCount >= 9 ? 'epic' : sizingAssessment.featureCount >= 6 ? 'broad' : sizingAssessment.featureCount >= 4 ? 'balanced' : sizingAssessment.featureCount >= 2 ? 'narrow' : 'minimal',
        complexity: sizingAssessment.stage === 'decomposition' ? 'high' : 'medium',
      },
    }),
    'DRAFT REVIEW INSTRUCTION:',
    '- You are consolidating pass-1 draft features before acceptance requirements are written.',
    '- Return ONLY the revised draft feature set.',
    '- Keep acceptance_requirements empty arrays for every feature.',
    '- Prefer the smallest strong set of features that preserves the intended workflow boundaries.',
    '- Do not silently drop explicit exception, approval, or manual-vs-automated path evidence.',
  ].join('\n\n');

  const result = await callLlmJsonWithUsage<{ features: RawFeature[] }>({
    model: getTierModel(config.generatorConfig.decompositionModel, config.tier),
    systemPrompt,
    userMessage,
    maxTokens: Math.max(config.generatorConfig.maxTokens ?? 8192, 4096),
    reasoningEffort: 'medium',
    ...providerOpts,
  });

  if (await maybeCancelled(shouldCancel)) throw new GenerationCancelledError();

  const repairedFeatures = (result.data.features ?? []).map((feature) => normaliseFeature({
    ...feature,
    acceptance_requirements: [],
  }, {
    requirement,
    clarifyAnswers,
    domainRoles: config.domainRoles,
  })).map((feature) => ({
    ...feature,
    acceptanceRequirements: [],
  }));

  if (!repairedFeatures.length) {
    return { features, usage: result.usage, applied: false };
  }

  const rejectedReason = repairedOutputViolatesExplicitSplitEvidence(repairedFeatures, guidance.explicitSplitEvidence);
  const improved = repairedFeatures.length < features.length;

  return {
    features: improved && !rejectedReason ? repairedFeatures : features,
    usage: result.usage,
    applied: improved && !rejectedReason,
    rejectedReason: rejectedReason ?? undefined,
  };
}

// ─── Heuristic Fallback Assessment ───────────────────────────────────────────

export function assessRequirement(input: {
  requirement: string;
  attachmentText: string;
  wiContextText: string;
  similarStoriesText?: string;
  clarifyAnswers?: ClarifyAnswer[];
}): RequirementAssessment {
  const requirement = input.requirement?.trim() ?? '';
  const attachment = input.attachmentText?.trim() ?? '';
  const wi = input.wiContextText?.trim() ?? '';
  const similar = input.similarStoriesText?.trim() ?? '';
  const answers = input.clarifyAnswers ?? [];

  const reqWords = requirement ? requirement.split(/\s+/).length : 0;
  const reqSentences = requirement
    ? requirement.split(/[.!?]\s+/).map(s => s.trim()).filter(Boolean).length
    : 0;
  const hasRichContext = attachment.length > 250 || wi.length > 250 || similar.length > 250 || answers.length >= 4;
  const hasConstraints = /(must|should|cannot|can't|only|except|unless|sla|kpi|compliance|permission|role|workflow|edge case|error|fallback|validation|audit|security)/i
    .test(requirement);
  const hasAmbiguousTokens = /(something|somehow|etc|and so on|kind of|maybe|improve|optimi[sz]e|optimal|better|faster|enhance|fix this|update this|handle this|do it)/i
    .test(requirement);

  // ── Richer signals for scope detection ──

  // Count enumerated items (bullets, numbered lists)
  const bulletCount = (requirement.match(/^[\s]*[-*•]\s/gm) ?? []).length;
  const numberedCount = (requirement.match(/^[\s]*\d+[.)]\s/gm) ?? []).length;
  const enumeratedItems = bulletCount + numberedCount;

  // Count distinct workflow/action verbs (deduplicated)
  const workflowMatches = (requirement.match(
    /\b(when|after|before|upon|during|if|unless|trigger|initiate|approve|reject|escalate|assign|notify|schedule|route|validate|submit|complete|cancel|archive|review|monitor|dispatch|prioriti[sz]e|allocate|transfer|reassign|override)\b/gi,
  ) ?? []);
  const distinctWorkflows = new Set(workflowMatches.map(w => w.toLowerCase())).size;

  // Detect broad domain concepts that imply multi-feature scope even in short sentences.
  // These are compound capabilities that typically require inputs, processing, outputs, and exceptions.
  const broadDomainConcepts = (requirement.match(
    /\b(schedule|scheduling|dashboard|reporting|notification|approval|integration|sync|assignment|prioriti[sz]ation|optimi[sz]ation|workflow|end[- ]to[- ]end|allocation|routing|escalation|automation|monitoring|analytics|forecast|compliance|audit)\b/gi,
  ) ?? []);
  const distinctBroadConcepts = new Set(broadDomainConcepts.map(c => c.toLowerCase())).size;

  // Detect multiple dimensions mentioned (e.g. "criticality and due dates", "skills and availability")
  const dimensionMatches = (requirement.match(
    /\b(criticality|priority|urgency|due date|deadline|skill|availability|capacity|location|travel|cost|sla|rating|score|weight|rank)\b/gi,
  ) ?? []);
  const distinctDimensions = new Set(dimensionMatches.map(d => d.toLowerCase())).size;

  // Count genuinely distinct roles (exclude generic terms)
  const roleMatches = (requirement.match(
    /\b(admin|administrator|manager|planner|dispatcher|technician|fse|field service engineer|customer|analyst|qa|developer|operator|supervisor|coordinator|lead|director|reviewer|approver|scheduler|engineer)\b/gi,
  ) ?? []);
  const distinctRoles = new Set(
    roleMatches.map(r => r.toLowerCase()).filter(r => !GENERIC_ROLE_WORDS.has(r)),
  ).size;
  const totalRoleMentions = roleMatches.length;

  const exceptionMentions = (requirement.match(/\b(error|fail|exception|edge|invalid|conflict|fallback|retry|permission|duplicate)\b/ig) ?? []).length;

  // ── Continuous shape score (0–10 scale) ──
  const shapeScore =
    (distinctWorkflows >= 8 ? 3 : distinctWorkflows >= 5 ? 2 : distinctWorkflows >= 2 ? 1 : 0) +
    (distinctRoles >= 3 ? 2 : distinctRoles >= 2 ? 1 : 0) +
    (enumeratedItems >= 6 ? 2 : enumeratedItems >= 3 ? 1 : 0) +
    (reqWords >= 200 ? 2 : reqWords >= 80 ? 1 : 0) +
    (reqSentences >= 8 ? 1 : 0) +
    // Broad domain concepts imply multi-feature scope even in short requirements
    (distinctBroadConcepts >= 3 ? 2 : distinctBroadConcepts >= 1 ? 1 : 0) +
    // Multiple decision dimensions imply processing/weighting features
    (distinctDimensions >= 3 ? 2 : distinctDimensions >= 2 ? 1 : 0);

  // ── Continuous complexity score (0–10 scale) ──
  const complexityScore =
    (hasConstraints ? 1 : 0) +
    (exceptionMentions >= 3 ? 2 : exceptionMentions >= 1 ? 1 : 0) +
    (answers.length >= 8 ? 2 : answers.length >= 5 ? 1 : 0) +
    (distinctRoles >= 3 ? 2 : distinctRoles >= 2 ? 1 : 0) +
    (distinctWorkflows >= 5 ? 2 : distinctWorkflows >= 2 ? 1 : 0) +
    (distinctDimensions >= 2 ? 1 : 0) +
    (distinctBroadConcepts >= 2 ? 1 : 0);

  // ── Ambiguity / clarity ──
  const ambiguityPenalty =
    (reqWords <= 25 ? 1 : 0) +
    (reqSentences <= 1 ? 1 : 0) +
    (hasAmbiguousTokens ? 1 : 0) +
    (shapeScore >= 3 ? 1 : 0) +   // broad scope adds ambiguity
    (totalRoleMentions === 0 ? 1 : 0) +
    (exceptionMentions === 0 ? 1 : 0);

  const clarityScore =
    (reqWords >= 45 ? 1 : 0) +
    (reqSentences >= 3 ? 1 : 0) +
    (hasRichContext ? 1 : 0) +
    (hasConstraints ? 1 : 0) -
    (ambiguityPenalty >= 3 ? 1 : 0);

  // ── Question plan (unchanged thresholds) ──
  const questionPlan: ClarifyQuestionPlan =
    clarityScore >= 4
      ? { min: 4, max: 6, target: 5, clarity: 'clear' }
      : clarityScore <= 1
        ? { min: 7, max: 11, target: 9, clarity: 'vague' }
        : { min: 5, max: 8, target: 7, clarity: 'medium' };

  // ── Shape tier (5 buckets) ──
  // Floor: short underspecified requirements with any broad concept should not
  // land in narrow/minimal — they need room for the LLM to decompose.
  const isShortButImplicitlyBroad = reqWords <= 30 && (distinctBroadConcepts >= 1 || distinctDimensions >= 2);
  const effectiveShapeScore = isShortButImplicitlyBroad ? Math.max(shapeScore, 3) : shapeScore;

  const shape: FeaturePlan['shape'] =
    effectiveShapeScore >= 7 ? 'epic'
      : effectiveShapeScore >= 5 ? 'broad'
        : effectiveShapeScore >= 3 ? 'balanced'
          : effectiveShapeScore >= 1 ? 'narrow'
            : 'minimal';

  // ── Complexity tier (5 buckets) ──
  const complexity: FeaturePlan['complexity'] =
    complexityScore >= 7 ? 'very_high'
      : complexityScore >= 5 ? 'high'
        : complexityScore >= 3 ? 'medium'
          : complexityScore >= 1 ? 'low'
            : 'trivial';

  // ── Feature plan matrix ──
  const featurePlanMatrix: Record<FeaturePlan['shape'], Record<string, Omit<FeaturePlan, 'shape' | 'complexity'>>> = {
    minimal: {
      low:    { min: 1, max: 1, target: 1 },
      high:   { min: 1, max: 2, target: 1 },
    },
    narrow: {
      low:    { min: 1, max: 3, target: 2 },
      high:   { min: 2, max: 4, target: 3 },
    },
    balanced: {
      low:    { min: 3, max: 5, target: 4 },
      high:   { min: 4, max: 7, target: 5 },
    },
    broad: {
      low:    { min: 4, max: 7, target: 6 },
      high:   { min: 5, max: 8, target: 7 },
    },
    epic: {
      low:    { min: 6, max: 10, target: 8 },
      high:   { min: 7, max: 10, target: 9 },
    },
  };
  const complexityBand = (complexity === 'high' || complexity === 'very_high') ? 'high' : 'low';
  const planEntry = featurePlanMatrix[shape]?.[complexityBand] ?? featurePlanMatrix.balanced.low;
  const featurePlan: FeaturePlan = { ...planEntry, shape, complexity };

  // ── AR plan ──
  const arPlan: ArPlan =
    complexity === 'very_high'
      ? { min: 5, max: 8, target: 6, depth: 'comprehensive' }
      : complexity === 'high'
        ? { min: 4, max: 6, target: 5, depth: 'thorough' }
        : complexity === 'medium'
          ? { min: 3, max: 5, target: 4, depth: 'standard' }
          : complexity === 'low'
            ? { min: 2, max: 3, target: 2, depth: 'lean' }
            : { min: 1, max: 2, target: 1, depth: 'minimal' };

  // ── Ambiguity reasons ──
  const ambiguityReasons: string[] = [];
  if (reqWords <= 25) ambiguityReasons.push('Requirement is short and likely underspecified.');
  if (reqSentences <= 1) ambiguityReasons.push('Requirement is expressed as a single sentence without decomposition clues.');
  if (!hasRichContext) ambiguityReasons.push('No attachment, work-instruction context, or prior Q&A was available.');
  if (shapeScore >= 3) ambiguityReasons.push('Request implies multiple dimensions (priority, due dates, skills, or dependencies).');
  if (totalRoleMentions === 0) ambiguityReasons.push('Primary role is not explicit.');
  if (exceptionMentions === 0) ambiguityReasons.push('Edge cases and failure handling are not defined.');
  if (!hasConstraints) ambiguityReasons.push('Business constraints are still implicit.');

  return {
    questionPlan,
    featurePlan,
    arPlan,
    ambiguityScore: Math.max(0, ambiguityPenalty - (hasConstraints ? 1 : 0)),
    ambiguityReasons,
  };
}

function parseQuestionCandidates(rawData: unknown): ClarifyQuestion[] {
  let candidates: any[] = [];
  if (Array.isArray(rawData)) {
    candidates = rawData;
  } else if (rawData && typeof rawData === 'object' && Array.isArray((rawData as any).questions)) {
    candidates = (rawData as any).questions;
  } else if (rawData && typeof rawData === 'object' && Array.isArray((rawData as any).features)) {
    candidates = (rawData as any).features;
  }

  return candidates
    .filter(x => typeof x === 'object' && x !== null && typeof (x as any).question === 'string')
    .flatMap((candidate) => expandRawQuestionCandidate({
      categoryKey: (candidate as any).categoryKey,
      category: (candidate as any).category,
      intent: (candidate as any).intent,
      question: trimClarifyCopy(String((candidate as any).question ?? ''), MAX_CLARIFY_QUESTION_CHARS),
      details: trimClarifyCopy(String((candidate as any).details ?? ''), MAX_CLARIFY_DETAILS_CHARS),
      suggestions: Array.isArray((candidate as any).suggestions)
        ? (candidate as any).suggestions
          .map((suggestion: unknown) => trimClarifyCopy(String(suggestion ?? ''), MAX_CLARIFY_SUGGESTION_CHARS))
          .filter(Boolean)
          .slice(0, 4)
        : [],
    }))
    .map((question) => ({
      ...question,
      question: trimClarifyCopy(question.question, MAX_CLARIFY_QUESTION_CHARS),
      details: trimClarifyCopy(question.details ?? '', MAX_CLARIFY_DETAILS_CHARS) || undefined,
      suggestions: question.suggestions
        .map((suggestion) => trimClarifyCopy(suggestion, MAX_CLARIFY_SUGGESTION_CHARS))
        .filter(Boolean)
        .slice(0, 4),
    }))
    .filter((question) => question.question.length > 0);
}

function parseDiscoveryProfileCandidate(rawData: unknown): Partial<DiscoveryProfile> | null {
  if (!rawData || typeof rawData !== 'object') return null;
  const root = rawData as Record<string, unknown>;
  const nested = root.discoveryProfile;
  if (nested && typeof nested === 'object') {
    return nested as Partial<DiscoveryProfile>;
  }

  if (
    typeof root.scope === 'string' ||
    typeof root.complexity === 'string' ||
    typeof root.ambiguity === 'string' ||
    Array.isArray(root.missingCategoryKeys) ||
    Array.isArray(root.missingDimensions)
  ) {
    const rawMissingCategoryKeys = Array.isArray(root.missingCategoryKeys)
      ? root.missingCategoryKeys as ClarifyCategoryKey[]
      : Array.isArray(root.missingDimensions)
        ? root.missingDimensions as ClarifyCategoryKey[]
        : undefined;
    return {
      scope: typeof root.scope === 'string' ? root.scope : undefined,
      complexity: typeof root.complexity === 'string' ? root.complexity : undefined,
      ambiguity: typeof root.ambiguity === 'string' ? root.ambiguity : undefined,
      missingCategoryKeys: rawMissingCategoryKeys,
      recommendedInitialCount: typeof root.recommendedInitialCount === 'number' ? root.recommendedInitialCount : undefined,
      followupCap: typeof root.followupCap === 'number' ? root.followupCap : undefined,
    } as Partial<DiscoveryProfile>;
  }

  return null;
}

function parseStringList(rawData: unknown, key: 'reasonCodes'): string[] {
  if (!rawData || typeof rawData !== 'object') return [];
  const candidate = (rawData as Record<string, unknown>)[key];
  if (!Array.isArray(candidate)) return [];
  return candidate
    .map((value) => String(value ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((value, index, values) => values.findIndex((entry) => entry.toLowerCase() === value.toLowerCase()) === index);
}

function parseCategoryKeyList(rawData: unknown): ClarifyCategoryKey[] {
  if (!rawData || typeof rawData !== 'object') return [];
  const root = rawData as Record<string, unknown>;
  const candidate = Array.isArray(root.missingCategoryKeys)
    ? root.missingCategoryKeys
    : Array.isArray(root.missingDimensions)
      ? root.missingDimensions
      : [];

  const seen = new Set<ClarifyCategoryKey>();
  const keys: ClarifyCategoryKey[] = [];
  candidate.forEach((value) => {
    const normalized = normalizeCategoryKey(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    keys.push(normalized);
  });
  return keys;
}

function ambiguityAssessmentFromDiscoveryProfile(
  profile: DiscoveryProfile,
  generatedQuestions: number,
  questionPlan?: ClarifyQuestionPlan,
): ClarifyAmbiguityAssessment {
  const level: ClarifyAmbiguityAssessment['level'] =
    profile.ambiguity === 'high'
      ? 'vague'
      : profile.ambiguity === 'low'
        ? 'clear'
        : 'medium';

  const score =
    profile.ambiguity === 'high'
      ? 8
      : profile.ambiguity === 'medium'
        ? 5
        : 2;

  return {
    level,
    score,
    reasons: profile.missingCategoryKeys.length
      ? profile.missingCategoryKeys.map((categoryKey) => `${labelForCategoryKey(categoryKey)} still needs clarification.`)
      : ['Discovery is focused on confirming the remaining implementation details.'],
    questionPlan: {
      min: questionPlan?.min ?? generatedQuestions,
      max: questionPlan?.max ?? generatedQuestions,
      target: questionPlan?.target ?? profile.recommendedInitialCount,
    },
    generatedQuestions,
  };
}

function trimClarifyCopy(text: string, maxChars: number): string {
  const compact = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  if (compact.length <= maxChars) return compact;

  const clipped = compact.slice(0, maxChars);
  const lastSpace = clipped.lastIndexOf(' ');
  const safe = lastSpace >= Math.floor(maxChars * 0.6) ? clipped.slice(0, lastSpace) : clipped;
  return `${safe.trimEnd()}...`;
}

// ─── Main Generation ──────────────────────────────────────────────────────────

export async function generateFeatures(opts: {
  requirement: string;
  clarifyAnswers: ClarifyAnswer[];
  attachmentText: string;
  similarStoriesText: string;
  wiContextText: string;
  config: TenantConfig;
  precomputedTriage?: TriageResult | null;
  precomputedDraftFeatures?: Feature[];
  draftReviewDecision?: 'keep' | 'consolidate';
  priorStageDurationsMs?: GenerationStageDurationsMs;
  onTriageComplete?: (assessment: EffectiveSizingContract) => Promise<void>;
  onPass1Complete?: (draftFeatures: Feature[], sizingAssessment: SizingAssessmentSnapshot, triage: EffectiveSizingContract, stageDurationsMs: GenerationStageDurationsMs) => Promise<void>;
  onArProgress?: (completed: number, total: number, completedFeatureIndex?: number) => Promise<void>;
  onSizingAssessment?: (assessment: GenerationSizingAssessment) => Promise<void>;
  shouldCancel?: () => Promise<boolean> | boolean;
}): Promise<GenerationResult> {
  const {
    requirement,
    clarifyAnswers,
    attachmentText,
    similarStoriesText,
    wiContextText,
    config,
    precomputedTriage,
    precomputedDraftFeatures,
    draftReviewDecision,
    priorStageDurationsMs,
    onTriageComplete,
    onPass1Complete,
    onArProgress,
    onSizingAssessment,
    shouldCancel,
  } = opts;
  const { generatorConfig } = config;
  const providerOpts = {
    provider: generatorConfig.provider,
    geminiApiKey: generatorConfig.geminiApiKey,
    geminiBaseUrl: generatorConfig.geminiBaseUrl,
    openaiApiKey: generatorConfig.openaiApiKey,
    openaiBaseUrl: generatorConfig.openaiBaseUrl,
    azureOpenAIApiKey: generatorConfig.azureOpenAIApiKey,
    azureOpenAIBaseUrl: generatorConfig.azureOpenAIBaseUrl,
    azureOpenAIApiVersion: generatorConfig.azureOpenAIApiVersion,
    modelCatalogs: generatorConfig.modelCatalogs,
    piiMaskingEnabled: Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled),
  } as const;

  const stageDurationsMs: GenerationStageDurationsMs = { ...(priorStageDurationsMs ?? {}) };
  const totalStartedAt = Date.now();

  // ── Triage: LLM assessment of scope, complexity, feature count, AR depth ──
  const triageStartedAt = Date.now();
  const triageResult = precomputedTriage !== undefined
    ? precomputedTriage
    : await assessRequirementWithLlm({
        requirement,
        clarifyAnswers,
        generatorConfig,
        tier: config.tier,
        providerOpts,
      });
  stageDurationsMs.triage = (stageDurationsMs.triage ?? 0) + (Date.now() - triageStartedAt);

  const assessment: RequirementAssessment = triageResult
    ? { ...DEFAULT_GENERATION_TRIAGE_FALLBACK, ...triageToAssessment(triageResult) }
    : DEFAULT_GENERATION_TRIAGE_FALLBACK;
  const roleGrounding: RoleGroundingContext = {
    requirement,
    clarifyAnswers,
    domainRoles: config.domainRoles,
  };

  if (onTriageComplete) {
    await onTriageComplete(
      triageResult
        ? triageToSizingContract(triageResult)
        : {
            shape: assessment.featurePlan.shape,
            complexity: assessment.featurePlan.complexity,
            featureTarget: assessment.featurePlan.target,
            arDepth: assessment.arPlan.depth,
            arTarget: assessment.arPlan.target || undefined,
            estimatedQuestions: assessment.questionPlan.target,
          },
    );
  }

  if (await maybeCancelled(shouldCancel)) throw new GenerationCancelledError();

  let pass1ResultUsage = { input: 0, output: 0 };
  let pass1Features: RawFeature[];
  let pass1DraftFeatures: Feature[];
  if (precomputedDraftFeatures?.length) {
    pass1DraftFeatures = precomputedDraftFeatures;
    pass1Features = precomputedDraftFeatures.map(toRawFeature);
  } else {
    const pass1StartedAt = Date.now();
    const pass1UserMessage = buildGenerationUserMessage({
      requirement,
      clarifyAnswers,
      attachmentText,
      wiContextText,
      similarStoriesText,
      limits: (assessment.featurePlan.shape === 'minimal' || assessment.featurePlan.shape === 'narrow')
        ? PASS1_CONTEXT_LIMITS_COMPACT
        : PASS1_CONTEXT_LIMITS,
    });

    // ── Pass 1: Decomposition ──
    const pass1System = buildDecompositionSystemPrompt({
      domainContext: config.domainContext,
      domainRoles: config.domainRoles,
      processTaxonomy: config.processTaxonomy,
      processTaxonomyEnabled: config.processTaxonomyEnabled,
      clarifyAnswerCount: clarifyAnswers.length,
      featurePlan: assessment.featurePlan,
    });

    const pass1Result = await runDecompositionPass({
      userMessage: pass1UserMessage,
      systemPrompt: pass1System,
      shape: assessment.featurePlan.shape,
      generatorConfig,
      tier: config.tier,
      providerOpts,
    });
    pass1ResultUsage = pass1Result.usage;
    stageDurationsMs.decomposition = (stageDurationsMs.decomposition ?? 0) + (Date.now() - pass1StartedAt);
    pass1Features = pass1Result.features;
    pass1DraftFeatures = pass1Features.map((feature) => normaliseFeature(feature, roleGrounding));
  }
  const decompositionSizingAssessment = assessSizingHeuristics({
    stage: 'decomposition',
    requirement,
    features: pass1DraftFeatures,
    clarifyAnswers,
    triage: triageResult,
  });

  // Notify caller so it can emit a progress event before the slow pass 2 LLM call
  const triageSizingContract = triageResult
    ? triageToSizingContract(triageResult)
    : {
        shape: assessment.featurePlan.shape,
        complexity: assessment.featurePlan.complexity,
        featureTarget: assessment.featurePlan.target,
        arDepth: assessment.arPlan.depth,
        arTarget: assessment.arPlan.target || undefined,
        estimatedQuestions: assessment.questionPlan.target,
      };
  if (onPass1Complete) await onPass1Complete(pass1DraftFeatures, decompositionSizingAssessment, triageSizingContract, stageDurationsMs);
  if (await maybeCancelled(shouldCancel)) throw new GenerationCancelledError();
  if (!precomputedDraftFeatures?.length && shouldPauseForDraftReview({
    draftFeatureCount: pass1DraftFeatures.length,
    triageFeatureTarget: triageSizingContract.featureTarget,
    sizingAssessment: decompositionSizingAssessment,
  })) {
    throw new Pass1DraftReviewRequiredError(pass1DraftFeatures, decompositionSizingAssessment, triageSizingContract, stageDurationsMs);
  }

  if (precomputedDraftFeatures?.length && draftReviewDecision === 'consolidate') {
    const repairStartedAt = Date.now();
    const draftRepairResult = await consolidateDraftFeatureSet({
      requirement,
      clarifyAnswers,
      attachmentText,
      wiContextText,
      similarStoriesText,
      features: pass1DraftFeatures,
      sizingAssessment: decompositionSizingAssessment,
      config,
      providerOpts,
      shouldCancel,
    });
    stageDurationsMs.repair = (stageDurationsMs.repair ?? 0) + (Date.now() - repairStartedAt);
    pass1DraftFeatures = draftRepairResult.features;
    pass1Features = draftRepairResult.features.map(toRawFeature);
  }

  // ── Pass 2: Acceptance Requirements ──
  // Use parallel per-feature AR generation for 2+ features (faster);
  // fall back to monolithic single-call for 1 feature (no parallelism benefit).

  let pass2Usage: { input: number; output: number };
  let rawFeatures: RawFeature[];

  if (pass1Features.length >= 2) {
    // Parallel path: one small LLM call per feature
    const arStartedAt = Date.now();
    const parallelResult = await runParallelArPass({
      features: pass1Features,
      requirement,
      clarifyAnswers,
      attachmentText,
      wiContextText,
      similarStoriesText,
      domainContext: config.domainContext,
      arPlan: assessment.arPlan,
      generatorConfig,
      tier: config.tier,
      providerOpts,
      onArProgress,
    });
    if (await maybeCancelled(shouldCancel)) throw new GenerationCancelledError();
    stageDurationsMs.acceptanceRequirements = (stageDurationsMs.acceptanceRequirements ?? 0) + (Date.now() - arStartedAt);
    const backfillStartedAt = Date.now();
    const backfillResult = await backfillMissingAcceptanceRequirements({
      features: parallelResult.features,
      requirement,
      clarifyAnswers,
      attachmentText,
      wiContextText,
      similarStoriesText,
      domainContext: config.domainContext,
      arPlan: assessment.arPlan,
      generatorConfig,
      tier: config.tier,
      providerOpts,
    });
    if (await maybeCancelled(shouldCancel)) throw new GenerationCancelledError();
    stageDurationsMs.backfill = (stageDurationsMs.backfill ?? 0) + (Date.now() - backfillStartedAt);
    rawFeatures = backfillResult.features;
    pass2Usage = {
      input: parallelResult.usage.input + backfillResult.usage.input,
      output: parallelResult.usage.output + backfillResult.usage.output,
    };
  } else {
    // Monolithic path: single LLM call for all features (used for 1-feature results)
    if (onArProgress) await onArProgress(0, pass1Features.length, 0);
    const pass2System = buildArSystemPrompt({
      domainContext: config.domainContext,
      arPlan: assessment.arPlan,
    });

    const pass2ContextMessage = buildGenerationUserMessage({
      requirement,
      clarifyAnswers,
      attachmentText,
      wiContextText,
      similarStoriesText,
      limits: PASS2_CONTEXT_LIMITS,
    });

    const pass2UserMessage = `${pass2ContextMessage}\n\n---\n\nFEATURES FROM PASS 1 (fill in acceptance_requirements for each):\n${JSON.stringify(pass1Features, null, 2)}`;

    const pass2MaxTokens = Math.max(generatorConfig.maxTokens ?? 8192, 4096);

    const arStartedAt = Date.now();
    const pass2Result = await callLlmJsonWithUsage<{ features: RawFeature[] }>({
      model: getTierModel(generatorConfig.arModel, config.tier),
      systemPrompt: pass2System,
      userMessage: pass2UserMessage,
      maxTokens: pass2MaxTokens,
      reasoningEffort: 'medium',
      ...providerOpts,
    });
    if (await maybeCancelled(shouldCancel)) throw new GenerationCancelledError();
    stageDurationsMs.acceptanceRequirements = (stageDurationsMs.acceptanceRequirements ?? 0) + (Date.now() - arStartedAt);

    rawFeatures = pass2Result.data.features?.length
      ? mergeFeatures(pass1Features, pass2Result.data.features)
      : pass1Features;
    const backfillStartedAt = Date.now();
    const backfillResult = await backfillMissingAcceptanceRequirements({
      features: rawFeatures,
      requirement,
      clarifyAnswers,
      attachmentText,
      wiContextText,
      similarStoriesText,
      domainContext: config.domainContext,
      arPlan: assessment.arPlan,
      generatorConfig,
      tier: config.tier,
      providerOpts,
    });
    stageDurationsMs.backfill = (stageDurationsMs.backfill ?? 0) + (Date.now() - backfillStartedAt);
    rawFeatures = backfillResult.features;
    pass2Usage = {
      input: pass2Result.usage.input + backfillResult.usage.input,
      output: pass2Result.usage.output + backfillResult.usage.output,
    };
    if (onArProgress) await onArProgress(pass1Features.length, pass1Features.length, pass1Features.length - 1);
  }

  let features = rawFeatures.map((feature) => normaliseFeature(feature, roleGrounding));
  let finalSizingAssessment = assessSizingHeuristics({
    stage: 'final',
    requirement,
    features,
    clarifyAnswers,
    triage: triageResult,
  });
  let repairApplied = false;
  let repairRejectedReason: string | undefined;
  let repairUsage = { input: 0, output: 0 };
  let preRepairFeatureCount: number | undefined;
  let preRepairAcceptanceRequirementCount: number | undefined;

  const allowAutoRepair = draftReviewDecision !== 'keep';
  if (allowAutoRepair && shouldAutoRepairOversizedAssessment(finalSizingAssessment)) {
    const repairStartedAt = Date.now();
    preRepairFeatureCount = finalSizingAssessment.featureCount;
    preRepairAcceptanceRequirementCount = finalSizingAssessment.acceptanceRequirementCount;
    const repairResult = await repairOversizedFeatureSet({
      requirement,
      clarifyAnswers,
      attachmentText,
      wiContextText,
      similarStoriesText,
      features,
      sizingAssessment: finalSizingAssessment,
      config,
      providerOpts,
      shouldCancel,
    });
    repairUsage = repairResult.usage;
    repairApplied = repairResult.applied;
    repairRejectedReason = repairResult.rejectedReason;
    features = repairResult.features;
    stageDurationsMs.repair = (stageDurationsMs.repair ?? 0) + (Date.now() - repairStartedAt);
    finalSizingAssessment = assessSizingHeuristics({
      stage: 'final',
      requirement,
      features,
      clarifyAnswers,
      triage: triageResult,
    });
  }

  const failedFeatureIndexes = findFeaturesMissingCompleteAcceptanceRequirements(features);
  if (failedFeatureIndexes.length > 0) {
    const failedCount = failedFeatureIndexes.length;
    throw new AcceptanceRequirementsGenerationError(
      `Acceptance requirements could not be completed for ${failedCount} feature${failedCount === 1 ? '' : 's'}. Retry generation to finish the missing acceptance requirements.`,
      features,
      failedFeatureIndexes,
    );
  }
  const violations = validateFeatures(features, config);

  const tokenUsage: TokenUsageSummary = {
    input: pass1ResultUsage.input + pass2Usage.input + repairUsage.input,
    output: pass1ResultUsage.output + pass2Usage.output + repairUsage.output,
    total: pass1ResultUsage.input + pass1ResultUsage.output + pass2Usage.input + pass2Usage.output + repairUsage.input + repairUsage.output,
    byStage: {
      decomposition: toStageUsage(pass1ResultUsage),
      acceptanceRequirements: toStageUsage(pass2Usage),
      ...(repairUsage.input || repairUsage.output
        ? { sizingRepair: toStageUsage(repairUsage) }
        : {}),
    },
  };
  stageDurationsMs.total = (priorStageDurationsMs?.total ?? 0) + (Date.now() - totalStartedAt);

  const sizingAssessment = buildGenerationSizingAssessment({
    decomposition: decompositionSizingAssessment,
    final: finalSizingAssessment,
    repairApplied,
    repairRejectedReason,
    preRepairFeatureCount,
    preRepairAcceptanceRequirementCount,
  });

  if (onSizingAssessment) {
    await onSizingAssessment(sizingAssessment);
  }

  return {
    features,
    violations,
    similarStories: [],   // filled in by the caller after this returns
    sessionId: uuidv4(),
    generationContext: {
      projectKey: '',
      domainRolesUsed: [],
      stageDurationsMs,
    },
    tokenUsage,
  };
}

// ─── Clarifying Questions ─────────────────────────────────────────────────────

export async function generateClarifyingQuestions(opts: {
  requirement: string;
  attachmentText: string;
  wiContextText: string;
  similarStoriesText: string;
  config: TenantConfig;
  onTriageComplete?: (assessment: {
    shape?: EffectiveSizingContract['shape'];
    complexity?: EffectiveSizingContract['complexity'];
    featureTarget?: number;
    arDepth?: EffectiveSizingContract['arDepth'];
    arTarget?: number;
    estimatedQuestions?: number;
    clarity: 'clear' | 'medium' | 'vague';
    questionPlan: { min: number; max: number; target: number };
  }) => Promise<void>;
}): Promise<ClarifyDiscoveryResult> {
  const { requirement, attachmentText, wiContextText, similarStoriesText, config, onTriageComplete } = opts;

  const clarifyTriageResult = await assessRequirementWithLlm({
    requirement,
    generatorConfig: config.generatorConfig,
    tier: config.tier,
    providerOpts: buildLlmProviderOpts(config),
  });
  const questionPlan = clarifyTriageResult
    ? triageToAssessment(clarifyTriageResult).questionPlan
    : undefined;
  const sizingContract = clarifyTriageResult ? triageToSizingContract(clarifyTriageResult) : undefined;
  if (onTriageComplete) {
    await onTriageComplete({
      ...(sizingContract ?? {}),
      clarity: questionPlan?.clarity ?? 'medium',
      questionPlan: {
        min: questionPlan?.min ?? 0,
        max: questionPlan?.max ?? 0,
        target: questionPlan?.target ?? 0,
      },
    });
  }
  const desiredQuestionCount = questionPlan?.target ?? 0;
  const clarifyMaxTokens = Math.max(Math.min(config.generatorConfig.maxTokens, 8192), 6144);
  const domainSignals = extractDiscoverySignals([
    requirement,
    attachmentText.slice(0, 2200),
    wiContextText.slice(0, 6000),
    similarStoriesText.slice(0, 5000),
    ...(config.domainRoles ?? []),
  ]);
  const groundingTerms = collectDiscoveryGroundingTerms([
    requirement,
    attachmentText.slice(0, 2200),
    wiContextText.slice(0, 6000),
    similarStoriesText.slice(0, 5000),
    ...(config.domainRoles ?? []),
  ]);

  const contextParts: string[] = [
    `REQUIREMENT: ${requirement}`,
  ];
  if (questionPlan) {
    contextParts.push(
      `DISCOVERY SIGNAL: the prior assessment estimates ${questionPlan.min}-${questionPlan.max} clarifying questions for this request (midpoint: ${desiredQuestionCount}). Treat that range as guidance only — return however many questions are materially needed to close the ambiguity gaps you identify. More is better than fewer when genuine business ambiguity remains.`,
    );
  }
  if (attachmentText) contextParts.push(`ATTACHMENT: ${attachmentText}`);
  if (wiContextText) contextParts.push(`WORK INSTRUCTIONS EXCERPT: ${wiContextText.slice(0, 12000)}`);
  if (similarStoriesText) contextParts.push(`RELATED DEPLOYED BACKLOG ITEMS:\n${similarStoriesText.slice(0, 6000)}`);
  if (domainSignals.length) {
    contextParts.push(`DOMAIN SIGNALS TO REUSE: ${domainSignals.join(', ')}`);
  }

  const system = buildClarifySystemPrompt({
    domainContext: config.domainContext,
    domainRoles: config.domainRoles,
    domainSignals,
    questionPlan,
  });

  const raw = await callLlmJsonWithUsage<Record<string, unknown>>({
    model: getTierModel(config.generatorConfig.clarifyModel, config.tier),
    systemPrompt: system,
    userMessage: contextParts.join('\n\n'),
    maxTokens: clarifyMaxTokens,
    reasoningEffort: 'medium',
    ...buildLlmProviderOpts(config),
  });

  const parsedQuestions = parseQuestionCandidates(raw.data);
  const normalizedProfileCandidate = normalizeDiscoveryProfile(
    parseDiscoveryProfileCandidate(raw.data),
    parsedQuestions.length || desiredQuestionCount,
    sizingContract ? {
      scope: sizingContract.shape === 'epic'
        ? 'very_broad'
        : sizingContract.shape === 'broad'
          ? 'broad'
          : sizingContract.shape === 'balanced'
            ? 'moderate'
            : 'narrow',
      complexity: sizingContract.complexity === 'trivial' ? 'low' : sizingContract.complexity,
      ambiguity: questionPlan?.clarity === 'vague' ? 'high' : questionPlan?.clarity === 'medium' ? 'medium' : 'low',
      recommendedInitialCount: sizingContract.estimatedQuestions,
      followupCap: 4,
    } : undefined,
  );
  const normalizedProfile = {
    ...normalizedProfileCandidate,
    recommendedInitialCount: parsedQuestions.length || normalizedProfileCandidate.recommendedInitialCount,
  };
  const repairedDiscovery = validateAndRepairInitialDiscovery(parsedQuestions, normalizedProfile, {
    requirement,
    attachmentText,
    wiContextText,
    similarStoriesText,
    domainSignals,
    domainRoles: config.domainRoles,
  });
  if (repairedDiscovery.questions.length > 0 && initialQuestionsLookWeak(repairedDiscovery.questions, groundingTerms)) {
    console.warn('[discovery] rejected generic initial question set', {
      generatedQuestions: repairedDiscovery.questions.length,
      requirementExcerpt: requirement.slice(0, 180),
    });
    throw new ClarifyDiscoveryError(
      'invalid_generic_questions',
      'Discovery produced questions that were too generic to present safely.',
    );
  }

  const zeroQuestionDiscoveryAllowed = allowsZeroQuestionDiscovery(repairedDiscovery.discoveryProfile);
  if ((!repairedDiscovery.questions.length && !zeroQuestionDiscoveryAllowed) || repairedDiscovery.failureReasonCode) {
    const rejectionReasonCode = repairedDiscovery.failureReasonCode
      ?? (repairedDiscovery.questions.length === 0 ? 'invalid_empty_questions' : 'invalid_underpowered_questions');
    console.warn('[discovery] rejected initial discovery result', {
      failureReasonCode: rejectionReasonCode,
      generatedQuestions: repairedDiscovery.questions.length,
      recommendedInitialCount: repairedDiscovery.discoveryProfile.recommendedInitialCount,
      ambiguity: repairedDiscovery.discoveryProfile.ambiguity,
      missingCategoryKeys: repairedDiscovery.discoveryProfile.missingCategoryKeys,
    });
    throw new ClarifyDiscoveryError(
      rejectionReasonCode,
      'Discovery did not produce a valid question set.',
    );
  }
  if (!repairedDiscovery.questions.length && zeroQuestionDiscoveryAllowed) {
    console.info('[discovery] accepted explicit zero-question discovery result', {
      ambiguity: repairedDiscovery.discoveryProfile.ambiguity,
      recommendedInitialCount: repairedDiscovery.discoveryProfile.recommendedInitialCount,
    });
  }
  const filteredQuestions = repairedDiscovery.questions;
  const discoveryProfile: DiscoveryProfile = calibrateDiscoveryProfile(
    {
      ...repairedDiscovery.discoveryProfile,
      recommendedInitialCount: filteredQuestions.length,
    },
    {
      requiredCategoryKeys: repairedDiscovery.discoveryProfile.missingCategoryKeys,
      repairApplied: repairedDiscovery.repairApplied,
      repairedQuestionCount: filteredQuestions.length,
    },
  );
  const totalInputTokens = raw.usage.input;
  const totalOutputTokens = raw.usage.output;
  const totalTokens = totalInputTokens + totalOutputTokens;

  return {
    questions: filteredQuestions,
    sizingContract,
    discoveryProfile,
    tokenUsage: {
      input: totalInputTokens,
      output: totalOutputTokens,
      total: totalTokens,
      byStage: { clarify: { input: totalInputTokens, output: totalOutputTokens, total: totalTokens } },
    },
    ambiguityAssessment: ambiguityAssessmentFromDiscoveryProfile(discoveryProfile, filteredQuestions.length, questionPlan),
  };
}

// ─── Evaluate Q&A Sufficiency ─────────────────────────────────────────────────

export async function evaluateSufficiency(opts: {
  requirement: string;
  answers: ClarifyAnswer[];
  askedQuestions?: Array<string | Pick<ClarifyQuestion, 'categoryKey' | 'intent' | 'question'>>;
  followupCap?: number;
  initialQuestionCount?: number;
  totalQuestionBudget?: number;
  config: TenantConfig;
}): Promise<DiscoverySufficiencyEvaluation> {
  const initialQuestionCount = Math.max(0, Number(opts.initialQuestionCount ?? 0));
  const followupCap = Math.max(0, Math.round(opts.followupCap ?? 0));

  const compactAnswers = opts.answers
    .slice(0, 8)
    .map((answer) => ({
      ...answer,
      question: trimForPrompt(answer.question, 180),
      answer: trimForPrompt(answer.answer, 240),
    }));
  const qaText = compactAnswers
    .map(a => `Q: ${a.question}\nA: ${a.answer}`)
    .join('\n\n');
  const askedQuestionDetails = (opts.askedQuestions ?? opts.answers.map((answer) => ({
    question: answer.question,
    categoryKey: answer.categoryKey,
    intent: answer.intent,
  })))
    .slice(0, 8)
    .map((entry) => {
      if (typeof entry === 'string') {
        return { question: trimForPrompt(entry, 180) };
      }

      return {
        question: trimForPrompt(String(entry?.question ?? ''), 180),
        categoryKey: entry?.categoryKey,
        intent: entry?.intent,
      };
    })
    .filter((entry) => entry.question);
  const domainSignals = extractDiscoverySignals([
    opts.requirement,
    qaText,
    ...askedQuestionDetails.map((entry) => entry.question),
    ...(opts.config.domainRoles ?? []),
  ]);

  const groundingTerms = collectDiscoveryGroundingTerms([
    opts.requirement,
    qaText,
    ...askedQuestionDetails.map((entry) => entry.question),
    ...(opts.config.domainRoles ?? []),
  ]);

  const baseUserMessage = [
    `REQUIREMENT: ${opts.requirement}`,
    askedQuestionDetails.length
      ? `DISCOVERY QUESTIONS ALREADY ASKED:\n${askedQuestionDetails.map((entry, index) => {
          const parts = [
            entry.categoryKey ? labelForCategoryKey(entry.categoryKey) : null,
            entry.intent ? String(entry.intent).trim() : null,
          ].filter(Boolean);
          const prefix = parts.length ? ` [${parts.join(' | ')}]` : '';
          return `${index + 1}.${prefix} ${entry.question}`;
        }).join('\n')}`
      : '',
    `DISCOVERY ANSWERS:\n${qaText}`,
  ].filter(Boolean).join('\n\n');

  const runEvaluationPass = async (
    userMessage: string,
    stageKey: 'clarifyEvaluate' | 'clarifyEvaluateRetry',
  ) => {
    const startedAt = Date.now();
    const result = await callLlmJsonWithUsage<Record<string, unknown>>({
      model: getTierModel(opts.config.generatorConfig.evaluateModel, opts.config.tier),
      systemPrompt: buildEvaluateSystemPrompt({
        domainContext: opts.config.domainContext,
        domainRoles: opts.config.domainRoles,
        domainSignals,
        minQuestions: 0,
        maxQuestions: followupCap,
      }),
      userMessage,
      maxTokens: 900,
      reasoningEffort: 'low',
      ...buildLlmProviderOpts(opts.config),
    });
    const durationMs = Date.now() - startedAt;

    const sufficient = Boolean((result.data as Record<string, unknown>).sufficient);
    const parsedQuestions = parseQuestionCandidates(result.data);
    const missingCategoryKeys = (() => {
      const explicit = parseCategoryKeyList(result.data);
      if (explicit.length) return explicit;

      const inferred = parsedQuestions
        .map((question) => question.categoryKey)
        .filter((value, index, values) => values.indexOf(value) === index);
      return inferred;
    })();
    const reasonCodes = parseStringList(result.data, 'reasonCodes')
      .map((code) => code.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase())
      .filter(Boolean);

    const questions = !sufficient
      ? finalizeFollowupDiscoveryQuestions(parsedQuestions, {
          askedQuestions: askedQuestionDetails.map((entry) => entry.question),
          askedCategoryKeys: askedQuestionDetails
            .map((entry) => entry.categoryKey)
            .filter((k): k is ClarifyCategoryKey => Boolean(k)),
          missingCategoryKeys,
          followupCap: followupCap || parsedQuestions.length,
          initialQuestionCount,
          fallbackInput: {
            requirement: opts.requirement,
            attachmentText: qaText,
            domainSignals,
            domainRoles: opts.config.domainRoles,
          },
        })
      : [];

    return {
      sufficient,
      questions,
      missingCategoryKeys,
      reasonCodes,
      durationMs,
      usage: result.usage,
      stageKey,
    };
  };

  const evaluationPasses = [await runEvaluationPass(baseUserMessage, 'clarifyEvaluate')];
  const firstPass = evaluationPasses[0];
  const shouldRetryFollowup = !firstPass.sufficient
    && followupCap > 0
    && firstPass.durationMs < 9000
    && followupQuestionsLookWeak(firstPass.questions, groundingTerms);

  if (shouldRetryFollowup) {
    const retryMessage = [
      baseUserMessage,
      'FOLLOW-UP RETRY INSTRUCTION: Your previous follow-up set was too generic, too weakly grounded, or empty.',
      'Retry only if you can ask requirement-specific DELTA questions that clearly depend on the actual requirement and answered Q&A.',
      'Do not ask broad context or business-outcome questions unless the requirement itself is explicitly asking for that.',
      'If there is no clearly grounded follow-up question left, return {"sufficient": true, "missingCategoryKeys": [], "reasonCodes": []}.',
    ].join('\n\n');
    evaluationPasses.push(await runEvaluationPass(retryMessage, 'clarifyEvaluateRetry'));
  }

  const finalPass = evaluationPasses[evaluationPasses.length - 1];
  const finalQuestions = !finalPass.sufficient && !followupQuestionsLookWeak(finalPass.questions, groundingTerms)
    ? finalPass.questions
    : [];
  const effectiveSufficient = finalPass.sufficient || finalQuestions.length === 0;
  const totalDurationMs = evaluationPasses.reduce((sum, pass) => sum + pass.durationMs, 0);
  const totalInputTokens = evaluationPasses.reduce((sum, pass) => sum + pass.usage.input, 0);
  const totalOutputTokens = evaluationPasses.reduce((sum, pass) => sum + pass.usage.output, 0);
  const byStage = Object.fromEntries(
    evaluationPasses.map((pass) => [
      pass.stageKey,
      {
        input: pass.usage.input,
        output: pass.usage.output,
        total: pass.usage.input + pass.usage.output,
      },
    ]),
  );

  return {
    sufficient: effectiveSufficient,
    questions: effectiveSufficient ? undefined : finalQuestions,
    missingCategoryKeys: effectiveSufficient ? [] : finalPass.missingCategoryKeys,
    reasonCodes: effectiveSufficient ? [] : finalPass.reasonCodes,
    durationMs: totalDurationMs,
    tokenUsage: {
      input: totalInputTokens,
      output: totalOutputTokens,
      total: totalInputTokens + totalOutputTokens,
      byStage,
    },
  };
}

// ─── Refinement ───────────────────────────────────────────────────────────────

const STRUCTURAL_REFINEMENT_PATTERNS = [
  /\bmerge\b/i,
  /\bconsolidat(?:e|ion)\b/i,
  /\bcombine\b/i,
  /\bdeduplicat(?:e|ion)\b/i,
  /\boverlap(?:ping)?\b/i,
  /\bsplit\b/i,
  /\bbreak\b[\s\S]{0,40}\binto\b/i,
  /\breorgani[sz]e\b/i,
  /\brestructur(?:e|ing)\b/i,
  /\bregroup\b/i,
  /\breorder\b/i,
  /\bremove\b[\s\S]{0,40}\bfeature\b/i,
  /\bdelete\b[\s\S]{0,40}\bfeature\b/i,
  /\bdrop\b[\s\S]{0,40}\bfeature\b/i,
  /\badd\b[\s\S]{0,40}\bfeature\b/i,
  /\bnew feature\b/i,
  /\bcreate\b[\s\S]{0,40}\bfeature\b/i,
  /\bmove\b[\s\S]{0,40}\bacceptance requirement/i,
  /\bmove\b[\s\S]{0,40}\bar\b/i,
  /\bfeature set\b/i,
];

export function feedbackRequestsStructuralRefinement(feedback: string): boolean {
  const normalized = String(feedback ?? '').trim();
  if (!normalized) return false;
  return STRUCTURAL_REFINEMENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export async function refineFeatures(opts: {
  requirement: string;
  features: Feature[];
  feedback: string;
  config: TenantConfig;
  onProgress?: (message: string) => Promise<void> | void;
}): Promise<{ features: Feature[]; tokenUsage: TokenUsageSummary }> {
  const { requirement, features, feedback, config, onProgress } = opts;

  if (!feedbackRequestsStructuralRefinement(feedback)) {
    return refineFeaturesIndividually({
      requirement,
      features,
      feedback,
      config,
      onProgress,
    });
  }

  const system = buildRefineSystemPrompt({
    domainContext: config.domainContext,
    domainRoles: config.domainRoles,
    processTaxonomy: config.processTaxonomy,
    processTaxonomyEnabled: config.processTaxonomyEnabled,
  });

  const userMessage = [
    `REQUIREMENT: ${requirement}`,
    `FEEDBACK: ${feedback}`,
    `CURRENT FEATURES:\n${JSON.stringify(features, null, 2)}`,
  ].join('\n\n');

  const result = await callLlmJsonWithUsage<{ features: RawFeature[] }>({
    model: getTierModel(config.generatorConfig.refineModel, config.tier),
    systemPrompt: system,
    userMessage,
    maxTokens: config.generatorConfig.maxTokens,
    reasoningEffort: 'high',
    ...buildLlmProviderOpts(config),
  });

  const roleGrounding: RoleGroundingContext = {
    requirement,
    domainRoles: config.domainRoles,
  };
  const normalisedFeatures = (result.data.features ?? []).map((feature) => normaliseFeature(feature, roleGrounding));
  // Drop any feature the LLM returned with no acceptance requirements — these are
  // invalid shells left behind when the model incorrectly moves all ARs to split features.
  const validFeatures = normalisedFeatures.filter((f) => f.acceptanceRequirements.length > 0);
  if (validFeatures.length < normalisedFeatures.length) {
    console.warn(
      `refineFeatures: dropped ${normalisedFeatures.length - validFeatures.length} feature(s) with empty acceptance requirements`,
    );
  }

  return {
    features: validFeatures.length > 0 ? validFeatures : normalisedFeatures,
    tokenUsage: {
      input: result.usage.input,
      output: result.usage.output,
      total: result.usage.input + result.usage.output,
      byStage: { refine: toStageUsage(result.usage) },
    },
  };
}

// ─── Single Feature Refinement ────────────────────────────────────────────────

export async function refineSingleFeature(opts: {
  requirement?: string;
  feature: Feature;
  feedback: string;
  config: TenantConfig;
  allowSplit?: boolean;
}): Promise<{ features: Feature[]; tokenUsage: TokenUsageSummary }> {
  const {
    requirement,
    feature,
    feedback,
    config,
    allowSplit = true,
  } = opts;

  const system = buildSingleFeatureRefineSystemPrompt({
    domainContext: config.domainContext,
    processTaxonomy: config.processTaxonomy,
    processTaxonomyEnabled: config.processTaxonomyEnabled,
    allowStructuralChanges: allowSplit,
  });

  const userMessage = [
    requirement ? `ORIGINAL REQUIREMENT:\n${requirement}` : '',
    `FEATURE:\n${JSON.stringify(feature, null, 2)}`,
    `FEEDBACK: ${feedback}`,
  ].filter(Boolean).join('\n\n');

  const result = await callLlmJsonWithUsage<{ features: RawFeature[] }>({
    model: getTierModel(config.generatorConfig.refineModel, config.tier),
    systemPrompt: system,
    userMessage,
    maxTokens: 4096,
    reasoningEffort: 'medium',
    ...buildLlmProviderOpts(config),
  });

  const rawFeatures = result.data.features ?? [];
  const effectiveRawFeatures = allowSplit ? rawFeatures : rawFeatures.slice(0, 1);
  const roleGrounding: RoleGroundingContext = {
    requirement,
    domainRoles: config.domainRoles,
  };

  if (!allowSplit && rawFeatures.length > 1) {
    console.warn(`refineSingleFeature: ignoring ${rawFeatures.length - 1} unexpected split feature(s)`);
  }

  // Build the result feature list. The first returned feature replaces the original
  // (preserving its id). Any additional features (e.g. when the user asks to split)
  // are returned as new features with fresh ids.
  const features: Feature[] = effectiveRawFeatures.map((raw, index) => {
    const candidate = normaliseFeature(raw, roleGrounding);
    if (index === 0) {
      // Preserve the original feature's id and fall back gracefully.
      const stableResult: Feature = {
        ...candidate,
        id: feature.id,
        summary: candidate.summary || feature.summary,
        description: candidate.description || feature.description,
        acceptanceRequirements: candidate.acceptanceRequirements?.length
          && !hasIncompleteAcceptanceRequirements(candidate.acceptanceRequirements)
          ? candidate.acceptanceRequirements
          : feature.acceptanceRequirements,
        storyPoints: candidate.storyPoints ?? feature.storyPoints,
        processCode: candidate.processCode ?? feature.processCode,
      };
      return applyFeatureOutputGuardrails(stableResult, roleGrounding);
    }
    // Additional split features get fresh ids (already assigned by normaliseFeature).
    return applyFeatureOutputGuardrails(candidate, roleGrounding);
  });

  // If the LLM returned nothing, fall back to the original feature unchanged.
  if (features.length === 0) {
    features.push(feature);
  }

  return {
    features,
    tokenUsage: {
      input: result.usage.input,
      output: result.usage.output,
      total: result.usage.input + result.usage.output,
      byStage: { refineSingle: toStageUsage(result.usage) },
    },
  };
}

async function refineFeaturesIndividually(opts: {
  requirement: string;
  features: Feature[];
  feedback: string;
  config: TenantConfig;
  onProgress?: (message: string) => Promise<void> | void;
}): Promise<{ features: Feature[]; tokenUsage: TokenUsageSummary }> {
  const { requirement, features, feedback, config, onProgress } = opts;

  if (!features.length) {
    return {
      features: [],
      tokenUsage: {
        input: 0,
        output: 0,
        total: 0,
        byStage: {},
      },
    };
  }

  const refinedFeatures: Feature[] = [];
  let totalInput = 0;
  let totalOutput = 0;
  const byStage: Record<string, { input: number; output: number; total: number }> = {};

  for (const [index, feature] of features.entries()) {
    await onProgress?.(`Refining feature ${index + 1} of ${features.length}…`);

    const result = await refineSingleFeature({
      requirement,
      feature,
      feedback,
      config,
      allowSplit: false,
    });

    refinedFeatures.push(result.features[0] ?? feature);
    totalInput += result.tokenUsage.input;
    totalOutput += result.tokenUsage.output;
    byStage[`refine_${index + 1}`] = {
      input: result.tokenUsage.input,
      output: result.tokenUsage.output,
      total: result.tokenUsage.total,
    };
  }

  return {
    features: refinedFeatures,
    tokenUsage: {
      input: totalInput,
      output: totalOutput,
      total: totalInput + totalOutput,
      byStage,
    },
  };
}

// ─── Refine Feedback Sufficiency ──────────────────────────────────────────────

export async function checkRefineFeedbackSufficiency(opts: {
  feature: Feature;
  feedback: string;
  config: TenantConfig;
}): Promise<{ sufficient: boolean; question?: string }> {
  const userMessage = `FEATURE SUMMARY: ${opts.feature.summary}\nFEEDBACK: "${opts.feedback}"`;

  const result = await callLlmJson<{ sufficient: boolean; question?: string }>({
    model: getTierModel(opts.config.generatorConfig.evaluateModel, opts.config.tier),
    systemPrompt: buildRefineSufficiencyPrompt(),
    userMessage,
    ...buildLlmProviderOpts(opts.config),
  });

  return result;
}

// ─── Session Title ────────────────────────────────────────────────────────────

export async function generateSessionTitle(requirement: string, config: TenantConfig): Promise<string> {
  const res = await callLlm({
    model: config.generatorConfig.themeModel,
    systemPrompt: 'Generate a very short session title for this software requirement. Prefer 2 to 4 words. Make it specific, scannable, and outcome-focused. Avoid quotes, punctuation-heavy phrasing, and generic labels like feature, task, process, workflow, requirement, or system. Output title only.',
    userMessage: requirement,
    maxTokens: 20,
    reasoningEffort: 'none',
    ...buildLlmProviderOpts(config),
  });
  return formatSessionTitle(res.text, requirement);
}

// ─── Ask / Chat ───────────────────────────────────────────────────────────────

export async function askQuestion(opts: {
  message: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  systemPrompt: string;
  config: TenantConfig;
}): Promise<string> {
  const historyText = opts.history
    .slice(-10)
    .map(h => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`)
    .join('\n');

  const userMessage = historyText
    ? `${historyText}\nUser: ${opts.message}`
    : opts.message;

  const res = await callLlm({
    model: opts.config.generatorConfig.arModel,
    systemPrompt: opts.systemPrompt,
    userMessage,
    maxTokens: 2048,
    reasoningEffort: 'low',
    ...buildLlmProviderOpts(opts.config),
  });

  return res.text;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NEUTRAL_FALLBACK_ROLE = 'authorized user';
const ROLE_BEHAVIOR_VERB_PATTERN = '(?:has|have|is|are|was|were|needs|need|can|cannot|must|should|views|receives|creates|updates|submits|opens|reviews|approves|rejects|selects|starts|attempts|tries|works|manages|uses|belongs)';
const CLAUSE_ROLE_PATTERN = new RegExp(`\\b(a|an|the)\\s+([A-Za-z][A-Za-z\\s/-]{1,60}?)(?=\\s+${ROLE_BEHAVIOR_VERB_PATTERN}\\b)`, 'gi');
const ROLE_LABEL_HINTS = new Set([
  ...GENERIC_ROLE_WORDS,
  'admin',
  'administrator',
  'manager',
  'owner',
  'requester',
  'reviewer',
  'approver',
  'dispatcher',
  'planner',
  'coordinator',
  'lead',
  'director',
  'supervisor',
  'customer',
  'caller',
  'sender',
  'recipient',
  'analyst',
  'developer',
]);

interface RoleGroundingContext {
  requirement?: string;
  clarifyAnswers?: ClarifyAnswer[];
  domainRoles?: string[];
}

function looksLikeRoleLabel(text: string): boolean {
  const tokens = tokenizeRole(text);
  if (!tokens.length) return false;
  return tokens.some((token) => ROLE_LABEL_HINTS.has(token) || token.endsWith('users') || token.endsWith('user'));
}

function uniqueNonEmptyStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(trimmed);
  });
  return result;
}

function collectExplicitActorLabels(input: RoleGroundingContext): string[] {
  const values: string[] = [];
  const sources = [
    String(input.requirement ?? ''),
    ...(input.clarifyAnswers ?? []).map((answer) => String(answer.answer ?? '')),
  ];

  for (const source of sources) {
    if (!source.trim()) continue;

    const storyMatch = source.match(/As an?\s+([^,.\n]{2,80}?)\s*,\s*I need to/i);
    if (storyMatch?.[1] && looksLikeRoleLabel(storyMatch[1])) {
      values.push(storyMatch[1].trim());
    }

    const rolePattern = /\b([A-Za-z][A-Za-z/& -]{1,60}?)\s+(?:must|can|cannot|can't|should|should not|need(?:s)? to|attempts? to|tries to)\b/gi;
    let match: RegExpExecArray | null;
    while ((match = rolePattern.exec(source)) !== null) {
      const candidate = String(match[1] ?? '').trim();
      if (!candidate || !looksLikeRoleLabel(candidate)) continue;
      values.push(candidate);
    }
  }

  return uniqueNonEmptyStrings(values);
}

function buildRoleEvidenceText(input: RoleGroundingContext): string {
  return [
    String(input.requirement ?? ''),
    ...(input.clarifyAnswers ?? []).map((answer) => String(answer.answer ?? '')),
  ].join('\n');
}

function scoreDomainRoleEvidence(role: string, evidenceText: string): number {
  const normalizedEvidence = evidenceText.toLowerCase();
  const normalizedRole = role.trim().toLowerCase();
  if (!normalizedRole) return 0;
  if (normalizedEvidence.includes(normalizedRole)) return 10 + tokenizeRole(role).length;

  const roleTokens = tokenizeRole(role).filter((token) => token.length > 2);
  const distinctiveTokens = roleTokens.filter((token) => !GENERIC_ROLE_WORDS.has(token));
  if (!distinctiveTokens.length) return 0;

  const evidenceTokens = new Set(tokenizeRole(evidenceText));
  const matched = distinctiveTokens.filter((token) => evidenceTokens.has(token)).length;
  if (matched !== distinctiveTokens.length) return 0;

  return 6 + distinctiveTokens.length;
}

function resolveHighConfidenceDomainRole(input: RoleGroundingContext): string | null {
  const roles = uniqueNonEmptyStrings(input.domainRoles ?? []);
  if (!roles.length) return null;

  const evidenceText = buildRoleEvidenceText(input);
  if (!evidenceText.trim()) return null;

  const scored = roles
    .map((role) => ({ role, score: scoreDomainRoleEvidence(role, evidenceText) }))
    .filter((item) => item.score >= 8)
    .sort((left, right) => right.score - left.score);

  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].score === scored[1].score) return null;
  return scored[0].role;
}

function roleMatchesActorLabel(role: string, actorLabel: string): boolean {
  const normalizedRole = role.trim().toLowerCase();
  const normalizedActor = actorLabel.trim().toLowerCase();
  if (!normalizedRole || !normalizedActor) return false;
  if (normalizedRole === normalizedActor) return true;
  return roleOverlapScore(normalizedRole, normalizedActor) >= 0.67;
}

function roleIsEvidenceBacked(role: string, input: RoleGroundingContext, explicitActors: string[]): boolean {
  if (!role.trim()) return false;
  if (role.trim().toLowerCase() === NEUTRAL_FALLBACK_ROLE) return true;
  if (explicitActors.some((actor) => roleMatchesActorLabel(role, actor))) return true;

  const evidenceText = buildRoleEvidenceText(input);
  if (scoreDomainRoleEvidence(role, evidenceText) >= 8) return true;
  return false;
}

function isGenericRoleLabel(role: string): boolean {
  const tokens = tokenizeRole(role);
  if (!tokens.length) return false;
  if (role.trim().toLowerCase() === NEUTRAL_FALLBACK_ROLE) return true;
  return tokens.every((token) => GENERIC_ROLE_WORDS.has(token) || token === 'authorized' || token.endsWith('user') || token.endsWith('users'));
}

function extractRoleCandidatesFromClause(clause: string): string[] {
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = CLAUSE_ROLE_PATTERN.exec(clause)) !== null) {
    const candidate = String(match[2] ?? '').trim();
    if (!candidate || !looksLikeRoleLabel(candidate)) continue;
    matches.push(candidate);
  }
  CLAUSE_ROLE_PATTERN.lastIndex = 0;
  return uniqueNonEmptyStrings(matches);
}

function canonicalizeRoleCandidate(
  role: string,
  input: RoleGroundingContext,
  explicitActors: string[],
): string | null {
  const trimmed = role.trim();
  if (!trimmed || !roleIsEvidenceBacked(trimmed, input, explicitActors)) return null;

  const matchedExplicitActor = explicitActors.find((actor) => roleMatchesActorLabel(trimmed, actor));
  if (matchedExplicitActor) return matchedExplicitActor;

  const matchedDomainRole = uniqueNonEmptyStrings(input.domainRoles ?? []).find((domainRole) => roleMatchesActorLabel(trimmed, domainRole));
  if (matchedDomainRole) return matchedDomainRole;

  if (isGenericRoleLabel(trimmed)) return null;
  return trimmed;
}

function resolveDominantAcceptanceRole(
  acceptanceRequirements: AcceptanceRequirement[],
  input?: RoleGroundingContext,
): string | null {
  if (!input || !acceptanceRequirements.length) return null;

  const explicitActors = collectExplicitActorLabels(input);
  const counts = new Map<string, number>();

  acceptanceRequirements.forEach((ar) => {
    extractRoleCandidatesFromClause(`${ar.given} ${ar.when} ${ar.then}`).forEach((candidate) => {
      const canonical = canonicalizeRoleCandidate(candidate, input, explicitActors);
      if (!canonical) return;
      counts.set(canonical, (counts.get(canonical) ?? 0) + 1);
    });
  });

  const candidates = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  if (candidates.length !== 1) return null;
  return candidates[0][0];
}

function resolveEvidenceBackedRole(
  featureRole: string | null,
  input?: RoleGroundingContext,
  acceptanceRequirements: AcceptanceRequirement[] = [],
): string {
  if (!input) return featureRole?.trim() || NEUTRAL_FALLBACK_ROLE;

  const explicitActors = collectExplicitActorLabels(input);
  if (featureRole && !isGenericRoleLabel(featureRole) && roleIsEvidenceBacked(featureRole, input, explicitActors)) {
    return featureRole.trim();
  }

  if (explicitActors.length) {
    return explicitActors[0];
  }

  const dominantAcceptanceRole = resolveDominantAcceptanceRole(acceptanceRequirements, input);
  if (dominantAcceptanceRole && (!featureRole || isGenericRoleLabel(featureRole))) {
    return dominantAcceptanceRole;
  }

  const domainRole = resolveHighConfidenceDomainRole(input);
  if (domainRole) return domainRole;
  return NEUTRAL_FALLBACK_ROLE;
}

function replaceFeatureRole(description: string, role: string): string {
  const trimmedRole = role.trim();
  if (!trimmedRole) return description;

  // Deduplicate before attempting role replacement to avoid wrapping an already-malformed string.
  const cleaned = deduplicateDescription(description);

  if (/^As an?\s+.+?,\s*I need to\s+/i.test(cleaned)) {
    return cleaned.replace(/^As an?\s+(.+?)(,\s*I need to\s+)/i, `As ${articleForRole(trimmedRole)} ${trimmedRole}$2`);
  }

  return `As ${articleForRole(trimmedRole)} ${trimmedRole}, I need to ${cleaned.trim()} so that the requested outcome is achieved.`;
}

function trimVerboseSegment(value: string, maxWords: number): string {
  let trimmed = sanitizeArClause(value)
    .replace(/\bfor example\b[\s\S]*$/i, '')
    .replace(/\bsuch as\b[\s\S]*$/i, '')
    .replace(/\bincluding\b[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  const sentenceBreak = trimmed.search(/[.;!?]\s/);
  if (sentenceBreak >= 0) {
    trimmed = trimmed.slice(0, sentenceBreak).trim();
  }

  const clauseMarkers = [', so that ', ' so that ', ' which ', ' allowing ', ' in order to ', ', with ', ' while '];
  for (const marker of clauseMarkers) {
    if (trimmed.split(/\s+/).length <= maxWords) break;
    const markerIndex = trimmed.toLowerCase().indexOf(marker);
    if (markerIndex > 0) {
      trimmed = trimmed.slice(0, markerIndex).trim();
    }
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > maxWords) {
    trimmed = words.slice(0, maxWords).join(' ');
  }

  return trimmed.replace(/[,:;.\s]+$/g, '').trim();
}

function deduplicateDescription(description: string): string {
  // Detect descriptions where the LLM concatenated two user-story sentences.
  // Strategy: find the last "As a[n] ..." occurrence and use that as the canonical sentence.
  const asAPattern = /As an?\s+/gi;
  const matches: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = asAPattern.exec(description)) !== null) {
    matches.push(m.index);
  }
  if (matches.length <= 1) return description;
  // Take the substring starting at the last "As a[n]" occurrence.
  const lastStart = matches[matches.length - 1];
  const candidate = description.slice(lastStart).trim();
  // Only use it if it forms a recognisable user story sentence.
  if (/^As an?\s+.+,\s*I need/i.test(candidate)) return candidate;
  // Fallback: try the second-to-last occurrence.
  if (matches.length >= 2) {
    const secondLast = description.slice(matches[matches.length - 2]).trim();
    if (/^As an?\s+.+,\s*I need/i.test(secondLast)) return secondLast;
  }
  return description;
}

function normalizeFeatureDescriptionVerbosity(description: string): string {
  const cleaned = deduplicateDescription(description);
  const match = cleaned.match(/^As an?\s+(.+?),\s*I need to\s+(.+?)\s+so that\s+(.+)$/i);
  if (!match) return sanitizeArClause(cleaned);

  const role = sanitizeArClause(match[1]);
  const action = trimVerboseSegment(match[2], 18);
  const benefit = trimVerboseSegment(match[3], 16);
  if (!role || !action || !benefit) return sanitizeArClause(description);

  return `As ${articleForRole(role)} ${role}, I need to ${action} so that ${benefit}.`;
}

function normalizeAcceptanceRequirementVerbosity(ar: AcceptanceRequirement): AcceptanceRequirement {
  return {
    given: trimVerboseSegment(ar.given, 22),
    when: trimVerboseSegment(ar.when, 22),
    then: trimVerboseSegment(ar.then, 18),
  };
}

export function applyFeatureOutputGuardrails(
  feature: Feature,
  roleGrounding?: { requirement?: string; clarifyAnswers?: ClarifyAnswer[]; domainRoles?: string[] },
): Feature {
  const normalizedAcceptanceRequirements = (feature.acceptanceRequirements || []).map(normalizeAcceptanceRequirementVerbosity);
  const resolvedRole = resolveEvidenceBackedRole(
    extractRoleFromDescription(feature.description),
    roleGrounding,
    normalizedAcceptanceRequirements,
  );
  const description = normalizeFeatureDescriptionVerbosity(replaceFeatureRole(feature.description, resolvedRole));
  return harmonizeFeatureRoleLanguage({
    ...feature,
    description,
    acceptanceRequirements: normalizedAcceptanceRequirements,
  });
}

function normaliseFeature(raw: RawFeature, roleGrounding?: RoleGroundingContext): Feature {
  return applyFeatureOutputGuardrails({
    id: uuidv4(),
    summary: raw.summary ?? 'Untitled feature',
    description: raw.description ?? '',
    acceptanceRequirements: normaliseArs(getRawAcceptanceArray(raw)),
    storyPoints: raw.suggested_story_points,
    processCode: raw.process_code,
  }, roleGrounding);
}

function buildLlmProviderOpts(config: TenantConfig) {
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

/** Read AR arrays whether the model used snake_case or camelCase. */
function getRawAcceptanceArray(raw: RawFeature): unknown[] {
  const snake = raw.acceptance_requirements;
  const camel = raw.acceptanceRequirements;
  if (Array.isArray(snake) && snake.length) return snake;
  if (Array.isArray(camel) && camel.length) return camel;
  if (Array.isArray(snake)) return snake;
  if (Array.isArray(camel)) return camel;
  return [];
}

function normaliseArs(ars: unknown[]): Array<{ given: string; when: string; then: string }> {
  const parsed = ars
    .map(ar => {
      if (typeof ar === 'string') return parseArString(ar);
      if (typeof ar === 'object' && ar !== null) {
        const obj = ar as Record<string, unknown>;
        return {
          given: sanitizeArClause(obj.given ?? obj.Given ?? ''),
          when: sanitizeArClause(obj.when ?? obj.When ?? ''),
          then: sanitizeArClause(obj.then ?? obj.Then ?? ''),
        };
      }
      return null;
    })
    .filter((x): x is { given: string; when: string; then: string } => x !== null && hasAnyArContent(x));

  return repairAcceptanceRequirements(parsed);
}

function sanitizeArClause(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasAnyArContent(ar: { given?: string; when?: string; then?: string }): boolean {
  return Boolean(ar.given?.trim() || ar.when?.trim() || ar.then?.trim());
}

function clausesEqualOrMissing(left: string, right: string): boolean {
  if (!left || !right) return true;
  return left.toLowerCase() === right.toLowerCase();
}

function canMergeArFragments(
  pending: AcceptanceRequirement,
  incoming: AcceptanceRequirement,
): boolean {
  if (hasCompleteArClauses(pending) || !hasAnyArContent(incoming)) return false;

  const fillsMissingClause =
    (!pending.given && !!incoming.given) ||
    (!pending.when && !!incoming.when) ||
    (!pending.then && !!incoming.then);

  if (!fillsMissingClause) return false;

  return clausesEqualOrMissing(pending.given, incoming.given)
    && clausesEqualOrMissing(pending.when, incoming.when)
    && clausesEqualOrMissing(pending.then, incoming.then);
}

function mergeArFragments(
  pending: AcceptanceRequirement,
  incoming: AcceptanceRequirement,
): AcceptanceRequirement {
  return {
    given: pending.given || incoming.given,
    when: pending.when || incoming.when,
    then: pending.then || incoming.then,
  };
}

function hasCompleteArClauses(ar: { given?: string; when?: string; then?: string }): boolean {
  return Boolean(ar.given?.trim() && ar.when?.trim() && ar.then?.trim());
}

export function repairAcceptanceRequirements(
  ars: Array<{ given?: string; when?: string; then?: string }>,
): AcceptanceRequirement[] {
  const repaired: AcceptanceRequirement[] = [];
  let pending: AcceptanceRequirement | null = null;

  for (const rawAr of ars) {
    const fragment: AcceptanceRequirement = {
      given: sanitizeArClause(rawAr.given),
      when: sanitizeArClause(rawAr.when),
      then: sanitizeArClause(rawAr.then),
    };

    if (!hasAnyArContent(fragment)) continue;

    if (!pending) {
      pending = fragment;
      if (hasCompleteArClauses(pending)) {
        repaired.push(pending);
        pending = null;
      }
      continue;
    }

    if (canMergeArFragments(pending, fragment)) {
      pending = mergeArFragments(pending, fragment);
      if (hasCompleteArClauses(pending)) {
        repaired.push(pending);
        pending = null;
      }
      continue;
    }

    repaired.push(pending);
    pending = fragment;
    if (hasCompleteArClauses(pending)) {
      repaired.push(pending);
      pending = null;
    }
  }

  if (pending) repaired.push(pending);

  const complete = repaired.filter(hasCompleteArClauses);
  return complete.length ? complete : repaired.filter(hasAnyArContent);
}

function extractRoleFromDescription(description: string): string | null {
  const match = description.match(/^As an?\s+(.+?),\s*I need to\s+/i);
  return match?.[1]?.trim() || null;
}

function tokenizeRole(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function roleOverlapScore(left: string, right: string): number {
  const leftTokens = new Set(tokenizeRole(left));
  const rightTokens = new Set(tokenizeRole(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function shouldAlignRolePhrase(candidateRole: string, featureRole: string): boolean {
  const candidate = candidateRole.trim();
  const target = featureRole.trim();
  if (!candidate || !target) return false;

  const normalizedCandidate = candidate.toLowerCase();
  const normalizedTarget = target.toLowerCase();
  if (normalizedCandidate === normalizedTarget) return false;
  if (normalizedCandidate.includes(normalizedTarget) || normalizedTarget.includes(normalizedCandidate)) return true;

  const candidateTokens = tokenizeRole(candidate);
  const targetTokens = tokenizeRole(target);
  const overlap = roleOverlapScore(candidate, target);
  const candidateIsGeneric = candidateTokens.every(token => GENERIC_ROLE_WORDS.has(token) || targetTokens.includes(token));

  return overlap >= 0.34 || (candidateIsGeneric && overlap >= 0.2);
}

function articleForRole(role: string): 'a' | 'an' {
  return /^[aeiou]/i.test(role.trim()) ? 'an' : 'a';
}

function alignRoleInClause(clause: string, featureRole: string): string {
  if (!clause || !featureRole) return clause;

  return clause.replace(CLAUSE_ROLE_PATTERN, (match, article, rolePhrase) => {
    if (!shouldAlignRolePhrase(rolePhrase, featureRole)) return match;
    const nextArticle = String(article).toLowerCase() === 'the' ? 'the' : articleForRole(featureRole);
    return `${nextArticle} ${featureRole}`;
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countDistinctClauseRoleCandidates(clause: string): number {
  return extractRoleCandidatesFromClause(clause).length;
}

function canNeutralizeWhenClause(clause: string, featureRole: string): boolean {
  const leadingRolePattern = new RegExp(`^(?:(?:a|an|the)\\s+)?${escapeRegex(featureRole)}\\s+${ROLE_BEHAVIOR_VERB_PATTERN}\\b`, 'i');
  if (!leadingRolePattern.test(clause)) return false;
  return countDistinctClauseRoleCandidates(clause) <= 1;
}

function neutralizeWhenClauseRole(clause: string, featureRole: string): string {
  if (!canNeutralizeWhenClause(clause, featureRole)) return clause;
  const leadingRolePattern = new RegExp(`^(?:(?:a|an|the)\\s+)?${escapeRegex(featureRole)}\\s+`, 'i');
  return clause
    .replace(leadingRolePattern, 'they ')
    .replace(/^they attempts\b/i, 'they attempt')
    .replace(/^they tries\b/i, 'they try')
    .replace(/^they has\b/i, 'they have')
    .replace(/^they is\b/i, 'they are')
    .replace(/^they does\b/i, 'they do');
}

function harmonizeFeatureRoleLanguage(feature: Feature): Feature {
  const featureRole = extractRoleFromDescription(feature.description);
  if (!featureRole) return feature;

  let explicitWhenRoleSeen = false;
  return {
    ...feature,
    acceptanceRequirements: (feature.acceptanceRequirements || []).map((ar) => {
      const given = alignRoleInClause(ar.given, featureRole);
      const whenAligned = alignRoleInClause(ar.when, featureRole);
      const when = explicitWhenRoleSeen ? neutralizeWhenClauseRole(whenAligned, featureRole) : whenAligned;
      if (new RegExp(`^(?:(?:a|an|the)\\s+)?${escapeRegex(featureRole)}\\s+${ROLE_BEHAVIOR_VERB_PATTERN}\\b`, 'i').test(whenAligned)) {
        explicitWhenRoleSeen = true;
      }
      return {
        ...ar,
        given,
        when,
        then: alignRoleInClause(ar.then, featureRole),
      };
    }),
  };
}

/** Parse GIVEN/WHEN/THEN; supports multiline clauses (models often wrap lines). */
function parseArString(s: string): { given: string; when: string; then: string } {
  const t = s.trim();
  const givenMatch = t.match(/GIVEN\s+([\s\S]+?)(?=\s+(?:WHEN|THEN)\b|$)/i);
  const whenMatch = t.match(/WHEN\s+([\s\S]+?)(?=\s+THEN\b|$)/i);
  const thenMatch = t.match(/THEN\s+([\s\S]+)$/i);
  
  let given = sanitizeArClause(givenMatch?.[1] ?? '');
  let when = sanitizeArClause(whenMatch?.[1] ?? '');
  let then = sanitizeArClause(thenMatch?.[1] ?? '');

  // Clean up any keywords repeated INSIDE the captured groups (fixes LLM hallucinations)
  given = sanitizeArClause(given.replace(/^(GIVEN|WHEN|THEN)\s+/i, ''));
  when = sanitizeArClause(when.replace(/^(GIVEN|WHEN|THEN)\s+/i, ''));
  then = sanitizeArClause(then.replace(/^(GIVEN|WHEN|THEN)\s+/i, ''));

  if (given || when || then) {
    return { given, when, then };
  }

  // Fallback for unformatted strings
  return { given: '', when: '', then: sanitizeArClause(t.replace(/^(GIVEN|WHEN|THEN)\s+/i, '')) };
}

/**
 * Merge pass1 and pass2: prefer pass2's ARs, keep pass1's metadata.
 * Matches by array index when summaries align; otherwise matches by summary text.
 */
function mergeFeatures(pass1: RawFeature[], pass2: RawFeature[]): RawFeature[] {
  if (!pass2.length) return pass1;
  return pass1.map((f1, i) => {
    const k = (f1.summary ?? '').trim().toLowerCase();
    const atI = pass2[i];
    const byIndexOk =
      atI && (atI.summary ?? '').trim().toLowerCase() === k ? atI : undefined;
    const byName = k ? pass2.find(f => (f.summary ?? '').trim().toLowerCase() === k) : undefined;
    const f2 =
      byIndexOk ??
      byName ??
      (pass2.length === pass1.length ? atI : undefined);
    if (!f2) return f1;
    const ar2 = getRawAcceptanceArray(f2);
    const ar1 = getRawAcceptanceArray(f1);
    return {
      ...f1,
      acceptance_requirements: ar2.length ? (ar2 as string[]) : (ar1 as string[]),
    };
  });
}

function toStageUsage(usage: { input: number; output: number }) {
  return {
    input: usage.input,
    output: usage.output,
    total: usage.input + usage.output,
  };
}

async function maybeCancelled(shouldCancel?: () => Promise<boolean> | boolean): Promise<boolean> {
  if (!shouldCancel) return false;
  return Boolean(await shouldCancel());
}

function formatSessionTitle(rawTitle: string, fallbackRequirement: string): string {
  const cleaned = String(rawTitle ?? '')
    .replace(/^["']|["']$/g, '')
    .replace(/^[#*\-\d.\s]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*[-–—:;,.]+\s*$/g, '')
    .trim();

  const trimmed = cleaned && cleaned.toLowerCase() !== 'untitled'
    ? cleaned
    : fallbackRequirement
      .replace(/\s+/g, ' ')
      .trim()
      .split(/(?<=[.?!])\s+/)[0]
      .split(/[,:;()[\]{}]/)[0]
      .trim();

  const words = trimmed
    .split(' ')
    .map((word) => word.replace(/^[^\w]+|[^\w]+$/g, ''))
    .filter(Boolean)
    .filter((word) => !['feature', 'task', 'process', 'workflow', 'requirement', 'system', 'solution'].includes(word.toLowerCase()));

  const capped = words.slice(0, 4).join(' ');
  const normalized = capped || 'Untitled session';
  return normalized.length > 48 ? normalized.slice(0, 48).trimEnd() : normalized;
}
