import React from 'react';
import { Zap, TrendingUp, AlertCircle, ExternalLink } from 'lucide-react';

type UsageSnapshot = {
  currentMonth: number;
  credentialMode?: 'byok' | 'hosted_sampler';
  quotaScope?: 'tenant' | 'user';
  resetCadence?: 'calendar_month';
  remainingFastCredits?: number;
  remainingBalancedCredits?: number;
  remainingQualityCredits?: number;
} | null;

interface UsageMeterProps {
  usage: UsageSnapshot;
  limits: { generationsPerMonth: number } | null;
  tier: string;
  isCompact?: boolean;
  className?: string;
}

export function UsageMeter({ usage, limits, tier, isCompact = false, className = '' }: UsageMeterProps) {
  if (!usage || !limits) return null;

  const current = usage.currentMonth;
  const max = limits.generationsPerMonth;
  const isUnlimited = max === -1;
  const percentage = isUnlimited ? 0 : Math.min(100, (current / max) * 100);
  const isNearLimit = !isUnlimited && percentage >= 80;
  const isAtLimit = !isUnlimited && current >= max;
  const isHostedSampler = usage?.credentialMode === 'hosted_sampler';

  const tierName = isHostedSampler
    ? 'Free Preview'
    : (tier.charAt(0) ? tier.charAt(0).toUpperCase() + tier.slice(1) : 'Standard');
  const previewBreakdown = isHostedSampler
    ? `${usage?.remainingFastCredits ?? 0}F / ${usage?.remainingBalancedCredits ?? 0}B / ${usage?.remainingQualityCredits ?? 0}Q left`
    : null;

  if (isCompact) {
    const remaining = isUnlimited ? null : Math.max(0, max - current);
    return (
      <div className={`flex items-center gap-3 ${className}`}>
        <div className="flex min-w-0 items-center gap-2">
          <div className={`flex h-7 w-7 items-center justify-center rounded-xl border ${isAtLimit ? 'border-[var(--rf-warning)]/30 bg-[var(--rf-warning-subtle)] text-[var(--rf-warning)]' : 'border-[var(--rf-border)] bg-white/75 text-[var(--rf-brand)]'}`}>
            <Zap className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <div className="text-[10px] font-bold text-[var(--rf-text-secondary)] uppercase tracking-widest">{tierName} usage</div>
            <div className="text-[12px] font-semibold text-[var(--rf-text-tertiary)]">
              {isUnlimited
                ? 'Unlimited plan'
                : isHostedSampler
                  ? previewBreakdown ?? `${remaining} preview generations left`
                  : `${remaining} included before warning`}
            </div>
          </div>
        </div>
        {!isUnlimited && (
          <div className="ml-auto flex min-w-[110px] items-center gap-2.5">
            <div className="flex-1 h-1.5 bg-white/70 rounded-full overflow-hidden border border-[rgba(0,0,0,0.04)]">
              <div
                className={`h-full transition-all duration-500 rounded-full ${isAtLimit ? 'bg-[var(--rf-warning)]' : isNearLimit ? 'bg-[var(--rf-warning)]' : 'bg-[var(--rf-brand)]'}`}
                style={{ width: `${percentage}%` }}
              />
            </div>
            <span className="text-[10px] font-bold text-[var(--rf-text-tertiary)] font-mono tracking-wider">
              {current}/{max}
            </span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`space-y-4 ${className}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`p-1.5 rounded-lg ${tier === 'standard' ? 'bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)] border border-[var(--rf-border)]' : 'bg-white/60 text-[var(--rf-text-tertiary)] border border-[var(--rf-border)]'}`}>
            <TrendingUp className="w-4 h-4" />
          </div>
          <div>
            <h4 className="text-[13px] font-bold text-[var(--rf-text)] tracking-tight">{tierName} Plan</h4>
            <p className="text-[10px] font-medium text-[var(--rf-sidebar-text-muted)] uppercase tracking-widest mt-0.5">Current Usage</p>
          </div>
        </div>
        {isAtLimit && <AlertCircle className="w-4 h-4 text-[var(--rf-warning)]" />}
      </div>

      <div className="space-y-2">
        <div className="flex justify-between items-end">
          <span className="text-[11px] font-semibold text-[var(--rf-text-tertiary)]">
            {isHostedSampler ? 'Hosted trial generations' : 'Included generations'}
          </span>
          <span className="text-sm font-bold text-[var(--rf-brand)] tracking-tight">
            {current} <span className="text-[var(--rf-text-tertiary)] font-medium text-[11px] ml-1">/ {isUnlimited ? '∞' : max}</span>
          </span>
        </div>
        {!isUnlimited && (
          <div className="w-full h-2 bg-white/60 border border-[rgba(0,0,0,0.04)] rounded-full overflow-hidden shadow-inner">
            <div
              className={`h-full transition-all duration-500 rounded-full ${
                isAtLimit ? 'bg-[var(--rf-warning)] shadow-[0_0_8px_rgba(179,94,48,0.2)]' :
                isNearLimit ? 'bg-[var(--rf-warning)] shadow-[0_0_8px_rgba(179,94,48,0.2)]' :
                'bg-[var(--rf-brand)] shadow-[0_0_8px_rgba(43,89,74,0.2)]'
              }`}
              style={{ width: `${percentage}%` }}
            />
          </div>
        )}
        {isAtLimit && (
          <p className="text-[11px] font-medium text-[var(--rf-warning)]">
            {isHostedSampler
              ? 'Free preview credits are exhausted for this month. Connect your own key in Settings to continue generating.'
              : 'Included monthly usage guidance reached. Generation remains available while you coordinate a higher soft threshold with support.'}
          </p>
        )}
      </div>

      {!isUnlimited && !isHostedSampler && (
        <a
          href="mailto:support@smartif.ai?subject=Refinely%20higher%20limits"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 w-full py-2.5 bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)] rounded-xl text-[11px] font-bold uppercase tracking-wider hover:bg-[var(--rf-brand)]/15 transition-colors border border-[var(--rf-border)]"
        >
          Need Higher Limits?
          <ExternalLink className="w-3 h-3" />
        </a>
      )}
    </div>
  );
}
