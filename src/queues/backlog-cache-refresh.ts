import { getConfig } from '../services/tenant-config';
import { refreshBacklogCachesForProjects } from '../core/similar-stories';
import { entitySet, KEYS } from '../services/cache';

interface BacklogCacheRefreshEvent {
  projectKey?: string;
  requestedAt?: string;
  requestedBy?: string;
  manual?: boolean;
}

function collectKnownProjectKeys(config: Awaited<ReturnType<typeof getConfig>>): string[] {
  const keys = new Set<string>();

  for (const mapping of config.arMappings ?? []) {
    if (mapping.projectKey && mapping.projectKey !== '*') keys.add(mapping.projectKey);
  }
  for (const ctx of config.domainContexts ?? []) {
    if (ctx.projectKey && ctx.projectKey !== '*') keys.add(ctx.projectKey);
  }
  for (const scope of config.backlogStatusScopes ?? []) {
    if (scope.projectKey && scope.projectKey !== '*') keys.add(scope.projectKey);
  }

  return Array.from(keys);
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

    if (manualProjectKey && manualProjectKey !== '*') {
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
      return;
    }

    const projectKeys = collectKnownProjectKeys(config);
    const refreshed = await refreshBacklogCachesForProjects(projectKeys, config);
    console.log('[backlog-cache-refresh] refreshed caches:', refreshed.map(r => `${r.projectKey}:${r.issueCount}`).join(', '));
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
