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
  if (config.tier === 'enterprise') return 'enterprise';
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
  if (tier === 'premium' || tier === 'enterprise') return requestedModel; // Top tiers can use anything

  if (tier === 'free') {
    const model = requestedModel.toLowerCase();

    if (requestedModel.startsWith('gemini-')) {
      if (model.includes('pro')) return requestedModel.replace(/pro/i, 'flash');
      if (model.includes('flash')) return requestedModel;
      return 'gemini-2.5-flash';
    }

    if (requestedModel.startsWith('gpt-') || requestedModel.startsWith('o1') || requestedModel.startsWith('o3')) {
      return 'gpt-4o-mini';
    }

    if (requestedModel.startsWith('anthropic.')) {
      if (model.includes('haiku')) return requestedModel;
      return 'anthropic.claude-3-5-haiku-20241022-v1:0';
    }

    if (model.includes('haiku')) return requestedModel;
    if (model.includes('sonnet') || model.includes('opus') || model.includes('claude')) {
      return 'claude-haiku-4-5-20251001';
    }

    return 'claude-haiku-4-5-20251001';
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
