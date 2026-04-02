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
  const hasSelectedScope = Boolean(projectKey);
  const brainstormDisabled = !hasSelectedScope || !requirement.trim() || isWorking || isAtLimit;
  const [showUsage, setShowUsage] = React.useState(true);
  const wordCount = requirement.trim().split(/\s+/).filter(Boolean).length;
  const activeWiDocs = wiDocs.filter(doc => (doc.targetProjects ?? ['*']).includes('*') || (doc.targetProjects ?? []).includes(projectKey));
  const availableProject = availableProjects.find(p => p.key === projectKey);
  const projectTitle = !projectKey
    ? 'Choose project or standalone'
    : projectKey === '*'
      ? 'Standalone Workspace'
      : `${projectKey} · ${availableProject?.name || 'Project context'}`;
  const projectHint = !projectKey
    ? 'Select a Jira project for context, or deliberately choose Standalone workspace.'
    : activeWiDocs.length > 0
      ? 'Project selected. Work instructions are available to ground discovery and generation.'
      : 'Project selected. Add work instructions for stronger context-aware generation.';
  const tierName = tier.charAt(0) ? `${tier.charAt(0).toUpperCase()}${tier.slice(1)}` : 'Free';

  return (
    <aside
      className="rf-sidebar-shell h-full flex flex-col shrink-0 overflow-hidden text-[var(--rf-sidebar-text)]"
      style={{ width: width ?? 380 }}
    >
      {/* Header */}
      <motion.div
        className="px-5 h-[68px] flex items-center justify-between shrink-0 border-b border-[var(--rf-sidebar-border)]"
        variants={fadeUpVariant}
        initial="hidden"
        animate="visible"
        custom={0}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1
              className="font-bold text-[var(--rf-text)] text-base tracking-tight cursor-pointer hover:text-[var(--rf-brand)] transition-colors"
              onClick={() => setViewMode('generate')}
            >
              Refinely
            </h1>
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-widest bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)] border border-[var(--rf-brand-muted)]">
              {tierName}
            </span>
          </div>
          <p className="text-[11px] font-medium text-[var(--rf-sidebar-text-muted)] uppercase tracking-widest">
            Requirement to Backlog
          </p>
        </div>
        <div className="flex items-center gap-0.5">
          {isAdmin && (
            <motion.button
              onClick={() => setViewMode('settings')}
              className={`p-1.5 rounded-lg transition-colors ${viewMode === 'settings' ? 'bg-[var(--rf-sidebar-card)] text-[var(--rf-text)] shadow-sm' : 'text-[var(--rf-sidebar-text-muted)] hover:bg-[var(--rf-sidebar-card)] hover:text-[var(--rf-text)]'}`}
              title="Settings"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              <Settings className="w-3.5 h-3.5" />
            </motion.button>
          )}
          <motion.button
            onClick={onToggleSidebar}
            className="p-1.5 rounded-lg transition-colors text-[var(--rf-sidebar-text-muted)] hover:bg-[var(--rf-sidebar-card)] hover:text-[var(--rf-text)]"
            title="Collapse Sidebar"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <PanelLeftClose className="w-3.5 h-3.5" />
          </motion.button>
        </div>
      </motion.div>

      <div className="flex-1 min-h-0 flex flex-col w-full px-4 py-3 gap-3 overflow-hidden">
        {/* Project context card */}
        <motion.div
          className="rf-sidebar-card px-3.5 py-3"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={1}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-sidebar-text-muted)]">Scope</div>
              <div className="text-sm font-semibold text-[var(--rf-text)] truncate">{projectTitle}</div>
            </div>
            <select
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value)}
              className="shrink-0 min-w-[170px] rounded-lg border border-[var(--rf-sidebar-border)] bg-transparent px-3 py-2 text-[12px] font-medium text-[var(--rf-text)] outline-none focus:border-[var(--rf-brand)] transition-all hover:bg-[var(--rf-sidebar-card-hover)]"
            >
              <option value="" className="text-[var(--rf-text)]">Choose scope...</option>
              <option value="*" className="text-[var(--rf-text)]">Standalone workspace</option>
              {availableProjects.map(project => (
                <option key={project.key} value={project.key} className="text-[var(--rf-text)]">
                  {project.key}: {project.name}
                </option>
              ))}
            </select>
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-[var(--rf-sidebar-text-muted)]">
            {projectHint}
          </p>
        </motion.div>

        <motion.div
          className="grid gap-2 grid-cols-2"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={2}
        >
          <motion.button
            type="button"
            onClick={() => onOpenProjectSettings('jira', projectKey)}
            className="rf-sidebar-card px-3.5 py-3 text-left disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={!hasSelectedScope}
            whileTap={{ scale: 0.98 }}
          >
            <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-sidebar-text-muted)] mb-1">Delivery</div>
            <div className="text-[12px] font-medium text-[var(--rf-text)] truncate">
              {!hasSelectedScope ? 'Choose a scope first' : 'Jira mappings & backlog settings'}
            </div>
          </motion.button>

          <motion.button
            type="button"
            onClick={() => onOpenProjectSettings('jira', projectKey)}
            className="rf-sidebar-card px-3.5 py-3 text-left disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={!hasSelectedScope}
            whileTap={{ scale: 0.98 }}
          >
            <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-sidebar-text-muted)] mb-1">Docs</div>
            <div className="text-[12px] font-medium text-[var(--rf-text)] truncate">
              {!hasSelectedScope ? 'Choose a scope first' : activeWiDocs.length > 0 ? `${activeWiDocs.length} ingested` : 'None linked'}
            </div>
          </motion.button>
        </motion.div>

        {/* Policy controls */}
        <motion.div
          className="rf-sidebar-card px-3.5 py-3 space-y-2.5"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={4}
        >
          <div className="grid gap-2 grid-cols-2">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-sidebar-text-muted)] mb-1">Reasoning</div>
              <div className="flex rounded-lg bg-[var(--rf-bg-sidebar)] border border-[var(--rf-sidebar-border)] p-0.5">
                {(['fast', 'deep'] as const).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setReasoningMode(mode)}
                    disabled={!allowReasoningModeOverride}
                    className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-bold transition ${
                      reasoningMode === mode
                        ? 'bg-white text-[var(--rf-brand)] shadow-sm'
                        : 'text-[var(--rf-text-secondary)] hover:text-[var(--rf-text)]'
                    } disabled:opacity-50`}
                  >
                    {mode === 'fast' ? 'Fast' : 'Deep'}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-sidebar-text-muted)] mb-1">Output</div>
              <div className="flex rounded-lg bg-[var(--rf-bg-sidebar)] border border-[var(--rf-sidebar-border)] p-0.5">
                {([
                  { value: 'single', label: '1' },
                  { value: 'auto', label: 'A' },
                  { value: 'full_breakdown', label: 'Full' },
                ] as const).map(option => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setOutputMode(option.value)}
                    disabled={!allowOutputModeOverride}
                    className={`flex-1 rounded-md px-1.5 py-1.5 text-[11px] font-bold transition ${
                      outputMode === option.value
                        ? 'bg-white text-[var(--rf-brand)] shadow-sm'
                        : 'text-[var(--rf-text-secondary)] hover:text-[var(--rf-text)]'
                    } disabled:opacity-50`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </motion.div>

        {/* Textarea Area - Flexible height */}
        <div className="flex-1 flex flex-col min-h-0 gap-2">
          <motion.div
            className="flex items-center justify-between gap-2 px-1"
            variants={fadeUpVariant}
            initial="hidden"
            animate="visible"
            custom={5}
          >
            <label className="text-[10px] font-bold text-[var(--rf-sidebar-text-muted)] uppercase tracking-widest">Requirement</label>
            {originIssueKey && (
              <span className="text-[10px] font-bold text-[var(--rf-brand)]">
                {originIssueKey}
              </span>
            )}
          </motion.div>

          <motion.div
            className="rf-sidebar-card flex flex-1 flex-col overflow-hidden focus-within:ring-1 focus-within:ring-[var(--rf-brand)]/30 transition-shadow bg-white min-h-[120px]"
            variants={fadeUpVariant}
            initial="hidden"
            animate="visible"
            custom={6}
          >
            <textarea
              value={requirement}
              onChange={(e) => setRequirement(e.target.value)}
              placeholder={hasSelectedScope ? 'Describe your feature...' : 'Choose a project or standalone workspace first'}
              disabled={isWorking || !hasSelectedScope}
              className="block w-full flex-1 bg-transparent border-none text-[var(--rf-text)] placeholder-[var(--rf-text-tertiary)] focus:outline-none text-sm leading-relaxed resize-none disabled:opacity-50 px-3.5 py-3 custom-scrollbar"
            />
            <div className="flex items-center justify-between gap-3 border-t border-[var(--rf-sidebar-border)] px-3 py-1.5 bg-[var(--rf-bg-sidebar)]">
              <motion.button
                title="Attach doc"
                className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--rf-text-secondary)] hover:text-[var(--rf-text)]"
                whileTap={{ scale: 0.97 }}
              >
                <Paperclip className="w-3 h-3" />
                <span>Attach</span>
              </motion.button>
              <div className="text-[10px] font-medium text-[var(--rf-text-tertiary)] tabular-nums">{wordCount} words</div>
            </div>
          </motion.div>
        </div>

        {/* Actions */}
        <motion.div
          className="shrink-0 space-y-2"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={7}
        >
          <motion.button
            onClick={onStartBrainstorm}
            disabled={brainstormDisabled}
            className="brainstorm-shimmer w-full bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] disabled:bg-[var(--rf-border-strong)] disabled:text-white/40 text-white text-sm font-bold py-3 rounded-lg transition-colors flex items-center justify-center gap-2 shadow-md border border-[var(--rf-brand)]/50"
            whileHover={!brainstormDisabled ? { scale: 1.01 } : {}}
            whileTap={!brainstormDisabled ? { scale: 0.98 } : {}}
          >
            {isWorking ? (
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span>Working...</span>
              </div>
            ) : (
              <>
                <Zap className={`w-3.5 h-3.5 ${requirement.trim() ? 'fill-white' : ''}`} />
                <span>{!hasSelectedScope ? 'Choose Scope First' : isAtLimit ? 'Limit Reached' : originIssueKey ? 'Create Backlog' : 'Start Generation'}</span>
              </>
            )}
          </motion.button>
          {!hasSelectedScope && (
            <p className="px-1 text-[12px] leading-relaxed text-[var(--rf-sidebar-text-muted)]">
              Generation is locked until you deliberately choose a Jira project or the standalone workspace mode.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <motion.button
              onClick={onNewSession}
              className="rf-sidebar-card py-2.5 text-[var(--rf-text-secondary)] hover:text-[var(--rf-text)] text-[11px] font-bold flex items-center justify-center gap-1"
              whileTap={{ scale: 0.97 }}
            >
              <Plus className="w-3 h-3" />
              New Draft
            </motion.button>
            <motion.button
              onClick={onOpenHistory}
              className="rf-sidebar-card py-2.5 text-[var(--rf-text-secondary)] hover:text-[var(--rf-text)] text-[11px] font-bold flex items-center justify-center gap-1"
              whileTap={{ scale: 0.97 }}
            >
              <Clock className="w-3 h-3" />
              History
            </motion.button>
          </div>
        </motion.div>
      </div>

      {/* Footer / Usage Meter */}
      {!hasUnlimitedUsage && showUsage && (
        <motion.div
          className="px-4 pb-3 pt-1 shrink-0"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="rf-sidebar-card relative p-2.5 bg-white/50 backdrop-blur-sm">
            <button
              onClick={() => setShowUsage(false)}
              className="absolute right-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-lg text-[var(--rf-text-tertiary)] transition hover:bg-black/5 hover:text-[var(--rf-text)]"
            >
              <X className="w-3.5 h-3.5" />
            </button>
            <UsageMeter usage={usage} limits={limits} tier={tier} className="scale-90 origin-left" />
          </div>
        </motion.div>
      )}
    </aside>
  );
}
