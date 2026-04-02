import React, { useState } from 'react';
import { Send, Sparkles, Edit2, Check, X, Plus, Trash2, Menu, Upload, ChevronDown, Coins, Download, AlertCircle, FileText, ExternalLink } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from './hooks/useForge';
import { router } from '@forge/bridge';

// ─── Word-level diff utility ──────────────────────────────────────────────────
type DiffToken = { text: string; type: 'same' | 'added' | 'removed' };
type AcceptanceRequirement = { given: string; when: string; then: string };

function tokenizeDiffText(text: string): string[] {
  return text.match(/\w+|\s+|[^\s\w]+/g) || [];
}

function appendDiffToken(tokens: DiffToken[], next: DiffToken) {
  const previous = tokens[tokens.length - 1];
  if (previous && previous.type === next.type) {
    previous.text += next.text;
    return;
  }
  tokens.push(next);
}

function wordDiff(oldText: string, newText: string): DiffToken[] {
  const oldWords = tokenizeDiffText(oldText || '');
  const newWords = tokenizeDiffText(newText || '');
  const m = oldWords.length, n = newWords.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = oldWords[i] === newWords[j] ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
  const tokens: DiffToken[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (oldWords[i] === newWords[j]) { appendDiffToken(tokens, { text: newWords[j], type: 'same' }); i++; j++; }
    else if (dp[i+1][j] >= dp[i][j+1]) { appendDiffToken(tokens, { text: oldWords[i], type: 'removed' }); i++; }
    else { appendDiffToken(tokens, { text: newWords[j], type: 'added' }); j++; }
  }
  while (i < m) appendDiffToken(tokens, { text: oldWords[i++], type: 'removed' });
  while (j < n) appendDiffToken(tokens, { text: newWords[j++], type: 'added' });
  return tokens;
}

