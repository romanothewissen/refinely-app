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
      <div className={`flex items-center gap-2.5 px-3 py-2 bg-[var(--rf-text)]/50 rounded-xl border border-slate-700 ${className}`}>
        <div className="flex items-center gap-2">
          <Zap className={`w-3.5 h-3.5 ${isAtLimit ? 'text-rose-500' : 'text-[var(--rf-brand)]'}`} />
          <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">{tierName}</span>
        </div>
        {!isUnlimited && (
          <div className="flex items-center gap-2.5">
            <div className="w-16 h-1.5 bg-[var(--rf-text)] rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 rounded-full ${isAtLimit ? 'bg-[var(--rf-danger)]' : isNearLimit ? 'bg-amber-500' : 'bg-[var(--rf-brand)]'}`}
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
          <div className={`p-1.5 rounded-lg shadow-sm ${(tier === 'premium' || tier === 'enterprise') ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20' : tier === 'standard' ? 'bg-[var(--rf-brand)]/10 text-blue-400 border border-[var(--rf-brand)]/20' : 'bg-white/5 text-[var(--rf-text-tertiary)] border border-white/10'}`}>
            {(tier === 'premium' || tier === 'enterprise') ? <ShieldCheck className="w-4 h-4" /> : <TrendingUp className="w-4 h-4" />}
          </div>
          <div>
            <h4 className="text-[13px] font-bold text-white tracking-tight">{tierName} Plan</h4>
            <p className="text-[10px] font-medium text-[var(--rf-sidebar-text-muted)] uppercase tracking-widest mt-0.5">Current Usage</p>
          </div>
        </div>
        {isAtLimit && <AlertCircle className="w-4 h-4 text-rose-500" />}
      </div>

      <div className="space-y-2">
        <div className="flex justify-between items-end">
          <span className="text-[11px] font-semibold text-[var(--rf-text-tertiary)]">Generations</span>
          <span className="text-sm font-bold text-white tracking-tight">
            {current} <span className="text-[var(--rf-text-tertiary)] font-medium text-[11px] ml-1">/ {isUnlimited ? '\u221e' : max}</span>
          </span>
        </div>
        {!isUnlimited && (
          <div className="w-full h-2 bg-[var(--rf-text)] rounded-full overflow-hidden shadow-inner">
            <div
              className={`h-full transition-all duration-500 rounded-full ${
                isAtLimit ? 'bg-[var(--rf-danger)] shadow-[0_0_10px_rgba(244,63,94,0.5)]' :
                isNearLimit ? 'bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.5)]' :
                'bg-[var(--rf-brand)] shadow-[0_0_10px_rgba(59,130,246,0.5)]'
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
          className="flex items-center justify-center gap-2 w-full py-2.5 bg-[var(--rf-brand)]/10 text-blue-400 rounded-xl text-[11px] font-bold uppercase tracking-wider hover:bg-[var(--rf-brand)]/20 transition-colors border border-[var(--rf-brand)]/20"
        >
          Upgrade for More
          <ExternalLink className="w-3 h-3" />
        </a>
      )}
    </div>
  );
}
