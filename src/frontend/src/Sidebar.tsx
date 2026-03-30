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
  projectKey: string;
  setProjectKey: (key: string) => void;
  availableProjects: Array<{ key: string; name: string }>;
  goldSources: Array<{ key: string; targetProjects?: string[]; project?: string; issuetype?: string; statuses?: string[]; status?: string }>;
  wiDocs: Array<{ docId: string; filename: string; chunkCount: number; targetProjects?: string[] }>;
  onOpenProjectSettings: (tab: 'models' | 'jira' | 'domain' | 'billing', projectKey: string) => void;
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
  originIssueKey,
  projectKey,
  setProjectKey,
  availableProjects,
  goldSources,
  wiDocs,
  onOpenProjectSettings
}: SidebarProps) {
  const isAtLimit = (limits?.generationsPerMonth !== -1 && usage && limits && usage.currentMonth >= limits.generationsPerMonth) || false;
  const hasUnlimitedUsage = limits?.generationsPerMonth === -1;
  const brainstormDisabled = !requirement.trim() || isWorking || isAtLimit;
  const [showUsage, setShowUsage] = React.useState(true);
  const wordCount = requirement.trim().split(/\s+/).filter(Boolean).length;
  const activeGoldSources = goldSources.filter(source => (source.targetProjects ?? []).includes(projectKey));
  const matchedConnectorLabel = projectKey === '*'
    ? 'Pick a project to validate gold connectors'
    : activeGoldSources.length > 0
      ? `${activeGoldSources.length} active golden-example connector${activeGoldSources.length !== 1 ? 's' : ''}`
      : 'No golden-example connector is active for this project';
  const activeWiDocs = wiDocs.filter(doc => (doc.targetProjects ?? ['*']).includes('*') || (doc.targetProjects ?? []).includes(projectKey));

  return (
    <aside 
      className="rf-glass-strong h-full flex flex-col shrink-0 overflow-hidden rounded-r-[24px] border-r border-white/70 bg-white/92"
      style={{ width: width ?? 380 }}
    >
      {/* Header */}
      <div className="relative px-6 py-5 border-b border-slate-200/70 bg-white/72 flex items-center justify-between">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-blue-300/50 to-transparent" />
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

      <div className="flex-1 min-h-0 flex flex-col w-full px-5 py-5 gap-4 overflow-y-auto no-scrollbar">
        <div className="shrink-0 flex items-start justify-between gap-3">
          <div>
            <label className="text-[11px] font-bold text-slate-400 uppercase tracking-[0.22em] pl-0.5">Requirement Scope</label>
            <p className="mt-1 text-xs text-slate-500 max-w-[26ch]">Describe the outcome, constraints, edge cases, and business context.</p>
          </div>
          <div className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500 shadow-sm">
            {originIssueKey ? `From ${originIssueKey}` : 'New brief'}
          </div>
        </div>

        <div className="rf-surface relative overflow-hidden rounded-[22px] border border-slate-200/80 bg-white/95 px-4 py-3 shadow-[0_14px_28px_-24px_rgba(15,23,42,0.24)]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Project scope</div>
              <div className="mt-1 text-sm font-semibold text-slate-800">
                {projectKey === '*'
                  ? 'Standalone workspace'
                  : `${projectKey}${availableProjects.find(p => p.key === projectKey)?.name ? ` • ${availableProjects.find(p => p.key === projectKey)?.name}` : ''}`}
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                Choose the Jira project whose golden examples and rules should be used.
              </p>
            </div>
            <select
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value)}
              className="shrink-0 min-w-[150px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] font-semibold text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/15"
            >
              <option value="*">No project selected</option>
              {availableProjects.map(project => (
                <option key={project.key} value={project.key}>
                  {project.key} - {project.name}
                </option>
              ))}
            </select>
          </div>
          {projectKey === '*' && availableProjects.length > 0 && (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
              Select a project to unlock project-scoped golden examples. Until then, generation runs in generic mode.
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => onOpenProjectSettings('jira', projectKey)}
          className="rf-surface relative overflow-hidden rounded-[22px] border border-slate-200/80 bg-white/95 px-4 py-3 shadow-[0_14px_28px_-24px_rgba(15,23,42,0.24)] text-left transition-all hover:border-blue-200 hover:shadow-[0_18px_36px_-26px_rgba(37,99,235,0.32)] focus:outline-none focus:ring-2 focus:ring-blue-500/15"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Connector health</div>
              <div className="mt-1 text-sm font-semibold text-slate-800">{matchedConnectorLabel}</div>
              <p className="mt-1 text-[11px] text-slate-500">
                This is what the generator will use for golden examples right now.
              </p>
            </div>
            <div className={`shrink-0 rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] border ${activeGoldSources.length > 0 ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
              {activeGoldSources.length > 0 ? 'Connected' : 'Not connected'}
            </div>
          </div>
          {activeGoldSources.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {activeGoldSources.slice(0, 4).map(source => (
                <span key={source.key} className="rf-chip inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium text-blue-700" title={`${source.project ?? 'Unknown project'} • ${source.issuetype ?? 'Unknown type'}`}>
                  {source.key}
                </span>
              ))}
            </div>
          )}
        </button>

        <button
          type="button"
          onClick={() => onOpenProjectSettings('domain', projectKey)}
          className="rf-surface relative overflow-hidden rounded-[22px] border border-slate-200/80 bg-white/95 px-4 py-3 shadow-[0_14px_28px_-24px_rgba(15,23,42,0.24)] text-left transition-all hover:border-blue-200 hover:shadow-[0_18px_36px_-26px_rgba(37,99,235,0.32)] focus:outline-none focus:ring-2 focus:ring-blue-500/15"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Work instructions</div>
              <div className="mt-1 text-sm font-semibold text-slate-800">
                {activeWiDocs.length > 0
                  ? `${activeWiDocs.length} reference document${activeWiDocs.length !== 1 ? 's' : ''} active`
                  : 'No reference documents active'}
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                These are the docs that can be pulled into the model for this project.
              </p>
            </div>
            <div className={`shrink-0 rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] border ${activeWiDocs.length > 0 ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>
              {activeWiDocs.length > 0 ? 'Ingested' : 'Empty'}
            </div>
          </div>
          {activeWiDocs.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {activeWiDocs.slice(0, 4).map(doc => (
                <span key={doc.docId} className="rf-chip inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium text-blue-700" title={`${doc.chunkCount} chunks`}>
                  {doc.filename}
                </span>
              ))}
            </div>
          )}
        </button>

        <div className="rf-surface relative overflow-hidden rounded-[24px] border border-slate-200/80 bg-white/96 px-4 py-4 shadow-[0_18px_40px_-28px_rgba(15,23,42,0.24)]">
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-blue-500 via-sky-400 to-cyan-300" />
          <textarea
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
            placeholder="Describe your feature requirement in detail... e.g. 'As a user, I want to be able to reset my password using an email link...'"
            disabled={isWorking}
            className="min-h-[260px] h-[clamp(260px,38vh,380px)] w-full bg-transparent border-none text-slate-800 placeholder-slate-400 focus:outline-none text-[15px] leading-relaxed resize-none disabled:opacity-50 pt-2 pb-3"
          />
          <div className="mt-2 flex items-center justify-between gap-3 border-t border-slate-200/80 pt-3">
            <button
              title="Attach doc (PDF/TXT)"
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
            >
              <Paperclip className="w-3.5 h-3.5" />
              <span>Attach Context</span>
            </button>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">{wordCount} words</div>
          </div>
        </div>

        <div className="shrink-0 space-y-3 pt-1 relative z-10">
          <button
            onClick={onStartBrainstorm}
            disabled={brainstormDisabled}
            title={isAtLimit ? 'Monthly generation limit reached.' : ''}
            className="rf-button-primary w-full disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold py-4 rounded-[20px] transition-all active:scale-[0.985] flex items-center justify-center gap-2 group shadow-[0_18px_36px_-18px_rgba(37,99,235,0.65)]"
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
          
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={onNewSession}
              className="bg-white border border-slate-200 rounded-2xl px-3 py-3 text-slate-700 text-[11px] font-bold uppercase tracking-[0.12em] transition-all hover:bg-slate-50 hover:border-blue-200 flex items-center justify-center gap-2 shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              New
            </button>
            <button
              onClick={onOpenHistory}
              className="bg-white border border-slate-200 rounded-2xl px-3 py-3 text-slate-700 text-[11px] font-bold uppercase tracking-[0.12em] transition-all hover:bg-slate-50 hover:border-blue-200 flex items-center justify-center gap-2 shadow-sm"
            >
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              History
            </button>
          </div>
        </div>
      </div>

      {/* Footer / Usage Meter */}
      {!hasUnlimitedUsage && showUsage && (
        <div className="px-5 pb-5 pt-0 shrink-0">
          <div className="relative rf-surface rounded-[22px] border border-slate-200/80 bg-white/94 p-4 shadow-[0_18px_40px_-28px_rgba(15,23,42,0.24)]">
            <button
              onClick={() => setShowUsage(false)}
              className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-800"
              title="Dismiss usage card"
              aria-label="Dismiss usage card"
            >
              <X className="w-4 h-4" />
            </button>
            <UsageMeter usage={usage} limits={limits} tier={tier} className="pr-10" />
          </div>
        </div>
      )}
    </aside>
  );
}