function DiffText({ oldText, newText, fullHighlight = false, mode = 'redline' }: { oldText: string; newText: string; fullHighlight?: boolean; mode?: 'redline' | 'blackline' }) {
  if (mode === 'blackline') return <span>{newText}</span>;
  if (fullHighlight) return <span className="bg-emerald-100 text-emerald-900 rounded px-0.5">{newText}</span>;
  const tokens = wordDiff(oldText, newText);
  return (
    <span>
      {tokens.map((tok, i) => {
        if (tok.type === 'same') return <span key={i}>{tok.text}</span>;
        if (tok.type === 'added') return <mark key={i} className="bg-blue-100 text-blue-900 rounded px-0.5 not-italic">{tok.text}</mark>;
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

function clauseSimilarity(left: string, right: string): number {
  const normalisedLeft = normaliseWhitespace(left);
  const normalisedRight = normaliseWhitespace(right);
  if (!normalisedLeft && !normalisedRight) return 1;
  if (!normalisedLeft || !normalisedRight) return 0;
  if (normalisedLeft === normalisedRight) return 1;
  return jaccard(tokenSet(left), tokenSet(right));
}

function arSimilarity(left: AcceptanceRequirement, right: AcceptanceRequirement): number {
  const leftText = `${left.given} ${left.when} ${left.then}`.trim();
  const rightText = `${right.given} ${right.when} ${right.then}`.trim();
  const exact = normaliseWhitespace(leftText) === normaliseWhitespace(rightText);
  if (exact) return 1;

  const fullScore = jaccard(tokenSet(leftText), tokenSet(rightText));
  const givenScore = clauseSimilarity(left.given, right.given);
  const whenScore = clauseSimilarity(left.when, right.when);
  const thenScore = clauseSimilarity(left.then, right.then);
  const structureScore =
    ((Boolean(normaliseWhitespace(left.given)) === Boolean(normaliseWhitespace(right.given)) ? 1 : 0) +
    (Boolean(normaliseWhitespace(left.when)) === Boolean(normaliseWhitespace(right.when)) ? 1 : 0) +
    (Boolean(normaliseWhitespace(left.then)) === Boolean(normaliseWhitespace(right.then)) ? 1 : 0)) / 3;

  return (fullScore * 0.4) + (givenScore * 0.2) + (whenScore * 0.15) + (thenScore * 0.2) + (structureScore * 0.05);
}

function arMatchScore(
  left: AcceptanceRequirement,
  right: AcceptanceRequirement,
  leftIndex: number,
  rightIndex: number,
  leftCount: number,
  rightCount: number,
): number {
  const similarity = arSimilarity(left, right);
  const leftPosition = leftCount <= 1 ? 0 : leftIndex / (leftCount - 1);
  const rightPosition = rightCount <= 1 ? 0 : rightIndex / (rightCount - 1);
  const positionPenalty = Math.min(Math.abs(leftPosition - rightPosition), 1) * 0.08;
  return similarity - positionPenalty;
}

function alignAcceptanceRequirements(
  original: AcceptanceRequirement[],
  proposed: AcceptanceRequirement[],
): Array<{ proposed: AcceptanceRequirement; oldAr?: AcceptanceRequirement; oldIndex?: number; isNew: boolean }> {
  const rows: Array<{ proposed: AcceptanceRequirement; oldAr?: AcceptanceRequirement; oldIndex?: number; isNew: boolean }> = [];

  if (proposed.length === 0) return rows;
  if (original.length === 0) {
    return proposed.map((nextAr) => ({ proposed: nextAr, isNew: true }));
  }

  const matchThreshold = 0.26;
  const newArPenalty = 0.38;
  const m = original.length;
  const n = proposed.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  const decision: Array<Array<'skip-original' | 'new-proposed' | 'match' | null>> = Array.from(
    { length: m + 1 },
    () => new Array(n + 1).fill(null),
  );

  for (let i = 1; i <= m; i += 1) {
    dp[i][0] = dp[i - 1][0];
    decision[i][0] = 'skip-original';
  }

  for (let j = 1; j <= n; j += 1) {
    dp[0][j] = dp[0][j - 1] - newArPenalty;
    decision[0][j] = 'new-proposed';
  }

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      let bestScore = dp[i - 1][j];
      let bestDecision: 'skip-original' | 'new-proposed' | 'match' = 'skip-original';

      const markAsNewScore = dp[i][j - 1] - newArPenalty;
      if (markAsNewScore > bestScore) {
        bestScore = markAsNewScore;
        bestDecision = 'new-proposed';
      }

      const pairScore = arMatchScore(original[i - 1], proposed[j - 1], i - 1, j - 1, m, n);
      if (pairScore >= matchThreshold) {
        const matchScore = dp[i - 1][j - 1] + pairScore;
        if (matchScore > bestScore) {
          bestScore = matchScore;
          bestDecision = 'match';
        }
      }

      dp[i][j] = bestScore;
      decision[i][j] = bestDecision;
    }
  }

  let i = m;
  let j = n;
  while (j > 0) {
    const step = decision[i][j];
    if (step === 'match') {
      rows.unshift({ proposed: proposed[j - 1], oldAr: original[i - 1], oldIndex: i - 1, isNew: false });
      i -= 1;
      j -= 1;
      continue;
    }

    if (step === 'new-proposed' || i === 0) {
      rows.unshift({ proposed: proposed[j - 1], isNew: true });
      j -= 1;
      continue;
    }

    i -= 1;
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
        className="absolute inset-0 bg-[var(--rf-text)]/30 backdrop-blur-sm"
        onClick={!loading ? onClose : undefined}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
      />
      <motion.div
        className="relative bg-white w-full max-w-lg rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-[var(--rf-border)]"
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
            <button onClick={onClose} className="p-1.5 hover:bg-slate-200 text-[var(--rf-text-tertiary)] rounded-lg transition"><X className="w-4 h-4" /></button>
          )}
        </div>

        <div className="px-5 py-5">
          {loading ? (
            <div className="flex flex-col items-center py-8 gap-4">
              <div className="w-10 h-10 rounded-xl bg-[var(--rf-brand-muted)] flex items-center justify-center">
                <div className="w-5 h-5 border-[2.5px] border-[var(--rf-brand-subtle)] border-t-blue-600 rounded-full spin-slow" />
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
  storyPoints?: number;
  processCode?: string;
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
    projectKey: string;
    domainContextApplied?: boolean;
    attachmentIncluded?: boolean;
    wiDocsCount?: number;
    referencedWiDocs?: Array<{ docId: string; filename: string; chunkCount: number }>;
    similarStoriesCount?: number;
    referencedSimilarStories?: Array<{ key: string; summary: string; relevanceScore?: number; url?: string }>;
    discoveryTranscript?: Array<{
      roundNumber: number;
      questions: Array<{ category: string; question: string; suggestions: string[] }>;
      answers: Array<{ question: string; answer: string }>;
      coverage?: {
        sufficient: boolean;
        canGenerate: boolean;
        shouldContinueDiscovery: boolean;
        overallScore: number;
        summary: string;
        missingCritical: string[];
        dimensions: Array<{
          key: string;
          label: string;
          required: boolean;
          score: number;
          status: 'missing' | 'partial' | 'covered';
          evidence: string;
        }>;
      };
      submittedAt: string;
    }>;
    discoveryCoverage?: {
      sufficient: boolean;
      canGenerate: boolean;
      shouldContinueDiscovery: boolean;
      overallScore: number;
      summary: string;
      missingCritical: string[];
      dimensions: Array<{
        key: string;
        label: string;
        required: boolean;
        score: number;
        status: 'missing' | 'partial' | 'covered';
        evidence: string;
      }>;
    };
    tokenUsage?: { input: number; output: number; total: number; byStage?: Record<string, { input: number; output: number; total: number }> };
  } | null;
  projectKey: string;
  workflowTokenUsage?: { input: number; output: number; total: number } | null;
  fastProfileModel?: string;
  deepProfileModel?: string;
  onWorkflowTokenUsage?: (usage: { input: number; output: number; total: number }) => void;
  loadingTitle?: string;
}

interface FeatureSection {
  id: string;
  title: string;
  summary: string;
  items: Array<{ feature: Feature; index: number }>;
}

function GeneratingSkeleton() {
  return (
    <motion.div
      className="w-full max-w-4xl mx-auto px-6 py-10 space-y-6 flex-1 flex flex-col items-center justify-center min-h-[400px]"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
    >
      <motion.div
        className="flex flex-col items-center gap-4 mb-6"
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="w-14 h-14 rounded-2xl bg-white border border-[var(--rf-border)] shadow-sm flex items-center justify-center relative overflow-hidden">
          <Sparkles className="w-6 h-6 text-[var(--rf-brand)] relative z-10" />
          <div className="absolute inset-0 bg-[var(--rf-brand-muted)]/50 animate-pulse" />
        </div>
      </motion.div>

      <div className="w-full space-y-4">
        {[1, 2, 3].map(i => (
          <motion.div
            key={i}
            className="w-full bg-white rounded-2xl border border-[var(--rf-border)] overflow-hidden"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.12, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="flex">
              <div className="w-2 shrink-0 bg-[var(--rf-surface-soft)]" />
              <div className="flex-1 p-6 space-y-4">
                <div className="shimmer h-5 w-2/5 rounded-md" />
                <div className="shimmer h-4 w-full rounded-md" />
                <div className="shimmer h-4 w-4/5 rounded-md" />
                <div className="space-y-2 pt-3">
                  {[1, 2, 3].map(j => <div key={j} className="shimmer h-3 rounded-md" style={{ width: `${60 + j * 10}%` }} />)}
                </div>
              </div>
            </div>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}

// ─── Pricing table (USD per 1M tokens) ───────────────────────────────────────
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-haiku-4-5': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-5': { input: 3.00, output: 15.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-opus-4-6': { input: 15.00, output: 75.00 },
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4.00 },
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 },
  'claude-3-7-sonnet-20250219': { input: 3.00, output: 15.00 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
  'o1': { input: 15.00, output: 60.00 },
  'o1-mini': { input: 1.10, output: 4.40 },
  'gemini-1.5-pro': { input: 1.25, output: 5.00 },
  'gemini-1.5-flash': { input: 0.075, output: 0.30 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-2.5-pro': { input: 1.25, output: 10.00 },
};

function calculateEstimatedCost(
  input: number,
  output: number,
  fastModel: string,
  deepModel: string,
): number {
  const fastPrice = MODEL_PRICING[fastModel] ?? { input: 0.80, output: 4.00 };
  const deepPrice = MODEL_PRICING[deepModel] ?? { input: 15.00, output: 75.00 };
  // Input tokens come mostly from fast profile (clarify/preflight); output from deep profile (generation)
  return (input / 1_000_000) * fastPrice.input + (output / 1_000_000) * deepPrice.output;
}

// ─── Main component ───────────────────────────────────────────────────────────
export function MainContent({
  features, setFeatures, onPushFeature, isGenerating, progress, loadingTitle,
  sidebarOpen, setSidebarOpen, sessionId, requirement,
  generationContext, projectKey, workflowTokenUsage, onWorkflowTokenUsage,
  fastProfileModel = 'claude-haiku-4-5-20251001',
  deepProfileModel = 'claude-opus-4-6',
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
  const generationProgressText = progress ?? '';
  const generationStageProgress = !isGenerating
    ? 100
    : hasFeatures
      ? 88
      : /generating features|acceptance requirements/i.test(generationProgressText)
        ? 68
        : /context loaded|related stor|work instruction/i.test(generationProgressText)
          ? 32
          : /loading context|initializ/i.test(generationProgressText)
            ? 18
            : /queu|prepar|preparing/i.test(generationProgressText)
              ? 8
              : 12;
  const [showBulkRefine, setShowBulkRefine] = useState(false);
  const [showTokenDetails, setShowTokenDetails] = useState(false);
  const [isContextModalOpen, setIsContextModalOpen] = useState(false);
  const [showInlineReferences, setShowInlineReferences] = useState(false);
  const [bulkInput, setBulkInput] = useState('');
  const [isBulkRefining, setIsBulkRefining] = useState(false);
  const [lastAiTokenUsage, setLastAiTokenUsage] = useState<{ label: string; input: number; output: number; total: number } | null>(null);
  const hasInlineReferences = Boolean(
    generationContext?.referencedWiDocs?.length ||
    generationContext?.referencedSimilarStories?.length,
  );
  const featureGroupTitleById = new Map<string, string>();
  const featureSections: FeatureSection[] = [{
    id: 'all-features',
    title: 'Generated features',
    summary: '',
    items: features.map((feature, index) => ({ feature, index })),
  }];
  const hasInitiativeSections = false;

  const escapeSpreadsheetValue = (value: string | number | boolean | null | undefined) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

  const buildSpreadsheetRow = (cells: Array<string | number | boolean>, header = false) =>
    `<Row>${cells.map(cell => `<Cell${header ? ' ss:StyleID="header"' : ''}><Data ss:Type="String">${escapeSpreadsheetValue(cell)}</Data></Cell>`).join('')}</Row>`;

  const exportFeaturesToExcel = () => {
    if (!features.length) return;

    const featureRows = [
      buildSpreadsheetRow(['Feature #', 'Initiative Group', 'Title', 'Description', 'AR Count', 'Accepted', 'Jira Issue', 'Jira URL', 'Pending Refinement', 'Pending Removal'], true),
      ...features.map((feature, idx) => buildSpreadsheetRow([
        idx + 1,
        featureGroupTitleById.get(feature.id) || '',
        feature.title || feature.summary || `Feature ${idx + 1}`,
        feature.description || feature.markdown || '',
        feature.acceptanceRequirements?.length || 0,
        feature.isAccepted ? 'Yes' : 'No',
        feature.jiraIssueKey || '',
        feature.jiraIssueUrl || '',
        feature.pendingRefinement ? 'Yes' : 'No',
        feature.pendingRemoval ? 'Yes' : 'No',
      ])),
    ].join('');

    const acceptanceRequirementRows = [
      buildSpreadsheetRow(['Feature #', 'Initiative Group', 'Feature Title', 'AR #', 'Given', 'When', 'Then', 'Accepted', 'Jira Issue'], true),
      ...features.flatMap((feature, featureIdx) => {
        const ars = feature.acceptanceRequirements || [];
        if (!ars.length) {
          return [
            buildSpreadsheetRow([
              featureIdx + 1,
              featureGroupTitleById.get(feature.id) || '',
              feature.title || feature.summary || `Feature ${featureIdx + 1}`,
              '',
              '',
              '',
              '',
              feature.isAccepted ? 'Yes' : 'No',
              feature.jiraIssueKey || '',
            ]),
          ];
        }

        return ars.map((ar, arIdx) => buildSpreadsheetRow([
          featureIdx + 1,
          featureGroupTitleById.get(feature.id) || '',
          feature.title || feature.summary || `Feature ${featureIdx + 1}`,
          arIdx + 1,
          ar.given || '',
          ar.when || '',
          ar.then || '',
          feature.isAccepted ? 'Yes' : 'No',
          feature.jiraIssueKey || '',
        ]));
      }),
    ].join('');

    const exportedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const workbook = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="header">
   <Font ss:Bold="1"/>
   <Interior ss:Color="#F4F5F7" ss:Pattern="Solid"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="Features">
  <Table>
   ${featureRows}
  </Table>
 </Worksheet>
 <Worksheet ss:Name="Acceptance Requirements">
  <Table>
   ${acceptanceRequirementRows}
  </Table>
 </Worksheet>
 <Worksheet ss:Name="Export Info">
  <Table>
   ${buildSpreadsheetRow(['Workspace Scope', projectKey === '*' ? 'Standalone workspace' : projectKey], true)}
   ${buildSpreadsheetRow(['Exported At (UTC)', exportedAt])}
   ${buildSpreadsheetRow(['Feature Count', features.length])}
   ${buildSpreadsheetRow(['Acceptance Requirement Count', totalArCount])}
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
      if (n[idx].pendingRefinement) {
        n[idx] = {
          ...n[idx].pendingRefinement!,
          id: n[idx].id,
          pendingRefinement: undefined,
          pendingRemoval: undefined,
        };
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
                id: f.id,
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
            id: f.id,
            pendingRefinement: undefined,
            pendingRemoval: undefined,
            isAccepted: true
          };
        });
      api.updateConversationFeatures(sessionId, next);
      return next;
    });
  };

  const renderFeatureCard = (feature: Feature, idx: number, animationIndex: number) => {
    const isEditing = editingIdx === idx;
    const draft = editDraft;

    return (
      <motion.div
        key={feature.id || idx}
        className={`group overflow-hidden rounded-[22px] border ${feature.pendingRemoval ? 'opacity-70 border-[var(--rf-danger-subtle)] bg-white' : feature.isAccepted ? 'border-[var(--rf-success-subtle)] bg-[var(--rf-success-subtle)]/30' : 'border-[var(--rf-border)] bg-white'}`}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: animationIndex * 0.05, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        style={{ boxShadow: feature.isAccepted ? '0 4px 24px -4px rgba(58,107,83,0.12)' : feature.pendingRemoval ? '0 4px 20px -4px rgba(244,63,94,0.15)' : '0 4px 12px -4px rgba(31,30,29,0.04)' }}
        whileHover={{ y: -2, boxShadow: feature.isAccepted ? '0 8px 32px -4px rgba(58,107,83,0.16)' : '0 8px 24px -4px rgba(31,30,29,0.06)' }}
      >
        <div className="flex flex-col sm:flex-row">
          <div className={`h-1.5 sm:h-auto sm:w-2 shrink-0 ${feature.pendingRemoval ? 'bg-[var(--rf-danger)]' : feature.isAccepted ? 'bg-[var(--rf-success)]' : 'bg-[var(--rf-border-strong)]'}`} />

          <div className="flex-1 p-4 sm:p-4.5">
            <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3 mb-3">
              {isEditing ? (
                <input
                  type="text"
                  value={draft?.title || draft?.summary || ''}
                  onChange={e => setEditDraft(d => d ? { ...d, summary: e.target.value, title: e.target.value } : null)}
                  className="flex-1 text-lg font-bold text-[var(--rf-text)] bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-2 focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none transition"
                />
              ) : (
                <div className="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center gap-3 cursor-pointer" onClick={() => toggleExpand(idx)}>
                  <h3 className="min-w-0 flex-1 text-[17px] font-bold leading-tight text-[var(--rf-text)] tracking-tight">
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

              <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                {isEditing ? (
                  <>
                    <motion.button onClick={cancelEditing} className="px-3 py-1.5 text-xs font-bold text-[var(--rf-text-secondary)] bg-[var(--rf-surface-soft)] hover:bg-slate-200 rounded-lg transition" whileTap={{ scale: 0.97 }}>Cancel</motion.button>
                    <motion.button onClick={saveEditing} className="px-3 py-1.5 text-xs font-bold text-white bg-emerald-600 hover:bg-[var(--rf-success)] rounded-lg transition flex items-center gap-1.5 shadow-sm shadow-emerald-600/20" whileTap={{ scale: 0.97 }}><Check className="w-3.5 h-3.5" /> Save</motion.button>
                  </>
                ) : (
                  <>
                    <motion.button onClick={() => startEditing(idx)} className="px-2.5 py-1.5 text-[11px] font-bold text-[var(--rf-text-tertiary)] hover:bg-[var(--rf-surface-soft)] hover:text-[var(--rf-text)] rounded-lg transition flex items-center gap-1.5" whileTap={{ scale: 0.97 }}><Edit2 className="w-3.5 h-3.5" /> Edit</motion.button>
                    <motion.button onClick={() => setRefinePopupIdx(idx)} className="px-2.5 py-1.5 text-[11px] font-bold text-[var(--rf-brand)] hover:bg-[var(--rf-brand-muted)] rounded-lg transition flex items-center gap-1.5" whileTap={{ scale: 0.97 }}><Sparkles className="w-3.5 h-3.5" /> Refine</motion.button>
                    <motion.button onClick={() => toggleAccepted(idx)} className={`px-3 py-1.5 text-[11px] font-bold rounded-lg transition border flex items-center gap-1.5 shadow-sm ${feature.isAccepted ? 'text-white bg-[var(--rf-success)] border-[var(--rf-success)] shadow-[var(--rf-success)]/20' : 'text-[var(--rf-text-secondary)] bg-white border-[var(--rf-border)] hover:bg-[var(--rf-success-subtle)] hover:text-[var(--rf-success)] hover:border-[var(--rf-success-subtle)]'}`} whileTap={{ scale: 0.97 }}>
                      <Check className="w-3.5 h-3.5" /> {feature.isAccepted ? 'Accepted' : 'Accept'}
                    </motion.button>
                    <motion.button onClick={() => requestFeatureRemoval(idx)} className="px-2.5 py-1.5 text-[11px] font-bold text-[var(--rf-danger)] hover:bg-[var(--rf-danger-subtle)] rounded-lg transition flex items-center gap-1.5" whileTap={{ scale: 0.97 }}><Trash2 className="w-3.5 h-3.5" /> Delete</motion.button>
                    {feature.jiraIssueKey ? (
                      <div className="flex items-center gap-1">
                        <motion.button
                          onClick={() => feature.jiraIssueUrl ? router.navigate(feature.jiraIssueUrl) : null}
                          className="px-3 py-1.5 text-[11px] font-bold text-[var(--rf-brand-hover)] bg-[var(--rf-brand-muted)] border border-[var(--rf-brand-subtle)] rounded-lg transition flex items-center gap-1.5 hover:bg-blue-100 shadow-sm"
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
                        className="px-3 py-1.5 text-[11px] font-bold text-white bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] disabled:bg-slate-300 disabled:text-[var(--rf-text-tertiary)] rounded-lg transition flex items-center gap-1.5 shadow-sm shadow-[var(--rf-brand)]/20"
                        whileTap={{ scale: 0.97 }}
                      >
                        <Upload className="w-3.5 h-3.5" /> Push
                      </motion.button>
                    )}
                  </>
                )}
              </div>
            </div>

            {!isEditing && (
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] leading-none">
                <span className="font-semibold text-[var(--rf-text-secondary)]">
                  {feature.acceptanceRequirements?.length || 0} acceptance requirement{(feature.acceptanceRequirements?.length || 0) !== 1 ? 's' : ''}
                </span>
                {feature.storyPoints ? (
                  <span className="text-[var(--rf-text-tertiary)]">SP {feature.storyPoints}</span>
                ) : null}
                {feature.processCode ? (
                  <span className="text-[var(--rf-text-tertiary)]">{feature.processCode}</span>
                ) : null}
                {feature.jiraIssueKey ? (
                  <span className="text-[var(--rf-brand)] font-semibold">{feature.jiraIssueKey}</span>
                ) : null}
              </div>
            )}

            {feature.pendingRemoval && (
              <div className="mb-4 p-4 rounded-xl bg-[var(--rf-danger-subtle)] border border-[var(--rf-danger-subtle)] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-2 text-[var(--rf-danger)] font-bold text-sm">
                  <Trash2 className="w-4 h-4" /> Proposed for Removal
                </div>
                <div className="flex items-center gap-2">
                  <motion.button onClick={() => clearPendingRemoval(idx)} className="px-4 py-2 text-xs font-bold text-[var(--rf-text-secondary)] bg-white border border-[var(--rf-border)] hover:bg-[var(--rf-surface-soft)] rounded-lg shadow-sm" whileTap={{ scale: 0.97 }}>Keep Instead</motion.button>
                  <motion.button onClick={() => removeFeatureAt(idx)} className="px-4 py-2 text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 rounded-lg shadow-sm shadow-rose-600/20" whileTap={{ scale: 0.97 }}>Confirm Removal</motion.button>
                </div>
              </div>
            )}

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
                <div className="mb-5 p-4 rounded-2xl bg-amber-50/50 border border-amber-200">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
                    <h4 className="text-amber-700 font-bold text-xs uppercase tracking-widest flex items-center gap-2"><Sparkles className="w-4 h-4" /> AI Suggested Refinements</h4>

                    <div className="flex flex-wrap items-center gap-3">
                      <div className="flex items-center bg-white p-1 rounded-lg border border-amber-200 shadow-sm">
                        <button
                          onClick={() => setDiffMode('redline')}
                          className={`px-3 py-1 text-[10px] font-bold rounded-md transition uppercase tracking-wider ${diffMode === 'redline' ? 'bg-amber-100 text-amber-900' : 'text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text-secondary)]'}`}
                        >
                          Redline
                        </button>
                        <button
                          onClick={() => setDiffMode('blackline')}
                          className={`px-3 py-1 text-[10px] font-bold rounded-md transition uppercase tracking-wider ${diffMode === 'blackline' ? 'bg-amber-100 text-amber-900' : 'text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text-secondary)]'}`}
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
                            <div key={`${i}-${row.oldIndex ?? 'new'}`} className={`p-2.5 rounded-lg text-[11px] text-[var(--rf-text)] border shadow-sm ${isNew ? 'bg-[var(--rf-success-subtle)] border-[var(--rf-success-subtle)]' : 'bg-white border-blue-100'}`}>
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

            {(expandedIndices.has(idx) || isEditing) && (
              <div className={`mt-4 ${feature.pendingRefinement ? 'opacity-50 pointer-events-none' : ''}`}>
                {isEditing ? (
                  <textarea
                    value={draft?.description || ''}
                    onChange={e => setEditDraft(d => d ? { ...d, description: e.target.value } : null)}
                    className="w-full text-[var(--rf-text-secondary)] text-sm bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 min-h-[120px] mb-6 focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none resize-y transition"
                  />
                ) : (
                  <div className="text-[var(--rf-text-secondary)] text-[13px] sm:text-sm mb-4 whitespace-pre-wrap leading-relaxed border-l-2 border-[var(--rf-brand)]/20 pl-3 py-0.5">
                    {feature.markdown || feature.description}
                  </div>
                )}

                {((isEditing && draft?.acceptanceRequirements) || (!isEditing && feature.acceptanceRequirements?.length > 0)) && (
                  <div className="mt-2 text-sm">
                    <div className="flex items-center justify-between mb-4 pb-2">
                      <h4 className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Acceptance Criteria</h4>
                      {isEditing && (
                        <motion.button onClick={addDraftAr} className="text-xs font-bold text-[var(--rf-brand)] bg-[var(--rf-brand-muted)] hover:bg-blue-100 px-3 py-1.5 rounded-lg transition flex items-center gap-1.5" whileTap={{ scale: 0.97 }}><Plus className="w-3.5 h-3.5" /> Add AR</motion.button>
                      )}
                    </div>
                    <div className="space-y-2">
                      {(isEditing ? draft!.acceptanceRequirements : feature.acceptanceRequirements).map((ar, i) => (
                        <div key={i} className="bg-[var(--rf-surface-soft)]/50 rounded-xl p-3 border border-[var(--rf-border-subtle)] relative group transition hover:border-[var(--rf-border)]">
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
                            <div className="space-y-1 text-[13px] sm:text-sm">
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
  };

  return (
    <main className="flex-1 flex flex-col h-full relative overflow-hidden bg-transparent">
      {/* Header */}
      <motion.header
        className="relative shrink-0 bg-white/80 backdrop-blur-md px-6 py-4 z-20 sticky top-0 border-b border-[var(--rf-border)] shadow-sm"
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
              {workflowTokenUsage?.total
                ? `~$${calculateEstimatedCost(workflowTokenUsage.input, workflowTokenUsage.output, fastProfileModel, deepProfileModel).toFixed(3)}`
                : 'Tokens'}
            </motion.button>
            <AnimatePresence>
              {showTokenDetails && (
                <motion.div
                  className="absolute right-0 top-full mt-3 w-[280px] rounded-2xl border border-[var(--rf-border)] bg-white p-4 shadow-xl z-50"
                  initial={{ opacity: 0, y: -8, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -8, scale: 0.96 }}
                  transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                >
                  <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-3">Workflow token usage</div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-[var(--rf-text-tertiary)]">Input tokens</span>
                      <span className="text-sm font-bold text-[var(--rf-text)]">{(workflowTokenUsage?.input ?? 0).toLocaleString()}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-[var(--rf-text-tertiary)]">Output tokens</span>
                      <span className="text-sm font-bold text-[var(--rf-text)]">{(workflowTokenUsage?.output ?? 0).toLocaleString()}</span>
                    </div>
                    <div className="flex items-center justify-between pt-1.5 border-t border-[var(--rf-border-subtle)]">
                      <span className="text-xs font-semibold text-[var(--rf-text-secondary)]">Total tokens</span>
                      <span className="text-sm font-black text-[var(--rf-text)]">{(workflowTokenUsage?.total ?? 0).toLocaleString()}</span>
                    </div>
                    {workflowTokenUsage?.total ? (
                      <div className="flex items-center justify-between pt-1.5 border-t border-[var(--rf-border-subtle)]">
                        <span className="text-xs font-semibold text-[var(--rf-brand)]">Est. cost</span>
                        <span className="text-sm font-black text-[var(--rf-brand)]">
                          ~${calculateEstimatedCost(workflowTokenUsage.input, workflowTokenUsage.output, fastProfileModel, deepProfileModel).toFixed(4)}
                        </span>
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-3 pt-3 border-t border-[var(--rf-border-subtle)] text-[11px] text-[var(--rf-text-tertiary)] leading-relaxed">
                    Includes clarify, generation, and all refinements. Cost is an estimate based on your configured model profiles.
                  </div>
                  {lastAiTokenUsage && (
                    <div className="mt-2 text-[11px] font-medium text-[var(--rf-text-tertiary)] bg-[var(--rf-surface-soft)] rounded-lg p-2 border border-[var(--rf-border-subtle)]">
                      Last: {lastAiTokenUsage.label} — {lastAiTokenUsage.total.toLocaleString()} tokens ({lastAiTokenUsage.input.toLocaleString()} in / {lastAiTokenUsage.output.toLocaleString()} out)
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {isGenerating && (
          <div className="mt-3 flex items-center gap-2.5">
            <div className="dot-bounce text-[var(--rf-brand)] shrink-0"><span /><span /><span /></div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-[var(--rf-text)] uppercase tracking-wider leading-none">
                {loadingTitle || 'Working'}
              </p>
              <p className="text-[13px] text-[var(--rf-text-secondary)] leading-snug mt-0.5 truncate">
                {progress || 'Preparing your request…'}
              </p>
            </div>
          </div>
        )}
        {isGenerating && (
          <div className="absolute bottom-0 left-0 right-0 h-[3px] overflow-hidden">
            <div
              className="h-full bg-[var(--rf-brand)] transition-[width] duration-700 ease-out"
              style={{ width: `${generationStageProgress}%` }}
            />
          </div>
        )}

        {hasFeatures && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-[var(--rf-border)] pt-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center rounded-lg bg-[var(--rf-text)] text-white px-3.5 py-1.5 text-xs font-bold shadow-sm">
                  {features.length} Features
                  <span className="mx-2 opacity-40">·</span>
                  {totalArCount} ARs
              </span>
              <span className={`text-xs font-semibold whitespace-nowrap px-3 py-1.5 rounded-lg border ${features.filter(f => f.isAccepted).length > 0 ? 'bg-[var(--rf-success-subtle)] text-[var(--rf-success)] border-[var(--rf-success)]/20' : 'text-[var(--rf-text-tertiary)] bg-[var(--rf-surface-soft)] border-[var(--rf-border)]'}`}>
                <span className="font-bold mr-1">{features.filter(f => f.isAccepted).length}</span> accepted
              </span>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2.5">
              {features.some(f => f.pendingRefinement) && (
                <>
                  <motion.button onClick={discardAllProposed} className="px-3 py-1.5 text-xs font-bold text-[var(--rf-text-secondary)] bg-white border border-[var(--rf-border)] rounded-lg hover:text-[var(--rf-danger)] hover:border-[var(--rf-danger-subtle)] transition shadow-sm" whileTap={{ scale: 0.97 }}>Discard All</motion.button>
                  <motion.button onClick={acceptAllProposed} className="px-3 py-1.5 bg-[var(--rf-success)] hover:bg-[#1E4D3B] text-white text-xs font-bold rounded-lg transition shadow-sm shadow-[var(--rf-success)]/20" whileTap={{ scale: 0.97 }}>Accept All</motion.button>
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
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-bold transition shadow-sm ${showBulkRefine ? 'bg-[var(--rf-text)] text-white border-slate-900' : 'bg-white text-[var(--rf-text-secondary)] border-[var(--rf-border)] hover:border-[var(--rf-brand-subtle)] hover:text-[var(--rf-brand)]'}`}
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
        {isGenerating && !hasFeatures ? (
          <GeneratingSkeleton />
        ) : !hasFeatures ? (
          <motion.div
            className="flex-1 flex flex-col items-center justify-center text-center max-w-md mx-auto"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="levitate w-16 h-16 rounded-2xl flex items-center justify-center mb-6 bg-white shadow-xl shadow-blue-900/5 border border-[var(--rf-border)]">
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
                className="bg-white/60 backdrop-blur-md rounded-2xl p-5 border border-[var(--rf-border)] shadow-sm"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="flex flex-wrap items-center gap-4 text-xs">
                  <div className="font-bold text-[var(--rf-text)]">
                    Project: <span className="font-medium text-[var(--rf-text-secondary)]">{generationContext.projectKey === '*' ? 'Global' : generationContext.projectKey}</span>
                  </div>
                  <div className="font-bold text-[var(--rf-text)]">
                    Domain guidance: <span className="font-medium text-[var(--rf-text-secondary)]">{generationContext.domainContextApplied ? 'Included' : 'None'}</span>
                  </div>
                  <div className="font-bold text-[var(--rf-text)]">
                    Attachment: <span className="font-medium text-[var(--rf-text-secondary)]">{generationContext.attachmentIncluded ? 'Included' : 'None'}</span>
                  </div>
                  {generationContext.discoveryCoverage ? (
                    <div className="font-bold text-[var(--rf-text)]">
                      Discovery: <span className="font-medium text-[var(--rf-text-secondary)]">{generationContext.discoveryCoverage.overallScore}% coverage</span>
                    </div>
                  ) : null}
                  {generationContext.discoveryTranscript?.length ? (
                    <div className="font-bold text-[var(--rf-text)]">
                      Discovery rounds: <span className="font-medium text-[var(--rf-text-secondary)]">{generationContext.discoveryTranscript.length}</span>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setIsContextModalOpen(true)}
                    className="text-xs font-bold text-[var(--rf-brand)] hover:text-[var(--rf-brand-hover)] transition-colors"
                  >
                    View full details
                  </button>
                  {hasInlineReferences && (
                    <button
                      type="button"
                      onClick={() => setShowInlineReferences(prev => !prev)}
                      className="text-xs font-bold text-[var(--rf-text-secondary)] hover:text-[var(--rf-text)] transition-colors"
                    >
                      {showInlineReferences ? 'Hide references' : 'Show references'}
                    </button>
                  )}
                </div>
                {showInlineReferences && (
                  <>
                    <div className="mt-4 pt-4 border-t border-[var(--rf-border)]/60">
                      <div className="flex flex-wrap items-center gap-3 text-xs">
                        <div className="font-bold text-[var(--rf-text)]">
                          Work instructions ({generationContext.wiDocsCount ?? 0}):
                        </div>
                        {generationContext.referencedWiDocs?.length ? (
                          <div className="font-medium text-[var(--rf-text-secondary)]">
                            {generationContext.referencedWiDocs.map(doc => doc.filename).join(', ')}
                          </div>
                        ) : (
                          <div className="text-[var(--rf-text-tertiary)] italic">No matching docs found</div>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </motion.div>
            )}

            {featureSections.map((section, sectionIndex) => (
              <div key={section.id} className="space-y-4">
                {hasInitiativeSections && (
                  <div className="px-1 pt-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className="text-lg font-bold tracking-tight text-[var(--rf-text)]">{section.title}</h3>
                      <span className="inline-flex items-center rounded-full bg-[var(--rf-surface-soft)] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)] border border-[var(--rf-border)]">
                        {section.items.length} feature{section.items.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                    <p className="mt-1 text-sm font-medium text-[var(--rf-text-tertiary)]">{section.summary}</p>
                  </div>
                )}

                {section.items.map(({ feature, index }, itemIndex) =>
                  renderFeatureCard(feature, index, sectionIndex * 4 + itemIndex),
                )}
              </div>
            ))}
          </motion.div>
        )}
      </div>

      {generationContext && isContextModalOpen && (
        <GenerationContextModal contextMeta={generationContext} onClose={() => setIsContextModalOpen(false)} />
      )}

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

function GenerationContextModal({
  contextMeta,
  onClose,
}: {
  contextMeta: NonNullable<MainContentProps['generationContext']>;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <motion.div
        className="absolute inset-0 bg-[var(--rf-text)]/45 backdrop-blur-sm"
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      />

      <motion.div
        className="relative w-full max-w-5xl max-h-[88vh] overflow-hidden rounded-3xl border border-[var(--rf-border)] bg-white shadow-2xl"
        initial={{ opacity: 0, scale: 0.96, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 16 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--rf-border-subtle)] px-6 py-5">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-[var(--rf-text)]">Feature canvas context</h2>
            <p className="mt-1 text-sm font-medium text-[var(--rf-text-tertiary)]">
              Full context used to generate the current feature set, including work instructions and related Jira stories.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-2 text-[var(--rf-text-tertiary)] transition hover:bg-[var(--rf-surface-soft)] hover:text-[var(--rf-text)]"
            aria-label="Close feature canvas context"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[calc(88vh-92px)] overflow-y-auto p-6 custom-scrollbar">
          <div className="grid gap-4 md:grid-cols-5">
            <ContextStatCard label="Project" value={contextMeta.projectKey === '*' ? 'Global' : contextMeta.projectKey} />
            <ContextStatCard label="Work instructions" value={`${contextMeta.wiDocsCount ?? 0}`} />
            <ContextStatCard label="Related stories" value={`${contextMeta.similarStoriesCount ?? 0}`} />
            <ContextStatCard label="Discovery coverage" value={contextMeta.discoveryCoverage ? `${contextMeta.discoveryCoverage.overallScore}%` : 'N/A'} />
            <ContextStatCard label="Discovery rounds" value={`${contextMeta.discoveryTranscript?.length ?? 0}`} />
          </div>

            <div className="mt-6 rounded-2xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)]/40 p-4">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-[var(--rf-brand)]" />
                <div className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Setup</div>
              </div>
              <div className="mt-3 grid gap-2 text-sm text-[var(--rf-text-secondary)] md:grid-cols-2">
                <div><strong className="text-[var(--rf-text)]">Domain guidance:</strong> {contextMeta.domainContextApplied ? 'Included' : 'Not configured'}</div>
                <div><strong className="text-[var(--rf-text)]">Attachment:</strong> {contextMeta.attachmentIncluded ? 'Included' : 'None'}</div>
                <div className="md:col-span-2"><strong className="text-[var(--rf-text)]">Roles:</strong> {contextMeta.domainRolesUsed?.length ? contextMeta.domainRolesUsed.join(', ') : 'None'}</div>
                <div className="md:col-span-2"><strong className="text-[var(--rf-text)]">Tokens:</strong> {contextMeta.tokenUsage ? `${contextMeta.tokenUsage.total.toLocaleString()} total (${contextMeta.tokenUsage.input.toLocaleString()} in / ${contextMeta.tokenUsage.output.toLocaleString()} out)` : 'Not available'}</div>
              </div>
            </div>

          {contextMeta.discoveryCoverage ? (
            <section className="mt-6 rounded-2xl border border-amber-200 bg-amber-50/60 p-5 shadow-sm">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-amber-900" />
                <h3 className="text-sm font-bold uppercase tracking-[0.18em] text-amber-900">Discovery coverage</h3>
              </div>
              <div className="mt-4 text-sm text-amber-900/90">{contextMeta.discoveryCoverage.summary}</div>
              {contextMeta.discoveryCoverage.missingCritical.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {contextMeta.discoveryCoverage.missingCritical.map(item => (
                    <span key={item} className="rounded-md bg-white px-2.5 py-1 text-[11px] font-medium text-amber-900 border border-amber-200">
                      Missing: {item}
                    </span>
                  ))}
                </div>
              )}
            </section>
          ) : null}

          {contextMeta.discoveryTranscript?.length ? (
            <section className="mt-6 rounded-2xl border border-[var(--rf-border)] bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-[var(--rf-brand)]" />
                <h3 className="text-sm font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Discovery transcript</h3>
              </div>
              <div className="mt-4 space-y-4">
                {contextMeta.discoveryTranscript.map(round => (
                  <div key={round.roundNumber} className="rounded-2xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)]/45 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-md bg-white px-2 py-1 text-[11px] font-bold tracking-wide text-[var(--rf-text)] border border-[var(--rf-border-subtle)]">
                        Round {round.roundNumber}
                      </span>
                      <span className="rounded-md bg-white px-2 py-1 text-[11px] font-medium text-[var(--rf-text-tertiary)] border border-[var(--rf-border-subtle)]">
                        {round.answers.length} answer{round.answers.length !== 1 ? 's' : ''}
                      </span>
                      {round.coverage ? (
                        <span className="rounded-md bg-white px-2 py-1 text-[11px] font-medium text-amber-900 border border-amber-200">
                          Coverage {round.coverage.overallScore}%
                        </span>
                      ) : null}
                    </div>
                    {round.coverage?.summary ? (
                      <div className="mt-3 text-sm text-[var(--rf-text-secondary)]">{round.coverage.summary}</div>
                    ) : null}
                    <div className="mt-3 space-y-2">
                      {round.answers.map((answer, index) => (
                        <div key={`${round.roundNumber}-${index}`} className="rounded-xl bg-white p-3 border border-[var(--rf-border-subtle)]">
                          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--rf-text-tertiary)]">{answer.question}</div>
                          <div className="mt-1 text-sm text-[var(--rf-text-secondary)] whitespace-pre-wrap">{answer.answer || 'No answer captured.'}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <section className="rounded-2xl border border-[var(--rf-border)] bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-[var(--rf-brand)]" />
                <h3 className="text-sm font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Work instructions</h3>
              </div>
              <div className="mt-4 space-y-3">
                {contextMeta.referencedWiDocs?.length ? (
                  contextMeta.referencedWiDocs.map(doc => (
                    <div key={doc.docId} className="rounded-2xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)]/55 p-4">
                      <div className="text-sm font-bold text-[var(--rf-text)] break-words">{doc.filename}</div>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs font-medium text-[var(--rf-text-tertiary)]">
                        <span className="rounded-md bg-white px-2 py-1 border border-[var(--rf-border-subtle)]">Reference: {doc.docId}</span>
                        <span className="rounded-md bg-white px-2 py-1 border border-[var(--rf-border-subtle)]">{doc.chunkCount} chunks matched</span>
                      </div>
                    </div>
                  ))
                ) : (
                  <ContextEmptyState text="No work instructions were attached to this generation pass." />
                )}
              </div>
            </section>

            <section className="rounded-2xl border border-[var(--rf-border)] bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2">
                <ExternalLink className="h-4 w-4 text-[var(--rf-brand)]" />
                <h3 className="text-sm font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Related Jira stories</h3>
              </div>
              <div className="mt-4 space-y-3">
                {contextMeta.referencedSimilarStories?.length ? (
                  contextMeta.referencedSimilarStories.map(story => (
                    <div key={story.key} className="rounded-2xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)]/55 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        {story.url ? (
                          <a
                            href={story.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-1 text-[11px] font-bold tracking-wide text-[var(--rf-brand-hover)] border border-blue-100 hover:border-[var(--rf-brand-subtle)] hover:text-[var(--rf-brand)]"
                          >
                            {story.key}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          <span className="rounded-md bg-white px-2 py-1 text-[11px] font-bold tracking-wide text-[var(--rf-brand-hover)] border border-blue-100">
                            {story.key}
                          </span>
                        )}
                        {typeof story.relevanceScore === 'number' && (
                          <span className="rounded-md bg-white px-2 py-1 text-[11px] font-medium text-[var(--rf-text-tertiary)] border border-[var(--rf-border-subtle)]">
                            Match {Math.round(Math.max(0, Math.min(story.relevanceScore, 1)) * 100)}%
                          </span>
                        )}
                      </div>
                      <div className="mt-3 text-sm">
                        <div className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">Title</div>
                        <div className="mt-1 font-semibold text-[var(--rf-text)]">{story.summary}</div>
                      </div>
                    </div>
                  ))
                ) : (
                  <ContextEmptyState text="No related Jira stories were referenced for this generation pass." />
                )}
              </div>
            </section>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function ContextStatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)]/45 p-4">
      <div className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">{label}</div>
      <div className="mt-2 text-2xl font-bold tracking-tight text-[var(--rf-text)]">{value}</div>
    </div>
  );
}

function ContextEmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-[var(--rf-border)] bg-[var(--rf-surface-soft)]/35 p-4 text-sm text-[var(--rf-text-tertiary)]">
      {text}
    </div>
  );
}
