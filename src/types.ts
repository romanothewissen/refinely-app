// ─── Constants ───────────────────────────────────────────────────────────────
import strategyCatalog from './frontend/src/modelStrategyCatalog.json';

export const REDACTED = '•••••••• (Encrypted)';
const DEFAULT_ANTHROPIC_STABLE = strategyCatalog.providers.anthropic.presets.stable;

// ─── Tenant Configuration ────────────────────────────────────────────────────

export type LlmProvider = 'forge_llms' | 'anthropic' | 'gemini' | 'openai' | 'fireworks' | 'azure_openai' | 'ollama' | 'groq';
export type ModelFamily = 'pro' | 'flash' | 'lite' | 'latest' | 'custom';
export type ConcreteModelFamily = Exclude<ModelFamily, 'latest'>;
export type LatestModelSelector = 'latest' | 'latest-pro' | 'latest-flash' | 'latest-lite';
export type GeneratorModelStrategy = 'simple' | 'advanced' | 'stable' | 'latest' | 'custom';
export type GeneratorBucketClass = 'pro' | 'flash' | 'lite';
export type PipelineProfile = 'fast' | 'balanced' | 'quality';
export type PipelineReasoningLevel = 'low' | 'medium' | 'high';
export type GenerationUsageSource = 'platform_free_credit' | 'user_api_key';
export type GenerationAccessState =
  | 'preview_available'
  | 'profile_preview_exhausted'
  | 'preview_exhausted_requires_api_key'
  | 'allowed_byok';
export type UsageWarningState = 'none' | 'last_preview_credit' | 'preview_exhausted';

export interface PipelineProfileConfig {
  profile: PipelineProfile;
  clarifyReasoning: PipelineReasoningLevel;
  decompositionReasoning: PipelineReasoningLevel;
  arReasoning: PipelineReasoningLevel;
  similarStoryMaxResults: number;
  arPatternMaxStories: number;
  wiDocSelectionCap: number;
  generationOutputMaxTokens: number;
  enableCoverageProbe: boolean;
}

export interface GeneratorBucketClasses {
  discovery: GeneratorBucketClass;
  generation: GeneratorBucketClass;
  refinement: GeneratorBucketClass;
}

export interface LlmModelCatalogEntry {
  id: string;                         // runtime model or deployment identifier
  displayName?: string;               // human-friendly label for settings/UI
  family?: ConcreteModelFamily;       // inferred or curated family bucket
  isLatest?: boolean;                 // marks the preferred/current model in a family
  releaseDate?: string;               // ISO timestamp when known
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  structuredOutputMode?: 'json_schema' | 'json_object' | 'prompt_only';
  reasoningControlMode?: 'reasoning_effort' | 'thinking_budget' | 'thinking_level' | 'openai_reasoning' | 'auto' | 'none';
  reasoningVisibility?: 'hidden' | 'separate_field' | 'inline' | 'unsupported';
  tokenLimitParam?: 'max_tokens' | 'max_completion_tokens' | 'maxOutputTokens';
  unsupportedParams?: string[];
  aliases?: string[];
  deploymentName?: string;            // Azure-specific deployment name if distinct from id
  source?: 'discovered' | 'manual' | 'fallback';
}

export interface LlmVendorModelCatalog {
  vendor: LlmProvider;
  fetchedAt?: string;
  source?: 'discovered' | 'manual' | 'fallback';
  models: LlmModelCatalogEntry[];
}

export type LlmModelCatalogByVendor = Partial<Record<LlmProvider, LlmVendorModelCatalog>>;

export interface StoryAssistantModelAssignment {
  lightModel?: string;
  heavyModel?: string;
}

export interface GeneratorConfig {
  provider: LlmProvider;
  modelStrategy: GeneratorModelStrategy;
  bucketClasses: GeneratorBucketClasses;
  modelStrategyVersion: string;
  pipelineProfile: PipelineProfile;
  decompositionModel: string;   // e.g. claude-opus-4-6, gpt-4o
  arModel: string;              // e.g. claude-opus-4-6, gpt-4o
  clarifyModel: string;         // e.g. claude-sonnet-4-6, gpt-4o-mini
  refineModel: string;          // e.g. claude-opus-4-6, gpt-4o
  evaluateModel: string;        // e.g. claude-haiku-4-5, gpt-4o-mini
  triageModel: string;          // e.g. claude-haiku-4-5, gpt-4o-mini — fast scope/complexity assessment
  themeModel: string;           // e.g. claude-haiku-4-5, gpt-4o-mini
  maxTokens: number;            // default: 8192
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
  geminiApiKey?: string;
  geminiBaseUrl?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  fireworksApiKey?: string;
  fireworksBaseUrl?: string;
  azureOpenAIApiKey?: string;
  azureOpenAIBaseUrl?: string;
  azureOpenAIApiVersion?: string;
  ollamaApiKey?: string;
  ollamaBaseUrl?: string;
  groqApiKey?: string;
  groqBaseUrl?: string;
  modelCatalogs?: LlmModelCatalogByVendor;
  storyAssistantModelAssignments?: Partial<Record<LlmProvider, StoryAssistantModelAssignment>>;
  pauseForDraftReview?: boolean;
}

export interface ProcessCode {
  code: string;
  name: string;
  definition: string;
}

export interface ProjectFieldMapping {
  summaryFieldId: string;
  descriptionFieldId: string;
  arFieldIds: string[];
}

export interface ProjectPersonaRole {
  role: string;
  activities: string;
}

export interface ProjectPersonaRoleSuggestion {
  role: string;
  activities: string;
  confidence: 'high' | 'medium' | 'low';
  evidenceIssueKeys: string[];
}

export interface InferProjectPersonaRolesResult {
  success: boolean;
  suggestions: ProjectPersonaRoleSuggestion[];
  sampledIssueCount: number;
  sampledIssueKeys: string[];
  usedCache: boolean;
  message?: string;
  error?: string;
}

export interface ProjectArMapping {
  projectKey: string;   // e.g. "MYPROJ" or "*" for default
  issueType?: string;   // e.g. "Story" or "*"
  mode: 'consolidated' | 'iterative';
  consolidatedFieldId: string;
  iterativeFieldIds: string[];
  inputMappings: ProjectFieldMapping;
  outputMappings: ProjectFieldMapping;
  issueLinkType?: string; // per-project link type
}

export interface ProjectDomainContext {
  projectKey: string;
  context: string;
  personaRoles?: ProjectPersonaRole[];
}

export interface ProjectGoldExampleConfig {
  projectKey: string;
  /** Manual gold issue keys chosen by the user. Highest precedence. */
  issueKeys?: string[];
  /** Jira label filter (e.g. "gold-example"). Second precedence. */
  label?: string;
}

export interface ProjectBacklogStatusScope {
  projectKey: string;
  statuses: string[];
}

