import { getConfig } from '../services/tenant-config';
import {
  markProjectMemoryRefreshError,
  refreshProjectMemory,
} from '../services/project-memory';

interface ProjectMemoryRefreshEventBody {
  projectKey?: string;
  trigger?: 'weekly' | 'manual' | 'threshold';
  requestedAt?: string;
  requestedBy?: string;
  force?: boolean;
}

export async function handler(event?: { body?: ProjectMemoryRefreshEventBody }) {
  const projectKey = String(event?.body?.projectKey ?? '').trim();
  if (!projectKey || projectKey === '*') {
    console.log('[project-memory-refresh] ignored refresh without explicit project key');
    return;
  }

  try {
    const config = await getConfig();
    const result = await refreshProjectMemory({
      projectKey,
      config,
      trigger: event?.body?.trigger === 'manual' || event?.body?.trigger === 'threshold' ? event.body.trigger : 'weekly',
      force: Boolean(event?.body?.force),
    });
    console.log('[project-memory-refresh] completed', {
      projectKey,
      requestedAt: event?.body?.requestedAt,
      requestedBy: event?.body?.requestedBy,
      refreshed: result.refreshed,
      reason: result.reason,
      artifactVersion: result.artifactVersion,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'Unknown project memory refresh error');
    await markProjectMemoryRefreshError(projectKey, message);
    console.error('[project-memory-refresh] failed', { projectKey, error: message });
    throw error;
  }
}
