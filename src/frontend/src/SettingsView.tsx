import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { 
  Database, BrainCircuit, Globe, X, RefreshCw, Save, CreditCard, ChevronLeft, ShieldCheck, 
  Users, FileText, ChevronRight, Check, Trash, Layers, Zap, Info, AlertCircle
} from 'lucide-react';
import { motion } from 'framer-motion';
import { api } from './hooks/useForge';
import { AiInsightsReport, AiPolicyPreset, LlmProvider, OutputMode, ProjectAiPolicy, REDACTED, ReasoningMode } from './types';

interface GoldSource {
  key: string;
  project: string;
  issuetype: string;
  status?: string;
  statuses?: string[];
  maxItems: number;
  requirementsFieldId: string | null;
  arFieldIds: string[];
  targetProjects?: string[];
}
interface JiraProject { key: string; name: string }
interface JiraIssueType { name: string }
interface JiraStatus { name: string; statusCategory?: { name: string } }
interface JiraField { id: string; name: string }
interface ProjectBacklogStatusScope { projectKey: string; statuses: string[] }
interface BacklogDiagnostics {
  projectKey: string;
  configuredStatuses: string[];
  jqlUsed: string;
  totalProjectIssues: number;
  doneCategoryIssues: number;
  matchingScopeIssues: number;
  likelyReason: string;
}

interface WiDocRow {
  docId: string;
  filename: string;
  revision: string;
  chunkCount: number;
  uploadedAt: string;
}

interface ComplianceAuditEvent {
  eventId: string;
  timestamp: string;
  category: 'config' | 'security' | 'prompt' | 'runtime';
  action: string;
  details: Record<string, unknown>;
}

interface TransparencyReportRow {
  reportId: string;
  createdAt: string;
  turnType: 'generate' | 'clarify' | 'refine' | 'ask';
  projectKey?: string;
  model?: string;
  decisionSummary: string[];
  piiMasking: { enabled: boolean; totalRedactions: number };
  tokenUsage?: { total: number };
}