export interface Branding {
  appTitle: string;
  logoUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
}

export type FeatureClass = 'business_capability' | 'technical_enabler' | 'cross_cutting_rule';
export type FeatureConfidence = 'confirmed' | 'assumption_applied';
export type FeatureActorSource = 'prompt' | 'clarify' | 'workspace_role' | 'fallback';

export interface GenerationPreferences {
  backlogDepth?: 'quick' | 'standard' | 'thorough';
  featureProfile?: {
    includeTechnicalEnablers?: boolean;
    includeCrossCuttingRules?: boolean;
  };
}

export interface TenantConfig {
  generatorConfig: GeneratorConfig;
  generationPreferences: GenerationPreferences;
  /** @deprecated Legacy workspace-level guidance text. Prefer project-scoped domainContexts. */
  domainContext: string;
  /** @deprecated Legacy workspace-level persona roles. Prefer project-scoped domainContexts.personaRoles. */
  domainRoles: string[];
  processTaxonomyEnabled: boolean;
  processTaxonomy: ProcessCode[];
  branding: Branding;
  similarityConfig: {
    threshold: number;
    useLlmRerank: boolean;
  };
  wiConfig: {
    enabled: boolean;
    topKChunks: number;
    maxChars: number;
  };
  tier: 'free' | 'standard';
  compliance: {
    enabled: boolean;
    transparencyReportsEnabled: boolean;
    piiMaskingEnabled: boolean;
    auditTrailEnabled: boolean;
  };
  /** @deprecated Legacy workspace-level fallback. Prefer ProjectArMapping.issueLinkType. */
  issueLinkType: string;  // default: 'Relates to'
  arMappings: ProjectArMapping[];
  domainContexts: ProjectDomainContext[];
  goldExampleConfigs?: ProjectGoldExampleConfig[];
  backlogStatusScopes: ProjectBacklogStatusScope[];
  backlogThemeBudgetOverride?: number | null;
  /** Internal QA / prompt iteration — gate pipeline audit recording and export. */
  developerTools?: {
    pipelineAuditEnabled?: boolean;
  };
}

export interface UserPreferences {
  defaultProjectKey?: string;
  pipelineProfile?: PipelineProfile;
  quickRefineModelByProvider?: Partial<Record<LlmProvider, string>>;
}

export const DEFAULT_CONFIG: TenantConfig = {
  generatorConfig: {
    provider: 'anthropic',
    modelStrategy: 'simple',
    bucketClasses: {
      discovery: 'flash',
      generation: 'pro',
      refinement: 'flash',
    },
    modelStrategyVersion: strategyCatalog.version,
    pipelineProfile: 'balanced',
    decompositionModel: DEFAULT_ANTHROPIC_STABLE.flash[0], // Flash: fast outline task; AR writing keeps Pro
    arModel: DEFAULT_ANTHROPIC_STABLE.pro[0],
    clarifyModel: DEFAULT_ANTHROPIC_STABLE.flash[0],
    refineModel: DEFAULT_ANTHROPIC_STABLE.flash[0],
    evaluateModel: DEFAULT_ANTHROPIC_STABLE.flash[0],
    triageModel: DEFAULT_ANTHROPIC_STABLE.flash[0],
    themeModel: DEFAULT_ANTHROPIC_STABLE.flash[0],
    maxTokens: 131072,
  },
  generationPreferences: {},
  domainContext: '',
  domainRoles: [],
  processTaxonomyEnabled: false,
  processTaxonomy: [],
  branding: {
    appTitle: 'Story Generator',
    logoUrl: null,
    primaryColor: '#4F46E5',
    secondaryColor: '#3730A3',
  },
  similarityConfig: {
    threshold: 0.24,
    useLlmRerank: true,
  },
  wiConfig: {
    enabled: true,
    topKChunks: 6,
    maxChars: 20000,
  },
  tier: 'standard',
  compliance: {
    enabled: false,
    transparencyReportsEnabled: false,
    piiMaskingEnabled: false,
    auditTrailEnabled: false,
  },
  issueLinkType: 'Relates to',
  arMappings: [
    {
      projectKey: '*',
      mode: 'consolidated',
      consolidatedFieldId: 'description',
      iterativeFieldIds: [],
      inputMappings: {
        summaryFieldId: 'summary',
        descriptionFieldId: 'description',
        arFieldIds: [],
      },
      outputMappings: {
        summaryFieldId: 'summary',
        descriptionFieldId: 'description',
        arFieldIds: [],
      },
    }
  ],
  domainContexts: [
    {
      projectKey: '*',
      context: '',
    }
  ],
  goldExampleConfigs: [],
  backlogStatusScopes: [],
  backlogThemeBudgetOverride: null,
  developerTools: {
    pipelineAuditEnabled: false,
  },
};

// ─── Feature / Story Types ────────────────────────────────────────────────────

export interface AcceptanceRequirement {
  given: string;
  when: string;
  then: string;
}

export interface OpenDecision {
  id: string;
  title: string;
  detail: string;
  category: ClarifyCategoryKey | 'general';
  impact: string;
  blocking: boolean;
}

export interface RoleCoverageItem {
  role: string;
  source: FeatureActorSource;
  status: 'covered' | 'missing' | 'assumed';
}

export interface CoverageFindings {
  missingUseCases: string[];
  overlapWarnings: string[];
  duplicatedThemes: string[];
}

export interface Feature {
  id: string;
  summary: string;
  description: string;          // "As a [role], I need [action] so that [benefit]"
  acceptanceRequirements: AcceptanceRequirement[];
  storyPoints?: number;
  processCode?: string;          // only if taxonomy enabled
  featureClass?: FeatureClass;
  confidence?: FeatureConfidence;
  actorSource?: FeatureActorSource;
  arGenerationStatus?: 'failed' | 'retrying';
  arGenerationError?: string;
  jiraIssueKey?: string;
  jiraIssueUrl?: string;
}

export type DraftReviewDecision =
  | 'continue'
  | 'broaden'
  | 'tighten'
  | 'merge_selected'
  | 'split_selected';

export interface DraftFeatureReviewNote {
  featureId?: string;
  summary?: string;
  whySeparate?: string;
  possibleMergeWith?: string[];
  possibleSplitNote?: string;
  featureClass?: FeatureClass;
  confidence?: FeatureConfidence;
  actorSource?: FeatureActorSource;
  descriptionIssues?: string[];
  descriptionAdjusted?: boolean;
}

export interface DraftDescriptionQualityReview {
  adjustedFeatureIds: string[];
  flaggedFeatureIds: string[];
  warnings: string[];
}

