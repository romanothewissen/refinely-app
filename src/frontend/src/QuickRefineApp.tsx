import React, { startTransition, useCallback, useEffect, useMemo, useState } from 'react';
import { router, view } from '@forge/bridge';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  ArrowRight,
  Check,
  ClipboardPenLine,
  CopyCheck,
  ExternalLink,
  Loader2,
  MessagesSquare,
  PencilLine,
  Plus,
  RefreshCcw,
  Sparkles,
  SplitSquareVertical,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react';
import { api } from './hooks/useForge';
import { DiffText, alignAcceptanceRequirementsDetailed } from './diffUtils';
import { getCatalogEntriesForProvider, getCatalogModelId } from './modelStrategy';
import type {
  AcceptanceRequirement,
  LlmModelCatalogByVendor,
  LlmProvider,
  QuickRefineAnswer,
  QuickRefineApplyResult,
  QuickRefineDraft,
  QuickRefineIssueContext,
  QuickRefineIssueFields,
  QuickRefineQuestion,
  QuickRefineSession,
  QuickRefineSurface,
  SplitCandidate,
} from './types';

type Stage = 'idle' | 'loading' | 'questions' | 'draft' | 'handoff';
type DraftViewMode = 'diff' | 'result';

interface QuickRefineAppProps {
  surface: QuickRefineSurface;
  onOpenFullWorkflow?: () => void;
  onOpenSettings?: () => void;
  initialState?: QuickRefineViewState | null;
  onStateChange?: (state: QuickRefineViewState | null) => void;
}

export interface QuickRefineViewState {
  issueKey: string;
  projectKey: string;
  sessionId: string;
  stage: Stage;
  active: boolean;
  draftViewMode: DraftViewMode;
  modelOverride: string;
  session: QuickRefineSession | null;
  questions: QuickRefineQuestion[];
  answers: QuickRefineAnswer[];
  draft: QuickRefineDraft | null;
  handoffReason: string;
  applyResult: QuickRefineApplyResult | null;
  diffBaseIssue: QuickRefineIssueFields | null;
}

interface AiPromptDialogProps {
  open: boolean;
  title: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (instructions: string) => void;
}

