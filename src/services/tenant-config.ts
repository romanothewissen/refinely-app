import { TenantConfig, DEFAULT_CONFIG } from '../types';
import { entitySet, entityGet, KEYS } from './cache';

export async function getConfig(): Promise<TenantConfig> {
  const saved = await entityGet<Partial<TenantConfig>>(KEYS.tenantConfig);
  if (!saved) return { ...DEFAULT_CONFIG };
  // Deep merge with defaults so new fields get defaults on upgrade
  return deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, saved as unknown as Record<string, unknown>) as unknown as TenantConfig;
}

export async function saveConfig(config: Partial<TenantConfig>): Promise<void> {
  const current = await getConfig();
  const merged = deepMerge(
    current as unknown as Record<string, unknown>,
    config as unknown as Record<string, unknown>,
  ) as unknown as TenantConfig;
  await entitySet(KEYS.tenantConfig, merged as unknown);
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
