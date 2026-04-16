import React from 'react';
import { Paperclip, Plus, Clock, Settings, PanelLeftClose, Zap, X, Database, FileText, Orbit, ChevronDown, Gauge } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { PipelineProfile } from './types';

interface SidebarProps {
  viewMode: 'generate' | 'settings';
  setViewMode: (mode: 'generate' | 'settings') => void;
  requirement: string;
  setRequirement: (val: string) => void;
  onStartBrainstorm: () => void;
  onNewSession: () => void;
  conversations: any[];
  currentSessionId: string;
  onRestoreSession: (sessionId: string) => void | Promise<void>;
  isWorking: boolean;
  onToggleSidebar: () => void;
  onOpenHistory: () => void;
  isAdmin?: boolean;
  tier: string;
  usage: { currentMonth: number } | null;
  limits: { generationsPerMonth: number } | null;
  brandingLogoUrl?: string | null;
  reviewBeforeARs?: boolean;
  pipelineProfile: PipelineProfile;
  onPipelineProfileChange: (value: PipelineProfile) => void;
  width?: number;
  originIssueKey?: string | null;
  projectKeys: string[];
  setProjectKeys: (keys: string[]) => void;
  contextMode: 'undecided' | 'project' | 'global';
  setContextMode: (mode: 'undecided' | 'project' | 'global') => void;
  workspaceSelectionVersion: number;
  availableProjects: Array<{ key: string; name: string }>;
  cacheCountsByProject: Record<string, number>;
  wiDocs: Array<{ docId: string; filename: string; chunkCount: number; targetProjects?: string[] }>;
  wiSelectionMode: 'auto' | 'selected';
  setWiSelectionMode: (mode: 'auto' | 'selected') => void;
  selectedWiDocIds: string[];
  setSelectedWiDocIds: (docIds: string[]) => void;
  onOpenProjectSettings: (tab: 'models' | 'jira' | 'domain' | 'billing', projectKey: string) => void;
  runAttachments: Array<{ id: string; filename: string; charCount: number }>;
  runAttachmentParseState: { filename: string; stage: 'reading' | 'parsing' } | null;
  runAttachmentError: string | null;
  onAddRunAttachments: (files: File[]) => void | Promise<void>;
  onRemoveRunAttachment: (attachmentId: string) => void;
  workspacePipelineAuditEnabled?: boolean;
  recordPipelineAuditForRun?: boolean;
  setRecordPipelineAuditForRun?: (value: boolean) => void;
}

const fadeUp = {
  hidden: { opacity: 0, y: 10 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.05, duration: 0.38, ease: [0.16, 1, 0.3, 1] as const },
  }),
};

function profileAccentColor(profile: PipelineProfile): string {
  if (profile === 'fast') return 'rgb(37, 99, 235)';
  if (profile === 'quality') return 'rgb(124, 58, 237)';
  return 'rgb(43, 89, 74)';
}

function profileAccentAlpha(profile: PipelineProfile): string {
  if (profile === 'fast') return 'rgba(37, 99, 235, 0.06)';
  if (profile === 'quality') return 'rgba(124, 58, 237, 0.06)';
  return 'rgba(43, 89, 74, 0.04)';
}

