import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { 
  Database, BrainCircuit, Globe, X, RefreshCw, Save, CreditCard, ChevronLeft, ShieldCheck, BarChart3,
  Users, FileText, ChevronRight, Check, Trash, Layers, Zap, Info, AlertCircle, Image
} from 'lucide-react';
import { motion } from 'framer-motion';
import { api } from './hooks/useForge';
import type { ConcreteModelFamily, LlmModelCatalogByVendor, LlmModelCatalogEntry, LlmProvider } from './types';
import { REDACTED } from './types';
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
  mode: 'consolidated' | 'iterative';
  consolidatedFieldId: string;
  iterativeFieldIds: string[];
  inputMappings: ProjectFieldMapping;
  outputMappings: ProjectFieldMapping;
  issueLinkType?: string;
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
const AZURE_OPENAI_MODELS: Array<{ id: string; label: string }> = [];
const WI_ACCEPT = '.pdf,.xlsx,.xls,.csv,.eml,.txt,.md';
const ROLE_GUIDANCE_MARKER = '\n\n[[role-guidance]]\n';

function inferModelFamily(modelId: string): ConcreteModelFamily | undefined {
  const normalized = modelId.trim().toLowerCase();
  if (normalized.includes('flash')) return 'flash';
  if (normalized.startsWith('gpt-4.1') || normalized.startsWith('gpt-4o') || normalized.startsWith('o4') || normalized.includes('sonnet')) return normalized.includes('mini') ? 'lite' : 'flash';
  if (normalized.includes('lite') || normalized.includes('mini') || normalized.includes('nano') || normalized.includes('haiku')) return 'lite';
  if (normalized.includes('pro') || normalized.includes('opus') || normalized.startsWith('gpt-5') || normalized.startsWith('o1') || normalized.startsWith('o3')) return 'pro';
  return undefined;
}

function buildStaticCatalog(provider: LlmProvider): LlmModelCatalogEntry[] {
  if (provider === 'forge_llms') return CLAUDE_MODELS.map(model => ({ id: model.id, displayName: model.label, family: inferModelFamily(model.id), source: 'fallback' as const }));
  if (provider === 'gemini') return GEMINI_MODELS.map(model => ({ id: model.id, displayName: model.label, family: inferModelFamily(model.id), source: 'fallback' as const }));
  if (provider === 'openai') return OPENAI_MODELS.map(model => ({ id: model.id, displayName: model.label, family: inferModelFamily(model.id), source: 'fallback' as const }));
  return AZURE_OPENAI_MODELS.map(model => ({ id: model.id, displayName: model.label, family: inferModelFamily(model.id), source: 'fallback' as const }));
}

function getCatalogModelId(entry?: LlmModelCatalogEntry) {
  return entry?.deploymentName || entry?.id || '';
}

function getPreferredFamilyModel(entries: LlmModelCatalogEntry[], family: ConcreteModelFamily) {
  const preferred = entries.find(entry => entry.family === family && entry.isLatest)
    || entries.find(entry => entry.family === family);
  return getCatalogModelId(preferred);
}

function isLatestAlias(modelId: string) {
  return modelId.trim().toLowerCase().startsWith('latest');
}

