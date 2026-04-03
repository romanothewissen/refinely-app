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
    : `${projectKey}${availableProject?.name ? ` \u00b7 ${availableProject.name}` : ''}`;
  const tierName = tier.charAt(0) ? `${tier.charAt(0).toUpperCase()}${tier.slice(1)}` : 'Free';
  const runAttachmentInputRef = React.useRef<HTMLInputElement | null>(null);
  const [logoLoadFailed, setLogoLoadFailed] = React.useState(false);
  const attachmentChipLabel = runAttachments.length === 1 ? '1 file attached' : `${runAttachments.length} files attached`;

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
        <div className="min-w-0 flex items-center gap-3">
          {brandingLogoUrl && !logoLoadFailed ? (
            <div className="shrink-0 min-h-[48px] max-w-[144px] rounded-2xl border border-[var(--rf-sidebar-border)] bg-gradient-to-br from-white/95 via-[var(--rf-sidebar-card)] to-[var(--rf-sidebar-card)] px-3 py-2 shadow-[0_8px_24px_rgba(15,23,42,0.08)] ring-1 ring-black/5 backdrop-blur-sm flex items-center justify-center">
              <img
                src={brandingLogoUrl}
                alt="Workspace logo"
                loading="lazy"
                onError={() => setLogoLoadFailed(true)}
                className="h-8 w-auto max-w-[116px] object-contain"
              />
            </div>
          ) : null}
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
              onChange={(e) => {
                const nextValue = e.target.value;
                setProjectKey(nextValue);
                if (nextValue === '*') {
                  if (contextMode === 'project') setContextMode('undecided');
                } else {
                  setContextMode('project');
                }
              }}
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
              Select a project to unlock project-scoped backlog context and instructions.
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                if (projectKey !== '*') setContextMode('project');
              }}
              disabled={projectKey === '*'}
              className={`inline-flex items-center rounded-lg px-3 py-1.5 text-[11px] font-bold transition border ${
                contextMode === 'project'
                  ? 'bg-[var(--rf-brand)] text-white border-[var(--rf-brand)]'
                  : 'bg-white text-[var(--rf-text-secondary)] border-[var(--rf-sidebar-border)] hover:border-[var(--rf-brand-subtle)]'
              } disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              Use selected project
            </button>
            <button
              type="button"
              onClick={() => {
                setProjectKey('*');
                setContextMode('global');
              }}
              className={`inline-flex items-center rounded-lg px-3 py-1.5 text-[11px] font-bold transition border ${
                contextMode === 'global'
                  ? 'bg-[var(--rf-brand)] text-white border-[var(--rf-brand)]'
                  : 'bg-white text-[var(--rf-text-secondary)] border-[var(--rf-sidebar-border)] hover:border-[var(--rf-brand-subtle)]'
              }`}
            >
              Run globally
            </button>
          </div>
          {!contextReady && (
            <div className="mt-2.5 text-[11px] text-[var(--rf-warning)] font-medium">
              Choose either a project-specific run or a global run before entering requirements.
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
              <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-sidebar-text-muted)]">Backlog Cache</div>
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider border ${projectKey !== '*' ? 'bg-[var(--rf-success-subtle)] text-[var(--rf-success)] border-[var(--rf-success)]/20' : 'bg-[var(--rf-warning-subtle)] text-[var(--rf-warning)] border-[var(--rf-warning)]/20'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${projectKey !== '*' ? 'bg-[var(--rf-success)]' : 'bg-[var(--rf-warning)]'}`} />
                {projectKey !== '*' ? 'Project' : 'Select'}
              </span>
            </div>
            <div className="text-xs font-medium text-[var(--rf-text)] leading-snug">
              {projectKey === '*'
                ? 'Select a project to manage backlog indexing.'
                : 'Backlog references come from the deployed stories cache.'}
            </div>
          </motion.button>

          <motion.button
            type="button"
            onClick={() => onOpenProjectSettings('jira', projectKey)}
            className="rf-sidebar-card px-3.5 py-3 text-left focus:outline-none focus:ring-2 focus:ring-[var(--rf-brand)]/30"
            whileTap={{ scale: 0.98 }}
          >
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-sidebar-text-muted)]">Project Docs</div>
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider border ${activeWiDocs.length > 0 ? 'bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)] border-[var(--rf-brand)]/20' : 'bg-[var(--rf-border-subtle)] text-[var(--rf-text-tertiary)] border-[var(--rf-border)]'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${activeWiDocs.length > 0 ? 'bg-[var(--rf-brand)]' : 'bg-[var(--rf-text-tertiary)]'}`} />
                {activeWiDocs.length > 0 ? 'Ingested' : 'Empty'}
              </span>
            </div>
            <div className="text-xs font-medium text-[var(--rf-text)] leading-snug">
              {activeWiDocs.length > 0 ? `${activeWiDocs.length} stored reference document${activeWiDocs.length !== 1 ? 's' : ''}` : 'No stored project docs yet'}
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
          <label className="text-[10px] font-bold text-[var(--rf-sidebar-text-muted)] uppercase tracking-widest">Input Message</label>
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
          custom={4}
        >
          <div className="border-b border-[var(--rf-sidebar-border)] bg-[linear-gradient(180deg,rgba(247,250,249,0.98),rgba(242,247,245,0.94))] px-4 py-3.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">One-time run input</div>
                  <span className="rounded-full border border-[var(--rf-brand)]/15 bg-white/85 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.18em] text-[var(--rf-brand)]">
                    prompt + files
                  </span>
                </div>
                <div className="mt-1 text-xs font-medium leading-snug text-[var(--rf-text-tertiary)]">
                  Type a request, add files, or do both. Attachments are used only for this run and do not become project grounding docs.
                </div>
              </div>
              <motion.button
                type="button"
                onClick={() => runAttachmentInputRef.current?.click()}
                disabled={isWorking}
                title="Attach supporting files for this run only"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--rf-brand)]/15 bg-white px-3 py-1.5 text-[11px] font-bold text-[var(--rf-brand)] shadow-sm transition hover:border-[var(--rf-brand)]/35 hover:text-[var(--rf-brand-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                whileTap={{ scale: 0.97 }}
              >
                <Paperclip className="w-3.5 h-3.5" />
                <span>{runAttachmentParseState ? 'Parsing…' : runAttachments.length ? 'Add more' : 'Add files'}</span>
              </motion.button>
            </div>
            <input
              ref={runAttachmentInputRef}
              type="file"
              onChange={handleRunAttachmentUpload}
              accept=".pdf,.xlsx,.xls,.csv,.txt,.md,.eml"
              multiple
              className="hidden"
              disabled={isWorking}
            />
            {runAttachments.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {runAttachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className="group flex items-center gap-2 rounded-2xl border border-[var(--rf-brand)]/15 bg-white px-3 py-2 shadow-[0_8px_24px_rgba(43,89,74,0.08)]"
                  >
                    <div className="min-w-0">
                      <div className="max-w-[190px] truncate text-[11px] font-bold text-[var(--rf-text)]">{attachment.filename}</div>
                      <div className="text-[10px] font-medium text-[var(--rf-text-tertiary)]">{attachment.charCount.toLocaleString()} chars</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemoveRunAttachment(attachment.id)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-transparent text-[var(--rf-text-tertiary)] transition hover:border-[var(--rf-border)] hover:bg-[var(--rf-surface-soft)] hover:text-[var(--rf-text)]"
                      title={`Remove ${attachment.filename}`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <textarea
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
            placeholder="Type your request here, or leave this blank and attach a file with the details. You can also do both."
            disabled={isWorking || !contextReady}
            className="min-h-[280px] h-[clamp(280px,40vh,460px)] w-full bg-transparent border-none text-[var(--rf-text)] placeholder-[var(--rf-text-tertiary)] focus:outline-none text-sm leading-relaxed resize-none disabled:opacity-50 px-4 pt-3 pb-2 custom-scrollbar"
          />
          <div className="flex items-center justify-between gap-3 border-t border-[var(--rf-sidebar-border)] px-4 py-2.5 bg-[var(--rf-bg-sidebar)]">
            <div className="text-[10px] font-medium text-[var(--rf-text-tertiary)]">
              {runAttachments.length > 0 ? `${attachmentChipLabel} · ` : ''}{wordCount} words
            </div>
            <div className="text-[10px] font-medium text-[var(--rf-text-tertiary)]">
              {hasPromptInput ? 'Ready to run' : 'Add text or files'}
            </div>
          </div>
        </motion.div>

        {(runAttachmentParseState || runAttachmentError) && (
          <motion.div
            className={`rf-sidebar-card px-4 py-3 ${runAttachmentError ? 'border-[var(--rf-danger-subtle)] bg-[var(--rf-danger-subtle)]' : ''}`}
            variants={fadeUpVariant}
            initial="hidden"
            animate="visible"
            custom={4.5}
          >
            {runAttachmentParseState && (
              <div className="space-y-2 mb-3 last:mb-0">
                <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">
                  {runAttachmentParseState.stage === 'reading' ? 'Reading attachment' : 'Parsing attachment'}
                </div>
                <div className="text-xs font-semibold text-[var(--rf-text)] break-words">{runAttachmentParseState.filename}</div>
              </div>
            )}
            {runAttachmentError && (
              <div className="space-y-2 mb-3 last:mb-0">
                <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-danger)]">Attachment failed</div>
                <div className="text-xs font-semibold text-[var(--rf-text)] break-words">{runAttachmentError}</div>
              </div>
            )}
          </motion.div>
        )}

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
