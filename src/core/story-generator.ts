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
  TokenUsageSummary,
  DiscoveryProfile,
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
  buildSingleFeatureRefineSystemPrompt,
  buildRefineSufficiencyPrompt,
} from './prompts';
import { validateFeatures } from './quality-validator';
import { hasIncompleteAcceptanceRequirements } from './ar-validation';
import {
  MAX_FOLLOWUP_DISCOVERY_QUESTIONS,
  MAX_INITIAL_DISCOVERY_QUESTIONS,
  MAX_TOTAL_DISCOVERY_QUESTIONS,
  MIN_FOLLOWUP_DISCOVERY_QUESTIONS,
  MIN_INITIAL_DISCOVERY_QUESTIONS,
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
}

interface DiscoverySufficiencyEvaluation {
  sufficient: boolean;
  questions?: ClarifyQuestion[];
  missingCategoryKeys: ClarifyCategoryKey[];
  reasonCodes: string[];
  tokenUsage: TokenUsageSummary;
  durationMs: number;
}

const AR_GENERATION_ATTEMPTS = 3;
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

const PASS1_CONTEXT_LIMITS = {
  requirement: 5000,
  clarify: 5000,
  // Attachment text is passed as-is — no artificial cap. The predecessor app (jira-story-assistant)
  // used no truncation for attachments and consistently produced better results. Context windows on
  // all supported models (Claude 200K, GPT-4o 128K, Gemini 1M) are large enough that the full
  // attachment poses no risk. Token cost is the tenant's responsibility.
  attachment: Number.MAX_SAFE_INTEGER,
  wi: 8000,
  similar: 5000,
} as const;

const PASS1_CONTEXT_LIMITS_COMPACT = {
  requirement: 4000,
  clarify: 3000,
  attachment: Number.MAX_SAFE_INTEGER,
  wi: 4000,
  similar: 3000,
} as const;

const PASS2_CONTEXT_LIMITS = {
  requirement: 4000,
  clarify: 4000,
  attachment: Number.MAX_SAFE_INTEGER,
  wi: 5000,
  similar: 3000,
} as const;

const MAX_EXECUTABLE_FEATURES = 10;
const MAX_CLARIFY_QUESTION_CHARS = 250;
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

