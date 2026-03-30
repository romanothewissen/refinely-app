import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Database, BrainCircuit, Globe, X, RefreshCw, Save, CreditCard, ChevronLeft, ShieldCheck, 
  Users, FileText, ChevronRight, Check, Trash, Layers, Zap, Info
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
interface JiraStatus { name: string }
interface JiraField { id: string; name: string }

interface WiDocRow {
  docId: string;
  filename: string;
  revision: string;
  chunkCount: number;
  uploadedAt: string;
}

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
  const [customFields, setCustomFields] = useState<JiraField[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [arMappings, setArMappings] = useState<any[]>([]);
  const [activeArProj, setActiveArProj] = useState(initialProjectKey); // Global context selector

  // Domain State
  const [domainContext, setDomainContext] = useState('');
  const [domainRoles, setDomainRoles] = useState('');
  const [tier, setTier] = useState<'free' | 'standard' | 'premium'>('free');
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
        if (existingConfig.wiConfig?.enabled !== undefined) setWiEnabled(existingConfig.wiConfig.enabled);
        if (existingConfig.issueLinkType) setIssueLinkType(existingConfig.issueLinkType);
        if (existingConfig.arMappings) setArMappings(existingConfig.arMappings);
        if (existingConfig.domainContexts) setDomainContexts(existingConfig.domainContexts);
        if (existingConfig.isAdmin !== undefined) setIsAdmin(existingConfig.isAdmin);
      }
      const usageRes = await api.getUsage() as any;
      if (usageRes?.usage) setUsage(usageRes.usage);
      if (usageRes?.limits) setLimits(usageRes.limits);
    } catch (e) { console.error('Error loading config', e); }
  }

  useEffect(() => {
    checkProjectAdmin();
  }, [activeArProj]);

  async function checkProjectAdmin() {
    if (!activeArProj || activeArProj === '*') {
      setActiveProjAdmin(!!isAdmin);
      return;
    }
    try {
      const res = await api.checkIsAdmin({ projectKey: activeArProj }) as any;
      if (res?.success) setActiveProjAdmin(!!res.isProjectAdmin);
    } catch { setActiveProjAdmin(false); }
  }

  async function loadWiDocs() {
    try {
      const res = await api.listWiDocs(activeArProj) as any;
      if (res.success !== false) setWiDocs(res.docs ?? []);
    } catch (e: any) { console.error('Could not list documents', e); }
  }

  useEffect(() => {
    if (activeTab === 'domain') loadWiDocs();
  }, [activeTab, activeArProj]);

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
        issueLinkType,
        arMappings,
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

  const availableModels = useMemo(() => {
    if (provider === 'forge_llms') return CLAUDE_MODELS;
    if (provider === 'gemini' && (geminiApiKey || existingGeminiApiKey)) return GEMINI_MODELS;
    if (provider === 'openai' && (openaiApiKey || existingOpenaiApiKey)) return OPENAI_MODELS;
    return [];
  }, [provider, geminiApiKey, existingGeminiApiKey, openaiApiKey, existingOpenaiApiKey]);

  const settingsNav = [
    { id: 'models', label: 'AI Infrastructure', icon: BrainCircuit, sub: 'LLM & API Keys' },
    { id: 'jira', label: 'Jira Governance', icon: Database, sub: 'Mappings & Linking' },
    { id: 'domain', label: 'Domain Intelligence', icon: Globe, sub: 'Rules & Reference' },
    { id: 'billing', label: 'Plan & Billing', icon: CreditCard, sub: 'Tier & Usage' },
  ] as const;

  const wiUploadCopy = wiUploadState
    ? wiUploadState.stage === 'reading'
      ? 'Preparing document'
      : wiUploadState.stage === 'uploading'
        ? 'Uploading document'
        : 'Indexing for retrieval'
    : null;

  return (
    <div className="flex-1 flex flex-col h-full bg-[var(--rf-bg)] relative overflow-hidden font-sans">
      <header className="shrink-0 border-b border-[var(--rf-border)] bg-white/90 backdrop-blur flex items-center justify-between px-6 py-4 z-30 sticky top-0">
        <div className="flex items-center gap-5">
          <button onClick={onClose} className="p-2.5 rounded-2xl border border-[var(--rf-border)] bg-white text-[var(--rf-text-tertiary)] hover:bg-[var(--rf-surface-soft)] hover:text-[var(--rf-text)] transition-all group shadow-[var(--rf-shadow-sm)]">
             <ChevronLeft className="w-5 h-5 group-hover:-translate-x-0.5" />
          </button>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--rf-text-tertiary)]">Workspace Settings</div>
            <h2 className="mt-1 text-[24px] font-semibold tracking-[-0.03em] text-[var(--rf-text)] flex items-center gap-2">Settings <span className="text-[var(--rf-border-strong)] font-light">/</span> <span className="text-[var(--rf-brand)]">Configuration</span></h2>
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
          {isAdmin && (
            <button onClick={handleSave} disabled={isSaving} className="bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] disabled:opacity-50 text-white text-sm font-bold px-6 py-2.5 rounded-2xl shadow-[var(--rf-shadow-md)] transition-all active:scale-[0.98] flex items-center gap-2">
              {isSaving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Config
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-hidden flex bg-[var(--rf-bg)]">
          <div className="w-72 shrink-0 border-r border-[var(--rf-border)] bg-white/75 p-6 flex flex-col gap-2">
            {settingsNav.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all ${
                  activeTab === tab.id ? 'bg-[var(--rf-brand-muted)] text-[var(--rf-brand)] border-[rgba(0,82,204,0.12)] shadow-[var(--rf-shadow-sm)]' : 'text-[var(--rf-text-secondary)] border-transparent hover:bg-[var(--rf-surface-soft)]'
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
               <div className="rf-panel-soft rounded-2xl p-4 text-[var(--rf-text)]">
                 <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-1">Current Plan</div>
                 <div className="text-base font-bold capitalize">{tier}</div>
                 <div className="text-xs text-[var(--rf-text-secondary)] mt-1">
                   {usage?.currentMonth ?? 0} / {limits?.generationsPerMonth === -1 ? 'Unlimited' : limits?.generationsPerMonth ?? 0} generations
                 </div>
               </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-8 lg:p-10 space-y-10 custom-scrollbar">
            {activeTab === 'models' && (
              <div className="max-w-3xl space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="space-y-1">
                   <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--rf-text-tertiary)]">AI Infrastructure</div>
                   <h3 className="text-3xl font-semibold text-[var(--rf-text)] tracking-[-0.04em]">Model and provider setup</h3>
                   <p className="text-[var(--rf-text-secondary)] text-sm">Configure the language models powering your story refinement pipeline.</p>
                </div>

                <div className="rf-panel rounded-[28px] p-6 space-y-6">
                  <div className="space-y-3">
                    <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">LLM Provider</label>
                    <div className="flex p-1 bg-slate-100 rounded-xl border border-slate-200">
                      {(['openai', 'gemini', 'forge_llms'] as const).map(p => (
                        <button key={p} onClick={() => setProvider(p)} className={`flex-1 py-1.5 text-[10px] font-bold uppercase rounded-lg transition-all ${provider === p ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-400'}`}>
                          {p.replace('_', ' ')}
                        </button>
                      ))}
                    </div>
                  </div>

                  {provider === 'openai' && (
                    <div className="space-y-2 pt-2 animate-in slide-in-from-top-1">
                      <div className="flex justify-between items-center px-1">
                        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">OpenAI API Key</label>
                        {existingOpenaiApiKey && <button onClick={() => { setExistingOpenaiApiKey(''); setOpenaiApiKey(''); }} className="text-[9px] font-bold text-red-500 hover:underline">Clear Stored</button>}
                      </div>
                      <input type="password" value={openaiApiKey} onChange={e => setOpenaiApiKey(e.target.value)} placeholder={existingOpenaiApiKey ? '••••••••• (Stored)' : 'sk-…'} disabled={!isAdmin} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-blue-500" />
                    </div>
                  )}

                  {provider === 'gemini' && (
                    <div className="space-y-2 pt-2 animate-in slide-in-from-top-1">
                      <div className="flex justify-between items-center px-1">
                        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Gemini API Key</label>
                        {existingGeminiApiKey && <button onClick={() => { setExistingGeminiApiKey(''); setGeminiApiKey(''); }} className="text-[9px] font-bold text-red-500 hover:underline">Clear Stored</button>}
                      </div>
                      <input type="password" value={geminiApiKey} onChange={e => setGeminiApiKey(e.target.value)} placeholder={existingGeminiApiKey ? '••••••••• (Stored)' : 'AIza…'} disabled={!isAdmin} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-blue-500" />
                    </div>
                  )}

                  <div className="space-y-4 pt-4 border-t border-slate-100">
                    {[
                      { label: 'Decomposition Pass', val: decompositionModel, set: setDecompositionModel },
                      { label: 'Reasoning & Clarify', val: clarifyModel, set: setClarifyModel },
                      { label: 'Evaluation & Theme', val: evaluateModel, set: setEvaluateModel },
                    ].map((item, i) => (
                      <div key={i} className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-600">{item.label}</span>
                        <select value={item.val} disabled={availableModels.length === 0} onChange={e => item.set(e.target.value)} className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-[11px] font-semibold text-slate-700 min-w-[180px] outline-none">
                          {availableModels.length === 0 ? <option>Provider required...</option> : availableModels.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>

                  <div className="pt-4 flex items-center gap-4">
                    <button onClick={testLlmConnection} disabled={isTestingLlm} className="bg-slate-800 hover:bg-slate-900 text-white text-[10px] font-bold uppercase tracking-widest px-5 py-2.5 rounded-xl transition-all flex items-center gap-2">
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
                    <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--rf-text-tertiary)]">Jira Governance</div>
                    <h3 className="text-3xl font-semibold text-[var(--rf-text)] tracking-[-0.04em]">Project mapping and source control</h3>
                    <p className="text-[var(--rf-text-secondary)] text-sm">Fine-tune how Refinely interacts with your Jira projects.</p>
                  </div>
                  <div className="rf-panel-soft flex items-center gap-2 p-1.5 rounded-2xl">
                     <span className="text-[10px] font-black text-[var(--rf-text-tertiary)] uppercase tracking-widest px-3">Editing Context:</span>
                     <select value={activeArProj} onChange={e => setActiveArProj(e.target.value)} className="bg-white border border-[var(--rf-border)] rounded-xl px-4 py-2 text-xs font-black text-[var(--rf-brand)] shadow-[var(--rf-shadow-sm)] focus:ring-2 focus:ring-blue-500/20 outline-none min-w-[180px]">
                        <option value="*">Global Org-Wide</option>
                        {projects.map(p => <option key={p.key} value={p.key}>{p.key}: {p.name}</option>)}
                      </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-8">
                <div className="rf-panel rounded-[28px] p-8 space-y-8">
                  <div className="flex items-center justify-between">
                     <div className="space-y-1">
                        <h4 className="text-base font-bold text-slate-800">Schema Discovery</h4>
                        <p className="text-xs text-slate-500">Sync latest projects and custom fields.</p>
                     </div>
                     <button onClick={discoverJira} disabled={isDiscovering} className="bg-slate-100 hover:bg-slate-200 text-slate-700 text-[10px] font-bold uppercase tracking-widest px-5 py-2.5 rounded-xl transition-all flex items-center gap-2 border border-slate-200 shadow-sm">
                      {isDiscovering ? <RefreshCw className="w-3.5 h-3.5 animate-spin"/> : <RefreshCw className="w-3.5 h-3.5" />} Sync Now
                    </button>
                  </div>

                  <ProjectConfigurationManager 
                    projects={projects || []} customFields={customFields || []} arMappings={arMappings || []} setArMappings={setArMappings}
                    domainContexts={domainContexts || []} setDomainContexts={setDomainContexts} goldSources={goldSources || []} setGoldSources={setGoldSources}
                    activeArProj={activeArProj} setActiveArProj={setActiveArProj} isAdmin={isAdmin} isProjectAdmin={activeProjAdmin}
                    issueTypes={issueTypes || []} statuses={statuses || []} onProjectSelect={onProjectSelect}
                    newSource={newSource || {}} setNewSource={setNewSource} addGoldSource={addGoldSource}
                  />
                </div>
                </div>
              </div>
            )}

            {activeTab === 'domain' && (
              <div className="max-w-4xl space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="space-y-1">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--rf-text-tertiary)]">Domain Intelligence</div>
                  <h3 className="text-3xl font-semibold text-[var(--rf-text)] tracking-[-0.04em]">Reference knowledge and team standards</h3>
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

                  <div className="pt-10 border-t border-[var(--rf-border-subtle)] space-y-6">
                    <div className="flex justify-between items-center">
                       <div className="flex items-center gap-4">
                         <div className="w-12 h-12 rounded-2xl bg-[var(--rf-brand-muted)] text-[var(--rf-brand)] flex items-center justify-center border border-[rgba(0,82,204,0.1)]"><FileText className="w-6 h-6" /></div>
                         <div>
                            <h4 className="text-lg font-bold text-[var(--rf-text)]">Work instructions</h4>
                            <p className="text-xs text-[var(--rf-text-secondary)] font-medium">PDF guidelines for organization-wide standards.</p>
                         </div>
                       </div>
                       <button onClick={() => wiFileInputRef.current?.click()} disabled={!!wiUploadState} className="bg-white border border-[var(--rf-border)] hover:bg-[var(--rf-surface-soft)] disabled:opacity-60 text-[var(--rf-text)] text-xs font-black px-6 py-3 rounded-2xl shadow-[var(--rf-shadow-sm)] transition-all">
                         {wiUploadState ? 'Uploading…' : '+ Add Instruction'}
                       </button>
                       <input type="file" ref={wiFileInputRef} onChange={handleWiPdfDrop} accept=".pdf" className="hidden" disabled={!!wiUploadState} />
                    </div>

                    {(wiUploadState || wiUploadError) && (
                      <div className={`rounded-[24px] border p-4 ${wiUploadError ? 'border-red-200 bg-[var(--rf-danger-subtle)]' : 'border-[rgba(0,82,204,0.12)] bg-[var(--rf-brand-muted)]'}`}>
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
                            <p className="text-xs text-[var(--rf-text-secondary)]">Your document is being uploaded and indexed so it can be referenced in future runs.</p>
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
                        <div className="col-span-2 p-16 text-center border-2 border-dashed border-[var(--rf-border-subtle)] rounded-3xl bg-[var(--rf-surface-soft)]">
                           <FileText className="w-12 h-12 text-[var(--rf-text-tertiary)]/30 mx-auto mb-4" />
                           <p className="text-sm font-bold text-[var(--rf-text-tertiary)]">No organizational instructions linked.</p>
                        </div>
                      ) : (
                        wiDocs.map(doc => (
                          <div key={doc.docId} className="rf-panel-soft p-5 rounded-[20px] flex items-center justify-between group hover:bg-white transition-all duration-300">
                             <div className="flex items-center gap-4 truncate">
                               <div className="shrink-0 w-10 h-10 bg-white rounded-xl border border-[var(--rf-border)] flex items-center justify-center"><FileText className="w-5 h-5 text-[var(--rf-text-tertiary)] font-light" /></div>
                               <div className="truncate">
                                 <p className="text-xs font-black text-[var(--rf-text)] truncate">{doc.filename}</p>
                                 <p className="text-[10px] text-[var(--rf-text-tertiary)] font-bold uppercase">{doc.chunkCount} vector chunks</p>
                               </div>
                             </div>
                             <button onClick={() => handleRemoveWiDoc(doc.docId)} className="text-[var(--rf-text-tertiary)] hover:text-red-500 transition-colors"><Trash className="w-4 h-4"/></button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'billing' && (
              <div className="max-w-4xl space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="space-y-1">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--rf-text-tertiary)]">Plan & Billing</div>
                  <h3 className="text-3xl font-semibold text-[var(--rf-text)] tracking-[-0.04em]">Subscription and workspace health</h3>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
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

                  <div className="rf-panel rounded-[28px] p-8 space-y-6">
                    <h4 className="text-sm font-bold text-[var(--rf-text)]">Environment Overview</h4>
                    <div className="space-y-4 text-sm">
                      <div className="flex items-center justify-between"><span className="text-slate-600">Cloud Status</span><span className="font-semibold text-green-600">Healthy</span></div>
                      <div className="flex items-center justify-between"><span className="text-slate-600">Security Layer</span><span className="font-semibold text-blue-600">Encrypted</span></div>
                      <div className="flex items-center justify-between"><span className="text-slate-600">Active Mappings</span><span className="font-semibold text-slate-900">{arMappings.length}</span></div>
                    </div>
                    {isAdmin && (
                      <button onClick={handleResetUsage} className="w-full py-3 text-xs font-bold uppercase tracking-widest text-red-600 hover:text-white border border-red-200 hover:bg-red-600 rounded-xl transition-all">
                        Reset Usage Counter
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
      </div>
    </div>
  );
}

function ProjectConfigurationManager({ 
  projects, customFields, arMappings, setArMappings, domainContexts, setDomainContexts, goldSources, setGoldSources,
  activeArProj, isAdmin, isProjectAdmin, issueTypes, statuses, onProjectSelect, newSource, setNewSource, addGoldSource
}: any) {
  const currentMapping = arMappings.find((m: any) => m.projectKey === activeArProj) || {
    projectKey: activeArProj, mode: 'consolidated', consolidatedFieldId: 'description', iterativeFieldIds: [],
  };
  const currentContext = domainContexts.find((c: any) => c.projectKey === activeArProj) || { projectKey: activeArProj, context: '' };
  const currentGoldSources = goldSources.filter((s: any) => s.targetProjects?.includes(activeArProj));

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

  const [isSavingProject, setIsSavingProject] = useState(false);
  const selectedStatuses: string[] = Array.isArray(newSource.statuses) ? newSource.statuses : [];

  const toggleStatus = (statusName: string) => {
    const exists = selectedStatuses.includes(statusName);
    const next = exists
      ? selectedStatuses.filter(s => s !== statusName)
      : [...selectedStatuses, statusName];
    setNewSource((p: any) => ({ ...p, statuses: next, status: next[0] || '' }));
  };

  const handleSave = async () => {
    setIsSavingProject(true);
    try {
      await api.saveProjectConfig({ projectKey: activeArProj, arMapping: currentMapping, domainContext: currentContext.context, goldSources: currentGoldSources });
      alert('Project saved.');
    } catch (e: any) { alert(e.message); }
    finally { setIsSavingProject(false); }
  };

  return (
    <div className="space-y-8 animate-in fade-in">
      <div className="flex items-center justify-between border-b border-[var(--rf-border-subtle)] pb-6">
        <div>
          <h4 className="text-lg font-bold text-[var(--rf-text)]">Project configuration</h4>
          <p className="text-[10px] text-[var(--rf-text-tertiary)] font-bold uppercase tracking-widest mt-0.5">Focus: {activeArProj === '*' ? 'System-Wide Defaults' : activeArProj}</p>
        </div>
        {isProjectAdmin && (
          <button onClick={handleSave} disabled={isSavingProject} className="bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] text-white text-[10px] font-bold uppercase tracking-widest px-6 py-3 rounded-2xl shadow-[var(--rf-shadow-sm)] active:scale-[0.98] transition-all flex items-center gap-2">
            {isSavingProject ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save Settings
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
         <div className="space-y-3">
            <h5 className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest flex items-center gap-2">Local Project Guidelines</h5>
            <textarea value={currentContext.context} onChange={e => updateContext(e.target.value)} placeholder="Guidelines for this project context..." className="w-full h-40 bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-2xl p-4 text-sm font-medium outline-none focus:ring-2 focus:ring-blue-500/20" />
         </div>

         <div className="space-y-6">
            <h5 className="text-[10px] font-black text-[var(--rf-text-tertiary)] uppercase tracking-widest flex items-center gap-2"><Layers className="w-3.5 h-3.5 text-[var(--rf-brand)]" /> AR Field Mapping</h5>
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
         </div>

         <div className="col-span-full space-y-6 pt-8 border-t border-[var(--rf-border-subtle)] animate-in fade-in slide-in-from-bottom-2 duration-500">
             <div className="flex items-center justify-between">
                <div>
                  <h5 className="text-[11px] font-black text-[var(--rf-text)] uppercase tracking-widest flex items-center gap-2"><Globe className="w-3.5 h-3.5 text-[var(--rf-brand)]" /> Golden Example Sources</h5>
                  <p className="text-xs text-[var(--rf-text-secondary)] mt-1">Defaults are auto-detected. You can override project, issue type, and statuses anytime.</p>
                </div>
             </div>
             
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
