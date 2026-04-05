import { TIER_LIMITS, TenantConfig, TierLimits } from '../types';
import { entityGet, entitySet, KEYS } from './cache';

interface UsageRecord {
  month: string;   // "YYYY-MM"
  generations: number;
}


export function getLimits(tier: TenantConfig['tier']): TierLimits {
  return TIER_LIMITS[tier];
}

export function getEffectiveTier(config: TenantConfig, context?: any): TenantConfig['tier'] {
  // If no license info, allow what's in config (for dev/staging)
  if (!context?.license) return config.tier === 'free' ? 'free' : 'standard';

  const license = context.license;
  if (!license.active) return 'free';

  return 'standard';
}

/**
 * Returns the recommended model for a given role based on the tier.
 * This prevents inactive/unlicensed users from using expensive models.
 */
export function getTierModel(
  requestedModel: string,
  tier: TenantConfig['tier']
): string {
  // Define "Safe/Mini" models for the limited free fallback.
  const MINI_MODELS: Record<string, string> = {
    'claude-opus-4-6': 'claude-sonnet-4-6',
    'claude-opus-4-1-20250805': 'claude-sonnet-4-20250514',
    'claude-opus-4-20250514': 'claude-sonnet-4-20250514',
    'claude-3-5-sonnet': 'claude-3-haiku-20240307',
    'gpt-5.4': 'gpt-5.4-mini',
    'gpt-5': 'gpt-5-mini',
    'gpt-4.1': 'gpt-4.1-mini',
    'gpt-4o': 'gpt-4o-mini',
    'o3': 'o4-mini',
    'gemini-2.5-pro': 'gemini-2.5-flash',
    'gemini-1.5-pro': 'gemini-1.5-flash',
  };

  if (tier === 'free') {
    // Force downgrade to mini for ALL free requests
    return MINI_MODELS[requestedModel] || 'claude-3-haiku-20240307';
  }

  return requestedModel;
}

export async function checkGenerationAllowed(
  config: TenantConfig,
  context?: any
): Promise<{ allowed: boolean; reason?: string }> {
  const effectiveTier = getEffectiveTier(config, context);
  const limits = getLimits(effectiveTier);
  
  if (limits.generationsPerMonth === -1) return { allowed: true };

  const usage = await getUsage();
  if (usage.generations >= limits.generationsPerMonth) {
    return {
      allowed: true,
      reason: `Your workspace has used the ${limits.generationsPerMonth} generations included with the Standard plan this month. Generation is still available, and you can contact support if you need higher soft-limit guidance.`,
    };
  }
  return { allowed: true };
}

export async function recordGeneration(): Promise<void> {
  const usage = await getUsage();
  usage.generations += 1;
  await entitySet(KEYS.usageCurrentMonth, usage);
}

export async function getUsage(): Promise<UsageRecord> {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const stored = await entityGet<UsageRecord>(KEYS.usageCurrentMonth);

  // Reset counter on new month
  if (!stored || stored.month !== currentMonth) {
    return { month: currentMonth, generations: 0 };
  }
  return stored;
}

export function checkFeatureAllowed(
  feature: keyof TierLimits,
  config: TenantConfig
): { allowed: boolean; reason?: string } {
  const limits = getLimits(config.tier);
  const val = limits[feature];

  if (typeof val === 'boolean') {
    if (!val) {
      return {
        allowed: false,
        reason: `"${String(feature)}" is not available on the ${config.tier} plan. Please upgrade.`,
      };
    }
    return { allowed: true };
  }

  if (typeof val === 'number' && val === -1) return { allowed: true };
  return { allowed: true };
}
