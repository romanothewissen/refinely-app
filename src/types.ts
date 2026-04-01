// ─── Constants ───────────────────────────────────────────────────────────────
export const REDACTED = '•••••••• (Encrypted)';

// ─── Tenant Configuration ────────────────────────────────────────────────────

export interface GoldSource {
  key: string;              // unique identifier e.g. "proj1"
  project: string;          // Jira project key e.g. "MYPROJ"
  issuetype: string;        // e.g. "Story", "Feature"
  /** @deprecated Prefer statuses — kept for backward compatibility */
  status?: string;           // e.g. "Done", "Released"
  statuses?: string[];       // e.g. ["Done", "Released"]
  maxItems: number;
  /** @deprecated Prefer arFieldIds — kept for backward compatibility */
  requirementsFieldId: string | null;
  /** Jira custom field IDs whose text is merged into gold acceptance_criteria (use many for multi-AR setups) */
  arFieldIds: string[];
  labels?: string[];                     // optional label filter
  targetProjects?: string[];              // list of project keys that should use this source (use "*" for global)
}

export interface GeneratorConfig {
  provider: LlmProvider;
  profileMode: AiProfileMode;
  fastProfileProvider: LlmProvider;
  deepProfileProvider: LlmProvider;
  fastProfileModel: string;
  deepProfileModel: string;
  decompositionModel: string;   // e.g. claude-opus-4-6, gpt-4o
  arModel: string;              // e.g. claude-opus-4-6, gpt-4o
  clarifyModel: string;         // e.g. claude-sonnet-4-6, gpt-4o-mini
  refineModel: string;          // e.g. claude-opus-4-6, gpt-4o
  evaluateModel: string;        // e.g. claude-haiku-4-5, gpt-4o-mini
  themeModel: string;           // e.g. claude-haiku-4-5, gpt-4o-mini
  maxTokens: number;            // default: 8192
  geminiApiKey?: string;
  geminiBaseUrl?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  azureOpenaiApiKey?: string;
  azureOpenaiEndpoint?: string;
  azureOpenaiDeployment?: string;
  azureOpenaiApiVersion?: string;
}

export type LlmProvider = 'forge_llms' | 'gemini' | 'openai' | 'azure_openai';
export type AiProfileMode = 'simplified';
export type AiPolicyPreset = 'balanced' | 'delivery' | 'discovery' | 'enterprise';
export type ReasoningMode = 'fast' | 'deep';
export type OutputMode = 'single' | 'auto' | 'full_breakdown';
export type ScopeMode = 'atomic' | 'focused' | 'standard' | 'initiative';
export type ClarificationMode = 'none' | 'light' | 'standard' | 'deep';

export interface ClarifyQuestionPlan {
  min: number;
  max: number;
  target: number;
  clarity: 'clear' | 'medium' | 'vague';
}

export interface FeaturePlan {
  min: number;
  max: number;
  target: number;
  shape: 'narrow' | 'balanced' | 'broad';
  complexity: 'low' | 'medium' | 'high';
}

export interface ArPlan {
  min: number;
  max: number;
  target: number;
  depth: 'lean' | 'standard' | 'thorough';
}

export interface PlannerDecision {
  reasoningMode: ReasoningMode;
  outputMode: OutputMode;
  scopeMode: ScopeMode;
  clarificationMode: ClarificationMode;
  questionPlan: ClarifyQuestionPlan;
  featurePlan: FeaturePlan;
  arPlan: ArPlan;
  useHierarchy: boolean;
  confidence: number;
  ambiguityScore: number;
  ambiguityReasons: string[];
  rationale: string[];
}

export interface AiExecutionPolicy {
  workspacePreset: AiPolicyPreset;
  defaultReasoningMode: ReasoningMode;
  defaultOutputMode: OutputMode;
  allowReasoningModeOverride: boolean;
  allowOutputModeOverride: boolean;
  simpleAskMaxQuestions: number;
  deepModeRoundTarget: number;
  enterpriseMaxQuestionsPerRound: number;
  maxDeepDiscoveryRounds: number;
  hideModelSelectionFromEndUsers: boolean;
}

export interface AiSessionInsight {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  projectKey: string;
  reasoningMode?: ReasoningMode;
  outputMode?: OutputMode;
  scopeMode?: ScopeMode;
  clarificationMode?: ClarificationMode;
  plannedFeatureTarget?: number;
  plannedQuestionTarget?: number;
  initialClarifyQuestionCount?: number;
  discoveryRounds?: number;
  totalDiscoveryQuestions?: number;
  totalDiscoveryAnswers?: number;
  latestCoverageScore?: number | null;
  latestMissingCriticalCount?: number;
  generatedFeatureCount?: number;
  initiativeGroupCount?: number;
}

export interface AiInsightsBreakdownItem {
  key: string;
  count: number;
  avgFeatures: number;
  avgDiscoveryRounds: number;
  avgCoverageScore: number | null;
}

