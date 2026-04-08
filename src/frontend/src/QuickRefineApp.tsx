import React, { startTransition, useCallback, useEffect, useMemo, useState } from 'react';
import { router, view } from '@forge/bridge';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  ArrowRight,
  Check,
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
        <div key={`ar-${index}`} className="rounded border border-[var(--jira-border)] bg-white p-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--jira-text-subtle)]">AR {index + 1}</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[11px] text-[var(--rf-danger)] hover:underline"
              onClick={() => onChange(ars.filter((_, candidateIndex) => candidateIndex !== index))}
            >
              <Trash2 className="w-3 h-3" />
              Delete
            </button>
          </div>
          <div className="space-y-1">
            <span className="text-[11px] font-semibold text-[var(--jira-text-subtle)]">Acceptance Requirement</span>
            <textarea
              rows={4}
              value={formatArText(ar)}
              onChange={(event) => {
                const next = [...ars];
                next[index] = parseArText(event.target.value);
                onChange(next);
              }}
              placeholder={'GIVEN ...\nWHEN ...\nTHEN ...'}
              className="w-full min-h-[80px] resize-y rounded border border-[var(--jira-border)] bg-[var(--jira-bg)] px-2.5 py-1.5 text-[13px] leading-5 text-[var(--jira-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-1 focus:ring-[var(--rf-brand-subtle)]"
            />
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...(ars.length ? ars : []), emptyAr()])}
        className="inline-flex items-center gap-1.5 rounded border border-dashed border-[var(--jira-border)] px-2.5 py-1.5 text-[12px] font-semibold text-[var(--rf-brand)] transition hover:border-[var(--rf-brand)] hover:bg-[var(--rf-brand-subtle)]"
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
            className={`rounded border px-3 py-2 text-[13px] ${
              isRemoved
                ? 'border-[rgba(155,53,69,0.16)] bg-[rgba(155,53,69,0.05)]'
                : isAdded
                  ? 'border-[rgba(46,125,86,0.16)] bg-[rgba(46,125,86,0.05)]'
                  : 'border-[var(--jira-border)] bg-white'
            }`}
          >
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wide text-[var(--jira-text-subtle)]">AR {index + 1}</span>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--jira-text-subtle)]">
                {isRemoved ? 'Removed' : isAdded ? 'Added' : 'Updated'}
              </span>
            </div>
            <div className="rounded border border-[var(--jira-border)] bg-[var(--jira-bg)] px-2.5 py-2 leading-5 text-[var(--jira-text)] whitespace-pre-wrap">
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
        <div className="rounded border border-dashed border-[var(--jira-border)] px-3 py-2 text-[12px] text-[var(--jira-text-subtle)]">
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
      <div className="absolute inset-0 bg-[rgba(9,30,66,0.4)] backdrop-blur-sm" onClick={busy ? undefined : onClose} />
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="relative bg-white rounded-lg border border-[var(--jira-border)] shadow-[0_8px_24px_rgba(9,30,66,0.14)] w-full max-w-lg p-4 space-y-3"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--jira-text-subtle)]">AI Refine</p>
            <h3 className="text-[15px] font-semibold text-[var(--jira-text)]">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded border border-[var(--jira-border)] bg-white p-1.5 text-[var(--jira-text-subtle)] transition hover:bg-[var(--jira-bg)] disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <textarea
          rows={4}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder='Example: "Tighten the scope to internal users only and add one AR for invalid input."'
          className="w-full rounded border border-[var(--jira-border)] bg-[var(--jira-bg)] px-3 py-2 text-[13px] text-[var(--jira-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-1 focus:ring-[var(--rf-brand-subtle)] resize-y"
        />
        {error ? (
          <div className="rounded border border-[rgba(155,53,69,0.2)] bg-[var(--rf-danger-subtle)] px-3 py-2 text-[12px] text-[var(--rf-danger)]">
            {error}
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12px] text-[var(--jira-text-subtle)]">Refines the current draft without discarding your manual edits.</p>
          <button
            type="button"
            disabled={busy || !instructions.trim()}
            onClick={() => onSubmit(instructions)}
            className="inline-flex items-center gap-1.5 rounded bg-[var(--rf-brand)] px-3 py-1.5 text-[13px] font-semibold text-white transition hover:bg-[var(--rf-brand-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <WandSparkles className="w-3.5 h-3.5" />}
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
    <div className="overflow-hidden rounded border border-[var(--jira-border)] bg-white shadow-[var(--jira-shadow-xs)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--jira-border)] bg-[var(--jira-bg)] px-3 py-2">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-semibold text-[var(--jira-text)]">{title}</h3>
          {typeof changed === 'boolean' ? (
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${changed ? 'bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)]' : 'bg-white border border-[var(--jira-border)] text-[var(--jira-text-subtle)]'}`}>
              {changed ? 'Updated' : 'Unchanged'}
            </span>
          ) : null}
        </div>
        {actions}
      </div>
      <div className="p-3 space-y-2">{children}</div>
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
      <div className="h-full w-full flex items-center justify-center p-4">
        <div className="rounded border border-[var(--jira-border)] bg-white p-4 max-w-md w-full shadow-[var(--jira-shadow-sm)] space-y-2">
          <div className="flex items-center gap-2 text-[var(--rf-danger)]">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <p className="text-[13px] font-semibold">Quick Refine unavailable</p>
          </div>
          <p className="text-[12px] text-[var(--jira-text-subtle)] leading-5">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!active && surface === 'issue-panel') {
    return (
      <div className="w-full px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)]">
            <Sparkles className="w-3.5 h-3.5" />
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="text-[13px] font-semibold text-[var(--jira-text)]">Quick Refine</span>
            <span className="rounded-full bg-[var(--rf-brand-subtle)] px-2 py-0.5 text-[11px] font-semibold text-[var(--rf-brand)] whitespace-nowrap">
              {getSessionBadgeCopy(session)}
            </span>
          </div>
          {isSessionProcessing ? (
            <div className="flex items-center gap-1.5 text-[12px] text-[var(--jira-text-subtle)]">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--rf-brand)] flex-shrink-0" />
              <span>Running…</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                openEditor();
                if (!hasResume) void handleStart();
              }}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded bg-[var(--rf-brand)] px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-[var(--rf-brand-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {hasResume ? 'Resume' : 'Refine'}
              <ArrowRight className="w-3 h-3" />
            </button>
          )}
          {onOpenSettings && !isSessionProcessing ? (
            <button
              type="button"
              onClick={onOpenSettings}
              className="text-[11px] font-medium text-[var(--jira-text-subtle)] hover:text-[var(--jira-text)] transition"
            >
              Settings
            </button>
          ) : null}
        </div>
        <p className="mt-0.5 pl-9 text-[11px] text-[var(--jira-text-subtle)]">
          {formatRelativeTimestamp(context?.updatedAt)}
        </p>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-auto">
      <AiPromptDialog
        open={aiDialogOpen}
        title="Refine this quick-rewrite draft"
        busy={aiBusy}
        error={aiError}
        onClose={() => setAiDialogOpen(false)}
        onSubmit={handleAiRefine}
      />

      <div className="mx-auto max-w-6xl space-y-1.5">
        <div className="overflow-hidden border-b border-[var(--jira-border)] bg-white">
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--jira-border)] px-3 py-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)]">
                <Sparkles className="w-3 h-3" />
              </div>
              <span className="text-[13px] font-semibold text-[var(--jira-text)]">Quick Refine</span>
              {issueKey ? (
                <span className="rounded bg-[var(--rf-brand-subtle)] px-2 py-0.5 text-[11px] font-semibold text-[var(--rf-brand)]">
                  {issueKey}
                </span>
              ) : null}
              {context?.issueType ? (
                <span className="rounded border border-[var(--jira-border)] px-2 py-0.5 text-[11px] text-[var(--jira-text-subtle)]">
                  {context.issueType}
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {stage === 'draft' ? (
                <div className="inline-flex rounded border border-[var(--jira-border)] bg-[var(--jira-bg)] p-0.5">
                  {(['diff', 'result'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setDraftViewMode(mode)}
                      className={`rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wide transition ${
                        draftViewMode === mode
                          ? 'bg-white text-[var(--jira-text)] shadow-[var(--jira-shadow-xs)]'
                          : 'text-[var(--jira-text-subtle)] hover:text-[var(--jira-text)]'
                      }`}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              ) : null}
              {modelOptions.length ? (
                <label className="inline-flex items-center gap-1.5 rounded border border-[var(--jira-border)] bg-white px-2 py-1">
                  <span className="text-[11px] text-[var(--jira-text-subtle)]">Model</span>
                  <select
                    value={modelOverride}
                    onChange={(event) => handleModelChange(event.target.value)}
                    className="bg-transparent text-[12px] font-medium text-[var(--jira-text)] outline-none"
                  >
                    {modelOptions.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              {!busy && !isSessionProcessing && stage === 'draft' ? (
                <button
                  type="button"
                  onClick={() => setAiDialogOpen(true)}
                  className="inline-flex items-center gap-1 rounded border border-[var(--jira-border)] bg-white px-2.5 py-1 text-[12px] font-medium text-[var(--jira-text-subtle)] transition hover:border-[var(--rf-brand)] hover:text-[var(--rf-brand)]"
                >
                  <WandSparkles className="w-3.5 h-3.5" />
                  AI Refine
                </button>
              ) : null}
              {!busy && !isSessionProcessing && (stage === 'draft' || stage === 'questions' || stage === 'handoff' || hasResume) ? (
                <button
                  type="button"
                  onClick={() => void handleStart({ restart: true })}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded border border-[var(--jira-border)] bg-white px-2.5 py-1 text-[12px] font-medium text-[var(--jira-text-subtle)] transition hover:text-[var(--jira-text)] disabled:opacity-50"
                >
                  <RefreshCcw className="w-3 h-3" />
                  Restart
                </button>
              ) : null}
              {onOpenSettings ? (
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="rounded border border-[var(--jira-border)] bg-white px-2.5 py-1 text-[12px] font-medium text-[var(--jira-text-subtle)] transition hover:text-[var(--jira-text)]"
                >
                  Settings
                </button>
              ) : null}
              {surface === 'issue-panel' ? (
                <button
                  type="button"
                  onClick={() => setActive(false)}
                  className="rounded border border-[var(--jira-border)] bg-white px-2.5 py-1 text-[12px] font-medium text-[var(--jira-text-subtle)] transition hover:text-[var(--jira-text)]"
                >
                  Collapse
                </button>
              ) : null}
            </div>
          </div>
          <div className="space-y-1.5 bg-[var(--jira-bg)] p-2">
            {error ? (
              <div className="rounded border border-[var(--rf-danger)]/25 bg-[var(--rf-danger-subtle)] px-3 py-2 text-[12px] text-[var(--rf-danger)]">
                {error}
              </div>
            ) : null}

            {applyResult ? (
              <div className="rounded border border-[var(--rf-success)]/20 bg-[var(--rf-success-subtle)] px-3 py-2 text-[12px] text-[var(--rf-success)] space-y-2">
                <div className="flex items-center gap-2 font-semibold">
                  <CopyCheck className="w-3.5 h-3.5" />
                  Quick refine applied to {applyResult.updatedIssueKey}
                </div>
                {applyResult.createdIssues.length ? (
                  <div className="flex flex-wrap gap-2">
                    {applyResult.createdIssues.map((created) => (
                      <button
                        key={created.issueKey}
                        type="button"
                        onClick={() => void router.navigate(created.issueUrl)}
                        className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1 text-[11px] font-semibold text-[var(--rf-brand)]"
                      >
                        {created.issueKey}
                        <ExternalLink className="w-3 h-3" />
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {busy && !isSessionProcessing ? (
              <div className="inline-flex items-center gap-2 rounded border border-[var(--jira-border)] bg-white px-3 py-2 text-[12px] text-[var(--jira-text-subtle)]">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--rf-brand)]" />
                {busyLabel}
              </div>
            ) : null}

            {stage === 'idle' && !busy && !isSessionProcessing ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-[var(--jira-border)] bg-white px-3 py-2.5">
                <span className="text-[13px] text-[var(--jira-text-subtle)]">
                  Rewrite this issue with backlog context and tighter acceptance requirements.
                </span>
                <button
                  type="button"
                  onClick={() => void handleStart()}
                  className="inline-flex items-center gap-2 rounded bg-[var(--rf-brand)] px-3 py-1.5 text-[13px] font-semibold text-white transition hover:bg-[var(--rf-brand-hover)] brainstorm-shimmer"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Quick Refine
                </button>
              </div>
            ) : null}

            {isSessionProcessing ? (
              <div className="rounded border border-[var(--jira-border)] bg-white px-3 py-2.5 space-y-1.5">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--rf-brand)] flex-shrink-0" />
                  <span className="text-[13px] font-semibold text-[var(--jira-text)]">
                    {session?.status === 'queued' ? 'Queued — loading context' : 'Building rewrite'}
                  </span>
                  <span className="ml-auto rounded-full bg-[var(--rf-brand-subtle)] px-2 py-0.5 text-[11px] font-semibold text-[var(--rf-brand)]">
                    {session?.status === 'queued' ? 'Queued' : 'Running'}
                  </span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-[var(--rf-brand-subtle)]">
                  <div className="h-full w-2/5 animate-pulse rounded-full bg-[var(--rf-brand)]" />
                </div>
                <p className="text-[12px] leading-5 text-[var(--jira-text-subtle)]">
                  {busyLabel || 'Keep this panel open or come back later — your session auto-resumes.'}
                </p>
              </div>
            ) : null}

            {stage === 'handoff' ? (
              <div className="rounded border border-[rgba(160,81,30,0.25)] bg-[var(--rf-warning-subtle)] px-3 py-3 space-y-2">
                <div className="flex items-start gap-2">
                  <MessagesSquare className="w-4 h-4 text-[var(--rf-warning)] mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-[13px] font-semibold text-[var(--rf-warning)]">This issue needs the full workflow</p>
                    <p className="mt-0.5 text-[12px] leading-5 text-[var(--jira-text-subtle)]">
                      {handoffReason || 'Too broad or ambiguous for the fast rewrite flow.'}
                    </p>
                  </div>
                </div>
                {onOpenFullWorkflow ? (
                  <button
                    type="button"
                    onClick={onOpenFullWorkflow}
                    className="inline-flex items-center gap-1.5 rounded bg-[var(--rf-brand)] px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-[var(--rf-brand-hover)]"
                  >
                    Open Full Refinely
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <p className="text-[12px] text-[var(--jira-text-subtle)]">
                    Use <span className="font-semibold text-[var(--jira-text)]">Refine Stories</span> to continue.
                  </p>
                )}
              </div>
            ) : null}

            {stage === 'questions' ? (
              <div className="space-y-1.5">
                {questions.map((question) => {
                  const answer = answers.find((entry) => entry.questionId === question.id);
                  return (
                    <div key={question.id} className="rounded border border-[var(--jira-border)] bg-white px-3 py-2.5 space-y-2">
                      <div className="flex items-center gap-1.5">
                        <MessagesSquare className="w-3.5 h-3.5 text-[var(--rf-brand)] flex-shrink-0" />
                        <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--rf-brand)]">Clarify</span>
                      </div>
                      <p className="text-[13px] font-semibold text-[var(--jira-text)] leading-snug">{question.question}</p>
                      {question.suggestions.length ? (
                        <div className="flex flex-wrap gap-1.5">
                          {question.suggestions.map((suggestion) => (
                            <button
                              key={suggestion}
                              type="button"
                              onClick={() => setQuestionAnswer(question, suggestion, suggestion)}
                              className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition ${answer?.selectedSuggestions?.includes(suggestion) ? 'bg-[var(--rf-brand)] text-white' : 'border border-[var(--jira-border)] bg-[var(--jira-bg)] text-[var(--jira-text-subtle)] hover:border-[var(--rf-brand)] hover:text-[var(--rf-brand)]'}`}
                            >
                              {suggestion}
                            </button>
                          ))}
                        </div>
                      ) : null}
                      <textarea
                        rows={2}
                        value={answer?.answer || ''}
                        onChange={(event) => setQuestionAnswer(question, event.target.value)}
                        className="w-full rounded border border-[var(--jira-border)] bg-[var(--jira-bg)] px-2.5 py-1.5 text-[13px] text-[var(--jira-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-1 focus:ring-[var(--rf-brand-subtle)] resize-y"
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
                    className="inline-flex items-center gap-1.5 rounded bg-[var(--rf-brand)] px-3 py-1.5 text-[13px] font-semibold text-white transition hover:bg-[var(--rf-brand-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <ArrowRight className="w-3.5 h-3.5" />
                    Build Rewrite Preview
                  </button>
                </div>
              </div>
            ) : null}

            {stage === 'draft' && draft && originalIssue ? (
              <div className="space-y-1.5">
                {draft.handoffRecommended ? (
                  <div className="rounded border border-[var(--rf-warning)]/25 bg-[var(--rf-warning-subtle)] px-3 py-2 text-[12px] text-[var(--rf-warning)]">
                    {draft.handoffReason || 'This draft is usable, but the issue still looks like it would benefit from the full Refinely workflow.'}
                  </div>
                ) : null}

                <DraftCard
                  title="Current Issue Rewrite"
                  changed={currentIssueChanged}
                  actions={(
                    <div className="flex items-center gap-1.5 text-[12px] text-[var(--jira-text-subtle)]">
                      <PencilLine className="w-3.5 h-3.5" />
                      {draftViewMode === 'diff' ? 'Compact diff' : 'Editable result'}
                    </div>
                  )}
                >
                  {draftViewMode === 'diff' ? (
                    <div className="space-y-2">
                      <div className="rounded border border-[var(--jira-border)] bg-[var(--jira-bg)] p-2.5">
                        <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-[var(--jira-text-subtle)]">Summary</p>
                        <div className="text-[13px] text-[var(--jira-text)]">
                          <DiffText oldText={(draft.diffBaseIssue ?? diffBaseIssue ?? originalIssue).summary} newText={draft.currentIssue.summary} mode="redline" />
                        </div>
                      </div>
                      <div className="rounded border border-[var(--jira-border)] bg-[var(--jira-bg)] p-2.5">
                        <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-[var(--jira-text-subtle)]">Description</p>
                        <div className="text-[13px] leading-6 text-[var(--jira-text)] whitespace-pre-wrap">
                          <DiffText oldText={(draft.diffBaseIssue ?? diffBaseIssue ?? originalIssue).description} newText={draft.currentIssue.description} mode="redline" />
                        </div>
                      </div>
                      <div className="rounded border border-[var(--jira-border)] bg-[var(--jira-bg)] p-2.5">
                        <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-[var(--jira-text-subtle)]">Acceptance Requirements</p>
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
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--jira-text-subtle)]">Summary</span>
                        <input
                          value={draft.currentIssue.summary}
                          onChange={(event) => setDraft({
                            ...draft,
                            currentIssue: {
                              ...draft.currentIssue,
                              summary: event.target.value,
                            },
                          })}
                          className="w-full rounded border border-[var(--jira-border)] bg-white px-3 py-1.5 text-[13px] text-[var(--jira-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-1 focus:ring-[var(--rf-brand-subtle)]"
                        />
                      </label>

                      <label className="block space-y-1">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--jira-text-subtle)]">Description</span>
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
                          className="w-full rounded border border-[var(--jira-border)] bg-white px-3 py-1.5 text-[13px] text-[var(--jira-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-1 focus:ring-[var(--rf-brand-subtle)]"
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
                      className="inline-flex items-center gap-1.5 rounded border border-[var(--jira-border)] bg-white px-2.5 py-1 text-[12px] font-medium text-[var(--jira-text-subtle)] transition hover:text-[var(--jira-text)]"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add Split
                    </button>
                  )}
                >
                  {draft.splitCandidates.length ? (
                    <div className="space-y-2">
                      {draft.splitCandidates.map((candidate, index) => (
                        <div key={candidate.id} className="rounded border border-[var(--jira-border)] bg-white p-2.5 space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => setDraft({
                                  ...draft,
                                  splitCandidates: draft.splitCandidates.map((item) => item.id === candidate.id ? { ...item, selected: !item.selected } : item),
                                })}
                                className={`inline-flex h-7 w-7 items-center justify-center rounded border transition ${candidate.selected ? 'border-[var(--rf-brand)] bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)]' : 'border-[var(--jira-border)] bg-white text-[var(--jira-text-subtle)]'}`}
                              >
                                {candidate.selected ? <Check className="w-3.5 h-3.5" /> : <SplitSquareVertical className="w-3.5 h-3.5" />}
                              </button>
                              <div>
                                <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--jira-text-subtle)]">Split {index + 1}</p>
                                <p className="text-[12px] font-semibold text-[var(--jira-text)]">{candidate.selected ? 'Will be created as a linked issue' : 'Draft only'}</p>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => setDraft({
                                ...draft,
                                splitCandidates: draft.splitCandidates.filter((item) => item.id !== candidate.id),
                              })}
                              className="inline-flex items-center gap-1 text-[11px] text-[var(--rf-danger)] hover:underline"
                            >
                              <Trash2 className="w-3 h-3" />
                              Delete
                            </button>
                          </div>

                          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr),128px]">
                            <label className="block space-y-1">
                              <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--jira-text-subtle)]">Summary</span>
                              <input
                                value={candidate.summary}
                                onChange={(event) => setDraft({
                                  ...draft,
                                  splitCandidates: draft.splitCandidates.map((item) => item.id === candidate.id ? { ...item, summary: event.target.value } : item),
                                })}
                                className="w-full rounded border border-[var(--jira-border)] bg-white px-2.5 py-1.5 text-[13px] text-[var(--jira-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-1 focus:ring-[var(--rf-brand-subtle)]"
                              />
                            </label>
                            <label className="block space-y-1">
                              <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--jira-text-subtle)]">Issue Type</span>
                              <select
                                value={candidate.issueType}
                                onChange={(event) => setDraft({
                                  ...draft,
                                  splitCandidates: draft.splitCandidates.map((item) => item.id === candidate.id ? { ...item, issueType: event.target.value } : item),
                                })}
                                className="w-full rounded border border-[var(--jira-border)] bg-white px-2.5 py-1.5 text-[13px] text-[var(--jira-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-1 focus:ring-[var(--rf-brand-subtle)]"
                              >
                                <option>Story</option>
                                <option>Task</option>
                                <option>Bug</option>
                                <option>Epic</option>
                              </select>
                            </label>
                          </div>

                          <label className="block space-y-1">
                            <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--jira-text-subtle)]">Description</span>
                            <textarea
                              rows={3}
                              value={candidate.description}
                              onChange={(event) => setDraft({
                                ...draft,
                                splitCandidates: draft.splitCandidates.map((item) => item.id === candidate.id ? { ...item, description: event.target.value } : item),
                              })}
                              className="w-full rounded border border-[var(--jira-border)] bg-white px-2.5 py-1.5 text-[13px] text-[var(--jira-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-1 focus:ring-[var(--rf-brand-subtle)]"
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
                    <div className="rounded border border-dashed border-[var(--jira-border)] px-3 py-4 text-center text-[12px] text-[var(--jira-text-subtle)]">
                      No split candidates yet. Keep this flow focused on rewriting the current issue unless you really need linked follow-on items.
                    </div>
                  )}
                </DraftCard>

                {draft.changeSummary?.length ? (
                  <div className="rounded border border-[var(--jira-border)] bg-white p-3">
                    <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--jira-text-subtle)]">Change Summary</p>
                    <ul className="mt-2 space-y-1.5 text-[12px] text-[var(--jira-text-subtle)]">
                      {draft.changeSummary.map((item) => (
                        <li key={item} className="flex gap-2">
                          <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--rf-brand)]" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-[12px] text-[var(--jira-text-subtle)]">
                    {selectedSplitCount
                      ? `${selectedSplitCount} split candidate${selectedSplitCount === 1 ? '' : 's'} selected for linked issue creation.`
                      : 'This apply will only update the current issue.'}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {draft.handoffRecommended && onOpenFullWorkflow ? (
                      <button
                        type="button"
                        onClick={onOpenFullWorkflow}
                        className="inline-flex items-center gap-1.5 rounded border border-[var(--jira-border)] bg-white px-3 py-1.5 text-[12px] font-medium text-[var(--jira-text-subtle)] transition hover:text-[var(--jira-text)]"
                      >
                        Open Full Refinely
                      </button>
                    ) : null}
                    {onOpenSettings ? (
                      <button
                        type="button"
                        onClick={onOpenSettings}
                        className="inline-flex items-center gap-1.5 rounded border border-[var(--jira-border)] bg-white px-3 py-1.5 text-[12px] font-medium text-[var(--jira-text-subtle)] transition hover:text-[var(--jira-text)]"
                      >
                        Settings
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void handleApply()}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 rounded bg-[var(--rf-brand)] px-3 py-1.5 text-[13px] font-semibold text-white transition hover:bg-[var(--rf-brand-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <CopyCheck className="w-3.5 h-3.5" />
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