export interface DraftReviewMetadata {
  reasoningSummary?: string;
  unresolvedAmbiguities: string[];
  featureNotes: DraftFeatureReviewNote[];
  openDecisions?: OpenDecision[];
  roleCoverage?: RoleCoverageItem[];
  coverageFindings?: CoverageFindings;
  descriptionQuality?: DraftDescriptionQualityReview;
  lastAction?: DraftReviewDecision;
  reviewMessage?: string;
}

export interface CoverageReviewAdvice {
  sufficient: boolean;
  missingCoverage: string[];
  reasoning?: string;
}

export type CanvasEditIntent = 'light_refine' | 'add_requirements' | 'add_feature' | 'reorganize';
export type CanvasEditScope = 'current' | 'selected' | 'all';
export type CoverageGapCategory =
  | 'trigger_outcome'
  | 'roles_ownership'
  | 'required_information_linkage'
  | 'rules_routing'
  | 'lifecycle_matching'
  | 'exceptions_duplicates';
export type CoverageGapConfidence = 'low' | 'medium' | 'high';
export type CoverageGapAction = 'add_to_feature' | 'add_feature' | 'ask_followup';

export interface EditRoutingDecision {
  intent: CanvasEditIntent;
  confidence: CoverageGapConfidence;
  reason: string;
  followupQuestion?: string;
  followupWhy?: string;
  followupUnlocks?: string;
}

export interface CoverageGap {
  id: string;
  category: CoverageGapCategory;
  label: string;
  confidence: CoverageGapConfidence;
  suggestedAction: CoverageGapAction;
  why: string;
  question?: string;
  targetFeatureId?: string;
  suggestedIntent?: CanvasEditIntent;
}

export type RestructureScope = 'all' | 'selected';

export interface StructuralFeatureProposal extends Feature {
  sourceFeatureIds: string[];
  sourceAcceptanceRequirementRefs: string[];
  primarySourceFeatureId?: string;
  rationale?: string;
}

export interface StructuralRestructureProposal {
  scope: RestructureScope;
  selectedFeatureIds: string[];
  proposedFeatures: StructuralFeatureProposal[];
  removedFeatureIds: string[];
  removedAcceptanceRequirementRefs: string[];
}

export type AiChangeActionType = 'refine_single' | 'refine_all' | 'restructure' | 'add_requirements' | 'add_feature';

export interface UndoableAiChange {
  actionType: AiChangeActionType;
  scope: 'single' | 'all' | 'selected';
  label: string;
  timestamp: string;
  affectedFeatureIds: string[];
  previousFeatures: Feature[];
}

export interface ValidationViolation {
  featureId: string;
  field: string;
  message: string;
}

export interface ReferencedSimilarStory {
  key: string;
  summary: string;
  relevanceScore?: number;
  url?: string;
  jiraIssueUrl?: string;
}

export interface ReferencedWiSection {
  docId: string;
  filename: string;
  chunkIndex: number;
  sectionLabel?: string;
  excerpt: string;
}

export type ClarifyCategoryKey =
  | 'context_trigger'
  | 'user_personas'
  | 'functional_flow'
  | 'business_rules'
  | 'state_lifecycle'
  | 'success_measurement';

export type ClarifyDiscoveryStatus = 'needs_clarification' | 'ready_for_generation' | 'discovery_failed';
export type ClarifyFailureReasonCode =
  | 'timeout'
  | 'queue_error'
  | 'json_parse_failed'
  | 'question_array_missing'
  | 'question_shape_invalid'
  | 'question_array_empty_when_discovery_required'
  | 'question_set_generic'
  | 'question_set_truncated';

export interface ClarifyFailureDiagnostics {
  technicalSummary: string;
  userActionHint: string;
  generatedQuestionCount?: number;
  parseShape?: string;
}

export interface DiscoveryCoverageArtifact {
  mustResolveThemes: string[];
  optionalThemes: string[];
  coveredThemes: string[];
  askedCategoryKeys?: ClarifyCategoryKey[];
  askedThemes?: string[];
  openBlockingThemes: string[];
  openNonBlockingDecisions: string[];
  plannedQuestionBudget: number;
  actualQuestionsAsked: number;
  actualAnswersReceived?: number;
}

export interface PipelineLatencyBreakdown {
  queueWaitMs?: number;
  retrievalMs?: number;
  wiInsightExtractionMs?: number;
  promptAssemblyMs?: number;
  firstProgressEventMs?: number;
  persistenceMs?: number;
  auditWriteMs?: number;
  pollingLagMs?: number;
}

export interface ActorSetGrounding {
  eligibleActors?: string[];
  approverActors?: string[];
  viewerActors?: string[];
  mentionedActors?: string[];
  canonicalRoles?: string[];
  roleConfidence?: 'high' | 'low';
}

export interface ScopeContract {
  inScope: string[];
  outOfScope: string[];
  assumptions: string[];
}

export type GenerationQualityMode = 'speed' | 'quality';

export interface GenerationModelOverrides {
  decompositionModel?: string;
  arModel?: string;
}

export interface GenerationModelRoute {
  clarify?: string;
  evaluate?: string;
  decomposition?: string;
  ar?: string;
}

export interface DiscoveryProfile {
  scope: 'narrow' | 'moderate' | 'broad' | 'very_broad';
  complexity: 'low' | 'medium' | 'high' | 'very_high';
  ambiguity: 'low' | 'medium' | 'high';
  reasoningLevel?: DiscoveryDepth;
  missingCategoryKeys: ClarifyCategoryKey[];
  recommendedInitialCount: number;
  followupCap: number;
  plannedQuestionBudget?: number;
  actualQuestionsAsked?: number;
  actualAnswersReceived?: number;
  softQuestionBudget?: number;
  hardQuestionCap?: number;
  coverageArtifact?: DiscoveryCoverageArtifact;
}

export type DiscoveryDepth = 'light' | 'standard' | 'deep';
export type DiscoveryDimensionLevel = 'low' | 'medium' | 'high';

export interface DiscoveryAssessment {
  discoveryDepth: DiscoveryDepth;
  reasoningLevel: DiscoveryDepth;
  workflowComplexity: DiscoveryDimensionLevel;
  actorComplexity: DiscoveryDimensionLevel;
  ruleDensity: DiscoveryDimensionLevel;
  exceptionDensity: DiscoveryDimensionLevel;
  lifecycleComplexity: DiscoveryDimensionLevel;
  ambiguityLevel: DiscoveryDimensionLevel;
  coverageObligations: string[];
  recommendedQuestionRange: { min: number; max: number };
  rationale: string;
}

export type AdvisoryTriageConfidence = 'low' | 'medium' | 'high';

export interface AdvisoryDeliveryForecast {
  shape: 'minimal' | 'narrow' | 'balanced' | 'broad' | 'epic';
  complexity: 'trivial' | 'low' | 'medium' | 'high' | 'very_high';
  featureTarget: number;
  featureMin?: number;
  featureMax?: number;
  arDepth: 'minimal' | 'lean' | 'standard' | 'thorough' | 'comprehensive';
  arTarget?: number;
}

