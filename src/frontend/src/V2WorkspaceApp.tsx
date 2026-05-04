import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { requestJira, view } from '@forge/bridge';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Check, ChevronRight, Edit2, Plus, Settings, Trash2, UserRound } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { SettingsView } from './SettingsView';
import { V2HistoryModal, type V2HistoryEntry } from './V2HistoryModal';
import { api } from './hooks/useForge';
import type { LlmProvider, PipelineProfile } from './types';

type DiscoveryMode = 'light' | 'standard' | 'deep' | 'very_deep';
type ConversationStatus = 'preview_ready' | 'needs_scope_confirmation' | 'needs_discovery' | 'complete';
type SettingsSurface = 'workspace' | 'project';
type SettingsTab = 'models' | 'jira' | 'domain' | 'stats' | 'billing' | 'compliance';
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
  return {
    capabilities: (scopeHypothesis.capabilities ?? []).map((capability) => ({
      id: capability.id,
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

function buildScopePayload(draft: EditableScopeDraft): ScopeHypothesis {
  return {
    capabilities: draft.capabilities
      .map((capability) => ({
        ...capability,
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

function actorSlotEntries(actorSlots: Record<string, string>) {
  return Object.entries(actorSlots);
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
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [originIssueKey, setOriginIssueKey] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [hasProjectSettingsAccess, setHasProjectSettingsAccess] = useState(false);
  const [tier, setTier] = useState('standard');
  const [brandingLogoUrl, setBrandingLogoUrl] = useState<string | null>(null);
  const [pipelineProfile, setPipelineProfile] = useState<PipelineProfile>('balanced');
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
        void view.resize('100%', `${Math.ceil(nextHeight + 24)}px`);
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

    void (async () => {
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
        if (configRes?.pipelineProfile === 'fast' || configRes?.pipelineProfile === 'balanced' || configRes?.pipelineProfile === 'quality') {
          setPipelineProfile(configRes.pipelineProfile);
        }
        if (usageRes?.usage) setUsage(usageRes.usage);
        if (usageRes?.limits) setLimits(usageRes.limits);

        const projects = Array.isArray(jiraRes?.projects) ? jiraRes.projects : [];
        setAvailableProjects(projects);
      } catch {
        // Keep the shell usable even if bootstrap data is partial.
      }
    })();

    void loadHistory();
    return () => {
      active = false;
    };
  }, []);

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
    setRunAttachments([]);
    setRunAttachmentParseState(null);
    setRunAttachmentError(null);
  }, []);

  const openSettings = useCallback((surface: SettingsSurface = (isAdmin ? 'workspace' : 'project')) => {
    setSettingsStartSurface(surface);
    setViewMode('settings');
    if (sidebarOpen) closeSidebar();
  }, [closeSidebar, isAdmin, sidebarOpen]);

  const openProjectSettings = useCallback((tab: 'models' | 'jira' | 'domain' | 'billing', projectKeyForSettings: string) => {
    setSettingsStartSurface('project');
    setSettingsStartTab(tab);
    setSettingsStartProjectKey(projectKeyForSettings);
    openSettings('project');
  }, [openSettings]);

  const handlePipelineProfileChange = useCallback((nextProfile: PipelineProfile) => {
    setPipelineProfile(nextProfile);
    void api.saveUserPreferences({ pipelineProfile: nextProfile }).catch(() => {});
  }, []);

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
      setViewMode('generate');
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
    setError(null);
    setWarning(null);
    try {
      const response = await api.v2Preview({
        sessionId,
        requirement,
        attachmentText,
        projectKeys: effectiveProjectKeys,
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
      setWarning(response.warning ?? null);
      void loadHistory();
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : 'Preview failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async (answerOverride?: Record<string, DiscoveryAnswer>) => {
    if (!scopeDraft) return;
    setLoading(true);
    setError(null);
    setWarning(null);
    try {
      const response = await api.v2Generate({
        sessionId,
        requirement,
        attachmentText,
        projectKeys: effectiveProjectKeys,
        confirmedScopeHypothesis: buildScopePayload(scopeDraft),
        discoveryAnswers: Object.values(answerOverride ?? discoveryAnswers),
      }) as { success?: boolean; error?: string; warning?: string; sessionId?: string; result?: V2Result };
      if (!response?.success || !response.result) {
        throw new Error(response?.error || 'Full refinement failed.');
      }
      const nextSessionId = response.sessionId ?? sessionId;
      setSessionId(nextSessionId);
      setSelectedConversationId(nextSessionId);
      setResult(response.result);
      setScopeDraft(buildScopeDraft(response.result.scopeHypothesis));
      setUiStep(deriveStepFromResult(response.result));
      setWarning(response.warning ?? null);
      void loadHistory();
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : 'Full refinement failed.');
    } finally {
      setLoading(false);
    }
  };

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
                pipelineProfile={pipelineProfile}
                onPipelineProfileChange={handlePipelineProfileChange}
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
                workspacePipelineAuditEnabled={false}
                recordPipelineAuditForRun={false}
                primaryActionLabel="Fast Preview"
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
  const current = stepIndex(uiStep);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {steps.map((step, index) => {
        const isDone = index < current;
        const isActive = index === current;
        return (
          <div
            key={step.id}
            className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-[0.12em] border ${
              isActive
                ? 'bg-[var(--rf-brand)] text-white border-[var(--rf-brand)]'
                : isDone
                  ? 'bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)] border-[var(--rf-border-strong)]'
                  : 'bg-white/70 text-[var(--rf-text-tertiary)] border-[var(--rf-border)]'
            }`}
          >
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-current/15">
              {isDone ? <Check className="w-3 h-3" /> : <span className="block h-1.5 w-1.5 rounded-full bg-current" />}
            </span>
            {step.label}
          </div>
        );
      })}
    </div>
  );
}

function V2Canvas({
  loading,
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
}: {
  loading: boolean;
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
}) {
  const triage = result?.triage ?? null;

  return (
    <div className="mx-auto w-full max-w-[1320px] flex flex-col gap-5">
      <section className="rf-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-3">
            <div className="text-[11px] font-black uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">V2 workflow</div>
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

      {uiStep === 'input' && (
        <section className="rf-card p-8">
          <div className="max-w-3xl">
            <div className="text-[11px] font-black uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">Ready to preview</div>
            <h2 className="mt-2 text-3xl text-[var(--rf-text)]">Use the left sidebar to shape scope, then run Fast Preview.</h2>
            <p className="mt-3 text-sm leading-7 text-[var(--rf-text-secondary)]">
              The V2 flow now uses the V1 shell so the main canvas stays scrollable, and scope review happens as a dedicated step instead of appearing below the fold.
            </p>
          </div>
        </section>
      )}

      {uiStep === 'scope_review' && result && scopeDraft && (
        <>
          <section className="rf-card p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-[11px] font-black uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">Fast preview result</div>
                <h2 className="mt-2 text-3xl text-[var(--rf-text)]">Review and edit the proposed scope before refinement.</h2>
                <p className="mt-3 max-w-3xl text-sm leading-7 text-[var(--rf-text-secondary)]">
                  Keep the capabilities that belong in this refinement, rename anything ambiguous, adjust actor roles, and decide which open questions should stay unresolved.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void onGenerate()}
                disabled={loading || !canContinueFromScope}
                className="rounded-full bg-[var(--rf-brand)] px-5 py-3 text-sm font-bold text-white disabled:opacity-45"
              >
                {loading ? 'Working…' : 'Continue into full refinement'}
              </button>
            </div>
          </section>

          <section className="rf-card p-6">
            <div className="flex items-center gap-3">
              <Edit2 className="w-4 h-4 text-[var(--rf-brand)]" />
              <h3 className="text-2xl text-[var(--rf-text)]">Capabilities</h3>
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
                      className="w-full bg-transparent text-sm font-semibold text-[var(--rf-text)] outline-none"
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
                    className="mt-3 min-h-[120px] w-full resize-none rounded-[18px] border border-[var(--rf-border)] bg-white/70 p-4 text-sm leading-7 text-[var(--rf-text-secondary)] outline-none"
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
                <h3 className="text-2xl text-[var(--rf-text)]">Actor slots</h3>
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
                <h3 className="text-2xl text-[var(--rf-text)]">Open questions</h3>
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

      {uiStep === 'discovery' && result?.status === 'needs_discovery' && (
        <>
          <section className="rf-card p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-[11px] font-black uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">Discovery step</div>
                <h2 className="mt-2 text-3xl text-[var(--rf-text)]">Answer only the questions that still change output shape.</h2>
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={onReturnToScope}
                  className="rounded-full border border-[var(--rf-border)] bg-white/80 px-5 py-3 text-sm font-bold text-[var(--rf-text-secondary)]"
                >
                  Back to scope
                </button>
                <button
                  type="button"
                  onClick={() => void onGenerate()}
                  disabled={loading}
                  className="rounded-full bg-[var(--rf-brand)] px-5 py-3 text-sm font-bold text-white disabled:opacity-45"
                >
                  {loading ? 'Working…' : 'Continue refinement'}
                </button>
              </div>
            </div>
            {result.materialityHints.length > 0 && (
              <div className="mt-5 space-y-3">
                {result.materialityHints.map((hint) => (
                  <div key={hint} className="rounded-[18px] border px-4 py-3 text-sm text-[var(--rf-text-secondary)]" style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.72)' }}>
                    {hint}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-4">
            {result.discoveryQuestions.map((question) => {
              const current = discoveryAnswers[question.id] ?? {
                questionId: question.id,
                categoryKey: question.categoryKey,
                question: question.question,
                answer: '',
              };

              return (
                <section key={question.id} className="rf-card p-6">
                  <div className="text-[11px] font-black uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)]">
                    {question.categoryKey.replace(/_/g, ' ')}
                  </div>
                  <h3 className="mt-2 text-2xl text-[var(--rf-text)]">{question.question}</h3>
                  <p className="mt-3 text-sm leading-7 text-[var(--rf-text-secondary)]">{question.rationale}</p>

                  <div className="mt-4 flex flex-wrap gap-2">
                    {question.suggestions.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onClick={() => setDiscoveryAnswers((previous) => ({
                          ...previous,
                          [question.id]: {
                            ...current,
                            selectedSuggestion: suggestion,
                            answer: suggestion,
                          },
                        }))}
                        className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                          current.selectedSuggestion === suggestion
                            ? 'border-[var(--rf-brand)] bg-[var(--rf-brand-subtle)] text-[var(--rf-brand)]'
                            : 'border-[var(--rf-border)] bg-white/75 text-[var(--rf-text-secondary)]'
                        }`}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>

                  <textarea
                    value={current.answer}
                    onChange={(event) => setDiscoveryAnswers((previous) => ({
                      ...previous,
                      [question.id]: {
                        ...current,
                        answer: event.target.value,
                      },
                    }))}
                    className="mt-4 min-h-[120px] w-full resize-none rounded-[20px] border border-[var(--rf-border)] bg-white/78 p-4 text-sm leading-7 text-[var(--rf-text)] outline-none"
                    placeholder="Answer in business terms."
                  />
                </section>
              );
            })}
          </section>
        </>
      )}

      {uiStep === 'complete' && result?.status === 'complete' && (
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
