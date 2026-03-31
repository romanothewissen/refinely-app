import React from 'react';
import { Paperclip, Plus, Clock, Settings, PanelLeftClose, Zap, X } from 'lucide-react';
import { motion } from 'framer-motion';
import { UsageMeter } from './UsageMeter';

interface SidebarProps {
  viewMode: 'generate' | 'settings';
  setViewMode: (mode: 'generate' | 'settings') => void;
  requirement: string;
  setRequirement: (val: string) => void;
  outputInstructions: string;
  setOutputInstructions: (val: string) => void;
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
  outputInstructions,
  setOutputInstructions,
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
    ? 'Select a project'
    : activeGoldSources.length > 0
      ? `${activeGoldSources.length} active`
      : 'No connectors';
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
        className="px-4 h-[56px] flex items-center justify-between shrink-0 border-b border-[var(--rf-sidebar-border)]"
        variants={fadeUpVariant}
        initial="hidden"
        animate="visible"
        custom={0}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1
              className="font-bold text-[var(--rf-text)] text-sm tracking-tight cursor-pointer hover:text-[var(--rf-brand)] transition-colors"
              onClick={() => setViewMode('generate')}
            >
              Refinely
            </h1>
            <span className="inline-flex items-center px-1.2 py-0.2 rounded-full text-[8px] font-bold uppercase tracking-widest bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)] border border-[var(--rf-brand-muted)]">
              {tierName}
            </span>
          </div>
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

