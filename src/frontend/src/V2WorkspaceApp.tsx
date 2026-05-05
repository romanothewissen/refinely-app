import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { requestJira, view } from '@forge/bridge';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, ChevronRight, Download, Edit2, Plus, Settings, Trash2, UserRound } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { SettingsView } from './SettingsView';
import { V2HistoryModal, type V2HistoryEntry } from './V2HistoryModal';
import { ClarifyQuestionsView } from './ClarifyQuestionsView';
import { StepIndicator } from './components/StepIndicator';
import { api } from './hooks/useForge';
import type { ClarifyAnswer, ClarifyQuestion, LlmProvider } from './types';
import {
  V2_PREVIEW_LOADING_STEPS,
  V2_REFINEMENT_LOADING_STEPS,
  type V2LoadingMode,
  type V2LoadingStep,
  type V2ProgressDraftFeatureSummary,
  type V2ProgressEvent,
  type V2ProgressEventProgress,
  type V2ProgressStage,
} from './v2Progress';

type DiscoveryMode = 'light' | 'standard' | 'deep' | 'very_deep';
type ActorGroundingStatus = 'weak' | 'supported' | 'strong';
type ConversationStatus = 'preview_ready' | 'needs_scope_confirmation' | 'needs_discovery' | 'complete';
type SettingsSurface = 'workspace' | 'project';
type SettingsTab = 'models' | 'jira' | 'domain' | 'compliance';
type V2UiStep = 'input' | 'scope_review' | 'discovery' | 'complete';

interface ScopeCapability {
  id: string;
  label: string;
  rationale: string;
  confidence: 'low' | 'medium' | 'high';
}

interface ScopeHypothesis {
  capabilities: ScopeCapability[];
  actorSlots: Record<string, string | undefined>;
  openQuestions: string[];
  confidence: 'low' | 'medium' | 'high';
  actorGroundingStatus?: ActorGroundingStatus;
}

interface DiscoveryQuestion {
  id: string;
  categoryKey: string;
  question: string;
  rationale: string;
  suggestions: string[];
}

interface AcceptanceRequirement {
  given: string;
  when: string;
  then: string;
}

interface V2Feature {
  id: string;
  summary: string;
  description: string;
  storyPoints?: number;
  processCode?: string;
  acceptanceRequirements: AcceptanceRequirement[];
}

interface V2ResultBase {
  triage: {
    discoveryMode: DiscoveryMode;
    questionBudget: number;
    likelyCapabilityCount: number;
    likelyCapabilityShape: string;
    crudRisk: string;
    reasons: string[];
  };
  scopeHypothesis: ScopeHypothesis;
}

interface PreviewResult extends V2ResultBase {
  status: 'preview_ready' | 'needs_scope_confirmation';
  recommendedNextStep: 'confirm_scope' | 'run_discovery';
}

interface DiscoveryResult extends V2ResultBase {
  status: 'needs_discovery';
  discoveryQuestions: DiscoveryQuestion[];
  materialityHints: string[];
}

interface CompleteResult extends V2ResultBase {
  status: 'complete';
  features: V2Feature[];
  discoveryChanges: string[];
  quality: {
    crudLike: boolean;
    capabilityDepthScore: number;
    actorIssues: string[];
    warnings: string[];
  };
  promptUsage: {
    input: number;
    output: number;
  };
}

type V2Result = PreviewResult | DiscoveryResult | CompleteResult;

interface ConversationRecord extends V2HistoryEntry {
  projectKey: string | null;
  projectKeys: string[];
  latestResult: {
    result?: V2Result;
    requirement?: string;
  } | null;
  turns: Array<{
    turnId: string;
    turnType: string;
    createdAt: string;
    payload: {
      result?: V2Result;
    };
  }>;
}

interface DiscoveryAnswer {
  questionId: string;
  categoryKey: string;
  question: string;
  answer: string;
  selectedSuggestion?: string;
}

interface RunAttachment {
  id: string;
  filename: string;
  text: string;
  charCount: number;
}

interface PipelineAuditEntry {
  sessionId: string;
  auditRunId: string;
  updatedAt: string;
  llmCallCount: number;
  clarifyQuestionCount: number;
  clarifyAnswerCount: number;
  featureCount: number;
  acceptanceRequirementCount: number;
}

interface V2LoadingState {
  mode: V2LoadingMode;
  localStepIndex: number;
  serverProgress: V2ProgressEventProgress | null;
  provisionalItems: V2ProgressDraftFeatureSummary[];
}

interface EditableScopeDraft {
  capabilities: Array<{
    id: string;
    label: string;
    rationale: string;
    confidence: 'low' | 'medium' | 'high';
  }>;
  actorSlots: Record<string, string>;
  openQuestions: Array<{ id: string; text: string; keepOpen: boolean }>;
  confidence: 'low' | 'medium' | 'high';
}

function createSessionId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `v2_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}

function normalizeProjectKeys(projectKeys: string[]): string[] {
  return [...new Set(projectKeys.map((key) => String(key ?? '').trim()).filter((key) => key && key !== '*'))]
    .slice(0, 2)
    .sort((left, right) => left.localeCompare(right));
}

function inferProjectKeyFromIssueKey(issueKey?: string | null): string[] {
  const projectKey = String(issueKey ?? '').trim().split('-')[0] ?? '';
  return projectKey ? [projectKey] : [];
}

function extractAdfText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const candidate = node as { text?: string; content?: unknown[] };
  if (typeof candidate.text === 'string') return candidate.text;
  if (Array.isArray(candidate.content)) return candidate.content.map(extractAdfText).filter(Boolean).join(' ');
  return '';
}

async function fileToBase64(file: File): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.split(',')[1] || dataUrl);
    };
    reader.onerror = () => reject(new Error('Read failed'));
    reader.readAsDataURL(file);
  });
}

function resultFromConversation(conversation: ConversationRecord | null): V2Result | null {
  if (!conversation) return null;
  return conversation.latestResult?.result
    ?? conversation.turns[conversation.turns.length - 1]?.payload?.result
    ?? null;
}

function buildScopeDraft(scopeHypothesis?: ScopeHypothesis | null): EditableScopeDraft | null {
  if (!scopeHypothesis) return null;
  const usedCapabilityIds = new Set<string>();
  return {
    capabilities: (scopeHypothesis.capabilities ?? []).map((capability) => ({
      id: normalizeScopeCapabilityId(capability.id || capability.label, usedCapabilityIds),
      label: capability.label,
      rationale: capability.rationale,
      confidence: capability.confidence,
    })),
    actorSlots: Object.fromEntries(
      Object.entries(scopeHypothesis.actorSlots ?? {}).map(([slot, value]) => [slot, String(value ?? '')]),
    ),
    openQuestions: (scopeHypothesis.openQuestions ?? []).map((question, index) => ({
      id: `oq_${index + 1}`,
      text: question,
      keepOpen: true,
    })),
    confidence: scopeHypothesis.confidence,
  };
}

function normalizeScopeCapabilityId(value: string, used: Set<string>) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const base = (normalized.startsWith('cap_') ? normalized : `cap_${normalized || 'draft'}`).slice(0, 32) || 'cap_draft';
  let candidate = base;
  let duplicateIndex = 2;
  while (used.has(candidate)) {
    const suffix = `_${duplicateIndex}`;
    candidate = `${base.slice(0, Math.max(1, 32 - suffix.length))}${suffix}`;
    duplicateIndex += 1;
  }
  used.add(candidate);
  return candidate;
}

function buildScopePayload(draft: EditableScopeDraft): ScopeHypothesis {
  const usedCapabilityIds = new Set<string>();
  return {
    capabilities: draft.capabilities
      .map((capability) => ({
        ...capability,
        id: normalizeScopeCapabilityId(capability.id || capability.label, usedCapabilityIds),
        label: capability.label.trim(),
        rationale: capability.rationale.trim(),
      }))
      .filter((capability) => capability.label),
    actorSlots: Object.fromEntries(
      Object.entries(draft.actorSlots)
        .map(([slot, value]) => [slot, value.trim()])
        .filter(([, value]) => Boolean(value)),
    ),
    openQuestions: draft.openQuestions
      .map((question) => ({ ...question, text: question.text.trim() }))
      .filter((question) => question.keepOpen && question.text)
      .map((question) => question.text),
    confidence: draft.confidence,
  };
}

function deriveStepFromResult(result: V2Result | null): V2UiStep {
  if (!result) return 'input';
  if (result.status === 'complete') return 'complete';
  if (result.status === 'needs_discovery') return 'discovery';
  return 'scope_review';
}

function stepIndex(step: V2UiStep): number {
  if (step === 'input') return 0;
  if (step === 'scope_review') return 2;
  if (step === 'discovery') return 3;
  return 4;
}

function compactUiText(value: string) {
  return String(value ?? '')
    .replace(/\u2026/g, '...')
    .replace(/\u2318/g, 'Cmd')
    .replace(/\s+/g, ' ')
    .trim();
}

function createAuditRunId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `audit_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}