export interface AdvisoryDiscoveryForecast {
  scope: DiscoveryProfile['scope'];
  complexity: DiscoveryProfile['complexity'];
  ambiguity: DiscoveryProfile['ambiguity'];
  recommendedInitialCount: number;
  followupCap: number;
}

export interface AdvisoryTriageContract {
  reasoning: string;
  confidence: AdvisoryTriageConfidence;
  deliveryForecast: AdvisoryDeliveryForecast;
  discoveryForecast: AdvisoryDiscoveryForecast;
  telemetry?: {
    fallbackUsed?: boolean;
    heuristicDivergence?: {
      deliveryShape?: {
        llm: AdvisoryDeliveryForecast['shape'];
        heuristic: AdvisoryDeliveryForecast['shape'];
      };
      deliveryComplexity?: {
        llm: AdvisoryDeliveryForecast['complexity'];
        heuristic: AdvisoryDeliveryForecast['complexity'];
      };
      discoveryScope?: {
        llm: AdvisoryDiscoveryForecast['scope'];
        heuristic: AdvisoryDiscoveryForecast['scope'];
      };
      discoveryComplexity?: {
        llm: AdvisoryDiscoveryForecast['complexity'];
        heuristic: AdvisoryDiscoveryForecast['complexity'];
      };
      discoveryAmbiguity?: {
        llm: AdvisoryDiscoveryForecast['ambiguity'];
        heuristic: AdvisoryDiscoveryForecast['ambiguity'];
      };
      recommendedInitialCount?: {
        llm: number;
        heuristic: number;
      };
    };
  };
}

export interface EffectiveSizingContract {
  shape: 'minimal' | 'narrow' | 'balanced' | 'broad' | 'epic';
  complexity: 'trivial' | 'low' | 'medium' | 'high' | 'very_high';
  featureTarget: number;
  arDepth: 'minimal' | 'lean' | 'standard' | 'thorough' | 'comprehensive';
  arTarget?: number;
  estimatedQuestions: number;
}

export interface DiscoverySufficiencyResult {
  evaluated: boolean;
  sufficient: boolean | null;
  status?: 'ask_followup' | 'ready_to_generate' | 'ready_with_open_decisions';
  roundEvaluated: number;
  missingCategoryKeys: ClarifyCategoryKey[];
  reasonCodes: string[];
}

export interface ClarifyAssessmentSummary {
  shape?: EffectiveSizingContract['shape'];
  complexity?: EffectiveSizingContract['complexity'];
  featureTarget?: number;
  arDepth?: EffectiveSizingContract['arDepth'];
  arTarget?: number;
  estimatedQuestions?: number;
  confidence?: AdvisoryTriageConfidence;
  reasoning?: string;
  discoveryForecast?: AdvisoryDiscoveryForecast;
  deliveryForecast?: AdvisoryDeliveryForecast;
}

export interface ClarifyProgressPayload {
  stage?: 'context' | 'question_generation' | 'finalize' | 'followup';
  assessment?: ClarifyAssessmentSummary;
  sizingContract?: EffectiveSizingContract;
  advisoryTriage?: AdvisoryTriageContract;
  discoveryProfile?: DiscoveryProfile;
  discoveryAssessment?: DiscoveryAssessment;
  coverageQualityScore?: number;
  coverageRetryTriggered?: boolean;
  ambiguityAssessment?: ClarifyContextMeta['ambiguityAssessment'];
  latencyMs?: PipelineLatencyBreakdown;
  modelRoute?: GenerationModelRoute;
  pipelineProfile?: PipelineProfile;
  sources?: {
    projectKey: string;
    projectCount?: number;
    domainContextApplied?: boolean;
    attachmentIncluded?: boolean;
    wiDocsCount?: number;
    linkedWiDocCount?: number;
    retrievedWiDocCount?: number;
    retrievedWiChunkCount?: number;
    wiInsightCount?: number;
    similarStoriesCount?: number;
  };
}

export interface WorkInstructionSourceSpan {
  docId: string;
  filename: string;
  chunkIndex: number;
  sectionLabel?: string;
}

export type WiFacetKind =
  | 'actor'
  | 'action'
  | 'object'
  | 'input'
  | 'output'
  | 'rule'
  | 'transition'
  | 'exception'
  | 'sequence'
  | 'split_decision';

export interface WiFacet {
  kind: WiFacetKind;
  value: string;
  confidence?: 'low' | 'medium' | 'high';
}

export interface WorkInstructionInsightItem {
  text: string;
  sourceSpans: WorkInstructionSourceSpan[];
}

export interface WorkInstructionInsightArtifact {
  resolvedFacts: WorkInstructionInsightItem[];
  workflowSteps: WorkInstructionInsightItem[];
  actors: WorkInstructionInsightItem[];
  inputs: WorkInstructionInsightItem[];
  outputs: WorkInstructionInsightItem[];
  businessRules: WorkInstructionInsightItem[];
  stateTransitions: WorkInstructionInsightItem[];
  exceptions: WorkInstructionInsightItem[];
  sequencingRules: WorkInstructionInsightItem[];
  splitVsSingleCaseRules: WorkInstructionInsightItem[];
  mustCoverBehaviors: WorkInstructionInsightItem[];
  sourceSpans: WorkInstructionSourceSpan[];
}

export interface ContextSourceMeta {
  projectKey: string;
  projectKeys?: string[];
  projectCount?: number;
  pipelineMode?: 'story_assistant_default';
  domainRolesUsed: string[];
  domainContextApplied?: boolean;
  attachmentIncluded?: boolean;
  wiDocsCount?: number;
  linkedWiDocCount?: number;
  retrievedWiDocCount?: number;
  retrievedWiChunkCount?: number;
  wiInsightCount?: number;
  referencedWiDocs?: Array<{ docId: string; filename: string; chunkCount: number }>;
  referencedWiSections?: ReferencedWiSection[];
  wiInsights?: WorkInstructionInsightArtifact;
}

