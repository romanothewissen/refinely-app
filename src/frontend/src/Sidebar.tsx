import React from 'react';
import { Paperclip, Plus, Clock, Settings, PanelLeftClose, Zap, X } from 'lucide-react';
import { UsageMeter } from './UsageMeter';

interface SidebarProps {
  viewMode: 'generate' | 'settings';
  setViewMode: (mode: 'generate' | 'settings') => void;
  requirement: string;
  setRequirement: (val: string) => void;
  onStartBrainstorm: () => void;
  onNewSession: () => void;
  conversations: any[];
  currentSessionId: string;
  onRestoreSession: (sessionId: string) => void;
  isWorking: boolean;
  onToggleSidebar: () => void;
  onOpenHistory: () => void;
  isAdmin?: boolean;
  tier: string;
  usage: { currentMonth: number } | null;
  limits: { generationsPerMonth: number } | null;
  width?: number;
  originIssueKey?: string | null;
}

export function Sidebar({
  viewMode,
  setViewMode,
  requirement,
  setRequirement,
  onStartBrainstorm,
  onNewSession,
  conversations,
  currentSessionId,
  onRestoreSession,
  isWorking,
  onToggleSidebar,
  onOpenHistory,
  isAdmin,
  tier,
  usage,
  limits,
  width,
  originIssueKey
}: SidebarProps) {
  const isAtLimit = (limits?.generationsPerMonth !== -1 && usage && limits && usage.currentMonth >= limits.generationsPerMonth) || false;
  const brainstormDisabled = !requirement.trim() || isWorking || isAtLimit;
  const [showUsage, setShowUsage] = React.useState(true);

  return (
    <aside 
      className="rf-glass-strong h-full flex flex-col shrink-0 overflow-hidden rounded-r-[24px] border-r border-white/60"
      style={{ width: width ?? 380 }}
    >
      {/* Header */}
      <div className="px-6 py-5 border-b border-slate-200/70 bg-white/55 flex items-center justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-semibold text-slate-900 text-lg tracking-tight hover:text-blue-700 transition-colors cursor-pointer" onClick={() => setViewMode('generate')}>
              Refinely
            </h1>
            <span className="rf-chip text-blue-700 text-[10px] px-2 py-0.5 rounded-full align-top font-bold uppercase tracking-[0.16em]">Forge</span>
          </div>
          <p className="mt-1 text-[11px] text-slate-500 font-medium">
            Requirement-to-backlog workspace
          </p>
        </div>
        <div className="flex items-center gap-1">
          {isAdmin && (
            <button 
              onClick={() => setViewMode('settings')}
              className={`p-2 rounded-xl transition-colors ${viewMode === 'settings' ? 'bg-blue-50 text-blue-700 border border-blue-100' : 'text-slate-400 hover:bg-white hover:text-slate-700 border border-transparent'}`}
              title="Settings"
            >
              <Settings className="w-4 h-4" />
            </button>
          )}
          <button 
            onClick={onToggleSidebar}
            className="p-2 rounded-xl transition-colors text-slate-400 hover:bg-white hover:text-slate-700 border border-transparent"
            title="Collapse Sidebar"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col w-full p-5 gap-4">
        {/* Mode Toggle removed as requested */}

        {/* Input Scope */}
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-[0.22em] pl-0.5">Requirement Scope</label>
              <p className="mt-1 text-xs text-slate-500">Describe the outcome, constraints, edge cases, and business context.</p>
            </div>
            <div className="text-[10px] text-slate-400 font-semibold uppercase tracking-[0.16em]">
              {originIssueKey ? `From ${originIssueKey}` : 'New brief'}
            </div>
          </div>
          <div className="flex-1 min-h-0 relative rounded-[20px] border border-slate-200 bg-white focus-within:ring-2 focus-within:ring-blue-500/15 focus-within:border-blue-500/40 transition-all px-4 py-4 shadow-inner flex flex-col">
            <textarea
              value={requirement}
              onChange={(e) => setRequirement(e.target.value)}
              placeholder="Describe your feature requirement in detail... e.g. 'As a user, I want to be able to reset my password using an email link...'"
              disabled={isWorking}
              className="flex-1 min-h-[360px] w-full bg-transparent border-none text-slate-800 placeholder-slate-400 focus:outline-none text-[15px] leading-relaxed resize-none disabled:opacity-50"
            />
            <div className="pt-3 flex justify-between items-center border-t border-slate-200/70 mt-3 shrink-0">
              <button title="Attach doc (PDF/TXT)" className="flex items-center gap-1.5 px-2.5 py-1.5 text-slate-500 hover:bg-slate-50 hover:text-blue-700 rounded-xl transition-colors text-xs font-medium">
                <Paperclip className="w-3.5 h-3.5" />
                <span>Attach Context</span>
              </button>
              <div className="text-[10px] text-slate-400 font-medium">{requirement.trim().split(/\s+/).filter(Boolean).length} words</div>
            </div>
          </div>
        </div>

        {/* Action Area */}
        <div className="space-y-3 shrink-0">
          <button
            onClick={onStartBrainstorm}
            disabled={brainstormDisabled}
            title={isAtLimit ? 'Monthly generation limit reached.' : ''}
            className="rf-button-primary w-full disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold py-4 rounded-[20px] transition-all active:scale-[0.985] flex items-center justify-center gap-2 group"
          >
            {isWorking ? (
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                <span>Working...</span>
              </div>
            ) : (
              <>
                <Zap className={`w-4 h-4 ${requirement.trim() ? 'fill-white' : ''}`} />
                <span>{isAtLimit ? 'Limit Reached' : originIssueKey ? 'Create Backlog' : 'Start Brainstorm'}</span>
              </>
            )}
          </button>
          
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={onNewSession}
              className="bg-white border border-slate-200 rounded-2xl px-3 py-3 text-slate-700 text-[11px] font-bold uppercase tracking-[0.12em] transition-all hover:bg-slate-50 flex items-center justify-center gap-2"
            >
              <Plus className="w-3.5 h-3.5" />
              New
            </button>
            <button
              onClick={onOpenHistory}
              className="bg-white border border-slate-200 rounded-2xl px-3 py-3 text-slate-700 text-[11px] font-bold uppercase tracking-[0.12em] transition-all hover:bg-slate-50 flex items-center justify-center gap-2"
            >
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              History
            </button>
          </div>
        </div>
      </div>

      {/* Footer / Usage Meter */}
      {showUsage && (
        <div className="px-5 py-4 border-t border-slate-200/70 bg-white/30 relative group shrink-0">
          <button 
            onClick={() => setShowUsage(false)}
            className="absolute top-2 right-2 p-1.5 rounded-full text-slate-300 hover:text-slate-500 hover:bg-slate-200 opacity-0 group-hover:opacity-100 transition-all z-20"
            title="Dismiss until next session"
          >
            <X className="w-3.5 h-3.5" />
            <span className="sr-only">Hide</span>
          </button>
          <UsageMeter usage={usage} limits={limits} tier={tier} />
        </div>
      )}
    </aside>
  );
}
