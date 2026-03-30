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
  onOpenProjectSettings
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
              className="font-bold text-white text-lg tracking-tight cursor-pointer hover:text-blue-400 transition-colors"
              onClick={() => setViewMode('generate')}
            >
              Refinely
            </h1>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest bg-blue-500/10 text-blue-400 border border-blue-500/20">
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
              className={`p-2 rounded-lg transition-colors ${viewMode === 'settings' ? 'bg-blue-500/20 text-blue-400' : 'text-slate-400 hover:bg-white/10 hover:text-white'}`}
              title="Settings"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              <Settings className="w-4 h-4" />
            </motion.button>
          )}
          <motion.button
            onClick={onToggleSidebar}
            className="p-2 rounded-lg transition-colors text-slate-400 hover:bg-white/10 hover:text-white"
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
              <div className="text-sm font-semibold text-white truncate">{projectTitle}</div>
            </div>
            <select
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value)}
              className="shrink-0 min-w-[132px] rounded-lg border border-[var(--rf-sidebar-border)] bg-white/5 px-2.5 py-1.5 text-[11px] font-medium text-white outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all hover:bg-white/10"
            >
              <option value="*" className="text-slate-900">No project selected</option>
              {availableProjects.map(project => (
                <option key={project.key} value={project.key} className="text-slate-900">
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
            className="rf-sidebar-card px-3.5 py-3 text-left focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            whileTap={{ scale: 0.98 }}
          >
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-sidebar-text-muted)]">Connectors</div>
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider border ${activeGoldSources.length > 0 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${activeGoldSources.length > 0 ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                {activeGoldSources.length > 0 ? 'Active' : 'Setup'}
              </span>
            </div>
            <div className="text-xs font-medium text-white leading-snug">{matchedConnectorLabel}</div>
          </motion.button>

          <motion.button
            type="button"
            onClick={() => onOpenProjectSettings('jira', projectKey)}
            className="rf-sidebar-card px-3.5 py-3 text-left focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            whileTap={{ scale: 0.98 }}
          >
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-sidebar-text-muted)]">Docs</div>
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider border ${activeWiDocs.length > 0 ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' : 'bg-white/5 text-slate-400 border-white/10'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${activeWiDocs.length > 0 ? 'bg-blue-400' : 'bg-slate-500'}`} />
                {activeWiDocs.length > 0 ? 'Ingested' : 'Empty'}
              </span>
            </div>
            <div className="text-xs font-medium text-white leading-snug">
              {activeWiDocs.length > 0 ? `${activeWiDocs.length} document${activeWiDocs.length !== 1 ? 's' : ''}` : 'None active'}
            </div>
          </motion.button>
        </motion.div>

        {/* Requirement scope label */}
        <motion.div
          className="flex items-center justify-between gap-3 px-1 mt-2"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={3}
        >
          <label className="text-[10px] font-bold text-[var(--rf-sidebar-text-muted)] uppercase tracking-widest">Feature Requirement</label>
          {originIssueKey && (
            <span className="rounded-full bg-blue-500/10 border border-blue-500/20 px-2.5 py-0.5 text-[10px] font-bold text-blue-400">
              Source: {originIssueKey}
            </span>
          )}
        </motion.div>

        {/* Textarea */}
        <motion.div
          className="rf-sidebar-card flex flex-col overflow-hidden focus-within:ring-2 focus-within:ring-blue-500/30 transition-shadow bg-black/20"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={4}
        >
          <textarea
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
            placeholder="Describe your feature requirement in detail... e.g. 'As a user, I want to be able to reset my password using an email link...'"
            disabled={isWorking}
            className="min-h-[280px] h-[clamp(280px,40vh,460px)] w-full bg-transparent border-none text-white placeholder-slate-500 focus:outline-none text-sm leading-relaxed resize-none disabled:opacity-50 px-4 pt-3 pb-2 custom-scrollbar"
          />
          <div className="flex items-center justify-between gap-3 border-t border-[var(--rf-sidebar-border)] px-4 py-2.5 bg-black/40">
            <motion.button
              title="Attach doc (PDF/TXT)"
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium text-slate-300 transition hover:bg-white/10 hover:text-white"
              whileTap={{ scale: 0.97 }}
            >
              <Paperclip className="w-3.5 h-3.5" />
              <span>Attach</span>
            </motion.button>
            <div className="text-[10px] font-medium text-slate-500 tabular-nums">{wordCount} words</div>
          </div>
        </motion.div>

        {/* Actions */}
        <motion.div
          className="shrink-0 space-y-3 mt-2"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={5}
        >
          <motion.button
            onClick={onStartBrainstorm}
            disabled={brainstormDisabled}
            title={isAtLimit ? 'Monthly generation limit reached.' : ''}
            className="brainstorm-shimmer w-full bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900/50 disabled:text-white/40 disabled:cursor-not-allowed text-white text-sm font-bold py-3.5 rounded-xl transition-colors flex items-center justify-center gap-2 shadow-lg shadow-blue-900/20 border border-blue-500/50"
            whileHover={!brainstormDisabled ? { scale: 1.01, boxShadow: '0 8px 20px rgba(37,99,235,0.25)' } : {}}
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
              className="rf-sidebar-card py-2.5 text-slate-300 hover:text-white text-xs font-semibold flex items-center justify-center gap-1.5"
              whileTap={{ scale: 0.97 }}
            >
              <Plus className="w-3.5 h-3.5" />
              New Draft
            </motion.button>
            <motion.button
              onClick={onOpenHistory}
              className="rf-sidebar-card py-2.5 text-slate-300 hover:text-white text-xs font-semibold flex items-center justify-center gap-1.5"
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
              className="absolute right-3 top-3 inline-flex h-6 w-6 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white/10 hover:text-white"
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
