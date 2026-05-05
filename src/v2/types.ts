import type {
  AcceptanceRequirement,
  ClarifyCategoryKey,
  Feature,
  TenantConfig,
} from '../types';
import type { JsonSchema } from '../core/json-schema';

export type V2DiscoveryMode = 'light' | 'standard' | 'deep' | 'very_deep';
export type V2CrudRisk = 'low' | 'medium' | 'high';
export type V2Confidence = 'low' | 'medium' | 'high';
export type V2ActorGroundingStatus = 'weak' | 'supported' | 'strong';
export type V2MemoryStatus = 'fresh' | 'stale' | 'missing';
export type V2AnswerMateriality =
  | 'structural'
  | 'actor_bearing'
  | 'rule_bearing'
  | 'measurement_bearing'
  | 'trivial';
export type ProjectMemorySliceType =
  | 'roles'
  | 'objects'
  | 'workflow_patterns'
  | 'lifecycle_states'
  | 'business_rules'
  | 'exception_patterns'
  | 'retrieval_hints'
  | 'compact_exemplars'
  | 'wi_memory';
export type ProjectMemoryRefreshTrigger = 'weekly' | 'manual' | 'threshold';

export type V2StageName =
  | 'triage'
  | 'scope_hypothesis'
  | 'discover'
  | 'discovery_synthesis'
  | 'final_generation'
  | 'coverage_repair'
  // Legacy stage names are kept in the union so older saved audit records and
  // tests that inspect stage usage remain readable.
  | 'capability_reasoning'
  | 'feature_formatter'
  | 'ar_writer';

export type V2ProgressStage =
  | 'context'
  | 'triage'
  | 'scope_hypothesis'
  | 'discover'
  | 'discovery_synthesis'
  | 'final_generation'
  | 'coverage_repair'
  | 'persisting';

export type V2ProgressResultStatus = 'needs_discovery' | 'discovery_generation_failed' | 'complete';

export interface V2ProgressDraftFeatureSummary {
  id: string;
  summary: string;
}

export interface V2ProgressFeatureCounts {
  drafted: number;
}

export interface V2PipelineProgressUpdate {
  stage: V2ProgressStage;
  message: string;
  draftFeatures?: V2ProgressDraftFeatureSummary[];
  featureCounts?: V2ProgressFeatureCounts;
}

export interface V2ProgressEventProgress extends V2PipelineProgressUpdate {
  type: 'progress';
  sessionId: string;
  updatedAt: number;
}

export interface V2ProgressEventComplete {
  type: 'complete';
  sessionId: string;
  resultStatus: V2ProgressResultStatus;
  updatedAt: number;
}

export interface V2ProgressEventError {
  type: 'error';
  sessionId: string;
  message: string;
  updatedAt: number;
}

export type V2ProgressEvent =
  | V2ProgressEventProgress
  | V2ProgressEventComplete
  | V2ProgressEventError;

export interface V2PromptBudget {
  stage: V2StageName;
  maxSystemChars: number;
  maxUserChars: number;
}

export interface V2TriageResult {
  discoveryMode: V2DiscoveryMode;
  questionBudget: number;
  complexity: number;
  ambiguity: number;
  workflowDepth: number;
  capabilityBreadth: number;
  askClarity: number;
  actorClarity: number;
  discoveryLoad: number;
  crudRisk: V2CrudRisk;
  likelyCapabilityCount: number;
  likelyCapabilityShape: 'single_capability' | 'small_workflow' | 'broad_workflow';
  mustCoverBehaviors: string[];
  unresolvedDecisionThemes: string[];
  arDepth: 'light' | 'standard' | 'deep';
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
  evidenceKeys?: string[];
}

export interface V2ScopeHypothesis {
  capabilities: V2CapabilityCandidate[];
  actorSlots: V2ActorSlots;
  openQuestions: string[];
  confidence: V2Confidence;
  actorGroundingStatus?: V2ActorGroundingStatus;
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
  evidenceKeys?: string[];
}

export interface V2CapabilityReasoningArtifact {
  capabilities: V2CapabilityReasoningItem[];
  actorSlots: V2ActorSlots;
  mustCarryRules: string[];
  edgeCases: string[];
  openDecisions: V2OpenDecision[];
}

export interface V2DiscoverySynthesis {
  resolvedFacts: string[];
  actorMap: V2ActorSlots;
  businessRules: string[];
  workflowSteps: string[];
  lifecycleStates: string[];
  exceptions: string[];
  successMeasures: string[];
  mustCoverBehaviors: string[];
  openDecisions: V2OpenDecision[];
  arDepth: 'light' | 'standard' | 'deep';
  featureTarget: number;
}

export interface V2GeneratedFeature {
  summary: string;
  description: string;
  suggested_story_points: number;
  process_code?: string;
  acceptanceRequirements: AcceptanceRequirement[];
}

export interface V2CoverageMapping {
  mustCoverBehavior: string;
  featureSummary?: string;
  openDecisionTitle?: string;
}

