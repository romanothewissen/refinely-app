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
const STALE_PROGRESS_MS = 20 * 60 * 1000; // 20 min since last update (generous for Pro thinking)

const CLARIFY_TIMEOUT_MS = 180000; // 3 min — generous for Pro thinking mode
const CLARIFY_POLL_INTERVAL_MS = 3500;
const GENERATION_POLL_INTERVAL_MS = 4000;

export function useClarifyRealtime(
  sessionId: string | null,
  onComplete: (payload: { questions: unknown[]; contextMeta?: unknown }) => void,
  onFallthrough: () => void,
) {
  const [progress, setProgress] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAtRef = useRef<number>(0);
  const inFlightRef = useRef(false);
  // Keep callbacks in refs so the polling interval always calls the latest version
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onFallthroughRef = useRef(onFallthrough);
  onFallthroughRef.current = onFallthrough;

  useEffect(() => {
    if (!sessionId) return;
    startedAtRef.current = Date.now();
    let cancelled = false;

    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

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
          result?: { type: string; questions?: unknown[]; contextMeta?: unknown; updatedAt?: number; message?: string };
        };
        const result = res.result;

        // Still waiting (null/undefined or 'pending' sentinel) — check for client-side timeout
        if (!result || result.type === 'pending') {
          setProgress(result?.message ?? 'Preparing discovery workflow…');
          if (Date.now() - startedAtRef.current > CLARIFY_TIMEOUT_MS) {
            clearTimer();
            setProgress('');
            onFallthroughRef.current();
            return;
          }
          scheduleNext();
          return;
        }

        if (result.type === 'complete' && Array.isArray(result.questions) && result.questions.length > 0) {
          console.log('[useClarifyRealtime] session complete with', result.questions.length, 'questions');
          clearTimer();
          setProgress('');
          onCompleteRef.current({ questions: result.questions, contextMeta: result.contextMeta });
        } else if (result.type === 'complete') {
          console.warn('[useClarifyRealtime] complete but no questions found — falling through to generate');
          clearTimer();
          setProgress('');
          onFallthroughRef.current();
        } else if (result.type === 'error') {
          console.error('[useClarifyRealtime] error result from backend');
          clearTimer();
          setProgress('');
          onFallthroughRef.current();
        }
      } catch {
        // transient polling error — keep trying
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
