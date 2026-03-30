import { invoke } from '@forge/bridge';

type Payload = Record<string, unknown>;
const p = (v: unknown) => v as Payload;

// Typed invoke wrapper for all resolver calls
export const api = {
  // Config
  getConfig: () => invoke('getConfig'),
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
  }) => invoke('startGeneration', payload),

  // Clarify (async queue)
  startClarify: (sessionId: string, requirement: string, attachmentText?: string) =>
    invoke('startClarify', { sessionId, requirement, attachmentText }),
  getClarifyResult: (sessionId: string) =>
    invoke('getClarifyResult', { sessionId }),
  evaluateSufficiency: (requirement: string, answers: unknown[]) =>
    invoke('evaluateSufficiency', { requirement, answers }),

  // Refine
  refineFeatures: (sessionId: string, requirement: string, features: unknown[], feedback: string) =>
    invoke('refineFeatures', { sessionId, requirement, features, feedback }),
  refineSingleFeature: (feature: unknown, feedback: string) =>
    invoke('refineSingleFeature', { feature, feedback }),
  checkRefineFeedback: (feature: unknown, feedback: string) =>
    invoke('checkRefineFeedback', { feature, feedback }),

  // Ask
  ask: (message: string, history: unknown[]) =>
    invoke('ask', { message, history }),

  // Jira
  createIssue: (payload: {
    feature: unknown;
    projectKey: string;
    issueType: string;
    reporterAccountId?: string;
    assigneeAccountId?: string;
    originIssueKey?: string;
  }) => invoke('createIssue', p(payload)),
  searchUsers: (query: string) => invoke('searchUsers', { query }),
  discoverJira: (projectKey?: string) => invoke('discoverJira', { projectKey }),
  discoverIssueTypes: (projectKey: string) => invoke('discoverIssueTypes', { projectKey }),
  discoverStatuses: (projectKey: string) => invoke('discoverStatuses', { projectKey }),
  discoverLinkTypes: () => invoke('discoverLinkTypes'),

  // Work Instructions
  uploadWi: (filename: string, fileBase64: string, revision?: string) =>
    invoke('uploadWi', { filename, fileBase64, revision }),
  listWiDocs: () => invoke('listWiDocs'),
  removeWiDoc: (docId: string) => invoke('removeWiDoc', { docId }),

  // Cache
  getCacheInfo: () => invoke('getCacheInfo'),
  refreshCache: () => invoke('refreshCache'),

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

  // Usage
  getUsage: () => invoke('getUsage'),
  resetUsage: () => invoke('resetUsage'),

  // LLM config
  checkIsAdmin: (payload?: any) => invoke('checkIsAdmin', payload),
  testLlmConnection: (payload: {
    provider: 'forge_llms' | 'gemini' | 'openai';
    model: string;
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
  }) => invoke('testLlmConnection', payload),
};

export type ApiResponse<T> = { success: boolean; error?: string } & T;