function actorSlotEntries(actorSlots: Record<string, string>) {
  return Object.entries(actorSlots);
}

function toProgressSummary(text: string, fallback: string): string {
  const compact = compactUiText(text);
  if (!compact) return fallback;
  if (compact.length <= 140) return compact;
  return `${compact.slice(0, 139).trimEnd()}…`;
}

function buildProvisionalLoadingItems(scopeDraft?: EditableScopeDraft | null): V2ProgressDraftFeatureSummary[] {
  return (scopeDraft?.capabilities ?? [])
    .slice(0, 6)
    .map((capability, index) => ({
      id: capability.id || `capability_${index + 1}`,
      summary: toProgressSummary(capability.label, `Planned capability ${index + 1}`),
    }))
    .filter((item) => Boolean(item.summary));
}

function getLoadingSteps(mode: V2LoadingMode): V2LoadingStep[] {
  return mode === 'preview' ? V2_PREVIEW_LOADING_STEPS : V2_REFINEMENT_LOADING_STEPS;
}

function getLoadingStepIndex(mode: V2LoadingMode, stage: V2ProgressStage): number {
  const steps = getLoadingSteps(mode);
  const exact = steps.findIndex((step) => step.stage === stage);
  if (exact >= 0) return exact;
  if (mode === 'refinement' && stage === 'triage') return 0;
  if (mode === 'refinement' && (stage === 'scope_hypothesis' || stage === 'discover')) return 1;
  if (mode === 'preview' && stage === 'persisting') return steps.length - 1;
  return 0;
}

const V2_STAGE_PROGRESS_DRIFT_MS: Record<V2LoadingMode, Partial<Record<V2ProgressStage, number>>> = {
  preview: {
    context: 2500,
    triage: 6000,
    scope_hypothesis: 9000,
    persisting: 2500,
  },
  refinement: {
    context: 3000,
    triage: 3000,
    scope_hypothesis: 5000,
    discover: 5000,
    discovery_synthesis: 7000,
    final_generation: 18000,
    coverage_repair: 8000,
    persisting: 6000,
  },
};

function easeOutQuad(progress: number) {
  return 1 - ((1 - progress) * (1 - progress));
}

function getDisplayedLoadingPercent(input: {
  mode: V2LoadingMode;
  activeIndex: number;
  stage: V2ProgressStage;
  updatedAt?: number | null;
  now: number;
}) {
  const steps = getLoadingSteps(input.mode);
  const boundedIndex = Math.min(Math.max(input.activeIndex, 0), Math.max(steps.length - 1, 0));
  const currentStep = steps[boundedIndex];
  if (!currentStep) return 0;

  const previousPercent = boundedIndex > 0 ? (steps[boundedIndex - 1]?.percent ?? 0) : 0;
  const targetPercent = currentStep.percent;
  const driftMs = V2_STAGE_PROGRESS_DRIFT_MS[input.mode][input.stage] ?? 6000;
  const startedAt = input.updatedAt ?? input.now;
  const elapsedMs = Math.max(0, input.now - startedAt);
  const stageProgress = Math.min(1, elapsedMs / driftMs);
  const displayed = previousPercent + ((targetPercent - previousPercent) * easeOutQuad(stageProgress));
  const minimumVisible = boundedIndex === 0 ? Math.min(targetPercent, 4) : previousPercent + 1;
  return Math.max(minimumVisible, Math.min(targetPercent, Math.round(displayed)));
}

function emptyLoadingState(mode: V2LoadingMode, provisionalItems: V2ProgressDraftFeatureSummary[] = []): V2LoadingState {
  return {
    mode,
    localStepIndex: 0,
    serverProgress: null,
    provisionalItems,
  };
}

