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
      className="h-full flex flex-col shrink-0 overflow-hidden bg-white border-r border-[#DFE1E6]"
      style={{ width: width ?? 380 }}
    >
      {/* Header */}
      <motion.div
        className="px-5 py-4 border-b border-[#DFE1E6] bg-white flex items-center justify-between"
        variants={fadeUpVariant}
        initial="hidden"
        animate="visible"
        custom={0}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1
              className="font-semibold text-[#172B4D] text-[15px] tracking-tight cursor-pointer hover:text-[#0052CC] transition-colors"
              onClick={() => setViewMode('generate')}
            >
              Refinely
            </h1>
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-[#DEEBFF] text-[#0052CC] border border-blue-200">
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

      <div className="flex-1 min-h-0 flex flex-col w-full px-4 py-4 gap-3 overflow-y-auto no-scrollbar">
        {/* Project context card */}
        <motion.div
          className="rounded-lg border border-[#DFE1E6] bg-white px-3.5 py-3 shadow-[0_1px_3px_rgba(9,30,66,0.06),0_0_1px_rgba(9,30,66,0.04)]"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={1}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[#8993A4]">Project Context</div>
              <div className="mt-0.5 text-sm font-semibold text-[#172B4D] truncate">{projectTitle}</div>
            </div>
            <select
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value)}
              className="shrink-0 min-w-[132px] rounded-md border border-[#DFE1E6] bg-white px-2.5 py-1.5 text-[11px] font-medium text-[#172B4D] outline-none focus:border-[#0052CC] focus:ring-1 focus:ring-[#0052CC]"
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
            className="rounded-lg border border-[#DFE1E6] bg-white px-3 py-2.5 text-left shadow-[0_1px_3px_rgba(9,30,66,0.06),0_0_1px_rgba(9,30,66,0.04)] transition focus:outline-none focus:ring-1 focus:ring-[#0052CC]"
            whileHover={{ y: -1, boxShadow: '0 4px 12px rgba(9,30,66,0.08), 0 1px 3px rgba(9,30,66,0.04)', borderColor: '#0052CC' }}
            whileTap={{ scale: 0.98 }}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[#8993A4]">Connector Health</div>
              <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide border ${activeGoldSources.length > 0 ? 'border-green-300 bg-[#E3FCEF] text-[#00875A]' : 'border-amber-300 bg-[#FFFAE6] text-amber-700'}`}>
                {activeGoldSources.length > 0 ? 'Connected' : 'Not connected'}
              </span>
            </div>
            <div className="mt-1.5 text-xs font-medium text-[#172B4D]">{matchedConnectorLabel}</div>
          </motion.button>

          <motion.button
            type="button"
            onClick={() => onOpenProjectSettings('jira', projectKey)}
            className="rounded-lg border border-[#DFE1E6] bg-white px-3 py-2.5 text-left shadow-[0_1px_3px_rgba(9,30,66,0.06),0_0_1px_rgba(9,30,66,0.04)] transition focus:outline-none focus:ring-1 focus:ring-[#0052CC]"
            whileHover={{ y: -1, boxShadow: '0 4px 12px rgba(9,30,66,0.08), 0 1px 3px rgba(9,30,66,0.04)', borderColor: '#0052CC' }}
            whileTap={{ scale: 0.98 }}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[#8993A4]">Work Instructions</div>
              <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide border ${activeWiDocs.length > 0 ? 'border-green-300 bg-[#E3FCEF] text-[#00875A]' : 'border-[#DFE1E6] bg-[#F4F5F7] text-[#8993A4]'}`}>
                {activeWiDocs.length > 0 ? 'Ingested' : 'Empty'}
              </span>
            </div>
            <div className="mt-1.5 text-xs font-medium text-[#172B4D]">
              {activeWiDocs.length > 0 ? `${activeWiDocs.length} document${activeWiDocs.length !== 1 ? 's' : ''}` : 'None active'}
            </div>
          </motion.button>
        </motion.div>

        {/* Requirement scope label */}
        <motion.div
          className="flex items-center justify-between gap-3 px-0.5 pt-1"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={3}
        >
          <div>
            <label className="text-[10px] font-semibold text-[#8993A4] uppercase tracking-wide">Requirement Scope</label>
          </div>
          <span className="rounded border border-[#DFE1E6] bg-[#F4F5F7] px-2 py-0.5 text-[10px] font-medium text-[#8993A4]">
            {originIssueKey ? `From ${originIssueKey}` : 'New brief'}
          </span>
        </motion.div>

        {/* Textarea */}
        <motion.div
          className="rounded-lg border border-[#DFE1E6] bg-white shadow-[0_1px_3px_rgba(9,30,66,0.06),0_0_1px_rgba(9,30,66,0.04)] overflow-hidden"
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
          <div className="flex items-center justify-between gap-3 border-t border-[#EBECF0] px-4 py-2.5">
            <motion.button
              title="Attach doc (PDF/TXT)"
              className="inline-flex items-center gap-1.5 rounded-md border border-[#DFE1E6] bg-white px-2.5 py-1.5 text-[11px] font-medium text-[#626F86] transition"
              whileHover={{ borderColor: '#0052CC', color: '#0052CC', backgroundColor: '#DEEBFF' }}
              whileTap={{ scale: 0.97 }}
            >
              <Paperclip className="w-3.5 h-3.5" />
              <span>Attach Context</span>
            </motion.button>
            <div className="text-[10px] font-medium text-[#8993A4]">{wordCount} words</div>
          </div>
        </motion.div>

        {/* Actions */}
        <motion.div
          className="shrink-0 space-y-2 pt-1"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={5}
        >
          <motion.button
            onClick={onStartBrainstorm}
            disabled={brainstormDisabled}
            title={isAtLimit ? 'Monthly generation limit reached.' : ''}
            className="brainstorm-shimmer w-full bg-[#0052CC] hover:bg-[#0747A6] disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-3 rounded-lg transition-colors flex items-center justify-center gap-2 shadow-[0_2px_8px_rgba(0,82,204,0.25)]"
            whileHover={!brainstormDisabled ? { scale: 1.01, boxShadow: '0 4px 16px rgba(0,82,204,0.35)' } : {}}
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
              className="bg-white border border-[#DFE1E6] rounded-lg px-3 py-2.5 text-[#172B4D] text-[11px] font-semibold transition flex items-center justify-center gap-1.5"
              whileHover={{ backgroundColor: '#F4F5F7', borderColor: '#8993A4' }}
              whileTap={{ scale: 0.97 }}
            >
              <Plus className="w-3.5 h-3.5" />
              New
            </motion.button>
            <motion.button
              onClick={onOpenHistory}
              className="bg-white border border-[#DFE1E6] rounded-lg px-3 py-2.5 text-[#172B4D] text-[11px] font-semibold transition flex items-center justify-center gap-1.5"
              whileHover={{ backgroundColor: '#F4F5F7', borderColor: '#8993A4' }}
              whileTap={{ scale: 0.97 }}
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
          className="px-4 pb-4 pt-0 shrink-0"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="relative rounded-lg border border-[#DFE1E6] bg-white p-3 shadow-[0_1px_3px_rgba(9,30,66,0.06),0_0_1px_rgba(9,30,66,0.04)]">
            <button
              onClick={() => setShowUsage(false)}
              className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-md text-[#8993A4] transition hover:bg-[#F4F5F7] hover:text-[#626F86]"
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