function collectDiscoveryGroundingTerms(parts: string[]): Set<string> {
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

function followupQuestionsLookWeak(
  questions: ClarifyQuestion[],
  groundingTerms: Set<string>,
): boolean {
  if (!questions.length) return true;

  return questions.some((question) => {
    const normalizedQuestion = question.question.trim();
    if (!normalizedQuestion) return true;
    if (GENERIC_FOLLOWUP_PATTERNS.some((pattern) => pattern.test(normalizedQuestion))) return true;

    const hits = countGroundingHits(normalizedQuestion, groundingTerms);
    const questionLooksGeneric = /\b(capability|process|system|workflow|handling|business outcome)\b/i.test(normalizedQuestion);
    return hits === 0 || (questionLooksGeneric && hits < 2);
  });
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
  pushPromptSection(parts, 'WORK INSTRUCTIONS', input.wiContextText, input.limits.wi);
  pushPromptSection(parts, 'SIMILAR STORIES FROM BACKLOG (use these for business context only; never copy actor labels or scope when the requirement already specifies them)', input.similarStoriesText, input.limits.similar);

  return parts.join('\n\n---\n\n');
}

async function runDecompositionPass(input: {
  userMessage: string;
  systemPrompt: string;
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
  const firstAttempt = await callLlmJsonWithUsage<{ features: RawFeature[] }>({
    model: getTierModel(input.generatorConfig.decompositionModel, input.tier),
    systemPrompt: input.systemPrompt,
    userMessage: input.userMessage,
    maxTokens: input.generatorConfig.maxTokens,
    reasoningEffort: 'high',
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
    reasoningEffort: 'high',
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

const PARALLEL_AR_CONCURRENCY = 5;

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
        reasoningEffort: 'medium',
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
      await delay(AR_RETRY_DELAY_MS * attempt);
      continue;
    }

    if (attempt < AR_GENERATION_ATTEMPTS) {
      await delay(AR_RETRY_DELAY_MS * attempt);
    }
  }

  return { feature: input.feature, usage };
}

async function runParallelArPass(input: {
  features: RawFeature[];
  requirement: string;
  clarifyAnswers?: ClarifyAnswer[];
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
      feature: {
        summary: feature.summary ?? '',
        description: feature.description ?? '',
        suggested_story_points: feature.suggested_story_points,
        process_code: feature.process_code,
      },
    }),
  }));

  // Execute in batches of PARALLEL_AR_CONCURRENCY
  const results: { feature: RawFeature; usage: { input: number; output: number } }[] = [];
  let completed = 0;

  for (let i = 0; i < tasks.length; i += PARALLEL_AR_CONCURRENCY) {
    const batch = tasks.slice(i, i + PARALLEL_AR_CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (task) => {
        const result = await generateAcceptanceRequirementsForFeature({
          feature: task.feature,
          systemPrompt,
          userMessage: task.userMessage,
          model,
          maxTokens,
          providerOpts: input.providerOpts,
        });
        return result;
      }),
    );

    for (let j = 0; j < batchResults.length; j++) {
      const settled = batchResults[j];
      if (settled.status === 'fulfilled') {
        results.push({
          feature: settled.value.feature,
          usage: settled.value.usage,
        });
      } else {
        // Failed — keep original feature without ARs
        results.push({
          feature: batch[j].feature,
          usage: { input: 0, output: 0 },
        });
      }
      completed++;
      if (input.onArProgress) await input.onArProgress(completed, tasks.length, i + j);
    }
  }

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
  let usage = { input: 0, output: 0 };

  for (const { feature, index } of missingIndexes) {
    const result = await generateAcceptanceRequirementsForFeature({
      feature,
      systemPrompt,
      userMessage: buildArPerFeatureUserMessage({
        requirement: input.requirement,
        clarifyAnswers: input.clarifyAnswers?.map(a => ({
          question: a.question,
          answer: a.answer,
        })),
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
    });

    usage = {
      input: usage.input + result.usage.input,
      output: usage.output + result.usage.output,
    };

    if (rawFeatureHasCompleteAcceptanceRequirements(result.feature)) {
      nextFeatures[index] = result.feature;
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
  questionPlan: { min: 4, max: 12, target: 10, clarity: 'vague' },
  featurePlan: { min: 1, max: 4, target: 2, shape: 'narrow', complexity: 'medium' },
  arPlan: { min: 1, max: 5, target: 3, depth: 'standard' },
  ambiguityScore: 3,
  ambiguityReasons: ['Triage could not be completed; using conservative defaults.'],
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
    ? Math.min(15, Math.max(4, Math.round(obj.estimatedQuestions)))
    : 10;
  return {
    estimatedFeatures: Math.min(MAX_EXECUTABLE_FEATURES, Math.max(1, Math.round(estimatedFeatures))),
    estimatedQuestions,
    shape,
    complexity,
    arDepth,
  };
}

export function triageToAssessment(triage: TriageResult): { featurePlan: FeaturePlan; arPlan: ArPlan; questionPlan: ClarifyQuestionPlan } {
  // Feature plan: LLM's estimate is the target; ceiling is target+2 to prevent runaway generation.
  // No computed floor — the decomposition prompt instructs the LLM to reach the target.
  const est = Math.min(MAX_EXECUTABLE_FEATURES, triage.estimatedFeatures);
  const featurePlan: FeaturePlan = {
    min: 1,
    max: Math.min(MAX_EXECUTABLE_FEATURES, est + 2),
    target: est,
    shape: triage.shape,
    complexity: triage.complexity,
  };

  // AR plan: LLM's depth drives target; ceiling is target+2.
  const arTargetMap: Record<ArPlan['depth'], number> = {
    minimal:       2,
    lean:          3,
    standard:      4,
    thorough:      5,
    comprehensive: 6,
  };
  const arTarget = arTargetMap[triage.arDepth];
  const arPlan: ArPlan = {
    min: 1,
    max: arTarget + 2,
    target: arTarget,
    depth: triage.arDepth,
  };

  // Question plan: LLM's estimate is the target; ceiling is target+2.
  const q = triage.estimatedQuestions;
  const questionPlan: ClarifyQuestionPlan = {
    min: 4,
    max: Math.min(15, q + 2),
    target: q,
    clarity: q >= 10 ? 'vague' : q >= 7 ? 'medium' : 'clear',
  };

  return { featurePlan, arPlan, questionPlan };
}

export function capAssessmentForExecution(assessment: RequirementAssessment): RequirementAssessment {
  const cappedTarget = Math.min(assessment.featurePlan.target, MAX_EXECUTABLE_FEATURES);
  const cappedMax = Math.min(Math.max(cappedTarget, assessment.featurePlan.max), MAX_EXECUTABLE_FEATURES);
  const cappedMin = Math.min(assessment.featurePlan.min, cappedMax);

  const featurePlan: FeaturePlan = {
    ...assessment.featurePlan,
    min: cappedMin,
    max: cappedMax,
    target: cappedTarget,
  };

  const arPlan: ArPlan = featurePlan.target >= 7
    ? {
        min: Math.min(assessment.arPlan.min, 2),
        max: Math.min(assessment.arPlan.max, 4),
        target: Math.min(assessment.arPlan.target, 3),
        depth: assessment.arPlan.depth === 'comprehensive'
          ? 'thorough'
          : assessment.arPlan.depth === 'thorough'
            ? 'standard'
            : assessment.arPlan.depth,
      }
    : assessment.arPlan;

  return {
    ...assessment,
    featurePlan,
    arPlan,
  };
}

function clampFeatureCount(features: RawFeature[], maxFeatures: number): RawFeature[] {
  if (features.length <= maxFeatures) return features;
  return features.slice(0, maxFeatures);
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
  try {
    const userMessage = input.clarifyAnswers?.length
      ? `REQUIREMENT:\n${input.requirement}\n\nCLARIFYING Q&A:\n${input.clarifyAnswers.map(a => `Q: ${a.question}\nA: ${a.answer}`).join('\n')}`
      : `REQUIREMENT:\n${input.requirement}`;

    const result = await callLlmJsonWithUsage<Record<string, unknown>>({
      model: getTierModel(input.generatorConfig.triageModel, input.tier),
      systemPrompt: buildTriageSystemPrompt(),
      userMessage,
      maxTokens: 1000,
      reasoningEffort: 'medium',
      ...input.providerOpts,
    });
    return parseTriageResult(result.data);
  } catch {
    return null;
  }
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
      min: questionPlan?.min ?? MIN_INITIAL_DISCOVERY_QUESTIONS,
      max: questionPlan?.max ?? MAX_INITIAL_DISCOVERY_QUESTIONS,
      target: profile.recommendedInitialCount,
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
  onTriageComplete?: (assessment: { shape: string; complexity: string; featureTarget: number; arDepth: string; arTarget: number; estimatedQuestions: number }) => Promise<void>;
  onPass1Complete?: (draftFeatures: Feature[]) => Promise<void>;
  onArProgress?: (completed: number, total: number, completedFeatureIndex?: number) => Promise<void>;
  shouldCancel?: () => Promise<boolean> | boolean;
}): Promise<GenerationResult> {
  const { requirement, clarifyAnswers, attachmentText, similarStoriesText, wiContextText, config, precomputedTriage, onTriageComplete, onPass1Complete, onArProgress, shouldCancel } = opts;
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

  // ── Triage: LLM assessment of scope, complexity, feature count, AR depth ──
  const triageResult = precomputedTriage !== undefined
    ? precomputedTriage
    : await assessRequirementWithLlm({
        requirement,
        clarifyAnswers,
        generatorConfig,
        tier: config.tier,
        providerOpts,
      });

  const rawAssessment: RequirementAssessment = triageResult
    ? { ...DEFAULT_GENERATION_TRIAGE_FALLBACK, ...triageToAssessment(triageResult) }
    : DEFAULT_GENERATION_TRIAGE_FALLBACK;
  const assessment = capAssessmentForExecution(rawAssessment);

  if (onTriageComplete) {
    await onTriageComplete({
      shape: assessment.featurePlan.shape,
      complexity: assessment.featurePlan.complexity,
      featureTarget: assessment.featurePlan.target,
      arDepth: assessment.arPlan.depth,
      arTarget: assessment.arPlan.target,
      estimatedQuestions: assessment.questionPlan.target,
    });
  }

  if (await maybeCancelled(shouldCancel)) throw new GenerationCancelledError();

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
    featurePlan: assessment.featurePlan,
  });

  const pass1Result = await runDecompositionPass({
    userMessage: pass1UserMessage,
    systemPrompt: pass1System,
    generatorConfig,
    tier: config.tier,
    providerOpts,
  });

  const pass1Features = clampFeatureCount(pass1Result.features, assessment.featurePlan.max);

  // Notify caller so it can emit a progress event before the slow pass 2 LLM call
  if (onPass1Complete) await onPass1Complete(pass1Features.map(normaliseFeature));
  if (await maybeCancelled(shouldCancel)) throw new GenerationCancelledError();

  // ── Pass 2: Acceptance Requirements ──
  // Use parallel per-feature AR generation for 2+ features (faster);
  // fall back to monolithic single-call for 1 feature (no parallelism benefit).

  let pass2Usage: { input: number; output: number };
  let rawFeatures: RawFeature[];

  if (pass1Features.length >= 2) {
    // Parallel path: one small LLM call per feature
    const parallelResult = await runParallelArPass({
      features: pass1Features,
      requirement,
      clarifyAnswers,
      domainContext: config.domainContext,
      arPlan: assessment.arPlan,
      generatorConfig,
      tier: config.tier,
      providerOpts,
      onArProgress,
    });
    if (await maybeCancelled(shouldCancel)) throw new GenerationCancelledError();
    const backfillResult = await backfillMissingAcceptanceRequirements({
      features: parallelResult.features,
      requirement,
      clarifyAnswers,
      domainContext: config.domainContext,
      arPlan: assessment.arPlan,
      generatorConfig,
      tier: config.tier,
      providerOpts,
    });
    if (await maybeCancelled(shouldCancel)) throw new GenerationCancelledError();
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

    const pass2Result = await callLlmJsonWithUsage<{ features: RawFeature[] }>({
      model: getTierModel(generatorConfig.arModel, config.tier),
      systemPrompt: pass2System,
      userMessage: pass2UserMessage,
      maxTokens: pass2MaxTokens,
      reasoningEffort: 'medium',
      ...providerOpts,
    });
    if (await maybeCancelled(shouldCancel)) throw new GenerationCancelledError();

    rawFeatures = pass2Result.data.features?.length
      ? mergeFeatures(pass1Features, pass2Result.data.features)
      : pass1Features;
    const backfillResult = await backfillMissingAcceptanceRequirements({
      features: rawFeatures,
      requirement,
      clarifyAnswers,
      domainContext: config.domainContext,
      arPlan: assessment.arPlan,
      generatorConfig,
      tier: config.tier,
      providerOpts,
    });
    rawFeatures = backfillResult.features;
    pass2Usage = {
      input: pass2Result.usage.input + backfillResult.usage.input,
      output: pass2Result.usage.output + backfillResult.usage.output,
    };
    if (onArProgress) await onArProgress(pass1Features.length, pass1Features.length, pass1Features.length - 1);
  }

  const features = rawFeatures.map(normaliseFeature);
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
    input: pass1Result.usage.input + pass2Usage.input,
    output: pass1Result.usage.output + pass2Usage.output,
    total: pass1Result.usage.input + pass1Result.usage.output + pass2Usage.input + pass2Usage.output,
    byStage: {
      decomposition: toStageUsage(pass1Result.usage),
      acceptanceRequirements: toStageUsage(pass2Usage),
    },
  };

  return {
    features,
    violations,
    similarStories: [],   // filled in by the caller after this returns
    sessionId: uuidv4(),
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
    shape?: 'minimal' | 'narrow' | 'balanced' | 'broad' | 'epic';
    complexity?: 'trivial' | 'low' | 'medium' | 'high' | 'very_high';
    clarity: 'clear' | 'medium' | 'vague';
    questionPlan: { min: number; max: number; target: number };
  }) => Promise<void>;
}): Promise<ClarifyDiscoveryResult> {
  const { requirement, attachmentText, wiContextText, similarStoriesText, config, onTriageComplete } = opts;

  const CLARIFY_QUESTION_FALLBACK: ClarifyQuestionPlan = { min: 4, max: 12, target: 10, clarity: 'vague' };

  const clarifyTriageResult = await assessRequirementWithLlm({
    requirement,
    generatorConfig: config.generatorConfig,
    tier: config.tier,
    providerOpts: buildLlmProviderOpts(config),
  });
  const questionPlan = clarifyTriageResult
    ? triageToAssessment(clarifyTriageResult).questionPlan
    : CLARIFY_QUESTION_FALLBACK;
  if (onTriageComplete) {
    await onTriageComplete({
      shape: clarifyTriageResult?.shape,
      complexity: clarifyTriageResult?.complexity,
      clarity: questionPlan.clarity,
      questionPlan: {
        min: questionPlan.min,
        max: questionPlan.max,
        target: questionPlan.target,
      },
    });
  }
  const desiredQuestionCount = questionPlan.target;
  const clarifyMaxTokens = Math.max(Math.min(config.generatorConfig.maxTokens, 8192), 6144);
  const domainSignals = extractDiscoverySignals([
    requirement,
    attachmentText.slice(0, 2200),
    wiContextText.slice(0, 6000),
    similarStoriesText.slice(0, 5000),
    ...(config.domainRoles ?? []),
  ]);

  const contextParts: string[] = [
    `REQUIREMENT: ${requirement}`,
    `DISCOVERY RANGE: produce between ${questionPlan.min} and ${questionPlan.max} clarifying questions. Ideal target: ${desiredQuestionCount}. If ambiguity is still material, lean toward the upper half of the range. If the requirement and context are unusually explicit, you may go lower, but do not exceed the maximum.`,
  ];
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
    desiredQuestionCount,
  );
  const normalizedProfile = {
    ...normalizedProfileCandidate,
    recommendedInitialCount: Math.min(
      questionPlan.max,
      Math.max(questionPlan.min, normalizedProfileCandidate.recommendedInitialCount),
    ),
  };
  const repairedDiscovery = validateAndRepairInitialDiscovery(parsedQuestions, normalizedProfile, {
    requirement,
    attachmentText,
    wiContextText,
    similarStoriesText,
    domainSignals,
    domainRoles: config.domainRoles,
  });
  if (!repairedDiscovery.questions.length || repairedDiscovery.failureReasonCode) {
    throw new ClarifyDiscoveryError(
      repairedDiscovery.failureReasonCode ?? 'invalid_underpowered_questions',
      'Discovery did not produce a valid question set.',
    );
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
  const totalQuestionBudget = Math.max(
    initialQuestionCount,
    Math.min(MAX_TOTAL_DISCOVERY_QUESTIONS, Number(opts.totalQuestionBudget ?? MAX_TOTAL_DISCOVERY_QUESTIONS)),
  );
  const remainingBudget = Math.max(0, totalQuestionBudget - initialQuestionCount);
  const followupCap = Math.min(
    remainingBudget,
    Math.max(MIN_FOLLOWUP_DISCOVERY_QUESTIONS, Math.min(MAX_FOLLOWUP_DISCOVERY_QUESTIONS, Math.round(opts.followupCap ?? 4))),
  );
  const followupMin = followupCap > 0 ? Math.min(MIN_FOLLOWUP_DISCOVERY_QUESTIONS, followupCap) : 0;
  const qaText = opts.answers
    .map(a => `Q: ${a.question}\nA: ${a.answer}`)
    .join('\n\n');
  const askedQuestionDetails = (opts.askedQuestions ?? opts.answers.map((answer) => ({
    question: answer.question,
    categoryKey: answer.categoryKey,
    intent: answer.intent,
  })))
    .map((entry) => {
      if (typeof entry === 'string') {
        return { question: entry.trim() };
      }

      return {
        question: String(entry?.question ?? '').trim(),
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
        minQuestions: Math.max(1, followupMin),
        maxQuestions: Math.max(1, followupCap),
      }),
      userMessage,
      maxTokens: 1400,
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

    const questions = !sufficient && followupCap > 0
      ? finalizeFollowupDiscoveryQuestions(parsedQuestions, {
          askedQuestions: askedQuestionDetails.map((entry) => entry.question),
          askedCategoryKeys: askedQuestionDetails
            .map((entry) => entry.categoryKey)
            .filter((k): k is ClarifyCategoryKey => Boolean(k)),
          missingCategoryKeys,
          followupCap,
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

export async function refineFeatures(opts: {
  requirement: string;
  features: Feature[];
  feedback: string;
  config: TenantConfig;
}): Promise<{ features: Feature[]; tokenUsage: TokenUsageSummary }> {
  const { requirement, features, feedback, config } = opts;

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

  const normalisedFeatures = (result.data.features ?? []).map(normaliseFeature);
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
}): Promise<{ features: Feature[]; tokenUsage: TokenUsageSummary }> {
  const { requirement, feature, feedback, config } = opts;

  const system = buildSingleFeatureRefineSystemPrompt({
    domainContext: config.domainContext,
    processTaxonomy: config.processTaxonomy,
    processTaxonomyEnabled: config.processTaxonomyEnabled,
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

  // Build the result feature list. The first returned feature replaces the original
  // (preserving its id). Any additional features (e.g. when the user asks to split)
  // are returned as new features with fresh ids.
  const features: Feature[] = rawFeatures.map((raw, index) => {
    const candidate = normaliseFeature(raw);
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
      return harmonizeFeatureRoleLanguage(stableResult);
    }
    // Additional split features get fresh ids (already assigned by normaliseFeature).
    return harmonizeFeatureRoleLanguage(candidate);
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

function normaliseFeature(raw: RawFeature): Feature {
  return harmonizeFeatureRoleLanguage({
    id: uuidv4(),
    summary: raw.summary ?? 'Untitled feature',
    description: raw.description ?? '',
    acceptanceRequirements: normaliseArs(getRawAcceptanceArray(raw)),
    storyPoints: raw.suggested_story_points,
    processCode: raw.process_code,
  });
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

  return clause.replace(/\b(a|an|the)\s+([A-Za-z][A-Za-z\s/-]{1,60}?)(?=\s+(?:has|have|is|are|was|were|needs|need|can|cannot|must|should|views|receives|creates|updates|submits|opens|reviews|approves|rejects|selects|starts|attempts|works|manages|uses|belongs)\b)/i, (match, article, rolePhrase) => {
    if (!shouldAlignRolePhrase(rolePhrase, featureRole)) return match;
    const nextArticle = String(article).toLowerCase() === 'the' ? 'the' : articleForRole(featureRole);
    return `${nextArticle} ${featureRole}`;
  });
}

function harmonizeFeatureRoleLanguage(feature: Feature): Feature {
  const featureRole = extractRoleFromDescription(feature.description);
  if (!featureRole) return feature;

  return {
    ...feature,
    acceptanceRequirements: (feature.acceptanceRequirements || []).map(ar => ({
      ...ar,
      given: alignRoleInClause(ar.given, featureRole),
      when: alignRoleInClause(ar.when, featureRole),
      then: alignRoleInClause(ar.then, featureRole),
    })),
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
