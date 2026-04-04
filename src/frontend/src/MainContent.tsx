import React, { useEffect, useRef, useState } from 'react';
import { Send, Sparkles, Edit2, Check, X, Plus, Trash2, Menu, Upload, ChevronDown, Download, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from './hooks/useForge';
import { router } from '@forge/bridge';

// ─── Word-level diff utility ──────────────────────────────────────────────────
type DiffToken = { text: string; type: 'same' | 'added' | 'removed' };
type AcceptanceRequirement = { given: string; when: string; then: string };
type ArDiffRow =
  | { type: 'matched'; proposed: AcceptanceRequirement; oldAr: AcceptanceRequirement; oldIndex: number; newIndex: number }
  | { type: 'added'; proposed: AcceptanceRequirement; newIndex: number }
  | { type: 'removed'; oldAr: AcceptanceRequirement; oldIndex: number };

function tokenizeDiffText(text: string): string[] {
  return (text || '').match(/\s+|[^\s]+/g) ?? [];
}

function wordDiff(oldText: string, newText: string): DiffToken[] {
  const oldWords = tokenizeDiffText(oldText);
  const newWords = tokenizeDiffText(newText);
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
  if (fullHighlight) return <span className="bg-[var(--rf-success-subtle)] text-[var(--rf-success)] rounded px-0.5">{newText}</span>;
  const tokens = wordDiff(oldText, newText);
  return (
    <span>
      {tokens.map((tok, i) => {
        if (tok.type === 'same') return <span key={i}>{tok.text}</span>;
        if (tok.type === 'added') return <mark key={i} className="bg-[var(--rf-brand-muted)] text-[var(--rf-brand-hover)] rounded px-0.5 not-italic">{tok.text}</mark>;
        return <del key={i} className="text-[var(--rf-text-tertiary)] line-through bg-[var(--rf-danger-subtle)] rounded px-0.5">{tok.text}</del>;
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
  const wholeScore = jaccard(tokenSet(leftText), tokenSet(rightText));
  const givenScore = jaccard(tokenSet(left.given), tokenSet(right.given));
  const whenScore = jaccard(tokenSet(left.when), tokenSet(right.when));
  const thenScore = jaccard(tokenSet(left.then), tokenSet(right.then));
  return Math.max(wholeScore, ((givenScore + whenScore + thenScore) / 3) * 0.8 + wholeScore * 0.2);
}

function alignAcceptanceRequirementsDetailed(
  original: AcceptanceRequirement[],
  proposed: AcceptanceRequirement[],
): ArDiffRow[] {
  const rows: ArDiffRow[] = [];
  const m = original.length;
  const n = proposed.length;
  const gapCost = 0.55;
  const matchThreshold = 0.2;
  const lowSimilarityPenalty = 1.35;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array.from({ length: n + 1 }, () => Number.POSITIVE_INFINITY));

  dp[m][n] = 0;
  for (let i = m; i >= 0; i -= 1) {
    for (let j = n; j >= 0; j -= 1) {
      if (i < m) dp[i][j] = Math.min(dp[i][j], gapCost + dp[i + 1][j]);
      if (j < n) dp[i][j] = Math.min(dp[i][j], gapCost + dp[i][j + 1]);
      if (i < m && j < n) {
        const similarity = arSimilarity(original[i], proposed[j]);
        const matchCost = similarity >= matchThreshold ? (1 - similarity) * 0.9 : lowSimilarityPenalty;
        dp[i][j] = Math.min(dp[i][j], matchCost + dp[i + 1][j + 1]);
      }
    }
  }

  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    const removeCost = i < m ? gapCost + dp[i + 1][j] : Number.POSITIVE_INFINITY;
    const addCost = j < n ? gapCost + dp[i][j + 1] : Number.POSITIVE_INFINITY;
    const similarity = i < m && j < n ? arSimilarity(original[i], proposed[j]) : 0;
    const matchCost = i < m && j < n
      ? (similarity >= matchThreshold ? (1 - similarity) * 0.9 : lowSimilarityPenalty) + dp[i + 1][j + 1]
      : Number.POSITIVE_INFINITY;

    if (i < m && j < n && matchCost <= addCost && matchCost <= removeCost) {
      rows.push({ type: 'matched', proposed: proposed[j], oldAr: original[i], oldIndex: i, newIndex: j });
      i += 1;
      j += 1;
      continue;
    }

    if (i < m && removeCost <= addCost) {
      rows.push({ type: 'removed', oldAr: original[i], oldIndex: i });
      i += 1;
      continue;
    }

    if (j < n) {
      rows.push({ type: 'added', proposed: proposed[j], newIndex: j });
      j += 1;
    }
  }

  return rows;
}

function buildExcerpt(text: string, maxChars = 180): string {
  const compact = normalizeDisplayText(text).replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars).trimEnd()}...`;
}

function normalizeDisplayText(value: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';

  return trimmed
    .replace(/\\u2026/gi, '...')
    .replace(/\\u2318/gi, 'Cmd')
    .replace(/\\u2019/gi, "'")
    .replace(/\\u201c|\\u201d/gi, '"')
    .replace(/\\u[0-9a-f]{4}/gi, '')
    .replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, 'backlog item')
    .replace(/\s+/g, ' ')
    .trim();
}

type GenerationProgressMeta = {
  stage?: 'context' | 'triage' | 'decomposition' | 'acceptance_requirements';
  triage?: { shape: string; complexity: string; featureTarget: number; arDepth: string; arTarget: number; estimatedQuestions: number };
  arProgress?: { completed: number; total: number };
  draftFeatures?: Array<{ id: string; summary: string; description: string; storyPoints?: number }>;
  featureProgress?: Array<{ id: string; status: 'pending' | 'active' | 'complete' }>;
  sources?: {
    projectKey: string;
    domainContextApplied?: boolean;
    attachmentIncluded?: boolean;
    wiDocsCount?: number;
    referencedWiDocs?: Array<{ docId: string; filename: string; chunkCount: number }>;
    referencedWiSections?: Array<{ docId: string; filename: string; chunkIndex: number; excerpt: string }>;
    similarStoriesCount?: number;
    referencedSimilarStories?: Array<{ key: string; summary: string; relevanceScore?: number; url?: string; jiraIssueUrl?: string }>;
  };
};

const GENERATION_STEPS: Array<{ key: GenerationProgressMeta['stage']; label: string; shortLabel: string }> = [
  { key: 'context', label: 'Gathering context', shortLabel: 'Context' },
  { key: 'triage', label: 'Assessing scope', shortLabel: 'Triage' },
  { key: 'decomposition', label: 'Sketching features', shortLabel: 'Features' },
  { key: 'acceptance_requirements', label: 'Writing acceptance requirements', shortLabel: 'ARs' },
];

function getGenerationStageIndex(meta: GenerationProgressMeta | null, progress?: string) {
  if (meta?.stage) {
    const idx = GENERATION_STEPS.findIndex(step => step.key === meta.stage);
    if (idx >= 0) return idx;
  }
  const text = (progress || '').toLowerCase();
  if (text.includes('acceptance requirement')) return 3;
  if (text.includes('scope') || text.includes('complexity') || text.includes('targeting')) return 1;
  if (text.includes('planning feature') || text.includes('feature structure')) return 2;
  return 0;
}

const COMPLEXITY_LEVELS = [
  { key: 'trivial', label: 'Trivial' },
  { key: 'low', label: 'Low' },
  { key: 'medium', label: 'Medium' },
  { key: 'high', label: 'High' },
  { key: 'very_high', label: 'Complex' },
];

const AR_DEPTH_LABELS: Record<string, string> = {
  minimal: 'Minimal', lean: 'Lean', standard: 'Standard', thorough: 'Thorough', comprehensive: 'Comprehensive',
};

const SHAPE_LABELS: Record<string, string> = {
  minimal: 'Minimal', narrow: 'Narrow', balanced: 'Balanced', broad: 'Broad', epic: 'Epic',
};

function ComplexityBar({ current }: { current: string }) {
  const currentIndex = COMPLEXITY_LEVELS.findIndex(l => l.key === current);
  return (
    <div className="flex gap-1">
      {COMPLEXITY_LEVELS.map((level, idx) => {
        const isActive = idx === currentIndex;
        const isPast = idx < currentIndex;
        return (
          <div key={level.key} className="flex-1 flex flex-col gap-1">
            <div className={`h-2 rounded-sm transition-colors duration-500 ${
              isActive ? 'bg-[var(--rf-brand)]'
              : isPast ? 'bg-[var(--rf-brand-subtle)]'
              : 'bg-[var(--rf-border)]'
            }`} />
            <span className={`text-[10px] font-bold uppercase tracking-tight text-center transition-colors leading-tight ${
              isActive ? 'text-[var(--rf-brand)]' : 'text-[var(--rf-text-tertiary)] opacity-40'
            }`}>{level.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function TriageScoreCard({ triage }: { triage: GenerationProgressMeta['triage'] }) {
  if (!triage) {
    return (
      <div>
        <div className="flex items-center justify-between mb-2.5">
          <span className="text-[12px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Complexity</span>
          <span className="text-[12px] text-[var(--rf-text-tertiary)] animate-pulse">Assessing…</span>
        </div>
        <div className="flex gap-1 mb-1">
          {[0, 1, 2, 3, 4].map(i => (
            <div key={i} className="flex-1 h-2 rounded-sm shimmer" style={{ animationDelay: `${i * 0.12}s` }} />
          ))}
        </div>
        <div className="mt-3 h-px bg-[rgba(0,0,0,0.05)]" />
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
          {['Shape', 'Features', 'Questions', 'AR depth'].map(label => (
            <div key={label}>
              <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-0.5">{label}</div>
              <div className="h-4 w-12 shimmer rounded-sm" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const complexityLabel = COMPLEXITY_LEVELS.find(l => l.key === triage.complexity)?.label ?? triage.complexity;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-[12px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Complexity</span>
        <span className="text-[12px] font-bold text-[var(--rf-brand)] uppercase tracking-wide">{complexityLabel}</span>
      </div>
      <ComplexityBar current={triage.complexity} />

      <div className="mt-3 h-px bg-[rgba(0,0,0,0.05)]" />

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-0.5">Shape</div>
          <div className="text-[14px] font-black text-[var(--rf-text)]">{SHAPE_LABELS[triage.shape] ?? triage.shape}</div>
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-0.5">Features</div>
          <div className="text-[14px] font-black text-[var(--rf-text)]">~{triage.featureTarget}</div>
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-0.5">Questions asked</div>
          <div className="text-[14px] font-black text-[var(--rf-text)]">~{triage.estimatedQuestions}</div>
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-0.5">ARs / feature</div>
          <div className="text-[14px] font-black text-[var(--rf-text)]">~{triage.arTarget} <span className="text-[11px] font-semibold text-[var(--rf-text-tertiary)]">({AR_DEPTH_LABELS[triage.arDepth] ?? triage.arDepth})</span></div>
        </div>
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline Loading Component
// ─────────────────────────────────────────────────────────────────────────────
function GeneratingPipeline({
  meta, progress, title, onCancel, canCancel, projectKey
}: {
  meta: GenerationProgressMeta | null;
  progress?: string;
  title?: string;
  onCancel?: () => void;
  canCancel?: boolean;
  projectKey: string;
}) {
  const stageIndex = getGenerationStageIndex(meta, progress);
  const triage = meta?.triage;
  const arProgress = meta?.arProgress;
  const draftFeatures = meta?.draftFeatures ?? [];
  const featureProgress = meta?.featureProgress ?? [];
  const sources = meta?.sources ?? null;
  const featureProgressById = new Map(featureProgress.map(item => [item.id, item.status]));
  const liveArRatio = arProgress?.total ? Math.min(1, arProgress.completed / arProgress.total) : 0;

  // Anchored progress: context=5%, triage=25%, features=50%, ARs=72→100%
  const STAGE_PCT = [5, 25, 50, 72];
  const pct = stageIndex < 3
    ? STAGE_PCT[stageIndex]
    : Math.round(72 + liveArRatio * 28);

  return (
    <motion.div
      className="w-full flex flex-col items-center py-8 px-4"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="w-full max-w-3xl rounded-2xl border border-[rgba(43,89,74,0.10)] backdrop-blur-xl shadow-[0_24px_64px_-24px_rgba(31,30,29,0.18),0_8px_24px_-12px_rgba(31,30,29,0.10)] p-6 space-y-4" style={{ background: 'rgba(252,252,251,0.70)' }}>

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-1.5 text-[13px] font-bold uppercase tracking-[0.2em] text-[var(--rf-brand)] mb-2">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--rf-brand)] animate-pulse" />
              Pipeline Running
            </div>
            <h2 className="text-[20px] font-black text-[var(--rf-text)] tracking-tight" style={{ fontFamily: 'Fraunces, serif' }}>
              {title || 'Crafting features'}
            </h2>
            <p className="mt-1.5 text-[14px] font-medium text-[var(--rf-text-secondary)] flex items-center gap-2">
              <span className="dot-bounce flex gap-0.5"><span /><span /><span /></span>
              {normalizeDisplayText(progress || 'Processing...')}
            </p>
          </div>
          {canCancel && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="shrink-0 flex items-center gap-1.5 text-[12px] font-semibold text-[var(--rf-text-secondary)] hover:text-[var(--rf-danger)] transition px-3 py-1.5 rounded-lg border border-[var(--rf-border)] bg-white/70"
            >
              <X className="w-3.5 h-3.5" /> Stop
            </button>
          )}
        </div>

        {/* Step tracker + progress bar */}
        <div className="rounded-xl border border-[var(--rf-border)] bg-white/80 px-4 py-3.5">
          <div className="flex items-center gap-1">
            {GENERATION_STEPS.map((step, idx) => {
              const isDone = idx < stageIndex;
              const isCurrent = idx === stageIndex;
              return (
                <React.Fragment key={step.key}>
                  <div className="flex items-center gap-2 min-w-0 shrink">
                    <div className={`shrink-0 flex h-5 w-5 items-center justify-center rounded-full border-2 transition-all duration-300 ${
                      isDone ? 'bg-[var(--rf-brand)] border-[var(--rf-brand)]'
                      : isCurrent ? 'border-[var(--rf-brand)] bg-white'
                      : 'border-[var(--rf-border)] bg-white'
                    }`}>
                      {isDone
                        ? <CheckCircle2 className="w-3 h-3 text-white" />
                        : isCurrent
                          ? <span className="h-2 w-2 rounded-full bg-[var(--rf-brand)] animate-pulse" />
                          : <span className="h-1.5 w-1.5 rounded-full bg-[var(--rf-border-strong)]" />
                      }
                    </div>
                    <span className={`text-[12px] font-semibold truncate transition-colors hidden sm:block ${
                      isCurrent ? 'text-[var(--rf-brand)]'
                      : isDone ? 'text-[var(--rf-text-tertiary)]'
                      : 'text-[var(--rf-text-tertiary)] opacity-40'
                    }`}>{step.shortLabel}</span>
                  </div>
                  {idx < GENERATION_STEPS.length - 1 && (
                    <div className={`flex-1 h-px min-w-[8px] transition-colors duration-500 ${isDone ? 'bg-[var(--rf-brand-subtle)]' : 'bg-[var(--rf-border)]'}`} />
                  )}
                </React.Fragment>
              );
            })}
          </div>

          <div className="mt-3.5 h-1.5 overflow-hidden rounded-full bg-[rgba(35,74,61,0.07)]">
            <motion.div
              className="h-full rounded-full bg-[linear-gradient(90deg,var(--rf-brand),var(--rf-brand-hover))]"
              initial={{ width: 0 }}
              animate={{ width: `${Math.max(pct, 5)}%` }}
              transition={{ type: 'spring', damping: 30, stiffness: 80 }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[12px] text-[var(--rf-text-tertiary)]">
              {arProgress?.total ? `${arProgress.completed} of ${arProgress.total} ARs written` : normalizeDisplayText(GENERATION_STEPS[stageIndex]?.label ?? 'Starting...')}
            </span>
            <span className="text-[12px] font-bold text-[var(--rf-brand)]">{pct}%</span>
          </div>
        </div>

        {/* Triage scores + Context */}
        <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
          <div className="rounded-xl border border-[var(--rf-border)] bg-white/80 px-4 py-3.5">
            <TriageScoreCard triage={triage} />
          </div>

          <div className="rounded-xl border border-[var(--rf-border)] bg-white/80 px-4 py-3.5">
            <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-3">Context</div>
            <div className="space-y-2.5">
              <div className="flex justify-between items-baseline">
                <span className="text-[13px] text-[var(--rf-text-secondary)]">Backlog</span>
                <span className="text-[16px] font-black text-[var(--rf-text)]">{sources?.similarStoriesCount ?? 0}</span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-[13px] text-[var(--rf-text-secondary)]">WI snippets</span>
                <span className="text-[16px] font-black text-[var(--rf-text)]">{sources?.referencedWiSections?.length ?? 0}</span>
              </div>
              <div className="flex justify-between items-baseline pt-2 border-t border-[var(--rf-border-subtle)]">
                <span className="text-[13px] text-[var(--rf-text-secondary)]">Scope</span>
                <span className="text-[12px] font-bold text-[var(--rf-brand)] uppercase">{sources?.projectKey === '*' ? 'Global' : sources?.projectKey || projectKey}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Features list (once sketched) */}
        {draftFeatures.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-1.5"
          >
            <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-2">Features</div>
            {draftFeatures.slice(0, 6).map((f, i) => {
              const status = featureProgressById.get(f.id) || (i === 0 ? 'active' : 'pending');
              return (
                <div key={f.id} className="rounded-lg border border-[var(--rf-border)] bg-white/80 px-3 py-2.5 flex items-center gap-2.5">
                  <div className={`w-1.5 h-1.5 rounded-full shrink-0 transition-colors ${
                    status === 'active' ? 'bg-[var(--rf-brand)] animate-pulse'
                    : status === 'complete' ? 'bg-[var(--rf-success)]'
                    : 'bg-[var(--rf-border-strong)]'
                  }`} />
                  <span className="text-[13px] font-medium text-[var(--rf-text)] truncate flex-1">{f.summary}</span>
                  {status === 'complete' && <CheckCircle2 className="w-3.5 h-3.5 text-[var(--rf-success)] shrink-0" />}
                  {status === 'active' && (
                    <div className="w-10 h-1 bg-[rgba(0,0,0,0.05)] rounded-full overflow-hidden shrink-0">
                      <div className="h-full w-3/5 bg-[var(--rf-brand)] animate-pulse rounded-full" />
                    </div>
                  )}
                </div>
              );
            })}
          </motion.div>
        )}

        {/* Backlog signal (once ingested) */}
        {sources?.referencedSimilarStories && sources.referencedSimilarStories.length > 0 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-1.5">
                    <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-2">Backlog signal</div>
            {sources.referencedSimilarStories.slice(0, 2).map((s, i) => (
              <div key={s.key || i} className="rounded-lg border border-[var(--rf-border)] bg-white/80 px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-bold text-[var(--rf-brand)] uppercase">Pattern {i + 1}</span>
                  <span className="text-[13px] text-[var(--rf-text-tertiary)]">{Math.round((s.relevanceScore || 0) * 100)}% match</span>
                </div>
                <div className="text-[12px] text-[var(--rf-text-secondary)] truncate mt-0.5">{buildExcerpt(s.summary, 120)}</div>
              </div>
            ))}
          </motion.div>
        )}

      </div>
    </motion.div>
  );
}


// ─── AI Refine Popup ──────────────────────────────────────────────────────────
function RefinePopup({ feature, requirement, sessionId, onClose, onResult }: {
  feature: Feature;
  requirement: string;
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
      const res = await api.refineSingleFeature(feature, feedback, requirement, sessionId) as any;
      if (res.success && res.feature) {
        onResult(res.feature, res.tokenUsage);
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
      <motion.div
        className="absolute inset-0 bg-[var(--rf-text)]/30 backdrop-blur-sm"
        onClick={!loading ? onClose : undefined}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
      />
      <motion.div
        className="relative rf-card w-full max-w-lg flex flex-col overflow-hidden shadow-[0_24px_80px_-48px_rgba(15,23,42,0.28)]"
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="px-5 py-4 border-b border-[var(--rf-border-subtle)] flex items-center justify-between bg-[var(--rf-surface-soft)]/50">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[var(--rf-brand)]" />
            <span className="font-bold text-[var(--rf-text)] text-sm">AI Refine</span>
            <span className="text-[var(--rf-text-tertiary)] text-xs ml-1 line-clamp-1 max-w-[200px]">— {feature.title || feature.summary}</span>
          </div>
          {!loading && (
            <button onClick={onClose} className="p-1.5 hover:bg-[var(--rf-surface-soft)] text-[var(--rf-text-tertiary)] rounded-lg transition"><X className="w-4 h-4" /></button>
          )}
        </div>

        <div className="px-5 py-5">
          {loading ? (
            <div className="flex flex-col items-center py-8 gap-4">
              <div className="w-10 h-10 rounded-xl bg-[var(--rf-brand-muted)] flex items-center justify-center">
                <div className="w-5 h-5 border-[2.5px] border-[rgba(43,89,74,0.12)] border-t-[var(--rf-brand)] rounded-full spin-slow" />
              </div>
              <div className="text-center">
                <p className="font-bold text-[var(--rf-text)] text-sm">Refining feature...</p>
                <p className="text-xs text-[var(--rf-text-tertiary)] mt-1">The AI is working on your request</p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-[var(--rf-text-secondary)]">Describe what you want changed — e.g. "Add an AR for invalid password", "Tighten the scope to mobile only"</p>
              <textarea
                rows={4}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSend(); }}
                placeholder="Your refinement instructions..."
                className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition resize-none"
                autoFocus
              />
              {error && <p className="text-xs text-[var(--rf-danger)]">{error}</p>}
            </div>
          )}
        </div>

        {!loading && (
          <div className="px-5 py-4 border-t border-[var(--rf-border-subtle)] flex items-center justify-between gap-3 bg-[var(--rf-surface-soft)]/50">
            <span className="text-[13px] font-medium text-[var(--rf-text-tertiary)]">Cmd/Ctrl + Enter to send</span>
            <div className="flex gap-2">
              <motion.button onClick={onClose} className="px-4 py-2 text-xs font-semibold text-[var(--rf-text-secondary)] border border-[var(--rf-border)] rounded-lg hover:bg-[var(--rf-surface-soft)] transition bg-white" whileTap={{ scale: 0.97 }}>Cancel</motion.button>
              <motion.button
                onClick={handleSend}
                disabled={!input.trim()}
                className="flex items-center gap-1.5 px-5 py-2 text-xs font-bold text-white bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] disabled:opacity-40 rounded-lg transition shadow-sm shadow-[var(--rf-brand)]/20"
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
  storyPoints?: number;
  processCode?: string;
  isAccepted?: boolean;
  pendingRefinement?: Feature;
  pendingRemoval?: boolean;
  pendingAddition?: boolean;
  jiraIssueKey?: string;
  jiraIssueUrl?: string;
}

type FeatureDiffRow =
  | { type: 'matched'; original: Feature; proposed: Feature; oldIndex: number; newIndex: number }
  | { type: 'added'; proposed: Feature; newIndex: number }
  | { type: 'removed'; original: Feature; oldIndex: number };

function featureNarrative(feature: Feature): string {
  return [
    feature.title || feature.summary || '',
    feature.description || feature.markdown || '',
    ...(feature.acceptanceRequirements || []).flatMap(ar => [ar.given || '', ar.when || '', ar.then || '']),
  ].join(' ');
}

function featureSimilarity(left: Feature, right: Feature): number {
  const titleScore = jaccard(tokenSet(left.title || left.summary || ''), tokenSet(right.title || right.summary || ''));
  const descScore = jaccard(tokenSet(left.description || left.markdown || ''), tokenSet(right.description || right.markdown || ''));
  const narrativeScore = jaccard(tokenSet(featureNarrative(left)), tokenSet(featureNarrative(right)));
  const roleScore = jaccard(tokenSet(left.description || ''), tokenSet(right.description || ''));
  return (titleScore * 0.25) + (descScore * 0.25) + (narrativeScore * 0.35) + (roleScore * 0.15);
}

function featureArsEquivalent(left: AcceptanceRequirement[], right: AcceptanceRequirement[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((ar, idx) => {
    const other = right[idx];
    return Boolean(other)
      && normaliseWhitespace(ar.given) === normaliseWhitespace(other.given)
      && normaliseWhitespace(ar.when) === normaliseWhitespace(other.when)
      && normaliseWhitespace(ar.then) === normaliseWhitespace(other.then);
  });
}

function featuresEquivalent(left: Feature, right: Feature): boolean {
  return normaliseWhitespace(left.title || left.summary || '') === normaliseWhitespace(right.title || right.summary || '')
    && normaliseWhitespace(left.description || left.markdown || '') === normaliseWhitespace(right.description || right.markdown || '')
    && featureArsEquivalent(left.acceptanceRequirements || [], right.acceptanceRequirements || [])
    && (left.storyPoints ?? null) === (right.storyPoints ?? null)
    && normaliseWhitespace(left.processCode || '') === normaliseWhitespace(right.processCode || '');
}

function alignFeaturesDetailed(original: Feature[], proposed: Feature[]): FeatureDiffRow[] {
  const rows: FeatureDiffRow[] = [];
  const m = original.length;
  const n = proposed.length;
  const gapCost = 0.7;
  const matchThreshold = 0.18;
  const lowSimilarityPenalty = 1.45;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array.from({ length: n + 1 }, () => Number.POSITIVE_INFINITY));

  dp[m][n] = 0;
  for (let i = m; i >= 0; i -= 1) {
    for (let j = n; j >= 0; j -= 1) {
      if (i < m) dp[i][j] = Math.min(dp[i][j], gapCost + dp[i + 1][j]);
      if (j < n) dp[i][j] = Math.min(dp[i][j], gapCost + dp[i][j + 1]);
      if (i < m && j < n) {
        const similarity = featureSimilarity(original[i], proposed[j]);
        const matchCost = similarity >= matchThreshold ? (1 - similarity) * 0.9 : lowSimilarityPenalty;
        dp[i][j] = Math.min(dp[i][j], matchCost + dp[i + 1][j + 1]);
      }
    }
  }

  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    const removeCost = i < m ? gapCost + dp[i + 1][j] : Number.POSITIVE_INFINITY;
    const addCost = j < n ? gapCost + dp[i][j + 1] : Number.POSITIVE_INFINITY;
    const similarity = i < m && j < n ? featureSimilarity(original[i], proposed[j]) : 0;
    const matchCost = i < m && j < n
      ? (similarity >= matchThreshold ? (1 - similarity) * 0.9 : lowSimilarityPenalty) + dp[i + 1][j + 1]
      : Number.POSITIVE_INFINITY;

    if (i < m && j < n && matchCost <= addCost && matchCost <= removeCost) {
      rows.push({ type: 'matched', original: original[i], proposed: proposed[j], oldIndex: i, newIndex: j });
      i += 1;
      j += 1;
      continue;
    }

    if (i < m && removeCost <= addCost) {
      rows.push({ type: 'removed', original: original[i], oldIndex: i });
      i += 1;
      continue;
    }

    if (j < n) {
      rows.push({ type: 'added', proposed: proposed[j], newIndex: j });
      j += 1;
    }
  }

  return rows;
}

function annotateBulkRefinementResults(original: Feature[], proposed: Feature[]): Feature[] {
  return alignFeaturesDetailed(original, proposed).map((row) => {
    if (row.type === 'removed') {
      return {
        ...row.original,
        pendingRefinement: undefined,
        pendingAddition: false,
        pendingRemoval: true,
      };
    }

    if (row.type === 'added') {
      return {
        ...row.proposed,
        pendingRefinement: undefined,
        pendingRemoval: false,
        pendingAddition: true,
      };
    }

    if (featuresEquivalent(row.original, row.proposed)) {
      return {
        ...row.original,
        pendingRefinement: undefined,
        pendingAddition: false,
        pendingRemoval: false,
      };
    }

    return {
      ...row.original,
      pendingAddition: false,
      pendingRemoval: false,
      pendingRefinement: {
        ...row.proposed,
        id: row.original.id,
        pendingAddition: false,
        pendingRemoval: false,
        pendingRefinement: undefined,
      },
    };
  });
}

interface MainContentProps {
  features: Feature[];
  setFeatures: React.Dispatch<React.SetStateAction<Feature[]>>;
  onPushFeature: (index: number) => void;
  isGenerating: boolean;
  progress?: string;
  loadingTitle?: string;
  onCancelLoading?: () => void;
  canCancelLoading?: boolean;
  sidebarOpen: boolean;
  setSidebarOpen: (o: boolean) => void;
  sessionId: string;
  requirement: string;
  generationContext?: {
    domainRolesUsed: string[];
    projectKey: string;
    domainContextApplied?: boolean;
    attachmentIncluded?: boolean;
    wiDocsCount?: number;
    referencedWiDocs?: Array<{ docId: string; filename: string; chunkCount: number }>;
    referencedWiSections?: Array<{ docId: string; filename: string; chunkIndex: number; excerpt: string }>;
    similarStoriesCount?: number;
    referencedSimilarStories?: Array<{ key: string; summary: string; relevanceScore?: number; url?: string; jiraIssueUrl?: string }>;
    tokenUsage?: { input: number; output: number; total: number; byStage?: Record<string, { input: number; output: number; total: number }> };
  } | null;
  generationProgressMeta?: GenerationProgressMeta | null;
  projectKey: string;
  workflowTokenUsage?: { input: number; output: number; total: number } | null;
  onWorkflowTokenUsage?: (usage: { input: number; output: number; total: number }) => void;
}

// ─── Main component ───────────────────────────────────────────────────────────
export function MainContent({
  features, setFeatures, onPushFeature, isGenerating, progress, loadingTitle, onCancelLoading, canCancelLoading,
  sidebarOpen, setSidebarOpen, sessionId, requirement,
  generationContext, generationProgressMeta, projectKey, workflowTokenUsage, onWorkflowTokenUsage
}: MainContentProps) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<Feature | null>(null);
  const [refinePopupIdx, setRefinePopupIdx] = useState<number | null>(null);

  const [diffMode, setDiffMode] = useState<'redline' | 'blackline'>('redline');
  const [expandedIndices, setExpandedIndices] = useState<Set<number>>(new Set());
  const [showContextDetails, setShowContextDetails] = useState(false);

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
  const [bulkInput, setBulkInput] = useState('');
  const [isBulkRefining, setIsBulkRefining] = useState(false);
  const [bulkRefineProgress, setBulkRefineProgress] = useState('');
  const bulkRefinePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bulkRefineStartedAtRef = useRef<number>(0);
  const escapeSpreadsheetValue = (value: string | number | boolean | null | undefined) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

  type SpreadsheetCell = {
    value: string | number | boolean | null | undefined;
    styleId?: string;
    type?: 'String' | 'Number' | 'Boolean';
    mergeAcross?: number;
    href?: string;
  };

  const buildSpreadsheetCell = ({ value, styleId, type, mergeAcross, href }: SpreadsheetCell) => {
    const resolvedType = type || (typeof value === 'number' ? 'Number' : typeof value === 'boolean' ? 'Boolean' : 'String');
    const attrs = [
      styleId ? ` ss:StyleID="${styleId}"` : '',
      typeof mergeAcross === 'number' && mergeAcross > 0 ? ` ss:MergeAcross="${mergeAcross}"` : '',
      href ? ` ss:HRef="${escapeSpreadsheetValue(href)}"` : '',
    ].join('');
    return `<Cell${attrs}><Data ss:Type="${resolvedType}">${escapeSpreadsheetValue(value)}</Data></Cell>`;
  };

  const buildSpreadsheetRow = (cells: SpreadsheetCell[]) => `<Row>${cells.map(buildSpreadsheetCell).join('')}</Row>`;

  const exportFeaturesToExcel = () => {
    if (!features.length) return;

    const exportedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);

    const rows = [
      buildSpreadsheetRow([{ value: 'Refinely Feature Export', styleId: 'title', mergeAcross: 9 }]),
      buildSpreadsheetRow([{ value: `Workspace scope: ${projectKey === '*' ? 'Global workspace' : projectKey}`, styleId: 'meta', mergeAcross: 9 }]),
      buildSpreadsheetRow([{ value: `Exported at (UTC): ${exportedAt}`, styleId: 'meta', mergeAcross: 9 }]),
      buildSpreadsheetRow([{ value: `Features: ${features.length} · Acceptance requirements: ${totalArCount}`, styleId: 'meta', mergeAcross: 9 }]),
      buildSpreadsheetRow([
        { value: 'Type', styleId: 'header' },
        { value: 'Feature #', styleId: 'header' },
        { value: 'Feature Title', styleId: 'header' },
        { value: 'Summary / AR Note', styleId: 'header' },
        { value: 'Given', styleId: 'header' },
        { value: 'When', styleId: 'header' },
        { value: 'Then', styleId: 'header' },
        { value: 'Status', styleId: 'header' },
        { value: 'Jira Issue', styleId: 'header' },
        { value: 'Jira URL', styleId: 'header' },
      ]),
      ...features.flatMap((feature, idx) => {
        const featureNumber = idx + 1;
        const featureTitle = feature.title || feature.summary || `Feature ${featureNumber}`;
        const featureDescription = feature.description || feature.markdown || '';
        const jiraUrl = feature.jiraIssueUrl || '';
        const status = feature.pendingRemoval
          ? 'Pending removal'
          : feature.pendingAddition
            ? 'Pending addition'
          : feature.pendingRefinement
            ? 'Pending refinement'
            : feature.isAccepted
              ? 'Accepted'
              : 'Draft';

        const featureRows = [
          buildSpreadsheetRow([
            { value: 'Feature', styleId: 'featureLabel' },
            { value: featureNumber, styleId: 'featureLabel', type: 'Number' },
            { value: featureTitle, styleId: 'featureLabel' },
            { value: featureDescription, styleId: 'featureValue' },
            { value: `ARs: ${feature.acceptanceRequirements?.length || 0}`, styleId: 'featureValue' },
            { value: '', styleId: 'featureValue' },
            { value: '', styleId: 'featureValue' },
            { value: status, styleId: 'featureValue' },
            { value: feature.jiraIssueKey || '', styleId: jiraUrl ? 'link' : 'featureValue', href: jiraUrl || undefined },
            { value: jiraUrl || '', styleId: jiraUrl ? 'link' : 'featureValue', href: jiraUrl || undefined },
          ]),
        ];

        const arRows = (feature.acceptanceRequirements || []).map((ar, arIdx) => buildSpreadsheetRow([
          { value: 'AR', styleId: 'arLabel' },
          { value: featureNumber, styleId: 'arLabel', type: 'Number' },
          { value: featureTitle, styleId: 'arLabel' },
          { value: `Acceptance requirement ${arIdx + 1}`, styleId: 'arValue' },
          { value: ar.given || '', styleId: 'arValue' },
          { value: ar.when || '', styleId: 'arValue' },
          { value: ar.then || '', styleId: 'arValue' },
          { value: status, styleId: 'arValue' },
          { value: feature.jiraIssueKey || '', styleId: jiraUrl ? 'link' : 'arValue', href: jiraUrl || undefined },
          { value: jiraUrl || '', styleId: jiraUrl ? 'link' : 'arValue', href: jiraUrl || undefined },
        ]));

        return [...featureRows, ...arRows];
      }),
    ].join('');

    const workbook = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="title">
   <Font ss:Bold="1" ss:Size="14" ss:Color="#173a2e"/>
   <Interior ss:Color="#f5f2ea" ss:Pattern="Solid"/>
   <Alignment ss:Vertical="Center"/>
  </Style>
  <Style ss:ID="meta">
   <Font ss:Size="10" ss:Color="#5b6570"/>
   <Interior ss:Color="#fbfaf6" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="header">
   <Font ss:Bold="1" ss:Color="#ffffff"/>
   <Interior ss:Color="#234a3d" ss:Pattern="Solid"/>
   <Alignment ss:Vertical="Center" ss:WrapText="1"/>
  </Style>
  <Style ss:ID="featureLabel">
   <Font ss:Bold="1" ss:Color="#234a3d"/>
   <Interior ss:Color="#e8f2ec" ss:Pattern="Solid"/>
   <Alignment ss:Vertical="Top" ss:WrapText="1"/>
  </Style>
  <Style ss:ID="featureValue">
   <Font ss:Color="#1f2937"/>
   <Interior ss:Color="#fbf9f4" ss:Pattern="Solid"/>
   <Alignment ss:Vertical="Top" ss:WrapText="1"/>
  </Style>
  <Style ss:ID="arLabel">
   <Font ss:Bold="1" ss:Color="#7c5e00"/>
   <Interior ss:Color="#fff8e8" ss:Pattern="Solid"/>
   <Alignment ss:Vertical="Top" ss:WrapText="1"/>
  </Style>
  <Style ss:ID="arValue">
   <Font ss:Color="#1f2937"/>
   <Interior ss:Color="#ffffff" ss:Pattern="Solid"/>
   <Alignment ss:Vertical="Top" ss:WrapText="1"/>
  </Style>
  <Style ss:ID="link">
   <Font ss:Color="#0f766e" ss:Underline="Single"/>
   <Interior ss:Color="#ffffff" ss:Pattern="Solid"/>
   <Alignment ss:Vertical="Top" ss:WrapText="1"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="Features and ARs">
  <Table>
   <Column ss:Width="70"/>
   <Column ss:Width="68"/>
   <Column ss:Width="220"/>
   <Column ss:Width="280"/>
   <Column ss:Width="240"/>
   <Column ss:Width="240"/>
   <Column ss:Width="280"/>
   <Column ss:Width="110"/>
   <Column ss:Width="150"/>
   <Column ss:Width="260"/>
   ${rows}
  </Table>
 </Worksheet>
</Workbook>`;

    try {
      const blob = new Blob([workbook], { type: 'application/vnd.ms-excel;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const safeScope = (projectKey === '*' ? 'workspace' : projectKey).replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
      const dateStamp = new Date().toISOString().slice(0, 10);
      link.href = url;
      link.download = `refinely-feature-canvas-${safeScope}-${dateStamp}.xls`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Excel export failed:', error);
      window.alert('Excel export failed. Please try again.');
    }
  };

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
    if (features[idx]?.pendingRemoval) {
      removeFeatureAt(idx);
      return;
    }
    setFeatures(prev => {
      const n = [...prev];
      if (n[idx].pendingAddition) {
        n[idx] = { ...n[idx], pendingAddition: undefined, pendingRefinement: undefined, pendingRemoval: undefined };
      } else if (n[idx].pendingRefinement) {
        n[idx] = {
          ...n[idx].pendingRefinement!,
          id: n[idx].id,
          pendingAddition: undefined,
          pendingRefinement: undefined,
          pendingRemoval: undefined,
        };
      }
      api.updateConversationFeatures(sessionId, n);
      return n;
    });
  };
  const rejectRefinement = (idx: number) => {
    if (features[idx]?.pendingAddition) {
      removeFeatureAt(idx);
      return;
    }
    setFeatures(prev => {
      const n = [...prev];
      n[idx] = { ...n[idx], pendingAddition: undefined, pendingRefinement: undefined, pendingRemoval: undefined };
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
  const shiftIndexedUiStateAfterRemoval = (idx: number) => {
    setExpandedIndices(prev => {
      const next = new Set<number>();
      prev.forEach(i => {
        if (i < idx) next.add(i);
        if (i > idx) next.add(i - 1);
      });
      return next;
    });
    setEditingIdx(prev => (prev === null ? null : prev === idx ? null : prev > idx ? prev - 1 : prev));
    setRefinePopupIdx(prev => (prev === null ? null : prev === idx ? null : prev > idx ? prev - 1 : prev));
  };
  const clearPendingRemoval = (idx: number) => {
    setFeatures(prev => {
      const next = prev.map((f, i) => i === idx ? { ...f, pendingRemoval: false } : f);
      api.updateConversationFeatures(sessionId, next);
      return next;
    });
  };
  const removeFeatureAt = (idx: number) => {
    shiftIndexedUiStateAfterRemoval(idx);
    setFeatures(prev => {
      const next = prev.filter((_, i) => i !== idx);
      api.updateConversationFeatures(sessionId, next);
      return next;
    });
  };
  const requestFeatureRemoval = (idx: number) => {
    const feature = features[idx];
    if (!feature) return;
    const featureLabel = feature.title || feature.summary || `Feature ${idx + 1}`;
    const jiraMessage = feature.jiraIssueKey
      ? `\n\nThis only removes it from Refinely. Jira issue ${feature.jiraIssueKey} will remain unchanged.`
      : '';
    if (window.confirm(`Remove "${featureLabel}" from the canvas? This cannot be undone.${jiraMessage}`)) {
      removeFeatureAt(idx);
    }
  };

  useEffect(() => {
    if (!isBulkRefining) {
      if (bulkRefinePollRef.current) {
        clearInterval(bulkRefinePollRef.current);
        bulkRefinePollRef.current = null;
      }
      if (!showBulkRefine) setBulkRefineProgress('');
      return;
    }

    let active = true;
    bulkRefineStartedAtRef.current = Date.now();
    setBulkRefineProgress(previous => previous || 'Starting bulk refinement…');

    bulkRefinePollRef.current = setInterval(async () => {
      if (!active) return;
      try {
        const res = await api.getBulkRefineResult(sessionId) as any;
        if (!active || !res?.success) return;
        const event = res.progress;

        if (!event) {
          if (Date.now() - bulkRefineStartedAtRef.current > 90_000) {
            throw new Error('Bulk refinement did not start. Please try again.');
          }
          return;
        }

        if (event.type === 'progress') {
          if (event.message) setBulkRefineProgress(event.message);
          const updatedAt = event.updatedAt ?? 0;
          if (updatedAt > 0 && Date.now() - updatedAt > 180_000) {
            throw new Error('Bulk refinement is taking unusually long. Please try again, or switch to a faster model in Settings.');
          }
          return;
        }

        if (bulkRefinePollRef.current) {
          clearInterval(bulkRefinePollRef.current);
          bulkRefinePollRef.current = null;
        }

        if (event.type === 'complete') {
          if (!Array.isArray(event.features)) {
            throw new Error('Bulk refinement finished without returning features.');
          }
          if (event.tokenUsage?.total) {
            onWorkflowTokenUsage?.(event.tokenUsage as { input: number; output: number; total: number });
          }
          setFeatures(prev => annotateBulkRefinementResults(prev, event.features as Feature[]));
          setShowBulkRefine(false);
          setBulkInput('');
          setBulkRefineProgress('');
          setIsBulkRefining(false);
          return;
        }

        if (event.type === 'cancelled') {
          setBulkRefineProgress('');
          setIsBulkRefining(false);
          return;
        }

        throw new Error(event.message || 'Bulk refinement failed');
      } catch (err: any) {
        if (bulkRefinePollRef.current) {
          clearInterval(bulkRefinePollRef.current);
          bulkRefinePollRef.current = null;
        }
        if (!active) return;
        console.error('Bulk refinement failed:', err);
        setBulkRefineProgress('');
        setIsBulkRefining(false);
        alert(`AI refinement failed: ${err.message || 'Unknown error'}. Please try again.`);
      }
    }, 1500);

    return () => {
      active = false;
      if (bulkRefinePollRef.current) {
        clearInterval(bulkRefinePollRef.current);
        bulkRefinePollRef.current = null;
      }
    };
  }, [isBulkRefining, onWorkflowTokenUsage, sessionId, setFeatures, showBulkRefine]);

  const handleBulkRefine = async () => {
    if (!bulkInput.trim() || isBulkRefining) return;

    try {
      const feedback = bulkInput.trim();
      const res = await api.refineFeatures(sessionId, requirement, features, feedback) as any;
      if (!res.success) {
        throw new Error(res.error || 'Bulk refinement failed');
      }
      setBulkRefineProgress('Queuing bulk refinement…');
      setIsBulkRefining(true);
    } catch (err: any) {
      console.error('Bulk refinement failed:', err);
      setBulkRefineProgress('');
      alert(`AI refinement failed: ${err.message || 'Unknown error'}. Please try again.`);
    }
  };

  const discardAllProposed = () => {
    if (window.confirm('Discard all pending AI improvements?')) {
      setFeatures(prev => {
        const next = prev
          .filter(f => !f.pendingAddition)
          .map(f => ({ ...f, pendingAddition: undefined, pendingRefinement: undefined, pendingRemoval: undefined }));
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
          if (f.pendingAddition) {
            return {
              ...f,
              pendingAddition: undefined,
              pendingRefinement: undefined,
              pendingRemoval: undefined,
            };
          }
          if (!f.pendingRefinement) return f;
          return {
            ...f,
            ...f.pendingRefinement,
            id: f.id,
            pendingAddition: undefined,
            pendingRefinement: undefined,
            pendingRemoval: undefined,
            isAccepted: true
          };
        });
      api.updateConversationFeatures(sessionId, next);
      return next;
    });
  };

  return (
    <main className="flex-1 flex min-w-0 flex-col h-full relative overflow-hidden bg-transparent">
      <motion.header
        className="rf-pane-header rf-pane-header--canvas shrink-0 sticky top-0"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="flex h-full w-full min-w-0 items-center gap-4">
          <div className="rf-pane-header-cluster">
            {!sidebarOpen && (
              <motion.button
                onClick={() => setSidebarOpen(true)}
                className="p-2 -ml-2 rounded-xl hover:bg-[var(--rf-surface-soft)] text-[var(--rf-text-secondary)] transition-colors"
                title="Open Sidebar"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
              >
                <Menu className="w-5 h-5" />
              </motion.button>
            )}
            <div className="rf-pane-header-copy">
              <h2 className="rf-pane-header-title">Feature Canvas</h2>
            </div>
          </div>
        </div>
      </motion.header>

      {/* Canvas toolbar — stats + actions, only when features exist */}
      {hasFeatures && !isGenerating && (
        <div className="shrink-0 border-b border-[var(--rf-border)] bg-[rgba(252,252,251,0.82)] px-5 py-3 backdrop-blur-md">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              {[
                { label: 'Features', value: features.length },
                { label: 'ARs', value: totalArCount },
                ...(features.filter(f => f.isAccepted).length > 0
                  ? [{ label: 'Accepted', value: features.filter(f => f.isAccepted).length }]
                  : []),
              ].map((chip) => (
                <span key={chip.label} className="inline-flex items-center gap-2 rounded-full border border-[var(--rf-border)] bg-white px-3 py-1.5 text-[12px] font-semibold text-[var(--rf-text-secondary)] shadow-sm">
                  <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">{chip.label}</span>
                  <span className="text-[13px] font-black text-[var(--rf-text)]">{chip.value}</span>
                </span>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {features.some(f => f.pendingRefinement || f.pendingRemoval || f.pendingAddition) && (
                <>
                  <motion.button onClick={discardAllProposed} className="rounded-xl border border-[var(--rf-border)] bg-white px-3 py-2 text-[12px] font-bold text-[var(--rf-text-secondary)] shadow-sm transition hover:border-[var(--rf-danger-subtle)] hover:text-[var(--rf-danger)]" whileTap={{ scale: 0.97 }}>Discard All</motion.button>
                  <motion.button onClick={acceptAllProposed} className="rounded-xl border border-[rgba(16,185,129,0.18)] bg-[var(--rf-success-subtle)] px-3 py-2 text-[12px] font-bold text-[var(--rf-success)] shadow-sm transition hover:brightness-[0.98]" whileTap={{ scale: 0.97 }}>Accept All</motion.button>
                </>
              )}
              <motion.button
                onClick={exportFeaturesToExcel}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--rf-border)] bg-white px-3 py-2 text-[12px] font-bold text-[var(--rf-text-secondary)] shadow-sm transition hover:border-[var(--rf-brand-subtle)] hover:text-[var(--rf-brand)]"
                whileTap={{ scale: 0.97 }}
                title="Export to Excel"
              >
                <Download className="w-3.5 h-3.5" />
                Export
              </motion.button>
              <motion.button
                onClick={() => setShowBulkRefine(true)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[rgba(43,89,74,0.16)] bg-[var(--rf-brand-muted)] px-3 py-2 text-[12px] font-bold text-[var(--rf-brand-hover)] shadow-sm transition hover:border-[var(--rf-brand)] hover:bg-white"
                whileTap={{ scale: 0.97 }}
              >
                <Sparkles className="w-3.5 h-3.5" />
                Refine All
              </motion.button>
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto w-full flex flex-col items-center relative custom-scrollbar p-6">
        <AnimatePresence mode="wait">
          {isGenerating ? (
            <GeneratingPipeline 
              meta={generationProgressMeta || null} 
              progress={progress} 
              title={loadingTitle} 
              onCancel={onCancelLoading} 
              canCancel={canCancelLoading}
              projectKey={projectKey}
            />
          ) : !hasFeatures ? (
            <motion.div
              key="empty-state"
              className="flex-1 flex flex-col items-center justify-center text-center max-w-md mx-auto"
              initial={{ opacity: 0, y: 16, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -12, scale: 0.98 }}
              transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="levitate w-16 h-16 rounded-2xl flex items-center justify-center mb-6 bg-white shadow-xl shadow-[var(--rf-shadow-sm)] border border-[var(--rf-border)]">
                <Sparkles className="w-7 h-7 text-[var(--rf-brand)]" />
              </div>
              <h2 className="text-2xl font-bold text-[var(--rf-text)] mb-3 tracking-tight">Ready to generate</h2>
              <p className="text-[var(--rf-text-tertiary)] text-sm leading-relaxed font-medium">Describe your requirement in the sidebar, answer the clarifying questions, and your polished features will appear here.</p>
            </motion.div>
          ) : (
            <motion.div
              key="features-canvas"
              className="w-full max-w-[900px] mx-auto space-y-3 pb-10"
              initial={{ opacity: 0, y: 16, scale: 0.99 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -12, scale: 0.99 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            >
            {generationContext && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              >
                {/* Slim source stack strip */}
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--rf-border)] bg-white/80 px-4 py-2.5">
                  <span className="text-[13px] font-bold uppercase tracking-[0.18em] text-[var(--rf-brand)] shrink-0">Source stack</span>
                  <div className="flex items-center gap-1.5 flex-wrap flex-1 min-w-0">
                    <span className="inline-flex items-center rounded-md border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-2 py-0.5 text-[13px] font-semibold text-[var(--rf-text-secondary)]">
                      {generationContext.projectKey === '*' ? 'Global' : generationContext.projectKey}
                    </span>
                    {(generationContext.similarStoriesCount ?? 0) > 0 && (
                      <span className="inline-flex items-center rounded-md border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-2 py-0.5 text-[13px] font-semibold text-[var(--rf-text-secondary)]">
                        {generationContext.similarStoriesCount} backlog items
                      </span>
                    )}
                    {(generationContext.referencedWiSections?.length ?? 0) > 0 && (
                      <span className="inline-flex items-center rounded-md border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-2 py-0.5 text-[13px] font-semibold text-[var(--rf-text-secondary)]">
                        {generationContext.referencedWiSections!.length} WI excerpts
                      </span>
                    )}
                    {generationContext.domainContextApplied && (
                      <span className="inline-flex items-center rounded-md border border-[rgba(43,89,74,0.14)] bg-[var(--rf-brand-muted)] px-2 py-0.5 text-[13px] font-semibold text-[var(--rf-brand)]">
                        Guidance on
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowContextDetails(prev => !prev)}
                    className="text-[13px] font-semibold text-[var(--rf-brand)] hover:text-[var(--rf-brand-hover)] transition-colors shrink-0"
                  >
                    {showContextDetails ? 'Hide' : 'Details'}
                  </button>
                </div>
                <AnimatePresence initial={false}>
                  {showContextDetails && (
                    <motion.div
                      className="mt-2 rounded-xl border border-[var(--rf-border)] bg-white/80 overflow-hidden"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2 }}
                    >
                    <div className="space-y-4 p-4">
                      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                        <div className="rf-card p-4">
                          <div className="flex items-center justify-between gap-3 mb-3">
                            <div className="text-[12px] font-bold uppercase tracking-[0.2em] text-[var(--rf-text-tertiary)]">Backlog patterns</div>
                            <div className="text-[12px] font-bold uppercase tracking-wider text-[var(--rf-text-tertiary)] bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-full px-2.5 py-1">
                              {generationContext.referencedSimilarStories?.length || 0}
                            </div>
                          </div>
                          {(generationContext.referencedSimilarStories?.length ?? 0) > 0 ? (
                            <div className="space-y-2.5">
                              {generationContext.referencedSimilarStories!.slice(0, 4).map((story, i) => (
                                <div key={`${story.key}-${i}`} className="rounded-2xl border border-[rgba(35,74,61,0.1)] bg-[linear-gradient(135deg,rgba(35,74,61,0.04),rgba(255,255,255,0.92))] p-3">
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="text-xs font-bold text-[var(--rf-text)]">Pattern {i + 1}</div>
                                    {typeof story.relevanceScore === 'number' && (
                                      <div className="shrink-0 rounded-full border border-[var(--rf-border)] bg-white px-2 py-1 text-[12px] font-bold uppercase tracking-wider text-[var(--rf-text-tertiary)]">
                                        {Math.min(100, Math.round(story.relevanceScore * 100))}% match
                                      </div>
                                    )}
                                  </div>
                                  <div className="mt-2 text-xs text-[var(--rf-text-secondary)] leading-relaxed">
                                    {buildExcerpt(story.summary, 160)}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="text-xs italic text-[var(--rf-text-tertiary)]">No backlog patterns were available.</div>
                          )}
                        </div>

                        <div className="rf-card p-4">
                          <div className="flex items-center justify-between gap-3 mb-3">
                            <div className="text-[12px] font-bold uppercase tracking-[0.2em] text-[var(--rf-text-tertiary)]">Work instruction excerpts</div>
                            <div className="text-[12px] font-bold uppercase tracking-wider text-[var(--rf-text-tertiary)] bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-full px-2.5 py-1">
                              {generationContext.referencedWiSections?.length || 0}
                            </div>
                          </div>
                          {(generationContext.referencedWiSections?.length ?? 0) > 0 ? (
                            <div className="space-y-2.5">
                              {generationContext.referencedWiSections!.map((section, i) => (
                                <div key={`${section.docId}-${section.chunkIndex}-${i}`} className="rounded-2xl border border-[rgba(35,74,61,0.1)] bg-[linear-gradient(135deg,rgba(35,74,61,0.04),rgba(255,255,255,0.92))] p-3">
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="text-[13px] font-bold text-[var(--rf-text)] truncate">Instruction excerpt {i + 1}</div>
                                    </div>
                                  </div>
                                  <div className="mt-2 text-xs text-[var(--rf-text-secondary)] leading-relaxed">
                                    {buildExcerpt(section.excerpt, 180)}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="text-xs italic text-[var(--rf-text-tertiary)]">No work instruction excerpts were used.</div>
                          )}
                        </div>

                        <div className="rf-card p-4">
                          <div className="text-[12px] font-bold uppercase tracking-[0.2em] text-[var(--rf-text-tertiary)]">Run profile</div>
                          <div className="mt-3 space-y-2.5">
                            <div className="rounded-2xl border border-[rgba(35,74,61,0.1)] bg-[linear-gradient(135deg,rgba(35,74,61,0.04),rgba(255,255,255,0.92))] p-3">
                              <div className="text-[12px] font-bold uppercase tracking-[0.14em] text-[var(--rf-text-tertiary)]">Attachment context</div>
                              <div className="mt-1.5 text-sm font-semibold text-[var(--rf-text)]">{generationContext.attachmentIncluded ? 'Included in reasoning' : 'No attachment used'}</div>
                            </div>
                            <div className="rounded-2xl border border-[rgba(35,74,61,0.1)] bg-[linear-gradient(135deg,rgba(35,74,61,0.04),rgba(255,255,255,0.92))] p-3">
                              <div className="text-[12px] font-bold uppercase tracking-[0.14em] text-[var(--rf-text-tertiary)]">Work instruction docs</div>
                              <div className="mt-1.5 text-sm font-semibold text-[var(--rf-text)]">{generationContext.wiDocsCount ?? 0} document{(generationContext.wiDocsCount ?? 0) !== 1 ? 's' : ''} scanned</div>
                            </div>
                            <div className="rounded-2xl border border-[rgba(35,74,61,0.1)] bg-[linear-gradient(135deg,rgba(35,74,61,0.04),rgba(255,255,255,0.92))] p-3">
                              <div className="text-[12px] font-bold uppercase tracking-[0.14em] text-[var(--rf-text-tertiary)]">Token usage</div>
                              <div className="mt-1.5 text-sm font-semibold text-[var(--rf-text)]">{(generationContext.tokenUsage?.total ?? 0).toLocaleString()} tokens total</div>
                              <div className="mt-1 text-[13px] text-[var(--rf-text-tertiary)]">
                                {(generationContext.tokenUsage?.input ?? 0).toLocaleString()} in / {(generationContext.tokenUsage?.output ?? 0).toLocaleString()} out
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}

            {features.map((feature, idx) => {
              const isEditing = editingIdx === idx;
              const draft = editDraft;

              return (
                <motion.div
                  key={feature.id || idx}
                  className={`group overflow-hidden rounded-2xl border bg-white ${feature.pendingRemoval ? 'opacity-70 border-[var(--rf-danger-subtle)]' : feature.pendingAddition ? 'border-[var(--rf-success-subtle)]' : feature.isAccepted ? 'border-[var(--rf-success-subtle)]' : 'border-[var(--rf-border)]'}`}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.05, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                  style={{ boxShadow: feature.pendingAddition || feature.isAccepted ? '0 4px 20px -4px rgba(16,185,129,0.15)' : feature.pendingRemoval ? '0 4px 20px -4px rgba(244,63,94,0.15)' : '0 4px 12px -4px rgba(15,23,42,0.05)' }}
                  whileHover={{ y: -2, boxShadow: feature.isAccepted ? '0 8px 30px -4px rgba(16,185,129,0.2)' : '0 8px 24px -4px rgba(15,23,42,0.08)' }}
                >
                  <div className="flex flex-col sm:flex-row">
                    {/* Left Accent Strip */}
                    <div className={`h-1.5 sm:h-auto sm:w-2 shrink-0 ${feature.pendingRemoval ? 'bg-[var(--rf-danger-subtle)]' : feature.pendingAddition || feature.isAccepted ? 'bg-[var(--rf-success-subtle)]' : 'bg-[var(--rf-brand-muted)]'}`} />

                    <div className="flex-1 p-4">
                      {/* Header Row */}
                      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4 mb-4">
                        {isEditing ? (
                          <input
                            type="text"
                            value={draft?.title || draft?.summary || ''}
                            onChange={e => setEditDraft(d => d ? { ...d, summary: e.target.value, title: e.target.value } : null)}
                            className="flex-1 text-lg font-bold text-[var(--rf-text)] bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-2 focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none transition"
                          />
                        ) : (
                          <div className="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center gap-3 cursor-pointer" onClick={() => toggleExpand(idx)}>
                            <h3 className="min-w-0 flex-1 text-lg font-bold leading-snug text-[var(--rf-text)] tracking-tight">
                              {feature.title || feature.summary || 'Untitled Feature'}
                            </h3>
                            <div className="shrink-0 flex items-center gap-2">
                              <span className="inline-flex min-w-[54px] justify-center items-center rounded-lg px-2.5 py-1 bg-[var(--rf-surface-soft)] text-[var(--rf-text-secondary)] text-[12px] font-bold tracking-widest border border-[var(--rf-border)]">
                                {feature.acceptanceRequirements?.length || 0} ARs
                              </span>
                              <ChevronDown className={`w-4 h-4 text-[var(--rf-text-tertiary)] transition-transform duration-300 ${expandedIndices.has(idx) ? 'rotate-180' : ''}`} />
                            </div>
                          </div>
                        )}

                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          {isEditing ? (
                            <>
                              <motion.button onClick={cancelEditing} className="px-3 py-1.5 text-xs font-bold text-[var(--rf-text-secondary)] bg-[var(--rf-surface-soft)] hover:bg-[var(--rf-surface-soft)] rounded-lg transition" whileTap={{ scale: 0.97 }}>Cancel</motion.button>
                              <motion.button onClick={saveEditing} className="px-3 py-1.5 text-xs font-bold text-white bg-[var(--rf-success)] hover:bg-[var(--rf-success)] rounded-lg transition flex items-center gap-1.5 shadow-sm shadow-[var(--rf-success)]/20" whileTap={{ scale: 0.97 }}><Check className="w-3.5 h-3.5" /> Save</motion.button>
                            </>
                          ) : (
                            <>
                              <motion.button onClick={() => startEditing(idx)} className="px-2.5 py-1.5 text-[13px] font-bold text-[var(--rf-text-tertiary)] hover:bg-[var(--rf-surface-soft)] hover:text-[var(--rf-text)] rounded-lg transition flex items-center gap-1.5" whileTap={{ scale: 0.97 }}><Edit2 className="w-3.5 h-3.5" /> Edit</motion.button>
                              <motion.button onClick={() => setRefinePopupIdx(idx)} className="px-2.5 py-1.5 text-[13px] font-bold text-[var(--rf-brand)] hover:bg-[var(--rf-brand-muted)] rounded-lg transition flex items-center gap-1.5" whileTap={{ scale: 0.97 }}><Sparkles className="w-3.5 h-3.5" /> Refine</motion.button>
                              <motion.button onClick={() => toggleAccepted(idx)} className={`px-3 py-1.5 text-[13px] font-bold rounded-lg transition border flex items-center gap-1.5 shadow-sm ${feature.isAccepted ? 'text-[var(--rf-success)] bg-[var(--rf-success-subtle)] border-[var(--rf-success-subtle)]' : 'text-[var(--rf-text-secondary)] bg-white border-[var(--rf-border)] hover:bg-[var(--rf-success-subtle)] hover:text-[var(--rf-success)] hover:border-[var(--rf-success-subtle)]'}`} whileTap={{ scale: 0.97 }}>
                                <Check className="w-3.5 h-3.5" /> {feature.isAccepted ? 'Accepted' : 'Accept'}
                              </motion.button>
                              <motion.button onClick={() => requestFeatureRemoval(idx)} className="px-2.5 py-1.5 text-[13px] font-bold text-[var(--rf-danger)] hover:bg-[var(--rf-danger-subtle)] rounded-lg transition flex items-center gap-1.5" whileTap={{ scale: 0.97 }}><Trash2 className="w-3.5 h-3.5" /> Delete</motion.button>
                              {feature.jiraIssueKey ? (
                                <div className="flex items-center gap-1">
                                  <motion.button
                                    onClick={() => feature.jiraIssueUrl ? router.navigate(feature.jiraIssueUrl) : null}
                                    className="px-3 py-1.5 text-[13px] font-bold text-[var(--rf-brand-hover)] bg-[var(--rf-brand-muted)] border border-[var(--rf-brand-subtle)] rounded-lg transition flex items-center gap-1.5 hover:bg-[var(--rf-brand-subtle)] shadow-sm"
                                    whileTap={{ scale: 0.97 }}
                                  >
                                    <Check className="w-3.5 h-3.5" /> {feature.jiraIssueKey}
                                  </motion.button>
                                  <motion.button
                                    onClick={() => {
                                      if (window.confirm(`Safety Warning: This feature has already been pushed to Jira as issue ${feature.jiraIssueKey}.\n\nAre you sure you want to push it again and create a duplicate issue?`)) {
                                        onPushFeature(idx);
                                      }
                                    }}
                                    title="Push a duplicate to Jira"
                                    className="px-2 py-1.5 text-[var(--rf-text-tertiary)] hover:bg-[var(--rf-surface-soft)] hover:text-[var(--rf-text-secondary)] rounded-lg transition"
                                    whileTap={{ scale: 0.97 }}
                                  >
                                    <Upload className="w-4 h-4" />
                                  </motion.button>
                                </div>
                              ) : (
                                <motion.button
                                  onClick={() => onPushFeature(idx)}
                                  disabled={!feature.isAccepted}
                                  title={!feature.isAccepted ? "Accept feature first to push to Jira" : ""}
                                  className="px-3 py-1.5 text-[13px] font-bold text-white bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] disabled:bg-[var(--rf-border-strong)] disabled:text-[var(--rf-text-tertiary)] rounded-lg transition flex items-center gap-1.5 shadow-sm shadow-[var(--rf-brand)]/20"
                                  whileTap={{ scale: 0.97 }}
                                >
                                  <Upload className="w-3.5 h-3.5" /> Push
                                </motion.button>
                              )}
                            </>
                          )}
                        </div>
                      </div>

                      {feature.pendingRemoval && (
                        <div className="mb-4 p-4 rounded-xl bg-[var(--rf-danger-subtle)] border border-[var(--rf-danger-subtle)] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                           <div className="flex items-center gap-2 text-[var(--rf-danger)] font-bold text-sm">
                             <Trash2 className="w-4 h-4" /> Proposed for Removal
                           </div>
                           <div className="flex items-center gap-2">
                             <motion.button onClick={() => clearPendingRemoval(idx)} className="px-4 py-2 text-xs font-bold text-[var(--rf-text-secondary)] bg-white border border-[var(--rf-border)] hover:bg-[var(--rf-surface-soft)] rounded-lg shadow-sm" whileTap={{ scale: 0.97 }}>Keep Instead</motion.button>
                             <motion.button onClick={() => removeFeatureAt(idx)} className="px-4 py-2 text-xs font-bold text-white bg-[var(--rf-danger)] hover:bg-[var(--rf-danger)] rounded-lg shadow-sm shadow-[var(--rf-danger)]/20" whileTap={{ scale: 0.97 }}>Confirm Removal</motion.button>
                           </div>
                        </div>
                      )}

                      {feature.pendingAddition && (
                        <div className="mb-4 p-4 rounded-xl bg-[var(--rf-success-subtle)] border border-[var(--rf-success-subtle)] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                           <div className="flex items-center gap-2 text-[var(--rf-success)] font-bold text-sm">
                             <Plus className="w-4 h-4" /> Proposed as New Feature
                           </div>
                           <div className="flex items-center gap-2">
                             <motion.button onClick={() => rejectRefinement(idx)} className="px-4 py-2 text-xs font-bold text-[var(--rf-text-secondary)] bg-white border border-[var(--rf-border)] hover:bg-[var(--rf-surface-soft)] rounded-lg shadow-sm" whileTap={{ scale: 0.97 }}>Reject</motion.button>
                             <motion.button onClick={() => acceptRefinement(idx)} className="px-4 py-2 text-xs font-bold text-white bg-[var(--rf-success)] hover:bg-[var(--rf-success)] rounded-lg shadow-sm shadow-[var(--rf-success)]/20" whileTap={{ scale: 0.97 }}>Accept Addition</motion.button>
                           </div>
                        </div>
                      )}

                      {/* Pending refinement diff view */}
                      {(feature.pendingRefinement || feature.pendingAddition || feature.pendingRemoval) && (() => {
                        const isAddedFeature = Boolean(feature.pendingAddition);
                        const isRemovedFeature = Boolean(feature.pendingRemoval);
                        const proposed = isAddedFeature ? feature : feature.pendingRefinement;
                        const origTitle = isAddedFeature ? '' : (feature.title || feature.summary || '');
                        const propTitle = proposed ? (proposed.title || proposed.summary || '') : '';
                        const origDesc = isAddedFeature ? '' : (feature.description || feature.markdown || '');
                        const propDesc = proposed ? (proposed.description || proposed.markdown || '') : '';
                        const arDiffRows = alignAcceptanceRequirementsDetailed(
                          isAddedFeature ? [] : (feature.acceptanceRequirements || []),
                          proposed?.acceptanceRequirements || [],
                        );
                        return (
                          <div className="mb-5 p-4 rounded-2xl bg-[var(--rf-warning-subtle)]/40 border border-[rgba(179,94,48,0.18)]">
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
                              <h4 className="text-[var(--rf-warning)] font-bold text-xs uppercase tracking-widest flex items-center gap-2"><Sparkles className="w-4 h-4" /> {isAddedFeature ? 'AI Suggested New Feature' : isRemovedFeature ? 'AI Suggested Feature Removal' : 'AI Suggested Refinements'}</h4>

                              <div className="flex flex-wrap items-center gap-3">
                                <div className="flex items-center bg-white p-1 rounded-lg border border-[rgba(179,94,48,0.18)] shadow-sm">
                                  <button
                                    onClick={() => setDiffMode('redline')}
                                    className={`px-3 py-1 text-[12px] font-bold rounded-md transition uppercase tracking-wider ${diffMode === 'redline' ? 'bg-[var(--rf-warning-subtle)] text-[var(--rf-warning)]' : 'text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text-secondary)]'}`}
                                  >
                                    Redline
                                  </button>
                                  <button
                                    onClick={() => setDiffMode('blackline')}
                                    className={`px-3 py-1 text-[12px] font-bold rounded-md transition uppercase tracking-wider ${diffMode === 'blackline' ? 'bg-[var(--rf-warning-subtle)] text-[var(--rf-warning)]' : 'text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text-secondary)]'}`}
                                  >
                                    Blackline
                                  </button>
                                </div>

                                <div className="flex items-center gap-2">
                                  <motion.button onClick={() => rejectRefinement(idx)} className="px-3 py-1.5 text-xs font-bold text-[var(--rf-text-secondary)] bg-white border border-[var(--rf-border)] hover:bg-[var(--rf-surface-soft)] rounded-lg shadow-sm" whileTap={{ scale: 0.97 }}>Reject</motion.button>
                                  <motion.button onClick={() => acceptRefinement(idx)} className="px-3 py-1.5 text-xs font-bold text-white bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] rounded-lg flex items-center gap-1.5 shadow-sm shadow-[var(--rf-brand)]/20" whileTap={{ scale: 0.97 }}><Check className="w-3.5 h-3.5" /> Accept</motion.button>
                                </div>
                              </div>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <div className="bg-white p-4 rounded-xl border border-[var(--rf-border)] shadow-sm">
                                <div className="text-[12px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest mb-2">Original</div>
                                {isAddedFeature ? (
                                  <div className="text-xs italic text-[var(--rf-text-tertiary)] mb-4">No original feature. This would be added to the canvas.</div>
                                ) : (
                                  <>
                                    <h4 className="text-sm font-bold text-[var(--rf-text)] mb-2">{origTitle}</h4>
                                    <div className="text-xs text-[var(--rf-text-secondary)] mb-4 whitespace-pre-wrap leading-relaxed">{origDesc}</div>
                                  </>
                                )}
                                <div className="space-y-2">
                                  {(isAddedFeature ? [] : feature.acceptanceRequirements).map((ar, i) => (
                                    <div key={i} className="bg-[var(--rf-surface-soft)] border border-[var(--rf-border-subtle)] p-2.5 rounded-lg text-[13px] text-[var(--rf-text-secondary)]">
                                      {ar.given && <div className="mb-1"><strong className="text-[var(--rf-text)]">Given</strong> {ar.given}</div>}
                                      {ar.when && <div className="mb-1"><strong className="text-[var(--rf-text)]">When</strong> {ar.when}</div>}
                                      <div><strong className="text-[var(--rf-text)]">Then</strong> {ar.then}</div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                              <div className="bg-[var(--rf-brand-muted)]/50 p-4 rounded-xl border border-[var(--rf-brand-subtle)] shadow-sm">
                                <div className="text-[12px] font-bold text-[var(--rf-brand)] uppercase tracking-widest mb-2">{isRemovedFeature ? 'Proposed Removal' : `Proposed (${diffMode === 'redline' ? 'Diff' : 'Result'})`}</div>
                                {isRemovedFeature ? (
                                  <div className="rounded-lg border border-[var(--rf-danger-subtle)] bg-[var(--rf-danger-subtle)] p-3 text-[13px] font-semibold text-[var(--rf-danger)]">
                                    This feature would be removed from the canvas.
                                  </div>
                                ) : (
                                  <>
                                    <h4 className="text-sm font-bold text-[var(--rf-text)] mb-2"><DiffText oldText={origTitle} newText={propTitle} fullHighlight={isAddedFeature} mode={diffMode} /></h4>
                                    <div className="text-xs text-[var(--rf-text-secondary)] mb-4 whitespace-pre-wrap leading-relaxed"><DiffText oldText={origDesc} newText={propDesc} fullHighlight={isAddedFeature} mode={diffMode} /></div>
                                  </>
                                )}
                                <div className="space-y-2">
                                  {arDiffRows.map((row, i) => {
                                    const isNew = row.type === 'added';
                                    const isRemoved = row.type === 'removed';
                                    const ar = row.type !== 'removed' ? row.proposed : row.oldAr;
                                    const oldAr = row.type === 'matched' ? row.oldAr : undefined;
                                    return (
                                      <div key={`${i}-${row.type === 'removed' ? row.oldIndex : row.type === 'added' ? row.newIndex : row.oldIndex}`} className={`p-2.5 rounded-lg text-[13px] border shadow-sm ${isRemoved ? 'bg-[var(--rf-danger-subtle)] border-[var(--rf-danger-subtle)] text-[var(--rf-danger)]' : isNew ? 'bg-[var(--rf-success-subtle)] border-[var(--rf-success-subtle)] text-[var(--rf-text)]' : 'bg-white border-[rgba(43,89,74,0.12)] text-[var(--rf-text)]'}`}>
                                        {isNew && <div className="text-[12px] font-bold text-[var(--rf-success)] uppercase tracking-widest mb-2">New AR</div>}
                                        {isRemoved && <div className="text-[12px] font-bold text-[var(--rf-danger)] uppercase tracking-widest mb-2">Removed AR</div>}
                                        {ar.given && <div className="mb-1"><strong className={isRemoved ? 'text-[var(--rf-danger)]' : 'text-[var(--rf-brand-hover)]'}>Given</strong>{' '}<DiffText oldText={oldAr?.given || ar.given} newText={isRemoved ? '' : ar.given} fullHighlight={isNew || isAddedFeature} mode={diffMode} /></div>}
                                        {ar.when && <div className="mb-1"><strong className={isRemoved ? 'text-[var(--rf-danger)]' : 'text-[var(--rf-brand-hover)]'}>When</strong>{' '}<DiffText oldText={oldAr?.when || ar.when} newText={isRemoved ? '' : ar.when} fullHighlight={isNew || isAddedFeature} mode={diffMode} /></div>}
                                        <div><strong className={isRemoved ? 'text-[var(--rf-danger)]' : 'text-[var(--rf-brand-hover)]'}>Then</strong>{' '}<DiffText oldText={oldAr?.then || ar.then} newText={isRemoved ? '' : ar.then} fullHighlight={isNew || isAddedFeature} mode={diffMode} /></div>
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
                        <div className={`mt-4 ${feature.pendingRefinement ? 'opacity-50 pointer-events-none' : ''}`}>
                          {isEditing ? (
                            <textarea
                              value={draft?.description || ''}
                              onChange={e => setEditDraft(d => d ? { ...d, description: e.target.value } : null)}
                              className="w-full text-[var(--rf-text-secondary)] text-sm bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 min-h-[120px] mb-6 focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none resize-y transition"
                            />
                          ) : (
                            <div className="text-[var(--rf-text-secondary)] text-[13px] sm:text-sm mb-6 whitespace-pre-wrap leading-relaxed border-l-2 border-[var(--rf-brand)]/20 pl-4 py-1">
                              {feature.markdown || feature.description}
                            </div>
                          )}

                          {/* Acceptance Criteria */}
                          {((isEditing && draft?.acceptanceRequirements) || (!isEditing && feature.acceptanceRequirements?.length > 0)) && (
                            <div className="mt-2 text-sm">
                              <div className="flex items-center justify-between mb-4 pb-2">
                                <h4 className="text-[13px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Acceptance Criteria</h4>
                                {isEditing && (
                                  <motion.button onClick={addDraftAr} className="text-xs font-bold text-[var(--rf-brand)] bg-[var(--rf-brand-muted)] hover:bg-[var(--rf-brand-subtle)] px-3 py-1.5 rounded-lg transition flex items-center gap-1.5" whileTap={{ scale: 0.97 }}><Plus className="w-3.5 h-3.5" /> Add AR</motion.button>
                                )}
                              </div>
                              <div className="space-y-2.5">
                                {(isEditing ? draft!.acceptanceRequirements : feature.acceptanceRequirements).map((ar, i) => (
                                  <div key={i} className="bg-[var(--rf-surface-soft)]/50 rounded-xl p-4 border border-[var(--rf-border-subtle)] relative group transition hover:border-[var(--rf-border)]">
                                    {isEditing && (
                                      <button onClick={() => deleteDraftAr(i)} className="absolute top-3 right-3 p-1.5 text-[var(--rf-text-tertiary)] hover:text-[var(--rf-danger)] hover:bg-[var(--rf-danger-subtle)] rounded-lg transition opacity-0 group-hover:opacity-100"><Trash2 className="w-4 h-4" /></button>
                                    )}
                                    {isEditing ? (
                                      <div className="space-y-3 pr-8">
                                        {(['given', 'when', 'then'] as const).map(field => (
                                          <div key={field} className="flex items-start gap-3">
                                            <strong className="text-[var(--rf-text-tertiary)] w-12 pt-2 text-[12px] font-bold uppercase tracking-widest">{field}</strong>
                                            {field === 'then'
                                              ? <textarea value={ar[field]} onChange={e => updateDraftAr(i, field, e.target.value)} rows={2} className="flex-1 bg-white border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] resize-none transition" />
                                              : <input value={ar[field]} onChange={e => updateDraftAr(i, field, e.target.value)} className="flex-1 bg-white border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition" />
                                            }
                                          </div>
                                        ))}
                                      </div>
                                    ) : (
                                      <div className="space-y-1.5 text-[13px] sm:text-sm">
                                        {ar.given?.trim() && (
                                          <div className="flex gap-4">
                                            <div className="w-12 shrink-0 text-[12px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest pt-0.5">Given</div>
                                            <div className="text-[var(--rf-text-secondary)] leading-relaxed font-medium">{ar.given}</div>
                                          </div>
                                        )}
                                        {ar.when?.trim() && (
                                          <div className="flex gap-4">
                                            <div className="w-12 shrink-0 text-[12px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest pt-0.5">When</div>
                                            <div className="text-[var(--rf-text-secondary)] leading-relaxed font-medium">{ar.when}</div>
                                          </div>
                                        )}
                                        <div className="flex gap-4">
                                          <div className="w-12 shrink-0 text-[12px] font-bold text-[var(--rf-brand)] uppercase tracking-widest pt-0.5">Then</div>
                                          <div className="text-[var(--rf-text)] leading-relaxed whitespace-pre-wrap font-medium">{ar.then}</div>
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
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {showBulkRefine && (
          <div className="fixed inset-0 z-[80] flex items-end justify-center p-4 sm:items-center">
            <motion.div
              className="absolute inset-0 bg-[var(--rf-text)]/30 backdrop-blur-sm"
              onClick={!isBulkRefining ? () => setShowBulkRefine(false) : undefined}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            />
            <motion.div
              className="relative rf-card w-full max-w-lg overflow-hidden shadow-[0_24px_80px_-48px_rgba(15,23,42,0.28)]"
              initial={{ opacity: 0, y: 18, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 18, scale: 0.98 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="border-b border-[var(--rf-border-subtle)] bg-[var(--rf-surface-soft)]/50 px-5 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-[var(--rf-brand)]" />
                    <span className="text-sm font-bold text-[var(--rf-text)]">Refine all features</span>
                  </div>
                  {!isBulkRefining && (
                    <button onClick={() => setShowBulkRefine(false)} className="rounded-lg p-1.5 text-[var(--rf-text-tertiary)] transition hover:bg-[var(--rf-surface-soft)]">
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <p className="mt-2 text-[13px] text-[var(--rf-text-tertiary)]">
                  Apply one instruction across every feature in this canvas. Use this when the same refinement should land everywhere.
                </p>
              </div>

              <div className="space-y-4 px-5 py-5">
                <textarea
                  autoFocus
                  placeholder="For example: tighten scope for implementation teams, add regulatory guardrails, or make the ARs more technical."
                  value={bulkInput}
                  onChange={(e) => setBulkInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      handleBulkRefine();
                    }
                  }}
                  className="min-h-[132px] w-full resize-none rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-3 text-sm text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand)]/20"
                />

                <div className="flex items-center justify-between gap-3">
                  <span className="text-[12px] font-medium text-[var(--rf-text-tertiary)]">
                    {isBulkRefining ? (bulkRefineProgress || 'Refining all features…') : 'Cmd/Ctrl + Enter to apply'}
                  </span>
                  <motion.button
                    onClick={handleBulkRefine}
                    disabled={!bulkInput.trim() || isBulkRefining}
                    className="inline-flex items-center gap-2 rounded-lg bg-[var(--rf-brand)] px-5 py-2 text-[13px] font-bold text-white shadow-sm shadow-[var(--rf-brand)]/20 transition hover:bg-[var(--rf-brand-hover)] disabled:opacity-40"
                    whileTap={{ scale: 0.98 }}
                  >
                    {isBulkRefining ? (
                      <>
                        <div className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                        Refining...
                      </>
                    ) : (
                      <>
                        <Send className="h-3.5 w-3.5" />
                        Apply to all
                      </>
                    )}
                  </motion.button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* AI Refine Popup */}
      {refinePopupIdx !== null && (
        <RefinePopup
          feature={features[refinePopupIdx]}
          requirement={requirement}
          sessionId={sessionId}
          onClose={() => setRefinePopupIdx(null)}
          onResult={(refined, tokenUsage) => {
            setFeatures(prev => {
              const n = [...prev];
              n[refinePopupIdx] = { ...n[refinePopupIdx], pendingRefinement: refined };
              return n;
            });
            if (tokenUsage) {
              onWorkflowTokenUsage?.(tokenUsage);
            }
            setRefinePopupIdx(null);
          }}
        />
      )}
    </main>
  );
}