export interface ClarifyContextMeta extends ContextSourceMeta {
  discoveryStatus?: ClarifyDiscoveryStatus;
  failureReasonCode?: ClarifyFailureReasonCode;
  failureDiagnostics?: ClarifyFailureDiagnostics;
  similarStoriesCount?: number;
  referencedSimilarStories?: ReferencedSimilarStory[];
  sizingContract?: EffectiveSizingContract;
  advisoryTriage?: AdvisoryTriageContract;
  askedQuestions?: ClarifyQuestion[];
  discoveryProfile?: DiscoveryProfile;
  discoveryAssessment?: DiscoveryAssessment;
  discoveryDepth?: DiscoveryDepth;
  reasoningLevel?: DiscoveryDepth;
  coverageObligations?: string[];
  recommendedQuestionRange?: { min: number; max: number };
  assessmentRationale?: string;
  coverageQualityScore?: number;
  coverageRetryTriggered?: boolean;
  ambiguityAssessment?: {
    level: 'clear' | 'medium' | 'vague';
    score: number;
    reasons: string[];
    questionPlan: { min: number; max: number; target: number };
    generatedQuestions: number;
  };
  roundsCompleted?: number;
  initialQuestionCount?: number;
  followupQuestionCount?: number;
  totalQuestionCount?: number;
  followupTriggered?: boolean;
  initialClarifyDurationMs?: number;
  sufficiencyEvaluationDurationMs?: number;
  totalDiscoveryDurationMs?: number;
  finalSufficiency?: DiscoverySufficiencyResult;
  tokenUsage?: TokenUsageSummary;
  actorSets?: ActorSetGrounding;
  latencyMs?: PipelineLatencyBreakdown;
  modelRoute?: GenerationModelRoute;
  pipelineProfile?: PipelineProfile;
  scopeContract?: ScopeContract;
  sharedEvidenceSignature?: string;
  discoveryCategoryCoverage?: {
    orderedCategories: ClarifyCategoryKey[];
    askedCategoryKeys: ClarifyCategoryKey[];
    missingCategoryKeys: ClarifyCategoryKey[];
  };
}

export type SizingAssessmentArchetype = 'guard_rule' | 'focused_capability' | 'workflow_area' | 'broad_platform';
export type SizingAssessmentVerdict = 'ok' | 'oversized' | 'undersized' | 'uncertain';
export type SizingAssessmentConfidence = 'low' | 'medium' | 'high';
export type SizingAssessmentArDepth = 'minimal' | 'lean' | 'standard' | 'thorough' | 'comprehensive';

export interface SizingAssessmentReason {
  code: string;
  detail: string;
}

export interface SizingAssessmentSnapshot {
  stage: 'decomposition' | 'final';
  archetype: SizingAssessmentArchetype;
  verdict: SizingAssessmentVerdict;
  confidence: SizingAssessmentConfidence;
  preferredFeatureRange: { min: number; max: number };
  preferredArDepth: SizingAssessmentArDepth;
  minimumPreservedFeatureCount: number;
  explicitSplitSignals: string[];
  featureCount: number;
  acceptanceRequirementCount: number;
  averageAcceptanceRequirementsPerFeature: number;
  reasonCodes: string[];
  reasons: SizingAssessmentReason[];
}

export interface GenerationSizingAssessment {
  archetype: SizingAssessmentArchetype;
  verdict: SizingAssessmentVerdict;
  confidence: SizingAssessmentConfidence;
  preferredFeatureRange: { min: number; max: number };
  preferredArDepth: SizingAssessmentArDepth;
  minimumPreservedFeatureCount: number;
  explicitSplitSignals: string[];
  reasonCodes: string[];
  reasons: SizingAssessmentReason[];
  repairApplied: boolean;
  repairRejectedReason?: string;
  preRepairFeatureCount?: number;
  preRepairAcceptanceRequirementCount?: number;
  decomposition: SizingAssessmentSnapshot;
  final: SizingAssessmentSnapshot;
}

export interface GenerationStageDurationsMs {
  triage?: number;
  decomposition?: number;
  acceptanceRequirements?: number;
  backfill?: number;
  coverageCheck?: number;
  total?: number;
}

export interface GenerationContextMeta extends ContextSourceMeta {
  /** Pass-2 batched WI retrieval (chunk count merged into AR context). */
  pass2BatchWiChunkCount?: number;
  /** Backlog keys whose AR patterns were injected for Pass-2. */
  pass2ArPatternStoryKeys?: string[];
  /** Gold exemplar backlog keys injected into Pass-2 AR generation. */
  goldExampleIssueKeys?: string[];
  /** Optional Jira label filter used to resolve gold exemplars. */
  goldExampleLabel?: string;
  usageSource?: GenerationUsageSource;
  freeCreditConsumed?: boolean;
  selectedEvidenceSummary?: {
    wiDocCount: number;
    similarStoryCount: number;
    arPatternStoryCount: number;
    goldExampleIssueKeys?: string[];
    goldExampleLabel?: string;
  };
  sufficiencyStatus?: DiscoverySufficiencyResult['status'];
  sufficiencyReasonCodes?: string[];
  similarStoriesCount?: number;
  referencedSimilarStories?: ReferencedSimilarStory[];
  sizingContract?: EffectiveSizingContract;
  advisoryTriage?: AdvisoryTriageContract;
  sizingAssessment?: GenerationSizingAssessment;
  pass1DraftFeatureCount?: number;
  draftReviewTriggered?: boolean;
  draftReviewDecision?: DraftReviewDecision;
  draftReviewIterations?: number;
  openDecisions?: OpenDecision[];
  roleCoverage?: RoleCoverageItem[];
  coverageFindings?: CoverageFindings;
  coverageReview?: CoverageReviewAdvice;
  wiCoverageUsedByFeature?: Array<{ featureId: string; summary: string; behaviors: string[] }>;
  wiCoverageMisses?: string[];
  autoRepairedIssues?: string[];
  remainingBlockingIssues?: string[];
  requiresUserDecision?: boolean;
  failedFeatureIds?: string[];
  partialSuccess?: boolean;
  partialSuccessMessage?: string;
  stageDurationsMs?: GenerationStageDurationsMs;
  tokenUsage?: TokenUsageSummary;
  actorSets?: ActorSetGrounding;
  latencyMs?: PipelineLatencyBreakdown;
  modelRoute?: GenerationModelRoute;
  pipelineProfile?: PipelineProfile;
  qualityMode?: GenerationQualityMode;
  scopeContract?: ScopeContract;
  sharedEvidenceSignature?: string;
  sharedEvidenceReused?: boolean;
  arCoverageStats?: {
    featureCount: number;
    completeFeatureCount: number;
    incompleteFeatureCount: number;
    acceptanceRequirementCount: number;
    averageAcceptanceRequirementsPerFeature: number;
  };
}

export interface GenerationResult {
  features: Feature[];
  violations: ValidationViolation[];
  similarStories: SimilarStory[];
  sessionId: string;
  generationContext?: GenerationContextMeta;
  tokenUsage?: TokenUsageSummary;
}

export interface SimpleDiscoveryResult {
  questions: ClarifyQuestion[];
  tokenUsage: TokenUsageSummary;
}

export interface SimpleSufficiencyResult {
  sufficient: boolean;
  questions?: ClarifyQuestion[];
  reasonCodes?: string[];
}

export interface SimpleGenerationContext {
  wiDocsCount?: number;
  tokenUsage?: TokenUsageSummary;
  stageDurationsMs?: GenerationStageDurationsMs;
}

