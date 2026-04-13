import { useEffect, useRef, useState } from 'react';
import { invoke } from '@forge/bridge';
import type { AdvisoryTriageContract, ClarifyContextMeta, ClarifyFailureReasonCode, ClarifyProgressPayload, DraftReviewMetadata, EffectiveSizingContract, FeatureActorSource, FeatureClass, FeatureConfidence, GenerationModelRoute, GenerationQualityMode, OutputProfile, PipelineLatencyBreakdown } from '../types';

export interface GenerationProgress {
  type: 'progress' | 'complete' | 'error' | 'cancelled' | 'review';
  sessionId: string;
  message?: string;
  pass?: 1 | 2;
  payload?: unknown;
  updatedAt?: number;
}

export interface GenerationProgressPayload {
  stage?: 'context' | 'triage' | 'decomposition' | 'acceptance_requirements';
  triage?: EffectiveSizingContract;
  sizingContract?: EffectiveSizingContract;
  advisoryTriage?: AdvisoryTriageContract;
  latencyMs?: PipelineLatencyBreakdown;
  modelRoute?: GenerationModelRoute;
  qualityMode?: GenerationQualityMode;
  arProgress?: { completed: number; total: number; phase?: 'initial' | 'backfill' };
  draftFeatures?: Array<{ id: string; summary: string; description: string; storyPoints?: number; featureClass?: FeatureClass; confidence?: FeatureConfidence; actorSource?: FeatureActorSource }>;
  draftFeatureCount?: number;
  featureProgress?: Array<{ id: string; status: 'pending' | 'active' | 'retrying' | 'complete' | 'failed' }>;
  failedFeatureIds?: string[];
  draftReview?: DraftReviewMetadata;
  stageDurationsMs?: { triage?: number; decomposition?: number; acceptanceRequirements?: number; backfill?: number; repair?: number; coverageCheck?: number; total?: number };
  resumeContext?: unknown;
  sources?: {
    projectKey: string;
    projectCount?: number;
    domainContextApplied?: boolean;
    attachmentIncluded?: boolean;
    wiDocsCount?: number;
    linkedWiDocCount?: number;
    retrievedWiDocCount?: number;
    retrievedWiChunkCount?: number;
    wiInsightCount?: number;
    referencedWiDocs?: Array<{ docId: string; filename: string; chunkCount: number }>;
    referencedWiSections?: Array<{ docId: string; filename: string; chunkIndex: number; excerpt: string; sectionLabel?: string }>;
    similarStoriesCount?: number;
    referencedSimilarStories?: Array<{ key: string; summary: string; relevanceScore?: number; url?: string; jiraIssueUrl?: string }>;
  };
  outputProfile?: OutputProfile;
}

const GENERATION_STAGE_ORDER: Array<NonNullable<GenerationProgressPayload['stage']>> = [
  'context',
  'triage',
  'decomposition',
  'acceptance_requirements',
];

function resolveStage(
  previous?: GenerationProgressPayload['stage'],
  next?: GenerationProgressPayload['stage'],
): GenerationProgressPayload['stage'] {
  if (!previous) return next;
  if (!next) return previous;
  const previousIndex = GENERATION_STAGE_ORDER.indexOf(previous);
  const nextIndex = GENERATION_STAGE_ORDER.indexOf(next);
  if (previousIndex < 0) return next;
  if (nextIndex < 0) return previous;
  return nextIndex >= previousIndex ? next : previous;
}

function mergeGenerationSources(
  previous?: GenerationProgressPayload['sources'],
  next?: GenerationProgressPayload['sources'],
): GenerationProgressPayload['sources'] {
  if (!previous) return next;
  if (!next) return previous;
  return {
    ...previous,
    ...next,
    referencedWiDocs: next.referencedWiDocs?.length ? next.referencedWiDocs : previous.referencedWiDocs,
    referencedWiSections: next.referencedWiSections?.length ? next.referencedWiSections : previous.referencedWiSections,
    referencedSimilarStories: next.referencedSimilarStories?.length ? next.referencedSimilarStories : previous.referencedSimilarStories,
  };
}

