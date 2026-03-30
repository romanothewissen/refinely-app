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
  hidden: { opacity: 0, y: 10 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.06, duration: 0.35, ease: [0.16, 1, 0.3, 1] as const },
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
    ? 'Pick a project to validate gold connectors'
    : activeGoldSources.length > 0
      ? `${activeGoldSources.length} active golden-example connector${activeGoldSources.length !== 1 ? 's' : ''}`
      : 'No golden-example connector is active for this project';
  const activeWiDocs = wiDocs.filter(doc => (doc.targetProjects ?? ['*']).includes('*') || (doc.targetProjects ?? []).includes(projectKey));
  const availableProject = availableProjects.find(p => p.key === projectKey);
  const projectTitle = projectKey === '*'
    ? 'Standalone workspace'
    : `${projectKey}${availableProject?.name ? ` \u00b7 ${availableProject.name}` : ''}`;
  const tierName = tier.charAt(0) ? `${tier.charAt(0).toUpperCase()}${tier.slice(1)}` : 'Free';

  return (
    <aside
      className="rf-sidebar-shell h-full flex flex-col shrink-0 overflow-hidden border-r border-[var(--rf-border)]"
      style={{ width: width ?? 380 }}
    >
      {/* Header — matches canvas header height and shadow treatment */}
      <motion.div
        className="px-6 h-[88px] bg-white flex items-center justify-between shrink-0 border-b border-[var(--rf-border)]"
        style={{ boxShadow: 'var(--rf-header-shadow)' }}
        variants={fadeUpVariant}
        initial="hidden"
        animate="visible"
        custom={0}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1
              className="font-bold text-[#172B4D] text-base tracking-tight cursor-pointer hover:text-[#0052CC] transition-colors"
              onClick={() => setViewMode('generate')}
            >
              Refinely
            </h1>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-[var(--rf-brand-muted)] text-[#0052CC] border border-[rgba(0,82,204,0.08)]">
              {tierName}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-[#8993A4]">
            Requirement-to-backlog workspace
          </p>
        </div>
        <div className="flex items-center gap-0.5">
          {isAdmin && (
            <motion.button
              onClick={() => setViewMode('settings')}
              className={`p-2 rounded-md transition-colors ${viewMode === 'settings' ? 'bg-[#DEEBFF] text-[#0052CC]' : 'text-[#8993A4] hover:bg-[#F4F5F7] hover:text-[#626F86]'}`}
              title="Settings"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              <Settings className="w-4 h-4" />
            </motion.button>
          )}
          <motion.button
            onClick={onToggleSidebar}
            className="p-2 rounded-md transition-colors text-[#8993A4] hover:bg-[#F4F5F7] hover:text-[#626F86]"
            title="Collapse Sidebar"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <PanelLeftClose className="w-4 h-4" />
          </motion.button>
        </div>
      </motion.div>

      <div className="flex-1 min-h-0 flex flex-col w-full px-5 py-5 gap-3.5 overflow-y-auto no-scrollbar">
        {/* Project context card */}
        <motion.div
          className="rf-card px-3.5 py-3"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={1}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-[#8993A4] mb-0.5">Project Context</div>
              <div className="text-sm font-semibold text-[#172B4D] truncate">{projectTitle}</div>
            </div>
            <select
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value)}
              className="shrink-0 min-w-[132px] rounded-lg border border-[var(--rf-border)] bg-white px-2.5 py-1.5 text-[11px] font-medium text-[#172B4D] outline-none focus:border-[#0052CC] focus:ring-2 focus:ring-[#0052CC]/20 transition-shadow"
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
            <div className="mt-2 text-[11px] text-[#8993A4]">
              Select a project to unlock project-scoped examples and instructions.
            </div>
          )}
        </motion.div>

        <motion.div
          className="grid gap-2 sm:grid-cols-2"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={2}
        >
          <motion.button
            type="button"
            onClick={() => onOpenProjectSettings('jira', projectKey)}
            className="rf-card px-3 py-2.5 text-left focus:outline-none focus:ring-2 focus:ring-[#0052CC]/30"
            whileHover={{ y: -2, boxShadow: 'var(--rf-shadow-md)' }}
            whileTap={{ scale: 0.98, y: 0 }}
          >
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-[#8993A4]">Connector Health</div>
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${activeGoldSources.length > 0 ? 'bg-[#E3FCEF] text-[#00875A]' : 'bg-[#FFFAE6] text-amber-700'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${activeGoldSources.length > 0 ? 'bg-[#00875A]' : 'bg-amber-500'}`} />
                {activeGoldSources.length > 0 ? 'Connected' : 'Not connected'}
              </span>
            </div>
            <div className="text-xs font-medium text-[#172B4D] leading-snug">{matchedConnectorLabel}</div>
          </motion.button>

          <motion.button
            type="button"
            onClick={() => onOpenProjectSettings('jira', projectKey)}
            className="rf-card px-3 py-2.5 text-left focus:outline-none focus:ring-2 focus:ring-[#0052CC]/30"
            whileHover={{ y: -2, boxShadow: 'var(--rf-shadow-md)' }}
            whileTap={{ scale: 0.98, y: 0 }}
          >
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-[#8993A4]">Work Instructions</div>
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${activeWiDocs.length > 0 ? 'bg-[#E3FCEF] text-[#00875A]' : 'bg-[#F4F5F7] text-[#8993A4]'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${activeWiDocs.length > 0 ? 'bg-[#00875A]' : 'bg-[#C1C7D0]'}`} />
                {activeWiDocs.length > 0 ? 'Ingested' : 'Empty'}
              </span>
            </div>
            <div className="text-xs font-medium text-[#172B4D] leading-snug">
              {activeWiDocs.length > 0 ? `${activeWiDocs.length} document${activeWiDocs.length !== 1 ? 's' : ''}` : 'None active'}
            </div>
          </motion.button>
        </motion.div>

        {/* Requirement scope label */}
        <motion.div
          className="flex items-center justify-between gap-3 px-0.5"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={3}
        >
          <label className="text-[10px] font-semibold text-[#8993A4] uppercase tracking-widest">Requirement Scope</label>
          <span className="rounded-full bg-[#EBECF0] px-2.5 py-0.5 text-[10px] font-semibold text-[#626F86]">
            {originIssueKey ? `From ${originIssueKey}` : 'New brief'}
          </span>
        </motion.div>

        {/* Textarea */}
        <motion.div
          className="rf-card overflow-hidden focus-within:ring-2 focus-within:ring-[#0052CC]/25 focus-within:shadow-[var(--rf-shadow-md)] transition-shadow"
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
            className="min-h-[280px] h-[clamp(280px,40vh,460px)] w-full bg-transparent border-none text-[#172B4D] placeholder-[#8993A4] focus:outline-none text-sm leading-relaxed resize-none disabled:opacity-50 px-4 pt-3 pb-2"
          />
          <div className="flex items-center justify-between gap-3 border-t border-[var(--rf-border-subtle)] px-4 py-2.5 bg-[var(--rf-surface-soft)]">
            <motion.button
              title="Attach doc (PDF/TXT)"
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium text-[#626F86] transition"
              whileHover={{ color: '#0052CC', backgroundColor: '#DEEBFF' }}
              whileTap={{ scale: 0.97 }}
            >
              <Paperclip className="w-3.5 h-3.5" />
              <span>Attach Context</span>
            </motion.button>
            <div className="text-[10px] font-medium text-[#8993A4] tabular-nums">{wordCount} words</div>
          </div>
        </motion.div>

        {/* Actions */}
        <motion.div
          className="shrink-0 space-y-2"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={5}
        >
          <motion.button
            onClick={onStartBrainstorm}
            disabled={brainstormDisabled}
            title={isAtLimit ? 'Monthly generation limit reached.' : ''}
            className="brainstorm-shimmer w-full bg-[#0B63E5] hover:bg-[#0052CC] disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2 shadow-[0_1px_2px_rgba(0,82,204,0.18)]"
            whileHover={!brainstormDisabled ? { scale: 1.005, boxShadow: '0 2px 6px rgba(0,82,204,0.18)' } : {}}
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
                <span>{isAtLimit ? 'Limit Reached' : originIssueKey ? 'Create Backlog' : 'Start Brainstorm'}</span>
              </>
            )}
          </motion.button>

          <div className="grid grid-cols-2 gap-2">
            <motion.button
              onClick={onNewSession}
              className="rf-card py-2.5 text-[#626F86] text-[11px] font-semibold flex items-center justify-center gap-1.5"
              whileHover={{ y: -1, boxShadow: 'var(--rf-shadow-md)', color: '#172B4D' }}
              whileTap={{ scale: 0.97, y: 0 }}
            >
              <Plus className="w-3.5 h-3.5" />
              New
            </motion.button>
            <motion.button
              onClick={onOpenHistory}
              className="rf-card py-2.5 text-[#626F86] text-[11px] font-semibold flex items-center justify-center gap-1.5"
              whileHover={{ y: -1, boxShadow: 'var(--rf-shadow-md)', color: '#172B4D' }}
              whileTap={{ scale: 0.97, y: 0 }}
            >
              <Clock className="w-3.5 h-3.5 text-[#8993A4]" />
              History
            </motion.button>
          </div>
        </motion.div>
      </div>

      {/* Footer / Usage Meter */}
      {!hasUnlimitedUsage && showUsage && (
        <motion.div
          className="px-4 pb-4 pt-2 shrink-0"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4, duration: 0.35, ease: [0.16, 1, 0.3, 1] as const }}
        >
          <div className="rf-card relative p-3.5">
            <button
              onClick={() => setShowUsage(false)}
              className="absolute right-2.5 top-2.5 inline-flex h-6 w-6 items-center justify-center rounded-lg text-[#8993A4] transition hover:bg-[#F4F5F7] hover:text-[#626F86]"
              title="Dismiss usage card"
              aria-label="Dismiss usage card"
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
