import type {
  V2GeneratedFeature,
  V2PipelineProgressUpdate,
  V2ProgressDraftFeatureSummary,
  V2ProgressEventComplete,
  V2ProgressEventError,
  V2ProgressEventProgress,
  V2ProgressResultStatus,
} from './types';

export const V2_PROGRESS_TTL_MS = 2 * 60 * 60 * 1000;
export const MAX_V2_PROGRESS_DRAFT_FEATURES = 6;

const MAX_V2_PROGRESS_SUMMARY_LENGTH = 140;

function compactProgressText(value: unknown, fallback: string): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  if (text.length <= MAX_V2_PROGRESS_SUMMARY_LENGTH) return text;
  return `${text.slice(0, MAX_V2_PROGRESS_SUMMARY_LENGTH - 1).trimEnd()}…`;
}

export function shapeV2ProgressDraftFeatures(
  features: Array<Pick<V2GeneratedFeature, 'summary'> & { id?: string }> | null | undefined,
): V2ProgressDraftFeatureSummary[] {
  return (features ?? [])
    .slice(0, MAX_V2_PROGRESS_DRAFT_FEATURES)
    .map((feature, index) => ({
      id: String(feature.id ?? `draft_${index + 1}`),
      summary: compactProgressText(feature.summary, `Draft feature ${index + 1}`),
    }))
    .filter((feature) => Boolean(feature.summary));
}

export function buildV2ProgressEvent(
  sessionId: string,
  update: V2PipelineProgressUpdate,
): V2ProgressEventProgress {
  const draftFeatures = shapeV2ProgressDraftFeatures(update.draftFeatures?.map((feature) => ({
    id: feature.id,
    summary: feature.summary,
  })) ?? []);
  return {
    type: 'progress',
    sessionId,
    stage: update.stage,
    message: compactProgressText(update.message, 'Working on refinement…'),
    ...(draftFeatures.length ? { draftFeatures } : {}),
    ...(update.featureCounts ? { featureCounts: update.featureCounts } : {}),
    updatedAt: Date.now(),
  };
}

export function buildV2CompletionEvent(
  sessionId: string,
  resultStatus: V2ProgressResultStatus,
): V2ProgressEventComplete {
  return {
    type: 'complete',
    sessionId,
    resultStatus,
    updatedAt: Date.now(),
  };
}

export function buildV2ErrorEvent(sessionId: string, message: string): V2ProgressEventError {
  return {
    type: 'error',
    sessionId,
    message: compactProgressText(message, 'V2 generation failed.'),
    updatedAt: Date.now(),
  };
}
