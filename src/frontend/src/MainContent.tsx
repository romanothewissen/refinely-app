import React, { useState } from 'react';
import { Send, Sparkles, Edit2, Check, X, Plus, Trash2, Menu, Upload, ChevronDown, Coins } from 'lucide-react';
import { api } from './hooks/useForge';
import { router } from '@forge/bridge';

// ─── Word-level diff utility ──────────────────────────────────────────────────
type DiffToken = { text: string; type: 'same' | 'added' | 'removed' };
type AcceptanceRequirement = { given: string; when: string; then: string };

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

function normaliseWhitespace(text: string): string {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenSet(text: string): Set<string> {
  const tokens = normaliseWhitespace(text)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
  return new Set(tokens);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

function arSimilarity(left: AcceptanceRequirement, right: AcceptanceRequirement): number {
  const leftText = `${left.given} ${left.when} ${left.then}`.trim();
  const rightText = `${right.given} ${right.when} ${right.then}`.trim();
  const exact = normaliseWhitespace(leftText) === normaliseWhitespace(rightText);
  if (exact) return 1;
  return jaccard(tokenSet(leftText), tokenSet(rightText));
}

function alignAcceptanceRequirements(
  original: AcceptanceRequirement[],
  proposed: AcceptanceRequirement[],
): Array<{ proposed: AcceptanceRequirement; oldAr?: AcceptanceRequirement; oldIndex?: number; isNew: boolean }> {
  const usedOriginalIndices = new Set<number>();
  const rows: Array<{ proposed: AcceptanceRequirement; oldAr?: AcceptanceRequirement; oldIndex?: number; isNew: boolean }> = [];

  for (const nextAr of proposed) {
    let bestIndex = -1;
    let bestScore = 0;

    for (let i = 0; i < original.length; i += 1) {
      if (usedOriginalIndices.has(i)) continue;
      const score = arSimilarity(original[i], nextAr);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    const matched = bestIndex >= 0 && bestScore >= 0.45;
    if (matched) {
      usedOriginalIndices.add(bestIndex);
      rows.push({ proposed: nextAr, oldAr: original[bestIndex], oldIndex: bestIndex, isNew: false });
    } else {
      rows.push({ proposed: nextAr, isNew: true });
    }
  }

  return rows;
}

// ─── AI Refine Popup ──────────────────────────────────────────────────────────
function RefinePopup({ feature, sessionId, onClose, onResult }: {
  feature: Feature;
  sessionId: string;
  onClose: () => void;
  onResult: (refined: Feature, tokenUsage?: { input: number; output: number; total: number }) => void;
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
      const res = await api.refineSingleFeature(feature, feedback, sessionId) as any;
      if (res.success && res.feature) {
        onResult(res.feature, res.tokenUsage);
      } else {
        setError('Refinement failed \u2014 please try again.');
        setLoading(false);
      }
    } catch (e: any) {
      setError(e?.message ?? 'Unknown error');
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/20" onClick={!loading ? onClose : undefined} />
      <div className="relative bg-white w-full max-w-lg rounded-lg shadow-[var(--rf-shadow-lg)] flex flex-col overflow-hidden slide-up border border-[var(--rf-border)]">
        <div className="px-5 py-3.5 border-b border-[var(--rf-border)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[var(--rf-brand)]" />
            <span className="font-semibold text-[var(--rf-text)] text-sm">AI Refine</span>
            <span className="text-[var(--rf-text-tertiary)] text-xs ml-1 line-clamp-1 max-w-[200px]">\u2014 {feature.title || feature.summary}</span>
          </div>
          {!loading && (
            <button onClick={onClose} className="p-1.5 hover:bg-[var(--rf-bg)] text-[var(--rf-text-tertiary)] rounded-md transition"><X className="w-4 h-4" /></button>
          )}
        </div>

        <div className="px-5 py-5">
          {loading ? (
            <div className="flex flex-col items-center py-8 gap-4">
              <div className="w-10 h-10 rounded-lg bg-[var(--rf-brand-subtle)] flex items-center justify-center">
                <div className="w-6 h-6 border-[2.5px] border-blue-200 border-t-[var(--rf-brand)] rounded-full spin-slow" />
              </div>
              <div className="text-center">
                <p className="font-semibold text-[var(--rf-text)] text-sm">Refining feature\u2026</p>
                <p className="text-xs text-[var(--rf-text-tertiary)] mt-1">The AI is working on your request</p>
              </div>
              <div className="dot-bounce text-[var(--rf-brand)]"><span /><span /><span /></div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-[var(--rf-text-secondary)]">Describe what you want changed \u2014 e.g. "Add an AR for invalid password", "Tighten the scope to mobile only"</p>
              <textarea
                rows={4}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSend(); }}
                placeholder="Your refinement instructions\u2026"
                className="w-full bg-[var(--rf-bg)] border border-[var(--rf-border)] rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--rf-brand)] focus:border-[var(--rf-brand)] transition resize-none"
                autoFocus
              />
              {error && <p className="text-xs text-[var(--rf-danger)]">{error}</p>}
            </div>
          )}
        </div>

        {!loading && (
          <div className="px-5 py-3.5 border-t border-[var(--rf-border)] flex items-center justify-between gap-3 bg-[var(--rf-bg)]">
            <span className="text-[11px] text-[var(--rf-text-tertiary)]">\u2318 + Enter to send</span>
            <div className="flex gap-2">
              <button onClick={onClose} className="px-3 py-1.5 text-xs font-medium text-[var(--rf-text-secondary)] border border-[var(--rf-border)] rounded-md hover:bg-white transition bg-white">Cancel</button>
              <button
                onClick={handleSend}
                disabled={!input.trim()}
                className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] disabled:opacity-40 rounded-md transition active:scale-[0.98]"
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
  acceptanceRequirements: AcceptanceRequirement[];
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
  generationContext?: {
    domainRolesUsed: string[];
    goldExamplesCount: number;
    referencedGoldExamples: Array<{ key: string; source: string; summary: string }>;
    projectKey: string;
    domainContextApplied?: boolean;
    attachmentIncluded?: boolean;
    wiDocsCount?: number;
    referencedWiDocs?: Array<{ docId: string; filename: string; chunkCount: number }>;
    similarStoriesCount?: number;
    referencedSimilarStories?: Array<{ key: string; summary: string; relevanceScore?: number }>;
    tokenUsage?: { input: number; output: number; total: number; byStage?: Record<string, { input: number; output: number; total: number }> };
  } | null;
  projectKey: string;
  workflowTokenUsage?: { input: number; output: number; total: number } | null;
  onWorkflowTokenUsage?: (usage: { input: number; output: number; total: number }) => void;
}

// ─── Main component ───────────────────────────────────────────────────────────
export function MainContent({
  features, setFeatures, onPushFeature, isGenerating, progress,
  sidebarOpen, setSidebarOpen, sessionId, requirement,
  generationContext, projectKey, workflowTokenUsage, onWorkflowTokenUsage
}: MainContentProps) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<Feature | null>(null);
  const [refinePopupIdx, setRefinePopupIdx] = useState<number | null>(null);

  const [diffMode, setDiffMode] = useState<'redline' | 'blackline'>('redline');
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
  const [showBulkRefine, setShowBulkRefine] = useState(false);
  const [showTokenDetails, setShowTokenDetails] = useState(false);
  const [bulkInput, setBulkInput] = useState('');
  const [isBulkRefining, setIsBulkRefining] = useState(false);
  const [lastAiTokenUsage, setLastAiTokenUsage] = useState<{ label: string; input: number; output: number; total: number } | null>(null);

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
        if (res.tokenUsage) {
          setLastAiTokenUsage({ label: 'Bulk refine', ...res.tokenUsage });
          onWorkflowTokenUsage?.(res.tokenUsage);
        }
        setFeatures(prev => {
          return prev.map((f, i) => {
            const r = refined[i];
            if (!r) {
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
    <div className="w-full max-w-4xl mx-auto px-6 py-8 space-y-5 fade-in h-full flex flex-col pt-12">
      <div className="flex flex-col items-center gap-3 mb-4 zoom-in">
        <div className="w-10 h-10 rounded-lg bg-[var(--rf-brand-subtle)] flex items-center justify-center">
          <Sparkles className="w-5 h-5 text-[var(--rf-brand)]" />
        </div>
        <div className="text-center">
          <h2 className="text-lg font-semibold text-[var(--rf-text)]">Generating features</h2>
          <p className="text-sm text-[var(--rf-text-secondary)] mt-0.5">{progress || 'Processing your request\u2026'}</p>
        </div>
        <div className="dot-bounce text-[var(--rf-brand)] mt-1"><span /><span /><span /></div>
      </div>

      <div className="space-y-4">
        {[1, 2, 3].map(i => (
          <div key={i} className="rounded-lg border border-[var(--rf-border)] bg-white overflow-hidden shadow-[var(--rf-shadow-sm)]" style={{ animationDelay: `${i * 0.12}s` }}>
            <div className="flex">
              <div className="w-1 shrink-0 bg-[var(--rf-border)]" />
              <div className="flex-1 p-5 space-y-3">
                <div className="shimmer h-4 w-2/5 rounded" />
                <div className="shimmer h-3 w-full rounded" />
                <div className="shimmer h-3 w-4/5 rounded" />
                <div className="space-y-2 pt-2">
                  {[1,2,3].map(j => <div key={j} className="shimmer h-2.5 rounded" style={{ width: `${60 + j * 10}%` }} />)}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <main className="flex-1 flex flex-col h-full relative overflow-hidden bg-[var(--rf-bg)]">
      {/* Header */}
      <header className="shrink-0 border-b border-[var(--rf-border)] bg-white px-5 py-3 z-10 sticky top-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            {!sidebarOpen && (
              <button onClick={() => setSidebarOpen(true)} className="p-1.5 -ml-0.5 rounded-md hover:bg-[var(--rf-bg)] text-[var(--rf-text-secondary)] transition border border-[var(--rf-border)]" title="Open Sidebar">
                <Menu className="w-4 h-4" />
              </button>
            )}
            <div className="min-w-0 flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-[var(--rf-text)]">Feature Canvas</h2>
              <div className="inline-flex items-center gap-1 rounded border border-[var(--rf-border)] bg-[var(--rf-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--rf-text-secondary)]">
                <span className="text-[var(--rf-text-tertiary)]">Scope</span>
                <span className="font-semibold text-[var(--rf-text)]">
                  {projectKey === '*' ? 'Standalone workspace' : projectKey}
                </span>
              </div>
            </div>
          </div>
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowTokenDetails(prev => !prev)}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--rf-border)] bg-white px-2 py-1 text-[11px] font-medium text-[var(--rf-text-secondary)] hover:bg-[var(--rf-bg)]"
              title="Workflow token usage"
            >
              <Coins className="w-3.5 h-3.5 text-[var(--rf-text-tertiary)]" />
              Tokens
            </button>
            {showTokenDetails && (
              <div className="absolute right-0 top-full mt-2 w-[250px] rounded-md border border-[var(--rf-border)] bg-white p-3 shadow-[var(--rf-shadow-lg)] z-40">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--rf-text-tertiary)]">Workflow tokens</div>
                <div className="mt-1 text-base font-semibold text-[var(--rf-text)]">
                  {(workflowTokenUsage?.total ?? 0).toLocaleString()}
                </div>
                <div className="mt-1 text-[11px] text-[var(--rf-text-secondary)]">
                  {(workflowTokenUsage?.input ?? 0).toLocaleString()} in / {(workflowTokenUsage?.output ?? 0).toLocaleString()} out
                </div>
                <div className="mt-2 text-[10px] text-[var(--rf-text-tertiary)]">
                  Includes clarify, generation, and refinements.
                </div>
                {lastAiTokenUsage && (
                  <div className="mt-2 border-t border-[var(--rf-border-subtle)] pt-2 text-[10px] text-[var(--rf-text-tertiary)]">
                    Last action: {lastAiTokenUsage.label} ({lastAiTokenUsage.total.toLocaleString()} tokens)
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {hasFeatures && (
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2.5">
            <div className="inline-flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center rounded border border-[var(--rf-border)] bg-[var(--rf-bg)] px-2.5 py-1 text-[11px] font-semibold text-[var(--rf-text)]">
                  {features.length} Features
                  <span className="mx-1.5 text-[var(--rf-border)]">|</span>
                  {totalArCount} ARs
              </span>
              <span className="text-[11px] text-[var(--rf-text-tertiary)]">
                {features.filter(f => f.isAccepted).length} accepted
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {features.some(f => f.pendingRefinement) && (
                <>
                  <button onClick={discardAllProposed} className="px-2.5 py-1.5 text-[11px] font-semibold text-[var(--rf-text-secondary)] bg-white border border-[var(--rf-border)] rounded-md hover:text-[var(--rf-danger)] hover:border-red-300 transition">Discard All</button>
                  <button onClick={acceptAllProposed} className="px-2.5 py-1.5 bg-[var(--rf-success)] hover:bg-green-700 text-white text-[11px] font-semibold rounded-md transition">Accept All</button>
                </>
              )}

              <div className="relative">
                <button
                  onClick={() => setShowBulkRefine(!showBulkRefine)}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-[11px] font-semibold transition ${showBulkRefine ? 'bg-[var(--rf-text)] text-white border-[var(--rf-text)]' : 'bg-white text-[var(--rf-text-secondary)] border-[var(--rf-border)] hover:border-[var(--rf-brand)] hover:text-[var(--rf-brand)]'}`}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Refine All
                </button>

                {showBulkRefine && (
                  <div className="absolute right-0 top-full mt-2 w-[380px] bg-white rounded-lg border border-[var(--rf-border)] p-4 z-50 shadow-[var(--rf-shadow-lg)] slide-up">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-[11px] font-semibold text-[var(--rf-text-secondary)] uppercase tracking-wide flex items-center gap-1.5">
                         <Sparkles className="w-3.5 h-3.5 text-[var(--rf-brand)]" /> Bulk Refine
                      </h4>
                      <button onClick={() => setShowBulkRefine(false)} className="p-1 hover:bg-[var(--rf-bg)] rounded-md transition text-[var(--rf-text-tertiary)]"><X className="w-4 h-4" /></button>
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
                      className="w-full bg-[var(--rf-bg)] border border-[var(--rf-border)] rounded-md p-3 text-sm min-h-[100px] outline-none focus:ring-1 focus:ring-[var(--rf-brand)] focus:border-[var(--rf-brand)] transition resize-none mb-3"
                    />
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[10px] text-[var(--rf-text-tertiary)]">\u2318 + Enter to apply</span>
                      <button
                        onClick={handleBulkRefine}
                        disabled={!bulkInput.trim() || isBulkRefining}
                        className="px-4 py-1.5 bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] text-white text-xs font-semibold rounded-md transition active:scale-[0.98] disabled:opacity-50 flex items-center gap-1.5"
                      >
                        {isBulkRefining ? (
                          <>
                            <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
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
            <div className="w-14 h-14 bg-[var(--rf-brand-subtle)] rounded-lg flex items-center justify-center mb-5">
              <Sparkles className="w-6 h-6 text-[var(--rf-brand)]" />
            </div>
            <h2 className="text-xl font-semibold text-[var(--rf-text)] mb-2">Ready to generate</h2>
            <p className="text-[var(--rf-text-secondary)] text-sm leading-relaxed">Describe your requirement in the sidebar, answer the clarifying questions, and your features will appear here.</p>
          </div>
        ) : (
          <div className="w-full max-w-4xl mx-auto px-6 py-6 space-y-3 fade-in flex-1">
            {generationContext && (
              <div className="rounded-lg border border-[var(--rf-border)] bg-white p-4 shadow-[var(--rf-shadow-sm)]">
                <div className="flex flex-wrap items-center gap-4 text-xs">
                  <div className="font-semibold text-[var(--rf-text)]">
                    Context used: {generationContext.goldExamplesCount} golden example{generationContext.goldExamplesCount !== 1 ? 's' : ''}
                  </div>
                  <div className="text-[var(--rf-text-secondary)]">
                    Project: {generationContext.projectKey === '*' ? 'Standalone workspace' : generationContext.projectKey}
                  </div>
                  <div className="text-[var(--rf-text-secondary)]">
                    Domain guidance: {generationContext.domainContextApplied ? 'Included' : 'Not configured'}
                  </div>
                  <div className="text-[var(--rf-text-secondary)]">
                    Attachment: {generationContext.attachmentIncluded ? 'Included' : 'None'}
                  </div>
                  {generationContext.domainRolesUsed?.length > 0 && (
                    <div className="text-[var(--rf-text-secondary)]">
                      Roles: {generationContext.domainRolesUsed.join(', ')}
                    </div>
                  )}
                </div>
                {generationContext.referencedGoldExamples?.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {generationContext.referencedGoldExamples.map((example, i) => (
                      <span
                        key={`${example.source}-${example.key}-${i}`}
                        className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)] border border-blue-200"
                        title={example.summary}
                      >
                        {example.source}: {example.key}
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-3 pt-3 border-t border-[var(--rf-border-subtle)]">
                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    <div className="font-semibold text-[var(--rf-text)]">
                      Work instructions used: {generationContext.wiDocsCount ?? 0}
                    </div>
                    {generationContext.referencedWiDocs?.length ? (
                      <div className="text-[var(--rf-text-secondary)]">
                        {generationContext.referencedWiDocs.map(doc => doc.filename).join(', ')}
                      </div>
                    ) : (
                      <div className="text-[var(--rf-text-tertiary)]">No project docs were matched for this run.</div>
                    )}
                  </div>
                </div>
                <div className="mt-3 pt-3 border-t border-[var(--rf-border-subtle)]">
                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    <div className="font-semibold text-[var(--rf-text)]">
                      Similar backlog stories used: {generationContext.similarStoriesCount ?? 0}
                    </div>
                    {generationContext.referencedSimilarStories?.length ? (
                      <div className="text-[var(--rf-text-secondary)]">
                        {generationContext.referencedSimilarStories.map(story => story.key).join(', ')}
                      </div>
                    ) : (
                      <div className="text-[var(--rf-text-tertiary)]">No similar backlog stories were used for this run.</div>
                    )}
                  </div>
                </div>
                {generationContext.tokenUsage && (
                  <div className="mt-3 pt-3 border-t border-[var(--rf-border-subtle)] text-xs text-[var(--rf-text-secondary)]">
                    Tokens used for generation: {generationContext.tokenUsage.total.toLocaleString()} ({generationContext.tokenUsage.input.toLocaleString()} in / {generationContext.tokenUsage.output.toLocaleString()} out)
                  </div>
                )}
              </div>
            )}

            {features.map((feature, idx) => {
              const isEditing = editingIdx === idx;
              const draft = editDraft;

              return (
                <div key={feature.id || idx} className={`rounded-lg border bg-white shadow-[var(--rf-shadow-sm)] transition-all duration-200 overflow-hidden ${feature.pendingRemoval ? 'border-red-400 opacity-80' : feature.isAccepted ? 'border-green-400' : 'border-[var(--rf-border)]'}`}>
                  {/* Left accent — thin solid line */}
                  <div className="flex">
                    <div className={`w-1 shrink-0 ${feature.pendingRemoval ? 'bg-[var(--rf-danger)]' : feature.isAccepted ? 'bg-[var(--rf-success)]' : 'bg-[var(--rf-brand)]'}`} />

                    <div className="flex-1 p-5">
                      {/* Title row */}
                      <div className="flex items-start justify-between gap-4 mb-2">
                        {isEditing ? (
                          <input
                            type="text"
                            value={draft?.title || draft?.summary || ''}
                            onChange={e => setEditDraft(d => d ? { ...d, summary: e.target.value, title: e.target.value } : null)}
                            className="flex-1 text-sm font-semibold text-[var(--rf-text)] bg-white border border-[var(--rf-border)] rounded-md px-3 py-1.5 focus:ring-1 focus:ring-[var(--rf-brand)] outline-none"
                          />
                        ) : (
                          <div className="flex-1 flex items-center gap-2 cursor-pointer group/title" onClick={() => toggleExpand(idx)}>
                            <h3 className="text-sm font-semibold text-[var(--rf-text)]">
                              {feature.title || feature.summary || 'Untitled Feature'}
                            </h3>
                            <span className="inline-flex items-center rounded px-1.5 py-0.5 bg-[var(--rf-bg)] text-[var(--rf-text-tertiary)] text-[10px] font-medium border border-[var(--rf-border-subtle)]">
                              {feature.acceptanceRequirements?.length || 0} ARs
                            </span>
                            <ChevronDown className={`w-3.5 h-3.5 text-[var(--rf-text-tertiary)] transition-transform duration-200 ${expandedIndices.has(idx) ? 'rotate-180' : ''}`} />
                          </div>
                        )}

                        <div className="flex items-center gap-1 shrink-0">
                          {isEditing ? (
                            <>
                              <button onClick={cancelEditing} className="px-2 py-1 text-xs font-medium text-[var(--rf-text-secondary)] bg-[var(--rf-bg)] hover:bg-gray-200 rounded-md transition">Cancel</button>
                              <button onClick={saveEditing} className="px-2 py-1 text-xs font-medium text-white bg-[var(--rf-success)] hover:bg-green-700 rounded-md transition flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Save</button>
                            </>
                          ) : (
                            <>
                              <button onClick={() => startEditing(idx)} className="px-2 py-1 text-[11px] font-medium text-[var(--rf-text-secondary)] hover:bg-[var(--rf-bg)] border border-transparent hover:border-[var(--rf-border)] rounded-md transition flex items-center gap-1"><Edit2 className="w-3 h-3" /> Edit</button>
                              <button onClick={() => setRefinePopupIdx(idx)} className="px-2 py-1 text-[11px] font-medium text-[var(--rf-text-secondary)] hover:bg-[var(--rf-brand-subtle)] hover:text-[var(--rf-brand)] border border-transparent hover:border-blue-200 rounded-md transition flex items-center gap-1"><Sparkles className="w-3 h-3" /> Refine</button>
                              <button onClick={() => toggleAccepted(idx)} className={`px-2 py-1 text-[11px] font-medium rounded-md transition border flex items-center gap-1 ${feature.isAccepted ? 'text-[var(--rf-success)] bg-[var(--rf-success-subtle)] border-green-300' : 'text-[var(--rf-text-secondary)] border-transparent hover:bg-[var(--rf-success-subtle)] hover:text-[var(--rf-success)] hover:border-green-300'}`}>
                                <Check className="w-3 h-3" /> {feature.isAccepted ? 'Accepted' : 'Accept'}
                              </button>
                              {feature.jiraIssueKey ? (
                                <div className="flex items-center gap-1">
                                  <button
                                    onClick={() => feature.jiraIssueUrl ? router.navigate(feature.jiraIssueUrl) : null}
                                    className="px-2 py-1 text-[11px] font-medium text-[var(--rf-brand)] bg-[var(--rf-brand-subtle)] border border-blue-200 rounded-md transition flex items-center gap-1 hover:bg-blue-100"
                                  >
                                    <Check className="w-3 h-3" /> {feature.jiraIssueKey}
                                  </button>
                                  <button
                                    onClick={() => {
                                      if (window.confirm(`Safety Warning: This feature has already been pushed to Jira as issue ${feature.jiraIssueKey}.\n\nAre you sure you want to push it again and create a duplicate issue?`)) {
                                        onPushFeature(idx);
                                      }
                                    }}
                                    title="Push a duplicate to Jira"
                                    className="px-1.5 py-1 text-[var(--rf-text-tertiary)] hover:bg-[var(--rf-bg)] border border-transparent hover:border-[var(--rf-border)] rounded-md transition"
                                  >
                                    <Upload className="w-3 h-3" />
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => onPushFeature(idx)}
                                  disabled={!feature.isAccepted}
                                  title={!feature.isAccepted ? "Accept feature first to push to Jira" : ""}
                                  className="px-2 py-1 text-[11px] font-medium text-white bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition flex items-center gap-1"
                                >
                                  <Upload className="w-3 h-3" /> Push to Jira
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>

                      {feature.pendingRemoval && (
                        <div className="mb-3 p-2.5 rounded-md bg-[var(--rf-danger-subtle)] border border-red-300 flex items-center justify-between">
                           <div className="flex items-center gap-1.5 text-[var(--rf-danger)] font-semibold text-xs">
                             <Trash2 className="w-3.5 h-3.5" /> Proposed for Removal
                           </div>
                           <div className="flex items-center gap-1.5">
                             <button onClick={() => setFeatures(prev => prev.map((f, i) => i === idx ? { ...f, pendingRemoval: false } : f))} className="px-2 py-1 text-[10px] font-medium text-[var(--rf-text-secondary)] bg-white border border-[var(--rf-border)] hover:bg-[var(--rf-bg)] rounded-md">Keep Instead</button>
                             <button onClick={() => setFeatures(prev => prev.filter((_, i) => i !== idx))} className="px-2 py-1 text-[10px] font-medium text-white bg-[var(--rf-danger)] hover:bg-red-700 rounded-md">Confirm Removal</button>
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
                        const arDiffRows = alignAcceptanceRequirements(
                          feature.acceptanceRequirements || [],
                          proposed.acceptanceRequirements || [],
                        );
                        return (
                          <div className="mb-3 p-3 rounded-md bg-[var(--rf-warning-subtle)] border border-amber-300">
                            <div className="flex items-center justify-between mb-2">
                              <h4 className="text-amber-800 font-semibold text-xs flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5" /> AI Suggested Refinements</h4>

                              <div className="flex items-center gap-2">
                                <div className="flex items-center bg-white p-0.5 rounded border border-amber-200">
                                  <button
                                    onClick={() => setDiffMode('redline')}
                                    className={`px-2 py-0.5 text-[9px] font-semibold rounded transition ${diffMode === 'redline' ? 'bg-[var(--rf-bg)] text-[var(--rf-text)]' : 'text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text-secondary)]'}`}
                                  >
                                    Redline
                                  </button>
                                  <button
                                    onClick={() => setDiffMode('blackline')}
                                    className={`px-2 py-0.5 text-[9px] font-semibold rounded transition ${diffMode === 'blackline' ? 'bg-[var(--rf-bg)] text-[var(--rf-text)]' : 'text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text-secondary)]'}`}
                                  >
                                    Blackline
                                  </button>
                                </div>

                                <div className="flex items-center gap-1.5">
                                  <button onClick={() => rejectRefinement(idx)} className="px-2 py-1 text-[10px] font-medium text-[var(--rf-text-secondary)] bg-white border border-[var(--rf-border)] hover:bg-[var(--rf-bg)] rounded-md">Reject</button>
                                  <button onClick={() => acceptRefinement(idx)} className="px-2 py-1 text-[10px] font-medium text-white bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] rounded-md flex items-center gap-1"><Check className="w-3 h-3" /> Accept</button>
                                </div>
                              </div>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                              <div className="bg-white p-3 rounded-md border border-[var(--rf-border)]">
                                <div className="text-[9px] font-semibold text-[var(--rf-text-tertiary)] uppercase tracking-wide mb-1">Original</div>
                                <h4 className="text-xs font-semibold text-[var(--rf-text)] mb-1">{origTitle}</h4>
                                <div className="text-[11px] text-[var(--rf-text-secondary)] mb-2 whitespace-pre-wrap leading-relaxed">{origDesc}</div>
                                <div className="space-y-1">
                                  {feature.acceptanceRequirements.map((ar, i) => (
                                    <div key={i} className="bg-[var(--rf-bg)] border border-[var(--rf-border-subtle)] p-1.5 rounded text-[10px] text-[var(--rf-text-secondary)]">
                                      {ar.given && <div><strong>Given</strong> {ar.given}</div>}
                                      {ar.when && <div><strong>When</strong> {ar.when}</div>}
                                      <div><strong>Then</strong> {ar.then}</div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                              <div className="bg-[var(--rf-brand-subtle)] p-3 rounded-md border border-blue-200">
                                <div className="text-[9px] font-semibold text-[var(--rf-brand)] uppercase tracking-wide mb-1">Proposed ({diffMode === 'redline' ? 'Diff' : 'Result'})</div>
                                <h4 className="text-xs font-semibold text-[var(--rf-text)] mb-1"><DiffText oldText={origTitle} newText={propTitle} mode={diffMode} /></h4>
                                <div className="text-[11px] text-[var(--rf-text-secondary)] mb-2 whitespace-pre-wrap leading-relaxed"><DiffText oldText={origDesc} newText={propDesc} mode={diffMode} /></div>
                                <div className="space-y-1.5">
                                  {arDiffRows.map((row, i) => {
                                    const ar = row.proposed;
                                    const oldAr = row.oldAr;
                                    const isNew = row.isNew;
                                    return (
                                      <div key={`${i}-${row.oldIndex ?? 'new'}`} className={`p-2 rounded text-[11px] text-[var(--rf-text)] border ${isNew ? 'bg-[var(--rf-success-subtle)] border-green-300' : 'bg-white border-blue-100'}`}>
                                        {isNew && <div className="text-[9px] font-semibold text-[var(--rf-success)] uppercase tracking-wide mb-1">New AR</div>}
                                        {ar.given && <div><strong className="text-[var(--rf-brand)]">Given</strong>{' '}<DiffText oldText={oldAr?.given || ''} newText={ar.given} fullHighlight={isNew} mode={diffMode} /></div>}
                                        {ar.when && <div><strong className="text-[var(--rf-brand)]">When</strong>{' '}<DiffText oldText={oldAr?.when || ''} newText={ar.when} fullHighlight={isNew} mode={diffMode} /></div>}
                                        <div><strong className="text-[var(--rf-brand)]">Then</strong>{' '}<DiffText oldText={oldAr?.then || ''} newText={ar.then} fullHighlight={isNew} mode={diffMode} /></div>
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
                        <div className={`mt-2 ${feature.pendingRefinement ? 'opacity-60 pointer-events-none' : ''}`}>
                          {isEditing ? (
                            <textarea
                              value={draft?.description || ''}
                              onChange={e => setEditDraft(d => d ? { ...d, description: e.target.value } : null)}
                              className="w-full text-[var(--rf-text-secondary)] text-sm bg-white border border-[var(--rf-border)] rounded-md px-3 py-2 min-h-[100px] mb-4 focus:ring-1 focus:ring-[var(--rf-brand)] outline-none resize-y"
                            />
                          ) : (
                            <div className="text-[var(--rf-text)] text-sm mb-4 whitespace-pre-wrap leading-relaxed border-l-2 border-[var(--rf-border)] pl-4">
                              {feature.markdown || feature.description}
                            </div>
                          )}

                          {/* Acceptance Criteria */}
                          {((isEditing && draft?.acceptanceRequirements) || (!isEditing && feature.acceptanceRequirements?.length > 0)) && (
                            <div className="mt-2 text-sm">
                              <div className="flex items-center justify-between mb-2 border-b border-[var(--rf-border-subtle)] pb-2">
                                <h4 className="text-[11px] font-semibold text-[var(--rf-text-tertiary)] uppercase tracking-wide">Acceptance Criteria</h4>
                                {isEditing && (
                                  <button onClick={addDraftAr} className="text-xs font-medium text-[var(--rf-brand)] bg-[var(--rf-brand-subtle)] hover:bg-blue-100 px-2 py-1 rounded-md transition flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Add AR</button>
                                )}
                              </div>
                              <div className="space-y-1.5">
                                {(isEditing ? draft!.acceptanceRequirements : feature.acceptanceRequirements).map((ar, i) => (
                                  <div key={i} className="bg-[var(--rf-bg)] rounded-md p-3 border border-[var(--rf-border-subtle)] relative group">
                                    {isEditing && (
                                      <button onClick={() => deleteDraftAr(i)} className="absolute top-2 right-2 p-1 text-[var(--rf-text-tertiary)] hover:text-[var(--rf-danger)] hover:bg-[var(--rf-danger-subtle)] rounded-md transition opacity-0 group-hover:opacity-100"><Trash2 className="w-3.5 h-3.5" /></button>
                                    )}
                                    {isEditing ? (
                                      <div className="space-y-2 pr-8">
                                        {(['given', 'when', 'then'] as const).map(field => (
                                          <div key={field} className="flex items-start gap-2">
                                            <strong className="text-[var(--rf-text-secondary)] w-12 pt-1.5 text-xs uppercase tracking-wide">{field}</strong>
                                            {field === 'then'
                                              ? <textarea value={ar[field]} onChange={e => updateDraftAr(i, field, e.target.value)} rows={2} className="flex-1 bg-white border border-[var(--rf-border)] rounded-md px-2 py-1 text-sm outline-none focus:border-[var(--rf-brand)] resize-none" />
                                              : <input value={ar[field]} onChange={e => updateDraftAr(i, field, e.target.value)} className="flex-1 bg-white border border-[var(--rf-border)] rounded-md px-2 py-1 text-sm outline-none focus:border-[var(--rf-brand)]" />
                                            }
                                          </div>
                                        ))}
                                      </div>
                                    ) : (
                                      <div className="space-y-1 text-sm">
                                        {ar.given?.trim() && (
                                          <div className="flex gap-3">
                                            <div className="w-10 shrink-0 text-[10px] font-semibold text-[var(--rf-text-tertiary)] uppercase pt-0.5">Given</div>
                                            <div className="text-[var(--rf-text)] leading-normal">{ar.given}</div>
                                          </div>
                                        )}
                                        {ar.when?.trim() && (
                                          <div className="flex gap-3">
                                            <div className="w-10 shrink-0 text-[10px] font-semibold text-[var(--rf-text-tertiary)] uppercase pt-0.5">When</div>
                                            <div className="text-[var(--rf-text)] leading-normal">{ar.when}</div>
                                          </div>
                                        )}
                                        <div className="flex gap-3">
                                          <div className="w-10 shrink-0 text-[10px] font-semibold text-[var(--rf-text-tertiary)] uppercase pt-0.5">Then</div>
                                          <div className="text-[var(--rf-text)] leading-normal whitespace-pre-wrap">{ar.then}</div>
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
          sessionId={sessionId}
          onClose={() => setRefinePopupIdx(null)}
          onResult={(refined, tokenUsage) => {
            setFeatures(prev => {
              const n = [...prev];
              n[refinePopupIdx] = { ...n[refinePopupIdx], pendingRefinement: refined };
              return n;
            });
            if (tokenUsage) {
              setLastAiTokenUsage({ label: 'Single refine', ...tokenUsage });
              onWorkflowTokenUsage?.(tokenUsage);
            }
            setRefinePopupIdx(null);
          }}
        />
      )}
    </main>
  );
}
