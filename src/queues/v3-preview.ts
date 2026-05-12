import { runForgeV3Preview, type ForgeV3PreviewInput } from '../services/v3-preview';
import { buildV3PreviewState, saveV3PreviewState } from '../services/v3-preview-state';

interface V3PreviewEventBody extends ForgeV3PreviewInput {
  previewId: string;
  accountId?: string;
  projectKey: string;
  projectKeys: string[];
  queuedAt: string;
}

export async function handler(event: { body: V3PreviewEventBody }) {
  const payload = event.body;
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const baseState = {
    previewId: payload.previewId,
    accountId: payload.accountId,
    projectKey: payload.projectKey,
    projectKeys: payload.projectKeys,
    queuedAt: payload.queuedAt,
  };

  await saveV3PreviewState(buildV3PreviewState({
    ...baseState,
    status: 'running',
    startedAt,
  }, startedAt));

  try {
    const preview = await runForgeV3Preview(payload);
    const completedAt = new Date().toISOString();
    await saveV3PreviewState(buildV3PreviewState({
      ...baseState,
      status: 'completed',
      startedAt,
      completedAt,
      durationMs: Date.now() - startedMs,
      result: preview.result,
      score: preview.score,
      sources: preview.sources,
    }, completedAt));
  } catch (error) {
    const completedAt = new Date().toISOString();
    await saveV3PreviewState(buildV3PreviewState({
      ...baseState,
      status: 'error',
      startedAt,
      completedAt,
      durationMs: Date.now() - startedMs,
      error: error instanceof Error ? error.message : String(error ?? 'V3 Preview failed.'),
    }, completedAt));
  }
}
