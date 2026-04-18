import React from 'react';
import { Check } from 'lucide-react';

export interface StepConfig {
  id: string;
  label: string;
  description?: string;
  required?: boolean;
}

interface StepIndicatorProps {
  steps: StepConfig[];
  activeStep: string;
  completedSteps: Set<string>;
  onStepClick: (stepId: string) => void;
}

export function StepIndicator({
  steps,
  activeStep,
  completedSteps,
  onStepClick,
}: StepIndicatorProps) {
  const activeIndex = steps.findIndex((s) => s.id === activeStep);

  return (
    <div className="flex items-center gap-1">
      {steps.map((step, index) => {
        const isActive = step.id === activeStep;
        const isCompleted = completedSteps.has(step.id);
        const isPast = index < activeIndex;

        return (
          <React.Fragment key={step.id}>
            {index > 0 && (
              <div
                className={`h-px flex-1 min-w-[16px] max-w-[32px] transition-colors ${
                  isPast || isCompleted ? 'bg-[var(--rf-brand)]' : 'bg-[var(--rf-border)]'
                }`}
              />
            )}
            <button
              type="button"
              onClick={() => onStepClick(step.id)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg transition text-left group ${
                isActive
                  ? 'bg-[var(--rf-brand-muted)] border border-[var(--rf-brand)]'
                  : 'hover:bg-[var(--rf-surface-soft)] border border-transparent'
              }`}
              title={step.description}
            >
              <span
                className={`flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-black shrink-0 transition ${
                  isCompleted
                    ? 'bg-[var(--rf-brand)] text-white'
                    : isActive
                      ? 'bg-[var(--rf-brand)] text-white'
                      : 'bg-[var(--rf-surface-soft)] text-[var(--rf-text-tertiary)] border border-[var(--rf-border)]'
                }`}
              >
                {isCompleted ? <Check className="w-3.5 h-3.5" /> : index + 1}
              </span>
              <div className="hidden sm:block min-w-0">
                <div className={`text-[13px] font-bold leading-tight ${
                  isActive ? 'text-[var(--rf-text)]' : 'text-[var(--rf-text-secondary)]'
                }`}>
                  {step.label}
                </div>
                {step.required && (
                  <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-danger)]">
                    Required
                  </span>
                )}
              </div>
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}