function mergeGenerationPayload(
  previous: GenerationProgressPayload | null,
  next: GenerationProgressPayload | null,
): GenerationProgressPayload | null {
  if (!previous) return next;
  if (!next) return previous;
  return {
    stage: resolveStage(previous.stage, next.stage),
    triage: next.triage ?? previous.triage,
    sizingContract: next.sizingContract ?? previous.sizingContract,
    advisoryTriage: next.advisoryTriage ?? previous.advisoryTriage,
    arProgress: next.arProgress ?? previous.arProgress,
    draftFeatures: next.draftFeatures?.length ? next.draftFeatures : previous.draftFeatures,
    draftFeatureCount: next.draftFeatureCount ?? previous.draftFeatureCount,
    featureProgress: next.featureProgress?.length ? next.featureProgress : previous.featureProgress,
    failedFeatureIds: next.failedFeatureIds ?? previous.failedFeatureIds,
    draftReview: next.draftReview ?? previous.draftReview,
    stageDurationsMs: next.stageDurationsMs ?? previous.stageDurationsMs,
    resumeContext: next.resumeContext ?? previous.resumeContext,
    sources: mergeGenerationSources(previous.sources, next.sources),
    outputProfile: next.outputProfile ?? previous.outputProfile,
    latencyMs: next.latencyMs ?? previous.latencyMs,
    modelRoute: next.modelRoute ?? previous.modelRoute,
    qualityMode: next.qualityMode ?? previous.qualityMode,
  };
}

const POLL_INTERVAL_MS = 2000;
const NO_FIRST_EVENT_MS = 60000;
/** Generation can sit on a single LLM call (especially AR pass) longer than 90s; avoid false timeouts while the queue still updates `updatedAt` via heartbeat. */
const STALE_PROGRESS_MS = 300000;
const PROGRESS_STABILITY_MS = 80;

// Clarify runs in a 15-minute queue worker, so client-side timeouts should
// allow long discovery sessions and only fail when progress actually goes stale.
const CLARIFY_TIMEOUT_MS = 960000;
const CLARIFY_STALE_PROGRESS_MS = 120000;

export interface ClarifyBlockedPayload {
  message: string;
  reasonCode: ClarifyFailureReasonCode;
  contextMeta?: ClarifyContextMeta | null;
}

function mergeClarifyPayload(
  previous: ClarifyProgressPayload | null,
  next: ClarifyProgressPayload | null,
): ClarifyProgressPayload | null {
  if (!previous) return next;
  if (!next) return previous;
  return {
    stage: next.stage ?? previous.stage,
    assessment: next.assessment ?? previous.assessment,
    sizingContract: next.sizingContract ?? previous.sizingContract,
    advisoryTriage: next.advisoryTriage ?? previous.advisoryTriage,
    discoveryProfile: next.discoveryProfile ?? previous.discoveryProfile,
    ambiguityAssessment: next.ambiguityAssessment ?? previous.ambiguityAssessment,
    latencyMs: next.latencyMs ?? previous.latencyMs,
    modelRoute: next.modelRoute ?? previous.modelRoute,
    sources: next.sources ?? previous.sources,
  };
}