export interface AiInsightRecentSession {
  sessionId: string;
  updatedAt: string;
  projectKey: string;
  scopeMode?: ScopeMode;
  reasoningMode?: ReasoningMode;
  outputMode?: OutputMode;
  generatedFeatureCount?: number;
  discoveryRounds?: number;
  latestCoverageScore?: number | null;
}

export interface AiInsightsReport {
  generatedAt: string;
  totalSessions: number;
  clarifySessions: number;
  generatedSessions: number;
  avgFeatureCount: number;
  avgDiscoveryRounds: number;
  avgQuestionsPerClarifySession: number;
  avgCoverageScore: number | null;
  overTargetFeatureSessions: number;
  singleFeatureSessions: number;
  multiRoundSessions: number;
  initiativeSessions: number;
  scopeBreakdown: AiInsightsBreakdownItem[];
  reasoningBreakdown: AiInsightsBreakdownItem[];
  outputBreakdown: AiInsightsBreakdownItem[];
  projectBreakdown: Array<{ key: string; count: number }>;
  recentSessions: AiInsightRecentSession[];
}

export interface ProjectAiPolicy {
  projectKey: string;
  preset: AiPolicyPreset | 'inherit';
  defaultReasoningMode?: ReasoningMode;
  defaultOutputMode?: OutputMode;
  profileMode?: AiProfileMode;
  fastProfileProvider?: LlmProvider;
  fastProfileModel?: string;
  deepProfileProvider?: LlmProvider;
  deepProfileModel?: string;
  allowReasoningModeOverride?: boolean;
  allowOutputModeOverride?: boolean;
  simpleAskMaxQuestions?: number;
  deepModeRoundTarget?: number;
  enterpriseMaxQuestionsPerRound?: number;
  maxDeepDiscoveryRounds?: number;
}

export interface ProcessCode {
  code: string;
  name: string;
  definition: string;
}

export interface ProjectArMapping {
  projectKey: string;   // e.g. "MYPROJ" or "*" for default
  mode: 'consolidated' | 'iterative';
  consolidatedFieldId: string;
  iterativeFieldIds: string[];
  issueLinkType?: string; // per-project link type
}

export interface ProjectDomainContext {
  projectKey: string;
  context: string;
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

export interface TenantConfig {
  goldSources: GoldSource[];
  generatorConfig: GeneratorConfig;
  aiExecutionPolicy: AiExecutionPolicy;
  domainContext: string;
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
  tier: 'free' | 'standard' | 'premium' | 'enterprise';
  compliance: {
    enabled: boolean;
    transparencyReportsEnabled: boolean;
    piiMaskingEnabled: boolean;
    auditTrailEnabled: boolean;
  };
  issueLinkType: string;  // default: 'Relates to'
  arMappings: ProjectArMapping[];
  domainContexts: ProjectDomainContext[];
  backlogStatusScopes: ProjectBacklogStatusScope[];
  projectAiPolicies: ProjectAiPolicy[];
}

export const DEFAULT_CONFIG: TenantConfig = {
  goldSources: [],
  generatorConfig: {
    provider: 'forge_llms',
    profileMode: 'simplified',
    fastProfileProvider: 'forge_llms',
    deepProfileProvider: 'forge_llms',
    fastProfileModel: 'claude-sonnet-4-6',
    deepProfileModel: 'claude-opus-4-6',
    decompositionModel: 'claude-opus-4-6',
    arModel: 'claude-sonnet-4-6',
    clarifyModel: 'claude-sonnet-4-6',
    refineModel: 'claude-haiku-4-5-20251001',
    evaluateModel: 'claude-haiku-4-5-20251001',
    themeModel: 'claude-haiku-4-5-20251001',
    maxTokens: 8192,
    azureOpenaiApiVersion: '2024-10-21',
  },
  aiExecutionPolicy: {
    workspacePreset: 'balanced',
    defaultReasoningMode: 'fast',
    defaultOutputMode: 'auto',
    allowReasoningModeOverride: true,
    allowOutputModeOverride: true,
    simpleAskMaxQuestions: 4,
    deepModeRoundTarget: 6,
    enterpriseMaxQuestionsPerRound: 10,
    maxDeepDiscoveryRounds: 3,
    hideModelSelectionFromEndUsers: true,
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
  tier: 'free',
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
    }
  ],
  domainContexts: [
    {
      projectKey: '*',
      context: '',
    }
  ],
  backlogStatusScopes: [],
  projectAiPolicies: [],
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
}

export interface InitiativeGroup {
  id: string;
  title: string;
  summary: string;
  featureIds: string[];
}

export interface DiscoveryCoverageDimension {
  key: string;
  label: string;
  required: boolean;
  score: number;
  status: 'missing' | 'partial' | 'covered';
  evidence: string;
}

