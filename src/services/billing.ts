import type {
  GenerationAccessState,
  PipelineProfile,
  PreviewUsageCredits,
  TenantConfig,
  TierLimits,
  UsageWarningState,
} from '../types';
import { TIER_LIMITS } from '../types';
import { entityDelete, entityGet, entitySet, KEYS } from './cache';

interface UsageRecord {
  month: string;   // "YYYY-MM"
  generations: number;
}

interface HostedPreviewUsageRecord {
  month: string;
  consumed: PreviewUsageCredits;
}

interface HostedPreviewReservation {
  month: string;
  profile: PipelineProfile;
  accountId: string;
  createdAt: string;
}

export type GenerationCredentialMode = 'byok' | 'hosted_sampler';

export interface GenerationUsageSnapshot extends UsageRecord {
  credentialMode: GenerationCredentialMode;
  quotaScope: 'user';
  resetCadence: 'calendar_month';
  remainingFastCredits: number;
  remainingBalancedCredits: number;
  remainingQualityCredits: number;
  resetAt: string;
  hasUserApiKey: boolean;
  generationAccessState: GenerationAccessState;
  warningState: UsageWarningState;
}

const HOSTED_PREVIEW_CREDITS: PreviewUsageCredits = {
  fast: 3,
  balanced: 2,
  quality: 1,
};

const PROVIDER_KEY_FIELDS = {
  anthropic: 'anthropicApiKey',
  gemini: 'geminiApiKey',
  openai: 'openaiApiKey',
  fireworks: 'fireworksApiKey',
  azure_openai: 'azureOpenAIApiKey',
  ollama: 'ollamaApiKey',
  groq: 'groqApiKey',
} as const;

function getCurrentMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

function getNextMonthIso(monthKey: string): string {
  const [year, month] = monthKey.split('-').map((value) => Number(value));
  const next = new Date(Date.UTC(year, Math.max(0, month - 1) + 1, 1));
  return next.toISOString();
}

function trimToString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function zeroCredits(): PreviewUsageCredits {
  return { fast: 0, balanced: 0, quality: 0 };
}

function sumPreviewCredits(credits: PreviewUsageCredits): number {
  return credits.fast + credits.balanced + credits.quality;
}

function subtractPreviewCredits(
  allowance: PreviewUsageCredits,
  consumed: PreviewUsageCredits,
): PreviewUsageCredits {
  return {
    fast: Math.max(0, allowance.fast - consumed.fast),
    balanced: Math.max(0, allowance.balanced - consumed.balanced),
    quality: Math.max(0, allowance.quality - consumed.quality),
  };
}

function clonePreviewCredits(value?: Partial<PreviewUsageCredits>): PreviewUsageCredits {
  return {
    fast: Math.max(0, Number(value?.fast ?? 0) || 0),
    balanced: Math.max(0, Number(value?.balanced ?? 0) || 0),
    quality: Math.max(0, Number(value?.quality ?? 0) || 0),
  };
}

function addConsumedCredit(
  current: PreviewUsageCredits,
  profile: PipelineProfile,
): PreviewUsageCredits {
  return {
    ...current,
    [profile]: current[profile] + 1,
  };
}

export function getGenerationCredentialMode(config: TenantConfig): GenerationCredentialMode {
  const provider = config.generatorConfig?.provider;
  if (!provider || provider === 'forge_llms') return 'hosted_sampler';

  const keyField = PROVIDER_KEY_FIELDS[provider as keyof typeof PROVIDER_KEY_FIELDS];
  if (!keyField) return 'hosted_sampler';

  const providerKey = trimToString(config.generatorConfig?.[keyField]);
  return providerKey ? 'byok' : 'hosted_sampler';
}

function getHostedPreviewLimits(baseLimits: TierLimits): TierLimits {
  return {
    ...baseLimits,
    generationsPerMonth: sumPreviewCredits(HOSTED_PREVIEW_CREDITS),
  };
}

export function getLimits(tier: TenantConfig['tier']): TierLimits {
  return TIER_LIMITS[tier];
}

export function getEffectiveTier(config: TenantConfig, context?: any): TenantConfig['tier'] {
  if (!context?.license) return config.tier === 'free' ? 'free' : 'standard';

  const license = context.license;
  if (!license.active) return 'free';

  return 'standard';
}

export function getTierModel(
  requestedModel: string,
  tier: TenantConfig['tier']
): string {
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
    return MINI_MODELS[requestedModel] || 'claude-3-haiku-20240307';
  }

  return requestedModel;
}

function getAccountId(context?: any): string {
  return String(context?.accountId ?? 'unknown');
}

function getPreviewUsageKey(accountId: string): string {
  return KEYS.hostedSamplerUsageCurrentMonthForAccount(accountId);
}

function getByokUsageKey(accountId: string): string {
  return KEYS.usageCurrentMonthForAccount(accountId);
}

function getReservationKey(accountId: string, sessionId: string): string {
  return KEYS.generationCreditReservation(accountId, sessionId);
}

