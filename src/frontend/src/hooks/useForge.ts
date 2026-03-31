import { invoke } from '@forge/bridge';

type Payload = Record<string, unknown>;
const p = (v: unknown) => v as Payload;
type ReasoningMode = 'fast' | 'deep';
type OutputMode = 'single' | 'auto' | 'full_breakdown';

// Typed invoke wrapper for all resolver calls
export const api = {
  // Config
  getConfig: (payload?: { projectKey?: string }) => invoke('getConfig', payload || {}),
  saveConfig: (config: unknown) => invoke('saveConfig', p(config)),
  saveProjectConfig: (payload: any) => invoke('saveProjectConfig', payload),
  patchConfig: (patch: unknown) => invoke('patchConfig', p(patch)),

  // Generation progress (polling)
  getProgress: (sessionId: string) => invoke('getProgress', { sessionId }),

  // Generation
  startGeneration: (payload: {
    sessionId: string;
    requirement: string;
    clarifyAnswers?: unknown[];
    attachmentText?: string;
    projectKey?: string;
    reasoningMode?: ReasoningMode;
    outputMode?: OutputMode;
    outputInstructions?: string;
  }) => invoke('startGeneration', payload),

  // Clarify (async queue)
  startClarify: (
    sessionId: string,
    requirement: string,
    attachmentText?: string,
    projectKey?: string,
    reasoningMode?: ReasoningMode,
    outputMode?: OutputMode,
    outputInstructions?: string,
  ) =>
    invoke('startClarify', { sessionId, requirement, attachmentText, projectKey, reasoningMode, outputMode, outputInstructions }),
  getClarifyResult: (sessionId: string) =>
    invoke('getClarifyResult', { sessionId }),
  evaluateSufficiency: (sessionId: string, requirement: string, answers: unknown[], projectKey?: string, reasoningMode?: ReasoningMode) =>
    invoke('evaluateSufficiency', { sessionId, requirement, answers, projectKey, reasoningMode }),
  saveDiscoveryRound: (payload: {
    sessionId: string;
    roundNumber: number;
    questions: unknown[];
    answers: unknown[];
    coverage?: unknown;
  }) => invoke('saveDiscoveryRound', payload),

  // Refine
  refineFeatures: (sessionId: string, requirement: string, features: unknown[], feedback: string, outputInstructions?: string) =>
    invoke('refineFeatures', { sessionId, requirement, features, feedback, outputInstructions }),
  refineSingleFeature: (feature: unknown, feedback: string, sessionId?: string, outputInstructions?: string) =>
    invoke('refineSingleFeature', { feature, feedback, sessionId, outputInstructions }),
  checkRefineFeedback: (feature: unknown, feedback: string) =>
    invoke('checkRefineFeedback', { feature, feedback }),

  // Ask
  ask: (message: string, history: unknown[]) =>
    invoke('ask', { message, history }),

  // Jira
  createIssue: (payload: {
    feature: unknown;
    featureId?: string;
    projectKey: string;
    issueType: string;
    reporterAccountId?: string;
    assigneeAccountId?: string;
    originIssueKey?: string;
    sessionId?: string;
  }) => invoke('createIssue', p(payload)),
  searchUsers: (query: string) => invoke('searchUsers', { query }),
  discoverJira: (projectKey?: string) => invoke('discoverJira', { projectKey }),
  discoverIssueTypes: (projectKey: string) => invoke('discoverIssueTypes', { projectKey }),
  discoverStatuses: (projectKey: string) => invoke('discoverStatuses', { projectKey }),
  discoverLinkTypes: () => invoke('discoverLinkTypes'),

  // Work Instructions
  uploadWi: (filename: string, fileBase64: string, revision?: string, projectKey?: string) =>
    invoke('uploadWi', { filename, fileBase64, revision, projectKey }),
  listWiDocs: (projectKey?: string) => invoke('listWiDocs', { projectKey }),
  removeWiDoc: (docId: string) => invoke('removeWiDoc', { docId }),

  // Cache
  getCacheInfo: () => invoke('getCacheInfo'),
  refreshCache: () => invoke('refreshCache'),
  getBacklogCacheInfo: (projectKey: string) => invoke('getBacklogCacheInfo', { projectKey }),
  diagnoseBacklogCache: (projectKey: string) => invoke('diagnoseBacklogCache', { projectKey }),
  refreshBacklogCache: (projectKey: string) => invoke('refreshBacklogCache', { projectKey }),

  // History
  getHistory: (limit?: number) => invoke('getHistory', { limit }),
  getConversation: (sessionId: string) => invoke('getConversation', { sessionId }),
  saveConversation: (sessionId: string) => invoke('saveConversation', { sessionId }),
  deleteConversation: (sessionId: string) => invoke('deleteConversation', { sessionId }),
  renameConversation: (sessionId: string, title: string) =>
    invoke('renameConversation', { sessionId, title }),
  toggleBookmark: (sessionId: string, isPinned: boolean) =>
    invoke('toggleBookmark', { sessionId, isPinned }),
  updateConversationFeatures: (sessionId: string, features: any[]) =>
    invoke('updateConversationFeatures', { sessionId, features }),

  // Session persistence
  getLastSession: () => invoke('getLastSession'),
  setLastSession: (sessionId: string) => invoke('setLastSession', { sessionId }),
  getIssueSession: (issueKey: string) => invoke('getIssueSession', { issueKey }),
  setIssueSession: (issueKey: string, sessionId: string) => invoke('setIssueSession', { issueKey, sessionId }),
  getSidebarWidth: () => invoke('getSidebarWidth'),
  setSidebarWidth: (width: number) => invoke('setSidebarWidth', { width }),

  // Usage
  getUsage: () => invoke('getUsage'),
  getAiInsights: () => invoke('getAiInsights'),
  resetUsage: () => invoke('resetUsage'),
  listComplianceAuditEvents: (limit?: number) => invoke('listComplianceAuditEvents', { limit }),
  listTransparencyReports: (payload?: { sessionId?: string; turnType?: 'generate' | 'clarify' | 'refine' | 'ask'; limit?: number }) =>
    invoke('listTransparencyReports', payload || {}),
  getJiraAuditRecords: (limit?: number) => invoke('getJiraAuditRecords', { limit }),

  // LLM config
  checkIsAdmin: (payload?: any) => invoke('checkIsAdmin', payload),
  fetchAvailableModels: (provider: 'openai' | 'gemini') =>
    invoke('fetchAvailableModels', { provider }),
  testLlmConnection: (payload: {
    provider: 'forge_llms' | 'gemini' | 'openai' | 'azure_openai' | 'bedrock';
    model: string;
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    azureOpenaiApiKey?: string;
    azureOpenaiEndpoint?: string;
    azureOpenaiDeployment?: string;
    azureOpenaiApiVersion?: string;
    bedrockAccessKeyId?: string;
    bedrockSecretAccessKey?: string;
    bedrockSessionToken?: string;
    bedrockRegion?: string;
  }) => invoke('testLlmConnection', payload),
};

export type ApiResponse<T> = { success: boolean; error?: string } & T;
