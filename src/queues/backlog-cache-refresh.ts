import { getConfig } from '../services/tenant-config';
import { refreshBacklogCachesForProjects } from '../core/similar-stories';
import { entitySet, KEYS } from '../services/cache';

interface BacklogCacheRefreshEvent {
  projectKey?: string;
  requestedAt?: string;
  requestedBy?: string;
  manual?: boolean;
}

async function setRefreshStatus(
  projectKey: string,
  status: 'queued' | 'running' | 'completed' | 'error',
  details: Record<string, unknown> = {},
) {
  await entitySet(KEYS.backlogRefreshStatus(projectKey), {
    projectKey,
    status,
    updatedAt: new Date().toISOString(),
    ...details,
  });
}

export async function handler(event?: { body?: BacklogCacheRefreshEvent }) {
  try {
    const config = await getConfig();
    const manualProjectKey = event?.body?.projectKey;

    if (!manualProjectKey || manualProjectKey === '*') {
      console.log('[backlog-cache-refresh] ignored refresh without explicit authorized project key');
      return;
    }

    await setRefreshStatus(manualProjectKey, 'running', {
      requestedAt: event?.body?.requestedAt,
      requestedBy: event?.body?.requestedBy,
      manual: true,
      startedAt: new Date().toISOString(),
    });
    const refreshed = await refreshBacklogCachesForProjects([manualProjectKey], config);
    const result = refreshed.find(item => item.projectKey === manualProjectKey);
    await setRefreshStatus(manualProjectKey, 'completed', {
      requestedAt: event?.body?.requestedAt,
      requestedBy: event?.body?.requestedBy,
      manual: true,
      completedAt: new Date().toISOString(),
      issueCount: result?.issueCount ?? 0,
      shardCount: result?.shardCount ?? 0,
      themeCount: result?.themeCount ?? 0,
      builtAt: result?.builtAt,
      themeBuiltAt: result?.themeBuiltAt,
    });
    console.log('[backlog-cache-refresh] refreshed manual cache:', `${manualProjectKey}:${result?.issueCount ?? 0}`);
  } catch (err) {
    const manualProjectKey = event?.body?.projectKey;
    if (manualProjectKey && manualProjectKey !== '*') {
      await setRefreshStatus(manualProjectKey, 'error', {
        requestedAt: event?.body?.requestedAt,
        requestedBy: event?.body?.requestedBy,
        manual: true,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    console.error('[backlog-cache-refresh] failed:', err);
    throw err;
  }
}
