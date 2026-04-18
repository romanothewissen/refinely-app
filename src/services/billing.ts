import { TIER_LIMITS, TenantConfig, TierLimits } from '../types';
import { entityGet, entitySet, KEYS } from './cache';

interface UsageRecord {
  month: string;   // "YYYY-MM"
  generations: number;
}

export type GenerationCredentialMode = 'byok' | 'hosted_sampler';

export interface GenerationUsageSnapshot extends UsageRecord {
  credentialMode: GenerationCredentialMode;
  quotaScope: 'tenant';
  resetCadence: 'calendar_month';
}

const HOSTED_SAMPLER_GENERATIONS_PER_MONTH = 5;

const PROVIDER_KEY_FIELDS = {
  anthropic: 'anthropicApiKey',
  gemini: 'geminiApiKey',
  openai: 'openaiApiKey',
  azure_openai: 'azureOpenAIApiKey',
  ollama: 'ollamaApiKey',
} as const;

function getCurrentMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

function getUsageRecordKey(mode: GenerationCredentialMode): string {
  return mode === 'hosted_sampler' ? KEYS.hostedSamplerUsageCurrentMonth : KEYS.usageCurrentMonth;
}

function trimToString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function getGenerationCredentialMode(config: TenantConfig): GenerationCredentialMode {
  const provider = config.generatorConfig?.provider;
  if (!provider || provider === 'forge_llms') return 'hosted_sampler';

  const keyField = PROVIDER_KEY_FIELDS[provider as keyof typeof PROVIDER_KEY_FIELDS];
  if (!keyField) return 'hosted_sampler';

  const providerKey = trimToString(config.generatorConfig?.[keyField]);
  return providerKey ? 'byok' : 'hosted_sampler';
}

function getHostedSamplerLimits(baseLimits: TierLimits): TierLimits {
  return {
    ...baseLimits,
    generationsPerMonth: HOSTED_SAMPLER_GENERATIONS_PER_MONTH,
  };
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
  const credentialMode = getGenerationCredentialMode(config);
  const limits = credentialMode === 'hosted_sampler'
    ? getHostedSamplerLimits(getLimits(effectiveTier))
    : getLimits(effectiveTier);

  if (credentialMode === 'hosted_sampler') {
    const usage = await getUsageForMode('hosted_sampler');
    if (usage.generations >= HOSTED_SAMPLER_GENERATIONS_PER_MONTH) {
      return {
        allowed: false,
        reason: 'This workspace has used all 5 hosted trial generations for this month. Connect your own key in Settings to continue generating.',
      };
    }
    if (usage.generations === HOSTED_SAMPLER_GENERATIONS_PER_MONTH - 1) {
      return {
        allowed: true,
        reason: 'This workspace is on the last hosted trial generation for this month. Connect your own key in Settings to continue after this run.',
      };
    }
    return { allowed: true };
  }

  if (limits.generationsPerMonth === -1) return { allowed: true };

  const usage = await getUsageForMode('byok');
  if (usage.generations >= limits.generationsPerMonth) {
    return {
      allowed: true,
      reason: `Your workspace has used the ${limits.generationsPerMonth} generations included with the Standard plan this month. Generation is still available, and you can contact support if you need higher soft-limit guidance.`,
    };
  }
  return { allowed: true };
}

export async function recordGeneration(config: TenantConfig): Promise<void> {
  const credentialMode = getGenerationCredentialMode(config);
  const usage = await getUsageForMode(credentialMode);
  usage.generations += 1;
  await entitySet(getUsageRecordKey(credentialMode), {
    month: usage.month,
    generations: usage.generations,
  });
}

async function getUsageForMode(mode: GenerationCredentialMode): Promise<UsageRecord> {
  const currentMonth = getCurrentMonthKey();
  const stored = await entityGet<UsageRecord>(getUsageRecordKey(mode));

  // Reset counter on new month
  if (!stored || stored.month !== currentMonth) {
    return { month: currentMonth, generations: 0 };
  }
  return stored;
}

export async function getUsage(config?: TenantConfig, context?: any): Promise<GenerationUsageSnapshot> {
  const credentialMode = config ? getGenerationCredentialMode(config) : 'byok';
  const usage = await getUsageForMode(credentialMode);
  return {
    ...usage,
    credentialMode,
    quotaScope: 'tenant',
    resetCadence: 'calendar_month',
  };
}

export function getUsageLimits(config: TenantConfig, context?: any): TierLimits {
  const effectiveTier = getEffectiveTier(config, context);
  const baseLimits = getLimits(effectiveTier);
  return getGenerationCredentialMode(config) === 'hosted_sampler'
    ? getHostedSamplerLimits(baseLimits)
    : baseLimits;
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
