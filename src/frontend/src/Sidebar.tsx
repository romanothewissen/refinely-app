import React from 'react';
import { Paperclip, Plus, Clock, Settings, PanelLeftClose, Zap, X } from 'lucide-react';
import { motion } from 'framer-motion';
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
  reasoningMode: 'fast' | 'deep';
  setReasoningMode: (mode: 'fast' | 'deep') => void;
  outputMode: 'single' | 'auto' | 'full_breakdown';
  setOutputMode: (mode: 'single' | 'auto' | 'full_breakdown') => void;
  allowReasoningModeOverride: boolean;
  allowOutputModeOverride: boolean;
}

const fadeUpVariant = {
  hidden: { opacity: 0, y: 12 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.05, duration: 0.4, ease: [0.16, 1, 0.3, 1] as const },
  }),
};

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
  onOpenProjectSettings,
  reasoningMode,
  setReasoningMode,
  outputMode,
  setOutputMode,
  allowReasoningModeOverride,
  allowOutputModeOverride,
}: SidebarProps) {
  const isAtLimit = (limits?.generationsPerMonth !== -1 && usage && limits && usage.currentMonth >= limits.generationsPerMonth) || false;
  const hasUnlimitedUsage = limits?.generationsPerMonth === -1;
  const brainstormDisabled = !requirement.trim() || isWorking || isAtLimit;
  const [showUsage, setShowUsage] = React.useState(true);
  const wordCount = requirement.trim().split(/\s+/).filter(Boolean).length;
  const activeGoldSources = goldSources.filter(source => (source.targetProjects ?? []).includes(projectKey));
  const matchedConnectorLabel = projectKey === '*'
    ? 'Select a project for context'
    : activeGoldSources.length > 0
      ? `${activeGoldSources.length} active connector${activeGoldSources.length !== 1 ? 's' : ''}`
      : 'No connectors active';
  const activeWiDocs = wiDocs.filter(doc => (doc.targetProjects ?? ['*']).includes('*') || (doc.targetProjects ?? []).includes(projectKey));
  const availableProject = availableProjects.find(p => p.key === projectKey);
  const projectTitle = projectKey === '*'
    ? 'Global Workspace'
    : `${projectKey}${availableProject?.name ? ` \u00b7 ${availableProject.name}` : ''}`;
  const tierName = tier.charAt(0) ? `${tier.charAt(0).toUpperCase()}${tier.slice(1)}` : 'Free';

  return (
    <aside
      className="rf-sidebar-shell h-full flex flex-col shrink-0 overflow-hidden text-[var(--rf-sidebar-text)]"
      style={{ width: width ?? 380 }}
    >
      {/* Header */}
      <motion.div
        className="px-6 h-[88px] flex items-center justify-between shrink-0 border-b border-[var(--rf-sidebar-border)]"
        variants={fadeUpVariant}
        initial="hidden"
        animate="visible"
        custom={0}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1
              className="font-bold text-[var(--rf-text)] text-lg tracking-tight cursor-pointer hover:text-[var(--rf-brand)] transition-colors"
              onClick={() => setViewMode('generate')}
            >
              Refinely
            </h1>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)] border border-[var(--rf-brand-muted)]">
              {tierName}
            </span>
          </div>
          <p className="mt-1 text-[11px] font-medium text-[var(--rf-sidebar-text-muted)] uppercase tracking-widest">
            Requirement to Backlog
          </p>
        </div>
        <div className="flex items-center gap-1">
          {isAdmin && (
            <motion.button
              onClick={() => setViewMode('settings')}
              className={`p-2 rounded-lg transition-colors ${viewMode === 'settings' ? 'bg-[var(--rf-sidebar-card)] text-[var(--rf-text)] shadow-sm' : 'text-[var(--rf-sidebar-text-muted)] hover:bg-[var(--rf-sidebar-card)] hover:text-[var(--rf-text)]'}`}
              title="Settings"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              <Settings className="w-4 h-4" />
            </motion.button>
          )}
          <motion.button
            onClick={onToggleSidebar}
            className="p-2 rounded-lg transition-colors text-[var(--rf-sidebar-text-muted)] hover:bg-[var(--rf-sidebar-card)] hover:text-[var(--rf-text)]"
            title="Collapse Sidebar"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <PanelLeftClose className="w-4 h-4" />
          </motion.button>
        </div>
      </motion.div>

      <div className="flex-1 min-h-0 flex flex-col w-full px-5 py-5 gap-4 overflow-y-auto no-scrollbar">
        {/* Project context card */}
        <motion.div
          className="rf-sidebar-card px-4 py-3.5"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={1}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-sidebar-text-muted)] mb-1">Workspace</div>
              <div className="text-sm font-semibold text-[var(--rf-text)] truncate">{projectTitle}</div>
            </div>
            <select
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value)}
              className="shrink-0 min-w-[132px] rounded-lg border border-[var(--rf-sidebar-border)] bg-transparent px-2.5 py-1.5 text-[11px] font-medium text-[var(--rf-text)] outline-none focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand-subtle)] transition-all hover:bg-[var(--rf-sidebar-card-hover)]"
            >
              <option value="*" className="text-[var(--rf-text)]">No project selected</option>
              {availableProjects.map(project => (
                <option key={project.key} value={project.key} className="text-[var(--rf-text)]">
                  {project.key} - {project.name}
                </option>
              ))}
            </select>
          </div>
          {projectKey === '*' && availableProjects.length > 0 && (
            <div className="mt-2.5 text-[11px] text-[var(--rf-sidebar-text-muted)]">
              Select a project to unlock project-scoped examples and instructions.
            </div>
          )}
        </motion.div>

        <motion.div
          className="grid gap-3 sm:grid-cols-2"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={2}
        >
          <motion.button
            type="button"
            onClick={() => onOpenProjectSettings('jira', projectKey)}
            className="rf-sidebar-card px-3.5 py-3 text-left focus:outline-none focus:ring-2 focus:ring-[var(--rf-brand)]/30"
            whileTap={{ scale: 0.98 }}
          >
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-sidebar-text-muted)]">Connectors</div>
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider border ${activeGoldSources.length > 0 ? 'bg-[var(--rf-success-subtle)] text-[var(--rf-success)] border-[var(--rf-success)]/20' : 'bg-[var(--rf-warning-subtle)] text-[var(--rf-warning)] border-[var(--rf-warning)]/20'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${activeGoldSources.length > 0 ? 'bg-[var(--rf-success)]' : 'bg-[var(--rf-warning)]'}`} />
                {activeGoldSources.length > 0 ? 'Active' : 'Setup'}
              </span>
            </div>
            <div className="text-xs font-medium text-[var(--rf-text)] leading-snug">{matchedConnectorLabel}</div>
          </motion.button>

          <motion.button
            type="button"
            onClick={() => onOpenProjectSettings('jira', projectKey)}
            className="rf-sidebar-card px-3.5 py-3 text-left focus:outline-none focus:ring-2 focus:ring-[var(--rf-brand)]/30"
            whileTap={{ scale: 0.98 }}
          >
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-sidebar-text-muted)]">Docs</div>
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider border ${activeWiDocs.length > 0 ? 'bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)] border-[var(--rf-brand)]/20' : 'bg-[var(--rf-border-subtle)] text-[var(--rf-text-tertiary)] border-[var(--rf-border)]'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${activeWiDocs.length > 0 ? 'bg-[var(--rf-brand)]' : 'bg-[var(--rf-text-tertiary)]'}`} />
                {activeWiDocs.length > 0 ? 'Ingested' : 'Empty'}
              </span>
            </div>
            <div className="text-xs font-medium text-[var(--rf-text)] leading-snug">
              {activeWiDocs.length > 0 ? `${activeWiDocs.length} document${activeWiDocs.length !== 1 ? 's' : ''}` : 'None active'}
            </div>
          </motion.button>
        </motion.div>

        {/* Requirement scope label */}
        <motion.div
          className="rf-sidebar-card px-4 py-3.5 space-y-3"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={4}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-sidebar-text-muted)] mb-2">Reasoning</div>
              {allowReasoningModeOverride ? (
                <div className="flex rounded-xl bg-[var(--rf-bg-sidebar)] border border-[var(--rf-sidebar-border)] p-1">
                  {(['fast', 'deep'] as const).map(mode => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setReasoningMode(mode)}
                      className={`flex-1 rounded-lg px-3 py-2 text-[11px] font-bold transition ${
                        reasoningMode === mode
                          ? 'bg-white text-[var(--rf-brand)] shadow-sm'
                          : 'text-[var(--rf-text-secondary)] hover:text-[var(--rf-text)]'
                      }`}
                    >
                      {mode === 'fast' ? 'Fast' : 'Deep'}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-[var(--rf-sidebar-border)] bg-[var(--rf-bg-sidebar)] px-3 py-3 text-sm font-bold text-[var(--rf-text)]">
                  {reasoningMode === 'fast' ? 'Fast' : 'Deep'}
                </div>
              )}
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-sidebar-text-muted)] mb-2">Output</div>
              {allowOutputModeOverride ? (
                <div className="flex rounded-xl bg-[var(--rf-bg-sidebar)] border border-[var(--rf-sidebar-border)] p-1">
                  {([
                    { value: 'single', label: 'Single' },
                    { value: 'auto', label: 'Auto' },
                    { value: 'full_breakdown', label: 'Full' },
                  ] as const).map(option => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setOutputMode(option.value)}
                      className={`flex-1 rounded-lg px-2 py-2 text-[11px] font-bold transition ${
                        outputMode === option.value
                          ? 'bg-white text-[var(--rf-brand)] shadow-sm'
                          : 'text-[var(--rf-text-secondary)] hover:text-[var(--rf-text)]'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-[var(--rf-sidebar-border)] bg-[var(--rf-bg-sidebar)] px-3 py-3 text-sm font-bold text-[var(--rf-text)]">
                  {outputMode === 'single' ? 'Single' : outputMode === 'full_breakdown' ? 'Full breakdown' : 'Auto'}
                </div>
              )}
            </div>
          </div>
          <div className="grid gap-2 text-[11px] text-[var(--rf-sidebar-text-muted)] sm:grid-cols-2">
            <div className="rounded-xl border border-[var(--rf-sidebar-border)] bg-[var(--rf-bg-sidebar)] px-3 py-2">
              {reasoningMode === 'fast'
                ? 'Fast keeps discovery short and gets to a first backlog draft quickly.'
                : 'Deep can ask follow-up discovery rounds before generating the backlog.'}
            </div>
            <div className="rounded-xl border border-[var(--rf-sidebar-border)] bg-[var(--rf-bg-sidebar)] px-3 py-2">
              {outputMode === 'single'
                ? 'Single pushes the planner toward one strong feature.'
                : outputMode === 'full_breakdown'
                  ? 'Full breakdown pushes the planner toward broader decomposition.'
                  : 'Auto lets the planner size the output to the ask.'}
            </div>
          </div>
          {(!allowReasoningModeOverride || !allowOutputModeOverride) && (
            <div className="rounded-xl border border-[var(--rf-sidebar-border)] bg-[var(--rf-bg-sidebar)] px-3 py-2 text-[11px] text-[var(--rf-sidebar-text-muted)]">
              This project is using an administrator-defined AI policy, so some planning controls are locked to workspace or project defaults.
            </div>
          )}
        </motion.div>

        <motion.div
          className="flex items-center justify-between gap-3 px-1 mt-2"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={5}
        >
          <label className="text-[10px] font-bold text-[var(--rf-sidebar-text-muted)] uppercase tracking-widest">Feature Requirement</label>
          {originIssueKey && (
            <span className="rounded-full bg-[var(--rf-brand-subtle)] border border-[var(--rf-brand)]/20 px-2.5 py-0.5 text-[10px] font-bold text-[var(--rf-brand)]">
              Source: {originIssueKey}
            </span>
          )}
        </motion.div>

        {/* Textarea */}
        <motion.div
          className="rf-sidebar-card flex flex-col overflow-hidden focus-within:ring-2 focus-within:ring-[var(--rf-brand)]/30 transition-shadow bg-white"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={6}
        >
          <textarea
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
            placeholder="Describe your feature requirement in detail... e.g. 'As a user, I want to be able to reset my password using an email link...'"
            disabled={isWorking}
            className="min-h-[280px] h-[clamp(280px,40vh,460px)] w-full bg-transparent border-none text-[var(--rf-text)] placeholder-[var(--rf-text-tertiary)] focus:outline-none text-sm leading-relaxed resize-none disabled:opacity-50 px-4 pt-3 pb-2 custom-scrollbar"
          />
          <div className="flex items-center justify-between gap-3 border-t border-[var(--rf-sidebar-border)] px-4 py-2.5 bg-[var(--rf-bg-sidebar)]">
            <motion.button
              title="Attach doc (PDF/TXT)"
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium text-[var(--rf-text-secondary)] transition hover:bg-[var(--rf-sidebar-card)] hover:text-[var(--rf-text)]"
              whileTap={{ scale: 0.97 }}
            >
              <Paperclip className="w-3.5 h-3.5" />
              <span>Attach</span>
            </motion.button>
            <div className="text-[10px] font-medium text-[var(--rf-text-tertiary)] tabular-nums">{wordCount} words</div>
          </div>
        </motion.div>

        {/* Actions */}
        <motion.div
          className="shrink-0 space-y-3 mt-2"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={7}
        >
          <motion.button
            onClick={onStartBrainstorm}
            disabled={brainstormDisabled}
            title={isAtLimit ? 'Monthly generation limit reached.' : ''}
            className="brainstorm-shimmer w-full bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] disabled:bg-[var(--rf-border-strong)] disabled:text-white/40 disabled:cursor-not-allowed text-white text-sm font-bold py-3.5 rounded-xl transition-colors flex items-center justify-center gap-2 shadow-lg shadow-[var(--rf-brand)]/20 border border-[var(--rf-brand)]/50"
            whileHover={!brainstormDisabled ? { scale: 1.01, boxShadow: '0 8px 20px rgba(43, 89, 74, 0.25)' } : {}}
            whileTap={!brainstormDisabled ? { scale: 0.98 } : {}}
          >
            {isWorking ? (
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span>Working...</span>
              </div>
            ) : (
              <>
                <Zap className={`w-4 h-4 ${requirement.trim() ? 'fill-white' : ''}`} />
                <span>{isAtLimit ? 'Limit Reached' : originIssueKey ? 'Create Backlog' : 'Start Generation'}</span>
              </>
            )}
          </motion.button>

          <div className="grid grid-cols-2 gap-3">
            <motion.button
              onClick={onNewSession}
              className="rf-sidebar-card py-2.5 text-[var(--rf-text-secondary)] hover:text-[var(--rf-text)] text-xs font-semibold flex items-center justify-center gap-1.5"
              whileTap={{ scale: 0.97 }}
            >
              <Plus className="w-3.5 h-3.5" />
              New Draft
            </motion.button>
            <motion.button
              onClick={onOpenHistory}
              className="rf-sidebar-card py-2.5 text-[var(--rf-text-secondary)] hover:text-[var(--rf-text)] text-xs font-semibold flex items-center justify-center gap-1.5"
              whileTap={{ scale: 0.97 }}
            >
              <Clock className="w-3.5 h-3.5" />
              History
            </motion.button>
          </div>
        </motion.div>
      </div>

      {/* Footer / Usage Meter */}
      {!hasUnlimitedUsage && showUsage && (
        <motion.div
          className="px-5 pb-5 pt-2 shrink-0"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="rf-sidebar-card relative p-4">
            <button
              onClick={() => setShowUsage(false)}
              className="absolute right-3 top-3 inline-flex h-6 w-6 items-center justify-center rounded-lg text-[var(--rf-text-tertiary)] transition hover:bg-white/10 hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
            <UsageMeter usage={usage} limits={limits} tier={tier} className="pr-8" />
          </div>
        </motion.div>
      )}
    </aside>
  );
}