export function useClarifyRealtime(
  sessionId: string | null,
  expectedInputSignature: string | null,
  runId: number,
  onComplete: (payload: { questions: unknown[]; contextMeta?: unknown }) => void,
  onBlocked: (payload: ClarifyBlockedPayload) => void,
  onCancel?: () => void,
) {
  const [progress, setProgress] = useState('');
  const [progressPayload, setProgressPayload] = useState<ClarifyProgressPayload | null>(null);
  const [isClarifying, setIsClarifying] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);
  const cancelledRef = useRef(false);
  // Keep callbacks in refs so the polling interval always calls the latest version
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onBlockedRef = useRef(onBlocked);
  onBlockedRef.current = onBlocked;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  const stopClarify = async () => {
    if (!sessionId) return;
    cancelledRef.current = true;
    try {
      await invoke('cancelClarify', { sessionId });
    } catch {
      // Best-effort cancellation marker; the queue will stop on its next checkpoint.
    }
  };

  useEffect(() => {
    if (!sessionId) return;
    void runId;
    let active = true;
    cancelledRef.current = false;
    startedAtRef.current = Date.now();
    setIsClarifying(true);
    setProgress('Analyzing requirement and gathering context…');
    setProgressPayload(null);

    timerRef.current = setInterval(async () => {
      if (!active) return;
      try {
        const res = await invoke('getClarifyResult', { sessionId }) as {
          success: boolean;
          result?: {
            type: string;
            inputSignature?: string;
            message?: string;
            payload?: ClarifyProgressPayload;
            error?: string;
            reasonCode?: ClarifyFailureReasonCode;
            questions?: unknown[];
            contextMeta?: ClarifyContextMeta;
            updatedAt?: number;
          };
        };
        if (!active) return;
        const result = res.result;

        if (
          expectedInputSignature
          && result?.inputSignature
          && result.inputSignature !== expectedInputSignature
        ) {
          return;
        }

        // Still waiting (null/undefined or 'pending' sentinel) — check for client-side timeout
        if (!result || result.type === 'pending' || result.type === 'progress') {
          if (result?.message) setProgress(result.message);
          const updatedAt = result?.updatedAt ?? 0;
          const payloadWithPollingLag = result?.payload
            ? {
                ...result.payload,
                latencyMs: {
                  ...(result.payload.latencyMs ?? {}),
                  ...(updatedAt > 0 ? { pollingLagMs: Math.max(0, Date.now() - updatedAt) } : {}),
                },
              }
            : null;
          setProgressPayload(previous => mergeClarifyPayload(previous, payloadWithPollingLag));
          const ageMs = updatedAt > 0 ? Date.now() - updatedAt : Date.now() - startedAtRef.current;
          if (ageMs > CLARIFY_STALE_PROGRESS_MS) {
            clearInterval(timerRef.current!);
            timerRef.current = null;
            setIsClarifying(false);
            setProgress('');
            setProgressPayload(null);
            onBlockedRef.current({
              message: 'Discovery timed out while waiting for clarifying questions.',
              reasonCode: 'timeout',
              contextMeta: null,
            });
            return;
          }
          if (Date.now() - startedAtRef.current > CLARIFY_TIMEOUT_MS) {
            clearInterval(timerRef.current!);
            timerRef.current = null;
            setIsClarifying(false);
            setProgress('');
            setProgressPayload(null);
            onBlockedRef.current({
              message: 'Discovery timed out before clarifying questions were ready.',
              reasonCode: 'timeout',
              contextMeta: null,
            });
          }
          return;
        }

        if (result.type === 'cancelled') {
          clearInterval(timerRef.current!);
          timerRef.current = null;
          cancelledRef.current = true;
          setIsClarifying(false);
          setProgress('');
          setProgressPayload(null);
          onCancelRef.current?.();
          return;
        }

        if (result.type === 'complete' && Array.isArray(result.questions)) {
          console.log('[useClarifyRealtime] session complete with', result.questions.length, 'questions');
          clearInterval(timerRef.current!);
          timerRef.current = null;
          setIsClarifying(false);
          setProgress('');
          setProgressPayload(null);
          onCompleteRef.current({ questions: result.questions, contextMeta: result.contextMeta });
        } else if (result.type === 'error' || result.type === 'blocked') {
          console.error('[useClarifyRealtime] blocked result from backend');
          clearInterval(timerRef.current!);
          timerRef.current = null;
          setIsClarifying(false);
          setProgress('');
          setProgressPayload(null);
          onBlockedRef.current({
            message: result.error || result.message || 'Discovery could not prepare clarifying questions.',
            reasonCode: result.reasonCode ?? 'queue_error',
            contextMeta: (result.contextMeta as ClarifyContextMeta | undefined) ?? null,
          });
        }
      } catch {
        // transient polling error — keep trying
      }
    }, POLL_INTERVAL_MS);

    return () => {
      active = false;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      cancelledRef.current = false;
      setIsClarifying(false);
      setProgress('');
      setProgressPayload(null);
    };
  }, [sessionId, expectedInputSignature, runId]); // eslint-disable-line react-hooks/exhaustive-deps

  return { cancelClarify: stopClarify, progress, progressPayload, isClarifying };
}

