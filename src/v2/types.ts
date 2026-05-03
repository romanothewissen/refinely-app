import type {
  AcceptanceRequirement,
  ClarifyCategoryKey,
  Feature,
  TenantConfig,
} from '../types';
import type { JsonSchema } from '../core/json-schema';

export type V2DiscoveryMode = 'none' | 'light' | 'standard' | 'deep' | 'very_deep';
export type V2CrudRisk = 'low' | 'medium' | 'high';
export type V2Confidence = 'low' | 'medium' | 'high';
export type V2AnswerMateriality =
  | 'structural'
  | 'actor_bearing'
  | 'rule_bearing'
  | 'measurement_bearing'
  | 'trivial';

export type V2StageName =
  | 'scope_hypothesis'
  | 'discover'
  | 'capability_reasoning'
  | 'feature_formatter'
  | 'ar_writer';

export interface V2PromptBudget {
  stage: V2StageName;
  maxSystemChars: number;
  maxUserChars: number;
}

export interface V2TriageResult {
  discoveryMode: V2DiscoveryMode;
  questionBudget: number;
  ambiguityScore: number;
  workflowScore: number;
  crudRisk: V2CrudRisk;
  likelyCapabilityCount: number;
  likelyCapabilityShape: 'single_capability' | 'small_workflow' | 'broad_workflow';
  shouldPauseForScopeConfirmation: boolean;
  reasons: string[];
}

export interface V2ActorSlots {
  initiator?: string;
  performer?: string;
  approver?: string;
  observer?: string;
}

export interface V2CapabilityCandidate {
  id: string;
  label: string;
  rationale: string;
  confidence: V2Confidence;
}

export interface V2ScopeHypothesis {
  capabilities: V2CapabilityCandidate[];
  actorSlots: V2ActorSlots;
  openQuestions: string[];
  confidence: V2Confidence;
}

export interface V2DiscoveryQuestion {
  id: string;
  categoryKey: ClarifyCategoryKey;
  question: string;
  rationale: string;
  suggestions: string[];
}

export interface V2DiscoveryAnswer {
  questionId: string;
  categoryKey: ClarifyCategoryKey;
  question: string;
  answer: string;
  selectedSuggestion?: string;
}

export interface V2ClassifiedAnswer extends V2DiscoveryAnswer {
  materiality: V2AnswerMateriality;
  reason: string;
}

export interface V2OpenDecision {
  title: string;
  detail: string;
  blocking: boolean;
}

export interface V2CapabilityReasoningItem {
  capabilityId: string;
  label: string;
  boundary: string;
  ownerRole: string;
  mustCarryRules: string[];
  edgeCases: string[];
}

export interface V2CapabilityReasoningArtifact {
  capabilities: V2CapabilityReasoningItem[];
  actorSlots: V2ActorSlots;
  mustCarryRules: string[];
  edgeCases: string[];
  openDecisions: V2OpenDecision[];
}

export interface V2BenchmarkExample {
  summary: string;
  description: string;
  acceptanceRequirements: string[];
  source?: string;
}

export interface V2BenchmarkSignals {
  storyCount: number;
  acceptanceRequirementCount: {
    min: number;
    max: number;
    avg: number;
    median: number;
    distribution: Record<number, number>;
  };
  averageDescriptionLength: number;
  averageSummaryLength: number;
  averageAcceptanceRequirementLength: number;
  rates: {
    decisionLogic: number;
    fallbackHandling: number;
    manualOverrideHandling: number;
    negativeConstraints: number;
    scenarioCoverage: number;
  };
}

export interface V2QualityEvaluation {
  crudLike: boolean;
  capabilityDepthScore: number;
  actorIssues: string[];
  warnings: string[];
}

export interface V2EvidenceBundle {
  domainContext?: string;
  domainRoles?: string[];
  similarStoriesText?: string;
  wiContextText?: string;
}

export interface V2PipelineInput extends V2EvidenceBundle {
  requirement: string;
  attachmentText?: string;
  config: TenantConfig;
  confirmedScopeHypothesis?: V2ScopeHypothesis;
  discoveryAnswers?: V2DiscoveryAnswer[];
  previewOnly?: boolean;
}

export interface V2PipelinePreviewResult {
  status: 'preview_ready';
  triage: V2TriageResult;
  scopeHypothesis: V2ScopeHypothesis;
  recommendedNextStep: 'confirm_scope' | 'proceed_to_generation' | 'run_discovery';
}

export interface V2PipelineNeedsScopeResult {
  status: 'needs_scope_confirmation';
  triage: V2TriageResult;
  scopeHypothesis: V2ScopeHypothesis;
  recommendedNextStep: 'confirm_scope' | 'proceed_to_generation' | 'run_discovery';
}

export interface V2PipelineNeedsDiscoveryResult {
  status: 'needs_discovery';
  triage: V2TriageResult;
  scopeHypothesis: V2ScopeHypothesis;
  discoveryQuestions: V2DiscoveryQuestion[];
  materialityHints: string[];
}

export interface V2PipelineCompleteResult {
  status: 'complete';
  triage: V2TriageResult;
  scopeHypothesis: V2ScopeHypothesis;
  reasoning: V2CapabilityReasoningArtifact;
  features: Feature[];
  classifiedAnswers: V2ClassifiedAnswer[];
  discoveryChanges: string[];
  quality: V2QualityEvaluation;
  promptUsage: {
    input: number;
    output: number;
    byStage: Partial<Record<V2StageName, { input: number; output: number }>>;
  };
}

export type V2PipelineResult =
  | V2PipelinePreviewResult
  | V2PipelineNeedsScopeResult
  | V2PipelineNeedsDiscoveryResult
  | V2PipelineCompleteResult;

export interface V2StageRequest<T> {
  stage: V2StageName;
  model: string;
  systemPrompt: string;
  userMessage: string;
  jsonSchema: JsonSchema;
  maxTokens: number;
  reasoningEffort: 'low' | 'medium' | 'high';
  validate?: (data: unknown) => string | null;
}

export interface V2StageResponse<T> {
  data: T;
  usage: { input: number; output: number };
}

export type V2StageExecutor = <T>(request: V2StageRequest<T>) => Promise<V2StageResponse<T>>;

export interface V2WorkflowStateStore {
  getProgress(sessionId: string): Promise<Record<string, unknown> | null>;
  setProgress(sessionId: string, payload: Record<string, unknown>): Promise<void>;
  clearProgress(sessionId: string): Promise<void>;
}

export interface V2ConversationStore {
  savePreview(sessionId: string, accountId: string, payload: Record<string, unknown>): Promise<void>;
  saveGeneration(sessionId: string, accountId: string, payload: Record<string, unknown>): Promise<void>;
}