export interface V2FinalGenerationResponse {
  features: V2GeneratedFeature[];
  coverageMap: V2CoverageMapping[];
}

export interface V2CoverageGateResult {
  sufficient: boolean;
  failures: string[];
  repaired: boolean;
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

export interface V2RoleCandidate {
  role: string;
  confidence: V2ActorGroundingStatus;
  evidenceKeys: string[];
}

export interface V2GroundedCue {
  key: string;
  text: string;
}

export interface V2GroundedEvidencePack {
  roleCandidates: V2RoleCandidate[];
  businessObjects: V2GroundedCue[];
  workflowSignals: V2GroundedCue[];
  businessRules: V2GroundedCue[];
  lifecycleSignals: V2GroundedCue[];
  backlogCues: V2GroundedCue[];
  wiCues: V2GroundedCue[];
  directEvidenceTerms: string[];
}

export interface ProjectMemoryArtifactHeader {
  roles: string[];
  businessObjects: string[];
  workflowCues: string[];
  arStyleHint: string;
  freshness: V2MemoryStatus;
  builtAt: string | null;
}

export interface ProjectMemoryCompactExemplar {
  key: string;
  summary: string;
  pattern: string;
}

export interface ProjectMemoryWiMemory {
  resolvedFacts: string[];
  workflowSteps: string[];
  businessRules: string[];
  exceptions: string[];
  mustCoverBehaviors: string[];
}

export interface ProjectMemorySelection {
  artifactVersion?: string;
  roles?: string[];
  objects?: string[];
  workflow_patterns?: string[];
  lifecycle_states?: string[];
  business_rules?: string[];
  exception_patterns?: string[];
  retrieval_hints?: string[];
  compact_exemplars?: ProjectMemoryCompactExemplar[];
  wi_memory?: ProjectMemoryWiMemory | null;
}

export interface V2PipelineInput extends V2EvidenceBundle {
  requirement: string;
  attachmentText?: string;
  config: TenantConfig;
  evidencePack?: V2GroundedEvidencePack;
  memoryHeader?: ProjectMemoryArtifactHeader;
  memorySelection?: ProjectMemorySelection | null;
  memoryStatus?: V2MemoryStatus;
  triageOverride?: V2TriageResult;
  confirmedScopeHypothesis?: V2ScopeHypothesis;
  discoveryAnswers?: V2DiscoveryAnswer[];
  previewOnly?: boolean;
}

export interface V2PipelinePreviewResult {
  status: 'preview_ready';
  triage: V2TriageResult;
  scopeHypothesis: V2ScopeHypothesis;
  recommendedNextStep: 'confirm_scope' | 'run_discovery';
}

export interface V2PipelineNeedsScopeResult {
  status: 'needs_scope_confirmation';
  triage: V2TriageResult;
  scopeHypothesis: V2ScopeHypothesis;
  recommendedNextStep: 'confirm_scope' | 'run_discovery';
}

export interface V2PipelineNeedsDiscoveryResult {
  status: 'needs_discovery';
  triage: V2TriageResult;
  scopeHypothesis: V2ScopeHypothesis;
  discoveryQuestions: V2DiscoveryQuestion[];
  materialityHints: string[];
}

export interface V2DiscoveryFailureDiagnostics {
  stage: 'discover';
  failureType: 'json_shape' | 'grounding_quality';
  validationError?: string;
  responseShape?: Record<string, string | number | boolean>;
  appearsTruncated?: boolean;
  appearsWrongStageEnvelope?: boolean;
}

export interface V2PipelineDiscoveryFailedResult {
  status: 'discovery_generation_failed';
  triage: V2TriageResult;
  scopeHypothesis: V2ScopeHypothesis;
  message: string;
  retryable: boolean;
  failureCode: 'discovery_questions_invalid_shape' | 'discovery_questions_not_grounded';
  diagnostics?: V2DiscoveryFailureDiagnostics;
}

export interface V2PipelineCompleteResult {
  status: 'complete';
  triage: V2TriageResult;
  scopeHypothesis: V2ScopeHypothesis;
  synthesis: V2DiscoverySynthesis;
  reasoning: V2CapabilityReasoningArtifact;
  features: Feature[];
  classifiedAnswers: V2ClassifiedAnswer[];
  discoveryChanges: string[];
  quality: V2QualityEvaluation;
  coverage: V2CoverageGateResult;
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
  | V2PipelineDiscoveryFailedResult
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
export type V2ProgressReporter = (update: V2PipelineProgressUpdate) => Promise<void> | void;

export interface V2WorkflowStateStore {
  getProgress(sessionId: string): Promise<V2ProgressEvent | null>;
  setProgress(sessionId: string, payload: V2ProgressEvent): Promise<void>;
  clearProgress(sessionId: string): Promise<void>;
}

export interface V2ConversationStore {
  savePreview(sessionId: string, accountId: string, payload: Record<string, unknown>): Promise<void>;
  saveGeneration(sessionId: string, accountId: string, payload: Record<string, unknown>): Promise<void>;
}
