import React, { useState } from 'react';
import { Send, Sparkles, Edit2, Check, X, Plus, Trash2, Menu, Upload, ChevronDown, Coins, Download, ExternalLink, BrainCircuit, Layers3, FileText, Clock3, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from './hooks/useForge';
import { router } from '@forge/bridge';

// ─── Word-level diff utility ──────────────────────────────────────────────────
type DiffToken = { text: string; type: 'same' | 'added' | 'removed' };
type AcceptanceRequirement = { given: string; when: string; then: string };

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

function alignAcceptanceRequirements(
  original: AcceptanceRequirement[],
  proposed: AcceptanceRequirement[],
): Array<{ proposed: AcceptanceRequirement; oldAr?: AcceptanceRequirement; oldIndex?: number; isNew: boolean }> {
  const rows: Array<{ proposed: AcceptanceRequirement; oldAr?: AcceptanceRequirement; oldIndex?: number; isNew: boolean }> = [];
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
  while (j < n) {
    const advanceOriginalCost = i < m ? gapCost + dp[i + 1][j] : Number.POSITIVE_INFINITY;
    const advanceProposedCost = gapCost + dp[i][j + 1];
    const similarity = i < m ? arSimilarity(original[i], proposed[j]) : 0;
    const matchCost = i < m
      ? (similarity >= matchThreshold ? (1 - similarity) * 0.9 : lowSimilarityPenalty) + dp[i + 1][j + 1]
      : Number.POSITIVE_INFINITY;

    if (i < m && matchCost <= advanceProposedCost && matchCost <= advanceOriginalCost) {
      rows.push({ proposed: proposed[j], oldAr: original[i], oldIndex: i, isNew: false });
      i += 1;
      j += 1;
      continue;
    }

    if (advanceProposedCost <= advanceOriginalCost || i >= m) {
      rows.push({ proposed: proposed[j], isNew: true });
      j += 1;
      continue;
    }

    i += 1;
  }

  return rows;
}

function buildExcerpt(text: string, maxChars = 180): string {
  const compact = (text || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars).trimEnd()}...`;
}

function resolveStoryUrl(story: { key?: string; url?: string; jiraIssueUrl?: string }) {
  if (story.url || story.jiraIssueUrl) return story.url || story.jiraIssueUrl || '';
  if (story.key && /^[A-Z][A-Z0-9]+-\d+$/.test(story.key)) return `/browse/${story.key}`;
  return '';
}

type GenerationProgressMeta = {
  stage?: 'context' | 'triage' | 'decomposition' | 'acceptance_requirements';
  triage?: { shape: string; complexity: string; featureTarget: number; arDepth: string };
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

function buildFeatureExcerpt(text: string, maxChars = 150) {
  const compact = (text || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars).trimEnd()}...`;
}

