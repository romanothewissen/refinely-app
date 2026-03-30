import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { 
  Database, BrainCircuit, Globe, X, RefreshCw, Save, CreditCard, ChevronLeft, ShieldCheck, 
  Users, FileText, ChevronRight, Check, Trash, Layers, Zap, Info, ExternalLink
} from 'lucide-react';
import { api } from './hooks/useForge';
import { REDACTED } from './types';

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

export function SettingsView({ onClose, initialTab = 'models', initialProjectKey = '*' }: { onClose: () => void; initialTab?: 'models' | 'jira' | 'domain' | 'billing'; initialProjectKey?: string }) {
  const [activeTab, setActiveTab] = useState<'models' | 'jira' | 'domain' | 'billing'>(initialTab);
  const [isSaving, setIsSaving] = useState(false);

  // Models State
  const [provider, setProvider] = useState<'forge_llms' | 'gemini' | 'openai'>('forge_llms');
  const [decompositionModel, setDecompositionModel] = useState('claude-opus-4-6');
  const [arModel, setArModel] = useState('claude-opus-4-6');
  const [clarifyModel, setClarifyModel] = useState('claude-sonnet-4-5-20250929');
  const [evaluateModel, setEvaluateModel] = useState('claude-haiku-4-5-20251001');
  const [refineModel, setRefineModel] = useState('claude-sonnet-4-5-20250929');
  const [themeModel, setThemeModel] = useState('claude-haiku-4-5-20251001');

  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [geminiBaseUrl, setGeminiBaseUrl] = useState('');
  const [existingGeminiApiKey, setExistingGeminiApiKey] = useState('');
  
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState('');
  const [existingOpenaiApiKey, setExistingOpenaiApiKey] = useState('');
  
  const [isTestingLlm, setIsTestingLlm] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState<{ ok: boolean; message: string } | null>(null);

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
    loadInitialConfig();
  }, []);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (initialProjectKey) setActiveArProj(initialProjectKey);
  }, [initialProjectKey]);

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
        if (gc.refineModel) setRefineModel(gc.refineModel);
        if (gc.themeModel) setThemeModel(gc.themeModel);
        
        if (gc.geminiApiKey) setExistingGeminiApiKey(gc.geminiApiKey);
        if (gc.geminiBaseUrl) setGeminiBaseUrl(gc.geminiBaseUrl);
        if (gc.openaiApiKey) setExistingOpenaiApiKey(gc.openaiApiKey);
        if (gc.openaiBaseUrl) setOpenaiBaseUrl(gc.openaiBaseUrl);

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

  async function handleSave() {
    setIsSaving(true);
    try {
      await api.saveConfig({
        goldSources,
        generatorConfig: {
          provider,
          decompositionModel,
          arModel,
          clarifyModel,
          refineModel: refineModel || arModel,
          evaluateModel,
          themeModel: themeModel || evaluateModel,
          maxTokens: 8192,
          geminiApiKey: geminiApiKey.trim() || existingGeminiApiKey || "",
          geminiBaseUrl: geminiBaseUrl.trim() || undefined,
          openaiApiKey: openaiApiKey.trim() || existingOpenaiApiKey || "",
          openaiBaseUrl: openaiBaseUrl.trim() || undefined,
        },
        domainContext: domainContext.trim(),
        domainContexts,
        domainRoles: domainRoles.split(',').map((r: any) => r.trim()).filter(Boolean),
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
        tier,
      });
      if (geminiApiKey.trim()) setExistingGeminiApiKey(REDACTED);
      if (openaiApiKey.trim()) setExistingOpenaiApiKey(REDACTED);
      setGeminiApiKey(''); setOpenaiApiKey('');
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
      const res = await api.testLlmConnection({
        provider,
        model: clarifyModel,
        geminiApiKey: provider === 'gemini' ? (geminiApiKey.trim() || existingGeminiApiKey || undefined) : undefined,
        openaiApiKey: provider === 'openai' ? (openaiApiKey.trim() || existingOpenaiApiKey || undefined) : undefined,
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
    if (provider === 'gemini') {
      if (!decompositionModel.startsWith('gemini-')) setDecompositionModel('gemini-2.5-pro');
      if (!arModel.startsWith('gemini-')) setArModel('gemini-2.5-pro');
      if (!clarifyModel.startsWith('gemini-')) setClarifyModel('gemini-2.5-flash');
      if (!evaluateModel.startsWith('gemini-')) setEvaluateModel('gemini-2.5-flash');
      if (!refineModel.startsWith('gemini-')) setRefineModel('gemini-2.5-flash');
      if (!themeModel.startsWith('gemini-')) setThemeModel('gemini-2.5-flash');
    } else if (provider === 'openai') {
      if (!decompositionModel.startsWith('gpt-') && !decompositionModel.startsWith('o1-')) setDecompositionModel('gpt-4o');
      if (!arModel.startsWith('gpt-') && !arModel.startsWith('o1-')) setArModel('gpt-4o');
      if (!clarifyModel.startsWith('gpt-')) setClarifyModel('gpt-4o-mini');
      if (!evaluateModel.startsWith('gpt-')) setEvaluateModel('gpt-4o-mini');
      if (!refineModel.startsWith('gpt-')) setRefineModel('gpt-4o-mini');
      if (!themeModel.startsWith('gpt-')) setThemeModel('gpt-4o-mini');
    } else {
      if (decompositionModel.startsWith('gemini-') || decompositionModel.startsWith('gpt-')) setDecompositionModel('claude-opus-4-6');
      if (arModel.startsWith('gemini-') || arModel.startsWith('gpt-')) setArModel('claude-opus-4-6');
      if (clarifyModel.startsWith('gemini-') || clarifyModel.startsWith('gpt-')) setClarifyModel('claude-sonnet-4-5-20250929');
      if (evaluateModel.startsWith('gemini-') || evaluateModel.startsWith('gpt-')) setEvaluateModel('claude-haiku-4-5-20251001');
      if (refineModel.startsWith('gemini-') || refineModel.startsWith('gpt-')) setRefineModel('claude-sonnet-4-5-20250929');
      if (themeModel.startsWith('gemini-') || themeModel.startsWith('gpt-')) setThemeModel('claude-haiku-4-5-20251001');
    }
  }, [provider]); // eslint-disable-line

  const availableModels = useMemo(() => {
    if (provider === 'forge_llms') return CLAUDE_MODELS;
    if (provider === 'gemini' && (geminiApiKey || existingGeminiApiKey)) return GEMINI_MODELS;
    if (provider === 'openai' && (openaiApiKey || existingOpenaiApiKey)) return OPENAI_MODELS;
    return [];
  }, [provider, geminiApiKey, existingGeminiApiKey, openaiApiKey, existingOpenaiApiKey]);

  const settingsNav = [
    { id: 'models', label: 'AI Setup', icon: BrainCircuit, sub: 'Provider and models' },
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
    <div className="flex-1 flex flex-col h-full bg-transparent relative overflow-hidden font-sans">
      <header className="shrink-0 h-[88px] border-b border-[var(--rf-border)] bg-white flex items-center justify-between px-6 z-30 sticky top-0">
        <div className="flex items-center gap-5">
          <button onClick={onClose} className="p-2.5 rounded-2xl border border-[var(--rf-border)] bg-white text-[var(--rf-text-tertiary)] hover:bg-[var(--rf-surface-soft)] hover:text-[var(--rf-text)] transition-all group shadow-[var(--rf-shadow-sm)]">
             <ChevronLeft className="w-5 h-5 group-hover:-translate-x-0.5" />
          </button>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--rf-text-tertiary)]">Workspace Settings</div>
            <h2 className="mt-1 text-[24px] font-semibold tracking-[-0.03em] text-[var(--rf-text)]">Configure Refinely</h2>
            <p className="mt-1 text-xs text-[var(--rf-text-secondary)]">Set up AI, choose a Jira project, then add optional guidance only where it helps.</p>
            <div className="flex items-center gap-2 mt-0.5">
              <span className={`text-[9px] font-black px-2 py-0.5 rounded-full uppercase border ${isAdmin ? 'bg-green-100 text-green-700 border-green-200' : 'bg-red-100 text-red-700 border-red-200'}`}>
                {isAdmin ? 'Administrator' : 'Read-Only'}
              </span>
              <span className="text-[10px] text-[var(--rf-text-tertiary)] font-bold uppercase tracking-wider flex items-center gap-1">
                <ShieldCheck className="w-3 h-3 text-[var(--rf-brand)]" /> {tier} plan
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {isAdmin && activeTab !== 'jira' && (
            <button onClick={handleSave} disabled={isSaving} className="bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] disabled:opacity-50 text-white text-sm font-bold px-6 py-2.5 rounded-2xl shadow-[var(--rf-shadow-md)] transition-all active:scale-[0.98] flex items-center gap-2">
              {isSaving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Workspace
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-hidden flex bg-transparent">
          <div className="w-72 shrink-0 border-r border-[var(--rf-border)] bg-[linear-gradient(180deg,#fcfdff_0%,var(--rf-bg)_55%,var(--rf-bg-canvas)_100%)] p-6 flex flex-col gap-2">
            {settingsNav.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all ${
                  activeTab === tab.id ? 'bg-white text-[var(--rf-brand)] border-[rgba(0,82,204,0.12)] shadow-[var(--rf-shadow-sm)]' : 'text-[var(--rf-text-secondary)] border-transparent hover:bg-white/70'
                }`}
              >
                <tab.icon className={`w-4 h-4 ${activeTab === tab.id ? 'text-[var(--rf-brand)]' : 'text-[var(--rf-text-tertiary)]'}`} />
                <div className="text-left">
                  <div className="text-xs font-bold">{tab.label}</div>
                  <div className="text-[10px] text-[var(--rf-text-tertiary)]">{tab.sub}</div>
                </div>
              </button>
            ))}
            
            <div className="mt-auto px-3 py-5 border-t border-[var(--rf-border-subtle)]">
               <div className="rf-panel-soft rounded-2xl p-4 text-[var(--rf-text)] space-y-3">
                 <div>
                   <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-1">Recommended Order</div>
                   <div className="text-sm font-semibold">1. AI Setup</div>
                   <div className="text-sm font-semibold">2. Project Setup</div>
                   <div className="text-sm font-semibold">3. Guidance</div>
                 </div>
                 <div className="pt-3 border-t border-[var(--rf-border-subtle)]">
                   <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-1">Current Plan</div>
                   <div className="text-base font-bold capitalize">{tier}</div>
                   <div className="text-xs text-[var(--rf-text-secondary)] mt-1">
                     {usage?.currentMonth ?? 0} / {limits?.generationsPerMonth === -1 ? 'Unlimited' : limits?.generationsPerMonth ?? 0} generations
                   </div>
                 </div>
               </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-8 lg:p-10 space-y-10 custom-scrollbar">
            {activeTab === 'models' && (
              <div className="max-w-3xl space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="space-y-1">
                   <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--rf-text-tertiary)]">AI Setup</div>
                   <h3 className="text-3xl font-semibold text-[var(--rf-text)] tracking-[-0.04em]">Choose a provider and assign the core model roles</h3>
                   <p className="text-[var(--rf-text-secondary)] text-sm">You only need three things here: a provider, credentials, and which models handle the main reasoning steps.</p>
                </div>

                <div className="rf-panel rounded-[28px] p-6 space-y-6">
                  <div className="space-y-3">
                    <label className="text-xs font-bold text-[var(--rf-text)] uppercase tracking-wider">LLM Provider</label>
                    <div className="flex p-1 bg-[var(--rf-surface-soft)] rounded-xl border border-[var(--rf-border-subtle)]">
                      {(['openai', 'gemini', 'forge_llms'] as const).map(p => (
                        <button key={p} onClick={() => setProvider(p)} className={`flex-1 py-1.5 text-[10px] font-bold uppercase rounded-lg transition-all ${provider === p ? 'bg-white text-[var(--rf-brand)] shadow-sm' : 'text-[var(--rf-text-tertiary)]'}`}>
                          {p.replace('_', ' ')}
                        </button>
                      ))}
                    </div>
                  </div>

                  {provider === 'openai' && (
                    <div className="space-y-2 pt-2 animate-in slide-in-from-top-1">
                      <div className="flex justify-between items-center px-1">
                        <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">OpenAI API Key</label>
                        {existingOpenaiApiKey && <button onClick={() => { setExistingOpenaiApiKey(''); setOpenaiApiKey(''); }} className="text-[9px] font-bold text-red-500 hover:underline">Clear Stored</button>}
                      </div>
                      <input type="password" value={openaiApiKey} onChange={e => setOpenaiApiKey(e.target.value)} placeholder={existingOpenaiApiKey ? '••••••••• (Stored)' : 'sk-…'} disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-2.5 text-sm outline-none focus:border-blue-500" />
                    </div>
                  )}

                  {provider === 'gemini' && (
                    <div className="space-y-2 pt-2 animate-in slide-in-from-top-1">
                      <div className="flex justify-between items-center px-1">
                        <label className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Gemini API Key</label>
                        {existingGeminiApiKey && <button onClick={() => { setExistingGeminiApiKey(''); setGeminiApiKey(''); }} className="text-[9px] font-bold text-red-500 hover:underline">Clear Stored</button>}
                      </div>
                      <input type="password" value={geminiApiKey} onChange={e => setGeminiApiKey(e.target.value)} placeholder={existingGeminiApiKey ? '••••••••• (Stored)' : 'AIza…'} disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-2.5 text-sm outline-none focus:border-blue-500" />
                    </div>
                  )}

                  <div className="space-y-4 pt-4 border-t border-slate-100">
                    <div className="rounded-2xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-3 text-xs text-[var(--rf-text-secondary)]">
                      <span className="font-semibold text-[var(--rf-text)]">Keep it simple:</span> one stronger model for decomposition, one fast model for clarify/evaluation, and optionally a separate refine model later.
                    </div>
                    {[
                      { label: 'Decomposition Pass', val: decompositionModel, set: setDecompositionModel },
                      { label: 'Reasoning & Clarify', val: clarifyModel, set: setClarifyModel },
                      { label: 'Evaluation & Theme', val: evaluateModel, set: setEvaluateModel },
                    ].map((item, i) => (
                      <div key={i} className="flex items-center justify-between">
                        <span className="text-xs font-bold text-[var(--rf-text-secondary)]">{item.label}</span>
                        <select value={item.val} disabled={availableModels.length === 0} onChange={e => item.set(e.target.value)} className="bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-1.5 text-[11px] font-semibold text-[var(--rf-text)] min-w-[180px] outline-none">
                          {availableModels.length === 0 ? <option>Provider required...</option> : availableModels.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>

                  <div className="pt-4 flex items-center gap-4">
                    <button onClick={testLlmConnection} disabled={isTestingLlm} className="bg-[var(--rf-text)] hover:bg-slate-900 text-white text-[10px] font-bold uppercase tracking-widest px-5 py-2.5 rounded-xl transition-all flex items-center gap-2">
                       {isTestingLlm ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />} Test Connection
                    </button>
                    {llmTestResult && (
                      <div className={`px-3 py-1.5 rounded-lg text-[10px] font-bold flex items-center gap-2 border ${llmTestResult.ok ? 'bg-green-50 text-green-700 border-green-100' : 'bg-red-50 text-red-700 border-red-100'}`}>
                         {llmTestResult.ok ? <Check className="w-3.5 h-3.5" /> : <Info className="w-3.5 h-3.5" />} {llmTestResult.message}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'jira' && (
              <div className="max-w-4xl space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--rf-text-tertiary)]">Project Setup</div>
                    <h3 className="text-3xl font-semibold text-[var(--rf-text)] tracking-[-0.04em]">Set up one Jira project at a time</h3>
                    <p className="text-[var(--rf-text-secondary)] text-sm">Focus on the essentials first: sync Jira, choose a project, define backlog context, then add optional boosters like curated examples only if needed.</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-8">
                <div className="rf-panel rounded-[28px] p-8 space-y-8">
                  <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_0.9fr] gap-6">
                    <div className="rf-panel-soft rounded-[24px] p-6 space-y-5">
                      <div className="flex items-center justify-between gap-4">
                        <div className="space-y-1">
                          <div className="text-[10px] font-black uppercase tracking-widest text-[var(--rf-text-tertiary)]">Step 1</div>
                          <h4 className="text-base font-bold text-[var(--rf-text)]">Workspace Jira discovery</h4>
                          <p className="text-xs text-[var(--rf-text-secondary)]">Refresh projects and fields before editing project-specific rules.</p>
                        </div>
                        <button onClick={discoverJira} disabled={isDiscovering} className="bg-slate-100 hover:bg-slate-200 text-slate-700 text-[10px] font-bold uppercase tracking-widest px-5 py-2.5 rounded-xl transition-all flex items-center gap-2 border border-slate-200 shadow-sm">
                          {isDiscovering ? <RefreshCw className="w-3.5 h-3.5 animate-spin"/> : <RefreshCw className="w-3.5 h-3.5" />} Sync Jira
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="rounded-2xl border border-[var(--rf-border)] bg-white px-4 py-3">
                          <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Projects Found</div>
                          <div className="mt-1 text-lg font-semibold text-[var(--rf-text)]">{projects.length}</div>
                        </div>
                        <div className="rounded-2xl border border-[var(--rf-border)] bg-white px-4 py-3">
                          <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Custom Fields</div>
                          <div className="mt-1 text-lg font-semibold text-[var(--rf-text)]">{customFields.length}</div>
                        </div>
                      </div>
                    </div>

                    <div className="rf-panel-soft rounded-[24px] p-6 space-y-5">
                      <div className="space-y-1">
                        <div className="text-[10px] font-black uppercase tracking-widest text-[var(--rf-text-tertiary)]">Workspace Default</div>
                        <h4 className="text-base font-bold text-[var(--rf-text)]">Issue linking</h4>
                        <p className="text-xs text-[var(--rf-text-secondary)]">Used when a project does not override its Jira issue link type.</p>
                      </div>
                      <select value={issueLinkType} onChange={e => setIssueLinkType(e.target.value)} className="bg-white border border-[var(--rf-border)] px-4 py-3 rounded-xl text-sm font-semibold text-[var(--rf-text)] outline-none shadow-[var(--rf-shadow-sm)] w-full">
                        {['Relates to', 'Blocks', 'Clones', 'Duplicates'].map(l => <option key={l} value={l}>{l}</option>)}
                      </select>
                      {isAdmin && (
                        <button onClick={handleSave} disabled={isSaving} className="bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] disabled:opacity-50 text-white text-xs font-bold px-5 py-2.5 rounded-2xl shadow-[var(--rf-shadow-sm)] transition-all active:scale-[0.98] flex items-center gap-2">
                          {isSaving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                          Save Workspace Default
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="rf-panel-soft rounded-[24px] p-6 space-y-5">
                    <div className="space-y-1">
                      <div className="text-[10px] font-black uppercase tracking-widest text-[var(--rf-text-tertiary)]">Step 2</div>
                      <h4 className="text-base font-bold text-[var(--rf-text)]">Choose the project you want to configure</h4>
                      <p className="text-xs text-[var(--rf-text-secondary)]">Everything below applies only to this project: backlog cache scope, AR field mapping, project guidance, and optional curated examples.</p>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
                      <select value={activeArProj} onChange={e => setActiveArProj(e.target.value)} className="bg-white border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-semibold text-[var(--rf-text)] shadow-[var(--rf-shadow-sm)] focus:ring-2 focus:ring-blue-500/20 outline-none min-w-[240px]">
                        <option value="*">Select a project...</option>
                        {projects.map(p => <option key={p.key} value={p.key}>{p.key}: {p.name}</option>)}
                      </select>
                      <div className="text-xs text-[var(--rf-text-secondary)]">
                        {activeArProj !== '*' ? `Currently editing ${activeArProj}.` : 'Pick a Jira project to unlock project-specific setup.'}
                      </div>
                    </div>
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
                    <div className="rf-panel-soft rounded-[24px] p-10 text-center border border-dashed border-[var(--rf-border)]">
                      <Database className="w-10 h-10 text-[var(--rf-text-tertiary)]/40 mx-auto mb-4" />
                      <h4 className="text-base font-semibold text-[var(--rf-text)]">Select a project to continue</h4>
                      <p className="text-sm text-[var(--rf-text-secondary)] mt-2">Once a project is selected, you can define which deployed backlog items are indexed, how ARs are read, and whether curated examples should boost the output.</p>
                    </div>
                  )}

                  <div className="rf-panel-soft rounded-[24px] p-6 space-y-5">
                    <div className="flex items-center justify-between gap-4">
                      <div className="space-y-1">
                        <div className="text-[10px] font-black uppercase tracking-widest text-[var(--rf-text-tertiary)]">Step 3</div>
                        <h4 className="text-base font-bold text-[var(--rf-text)]">Project work instructions</h4>
                        <p className="text-xs text-[var(--rf-text-secondary)]">
                          Attach PDF instructions to the selected project so clarify and generation can reference them.
                        </p>
                      </div>
                      <button
                        onClick={() => wiFileInputRef.current?.click()}
                        disabled={activeArProj === '*' || !!wiUploadState}
                        className="bg-white border border-[var(--rf-border)] hover:bg-[var(--rf-surface-soft)] disabled:opacity-60 text-[var(--rf-text)] text-xs font-black px-5 py-2.5 rounded-xl shadow-[var(--rf-shadow-sm)] transition-all"
                      >
                        {wiUploadState ? 'Uploading…' : 'Add PDF'}
                      </button>
                      <input type="file" ref={wiFileInputRef} onChange={handleWiPdfDrop} accept=".pdf" className="hidden" disabled={activeArProj === '*' || !!wiUploadState} />
                    </div>

                    {activeArProj === '*' ? (
                      <div className="rounded-2xl border border-dashed border-[var(--rf-border)] bg-white px-4 py-5 text-sm text-[var(--rf-text-secondary)]">
                        Select a project first to manage project-specific work instructions.
                      </div>
                    ) : (
                      <>
                        {(wiUploadState || wiUploadError) && (
                          <div className={`rounded-2xl border p-4 ${wiUploadError ? 'border-red-200 bg-[var(--rf-danger-subtle)]' : 'border-[rgba(0,82,204,0.12)] bg-[var(--rf-brand-muted)]'}`}>
                            {wiUploadState && (
                              <div className="space-y-3">
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Upload In Progress</div>
                                    <div className="mt-1 text-sm font-semibold text-[var(--rf-text)]">{wiUploadState.filename}</div>
                                  </div>
                                  <div className="inline-flex items-center gap-2 text-[var(--rf-brand)] text-xs font-semibold">
                                    <RefreshCw className="w-4 h-4 animate-spin" />
                                    {wiUploadCopy}
                                  </div>
                                </div>
                                <div className="h-2 overflow-hidden rounded-full bg-white/70 border border-[rgba(0,82,204,0.08)]">
                                  <div className="h-full w-1/2 rounded-full bg-[var(--rf-brand)] animate-pulse" />
                                </div>
                              </div>
                            )}
                            {wiUploadError && (
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--rf-danger)]">Upload Failed</div>
                                  <p className="mt-1 text-sm text-[var(--rf-text)]">{wiUploadError}</p>
                                </div>
                                <button type="button" onClick={() => setWiUploadError(null)} className="rounded-xl border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-[var(--rf-danger)]">Dismiss</button>
                              </div>
                            )}
                          </div>
                        )}

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {wiDocs.length === 0 ? (
                            <div className="col-span-2 p-10 text-center border-2 border-dashed border-[var(--rf-border-subtle)] rounded-3xl bg-[var(--rf-surface-soft)]">
                              <FileText className="w-10 h-10 text-[var(--rf-text-tertiary)]/30 mx-auto mb-3" />
                              <p className="text-sm font-semibold text-[var(--rf-text-tertiary)]">No work instructions linked to {activeArProj}.</p>
                            </div>
                          ) : (
                            wiDocs.map(doc => (
                              <div key={doc.docId} className="rf-panel-soft p-4 rounded-2xl flex items-center justify-between group hover:bg-white transition-all duration-300">
                                <div className="flex items-center gap-3 truncate">
                                  <div className="shrink-0 w-9 h-9 bg-white rounded-lg border border-[var(--rf-border)] flex items-center justify-center">
                                    <FileText className="w-4 h-4 text-[var(--rf-text-tertiary)] font-light" />
                                  </div>
                                  <div className="truncate">
                                    <p className="text-xs font-bold text-[var(--rf-text)] truncate">{doc.filename}</p>
                                    <p className="text-[10px] text-[var(--rf-text-tertiary)] font-semibold uppercase">{doc.chunkCount} chunks</p>
                                  </div>
                                </div>
                                <button onClick={() => handleRemoveWiDoc(doc.docId)} className="text-[var(--rf-text-tertiary)] hover:text-red-500 transition-colors">
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
                </div>
              </div>
            )}

            {activeTab === 'domain' && (
              <div className="max-w-4xl space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="space-y-1">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--rf-text-tertiary)]">Guidance</div>
                  <h3 className="text-3xl font-semibold text-[var(--rf-text)] tracking-[-0.04em]">Set the shared guidance Refinely should follow</h3>
                  <p className="text-sm text-[var(--rf-text-secondary)]">Use this section for workspace-wide defaults only. Project-specific rules now live in Project Setup.</p>
                </div>
                <div className="rf-panel rounded-[32px] p-8 lg:p-10 space-y-10">
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-2xl bg-[var(--rf-brand-muted)] text-[var(--rf-brand)] flex items-center justify-center border border-[rgba(0,82,204,0.1)]"><Users className="w-6 h-6" /></div>
                      <div>
                        <h4 className="text-lg font-bold text-[var(--rf-text)]">Core persona roles</h4>
                        <p className="text-xs text-[var(--rf-text-secondary)] font-medium">Key stakeholders for story decomposition.</p>
                      </div>
                    </div>
                    <input value={domainRoles} onChange={e => setDomainRoles(e.target.value)} placeholder="e.g. Developer, QA Engineer, Project Manager" className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-2xl px-6 py-4 text-sm font-medium focus:ring-2 focus:ring-blue-500/20 outline-none" />
                  </div>

                  <div className="pt-10 border-t border-[var(--rf-border-subtle)] rounded-2xl border border-dashed border-[var(--rf-border)] bg-white px-5 py-4">
                    <div className="text-xs font-semibold text-[var(--rf-text)]">Project work instructions moved</div>
                    <p className="mt-1 text-xs text-[var(--rf-text-secondary)]">
                      Work instructions are project-scoped and are now managed in <span className="font-semibold">Jira Governance</span> after selecting a project.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'billing' && (
              <div className="max-w-4xl space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="space-y-1">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--rf-text-tertiary)]">Billing</div>
                  <h3 className="text-3xl font-semibold text-[var(--rf-text)] tracking-[-0.04em]">Plan, usage, and compliance controls</h3>
                </div>

                <div className="rf-panel rounded-[28px] p-8 space-y-6">
                  <div>
                    <p className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">Current Plan</p>
                    <h4 className="text-3xl font-black text-slate-900 capitalize mt-2">{tier}</h4>
                  </div>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm font-semibold text-slate-700">
                      <span>Generations this month</span>
                      <span>{usage?.currentMonth ?? 0} / {limits?.generationsPerMonth === -1 ? 'Unlimited' : limits?.generationsPerMonth ?? 0}</span>
                    </div>
                    {limits?.generationsPerMonth !== -1 && (
                      <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-600 transition-all duration-500"
                          style={{ width: usage ? `${Math.min(100, (usage.currentMonth / (limits?.generationsPerMonth || 1)) * 100)}%` : '0%' }}
                        />
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5">
                  {[
                    {
                      key: 'free',
                      name: 'Free',
                      price: 'Try it out',
                      highlights: ['Core generation', 'Limited monthly volume', 'Basic workspace setup'],
                    },
                    {
                      key: 'standard',
                      name: 'Standard',
                      price: 'For growing teams',
                      highlights: ['Higher monthly volume', 'Backlog context features', 'Project governance controls'],
                    },
                    {
                      key: 'premium',
                      name: 'Premium',
                      price: 'For advanced workflows',
                      highlights: ['Unlimited generations', 'Full automation support', 'Best fit for enterprise rollout'],
                    },
                    {
                      key: 'enterprise',
                      name: 'Enterprise',
                      price: 'Regulated industries',
                      highlights: ['Compliance Pack', 'PII masking and transparency reports', 'Immutable audit trail + Jira audit visibility'],
                    },
                  ].map(plan => {
                    const isCurrent = tier === plan.key;
                    return (
                      <div key={plan.key} className={`rounded-2xl border bg-white p-5 shadow-[var(--rf-shadow-sm)] ${isCurrent ? 'border-[var(--rf-brand)]' : 'border-[var(--rf-border)]'}`}>
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-lg font-bold text-[var(--rf-text)]">{plan.name}</div>
                            <div className="text-xs text-[var(--rf-text-secondary)] mt-1">{plan.price}</div>
                          </div>
                          {isCurrent && (
                            <span className="rounded-full bg-[var(--rf-brand-subtle)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--rf-brand)]">
                              Current
                            </span>
                          )}
                        </div>
                        <ul className="mt-4 space-y-2">
                          {plan.highlights.map(item => (
                            <li key={item} className="text-xs text-[var(--rf-text-secondary)] flex items-center gap-2">
                              <Check className="w-3.5 h-3.5 text-[var(--rf-brand)]" />
                              {item}
                            </li>
                          ))}
                        </ul>
                        <a
                          href="https://marketplace.atlassian.com"
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`mt-5 inline-flex w-full items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition ${
                            isCurrent
                              ? 'border-[var(--rf-border)] bg-white text-[var(--rf-text-secondary)] hover:bg-[var(--rf-surface-soft)]'
                              : 'border-[var(--rf-brand)] bg-[var(--rf-brand)] text-white hover:bg-[var(--rf-brand-hover)]'
                          }`}
                        >
                          {isCurrent ? 'Manage Plan' : 'Upgrade'}
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </div>
                    );
                  })}
                </div>

                <div className="rf-panel rounded-[28px] p-8 space-y-6">
                  <div>
                    <p className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">Compliance Pack</p>
                    <h4 className="text-2xl font-black text-slate-900 mt-2">GDPR + EU AI Act readiness</h4>
                    <p className="mt-2 text-sm text-[var(--rf-text-secondary)]">
                      Enable transparency reports, data minimization through PII masking, and immutable compliance audits.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {[
                      { key: 'enabled', label: 'Compliance mode', value: complianceEnabled, set: setComplianceEnabled },
                      { key: 'transparency', label: 'Transparency reports', value: transparencyEnabled, set: setTransparencyEnabled },
                      { key: 'pii', label: 'PII masking before LLM calls', value: piiMaskingEnabled, set: setPiiMaskingEnabled },
                      { key: 'audit', label: 'Immutable audit trail', value: auditTrailEnabled, set: setAuditTrailEnabled },
                    ].map(item => (
                      <label key={item.key} className="flex items-center justify-between rounded-xl border border-[var(--rf-border)] bg-white px-4 py-3 text-sm">
                        <span className="font-medium text-[var(--rf-text)]">{item.label}</span>
                        <input
                          type="checkbox"
                          checked={item.value}
                          onChange={(e) => item.set(e.target.checked)}
                          disabled={!isAdmin}
                          className="h-4 w-4 rounded border-[var(--rf-border)] text-[var(--rf-brand)] focus:ring-[var(--rf-brand)]"
                        />
                      </label>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                  <div className="rf-panel rounded-[24px] p-6 space-y-4">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-bold text-[var(--rf-text)]">Transparency reports</h4>
                      <span className="text-xs text-[var(--rf-text-tertiary)]">{transparencyReports.length} recent</span>
                    </div>
                    <div className="space-y-2 max-h-[260px] overflow-y-auto pr-1">
                      {transparencyReports.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-[var(--rf-border)] px-4 py-6 text-xs text-[var(--rf-text-tertiary)]">
                          No reports yet.
                        </div>
                      ) : (
                        transparencyReports.map((report) => (
                          <div key={report.reportId} className="rounded-xl border border-[var(--rf-border)] bg-white px-3 py-2.5">
                            <div className="flex items-center justify-between gap-2">
                              <div className="text-xs font-semibold text-[var(--rf-text)] uppercase">{report.turnType}</div>
                              <div className="text-[10px] text-[var(--rf-text-tertiary)]">{new Date(report.createdAt).toLocaleString()}</div>
                            </div>
                            <div className="mt-1 text-[11px] text-[var(--rf-text-secondary)]">
                              {(report.decisionSummary || []).slice(0, 1).join(' ') || 'No summary'}
                            </div>
                            <div className="mt-1 text-[10px] text-[var(--rf-text-tertiary)]">
                              PII redactions: {report.piiMasking?.totalRedactions ?? 0} • Tokens: {report.tokenUsage?.total ?? 0}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="rf-panel rounded-[24px] p-6 space-y-4">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-bold text-[var(--rf-text)]">Compliance audit trail</h4>
                      <span className="text-xs text-[var(--rf-text-tertiary)]">{complianceEvents.length} recent</span>
                    </div>
                    <div className="space-y-2 max-h-[260px] overflow-y-auto pr-1">
                      {complianceEvents.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-[var(--rf-border)] px-4 py-6 text-xs text-[var(--rf-text-tertiary)]">
                          No audit events yet.
                        </div>
                      ) : (
                        complianceEvents.map((event) => (
                          <div key={event.eventId} className="rounded-xl border border-[var(--rf-border)] bg-white px-3 py-2.5">
                            <div className="flex items-center justify-between gap-2">
                              <div className="text-xs font-semibold text-[var(--rf-text)]">{event.action}</div>
                              <div className="text-[10px] text-[var(--rf-text-tertiary)]">{new Date(event.timestamp).toLocaleString()}</div>
                            </div>
                            <div className="mt-1 text-[10px] uppercase tracking-wide text-[var(--rf-text-tertiary)]">{event.category}</div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                <div className="rf-panel rounded-[24px] p-6 space-y-3">
                  <h4 className="text-sm font-bold text-[var(--rf-text)]">Atlassian audit correlation</h4>
                  <p className="text-xs text-[var(--rf-text-secondary)]">
                    Recent Jira audit records are shown here for security/compliance teams to cross-check with app-level audit events.
                  </p>
                  <div className="text-xs text-[var(--rf-text-tertiary)]">
                    Jira audit records fetched: {jiraAuditRecords.length}
                  </div>
                </div>

                {isAdmin && (
                  <button onClick={handleResetUsage} className="px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-red-600 hover:text-white border border-red-200 hover:bg-red-600 rounded-xl transition-all">
                    Reset Usage Counter
                  </button>
                )}
              </div>
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
          setProjectNotice(`Backlog cache rebuilt, but returned 0 items. ${refreshed.diagnostics.likelyReason}`);
        } else {
          setProjectNotice('Backlog cache rebuilt, but 0 matching issues were found for the selected statuses.');
        }
      }
    } catch (e: any) {
      alert(e.message);
    } finally {
      setIsSavingProject(false);
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in">
      <div className="flex flex-col gap-4 border-b border-[var(--rf-border-subtle)] pb-6">
        <div>
          <div className="text-[10px] font-black uppercase tracking-widest text-[var(--rf-text-tertiary)]">Project Configuration</div>
          <h4 className="text-lg font-bold text-[var(--rf-text)]">Project setup for {activeArProj}</h4>
          <p className="text-sm text-[var(--rf-text-secondary)] mt-1">Start with backlog context and project guidance. Acceptance-criteria mapping and curated examples are there if you need them, but they are not required for every rollout.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="rounded-2xl border border-[var(--rf-border)] bg-white px-4 py-3">
            <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Required First</div>
            <div className="mt-1 text-sm font-semibold text-[var(--rf-text)]">Backlog context</div>
          </div>
          <div className="rounded-2xl border border-[var(--rf-border)] bg-white px-4 py-3">
            <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Usually Helpful</div>
            <div className="mt-1 text-sm font-semibold text-[var(--rf-text)]">Project guidance</div>
          </div>
          <div className="rounded-2xl border border-[var(--rf-border)] bg-white px-4 py-3">
            <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Advanced / Optional</div>
            <div className="mt-1 text-sm font-semibold text-[var(--rf-text)]">AR mapping and examples</div>
          </div>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          {projectNotice ? (
            <div className="text-xs font-semibold text-[var(--rf-brand)] bg-[var(--rf-brand-muted)] border border-[rgba(0,82,204,0.12)] rounded-2xl px-4 py-3">
              {projectNotice}
            </div>
          ) : (
            <div className="text-xs text-[var(--rf-text-secondary)]">
              Project admins can save project-only changes here without affecting the rest of the workspace.
            </div>
          )}
          {isProjectAdmin && (
            <div className="flex flex-wrap gap-2">
              <button onClick={handleSave} disabled={isSavingProject || isRefreshingBacklogCache} className="bg-white border border-[var(--rf-border)] hover:bg-[var(--rf-surface-soft)] text-[10px] font-bold uppercase tracking-widest px-5 py-3 rounded-2xl shadow-[var(--rf-shadow-sm)] transition-all flex items-center gap-2">
                {isSavingProject ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save Project
              </button>
              <button onClick={handleSaveAndRefresh} disabled={isSavingProject || isRefreshingBacklogCache} className="bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] text-white text-[10px] font-bold uppercase tracking-widest px-5 py-3 rounded-2xl shadow-[var(--rf-shadow-sm)] active:scale-[0.98] transition-all flex items-center gap-2">
                {(isSavingProject || isRefreshingBacklogCache) ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Save + Rebuild Cache
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
         <div className="col-span-full space-y-4">
           <button
             type="button"
             onClick={() => toggleSection('backlog')}
             className="w-full flex items-start justify-between gap-4 rounded-[24px] border border-[var(--rf-border)] bg-white px-5 py-4 text-left"
           >
             <div>
               <h5 className="text-[10px] font-black text-[var(--rf-text-tertiary)] uppercase tracking-widest flex items-center gap-2">
                 <Database className="w-3.5 h-3.5 text-[var(--rf-brand)]" /> Backlog Context
                 <span className="rounded-full bg-[var(--rf-brand-muted)] px-2 py-0.5 text-[9px] text-[var(--rf-brand)] border border-[rgba(0,82,204,0.1)]">Required</span>
               </h5>
               <p className="text-xs text-[var(--rf-text-secondary)] mt-1">
                 Choose which Jira statuses Refinely should treat as the usable backlog context for this project.
               </p>
             </div>
             <ChevronRight className={`w-4 h-4 mt-1 text-[var(--rf-text-tertiary)] transition-transform ${expandedSections.backlog ? 'rotate-90' : ''}`} />
           </button>

           {expandedSections.backlog && (
           <div className="rf-panel-soft rounded-[24px] p-6 space-y-5">
             <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
               <div className="rounded-2xl border border-[var(--rf-border)] bg-white px-4 py-3">
                 <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Indexed Items</div>
                 <div className="mt-1 text-lg font-semibold text-[var(--rf-text)]">{backlogCacheInfo?.issueCount ?? 0}</div>
               </div>
               <div className="rounded-2xl border border-[var(--rf-border)] bg-white px-4 py-3">
                 <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Last Built</div>
                 <div className="mt-1 text-sm font-semibold text-[var(--rf-text)]">
                   {backlogCacheInfo?.builtAt ? new Date(backlogCacheInfo.builtAt).toLocaleString() : 'Not built yet'}
                 </div>
               </div>
               <div className="rounded-2xl border border-[var(--rf-border)] bg-white px-4 py-3">
                 <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Refresh Policy</div>
                 <div className="mt-1 text-sm font-semibold text-[var(--rf-text)]">
                   {backlogCacheInfo?.stale ? 'Needs refresh' : 'Fresh'}
                 </div>
                 <div className="mt-1 text-[11px] text-[var(--rf-text-secondary)]">Weekly scheduled rebuild plus manual refresh anytime.</div>
               </div>
             </div>

             {backlogDiagnostics && (
               <div className="rounded-2xl border border-[var(--rf-border)] bg-white px-4 py-4 space-y-2">
                 <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Why This Count</div>
                 <div className="text-xs text-[var(--rf-text-secondary)]">{backlogDiagnostics.likelyReason}</div>
                 <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                   <div className="rounded-xl bg-[var(--rf-surface-soft)] px-3 py-2">
                     <div className="text-[10px] uppercase tracking-widest text-[var(--rf-text-tertiary)] font-bold">Project Issues</div>
                     <div className="mt-1 font-semibold text-[var(--rf-text)]">{backlogDiagnostics.totalProjectIssues}</div>
                   </div>
                   <div className="rounded-xl bg-[var(--rf-surface-soft)] px-3 py-2">
                     <div className="text-[10px] uppercase tracking-widest text-[var(--rf-text-tertiary)] font-bold">Done Category</div>
                     <div className="mt-1 font-semibold text-[var(--rf-text)]">{backlogDiagnostics.doneCategoryIssues}</div>
                   </div>
                   <div className="rounded-xl bg-[var(--rf-surface-soft)] px-3 py-2">
                     <div className="text-[10px] uppercase tracking-widest text-[var(--rf-text-tertiary)] font-bold">Matches Scope</div>
                     <div className="mt-1 font-semibold text-[var(--rf-text)]">{backlogDiagnostics.matchingScopeIssues}</div>
                   </div>
                 </div>
                 <div className="text-[11px] text-[var(--rf-text-tertiary)] font-mono break-all">JQL: {backlogDiagnostics.jqlUsed}</div>
               </div>
             )}

             <div className="flex items-center justify-between gap-3">
               <div className="text-xs font-semibold text-[var(--rf-text)]">
                 {effectiveBacklogStatuses.length} status{effectiveBacklogStatuses.length === 1 ? '' : 'es'} currently in scope
               </div>
               <div className="flex items-center gap-2">
                 <button
                   type="button"
                   onClick={() => updateBacklogStatuses(detectDefaultStatuses(backlogStatusOptions))}
                   className="text-[10px] font-bold text-[var(--rf-brand)] hover:text-[var(--rf-brand-hover)]"
                 >
                   Reset to done-like defaults
                 </button>
                 <button
                   type="button"
                   onClick={() => updateBacklogStatuses(backlogStatusOptions.map((status: any) => status.name))}
                   className="text-[10px] font-bold text-[var(--rf-brand)] hover:text-[var(--rf-brand-hover)]"
                 >
                   Select all
                 </button>
               </div>
             </div>

             <div className="flex flex-wrap gap-2">
               {backlogStatusOptions.map((status: any) => {
                 const selected = effectiveBacklogStatuses.includes(status.name);
                 const categoryLabel = status.statusCategory?.name || '';
                 return (
                   <button
                     key={status.name}
                     type="button"
                     onClick={() => updateBacklogStatuses(
                       selected
                         ? effectiveBacklogStatuses.filter((item: string) => item !== status.name)
                         : [...effectiveBacklogStatuses, status.name],
                     )}
                     className={`px-3 py-2 rounded-2xl text-left text-xs font-semibold border transition-colors ${selected ? 'bg-[var(--rf-brand-muted)] text-[var(--rf-brand)] border-[rgba(0,82,204,0.14)]' : 'bg-white text-[var(--rf-text-secondary)] border-[var(--rf-border)] hover:border-[var(--rf-border-strong)]'}`}
                   >
                     <span className="block">{status.name}</span>
                     {categoryLabel ? <span className="block text-[10px] opacity-70 mt-0.5">{categoryLabel}</span> : null}
                   </button>
                 );
               })}
             </div>

             <div className="rounded-2xl border border-[var(--rf-border)] bg-white px-4 py-3 text-[11px] text-[var(--rf-text-secondary)]">
               If you click <span className="font-semibold text-[var(--rf-text)]">Save + Rebuild Cache</span>, the current project settings are saved first and then the cache is rebuilt immediately using the selected statuses.
             </div>
           </div>
           )}
         </div>

         <div className="space-y-3">
            <button
              type="button"
              onClick={() => toggleSection('guidance')}
              className="w-full flex items-start justify-between gap-4 rounded-[24px] border border-[var(--rf-border)] bg-white px-5 py-4 text-left"
            >
              <div>
                <h5 className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest flex items-center gap-2">
                  Project Guidance
                  <span className="rounded-full bg-[var(--rf-surface-soft)] px-2 py-0.5 text-[9px] text-[var(--rf-text-secondary)] border border-[var(--rf-border-subtle)]">Recommended</span>
                </h5>
                <p className="text-xs text-[var(--rf-text-secondary)] mt-1">Optional writing or process rules that should apply only to this project.</p>
              </div>
              <ChevronRight className={`w-4 h-4 mt-1 text-[var(--rf-text-tertiary)] transition-transform ${expandedSections.guidance ? 'rotate-90' : ''}`} />
            </button>
            {expandedSections.guidance && (
              <textarea value={currentContext.context} onChange={e => updateContext(e.target.value)} placeholder="Guidelines for this project context..." className="w-full h-40 bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-2xl p-4 text-sm font-medium outline-none focus:ring-2 focus:ring-blue-500/20" />
            )}
         </div>

         <div className="space-y-6">
            <button
              type="button"
              onClick={() => toggleSection('mapping')}
              className="w-full flex items-start justify-between gap-4 rounded-[24px] border border-[var(--rf-border)] bg-white px-5 py-4 text-left"
            >
              <div>
                <h5 className="text-[10px] font-black text-[var(--rf-text-tertiary)] uppercase tracking-widest flex items-center gap-2">
                  <Layers className="w-3.5 h-3.5 text-[var(--rf-brand)]" /> AR Field Mapping
                  <span className="rounded-full bg-[var(--rf-surface-soft)] px-2 py-0.5 text-[9px] text-[var(--rf-text-secondary)] border border-[var(--rf-border-subtle)]">Advanced</span>
                </h5>
                <p className="text-xs text-[var(--rf-text-secondary)] mt-1">Only needed if acceptance criteria live in custom Jira fields or iterative slots.</p>
              </div>
              <ChevronRight className={`w-4 h-4 mt-1 text-[var(--rf-text-tertiary)] transition-transform ${expandedSections.mapping ? 'rotate-90' : ''}`} />
            </button>
            {expandedSections.mapping && (
            <div className="rf-panel-soft rounded-[24px] p-6 space-y-6">
               <div className="flex p-1 bg-white rounded-2xl border border-[var(--rf-border-subtle)] shadow-[var(--rf-shadow-sm)] max-w-[240px]">
                 <button onClick={() => updateMapping({ mode: 'consolidated' })} className={`flex-1 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-xl ${currentMapping.mode === 'consolidated' ? 'bg-[var(--rf-text)] text-white shadow-md' : 'text-[var(--rf-text-tertiary)]'}`}>Consolidated</button>
                 <button onClick={() => updateMapping({ mode: 'iterative' })} className={`flex-1 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-xl ${currentMapping.mode === 'iterative' ? 'bg-[var(--rf-text)] text-white shadow-md' : 'text-[var(--rf-text-tertiary)]'}`}>Iterative</button>
               </div>
               
               <div className="pt-2">
                 {currentMapping.mode === 'consolidated' ? (
                   <div className="flex items-center justify-between gap-4">
                     <span className="text-xs font-bold text-[var(--rf-text)]">Storage Field</span>
                     <FieldSelector value={currentMapping.consolidatedFieldId} onChange={(fid: string) => updateMapping({ consolidatedFieldId: fid })} customFields={customFields} />
                   </div>
                 ) : (
                   <div className="space-y-4">
                     {currentMapping.iterativeFieldIds.map((fid: string, i: number) => (
                       <div key={i} className="flex items-center gap-3">
                         <span className="text-[9px] font-black text-slate-300 min-w-[28px]">#{i+1}</span>
                         <div className="flex-1"><FieldSelector value={fid} onChange={(newF: string) => { const ids = [...currentMapping.iterativeFieldIds]; ids[i] = newF; updateMapping({ iterativeFieldIds: ids }); }} customFields={customFields} /></div>
                         <button onClick={() => updateMapping({ iterativeFieldIds: currentMapping.iterativeFieldIds.filter((_: any, idx: number) => idx !== i) })} className="text-slate-200 hover:text-red-500"><X className="w-4 h-4"/></button>
                       </div>
                     ))}
                     <button onClick={() => updateMapping({ iterativeFieldIds: [...currentMapping.iterativeFieldIds, ''] })} className="text-[10px] font-black text-blue-600 uppercase tracking-widest flex items-center gap-2">+ Add iteration slot</button>
                   </div>
                 )}
               </div>

               <div className="pt-6 border-t border-[var(--rf-border-subtle)] flex items-center justify-between">
                  <span className="text-xs font-bold text-[var(--rf-text)]">Issue Linking</span>
                  <select value={currentMapping.issueLinkType || ''} onChange={e => updateMapping({ issueLinkType: e.target.value })} className="bg-white border border-[var(--rf-border)] px-4 py-2 rounded-xl text-xs font-bold text-[var(--rf-text-secondary)] outline-none shadow-[var(--rf-shadow-sm)] min-w-[140px]">
                    <option value="">Global Default</option>
                    {['Relates to', 'Blocks', 'Clones', 'Duplicates'].map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
               </div>
            </div>
            )}
         </div>

         <div className="col-span-full space-y-6 pt-8 border-t border-[var(--rf-border-subtle)] animate-in fade-in slide-in-from-bottom-2 duration-500">
             <button
               type="button"
               onClick={() => toggleSection('examples')}
               className="w-full flex items-start justify-between gap-4 rounded-[24px] border border-[var(--rf-border)] bg-white px-5 py-4 text-left"
             >
               <div>
                 <h5 className="text-[11px] font-black text-[var(--rf-text)] uppercase tracking-widest flex items-center gap-2">
                   <Globe className="w-3.5 h-3.5 text-[var(--rf-brand)]" /> Curated Examples
                   <span className="rounded-full bg-[var(--rf-surface-soft)] px-2 py-0.5 text-[9px] text-[var(--rf-text-secondary)] border border-[var(--rf-border-subtle)]">Optional</span>
                 </h5>
                 <p className="text-xs text-[var(--rf-text-secondary)] mt-1">Use this only if you want to boost especially strong reference stories. Backlog context remains the primary source.</p>
               </div>
               <ChevronRight className={`w-4 h-4 mt-1 text-[var(--rf-text-tertiary)] transition-transform ${expandedSections.examples ? 'rotate-90' : ''}`} />
             </button>
             
             {expandedSections.examples && (
             <div className="space-y-5">
             {activeArProj !== '*' && (
                <div className="rf-panel rounded-[24px] p-6 space-y-5">
                  <div className="flex flex-wrap gap-4">
                    <div className="space-y-1.5 min-w-[220px]">
                      <span className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest ml-1">Source Project</span>
                      <select
                        className="bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-2.5 text-xs text-[var(--rf-text)] outline-none w-full"
                        onChange={e => onProjectSelect(e.target.value)}
                        value={newSource.project || ''}
                      >
                        <option value="">Select Project...</option>
                        {projects.map((p: any) => <option key={p.key} value={p.key}>{p.key}{p.key === activeArProj ? ' (Local)' : ''}</option>)}
                      </select>
                    </div>

                    <div className="space-y-1.5 min-w-[220px]">
                      <span className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest ml-1">Issue Type</span>
                      <select
                        className="bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-2.5 text-xs text-[var(--rf-text)] outline-none w-full"
                        onChange={e => setNewSource((p: any) => ({ ...p, issuetype: e.target.value }))}
                        value={newSource.issuetype || ''}
                      >
                        <option value="">Select Type...</option>
                        {issueTypes.map((it: any) => <option key={it.name} value={it.name}>{it.name}</option>)}
                      </select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest ml-1">Statuses In Scope</span>
                      <button
                        type="button"
                        onClick={() => setNewSource((p: any) => ({ ...p, statuses: statuses.map((s: any) => s.name), status: statuses[0]?.name || '' }))}
                        className="text-[10px] font-bold text-[var(--rf-brand)] hover:text-[var(--rf-brand-hover)]"
                      >
                        Select All
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {statuses.map((st: any) => {
                        const selected = selectedStatuses.includes(st.name);
                        return (
                          <button
                            key={st.name}
                            type="button"
                            onClick={() => toggleStatus(st.name)}
                            className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${selected ? 'bg-[var(--rf-brand-muted)] text-[var(--rf-brand)] border-[rgba(0,82,204,0.14)]' : 'bg-white text-[var(--rf-text-secondary)] border-[var(--rf-border)] hover:border-[var(--rf-border-strong)]'}`}
                          >
                            {st.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="pt-2">
                    <button
                      onClick={addGoldSource}
                      disabled={!newSource.project || !newSource.issuetype || selectedStatuses.length === 0}
                      className="bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] disabled:opacity-40 text-white text-xs font-bold px-6 py-2.5 rounded-2xl shadow-[var(--rf-shadow-sm)] transition-all"
                    >
                      Add Golden Source
                    </button>
                  </div>
                </div>
             )}
             
             <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pb-6">
                {currentGoldSources.length === 0 ? (
                  <div className="col-span-full py-16 text-center border-2 border-dashed border-[var(--rf-border)] rounded-[24px] bg-[var(--rf-surface-soft)]">
                     <BrainCircuit className="w-12 h-12 text-[var(--rf-text-tertiary)]/30 mx-auto mb-4" />
                     <p className="text-[10px] font-black text-[var(--rf-text-tertiary)] uppercase tracking-widest">No Active Golden Sources</p>
                     <p className="text-[11px] text-[var(--rf-text-secondary)] mt-2">The AI will use global defaults if no project sources are configured.</p>
                  </div>
                ) : (
                  currentGoldSources.map((s: any, idx: number) => (
                    <div key={idx} className="rf-panel-soft p-5 rounded-[24px] flex items-start justify-between gap-4">
                       <div className="space-y-2">
                         <div className="text-sm font-bold text-[var(--rf-text)]">{s.project} <span className="text-[var(--rf-text-secondary)]">/ {s.issuetype}</span></div>
                         <div className="flex flex-wrap gap-1.5">
                           {(Array.isArray(s.statuses) && s.statuses.length ? s.statuses : [s.status]).filter(Boolean).map((statusName: string) => (
                             <span key={statusName} className="px-2 py-0.5 rounded-full bg-white border border-[var(--rf-border)] text-[10px] font-semibold text-[var(--rf-text-secondary)]">
                               {statusName}
                             </span>
                           ))}
                         </div>
                       </div>
                       <button onClick={() => setGoldSources((p: any) => p.filter((x: any) => x !== s))} className="p-2 bg-white text-[var(--rf-text-tertiary)] hover:bg-red-50 hover:text-red-500 rounded-xl transition-all border border-[var(--rf-border)]">
                         <Trash className="w-4 h-4" />
                       </button>
                    </div>
                  ))
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
    <div className="relative w-full max-w-[280px]" ref={wrapperRef}>
      <button type="button" onClick={() => setIsOpen(!isOpen)} className="w-full bg-white border border-[var(--rf-border)] rounded-xl px-4 py-2.5 text-xs font-bold text-left flex justify-between items-center hover:border-[var(--rf-brand)] transition-all shadow-[var(--rf-shadow-sm)]">
        <span className="truncate text-[var(--rf-text)]">{selected ? selected.name : 'Select Field'} <span className="ml-1 text-[9px] text-[var(--rf-text-tertiary)] font-mono">({selected ? selected.id : '---'})</span></span>
        <ChevronRight className={`w-3.5 h-3.5 text-[var(--rf-text-tertiary)] transition-transform ${isOpen ? 'rotate-90' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute z-[100] top-full left-0 right-0 mt-2 bg-white border border-[var(--rf-border)] rounded-[18px] shadow-[var(--rf-shadow-lg)] overflow-hidden animate-in zoom-in-95 duration-100 flex flex-col">
          <div className="p-3 border-b border-[var(--rf-border-subtle)] bg-[var(--rf-surface-soft)]"><input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter fields..." className="w-full bg-white border border-[var(--rf-border)] rounded-2xl px-4 py-2 text-xs outline-none" /></div>
          <div className="max-h-[240px] overflow-y-auto custom-scrollbar">
            {filtered.map((f: any) => (
              <button key={f.id} onClick={() => { onChange(f.id); setIsOpen(false); setSearch(''); }} className={`w-full text-left px-5 py-3.5 text-xs hover:bg-[var(--rf-surface-soft)] transition-colors flex flex-col gap-0.5 border-b border-[var(--rf-border-subtle)] last:border-0 ${value === f.id ? 'bg-[var(--rf-brand-muted)]/70' : ''}`}>
                <span className={`font-black uppercase tracking-tight ${value === f.id ? 'text-[var(--rf-brand)]' : 'text-[var(--rf-text)]'}`}>{f.name}</span>
                <span className="text-[9px] text-[var(--rf-text-tertiary)] font-mono tracking-tighter">{f.id}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
