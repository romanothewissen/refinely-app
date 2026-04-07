import { GeneratorConfig, ProjectDomainContext, ProjectPersonaRole, TenantConfig, DEFAULT_CONFIG } from '../types';
import { entityDeleteSecret, entityGet, entityGetSecret, entitySet, entitySetSecret, KEYS } from './cache';

const GENERATOR_SECRET_FIELDS = [
  { field: 'anthropicApiKey', provider: 'anthropic' },
  { field: 'geminiApiKey', provider: 'gemini' },
  { field: 'openaiApiKey', provider: 'openai' },
  { field: 'azureOpenAIApiKey', provider: 'azure_openai' },
] as const;

export async function getConfig(): Promise<TenantConfig> {
  const saved = await entityGet<Partial<TenantConfig>>(KEYS.tenantConfig);
  if (!saved) return { ...DEFAULT_CONFIG };
  // Deep merge with defaults so new fields get defaults on upgrade
  const merged = deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, saved as unknown as Record<string, unknown>) as unknown as TenantConfig;
  const normalized = normalizeConfig(merged);
  return withGeneratorSecrets(normalized, saved);
}

export async function saveConfig(config: Partial<TenantConfig>): Promise<void> {
  const current = await getConfig();
  const merged = deepMerge(
    current as unknown as Record<string, unknown>,
    config as unknown as Record<string, unknown>,
  ) as unknown as TenantConfig;
  const normalized = normalizeConfig(merged);
  await persistGeneratorSecrets(normalized);
  await entitySet(KEYS.tenantConfig, stripGeneratorSecrets(normalized) as unknown);
}

export async function patchConfig(patch: Partial<TenantConfig>): Promise<TenantConfig> {
  const current = await getConfig();
  const updated = deepMerge(current as unknown as Record<string, unknown>, patch as unknown as Record<string, unknown>) as unknown as TenantConfig;
  await saveConfig(updated);
  return updated;
}

export function isConfigured(config: TenantConfig): boolean {
  return Boolean(
    config.arMappings?.length
    || config.domainContexts?.length
    || config.backlogStatusScopes?.length
    || config.wiConfig?.enabled,
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const ov = override[key];
    const bv = base[key];
    if (ov !== null && typeof ov === 'object' && !Array.isArray(ov) &&
        bv !== null && typeof bv === 'object' && !Array.isArray(bv)) {
      result[key] = deepMerge(bv as Record<string, unknown>, ov as unknown as Record<string, unknown>);
    } else if (ov !== undefined) {
      result[key] = ov;
    }
  }
  return result;
}

async function withGeneratorSecrets(config: TenantConfig, saved?: Partial<TenantConfig>): Promise<TenantConfig> {
  const generatorConfig = { ...(config.generatorConfig ?? {}) } as TenantConfig['generatorConfig'];
  const savedGeneratorConfig = (saved?.generatorConfig ?? {}) as Partial<GeneratorConfig>;

  const secretValues = await Promise.all(
    GENERATOR_SECRET_FIELDS.map(async ({ field, provider }) => {
      const secret = await entityGetSecret(KEYS.providerApiKey(provider));
      const legacy =
        field === 'anthropicApiKey' ? savedGeneratorConfig.anthropicApiKey
        : field === 'geminiApiKey' ? savedGeneratorConfig.geminiApiKey
        : field === 'openaiApiKey' ? savedGeneratorConfig.openaiApiKey
        : savedGeneratorConfig.azureOpenAIApiKey;
      return [field, secret ?? legacy] as const;
    }),
  );

  secretValues.forEach(([field, value]) => {
    if (value) generatorConfig[field] = value;
  });

  return {
    ...config,
    generatorConfig,
  };
}

async function persistGeneratorSecrets(config: TenantConfig): Promise<void> {
  const generatorConfig = config.generatorConfig ?? {};

  await Promise.all(
    GENERATOR_SECRET_FIELDS.map(async ({ field, provider }) => {
      const value = generatorConfig[field];
      if (typeof value === 'string' && value.trim()) {
        await entitySetSecret(KEYS.providerApiKey(provider), value.trim());
        return;
      }
      if (value === '') {
        await entityDeleteSecret(KEYS.providerApiKey(provider));
      }
    }),
  );
}

