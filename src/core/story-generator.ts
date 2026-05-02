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
  AdvisoryDiscoveryForecast,
  AdvisoryTriageConfidence,
  AdvisoryTriageContract,
  Feature,
  FeatureActorSource,
  FeatureClass,
  FeatureConfidence,
  ClarifyQuestion,
  ClarifyAnswer,
  ClarifyCategoryKey,
  ClarifyFailureDiagnostics,
  ClarifyFailureReasonCode,
  TenantConfig,
  GenerationResult,
  OpenDecision,
  RoleCoverageItem,
  SimilarStory,
  CoverageFindings,
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
  StructuralFeatureProposal,
  StructuralRestructureProposal,
  RestructureScope,
  CoverageReviewAdvice,
  DraftReviewDecision,
  DraftReviewMetadata,
  DraftFeatureReviewNote,
  DiscoveryCoverageArtifact,
  ValidationViolation,
  WorkInstructionInsightArtifact,
  PipelineProfile,
} from '../types';
import { callLlm, callLlmJson, callLlmJsonWithUsage, LlmJsonParseError } from './llm';
import { getTierModel } from '../services/billing';
import {
  buildDecompositionSystemPrompt,
  buildDraftDescriptionRepairSystemPrompt,
  buildDraftReviewSystemPrompt,
  buildArSystemPrompt,
  buildArPerFeatureUserMessage,
  buildGenerationFinalConstraintBlock,
  buildTriageSystemPrompt,
  buildClarifySystemPrompt,
  buildEvaluateSystemPrompt,
  buildRestructureSystemPrompt,
  buildCoverageCheckSystemPrompt,
  buildAddFeatureSystemPrompt,
  buildAddRequirementsSystemPrompt,
  buildSingleFeatureRefineSystemPrompt,
  buildRefineSufficiencyPrompt,
} from './prompts';
import { detectFeatureOverlaps, validateFeatures } from './quality-validator';
import { hasIncompleteAcceptanceRequirements } from './ar-validation';
import { retrieveScopedWiContext } from '../services/project-selection';
import {
  formatArPatternLibraryFromSimilarStories,
  getGoldStoryPool,
  formatGoldStoryExemplars,
  resolveGoldKeys,
  resolveGoldKeysFromBacklog,
  findGoldConfigForProject,
} from './similar-stories';
import { objectRead, KEYS } from '../services/cache';
import type { DomainPatterns } from './similar-stories';
import {
  allowsZeroQuestionDiscovery,
  buildDiscoveryCoverageArtifact,
  expandRawQuestionCandidate,
  finalizeFollowupDiscoveryQuestions,
  labelForCategoryKey,
  normalizeCategoryKey,
  normalizeDiscoveryProfile,
  validateAndRepairInitialDiscovery,
} from './discovery';
import { formatWorkInstructionInsightsForPrompt } from './wi-insights';
import type { JsonSchema } from './json-schema';

// ─── Types from LLM response ──────────────────────────────────────────────────

interface RawFeature {
  id?: string;
  summary?: string;
  description?: string;
  /** Snake_case (preferred in prompts) */
  acceptance_requirements?: unknown[];
  /** Some models return camelCase — we merge both */
  acceptanceRequirements?: unknown[];
  suggested_story_points?: number;
  process_code?: string;
  feature_class?: unknown;
  featureClass?: unknown;
  confidence?: unknown;
  actor_source?: unknown;
  actorSource?: unknown;
}

interface RawDraftFeature extends RawFeature {
  why_separate?: string;
  whySeparate?: string;
  possible_merge_with?: unknown[];
  possibleMergeWith?: unknown[];
  possible_split_note?: string;
  possibleSplitNote?: string;
}

interface RawDecompositionResponse {
  reasoning_summary?: string;
  reasoningSummary?: string;
  unresolved_ambiguities?: unknown[];
  unresolvedAmbiguities?: unknown[];
  open_decisions?: unknown[];
  openDecisions?: unknown[];
  features?: RawDraftFeature[];
}

interface RawDescriptionRewrite {
  id?: string;
  description?: string;
}

interface RawDescriptionRepairResponse {
  rewrites?: RawDescriptionRewrite[];
}

interface RawCoverageReviewResponse {
  sufficient?: boolean;
  missingCoverage?: unknown[];
  reasoning?: string;
}

interface RawStructuralFeatureProposal extends RawFeature {
  source_feature_ids?: unknown[];
  sourceAcceptanceRequirementRefs?: unknown[];
  source_acceptance_requirement_refs?: unknown[];
  primary_source_feature_id?: string;
  primarySourceFeatureId?: string;
  rationale?: string;
}

interface RawStructuralRestructureResponse {
  proposed_features?: RawStructuralFeatureProposal[];
  proposedFeatures?: RawStructuralFeatureProposal[];
  removed_feature_ids?: unknown[];
  removedFeatureIds?: unknown[];
  removed_acceptance_requirement_refs?: unknown[];
  removedAcceptanceRequirementRefs?: unknown[];
}

interface DraftFeatureReviewDetails {
  whySeparate?: string;
  possibleMergeWith: string[];
  possibleSplitNote?: string;
}

interface DecompositionDraftResult {
  features: RawDraftFeature[];
  reviewMeta: {
    reasoningSummary?: string;
    unresolvedAmbiguities: string[];
    openDecisions: OpenDecision[];
    featureNotes: DraftFeatureReviewDetails[];
  };
  usage: { input: number; output: number };
}

interface ClarifyQuestionPlan {
  min: number;
  max: number;
  target: number;
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
  advisoryTriage?: AdvisoryTriageContract;
  sizingContract?: EffectiveSizingContract;
}

interface DiscoverySufficiencyEvaluation {
  sufficient: boolean;
  status: 'ask_followup' | 'ready_to_generate' | 'ready_with_open_decisions';
  questions?: ClarifyQuestion[];
  missingCategoryKeys: ClarifyCategoryKey[];
  reasonCodes: string[];
  coverageArtifact: DiscoveryCoverageArtifact;
  warning?: string;
  tokenUsage: TokenUsageSummary;
  durationMs: number;
}

interface ArObligations {
  confirmedOutcomes: string[];
  scopeBoundaries: string[];
  confirmedDataObligations: string[];
  unresolvedDecisions: string[];
  wiMustCoverBehaviors: string[];
}

const RAW_ACCEPTANCE_REQUIREMENT_SCHEMA: JsonSchema = {
  anyOf: [
    { type: 'string' },
    {
      type: 'object',
      properties: {
        given: { type: 'string' },
        when: { type: 'string' },
        then: { type: 'string' },
      },
    },
  ],
};

const RAW_FEATURE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    summary: { type: 'string' },
    description: { type: 'string' },
    acceptance_requirements: {
      type: 'array',
      items: RAW_ACCEPTANCE_REQUIREMENT_SCHEMA,
    },
    acceptanceRequirements: {
      type: 'array',
      items: RAW_ACCEPTANCE_REQUIREMENT_SCHEMA,
    },
    suggested_story_points: { type: 'number' },
    process_code: { type: 'string' },
    feature_class: { type: 'string' },
    featureClass: { type: 'string' },
    confidence: { type: 'string' },
    actor_source: { type: 'string' },
    actorSource: { type: 'string' },
  },
};

const RAW_DRAFT_FEATURE_SCHEMA: JsonSchema = {
  ...RAW_FEATURE_SCHEMA,
  properties: {
    ...(RAW_FEATURE_SCHEMA.properties ?? {}),
    why_separate: { type: 'string' },
    whySeparate: { type: 'string' },
    possible_merge_with: { type: 'array', items: { type: 'string' } },
    possibleMergeWith: { type: 'array', items: { type: 'string' } },
    possible_split_note: { type: 'string' },
    possibleSplitNote: { type: 'string' },
  },
};

const RAW_DECOMPOSITION_RESPONSE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    reasoning_summary: { type: 'string' },
    reasoningSummary: { type: 'string' },
    unresolved_ambiguities: { type: 'array', items: { type: 'string' } },
    unresolvedAmbiguities: { type: 'array', items: { type: 'string' } },
    open_decisions: { type: 'array', items: { type: 'object' } },
    openDecisions: { type: 'array', items: { type: 'object' } },
    features: { type: 'array', items: RAW_DRAFT_FEATURE_SCHEMA },
  },
  required: ['features'],
};

const RAW_DESCRIPTION_REWRITE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    description: { type: 'string' },
  },
};

const RAW_DESCRIPTION_REPAIR_RESPONSE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    rewrites: {
      type: 'array',
      items: RAW_DESCRIPTION_REWRITE_SCHEMA,
    },
  },
  required: ['rewrites'],
};

const RAW_FEATURE_COLLECTION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    features: {
      type: 'array',
      items: RAW_FEATURE_SCHEMA,
    },
  },
  required: ['features'],
};

const REFINE_FEEDBACK_SUFFICIENCY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    sufficient: { type: 'boolean' },
    question: { type: 'string' },
  },
  required: ['sufficient'],
};

const RAW_COVERAGE_REVIEW_RESPONSE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    sufficient: { type: 'boolean' },
    missingCoverage: { type: 'array', items: { type: 'string' } },
    reasoning: { type: 'string' },
  },
  required: ['sufficient'],
};

const RAW_STRUCTURAL_FEATURE_PROPOSAL_SCHEMA: JsonSchema = {
  ...RAW_FEATURE_SCHEMA,
  properties: {
    ...(RAW_FEATURE_SCHEMA.properties ?? {}),
    source_feature_ids: { type: 'array', items: { type: 'string' } },
    sourceAcceptanceRequirementRefs: { type: 'array', items: { type: 'string' } },
    source_acceptance_requirement_refs: { type: 'array', items: { type: 'string' } },
    primary_source_feature_id: { type: 'string' },
    primarySourceFeatureId: { type: 'string' },
    rationale: { type: 'string' },
  },
};

const RAW_STRUCTURAL_RESTRUCTURE_RESPONSE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    proposed_features: { type: 'array', items: RAW_STRUCTURAL_FEATURE_PROPOSAL_SCHEMA },
    proposedFeatures: { type: 'array', items: RAW_STRUCTURAL_FEATURE_PROPOSAL_SCHEMA },
    removed_feature_ids: { type: 'array', items: { type: 'string' } },
    removedFeatureIds: { type: 'array', items: { type: 'string' } },
    removed_acceptance_requirement_refs: { type: 'array', items: { type: 'string' } },
    removedAcceptanceRequirementRefs: { type: 'array', items: { type: 'string' } },
  },
  anyOf: [
    { type: 'object', required: ['proposed_features'] },
    { type: 'object', required: ['proposedFeatures'] },
  ],
};

const AR_GENERATION_ATTEMPTS = 2;
const AR_RETRY_DELAY_MS = 600;
/** Caps parallel AR LLM calls (backfill path) so providers do not throttle. Reduced from 5 to 3 to avoid Gemini rate-limiting. */
const AR_PARALLEL_CONCURRENCY = 3;

/**
 * Maps the user-selected pipeline profile to a reasoning effort level.
 * fast → 'none'  (no thinking budget — fastest, lowest token cost)
 * balanced → 'medium'  (balanced quality without forcing the deepest path)
 * quality → 'high'  (deepest reasoning for decomposition-quality work)
 *
 * Non-thinking providers (Ollama, older Claude/Gemini/OpenAI) silently ignore reasoning effort.
 */
function pipelineReasoningEffort(profile: PipelineProfile | undefined): 'none' | 'medium' | 'high' {
  if (profile === 'fast') return 'none';
  if (profile === 'quality') return 'high';
  return 'medium'; // 'balanced' or undefined → medium
}

/** Pass-2 AR generation needs enough reasoning to avoid templated shallow ARs. */
function acceptanceRequirementsReasoningEffort(profile: PipelineProfile | undefined): 'none' | 'high' {
  if (profile === 'fast') return 'none';
  return 'high'; // balanced + quality
}

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

export interface ArGenerationProgressSnapshot {
  total: number;
  completedFeatureIds: string[];
  activeFeatureIds: string[];
  backfillFeatureIds: string[];
  failedFeatureIds: string[];
  phase: 'initial' | 'backfill';
}

const INCOMPLETE_AR_RETRY_MESSAGE = 'Acceptance requirements could not be completed automatically. Retry this feature to finish its ARs.';

function trimForPrompt(text: string, maxChars: number): string {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function summarizeAnswerForObligation(answer: ClarifyAnswer): string {
  return trimForPrompt([
    answer.question,
    answer.answer,
    ...(answer.selectedSuggestions ?? []),
  ].filter(Boolean).join(' | '), 400);
}

function uniquePromptSummaries(values: string[]): string[] {
  return uniqueNonEmptyStrings(values).map((value) => trimForPrompt(value, 400));
}

export class GenerationCancelledError extends Error {
  constructor() {
    super('Generation cancelled');
    this.name = 'GenerationCancelledError';
  }
}

export class ClarifyDiscoveryError extends Error {
  reasonCode: ClarifyFailureReasonCode;
  diagnostics: ClarifyFailureDiagnostics;

  constructor(reasonCode: ClarifyFailureReasonCode, diagnostics: ClarifyFailureDiagnostics, message?: string) {
    super(message ?? diagnostics.technicalSummary ?? 'Clarifying question discovery failed');
    this.name = 'ClarifyDiscoveryError';
    this.reasonCode = reasonCode;
    this.diagnostics = diagnostics;
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
  clarify: 4000,
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
const MAX_CLARIFY_SUGGESTION_CHARS = 180;

function trimPromptText(text: string, maxChars: number): string {
  const normalized = (text || '').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}\n...[truncated for speed]`;
}

type DiscoveryCandidateSource = 'root_array' | 'questions' | 'features' | 'missing';

type ParsedQuestionCandidatesResult = {
  questions: ClarifyQuestion[];
  source: DiscoveryCandidateSource;
  rawCandidateCount: number;
  validQuestionObjectCount: number;
  stringQuestionCount: number;
  truncatedQuestionCount: number;
  parseShape: string;
};

function summarizeDiscoveryJsonShape(rawData: unknown): string {
  if (Array.isArray(rawData)) return 'root:Array';
  if (!rawData || typeof rawData !== 'object') return `root:${typeof rawData}`;

  const root = rawData as Record<string, unknown>;
  const keys = Object.keys(root).sort();
  const questionShape = Array.isArray(root.questions) ? `questions:Array(${root.questions.length})` : `questions:${typeof root.questions}`;
  const featureShape = Array.isArray(root.features) ? `features:Array(${root.features.length})` : `features:${typeof root.features}`;
  return `root:Object keys=${keys.join(',') || '(none)'} ${questionShape} ${featureShape}`;
}

function resolveDiscoveryQuestionCandidates(rawData: unknown): { source: DiscoveryCandidateSource; candidates: unknown[] } {
  if (Array.isArray(rawData)) {
    return { source: 'root_array', candidates: rawData };
  }
  if (rawData && typeof rawData === 'object' && Array.isArray((rawData as any).questions)) {
    return { source: 'questions', candidates: (rawData as any).questions };
  }
  if (rawData && typeof rawData === 'object' && Array.isArray((rawData as any).features)) {
    return { source: 'features', candidates: (rawData as any).features };
  }
  return { source: 'missing', candidates: [] };
}

function looksLikeTruncatedDiscoveryQuestion(value: string): boolean {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (/\.\.\.$/.test(normalized)) return true;
  if (/[`"'([{,:;/-]$/.test(normalized)) return true;
  if (/\b(and|or|the|a|an|to|for|with|when|if|is|are|should|can|could|would|will)\s*$/i.test(normalized)) return true;
  return false;
}

function parseQuestionCandidatesDetailed(rawData: unknown): ParsedQuestionCandidatesResult {
  const { source, candidates } = resolveDiscoveryQuestionCandidates(rawData);
  let validQuestionObjectCount = 0;
  let stringQuestionCount = 0;
  let truncatedQuestionCount = 0;

  const questions = candidates
    .filter((candidate) => {
      if (typeof candidate !== 'object' || candidate === null) return false;
      validQuestionObjectCount += 1;
      const rawQuestion = (candidate as any).question;
      if (typeof rawQuestion !== 'string') return false;
      stringQuestionCount += 1;
      if (looksLikeTruncatedDiscoveryQuestion(rawQuestion)) truncatedQuestionCount += 1;
      return true;
    })
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
          .slice(0, 3)
        : [],
    }))
    .map((question) => ({
      ...question,
      question: trimClarifyCopy(question.question, MAX_CLARIFY_QUESTION_CHARS),
      details: trimClarifyCopy(question.details ?? '', MAX_CLARIFY_DETAILS_CHARS) || undefined,
      suggestions: question.suggestions
        .map((suggestion) => trimClarifyCopy(suggestion, MAX_CLARIFY_SUGGESTION_CHARS))
        .filter(Boolean)
        .slice(0, 3),
    }))
    .filter((question) => question.question.length > 0);

  return {
    questions,
    source,
    rawCandidateCount: candidates.length,
    validQuestionObjectCount,
    stringQuestionCount,
    truncatedQuestionCount,
    parseShape: summarizeDiscoveryJsonShape(rawData),
  };
}

export function parseQuestionCandidates(rawData: unknown): ClarifyQuestion[] {
  return parseQuestionCandidatesDetailed(rawData).questions;
}

