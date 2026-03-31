import { useEffect, useRef, useState } from 'react';
import { invoke } from '@forge/bridge';

export interface GenerationProgress {
  type: 'progress' | 'complete' | 'error';
  sessionId: string;
  message?: string;
  pass?: 1 | 2;
  payload?: unknown;
  updatedAt?: number;
}

const NO_FIRST_EVENT_MS = 90000;       // 90s to receive first queue event before giving up
const STALE_PROGRESS_MS = 6 * 60 * 1000; // fail fast on stalled runs instead of spinning indefinitely

const CLARIFY_TIMEOUT_MS = 120000; // fail sooner so clarify never feels frozen
const CLARIFY_STALE_PROGRESS_MS = 75000;
const CLARIFY_POLL_INTERVAL_MS = 3500;
const GENERATION_POLL_INTERVAL_MS = 4000;

export type ClarifyFallthroughReason = 'no_questions' | 'error' | 'timeout';

export function useClarifyRealtime(
  sessionId: string | null,
  onComplete: (payload: { questions: unknown[]; contextMeta?: unknown }) => void,
  onFallthrough: (reason: ClarifyFallthroughReason) => void,
) {
  const [progress, setProgress] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAtRef = useRef<number>(0);
  const lastSuccessfulPollAtRef = useRef<number>(0);
  const lastDebugSignatureRef = useRef('');
  const inFlightRef = useRef(false);
  // Keep callbacks in refs so the polling interval always calls the latest version
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onFallthroughRef = useRef(onFallthrough);
  onFallthroughRef.current = onFallthrough;

  useEffect(() => {
    if (!sessionId) return;
    console.log('[useClarifyRealtime] polling started', { sessionId });
    startedAtRef.current = Date.now();
    lastSuccessfulPollAtRef.current = startedAtRef.current;
    let cancelled = false;

    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const clearWatchdog = () => {
      if (watchdogRef.current) {
        clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
    };

    const finishWith = (reason: ClarifyFallthroughReason) => {
      if (cancelled) return;
      cancelled = true;
      clearTimer();
      clearWatchdog();
      inFlightRef.current = false;
      setProgress('');
      onFallthroughRef.current(reason);
    };

    watchdogRef.current = setTimeout(() => {
      finishWith('timeout');
    }, CLARIFY_TIMEOUT_MS);

    const scheduleNext = (delay = CLARIFY_POLL_INTERVAL_MS) => {
      if (cancelled) return;
      clearTimer();
      timerRef.current = setTimeout(() => {
        void poll();
      }, delay);
    };

    const poll = async () => {
      if (cancelled || inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const res = await invoke('getClarifyResult', { sessionId }) as {
          success: boolean;
          result?: {
            type: string;
            questions?: unknown[];
            contextMeta?: unknown;
            updatedAt?: number;
            message?: string;
            phase?: string;
            runId?: string;
            jobId?: string;
            eventId?: string;
            retryCount?: number;
            retryReason?: string;
            error?: string;
          };
        };
        lastSuccessfulPollAtRef.current = Date.now();
        const result = res.result;

        // Still waiting (null/undefined or 'pending' sentinel) — check for client-side timeout
        if (!result || result.type === 'pending') {
          setProgress(result?.message ?? 'Preparing discovery workflow…');
          const debugSignature = JSON.stringify({
            type: result?.type ?? 'pending',
            message: result?.message ?? '',
            phase: result?.phase ?? '',
            runId: result?.runId ?? '',
            jobId: result?.jobId ?? '',
            retryCount: result?.retryCount ?? 0,
            retryReason: result?.retryReason ?? '',
          });
          if (debugSignature !== lastDebugSignatureRef.current) {
            lastDebugSignatureRef.current = debugSignature;
            console.log('[useClarifyRealtime] progress', {
              sessionId,
              type: result?.type ?? 'pending',
              message: result?.message ?? 'Preparing discovery workflow…',
              phase: result?.phase,
              runId: result?.runId,
              jobId: result?.jobId,
              eventId: result?.eventId,
              retryCount: result?.retryCount,
              retryReason: result?.retryReason,
              updatedAt: result?.updatedAt,
            });
          }
          const updatedAt = result?.updatedAt ?? 0;
          const ageMs = updatedAt > 0 ? Date.now() - updatedAt : Date.now() - startedAtRef.current;
          if (ageMs > CLARIFY_STALE_PROGRESS_MS) {
            finishWith('timeout');
            return;
          }
          if (Date.now() - startedAtRef.current > CLARIFY_TIMEOUT_MS) {
            finishWith('timeout');
            return;
          }
          scheduleNext();
          return;
        }

        if (result.type === 'complete' && Array.isArray(result.questions) && result.questions.length > 0) {
          console.log('[useClarifyRealtime] session complete with', result.questions.length, 'questions');
          clearTimer();
          clearWatchdog();
          setProgress('');
          onCompleteRef.current({ questions: result.questions, contextMeta: result.contextMeta });
        } else if (result.type === 'complete') {
          console.warn('[useClarifyRealtime] complete but no questions — planner decided none needed');
          finishWith('no_questions');
        } else if (result.type === 'error') {
          console.error('[useClarifyRealtime] error result from backend', {
            sessionId,
            runId: result.runId,
            jobId: result.jobId,
            eventId: result.eventId,
            retryCount: result.retryCount,
            retryReason: result.retryReason,
            error: result.error,
          });
          finishWith('error');
        } else {
          // Unknown shape from storage; keep polling instead of getting stuck.
          scheduleNext();
        }
      } catch {
        const silentPollAgeMs = Date.now() - lastSuccessfulPollAtRef.current;
        if (
          Date.now() - startedAtRef.current > CLARIFY_TIMEOUT_MS ||
          silentPollAgeMs > CLARIFY_STALE_PROGRESS_MS
        ) {
          finishWith('timeout');
          return;
        }
        // transient polling error — keep trying, but the watchdog still enforces a hard stop
        scheduleNext();
      } finally {
        inFlightRef.current = false;
      }
    };

    scheduleNext(0);

    return () => {
      cancelled = true;
      clearTimer();
      clearWatchdog();
      inFlightRef.current = false;
      setProgress('');
    };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  return { progress };
}

export function useGenerationRealtime(
  sessionId: string | null,
  onComplete: (payload: unknown) => void,
  onError: (message: string) => void,
) {
  const [progress, setProgress] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAtRef = useRef<number>(0);
  const inFlightRef = useRef(false);
  // Keep callbacks in refs so the polling interval always calls the latest version
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!sessionId) return;

    setIsGenerating(true);
    setProgress('Queuing generation…');
    startedAtRef.current = Date.now();
    let cancelled = false;

    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const scheduleNext = (delay = GENERATION_POLL_INTERVAL_MS) => {
      if (cancelled) return;
      clearTimer();
      timerRef.current = setTimeout(() => {
        void poll();
      }, delay);
    };

    const poll = async () => {
      if (cancelled || inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const res = await invoke('getProgress', { sessionId }) as { success: boolean; progress?: GenerationProgress };
        const event = res.progress;
        if (!event) {
          // Queue job hasn't written anything yet — give it 90s before giving up
          if (Date.now() - startedAtRef.current > NO_FIRST_EVENT_MS) {
            clearTimer();
            setIsGenerating(false);
            setProgress('');
            onErrorRef.current('Generation did not start — the background job may have failed to launch. Please try again.');
            return;
          }
          scheduleNext();
          return;
        }

        if (event.type === 'progress') {
          const updatedAt = event.updatedAt ?? 0;
          const ageMs = updatedAt > 0 ? Date.now() - updatedAt : Date.now() - startedAtRef.current;
          if (ageMs > STALE_PROGRESS_MS) {
            clearTimer();
            setIsGenerating(false);
            setProgress('');
            onErrorRef.current('Generation is taking unusually long. Please try again, or switch to Fast mode.');
            return;
          }
          setProgress(event.message ?? '');
          scheduleNext();
        } else if (event.type === 'complete') {
          console.log('[useGenerationRealtime] session complete, payload keys', Object.keys(event.payload || {}));
          // Ensure we actually have results, or something went wrong
          const payload = event.payload as any;
          if (payload && payload.features && Array.isArray(payload.features) && payload.features.length > 0) {
            clearTimer();
            setIsGenerating(false);
            setProgress('');
            onCompleteRef.current(payload);
          } else {
            console.error('[useGenerationRealtime] complete but no features found');
            clearTimer();
            setIsGenerating(false);
            setProgress('');
            onErrorRef.current('Generation finished but no features were returned. Please try again.');
          }
        } else if (event.type === 'error') {
          clearTimer();
          setIsGenerating(false);
          setProgress('');
          onErrorRef.current(event.message ?? 'Generation failed');
        } else {
          // Unknown progress payload should not freeze polling.
          scheduleNext();
        }
      } catch {
        // polling errors are transient — keep trying
        scheduleNext();
      } finally {
        inFlightRef.current = false;
      }
    };

    scheduleNext(0);

    return () => {
      cancelled = true;
      clearTimer();
      inFlightRef.current = false;
      setIsGenerating(false);
      setProgress('');
    };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  return { isGenerating, progress };
}