function createSessionId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `quick_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

function emptyAr(): AcceptanceRequirement {
  return { given: '', when: '', then: '' };
}

function emptySplitCandidate(): SplitCandidate {
  return {
    id: createSessionId(),
    summary: '',
    description: '',
    acceptanceRequirements: [emptyAr()],
    issueType: 'Story',
    selected: true,
  };
}

function isFieldChanged(left: string, right: string) {
  return left.trim() !== right.trim();
}

function arsChanged(left: AcceptanceRequirement[], right: AcceptanceRequirement[]) {
  return JSON.stringify(left) !== JSON.stringify(right);
}

function formatRelativeTimestamp(value?: string | null) {
  if (!value) return 'No saved draft';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Saved draft';
  return date.toLocaleString();
}

function getSessionBadgeCopy(session: QuickRefineSession | null) {
  if (!session) return 'Ready';
  if (session.status === 'queued') return 'Queued';
  if (session.status === 'running') return 'Refining';
  if (session.status === 'failed') return 'Needs retry';
  if (session.draft) return 'Draft ready';
  if (session.status === 'needs_clarification') return 'Questions ready';
  if (session.status === 'handoff') return 'Needs handoff';
  if (session.status === 'applied') return 'Applied';
  return 'Ready';
}

function buildModelOptions(
  provider: LlmProvider | null,
  modelCatalogs: LlmModelCatalogByVendor,
  fallbackModels: string[] = [],
) {
  if (!provider) return [];
  const { entries } = getCatalogEntriesForProvider(provider, modelCatalogs);
  const options = new Map<string, string>();
  entries.forEach((entry) => {
    const id = getCatalogModelId(entry);
    if (!id) return;
    options.set(id, entry.displayName || entry.id);
  });
  fallbackModels.forEach((modelId) => {
    const trimmed = String(modelId ?? '').trim();
    if (trimmed && !options.has(trimmed)) {
      options.set(trimmed, trimmed);
    }
  });
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...options.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((left, right) => collator.compare(left.label, right.label));
}

function formatArText(ar: AcceptanceRequirement): string {
  const parts = [
    ar.given.trim() ? `GIVEN ${ar.given.trim()}` : '',
    ar.when.trim() ? `WHEN ${ar.when.trim()}` : '',
    ar.then.trim() ? `THEN ${ar.then.trim()}` : '',
  ].filter(Boolean);
  return parts.join('\n');
}

function parseArText(value: string): AcceptanceRequirement {
  const text = String(value ?? '').trim();
  const givenMatch = text.match(/GIVEN\s+([\s\S]+?)(?=\s+(?:WHEN|THEN)\b|$)/i);
  const whenMatch = text.match(/WHEN\s+([\s\S]+?)(?=\s+THEN\b|$)/i);
  const thenMatch = text.match(/THEN\s+([\s\S]+)$/i);

  return {
    given: (givenMatch?.[1] ?? '').replace(/\s+/g, ' ').trim(),
    when: (whenMatch?.[1] ?? '').replace(/\s+/g, ' ').trim(),
    then: (thenMatch?.[1] ?? text.replace(/^(GIVEN|WHEN|THEN)\s+/i, '')).replace(/\s+/g, ' ').trim(),
  };
}

function CompactArEditor({
  ars,
  onChange,
}: {
  ars: AcceptanceRequirement[];
  onChange: (next: AcceptanceRequirement[]) => void;
}) {
  return (
    <div className="space-y-2">
      {ars.map((ar, index) => (
        <div key={`ar-${index}`} className="rounded-[18px] border border-[rgba(43,89,74,0.12)] bg-[linear-gradient(180deg,rgba(255,255,255,0.9),rgba(245,249,246,0.86))] p-2.5 space-y-2 shadow-[0_10px_24px_rgba(15,23,42,0.04)]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">AR {index + 1}</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[11px] text-[var(--rf-danger)]"
              onClick={() => onChange(ars.filter((_, candidateIndex) => candidateIndex !== index))}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
          </div>
          <label className="block rounded-[16px] border border-[var(--rf-border-subtle)] bg-white/92 px-2.5 py-2 space-y-1">
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">Acceptance Requirement</span>
            <textarea
              rows={4}
              value={formatArText(ar)}
              onChange={(event) => {
                const next = [...ars];
                next[index] = parseArText(event.target.value);
                onChange(next);
              }}
              placeholder={'GIVEN ...\nWHEN ...\nTHEN ...'}
              className="w-full min-h-[88px] resize-y rounded-xl border border-[var(--rf-border)] bg-white px-2.5 py-2 text-sm leading-6 text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand-subtle)]"
            />
          </label>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...(ars.length ? ars : []), emptyAr()])}
        className="inline-flex items-center gap-2 rounded-lg border border-dashed border-[var(--rf-border-strong)] px-3 py-1.5 text-sm font-semibold text-[var(--rf-brand)] transition hover:border-[var(--rf-brand)] hover:bg-[var(--rf-brand-subtle)]"
      >
        <Plus className="w-4 h-4" />
        Add AR
      </button>
    </div>
  );
}

function CompactArDiff({
  original,
  proposed,
  mode,
}: {
  original: AcceptanceRequirement[];
  proposed: AcceptanceRequirement[];
  mode: DraftViewMode;
}) {
  const rows = alignAcceptanceRequirementsDetailed(original, proposed);

  return (
    <div className="space-y-2">
      {rows.map((row, index) => {
        const isRemoved = row.type === 'removed';
        const isAdded = row.type === 'added';
        const current = row.type === 'removed' ? row.oldAr : row.proposed;
        const previous = row.type === 'matched' ? row.oldAr : undefined;
        return (
          <div
            key={`${row.type}-${index}`}
            className={`rounded-xl border px-3 py-2 text-sm ${
              isRemoved
                ? 'border-[rgba(155,53,69,0.16)] bg-[rgba(155,53,69,0.05)]'
                : isAdded
                  ? 'border-[rgba(46,125,86,0.16)] bg-[rgba(46,125,86,0.05)]'
                  : 'border-[var(--rf-border)] bg-white/70'
            }`}
          >
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">AR {index + 1}</span>
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--rf-text-tertiary)]">
                {isRemoved ? 'Removed' : isAdded ? 'Added' : 'Updated'}
              </span>
            </div>
            <div className="rounded-lg border border-[var(--rf-border-subtle)] bg-white/80 px-2.5 py-2 leading-6 text-[var(--rf-text)] whitespace-pre-wrap">
              <DiffText
                oldText={formatArText(previous || current)}
                newText={isRemoved ? '' : formatArText(current)}
                fullHighlight={isAdded}
                mode={mode === 'diff' ? 'redline' : 'blackline'}
              />
            </div>
          </div>
        );
      })}
      {!rows.length ? (
        <div className="rounded-xl border border-dashed border-[var(--rf-border-strong)] px-3 py-2 text-sm text-[var(--rf-text-tertiary)]">
          No acceptance requirements yet.
        </div>
      ) : null}
    </div>
  );
}

function AiPromptDialog({ open, title, busy, error, onClose, onSubmit }: AiPromptDialogProps) {
  const [instructions, setInstructions] = useState('');

  useEffect(() => {
    if (!open) {
      setInstructions('');
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[var(--rf-text)]/35 backdrop-blur-sm" onClick={busy ? undefined : onClose} />
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="relative rf-card w-full max-w-xl p-5 space-y-4"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-[var(--rf-text-tertiary)]">AI Refine</p>
            <h3 className="text-xl font-semibold text-[var(--rf-text)]">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-xl border border-[var(--rf-border)] bg-white px-3 py-2 text-[var(--rf-text-secondary)] transition hover:border-[var(--rf-border-strong)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <textarea
          rows={5}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder='Example: "Tighten the scope to internal users only and add one AR for invalid input."'
          className="w-full rounded-2xl border border-[var(--rf-border)] bg-white/80 px-4 py-3 text-sm text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand-subtle)]"
        />
        {error ? (
          <div className="rounded-2xl border border-[var(--rf-danger)]/20 bg-[var(--rf-danger-subtle)] px-4 py-3 text-sm text-[var(--rf-danger)]">
            {error}
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-[var(--rf-text-tertiary)]">Refines the current draft without discarding your manual edits.</p>
          <button
            type="button"
            disabled={busy || !instructions.trim()}
            onClick={() => onSubmit(instructions)}
            className="inline-flex items-center gap-2 rounded-2xl bg-[var(--rf-brand)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--rf-brand-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <WandSparkles className="w-4 h-4" />}
            Refine Draft
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function DraftCard({
  title,
  changed,
  children,
  actions,
}: {
  title: string;
  changed?: boolean;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="rf-card overflow-hidden border border-[rgba(43,89,74,0.12)] shadow-[0_16px_40px_rgba(16,24,40,0.07)]">
      <div className="flex items-center justify-between gap-3 border-b border-[rgba(43,89,74,0.1)] bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(245,249,246,0.9))] px-4 py-3">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-semibold text-[var(--rf-text)]">{title}</h3>
          {typeof changed === 'boolean' ? (
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.18em] ${changed ? 'bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)]' : 'bg-[var(--rf-surface-soft)] text-[var(--rf-text-tertiary)]'}`}>
              {changed ? 'Updated' : 'Unchanged'}
            </span>
          ) : null}
        </div>
        {actions}
      </div>
      <div className="p-4 space-y-3">{children}</div>
    </div>
  );
}