export function buildClarifyFailureDiagnostics(
  reasonCode: ClarifyFailureReasonCode,
  opts: {
    generatedQuestionCount?: number;
    parseShape?: string;
    technicalSummary?: string;
  } = {},
): ClarifyFailureDiagnostics {
  const generatedQuestionCount = Number.isFinite(opts.generatedQuestionCount)
    ? Number(opts.generatedQuestionCount)
    : undefined;
  const technicalSummary = opts.technicalSummary ?? (() => {
    switch (reasonCode) {
      case 'json_parse_failed':
        return 'The discovery model did not return valid JSON after the built-in JSON retry.';
      case 'question_array_missing':
        return 'The discovery response was valid JSON, but it did not include a usable questions array.';
      case 'question_shape_invalid':
        return 'The discovery response included question entries, but none matched the expected question shape.';
      case 'question_array_empty_when_discovery_required':
        return 'Discovery still found unresolved ambiguity, but the response returned no usable questions.';
      case 'question_set_generic':
        return 'The discovery response returned questions, but they were too generic to trust.';
      case 'question_set_truncated':
        return 'The discovery response contained partial or truncated question text that could not be normalized safely.';
      case 'timeout':
        return 'Discovery timed out before it could prepare a usable question set.';
      case 'queue_error':
      default:
        return 'Discovery hit an unexpected backend error before it could prepare a usable question set.';
    }
  })();
  const userActionHint = (() => {
    switch (reasonCode) {
      case 'question_array_empty_when_discovery_required':
        return 'Try narrowing the ask to one workflow, or name the actor, trigger, and key decision rules explicitly.';
      case 'question_set_generic':
        return 'Add the concrete business object, actor, trigger, and duplicate or exception policy so discovery can ask grounded questions.';
      case 'question_array_missing':
      case 'question_shape_invalid':
      case 'question_set_truncated':
      case 'json_parse_failed':
        return 'Your requirement is probably fine. Retry once first; if it repeats, add one concrete example of the workflow or rule you need clarified.';
      case 'timeout':
        return 'Retry once. If it keeps timing out, shorten the requirement or remove non-essential background detail.';
      case 'queue_error':
      default:
        return 'Retry once. If it repeats, try a shorter requirement with the key actor, trigger, and business rule stated directly.';
    }
  })();

  return {
    technicalSummary,
    userActionHint,
    ...(generatedQuestionCount !== undefined ? { generatedQuestionCount } : {}),
    ...(opts.parseShape ? { parseShape: opts.parseShape } : {}),
  };
}

function discoveryFailureMessage(reasonCode: ClarifyFailureReasonCode): string {
  switch (reasonCode) {
    case 'question_array_empty_when_discovery_required':
      return 'Discovery could not prepare focused questions because the requirement is still too open-ended.';
    case 'question_set_generic':
      return 'Discovery only produced generic questions, so it stopped instead of guessing.';
    case 'question_array_missing':
    case 'question_shape_invalid':
    case 'question_set_truncated':
    case 'json_parse_failed':
      return 'Discovery could not format a usable question set this time.';
    case 'timeout':
      return 'Discovery timed out before clarifying questions were ready.';
    case 'queue_error':
    default:
      return 'Discovery could not prepare clarifying questions.';
  }
}

function pushPromptSection(parts: string[], heading: string, text: string, maxChars: number) {
  const trimmed = trimPromptText(text, maxChars);
  if (!trimmed) return;
  parts.push(`${heading}:\n${trimmed}`);
}

function extractDiscoveredRoles(answers?: ClarifyAnswer[]): string[] {
  if (!answers?.length) return [];
  const roles = new Set<string>();
  for (const a of answers) {
    if (a.categoryKey !== 'user_personas') continue;
    const text = (a.answer || a.customAnswer || '').trim();
    if (text) roles.add(text);
    for (const s of a.selectedSuggestions ?? []) {
      const trimmed = s.trim();
      if (trimmed) roles.add(trimmed);
    }
  }
  return [...roles];
}