      <div className="flex-1 min-h-0 flex flex-col w-full px-3 py-2.5 gap-2.5 overflow-hidden">
        {/* Project context card */}
        <motion.div
          className="rf-sidebar-card px-2.5 py-1.5"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={1}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-[8px] font-bold uppercase tracking-widest text-slate-400">Workspace</div>
              <div className="text-[11px] font-semibold text-slate-700 truncate">{projectTitle}</div>
            </div>
            <select
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value)}
              className="shrink-0 min-w-[100px] rounded-md border border-[var(--rf-sidebar-border)] bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-600 outline-none focus:border-[var(--rf-brand)] transition-all"
            >
              <option value="*">No project</option>
              {availableProjects.map(project => (
                <option key={project.key} value={project.key}>{project.key}</option>
              ))}
            </select>
          </div>
        </motion.div>

        <motion.div className="grid gap-2 grid-cols-2" variants={fadeUpVariant} initial="hidden" animate="visible" custom={2}>
          <motion.button type="button" onClick={() => onOpenProjectSettings('jira', projectKey)} className="rf-sidebar-card px-2.5 py-1.5 text-left" whileTap={{ scale: 0.98 }}>
            <div className="text-[8px] font-bold uppercase tracking-widest text-slate-400 mb-0.5">Connectors</div>
            <div className="text-[10px] font-medium text-slate-700 truncate">{matchedConnectorLabel}</div>
          </motion.button>
          <motion.button type="button" onClick={() => onOpenProjectSettings('jira', projectKey)} className="rf-sidebar-card px-2.5 py-1.5 text-left" whileTap={{ scale: 0.98 }}>
            <div className="text-[8px] font-bold uppercase tracking-widest text-slate-400 mb-0.5">Docs</div>
            <div className="text-[10px] font-medium text-slate-700 truncate">{activeWiDocs.length > 0 ? `${activeWiDocs.length} Active` : 'None'}</div>
          </motion.button>
        </motion.div>

        {/* Policy controls */}
        <motion.div className="rf-sidebar-card px-2.5 py-1.5" variants={fadeUpVariant} initial="hidden" animate="visible" custom={4}>
          <div className="grid gap-4 grid-cols-2">
            <div>
              <div className="text-[8px] font-bold uppercase tracking-widest text-slate-400 mb-1">Reasoning</div>
              <div className="flex rounded-md bg-slate-50 border border-slate-200 p-0.5">
                {(['fast', 'deep'] as const).map(mode => (
                  <button key={mode} type="button" onClick={() => setReasoningMode(mode)} disabled={!allowReasoningModeOverride} className={`flex-1 rounded-sm px-1 py-0.5 text-[9px] font-bold transition ${reasoningMode === mode ? 'bg-white text-[var(--rf-brand)] shadow-xs' : 'text-slate-400 hover:text-slate-600'} disabled:opacity-50`}>{mode === 'fast' ? 'Fast' : 'Deep'}</button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[8px] font-bold uppercase tracking-widest text-slate-400 mb-1">Breakdown</div>
              <div className="flex rounded-md bg-slate-50 border border-slate-200 p-0.5">
                {([ { value: 'single', label: '1' }, { value: 'auto', label: 'A' }, { value: 'full_breakdown', label: 'Full' } ] as const).map(option => (
                  <button key={option.value} type="button" onClick={() => setOutputMode(option.value)} disabled={!allowOutputModeOverride} className={`flex-1 rounded-sm px-1 py-0.5 text-[9px] font-bold transition ${outputMode === option.value ? 'bg-white text-[var(--rf-brand)] shadow-xs' : 'text-slate-400 hover:text-slate-600'} disabled:opacity-50`}>{option.label}</button>
                ))}
              </div>
            </div>
          </div>
        </motion.div>

        {/* Output Instructions (New) */}
        <motion.div className="flex flex-col gap-1.5" variants={fadeUpVariant} initial="hidden" animate="visible" custom={5}>
          <label className="text-[8px] font-bold text-slate-400 uppercase tracking-widest px-0.5">Output Instructions (Optional)</label>
          <div className="rf-sidebar-card bg-slate-50 border-slate-200 focus-within:ring-1 focus-within:ring-[var(--rf-brand)]/20 transition-all">
            <textarea
              value={outputInstructions}
              onChange={(e) => setOutputInstructions(e.target.value)}
              placeholder="e.g. Focus on technical risk, or use Gherkin..."
              disabled={isWorking}
              className="block w-full bg-transparent border-none text-slate-600 placeholder-slate-400 focus:outline-none text-[11px] leading-tight resize-none px-2.5 py-1.5 h-[44px] custom-scrollbar"
            />
          </div>
        </motion.div>

        {/* Primary Requirement */}
        <div className="flex-1 flex flex-col min-h-0 gap-1.5">
          <label className="text-[8px] font-bold text-slate-400 uppercase tracking-widest px-0.5">Requirement <span className="text-[var(--rf-brand)]">{originIssueKey}</span></label>
          <motion.div className="rf-sidebar-card flex flex-1 flex-col overflow-hidden bg-white border-slate-200 focus-within:ring-1 focus-within:ring-[var(--rf-brand)]/30" variants={fadeUpVariant} initial="hidden" animate="visible" custom={6}>
            <textarea
              value={requirement}
              onChange={(e) => setRequirement(e.target.value)}
              placeholder="Describe your feature..."
              disabled={isWorking}
              className="block w-full flex-1 bg-transparent border-none text-slate-700 placeholder-slate-300 focus:outline-none text-[12px] leading-relaxed resize-none px-3 py-2.5 custom-scrollbar"
            />
            <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-3 py-1.5 bg-slate-50/50">
              <button className="inline-flex items-center gap-1 text-[9px] font-bold text-slate-400 hover:text-[var(--rf-brand)]"><Paperclip className="w-2.5 h-2.5" /> Attach</button>
              <div className="text-[9px] font-medium text-slate-300 tabular-nums">{wordCount} words</div>
            </div>
          </motion.div>
        </div>

        {/* Actions - Guaranteed visible */}
        <motion.div className="shrink-0 space-y-2 pt-1" variants={fadeUpVariant} initial="hidden" animate="visible" custom={7}>
          <motion.button
            onClick={onStartBrainstorm}
            disabled={brainstormDisabled}
            className="brainstorm-shimmer w-full bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] disabled:bg-slate-200 disabled:text-slate-400 text-white text-[11px] font-bold py-2.5 rounded-lg transition-all flex items-center justify-center gap-2 shadow-sm"
            whileHover={!brainstormDisabled ? { scale: 1.01 } : {}}
            whileTap={!brainstormDisabled ? { scale: 0.98 } : {}}
          >
            {isWorking ? (
              <div className="flex items-center gap-2 shadow-inner">
                <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span>Working...</span>
              </div>
            ) : (
              <>
                <Zap className={`w-3.5 h-3.5 ${requirement.trim() ? 'fill-white' : ''}`} />
                <span>{isAtLimit ? 'Limit Reached' : 'Start Generation'}</span>
              </>
            )}
          </motion.button>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={onNewSession} className="rf-sidebar-card py-1.5 text-slate-500 hover:text-slate-800 text-[10px] font-bold flex items-center justify-center gap-1.5 transition-colors border-slate-200"><Plus className="w-3 h-3" /> New Draft</button>
            <button onClick={onOpenHistory} className="rf-sidebar-card py-1.5 text-slate-500 hover:text-slate-800 text-[10px] font-bold flex items-center justify-center gap-1.5 transition-colors border-slate-200"><Clock className="w-3 h-3" /> History</button>
          </div>
        </motion.div>
      </div>

      {/* Usage Meter */}
      {!hasUnlimitedUsage && showUsage && (
        <motion.div className="px-3 pb-3 shrink-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6 }}>
          <div className="rf-sidebar-card p-2 bg-slate-50/80 border-slate-100 relative group">
            <button onClick={() => setShowUsage(false)} className="absolute right-1 top-1 p-0.5 text-slate-300 hover:text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity"><X className="w-2.5 h-2.5" /></button>
            <UsageMeter usage={usage} limits={limits} tier={tier} className="scale-[0.85] origin-left" />
          </div>
        </motion.div>
      )}
    </aside>
  );
}
