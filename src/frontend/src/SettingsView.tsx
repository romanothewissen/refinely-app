import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { 
  Database, BrainCircuit, Globe, X, RefreshCw, Save, CreditCard, ChevronLeft, ShieldCheck, 
  Users, FileText, ChevronRight, Check, Trash, Layers, Zap, Info, ExternalLink, AlertCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
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
    <div className="flex-1 flex flex-col h-full bg-slate-50 relative overflow-hidden font-sans">
      <header className="shrink-0 h-[88px] border-b border-slate-200 bg-white/80 backdrop-blur-md flex items-center justify-between px-8 z-30 sticky top-0 shadow-sm">
        <div className="flex items-center gap-5">
          <motion.button 
            onClick={onClose} 
            className="p-2.5 rounded-xl border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-900 transition-all shadow-sm"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
             <ChevronLeft className="w-5 h-5" />
          </motion.button>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Workspace Settings</div>
            <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">Configure Refinely</h2>
            <div className="flex items-center gap-2 mt-1.5">
              <span className={`text-[9px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wider border ${isAdmin ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : 'bg-rose-50 text-rose-600 border-rose-200'}`}>
                {isAdmin ? 'Administrator' : 'Read-Only'}
              </span>
              <span className="text-[10px] text-blue-600 font-bold uppercase tracking-wider flex items-center gap-1 bg-blue-50 px-2 py-0.5 rounded-md border border-blue-100">
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
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:bg-slate-400 text-white text-sm font-bold px-6 py-2.5 rounded-xl shadow-md shadow-blue-600/20 transition-all flex items-center gap-2"
              whileTap={{ scale: 0.98 }}
            >
              {isSaving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Workspace
            </motion.button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-hidden flex">
          <div className="w-72 shrink-0 border-r border-slate-200 bg-slate-50/50 p-6 flex flex-col gap-2">
            {settingsNav.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all ${
                  activeTab === tab.id ? 'bg-white text-blue-600 border-slate-200 shadow-sm' : 'text-slate-500 border-transparent hover:bg-slate-100 hover:text-slate-700'
                }`}
              >
                <tab.icon className={`w-4 h-4 ${activeTab === tab.id ? 'text-blue-600' : 'text-slate-400'}`} />
                <div className="text-left">
                  <div className={`text-xs font-bold ${activeTab === tab.id ? 'text-blue-700' : 'text-slate-700'}`}>{tab.label}</div>
                  <div className={`text-[10px] mt-0.5 ${activeTab === tab.id ? 'text-blue-500' : 'text-slate-400'}`}>{tab.sub}</div>
                </div>
              </button>
            ))}
            
            <div className="mt-auto pt-6 border-t border-slate-200">
               <div className="bg-white rounded-xl p-4 border border-slate-200 shadow-sm">
                 <div>
                   <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">Recommended Order</div>
                   <div className="text-xs font-semibold text-slate-700 space-y-1.5">
                     <div>1. AI Setup</div>
                     <div>2. Project Setup</div>
                     <div>3. Guidance</div>
                   </div>
                 </div>
                 <div className="pt-4 mt-4 border-t border-slate-100">
                   <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Current Plan</div>
                   <div className="text-sm font-bold text-slate-900 capitalize">{tier}</div>
                   <div className="text-[11px] font-medium text-slate-500 mt-1">
                     {usage?.currentMonth ?? 0} / {limits?.generationsPerMonth === -1 ? 'Unlimited' : limits?.generationsPerMonth ?? 0} generations
                   </div>
                 </div>
               </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-8 lg:p-10 custom-scrollbar bg-slate-50/50">
            {activeTab === 'models' && (
              <motion.div 
                className="max-w-3xl space-y-6"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
              >
                <div className="space-y-1">
                   <h3 className="text-2xl font-bold text-slate-900 tracking-tight">AI Provider & Models</h3>
                   <p className="text-slate-500 text-sm">Configure your LLM provider and specify which models handle the distinct reasoning steps.</p>
                </div>

                <div className="bg-white rounded-2xl p-6 lg:p-8 border border-slate-200 shadow-sm space-y-8">
                  <div className="space-y-3">
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">LLM Provider</label>
                    <div className="flex p-1 bg-slate-100 rounded-xl border border-slate-200">
                      {(['openai', 'gemini', 'forge_llms'] as const).map(p => (
                        <button key={p} onClick={() => setProvider(p)} className={`flex-1 py-2 text-[11px] font-bold uppercase tracking-wider rounded-lg transition-all ${provider === p ? 'bg-white text-blue-600 shadow-sm border border-slate-200/50' : 'text-slate-500 hover:text-slate-700'}`}>
                          {p.replace('_', ' ')}
                        </button>
                      ))}
                    </div>
                  </div>

                  {provider === 'openai' && (
                    <motion.div className="space-y-2" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                      <div className="flex justify-between items-center px-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">OpenAI API Key</label>
                        {existingOpenaiApiKey && <button onClick={() => { setExistingOpenaiApiKey(''); setOpenaiApiKey(''); }} className="text-[10px] font-bold text-rose-500 hover:text-rose-700">Clear Stored</button>}
                      </div>
                      <input type="password" value={openaiApiKey} onChange={e => setOpenaiApiKey(e.target.value)} placeholder={existingOpenaiApiKey ? '••••••••• (Stored)' : 'sk-…'} disabled={!isAdmin} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all outline-none" />
                    </motion.div>
                  )}

                  {provider === 'gemini' && (
                    <motion.div className="space-y-2" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                      <div className="flex justify-between items-center px-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Gemini API Key</label>
                        {existingGeminiApiKey && <button onClick={() => { setExistingGeminiApiKey(''); setGeminiApiKey(''); }} className="text-[10px] font-bold text-rose-500 hover:text-rose-700">Clear Stored</button>}
                      </div>
                      <input type="password" value={geminiApiKey} onChange={e => setGeminiApiKey(e.target.value)} placeholder={existingGeminiApiKey ? '••••••••• (Stored)' : 'AIza…'} disabled={!isAdmin} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all outline-none" />
                    </motion.div>
                  )}

                  <div className="space-y-5 pt-6 border-t border-slate-100">
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600 flex items-start gap-3">
                      <Info className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                      <p><span className="font-bold text-slate-900">Best practice:</span> use a stronger model for decomposition and a faster model for clarify and evaluation.</p>
                    </div>
                    
                    <div className="space-y-4">
                      {[
                        { label: 'Decomposition Pass', val: decompositionModel, set: setDecompositionModel },
                        { label: 'Reasoning & Clarify', val: clarifyModel, set: setClarifyModel },
                        { label: 'Evaluation & Theme', val: evaluateModel, set: setEvaluateModel },
                      ].map((item, i) => (
                        <div key={i} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                          <span className="text-sm font-bold text-slate-700">{item.label}</span>
                          <select value={item.val} disabled={availableModels.length === 0} onChange={e => item.set(e.target.value)} className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-semibold text-slate-900 sm:w-[240px] focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition">
                            {availableModels.length === 0 ? <option>Provider required...</option> : availableModels.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                          </select>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="pt-6 border-t border-slate-100 flex items-center gap-4">
                    <motion.button 
                      onClick={testLlmConnection} 
                      disabled={isTestingLlm} 
                      className="bg-slate-900 hover:bg-black text-white text-[11px] font-bold uppercase tracking-widest px-5 py-2.5 rounded-lg transition-all flex items-center gap-2"
                      whileTap={{ scale: 0.98 }}
                    >
                       {isTestingLlm ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />} Test Connection
                    </motion.button>
                    {llmTestResult && (
                      <div className={`px-4 py-2.5 rounded-lg text-[11px] font-bold flex items-center gap-2 border ${llmTestResult.ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200'}`}>
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
                  <h3 className="text-2xl font-bold text-slate-900 tracking-tight">Project Setup</h3>
                  <p className="text-slate-500 text-sm">Sync Jira, select a project, and define its backlog context and optional boosters.</p>
                </div>

                <div className="space-y-6">
                  {/* Step 1 */}
                  <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-6">
                    <div className="space-y-1">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Step 1</div>
                      <h4 className="text-lg font-bold text-slate-900">Workspace Jira Discovery</h4>
                      <p className="text-xs font-medium text-slate-500">Refresh projects and fields before editing project rules.</p>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="flex gap-4 mr-2">
                        <div className="text-center">
                          <div className="text-2xl font-black text-slate-900">{projects.length}</div>
                          <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400">Projects</div>
                        </div>
                        <div className="w-px bg-slate-200"></div>
                        <div className="text-center">
                          <div className="text-2xl font-black text-slate-900">{customFields.length}</div>
                          <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400">Fields</div>
                        </div>
                      </div>
                      <motion.button 
                        onClick={discoverJira} 
                        disabled={isDiscovering} 
                        className="bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-bold uppercase tracking-widest px-5 py-3 rounded-xl transition-all flex items-center gap-2 border border-slate-200"
                        whileTap={{ scale: 0.98 }}
                      >
                        <RefreshCw className={`w-4 h-4 ${isDiscovering ? 'animate-spin' : ''}`} /> Sync
                      </motion.button>
                    </div>
                  </div>

                  {/* Step 2 Selection */}
                  <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="space-y-1">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Step 2</div>
                      <h4 className="text-lg font-bold text-slate-900">Select Project</h4>
                    </div>
                    <select 
                      value={activeArProj} 
                      onChange={e => setActiveArProj(e.target.value)} 
                      className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold text-slate-900 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none sm:w-64 transition"
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
                    <div className="bg-white rounded-2xl p-12 text-center border-2 border-dashed border-slate-200">
                      <Database className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                      <h4 className="text-lg font-bold text-slate-900">Select a project to configure</h4>
                      <p className="text-sm font-medium text-slate-500 mt-2 max-w-md mx-auto">Define backlog indexing scope, work instructions, and optional curated examples for the selected project.</p>
                    </div>
                  )}

                  {/* Step 3 WIs */}
                  <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm space-y-6">
                    <div className="flex items-center justify-between gap-4">
                      <div className="space-y-1">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Step 3</div>
                        <h4 className="text-lg font-bold text-slate-900">Project Work Instructions</h4>
                        <p className="text-xs font-medium text-slate-500">Attach PDFs to inform AI generation for this project.</p>
                      </div>
                      <motion.button
                        onClick={() => wiFileInputRef.current?.click()}
                        disabled={activeArProj === '*' || !!wiUploadState}
                        className="bg-slate-900 hover:bg-black disabled:bg-slate-300 text-white text-[11px] font-bold uppercase tracking-widest px-5 py-2.5 rounded-lg shadow-sm transition-all"
                        whileTap={{ scale: 0.98 }}
                      >
                        {wiUploadState ? 'Uploading…' : 'Add PDF'}
                      </motion.button>
                      <input type="file" ref={wiFileInputRef} onChange={handleWiPdfDrop} accept=".pdf" className="hidden" disabled={activeArProj === '*' || !!wiUploadState} />
                    </div>

                    {activeArProj === '*' ? (
                      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm font-medium text-slate-500 text-center">
                        Select a project first to manage instructions.
                      </div>
                    ) : (
                      <>
                        {(wiUploadState || wiUploadError) && (
                          <div className={`rounded-xl border p-4 ${wiUploadError ? 'border-rose-200 bg-rose-50' : 'border-blue-200 bg-blue-50'}`}>
                            {wiUploadState && (
                              <div className="space-y-3">
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <div className="text-[10px] font-bold uppercase tracking-widest text-blue-500">Upload In Progress</div>
                                    <div className="mt-1 text-sm font-bold text-slate-900">{wiUploadState.filename}</div>
                                  </div>
                                  <div className="inline-flex items-center gap-2 text-blue-600 text-xs font-bold">
                                    <RefreshCw className="w-4 h-4 animate-spin" />
                                    {wiUploadCopy}
                                  </div>
                                </div>
                                <div className="h-1.5 overflow-hidden rounded-full bg-blue-100">
                                  <div className="h-full w-1/2 rounded-full bg-blue-500 animate-pulse" />
                                </div>
                              </div>
                            )}
                            {wiUploadError && (
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <div className="text-[10px] font-bold uppercase tracking-widest text-rose-500">Upload Failed</div>
                                  <p className="mt-1 text-sm font-bold text-slate-900">{wiUploadError}</p>
                                </div>
                                <button type="button" onClick={() => setWiUploadError(null)} className="rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-rose-600 border border-rose-200">Dismiss</button>
                              </div>
                            )}
                          </div>
                        )}

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {wiDocs.length === 0 ? (
                            <div className="col-span-2 p-8 text-center border-2 border-dashed border-slate-200 rounded-xl bg-slate-50">
                              <FileText className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                              <p className="text-sm font-semibold text-slate-500">No work instructions linked to {activeArProj}.</p>
                            </div>
                          ) : (
                            wiDocs.map(doc => (
                              <div key={doc.docId} className="bg-slate-50 p-4 rounded-xl border border-slate-200 flex items-center justify-between group hover:border-slate-300 transition-all">
                                <div className="flex items-center gap-3 truncate">
                                  <div className="shrink-0 w-10 h-10 bg-white rounded-lg border border-slate-200 flex items-center justify-center shadow-sm">
                                    <FileText className="w-5 h-5 text-blue-500" />
                                  </div>
                                  <div className="truncate">
                                    <p className="text-sm font-bold text-slate-900 truncate">{doc.filename}</p>
                                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-0.5">{doc.chunkCount} chunks</p>
                                  </div>
                                </div>
                                <button onClick={() => handleRemoveWiDoc(doc.docId)} className="text-slate-400 hover:text-rose-500 p-2 rounded-lg hover:bg-rose-50 transition-colors">
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
                  <h3 className="text-2xl font-bold text-slate-900 tracking-tight">Workspace Guidance</h3>
                  <p className="text-sm font-medium text-slate-500">Global defaults for the workspace. Project-specific rules live in Project Setup.</p>
                </div>
                <div className="bg-white rounded-2xl p-6 lg:p-8 border border-slate-200 shadow-sm space-y-8">
                  <div className="space-y-4">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-100 shadow-sm"><Users className="w-6 h-6" /></div>
                      <div>
                        <h4 className="text-base font-bold text-slate-900">Core persona roles</h4>
                        <p className="text-xs font-medium text-slate-500">Key stakeholders to consider during generation.</p>
                      </div>
                    </div>
                    <input value={domainRoles} onChange={e => setDomainRoles(e.target.value)} placeholder="e.g. Developer, QA Engineer, Product Manager" className="w-full bg-slate-50 border border-slate-200 rounded-xl px-5 py-3.5 text-sm font-bold text-slate-900 focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition" />
                  </div>

                  <div className="space-y-4 pt-6 border-t border-slate-100">
                    <div>
                      <h4 className="text-base font-bold text-slate-900">Issue linking default</h4>
                      <p className="text-xs font-medium text-slate-500 mt-0.5">Used when a project does not override its Jira issue link type.</p>
                    </div>
                    <select value={issueLinkType} onChange={e => setIssueLinkType(e.target.value)} className="bg-slate-50 border border-slate-200 px-4 py-3 rounded-xl text-sm font-bold text-slate-900 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none w-full max-w-sm transition">
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
                  <h3 className="text-2xl font-bold text-slate-900 tracking-tight">Billing & Compliance</h3>
                </div>

                <div className="bg-white rounded-2xl p-8 border border-slate-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-6">
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">Current Plan</p>
                    <h4 className="text-3xl font-black text-blue-600 capitalize mt-1">{tier}</h4>
                  </div>
                  <div className="flex-1 max-w-sm space-y-2">
                    <div className="flex justify-between text-sm font-bold text-slate-700">
                      <span>Generations this month</span>
                      <span>{usage?.currentMonth ?? 0} <span className="text-slate-400 font-medium">/ {limits?.generationsPerMonth === -1 ? 'Unlimited' : limits?.generationsPerMonth ?? 0}</span></span>
                    </div>
                    {limits?.generationsPerMonth !== -1 && (
                      <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden shadow-inner">
                        <div
                          className="h-full bg-blue-500 transition-all duration-500"
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
                      <div key={plan.key} className={`rounded-2xl border bg-white p-5 flex flex-col shadow-sm transition-all ${isCurrent ? 'border-blue-500 shadow-md shadow-blue-500/10' : 'border-slate-200 hover:border-slate-300'}`}>
                        <div className="mb-4">
                          <div className="flex items-center justify-between">
                            <div className={`text-lg font-black ${isCurrent ? 'text-blue-600' : 'text-slate-900'}`}>{plan.name}</div>
                            {isCurrent && <span className="bg-blue-50 text-blue-600 text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-md border border-blue-100">Current</span>}
                          </div>
                          <div className="text-xs font-semibold text-slate-500 mt-1">{plan.price}</div>
                        </div>
                        <ul className="space-y-2.5 mb-6 flex-1">
                          {plan.highlights.map(item => (
                            <li key={item} className="text-xs font-medium text-slate-600 flex items-start gap-2">
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
                              ? 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'
                              : 'border-slate-900 bg-slate-900 text-white hover:bg-black'
                          }`}
                        >
                          {isCurrent ? 'Manage Plan' : 'Upgrade'}
                        </a>
                      </div>
                    );
                  })}
                </div>

                <div className="bg-white rounded-2xl p-6 lg:p-8 border border-slate-200 shadow-sm space-y-6">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <ShieldCheck className="w-5 h-5 text-indigo-600" />
                      <p className="text-[11px] uppercase tracking-widest text-indigo-600 font-bold">Compliance Pack</p>
                    </div>
                    <h4 className="text-xl font-bold text-slate-900">GDPR + EU AI Act readiness</h4>
                    <p className="mt-1 text-sm font-medium text-slate-500">
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
                      <label key={item.key} className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3.5 cursor-pointer hover:bg-slate-100 transition">
                        <span className="font-bold text-sm text-slate-700">{item.label}</span>
                        <input
                          type="checkbox"
                          checked={item.value}
                          onChange={(e) => item.set(e.target.checked)}
                          disabled={!isAdmin}
                          className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        />
                      </label>
                    ))}
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
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-t border-slate-200 pt-6">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-blue-600 mb-1">Editing Project</div>
          <h4 className="text-xl font-bold text-slate-900">{activeArProj} Configuration</h4>
        </div>
        {isProjectAdmin && (
          <div className="flex flex-wrap gap-2">
            <motion.button 
              onClick={handleSave} 
              disabled={isSavingProject || isRefreshingBacklogCache} 
              className="bg-white border border-slate-200 hover:bg-slate-50 text-[10px] font-bold uppercase tracking-widest px-4 py-2.5 rounded-xl shadow-sm transition-all flex items-center gap-2 text-slate-700"
              whileTap={{ scale: 0.98 }}
            >
              {isSavingProject ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
            </motion.button>
            <motion.button 
              onClick={handleSaveAndRefresh} 
              disabled={isSavingProject || isRefreshingBacklogCache} 
              className="bg-slate-900 hover:bg-black text-white text-[10px] font-bold uppercase tracking-widest px-4 py-2.5 rounded-xl shadow-sm transition-all flex items-center gap-2"
              whileTap={{ scale: 0.98 }}
            >
              {(isSavingProject || isRefreshingBacklogCache) ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Save & Rebuild
            </motion.button>
          </div>
        )}
      </div>

      {projectNotice && (
        <div className="text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 flex items-center gap-2">
          <Check className="w-4 h-4" /> {projectNotice}
        </div>
      )}

      <div className="space-y-4">
         <div className="space-y-3">
           <button
             type="button"
             onClick={() => toggleSection('backlog')}
             className="w-full flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white px-5 py-4 text-left shadow-sm hover:border-slate-300 transition"
           >
             <div className="flex items-center gap-3">
               <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center border border-blue-100"><Database className="w-4 h-4 text-blue-600" /></div>
               <div>
                 <h5 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                   Backlog Context
                   <span className="rounded-md bg-rose-50 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-rose-600 border border-rose-100">Required</span>
                 </h5>
                 <p className="text-xs font-medium text-slate-500 mt-0.5">Define Jira statuses for AI context.</p>
               </div>
             </div>
             <ChevronRight className={`w-5 h-5 text-slate-400 transition-transform ${expandedSections.backlog ? 'rotate-90' : ''}`} />
           </button>

           {expandedSections.backlog && (
           <div className="bg-slate-50 rounded-xl p-5 border border-slate-200 space-y-5">
             <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
               <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                 <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Indexed Items</div>
                 <div className="mt-1 text-xl font-black text-slate-900">{backlogCacheInfo?.issueCount ?? 0}</div>
               </div>
               <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                 <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Last Built</div>
                 <div className="mt-1 text-sm font-bold text-slate-700">
                   {backlogCacheInfo?.builtAt ? new Date(backlogCacheInfo.builtAt).toLocaleString() : 'Not built yet'}
                 </div>
               </div>
               <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                 <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Status</div>
                 <div className="mt-1 text-sm font-bold text-slate-700 flex items-center gap-1.5">
                   {backlogCacheInfo?.stale ? <><AlertCircle className="w-4 h-4 text-amber-500"/> Needs refresh</> : <><Check className="w-4 h-4 text-emerald-500"/> Fresh</>}
                 </div>
               </div>
             </div>

             <div className="space-y-3 pt-2">
               <div className="flex items-center justify-between">
                 <div className="text-sm font-bold text-slate-900">
                   {effectiveBacklogStatuses.length} status{effectiveBacklogStatuses.length === 1 ? '' : 'es'} in scope
                 </div>
                 <div className="flex gap-2">
                   <button onClick={() => updateBacklogStatuses(detectDefaultStatuses(backlogStatusOptions))} className="text-[10px] font-bold uppercase tracking-widest text-blue-600 hover:text-blue-800 bg-blue-50 px-2 py-1 rounded">Default</button>
                   <button onClick={() => updateBacklogStatuses(backlogStatusOptions.map((status: any) => status.name))} className="text-[10px] font-bold uppercase tracking-widest text-blue-600 hover:text-blue-800 bg-blue-50 px-2 py-1 rounded">All</button>
                 </div>
               </div>
               <div className="flex flex-wrap gap-2">
                 {backlogStatusOptions.map((status: any) => {
                   const selected = effectiveBacklogStatuses.includes(status.name);
                   return (
                     <button
                       key={status.name}
                       onClick={() => updateBacklogStatuses(selected ? effectiveBacklogStatuses.filter((item: string) => item !== status.name) : [...effectiveBacklogStatuses, status.name])}
                       className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${selected ? 'bg-blue-600 text-white border-blue-600 shadow-md shadow-blue-600/20' : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300'}`}
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
              className="w-full flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white px-5 py-4 text-left shadow-sm hover:border-slate-300 transition"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center border border-indigo-100"><Globe className="w-4 h-4 text-indigo-600" /></div>
                <div>
                  <h5 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    Project Guidance
                    <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-slate-500 border border-slate-200">Recommended</span>
                  </h5>
                  <p className="text-xs font-medium text-slate-500 mt-0.5">Rules or context specific to this project.</p>
                </div>
              </div>
              <ChevronRight className={`w-5 h-5 text-slate-400 transition-transform ${expandedSections.guidance ? 'rotate-90' : ''}`} />
            </button>
            {expandedSections.guidance && (
              <div className="bg-slate-50 rounded-xl p-5 border border-slate-200">
                <textarea value={currentContext.context} onChange={e => updateContext(e.target.value)} placeholder="e.g. Ensure all stories include accessibility requirements..." className="w-full h-32 bg-white border border-slate-200 rounded-xl p-4 text-sm font-medium outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition shadow-sm resize-none" />
              </div>
            )}
         </div>

         <div className="space-y-3">
            <button
              type="button"
              onClick={() => toggleSection('mapping')}
              className="w-full flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white px-5 py-4 text-left shadow-sm hover:border-slate-300 transition"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center border border-emerald-100"><Layers className="w-4 h-4 text-emerald-600" /></div>
                <div>
                  <h5 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    AR Field Mapping
                    <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-slate-500 border border-slate-200">Advanced</span>
                  </h5>
                  <p className="text-xs font-medium text-slate-500 mt-0.5">Map where Acceptance Criteria go.</p>
                </div>
              </div>
              <ChevronRight className={`w-5 h-5 text-slate-400 transition-transform ${expandedSections.mapping ? 'rotate-90' : ''}`} />
            </button>
            {expandedSections.mapping && (
            <div className="bg-slate-50 rounded-xl p-5 border border-slate-200 space-y-5">
               <div className="flex p-1 bg-white rounded-lg border border-slate-200 shadow-sm max-w-[240px]">
                 <button onClick={() => updateMapping({ mode: 'consolidated' })} className={`flex-1 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded-md transition ${currentMapping.mode === 'consolidated' ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>Consolidated</button>
                 <button onClick={() => updateMapping({ mode: 'iterative' })} className={`flex-1 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded-md transition ${currentMapping.mode === 'iterative' ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>Iterative</button>
               </div>
               
               <div>
                 {currentMapping.mode === 'consolidated' ? (
                   <div className="flex items-center justify-between gap-4 bg-white p-3 rounded-xl border border-slate-200">
                     <span className="text-xs font-bold text-slate-700">Storage Field</span>
                     <FieldSelector value={currentMapping.consolidatedFieldId} onChange={(fid: string) => updateMapping({ consolidatedFieldId: fid })} customFields={customFields} />
                   </div>
                 ) : (
                   <div className="space-y-3">
                     {currentMapping.iterativeFieldIds.map((fid: string, i: number) => (
                       <div key={i} className="flex items-center gap-3 bg-white p-2 rounded-xl border border-slate-200">
                         <span className="text-[10px] font-black text-slate-400 min-w-[24px] text-center">#{i+1}</span>
                         <div className="flex-1"><FieldSelector value={fid} onChange={(newF: string) => { const ids = [...currentMapping.iterativeFieldIds]; ids[i] = newF; updateMapping({ iterativeFieldIds: ids }); }} customFields={customFields} /></div>
                         <button onClick={() => updateMapping({ iterativeFieldIds: currentMapping.iterativeFieldIds.filter((_: any, idx: number) => idx !== i) })} className="p-1.5 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-md transition"><X className="w-4 h-4"/></button>
                       </div>
                     ))}
                     <button onClick={() => updateMapping({ iterativeFieldIds: [...currentMapping.iterativeFieldIds, ''] })} className="text-[10px] font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 px-3 py-1.5 rounded-lg uppercase tracking-widest transition">+ Add slot</button>
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
      <button type="button" onClick={() => setIsOpen(!isOpen)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-bold text-left flex justify-between items-center hover:border-blue-300 transition-all shadow-sm">
        <span className="truncate text-slate-800">{selected ? selected.name : 'Select Field'}</span>
        <ChevronRight className={`w-3.5 h-3.5 text-slate-400 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1.5 bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden flex flex-col">
          <div className="p-2 border-b border-slate-100 bg-slate-50">
            <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter fields..." className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-medium outline-none focus:border-blue-500" />
          </div>
          <div className="max-h-[200px] overflow-y-auto custom-scrollbar py-1">
            {filtered.map((f: any) => (
              <button key={f.id} onClick={() => { onChange(f.id); setIsOpen(false); setSearch(''); }} className={`w-full text-left px-3 py-2 text-xs hover:bg-slate-50 transition-colors flex items-center justify-between ${value === f.id ? 'bg-blue-50/50' : ''}`}>
                <span className={`font-bold truncate ${value === f.id ? 'text-blue-700' : 'text-slate-700'}`}>{f.name}</span>
                <span className="text-[9px] text-slate-400 font-mono shrink-0 ml-2">{f.id}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