const CLAUDE_MODELS = [
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku (Fastest)' },
  { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet (Balanced)' },
  { id: 'claude-opus-4-6', label: 'Claude Opus (Best logic)' },
];
const GEMINI_MODELS = [
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
  { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
];
const OPENAI_MODELS = [
  { id: 'gpt-4o-mini', label: 'GPT-4o Mini (Fast)' },
  { id: 'gpt-4o', label: 'GPT-4o (Strong)' },
  { id: 'gpt-4.5-preview', label: 'GPT-4.5 (Top logic)' },
  { id: 'o1-mini', label: 'o1 Mini (Reasoning)' },
  { id: 'o1-preview', label: 'o1 Preview' },
];
const PROVIDER_OPTIONS: Array<{ id: LlmProvider; label: string; blurb: string }> = [
  { id: 'forge_llms', label: 'Forge', blurb: 'Atlassian-managed routing' },
  { id: 'openai', label: 'OpenAI', blurb: 'Direct OpenAI API access' },
  { id: 'azure_openai', label: 'Azure OpenAI', blurb: 'Enterprise-managed OpenAI through Azure' },
  { id: 'gemini', label: 'Gemini', blurb: 'Google Gemini API access' },
];

const AI_POLICY_PRESETS: Record<
  AiPolicyPreset,
  {
    label: string;
    description: string;
    values: {
      defaultReasoningMode: ReasoningMode;
      defaultOutputMode: OutputMode;
      allowReasoningModeOverride: boolean;
      allowOutputModeOverride: boolean;
      simpleAskMaxQuestions: number;
      deepModeRoundTarget: number;
      enterpriseMaxQuestionsPerRound: number;
      maxDeepDiscoveryRounds: number;
    };
  }
> = {
  balanced: {
    label: 'Balanced',
    description: 'General-purpose default for most teams and mixed complexity asks.',
    values: {
      defaultReasoningMode: 'fast',
      defaultOutputMode: 'auto',
      allowReasoningModeOverride: true,
      allowOutputModeOverride: true,
      simpleAskMaxQuestions: 4,
      deepModeRoundTarget: 6,
      enterpriseMaxQuestionsPerRound: 10,
      maxDeepDiscoveryRounds: 3,
    },
  },
  delivery: {
    label: 'Delivery',
    description: 'Biases toward faster output and fewer clarifying questions.',
    values: {
      defaultReasoningMode: 'fast',
      defaultOutputMode: 'single',
      allowReasoningModeOverride: true,
      allowOutputModeOverride: true,
      simpleAskMaxQuestions: 2,
      deepModeRoundTarget: 4,
      enterpriseMaxQuestionsPerRound: 8,
      maxDeepDiscoveryRounds: 2,
    },
  },
  discovery: {
    label: 'Discovery',
    description: 'Encourages deeper planning and more user input before generation.',
    values: {
      defaultReasoningMode: 'deep',
      defaultOutputMode: 'auto',
      allowReasoningModeOverride: true,
      allowOutputModeOverride: true,
      simpleAskMaxQuestions: 4,
      deepModeRoundTarget: 8,
      enterpriseMaxQuestionsPerRound: 12,
      maxDeepDiscoveryRounds: 4,
    },
  },
  enterprise: {
    label: 'Enterprise',
    description: 'Supports broader decomposition and extended discovery on complex asks.',
    values: {
      defaultReasoningMode: 'deep',
      defaultOutputMode: 'full_breakdown',
      allowReasoningModeOverride: true,
      allowOutputModeOverride: true,
      simpleAskMaxQuestions: 4,
      deepModeRoundTarget: 9,
      enterpriseMaxQuestionsPerRound: 14,
      maxDeepDiscoveryRounds: 5,
    },
  },
};

function modelMatchesProvider(model: string, provider: LlmProvider): boolean {
  if (!model) return false;
  if (provider === 'gemini') return model.startsWith('gemini-');
  if (provider === 'openai' || provider === 'azure_openai') {
    return model.startsWith('gpt-') || model.startsWith('o1-');
  }
  return !model.startsWith('gemini-') && !model.startsWith('gpt-') && !model.startsWith('o1-');
}

function getProviderDefaults(provider: LlmProvider): { fastModel: string; deepModel: string } {
  if (provider === 'gemini') return { fastModel: 'gemini-2.5-flash', deepModel: 'gemini-2.5-pro' };
  if (provider === 'openai' || provider === 'azure_openai') return { fastModel: 'gpt-4o-mini', deepModel: 'gpt-4.5-preview' };
  return { fastModel: 'claude-haiku-4-5-20251001', deepModel: 'claude-opus-4-6' };
}

function getAvailableModels(provider: LlmProvider) {
  if (provider === 'gemini') return GEMINI_MODELS;
  if (provider === 'openai' || provider === 'azure_openai') return OPENAI_MODELS;
  return CLAUDE_MODELS;
}

function isFastProfileModel(modelId: string) {
  const normalized = modelId.toLowerCase();
  return normalized.includes('haiku') || normalized.includes('flash') || normalized.includes('mini');
}

function getProfileModels(provider: LlmProvider, profile: 'fast' | 'deep') {
  const models = getAvailableModels(provider);
  const filtered = models.filter((model) =>
    profile === 'fast' ? isFastProfileModel(model.id) : !isFastProfileModel(model.id),
  );
  return filtered.length ? filtered : models;
}

function getModelLabel(model: string): string {
  return [...CLAUDE_MODELS, ...GEMINI_MODELS, ...OPENAI_MODELS].find((option) => option.id === model)?.label ?? model;
}

function applySimplifiedRouting(fastModel: string, deepModel: string) {
  return {
    decompositionModel: deepModel,
    arModel: deepModel,
    clarifyModel: fastModel,
    refineModel: fastModel,
    evaluateModel: fastModel,
    themeModel: fastModel,
  };
}

function getProviderLabel(provider: LlmProvider): string {
  return PROVIDER_OPTIONS.find((option) => option.id === provider)?.label ?? provider.replace('_', ' ');
}

function normalizePolicyNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}

function getDefaultModelForProvider(provider: LlmProvider, depth: 'fast' | 'deep') {
  const defaults = getProviderDefaults(provider);
  return depth === 'deep' ? defaults.deepModel : defaults.fastModel;
}

function formatInsightKey(value: string) {
  if (value === '*') return 'Workspace default';
  return value
    .split('_')
    .join(' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function SettingsView({ onClose, initialTab = 'models', initialProjectKey = '*' }: { onClose: () => void; initialTab?: 'models' | 'jira' | 'domain' | 'billing'; initialProjectKey?: string }) {
  const [activeTab, setActiveTab] = useState<'models' | 'jira' | 'domain' | 'billing'>(initialTab);
  const [isSaving, setIsSaving] = useState(false);

  // AI infrastructure state
  const [provider, setProvider] = useState<LlmProvider>('forge_llms');
  const [fastProfileProvider, setFastProfileProvider] = useState<LlmProvider>('forge_llms');
  const [deepProfileProvider, setDeepProfileProvider] = useState<LlmProvider>('forge_llms');
  const [fastProfileModel, setFastProfileModel] = useState('claude-haiku-4-5-20251001');
  const [deepProfileModel, setDeepProfileModel] = useState('claude-opus-4-6');

  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [geminiBaseUrl, setGeminiBaseUrl] = useState('');
  const [existingGeminiApiKey, setExistingGeminiApiKey] = useState('');
  
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState('');
  const [existingOpenaiApiKey, setExistingOpenaiApiKey] = useState('');

  const [azureOpenaiApiKey, setAzureOpenaiApiKey] = useState('');
  const [azureOpenaiEndpoint, setAzureOpenaiEndpoint] = useState('');
  const [azureOpenaiDeployment, setAzureOpenaiDeployment] = useState('');
  const [azureOpenaiApiVersion, setAzureOpenaiApiVersion] = useState('2024-10-21');
  const [existingAzureOpenaiApiKey, setExistingAzureOpenaiApiKey] = useState('');
  
  // Dynamic model lists (fetched from provider APIs)
  const [dynamicModels, setDynamicModels] = useState<Record<string, { id: string; label: string }[]>>({});
  const [isFetchingModels, setIsFetchingModels] = useState<'openai' | 'gemini' | null>(null);
  const [modelFetchError, setModelFetchError] = useState<Record<string, string>>({});

  const [isTestingLlm, setIsTestingLlm] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [workspacePreset, setWorkspacePreset] = useState<AiPolicyPreset>('balanced');
  const [defaultReasoningMode, setDefaultReasoningMode] = useState<ReasoningMode>('fast');
  const [defaultOutputMode, setDefaultOutputMode] = useState<OutputMode>('auto');
  const [allowReasoningModeOverride, setAllowReasoningModeOverride] = useState(true);
  const [allowOutputModeOverride, setAllowOutputModeOverride] = useState(true);
  const [simpleAskMaxQuestions, setSimpleAskMaxQuestions] = useState(4);
  const [deepModeRoundTarget, setDeepModeRoundTarget] = useState(6);
  const [enterpriseMaxQuestionsPerRound, setEnterpriseMaxQuestionsPerRound] = useState(10);
  const [maxDeepDiscoveryRounds, setMaxDeepDiscoveryRounds] = useState(3);
  const [projectAiPolicies, setProjectAiPolicies] = useState<ProjectAiPolicy[]>([]);
  const [aiInsights, setAiInsights] = useState<AiInsightsReport | null>(null);
  const [isLoadingAiInsights, setIsLoadingAiInsights] = useState(false);

  // Jira State
  const [issueLinkType, setIssueLinkType] = useState('Relates to');
  const [projects, setProjects] = useState<JiraProject[]>([]);
  const [goldSources, setGoldSources] = useState<GoldSource[]>([]);
  const [newSource, setNewSource] = useState<Partial<GoldSource>>({ statuses: [] });
  const [issueTypes, setIssueTypes] = useState<JiraIssueType[]>([]);
  const [statuses, setStatuses] = useState<JiraStatus[]>([]);
  const [backlogStatusOptions, setBacklogStatusOptions] = useState<JiraStatus[]>([]);
  const [customFields, setCustomFields] = useState<JiraField[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [arMappings, setArMappings] = useState<any[]>([]);
  const [backlogStatusScopes, setBacklogStatusScopes] = useState<ProjectBacklogStatusScope[]>([]);
  const [activeArProj, setActiveArProj] = useState(initialProjectKey); // Global context selector
  const [backlogCacheInfo, setBacklogCacheInfo] = useState<{ projectKey: string; builtAt?: string; issueCount: number; stale: boolean } | null>(null);
  const [backlogDiagnostics, setBacklogDiagnostics] = useState<BacklogDiagnostics | null>(null);
  const [isRefreshingBacklogCache, setIsRefreshingBacklogCache] = useState(false);

  // Domain State
  const [domainContext, setDomainContext] = useState('');
  const [domainRoles, setDomainRoles] = useState('');
  const [tier, setTier] = useState<'free' | 'standard' | 'premium' | 'enterprise'>('free');
  const [complianceEnabled, setComplianceEnabled] = useState(false);
  const [transparencyEnabled, setTransparencyEnabled] = useState(false);
  const [piiMaskingEnabled, setPiiMaskingEnabled] = useState(false);
  const [auditTrailEnabled, setAuditTrailEnabled] = useState(false);
  const [complianceEvents, setComplianceEvents] = useState<ComplianceAuditEvent[]>([]);
  const [transparencyReports, setTransparencyReports] = useState<TransparencyReportRow[]>([]);
  const [jiraAuditRecords, setJiraAuditRecords] = useState<Array<Record<string, unknown>>>([]);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<{ currentMonth: number } | null>(null);
  const [limits, setLimits] = useState<{ generationsPerMonth: number } | null>(null);
  const [domainContexts, setDomainContexts] = useState<any[]>([]);
  const [activeProjAdmin, setActiveProjAdmin] = useState<boolean>(false);
  
  // WIs State
  const [wiEnabled, setWiEnabled] = useState(true);
  const [wiDocs, setWiDocs] = useState<WiDocRow[]>([]);
  const [wiUploadState, setWiUploadState] = useState<{ filename: string; stage: 'reading' | 'uploading' | 'indexing' } | null>(null);
  const [wiUploadError, setWiUploadError] = useState<string | null>(null);
  const wiFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (initialProjectKey) setActiveArProj(initialProjectKey);
  }, [initialProjectKey]);

  const loadAiInsights = useCallback(async () => {
    setIsLoadingAiInsights(true);
    try {
      const res = await api.getAiInsights() as any;
      if (res?.success && res.insights) {
        setAiInsights(res.insights);
      }
    } catch (e) {
      console.error('Error loading AI insights', e);
    } finally {
      setIsLoadingAiInsights(false);
    }
  }, []);

  function detectDefaultIssueType(types: JiraIssueType[]): string | undefined {
    if (!types.length) return undefined;
    const preferred = ['story', 'feature', 'task'];
    const found = preferred
      .map(name => types.find(t => t.name.toLowerCase() === name))
      .find(Boolean);
    return found?.name ?? types[0]?.name;
  }

  function detectDefaultStatuses(statuses: JiraStatus[]): string[] {
    if (!statuses.length) return [];
    const byCategory = statuses
      .filter(s => (s.statusCategory?.name || '').toLowerCase() === 'done')
      .map(s => s.name);
    if (byCategory.length) {
      return [...new Set(byCategory)];
    }
    const doneKeywords = ['done', 'completed', 'deployed', 'released', 'closed', 'resolved'];
    const matches = statuses
      .map(s => s.name)
      .filter(name => doneKeywords.some(k => name.toLowerCase().includes(k)));
    return matches.length ? [...new Set(matches)] : [statuses[0].name];
  }

  const loadInitialConfig = useCallback(async () => {
    api.discoverLinkTypes().then((res: any) => {
      // Logic for available link types was removed
    }).catch(() => {});

    try {
      const existingConfig = await api.getConfig() as any;
      if (existingConfig) {
        const gc = existingConfig.generatorConfig || {};
        if (gc.provider) setProvider(gc.provider);
        if (gc.fastProfileProvider) setFastProfileProvider(gc.fastProfileProvider);
        else if (gc.provider) setFastProfileProvider(gc.provider);
        if (gc.deepProfileProvider) setDeepProfileProvider(gc.deepProfileProvider);
        else if (gc.provider) setDeepProfileProvider(gc.provider);
        if (gc.fastProfileModel) setFastProfileModel(gc.fastProfileModel);
        else if (gc.clarifyModel) setFastProfileModel(gc.clarifyModel);
        if (gc.deepProfileModel) setDeepProfileModel(gc.deepProfileModel);
        else if (gc.decompositionModel) setDeepProfileModel(gc.decompositionModel);
        
        if (gc.geminiApiKey) { setExistingGeminiApiKey(gc.geminiApiKey); void fetchModelsForProvider('gemini'); }
        if (gc.geminiBaseUrl) setGeminiBaseUrl(gc.geminiBaseUrl);
        if (gc.openaiApiKey) { setExistingOpenaiApiKey(gc.openaiApiKey); void fetchModelsForProvider('openai'); }
        if (gc.openaiBaseUrl) setOpenaiBaseUrl(gc.openaiBaseUrl);
        if (gc.azureOpenaiApiKey) setExistingAzureOpenaiApiKey(gc.azureOpenaiApiKey);
        if (gc.azureOpenaiEndpoint) setAzureOpenaiEndpoint(gc.azureOpenaiEndpoint);
        if (gc.azureOpenaiDeployment) setAzureOpenaiDeployment(gc.azureOpenaiDeployment);
        if (gc.azureOpenaiApiVersion) setAzureOpenaiApiVersion(gc.azureOpenaiApiVersion);
        const aiPolicy = existingConfig.aiExecutionPolicy || {};
        if (aiPolicy.workspacePreset) setWorkspacePreset(aiPolicy.workspacePreset);
        if (aiPolicy.defaultReasoningMode) setDefaultReasoningMode(aiPolicy.defaultReasoningMode);
        if (aiPolicy.defaultOutputMode) setDefaultOutputMode(aiPolicy.defaultOutputMode);
        if (typeof aiPolicy.allowReasoningModeOverride === 'boolean') setAllowReasoningModeOverride(aiPolicy.allowReasoningModeOverride);
        if (typeof aiPolicy.allowOutputModeOverride === 'boolean') setAllowOutputModeOverride(aiPolicy.allowOutputModeOverride);
        if (typeof aiPolicy.simpleAskMaxQuestions === 'number') setSimpleAskMaxQuestions(aiPolicy.simpleAskMaxQuestions);
        if (typeof aiPolicy.deepModeRoundTarget === 'number') setDeepModeRoundTarget(aiPolicy.deepModeRoundTarget);
        if (typeof aiPolicy.enterpriseMaxQuestionsPerRound === 'number') setEnterpriseMaxQuestionsPerRound(aiPolicy.enterpriseMaxQuestionsPerRound);
        if (typeof aiPolicy.maxDeepDiscoveryRounds === 'number') setMaxDeepDiscoveryRounds(aiPolicy.maxDeepDiscoveryRounds);
        if (existingConfig.projectAiPolicies) setProjectAiPolicies(existingConfig.projectAiPolicies);

        if (existingConfig.goldSources) {
          setGoldSources(existingConfig.goldSources.map((gs: any) => {
            const normalizedStatuses = Array.isArray(gs.statuses) && gs.statuses.length
              ? gs.statuses
              : (gs.status ? [gs.status] : []);
            return {
              ...gs,
              statuses: normalizedStatuses,
              status: normalizedStatuses[0],
              arFieldIds: Array.isArray(gs.arFieldIds) && gs.arFieldIds.length > 0 ? gs.arFieldIds : (gs.requirementsFieldId ? [gs.requirementsFieldId] : []),
              requirementsFieldId: null,
            };
          }));
        }
        if (existingConfig.domainContext) setDomainContext(existingConfig.domainContext);
        if (existingConfig.domainRoles) setDomainRoles((existingConfig.domainRoles as string[]).join(', '));
        if (existingConfig.tier) setTier(existingConfig.tier);
        setComplianceEnabled(Boolean(existingConfig.compliance?.enabled));
        setTransparencyEnabled(Boolean(existingConfig.compliance?.transparencyReportsEnabled));
        setPiiMaskingEnabled(Boolean(existingConfig.compliance?.piiMaskingEnabled));
        setAuditTrailEnabled(Boolean(existingConfig.compliance?.auditTrailEnabled));
        if (existingConfig.wiConfig?.enabled !== undefined) setWiEnabled(existingConfig.wiConfig.enabled);
        if (existingConfig.issueLinkType) setIssueLinkType(existingConfig.issueLinkType);
        if (existingConfig.arMappings) setArMappings(existingConfig.arMappings);
        if (existingConfig.domainContexts) setDomainContexts(existingConfig.domainContexts);
        if (existingConfig.backlogStatusScopes) setBacklogStatusScopes(existingConfig.backlogStatusScopes);
        if (existingConfig.isAdmin !== undefined) setIsAdmin(existingConfig.isAdmin);
        if (existingConfig.isAdmin) {
          await loadAiInsights();
        } else {
          setAiInsights(null);
        }
      }
      const usageRes = await api.getUsage() as any;
      if (usageRes?.usage) setUsage(usageRes.usage);
      if (usageRes?.limits) setLimits(usageRes.limits);
      const jiraRes = await api.discoverJira() as any;
      if (jiraRes?.success !== false) {
        setProjects(jiraRes.projects ?? []);
        setCustomFields(jiraRes.fields ?? []);
      }
      const [auditRes, reportRes, jiraAuditRes] = await Promise.all([
        api.listComplianceAuditEvents(30) as Promise<any>,
        api.listTransparencyReports({ limit: 30 }) as Promise<any>,
        api.getJiraAuditRecords(20) as Promise<any>,
      ]);
      setComplianceEvents(Array.isArray(auditRes?.events) ? auditRes.events : []);
      setTransparencyReports(Array.isArray(reportRes?.reports) ? reportRes.reports : []);
      setJiraAuditRecords(Array.isArray(jiraAuditRes?.records) ? jiraAuditRes.records : []);
    } catch (e) { console.error('Error loading config', e); }
  }, [loadAiInsights]);

  useEffect(() => {
    loadInitialConfig();
  }, [loadInitialConfig]);

  const checkProjectAdmin = useCallback(async () => {
    if (!activeArProj || activeArProj === '*') {
      setActiveProjAdmin(!!isAdmin);
      return;
    }
    try {
      const res = await api.checkIsAdmin({ projectKey: activeArProj }) as any;
      if (res?.success) setActiveProjAdmin(!!res.isProjectAdmin);
    } catch { setActiveProjAdmin(false); }
  }, [activeArProj, isAdmin]);

  const loadWiDocs = useCallback(async () => {
    try {
      const res = await api.listWiDocs(activeArProj) as any;
      if (res.success !== false) setWiDocs(res.docs ?? []);
    } catch (e: any) { console.error('Could not list documents', e); }
  }, [activeArProj]);

  useEffect(() => {
    checkProjectAdmin();
  }, [checkProjectAdmin]);

  useEffect(() => {
    if (activeTab === 'jira' && activeArProj && activeArProj !== '*') {
      loadBacklogCacheInfo(activeArProj);
      loadBacklogDiagnostics(activeArProj);
    } else {
      setBacklogCacheInfo(null);
      setBacklogDiagnostics(null);
    }
  }, [activeTab, activeArProj]);

  useEffect(() => {
    if (activeTab === 'jira' && activeArProj && activeArProj !== '*') {
      loadBacklogStatuses(activeArProj);
    } else {
      setBacklogStatusOptions([]);
    }
  }, [activeTab, activeArProj]);

  async function loadBacklogCacheInfo(projectKey: string) {
    try {
      const res = await api.getBacklogCacheInfo(projectKey) as any;
      if (res?.success) {
        setBacklogCacheInfo({
          projectKey: res.projectKey,
          builtAt: res.builtAt,
          issueCount: res.issueCount ?? 0,
          stale: !!res.stale,
        });
      }
    } catch (e) {
      console.error('Could not load backlog cache info', e);
    }
  }

  async function loadBacklogDiagnostics(projectKey: string) {
    try {
      const res = await api.diagnoseBacklogCache(projectKey) as any;
      if (res?.success) {
        setBacklogDiagnostics(res.diagnostics ?? null);
      } else {
        setBacklogDiagnostics(null);
      }
    } catch (e) {
      console.error('Could not load backlog diagnostics', e);
      setBacklogDiagnostics(null);
    }
  }

  async function handleRefreshBacklogCache(projectKey = activeArProj) {
    if (!projectKey || projectKey === '*') return null;
    setIsRefreshingBacklogCache(true);
    try {
      const res = await api.refreshBacklogCache(projectKey) as any;
      if (res?.success) {
        const nextInfo = {
          projectKey: res.projectKey,
          builtAt: res.builtAt,
          issueCount: res.issueCount ?? 0,
          stale: false,
        };
        setBacklogCacheInfo(nextInfo);
        setBacklogDiagnostics(res.diagnostics ?? null);
        return { ...nextInfo, diagnostics: res.diagnostics ?? null };
      } else {
        alert(res?.error || 'Backlog cache refresh failed.');
      }
    } catch (e: any) {
      alert(e?.message || 'Backlog cache refresh failed.');
    } finally {
      setIsRefreshingBacklogCache(false);
    }
    return null;
  }

  async function loadBacklogStatuses(projectKey: string) {
    try {
      const res = await api.discoverStatuses(projectKey) as any;
      setBacklogStatusOptions(res?.statuses ?? []);
    } catch (e) {
      console.error('Could not load backlog statuses', e);
      setBacklogStatusOptions([]);
    }
  }

  useEffect(() => {
    if (activeTab === 'jira') loadWiDocs();
  }, [activeTab, loadWiDocs]);

  async function handleWiPdfDrop(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.type !== 'application/pdf') {
      setWiUploadError('Only PDF documents are supported right now.');
      return;
    }
    setWiUploadError(null);
    setWiUploadState({ filename: file.name, stage: 'reading' });
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          resolve(dataUrl.split(',')[1] || dataUrl);
        };
        reader.onerror = () => reject(new Error('Read failed'));
        reader.readAsDataURL(file);
      });
      setWiUploadState({ filename: file.name, stage: 'uploading' });
      const res = await api.uploadWi(file.name, base64, undefined, activeArProj) as any;
      if (res.success === false) {
        throw new Error(res.error || 'Upload failed');
      }
      setWiUploadState({ filename: file.name, stage: 'indexing' });
      if (!res.duplicate) await loadWiDocs();
    } catch (err: any) {
      console.error('Upload failed', err);
      setWiUploadError(err?.message || 'Upload failed.');
    } finally {
      setWiUploadState(null);
    }
  }

  async function handleRemoveWiDoc(docId: string) {
    try {
      await api.removeWiDoc(docId);
      await loadWiDocs();
    } catch (e: any) { console.error('Remove failed', e); }
  }

  function applyWorkspacePolicyPreset(preset: AiPolicyPreset) {
    const values = AI_POLICY_PRESETS[preset].values;
    setWorkspacePreset(preset);
    setDefaultReasoningMode(values.defaultReasoningMode);
    setDefaultOutputMode(values.defaultOutputMode);
    setAllowReasoningModeOverride(values.allowReasoningModeOverride);
    setAllowOutputModeOverride(values.allowOutputModeOverride);
    setSimpleAskMaxQuestions(values.simpleAskMaxQuestions);
    setDeepModeRoundTarget(values.deepModeRoundTarget);
    setEnterpriseMaxQuestionsPerRound(values.enterpriseMaxQuestionsPerRound);
    setMaxDeepDiscoveryRounds(values.maxDeepDiscoveryRounds);
  }

  const currentProjectAiPolicy = projectAiPolicies.find((policy) => policy.projectKey === activeArProj) || null;

  function updateProjectAiPolicy(nextPatch: Partial<ProjectAiPolicy> | null) {
    if (!activeArProj || activeArProj === '*') return;
    setProjectAiPolicies((prev) => {
      const idx = prev.findIndex((policy) => policy.projectKey === activeArProj);
      if (nextPatch === null) {
        if (idx === -1) return prev;
        return prev.filter((policy) => policy.projectKey !== activeArProj);
      }

      const nextPolicy: ProjectAiPolicy = {
        ...(idx >= 0 ? prev[idx] : { projectKey: activeArProj, preset: 'inherit' }),
        ...nextPatch,
        projectKey: activeArProj,
      };

      if (idx >= 0) {
        const next = [...prev];
        next[idx] = nextPolicy;
        return next;
      }
      return [...prev, nextPolicy];
    });
  }

  function applyProjectPolicyPreset(preset: AiPolicyPreset | 'inherit') {
    if (preset === 'inherit') {
      updateProjectAiPolicy(null);
      return;
    }
    const values = AI_POLICY_PRESETS[preset].values;
    updateProjectAiPolicy({
      preset,
      defaultReasoningMode: values.defaultReasoningMode,
      defaultOutputMode: values.defaultOutputMode,
      allowReasoningModeOverride: values.allowReasoningModeOverride,
      allowOutputModeOverride: values.allowOutputModeOverride,
      simpleAskMaxQuestions: values.simpleAskMaxQuestions,
      deepModeRoundTarget: values.deepModeRoundTarget,
      enterpriseMaxQuestionsPerRound: values.enterpriseMaxQuestionsPerRound,
      maxDeepDiscoveryRounds: values.maxDeepDiscoveryRounds,
    });
  }

  function handleFastProfileProviderChange(nextProvider: LlmProvider) {
    setFastProfileProvider(nextProvider);
    if (!modelMatchesProvider(fastProfileModel, nextProvider)) {
      setFastProfileModel(getDefaultModelForProvider(nextProvider, 'fast'));
    }
  }

  function handleDeepProfileProviderChange(nextProvider: LlmProvider) {
    setDeepProfileProvider(nextProvider);
    if (!modelMatchesProvider(deepProfileModel, nextProvider)) {
      setDeepProfileModel(getDefaultModelForProvider(nextProvider, 'deep'));
    }
  }

  function handleProjectRouteProviderChange(
    profile: 'fast' | 'deep',
    nextProvider: LlmProvider,
  ) {
    if (profile === 'fast') {
      const currentModel = currentProjectAiPolicy?.fastProfileModel ?? fastProfileModel;
      updateProjectAiPolicy({
        fastProfileProvider: nextProvider,
        fastProfileModel: modelMatchesProvider(currentModel, nextProvider)
          ? currentModel
          : getDefaultModelForProvider(nextProvider, 'fast'),
      });
      return;
    }

    const currentModel = currentProjectAiPolicy?.deepProfileModel ?? deepProfileModel;
    updateProjectAiPolicy({
      deepProfileProvider: nextProvider,
      deepProfileModel: modelMatchesProvider(currentModel, nextProvider)
        ? currentModel
        : getDefaultModelForProvider(nextProvider, 'deep'),
    });
  }

  async function handleSave() {
    setIsSaving(true);
    try {
      const normalizedProjectAiPolicies = projectAiPolicies.map((policy) => ({
        ...policy,
        simpleAskMaxQuestions: policy.simpleAskMaxQuestions === undefined ? undefined : normalizePolicyNumber(policy.simpleAskMaxQuestions, 2, 4),
        deepModeRoundTarget: policy.deepModeRoundTarget === undefined ? undefined : normalizePolicyNumber(policy.deepModeRoundTarget, 4, 10),
        enterpriseMaxQuestionsPerRound: policy.enterpriseMaxQuestionsPerRound === undefined ? undefined : normalizePolicyNumber(policy.enterpriseMaxQuestionsPerRound, 8, 14),
        maxDeepDiscoveryRounds: policy.maxDeepDiscoveryRounds === undefined ? undefined : normalizePolicyNumber(policy.maxDeepDiscoveryRounds, 1, 6),
      }));
      const routedModels = applySimplifiedRouting(fastProfileModel, deepProfileModel);

      await api.saveConfig({
        goldSources,
        generatorConfig: {
          provider,
          profileMode: 'simplified',
          fastProfileProvider,
          deepProfileProvider,
          fastProfileModel,
          deepProfileModel,
          ...routedModels,
          maxTokens: 8192,
          geminiApiKey: geminiApiKey.trim() || existingGeminiApiKey || "",
          geminiBaseUrl: geminiBaseUrl.trim() || undefined,
          openaiApiKey: openaiApiKey.trim() || existingOpenaiApiKey || "",
          openaiBaseUrl: openaiBaseUrl.trim() || undefined,
          azureOpenaiApiKey: azureOpenaiApiKey.trim() || existingAzureOpenaiApiKey || "",
          azureOpenaiEndpoint: azureOpenaiEndpoint.trim() || undefined,
          azureOpenaiDeployment: azureOpenaiDeployment.trim() || undefined,
          azureOpenaiApiVersion: azureOpenaiApiVersion.trim() || undefined,
        },
        domainContext: domainContext.trim(),
        domainContexts,
        domainRoles: domainRoles.split(',').map((r: any) => r.trim()).filter(Boolean),
        aiExecutionPolicy: {
          workspacePreset,
          defaultReasoningMode,
          defaultOutputMode,
          allowReasoningModeOverride,
          allowOutputModeOverride,
          simpleAskMaxQuestions: normalizePolicyNumber(simpleAskMaxQuestions, 2, 4),
          deepModeRoundTarget: normalizePolicyNumber(deepModeRoundTarget, 4, 10),
          enterpriseMaxQuestionsPerRound: normalizePolicyNumber(enterpriseMaxQuestionsPerRound, 8, 14),
          maxDeepDiscoveryRounds: normalizePolicyNumber(maxDeepDiscoveryRounds, 1, 6),
          hideModelSelectionFromEndUsers: true,
        },
        wiConfig: { enabled: wiEnabled, topKChunks: 8, maxChars: 100000 },
        compliance: {
          enabled: complianceEnabled,
          transparencyReportsEnabled: transparencyEnabled,
          piiMaskingEnabled,
          auditTrailEnabled,
        },
        issueLinkType,
        arMappings,
        backlogStatusScopes,
        projectAiPolicies: normalizedProjectAiPolicies,
        tier,
      });
      if (geminiApiKey.trim()) setExistingGeminiApiKey(REDACTED);
      if (openaiApiKey.trim()) setExistingOpenaiApiKey(REDACTED);
      if (azureOpenaiApiKey.trim()) setExistingAzureOpenaiApiKey(REDACTED);
      setGeminiApiKey('');
      setOpenaiApiKey('');
      setAzureOpenaiApiKey('');
      alert('Settings saved successfully!');
    } catch(e: any) { alert(`Failed to save configuration: ${e.message || 'Unknown error'}`); }
    finally { setIsSaving(false); }
  }

  async function handleResetUsage() {
    if (!window.confirm('Are you sure you want to reset the usage counter?')) return;
    try {
      const res = await api.resetUsage() as any;
      if (res.success) {
        const usageRes = await api.getUsage() as any;
        if (usageRes.success && usageRes.usage) setUsage(usageRes.usage);
        alert('Usage counter reset successfully.');
      }
    } catch (e: any) { alert(`Failed to reset usage: ${e.message}`); }
  }

  async function testLlmConnection() {
    setIsTestingLlm(true); setLlmTestResult(null);
    try {
      const selectedProvider =
        provider === deepProfileProvider
          ? deepProfileProvider
          : provider === fastProfileProvider
            ? fastProfileProvider
            : provider;
      const selectedModel =
        selectedProvider === deepProfileProvider
          ? deepProfileModel
          : selectedProvider === fastProfileProvider
            ? fastProfileModel
            : getDefaultModelForProvider(selectedProvider, 'fast');
      const res = await api.testLlmConnection({
        provider: selectedProvider,
        model: selectedModel,
        geminiApiKey: selectedProvider === 'gemini' ? (geminiApiKey.trim() || existingGeminiApiKey || undefined) : undefined,
        geminiBaseUrl: selectedProvider === 'gemini' ? (geminiBaseUrl.trim() || undefined) : undefined,
        openaiApiKey: selectedProvider === 'openai' ? (openaiApiKey.trim() || existingOpenaiApiKey || undefined) : undefined,
        openaiBaseUrl: selectedProvider === 'openai' ? (openaiBaseUrl.trim() || undefined) : undefined,
        azureOpenaiApiKey: selectedProvider === 'azure_openai' ? (azureOpenaiApiKey.trim() || existingAzureOpenaiApiKey || undefined) : undefined,
        azureOpenaiEndpoint: selectedProvider === 'azure_openai' ? (azureOpenaiEndpoint.trim() || undefined) : undefined,
        azureOpenaiDeployment: selectedProvider === 'azure_openai' ? (azureOpenaiDeployment.trim() || undefined) : undefined,
        azureOpenaiApiVersion: selectedProvider === 'azure_openai' ? (azureOpenaiApiVersion.trim() || undefined) : undefined,
      }) as any;
      setLlmTestResult(res.success ? { ok: true, message: 'Connection successful.' } : { ok: false, message: res.error || 'Connection failed.' });
    } catch (err: any) { setLlmTestResult({ ok: false, message: err.message || 'Connection failed.' }); }
    finally { setIsTestingLlm(false); }
  }

  async function discoverJira() {
    setIsDiscovering(true);
    try {
      const res = await api.discoverJira() as any;
      if (res.success !== false) {
        setProjects(res.projects ?? []);
        setCustomFields(res.fields ?? []);
      }
    } catch(e: any) { console.error('Discovery failed', e); }
    finally { setIsDiscovering(false); }
  }

  async function onProjectSelect(projectKey: string) {
    setNewSource(prev => ({ ...prev, project: projectKey, statuses: [] }));
    try {
      const [it, st] = await Promise.all([api.discoverIssueTypes(projectKey) as Promise<any>, api.discoverStatuses(projectKey) as Promise<any>]);
      const fetchedTypes = it.issueTypes ?? [];
      const fetchedStatuses = st.statuses ?? [];
      setIssueTypes(fetchedTypes);
      setStatuses(fetchedStatuses);

      const autoType = detectDefaultIssueType(fetchedTypes);
      const autoStatuses = detectDefaultStatuses(fetchedStatuses);

      setNewSource(prev => ({
        ...prev,
        statuses: autoStatuses,
        ...(autoStatuses[0] ? { status: autoStatuses[0] } : {}),
        ...(autoType ? { issuetype: autoType } : {}),
      }));
    } catch {}
  }

  function addGoldSource() {
    const pickedStatuses = Array.isArray(newSource.statuses) ? newSource.statuses : [];
    if (!newSource.project || !newSource.issuetype || pickedStatuses.length === 0) return;
    setGoldSources(prev => [...prev, {
      key: `src${goldSources.length + 1}`,
      project: newSource.project!,
      issuetype: newSource.issuetype!,
      statuses: pickedStatuses,
      status: pickedStatuses[0],
      maxItems: 50,
      requirementsFieldId: null,
      arFieldIds: newSource.arFieldIds ?? [],
      targetProjects: [activeArProj],
    }]);
    setNewSource({ statuses: [] }); setIssueTypes([]); setStatuses([]);
  }

  useEffect(() => {
    const fastDefaults = getProviderDefaults(fastProfileProvider);
    if (!modelMatchesProvider(fastProfileModel, fastProfileProvider) || !isFastProfileModel(fastProfileModel)) {
      setFastProfileModel(fastDefaults.fastModel);
    }
  }, [fastProfileProvider, fastProfileModel]);

  useEffect(() => {
    const deepDefaults = getProviderDefaults(deepProfileProvider);
    if (!modelMatchesProvider(deepProfileModel, deepProfileProvider) || isFastProfileModel(deepProfileModel)) {
      setDeepProfileModel(deepDefaults.deepModel);
    }
  }, [deepProfileProvider, deepProfileModel]);

  const fetchModelsForProvider = useCallback(async (prov: 'openai' | 'gemini') => {
    setIsFetchingModels(prov);
    setModelFetchError(prev => ({ ...prev, [prov]: '' }));
    try {
      const res = await api.fetchAvailableModels(prov) as any;
      if (res.success && Array.isArray(res.models) && res.models.length > 0) {
        setDynamicModels(prev => ({ ...prev, [prov]: res.models }));
      } else {
        setModelFetchError(prev => ({ ...prev, [prov]: res.error || 'No models returned' }));
      }
    } catch (e: any) {
      setModelFetchError(prev => ({ ...prev, [prov]: e?.message ?? 'Fetch failed' }));
    } finally {
      setIsFetchingModels(null);
    }
  }, []);

  const getModelsForProvider = useCallback((prov: LlmProvider): { id: string; label: string }[] => {
    if ((prov === 'openai' || prov === 'gemini') && dynamicModels[prov]?.length) {
      return dynamicModels[prov];
    }
    return getAvailableModels(prov);
  }, [dynamicModels]);

  const fastProfileModels = useMemo(() => {
    const all = getModelsForProvider(fastProfileProvider);
    const filtered = all.filter(m => isFastProfileModel(m.id));
    return filtered.length ? filtered : all;
  }, [fastProfileProvider, getModelsForProvider]);

  const deepProfileModels = useMemo(() => {
    const all = getModelsForProvider(deepProfileProvider);
    const filtered = all.filter(m => !isFastProfileModel(m.id));
    return filtered.length ? filtered : all;
  }, [deepProfileProvider, getModelsForProvider]);

  const settingsNav = [
    { id: 'models', label: 'AI Infrastructure', icon: BrainCircuit, sub: 'Provider and execution profiles' },
    { id: 'jira', label: 'Project Setup', icon: Database, sub: 'Backlog, fields, examples' },
    { id: 'domain', label: 'Guidance', icon: Globe, sub: 'Roles and workspace rules' },
    { id: 'billing', label: 'Billing', icon: CreditCard, sub: 'Plan and controls' },
  ] as const;

  const wiUploadCopy = wiUploadState
    ? wiUploadState.stage === 'reading'
      ? 'Preparing document'
      : wiUploadState.stage === 'uploading'
        ? 'Uploading document'
        : 'Indexing for retrieval'
    : null;

  return (
    <div className="flex-1 flex flex-col h-full bg-[var(--rf-surface-soft)] relative overflow-hidden font-sans">
      <header className="shrink-0 h-[88px] border-b border-[var(--rf-border)] bg-white/80 backdrop-blur-md flex items-center justify-between px-8 z-30 sticky top-0 shadow-sm">
        <div className="flex items-center gap-5">
          <motion.button 
            onClick={onClose} 
            className="p-2.5 rounded-xl border border-[var(--rf-border)] bg-white text-[var(--rf-text-tertiary)] hover:bg-[var(--rf-surface-soft)] hover:text-[var(--rf-text)] transition-all shadow-sm"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
             <ChevronLeft className="w-5 h-5" />
          </motion.button>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Workspace Settings</div>
            <h2 className="mt-1 text-2xl font-bold tracking-tight text-[var(--rf-text)]">Configure Refinely</h2>
            <div className="flex items-center gap-2 mt-1.5">
              <span className={`text-[9px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wider border ${isAdmin ? 'bg-[var(--rf-success-subtle)] text-[var(--rf-success)] border-[var(--rf-success-subtle)]' : 'bg-[var(--rf-danger-subtle)] text-[var(--rf-danger)] border-[var(--rf-danger-subtle)]'}`}>
                {isAdmin ? 'Administrator' : 'Read-Only'}
              </span>
              <span className="text-[10px] text-[var(--rf-brand)] font-bold uppercase tracking-wider flex items-center gap-1 bg-[var(--rf-brand-muted)] px-2 py-0.5 rounded-md border border-blue-100">
                <ShieldCheck className="w-3 h-3" /> {tier} plan
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {isAdmin && activeTab !== 'jira' && (
            <motion.button 
              onClick={handleSave} 
              disabled={isSaving} 
              className="bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] disabled:opacity-50 disabled:bg-slate-400 text-white text-sm font-bold px-6 py-2.5 rounded-xl shadow-md shadow-[var(--rf-brand)]/20 transition-all flex items-center gap-2"
              whileTap={{ scale: 0.98 }}
            >
              {isSaving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Workspace
            </motion.button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-hidden flex">
          <div className="w-72 shrink-0 border-r border-[var(--rf-border)] bg-[var(--rf-surface-soft)]/50 p-6 flex flex-col gap-2">
            {settingsNav.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all ${
                  activeTab === tab.id ? 'bg-white text-[var(--rf-brand)] border-[var(--rf-border)] shadow-sm' : 'text-[var(--rf-text-tertiary)] border-transparent hover:bg-[var(--rf-surface-soft)] hover:text-[var(--rf-text-secondary)]'
                }`}
              >
                <tab.icon className={`w-4 h-4 ${activeTab === tab.id ? 'text-[var(--rf-brand)]' : 'text-[var(--rf-text-tertiary)]'}`} />
                <div className="text-left">
                  <div className={`text-xs font-bold ${activeTab === tab.id ? 'text-[var(--rf-brand-hover)]' : 'text-[var(--rf-text-secondary)]'}`}>{tab.label}</div>
                  <div className={`text-[10px] mt-0.5 ${activeTab === tab.id ? 'text-[var(--rf-brand)]' : 'text-[var(--rf-text-tertiary)]'}`}>{tab.sub}</div>
                </div>
              </button>
            ))}
            
            <div className="mt-auto pt-6 border-t border-[var(--rf-border)]">
               <div className="bg-white rounded-xl p-4 border border-[var(--rf-border)] shadow-sm">
                 <div>
                   <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-2">Recommended Order</div>
                   <div className="text-xs font-semibold text-[var(--rf-text-secondary)] space-y-1.5">
                     <div>1. AI Infrastructure</div>
                     <div>2. Project Setup</div>
                     <div>3. Guidance</div>
                   </div>
                 </div>
                 <div className="pt-4 mt-4 border-t border-[var(--rf-border-subtle)]">
                   <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-1">Current Plan</div>
                   <div className="text-sm font-bold text-[var(--rf-text)] capitalize">{tier}</div>
                   <div className="text-[11px] font-medium text-[var(--rf-text-tertiary)] mt-1">
                     {usage?.currentMonth ?? 0} / {limits?.generationsPerMonth === -1 ? 'Unlimited' : limits?.generationsPerMonth ?? 0} generations
                   </div>
                 </div>
               </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-8 lg:p-10 custom-scrollbar bg-[var(--rf-surface-soft)]/50">
            {activeTab === 'models' && (
              <motion.div 
                className="max-w-3xl space-y-6"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
              >
                <div className="space-y-1">
                   <h3 className="text-2xl font-bold text-[var(--rf-text)] tracking-tight">AI Infrastructure</h3>
                   <p className="text-[var(--rf-text-tertiary)] text-sm">Workspace administrators manage providers and execution profiles here. End users only see the simplified Fast and Deep choices in the main flow.</p>
                </div>

                {!isAdmin ? (
                  <div className="bg-white rounded-2xl p-6 lg:p-8 border border-[var(--rf-border)] shadow-sm space-y-6">
                    <div className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-4 text-sm text-[var(--rf-text-secondary)] flex items-start gap-3">
                      <ShieldCheck className="w-5 h-5 text-[var(--rf-brand)] shrink-0 mt-0.5" />
                      <div>
                        <div className="font-bold text-[var(--rf-text)]">AI infrastructure is administrator-managed</div>
                        <div className="mt-1 text-xs leading-relaxed">Users can still choose Fast or Deep when creating work, but provider credentials and model routing are intentionally hidden from this view.</div>
                      </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-4">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Fast Profile</div>
                        <div className="mt-2 text-[11px] font-bold text-[var(--rf-brand)]">{getProviderLabel(fastProfileProvider)}</div>
                        <div className="mt-2 text-sm font-bold text-[var(--rf-text)]">{getModelLabel(fastProfileModel)}</div>
                        <div className="mt-1 text-[11px] text-[var(--rf-text-tertiary)]">Lighter reasoning — clarification, assessment, follow-up work.</div>
                      </div>
                      <div className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-4">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Deep Profile</div>
                        <div className="mt-2 text-[11px] font-bold text-[var(--rf-brand)]">{getProviderLabel(deepProfileProvider)}</div>
                        <div className="mt-2 text-sm font-bold text-[var(--rf-text)]">{getModelLabel(deepProfileModel)}</div>
                        <div className="mt-1 text-[11px] text-[var(--rf-text-tertiary)]">Heavier reasoning — feature generation and acceptance requirements.</div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="bg-white rounded-2xl p-6 lg:p-8 border border-[var(--rf-border)] shadow-sm space-y-8">
                    <div className="space-y-5">
                      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                        <div className="space-y-1">
                          <div className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Planning Insights</div>
                          <p className="text-sm text-[var(--rf-text-tertiary)]">Track how the adaptive planner is behaving across this workspace so you can tune defaults without guessing.</p>
                        </div>
                        <button
                          type="button"
                          onClick={loadAiInsights}
                          disabled={isLoadingAiInsights}
                          className="inline-flex items-center justify-center gap-2 rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-secondary)] transition hover:border-[var(--rf-brand)]/40 hover:text-[var(--rf-text)] disabled:opacity-60"
                        >
                          <RefreshCw className={`w-4 h-4 ${isLoadingAiInsights ? 'animate-spin' : ''}`} />
                          Refresh insights
                        </button>
                      </div>

                      {aiInsights ? (
                        <div className="space-y-4 rounded-2xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)]/55 p-4">
                          <div className="grid gap-3 md:grid-cols-4">
                            {[
                              { label: 'Tracked sessions', value: aiInsights.totalSessions },
                              { label: 'Avg features', value: aiInsights.avgFeatureCount },
                              { label: 'Avg rounds', value: aiInsights.avgDiscoveryRounds },
                              { label: 'Avg coverage', value: aiInsights.avgCoverageScore !== null ? `${aiInsights.avgCoverageScore}%` : 'n/a' },
                              { label: 'Single-feature runs', value: aiInsights.singleFeatureSessions },
                              { label: 'Over target runs', value: aiInsights.overTargetFeatureSessions },
                              { label: 'Multi-round discovery', value: aiInsights.multiRoundSessions },
                              { label: 'Initiative outputs', value: aiInsights.initiativeSessions },
                            ].map((item) => (
                              <div key={item.label} className="rounded-xl border border-[var(--rf-border)] bg-white px-4 py-3 shadow-sm">
                                <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">{item.label}</div>
                                <div className="mt-2 text-2xl font-bold tracking-tight text-[var(--rf-text)]">{item.value}</div>
                              </div>
                            ))}
                          </div>

                          <div className="grid gap-4 xl:grid-cols-4">
                            <div className="rounded-xl border border-[var(--rf-border)] bg-white p-4 shadow-sm xl:col-span-2">
                              <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Scope mix</div>
                              <div className="mt-3 space-y-2.5">
                                {aiInsights.scopeBreakdown.length ? aiInsights.scopeBreakdown.map((item) => (
                                  <div key={item.key} className="flex items-center justify-between gap-3 text-sm">
                                    <div>
                                      <div className="font-bold text-[var(--rf-text)]">{formatInsightKey(item.key)}</div>
                                      <div className="text-[11px] text-[var(--rf-text-tertiary)]">
                                        {item.avgFeatures} avg features • {item.avgDiscoveryRounds} avg rounds
                                        {item.avgCoverageScore !== null ? ` • ${item.avgCoverageScore}% coverage` : ''}
                                      </div>
                                    </div>
                                    <span className="rounded-md bg-[var(--rf-brand-muted)] px-2 py-1 text-[11px] font-bold text-[var(--rf-brand)]">
                                      {item.count}
                                    </span>
                                  </div>
                                )) : (
                                  <div className="text-sm text-[var(--rf-text-tertiary)]">No planner sessions recorded yet.</div>
                                )}
                              </div>
                            </div>

                            <div className="rounded-xl border border-[var(--rf-border)] bg-white p-4 shadow-sm">
                              <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Reasoning mix</div>
                              <div className="mt-3 space-y-2.5">
                                {aiInsights.reasoningBreakdown.length ? aiInsights.reasoningBreakdown.map((item) => (
                                  <div key={item.key} className="flex items-center justify-between gap-3 text-sm">
                                    <span className="font-bold text-[var(--rf-text)]">{formatInsightKey(item.key)}</span>
                                    <span className="rounded-md bg-[var(--rf-surface-soft)] px-2 py-1 text-[11px] font-bold text-[var(--rf-text-secondary)]">{item.count}</span>
                                  </div>
                                )) : (
                                  <div className="text-sm text-[var(--rf-text-tertiary)]">No reasoning activity yet.</div>
                                )}
                              </div>
                              <div className="mt-4 border-t border-[var(--rf-border-subtle)] pt-4">
                                <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Output mix</div>
                                <div className="mt-3 space-y-2.5">
                                  {aiInsights.outputBreakdown.length ? aiInsights.outputBreakdown.map((item) => (
                                    <div key={item.key} className="flex items-center justify-between gap-3 text-sm">
                                      <span className="font-bold text-[var(--rf-text)]">{formatInsightKey(item.key)}</span>
                                      <span className="rounded-md bg-[var(--rf-surface-soft)] px-2 py-1 text-[11px] font-bold text-[var(--rf-text-secondary)]">{item.count}</span>
                                    </div>
                                  )) : (
                                    <div className="text-sm text-[var(--rf-text-tertiary)]">No output overrides recorded yet.</div>
                                  )}
                                </div>
                              </div>
                            </div>

                            <div className="rounded-xl border border-[var(--rf-border)] bg-white p-4 shadow-sm">
                              <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Recent sessions</div>
                              <div className="mt-3 space-y-2.5">
                                {aiInsights.recentSessions.length ? aiInsights.recentSessions.map((session) => (
                                  <div key={session.sessionId} className="rounded-lg border border-[var(--rf-border-subtle)] bg-[var(--rf-surface-soft)]/45 px-3 py-2">
                                    <div className="flex items-center justify-between gap-2">
                                      <div className="text-xs font-bold text-[var(--rf-text)]">
                                        {formatInsightKey(session.scopeMode ?? 'unclassified')}
                                      </div>
                                      <div className="text-[10px] font-medium text-[var(--rf-text-tertiary)]">
                                        {new Date(session.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                      </div>
                                    </div>
                                    <div className="mt-1 text-[11px] text-[var(--rf-text-tertiary)]">
                                      {session.projectKey === '*' ? 'Workspace default' : session.projectKey} • {formatInsightKey(session.reasoningMode ?? 'fast')}
                                      {session.generatedFeatureCount !== undefined ? ` • ${session.generatedFeatureCount} features` : ''}
                                      {session.discoveryRounds !== undefined ? ` • ${session.discoveryRounds} rounds` : ''}
                                      {session.latestCoverageScore !== null && session.latestCoverageScore !== undefined ? ` • ${session.latestCoverageScore}% coverage` : ''}
                                    </div>
                                  </div>
                                )) : (
                                  <div className="text-sm text-[var(--rf-text-tertiary)]">No recent session telemetry yet.</div>
                                )}
                              </div>
                            </div>
                          </div>

                          {aiInsights.projectBreakdown.length > 0 && (
                            <div className="rounded-xl border border-[var(--rf-border)] bg-white p-4 shadow-sm">
                              <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Top projects</div>
                              <div className="mt-3 flex flex-wrap gap-2">
                                {aiInsights.projectBreakdown.map((item) => (
                                  <span key={item.key} className="rounded-full border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-1 text-[11px] font-bold text-[var(--rf-text-secondary)]">
                                    {formatInsightKey(item.key)}: {item.count}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="rounded-xl border border-dashed border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-5 text-sm text-[var(--rf-text-tertiary)]">
                          {isLoadingAiInsights ? 'Loading planner insights…' : 'No planner insights recorded yet. Run a few clarify and generation sessions to start seeing workspace behavior.'}
                        </div>
                      )}
                    </div>

                    <div className="space-y-3">
                      <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Provider Credentials</label>
                      <p className="text-sm text-[var(--rf-text-tertiary)]">Select a provider to enter or test its credentials. Actual routing is set independently by the Fast and Deep profiles below.</p>
                      <div className="grid gap-3 md:grid-cols-2">
                        {PROVIDER_OPTIONS.map((option) => (
                          <button
                            key={option.id}
                            onClick={() => setProvider(option.id)}
                            className={`rounded-xl border px-4 py-4 text-left transition-all ${
                              provider === option.id
                                ? 'border-[var(--rf-brand)] bg-[var(--rf-brand-muted)] shadow-sm'
                                : 'border-[var(--rf-border)] bg-[var(--rf-surface-soft)] hover:border-[var(--rf-brand)]/40'
                            }`}
                          >
                            <div className="text-sm font-bold text-[var(--rf-text)]">{option.label}</div>
                            <div className="mt-1 text-xs text-[var(--rf-text-tertiary)]">{option.blurb}</div>
                          </button>
                        ))}
                      </div>
                    </div>

                    {provider === 'forge_llms' && (
                      <div className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-4 text-sm text-[var(--rf-text-secondary)]">
                        Forge-managed routing is active. No external API keys are required for this provider.
                      </div>
                    )}

                    {provider === 'openai' && (
                      <motion.div className="grid gap-4 md:grid-cols-2" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                        <div className="space-y-2 md:col-span-2">
                          <div className="flex justify-between items-center px-1">
                            <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">OpenAI API Key</label>
                            {existingOpenaiApiKey && <button onClick={() => { setExistingOpenaiApiKey(''); setOpenaiApiKey(''); }} className="text-[10px] font-bold text-rose-500 hover:text-[var(--rf-danger)]">Clear Stored</button>}
                          </div>
                          <input type="password" value={openaiApiKey} onChange={e => setOpenaiApiKey(e.target.value)} placeholder={existingOpenaiApiKey ? '••••••••• (Stored)' : 'sk-…'} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                        </div>
                        <div className="space-y-2 md:col-span-2">
                          <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">Base URL</label>
                          <input type="text" value={openaiBaseUrl} onChange={e => setOpenaiBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                        </div>
                      </motion.div>
                    )}

                    {provider === 'gemini' && (
                      <motion.div className="grid gap-4 md:grid-cols-2" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                        <div className="space-y-2 md:col-span-2">
                          <div className="flex justify-between items-center px-1">
                            <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Gemini API Key</label>
                            {existingGeminiApiKey && <button onClick={() => { setExistingGeminiApiKey(''); setGeminiApiKey(''); }} className="text-[10px] font-bold text-rose-500 hover:text-[var(--rf-danger)]">Clear Stored</button>}
                          </div>
                          <input type="password" value={geminiApiKey} onChange={e => setGeminiApiKey(e.target.value)} placeholder={existingGeminiApiKey ? '••••••••• (Stored)' : 'AIza…'} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                        </div>
                        <div className="space-y-2 md:col-span-2">
                          <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">Base URL</label>
                          <input type="text" value={geminiBaseUrl} onChange={e => setGeminiBaseUrl(e.target.value)} placeholder="https://generativelanguage.googleapis.com/v1beta" className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                        </div>
                      </motion.div>
                    )}

                    {provider === 'azure_openai' && (
                      <motion.div className="grid gap-4 md:grid-cols-2" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                        <div className="space-y-2 md:col-span-2">
                          <div className="flex justify-between items-center px-1">
                            <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Azure OpenAI API Key</label>
                            {existingAzureOpenaiApiKey && <button onClick={() => { setExistingAzureOpenaiApiKey(''); setAzureOpenaiApiKey(''); }} className="text-[10px] font-bold text-rose-500 hover:text-[var(--rf-danger)]">Clear Stored</button>}
                          </div>
                          <input type="password" value={azureOpenaiApiKey} onChange={e => setAzureOpenaiApiKey(e.target.value)} placeholder={existingAzureOpenaiApiKey ? '••••••••• (Stored)' : 'Azure key'} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                        </div>
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">Endpoint</label>
                          <input type="text" value={azureOpenaiEndpoint} onChange={e => setAzureOpenaiEndpoint(e.target.value)} placeholder="https://your-resource.openai.azure.com" className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                        </div>
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">Deployment</label>
                          <input type="text" value={azureOpenaiDeployment} onChange={e => setAzureOpenaiDeployment(e.target.value)} placeholder="gpt-4o-prod" className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                        </div>
                        <div className="space-y-2 md:col-span-2">
                          <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">API Version</label>
                          <input type="text" value={azureOpenaiApiVersion} onChange={e => setAzureOpenaiApiVersion(e.target.value)} placeholder="2024-10-21" className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                        </div>
                      </motion.div>
                    )}

                    <div className="space-y-5 pt-6 border-t border-[var(--rf-border-subtle)]">
                      <div className="space-y-1">
                        <div className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Workspace AI Policy</div>
                        <p className="text-sm text-[var(--rf-text-tertiary)]">Set the default planning behavior for everyone in this workspace. These values drive the Fast and Deep experience users see in the main flow.</p>
                      </div>

                      <div className="grid gap-3 md:grid-cols-2">
                        {(Object.entries(AI_POLICY_PRESETS) as Array<[AiPolicyPreset, (typeof AI_POLICY_PRESETS)[AiPolicyPreset]]>).map(([presetId, preset]) => (
                          <button
                            key={presetId}
                            type="button"
                            onClick={() => applyWorkspacePolicyPreset(presetId)}
                            className={`rounded-xl border px-4 py-4 text-left transition-all ${
                              workspacePreset === presetId
                                ? 'border-[var(--rf-brand)] bg-[var(--rf-brand-muted)] shadow-sm'
                                : 'border-[var(--rf-border)] bg-[var(--rf-surface-soft)] hover:border-[var(--rf-brand)]/40'
                            }`}
                          >
                            <div className="text-sm font-bold text-[var(--rf-text)]">{preset.label}</div>
                            <div className="mt-1 text-xs text-[var(--rf-text-tertiary)]">{preset.description}</div>
                          </button>
                        ))}
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">Default Reasoning</label>
                          <div className="flex p-1 bg-[var(--rf-surface-soft)] rounded-xl border border-[var(--rf-border)]">
                            {(['fast', 'deep'] as const).map((mode) => (
                              <button
                                key={mode}
                                type="button"
                                onClick={() => setDefaultReasoningMode(mode)}
                                className={`flex-1 py-2 text-[11px] font-bold uppercase tracking-wider rounded-lg transition-all ${
                                  defaultReasoningMode === mode
                                    ? 'bg-white text-[var(--rf-brand)] shadow-sm border border-[var(--rf-border)]/50'
                                    : 'text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text-secondary)]'
                                }`}
                              >
                                {mode}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">Default Output</label>
                          <div className="flex p-1 bg-[var(--rf-surface-soft)] rounded-xl border border-[var(--rf-border)]">
                            {([
                              { id: 'single', label: 'Single' },
                              { id: 'auto', label: 'Auto' },
                              { id: 'full_breakdown', label: 'Full' },
                            ] as const).map((mode) => (
                              <button
                                key={mode.id}
                                type="button"
                                onClick={() => setDefaultOutputMode(mode.id)}
                                className={`flex-1 py-2 text-[11px] font-bold uppercase tracking-wider rounded-lg transition-all ${
                                  defaultOutputMode === mode.id
                                    ? 'bg-white text-[var(--rf-brand)] shadow-sm border border-[var(--rf-border)]/50'
                                    : 'text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text-secondary)]'
                                }`}
                              >
                                {mode.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <label className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-3 text-sm text-[var(--rf-text-secondary)] flex items-start gap-3 cursor-pointer">
                          <input type="checkbox" checked={allowReasoningModeOverride} onChange={e => setAllowReasoningModeOverride(e.target.checked)} className="mt-0.5 rounded border-[var(--rf-border)] text-[var(--rf-brand)] focus:ring-[var(--rf-brand)]/20" />
                          <span>
                            <span className="block font-bold text-[var(--rf-text)]">Let users choose Fast or Deep</span>
                            <span className="block text-xs text-[var(--rf-text-tertiary)] mt-1">Turn this off if you want every request in this workspace to follow one default reasoning mode.</span>
                          </span>
                        </label>
                        <label className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-3 text-sm text-[var(--rf-text-secondary)] flex items-start gap-3 cursor-pointer">
                          <input type="checkbox" checked={allowOutputModeOverride} onChange={e => setAllowOutputModeOverride(e.target.checked)} className="mt-0.5 rounded border-[var(--rf-border)] text-[var(--rf-brand)] focus:ring-[var(--rf-brand)]/20" />
                          <span>
                            <span className="block font-bold text-[var(--rf-text)]">Let users override output shape</span>
                            <span className="block text-xs text-[var(--rf-text-tertiary)] mt-1">Turn this off to keep output sizing fixed to workspace or project policy.</span>
                          </span>
                        </label>
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">Fast mode — max clarifying questions</label>
                          <input type="number" min={2} max={4} value={simpleAskMaxQuestions} onChange={e => setSimpleAskMaxQuestions(Number(e.target.value))} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                        </div>
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">Deep mode — target questions per round</label>
                          <input type="number" min={4} max={10} value={deepModeRoundTarget} onChange={e => setDeepModeRoundTarget(Number(e.target.value))} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                        </div>
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">Deep mode — max questions per round</label>
                          <input type="number" min={8} max={14} value={enterpriseMaxQuestionsPerRound} onChange={e => setEnterpriseMaxQuestionsPerRound(Number(e.target.value))} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                        </div>
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">Deep mode — max discovery rounds</label>
                          <input type="number" min={1} max={6} value={maxDeepDiscoveryRounds} onChange={e => setMaxDeepDiscoveryRounds(Number(e.target.value))} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                        </div>
                      </div>
                    </div>

                    <div className="space-y-5 pt-6 border-t border-[var(--rf-border-subtle)]">
                      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                        <div className="space-y-1">
                          <div className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Project AI Override</div>
                          <p className="text-sm text-[var(--rf-text-tertiary)]">Override the workspace defaults for a specific project when one team needs different planning behavior.</p>
                        </div>
                        <select
                          value={activeArProj}
                          onChange={e => setActiveArProj(e.target.value)}
                          className="bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-bold text-[var(--rf-text)] focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none md:w-72 transition"
                        >
                          <option value="*">Select a project...</option>
                          {projects.map(project => (
                            <option key={project.key} value={project.key}>{project.key}: {project.name}</option>
                          ))}
                        </select>
                      </div>

                      {activeArProj === '*' ? (
                        <div className="rounded-xl border border-dashed border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-5 text-sm text-[var(--rf-text-tertiary)] text-center">
                          Select a project to define project-specific AI behavior.
                        </div>
                      ) : (
                        <>
                          <div className="grid gap-3 md:grid-cols-2">
                            <button
                              type="button"
                              onClick={() => applyProjectPolicyPreset('inherit')}
                              className={`rounded-xl border px-4 py-4 text-left transition-all ${
                                !currentProjectAiPolicy || currentProjectAiPolicy.preset === 'inherit'
                                  ? 'border-[var(--rf-brand)] bg-[var(--rf-brand-muted)] shadow-sm'
                                  : 'border-[var(--rf-border)] bg-[var(--rf-surface-soft)] hover:border-[var(--rf-brand)]/40'
                              }`}
                            >
                              <div className="text-sm font-bold text-[var(--rf-text)]">Inherit Workspace Policy</div>
                              <div className="mt-1 text-xs text-[var(--rf-text-tertiary)]">Use the workspace defaults without project-specific AI behavior.</div>
                            </button>
                            {(Object.entries(AI_POLICY_PRESETS) as Array<[AiPolicyPreset, (typeof AI_POLICY_PRESETS)[AiPolicyPreset]]>).map(([presetId, preset]) => (
                              <button
                                key={presetId}
                                type="button"
                                onClick={() => applyProjectPolicyPreset(presetId)}
                                className={`rounded-xl border px-4 py-4 text-left transition-all ${
                                  currentProjectAiPolicy?.preset === presetId
                                    ? 'border-[var(--rf-brand)] bg-[var(--rf-brand-muted)] shadow-sm'
                                    : 'border-[var(--rf-border)] bg-[var(--rf-surface-soft)] hover:border-[var(--rf-brand)]/40'
                                }`}
                              >
                                <div className="text-sm font-bold text-[var(--rf-text)]">{preset.label}</div>
                                <div className="mt-1 text-xs text-[var(--rf-text-tertiary)]">{preset.description}</div>
                              </button>
                            ))}
                          </div>

                          {currentProjectAiPolicy && currentProjectAiPolicy.preset !== 'inherit' && (
                            <div className="space-y-4 rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-4">
                              <div className="grid gap-4 md:grid-cols-2">
                                <div className="space-y-2">
                                  <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">Project Default Reasoning</label>
                                  <div className="flex p-1 bg-white rounded-xl border border-[var(--rf-border)]">
                                    {(['fast', 'deep'] as const).map((mode) => (
                                      <button
                                        key={mode}
                                        type="button"
                                        onClick={() => updateProjectAiPolicy({ defaultReasoningMode: mode })}
                                        className={`flex-1 py-2 text-[11px] font-bold uppercase tracking-wider rounded-lg transition-all ${
                                          currentProjectAiPolicy.defaultReasoningMode === mode
                                            ? 'bg-[var(--rf-brand-muted)] text-[var(--rf-brand)]'
                                            : 'text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text-secondary)]'
                                        }`}
                                      >
                                        {mode}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                                <div className="space-y-2">
                                  <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">Project Default Output</label>
                                  <div className="flex p-1 bg-white rounded-xl border border-[var(--rf-border)]">
                                    {([
                                      { id: 'single', label: 'Single' },
                                      { id: 'auto', label: 'Auto' },
                                      { id: 'full_breakdown', label: 'Full' },
                                    ] as const).map((mode) => (
                                      <button
                                        key={mode.id}
                                        type="button"
                                        onClick={() => updateProjectAiPolicy({ defaultOutputMode: mode.id })}
                                        className={`flex-1 py-2 text-[11px] font-bold uppercase tracking-wider rounded-lg transition-all ${
                                          currentProjectAiPolicy.defaultOutputMode === mode.id
                                            ? 'bg-[var(--rf-brand-muted)] text-[var(--rf-brand)]'
                                            : 'text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text-secondary)]'
                                        }`}
                                      >
                                        {mode.label}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              </div>

                              <div className="grid gap-4 md:grid-cols-2">
                                <div className="space-y-2">
                                  <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">Project Fast Provider</label>
                                  <select
                                    value={currentProjectAiPolicy.fastProfileProvider ?? fastProfileProvider}
                                    onChange={e => handleProjectRouteProviderChange('fast', e.target.value as LlmProvider)}
                                    className="w-full bg-white border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-semibold text-[var(--rf-text)] focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none transition"
                                  >
                                    {PROVIDER_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                                  </select>
                                </div>
                                <div className="space-y-2">
                                  <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">Project Fast Profile</label>
                                  <select
                                    value={currentProjectAiPolicy.fastProfileModel ?? fastProfileModel}
                                    onChange={e => updateProjectAiPolicy({ fastProfileModel: e.target.value })}
                                    className="w-full bg-white border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-semibold text-[var(--rf-text)] focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none transition"
                                  >
                                    {getProfileModels(currentProjectAiPolicy.fastProfileProvider ?? fastProfileProvider, 'fast').map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                                  </select>
                                </div>
                                <div className="space-y-2">
                                  <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">Project Deep Provider</label>
                                  <select
                                    value={currentProjectAiPolicy.deepProfileProvider ?? deepProfileProvider}
                                    onChange={e => handleProjectRouteProviderChange('deep', e.target.value as LlmProvider)}
                                    className="w-full bg-white border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-semibold text-[var(--rf-text)] focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none transition"
                                  >
                                    {PROVIDER_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                                  </select>
                                </div>
                                <div className="space-y-2">
                                  <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">Project Deep Profile</label>
                                  <select
                                    value={currentProjectAiPolicy.deepProfileModel ?? deepProfileModel}
                                    onChange={e => updateProjectAiPolicy({ deepProfileModel: e.target.value })}
                                    className="w-full bg-white border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-semibold text-[var(--rf-text)] focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none transition"
                                  >
                                    {getProfileModels(currentProjectAiPolicy.deepProfileProvider ?? deepProfileProvider, 'deep').map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                                  </select>
                                </div>
                              </div>

                              <div className="grid gap-4 md:grid-cols-2">
                                <label className="rounded-xl border border-[var(--rf-border)] bg-white px-4 py-3 text-sm text-[var(--rf-text-secondary)] flex items-start gap-3 cursor-pointer">
                                  <input type="checkbox" checked={currentProjectAiPolicy.allowReasoningModeOverride ?? true} onChange={e => updateProjectAiPolicy({ allowReasoningModeOverride: e.target.checked })} className="mt-0.5 rounded border-[var(--rf-border)] text-[var(--rf-brand)] focus:ring-[var(--rf-brand)]/20" />
                                  <span>
                                    <span className="block font-bold text-[var(--rf-text)]">Allow project users to choose Fast or Deep</span>
                                    <span className="block text-xs text-[var(--rf-text-tertiary)] mt-1">Lock this project to one reasoning mode if needed.</span>
                                  </span>
                                </label>
                                <label className="rounded-xl border border-[var(--rf-border)] bg-white px-4 py-3 text-sm text-[var(--rf-text-secondary)] flex items-start gap-3 cursor-pointer">
                                  <input type="checkbox" checked={currentProjectAiPolicy.allowOutputModeOverride ?? true} onChange={e => updateProjectAiPolicy({ allowOutputModeOverride: e.target.checked })} className="mt-0.5 rounded border-[var(--rf-border)] text-[var(--rf-brand)] focus:ring-[var(--rf-brand)]/20" />
                                  <span>
                                    <span className="block font-bold text-[var(--rf-text)]">Allow project users to override output shape</span>
                                    <span className="block text-xs text-[var(--rf-text-tertiary)] mt-1">Hide Single / Auto / Full when the project should stay standardized.</span>
                                  </span>
                                </label>
                              </div>

                              <div className="grid gap-4 md:grid-cols-2">
                                <div className="space-y-2">
                                  <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">Fast mode — max clarifying questions</label>
                                  <input type="number" min={2} max={4} value={currentProjectAiPolicy.simpleAskMaxQuestions ?? 4} onChange={e => updateProjectAiPolicy({ simpleAskMaxQuestions: Number(e.target.value) })} className="w-full bg-white border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                                </div>
                                <div className="space-y-2">
                                  <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">Deep mode — target questions per round</label>
                                  <input type="number" min={4} max={10} value={currentProjectAiPolicy.deepModeRoundTarget ?? 6} onChange={e => updateProjectAiPolicy({ deepModeRoundTarget: Number(e.target.value) })} className="w-full bg-white border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                                </div>
                                <div className="space-y-2">
                                  <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">Deep mode — max questions per round</label>
                                  <input type="number" min={8} max={14} value={currentProjectAiPolicy.enterpriseMaxQuestionsPerRound ?? 10} onChange={e => updateProjectAiPolicy({ enterpriseMaxQuestionsPerRound: Number(e.target.value) })} className="w-full bg-white border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                                </div>
                                <div className="space-y-2">
                                  <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">Deep mode — max discovery rounds</label>
                                  <input type="number" min={1} max={6} value={currentProjectAiPolicy.maxDeepDiscoveryRounds ?? 3} onChange={e => updateProjectAiPolicy({ maxDeepDiscoveryRounds: Number(e.target.value) })} className="w-full bg-white border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                                </div>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>

                    <div className="space-y-5 pt-6 border-t border-[var(--rf-border-subtle)]">
                      <div className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-3 text-xs text-[var(--rf-text-secondary)] flex items-start gap-3">
                        <Info className="w-4 h-4 text-[var(--rf-brand)] shrink-0 mt-0.5" />
                        <p><span className="font-bold text-[var(--rf-text)]">Execution profiles:</span> Fast powers lighter reasoning and follow-up work. Deep powers the heavier generation passes. Users only see these profile concepts, not raw model names.</p>
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">Fast Provider</label>
                          <select value={fastProfileProvider} onChange={e => handleFastProfileProviderChange(e.target.value as LlmProvider)} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-semibold text-[var(--rf-text)] focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none transition">
                            {PROVIDER_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                          </select>
                        </div>
                        <div className="space-y-2">
                          <div className="flex items-center justify-between px-1">
                            <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Fast Profile</label>
                            {(fastProfileProvider === 'openai' || fastProfileProvider === 'gemini') && (
                              <button
                                onClick={() => fetchModelsForProvider(fastProfileProvider as 'openai' | 'gemini')}
                                disabled={isFetchingModels === fastProfileProvider}
                                className="flex items-center gap-1 text-[10px] font-bold text-[var(--rf-brand)] hover:underline disabled:opacity-50"
                                title="Refresh model list from provider API"
                              >
                                <RefreshCw className={`w-3 h-3 ${isFetchingModels === fastProfileProvider ? 'animate-spin' : ''}`} />
                                {dynamicModels[fastProfileProvider]?.length ? 'Refresh' : 'Load models'}
                              </button>
                            )}
                          </div>
                          <select value={fastProfileModel} onChange={e => setFastProfileModel(e.target.value)} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-semibold text-[var(--rf-text)] focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none transition">
                            {fastProfileModels.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                          </select>
                          {modelFetchError[fastProfileProvider] && <p className="text-[11px] text-rose-500 px-1">{modelFetchError[fastProfileProvider]}</p>}
                          {dynamicModels[fastProfileProvider]?.length ? <p className="text-[11px] text-[var(--rf-brand)] px-1">{dynamicModels[fastProfileProvider].length} models loaded from API</p> : null}
                          <div className="text-[11px] text-[var(--rf-text-tertiary)] px-1">Used for lightweight assessment, clarify, refinement, and other short-turn work.</div>
                        </div>
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest px-1">Deep Provider</label>
                          <select value={deepProfileProvider} onChange={e => handleDeepProfileProviderChange(e.target.value as LlmProvider)} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-semibold text-[var(--rf-text)] focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none transition">
                            {PROVIDER_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                          </select>
                        </div>
                        <div className="space-y-2">
                          <div className="flex items-center justify-between px-1">
                            <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Deep Profile</label>
                            {(deepProfileProvider === 'openai' || deepProfileProvider === 'gemini') && (
                              <button
                                onClick={() => fetchModelsForProvider(deepProfileProvider as 'openai' | 'gemini')}
                                disabled={isFetchingModels === deepProfileProvider}
                                className="flex items-center gap-1 text-[10px] font-bold text-[var(--rf-brand)] hover:underline disabled:opacity-50"
                                title="Refresh model list from provider API"
                              >
                                <RefreshCw className={`w-3 h-3 ${isFetchingModels === deepProfileProvider ? 'animate-spin' : ''}`} />
                                {dynamicModels[deepProfileProvider]?.length ? 'Refresh' : 'Load models'}
                              </button>
                            )}
                          </div>
                          <select value={deepProfileModel} onChange={e => setDeepProfileModel(e.target.value)} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-semibold text-[var(--rf-text)] focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none transition">
                            {deepProfileModels.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                          </select>
                          {modelFetchError[deepProfileProvider] && <p className="text-[11px] text-rose-500 px-1">{modelFetchError[deepProfileProvider]}</p>}
                          {dynamicModels[deepProfileProvider]?.length ? <p className="text-[11px] text-[var(--rf-brand)] px-1">{dynamicModels[deepProfileProvider].length} models loaded from API</p> : null}
                          <div className="text-[11px] text-[var(--rf-text-tertiary)] px-1">Used for feature generation, acceptance requirements, and heavier reasoning.</div>
                        </div>
                      </div>

                      <div className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-4 text-sm text-[var(--rf-text-secondary)]">
                        Routing is fixed to two lanes only: <span className="font-bold text-[var(--rf-text)]">Fast</span> handles quick analysis and clarifying work, while <span className="font-bold text-[var(--rf-text)]">Deep</span> handles the heavy generation passes. There is no separate stage-by-stage model routing anymore.
                      </div>
                    </div>

                    <div className="pt-6 border-t border-[var(--rf-border-subtle)] flex flex-col gap-4 sm:flex-row sm:items-center">
                      <motion.button 
                        onClick={testLlmConnection} 
                        disabled={isTestingLlm} 
                        className="bg-[var(--rf-text)] hover:bg-black text-white text-[11px] font-bold uppercase tracking-widest px-5 py-2.5 rounded-lg transition-all flex items-center justify-center gap-2"
                        whileTap={{ scale: 0.98 }}
                      >
                         {isTestingLlm ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />} Test Provider Connection
                      </motion.button>
                      {llmTestResult && (
                        <div className={`px-4 py-2.5 rounded-lg text-[11px] font-bold flex items-center gap-2 border ${llmTestResult.ok ? 'bg-[var(--rf-success-subtle)] text-[var(--rf-success)] border-[var(--rf-success-subtle)]' : 'bg-[var(--rf-danger-subtle)] text-[var(--rf-danger)] border-[var(--rf-danger-subtle)]'}`}>
                           {llmTestResult.ok ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />} {llmTestResult.message}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </motion.div>
            )}

            {activeTab === 'jira' && (
              <motion.div 
                className="max-w-4xl space-y-8"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
              >
                <div className="space-y-1">
                  <h3 className="text-2xl font-bold text-[var(--rf-text)] tracking-tight">Project Setup</h3>
                  <p className="text-[var(--rf-text-tertiary)] text-sm">Sync Jira, select a project, and define its backlog context and optional boosters.</p>
                </div>

                <div className="space-y-6">
                  {/* Step 1 */}
                  <div className="bg-white rounded-2xl p-6 border border-[var(--rf-border)] shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-6">
                    <div className="space-y-1">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Step 1</div>
                      <h4 className="text-lg font-bold text-[var(--rf-text)]">Workspace Jira Discovery</h4>
                      <p className="text-xs font-medium text-[var(--rf-text-tertiary)]">Refresh projects and fields before editing project rules.</p>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="flex gap-4 mr-2">
                        <div className="text-center">
                          <div className="text-2xl font-black text-[var(--rf-text)]">{projects.length}</div>
                          <div className="text-[9px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Projects</div>
                        </div>
                        <div className="w-px bg-slate-200"></div>
                        <div className="text-center">
                          <div className="text-2xl font-black text-[var(--rf-text)]">{customFields.length}</div>
                          <div className="text-[9px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Fields</div>
                        </div>
                      </div>
                      <motion.button 
                        onClick={discoverJira} 
                        disabled={isDiscovering} 
                        className="bg-[var(--rf-surface-soft)] hover:bg-slate-200 text-[var(--rf-text-secondary)] text-[11px] font-bold uppercase tracking-widest px-5 py-3 rounded-xl transition-all flex items-center gap-2 border border-[var(--rf-border)]"
                        whileTap={{ scale: 0.98 }}
                      >
                        <RefreshCw className={`w-4 h-4 ${isDiscovering ? 'animate-spin' : ''}`} /> Sync
                      </motion.button>
                    </div>
                  </div>

                  {/* Step 2 Selection */}
                  <div className="bg-white rounded-2xl p-6 border border-[var(--rf-border)] shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="space-y-1">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Step 2</div>
                      <h4 className="text-lg font-bold text-[var(--rf-text)]">Select Project</h4>
                    </div>
                    <select 
                      value={activeArProj} 
                      onChange={e => setActiveArProj(e.target.value)} 
                      className="bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-bold text-[var(--rf-text)] focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none sm:w-64 transition"
                    >
                      <option value="*">Select a project...</option>
                      {projects.map(p => <option key={p.key} value={p.key}>{p.key}: {p.name}</option>)}
                    </select>
                  </div>

                  {activeArProj !== '*' ? (
                    <ProjectConfigurationManager 
                      projects={projects || []} customFields={customFields || []} arMappings={arMappings || []} setArMappings={setArMappings}
                      domainContexts={domainContexts || []} setDomainContexts={setDomainContexts} goldSources={goldSources || []} setGoldSources={setGoldSources}
                      backlogStatusScopes={backlogStatusScopes || []} setBacklogStatusScopes={setBacklogStatusScopes} backlogStatusOptions={backlogStatusOptions || []}
                      detectDefaultStatuses={detectDefaultStatuses}
                      activeArProj={activeArProj} setActiveArProj={setActiveArProj} isAdmin={isAdmin} isProjectAdmin={activeProjAdmin}
                      issueTypes={issueTypes || []} statuses={statuses || []} onProjectSelect={onProjectSelect}
                      newSource={newSource || {}} setNewSource={setNewSource} addGoldSource={addGoldSource}
                      backlogCacheInfo={backlogCacheInfo}
                      backlogDiagnostics={backlogDiagnostics}
                      isRefreshingBacklogCache={isRefreshingBacklogCache}
                      onRefreshBacklogCache={handleRefreshBacklogCache}
                    />
                  ) : (
                    <div className="bg-white rounded-2xl p-12 text-center border-2 border-dashed border-[var(--rf-border)]">
                      <Database className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                      <h4 className="text-lg font-bold text-[var(--rf-text)]">Select a project to configure</h4>
                      <p className="text-sm font-medium text-[var(--rf-text-tertiary)] mt-2 max-w-md mx-auto">Define backlog indexing scope, work instructions, and optional curated examples for the selected project.</p>
                    </div>
                  )}

                  {/* Step 3 WIs */}
                  <div className="bg-white rounded-2xl p-6 border border-[var(--rf-border)] shadow-sm space-y-6">
                    <div className="flex items-center justify-between gap-4">
                      <div className="space-y-1">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Step 3</div>
                        <h4 className="text-lg font-bold text-[var(--rf-text)]">Project Work Instructions</h4>
                        <p className="text-xs font-medium text-[var(--rf-text-tertiary)]">Attach PDFs to inform AI generation for this project.</p>
                      </div>
                      <motion.button
                        onClick={() => wiFileInputRef.current?.click()}
                        disabled={activeArProj === '*' || !!wiUploadState}
                        className="bg-[var(--rf-text)] hover:bg-black disabled:bg-slate-300 text-white text-[11px] font-bold uppercase tracking-widest px-5 py-2.5 rounded-lg shadow-sm transition-all"
                        whileTap={{ scale: 0.98 }}
                      >
                        {wiUploadState ? 'Uploading…' : 'Add PDF'}
                      </motion.button>
                      <input type="file" ref={wiFileInputRef} onChange={handleWiPdfDrop} accept=".pdf" className="hidden" disabled={activeArProj === '*' || !!wiUploadState} />
                    </div>

                    {activeArProj === '*' ? (
                      <div className="rounded-xl border border-dashed border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-5 text-sm font-medium text-[var(--rf-text-tertiary)] text-center">
                        Select a project first to manage instructions.
                      </div>
                    ) : (
                      <>
                        {(wiUploadState || wiUploadError) && (
                          <div className={`rounded-xl border p-4 ${wiUploadError ? 'border-[var(--rf-danger-subtle)] bg-[var(--rf-danger-subtle)]' : 'border-[var(--rf-brand-subtle)] bg-[var(--rf-brand-muted)]'}`}>
                            {wiUploadState && (
                              <div className="space-y-3">
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Upload In Progress</div>
                                    <div className="mt-1 text-sm font-bold text-[var(--rf-text)]">{wiUploadState.filename}</div>
                                  </div>
                                  <div className="inline-flex items-center gap-2 text-[var(--rf-brand)] text-xs font-bold">
                                    <RefreshCw className="w-4 h-4 animate-spin" />
                                    {wiUploadCopy}
                                  </div>
                                </div>
                                <div className="h-1.5 overflow-hidden rounded-full bg-blue-100">
                                  <div className="h-full w-1/2 rounded-full bg-[var(--rf-brand)] animate-pulse" />
                                </div>
                              </div>
                            )}
                            {wiUploadError && (
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <div className="text-[10px] font-bold uppercase tracking-widest text-rose-500">Upload Failed</div>
                                  <p className="mt-1 text-sm font-bold text-[var(--rf-text)]">{wiUploadError}</p>
                                </div>
                                <button type="button" onClick={() => setWiUploadError(null)} className="rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-[var(--rf-danger)] border border-[var(--rf-danger-subtle)]">Dismiss</button>
                              </div>
                            )}
                          </div>
                        )}

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {wiDocs.length === 0 ? (
                            <div className="col-span-2 p-8 text-center border-2 border-dashed border-[var(--rf-border)] rounded-xl bg-[var(--rf-surface-soft)]">
                              <FileText className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                              <p className="text-sm font-semibold text-[var(--rf-text-tertiary)]">No work instructions linked to {activeArProj}.</p>
                            </div>
                          ) : (
                            wiDocs.map(doc => (
                              <div key={doc.docId} className="bg-[var(--rf-surface-soft)] p-4 rounded-xl border border-[var(--rf-border)] flex items-center justify-between group hover:border-[var(--rf-border-strong)] transition-all">
                                <div className="flex items-center gap-3 truncate">
                                  <div className="shrink-0 w-10 h-10 bg-white rounded-lg border border-[var(--rf-border)] flex items-center justify-center shadow-sm">
                                    <FileText className="w-5 h-5 text-[var(--rf-brand)]" />
                                  </div>
                                  <div className="truncate">
                                    <p className="text-sm font-bold text-[var(--rf-text)] truncate">{doc.filename}</p>
                                    <p className="text-[10px] text-[var(--rf-text-tertiary)] font-bold uppercase tracking-widest mt-0.5">{doc.chunkCount} chunks</p>
                                  </div>
                                </div>
                                <button onClick={() => handleRemoveWiDoc(doc.docId)} className="text-[var(--rf-text-tertiary)] hover:text-rose-500 p-2 rounded-lg hover:bg-[var(--rf-danger-subtle)] transition-colors">
                                  <Trash className="w-4 h-4" />
                                </button>
                              </div>
                            ))
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === 'domain' && (
              <motion.div 
                className="max-w-3xl space-y-8"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
              >
                <div className="space-y-1">
                  <h3 className="text-2xl font-bold text-[var(--rf-text)] tracking-tight">Workspace Guidance</h3>
                  <p className="text-sm font-medium text-[var(--rf-text-tertiary)]">Global defaults for the workspace. Project-specific rules live in Project Setup.</p>
                </div>
                <div className="bg-white rounded-2xl p-6 lg:p-8 border border-[var(--rf-border)] shadow-sm space-y-8">
                  <div className="space-y-4">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 rounded-xl bg-[var(--rf-brand-muted)] text-[var(--rf-brand)] flex items-center justify-center border border-blue-100 shadow-sm"><Globe className="w-6 h-6" /></div>
                      <div>
                        <h4 className="text-base font-bold text-[var(--rf-text)]">Workspace context</h4>
                        <p className="text-xs font-medium text-[var(--rf-text-tertiary)]">Background about your business or product that shapes AI generation across all projects.</p>
                      </div>
                    </div>
                    <textarea
                      value={domainContext}
                      onChange={e => setDomainContext(e.target.value)}
                      rows={4}
                      placeholder="e.g. We are a B2B SaaS company building logistics software. Our users are warehouse managers and operations teams..."
                      className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-5 py-3.5 text-sm font-medium text-[var(--rf-text)] focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none transition resize-none"
                    />
                  </div>

                  <div className="space-y-4 pt-6 border-t border-[var(--rf-border-subtle)]">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 rounded-xl bg-[var(--rf-brand-muted)] text-[var(--rf-brand)] flex items-center justify-center border border-blue-100 shadow-sm"><Users className="w-6 h-6" /></div>
                      <div>
                        <h4 className="text-base font-bold text-[var(--rf-text)]">Core persona roles</h4>
                        <p className="text-xs font-medium text-[var(--rf-text-tertiary)]">Key stakeholders to consider during generation.</p>
                      </div>
                    </div>
                    <input value={domainRoles} onChange={e => setDomainRoles(e.target.value)} placeholder="e.g. Developer, QA Engineer, Product Manager" className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-5 py-3.5 text-sm font-bold text-[var(--rf-text)] focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none transition" />
                  </div>

                  <div className="space-y-4 pt-6 border-t border-[var(--rf-border-subtle)]">
                    <div>
                      <h4 className="text-base font-bold text-[var(--rf-text)]">Issue linking default</h4>
                      <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-0.5">Used when a project does not override its Jira issue link type.</p>
                    </div>
                    <select value={issueLinkType} onChange={e => setIssueLinkType(e.target.value)} className="bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] px-4 py-3 rounded-xl text-sm font-bold text-[var(--rf-text)] focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none w-full max-w-sm transition">
                      {['Relates to', 'Blocks', 'Clones', 'Duplicates'].map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === 'billing' && (
              <motion.div 
                className="max-w-4xl space-y-8"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
              >
                <div className="space-y-1">
                  <h3 className="text-2xl font-bold text-[var(--rf-text)] tracking-tight">Billing & Compliance</h3>
                </div>

                <div className="bg-white rounded-2xl p-8 border border-[var(--rf-border)] shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-6">
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-[var(--rf-text-tertiary)] font-bold">Current Plan</p>
                    <h4 className="text-3xl font-black text-[var(--rf-brand)] capitalize mt-1">{tier}</h4>
                  </div>
                  <div className="flex-1 max-w-sm space-y-2">
                    <div className="flex justify-between text-sm font-bold text-[var(--rf-text-secondary)]">
                      <span>Generations this month</span>
                      <span>{usage?.currentMonth ?? 0} <span className="text-[var(--rf-text-tertiary)] font-medium">/ {limits?.generationsPerMonth === -1 ? 'Unlimited' : limits?.generationsPerMonth ?? 0}</span></span>
                    </div>
                    {limits?.generationsPerMonth !== -1 && (
                      <div className="w-full h-2.5 bg-[var(--rf-surface-soft)] rounded-full overflow-hidden shadow-inner">
                        <div
                          className="h-full bg-[var(--rf-brand)] transition-all duration-500"
                          style={{ width: usage ? `${Math.min(100, (usage.currentMonth / (limits?.generationsPerMonth || 1)) * 100)}%` : '0%' }}
                        />
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                  {[
                    { key: 'free', name: 'Free', price: 'Try it out', highlights: ['Core generation', 'Limited volume', 'Basic setup'] },
                    { key: 'standard', name: 'Standard', price: 'Growing teams', highlights: ['Higher volume', 'Backlog context', 'Project controls'] },
                    { key: 'premium', name: 'Premium', price: 'Advanced workflows', highlights: ['Unlimited gens', 'Full automation', 'Enterprise fit'] },
                    { key: 'enterprise', name: 'Enterprise', price: 'Regulated', highlights: ['Compliance Pack', 'PII masking', 'Audit trail'] },
                  ].map(plan => {
                    const isCurrent = tier === plan.key;
                    return (
                      <div key={plan.key} className={`rounded-2xl border bg-white p-5 flex flex-col shadow-sm transition-all ${isCurrent ? 'border-[var(--rf-brand)] shadow-md shadow-blue-500/10' : 'border-[var(--rf-border)] hover:border-[var(--rf-border-strong)]'}`}>
                        <div className="mb-4">
                          <div className="flex items-center justify-between">
                            <div className={`text-lg font-black ${isCurrent ? 'text-[var(--rf-brand)]' : 'text-[var(--rf-text)]'}`}>{plan.name}</div>
                            {isCurrent && <span className="bg-[var(--rf-brand-muted)] text-[var(--rf-brand)] text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-md border border-blue-100">Current</span>}
                          </div>
                          <div className="text-xs font-semibold text-[var(--rf-text-tertiary)] mt-1">{plan.price}</div>
                        </div>
                        <ul className="space-y-2.5 mb-6 flex-1">
                          {plan.highlights.map(item => (
                            <li key={item} className="text-xs font-medium text-[var(--rf-text-secondary)] flex items-start gap-2">
                              <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                              {item}
                            </li>
                          ))}
                        </ul>
                        <a
                          href="https://marketplace.atlassian.com"
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`mt-auto inline-flex w-full items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-xs font-bold transition ${
                            isCurrent
                              ? 'border-[var(--rf-border)] bg-[var(--rf-surface-soft)] text-[var(--rf-text-secondary)] hover:bg-[var(--rf-surface-soft)]'
                              : 'border-slate-900 bg-[var(--rf-text)] text-white hover:bg-black'
                          }`}
                        >
                          {isCurrent ? 'Manage Plan' : 'Upgrade'}
                        </a>
                      </div>
                    );
                  })}
                </div>

                <div className="bg-white rounded-2xl p-6 lg:p-8 border border-[var(--rf-border)] shadow-sm space-y-6">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <ShieldCheck className="w-5 h-5 text-indigo-600" />
                      <p className="text-[11px] uppercase tracking-widest text-indigo-600 font-bold">Compliance Pack</p>
                    </div>
                    <h4 className="text-xl font-bold text-[var(--rf-text)]">GDPR + EU AI Act readiness</h4>
                    <p className="mt-1 text-sm font-medium text-[var(--rf-text-tertiary)]">
                      Enable transparency reports, PII masking, and immutable audits.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {[
                      { key: 'enabled', label: 'Compliance mode', value: complianceEnabled, set: setComplianceEnabled },
                      { key: 'transparency', label: 'Transparency reports', value: transparencyEnabled, set: setTransparencyEnabled },
                      { key: 'pii', label: 'PII masking before LLM', value: piiMaskingEnabled, set: setPiiMaskingEnabled },
                      { key: 'audit', label: 'Immutable audit trail', value: auditTrailEnabled, set: setAuditTrailEnabled },
                    ].map(item => (
                      <label key={item.key} className="flex items-center justify-between rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-3.5 cursor-pointer hover:bg-[var(--rf-surface-soft)] transition">
                        <span className="font-bold text-sm text-[var(--rf-text-secondary)]">{item.label}</span>
                        <input
                          type="checkbox"
                          checked={item.value}
                          onChange={(e) => item.set(e.target.checked)}
                          disabled={!isAdmin}
                          className="h-4 w-4 rounded border-[var(--rf-border-strong)] text-[var(--rf-brand)] focus:ring-[var(--rf-brand)]"
                        />
                      </label>
                    ))}
                  </div>
                </div>

                {transparencyEnabled && (
                  <div className="bg-white rounded-2xl p-6 lg:p-8 border border-[var(--rf-border)] shadow-sm space-y-4">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <ShieldCheck className="w-4 h-4 text-indigo-600" />
                        <p className="text-[11px] uppercase tracking-widest text-indigo-600 font-bold">Compliance Pack</p>
                      </div>
                      <h4 className="text-xl font-bold text-[var(--rf-text)]">Transparency Reports</h4>
                      <p className="mt-1 text-sm font-medium text-[var(--rf-text-tertiary)]">One record per generation turn. Shows the model used, token consumption, PII redactions, and the reasoning decisions the AI made.</p>
                    </div>
                    {transparencyReports.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-6 text-sm text-[var(--rf-text-tertiary)] text-center">
                        No transparency reports recorded yet.
                      </div>
                    ) : (
                      <div className="overflow-x-auto rounded-xl border border-[var(--rf-border)]">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-[var(--rf-border)] bg-[var(--rf-surface-soft)]">
                              <th className="px-4 py-3 text-left font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest whitespace-nowrap">When</th>
                              <th className="px-4 py-3 text-left font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Turn</th>
                              <th className="px-4 py-3 text-left font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Project</th>
                              <th className="px-4 py-3 text-left font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Model</th>
                              <th className="px-4 py-3 text-right font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest whitespace-nowrap">Tokens</th>
                              <th className="px-4 py-3 text-right font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest whitespace-nowrap">PII redacted</th>
                              <th className="px-4 py-3 text-left font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">AI decisions</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[var(--rf-border-subtle)]">
                            {transparencyReports.map((report) => (
                              <tr key={report.reportId} className="hover:bg-[var(--rf-surface-soft)]/50 transition-colors">
                                <td className="px-4 py-3 text-[var(--rf-text-tertiary)] whitespace-nowrap">
                                  {new Date(report.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{' '}
                                  <span className="text-[10px]">{new Date(report.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                                </td>
                                <td className="px-4 py-3">
                                  <span className={`inline-block rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest border ${
                                    report.turnType === 'generate' ? 'bg-[var(--rf-brand-muted)] text-[var(--rf-brand)] border-blue-100' :
                                    report.turnType === 'clarify' ? 'bg-emerald-50 text-emerald-700 border-emerald-100' :
                                    report.turnType === 'refine' ? 'bg-amber-50 text-amber-700 border-amber-100' :
                                    'bg-[var(--rf-surface-soft)] text-[var(--rf-text-secondary)] border-[var(--rf-border)]'
                                  }`}>
                                    {report.turnType}
                                  </span>
                                </td>
                                <td className="px-4 py-3 font-bold text-[var(--rf-text)]">{report.projectKey ?? '—'}</td>
                                <td className="px-4 py-3 text-[var(--rf-text-secondary)] font-mono">{report.model ?? '—'}</td>
                                <td className="px-4 py-3 text-right font-bold text-[var(--rf-text)]">
                                  {report.tokenUsage?.total != null ? report.tokenUsage.total.toLocaleString() : '—'}
                                </td>
                                <td className="px-4 py-3 text-right">
                                  {report.piiMasking.enabled ? (
                                    <span className={`font-bold ${report.piiMasking.totalRedactions > 0 ? 'text-amber-600' : 'text-[var(--rf-text-tertiary)]'}`}>
                                      {report.piiMasking.totalRedactions}
                                    </span>
                                  ) : (
                                    <span className="text-[var(--rf-text-tertiary)]">off</span>
                                  )}
                                </td>
                                <td className="px-4 py-3 text-[var(--rf-text-secondary)] max-w-xs">
                                  {report.decisionSummary.length > 0 ? (
                                    <ul className="space-y-0.5">
                                      {report.decisionSummary.map((d, i) => (
                                        <li key={i} className="truncate" title={d}>· {d}</li>
                                      ))}
                                    </ul>
                                  ) : '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {auditTrailEnabled && (
                  <div className="bg-white rounded-2xl p-6 lg:p-8 border border-[var(--rf-border)] shadow-sm space-y-4">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <ShieldCheck className="w-4 h-4 text-indigo-600" />
                        <p className="text-[11px] uppercase tracking-widest text-indigo-600 font-bold">Compliance Pack</p>
                      </div>
                      <h4 className="text-xl font-bold text-[var(--rf-text)]">Audit Trail</h4>
                      <p className="mt-1 text-sm font-medium text-[var(--rf-text-tertiary)]">Immutable log of configuration changes, security events, and runtime actions. Hash-chained to detect tampering.</p>
                    </div>
                    {complianceEvents.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-6 text-sm text-[var(--rf-text-tertiary)] text-center">
                        No audit events recorded yet.
                      </div>
                    ) : (
                      <div className="overflow-x-auto rounded-xl border border-[var(--rf-border)]">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-[var(--rf-border)] bg-[var(--rf-surface-soft)]">
                              <th className="px-4 py-3 text-left font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest whitespace-nowrap">When</th>
                              <th className="px-4 py-3 text-left font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Category</th>
                              <th className="px-4 py-3 text-left font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Action</th>
                              <th className="px-4 py-3 text-left font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Details</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[var(--rf-border-subtle)]">
                            {complianceEvents.map((event) => (
                              <tr key={event.eventId} className="hover:bg-[var(--rf-surface-soft)]/50 transition-colors">
                                <td className="px-4 py-3 text-[var(--rf-text-tertiary)] whitespace-nowrap">
                                  {new Date(event.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{' '}
                                  <span className="text-[10px]">{new Date(event.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                                </td>
                                <td className="px-4 py-3">
                                  <span className={`inline-block rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest border ${
                                    event.category === 'security' ? 'bg-rose-50 text-rose-700 border-rose-100' :
                                    event.category === 'config' ? 'bg-[var(--rf-brand-muted)] text-[var(--rf-brand)] border-blue-100' :
                                    event.category === 'prompt' ? 'bg-amber-50 text-amber-700 border-amber-100' :
                                    'bg-[var(--rf-surface-soft)] text-[var(--rf-text-secondary)] border-[var(--rf-border)]'
                                  }`}>
                                    {event.category}
                                  </span>
                                </td>
                                <td className="px-4 py-3 font-bold text-[var(--rf-text)]">{event.action.replace(/_/g, ' ')}</td>
                                <td className="px-4 py-3 text-[var(--rf-text-secondary)] font-mono text-[10px] max-w-xs truncate" title={JSON.stringify(event.details)}>
                                  {JSON.stringify(event.details)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {auditTrailEnabled && jiraAuditRecords.length > 0 && (
                  <div className="bg-white rounded-2xl p-6 lg:p-8 border border-[var(--rf-border)] shadow-sm space-y-4">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <ShieldCheck className="w-4 h-4 text-indigo-600" />
                        <p className="text-[11px] uppercase tracking-widest text-indigo-600 font-bold">Compliance Pack</p>
                      </div>
                      <h4 className="text-xl font-bold text-[var(--rf-text)]">Jira Audit Records</h4>
                      <p className="mt-1 text-sm font-medium text-[var(--rf-text-tertiary)]">Recent Jira-side audit events for issues created or modified by Refinely.</p>
                    </div>
                    <div className="overflow-x-auto rounded-xl border border-[var(--rf-border)]">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-[var(--rf-border)] bg-[var(--rf-surface-soft)]">
                            <th className="px-4 py-3 text-left font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest whitespace-nowrap">When</th>
                            <th className="px-4 py-3 text-left font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Event</th>
                            <th className="px-4 py-3 text-left font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Author</th>
                            <th className="px-4 py-3 text-left font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Details</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--rf-border-subtle)]">
                          {jiraAuditRecords.map((record, i) => (
                            <tr key={i} className="hover:bg-[var(--rf-surface-soft)]/50 transition-colors">
                              <td className="px-4 py-3 text-[var(--rf-text-tertiary)] whitespace-nowrap">
                                {record.created ? (
                                  <>
                                    {new Date(record.created as string).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{' '}
                                    <span className="text-[10px]">{new Date(record.created as string).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                                  </>
                                ) : '—'}
                              </td>
                              <td className="px-4 py-3 font-bold text-[var(--rf-text)]">{String(record.summary ?? record.eventName ?? '—')}</td>
                              <td className="px-4 py-3 text-[var(--rf-text-secondary)]">{String((record.authorAccountId as any)?.displayName ?? record.authorAccountId ?? '—')}</td>
                              <td className="px-4 py-3 text-[var(--rf-text-secondary)] font-mono text-[10px] max-w-xs truncate" title={JSON.stringify(record)}>
                                {JSON.stringify(record.objectItem ?? record.changedValues ?? {})}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </motion.div>
            )}
          </div>
      </div>
    </div>
  );
}

function ProjectConfigurationManager({ 
  projects, customFields, arMappings, setArMappings, domainContexts, setDomainContexts, goldSources, setGoldSources,
  backlogStatusScopes, setBacklogStatusScopes, backlogStatusOptions, detectDefaultStatuses,
  activeArProj, isAdmin, isProjectAdmin, issueTypes, statuses, onProjectSelect, newSource, setNewSource, addGoldSource,
  backlogCacheInfo, backlogDiagnostics, isRefreshingBacklogCache, onRefreshBacklogCache,
}: any) {
  const currentMapping = arMappings.find((m: any) => m.projectKey === activeArProj) || {
    projectKey: activeArProj, mode: 'consolidated', consolidatedFieldId: 'description', iterativeFieldIds: [],
  };
  const currentContext = domainContexts.find((c: any) => c.projectKey === activeArProj) || { projectKey: activeArProj, context: '' };
  const currentGoldSources = goldSources.filter((s: any) => s.targetProjects?.includes(activeArProj));
  const currentBacklogScope = backlogStatusScopes.find((scope: any) => scope.projectKey === activeArProj) || { projectKey: activeArProj, statuses: [] };
  const effectiveBacklogStatuses = currentBacklogScope.statuses.length
    ? currentBacklogScope.statuses
    : detectDefaultStatuses(backlogStatusOptions);

  const updateMapping = (p: any) => {
    const idx = arMappings.findIndex((m: any) => m.projectKey === activeArProj);
    const upd = { ...currentMapping, ...p };
    if (idx >= 0) { const l = [...arMappings]; l[idx] = upd; setArMappings(l); }
    else setArMappings([...arMappings, upd]);
  };
  const updateContext = (ctx: string) => {
    const idx = domainContexts.findIndex((c: any) => c.projectKey === activeArProj);
    const upd = { projectKey: activeArProj, context: ctx };
    if (idx >= 0) { const l = [...domainContexts]; l[idx] = upd; setDomainContexts(l); }
    else setDomainContexts([...domainContexts, upd]);
  };
  const updateBacklogStatuses = (nextStatuses: string[]) => {
    const normalized = [...new Set(nextStatuses.filter(Boolean))];
    const idx = backlogStatusScopes.findIndex((scope: any) => scope.projectKey === activeArProj);
    const updated = { projectKey: activeArProj, statuses: normalized };
    if (idx >= 0) {
      const next = [...backlogStatusScopes];
      next[idx] = updated;
      setBacklogStatusScopes(next);
    } else {
      setBacklogStatusScopes([...backlogStatusScopes, updated]);
    }
  };

  const [isSavingProject, setIsSavingProject] = useState(false);
  const selectedStatuses: string[] = Array.isArray(newSource.statuses) ? newSource.statuses : [];
  const [projectNotice, setProjectNotice] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState({
    backlog: true,
    guidance: true,
    mapping: false,
    examples: false,
  });

  const toggleSection = (section: 'backlog' | 'guidance' | 'mapping' | 'examples') => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const toggleStatus = (statusName: string) => {
    const exists = selectedStatuses.includes(statusName);
    const next = exists
      ? selectedStatuses.filter(s => s !== statusName)
      : [...selectedStatuses, statusName];
    setNewSource((p: any) => ({ ...p, statuses: next, status: next[0] || '' }));
  };

  const handleSave = async () => {
    setIsSavingProject(true);
    setProjectNotice(null);
    try {
      await api.saveProjectConfig({
        projectKey: activeArProj,
        arMapping: currentMapping,
        domainContext: currentContext.context,
        goldSources: currentGoldSources,
        backlogStatuses: effectiveBacklogStatuses,
      });
      setProjectNotice('Project configuration saved.');
    } catch (e: any) { alert(e.message); }
    finally { setIsSavingProject(false); }
  };

  const handleSaveAndRefresh = async () => {
    setIsSavingProject(true);
    setProjectNotice(null);
    try {
      await api.saveProjectConfig({
        projectKey: activeArProj,
        arMapping: currentMapping,
        domainContext: currentContext.context,
        goldSources: currentGoldSources,
        backlogStatuses: effectiveBacklogStatuses,
      });
      const refreshed = await onRefreshBacklogCache(activeArProj);
      if (refreshed) {
        if (refreshed.issueCount > 0) {
          setProjectNotice(`Backlog cache rebuilt with ${refreshed.issueCount} issues.`);
        } else if (refreshed.diagnostics?.likelyReason) {
          setProjectNotice(`Cache rebuilt: 0 items. ${refreshed.diagnostics.likelyReason}`);
        } else {
          setProjectNotice('Cache rebuilt: 0 matching issues found.');
        }
      }
    } catch (e: any) {
      alert(e.message);
    } finally {
      setIsSavingProject(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-t border-[var(--rf-border)] pt-6">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-brand)] mb-1">Editing Project</div>
          <h4 className="text-xl font-bold text-[var(--rf-text)]">{activeArProj} Configuration</h4>
        </div>
        {isProjectAdmin && (
          <div className="flex flex-wrap gap-2">
            <motion.button 
              onClick={handleSave} 
              disabled={isSavingProject || isRefreshingBacklogCache} 
              className="bg-white border border-[var(--rf-border)] hover:bg-[var(--rf-surface-soft)] text-[10px] font-bold uppercase tracking-widest px-4 py-2.5 rounded-xl shadow-sm transition-all flex items-center gap-2 text-[var(--rf-text-secondary)]"
              whileTap={{ scale: 0.98 }}
            >
              {isSavingProject ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
            </motion.button>
            <motion.button 
              onClick={handleSaveAndRefresh} 
              disabled={isSavingProject || isRefreshingBacklogCache} 
              className="bg-[var(--rf-text)] hover:bg-black text-white text-[10px] font-bold uppercase tracking-widest px-4 py-2.5 rounded-xl shadow-sm transition-all flex items-center gap-2"
              whileTap={{ scale: 0.98 }}
            >
              {(isSavingProject || isRefreshingBacklogCache) ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Save & Rebuild
            </motion.button>
          </div>
        )}
      </div>

      {projectNotice && (
        <div className="text-xs font-bold text-[var(--rf-success)] bg-[var(--rf-success-subtle)] border border-[var(--rf-success-subtle)] rounded-xl px-4 py-3 flex items-center gap-2">
          <Check className="w-4 h-4" /> {projectNotice}
        </div>
      )}

      <div className="space-y-4">
         <div className="space-y-3">
           <button
             type="button"
             onClick={() => toggleSection('backlog')}
             className="w-full flex items-center justify-between gap-4 rounded-xl border border-[var(--rf-border)] bg-white px-5 py-4 text-left shadow-sm hover:border-[var(--rf-border-strong)] transition"
           >
             <div className="flex items-center gap-3">
               <div className="w-8 h-8 rounded-lg bg-[var(--rf-brand-muted)] flex items-center justify-center border border-blue-100"><Database className="w-4 h-4 text-[var(--rf-brand)]" /></div>
               <div>
                 <h5 className="text-sm font-bold text-[var(--rf-text)] flex items-center gap-2">
                   Backlog Context
                   <span className="rounded-md bg-[var(--rf-danger-subtle)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-[var(--rf-danger)] border border-rose-100">Required</span>
                 </h5>
                 <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-0.5">Define Jira statuses for AI context.</p>
               </div>
             </div>
             <ChevronRight className={`w-5 h-5 text-[var(--rf-text-tertiary)] transition-transform ${expandedSections.backlog ? 'rotate-90' : ''}`} />
           </button>

           {expandedSections.backlog && (
           <div className="bg-[var(--rf-surface-soft)] rounded-xl p-5 border border-[var(--rf-border)] space-y-5">
             <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
               <div className="rounded-xl border border-[var(--rf-border)] bg-white px-4 py-3 shadow-sm">
                 <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Indexed Items</div>
                 <div className="mt-1 text-xl font-black text-[var(--rf-text)]">{backlogCacheInfo?.issueCount ?? 0}</div>
               </div>
               <div className="rounded-xl border border-[var(--rf-border)] bg-white px-4 py-3 shadow-sm">
                 <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Last Built</div>
                 <div className="mt-1 text-sm font-bold text-[var(--rf-text-secondary)]">
                   {backlogCacheInfo?.builtAt ? new Date(backlogCacheInfo.builtAt).toLocaleString() : 'Not built yet'}
                 </div>
               </div>
               <div className="rounded-xl border border-[var(--rf-border)] bg-white px-4 py-3 shadow-sm">
                 <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Status</div>
                 <div className="mt-1 text-sm font-bold text-[var(--rf-text-secondary)] flex items-center gap-1.5">
                   {backlogCacheInfo?.stale ? <><AlertCircle className="w-4 h-4 text-amber-500"/> Needs refresh</> : <><Check className="w-4 h-4 text-emerald-500"/> Fresh</>}
                 </div>
               </div>
             </div>

             <div className="space-y-3 pt-2">
               <div className="flex items-center justify-between">
                 <div className="text-sm font-bold text-[var(--rf-text)]">
                   {effectiveBacklogStatuses.length} status{effectiveBacklogStatuses.length === 1 ? '' : 'es'} in scope
                 </div>
                 <div className="flex gap-2">
                   <button onClick={() => updateBacklogStatuses(detectDefaultStatuses(backlogStatusOptions))} className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-brand)] hover:text-blue-800 bg-[var(--rf-brand-muted)] px-2 py-1 rounded">Default</button>
                   <button onClick={() => updateBacklogStatuses(backlogStatusOptions.map((status: any) => status.name))} className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-brand)] hover:text-blue-800 bg-[var(--rf-brand-muted)] px-2 py-1 rounded">All</button>
                 </div>
               </div>
               <div className="flex flex-wrap gap-2">
                 {backlogStatusOptions.map((status: any) => {
                   const selected = effectiveBacklogStatuses.includes(status.name);
                   return (
                     <button
                       key={status.name}
                       onClick={() => updateBacklogStatuses(selected ? effectiveBacklogStatuses.filter((item: string) => item !== status.name) : [...effectiveBacklogStatuses, status.name])}
                       className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${selected ? 'bg-[var(--rf-brand)] text-white border-blue-600 shadow-md shadow-[var(--rf-brand)]/20' : 'bg-white text-[var(--rf-text-secondary)] border-[var(--rf-border)] hover:border-[var(--rf-brand-subtle)]'}`}
                     >
                       {status.name}
                     </button>
                   );
                 })}
               </div>
             </div>
           </div>
           )}
         </div>

         <div className="space-y-3">
            <button
              type="button"
              onClick={() => toggleSection('guidance')}
              className="w-full flex items-center justify-between gap-4 rounded-xl border border-[var(--rf-border)] bg-white px-5 py-4 text-left shadow-sm hover:border-[var(--rf-border-strong)] transition"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center border border-indigo-100"><Globe className="w-4 h-4 text-indigo-600" /></div>
                <div>
                  <h5 className="text-sm font-bold text-[var(--rf-text)] flex items-center gap-2">
                    Project Guidance
                    <span className="rounded-md bg-[var(--rf-surface-soft)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] border border-[var(--rf-border)]">Recommended</span>
                  </h5>
                  <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-0.5">Rules or context specific to this project.</p>
                </div>
              </div>
              <ChevronRight className={`w-5 h-5 text-[var(--rf-text-tertiary)] transition-transform ${expandedSections.guidance ? 'rotate-90' : ''}`} />
            </button>
            {expandedSections.guidance && (
              <div className="bg-[var(--rf-surface-soft)] rounded-xl p-5 border border-[var(--rf-border)]">
                <textarea value={currentContext.context} onChange={e => updateContext(e.target.value)} placeholder="e.g. Ensure all stories include accessibility requirements..." className="w-full h-32 bg-white border border-[var(--rf-border)] rounded-xl p-4 text-sm font-medium outline-none focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition shadow-sm resize-none" />
              </div>
            )}
         </div>

         <div className="space-y-3">
            <button
              type="button"
              onClick={() => toggleSection('mapping')}
              className="w-full flex items-center justify-between gap-4 rounded-xl border border-[var(--rf-border)] bg-white px-5 py-4 text-left shadow-sm hover:border-[var(--rf-border-strong)] transition"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-[var(--rf-success-subtle)] flex items-center justify-center border border-emerald-100"><Layers className="w-4 h-4 text-[var(--rf-success)]" /></div>
                <div>
                  <h5 className="text-sm font-bold text-[var(--rf-text)] flex items-center gap-2">
                    AR Field Mapping
                    <span className="rounded-md bg-[var(--rf-surface-soft)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] border border-[var(--rf-border)]">Advanced</span>
                  </h5>
                  <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-0.5">Map where Acceptance Criteria go.</p>
                </div>
              </div>
              <ChevronRight className={`w-5 h-5 text-[var(--rf-text-tertiary)] transition-transform ${expandedSections.mapping ? 'rotate-90' : ''}`} />
            </button>
            {expandedSections.mapping && (
            <div className="bg-[var(--rf-surface-soft)] rounded-xl p-5 border border-[var(--rf-border)] space-y-5">
               <div className="flex p-1 bg-white rounded-lg border border-[var(--rf-border)] shadow-sm max-w-[240px]">
                 <button onClick={() => updateMapping({ mode: 'consolidated' })} className={`flex-1 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded-md transition ${currentMapping.mode === 'consolidated' ? 'bg-[var(--rf-text)] text-white shadow-sm' : 'text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text-secondary)]'}`}>Consolidated</button>
                 <button onClick={() => updateMapping({ mode: 'iterative' })} className={`flex-1 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded-md transition ${currentMapping.mode === 'iterative' ? 'bg-[var(--rf-text)] text-white shadow-sm' : 'text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text-secondary)]'}`}>Iterative</button>
               </div>
               
               <div>
                 {currentMapping.mode === 'consolidated' ? (
                   <div className="flex items-center justify-between gap-4 bg-white p-3 rounded-xl border border-[var(--rf-border)]">
                     <span className="text-xs font-bold text-[var(--rf-text-secondary)]">Storage Field</span>
                     <FieldSelector value={currentMapping.consolidatedFieldId} onChange={(fid: string) => updateMapping({ consolidatedFieldId: fid })} customFields={customFields} />
                   </div>
                 ) : (
                   <div className="space-y-3">
                     {currentMapping.iterativeFieldIds.map((fid: string, i: number) => (
                       <div key={i} className="flex items-center gap-3 bg-white p-2 rounded-xl border border-[var(--rf-border)]">
                         <span className="text-[10px] font-black text-[var(--rf-text-tertiary)] min-w-[24px] text-center">#{i+1}</span>
                         <div className="flex-1"><FieldSelector value={fid} onChange={(newF: string) => { const ids = [...currentMapping.iterativeFieldIds]; ids[i] = newF; updateMapping({ iterativeFieldIds: ids }); }} customFields={customFields} /></div>
                         <button onClick={() => updateMapping({ iterativeFieldIds: currentMapping.iterativeFieldIds.filter((_: any, idx: number) => idx !== i) })} className="p-1.5 text-[var(--rf-text-tertiary)] hover:text-rose-500 hover:bg-[var(--rf-danger-subtle)] rounded-md transition"><X className="w-4 h-4"/></button>
                       </div>
                     ))}
                     <button onClick={() => updateMapping({ iterativeFieldIds: [...currentMapping.iterativeFieldIds, ''] })} className="text-[10px] font-bold text-[var(--rf-brand)] bg-[var(--rf-brand-muted)] hover:bg-blue-100 px-3 py-1.5 rounded-lg uppercase tracking-widest transition">+ Add slot</button>
                   </div>
                 )}
               </div>
            </div>
            )}
         </div>
      </div>
    </div>
  );
}

