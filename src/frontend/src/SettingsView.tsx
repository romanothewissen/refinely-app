import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Database, BrainCircuit, Globe, X, RefreshCw, Save, CreditCard, ChevronLeft, BarChart3,
  FileText, ChevronRight, ChevronDown, Check, Trash, Layers, Zap, AlertCircle, Image,
  ShieldCheck, Filter
} from 'lucide-react';
import { motion } from 'framer-motion';
import { api } from './hooks/useForge';
import type {
  GeneratorModelStrategy,
  InferProjectPersonaRolesResult,
  LlmModelCatalogByVendor,
  LlmModelCatalogEntry,
  LlmProvider,
  ProjectActivitySummaryRow,
  ProjectPersonaRoleSuggestion,
} from './types';
import { REDACTED } from './types';
import { SearchableSelect, type SearchableSelectOption } from './components/SearchableSelect';
import {
  DEFAULT_BUCKET_CLASSES,
  GENERATOR_ROLE_ORDER,
  getCatalogEntriesForProvider,
  MODEL_STRATEGY_VERSION,
  resolveUiGeneratorStrategyState,
  SIMPLE_BUCKET_DESCRIPTIONS,
  SIMPLE_BUCKET_LABELS,
  type SimpleBucketModels,
} from './modelStrategy';
interface JiraProject { key: string; name: string }
interface JiraStatus { name: string; statusCategory?: { name: string } }
interface JiraField { id: string; name: string }
interface ProjectBacklogStatusScope { projectKey: string; statuses: string[] }
interface ProjectFieldMapping {
  summaryFieldId: string;
  descriptionFieldId: string;
  arFieldIds: string[];
}
interface RoleGuidanceRow {
  role: string;
  activities: string;
}
interface ProjectArMapping {
  projectKey: string;
  issueType?: string;
  mode: 'consolidated' | 'iterative';
  consolidatedFieldId: string;
  iterativeFieldIds: string[];
  inputMappings: ProjectFieldMapping;
  outputMappings: ProjectFieldMapping;
  issueLinkType?: string;
}
interface ProjectDomainContextRow {
  projectKey: string;
  context: string;
  personaRoles?: RoleGuidanceRow[];
}
interface BacklogDiagnostics {
  projectKey: string;
  configuredStatuses: string[];
  jqlUsed: string;
  totalProjectIssues: number;
  doneCategoryIssues: number;
  matchingScopeIssues: number;
  likelyReason: string;
}

interface BacklogCacheInfoRow {
  projectKey: string;
  builtAt?: string;
  issueCount: number;
  stale: boolean;
  shardCount: number;
  themeCount: number;
  themeBuiltAt?: string;
  legacyFallback: boolean;
}

interface BacklogRefreshStatusRow {
  projectKey: string;
  status: 'queued' | 'running' | 'completed' | 'error';
  updatedAt?: string;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  issueCount?: number;
  shardCount?: number;
  themeCount?: number;
  builtAt?: string;
  themeBuiltAt?: string;
  error?: string;
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
  actorAccountId?: string;
  category: 'config' | 'security' | 'prompt' | 'runtime';
  action: string;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

interface TransparencyReportRow {
  reportId: string;
  createdAt: string;
  turnType: 'generate' | 'clarify' | 'refine' | 'ask';
  projectKey?: string;
  provider?: string;
  model?: string;
  requirementExcerpt?: string;
  decisionSummary: string[];
  contextUsage?: Record<string, unknown>;
  piiMasking: { enabled: boolean; totalRedactions: number; byType?: Record<string, number> };
  tokenUsage?: { input?: number; output?: number; total: number };
}

interface ComplianceSummary {
  totalByTurnType: Record<string, number>;
  totalTokens: number;
  piiRedactionsByType: Record<string, number>;
  modelUsage: Record<string, number>;
  projectBreakdown: Array<{ projectKey: string; count: number; tokenUsage: number; latestAt?: string }>;
}

interface PiiPreviewResult {
  text: string;
  totalRedactions: number;
  byType: Record<string, number>;
}
const WI_ACCEPT = '.pdf,.csv,.eml,.txt,.md';
const ROLE_GUIDANCE_MARKER = '\n\n[[role-guidance]]\n';
type UiProvider = Exclude<LlmProvider, 'forge_llms'>;
const DEFAULT_STRATEGY_STATE = resolveUiGeneratorStrategyState({
  provider: 'anthropic',
  modelStrategy: 'simple',
});

function getDisplayProvider(provider: LlmProvider): UiProvider {
  return provider === 'forge_llms' ? 'anthropic' : provider;
}

function getProviderLabel(provider: UiProvider) {
  if (provider === 'anthropic') return 'Anthropic';
  if (provider === 'azure_openai') return 'Azure OpenAI';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function compactUiText(value: string) {
  return String(value ?? '')
    .replace(/\u2026/g, '...')
    .replace(/\u2318/g, 'Cmd')
    .replace(/\s+/g, ' ')
    .trim();
}

function maskPreviewText(text: string) {
  const raw = text ?? '';
  const counts: Record<string, number> = {};
  let masked = raw;
  masked = masked.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, () => {
    counts.email = (counts.email ?? 0) + 1;
    return '[REDACTED_EMAIL]';
  });
  masked = masked.replace(/\b(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)\d{3,4}[\s.-]?\d{3,4}\b/g, () => {
    counts.phone = (counts.phone ?? 0) + 1;
    return '[REDACTED_PHONE]';
  });
  masked = masked.replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, () => {
    counts.iban = (counts.iban ?? 0) + 1;
    return '[REDACTED_IBAN]';
  });
  masked = masked.replace(/\b(?:\d[ -]*?){13,19}\b/g, () => {
    counts.paymentCard = (counts.paymentCard ?? 0) + 1;
    return '[REDACTED_CARD]';
  });
  masked = masked.replace(/\b\d{3}-\d{2}-\d{4}\b/g, () => {
    counts.ssn = (counts.ssn ?? 0) + 1;
    return '[REDACTED_SSN]';
  });
  return {
    text: masked,
    totalRedactions: Object.values(counts).reduce((sum, next) => sum + next, 0),
    byType: counts,
  };
}

function getCatalogModelId(entry?: LlmModelCatalogEntry) {
  return entry?.deploymentName || entry?.id || '';
}

function getPreferredFamilyModel(entries: LlmModelCatalogEntry[], family: 'pro' | 'flash' | 'lite') {
  const preferred = entries.find(entry => entry.family === family && entry.isLatest)
    || entries.find(entry => entry.family === family);
  return getCatalogModelId(preferred);
}

function isProviderModel(provider: LlmProvider, modelId: string) {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return false;
  if (provider === 'gemini') return normalized.startsWith('gemini-');
  if (provider === 'openai') return normalized.startsWith('gpt-') || normalized.startsWith('o');
  if (provider === 'azure_openai') return true;
  return normalized.startsWith('claude-');
}

function coerceRoleGuidanceRows(
  rawRows: any[] = [],
  options: { trimFields?: boolean; includeBlankFallback?: boolean } = {},
): RoleGuidanceRow[] {
  const { trimFields = true, includeBlankFallback = false } = options;
  const rows = rawRows
    .map((row: any) => {
      if (!row) return null;
      const rawRole = typeof row === 'string'
        ? row
        : String(row.role ?? row.name ?? row.title ?? '');
      const rawActivities = typeof row === 'string'
        ? ''
        : String(row.activities ?? row.activity ?? row.description ?? row.context ?? '');
      const role = trimFields ? rawRole.trim() : rawRole;
      const activities = trimFields ? rawActivities.trim() : rawActivities;
      return { role, activities };
    })
    .filter((row: RoleGuidanceRow | null): row is RoleGuidanceRow => {
      if (!row) return false;
      const hasContent = trimFields
        ? Boolean(row.role || row.activities)
        : Boolean(row.role.length || row.activities.length);
      return hasContent;
    });
  return rows.length ? rows : (includeBlankFallback ? [{ role: '', activities: '' }] : []);
}

function normalizeRoleGuidanceRows(rawRows: any[] = []): RoleGuidanceRow[] {
  return coerceRoleGuidanceRows(rawRows, { trimFields: true, includeBlankFallback: true });
}

function mergeSuggestedPersonaRoles(
  existingRows: RoleGuidanceRow[],
  selectedSuggestions: ProjectPersonaRoleSuggestion[],
): RoleGuidanceRow[] {
  const normalizedExisting = coerceRoleGuidanceRows(existingRows, { trimFields: true, includeBlankFallback: false });
  const nextRows = normalizedExisting.length ? [...normalizedExisting] : [];
  const exactKeys = new Set(nextRows.map((row) => `${row.role.toLowerCase()}::${row.activities.toLowerCase()}`));

  selectedSuggestions.forEach((suggestion) => {
    const role = suggestion.role.trim();
    const activities = suggestion.activities.trim();
    if (!role || !activities) return;

    const exactKey = `${role.toLowerCase()}::${activities.toLowerCase()}`;
    if (exactKeys.has(exactKey)) return;

    const sameRoleIndex = nextRows.findIndex((row) => row.role.trim().toLowerCase() === role.toLowerCase());
    if (sameRoleIndex >= 0) {
      const current = nextRows[sameRoleIndex];
      if (!current.activities.trim()) {
        nextRows[sameRoleIndex] = { ...current, activities };
        exactKeys.add(exactKey);
      }
      return;
    }

    nextRows.push({ role, activities });
    exactKeys.add(exactKey);
  });

  return nextRows.length ? nextRows : [{ role: '', activities: '' }];
}

function splitGuidanceContext(rawContext = '') {
  const markerIndex = rawContext.indexOf(ROLE_GUIDANCE_MARKER);
  if (markerIndex === -1) {
    return { context: rawContext.trim(), roleRows: [] as RoleGuidanceRow[] };
  }
  const context = rawContext.slice(0, markerIndex).trim();
  const payload = rawContext.slice(markerIndex + ROLE_GUIDANCE_MARKER.length).trim();
  if (!payload) {
    return { context, roleRows: [] as RoleGuidanceRow[] };
  }
  try {
    const parsed = JSON.parse(payload);
    return { context, roleRows: normalizeRoleGuidanceRows(Array.isArray(parsed) ? parsed : []) };
  } catch {
    return { context, roleRows: [] as RoleGuidanceRow[] };
  }
}

