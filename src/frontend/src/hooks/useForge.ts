import { invoke } from '@forge/bridge';
import type { CanvasEditIntent, CanvasEditScope, GenerationModelOverrides, LlmProvider } from '../types';

type Payload = Record<string, unknown>;
const p = (v: unknown) => v as Payload;

// Typed invoke wrapper for all resolver calls
export const api = {
  // Config
  getConfig: () => invoke('getConfig'),
  saveConfig: (config: unknown) => invoke('saveConfig', p(config)),
  saveProjectConfig: (payload: any) => invoke('saveProjectConfig', payload),
  getUserPreferences: () => invoke('getUserPreferences'),
  saveUserPreferences: (payload: {
    defaultProjectKey?: string;
    pipelineProfile?: 'fast' | 'balanced' | 'quality';
    quickRefineModelByProvider?: Partial<Record<LlmProvider, string>>;
  }) => invoke('saveUserPreferences', payload),
  patchConfig: (patch: unknown) => invoke('patchConfig', p(patch)),

  // Generation progress (polling)
  getProgress: (sessionId: string) => invoke('getProgress', { sessionId }),

  // V2 core flow
  v2Preview: (payload: {
    sessionId?: string;
    requirement: string;
    attachmentText?: string;
    projectKey?: string;
    projectKeys?: string[];
    selectedWiDocIds?: string[];
    includeWiContext?: boolean;
    includeSimilarStories?: boolean;
  }) => invoke('v2Preview', payload),
  v2Generate: (payload: {
    sessionId?: string;
    requirement: string;
    attachmentText?: string;
    projectKey?: string;
    projectKeys?: string[];
    selectedWiDocIds?: string[];
    includeWiContext?: boolean;
    includeSimilarStories?: boolean;
    confirmedScopeHypothesis?: unknown;
    discoveryAnswers?: unknown[];
  }) => invoke('v2Generate', payload),
  v2GetHistory: (limit?: number) => invoke('v2GetHistory', { limit }),
  v2GetConversation: (sessionId: string) => invoke('v2GetConversation', { sessionId }),
  v2DeleteConversation: (sessionId: string) => invoke('v2DeleteConversation', { sessionId }),

  // Generation
  startGeneration: (payload: {
    sessionId: string;
    requirement: string;
    clarifyAnswers?: unknown[];
    clarifyQuestionsAsked?: unknown[];
    clarifyFinalSufficiency?: unknown;
    attachmentText?: string;
    modelOverrides?: GenerationModelOverrides;
    projectKey?: string;
    projectKeys?: string[];
    selectedWiDocIds?: string[];
    clarifyDiscoveryProfile?: unknown;
    clarifySizingContract?: unknown;
    clarifyAdvisoryTriage?: unknown;
    pipelineAudit?: boolean;
    auditRunId?: string;
  }) => invoke('startGeneration', payload),
  retryFailedFeatureGeneration: (payload: {
    sessionId: string;
    featureId: string;
  }) => invoke('retryFailedFeatureGeneration', payload),
  retryFailedFeatureGenerations: (payload: {
    sessionId: string;
    featureIds: string[];
  }) => invoke('retryFailedFeatureGenerations', payload),
  retryGeneration: (payload: {
    sessionId: string;
  }) => invoke('retryGeneration', payload),

  // Clarify (async queue)
  startClarify: (payload: {
    sessionId: string;
    requirement: string;
    attachmentText?: string;
    projectKey?: string;
    projectKeys?: string[];
    selectedWiDocIds?: string[];
    inputSignature?: string;
    round?: 1 | 2;
    priorAnswers?: unknown[];
    pipelineAudit?: boolean;
    auditRunId?: string;
  }) => invoke('startClarify', payload),
  retryClarify: (payload: {
    sessionId: string;
    requirement: string;
    attachmentText?: string;
    projectKey?: string;
    projectKeys?: string[];
    selectedWiDocIds?: string[];
    inputSignature?: string;
    round?: 1 | 2;
    priorAnswers?: unknown[];
    pipelineAudit?: boolean;
    auditRunId?: string;
  }) => invoke('retryClarify', payload),
  getClarifyResult: (sessionId: string) =>
    invoke('getClarifyResult', { sessionId }),

  getPipelineAudit: (payload: { sessionId: string; auditRunId: string }) =>
    invoke('getPipelineAudit', payload),
  deletePipelineAudit: (payload: { sessionId: string; auditRunId: string }) =>
    invoke('deletePipelineAudit', payload),
  mergePipelineAuditClientPolling: (payload: {
    sessionId: string;
    auditRunId: string;
    clarify?: unknown;
    generation?: unknown;
  }) => invoke('mergePipelineAuditClientPolling', payload),

  // Refine
  refineFeatures: (sessionId: string, requirement: string, features: unknown[], feedback: string) =>
    invoke('refineFeatures', { sessionId, requirement, features, feedback }),
  changeCanvas: (payload: {
    sessionId: string;
    requirement: string;
    features: unknown[];
    instruction: string;
    intent: CanvasEditIntent;
    scope: CanvasEditScope;
    selectedFeatureIds?: string[];
  }) => invoke('changeCanvas', payload),
  restructureFeatures: (payload: {
    sessionId: string;
    requirement: string;
    features: unknown[];
    feedback: string;
    scope: 'all' | 'selected';
    selectedFeatureIds?: string[];
  }) => invoke('restructureFeatures', payload),
  getBulkRefineResult: (sessionId: string) => invoke('getBulkRefineResult', { sessionId }),
  cancelBulkRefine: (sessionId: string) => invoke('cancelBulkRefine', { sessionId }),
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

  // Quick refine
  getQuickRefineIssueContext: (payload: {
    issueKey: string;
    projectKey?: string;
    surface: 'issue-panel' | 'issue-action';
  }) => invoke('getQuickRefineIssueContext', payload),
  getQuickRefineSession: (payload: { issueKey?: string; sessionId?: string }) =>
    invoke('getQuickRefineSession', payload),
  startQuickRefine: (payload: {
    issueKey: string;
    projectKey?: string;
    sessionId: string;
    surface: 'issue-panel' | 'issue-action';
    modelOverride?: string;
    restart?: boolean;
  }) => invoke('startQuickRefine', payload),
  submitQuickRefineAnswers: (payload: {
    issueKey: string;
    sessionId: string;
    answers: unknown[];
    modelOverride?: string;
  }) => invoke('submitQuickRefineAnswers', payload),
  refineQuickRefineDraft: (payload: {
    issueKey: string;
    sessionId: string;
    instructions: string;
    draft: unknown;
    modelOverride?: string;
  }) => invoke('refineQuickRefineDraft', payload),
  applyQuickRefine: (payload: {
    issueKey: string;
    sessionId: string;
    draft: unknown;
  }) => invoke('applyQuickRefine', payload),

  // Work Instructions
  uploadWi: (filename: string, fileBase64: string, revision?: string, projectKey?: string) =>
    invoke('uploadWi', { filename, fileBase64, revision, projectKey }),
  parseRunAttachment: (filename: string, fileBase64: string) =>
    invoke('parseRunAttachment', { filename, fileBase64 }),
  listWiDocs: (projectKey?: string) => invoke('listWiDocs', { projectKey }),
  removeWiDoc: (docId: string, projectKey?: string) => invoke('removeWiDoc', { docId, projectKey }),

  // Cache
  getBacklogCacheInfo: (projectKey: string) => invoke('getBacklogCacheInfo', { projectKey }),
  diagnoseBacklogCache: (projectKey: string) => invoke('diagnoseBacklogCache', { projectKey }),
  refreshBacklogCache: (projectKey: string) => invoke('refreshBacklogCache', { projectKey }),
  getBacklogRefreshStatus: (projectKey: string) => invoke('getBacklogRefreshStatus', { projectKey }),
  getGoldStoryPool: (projectKey: string) => invoke('getGoldStoryPool', { projectKey }),
  searchBacklogForGoldCandidates: (payload: { projectKey: string; query?: string }) =>
    invoke('searchBacklogForGoldCandidates', payload),
  setGoldExampleKeys: (payload: { projectKey: string; issueKeys: string[] }) =>
    invoke('setGoldExampleKeys', payload),
  setGoldExampleLabel: (payload: { projectKey: string; label?: string }) =>
    invoke('setGoldExampleLabel', payload),
  inferProjectPersonaRoles: (projectKey: string) => invoke('inferProjectPersonaRoles', { projectKey }),

  // History
  getHistory: (limit?: number) => invoke('getHistory', { limit }),
  getConversation: (sessionId: string) => invoke('getConversation', { sessionId }),
  saveConversation: (sessionId: string) => invoke('saveConversation', { sessionId }),
  deleteConversation: (sessionId: string) => invoke('deleteConversation', { sessionId }),
  renameConversation: (sessionId: string, title: string) =>
    invoke('renameConversation', { sessionId, title }),
  toggleBookmark: (sessionId: string, isPinned: boolean) =>
    invoke('toggleBookmark', { sessionId, isPinned }),
  updateConversationFeatures: (
    sessionId: string,
    features: any[],
    options?: { lastAiChange?: unknown; clearLastAiChange?: boolean },
  ) => invoke('updateConversationFeatures', { sessionId, features, ...(options || {}) }),
  undoLastAiChange: (sessionId: string) => invoke('undoLastAiChange', { sessionId }),

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
    fireworksApiKey?: string;
    fireworksBaseUrl?: string;
    azureOpenAIApiKey?: string;
    azureOpenAIBaseUrl?: string;
    azureOpenAIApiVersion?: string;
    ollamaApiKey?: string;
    ollamaBaseUrl?: string;
    groqApiKey?: string;
    groqBaseUrl?: string;
  }) => invoke('testLlmConnection', payload),
  discoverLlmModels: (payload: {
    provider: LlmProvider;
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
  }) => invoke('discoverLlmModels', payload),
};

export type ApiResponse<T> = { success: boolean; error?: string } & T;
