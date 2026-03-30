import React, { useState } from 'react';
import { Send, Sparkles, Edit2, Check, X, Plus, Trash2, Menu, Upload, ChevronDown, Coins } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
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
      <motion.div
        className="absolute inset-0 bg-black/20"
        onClick={!loading ? onClose : undefined}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
      />
      <motion.div
        className="relative bg-white w-full max-w-lg rounded-lg shadow-[0_8px_24px_rgba(9,30,66,0.1),0_2px_6px_rgba(9,30,66,0.04)] flex flex-col overflow-hidden border border-[#DFE1E6]"
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="px-5 py-3.5 border-b border-[#DFE1E6] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#0052CC]" />
            <span className="font-semibold text-[#172B4D] text-sm">AI Refine</span>
            <span className="text-[#8993A4] text-xs ml-1 line-clamp-1 max-w-[200px]">\u2014 {feature.title || feature.summary}</span>
          </div>
          {!loading && (
            <button onClick={onClose} className="p-1.5 hover:bg-[#F4F5F7] text-[#8993A4] rounded-md transition"><X className="w-4 h-4" /></button>
          )}
        </div>

        <div className="px-5 py-5">
          {loading ? (
            <div className="flex flex-col items-center py-8 gap-4">
              <div className="w-10 h-10 rounded-lg bg-[#DEEBFF] flex items-center justify-center">
                <div className="w-6 h-6 border-[2.5px] border-blue-200 border-t-[#0052CC] rounded-full spin-slow" />
              </div>
              <div className="text-center">
                <p className="font-semibold text-[#172B4D] text-sm">Refining feature\u2026</p>
                <p className="text-xs text-[#8993A4] mt-1">The AI is working on your request</p>
              </div>
              <div className="dot-bounce text-[#0052CC]"><span /><span /><span /></div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-[#626F86]">Describe what you want changed \u2014 e.g. "Add an AR for invalid password", "Tighten the scope to mobile only"</p>
              <textarea
                rows={4}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSend(); }}
                placeholder="Your refinement instructions\u2026"
                className="w-full bg-[#F4F5F7] border border-[#DFE1E6] rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#0052CC] focus:border-[#0052CC] transition resize-none"
                autoFocus
              />
              {error && <p className="text-xs text-[#DE350B]">{error}</p>}
            </div>
          )}
        </div>

        {!loading && (
          <div className="px-5 py-3.5 border-t border-[#DFE1E6] flex items-center justify-between gap-3 bg-[#F4F5F7]">
            <span className="text-[11px] text-[#8993A4]">\u2318 + Enter to send</span>
            <div className="flex gap-2">
              <motion.button onClick={onClose} className="px-3 py-1.5 text-xs font-medium text-[#626F86] border border-[#DFE1E6] rounded-md hover:bg-white transition bg-white" whileTap={{ scale: 0.97 }}>Cancel</motion.button>
              <motion.button
                onClick={handleSend}
                disabled={!input.trim()}
                className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-[#0052CC] hover:bg-[#0747A6] disabled:opacity-40 rounded-md transition"
                whileTap={{ scale: 0.98 }}
              >
                <Send className="w-3.5 h-3.5" /> Refine
              </motion.button>
            </div>
          </div>
        )}
      </motion.div>
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
    <motion.div
      className="w-full max-w-4xl mx-auto px-6 py-8 space-y-5 h-full flex flex-col pt-12"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
    >
      <motion.div
        className="flex flex-col items-center gap-3 mb-4"
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="w-10 h-10 rounded-lg bg-[#DEEBFF] flex items-center justify-center">
          <Sparkles className="w-5 h-5 text-[#0052CC]" />
        </div>
        <div className="text-center">
          <h2 className="text-lg font-semibold text-[#172B4D]">Generating features</h2>
          <p className="text-sm text-[#626F86] mt-0.5">{progress || 'Processing your request\u2026'}</p>
        </div>
        <div className="dot-bounce text-[#0052CC] mt-1"><span /><span /><span /></div>
      </motion.div>

      <div className="space-y-4">
        {[1, 2, 3].map(i => (
          <motion.div
            key={i}
            className="overflow-hidden rounded-xl border border-[var(--rf-border)] bg-white"
            style={{ boxShadow: 'var(--rf-shadow-sm)' }}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.12, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="flex">
              <div className="w-1.5 shrink-0 bg-[#DFE1E6]" />
              <div className="flex-1 p-5 space-y-3">
                <div className="shimmer h-4 w-2/5 rounded" />
                <div className="shimmer h-3 w-full rounded" />
                <div className="shimmer h-3 w-4/5 rounded" />
                <div className="space-y-2 pt-2">
                  {[1,2,3].map(j => <div key={j} className="shimmer h-2.5 rounded" style={{ width: `${60 + j * 10}%` }} />)}
                </div>
              </div>
            </div>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );

  return (
    <main className="flex-1 flex flex-col h-full relative overflow-hidden bg-transparent">
      {/* Header — aligned to sidebar header height and padding */}
      <motion.header
        className="shrink-0 h-[88px] bg-white px-6 z-10 sticky top-0 border-b border-[var(--rf-border)] flex items-center"
        style={{ boxShadow: 'var(--rf-header-shadow)' }}
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            {!sidebarOpen && (
              <motion.button
                onClick={() => setSidebarOpen(true)}
                className="p-1.5 -ml-1 rounded-lg hover:bg-[#F4F5F7] text-[#626F86] transition"
                title="Open Sidebar"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
              >
                <Menu className="w-4 h-4" />
              </motion.button>
            )}
            <div className="min-w-0 flex flex-wrap items-center gap-2.5">
              <h2 className="text-base font-bold text-[#172B4D] tracking-tight">Feature Canvas</h2>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--rf-brand-muted)] px-2.5 py-0.5 text-[10px] font-semibold text-[#626F86] border border-[rgba(0,82,204,0.08)]">
                <span className="text-[#8993A4]">Scope</span>
                <span className="text-[#172B4D]">
                  {projectKey === '*' ? 'Standalone workspace' : projectKey}
                </span>
              </span>
            </div>
          </div>
          <div className="relative">
            <motion.button
              type="button"
              onClick={() => setShowTokenDetails(prev => !prev)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--rf-surface-soft)] hover:bg-[#eef2f7] px-2.5 py-1.5 text-[11px] font-semibold text-[#626F86] transition-colors border border-[var(--rf-border-subtle)]"
              title="Workflow token usage"
              whileTap={{ scale: 0.97 }}
            >
              <Coins className="w-3.5 h-3.5 text-[#8993A4]" />
              Tokens
            </motion.button>
            <AnimatePresence>
              {showTokenDetails && (
                <motion.div
                  className="absolute right-0 top-full mt-2 w-[250px] rounded-lg border border-[var(--rf-border)] bg-white p-3 shadow-[var(--rf-shadow-md)] z-40"
                  initial={{ opacity: 0, y: -4, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.98 }}
                  transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                >
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-[#8993A4]">Workflow tokens</div>
                  <div className="mt-1 text-base font-semibold text-[#172B4D]">
                    {(workflowTokenUsage?.total ?? 0).toLocaleString()}
                  </div>
                  <div className="mt-1 text-[11px] text-[#626F86]">
                    {(workflowTokenUsage?.input ?? 0).toLocaleString()} in / {(workflowTokenUsage?.output ?? 0).toLocaleString()} out
                  </div>
                  <div className="mt-2 text-[10px] text-[#8993A4]">
                    Includes clarify, generation, and refinements.
                  </div>
                  {lastAiTokenUsage && (
                    <div className="mt-2 border-t border-[#EBECF0] pt-2 text-[10px] text-[#8993A4]">
                      Last action: {lastAiTokenUsage.label} ({lastAiTokenUsage.total.toLocaleString()} tokens)
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {hasFeatures && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2.5">
            <div className="inline-flex items-center gap-2.5 flex-wrap">
              <span className="inline-flex items-center rounded-full bg-[#172B4D] text-white px-3 py-1 text-[11px] font-semibold">
                  {features.length} Features
                  <span className="mx-1.5 opacity-30">·</span>
                  {totalArCount} ARs
              </span>
              <span className="text-[11px] text-[#8993A4] font-medium">
                {features.filter(f => f.isAccepted).length} accepted
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {features.some(f => f.pendingRefinement) && (
                <>
                  <motion.button onClick={discardAllProposed} className="px-2.5 py-1.5 text-[11px] font-semibold text-[#626F86] bg-[rgba(255,255,255,0.94)] border border-[var(--rf-border)] rounded-md hover:text-[#DE350B] hover:border-red-300 transition" whileTap={{ scale: 0.97 }}>Discard All</motion.button>
                  <motion.button onClick={acceptAllProposed} className="px-2.5 py-1.5 bg-[#00875A] hover:bg-green-700 text-white text-[11px] font-semibold rounded-md transition" whileTap={{ scale: 0.97 }}>Accept All</motion.button>
                </>
              )}

              <div className="relative">
                <motion.button
                  onClick={() => setShowBulkRefine(!showBulkRefine)}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-[11px] font-semibold transition ${showBulkRefine ? 'bg-[#172B4D] text-white border-[#172B4D]' : 'bg-[rgba(255,255,255,0.94)] text-[#626F86] border-[var(--rf-border)] hover:border-[#0052CC] hover:text-[#0052CC]'}`}
                  whileTap={{ scale: 0.97 }}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Refine All
                </motion.button>

                <AnimatePresence>
                  {showBulkRefine && (
                    <motion.div
                      className="absolute right-0 top-full mt-2 w-[380px] bg-[rgba(255,255,255,0.97)] backdrop-blur-md rounded-lg border border-[var(--rf-border)] p-4 z-50 shadow-[var(--rf-shadow-md)]"
                      initial={{ opacity: 0, y: -4, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -4, scale: 0.98 }}
                      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                    >
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="text-[11px] font-semibold text-[#626F86] uppercase tracking-wide flex items-center gap-1.5">
                           <Sparkles className="w-3.5 h-3.5 text-[#0052CC]" /> Bulk Refine
                        </h4>
                        <button onClick={() => setShowBulkRefine(false)} className="p-1 hover:bg-[#F4F5F7] rounded-md transition text-[#8993A4]"><X className="w-4 h-4" /></button>
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
                        className="w-full bg-[#F4F5F7] border border-[#DFE1E6] rounded-md p-3 text-sm min-h-[100px] outline-none focus:ring-1 focus:ring-[#0052CC] focus:border-[#0052CC] transition resize-none mb-3"
                      />
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[10px] text-[#8993A4]">\u2318 + Enter to apply</span>
                        <motion.button
                          onClick={handleBulkRefine}
                          disabled={!bulkInput.trim() || isBulkRefining}
                          className="px-4 py-1.5 bg-[#0052CC] hover:bg-[#0747A6] text-white text-xs font-semibold rounded-md transition disabled:opacity-50 flex items-center gap-1.5"
                          whileTap={{ scale: 0.98 }}
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
                        </motion.button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>
        )}
      </motion.header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto w-full flex flex-col items-center relative custom-scrollbar">
        {isGenerating ? (
          <GeneratingSkeleton />
        ) : !hasFeatures ? (
          <motion.div
            className="flex-1 flex flex-col items-center justify-center text-center max-w-md mx-auto p-6"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="levitate w-14 h-14 rounded-xl flex items-center justify-center mb-5 shadow-[var(--rf-shadow-sm)] bg-white border border-[rgba(203,220,245,0.95)]">
              <Sparkles className="w-6 h-6 text-[#0052CC]" />
            </div>
            <h2 className="text-xl font-semibold text-[#172B4D] mb-2">Ready to generate</h2>
            <p className="text-[#626F86] text-sm leading-relaxed">Describe your requirement in the sidebar, answer the clarifying questions, and your features will appear here.</p>
          </motion.div>
        ) : (
          <motion.div
            className="w-full max-w-4xl mx-auto px-6 py-6 space-y-3 flex-1"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          >
            {generationContext && (
              <motion.div
                className="rf-tint-panel rounded-xl p-4"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="flex flex-wrap items-center gap-4 text-xs">
                  <div className="font-semibold text-[#172B4D]">
                    Context used: {generationContext.goldExamplesCount} golden example{generationContext.goldExamplesCount !== 1 ? 's' : ''}
                  </div>
                  <div className="text-[#626F86]">
                    Project: {generationContext.projectKey === '*' ? 'Standalone workspace' : generationContext.projectKey}
                  </div>
                  <div className="text-[#626F86]">
                    Domain guidance: {generationContext.domainContextApplied ? 'Included' : 'Not configured'}
                  </div>
                  <div className="text-[#626F86]">
                    Attachment: {generationContext.attachmentIncluded ? 'Included' : 'None'}
                  </div>
                  {generationContext.domainRolesUsed?.length > 0 && (
                    <div className="text-[#626F86]">
                      Roles: {generationContext.domainRolesUsed.join(', ')}
                    </div>
                  )}
                </div>
                {generationContext.referencedGoldExamples?.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {generationContext.referencedGoldExamples.map((example, i) => (
                      <span
                        key={`${example.source}-${example.key}-${i}`}
                        className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium bg-[#DEEBFF] text-[#0052CC] border border-blue-200"
                        title={example.summary}
                      >
                        {example.source}: {example.key}
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-3 pt-3 border-t border-[#EBECF0]">
                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    <div className="font-semibold text-[#172B4D]">
                      Work instructions used: {generationContext.wiDocsCount ?? 0}
                    </div>
                    {generationContext.referencedWiDocs?.length ? (
                      <div className="text-[#626F86]">
                        {generationContext.referencedWiDocs.map(doc => doc.filename).join(', ')}
                      </div>
                    ) : (
                      <div className="text-[#8993A4]">No project docs were matched for this run.</div>
                    )}
                  </div>
                </div>
                <div className="mt-3 pt-3 border-t border-[#EBECF0]">
                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    <div className="font-semibold text-[#172B4D]">
                      Similar backlog stories used: {generationContext.similarStoriesCount ?? 0}
                    </div>
                    {generationContext.referencedSimilarStories?.length ? (
                      <div className="text-[#626F86]">
                        {generationContext.referencedSimilarStories.map(story => story.key).join(', ')}
                      </div>
                    ) : (
                      <div className="text-[#8993A4]">No similar backlog stories were used for this run.</div>
                    )}
                  </div>
                </div>
                {generationContext.tokenUsage && (
                  <div className="mt-3 pt-3 border-t border-[#EBECF0] text-xs text-[#626F86]">
                    Tokens used for generation: {generationContext.tokenUsage.total.toLocaleString()} ({generationContext.tokenUsage.input.toLocaleString()} in / {generationContext.tokenUsage.output.toLocaleString()} out)
                  </div>
                )}
              </motion.div>
            )}

            {features.map((feature, idx) => {
              const isEditing = editingIdx === idx;
              const draft = editDraft;

              return (
                <motion.div
                  key={feature.id || idx}
                  className={`overflow-hidden rounded-xl border border-[var(--rf-border)] bg-white ${feature.pendingRemoval ? 'opacity-80' : ''}`}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.06, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                  style={{ boxShadow: feature.isAccepted ? '0 0 0 1px rgba(0,135,90,0.25), 0 2px 6px rgba(15,23,42,0.05)' : feature.pendingRemoval ? '0 0 0 1px rgba(222,53,11,0.25), 0 2px 6px rgba(15,23,42,0.05)' : 'var(--rf-shadow-sm)' }}
                  whileHover={{ boxShadow: feature.isAccepted ? '0 0 0 1px rgba(0,135,90,0.3), 0 4px 10px rgba(15,23,42,0.06)' : 'var(--rf-shadow-md)', y: -1 }}
                >
                  {/* Left accent bar */}
                  <div className="flex">
                    <div className={`w-1.5 shrink-0 ${feature.pendingRemoval ? 'bg-[#DE350B]' : feature.isAccepted ? 'bg-[#00875A]' : 'bg-[#0052CC]'}`} />

                    <div className="flex-1 p-5">
                      {/* Title row */}
                      <div className="flex items-start justify-between gap-4 mb-2">
                        {isEditing ? (
                          <input
                            type="text"
                            value={draft?.title || draft?.summary || ''}
                            onChange={e => setEditDraft(d => d ? { ...d, summary: e.target.value, title: e.target.value } : null)}
                            className="flex-1 text-sm font-semibold text-[#172B4D] bg-white border border-[#DFE1E6] rounded-md px-3 py-1.5 focus:ring-1 focus:ring-[#0052CC] outline-none"
                          />
                        ) : (
                          <div className="flex-1 flex items-center gap-2 cursor-pointer group/title" onClick={() => toggleExpand(idx)}>
                            <h3 className="text-sm font-semibold text-[#172B4D]">
                              {feature.title || feature.summary || 'Untitled Feature'}
                            </h3>
                            <span className="inline-flex items-center rounded px-1.5 py-0.5 bg-[#F4F5F7] text-[#8993A4] text-[10px] font-medium border border-[#EBECF0]">
                              {feature.acceptanceRequirements?.length || 0} ARs
                            </span>
                            <ChevronDown className={`w-3.5 h-3.5 text-[#8993A4] transition-transform duration-200 ${expandedIndices.has(idx) ? 'rotate-180' : ''}`} />
                          </div>
                        )}

                        <div className="flex items-center gap-1 shrink-0">
                          {isEditing ? (
                            <>
                              <motion.button onClick={cancelEditing} className="px-2 py-1 text-xs font-medium text-[#626F86] bg-[#F4F5F7] hover:bg-gray-200 rounded-md transition" whileTap={{ scale: 0.97 }}>Cancel</motion.button>
                              <motion.button onClick={saveEditing} className="px-2 py-1 text-xs font-medium text-white bg-[#00875A] hover:bg-green-700 rounded-md transition flex items-center gap-1" whileTap={{ scale: 0.97 }}><Check className="w-3.5 h-3.5" /> Save</motion.button>
                            </>
                          ) : (
                            <>
                              <motion.button onClick={() => startEditing(idx)} className="px-2 py-1 text-[11px] font-medium text-[#626F86] hover:bg-[#F4F5F7] border border-transparent hover:border-[#DFE1E6] rounded-md transition flex items-center gap-1" whileTap={{ scale: 0.97 }}><Edit2 className="w-3 h-3" /> Edit</motion.button>
                              <motion.button onClick={() => setRefinePopupIdx(idx)} className="px-2 py-1 text-[11px] font-medium text-[#626F86] hover:bg-[#DEEBFF] hover:text-[#0052CC] border border-transparent hover:border-blue-200 rounded-md transition flex items-center gap-1" whileTap={{ scale: 0.97 }}><Sparkles className="w-3 h-3" /> Refine</motion.button>
                              <motion.button onClick={() => toggleAccepted(idx)} className={`px-2 py-1 text-[11px] font-medium rounded-md transition border flex items-center gap-1 ${feature.isAccepted ? 'text-[#00875A] bg-[#E3FCEF] border-green-300' : 'text-[#626F86] border-transparent hover:bg-[#E3FCEF] hover:text-[#00875A] hover:border-green-300'}`} whileTap={{ scale: 0.97 }}>
                                <Check className="w-3 h-3" /> {feature.isAccepted ? 'Accepted' : 'Accept'}
                              </motion.button>
                              {feature.jiraIssueKey ? (
                                <div className="flex items-center gap-1">
                                  <motion.button
                                    onClick={() => feature.jiraIssueUrl ? router.navigate(feature.jiraIssueUrl) : null}
                                    className="px-2 py-1 text-[11px] font-medium text-[#0052CC] bg-[#DEEBFF] border border-blue-200 rounded-md transition flex items-center gap-1 hover:bg-blue-100"
                                    whileTap={{ scale: 0.97 }}
                                  >
                                    <Check className="w-3 h-3" /> {feature.jiraIssueKey}
                                  </motion.button>
                                  <motion.button
                                    onClick={() => {
                                      if (window.confirm(`Safety Warning: This feature has already been pushed to Jira as issue ${feature.jiraIssueKey}.\n\nAre you sure you want to push it again and create a duplicate issue?`)) {
                                        onPushFeature(idx);
                                      }
                                    }}
                                    title="Push a duplicate to Jira"
                                    className="px-1.5 py-1 text-[#8993A4] hover:bg-[#F4F5F7] border border-transparent hover:border-[#DFE1E6] rounded-md transition"
                                    whileTap={{ scale: 0.97 }}
                                  >
                                    <Upload className="w-3 h-3" />
                                  </motion.button>
                                </div>
                              ) : (
                                <motion.button
                                  onClick={() => onPushFeature(idx)}
                                  disabled={!feature.isAccepted}
                                  title={!feature.isAccepted ? "Accept feature first to push to Jira" : ""}
                                  className="px-2 py-1 text-[11px] font-medium text-white bg-[#0052CC] hover:bg-[#0747A6] disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition flex items-center gap-1"
                                  whileTap={{ scale: 0.97 }}
                                >
                                  <Upload className="w-3 h-3" /> Push to Jira
                                </motion.button>
                              )}
                            </>
                          )}
                        </div>
                      </div>

                      {feature.pendingRemoval && (
                        <div className="mb-3 p-2.5 rounded-md bg-[#FFEBE6] border border-red-300 flex items-center justify-between">
                           <div className="flex items-center gap-1.5 text-[#DE350B] font-semibold text-xs">
                             <Trash2 className="w-3.5 h-3.5" /> Proposed for Removal
                           </div>
                           <div className="flex items-center gap-1.5">
                             <motion.button onClick={() => setFeatures(prev => prev.map((f, i) => i === idx ? { ...f, pendingRemoval: false } : f))} className="px-2 py-1 text-[10px] font-medium text-[#626F86] bg-white border border-[#DFE1E6] hover:bg-[#F4F5F7] rounded-md" whileTap={{ scale: 0.97 }}>Keep Instead</motion.button>
                             <motion.button onClick={() => setFeatures(prev => prev.filter((_, i) => i !== idx))} className="px-2 py-1 text-[10px] font-medium text-white bg-[#DE350B] hover:bg-red-700 rounded-md" whileTap={{ scale: 0.97 }}>Confirm Removal</motion.button>
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
                          <div className="mb-3 p-3 rounded-lg bg-[#FFFAE6] border border-amber-300">
                            <div className="flex items-center justify-between mb-2">
                              <h4 className="text-amber-800 font-semibold text-xs flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5" /> AI Suggested Refinements</h4>

                              <div className="flex items-center gap-2">
                                <div className="flex items-center bg-white p-0.5 rounded border border-amber-200">
                                  <button
                                    onClick={() => setDiffMode('redline')}
                                    className={`px-2 py-0.5 text-[9px] font-semibold rounded transition ${diffMode === 'redline' ? 'bg-[#F4F5F7] text-[#172B4D]' : 'text-[#8993A4] hover:text-[#626F86]'}`}
                                  >
                                    Redline
                                  </button>
                                  <button
                                    onClick={() => setDiffMode('blackline')}
                                    className={`px-2 py-0.5 text-[9px] font-semibold rounded transition ${diffMode === 'blackline' ? 'bg-[#F4F5F7] text-[#172B4D]' : 'text-[#8993A4] hover:text-[#626F86]'}`}
                                  >
                                    Blackline
                                  </button>
                                </div>

                                <div className="flex items-center gap-1.5">
                                  <motion.button onClick={() => rejectRefinement(idx)} className="px-2 py-1 text-[10px] font-medium text-[#626F86] bg-white border border-[#DFE1E6] hover:bg-[#F4F5F7] rounded-md" whileTap={{ scale: 0.97 }}>Reject</motion.button>
                                  <motion.button onClick={() => acceptRefinement(idx)} className="px-2 py-1 text-[10px] font-medium text-white bg-[#0052CC] hover:bg-[#0747A6] rounded-md flex items-center gap-1" whileTap={{ scale: 0.97 }}><Check className="w-3 h-3" /> Accept</motion.button>
                                </div>
                              </div>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                              <div className="bg-white p-3 rounded-lg border border-[#DFE1E6]">
                                <div className="text-[9px] font-semibold text-[#8993A4] uppercase tracking-wide mb-1">Original</div>
                                <h4 className="text-xs font-semibold text-[#172B4D] mb-1">{origTitle}</h4>
                                <div className="text-[11px] text-[#626F86] mb-2 whitespace-pre-wrap leading-relaxed">{origDesc}</div>
                                <div className="space-y-1">
                                  {feature.acceptanceRequirements.map((ar, i) => (
                                    <div key={i} className="bg-[#F4F5F7] border border-[#EBECF0] p-1.5 rounded text-[10px] text-[#626F86]">
                                      {ar.given && <div><strong>Given</strong> {ar.given}</div>}
                                      {ar.when && <div><strong>When</strong> {ar.when}</div>}
                                      <div><strong>Then</strong> {ar.then}</div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                              <div className="bg-[#DEEBFF] p-3 rounded-lg border border-blue-200">
                                <div className="text-[9px] font-semibold text-[#0052CC] uppercase tracking-wide mb-1">Proposed ({diffMode === 'redline' ? 'Diff' : 'Result'})</div>
                                <h4 className="text-xs font-semibold text-[#172B4D] mb-1"><DiffText oldText={origTitle} newText={propTitle} mode={diffMode} /></h4>
                                <div className="text-[11px] text-[#626F86] mb-2 whitespace-pre-wrap leading-relaxed"><DiffText oldText={origDesc} newText={propDesc} mode={diffMode} /></div>
                                <div className="space-y-1.5">
                                  {arDiffRows.map((row, i) => {
                                    const ar = row.proposed;
                                    const oldAr = row.oldAr;
                                    const isNew = row.isNew;
                                    return (
                                      <div key={`${i}-${row.oldIndex ?? 'new'}`} className={`p-2 rounded text-[11px] text-[#172B4D] border ${isNew ? 'bg-[#E3FCEF] border-green-300' : 'bg-white border-blue-100'}`}>
                                        {isNew && <div className="text-[9px] font-semibold text-[#00875A] uppercase tracking-wide mb-1">New AR</div>}
                                        {ar.given && <div><strong className="text-[#0052CC]">Given</strong>{' '}<DiffText oldText={oldAr?.given || ''} newText={ar.given} fullHighlight={isNew} mode={diffMode} /></div>}
                                        {ar.when && <div><strong className="text-[#0052CC]">When</strong>{' '}<DiffText oldText={oldAr?.when || ''} newText={ar.when} fullHighlight={isNew} mode={diffMode} /></div>}
                                        <div><strong className="text-[#0052CC]">Then</strong>{' '}<DiffText oldText={oldAr?.then || ''} newText={ar.then} fullHighlight={isNew} mode={diffMode} /></div>
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
                              className="w-full text-[#626F86] text-sm bg-white border border-[#DFE1E6] rounded-md px-3 py-2 min-h-[100px] mb-4 focus:ring-1 focus:ring-[#0052CC] outline-none resize-y"
                            />
                          ) : (
                            <div className="text-[#172B4D] text-sm mb-4 whitespace-pre-wrap leading-relaxed border-l-2 border-[#DFE1E6] pl-4">
                              {feature.markdown || feature.description}
                            </div>
                          )}

                          {/* Acceptance Criteria */}
                          {((isEditing && draft?.acceptanceRequirements) || (!isEditing && feature.acceptanceRequirements?.length > 0)) && (
                            <div className="mt-2 text-sm">
                              <div className="flex items-center justify-between mb-2 border-b border-[#EBECF0] pb-2">
                                <h4 className="text-[11px] font-semibold text-[#8993A4] uppercase tracking-wide">Acceptance Criteria</h4>
                                {isEditing && (
                                  <motion.button onClick={addDraftAr} className="text-xs font-medium text-[#0052CC] bg-[#DEEBFF] hover:bg-blue-100 px-2 py-1 rounded-md transition flex items-center gap-1" whileTap={{ scale: 0.97 }}><Plus className="w-3.5 h-3.5" /> Add AR</motion.button>
                                )}
                              </div>
                              <div className="space-y-1.5">
                                {(isEditing ? draft!.acceptanceRequirements : feature.acceptanceRequirements).map((ar, i) => (
                                  <div key={i} className="bg-[#F4F5F7] rounded-md p-3 border border-[#EBECF0] relative group">
                                    {isEditing && (
                                      <button onClick={() => deleteDraftAr(i)} className="absolute top-2 right-2 p-1 text-[#8993A4] hover:text-[#DE350B] hover:bg-[#FFEBE6] rounded-md transition opacity-0 group-hover:opacity-100"><Trash2 className="w-3.5 h-3.5" /></button>
                                    )}
                                    {isEditing ? (
                                      <div className="space-y-2 pr-8">
                                        {(['given', 'when', 'then'] as const).map(field => (
                                          <div key={field} className="flex items-start gap-2">
                                            <strong className="text-[#626F86] w-12 pt-1.5 text-xs uppercase tracking-wide">{field}</strong>
                                            {field === 'then'
                                              ? <textarea value={ar[field]} onChange={e => updateDraftAr(i, field, e.target.value)} rows={2} className="flex-1 bg-white border border-[#DFE1E6] rounded-md px-2 py-1 text-sm outline-none focus:border-[#0052CC] resize-none" />
                                              : <input value={ar[field]} onChange={e => updateDraftAr(i, field, e.target.value)} className="flex-1 bg-white border border-[#DFE1E6] rounded-md px-2 py-1 text-sm outline-none focus:border-[#0052CC]" />
                                            }
                                          </div>
                                        ))}
                                      </div>
                                    ) : (
                                      <div className="space-y-1 text-sm">
                                        {ar.given?.trim() && (
                                          <div className="flex gap-3">
                                            <div className="w-10 shrink-0 text-[10px] font-semibold text-[#8993A4] uppercase pt-0.5">Given</div>
                                            <div className="text-[#172B4D] leading-normal">{ar.given}</div>
                                          </div>
                                        )}
                                        {ar.when?.trim() && (
                                          <div className="flex gap-3">
                                            <div className="w-10 shrink-0 text-[10px] font-semibold text-[#8993A4] uppercase pt-0.5">When</div>
                                            <div className="text-[#172B4D] leading-normal">{ar.when}</div>
                                          </div>
                                        )}
                                        <div className="flex gap-3">
                                          <div className="w-10 shrink-0 text-[10px] font-semibold text-[#8993A4] uppercase pt-0.5">Then</div>
                                          <div className="text-[#172B4D] leading-normal whitespace-pre-wrap">{ar.then}</div>
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
                </motion.div>
              );
            })}
          </motion.div>
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