export interface StoryAssistantClarifyResult {
  questions: ClarifyQuestion[];
  tokenUsage: TokenUsageSummary;
  sources?: ContextSourceMeta;
}

export interface StoryAssistantSufficiencyResult {
  sufficient: boolean;
  questions?: ClarifyQuestion[];
  warning?: string;
  tokenUsage: TokenUsageSummary;
}

export interface StoryAssistantGenerationResult {
  features: Feature[];
  tokenUsage: TokenUsageSummary;
  stageDurationsMs?: GenerationStageDurationsMs;
  failedFeatureIds?: string[];
}

export interface TokenUsageSummary {
  input: number;
  output: number;
  total: number;
  byStage?: Record<string, { input: number; output: number; total: number }>;
}

// ─── Similar Stories ─────────────────────────────────────────────────────────

export interface SimilarStory {
  key: string;
  summary: string;
  description?: string;
  acceptanceCriteria?: string;
  url?: string;
  relevanceScore?: number;
}

// ─── Clarifying Questions ────────────────────────────────────────────────────

export interface ClarifyQuestion {
  categoryKey: ClarifyCategoryKey;
  category: string;
  intent: string;
  question: string;
  details?: string;
  suggestions: string[];
}

export interface ClarifyAnswer {
  question: string;
  answer: string;
  selectedSuggestions: string[];
  customAnswer?: string;
  categoryKey?: ClarifyCategoryKey;
  intent?: string;
}

// ─── Quick Refine ────────────────────────────────────────────────────────────

export type QuickRefineSurface = 'issue-panel' | 'issue-action';
export type QuickRefineSessionStatus = 'idle' | 'queued' | 'running' | 'needs_clarification' | 'draft' | 'handoff' | 'applied' | 'failed';

export interface QuickRefineQuestion {
  id: string;
  question: string;
  suggestions: string[];
}

export interface QuickRefineAnswer {
  questionId: string;
  question: string;
  answer: string;
  selectedSuggestions: string[];
}

export interface QuickRefineIssueFields {
  summary: string;
  description: string;
  acceptanceRequirements: AcceptanceRequirement[];
}

export interface SplitCandidate extends QuickRefineIssueFields {
  id: string;
  issueType: string;
  selected: boolean;
  storyPoints?: number;
  reason?: string;
  jiraIssueKey?: string;
  jiraIssueUrl?: string;
}

export interface QuickRefineContextMeta extends ContextSourceMeta {
  issueKey: string;
  issueType: string;
  activeFieldMapping: ProjectFieldMapping;
  outputFieldMapping: ProjectFieldMapping;
  similarStoriesCount?: number;
  referencedSimilarStories?: ReferencedSimilarStory[];
}

export interface QuickRefineDraft {
  currentIssue: QuickRefineIssueFields;
  diffBaseIssue?: QuickRefineIssueFields;
  splitCandidates: SplitCandidate[];
  clarifyAnswers: QuickRefineAnswer[];
  contextMeta?: QuickRefineContextMeta;
  tokenUsage?: TokenUsageSummary;
  changeSummary?: string[];
  handoffRecommended?: boolean;
  handoffReason?: string;
  updatedAt?: string;
}

export interface QuickRefineIssueContext {
  surface: QuickRefineSurface;
  issueKey: string;
  issueId?: string;
  projectKey: string;
  issueType: string;
  originalIssue: QuickRefineIssueFields;
  fieldMapping: ProjectFieldMapping;
  outputFieldMapping: ProjectFieldMapping;
  linkType: string;
  contextMeta: QuickRefineContextMeta;
  existingSessionId?: string | null;
  sessionStatus?: QuickRefineSessionStatus | null;
  updatedAt?: string | null;
}

export interface QuickRefineApplyResult {
  updatedIssueKey: string;
  createdIssues: Array<{
    candidateId: string;
    issueKey: string;
    issueUrl: string;
  }>;
  linkErrors: Array<{
    candidateId: string;
    error: string;
  }>;
}

export interface QuickRefineSession {
  sessionId: string;
  surface: QuickRefineSurface;
  issueKey: string;
  projectKey: string;
  issueType: string;
  modelProvider?: LlmProvider;
  modelOverride?: string;
  originalIssue: QuickRefineIssueFields;
  context: QuickRefineIssueContext;
  status: QuickRefineSessionStatus;
  questions?: QuickRefineQuestion[];
  draft?: QuickRefineDraft;
  handoffReason?: string;
  error?: string;
  updatedAt: string;
  createdAt: string;
  appliedAt?: string;
  applyResult?: QuickRefineApplyResult;
}

export interface QuickRefineEvent {
  sessionId: string;
  accountId: string;
  context: QuickRefineIssueContext;
  config: TenantConfig;
  modelOverride?: string;
}

// ─── Conversation / History ───────────────────────────────────────────────────

export interface ConversationTurn {
  turnType: 'generate' | 'refine' | 'clarify';
  requirement: string;
  inputSignature?: string;
  features: Feature[];
  similarStories: SimilarStory[];
  generationContext?: GenerationContextMeta;
  clarifyContext?: ClarifyContextMeta;
  tokenUsage?: TokenUsageSummary;
  feedback?: string;
  model: string;
  timestamp: string;
}

export interface PiiMaskingStats {
  enabled: boolean;
  totalRedactions: number;
  byType: Record<string, number>;
}

export interface TransparencyReport {
  reportId: string;
  sessionId: string;
  turnType: 'generate' | 'clarify' | 'refine' | 'ask';
  actorAccountId?: string;
  provider?: string;
  model?: string;
  projectKey?: string;
  requirementExcerpt?: string;
  decisionSummary: string[];
  contextUsage?: Record<string, unknown>;
  tokenUsage?: TokenUsageSummary;
  piiMasking: PiiMaskingStats;
  createdAt: string;
}

/** On-demand full-run capture for external pipeline / prompt review (developerTools.pipelineAuditEnabled). */
export type PipelineAuditPhase = 'clarify' | 'sufficiency' | 'generation';

export interface PipelineAuditLlmCallRecord {
  seq: number;
  phase: string;
  model: string;
  requestedModel?: string;
  resolvedModel?: string;
  provider?: LlmProvider;
  durationMs?: number;
  usage?: { input: number; output: number };
  maxTokens?: number;
  effectiveMaxTokens?: number;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  thinkingBudget?: number;
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
  thoughtTokens?: number;
  structuredOutputMode?: 'json_schema' | 'json_object' | 'prompt_only';
  reasoningControlMode?: 'reasoning_effort' | 'thinking_budget' | 'thinking_level' | 'openai_reasoning' | 'auto' | 'none';
  systemPrompt: string;
  userMessage: string;
  responseText: string;
  parseOutcome?: 'n/a' | 'clean_parse' | 'repaired_parse' | 'parse_failed' | 'parse_failed_after_retry';
  geminiFallbacks?: string[];
  jsonFailure?: {
    stage?: string;
    failureType?: string;
    validationError?: string;
    responseShape?: Record<string, string | number | boolean>;
    appearsTruncated?: boolean;
    appearsWrongStageEnvelope?: boolean;
  };
  piiMasking?: PiiMaskingStats;
}

