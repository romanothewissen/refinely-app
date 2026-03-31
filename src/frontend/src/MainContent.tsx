import React, { useState } from 'react';
import { Send, Sparkles, Edit2, Check, X, Plus, Trash2, Menu, Upload, ChevronDown, Coins, Download, AlertCircle, FileText, ExternalLink } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from './hooks/useForge';
import { router } from '@forge/bridge';

// ─── Word-level diff utility ──────────────────────────────────────────────────
type DiffToken = { text: string; type: 'same' | 'added' | 'removed' };
type AcceptanceRequirement = { given: string; when: string; then: string };

function formatPlannerLabel(value: string): string {
  return value
    .split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatMatchPercent(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.round(Math.max(0, Math.min(score, 1)) * 100);
}

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
function RefinePopup({ feature, sessionId, onClose, onResult, outputInstructions }: {
  feature: Feature;
  sessionId: string;
  onClose: () => void;
  onResult: (refined: Feature, tokenUsage?: { input: number; output: number; total: number }) => void;
  outputInstructions?: string;
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
      const res = await api.refineSingleFeature(feature, feedback, sessionId, outputInstructions) as any;
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

interface InitiativeGroup {
  id: string;
  title: string;
  summary: string;
  featureIds: string[];
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
    plannerDecision?: {
      reasoningMode: 'fast' | 'deep';
      outputMode: 'single' | 'auto' | 'full_breakdown';
      scopeMode: 'atomic' | 'focused' | 'standard' | 'initiative';
      clarificationMode: 'none' | 'light' | 'standard' | 'deep';
      featurePlan: { min: number; max: number; target: number };
      questionPlan: { min: number; max: number; target: number; clarity: 'clear' | 'medium' | 'vague' };
      useHierarchy: boolean;
      confidence: number;
      rationale: string[];
    };
    wiDocsCount?: number;
    referencedWiDocs?: Array<{ docId: string; filename: string; chunkCount: number }>;
    similarStoriesCount?: number;
    referencedSimilarStories?: Array<{ key: string; summary: string; relevanceScore?: number; url?: string }>;
    initiativeGroups?: InitiativeGroup[];
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
  onWorkflowTokenUsage?: (usage: { input: number; output: number; total: number }) => void;
  loadingTitle?: string;
  outputInstructions?: string;
}

interface FeatureSection {
  id: string;
  title: string;
  summary: string;
  items: Array<{ feature: Feature; index: number }>;
}

function GeneratingSkeleton({ loadingTitle, progress }: { loadingTitle?: string; progress?: string }) {
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
        <div className="text-center">
          <h2 className="text-xl font-bold text-[var(--rf-text)] tracking-tight">{loadingTitle || 'Crafting features'}</h2>
          <p className="text-sm font-medium text-[var(--rf-text-tertiary)] mt-1 max-w-xl">{progress || 'Processing your request…'}</p>
        </div>
        <div className="dot-bounce text-[var(--rf-brand)] mt-2"><span /><span /><span /></div>
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

// ─── Main component ───────────────────────────────────────────────────────────
export function MainContent({
  features, setFeatures, onPushFeature, isGenerating, progress, loadingTitle,
  sidebarOpen, setSidebarOpen, sessionId, requirement,
  generationContext, projectKey, workflowTokenUsage, onWorkflowTokenUsage,
  outputInstructions
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
      : /acceptance requirement|drafting ar|pass 2/i.test(generationProgressText)
        ? 75
        : /decompos|planning feature|pass 1/i.test(generationProgressText)
          ? 45
          : /context loaded|curated|related stor|work instruction/i.test(generationProgressText)
            ? 28
          : /loading context|initializ/i.test(generationProgressText)
            ? 18
            : /queu|prepar|preparing/i.test(generationProgressText)
              ? 8
              : /drafting.*question|question_gen/i.test(generationProgressText)
                ? 60
                : /loading.*context|contextual signal/i.test(generationProgressText)
                  ? 25
                  : /assess|preflight/i.test(generationProgressText)
                    ? 12
                    : 10;
  const [showBulkRefine, setShowBulkRefine] = useState(false);
  const [showTokenDetails, setShowTokenDetails] = useState(false);
  const [isContextModalOpen, setIsContextModalOpen] = useState(false);
  const [showInlineReferences, setShowInlineReferences] = useState(false);
  const [bulkInput, setBulkInput] = useState('');
  const [isBulkRefining, setIsBulkRefining] = useState(false);
  const [lastAiTokenUsage, setLastAiTokenUsage] = useState<{ label: string; input: number; output: number; total: number } | null>(null);
  const initiativeGroups = generationContext?.initiativeGroups ?? [];
  const hasInlineReferences = Boolean(
    generationContext?.referencedGoldExamples?.length ||
    generationContext?.referencedWiDocs?.length ||
    generationContext?.referencedSimilarStories?.length,
  );
  const featureIndexById = new Map(features.map((feature, index) => [feature.id, index] as const));
  const featureGroupTitleById = new Map<string, string>();
  const groupedFeatureIds = new Set<string>();

  initiativeGroups.forEach(group => {
    group.featureIds.forEach(featureId => {
      if (featureIndexById.has(featureId)) {
        groupedFeatureIds.add(featureId);
        featureGroupTitleById.set(featureId, group.title);
      }
    });
  });

  const featureSections: FeatureSection[] = initiativeGroups.length
    ? [
        ...initiativeGroups
          .map(group => ({
            id: group.id,
            title: group.title,
            summary: group.summary,
            items: group.featureIds
              .map(featureId => {
                const index = featureIndexById.get(featureId);
                return index === undefined ? null : { feature: features[index], index };
              })
              .filter((item): item is { feature: Feature; index: number } => item !== null),
          }))
          .filter(section => section.items.length > 0),
        ...(features.some(feature => !groupedFeatureIds.has(feature.id))
          ? [{
              id: 'ungrouped-features',
              title: 'Additional features',
              summary: 'These items remained outside the generated initiative groupings.',
              items: features
                .map((feature, index) => ({ feature, index }))
                .filter(({ feature }) => !groupedFeatureIds.has(feature.id)),
            }]
          : []),
      ]
    : [{
        id: 'all-features',
        title: 'Generated features',
        summary: '',
        items: features.map((feature, index) => ({ feature, index })),
      }];
  const hasInitiativeSections = initiativeGroups.length > 0 && featureSections.some(section => section.items.length > 0);

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
      const res = await api.refineFeatures(sessionId, requirement, features, bulkInput, outputInstructions) as any;
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
        className={`group overflow-hidden rounded-xl border ${feature.pendingRemoval ? 'opacity-70 border-rose-200 bg-white' : feature.isAccepted ? 'border-emerald-200 bg-emerald-50/20' : 'border-[var(--rf-border)] bg-white'}`}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: animationIndex * 0.04, duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        style={{ boxShadow: '0 2px 8px -2px rgba(31,30,29,0.04)' }}
        whileHover={{ y: -1, boxShadow: '0 4px 12px -2px rgba(31,30,29,0.06)' }}
      >
        <div className="flex flex-col sm:flex-row">
          <div className={`h-1 sm:h-auto sm:w-1.5 shrink-0 ${feature.pendingRemoval ? 'bg-rose-500' : feature.isAccepted ? 'bg-emerald-500' : 'bg-slate-300'}`} />

          <div className="flex-1 p-3 sm:p-3.5">
            <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-2 mb-2">
              {isEditing ? (
                <input
                  type="text"
                  value={draft?.title || draft?.summary || ''}
                  onChange={e => setEditDraft(d => d ? { ...d, summary: e.target.value, title: e.target.value } : null)}
                  className="flex-1 text-base font-bold text-[var(--rf-text)] bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-[var(--rf-brand)]/20 outline-none transition"
                />
              ) : (
                <div className="flex-1 min-w-0 flex items-center gap-2 cursor-pointer" onClick={() => toggleExpand(idx)}>
                  <h3 className="min-w-0 flex-1 text-base font-bold leading-tight text-slate-800 tracking-tight">
                    {feature.title || feature.summary || 'Untitled Feature'}
                  </h3>
                  <div className="shrink-0 flex items-center gap-1.5">
                    <span className="inline-flex items-center rounded-md px-1.5 py-0.5 bg-slate-100 text-slate-500 text-[10px] font-bold border border-slate-200">
                      {feature.acceptanceRequirements?.length || 0} ARs
                    </span>
                    <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-200 ${expandedIndices.has(idx) ? 'rotate-180' : ''}`} />
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-1 shrink-0">
                {isEditing ? (
                  <>
                    <button onClick={cancelEditing} className="px-2 py-1 text-[10px] font-bold text-slate-500 hover:bg-slate-100 rounded-md transition">Cancel</button>
                    <button onClick={saveEditing} className="px-2.5 py-1 text-[10px] font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-md transition shadow-sm">Save</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => startEditing(idx)} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-md transition" title="Edit"><Edit2 className="w-3.5 h-3.5" /></button>
                    <button onClick={() => setRefinePopupIdx(idx)} className="p-1.5 text-[var(--rf-brand)] hover:bg-blue-50 rounded-md transition" title="AI Refine"><Sparkles className="w-3.5 h-3.5" /></button>
                    <button onClick={() => toggleAccepted(idx)} className={`px-2 py-1 text-[10px] font-bold rounded-md transition border flex items-center gap-1.5 ${feature.isAccepted ? 'text-white bg-emerald-500 border-emerald-500' : 'text-slate-600 bg-white border-slate-200 hover:bg-emerald-50 hover:text-emerald-600 hover:border-emerald-200'}`}>
                      <Check className="w-3 h-3" /> {feature.isAccepted ? 'Accepted' : 'Accept'}
                    </button>
                    <button onClick={() => requestFeatureRemoval(idx)} className="p-1.5 text-rose-400 hover:text-rose-600 hover:bg-rose-50 rounded-md transition" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
                    
                    {feature.jiraIssueKey ? (
                      <button
                        onClick={() => feature.jiraIssueUrl ? router.navigate(feature.jiraIssueUrl) : null}
                        className="px-2 py-1 text-[10px] font-bold text-[var(--rf-brand)] bg-blue-50 border border-blue-100 rounded-md transition flex items-center gap-1"
                      >
                        <Check className="w-3 h-3" /> {feature.jiraIssueKey}
                      </button>
                    ) : (
                      <button
                        onClick={() => onPushFeature(idx)}
                        disabled={!feature.isAccepted}
                        className="px-2 py-1 text-[10px] font-bold text-white bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] disabled:bg-slate-200 disabled:text-slate-400 rounded-md transition flex items-center gap-1 shadow-sm"
                      >
                        <Upload className="w-3 h-3" /> Push
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>

            {!isEditing && (
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-medium text-slate-500">
                <span>{feature.acceptanceRequirements?.length || 0} criteria</span>
                {feature.storyPoints && <span>· SP {feature.storyPoints}</span>}
                {feature.processCode && <span className="bg-slate-100 px-1 rounded text-[9px] uppercase font-bold">{feature.processCode}</span>}
              </div>
            )}

            {feature.pendingRemoval && (
              <div className="mb-3 p-3 rounded-lg bg-rose-50 border border-rose-100 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-rose-600 font-bold text-xs">
                  <Trash2 className="w-3.5 h-3.5" /> Proposed for Removal
                </div>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => clearPendingRemoval(idx)} className="px-2.5 py-1 text-[10px] font-bold text-slate-600 bg-white border border-slate-200 rounded-md shadow-sm">Keep</button>
                  <button onClick={() => removeFeatureAt(idx)} className="px-2.5 py-1 text-[10px] font-bold text-white bg-rose-600 rounded-md shadow-sm">Confirm</button>
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
                <div className="mb-4 p-3 rounded-xl bg-amber-50 border border-amber-100">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <h4 className="text-amber-700 font-bold text-[10px] uppercase tracking-wider flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5" /> Proposed Refinements</h4>
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => rejectRefinement(idx)} className="px-2 py-1 text-[10px] font-bold text-slate-600 bg-white border border-slate-200 rounded-md shadow-sm">Reject</button>
                      <button onClick={() => acceptRefinement(idx)} className="px-2 py-1 text-[10px] font-bold text-white bg-amber-600 rounded-md shadow-sm">Accept</button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <div className="bg-white p-2.5 rounded-lg border border-slate-200 shadow-sm text-[11px]">
                      <div className="text-[9px] font-bold text-slate-400 uppercase mb-1">Current</div>
                      <h4 className="font-bold text-slate-800 mb-1">{origTitle}</h4>
                      <div className="text-slate-500 whitespace-pre-wrap line-clamp-2">{origDesc}</div>
                    </div>
                    <div className="bg-white p-2.5 rounded-lg border border-amber-200 shadow-sm text-[11px]">
                      <div className="text-[9px] font-bold text-amber-600 uppercase mb-1">Proposed</div>
                      <h4 className="font-bold text-slate-800 mb-1"><DiffText oldText={origTitle} newText={propTitle} mode={diffMode} /></h4>
                      <div className="text-slate-500 whitespace-pre-wrap line-clamp-2"><DiffText oldText={origDesc} newText={propDesc} mode={diffMode} /></div>
                    </div>
                  </div>
                </div>
              );
            })()}

            {(expandedIndices.has(idx) || isEditing) && (
              <div className={`mt-3 ${feature.pendingRefinement ? 'opacity-50 pointer-events-none' : ''}`}>
                {isEditing ? (
                  <textarea
                    value={draft?.description || ''}
                    onChange={e => setEditDraft(d => d ? { ...d, description: e.target.value } : null)}
                    className="w-full text-sm bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 min-h-[100px] mb-4 outline-none focus:ring-2 focus:ring-[var(--rf-brand)]/20 transition resize-y"
                  />
                ) : (
                  <div className="text-slate-600 text-xs sm:text-[13px] mb-3 whitespace-pre-wrap leading-relaxed border-l-2 border-blue-100 pl-3">
                    {feature.markdown || feature.description}
                  </div>
                )}

                {((isEditing && draft?.acceptanceRequirements) || (!isEditing && feature.acceptanceRequirements?.length > 0)) && (
                  <div className="mt-2">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Acceptance Criteria</h4>
                      {isEditing && (
                        <button onClick={addDraftAr} className="text-[10px] font-bold text-[var(--rf-brand)] hover:underline flex items-center gap-1"><Plus className="w-3 h-3" /> Add AR</button>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      {(isEditing ? draft!.acceptanceRequirements : feature.acceptanceRequirements).map((ar, i) => (
                        <div key={i} className="bg-slate-50 rounded-lg p-2.5 border border-slate-100 relative group transition hover:border-slate-200">
                          {isEditing && (
                            <button onClick={() => deleteDraftAr(i)} className="absolute top-2 right-2 p-1 text-slate-300 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition"><Trash2 className="w-3.5 h-3.5" /></button>
                          )}
                          <div className="space-y-1 text-xs sm:text-[13px]">
                            {ar.given?.trim() && (
                              <div className="flex gap-2">
                                <span className="w-9 shrink-0 text-[9px] font-bold text-slate-400 uppercase pt-0.5">Given</span>
                                <span className="text-slate-600 leading-tight">{ar.given}</span>
                              </div>
                            )}
                            {ar.when?.trim() && (
                              <div className="flex gap-2">
                                <span className="w-9 shrink-0 text-[9px] font-bold text-slate-400 uppercase pt-0.5">When</span>
                                <span className="text-slate-600 leading-tight">{ar.when}</span>
                              </div>
                            )}
                            <div className="flex gap-2">
                              <span className="w-9 shrink-0 text-[9px] font-bold text-[var(--rf-brand)] uppercase pt-0.5">Then</span>
                              <span className="text-slate-800 font-medium leading-tight">{ar.then}</span>
                            </div>
                          </div>
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
      {/* ─── Compact Single-Layer Header ─── */}
      <header className="h-14 shrink-0 bg-white border-b border-[var(--rf-border-subtle)] px-4 flex items-center justify-between sticky top-0 z-30 shadow-sm shadow-slate-200/50">
        <div className="flex items-center gap-3 overflow-hidden">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-1.5 hover:bg-slate-100 rounded-lg text-[var(--rf-text-tertiary)] transition"
          >
            <Menu className="w-4 h-4" />
          </button>
          
          <div className="h-4 w-px bg-[var(--rf-border-subtle)]" />
          
          <div className="flex items-center gap-2 overflow-hidden">
            <h1 className="font-bold text-sm text-[var(--rf-text)] whitespace-nowrap">Feature Canvas</h1>
            {projectKey && (
              <span className="hidden sm:inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-500 border border-slate-200 uppercase tracking-tight">
                {projectKey === '*' ? 'GLOBAL' : projectKey}
              </span>
            )}
          </div>
          
          {hasFeatures && (
            <>
              <div className="h-3 w-px bg-[var(--rf-border-subtle)] mx-1" />
              <div className="flex items-center gap-2.5 text-[11px] font-medium text-[var(--rf-text-tertiary)]">
                <span className="whitespace-nowrap"><b className="text-[var(--rf-text-secondary)]">{features.length}</b> Features</span>
                <span className="whitespace-nowrap"><b className="text-[var(--rf-text-secondary)]">{totalArCount}</b> ARs</span>
              </div>
            </>
          )}

          {isGenerating && (
            <div className="flex items-center gap-2 ml-2 px-2 py-1 bg-blue-50 rounded-lg border border-blue-100 shadow-sm animate-pulse-subtle">
              <div className="dot-bounce text-[var(--rf-brand)] shrink-0 scale-75"><span /><span /><span /></div>
              <span className="text-[10px] font-bold text-[var(--rf-brand)] uppercase tracking-wider truncate max-w-[120px]">
                {loadingTitle || 'Working'}...
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {hasFeatures && (
            <div className="flex items-center gap-1.5">
              <button
                onClick={exportFeaturesToExcel}
                className="flex items-center gap-1.5 h-8 px-2.5 text-[11px] font-bold text-[var(--rf-text-secondary)] hover:bg-slate-100 border border-[var(--rf-border)] rounded-lg transition"
              >
                <Download className="w-3.5 h-3.5" />
                <span className="hidden md:inline">Export</span>
              </button>
              
              <div className="relative">
                <button
                  onClick={() => setShowBulkRefine(!showBulkRefine)}
                  className={`flex items-center gap-1.5 h-8 px-3 text-[11px] font-bold rounded-lg shadow-sm transition ${showBulkRefine ? 'bg-[var(--rf-text)] text-white' : 'bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] text-white'}`}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Refine All</span>
                </button>
                
                <AnimatePresence>
                  {showBulkRefine && (
                    <motion.div
                      className="absolute right-0 top-full mt-2 w-[400px] bg-white rounded-xl border border-[var(--rf-border)] p-4 z-50 shadow-2xl"
                      initial={{ opacity: 0, y: -8, scale: 0.96 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -8, scale: 0.96 }}
                      transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                    >
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="text-[10px] font-bold text-[var(--rf-text)] uppercase tracking-[0.15em] flex items-center gap-2">
                           <Sparkles className="w-3.5 h-3.5 text-[var(--rf-brand)]" /> Bulk Refine
                        </h4>
                        <button onClick={() => setShowBulkRefine(false)} className="p-1 hover:bg-slate-100 rounded-lg transition text-[var(--rf-text-tertiary)]"><X className="w-3.5 h-3.5" /></button>
                      </div>
                      <textarea
                        autoFocus
                        placeholder="e.g. Make all stories more technical..."
                        value={bulkInput}
                        onChange={(e) => setBulkInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleBulkRefine(); }}
                        className="w-full bg-slate-50 border border-[var(--rf-border)] rounded-lg p-3 text-sm min-h-[100px] outline-none focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition resize-none mb-3"
                      />
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[10px] font-medium text-[var(--rf-text-tertiary)]">\u2318 + Enter to apply</span>
                        <button
                          onClick={handleBulkRefine}
                          disabled={!bulkInput.trim() || isBulkRefining}
                          className="px-4 py-1.5 bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] text-white text-xs font-bold rounded-lg transition disabled:opacity-40 flex items-center gap-2"
                        >
                          {isBulkRefining ? <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Send className="w-3 h-3" />}
                          Apply
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          )}
          
          <div className="h-4 w-px bg-[var(--rf-border-subtle)] mx-1" />
          
          <div className="relative">
            <button
              onClick={() => setShowTokenDetails(!showTokenDetails)}
              className={`flex items-center gap-1.5 h-8 px-2.5 text-[11px] font-semibold rounded-lg transition ${showTokenDetails ? 'bg-slate-100 text-[var(--rf-text-secondary)]' : 'text-[var(--rf-text-tertiary)] hover:bg-slate-50 hover:text-[var(--rf-text-secondary)]'}`}
            >
              <Coins className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Tokens</span>
            </button>
            <AnimatePresence>
              {showTokenDetails && (
                <motion.div
                  className="absolute right-0 top-full mt-2 w-[240px] rounded-xl border border-[var(--rf-border)] bg-white p-4 shadow-xl z-50"
                  initial={{ opacity: 0, y: -8, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -8, scale: 0.96 }}
                  transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                >
                  <div className="text-[9px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Workflow tokens</div>
                  <div className="mt-1 text-xl font-bold text-[var(--rf-text)] tracking-tight">
                    {(workflowTokenUsage?.total ?? 0).toLocaleString()}
                  </div>
                  <div className="mt-1 text-[10px] font-medium text-[var(--rf-text-tertiary)]">
                    {(workflowTokenUsage?.input ?? 0).toLocaleString()} in / {(workflowTokenUsage?.output ?? 0).toLocaleString()} out
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
        
        {isGenerating && (
          <div className="absolute bottom-0 left-0 right-0 h-[2px] overflow-hidden">
            <div
              className="h-full bg-[var(--rf-brand)] transition-[width] duration-700 ease-out"
              style={{ width: `${generationStageProgress}%` }}
            />
          </div>
        )}
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto w-full flex flex-col items-center relative custom-scrollbar p-6">
        {isGenerating && !hasFeatures ? (
          <GeneratingSkeleton loadingTitle={loadingTitle} progress={progress} />
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
                    Context: <span className="font-medium text-[var(--rf-text-secondary)]">{generationContext.goldExamplesCount} example{generationContext.goldExamplesCount !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="font-bold text-[var(--rf-text)]">
                    Project: <span className="font-medium text-[var(--rf-text-secondary)]">{generationContext.projectKey === '*' ? 'Global' : generationContext.projectKey}</span>
                  </div>
                  <div className="font-bold text-[var(--rf-text)]">
                    Domain guidance: <span className="font-medium text-[var(--rf-text-secondary)]">{generationContext.domainContextApplied ? 'Included' : 'None'}</span>
                  </div>
                  <div className="font-bold text-[var(--rf-text)]">
                    Attachment: <span className="font-medium text-[var(--rf-text-secondary)]">{generationContext.attachmentIncluded ? 'Included' : 'None'}</span>
                  </div>
                  {generationContext.plannerDecision && (
                    <>
                      <div className="font-bold text-[var(--rf-text)]">
                        Scope: <span className="font-medium text-[var(--rf-text-secondary)]">{formatPlannerLabel(generationContext.plannerDecision.scopeMode)}</span>
                      </div>
                      <div className="font-bold text-[var(--rf-text)]">
                        Target: <span className="font-medium text-[var(--rf-text-secondary)]">{generationContext.plannerDecision.featurePlan.target} features</span>
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
                      {generationContext.initiativeGroups?.length ? (
                        <div className="font-bold text-[var(--rf-text)]">
                          Structure: <span className="font-medium text-[var(--rf-text-secondary)]">{generationContext.initiativeGroups.length} initiative group{generationContext.initiativeGroups.length !== 1 ? 's' : ''}</span>
                        </div>
                      ) : null}
                    </>
                  )}
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
                    {generationContext.referencedGoldExamples?.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {generationContext.referencedGoldExamples.map((example, i) => (
                          <span
                            key={`${example.source}-${example.key}-${i}`}
                            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[10px] font-bold tracking-wide bg-[var(--rf-brand-muted)] text-[var(--rf-brand-hover)] border border-blue-100"
                            title={example.summary}
                          >
                            {example.source}: {example.key}
                          </span>
                        ))}
                      </div>
                    )}
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

            {hasInitiativeSections && (
              <motion.div
                className="rounded-2xl border border-[var(--rf-border)] bg-[var(--rf-brand-muted)]/45 p-5 shadow-sm"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="inline-flex items-center rounded-full border border-[var(--rf-brand-subtle)] bg-white px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--rf-brand)]">
                    Initiative structure
                  </span>
                  <div className="text-sm font-semibold text-[var(--rf-text)]">
                    {initiativeGroups.length} group{initiativeGroups.length !== 1 ? 's' : ''} organizing {features.length} generated features
                  </div>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {featureSections.map(section => (
                    <div key={section.id} className="rounded-2xl border border-[var(--rf-border)] bg-white/85 p-4">
                      <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">
                        {section.items.length} feature{section.items.length !== 1 ? 's' : ''}
                      </div>
                      <div className="mt-1 text-base font-bold text-[var(--rf-text)]">{section.title}</div>
                      <div className="mt-2 text-sm text-[var(--rf-text-secondary)]">{section.summary}</div>
                    </div>
                  ))}
                </div>
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
          <div className="grid gap-4 md:grid-cols-7">
            <ContextStatCard label="Project" value={contextMeta.projectKey === '*' ? 'Global' : contextMeta.projectKey} />
            <ContextStatCard label="Examples" value={`${contextMeta.goldExamplesCount ?? 0}`} />
            <ContextStatCard label="Work instructions" value={`${contextMeta.wiDocsCount ?? 0}`} />
            <ContextStatCard label="Related stories" value={`${contextMeta.similarStoriesCount ?? 0}`} />
            <ContextStatCard label="Initiative groups" value={`${contextMeta.initiativeGroups?.length ?? 0}`} />
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
                {contextMeta.plannerDecision && (
                  <>
                    <div><strong className="text-[var(--rf-text)]">Scope:</strong> {formatPlannerLabel(contextMeta.plannerDecision.scopeMode)}</div>
                    <div><strong className="text-[var(--rf-text)]">Discovery:</strong> {formatPlannerLabel(contextMeta.plannerDecision.clarificationMode)}</div>
                    <div><strong className="text-[var(--rf-text)]">Reasoning:</strong> {formatPlannerLabel(contextMeta.plannerDecision.reasoningMode)}</div>
                    <div><strong className="text-[var(--rf-text)]">Target output:</strong> {contextMeta.plannerDecision.featurePlan.target} feature(s)</div>
                    <div className="md:col-span-2"><strong className="text-[var(--rf-text)]">Planner rationale:</strong> {contextMeta.plannerDecision.rationale.join(' ') || 'No additional rationale recorded.'}</div>
                  </>
                )}
                <div className="md:col-span-2"><strong className="text-[var(--rf-text)]">Tokens:</strong> {contextMeta.tokenUsage ? `${contextMeta.tokenUsage.total.toLocaleString()} total (${contextMeta.tokenUsage.input.toLocaleString()} in / ${contextMeta.tokenUsage.output.toLocaleString()} out)` : 'Not available'}</div>
              </div>
            </div>

          {contextMeta.initiativeGroups?.length ? (
            <section className="mt-6 rounded-2xl border border-[var(--rf-border)] bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-[var(--rf-brand)]" />
                <h3 className="text-sm font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Initiative groups</h3>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {contextMeta.initiativeGroups.map(group => (
                  <div key={group.id} className="rounded-2xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)]/55 p-4">
                    <div className="text-sm font-bold text-[var(--rf-text)]">{group.title}</div>
                    <div className="mt-2 text-sm text-[var(--rf-text-secondary)]">{group.summary}</div>
                    <div className="mt-3 inline-flex rounded-md bg-white px-2 py-1 text-[11px] font-medium text-[var(--rf-text-tertiary)] border border-[var(--rf-border-subtle)]">
                      {group.featureIds.length} feature{group.featureIds.length !== 1 ? 's' : ''}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

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
                            Match {formatMatchPercent(story.relevanceScore)}%
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
