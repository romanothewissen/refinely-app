import React, { startTransition, useEffect, useMemo, useState } from 'react';
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
import type {
  AcceptanceRequirement,
  QuickRefineAnswer,
  QuickRefineApplyResult,
  QuickRefineDraft,
  QuickRefineIssueContext,
  QuickRefineQuestion,
  QuickRefineSession,
  QuickRefineSurface,
  SplitCandidate,
} from './types';

type Stage = 'idle' | 'loading' | 'questions' | 'draft' | 'handoff';

interface QuickRefineAppProps {
  surface: QuickRefineSurface;
  onOpenFullWorkflow?: () => void;
  onOpenSettings?: () => void;
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

function summarizeFieldMapping(context: QuickRefineIssueContext | null) {
  if (!context) return 'summary, description';
  const mapping = context.fieldMapping;
  const fields = [mapping.summaryFieldId, mapping.descriptionFieldId, ...mapping.arFieldIds]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
  return fields.join(', ');
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

function ArEditor({
  ars,
  onChange,
}: {
  ars: AcceptanceRequirement[];
  onChange: (next: AcceptanceRequirement[]) => void;
}) {
  return (
    <div className="space-y-3">
      {ars.map((ar, index) => (
        <div key={`ar-${index}`} className="rounded-2xl border border-[var(--rf-border)] bg-white/70 p-3 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">AR {index + 1}</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs text-[var(--rf-danger)]"
              onClick={() => onChange(ars.filter((_, candidateIndex) => candidateIndex !== index))}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
          </div>
          {(['given', 'when', 'then'] as const).map((field) => (
            <label key={field} className="block space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">{field}</span>
              <textarea
                rows={2}
                value={ar[field]}
                onChange={(event) => {
                  const next = [...ars];
                  next[index] = {
                    ...next[index],
                    [field]: event.target.value,
                  };
                  onChange(next);
                }}
                className="w-full rounded-xl border border-[var(--rf-border)] bg-white px-3 py-2 text-sm text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand-subtle)]"
              />
            </label>
          ))}
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...(ars.length ? ars : []), emptyAr()])}
        className="inline-flex items-center gap-2 rounded-2xl border border-dashed border-[var(--rf-border-strong)] px-3 py-2 text-sm font-semibold text-[var(--rf-brand)] transition hover:border-[var(--rf-brand)] hover:bg-[var(--rf-brand-subtle)]"
      >
        <Plus className="w-4 h-4" />
        Add Acceptance Requirement
      </button>
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
    <div className="rf-card overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--rf-border-subtle)] px-5 py-4 bg-white/50">
        <div className="flex items-center gap-3">
          <h3 className="text-xl font-semibold text-[var(--rf-text)]">{title}</h3>
          {typeof changed === 'boolean' ? (
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.18em] ${changed ? 'bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)]' : 'bg-[var(--rf-surface-soft)] text-[var(--rf-text-tertiary)]'}`}>
              {changed ? 'Updated' : 'Unchanged'}
            </span>
          ) : null}
        </div>
        {actions}
      </div>
      <div className="p-5 space-y-4">{children}</div>
    </div>
  );
}

export function QuickRefineApp({ surface, onOpenFullWorkflow, onOpenSettings }: QuickRefineAppProps) {
  const [issueKey, setIssueKey] = useState('');
  const [projectKey, setProjectKey] = useState('');
  const [context, setContext] = useState<QuickRefineIssueContext | null>(null);
  const [session, setSession] = useState<QuickRefineSession | null>(null);
  const [sessionId, setSessionId] = useState<string>('');
  const [stage, setStage] = useState<Stage>('idle');
  const [active, setActive] = useState(surface === 'issue-action');
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

        const contextRes = await api.getQuickRefineIssueContext({
          issueKey: nextIssueKey,
          projectKey: nextProjectKey,
          surface,
        }) as any;
        if (!contextRes?.success) {
          throw new Error(contextRes?.error || 'Could not load issue context.');
        }

        if (cancelled) return;
        const nextContext = contextRes.context as QuickRefineIssueContext;
        setContext(nextContext);

        if (nextContext.existingSessionId) {
          const sessionRes = await api.getQuickRefineSession({ sessionId: nextContext.existingSessionId }) as any;
          if (sessionRes?.success && sessionRes?.session && !cancelled) {
            const nextSession = sessionRes.session as QuickRefineSession;
            startTransition(() => {
              setSession(nextSession);
              setSessionId(nextSession.sessionId);
              setApplyResult(nextSession.applyResult || null);
              setHandoffReason(nextSession.handoffReason || '');
              if (nextSession.status === 'needs_clarification' && nextSession.questions?.length) {
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
  }, [surface]);

  const hasResume = Boolean(session && (session.questions?.length || session.draft || session.status === 'handoff'));
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

  const restoreFromSession = (nextSession: QuickRefineSession) => {
    setSession(nextSession);
    setSessionId(nextSession.sessionId);
    setApplyResult(nextSession.applyResult || null);
    setHandoffReason(nextSession.handoffReason || '');
    if (nextSession.status === 'needs_clarification' && nextSession.questions?.length) {
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
      setDraft(nextSession.draft);
      setStage('draft');
      return;
    }
    if (nextSession.status === 'handoff') {
      setStage('handoff');
      return;
    }
    setStage('idle');
  };

  const handleStart = async () => {
    if (!issueKey || !projectKey) return;
    const nextSessionId = sessionId || createSessionId();
    setSessionId(nextSessionId);
    setBusy(true);
    setBusyLabel('Building quick rewrite');
    setError('');
    try {
      const res = await api.startQuickRefine({
        issueKey,
        projectKey,
        sessionId: nextSessionId,
        surface,
      }) as any;
      if (!res?.success) {
        throw new Error(res?.error || 'Quick refine could not start.');
      }

      if (res.route === 'clarify') {
        const nextQuestions = Array.isArray(res.questions) ? res.questions as QuickRefineQuestion[] : [];
        setQuestions(nextQuestions);
        setAnswers(nextQuestions.map((question) => ({
          questionId: question.id,
          question: question.question,
          answer: '',
          selectedSuggestions: [],
        })));
        setStage('questions');
      } else if (res.route === 'rewrite') {
        setDraft(res.draft as QuickRefineDraft);
        setStage('draft');
      } else {
        setHandoffReason(String(res.reason ?? 'This issue needs the full Refinely workflow.'));
        setStage('handoff');
      }

      const sessionRes = await api.getQuickRefineSession({ sessionId: nextSessionId }) as any;
      if (sessionRes?.success && sessionRes?.session) {
        restoreFromSession(sessionRes.session as QuickRefineSession);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
        <div className="rf-card h-full p-3 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="inline-flex h-7 w-7 items-center justify-center rounded-xl bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)]">
                <Sparkles className="w-3.5 h-3.5" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-sm font-semibold text-[var(--rf-text)]">Quick Refine</h2>
                  <span className="rounded-full border border-[var(--rf-border)] bg-white px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--rf-text-secondary)]">
                    {hasResume ? 'Draft ready' : 'Ready'}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--rf-text-tertiary)]">
                  <span>{context?.contextMeta.similarStoriesCount ?? 0} similar</span>
                  <span>{context?.contextMeta.wiDocsCount ?? 0} WI docs</span>
                  <span>{formatRelativeTimestamp(context?.updatedAt)}</span>
                </div>
              </div>
            </div>
            <span className="rounded-full border border-[var(--rf-border)] bg-white/80 px-2 py-0.5 text-[10px] text-[var(--rf-text-tertiary)]">
              {summarizeFieldMapping(context)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                openEditor();
                if (!hasResume) void handleStart();
              }}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg bg-[var(--rf-brand)] px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-[var(--rf-brand-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardPenLine className="w-4 h-4" />}
              {hasResume ? 'Resume Draft' : 'Quick Rewrite'}
            </button>
            {hasResume ? (
              <button
                type="button"
                onClick={() => {
                  openEditor();
                  if (session) restoreFromSession(session);
                }}
                className="inline-flex items-center gap-2 rounded-lg border border-[var(--rf-border)] px-3 py-1.5 text-sm font-semibold text-[var(--rf-text-secondary)] transition hover:border-[var(--rf-border-strong)] hover:bg-white/80"
              >
                <RefreshCcw className="w-4 h-4" />
                Resume
              </button>
            ) : null}
            {onOpenSettings ? (
              <button
                type="button"
                onClick={onOpenSettings}
                className="inline-flex items-center gap-2 rounded-lg border border-[var(--rf-border)] px-3 py-1.5 text-sm font-semibold text-[var(--rf-text-secondary)] transition hover:border-[var(--rf-border-strong)] hover:bg-white/80"
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
    <div className={`h-full w-full ${surface === 'issue-action' ? 'p-4' : 'p-3'} overflow-auto`}>
      <AiPromptDialog
        open={aiDialogOpen}
        title="Refine this quick-rewrite draft"
        busy={aiBusy}
        error={aiError}
        onClose={() => setAiDialogOpen(false)}
        onSubmit={handleAiRefine}
      />

      <div className="mx-auto max-w-6xl space-y-3">
        <div className="rf-card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--rf-border-subtle)] bg-white/55 px-4 py-3">
            <div className="min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--rf-text-tertiary)]">
                {surface === 'issue-action' ? 'Issue Action' : 'Issue Panel'}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold text-[var(--rf-text)]">Quick Refine</h1>
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
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {onOpenSettings ? (
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="rounded-xl border border-[var(--rf-border)] bg-white px-3 py-2 text-sm font-semibold text-[var(--rf-text-secondary)] transition hover:border-[var(--rf-border-strong)]"
                >
                  Settings
                </button>
              ) : null}
              {surface === 'issue-panel' ? (
                <button
                  type="button"
                  onClick={() => setActive(false)}
                  className="rounded-xl border border-[var(--rf-border)] bg-white px-3 py-2 text-sm font-semibold text-[var(--rf-text-secondary)] transition hover:border-[var(--rf-border-strong)]"
                >
                  Collapse
                </button>
              ) : null}
              {stage === 'draft' ? (
                <button
                  type="button"
                  onClick={() => setAiDialogOpen(true)}
                  className="inline-flex items-center gap-2 rounded-xl border border-[var(--rf-border)] bg-white px-3 py-2 text-sm font-semibold text-[var(--rf-text-secondary)] transition hover:border-[var(--rf-border-strong)]"
                >
                  <WandSparkles className="w-4 h-4 text-[var(--rf-brand)]" />
                  AI Refine
                </button>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap gap-2 border-b border-[var(--rf-border-subtle)] bg-[var(--rf-brand-muted)]/60 px-4 py-3 text-xs text-[var(--rf-text-secondary)]">
            <span className="rounded-full border border-[var(--rf-border)] bg-white/80 px-2.5 py-1 break-all">{summarizeFieldMapping(context)}</span>
            <span className="rounded-full border border-[var(--rf-border)] bg-white/80 px-2.5 py-1">
              {context?.contextMeta.domainContextApplied ? 'project context on' : 'project context off'}
            </span>
            <span className="rounded-full border border-[var(--rf-border)] bg-white/80 px-2.5 py-1">
              {context?.contextMeta.similarStoriesCount ?? 0} similar
            </span>
            <span className="rounded-full border border-[var(--rf-border)] bg-white/80 px-2.5 py-1">
              {context?.contextMeta.wiDocsCount ?? 0} WI docs
            </span>
          </div>

          <div className="p-4 space-y-3">
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

            {busy ? (
              <div className="rounded-2xl border border-[var(--rf-border)] bg-white/70 px-4 py-3 text-sm text-[var(--rf-text-secondary)] inline-flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-[var(--rf-brand)]" />
                {busyLabel}
              </div>
            ) : null}

            {stage === 'idle' ? (
              <div className="rounded-2xl border border-dashed border-[var(--rf-border-strong)] bg-white/65 px-4 py-5 text-center">
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Ready</p>
                <h2 className="mt-1 text-xl font-semibold text-[var(--rf-text)]">Generate a quick rewrite preview</h2>
                <button
                  type="button"
                  onClick={() => void handleStart()}
                  className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[var(--rf-brand)] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[var(--rf-brand-hover)]"
                >
                  <Sparkles className="w-4 h-4" />
                  Start Quick Rewrite
                </button>
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
              <div className="space-y-3">
                {questions.map((question) => {
                  const answer = answers.find((entry) => entry.questionId === question.id);
                  return (
                    <div key={question.id} className="rf-card p-4 space-y-3">
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
                        className="w-full rounded-xl border border-[var(--rf-border)] bg-white px-3 py-2.5 text-sm text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand-subtle)]"
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
              <div className="space-y-3">
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
                      Editable preview
                    </div>
                  )}
                >
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
                      className="w-full rounded-2xl border border-[var(--rf-border)] bg-white px-4 py-3 text-sm text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand-subtle)]"
                    />
                    {isFieldChanged(originalIssue.summary, draft.currentIssue.summary) ? (
                      <p className="text-xs text-[var(--rf-text-tertiary)]">Original: {originalIssue.summary}</p>
                    ) : null}
                  </label>

                  <label className="block space-y-1">
                    <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Description</span>
                    <textarea
                      rows={5}
                      value={draft.currentIssue.description}
                      onChange={(event) => setDraft({
                        ...draft,
                        currentIssue: {
                          ...draft.currentIssue,
                          description: event.target.value,
                        },
                      })}
                      className="w-full rounded-2xl border border-[var(--rf-border)] bg-white px-4 py-3 text-sm text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand-subtle)]"
                    />
                  </label>

                  <ArEditor
                    ars={draft.currentIssue.acceptanceRequirements}
                    onChange={(next) => setDraft({
                      ...draft,
                      currentIssue: {
                        ...draft.currentIssue,
                        acceptanceRequirements: next,
                      },
                    })}
                  />
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
                      className="inline-flex items-center gap-2 rounded-2xl border border-[var(--rf-border)] bg-white px-3 py-2 text-sm font-semibold text-[var(--rf-text-secondary)] transition hover:border-[var(--rf-border-strong)]"
                    >
                      <Plus className="w-4 h-4" />
                      Add Split Candidate
                    </button>
                  )}
                >
                  {draft.splitCandidates.length ? (
                    <div className="space-y-4">
                      {draft.splitCandidates.map((candidate, index) => (
                        <div key={candidate.id} className="rounded-2xl border border-[var(--rf-border)] bg-white/70 p-3 space-y-3">
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

                          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr),140px]">
                            <label className="block space-y-1">
                              <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Summary</span>
                              <input
                                value={candidate.summary}
                                onChange={(event) => setDraft({
                                  ...draft,
                                  splitCandidates: draft.splitCandidates.map((item) => item.id === candidate.id ? { ...item, summary: event.target.value } : item),
                                })}
                                className="w-full rounded-2xl border border-[var(--rf-border)] bg-white px-4 py-3 text-sm text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand-subtle)]"
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
                                className="w-full rounded-2xl border border-[var(--rf-border)] bg-white px-4 py-3 text-sm text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand-subtle)]"
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
                              className="w-full rounded-2xl border border-[var(--rf-border)] bg-white px-4 py-3 text-sm text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand-subtle)]"
                            />
                          </label>

                          <ArEditor
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
                  <div className="rf-card p-5">
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
