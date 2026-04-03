import React, { useState } from 'react';
import { ArrowRight, Check, Menu, Sparkles, AlertCircle, ExternalLink } from 'lucide-react';
import { motion } from 'framer-motion';
import { router } from '@forge/bridge';

interface Question { category: string; question: string; suggestions: string[]; }
interface Answer   { question: string; answer: string; }

interface ClarifyProps {
  questions: Question[];
  onComplete: (answers: Answer[]) => void;
  onSkip: () => void;
  contextMeta?: {
    projectKey: string;
    domainRolesUsed: string[];
    domainContextApplied?: boolean;
    attachmentIncluded?: boolean;
    similarStoriesCount?: number;
    referencedSimilarStories?: Array<{ key: string; summary: string; relevanceScore?: number; url?: string; jiraIssueUrl?: string }>;
    ambiguityAssessment?: {
      level: 'clear' | 'medium' | 'vague';
      score: number;
      reasons: string[];
      questionPlan: { min: number; max: number; target: number };
      generatedQuestions: number;
    };
    wiDocsCount?: number;
    referencedWiDocs?: Array<{ docId: string; filename: string; chunkCount: number }>;
    referencedWiSections?: Array<{ docId: string; filename: string; chunkIndex: number; excerpt: string }>;
    tokenUsage?: { input: number; output: number; total: number; byStage?: Record<string, { input: number; output: number; total: number }> };
  } | null;
  sidebarOpen: boolean;
  setSidebarOpen: (o: boolean) => void;
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

export function ClarifyQuestionsView({ questions, onComplete, onSkip, contextMeta, sidebarOpen, setSidebarOpen }: ClarifyProps) {
  const [answers, setAnswers] = useState<Record<number, { selected: string[]; custom: string }>>({});
  const [showContextDetails, setShowContextDetails] = useState(false);

  const answeredCount = Object.values(answers).filter(a => a && (a.selected.length > 0 || a.custom.trim())).length;
  const storyLookup = new Map(
    (contextMeta?.referencedSimilarStories ?? [])
      .map(story => [story.key, resolveStoryUrl(story)] as const)
      .filter(([key, url]) => Boolean(key && url)),
  );

  function ensureAnswer(idx: number) {
    return answers[idx] ?? { selected: [], custom: '' };
  }

  function toggleSuggestion(qIdx: number, sug: string) {
    const existing = ensureAnswer(qIdx);
    const alreadySelected = existing.selected.includes(sug);
    const newSelected = alreadySelected
      ? existing.selected.filter(s => s !== sug)
      : [...existing.selected, sug];

    const newCustom = newSelected.join('; ');
    setAnswers(prev => ({ ...prev, [qIdx]: { selected: newSelected, custom: newCustom } }));
  }

  function handleCustomChange(qIdx: number, val: string) {
    setAnswers(prev => ({ ...prev, [qIdx]: { ...ensureAnswer(qIdx), custom: val } }));
  }

  function handleSubmit() {
    const result: Answer[] = questions.map((q, i) => {
      const a = ensureAnswer(i);
      const combined = a.custom.trim() || a.selected.join('; ');
      return { question: q.question, answer: combined };
    }).filter(a => a.answer);
    console.log('[ClarifyQuestionsView] handleSubmit called, answers:', result.length);
    onComplete(result);
  }

  const categories: Record<string, { idx: number; q: Question }[]> = {};
  questions.forEach((q, i) => {
    if (!categories[q.category]) categories[q.category] = [];
    categories[q.category].push({ idx: i, q });
  });

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden fade-in bg-transparent">
      {/* Header */}
      <motion.header
        className="shrink-0 bg-white/80 backdrop-blur-md px-6 py-4 z-20 sticky top-0 border-b border-[var(--rf-border)] shadow-sm flex items-center justify-between gap-4"
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
            <div className="w-10 h-10 rounded-xl bg-[var(--rf-brand-muted)] flex items-center justify-center border border-blue-100 shadow-sm">
              <Sparkles className="w-5 h-5 text-[var(--rf-brand)]" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-[var(--rf-text)] tracking-tight">Requirement Discovery</h1>
              <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-0.5">{answeredCount} of {questions.length} questions explored</p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 flex-1 max-w-lg hidden md:flex">
          <div className="flex-1 h-2 bg-[var(--rf-surface-soft)] rounded-full overflow-hidden shadow-inner">
            <div
              className="h-full bg-[var(--rf-brand-muted)]0 rounded-full transition-all duration-500 shadow-[0_0_10px_rgba(59,130,246,0.5)]"
              style={{ width: `${(answeredCount / Math.max(questions.length, 1)) * 100}%` }}
            />
          </div>
          <span className="text-xs font-bold text-[var(--rf-text-tertiary)] shrink-0">{answeredCount}/{questions.length}</span>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <motion.button
            onClick={onSkip}
            className="text-xs font-bold text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text-secondary)] transition px-3 py-2 rounded-lg hover:bg-[var(--rf-surface-soft)]"
            whileTap={{ scale: 0.97 }}
          >
            Skip all
          </motion.button>
          <motion.button
            onClick={handleSubmit}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-white bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] transition shadow-sm shadow-[var(--rf-brand)]/20"
            whileTap={{ scale: 0.98 }}
          >
            Generate Features <ArrowRight className="w-4 h-4" />
          </motion.button>
        </div>
      </motion.header>