/** Client-side progress polling telemetry (Custom UI → resolver → KVS read of progress key per successful poll). */
export interface PipelineAuditClientPollingStats {
  surface: 'clarify' | 'generation';
  pollIntervalMs: number;
  hiddenTabPollMultiplier: number;
  /** Successful `invoke(getClarifyResult|getProgress)` round-trips */
  invokeCount: number;
  /** Timer ticks skipped by hidden-tab downsampling */
  skippedDueToHiddenTab: number;
  /** `invoke` threw before a response (transient bridge/network) */
  transientInvokeErrors: number;
  totalInvokeDurationMs: number;
  minInvokeDurationMs?: number;
  maxInvokeDurationMs?: number;
  /** Wall time from hook start to terminal poll */
  elapsedClientMs: number;
  /** Same as invokeCount: one poll ⇒ one typical progress-key read on the server */
  estimatedKvsProgressReads: number;
  capturedAt: string;
}

export interface PipelineAuditBundle {
  schemaVersion: 1;
  sessionId: string;
  auditRunId: string;
  accountId?: string;
  createdAt: string;
  updatedAt: string;
  completedPhases: PipelineAuditPhase[];
  reviewerPrompt?: string;
  reviewerOutputSchema?: string;
  /** Per-run Custom UI polling; largest invokeCount × payload size drives KVS read GB */
  clientPolling?: {
    clarify?: PipelineAuditClientPollingStats;
    generation?: PipelineAuditClientPollingStats;
  };
  header: {
    primaryProjectKey?: string;
    projectKeys?: string[];
    generatorModels?: {
      pipelineProfile?: PipelineProfile;
      requestedPipelineProfile?: PipelineProfile;
      resolvedPipelineProfile?: PipelineProfile;
      requestedModelRoute?: GenerationModelRoute;
      resolvedModelRoute?: GenerationModelRoute;
      selectedModeHonored?: boolean;
      triageModel?: string;
      clarifyModel?: string;
      evaluateModel?: string;
      decompositionModel?: string;
      arModel?: string;
    };
    piiMaskingEnabled?: boolean;
    piiMaskingStats?: PiiMaskingStats;
  };
  userInputs?: {
    requirement?: string;
    attachmentText?: string;
    clarifyDiscoveryProfile?: unknown;
    clarifySizingContract?: unknown;
    clarifyAdvisoryTriage?: unknown;
  };
  discoveryContext?: {
    clarify?: {
      wiRetrievalQuery?: string;
      wiContextText?: string;
      similarStoriesText?: string;
      domainContext?: string;
      domainRoles?: string[];
      wiInsights?: WorkInstructionInsightArtifact;
    };
    generation?: {
      wiRetrievalQuery?: string;
      wiContextText?: string;
      similarStoriesText?: string;
      domainContext?: string;
      domainRoles?: string[];
      wiInsights?: WorkInstructionInsightArtifact;
    };
  };
  llmCalls: PipelineAuditLlmCallRecord[];
  clarify?: {
    questions?: ClarifyQuestion[];
    contextMeta?: ClarifyContextMeta;
    failure?: {
      code: string;
      message: string;
      retryable: boolean;
      stage: string;
      failureType: string;
      validationError?: string;
      responseShape?: Record<string, string | number | boolean>;
      appearsTruncated?: boolean;
      appearsWrongStageEnvelope?: boolean;
    };
    completedAt?: string;
  };
  sufficiency?: {
    evaluation?: Record<string, unknown>;
    completedAt?: string;
  };
  generation?: {
    clarifyAnswers?: ClarifyAnswer[];
    features?: Feature[];
    generationContext?: GenerationContextMeta;
    completedAt?: string;
  };
}

export interface PipelineAuditIndexEntry {
  sessionId: string;
  auditRunId: string;
  accountId?: string;
  createdAt: string;
  updatedAt: string;
  primaryProjectKey?: string;
  projectKeys?: string[];
  completedPhases: PipelineAuditPhase[];
  pipelineProfile?: PipelineProfile;
  requestedPipelineProfile?: PipelineProfile;
  resolvedPipelineProfile?: PipelineProfile;
  requestedModelRoute?: GenerationModelRoute;
  resolvedModelRoute?: GenerationModelRoute;
  generatorModels?: NonNullable<PipelineAuditBundle['header']['generatorModels']>;
  llmCallCount: number;
  clarifyQuestionCount: number;
  clarifyAnswerCount: number;
  featureCount: number;
  acceptanceRequirementCount: number;
  requirementPreview?: string;
}

export interface PipelineAuditShadowRunInput {
  caseId: string;
  sessionId: string;
  auditRunId: string;
  projectKey?: string;
  projectKeys?: string[];
  requirement: string;
  attachmentText: string;
  clarifyAnswers: ClarifyAnswer[];
  clarifyDiscoveryProfile?: unknown;
  clarifySizingContract?: unknown;
  clarifyAdvisoryTriage?: unknown;
  replayableStages: {
    clarify: boolean;
    sufficiency: boolean;
    generation: boolean;
  };
  recommendedStage: 'clarify' | 'generation';
  generatorModels?: NonNullable<PipelineAuditBundle['header']['generatorModels']>;
}

export interface PipelineAuditBenchmarkCase {
  caseId: string;
  sessionId: string;
  auditRunId: string;
  createdAt: string;
  updatedAt: string;
  primaryProjectKey?: string;
  projectKeys: string[];
  baseline: {
    completedPhases: PipelineAuditPhase[];
    llmCallCount: number;
    clarifyQuestionCount: number;
    clarifyAnswerCount: number;
    featureCount: number;
    acceptanceRequirementCount: number;
    sufficiencyStatus?: string;
  };
  inputs: {
    requirement: string;
    attachmentText: string;
    clarifyAnswers: ClarifyAnswer[];
    clarifyDiscoveryProfile?: unknown;
    clarifySizingContract?: unknown;
    clarifyAdvisoryTriage?: unknown;
  };
  shadowRunInput: PipelineAuditShadowRunInput;
  reviewerPrompt?: string;
  reviewerOutputSchema?: string;
}

export interface PipelineAuditBenchmarkSuite {
  schemaVersion: 1;
  generatedAt: string;
  caseCount: number;
  skippedMissingRequirementCount: number;
  summary: {
    totalLlmCalls: number;
    totalFeatures: number;
    totalAcceptanceRequirements: number;
    replayableClarifyCount: number;
    replayableGenerationCount: number;
    phaseCoverage: Record<PipelineAuditPhase, number>;
    providerCounts: Record<string, number>;
  };
  cases: PipelineAuditBenchmarkCase[];
}

