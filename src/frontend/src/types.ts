// ─── Constants ───────────────────────────────────────────────────────────────
import strategyCatalog from './modelStrategyCatalog.json';

export const REDACTED = '•••••••• (Encrypted)';
const DEFAULT_ANTHROPIC_STABLE = strategyCatalog.providers.anthropic.presets.stable;

// ─── Tenant Configuration ────────────────────────────────────────────────────

export interface GoldSource {
  key: string;              // unique identifier e.g. "proj1"
  project: string;          // Jira project key e.g. "MYPROJ"
  issuetype: string;        // e.g. "Story", "Feature"
  /** @deprecated Prefer statuses — kept for backward compatibility */
  status?: string;          // e.g. "Done", "Released"
  statuses?: string[];      // e.g. ["Done", "Released"]
  maxItems: number;
  /** @deprecated Prefer arFieldIds — kept for backward compatibility */
  requirementsFieldId: string | null;
  /** Jira custom field IDs whose text is merged into gold acceptance_criteria (use many for multi-AR setups) */
  arFieldIds: string[];
  labels?: string[];                     // optional label filter
  targetProjects?: string[];
}

export type LlmProvider = 'forge_llms' | 'anthropic' | 'gemini' | 'openai' | 'azure_openai';
export type ModelFamily = 'pro' | 'flash' | 'lite' | 'latest' | 'custom';
export type ConcreteModelFamily = Exclude<ModelFamily, 'latest'>;
export type LatestModelSelector = 'latest' | 'latest-pro' | 'latest-flash' | 'latest-lite';
export type GeneratorModelStrategy = 'simple' | 'advanced' | 'stable' | 'latest' | 'custom';
export type GeneratorBucketClass = 'pro' | 'flash' | 'lite';

export interface GeneratorBucketClasses {
  discovery: GeneratorBucketClass;
  generation: GeneratorBucketClass;
  refinement: GeneratorBucketClass;
}

export interface LlmModelCatalogEntry {
  id: string;
  displayName?: string;
  family?: ConcreteModelFamily;
  isLatest?: boolean;
  releaseDate?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  aliases?: string[];
  deploymentName?: string;
  source?: 'discovered' | 'manual' | 'fallback';
}

export interface LlmVendorModelCatalog {
  vendor: LlmProvider;
  fetchedAt?: string;
  source?: 'discovered' | 'manual' | 'fallback';
  models: LlmModelCatalogEntry[];
}

export type LlmModelCatalogByVendor = Partial<Record<LlmProvider, LlmVendorModelCatalog>>;