async function getUsageRecordForMode(mode: GenerationCredentialMode, accountId: string): Promise<UsageRecord> {
  const currentMonth = getCurrentMonthKey();
  const key = mode === 'hosted_sampler'
    ? getPreviewUsageKey(accountId)
    : getByokUsageKey(accountId);
  const stored = await entityGet<UsageRecord>(key);
  if (!stored || stored.month !== currentMonth) {
    return { month: currentMonth, generations: 0 };
  }
  return stored;
}

async function getHostedPreviewUsage(accountId: string): Promise<HostedPreviewUsageRecord> {
  const currentMonth = getCurrentMonthKey();
  const stored = await entityGet<HostedPreviewUsageRecord>(getPreviewUsageKey(accountId));
  if (!stored || stored.month !== currentMonth) {
    return { month: currentMonth, consumed: zeroCredits() };
  }
  return {
    month: stored.month,
    consumed: clonePreviewCredits(stored.consumed),
  };
}

async function setHostedPreviewUsage(accountId: string, usage: HostedPreviewUsageRecord): Promise<void> {
  const generations = sumPreviewCredits(usage.consumed);
  await entitySet(getPreviewUsageKey(accountId), {
    month: usage.month,
    consumed: usage.consumed,
    generations,
  });
}

async function getReservation(accountId: string, sessionId?: string): Promise<HostedPreviewReservation | null> {
  if (!sessionId) return null;
  const reservation = await entityGet<HostedPreviewReservation>(getReservationKey(accountId, sessionId));
  if (!reservation || reservation.month !== getCurrentMonthKey()) return null;
  return reservation;
}

async function reserveHostedPreviewCredit(
  accountId: string,
  sessionId: string | undefined,
  profile: PipelineProfile,
  remaining: PreviewUsageCredits,
): Promise<HostedPreviewReservation | null> {
  if (!sessionId) return null;
  const existing = await getReservation(accountId, sessionId);
  if (existing) return existing;
  if (remaining[profile] <= 0) return null;

  const reservation: HostedPreviewReservation = {
    month: getCurrentMonthKey(),
    profile,
    accountId,
    createdAt: new Date().toISOString(),
  };
  await entitySet(getReservationKey(accountId, sessionId), reservation);
  return reservation;
}

async function releaseHostedPreviewReservation(accountId: string, sessionId?: string): Promise<void> {
  if (!sessionId) return;
  await entityDelete(getReservationKey(accountId, sessionId));
}

function buildHostedSamplerReason(
  profile: PipelineProfile,
  remaining: PreviewUsageCredits,
): string | undefined {
  if (remaining[profile] > 1) return undefined;
  if (remaining[profile] === 1) {
    return `This is your last free ${profile} preview generation this month. You still have ${remaining.fast} fast, ${remaining.balanced} balanced, and ${remaining.quality} quality preview runs before you need to connect an API key.`;
  }
  const alternatives: string[] = [];
  if (remaining.fast > 0) alternatives.push(`fast (${remaining.fast})`);
  if (remaining.balanced > 0) alternatives.push(`balanced (${remaining.balanced})`);
  if (remaining.quality > 0) alternatives.push(`quality (${remaining.quality})`);
  if (alternatives.length) {
    return `No free ${profile} preview runs remain this month. You still have ${alternatives.join(', ')} available, or you can connect your own API key.`;
  }
  return 'You have used all free preview generations for this month. Connect your own API key in Settings to continue generating.';
}

function buildWarningState(
  credentialMode: GenerationCredentialMode,
  remaining: PreviewUsageCredits,
): UsageWarningState {
  if (credentialMode === 'byok') return 'none';
  const totalRemaining = sumPreviewCredits(remaining);
  if (totalRemaining <= 0) return 'preview_exhausted';
  if (totalRemaining === 1) return 'last_preview_credit';
  return 'none';
}

function buildGenerationAccessState(
  credentialMode: GenerationCredentialMode,
  profile: PipelineProfile,
  remaining: PreviewUsageCredits,
): GenerationAccessState {
  if (credentialMode === 'byok') return 'allowed_byok';
  if (remaining[profile] > 0) return 'preview_available';
  if (sumPreviewCredits(remaining) > 0) return 'profile_preview_exhausted';
  return 'preview_exhausted_requires_api_key';
}

