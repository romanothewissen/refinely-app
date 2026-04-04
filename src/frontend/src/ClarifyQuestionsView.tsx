import React, { useEffect, useState } from 'react';
import { ArrowRight, Check, Menu, Sparkles, AlertCircle, ExternalLink } from 'lucide-react';
import { motion } from 'framer-motion';
import { router } from '@forge/bridge';
import type { ClarifyAnswer, ClarifyCategoryKey, ClarifyContextMeta, ClarifyFailureReasonCode, ClarifyQuestion } from './types';

const CATEGORY_ORDER: ClarifyCategoryKey[] = [
  'context_trigger',
  'user_personas',
  'information_architecture',
  'business_rules',
  'state_lifecycle',
  'edge_cases_exceptions',
];

const CATEGORY_LABELS: Record<ClarifyCategoryKey, string> = {
  context_trigger: 'Context & Trigger',
  user_personas: 'User Personas',
  information_architecture: 'Information Architecture',
  business_rules: 'Business Rules',
  state_lifecycle: 'State & Lifecycle',
  edge_cases_exceptions: 'Edge Cases & Exceptions',
};

interface ClarifyProps {
  questions: ClarifyQuestion[];
  onComplete: (answers: ClarifyAnswer[]) => void;
  onSkip: () => void;
  onRetry?: () => void;
  round?: 1 | 2;
  isSubmitting?: boolean;
  submitLabel?: string;
  skipLabel?: string;
  contextMeta?: ClarifyContextMeta | null;
  blockingState?: { message: string; reasonCode?: ClarifyFailureReasonCode } | null;
  inlineError?: string | null;
  sidebarOpen: boolean;
  setSidebarOpen: (o: boolean) => void;
}

type LocalAnswerState = {
  selectedSuggestions: string[];
  customAnswer: string;
};

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

function renderQuestionWithStoryLinks(
  question: string,
  storyLookup: Map<string, string>,
) {
  const storyKeyRegex = /\b[A-Z][A-Z0-9]+-\d+\b/g;
  const matches = Array.from(question.matchAll(storyKeyRegex));
  if (!matches.length) return question;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  matches.forEach((match, index) => {
    const key = match[0];
    const start = match.index ?? 0;
    if (start > cursor) {
      parts.push(<React.Fragment key={`text-${index}`}>{question.slice(cursor, start)}</React.Fragment>);
    }

    const url = storyLookup.get(key) || `/browse/${key}`;
    parts.push(
      <button
        key={`story-${key}-${index}`}
        type="button"
        onClick={() => void router.navigate(url)}
        className="inline text-[var(--rf-brand)] underline decoration-[var(--rf-brand-subtle)] underline-offset-2 hover:text-[var(--rf-brand-hover)] transition-colors"
        title={`Open ${key}`}
      >
        {key}
      </button>,
    );
    cursor = start + key.length;
  });

  if (cursor < question.length) {
    parts.push(<React.Fragment key="text-final">{question.slice(cursor)}</React.Fragment>);
  }

  return parts;
}

function buildCompatibilityAnswer(selectedSuggestions: string[], customAnswer: string): string {
  const custom = customAnswer.trim();
  const suggestions = selectedSuggestions.map((suggestion) => suggestion.trim()).filter(Boolean);

  if (!suggestions.length) return custom;
  const selectedLabel = suggestions.length === 1 ? 'Chosen answer' : 'Chosen answers';
  const selectedBlock = `${selectedLabel}:\n${suggestions.map((suggestion) => `- ${suggestion}`).join('\n')}`;
  if (!custom) return selectedBlock;
  return `${selectedBlock}\n\nAdditional context:\n${custom}`;
}