export interface GeneratorConfig {
  provider: LlmProvider;
  modelStrategy: GeneratorModelStrategy;
  bucketClasses: GeneratorBucketClasses;
  modelStrategyVersion: string;
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
  azureOpenAIApiKey?: string;
  azureOpenAIBaseUrl?: string;
  azureOpenAIApiVersion?: string;
  modelCatalogs?: LlmModelCatalogByVendor;
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

export interface Branding {
  appTitle: string;
  logoUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
}

export interface ProjectArMapping {
  projectKey: string;   // e.g. "MYPROJ" or "*" for default
  issueType?: string;   // e.g. "Story" or "*"
  mode: 'consolidated' | 'iterative';
  consolidatedFieldId: string;
  iterativeFieldIds: string[];
  inputMappings: ProjectFieldMapping;
  outputMappings: ProjectFieldMapping;
  issueLinkType?: string;
}

export interface ProjectBacklogStatusScope {
  projectKey: string;
  statuses: string[];
}

export interface ProjectDomainContext {
  projectKey: string;
  context: string;
  personaRoles?: ProjectPersonaRole[];
}

export interface TenantConfig {
  goldSources: GoldSource[];
  generatorConfig: GeneratorConfig;
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
  domainContexts?: ProjectDomainContext[];
  backlogStatusScopes: ProjectBacklogStatusScope[];
  backlogThemeBudgetOverride?: number | null;
}

export interface UserPreferences {
  defaultProjectKey?: string;
  quickRefineModelByProvider?: Partial<Record<LlmProvider, string>>;
}

export const DEFAULT_CONFIG: TenantConfig = {
  goldSources: [],
  generatorConfig: {
    provider: 'anthropic',
    modelStrategy: 'simple',
    bucketClasses: {
      discovery: 'flash',
      generation: 'pro',
      refinement: 'flash',
    },
    modelStrategyVersion: strategyCatalog.version,
    decompositionModel: DEFAULT_ANTHROPIC_STABLE.pro[0],
    arModel: DEFAULT_ANTHROPIC_STABLE.pro[0],
    clarifyModel: DEFAULT_ANTHROPIC_STABLE.flash[0],
    refineModel: DEFAULT_ANTHROPIC_STABLE.flash[0],
    evaluateModel: DEFAULT_ANTHROPIC_STABLE.flash[0],
    triageModel: DEFAULT_ANTHROPIC_STABLE.flash[0],
    themeModel: DEFAULT_ANTHROPIC_STABLE.flash[0],
    maxTokens: 8192,
  },
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
    topKChunks: 8,
    maxChars: 100000,
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
  backlogStatusScopes: [],
  backlogThemeBudgetOverride: null,
};

// ─── Feature / Story Types ────────────────────────────────────────────────────

export interface AcceptanceRequirement {
  given: string;
  when: string;
  then: string;
}

export interface Feature {
  id: string;
  summary: string;
  description: string;          // "As a [role], I need to [action] so that [benefit]"
  acceptanceRequirements: AcceptanceRequirement[];
  storyPoints?: number;
  processCode?: string;          // only if taxonomy enabled
  jiraIssueKey?: string;
  jiraIssueUrl?: string;
}

export interface ValidationViolation {
  featureId: string;
  field: string;
  message: string;
}

export interface ReferencedGoldExample {
  key: string;
  source: string;
  summary: string;
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
  excerpt: string;
}

export type ClarifyCategoryKey =
  | 'context_trigger'
  | 'user_personas'
  | 'information_architecture'
  | 'business_rules'
  | 'state_lifecycle'
  | 'edge_cases_exceptions';

export type ClarifyDiscoveryStatus = 'needs_clarification' | 'ready_for_generation' | 'discovery_failed';
export type ClarifyFailureReasonCode =
  | 'timeout'
  | 'queue_error'
  | 'invalid_empty_questions'
  | 'invalid_underpowered_questions'
  | 'invalid_generic_questions';

export interface DiscoveryProfile {
  scope: 'narrow' | 'moderate' | 'broad' | 'very_broad';
  complexity: 'low' | 'medium' | 'high' | 'very_high';
  ambiguity: 'low' | 'medium' | 'high';
  missingCategoryKeys: ClarifyCategoryKey[];
  recommendedInitialCount: number;
  followupCap: number;
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
  clarity?: 'clear' | 'medium' | 'vague';
  questionPlan?: { min: number; max: number; target: number };
}

export interface ClarifyProgressPayload {
  stage?: 'context' | 'assessment' | 'question_generation' | 'finalize' | 'sufficiency' | 'followup';
  assessment?: ClarifyAssessmentSummary;
  sizingContract?: EffectiveSizingContract;
  discoveryProfile?: DiscoveryProfile;
  ambiguityAssessment?: ClarifyContextMeta['ambiguityAssessment'];
  sources?: {
    projectKey: string;
    projectCount?: number;
    domainContextApplied?: boolean;
    attachmentIncluded?: boolean;
    wiDocsCount?: number;
    similarStoriesCount?: number;
  };
}

export interface ContextSourceMeta {
  projectKey: string;
  projectKeys?: string[];
  projectCount?: number;
  domainRolesUsed: string[];
  domainContextApplied?: boolean;
  attachmentIncluded?: boolean;
  wiDocsCount?: number;
  referencedWiDocs?: Array<{ docId: string; filename: string; chunkCount: number }>;
  referencedWiSections?: ReferencedWiSection[];
}

export interface ClarifyContextMeta extends ContextSourceMeta {
  discoveryStatus?: ClarifyDiscoveryStatus;
  failureReasonCode?: ClarifyFailureReasonCode;
  goldExamplesCount?: number;
  referencedGoldExamples?: ReferencedGoldExample[];
  similarStoriesCount?: number;
  referencedSimilarStories?: ReferencedSimilarStory[];
  sizingContract?: EffectiveSizingContract;
  discoveryProfile?: DiscoveryProfile;
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
  repair?: number;
  total?: number;
}

export interface GenerationContextMeta extends ContextSourceMeta {
  goldExamplesCount?: number;
  referencedGoldExamples?: ReferencedGoldExample[];
  similarStoriesCount?: number;
  referencedSimilarStories?: ReferencedSimilarStory[];
  sizingContract?: EffectiveSizingContract;
  sizingAssessment?: GenerationSizingAssessment;
  pass1DraftFeatureCount?: number;
  draftReviewTriggered?: boolean;
  draftReviewDecision?: 'keep' | 'consolidate';
  stageDurationsMs?: GenerationStageDurationsMs;
  tokenUsage?: TokenUsageSummary;
}

export interface GenerationResult {
  features: Feature[];
  violations: ValidationViolation[];
  similarStories: SimilarStory[];
  sessionId: string;
  generationContext?: GenerationContextMeta;
  tokenUsage?: TokenUsageSummary;
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

export interface Conversation {
  sessionId: string;
  title: string;
  turns: ConversationTurn[];
  saved: boolean;
  createdAt: string;
  updatedAt: string;
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

export type ProjectActivityAction = 'clarify' | 'generate' | 'refine' | 'ask' | 'issue';

export interface ProjectActivitySummaryRow {
  projectKey: string;
  count: number;
  tokenUsage: number;
  latestAt?: string;
  actionCounts: Record<string, number>;
}

// ─── Work Instructions ────────────────────────────────────────────────────────

export interface WiChunk {
  docId: string;
  filename: string;
  revision: string;
  chunkIndex: number;
  text: string;
  tokenCount: number;
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
  attachmentText: string;
  config: TenantConfig;
  license?: any;
  projectKey?: string;
  projectKeys?: string[];
  round?: 1 | 2;
  priorAnswers?: ClarifyAnswer[];
}

// ─── Generation Queue Event ───────────────────────────────────────────────────

export interface GenerationEvent {
  sessionId: string;
  accountId: string;          // Atlassian account ID of the initiating user
  requirement: string;
  clarifyAnswers: ClarifyAnswer[];
  attachmentText: string;
  config: TenantConfig;
  projectKey?: string;
  projectKeys?: string[];
  goldExamples: string;
  wiContext: string;
  reviewedDraftFeatures?: Feature[];
  reviewedDraftDecision?: 'keep' | 'consolidate';
  reviewedTriageSizingContract?: EffectiveSizingContract;
  priorStageDurationsMs?: GenerationStageDurationsMs;
}

// ─── Tier Limits ─────────────────────────────────────────────────────────────

export interface TierLimits {
  generationsPerMonth: number;   // -1 = unlimited
  maxWiDocs: number;
  maxConfiguredProjects: number;
  similarStories: boolean;
  exportExcel: boolean;
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
