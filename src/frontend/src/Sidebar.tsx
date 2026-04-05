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
  projectKeys: string[];
  setProjectKeys: (keys: string[]) => void;
  contextMode: 'undecided' | 'project' | 'global';
  setContextMode: (mode: 'undecided' | 'project' | 'global') => void;
  availableProjects: Array<{ key: string; name: string }>;
  cacheCountsByProject: Record<string, number>;
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
  projectKeys,
  setProjectKeys,
  contextMode,
  setContextMode,
  availableProjects,
  cacheCountsByProject,
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
  const primaryProjectKey = projectKeys[0] ?? '*';
  const hasSelectedProject = projectKeys.some((key) => key && key !== '*');
  const contextReady = contextMode === 'global' || (contextMode === 'project' && primaryProjectKey !== '*');
  const hasPromptInput = Boolean(requirement.trim() || runAttachments.length);
  const brainstormDisabled = !contextReady || !hasPromptInput || isWorking;
  const [showUsage, setShowUsage] = React.useState(true);
  const [projectFilter, setProjectFilter] = React.useState('');
  const wordCount = requirement.trim().split(/\s+/).filter(Boolean).length;
  const activeWiDocs = projectKeys.length
    ? wiDocs.filter(doc => {
        const targets = doc.targetProjects ?? ['*'];
        return targets.includes('*') || projectKeys.some(key => targets.includes(key));
      })
    : wiDocs;
  const selectedProjects = projectKeys
    .map(key => availableProjects.find(p => p.key === key) || { key, name: '' })
    .filter((project): project is { key: string; name: string } => Boolean(project.key));
  const projectTitle = selectedProjects.length
    ? selectedProjects.map(project => project.name ? `${project.key} · ${project.name}` : project.key).join(' + ')
    : 'Global Workspace';
  const tierName = tier.charAt(0) ? `${tier.charAt(0).toUpperCase()}${tier.slice(1)}` : 'Standard';
  const runAttachmentInputRef = React.useRef<HTMLInputElement | null>(null);
  const [logoLoadFailed, setLogoLoadFailed] = React.useState(false);
  const [workspaceExpanded, setWorkspaceExpanded] = React.useState(() =>
    contextMode === 'undecided' && !hasSelectedProject && (width ?? 400) >= 360
  );
  const hadSelectedProjectRef = React.useRef(hasSelectedProject);
  const filteredProjects = availableProjects.filter(project => {
    const haystack = `${project.key} ${project.name}`.toLowerCase();
    return !projectFilter.trim() || haystack.includes(projectFilter.trim().toLowerCase());
  });
  const cacheBreakdown = selectedProjects
    .map((project) => ({ key: project.key, count: cacheCountsByProject[project.key] ?? 0 }))
    .filter((entry) => entry.key);
  const totalCachedStories = cacheBreakdown.reduce((sum, entry) => sum + entry.count, 0);

  React.useEffect(() => {
    setLogoLoadFailed(false);
  }, [brandingLogoUrl]);

  React.useEffect(() => {
    if ((width ?? 400) < 360) {
      setWorkspaceExpanded(false);
    }
  }, [width]);

  React.useEffect(() => {
    const nextHasSelectedProject = projectKeys.some((key) => key && key !== '*');
    const becameSelected = nextHasSelectedProject && !hadSelectedProjectRef.current;
    hadSelectedProjectRef.current = nextHasSelectedProject;

    if (becameSelected) {
      setWorkspaceExpanded(false);
    }
  }, [projectKeys]);

  const toggleProject = (nextKey: string) => {
    const normalized = String(nextKey ?? '').trim();
    if (!normalized || normalized === '*') return;
    const exists = projectKeys.includes(normalized);
    if (exists) {
      const next = projectKeys.filter(key => key !== normalized);
      setProjectKeys(next);
      if (!next.length && contextMode === 'project') setContextMode('global');
      return;
    }
    if (projectKeys.length >= 2) return;
    const next = [...projectKeys, normalized].slice(0, 2);
    setProjectKeys(next);
    if (contextMode !== 'global') setContextMode('project');
  };

  async function handleRunAttachmentUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;
    await onAddRunAttachments(files);
  }

  return (
    <aside
      className="rf-sidebar-shell h-full flex flex-col shrink-0 overflow-hidden"
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
              className={`p-2 rounded-xl transition-all border ${
                viewMode === 'settings'
                  ? 'bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)] border-[var(--rf-border-strong)]'
                  : 'text-[var(--rf-text-secondary)] bg-white/50 border-[var(--rf-border)] hover:bg-white/80 hover:text-[var(--rf-brand)]'
              }`}
              title="Settings"
            >
              <Settings className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={onToggleSidebar}
            className="p-2 rounded-xl transition-all text-[var(--rf-text-tertiary)] hover:bg-white/60 hover:text-[var(--rf-text)]"
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
            {/* Header: current workspace + collapse toggle */}
            <motion.button
              type="button"
              onClick={() => setWorkspaceExpanded((prev) => !prev)}
              aria-expanded={workspaceExpanded}
              aria-controls="workspace-selector"
              className="group w-full rounded-2xl border border-[var(--rf-border)] bg-white/72 p-3 text-left shadow-sm transition-all hover:border-[var(--rf-border-strong)] hover:bg-white/92 hover:shadow-md"
              whileTap={{ scale: 0.99 }}
              title={workspaceExpanded ? 'Collapse project picker' : 'Expand project picker'}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-[var(--rf-border)] bg-[var(--rf-brand-subtle)] shadow-sm">
                    <Orbit className="h-3.5 w-3.5 text-[var(--rf-brand)]" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] font-700 uppercase tracking-[0.14em] text-[var(--rf-text-tertiary)]">
                      {contextMode === 'undecided' ? 'Step 1 — Pick a scope' : 'Workspace'}
                    </div>
                    <div className="mt-0.5 truncate text-[13px] font-semibold text-[var(--rf-text)]">
                      {contextMode === 'undecided' ? 'Select project or go workspace-wide' : projectTitle}
                    </div>
                  </div>
                </div>
                <ChevronDown className={`h-4 w-4 shrink-0 text-[var(--rf-text-tertiary)] transition-transform group-hover:text-[var(--rf-text)] ${workspaceExpanded ? 'rotate-180' : ''}`} />
              </div>
              {contextMode !== 'undecided' && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {selectedProjects.length ? (
                    selectedProjects.map((project) => (
                      <span
                        key={project.key}
                        className="inline-flex items-center rounded-full border border-[var(--rf-border)] bg-[var(--rf-brand-subtle)] px-2.5 py-0.5 text-[12px] font-semibold text-[var(--rf-brand)]"
                      >
                        <span className="max-w-[120px] truncate">
                          {project.key}{project.name ? ` · ${project.name}` : ''}
                        </span>
                      </span>
                    ))
                  ) : (
                    <span className="inline-flex items-center rounded-full border border-[var(--rf-border)] bg-white/60 px-2.5 py-0.5 text-[12px] font-medium text-[var(--rf-text-secondary)]">
                      Workspace-wide
                    </span>
                  )}
                  <span className="text-[12px] text-[var(--rf-text-tertiary)]">
                    {activeWiDocs.length > 0 ? `${activeWiDocs.length} docs linked` : 'No docs linked'}
                  </span>
                </div>
              )}
            </motion.button>

            <AnimatePresence initial={false}>
              {workspaceExpanded && (
                <motion.div
                  id="workspace-selector"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                  className="overflow-hidden pt-2"
                >
                  <div className="space-y-2">
                    {/* Workspace-wide quick-select — always shown prominently */}
                    <button
                      type="button"
                      onClick={() => {
                        setProjectKeys([]);
                        setContextMode('global');
                        setWorkspaceExpanded(false);
                      }}
                      className={`w-full flex items-center justify-between rounded-xl border px-3 py-2.5 text-left transition ${
                        projectKeys.length === 0 && contextMode !== 'undecided'
                          ? 'border-[var(--rf-brand)] bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)]'
                          : 'border-[var(--rf-border)] bg-white/60 text-[var(--rf-text-secondary)] hover:border-[var(--rf-border-strong)] hover:bg-white/80 hover:text-[var(--rf-text)]'
                      }`}
                    >
                      <span className="text-[13px] font-semibold">Workspace-wide</span>
                      <span className="text-[11px] font-medium opacity-70">All projects</span>
                    </button>

                    {/* Divider */}
                    <div className="flex items-center gap-2">
                      <div className="h-px flex-1 bg-[var(--rf-border)]" />
                      <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--rf-text-tertiary)]">or pick a project</span>
                      <div className="h-px flex-1 bg-[var(--rf-border)]" />
                    </div>

                    {/* Selected project chips */}
                    {selectedProjects.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {selectedProjects.map((project) => (
                          <button
                            key={project.key}
                            type="button"
                            onClick={() => toggleProject(project.key)}
                            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--rf-border)] bg-[var(--rf-brand-subtle)] px-2.5 py-0.5 text-[12px] font-semibold text-[var(--rf-brand)] transition hover:bg-white/70"
                          >
                            <span className="max-w-[120px] truncate">
                              {project.key}{project.name ? ` · ${project.name}` : ''}
                            </span>
                            <X className="h-2.5 w-2.5" />
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Project search + list */}
                    <div className="relative">
                      <input
                        value={projectFilter}
                        onChange={(e) => setProjectFilter(e.target.value)}
                        placeholder="Search projects…"
                        className="w-full rounded-xl border border-[var(--rf-border)] bg-white/65 px-3.5 py-2 text-[13px] font-medium text-[var(--rf-text)] outline-none transition-all placeholder:text-[var(--rf-text-tertiary)] focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand-subtle)] backdrop-blur-sm"
                      />
                    </div>

                    <div className="max-h-36 overflow-y-auto rounded-xl border border-[var(--rf-border)] bg-white/55 p-1 custom-scrollbar backdrop-blur-sm">
                      {filteredProjects.length ? filteredProjects.map((project) => {
                        const selected = projectKeys.includes(project.key);
                        const disabled = !selected && projectKeys.length >= 2;
                        return (
                          <button
                            key={project.key}
                            type="button"
                            disabled={disabled}
                            onClick={() => toggleProject(project.key)}
                            className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition ${
                              selected
                                ? 'bg-[var(--rf-brand-subtle)] text-[var(--rf-text)]'
                                : 'hover:bg-white/70 text-[var(--rf-text-secondary)]'
                            } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-[13px] font-semibold">{project.key}</span>
                              <span className="block truncate text-[11px] text-[var(--rf-text-tertiary)]">{project.name}</span>
                            </span>
                            <span className="ml-3 shrink-0 text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--rf-brand)]">
                              {selected ? 'Selected' : 'Pick'}
                            </span>
                          </button>
                        );
                      }) : (
                        <div className="px-3 py-2 text-[13px] text-[var(--rf-text-tertiary)]">
                          No projects found.
                        </div>
                      )}
                    </div>

                    <p className="text-[12px] text-[var(--rf-text-tertiary)] leading-relaxed">
                      Select up to 2 projects to merge their backlog, docs, and guidance.
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Backlog + Docs stats row — only shown once scope is chosen */}
          {contextReady && (
            <div className="mx-3 mb-3 grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => onOpenProjectSettings('jira', primaryProjectKey)}
                className="group flex min-w-0 items-center gap-2 rounded-xl border border-[var(--rf-border)] bg-white/50 px-2.5 py-2 transition-all hover:border-[var(--rf-border-strong)] hover:bg-white/80"
                title="Open backlog cache settings"
              >
                <Database className="h-3.5 w-3.5 shrink-0 text-[var(--rf-brand)] opacity-60 group-hover:opacity-100 transition-opacity" />
                <div className="min-w-0 text-left">
                  <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--rf-text-tertiary)]">Backlog</div>
                  <div className="text-[13px] font-semibold text-[var(--rf-text)] truncate">
                    {selectedProjects.length ? `${totalCachedStories} stories` : 'All projects'}
                  </div>
                  {cacheBreakdown.length > 1 && (
                    <div className="text-[10px] text-[var(--rf-text-tertiary)] truncate">
                      {cacheBreakdown.map((entry) => `${entry.key} ${entry.count}`).join(' · ')}
                    </div>
                  )}
                </div>
              </button>
              <button
                type="button"
                onClick={() => onOpenProjectSettings('jira', primaryProjectKey)}
                className="group flex min-w-0 items-center gap-2 rounded-xl border border-[var(--rf-border)] bg-white/50 px-2.5 py-2 transition-all hover:border-[var(--rf-border-strong)] hover:bg-white/80"
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--rf-brand)] opacity-60 group-hover:opacity-100 transition-opacity" />
                <div className="min-w-0 text-left">
                  <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--rf-text-tertiary)]">Docs</div>
                  <div className="text-[13px] font-semibold text-[var(--rf-text)] truncate">
                    {activeWiDocs.length > 0 ? `${activeWiDocs.length} linked` : 'None stored'}
                  </div>
                </div>
              </button>
            </div>
          )}
        </motion.div>

        {/* ── Input card ── */}
        <motion.div
          className="rf-sidebar-card flex-1 flex flex-col min-h-0 overflow-hidden focus-within:ring-2 focus-within:ring-[var(--rf-brand-subtle)] transition-shadow"
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          custom={2}
        >
          {/* Card header */}
          <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-[var(--rf-border-subtle)] bg-white/40">
            <div className="flex items-center gap-2 min-w-0">
              {originIssueKey && (
                <span className="rounded-full bg-[var(--rf-brand-subtle)] border border-[var(--rf-border)] px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--rf-brand)] truncate">
                  {originIssueKey}
                </span>
              )}
              <span className="text-[11px] font-700 uppercase tracking-[0.13em] text-[var(--rf-text-tertiary)]">
                {contextMode === 'undecided' ? 'Step 2 — Requirement' : 'Requirement'}
              </span>
            </div>
            <motion.button
              type="button"
              onClick={() => runAttachmentInputRef.current?.click()}
              disabled={isWorking}
              title="Attach supporting files for this run only"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--rf-border)] bg-white/70 px-2.5 py-1.5 text-[12px] font-semibold text-[var(--rf-brand)] shadow-sm transition-all hover:border-[var(--rf-border-strong)] hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-40 backdrop-blur-sm"
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
                  className="flex items-center gap-1.5 rounded-xl border border-[var(--rf-border)] bg-white/65 px-2.5 py-1.5"
                >
                  <div className="min-w-0">
                    <div className="max-w-[140px] truncate text-[13px] font-semibold text-[var(--rf-text)]">{attachment.filename}</div>
                    <div className="text-[11px] text-[var(--rf-text-tertiary)]">{attachment.charCount.toLocaleString()} chars</div>
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
            placeholder={!contextReady ? 'Pick a scope above first…' : 'Describe your feature or requirement…'}
            disabled={isWorking || !contextReady}
            className="flex-1 min-h-0 w-full bg-transparent border-none text-[var(--rf-text)] placeholder-[var(--rf-text-tertiary)] focus:outline-none text-[13px] leading-relaxed resize-none disabled:opacity-50 px-3 pt-2.5 pb-2 custom-scrollbar"
          />

          {/* Card footer */}
          <div className="flex items-center justify-between gap-3 border-t border-[var(--rf-border-subtle)] px-3 py-2 bg-white/30">
            <span className="text-[12px] text-[var(--rf-text-tertiary)]">
              {wordCount > 0 ? `${wordCount} word${wordCount !== 1 ? 's' : ''}` : 'No input yet'}
            </span>
            <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.13em] border transition-all ${
              hasPromptInput
                ? 'bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)] border-[var(--rf-border)]'
                : 'bg-white/50 text-[var(--rf-text-tertiary)] border-[var(--rf-border-subtle)]'
            }`}>
              {hasPromptInput ? 'Ready' : 'Add input'}
            </span>
          </div>
        </motion.div>

        {/* ── Attachment parse state / error ── */}
        {(runAttachmentParseState || runAttachmentError) && (
          <motion.div
            className={`rf-sidebar-card px-4 py-3 ${runAttachmentError ? 'border-[rgba(155,53,69,0.2)] bg-[var(--rf-danger-subtle)]' : ''}`}
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
          className="shrink-0 space-y-2 mt-0.5"
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          custom={3}
        >
          {/* Primary CTA */}
          <motion.button
            onClick={onStartBrainstorm}
            disabled={brainstormDisabled}
            title={isAtLimit ? 'Included monthly usage has been reached. Generation is still available.' : ''}
            className="brainstorm-shimmer w-full bg-[linear-gradient(135deg,#1e4035,#2b594a,#3a7062)] hover:brightness-[1.05] disabled:bg-[var(--rf-border-strong)] disabled:text-white/40 disabled:cursor-not-allowed text-white text-[13px] font-bold py-[11px] rounded-[18px] transition-all flex items-center justify-center gap-2 shadow-[0_10px_32px_-12px_rgba(43,89,74,0.55)] border border-white/10"
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
                  <span>{originIssueKey ? 'Create Backlog' : 'Start Generation'}</span>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.button>

          {/* Secondary actions */}
          <div className="grid grid-cols-2 gap-2">
            <motion.button
              onClick={onNewSession}
              className="rf-glass-btn py-2.5 rounded-[18px] text-[var(--rf-text-secondary)] hover:text-[var(--rf-text)] text-[12px] font-semibold uppercase tracking-[0.1em] flex items-center justify-center gap-1.5 transition-all"
              whileTap={{ scale: 0.97 }}
            >
              <Plus className="w-3.5 h-3.5" />
              New Draft
            </motion.button>
            <motion.button
              onClick={onOpenHistory}
              className="rf-glass-btn py-2.5 rounded-[18px] text-[var(--rf-text-secondary)] hover:text-[var(--rf-text)] text-[12px] font-semibold uppercase tracking-[0.1em] flex items-center justify-center gap-1.5 transition-all"
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
          className="px-3 pb-3 pt-1 shrink-0"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35, duration: 0.38, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="relative overflow-hidden rounded-[18px] border border-[var(--rf-border)] bg-white/72 backdrop-blur-xl px-3 py-2.5">
            <button
              onClick={() => setShowUsage(false)}
              className="absolute right-2 top-2 inline-flex h-5 w-5 items-center justify-center rounded-lg text-[var(--rf-text-tertiary)] transition hover:bg-white/70 hover:text-[var(--rf-text)]"
            >
              <X className="w-3 h-3" />
            </button>
            <UsageMeter usage={usage} limits={limits} tier={tier} isCompact={true} className="pr-6" />
          </div>
        </motion.div>
      )}
    </aside>
  );
}
