import { OutputMode, ReasoningMode } from '../types';

/**
 * Minimal planner stub — complexity calibration is now prompt-driven.
 * This file exists only to avoid breaking imports during the transition.
 */
export interface MinimalPlannerContext {
  reasoningMode: ReasoningMode;
  outputMode: OutputMode;
}

export function buildPlannerContext(input: {
  reasoningMode?: ReasoningMode;
  outputMode?: OutputMode;
}): MinimalPlannerContext {
  return {
    reasoningMode: input.reasoningMode ?? 'fast',
    outputMode: input.outputMode ?? 'auto',
  };
}
