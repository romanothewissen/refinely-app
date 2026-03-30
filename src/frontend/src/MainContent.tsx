import React, { useState } from 'react';
import { Send, Sparkles, Edit2, Check, X, Plus, Trash2, Menu, Upload, ChevronDown } from 'lucide-react';
import { api } from './hooks/useForge';
import { UsageMeter } from './UsageMeter';
import { router } from '@forge/bridge';

// ─── Word-level diff utility ──────────────────────────────────────────────────
type DiffToken = { text: string; type: 'same' | 'added' | 'removed' };

function wordDiff(oldText: string, newText: string): DiffToken[] {
  const oldWords = (oldText || '').split(/\b/);
  const newWords = (newText || '').split(/\b/);
  const m = oldWords.length, n = newWords.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = oldWords[i] === newWords[j] ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
  const tokens: DiffToken[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (oldWords[i] === newWords[j]) { tokens.push({ text: newWords[j], type: 'same' }); i++; j++; }
    else if (dp[i+1][j] >= dp[i][j+1]) { tokens.push({ text: oldWords[i], type: 'removed' }); i++; }
    else { tokens.push({ text: newWords[j], type: 'added' }); j++; }
  }
  while (i < m) tokens.push({ text: oldWords[i++], type: 'removed' });
  while (j < n) tokens.push({ text: newWords[j++], type: 'added' });
  return tokens;
}

function DiffText({ oldText, newText, fullHighlight = false, mode = 'redline' }: { oldText: string; newText: string; fullHighlight?: boolean; mode?: 'redline' | 'blackline' }) {
  if (mode === 'blackline') return <span>{newText}</span>;
  if (fullHighlight) return <span className="bg-green-100 text-green-900 rounded px-0.5">{newText}</span>;
  const tokens = wordDiff(oldText, newText);
  return (
    <span>
      {tokens.map((tok, i) => {
        if (tok.type === 'same') return <span key={i}>{tok.text}</span>;
        if (tok.type === 'added') return <mark key={i} className="bg-blue-100 text-blue-900 rounded px-0.5 not-italic">{tok.text}</mark>;
        return <del key={i} className="text-slate-400 line-through bg-red-50 rounded px-0.5">{tok.text}</del>;
      })}
    </span>
  );
}

