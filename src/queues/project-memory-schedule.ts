import { getConfig } from '../services/tenant-config';
import { queueDueProjectMemoryRefreshes } from '../services/project-memory';

export async function handler() {
  const config = await getConfig();
  const queuedProjects = await queueDueProjectMemoryRefreshes(config);
  console.log('[project-memory-schedule] queued projects', queuedProjects);
  return { queuedProjects };
}