export default function V2WorkspaceApp({
  initialViewMode = 'generate',
  initialSettingsSurface = 'workspace',
  initialSettingsTab = 'models',
  initialRequirement = '',
  onCloseSettings,
}: {
  initialViewMode?: 'generate' | 'settings';
  initialSettingsSurface?: SettingsSurface;
  initialSettingsTab?: SettingsTab;
  initialRequirement?: string;
  onCloseSettings?: () => void;
}) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [viewMode, setViewMode] = useState<'generate' | 'settings'>(initialViewMode);
  const [settingsStartSurface, setSettingsStartSurface] = useState<SettingsSurface>(initialSettingsSurface);
  const [settingsStartTab, setSettingsStartTab] = useState<SettingsTab>(initialSettingsTab);
  const [settingsStartProjectKey, setSettingsStartProjectKey] = useState<string>('*');
  const [requirement, setRequirement] = useState(initialRequirement);
  const [sessionId, setSessionId] = useState(() => createSessionId());
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [projectKeys, setProjectKeys] = useState<string[]>([]);
  const [contextMode, setContextMode] = useState<'undecided' | 'project' | 'global'>('undecided');
  const [workspaceSelectionVersion, setWorkspaceSelectionVersion] = useState(0);
  const [availableProjects, setAvailableProjects] = useState<Array<{ key: string; name: string }>>([]);
  const [wiDocs, setWiDocs] = useState<any[]>([]);
  const [selectedWiDocIds, setSelectedWiDocIds] = useState<string[]>([]);
  const [wiSelectionMode, setWiSelectionMode] = useState<'auto' | 'selected'>('auto');
  const [runAttachments, setRunAttachments] = useState<RunAttachment[]>([]);
  const [runAttachmentParseState, setRunAttachmentParseState] = useState<{ filename: string; stage: 'reading' | 'parsing' } | null>(null);
  const [runAttachmentError, setRunAttachmentError] = useState<string | null>(null);
  const [result, setResult] = useState<V2Result | null>(null);
  const [uiStep, setUiStep] = useState<V2UiStep>('input');
  const [scopeDraft, setScopeDraft] = useState<EditableScopeDraft | null>(null);
  const [discoveryAnswers, setDiscoveryAnswers] = useState<Record<string, DiscoveryAnswer>>({});
  const [history, setHistory] = useState<V2HistoryEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState<string | null>(null);
  const [loadingState, setLoadingState] = useState<V2LoadingState | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [originIssueKey, setOriginIssueKey] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [hasProjectSettingsAccess, setHasProjectSettingsAccess] = useState(false);
  const [tier, setTier] = useState('standard');
  const [brandingLogoUrl, setBrandingLogoUrl] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(initialViewMode !== 'settings');
  const [sidebarExiting, setSidebarExiting] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(420);
  const [usage, setUsage] = useState<{
    currentMonth: number;
    credentialMode?: 'byok' | 'hosted_sampler';
    quotaScope?: 'tenant' | 'user';
    resetCadence?: 'calendar_month';
    remainingFastCredits?: number;
    remainingBalancedCredits?: number;
    remainingQualityCredits?: number;
  } | null>(null);
  const [limits, setLimits] = useState<{ generationsPerMonth: number } | null>(null);
  const [sidebarCacheCounts, setSidebarCacheCounts] = useState<Record<string, number>>({});
  const [pipelineAuditEnabled, setPipelineAuditEnabled] = useState(false);
  const [recordPipelineAuditForRun, setRecordPipelineAuditForRun] = useState(false);
  const [currentAuditRunId, setCurrentAuditRunId] = useState<string | null>(null);
  const [auditEntries, setAuditEntries] = useState<PipelineAuditEntry[]>([]);
  const [isExportingAudit, setIsExportingAudit] = useState(false);
  const [isDeletingAudit, setIsDeletingAudit] = useState(false);
  const isResizing = useRef(false);

  const effectiveProjectKeys = useMemo(() => {
    if (projectKeys.length > 0) return projectKeys;
    return normalizeProjectKeys(inferProjectKeyFromIssueKey(originIssueKey));
  }, [originIssueKey, projectKeys]);
  const effectiveProjectKey = effectiveProjectKeys[0] ?? '*';
  const settingsProjectKey = settingsStartProjectKey !== '*' ? settingsStartProjectKey : effectiveProjectKey;
  const activeDiscoveryQuestions = result?.status === 'needs_discovery' ? result.discoveryQuestions : [];
  const canContinueFromScope = Boolean(scopeDraft && buildScopePayload(scopeDraft).capabilities.length > 0);

  const setSelectedProjectKeys = useCallback((
    nextKeys: string[],
    options?: { collapseWorkspace?: boolean; nextContextMode?: 'undecided' | 'project' | 'global' },
  ) => {
    const normalized = normalizeProjectKeys(nextKeys);
    const selectionChanged =
      normalized.length !== projectKeys.length || normalized.some((key, index) => key !== projectKeys[index]);

    if (selectionChanged && normalized.length > 0 && options?.collapseWorkspace !== false) {
      setWorkspaceSelectionVersion((prev) => prev + 1);
    }

    setProjectKeys(normalized);
    setContextMode(options?.nextContextMode ?? (normalized.length ? 'project' : 'global'));
  }, [projectKeys]);

  const closeSidebar = useCallback(() => {
    setSidebarExiting(true);
    window.setTimeout(() => {
      setSidebarOpen(false);
      setSidebarExiting(false);
    }, 270);
  }, []);

  const startResizing = (event: React.MouseEvent) => {
    event.preventDefault();
    isResizing.current = true;
  };

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (!isResizing.current) return;
      const nextWidth = Math.min(Math.max(300, event.clientX), window.innerWidth * 0.7);
      setSidebarWidth(nextWidth);
    };

    const endResizing = () => {
      isResizing.current = false;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', endResizing);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', endResizing);
    };
  }, []);

  useEffect(() => {
    const element = shellRef.current;
    if (!element) return;

    let frameId = 0;
    const syncHeight = () => {
      if (frameId) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        const nextHeight = Math.max(element.scrollHeight, document.documentElement.scrollHeight, document.body.scrollHeight);
        void (view as any).resize('100%', `${Math.ceil(nextHeight + 24)}px`);
      });
    };

    syncHeight();
    const observer = new ResizeObserver(() => syncHeight());
    observer.observe(element);
    window.addEventListener('resize', syncHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncHeight);
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, [viewMode, uiStep, result, historyOpen, loading, warning, error, sidebarOpen, scopeDraft]);

  useEffect(() => {
    let active = true;

    const loadBootstrapData = async () => {
      try {
        const [configRes, usageRes, jiraRes] = await Promise.all([
          api.getConfig() as Promise<any>,
          api.getUsage() as Promise<any>,
          api.discoverJira() as Promise<any>,
        ]);
        if (!active) return;

        setBrandingLogoUrl(configRes?.branding?.logoUrl || null);
        if (configRes?.tier) setTier(configRes.tier);
        if (configRes?.isAdmin !== undefined) setIsAdmin(Boolean(configRes.isAdmin));
        setPipelineAuditEnabled(Boolean(configRes?.developerTools?.pipelineAuditEnabled));
        if (usageRes?.usage) setUsage(usageRes.usage);
        if (usageRes?.limits) setLimits(usageRes.limits);

        const projects = Array.isArray(jiraRes?.projects) ? jiraRes.projects : [];
        setAvailableProjects(projects);
      } catch {
        // Keep the shell usable even if bootstrap data is partial.
      }
    };

    void loadBootstrapData();

    void loadHistory();
    return () => {
      active = false;
    };
  }, []);

  const refreshWorkspaceFlags = useCallback(async () => {
    try {
      const configRes = await api.getConfig() as any;
      setBrandingLogoUrl(configRes?.branding?.logoUrl || null);
      if (configRes?.tier) setTier(configRes.tier);
      if (configRes?.isAdmin !== undefined) setIsAdmin(Boolean(configRes.isAdmin));
      setPipelineAuditEnabled(Boolean(configRes?.developerTools?.pipelineAuditEnabled));
    } catch {
      // Best-effort only.
    }
  }, []);

  useEffect(() => {
    if (!pipelineAuditEnabled) {
      setRecordPipelineAuditForRun(false);
      setCurrentAuditRunId(null);
      setAuditEntries([]);
    }
  }, [pipelineAuditEnabled]);

  useEffect(() => {
    if (!loadingState) return;
    if (loadingState.serverProgress) return;

    const steps = getLoadingSteps(loadingState.mode);
    const maxIndex = Math.max(0, steps.length - 1);
    const tickMs = loadingState.mode === 'preview' ? 850 : 1100;
    const timer = window.setInterval(() => {
      setLoadingState((previous) => {
        if (!previous || previous.serverProgress || previous.mode !== loadingState.mode) return previous;
        return {
          ...previous,
          localStepIndex: Math.min(previous.localStepIndex + 1, maxIndex),
        };
      });
    }, tickMs);

    return () => window.clearInterval(timer);
  }, [loadingState]);

  useEffect(() => {
    let active = true;

    void view.getContext().then(async (ctx: any) => {
      if (!active) return;
      const issueKey = ctx?.extension?.issue?.key as string | undefined;
      const ctxProjectKey =
        (ctx?.extension?.project?.key as string | undefined)
        || (ctx?.extension?.projectKey as string | undefined)
        || (issueKey ? issueKey.split('-')[0] : undefined);

      if (ctxProjectKey) {
        setSelectedProjectKeys([ctxProjectKey], { collapseWorkspace: false });
      }

      if (issueKey) {
        setOriginIssueKey(issueKey);
        try {
          const issueRes = await requestJira(`/rest/api/3/issue/${issueKey}?fields=summary,description`);
          if (!active || !issueRes.ok) return;
          const data = await issueRes.json() as any;
          const summary = String(data?.fields?.summary ?? '').trim();
          const description = extractAdfText(data?.fields?.description);
          const prefill = [summary, description].filter(Boolean).join('\n\n');
          if (prefill.trim()) setRequirement(prefill);
        } catch {
          // ignore context fetch issues
        }
      }
    }).catch(() => {});

    return () => {
      active = false;
    };
  }, [setSelectedProjectKeys]);

  useEffect(() => {
    let active = true;
    if (!settingsProjectKey || settingsProjectKey === '*') {
      setHasProjectSettingsAccess(false);
      return;
    }

    void api.checkIsAdmin({ projectKey: settingsProjectKey })
      .then((response: any) => {
        if (active) setHasProjectSettingsAccess(Boolean(response?.isProjectAdmin));
      })
      .catch(() => {
        if (active) setHasProjectSettingsAccess(false);
      });

    return () => {
      active = false;
    };
  }, [settingsProjectKey]);

  useEffect(() => {
    let cancelled = false;
    const selectedKeys = effectiveProjectKeys.filter((key) => key && key !== '*');
    if (!selectedKeys.length) {
      setSidebarCacheCounts({});
      return;
    }

    void Promise.all(selectedKeys.map(async (key) => {
      try {
        const response = await api.getBacklogCacheInfo(key) as any;
        return [key, response?.success ? (response.issueCount ?? 0) : 0] as const;
      } catch {
        return [key, 0] as const;
      }
    })).then((entries) => {
      if (!cancelled) setSidebarCacheCounts(Object.fromEntries(entries));
    });

    return () => {
      cancelled = true;
    };
  }, [effectiveProjectKeys]);

  useEffect(() => {
    const loadWiDocs = async () => {
      try {
        const keys = effectiveProjectKeys.length ? effectiveProjectKeys : ['*'];
        const results = await Promise.all(keys.map((key) => api.listWiDocs(key) as Promise<any>));
        const docsById = new Map<string, any>();
        results.forEach((response: any) => {
          (Array.isArray(response?.docs) ? response.docs : []).forEach((doc: any) => {
            docsById.set(doc.docId, doc);
          });
        });
        const nextDocs = [...docsById.values()];
        setWiDocs(nextDocs);
        setSelectedWiDocIds((prev) => prev.filter((id) => nextDocs.some((doc: any) => doc.docId === id)));
      } catch {
        // noop
      }
    };

    void loadWiDocs();
  }, [effectiveProjectKeys]);

  async function loadHistory() {
    try {
      const response = await api.v2GetHistory(50) as { success?: boolean; conversations?: V2HistoryEntry[]; warning?: string };
      if (response?.success) {
        setHistory(response.conversations ?? []);
        if (response.warning) setWarning(response.warning);
      }
    } catch {
      // Keep history best-effort.
    }
  }

  const loadAuditEntries = useCallback(async (targetSessionId: string) => {
    if (!pipelineAuditEnabled || !targetSessionId) {
      setAuditEntries([]);
      return;
    }
    try {
      const response = await api.listPipelineAudits({ sessionId: targetSessionId, limit: 10 }) as {
        success?: boolean;
        audits?: PipelineAuditEntry[];
      };
      if (response?.success) {
        setAuditEntries(Array.isArray(response.audits) ? response.audits : []);
      }
    } catch {
      // Best-effort only.
    }
  }, [pipelineAuditEnabled]);

  const resetDraftState = useCallback((nextRequirement = '') => {
    const nextSessionId = createSessionId();
    setSelectedConversationId(null);
    setSessionId(nextSessionId);
    setRequirement(nextRequirement);
    setResult(null);
    setUiStep(nextRequirement.trim() ? 'input' : 'input');
    setScopeDraft(null);
    setDiscoveryAnswers({});
    setWarning(null);
    setError(null);
    setLoadingMessage(null);
    setLoadingState(null);
    setRunAttachments([]);
    setRunAttachmentParseState(null);
    setRunAttachmentError(null);
    setCurrentAuditRunId(null);
    setAuditEntries([]);
  }, []);

  const openSettings = useCallback((surface: SettingsSurface = (isAdmin ? 'workspace' : 'project')) => {
    setSettingsStartSurface(surface);
    setViewMode('settings');
    if (sidebarOpen) closeSidebar();
  }, [closeSidebar, isAdmin, sidebarOpen]);

  const openProjectSettings = useCallback((tab: 'models' | 'jira' | 'domain', projectKeyForSettings: string) => {
    setSettingsStartSurface('project');
    setSettingsStartTab(tab);
    setSettingsStartProjectKey(projectKeyForSettings);
    openSettings('project');
  }, [openSettings]);

  const handleAddRunAttachments = async (files: File[]) => {
    if (!files.length) return;
    setRunAttachmentError(null);

    try {
      const parsedAttachments: RunAttachment[] = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const label = files.length > 1 ? `${file.name} (${index + 1}/${files.length})` : file.name;
        setRunAttachmentParseState({ filename: label, stage: 'reading' });
        const base64 = await fileToBase64(file);
        setRunAttachmentParseState({ filename: label, stage: 'parsing' });
        const response = await api.parseRunAttachment(file.name, base64) as any;
        if (response?.success === false) {
          throw new Error(response.error || `Could not parse ${file.name}`);
        }
        parsedAttachments.push({
          id: `${file.name}_${file.size}_${file.lastModified}`,
          filename: response?.filename || file.name,
          text: String(response?.text ?? ''),
          charCount: Number(response?.charCount ?? String(response?.text ?? '').length),
        });
      }

      setRunAttachments((previous) => {
        const next = new Map(previous.map((attachment) => [attachment.id, attachment]));
        parsedAttachments.forEach((attachment) => {
          next.set(attachment.id, attachment);
        });
        return [...next.values()];
      });
    } catch (attachmentError: any) {
      setRunAttachmentError(attachmentError?.message || 'Could not parse the selected attachment.');
    } finally {
      setRunAttachmentParseState(null);
    }
  };

  const handleRemoveRunAttachment = (attachmentId: string) => {
    setRunAttachments((previous) => previous.filter((attachment) => attachment.id !== attachmentId));
    setRunAttachmentError(null);
  };

  const attachmentText = useMemo(
    () => runAttachments.map((attachment) => `--- ${attachment.filename} ---\n${attachment.text}`).join('\n\n'),
    [runAttachments],
  );
  const runWiSelectionPayload = useMemo(() => {
    if (wiSelectionMode === 'auto') {
      return {
        includeWiContext: true,
        selectedWiDocIds: undefined as string[] | undefined,
      };
    }
    if (!selectedWiDocIds.length) {
      return {
        includeWiContext: false,
        selectedWiDocIds: [] as string[],
      };
    }
    return {
      includeWiContext: true,
      selectedWiDocIds,
    };
  }, [wiSelectionMode, selectedWiDocIds]);

  const restoreConversation = async (nextSessionId: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.v2GetConversation(nextSessionId) as { success?: boolean; conversation?: ConversationRecord | null; error?: string };
      if (!response?.success || !response.conversation) {
        throw new Error(response?.error || 'Conversation not found.');
      }

      const restoredResult = resultFromConversation(response.conversation);
      setSessionId(response.conversation.sessionId);
      setSelectedConversationId(response.conversation.sessionId);
      setRequirement(response.conversation.requirement ?? '');
      setResult(restoredResult);
      setUiStep(deriveStepFromResult(restoredResult));
      setScopeDraft(buildScopeDraft(restoredResult?.scopeHypothesis ?? null));
      setDiscoveryAnswers({});
      setLoadingMessage(null);
      setLoadingState(null);
      setViewMode('generate');
      void loadAuditEntries(response.conversation.sessionId);
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : 'Unable to load V2 session.');
    } finally {
      setLoading(false);
    }
  };

  const deleteConversation = async (sessionToDelete: string) => {
    try {
      await api.v2DeleteConversation(sessionToDelete);
      if (selectedConversationId === sessionToDelete) {
        resetDraftState(requirement);
      }
      await loadHistory();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not delete V2 session.');
    }
  };

  const handlePreview = async () => {
    if (!requirement.trim() && !runAttachments.length) return;
    setLoading(true);
    setLoadingMessage('Building scope preview…');
    setLoadingState(emptyLoadingState('preview'));
    setError(null);
    setWarning(null);
    try {
      const auditRunId = pipelineAuditEnabled && recordPipelineAuditForRun
        ? (currentAuditRunId ?? createAuditRunId())
        : undefined;
      if (auditRunId && auditRunId !== currentAuditRunId) setCurrentAuditRunId(auditRunId);
      const response = await api.v2Preview({
        sessionId,
        requirement,
        attachmentText,
        projectKeys: effectiveProjectKeys,
        selectedWiDocIds: runWiSelectionPayload.selectedWiDocIds,
        includeWiContext: runWiSelectionPayload.includeWiContext,
        includeSimilarStories: false,
        pipelineAudit: Boolean(auditRunId),
        auditRunId,
      }) as { success?: boolean; error?: string; warning?: string; sessionId?: string; result?: V2Result };
      if (!response?.success || !response.result) {
        throw new Error(response?.error || 'Preview failed.');
      }
      const nextSessionId = response.sessionId ?? sessionId;
      setSessionId(nextSessionId);
      setSelectedConversationId(nextSessionId);
      setResult(response.result);
      setScopeDraft(buildScopeDraft(response.result.scopeHypothesis));
      setDiscoveryAnswers({});
      setUiStep('scope_review');
      setLoadingMessage(null);
      setLoadingState(null);
      setWarning(response.warning ?? null);
      void loadHistory();
      void loadAuditEntries(nextSessionId);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : 'Preview failed.');
      setLoadingState(null);
    } finally {
      setLoading(false);
      setLoadingMessage(null);
    }
  };

  const applyV2Result = useCallback((nextSessionId: string, nextResult: V2Result, nextWarning?: string | null) => {
    setSessionId(nextSessionId);
    setSelectedConversationId(nextSessionId);
    setResult(nextResult);
    setScopeDraft(buildScopeDraft(nextResult.scopeHypothesis));
    setUiStep(deriveStepFromResult(nextResult));
    setWarning(nextWarning ?? null);
  }, []);

  const hydrateQueuedV2Result = useCallback(async (nextSessionId: string) => {
    const response = await api.v2GetConversation(nextSessionId) as {
      success?: boolean;
      conversation?: ConversationRecord | null;
      error?: string;
    };
    if (!response?.success || !response.conversation) {
      throw new Error(response?.error || 'Queued refinement finished, but the saved result could not be loaded.');
    }

    const hydratedResult = resultFromConversation(response.conversation);
    if (!hydratedResult) {
      throw new Error('Queued refinement finished, but the saved result was empty.');
    }

    applyV2Result(nextSessionId, hydratedResult);
    try {
      await api.v2ClearProgress(nextSessionId);
    } catch {
      // Best-effort cleanup only.
    }
    setLoadingState(null);
    void loadHistory();
    void loadAuditEntries(nextSessionId);
  }, [applyV2Result, loadAuditEntries]);

  const waitForQueuedV2Generation = useCallback(async (nextSessionId: string) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 15 * 60 * 1000) {
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      const progressResponse = await api.v2GetProgress(nextSessionId) as {
        success?: boolean;
        progress?: V2ProgressEvent;
      };
      const progress = progressResponse?.progress;
      if (!progress) continue;

      if (progress.type === 'progress') {
        setLoadingMessage(progress.message ?? 'Refining backlog…');
        setLoadingState((previous) => previous ? {
          ...previous,
          localStepIndex: Math.max(previous.localStepIndex, getLoadingStepIndex(previous.mode, progress.stage)),
          serverProgress: progress,
        } : previous);
        continue;
      }

      if (progress.type === 'complete') {
        setLoadingMessage('Opening the saved refinement…');
        setLoadingState((previous) => previous ? {
          ...previous,
          serverProgress: {
            type: 'progress',
            sessionId: nextSessionId,
            stage: previous.serverProgress?.stage
              ?? getLoadingSteps(previous.mode)[Math.min(previous.localStepIndex, getLoadingSteps(previous.mode).length - 1)]?.stage
              ?? 'final_generation',
            message: 'Opening the saved refinement…',
            updatedAt: Date.now(),
          },
        } : previous);
        await hydrateQueuedV2Result(nextSessionId);
        return;
      }

      if (progress.type === 'error') {
        throw new Error(progress.message || 'Full refinement failed.');
      }
    }

    throw new Error('V2 refinement is taking longer than expected. Please try again.');
  }, [hydrateQueuedV2Result]);

  const handleGenerate = async (answerOverride?: Record<string, DiscoveryAnswer>) => {
    if (!scopeDraft) return;
    setLoading(true);
    setLoadingMessage('Preparing refinement…');
    setLoadingState(emptyLoadingState('refinement', buildProvisionalLoadingItems(scopeDraft)));
    setError(null);
    setWarning(null);
    try {
      const auditRunId = pipelineAuditEnabled && recordPipelineAuditForRun
        ? (currentAuditRunId ?? createAuditRunId())
        : undefined;
      if (auditRunId && auditRunId !== currentAuditRunId) setCurrentAuditRunId(auditRunId);
      const response = await api.v2Generate({
        sessionId,
        requirement,
        attachmentText,
        projectKeys: effectiveProjectKeys,
        selectedWiDocIds: runWiSelectionPayload.selectedWiDocIds,
        includeWiContext: runWiSelectionPayload.includeWiContext,
        includeSimilarStories: true,
        triageOverride: result?.triage,
        confirmedScopeHypothesis: buildScopePayload(scopeDraft),
        discoveryAnswers: Object.values(answerOverride ?? discoveryAnswers),
        pipelineAudit: Boolean(auditRunId),
        auditRunId,
      }) as { success?: boolean; error?: string; warning?: string; sessionId?: string; result?: V2Result; queued?: boolean };
      if (!response?.success) {
        throw new Error(response?.error || 'Full refinement failed.');
      }
      const nextSessionId = response.sessionId ?? sessionId;
      if (response.queued) {
        setSelectedConversationId(nextSessionId);
        setWarning(response.warning ?? null);
        setLoadingMessage('Queued refinement is running…');
        await waitForQueuedV2Generation(nextSessionId);
      } else if (response.result) {
        applyV2Result(nextSessionId, response.result, response.warning ?? null);
        setLoadingState(null);
        void loadHistory();
        void loadAuditEntries(nextSessionId);
      } else {
        throw new Error('Full refinement failed.');
      }
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : 'Full refinement failed.');
      setLoadingState(null);
    } finally {
      setLoading(false);
      setLoadingMessage(null);
    }
  };

  const latestAuditEntry = auditEntries[0] ?? null;

  const exportAudit = useCallback(async (entry: PipelineAuditEntry | null) => {
    if (!entry) return;
    setIsExportingAudit(true);
    setError(null);
    try {
      const response = await api.getPipelineAudit({
        sessionId: entry.sessionId,
        auditRunId: entry.auditRunId,
      }) as { success?: boolean; error?: string; bundle?: unknown };
      if (!response?.success || !response.bundle) {
        throw new Error(response?.error || 'Could not load the pipeline audit bundle.');
      }
      const blob = new Blob([JSON.stringify(response.bundle, null, 2)], { type: 'application/json' });
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = `pipeline-audit_${entry.sessionId}_${entry.auditRunId}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (auditError) {
      setError(auditError instanceof Error ? auditError.message : 'Could not export the pipeline audit.');
    } finally {
      setIsExportingAudit(false);
    }
  }, []);

  const deleteAudit = useCallback(async (entry: PipelineAuditEntry | null) => {
    if (!entry) return;
    setIsDeletingAudit(true);
    setError(null);
    try {
      const response = await api.deletePipelineAudit({
        sessionId: entry.sessionId,
        auditRunId: entry.auditRunId,
      }) as { success?: boolean; error?: string };
      if (!response?.success) {
        throw new Error(response?.error || 'Could not delete the pipeline audit.');
      }
      if (entry.auditRunId === currentAuditRunId) {
        setCurrentAuditRunId(null);
      }
      await loadAuditEntries(entry.sessionId);
    } catch (auditError) {
      setError(auditError instanceof Error ? auditError.message : 'Could not delete the pipeline audit.');
    } finally {
      setIsDeletingAudit(false);
    }
  }, [currentAuditRunId, loadAuditEntries]);

  return (
    <div ref={shellRef} className="flex h-full w-full overflow-hidden text-[var(--rf-text)] font-sans bg-transparent">
      <AnimatePresence>
        {(sidebarOpen || sidebarExiting) && (
          <motion.div
            key="sidebar"
            initial={{ opacity: 0, x: -16, width: 0 }}
            animate={{ opacity: 1, x: 0, width: sidebarWidth }}
            exit={{ opacity: 0, x: -16, width: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="shrink-0 overflow-hidden shadow-2xl z-40 relative"
          >
            <div className="relative h-full w-full flex">
              <Sidebar
                viewMode={viewMode}
                setViewMode={(mode: 'generate' | 'settings') => {
                  if (mode === 'settings') openSettings();
                  else setViewMode(mode);
                }}
                requirement={requirement}
                setRequirement={setRequirement}
                onStartBrainstorm={() => {
                  void handlePreview();
                  closeSidebar();
                }}
                onNewSession={() => {
                  resetDraftState('');
                  if (effectiveProjectKeys.length > 0) {
                    setSelectedProjectKeys(effectiveProjectKeys, { collapseWorkspace: false });
                  }
                }}
                conversations={history}
                currentSessionId={sessionId}
                onRestoreSession={async (sid: string) => {
                  await restoreConversation(sid);
                  closeSidebar();
                }}
                isWorking={loading}
                onToggleSidebar={closeSidebar}
                onOpenHistory={() => setHistoryOpen(true)}
                isAdmin={isAdmin || hasProjectSettingsAccess}
                tier={tier}
                usage={usage}
                limits={limits}
                brandingLogoUrl={brandingLogoUrl}
                reviewBeforeARs={false}
                width={sidebarWidth}
                originIssueKey={originIssueKey}
                projectKeys={effectiveProjectKeys}
                setProjectKeys={setSelectedProjectKeys}
                contextMode={effectiveProjectKeys.length ? 'project' : contextMode}
                setContextMode={setContextMode}
                workspaceSelectionVersion={workspaceSelectionVersion}
                availableProjects={availableProjects}
                cacheCountsByProject={sidebarCacheCounts}
                wiDocs={wiDocs}
                wiSelectionMode={wiSelectionMode}
                setWiSelectionMode={setWiSelectionMode}
                selectedWiDocIds={selectedWiDocIds}
                setSelectedWiDocIds={setSelectedWiDocIds}
                onOpenProjectSettings={openProjectSettings}
                runAttachments={runAttachments}
                runAttachmentParseState={runAttachmentParseState}
                runAttachmentError={runAttachmentError}
                onAddRunAttachments={handleAddRunAttachments}
                onRemoveRunAttachment={handleRemoveRunAttachment}
                workspacePipelineAuditEnabled={pipelineAuditEnabled}
                recordPipelineAuditForRun={recordPipelineAuditForRun}
                setRecordPipelineAuditForRun={setRecordPipelineAuditForRun}
                primaryActionLabel="Preview Scope"
              />
              {sidebarOpen && (
                <div
                  onMouseDown={startResizing}
                  className="absolute top-0 -right-1.5 w-3 h-full cursor-col-resize group z-50 transition-colors flex items-center justify-center"
                  style={{ cursor: 'col-resize' }}
                >
                  <div className="w-1 h-8 bg-white/20 group-hover:bg-white/45 rounded-full transition-colors" />
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {viewMode === 'settings' && (isAdmin || hasProjectSettingsAccess) ? (
        <SettingsView
          onClose={() => {
            if (onCloseSettings) {
              onCloseSettings();
              return;
            }
            void refreshWorkspaceFlags();
            setViewMode('generate');
            setSidebarOpen(true);
          }}
          initialSurface={settingsStartSurface}
          initialTab={settingsStartTab}
          initialProjectKey={settingsStartProjectKey}
        />
      ) : (
        <div className="rf-main-shell rf-pane-seam flex-1 flex flex-col h-full relative overflow-hidden">
          <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-[var(--rf-border-subtle)] bg-white/58 backdrop-blur-xl">
            <div>
              <div className="text-[11px] font-black uppercase tracking-[0.14em] text-[var(--rf-text-tertiary)]">Refinely Core V2</div>
              <h1 className="mt-1 text-[28px] leading-tight text-[var(--rf-text)]">Scope first, then refine with intent</h1>
            </div>
            <div className="flex items-center gap-2">
              {!sidebarOpen && (
                <button
                  type="button"
                  onClick={() => setSidebarOpen(true)}
                  className="inline-flex items-center gap-2 rounded-xl border border-[var(--rf-border)] bg-white/75 px-3 py-2 text-sm font-semibold text-[var(--rf-text-secondary)] hover:bg-white"
                >
                  <ChevronRight className="w-4 h-4 rotate-180" />
                  Sidebar
                </button>
              )}
              <button
                type="button"
                onClick={() => openSettings()}
                className="inline-flex items-center gap-2 rounded-xl border border-[var(--rf-border)] bg-white/75 px-3 py-2 text-sm font-semibold text-[var(--rf-text-secondary)] hover:bg-white"
              >
                <Settings className="w-4 h-4" />
                Settings
              </button>
            </div>
          </div>

          {(warning || error) && (
            <div className="px-6 pt-4">
              {warning && (
                <div className="rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: 'rgba(160,81,30,0.2)', background: 'rgba(160,81,30,0.08)', color: 'var(--rf-warning)' }}>
                  {warning}
                </div>
              )}
              {error && (
                <div className="mt-3 rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: 'rgba(155,53,69,0.2)', background: 'rgba(155,53,69,0.08)', color: 'var(--rf-danger)' }}>
                  {error}
                </div>
              )}
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-6 py-5">
            <V2Canvas
              loading={loading}
              loadingMessage={loadingMessage}
              loadingState={loadingState}
              result={result}
              uiStep={uiStep}
              scopeDraft={scopeDraft}
              setScopeDraft={setScopeDraft}
              discoveryAnswers={discoveryAnswers}
              setDiscoveryAnswers={setDiscoveryAnswers}
              onGenerate={handleGenerate}
              onReset={() => {
                resetDraftState('');
                setSidebarOpen(true);
              }}
              onReturnToScope={() => setUiStep('scope_review')}
              canContinueFromScope={canContinueFromScope}
              sidebarOpen={sidebarOpen}
              setSidebarOpen={setSidebarOpen}
              pipelineAuditEnabled={pipelineAuditEnabled}
              recordPipelineAuditForRun={recordPipelineAuditForRun}
              latestAuditEntry={latestAuditEntry}
              auditEntryCount={auditEntries.length}
              isExportingAudit={isExportingAudit}
              isDeletingAudit={isDeletingAudit}
              onExportAudit={() => void exportAudit(latestAuditEntry)}
              onDeleteAudit={() => void deleteAudit(latestAuditEntry)}
            />
          </div>
        </div>
      )}

      {historyOpen && (
        <V2HistoryModal
          onClose={() => setHistoryOpen(false)}
          onRestore={async (sid) => {
            await restoreConversation(sid);
            closeSidebar();
            setHistoryOpen(false);
          }}
          onDelete={deleteConversation}
          conversations={history}
          currentSessionId={selectedConversationId ?? sessionId}
        />
      )}
    </div>
  );
}

function StepRail({ uiStep }: { uiStep: V2UiStep }) {
  const steps = [
    { id: 'input', label: 'Input' },
    { id: 'preview', label: 'Preview' },
    { id: 'scope_review', label: 'Scope Review' },
    { id: 'discovery', label: 'Discovery' },
    { id: 'complete', label: 'Complete' },
  ];
  const completedSteps = new Set(
    steps
      .filter((_, index) => index < stepIndex(uiStep))
      .map((step) => step.id),
  );

  return (
    <StepIndicator
      steps={steps}
      activeStep={uiStep}
      completedSteps={completedSteps}
      onStepClick={() => {}}
    />
  );
}

function V2LoadingSurface({
  mode,
  loadingMessage,
  activeStep,
  activeIndex,
  serverProgress,
  items,
}: {
  mode: V2LoadingMode;
  loadingMessage: string | null;
  activeStep: V2LoadingStep;
  activeIndex: number;
  serverProgress: V2ProgressEventProgress | null;
  items: V2ProgressDraftFeatureSummary[];
}) {
  const steps = getLoadingSteps(mode);
  const statusLine = loadingMessage || serverProgress?.message || activeStep.label;
  const listHeading = serverProgress?.draftFeatures?.length
    ? 'Draft features arriving'
    : mode === 'refinement'
      ? 'Planned capabilities'
      : 'Live progress';
  const listNote = serverProgress?.featureCounts?.drafted && serverProgress.featureCounts.drafted > items.length
    ? `${serverProgress.featureCounts.drafted} total drafts in progress`
    : null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 300);
    return () => window.clearInterval(timer);
  }, []);

  const displayedPercent = getDisplayedLoadingPercent({
    mode,
    activeIndex,
    stage: serverProgress?.stage ?? activeStep.stage,
    updatedAt: serverProgress?.updatedAt ?? null,
    now,
  });

  return (
    <motion.section
      className="rf-card overflow-hidden"
      initial={{ opacity: 0, y: 12, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="relative overflow-hidden border-b border-[var(--rf-border-subtle)] bg-[linear-gradient(135deg,rgba(255,255,255,0.98),rgba(237,246,242,0.92))] px-6 py-6">
        <div className="absolute inset-y-0 right-0 w-[36%] bg-[radial-gradient(circle_at_top_right,rgba(43,89,74,0.12),transparent_62%)]" />
        <div className="relative flex flex-wrap items-start justify-between gap-5">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.18em] text-[var(--rf-brand)]">
              <span className="h-2 w-2 rounded-full bg-[var(--rf-brand)] animate-pulse" />
              {mode === 'preview' ? 'Preview Running' : 'Refinement Running'}
            </div>
            <h2 className="mt-3 text-[24px] font-black tracking-tight text-[var(--rf-text)]" style={{ fontFamily: 'Fraunces, serif' }}>
              {activeStep.label}
            </h2>
            <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-[var(--rf-text-secondary)]">
              {activeStep.summary}
            </p>
            <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-[var(--rf-border)] bg-white/82 px-4 py-2 text-[13px] font-semibold text-[var(--rf-text-secondary)] shadow-sm">
              <span className="flex gap-1 dot-bounce"><span /><span /><span /></span>
              {compactUiText(statusLine)}
            </div>
          </div>
          <div className="rounded-[22px] border border-[var(--rf-border)] bg-white/78 px-4 py-3 shadow-sm">
            <div className="text-[11px] font-black uppercase tracking-[0.14em] text-[var(--rf-text-tertiary)]">Progress</div>
            <div className="mt-2 text-[28px] font-black text-[var(--rf-text)]">{displayedPercent}%</div>
          </div>
        </div>
      </div>

      <div className="grid gap-5 px-6 py-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-[24px] border border-[var(--rf-border)] bg-white/72 p-5">
          <div className="flex items-center gap-2">
            {steps.map((step, index) => {
              const isDone = index < activeIndex;
              const isCurrent = index === activeIndex;
              return (
                <React.Fragment key={step.stage}>
                  <div className="flex items-center gap-2 min-w-0 shrink">
                    <div className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-all ${
                      isDone ? 'border-[var(--rf-brand)] bg-[var(--rf-brand)]'
                        : isCurrent ? 'border-[var(--rf-brand)] bg-white'
                          : 'border-[var(--rf-border)] bg-white'
                    }`}>
                      <span className={`h-2 w-2 rounded-full ${isDone ? 'bg-white' : isCurrent ? 'bg-[var(--rf-brand)] animate-pulse' : 'bg-[var(--rf-border-strong)]'}`} />
                    </div>
                    <span className={`hidden text-[12px] font-semibold sm:block ${isCurrent ? 'text-[var(--rf-brand)]' : isDone ? 'text-[var(--rf-text-secondary)]' : 'text-[var(--rf-text-tertiary)]'}`}>
                      {step.shortLabel}
                    </span>
                  </div>
                  {index < steps.length - 1 && (
                    <div className={`h-px flex-1 min-w-[10px] ${isDone ? 'bg-[var(--rf-brand-subtle)]' : 'bg-[var(--rf-border)]'}`} />
                  )}
                </React.Fragment>
              );
            })}
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-[rgba(35,74,61,0.08)]">
            <motion.div
              className="h-full rounded-full bg-[linear-gradient(90deg,var(--rf-brand),var(--rf-brand-hover))]"
              initial={{ width: 0 }}
              animate={{ width: `${Math.max(displayedPercent, 8)}%` }}
              transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            />
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 text-[12px]">
            <span className="text-[var(--rf-text-tertiary)]">{compactUiText(activeStep.label)}</span>
            <span className="font-bold text-[var(--rf-brand)]">{displayedPercent}%</span>
          </div>
        </div>

        <div className="rounded-[24px] border border-[var(--rf-border)] bg-white/72 p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-black uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">{listHeading}</div>
              <div className="mt-1 text-[14px] font-semibold text-[var(--rf-text)]">
                {items.length > 0 ? `${items.length} visible item${items.length === 1 ? '' : 's'}` : 'The canvas will update as soon as draft structure is ready.'}
              </div>
            </div>
            {listNote && (
              <div className="rounded-full border border-[var(--rf-border)] bg-white/82 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--rf-text-secondary)]">
                {listNote}
              </div>
            )}
          </div>

          <div className="mt-4 space-y-2">
            {items.length > 0 ? items.map((item, index) => (
              <motion.div
                key={item.id}
                className="flex items-center gap-3 rounded-[18px] border border-[var(--rf-border)] bg-white/76 px-4 py-3"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.04, duration: 0.24 }}
              >
                <div className={`h-2.5 w-2.5 shrink-0 rounded-full ${serverProgress?.draftFeatures?.length ? 'bg-[var(--rf-brand)] animate-pulse' : 'bg-[var(--rf-brand)]/45'}`} />
                <div className="min-w-0 flex-1 text-[13px] font-semibold text-[var(--rf-text)]">
                  {compactUiText(item.summary)}
                </div>
              </motion.div>
            )) : (
              <div className="rounded-[18px] border border-dashed border-[var(--rf-border)] bg-white/58 px-4 py-4 text-[13px] leading-relaxed text-[var(--rf-text-secondary)]">
                The loading canvas will stay active and transition as scope signals, drafted feature titles, and final persistence updates arrive.
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.section>
  );
}

