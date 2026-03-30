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
      className="h-full flex flex-col shrink-0 overflow-hidden bg-white border-r border-[var(--rf-border)]"
      style={{ width: width ?? 380 }}
    >
      {/* Header */}
      <div className="px-5 py-4 border-b border-[var(--rf-border)] bg-white flex items-center justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1
              className="font-semibold text-[var(--rf-text)] text-[15px] tracking-tight cursor-pointer hover:text-[var(--rf-brand)] transition-colors"
              onClick={() => setViewMode('generate')}
            >
              Refinely
            </h1>
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)] border border-blue-200">
              Forge
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-[var(--rf-text-tertiary)]">
            Requirement-to-backlog workspace
          </p>
        </div>
        <div className="flex items-center gap-0.5">
          {isAdmin && (
            <button
              onClick={() => setViewMode('settings')}
              className={`p-2 rounded-md transition-colors ${viewMode === 'settings' ? 'bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)]' : 'text-[var(--rf-text-tertiary)] hover:bg-[var(--rf-bg)] hover:text-[var(--rf-text-secondary)]'}`}
              title="Settings"
            >
              <Settings className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={onToggleSidebar}
            className="p-2 rounded-md transition-colors text-[var(--rf-text-tertiary)] hover:bg-[var(--rf-bg)] hover:text-[var(--rf-text-secondary)]"
            title="Collapse Sidebar"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col w-full px-4 py-4 gap-3 overflow-y-auto no-scrollbar">
        {/* Project context card */}
        <div className="rounded-lg border border-[var(--rf-border)] bg-white p-4 shadow-[var(--rf-shadow-sm)]">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--rf-text-tertiary)]">Project Context</div>
              <div className="mt-1 text-sm font-semibold text-[var(--rf-text)]">{projectTitle}</div>
              <p className="mt-0.5 text-[11px] text-[var(--rf-text-tertiary)]">
                Choose the Jira project whose golden examples and instructions should power this run.
              </p>
            </div>
            <select
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value)}
              className="shrink-0 min-w-[140px] rounded-md border border-[var(--rf-border)] bg-white px-2.5 py-1.5 text-[11px] font-medium text-[var(--rf-text)] outline-none focus:border-[var(--rf-brand)] focus:ring-1 focus:ring-[var(--rf-brand)]"
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
            <div className="mb-3 rounded-md border border-amber-300 bg-[var(--rf-warning-subtle)] px-3 py-2 text-[11px] text-amber-800">
              Select a project to unlock project-scoped golden examples and work instructions.
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => onOpenProjectSettings('jira', projectKey)}
              className="rounded-md border border-[var(--rf-border)] bg-[var(--rf-bg)] px-3 py-2.5 text-left transition hover:border-[var(--rf-brand)] hover:bg-[var(--rf-brand-subtle)] focus:outline-none focus:ring-1 focus:ring-[var(--rf-brand)]"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--rf-text-tertiary)]">Connector Health</div>
                <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide border ${activeGoldSources.length > 0 ? 'border-green-300 bg-[var(--rf-success-subtle)] text-[var(--rf-success)]' : 'border-amber-300 bg-[var(--rf-warning-subtle)] text-amber-700'}`}>
                  {activeGoldSources.length > 0 ? 'Connected' : 'Not connected'}
                </span>
              </div>
              <div className="mt-1.5 text-xs font-medium text-[var(--rf-text)]">{matchedConnectorLabel}</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {activeGoldSources.length > 0 ? (
                  activeGoldSources.slice(0, 3).map(source => (
                    <span key={source.key} className="inline-flex items-center rounded px-2 py-0.5 text-[10px] font-medium bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)] border border-blue-200">
                      {source.key}
                    </span>
                  ))
                ) : (
                  <span className="text-[10px] text-[var(--rf-text-tertiary)]">Open settings to wire the selected project to golden examples.</span>
                )}
              </div>
            </button>

            <button
              type="button"
              onClick={() => onOpenProjectSettings('domain', projectKey)}
              className="rounded-md border border-[var(--rf-border)] bg-[var(--rf-bg)] px-3 py-2.5 text-left transition hover:border-[var(--rf-brand)] hover:bg-[var(--rf-brand-subtle)] focus:outline-none focus:ring-1 focus:ring-[var(--rf-brand)]"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--rf-text-tertiary)]">Work Instructions</div>
                <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide border ${activeWiDocs.length > 0 ? 'border-green-300 bg-[var(--rf-success-subtle)] text-[var(--rf-success)]' : 'border-[var(--rf-border)] bg-[var(--rf-bg)] text-[var(--rf-text-tertiary)]'}`}>
                  {activeWiDocs.length > 0 ? 'Ingested' : 'Empty'}
                </span>
              </div>
              <div className="mt-1.5 text-xs font-medium text-[var(--rf-text)]">
                {activeWiDocs.length > 0 ? `${activeWiDocs.length} document${activeWiDocs.length !== 1 ? 's' : ''}` : 'None active'}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {activeWiDocs.length > 0 ? (
                  activeWiDocs.slice(0, 3).map(doc => (
                    <span key={doc.docId} className="inline-flex items-center rounded px-2 py-0.5 text-[10px] font-medium bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)] border border-blue-200">
                      {doc.filename}
                    </span>
                  ))
                ) : (
                  <span className="text-[10px] text-[var(--rf-text-tertiary)]">Open settings to upload or map project docs.</span>
                )}
              </div>
            </button>
          </div>
        </div>

        {/* Requirement scope label */}
        <div className="flex items-center justify-between gap-3 px-0.5">
          <div>
            <label className="text-[10px] font-semibold text-[var(--rf-text-tertiary)] uppercase tracking-wide">Requirement Scope</label>
          </div>
          <span className="rounded border border-[var(--rf-border)] bg-[var(--rf-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--rf-text-tertiary)]">
            {originIssueKey ? `From ${originIssueKey}` : 'New brief'}
          </span>
        </div>

        {/* Textarea */}
        <div className="rounded-lg border border-[var(--rf-border)] bg-white shadow-[var(--rf-shadow-sm)] overflow-hidden">
          <textarea
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
            placeholder="Describe your feature requirement in detail... e.g. 'As a user, I want to be able to reset my password using an email link...'"
            disabled={isWorking}
            className="min-h-[220px] h-[clamp(220px,32vh,340px)] w-full bg-transparent border-none text-[var(--rf-text)] placeholder-[var(--rf-text-tertiary)] focus:outline-none text-sm leading-relaxed resize-none disabled:opacity-50 px-4 pt-3 pb-2"
          />
          <div className="flex items-center justify-between gap-3 border-t border-[var(--rf-border-subtle)] px-4 py-2.5">
            <button
              title="Attach doc (PDF/TXT)"
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--rf-border)] bg-white px-2.5 py-1.5 text-[11px] font-medium text-[var(--rf-text-secondary)] transition hover:border-[var(--rf-brand)] hover:text-[var(--rf-brand)] hover:bg-[var(--rf-brand-subtle)]"
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
            className="w-full bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-3 rounded-md transition-colors active:scale-[0.99] flex items-center justify-center gap-2 shadow-[var(--rf-shadow-sm)]"
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
              className="bg-white border border-[var(--rf-border)] rounded-md px-3 py-2.5 text-[var(--rf-text)] text-[11px] font-semibold transition hover:bg-[var(--rf-bg)] hover:border-[var(--rf-text-tertiary)] flex items-center justify-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              New
            </button>
            <button
              onClick={onOpenHistory}
              className="bg-white border border-[var(--rf-border)] rounded-md px-3 py-2.5 text-[var(--rf-text)] text-[11px] font-semibold transition hover:bg-[var(--rf-bg)] hover:border-[var(--rf-text-tertiary)] flex items-center justify-center gap-1.5"
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
          <div className="relative rounded-lg border border-[var(--rf-border)] bg-white p-3 shadow-[var(--rf-shadow-sm)]">
            <button
              onClick={() => setShowUsage(false)}
              className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--rf-text-tertiary)] transition hover:bg-[var(--rf-bg)] hover:text-[var(--rf-text-secondary)]"
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