export interface PipelineAuditShadowResultSnapshot {
  clarifyQuestions?: ClarifyQuestion[];
  sufficiencyEvaluation?: Record<string, unknown>;
  features?: Feature[];
  llmCallCount?: number;
}

export interface PipelineAuditShadowDiffSummary {
  baselineSufficiencyStatus?: string;
  candidateSufficiencyStatus?: string;
  sufficiencyStatusChanged: boolean;
  clarifyQuestionCountDelta: number;
  featureCountDelta: number;
  acceptanceRequirementCountDelta: number;
  llmCallCountDelta: number;
}

export interface ComplianceAuditEvent {
  eventId: string;
  timestamp: string;
  actorAccountId?: string;
  category: 'config' | 'security' | 'prompt' | 'runtime';
  action: string;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface Conversation {
  sessionId: string;
  title: string;
  turns: ConversationTurn[];
  saved: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Work Instructions ────────────────────────────────────────────────────────

export interface WiChunk {
  docId: string;
  filename: string;
  revision: string;
  chunkIndex: number;
  sectionLabel?: string;
  sectionKind?: 'heading' | 'step' | 'bullet' | 'table' | 'paragraph';
  text: string;
  tokenCount: number;
  facets?: WiFacet[];
}

export interface WiDoc {
  docId: string;
  filename: string;
  revision: string;
  chunkCount: number;
  uploadedAt: string;
  targetProjects?: string[];
}

// ─── Clarify Queue Event ──────────────────────────────────────────────────────

export interface ClarifyEvent {
  sessionId: string;
  accountId: string;
  requirement: string;
  inputSignature?: string;
  attachmentText: string;
  config: TenantConfig;
  license?: any;
  projectKey: string;
  projectKeys?: string[];
  /** Optional per-run WI scope; when set, retrieval is constrained to these docs. */
  selectedWiDocIds?: string[];
  round?: 1 | 2;
  priorAnswers?: ClarifyAnswer[];
  /** When set with config.developerTools.pipelineAuditEnabled, persist full audit bundle. */
  pipelineAudit?: boolean;
  auditRunId?: string;
  enqueuedAt?: number;
}

// ─── Generation Queue Event ───────────────────────────────────────────────────

export interface GenerationEvent {
  sessionId: string;
  accountId: string;
  requirement: string;
  clarifyAnswers: ClarifyAnswer[];
  attachmentText: string;
  config: TenantConfig;
  license?: { active: boolean; licenseType: string };
  projectKey: string;
  projectKeys?: string[];
  /** Optional per-run WI scope; when set, retrieval is constrained to these docs. */
  selectedWiDocIds?: string[];
  /** Discovery profile from the clarify LLM — retained for context/questioning only. */
  clarifyDiscoveryProfile?: DiscoveryProfile;
  /** Shared LLM sizing contract captured during discovery. */
  clarifySizingContract?: EffectiveSizingContract;
  /** Shared advisory triage contract captured during discovery. */
  clarifyAdvisoryTriage?: AdvisoryTriageContract;
  clarifyFinalSufficiency?: DiscoverySufficiencyResult;
  clarifyQuestionsAsked?: Array<string | { categoryKey?: string; intent?: string; question?: string }>;
  clarifyScopeContract?: ScopeContract;
  sharedEvidenceSignature?: string;
  /** Resume generation from an already-reviewed pass-1 draft. */
  reviewedDraftFeatures?: Feature[];
  reviewedDraftReview?: DraftReviewMetadata;
  reviewedDraftDecision?: DraftReviewDecision;
  reviewedDraftSelectedFeatureIds?: string[];
  reviewedDraftReviewIterations?: number;
  reviewedTriageSizingContract?: EffectiveSizingContract;
  reviewedAdvisoryTriage?: AdvisoryTriageContract;
  priorStageDurationsMs?: GenerationStageDurationsMs;
  retryFeatureId?: string;
  retryFeatureIds?: string[];
  retryFeature?: Feature;
  retryFeatures?: Feature[];
  retryBaseFeatures?: Feature[];
  /** When true, always pause after pass-1 feature decomposition for user review, regardless of quality issues. */
  pauseForDraftReview?: boolean;
  /** When set with config.developerTools.pipelineAuditEnabled, persist full audit bundle. */
  pipelineAudit?: boolean;
  auditRunId?: string;
  qualityMode?: GenerationQualityMode;
  modelOverrides?: GenerationModelOverrides;
  usageSource?: GenerationUsageSource;
  freeCreditConsumed?: boolean;
  enqueuedAt?: number;
}

// ─── Refine Queue Event ───────────────────────────────────────────────────────

export interface RefineEvent {
  sessionId: string;
  accountId: string;
  requirement: string;
  feedback: string;
  features: Feature[];
  config: TenantConfig;
  license?: any;
  projectKey: string;
  projectKeys?: string[];
  mode?: 'refine' | 'restructure' | 'add_feature';
  restructureScope?: RestructureScope;
  selectedFeatureIds?: string[];
  intent?: CanvasEditIntent;
  scope?: CanvasEditScope;
}

// ─── Project Activity ────────────────────────────────────────────────────────

export type ProjectActivityAction = 'clarify' | 'generate' | 'refine' | 'ask' | 'issue';

export interface ProjectActivityEvent {
  eventId: string;
  timestamp: string;
  projectKeys: string[];
  projectKey: string;
  action: ProjectActivityAction;
  sessionId?: string;
  model?: string;
  tokenUsage?: TokenUsageSummary;
  metadata?: Record<string, unknown>;
}

export interface ProjectActivitySummaryRow {
  projectKey: string;
  count: number;
  tokenUsage: number;
  latestAt?: string;
  actionCounts: Record<string, number>;
}

// ─── Tier Limits ─────────────────────────────────────────────────────────────

export interface TierLimits {
  generationsPerMonth: number;   // -1 = unlimited
  maxWiDocs: number;
  maxConfiguredProjects: number;
  similarStories: boolean;
  exportExcel: boolean;
}

export interface PreviewUsageCredits {
  fast: number;
  balanced: number;
  quality: number;
}

export const TIER_LIMITS: Record<TenantConfig['tier'], TierLimits> = {
  free: {
    generationsPerMonth: 5,
    maxWiDocs: 2,
    maxConfiguredProjects: 1,
    similarStories: false,
    exportExcel: false,
  },
  standard: {
    generationsPerMonth: 150,
    maxWiDocs: 25,
    maxConfiguredProjects: 10,
    similarStories: true,
    exportExcel: true,
  },
};