function stripGeneratorSecrets(config: TenantConfig): TenantConfig {
  const generatorConfig = { ...(config.generatorConfig ?? {}) };
  GENERATOR_SECRET_FIELDS.forEach(({ field }) => {
    delete generatorConfig[field];
  });

  return {
    ...config,
    generatorConfig,
  };
}

function normalizeConfig(config: TenantConfig): TenantConfig {
  const normalizedContexts = normalizeDomainContexts(config);
  return {
    ...config,
    domainContexts: normalizedContexts,
  };
}

function normalizeDomainContexts(config: TenantConfig): ProjectDomainContext[] {
  const contexts = Array.isArray(config.domainContexts) ? [...config.domainContexts] : [];
  const legacyContext = splitLegacyGuidance(config.domainContext);
  const legacyRoles = normalizePersonaRoles(config.domainRoles);

  const globalIndex = contexts.findIndex((entry) => entry.projectKey === '*');
  const globalEntry = globalIndex >= 0 ? contexts[globalIndex] : null;
  const mergedGlobal: ProjectDomainContext = {
    projectKey: '*',
    context: String(globalEntry?.context ?? legacyContext.context ?? '').trim(),
    personaRoles: normalizePersonaRoles([
      ...(globalEntry?.personaRoles ?? []),
      ...legacyContext.personaRoles,
      ...legacyRoles,
    ]),
  };

  const next: ProjectDomainContext[] = contexts
    .filter((entry): entry is ProjectDomainContext => Boolean(entry?.projectKey))
    .map((entry) => ({
      projectKey: String(entry.projectKey).trim(),
      context: String(entry.context ?? '').trim(),
      personaRoles: normalizePersonaRoles(entry.personaRoles),
    }))
    .filter((entry) => entry.projectKey);

  if (globalIndex >= 0) {
    const replaceIndex = next.findIndex((entry) => entry.projectKey === '*');
    if (replaceIndex >= 0) next[replaceIndex] = mergedGlobal;
    else next.unshift(mergedGlobal);
  } else if (mergedGlobal.context || mergedGlobal.personaRoles?.length) {
    next.unshift(mergedGlobal);
  } else if (!next.some((entry) => entry.projectKey === '*')) {
    next.unshift({ projectKey: '*', context: '', personaRoles: [] });
  }

  return next;
}

function normalizePersonaRoles(rawRows: unknown): ProjectPersonaRole[] {
  if (!Array.isArray(rawRows)) return [];
  const seen = new Set<string>();
  return rawRows
    .map((row) => {
      if (!row) return null;
      if (typeof row === 'string') {
        return { role: row.trim(), activities: '' };
      }
      const role = String((row as { role?: string; name?: string; title?: string }).role ?? (row as { name?: string }).name ?? (row as { title?: string }).title ?? '').trim();
      const activities = String((row as { activities?: string; activity?: string; description?: string; context?: string }).activities
        ?? (row as { activity?: string }).activity
        ?? (row as { description?: string }).description
        ?? (row as { context?: string }).context
        ?? '').trim();
      return role || activities ? { role, activities } : null;
    })
    .filter((row): row is ProjectPersonaRole => Boolean(row))
    .filter((row) => {
      const key = `${row.role.toLowerCase()}::${row.activities.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function splitLegacyGuidance(rawContext = ''): { context: string; personaRoles: ProjectPersonaRole[] } {
  const marker = '\n---ROLE_GUIDANCE---\n';
  const markerIndex = rawContext.indexOf(marker);
  if (markerIndex === -1) {
    return { context: rawContext.trim(), personaRoles: [] };
  }
  const context = rawContext.slice(0, markerIndex).trim();
  const payload = rawContext.slice(markerIndex + marker.length).trim();
  if (!payload) return { context, personaRoles: [] };
  try {
    const parsed = JSON.parse(payload);
    return { context, personaRoles: normalizePersonaRoles(Array.isArray(parsed) ? parsed : []) };
  } catch {
    return { context, personaRoles: [] };
  }
}
