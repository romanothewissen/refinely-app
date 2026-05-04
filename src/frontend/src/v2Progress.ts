export type V2ProgressStage =
  | 'context'
  | 'triage'
  | 'scope_hypothesis'
  | 'discover'
  | 'discovery_synthesis'
  | 'final_generation'
  | 'coverage_repair'
  | 'persisting';

export type V2ProgressResultStatus = 'needs_discovery' | 'complete';

export interface V2ProgressDraftFeatureSummary {
  id: string;
  summary: string;
}

export interface V2ProgressFeatureCounts {
  drafted: number;
}

export interface V2ProgressEventProgress {
  type: 'progress';
  sessionId: string;
  stage: V2ProgressStage;
  message: string;
  updatedAt: number;
  draftFeatures?: V2ProgressDraftFeatureSummary[];
  featureCounts?: V2ProgressFeatureCounts;
}

export interface V2ProgressEventComplete {
  type: 'complete';
  sessionId: string;
  resultStatus: V2ProgressResultStatus;
  updatedAt: number;
}

export interface V2ProgressEventError {
  type: 'error';
  sessionId: string;
  message: string;
  updatedAt: number;
}

export type V2ProgressEvent =
  | V2ProgressEventProgress
  | V2ProgressEventComplete
  | V2ProgressEventError;

export type V2LoadingMode = 'preview' | 'refinement';

export interface V2LoadingStep {
  stage: V2ProgressStage;
  label: string;
  shortLabel: string;
  summary: string;
  percent: number;
}

export const V2_PREVIEW_LOADING_STEPS: V2LoadingStep[] = [
  {
    stage: 'context',
    label: 'Reading project context',
    shortLabel: 'Context',
    summary: 'Pulling the requirement, project scope, and supporting context into one working view.',
    percent: 16,
  },
  {
    stage: 'triage',
    label: 'Scoring scope complexity',
    shortLabel: 'Triage',
    summary: 'Estimating capability breadth, ambiguity, and how much discovery the request may need.',
    percent: 48,
  },
  {
    stage: 'scope_hypothesis',
    label: 'Shaping scope hypothesis',
    shortLabel: 'Scope',
    summary: 'Turning the request into provisional capabilities, actor slots, and open questions.',
    percent: 86,
  },
];

export const V2_REFINEMENT_LOADING_STEPS: V2LoadingStep[] = [
  {
    stage: 'context',
    label: 'Preparing refinement context',
    shortLabel: 'Prep',
    summary: 'Loading the scoped requirement and any saved project memory needed for final drafting.',
    percent: 10,
  },
  {
    stage: 'discovery_synthesis',
    label: 'Synthesizing decisions',
    shortLabel: 'Synthesis',
    summary: 'Consolidating the approved scope and material answers into the backlog shape.',
    percent: 34,
  },
  {
    stage: 'final_generation',
    label: 'Drafting backlog features',
    shortLabel: 'Drafts',
    summary: 'Generating feature summaries first so the canvas can show visible progress while refinement continues.',
    percent: 66,
  },
  {
    stage: 'coverage_repair',
    label: 'Repairing coverage gaps',
    shortLabel: 'Coverage',
    summary: 'Checking for missed workflow or rule coverage and tightening the draft where needed.',
    percent: 82,
  },
  {
    stage: 'persisting',
    label: 'Saving final result',
    shortLabel: 'Save',
    summary: 'Persisting the completed V2 turn so the full result can be reloaded from SQL.',
    percent: 96,
  },
];
