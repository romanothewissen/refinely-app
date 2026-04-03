import { getConfig } from '../services/tenant-config';
import { refreshBacklogCachesForProjects } from '../core/similar-stories';

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

export async function handler() {
  try {
    const config = await getConfig();
    const projectKeys = collectKnownProjectKeys(config);
    const refreshed = await refreshBacklogCachesForProjects(projectKeys, config);
    console.log('[backlog-cache-refresh] refreshed caches:', refreshed.map(r => `${r.projectKey}:${r.issueCount}`).join(', '));
  } catch (err) {
    console.error('[backlog-cache-refresh] failed:', err);
    throw err;
  }
}
