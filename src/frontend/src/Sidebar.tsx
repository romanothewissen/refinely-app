import React from 'react';
import { UploadCloud, Paperclip, ChevronDown, Plus, MessageSquare, Pin, Clock, Settings, PanelLeftClose, Zap, X } from 'lucide-react';
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
  width
}: SidebarProps) {
  const isAtLimit = (limits?.generationsPerMonth !== -1 && usage && limits && usage.currentMonth >= limits.generationsPerMonth) || false;
  const brainstormDisabled = !requirement.trim() || isWorking || isAtLimit;
  const [showUsage, setShowUsage] = React.useState(true);

  return (
    <aside 
      className="h-full flex flex-col bg-white border-r border-slate-200 shadow-sm shrink-0 overflow-hidden"
      style={{ width: width ?? 380 }}
    >
      {/* Header */}
      <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
        <h1 className="font-semibold text-slate-800 text-lg tracking-tight hover:text-blue-600 transition-colors cursor-pointer" onClick={() => setViewMode('generate')}>
          Feature Assistant <span className="text-blue-600 text-[10px] ml-1 px-1.5 py-0.5 bg-blue-50 rounded-full align-top font-bold uppercase">v2.0</span>
        </h1>
        <div className="flex items-center gap-1">
          {isAdmin && (
            <button 
              onClick={() => setViewMode('settings')}
              className={`p-1.5 rounded-lg transition-colors ${viewMode === 'settings' ? 'bg-blue-50 text-blue-600' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'}`}
              title="Settings"
            >
              <Settings className="w-4 h-4" />
            </button>
          )}
          <button 
            onClick={onToggleSidebar}
            className="p-1.5 rounded-lg transition-colors text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            title="Collapse Sidebar"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto w-full p-6 space-y-5 no-scrollbar">
        {/* Mode Toggle removed as requested */}

        {/* Input Scope */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 flex flex-col space-y-2 min-h-0">
            <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest pl-1">Requirement Scope</label>
            <div className="flex-1 min-h-[250px] relative border border-slate-200 bg-slate-50 rounded-xl focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500 transition-all p-4 shadow-inner flex flex-col">
              <textarea
                value={requirement}
                onChange={(e) => setRequirement(e.target.value)}
                placeholder="Describe your feature requirement in detail... e.g. 'As a user, I want to be able to reset my password using an email link...'"
                disabled={isWorking}
                className="flex-1 w-full bg-transparent border-none text-slate-700 placeholder-slate-400 focus:outline-none text-[15px] leading-relaxed resize-none disabled:opacity-50"
              />
              <div className="pt-3 flex justify-between items-center border-t border-slate-200/60 mt-2 shrink-0">
                <button title="Attach doc (PDF/TXT)" className="flex items-center gap-1.5 px-2 py-1 text-slate-400 hover:bg-white hover:text-blue-600 rounded-lg transition-colors text-xs font-medium">
                  <Paperclip className="w-3.5 h-3.5" />
                  <span>Attach Context</span>
                </button>
                <div className="text-[10px] text-slate-300 font-medium">Rich text supported</div>
              </div>
            </div>
          </div>
        </div>

        {/* Action Area */}
        <div className="space-y-3 pt-2">
          <button
            onClick={onStartBrainstorm}
            disabled={brainstormDisabled}
            title={isAtLimit ? 'Monthly generation limit reached.' : ''}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold py-3.5 rounded-xl shadow-[0_8px_20px_-6px_rgba(37,99,235,0.4)] transition-all active:scale-[0.98] flex items-center justify-center gap-2 group"
          >
            {isWorking ? (
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                <span>Working...</span>
              </div>
            ) : (
              <>
                <Zap className={`w-4 h-4 ${requirement.trim() ? 'fill-white' : ''}`} />
                <span>{isAtLimit ? 'Limit Reached' : 'Start Brainstorm'}</span>
              </>
            )}
          </button>
          
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={onNewSession}
              className="px-3 py-2.5 bg-white hover:bg-slate-50 text-slate-600 border border-slate-200 text-[11px] font-bold uppercase tracking-wider rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              <Plus className="w-3.5 h-3.5" />
              New
            </button>
            <button
              onClick={onOpenHistory}
              className="px-3 py-2.5 bg-white hover:bg-slate-50 text-slate-600 border border-slate-200 text-[11px] font-bold uppercase tracking-wider rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              History
            </button>
          </div>
        </div>
      </div>

      {/* Footer / Usage Meter */}
      {showUsage && (
        <div className="p-6 border-t border-slate-100 bg-slate-50/50 relative group">
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