function normalizeRoleGuidanceRows(rawRows: any[] = []): RoleGuidanceRow[] {
  const rows = rawRows
    .map((row: any) => {
      if (!row) return null;
      if (typeof row === 'string') return { role: row.trim(), activities: '' };
      const role = String(row.role ?? row.name ?? row.title ?? '').trim();
      const activities = String(row.activities ?? row.activity ?? row.description ?? row.context ?? '').trim();
      return { role, activities };
    })
    .filter((row: RoleGuidanceRow | null): row is RoleGuidanceRow => Boolean(row && (row.role || row.activities)));
  return rows.length ? rows : [{ role: '', activities: '' }];
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

function buildGuidanceContextPayload(baseContext: string, roleRows: RoleGuidanceRow[]) {
  const trimmedBase = baseContext.trim();
  const serializableRows = roleRows
    .map(row => ({ role: row.role.trim(), activities: row.activities.trim() }))
    .filter(row => row.role || row.activities);
  if (!serializableRows.length) return trimmedBase;
  return [trimmedBase, `${ROLE_GUIDANCE_MARKER}${JSON.stringify(serializableRows, null, 2)}`]
    .filter(Boolean)
    .join('\n');
}

export function SettingsView({ onClose, initialTab = 'models', initialProjectKey = '*' }: { onClose: () => void; initialTab?: 'models' | 'jira' | 'domain' | 'stats' | 'billing'; initialProjectKey?: string }) {
  const [activeTab, setActiveTab] = useState<'models' | 'jira' | 'domain' | 'stats' | 'billing'>(initialTab);
  const [isSaving, setIsSaving] = useState(false);

  // Models State
  const [provider, setProvider] = useState<LlmProvider>('forge_llms');
  const [decompositionModel, setDecompositionModel] = useState('claude-opus-4-6');
  const [arModel, setArModel] = useState('claude-opus-4-6');
  const [clarifyModel, setClarifyModel] = useState('claude-sonnet-4-5-20250929');
  const [evaluateModel, setEvaluateModel] = useState('claude-haiku-4-5-20251001');
  const [triageModel, setTriageModel] = useState('claude-haiku-4-5-20251001');
  const [refineModel, setRefineModel] = useState('claude-sonnet-4-5-20250929');
  const [themeModel, setThemeModel] = useState('claude-haiku-4-5-20251001');

  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [geminiBaseUrl, setGeminiBaseUrl] = useState('');
  const [existingGeminiApiKey, setExistingGeminiApiKey] = useState('');
  
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
  const [issueLinkType, setIssueLinkType] = useState('Relates to');
  const [projects, setProjects] = useState<JiraProject[]>([]);
  const [backlogStatusOptions, setBacklogStatusOptions] = useState<JiraStatus[]>([]);
  const [customFields, setCustomFields] = useState<JiraField[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [arMappings, setArMappings] = useState<ProjectArMapping[]>([]);
  const [backlogStatusScopes, setBacklogStatusScopes] = useState<ProjectBacklogStatusScope[]>([]);
  const [activeArProj, setActiveArProj] = useState(initialProjectKey); // Global context selector
  const [backlogCacheInfo, setBacklogCacheInfo] = useState<{ projectKey: string; builtAt?: string; issueCount: number; stale: boolean } | null>(null);
  const [backlogDiagnostics, setBacklogDiagnostics] = useState<BacklogDiagnostics | null>(null);
  const [isRefreshingBacklogCache, setIsRefreshingBacklogCache] = useState(false);

  // Domain State
  const [domainContext, setDomainContext] = useState('');
  const [roleGuidanceRows, setRoleGuidanceRows] = useState<RoleGuidanceRow[]>([{ role: '', activities: '' }]);
  const [tier, setTier] = useState<'free' | 'standard' | 'premium' | 'enterprise'>('free');
  const [complianceEnabled, setComplianceEnabled] = useState(false);
  const [transparencyEnabled, setTransparencyEnabled] = useState(false);
  const [piiMaskingEnabled, setPiiMaskingEnabled] = useState(false);
  const [auditTrailEnabled, setAuditTrailEnabled] = useState(false);
  const [complianceEvents, setComplianceEvents] = useState<ComplianceAuditEvent[]>([]);
  const [transparencyReports, setTransparencyReports] = useState<TransparencyReportRow[]>([]);
  const [jiraAuditRecords, setJiraAuditRecords] = useState<Array<Record<string, unknown>>>([]);
  const [brandingLogoUrl, setBrandingLogoUrl] = useState('');
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
  const workspaceTokenUsage = useMemo(() => {
    return transparencyReports.reduce((sum, report) => sum + (report.tokenUsage?.total ?? 0), 0);
  }, [transparencyReports]);

  const projectUsageBreakdown = useMemo(() => {
    const byProject = new Map<string, { projectKey: string; tokenUsage: number; reportCount: number; latestAt?: string }>();
    transparencyReports.forEach(report => {
      const key = report.projectKey || 'Workspace-wide';
      const current = byProject.get(key) ?? { projectKey: key, tokenUsage: 0, reportCount: 0, latestAt: undefined };
      current.reportCount += 1;
      current.tokenUsage += report.tokenUsage?.total ?? 0;
      if (!current.latestAt || (report.createdAt && report.createdAt > current.latestAt)) {
        current.latestAt = report.createdAt;
      }
      byProject.set(key, current);
    });
    return [...byProject.values()].sort((a, b) => b.tokenUsage - a.tokenUsage || b.reportCount - a.reportCount);
  }, [transparencyReports]);

  const loadBacklogCacheInfo = useCallback(async (projectKey: string) => {
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
  }, []);

  const loadBacklogDiagnostics = useCallback(async (projectKey: string) => {
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
  }, []);

  useEffect(() => {
    loadInitialConfig();
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
        if (gc.provider) setProvider(gc.provider);
        if (gc.decompositionModel) setDecompositionModel(gc.decompositionModel);
        if (gc.arModel) setArModel(gc.arModel);
        if (gc.clarifyModel) setClarifyModel(gc.clarifyModel);
        if (gc.evaluateModel) setEvaluateModel(gc.evaluateModel);
        if (gc.triageModel) setTriageModel(gc.triageModel);
        if (gc.refineModel) setRefineModel(gc.refineModel);
        if (gc.themeModel) setThemeModel(gc.themeModel);
        
        if (gc.geminiApiKey) setExistingGeminiApiKey(gc.geminiApiKey);
        if (gc.geminiBaseUrl) setGeminiBaseUrl(gc.geminiBaseUrl);
        if (gc.openaiApiKey) setExistingOpenaiApiKey(gc.openaiApiKey);
        if (gc.openaiBaseUrl) setOpenaiBaseUrl(gc.openaiBaseUrl);
        if (gc.azureOpenAIApiKey) setExistingAzureOpenAIApiKey(gc.azureOpenAIApiKey);
        if (gc.azureOpenAIBaseUrl) setAzureOpenAIBaseUrl(gc.azureOpenAIBaseUrl);
        if (gc.azureOpenAIApiVersion) setAzureOpenAIApiVersion(gc.azureOpenAIApiVersion);
        if (gc.modelCatalogs) setModelCatalogs(gc.modelCatalogs);

        const parsedContext = splitGuidanceContext(existingConfig.domainContext || '');
        setDomainContext(parsedContext.context);
        if (parsedContext.roleRows.length) {
          setRoleGuidanceRows(parsedContext.roleRows);
        } else if (Array.isArray(existingConfig.domainRoles) && existingConfig.domainRoles.length) {
          setRoleGuidanceRows(normalizeRoleGuidanceRows(existingConfig.domainRoles as any[]));
        }
        if (existingConfig.tier) setTier(existingConfig.tier);
        setComplianceEnabled(Boolean(existingConfig.compliance?.enabled));
        setTransparencyEnabled(Boolean(existingConfig.compliance?.transparencyReportsEnabled));
        setPiiMaskingEnabled(Boolean(existingConfig.compliance?.piiMaskingEnabled));
        setAuditTrailEnabled(Boolean(existingConfig.compliance?.auditTrailEnabled));
        if (existingConfig.wiConfig?.enabled !== undefined) setWiEnabled(existingConfig.wiConfig.enabled);
        if (existingConfig.issueLinkType) setIssueLinkType(existingConfig.issueLinkType);
        if (existingConfig.arMappings) setArMappings(existingConfig.arMappings.map((mapping: any) => normalizeProjectArMapping(mapping)));
        if (existingConfig.domainContexts) setDomainContexts(existingConfig.domainContexts);
        if (existingConfig.backlogStatusScopes) setBacklogStatusScopes(existingConfig.backlogStatusScopes);
        if (existingConfig.branding?.logoUrl !== undefined) setBrandingLogoUrl(existingConfig.branding.logoUrl || '');
        if (existingConfig.isAdmin !== undefined) setIsAdmin(existingConfig.isAdmin);
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
    } else {
      setBacklogCacheInfo(null);
      setBacklogDiagnostics(null);
    }
  }, [activeTab, activeArProj, loadBacklogCacheInfo, loadBacklogDiagnostics]);

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
    if (activeTab === 'jira' && activeArProj && activeArProj !== '*') {
      void loadWiDocs();
    } else {
      setWiDocs([]);
    }
  }, [activeTab, activeArProj, loadWiDocs]);

  async function handleWiFileDrop(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;
    const invalid = files.find(file => !['.pdf', '.xlsx', '.xls', '.csv', '.txt', '.md', '.eml'].some(ext => file.name.toLowerCase().endsWith(ext)));
    if (invalid) {
      setWiUploadError('Supported formats are PDF, Excel (.xlsx/.xls), CSV, TXT, Markdown, and EML.');
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
      await api.saveConfig({
        generatorConfig: {
          provider,
          decompositionModel,
          arModel,
          clarifyModel,
          refineModel,
          evaluateModel,
          triageModel,
          themeModel,
          maxTokens: 8192,
          geminiApiKey: geminiApiKey.trim() || existingGeminiApiKey || "",
          geminiBaseUrl: geminiBaseUrl.trim() || undefined,
          openaiApiKey: openaiApiKey.trim() || existingOpenaiApiKey || "",
          openaiBaseUrl: openaiBaseUrl.trim() || undefined,
          azureOpenAIApiKey: azureOpenAIApiKey.trim() || existingAzureOpenAIApiKey || "",
          azureOpenAIBaseUrl: azureOpenAIBaseUrl.trim() || undefined,
          azureOpenAIApiVersion: azureOpenAIApiVersion.trim() || undefined,
          modelCatalogs,
        },
        domainContext: buildGuidanceContextPayload(domainContext, roleGuidanceRows),
        domainContexts,
        domainRoles: roleGuidanceRows.map(row => row.role.trim()).filter(Boolean),
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
        issueLinkType,
        arMappings,
        backlogStatusScopes,
        tier,
      });
      if (geminiApiKey.trim()) setExistingGeminiApiKey(REDACTED);
      if (openaiApiKey.trim()) setExistingOpenaiApiKey(REDACTED);
      if (azureOpenAIApiKey.trim()) setExistingAzureOpenAIApiKey(REDACTED);
      setGeminiApiKey(''); setOpenaiApiKey(''); setAzureOpenAIApiKey('');
      alert('Settings saved successfully!');
    } catch(e: any) { alert(`Failed to save configuration: ${e.message || 'Unknown error'}`); }
    finally { setIsSaving(false); }
  }

  async function testLlmConnection() {
    setIsTestingLlm(true); setLlmTestResult(null);
    try {
      const resolvedTestModel = isLatestAlias(clarifyModel)
        ? (clarifyModel === 'latest-pro'
            ? getPreferredFamilyModel(currentCatalogEntries, 'pro')
            : clarifyModel === 'latest-flash'
              ? getPreferredFamilyModel(currentCatalogEntries, 'flash')
              : clarifyModel === 'latest-lite'
                ? getPreferredFamilyModel(currentCatalogEntries, 'lite')
                : getCatalogModelId(currentCatalogEntries[0]))
        : clarifyModel.trim();
      if (!resolvedTestModel) {
        throw new Error(provider === 'azure_openai'
          ? 'No Azure OpenAI deployment is available yet. Refresh models and choose a concrete deployment first.'
          : 'Choose a concrete model before testing the connection.');
      }
      const res = await api.testLlmConnection({
        provider,
        model: resolvedTestModel,
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

  useEffect(() => {
    const providerEntries = modelCatalogs[provider]?.models?.length ? modelCatalogs[provider]!.models : buildStaticCatalog(provider);
    const proModel = getPreferredFamilyModel(providerEntries, 'pro');
    const flashModel = getPreferredFamilyModel(providerEntries, 'flash');
    const liteModel = getPreferredFamilyModel(providerEntries, 'lite');

    if (provider === 'gemini') {
      if (!decompositionModel.startsWith('gemini-') || isLatestAlias(decompositionModel)) setDecompositionModel(proModel || 'gemini-2.5-pro');
      if (!arModel.startsWith('gemini-') || isLatestAlias(arModel)) setArModel(proModel || 'gemini-2.5-pro');
      if (!clarifyModel.startsWith('gemini-') || isLatestAlias(clarifyModel)) setClarifyModel(flashModel || 'gemini-2.5-flash');
      if (!evaluateModel.startsWith('gemini-') || isLatestAlias(evaluateModel)) setEvaluateModel(liteModel || flashModel || 'gemini-2.5-flash');
      if (!triageModel.startsWith('gemini-') || isLatestAlias(triageModel)) setTriageModel(liteModel || flashModel || 'gemini-2.5-flash');
      if (!refineModel.startsWith('gemini-') || isLatestAlias(refineModel)) setRefineModel(flashModel || 'gemini-2.5-flash');
      if (!themeModel.startsWith('gemini-') || isLatestAlias(themeModel)) setThemeModel(liteModel || flashModel || 'gemini-2.5-flash');
    } else if (provider === 'openai') {
      if ((!decompositionModel.startsWith('gpt-') && !decompositionModel.startsWith('o')) || isLatestAlias(decompositionModel)) setDecompositionModel(proModel || 'gpt-4o');
      if ((!arModel.startsWith('gpt-') && !arModel.startsWith('o')) || isLatestAlias(arModel)) setArModel(proModel || 'gpt-4o');
      if ((!clarifyModel.startsWith('gpt-') && !clarifyModel.startsWith('o')) || isLatestAlias(clarifyModel)) setClarifyModel(flashModel || 'gpt-4o');
      if ((!evaluateModel.startsWith('gpt-') && !evaluateModel.startsWith('o')) || isLatestAlias(evaluateModel)) setEvaluateModel(liteModel || 'gpt-4o-mini');
      if ((!triageModel.startsWith('gpt-') && !triageModel.startsWith('o')) || isLatestAlias(triageModel)) setTriageModel(liteModel || 'gpt-4o-mini');
      if ((!refineModel.startsWith('gpt-') && !refineModel.startsWith('o')) || isLatestAlias(refineModel)) setRefineModel(flashModel || 'gpt-4o');
      if ((!themeModel.startsWith('gpt-') && !themeModel.startsWith('o')) || isLatestAlias(themeModel)) setThemeModel(liteModel || 'gpt-4o-mini');
    } else if (provider === 'azure_openai') {
      const shouldResetAzureModel = (modelId: string) =>
        !modelId.trim()
        || isLatestAlias(modelId)
        || modelId.startsWith('gemini-')
        || modelId.startsWith('gpt-')
        || modelId.startsWith('o')
        || modelId.startsWith('claude-');
      if (shouldResetAzureModel(decompositionModel) && proModel) setDecompositionModel(proModel);
      if (shouldResetAzureModel(arModel) && proModel) setArModel(proModel);
      if (shouldResetAzureModel(clarifyModel) && flashModel) setClarifyModel(flashModel);
      if (shouldResetAzureModel(evaluateModel) && (liteModel || flashModel)) setEvaluateModel(liteModel || flashModel);
      if (shouldResetAzureModel(triageModel) && (liteModel || flashModel)) setTriageModel(liteModel || flashModel);
      if (shouldResetAzureModel(refineModel) && flashModel) setRefineModel(flashModel);
      if (shouldResetAzureModel(themeModel) && (liteModel || flashModel)) setThemeModel(liteModel || flashModel);
    } else {
      if (!decompositionModel.startsWith('claude-') || isLatestAlias(decompositionModel)) setDecompositionModel(proModel || 'claude-opus-4-6');
      if (!arModel.startsWith('claude-') || isLatestAlias(arModel)) setArModel(proModel || 'claude-opus-4-6');
      if (!clarifyModel.startsWith('claude-') || isLatestAlias(clarifyModel)) setClarifyModel(flashModel || 'claude-sonnet-4-5-20250929');
      if (!evaluateModel.startsWith('claude-') || isLatestAlias(evaluateModel)) setEvaluateModel(liteModel || 'claude-haiku-4-5-20251001');
      if (!triageModel.startsWith('claude-') || isLatestAlias(triageModel)) setTriageModel(liteModel || 'claude-haiku-4-5-20251001');
      if (!refineModel.startsWith('claude-') || isLatestAlias(refineModel)) setRefineModel(flashModel || 'claude-sonnet-4-5-20250929');
      if (!themeModel.startsWith('claude-') || isLatestAlias(themeModel)) setThemeModel(liteModel || 'claude-haiku-4-5-20251001');
    }
  }, [provider, modelCatalogs, decompositionModel, arModel, clarifyModel, evaluateModel, triageModel, refineModel, themeModel]);

  const refreshModelCatalog = useCallback(async () => {
    setIsRefreshingModels(true);
    setModelCatalogError(null);
    try {
      const res = await api.discoverLlmModels({
        provider,
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
  }, [provider, geminiApiKey, existingGeminiApiKey, geminiBaseUrl, openaiApiKey, existingOpenaiApiKey, openaiBaseUrl, azureOpenAIApiKey, existingAzureOpenAIApiKey, azureOpenAIBaseUrl, azureOpenAIApiVersion]);

  useEffect(() => {
    if (provider === 'forge_llms') {
      setModelCatalogs(prev => prev.forge_llms ? prev : { ...prev, forge_llms: { vendor: 'forge_llms', source: 'fallback', fetchedAt: new Date().toISOString(), models: buildStaticCatalog('forge_llms') } });
      return;
    }
    const hasStoredCredential = provider === 'gemini'
      ? Boolean(existingGeminiApiKey)
      : provider === 'openai'
        ? Boolean(existingOpenaiApiKey)
        : Boolean(existingAzureOpenAIApiKey && azureOpenAIBaseUrl.trim());
    if (hasStoredCredential && !modelCatalogs[provider]) {
      void refreshModelCatalog();
    }
  }, [provider, existingGeminiApiKey, existingOpenaiApiKey, existingAzureOpenAIApiKey, azureOpenAIBaseUrl, modelCatalogs, refreshModelCatalog]);

  const currentCatalogEntries = useMemo(() => {
    return modelCatalogs[provider]?.models?.length ? modelCatalogs[provider]!.models : buildStaticCatalog(provider);
  }, [modelCatalogs, provider]);

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
    [clarifyModel, decompositionModel, arModel, evaluateModel].forEach(modelId => {
      if (modelId && !options.some(option => option.id === modelId)) {
        options.push({ id: modelId, label: modelId });
      }
    });
    return options;
  }, [currentCatalogEntries, clarifyModel, decompositionModel, arModel, evaluateModel]);

  const settingsNav = [
    { id: 'models', label: 'AI Setup', icon: BrainCircuit, sub: 'Provider and models' },
    { id: 'jira', label: 'Project Setup', icon: Database, sub: 'Backlog, fields, docs' },
    { id: 'domain', label: 'Guidance', icon: Globe, sub: 'Roles and workspace rules' },
    { id: 'stats', label: 'Stats', icon: BarChart3, sub: 'Usage and audit visibility' },
    { id: 'billing', label: 'Billing', icon: CreditCard, sub: 'Plan and controls' },
  ] as const;

  const wiUploadCopy = wiUploadState
    ? wiUploadState.stage === 'reading'
      ? 'Preparing document'
      : wiUploadState.stage === 'uploading'
        ? 'Uploading document'
        : 'Indexing for retrieval'
    : null;
  const canEditBranding = Boolean(isAdmin && tier === 'enterprise');

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
                     <div>1. AI Setup</div>
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
                   <h3 className="text-2xl font-bold text-[var(--rf-text)] tracking-tight">AI Provider & Models</h3>
                   <p className="text-[var(--rf-text-tertiary)] text-sm">Configure your LLM provider and specify which models handle the distinct reasoning steps.</p>
                </div>

                <div className="bg-white rounded-2xl p-6 lg:p-8 border border-[var(--rf-border)] shadow-sm space-y-8">
                  <div className="space-y-3">
                    <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">LLM Provider</label>
                    <div className="flex p-1 bg-[var(--rf-surface-soft)] rounded-xl border border-[var(--rf-border)]">
                      {(['openai', 'azure_openai', 'gemini', 'forge_llms'] as const).map(p => (
                        <button key={p} onClick={() => setProvider(p)} className={`flex-1 py-2 text-[11px] font-bold uppercase tracking-wider rounded-lg transition-all ${provider === p ? 'bg-white text-[var(--rf-brand)] shadow-sm border border-[var(--rf-border)]/50' : 'text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text-secondary)]'}`}>
                          {p === 'azure_openai' ? 'azure openai' : p.replace('_', ' ')}
                        </button>
                      ))}
                    </div>
                  </div>

                  {provider === 'openai' && (
                    <motion.div className="space-y-2" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                      <div className="flex justify-between items-center px-1">
                        <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">OpenAI API Key</label>
                        {existingOpenaiApiKey && <button onClick={() => { setExistingOpenaiApiKey(''); setOpenaiApiKey(''); }} className="text-[10px] font-bold text-rose-500 hover:text-[var(--rf-danger)]">Clear Stored</button>}
                      </div>
                      <input type="password" value={openaiApiKey} onChange={e => setOpenaiApiKey(e.target.value)} placeholder={existingOpenaiApiKey ? '••••••••• (Stored)' : 'sk-…'} disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                    </motion.div>
                  )}

                  {provider === 'azure_openai' && (
                    <motion.div className="space-y-3" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                      <div className="space-y-2">
                        <div className="flex justify-between items-center px-1">
                          <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Azure OpenAI API Key</label>
                          {existingAzureOpenAIApiKey && <button onClick={() => { setExistingAzureOpenAIApiKey(''); setAzureOpenAIApiKey(''); }} className="text-[10px] font-bold text-rose-500 hover:text-[var(--rf-danger)]">Clear Stored</button>}
                        </div>
                        <input type="password" value={azureOpenAIApiKey} onChange={e => setAzureOpenAIApiKey(e.target.value)} placeholder={existingAzureOpenAIApiKey ? '••••••••• (Stored)' : 'Azure key'} disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                      </div>
                      <div className="space-y-2">
                        <label className="px-1 text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Endpoint</label>
                        <input type="text" value={azureOpenAIBaseUrl} onChange={e => setAzureOpenAIBaseUrl(e.target.value)} placeholder="https://your-resource.openai.azure.com" disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                      </div>
                      <div className="space-y-2">
                        <label className="px-1 text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">API Version</label>
                        <input type="text" value={azureOpenAIApiVersion} onChange={e => setAzureOpenAIApiVersion(e.target.value)} placeholder="2024-06-01" disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                      </div>
                    </motion.div>
                  )}

                  {provider === 'gemini' && (
                    <motion.div className="space-y-2" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                      <div className="flex justify-between items-center px-1">
                        <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Gemini API Key</label>
                        {existingGeminiApiKey && <button onClick={() => { setExistingGeminiApiKey(''); setGeminiApiKey(''); }} className="text-[10px] font-bold text-rose-500 hover:text-[var(--rf-danger)]">Clear Stored</button>}
                      </div>
                      <input type="password" value={geminiApiKey} onChange={e => setGeminiApiKey(e.target.value)} placeholder={existingGeminiApiKey ? '••••••••• (Stored)' : 'AIza…'} disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                    </motion.div>
                  )}

                  <div className="space-y-5 pt-6 border-t border-[var(--rf-border-subtle)]">
                    <div className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-3 text-xs text-[var(--rf-text-secondary)] flex items-start gap-3">
                      <Info className="w-4 h-4 text-[var(--rf-brand)] shrink-0 mt-0.5" />
                      <p><span className="font-bold text-[var(--rf-text)]">How this works:</span> each phase can use a different model, but each phase does a different job. Use a stronger model where you want deeper structure, and a faster model where you want cheap, quick validation.</p>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--rf-border)] bg-white px-4 py-3 shadow-sm">
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Model catalog</div>
                        <p className="mt-1 text-xs font-medium text-[var(--rf-text-tertiary)]">
                          {modelCatalogs[provider]?.models?.length
                            ? `Loaded ${modelCatalogs[provider]?.models?.length ?? 0} model option(s) for ${provider === 'azure_openai' ? 'Azure OpenAI' : provider.replace('_', ' ')}.`
                            : 'Using the bundled fallback catalog until a live vendor catalog is loaded.'}
                        </p>
                      </div>
                      <motion.button
                        onClick={refreshModelCatalog}
                        disabled={isRefreshingModels || !isAdmin}
                        className="bg-[var(--rf-surface-soft)] hover:bg-slate-200 disabled:opacity-50 text-[var(--rf-text-secondary)] text-[11px] font-bold uppercase tracking-widest px-4 py-2.5 rounded-xl transition-all flex items-center gap-2 border border-[var(--rf-border)]"
                        whileTap={{ scale: 0.98 }}
                      >
                        <RefreshCw className={`w-4 h-4 ${isRefreshingModels ? 'animate-spin' : ''}`} />
                        Refresh models
                      </motion.button>
                    </div>
                    {modelCatalogError && (
                      <div className="rounded-xl border border-[var(--rf-danger-subtle)] bg-[var(--rf-danger-subtle)] px-4 py-3 text-xs font-semibold text-[var(--rf-danger)]">
                        {modelCatalogError}
                      </div>
                    )}
                    
                    <div className="space-y-3">
                      {[
                        {
                          label: 'Clarifying Questions',
                          hint: 'Asks follow-up questions when the request is ambiguous and powers the follow-on refine step.',
                          val: clarifyModel,
                          set: (value: string) => {
                            setClarifyModel(value);
                            setRefineModel(value);
                          },
                        },
                        {
                          label: 'Feature Breakdown',
                          hint: 'Breaks the request into the main feature ideas, user needs, and scope boundaries before drafting details.',
                          val: decompositionModel,
                          set: (value: string) => {
                            setDecompositionModel(value);
                          },
                        },
                        {
                          label: 'Acceptance Requirements',
                          hint: 'Writes the GIVEN / WHEN / THEN acceptance requirements for each feature after the breakdown is complete.',
                          val: arModel,
                          set: (value: string) => {
                            setArModel(value);
                          },
                        },
                        {
                          label: 'Triage',
                          hint: 'Quick assessment of requirement scope and complexity before generation. Determines how many features and acceptance requirements to produce.',
                          val: triageModel,
                          set: (value: string) => {
                            setTriageModel(value);
                          },
                        },
                        {
                          label: 'Review & Titles',
                          hint: 'Checks whether enough context was captured, spots grouped gaps, and generates concise themes and titles.',
                          val: evaluateModel,
                          set: (value: string) => {
                            setEvaluateModel(value);
                            setThemeModel(value);
                          },
                        },
                      ].map((item, i) => (
                        <div key={i} className="rounded-xl border border-[var(--rf-border)] bg-white px-4 py-3.5 space-y-2 shadow-sm">
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                            <span className="text-sm font-bold text-[var(--rf-text-secondary)]">{item.label}</span>
                            <select value={item.val} disabled={availableModels.length === 0} onChange={e => item.set(e.target.value)} className="bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-xs font-semibold text-[var(--rf-text)] sm:w-[240px] focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none transition">
                              {availableModels.length === 0 ? <option>Provider required...</option> : availableModels.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                            </select>
                          </div>
                          <p className="text-[11px] font-medium text-[var(--rf-text-tertiary)] leading-relaxed">{item.hint}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="pt-6 border-t border-[var(--rf-border-subtle)] flex items-center gap-4">
                    <motion.button 
                      onClick={testLlmConnection} 
                      disabled={isTestingLlm} 
                      className="bg-[var(--rf-text)] hover:bg-black text-white text-[11px] font-bold uppercase tracking-widest px-5 py-2.5 rounded-lg transition-all flex items-center gap-2"
                      whileTap={{ scale: 0.98 }}
                    >
                       {isTestingLlm ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />} Test Connection
                    </motion.button>
                    {llmTestResult && (
                      <div className={`px-4 py-2.5 rounded-lg text-[11px] font-bold flex items-center gap-2 border ${llmTestResult.ok ? 'bg-[var(--rf-success-subtle)] text-[var(--rf-success)] border-[var(--rf-success-subtle)]' : 'bg-[var(--rf-danger-subtle)] text-[var(--rf-danger)] border-[var(--rf-danger-subtle)]'}`}>
                         {llmTestResult.ok ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />} {llmTestResult.message}
                      </div>
                    )}
                  </div>
                </div>
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
                      domainContexts={domainContexts || []} setDomainContexts={setDomainContexts}
                      backlogStatusScopes={backlogStatusScopes || []} setBacklogStatusScopes={setBacklogStatusScopes} backlogStatusOptions={backlogStatusOptions || []}
                      detectDefaultStatuses={detectDefaultStatuses}
                      activeArProj={activeArProj} setActiveArProj={setActiveArProj} isAdmin={isAdmin} isProjectAdmin={activeProjAdmin}
                      backlogCacheInfo={backlogCacheInfo}
                      backlogDiagnostics={backlogDiagnostics}
                      isRefreshingBacklogCache={isRefreshingBacklogCache}
                      onRefreshBacklogCache={handleRefreshBacklogCache}
                    />
                  ) : (
                    <div className="bg-white rounded-2xl p-12 text-center border-2 border-dashed border-[var(--rf-border)]">
                      <Database className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                      <h4 className="text-lg font-bold text-[var(--rf-text)]">Select a project to configure</h4>
                      <p className="text-sm font-medium text-[var(--rf-text-tertiary)] mt-2 max-w-md mx-auto">Define backlog indexing scope, work instructions, and project-specific guidance for the selected project.</p>
                    </div>
                  )}

                  {/* Step 3 WIs */}
                  <div className="bg-white rounded-2xl p-6 border border-[var(--rf-border)] shadow-sm space-y-6">
                    <div className="flex items-center justify-between gap-4">
                      <div className="space-y-1">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Step 3</div>
                        <h4 className="text-lg font-bold text-[var(--rf-text)]">Project Work Instructions</h4>
                        <p className="text-xs font-medium text-[var(--rf-text-tertiary)]">Attach documents to inform AI generation for this project. The picker accepts PDFs, spreadsheets, text files, and email exports.</p>
                      </div>
                      <div className="rounded-full border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">
                        {wiDocs.length} linked
                      </div>
                      <motion.button
                        onClick={() => wiFileInputRef.current?.click()}
                        disabled={activeArProj === '*' || !!wiUploadState}
                        className="bg-[var(--rf-text)] hover:bg-black disabled:bg-slate-300 text-white text-[11px] font-bold uppercase tracking-widest px-5 py-2.5 rounded-lg shadow-sm transition-all"
                        whileTap={{ scale: 0.98 }}
                      >
                        {wiUploadState ? 'Uploading…' : 'Add docs'}
                      </motion.button>
                      <input type="file" ref={wiFileInputRef} onChange={handleWiFileDrop} accept={WI_ACCEPT} multiple className="hidden" disabled={activeArProj === '*' || !!wiUploadState} />
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
                                  <div className="h-full w-1/2 rounded-full bg-[var(--rf-brand-muted)]0 animate-pulse" />
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
                              <div key={doc.docId} className="bg-[var(--rf-surface-soft)] p-4 rounded-xl border border-[var(--rf-border)] flex items-center justify-between gap-3 group hover:border-[var(--rf-border-strong)] transition-all">
                                <div className="flex items-start gap-3 min-w-0 flex-1">
                                  <div className="shrink-0 w-10 h-10 bg-white rounded-lg border border-[var(--rf-border)] flex items-center justify-center shadow-sm">
                                    <FileText className="w-5 h-5 text-[var(--rf-brand)]" />
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <p className="text-sm font-bold text-[var(--rf-text)] leading-snug break-words">{doc.filename}</p>
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
                      <div className="w-12 h-12 rounded-xl bg-[var(--rf-brand-muted)] text-[var(--rf-brand)] flex items-center justify-center border border-blue-100 shadow-sm"><Users className="w-6 h-6" /></div>
                      <div>
                        <h4 className="text-base font-bold text-[var(--rf-text)]">Core persona roles</h4>
                        <p className="text-xs font-medium text-[var(--rf-text-tertiary)]">Enter the roles that matter and what each role actually does so the question flow stays grounded in real work.</p>
                      </div>
                    </div>

                    <div className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] p-4 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Role guidance table</div>
                          <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-1">Keep this brief and operational. Each row should describe a role and the activities that role performs.</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setRoleGuidanceRows(prev => [...prev, { role: '', activities: '' }])}
                          className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-brand)] bg-[var(--rf-brand-muted)] hover:bg-blue-100 px-3 py-1.5 rounded-lg transition"
                        >
                          + Add row
                        </button>
                      </div>

                      <div className="space-y-3">
                        <div className="hidden md:grid md:grid-cols-[minmax(180px,220px)_1fr_auto] gap-3 px-1 text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">
                          <div>Role</div>
                          <div>Activities</div>
                          <div />
                        </div>
                        {roleGuidanceRows.map((row, index) => (
                          <div key={`workspace-role-${index}`} className="grid grid-cols-1 md:grid-cols-[minmax(180px,220px)_1fr_auto] gap-3 items-start rounded-xl border border-[var(--rf-border)] bg-white p-3 shadow-sm">
                            <div className="space-y-1">
                              <div className="md:hidden text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Role</div>
                              <input
                                value={row.role}
                                onChange={e => setRoleGuidanceRows(prev => prev.map((item, idx) => idx === index ? { ...item, role: e.target.value } : item))}
                                placeholder="Field Service Engineer"
                                className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2.5 text-sm font-semibold text-[var(--rf-text)] outline-none focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition shadow-sm"
                              />
                            </div>
                            <div className="space-y-1">
                              <div className="md:hidden text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Activities</div>
                              <textarea
                                value={row.activities}
                                onChange={e => setRoleGuidanceRows(prev => prev.map((item, idx) => idx === index ? { ...item, activities: e.target.value } : item))}
                                placeholder="Schedules visits, checks service windows, and confirms completion."
                                className="w-full min-h-[72px] bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2.5 text-sm font-medium text-[var(--rf-text)] outline-none focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition shadow-sm resize-none"
                              />
                            </div>
                            <button
                              type="button"
                              onClick={() => setRoleGuidanceRows(prev => prev.length === 1 ? [{ role: '', activities: '' }] : prev.filter((_, idx) => idx !== index))}
                              className="md:mt-1 rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] hover:text-[var(--rf-danger)] hover:border-[var(--rf-danger-subtle)] transition"
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
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

            {activeTab === 'stats' && (
              <motion.div
                className="max-w-5xl space-y-8"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
              >
                <div className="space-y-1">
                  <h3 className="text-2xl font-bold text-[var(--rf-text)] tracking-tight">Usage & Compliance Stats</h3>
                  <p className="text-sm font-medium text-[var(--rf-text-tertiary)]">Workspace-wide activity, project breakdowns, and the compliance package signals currently captured by the app.</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  {[
                    { label: 'Generations this month', value: usage?.currentMonth ?? 0, helper: 'Workspace total' },
                    { label: 'Tracked tokens', value: workspaceTokenUsage.toLocaleString(), helper: 'From transparency reports' },
                    { label: 'Projects with activity', value: projectUsageBreakdown.length, helper: 'Approximate from reports' },
                    { label: 'Compliance signals', value: complianceEvents.length + transparencyReports.length + jiraAuditRecords.length, helper: 'Audit + transparency + Jira records' },
                  ].map((card) => (
                    <div key={card.label} className="rounded-2xl border border-[var(--rf-border)] bg-white px-5 py-4 shadow-sm">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">{card.label}</div>
                      <div className="mt-2 text-2xl font-black text-[var(--rf-text)]">{card.value}</div>
                      <div className="mt-1 text-[11px] font-medium text-[var(--rf-text-tertiary)]">{card.helper}</div>
                    </div>
                  ))}
                </div>

                <div className="rounded-2xl border border-[var(--rf-border)] bg-white p-6 shadow-sm space-y-4">
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Project usage</div>
                    <h4 className="mt-1 text-lg font-bold text-[var(--rf-text)]">Activity across the workspace</h4>
                    <p className="mt-1 text-xs font-medium text-[var(--rf-text-tertiary)]">Based on transparency reports currently stored in the workspace. This gives you a practical cross-project view even before a dedicated billing analytics backend exists.</p>
                  </div>
                  {projectUsageBreakdown.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-5 text-sm font-medium text-[var(--rf-text-tertiary)] text-center">
                      No tracked project activity yet.
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-xl border border-[var(--rf-border)]">
                      <table className="w-full text-left">
                        <thead className="bg-[var(--rf-surface-soft)]">
                          <tr className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">
                            <th className="px-4 py-3">Project</th>
                            <th className="px-4 py-3">Reports</th>
                            <th className="px-4 py-3">Tokens</th>
                            <th className="px-4 py-3">Latest activity</th>
                          </tr>
                        </thead>
                        <tbody>
                          {projectUsageBreakdown.map((project) => (
                            <tr key={project.projectKey} className="border-t border-[var(--rf-border)]">
                              <td className="px-4 py-3 text-sm font-bold text-[var(--rf-text)]">{project.projectKey}</td>
                              <td className="px-4 py-3 text-sm font-medium text-[var(--rf-text-secondary)]">{project.reportCount}</td>
                              <td className="px-4 py-3 text-sm font-medium text-[var(--rf-text-secondary)]">{project.tokenUsage.toLocaleString()}</td>
                              <td className="px-4 py-3 text-sm font-medium text-[var(--rf-text-tertiary)]">{project.latestAt ? new Date(project.latestAt).toLocaleString() : 'n/a'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                  <div className="rounded-2xl border border-[var(--rf-border)] bg-white p-5 shadow-sm space-y-3">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-indigo-600">Transparency reports</div>
                    <div className="text-sm font-medium text-[var(--rf-text-tertiary)]">Recent model decisions and token usage.</div>
                    <div className="space-y-2">
                      {transparencyReports.slice(0, 6).map((report) => (
                        <div key={report.reportId} className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-xs font-bold text-[var(--rf-text)]">{report.projectKey || 'Workspace-wide'}</div>
                            <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">{report.turnType}</div>
                          </div>
                          <div className="mt-1 text-[11px] font-medium text-[var(--rf-text-tertiary)]">{new Date(report.createdAt).toLocaleString()}</div>
                          <div className="mt-2 text-xs text-[var(--rf-text-secondary)]">{report.decisionSummary?.[0] || 'No summary captured.'}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-[var(--rf-border)] bg-white p-5 shadow-sm space-y-3">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-indigo-600">Compliance audit trail</div>
                    <div className="text-sm font-medium text-[var(--rf-text-tertiary)]">Configuration, security, prompt, and runtime events.</div>
                    <div className="space-y-2">
                      {complianceEvents.slice(0, 6).map((event) => (
                        <div key={event.eventId} className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-xs font-bold text-[var(--rf-text)]">{event.action}</div>
                            <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">{event.category}</div>
                          </div>
                          <div className="mt-1 text-[11px] font-medium text-[var(--rf-text-tertiary)]">{new Date(event.timestamp).toLocaleString()}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-[var(--rf-border)] bg-white p-5 shadow-sm space-y-3">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-indigo-600">Jira audit records</div>
                    <div className="text-sm font-medium text-[var(--rf-text-tertiary)]">Recent issue creation and downstream writeback activity.</div>
                    <div className="space-y-2">
                      {jiraAuditRecords.slice(0, 6).map((record, index) => (
                        <div key={`${String(record.issueKey ?? 'jira')}-${index}`} className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-3">
                          <div className="text-xs font-bold text-[var(--rf-text)]">{String(record.issueKey ?? record.projectKey ?? 'Jira event')}</div>
                          <div className="mt-1 text-[11px] font-medium text-[var(--rf-text-tertiary)]">{String(record.action ?? record.status ?? 'No action')}</div>
                        </div>
                      ))}
                    </div>
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
                          className="h-full bg-[var(--rf-brand-muted)]0 transition-all duration-500"
                          style={{ width: usage ? `${Math.min(100, (usage.currentMonth / (limits?.generationsPerMonth || 1)) * 100)}%` : '0%' }}
                        />
                      </div>
                    )}
                  </div>
                </div>

                <div className="bg-white rounded-2xl p-6 lg:p-8 border border-[var(--rf-border)] shadow-sm space-y-6">
                  <div className="flex flex-col gap-2">
                    <div>
                      <p className="text-[11px] uppercase tracking-widest text-[var(--rf-brand)] font-bold">Usage & stats</p>
                      <h4 className="text-xl font-bold text-[var(--rf-text)]">Workspace and project activity</h4>
                    </div>
                    <p className="text-sm font-medium text-[var(--rf-text-tertiary)]">
                      Workspace usage is the billing source of truth. Project rows below are approximated from transparency reports already loaded in this screen.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                    <div className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] p-4">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Workspace generations</div>
                      <div className="mt-2 text-2xl font-black text-[var(--rf-text)]">{usage?.currentMonth ?? 0}</div>
                      <div className="mt-1 text-[11px] font-medium text-[var(--rf-text-tertiary)]">of {limits?.generationsPerMonth === -1 ? 'Unlimited' : limits?.generationsPerMonth ?? 0}</div>
                    </div>
                    <div className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] p-4">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Approx. project tokens</div>
                      <div className="mt-2 text-2xl font-black text-[var(--rf-text)]">{workspaceTokenUsage.toLocaleString()}</div>
                      <div className="mt-1 text-[11px] font-medium text-[var(--rf-text-tertiary)]">From loaded transparency reports.</div>
                    </div>
                    <div className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] p-4">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Configured projects</div>
                      <div className="mt-2 text-2xl font-black text-[var(--rf-text)]">{projects.length}</div>
                      <div className="mt-1 text-[11px] font-medium text-[var(--rf-text-tertiary)]">Available for project-specific setup.</div>
                    </div>
                    <div className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] p-4">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Loaded records</div>
                      <div className="mt-2 text-2xl font-black text-[var(--rf-text)]">{transparencyReports.length + complianceEvents.length + jiraAuditRecords.length}</div>
                      <div className="mt-1 text-[11px] font-medium text-[var(--rf-text-tertiary)]">Transparency, compliance, and Jira audit trails.</div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] p-4">
                    <div className="flex items-center justify-between gap-3 mb-4">
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Per-project usage</div>
                        <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-1">Approximate usage is grouped from transparency reports already loaded in this screen.</p>
                      </div>
                      <span className="rounded-md border border-[var(--rf-border)] bg-white px-2.5 py-1 text-[9px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Approximate</span>
                    </div>
                    {projectUsageBreakdown.length ? (
                      <div className="overflow-hidden rounded-xl border border-[var(--rf-border)] bg-white">
                        <div className="grid grid-cols-[minmax(0,1.2fr)_90px_90px_minmax(0,1fr)] gap-3 border-b border-[var(--rf-border)] px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">
                          <div>Project</div>
                          <div className="text-right">Reports</div>
                          <div className="text-right">Tokens</div>
                          <div>Latest</div>
                        </div>
                        <div className="divide-y divide-[var(--rf-border)]">
                          {projectUsageBreakdown.map(project => (
                            <div key={project.projectKey} className="grid grid-cols-[minmax(0,1.2fr)_90px_90px_minmax(0,1fr)] gap-3 px-4 py-3 items-center">
                              <div className="min-w-0">
                                <div className="text-sm font-bold text-[var(--rf-text)] truncate">{project.projectKey}</div>
                              </div>
                              <div className="text-sm font-bold text-[var(--rf-text-secondary)] text-right">{project.reportCount}</div>
                              <div className="text-sm font-bold text-[var(--rf-text-secondary)] text-right">{project.tokenUsage.toLocaleString()}</div>
                              <div className="text-[11px] font-medium text-[var(--rf-text-tertiary)] truncate">
                                {project.latestAt ? new Date(project.latestAt).toLocaleString() : 'No timestamp'}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-xl border border-dashed border-[var(--rf-border)] bg-white px-4 py-5 text-sm font-medium text-[var(--rf-text-tertiary)]">
                        No transparency reports have been loaded yet, so project-level usage cannot be approximated.
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
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <Image className="w-5 h-5 text-[var(--rf-brand)]" />
                        <p className="text-[11px] uppercase tracking-widest text-[var(--rf-brand)] font-bold">Branding</p>
                      </div>
                      <h4 className="text-xl font-bold text-[var(--rf-text)]">Company logo</h4>
                      <p className="mt-1 text-sm font-medium text-[var(--rf-text-tertiary)]">
                        Configure a logo URL for enterprise workspaces so the app can carry your company identity.
                      </p>
                    </div>
                    <span className={`text-[9px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wider border ${canEditBranding ? 'bg-[var(--rf-success-subtle)] text-[var(--rf-success)] border-[var(--rf-success-subtle)]' : 'bg-[var(--rf-surface-soft)] text-[var(--rf-text-tertiary)] border-[var(--rf-border)]'}`}>
                      {canEditBranding ? 'Editable' : 'Enterprise only'}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-[1fr_220px] gap-4">
                    <div className="space-y-3">
                      <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Logo URL</label>
                      <input
                        value={brandingLogoUrl}
                        onChange={e => setBrandingLogoUrl(e.target.value)}
                        placeholder="https://example.com/company-logo.svg"
                        disabled={!canEditBranding}
                        className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none disabled:opacity-60"
                      />
                      <p className="text-[11px] font-medium text-[var(--rf-text-tertiary)]">
                        Paste a publicly reachable image URL. The stored logo is saved in the workspace branding contract.
                      </p>
                    </div>
                    <div className="rounded-2xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] p-4 flex items-center justify-center min-h-[132px]">
                      {brandingLogoUrl.trim() ? (
                        <img
                          src={brandingLogoUrl.trim()}
                          alt="Company logo preview"
                          className="max-h-[92px] max-w-full object-contain"
                        />
                      ) : (
                        <div className="text-center">
                          <Image className="w-8 h-8 text-[var(--rf-text-tertiary)] mx-auto mb-2" />
                          <p className="text-xs font-medium text-[var(--rf-text-tertiary)]">Logo preview</p>
                        </div>
                      )}
                    </div>
                  </div>
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

                  <div className="rounded-2xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] p-4 space-y-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Loaded compliance records</div>
                        <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-1">
                          These are already available in settings and help surface the transparency trail behind the current workspace.
                        </p>
                      </div>
                      <span className="rounded-md border border-[var(--rf-border)] bg-white px-2.5 py-1 text-[9px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">
                        {complianceEvents.length + transparencyReports.length + jiraAuditRecords.length} loaded
                      </span>
                    </div>

                    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                      <div className="rounded-xl border border-[var(--rf-border)] bg-white p-4">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-3">Compliance audit events</div>
                        <div className="space-y-2 max-h-60 overflow-y-auto custom-scrollbar pr-1">
                          {complianceEvents.length ? complianceEvents.slice(0, 6).map(event => (
                            <div key={event.eventId} className="rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-2">
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-xs font-bold text-[var(--rf-text)]">{event.action}</div>
                                <div className="text-[9px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">{event.category}</div>
                              </div>
                              <div className="mt-1 text-[11px] font-medium text-[var(--rf-text-tertiary)]">{new Date(event.timestamp).toLocaleString()}</div>
                            </div>
                          )) : (
                            <div className="rounded-lg border border-dashed border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-4 text-xs font-medium text-[var(--rf-text-tertiary)]">
                              No compliance audit events loaded yet.
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="rounded-xl border border-[var(--rf-border)] bg-white p-4">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-3">Transparency reports</div>
                        <div className="space-y-2 max-h-60 overflow-y-auto custom-scrollbar pr-1">
                          {transparencyReports.length ? transparencyReports.slice(0, 6).map(report => (
                            <div key={report.reportId} className="rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-2">
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-xs font-bold text-[var(--rf-text)] capitalize">{report.turnType}</div>
                                <div className="text-[9px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">{report.projectKey || 'workspace'}</div>
                              </div>
                              <div className="mt-1 text-[11px] font-medium text-[var(--rf-text-tertiary)]">
                                {report.model ? `${report.model} · ` : ''}{report.tokenUsage?.total ? `${report.tokenUsage.total.toLocaleString()} tokens · ` : ''}{new Date(report.createdAt).toLocaleString()}
                              </div>
                              <div className="mt-1 text-[11px] font-medium text-[var(--rf-text-secondary)] line-clamp-2">
                                {report.decisionSummary.join(' · ')}
                              </div>
                            </div>
                          )) : (
                            <div className="rounded-lg border border-dashed border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-4 text-xs font-medium text-[var(--rf-text-tertiary)]">
                              No transparency reports loaded yet.
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="rounded-xl border border-[var(--rf-border)] bg-white p-4">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-3">Jira audit records</div>
                        <div className="space-y-2 max-h-60 overflow-y-auto custom-scrollbar pr-1">
                          {jiraAuditRecords.length ? jiraAuditRecords.slice(0, 6).map((record, index) => {
                            const label = String(record.action || record.event || record.type || record.change || `Record ${index + 1}`);
                            const detailText = typeof record.details === 'string'
                              ? record.details
                              : (JSON.stringify(record.details ?? record ?? {}) || '').slice(0, 180);
                            return (
                              <div key={`${label}-${index}`} className="rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-2">
                                <div className="text-xs font-bold text-[var(--rf-text)]">{label}</div>
                                <div className="mt-1 text-[11px] font-medium text-[var(--rf-text-tertiary)] line-clamp-2">{detailText}</div>
                              </div>
                            );
                          }) : (
                            <div className="rounded-lg border border-dashed border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-4 text-xs font-medium text-[var(--rf-text-tertiary)]">
                              No Jira audit records loaded yet.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
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
  backlogCacheInfo, backlogDiagnostics, isRefreshingBacklogCache, onRefreshBacklogCache,
}: any) {
  const currentMapping = useMemo(() => {
    const existing = arMappings.find((m: any) => m.projectKey === activeArProj);
    return normalizeProjectArMapping(existing || { projectKey: activeArProj });
  }, [arMappings, activeArProj]);
  const currentContext = domainContexts.find((c: any) => c.projectKey === activeArProj) || { projectKey: activeArProj, context: '' };
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

  const updateMapping = (p: any) => {
    const idx = arMappings.findIndex((m: any) => m.projectKey === activeArProj);
    const upd = normalizeProjectArMapping({ ...currentMapping, ...p, projectKey: activeArProj });
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
  const [projectNotice, setProjectNotice] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState({
    backlog: true,
    guidance: true,
    mapping: false,
  });

  const toggleSection = (section: 'backlog' | 'guidance' | 'mapping') => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const handleSave = async () => {
    setIsSavingProject(true);
    setProjectNotice(null);
    try {
      await api.saveProjectConfig({
        projectKey: activeArProj,
        arMapping: currentMapping,
        domainContext: currentContext.context,
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
                 <div className="mt-1 text-xl font-black text-[var(--rf-text)]">{indexedCount}</div>
                 <div className="mt-1 text-[10px] font-medium text-[var(--rf-text-tertiary)]">
                   {backlogCacheInfo?.issueCount !== undefined
                     ? 'Cache count from the latest rebuild.'
                     : 'Fallback from backlog diagnostics when cache metadata has not been refreshed yet.'}
                 </div>
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
              <div className="bg-[var(--rf-surface-soft)] rounded-xl p-5 border border-[var(--rf-border)] space-y-5">
                <div className="rounded-xl border border-[var(--rf-border)] bg-white p-4 shadow-sm space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Project guidance</div>
                      <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-1">Use this for rules, defaults, and phrasing that should apply to this project only.</p>
                    </div>
                  </div>
                  <textarea value={currentContext.context} onChange={e => updateContext(e.target.value)} placeholder="e.g. Ensure all stories include accessibility requirements..." className="w-full h-28 bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl p-4 text-sm font-medium outline-none focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition shadow-sm resize-none" />
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
                    <span className="rounded-md bg-[var(--rf-surface-soft)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] border border-[var(--rf-border)]">Advanced</span>
                  </h5>
                  <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-0.5">Map where Acceptance Criteria go.</p>
                </div>
              </div>
              <ChevronRight className={`w-5 h-5 text-[var(--rf-text-tertiary)] transition-transform ${expandedSections.mapping ? 'rotate-90' : ''}`} />
            </button>
            {expandedSections.mapping && (
            <div className="bg-[var(--rf-surface-soft)] rounded-xl p-5 border border-[var(--rf-border)] space-y-5">
               <div className="rounded-xl border border-[var(--rf-border)] bg-white p-4 shadow-sm">
                 <div className="flex items-start justify-between gap-4">
                   <div>
                     <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Mapping</div>
                     <p className="mt-1 text-xs font-medium text-[var(--rf-text-tertiary)]">
                       Input and output mappings stay separate so admins can point generated content into the right fields without switching modes.
                     </p>
                   </div>
                 </div>
                 <div className="mt-4 grid grid-cols-1 xl:grid-cols-2 gap-4">
                   <FieldMappingEditor
                     title="Input mapping"
                     description="Fields used when reading or grounding existing Jira content."
                     mapping={currentMapping.inputMappings}
                     onChange={(next: ProjectFieldMapping) => updateMapping({ inputMappings: next })}
                     customFields={customFields}
                   />
                   <FieldMappingEditor
                     title="Output mapping"
                     description="Fields used when writing generated content back to Jira."
                     mapping={currentMapping.outputMappings}
                     onChange={(next: ProjectFieldMapping) => updateMapping({ outputMappings: next })}
                     customFields={customFields}
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
    mode: outputMappings.arFieldIds.length > 1 ? 'iterative' : (raw?.mode || 'consolidated'),
    consolidatedFieldId: outputMappings.arFieldIds[0] || outputMappings.descriptionFieldId || 'description',
    iterativeFieldIds: outputMappings.arFieldIds,
    inputMappings,
    outputMappings,
    issueLinkType: raw?.issueLinkType,
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
    <div className="rounded-2xl border border-[var(--rf-border)] bg-white p-5 shadow-sm space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">{title}</div>
          <p className="mt-1 text-xs font-medium text-[var(--rf-text-tertiary)]">{description}</p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-3">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Summary</div>
            <div className="text-sm font-bold text-[var(--rf-text-secondary)] mt-1">summary</div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-3">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Description</div>
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
              <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Acceptance requirements</div>
              <div className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-0.5">Add one or more Jira fields where ARs should appear.</div>
            </div>
            <button
              type="button"
              onClick={addArField}
              disabled={selectableFieldIds.every(fieldId => mapping.arFieldIds.includes(fieldId))}
              className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-brand)] bg-[var(--rf-brand-muted)] hover:bg-blue-100 px-3 py-1.5 rounded-lg transition"
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
                  <span className="text-[10px] font-black text-[var(--rf-text-tertiary)] min-w-[24px] text-center">#{i + 1}</span>
                  <div className="flex-1">
                    <FieldSelector value={fid} onChange={(nextFieldId: string) => updateArField(i, nextFieldId)} customFields={customFields} />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeArField(i)}
                    className="p-1.5 text-[var(--rf-text-tertiary)] hover:text-rose-500 hover:bg-[var(--rf-danger-subtle)] rounded-md transition"
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
                <span className="text-[9px] text-[var(--rf-text-tertiary)] font-mono shrink-0 ml-2">{f.id}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