function formatClarifyAnswersForPrompt(answers: ClarifyAnswer[]): string {
  return answers
    .map((answer, index) => {
      const question = trimPromptText(String(answer.question ?? ''), 220);
      const main = trimPromptText(String(answer.answer ?? ''), 600);
      const custom = trimPromptText(String(answer.customAnswer ?? ''), 500);
      const selectedSuggestions = uniqueNonEmptyStrings(
        (answer.selectedSuggestions ?? []).map((item) => trimPromptText(String(item ?? ''), 100)),
      ).slice(0, 4);
      const tags = [
        answer.categoryKey ? labelForCategoryKey(answer.categoryKey) : '',
        answer.intent ? String(answer.intent).trim() : '',
      ].filter(Boolean);
      const prefix = tags.length ? ` [${tags.join(' | ')}]` : '';
      const answerLines = [
        main ? `A: ${main}` : '',
        custom && custom !== main ? `Additional context: ${custom}` : '',
        selectedSuggestions.length ? `Selected signals: ${selectedSuggestions.join('; ')}` : '',
      ].filter(Boolean);
      return [`${index + 1}.${prefix} Q: ${question}`, ...answerLines].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

function buildGenerationUserMessage(input: {
  requirement: string;
  clarifyAnswers: ClarifyAnswer[];
  attachmentText: string;
  wiContextText: string;
  wiInsightsArtifact?: WorkInstructionInsightArtifact | null;
  similarStoriesText: string;
  limits: typeof PASS1_CONTEXT_LIMITS | typeof PASS1_CONTEXT_LIMITS_COMPACT | typeof PASS2_CONTEXT_LIMITS;
}): string {
  const parts = [`REQUIREMENT: ${trimPromptText(input.requirement, input.limits.requirement)}`];

  if (input.clarifyAnswers.length) {
    const qaText = formatClarifyAnswersForPrompt(input.clarifyAnswers);
    pushPromptSection(parts, 'CLARIFICATION Q&A', qaText, input.limits.clarify);
  }

  pushPromptSection(parts, 'ATTACHMENT CONTEXT', input.attachmentText, input.limits.attachment);
  pushPromptSection(
    parts,
    'WORK INSTRUCTION INSIGHTS (normalized operational obligations extracted from retrieved work-instruction context; preserve them when relevant without copying organization-specific wording)',
    formatWorkInstructionInsightsForPrompt(input.wiInsightsArtifact),
    input.limits.wi,
  );
  pushPromptSection(parts, 'WORK INSTRUCTIONS / OPERATIONAL GUIDANCE (treat relevant rules here as higher-authority business guidance than similar backlog stories)', input.wiContextText, input.limits.wi);
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
}): Promise<DecompositionDraftResult> {
  const reasoningEffort = pipelineReasoningEffort(input.generatorConfig.pipelineProfile);
  const firstAttempt = await callLlmJsonWithUsage<RawDecompositionResponse>({
    model: getTierModel(input.generatorConfig.decompositionModel, input.tier),
    systemPrompt: input.systemPrompt,
    userMessage: input.userMessage,
    maxTokens: input.generatorConfig.maxTokens,
    schemaName: 'decomposition_response',
    jsonSchema: RAW_DECOMPOSITION_RESPONSE_SCHEMA,
    reasoningEffort,
    geminiThinkingLevel: reasoningEffort === 'none' ? undefined : 'high',
    ...input.providerOpts,
  });

  const initialFeatures = firstAttempt.data.features ?? [];
  if (initialFeatures.length > 0) {
    return {
      features: initialFeatures,
      reviewMeta: extractDraftReviewMetadata(firstAttempt.data, initialFeatures),
      usage: firstAttempt.usage,
    };
  }

  const retryAttempt = await callLlmJsonWithUsage<RawDecompositionResponse>({
    model: getTierModel(input.generatorConfig.decompositionModel, input.tier),
    systemPrompt: `${input.systemPrompt}\n\nFINAL REMINDER: Return at least 1 feature. Never return an empty features array.`,
    userMessage: `${input.userMessage}\n\nIMPORTANT: The previous result contained zero features. Return at least one well-scoped feature in valid JSON.`,
    maxTokens: input.generatorConfig.maxTokens,
    schemaName: 'decomposition_response',
    jsonSchema: RAW_DECOMPOSITION_RESPONSE_SCHEMA,
    reasoningEffort,
    geminiThinkingLevel: reasoningEffort === 'none' ? undefined : 'high',
    ...input.providerOpts,
  });

  const retryFeatures = retryAttempt.data.features ?? [];
  if (!retryFeatures.length) {
    throw new Error('Feature breakdown returned no features. Please tighten the requirement or switch to a faster, more reliable model for feature breakdown.');
  }

  return {
    features: retryFeatures,
    reviewMeta: extractDraftReviewMetadata(retryAttempt.data, retryFeatures),
    usage: {
      input: firstAttempt.usage.input + retryAttempt.usage.input,
      output: firstAttempt.usage.output + retryAttempt.usage.output,
    },
  };
}

function normalizeDraftFeatureReviewDetails(feature: RawDraftFeature): DraftFeatureReviewDetails {
  return {
    whySeparate: sanitizeArClause(feature.why_separate ?? feature.whySeparate ?? ''),
    possibleMergeWith: sanitizeStringArray(
      Array.isArray(feature.possible_merge_with)
        ? feature.possible_merge_with
        : Array.isArray(feature.possibleMergeWith)
          ? feature.possibleMergeWith
          : [],
    ),
    possibleSplitNote: sanitizeArClause(feature.possible_split_note ?? feature.possibleSplitNote ?? ''),
  };
}

const VALID_FEATURE_CLASSES = new Set<FeatureClass>(['business_capability', 'technical_enabler', 'cross_cutting_rule']);
const VALID_FEATURE_CONFIDENCE = new Set<FeatureConfidence>(['confirmed', 'assumption_applied']);
const VALID_ACTOR_SOURCES = new Set<FeatureActorSource>(['prompt', 'clarify', 'workspace_role', 'fallback']);

function sanitizeOpenDecisionArray(values: unknown): OpenDecision[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  return values
    .map((value, index): OpenDecision | null => {
      if (!value || typeof value !== 'object') return null;
      const raw = value as Record<string, unknown>;
      const title = sanitizeArClause(raw.title ?? raw.summary ?? '');
      const detail = sanitizeArClause(raw.detail ?? raw.description ?? '');
      const categoryCandidate = String(raw.category ?? 'general').trim();
      const category = normalizeCategoryKey(categoryCandidate) ?? (categoryCandidate ? 'general' : 'general');
      const impact = sanitizeArClause(raw.impact ?? raw.reason ?? '');
      const blocking = Boolean(raw.blocking);
      if (!title && !detail) return null;
      const dedupeKey = `${title.toLowerCase()}::${detail.toLowerCase()}`;
      if (seen.has(dedupeKey)) return null;
      seen.add(dedupeKey);
      return {
        id: sanitizeArClause(raw.id ?? '') || `open-decision-${index + 1}`,
        title: title || `Open decision ${index + 1}`,
        detail,
        category,
        impact,
        blocking,
      };
    })
    .filter((item): item is OpenDecision => Boolean(item));
}

function fallbackOpenDecisionsFromAmbiguities(values: string[]): OpenDecision[] {
  return values.map((value, index) => ({
    id: `open-decision-${index + 1}`,
    title: `Clarify ${value.split(/[,.]/)[0] || `decision ${index + 1}`}`.trim(),
    detail: value,
    category: normalizeCategoryKey(value) ?? 'general',
    impact: 'This could change confirmed features, roles, or acceptance requirements.',
    blocking: true,
  }));
}

function extractDraftReviewMetadata(
  raw: RawDecompositionResponse,
  features: RawDraftFeature[],
): DecompositionDraftResult['reviewMeta'] {
  const unresolvedAmbiguities = sanitizeStringArray(
    Array.isArray(raw.unresolved_ambiguities)
      ? raw.unresolved_ambiguities
      : Array.isArray(raw.unresolvedAmbiguities)
        ? raw.unresolvedAmbiguities
        : [],
  );
  const explicitOpenDecisions = sanitizeOpenDecisionArray(
    Array.isArray(raw.open_decisions)
      ? raw.open_decisions
      : Array.isArray(raw.openDecisions)
        ? raw.openDecisions
        : [],
  );
  return {
    reasoningSummary: sanitizeArClause(raw.reasoning_summary ?? raw.reasoningSummary ?? ''),
    unresolvedAmbiguities,
    openDecisions: explicitOpenDecisions.length ? explicitOpenDecisions : fallbackOpenDecisionsFromAmbiguities(unresolvedAmbiguities),
    featureNotes: features.map((feature) => normalizeDraftFeatureReviewDetails(feature)),
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

const GENERIC_DESCRIPTION_BENEFIT_PATTERNS = [
  /\brequested outcome is achieved\b/i,
  /\bbusiness value is delivered\b/i,
  /\bprocess (?:stays|remains) (?:aligned|supported|compliant)\b/i,
  /\btask can be completed\b/i,
  /\bworkflow can proceed\b/i,
];

function normalizeDraftDescriptionText(description: string): string {
  let cleaned = deduplicateDescription(description)
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();

  cleaned = cleaned.replace(/\bso that\b\s+(.*?)\s+\bso that\b\s+\1\b/i, 'so that $1');
  return cleaned.trim();
}

function parseFeatureDescriptionParts(description: string): { role: string; action: string; benefit: string } | null {
  const cleaned = normalizeDraftDescriptionText(description);
  const match = cleaned.match(/^As an?\s+(.+?),\s*I need(?:\s+to)?\s+(.+?)\s+so that\s+(.+?)[.?!]?$/i);
  if (!match) return null;
  return {
    role: sanitizeArClause(match[1]),
    action: sanitizeArClause(match[2]),
    benefit: sanitizeArClause(match[3]),
  };
}

function collectFeatureDescriptionIssues(description: string): string[] {
  const cleaned = normalizeDraftDescriptionText(description);
  const issues = new Set<string>();

  if (!/^As an?\s+/i.test(cleaned)) issues.add('Missing "As a [role]" opening');
  if (!/\bI need(?:\s+to)?\b/i.test(cleaned)) issues.add('Missing "I need" action clause');
  if (!/\bso that\b/i.test(cleaned)) issues.add('Missing explicit business benefit');
  if ((cleaned.match(/\bso that\b/gi) ?? []).length > 1) issues.add('Contains repeated "so that" benefit clauses');
  if (/[.?!]\s+\S/.test(cleaned)) issues.add('Contains more than one sentence');

  const parts = parseFeatureDescriptionParts(cleaned);
  if (!parts) {
    issues.add('Does not follow the expected user-story structure');
    return [...issues];
  }

  if (parts.action.split(/\s+/).length < 2) issues.add('Action clause is too weak or incomplete');
  if (parts.benefit.split(/\s+/).length < 2) issues.add('Benefit clause is too weak or incomplete');
  if (GENERIC_DESCRIPTION_BENEFIT_PATTERNS.some((pattern) => pattern.test(parts.benefit))) {
    issues.add('Benefit clause is too generic');
  }

  return [...issues];
}

function buildDraftDescriptionIssueMap(features: Feature[]): Map<string, string[]> {
  const issuesById = new Map<string, string[]>();
  features.forEach((feature) => {
    const issues = collectFeatureDescriptionIssues(feature.description);
    if (issues.length > 0) {
      issuesById.set(feature.id, issues);
    }
  });
  return issuesById;
}

async function repairDraftFeatureDescriptions(opts: {
  requirement: string;
  clarifyAnswers: ClarifyAnswer[];
  attachmentText: string;
  similarStoriesText: string;
  wiContextText: string;
  wiInsightsArtifact?: WorkInstructionInsightArtifact | null;
  features: Feature[];
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
}): Promise<{ features: Feature[]; descriptionQuality: DraftReviewMetadata['descriptionQuality']; usage: { input: number; output: number } }> {
  const issueMap = buildDraftDescriptionIssueMap(opts.features);
  if (issueMap.size === 0) {
    return {
      features: opts.features,
      descriptionQuality: {
        adjustedFeatureIds: [],
        flaggedFeatureIds: [],
        warnings: [],
      },
      usage: { input: 0, output: 0 },
    };
  }

  const flagged = opts.features.filter((feature) => issueMap.has(feature.id));
  const userMessage = [
    buildGenerationUserMessage({
      requirement: opts.requirement,
      clarifyAnswers: opts.clarifyAnswers,
      attachmentText: opts.attachmentText,
      wiContextText: opts.wiContextText,
      wiInsightsArtifact: opts.wiInsightsArtifact,
      similarStoriesText: opts.similarStoriesText,
      limits: PASS1_CONTEXT_LIMITS,
    }),
    `FEATURES WITH DESCRIPTION ISSUES:\n${JSON.stringify(flagged.map((feature) => ({
      id: feature.id,
      summary: feature.summary,
      description: feature.description,
      description_issues: issueMap.get(feature.id) ?? [],
    })), null, 2)}`,
  ].join('\n\n---\n\n');

  const result = await callLlmJsonWithUsage<RawDescriptionRepairResponse>({
    model: getTierModel(opts.config.generatorConfig.refineModel, opts.config.tier),
    systemPrompt: buildDraftDescriptionRepairSystemPrompt(),
    userMessage,
    maxTokens: 2048,
    schemaName: 'description_repair_response',
    jsonSchema: RAW_DESCRIPTION_REPAIR_RESPONSE_SCHEMA,
    reasoningEffort: 'medium',
    ...opts.providerOpts,
  });

  const rewriteMap = new Map(
    (result.data.rewrites ?? [])
      .map((rewrite) => [String(rewrite.id ?? '').trim(), normalizeDraftDescriptionText(String(rewrite.description ?? '').trim())] as const)
      .filter(([id, description]) => id && description),
  );

  const adjustedFeatureIds: string[] = [];
  const revisedFeatures = opts.features.map((feature) => {
    const rewrite = rewriteMap.get(feature.id);
    if (!rewrite) return feature;
    if (normalizeDraftDescriptionText(feature.description) !== rewrite) {
      adjustedFeatureIds.push(feature.id);
      return { ...feature, description: rewrite };
    }
    return feature;
  });

  const remainingIssues = buildDraftDescriptionIssueMap(revisedFeatures);
  const flaggedFeatureIds = [...remainingIssues.keys()];
  const warnings = revisedFeatures
    .filter((feature) => remainingIssues.has(feature.id))
    .map((feature) => `${feature.summary}: ${(remainingIssues.get(feature.id) ?? []).join('; ')}`);

  return {
    features: revisedFeatures,
    descriptionQuality: {
      adjustedFeatureIds,
      flaggedFeatureIds,
      warnings,
    },
    usage: result.usage,
  };
}

function buildDraftReviewMetadata(input: {
  features: Feature[];
  base: DecompositionDraftResult['reviewMeta'];
  openDecisions?: OpenDecision[];
  descriptionQuality?: DraftReviewMetadata['descriptionQuality'];
  lastAction?: DraftReviewDecision;
  reviewMessage?: string;
}): DraftReviewMetadata {
  const issueMap = buildDraftDescriptionIssueMap(input.features);

  const featureNotes: DraftFeatureReviewNote[] = input.features.map((feature, index) => {
    const baseNote = input.base.featureNotes[index] ?? { possibleMergeWith: [] };
    return {
      featureId: feature.id,
      summary: feature.summary,
      whySeparate: baseNote.whySeparate,
      possibleMergeWith: baseNote.possibleMergeWith,
      possibleSplitNote: baseNote.possibleSplitNote,
      featureClass: feature.featureClass,
      confidence: feature.confidence,
      actorSource: feature.actorSource,
      descriptionIssues: issueMap.get(feature.id),
      descriptionAdjusted: Boolean(input.descriptionQuality?.adjustedFeatureIds.includes(feature.id)),
    };
  });

  return {
    reasoningSummary: input.base.reasoningSummary,
    unresolvedAmbiguities: input.base.unresolvedAmbiguities,
    openDecisions: input.openDecisions ?? input.base.openDecisions,
    roleCoverage: buildRoleCoverage(input.features),
    coverageFindings: buildCoverageFindings(input.features, input.openDecisions ?? input.base.openDecisions),
    featureNotes,
    descriptionQuality: input.descriptionQuality,
    lastAction: input.lastAction,
    reviewMessage: input.reviewMessage,
  };
}

function rawFeatureHasCompleteAcceptanceRequirements(feature: RawFeature): boolean {
  const rawArs = getRawAcceptanceArray(feature);
  return rawArs.length > 0
    && !hasIncompleteAcceptanceRequirements(rawArs as Array<{ given?: string; when?: string; then?: string } | string>);
}

function hasAnyIncompleteAcceptanceRequirements(features: RawFeature[]): boolean {
  return features.some((feature) => !rawFeatureHasCompleteAcceptanceRequirements(feature));
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
        schemaName: 'feature_collection',
        jsonSchema: RAW_FEATURE_COLLECTION_SCHEMA,
        reasoningEffort: 'high',
        geminiThinkingLevel: 'high',
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

function listCompleteFeatureIds(features: RawFeature[]): string[] {
  return features
    .filter((feature) => rawFeatureHasCompleteAcceptanceRequirements(feature))
    .map((feature) => feature.id)
    .filter((featureId): featureId is string => Boolean(featureId));
}

export function annotateFailedAcceptanceRequirementFeatures(features: Feature, failedIds: Set<string>): Feature;
export function annotateFailedAcceptanceRequirementFeatures(features: Feature[], failedIds: Set<string>): Feature[];
export function annotateFailedAcceptanceRequirementFeatures(features: Feature | Feature[], failedIds: Set<string>): Feature | Feature[] {
  const applyToFeature = (feature: Feature): Feature => {
    if (failedIds.has(feature.id)) {
      return {
        ...feature,
        arGenerationStatus: 'failed',
        arGenerationError: INCOMPLETE_AR_RETRY_MESSAGE,
      };
    }
    const rest = { ...feature };
    delete rest.arGenerationStatus;
    delete rest.arGenerationError;
    return rest;
  };

  return Array.isArray(features)
    ? features.map((feature) => applyToFeature(feature))
    : applyToFeature(features);
}

async function runParallelArPass(input: {
  features: RawFeature[];
  requirement: string;
  clarifyAnswers?: ClarifyAnswer[];
  attachmentText?: string;
  wiContextText?: string;
  similarStoriesText?: string;
  wiInsightsArtifact?: WorkInstructionInsightArtifact | null;
  domainContext: string;
  domainPatterns?: { roles: string[]; coreTerminology: string[]; arStyle: string } | null;
  arPlan: ArPlan;
  arObligations?: ArObligations;
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
  onArProgress?: (snapshot: ArGenerationProgressSnapshot) => Promise<void>;
  discoveredRoles?: string[];
}): Promise<{ features: RawFeature[]; usage: { input: number; output: number } }> {
  const systemPrompt = buildArSystemPrompt({
    domainContext: input.domainContext,
    domainPatterns: input.domainPatterns,
    arPlan: input.arPlan,
  });

  const model = getTierModel(input.generatorConfig.arModel, input.tier);
  const maxTokens = 8192;

  const wiInsightsText = input.wiInsightsArtifact
    ? formatWorkInstructionInsightsForPrompt(input.wiInsightsArtifact, 5).trim()
    : '';

  // Build per-feature tasks
  const tasks = input.features.map((feature) => ({
      feature,
      userMessage: buildArPerFeatureUserMessage({
        requirement: input.requirement,
        clarifyAnswers: input.clarifyAnswers?.map((a) => ({
          question: a.question,
          answer: a.answer,
          customAnswer: a.customAnswer,
          selectedSuggestions: a.selectedSuggestions,
          categoryKey: a.categoryKey,
          intent: a.intent,
        })),
        attachmentText: input.attachmentText,
        ...(wiInsightsText ? { wiInsightsText } : {}),
        wiContextText: input.wiContextText,
        similarStoriesText: input.similarStoriesText,
        feature: {
          summary: feature.summary ?? '',
          description: feature.description ?? '',
        suggested_story_points: feature.suggested_story_points,
        process_code: feature.process_code,
      },
      siblingFeatures: input.features
        .filter(f => f.id !== feature.id)
        .map(f => ({ summary: f.summary ?? '', description: f.description ?? '' })),
      discoveredRoles: input.discoveredRoles,
      arObligations: input.arObligations,
    }),
  }));

  const total = tasks.length;
  const completedFeatureIds = new Set<string>();
  const activeFeatureIds = new Set(tasks.map((task) => task.feature.id).filter((featureId): featureId is string => Boolean(featureId)));
  const failedFeatureIds = new Set<string>();

  if (input.onArProgress) {
    await input.onArProgress({
      total,
      completedFeatureIds: [],
      activeFeatureIds: [...activeFeatureIds],
      backfillFeatureIds: [],
      failedFeatureIds: [],
      phase: 'initial',
    });
  }

  const runOne = async (task: (typeof tasks)[number]) => {
    let result: { feature: RawFeature; usage: { input: number; output: number } };
    try {
      result = await generateAcceptanceRequirementsForFeature({
        feature: task.feature,
        systemPrompt,
        userMessage: task.userMessage,
        model,
        maxTokens,
        providerOpts: input.providerOpts,
      });
    } catch {
      result = { feature: task.feature, usage: { input: 0, output: 0 } };
    }
    const featureId = task.feature.id;
    if (featureId) {
      activeFeatureIds.delete(featureId);
    }
    if (rawFeatureHasCompleteAcceptanceRequirements(result.feature)) {
      if (featureId) {
        completedFeatureIds.add(featureId);
        failedFeatureIds.delete(featureId);
      }
    } else if (featureId) {
      failedFeatureIds.add(featureId);
    }
    if (input.onArProgress) {
      await input.onArProgress({
        total,
        completedFeatureIds: [...completedFeatureIds],
        activeFeatureIds: [...activeFeatureIds],
        backfillFeatureIds: [],
        failedFeatureIds: [...failedFeatureIds],
        phase: 'initial',
      });
    }
    return result;
  };

  const allResults = await runOrderedConcurrentTasks({
    tasks: tasks.map((task) => () => runOne(task)),
    concurrency: AR_PARALLEL_CONCURRENCY,
  });

  const totalUsage = allResults.reduce(
    (acc, r) => ({ input: acc.input + r.usage.input, output: acc.output + r.usage.output }),
    { input: 0, output: 0 },
  );

  return { features: allResults.map((r) => r.feature), usage: totalUsage };
}

async function backfillMissingAcceptanceRequirements(input: {
  features: RawFeature[];
  requirement: string;
  clarifyAnswers?: ClarifyAnswer[];
  attachmentText?: string;
  wiContextText?: string;
  similarStoriesText?: string;
  wiInsightsArtifact?: WorkInstructionInsightArtifact | null;
  domainContext: string;
  domainPatterns?: { roles: string[]; coreTerminology: string[]; arStyle: string } | null;
  arPlan: ArPlan;
  arObligations?: ArObligations;
  generatorConfig: TenantConfig['generatorConfig'];
  tier: TenantConfig['tier'];
  discoveredRoles?: string[];
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
  onArProgress?: (snapshot: ArGenerationProgressSnapshot) => Promise<void>;
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
    domainPatterns: input.domainPatterns,
    arPlan: input.arPlan,
  });
  const model = getTierModel(input.generatorConfig.arModel, input.tier);
  const nextFeatures = [...input.features];
  const total = input.features.length;
  const completedFeatureIds = new Set(listCompleteFeatureIds(input.features));
  const retryingFeatureIds = new Set(missingIndexes.map(({ feature }) => feature.id).filter((featureId): featureId is string => Boolean(featureId)));
  const failedFeatureIds = new Set<string>();

  if (input.onArProgress) {
    retryingFeatureIds.forEach((featureId) => completedFeatureIds.delete(featureId));
    await input.onArProgress({
      total,
      completedFeatureIds: [...completedFeatureIds],
      activeFeatureIds: [],
      backfillFeatureIds: [...retryingFeatureIds],
      failedFeatureIds: [],
      phase: 'backfill',
    });
  }

  const wiInsightsText = input.wiInsightsArtifact
    ? formatWorkInstructionInsightsForPrompt(input.wiInsightsArtifact, 5).trim()
    : '';

  const buildUserMessage = (feature: RawFeature) => buildArPerFeatureUserMessage({
    requirement: input.requirement,
    clarifyAnswers: input.clarifyAnswers?.map((a) => ({
      question: a.question,
      answer: a.answer,
      customAnswer: a.customAnswer,
      selectedSuggestions: a.selectedSuggestions,
      categoryKey: a.categoryKey,
      intent: a.intent,
    })),
    attachmentText: input.attachmentText,
    ...(wiInsightsText ? { wiInsightsText } : {}),
    wiContextText: input.wiContextText,
    similarStoriesText: input.similarStoriesText,
    feature: {
      summary: feature.summary ?? '',
      description: feature.description ?? '',
      suggested_story_points: feature.suggested_story_points,
      process_code: feature.process_code,
    },
    siblingFeatures: input.features
      .filter(f => f.id !== feature.id)
      .map(f => ({ summary: f.summary ?? '', description: f.description ?? '' })),
    discoveredRoles: input.discoveredRoles,
    arObligations: input.arObligations,
  });

  const runBackfillOne = async ({ feature, index }: { feature: RawFeature; index: number }) => {
    let result: { feature: RawFeature; usage: { input: number; output: number } };
    try {
      result = await generateAcceptanceRequirementsForFeature({
        feature,
        systemPrompt,
        userMessage: buildUserMessage(feature),
        model,
        maxTokens: 8192,
        providerOpts: input.providerOpts,
      });
    } catch {
      result = { feature, usage: { input: 0, output: 0 } };
    }
    const featureId = feature.id;
    if (featureId) {
      retryingFeatureIds.delete(featureId);
    }
    if (rawFeatureHasCompleteAcceptanceRequirements(result.feature)) {
      if (featureId) {
        completedFeatureIds.add(featureId);
        failedFeatureIds.delete(featureId);
      }
    } else if (featureId) {
      failedFeatureIds.add(featureId);
    }
    if (input.onArProgress) {
      await input.onArProgress({
        total,
        completedFeatureIds: [...completedFeatureIds],
        activeFeatureIds: [],
        backfillFeatureIds: [...retryingFeatureIds],
        failedFeatureIds: [...failedFeatureIds],
        phase: 'backfill',
      });
    }
    return { result, index };
  };

  const backfillResults = await runOrderedConcurrentTasks({
    tasks: missingIndexes.map((entry) => () => runBackfillOne(entry)),
    concurrency: AR_PARALLEL_CONCURRENCY,
  });

  let usage = { input: 0, output: 0 };
  for (const { result, index } of backfillResults) {
    usage = { input: usage.input + result.usage.input, output: usage.output + result.usage.output };
    if (rawFeatureHasCompleteAcceptanceRequirements(result.feature)) {
      nextFeatures[index] = result.feature;
    }
  }

  return { features: nextFeatures, usage };
}

// ─── LLM-based Requirement Triage ────────────────────────────────────────────

export interface TriageResult extends AdvisoryTriageContract {}

export const DEFAULT_GENERATION_TRIAGE_FALLBACK: AdvisoryTriageContract = {
  reasoning: 'Triage could not be completed; using operational fallback metadata only.',
  confidence: 'low',
  deliveryForecast: {
    shape: 'minimal',
    complexity: 'low',
    featureTarget: 1,
    featureMin: 1,
    featureMax: 1,
    arDepth: 'standard',
    arTarget: 0,
  },
  discoveryForecast: {
    scope: 'narrow',
    complexity: 'low',
    ambiguity: 'medium',
    recommendedInitialCount: 0,
    followupCap: 0,
  },
  telemetry: {
    fallbackUsed: true,
  },
};

const VALID_SHAPES = new Set<FeaturePlan['shape']>(['minimal', 'narrow', 'balanced', 'broad', 'epic']);
const VALID_COMPLEXITIES = new Set<FeaturePlan['complexity']>(['trivial', 'low', 'medium', 'high', 'very_high']);
const VALID_AR_DEPTHS = new Set<ArPlan['depth']>(['minimal', 'lean', 'standard', 'thorough', 'comprehensive']);
const VALID_DISCOVERY_SCOPES = new Set<DiscoveryProfile['scope']>(['narrow', 'moderate', 'broad', 'very_broad']);
const VALID_DISCOVERY_COMPLEXITIES = new Set<DiscoveryProfile['complexity']>(['low', 'medium', 'high', 'very_high']);
const VALID_DISCOVERY_AMBIGUITIES = new Set<DiscoveryProfile['ambiguity']>(['low', 'medium', 'high']);
const VALID_TRIAGE_CONFIDENCE = new Set<AdvisoryTriageConfidence>(['low', 'medium', 'high']);

function parseTriageResult(raw: unknown): TriageResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const deliveryRoot = (obj.deliveryForecast && typeof obj.deliveryForecast === 'object'
    ? obj.deliveryForecast
    : obj) as Record<string, unknown>;
  const discoveryRoot = (obj.discoveryForecast && typeof obj.discoveryForecast === 'object'
    ? obj.discoveryForecast
    : obj) as Record<string, unknown>;

  const featureTarget = typeof deliveryRoot.featureTarget === 'number'
    ? deliveryRoot.featureTarget
    : typeof obj.estimatedFeatures === 'number'
      ? obj.estimatedFeatures
      : null;
  const shape = typeof deliveryRoot.shape === 'string' && VALID_SHAPES.has(deliveryRoot.shape as FeaturePlan['shape'])
    ? deliveryRoot.shape as FeaturePlan['shape']
    : null;
  const deliveryComplexity = typeof deliveryRoot.complexity === 'string' && VALID_COMPLEXITIES.has(deliveryRoot.complexity as FeaturePlan['complexity'])
    ? deliveryRoot.complexity as FeaturePlan['complexity']
    : null;
  const arDepth = typeof deliveryRoot.arDepth === 'string' && VALID_AR_DEPTHS.has(deliveryRoot.arDepth as ArPlan['depth'])
    ? deliveryRoot.arDepth as ArPlan['depth']
    : null;
  const discoveryScope = typeof discoveryRoot.scope === 'string' && VALID_DISCOVERY_SCOPES.has(discoveryRoot.scope as DiscoveryProfile['scope'])
    ? discoveryRoot.scope as DiscoveryProfile['scope']
    : shape === 'epic'
      ? 'very_broad'
      : shape === 'broad'
        ? 'broad'
        : shape === 'balanced'
          ? 'moderate'
          : shape === 'minimal' || shape === 'narrow'
            ? 'narrow'
            : null;
  const discoveryComplexity = typeof discoveryRoot.complexity === 'string' && VALID_DISCOVERY_COMPLEXITIES.has(discoveryRoot.complexity as DiscoveryProfile['complexity'])
    ? discoveryRoot.complexity as DiscoveryProfile['complexity']
    : deliveryComplexity === 'trivial'
      ? 'low'
      : deliveryComplexity === 'very_high'
        ? 'very_high'
        : deliveryComplexity as DiscoveryProfile['complexity'] | null;
  const discoveryAmbiguity = typeof discoveryRoot.ambiguity === 'string' && VALID_DISCOVERY_AMBIGUITIES.has(discoveryRoot.ambiguity as DiscoveryProfile['ambiguity'])
    ? discoveryRoot.ambiguity as DiscoveryProfile['ambiguity']
    : typeof obj.estimatedQuestions === 'number'
      ? (obj.estimatedQuestions >= 10 ? 'high' : obj.estimatedQuestions >= 7 ? 'medium' : 'low')
      : null;
  const recommendedInitialCount = typeof discoveryRoot.recommendedInitialCount === 'number'
    ? discoveryRoot.recommendedInitialCount
    : typeof obj.estimatedQuestions === 'number'
      ? obj.estimatedQuestions
      : null;
  const followupCap = typeof discoveryRoot.followupCap === 'number'
    ? discoveryRoot.followupCap
    : recommendedInitialCount != null
      ? (recommendedInitialCount >= 12 ? 6 : recommendedInitialCount >= 7 ? 4 : 2)
      : null;
  const confidence = typeof obj.confidence === 'string' && VALID_TRIAGE_CONFIDENCE.has(obj.confidence as AdvisoryTriageConfidence)
    ? obj.confidence as AdvisoryTriageConfidence
    : 'medium';
  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning.trim() : '';

  if (
    featureTarget == null
    || !shape
    || !deliveryComplexity
    || !arDepth
    || !discoveryScope
    || !discoveryComplexity
    || !discoveryAmbiguity
    || recommendedInitialCount == null
    || followupCap == null
  ) {
    return null;
  }

  const featureMin = typeof deliveryRoot.featureMin === 'number' ? Math.max(1, Math.round(deliveryRoot.featureMin)) : undefined;
  const featureMax = typeof deliveryRoot.featureMax === 'number' ? Math.max(1, Math.round(deliveryRoot.featureMax)) : undefined;
  const arTarget = typeof deliveryRoot.arTarget === 'number' ? Math.max(0, Math.round(deliveryRoot.arTarget)) : undefined;

  return {
    reasoning,
    confidence,
    deliveryForecast: {
      shape,
      complexity: deliveryComplexity,
      featureTarget: clampCount(featureTarget, 1, 15),
      ...(featureMin != null ? { featureMin } : {}),
      ...(featureMax != null ? { featureMax } : {}),
      arDepth,
      ...(arTarget != null ? { arTarget: clampCount(arTarget, 0, 8) } : {}),
    },
    discoveryForecast: {
      scope: discoveryScope,
      complexity: discoveryComplexity,
      ambiguity: discoveryAmbiguity,
      recommendedInitialCount: clampCount(recommendedInitialCount, 0, 20),
      followupCap: clampCount(followupCap, 0, 10),
    },
  };
}

function clampCount(value: number, min: number, max: number): number {
  const rounded = Math.round(Number(value));
  if (!Number.isFinite(rounded)) return min;
  return Math.min(max, Math.max(min, rounded));
}

function ambiguityLevelFromProfile(ambiguity: AdvisoryDiscoveryForecast['ambiguity']): ClarifyAmbiguityAssessment['level'] {
  return ambiguity === 'high' ? 'vague' : ambiguity === 'low' ? 'clear' : 'medium';
}

export function triageToAssessment(triage: TriageResult): { featurePlan: FeaturePlan; arPlan: ArPlan; questionPlan: ClarifyQuestionPlan } {
  const est = Math.max(1, triage.deliveryForecast.featureTarget);
  const isHighComplexity = triage.deliveryForecast.complexity === 'high' || triage.deliveryForecast.complexity === 'very_high';
  const upwardBuffer = Math.max(1, (triage.deliveryForecast.featureMax ?? (est + (isHighComplexity ? Math.max(4, Math.ceil(est * 0.8)) : Math.max(2, Math.ceil(est * 0.5))))) - est);
  const featurePlan: FeaturePlan = {
    min: Math.max(1, triage.deliveryForecast.featureMin ?? (est - 1)),
    max: Math.max(est, triage.deliveryForecast.featureMax ?? (est + upwardBuffer)),
    target: est,
    shape: triage.deliveryForecast.shape,
    complexity: triage.deliveryForecast.complexity,
  };

  const arPlan: ArPlan = {
    min: 0,
    max: 0,
    target: Math.max(0, triage.deliveryForecast.arTarget ?? 0),
    depth: triage.deliveryForecast.arDepth,
  };

  const q = Math.max(0, triage.discoveryForecast.recommendedInitialCount);
  const isHighQ = triage.discoveryForecast.complexity === 'high' || triage.discoveryForecast.complexity === 'very_high';
  const qMin = Math.max(0, q - 2);
  const qMax = isHighQ ? Math.min(q + 8, 20) : Math.min(q + 4, 16);
  const questionPlan: ClarifyQuestionPlan = {
    min: qMin,
    max: qMax,
    target: q,
  };

  return { featurePlan, arPlan, questionPlan };
}

export function triageToSizingContract(triage: TriageResult): EffectiveSizingContract {
  return {
    shape: triage.deliveryForecast.shape,
    complexity: triage.deliveryForecast.complexity,
    featureTarget: Math.max(1, triage.deliveryForecast.featureTarget),
    arDepth: triage.deliveryForecast.arDepth,
    ...(typeof triage.deliveryForecast.arTarget === 'number' ? { arTarget: triage.deliveryForecast.arTarget } : {}),
    estimatedQuestions: Math.max(0, triage.discoveryForecast.recommendedInitialCount),
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
      ? `REQUIREMENT:\n${input.requirement}\n\nCLARIFYING Q&A:\n${formatClarifyAnswersForPrompt(input.clarifyAnswers)}`
      : `REQUIREMENT:\n${input.requirement}`;

    const result = await callLlmJsonWithUsage<Record<string, unknown>>({
      model: getTierModel(input.generatorConfig.triageModel, input.tier),
      systemPrompt: buildTriageSystemPrompt(),
      userMessage,
      reasoningEffort: pipelineReasoningEffort(input.generatorConfig.pipelineProfile),
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
      const highComplexity = input.triage?.deliveryForecast.complexity === 'high' || input.triage?.deliveryForecast.complexity === 'very_high';
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
      return input.triage?.deliveryForecast.complexity === 'high' ? 'standard' : 'lean';
    case 'workflow_area':
      return input.triage?.deliveryForecast.complexity === 'high' || input.triage?.deliveryForecast.complexity === 'very_high'
        ? 'thorough'
        : 'standard';
    case 'broad_platform':
    default:
      return input.triage?.deliveryForecast.complexity === 'very_high' ? 'comprehensive' : 'thorough';
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
  return input.triage;
}

export function capDiscoveryProfileFloorForSmallAsk(input: {
  requirement: string;
  clarifyAnswers?: ClarifyAnswer[];
  triage: TriageResult | null;
}): TriageResult | null {
  return input.triage;
}

function toRawFeature(feature: Feature): RawFeature {
  return {
    id: feature.id,
    summary: feature.summary,
    description: feature.description,
    acceptance_requirements: feature.acceptanceRequirements.map((ar) => `GIVEN ${ar.given} WHEN ${ar.when} THEN ${ar.then}`),
    suggested_story_points: feature.storyPoints,
    process_code: feature.processCode,
    feature_class: feature.featureClass,
    confidence: feature.confidence,
    actor_source: feature.actorSource,
  };
}

async function reviewDraftFeatureSet(opts: {
  requirement: string;
  clarifyAnswers: ClarifyAnswer[];
  attachmentText: string;
  similarStoriesText: string;
  wiContextText: string;
  wiInsightsArtifact?: WorkInstructionInsightArtifact | null;
  features: Feature[];
  action: Exclude<DraftReviewDecision, 'continue'>;
  selectedFeatureIds?: string[];
  currentReviewMeta?: DraftReviewMetadata;
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
}): Promise<{ features: Feature[]; reviewMeta: DraftReviewMetadata; usage: { input: number; output: number } }> {
  const selectedFeatureIds = uniqueNonEmptyStrings(opts.selectedFeatureIds ?? []).filter((featureId) =>
    opts.features.some((feature) => feature.id === featureId),
  );
  const selectionTooSmall =
    (opts.action === 'merge_selected' && selectedFeatureIds.length < 2)
    || (opts.action === 'split_selected' && selectedFeatureIds.length < 1);

  if (selectionTooSmall) {
    const reviewMeta = opts.currentReviewMeta
      ? {
          ...opts.currentReviewMeta,
          lastAction: opts.action,
          reviewMessage: opts.action === 'merge_selected'
            ? 'Select at least two draft features before merging.'
            : 'Select at least one draft feature before splitting.',
        }
      : buildDraftReviewMetadata({
          features: opts.features,
          base: {
            reasoningSummary: '',
            unresolvedAmbiguities: [],
            openDecisions: [],
            featureNotes: opts.features.map(() => ({ possibleMergeWith: [] })),
          },
          lastAction: opts.action,
          reviewMessage: opts.action === 'merge_selected'
            ? 'Select at least two draft features before merging.'
            : 'Select at least one draft feature before splitting.',
        });
    return { features: opts.features, reviewMeta, usage: { input: 0, output: 0 } };
  }

  const userMessage = [
    buildGenerationUserMessage({
      requirement: opts.requirement,
      clarifyAnswers: opts.clarifyAnswers,
      attachmentText: opts.attachmentText,
      wiContextText: opts.wiContextText,
      wiInsightsArtifact: opts.wiInsightsArtifact,
      similarStoriesText: opts.similarStoriesText,
      limits: PASS1_CONTEXT_LIMITS,
    }),
    `CURRENT DRAFT FEATURES:\n${JSON.stringify(opts.features.map((feature) => ({
      id: feature.id,
      summary: feature.summary,
      description: feature.description,
      suggested_story_points: feature.storyPoints,
      process_code: feature.processCode,
    })), null, 2)}`,
    selectedFeatureIds.length
      ? `SELECTED FEATURE IDS FOR THIS ACTION:\n${JSON.stringify(selectedFeatureIds, null, 2)}`
      : 'SELECTED FEATURE IDS FOR THIS ACTION:\n[]',
  ].join('\n\n---\n\n');

  const result = await callLlmJsonWithUsage<RawDecompositionResponse>({
    model: getTierModel(opts.config.generatorConfig.decompositionModel, opts.config.tier),
    systemPrompt: buildDraftReviewSystemPrompt({
      domainContext: opts.config.domainContext,
      processTaxonomyEnabled: opts.config.processTaxonomyEnabled,
      action: opts.action,
    }),
    userMessage,
    maxTokens: Math.max(opts.config.generatorConfig.maxTokens ?? 8192, 4096),
    schemaName: 'draft_review_response',
    jsonSchema: RAW_DECOMPOSITION_RESPONSE_SCHEMA,
    reasoningEffort: 'medium',
    ...opts.providerOpts,
  });

  if (await maybeCancelled(opts.shouldCancel)) throw new GenerationCancelledError();

  const rawFeatures = result.data.features ?? [];
  if (!rawFeatures.length) {
    return {
      features: opts.features,
      reviewMeta: {
        ...(opts.currentReviewMeta ?? buildDraftReviewMetadata({
          features: opts.features,
          base: {
            reasoningSummary: '',
            unresolvedAmbiguities: [],
            openDecisions: [],
            featureNotes: opts.features.map(() => ({ possibleMergeWith: [] })),
          },
        })),
        lastAction: opts.action,
        reviewMessage: 'The draft revision kept the current structure unchanged.',
      },
      usage: result.usage,
    };
  }

  const roleGrounding: RoleGroundingContext = {
    requirement: opts.requirement,
    clarifyAnswers: opts.clarifyAnswers,
    domainRoles: opts.config.domainRoles,
  };
  const revisedFeatures = rawFeatures
    .map((feature) => normaliseFeature({ ...feature, acceptance_requirements: [] }, roleGrounding))
    .map((feature) => ({ ...feature, acceptanceRequirements: [] }));
  const descriptionRepair = await repairDraftFeatureDescriptions({
    requirement: opts.requirement,
    clarifyAnswers: opts.clarifyAnswers,
    attachmentText: opts.attachmentText,
    similarStoriesText: opts.similarStoriesText,
    wiContextText: opts.wiContextText,
    wiInsightsArtifact: opts.wiInsightsArtifact,
    features: revisedFeatures,
    config: opts.config,
    providerOpts: opts.providerOpts,
  });

  return {
    features: descriptionRepair.features,
    reviewMeta: buildDraftReviewMetadata({
      features: descriptionRepair.features,
      base: extractDraftReviewMetadata(result.data, rawFeatures),
      descriptionQuality: descriptionRepair.descriptionQuality,
      lastAction: opts.action,
      reviewMessage:
        opts.action === 'broaden'
          ? 'Draft broadened for another review.'
          : opts.action === 'tighten'
            ? 'Draft tightened for another review.'
            : opts.action === 'merge_selected'
              ? 'Selected features merged for another review.'
              : 'Selected features split for another review.',
    }),
    usage: {
      input: result.usage.input + descriptionRepair.usage.input,
      output: result.usage.output + descriptionRepair.usage.output,
    },
  };
}

// ─── Heuristic Fallback Assessment ───────────────────────────────────────────

export function assessRequirement(input: {
  requirement: string;
  attachmentText: string;
  wiContextText: string;
  similarStoriesText?: string;
  clarifyAnswers?: ClarifyAnswer[];
}): AdvisoryTriageContract {
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
      ? { min: 4, max: 6, target: 5 }
      : clarityScore <= 1
        ? { min: 7, max: 11, target: 9 }
        : { min: 5, max: 8, target: 7 };

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

  const discoveryComplexity: DiscoveryProfile['complexity'] =
    complexity === 'very_high'
      ? 'very_high'
      : complexity === 'high'
        ? 'high'
        : complexity === 'medium'
          ? 'medium'
          : 'low';
  const discoveryScope: DiscoveryProfile['scope'] =
    shape === 'epic'
      ? 'very_broad'
      : shape === 'broad'
        ? 'broad'
        : shape === 'balanced'
          ? 'moderate'
          : 'narrow';
  const discoveryAmbiguity: DiscoveryProfile['ambiguity'] =
    clarityScore <= 1 ? 'high' : clarityScore >= 4 ? 'low' : 'medium';

  return {
    reasoning: ambiguityReasons.join(' '),
    confidence: 'low',
    deliveryForecast: {
      shape,
      complexity,
      featureTarget: clampCount(featurePlan.target, 1, 15),
      featureMin: clampCount(featurePlan.min, 1, 15),
      featureMax: clampCount(featurePlan.max, 1, 15),
      arDepth: arPlan.depth,
      arTarget: clampCount(arPlan.target, 0, 8),
    },
    discoveryForecast: {
      scope: discoveryScope,
      complexity: discoveryComplexity,
      ambiguity: discoveryAmbiguity,
      recommendedInitialCount: clampCount(questionPlan.target, 0, 20),
      followupCap: clampCount(
        discoveryAmbiguity === 'high' ? 6 : discoveryAmbiguity === 'medium' ? 4 : 2,
        0,
        10,
      ),
    },
    telemetry: {
      fallbackUsed: true,
    },
  };
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
      plannedQuestionBudget: typeof root.plannedQuestionBudget === 'number' ? root.plannedQuestionBudget : undefined,
      actualQuestionsAsked: typeof root.actualQuestionsAsked === 'number' ? root.actualQuestionsAsked : undefined,
      actualAnswersReceived: typeof root.actualAnswersReceived === 'number' ? root.actualAnswersReceived : undefined,
      softQuestionBudget: typeof root.softQuestionBudget === 'number' ? root.softQuestionBudget : undefined,
      hardQuestionCap: typeof root.hardQuestionCap === 'number' ? root.hardQuestionCap : undefined,
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

function shouldRetrySchemaRepair(reasonCode: ClarifyFailureReasonCode, durationMs?: number): boolean {
  const duration = Number.isFinite(durationMs) ? Number(durationMs) : 0;
  if (duration > 0 && duration >= 12000) return false;
  return reasonCode === 'question_array_missing'
    || reasonCode === 'question_shape_invalid'
    || reasonCode === 'question_set_truncated';
}

function combinedClarifyQuestionText(question: ClarifyQuestion): string {
  return [question.question, question.details ?? ''].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

const GENERIC_DISCOVERY_QUESTION_PHRASE_RES = [
  /\bwhat\s+business\s+problem\b/i,
  /\bwhat\s+should\s+(?:this|the)\s+(?:capability|feature|system|process)\s+(?:do|achieve|deliver)\b/i,
  /\bwhat\s+(?:is|are)\s+the\s+(?:main\s+)?(?:primary\s+)?(?:goal|goals|objective)s?\s+for\s+(?:this|the)\s+(?:capability|feature|system|process)\b/i,
];

function discoveryQuestionSetLooksTooGeneric(questions: ClarifyQuestion[], requirement: string): boolean {
  if (!questions.length || !String(requirement ?? '').trim()) return false;
  return questions.every((question) => {
    const text = combinedClarifyQuestionText(question);
    return GENERIC_DISCOVERY_QUESTION_PHRASE_RES.some((re) => re.test(text));
  });
}

function determineInitialDiscoveryFailureReason(
  parsed: ParsedQuestionCandidatesResult,
  repairedDiscovery: {
    questions: ClarifyQuestion[];
    discoveryProfile: DiscoveryProfile;
    failureReasonCode: ClarifyFailureReasonCode | null;
  },
  requirement: string,
): ClarifyFailureReasonCode | null {
  if (parsed.source === 'missing') return 'question_array_missing';
  if (parsed.rawCandidateCount > 0 && parsed.stringQuestionCount === 0) return 'question_shape_invalid';
  if (parsed.stringQuestionCount > 0 && parsed.questions.length === 0 && parsed.truncatedQuestionCount > 0) return 'question_set_truncated';
  if (repairedDiscovery.failureReasonCode) return repairedDiscovery.failureReasonCode;

  const zeroQuestionDiscoveryAllowed = allowsZeroQuestionDiscovery(repairedDiscovery.discoveryProfile);
  if (!repairedDiscovery.questions.length && !zeroQuestionDiscoveryAllowed) {
    return 'question_array_empty_when_discovery_required';
  }
  if (repairedDiscovery.questions.length > 0 && discoveryQuestionSetLooksTooGeneric(repairedDiscovery.questions, requirement)) {
    return 'question_set_generic';
  }
  return null;
}

export function assessInitialDiscoveryResponse(opts: {
  rawData: unknown;
  requirement: string;
  profileFallback?: Partial<DiscoveryProfile> | null;
  domainRoles?: string[];
}): {
  questions: ClarifyQuestion[];
  discoveryProfile: DiscoveryProfile;
  failureReasonCode: ClarifyFailureReasonCode | null;
  parseShape: string;
} {
  const parsed = parseQuestionCandidatesDetailed(opts.rawData);
  const normalizedProfile = normalizeDiscoveryProfile(
    parseDiscoveryProfileCandidate(opts.rawData) ?? opts.profileFallback ?? null,
    parsed.questions.length || opts.profileFallback?.recommendedInitialCount || 0,
  );
  const repairedDiscovery = validateAndRepairInitialDiscovery(parsed.questions, normalizedProfile);
  const failureReasonCode = determineInitialDiscoveryFailureReason(parsed, repairedDiscovery, opts.requirement);

  return {
    questions: repairedDiscovery.questions,
    discoveryProfile: repairedDiscovery.discoveryProfile,
    failureReasonCode,
    parseShape: parsed.parseShape,
  };
}

function ambiguityAssessmentFromDiscoveryProfile(
  profile: DiscoveryProfile,
  generatedQuestions: number,
): ClarifyAmbiguityAssessment {
  const score =
    profile.ambiguity === 'high'
      ? 8
      : profile.ambiguity === 'medium'
        ? 5
        : 2;

  return {
    level: ambiguityLevelFromProfile(profile.ambiguity),
    score,
    reasons: profile.missingCategoryKeys.length
      ? profile.missingCategoryKeys.map((categoryKey) => `${labelForCategoryKey(categoryKey)} still needs clarification.`)
      : ['Discovery is focused on confirming the remaining implementation details.'],
    questionPlan: {
      min: generatedQuestions,
      max: generatedQuestions,
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

function summarizeAskedQuestionsForEvaluation(
  askedQuestions: Array<string | { categoryKey?: ClarifyCategoryKey; intent?: string; question: string }>,
): {
  details: Array<{ question: string; categoryKey?: ClarifyCategoryKey; intent?: string }>;
  categorySummary: string[];
} {
  const details = askedQuestions
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

  const categoryCounts = new Map<string, number>();
  details.forEach((entry) => {
    const key = entry.categoryKey ? labelForCategoryKey(entry.categoryKey) : 'Unclassified';
    categoryCounts.set(key, (categoryCounts.get(key) ?? 0) + 1);
  });

  return {
    details: details.slice(-12),
    categorySummary: [...categoryCounts.entries()].map(([label, count]) => `${label}: ${count}`),
  };
}

function summarizeAnswersForEvaluation(answers: ClarifyAnswer[]): string {
  if (!answers.length) return 'No discovery answers provided.';
  return answers
    .slice(-12)
    .map((answer, index) => {
      const categoryLabel = answer.categoryKey ? labelForCategoryKey(answer.categoryKey) : 'General';
      return [
        `${index + 1}. [${categoryLabel}${answer.intent ? ` | ${answer.intent}` : ''}] ${trimForPrompt(answer.question, 180)}`,
        `Answer: ${trimForPrompt(answer.answer, 240)}`,
      ].join('\n');
    })
    .join('\n\n');
}

// ─── Main Generation ──────────────────────────────────────────────────────────

export async function generateFeatures(opts: {
  requirement: string;
  clarifyAnswers: ClarifyAnswer[];
  attachmentText: string;
  similarStoriesText: string;
  wiContextText: string;
  wiInsightsArtifact?: WorkInstructionInsightArtifact | null;
  config: TenantConfig;
  advisoryTriage?: AdvisoryTriageContract;
  precomputedDraftFeatures?: Feature[];
  /** @deprecated No longer used — pipeline flows straight through without review pause. */
  precomputedDraftReview?: DraftReviewMetadata;
  /** @deprecated No longer used — pipeline flows straight through without review pause. */
  draftReviewDecision?: DraftReviewDecision;
  /** @deprecated No longer used — pipeline flows straight through without review pause. */
  draftReviewSelectedFeatureIds?: string[];
  allowPartialArFailure?: boolean;
  priorStageDurationsMs?: GenerationStageDurationsMs;
  /** @deprecated No longer used — pipeline flows straight through without review pause. */
  pauseForDraftReview?: boolean;
  /** @deprecated No longer used — pipeline flows straight through without review pause. */
  onPass1Complete?: (draftFeatures: Feature[], draftReview: DraftReviewMetadata, stageDurationsMs: GenerationStageDurationsMs) => Promise<void>;
  /** After Pass 1 drafts are final (incl. description repair and optional tighten); for UI progress only. */
  onPass1DraftFeatures?: (draftFeatures: Feature[]) => Promise<void>;
  onArProgress?: (snapshot: ArGenerationProgressSnapshot) => Promise<void>;
  shouldCancel?: () => Promise<boolean> | boolean;
  projectKeys?: string[];
  clarifyDiscoveryProfile?: DiscoveryProfile;
  similarStories?: SimilarStory[];
}): Promise<GenerationResult> {
  const {
    requirement,
    clarifyAnswers,
    attachmentText,
    similarStoriesText,
    wiContextText,
    wiInsightsArtifact,
    config,
    advisoryTriage,
    precomputedDraftFeatures,
    allowPartialArFailure,
    priorStageDurationsMs,
    onArProgress,
    onPass1DraftFeatures,
    shouldCancel,
    projectKeys,
    clarifyDiscoveryProfile,
    similarStories,
  } = opts;
  const { generatorConfig } = config;
  const providerOpts = {
    provider: generatorConfig.provider,
    anthropicApiKey: generatorConfig.anthropicApiKey,
    anthropicBaseUrl: generatorConfig.anthropicBaseUrl,
    geminiApiKey: generatorConfig.geminiApiKey,
    geminiBaseUrl: generatorConfig.geminiBaseUrl,
    openaiApiKey: generatorConfig.openaiApiKey,
    openaiBaseUrl: generatorConfig.openaiBaseUrl,
    fireworksApiKey: generatorConfig.fireworksApiKey,
    fireworksBaseUrl: generatorConfig.fireworksBaseUrl,
    azureOpenAIApiKey: generatorConfig.azureOpenAIApiKey,
    azureOpenAIBaseUrl: generatorConfig.azureOpenAIBaseUrl,
    azureOpenAIApiVersion: generatorConfig.azureOpenAIApiVersion,
    ollamaApiKey: generatorConfig.ollamaApiKey,
    ollamaBaseUrl: generatorConfig.ollamaBaseUrl,
    groqApiKey: generatorConfig.groqApiKey,
    groqBaseUrl: generatorConfig.groqBaseUrl,
    modelCatalogs: generatorConfig.modelCatalogs,
    piiMaskingEnabled: Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled),
  } as const;

  const stageDurationsMs: GenerationStageDurationsMs = { ...(priorStageDurationsMs ?? {}) };
  const totalStartedAt = Date.now();
  const roleGrounding: RoleGroundingContext = {
    requirement,
    clarifyAnswers,
    domainRoles: config.domainRoles,
  };

  if (await maybeCancelled(shouldCancel)) throw new GenerationCancelledError();

  const fallbackArPlan: ArPlan = {
    min: 0,
    max: 0,
    target: 0,
    depth: 'standard',
  };
  const effectiveArPlan: ArPlan = advisoryTriage
    ? triageToAssessment(advisoryTriage).arPlan
    : fallbackArPlan;

  let pass1ResultUsage = { input: 0, output: 0 };
  let pass1Features: RawFeature[];
  let pass1DraftFeatures: Feature[];
  let openDecisions: OpenDecision[] = [];
  const autoRepairedIssues: string[] = [];
  let arObligations: ArObligations = buildArObligations({
    requirement,
    clarifyAnswers,
    wiContextText,
    wiInsightsArtifact,
    openDecisions,
  });
  if (!precomputedDraftFeatures?.length) {
    const pass1StartedAt = Date.now();
    const pass1UserMessage = buildGenerationUserMessage({
      requirement,
      clarifyAnswers,
      attachmentText,
      wiContextText,
      wiInsightsArtifact,
      similarStoriesText,
      limits: PASS1_CONTEXT_LIMITS,
    });
    const pass1PromptWithFinalConstraints = [
      pass1UserMessage,
      buildGenerationFinalConstraintBlock('decomposition'),
    ].join('\n\n---\n\n');

    const unansweredDiscoveryCategories = clarifyDiscoveryProfile?.missingCategoryKeys?.length
      ? clarifyDiscoveryProfile.missingCategoryKeys.map((k) => labelForCategoryKey(k)).join('; ')
      : undefined;

    const pass1System = buildDecompositionSystemPrompt({
      domainContext: config.domainContext,
      domainRoles: config.domainRoles,
      processTaxonomy: config.processTaxonomy,
      processTaxonomyEnabled: config.processTaxonomyEnabled,
      clarifyAnswerCount: clarifyAnswers.length,
      reviewMode: true,
      backlogDepth: config.generationPreferences?.backlogDepth,
      featureProfile: config.generationPreferences?.featureProfile,
      advisoryScopeChecklist: advisoryTriage?.reasoning
        ? trimPromptText(advisoryTriage.reasoning, 2200)
        : undefined,
      unansweredDiscoveryCategories,
      advisoryDeliveryShape: advisoryTriage?.deliveryForecast?.shape,
    });

    const pass1Result = await runDecompositionPass({
      userMessage: pass1PromptWithFinalConstraints,
      systemPrompt: pass1System,
      generatorConfig,
      tier: config.tier,
      providerOpts,
    });
    const normalizedDraftFeatures = pass1Result.features
      .map((feature) => normaliseFeature({ ...feature, acceptance_requirements: [] }, roleGrounding))
      .map((feature) => ({ ...feature, acceptanceRequirements: [] }));
    const descriptionRepair = await repairDraftFeatureDescriptions({
      requirement,
      clarifyAnswers,
      attachmentText,
      similarStoriesText,
      wiContextText,
      wiInsightsArtifact,
      features: normalizedDraftFeatures,
      config,
      providerOpts,
    });

    pass1DraftFeatures = descriptionRepair.features;
    pass1Features = pass1DraftFeatures.map(toRawFeature);
    openDecisions = mergeOpenDecisions(
      [...(pass1Result.reviewMeta.openDecisions ?? []), ...synthesizeRequirementOpenDecisions(requirement, clarifyAnswers)],
      synthesizeWorkInstructionOpenDecisions(wiInsightsArtifact),
    );
    arObligations = buildArObligations({
      requirement,
      clarifyAnswers,
      wiContextText,
      wiInsightsArtifact,
      openDecisions,
    });
    pass1ResultUsage = {
      input: pass1Result.usage.input + descriptionRepair.usage.input,
      output: pass1Result.usage.output + descriptionRepair.usage.output,
    };
    let draftReview = buildDraftReviewMetadata({
      features: pass1DraftFeatures,
      base: pass1Result.reviewMeta,
      openDecisions,
      descriptionQuality: descriptionRepair.descriptionQuality,
      reviewMessage: 'Review the drafted feature structure before acceptance requirements are written.',
    });

    const overlapWarnings = draftReview.coverageFindings?.overlapWarnings ?? [];
    const duplicatedThemes = draftReview.coverageFindings?.duplicatedThemes ?? [];
    const shouldAutoTighten =
      overlapWarnings.length >= 2
      && duplicatedThemes.length === 0
      && !draftReview.openDecisions?.some((decision) => decision.blocking)
      && (
        !advisoryTriage
        || advisoryTriage.deliveryForecast.shape === 'minimal'
        || advisoryTriage.deliveryForecast.shape === 'narrow'
      );

    if (shouldAutoTighten) {
      const tightened = await reviewDraftFeatureSet({
        requirement,
        clarifyAnswers,
        attachmentText,
        similarStoriesText,
        wiContextText,
        wiInsightsArtifact,
        features: pass1DraftFeatures,
        action: 'tighten',
        currentReviewMeta: draftReview,
        config,
        providerOpts,
        shouldCancel,
      });
      pass1DraftFeatures = tightened.features;
      pass1Features = pass1DraftFeatures.map(toRawFeature);
      openDecisions = mergeOpenDecisions(
        [...(tightened.reviewMeta.openDecisions ?? []), ...synthesizeRequirementOpenDecisions(requirement, clarifyAnswers)],
        synthesizeWorkInstructionOpenDecisions(wiInsightsArtifact),
      );
      arObligations = buildArObligations({
        requirement,
        clarifyAnswers,
        wiContextText,
        wiInsightsArtifact,
        openDecisions,
      });
      draftReview = {
        ...tightened.reviewMeta,
        openDecisions,
      };
      pass1ResultUsage = {
        input: pass1ResultUsage.input + tightened.usage.input,
        output: pass1ResultUsage.output + tightened.usage.output,
      };
      autoRepairedIssues.push('Tightened overlapping draft features before acceptance requirements were written.');
    }

    // Auto-broaden removed — coverage gaps are surfaced as user-facing suggestions
    // via coverageReview.missingCoverage instead of silently inventing features.

    if (onPass1DraftFeatures) {
      await onPass1DraftFeatures(pass1DraftFeatures);
    }

    stageDurationsMs.decomposition = (stageDurationsMs.decomposition ?? 0) + (Date.now() - pass1StartedAt);
  } else {
    pass1DraftFeatures = precomputedDraftFeatures;
    pass1Features = precomputedDraftFeatures.map(toRawFeature);
  }

  let wiForPass2Ar = wiContextText;
  let similarForPass2Ar = similarStoriesText;
  let pass2BatchWiChunkCount = 0;
  let pass2ArPatternStoryKeys: string[] = [];
  let goldExampleIssueKeys: string[] = [];
  let goldExampleLabel: string | undefined;

  if (!precomputedDraftFeatures?.length && config.wiConfig.enabled && projectKeys?.length && pass1DraftFeatures.length >= 2) {
    try {
      const batchQuery = [
        requirement.slice(0, 500),
        ...pass1DraftFeatures.slice(0, 8).map((f) => trimPromptText(f.summary, 120)),
      ].join(' ');
      const k = Math.min(6, Math.max(3, config.wiConfig.topKChunks));
      const c = Math.min(8000, config.wiConfig.maxChars);
      const extra = await retrieveScopedWiContext(batchQuery, k, c, projectKeys);
      if (extra.text.trim()) {
        pass2BatchWiChunkCount = extra.chunks.length;
        const merged = `${wiContextText}\n\n---\n\nFEATURE-SCOPED WORK INSTRUCTIONS (use only when relevant to this feature):\n${extra.text}`;
        wiForPass2Ar = trimPromptText(merged, 16000);
      }
    } catch {
      // keep base WI
    }
  }

  let pass2DomainPatterns: DomainPatterns | null = null;

  if (!precomputedDraftFeatures?.length && projectKeys?.length) {
    const activeProjectKey = projectKeys[0];

    const [domainPatterns, goldPool] = await Promise.all([
      objectRead<DomainPatterns>(KEYS.domainPatterns(activeProjectKey)).catch(() => null),
      getGoldStoryPool(activeProjectKey).catch(() => null),
    ]);

    pass2DomainPatterns = domainPatterns;

    if (goldPool?.entries?.length) {
      const configuredGold = findGoldConfigForProject(activeProjectKey, config.goldExampleConfigs);
      const resolvedKeys = await resolveGoldKeysFromBacklog(activeProjectKey, config.goldExampleConfigs)
        ?? resolveGoldKeys(activeProjectKey, config.goldExampleConfigs, goldPool);
      goldExampleIssueKeys = (resolvedKeys?.length ? resolvedKeys : goldPool.entries.map((entry) => entry.key)).slice(0, 8);
      goldExampleLabel = configuredGold?.label?.trim() || undefined;
      const goldText = formatGoldStoryExemplars(goldPool, resolvedKeys ?? undefined);
      if (goldText) {
        const merged = `${similarForPass2Ar}\n\n---\n\n${goldText}`;
        similarForPass2Ar = trimPromptText(merged, 5200);
      }
    } else if (similarStories?.length && config.tier !== 'free') {
      const pat = formatArPatternLibraryFromSimilarStories(similarStories, requirement, 5);
      if (pat.text) {
        pass2ArPatternStoryKeys = pat.storyKeys;
        const merged = `${similarStoriesText}\n\n---\n\n${pat.text}`;
        similarForPass2Ar = trimPromptText(merged, 5200);
      }
    }
  } else if (!precomputedDraftFeatures?.length && similarStories?.length && config.tier !== 'free') {
    const pat = formatArPatternLibraryFromSimilarStories(similarStories, requirement, 5);
    if (pat.text) {
      pass2ArPatternStoryKeys = pat.storyKeys;
      const merged = `${similarStoriesText}\n\n---\n\n${pat.text}`;
      similarForPass2Ar = trimPromptText(merged, 5200);
    }
  }

  // ── Pass 2: Acceptance Requirements ──
  // Batch path: one LLM call for all features regardless of count.
  // Sending all features together reduces token usage by ~83% vs the old
  // per-feature parallel approach (shared context sent once, not N times)
  // and eliminates rate-limiting from concurrent Gemini calls.
  // backfillMissingAcceptanceRequirements handles any per-feature gaps.

  let pass2Usage: { input: number; output: number };
  let rawFeatures: RawFeature[];

  {
    const allFeatureIds = pass1Features
      .map((f) => f.id)
      .filter((id): id is string => Boolean(id));
    if (onArProgress) {
      await onArProgress({
        total: pass1Features.length,
        completedFeatureIds: [],
        activeFeatureIds: allFeatureIds,
        backfillFeatureIds: [],
        failedFeatureIds: [],
        phase: 'initial',
      });
    }

    const pass2System = buildArSystemPrompt({
      domainContext: config.domainContext,
      domainPatterns: pass2DomainPatterns,
      arPlan: effectiveArPlan,
    });

    const pass2ContextMessage = buildGenerationUserMessage({
      requirement,
      clarifyAnswers,
      attachmentText,
      wiContextText: wiForPass2Ar,
      wiInsightsArtifact,
      similarStoriesText: similarForPass2Ar,
      limits: PASS2_CONTEXT_LIMITS,
    });

    const pass2UserMessage = [
      pass2ContextMessage,
      `AR OBLIGATIONS:\n${JSON.stringify(arObligations, null, 2)}`,
      `FEATURES FROM PASS 1 (fill in acceptance_requirements for each):\n${JSON.stringify(pass1Features, null, 2)}`,
      buildGenerationFinalConstraintBlock('acceptance_requirements'),
    ].join('\n\n---\n\n');

    // Scale output token budget with feature count so batch calls never truncate.
    // 1200 tokens per feature covers ~4 detailed ARs; 4096 covers JSON overhead.
    const pass2MaxTokens = Math.max(
      generatorConfig.maxTokens ?? 8192,
      Math.min(24576, pass1Features.length * 1200 + 4096),
    );

    const arStartedAt = Date.now();
    const pass2Result = await callLlmJsonWithUsage<{ features: RawFeature[] }>({
      model: getTierModel(generatorConfig.arModel, config.tier),
      systemPrompt: pass2System,
      userMessage: pass2UserMessage,
      maxTokens: pass2MaxTokens,
      schemaName: 'feature_collection',
      jsonSchema: RAW_FEATURE_COLLECTION_SCHEMA,
      reasoningEffort: acceptanceRequirementsReasoningEffort(generatorConfig.pipelineProfile),
      geminiThinkingLevel: generatorConfig.pipelineProfile === 'fast' ? undefined : 'high',
      ...providerOpts,
    });
    if (await maybeCancelled(shouldCancel)) throw new GenerationCancelledError();
    stageDurationsMs.acceptanceRequirements = (stageDurationsMs.acceptanceRequirements ?? 0) + (Date.now() - arStartedAt);

    rawFeatures = pass2Result.data.features?.length
      ? mergeFeatures(pass1Features, pass2Result.data.features)
      : pass1Features;
    let backfillUsage = { input: 0, output: 0 };
    let retryUsage = { input: 0, output: 0 };
    if (hasAnyIncompleteAcceptanceRequirements(rawFeatures)) {
      const backfillStartedAt = Date.now();
      const backfillResult = await backfillMissingAcceptanceRequirements({
        features: rawFeatures,
        requirement,
        clarifyAnswers,
        attachmentText,
        wiContextText: wiForPass2Ar,
        similarStoriesText: similarForPass2Ar,
        wiInsightsArtifact,
        arObligations,
        domainContext: config.domainContext,
        domainPatterns: pass2DomainPatterns,
        arPlan: effectiveArPlan,
        generatorConfig,
        tier: config.tier,
        providerOpts,
        onArProgress,
      });
      if (await maybeCancelled(shouldCancel)) throw new GenerationCancelledError();
      stageDurationsMs.backfill = (stageDurationsMs.backfill ?? 0) + (Date.now() - backfillStartedAt);
      rawFeatures = backfillResult.features;
      backfillUsage = backfillResult.usage;
    }
    if (hasAnyIncompleteAcceptanceRequirements(rawFeatures)) {
      const targetedRetryStartedAt = Date.now();
      const targetedRetryResult = await backfillMissingAcceptanceRequirements({
        features: rawFeatures,
        requirement,
        clarifyAnswers,
        attachmentText,
        wiContextText: wiForPass2Ar,
        similarStoriesText: similarForPass2Ar,
        wiInsightsArtifact,
        arObligations,
        domainContext: config.domainContext,
        domainPatterns: pass2DomainPatterns,
        arPlan: effectiveArPlan,
        generatorConfig,
        tier: config.tier,
        providerOpts,
        onArProgress,
      });
      if (await maybeCancelled(shouldCancel)) throw new GenerationCancelledError();
      stageDurationsMs.backfill = (stageDurationsMs.backfill ?? 0) + (Date.now() - targetedRetryStartedAt);
      rawFeatures = targetedRetryResult.features;
      retryUsage = targetedRetryResult.usage;
    }
    pass2Usage = {
      input: pass2Result.usage.input + backfillUsage.input + retryUsage.input,
      output: pass2Result.usage.output + backfillUsage.output + retryUsage.output,
    };
    const completedBatchFeatureIds = listCompleteFeatureIds(rawFeatures);
    if (onArProgress) {
      await onArProgress({
        total: pass1Features.length,
        completedFeatureIds: completedBatchFeatureIds,
        activeFeatureIds: [],
        backfillFeatureIds: [],
        failedFeatureIds: allFeatureIds.filter((id) => !completedBatchFeatureIds.includes(id)),
        phase: 'initial',
      });
    }
  }

  let features = rawFeatures.map((feature) => normaliseFeature(feature, roleGrounding));
  const failedFeatureIndexes = findFeaturesMissingCompleteAcceptanceRequirements(features);
  const failedFeatureIds = new Set(
    failedFeatureIndexes
      .map((index) => features[index]?.id)
      .filter((id): id is string => Boolean(id)),
  );

  if (failedFeatureIndexes.length > 0) {
    const failedCount = failedFeatureIndexes.length;
    const successfulCount = features.length - failedCount;
    if (successfulCount === 0 && !allowPartialArFailure) {
      throw new AcceptanceRequirementsGenerationError(
        `Acceptance requirements could not be completed for ${failedCount} feature${failedCount === 1 ? '' : 's'}. Retry generation to finish the missing acceptance requirements.`,
        features,
        failedFeatureIndexes,
      );
    }
    features = annotateFailedAcceptanceRequirementFeatures(features, failedFeatureIds) as Feature[];
  }
  const violations = validateFeatures(features, config);
  const coverageStartedAt = Date.now();
  const coverageReview = await checkCoverageAdvice({
    requirement,
    clarifyAnswers,
    attachmentText,
    similarStoriesText,
    wiContextText,
    wiInsightsArtifact,
    features,
    openDecisions,
    config,
  });
  stageDurationsMs.coverageCheck = (stageDurationsMs.coverageCheck ?? 0) + (Date.now() - coverageStartedAt);
  const wiCoverage = assessWiCoverage({
    features,
    openDecisions,
    wiInsightsArtifact,
  });
  coverageReview.advice.missingCoverage = uniqueNonEmptyStrings([
    ...coverageReview.advice.missingCoverage,
    ...wiCoverage.missing,
  ]);
  const coverageFindings = buildCoverageFindings(features, openDecisions);
  coverageFindings.missingUseCases = uniqueNonEmptyStrings([
    ...coverageFindings.missingUseCases,
    ...coverageReview.advice.missingCoverage,
  ]);
  const remainingBlockingIssues = collectRemainingBlockingIssues(violations, openDecisions, coverageFindings);
  const requiresUserDecision = remainingBlockingIssues.some((issue) =>
    openDecisions.some((decision) => decision.title === issue)
    || coverageFindings.overlapWarnings.includes(issue)
    || issue.startsWith('Duplicated theme:'),
  );

  const tokenUsage: TokenUsageSummary = {
    input: pass1ResultUsage.input + pass2Usage.input + coverageReview.usage.input,
    output: pass1ResultUsage.output + pass2Usage.output + coverageReview.usage.output,
    total: pass1ResultUsage.input + pass1ResultUsage.output + pass2Usage.input + pass2Usage.output + coverageReview.usage.input + coverageReview.usage.output,
    byStage: {
      decomposition: toStageUsage(pass1ResultUsage),
      acceptanceRequirements: toStageUsage(pass2Usage),
      ...(coverageReview.usage.input || coverageReview.usage.output
        ? { coverageCheck: toStageUsage(coverageReview.usage) }
        : {}),
    },
  };
  stageDurationsMs.total = (priorStageDurationsMs?.total ?? 0) + (Date.now() - totalStartedAt);

  return {
    features,
    violations,
    similarStories: [],   // filled in by the caller after this returns
    sessionId: uuidv4(),
    generationContext: {
      projectKey: '',
      domainRolesUsed: [],
      pass2BatchWiChunkCount: pass2BatchWiChunkCount || undefined,
      pass2ArPatternStoryKeys: pass2ArPatternStoryKeys.length ? pass2ArPatternStoryKeys : undefined,
      goldExampleIssueKeys: goldExampleIssueKeys.length ? goldExampleIssueKeys : undefined,
      goldExampleLabel,
      openDecisions,
      roleCoverage: buildRoleCoverage(features),
      coverageFindings,
      coverageReview: coverageReview.advice,
      wiCoverageUsedByFeature: wiCoverage.usedByFeature,
      wiCoverageMisses: wiCoverage.missing,
      autoRepairedIssues: uniqueNonEmptyStrings(autoRepairedIssues),
      remainingBlockingIssues,
      requiresUserDecision,
      failedFeatureIds: [...failedFeatureIds],
      partialSuccess: failedFeatureIds.size > 0,
      partialSuccessMessage: failedFeatureIds.size > 0
        ? `Acceptance requirements could not be completed for ${failedFeatureIds.size} feature${failedFeatureIds.size === 1 ? '' : 's'}. Retry the highlighted feature${failedFeatureIds.size === 1 ? '' : 's'} from the canvas.`
        : undefined,
      stageDurationsMs,
    },
    tokenUsage,
  };
}

// Legacy discovery / sufficiency entrypoints were removed in favor of
// `story-assistant-default.ts` and the queue-backed story assistant pipeline.

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

function toAcceptanceRequirementRef(featureId: string, arIndex: number): string {
  return `${featureId}#${arIndex}`;
}

function sanitizeStringArray(values: unknown[]): string[] {
  return values
    .map((value) => String(value ?? '').trim())
    .filter((value) => value.length > 0);
}

function normaliseStructuralProposalFeature(
  raw: RawStructuralFeatureProposal,
  roleGrounding?: RoleGroundingContext,
): StructuralFeatureProposal {
  const feature = normaliseFeature(raw, roleGrounding);
  const sourceFeatureIds = sanitizeStringArray(Array.isArray(raw.source_feature_ids) ? raw.source_feature_ids : []);
  const sourceAcceptanceRequirementRefs = sanitizeStringArray(
    Array.isArray(raw.source_acceptance_requirement_refs)
      ? raw.source_acceptance_requirement_refs
      : Array.isArray(raw.sourceAcceptanceRequirementRefs)
        ? raw.sourceAcceptanceRequirementRefs
        : [],
  );
  const primarySourceFeatureId = String(raw.primary_source_feature_id ?? raw.primarySourceFeatureId ?? '').trim() || undefined;
  const rationale = String(raw.rationale ?? '').trim() || undefined;

  return {
    ...feature,
    sourceFeatureIds,
    sourceAcceptanceRequirementRefs,
    primarySourceFeatureId,
    rationale,
  };
}

function normaliseStructuralRestructureResponse(
  raw: RawStructuralRestructureResponse,
  roleGrounding?: RoleGroundingContext,
): StructuralRestructureProposal {
  const proposedRaw = Array.isArray(raw.proposed_features)
    ? raw.proposed_features
    : Array.isArray(raw.proposedFeatures)
      ? raw.proposedFeatures
      : [];
  const removedFeatureIds = sanitizeStringArray(
    Array.isArray(raw.removed_feature_ids)
      ? raw.removed_feature_ids
      : Array.isArray(raw.removedFeatureIds)
        ? raw.removedFeatureIds
        : [],
  );
  const removedAcceptanceRequirementRefs = sanitizeStringArray(
    Array.isArray(raw.removed_acceptance_requirement_refs)
      ? raw.removed_acceptance_requirement_refs
      : Array.isArray(raw.removedAcceptanceRequirementRefs)
        ? raw.removedAcceptanceRequirementRefs
        : [],
  );

  return {
    scope: 'all',
    selectedFeatureIds: [],
    proposedFeatures: proposedRaw.map((feature) => normaliseStructuralProposalFeature(feature, roleGrounding)),
    removedFeatureIds,
    removedAcceptanceRequirementRefs,
  };
}

export function validateStructuralRestructureProposal(input: {
  scope: RestructureScope;
  selectedFeatures: Feature[];
  proposal: StructuralRestructureProposal;
}): { valid: true } | { valid: false; reason: string } {
  const selectedFeatureIds = new Set(input.selectedFeatures.map((feature) => feature.id));
  const selectedRefs = new Set(
    input.selectedFeatures.flatMap((feature) =>
      (feature.acceptanceRequirements || []).map((_, index) => toAcceptanceRequirementRef(feature.id, index))),
  );

  const proposalSelectedIds = new Set(input.proposal.selectedFeatureIds);
  if (proposalSelectedIds.size !== selectedFeatureIds.size || [...selectedFeatureIds].some((id) => !proposalSelectedIds.has(id))) {
    return { valid: false, reason: 'Proposal selected feature ids do not match the requested restructure scope.' };
  }

  const coveredFeatureIds = new Set<string>();
  const coveredRefs = new Set<string>();

  for (const proposedFeature of input.proposal.proposedFeatures) {
    if (!proposedFeature.acceptanceRequirements?.length) {
      return { valid: false, reason: `Proposed feature "${proposedFeature.summary}" is missing acceptance requirements.` };
    }

    if (proposedFeature.sourceFeatureIds.length === 0 && proposedFeature.primarySourceFeatureId) {
      return { valid: false, reason: `Proposed feature "${proposedFeature.summary}" declares a primary source without source_feature_ids.` };
    }

    for (const sourceFeatureId of proposedFeature.sourceFeatureIds) {
      if (!selectedFeatureIds.has(sourceFeatureId)) {
        return { valid: false, reason: `Proposed feature "${proposedFeature.summary}" references out-of-scope source feature "${sourceFeatureId}".` };
      }
      coveredFeatureIds.add(sourceFeatureId);
    }

    if (
      proposedFeature.primarySourceFeatureId
      && !proposedFeature.sourceFeatureIds.includes(proposedFeature.primarySourceFeatureId)
    ) {
      return { valid: false, reason: `Proposed feature "${proposedFeature.summary}" has a primary source that is not in source_feature_ids.` };
    }

    for (const ref of proposedFeature.sourceAcceptanceRequirementRefs) {
      if (!selectedRefs.has(ref)) {
        return { valid: false, reason: `Proposed feature "${proposedFeature.summary}" references unknown or out-of-scope AR ref "${ref}".` };
      }
      const sourceFeatureId = ref.split('#')[0] ?? '';
      if (!proposedFeature.sourceFeatureIds.includes(sourceFeatureId)) {
        return { valid: false, reason: `Proposed feature "${proposedFeature.summary}" owns AR ref "${ref}" without owning its source feature.` };
      }
      if (coveredRefs.has(ref)) {
        return { valid: false, reason: `Acceptance requirement ref "${ref}" is assigned more than once.` };
      }
      coveredRefs.add(ref);
    }
  }

  for (const featureId of input.proposal.removedFeatureIds) {
    if (!selectedFeatureIds.has(featureId)) {
      return { valid: false, reason: `Removed feature id "${featureId}" is outside the restructure scope.` };
    }
    coveredFeatureIds.add(featureId);
  }

  for (const ref of input.proposal.removedAcceptanceRequirementRefs) {
    if (!selectedRefs.has(ref)) {
      return { valid: false, reason: `Removed acceptance requirement ref "${ref}" is outside the restructure scope.` };
    }
    if (coveredRefs.has(ref)) {
      return { valid: false, reason: `Acceptance requirement ref "${ref}" is both preserved and removed.` };
    }
    coveredRefs.add(ref);
  }

  for (const featureId of selectedFeatureIds) {
    if (!coveredFeatureIds.has(featureId)) {
      return { valid: false, reason: `Source feature "${featureId}" is not accounted for by the restructure proposal.` };
    }
  }

  for (const ref of selectedRefs) {
    if (!coveredRefs.has(ref)) {
      return { valid: false, reason: `Acceptance requirement ref "${ref}" is not accounted for by the restructure proposal.` };
    }
  }

  return { valid: true };
}

export async function restructureFeatures(opts: {
  requirement: string;
  features: Feature[];
  feedback: string;
  selectedFeatureIds?: string[];
  scope: RestructureScope;
  config: TenantConfig;
}): Promise<{ proposal: StructuralRestructureProposal; tokenUsage: TokenUsageSummary }> {
  const { requirement, features, feedback, selectedFeatureIds = [], scope, config } = opts;
  const targetedFeatures = scope === 'selected'
    ? features.filter((feature) => selectedFeatureIds.includes(feature.id))
    : features;

  if (!targetedFeatures.length) {
    throw new Error('Select at least one feature to restructure.');
  }

  const system = buildRestructureSystemPrompt({
    domainContext: config.domainContext,
    domainRoles: config.domainRoles,
    processTaxonomy: config.processTaxonomy,
    processTaxonomyEnabled: config.processTaxonomyEnabled,
    scope,
  });

  const userMessage = [
    `REQUIREMENT: ${requirement}`,
    `FEEDBACK: ${feedback}`,
    `SCOPE: ${scope === 'selected' ? `selected features only (${targetedFeatures.length})` : `entire canvas (${targetedFeatures.length} features)`}`,
    `TARGET FEATURES:\n${JSON.stringify(targetedFeatures.map((feature) => ({
      ...feature,
      acceptanceRequirementRefs: (feature.acceptanceRequirements || []).map((ar, index) => ({
        ref: toAcceptanceRequirementRef(feature.id, index),
        ...ar,
      })),
    })), null, 2)}`,
  ].join('\n\n');

  const result = await callLlmJsonWithUsage<RawStructuralRestructureResponse>({
    model: getTierModel(config.generatorConfig.refineModel, config.tier),
    systemPrompt: system,
    userMessage,
    maxTokens: config.generatorConfig.maxTokens,
    schemaName: 'structural_restructure_response',
    jsonSchema: RAW_STRUCTURAL_RESTRUCTURE_RESPONSE_SCHEMA,
    reasoningEffort: 'high',
    ...buildLlmProviderOpts(config),
  });

  const roleGrounding: RoleGroundingContext = {
    requirement,
    domainRoles: config.domainRoles,
  };
  const proposal = normaliseStructuralRestructureResponse(result.data, roleGrounding);
  proposal.scope = scope;
  proposal.selectedFeatureIds = targetedFeatures.map((feature) => feature.id);

  const validation = validateStructuralRestructureProposal({
    scope,
    selectedFeatures: targetedFeatures,
    proposal,
  });
  if (!validation.valid) {
    throw new Error(validation.reason);
  }

  return {
    proposal,
    tokenUsage: {
      input: result.usage.input,
      output: result.usage.output,
      total: result.usage.input + result.usage.output,
      byStage: { restructure: toStageUsage(result.usage) },
    },
  };
}

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

  if (feedbackRequestsStructuralRefinement(feedback)) {
    throw new Error('structural_refine_unsupported');
  }

  return refineFeaturesIndividually({
    requirement,
    features,
    feedback,
    config,
    onProgress,
  });
}

export async function addFeaturesFromFeedback(opts: {
  requirement: string;
  features: Feature[];
  feedback: string;
  config: TenantConfig;
  selectedFeatureIds?: string[];
}): Promise<{ features: Feature[]; tokenUsage: TokenUsageSummary }> {
  const { requirement, features, feedback, config, selectedFeatureIds = [] } = opts;
  const system = buildAddFeatureSystemPrompt({
    domainContext: config.domainContext,
    domainRoles: config.domainRoles,
    processTaxonomy: config.processTaxonomy,
    processTaxonomyEnabled: config.processTaxonomyEnabled,
  });
  const roleGrounding: RoleGroundingContext = {
    requirement,
    domainRoles: config.domainRoles,
  };
  const targetedFeatures = selectedFeatureIds.length
    ? features.filter((feature) => selectedFeatureIds.includes(feature.id))
    : features;
  const userMessage = [
    `REQUIREMENT: ${requirement}`,
    `USER INSTRUCTION: ${feedback}`,
    `CURRENT FEATURE SET (read-only context):\n${JSON.stringify(features, null, 2)}`,
    `TARGETED FEATURE CONTEXT:\n${JSON.stringify(targetedFeatures, null, 2)}`,
  ].join('\n\n');

  const result = await callLlmJsonWithUsage<{ features: RawFeature[] }>({
    model: getTierModel(config.generatorConfig.refineModel, config.tier),
    systemPrompt: system,
    userMessage,
    maxTokens: Math.min(config.generatorConfig.maxTokens, 4096),
    schemaName: 'feature_collection',
    jsonSchema: RAW_FEATURE_COLLECTION_SCHEMA,
    reasoningEffort: 'medium',
    ...buildLlmProviderOpts(config),
  });

  const existingSummaries = new Set(features.map((feature) => feature.summary.trim().toLowerCase()).filter(Boolean));
  const addedFeatures = (result.data.features ?? [])
    .map((raw) => applyFeatureOutputGuardrails(normaliseFeature(raw, roleGrounding)))
    .filter((feature) => feature.acceptanceRequirements.length > 0)
    .filter((feature) => {
      const summaryKey = feature.summary.trim().toLowerCase();
      if (!summaryKey || existingSummaries.has(summaryKey)) return false;
      existingSummaries.add(summaryKey);
      return true;
    });

  return {
    features: addedFeatures,
    tokenUsage: {
      input: result.usage.input,
      output: result.usage.output,
      total: result.usage.input + result.usage.output,
      byStage: { add_feature: toStageUsage(result.usage) },
    },
  };
}

function acceptanceRequirementSignature(ar: AcceptanceRequirement): string {
  return [
    ar.given,
    ar.when,
    ar.then,
  ].map((value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()).join(' | ');
}

function appendUniqueAcceptanceRequirements(
  existing: AcceptanceRequirement[],
  proposed: AcceptanceRequirement[],
): AcceptanceRequirement[] {
  const signatures = new Set(existing.map(acceptanceRequirementSignature));
  const appended = proposed.filter((ar) => {
    if (!ar.given?.trim() || !ar.when?.trim() || !ar.then?.trim()) return false;
    const signature = acceptanceRequirementSignature(ar);
    if (!signature || signatures.has(signature)) return false;
    signatures.add(signature);
    return true;
  });
  return [...existing, ...appended];
}

async function addRequirementsToFeature(opts: {
  requirement: string;
  feature: Feature;
  feedback: string;
  config: TenantConfig;
}): Promise<{ feature: Feature; tokenUsage: TokenUsageSummary }> {
  const { requirement, feature, feedback, config } = opts;
  const featurePayload = {
    summary: feature.summary,
    description: feature.description,
    acceptance_requirements: feature.acceptanceRequirements,
    suggested_story_points: feature.storyPoints,
    process_code: feature.processCode,
  };

  const system = buildAddRequirementsSystemPrompt({
    domainContext: config.domainContext,
    processTaxonomy: config.processTaxonomy,
    processTaxonomyEnabled: config.processTaxonomyEnabled,
  });

  const userMessage = [
    requirement ? `ORIGINAL REQUIREMENT:\n${requirement}` : '',
    `FEATURE:\n${JSON.stringify(featurePayload, null, 2)}`,
    `USER INSTRUCTION: ${feedback}`,
  ].filter(Boolean).join('\n\n');

  const result = await callLlmJsonWithUsage<{ features: RawFeature[] }>({
    model: getTierModel(config.generatorConfig.refineModel, config.tier),
    systemPrompt: system,
    userMessage,
    maxTokens: 3072,
    schemaName: 'feature_collection',
    jsonSchema: RAW_FEATURE_COLLECTION_SCHEMA,
    reasoningEffort: 'low',
    ...buildLlmProviderOpts(config),
  });

  const rawFeature = result.data.features?.[0];
  const roleGrounding: RoleGroundingContext = {
    requirement,
    domainRoles: config.domainRoles,
  };
  const candidate = rawFeature
    ? applyFeatureOutputGuardrails(normaliseFeature(rawFeature, roleGrounding))
    : feature;

  return {
    feature: {
      ...feature,
      acceptanceRequirements: appendUniqueAcceptanceRequirements(
        feature.acceptanceRequirements,
        candidate.acceptanceRequirements,
      ),
    },
    tokenUsage: {
      input: result.usage.input,
      output: result.usage.output,
      total: result.usage.input + result.usage.output,
      byStage: { add_requirements_single: toStageUsage(result.usage) },
    },
  };
}

export async function addRequirementsFromFeedback(opts: {
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

  const updatedFeatures: Feature[] = [];
  let totalInput = 0;
  let totalOutput = 0;
  const byStage: Record<string, { input: number; output: number; total: number }> = {};
  const results = await runOrderedConcurrentTasks({
    tasks: features.map((feature) => () => addRequirementsToFeature({
      requirement,
      feature,
      feedback,
      config,
    })),
    concurrency: 3,
    onProgress: (completed, total) => onProgress?.(`Extended acceptance coverage for ${completed} of ${total} features…`),
  });

  results.forEach((result, index) => {
    updatedFeatures.push(result.feature);
    totalInput += result.tokenUsage.input;
    totalOutput += result.tokenUsage.output;
    byStage[`add_requirements_${index + 1}`] = {
      input: result.tokenUsage.input,
      output: result.tokenUsage.output,
      total: result.tokenUsage.total,
    };
  });

  return {
    features: updatedFeatures,
    tokenUsage: {
      input: totalInput,
      output: totalOutput,
      total: totalInput + totalOutput,
      byStage,
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

  const featurePayload = {
    summary: feature.summary,
    description: feature.description,
    acceptance_requirements: feature.acceptanceRequirements,
    suggested_story_points: feature.storyPoints,
    process_code: feature.processCode,
  };

  const system = buildSingleFeatureRefineSystemPrompt({
    domainContext: config.domainContext,
    processTaxonomy: config.processTaxonomy,
    processTaxonomyEnabled: config.processTaxonomyEnabled,
    allowStructuralChanges: allowSplit,
  });

  const userMessage = [
    requirement ? `ORIGINAL REQUIREMENT:\n${requirement}` : '',
    `FEATURE:\n${JSON.stringify(featurePayload, null, 2)}`,
    `FEEDBACK: ${feedback}`,
  ].filter(Boolean).join('\n\n');

  const result = await callLlmJsonWithUsage<{ features: RawFeature[] }>({
    model: getTierModel(config.generatorConfig.refineModel, config.tier),
    systemPrompt: system,
    userMessage,
    maxTokens: allowSplit ? 4096 : 3072,
    schemaName: 'feature_collection',
    jsonSchema: RAW_FEATURE_COLLECTION_SCHEMA,
    reasoningEffort: allowSplit ? 'medium' : 'low',
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
      return applyFeatureOutputGuardrails(stableResult);
    }
    // Additional split features get fresh ids (already assigned by normaliseFeature).
    return applyFeatureOutputGuardrails(candidate);
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

export async function runOrderedConcurrentTasks<T>(opts: {
  tasks: Array<() => Promise<T>>;
  concurrency: number;
  onProgress?: (completed: number, total: number) => Promise<void> | void;
}): Promise<T[]> {
  const { tasks, concurrency, onProgress } = opts;
  if (!tasks.length) return [];

  const limit = Math.max(1, Math.min(concurrency, tasks.length));
  const results = new Array<T>(tasks.length);
  let nextIndex = 0;
  let completed = 0;

  const worker = async () => {
    while (nextIndex < tasks.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      results[currentIndex] = await tasks[currentIndex]();
      completed += 1;
      await onProgress?.(completed, tasks.length);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
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
  const results = await runOrderedConcurrentTasks({
    tasks: features.map((feature) => () => refineSingleFeature({
      requirement,
      feature,
      feedback,
      config,
      allowSplit: false,
    })),
    concurrency: 3,
    onProgress: (completed, total) => onProgress?.(`Refined ${completed} of ${total} features…`),
  });

  results.forEach((result, index) => {
    refinedFeatures.push(result.features[0] ?? features[index]);
    totalInput += result.tokenUsage.input;
    totalOutput += result.tokenUsage.output;
    byStage[`refine_${index + 1}`] = {
      input: result.tokenUsage.input,
      output: result.tokenUsage.output,
      total: result.tokenUsage.total,
    };
  });

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
    schemaName: 'refine_feedback_sufficiency',
    jsonSchema: REFINE_FEEDBACK_SUFFICIENCY_SCHEMA,
    ...buildLlmProviderOpts(opts.config),
  });

  return result;
}

async function checkCoverageAdvice(opts: {
  requirement: string;
  clarifyAnswers: ClarifyAnswer[];
  attachmentText: string;
  similarStoriesText: string;
  wiContextText: string;
  wiInsightsArtifact?: WorkInstructionInsightArtifact | null;
  features: Feature[];
  openDecisions?: OpenDecision[];
  config: TenantConfig;
}): Promise<{ advice: CoverageReviewAdvice; usage: { input: number; output: number } }> {
  const userMessage = [
    buildGenerationUserMessage({
      requirement: opts.requirement,
      clarifyAnswers: opts.clarifyAnswers,
      attachmentText: opts.attachmentText,
      wiContextText: opts.wiContextText,
      wiInsightsArtifact: opts.wiInsightsArtifact,
      similarStoriesText: opts.similarStoriesText,
      limits: PASS2_CONTEXT_LIMITS,
    }),
    `CURRENT FEATURES:\n${JSON.stringify(opts.features, null, 2)}`,
    `OPEN DECISIONS:\n${JSON.stringify(opts.openDecisions ?? [], null, 2)}`,
  ].join('\n\n---\n\n');

  const result = await callLlmJsonWithUsage<RawCoverageReviewResponse>({
    model: getTierModel(opts.config.generatorConfig.evaluateModel, opts.config.tier),
    systemPrompt: buildCoverageCheckSystemPrompt({ domainContext: opts.config.domainContext }),
    userMessage,
    maxTokens: 2048,
    schemaName: 'coverage_review_response',
    jsonSchema: RAW_COVERAGE_REVIEW_RESPONSE_SCHEMA,
    reasoningEffort: 'medium',
    ...buildLlmProviderOpts(opts.config),
  });

  return {
    advice: {
      sufficient: Boolean(result.data.sufficient),
      missingCoverage: sanitizeStringArray(Array.isArray(result.data.missingCoverage) ? result.data.missingCoverage : []),
      reasoning: sanitizeArClause(result.data.reasoning ?? ''),
    },
    usage: result.usage,
  };
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

interface RoleGroundingContext {
  requirement?: string;
  clarifyAnswers?: ClarifyAnswer[];
  domainRoles?: string[];
}

const TECHNICAL_FEATURE_TERMS = [
  'integration', 'ingest', 'ingestion', 'parse', 'parsing', 'sync', 'synchronization', 'transmission',
  'payload', 'logfile', 'mapping', 'transform', 'monitor integration', 'integration status', 'data flow',
  'external source', 'external system', 'event processing', 'processing pipeline', 'automated processing',
  'event notification', 'polling mechanism', 'queue', 'batch processing',
];
const CROSS_CUTTING_FEATURE_TERMS = [
  'audit', 'audit trail', 'permission', 'permissions', 'access policy', 'role-based access',
  'traceability', 'compliance', 'retention', 'cannot be deleted', 'must not be deleted',
  'non-deletion', 'immutable history', 'historical integrity',
];

function countMatchedPhrases(text: string, terms: string[]): number {
  const haystack = String(text ?? '').toLowerCase();
  return terms.reduce((count, term) => count + (haystack.includes(term.toLowerCase()) ? 1 : 0), 0);
}

function looksLikeTechnicalActor(role: string): boolean {
  const normalized = role.trim().toLowerCase();
  if (!normalized) return false;
  return /\b(integration|service|system|platform|pipeline|processor)\b/.test(normalized)
    && !/\b(field service|technical support|support specialist|service quality|administrator)\b/.test(normalized);
}

function normalizeFeatureClass(value: unknown): FeatureClass | undefined {
  const normalized = String(value ?? '').trim();
  return VALID_FEATURE_CLASSES.has(normalized as FeatureClass) ? normalized as FeatureClass : undefined;
}

function normalizeFeatureConfidence(value: unknown): FeatureConfidence | undefined {
  const normalized = String(value ?? '').trim();
  return VALID_FEATURE_CONFIDENCE.has(normalized as FeatureConfidence) ? normalized as FeatureConfidence : undefined;
}

function normalizeFeatureActorSource(value: unknown): FeatureActorSource | undefined {
  const normalized = String(value ?? '').trim();
  return VALID_ACTOR_SOURCES.has(normalized as FeatureActorSource) ? normalized as FeatureActorSource : undefined;
}

function determineFeatureClass(raw: RawFeature): FeatureClass {
  const explicit = normalizeFeatureClass(raw.feature_class ?? raw.featureClass);
  const content = `${raw.summary ?? ''} ${raw.description ?? ''}`;
  const role = extractRoleFromDescription(String(raw.description ?? '')) ?? '';
  const strongCrossCuttingSignal =
    countMatchedPhrases(content, CROSS_CUTTING_FEATURE_TERMS) >= 1
    || /\b(audit trail|cannot be deleted|must not be deleted|retain(?:ed|ing)? history|historical integrity)\b/i.test(content);
  const strongTechnicalSignal =
    looksLikeTechnicalActor(role)
    || countMatchedPhrases(content, TECHNICAL_FEATURE_TERMS) >= 2
    || /\b(parse|extract|ingest|monitor|poll|match|map|transform|payload|external source|external system)\b/i.test(content);

  if (explicit === 'cross_cutting_rule') return explicit;
  if (strongCrossCuttingSignal) return 'cross_cutting_rule';
  if (explicit === 'technical_enabler') return explicit;
  if (strongTechnicalSignal) return 'technical_enabler';
  return explicit ?? 'business_capability';
}

function determineActorSource(description: string, roleGrounding?: RoleGroundingContext, raw?: RawFeature): FeatureActorSource {
  const explicit = normalizeFeatureActorSource(raw?.actor_source ?? raw?.actorSource);
  if (explicit) return explicit;
  const role = extractRoleFromDescription(description)?.toLowerCase();
  if (!role || role === 'authorized user') return 'fallback';
  const requirement = String(roleGrounding?.requirement ?? '').toLowerCase();
  if (requirement.includes(role)) return 'prompt';
  const clarifyTexts = (roleGrounding?.clarifyAnswers ?? [])
    .flatMap((answer) => [answer.question, answer.answer, answer.customAnswer, ...(answer.selectedSuggestions ?? [])])
    .join(' ')
    .toLowerCase();
  if (clarifyTexts.includes(role)) return 'clarify';
  const workspaceRoles = (roleGrounding?.domainRoles ?? []).map((value) => String(value ?? '').trim().toLowerCase());
  if (workspaceRoles.includes(role)) return 'workspace_role';
  return 'fallback';
}

function determineFeatureConfidence(feature: {
  description: string;
  actorSource?: FeatureActorSource;
  raw?: RawFeature;
}): FeatureConfidence {
  const explicit = normalizeFeatureConfidence(feature.raw?.confidence);
  if (explicit) return explicit;
  if ((feature.actorSource ?? 'fallback') === 'fallback') return 'assumption_applied';
  if (/authorized user/i.test(feature.description)) return 'assumption_applied';
  return 'confirmed';
}

function buildRoleCoverage(features: Feature[]): RoleCoverageItem[] {
  const seen = new Set<string>();
  return features
    .map((feature) => {
      const role = extractRoleFromDescription(feature.description);
      if (!role) return null;
      const key = role.toLowerCase();
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        role,
        source: feature.actorSource ?? 'fallback',
        status: feature.confidence === 'assumption_applied' || feature.actorSource === 'fallback'
          ? 'assumed'
          : 'covered',
      } as RoleCoverageItem;
    })
    .filter((item): item is RoleCoverageItem => Boolean(item));
}

function buildCoverageFindings(features: Feature[], openDecisions: OpenDecision[] = []): CoverageFindings {
  const overlaps = detectFeatureOverlaps(features);
  const overlapWarnings = overlaps.map((overlap) => `${overlap.leftSummary} overlaps with ${overlap.rightSummary}`);
  const duplicatedThemes = features
    .filter((feature, index) => features.findIndex((candidate) => candidate.summary.trim().toLowerCase() === feature.summary.trim().toLowerCase()) !== index)
    .map((feature) => feature.summary);
  const missingUseCases = openDecisions
    .filter((decision) => decision.blocking)
    .map((decision) => decision.title);
  return {
    missingUseCases: uniqueNonEmptyStrings(missingUseCases),
    overlapWarnings: uniqueNonEmptyStrings(overlapWarnings),
    duplicatedThemes: uniqueNonEmptyStrings(duplicatedThemes),
  };
}

function getWiCoverageSignals(wiInsightsArtifact?: WorkInstructionInsightArtifact | null): string[] {
  if (!wiInsightsArtifact) return [];
  return uniqueNonEmptyStrings([
    ...wiInsightsArtifact.mustCoverBehaviors.map((item) => item.text),
    ...wiInsightsArtifact.sequencingRules.map((item) => item.text),
    ...wiInsightsArtifact.splitVsSingleCaseRules.map((item) => item.text),
    ...wiInsightsArtifact.stateTransitions.map((item) => item.text),
    ...wiInsightsArtifact.exceptions.map((item) => item.text),
  ]).slice(0, 18);
}

function textMatchesWiBehavior(text: string, behavior: string): boolean {
  const normalizedText = String(text ?? '').toLowerCase();
  const normalizedBehavior = String(behavior ?? '').toLowerCase();
  if (!normalizedText || !normalizedBehavior) return false;
  if (normalizedText.includes(normalizedBehavior) || normalizedBehavior.includes(normalizedText)) return true;

  const textTokens = tokenizeDecisionText(normalizedText);
  const behaviorTokens = tokenizeDecisionText(normalizedBehavior);
  if (!textTokens.size || !behaviorTokens.size) return false;

  let overlap = 0;
  behaviorTokens.forEach((token) => {
    if (textTokens.has(token)) overlap += 1;
  });

  const minimumOverlap = behaviorTokens.size >= 5 ? 3 : 2;
  return overlap >= minimumOverlap;
}

function assessWiCoverage(input: {
  features: Feature[];
  openDecisions?: OpenDecision[];
  wiInsightsArtifact?: WorkInstructionInsightArtifact | null;
}): {
  usedByFeature: Array<{ featureId: string; summary: string; behaviors: string[] }>;
  missing: string[];
} {
  const signals = getWiCoverageSignals(input.wiInsightsArtifact);
  if (!signals.length) return { usedByFeature: [], missing: [] };

  const featureCoverage = new Map<string, { featureId: string; summary: string; behaviors: string[] }>();
  const decisionCorpus = (input.openDecisions ?? [])
    .flatMap((decision) => [decision.title, decision.detail, decision.impact])
    .join(' ');
  const missing: string[] = [];

  signals.forEach((behavior) => {
    const matchedFeature = input.features.find((feature) => {
      const featureText = [
        feature.summary,
        feature.description,
        ...(feature.acceptanceRequirements ?? []).flatMap((ar) => [ar.given, ar.when, ar.then]),
      ].join(' ');
      return textMatchesWiBehavior(featureText, behavior);
    });

    if (matchedFeature) {
      const existing = featureCoverage.get(matchedFeature.id) ?? {
        featureId: matchedFeature.id,
        summary: matchedFeature.summary,
        behaviors: [],
      };
      existing.behaviors = uniqueNonEmptyStrings([...existing.behaviors, behavior]);
      featureCoverage.set(matchedFeature.id, existing);
      return;
    }

    if (!textMatchesWiBehavior(decisionCorpus, behavior)) {
      missing.push(behavior);
    }
  });

  return {
    usedByFeature: [...featureCoverage.values()],
    missing: uniqueNonEmptyStrings(missing),
  };
}

function determineOpenDecisionCategory(text: string): ClarifyCategoryKey | 'general' {
  const normalized = text.toLowerCase();
  if (/\b(who|permission|permissions|role|roles|owner|ownership|notify|notified)\b/.test(normalized)) return 'user_personas';
  if (/\b(when|trigger|receive|schedule|frequency|poll|event)\b/.test(normalized)) return 'context_trigger';
  if (/\b(state|history|lifecycle|swap|exchange|deinstall|removed|moved|owner change|remain)\b/.test(normalized)) return 'state_lifecycle';
  if (/\b(duplicate|match|identifier|criteria|version list|picklist|target version|sequence|step|depends|order|branch|path)\b/.test(normalized)) return 'functional_flow';
  if (/\b(error|failure|disconnect|drop|unreadable|missing|no match|fallback|exception|invalid|override)\b/.test(normalized)) return 'business_rules';
  if (/\b(should|how|policy|priority|rule|rules|validation|allowed)\b/.test(normalized)) return 'business_rules';
  return 'general';
}

function tokenizeDecisionText(text: string): Set<string> {
  return new Set(
    (String(text ?? '').toLowerCase().match(/\b[a-z][a-z0-9/-]{2,}\b/g) ?? [])
      .filter((token) => !SIZING_STOPWORDS.has(token)),
  );
}

function decisionLooksResolved(candidate: string, clarifyAnswers: ClarifyAnswer[]): boolean {
  const candidateTokens = tokenizeDecisionText(candidate);
  if (!candidateTokens.size) return false;
  return clarifyAnswers.some((answer) => {
    const answerTokens = tokenizeDecisionText([
      answer.question,
      answer.answer,
      answer.customAnswer,
      ...(answer.selectedSuggestions ?? []),
    ].filter(Boolean).join(' '));
    if (!answerTokens.size) return false;
    return jaccard(candidateTokens, answerTokens) >= 0.18;
  });
}

function synthesizeRequirementOpenDecisions(requirement: string, clarifyAnswers: ClarifyAnswer[]): OpenDecision[] {
  const lines = String(requirement ?? '')
    .split('\n')
    .map((line) => sanitizeArClause(line))
    .filter(Boolean);

  const candidates = lines.filter((line) =>
    /(?:\?|^\s*(?:what|how|who|when|should|do we|does it|is it|can it)\b)/i.test(line),
  );

  return candidates
    .filter((line) => !decisionLooksResolved(line, clarifyAnswers))
    .map((line, index) => {
      const category = determineOpenDecisionCategory(line);
      return {
        id: `requirement-open-decision-${index + 1}`,
        title: line.replace(/\?+$/g, '').slice(0, 140),
        detail: line,
        category,
        impact: category === 'general'
          ? 'This decision can materially change the generated scope or behavior.'
          : `This unresolved ${category.replace(/_/g, ' ')} decision can materially change the generated scope or behavior.`,
        blocking: true,
      } as OpenDecision;
    });
}

function synthesizeWorkInstructionOpenDecisions(
  wiInsightsArtifact?: WorkInstructionInsightArtifact | null,
): OpenDecision[] {
  if (!wiInsightsArtifact) return [];
  const decisionBuckets = [
    ...wiInsightsArtifact.sequencingRules.map((item) => ({ item, category: 'functional_flow' as const, label: 'sequencing rule' })),
    ...wiInsightsArtifact.splitVsSingleCaseRules.map((item) => ({ item, category: 'business_rules' as const, label: 'single-vs-multiple-plan rule' })),
    ...wiInsightsArtifact.stateTransitions.map((item) => ({ item, category: 'state_lifecycle' as const, label: 'state transition' })),
  ];
  return decisionBuckets.slice(0, 10).map(({ item, category, label }, index) => ({
    id: `wi-open-decision-${index + 1}`,
    title: `${label}: ${item.text.slice(0, 120)}`,
    detail: item.text,
    category,
    impact: 'Retrieved work-instruction guidance indicates this behavior should be preserved or resolved explicitly.',
    blocking: true,
  }));
}

function mergeOpenDecisions(primary: OpenDecision[], secondary: OpenDecision[]): OpenDecision[] {
  const seen = new Set<string>();
  const merged: OpenDecision[] = [];
  [...primary, ...secondary].forEach((decision) => {
    const title = sanitizeArClause(decision.title).toLowerCase();
    if (!title || seen.has(title)) return;
    seen.add(title);
    merged.push(decision);
  });
  return merged;
}

function extractClassificationOutcomes(text: string): string[] {
  const normalized = String(text ?? '').trim();
  if (!normalized) return [];
  const betweenMatch = normalized.match(/\bdistinguish between\s+(.+?)\s+and\s+(.+?)(?:[.?!]|$)/i);
  if (betweenMatch) {
    return uniquePromptSummaries([betweenMatch[1], betweenMatch[2]]);
  }
  return [];
}

function buildArObligations(input: {
  requirement: string;
  clarifyAnswers: ClarifyAnswer[];
  wiContextText?: string;
  wiInsightsArtifact?: WorkInstructionInsightArtifact | null;
  openDecisions?: OpenDecision[];
}): ArObligations {
  const confirmedOutcomes = uniquePromptSummaries([
    ...extractClassificationOutcomes(input.requirement),
    ...input.clarifyAnswers
      .filter((answer) => answer.categoryKey === 'business_rules' || answer.categoryKey === 'state_lifecycle')
      .map(summarizeAnswerForObligation),
  ]);
  const scopeBoundaries = uniquePromptSummaries([
    ...input.clarifyAnswers
      .filter((answer) => answer.categoryKey === 'business_rules')
      .map(summarizeAnswerForObligation),
    ...String(input.wiContextText ?? '')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => /\b(if|when)\b/i.test(line) && /\b(manual review|fallback|exception|exclude|ignore|missing|ambiguous|duplicate|unwanted|failed?)\b/i.test(line)),
  ]);
  const confirmedDataObligations = uniquePromptSummaries([
    ...input.clarifyAnswers
      .filter((answer) => answer.categoryKey === 'functional_flow' || answer.categoryKey === 'context_trigger')
      .map(summarizeAnswerForObligation),
    ...String(input.wiContextText ?? '')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => /\b(attachment|attachments|subject|body|description|link|linked|include|capture|field|data|identifier|history|record)\b/i.test(line)),
  ]);
  const unresolvedDecisions = uniquePromptSummaries(
    (input.openDecisions ?? [])
      .filter((decision) => decision.blocking)
      .map((decision) => `${decision.title}: ${decision.detail}`),
  );
  const wiMustCoverBehaviors = uniquePromptSummaries([
    ...(input.wiInsightsArtifact?.mustCoverBehaviors ?? []).map((item) => item.text),
    ...(input.wiInsightsArtifact?.sequencingRules ?? []).map((item) => item.text),
    ...(input.wiInsightsArtifact?.splitVsSingleCaseRules ?? []).map((item) => item.text),
  ]);

  return {
    confirmedOutcomes,
    scopeBoundaries,
    confirmedDataObligations,
    unresolvedDecisions,
    wiMustCoverBehaviors,
  };
}

function collectRemainingBlockingIssues(
  violations: ValidationViolation[],
  openDecisions: OpenDecision[],
  coverageFindings?: CoverageFindings,
): string[] {
  const blockingViolations = violations
    .filter((violation) =>
      /truncated|overlaps with|description must follow|AR missing GIVEN, WHEN, or THEN clause|implementation-flavored wording|solution language/i.test(violation.message),
    )
    .map((violation) => violation.message);

  const blockingDecisions = openDecisions
    .filter((decision) => decision.blocking)
    .map((decision) => decision.title);

  return uniqueNonEmptyStrings([
    ...blockingViolations,
    ...(coverageFindings?.overlapWarnings ?? []),
    ...(coverageFindings?.duplicatedThemes ?? []).map((item) => `Duplicated theme: ${item}`),
    ...blockingDecisions,
  ]);
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

export function applyFeatureOutputGuardrails(feature: Feature): Feature {
  return {
    ...feature,
    description: normalizeDraftDescriptionText(feature.description),
    acceptanceRequirements: [...(feature.acceptanceRequirements || [])],
  };
}

export function normaliseFeature(raw: RawFeature, roleGrounding?: RoleGroundingContext): Feature {
  const draft: Feature = {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : uuidv4(),
    summary: raw.summary ?? 'Untitled feature',
    description: raw.description ?? '',
    acceptanceRequirements: normaliseArs(getRawAcceptanceArray(raw)),
    storyPoints: raw.suggested_story_points,
    processCode: raw.process_code,
  };
  const guarded = applyFeatureOutputGuardrails(draft);
  guarded.featureClass = determineFeatureClass({ ...raw, description: guarded.description });
  guarded.actorSource = determineActorSource(guarded.description, roleGrounding, raw);
  guarded.confidence = determineFeatureConfidence({ description: guarded.description, actorSource: guarded.actorSource, raw });
  return guarded;
}

function buildLlmProviderOpts(config: TenantConfig) {
  return {
    provider: config.generatorConfig.provider,
    anthropicApiKey: config.generatorConfig.anthropicApiKey,
    anthropicBaseUrl: config.generatorConfig.anthropicBaseUrl,
    geminiApiKey: config.generatorConfig.geminiApiKey,
    geminiBaseUrl: config.generatorConfig.geminiBaseUrl,
    openaiApiKey: config.generatorConfig.openaiApiKey,
    openaiBaseUrl: config.generatorConfig.openaiBaseUrl,
    fireworksApiKey: config.generatorConfig.fireworksApiKey,
    fireworksBaseUrl: config.generatorConfig.fireworksBaseUrl,
    azureOpenAIApiKey: config.generatorConfig.azureOpenAIApiKey,
    azureOpenAIBaseUrl: config.generatorConfig.azureOpenAIBaseUrl,
    azureOpenAIApiVersion: config.generatorConfig.azureOpenAIApiVersion,
    ollamaApiKey: config.generatorConfig.ollamaApiKey,
    ollamaBaseUrl: config.generatorConfig.ollamaBaseUrl,
    groqApiKey: config.generatorConfig.groqApiKey,
    groqBaseUrl: config.generatorConfig.groqBaseUrl,
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
  const match = description.match(/^As an?\s+(.+?),\s*I need(?:\s+to)?\s+/i);
  return match?.[1]?.trim() || null;
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