function V2Canvas({
  loading,
  loadingMessage,
  loadingState,
  result,
  uiStep,
  scopeDraft,
  setScopeDraft,
  discoveryAnswers,
  setDiscoveryAnswers,
  onGenerate,
  onReset,
  onReturnToScope,
  canContinueFromScope,
  sidebarOpen,
  setSidebarOpen,
  pipelineAuditEnabled,
  recordPipelineAuditForRun,
  latestAuditEntry,
  auditEntryCount,
  isExportingAudit,
  isDeletingAudit,
  onExportAudit,
  onDeleteAudit,
}: {
  loading: boolean;
  loadingMessage: string | null;
  loadingState: V2LoadingState | null;
  result: V2Result | null;
  uiStep: V2UiStep;
  scopeDraft: EditableScopeDraft | null;
  setScopeDraft: React.Dispatch<React.SetStateAction<EditableScopeDraft | null>>;
  discoveryAnswers: Record<string, DiscoveryAnswer>;
  setDiscoveryAnswers: React.Dispatch<React.SetStateAction<Record<string, DiscoveryAnswer>>>;
  onGenerate: (answerOverride?: Record<string, DiscoveryAnswer>) => Promise<void>;
  onReset: () => void;
  onReturnToScope: () => void;
  canContinueFromScope: boolean;
  sidebarOpen: boolean;
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
  pipelineAuditEnabled: boolean;
  recordPipelineAuditForRun: boolean;
  latestAuditEntry: PipelineAuditEntry | null;
  auditEntryCount: number;
  isExportingAudit: boolean;
  isDeletingAudit: boolean;
  onExportAudit: () => void;
  onDeleteAudit: () => void;
}) {
  const triage = result?.triage ?? null;
  const showAuditPanel = pipelineAuditEnabled && (uiStep !== 'input' || Boolean(latestAuditEntry));
  const activeLoadingStep = loadingState
    ? getLoadingSteps(loadingState.mode)[
      loadingState.serverProgress
        ? getLoadingStepIndex(loadingState.mode, loadingState.serverProgress.stage)
        : Math.min(loadingState.localStepIndex, getLoadingSteps(loadingState.mode).length - 1)
    ] ?? null
    : null;
  const loadingItems = loadingState
    ? ((loadingState.serverProgress?.draftFeatures?.length ? loadingState.serverProgress.draftFeatures : loadingState.provisionalItems) ?? [])
    : [];

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4">
      <section className="rf-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl space-y-3">
            <div className="text-[11px] font-black uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">
              {uiStep === 'input' ? 'Refinement flow' : 'V2 workflow'}
            </div>
            {uiStep === 'input' && (
              <div className="space-y-2">
                <h2 className="text-[22px] font-black tracking-tight text-[var(--rf-text)]" style={{ fontFamily: 'Fraunces, serif' }}>
                  Shape the scope in the sidebar, then run Preview Scope.
                </h2>
                <p className="max-w-2xl text-[14px] leading-relaxed text-[var(--rf-text-secondary)]">
                  Start with the requirement and only add the context that changes scope. Review and audit details will appear later, when they are actually useful.
                </p>
                {pipelineAuditEnabled && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <span className="rounded-full border border-[var(--rf-border)] bg-white/70 px-3 py-1 text-[12px] font-semibold text-[var(--rf-text-secondary)]">
                      Audit {recordPipelineAuditForRun ? 'on' : 'off'} for this run
                    </span>
                    {latestAuditEntry && (
                      <span className="rounded-full border border-[var(--rf-border)] bg-white/70 px-3 py-1 text-[12px] font-semibold text-[var(--rf-text-secondary)]">
                        {auditEntryCount} saved audit run{auditEntryCount === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
            <StepRail uiStep={uiStep} />
          </div>
          <button
            type="button"
            onClick={onReset}
            className="inline-flex items-center gap-2 rounded-xl border border-[var(--rf-border)] bg-white/78 px-3 py-2 text-sm font-semibold text-[var(--rf-text-secondary)] hover:bg-white"
          >
            <Plus className="w-4 h-4" />
            New session
          </button>
        </div>

        {triage && (
          <div className="mt-5 grid gap-3 md:grid-cols-4">
            <CanvasStat label="Discovery mode" value={triage.discoveryMode} />
            <CanvasStat label="Question budget" value={`${triage.questionBudget} advisory`} />
            <CanvasStat label="Capability target" value={`${triage.likelyCapabilityCount} advisory`} />
            <CanvasStat label="CRUD risk" value={`${triage.crudRisk} heuristic`} />
          </div>
        )}
      </section>

      {showAuditPanel && (
        <section className="rf-card p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-[11px] font-black uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">Pipeline audit</div>
              <h2 className="mt-2 text-[20px] font-black tracking-tight text-[var(--rf-text)]" style={{ fontFamily: 'Fraunces, serif' }}>
                {latestAuditEntry ? 'Audit capture is available for this session.' : recordPipelineAuditForRun ? 'Audit capture is armed for this run.' : 'Audit capture is available but currently off for this run.'}
              </h2>
              <p className="mt-2 max-w-3xl text-[14px] leading-relaxed text-[var(--rf-text-secondary)]">
                Prompts, model traces, discovery depth, and generated output can be exported as JSON for QA. To protect KVS, only the newest audit runs are retained and very large prompt/response fields are truncated.
              </p>
            </div>
            {latestAuditEntry && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={onExportAudit}
                  disabled={isExportingAudit}
                  className="inline-flex items-center gap-2 rounded-xl border border-[var(--rf-border)] bg-white/78 px-3 py-2 text-sm font-semibold text-[var(--rf-text-secondary)] hover:bg-white disabled:opacity-45"
                >
                  <Download className="w-4 h-4" />
                  {isExportingAudit ? 'Exporting…' : 'Export latest audit'}
                </button>
                <button
                  type="button"
                  onClick={onDeleteAudit}
                  disabled={isDeletingAudit}
                  className="inline-flex items-center gap-2 rounded-xl border border-[rgba(155,53,69,0.18)] bg-[rgba(155,53,69,0.06)] px-3 py-2 text-sm font-semibold text-[var(--rf-danger)] hover:bg-[rgba(155,53,69,0.1)] disabled:opacity-45"
                >
                  <Trash2 className="w-4 h-4" />
                  {isDeletingAudit ? 'Deleting…' : 'Delete latest audit'}
                </button>
              </div>
            )}
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-5">
            <CanvasStat label="Run toggle" value={recordPipelineAuditForRun ? 'On for this run' : 'Off for this run'} />
            <CanvasStat label="Captured runs" value={`${auditEntryCount}`} />
            <CanvasStat label="LLM calls" value={`${latestAuditEntry?.llmCallCount ?? 0}`} />
            <CanvasStat label="Questions / answers" value={`${latestAuditEntry?.clarifyQuestionCount ?? 0} / ${latestAuditEntry?.clarifyAnswerCount ?? 0}`} />
            <CanvasStat label="Features / ARs" value={`${latestAuditEntry?.featureCount ?? 0} / ${latestAuditEntry?.acceptanceRequirementCount ?? 0}`} />
          </div>
        </section>
      )}

      {loading && loadingState && activeLoadingStep && (
        <V2LoadingSurface
          mode={loadingState.mode}
          loadingMessage={loadingMessage}
          activeStep={activeLoadingStep}
          activeIndex={loadingState.serverProgress
            ? getLoadingStepIndex(loadingState.mode, loadingState.serverProgress.stage)
            : loadingState.localStepIndex}
          serverProgress={loadingState.serverProgress}
          items={loadingItems}
        />
      )}

      {!loading && uiStep === 'scope_review' && result && scopeDraft && (
        <>
          <section className="rf-card p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-[11px] font-black uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">Scope preview result</div>
                <h2 className="mt-2 text-[20px] font-black tracking-tight text-[var(--rf-text)]" style={{ fontFamily: 'Fraunces, serif' }}>Review and edit the proposed scope before refinement.</h2>
                <p className="mt-2 max-w-3xl text-[14px] leading-relaxed text-[var(--rf-text-secondary)]">
                  Keep the capabilities that belong in this refinement, rename anything ambiguous, adjust actor roles, and decide which open questions should stay unresolved.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void onGenerate()}
                disabled={loading || !canContinueFromScope}
                className="rounded-[18px] bg-[var(--rf-brand)] px-4 py-2.5 text-[13px] font-bold text-white disabled:opacity-45 shadow-sm"
              >
                {loading ? (loadingMessage ?? 'Working…') : 'Continue into full refinement'}
              </button>
            </div>
          </section>

          <section className="rf-card p-6">
            <div className="flex items-center gap-3">
              <Edit2 className="w-4 h-4 text-[var(--rf-brand)]" />
              <h3 className="text-[20px] font-black tracking-tight text-[var(--rf-text)]" style={{ fontFamily: 'Fraunces, serif' }}>Capabilities</h3>
            </div>
            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              {scopeDraft.capabilities.map((capability, index) => (
                <div key={capability.id} className="rounded-[24px] border p-5 bg-white/72" style={{ borderColor: 'var(--rf-border)' }}>
                  <div className="flex items-start justify-between gap-3">
                    <input
                      value={capability.label}
                      onChange={(event) => setScopeDraft((previous) => previous ? {
                        ...previous,
                        capabilities: previous.capabilities.map((entry, entryIndex) => entryIndex === index ? { ...entry, label: event.target.value } : entry),
                      } : previous)}
                      className="w-full bg-transparent text-[16px] font-bold text-[var(--rf-text)] outline-none tracking-tight"
                    />
                    <button
                      type="button"
                      onClick={() => setScopeDraft((previous) => previous ? {
                        ...previous,
                        capabilities: previous.capabilities.filter((_, entryIndex) => entryIndex !== index),
                      } : previous)}
                      className="p-1.5 rounded-lg text-[var(--rf-text-tertiary)] hover:text-[var(--rf-danger)] hover:bg-[var(--rf-danger-subtle)]"
                      title="Remove capability"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <textarea
                    value={capability.rationale}
                    onChange={(event) => setScopeDraft((previous) => previous ? {
                      ...previous,
                      capabilities: previous.capabilities.map((entry, entryIndex) => entryIndex === index ? { ...entry, rationale: event.target.value } : entry),
                    } : previous)}
                    className="mt-3 min-h-[110px] w-full resize-none rounded-[18px] border border-[var(--rf-border)] bg-white/70 p-4 text-[13px] leading-relaxed text-[var(--rf-text-secondary)] outline-none"
                  />
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setScopeDraft((previous) => previous ? {
                ...previous,
                capabilities: [
                  ...previous.capabilities,
                  {
                    id: `manual_cap_${Date.now()}`,
                    label: 'New capability',
                    rationale: '',
                    confidence: 'medium',
                  },
                ],
              } : previous)}
              className="mt-5 inline-flex items-center gap-2 rounded-xl border border-[var(--rf-border)] bg-white/78 px-3 py-2 text-sm font-semibold text-[var(--rf-text-secondary)] hover:bg-white"
            >
              <Plus className="w-4 h-4" />
              Add capability
            </button>
          </section>

          <section className="grid gap-5 lg:grid-cols-[1fr_1fr]">
            <div className="rf-card p-6">
              <div className="flex items-center gap-3">
                <UserRound className="w-4 h-4 text-[var(--rf-brand)]" />
                <h3 className="text-[20px] font-black tracking-tight text-[var(--rf-text)]" style={{ fontFamily: 'Fraunces, serif' }}>Actor slots</h3>
              </div>
              <div className="mt-5 space-y-3">
                {actorSlotEntries(scopeDraft.actorSlots).map(([slot, value]) => (
                  <label key={slot} className="block">
                    <div className="mb-2 text-[11px] font-black uppercase tracking-[0.14em] text-[var(--rf-text-tertiary)]">
                      {slot.replace(/_/g, ' ')}
                    </div>
                    <input
                      value={value}
                      onChange={(event) => setScopeDraft((previous) => previous ? {
                        ...previous,
                        actorSlots: {
                          ...previous.actorSlots,
                          [slot]: event.target.value,
                        },
                      } : previous)}
                      className="w-full rounded-[18px] border border-[var(--rf-border)] bg-white/76 px-4 py-3 text-sm text-[var(--rf-text)] outline-none"
                    />
                  </label>
                ))}
              </div>
            </div>

            <div className="rf-card p-6">
              <div className="flex items-center gap-3">
                <AlertTriangle className="w-4 h-4 text-[var(--rf-warning)]" />
                <h3 className="text-[20px] font-black tracking-tight text-[var(--rf-text)]" style={{ fontFamily: 'Fraunces, serif' }}>Open questions</h3>
              </div>
              <div className="mt-5 space-y-4">
                {scopeDraft.openQuestions.length === 0 ? (
                  <div className="rounded-[20px] border px-4 py-4 text-sm text-[var(--rf-text-secondary)]" style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.72)' }}>
                    No unresolved questions remain in the current scope draft.
                  </div>
                ) : scopeDraft.openQuestions.map((question, index) => (
                  <div key={question.id} className="rounded-[20px] border p-4 bg-white/72" style={{ borderColor: 'var(--rf-border)' }}>
                    <label className="flex items-center gap-2 text-sm font-semibold text-[var(--rf-text)]">
                      <input
                        type="checkbox"
                        checked={question.keepOpen}
                        onChange={(event) => setScopeDraft((previous) => previous ? {
                          ...previous,
                          openQuestions: previous.openQuestions.map((entry, entryIndex) => entryIndex === index ? { ...entry, keepOpen: event.target.checked } : entry),
                        } : previous)}
                      />
                      Keep as unresolved for downstream discovery
                    </label>
                    <textarea
                      value={question.text}
                      onChange={(event) => setScopeDraft((previous) => previous ? {
                        ...previous,
                        openQuestions: previous.openQuestions.map((entry, entryIndex) => entryIndex === index ? { ...entry, text: event.target.value } : entry),
                      } : previous)}
                      className="mt-3 min-h-[100px] w-full resize-none rounded-[16px] border border-[var(--rf-border)] bg-white/70 p-3 text-sm leading-7 text-[var(--rf-text-secondary)] outline-none"
                    />
                  </div>
                ))}
              </div>
            </div>
          </section>
        </>
      )}

      {!loading && uiStep === 'discovery' && result?.status === 'needs_discovery' && (
        <ClarifyQuestionsView
          questions={result.discoveryQuestions.map((question): ClarifyQuestion => ({
            categoryKey: question.categoryKey as ClarifyQuestion['categoryKey'],
            category: question.categoryKey,
            intent: question.categoryKey,
            question: question.question,
            details: question.rationale,
            suggestions: question.suggestions,
          }))}
          onComplete={(answers: ClarifyAnswer[]) => {
            const nextAnswers = Object.fromEntries(
              result.discoveryQuestions.map((question, index) => {
                const answer = answers[index];
                return [question.id, {
                  questionId: question.id,
                  categoryKey: question.categoryKey,
                  question: question.question,
                  answer: String(answer?.customAnswer ?? answer?.answer ?? '').trim(),
                  selectedSuggestion: answer?.selectedSuggestions?.[0],
                }];
              }),
            );
            setDiscoveryAnswers(nextAnswers);
            void onGenerate(nextAnswers);
          }}
          onSkip={onReturnToScope}
          round={1}
          isSubmitting={loading}
          submitLabel={loading ? (loadingMessage ?? 'Working…') : 'Continue refinement'}
          skipLabel="Back to scope"
          inlineError={null}
          priorAnswers={result.discoveryQuestions.map((question) => {
            const current = discoveryAnswers[question.id];
            return {
              question: question.question,
              answer: current?.answer ?? '',
              selectedSuggestions: current?.selectedSuggestion ? [current.selectedSuggestion] : [],
              customAnswer: current?.answer ?? '',
              categoryKey: question.categoryKey as ClarifyQuestion['categoryKey'],
              intent: question.categoryKey,
            };
          })}
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
        />
      )}

      {!loading && uiStep === 'complete' && result?.status === 'complete' && (
        <>
          <section className="rf-card p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-[11px] font-black uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">Complete</div>
                <h2 className="mt-2 text-3xl text-[var(--rf-text)]">The refinement is ready in the main canvas.</h2>
                <p className="mt-3 text-sm leading-7 text-[var(--rf-text-secondary)]">
                  Review the features below. This right-side canvas now uses the V1 shell layout, so long outputs stay reachable with normal canvas scrolling.
                </p>
              </div>
              <div className="rounded-[18px] border px-4 py-3 text-sm font-semibold text-[var(--rf-text-secondary)]" style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.72)' }}>
                {result.features.length} feature{result.features.length === 1 ? '' : 's'} generated
              </div>
            </div>
          </section>

          <section className="space-y-4">
            {result.features.map((feature) => (
              <section key={feature.id} className="rf-card p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-2xl text-[var(--rf-text)]">{feature.summary}</h3>
                    <p className="mt-3 text-sm leading-7 text-[var(--rf-text-secondary)]">{feature.description}</p>
                  </div>
                  {typeof feature.storyPoints === 'number' && (
                    <div className="rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-[0.14em]" style={{ borderColor: 'var(--rf-border)', color: 'var(--rf-text-tertiary)' }}>
                      {feature.storyPoints} pts
                    </div>
                  )}
                </div>

                <div className="mt-5 space-y-3">
                  {feature.acceptanceRequirements.map((acceptanceRequirement, index) => (
                    <div key={`${feature.id}_${index}`} className="rounded-[20px] border p-4 bg-white/72" style={{ borderColor: 'var(--rf-border)' }}>
                      <div className="text-[11px] font-black uppercase tracking-[0.14em] text-[var(--rf-text-tertiary)]">Acceptance requirement {index + 1}</div>
                      <div className="mt-3 space-y-2 text-sm leading-7 text-[var(--rf-text-secondary)]">
                        <div><strong className="text-[var(--rf-text)]">Given:</strong> {acceptanceRequirement.given}</div>
                        <div><strong className="text-[var(--rf-text)]">When:</strong> {acceptanceRequirement.when}</div>
                        <div><strong className="text-[var(--rf-text)]">Then:</strong> {acceptanceRequirement.then}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </section>
        </>
      )}
    </div>
  );
}

function CanvasStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[18px] border p-4" style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.72)' }}>
      <div className="text-[11px] font-black uppercase tracking-[0.14em] text-[var(--rf-text-tertiary)]">{label}</div>
      <div className="mt-2 text-sm font-semibold text-[var(--rf-text)]">{compactUiText(value)}</div>
    </div>
  );
}
