import React from 'react';
import { Paperclip, Plus, Clock, Settings, PanelLeftClose, Zap, X, Database, FileText, Orbit, ChevronDown, Gauge, Layers, Check, ChevronRight, History } from 'lucide-react';
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

const stepSlideVariants = {
  enter: (direction: number) => ({ x: direction * 28, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (direction: number) => ({ x: direction * -28, opacity: 0 }),
};

function profileAccentColor(profile: PipelineProfile): string {
  if (profile === 'fast') return 'rgb(234, 138, 46)';
  if (profile === 'quality') return 'rgb(82, 58, 118)';
  return 'rgb(43, 89, 74)';
}

function profileRgba(profile: PipelineProfile, alpha: number): string {
  if (profile === 'fast') return `rgba(234, 138, 46, ${alpha})`;
  if (profile === 'quality') return `rgba(82, 58, 118, ${alpha})`;
  return `rgba(43, 89, 74, ${alpha})`;
}

/** CSS custom properties driven by the active output profile — applied to the sidebar root. */
function profileCssVars(profile: PipelineProfile): React.CSSProperties {
  const themes: Record<PipelineProfile, Record<string, string>> = {
    fast: {
      '--sidebar-accent': 'rgb(234, 138, 46)',
      '--sidebar-accent-subtle': 'rgba(234, 138, 46, 0.08)',
      '--sidebar-accent-alpha': 'rgba(234, 138, 46, 0.06)',
      '--sidebar-accent-border': 'rgba(234, 138, 46, 0.25)',
      '--sidebar-cta-from': '#c47820',
      '--sidebar-cta-mid': '#ea8a2e',
      '--sidebar-cta-to': '#f0a04b',
      '--sidebar-cta-shadow': 'rgba(234, 138, 46, 0.45)',
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
      '--sidebar-accent': 'rgb(82, 58, 118)',
      '--sidebar-accent-subtle': 'rgba(82, 58, 118, 0.10)',
      '--sidebar-accent-alpha': 'rgba(82, 58, 118, 0.07)',
      '--sidebar-accent-border': 'rgba(82, 58, 118, 0.30)',
      '--sidebar-cta-from': '#3d2868',
      '--sidebar-cta-mid': '#523a76',
      '--sidebar-cta-to': '#6b4d8f',
      '--sidebar-cta-shadow': 'rgba(82, 58, 118, 0.60)',
    },
  };
  return themes[profile] as React.CSSProperties;
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
    { id: 'fast' as PipelineProfile, label: 'Fast', desc: 'Quick iteration · lighter analysis', Icon: Zap },
    { id: 'balanced' as PipelineProfile, label: 'Balanced', desc: 'Standard depth and quality', Icon: Gauge },
    { id: 'quality' as PipelineProfile, label: 'Quality', desc: 'Thorough analysis · richer output', Icon: Layers },
  ];

  // ── Stepper state ──────────────────────────────────────────────────
  const [currentStep, setCurrentStep] = React.useState(0);
  const [maxStep, setMaxStep] = React.useState(0);
  const [slideDirection, setSlideDirection] = React.useState<1 | -1>(1);

  const steps = React.useMemo(() => {
    const base: Array<{ id: 'scope' | 'profile' | 'instructions' | 'requirement'; label: string; number: string }> = [
      { id: 'scope', label: 'Scope', number: '01' },
      { id: 'profile', label: 'Profile', number: '02' },
    ];
    if (activeWiDocs.length > 0) {
      base.push({ id: 'instructions', label: 'Instructions', number: '03' });
      base.push({ id: 'requirement', label: 'Requirement', number: '04' });
    } else {
      base.push({ id: 'requirement', label: 'Requirement', number: '03' });
    }
    return base;
  }, [activeWiDocs.length]);

  const lastStepIdx = steps.length - 1;
  const isLastStep = currentStep === lastStepIdx;
  const currentStepDef = steps[currentStep] ?? steps[lastStepIdx];

  const goToStep = (idx: number) => {
    if (idx === currentStep || idx > maxStep || idx < 0) return;
    setSlideDirection(idx > currentStep ? 1 : -1);
    setCurrentStep(idx);
  };

  const goNext = () => {
    if (currentStep < lastStepIdx) {
      const next = currentStep + 1;
      setSlideDirection(1);
      setCurrentStep(next);
      setMaxStep(prev => Math.max(prev, next));
    }
  };

  const goBack = () => {
    if (currentStep > 0) {
      setSlideDirection(-1);
      setCurrentStep(prev => prev - 1);
    }
  };

  const continueDisabled = (currentStep === 0 && !contextReady) || isWorking;

  React.useEffect(() => {
    setCurrentStep(0);
    setMaxStep(0);
  }, [currentSessionId]);

  React.useEffect(() => {
    setCurrentStep(prev => Math.min(prev, lastStepIdx));
    setMaxStep(prev => Math.min(prev, lastStepIdx));
  }, [lastStepIdx]);

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
            onClick={onOpenHistory}
            className="p-2 rounded-xl transition-all text-[var(--rf-text-secondary)] bg-white/50 border border-[var(--rf-border)] hover:bg-white/80 hover:text-[var(--rf-text)]"
            title="History"
          >
            <History className="w-4 h-4" />
          </button>
          <button
            onClick={onToggleSidebar}
            className="p-2 rounded-xl transition-all text-[var(--rf-text-tertiary)] hover:bg-white/60 hover:text-[var(--rf-text)]"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>
      </motion.header>

      {/* ── Step indicator bar ── */}
      <div className="shrink-0 px-4 pt-3 pb-2.5 border-b border-[var(--rf-border-subtle)] bg-white/40 backdrop-blur-sm">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-black uppercase tracking-[0.14em] text-[var(--sidebar-accent)]">
            {currentStepDef.label}
          </span>
          <span className="text-[11px] font-medium text-[var(--rf-text-tertiary)]">
            {currentStep + 1} / {steps.length}
          </span>
        </div>
        <div className="flex items-center">
          {steps.map((step, idx) => (
            <React.Fragment key={step.id}>
              {idx > 0 && (
                <div
                  className="flex-1 h-px transition-colors duration-300"
                  style={{ backgroundColor: idx <= currentStep ? 'var(--sidebar-accent)' : 'var(--rf-border)' }}
                />
              )}
              <button
                type="button"
                onClick={() => goToStep(idx)}
                disabled={idx > maxStep}
                title={step.label}
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-black transition-all duration-200 ${
                  idx === currentStep
                    ? 'scale-110 text-white shadow-sm'
                    : idx < currentStep
                      ? 'hover:scale-105'
                      : ''
                } ${idx > maxStep ? 'cursor-default' : idx < currentStep ? 'cursor-pointer' : ''}`}
                style={
                  idx === currentStep
                    ? { backgroundColor: 'var(--sidebar-accent)', color: 'white' }
                    : idx < currentStep
                      ? {
                          backgroundColor: 'var(--sidebar-accent-subtle)',
                          color: 'var(--sidebar-accent)',
                          border: '1px solid var(--sidebar-accent-border)',
                        }
                      : {
                          backgroundColor: 'rgba(255,255,255,0.60)',
                          color: 'var(--rf-text-tertiary)',
                          border: '1px solid var(--rf-border)',
                          opacity: 0.6,
                        }
                }
              >
                {idx < currentStep ? <Check className="h-3 w-3" /> : step.number}
              </button>
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* ── Step content area ── */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <AnimatePresence mode="wait" custom={slideDirection}>
          <motion.div
            key={currentStepDef.id}
            custom={slideDirection}
            variants={stepSlideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-0 overflow-y-auto custom-scrollbar px-4 py-4 flex flex-col gap-2"
            style={{ background: `linear-gradient(to bottom, var(--sidebar-accent-alpha), transparent 220px)` }}
          >

            {/* ── STEP: Scope ── */}
            {currentStepDef.id === 'scope' && (
              <motion.div
                className="rf-sidebar-card relative flex flex-col flex-1"
                style={{
                  boxShadow: contextMode === 'undecided'
                    ? `0 0 0 2px var(--sidebar-accent-border), 0 4px 16px -6px var(--sidebar-cta-shadow), 0 1px 4px -1px var(--sidebar-cta-shadow)`
                    : undefined,
                }}
                variants={fadeUp}
                initial="hidden"
                animate="visible"
                custom={0}
              >
                {contextMode === 'undecided' && (
                  <motion.div
                    className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full bg-[var(--sidebar-accent)]"
                    animate={{ opacity: [0.4, 1, 0.4] }}
                    transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                  />
                )}

                <div className="px-3 pt-3 pb-3 flex flex-col flex-1 min-h-0">
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
                            <span className="hidden min-[380px]:inline-flex items-center gap-1 rounded-full border border-[var(--sidebar-accent-border)] bg-[var(--sidebar-accent-subtle)] px-2 py-0.5 text-[10px] font-semibold text-[var(--sidebar-accent)]">
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

                          <div className="flex items-center gap-2">
                            <div className="h-px flex-1 bg-[var(--rf-border)]" />
                            <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--rf-text-tertiary)]">or pick a project</span>
                            <div className="h-px flex-1 bg-[var(--rf-border)]" />
                          </div>

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

                          <div className="relative">
                            <input
                              value={projectFilter}
                              onChange={(e) => setProjectFilter(e.target.value)}
                              placeholder="Search projects…"
                              className="w-full rounded-xl border border-[var(--rf-border)] bg-white/65 px-3.5 py-2 text-[13px] font-medium text-[var(--rf-text)] outline-none transition-all placeholder:text-[var(--rf-text-tertiary)] focus:border-[var(--sidebar-accent)] focus:ring-2 focus:ring-[var(--sidebar-accent-subtle)] backdrop-blur-sm"
                            />
                          </div>

                          <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-[var(--rf-border)] bg-white/55 p-1 custom-scrollbar backdrop-blur-sm">
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
            )}

            {/* ── STEP: Profile ── */}
            {currentStepDef.id === 'profile' && (
              <div className="flex flex-col gap-2">
                <p className="px-0.5 text-[12px] text-[var(--rf-text-tertiary)] leading-relaxed">
                  Choose how much time and depth to apply to this run.
                </p>
                {profileOptions.map((option, optIdx) => {
                  const selected = pipelineProfile === option.id;
                  const depthLevel = option.id === 'fast' ? 1 : option.id === 'balanced' ? 2 : 3;
                  return (
                    <motion.button
                      key={option.id}
                      type="button"
                      onClick={() => onPipelineProfileChange(option.id)}
                      disabled={isWorking}
                      className={`w-full flex items-center gap-3 rounded-2xl border px-4 py-3.5 text-left transition-all disabled:opacity-50 ${
                        selected
                          ? 'shadow-sm'
                          : 'bg-white/60 border-[var(--rf-border)] hover:bg-white/80'
                      }`}
                      style={selected ? {
                        borderColor: profileRgba(option.id, 0.30),
                        borderLeftWidth: '3px',
                        borderLeftColor: profileAccentColor(option.id),
                        background: `linear-gradient(135deg, ${profileRgba(option.id, 0.08)}, ${profileRgba(option.id, 0.03)})`,
                      } : {
                        borderLeftWidth: '3px',
                        borderLeftColor: profileRgba(option.id, 0.35),
                      }}
                      whileTap={{ scale: 0.98 }}
                      variants={fadeUp}
                      initial="hidden"
                      animate="visible"
                      custom={optIdx * 0.12}
                    >
                      <div
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-all"
                        style={selected ? {
                          backgroundColor: profileAccentColor(option.id),
                          border: 'none',
                          color: 'white',
                        } : {
                          backgroundColor: profileRgba(option.id, 0.07),
                          border: `1px solid ${profileRgba(option.id, 0.20)}`,
                          color: profileAccentColor(option.id),
                        }}
                      >
                        <option.Icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className={`text-[14px] font-bold leading-tight ${selected ? 'text-[var(--rf-text)]' : 'text-[var(--rf-text-secondary)]'}`}>
                          {option.label}
                        </div>
                        <div className="text-[12px] text-[var(--rf-text-tertiary)] leading-snug mt-0.5">
                          {option.desc}
                        </div>
                        <div className="flex items-center gap-1 mt-1.5">
                          {[1, 2, 3].map((level) => (
                            <div
                              key={level}
                              className="h-1.5 rounded-full transition-all duration-200"
                              style={{
                                width: level <= depthLevel ? '14px' : '8px',
                                backgroundColor: level <= depthLevel
                                  ? profileRgba(option.id, selected ? 0.7 : 0.35)
                                  : profileRgba(option.id, 0.1),
                              }}
                            />
                          ))}
                          <span className="ml-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--rf-text-tertiary)]">
                            {depthLevel === 1 ? 'Quick' : depthLevel === 2 ? 'Standard' : 'Deep'}
                          </span>
                        </div>
                      </div>
                      <AnimatePresence>
                        {selected && (
                          <motion.div
                            key={`check-${option.id}`}
                            initial={{ scale: 0.5, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.5, opacity: 0 }}
                            transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white"
                            style={{ backgroundColor: profileAccentColor(option.id) }}
                          >
                            <Check className="h-3 w-3" />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </motion.button>
                  );
                })}
              </div>
            )}

            {/* ── STEP: Work Instructions ── */}
            {currentStepDef.id === 'instructions' && (
              <motion.div
                className="rf-sidebar-card flex flex-col flex-1"
                variants={fadeUp}
                initial="hidden"
                animate="visible"
                custom={0}
              >
                <div className="px-3.5 pt-3.5 pb-3.5 flex flex-col flex-1 min-h-0 space-y-3">
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

                  {wiSelectionMode === 'selected' && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                      className="overflow-hidden"
                    >
                      <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-[var(--rf-border)] bg-white/55 p-1 custom-scrollbar">
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
            )}

            {/* ── STEP: Requirement ── */}
            {currentStepDef.id === 'requirement' && (
              <motion.div
                className="rf-sidebar-card relative flex flex-col flex-1 overflow-hidden transition-shadow"
                style={{
                  boxShadow: !contextReady ? 'none' : undefined,
                  opacity: !contextReady ? 0.55 : undefined,
                }}
                variants={fadeUp}
                initial="hidden"
                animate="visible"
                custom={0}
              >
                {!contextReady && (
                  <div className="absolute inset-0 flex items-center justify-center bg-white/50 backdrop-blur-[2px] rounded-[inherit] z-10">
                    <div className="text-center px-4">
                      <Orbit className="w-6 h-6 mx-auto mb-2 text-[var(--sidebar-accent)] opacity-40" />
                      <div className="text-[13px] font-semibold text-[var(--rf-text-secondary)]">Select a scope first</div>
                      <div className="text-[11px] text-[var(--rf-text-tertiary)] mt-1">Go back to Step 1 to choose a project or workspace</div>
                    </div>
                  </div>
                )}

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

                <textarea
                  value={requirement}
                  onChange={(e) => setRequirement(e.target.value)}
                  placeholder={!contextReady ? 'Go back to Step 1 to select a scope…' : 'Describe your feature or requirement…'}
                  disabled={isWorking || !contextReady}
                  className="flex-1 min-h-0 w-full bg-transparent border-none text-[var(--rf-text)] placeholder-[var(--rf-text-tertiary)] focus:outline-none text-[14px] leading-relaxed resize-none disabled:opacity-50 px-3.5 pt-3 pb-2 custom-scrollbar"
                />

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
            )}

            {/* ── Attachment parse state / error ── */}
            {currentStepDef.id === 'requirement' && (runAttachmentParseState || runAttachmentError) && (
              <motion.div
                className={`rf-sidebar-card px-4 py-3 ${runAttachmentError ? 'border-[rgba(155,53,69,0.2)] bg-[var(--rf-danger-subtle)]' : ''}`}
                variants={fadeUp}
                initial="hidden"
                animate="visible"
                custom={1}
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

          </motion.div>
        </AnimatePresence>
      </div>

      {/* ── Footer navigation ── */}
      <div className="shrink-0 border-t border-[var(--rf-border-subtle)] px-4 pb-4 pt-3 bg-white/35 backdrop-blur-sm">
        {isLastStep ? (
          <div className="space-y-2">
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
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {currentStep > 0 && (
              <motion.button
                type="button"
                onClick={goBack}
                disabled={isWorking}
                className="rf-glass-btn flex-1 py-2.5 rounded-[18px] text-[var(--rf-text-secondary)] hover:text-[var(--rf-text)] text-[13px] font-semibold flex items-center justify-center gap-1 transition-all disabled:opacity-40"
                whileTap={{ scale: 0.97 }}
              >
                ← Back
              </motion.button>
            )}
            <motion.button
              type="button"
              onClick={goNext}
              disabled={continueDisabled}
              className={`flex items-center justify-center gap-1.5 rounded-[18px] py-2.5 text-[13px] font-bold transition-all disabled:cursor-not-allowed border border-white/10 ${currentStep > 0 ? 'flex-[2]' : 'w-full'}`}
              style={{
                background: continueDisabled
                  ? 'var(--rf-border-strong)'
                  : 'linear-gradient(135deg, var(--sidebar-cta-from), var(--sidebar-cta-mid), var(--sidebar-cta-to))',
                color: continueDisabled ? 'rgba(255,255,255,0.4)' : 'white',
                boxShadow: continueDisabled ? 'none' : '0 6px 20px -8px var(--sidebar-cta-shadow)',
              }}
              whileTap={!continueDisabled ? { scale: 0.98 } : {}}
            >
              Continue
              <ChevronRight className="h-4 w-4" />
            </motion.button>
          </div>
        )}
      </div>

    </aside>
  );
}
