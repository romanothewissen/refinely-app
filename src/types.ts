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

export type LlmProvider = 'forge_llms' | 'gemini' | 'openai' | 'azure_openai';
export type ModelFamily = 'pro' | 'flash' | 'lite' | 'latest' | 'custom';
export type ConcreteModelFamily = Exclude<ModelFamily, 'latest'>;
export type LatestModelSelector = 'latest' | 'latest-pro' | 'latest-flash' | 'latest-lite';

export interface LlmModelCatalogEntry {
  id: string;                         // runtime model or deployment identifier
  displayName?: string;               // human-friendly label for settings/UI
  family?: ConcreteModelFamily;       // inferred or curated family bucket
  isLatest?: boolean;                 // marks the preferred/current model in a family
  releaseDate?: string;               // ISO timestamp when known
  contextWindowTokens?: number;
  maxOutputTokens?: number;
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

export interface GeneratorConfig {
  provider: LlmProvider;
  decompositionModel: string;   // e.g. claude-opus-4-6, gpt-4o
  arModel: string;              // e.g. claude-opus-4-6, gpt-4o
  clarifyModel: string;         // e.g. claude-sonnet-4-6, gpt-4o-mini
  refineModel: string;          // e.g. claude-opus-4-6, gpt-4o
  evaluateModel: string;        // e.g. claude-haiku-4-5, gpt-4o-mini
  triageModel: string;          // e.g. claude-haiku-4-5, gpt-4o-mini — fast scope/complexity assessment
  themeModel: string;           // e.g. claude-haiku-4-5, gpt-4o-mini
  maxTokens: number;            // default: 8192
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

export interface ProjectArMapping {
  projectKey: string;   // e.g. "MYPROJ" or "*" for default
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
  backlogThemeBudgetOverride?: number | null;
}

export const DEFAULT_CONFIG: TenantConfig = {
  goldSources: [],
  generatorConfig: {
    provider: 'forge_llms',
    decompositionModel: 'claude-opus-4-6',
    arModel: 'claude-opus-4-6',
    clarifyModel: 'claude-sonnet-4-5-20250929',
    refineModel: 'claude-opus-4-6',
    evaluateModel: 'claude-haiku-4-5-20251001',
    triageModel: 'claude-haiku-4-5-20251001',
    themeModel: 'claude-haiku-4-5-20251001',
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
}

export interface ReferencedWiSection {
  docId: string;
  filename: string;
  chunkIndex: number;
  excerpt: string;
}

export interface DiscoveryProfile {
  scope: 'narrow' | 'moderate' | 'broad' | 'very_broad';
  complexity: 'low' | 'medium' | 'high' | 'very_high';
  ambiguity: 'low' | 'medium' | 'high';
  missingDimensions: string[];
  recommendedInitialCount: number;
  followupCap: number;
}

export interface DiscoverySufficiencyResult {
  evaluated: boolean;
  sufficient: boolean | null;
  roundEvaluated: number;
  missingDimensions: string[];
  reasonCodes: string[];
}

export interface ContextSourceMeta {
  projectKey: string;
  domainRolesUsed: string[];
  domainContextApplied?: boolean;
  attachmentIncluded?: boolean;
  wiDocsCount?: number;
  referencedWiDocs?: Array<{ docId: string; filename: string; chunkCount: number }>;
  referencedWiSections?: ReferencedWiSection[];
}

export interface ClarifyContextMeta extends ContextSourceMeta {
  goldExamplesCount?: number;
  referencedGoldExamples?: ReferencedGoldExample[];
  similarStoriesCount?: number;
  referencedSimilarStories?: ReferencedSimilarStory[];
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

export interface GenerationContextMeta extends ContextSourceMeta {
  goldExamplesCount?: number;
  referencedGoldExamples?: ReferencedGoldExample[];
  similarStoriesCount?: number;
  referencedSimilarStories?: ReferencedSimilarStory[];
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
  sessionId: string;
  accountId: string;
  requirement: string;
  attachmentText: string;
  config: TenantConfig;
  license?: any;
  projectKey: string;
  round?: 1 | 2;
  priorAnswers?: ClarifyAnswer[];
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
  goldExamples?: string;
  goldExamplesCount?: number;
  wiContext?: string;
  projectKey: string;
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
