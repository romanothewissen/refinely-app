import { invoke } from '@forge/bridge';
import type { LlmProvider } from '../types';

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
    projectKey?: string;
    projectKeys?: string[];
  }) => invoke('startGeneration', payload),

  // Clarify (async queue)
  startClarify: (
    sessionId: string,
    requirement: string,
    attachmentText?: string,
    projectKey?: string,
    projectKeys?: string[],
    inputSignature?: string,
  ) => invoke('startClarify', { sessionId, requirement, attachmentText, projectKey, projectKeys, inputSignature }),
  retryClarify: (
    sessionId: string,
    requirement: string,
    attachmentText?: string,
    projectKey?: string,
    projectKeys?: string[],
    inputSignature?: string,
  ) => invoke('retryClarify', { sessionId, requirement, attachmentText, projectKey, projectKeys, inputSignature }),
  getClarifyResult: (sessionId: string) =>
    invoke('getClarifyResult', { sessionId }),
  evaluateSufficiency: (payload: {
    requirement: string;
    answers: unknown[];
    askedQuestions?: unknown[];
    followupCap?: number;
    initialQuestionCount?: number;
    totalQuestionBudget?: number;
  }) => invoke('evaluateSufficiency', payload),

  // Refine
  refineFeatures: (sessionId: string, requirement: string, features: unknown[], feedback: string) =>
    invoke('refineFeatures', { sessionId, requirement, features, feedback }),
  refineSingleFeature: (feature: unknown, feedback: string, requirement?: string, sessionId?: string) =>
    invoke('refineSingleFeature', { feature, feedback, requirement, sessionId }),
  checkRefineFeedback: (feature: unknown, feedback: string) =>
    invoke('checkRefineFeedback', { feature, feedback }),

  // Ask
  ask: (message: string, history: unknown[], projectKey?: string, projectKeys?: string[]) =>
    invoke('ask', { message, history, projectKey, projectKeys }),

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
  parseRunAttachment: (filename: string, fileBase64: string) =>
    invoke('parseRunAttachment', { filename, fileBase64 }),
  listWiDocs: (projectKey?: string) => invoke('listWiDocs', { projectKey }),
  removeWiDoc: (docId: string) => invoke('removeWiDoc', { docId }),

  // Cache
  getBacklogCacheInfo: (projectKey: string) => invoke('getBacklogCacheInfo', { projectKey }),
  diagnoseBacklogCache: (projectKey: string) => invoke('diagnoseBacklogCache', { projectKey }),
  refreshBacklogCache: (projectKey: string) => invoke('refreshBacklogCache', { projectKey }),
  getBacklogRefreshStatus: (projectKey: string) => invoke('getBacklogRefreshStatus', { projectKey }),

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
  listComplianceAuditEvents: (limit?: number) => invoke('listComplianceAuditEvents', { limit }),
  listTransparencyReports: (payload?: { sessionId?: string; turnType?: 'generate' | 'clarify' | 'refine' | 'ask'; limit?: number }) =>
    invoke('listTransparencyReports', payload || {}),
  getComplianceSummary: () => invoke('getComplianceSummary'),
  previewPiiMasking: (payload: { text: string; enabled?: boolean }) => invoke('previewPiiMasking', payload),
  getProjectActivitySummary: (limit?: number) => invoke('getProjectActivitySummary', { limit }),
  getJiraAuditRecords: (limit?: number) => invoke('getJiraAuditRecords', { limit }),

  // LLM config
  checkIsAdmin: (payload?: any) => invoke('checkIsAdmin', payload),
  testLlmConnection: (payload: {
    provider: LlmProvider;
    model: string;
    anthropicApiKey?: string;
    anthropicBaseUrl?: string;
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    azureOpenAIApiKey?: string;
    azureOpenAIBaseUrl?: string;
    azureOpenAIApiVersion?: string;
  }) => invoke('testLlmConnection', payload),
  discoverLlmModels: (payload: {
    provider: LlmProvider;
    anthropicApiKey?: string;
    anthropicBaseUrl?: string;
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    azureOpenAIApiKey?: string;
    azureOpenAIBaseUrl?: string;
    azureOpenAIApiVersion?: string;
  }) => invoke('discoverLlmModels', payload),
};

export type ApiResponse<T> = { success: boolean; error?: string } & T;
