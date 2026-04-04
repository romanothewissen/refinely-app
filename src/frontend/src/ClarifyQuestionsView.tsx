import React, { useEffect, useState } from 'react';
import { ArrowRight, Check, Menu, AlertCircle, ExternalLink } from 'lucide-react';
import { motion } from 'framer-motion';
import { router } from '@forge/bridge';
import type { ClarifyAnswer, ClarifyCategoryKey, ClarifyContextMeta, ClarifyFailureReasonCode, ClarifyQuestion } from './types';

const CLARIFY_COMPLEXITY_LEVELS = [
  { key: 'trivial', label: 'Trivial' },
  { key: 'low', label: 'Low' },
  { key: 'medium', label: 'Medium' },
  { key: 'high', label: 'High' },
  { key: 'very_high', label: 'Complex' },
];

// DiscoveryProfile uses a 4-level complexity scale; map to 5-level for the bar
const DISCOVERY_COMPLEXITY_MAP: Record<string, number> = {
  low: 1, medium: 2, high: 3, very_high: 4,
};

const AMBIGUITY_LABELS: Record<string, string> = {
  low: 'Low ambiguity', medium: 'Moderate ambiguity', high: 'High ambiguity',
};

const SCOPE_LABELS: Record<string, string> = {
  narrow: 'Narrow scope', moderate: 'Moderate scope', broad: 'Broad scope', very_broad: 'Very broad scope',
};

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
        <div className="flex h-full w-full min-w-0 items-center justify-between gap-3">
          <div className="rf-pane-header-cluster">
            {!sidebarOpen && (
              <motion.button
                onClick={() => setSidebarOpen(true)}
                className="p-1.5 -ml-1 rounded-lg hover:bg-[var(--rf-surface-soft)] text-[var(--rf-text-secondary)] transition-colors shrink-0"
                title="Open Sidebar"
                whileTap={{ scale: 0.95 }}
              >
                <Menu className="w-4 h-4" />
              </motion.button>
            )}
            <div className="rf-pane-header-copy">
              <h1 className="rf-pane-header-title">Requirement Discovery</h1>
              <p className="rf-pane-header-subtitle" style={{ color: 'var(--rf-text-tertiary)' }}>
                Round {round} of 2 · <span style={{ color: 'var(--rf-brand)', fontWeight: 600 }}>{answeredCount}</span>/{questions.length} answered
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {isBlocked && (
              <motion.button
                onClick={onRetry}
                disabled={isSubmitting || !onRetry}
                className="brainstorm-shimmer flex items-center gap-1.5 px-4 py-2 rounded-[14px] text-sm font-bold text-white bg-[linear-gradient(135deg,#1e4035,#2b594a,#3a7062)] hover:brightness-[1.04] transition shadow-sm disabled:opacity-60"
                whileTap={{ scale: 0.98 }}
              >
                Retry
                <ArrowRight className="w-3.5 h-3.5" />
              </motion.button>
            )}
            <motion.button
              onClick={onSkip}
              disabled={isSubmitting}
              className="text-xs font-medium text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text-secondary)] transition px-3 py-1.5 rounded-lg hover:bg-[var(--rf-surface-soft)]"
              whileTap={{ scale: 0.97 }}
            >
              {skipLabel ?? (round === 2 ? 'Skip' : 'Skip all')}
            </motion.button>
          </div>
        </div>
      </motion.header>

      <div className="flex-1 overflow-y-auto custom-scrollbar px-5 py-4">
        <div className="mx-auto w-full max-w-[860px] space-y-4 pb-8">
          {contextMeta && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            >
              {/* Slim context status strip */}
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--rf-border)] bg-white/80 px-4 py-2.5">
                <AlertCircle className="w-3.5 h-3.5 text-[var(--rf-brand)] shrink-0" />
                <span className="text-[13px] text-[var(--rf-text-secondary)] flex-1 min-w-0">
                  Discovery is grounding the requirement
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="inline-flex items-center gap-1 rounded-md border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-2 py-0.5 text-[13px] font-semibold text-[var(--rf-text-secondary)]">
                    {contextMeta.projectKey === '*' ? 'Global' : contextMeta.projectKey}
                  </span>
                  {(contextMeta.wiDocsCount ?? 0) > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-md border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-2 py-0.5 text-[13px] font-semibold text-[var(--rf-text-secondary)]">
                      {contextMeta.wiDocsCount} docs
                    </span>
                  )}
                  {(contextMeta.similarStoriesCount ?? 0) > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-md border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-2 py-0.5 text-[13px] font-semibold text-[var(--rf-text-secondary)]">
                      {contextMeta.similarStoriesCount} refs
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowContextDetails(v => !v)}
                    className="text-[13px] font-semibold text-[var(--rf-brand)] hover:text-[var(--rf-brand-hover)] transition-colors ml-1"
                  >
                    {showContextDetails ? 'Hide' : 'Details'}
                  </button>
                </div>
              </div>

              {/* LLM scoring panel */}
              {questions.length > 0 && (() => {
                const profile = contextMeta?.discoveryProfile;
                const qPlan = contextMeta?.ambiguityAssessment?.questionPlan;
                const complexityKey = profile?.complexity;
                const ci = complexityKey ? (DISCOVERY_COMPLEXITY_MAP[complexityKey] ?? 2) : 2;

                return (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2 }}
                    className="mt-2 rounded-xl border border-[var(--rf-border)] bg-white/70 px-4 py-3"
                  >
                    <div className="flex items-center justify-between mb-2.5">
                      <span className="text-[12px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Complexity</span>
                      {complexityKey && (
                        <span className="text-[12px] font-bold text-[var(--rf-brand)] uppercase tracking-wide">
                          {CLARIFY_COMPLEXITY_LEVELS[ci]?.label ?? complexityKey}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-1">
                      {CLARIFY_COMPLEXITY_LEVELS.map((l, idx) => (
                        <div key={l.key} className="flex-1 flex flex-col gap-1">
                          <div className={`h-1.5 rounded-sm transition-colors duration-500 ${
                            idx === ci ? 'bg-[var(--rf-brand)]'
                            : idx < ci ? 'bg-[var(--rf-brand-subtle)]'
                            : 'bg-[var(--rf-border)]'
                          }`} />
                          <span className={`text-[10px] font-bold uppercase tracking-tight text-center ${
                            idx === ci ? 'text-[var(--rf-brand)]' : 'text-[var(--rf-text-tertiary)] opacity-40'
                          }`}>{l.label}</span>
                        </div>
                      ))}
                    </div>

                    {(profile || qPlan) && (
                      <div className="mt-3 pt-2.5 border-t border-[rgba(0,0,0,0.05)] grid grid-cols-3 gap-x-3 gap-y-2">
                        {profile?.scope && (
                          <div>
                            <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-0.5">Scope</div>
                            <div className="text-[12px] font-bold text-[var(--rf-text)]">{SCOPE_LABELS[profile.scope] ?? profile.scope}</div>
                          </div>
                        )}
                        {profile?.ambiguity && (
                          <div>
                            <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-0.5">Ambiguity</div>
                            <div className="text-[12px] font-bold text-[var(--rf-text)]">{AMBIGUITY_LABELS[profile.ambiguity] ?? profile.ambiguity}</div>
                          </div>
                        )}
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-0.5">Questions</div>
                          <div className="text-[12px] font-bold text-[var(--rf-text)]">{questions.length}{qPlan?.target && qPlan.target !== questions.length ? <span className="text-[var(--rf-text-tertiary)] font-normal"> of ~{qPlan.target}</span> : ''}</div>
                        </div>
                      </div>
                    )}
                  </motion.div>
                );
              })()}

              {/* Expandable details */}
              {showContextDetails && (
                <motion.div
                  className="mt-2 rounded-xl border border-[var(--rf-border)] bg-white/80 px-4 py-3 space-y-3 text-xs"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                >
                  {contextMeta.ambiguityAssessment?.reasons?.length ? (
                    <div className="text-[var(--rf-text-secondary)] leading-relaxed">
                      <span className="font-semibold text-[var(--rf-brand-hover)]">Analysis: </span>
                      {contextMeta.ambiguityAssessment.reasons.join(' ')}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-[var(--rf-text-tertiary)]">
                    <span>Domain: <span className="text-[var(--rf-text-secondary)] font-medium">{contextMeta.domainContextApplied ? 'Included' : 'Not configured'}</span></span>
                    <span>Attachment: <span className="text-[var(--rf-text-secondary)] font-medium">{contextMeta.attachmentIncluded ? 'Included' : 'None'}</span></span>
                    {contextMeta.domainRolesUsed?.length > 0 && (
                      <span>Roles: <span className="text-[var(--rf-text-secondary)] font-medium">{contextMeta.domainRolesUsed.join(', ')}</span></span>
                    )}
                  </div>
                  {(contextMeta.referencedSimilarStories?.length ?? 0) > 0 && (
                    <div>
                      <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-1.5">Similar stories</div>
                      <div className="grid gap-2 xl:grid-cols-2">
                        {contextMeta.referencedSimilarStories!.map((story, i) => (
                          <div key={`${story.key}-${i}`} className="rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-2">
                            <div className="flex items-center justify-between gap-2">
                              {resolveStoryUrl(story) ? (
                                <button
                                  type="button"
                                  onClick={() => { const url = resolveStoryUrl(story); if (url) void router.navigate(url); }}
                                  className="inline-flex items-center gap-1 text-xs font-bold text-[var(--rf-brand-hover)] hover:text-[var(--rf-brand)] transition"
                                >
                                  {story.key} <ExternalLink className="w-2.5 h-2.5" />
                                </button>
                              ) : (
                                <div className="text-xs font-bold text-[var(--rf-text)]">{story.key}</div>
                              )}
                              {typeof story.relevanceScore === 'number' && (
                                <span className="text-[13px] text-[var(--rf-text-tertiary)]">{(story.relevanceScore * 100).toFixed(0)}%</span>
                              )}
                            </div>
                            <div className="mt-1 text-[13px] text-[var(--rf-text-secondary)] leading-relaxed">
                              {buildExcerpt(story.summary, 140)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {(contextMeta.referencedWiSections?.length ?? 0) > 0 && (
                    <div>
                      <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-1.5">
                        WI sections · {contextMeta.referencedWiDocs?.length ?? 0} docs
                      </div>
                      <div className="grid gap-2 xl:grid-cols-2">
                        {contextMeta.referencedWiSections!.map((section, i) => (
                          <div key={`${section.docId}-${section.chunkIndex}-${i}`} className="rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-2">
                            <div className="text-[13px] font-semibold text-[var(--rf-text)] truncate">{section.filename} <span className="font-normal text-[var(--rf-text-tertiary)]">§{section.chunkIndex + 1}</span></div>
                            <div className="mt-1 text-[13px] text-[var(--rf-text-secondary)] leading-relaxed">{section.excerpt}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {contextMeta.tokenUsage && (
                    <div className="text-[13px] text-[var(--rf-text-tertiary)] pt-1 border-t border-[var(--rf-border-subtle)]">
                      {contextMeta.tokenUsage.total.toLocaleString()} tokens ({contextMeta.tokenUsage.input.toLocaleString()} in / {contextMeta.tokenUsage.output.toLocaleString()} out)
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
              className="space-y-2"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.08, duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center rounded-md px-2.5 py-0.5 text-[13px] font-bold uppercase tracking-widest bg-[var(--rf-text)] text-white">
                  {label}
                </span>
                <div className="flex-1 h-px bg-[var(--rf-border)]" />
              </div>

              <div className="grid gap-2">
                {items.map(({ idx, q }) => {
                  const ans = ensureAnswer(idx);
                  const isAnswered = ans.customAnswer.trim().length > 0 || ans.selectedSuggestions.length > 0;
                  const suggestions = q.suggestions.slice(0, 4);

                  return (
                    <div
                      key={idx}
                      className={`overflow-hidden rounded-[18px] border transition-all duration-200 ${
                        isAnswered
                          ? 'border-[var(--rf-brand-subtle)] bg-white shadow-sm shadow-[var(--rf-brand)]/4'
                          : 'border-[var(--rf-border)] bg-white hover:border-[var(--rf-border-strong)]'
                      }`}
                    >
                      <div className="space-y-2.5 p-3">
                        <div className="flex items-start gap-2.5">
                          <div className={`flex h-6 w-6 rounded-lg items-center justify-center shrink-0 transition-all text-xs font-bold ${isAnswered ? 'bg-[var(--rf-brand)] text-white' : 'bg-[var(--rf-surface-soft)] text-[var(--rf-text-tertiary)] border border-[var(--rf-border)]'}`}>
                            {isAnswered ? <Check className="w-3 h-3" /> : <span>{idx + 1}</span>}
                          </div>
                          <p className="text-[14px] font-semibold text-[var(--rf-text)] leading-snug pt-0.5">
                            {renderQuestionWithStoryLinks(q.question, storyLookup)}
                          </p>
                        </div>

                        {suggestions.length > 0 && (
                          <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-4">
                            {suggestions.map((sug, si) => {
                              const sel = ans.selectedSuggestions.includes(sug);
                              return (
                                <button
                                  key={si}
                                  onClick={() => toggleSuggestion(idx, sug)}
                                  disabled={isSubmitting}
                                  className={`flex items-start rounded-[12px] border px-3 py-2 text-left text-[13px] font-medium leading-relaxed transition-all ${
                                    sel
                                      ? 'border-[var(--rf-brand)] bg-[var(--rf-brand-muted)] text-[var(--rf-brand-hover)]'
                                      : 'border-[var(--rf-border)] bg-[var(--rf-surface-soft)] text-[var(--rf-text-secondary)] hover:border-[var(--rf-brand-subtle)] hover:text-[var(--rf-brand)]'
                                  }`}
                                >
                                  <div className="flex w-full items-start gap-2">
                                    <div className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${sel ? 'border-[var(--rf-brand)] bg-[var(--rf-brand)] text-white' : 'border-[var(--rf-border-strong)] bg-white text-transparent'}`}>
                                      <Check className="w-2.5 h-2.5" />
                                    </div>
                                    <span>{sug}</span>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        )}

                        <textarea
                          value={ans.customAnswer}
                          onChange={e => handleCustomChange(idx, e.target.value)}
                          disabled={isSubmitting}
                          placeholder={suggestions.length > 0 ? 'Add nuance, or anything your chosen answer does not cover…' : 'Type your answer here…'}
                          rows={2}
                          className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--rf-brand)]/15 focus:border-[var(--rf-brand)] transition resize-none placeholder-[var(--rf-text-tertiary)]"
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
              className="flex justify-end pt-4"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
            >
              <button
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="brainstorm-shimmer flex items-center gap-1.5 px-5 py-2.5 rounded-[14px] text-sm font-bold text-white bg-[linear-gradient(135deg,#1e4035,#2b594a,#3a7062)] hover:brightness-[1.04] transition shadow-sm active:scale-[0.98]"
              >
                {isSubmitting ? 'Checking…' : (submitLabel ?? (round === 2 ? 'Generate Features' : 'Continue Discovery'))}
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}