export function ClarifyQuestionsView({
  questions,
  onComplete,
  onSkip,
  onRetry,
  round = 1,
  isSubmitting = false,
  submitLabel,
  skipLabel,
  contextMeta,
  blockingState,
  inlineError,
  sidebarOpen,
  setSidebarOpen,
}: ClarifyProps) {
  const [answers, setAnswers] = useState<Record<number, LocalAnswerState>>({});
  const [showContextDetails, setShowContextDetails] = useState(false);

  useEffect(() => {
    setAnswers({});
  }, [questions, round]);

  const answeredCount = Object.values(answers).filter(a => a && (a.selectedSuggestions.length > 0 || a.customAnswer.trim())).length;
  const isBlocked = Boolean(blockingState && questions.length === 0);
  const storyLookup = new Map(
    (contextMeta?.referencedSimilarStories ?? [])
      .map(story => [story.key, resolveStoryUrl(story)] as const)
      .filter(([key, url]) => Boolean(key && url)),
  );

  function ensureAnswer(idx: number) {
    return answers[idx] ?? { selectedSuggestions: [], customAnswer: '' };
  }

  function toggleSuggestion(qIdx: number, sug: string) {
    const existing = ensureAnswer(qIdx);
    const alreadySelected = existing.selectedSuggestions.includes(sug);
    const newSelected = alreadySelected
      ? existing.selectedSuggestions.filter(s => s !== sug)
      : [...existing.selectedSuggestions, sug];

    setAnswers(prev => ({ ...prev, [qIdx]: { ...existing, selectedSuggestions: newSelected } }));
  }

  function handleCustomChange(qIdx: number, val: string) {
    setAnswers(prev => ({ ...prev, [qIdx]: { ...ensureAnswer(qIdx), customAnswer: val } }));
  }

  function handleSubmit() {
    const result: ClarifyAnswer[] = questions.map((q, i) => {
      const a = ensureAnswer(i);
      const answer = buildCompatibilityAnswer(a.selectedSuggestions, a.customAnswer);
      return {
        question: q.question,
        categoryKey: q.categoryKey,
        intent: q.intent,
        selectedSuggestions: a.selectedSuggestions,
        customAnswer: a.customAnswer.trim() || undefined,
        answer,
      };
    }).filter(answer => answer.answer || answer.selectedSuggestions.length || answer.customAnswer);
    console.log('[ClarifyQuestionsView] handleSubmit called, answers:', result.length);
    onComplete(result);
  }

  const categories = CATEGORY_ORDER
    .map((categoryKey) => ({
      categoryKey,
      label: CATEGORY_LABELS[categoryKey],
      items: questions
        .map((question, index) => ({ idx: index, q: question }))
        .filter(({ q }) => q.categoryKey === categoryKey),
    }))
    .filter((section) => section.items.length > 0);

  return (
    <div className="flex-1 flex min-w-0 flex-col h-full overflow-hidden fade-in bg-transparent">
      <motion.header
        className="rf-pane-header rf-pane-header--canvas shrink-0 sticky top-0"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="flex h-full w-full min-w-0 items-center justify-between gap-4">
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
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-[rgba(43,89,74,0.12)] bg-[var(--rf-brand-muted)] shadow-sm">
              <Sparkles className="w-5 h-5 text-[var(--rf-brand)]" />
            </div>
            <div className="rf-pane-header-copy">
              <div className="rf-pane-header-kicker">Discovery Flow</div>
              <h1 className="rf-pane-header-title">Requirement Discovery</h1>
              <p className="rf-pane-header-subtitle">
                Round {round} of 2 · {answeredCount} of {questions.length} questions explored
              </p>
            </div>
          </div>

          <div className="hidden min-[980px]:flex min-w-[320px] max-w-[420px] flex-1 items-center gap-4">
            <div className="flex-1">
              <div className="mb-2 flex items-center justify-between text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">
                <span>Coverage</span>
                <span>{answeredCount}/{questions.length}</span>
              </div>
              <div className="h-2 rounded-full bg-[rgba(35,74,61,0.08)] overflow-hidden">
                <div
                  className="h-full rounded-full bg-[linear-gradient(90deg,var(--rf-brand),var(--rf-brand-hover))] transition-all duration-500"
                  style={{ width: `${(answeredCount / Math.max(questions.length, 1)) * 100}%` }}
                />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <motion.button
              onClick={onSkip}
              disabled={isSubmitting}
              className="text-xs font-bold text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text-secondary)] transition px-3 py-2 rounded-lg hover:bg-[var(--rf-surface-soft)]"
              whileTap={{ scale: 0.97 }}
            >
              {skipLabel ?? (round === 2 ? 'Skip follow-up' : 'Skip all')}
            </motion.button>
            {isBlocked ? (
              <motion.button
                onClick={onRetry}
                disabled={isSubmitting || !onRetry}
                className="brainstorm-shimmer flex items-center gap-2 px-5 py-2.5 rounded-[18px] text-sm font-bold text-white bg-[linear-gradient(135deg,#1e4035,#2b594a,#3a7062)] hover:brightness-[1.04] transition shadow-sm shadow-[var(--rf-brand)]/20 disabled:opacity-60"
                whileTap={{ scale: 0.98 }}
              >
                Retry discovery
                <ArrowRight className="w-4 h-4" />
              </motion.button>
            ) : (
              <motion.button
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="brainstorm-shimmer flex items-center gap-2 px-5 py-2.5 rounded-[18px] text-sm font-bold text-white bg-[linear-gradient(135deg,#1e4035,#2b594a,#3a7062)] hover:brightness-[1.04] transition shadow-sm shadow-[var(--rf-brand)]/20"
                whileTap={{ scale: 0.98 }}
              >
                {isSubmitting ? 'Checking sufficiency…' : (submitLabel ?? (round === 2 ? 'Generate Features' : 'Continue Discovery'))}
                <ArrowRight className="w-4 h-4" />
              </motion.button>
            )}
          </div>
        </div>
      </motion.header>

      <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-5">
        <div className="mx-auto w-full max-w-[1320px] space-y-6 pb-10">
          {contextMeta && (
            <motion.div
              className="relative overflow-hidden rounded-[28px] border border-[var(--rf-border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(250,247,240,0.96))] shadow-[0_32px_80px_-48px_rgba(15,23,42,0.3)]"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="absolute inset-x-0 top-0 h-1.5 overflow-hidden">
                <div className="h-full w-full bg-[linear-gradient(90deg,rgba(43,89,74,0.16),rgba(43,89,74,0.55),rgba(179,94,48,0.28))]" />
              </div>
              <div className="relative overflow-hidden border-b border-[var(--rf-border-subtle)] bg-[radial-gradient(circle_at_top,rgba(53,113,95,0.14),transparent_42%),linear-gradient(135deg,rgba(255,255,255,0.95),rgba(244,239,230,0.9))] px-5 sm:px-6 py-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="max-w-3xl">
                    <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[var(--rf-brand)]">Discovery Context</div>
                    <div className="mt-2 flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-[rgba(43,89,74,0.12)] bg-white shadow-sm">
                        <AlertCircle className="w-4 h-4 text-[var(--rf-brand)]" />
                      </div>
                      <div>
                        <div className="text-[20px] font-semibold tracking-tight text-[var(--rf-text)]" style={{ fontFamily: 'Fraunces, serif' }}>
                          Discovery is grounding the requirement
                        </div>
                        <p className="mt-0.5 text-[13px] text-[var(--rf-text-secondary)]">
                          Review the context pool, then answer only what meaningfully sharpens scope.
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 sm:gap-3 lg:min-w-[320px]">
                    <div className="rounded-2xl border border-[rgba(43,89,74,0.08)] bg-white/72 px-3.5 py-2.5">
                      <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">Project</div>
                      <div className="mt-1 text-sm font-semibold text-[var(--rf-text)]">{contextMeta.projectKey === '*' ? 'Global' : contextMeta.projectKey}</div>
                    </div>
                    <div className="rounded-2xl border border-[rgba(43,89,74,0.08)] bg-white/72 px-3.5 py-2.5">
                      <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">Docs</div>
                      <div className="mt-1 text-sm font-semibold text-[var(--rf-text)]">{contextMeta.wiDocsCount ?? 0}</div>
                    </div>
                    <div className="rounded-2xl border border-[rgba(43,89,74,0.08)] bg-white/72 px-3.5 py-2.5">
                      <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">Refs</div>
                      <div className="mt-1 text-sm font-semibold text-[var(--rf-text)]">{contextMeta.similarStoriesCount ?? 0}</div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="px-5 sm:px-6 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-xs font-medium text-[var(--rf-text-secondary)]">
                    Sources used for this pass, plus the ambiguity signals behind the follow-up questions.
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowContextDetails(v => !v)}
                    className="text-xs font-bold text-[var(--rf-brand)] hover:text-[var(--rf-brand-hover)] transition-colors"
                  >
                    {showContextDetails ? 'Hide details' : 'Show details'}
                  </button>
                </div>
              </div>

              {showContextDetails && (
                <motion.div
                  className="border-t border-[var(--rf-border)]/60 px-5 sm:px-6 py-4 space-y-4 text-xs"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                >
                  {contextMeta.ambiguityAssessment?.reasons?.length ? (
                    <div className="text-[var(--rf-text-secondary)] bg-[var(--rf-brand-muted)]/50 p-3 rounded-xl border border-[rgba(43,89,74,0.12)] leading-relaxed">
                      <strong className="text-[var(--rf-brand-hover)] mb-1 block">Analysis:</strong>
                      {contextMeta.ambiguityAssessment.reasons.join(' ')}
                    </div>
                  ) : null}
                  <div className="grid grid-cols-1 gap-2 text-[var(--rf-text-secondary)] mt-2 md:grid-cols-3">
                    <div className="rounded-xl border border-[var(--rf-border)] bg-white px-3 py-2">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Domain guidance</div>
                      <div className="mt-1 text-xs font-medium text-[var(--rf-text)]">{contextMeta.domainContextApplied ? 'Included' : 'Not configured'}</div>
                    </div>
                    <div className="rounded-xl border border-[var(--rf-border)] bg-white px-3 py-2">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Attachment</div>
                      <div className="mt-1 text-xs font-medium text-[var(--rf-text)]">{contextMeta.attachmentIncluded ? 'Included' : 'None'}</div>
                    </div>
                    <div className="rounded-xl border border-[var(--rf-border)] bg-white px-3 py-2">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Roles</div>
                      <div className="mt-1 text-xs font-medium text-[var(--rf-text)]">
                        {contextMeta.domainRolesUsed?.length > 0 ? contextMeta.domainRolesUsed.join(', ') : 'No specific role guidance'}
                      </div>
                    </div>
                  </div>
                  {(contextMeta.referencedSimilarStories?.length ?? 0) > 0 && (
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-2">Similar backlog stories</div>
                      <div className="grid gap-3 xl:grid-cols-2">
                        {contextMeta.referencedSimilarStories!.map((story, i) => (
                          <div key={`${story.key}-${i}`} className="rf-card p-3 ">
                            <div className="flex items-start justify-between gap-3">
                              {resolveStoryUrl(story) ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    const url = resolveStoryUrl(story);
                                    if (url) void router.navigate(url);
                                  }}
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
                                <div className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-[var(--rf-text-tertiary)] bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-md px-2 py-1">
                                  {(story.relevanceScore * 100).toFixed(0)}% match
                                </div>
                              )}
                            </div>
                            <div className="mt-2 text-xs text-[var(--rf-text-secondary)] leading-relaxed">
                              {buildExcerpt(story.summary, 180)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">
                        Matched WI sections
                      </div>
                      <div className="text-[11px] text-[var(--rf-text-tertiary)]">
                        {contextMeta.referencedWiDocs?.length
                          ? `${contextMeta.referencedWiDocs.length} docs referenced`
                          : 'No matching docs found'}
                      </div>
                    </div>
                    {(contextMeta.referencedWiSections?.length ?? 0) > 0 ? (
                      <div className="grid gap-3 xl:grid-cols-2">
                        {contextMeta.referencedWiSections!.map((section, i) => (
                          <div key={`${section.docId}-${section.chunkIndex}-${i}`} className="rf-card p-3 ">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-[11px] font-bold text-[var(--rf-text)] truncate">
                                  {section.filename}
                                </div>
                                <div className="mt-1 inline-flex items-center rounded-md border border-[var(--rf-border-subtle)] bg-[var(--rf-surface-soft)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">
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
                      <div className="text-[var(--rf-text-tertiary)] italic text-xs">No matched WI sections were used.</div>
                    )}
                  </div>
                  
                  {contextMeta.tokenUsage && (
                    <div className="text-[var(--rf-text-tertiary)] mt-3 pt-3 border-t border-[var(--rf-border-subtle)]">
                      Tokens used: {contextMeta.tokenUsage.total.toLocaleString()} ({contextMeta.tokenUsage.input.toLocaleString()} in / {contextMeta.tokenUsage.output.toLocaleString()} out)
                    </div>
                  )}
                </motion.div>
              )}
            </motion.div>
          )}

          {inlineError && questions.length > 0 && (
            <motion.div
              className="rounded-[22px] border border-[var(--rf-danger-subtle)] bg-[var(--rf-danger-subtle)]/35 px-5 py-4 text-sm text-[var(--rf-danger)] shadow-sm"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <div className="font-bold">Discovery needs another try</div>
              <div className="mt-1 leading-relaxed">{inlineError}</div>
            </motion.div>
          )}

          {blockingState && questions.length === 0 && (
            <motion.div
              className="rf-card p-8"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-2xl bg-[var(--rf-danger-subtle)]/50 flex items-center justify-center text-[var(--rf-danger)] border border-[var(--rf-danger-subtle)]">
                  <AlertCircle className="w-5 h-5" />
                </div>
                <div className="flex-1">
                  <h2 className="text-lg font-bold text-[var(--rf-text)]">Discovery is blocked</h2>
                  <p className="mt-2 text-sm text-[var(--rf-text-secondary)] leading-relaxed">
                    {blockingState.message}
                  </p>
                  <p className="mt-2 text-xs font-medium text-[var(--rf-text-tertiary)]">
                    Requirement discovery did not complete successfully, so generation is paused until you retry or skip explicitly.
                  </p>
                  <div className="mt-5 flex flex-wrap gap-3">
                    {onRetry && (
                      <button
                        type="button"
                        onClick={onRetry}
                        className="brainstorm-shimmer flex items-center gap-2 px-5 py-2.5 rounded-[18px] text-sm font-bold text-white bg-[linear-gradient(135deg,#1e4035,#2b594a,#3a7062)] hover:brightness-[1.04] transition shadow-sm shadow-[var(--rf-brand)]/20"
                      >
                        Retry discovery
                        <ArrowRight className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={onSkip}
                      className="px-4 py-2.5 rounded-[18px] text-sm font-bold border border-[var(--rf-border)] text-[var(--rf-text-secondary)] hover:border-[var(--rf-border-strong)] hover:bg-[var(--rf-surface-soft)] transition"
                    >
                      {skipLabel ?? 'Skip all'}
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {questions.length > 0 && categories.map(({ categoryKey, label, items }, idx) => (
            <motion.div
              key={categoryKey}
              className="space-y-3"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.1, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="flex items-center gap-4">
                <span className="inline-flex items-center rounded-lg px-3 py-1 text-[11px] font-bold uppercase tracking-widest bg-[var(--rf-text)] text-white shadow-sm">
                  {label}
                </span>
                <div className="flex-1 h-px bg-[var(--rf-border)]" />
              </div>

              <div className="grid gap-3">
                {items.map(({ idx, q }) => {
                  const ans = ensureAnswer(idx);
                  const isAnswered = ans.customAnswer.trim().length > 0 || ans.selectedSuggestions.length > 0;
                  const suggestions = q.suggestions.slice(0, 4);

                  return (
                    <div
                      key={idx}
                      className={`overflow-hidden rounded-[24px] border shadow-sm transition-all duration-300 ${
                        isAnswered
                          ? 'border-[var(--rf-brand-subtle)] bg-[linear-gradient(180deg,rgba(248,252,250,0.98),rgba(255,255,255,0.95))] shadow-md shadow-[var(--rf-brand)]/5'
                          : 'border-[var(--rf-border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(249,247,243,0.94))] hover:border-[var(--rf-border-strong)] hover:shadow-md'
                      }`}
                    >
                      <div className="space-y-3 p-4">
                        <div className="flex items-start gap-3">
                          <div className={`flex h-8 w-8 rounded-xl items-center justify-center shrink-0 transition-all text-sm font-bold shadow-inner ${isAnswered ? 'bg-[var(--rf-brand)] text-white' : 'bg-[var(--rf-surface-soft)] text-[var(--rf-text-tertiary)] border border-[var(--rf-border)]'}`}>
                            {isAnswered ? <Check className="w-4 h-4" /> : <span>{idx + 1}</span>}
                          </div>
                          <div className="space-y-1.5 min-w-0">
                            <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">{label}</div>
                            <p className="text-[15px] font-bold text-[var(--rf-text)] leading-snug">
                              {renderQuestionWithStoryLinks(q.question, storyLookup)}
                            </p>
                            <div className="text-[11px] font-medium text-[var(--rf-text-tertiary)]">
                              Choose the closest framing, then add only the nuance that matters.
                            </div>
                          </div>
                        </div>

                        {suggestions.length > 0 && (
                          <div className="rounded-[20px] border border-[rgba(43,89,74,0.08)] bg-[rgba(246,242,234,0.76)] p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]">
                            <div className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">
                              Proposed answers
                            </div>
                            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                              {suggestions.map((sug, si) => {
                                const sel = ans.selectedSuggestions.includes(sug);
                                return (
                                  <button
                                    key={si}
                                    onClick={() => toggleSuggestion(idx, sug)}
                                    disabled={isSubmitting}
                                    className={`flex min-h-[64px] items-start rounded-[18px] border px-3.5 py-3 text-left text-[12px] font-semibold leading-relaxed transition-all ${
                                      sel
                                        ? 'border-[var(--rf-brand)] bg-[var(--rf-brand-muted)] text-[var(--rf-brand-hover)] shadow-sm'
                                        : 'border-[var(--rf-border)] bg-white/88 text-[var(--rf-text-secondary)] hover:border-[var(--rf-brand-subtle)] hover:text-[var(--rf-brand)]'
                                    }`}
                                  >
                                    <div className="flex w-full items-start gap-2.5">
                                      <div className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${sel ? 'border-[var(--rf-brand)] bg-[var(--rf-brand)] text-white' : 'border-[var(--rf-border-strong)] bg-white text-transparent'}`}>
                                        <Check className="w-3 h-3" />
                                      </div>
                                      <span>{sug}</span>
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        <textarea
                          value={ans.customAnswer}
                          onChange={e => handleCustomChange(idx, e.target.value)}
                          disabled={isSubmitting}
                          placeholder={suggestions.length > 0 ? 'Add nuance, corrections, or anything your chosen answer does not cover…' : 'Type your answer here…'}
                          rows={3}
                          className="w-full bg-[rgba(255,255,255,0.82)] border border-[var(--rf-border)] rounded-2xl px-4 py-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition resize-none placeholder-[var(--rf-text-tertiary)]"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          ))}

          {questions.length > 0 && (
            <motion.div
              className="flex justify-end pt-6"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
            >
              <button
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="brainstorm-shimmer flex items-center gap-2 px-6 py-3 rounded-[18px] text-sm font-bold text-white bg-[linear-gradient(135deg,#1e4035,#2b594a,#3a7062)] hover:brightness-[1.04] transition shadow-lg shadow-[var(--rf-brand)]/20 active:scale-[0.98]"
              >
                {isSubmitting ? 'Checking sufficiency…' : (submitLabel ?? (round === 2 ? 'Generate Features' : 'Continue Discovery'))}
                <ArrowRight className="w-4 h-4" />
              </button>
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}