function FieldSelector({ value, onChange, customFields }: any) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const selected = value === 'description' ? { id: 'description', name: 'Description (Standard)' } : customFields.find((f: any) => f.id === value);

  const filtered = useMemo(() => {
    const opts = [{ id: 'description', name: 'Description (Standard)' }, ...customFields];
    if (!search) return opts.slice(0, 100);
    const s = search.toLowerCase();
    return opts.filter(f => f.name.toLowerCase().includes(s) || f.id.toLowerCase().includes(s)).slice(0, 100);
  }, [search, customFields]);

  useEffect(() => {
    const click = (e: MouseEvent) => { if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setIsOpen(false); };
    document.addEventListener('mousedown', click);
    return () => document.removeEventListener('mousedown', click);
  }, []);

  return (
    <div className="relative w-full max-w-[240px]" ref={wrapperRef}>
      <button type="button" onClick={() => setIsOpen(!isOpen)} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-xs font-bold text-left flex justify-between items-center hover:border-[var(--rf-brand-subtle)] transition-all shadow-sm">
        <span className="truncate text-[var(--rf-text-secondary)]">{selected ? selected.name : 'Select Field'}</span>
        <ChevronRight className={`w-3.5 h-3.5 text-[var(--rf-text-tertiary)] transition-transform ${isOpen ? 'rotate-90' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1.5 bg-white border border-[var(--rf-border)] rounded-xl shadow-xl overflow-hidden flex flex-col">
          <div className="p-2 border-b border-[var(--rf-border-subtle)] bg-[var(--rf-surface-soft)]">
            <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter fields..." className="w-full bg-white border border-[var(--rf-border)] rounded-lg px-3 py-1.5 text-xs font-medium outline-none focus:border-[var(--rf-brand)]" />
          </div>
          <div className="max-h-[200px] overflow-y-auto custom-scrollbar py-1">
            {filtered.map((f: any) => (
              <button key={f.id} onClick={() => { onChange(f.id); setIsOpen(false); setSearch(''); }} className={`w-full text-left px-3 py-2 text-xs hover:bg-[var(--rf-surface-soft)] transition-colors flex items-center justify-between ${value === f.id ? 'bg-[var(--rf-brand-muted)]/50' : ''}`}>
                <span className={`font-bold truncate ${value === f.id ? 'text-[var(--rf-brand-hover)]' : 'text-[var(--rf-text-secondary)]'}`}>{f.name}</span>
                <span className="text-[9px] text-[var(--rf-text-tertiary)] font-mono shrink-0 ml-2">{f.id}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