export interface DiscoveryCoverageResult {
  sufficient: boolean;
  canGenerate: boolean;
  shouldContinueDiscovery: boolean;
  overallScore: number;
  summary: string;
  missingCritical: string[];
  dimensions: DiscoveryCoverageDimension[];
  questions?: ClarifyQuestion[];
  tokenUsage?: TokenUsageSummary;
}

export interface DiscoveryRoundTranscript {
  roundNumber: number;
  questions: ClarifyQuestion[];
  answers: ClarifyAnswer[];
  coverage?: DiscoveryCoverageResult;
  submittedAt: string;
}

export interface ContextSourceMeta {
  projectKey: string;
  domainRolesUsed: string[];
  domainContextApplied?: boolean;
  attachmentIncluded?: boolean;
  wiDocsCount?: number;
  referencedWiDocs?: Array<{ docId: string; filename: string; chunkCount: number }>;
}

export interface ClarifyContextMeta extends ContextSourceMeta {
  plannerDecision?: PlannerDecision;
  goldExamplesCount?: number;
  referencedGoldExamples?: ReferencedGoldExample[];
  similarStoriesCount?: number;
  referencedSimilarStories?: ReferencedSimilarStory[];
  discoveryCoverage?: DiscoveryCoverageResult;
  discoveryTranscript?: DiscoveryRoundTranscript[];
  ambiguityAssessment?: {
    level: 'clear' | 'medium' | 'vague';
    score: number;
    reasons: string[];
    questionPlan: { min: number; max: number; target: number };
    generatedQuestions: number;
  };
  tokenUsage?: TokenUsageSummary;
}

export interface GenerationContextMeta extends ContextSourceMeta {
  plannerDecision?: PlannerDecision;
  goldExamplesCount: number;
  referencedGoldExamples: ReferencedGoldExample[];
  similarStoriesCount?: number;
  referencedSimilarStories?: ReferencedSimilarStory[];
  initiativeGroups?: InitiativeGroup[];
  discoveryCoverage?: DiscoveryCoverageResult;
  discoveryTranscript?: DiscoveryRoundTranscript[];
  tokenUsage?: TokenUsageSummary;
}

export interface GenerationResult {
  features: Feature[];
  violations: ValidationViolation[];
  similarStories: SimilarStory[];
  sessionId: string;
  plannerDecision?: PlannerDecision;
  initiativeGroups?: InitiativeGroup[];
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
  category: string;
  question: string;
  suggestions: string[];
}

export interface ClarifyAnswer {
  question: string;
  answer: string;
}

// ─── Conversation / History ───────────────────────────────────────────────────

export interface ConversationTurn {
  turnType: 'generate' | 'refine' | 'clarify';
  requirement: string;
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
  runId: string;
  sessionId: string;
  accountId: string;
  requirement: string;
  attachmentText: string;
  config: TenantConfig;
  license?: any;
  projectKey: string;
  reasoningMode?: ReasoningMode;
  outputMode?: OutputMode;
}

// ─── Generation Queue Event ───────────────────────────────────────────────────

export interface GenerationEvent {
  runId: string;
  sessionId: string;
  accountId: string;
  requirement: string;
  clarifyAnswers: ClarifyAnswer[];
  attachmentText: string;
  config: TenantConfig;
  license?: { active: boolean; licenseType: string };
  goldExamples?: string;
  goldExamplesCount?: number;
  wiContext?: string;
  projectKey: string;
  reasoningMode?: ReasoningMode;
  outputMode?: OutputMode;
}

// ─── Tier Limits ─────────────────────────────────────────────────────────────

export interface TierLimits {
  generationsPerMonth: number;   // -1 = unlimited
  maxGoldSources: number;
  maxWiDocs: number;
  similarStories: boolean;
  exportExcel: boolean;
  customBranding: boolean;
  processTaxonomy: boolean;
  maxUsers: number;
}

export const TIER_LIMITS: Record<TenantConfig['tier'], TierLimits> = {
  free: {
    generationsPerMonth: 5,
    maxGoldSources: 1,
    maxWiDocs: 2,
    similarStories: false,
    exportExcel: false,
    customBranding: false,
    processTaxonomy: false,
    maxUsers: 5,
  },
  standard: {
    generationsPerMonth: 250,
    maxGoldSources: 5,
    maxWiDocs: 15,
    similarStories: false,
    exportExcel: true,
    customBranding: false,
    processTaxonomy: false,
    maxUsers: 50,
  },
  premium: {
    generationsPerMonth: -1,
    maxGoldSources: -1,
    maxWiDocs: -1,
    similarStories: true,
    exportExcel: true,
    customBranding: true,
    processTaxonomy: true,
    maxUsers: -1,
  },
  enterprise: {
    generationsPerMonth: -1,
    maxGoldSources: -1,
    maxWiDocs: -1,
    similarStories: true,
    exportExcel: true,
    customBranding: true,
    processTaxonomy: true,
    maxUsers: -1,
  },
};