export function QuickRefineApp({ surface, onOpenFullWorkflow, onOpenSettings, initialState = null, onStateChange }: QuickRefineAppProps) {
  const [issueKey, setIssueKey] = useState('');
  const [projectKey, setProjectKey] = useState('');
  const [provider, setProvider] = useState<LlmProvider | null>(null);
  const [modelCatalogs, setModelCatalogs] = useState<LlmModelCatalogByVendor>({});
  const [modelOverride, setModelOverride] = useState('');
  const [context, setContext] = useState<QuickRefineIssueContext | null>(null);
  const [session, setSession] = useState<QuickRefineSession | null>(null);
  const [sessionId, setSessionId] = useState<string>('');
  const [stage, setStage] = useState<Stage>('idle');
  const [active, setActive] = useState(surface === 'issue-action');
  const [draftViewMode, setDraftViewMode] = useState<DraftViewMode>('result');
  const [busyLabel, setBusyLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [questions, setQuestions] = useState<QuickRefineQuestion[]>([]);
  const [answers, setAnswers] = useState<QuickRefineAnswer[]>([]);
  const [draft, setDraft] = useState<QuickRefineDraft | null>(null);
  const [handoffReason, setHandoffReason] = useState('');
  const [applyResult, setApplyResult] = useState<QuickRefineApplyResult | null>(null);
  const [aiDialogOpen, setAiDialogOpen] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [diffBaseIssue, setDiffBaseIssue] = useState<QuickRefineIssueFields | null>(initialState?.diffBaseIssue ?? null);

  useEffect(() => {
    let cancelled = false;

    const hydrate = async () => {
      try {
        const bridgeContext = await view.getContext() as any;
        const nextIssueKey = String(bridgeContext?.extension?.issue?.key ?? '').trim();
        const nextProjectKey = String(
          bridgeContext?.extension?.project?.key
          ?? bridgeContext?.extension?.projectKey
          ?? nextIssueKey.split('-')[0]
          ?? '',
        ).trim();

        if (!nextIssueKey) {
          if (!cancelled) setLoadError('Quick refine is only available from a Jira issue view.');
          return;
        }

        if (cancelled) return;
        setIssueKey(nextIssueKey);
        setProjectKey(nextProjectKey);

        const [contextRes, configRes, preferencesRes] = await Promise.all([
          api.getQuickRefineIssueContext({
            issueKey: nextIssueKey,
            projectKey: nextProjectKey,
            surface,
          }) as Promise<any>,
          api.getConfig() as Promise<any>,
          api.getUserPreferences() as Promise<any>,
        ]);
        if (!contextRes?.success) {
          throw new Error(contextRes?.error || 'Could not load issue context.');
        }

        if (cancelled) return;
        const nextContext = contextRes.context as QuickRefineIssueContext;
        const nextProvider = (configRes?.generatorConfig?.provider ?? null) as LlmProvider | null;
        const nextModelCatalogs = (configRes?.generatorConfig?.modelCatalogs ?? {}) as LlmModelCatalogByVendor;
        const configuredModels = [
          configRes?.generatorConfig?.refineModel,
          configRes?.generatorConfig?.clarifyModel,
        ];
        const nextModelOptions = buildModelOptions(nextProvider, nextModelCatalogs, configuredModels);
        const preferredModel = String(preferencesRes?.quickRefineModelByProvider?.[nextProvider ?? ''] ?? '').trim();
        const validPreferredModel = preferredModel && nextModelOptions.some((option) => option.id === preferredModel)
          ? preferredModel
          : String(configRes?.generatorConfig?.refineModel ?? '').trim();

        setContext(nextContext);
        setProvider(nextProvider);
        setModelCatalogs(nextModelCatalogs);
        setModelOverride(validPreferredModel);

        if (initialState && initialState.issueKey === nextIssueKey) {
          startTransition(() => {
            setProjectKey(initialState.projectKey || nextProjectKey);
            setSession(initialState.session);
            setSessionId(initialState.sessionId);
            setApplyResult(initialState.applyResult || null);
            setHandoffReason(initialState.handoffReason || '');
            setQuestions(initialState.questions || []);
            setAnswers(initialState.answers || []);
            setDraft(initialState.draft || null);
            setStage(initialState.stage);
            setActive(initialState.active);
            setDraftViewMode(initialState.draftViewMode);
            setModelOverride(initialState.modelOverride || validPreferredModel);
            setDiffBaseIssue(initialState.diffBaseIssue || initialState.draft?.diffBaseIssue || nextContext.originalIssue);
          });
          return;
        }

        if (preferredModel && preferredModel !== validPreferredModel && nextProvider) {
          void api.saveUserPreferences({
            quickRefineModelByProvider: {
              [nextProvider]: validPreferredModel,
            },
          }).catch(() => {});
        }

        if (nextContext.existingSessionId) {
          const sessionRes = await api.getQuickRefineSession({ sessionId: nextContext.existingSessionId }) as any;
          if (sessionRes?.success && sessionRes?.session && !cancelled) {
            const nextSession = sessionRes.session as QuickRefineSession;
            startTransition(() => {
              setModelOverride(String(nextSession.modelOverride ?? validPreferredModel).trim() || validPreferredModel);
              setSession(nextSession);
              setSessionId(nextSession.sessionId);
              setApplyResult(nextSession.applyResult || null);
              setHandoffReason(nextSession.handoffReason || '');
              if (nextSession.status === 'queued' || nextSession.status === 'running') {
                setStage('loading');
              } else if (nextSession.status === 'failed') {
                setError(nextSession.error || 'Quick refine could not finish.');
                setStage('idle');
              } else if (nextSession.status === 'needs_clarification' && nextSession.questions?.length) {
                setQuestions(nextSession.questions);
                setAnswers(nextSession.questions.map((question) => ({
                  questionId: question.id,
                  question: question.question,
                  answer: '',
                  selectedSuggestions: [],
                })));
                setStage('questions');
              } else if (nextSession.draft) {
                setDraft(nextSession.draft);
                setDiffBaseIssue(nextSession.draft.diffBaseIssue || nextContext.originalIssue);
                setDraftViewMode('result');
                setStage('draft');
              } else if (nextSession.status === 'handoff') {
                setStage('handoff');
              }
            });
          }
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      }
    };

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [initialState, surface]);

  useEffect(() => {
    if (!context?.originalIssue || diffBaseIssue) return;
    setDiffBaseIssue(context.originalIssue);
  }, [context?.originalIssue, diffBaseIssue]);

  useEffect(() => {
    if (!onStateChange || !issueKey) return;
    onStateChange({
      issueKey,
      projectKey,
      sessionId,
      stage,
      active,
      draftViewMode,
      modelOverride,
      session,
      questions,
      answers,
      draft,
      handoffReason,
      applyResult,
      diffBaseIssue,
    });
  }, [
    active,
    answers,
    applyResult,
    diffBaseIssue,
    draft,
    draftViewMode,
    handoffReason,
    issueKey,
    modelOverride,
    onStateChange,
    projectKey,
    questions,
    session,
    sessionId,
    stage,
  ]);

  const modelOptions = useMemo(() => buildModelOptions(provider, modelCatalogs, []), [provider, modelCatalogs]);

  const hasResume = Boolean(
    session
    && (
      session.questions?.length
      || session.draft
      || session.status === 'handoff'
      || session.status === 'queued'
      || session.status === 'running'
    ),
  );
  const isSessionProcessing = stage === 'loading' || session?.status === 'queued' || session?.status === 'running';
  const originalIssue = context?.originalIssue;

  const currentIssueChanged = useMemo(() => {
    if (!originalIssue || !draft) return false;
    return (
      isFieldChanged(originalIssue.summary, draft.currentIssue.summary)
      || isFieldChanged(originalIssue.description, draft.currentIssue.description)
      || arsChanged(originalIssue.acceptanceRequirements, draft.currentIssue.acceptanceRequirements)
    );
  }, [draft, originalIssue]);

  const selectedSplitCount = useMemo(
    () => draft?.splitCandidates?.filter((candidate) => candidate.selected).length ?? 0,
    [draft],
  );

  const setQuestionAnswer = (question: QuickRefineQuestion, answer: string, selectedSuggestion?: string) => {
    setAnswers((current) => current.map((entry) => {
      if (entry.questionId !== question.id) return entry;
      return {
        ...entry,
        question: question.question,
        answer,
        selectedSuggestions: selectedSuggestion ? [selectedSuggestion] : entry.selectedSuggestions,
      };
    }));
  };

  const openEditor = () => setActive(true);

  const persistModelPreference = async (nextModel: string) => {
    if (!provider) return;
    try {
      await api.saveUserPreferences({
        quickRefineModelByProvider: {
          [provider]: nextModel,
        },
      });
    } catch {
      // Best-effort only.
    }
  };

  const handleModelChange = (nextModel: string) => {
    setModelOverride(nextModel);
    void persistModelPreference(nextModel);
  };

  const restoreFromSession = useCallback((nextSession: QuickRefineSession) => {
    setSession(nextSession);
    setSessionId(nextSession.sessionId);
    if (nextSession.modelOverride) {
      setModelOverride(nextSession.modelOverride);
    }
    setApplyResult(nextSession.applyResult || null);
    setHandoffReason(nextSession.handoffReason || '');
    setDiffBaseIssue(nextSession.draft?.diffBaseIssue ?? context?.originalIssue ?? null);
    if (nextSession.status === 'queued' || nextSession.status === 'running') {
      setError('');
      setStage('loading');
      return;
    }
    if (nextSession.status === 'failed') {
      setDraft(null);
      setQuestions([]);
      setAnswers([]);
      setError(nextSession.error || 'Quick refine could not finish.');
      setStage('idle');
      return;
    }
    if (nextSession.status === 'needs_clarification' && nextSession.questions?.length) {
      setError('');
      setQuestions(nextSession.questions);
      setAnswers(nextSession.questions.map((question) => ({
        questionId: question.id,
        question: question.question,
        answer: '',
        selectedSuggestions: [],
      })));
      setStage('questions');
      return;
    }
    if (nextSession.draft) {
      setError('');
      setDraft(nextSession.draft);
      setQuestions([]);
      setAnswers([]);
      setDraftViewMode('result');
      setStage('draft');
      return;
    }
    if (nextSession.status === 'handoff') {
      setError('');
      setStage('handoff');
      return;
    }
    setStage('idle');
  }, [context?.originalIssue]);

  useEffect(() => {
    if (!sessionId) return;
    if (!isSessionProcessing) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const sessionRes = await api.getQuickRefineSession({ sessionId }) as any;
        if (cancelled) return;
        if (!sessionRes?.success || !sessionRes?.session) {
          throw new Error(sessionRes?.error || 'Quick refine session could not be refreshed.');
        }
        const nextSession = sessionRes.session as QuickRefineSession;
        if (nextSession.status === 'queued' || nextSession.status === 'running') {
          setSession(nextSession);
          setBusyLabel(nextSession.status === 'queued' ? 'Queued for context loading' : 'Building rewrite with project context');
          timer = setTimeout(() => void poll(), 1500);
          return;
        }
        setBusyLabel('');
        restoreFromSession(nextSession);
      } catch (err) {
        if (cancelled) return;
        setBusyLabel('');
        setError(err instanceof Error ? err.message : String(err));
        setStage('idle');
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [isSessionProcessing, restoreFromSession, sessionId]);

  const handleStart = async (options?: { restart?: boolean }) => {
    if (!issueKey || !projectKey) return;
    const nextSessionId = sessionId || createSessionId();
    setSessionId(nextSessionId);
    setBusy(true);
    setBusyLabel(options?.restart ? 'Queueing a fresh quick rewrite' : 'Queueing quick refine');
    setError('');
    if (options?.restart) {
      setApplyResult(null);
      setDraft(null);
      setQuestions([]);
      setAnswers([]);
      setHandoffReason('');
      setStage('loading');
    }
    try {
      const res = await api.startQuickRefine({
        issueKey,
        projectKey,
        sessionId: nextSessionId,
        surface,
        modelOverride,
        restart: options?.restart,
      }) as any;
      if (!res?.success) {
        throw new Error(res?.error || 'Quick refine could not start.');
      }
      if (res.session) {
        setSession(res.session as QuickRefineSession);
      }
      setDraftViewMode('result');
      setStage('loading');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage('idle');
    } finally {
      setBusy(false);
      setBusyLabel('');
    }
  };

  const handleSubmitAnswers = async () => {
    if (!issueKey || !sessionId) return;
    setBusy(true);
    setBusyLabel('Applying answers');
    setError('');
    try {
      const completedAnswers = answers.filter((answer) => answer.answer.trim());
      const res = await api.submitQuickRefineAnswers({
        issueKey,
        sessionId,
        answers: completedAnswers,
        modelOverride,
      }) as any;
      if (!res?.success) {
        throw new Error(res?.error || 'Could not apply answers.');
      }
      restoreFromSession(res.session as QuickRefineSession);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setBusyLabel('');
    }
  };

  const handleAiRefine = async (instructions: string) => {
    if (!issueKey || !sessionId || !draft) return;
    setAiBusy(true);
    setAiError('');
    try {
      const res = await api.refineQuickRefineDraft({
        issueKey,
        sessionId,
        instructions,
        draft,
        modelOverride,
      }) as any;
      if (!res?.success) {
        throw new Error(res?.error || 'Could not refine the quick draft.');
      }
      restoreFromSession(res.session as QuickRefineSession);
      setAiDialogOpen(false);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiBusy(false);
    }
  };

  const handleApply = async () => {
    if (!issueKey || !sessionId || !draft) return;
    setBusy(true);
    setBusyLabel(selectedSplitCount ? 'Saving issue and linked items' : 'Saving issue');
    setError('');
    try {
      const res = await api.applyQuickRefine({
        issueKey,
        sessionId,
        draft,
      }) as any;
      if (!res?.success) {
        throw new Error(res?.error || 'Could not apply the quick refine draft.');
      }
      setApplyResult(res.result as QuickRefineApplyResult);
      restoreFromSession(res.session as QuickRefineSession);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setBusyLabel('');
    }
  };

  if (loadError) {
    return (
      <div className="h-full w-full flex items-center justify-center p-6">
        <div className="rf-card max-w-xl p-6 space-y-3">
          <div className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--rf-danger-subtle)] text-[var(--rf-danger)]">
            <AlertCircle className="w-5 h-5" />
          </div>
          <h2 className="text-2xl font-semibold text-[var(--rf-text)]">Quick Refine unavailable</h2>
          <p className="text-sm text-[var(--rf-text-secondary)]">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!active && surface === 'issue-panel') {
    return (
      <div className="h-full w-full p-2">
        <div className="rf-card relative h-full overflow-hidden border border-[rgba(43,89,74,0.12)] bg-[radial-gradient(circle_at_top_left,rgba(96,154,127,0.2),transparent_42%),linear-gradient(180deg,rgba(252,253,252,0.96),rgba(243,248,245,0.96))] p-3">
          <div className="pointer-events-none absolute inset-x-3 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(43,89,74,0.35),transparent)]" />
          <div className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex min-w-0 items-start gap-2.5">
                <div className="inline-flex h-9 w-9 items-center justify-center rounded-2xl border border-white/70 bg-white/80 text-[var(--rf-brand)] shadow-[0_12px_28px_rgba(43,89,74,0.12)]">
                  <Sparkles className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-[var(--rf-text-tertiary)]">Issue Panel</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-[22px] leading-none font-semibold text-[var(--rf-text)]">Quick Refinely</h2>
                    <span className="rounded-full border border-[rgba(43,89,74,0.14)] bg-white/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--rf-brand)]">
                      {getSessionBadgeCopy(session)}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] leading-5 text-[var(--rf-text-secondary)]">
                    Rewrite this issue with project context, WI guidance, and tighter acceptance requirements.
                  </div>
                </div>
              </div>
              <div className="rounded-full border border-[var(--rf-border)] bg-white/80 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">
                {formatRelativeTimestamp(context?.updatedAt)}
              </div>
            </div>
            {isSessionProcessing ? (
              <div className="rounded-2xl border border-[rgba(43,89,74,0.14)] bg-white/82 px-3 py-3 shadow-[0_18px_36px_rgba(43,89,74,0.08)]">
                <div className="flex items-center gap-2 text-[var(--rf-brand)]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm font-semibold">{busyLabel || 'Quick refine is running'}</span>
                </div>
                <p className="mt-1 text-[12px] leading-5 text-[var(--rf-text-secondary)]">
                  We are retrieving backlog signals and composing a rewrite in the background.
                </p>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  openEditor();
                  if (!hasResume) void handleStart();
                }}
                disabled={busy}
                className="group inline-flex w-full items-center justify-between rounded-[22px] border border-[rgba(43,89,74,0.18)] bg-[linear-gradient(135deg,var(--rf-brand),#3b715f)] px-4 py-3 text-left text-white shadow-[0_22px_42px_rgba(43,89,74,0.22)] transition hover:-translate-y-0.5 hover:shadow-[0_26px_48px_rgba(43,89,74,0.28)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="flex items-center gap-3">
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-white/14 ring-1 ring-white/20">
                    <ClipboardPenLine className="h-4.5 w-4.5" />
                  </span>
                  <span>
                    <span className="block text-[11px] font-bold uppercase tracking-[0.18em] text-white/72">
                      {hasResume ? 'Continue where you left off' : 'Refine this story now'}
                    </span>
                    <span className="block text-base font-semibold">
                      {hasResume ? 'Open Quick Refine draft' : 'Launch Quick Refine'}
                    </span>
                  </span>
                </span>
                <ArrowRight className="h-4.5 w-4.5 transition group-hover:translate-x-0.5" />
              </button>
            )}
            {onOpenSettings && !isSessionProcessing ? (
              <button
                type="button"
                onClick={onOpenSettings}
                className="inline-flex items-center gap-2 rounded-xl border border-[var(--rf-border)] px-3 py-1.5 text-sm font-semibold text-[var(--rf-text-secondary)] transition hover:border-[var(--rf-border-strong)] hover:bg-white/80"
              >
                Settings
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-full w-full ${surface === 'issue-action' ? 'p-2.5' : 'p-2'} overflow-auto`}>
      <AiPromptDialog
        open={aiDialogOpen}
        title="Refine this quick-rewrite draft"
        busy={aiBusy}
        error={aiError}
        onClose={() => setAiDialogOpen(false)}
        onSubmit={handleAiRefine}
      />

      <div className="mx-auto max-w-6xl space-y-2">
        <div className="rf-card overflow-hidden border border-[rgba(43,89,74,0.12)] shadow-[0_22px_52px_rgba(15,23,42,0.08)]">
          <div className="relative border-b border-[rgba(43,89,74,0.1)] bg-[radial-gradient(circle_at_top_left,rgba(96,154,127,0.18),transparent_36%),linear-gradient(180deg,rgba(255,255,255,0.96),rgba(244,248,245,0.92))] px-3 py-2.5">
            <div className="pointer-events-none absolute inset-x-3 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(43,89,74,0.3),transparent)]" />
            <div className="flex flex-wrap items-start justify-between gap-2.5">
            <div className="min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--rf-text-tertiary)]">
                {surface === 'issue-action' ? 'Issue Action' : 'Issue Panel'}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[30px] leading-none font-semibold text-[var(--rf-text)]">Quick Refinely</h1>
                {issueKey ? (
                  <span className="rounded-full bg-[var(--rf-brand-subtle)] px-2.5 py-1 text-sm font-semibold text-[var(--rf-brand)]">
                    {issueKey}
                  </span>
                ) : null}
                {context?.issueType ? (
                  <span className="rounded-full bg-white px-2.5 py-1 text-sm text-[var(--rf-text-secondary)] border border-[var(--rf-border)]">
                    {context.issueType}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 max-w-2xl text-[12px] leading-5 text-[var(--rf-text-secondary)]">
                Dense, context-aware issue rewriting for Jira stories that need a tighter scope, sharper user story, and cleaner acceptance requirements.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {stage === 'draft' ? (
                <div className="inline-flex items-center gap-1 rounded-xl border border-[var(--rf-border)] bg-white p-1">
                  {(['diff', 'result'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setDraftViewMode(mode)}
                      className={`rounded-lg px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.12em] transition ${
                        draftViewMode === mode
                          ? 'bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)]'
                          : 'text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text)]'
                      }`}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              ) : null}
              {modelOptions.length ? (
                <label className="inline-flex items-center gap-2 rounded-xl border border-[var(--rf-border)] bg-white px-2.5 py-1 text-sm text-[var(--rf-text-secondary)]">
                  <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--rf-text-tertiary)]">Model</span>
                  <select
                    value={modelOverride}
                    onChange={(event) => handleModelChange(event.target.value)}
                    className="min-w-[170px] bg-transparent text-sm font-semibold text-[var(--rf-text)] outline-none"
                  >
                    {modelOptions.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                  </label>
              ) : null}
              {onOpenSettings ? (
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="rounded-xl border border-[var(--rf-border)] bg-white px-2.5 py-1 text-sm font-semibold text-[var(--rf-text-secondary)] transition hover:border-[var(--rf-border-strong)]"
                >
                  Settings
                </button>
              ) : null}
              {!busy && !isSessionProcessing && (stage === 'draft' || stage === 'questions' || stage === 'handoff' || hasResume) ? (
                <button
                  type="button"
                  onClick={() => void handleStart({ restart: true })}
                  disabled={busy}
                  className="inline-flex items-center gap-2 rounded-xl border border-[var(--rf-border)] bg-white px-2.5 py-1 text-sm font-semibold text-[var(--rf-text-secondary)] transition hover:border-[var(--rf-border-strong)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCcw className="w-4 h-4" />
                  Restart
                </button>
              ) : null}
              {surface === 'issue-panel' ? (
                <button
                  type="button"
                  onClick={() => setActive(false)}
                  className="rounded-xl border border-[var(--rf-border)] bg-white px-2.5 py-1 text-sm font-semibold text-[var(--rf-text-secondary)] transition hover:border-[var(--rf-border-strong)]"
                >
                  Collapse
                </button>
              ) : null}
              {!busy && !isSessionProcessing && stage === 'draft' ? (
                <button
                  type="button"
                  onClick={() => setAiDialogOpen(true)}
                  className="inline-flex items-center gap-2 rounded-xl border border-[var(--rf-border)] bg-white px-2.5 py-1 text-sm font-semibold text-[var(--rf-text-secondary)] transition hover:border-[var(--rf-border-strong)]"
                >
                  <WandSparkles className="w-4 h-4 text-[var(--rf-brand)]" />
                  AI Refine
                </button>
              ) : null}
            </div>
          </div>
          </div>
          <div className="space-y-2 bg-[linear-gradient(180deg,rgba(248,251,249,0.82),rgba(255,255,255,0.92))] p-2.5">
            {error ? (
              <div className="rounded-2xl border border-[var(--rf-danger)]/25 bg-[var(--rf-danger-subtle)] px-4 py-3 text-sm text-[var(--rf-danger)]">
                {error}
              </div>
            ) : null}

            {applyResult ? (
              <div className="rounded-2xl border border-[var(--rf-success)]/20 bg-[var(--rf-success-subtle)] px-4 py-3 text-sm text-[var(--rf-success)] space-y-2">
                <div className="flex items-center gap-2 font-semibold">
                  <CopyCheck className="w-4 h-4" />
                  Quick refine applied to {applyResult.updatedIssueKey}
                </div>
                {applyResult.createdIssues.length ? (
                  <div className="flex flex-wrap gap-2">
                    {applyResult.createdIssues.map((created) => (
                      <button
                        key={created.issueKey}
                        type="button"
                        onClick={() => void router.navigate(created.issueUrl)}
                        className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1 text-xs font-semibold text-[var(--rf-brand)]"
                      >
                        {created.issueKey}
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {busy && !isSessionProcessing ? (
              <div className="inline-flex items-center gap-2 rounded-xl border border-[var(--rf-border)] bg-white/75 px-3 py-2 text-sm text-[var(--rf-text-secondary)]">
                <Loader2 className="w-4 h-4 animate-spin text-[var(--rf-brand)]" />
                {busyLabel}
              </div>
            ) : null}

            {stage === 'idle' && !busy && !isSessionProcessing ? (
              <div className="relative overflow-hidden rounded-[24px] border border-[rgba(43,89,74,0.14)] bg-[radial-gradient(circle_at_top_left,rgba(96,154,127,0.16),transparent_38%),linear-gradient(180deg,rgba(255,255,255,0.96),rgba(245,249,246,0.92))] px-4 py-4">
                <div className="pointer-events-none absolute inset-y-0 left-0 w-[120px] bg-[linear-gradient(90deg,rgba(43,89,74,0.06),transparent)]" />
                <div className="relative flex flex-wrap items-center justify-between gap-3">
                  <div className="max-w-xl space-y-1.5">
                    <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--rf-text-tertiary)]">Quick Refinely</p>
                    <h2 className="text-2xl leading-tight font-semibold text-[var(--rf-text)]">Turn a rough Jira issue into a clean story in one pass.</h2>
                    <p className="text-sm leading-6 text-[var(--rf-text-secondary)]">
                      We’ll use your project context, WI sources, and backlog signals to draft a sharper user story and compact acceptance requirements.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleStart()}
                    className="group inline-flex min-w-[220px] items-center justify-between rounded-[22px] border border-[rgba(43,89,74,0.16)] bg-[linear-gradient(135deg,var(--rf-brand),#3b715f)] px-4 py-3 text-left text-white shadow-[0_24px_44px_rgba(43,89,74,0.24)] transition hover:-translate-y-0.5 hover:shadow-[0_28px_52px_rgba(43,89,74,0.3)]"
                  >
                    <span className="flex items-center gap-3">
                      <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-white/14 ring-1 ring-white/20">
                        <Sparkles className="w-4.5 h-4.5" />
                      </span>
                      <span>
                        <span className="block text-[11px] font-bold uppercase tracking-[0.18em] text-white/72">Primary action</span>
                        <span className="block text-base font-semibold">Quick Refine</span>
                      </span>
                    </span>
                    <ArrowRight className="h-4.5 w-4.5 transition group-hover:translate-x-0.5" />
                  </button>
                </div>
              </div>
            ) : null}

            {isSessionProcessing ? (
              <div className="relative overflow-hidden rounded-[24px] border border-[rgba(43,89,74,0.14)] bg-[radial-gradient(circle_at_top_left,rgba(96,154,127,0.14),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.96),rgba(244,248,245,0.94))] px-4 py-4">
                <div className="pointer-events-none absolute inset-x-4 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(43,89,74,0.26),transparent)]" />
                <div className="relative flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-1.5">
                    <div className="inline-flex items-center gap-2 rounded-full border border-[rgba(43,89,74,0.12)] bg-white/80 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--rf-brand)]">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {session?.status === 'queued' ? 'Queued' : 'Running'}
                    </div>
                    <h2 className="text-xl font-semibold text-[var(--rf-text)]">
                      {session?.status === 'queued' ? 'Quick refine is lining up context.' : 'Quick refine is building your rewrite.'}
                    </h2>
                    <p className="max-w-xl text-sm leading-6 text-[var(--rf-text-secondary)]">
                      {busyLabel || 'We are pulling project signals, similar backlog items, and WI context before drafting the updated issue.'}
                    </p>
                  </div>
                  <div className="min-w-[220px] rounded-[20px] border border-white/70 bg-white/80 px-3.5 py-3 shadow-[0_14px_30px_rgba(43,89,74,0.08)]">
                    <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">In progress</div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--rf-brand-subtle)]">
                      <div className="h-full w-1/2 animate-pulse rounded-full bg-[var(--rf-brand)]" />
                    </div>
                    <div className="mt-2 text-[12px] leading-5 text-[var(--rf-text-secondary)]">
                      Keep this panel open or come back later. Your session will resume automatically.
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {stage === 'handoff' ? (
              <div className="rf-card p-4 space-y-3">
                <div className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--rf-warning-subtle)] text-[var(--rf-warning)]">
                  <MessagesSquare className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-[var(--rf-text)]">This issue needs the full workflow</h2>
                  <p className="mt-1 text-sm leading-relaxed text-[var(--rf-text-secondary)]">
                    {handoffReason || 'The issue is too broad or too ambiguous for the fast rewrite flow.'}
                  </p>
                </div>
                {onOpenFullWorkflow ? (
                  <button
                    type="button"
                    onClick={onOpenFullWorkflow}
                    className="inline-flex items-center gap-2 rounded-xl bg-[var(--rf-brand)] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[var(--rf-brand-hover)]"
                  >
                    Open Full Refinely Workflow
                    <ArrowRight className="w-4 h-4" />
                  </button>
                ) : (
                  <p className="text-sm text-[var(--rf-text-tertiary)]">
                    Open the <span className="font-semibold text-[var(--rf-text)]">Refine Stories</span> issue action to continue in the full workflow.
                  </p>
                )}
              </div>
            ) : null}

            {stage === 'questions' ? (
              <div className="space-y-2">
                {questions.map((question) => {
                  const answer = answers.find((entry) => entry.questionId === question.id);
                  return (
                    <div key={question.id} className="rf-card p-3 space-y-2.5">
                      <div className="flex items-center gap-2 text-[var(--rf-brand)]">
                        <MessagesSquare className="w-4 h-4" />
                        <span className="text-xs font-bold uppercase tracking-[0.18em]">Clarify</span>
                      </div>
                      <h3 className="text-lg font-semibold text-[var(--rf-text)]">{question.question}</h3>
                      {question.suggestions.length ? (
                        <div className="flex flex-wrap gap-2">
                          {question.suggestions.map((suggestion) => (
                            <button
                              key={suggestion}
                              type="button"
                              onClick={() => setQuestionAnswer(question, suggestion, suggestion)}
                              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${answer?.selectedSuggestions?.includes(suggestion) ? 'bg-[var(--rf-brand)] text-white' : 'border border-[var(--rf-border)] bg-white text-[var(--rf-text-secondary)] hover:border-[var(--rf-brand)] hover:text-[var(--rf-brand)]'}`}
                            >
                              {suggestion}
                            </button>
                          ))}
                        </div>
                      ) : null}
                      <textarea
                        rows={3}
                        value={answer?.answer || ''}
                        onChange={(event) => setQuestionAnswer(question, event.target.value)}
                        className="w-full rounded-xl border border-[var(--rf-border)] bg-white px-3 py-1.5 text-sm text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand-subtle)]"
                        placeholder="Answer in one or two sentences."
                      />
                    </div>
                  );
                })}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    disabled={busy || answers.some((answer) => !answer.answer.trim())}
                    onClick={() => void handleSubmitAnswers()}
                    className="inline-flex items-center gap-2 rounded-xl bg-[var(--rf-brand)] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[var(--rf-brand-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <ArrowRight className="w-4 h-4" />
                    Build Rewrite Preview
                  </button>
                </div>
              </div>
            ) : null}

            {stage === 'draft' && draft && originalIssue ? (
              <div className="space-y-2">
                {draft.handoffRecommended ? (
                  <div className="rounded-2xl border border-[var(--rf-warning)]/25 bg-[var(--rf-warning-subtle)] px-4 py-3 text-sm text-[var(--rf-warning)]">
                    {draft.handoffReason || 'This draft is usable, but the issue still looks like it would benefit from the full Refinely workflow.'}
                  </div>
                ) : null}

                <DraftCard
                  title="Current Issue Rewrite"
                  changed={currentIssueChanged}
                  actions={(
                    <div className="flex items-center gap-2 text-sm text-[var(--rf-text-tertiary)]">
                      <PencilLine className="w-4 h-4" />
                      {draftViewMode === 'diff' ? 'Compact diff' : 'Editable result'}
                    </div>
                  )}
                >
                  {draftViewMode === 'diff' ? (
                    <div className="space-y-2">
                      <div className="rounded-xl border border-[var(--rf-border)] bg-white/80 p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)]">
                        <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">Summary</p>
                        <div className="text-sm text-[var(--rf-text)]">
                          <DiffText oldText={(draft.diffBaseIssue ?? diffBaseIssue ?? originalIssue).summary} newText={draft.currentIssue.summary} mode="redline" />
                        </div>
                      </div>
                      <div className="rounded-xl border border-[var(--rf-border)] bg-white/80 p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)]">
                        <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">Description</p>
                        <div className="text-sm leading-7 text-[var(--rf-text)] whitespace-pre-wrap">
                          <DiffText oldText={(draft.diffBaseIssue ?? diffBaseIssue ?? originalIssue).description} newText={draft.currentIssue.description} mode="redline" />
                        </div>
                      </div>
                      <div className="rounded-xl border border-[var(--rf-border)] bg-white/75 p-2.5">
                        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">Acceptance Requirements</p>
                        <CompactArDiff
                          original={(draft.diffBaseIssue ?? diffBaseIssue ?? originalIssue).acceptanceRequirements}
                          proposed={draft.currentIssue.acceptanceRequirements}
                          mode={draftViewMode}
                        />
                      </div>
                    </div>
                  ) : (
                    <>
                      <label className="block space-y-1">
                        <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Summary</span>
                        <input
                          value={draft.currentIssue.summary}
                          onChange={(event) => setDraft({
                            ...draft,
                            currentIssue: {
                              ...draft.currentIssue,
                              summary: event.target.value,
                            },
                          })}
                          className="w-full rounded-xl border border-[var(--rf-border)] bg-white px-3 py-1.5 text-sm text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand-subtle)]"
                        />
                      </label>

                      <label className="block space-y-1">
                        <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Description</span>
                        <textarea
                          rows={4}
                          value={draft.currentIssue.description}
                          onChange={(event) => setDraft({
                            ...draft,
                            currentIssue: {
                              ...draft.currentIssue,
                              description: event.target.value,
                            },
                          })}
                          className="w-full rounded-xl border border-[var(--rf-border)] bg-white px-3 py-1.5 text-sm text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand-subtle)]"
                        />
                      </label>

                      <CompactArEditor
                        ars={draft.currentIssue.acceptanceRequirements}
                        onChange={(next) => setDraft({
                          ...draft,
                          currentIssue: {
                            ...draft.currentIssue,
                            acceptanceRequirements: next,
                          },
                        })}
                      />
                    </>
                  )}
                </DraftCard>

                <DraftCard
                  title="Split Candidates"
                  changed={Boolean(draft.splitCandidates.length)}
                  actions={(
                    <button
                      type="button"
                      onClick={() => setDraft({
                        ...draft,
                        splitCandidates: [...draft.splitCandidates, emptySplitCandidate()],
                      })}
                      className="inline-flex items-center gap-2 rounded-2xl border border-[var(--rf-border)] bg-white px-3 py-1.5 text-sm font-semibold text-[var(--rf-text-secondary)] transition hover:border-[var(--rf-border-strong)]"
                    >
                      <Plus className="w-4 h-4" />
                      Add Split Candidate
                    </button>
                  )}
                >
                  {draft.splitCandidates.length ? (
                    <div className="space-y-3">
                      {draft.splitCandidates.map((candidate, index) => (
                        <div key={candidate.id} className="rounded-xl border border-[var(--rf-border)] bg-white/85 p-2.5 space-y-2.5 shadow-[0_6px_18px_rgba(16,24,40,0.05)]">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="flex items-center gap-3">
                              <button
                                type="button"
                                onClick={() => setDraft({
                                  ...draft,
                                  splitCandidates: draft.splitCandidates.map((item) => item.id === candidate.id ? { ...item, selected: !item.selected } : item),
                                })}
                                className={`inline-flex h-9 w-9 items-center justify-center rounded-xl border transition ${candidate.selected ? 'border-[var(--rf-brand)] bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)]' : 'border-[var(--rf-border)] bg-white text-[var(--rf-text-tertiary)]'}`}
                              >
                                {candidate.selected ? <Check className="w-4 h-4" /> : <SplitSquareVertical className="w-4 h-4" />}
                              </button>
                              <div>
                                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Split {index + 1}</p>
                                <p className="text-sm font-semibold text-[var(--rf-text)]">{candidate.selected ? 'Will be created as a linked issue' : 'Draft only'}</p>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => setDraft({
                                ...draft,
                                splitCandidates: draft.splitCandidates.filter((item) => item.id !== candidate.id),
                              })}
                              className="inline-flex items-center gap-1 text-xs text-[var(--rf-danger)]"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              Delete
                            </button>
                          </div>

                          <div className="grid gap-2.5 md:grid-cols-[minmax(0,1fr),128px]">
                            <label className="block space-y-1">
                              <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Summary</span>
                              <input
                                value={candidate.summary}
                                onChange={(event) => setDraft({
                                  ...draft,
                                  splitCandidates: draft.splitCandidates.map((item) => item.id === candidate.id ? { ...item, summary: event.target.value } : item),
                                })}
                                className="w-full rounded-xl border border-[var(--rf-border)] bg-white px-3 py-1.5 text-sm text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand-subtle)]"
                              />
                            </label>
                            <label className="block space-y-1">
                              <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Issue Type</span>
                              <select
                                value={candidate.issueType}
                                onChange={(event) => setDraft({
                                  ...draft,
                                  splitCandidates: draft.splitCandidates.map((item) => item.id === candidate.id ? { ...item, issueType: event.target.value } : item),
                                })}
                                className="w-full rounded-xl border border-[var(--rf-border)] bg-white px-3 py-1.5 text-sm text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand-subtle)]"
                              >
                                <option>Story</option>
                                <option>Task</option>
                                <option>Bug</option>
                                <option>Epic</option>
                              </select>
                            </label>
                          </div>

                          <label className="block space-y-1">
                            <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Description</span>
                            <textarea
                              rows={4}
                              value={candidate.description}
                              onChange={(event) => setDraft({
                                ...draft,
                                splitCandidates: draft.splitCandidates.map((item) => item.id === candidate.id ? { ...item, description: event.target.value } : item),
                              })}
                              className="w-full rounded-xl border border-[var(--rf-border)] bg-white px-3 py-1.5 text-sm text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand-subtle)]"
                            />
                          </label>

                          <CompactArEditor
                            ars={candidate.acceptanceRequirements}
                            onChange={(next) => setDraft({
                              ...draft,
                              splitCandidates: draft.splitCandidates.map((item) => item.id === candidate.id ? { ...item, acceptanceRequirements: next } : item),
                            })}
                          />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-[var(--rf-border-strong)] px-4 py-6 text-center text-sm text-[var(--rf-text-tertiary)]">
                      No split candidates yet. Keep this flow focused on rewriting the current issue unless you really need linked follow-on items.
                    </div>
                  )}
                </DraftCard>

                {draft.changeSummary?.length ? (
                  <div className="rf-card p-3">
                    <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Change Summary</p>
                    <ul className="mt-3 space-y-2 text-sm text-[var(--rf-text-secondary)]">
                      {draft.changeSummary.map((item) => (
                        <li key={item} className="flex gap-2">
                          <span className="mt-1 h-1.5 w-1.5 rounded-full bg-[var(--rf-brand)]" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm text-[var(--rf-text-tertiary)]">
                    {selectedSplitCount
                      ? `${selectedSplitCount} split candidate${selectedSplitCount === 1 ? '' : 's'} selected for linked issue creation.`
                      : 'This apply will only update the current issue.'}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {draft.handoffRecommended && onOpenFullWorkflow ? (
                      <button
                        type="button"
                        onClick={onOpenFullWorkflow}
                        className="inline-flex items-center gap-2 rounded-xl border border-[var(--rf-border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--rf-text-secondary)] transition hover:border-[var(--rf-border-strong)]"
                      >
                        Open Full Refinely
                      </button>
                    ) : null}
                    {onOpenSettings ? (
                      <button
                        type="button"
                        onClick={onOpenSettings}
                        className="inline-flex items-center gap-2 rounded-xl border border-[var(--rf-border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--rf-text-secondary)] transition hover:border-[var(--rf-border-strong)]"
                      >
                        Settings
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void handleApply()}
                      disabled={busy}
                      className="inline-flex items-center gap-2 rounded-xl bg-[var(--rf-brand)] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[var(--rf-brand-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <CopyCheck className="w-4 h-4" />
                      {selectedSplitCount ? 'Save + Create Linked Items' : 'Save Current Issue'}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export default QuickRefineApp;
