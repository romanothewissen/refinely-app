import React, { useState } from 'react';
import { ArrowRight, Check, Menu, Sparkles, AlertCircle, FileText, ExternalLink, X } from 'lucide-react';
import { motion } from 'framer-motion';

interface Question { category: string; question: string; suggestions: string[]; }
interface Answer   { question: string; answer: string; }

interface ClarifyProps {
  questions: Question[];
  onComplete: (answers: Answer[]) => void;
  onSkip: () => void;
  roundNumber?: number;
  reasoningMode?: 'fast' | 'deep';
  skipLabel?: string;
  coverageSummary?: {
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
  } | null;
  contextMeta?: {
    projectKey: string;
    domainRolesUsed: string[];
    domainContextApplied?: boolean;
    attachmentIncluded?: boolean;
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
    wiDocsCount?: number;
    referencedWiDocs?: Array<{ docId: string; filename: string; chunkCount: number }>;
    tokenUsage?: { input: number; output: number; total: number; byStage?: Record<string, { input: number; output: number; total: number }> };
  } | null;
  sidebarOpen: boolean;
  setSidebarOpen: (o: boolean) => void;
}

const CLARIFY_CATEGORY_ORDER = [
  'Roles & Personas',
  'Trigger & Context',
  'Functional Flow',
  'Business Rules & Exceptions',
  'Success & Measurement',
] as const;

