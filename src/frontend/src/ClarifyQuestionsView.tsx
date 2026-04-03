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
  allowMultiple: boolean;
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
    return answers[idx] ?? { selectedSuggestions: [], customAnswer: '', allowMultiple: false };
  }

  function toggleSuggestion(qIdx: number, sug: string) {
    const existing = ensureAnswer(qIdx);
    const alreadySelected = existing.selectedSuggestions.includes(sug);
    const newSelected = alreadySelected
      ? existing.selectedSuggestions.filter(s => s !== sug)
      : existing.allowMultiple
        ? [...existing.selectedSuggestions, sug]
        : [sug];

    setAnswers(prev => ({ ...prev, [qIdx]: { ...existing, selectedSuggestions: newSelected } }));
  }

  function enableMultiSelect(qIdx: number) {
    setAnswers(prev => ({ ...prev, [qIdx]: { ...ensureAnswer(qIdx), allowMultiple: true } }));
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
    <div className="flex-1 flex flex-col h-full overflow-hidden fade-in bg-transparent">
      {/* Header */}
      <motion.header
        className="shrink-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.6),rgba(255,255,255,0.3))] backdrop-blur-xl px-6 py-4 z-20 sticky top-0 shadow-[0_1px_0_rgba(43,89,74,0.08)] flex items-center justify-between gap-4"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="flex items-center gap-3">
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
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[var(--rf-brand-muted)] flex items-center justify-center border border-[rgba(43,89,74,0.12)] shadow-sm">
              <Sparkles className="w-5 h-5 text-[var(--rf-brand)]" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-[var(--rf-text)] tracking-tight">Requirement Discovery</h1>
              <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-0.5">
                Round {round} of 2 · {answeredCount} of {questions.length} questions explored
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 flex-1 max-w-lg hidden md:flex">
          <div className="flex-1 h-2 bg-[var(--rf-surface-soft)] rounded-full overflow-hidden shadow-inner">
            <div
              className="h-full bg-[var(--rf-brand)] rounded-full transition-all duration-500 shadow-[0_0_10px_rgba(43,89,74,0.35)]"
              style={{ width: `${(answeredCount / Math.max(questions.length, 1)) * 100}%` }}
            />
          </div>
          <span className="text-xs font-bold text-[var(--rf-text-tertiary)] shrink-0">{answeredCount}/{questions.length}</span>
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
      </motion.header>

      {/* All questions */}
      <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
        <div className="max-w-3xl mx-auto space-y-8 pb-12">
          {contextMeta && (
            <motion.div
              className="rf-card p-5"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-sm">
                <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                  <div className="font-bold text-[var(--rf-text)] flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-[var(--rf-brand)]" />
                    Discovery Context
                  </div>
                  <div className="flex items-center gap-3 text-[var(--rf-text-tertiary)] text-xs font-medium">
                    <span className="px-2 py-1 bg-[var(--rf-surface-soft)] rounded-md">Project: {contextMeta.projectKey === '*' ? 'Global' : contextMeta.projectKey}</span>
                    <span className="px-2 py-1 bg-[var(--rf-surface-soft)] rounded-md">Docs: {contextMeta.wiDocsCount ?? 0}</span>
                    <span className="px-2 py-1 bg-[var(--rf-surface-soft)] rounded-md">Refs: {contextMeta.similarStoriesCount ?? 0}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowContextDetails(v => !v)}
                  className="text-xs font-bold text-[var(--rf-brand)] hover:text-[var(--rf-brand-hover)] transition-colors"
                >
                  {showContextDetails ? 'Hide details' : 'Show details'}
                </button>
              </div>

              {showContextDetails && (
                <motion.div
                  className="mt-4 pt-4 border-t border-[var(--rf-border)]/60 space-y-2 text-xs"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                >
                  {contextMeta.ambiguityAssessment?.reasons?.length ? (
                    <div className="text-[var(--rf-text-secondary)] bg-[var(--rf-brand-muted)]/50 p-3 rounded-xl border border-[rgba(43,89,74,0.12)] leading-relaxed">
                      <strong className="text-[var(--rf-brand-hover)] mb-1 block">Analysis:</strong>
                      {contextMeta.ambiguityAssessment.reasons.join(' ')}
                    </div>
                  ) : null}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[var(--rf-text-secondary)] mt-2">
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
                      <div className="space-y-2">
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
                      <div className="space-y-2">
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
              className="space-y-4"
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

              <div className="space-y-4">
                {items.map(({ idx, q }) => {
                  const ans = ensureAnswer(idx);
                  const isAnswered = ans.customAnswer.trim().length > 0 || ans.selectedSuggestions.length > 0;
                  const suggestions = q.suggestions.slice(0, 4);
                  const canEnableMultiSelect = suggestions.length > 1 && ans.selectedSuggestions.length > 0 && !ans.allowMultiple;

                  return (
                    <div
                      key={idx}
                      className={`rounded-2xl border bg-white shadow-sm transition-all duration-300 overflow-hidden ${isAnswered ? 'border-[var(--rf-brand-subtle)] shadow-md shadow-[var(--rf-brand)]/5' : 'border-[var(--rf-border)] hover:border-[var(--rf-border-strong)] hover:shadow-md'}`}
                    >
                      <div className="p-5 flex items-start gap-4">
                        <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 transition-all text-sm font-bold shadow-inner ${isAnswered ? 'bg-[var(--rf-brand)] text-white' : 'bg-[var(--rf-surface-soft)] text-[var(--rf-text-tertiary)] border border-[var(--rf-border)]'}`}>
                          {isAnswered ? <Check className="w-4 h-4" /> : <span>{idx + 1}</span>}
                        </div>
                        <div className="flex-1 space-y-4">
                          <p className="text-[15px] font-bold text-[var(--rf-text)] leading-snug pt-1">
                            {renderQuestionWithStoryLinks(q.question, storyLookup)}
                          </p>

                          {suggestions.length > 0 && (
                            <div className="space-y-2">
                              <div className="text-[11px] font-medium text-[var(--rf-text-tertiary)]">
                                Choose one answer that is closest. Add another only if none of them fully covers it.
                              </div>
                              {canEnableMultiSelect && (
                                <button
                                  type="button"
                                  onClick={() => enableMultiSelect(idx)}
                                  disabled={isSubmitting}
                                  className="inline-flex items-center rounded-lg border border-[var(--rf-border)] bg-white px-2.5 py-1 text-[11px] font-semibold text-[var(--rf-text-secondary)] transition hover:border-[var(--rf-brand-subtle)] hover:text-[var(--rf-brand)]"
                                >
                                  Add another answer if needed
                                </button>
                              )}
                              {ans.allowMultiple && (
                                <div className="text-[11px] font-medium text-[var(--rf-text-tertiary)]">
                                  Multiple answers are on. Keep only the answers that truly need to be combined.
                                </div>
                              )}
                              <div className="flex flex-wrap gap-2">
                              {suggestions.map((sug, si) => {
                                const sel = ans.selectedSuggestions.includes(sug);
                                return (
                                  <button
                                    key={si}
                                    onClick={() => toggleSuggestion(idx, sug)}
                                    disabled={isSubmitting}
                                    className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all ${
                                      sel
                                        ? 'bg-[var(--rf-brand-muted)] text-[var(--rf-brand-hover)] border-[var(--rf-brand-subtle)] shadow-sm'
                                        : 'border-[var(--rf-border)] text-[var(--rf-text-secondary)] hover:border-[var(--rf-brand-subtle)] hover:text-[var(--rf-brand)] bg-white hover:bg-[var(--rf-surface-soft)]'
                                    }`}
                                  >
                                    <div className="flex items-center gap-1.5">
                                      {sel && <Check className="w-3.5 h-3.5" />}
                                      {sug}
                                    </div>
                                  </button>
                                );
                              })}
                              </div>
                            </div>
                          )}

                          {ans.selectedSuggestions.length > 0 && (
                            <div className="rounded-xl border border-[var(--rf-brand-subtle)] bg-[var(--rf-brand-muted)]/60 px-4 py-3">
                              <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-brand-hover)]">
                                {ans.selectedSuggestions.length === 1 ? 'Chosen answer' : 'Chosen answers'}
                              </div>
                              <div className="mt-2 flex flex-wrap gap-2">
                                {ans.selectedSuggestions.map((suggestion) => (
                                  <span
                                    key={suggestion}
                                    className="inline-flex items-center gap-1 rounded-full border border-[var(--rf-brand-subtle)] bg-white px-2.5 py-1 text-[11px] font-semibold text-[var(--rf-brand-hover)]"
                                  >
                                    <Check className="w-3 h-3" />
                                    {suggestion}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          <textarea
                            value={ans.customAnswer}
                            onChange={e => handleCustomChange(idx, e.target.value)}
                            disabled={isSubmitting}
                            placeholder={suggestions.length > 0 ? 'Add nuance, corrections, or anything your chosen answer does not cover…' : 'Type your answer here…'}
                            rows={3}
                            className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition resize-none placeholder-[var(--rf-text-tertiary)]"
                          />
                        </div>
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