export async function checkGenerationAllowed(
  config: TenantConfig,
  context?: any,
  options?: { sessionId?: string; profile?: PipelineProfile; reserveHostedPreview?: boolean },
): Promise<{ allowed: boolean; reason?: string; warningState?: UsageWarningState; generationAccessState?: GenerationAccessState }> {
  const credentialMode = getGenerationCredentialMode(config);
  const profile = options?.profile ?? config.generatorConfig?.pipelineProfile ?? 'balanced';
  const accountId = getAccountId(context);

  if (credentialMode === 'hosted_sampler') {
    const usage = await getHostedPreviewUsage(accountId);
    const remaining = subtractPreviewCredits(HOSTED_PREVIEW_CREDITS, usage.consumed);
    const reservation = await getReservation(accountId, options?.sessionId);
    const effectiveRemaining = reservation
      ? { ...remaining, [reservation.profile]: remaining[reservation.profile] + 1 }
      : remaining;

    const generationAccessState = buildGenerationAccessState(credentialMode, profile, effectiveRemaining);
    const warningState = buildWarningState(credentialMode, effectiveRemaining);

    if (generationAccessState === 'profile_preview_exhausted' || generationAccessState === 'preview_exhausted_requires_api_key') {
      return {
        allowed: false,
        reason: buildHostedSamplerReason(profile, effectiveRemaining),
        warningState,
        generationAccessState,
      };
    }

    if (options?.reserveHostedPreview && options.sessionId && !reservation) {
      await reserveHostedPreviewCredit(accountId, options.sessionId, profile, effectiveRemaining);
    }

    return {
      allowed: true,
      reason: buildHostedSamplerReason(profile, effectiveRemaining),
      warningState,
      generationAccessState,
    };
  }

  const effectiveTier = getEffectiveTier(config, context);
  const limits = getLimits(effectiveTier);
  if (limits.generationsPerMonth === -1) {
    return {
      allowed: true,
      warningState: 'none',
      generationAccessState: 'allowed_byok',
    };
  }

  const usage = await getUsageRecordForMode('byok', accountId);
  if (usage.generations >= limits.generationsPerMonth) {
    return {
      allowed: true,
      reason: `You have used the ${limits.generationsPerMonth} generations included with the Standard plan this month. Generation is still available, and usage will continue through your connected API key.`,
      warningState: 'none',
      generationAccessState: 'allowed_byok',
    };
  }

  return {
    allowed: true,
    warningState: 'none',
    generationAccessState: 'allowed_byok',
  };
}

export async function recordGeneration(
  config: TenantConfig,
  accountId: string,
  sessionId?: string,
): Promise<{ usageSource: 'platform_free_credit' | 'user_api_key'; freeCreditConsumed: boolean }> {
  const credentialMode = getGenerationCredentialMode(config);
  const currentMonth = getCurrentMonthKey();

  if (credentialMode === 'hosted_sampler') {
    const reservation = await getReservation(accountId, sessionId);
    const profile = reservation?.profile ?? config.generatorConfig?.pipelineProfile ?? 'balanced';
    const usage = await getHostedPreviewUsage(accountId);
    const nextUsage: HostedPreviewUsageRecord = {
      month: currentMonth,
      consumed: addConsumedCredit(usage.consumed, profile),
    };
    await setHostedPreviewUsage(accountId, nextUsage);
    await releaseHostedPreviewReservation(accountId, sessionId);
    return { usageSource: 'platform_free_credit', freeCreditConsumed: true };
  }

  const usage = await getUsageRecordForMode('byok', accountId);
  usage.generations += 1;
  await entitySet(getByokUsageKey(accountId), {
    month: usage.month,
    generations: usage.generations,
  });
  return { usageSource: 'user_api_key', freeCreditConsumed: false };
}

export async function releaseGenerationReservation(
  config: TenantConfig,
  accountId: string,
  sessionId?: string,
): Promise<void> {
  if (getGenerationCredentialMode(config) !== 'hosted_sampler') return;
  await releaseHostedPreviewReservation(accountId, sessionId);
}

export async function getUsage(config?: TenantConfig, context?: any): Promise<GenerationUsageSnapshot> {
  const accountId = getAccountId(context);
  const credentialMode = config ? getGenerationCredentialMode(config) : 'byok';
  const currentMonth = getCurrentMonthKey();
  const resetAt = getNextMonthIso(currentMonth);

  if (credentialMode === 'hosted_sampler') {
    const usage = await getHostedPreviewUsage(accountId);
    const remaining = subtractPreviewCredits(HOSTED_PREVIEW_CREDITS, usage.consumed);
    const generations = sumPreviewCredits(usage.consumed);
    return {
      month: usage.month,
      generations,
      credentialMode,
      quotaScope: 'user',
      resetCadence: 'calendar_month',
      remainingFastCredits: remaining.fast,
      remainingBalancedCredits: remaining.balanced,
      remainingQualityCredits: remaining.quality,
      resetAt,
      hasUserApiKey: false,
      generationAccessState: sumPreviewCredits(remaining) > 0 ? 'preview_available' : 'preview_exhausted_requires_api_key',
      warningState: buildWarningState(credentialMode, remaining),
    };
  }

  const usage = await getUsageRecordForMode('byok', accountId);
  return {
    ...usage,
    credentialMode,
    quotaScope: 'user',
    resetCadence: 'calendar_month',
    remainingFastCredits: 0,
    remainingBalancedCredits: 0,
    remainingQualityCredits: 0,
    resetAt,
    hasUserApiKey: true,
    generationAccessState: 'allowed_byok',
    warningState: 'none',
  };
}

export function getUsageLimits(config: TenantConfig, context?: any): TierLimits {
  const effectiveTier = getEffectiveTier(config, context);
  const baseLimits = getLimits(effectiveTier);
  return getGenerationCredentialMode(config) === 'hosted_sampler'
    ? getHostedPreviewLimits(baseLimits)
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
