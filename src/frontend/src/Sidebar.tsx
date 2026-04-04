import React from 'react';
import { Paperclip, Plus, Clock, Settings, PanelLeftClose, Zap, X, Database, FileText, Orbit, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
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
  brandingLogoUrl?: string | null;
  width?: number;
  originIssueKey?: string | null;
  projectKey: string;
  setProjectKey: (key: string) => void;
  contextMode: 'undecided' | 'project' | 'global';
  setContextMode: (mode: 'undecided' | 'project' | 'global') => void;
  availableProjects: Array<{ key: string; name: string }>;
  wiDocs: Array<{ docId: string; filename: string; chunkCount: number; targetProjects?: string[] }>;
  onOpenProjectSettings: (tab: 'models' | 'jira' | 'domain' | 'billing', projectKey: string) => void;
  runAttachments: Array<{ id: string; filename: string; charCount: number }>;
  runAttachmentParseState: { filename: string; stage: 'reading' | 'parsing' } | null;
  runAttachmentError: string | null;
  onAddRunAttachments: (files: File[]) => void | Promise<void>;
  onRemoveRunAttachment: (attachmentId: string) => void;
}

const fadeUp = {
  hidden: { opacity: 0, y: 10 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.05, duration: 0.38, ease: [0.16, 1, 0.3, 1] as const },
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
  brandingLogoUrl,
  width,
  originIssueKey,
  projectKey,
  setProjectKey,
  contextMode,
  setContextMode,
  availableProjects,
  wiDocs,
  onOpenProjectSettings,
  runAttachments,
  runAttachmentParseState,
  runAttachmentError,
  onAddRunAttachments,
  onRemoveRunAttachment,
}: SidebarProps) {
  const isAtLimit = (limits?.generationsPerMonth !== -1 && usage && limits && usage.currentMonth >= limits.generationsPerMonth) || false;
  const hasUnlimitedUsage = limits?.generationsPerMonth === -1;
  const contextReady = contextMode === 'global' || (contextMode === 'project' && projectKey !== '*');
  const hasPromptInput = Boolean(requirement.trim() || runAttachments.length);
  const brainstormDisabled = !contextReady || !hasPromptInput || isWorking || isAtLimit;
  const [showUsage, setShowUsage] = React.useState(true);
  const wordCount = requirement.trim().split(/\s+/).filter(Boolean).length;
  const activeWiDocs = wiDocs.filter(doc => (doc.targetProjects ?? ['*']).includes('*') || (doc.targetProjects ?? []).includes(projectKey));
  const availableProject = availableProjects.find(p => p.key === projectKey);
  const projectTitle = projectKey === '*'
    ? 'Global Workspace'
    : `${projectKey}${availableProject?.name ? ` · ${availableProject.name}` : ''}`;
  const tierName = tier.charAt(0) ? `${tier.charAt(0).toUpperCase()}${tier.slice(1)}` : 'Free';
  const runAttachmentInputRef = React.useRef<HTMLInputElement | null>(null);
  const [logoLoadFailed, setLogoLoadFailed] = React.useState(false);

  React.useEffect(() => {
    setLogoLoadFailed(false);
  }, [brandingLogoUrl]);

  async function handleRunAttachmentUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;
    await onAddRunAttachments(files);
  }

  return (
    <aside
      className="rf-sidebar-shell h-full flex flex-col shrink-0 overflow-hidden text-[var(--rf-sidebar-text)]"
      style={{ width: width ?? 400 }}
    >
      {/* ── Header ── */}
      <motion.header
        className="rf-pane-header rf-pane-header--sidebar shrink-0"
        variants={fadeUp}
        initial="hidden"
        animate="visible"
        custom={0}
      >
        <div className="rf-pane-header-cluster">
          {brandingLogoUrl && !logoLoadFailed ? (
            <img
              src={brandingLogoUrl}
              alt="Workspace logo"
              loading="lazy"
              onError={() => setLogoLoadFailed(true)}
              className="h-6 w-auto max-w-[80px] object-contain rounded"
            />
          ) : null}
          <div className="rf-pane-header-copy">
            <button
              onClick={() => setViewMode('generate')}
              className="rf-pane-header-title text-left hover:text-[var(--rf-brand)] transition-colors"
            >
              Refinely
            </button>
            <div className="rf-pane-header-subtitle rf-pane-header-subtitle--muted">
              Workspace Builder
            </div>
          </div>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <span className="rf-pane-header-badge hidden min-[360px]:inline-flex">
            Tier <strong>{tierName}</strong>
          </span>
          {isAdmin && (
            <button
              onClick={() => setViewMode('settings')}
              className={`p-2 rounded-lg transition-colors ${viewMode === 'settings' ? 'bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)]' : 'text-[var(--rf-sidebar-text-muted)] hover:bg-white/70 hover:text-[var(--rf-text)]'}`}
              title="Settings"
            >
              <Settings className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={onToggleSidebar}
            className="p-2 rounded-lg transition-colors text-[var(--rf-sidebar-text-muted)] hover:bg-white/70 hover:text-[var(--rf-text)]"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>
      </motion.header>

      {/* ── Scrollable body ── */}
      <div className="relative z-[1] flex-1 min-h-0 flex flex-col w-full px-3 py-3 gap-2.5 overflow-y-auto custom-scrollbar">

        {/* ── Workspace card ── */}
        <motion.div
          className="rf-sidebar-card"
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          custom={1}
        >
          {/* Project row */}
          <div className="px-3 pt-3 pb-2.5">
            <div className="mb-2.5 flex flex-wrap items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[rgba(43,89,74,0.1)] bg-[var(--rf-brand-subtle)] shadow-sm">
                  <Orbit className="h-3 w-3 text-[var(--rf-brand)]" />
                </div>
                <div className="min-w-0">
                  <div className="text-[13px] font-bold uppercase tracking-[0.14em] text-[var(--rf-sidebar-text-muted)]">Workspace</div>
                  <div className="mt-1 truncate text-[13px] font-semibold text-[var(--rf-text)]">
                    {projectTitle}
                  </div>
                </div>
              </div>
              {projectKey !== '*' && (
                <div className="shrink-0 text-[13px] font-medium text-[var(--rf-brand)] bg-[var(--rf-brand-subtle)] px-2 py-0.5 rounded-full border border-[rgba(43,89,74,0.1)]">
                  Project Active
                </div>
              )}
            </div>

            {/* Enlarged Select */}
            <div className="relative w-full">
              <select
                value={projectKey}
                onChange={(e) => {
                  const nextValue = e.target.value;
                  setProjectKey(nextValue);
                  if (nextValue === '*') {
                    if (contextMode === 'project') setContextMode('undecided');
                  } else {
                    setContextMode('project');
                  }
                }}
                className="appearance-none w-full pl-3.5 pr-10 py-2.5 rounded-xl border border-[rgba(43,89,74,0.12)] bg-white/80 text-[13px] font-semibold text-[var(--rf-text)] outline-none focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand)]/10 transition-all shadow-sm cursor-pointer"
              >
                <option value="*">Global Workspace (No project)</option>
                {availableProjects.map(project => (
                  <option key={project.key} value={project.key}>
                    {project.key} – {project.name}
                  </option>
                ))}
              </select>
              <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none flex items-center gap-1">
                <div className="w-px h-4 bg-[rgba(43,89,74,0.1)] mx-1" />
                <ChevronDown className="w-4 h-4 text-[var(--rf-sidebar-text-muted)]" />
              </div>
            </div>

            {/* Hint text */}
            {projectKey === '*' && availableProjects.length > 0 && (
              <p className="mt-2 text-[13px] text-[var(--rf-sidebar-text-muted)]">
                Select a project for scoped context.
              </p>
            )}
          </div>

          {/* Context mode toggles */}
          <div className="px-3 pb-2.5 flex gap-2">
            <button
              type="button"
              onClick={() => { if (projectKey !== '*') setContextMode('project'); }}
              disabled={projectKey === '*'}
              className={`flex-1 rounded-xl px-3 py-1.5 text-[13px] font-bold uppercase tracking-[0.12em] transition-all border ${
                contextMode === 'project'
                  ? 'bg-[var(--rf-brand)] text-white border-[var(--rf-brand)] shadow-sm'
                  : 'bg-white/70 text-[var(--rf-text-secondary)] border-[rgba(43,89,74,0.1)] hover:border-[rgba(43,89,74,0.22)] hover:bg-white/90'
              } disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              Project
            </button>
            <button
              type="button"
              onClick={() => { setProjectKey('*'); setContextMode('global'); }}
              className={`flex-1 rounded-xl px-3 py-1.5 text-[13px] font-bold uppercase tracking-[0.12em] transition-all border ${
                contextMode === 'global'
                  ? 'bg-[var(--rf-brand)] text-white border-[var(--rf-brand)] shadow-sm'
                  : 'bg-white/70 text-[var(--rf-text-secondary)] border-[rgba(43,89,74,0.1)] hover:border-[rgba(43,89,74,0.22)] hover:bg-white/90'
              }`}
            >
              Global
            </button>
          </div>

          {/* Cache + Docs stats row */}
          <div className="mx-3 mb-3 grid grid-cols-2 gap-1.5 min-[0px]:min-w-0">
            <button
              type="button"
              onClick={() => onOpenProjectSettings('jira', projectKey)}
              className="group flex min-w-0 items-center gap-2 rounded-lg border border-[rgba(43,89,74,0.08)] bg-[var(--rf-brand-muted)] px-2.5 py-1.5 transition-all hover:border-[rgba(43,89,74,0.18)] hover:bg-[var(--rf-brand-subtle)]"
            >
              <Database className="h-3 w-3 shrink-0 text-[var(--rf-brand)] opacity-70 group-hover:opacity-100 transition-opacity" />
              <div className="min-w-0 text-left">
                <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--rf-sidebar-text-muted)]">Cache</div>
                <div className="text-[13px] font-semibold text-[var(--rf-text)] truncate">
                  {projectKey !== '*' ? 'Project' : 'Select project'}
                </div>
              </div>
            </button>
            <button
              type="button"
              onClick={() => onOpenProjectSettings('jira', projectKey)}
              className="group flex min-w-0 items-center gap-2 rounded-lg border border-[rgba(43,89,74,0.08)] bg-[var(--rf-brand-muted)] px-2.5 py-1.5 transition-all hover:border-[rgba(43,89,74,0.18)] hover:bg-[var(--rf-brand-subtle)]"
            >
              <FileText className="h-3 w-3 shrink-0 text-[var(--rf-brand)] opacity-70 group-hover:opacity-100 transition-opacity" />
              <div className="min-w-0 text-left">
                <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--rf-sidebar-text-muted)]">Docs</div>
                <div className="text-[13px] font-semibold text-[var(--rf-text)] truncate">
                  {activeWiDocs.length > 0 ? `${activeWiDocs.length} stored` : 'None stored'}
                </div>
              </div>
            </button>
          </div>

          {/* Context not ready warning */}
          {!contextReady && (
            <div className="mx-3 mb-3 rounded-lg bg-[var(--rf-warning-subtle)] border border-[rgba(179,94,48,0.14)] px-3 py-2 text-[13px] font-medium text-[var(--rf-warning)]">
              Choose a context scope to continue.
            </div>
          )}
        </motion.div>

        {/* ── Input card ── */}
        <motion.div
          className="rf-sidebar-card flex-1 flex flex-col min-h-0 overflow-hidden focus-within:ring-2 focus-within:ring-[var(--rf-brand)]/20 transition-shadow"
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          custom={2}
        >
          {/* Card header */}
          <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-[rgba(43,89,74,0.06)] bg-[rgba(255,255,255,0.7)]">
            <div className="flex items-center gap-2 min-w-0">
              {originIssueKey && (
                <span className="rounded-full bg-[var(--rf-brand-subtle)] border border-[rgba(43,89,74,0.14)] px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--rf-brand)] truncate">
                  {originIssueKey}
                </span>
              )}
              <span className="text-[13px] font-bold uppercase tracking-[0.12em] text-[var(--rf-sidebar-text-muted)]">
                Requirement
              </span>
            </div>
            <motion.button
              type="button"
              onClick={() => runAttachmentInputRef.current?.click()}
              disabled={isWorking}
              title="Attach supporting files for this run only"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[rgba(43,89,74,0.12)] bg-white px-2.5 py-1.5 text-[13px] font-bold uppercase tracking-[0.1em] text-[var(--rf-brand)] shadow-sm transition-all hover:border-[rgba(43,89,74,0.28)] hover:shadow disabled:cursor-not-allowed disabled:opacity-40"
              whileTap={{ scale: 0.97 }}
            >
              <Paperclip className="w-3 h-3" />
              <span>{runAttachmentParseState ? 'Parsing…' : runAttachments.length > 0 ? `${runAttachments.length} file${runAttachments.length > 1 ? 's' : ''}` : 'Add files'}</span>
            </motion.button>
            <input
              ref={runAttachmentInputRef}
              type="file"
              onChange={handleRunAttachmentUpload}
              accept=".pdf,.xlsx,.xls,.csv,.txt,.md,.eml"
              multiple
              className="hidden"
              disabled={isWorking}
            />
          </div>

          {/* Attached files */}
          {runAttachments.length > 0 && (
            <div className="px-4 pt-3 flex flex-wrap gap-1.5">
              {runAttachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="flex items-center gap-1.5 rounded-lg border border-[rgba(43,89,74,0.12)] bg-[var(--rf-brand-muted)] px-2.5 py-1.5"
                >
                  <div className="min-w-0">
                    <div className="max-w-[140px] truncate text-[13px] font-semibold text-[var(--rf-text)]">{attachment.filename}</div>
                    <div className="text-[11px] font-medium text-[var(--rf-text-tertiary)]">{attachment.charCount.toLocaleString()} chars</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemoveRunAttachment(attachment.id)}
                    className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[var(--rf-text-tertiary)] transition hover:bg-white hover:text-[var(--rf-text)]"
                    title={`Remove ${attachment.filename}`}
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Textarea */}
          <textarea
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
            placeholder="Type your requirement here, or leave blank and attach a file."
            disabled={isWorking || !contextReady}
            className="flex-1 min-h-0 w-full bg-transparent border-none text-[var(--rf-text)] placeholder-[var(--rf-text-tertiary)] focus:outline-none text-[13px] leading-relaxed resize-none disabled:opacity-50 px-3 pt-2.5 pb-2 custom-scrollbar"
          />

          {/* Card footer */}
          <div className="flex items-center justify-between gap-3 border-t border-[rgba(43,89,74,0.06)] px-3 py-2 bg-[rgba(248,247,244,0.6)]">
            <span className="text-[13px] font-medium text-[var(--rf-text-tertiary)]">
              {wordCount > 0 ? `${wordCount} word${wordCount !== 1 ? 's' : ''}` : 'No input yet'}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.14em] border transition-all ${
              hasPromptInput
                ? 'bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)] border-[rgba(43,89,74,0.14)]'
                : 'bg-white/60 text-[var(--rf-text-tertiary)] border-[rgba(0,0,0,0.06)]'
            }`}>
              {hasPromptInput ? 'Ready' : 'Add input'}
            </span>
          </div>
        </motion.div>

        {/* ── Attachment parse state / error ── */}
        {(runAttachmentParseState || runAttachmentError) && (
          <motion.div
            className={`rf-sidebar-card px-4 py-3 ${runAttachmentError ? 'border-[rgba(158,62,71,0.2)] bg-[var(--rf-danger-subtle)]' : ''}`}
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            custom={2.5}
          >
            {runAttachmentParseState && (
              <div className="space-y-1">
                <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--rf-brand)]">
                  {runAttachmentParseState.stage === 'reading' ? 'Reading file' : 'Parsing file'}
                </div>
                <div className="text-[13px] font-semibold text-[var(--rf-text)] break-words">{runAttachmentParseState.filename}</div>
              </div>
            )}
            {runAttachmentError && (
              <div className="space-y-1">
                <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--rf-danger)]">Attachment failed</div>
                <div className="text-[13px] font-semibold text-[var(--rf-text)] break-words">{runAttachmentError}</div>
              </div>
            )}
          </motion.div>
        )}

        {/* ── Actions ── */}
        <motion.div
          className="shrink-0 space-y-2.5 mt-0.5"
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          custom={3}
        >
          {/* Primary CTA */}
          <motion.button
            onClick={onStartBrainstorm}
            disabled={brainstormDisabled}
            title={isAtLimit ? 'Monthly generation limit reached.' : ''}
            className="brainstorm-shimmer w-full bg-[linear-gradient(135deg,#1e4035,#2b594a,#3a7062)] hover:brightness-[1.04] disabled:bg-[var(--rf-border-strong)] disabled:text-white/40 disabled:cursor-not-allowed text-white text-[13px] font-bold py-[11px] rounded-[16px] transition-all flex items-center justify-center gap-2 shadow-[0_12px_28px_-16px_rgba(43,89,74,0.6)] border border-white/10"
            whileHover={!brainstormDisabled ? { scale: 1.01 } : {}}
            whileTap={!brainstormDisabled ? { scale: 0.98 } : {}}
          >
            <AnimatePresence mode="wait">
              {isWorking ? (
                <motion.div
                  key="working"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.15 }}
                  className="flex items-center gap-2"
                >
                  <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Working…</span>
                </motion.div>
              ) : (
                <motion.div
                  key="idle"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.15 }}
                  className="flex items-center gap-2"
                >
                  <Zap className={`w-3.5 h-3.5 ${requirement.trim() ? 'fill-white' : ''}`} />
                  <span>{isAtLimit ? 'Limit Reached' : originIssueKey ? 'Create Backlog' : 'Start Generation'}</span>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.button>

          {/* Secondary actions */}
          <div className="grid grid-cols-2 gap-2">
            <motion.button
              onClick={onNewSession}
              className="rf-sidebar-card py-2.5 text-[var(--rf-text-secondary)] hover:text-[var(--rf-text)] text-[13px] font-bold uppercase tracking-[0.1em] flex items-center justify-center gap-1.5 transition-colors"
              whileTap={{ scale: 0.97 }}
            >
              <Plus className="w-3.5 h-3.5" />
              New Draft
            </motion.button>
            <motion.button
              onClick={onOpenHistory}
              className="rf-sidebar-card py-2.5 text-[var(--rf-text-secondary)] hover:text-[var(--rf-text)] text-[13px] font-bold uppercase tracking-[0.1em] flex items-center justify-center gap-1.5 transition-colors"
              whileTap={{ scale: 0.97 }}
            >
              <Clock className="w-3.5 h-3.5" />
              History
            </motion.button>
          </div>
        </motion.div>
      </div>

      {/* ── Usage footer ── */}
      {!hasUnlimitedUsage && showUsage && (
        <motion.div
          className="px-4 pb-4 pt-1 shrink-0"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35, duration: 0.38, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="rf-sidebar-card relative overflow-hidden px-3 py-3">
            <button
              onClick={() => setShowUsage(false)}
              className="absolute right-2.5 top-2.5 inline-flex h-6 w-6 items-center justify-center rounded-lg text-[var(--rf-text-tertiary)] transition hover:bg-white/80 hover:text-[var(--rf-text)]"
            >
              <X className="w-3 h-3" />
            </button>
            <UsageMeter usage={usage} limits={limits} tier={tier} isCompact={true} className="pr-7" />
          </div>
        </motion.div>
      )}
    </aside>
  );
}
