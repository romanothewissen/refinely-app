import React from 'react';
import { Zap, TrendingUp, ShieldCheck, AlertCircle, ExternalLink } from 'lucide-react';

interface UsageMeterProps {
  usage: { currentMonth: number } | null;
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

  const tierName = tier.charAt(0) ? tier.charAt(0).toUpperCase() + tier.slice(1) : 'Free';

  if (isCompact) {
    return (
      <div className={`flex items-center gap-2.5 px-2.5 py-1.5 bg-[var(--rf-bg)] rounded-md border border-[var(--rf-border)] ${className}`}>
        <div className="flex items-center gap-1.5">
          <Zap className={`w-3 h-3 ${isAtLimit ? 'text-[var(--rf-danger)]' : 'text-[var(--rf-brand)]'}`} />
          <span className="text-[10px] font-semibold text-[var(--rf-text-secondary)] uppercase tracking-wide">{tierName}</span>
        </div>
        {!isUnlimited && (
          <div className="flex items-center gap-2">
            <div className="w-14 h-1.5 bg-[var(--rf-border-subtle)] rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 rounded-full ${isAtLimit ? 'bg-[var(--rf-danger)]' : isNearLimit ? 'bg-[var(--rf-warning)]' : 'bg-[var(--rf-brand)]'}`}
                style={{ width: `${percentage}%` }}
              />
            </div>
            <span className="text-[10px] font-medium text-[var(--rf-text-secondary)] font-mono">
              {current}/{max}
            </span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`space-y-2.5 ${className}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`p-1 rounded ${(tier === 'premium' || tier === 'enterprise') ? 'bg-purple-100 text-purple-600' : tier === 'standard' ? 'bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)]' : 'bg-[var(--rf-bg)] text-[var(--rf-text-secondary)]'}`}>
            {(tier === 'premium' || tier === 'enterprise') ? <ShieldCheck className="w-3.5 h-3.5" /> : <TrendingUp className="w-3.5 h-3.5" />}
          </div>
          <div>
            <h4 className="text-xs font-semibold text-[var(--rf-text)] leading-tight">{tierName} Plan</h4>
            <p className="text-[10px] text-[var(--rf-text-tertiary)]">Current Usage</p>
          </div>
        </div>
        {isAtLimit && <AlertCircle className="w-3.5 h-3.5 text-[var(--rf-danger)]" />}
      </div>

      <div className="space-y-1.5">
        <div className="flex justify-between items-end">
          <span className="text-[11px] text-[var(--rf-text-secondary)]">Generations</span>
          <span className="text-[11px] font-semibold text-[var(--rf-text)]">
            {current} <span className="text-[var(--rf-text-tertiary)] font-normal">/ {isUnlimited ? '\u221e' : max}</span>
          </span>
        </div>
        {!isUnlimited && (
          <div className="w-full h-1.5 bg-[var(--rf-border-subtle)] rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-500 rounded-full ${
                isAtLimit ? 'bg-[var(--rf-danger)]' :
                isNearLimit ? 'bg-[var(--rf-warning)]' :
                'bg-[var(--rf-brand)]'
              }`}
              style={{ width: `${percentage}%` }}
            />
          </div>
        )}
      </div>

      {tier === 'free' && (
        <a
          href="https://marketplace.atlassian.com"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-1.5 w-full py-1.5 bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)] rounded-md text-[10px] font-semibold hover:bg-blue-100 transition-colors border border-blue-200"
        >
          UPGRADE TO REMOVE LIMITS
          <ExternalLink className="w-2.5 h-2.5" />
        </a>
      )}
    </div>
  );
}
