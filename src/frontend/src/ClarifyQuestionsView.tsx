import React, { useState } from 'react';
import { ArrowRight, Check, Menu, Sparkles } from 'lucide-react';

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
    wiDocsCount?: number;
    referencedWiDocs?: Array<{ docId: string; filename: string; chunkCount: number }>;
    usesGoldenExamples: false;
    usesSimilarStories: false;
  } | null;
  sidebarOpen: boolean;
  setSidebarOpen: (o: boolean) => void;
}

export function ClarifyQuestionsView({ questions, onComplete, onSkip, contextMeta, sidebarOpen, setSidebarOpen }: ClarifyProps) {
  const [answers, setAnswers] = useState<Record<number, { selected: string[]; custom: string }>>({});

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
  questions.forEach((q, i) => {
    if (!categories[q.category]) categories[q.category] = [];
    categories[q.category].push({ idx: i, q });
  });

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden fade-in bg-[var(--rf-bg)]">
      {/* Header */}
      <header className="shrink-0 border-b border-[var(--rf-border)] bg-white flex items-center justify-between px-6 py-4 gap-4 sticky top-0 z-20">
        <div className="flex items-center gap-3">
          {!sidebarOpen && (
            <button onClick={() => setSidebarOpen(true)} className="p-2 rounded-md hover:bg-[var(--rf-bg)] text-[var(--rf-text-secondary)] transition border border-[var(--rf-border)]" title="Open Sidebar">
              <Menu className="w-4 h-4" />
            </button>
          )}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-[var(--rf-brand-subtle)] flex items-center justify-center">
              <Sparkles className="w-4.5 h-4.5 text-[var(--rf-brand)]" />
            </div>
            <div>
              <h1 className="text-sm font-semibold text-[var(--rf-text)]">Requirement Discovery</h1>
              <p className="text-[11px] text-[var(--rf-text-tertiary)] mt-0.5">{answeredCount} of {questions.length} questions explored</p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 flex-1 max-w-lg">
          <div className="flex-1 h-1.5 bg-[var(--rf-border-subtle)] rounded-full overflow-hidden">
            <div
              className="h-full bg-[var(--rf-brand)] rounded-full transition-all duration-500"
              style={{ width: `${(answeredCount / Math.max(questions.length, 1)) * 100}%` }}
            />
          </div>
          <span className="text-[11px] font-medium text-[var(--rf-text-tertiary)] shrink-0">{answeredCount}/{questions.length}</span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button onClick={onSkip} className="text-xs font-medium text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text-secondary)] transition px-3 py-1.5 rounded-md hover:bg-[var(--rf-bg)]">
            Skip all
          </button>
          <button
            onClick={handleSubmit}
            className="flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-semibold text-white bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] transition active:scale-[0.98]"
          >
            Generate Features <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* All questions */}
      <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-6">
        <div className="max-w-4xl mx-auto space-y-6">
          {contextMeta && (
            <div className="rounded-lg border border-[var(--rf-border)] bg-white p-4 shadow-[var(--rf-shadow-sm)]">
              <div className="flex flex-wrap items-center gap-4 text-xs">
                <div className="font-semibold text-[var(--rf-text)]">Context used for clarifying questions</div>
                <div className="text-[var(--rf-text-secondary)]">
                  Project: {contextMeta.projectKey === '*' ? 'Standalone workspace' : contextMeta.projectKey}
                </div>
                <div className="text-[var(--rf-text-secondary)]">
                  Domain guidance: {contextMeta.domainContextApplied ? 'Included' : 'Not configured'}
                </div>
                <div className="text-[var(--rf-text-secondary)]">
                  Attachment: {contextMeta.attachmentIncluded ? 'Included' : 'None'}
                </div>
                <div className="text-[var(--rf-text-secondary)]">
                  Golden examples: Not used in clarify
                </div>
                <div className="text-[var(--rf-text-secondary)]">
                  Similar stories: Not used in clarify
                </div>
              </div>
              {contextMeta.domainRolesUsed?.length > 0 && (
                <div className="mt-2 text-xs text-[var(--rf-text-secondary)]">
                  Roles: {contextMeta.domainRolesUsed.join(', ')}
                </div>
              )}
              <div className="mt-3 pt-3 border-t border-[var(--rf-border-subtle)]">
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <div className="font-semibold text-[var(--rf-text)]">
                    Work instructions used: {contextMeta.wiDocsCount ?? 0}
                  </div>
                  {contextMeta.referencedWiDocs?.length ? (
                    <div className="text-[var(--rf-text-secondary)]">
                      {contextMeta.referencedWiDocs.map(doc => doc.filename).join(', ')}
                    </div>
                  ) : (
                    <div className="text-[var(--rf-text-tertiary)]">No project docs were matched for clarifying questions.</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {Object.entries(categories).map(([category, items]) => (
            <div key={category} className="space-y-3">
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)] border border-blue-200">{category}</span>
                <div className="flex-1 h-px bg-[var(--rf-border-subtle)]" />
              </div>

              <div className="space-y-3">
                {items.map(({ idx, q }) => {
                  const ans = ensureAnswer(idx);
                  const isAnswered = ans.custom.trim().length > 0 || ans.selected.length > 0;

                  return (
                    <div
                      key={idx}
                      className={`rounded-lg border bg-white shadow-[var(--rf-shadow-sm)] transition-all duration-200 overflow-hidden ${isAnswered ? 'border-blue-300' : 'border-[var(--rf-border)]'}`}
                    >
                      <div className="px-4 pt-3.5 pb-2.5 flex items-start gap-3">
                        <div className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-0.5 transition-all text-xs font-semibold ${isAnswered ? 'bg-[var(--rf-brand)] text-white' : 'bg-[var(--rf-bg)] text-[var(--rf-text-tertiary)] border border-[var(--rf-border)]'}`}>
                          {isAnswered ? <Check className="w-3.5 h-3.5" /> : <span className="text-[10px]">{idx + 1}</span>}
                        </div>
                        <p className="text-sm font-medium text-[var(--rf-text)] leading-relaxed">{q.question}</p>
                      </div>

                      {q.suggestions.length > 0 && (
                        <div className="px-4 pb-2.5 flex flex-wrap gap-1.5">
                          {q.suggestions.map((sug, si) => {
                            const sel = ans.selected.includes(sug);
                            return (
                              <button
                                key={si}
                                onClick={() => toggleSuggestion(idx, sug)}
                                className={`px-2.5 py-1 text-[11px] font-medium rounded-md border transition ${
                                  sel
                                    ? 'bg-[var(--rf-brand)] text-white border-[var(--rf-brand)]'
                                    : 'border-[var(--rf-border)] text-[var(--rf-text-secondary)] hover:border-[var(--rf-brand)] hover:text-[var(--rf-brand)] hover:bg-[var(--rf-brand-subtle)]'
                                }`}
                              >
                                {sel && <Check className="w-3 h-3 inline mr-1" />}
                                {sug}
                              </button>
                            );
                          })}
                        </div>
                      )}

                      <div className="px-4 pb-3.5">
                        <textarea
                          value={ans.custom}
                          onChange={e => handleCustomChange(idx, e.target.value)}
                          placeholder={q.suggestions.length > 0 ? 'Click suggestions above or type your own answer\u2026' : 'Type your answer\u2026'}
                          rows={2}
                          className="w-full bg-[var(--rf-bg)] border border-[var(--rf-border)] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--rf-brand)] focus:border-[var(--rf-brand)] transition resize-none"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="flex justify-end pt-2 pb-8">
            <button
              onClick={handleSubmit}
              className="flex items-center gap-2 px-5 py-2.5 rounded-md text-sm font-semibold text-white bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] transition active:scale-[0.98]"
            >
              Generate Features <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