/** CSS custom properties driven by the active output profile — applied to the sidebar root. */
function profileCssVars(profile: PipelineProfile): React.CSSProperties {
  const themes: Record<PipelineProfile, Record<string, string>> = {
    fast: {
      '--sidebar-accent': 'rgb(37, 99, 235)',
      '--sidebar-accent-subtle': 'rgba(37, 99, 235, 0.08)',
      '--sidebar-accent-alpha': 'rgba(37, 99, 235, 0.06)',
      '--sidebar-accent-border': 'rgba(37, 99, 235, 0.25)',
      '--sidebar-cta-from': '#1e3a5f',
      '--sidebar-cta-mid': '#2563eb',
      '--sidebar-cta-to': '#3b82f6',
      '--sidebar-cta-shadow': 'rgba(37, 99, 235, 0.45)',
    },
    balanced: {
      '--sidebar-accent': 'rgb(43, 89, 74)',
      '--sidebar-accent-subtle': 'rgba(43, 89, 74, 0.08)',
      '--sidebar-accent-alpha': 'rgba(43, 89, 74, 0.04)',
      '--sidebar-accent-border': 'rgba(43, 89, 74, 0.25)',
      '--sidebar-cta-from': '#1e4035',
      '--sidebar-cta-mid': '#2b594a',
      '--sidebar-cta-to': '#3a7062',
      '--sidebar-cta-shadow': 'rgba(43, 89, 74, 0.55)',
    },
    quality: {
      '--sidebar-accent': 'rgb(124, 58, 237)',
      '--sidebar-accent-subtle': 'rgba(124, 58, 237, 0.08)',
      '--sidebar-accent-alpha': 'rgba(124, 58, 237, 0.06)',
      '--sidebar-accent-border': 'rgba(124, 58, 237, 0.25)',
      '--sidebar-cta-from': '#3b1a6e',
      '--sidebar-cta-mid': '#7c3aed',
      '--sidebar-cta-to': '#8b5cf6',
      '--sidebar-cta-shadow': 'rgba(124, 58, 237, 0.45)',
    },
  };
  return themes[profile] as React.CSSProperties;
}

