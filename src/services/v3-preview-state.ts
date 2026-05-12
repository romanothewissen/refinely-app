import { randomUUID } from 'crypto';
import { entityGet, entitySetWithTtl, KEYS } from './cache';
import type { ForgeV3PreviewResult } from './v3-preview';

export type V3PreviewRunStatus = 'queued' | 'running' | 'completed' | 'error';

export interface V3PreviewState {
  previewId: string;
  accountId?: string;
  projectKey?: string;
  projectKeys?: string[];
  status: V3PreviewRunStatus;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  durationMs?: number;
  error?: string;
  result?: ForgeV3PreviewResult['result'];
  score?: ForgeV3PreviewResult['score'];
  sources?: ForgeV3PreviewResult['sources'];
}

export const V3_PREVIEW_STATE_TTL_MS = 24 * 60 * 60 * 1000;

export function createV3PreviewId(): string {
  return `v3_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function buildV3PreviewState(input: {
  previewId: string;
  accountId?: string;
  projectKey?: string;
  projectKeys?: string[];
  status: V3PreviewRunStatus;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  result?: ForgeV3PreviewResult['result'];
  score?: ForgeV3PreviewResult['score'];
  sources?: ForgeV3PreviewResult['sources'];
}, updatedAt = new Date().toISOString()): V3PreviewState {
  return {
    previewId: input.previewId,
    accountId: input.accountId,
    projectKey: input.projectKey,
    projectKeys: input.projectKeys,
    status: input.status,
    queuedAt: input.queuedAt,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    updatedAt,
    durationMs: input.durationMs,
    error: input.error,
    result: input.result,
    score: input.score,
    sources: input.sources,
  };
}

export async function saveV3PreviewState(state: V3PreviewState): Promise<void> {
  await entitySetWithTtl(KEYS.v3PreviewStatus(state.previewId), state, V3_PREVIEW_STATE_TTL_MS);
}

export async function loadV3PreviewState(previewId: string): Promise<V3PreviewState | undefined> {
  return entityGet<V3PreviewState>(KEYS.v3PreviewStatus(previewId));
}