function normalizeOptionalPositiveInt(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function SettingsView({ onClose, initialTab = 'models', initialProjectKey = '*' }: { onClose: () => void; initialTab?: 'models' | 'jira' | 'domain' | 'stats' | 'billing' | 'compliance'; initialProjectKey?: string }) {
  const [activeTab, setActiveTab] = useState<'models' | 'jira' | 'domain' | 'stats' | 'billing' | 'compliance'>(initialTab);
  const [isSaving, setIsSaving] = useState(false);

  // Models State
  const [provider, setProvider] = useState<LlmProvider>('anthropic');
  const [modelStrategy, setModelStrategy] = useState<GeneratorModelStrategy>('simple');
  const [simpleBucketModels, setSimpleBucketModels] = useState<SimpleBucketModels>(DEFAULT_STRATEGY_STATE.resolvedBucketModels);
  const [decompositionModel, setDecompositionModel] = useState(DEFAULT_STRATEGY_STATE.resolvedModels.decompositionModel);
  const [arModel, setArModel] = useState(DEFAULT_STRATEGY_STATE.resolvedModels.arModel);
  const [clarifyModel, setClarifyModel] = useState(DEFAULT_STRATEGY_STATE.resolvedModels.clarifyModel);
  const [evaluateModel, setEvaluateModel] = useState(DEFAULT_STRATEGY_STATE.resolvedModels.evaluateModel);
  const [triageModel, setTriageModel] = useState(DEFAULT_STRATEGY_STATE.resolvedModels.triageModel);
  const [refineModel, setRefineModel] = useState(DEFAULT_STRATEGY_STATE.resolvedModels.refineModel);
  const [themeModel, setThemeModel] = useState(DEFAULT_STRATEGY_STATE.resolvedModels.themeModel);
  const roleModelValues = {
    triageModel,
    clarifyModel,
    evaluateModel,
    decompositionModel,
    arModel,
    themeModel,
    refineModel,
  };
  const roleModelSetters = {
    triageModel: setTriageModel,
    clarifyModel: setClarifyModel,
    evaluateModel: setEvaluateModel,
    decompositionModel: setDecompositionModel,
    arModel: setArModel,
    themeModel: setThemeModel,
    refineModel: setRefineModel,
  };

  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [geminiBaseUrl, setGeminiBaseUrl] = useState('');
  const [existingGeminiApiKey, setExistingGeminiApiKey] = useState('');

  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [anthropicBaseUrl, setAnthropicBaseUrl] = useState('');
  const [existingAnthropicApiKey, setExistingAnthropicApiKey] = useState('');
  
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState('');
  const [existingOpenaiApiKey, setExistingOpenaiApiKey] = useState('');

  const [azureOpenAIApiKey, setAzureOpenAIApiKey] = useState('');
  const [azureOpenAIBaseUrl, setAzureOpenAIBaseUrl] = useState('');
  const [azureOpenAIApiVersion, setAzureOpenAIApiVersion] = useState('2024-06-01');
  const [existingAzureOpenAIApiKey, setExistingAzureOpenAIApiKey] = useState('');
  const [modelCatalogs, setModelCatalogs] = useState<LlmModelCatalogByVendor>({});
  const [isRefreshingModels, setIsRefreshingModels] = useState(false);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  
  const [isTestingLlm, setIsTestingLlm] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Jira State
  const [projects, setProjects] = useState<JiraProject[]>([]);
  const [backlogStatusOptions, setBacklogStatusOptions] = useState<JiraStatus[]>([]);
  const [customFields, setCustomFields] = useState<JiraField[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [arMappings, setArMappings] = useState<ProjectArMapping[]>([]);
  const [backlogStatusScopes, setBacklogStatusScopes] = useState<ProjectBacklogStatusScope[]>([]);
  const [activeArProj, setActiveArProj] = useState(initialProjectKey); // Global context selector
  const [backlogCacheInfo, setBacklogCacheInfo] = useState<BacklogCacheInfoRow | null>(null);
  const [backlogDiagnostics, setBacklogDiagnostics] = useState<BacklogDiagnostics | null>(null);
  const [backlogRefreshStatus, setBacklogRefreshStatus] = useState<BacklogRefreshStatusRow | null>(null);
  const [isRefreshingBacklogCache, setIsRefreshingBacklogCache] = useState(false);
  const [backlogThemeBudgetOverride, setBacklogThemeBudgetOverride] = useState('');

  // Personal + workspace state
  const [defaultProjectKey, setDefaultProjectKey] = useState('');
  const [tier, setTier] = useState<'free' | 'standard'>('standard');
  const [complianceEnabled, setComplianceEnabled] = useState(false);
  const [transparencyEnabled, setTransparencyEnabled] = useState(false);
  const [piiMaskingEnabled, setPiiMaskingEnabled] = useState(false);
  const [auditTrailEnabled, setAuditTrailEnabled] = useState(false);
  const [complianceEvents, setComplianceEvents] = useState<ComplianceAuditEvent[]>([]);
  const [transparencyReports, setTransparencyReports] = useState<TransparencyReportRow[]>([]);
  const [complianceSummary, setComplianceSummary] = useState<ComplianceSummary | null>(null);
  const [projectActivityRows, setProjectActivityRows] = useState<ProjectActivitySummaryRow[]>([]);
  const [reportFilterTurnType, setReportFilterTurnType] = useState('');
  const [reportFilterProject, setReportFilterProject] = useState('');
  const [expandedReportId, setExpandedReportId] = useState<string | null>(null);
  const [expandedAuditId, setExpandedAuditId] = useState<string | null>(null);
  const [showAllAuditEvents, setShowAllAuditEvents] = useState(false);
  const [auditCategoryFilter, setAuditCategoryFilter] = useState<'all' | 'config' | 'security' | 'prompt' | 'runtime'>('runtime');
  const [piiPreviewInput, setPiiPreviewInput] = useState('Contact Jane Doe at jane.doe@example.com or +31 6 1234 5678 to review payment card 4111 1111 1111 1111.');
  const [piiPreviewResult, setPiiPreviewResult] = useState<PiiPreviewResult>({ text: '', totalRedactions: 0, byType: {} });
  const [brandingLogoUrl, setBrandingLogoUrl] = useState('');
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<{ currentMonth: number } | null>(null);
  const [limits, setLimits] = useState<{ generationsPerMonth: number } | null>(null);
  const [domainContexts, setDomainContexts] = useState<ProjectDomainContextRow[]>([]);
  const [activeProjAdmin, setActiveProjAdmin] = useState<boolean>(false);
  
  // WIs State
  const [wiEnabled, setWiEnabled] = useState(true);
  const [wiDocs, setWiDocs] = useState<WiDocRow[]>([]);
  const [wiUploadState, setWiUploadState] = useState<{ filename: string; stage: 'reading' | 'uploading' | 'indexing' } | null>(null);
  const [wiUploadError, setWiUploadError] = useState<string | null>(null);
  const wiFileInputRef = useRef<HTMLInputElement>(null);
  const workspaceTokenUsage = useMemo(() => {
    return transparencyReports.reduce((sum, report) => sum + (report.tokenUsage?.total ?? 0), 0);
  }, [transparencyReports]);
  const configuredProjectCount = useMemo(() => {
    const keys = new Set<string>();
    arMappings.forEach((mapping) => {
      if (mapping?.projectKey && mapping.projectKey !== '*') keys.add(mapping.projectKey);
    });
    domainContexts.forEach((context) => {
      if (context?.projectKey && context.projectKey !== '*') keys.add(context.projectKey);
    });
    backlogStatusScopes.forEach((scope) => {
      if (scope?.projectKey && scope.projectKey !== '*') keys.add(scope.projectKey);
    });
    return keys.size;
  }, [arMappings, domainContexts, backlogStatusScopes]);

  const projectUsageBreakdown = useMemo(() => {
    return projectActivityRows
      .map((row) => ({
        projectKey: row.projectKey,
        tokenUsage: row.tokenUsage,
        reportCount: row.count,
        latestAt: row.latestAt,
        actionCounts: row.actionCounts,
      }))
      .sort((a, b) => b.reportCount - a.reportCount || b.tokenUsage - a.tokenUsage);
  }, [projectActivityRows]);

  const projectOptions = useMemo<SearchableSelectOption[]>(
    () => projects.map((project) => ({
      value: project.key,
      label: `${project.key} · ${project.name}`,
      description: project.name,
    })),
    [projects],
  );

  const loadBacklogCacheInfo = useCallback(async (projectKey: string) => {
    try {
      const res = await api.getBacklogCacheInfo(projectKey) as any;
      if (res?.success) {
        const nextInfo = {
          projectKey: res.projectKey,
          builtAt: res.builtAt,
          issueCount: res.issueCount ?? 0,
          stale: !!res.stale,
          shardCount: res.shardCount ?? 0,
          themeCount: res.themeCount ?? 0,
          themeBuiltAt: res.themeBuiltAt,
          legacyFallback: !!res.legacyFallback,
        };
        setBacklogCacheInfo(nextInfo);
        return nextInfo;
      }
    } catch (e) {
      console.error('Could not load backlog cache info', e);
    }
    return null;
  }, []);

  const loadBacklogDiagnostics = useCallback(async (projectKey: string) => {
    try {
      const res = await api.diagnoseBacklogCache(projectKey) as any;
      if (res?.success) {
        setBacklogDiagnostics(res.diagnostics ?? null);
        return res.diagnostics ?? null;
      } else {
        setBacklogDiagnostics(null);
      }
    } catch (e) {
      console.error('Could not load backlog diagnostics', e);
      setBacklogDiagnostics(null);
    }
    return null;
  }, []);

  const loadBacklogRefreshStatus = useCallback(async (projectKey: string) => {
    try {
      const res = await api.getBacklogRefreshStatus(projectKey) as any;
      if (res?.success) {
        setBacklogRefreshStatus(res.status ?? null);
        return res.status ?? null;
      }
    } catch (e) {
      console.error('Could not load backlog refresh status', e);
    }
    return null;
  }, []);

  useEffect(() => {
    loadInitialConfig();
    // Bootstraps settings state once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (initialProjectKey) setActiveArProj(initialProjectKey);
  }, [initialProjectKey]);

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

  async function loadInitialConfig() {
    api.discoverLinkTypes().then((res: any) => {
      // Logic for available link types was removed
    }).catch(() => {});

    try {
      const existingConfig = await api.getConfig() as any;
      if (existingConfig) {
        const gc = existingConfig.generatorConfig || {};
        const loadedProvider = gc.provider ? getDisplayProvider(gc.provider) : 'anthropic';
        setProvider(loadedProvider);
        if (gc.decompositionModel) setDecompositionModel(gc.decompositionModel);
        if (gc.arModel) setArModel(gc.arModel);
        if (gc.clarifyModel) setClarifyModel(gc.clarifyModel);
        if (gc.evaluateModel) setEvaluateModel(gc.evaluateModel);
        if (gc.triageModel) setTriageModel(gc.triageModel);
        if (gc.refineModel) setRefineModel(gc.refineModel);
        if (gc.themeModel) setThemeModel(gc.themeModel);

        if (gc.geminiApiKey) setExistingGeminiApiKey(gc.geminiApiKey);
        if (gc.geminiBaseUrl) setGeminiBaseUrl(gc.geminiBaseUrl);
        if (gc.anthropicApiKey) setExistingAnthropicApiKey(gc.anthropicApiKey);
        if (gc.anthropicBaseUrl) setAnthropicBaseUrl(gc.anthropicBaseUrl);
        if (gc.openaiApiKey) setExistingOpenaiApiKey(gc.openaiApiKey);
        if (gc.openaiBaseUrl) setOpenaiBaseUrl(gc.openaiBaseUrl);
        if (gc.azureOpenAIApiKey) setExistingAzureOpenAIApiKey(gc.azureOpenAIApiKey);
        if (gc.azureOpenAIBaseUrl) setAzureOpenAIBaseUrl(gc.azureOpenAIBaseUrl);
        if (gc.azureOpenAIApiVersion) setAzureOpenAIApiVersion(gc.azureOpenAIApiVersion);
        if (gc.modelCatalogs) {
          const nextCatalogs = { ...gc.modelCatalogs } as LlmModelCatalogByVendor;
          if (!nextCatalogs.anthropic && nextCatalogs.forge_llms) {
            nextCatalogs.anthropic = {
              ...nextCatalogs.forge_llms,
              vendor: 'anthropic',
            };
          }
          setModelCatalogs(nextCatalogs);
          const strategyState = resolveUiGeneratorStrategyState({
            config: gc,
            provider: loadedProvider,
          });
          setModelStrategy(strategyState.modelStrategy);
          setSimpleBucketModels(strategyState.resolvedBucketModels);
        } else {
          const strategyState = resolveUiGeneratorStrategyState({
            config: gc,
            provider: loadedProvider,
          });
          setModelStrategy(strategyState.modelStrategy);
          setSimpleBucketModels(strategyState.resolvedBucketModels);
        }

        if (existingConfig.tier) setTier(existingConfig.tier);
        setComplianceEnabled(Boolean(existingConfig.compliance?.enabled));
        setTransparencyEnabled(Boolean(existingConfig.compliance?.transparencyReportsEnabled));
        setPiiMaskingEnabled(Boolean(existingConfig.compliance?.piiMaskingEnabled));
        setAuditTrailEnabled(Boolean(existingConfig.compliance?.auditTrailEnabled));
        if (existingConfig.wiConfig?.enabled !== undefined) setWiEnabled(existingConfig.wiConfig.enabled);
        if (existingConfig.defaultProjectKey) setDefaultProjectKey(existingConfig.defaultProjectKey);
        if (existingConfig.arMappings) setArMappings(existingConfig.arMappings.map((mapping: any) => normalizeProjectArMapping(mapping)));
        if (existingConfig.domainContexts) {
          setDomainContexts(existingConfig.domainContexts.map((entry: any) => normalizeProjectDomainContext(entry)));
        } else {
          const parsedContext = splitGuidanceContext(existingConfig.domainContext || '');
          setDomainContexts([{
            projectKey: '*',
            context: parsedContext.context,
            personaRoles: parsedContext.roleRows.length
              ? parsedContext.roleRows
              : normalizeRoleGuidanceRows(existingConfig.domainRoles as any[]).filter((row) => row.role || row.activities),
          }]);
        }
        if (existingConfig.backlogStatusScopes) setBacklogStatusScopes(existingConfig.backlogStatusScopes);
        if (existingConfig.backlogThemeBudgetOverride) {
          setBacklogThemeBudgetOverride(String(existingConfig.backlogThemeBudgetOverride));
        } else {
          setBacklogThemeBudgetOverride('');
        }
        if (existingConfig.branding?.logoUrl !== undefined) setBrandingLogoUrl(existingConfig.branding.logoUrl || '');
        if (existingConfig.isAdmin !== undefined) setIsAdmin(existingConfig.isAdmin);
      }
      const usageRes = await api.getUsage() as any;
      if (usageRes?.usage) setUsage(usageRes.usage);
      if (usageRes?.limits) setLimits(usageRes.limits);
      if (usageRes?.tier) setTier(usageRes.tier);
      const jiraRes = await api.discoverJira() as any;
      if (jiraRes?.success !== false) {
        setProjects(jiraRes.projects ?? []);
        setCustomFields(jiraRes.fields ?? []);
      }
      const [auditRes, reportRes, summaryRes, activityRes, piiPreviewRes] = await Promise.all([
        api.listComplianceAuditEvents(250) as Promise<any>,
        api.listTransparencyReports({ limit: 250 }) as Promise<any>,
        api.getComplianceSummary().catch(() => null) as Promise<any>,
        api.getProjectActivitySummary(1000).catch(() => null) as Promise<any>,
        api.previewPiiMasking({ text: piiPreviewInput, enabled: true }).catch(() => null) as Promise<any>,
      ]);
      setComplianceEvents(Array.isArray(auditRes?.events) ? auditRes.events : []);
      setTransparencyReports(Array.isArray(reportRes?.reports) ? reportRes.reports : []);
      if (summaryRes?.summary) setComplianceSummary(summaryRes.summary);
      setProjectActivityRows(Array.isArray(activityRes?.summary) ? activityRes.summary : []);
      if (piiPreviewRes?.success) {
        setPiiPreviewResult({
          text: piiPreviewRes.text,
          totalRedactions: piiPreviewRes.totalRedactions ?? 0,
          byType: piiPreviewRes.byType ?? {},
        });
      }
    } catch (e) { console.error('Error loading config', e); }
  }

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
      void loadBacklogCacheInfo(activeArProj);
      void loadBacklogDiagnostics(activeArProj);
      void loadBacklogRefreshStatus(activeArProj);
    } else {
      setBacklogCacheInfo(null);
      setBacklogDiagnostics(null);
      setBacklogRefreshStatus(null);
    }
  }, [activeTab, activeArProj, loadBacklogCacheInfo, loadBacklogDiagnostics, loadBacklogRefreshStatus]);

  useEffect(() => {
    if (activeTab === 'jira' && activeArProj && activeArProj !== '*') {
      loadBacklogStatuses(activeArProj);
    } else {
      setBacklogStatusOptions([]);
    }
  }, [activeTab, activeArProj]);

  async function handleRefreshBacklogCache(projectKey = activeArProj) {
    if (!projectKey || projectKey === '*') return null;
    setIsRefreshingBacklogCache(true);
    try {
      const res = await api.refreshBacklogCache(projectKey) as any;
      if (res?.success) {
        setBacklogRefreshStatus({
          projectKey,
          status: 'queued',
          queuedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        const startedAt = Date.now();
        while (Date.now() - startedAt < 15 * 60 * 1000) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          const status = await loadBacklogRefreshStatus(projectKey);
          if (!status) continue;
          if (status.status === 'queued' || status.status === 'running') continue;
          if (status.status === 'error') {
            alert(status.error || 'Backlog cache refresh failed.');
            return null;
          }
          const [nextInfo, diagnostics] = await Promise.all([
            loadBacklogCacheInfo(projectKey),
            loadBacklogDiagnostics(projectKey),
          ]);
          if (nextInfo) {
            return {
              ...nextInfo,
              diagnostics,
            };
          }
          return null;
        }
        alert('Backlog cache rebuild is still running in the background. Please check back in a moment.');
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
    if (activeTab === 'jira' && activeArProj && activeArProj !== '*') {
      void loadWiDocs();
    } else {
      setWiDocs([]);
    }
  }, [activeTab, activeArProj, loadWiDocs]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const res = await api.previewPiiMasking({ text: piiPreviewInput, enabled: piiMaskingEnabled }) as any;
        if (!cancelled && res?.success) {
          setPiiPreviewResult({
            text: res.text,
            totalRedactions: res.totalRedactions ?? 0,
            byType: res.byType ?? {},
          });
        }
      } catch {
        if (!cancelled) {
          const fallback = maskPreviewText(piiPreviewInput);
          setPiiPreviewResult({
            text: fallback.text,
            totalRedactions: fallback.totalRedactions,
            byType: fallback.byType,
          });
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [piiPreviewInput, piiMaskingEnabled]);

  async function handleWiFileDrop(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;
    const invalid = files.find(file => !['.pdf', '.csv', '.txt', '.md', '.eml'].some(ext => file.name.toLowerCase().endsWith(ext)));
    if (invalid) {
      setWiUploadError('Supported formats are PDF, CSV, TXT, Markdown, and EML.');
      return;
    }
    setWiUploadError(null);
    try {
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        const label = files.length > 1 ? `${file.name} (${i + 1}/${files.length})` : file.name;
        setWiUploadState({ filename: label, stage: 'reading' });
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            resolve(dataUrl.split(',')[1] || dataUrl);
          };
          reader.onerror = () => reject(new Error('Read failed'));
          reader.readAsDataURL(file);
        });
        setWiUploadState({ filename: label, stage: 'uploading' });
        const res = await api.uploadWi(file.name, base64, undefined, activeArProj) as any;
        if (res.success === false) {
          throw new Error(res.error || 'Upload failed');
        }
        setWiUploadState({ filename: label, stage: 'indexing' });
      }
      await loadWiDocs();
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

  async function handleSave() {
    setIsSaving(true);
    try {
      if (activeTab === 'domain' && !isAdmin) {
        await api.saveUserPreferences({ defaultProjectKey: defaultProjectKey || undefined });
        alert('Personal settings saved successfully!');
        return;
      }
      const generatorModels = strategyState.resolvedModels;
      await api.saveConfig({
        generatorConfig: {
          provider,
          modelStrategy: strategyState.modelStrategy,
          bucketClasses: DEFAULT_BUCKET_CLASSES,
          modelStrategyVersion: MODEL_STRATEGY_VERSION,
          decompositionModel: generatorModels.decompositionModel,
          arModel: generatorModels.arModel,
          clarifyModel: generatorModels.clarifyModel,
          refineModel: generatorModels.refineModel,
          evaluateModel: generatorModels.evaluateModel,
          triageModel: generatorModels.triageModel,
          themeModel: generatorModels.themeModel,
          maxTokens: 8192,
          anthropicApiKey: provider === 'anthropic' ? (anthropicApiKey.trim() || existingAnthropicApiKey || undefined) : undefined,
          anthropicBaseUrl: provider === 'anthropic' ? (anthropicBaseUrl.trim() || undefined) : undefined,
          geminiApiKey: geminiApiKey.trim() || existingGeminiApiKey || "",
          geminiBaseUrl: geminiBaseUrl.trim() || undefined,
          openaiApiKey: openaiApiKey.trim() || existingOpenaiApiKey || "",
          openaiBaseUrl: openaiBaseUrl.trim() || undefined,
          azureOpenAIApiKey: azureOpenAIApiKey.trim() || existingAzureOpenAIApiKey || "",
          azureOpenAIBaseUrl: azureOpenAIBaseUrl.trim() || undefined,
          azureOpenAIApiVersion: azureOpenAIApiVersion.trim() || undefined,
          modelCatalogs,
        },
        domainContext: '',
        domainContexts,
        domainRoles: [],
        wiConfig: { enabled: wiEnabled, topKChunks: 8, maxChars: 100000 },
        compliance: {
          enabled: complianceEnabled,
          transparencyReportsEnabled: transparencyEnabled,
          piiMaskingEnabled,
          auditTrailEnabled,
        },
        branding: {
          logoUrl: brandingLogoUrl.trim() || null,
        },
        arMappings,
        backlogStatusScopes,
        backlogThemeBudgetOverride: normalizeOptionalPositiveInt(backlogThemeBudgetOverride),
        tier: 'standard',
      });
      await api.saveUserPreferences({ defaultProjectKey: defaultProjectKey || undefined });
      if (geminiApiKey.trim()) setExistingGeminiApiKey(REDACTED);
      if (anthropicApiKey.trim()) setExistingAnthropicApiKey(REDACTED);
      if (openaiApiKey.trim()) setExistingOpenaiApiKey(REDACTED);
      if (azureOpenAIApiKey.trim()) setExistingAzureOpenAIApiKey(REDACTED);
      setGeminiApiKey(''); setAnthropicApiKey(''); setOpenaiApiKey(''); setAzureOpenAIApiKey('');
      alert('Settings saved successfully!');
    } catch(e: any) { alert(`Failed to save configuration: ${e.message || 'Unknown error'}`); }
    finally { setIsSaving(false); }
  }

  async function testLlmConnection() {
    setIsTestingLlm(true); setLlmTestResult(null);
    try {
      const resolvedTestModel = strategyState.resolvedModels.clarifyModel.trim();
      if (!resolvedTestModel) {
        throw new Error(provider === 'azure_openai'
          ? 'No Azure OpenAI deployment is available yet. Refresh models and choose a concrete deployment first.'
          : 'Choose a concrete model before testing the connection.');
      }
      const res = await api.testLlmConnection({
        provider,
        model: resolvedTestModel,
        anthropicApiKey: provider === 'anthropic' ? (anthropicApiKey.trim() || existingAnthropicApiKey || undefined) : undefined,
        anthropicBaseUrl: provider === 'anthropic' ? (anthropicBaseUrl.trim() || undefined) : undefined,
        geminiApiKey: provider === 'gemini' ? (geminiApiKey.trim() || existingGeminiApiKey || undefined) : undefined,
        geminiBaseUrl: provider === 'gemini' ? (geminiBaseUrl.trim() || undefined) : undefined,
        openaiApiKey: provider === 'openai' ? (openaiApiKey.trim() || existingOpenaiApiKey || undefined) : undefined,
        openaiBaseUrl: provider === 'openai' ? (openaiBaseUrl.trim() || undefined) : undefined,
        azureOpenAIApiKey: provider === 'azure_openai' ? (azureOpenAIApiKey.trim() || existingAzureOpenAIApiKey || undefined) : undefined,
        azureOpenAIBaseUrl: provider === 'azure_openai' ? (azureOpenAIBaseUrl.trim() || undefined) : undefined,
        azureOpenAIApiVersion: provider === 'azure_openai' ? (azureOpenAIApiVersion.trim() || undefined) : undefined,
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

  const refreshModelCatalog = useCallback(async () => {
    setIsRefreshingModels(true);
    setModelCatalogError(null);
    try {
      const res = await api.discoverLlmModels({
        provider,
        anthropicApiKey: anthropicApiKey.trim() || existingAnthropicApiKey || undefined,
        anthropicBaseUrl: anthropicBaseUrl.trim() || undefined,
        geminiApiKey: geminiApiKey.trim() || existingGeminiApiKey || undefined,
        geminiBaseUrl: geminiBaseUrl.trim() || undefined,
        openaiApiKey: openaiApiKey.trim() || existingOpenaiApiKey || undefined,
        openaiBaseUrl: openaiBaseUrl.trim() || undefined,
        azureOpenAIApiKey: azureOpenAIApiKey.trim() || existingAzureOpenAIApiKey || undefined,
        azureOpenAIBaseUrl: azureOpenAIBaseUrl.trim() || undefined,
        azureOpenAIApiVersion: azureOpenAIApiVersion.trim() || undefined,
      }) as any;
      if (res?.success && res.catalog) {
        setModelCatalogs(prev => ({ ...prev, [provider]: res.catalog }));
      } else if (res?.error) {
        setModelCatalogError(res.error);
      }
    } catch (err: any) {
      setModelCatalogError(err?.message || 'Could not refresh model list.');
    } finally {
      setIsRefreshingModels(false);
    }
  }, [
    provider,
    anthropicApiKey,
    existingAnthropicApiKey,
    anthropicBaseUrl,
    geminiApiKey,
    existingGeminiApiKey,
    geminiBaseUrl,
    openaiApiKey,
    existingOpenaiApiKey,
    openaiBaseUrl,
    azureOpenAIApiKey,
    existingAzureOpenAIApiKey,
    azureOpenAIBaseUrl,
    azureOpenAIApiVersion,
  ]);

  useEffect(() => {
    const hasStoredCredential = provider === 'gemini'
      ? Boolean(existingGeminiApiKey)
      : provider === 'openai'
        ? Boolean(existingOpenaiApiKey)
        : provider === 'azure_openai'
          ? Boolean(existingAzureOpenAIApiKey && azureOpenAIBaseUrl.trim())
          : true;
    if (hasStoredCredential && !modelCatalogs[provider]) {
      void refreshModelCatalog();
    }
  }, [provider, existingGeminiApiKey, existingOpenaiApiKey, existingAzureOpenAIApiKey, azureOpenAIBaseUrl, modelCatalogs, refreshModelCatalog]);

  const { entries: catalogEntries } = useMemo(
    () => getCatalogEntriesForProvider(provider, modelCatalogs),
    [provider, modelCatalogs],
  );

  const currentCatalogEntries = useMemo(() => {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return [...catalogEntries].sort((a, b) => collator.compare(a.displayName || a.id, b.displayName || b.id));
  }, [catalogEntries]);

  const strategyState = useMemo(() => resolveUiGeneratorStrategyState({
    config: {
      provider,
      modelStrategy,
      modelStrategyVersion: MODEL_STRATEGY_VERSION,
      decompositionModel,
      arModel,
      clarifyModel,
      refineModel,
      evaluateModel,
      triageModel,
      themeModel,
      maxTokens: 8192,
    },
    provider,
    modelStrategy,
    bucketModels: simpleBucketModels,
  }), [
    provider,
    modelStrategy,
    simpleBucketModels,
    decompositionModel,
    arModel,
    clarifyModel,
    refineModel,
    evaluateModel,
    triageModel,
    themeModel,
  ]);

  useEffect(() => {
    if (strategyState.modelStrategy !== 'advanced') return;
    const proModel = getPreferredFamilyModel(currentCatalogEntries, 'pro');
    const flashModel = getPreferredFamilyModel(currentCatalogEntries, 'flash');
    const liteModel = getPreferredFamilyModel(currentCatalogEntries, 'lite');
    const liteOrFlashModel = liteModel || flashModel;

    if (provider === 'azure_openai') {
      const shouldResetAzureModel = (modelId: string) =>
        !modelId.trim()
        || modelId.startsWith('gemini-')
        || modelId.startsWith('gpt-')
        || modelId.startsWith('o')
        || modelId.startsWith('claude-');
      if (shouldResetAzureModel(decompositionModel) && proModel) setDecompositionModel(proModel);
      if (shouldResetAzureModel(arModel) && proModel) setArModel(proModel);
      if (shouldResetAzureModel(clarifyModel) && flashModel) setClarifyModel(flashModel);
      if (shouldResetAzureModel(evaluateModel) && liteOrFlashModel) setEvaluateModel(liteOrFlashModel);
      if (shouldResetAzureModel(triageModel) && liteOrFlashModel) setTriageModel(liteOrFlashModel);
      if (shouldResetAzureModel(refineModel) && flashModel) setRefineModel(flashModel);
      if (shouldResetAzureModel(themeModel) && liteOrFlashModel) setThemeModel(liteOrFlashModel);
    } else {
      if (!isProviderModel(provider, decompositionModel) && proModel) setDecompositionModel(proModel);
      if (!isProviderModel(provider, arModel) && proModel) setArModel(proModel);
      if (!isProviderModel(provider, clarifyModel) && flashModel) setClarifyModel(flashModel);
      if (!isProviderModel(provider, evaluateModel) && liteOrFlashModel) setEvaluateModel(liteOrFlashModel);
      if (!isProviderModel(provider, triageModel) && liteOrFlashModel) setTriageModel(liteOrFlashModel);
      if (!isProviderModel(provider, refineModel) && flashModel) setRefineModel(flashModel);
      if (!isProviderModel(provider, themeModel) && liteOrFlashModel) setThemeModel(liteOrFlashModel);
    }
  }, [provider, strategyState.modelStrategy, currentCatalogEntries, decompositionModel, arModel, clarifyModel, evaluateModel, triageModel, refineModel, themeModel]);

  const availableModels = useMemo(() => {
    const options: Array<{ id: string; label: string }> = [];
    currentCatalogEntries.forEach(entry => {
      const id = entry.deploymentName || entry.id;
      if (!options.some(option => option.id === id)) {
        options.push({
          id,
          label: entry.displayName || entry.id,
        });
      }
    });
    [
      clarifyModel,
      decompositionModel,
      arModel,
      evaluateModel,
      triageModel,
      refineModel,
      themeModel,
      strategyState.resolvedModels.clarifyModel,
      strategyState.resolvedModels.decompositionModel,
      strategyState.resolvedModels.arModel,
      strategyState.resolvedModels.evaluateModel,
      strategyState.resolvedModels.triageModel,
      strategyState.resolvedModels.refineModel,
      strategyState.resolvedModels.themeModel,
    ].forEach(modelId => {
      if (modelId && !options.some(option => option.id === modelId)) {
        options.push({ id: modelId, label: modelId });
      }
    });
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return options.sort((left, right) => collator.compare(left.label, right.label));
  }, [currentCatalogEntries, clarifyModel, decompositionModel, arModel, evaluateModel, triageModel, refineModel, themeModel, strategyState]);

  const showComplianceTab = true;
  const settingsNav = [
    { id: 'models', label: 'AI Setup', icon: BrainCircuit, sub: 'Provider and models' },
    { id: 'jira', label: 'Project Setup', icon: Database, sub: 'Backlog, fields, docs' },
    { id: 'domain', label: 'Personal', icon: Globe, sub: 'Your defaults and preferences' },
    { id: 'stats', label: 'Stats', icon: BarChart3, sub: 'Usage and audit visibility' },
    { id: 'billing', label: 'Billing', icon: CreditCard, sub: 'Plan and controls' },
    ...(showComplianceTab ? [{ id: 'compliance', label: 'Compliance', icon: ShieldCheck, sub: 'Coming Soon' }] : []),
  ] as const;

  const wiUploadCopy = wiUploadState
    ? wiUploadState.stage === 'reading'
      ? 'Preparing document'
      : wiUploadState.stage === 'uploading'
        ? 'Uploading document'
        : 'Indexing for retrieval'
    : null;
  return (
    <div className="flex-1 flex flex-col h-full bg-transparent relative overflow-hidden font-sans">
      <header className="shrink-0 h-14 border-b border-[rgba(43,89,74,0.08)] bg-[rgba(252,252,251,0.82)] backdrop-blur-xl flex items-center justify-between px-6 z-30 sticky top-0">
        <div className="flex items-center gap-4">
          <motion.button
            onClick={onClose}
            className="p-1.5 rounded-lg border border-[var(--rf-border)] bg-white text-[var(--rf-text-tertiary)] hover:bg-[var(--rf-surface-soft)] hover:text-[var(--rf-text)] transition-all shadow-sm"
            whileTap={{ scale: 0.95 }}
          >
            <ChevronLeft className="w-4 h-4" />
          </motion.button>
          <h2 className="rf-pane-header-title">Settings</h2>
          <div className="flex items-center gap-1.5">
            <span className={`text-[13px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wider border ${isAdmin ? 'bg-[var(--rf-success-subtle)] text-[var(--rf-success)] border-[var(--rf-success-subtle)]' : 'bg-[var(--rf-danger-subtle)] text-[var(--rf-danger)] border-[var(--rf-danger-subtle)]'}`}>
              {isAdmin ? 'Admin' : 'Personal Only'}
            </span>
            <span className="text-[13px] text-[var(--rf-brand)] font-bold uppercase tracking-wider flex items-center gap-1 bg-[var(--rf-brand-muted)] px-2 py-0.5 rounded-md border border-[rgba(43,89,74,0.12)] capitalize">
              {tier}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {isAdmin && activeTab === 'jira' && activeArProj !== '*' && (
            <div className="flex items-center gap-2">
              <motion.button
                onClick={() => document.getElementById('jira-save-target')?.click()}
                className="bg-white border border-[var(--rf-border)] text-[var(--rf-text-secondary)] hover:bg-[var(--rf-surface-soft)] text-[13px] font-bold px-4 py-1.5 rounded-lg shadow-sm transition-all flex items-center gap-2"
                whileTap={{ scale: 0.98 }}
              >
                <Save className="w-3.5 h-3.5" /> Save
              </motion.button>
              <motion.button
                onClick={() => document.getElementById('jira-save-rebuild-target')?.click()}
                className="bg-[var(--rf-text)] hover:bg-black text-white text-[13px] font-bold px-4 py-1.5 rounded-lg shadow-sm transition-all flex items-center gap-2"
                whileTap={{ scale: 0.98 }}
              >
                <RefreshCw className="w-3.5 h-3.5" /> Save & Rebuild
              </motion.button>
            </div>
          )}
          {(isAdmin || activeTab === 'domain') && activeTab !== 'jira' && activeTab !== 'compliance' && (
            <motion.button
              onClick={handleSave}
              disabled={isSaving}
              className="bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] disabled:opacity-50 text-white text-[13px] font-bold px-4 py-1.5 rounded-lg shadow-sm shadow-[var(--rf-brand)]/20 transition-all flex items-center gap-2"
              whileTap={{ scale: 0.98 }}
            >
              {isSaving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save
            </motion.button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-hidden flex">
          <div className="w-44 shrink-0 border-r border-[rgba(43,89,74,0.10)] bg-[rgba(248,246,240,0.60)] backdrop-blur-xl px-3 py-3 flex flex-col gap-0.5">
            {settingsNav.map((tab) => (
              <button
                key={tab.id}
                disabled={tab.id === 'compliance'}
                onClick={() => setActiveTab(tab.id as any)}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-all ${
                  activeTab === tab.id
                    ? 'bg-white/90 text-[var(--rf-brand)] shadow-sm border border-[rgba(43,89,74,0.10)]'
                    : 'text-[var(--rf-text-tertiary)] border border-transparent hover:bg-white/50 hover:text-[var(--rf-text-secondary)]'
                } ${tab.id === 'compliance' ? 'opacity-50 cursor-not-allowed filter grayscale' : ''}`}
              >
                <tab.icon className={`w-3.5 h-3.5 shrink-0 ${activeTab === tab.id ? 'text-[var(--rf-brand)]' : 'text-[var(--rf-text-tertiary)]'}`} />
                <div className="flex flex-col text-left">
                  <span className={`text-[13px] font-semibold leading-tight ${activeTab === tab.id ? 'text-[var(--rf-brand-hover)]' : 'text-[var(--rf-text-secondary)]'}`}>{tab.label}</span>
                  {tab.id === 'compliance' && <span className="text-[10px] font-bold text-[var(--rf-brand)] uppercase tracking-tighter mt-0.5">Coming Soon</span>}
                </div>
              </button>
            ))}

            <div className="mt-auto pt-3 border-t border-[rgba(43,89,74,0.08)]">
              <div className="px-2.5 py-2 space-y-0.5">
                <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">{tier}</div>
                <div className="text-[12px] text-[var(--rf-text-tertiary)]">
                  {usage?.currentMonth ?? 0}<span className="text-[var(--rf-border-strong)]">/</span>{limits?.generationsPerMonth === -1 ? '∞' : limits?.generationsPerMonth ?? 0} included
                </div>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-5 custom-scrollbar bg-transparent">
            {activeTab === 'models' && (
              <motion.div
                className="max-w-3xl space-y-4"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
              >
                {/* Provider + API key */}
                <div className="rf-card p-5 space-y-4">
                  <div className="space-y-2">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">LLM Provider</div>
                    <div className="flex p-0.5 bg-[var(--rf-surface-soft)] rounded-lg border border-[var(--rf-border)]">
                      {(['anthropic', 'openai', 'azure_openai', 'gemini'] as const).map(p => (
                        <button key={p} onClick={() => setProvider(p)} className={`flex-1 py-1.5 text-[12px] font-bold uppercase tracking-wide rounded-md transition-all ${provider === p ? 'bg-white text-[var(--rf-brand)] shadow-sm border border-[var(--rf-border)]/50' : 'text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text-secondary)]'}`}>
                          {getProviderLabel(p)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {provider === 'anthropic' && (
                    <motion.div className="space-y-3" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                      <div className="space-y-1.5">
                        <div className="flex justify-between items-center">
                          <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Anthropic API Key</label>
                          {existingAnthropicApiKey && <button onClick={() => { setExistingAnthropicApiKey(''); setAnthropicApiKey(''); }} className="text-[12px] font-bold text-[var(--rf-danger)]">Clear</button>}
                        </div>
                        <input type="password" value={anthropicApiKey} onChange={e => setAnthropicApiKey(e.target.value)} placeholder={existingAnthropicApiKey ? '••••••••• (stored)' : 'sk-ant-…'} disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Custom Base URL</label>
                        <input type="text" value={anthropicBaseUrl} onChange={e => setAnthropicBaseUrl(e.target.value)} placeholder="https://api.anthropic.com/v1" disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                      </div>
                    </motion.div>
                  )}

                  {provider === 'openai' && (
                    <motion.div className="space-y-1.5" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                      <div className="flex justify-between items-center">
                        <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">OpenAI API Key</label>
                        {existingOpenaiApiKey && <button onClick={() => { setExistingOpenaiApiKey(''); setOpenaiApiKey(''); }} className="text-[12px] font-bold text-[var(--rf-danger)]">Clear</button>}
                      </div>
                      <input type="password" value={openaiApiKey} onChange={e => setOpenaiApiKey(e.target.value)} placeholder={existingOpenaiApiKey ? '••••••••• (stored)' : 'sk-…'} disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                    </motion.div>
                  )}

                  {provider === 'azure_openai' && (
                    <motion.div className="space-y-3" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                      <div className="space-y-1.5">
                        <div className="flex justify-between items-center">
                          <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Azure OpenAI API Key</label>
                          {existingAzureOpenAIApiKey && <button onClick={() => { setExistingAzureOpenAIApiKey(''); setAzureOpenAIApiKey(''); }} className="text-[12px] font-bold text-[var(--rf-danger)]">Clear</button>}
                        </div>
                        <input type="password" value={azureOpenAIApiKey} onChange={e => setAzureOpenAIApiKey(e.target.value)} placeholder={existingAzureOpenAIApiKey ? '••••••••• (stored)' : 'Azure key'} disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Endpoint</label>
                          <input type="text" value={azureOpenAIBaseUrl} onChange={e => setAzureOpenAIBaseUrl(e.target.value)} placeholder="https://…openai.azure.com" disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">API Version</label>
                          <input type="text" value={azureOpenAIApiVersion} onChange={e => setAzureOpenAIApiVersion(e.target.value)} placeholder="2024-06-01" disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                        </div>
                      </div>
                    </motion.div>
                  )}

                  {provider === 'gemini' && (
                    <motion.div className="space-y-1.5" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                      <div className="flex justify-between items-center">
                        <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Gemini API Key</label>
                        {existingGeminiApiKey && <button onClick={() => { setExistingGeminiApiKey(''); setGeminiApiKey(''); }} className="text-[12px] font-bold text-[var(--rf-danger)]">Clear</button>}
                      </div>
                      <input type="password" value={geminiApiKey} onChange={e => setGeminiApiKey(e.target.value)} placeholder={existingGeminiApiKey ? '••••••••• (stored)' : 'AIza…'} disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                    </motion.div>
                  )}
                </div>

                {/* Model assignments */}
                <div className="rf-card p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Model assignments</div>
                    <div className="flex items-center gap-3">
                      {modelCatalogError && <span className="text-[12px] font-semibold text-[var(--rf-danger)]">{modelCatalogError}</span>}
                      <span className="text-[12px] text-[var(--rf-text-tertiary)]">
                        {modelCatalogs[provider]?.models?.length ? `${modelCatalogs[provider]?.models?.length} models` : 'bundled catalog'}
                      </span>
                      <motion.button
                        onClick={refreshModelCatalog}
                        disabled={isRefreshingModels || !isAdmin}
                        className="flex items-center gap-1.5 text-[12px] font-bold text-[var(--rf-text-secondary)] bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] px-2.5 py-1 rounded-lg disabled:opacity-40 transition hover:bg-white"
                        whileTap={{ scale: 0.97 }}
                      >
                        <RefreshCw className={`w-3 h-3 ${isRefreshingModels ? 'animate-spin' : ''}`} /> Refresh
                      </motion.button>
                    </div>
                  </div>

                  <div className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3.5 py-3">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Strategy</div>
                    <div className="mt-1.5 text-[13px] text-[var(--rf-text-secondary)] leading-relaxed">
                      Simple keeps setup lightweight with one model for each workflow bucket. Advanced exposes all 7 internal model roles when a team wants full control.
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Mode</div>
                    <div className="flex p-0.5 bg-[var(--rf-surface-soft)] rounded-lg border border-[var(--rf-border)]">
                      {(['simple', 'advanced'] as const).map((nextStrategy) => {
                        return (
                          <button
                            key={nextStrategy}
                            onClick={() => {
                              if (nextStrategy === 'advanced' && strategyState.modelStrategy !== 'advanced') {
                                setDecompositionModel(strategyState.resolvedModels.decompositionModel);
                                setArModel(strategyState.resolvedModels.arModel);
                                setClarifyModel(strategyState.resolvedModels.clarifyModel);
                                setEvaluateModel(strategyState.resolvedModels.evaluateModel);
                                setTriageModel(strategyState.resolvedModels.triageModel);
                                setRefineModel(strategyState.resolvedModels.refineModel);
                                setThemeModel(strategyState.resolvedModels.themeModel);
                              }
                              if (nextStrategy === 'simple' && strategyState.modelStrategy !== 'simple') {
                                setSimpleBucketModels(strategyState.resolvedBucketModels);
                              }
                              setModelStrategy(nextStrategy);
                            }}
                            className={`flex-1 py-1.5 text-[12px] font-bold uppercase tracking-wide rounded-md transition-all ${
                              strategyState.modelStrategy === nextStrategy
                                ? 'bg-white text-[var(--rf-brand)] shadow-sm border border-[var(--rf-border)]/50'
                                : 'text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text-secondary)]'
                            }`}
                          >
                            {nextStrategy}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {strategyState.modelStrategy === 'advanced' ? (
                    <div className="divide-y divide-[var(--rf-border-subtle)]">
                      {GENERATOR_ROLE_ORDER.map((item) => (
                        <div key={item.field} className="flex items-center justify-between gap-4 py-2.5">
                          <div>
                            <div className="text-sm font-semibold text-[var(--rf-text)]">{item.label}</div>
                            <div className="text-[11px] text-[var(--rf-text-tertiary)] mt-0.5">{item.description}</div>
                          </div>
                          <div className="relative w-[220px] shrink-0">
                            <select value={roleModelValues[item.field]} disabled={availableModels.length === 0 || !isAdmin} onChange={e => roleModelSetters[item.field](e.target.value)} className="appearance-none pr-7 w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-1.5 text-[13px] font-semibold text-[var(--rf-text)] focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none transition disabled:opacity-60">
                              {availableModels.length === 0 ? <option>Select provider…</option> : availableModels.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                            </select>
                            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--rf-text-tertiary)] pointer-events-none" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="divide-y divide-[var(--rf-border-subtle)]">
                        {[
                          { key: 'discovery' as const, label: SIMPLE_BUCKET_LABELS.discovery, sub: SIMPLE_BUCKET_DESCRIPTIONS.discovery, resolved: strategyState.resolvedBucketModels.discovery },
                          { key: 'generation' as const, label: SIMPLE_BUCKET_LABELS.generation, sub: SIMPLE_BUCKET_DESCRIPTIONS.generation, resolved: strategyState.resolvedBucketModels.generation },
                          { key: 'refinement' as const, label: SIMPLE_BUCKET_LABELS.refinement, sub: SIMPLE_BUCKET_DESCRIPTIONS.refinement, resolved: strategyState.resolvedBucketModels.refinement },
                        ].map((item) => (
                          <div key={item.key} className="flex items-center justify-between gap-4 py-2.5">
                            <div>
                              <div className="text-sm font-semibold text-[var(--rf-text)]">{item.label}</div>
                              <div className="text-[11px] text-[var(--rf-text-tertiary)] mt-0.5">{item.sub}</div>
                              <div className="text-[12px] text-[var(--rf-brand)] mt-1 font-semibold">{item.resolved || 'No model selected'}</div>
                            </div>
                            <div className="relative w-[220px] shrink-0">
                              <select
                                value={simpleBucketModels[item.key]}
                                disabled={!isAdmin || availableModels.length === 0}
                                onChange={e => setSimpleBucketModels(prev => ({ ...prev, [item.key]: e.target.value }))}
                                className="appearance-none pr-7 w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-1.5 text-[13px] font-semibold text-[var(--rf-text)] focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none transition disabled:opacity-60"
                              >
                                {availableModels.length === 0 ? <option>Select provider…</option> : availableModels.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                              </select>
                              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--rf-text-tertiary)] pointer-events-none" />
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3.5 py-3 space-y-2">
                        <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Advanced role breakdown</div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {GENERATOR_ROLE_ORDER.map((item) => (
                            <div key={item.field} className="rounded-lg border border-[var(--rf-border)] bg-white px-3 py-2">
                              <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">{item.label}</div>
                              <div className="mt-1 text-[13px] font-semibold text-[var(--rf-text)]">{strategyState.resolvedModels[item.field]}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="pt-2 border-t border-[var(--rf-border-subtle)] flex items-center gap-3">
                    <motion.button
                      onClick={testLlmConnection}
                      disabled={isTestingLlm}
                      className="flex items-center gap-1.5 text-[13px] font-bold text-[var(--rf-text-secondary)] bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] px-3 py-1.5 rounded-lg transition hover:bg-white disabled:opacity-50"
                      whileTap={{ scale: 0.97 }}
                    >
                      {isTestingLlm ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />} Test connection
                    </motion.button>
                    {llmTestResult && (
                      <span className={`text-[13px] font-bold flex items-center gap-1.5 ${llmTestResult.ok ? 'text-[var(--rf-success)]' : 'text-[var(--rf-danger)]'}`}>
                        {llmTestResult.ok ? <Check className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />} {llmTestResult.message}
                      </span>
                    )}
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === 'jira' && (
              <motion.div
                className="max-w-3xl space-y-4"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
              >
                <div className="space-y-3">
                  {/* Step 1 */}
                  <div className="rf-card p-4 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <span className="w-5 h-5 rounded-full bg-[var(--rf-brand-muted)] border border-[rgba(43,89,74,0.15)] text-[var(--rf-brand)] text-[11px] font-black flex items-center justify-center shrink-0">1</span>
                      <div>
                        <div className="text-sm font-bold text-[var(--rf-text)]">Sync Jira</div>
                        <div className="text-[12px] text-[var(--rf-text-tertiary)]">{projects.length} projects · {customFields.length} fields</div>
                      </div>
                    </div>
                    <motion.button
                      onClick={discoverJira}
                      disabled={isDiscovering}
                      className="flex items-center gap-1.5 text-[13px] font-bold text-[var(--rf-text-secondary)] bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] px-3 py-1.5 rounded-lg transition hover:bg-white disabled:opacity-50"
                      whileTap={{ scale: 0.97 }}
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isDiscovering ? 'animate-spin' : ''}`} /> Sync
                    </motion.button>
                  </div>

                  {/* Step 2 Selection */}
                  <div className="rf-card p-4 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <span className="w-5 h-5 rounded-full bg-[var(--rf-brand-muted)] border border-[rgba(43,89,74,0.15)] text-[var(--rf-brand)] text-[11px] font-black flex items-center justify-center shrink-0">2</span>
                      <div className="text-sm font-bold text-[var(--rf-text)]">Select Project</div>
                    </div>
                    <SearchableSelect
                      value={activeArProj}
                      onChange={(value) => setActiveArProj(value || '*')}
                      options={projectOptions}
                      placeholder="Select a project..."
                      searchPlaceholder="Search projects..."
                      allowClear
                      clearLabel="Clear project"
                      className="w-64"
                      buttonClassName="bg-[var(--rf-surface-soft)]"
                    />
                  </div>

                  {activeArProj !== '*' ? (
                    <ProjectConfigurationManager 
                      projects={projects || []} customFields={customFields || []} arMappings={arMappings || []} setArMappings={setArMappings}
                      domainContexts={domainContexts || []} setDomainContexts={setDomainContexts}
                      backlogStatusScopes={backlogStatusScopes || []} setBacklogStatusScopes={setBacklogStatusScopes} backlogStatusOptions={backlogStatusOptions || []}
                      detectDefaultStatuses={detectDefaultStatuses}
                      activeArProj={activeArProj} setActiveArProj={setActiveArProj} isAdmin={isAdmin} isProjectAdmin={activeProjAdmin}
                      backlogCacheInfo={backlogCacheInfo}
                      backlogDiagnostics={backlogDiagnostics}
                      backlogRefreshStatus={backlogRefreshStatus}
                      isRefreshingBacklogCache={isRefreshingBacklogCache}
                      onRefreshBacklogCache={handleRefreshBacklogCache}
                      backlogThemeBudgetOverride={backlogThemeBudgetOverride}
                      onBacklogThemeBudgetOverrideChange={setBacklogThemeBudgetOverride}
                    />
                  ) : (
                    <div className="bg-white rounded-2xl p-12 text-center border-2 border-dashed border-[var(--rf-border)]">
                      <Database className="w-12 h-12 text-[var(--rf-border-strong)] mx-auto mb-4" />
                      <h4 className="text-lg font-bold text-[var(--rf-text)]">Select a project to configure</h4>
                      <p className="text-sm font-medium text-[var(--rf-text-tertiary)] mt-2 max-w-md mx-auto">Define backlog indexing scope, work instructions, and project-specific guidance for the selected project.</p>
                    </div>
                  )}

                  {/* Step 3 WIs */}
                  <div className="rf-card p-4 space-y-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <span className="w-5 h-5 rounded-full bg-[var(--rf-brand-muted)] border border-[rgba(43,89,74,0.15)] text-[var(--rf-brand)] text-[11px] font-black flex items-center justify-center shrink-0">3</span>
                        <div>
                          <div className="text-sm font-bold text-[var(--rf-text)]">Work Instructions</div>
                          <div className="text-[12px] text-[var(--rf-text-tertiary)]">{wiDocs.length} linked · PDFs, spreadsheets, text</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <motion.button
                          onClick={() => wiFileInputRef.current?.click()}
                          disabled={activeArProj === '*' || !!wiUploadState}
                          className="flex items-center gap-1.5 text-[13px] font-bold text-white bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] disabled:opacity-50 px-3 py-1.5 rounded-lg transition"
                          whileTap={{ scale: 0.97 }}
                        >
                          {wiUploadState ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Uploading…</> : 'Add docs'}
                        </motion.button>
                        <input type="file" ref={wiFileInputRef} onChange={handleWiFileDrop} accept={WI_ACCEPT} multiple className="hidden" disabled={activeArProj === '*' || !!wiUploadState} />
                      </div>
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
                                    <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Upload In Progress</div>
                                    <div className="mt-1 text-sm font-bold text-[var(--rf-text)]">{wiUploadState.filename}</div>
                                  </div>
                                  <div className="inline-flex items-center gap-2 text-[var(--rf-brand)] text-xs font-bold">
                                    <RefreshCw className="w-4 h-4 animate-spin" />
                                    {wiUploadCopy}
                                  </div>
                                </div>
                                <div className="h-1.5 overflow-hidden rounded-full bg-[rgba(43,89,74,0.12)]">
                                  <div className="h-full w-1/2 rounded-full bg-[var(--rf-brand)] animate-pulse" />
                                </div>
                              </div>
                            )}
                            {wiUploadError && (
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-danger)]">Upload Failed</div>
                                  <p className="mt-1 text-sm font-bold text-[var(--rf-text)]">{wiUploadError}</p>
                                </div>
                                <button type="button" onClick={() => setWiUploadError(null)} className="rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-[var(--rf-danger)] border border-[var(--rf-danger-subtle)]">Dismiss</button>
                              </div>
                            )}
                          </div>
                        )}

                        <div className="overflow-hidden rounded-xl border border-[var(--rf-border)] bg-white">
                          {wiDocs.length === 0 ? (
                            <div className="p-8 text-center border-2 border-dashed border-[var(--rf-border)] rounded-xl bg-[var(--rf-surface-soft)] m-3">
                              <FileText className="w-8 h-8 text-[var(--rf-border-strong)] mx-auto mb-2" />
                              <p className="text-sm font-semibold text-[var(--rf-text-tertiary)]">No work instructions linked to {activeArProj}.</p>
                            </div>
                          ) : (
                            <div>
                              <div className="grid grid-cols-[minmax(0,1fr)_90px_140px_56px] gap-3 border-b border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">
                                <div>Document</div>
                                <div>Chunks</div>
                                <div>Uploaded</div>
                                <div />
                              </div>
                              {wiDocs.map(doc => (
                                <div key={doc.docId} className="grid grid-cols-[minmax(0,1fr)_90px_140px_56px] gap-3 border-b border-[var(--rf-border-subtle)] px-4 py-3 last:border-b-0">
                                  <div className="min-w-0">
                                    <p className="truncate text-sm font-semibold text-[var(--rf-text)]">{doc.filename}</p>
                                    <p className="mt-0.5 text-[12px] text-[var(--rf-text-tertiary)]">{doc.revision}</p>
                                  </div>
                                  <div className="text-sm font-medium text-[var(--rf-text-secondary)]">{doc.chunkCount}</div>
                                  <div className="text-[12px] font-medium text-[var(--rf-text-tertiary)]">{new Date(doc.uploadedAt).toLocaleDateString()}</div>
                                  <button onClick={() => handleRemoveWiDoc(doc.docId)} className="ml-auto rounded-lg p-2 text-[var(--rf-text-tertiary)] transition-colors hover:bg-[var(--rf-danger-subtle)] hover:text-[var(--rf-danger)]">
                                    <Trash className="w-4 h-4" />
                                  </button>
                                </div>
                              ))}
                            </div>
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
                className="max-w-3xl space-y-4"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
              >
                <div className="rf-card p-5 space-y-5">
                  <div>
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Default project</div>
                    <div className="text-[13px] text-[var(--rf-text-tertiary)] mt-1">Choose the project that should be preselected for you when opening the generator.</div>
                  </div>
                  <div className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] p-4 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <div className="space-y-1">
                      <div className="text-sm font-bold text-[var(--rf-text)]">Personal default project</div>
                      <div className="text-[12px] text-[var(--rf-text-tertiary)]">Stored per user, so each teammate can keep their own starting project.</div>
                    </div>
                    <SearchableSelect
                      value={defaultProjectKey}
                      onChange={setDefaultProjectKey}
                      options={projectOptions}
                      placeholder="No default — choose each time"
                      searchPlaceholder="Search projects..."
                      allowClear
                      clearLabel="Clear default project"
                      className="w-full md:w-72"
                      buttonClassName="bg-white"
                    />
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === 'stats' && (
              <motion.div
                className="max-w-3xl space-y-4"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
              >
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {[
                    { label: 'Generations', value: usage?.currentMonth ?? 0, helper: 'this month' },
                    { label: 'Tokens', value: workspaceTokenUsage.toLocaleString(), helper: 'tracked' },
                    { label: 'Projects', value: projectUsageBreakdown.length, helper: 'with activity' },
                    { label: 'Records', value: complianceEvents.length + transparencyReports.length, helper: 'audit + reports' },
                  ].map((card) => (
                    <div key={card.label} className="rf-card px-3 py-2.5">
                      <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">{card.label}</div>
                      <div className="mt-1 text-xl font-black text-[var(--rf-text)]">{card.value}</div>
                      <div className="mt-0.5 text-[12px] text-[var(--rf-text-tertiary)]">{card.helper}</div>
                    </div>
                  ))}
                </div>

                <div className="rf-card p-4 space-y-3">
                  <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Project activity</div>
                  {projectUsageBreakdown.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-4 text-sm font-medium text-[var(--rf-text-tertiary)] text-center">
                      No tracked project activity yet.
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-lg border border-[var(--rf-border)]">
                      <table className="w-full text-left">
                        <thead className="bg-[var(--rf-surface-soft)]">
                          <tr className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">
                            <th className="px-3 py-2">Project</th>
                            <th className="px-3 py-2">Reports</th>
                            <th className="px-3 py-2">Tokens</th>
                            <th className="px-3 py-2 hidden sm:table-cell">Latest</th>
                          </tr>
                        </thead>
                        <tbody>
                          {projectUsageBreakdown.map((project) => (
                            <tr key={project.projectKey} className="border-t border-[var(--rf-border)]">
                              <td className="px-3 py-2 text-sm font-bold text-[var(--rf-text)]">{project.projectKey}</td>
                              <td className="px-3 py-2 text-sm font-medium text-[var(--rf-text-secondary)]">{project.reportCount}</td>
                              <td className="px-3 py-2 text-sm font-medium text-[var(--rf-text-secondary)]">{project.tokenUsage.toLocaleString()}</td>
                              <td className="px-3 py-2 text-[13px] font-medium text-[var(--rf-text-tertiary)] hidden sm:table-cell">{project.latestAt ? new Date(project.latestAt).toLocaleString() : 'n/a'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {showComplianceTab && (
                  <button
                    onClick={() => setActiveTab('compliance')}
                    className="w-full rf-card p-4 flex items-center justify-between gap-3 text-left hover:border-[var(--rf-brand)] transition group"
                  >
                    <div className="flex items-center gap-3">
                      <ShieldCheck className="w-5 h-5 text-[var(--rf-brand)]" />
                      <div>
                        <div className="text-sm font-bold text-[var(--rf-text)]">Compliance reports & audit trail</div>
                        <div className="text-[12px] text-[var(--rf-text-tertiary)]">{transparencyReports.length} transparency reports · {complianceEvents.length} audit events</div>
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-[var(--rf-text-tertiary)] group-hover:text-[var(--rf-brand)] transition" />
                  </button>
                )}
              </motion.div>
            )}

            {activeTab === 'billing' && (
              <motion.div
                className="max-w-3xl space-y-4"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
              >
                <div className="rf-card p-4 flex items-center justify-between gap-6">
                  <div>
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Launch plan</div>
                    <div className="text-xl font-black text-[var(--rf-brand)] capitalize mt-0.5">{tier}</div>
                    <div className="text-[12px] text-[var(--rf-text-tertiary)] mt-1">Refinely is launching with a single paid Standard tier and a 30-day Marketplace trial.</div>
                  </div>
                  <div className="flex-1 max-w-xs space-y-1.5">
                    <div className="flex justify-between text-[13px] font-semibold text-[var(--rf-text-secondary)]">
                      <span>Included generations this month</span>
                      <span>{usage?.currentMonth ?? 0}<span className="text-[var(--rf-text-tertiary)] font-medium"> / {limits?.generationsPerMonth === -1 ? '∞' : limits?.generationsPerMonth ?? 0}</span></span>
                    </div>
                    {limits?.generationsPerMonth !== -1 && (
                      <div className="w-full h-1.5 bg-[var(--rf-surface-soft)] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[var(--rf-brand)] transition-all duration-500 rounded-full"
                          style={{ width: usage ? `${Math.min(100, (usage.currentMonth / (limits?.generationsPerMonth || 1)) * 100)}%` : '0%' }}
                        />
                      </div>
                    )}
                  </div>
                </div>

                <div className="rf-card p-4 flex items-start justify-between gap-4">
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Need more headroom?</div>
                    <div className="text-sm font-semibold text-[var(--rf-text)]">Larger teams can contact support for a higher soft threshold and early access to advanced packaging.</div>
                    <div className="text-[12px] text-[var(--rf-text-tertiary)]">We are keeping the launch offer simple, then expanding into larger-organization controls based on customer demand.</div>
                  </div>
                  <a
                    href="mailto:support@smartif.ai?subject=Refinely%20Advanced%20Tier%20Inquiry"
                    className="shrink-0 inline-flex items-center justify-center rounded-lg border border-[var(--rf-text)] bg-[var(--rf-text)] px-3 py-2 text-[12px] font-bold text-white transition hover:bg-black"
                  >
                    Contact support
                  </a>
                </div>

                <div className="rf-card p-4 space-y-4">
                  <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Usage</div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {[
                      { label: 'Generations', value: usage?.currentMonth ?? 0, sub: `included ${limits?.generationsPerMonth === -1 ? '∞' : limits?.generationsPerMonth ?? 0} before warning` },
                      { label: 'Tokens', value: workspaceTokenUsage.toLocaleString(), sub: 'approx.' },
                      { label: 'Projects', value: configuredProjectCount, sub: 'configured' },
                      { label: 'Records', value: transparencyReports.length + complianceEvents.length, sub: 'audit + transparency' },
                    ].map(card => (
                      <div key={card.label} className="rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-2.5">
                        <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">{card.label}</div>
                        <div className="mt-1 text-xl font-black text-[var(--rf-text)]">{card.value}</div>
                        <div className="mt-0.5 text-[12px] text-[var(--rf-text-tertiary)]">{card.sub}</div>
                      </div>
                    ))}
                  </div>

                  <div className="rounded-xl border border-[var(--rf-border)] overflow-hidden">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] px-3 py-2 bg-[var(--rf-surface-soft)] border-b border-[var(--rf-border)]">Per-project usage</div>
                    {projectUsageBreakdown.length ? (
                      <div className="divide-y divide-[var(--rf-border)] bg-white">
                        <div className="grid grid-cols-[1fr_60px_80px_minmax(0,1fr)] gap-3 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] bg-[var(--rf-surface-soft)]">
                          <div>Project</div><div className="text-right">Reports</div><div className="text-right">Tokens</div><div>Latest</div>
                        </div>
                        {projectUsageBreakdown.map(project => (
                          <div key={project.projectKey} className="grid grid-cols-[1fr_60px_80px_minmax(0,1fr)] gap-3 px-3 py-2 items-center">
                            <div className="text-sm font-bold text-[var(--rf-text)] truncate">{project.projectKey}</div>
                            <div className="text-sm text-[var(--rf-text-secondary)] text-right">{project.reportCount}</div>
                            <div className="text-sm text-[var(--rf-text-secondary)] text-right">{project.tokenUsage.toLocaleString()}</div>
                            <div className="text-[12px] text-[var(--rf-text-tertiary)] truncate">{project.latestAt ? new Date(project.latestAt).toLocaleString() : 'n/a'}</div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="bg-white px-4 py-4 text-sm font-medium text-[var(--rf-text-tertiary)]">
                        No transparency reports have been loaded yet, so project-level usage cannot be approximated.
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {[
                    { key: 'standard', name: 'Standard', price: 'Marketplace launch tier', highlights: ['Full core workflow', 'Shared workspace setup', 'Soft monthly usage guidance'], cta: 'Included in trial', href: 'https://marketplace.atlassian.com' },
                    { key: 'advanced', name: 'Advanced', price: 'Later / contact us', highlights: ['Higher limits', 'Larger-team controls', 'Priority roadmap input'], cta: 'Talk to support', href: 'mailto:support@smartif.ai?subject=Refinely%20Advanced%20Tier%20Inquiry' },
                  ].map(plan => {
                    const isCurrent = plan.key === 'standard' && tier === 'standard';
                    return (
                      <div key={plan.key} className={`rounded-xl border bg-white p-4 flex flex-col shadow-sm transition-all ${isCurrent ? 'border-[var(--rf-brand)] shadow-sm shadow-[var(--rf-brand)]/10' : 'border-[var(--rf-border)] hover:border-[var(--rf-border-strong)]'}`}>
                        <div className="mb-3">
                          <div className="flex items-center justify-between gap-1">
                            <div className={`text-sm font-black ${isCurrent ? 'text-[var(--rf-brand)]' : 'text-[var(--rf-text)]'}`}>{plan.name}</div>
                            {isCurrent && <span className="bg-[var(--rf-brand-muted)] text-[var(--rf-brand)] text-[11px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border border-[rgba(43,89,74,0.12)]">Active</span>}
                          </div>
                          <div className="text-[12px] text-[var(--rf-text-tertiary)] mt-0.5">{plan.price}</div>
                        </div>
                        <ul className="space-y-1.5 mb-4 flex-1">
                          {plan.highlights.map(item => (
                            <li key={item} className="text-[12px] font-medium text-[var(--rf-text-secondary)] flex items-start gap-1.5">
                              <Check className="w-3 h-3 text-[var(--rf-success)] shrink-0 mt-0.5" />
                              {item}
                            </li>
                          ))}
                        </ul>
                        <a
                          href={plan.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`mt-auto inline-flex w-full items-center justify-center rounded-lg border px-2 py-1.5 text-[12px] font-bold transition ${
                            isCurrent
                              ? 'border-[var(--rf-border)] bg-[var(--rf-surface-soft)] text-[var(--rf-text-secondary)]'
                              : 'border-[var(--rf-text)] bg-[var(--rf-text)] text-white hover:bg-black'
                          }`}
                        >
                          {isCurrent ? 'Manage' : plan.cta}
                        </a>
                      </div>
                    );
                  })}
                </div>

                <div className="rf-card p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Company branding</div>
                    <span className="text-[12px] font-bold px-2 py-0.5 rounded border bg-[var(--rf-surface-soft)] text-[var(--rf-text-tertiary)] border-[var(--rf-border)]">
                      Advanced later
                    </span>
                  </div>
                  <div className="flex gap-3 items-start">
                    <div className="flex-1 space-y-1.5">
                      <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Logo URL</label>
                      <input
                        value={brandingLogoUrl}
                        onChange={e => setBrandingLogoUrl(e.target.value)}
                        placeholder="https://example.com/logo.svg"
                        disabled
                        className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none disabled:opacity-60"
                      />
                    </div>
                    <div className="w-20 h-14 rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] flex items-center justify-center shrink-0">
                      {brandingLogoUrl.trim() ? (
                        <img src={brandingLogoUrl.trim()} alt="Logo preview" className="max-h-12 max-w-full object-contain" />
                      ) : (
                        <Image className="w-5 h-5 text-[var(--rf-text-tertiary)]" />
                      )}
                    </div>
                  </div>
                </div>

                <div className="rf-card p-4 space-y-3 relative overflow-hidden group">
                  <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Compliance</div>
                   
                  {/* Gating Overlay */}
                  <div className="absolute inset-0 z-20 bg-[var(--rf-surface-soft)]/60 backdrop-blur-[1px] flex flex-col items-center justify-center p-6 text-center transition-all group-hover:bg-[var(--rf-surface-soft)]/80 cursor-not-allowed">
                    <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center shadow-lg mb-3 border border-[var(--rf-border)]">
                      <ShieldCheck className="w-5 h-5 text-[var(--rf-brand)]" />
                    </div>
                    <div className="text-sm font-bold text-[var(--rf-text)]">Compliance controls</div>
                    <div className="text-[11px] font-bold text-[var(--rf-brand)] uppercase tracking-wider mt-1 bg-[var(--rf-brand-muted)] px-2 py-0.5 rounded border border-[rgba(43,89,74,0.1)]">Available in Advanced Edition</div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 opacity-20 pointer-events-none filter blur-[1px]">
                    {[
                      { key: 'enabled', label: 'Compliance mode', value: complianceEnabled, set: setComplianceEnabled },
                      { key: 'transparency', label: 'Transparency reports', value: transparencyEnabled, set: setTransparencyEnabled },
                      { key: 'pii', label: 'PII masking', value: piiMaskingEnabled, set: setPiiMaskingEnabled },
                      { key: 'audit', label: 'Immutable audit trail', value: auditTrailEnabled, set: setAuditTrailEnabled },
                    ].map(item => (
                      <label key={item.key} className="flex items-center justify-between rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-2.5">
                        <span className="text-sm font-medium text-[var(--rf-text-secondary)]">{item.label}</span>
                        <input
                          type="checkbox"
                          checked={item.value}
                          readOnly
                          className="h-4 w-4 rounded border-[var(--rf-border-strong)] text-[var(--rf-brand)] focus:ring-[var(--rf-brand)]"
                        />
                      </label>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === 'compliance' && (
              <motion.div
                className="max-w-3xl space-y-4"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
              >
                <div className="rf-card p-4 space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Compliance workspace</div>
                      <div className="mt-1 text-sm font-bold text-[var(--rf-text)]">Visibility into masking, reports, and audit activity</div>
                      <p className="mt-1 text-[13px] text-[var(--rf-text-tertiary)]">
                        This section stays visible even before compliance is fully enabled so admins can see what is configured, what evidence exists, and what will start populating after the next run.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { label: 'Compliance', value: complianceEnabled },
                        { label: 'Transparency', value: transparencyEnabled },
                        { label: 'PII masking', value: piiMaskingEnabled },
                        { label: 'Audit trail', value: auditTrailEnabled },
                      ].map((item) => (
                        <span key={item.label} className={`rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-widest ${item.value ? 'border-[rgba(43,89,74,0.16)] bg-[var(--rf-brand-muted)] text-[var(--rf-brand)]' : 'border-[var(--rf-border)] bg-[var(--rf-surface-soft)] text-[var(--rf-text-tertiary)]'}`}>
                          {item.label}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Summary cards */}
                {complianceSummary && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {[
                      {
                        label: 'AI Operations',
                        value: Object.values(complianceSummary.totalByTurnType).reduce((s, v) => s + v, 0),
                        sub: Object.entries(complianceSummary.totalByTurnType).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'none',
                      },
                      {
                        label: 'PII Redactions',
                        value: Object.values(complianceSummary.piiRedactionsByType).reduce((s, v) => s + v, 0),
                        sub: Object.entries(complianceSummary.piiRedactionsByType).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'none',
                      },
                      {
                        label: 'Tokens Used',
                        value: complianceSummary.totalTokens.toLocaleString(),
                        sub: 'approximate total',
                      },
                      {
                        label: 'Top Model',
                        value: Object.entries(complianceSummary.modelUsage).sort((a, b) => b[1] - a[1])[0]?.[0]?.split('/').pop()?.slice(0, 16) ?? 'n/a',
                        sub: `${Object.entries(complianceSummary.modelUsage).sort((a, b) => b[1] - a[1])[0]?.[1] ?? 0} calls`,
                      },
                    ].map((card) => (
                      <div key={card.label} className="rf-card px-3 py-2.5">
                        <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">{card.label}</div>
                        <div className="mt-1 text-lg font-black text-[var(--rf-text)] truncate">{card.value}</div>
                        <div className="mt-0.5 text-[11px] text-[var(--rf-text-tertiary)] truncate">{card.sub}</div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="rf-card p-4 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">PII masking proof</div>
                      <div className="mt-1 text-sm font-bold text-[var(--rf-text)]">Preview how Refinely masks supported PII categories</div>
                    </div>
                    <div className="text-[12px] font-medium text-[var(--rf-text-tertiary)]">
                      {piiPreviewResult.totalRedactions} redaction{piiPreviewResult.totalRedactions === 1 ? '' : 's'}
                    </div>
                  </div>
                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="space-y-2">
                      <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Sample input</div>
                      <textarea
                        value={piiPreviewInput}
                        onChange={(e) => setPiiPreviewInput(e.target.value)}
                        className="min-h-[160px] w-full rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-3 text-sm font-medium text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand)]/20"
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Masked output</div>
                      <div className="min-h-[160px] rounded-xl border border-[var(--rf-border)] bg-white px-3 py-3 text-sm text-[var(--rf-text-secondary)] whitespace-pre-wrap">
                        {compactUiText(piiPreviewResult.text || 'Masked output will appear here.')}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(piiPreviewResult.byType).length > 0 ? Object.entries(piiPreviewResult.byType).map(([key, value]) => (
                      <span key={key} className="rounded-full border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-1 text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-secondary)]">
                        {key}: {value}
                      </span>
                    )) : (
                      <span className="text-[13px] text-[var(--rf-text-tertiary)]">No supported PII types detected in the current sample.</span>
                    )}
                  </div>
                  <p className="text-[12px] text-[var(--rf-text-tertiary)]">
                    Current masking coverage includes email, phone numbers, IBANs, payment cards, and SSNs. Use the transparency reports below for per-run evidence once new runs are executed.
                  </p>
                </div>

                {/* Transparency Reports */}
                <div className="rf-card p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Transparency reports ({transparencyReports.length})</div>
                    <div className="flex items-center gap-2">
                      <Filter className="w-3 h-3 text-[var(--rf-text-tertiary)]" />
                      <select value={reportFilterTurnType} onChange={e => setReportFilterTurnType(e.target.value)} className="appearance-none bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded px-2 py-1 text-[12px] font-medium text-[var(--rf-text)] outline-none">
                        <option value="">All actions</option>
                        {(['generate', 'clarify', 'refine', 'ask'] as const).map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <select value={reportFilterProject} onChange={e => setReportFilterProject(e.target.value)} className="appearance-none bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded px-2 py-1 text-[12px] font-medium text-[var(--rf-text)] outline-none">
                        <option value="">All projects</option>
                        {[...new Set(transparencyReports.map(r => r.projectKey || 'Workspace'))].map(pk => <option key={pk} value={pk}>{pk}</option>)}
                      </select>
                    </div>
                  </div>
                  {(() => {
                    const filtered = transparencyReports.filter(r => {
                      if (reportFilterTurnType && r.turnType !== reportFilterTurnType) return false;
                      if (reportFilterProject && (r.projectKey || 'Workspace') !== reportFilterProject) return false;
                      return true;
                    });
                    if (filtered.length === 0) return <div className="text-sm text-[var(--rf-text-tertiary)]">No reports match the current filters.</div>;
                    return (
                      <div className="rounded-xl border border-[var(--rf-border)] overflow-hidden">
                        <div className="grid grid-cols-[minmax(0,1fr)_70px_80px_60px_50px] gap-2 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] bg-[var(--rf-surface-soft)] border-b border-[var(--rf-border)]">
                          <div>Date</div><div>Action</div><div>Project</div><div className="text-right">Tokens</div><div className="text-right">PII</div>
                        </div>
                        <div className="divide-y divide-[var(--rf-border)] bg-white max-h-80 overflow-y-auto">
                          {filtered.map(report => (
                            <div key={report.reportId}>
                              <button
                                className="w-full grid grid-cols-[minmax(0,1fr)_70px_80px_60px_50px] gap-2 px-3 py-2 text-left hover:bg-[var(--rf-surface-soft)] transition items-center"
                                onClick={() => setExpandedReportId(expandedReportId === report.reportId ? null : report.reportId)}
                              >
                                <div className="text-[12px] text-[var(--rf-text-tertiary)] truncate">{new Date(report.createdAt).toLocaleString()}</div>
                                <div className="text-[12px] font-bold text-[var(--rf-text)] uppercase">{report.turnType}</div>
                                <div className="text-[12px] text-[var(--rf-text-secondary)] truncate">{report.projectKey || 'Workspace'}</div>
                                <div className="text-[12px] text-right text-[var(--rf-text-secondary)]">{(report.tokenUsage?.total ?? 0).toLocaleString()}</div>
                                <div className="text-[12px] text-right text-[var(--rf-text-secondary)]">{report.piiMasking?.totalRedactions ?? 0}</div>
                              </button>
                              {expandedReportId === report.reportId && (
                                <div className="px-4 pb-3 pt-1 bg-[var(--rf-surface-soft)] border-t border-[var(--rf-border)] space-y-2">
                                  {report.model && <div className="text-[12px] text-[var(--rf-text-tertiary)]">Model: <span className="font-semibold text-[var(--rf-text)]">{report.model}</span>{report.provider ? ` (${report.provider})` : ''}</div>}
                                  {report.requirementExcerpt && <div className="text-[12px] text-[var(--rf-text-tertiary)]">Requirement: <span className="italic">{report.requirementExcerpt}</span></div>}
                                  {report.decisionSummary?.length > 0 && (
                                    <div>
                                      <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-1">Decisions</div>
                                      <ul className="space-y-0.5">
                                        {report.decisionSummary.map((d, i) => <li key={i} className="text-[12px] text-[var(--rf-text-secondary)] flex gap-1.5"><span className="text-[var(--rf-brand)] mt-0.5">·</span>{d}</li>)}
                                      </ul>
                                    </div>
                                  )}
                                  {report.piiMasking?.byType && Object.keys(report.piiMasking.byType).length > 0 && (
                                    <div className="text-[12px] text-[var(--rf-text-tertiary)]">PII by type: {Object.entries(report.piiMasking.byType).map(([k, v]) => `${k}: ${v}`).join(', ')}</div>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* Audit Trail */}
                <div className="rf-card p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Audit trail ({complianceEvents.length})</div>
                    <div className="flex items-center gap-2">
                      <select value={auditCategoryFilter} onChange={e => setAuditCategoryFilter(e.target.value as any)} className="appearance-none rounded border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-2 py-1 text-[12px] font-medium text-[var(--rf-text)] outline-none">
                        {(['runtime', 'config', 'security', 'prompt', 'all'] as const).map(category => (
                          <option key={category} value={category}>{category === 'all' ? 'All categories' : category}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => setShowAllAuditEvents(prev => !prev)}
                        className="rounded border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-2 py-1 text-[12px] font-bold text-[var(--rf-text-secondary)] transition hover:bg-white"
                      >
                        {showAllAuditEvents ? 'Refinely only' : 'Show all events'}
                      </button>
                    </div>
                  </div>
                  {complianceEvents.length === 0 ? (
                    <div className="text-sm text-[var(--rf-text-tertiary)]">No audit events yet. Enable the immutable audit trail in the Billing tab.</div>
                  ) : (
                    <div className="rounded-xl border border-[var(--rf-border)] overflow-hidden">
                      <div className="grid grid-cols-[minmax(0,1.2fr)_70px_minmax(0,1fr)_40px] gap-2 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] bg-[var(--rf-surface-soft)] border-b border-[var(--rf-border)]">
                        <div>Timestamp</div><div>Category</div><div>Action</div><div className="text-center">Chain</div>
                      </div>
                      <div className="divide-y divide-[var(--rf-border)] bg-white max-h-80 overflow-y-auto">
                        {complianceEvents
                          .filter((event) => showAllAuditEvents || event.category === 'runtime')
                          .filter((event) => auditCategoryFilter === 'all' || event.category === auditCategoryFilter)
                          .map(event => (
                          <div key={event.eventId}>
                            <button
                              className="w-full grid grid-cols-[minmax(0,1.2fr)_70px_minmax(0,1fr)_40px] gap-2 px-3 py-2 text-left hover:bg-[var(--rf-surface-soft)] transition items-center"
                              onClick={() => setExpandedAuditId(expandedAuditId === event.eventId ? null : event.eventId)}
                            >
                              <div className="text-[12px] text-[var(--rf-text-tertiary)] truncate">{new Date(event.timestamp).toLocaleString()}</div>
                              <div className="text-[12px] font-bold uppercase text-[var(--rf-text-secondary)]">{event.category}</div>
                              <div className="text-[12px] text-[var(--rf-text)] truncate">{event.action.replace(/_/g, ' ').toLowerCase()}</div>
                              <div className="text-center" title={event.hash ? 'Hash present' : 'No hash'}>
                                {event.hash ? <Check className="w-3.5 h-3.5 text-[var(--rf-success)] mx-auto" /> : <AlertCircle className="w-3.5 h-3.5 text-[var(--rf-text-tertiary)] mx-auto" />}
                              </div>
                            </button>
                            {expandedAuditId === event.eventId && (
                              <div className="px-4 pb-3 pt-1 bg-[var(--rf-surface-soft)] border-t border-[var(--rf-border)] space-y-1.5">
                                {event.actorAccountId && <div className="text-[12px] text-[var(--rf-text-tertiary)]">Actor: <span className="font-mono text-[var(--rf-text)]">{event.actorAccountId.slice(0, 8)}…</span></div>}
                                {Object.keys(event.details ?? {}).length > 0 && (
                                  <div className="text-[12px] text-[var(--rf-text-tertiary)]">Details: {Object.entries(event.details).map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</div>
                                )}
                                <div className="text-[11px] font-mono text-[var(--rf-text-tertiary)] truncate">hash: {event.hash}</div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                      <div className="px-3 py-1.5 bg-[var(--rf-surface-soft)] border-t border-[var(--rf-border)] text-[11px] text-[var(--rf-text-tertiary)]">
                        Use the category filter to review runtime, config, security, or prompt events. Toggle “Show all events” to include non-runtime records.
                      </div>
                    </div>
                  )}
                </div>

                {/* Project breakdown */}
                {complianceSummary && complianceSummary.projectBreakdown.length > 0 && (
                  <div className="rf-card p-4 space-y-3">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Project breakdown</div>
                    <div className="rounded-xl border border-[var(--rf-border)] overflow-hidden">
                      <div className="grid grid-cols-[1fr_60px_80px_minmax(0,1fr)] gap-3 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] bg-[var(--rf-surface-soft)]">
                        <div>Project</div><div className="text-right">Ops</div><div className="text-right">Tokens</div><div>Latest</div>
                      </div>
                      <div className="divide-y divide-[var(--rf-border)] bg-white">
                        {complianceSummary.projectBreakdown.map(p => (
                          <div key={p.projectKey} className="grid grid-cols-[1fr_60px_80px_minmax(0,1fr)] gap-3 px-3 py-2 items-center">
                            <div className="text-sm font-bold text-[var(--rf-text)] truncate">{p.projectKey}</div>
                            <div className="text-sm text-[var(--rf-text-secondary)] text-right">{p.count}</div>
                            <div className="text-sm text-[var(--rf-text-secondary)] text-right">{p.tokenUsage.toLocaleString()}</div>
                            <div className="text-[12px] text-[var(--rf-text-tertiary)] truncate">{p.latestAt ? new Date(p.latestAt).toLocaleString() : 'n/a'}</div>
                          </div>
                        ))}
                      </div>
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
  projects, customFields, arMappings, setArMappings, domainContexts, setDomainContexts,
  backlogStatusScopes, setBacklogStatusScopes, backlogStatusOptions, detectDefaultStatuses,
  activeArProj, isAdmin, isProjectAdmin,
  backlogCacheInfo, backlogDiagnostics, backlogRefreshStatus, isRefreshingBacklogCache, onRefreshBacklogCache,
  backlogThemeBudgetOverride, onBacklogThemeBudgetOverrideChange,
}: any) {
const [issueTypes, setIssueTypes] = useState<any[]>([]);
  const [activeIssueType, setActiveIssueType] = useState<string>('*');
  const [isLoadingIssueTypes, setIsLoadingIssueTypes] = useState(false);

  useEffect(() => {
    let active = true;
    if (!activeArProj || activeArProj === '*') {
      setIssueTypes([]);
      setActiveIssueType('*');
      return;
    }
    setIsLoadingIssueTypes(true);
    api.discoverIssueTypes(activeArProj)
       .then((res: any) => {
         if(active) {
           setIssueTypes(res.issueTypes || []);
         }
       })
       .finally(() => { if(active) setIsLoadingIssueTypes(false); });
    return () => { active = false; };
  }, [activeArProj]);

  const currentMapping = useMemo(() => {
    const existing = arMappings.find((m: any) => m.projectKey === activeArProj && ((m.issueType || '*') === activeIssueType));
    if (existing) return normalizeProjectArMapping(existing);
    
    const fallback = arMappings.find((m: any) => m.projectKey === activeArProj && (!m.issueType || m.issueType === '*'));
    return normalizeProjectArMapping({ ...(fallback || {}), projectKey: activeArProj, issueType: activeIssueType });
  }, [arMappings, activeArProj, activeIssueType]);

  const updateMapping = (p: any) => {
    const idx = arMappings.findIndex((m: any) => m.projectKey === activeArProj && ((m.issueType || '*') === activeIssueType));
    const upd = normalizeProjectArMapping({ ...currentMapping, ...p, projectKey: activeArProj, issueType: activeIssueType });
    if (idx >= 0) { const l = [...arMappings]; l[idx] = upd; setArMappings(l); }
    else setArMappings([...arMappings, upd]);
  };

  const projectFields = useMemo(() => {
    if (activeIssueType === '*') {
      const seen = new Set<string>();
      const all: any[] = [];
      issueTypes.forEach(it => {
        Object.values(it.fields || {}).forEach((f: any) => {
          if (!seen.has(f.id)) { seen.add(f.id); all.push(f); }
        });
      });
      return all.length > 0 ? all : customFields;
    } else {
      const it = issueTypes.find(t => t.id === activeIssueType);
      if (!it || !it.fields) return customFields;
      return Object.entries(it.fields).map(([key, val]: any) => ({
        id: key,
        name: val.name,
        custom: val.custom
      }));
    }
  }, [issueTypes, activeIssueType, customFields]);
  const currentContext = domainContexts.find((c: any) => c.projectKey === activeArProj) || { projectKey: activeArProj, context: '', personaRoles: [] };
  const currentPersonaRoles: RoleGuidanceRow[] = currentContext.personaRoles?.length
    ? currentContext.personaRoles
    : [{ role: '', activities: '' }];
  const currentBacklogScope = backlogStatusScopes.find((scope: any) => scope.projectKey === activeArProj) || { projectKey: activeArProj, statuses: [] };
  const effectiveBacklogStatuses = currentBacklogScope.statuses.length
    ? currentBacklogScope.statuses
    : detectDefaultStatuses(backlogStatusOptions);
  const indexedCount = useMemo(() => {
    if (backlogCacheInfo?.issueCount && backlogCacheInfo.issueCount > 0) return backlogCacheInfo.issueCount;
    if (backlogDiagnostics?.matchingScopeIssues !== undefined && backlogDiagnostics.matchingScopeIssues > 0) return backlogDiagnostics.matchingScopeIssues;
    if (backlogDiagnostics?.totalProjectIssues !== undefined && backlogDiagnostics.totalProjectIssues > 0) return backlogDiagnostics.totalProjectIssues;
    if (backlogCacheInfo?.issueCount !== undefined) return backlogCacheInfo.issueCount;
    if (backlogDiagnostics?.matchingScopeIssues !== undefined) return backlogDiagnostics.matchingScopeIssues;
    if (backlogDiagnostics?.totalProjectIssues !== undefined) return backlogDiagnostics.totalProjectIssues;
    return 0;
  }, [backlogCacheInfo, backlogDiagnostics]);
  const updateContext = (patch: Partial<ProjectDomainContextRow>) => {
    const idx = domainContexts.findIndex((c: any) => c.projectKey === activeArProj);
    const nextRoles = coerceRoleGuidanceRows(
      Array.isArray(patch.personaRoles) ? patch.personaRoles : (currentContext.personaRoles ?? []),
      { trimFields: false, includeBlankFallback: false },
    );
    const upd: ProjectDomainContextRow = {
      projectKey: activeArProj,
      context: String(patch.context ?? currentContext.context ?? ''),
      personaRoles: nextRoles,
    };
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
  const [projectNotice, setProjectNotice] = useState<string | null>(null);
  const [isInferringPersonaRoles, setIsInferringPersonaRoles] = useState(false);
  const [roleInferenceResult, setRoleInferenceResult] = useState<InferProjectPersonaRolesResult | null>(null);
  const [selectedRoleSuggestionKeys, setSelectedRoleSuggestionKeys] = useState<string[]>([]);
  const [expandedSections, setExpandedSections] = useState({
    backlog: true,
    guidance: true,
    mapping: false,
  });

  const toggleSection = (section: 'backlog' | 'guidance' | 'mapping') => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  useEffect(() => {
    setRoleInferenceResult(null);
    setSelectedRoleSuggestionKeys([]);
  }, [activeArProj]);

  const inferButtonDisabled = !activeArProj || activeArProj === '*' || isInferringPersonaRoles || indexedCount <= 0;

  const handleSuggestPersonaRoles = async () => {
    if (inferButtonDisabled) return;
    setIsInferringPersonaRoles(true);
    setProjectNotice(null);
    try {
      const response = await api.inferProjectPersonaRoles(activeArProj) as InferProjectPersonaRolesResult;
      setRoleInferenceResult(response);
      setSelectedRoleSuggestionKeys(
        (response.suggestions ?? []).map((suggestion) => suggestion.role.trim().toLowerCase()),
      );
    } catch (error: any) {
      setRoleInferenceResult({
        success: false,
        suggestions: [],
        sampledIssueCount: 0,
        sampledIssueKeys: [],
        usedCache: true,
        error: error?.message || 'Role suggestions could not be generated.',
      });
    } finally {
      setIsInferringPersonaRoles(false);
    }
  };

  const toggleRoleSuggestion = (role: string) => {
    const key = role.trim().toLowerCase();
    setSelectedRoleSuggestionKeys((current) => (
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key]
    ));
  };

  const handleAddSelectedRoleSuggestions = () => {
    const selectedSuggestions = (roleInferenceResult?.suggestions ?? []).filter((suggestion) => (
      selectedRoleSuggestionKeys.includes(suggestion.role.trim().toLowerCase())
    ));
    if (!selectedSuggestions.length) return;
    updateContext({
      personaRoles: mergeSuggestedPersonaRoles(currentContext.personaRoles ?? [], selectedSuggestions),
    });
    setProjectNotice(`Added ${selectedSuggestions.length} inferred role${selectedSuggestions.length === 1 ? '' : 's'} to the editable table. Save the project to persist them.`);
    setRoleInferenceResult(null);
    setSelectedRoleSuggestionKeys([]);
  };

  const handleSave = async () => {
    setIsSavingProject(true);
    setProjectNotice(null);
    try {
      if (isAdmin) {
        await api.patchConfig({
          backlogThemeBudgetOverride: normalizeOptionalPositiveInt(backlogThemeBudgetOverride),
        });
      }
      const saveRes = await api.saveProjectConfig({
        projectKey: activeArProj,
        arMapping: currentMapping,
        domainContext: currentContext,
        backlogStatuses: effectiveBacklogStatuses,
      });
      if ((saveRes as any)?.success === false) {
        throw new Error((saveRes as any)?.error || 'Project configuration could not be saved.');
      }
      setProjectNotice('Project configuration saved.');
    } catch (e: any) { alert(e.message); }
    finally { setIsSavingProject(false); }
  };

  const handleSaveAndRefresh = async () => {
    setIsSavingProject(true);
    setProjectNotice(null);
    try {
      if (isAdmin) {
        await api.patchConfig({
          backlogThemeBudgetOverride: normalizeOptionalPositiveInt(backlogThemeBudgetOverride),
        });
      }
      const saveRes = await api.saveProjectConfig({
        projectKey: activeArProj,
        arMapping: currentMapping,
        domainContext: currentContext,
        backlogStatuses: effectiveBacklogStatuses,
      });
      if ((saveRes as any)?.success === false) {
        throw new Error((saveRes as any)?.error || 'Project configuration could not be saved.');
      }
      setProjectNotice('Backlog cache rebuild queued. This can take a little while on larger projects.');
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
      <div style={{ display: 'none' }}>
        <button id="jira-save-target" onClick={handleSave} disabled={isSavingProject || isRefreshingBacklogCache} />
        <button id="jira-save-rebuild-target" onClick={handleSaveAndRefresh} disabled={isSavingProject || isRefreshingBacklogCache} />
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
               <div className="w-8 h-8 rounded-lg bg-[var(--rf-brand-muted)] flex items-center justify-center border border-[rgba(43,89,74,0.12)]"><Database className="w-4 h-4 text-[var(--rf-brand)]" /></div>
               <div>
                 <h5 className="text-sm font-bold text-[var(--rf-text)] flex items-center gap-2">
                   Backlog Context
                   <span className="rounded-md bg-[var(--rf-danger-subtle)] px-2 py-0.5 text-[13px] font-bold uppercase tracking-widest text-[var(--rf-danger)] border border-rose-100">Required</span>
                 </h5>
                 <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-0.5">Define Jira statuses for AI context.</p>
               </div>
             </div>
             <ChevronRight className={`w-5 h-5 text-[var(--rf-text-tertiary)] transition-transform ${expandedSections.backlog ? 'rotate-90' : ''}`} />
           </button>

           {expandedSections.backlog && (
           <div className="bg-[var(--rf-surface-soft)] rounded-xl p-5 border border-[var(--rf-border)] space-y-5">
             <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
               <div className="rf-card px-4 py-3 ">
                 <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Indexed Items</div>
                 <div className="mt-1 text-xl font-black text-[var(--rf-text)]">{indexedCount}</div>
                 <div className="mt-1 text-[13px] font-medium text-[var(--rf-text-tertiary)]">
                   {backlogCacheInfo?.issueCount !== undefined
                     ? 'Cache count from the latest rebuild.'
                     : 'Fallback from backlog diagnostics when cache metadata has not been refreshed yet.'}
                 </div>
               </div>
               <div className="rf-card px-4 py-3 ">
                 <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Shards</div>
                 <div className="mt-1 text-xl font-black text-[var(--rf-text)]">{backlogCacheInfo?.shardCount ?? 0}</div>
                 <div className="mt-1 text-[13px] font-medium text-[var(--rf-text-tertiary)]">
                   Lean cache slices sized for Forge storage.
                 </div>
               </div>
               <div className="rf-card px-4 py-3 ">
                 <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Themes</div>
                 <div className="mt-1 text-xl font-black text-[var(--rf-text)]">{backlogCacheInfo?.themeCount ?? 0}</div>
                 <div className="mt-1 text-[13px] font-medium text-[var(--rf-text-tertiary)]">
                   Adaptive shortlist index for retrieval.
                 </div>
               </div>
               <div className="rf-card px-4 py-3 ">
                 <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Last Built</div>
                 <div className="mt-1 text-sm font-bold text-[var(--rf-text-secondary)]">
                   {backlogCacheInfo?.builtAt ? new Date(backlogCacheInfo.builtAt).toLocaleString() : 'Not built yet'}
                 </div>
               </div>
               <div className="rf-card px-4 py-3 ">
                 <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Theme Index</div>
                 <div className="mt-1 text-sm font-bold text-[var(--rf-text-secondary)]">
                   {backlogCacheInfo?.themeBuiltAt ? new Date(backlogCacheInfo.themeBuiltAt).toLocaleString() : 'Not built yet'}
                 </div>
               </div>
               <div className="rf-card px-4 py-3 ">
               <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Status</div>
                 <div className="mt-1 text-sm font-bold text-[var(--rf-text-secondary)] flex items-center gap-1.5">
                   {isRefreshingBacklogCache || backlogRefreshStatus?.status === 'queued' || backlogRefreshStatus?.status === 'running'
                     ? <><RefreshCw className="w-4 h-4 animate-spin text-[var(--rf-brand)]"/> Rebuilding</>
                     : backlogCacheInfo?.stale
                       ? <><AlertCircle className="w-4 h-4 text-[var(--rf-warning)]"/> Needs refresh</>
                       : <><Check className="w-4 h-4 text-[var(--rf-success)]"/> Fresh</>}
                 </div>
                 {(backlogRefreshStatus?.status === 'queued' || backlogRefreshStatus?.status === 'running') && (
                   <div className="mt-2 text-[13px] font-medium text-[var(--rf-text-tertiary)]">
                     {backlogRefreshStatus.status === 'queued' ? 'Queued in the long-running refresh worker.' : 'Building shards and theme index in the background.'}
                   </div>
                 )}
                 {backlogRefreshStatus?.status === 'error' && (
                   <div className="mt-2 text-[13px] font-medium text-[var(--rf-danger)]">
                     {backlogRefreshStatus.error || 'Last rebuild attempt failed.'}
                   </div>
                 )}
                 {backlogCacheInfo?.legacyFallback && (
                   <div className="mt-2 text-[13px] font-bold uppercase tracking-widest text-[var(--rf-warning)]">Legacy cache fallback</div>
                 )}
               </div>
             </div>

             <div className="rf-card px-4 py-4 ">
               <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
                 <div className="space-y-1">
                   <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Adaptive Theme Budget</div>
                   <div className="text-sm font-bold text-[var(--rf-text)]">Optional override for large or unusual projects</div>
                   <div className="text-[13px] font-medium text-[var(--rf-text-tertiary)] max-w-xl">
                     Leave blank to use the adaptive default: <span className="font-bold text-[var(--rf-text-secondary)]">ceil(issueCount / 50)</span>, clamped between 24 and 120.
                   </div>
                 </div>
                 <div className="w-full md:w-56">
                   <input
                     type="number"
                     min={1}
                     max={120}
                     value={backlogThemeBudgetOverride}
                     onChange={(e) => onBacklogThemeBudgetOverrideChange(e.target.value)}
                     placeholder="Adaptive default"
                     disabled={!isAdmin}
                     className="w-full rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-3 text-sm font-bold text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand)]/20"
                   />
                   {!isAdmin && (
                     <div className="mt-2 text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">
                       Workspace admin only
                     </div>
                   )}
                 </div>
               </div>
             </div>

             <div className="space-y-3 pt-2">
               <div className="flex items-center justify-between">
                 <div className="text-sm font-bold text-[var(--rf-text)]">
                   {effectiveBacklogStatuses.length} status{effectiveBacklogStatuses.length === 1 ? '' : 'es'} in scope
                 </div>
                 <div className="flex gap-2">
                   <button onClick={() => updateBacklogStatuses(detectDefaultStatuses(backlogStatusOptions))} className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-brand)] hover:text-[var(--rf-brand-hover)] bg-[var(--rf-brand-muted)] px-2 py-1 rounded">Default</button>
                   <button onClick={() => updateBacklogStatuses(backlogStatusOptions.map((status: any) => status.name))} className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-brand)] hover:text-[var(--rf-brand-hover)] bg-[var(--rf-brand-muted)] px-2 py-1 rounded">All</button>
                 </div>
               </div>
               <div className="flex flex-wrap gap-2">
                 {backlogStatusOptions.map((status: any) => {
                   const selected = effectiveBacklogStatuses.includes(status.name);
                   return (
                     <button
                       key={status.name}
                       onClick={() => updateBacklogStatuses(selected ? effectiveBacklogStatuses.filter((item: string) => item !== status.name) : [...effectiveBacklogStatuses, status.name])}
                       className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${selected ? 'bg-[var(--rf-brand)] text-white border-[var(--rf-brand)] shadow-md shadow-[var(--rf-brand)]/20' : 'bg-white text-[var(--rf-text-secondary)] border-[var(--rf-border)] hover:border-[var(--rf-brand-subtle)]'}`}
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
                <div className="w-8 h-8 rounded-lg bg-[var(--rf-brand-muted)] flex items-center justify-center border border-[rgba(43,89,74,0.12)]"><Globe className="w-4 h-4 text-[var(--rf-brand)]" /></div>
                <div>
                  <h5 className="text-sm font-bold text-[var(--rf-text)] flex items-center gap-2">
                    Project Guidance
                    <span className="rounded-md bg-[var(--rf-surface-soft)] px-2 py-0.5 text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] border border-[var(--rf-border)]">Recommended</span>
                  </h5>
                  <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-0.5">Rules or context specific to this project.</p>
                </div>
              </div>
              <ChevronRight className={`w-5 h-5 text-[var(--rf-text-tertiary)] transition-transform ${expandedSections.guidance ? 'rotate-90' : ''}`} />
            </button>
            {expandedSections.guidance && (
              <div className="bg-[var(--rf-surface-soft)] rounded-xl p-5 border border-[var(--rf-border)] space-y-5">
                <div className="rf-card p-4  space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Project guidance</div>
                      <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-1">Use this for rules, defaults, and phrasing that should apply to this project only.</p>
                    </div>
                  </div>
                  <textarea value={currentContext.context} onChange={e => updateContext({ context: e.target.value })} placeholder="e.g. Ensure all stories include accessibility requirements..." className="w-full h-28 bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl p-4 text-sm font-medium outline-none focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition shadow-sm resize-none" />
                </div>

                <div className="rf-card p-4 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Persona roles</div>
                      <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-1">Define project-specific roles and the activities they commonly perform.</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleSuggestPersonaRoles}
                        disabled={inferButtonDisabled}
                        className="text-[12px] font-bold text-[var(--rf-brand)] bg-[var(--rf-brand-muted)] hover:bg-[var(--rf-brand-subtle)] disabled:opacity-50 disabled:cursor-not-allowed px-2.5 py-1 rounded-lg transition inline-flex items-center gap-1.5"
                      >
                        {isInferringPersonaRoles ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <BrainCircuit className="w-3.5 h-3.5" />}
                        Suggest from backlog
                      </button>
                      <button
                        type="button"
                        onClick={() => updateContext({ personaRoles: [...(currentContext.personaRoles ?? []), { role: '', activities: '' }] })}
                        className="text-[12px] font-bold text-[var(--rf-brand)] bg-[var(--rf-brand-muted)] hover:bg-[var(--rf-brand-subtle)] px-2.5 py-1 rounded-lg transition"
                      >
                        + Add row
                      </button>
                    </div>
                  </div>
                  {indexedCount <= 0 && (
                    <div className="rounded-xl border border-[var(--rf-border)] bg-white px-3 py-2.5 text-[13px] font-medium text-[var(--rf-text-tertiary)]">
                      Build backlog context first to infer roles from a broad cached backlog sample.
                    </div>
                  )}
                  {roleInferenceResult && (
                    <div className={`rounded-xl border px-4 py-4 space-y-3 ${roleInferenceResult.success ? 'border-[var(--rf-border)] bg-white' : 'border-[var(--rf-danger-subtle)] bg-[var(--rf-danger-subtle)]/35'}`}>
                      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                        <div>
                          <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Backlog suggestions</div>
                          <div className="mt-1 text-sm font-semibold text-[var(--rf-text)]">
                            Reviewed suggestions from {roleInferenceResult.sampledIssueCount} sampled backlog item{roleInferenceResult.sampledIssueCount === 1 ? '' : 's'} across the cached project backlog.
                          </div>
                          {(roleInferenceResult.message || roleInferenceResult.error) && (
                            <div className={`mt-1 text-[13px] font-medium ${roleInferenceResult.error ? 'text-[var(--rf-danger)]' : 'text-[var(--rf-text-tertiary)]'}`}>
                              {roleInferenceResult.error || roleInferenceResult.message}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setRoleInferenceResult(null);
                            setSelectedRoleSuggestionKeys([]);
                          }}
                          className="self-start rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-1.5 text-[12px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] transition hover:border-[var(--rf-border-strong)]"
                        >
                          Dismiss
                        </button>
                      </div>

                      {roleInferenceResult.suggestions.length > 0 && (
                        <>
                          <div className="space-y-2">
                            {roleInferenceResult.suggestions.map((suggestion) => {
                              const suggestionKey = suggestion.role.trim().toLowerCase();
                              const checked = selectedRoleSuggestionKeys.includes(suggestionKey);
                              const confidenceTone = suggestion.confidence === 'high'
                                ? 'bg-[var(--rf-success-subtle)] text-[var(--rf-success)]'
                                : suggestion.confidence === 'medium'
                                  ? 'bg-[var(--rf-warning-subtle)] text-[var(--rf-warning)]'
                                  : 'bg-[var(--rf-surface-soft)] text-[var(--rf-text-tertiary)]';
                              return (
                                <label key={suggestion.role} className="flex gap-3 rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-3 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggleRoleSuggestion(suggestion.role)}
                                    className="mt-1 h-4 w-4 rounded border-[var(--rf-border)] text-[var(--rf-brand)] focus:ring-[var(--rf-brand)]/20"
                                  />
                                  <div className="min-w-0 flex-1 space-y-1.5">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <div className="text-sm font-bold text-[var(--rf-text)]">{suggestion.role}</div>
                                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.16em] ${confidenceTone}`}>
                                        {suggestion.confidence}
                                      </span>
                                    </div>
                                    <div className="text-sm font-medium text-[var(--rf-text-secondary)]">{suggestion.activities}</div>
                                    {suggestion.evidenceIssueKeys.length > 0 && (
                                      <div className="text-[12px] font-medium text-[var(--rf-text-tertiary)]">
                                        Evidence: {suggestion.evidenceIssueKeys.join(', ')}
                                      </div>
                                    )}
                                  </div>
                                </label>
                              );
                            })}
                          </div>
                          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                            <div className="text-[12px] font-medium text-[var(--rf-text-tertiary)]">
                              {selectedRoleSuggestionKeys.length} selected. Added suggestions stay editable until you save the project.
                            </div>
                            <button
                              type="button"
                              onClick={handleAddSelectedRoleSuggestions}
                              disabled={selectedRoleSuggestionKeys.length === 0}
                              className="rounded-lg bg-[var(--rf-brand)] text-white px-3 py-2 text-[12px] font-bold uppercase tracking-widest transition hover:bg-[var(--rf-brand-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              Add selected
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                  <div className="rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] p-3 space-y-2.5">
                    <div className="space-y-3">
                      <div className="hidden md:grid md:grid-cols-[minmax(180px,220px)_1fr_auto] gap-3 px-1 text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">
                        <div>Role</div>
                        <div>Activities</div>
                        <div />
                      </div>
                      {currentPersonaRoles.map((row, index, allRows) => (
                        <div key={`project-role-${index}`} className="grid grid-cols-1 md:grid-cols-[minmax(160px,200px)_1fr_auto] gap-2.5 items-start rounded-xl border border-[var(--rf-border)] bg-white px-3 py-2.5">
                          <div className="space-y-1">
                            <div className="md:hidden text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Role</div>
                            <input
                              value={row.role}
                              onChange={e => updateContext({ personaRoles: allRows.map((item, idx) => idx === index ? { ...item, role: e.target.value } : item) })}
                              placeholder="Field Service Engineer"
                              className="w-full rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-2 text-sm font-semibold text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand)]/20"
                            />
                          </div>
                          <div className="space-y-1">
                            <div className="md:hidden text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Activities</div>
                            <textarea
                              value={row.activities}
                              onChange={e => updateContext({ personaRoles: allRows.map((item, idx) => idx === index ? { ...item, activities: e.target.value } : item) })}
                              placeholder="Schedules visits, checks service windows, and confirms completion."
                              className="min-h-[64px] w-full resize-none rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-2 text-sm font-medium text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand)]/20"
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => updateContext({ personaRoles: allRows.length === 1 ? [] : allRows.filter((_, idx) => idx !== index) })}
                            className="md:mt-1 rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-2 text-[12px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] transition hover:border-[var(--rf-danger-subtle)] hover:text-[var(--rf-danger)]"
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="rf-card p-4 flex items-center justify-between gap-4">
                  <div>
                    <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Issue link type</div>
                    <div className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-1">Used when issues created from this project are linked back to the source issue.</div>
                  </div>
                  <div className="relative w-44">
                    <select
                      value={currentMapping.issueLinkType || 'Relates to'}
                      onChange={e => updateMapping({ issueLinkType: e.target.value })}
                      className="appearance-none pr-6 w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] px-3 py-1.5 rounded-lg text-sm font-semibold text-[var(--rf-text)] focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none transition"
                    >
                      {['Relates to', 'Blocks', 'Clones', 'Duplicates'].map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                    <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--rf-text-tertiary)] pointer-events-none" />
                  </div>
                </div>
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
                    <span className="rounded-md bg-[var(--rf-surface-soft)] px-2 py-0.5 text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] border border-[var(--rf-border)]">Advanced</span>
                  </h5>
                  <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-0.5">Map where Acceptance Criteria go.</p>
                </div>
              </div>
              <ChevronRight className={`w-5 h-5 text-[var(--rf-text-tertiary)] transition-transform ${expandedSections.mapping ? 'rotate-90' : ''}`} />
            </button>
            {expandedSections.mapping && (
            <div className="bg-[var(--rf-surface-soft)] rounded-xl p-5 border border-[var(--rf-border)] space-y-5">
               <div className="rf-card p-4 ">
                 <div className="flex items-start justify-between gap-4">
                   <div>
                     <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Mapping</div>
                     <p className="mt-1 text-xs font-medium text-[var(--rf-text-tertiary)]">
                       Input and output mappings stay separate so admins can point generated content into the right fields without switching modes.
                     </p>
                   </div>
                 </div>
                 
                 <div className="flex flex-wrap items-center gap-3 mt-4">
                    <span className="text-[13px] font-bold text-[var(--rf-text)] pr-2">Issue Type Mapping:</span>
                    <div className="relative">
                      <select 
                        value={activeIssueType}
                        onChange={e => setActiveIssueType(e.target.value)}
                        className="appearance-none bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg text-[13px] font-semibold pl-3 pr-8 py-1.5 focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none"
                      >
                        <option value="*">General (All Types)</option>
                        {issueTypes.map((it: any) => (
                          <option key={it.id} value={it.id}>{it.name}</option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--rf-text-tertiary)] pointer-events-none" />
                    </div>
                    {isLoadingIssueTypes && <span className="text-xs text-[var(--rf-text-tertiary)] ml-2">Loading types...</span>}
                  </div>

                 <div className="mt-4 grid grid-cols-1 gap-4">
                   <FieldMappingEditor

                     title="Input mapping"
                     description="Fields used when reading or grounding existing Jira content."
                     mapping={currentMapping.inputMappings}
                     onChange={(next: ProjectFieldMapping) => updateMapping({ inputMappings: next })}
                     customFields={projectFields}
                   />
                   <FieldMappingEditor
                     title="Output mapping"
                     description="Fields used when writing generated content back to Jira."
                     mapping={currentMapping.outputMappings}
                     onChange={(next: ProjectFieldMapping) => updateMapping({ outputMappings: next })}
                     customFields={projectFields}
                   />
                 </div>
               </div>
            </div>
            )}
         </div>
      </div>
    </div>
  );
}

function normalizeFieldIds(fieldIds: Array<string | null | undefined> = []) {
  return [...new Set(fieldIds.map(id => id?.trim()).filter((id): id is string => Boolean(id)))];
}

function normalizeProjectDomainContext(raw: any): ProjectDomainContextRow {
  return {
    projectKey: raw?.projectKey || '*',
    context: String(raw?.context ?? '').trim(),
    personaRoles: normalizeRoleGuidanceRows(raw?.personaRoles ?? []).filter((row) => row.role || row.activities),
  };
}

function normalizeProjectArMapping(raw: any): ProjectArMapping {
  const legacyArFieldIds = normalizeFieldIds(
    raw?.mode === 'iterative'
      ? raw?.iterativeFieldIds
      : raw?.consolidatedFieldId
        ? [raw.consolidatedFieldId]
        : [],
  );
  const hasOutputArFieldIds = Boolean(raw?.outputMappings && Object.prototype.hasOwnProperty.call(raw.outputMappings, 'arFieldIds'));
  const hasInputArFieldIds = Boolean(raw?.inputMappings && Object.prototype.hasOwnProperty.call(raw.inputMappings, 'arFieldIds'));
  const outputArFieldIds = hasOutputArFieldIds
    ? normalizeFieldIds(raw?.outputMappings?.arFieldIds)
    : legacyArFieldIds;
  const inputArFieldIds = hasInputArFieldIds
    ? normalizeFieldIds(raw?.inputMappings?.arFieldIds)
    : outputArFieldIds;
  const outputMappings: ProjectFieldMapping = {
    summaryFieldId: raw?.outputMappings?.summaryFieldId || 'summary',
    descriptionFieldId: raw?.outputMappings?.descriptionFieldId || 'description',
    arFieldIds: outputArFieldIds,
  };
  const inputMappings: ProjectFieldMapping = {
    summaryFieldId: raw?.inputMappings?.summaryFieldId || 'summary',
    descriptionFieldId: raw?.inputMappings?.descriptionFieldId || 'description',
    arFieldIds: inputArFieldIds,
  };
  return {
    projectKey: raw?.projectKey || '*',
    issueType: raw?.issueType || '*',
    mode: outputMappings.arFieldIds.length > 1 ? 'iterative' : (raw?.mode || 'consolidated'),
    consolidatedFieldId: outputMappings.arFieldIds[0] || outputMappings.descriptionFieldId || 'description',
    iterativeFieldIds: outputMappings.arFieldIds,
    inputMappings,
    outputMappings,
    issueLinkType: raw?.issueLinkType || 'Relates to',
  };
}

function FieldMappingEditor({
  title,
  description,
  mapping,
  onChange,
  customFields,
}: {
  title: string;
  description: string;
  mapping: ProjectFieldMapping;
  onChange: (next: ProjectFieldMapping) => void;
  customFields: JiraField[];
}) {
  const selectableFieldIds = ['description', ...customFields.map(field => field.id)];

  const updateArField = (index: number, nextFieldId: string) => {
    const arFieldIds = [...mapping.arFieldIds];
    arFieldIds[index] = nextFieldId;
    onChange({ ...mapping, arFieldIds: normalizeFieldIds(arFieldIds) });
  };

  const addArField = () => {
    const nextFieldId = selectableFieldIds.find(fieldId => !mapping.arFieldIds.includes(fieldId));
    if (!nextFieldId) return;
    onChange({ ...mapping, arFieldIds: [...mapping.arFieldIds, nextFieldId] });
  };

  const removeArField = (index: number) => {
    onChange({ ...mapping, arFieldIds: mapping.arFieldIds.filter((_: string, idx: number) => idx !== index) });
  };

  return (
    <div className="rf-card p-5  space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">{title}</div>
          <p className="mt-1 text-xs font-medium text-[var(--rf-text-tertiary)]">{description}</p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-3">
          <div>
            <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Summary</div>
            <div className="text-sm font-bold text-[var(--rf-text-secondary)] mt-1">summary</div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-3">
          <div>
            <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Description</div>
            <div className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-0.5">Select the Jira field that should hold the narrative body.</div>
          </div>
          <FieldSelector
            value={mapping.descriptionFieldId}
            onChange={(fid: string) => onChange({ ...mapping, descriptionFieldId: fid })}
            customFields={customFields}
          />
        </div>

        <div className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] p-4 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Acceptance requirements</div>
              <div className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-0.5">Add one or more Jira fields where ARs should appear.</div>
            </div>
            <button
              type="button"
              onClick={addArField}
              disabled={selectableFieldIds.every(fieldId => mapping.arFieldIds.includes(fieldId))}
              className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-brand)] bg-[var(--rf-brand-muted)] hover:bg-[var(--rf-brand-subtle)] px-3 py-1.5 rounded-lg transition"
            >
              + Add field
            </button>
          </div>
          <div className="space-y-2">
            {mapping.arFieldIds.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--rf-border)] bg-white px-4 py-3 text-xs font-medium text-[var(--rf-text-tertiary)]">
                No AR fields selected yet.
              </div>
            ) : (
              mapping.arFieldIds.map((fid: string, i: number) => (
                <div key={`${title}-${i}`} className="flex items-center gap-3 bg-white p-2 rounded-xl border border-[var(--rf-border)]">
                  <span className="text-[13px] font-black text-[var(--rf-text-tertiary)] min-w-[24px] text-center">#{i + 1}</span>
                  <div className="flex-1">
                    <FieldSelector value={fid} onChange={(nextFieldId: string) => updateArField(i, nextFieldId)} customFields={customFields} />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeArField(i)}
                    className="p-1.5 text-[var(--rf-text-tertiary)] hover:text-[var(--rf-danger)] hover:bg-[var(--rf-danger-subtle)] rounded-md transition"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))
            )}
          </div>
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
                <span className="text-[13px] text-[var(--rf-text-tertiary)] font-mono shrink-0 ml-2">{f.id}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
