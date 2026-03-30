import React, { useState } from 'react';
import { ArrowRight, Check, Menu, Sparkles } from 'lucide-react';

interface Question { category: string; question: string; suggestions: string[]; }
interface Answer   { question: string; answer: string; }

interface ClarifyProps {
  questions: Question[];
  onComplete: (answers: Answer[]) => void;
  onSkip: () => void;
  sidebarOpen: boolean;
  setSidebarOpen: (o: boolean) => void;
}

export function ClarifyQuestionsView({ questions, onComplete, onSkip, sidebarOpen, setSidebarOpen }: ClarifyProps) {
  // Each entry: { selected: string[], custom: string }
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

    // Sync custom textarea: rebuild from selected list
    const newCustom = newSelected.join('; ');
    setAnswers(prev => ({ ...prev, [qIdx]: { selected: newSelected, custom: newCustom } }));
  }

  function handleCustomChange(qIdx: number, val: string) {
    // On manual edit, keep selected in sync (we just update custom freely)
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

  // Group questions by category for visual organisation
  const categories: Record<string, { idx: number; q: Question }[]> = {};
  questions.forEach((q, i) => {
    if (!categories[q.category]) categories[q.category] = [];
    categories[q.category].push({ idx: i, q });
  });

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-50 overflow-hidden fade-in">
      {/* Header */}
      <header className="h-[72px] shrink-0 border-b border-slate-200 bg-white shadow-sm flex items-center justify-between px-8 gap-4 sticky top-0 z-20">
        <div className="flex items-center gap-4">
          {!sidebarOpen && (
            <button onClick={() => setSidebarOpen(true)} className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 transition border border-slate-200" title="Open Sidebar">
              <Menu className="w-4 h-4" />
            </button>
          )}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-600 shadow-lg shadow-blue-100 flex items-center justify-center animate-pulse">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-base font-bold text-slate-800 tracking-tight leading-tight">Requirement Discovery</h1>
              <p className="text-[11px] text-slate-500 font-medium leading-tight mt-0.5">{answeredCount} of {questions.length} questions explored</p>
            </div>
          </div>
        </div>

        {/* Progress bar + actions */}
        <div className="flex items-center gap-4 flex-1 max-w-lg">
          <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-500"
              style={{ width: `${(answeredCount / Math.max(questions.length, 1)) * 100}%` }}
            />
          </div>
          <span className="text-xs font-semibold text-slate-400 shrink-0">{answeredCount}/{questions.length}</span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button onClick={onSkip} className="text-xs font-medium text-slate-400 hover:text-slate-600 transition px-3 py-1.5 rounded-lg hover:bg-slate-100">
            Skip all
          </button>
          <button
            onClick={handleSubmit}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 transition shadow-sm active:scale-[0.98]"
          >
            Generate Features <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* All questions — scrollable */}
      <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-6">
        <div className="max-w-5xl mx-auto space-y-8">
          {Object.entries(categories).map(([category, items]) => (
            <div key={category} className="space-y-4">
              {/* Category header */}
              <div className="flex items-center gap-3">
                <span className="text-[10px] font-bold uppercase tracking-widest text-blue-600 bg-blue-50 px-2 py-1 rounded-full">{category}</span>
                <div className="flex-1 h-px bg-slate-200" />
              </div>

              <div className="space-y-4">
                {items.map(({ idx, q }) => {
                  const ans = ensureAnswer(idx);
                  const isAnswered = ans.custom.trim().length > 0 || ans.selected.length > 0;

                  return (
                    <div
                      key={idx}
                      className={`bg-white rounded-2xl border transition-all duration-200 overflow-hidden ${isAnswered ? 'border-blue-200 shadow-sm shadow-blue-100/50' : 'border-slate-200'}`}
                    >
                      {/* Question */}
                      <div className="px-5 pt-4 pb-3 flex items-start gap-3">
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 transition-all ${isAnswered ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-400'}`}>
                          {isAnswered ? <Check className="w-3.5 h-3.5" /> : <span className="text-[10px] font-bold">{idx + 1}</span>}
                        </div>
                        <p className="text-sm font-medium text-slate-800 leading-relaxed">{q.question}</p>
                      </div>

                      {/* Suggestion chips */}
                      {q.suggestions.length > 0 && (
                        <div className="px-5 pb-3 flex flex-wrap gap-2">
                          {q.suggestions.map((sug, si) => {
                            const sel = ans.selected.includes(sug);
                            return (
                              <button
                                key={si}
                                onClick={() => toggleSuggestion(idx, sug)}
                                className={`px-3 py-1.5 text-xs font-medium rounded-xl border transition-all ${
                                  sel
                                    ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                                    : 'border-slate-200 text-slate-600 hover:border-blue-300 hover:bg-blue-50'
                                }`}
                              >
                                {sel && <Check className="w-3 h-3 inline mr-1" />}
                                {sug}
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {/* Answer textarea — pre-filled when chips clicked */}
                      <div className="px-5 pb-4">
                        <textarea
                          value={ans.custom}
                          onChange={e => handleCustomChange(idx, e.target.value)}
                          placeholder={q.suggestions.length > 0 ? 'Click suggestions above or type your own answer…' : 'Type your answer…'}
                          rows={2}
                          className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition resize-none"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Bottom CTA  */}
          <div className="flex justify-end pt-2 pb-8">
            <button
              onClick={handleSubmit}
              className="flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 transition shadow-md active:scale-[0.98]"
            >
              Generate Features <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
