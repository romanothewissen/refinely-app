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
      <div className={`flex items-center gap-3 px-3 py-1.5 bg-slate-100/50 rounded-full border border-slate-200/50 ${className}`}>
        <div className="flex items-center gap-1.5">
          <Zap className={`w-3 h-3 ${isAtLimit ? 'text-red-500' : 'text-blue-500'}`} />
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">{tierName} Plan</span>
        </div>
        {!isUnlimited && (
          <div className="flex items-center gap-2">
            <div className="w-16 h-1.5 bg-slate-200 rounded-full overflow-hidden">
              <div 
                className={`h-full transition-all duration-500 ${isAtLimit ? 'bg-red-500' : isNearLimit ? 'bg-amber-500' : 'bg-blue-600'}`}
                style={{ width: `${percentage}%` }}
              />
            </div>
            <span className="text-[10px] font-medium text-slate-600 font-mono">
              {current}/{max}
            </span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`p-4 bg-white border border-slate-200 rounded-xl shadow-sm space-y-3 ${className}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`p-1.5 rounded-lg ${tier === 'premium' ? 'bg-purple-100 text-purple-600' : tier === 'standard' ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-600'}`}>
            {tier === 'premium' ? <ShieldCheck className="w-4 h-4" /> : <TrendingUp className="w-4 h-4" />}
          </div>
          <div>
            <h4 className="text-sm font-bold text-slate-800 leading-tight">{tierName} Plan</h4>
            <p className="text-[10px] text-slate-500 uppercase tracking-widest font-semibold mt-0.5">Current Usage</p>
          </div>
        </div>
        {isAtLimit && <AlertCircle className="w-4 h-4 text-red-500" />}
      </div>

      <div className="space-y-1.5">
        <div className="flex justify-between items-end">
          <span className="text-xs font-medium text-slate-600">Generations Used</span>
          <span className="text-xs font-bold text-slate-800">
            {current} <span className="text-slate-400 font-normal">/ {isUnlimited ? '∞' : max}</span>
          </span>
        </div>
        {!isUnlimited && (
          <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden border border-slate-50 shadow-inner">
            <div 
              className={`h-full transition-all duration-700 ease-out shadow-sm ${
                isAtLimit ? 'bg-gradient-to-r from-red-500 to-rose-600' : 
                isNearLimit ? 'bg-gradient-to-r from-amber-400 to-orange-500' : 
                'bg-gradient-to-r from-blue-500 to-indigo-600'
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
          className="flex items-center justify-center gap-1.5 w-full py-1.5 bg-blue-50 text-blue-600 rounded-lg text-[10px] font-bold hover:bg-blue-100 transition-colors"
        >
          UPGRADE TO REMOVE LIMITS
          <ExternalLink className="w-2.5 h-2.5" />
        </a>
      )}
    </div>
  );
}
