import React from 'react';
import { Paperclip, Plus, Clock, Settings, PanelLeftClose, Zap, X, Sparkles, Database, FileText, Orbit } from 'lucide-react';
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
        className="relative z-[1] px-6 h-[96px] flex items-center justify-between shrink-0 border-b border-white/45 bg-[linear-gradient(180deg,rgba(255,255,255,0.52),rgba(255,255,255,0.22))] backdrop-blur-xl"
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
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest bg-white/80 text-[var(--rf-brand)] border border-[rgba(43,89,74,0.12)] shadow-sm">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--rf-brand)]" />
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

      <div className="relative z-[1] flex-1 min-h-0 flex flex-col w-full px-5 py-5 gap-4 overflow-y-auto no-scrollbar">
        {/* Project context card */}
        <motion.div
          className="rf-sidebar-card overflow-hidden px-4 py-3.5"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={1}
        >
          <div className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(43,89,74,0.24),transparent)]" />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-2xl border border-[rgba(43,89,74,0.1)] bg-white shadow-sm">
                  <Orbit className="h-3.5 w-3.5 text-[var(--rf-brand)]" />
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-sidebar-text-muted)]">Workspace</div>
                  <div className="text-sm font-semibold text-[var(--rf-text)] truncate">{projectTitle}</div>
                </div>
              </div>
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
              className="shrink-0 min-w-[124px] max-w-[138px] rounded-xl border border-[rgba(43,89,74,0.12)] bg-white/75 px-2 py-1.5 text-[11px] font-medium text-[var(--rf-text)] outline-none focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand-subtle)] transition-all shadow-sm"
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
            <div className="mt-2 text-[11px] text-[var(--rf-sidebar-text-muted)]">
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
              className={`inline-flex items-center rounded-xl px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] transition border shadow-sm ${
                contextMode === 'project'
                  ? 'bg-[linear-gradient(135deg,var(--rf-brand),#3b705f)] text-white border-[var(--rf-brand)]'
                  : 'bg-white/85 text-[var(--rf-text-secondary)] border-[rgba(43,89,74,0.12)] hover:border-[var(--rf-brand-subtle)]'
              } disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              Use project
            </button>
            <button
              type="button"
              onClick={() => {
                setProjectKey('*');
                setContextMode('global');
              }}
              className={`inline-flex items-center rounded-xl px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] transition border shadow-sm ${
                contextMode === 'global'
                  ? 'bg-[linear-gradient(135deg,var(--rf-brand),#3b705f)] text-white border-[var(--rf-brand)]'
                  : 'bg-white/85 text-[var(--rf-text-secondary)] border-[rgba(43,89,74,0.12)] hover:border-[var(--rf-brand-subtle)]'
              }`}
            >
              Global
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onOpenProjectSettings('jira', projectKey)}
              className="inline-flex min-w-0 items-center gap-2 rounded-2xl border border-[rgba(43,89,74,0.1)] bg-white/78 px-2.5 py-2 text-left shadow-sm transition hover:border-[rgba(43,89,74,0.16)]"
            >
              <div className="flex h-6 w-6 items-center justify-center rounded-xl bg-[var(--rf-brand-subtle)] border border-[rgba(43,89,74,0.08)]">
                <Database className="h-3 w-3 text-[var(--rf-brand)]" />
              </div>
              <div className="min-w-0">
                <div className="text-[9px] font-bold uppercase tracking-[0.16em] text-[var(--rf-sidebar-text-muted)]">Cache</div>
                <div className="text-[11px] font-semibold text-[var(--rf-text)]">
                  {projectKey !== '*' ? 'Project cache' : 'Select project'}
                </div>
              </div>
            </button>
            <button
              type="button"
              onClick={() => onOpenProjectSettings('jira', projectKey)}
              className="inline-flex min-w-0 items-center gap-2 rounded-2xl border border-[rgba(43,89,74,0.1)] bg-white/78 px-2.5 py-2 text-left shadow-sm transition hover:border-[rgba(43,89,74,0.16)]"
            >
              <div className="flex h-6 w-6 items-center justify-center rounded-xl bg-[var(--rf-brand-subtle)] border border-[rgba(43,89,74,0.08)]">
                <FileText className="h-3 w-3 text-[var(--rf-brand)]" />
              </div>
              <div className="min-w-0">
                <div className="text-[9px] font-bold uppercase tracking-[0.16em] text-[var(--rf-sidebar-text-muted)]">Docs</div>
                <div className="text-[11px] font-semibold text-[var(--rf-text)]">
                  {activeWiDocs.length > 0 ? `${activeWiDocs.length} stored` : 'None stored'}
                </div>
              </div>
            </button>
          </div>
          {!contextReady && (
            <div className="mt-2.5 text-[11px] text-[var(--rf-warning)] font-medium">
              Choose either a project-specific run or a global run before entering requirements.
            </div>
          )}
        </motion.div>

        {/* Requirement scope label */}
        <motion.div
          className="flex items-center justify-between gap-3 px-1 mt-1"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={2}
        >
          <label className="text-[10px] font-bold text-[var(--rf-sidebar-text-muted)] uppercase tracking-widest">Input Message</label>
          {originIssueKey && (
            <span className="rounded-full bg-white/78 border border-[rgba(43,89,74,0.12)] px-2.5 py-1 text-[10px] font-bold text-[var(--rf-brand)] shadow-sm">
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
          custom={3}
        >
          <div className="relative border-b border-white/45 bg-[radial-gradient(circle_at_top,rgba(43,89,74,0.14),transparent_58%),linear-gradient(135deg,rgba(255,255,255,0.96),rgba(244,239,230,0.92))] px-4 py-2.5">
            <div className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(43,89,74,0.28),transparent)]" />
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-2xl border border-[rgba(43,89,74,0.1)] bg-white shadow-sm">
                  <Sparkles className="h-3.5 w-3.5 text-[var(--rf-brand)]" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Run input</div>
                    <span className="rounded-full border border-[var(--rf-brand)]/15 bg-white/85 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.18em] text-[var(--rf-brand)] shadow-sm">
                      text + files
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] font-medium leading-snug text-[var(--rf-text-tertiary)]">
                    Add a short prompt, files, or both.
                  </div>
                </div>
              </div>
              <motion.button
                type="button"
                onClick={() => runAttachmentInputRef.current?.click()}
                disabled={isWorking}
                title="Attach supporting files for this run only"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--rf-brand)]/15 bg-white px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--rf-brand)] shadow-sm transition hover:border-[var(--rf-brand)]/35 hover:text-[var(--rf-brand-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                whileTap={{ scale: 0.97 }}
              >
                <Paperclip className="w-3.5 h-3.5" />
                <span>{runAttachmentParseState ? 'Parsing' : runAttachments.length ? 'Add more' : 'Add files'}</span>
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
              <div className="mt-2 flex flex-wrap gap-2">
                {runAttachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className="group flex items-center gap-2 rounded-2xl border border-[var(--rf-brand)]/15 bg-white/96 px-2.5 py-1.5 shadow-[0_12px_28px_rgba(43,89,74,0.08)]"
                  >
                    <div className="min-w-0">
                      <div className="max-w-[160px] truncate text-[11px] font-bold text-[var(--rf-text)]">{attachment.filename}</div>
                      <div className="text-[10px] font-medium text-[var(--rf-text-tertiary)]">{attachment.charCount.toLocaleString()} chars</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemoveRunAttachment(attachment.id)}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-transparent text-[var(--rf-text-tertiary)] transition hover:border-[var(--rf-border)] hover:bg-[var(--rf-surface-soft)] hover:text-[var(--rf-text)]"
                      title={`Remove ${attachment.filename}`}
                    >
                      <X className="w-3 h-3" />
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
            className="min-h-[220px] h-[clamp(220px,36vh,400px)] w-full bg-transparent border-none text-[var(--rf-text)] placeholder-[var(--rf-text-tertiary)] focus:outline-none text-sm leading-relaxed resize-none disabled:opacity-50 px-4 pt-3 pb-2 custom-scrollbar"
          />
          <div className="flex items-center justify-between gap-3 border-t border-white/45 px-4 py-3 bg-[linear-gradient(180deg,rgba(247,250,249,0.88),rgba(238,244,241,0.88))]">
            <div className="text-[10px] font-medium text-[var(--rf-text-tertiary)]">
              {runAttachments.length > 0 ? `${attachmentChipLabel} · ` : ''}{wordCount} words
            </div>
            <div className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] ${
              hasPromptInput
                ? 'bg-white/88 text-[var(--rf-brand)] border border-[rgba(43,89,74,0.12)] shadow-sm'
                : 'bg-[var(--rf-surface-soft)] text-[var(--rf-text-tertiary)] border border-[var(--rf-border)]'
            }`}>
              {hasPromptInput ? 'Ready to run' : 'Add input'}
            </div>
          </div>
        </motion.div>

        {(runAttachmentParseState || runAttachmentError) && (
          <motion.div
            className={`rf-sidebar-card px-4 py-3 ${runAttachmentError ? 'border-[var(--rf-danger-subtle)] bg-[linear-gradient(180deg,#fff7f8,#f8e9eb)]' : ''}`}
            variants={fadeUpVariant}
            initial="hidden"
            animate="visible"
            custom={3.5}
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
          className="shrink-0 space-y-3 mt-1"
          variants={fadeUpVariant}
          initial="hidden"
          animate="visible"
          custom={4}
        >
          <motion.button
            onClick={onStartBrainstorm}
            disabled={brainstormDisabled}
            title={isAtLimit ? 'Monthly generation limit reached.' : ''}
            className="brainstorm-shimmer w-full bg-[linear-gradient(135deg,#21473b,#2b594a,#3d7867)] hover:brightness-[1.03] disabled:bg-[var(--rf-border-strong)] disabled:text-white/40 disabled:cursor-not-allowed text-white text-sm font-bold py-4 rounded-[20px] transition-colors flex items-center justify-center gap-2 shadow-[0_22px_42px_-22px_rgba(43,89,74,0.55)] border border-[rgba(255,255,255,0.16)]"
            whileHover={!brainstormDisabled ? { scale: 1.01, boxShadow: '0 18px 34px -18px rgba(43, 89, 74, 0.5)' } : {}}
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
              className="rf-sidebar-card py-3 text-[var(--rf-text-secondary)] hover:text-[var(--rf-text)] text-xs font-semibold flex items-center justify-center gap-1.5"
              whileTap={{ scale: 0.97 }}
            >
              <Plus className="w-3.5 h-3.5" />
              New Draft
            </motion.button>
            <motion.button
              onClick={onOpenHistory}
              className="rf-sidebar-card py-3 text-[var(--rf-text-secondary)] hover:text-[var(--rf-text)] text-xs font-semibold flex items-center justify-center gap-1.5"
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
          <div className="rf-sidebar-card relative overflow-hidden p-4">
            <div className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(43,89,74,0.22),transparent)]" />
            <button
              onClick={() => setShowUsage(false)}
              className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-xl text-[var(--rf-text-tertiary)] transition hover:bg-white/75 hover:text-[var(--rf-text)]"
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
