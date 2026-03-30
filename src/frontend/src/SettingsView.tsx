import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Database, BrainCircuit, Globe, X, RefreshCw, Save, CreditCard, ChevronLeft, ShieldCheck, 
  Users, FileText, ChevronRight, Check, Trash, Layout, Layers, Zap, Info, Shield, ArrowRight
} from 'lucide-react';
import { api } from './hooks/useForge';
import { UsageMeter } from './UsageMeter';
import { REDACTED } from './types';

interface GoldSource {
  key: string;
  project: string;
  issuetype: string;
  status: string;
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

export function SettingsView({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<'models' | 'jira' | 'domain' | 'billing'>('models');
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
  const [newSource, setNewSource] = useState<Partial<GoldSource>>({});
  const [issueTypes, setIssueTypes] = useState<JiraIssueType[]>([]);
  const [statuses, setStatuses] = useState<JiraStatus[]>([]);
  const [customFields, setCustomFields] = useState<JiraField[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [arMappings, setArMappings] = useState<any[]>([]);
  const [activeArProj, setActiveArProj] = useState('*'); // Global context selector

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
  const wiFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadInitialConfig();
  }, []);

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
          setGoldSources(existingConfig.goldSources.map((gs: any) => ({ 
            ...gs, 
            arFieldIds: Array.isArray(gs.arFieldIds) && gs.arFieldIds.length > 0 ? gs.arFieldIds : (gs.requirementsFieldId ? [gs.requirementsFieldId] : []),
            requirementsFieldId: null 
          })));
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
      const res = await api.listWiDocs() as any;
      if (res.success !== false) setWiDocs(res.docs ?? []);
    } catch (e: any) { console.error('Could not list documents', e); }
  }

  useEffect(() => {
    if (activeTab === 'domain') loadWiDocs();
  }, [activeTab]);

  async function handleWiPdfDrop(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.type !== 'application/pdf') return;
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
      const res = await api.uploadWi(file.name, base64) as any;
      if (res.success !== false && !res.duplicate) await loadWiDocs();
    } catch (err: any) { console.error('Upload failed', err); }
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
    setNewSource(prev => ({ ...prev, project: projectKey }));
    try {
      const [it, st] = await Promise.all([api.discoverIssueTypes(projectKey) as Promise<any>, api.discoverStatuses(projectKey) as Promise<any>]);
      setIssueTypes(it.issueTypes ?? []);
      setStatuses(st.statuses ?? []);
    } catch {}
  }

  function addGoldSource() {
    if (!newSource.project || !newSource.issuetype || !newSource.status) return;
    setGoldSources(prev => [...prev, {
      key: `src${goldSources.length + 1}`,
      project: newSource.project!,
      issuetype: newSource.issuetype!,
      status: newSource.status!,
      maxItems: 50,
      requirementsFieldId: null,
      arFieldIds: newSource.arFieldIds ?? [],
      targetProjects: [activeArProj],
    }]);
    setNewSource({}); setIssueTypes([]); setStatuses([]);
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

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-50 relative overflow-hidden font-sans">
      <header className="h-20 shrink-0 border-b border-slate-200/60 bg-white/70 backdrop-blur-md flex items-center justify-between px-8 z-30 sticky top-0 shadow-sm">
        <div className="flex items-center gap-5">
          <button onClick={onClose} className="p-2.5 rounded-xl hover:bg-slate-100 text-slate-400 hover:text-slate-800 transition-all group">
             <ChevronLeft className="w-5 h-5 group-hover:-translate-x-0.5" />
          </button>
          <div>
            <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">Settings <span className="text-slate-300 font-light">/</span> <span className="text-blue-600">Configuration</span></h2>
            <div className="flex items-center gap-2 mt-0.5">
              <span className={`text-[9px] font-black px-2 py-0.5 rounded-full uppercase border ${isAdmin ? 'bg-green-100 text-green-700 border-green-200' : 'bg-red-100 text-red-700 border-red-200'}`}>
                {isAdmin ? 'Administrator' : 'Read-Only'}
              </span>
              <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider flex items-center gap-1">
                <ShieldCheck className="w-3 h-3 text-blue-500" /> {tier} plan
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {isAdmin && (
            <button onClick={handleSave} disabled={isSaving} className="bg-slate-900 hover:bg-black disabled:opacity-50 text-white text-sm font-bold px-6 py-2.5 rounded-xl shadow-lg transition-all active:scale-[0.98] flex items-center gap-2">
              {isSaving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Config
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-hidden flex bg-white/40">
          <div className="w-72 shrink-0 border-r border-slate-200 p-6 flex flex-col gap-1.5">
            {[
              { id: 'models', label: 'AI Infrastructure', icon: BrainCircuit, sub: 'LLM & API Keys' },
              { id: 'jira', label: 'Jira Governance', icon: Database, sub: 'Mappings & Linking' },
              { id: 'domain', label: 'Domain Intelligence', icon: Globe, sub: 'Rules & Reference' },
              { id: 'billing', label: 'Plan & Billing', icon: CreditCard, sub: 'Tier & Usage' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${
                  activeTab === tab.id ? 'bg-blue-50 text-blue-700 shadow-sm' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                <tab.icon className={`w-4 h-4 ${activeTab === tab.id ? 'text-blue-600' : 'text-slate-400'}`} />
                <div className="text-left">
                  <div className="text-xs font-bold">{tab.label}</div>
                  <div className="text-[10px] text-slate-400">{tab.sub}</div>
                </div>
              </button>
            ))}
            
            <div className="mt-auto px-4 py-6 border-t border-slate-100">
               <div className="bg-slate-900 rounded-3xl p-5 text-white shadow-sm relative overflow-hidden">
                 <div className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1">Active Subscription</div>
                 <div className="text-lg font-bold capitalize">{tier} tier</div>
                 <div className="w-full bg-slate-800 h-1.5 rounded-full mt-3 overflow-hidden">
                   <div className="bg-blue-500 h-full" style={{ width: usage ? `${Math.min(100, (usage.currentMonth / (limits?.generationsPerMonth || 1)) * 100)}%` : '0%' }} />
                 </div>
               </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-10 space-y-10 custom-scrollbar">
            {activeTab === 'models' && (
              <div className="max-w-3xl space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="space-y-1">
                   <h3 className="text-2xl font-black text-slate-900 tracking-tight">AI Infrastructure</h3>
                   <p className="text-slate-500 text-sm">Configure the Large Language Models powering your story refinement pipeline.</p>
                </div>

                <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-6">
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
                    <h3 className="text-2xl font-black text-slate-900 tracking-tight">Jira Governance</h3>
                    <p className="text-slate-500 text-sm">Fine-tune how Refinely interacts with your specific Jira projects.</p>
                  </div>
                  <div className="flex items-center gap-2 bg-slate-100/50 p-1.5 rounded-2xl border border-slate-200/60 shadow-inner">
                     <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-3">Editing Context:</span>
                     <select value={activeArProj} onChange={e => setActiveArProj(e.target.value)} className="bg-white border border-slate-200 rounded-xl px-4 py-2 text-xs font-black text-blue-600 shadow-sm focus:ring-2 focus:ring-blue-500/20 outline-none min-w-[180px]">
                        <option value="*">Global Org-Wide</option>
                        {projects.map(p => <option key={p.key} value={p.key}>{p.key}: {p.name}</option>)}
                      </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-8">
                <div className="bg-white border border-slate-200 rounded-2xl p-8 shadow-sm space-y-8">
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
                <h3 className="text-2xl font-black text-slate-900 tracking-tight">Domain Intelligence</h3>
                <div className="bg-white border border-slate-200/80 rounded-[32px] p-10 shadow-sm space-y-10">
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-2xl bg-orange-50 text-orange-600 flex items-center justify-center border border-orange-100"><Users className="w-6 h-6" /></div>
                      <div>
                        <h4 className="text-lg font-bold text-slate-900">Core Persona Roles</h4>
                        <p className="text-xs text-slate-500 font-medium italic">Key stakeholders for story decomposition.</p>
                      </div>
                    </div>
                    <input value={domainRoles} onChange={e => setDomainRoles(e.target.value)} placeholder="e.g. Developer, QA Engineer, Project Manager" className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-6 py-4 text-sm font-medium focus:ring-2 focus:ring-blue-500/20 outline-none" />
                  </div>

                  <div className="pt-10 border-t border-slate-100 space-y-6">
                    <div className="flex justify-between items-center">
                       <div className="flex items-center gap-4">
                         <div className="w-12 h-12 rounded-2xl bg-purple-50 text-purple-600 flex items-center justify-center border border-purple-100"><FileText className="w-6 h-6" /></div>
                         <div>
                            <h4 className="text-lg font-bold text-slate-900">Work Instructions</h4>
                            <p className="text-xs text-slate-500 font-medium italic">PDF guidelines for organization-wide standards.</p>
                         </div>
                       </div>
                       <button onClick={() => wiFileInputRef.current?.click()} className="bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-black px-6 py-3 rounded-2xl shadow-sm transition-all">+ Add Instruction</button>
                       <input type="file" ref={wiFileInputRef} onChange={handleWiPdfDrop} accept=".pdf" className="hidden" />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {wiDocs.length === 0 ? (
                        <div className="col-span-2 p-16 text-center border-2 border-dashed border-slate-100 rounded-3xl">
                           <FileText className="w-12 h-12 text-slate-200 mx-auto mb-4" />
                           <p className="text-sm font-bold text-slate-400">No organizational instructions linked.</p>
                        </div>
                      ) : (
                        wiDocs.map(doc => (
                          <div key={doc.docId} className="bg-slate-50/50 border border-slate-200 p-5 rounded-[24px] flex items-center justify-between group hover:bg-white transition-all duration-300">
                             <div className="flex items-center gap-4 truncate">
                               <div className="shrink-0 w-10 h-10 bg-white rounded-xl border border-slate-200 flex items-center justify-center"><FileText className="w-5 h-5 text-slate-400 font-light" /></div>
                               <div className="truncate">
                                 <p className="text-xs font-black text-slate-700 truncate">{doc.filename}</p>
                                 <p className="text-[10px] text-slate-400 font-bold uppercase">{doc.chunkCount} vector chunks</p>
                               </div>
                             </div>
                             <button onClick={() => handleRemoveWiDoc(doc.docId)} className="text-slate-300 hover:text-red-500 transition-colors"><Trash className="w-4 h-4"/></button>
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
                <h3 className="text-2xl font-black text-slate-900 tracking-tight">Plan & Usage</h3>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                   <div className="bg-slate-900 rounded-[40px] p-10 text-white relative overflow-hidden group">
                      <div className="absolute top-0 right-0 w-64 h-64 bg-blue-500/10 rounded-full blur-[100px] -mr-32 -mt-32" />
                      <div className="relative z-10 space-y-10 flex flex-col h-full justify-between">
                         <div className="space-y-4">
                           <div className="text-[10px] font-black uppercase tracking-[0.3em] text-blue-400">Current tier</div>
                           <div className="flex items-center gap-3">
                              <h4 className="text-5xl font-black capitalize tracking-tighter">{tier}</h4>
                              <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                           </div>
                         </div>
                         <div className="space-y-6">
                            <div className="flex justify-between items-end text-[10px] font-black uppercase tracking-widest text-slate-400">
                              <span>Consumption</span>
                              <span>{usage?.currentMonth} / {limits?.generationsPerMonth === -1 ? 'Unlimited' : limits?.generationsPerMonth}</span>
                            </div>
                            <div className="w-full bg-slate-800 h-2.5 rounded-full overflow-hidden">
                               <div className="bg-blue-500 h-full transition-all duration-1000" style={{ width: usage ? `${Math.min(100, (usage.currentMonth / (limits?.generationsPerMonth || 1)) * 100)}%` : '0%' }} />
                            </div>
                         </div>
                      </div>
                   </div>

                   <div className="flex flex-col gap-8 justify-between">
                      <div className="bg-white border border-slate-200/80 rounded-[32px] p-8 shadow-sm">
                         <h4 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] mb-6">Service Overview</h4>
                         <div className="space-y-6">
                            {[
                              { label: 'Cloud Status', value: 'Healthy', icon: Zap, color: 'text-green-500' },
                              { label: 'Security Layer', value: 'Encrypted', icon: Shield, color: 'text-blue-500' },
                              { label: 'Active Mappings', value: arMappings.length, icon: Layers, color: 'text-purple-500' },
                            ].map((stat, i) => (
                              <div key={i} className="flex items-center justify-between group">
                                <div className="flex items-center gap-4">
                                  <stat.icon className={`w-5 h-5 ${stat.color} group-hover:scale-110 transition-transform`} />
                                  <span className="text-sm font-bold text-slate-600">{stat.label}</span>
                                </div>
                                <span className="text-sm font-black text-slate-900">{stat.value}</span>
                              </div>
                            ))}
                         </div>
                      </div>
                      {isAdmin && (
                        <button onClick={handleResetUsage} className="py-5 text-[10px] font-black uppercase tracking-[0.3em] text-red-500 hover:text-white border-2 border-red-50/50 hover:bg-red-500 hover:border-red-500 rounded-3xl transition-all active:scale-95">Reset Counter ⚠️</button>
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
      <div className="flex items-center justify-between border-b border-slate-100 pb-6">
        <div>
          <h4 className="text-lg font-bold text-slate-800">Override Context</h4>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">Focus: {activeArProj === '*' ? 'System-Wide Defaults' : activeArProj}</p>
        </div>
        {isProjectAdmin && (
          <button onClick={handleSave} disabled={isSavingProject} className="bg-blue-600 hover:bg-blue-700 text-white text-[10px] font-bold uppercase tracking-widest px-6 py-3 rounded-xl shadow-md active:scale-[0.98] transition-all flex items-center gap-2">
            {isSavingProject ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save Settings
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
         <div className="space-y-3">
            <h5 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">Local Project Guidelines</h5>
            <textarea value={currentContext.context} onChange={e => updateContext(e.target.value)} placeholder="Guidelines for this project context..." className="w-full h-40 bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm font-medium outline-none" />
         </div>

         <div className="space-y-6">
            <h5 className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2"><Layers className="w-3.5 h-3.5 text-purple-500" /> AR Field Mapping</h5>
            <div className="bg-slate-50 rounded-[28px] p-8 space-y-6 border border-slate-100/50 shadow-inner">
               <div className="flex p-1 bg-white rounded-2xl border border-slate-100 shadow-sm max-w-[240px]">
                 <button onClick={() => updateMapping({ mode: 'consolidated' })} className={`flex-1 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-xl ${currentMapping.mode === 'consolidated' ? 'bg-slate-900 text-white shadow-md' : 'text-slate-400'}`}>Consolidated</button>
                 <button onClick={() => updateMapping({ mode: 'iterative' })} className={`flex-1 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-xl ${currentMapping.mode === 'iterative' ? 'bg-slate-900 text-white shadow-md' : 'text-slate-400'}`}>Iterative</button>
               </div>
               
               <div className="pt-2">
                 {currentMapping.mode === 'consolidated' ? (
                   <div className="flex items-center justify-between gap-4">
                     <span className="text-xs font-bold text-slate-700">Storage Field</span>
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

               <div className="pt-6 border-t border-slate-200/50 flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-700">Issue Linking</span>
                  <select value={currentMapping.issueLinkType || ''} onChange={e => updateMapping({ issueLinkType: e.target.value })} className="bg-white border border-slate-100 px-4 py-2 rounded-xl text-xs font-bold text-slate-600 outline-none shadow-sm min-w-[140px]">
                    <option value="">Global Default</option>
                    {['Relates to', 'Blocks', 'Clones', 'Duplicates'].map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
               </div>
            </div>
         </div>

         <div className="col-span-full space-y-8 pt-8 border-t border-slate-100 animate-in fade-in slide-in-from-bottom-2 duration-500">
             <div className="flex items-center justify-between">
                <h5 className="text-[11px] font-black text-slate-900 uppercase tracking-widest flex items-center gap-2"><Globe className="w-3.5 h-3.5 text-blue-500" /> AI Generation Reference Standards</h5>
                {activeArProj !== '*' && (
                   <button onClick={() => onProjectSelect(activeArProj)} className="text-[9px] font-black text-blue-600 uppercase tracking-widest bg-blue-50 px-3 py-1.5 rounded-lg hover:bg-blue-100 transition-colors">
                     Quick Add {activeArProj} Standard
                   </button>
                )}
             </div>
             
             {activeArProj !== '*' && (
                <div className="bg-slate-900 rounded-[32px] p-8 text-white shadow-xl relative overflow-hidden group">
                   <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:scale-110 transition-transform duration-700"><Database className="w-32 h-32" /></div>
                   <div className="mb-6 max-w-lg">
                      <p className="text-sm font-bold text-blue-400 mb-1">Source Configuration</p>
                      <p className="text-xs text-slate-400 font-medium leading-relaxed">Define which project's high-quality stories the AI should look at. You can pick the current project below to set its own "Gold Standard".</p>
                   </div>
                   
                   <div className="flex flex-wrap gap-4 items-end relative z-10">
                     <div className="space-y-1.5 min-w-[180px]">
                        <span className="text-[9px] font-black text-slate-500 uppercase ml-1">Select Source Project</span>
                        <select className="bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-xs text-white outline-none w-full hover:bg-white/10 transition-colors" onChange={e => onProjectSelect(e.target.value)} value={newSource.project || ''}>
                           <option value="">Choose Project...</option>
                           {projects.map((p: any) => <option key={p.key} value={p.key}>{p.key}{p.key === activeArProj ? ' (Local)' : ''}</option>)}
                        </select>
                     </div>
                     <div className="space-y-1.5">
                        <span className="text-[9px] font-black text-slate-500 uppercase ml-1">Issue Type</span>
                        <select className="bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-xs text-white outline-none w-40 hover:bg-white/10 transition-colors" onChange={e => setNewSource((p: any) => ({...p, issuetype: e.target.value}))} value={newSource.issuetype || ''}>
                           <option value="">All Types</option>
                           {issueTypes.map((it: any) => <option key={it.name} value={it.name}>{it.name}</option>)}
                        </select>
                     </div>
                     <div className="space-y-1.5">
                        <span className="text-[9px] font-black text-slate-500 uppercase ml-1">Target Status</span>
                        <select className="bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-xs text-white outline-none w-40 hover:bg-white/10 transition-colors" onChange={e => setNewSource((p: any) => ({...p, status: e.target.value}))} value={newSource.status || ''}>
                           <option value="">All Done</option>
                           {statuses.map((st: any) => <option key={st.name} value={st.name}>{st.name}</option>)}
                        </select>
                     </div>
                     <button onClick={addGoldSource} disabled={!newSource.project} className="bg-white text-slate-900 text-xs font-black px-10 py-3.5 rounded-2xl shadow-lg active:scale-95 transition-all disabled:opacity-20 flex items-center gap-2">
                        {newSource.project === activeArProj ? <Layers className="w-4 h-4" /> : <Globe className="w-4 h-4" />} {newSource.project === activeArProj ? 'Set Local Standard' : 'Link Knowledge Bridge'}
                     </button>
                   </div>
                </div>
             )}
             
             <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pb-12">
                {currentGoldSources.length === 0 ? (
                  <div className="col-span-full py-24 text-center border-2 border-dashed border-slate-100 rounded-[40px] bg-slate-50/20">
                     <BrainCircuit className="w-12 h-12 text-slate-100 mx-auto mb-4" />
                     <p className="text-[10px] font-black text-slate-300 uppercase tracking-widest">No Active Standards Linked</p>
                     <p className="text-[11px] text-slate-400 mt-2">The AI will use global defaults if no project standards are set.</p>
                  </div>
                ) : (
                  currentGoldSources.map((s: any, idx: number) => (
                    <div key={idx} className="bg-white border border-slate-100 p-7 rounded-[32px] shadow-sm flex items-center justify-between group hover:shadow-xl hover:-translate-y-1 transition-all duration-300">
                       <div className="flex gap-4 items-center">
                          <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${s.project === activeArProj ? 'bg-blue-50 text-blue-600 border border-blue-100' : 'bg-slate-50 text-slate-400 border border-slate-100'}`}>
                             {s.project === activeArProj ? <Layers className="w-6 h-6" /> : <Globe className="w-6 h-6" />}
                          </div>
                          <div>
                             <div className="text-sm font-black text-slate-900 flex items-center gap-2">
                               {s.project} {s.project === activeArProj && <span className="bg-blue-600 text-[8px] text-white px-2 py-0.5 rounded-full uppercase tracking-tighter">Local</span>}
                             </div>
                             <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">{s.issuetype} • {s.status}</div>
                          </div>
                       </div>
                       <button onClick={() => setGoldSources((p: any) => p.filter((x: any) => x !== s))} className="p-3 bg-slate-50 text-slate-200 hover:bg-red-50 hover:text-red-500 rounded-2xl transition-all duration-300 opacity-0 group-hover:opacity-100"><Trash className="w-4 h-4" /></button>
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
      <button type="button" onClick={() => setIsOpen(!isOpen)} className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-xs font-bold text-left flex justify-between items-center hover:border-blue-400 transition-all shadow-sm">
        <span className="truncate text-slate-700">{selected ? selected.name : 'Select Field'} <span className="ml-1 text-[9px] text-slate-300 font-mono">({selected ? selected.id : '---'})</span></span>
        <ChevronRight className={`w-3.5 h-3.5 text-slate-300 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute z-[100] top-full left-0 right-0 mt-2 bg-white border border-slate-200 rounded-[28px] shadow-2xl overflow-hidden animate-in zoom-in-95 duration-100 flex flex-col">
          <div className="p-3 border-b border-slate-50 bg-slate-50/50"><input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter fields..." className="w-full bg-white border border-slate-200 rounded-2xl px-4 py-2 text-xs outline-none" /></div>
          <div className="max-h-[240px] overflow-y-auto custom-scrollbar">
            {filtered.map((f: any) => (
              <button key={f.id} onClick={() => { onChange(f.id); setIsOpen(false); setSearch(''); }} className={`w-full text-left px-5 py-3.5 text-xs hover:bg-slate-50 transition-colors flex flex-col gap-0.5 border-b border-slate-50 last:border-0 ${value === f.id ? 'bg-blue-50/40' : ''}`}>
                <span className={`font-black uppercase tracking-tight ${value === f.id ? 'text-blue-600' : 'text-slate-800'}`}>{f.name}</span>
                <span className="text-[9px] text-slate-300 font-mono tracking-tighter">{f.id}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