export function ClarifyQuestionsView({
  questions,
  onComplete,
  onSkip,
  roundNumber = 1,
  reasoningMode = 'fast',
  skipLabel = 'Skip questions',
  coverageSummary,
  contextMeta,
  sidebarOpen,
  setSidebarOpen,
}: ClarifyProps) {
  const [answers, setAnswers] = useState<Record<number, { selected: string[]; custom: string }>>({});
  const [isContextModalOpen, setIsContextModalOpen] = useState(false);
  const activeCoverage = coverageSummary ?? contextMeta?.discoveryCoverage ?? null;

  const answeredCount = Object.values(answers).filter(a => a && (a.selected.length > 0 || a.custom.trim())).length;

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
  const orderedQuestions = [...questions].sort((left, right) => {
    const leftOrder = CLARIFY_CATEGORY_ORDER.indexOf(left.category as (typeof CLARIFY_CATEGORY_ORDER)[number]);
    const rightOrder = CLARIFY_CATEGORY_ORDER.indexOf(right.category as (typeof CLARIFY_CATEGORY_ORDER)[number]);
    return (leftOrder === -1 ? CLARIFY_CATEGORY_ORDER.length : leftOrder) - (rightOrder === -1 ? CLARIFY_CATEGORY_ORDER.length : rightOrder);
  });

  orderedQuestions.forEach((q) => {
    const i = questions.findIndex((candidate) => candidate.question === q.question && candidate.category === q.category);
    if (!categories[q.category]) categories[q.category] = [];
    categories[q.category].push({ idx: i, q });
  });

  let displayCounter = 0;

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
              <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-0.5">
                Round {roundNumber} {reasoningMode === 'deep' ? 'of adaptive discovery' : 'of discovery'} • {answeredCount} of {questions.length} questions explored
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 flex-1 max-w-lg hidden md:flex">
          <div className="flex-1 h-2 bg-[var(--rf-surface-soft)] rounded-full overflow-hidden shadow-inner">
            <div
              className="h-full bg-[var(--rf-brand)] rounded-full transition-all duration-500 shadow-[0_0_10px_rgba(59,130,246,0.5)]"
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
            {skipLabel}
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
                    <span className="px-2 py-1 bg-[var(--rf-surface-soft)] rounded-md">Rounds: {contextMeta.discoveryTranscript?.length ?? 0}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setIsContextModalOpen(true)}
                  className="text-xs font-bold text-[var(--rf-brand)] hover:text-[var(--rf-brand-hover)] transition-colors"
                >
                  View full details
                </button>
              </div>
              <div className="mt-3 text-[11px] font-medium text-[var(--rf-text-tertiary)]">
                {reasoningMode === 'deep'
                  ? `Deep mode can continue into additional rounds if critical discovery gaps remain after round ${roundNumber}.`
                  : 'Fast mode keeps discovery lightweight and will generate after this round.'}
              </div>
              {activeCoverage && (
                <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="rounded-md bg-white px-2.5 py-1 text-[11px] font-bold tracking-wide text-amber-900 border border-amber-200">
                      Coverage {activeCoverage.overallScore}%
                    </span>
                    <span className="text-xs font-semibold text-amber-900">
                      {activeCoverage.canGenerate ? 'Enough context to generate now' : 'Another discovery round is recommended'}
                    </span>
                  </div>
                  <div className="mt-2 text-sm text-amber-900/90">{activeCoverage.summary}</div>
                  {activeCoverage.missingCritical.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {activeCoverage.missingCritical.map(item => (
                        <span
                          key={item}
                          className="rounded-md bg-white px-2.5 py-1 text-[11px] font-medium text-amber-900 border border-amber-200"
                        >
                          Missing: {item}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
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
                  displayCounter += 1;
                  const displayNumber = displayCounter;

                  return (
                    <div
                      key={idx}
                      className={`rounded-2xl border bg-white shadow-sm transition-all duration-300 overflow-hidden ${isAnswered ? 'border-[var(--rf-brand-subtle)] shadow-md shadow-blue-500/5' : 'border-[var(--rf-border)] hover:border-[var(--rf-border-strong)] hover:shadow-md'}`}
                    >
                      <div className="p-5 flex items-start gap-4">
                        <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 transition-all text-sm font-bold shadow-inner ${isAnswered ? 'bg-[var(--rf-brand)] text-white' : 'bg-[var(--rf-surface-soft)] text-[var(--rf-text-tertiary)] border border-[var(--rf-border)]'}`}>
                          {isAnswered ? <Check className="w-4 h-4" /> : <span>{displayNumber}</span>}
                        </div>
                        <div className="flex-1 space-y-4">
                          <p className="text-[15px] font-bold text-[var(--rf-text)] leading-snug pt-1">{q.question}</p>

                          {q.suggestions.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                              {q.suggestions.map((sug, si) => {
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
                            placeholder={q.suggestions.length > 0 ? 'Click suggestions above or type your own answer\u2026' : 'Type your detailed answer here\u2026'}
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

      {contextMeta && isContextModalOpen && (
        <ContextDetailsModal contextMeta={contextMeta} onClose={() => setIsContextModalOpen(false)} />
      )}
    </div>
  );
}

function ContextDetailsModal({
  contextMeta,
  onClose,
}: {
  contextMeta: NonNullable<ClarifyProps['contextMeta']>;
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
            <h2 className="text-xl font-bold tracking-tight text-[var(--rf-text)]">Discovery context details</h2>
            <p className="mt-1 text-sm font-medium text-[var(--rf-text-tertiary)]">
              Full context used to prepare clarifying questions, including work instructions and related Jira stories.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-2 text-[var(--rf-text-tertiary)] transition hover:bg-[var(--rf-surface-soft)] hover:text-[var(--rf-text)]"
            aria-label="Close context details"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[calc(88vh-92px)] overflow-y-auto p-6 custom-scrollbar">
          <div className="grid gap-4 md:grid-cols-5">
            <StatCard label="Project" value={contextMeta.projectKey === '*' ? 'Global' : contextMeta.projectKey} />
            <StatCard label="Work instructions" value={`${contextMeta.wiDocsCount ?? 0}`} />
            <StatCard label="Related stories" value={`${contextMeta.similarStoriesCount ?? 0}`} />
            <StatCard label="Roles" value={`${contextMeta.domainRolesUsed?.length ?? 0}`} />
            <StatCard label="Coverage" value={contextMeta.discoveryCoverage ? `${contextMeta.discoveryCoverage.overallScore}%` : 'N/A'} />
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)]/40 p-4">
              <div className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Setup</div>
              <div className="mt-3 space-y-2 text-sm text-[var(--rf-text-secondary)]">
                <div><strong className="text-[var(--rf-text)]">Domain guidance:</strong> {contextMeta.domainContextApplied ? 'Included' : 'Not configured'}</div>
                <div><strong className="text-[var(--rf-text)]">Attachment:</strong> {contextMeta.attachmentIncluded ? 'Included' : 'None'}</div>
                <div><strong className="text-[var(--rf-text)]">Roles:</strong> {contextMeta.domainRolesUsed?.length ? contextMeta.domainRolesUsed.join(', ') : 'None'}</div>
              </div>
            </div>

            <div className="rounded-2xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)]/40 p-4">
              <div className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)] mb-3">Token usage</div>
              {contextMeta.tokenUsage ? (
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-[var(--rf-text-tertiary)]">Input</span>
                    <span className="font-semibold text-[var(--rf-text)]">{contextMeta.tokenUsage.input.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-[var(--rf-text-tertiary)]">Output</span>
                    <span className="font-semibold text-[var(--rf-text)]">{contextMeta.tokenUsage.output.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-xs pt-1 border-t border-[var(--rf-border-subtle)]">
                    <span className="font-semibold text-[var(--rf-text-secondary)]">Total</span>
                    <span className="font-bold text-[var(--rf-text)]">{contextMeta.tokenUsage.total.toLocaleString()}</span>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-[var(--rf-text-tertiary)]">Not available</div>
              )}
            </div>
          </div>

          {contextMeta.discoveryCoverage ? (
            <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
              <div className="text-xs font-bold uppercase tracking-[0.18em] text-amber-900">Discovery coverage</div>
              <div className="mt-3 text-sm text-amber-900/90">{contextMeta.discoveryCoverage.summary}</div>
              {contextMeta.discoveryCoverage.missingCritical.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {contextMeta.discoveryCoverage.missingCritical.map(item => (
                    <span key={item} className="rounded-md bg-white px-2.5 py-1 text-[11px] font-medium text-amber-900 border border-amber-200">
                      Missing: {item}
                    </span>
                  ))}
                </div>
              )}
            </div>
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
                  <EmptyState text="No work instructions were attached to this clarifying pass." />
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
                  <EmptyState text="No related Jira stories were referenced for this clarifying pass." />
                )}
              </div>
            </section>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)]/45 p-4">
      <div className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">{label}</div>
      <div className="mt-2 text-2xl font-bold tracking-tight text-[var(--rf-text)]">{value}</div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-[var(--rf-border)] bg-[var(--rf-surface-soft)]/35 p-4 text-sm text-[var(--rf-text-tertiary)]">
      {text}
    </div>
  );
}
