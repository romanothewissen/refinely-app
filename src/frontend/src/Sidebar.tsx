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
  const availableProject = availableProjects.find(p => p.key === projectKey);
  const projectTitle = projectKey === '*'
    ? 'Standalone workspace'
    : `${projectKey}${availableProject?.name ? ` \u00b7 ${availableProject.name}` : ''}`;

  return (
    <aside
      className="rf-sidebar-surface h-full flex flex-col shrink-0 overflow-hidden border-r border-[rgba(183,197,214,0.72)]"
      style={{ width: width ?? 380 }}
    >
      {/* Header */}
      <div className="px-5 py-4 border-b border-[rgba(183,197,214,0.68)] bg-[rgba(255,255,255,0.72)] flex items-center justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1
              className="font-semibold text-[var(--rf-text)] text-[18px] tracking-[-0.03em] cursor-pointer hover:text-[var(--rf-brand)] transition-colors"
              onClick={() => setViewMode('generate')}
            >
              Refinely
            </h1>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-[0.16em] bg-[var(--rf-brand-muted)] text-[var(--rf-brand)] border border-[rgba(0,82,204,0.12)]">
              Forge
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-[var(--rf-text-tertiary)]">
            Requirement-to-backlog workspace
          </p>
        </div>
        <div className="flex items-center gap-1">
          {isAdmin && (
            <button
              onClick={() => setViewMode('settings')}
              className={`p-2.5 rounded-xl border transition-colors ${
                viewMode === 'settings'
                  ? 'bg-[var(--rf-brand-muted)] text-[var(--rf-brand)] border-[rgba(0,82,204,0.12)]'
                  : 'text-[var(--rf-text-tertiary)] bg-white/70 border-[rgba(183,197,214,0.7)] hover:bg-white hover:text-[var(--rf-text-secondary)]'
              }`}
              title="Settings"
            >
              <Settings className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={onToggleSidebar}
            className="p-2.5 rounded-xl border border-[rgba(183,197,214,0.7)] bg-white/70 transition-colors text-[var(--rf-text-tertiary)] hover:bg-white hover:text-[var(--rf-text-secondary)]"
            title="Collapse Sidebar"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col w-full px-4 py-4 gap-4 overflow-y-auto no-scrollbar">
        {/* Project context card */}
        <div className="rf-panel rounded-[24px] px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--rf-text-tertiary)]">Project Scope</div>
              <div className="mt-1 text-[15px] font-semibold text-[var(--rf-text)] truncate">{projectTitle}</div>
            </div>
            <select
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value)}
              className="rf-focus-ring shrink-0 min-w-[148px] rounded-xl border border-[rgba(183,197,214,0.72)] bg-[var(--rf-surface-soft)] px-3 py-2 text-[11px] font-medium text-[var(--rf-text)] outline-none"
            >
              <option value="*">No project selected</option>
              {availableProjects.map(project => (
                <option key={project.key} value={project.key}>
                  {project.key} - {project.name}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => onOpenProjectSettings('jira', projectKey)}
            className="rf-panel-soft rounded-[18px] px-3.5 py-3 text-left transition hover:-translate-y-[1px] hover:border-[var(--rf-border-strong)] focus:outline-none"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">Connector Health</div>
              <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide border ${activeGoldSources.length > 0 ? 'border-green-300 bg-[var(--rf-success-subtle)] text-[var(--rf-success)]' : 'border-amber-300 bg-[var(--rf-warning-subtle)] text-amber-700'}`}>
                {activeGoldSources.length > 0 ? 'Connected' : 'Not connected'}
              </span>
            </div>
            <div className="mt-2 text-[13px] font-semibold leading-5 text-[var(--rf-text)]">{matchedConnectorLabel}</div>
          </button>

          <button
            type="button"
            onClick={() => onOpenProjectSettings('domain', projectKey)}
            className="rf-panel-soft rounded-[18px] px-3.5 py-3 text-left transition hover:-translate-y-[1px] hover:border-[var(--rf-border-strong)] focus:outline-none"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">Work Instructions</div>
              <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide border ${activeWiDocs.length > 0 ? 'border-green-300 bg-[var(--rf-success-subtle)] text-[var(--rf-success)]' : 'border-[var(--rf-border)] bg-[var(--rf-bg)] text-[var(--rf-text-tertiary)]'}`}>
                {activeWiDocs.length > 0 ? 'Ingested' : 'Empty'}
              </span>
            </div>
            <div className="mt-2 text-[13px] font-semibold leading-5 text-[var(--rf-text)]">
              {activeWiDocs.length > 0 ? `${activeWiDocs.length} document${activeWiDocs.length !== 1 ? 's' : ''}` : 'None active'}
            </div>
          </button>
        </div>
        {projectKey === '*' && availableProjects.length > 0 && (
          <div className="mt-3 text-[11px] text-[var(--rf-text-tertiary)]">
            Select a project to unlock project-scoped examples and instructions.
          </div>
        )}
        </div>

        {/* Requirement scope label */}
        <div className="flex items-center justify-between gap-3 px-0.5 pt-1">
          <div>
            <label className="text-[10px] font-semibold text-[var(--rf-text-tertiary)] uppercase tracking-[0.18em]">Requirement Scope</label>
          </div>
          <span className="rounded-full border border-[rgba(183,197,214,0.72)] bg-white/80 px-2.5 py-1 text-[10px] font-medium text-[var(--rf-text-tertiary)] shadow-[var(--rf-shadow-sm)]">
            {originIssueKey ? `From ${originIssueKey}` : 'New brief'}
          </span>
        </div>

        {/* Textarea */}
        <div className="rf-panel rounded-[28px] overflow-hidden">
          <div className="rf-focus-ring m-3 rounded-[22px] border border-[rgba(183,197,214,0.66)] bg-[linear-gradient(180deg,rgba(248,251,255,0.88),rgba(255,255,255,0.98))]">
            <textarea
              value={requirement}
              onChange={(e) => setRequirement(e.target.value)}
              placeholder="Describe your feature requirement in detail... e.g. 'As a user, I want to be able to reset my password using an email link...'"
              disabled={isWorking}
              className="min-h-[320px] h-[clamp(320px,44vh,520px)] w-full bg-transparent border-none text-[var(--rf-text)] placeholder-[var(--rf-text-tertiary)] focus:outline-none text-[15px] leading-7 resize-none disabled:opacity-50 px-4 pt-4 pb-3"
            />
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-[var(--rf-border-subtle)] px-4 py-3">
            <button
              title="Attach doc (PDF/TXT)"
              className="inline-flex items-center gap-1.5 rounded-xl border border-[rgba(183,197,214,0.72)] bg-[var(--rf-surface-soft)] px-3 py-2 text-[11px] font-medium text-[var(--rf-text-secondary)] transition hover:-translate-y-[1px] hover:border-[var(--rf-brand)] hover:text-[var(--rf-brand)] hover:bg-[var(--rf-brand-muted)]"
            >
              <Paperclip className="w-3.5 h-3.5" />
              <span>Attach Context</span>
            </button>
            <div className="text-[10px] font-medium text-[var(--rf-text-tertiary)]">{wordCount} words</div>
          </div>
        </div>

        {/* Actions */}
        <div className="shrink-0 space-y-2 pt-1">
          <button
            onClick={onStartBrainstorm}
            disabled={brainstormDisabled}
            title={isAtLimit ? 'Monthly generation limit reached.' : ''}
            className="w-full bg-[linear-gradient(180deg,#2684ff_0%,#1f6fe5_100%)] hover:brightness-[1.02] disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-3.5 rounded-[18px] transition active:scale-[0.99] flex items-center justify-center gap-2 shadow-[0_16px_34px_rgba(0,82,204,0.18)]"
          >
            {isWorking ? (
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
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
              className="bg-white/88 border border-[rgba(183,197,214,0.72)] rounded-[16px] px-3 py-2.5 text-[var(--rf-text)] text-[11px] font-semibold transition hover:-translate-y-[1px] hover:bg-white hover:border-[var(--rf-border-strong)] flex items-center justify-center gap-1.5 shadow-[var(--rf-shadow-sm)]"
            >
              <Plus className="w-3.5 h-3.5" />
              New
            </button>
            <button
              onClick={onOpenHistory}
              className="bg-white/88 border border-[rgba(183,197,214,0.72)] rounded-[16px] px-3 py-2.5 text-[var(--rf-text)] text-[11px] font-semibold transition hover:-translate-y-[1px] hover:bg-white hover:border-[var(--rf-border-strong)] flex items-center justify-center gap-1.5 shadow-[var(--rf-shadow-sm)]"
            >
              <Clock className="w-3.5 h-3.5 text-[var(--rf-text-tertiary)]" />
              History
            </button>
          </div>
        </div>
      </div>

      {/* Footer / Usage Meter */}
      {!hasUnlimitedUsage && showUsage && (
        <div className="px-4 pb-4 pt-0 shrink-0">
          <div className="rf-panel-soft relative rounded-[20px] p-3">
            <button
              onClick={() => setShowUsage(false)}
              className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-lg text-[var(--rf-text-tertiary)] transition hover:bg-white hover:text-[var(--rf-text-secondary)]"
              title="Dismiss usage card"
              aria-label="Dismiss usage card"
            >
              <X className="w-3.5 h-3.5" />
            </button>
            <UsageMeter usage={usage} limits={limits} tier={tier} className="pr-8" />
          </div>
        </div>
      )}
    </aside>
  );
}