      {/* All questions */}
      <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
        <div className="max-w-3xl mx-auto space-y-8 pb-12">
          {contextMeta && (
            <motion.div
              className="rounded-2xl border border-[var(--rf-border)] bg-white/60 backdrop-blur-md p-5 shadow-sm"
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
                    <div className="text-[var(--rf-text-secondary)] bg-[var(--rf-brand-muted)]/50 p-3 rounded-xl border border-blue-100 leading-relaxed">
                      <strong className="text-blue-900 mb-1 block">Analysis:</strong>
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
                          <div key={`${story.key}-${i}`} className="rounded-xl border border-[var(--rf-border)] bg-white p-3 shadow-sm">
                            <div className="flex items-start justify-between gap-3">
                              {resolveStoryUrl(story) ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    const url = resolveStoryUrl(story);
                                    if (url) void router.navigate(url);
                                  }}
                                  className="inline-flex items-center gap-1.5 text-left text-xs font-bold text-[var(--rf-brand-hover)] hover:text-blue-900 transition"
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
                          <div key={`${section.docId}-${section.chunkIndex}-${i}`} className="rounded-xl border border-[var(--rf-border)] bg-white p-3 shadow-sm">
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

          {Object.entries(categories).map(([category, items], idx) => (
            <motion.div
              key={category}
              className="space-y-4"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.1, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="flex items-center gap-4">
                <span className="inline-flex items-center rounded-lg px-3 py-1 text-[11px] font-bold uppercase tracking-widest bg-[var(--rf-text)] text-white shadow-sm">
                  {category}
                </span>
                <div className="flex-1 h-px bg-slate-200" />
              </div>

              <div className="space-y-4">
                {items.map(({ idx, q }) => {
                  const ans = ensureAnswer(idx);
                  const isAnswered = ans.custom.trim().length > 0 || ans.selected.length > 0;
                  const suggestions = q.suggestions.slice(0, 4);

                  return (
                    <div
                      key={idx}
                      className={`rounded-2xl border bg-white shadow-sm transition-all duration-300 overflow-hidden ${isAnswered ? 'border-[var(--rf-brand-subtle)] shadow-md shadow-blue-500/5' : 'border-[var(--rf-border)] hover:border-[var(--rf-border-strong)] hover:shadow-md'}`}
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
                            <div className="flex flex-wrap gap-2">
                              {suggestions.map((sug, si) => {
                                const sel = ans.selected.includes(sug);
                                return (
                                  <button
                                    key={si}
                                    onClick={() => toggleSuggestion(idx, sug)}
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
                          )}

                          <textarea
                            value={ans.custom}
                            onChange={e => handleCustomChange(idx, e.target.value)}
                            placeholder={suggestions.length > 0 ? 'Click a suggestion or type your own answer\u2026' : 'Type your detailed answer here\u2026'}
                            rows={3}
                            className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition resize-none placeholder-slate-400"
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          ))}

          <motion.div
            className="flex justify-end pt-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
          >
            <button
              onClick={handleSubmit}
              className="flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-bold text-white bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] transition shadow-lg shadow-[var(--rf-brand)]/20 active:scale-[0.98]"
            >
              Generate Features <ArrowRight className="w-4 h-4" />
            </button>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