// ─── AI Refine Popup ──────────────────────────────────────────────────────────
function RefinePopup({ feature, onClose, onResult }: {
  feature: Feature;
  onClose: () => void;
  onResult: (refined: Feature) => void;
}) {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSend = async () => {
    const feedback = input.trim();
    if (!feedback) return;
    setLoading(true);
    setError('');
    try {
      const res = await api.refineSingleFeature(feature, feedback) as any;
      if (res.success && res.feature) {
        onResult(res.feature);
      } else {
        setError('Refinement failed — please try again.');
        setLoading(false);
      }
    } catch (e: any) {
      setError(e?.message ?? 'Unknown error');
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm" onClick={!loading ? onClose : undefined} />
      <div className="relative bg-white w-full max-w-lg rounded-2xl shadow-[0_24px_64px_-12px_rgba(0,0,0,0.18)] flex flex-col overflow-hidden slide-up border border-slate-100">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-blue-500" />
            <span className="font-semibold text-slate-800 text-sm">AI Refine</span>
            <span className="text-slate-400 text-xs ml-1 line-clamp-1 max-w-[200px]">— {feature.title || feature.summary}</span>
          </div>
          {!loading && (
            <button onClick={onClose} className="p-1.5 hover:bg-slate-100 text-slate-400 rounded-lg transition"><X className="w-4 h-4" /></button>
          )}
        </div>

        <div className="px-5 py-5">
          {loading ? (
            <div className="flex flex-col items-center py-8 gap-4">
              <div className="w-12 h-12 rounded-full bg-blue-50 flex items-center justify-center">
                <div className="w-7 h-7 border-[3px] border-blue-200 border-t-blue-600 rounded-full spin-slow" />
              </div>
              <div className="text-center">
                <p className="font-semibold text-slate-800 text-sm">Refining feature…</p>
                <p className="text-xs text-slate-400 mt-1">The AI is working on your request</p>
              </div>
              <div className="dot-bounce text-blue-400"><span /><span /><span /></div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-slate-500">Describe what you want changed — e.g. "Add an AR for invalid password", "Tighten the scope to mobile only"</p>
              <textarea
                rows={4}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSend(); }}
                placeholder="Your refinement instructions…"
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition resize-none"
                autoFocus
              />
              {error && <p className="text-xs text-red-500">{error}</p>}
            </div>
          )}
        </div>

        {!loading && (
          <div className="px-5 py-4 border-t border-slate-100 flex items-center justify-between gap-3">
            <span className="text-[11px] text-slate-400">⌘ + Enter to send</span>
            <div className="flex gap-2">
              <button onClick={onClose} className="px-3 py-2 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition">Cancel</button>
              <button
                onClick={handleSend}
                disabled={!input.trim()}
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-900 disabled:opacity-40 rounded-lg transition active:scale-[0.97]"
              >
                <Send className="w-3.5 h-3.5" /> Refine
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Interface ────────────────────────────────────────────────────────────────
interface Feature {
  id: string;
  title?: string;
  summary: string;
  description: string;
  markdown?: string;
  acceptanceRequirements: Array<{ given: string; when: string; then: string }>;
  isAccepted?: boolean;
  pendingRefinement?: Feature;
  pendingRemoval?: boolean;
  jiraIssueKey?: string;
  jiraIssueUrl?: string;
}

interface MainContentProps {
  features: Feature[];
  setFeatures: React.Dispatch<React.SetStateAction<Feature[]>>;
  onPushFeature: (index: number) => void;
  isGenerating: boolean;
  progress?: string;
  sidebarOpen: boolean;
  setSidebarOpen: (o: boolean) => void;
  sessionId: string;
  requirement: string;
  tier: string;
  usage: { currentMonth: number } | null;
  limits: { generationsPerMonth: number } | null;
  generationContext?: {
    domainRolesUsed: string[];
    goldExamplesCount: number;
    referencedGoldExamples: Array<{ key: string; source: string; summary: string }>;
  } | null;
}

// ─── Main component ───────────────────────────────────────────────────────────
export function MainContent({ 
  features, setFeatures, onPushFeature, isGenerating, progress, 
  sidebarOpen, setSidebarOpen, sessionId, requirement,
  tier, usage, limits, generationContext
}: MainContentProps) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<Feature | null>(null);
  const [refinePopupIdx, setRefinePopupIdx] = useState<number | null>(null);

  // Diff mode: redline (with highlights) or blackline (final result)
  const [diffMode, setDiffMode] = useState<'redline' | 'blackline'>('redline');

  // Collapsible state: store indices of EXPANDED features. Default empty = all collapsed.
  const [expandedIndices, setExpandedIndices] = useState<Set<number>>(new Set());

  const toggleExpand = (idx: number) => {
    setExpandedIndices(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const hasFeatures = Array.isArray(features) && features.length > 0;
  const totalArCount = Array.isArray(features) ? features.reduce((acc, f) => acc + (f?.acceptanceRequirements?.length || 0), 0) : 0;
  // Bulk Refine state
  const [showBulkRefine, setShowBulkRefine] = useState(false);
  const [bulkInput, setBulkInput] = useState('');
  const [isBulkRefining, setIsBulkRefining] = useState(false);

  // ── Edit helpers ─────────────────────────────────────────────────────────
  const startEditing  = (idx: number) => { setEditingIdx(idx); setEditDraft(JSON.parse(JSON.stringify(features[idx]))); };
  const cancelEditing = () => { setEditingIdx(null); setEditDraft(null); };
  const saveEditing   = () => {
    if (editingIdx !== null && editDraft) {
      setFeatures(prev => { 
        const n = [...prev]; 
        n[editingIdx] = editDraft; 
        api.updateConversationFeatures(sessionId, n);
        return n; 
      });
    }
    cancelEditing();
  };
  const updateDraftAr = (arIdx: number, field: 'given' | 'when' | 'then', value: string) => {
    if (!editDraft) return;
    const newArs = [...editDraft.acceptanceRequirements];
    newArs[arIdx] = { ...newArs[arIdx], [field]: value };
    setEditDraft({ ...editDraft, acceptanceRequirements: newArs });
  };
  const deleteDraftAr = (arIdx: number) => {
    if (!editDraft) return;
    setEditDraft({ ...editDraft, acceptanceRequirements: editDraft.acceptanceRequirements.filter((_, i) => i !== arIdx) });
  };
  const addDraftAr = () => {
    if (!editDraft) return;
    setEditDraft({ ...editDraft, acceptanceRequirements: [...(editDraft.acceptanceRequirements || []), { given: '', when: '', then: '' }] });
  };

  // ── Refinement helpers ───────────────────────────────────────────────────
  const acceptRefinement = (idx: number) => {
    setFeatures(prev => {
      const n = [...prev];
      if (n[idx].pendingRefinement) n[idx] = { ...n[idx].pendingRefinement!, pendingRefinement: undefined, pendingRemoval: undefined };
      else if (n[idx].pendingRemoval) {
        // Confirm removal: remove from array
        const next = n.filter((_, i) => i !== idx);
        api.updateConversationFeatures(sessionId, next);
        return next;
      }
      api.updateConversationFeatures(sessionId, n);
      return n;
    });
  };
  const rejectRefinement = (idx: number) => {
    setFeatures(prev => { 
      const n = [...prev]; 
      n[idx] = { ...n[idx], pendingRefinement: undefined, pendingRemoval: undefined }; 
      api.updateConversationFeatures(sessionId, n);
      return n; 
    });
  };
  const toggleAccepted = (idx: number) => {
    setFeatures(prev => { 
      const n = [...prev]; 
      n[idx] = { ...n[idx], isAccepted: !n[idx].isAccepted }; 
      api.updateConversationFeatures(sessionId, n);
      return n; 
    });
  };

  const handleBulkRefine = async () => {
    if (!bulkInput.trim() || isBulkRefining) return;
    setIsBulkRefining(true);

    try {
      const res = await api.refineFeatures(sessionId, requirement, features, bulkInput) as any;
      if (res.success && Array.isArray(res.features)) {
        const refined = res.features;
        setFeatures(prev => {
          return prev.map((f, i) => {
            const r = refined[i];
            if (!r) {
              // If backend returned fewer items than before, mark the rest as pending removal
              // assuming the order was perfectly maintained.
              // (Usually the backend is instructed to return 1-for-1 or matches by ID)
              return { ...f, pendingRemoval: true };
            }
            return {
              ...f,
              pendingRemoval: false,
              pendingRefinement: {
                ...f,
                ...r,
                acceptanceRequirements: r.acceptanceRequirements || f.acceptanceRequirements
              }
            };
          });
        });
        setShowBulkRefine(false);
        setBulkInput('');
      } else {
        throw new Error(res.error || 'Refinement failed');
      }
    } catch (err: any) {
      console.error('Bulk refinement failed:', err);
      alert(`AI refinement failed: ${err.message || 'Unknown error'}. Please try again.`);
    } finally {
      setIsBulkRefining(false);
    }
  };

  const discardAllProposed = () => {
    if (window.confirm('Discard all pending AI improvements?')) {
      setFeatures(prev => {
        const next = prev.map(f => ({ ...f, pendingRefinement: undefined, pendingRemoval: undefined }));
        api.updateConversationFeatures(sessionId, next);
        return next;
      });
    }
  };

  const acceptAllProposed = () => {
    setFeatures(prev => {
      const next = prev
        .filter(f => !f.pendingRemoval)
        .map(f => {
          if (!f.pendingRefinement) return f;
          return { 
            ...f, 
            ...f.pendingRefinement, 
            pendingRefinement: undefined,
            pendingRemoval: undefined,
            isAccepted: true 
          };
        });
      api.updateConversationFeatures(sessionId, next);
      return next;
    });
  };

  // ── Generating skeleton ──────────────────────────────────────────────────
  const GeneratingSkeleton = () => (
    <div className="w-full px-6 md:px-12 py-8 space-y-6 fade-in h-full flex flex-col pt-12">
      {/* Moved progress to top as requested */}
      <div className="flex flex-col items-center gap-4 mb-4 zoom-in">
        <div className="w-14 h-14 rounded-[20px] bg-gradient-to-br from-blue-600 via-blue-500 to-sky-500 shadow-[0_18px_42px_-18px_rgba(37,99,235,0.68)] flex items-center justify-center animate-pulse">
          <Sparkles className="w-6 h-6 text-white" />
        </div>
        <div className="text-center">
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">Refinely at work</h2>
          <p className="text-sm text-slate-500 font-medium mt-1">{progress || 'Processing your request…'}</p>
        </div>
        <div className="dot-bounce text-blue-400 mt-2"><span /><span /><span /></div>
      </div>

      <div className="space-y-6">
        {[1, 2, 3].map(i => (
          <div key={i} className="rf-surface rounded-[24px] overflow-hidden" style={{ animationDelay: `${i * 0.12}s` }}>
            <div className="flex">
              <div className="w-2 shimmer shrink-0" />
              <div className="flex-1 p-6 space-y-4">
                <div className="shimmer h-5 w-2/5 rounded-lg" />
                <div className="shimmer h-3.5 w-full rounded" />
                <div className="shimmer h-3.5 w-4/5 rounded" />
                <div className="space-y-2 pt-2">
                  {[1,2,3].map(j => <div key={j} className="shimmer h-3 rounded" style={{ width: `${60 + j * 10}%` }} />)}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <main className="flex-1 flex flex-col h-full relative overflow-hidden">
      {/* Header */}
      <header className="h-[74px] shrink-0 border-b border-white/60 bg-white/65 backdrop-blur-xl flex items-center justify-between px-8 z-10 sticky top-0">
        <div className="flex items-center gap-4">
          {!sidebarOpen && (
            <button onClick={() => setSidebarOpen(true)} className="p-2.5 -ml-2 rounded-xl hover:bg-white text-slate-500 transition border border-slate-200/80 shadow-sm" title="Open Sidebar">
              <Menu className="w-4 h-4" />
            </button>
          )}
          <div>
            <span className="font-semibold text-slate-800 text-sm tracking-[0.08em] uppercase">Feature Canvas</span>
            <p className="text-[11px] text-slate-500 mt-0.5">Review, refine, and push backlog-ready features.</p>
          </div>
          
          <UsageMeter usage={usage} limits={limits} tier={tier} isCompact />
        </div>
        {hasFeatures && (
          <div className="flex items-center gap-4">
            {features.some(f => f.pendingRefinement) && (
              <div className="flex items-center gap-2 pr-4 border-r border-slate-200">
                <button onClick={discardAllProposed} className="text-[11px] font-bold text-slate-400 hover:text-red-500 transition">Discard All</button>
                <button onClick={acceptAllProposed} className="px-3 py-1 bg-green-600 hover:bg-green-700 text-white text-[11px] font-bold rounded-lg transition shadow-sm">Accept All Changes</button>
              </div>
            )}

            <div className="relative">
              <button 
                onClick={() => setShowBulkRefine(!showBulkRefine)} 
                className={`flex items-center gap-2 px-3 py-2 rounded-2xl border text-xs font-semibold transition-all ${showBulkRefine ? 'bg-slate-900 text-white border-slate-900 shadow-lg' : 'bg-white/85 text-slate-600 border-slate-200 hover:border-blue-300 hover:text-blue-700 shadow-sm'}`}
              >
                <Sparkles className={`w-3.5 h-3.5 ${showBulkRefine ? 'animate-pulse' : ''}`} />
                Refine All
              </button>

              {showBulkRefine && (
                <div className="absolute right-0 top-full mt-3 w-[400px] rf-glass-strong rounded-[24px] p-4 z-50 slide-down">
                  <div className="flex items-center justify-between mb-3 px-1">
                    <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
                       <Sparkles className="w-3.5 h-3.5 text-purple-500" /> Advanced Bulk Refine
                    </h4>
                    <button onClick={() => setShowBulkRefine(false)} className="p-1 hover:bg-slate-100 rounded-md transition text-slate-400"><X className="w-4 h-4" /></button>
                  </div>
                  <textarea
                    autoFocus
                    placeholder="e.g. Make all stories more technical, or ensure they all follow regulatory compliance rules..."
                    value={bulkInput}
                    onChange={(e) => setBulkInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        handleBulkRefine();
                      }
                    }}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm min-h-[100px] outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 transition resize-none mb-3"
                  />
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] text-slate-400">⌘ + Enter to apply</span>
                    <button 
                      onClick={handleBulkRefine}
                      disabled={!bulkInput.trim() || isBulkRefining}
                      className="px-5 py-2 bg-slate-800 hover:bg-slate-900 text-white text-xs font-bold rounded-xl transition shadow-lg active:scale-95 disabled:opacity-50 flex items-center gap-2"
                    >
                      {isBulkRefining ? (
                        <>
                          <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                          Refining...
                        </>
                      ) : (
                        <>
                          <Send className="w-3.5 h-3.5" /> Apply to All
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center gap-3 ml-2 border-l border-slate-200 pl-4">
              <div className="px-3 py-1 bg-blue-50 text-blue-700 text-xs font-bold uppercase rounded-full tracking-wider flex items-center gap-2">
                <span>{features.length} Features</span>
                <span className="w-1 h-1 bg-blue-300 rounded-full" />
                <span>{totalArCount} Acceptance Requirements</span>
              </div>
              <div className="text-xs text-slate-400">
                {features.filter(f => f.isAccepted).length} accepted
              </div>
            </div>
          </div>
        )}
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto w-full flex flex-col items-center relative custom-scrollbar">
        {isGenerating ? (
          <GeneratingSkeleton />
        ) : !hasFeatures ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center fade-in max-w-md mx-auto p-6">
            <div className="w-[72px] h-[72px] bg-white/80 rounded-[24px] flex items-center justify-center mb-6 shadow-[0_24px_52px_-28px_rgba(37,99,235,0.5)] border border-white/80 p-4">
              <Sparkles className="w-8 h-8 text-blue-400" />
            </div>
            <h2 className="text-2xl font-semibold text-slate-900 tracking-tight mb-2">Ready to generate</h2>
            <p className="text-slate-500 text-sm leading-relaxed">Describe your requirement in the sidebar, answer the clarifying questions, and your features will appear here.</p>
          </div>
        ) : (
          <div className="w-full px-6 md:px-12 py-8 space-y-4 fade-in flex-1">
            {generationContext && (
              <div className="rf-surface rounded-[24px] p-5">
                <div className="flex flex-wrap items-center gap-4 text-xs">
                  <div className="font-semibold text-slate-800">
                    Context used: {generationContext.goldExamplesCount} golden example{generationContext.goldExamplesCount !== 1 ? 's' : ''}
                  </div>
                  {generationContext.domainRolesUsed?.length > 0 && (
                    <div className="text-slate-600">
                      Roles: {generationContext.domainRolesUsed.join(', ')}
                    </div>
                  )}
                </div>
                {generationContext.referencedGoldExamples?.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {generationContext.referencedGoldExamples.map((example, i) => (
                      <span
                        key={`${example.source}-${example.key}-${i}`}
                        className="rf-chip inline-flex items-center gap-1 rounded-full text-blue-700 px-2.5 py-1 text-[11px] font-medium"
                        title={example.summary}
                      >
                        {example.source}: {example.key}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {features.map((feature, idx) => {
              const isEditing = editingIdx === idx;
              const draft = editDraft;

              return (
                <div key={feature.id || idx} className={`rf-surface rounded-[24px] transition-all duration-300 overflow-hidden ${feature.pendingRemoval ? 'border-red-400 opacity-80' : feature.isAccepted ? 'border-green-300 ring-1 ring-green-100' : 'border-slate-200/80'}`}>
                  {/* Accent bar */}
                  <div className={`h-1.5 ${feature.pendingRemoval ? 'bg-red-500' : feature.isAccepted ? 'bg-gradient-to-r from-green-400 to-emerald-500' : 'bg-gradient-to-r from-blue-500 via-sky-500 to-indigo-500'}`} />

                  <div className="p-5">
                    {/* Title row */}
                    <div className="flex items-start justify-between gap-4 mb-3">
                      {isEditing ? (
                        <input
                          type="text"
                          value={draft?.title || draft?.summary || ''}
                          onChange={e => setEditDraft(d => d ? { ...d, summary: e.target.value, title: e.target.value } : null)}
                          className="flex-1 text-base font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-blue-500 outline-none"
                        />
                      ) : (
                        <div className="flex-1 flex items-center gap-3 cursor-pointer group/title" onClick={() => toggleExpand(idx)}>
                          <h2 className="text-base font-semibold tracking-tight text-slate-800">
                            {feature.title || feature.summary || 'Untitled Feature'}
                          </h2>
                          <div className="px-2 py-0.5 bg-slate-100 text-slate-500 text-[10px] font-bold rounded-full group-hover/title:bg-blue-50 group-hover/title:text-blue-600 transition-colors">
                            {feature.acceptanceRequirements?.length || 0} ARs
                          </div>
                          <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform duration-300 ${expandedIndices.has(idx) ? 'rotate-180' : ''}`} />
                        </div>
                      )}

                      <div className="flex items-center gap-1.5 shrink-0">
                        {isEditing ? (
                          <>
                            <button onClick={cancelEditing} className="px-2.5 py-1 text-xs font-semibold text-slate-500 bg-slate-100 hover:bg-slate-200 rounded-md transition">Cancel</button>
                            <button onClick={saveEditing} className="px-2.5 py-1 text-xs font-semibold text-white bg-green-600 hover:bg-green-700 rounded-md transition flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Save</button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => startEditing(idx)} className="px-2.5 py-1 text-xs font-semibold text-slate-600 bg-slate-50 hover:bg-blue-50 hover:text-blue-600 border border-slate-200 rounded-md transition flex items-center gap-1"><Edit2 className="w-3.5 h-3.5" /> Edit</button>
                            <button onClick={() => setRefinePopupIdx(idx)} className="px-2.5 py-1 text-xs font-semibold text-slate-600 bg-slate-50 hover:bg-purple-50 hover:text-purple-600 border border-slate-200 rounded-md transition flex items-center gap-1"><Sparkles className="w-3.5 h-3.5" /> Refine</button>
                            <button onClick={() => toggleAccepted(idx)} className={`px-2.5 py-1 text-xs font-semibold rounded-md transition border flex items-center gap-1 ${feature.isAccepted ? 'text-green-700 bg-green-100 border-green-200' : 'text-slate-600 bg-slate-50 hover:bg-green-50 hover:text-green-600 hover:border-green-200 border-slate-200'}`}>
                              <Check className="w-3.5 h-3.5" /> {feature.isAccepted ? 'Accepted' : 'Accept'}
                            </button>
                            {feature.jiraIssueKey ? (
                              <div className="flex items-center gap-1">
                                <button 
                                  onClick={() => feature.jiraIssueUrl ? router.navigate(feature.jiraIssueUrl) : null}
                                  className="px-2.5 py-1 text-xs font-semibold text-blue-700 bg-blue-100 hover:bg-blue-200 rounded-md transition flex items-center gap-1"
                                >
                                  <Check className="w-3.5 h-3.5" /> Pushed: {feature.jiraIssueKey}
                                </button>
                                <button
                                  onClick={() => {
                                    if (window.confirm(`Safety Warning: This feature has already been pushed to Jira as issue ${feature.jiraIssueKey}.\n\nAre you sure you want to push it again and create a duplicate issue?`)) {
                                      onPushFeature(idx);
                                    }
                                  }}
                                  title="Push a duplicate to Jira"
                                  className="px-2 py-1 text-xs text-slate-400 bg-slate-50 border border-slate-200 hover:bg-slate-100 hover:text-slate-600 rounded-md transition flex items-center justify-center"
                                >
                                  <Upload className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ) : (
                              <button 
                                onClick={() => onPushFeature(idx)} 
                                disabled={!feature.isAccepted}
                                title={!feature.isAccepted ? "Accept feature first to push to Jira" : ""}
                                className="px-2.5 py-1 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-md transition flex items-center gap-1 shadow-sm"
                              >
                                <Upload className="w-3.5 h-3.5" /> Push to Jira
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    {feature.pendingRemoval && (
                      <div className="mb-3 p-3 rounded-lg bg-red-50 border border-red-200 flex items-center justify-between">
                         <div className="flex items-center gap-2 text-red-800 font-bold text-xs">
                           <Trash2 className="w-3.5 h-3.5" /> Proposed for Removal
                         </div>
                         <div className="flex items-center gap-2">
                           <button onClick={() => setFeatures(prev => prev.map((f, i) => i === idx ? { ...f, pendingRemoval: false } : f))} className="px-2 py-1 text-[10px] font-semibold text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-md">Keep Instead</button>
                           <button onClick={() => setFeatures(prev => prev.filter((_, i) => i !== idx))} className="px-2 py-1 text-[10px] font-semibold text-white bg-red-600 hover:bg-red-700 rounded-md shadow-sm">Confirm Removal</button>
                         </div>
                      </div>
                    )}

                    {/* Pending refinement diff view */}
                    {feature.pendingRefinement && (() => {
                      const proposed = feature.pendingRefinement!;
                      const origTitle = feature.title || feature.summary || '';
                      const propTitle = proposed.title || proposed.summary || '';
                      const origDesc = feature.description || feature.markdown || '';
                      const propDesc = proposed.description || proposed.markdown || '';
                      return (
                        <div className="mb-3 p-3 rounded-lg bg-amber-50 border border-amber-200">
                          <div className="flex items-center justify-between mb-2">
                            <h3 className="text-amber-800 font-bold text-xs flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5" /> AI Suggested Refinements</h3>
                            
                            <div className="flex items-center gap-3">
                              <div className="flex items-center bg-white/60 p-0.5 rounded-md border border-amber-200">
                                <button 
                                  onClick={() => setDiffMode('redline')}
                                  className={`px-2 py-0.5 text-[9px] font-bold rounded transition-all ${diffMode === 'redline' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                                >
                                  Redline
                                </button>
                                <button 
                                  onClick={() => setDiffMode('blackline')}
                                  className={`px-2 py-0.5 text-[9px] font-bold rounded transition-all ${diffMode === 'blackline' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                                >
                                  Blackline
                                </button>
                              </div>

                              <div className="flex items-center gap-2">
                                <button onClick={() => rejectRefinement(idx)} className="px-2 py-1 text-[10px] font-semibold text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-md shadow-sm">Reject</button>
                                <button onClick={() => acceptRefinement(idx)} className="px-2 py-1 text-[10px] font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md shadow-sm flex items-center gap-1"><Check className="w-3 h-3" /> Accept</button>
                              </div>
                            </div>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div className="bg-white p-3 rounded-lg border border-slate-200 opacity-60">
                              <div className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">Original</div>
                              <h4 className="text-xs font-bold text-slate-800 mb-1">{origTitle}</h4>
                              <div className="text-[11px] text-slate-600 mb-2 whitespace-pre-wrap leading-relaxed">{origDesc}</div>
                              <div className="space-y-1">
                                {feature.acceptanceRequirements.map((ar, i) => (
                                  <div key={i} className="bg-slate-50 border border-slate-100 p-1.5 rounded text-[10px] text-slate-600">
                                    {ar.given && <div><strong>Given</strong> {ar.given}</div>}
                                    {ar.when && <div><strong>When</strong> {ar.when}</div>}
                                    <div><strong>Then</strong> {ar.then}</div>
                                  </div>
                                ))}
                              </div>
                            </div>
                            <div className="bg-blue-50/30 p-4 rounded-lg border border-blue-200 shadow-sm ring-1 ring-blue-100">
                              <div className="text-[9px] font-bold text-blue-500 uppercase tracking-widest mb-2">Proposed ({diffMode === 'redline' ? 'Diff' : 'Result'})</div>
                              <h4 className="text-sm font-bold text-slate-800 mb-2"><DiffText oldText={origTitle} newText={propTitle} mode={diffMode} /></h4>
                              <div className="text-xs text-slate-600 mb-4 whitespace-pre-wrap leading-relaxed"><DiffText oldText={origDesc} newText={propDesc} mode={diffMode} /></div>
                              <div className="space-y-2">
                                {proposed.acceptanceRequirements.map((ar, i) => {
                                  const oldAr = feature.acceptanceRequirements[i];
                                  const isNew = !oldAr;
                                  return (
                                    <div key={i} className={`p-2 rounded text-[11px] text-slate-700 shadow-sm border ${isNew ? 'bg-green-50 border-green-200' : 'bg-white border-blue-100'}`}>
                                      {isNew && <div className="text-[9px] font-bold text-green-700 uppercase tracking-wide mb-1">★ New AR</div>}
                                      {ar.given && <div><strong className="text-blue-600">Given</strong>{' '}<DiffText oldText={oldAr?.given || ''} newText={ar.given} fullHighlight={isNew} mode={diffMode} /></div>}
                                      {ar.when && <div><strong className="text-blue-600">When</strong>{' '}<DiffText oldText={oldAr?.when || ''} newText={ar.when} fullHighlight={isNew} mode={diffMode} /></div>}
                                      <div><strong className="text-blue-600">Then</strong>{' '}<DiffText oldText={oldAr?.then || ''} newText={ar.then} fullHighlight={isNew} mode={diffMode} /></div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Feature body */}
                    {(expandedIndices.has(idx) || isEditing) && (
                      <div className={`mt-2 ${feature.pendingRefinement ? 'opacity-30 pointer-events-none' : ''}`}>
                        {isEditing ? (
                          <textarea
                            value={draft?.description || ''}
                            onChange={e => setEditDraft(d => d ? { ...d, description: e.target.value } : null)}
                            className="w-full text-slate-600 text-[15px] bg-white border border-slate-300 rounded-lg px-3 py-2 min-h-[100px] mb-4 focus:ring-2 focus:ring-blue-500 outline-none resize-y"
                          />
                        ) : (
                          <div className="text-slate-600 text-[15px] mb-4 whitespace-pre-wrap leading-relaxed border-l-2 border-slate-100 pl-4">
                            {feature.markdown || feature.description}
                          </div>
                        )}

                        {/* Acceptance Criteria */}
                        {((isEditing && draft?.acceptanceRequirements) || (!isEditing && feature.acceptanceRequirements?.length > 0)) && (
                          <div className="mt-2 text-sm">
                            <div className="flex items-center justify-between mb-3 border-b border-slate-100 pb-2">
                              <h3 className="text-[12px] font-bold text-slate-400 uppercase tracking-widest">Acceptance Criteria</h3>
                              {isEditing && (
                                <button onClick={addDraftAr} className="text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 px-2 py-1 rounded transition flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Add AR</button>
                              )}
                            </div>
                            <div className="space-y-2">
                              {(isEditing ? draft!.acceptanceRequirements : feature.acceptanceRequirements).map((ar, i) => (
                                <div key={i} className="bg-slate-50/50 rounded-xl p-3 border border-slate-100/60 shadow-sm relative group">
                                  {isEditing && (
                                    <button onClick={() => deleteDraftAr(i)} className="absolute top-2 right-2 p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-md transition opacity-0 group-hover:opacity-100"><Trash2 className="w-4 h-4" /></button>
                                  )}
                                  {isEditing ? (
                                    <div className="space-y-2 pr-8">
                                      {(['given', 'when', 'then'] as const).map(field => (
                                        <div key={field} className="flex items-start gap-2">
                                          <strong className="text-slate-700 w-12 pt-1.5 text-xs uppercase tracking-wider">{field}</strong>
                                          {field === 'then'
                                            ? <textarea value={ar[field]} onChange={e => updateDraftAr(i, field, e.target.value)} rows={2} className="flex-1 bg-white border border-slate-200 rounded px-2 py-1 text-sm outline-none focus:border-blue-400 resize-none" />
                                            : <input value={ar[field]} onChange={e => updateDraftAr(i, field, e.target.value)} className="flex-1 bg-white border border-slate-200 rounded px-2 py-1 text-sm outline-none focus:border-blue-400" />
                                          }
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <div className="space-y-1.5 text-sm">
                                      {ar.given?.trim() && (
                                        <div className="flex gap-4">
                                          <div className="w-10 shrink-0 text-[10px] font-bold text-slate-400 uppercase pt-0.5 tracking-tight">Given</div>
                                          <div className="text-slate-600 leading-normal">{ar.given}</div>
                                        </div>
                                      )}
                                      {ar.when?.trim() && (
                                        <div className="flex gap-4">
                                          <div className="w-10 shrink-0 text-[10px] font-bold text-slate-400 uppercase pt-0.5 tracking-tight">When</div>
                                          <div className="text-slate-600 leading-normal">{ar.when}</div>
                                        </div>
                                      )}
                                      <div className="flex gap-4">
                                        <div className="w-10 shrink-0 text-[10px] font-bold text-slate-400 uppercase pt-0.5 tracking-tight">Then</div>
                                        <div className="text-slate-600 leading-normal whitespace-pre-wrap">{ar.then}</div>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* AI Refine Popup */}
      {refinePopupIdx !== null && (
        <RefinePopup
          feature={features[refinePopupIdx]}
          onClose={() => setRefinePopupIdx(null)}
          onResult={(refined) => {
            setFeatures(prev => {
              const n = [...prev];
              n[refinePopupIdx] = { ...n[refinePopupIdx], pendingRefinement: refined };
              return n;
            });
            setRefinePopupIdx(null);
          }}
        />
      )}
    </main>
  );
}
