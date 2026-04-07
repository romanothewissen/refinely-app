import type { InferProjectPersonaRolesResult, TenantConfig } from '../types';

interface InferProjectPersonaRolesPayload {
  projectKey?: string;
}

interface InferProjectPersonaRolesContext {
  [key: string]: unknown;
}

interface InferProjectPersonaRolesDeps {
  ensureAdmin: (context: InferProjectPersonaRolesContext, projectKey?: string) => Promise<void>;
  getConfig: () => Promise<TenantConfig>;
  inferProjectPersonaRolesFromBacklog: (projectKey: string, config: TenantConfig) => Promise<InferProjectPersonaRolesResult>;
}

export async function handleInferProjectPersonaRoles(
  payload: InferProjectPersonaRolesPayload | undefined,
  context: InferProjectPersonaRolesContext,
  deps: InferProjectPersonaRolesDeps,
): Promise<InferProjectPersonaRolesResult> {
  const projectKey = String(payload?.projectKey ?? '').trim();
  if (!projectKey || projectKey === '*') {
    return {
      success: false,
      suggestions: [],
      sampledIssueCount: 0,
      sampledIssueKeys: [],
      usedCache: true,
      error: 'Select a project before requesting persona role suggestions.',
    };
  }

  await deps.ensureAdmin(context, projectKey);
  const config = await deps.getConfig();
  return deps.inferProjectPersonaRolesFromBacklog(projectKey, config);
}
