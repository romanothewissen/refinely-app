// ─── Constants ───────────────────────────────────────────────────────────────
export const REDACTED = '•••••••• (Encrypted)';

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
}

export interface GeneratorConfig {
  provider: 'forge_llms' | 'gemini' | 'openai';
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
}

export interface ProcessCode {
  code: string;
  name: string;
  definition: string;
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
  tier: 'free' | 'team' | 'enterprise';
  issueLinkType: string;  // default: 'Relates to'
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
  issueLinkType: 'Relates to',
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

export interface ContextSourceMeta {
  projectKey: string;
  domainRolesUsed: string[];
  domainContextApplied?: boolean;
  attachmentIncluded?: boolean;
  wiDocsCount?: number;
  referencedWiDocs?: Array<{ docId: string; filename: string; chunkCount: number }>;
}

export interface ClarifyContextMeta extends ContextSourceMeta {
  usesGoldenExamples: false;
  usesSimilarStories: false;
}

export interface GenerationContextMeta extends ContextSourceMeta {
  goldExamplesCount: number;
  referencedGoldExamples: ReferencedGoldExample[];
  similarStoriesCount?: number;
  referencedSimilarStories?: ReferencedSimilarStory[];
}

export interface GenerationResult {
  features: Feature[];
  violations: ValidationViolation[];
  similarStories: SimilarStory[];
  sessionId: string;
  generationContext?: GenerationContextMeta;
  tokenUsage?: { input: number; output: number };
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
  requirement: string;
  attachmentText: string;
  config: TenantConfig;
}

// ─── Generation Queue Event ───────────────────────────────────────────────────

export interface GenerationEvent {
  sessionId: string;
  accountId: string;          // Atlassian account ID of the initiating user
  requirement: string;
  clarifyAnswers: ClarifyAnswer[];
  attachmentText: string;
  config: TenantConfig;
  goldExamples: string;
  wiContext: string;
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
    generationsPerMonth: 20,
    maxGoldSources: 1,
    maxWiDocs: 2,
    similarStories: false,
    exportExcel: false,
    customBranding: false,
    processTaxonomy: false,
    maxUsers: 3,
  },
  team: {
    generationsPerMonth: 200,
    maxGoldSources: 3,
    maxWiDocs: 10,
    similarStories: true,
    exportExcel: true,
    customBranding: false,
    processTaxonomy: false,
    maxUsers: 25,
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