export function useGenerationRealtime(
  sessionId: string | null,
  runId: number,
  onComplete: (payload: unknown) => void,
  /** @deprecated Draft review pause removed — this callback is never invoked. */
  _onReview: (payload: { message?: string; payload?: GenerationProgressPayload }) => void,
  onError: (message: string) => void,
  onCancel?: (message: string) => void,
) {
  const [progress, setProgress] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [progressPayload, setProgressPayload] = useState<GenerationProgressPayload | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);
  const visibleProgressRef = useRef<string>('');
  const pendingProgressRef = useRef<string>('');
  const pendingProgressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep callbacks in refs so the polling interval always calls the latest version
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  const clearPendingProgressTimer = () => {
    if (pendingProgressTimerRef.current) {
      clearTimeout(pendingProgressTimerRef.current);
      pendingProgressTimerRef.current = null;
    }
  };

  const commitProgress = (message: string, immediate = false) => {
    const next = message.trim();
    if (next === visibleProgressRef.current && !pendingProgressTimerRef.current) return;
    clearPendingProgressTimer();
    if (!next) {
      visibleProgressRef.current = '';
      setProgress('');
      setProgressPayload(null);
      return;
    }

    if (immediate) {
      visibleProgressRef.current = next;
      setProgress(next);
      return;
    }

    pendingProgressRef.current = next;
    pendingProgressTimerRef.current = setTimeout(() => {
      pendingProgressTimerRef.current = null;
      if (pendingProgressRef.current !== next) return;
      visibleProgressRef.current = next;
      setProgress(next);
    }, PROGRESS_STABILITY_MS);
  };

  const stopGeneration = async () => {
    if (!sessionId) return;
    commitProgress('Stopping generation…', true);
    try {
      await invoke('cancelGeneration', { sessionId });
    } catch {
      // Best-effort cancellation marker; the queue will stop on its next checkpoint.
    }
  };

  useEffect(() => {
    if (!sessionId) return;
    void runId;
    let active = true;

    setIsGenerating(true);
    visibleProgressRef.current = '';
    commitProgress('Starting generation…', true);
    startedAtRef.current = Date.now();

    timerRef.current = setInterval(async () => {
      if (!active) return;
      try {
        const res = await invoke('getProgress', { sessionId }) as { success: boolean; progress?: GenerationProgress };
        if (!active) return;
        const event = res.progress;
        if (!event) {
          // Queue job hasn't written anything yet — give it 90s before giving up
          if (Date.now() - startedAtRef.current > NO_FIRST_EVENT_MS) {
            clearInterval(timerRef.current!);
            timerRef.current = null;
            setIsGenerating(false);
            setProgress('');
            onErrorRef.current('Generation did not start — the background job may have failed to launch. Please try again.');
          }
          return;
        }

        const eventUpdatedAt = event.updatedAt ?? 0;
        const isTerminalEvent = event.type === 'complete' || event.type === 'error' || event.type === 'cancelled';
        if (isTerminalEvent && eventUpdatedAt > 0 && eventUpdatedAt < startedAtRef.current) {
          return;
        }

        if (event.type === 'progress') {
          const updatedAt = eventUpdatedAt;
          const ageMs = updatedAt > 0 ? Date.now() - updatedAt : Date.now() - startedAtRef.current;
          if (ageMs > STALE_PROGRESS_MS) {
            clearInterval(timerRef.current!);
            timerRef.current = null;
            setIsGenerating(false);
            clearPendingProgressTimer();
            visibleProgressRef.current = '';
            setProgress('');
            setProgressPayload(null);
            onErrorRef.current('Generation is taking unusually long. Please try again, or switch to a faster model in Settings.');
            return;
          }
          if (event.message) {
            commitProgress(event.message, visibleProgressRef.current === '');
          }
          const nextPayload = (event.payload as GenerationProgressPayload | undefined)
            ? {
                ...(event.payload as GenerationProgressPayload),
                latencyMs: {
                  ...((event.payload as GenerationProgressPayload).latencyMs ?? {}),
                  ...(updatedAt > 0 ? { pollingLagMs: Math.max(0, Date.now() - updatedAt) } : {}),
                },
              }
            : null;
          setProgressPayload(previous => mergeGenerationPayload(
            previous,
            nextPayload,
          ));
        } else if (event.type === 'cancelled') {
          clearInterval(timerRef.current!);
          timerRef.current = null;
          setIsGenerating(false);
          clearPendingProgressTimer();
          visibleProgressRef.current = '';
          setProgress('');
          setProgressPayload(null);
          onCancelRef.current?.(event.message ?? 'Generation stopped.');
        } else if (event.type === 'complete') {
          console.log('[useGenerationRealtime] session complete, payload keys', Object.keys(event.payload || {}));
          // Ensure we actually have results, or something went wrong
          const payload = event.payload as any;
          if (payload && payload.features && Array.isArray(payload.features) && payload.features.length > 0) {
            clearInterval(timerRef.current!);
            timerRef.current = null;
            setIsGenerating(false);
            clearPendingProgressTimer();
            visibleProgressRef.current = '';
            setProgress('');
            setProgressPayload(null);
            onCompleteRef.current(payload);
          } else {
            console.error('[useGenerationRealtime] complete but no features found');
            clearInterval(timerRef.current!);
            timerRef.current = null;
            setIsGenerating(false);
            clearPendingProgressTimer();
            visibleProgressRef.current = '';
            setProgress('');
            setProgressPayload(null);
            onErrorRef.current('Generation finished but no features were returned. Please try again.');
          }
        } else if (event.type === 'error') {
          clearInterval(timerRef.current!);
          timerRef.current = null;
          setIsGenerating(false);
          clearPendingProgressTimer();
          visibleProgressRef.current = '';
          setProgress('');
          setProgressPayload(null);
          onErrorRef.current(event.message ?? 'Generation failed');
        }
      } catch {
        // polling errors are transient — keep trying
      }
    }, POLL_INTERVAL_MS);

    return () => {
      active = false;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      clearPendingProgressTimer();
      setIsGenerating(false);
      visibleProgressRef.current = '';
      setProgress('');
      setProgressPayload(null);
    };
  }, [sessionId, runId]); // eslint-disable-line react-hooks/exhaustive-deps

  return { isGenerating, progress, progressPayload, cancelGeneration: stopGeneration };
}