function StepLabel({ number, title }: { number: string; title: string }) {
  return (
    <div className="flex items-center gap-2 px-1 pt-1">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--sidebar-accent-border)] bg-[var(--sidebar-accent-subtle)] text-[10px] font-bold text-[var(--sidebar-accent)] leading-none">
        {number}
      </span>
      <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--sidebar-accent)]">
        {title}
      </span>
    </div>
  );
}

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
  reviewBeforeARs,
  pipelineProfile,
  onPipelineProfileChange,
  width,
  originIssueKey,
  projectKeys,
  setProjectKeys,
  contextMode,
  setContextMode,
  workspaceSelectionVersion,
  availableProjects,
  cacheCountsByProject,
  wiDocs,
  wiSelectionMode,
  setWiSelectionMode,
  selectedWiDocIds,
  setSelectedWiDocIds,
  onOpenProjectSettings,
  runAttachments,
  runAttachmentParseState,
  runAttachmentError,
  onAddRunAttachments,
  onRemoveRunAttachment,
  workspacePipelineAuditEnabled = false,
  recordPipelineAuditForRun = false,
  setRecordPipelineAuditForRun,
}: SidebarProps) {
  const isAtLimit = (limits?.generationsPerMonth !== -1 && usage && limits && usage.currentMonth >= limits.generationsPerMonth) || false;
  const hasUnlimitedUsage = limits?.generationsPerMonth === -1;
  const primaryProjectKey = projectKeys[0] ?? '*';
  const hasSelectedProject = projectKeys.some((key) => key && key !== '*');
  const contextReady = contextMode === 'global' || (contextMode === 'project' && primaryProjectKey !== '*');
  const hasPromptInput = Boolean(requirement.trim() || runAttachments.length);
  const brainstormDisabled = !contextReady || !hasPromptInput || isWorking;
  const [projectFilter, setProjectFilter] = React.useState('');
  const wordCount = requirement.trim().split(/\s+/).filter(Boolean).length;
  const activeWiDocs = projectKeys.length
    ? wiDocs.filter(doc => {
        const targets = doc.targetProjects ?? ['*'];
        return targets.includes('*') || projectKeys.some(key => targets.includes(key));
      })
    : wiDocs;
  const activeWiDocIdSet = React.useMemo(() => new Set(activeWiDocs.map((doc) => doc.docId)), [activeWiDocs]);
  const selectedRunWiDocs = activeWiDocs.filter((doc) => selectedWiDocIds.includes(doc.docId));
  const selectedProjects = projectKeys
    .map(key => availableProjects.find(p => p.key === key) || { key, name: '' })
    .filter((project): project is { key: string; name: string } => Boolean(project.key));
  const projectTitle = selectedProjects.length
    ? selectedProjects.map(project => project.name ? `${project.key} · ${project.name}` : project.key).join(' + ')
    : 'Global Workspace';
  const runAttachmentInputRef = React.useRef<HTMLInputElement | null>(null);
  const [logoLoadFailed, setLogoLoadFailed] = React.useState(false);
  const [workspaceExpanded, setWorkspaceExpanded] = React.useState(() =>
    contextMode === 'undecided' && !hasSelectedProject && (width ?? 400) >= 360
  );
  const filteredProjects = availableProjects.filter(project => {
    const haystack = `${project.key} ${project.name}`.toLowerCase();
    return !projectFilter.trim() || haystack.includes(projectFilter.trim().toLowerCase());
  });
  const cacheBreakdown = selectedProjects
    .map((project) => ({ key: project.key, count: cacheCountsByProject[project.key] ?? 0 }))
    .filter((entry) => entry.key);
  const totalCachedStories = cacheBreakdown.reduce((sum, entry) => sum + entry.count, 0);
  const usageCurrent = usage?.currentMonth ?? 0;
  const usageLimit = limits?.generationsPerMonth ?? 0;
  const usagePercentage = !usage || !limits || hasUnlimitedUsage || usageLimit <= 0
    ? 0
    : Math.min(100, (usageCurrent / usageLimit) * 100);
  const usageMeterTone = isAtLimit
    ? 'var(--rf-warning)'
    : usagePercentage >= 80
      ? 'rgba(179,94,48,0.92)'
      : 'var(--rf-brand)';
  const usageLabel = !usage || !limits
    ? 'Usage syncing'
    : hasUnlimitedUsage
      ? 'Unlimited usage'
      : `${Math.max(0, usageLimit - usageCurrent)} left before guidance`;
  const usageCompactLabel = !usage || !limits
    ? 'Syncing'
    : hasUnlimitedUsage
      ? 'Unlimited'
      : `${Math.max(0, usageLimit - usageCurrent)} left`;
  const shouldShowHeaderUsage = Boolean(usage && limits && !hasUnlimitedUsage);

  React.useEffect(() => {
    setLogoLoadFailed(false);
  }, [brandingLogoUrl]);

  React.useEffect(() => {
    if ((width ?? 400) < 360) {
      setWorkspaceExpanded(false);
    }
  }, [width]);

  React.useEffect(() => {
    if (workspaceSelectionVersion > 0) {
      setWorkspaceExpanded(false);
    }
  }, [workspaceSelectionVersion]);

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

  const toggleRunWiDoc = (docId: string) => {
    const normalized = String(docId ?? '').trim();
    if (!normalized || !activeWiDocIdSet.has(normalized)) return;
    const next = selectedWiDocIds.includes(normalized)
      ? selectedWiDocIds.filter((id) => id !== normalized)
      : [...selectedWiDocIds, normalized].slice(0, 3);
    setSelectedWiDocIds(next);
  };

  const profileOptions = [
    { id: 'fast' as const, label: 'Fast', desc: 'Quick iteration · lighter analysis' },
    { id: 'balanced' as const, label: 'Balanced', desc: 'Standard depth and quality' },
    { id: 'quality' as const, label: 'Quality', desc: 'Thorough analysis · richer output' },
  ] as const;

  const selectedProfileOption = profileOptions.find(o => o.id === pipelineProfile);

  return (
    <aside
      className="rf-sidebar-shell h-full flex flex-col shrink-0 overflow-hidden"
      style={{ width: width ?? 400, ...profileCssVars(pipelineProfile) }}
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
          {shouldShowHeaderUsage && (
            <motion.div
              className="hidden min-[380px]:flex min-w-0 flex-1 max-w-[236px] items-center gap-2 rounded-[18px] border border-[var(--rf-border)] bg-white/72 px-2.5 py-2 shadow-[0_10px_24px_-18px_rgba(43,89,74,0.45)] backdrop-blur-xl"
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.12, duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
              title={isAtLimit ? 'Included monthly usage guidance has been reached.' : `${usageCurrent}/${usageLimit} included generations used this month.`}
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <div
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[12px] border ${
                    isAtLimit
                      ? 'border-[var(--rf-warning)]/30 bg-[var(--rf-warning-subtle)] text-[var(--rf-warning)]'
                      : 'border-[var(--rf-border)] bg-white/85 text-[var(--rf-brand)]'
                  }`}
                >
                  <Zap className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--rf-text-tertiary)]">
                    Usage
                  </div>
                  <div className="text-[11px] font-semibold text-[var(--rf-text-secondary)] leading-tight">
                    <span className="block truncate min-[440px]:hidden">
                      {usageCompactLabel}
                    </span>
                    <span className="hidden truncate min-[440px]:block">
                      {usageLabel}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex w-[66px] shrink-0 flex-col items-end gap-1 min-[440px]:w-[72px]">
                <div className="text-[10px] font-bold tracking-[0.08em] text-[var(--rf-text-tertiary)]">
                  {usageCurrent}/{usageLimit}
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full border border-[rgba(0,0,0,0.04)] bg-white/80">
                  <motion.div
                    className="h-full rounded-full"
                    style={{ background: usageMeterTone }}
                    initial={{ width: 0 }}
                    animate={{ width: `${usagePercentage}%` }}
                    transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                  />
                </div>
              </div>
            </motion.div>
          )}
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
      <div
        className="relative z-[1] flex-1 min-h-0 flex flex-col w-full px-4 py-4 gap-4 overflow-y-auto custom-scrollbar"
        style={{ background: `linear-gradient(to bottom, var(--sidebar-accent-alpha), transparent 220px)` }}
      >

        {/* ── Step 01: Scope ── */}
        <div className="flex flex-col gap-1.5">
          <StepLabel number="01" title="Scope" />
          <motion.div
            className="rf-sidebar-card relative"
            style={{
              boxShadow: contextMode === 'undecided'
                ? `0 0 0 2px var(--sidebar-accent-border), 0 4px 16px -6px var(--sidebar-cta-shadow), 0 1px 4px -1px var(--sidebar-cta-shadow)`
                : undefined,
            }}
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            custom={0.5}
          >
            {/* Animated left-accent pulse when scope is undecided */}
            {contextMode === 'undecided' && (
              <motion.div
                className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full bg-[var(--sidebar-accent)]"
                animate={{ opacity: [0.4, 1, 0.4] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              />
            )}

            <div className="px-3 pt-3 pb-3">
              {/* Compact context row */}
              <motion.button
                type="button"
                onClick={() => setWorkspaceExpanded((prev) => !prev)}
                aria-expanded={workspaceExpanded}
                aria-controls="workspace-selector"
                className="group w-full rounded-2xl border border-[var(--rf-border)] bg-white/72 px-3 py-2.5 text-left shadow-sm transition-all hover:border-[var(--sidebar-accent-border)] hover:bg-white/92 hover:shadow-md"
                whileTap={{ scale: 0.99 }}
                title={workspaceExpanded ? 'Collapse project picker' : 'Expand project picker'}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--sidebar-accent-border)] bg-[var(--sidebar-accent-subtle)] shadow-sm">
                      <Orbit className="h-3 w-3 text-[var(--sidebar-accent)]" />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-semibold text-[var(--rf-text)]">
                        {contextMode === 'undecided' ? 'Pick a scope' : projectTitle}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {contextReady && (
                      <>
                        <span
                          className="hidden min-[380px]:inline-flex items-center gap-1 rounded-full border border-[var(--sidebar-accent-border)] bg-[var(--sidebar-accent-subtle)] px-2 py-0.5 text-[10px] font-semibold text-[var(--sidebar-accent)]"
                        >
                          <Database className="h-2.5 w-2.5 text-[var(--sidebar-accent)]" />
                          {selectedProjects.length ? `${totalCachedStories}` : 'All'}
                        </span>
                        {activeWiDocs.length > 0 && (
                          <span className="hidden min-[380px]:inline-flex items-center gap-1 rounded-full border border-[var(--sidebar-accent-border)] bg-[var(--sidebar-accent-subtle)] px-2 py-0.5 text-[10px] font-semibold text-[var(--sidebar-accent)]">
                            <FileText className="h-2.5 w-2.5 text-[var(--sidebar-accent)]" />
                            {activeWiDocs.length}
                          </span>
                        )}
                      </>
                    )}
                    <ChevronDown className={`h-4 w-4 shrink-0 text-[var(--rf-text-tertiary)] transition-transform group-hover:text-[var(--rf-text)] ${workspaceExpanded ? 'rotate-180' : ''}`} />
                  </div>
                </div>
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
                      {/* Workspace-wide quick-select */}
                      <button
                        type="button"
                        onClick={() => {
                          setProjectKeys([]);
                          setContextMode('global');
                          setWorkspaceExpanded(false);
                        }}
                        className={`w-full flex items-center justify-between rounded-xl border px-3 py-2.5 text-left transition ${
                          projectKeys.length === 0 && contextMode !== 'undecided'
                            ? 'border-[var(--sidebar-accent)] bg-[var(--sidebar-accent-subtle)] text-[var(--sidebar-accent)]'
                            : 'border-[var(--rf-border)] bg-white/60 text-[var(--rf-text-secondary)] hover:border-[var(--sidebar-accent-border)] hover:bg-white/80 hover:text-[var(--rf-text)]'
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
                              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--sidebar-accent-border)] bg-[var(--sidebar-accent-subtle)] px-2.5 py-0.5 text-[12px] font-semibold text-[var(--sidebar-accent)] transition hover:bg-white/70"
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
                          className="w-full rounded-xl border border-[var(--rf-border)] bg-white/65 px-3.5 py-2 text-[13px] font-medium text-[var(--rf-text)] outline-none transition-all placeholder:text-[var(--rf-text-tertiary)] focus:border-[var(--sidebar-accent)] focus:ring-2 focus:ring-[var(--sidebar-accent-subtle)] backdrop-blur-sm"
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
                                  ? 'bg-[var(--sidebar-accent-subtle)] text-[var(--rf-text)]'
                                  : 'hover:bg-white/70 text-[var(--rf-text-secondary)]'
                              } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                            >
                              <span className="min-w-0">
                                <span className="block truncate text-[13px] font-semibold">{project.key}</span>
                                <span className="block truncate text-[11px] text-[var(--rf-text-tertiary)]">{project.name}</span>
                              </span>
                              <span className="ml-3 shrink-0 text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--sidebar-accent)]">
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
                      {cacheBreakdown.length > 1 && (
                        <div className="rounded-xl border border-[var(--rf-border-subtle)] bg-white/55 px-3 py-2 text-[11px] text-[var(--rf-text-tertiary)]">
                          {cacheBreakdown.map((entry) => `${entry.key} ${entry.count}`).join(' · ')}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </div>

        {/* ── Step 02: Output Profile ── */}
        <div className="flex flex-col gap-1.5">
          <StepLabel number="02" title="Output Profile" />
          <motion.div
            className="rf-sidebar-card"
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            custom={1}
          >
            <div className="px-3.5 pt-3.5 pb-3.5 space-y-3">
              {/* Header row */}
              <div className="flex items-center gap-2.5">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--sidebar-accent-border)] bg-[var(--sidebar-accent-subtle)] shadow-sm">
                  <Gauge className="h-3.5 w-3.5 text-[var(--sidebar-accent)]" />
                </div>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-[var(--rf-text)]">Performance</div>
                  <div className="text-[12px] leading-relaxed text-[var(--rf-text-secondary)]">
                    Speed and depth for this run.
                  </div>
                </div>
              </div>

              {/* Full-width segmented toggle */}
              <div className="relative flex w-full rounded-2xl border border-[var(--sidebar-accent-border)] bg-white/72 p-1 shadow-sm backdrop-blur-sm">
                {profileOptions.map((option, idx) => {
                  const selected = pipelineProfile === option.id;
                  return (
                    <React.Fragment key={option.id}>
                      {selected && (
                        <motion.span
                          layoutId="profile-pill"
                          className="absolute inset-y-1 rounded-[14px] shadow-sm pointer-events-none"
                          style={{
                            backgroundColor: profileAccentColor(pipelineProfile),
                            left: `calc(${idx} * 33.333% + 4px)`,
                            width: 'calc(33.333% - 5.333px)',
                          }}
                          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                        />
                      )}
                      <motion.button
                        type="button"
                        onClick={() => onPipelineProfileChange(option.id)}
                        disabled={isWorking}
                        whileTap={{ scale: 0.95 }}
                        className={`relative z-10 flex-1 rounded-[14px] px-2 py-2 text-[11px] font-bold uppercase tracking-[0.12em] transition-colors text-center ${
                          selected ? 'text-white' : 'text-[var(--rf-text-secondary)] hover:text-[var(--rf-text)]'
                        } disabled:opacity-50`}
                      >
                        {option.label}
                      </motion.button>
                    </React.Fragment>
                  );
                })}
              </div>

              {/* Profile description — changes with selection */}
              <div className="text-[11px] text-[var(--rf-text-tertiary)] leading-relaxed min-h-[16px]">
                {selectedProfileOption?.desc}
              </div>
            </div>
          </motion.div>
        </div>

        {/* ── Step 03: Work Instructions ── */}
        {activeWiDocs.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <StepLabel number="03" title="Work Instructions" />
            <motion.div
              className="rf-sidebar-card"
              variants={fadeUp}
              initial="hidden"
              animate="visible"
              custom={1.5}
            >
              <div className="px-3.5 pt-3.5 pb-3.5 space-y-3">
                {/* Header row */}
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--sidebar-accent-border)] bg-[var(--sidebar-accent-subtle)] shadow-sm">
                      <FileText className="h-3.5 w-3.5 text-[var(--sidebar-accent)]" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold text-[var(--rf-text)]">Docs</div>
                      <div className="text-[12px] leading-relaxed text-[var(--rf-text-secondary)]">
                        Auto uses all linked docs. Pick limits to 3.
                      </div>
                    </div>
                  </div>
                  <span className="shrink-0 rounded-full border border-[var(--sidebar-accent-border)] bg-[var(--sidebar-accent-subtle)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--sidebar-accent)]">
                    {wiSelectionMode === 'auto' ? `${activeWiDocs.length} auto` : `${selectedRunWiDocs.length}/3 picked`}
                  </span>
                </div>

                {/* Full-width Auto / Pick toggle */}
                <div className="relative flex w-full rounded-2xl border border-[var(--sidebar-accent-border)] bg-white/72 p-1 shadow-sm backdrop-blur-sm">
                  {([
                    { id: 'auto' as const, label: 'Auto' },
                    { id: 'selected' as const, label: 'Pick up to 3' },
                  ]).map((option, idx) => {
                    const selected = wiSelectionMode === option.id;
                    return (
                      <React.Fragment key={option.id}>
                        {selected && (
                          <motion.span
                            layoutId="wi-mode-pill"
                            className="absolute inset-y-1 rounded-[14px] shadow-sm pointer-events-none"
                            style={{
                              backgroundColor: 'var(--sidebar-accent)',
                              left: idx === 0 ? '4px' : 'calc(50% + 2px)',
                              width: idx === 0 ? 'calc(50% - 6px)' : 'calc(50% - 6px)',
                            }}
                            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                          />
                        )}
                        <motion.button
                          type="button"
                          onClick={() => setWiSelectionMode(option.id)}
                          whileTap={{ scale: 0.95 }}
                          className={`relative z-10 flex-1 rounded-[14px] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.12em] transition-colors text-center ${
                            selected ? 'text-white' : 'text-[var(--rf-text-secondary)] hover:text-[var(--rf-text)]'
                          }`}
                        >
                          {option.label}
                        </motion.button>
                      </React.Fragment>
                    );
                  })}
                </div>

                {/* Doc list when Pick mode */}
                {wiSelectionMode === 'selected' && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                    className="overflow-hidden"
                  >
                    <div className="max-h-32 overflow-y-auto rounded-xl border border-[var(--rf-border)] bg-white/55 p-1 custom-scrollbar">
                      {activeWiDocs.map((doc) => {
                        const isSelected = selectedWiDocIds.includes(doc.docId);
                        const disabled = !isSelected && selectedWiDocIds.length >= 3;
                        return (
                          <button
                            key={doc.docId}
                            type="button"
                            disabled={disabled}
                            onClick={() => toggleRunWiDoc(doc.docId)}
                            className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition ${
                              isSelected
                                ? 'bg-[var(--sidebar-accent-subtle)] text-[var(--rf-text)]'
                                : 'hover:bg-white/70 text-[var(--rf-text-secondary)]'
                            } ${disabled ? 'opacity-45 cursor-not-allowed' : ''}`}
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-[12px] font-semibold">{doc.filename}</span>
                              <span className="block truncate text-[11px] text-[var(--rf-text-tertiary)]">{doc.chunkCount} chunks</span>
                            </span>
                            <span className="ml-3 shrink-0 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--sidebar-accent)]">
                              {isSelected ? 'Selected' : 'Pick'}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </div>
            </motion.div>
          </div>
        )}

        {/* ── Step 04: Requirement ── */}
        <div className="flex flex-col gap-1.5">
          <StepLabel number={activeWiDocs.length > 0 ? '04' : '03'} title="Requirement" />
          <motion.div
            className="rf-sidebar-card relative flex-[1] flex flex-col min-h-[220px] overflow-hidden transition-shadow"
            style={{
              boxShadow: !contextReady ? 'none' : undefined,
              opacity: !contextReady ? 0.55 : undefined,
            }}
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            custom={activeWiDocs.length > 0 ? 2 : 1.5}
          >
            {/* Scope-not-set overlay */}
            {!contextReady && (
              <div className="absolute inset-0 flex items-center justify-center bg-white/50 backdrop-blur-[2px] rounded-[inherit] z-10">
                <div className="text-center px-4">
                  <Orbit className="w-6 h-6 mx-auto mb-2 text-[var(--sidebar-accent)] opacity-40" />
                  <div className="text-[13px] font-semibold text-[var(--rf-text-secondary)]">Select a scope first</div>
                  <div className="text-[11px] text-[var(--rf-text-tertiary)] mt-1">Choose a project or workspace in Step 1</div>
                </div>
              </div>
            )}

            {/* Toolbar row */}
            <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 border-b border-[var(--rf-border-subtle)] bg-white/40">
              <div className="flex items-center gap-2.5 min-w-0">
                {originIssueKey && (
                  <span className="rounded-full bg-[var(--sidebar-accent-subtle)] border border-[var(--sidebar-accent-border)] px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--sidebar-accent)] truncate">
                    {originIssueKey}
                  </span>
                )}
                <span className="text-[11px] font-700 uppercase tracking-[0.13em] text-[var(--rf-text-tertiary)]">
                  Describe your requirement
                </span>
              </div>
              <motion.button
                type="button"
                onClick={() => runAttachmentInputRef.current?.click()}
                disabled={isWorking || !contextReady}
                title="Attach supporting files for this run only"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--sidebar-accent-border)] bg-[var(--sidebar-accent-subtle)] px-2.5 py-1.5 text-[12px] font-semibold text-[var(--sidebar-accent)] shadow-sm transition-all hover:border-[var(--sidebar-accent)] hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-40 backdrop-blur-sm"
                whileTap={{ scale: 0.97 }}
              >
                <Paperclip className="w-3 h-3" />
                <span>{runAttachmentParseState ? 'Parsing…' : runAttachments.length > 0 ? `${runAttachments.length} file${runAttachments.length > 1 ? 's' : ''}` : 'Add files'}</span>
              </motion.button>
              <input
                ref={runAttachmentInputRef}
                type="file"
                onChange={handleRunAttachmentUpload}
                accept=".pdf,.csv,.txt,.md,.eml"
                multiple
                className="hidden"
                disabled={isWorking || !contextReady}
              />
            </div>

            {/* Attached files */}
            {runAttachments.length > 0 && (
              <div className="px-3.5 pt-3 flex flex-wrap gap-1.5">
                {runAttachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className="flex items-center gap-1.5 rounded-xl border border-[var(--sidebar-accent-border)] bg-[var(--sidebar-accent-subtle)] px-2.5 py-1.5"
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
              placeholder={!contextReady ? 'Select a scope in Step 1 to enable input…' : 'Describe your feature or requirement…'}
              disabled={isWorking || !contextReady}
              className="flex-1 min-h-0 w-full bg-transparent border-none text-[var(--rf-text)] placeholder-[var(--rf-text-tertiary)] focus:outline-none text-[14px] leading-relaxed resize-none disabled:opacity-50 px-3.5 pt-3 pb-2 custom-scrollbar"
            />

            {/* Card footer */}
            <div className="flex items-center justify-between gap-3 border-t border-[var(--rf-border-subtle)] px-3.5 py-2 bg-white/30">
              <span className="text-[12px] text-[var(--rf-text-tertiary)]">
                {wordCount > 0 ? `${wordCount} word${wordCount !== 1 ? 's' : ''}` : 'No input yet'}
              </span>
              <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.13em] border transition-all ${
                hasPromptInput
                  ? 'bg-[var(--sidebar-accent-subtle)] text-[var(--sidebar-accent)] border-[var(--sidebar-accent-border)]'
                  : 'bg-white/50 text-[var(--rf-text-tertiary)] border-[var(--rf-border-subtle)]'
              }`}>
                {hasPromptInput ? 'Ready' : 'Add input'}
              </span>
            </div>
          </motion.div>
        </div>

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
                <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--sidebar-accent)]">
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
          className="shrink-0 space-y-2 mt-1"
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          custom={3}
        >
          {workspacePipelineAuditEnabled && setRecordPipelineAuditForRun && (
            <label className="flex items-start gap-2.5 px-1 cursor-pointer">
              <input
                type="checkbox"
                checked={recordPipelineAuditForRun}
                onChange={(e) => setRecordPipelineAuditForRun(e.target.checked)}
                className="mt-0.5 rounded border-[var(--rf-border)] accent-[var(--sidebar-accent)]"
              />
              <span className="text-[11px] font-semibold text-[var(--rf-text-secondary)] leading-snug">
                Record pipeline audit for this run (export prompts & trace after generation)
              </span>
            </label>
          )}
          {/* Primary CTA — profile-aware gradient */}
          <motion.button
            onClick={onStartBrainstorm}
            disabled={brainstormDisabled}
            title={isAtLimit ? 'Included monthly usage has been reached. Generation is still available.' : ''}
            className="brainstorm-shimmer w-full text-white text-[13px] font-bold py-[11px] rounded-[18px] transition-all flex items-center justify-center gap-2 border border-white/10 disabled:cursor-not-allowed"
            style={{
              background: brainstormDisabled
                ? 'var(--rf-border-strong)'
                : 'linear-gradient(135deg, var(--sidebar-cta-from), var(--sidebar-cta-mid), var(--sidebar-cta-to))',
              boxShadow: brainstormDisabled
                ? 'none'
                : '0 10px 32px -12px var(--sidebar-cta-shadow)',
              color: brainstormDisabled ? 'rgba(255,255,255,0.4)' : 'white',
            }}
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

    </aside>
  );
}