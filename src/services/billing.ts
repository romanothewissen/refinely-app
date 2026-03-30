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
  if (!context?.license) return config.tier;

  const license = context.license;
  if (!license.active) return 'free';

  // If active, they are at least 'standard'. 
  // Only allow 'premium' if they have a commercial license or explicitly marked in config
  if (config.tier === 'premium') return 'premium';
  return 'standard';
}

/**
 * Returns the recommended model for a given role based on the tier.
 * This prevents Free users from using expensive/high-perf models.
 */
export function getTierModel(
  requestedModel: string,
  tier: TenantConfig['tier']
): string {
  if (tier === 'premium') return requestedModel; // Premium can use anything

  // Define "Safe/Mini" models for Free/Standard
  const MINI_MODELS: Record<string, string> = {
    'claude-opus-4-6': 'claude-sonnet-4-5-20250929', 
    'claude-3-5-sonnet': 'claude-3-haiku-20240307',
    'gpt-4o': 'gpt-4o-mini',
    'gemini-1.5-pro': 'gemini-1.5-flash',
  };

  if (tier === 'free') {
    // Force downgrade to mini for ALL free requests
    return MINI_MODELS[requestedModel] || 'claude-3-haiku-20240307';
  }

  // Standard can use Pro models but maybe not the "Ultra" ones?
  // For now, let's just allow standard to use what's requested unless it's explicitly blocked.
  return requestedModel;
}

export async function checkGenerationAllowed(
  config: TenantConfig,
  context?: any
): Promise<{ allowed: boolean; reason?: string }> {
  const effectiveTier = getEffectiveTier(config, context);
  const limits = getLimits(effectiveTier);
  
  if (limits.generationsPerMonth === -1) return { allowed: true };
  if (limits.generationsPerMonth === -1) return { allowed: true };

  const usage = await getUsage();
  if (usage.generations >= limits.generationsPerMonth) {
    return {
      allowed: false,
      reason: `You've used all ${limits.generationsPerMonth} generations for this month on the ${config.tier} plan. Please upgrade to continue.`,
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