function getTriageSupportCopy(triage?: GenerationProgressMeta['triage']) {
  if (!triage) return 'Sizing the request so the pipeline knows how much depth to apply.';
  if (triage.complexity === 'high' || triage.complexity === 'very high' || triage.shape === 'broad') {
    return 'This looks like a broader, heavier request, so the system is spending extra time decomposing and tightening the output.';
  }
  if (triage.complexity === 'medium') {
    return 'This looks moderately involved, so the system is balancing speed with a bit more reasoning before it writes the details.';
  }
  return 'This looks fairly contained, so the system should move through decomposition quickly.';
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()),
  );

  return results;
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
        className="absolute inset-0 bg-[var(--rf-text)]/30 backdrop-blur-sm"
        onClick={!loading ? onClose : undefined}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
      />
      <motion.div
        className="relative bg-white w-full max-w-lg rounded-[22px] shadow-2xl flex flex-col overflow-hidden border border-[var(--rf-border)]"
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="px-5 py-4 border-b border-[var(--rf-border-subtle)] flex items-center justify-between bg-[var(--rf-surface-soft)]/50">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[var(--rf-brand)]" />
            <span className="font-bold text-[var(--rf-text)] text-sm">AI Refine</span>
            <span className="text-[var(--rf-text-tertiary)] text-xs ml-1 line-clamp-1 max-w-[200px]">\u2014 {feature.title || feature.summary}</span>
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
                <p className="font-bold text-[var(--rf-text)] text-sm">Refining feature\u2026</p>
                <p className="text-xs text-[var(--rf-text-tertiary)] mt-1">The AI is working on your request</p>
              </div>
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
                className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition resize-none"
                autoFocus
              />
              {error && <p className="text-xs text-[var(--rf-danger)]">{error}</p>}
            </div>
          )}
        </div>

        {!loading && (
          <div className="px-5 py-4 border-t border-[var(--rf-border-subtle)] flex items-center justify-between gap-3 bg-[var(--rf-surface-soft)]/50">
            <span className="text-[11px] font-medium text-[var(--rf-text-tertiary)]">\u2318 + Enter to send</span>
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
  const [showTokenDetails, setShowTokenDetails] = useState(false);
  const [bulkInput, setBulkInput] = useState('');
  const [isBulkRefining, setIsBulkRefining] = useState(false);
  const [lastAiTokenUsage, setLastAiTokenUsage] = useState<{ label: string; input: number; output: number; total: number } | null>(null);
  const liveStageIndex = getGenerationStageIndex(generationProgressMeta ?? null, progress);
  const liveTriage = generationProgressMeta?.triage;
  const liveArProgress = generationProgressMeta?.arProgress;
  const liveDraftFeatures = generationProgressMeta?.draftFeatures ?? [];
  const liveFeatureProgress = generationProgressMeta?.featureProgress ?? [];
  const liveSources = generationProgressMeta?.sources ?? generationContext ?? null;
  const liveArRatio = liveArProgress?.total ? Math.min(1, liveArProgress.completed / liveArProgress.total) : 0;
  const liveFeatureProgressById = new Map(liveFeatureProgress.map(item => [item.id, item.status]));
  const triageSupportCopy = getTriageSupportCopy(liveTriage);

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
      if (n[idx].pendingRefinement) n[idx] = { ...n[idx].pendingRefinement!, pendingRefinement: undefined, pendingRemoval: undefined };
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

  const handleBulkRefine = async () => {
    if (!bulkInput.trim() || isBulkRefining) return;
    setIsBulkRefining(true);

    try {
      const feedback = bulkInput.trim();
      const results = await mapWithConcurrency(features, 2, async (feature) => {
        const res = await api.refineSingleFeature(feature, feedback, requirement, sessionId) as any;
        if (!res.success || !res.feature) {
          throw new Error(res.error || `Refinement failed for "${feature.summary}"`);
        }
        return {
          original: feature,
          refined: res.feature,
          tokenUsage: res.tokenUsage as { input: number; output: number; total: number } | undefined,
        };
      });

      const aggregateUsage = results.reduce((acc, item) => ({
        input: acc.input + (item.tokenUsage?.input ?? 0),
        output: acc.output + (item.tokenUsage?.output ?? 0),
        total: acc.total + (item.tokenUsage?.total ?? 0),
      }), { input: 0, output: 0, total: 0 });

      if (aggregateUsage.total > 0) {
        setLastAiTokenUsage({ label: 'Bulk refine', ...aggregateUsage });
        onWorkflowTokenUsage?.(aggregateUsage);
      }

      setFeatures(prev => prev.map((f, i) => {
        const refined = results[i]?.refined;
        if (!refined) return f;
        return {
          ...f,
          pendingRemoval: false,
          pendingRefinement: {
            ...f,
            ...refined,
            acceptanceRequirements: refined.acceptanceRequirements || f.acceptanceRequirements,
          },
        };
      }));
      setShowBulkRefine(false);
      setBulkInput('');
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
  const renderGeneratingSkeleton = () => (
    <motion.div
      className="w-full max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-10 flex-1 flex items-start justify-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="w-full max-w-5xl overflow-hidden rounded-[30px] border border-[var(--rf-border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(250,247,240,0.96))] shadow-[0_30px_90px_-40px_rgba(15,23,42,0.35)]">
        <div className="relative overflow-hidden border-b border-[var(--rf-border-subtle)] bg-[radial-gradient(circle_at_top,rgba(53,113,95,0.14),transparent_42%),linear-gradient(135deg,rgba(255,255,255,0.95),rgba(244,239,230,0.9))] px-6 sm:px-8 pt-7 sm:pt-8 pb-7">
          <div className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(35,74,61,0.35),transparent)]" />
          <div className="relative flex flex-col gap-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="flex items-start gap-4">
                <div className="flex h-16 w-16 items-center justify-center rounded-[22px] border border-[var(--rf-border)] bg-white shadow-lg shadow-[var(--rf-shadow-sm)]">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,rgba(53,113,95,0.18),rgba(53,113,95,0.05))]">
                    <Sparkles className="h-6 w-6 text-[var(--rf-brand)] animate-pulse" />
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="inline-flex items-center gap-2 rounded-full border border-[rgba(35,74,61,0.14)] bg-white/80 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.24em] text-[var(--rf-brand)] shadow-sm">
                    Live Run
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--rf-brand)] animate-pulse" />
                  </div>
                  <div>
                    <h2 className="text-xl sm:text-2xl font-bold text-[var(--rf-text)] tracking-tight">
                      {loadingTitle || 'Crafting features'}
                    </h2>
                    <p className="mt-1 max-w-2xl text-sm font-medium leading-relaxed text-[var(--rf-text-tertiary)]">
                      {progress || 'Processing your request…'}
                    </p>
                    <p className="mt-2 max-w-2xl text-xs font-medium leading-relaxed text-[var(--rf-text-tertiary)]">
                      {triageSupportCopy}
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2.5 lg:justify-end">
                {liveTriage && (
                  <>
                    <span className="rounded-full border border-[rgba(35,74,61,0.12)] bg-white/80 px-3 py-1.5 text-[11px] font-bold text-[var(--rf-text-secondary)]">
                      {liveTriage.shape} scope
                    </span>
                    <span className="rounded-full border border-[rgba(35,74,61,0.12)] bg-white/80 px-3 py-1.5 text-[11px] font-bold text-[var(--rf-text-secondary)]">
                      {liveTriage.complexity} complexity
                    </span>
                    <span className="rounded-full border border-[rgba(35,74,61,0.12)] bg-white/80 px-3 py-1.5 text-[11px] font-bold text-[var(--rf-text-secondary)]">
                      ~{liveTriage.featureTarget} features
                    </span>
                  </>
                )}
                {canCancelLoading && onCancelLoading && (
                  <motion.button
                    type="button"
                    onClick={onCancelLoading}
                    className="inline-flex items-center gap-2 rounded-xl border border-[var(--rf-border)] bg-white px-4 py-2 text-xs font-bold text-[var(--rf-text-secondary)] shadow-sm transition hover:border-[var(--rf-danger-subtle)] hover:text-[var(--rf-danger)]"
                    whileTap={{ scale: 0.98 }}
                  >
                    <X className="w-3.5 h-3.5" />
                    Stop
                  </motion.button>
                )}
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
              <div className="rounded-[24px] border border-[rgba(35,74,61,0.12)] bg-white/88 p-4 shadow-[0_14px_50px_-36px_rgba(15,23,42,0.25)]">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--rf-text-tertiary)]">
                    Pipeline
                  </div>
                  {liveArProgress?.total ? (
                    <div className="text-[11px] font-semibold text-[var(--rf-text-tertiary)]">
                      {liveArProgress.completed}/{liveArProgress.total} AR passes done
                    </div>
                  ) : (
                    <div className="dot-bounce text-[var(--rf-brand)]"><span /><span /><span /></div>
                  )}
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-4">
                  {GENERATION_STEPS.map((step, index) => {
                    const isDone = index < liveStageIndex;
                    const isCurrent = index === liveStageIndex;
                    return (
                      <div
                        key={step.key}
                        className={`rounded-2xl border px-3.5 py-3 transition-all ${
                          isCurrent
                            ? 'border-[rgba(35,74,61,0.2)] bg-[linear-gradient(135deg,rgba(53,113,95,0.14),rgba(255,255,255,0.92))] shadow-sm'
                            : isDone
                              ? 'border-[rgba(16,185,129,0.18)] bg-[rgba(16,185,129,0.08)]'
                              : 'border-[var(--rf-border)] bg-[var(--rf-surface-soft)]/55'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className={`text-[10px] font-bold uppercase tracking-[0.18em] ${isCurrent || isDone ? 'text-[var(--rf-text)]' : 'text-[var(--rf-text-tertiary)]'}`}>
                            {step.shortLabel}
                          </span>
                          {isDone ? (
                            <CheckCircle2 className="h-4 w-4 text-[var(--rf-success)]" />
                          ) : isCurrent ? (
                            <Clock3 className="h-4 w-4 text-[var(--rf-brand)]" />
                          ) : (
                            <div className="h-2.5 w-2.5 rounded-full border border-[var(--rf-border)] bg-white" />
                          )}
                        </div>
                        <div className="mt-2 text-sm font-semibold leading-snug text-[var(--rf-text)]">
                          {step.label}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-[rgba(35,74,61,0.08)]">
                  <div
                    className="h-full rounded-full bg-[linear-gradient(90deg,rgba(35,74,61,0.72),rgba(53,113,95,0.95),rgba(126,211,158,0.95))] transition-all duration-700"
                    style={{ width: `${liveArProgress?.total ? Math.max(((liveStageIndex + liveArRatio) / GENERATION_STEPS.length) * 100, 8) : ((liveStageIndex + 1) / GENERATION_STEPS.length) * 100}%` }}
                  />
                </div>
              </div>

              <div className="rounded-[24px] border border-[rgba(35,74,61,0.12)] bg-[linear-gradient(135deg,rgba(255,255,255,0.94),rgba(244,239,230,0.92))] p-4 shadow-[0_14px_50px_-36px_rgba(15,23,42,0.25)]">
                <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--rf-text-tertiary)]">
                  Context Signals
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div className="rounded-2xl border border-[rgba(35,74,61,0.12)] bg-white/88 p-3">
                    <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">
                      <Layers3 className="h-4 w-4 text-[var(--rf-brand)]" />
                      Backlog
                    </div>
                    <div className="mt-2 text-2xl font-black tracking-tight text-[var(--rf-text)]">
                      {liveSources?.similarStoriesCount ?? 0}
                    </div>
                    <div className="mt-1 text-xs text-[var(--rf-text-tertiary)]">reference stories</div>
                  </div>
                  <div className="rounded-2xl border border-[rgba(35,74,61,0.12)] bg-white/88 p-3">
                    <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">
                      <FileText className="h-4 w-4 text-[var(--rf-brand)]" />
                      WI Docs
                    </div>
                    <div className="mt-2 text-2xl font-black tracking-tight text-[var(--rf-text)]">
                      {liveSources?.wiDocsCount ?? 0}
                    </div>
                    <div className="mt-1 text-xs text-[var(--rf-text-tertiary)]">docs informing the run</div>
                  </div>
                </div>
                <div className="mt-3 space-y-2">
                  {liveTriage && (
                    <div className="rounded-2xl border border-[rgba(35,74,61,0.12)] bg-white/88 px-3.5 py-3 text-sm font-semibold text-[var(--rf-text)]">
                      Early read: <span className="text-[var(--rf-brand)]">{liveTriage.shape} / {liveTriage.complexity}</span>
                    </div>
                  )}
                  <div className="rounded-2xl border border-[rgba(35,74,61,0.12)] bg-white/88 px-3.5 py-3 text-sm font-semibold text-[var(--rf-text)]">
                    Project scope: <span className="text-[var(--rf-brand)]">{liveSources?.projectKey === '*' ? 'Global workspace' : liveSources?.projectKey || projectKey}</span>
                  </div>
                  <div className="rounded-2xl border border-[rgba(35,74,61,0.12)] bg-white/88 px-3.5 py-3 text-sm font-semibold text-[var(--rf-text)]">
                    Domain guidance: <span className={liveSources?.domainContextApplied ? 'text-[var(--rf-success)]' : 'text-[var(--rf-text-tertiary)]'}>{liveSources?.domainContextApplied ? 'Applied' : 'Not configured'}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-4 px-5 py-5 sm:px-6 sm:py-6 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--rf-text-tertiary)]">
                Draft feature canvas
              </div>
              <div className="text-[11px] font-medium text-[var(--rf-text-tertiary)]">
                {liveDraftFeatures.length > 0 ? `${liveDraftFeatures.length} draft feature${liveDraftFeatures.length !== 1 ? 's' : ''}` : 'Feature shapes appear after decomposition'}
              </div>
            </div>
            {liveDraftFeatures.length > 0 ? (
              liveDraftFeatures.map((feature, i) => (
                <motion.div
                  key={feature.id || `${feature.summary}-${i}`}
                  className="overflow-hidden rounded-[24px] border border-[var(--rf-border)] bg-white shadow-[0_10px_40px_-32px_rgba(15,23,42,0.35)]"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.08, duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                >
                  {(() => {
                    const featureStatus = liveFeatureProgressById.get(feature.id) ?? (liveArProgress?.completed === liveArProgress?.total && liveArProgress?.total ? 'complete' : i === 0 ? 'active' : 'pending');
                    const featureWidth = featureStatus === 'complete' ? '100%' : featureStatus === 'active' ? '62%' : '16%';
                    const featureTone = featureStatus === 'complete'
                      ? 'from-[var(--rf-success)] to-[rgba(58,107,83,0.9)]'
                      : featureStatus === 'active'
                        ? 'from-[rgba(35,74,61,0.55)] to-[rgba(53,113,95,0.95)]'
                        : 'from-[rgba(35,74,61,0.12)] to-[rgba(35,74,61,0.24)]';
                    const featureLabel = featureStatus === 'complete'
                      ? 'Acceptance requirements complete'
                      : featureStatus === 'active'
                        ? 'Writing acceptance requirements'
                        : 'Queued for acceptance requirements';

                    return (
                  <div className="flex">
                    <div className="w-1.5 shrink-0 bg-[linear-gradient(180deg,rgba(53,113,95,0.9),rgba(126,211,158,0.6))]" />
                    <div className="flex-1 p-4 sm:p-5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-base font-bold leading-snug text-[var(--rf-text)]">{feature.summary}</div>
                          <div className="mt-2 text-sm leading-relaxed text-[var(--rf-text-secondary)]">
                            {buildFeatureExcerpt(feature.description, 160)}
                          </div>
                        </div>
                        <div className="shrink-0 rounded-full border border-[rgba(35,74,61,0.12)] bg-[var(--rf-surface-soft)] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--rf-text-secondary)]">
                          {feature.storyPoints ? `${feature.storyPoints} pts` : 'draft'}
                        </div>
                      </div>
                      <div className="mt-4 rounded-2xl border border-dashed border-[rgba(35,74,61,0.18)] bg-[rgba(35,74,61,0.03)] px-3.5 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">
                          <BrainCircuit className="h-4 w-4 text-[var(--rf-brand)]" />
                            {featureLabel}
                          </div>
                          <div className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] ${
                            featureStatus === 'complete'
                              ? 'bg-[var(--rf-success-subtle)] text-[var(--rf-success)]'
                              : featureStatus === 'active'
                                ? 'bg-[var(--rf-brand-muted)] text-[var(--rf-brand)]'
                                : 'bg-[var(--rf-surface-soft)] text-[var(--rf-text-tertiary)]'
                          }`}>
                            {featureStatus}
                          </div>
                        </div>
                        <div className="mt-2 h-2 overflow-hidden rounded-full bg-[rgba(35,74,61,0.08)]">
                          <div
                            className={`h-full rounded-full bg-gradient-to-r ${featureTone} transition-all duration-700 ${featureStatus === 'active' ? 'animate-pulse' : ''}`}
                            style={{ width: featureWidth }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                    );
                  })()}
                </motion.div>
              ))
            ) : (
              [1, 2, 3].map(i => (
                <motion.div
                  key={i}
                  className="overflow-hidden rounded-[24px] border border-[var(--rf-border)] bg-white"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.08, duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                >
                  <div className="flex">
                    <div className="w-1.5 shrink-0 bg-[var(--rf-surface-soft)]" />
                    <div className="flex-1 p-5 space-y-3.5">
                      <div className="shimmer h-5 w-2/5 rounded-md" />
                      <div className="shimmer h-4 w-full rounded-md" />
                      <div className="shimmer h-4 w-4/5 rounded-md" />
                    </div>
                  </div>
                </motion.div>
              ))
            )}
          </div>

          <div className="space-y-4">
            <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--rf-text-tertiary)]">
              Source highlights
            </div>
            <div className="rounded-[24px] border border-[var(--rf-border)] bg-white p-4 shadow-[0_10px_40px_-32px_rgba(15,23,42,0.35)]">
              <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Reference stories</div>
              {(liveSources?.referencedSimilarStories?.length ?? 0) > 0 ? (
                <div className="mt-3 space-y-2.5">
                  {liveSources!.referencedSimilarStories!.slice(0, 3).map((story, index) => {
                    const storyUrl = resolveStoryUrl(story);
                    return (
                      <div key={`${story.key}-${index}`} className="rounded-2xl border border-[rgba(35,74,61,0.1)] bg-[linear-gradient(135deg,rgba(35,74,61,0.04),rgba(255,255,255,0.9))] p-3">
                        <div className="flex items-start justify-between gap-3">
                          {storyUrl ? (
                            <button type="button" onClick={() => void router.navigate(storyUrl)} className="inline-flex items-center gap-1.5 text-left text-xs font-bold text-[var(--rf-brand-hover)] hover:text-[var(--rf-brand)] transition">
                              {story.key}
                              <ExternalLink className="h-3 w-3" />
                            </button>
                          ) : (
                            <div className="text-xs font-bold text-[var(--rf-text)]">{story.key}</div>
                          )}
                          {typeof story.relevanceScore === 'number' && (
                            <span className="rounded-full bg-white px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--rf-text-tertiary)] border border-[var(--rf-border)]">
                              {(story.relevanceScore * 100).toFixed(0)}%
                            </span>
                          )}
                        </div>
                        <div className="mt-2 text-xs leading-relaxed text-[var(--rf-text-secondary)]">
                          {buildExcerpt(story.summary, 140)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="mt-3 text-xs italic text-[var(--rf-text-tertiary)]">No backlog references loaded yet.</div>
              )}
            </div>

            <div className="rounded-[24px] border border-[var(--rf-border)] bg-white p-4 shadow-[0_10px_40px_-32px_rgba(15,23,42,0.35)]">
              <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Work instruction snippets</div>
              {(liveSources?.referencedWiSections?.length ?? 0) > 0 ? (
                <div className="mt-3 space-y-2.5">
                  {liveSources!.referencedWiSections!.slice(0, 3).map((section, index) => (
                    <div key={`${section.docId}-${section.chunkIndex}-${index}`} className="rounded-2xl border border-[rgba(35,74,61,0.1)] bg-[linear-gradient(135deg,rgba(35,74,61,0.04),rgba(255,255,255,0.9))] p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 text-[11px] font-bold text-[var(--rf-text)] truncate">{section.filename}</div>
                        <span className="rounded-full bg-white px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--rf-text-tertiary)] border border-[var(--rf-border)]">
                          S{section.chunkIndex + 1}
                        </span>
                      </div>
                      <div className="mt-2 text-xs leading-relaxed text-[var(--rf-text-secondary)]">
                        {buildExcerpt(section.excerpt, 135)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-3 text-xs italic text-[var(--rf-text-tertiary)]">No WI snippets matched yet.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );

  return (
    <main className="flex-1 flex flex-col h-full relative overflow-hidden bg-transparent">
      {/* Header */}
      <motion.header
        className="shrink-0 bg-white/80 backdrop-blur-md px-6 py-4 z-20 sticky top-0 border-b border-[var(--rf-border)] shadow-sm"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="flex min-h-[48px] w-full items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
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
            <div className="min-w-0 flex items-center gap-3">
              <h2 className="text-lg font-bold text-[var(--rf-text)] tracking-tight">Feature Canvas</h2>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--rf-surface-soft)] px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--rf-text-secondary)] border border-[var(--rf-border)]">
                <span className="text-[var(--rf-text-tertiary)]">Scope</span>
                <span className="text-[var(--rf-text-secondary)]">
                  {projectKey === '*' ? 'Global Workspace' : projectKey}
                </span>
              </span>
            </div>
          </div>
          <div className="relative shrink-0">
            <motion.button
              type="button"
              onClick={() => setShowTokenDetails(prev => !prev)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--rf-surface-soft)] hover:bg-[var(--rf-surface-soft)] px-3 py-2 text-xs font-semibold text-[var(--rf-text-secondary)] transition-colors border border-[var(--rf-border)] shadow-sm"
              title="Workflow token usage"
              whileTap={{ scale: 0.97 }}
            >
              <Coins className="w-4 h-4 text-[var(--rf-text-tertiary)]" />
              Tokens
            </motion.button>
            <AnimatePresence>
              {showTokenDetails && (
                <motion.div
                  className="absolute right-0 top-full mt-3 w-[260px] rounded-2xl border border-[var(--rf-border)] bg-white p-4 shadow-xl z-50"
                  initial={{ opacity: 0, y: -8, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -8, scale: 0.96 }}
                  transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                >
                  <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Workflow tokens</div>
                  <div className="mt-1.5 text-2xl font-black text-[var(--rf-text)] tracking-tight">
                    {(workflowTokenUsage?.total ?? 0).toLocaleString()}
                  </div>
                  <div className="mt-1 text-xs font-medium text-[var(--rf-text-tertiary)]">
                    {(workflowTokenUsage?.input ?? 0).toLocaleString()} in / {(workflowTokenUsage?.output ?? 0).toLocaleString()} out
                  </div>
                  <div className="mt-3 pt-3 border-t border-[var(--rf-border-subtle)] text-[11px] text-[var(--rf-text-tertiary)] leading-relaxed">
                    Includes clarify, generation, and all iterative refinements.
                  </div>
                  {lastAiTokenUsage && (
                    <div className="mt-2 text-[11px] font-medium text-[var(--rf-text-tertiary)] bg-[var(--rf-surface-soft)] rounded-lg p-2 border border-[var(--rf-border-subtle)]">
                      Last: {lastAiTokenUsage.label} ({lastAiTokenUsage.total.toLocaleString()})
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {hasFeatures && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-[var(--rf-border)] pt-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center rounded-lg bg-[var(--rf-text)] text-white px-3.5 py-1.5 text-xs font-bold shadow-sm">
                  {features.length} Features
                  <span className="mx-2 opacity-40">·</span>
                  {totalArCount} ARs
              </span>
              <span className="text-xs font-semibold text-[var(--rf-text-tertiary)] whitespace-nowrap bg-[var(--rf-surface-soft)] px-3 py-1.5 rounded-lg border border-[var(--rf-border)]">
                <span className="text-[var(--rf-success)] mr-1.5">{features.filter(f => f.isAccepted).length}</span> accepted
              </span>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2.5">
              {features.some(f => f.pendingRefinement) && (
                <>
                  <motion.button onClick={discardAllProposed} className="px-3 py-1.5 text-xs font-bold text-[var(--rf-text-secondary)] bg-white border border-[var(--rf-border)] rounded-lg hover:text-[var(--rf-danger)] hover:border-[var(--rf-danger-subtle)] transition shadow-sm" whileTap={{ scale: 0.97 }}>Discard All</motion.button>
                  <motion.button onClick={acceptAllProposed} className="px-3 py-1.5 bg-[var(--rf-success)] hover:bg-[var(--rf-success)] text-white text-xs font-bold rounded-lg transition shadow-sm shadow-[var(--rf-success)]/20" whileTap={{ scale: 0.97 }}>Accept All</motion.button>
                </>
              )}

              <motion.button
                onClick={exportFeaturesToExcel}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--rf-border)] bg-white text-xs font-bold text-[var(--rf-text-secondary)] transition hover:border-[var(--rf-brand-subtle)] hover:text-[var(--rf-brand)] shadow-sm"
                whileTap={{ scale: 0.97 }}
                title="Export features and acceptance requirements to Excel"
              >
                <Download className="w-4 h-4" />
                Export
              </motion.button>

              <div className="relative">
                <motion.button
                  onClick={() => setShowBulkRefine(!showBulkRefine)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-bold transition shadow-sm ${showBulkRefine ? 'bg-[var(--rf-text)] text-white border-[var(--rf-text)]' : 'bg-white text-[var(--rf-text-secondary)] border-[var(--rf-border)] hover:border-[var(--rf-brand-subtle)] hover:text-[var(--rf-brand)]'}`}
                  whileTap={{ scale: 0.97 }}
                >
                  <Sparkles className="w-4 h-4" />
                  Refine All
                </motion.button>

                <AnimatePresence>
                  {showBulkRefine && (
                    <motion.div
                      className="absolute right-0 top-full mt-3 w-[400px] bg-white rounded-2xl border border-[var(--rf-border)] p-5 z-50 shadow-2xl"
                      initial={{ opacity: 0, y: -8, scale: 0.96 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -8, scale: 0.96 }}
                      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                    >
                      <div className="flex items-center justify-between mb-4">
                        <h4 className="text-xs font-bold text-[var(--rf-text)] uppercase tracking-widest flex items-center gap-2">
                           <Sparkles className="w-4 h-4 text-[var(--rf-brand)]" /> Bulk Refine
                        </h4>
                        <button onClick={() => setShowBulkRefine(false)} className="p-1 hover:bg-[var(--rf-surface-soft)] rounded-lg transition text-[var(--rf-text-tertiary)]"><X className="w-4 h-4" /></button>
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
                        className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl p-4 text-sm min-h-[120px] outline-none focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition resize-none mb-4"
                      />
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[11px] font-medium text-[var(--rf-text-tertiary)]">\u2318 + Enter to apply</span>
                        <motion.button
                          onClick={handleBulkRefine}
                          disabled={!bulkInput.trim() || isBulkRefining}
                          className="px-5 py-2 bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] text-white text-xs font-bold rounded-lg transition disabled:opacity-40 flex items-center gap-2 shadow-sm shadow-[var(--rf-brand)]/20"
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
      <div className="flex-1 overflow-y-auto w-full flex flex-col items-center relative custom-scrollbar p-6">
        {isGenerating ? (
          renderGeneratingSkeleton()
        ) : !hasFeatures ? (
          <motion.div
            className="flex-1 flex flex-col items-center justify-center text-center max-w-md mx-auto"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="levitate w-16 h-16 rounded-2xl flex items-center justify-center mb-6 bg-white shadow-xl shadow-[var(--rf-shadow-sm)] border border-[var(--rf-border)]">
              <Sparkles className="w-7 h-7 text-[var(--rf-brand)]" />
            </div>
            <h2 className="text-2xl font-bold text-[var(--rf-text)] mb-3 tracking-tight">Ready to generate</h2>
            <p className="text-[var(--rf-text-tertiary)] text-sm leading-relaxed font-medium">Describe your requirement in the sidebar, answer the clarifying questions, and your polished features will appear here.</p>
          </motion.div>
        ) : (
          <motion.div
            className="w-full max-w-[900px] mx-auto space-y-5 pb-12"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          >
            {generationContext && (
              <motion.div
                className="overflow-hidden rounded-[28px] border border-[var(--rf-border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.97),rgba(248,244,236,0.94))] shadow-[0_24px_80px_-48px_rgba(15,23,42,0.28)]"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="border-b border-[var(--rf-border-subtle)] bg-[radial-gradient(circle_at_top,rgba(53,113,95,0.12),transparent_40%),linear-gradient(135deg,rgba(255,255,255,0.96),rgba(244,239,230,0.88))] px-5 py-5 sm:px-6">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-[0.24em] text-[var(--rf-brand)]">Source stack</div>
                      <div className="mt-1 text-lg font-bold tracking-tight text-[var(--rf-text)]">What informed this canvas</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowContextDetails(prev => !prev)}
                      className="inline-flex items-center gap-1.5 self-start rounded-xl border border-[rgba(35,74,61,0.12)] bg-white/85 px-3.5 py-2 text-xs font-bold text-[var(--rf-brand)] shadow-sm transition hover:text-[var(--rf-brand-hover)]"
                    >
                      <ChevronDown className={`w-4 h-4 transition-transform ${showContextDetails ? 'rotate-180' : ''}`} />
                      {showContextDetails ? 'Hide sources' : 'Show sources'}
                    </button>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-4">
                    <div className="rounded-2xl border border-[rgba(35,74,61,0.1)] bg-white/82 px-4 py-3">
                      <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Project</div>
                      <div className="mt-1.5 text-lg font-black tracking-tight text-[var(--rf-text)]">{generationContext.projectKey === '*' ? 'Global' : generationContext.projectKey}</div>
                    </div>
                    <div className="rounded-2xl border border-[rgba(35,74,61,0.1)] bg-white/82 px-4 py-3">
                      <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Backlog refs</div>
                      <div className="mt-1.5 text-lg font-black tracking-tight text-[var(--rf-text)]">{generationContext.similarStoriesCount ?? 0}</div>
                    </div>
                    <div className="rounded-2xl border border-[rgba(35,74,61,0.1)] bg-white/82 px-4 py-3">
                      <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">WI sections</div>
                      <div className="mt-1.5 text-lg font-black tracking-tight text-[var(--rf-text)]">{generationContext.referencedWiSections?.length ?? 0}</div>
                    </div>
                    <div className="rounded-2xl border border-[rgba(35,74,61,0.1)] bg-white/82 px-4 py-3">
                      <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Guidance</div>
                      <div className="mt-1.5 text-lg font-black tracking-tight text-[var(--rf-text)]">{generationContext.domainContextApplied ? 'On' : 'Off'}</div>
                    </div>
                  </div>
                </div>
                <AnimatePresence initial={false}>
                  {showContextDetails && (
                    <motion.div
                      className="space-y-4 px-5 py-5 sm:px-6"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                    >
                      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                        <div className="rounded-[24px] border border-[rgba(35,74,61,0.12)] bg-white p-4 shadow-[0_12px_40px_-34px_rgba(15,23,42,0.28)]">
                          <div className="flex items-center justify-between gap-3 mb-3">
                            <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--rf-text-tertiary)]">Similar backlog stories</div>
                            <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--rf-text-tertiary)] bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-full px-2.5 py-1">
                              {generationContext.referencedSimilarStories?.length || 0}
                            </div>
                          </div>
                          {(generationContext.referencedSimilarStories?.length ?? 0) > 0 ? (
                            <div className="space-y-2.5">
                              {generationContext.referencedSimilarStories!.slice(0, 4).map((story, i) => {
                                const storyUrl = resolveStoryUrl(story);
                                return (
                                  <div key={`${story.key}-${i}`} className="rounded-2xl border border-[rgba(35,74,61,0.1)] bg-[linear-gradient(135deg,rgba(35,74,61,0.04),rgba(255,255,255,0.92))] p-3">
                                    <div className="flex items-start justify-between gap-3">
                                      {storyUrl ? (
                                        <button
                                          type="button"
                                          onClick={() => void router.navigate(storyUrl)}
                                          className="inline-flex items-center gap-1.5 text-left text-xs font-bold text-[var(--rf-brand-hover)] hover:text-[var(--rf-brand)] transition"
                                          title="Open referenced story"
                                        >
                                          {story.key}
                                          <ExternalLink className="w-3 h-3" />
                                        </button>
                                      ) : (
                                        <div className="text-xs font-bold text-[var(--rf-text)]">{story.key}</div>
                                      )}
                                      {typeof story.relevanceScore === 'number' && (
                                        <div className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-[var(--rf-text-tertiary)] bg-white border border-[var(--rf-border)] rounded-full px-2 py-1">
                                          {(story.relevanceScore * 100).toFixed(0)}% match
                                        </div>
                                      )}
                                    </div>
                                    <div className="mt-2 text-xs text-[var(--rf-text-secondary)] leading-relaxed">
                                      {buildExcerpt(story.summary, 160)}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="text-xs italic text-[var(--rf-text-tertiary)]">No similar stories were available.</div>
                          )}
                        </div>

                        <div className="rounded-[24px] border border-[rgba(35,74,61,0.12)] bg-white p-4 shadow-[0_12px_40px_-34px_rgba(15,23,42,0.28)]">
                          <div className="flex items-center justify-between gap-3 mb-3">
                            <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--rf-text-tertiary)]">Matched WI sections</div>
                            <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--rf-text-tertiary)] bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-full px-2.5 py-1">
                              {generationContext.referencedWiSections?.length || 0}
                            </div>
                          </div>
                          {(generationContext.referencedWiSections?.length ?? 0) > 0 ? (
                            <div className="space-y-2.5">
                              {generationContext.referencedWiSections!.map((section, i) => (
                                <div key={`${section.docId}-${section.chunkIndex}-${i}`} className="rounded-2xl border border-[rgba(35,74,61,0.1)] bg-[linear-gradient(135deg,rgba(35,74,61,0.04),rgba(255,255,255,0.92))] p-3">
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="text-[11px] font-bold text-[var(--rf-text)] truncate">{section.filename}</div>
                                      <div className="mt-1 inline-flex items-center rounded-full border border-[var(--rf-border-subtle)] bg-white px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">
                                        Section {section.chunkIndex + 1}
                                      </div>
                                    </div>
                                  </div>
                                  <div className="mt-2 text-xs text-[var(--rf-text-secondary)] leading-relaxed">
                                    {section.excerpt}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="text-xs italic text-[var(--rf-text-tertiary)]">No matched WI sections were used.</div>
                          )}
                        </div>

                        <div className="rounded-[24px] border border-[rgba(35,74,61,0.12)] bg-white p-4 shadow-[0_12px_40px_-34px_rgba(15,23,42,0.28)]">
                          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--rf-text-tertiary)]">Run profile</div>
                          <div className="mt-3 space-y-2.5">
                            <div className="rounded-2xl border border-[rgba(35,74,61,0.1)] bg-[linear-gradient(135deg,rgba(35,74,61,0.04),rgba(255,255,255,0.92))] p-3">
                              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--rf-text-tertiary)]">Attachment context</div>
                              <div className="mt-1.5 text-sm font-semibold text-[var(--rf-text)]">{generationContext.attachmentIncluded ? 'Included in reasoning' : 'No attachment used'}</div>
                            </div>
                            <div className="rounded-2xl border border-[rgba(35,74,61,0.1)] bg-[linear-gradient(135deg,rgba(35,74,61,0.04),rgba(255,255,255,0.92))] p-3">
                              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--rf-text-tertiary)]">Work instruction docs</div>
                              <div className="mt-1.5 text-sm font-semibold text-[var(--rf-text)]">{generationContext.wiDocsCount ?? 0} document{(generationContext.wiDocsCount ?? 0) !== 1 ? 's' : ''} scanned</div>
                            </div>
                            <div className="rounded-2xl border border-[rgba(35,74,61,0.1)] bg-[linear-gradient(135deg,rgba(35,74,61,0.04),rgba(255,255,255,0.92))] p-3">
                              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--rf-text-tertiary)]">Token usage</div>
                              <div className="mt-1.5 text-sm font-semibold text-[var(--rf-text)]">{(generationContext.tokenUsage?.total ?? 0).toLocaleString()} tokens total</div>
                              <div className="mt-1 text-[11px] text-[var(--rf-text-tertiary)]">
                                {(generationContext.tokenUsage?.input ?? 0).toLocaleString()} in / {(generationContext.tokenUsage?.output ?? 0).toLocaleString()} out
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
                  className={`group overflow-hidden rounded-2xl border bg-white ${feature.pendingRemoval ? 'opacity-70 border-[var(--rf-danger-subtle)]' : feature.isAccepted ? 'border-[var(--rf-success-subtle)]' : 'border-[var(--rf-border)]'}`}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.05, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                  style={{ boxShadow: feature.isAccepted ? '0 4px 20px -4px rgba(16,185,129,0.15)' : feature.pendingRemoval ? '0 4px 20px -4px rgba(244,63,94,0.15)' : '0 4px 12px -4px rgba(15,23,42,0.05)' }}
                  whileHover={{ y: -2, boxShadow: feature.isAccepted ? '0 8px 30px -4px rgba(16,185,129,0.2)' : '0 8px 24px -4px rgba(15,23,42,0.08)' }}
                >
                  <div className="flex flex-col sm:flex-row">
                    {/* Left Accent Strip */}
                    <div className={`h-1.5 sm:h-auto sm:w-2 shrink-0 ${feature.pendingRemoval ? 'bg-[var(--rf-danger-subtle)]' : feature.isAccepted ? 'bg-[var(--rf-success-subtle)]' : 'bg-[var(--rf-brand-muted)]'}`} />

                    <div className="flex-1 p-5 sm:p-6">
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
                              <span className="inline-flex min-w-[54px] justify-center items-center rounded-lg px-2.5 py-1 bg-[var(--rf-surface-soft)] text-[var(--rf-text-secondary)] text-[10px] font-bold tracking-widest border border-[var(--rf-border)]">
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
                              <motion.button onClick={() => startEditing(idx)} className="px-2.5 py-1.5 text-[11px] font-bold text-[var(--rf-text-tertiary)] hover:bg-[var(--rf-surface-soft)] hover:text-[var(--rf-text)] rounded-lg transition flex items-center gap-1.5" whileTap={{ scale: 0.97 }}><Edit2 className="w-3.5 h-3.5" /> Edit</motion.button>
                              <motion.button onClick={() => setRefinePopupIdx(idx)} className="px-2.5 py-1.5 text-[11px] font-bold text-[var(--rf-brand)] hover:bg-[var(--rf-brand-muted)] rounded-lg transition flex items-center gap-1.5" whileTap={{ scale: 0.97 }}><Sparkles className="w-3.5 h-3.5" /> Refine</motion.button>
                              <motion.button onClick={() => toggleAccepted(idx)} className={`px-3 py-1.5 text-[11px] font-bold rounded-lg transition border flex items-center gap-1.5 shadow-sm ${feature.isAccepted ? 'text-[var(--rf-success)] bg-[var(--rf-success-subtle)] border-[var(--rf-success-subtle)]' : 'text-[var(--rf-text-secondary)] bg-white border-[var(--rf-border)] hover:bg-[var(--rf-success-subtle)] hover:text-[var(--rf-success)] hover:border-[var(--rf-success-subtle)]'}`} whileTap={{ scale: 0.97 }}>
                                <Check className="w-3.5 h-3.5" /> {feature.isAccepted ? 'Accepted' : 'Accept'}
                              </motion.button>
                              <motion.button onClick={() => requestFeatureRemoval(idx)} className="px-2.5 py-1.5 text-[11px] font-bold text-[var(--rf-danger)] hover:bg-[var(--rf-danger-subtle)] rounded-lg transition flex items-center gap-1.5" whileTap={{ scale: 0.97 }}><Trash2 className="w-3.5 h-3.5" /> Delete</motion.button>
                              {feature.jiraIssueKey ? (
                                <div className="flex items-center gap-1">
                                  <motion.button
                                    onClick={() => feature.jiraIssueUrl ? router.navigate(feature.jiraIssueUrl) : null}
                                    className="px-3 py-1.5 text-[11px] font-bold text-[var(--rf-brand-hover)] bg-[var(--rf-brand-muted)] border border-[var(--rf-brand-subtle)] rounded-lg transition flex items-center gap-1.5 hover:bg-[var(--rf-brand-subtle)] shadow-sm"
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
                                  className="px-3 py-1.5 text-[11px] font-bold text-white bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] disabled:bg-[var(--rf-border-strong)] disabled:text-[var(--rf-text-tertiary)] rounded-lg transition flex items-center gap-1.5 shadow-sm shadow-[var(--rf-brand)]/20"
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
                          <div className="mb-5 p-4 rounded-2xl bg-[var(--rf-warning-subtle)]/40 border border-[rgba(179,94,48,0.18)]">
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
                              <h4 className="text-[var(--rf-warning)] font-bold text-xs uppercase tracking-widest flex items-center gap-2"><Sparkles className="w-4 h-4" /> AI Suggested Refinements</h4>

                              <div className="flex flex-wrap items-center gap-3">
                                <div className="flex items-center bg-white p-1 rounded-lg border border-[rgba(179,94,48,0.18)] shadow-sm">
                                  <button
                                    onClick={() => setDiffMode('redline')}
                                    className={`px-3 py-1 text-[10px] font-bold rounded-md transition uppercase tracking-wider ${diffMode === 'redline' ? 'bg-[var(--rf-warning-subtle)] text-[var(--rf-warning)]' : 'text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text-secondary)]'}`}
                                  >
                                    Redline
                                  </button>
                                  <button
                                    onClick={() => setDiffMode('blackline')}
                                    className={`px-3 py-1 text-[10px] font-bold rounded-md transition uppercase tracking-wider ${diffMode === 'blackline' ? 'bg-[var(--rf-warning-subtle)] text-[var(--rf-warning)]' : 'text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text-secondary)]'}`}
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
                                <div className="text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest mb-2">Original</div>
                                <h4 className="text-sm font-bold text-[var(--rf-text)] mb-2">{origTitle}</h4>
                                <div className="text-xs text-[var(--rf-text-secondary)] mb-4 whitespace-pre-wrap leading-relaxed">{origDesc}</div>
                                <div className="space-y-2">
                                  {feature.acceptanceRequirements.map((ar, i) => (
                                    <div key={i} className="bg-[var(--rf-surface-soft)] border border-[var(--rf-border-subtle)] p-2.5 rounded-lg text-[11px] text-[var(--rf-text-secondary)]">
                                      {ar.given && <div className="mb-1"><strong className="text-[var(--rf-text)]">Given</strong> {ar.given}</div>}
                                      {ar.when && <div className="mb-1"><strong className="text-[var(--rf-text)]">When</strong> {ar.when}</div>}
                                      <div><strong className="text-[var(--rf-text)]">Then</strong> {ar.then}</div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                              <div className="bg-[var(--rf-brand-muted)]/50 p-4 rounded-xl border border-[var(--rf-brand-subtle)] shadow-sm">
                                <div className="text-[10px] font-bold text-[var(--rf-brand)] uppercase tracking-widest mb-2">Proposed ({diffMode === 'redline' ? 'Diff' : 'Result'})</div>
                                <h4 className="text-sm font-bold text-[var(--rf-text)] mb-2"><DiffText oldText={origTitle} newText={propTitle} mode={diffMode} /></h4>
                                <div className="text-xs text-[var(--rf-text-secondary)] mb-4 whitespace-pre-wrap leading-relaxed"><DiffText oldText={origDesc} newText={propDesc} mode={diffMode} /></div>
                                <div className="space-y-2">
                                  {arDiffRows.map((row, i) => {
                                    const ar = row.proposed;
                                    const oldAr = row.oldAr;
                                    const isNew = row.isNew;
                                    return (
                                      <div key={`${i}-${row.oldIndex ?? 'new'}`} className={`p-2.5 rounded-lg text-[11px] text-[var(--rf-text)] border shadow-sm ${isNew ? 'bg-[var(--rf-success-subtle)] border-[var(--rf-success-subtle)]' : 'bg-white border-[rgba(43,89,74,0.12)]'}`}>
                                        {isNew && <div className="text-[10px] font-bold text-[var(--rf-success)] uppercase tracking-widest mb-2">New AR</div>}
                                        {ar.given && <div className="mb-1"><strong className="text-[var(--rf-brand-hover)]">Given</strong>{' '}<DiffText oldText={oldAr?.given || ''} newText={ar.given} fullHighlight={isNew} mode={diffMode} /></div>}
                                        {ar.when && <div className="mb-1"><strong className="text-[var(--rf-brand-hover)]">When</strong>{' '}<DiffText oldText={oldAr?.when || ''} newText={ar.when} fullHighlight={isNew} mode={diffMode} /></div>}
                                        <div><strong className="text-[var(--rf-brand-hover)]">Then</strong>{' '}<DiffText oldText={oldAr?.then || ''} newText={ar.then} fullHighlight={isNew} mode={diffMode} /></div>
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
                                <h4 className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Acceptance Criteria</h4>
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
                                            <strong className="text-[var(--rf-text-tertiary)] w-12 pt-2 text-[10px] font-bold uppercase tracking-widest">{field}</strong>
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
                                            <div className="w-12 shrink-0 text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest pt-0.5">Given</div>
                                            <div className="text-[var(--rf-text-secondary)] leading-relaxed font-medium">{ar.given}</div>
                                          </div>
                                        )}
                                        {ar.when?.trim() && (
                                          <div className="flex gap-4">
                                            <div className="w-12 shrink-0 text-[10px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest pt-0.5">When</div>
                                            <div className="text-[var(--rf-text-secondary)] leading-relaxed font-medium">{ar.when}</div>
                                          </div>
                                        )}
                                        <div className="flex gap-4">
                                          <div className="w-12 shrink-0 text-[10px] font-bold text-[var(--rf-brand)] uppercase tracking-widest pt-0.5">Then</div>
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
      </div>

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
