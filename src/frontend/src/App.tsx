import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { requestJira, view } from '@forge/bridge';
import { motion, AnimatePresence } from 'framer-motion';
import { Sidebar } from './Sidebar';
import { MainContent } from './MainContent';
import { JiraModal } from './JiraModal';
import { SettingsView } from './SettingsView';
import { api } from './hooks/useForge';
import { useGenerationRealtime, useClarifyRealtime, type GenerationProgressPayload } from './hooks/useRealtime';
import { ClarifyQuestionsView } from './ClarifyQuestionsView';
import { HistoryModal } from './HistoryModal';
import QuickRefineApp, { type QuickRefineViewState } from './QuickRefineApp';
import type {
  CanvasEditIntent,
  ClarifyAnswer,
  ClarifyCategoryKey,
  ClarifyContextMeta,
  ClarifyFailureReasonCode,
  ClarifyProgressPayload,
  ClarifyQuestion,
  DraftReviewDecision,
  FeatureActorSource,
  FeatureClass,
  FeatureConfidence,
  GenerationContextMeta,
  OutputProfile,
  TokenUsageSummary,
  UndoableAiChange,
} from './types';

export interface Feature {
  id: string;
  summary: string;
  description: string;
  acceptanceRequirements: Array<{ given: string; when: string; then: string }>;
  storyPoints?: number;
  processCode?: string;
  featureClass?: FeatureClass;
  confidence?: FeatureConfidence;
  actorSource?: FeatureActorSource;
  arGenerationStatus?: 'failed' | 'retrying';
  arGenerationError?: string;
  markdown?: string;
  title?: string;
  isAccepted?: boolean;
  jiraIssueKey?: string;
  jiraIssueUrl?: string;
  pendingRefinement?: Feature;
  pendingRemoval?: boolean;
  pendingAddition?: boolean;
  pendingChangeSource?: 'refine' | 'restructure';
  pendingChangeScope?: 'single' | 'all' | 'selected';
  pendingChangeIntent?: CanvasEditIntent;
}


export interface AppConfig {
  branding?: { appTitle?: string; primaryColor?: string; secondaryColor?: string; logoUrl?: string | null };
  tier?: string;
}

interface WorkflowTokenUsage {
  input: number;
  output: number;
  total: number;
}

interface RunAttachment {
  id: string;
  filename: string;
  text: string;
  charCount: number;
}

type WorkflowStage =
  | 'idle'
  | 'clarify_round_1'
  | 'sufficiency_check'
  | 'clarify_round_2'
  | 'generation'
  | 'blocked';

function normalizeProjectKeys(projectKeys: string[]): string[] {
  return [...new Set(projectKeys.map((key) => String(key ?? '').trim()).filter((key) => key && key !== '*'))]
    .slice(0, 2)
    .sort((left, right) => left.localeCompare(right));
}

function buildProjectSelectionSignature(projectKeys: string[]): string[] {
  return normalizeProjectKeys(projectKeys);
}

/** Recursively extract plain text from an Atlassian Document Format node */
function extractAdfText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { text?: string; content?: unknown[] };
  if (typeof n.text === 'string') return n.text;
  if (Array.isArray(n.content)) return n.content.map(extractAdfText).filter(Boolean).join(' ');
  return '';
}

function addTokenUsage(
  base: WorkflowTokenUsage | null,
  next?: { input: number; output: number; total: number } | null,
): WorkflowTokenUsage | null {
  if (!next) return base;
  return {
    input: (base?.input ?? 0) + (next.input ?? 0),
    output: (base?.output ?? 0) + (next.output ?? 0),
    total: (base?.total ?? 0) + (next.total ?? 0),
  };
}

function mergeTokenUsageSummary(
  base?: TokenUsageSummary | null,
  next?: TokenUsageSummary | null,
): TokenUsageSummary | undefined {
  if (!base && !next) return undefined;
  if (!base) return next ?? undefined;
  if (!next) return base;

  const mergedStages: Record<string, { input: number; output: number; total: number }> = {
    ...(base.byStage ?? {}),
  };

  Object.entries(next.byStage ?? {}).forEach(([stage, usage]) => {
    const existing = mergedStages[stage];
    mergedStages[stage] = {
      input: (existing?.input ?? 0) + usage.input,
      output: (existing?.output ?? 0) + usage.output,
      total: (existing?.total ?? 0) + usage.total,
    };
  });

  return {
    input: base.input + next.input,
    output: base.output + next.output,
    total: base.total + next.total,
    byStage: Object.keys(mergedStages).length ? mergedStages : undefined,
  };
}

function buildClarifyLoadingMeta(
  livePayload: ClarifyProgressPayload | null,
  clarifyContext: ClarifyContextMeta | null,
  workflowStage: WorkflowStage,
): ClarifyProgressPayload | null {
  const contextSources = clarifyContext
    ? {
        projectKey: clarifyContext.projectKey,
        projectCount: clarifyContext.projectCount,
        domainContextApplied: clarifyContext.domainContextApplied,
        attachmentIncluded: clarifyContext.attachmentIncluded,
        wiDocsCount: clarifyContext.wiDocsCount,
        linkedWiDocCount: clarifyContext.linkedWiDocCount,
        retrievedWiDocCount: clarifyContext.retrievedWiDocCount,
        retrievedWiChunkCount: clarifyContext.retrievedWiChunkCount,
        wiInsightCount: clarifyContext.wiInsightCount,
        similarStoriesCount: clarifyContext.similarStoriesCount,
      }
    : undefined;

  const basePayload: ClarifyProgressPayload | null = livePayload || clarifyContext
      ? {
          ...livePayload,
          sizingContract: livePayload?.sizingContract ?? clarifyContext?.sizingContract,
          advisoryTriage: livePayload?.advisoryTriage ?? clarifyContext?.advisoryTriage,
          discoveryProfile: livePayload?.discoveryProfile ?? clarifyContext?.discoveryProfile,
          ambiguityAssessment: livePayload?.ambiguityAssessment ?? clarifyContext?.ambiguityAssessment,
          sources: livePayload?.sources ?? contextSources,
        }
    : null;

  if (workflowStage === 'sufficiency_check') {
    return {
      ...basePayload,
      stage: 'sufficiency',
    };
  }

  if (workflowStage === 'clarify_round_2') {
    return {
      ...basePayload,
      stage: 'followup',
    };
  }

  return basePayload;
}

function buildSufficiencyProgressMessage(
  tick: number,
  context: ClarifyContextMeta | null,
): string {
  const answered = context?.initialQuestionCount ?? 0;
  const followupCap = context?.discoveryProfile?.followupCap;
  const messages = [
    `Reviewing the ${answered || 'current'} discovery answers against the requirement…`,
    'Checking which business dimensions are now covered well enough…',
    followupCap
      ? `Deciding whether any focused follow-up questions are still needed, up to ${followupCap} more…`
      : 'Deciding whether any focused follow-up questions are still needed…',
  ];
  return messages[tick % messages.length] ?? messages[0];
}

function sumWorkflowTokenUsage(conversation: any): WorkflowTokenUsage | null {
  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  let total: WorkflowTokenUsage | null = null;

  turns.forEach((turn: any) => {
    if (turn?.tokenUsage) {
      total = addTokenUsage(total, turn.tokenUsage);
      return;
    }
    if (turn?.clarifyContext?.tokenUsage) {
      total = addTokenUsage(total, turn.clarifyContext.tokenUsage);
    }
    if (turn?.generationContext?.tokenUsage) {
      total = addTokenUsage(total, turn.generationContext.tokenUsage);
    }
  });

  return total;
}

function getLatestFeatureBearingTurn(conversation: any): any | null {
  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (Array.isArray(turn?.features) && turn.features.length > 0) {
      return turn;
    }
  }
  return turns[turns.length - 1] ?? null;
}

function getLatestRequirementText(conversation: any): string {
  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const requirement = turns[i]?.requirement;
    if (typeof requirement === 'string' && requirement.trim()) {
      return requirement;
    }
  }
  return '';
}

function getLatestClarifyContext(conversation: any): ClarifyContextMeta | null {
  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const clarifyContext = turns[i]?.clarifyContext;
    if (clarifyContext) return clarifyContext;
  }
  return null;
}

function getLatestGenerationContext(conversation: any): GenerationContextMeta | null {
  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const generationContext = turns[i]?.generationContext;
    if (generationContext) return generationContext;
  }
  return null;
}

function buildDiscoveryInputSignature(params: {
  requirement: string;
  projectKey: string;
  projectKeys?: string[];
  contextMode: 'undecided' | 'project' | 'global';
  attachments: RunAttachment[];
}): string {
  return JSON.stringify({
    requirement: params.requirement.trim(),
    projectKey: params.projectKey,
    projectKeys: buildProjectSelectionSignature(params.projectKeys ?? (params.projectKey && params.projectKey !== '*' ? [params.projectKey] : [])),
    contextMode: params.contextMode,
    attachments: params.attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      text: attachment.text,
    })),
  });
}

function createSessionId(): string {
  try {
    return crypto.randomUUID();
  } catch (e) {
    return `fallback_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}

function resolveContextModeForSignature(
  projectKey: string,
  fallback: 'undecided' | 'project' | 'global',
): 'undecided' | 'project' | 'global' {
  if (fallback !== 'undecided') return fallback;
  return projectKey && projectKey !== '*' ? 'project' : 'global';
}

function buildConversationInputSignature(
  conversation: any,
  fallback: { projectKey: string; contextMode: 'undecided' | 'project' | 'global' },
): string | null {
  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  const lastTurn = turns[turns.length - 1];
  if (!lastTurn?.requirement) return null;
  if (typeof lastTurn.inputSignature === 'string' && lastTurn.inputSignature.trim()) {
    return lastTurn.inputSignature;
  }

  const restoredProjectKey =
    lastTurn?.clarifyContext?.projectKey
    || lastTurn?.generationContext?.projectKey
    || fallback.projectKey
    || '*';
  const restoredProjectKeys = normalizeProjectKeys(
    lastTurn?.clarifyContext?.projectKeys
      ?? lastTurn?.generationContext?.projectKeys
      ?? (restoredProjectKey && restoredProjectKey !== '*' ? [restoredProjectKey] : []),
  );

  return buildDiscoveryInputSignature({
    requirement: String(lastTurn.requirement ?? ''),
    projectKey: restoredProjectKey,
    projectKeys: restoredProjectKeys,
    contextMode: resolveContextModeForSignature(restoredProjectKey, fallback.contextMode),
    attachments: [],
  });
}

function getDefaultSidebarWidth(viewportWidth?: number): number {
  const width =
    typeof viewportWidth === 'number'
      ? viewportWidth
      : typeof window !== 'undefined'
        ? window.innerWidth
        : 0;

  if (!width || width <= 0) return 420;
  if (width <= 720) return Math.max(300, width - 48);
  return Math.min(Math.max(Math.round(width * 0.5), 360), Math.round(width * 0.7));
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

function LegacyApp({
  initialViewMode = 'generate',
  initialSettingsTab = 'models',
  initialRequirement = '',
  onCloseSettings,
}: {
  initialViewMode?: 'generate' | 'settings';
  initialSettingsTab?: 'models' | 'jira' | 'domain' | 'billing';
  initialRequirement?: string;
  onCloseSettings?: () => void;
}) {
  const [viewMode, setViewMode] = useState<'generate' | 'settings'>(initialViewMode);
  const [settingsStartTab, setSettingsStartTab] = useState<'models' | 'jira' | 'domain' | 'billing'>(initialSettingsTab);
  const [settingsStartProjectKey, setSettingsStartProjectKey] = useState<string>('*');
  const [requirement, setRequirement] = useState('');
  const [activePushFeatureIdx, setActivePushFeatureIdx] = useState<number | null>(null);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [generationContext, setGenerationContext] = useState<GenerationContextMeta | null>(null);
  const [generationProgressMeta, setGenerationProgressMeta] = useState<GenerationProgressPayload | null>(null);
  const [clarifyContext, setClarifyContext] = useState<ClarifyContextMeta | null>(null);
  const [workflowTokenUsage, setWorkflowTokenUsage] = useState<WorkflowTokenUsage | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [sessionId, setSessionIdState] = useState<string>(() => createSessionId());
  const sessionIdRef = useRef(sessionId);
  const [activeSessionInputSignature, setActiveSessionInputSignature] = useState<string | null>(null);
  const activeSessionInputSignatureRef = useRef<string | null>(null);
  const [restoredSessionInputSignature, setRestoredSessionInputSignature] = useState<string | null>(null);
  const restoredSessionInputSignatureRef = useRef<string | null>(null);

  const setSessionId = (nextSessionId: string) => {
    sessionIdRef.current = nextSessionId;
    setSessionIdState(nextSessionId);
  };

  const setSessionSignatures = (
    nextActiveSignature: string | null,
    nextRestoredSignature: string | null = nextActiveSignature,
  ) => {
    activeSessionInputSignatureRef.current = nextActiveSignature;
    restoredSessionInputSignatureRef.current = nextRestoredSignature;
    setActiveSessionInputSignature(nextActiveSignature);
    setRestoredSessionInputSignature(nextRestoredSignature);
  };
  
  // Realtime Integration
  const [clarifyQuestions, setClarifyQuestions] = useState<ClarifyQuestion[]>([]);
  const [clarifyAnswers, setClarifyAnswers] = useState<ClarifyAnswer[]>([]);
  const [clarifyRound, setClarifyRound] = useState<1 | 2>(1);
  const [isEvaluatingDiscovery, setIsEvaluatingDiscovery] = useState(false);
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [pendingClarifySessionId, setPendingClarifySessionId] = useState<string | null>(null);
  const [workflowRunId, setWorkflowRunId] = useState(0);
  const [isWorking, setIsWorking] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [retryingFeatureId, setRetryingFeatureId] = useState<string | null>(null);
  const [generationWarning, setGenerationWarning] = useState<string | null>(null);
  const [lastAiChange, setLastAiChange] = useState<UndoableAiChange | null>(null);
  const [clarifyBlockingError, setClarifyBlockingError] = useState<{ message: string; reasonCode?: ClarifyFailureReasonCode } | null>(null);
  const [clarifyEvaluationError, setClarifyEvaluationError] = useState<string | null>(null);
  const [workflowStage, setWorkflowStage] = useState<WorkflowStage>('idle');
  const [sufficiencyProgressTick, setSufficiencyProgressTick] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(initialViewMode !== 'settings');
  const [sidebarExiting, setSidebarExiting] = useState(false);
  const [isHistoryModalOpen, setHistoryModalOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [tier, setTier] = useState('standard');
  const [workspacePipelineAuditEnabled, setWorkspacePipelineAuditEnabled] = useState(false);
  const [recordPipelineAuditForRun, setRecordPipelineAuditForRun] = useState(false);
  const pipelineAuditRunIdRef = useRef<string | null>(null);
  const pipelineAuditActiveRef = useRef(false);
  const [pipelineAuditBanner, setPipelineAuditBanner] = useState<{ sessionId: string; auditRunId: string } | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => getDefaultSidebarWidth());
  const isResizing = useRef(false);
  const resolvedSidebarWidth = Number.isFinite(sidebarWidth) && sidebarWidth >= 300
    ? sidebarWidth
    : getDefaultSidebarWidth();

  const handleMouseMove = (e: MouseEvent) => {
    if (!isResizing.current) return;
    // Limit between 280px and 70% of screen
    const newWidth = Math.min(Math.max(300, e.clientX), window.innerWidth * 0.7);
    setSidebarWidth(newWidth);
  };

  const endResizing = () => {
    isResizing.current = false;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', endResizing);
  };

  const startResizing = (e: React.MouseEvent) => {
    isResizing.current = true;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', endResizing);
  };

  useEffect(() => {
    if (!sidebarOpen) return;
    if (sidebarWidth >= 300) return;
    setSidebarWidth(getDefaultSidebarWidth());
  }, [sidebarOpen, sidebarWidth]);
  
  // Issue context (when launched from a Jira issue via issueAction)
  const [originIssueKey, setOriginIssueKey] = useState<string | null>(null);
  const [projectKeys, setProjectKeys] = useState<string[]>([]);
  const [contextMode, setContextMode] = useState<'undecided' | 'project' | 'global'>('undecided');
  const [launchContextReady, setLaunchContextReady] = useState(false);
  /** False until we know whether to bind session from Jira issue (avoids loading a throwaway session id). */
  const [issueConversationBootstrapDone, setIssueConversationBootstrapDone] = useState(false);
  const [launchProjectKey, setLaunchProjectKey] = useState<string | null>(null);
  const [savedDefaultProjectKey, setSavedDefaultProjectKey] = useState<string | null>(null);
  const [workspaceSelectionVersion, setWorkspaceSelectionVersion] = useState(0);
  const [availableProjects, setAvailableProjects] = useState<Array<{ key: string; name: string }>>([]);
  const [brandingLogoUrl, setBrandingLogoUrl] = useState<string | null>(null);
  const [workspaceOutputProfile, setWorkspaceOutputProfile] = useState<OutputProfile>('business_first');
  const [runOutputProfileOverride, setRunOutputProfileOverride] = useState<OutputProfile>('business_first');
  const [reviewBeforeARs] = useState(false);
  const [wiDocs, setWiDocs] = useState<any[]>([]);
  const [runAttachments, setRunAttachments] = useState<RunAttachment[]>([]);
  const [runAttachmentParseState, setRunAttachmentParseState] = useState<{ filename: string; stage: 'reading' | 'parsing' } | null>(null);
  const [runAttachmentError, setRunAttachmentError] = useState<string | null>(null);

  useEffect(() => {
    if (!initialRequirement.trim()) return;
    setRequirement(initialRequirement);
    setViewMode('generate');
    setSidebarOpen(true);
  }, [initialRequirement]);

  // History
  const [conversations, setConversations] = useState<any[]>([]);

  // Animated sidebar close helper
  const closeSidebar = () => {
    setSidebarExiting(true);
    setTimeout(() => { setSidebarOpen(false); setSidebarExiting(false); }, 270);
  };

  const projectKey = projectKeys[0] ?? '*';
  const preferredProjectKeys = useMemo(
    () => normalizeProjectKeys(
      launchProjectKey ? [launchProjectKey] : (savedDefaultProjectKey ? [savedDefaultProjectKey] : []),
    ),
    [launchProjectKey, savedDefaultProjectKey],
  );
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

  const persistSessionPointers = async (nextSessionId: string, issueKeyOverride?: string | null, bindIssueSession = true) => {
    await Promise.all([
      api.setLastSession(nextSessionId),
      bindIssueSession && issueKeyOverride ? api.setIssueSession(issueKeyOverride, nextSessionId) : Promise.resolve(),
    ]);
  };

  // Fetch Atlassian account ID once on mount; detect issue context if launched via issueAction
  useEffect(() => {
    let active = true;

    view.getContext().then(async (ctx: any) => {
      try {
        if (!ctx) return;
        const aid = ctx.accountId as string | undefined;
        if (!aid) return;
        if (!active) return;
        setAccountId(aid);

        const issueKey = ctx.extension?.issue?.key as string | undefined;
        const ctxProjectKey =
          (ctx.extension?.project?.key as string | undefined) ||
          (ctx.extension?.projectKey as string | undefined) ||
          (issueKey ? issueKey.split('-')[0] : undefined);
        if (ctxProjectKey) {
          if (!active) return;
          setLaunchProjectKey(ctxProjectKey);
          setSelectedProjectKeys([ctxProjectKey]);
        }

        if (issueKey) {
          if (!active) return;
          setOriginIssueKey(issueKey);

          const issueRes = await requestJira(`/rest/api/3/issue/${issueKey}?fields=summary,description`);
          let requirementText = '';
          if (issueRes.ok) {
            const data = await issueRes.json() as any;
            const summary = data.fields?.summary ?? '';
            const description = extractAdfText(data.fields?.description);
            requirementText = [summary, description].filter(Boolean).join('\n\n');
            if (active && requirementText) setRequirement(requirementText);
          }
        }
      } catch (e) {
        console.error('Context error', e);
      } finally {
        if (active) {
          setLaunchContextReady(true);
        }
      }
    }).catch(err => {
      console.error('Context error', err);
      if (active) {
        setLaunchContextReady(true);
      }
    });

    return () => {
      active = false;
    };
  }, []); // eslint-disable-line

  useEffect(() => {
    if (!accountId || !launchContextReady) return;
    let cancelled = false;
    if (!originIssueKey) {
      setIssueConversationBootstrapDone(true);
      return;
    }
    void api.getIssueSession(originIssueKey).then((res: any) => {
      if (cancelled) return;
      const sid = typeof res?.sessionId === 'string' ? res.sessionId.trim() : '';
      if (res?.success && sid) {
        setSessionId(sid);
      }
      setIssueConversationBootstrapDone(true);
    }).catch(() => {
      if (!cancelled) setIssueConversationBootstrapDone(true);
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, launchContextReady, originIssueKey]);

  useEffect(() => {
    api.discoverJira()
      .then((res: any) => {
        const projects = Array.isArray(res?.projects) ? res.projects : [];
        setAvailableProjects(projects);
        if (projectKeys.length === 0 && projects.length === 1) {
          setSelectedProjectKeys([projects[0].key]);
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line

  useEffect(() => {
    api.getConfig()
      .then((res: any) => {
        setBrandingLogoUrl(res?.branding?.logoUrl || null);
        const profile = res?.generationPreferences?.outputProfile;
        const normalizedProfile: OutputProfile = profile === 'balanced' || profile === 'technical_first' ? profile : 'business_first';
        setWorkspaceOutputProfile(normalizedProfile);
        setRunOutputProfileOverride(normalizedProfile);
        setWorkspacePipelineAuditEnabled(Boolean(res?.developerTools?.pipelineAuditEnabled));
      })
      .catch(() => {});
  }, []); // eslint-disable-line

  const loadWiDocs = async (nextProjectKeys = projectKeys) => {
    try {
      const keys = normalizeProjectKeys(nextProjectKeys);
      const targetKeys = keys.length ? keys : ['*'];
      const results = await Promise.all(targetKeys.map((key) => api.listWiDocs(key) as Promise<any>));
      const docsById = new Map<string, any>();
      results.forEach((res: any) => {
        (Array.isArray(res?.docs) ? res.docs : []).forEach((doc: any) => {
          docsById.set(doc.docId, doc);
        });
      });
      setWiDocs([...docsById.values()]);
    } catch {}
  };

  useEffect(() => {
    loadWiDocs(projectKeys);
  }, [projectKeys]); // eslint-disable-line

  const discoveryInputSignature = useMemo(
    () => buildDiscoveryInputSignature({
      requirement,
      projectKey,
      projectKeys,
      contextMode,
      attachments: runAttachments,
    }),
    [requirement, projectKey, projectKeys, contextMode, runAttachments],
  );

  const hydrateConversationState = (conversation: any) => {
    const latestFeatureTurn = getLatestFeatureBearingTurn(conversation);
    const latestRequirement = getLatestRequirementText(conversation);
    setFeatures(latestFeatureTurn?.features ?? []);
    setRequirement(latestRequirement);
    setGenerationContext(getLatestGenerationContext(conversation));
    setClarifyContext(getLatestClarifyContext(conversation));
    setWorkflowTokenUsage(sumWorkflowTokenUsage(conversation));
    setPendingSessionId(null);
    setPendingClarifySessionId(null);
    setIsWorking(false);
    setSidebarOpen(!((latestFeatureTurn?.features?.length ?? 0) > 0));
    setLastAiChange((conversation?.lastAiChange as UndoableAiChange | null) ?? null);
  };

  // Restore features from Forge Storage whenever sessionId or accountId changes
  useEffect(() => {
    if (!accountId || !issueConversationBootstrapDone) return;
    let cancelled = false;

    api.getConversation(sessionId).then((res: any) => {
      if (cancelled) return;

      if (res?.success && res.conversation?.turns?.length > 0) {
        const restoredSignature = buildConversationInputSignature(res.conversation, {
          projectKey,
          contextMode,
        });
        setSessionSignatures(
          activeSessionInputSignatureRef.current ?? restoredSignature,
          restoredSignature,
        );
        hydrateConversationState(res.conversation);
      } else {
        setSessionSignatures(activeSessionInputSignatureRef.current, null);
        setWorkflowTokenUsage(null);
        setPendingSessionId(null);
        setPendingClarifySessionId(null);
        setIsWorking(false);
        setFeatures([]);
        setGenerationContext(null);
        setClarifyContext(null);
        setLastAiChange(null);
        setSidebarOpen(true);
      }
    }).catch(() => {
      if (cancelled) return;
      setWorkflowTokenUsage(null);
      setFeatures([]);
      setGenerationContext(null);
      setClarifyContext(null);
      setLastAiChange(null);
      setSidebarOpen(true);
    });
    loadHistory();
    return () => {
      cancelled = true;
    };
  }, [sessionId, accountId, issueConversationBootstrapDone]); // eslint-disable-line

  const [usage, setUsage] = useState<{ currentMonth: number } | null>(null);
  const [limits, setLimits] = useState<{ generationsPerMonth: number } | null>(null);
  const [sidebarCacheCounts, setSidebarCacheCounts] = useState<Record<string, number>>({});

  const loadUsage = async () => {
    try {
      const res = await api.getUsage() as any;
      if (res?.usage) setUsage(res.usage);
      if (res?.limits) setLimits(res.limits);
      if (res?.tier) setTier(res.tier);
    } catch {}
  };

  // Initial fetch of config and usage
  useEffect(() => {
    api.getConfig().then((res: any) => {
      if (!res) return;
      if (res.tier) setTier(res.tier);
      if (res.isAdmin !== undefined) setIsAdmin(!!res.isAdmin);
      setBrandingLogoUrl(res?.branding?.logoUrl || null);
      const profile = res?.generationPreferences?.outputProfile;
      const normalizedProfile: OutputProfile = profile === 'balanced' || profile === 'technical_first' ? profile : 'business_first';
      setWorkspaceOutputProfile(normalizedProfile);
      setRunOutputProfileOverride(normalizedProfile);
      setSavedDefaultProjectKey(typeof res.defaultProjectKey === 'string' ? res.defaultProjectKey : null);
      setWorkspacePipelineAuditEnabled(Boolean(res?.developerTools?.pipelineAuditEnabled));
    }).catch(e => console.error('Config fetch failed', e));
    loadUsage();
    // Initial bootstrap only; later project selection changes are user-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!launchContextReady) return;
    if (!preferredProjectKeys.length) return;
    if (projectKeys.length > 0) return;

    setSelectedProjectKeys(preferredProjectKeys);
  }, [launchContextReady, preferredProjectKeys, projectKeys.length, setSelectedProjectKeys]);

  // Restore features from Forge Storage whenever sessionId or accountId changes

  const loadHistory = async () => {
    try {
      const res = await api.getHistory(50) as any;
      if (res.success && res.conversations) {
        setConversations(res.conversations);
      }
    } catch {}
  };

  const {
    isGenerating,
    progress: generationProgress,
    progressPayload: liveGenerationPayload,
    cancelGeneration,
  } = useGenerationRealtime(
    pendingSessionId,
    workflowRunId,
    (payload: any) => {
      if (payload.features) {
        setFeatures(payload.features);
      }
      setGenerationContext(payload.generationContext ?? null);
      setGenerationError(null);
      setGenerationProgressMeta(null);
      setGenerationWarning(payload.generationContext?.partialSuccessMessage ?? null);
      setWorkflowTokenUsage(prev => addTokenUsage(prev, payload.generationContext?.tokenUsage ?? null));
      setPendingSessionId(null);
      setRetryingFeatureId(null);
      setIsWorking(false);
      setWorkflowStage('idle');
      if (pipelineAuditActiveRef.current && pipelineAuditRunIdRef.current) {
        setPipelineAuditBanner({
          sessionId: sessionIdRef.current,
          auditRunId: pipelineAuditRunIdRef.current,
        });
      }
      loadHistory();
      window.setTimeout(() => { void loadHistory(); }, 1500);
      loadUsage();
    },
    () => {
      // Draft review pause removed — pipeline flows straight through
    },
    (errMsg) => {
      setGenerationError(errMsg);
      setGenerationProgressMeta(null);
      setPendingSessionId(null);
      setRetryingFeatureId(null);
      setIsWorking(false);
      setWorkflowStage('blocked');
    }
    ,
    () => {
      setPendingSessionId(null);
      setGenerationProgressMeta(null);
      setRetryingFeatureId(null);
      setIsWorking(false);
      setWorkflowStage('idle');
    }
  );

  useEffect(() => {
    if (liveGenerationPayload) {
      setGenerationProgressMeta(liveGenerationPayload);
      return;
    }

    if (workflowStage === 'idle') {
      setGenerationProgressMeta(null);
    }
  }, [liveGenerationPayload, workflowStage]);

  useEffect(() => {
    let cancelled = false;
    const selectedKeys = projectKeys.filter((key) => key && key !== '*').slice(0, 2);
    if (!selectedKeys.length) {
      setSidebarCacheCounts({});
      return () => {
        cancelled = true;
      };
    }

    void Promise.all(selectedKeys.map(async (key) => {
      try {
        const res = await api.getBacklogCacheInfo(key) as any;
        return [key, res?.success ? (res.issueCount ?? 0) : 0] as const;
      } catch {
        return [key, 0] as const;
      }
    })).then((entries) => {
      if (cancelled) return;
      setSidebarCacheCounts(Object.fromEntries(entries));
    });

    return () => {
      cancelled = true;
    };
  }, [projectKeys]);

  const {
    cancelClarify,
    progress: clarifyProgress,
    progressPayload: liveClarifyPayload,
    isClarifying,
  } = useClarifyRealtime(
    pendingClarifySessionId,
    activeSessionInputSignature,
    workflowRunId,
    ({ questions, contextMeta }) => {
      const nextClarifyContext = (contextMeta as ClarifyContextMeta | undefined) ?? null;
      setPendingClarifySessionId(null);
      setClarifyBlockingError(null);
      setClarifyEvaluationError(null);
      setClarifyContext(nextClarifyContext);
      setClarifyRound(1);
      setClarifyAnswers([]);
      setIsEvaluatingDiscovery(false);
      setWorkflowTokenUsage(prev => addTokenUsage(prev, nextClarifyContext?.tokenUsage ?? null));
      if (questions.length > 0) {
        setClarifyContext(nextClarifyContext ? {
          ...nextClarifyContext,
          discoveryStatus: 'needs_clarification',
        } : nextClarifyContext);
        setClarifyQuestions(questions as ClarifyQuestion[]);
        setWorkflowStage('clarify_round_1');
        setIsWorking(false);
        return;
      }
      setClarifyQuestions([]);
      setClarifyContext((prev) => prev ? {
        ...prev,
        discoveryStatus: 'ready_for_generation',
        roundsCompleted: 1,
        totalQuestionCount: 0,
        followupQuestionCount: 0,
        followupTriggered: false,
      } : prev);
      setWorkflowStage('generation');
      void startGeneration(requirementRef.current, []);
    },
    ({ message, reasonCode, contextMeta }) => {
      setPendingClarifySessionId(null);
      setIsEvaluatingDiscovery(false);
      setIsWorking(false);
      setClarifyQuestions([]);
      setClarifyContext(
        (contextMeta as ClarifyContextMeta | undefined)
        ?? {
          projectKey,
          domainRolesUsed: [],
          discoveryStatus: 'discovery_failed',
          failureReasonCode: reasonCode,
        },
      );
      setClarifyBlockingError({ message, reasonCode });
      setWorkflowStage('blocked');
    },
    () => {
      setPendingClarifySessionId(null);
      setIsWorking(false);
      setWorkflowStage('idle');
    }
  );

  useEffect(() => {
    if (workflowStage !== 'sufficiency_check') {
      setSufficiencyProgressTick(0);
      return;
    }

    const timer = window.setInterval(() => {
      setSufficiencyProgressTick((tick) => tick + 1);
    }, 2400);

    return () => window.clearInterval(timer);
  }, [workflowStage]);

  const isCanvasLoading = Boolean(
    !retryingFeatureId
    && (
      pendingClarifySessionId
      || pendingSessionId
      || isClarifying
      || isGenerating
      || workflowStage === 'sufficiency_check'
      || workflowStage === 'generation'
    ),
  );

  const loadingTitle = workflowStage === 'sufficiency_check'
    ? 'Checking discovery sufficiency'
    : workflowStage === 'generation'
      ? 'Crafting features'
      : 'Exploring the requirement';

  const clarifyLoadingMeta = useMemo(
    () => buildClarifyLoadingMeta(liveClarifyPayload, clarifyContext, workflowStage),
    [liveClarifyPayload, clarifyContext, workflowStage],
  );

  const loadingProgress = workflowStage === 'sufficiency_check'
    ? buildSufficiencyProgressMessage(sufficiencyProgressTick, clarifyContext)
    : workflowStage === 'clarify_round_2'
      ? (clarifyProgress || 'Preparing follow-up discovery questions…')
      : workflowStage === 'generation'
        ? (generationProgress || (pendingSessionId ? 'Starting generation…' : 'Preparing generation…'))
        : (clarifyProgress || 'Analyzing requirement and gathering context…');

  const applyDiscoveryEvaluationToContext = (
    baseContext: ClarifyContextMeta | null,
    evaluation: {
      sufficient?: boolean;
      missingCategoryKeys?: ClarifyCategoryKey[];
      reasonCodes?: string[];
      durationMs?: number;
      tokenUsage?: TokenUsageSummary;
    },
    followupQuestionCount: number,
  ): ClarifyContextMeta | null => {
    if (!baseContext) return baseContext;

    const initialCount = baseContext.initialQuestionCount ?? baseContext.totalQuestionCount ?? 0;
    const sufficiencyDurationMs = evaluation.durationMs ?? 0;
    const mergedTokenUsage = mergeTokenUsageSummary(baseContext.tokenUsage, evaluation.tokenUsage ?? null);

    return {
      ...baseContext,
      roundsCompleted: 1,
      followupTriggered: followupQuestionCount > 0,
      followupQuestionCount,
      totalQuestionCount: initialCount + followupQuestionCount,
      sufficiencyEvaluationDurationMs: sufficiencyDurationMs,
      totalDiscoveryDurationMs: (baseContext.initialClarifyDurationMs ?? 0) + sufficiencyDurationMs,
      finalSufficiency: {
        evaluated: true,
        sufficient: evaluation.sufficient ?? null,
        roundEvaluated: 1,
        missingCategoryKeys: evaluation.missingCategoryKeys ?? [],
        reasonCodes: evaluation.reasonCodes ?? [],
      },
      tokenUsage: mergedTokenUsage,
    };
  };

  const markDiscoveryRoundComplete = (completedRounds: 1 | 2) => {
    setClarifyContext(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        roundsCompleted: completedRounds,
        totalDiscoveryDurationMs:
          prev.totalDiscoveryDurationMs
          ?? ((prev.initialClarifyDurationMs ?? 0) + (prev.sufficiencyEvaluationDurationMs ?? 0)),
        finalSufficiency: prev.finalSufficiency
          ? { ...prev.finalSufficiency, roundEvaluated: completedRounds }
          : prev.finalSufficiency,
      };
    });
  };

  const handleClarifyComplete = async (submittedAnswers: ClarifyAnswer[]) => {
    const mergedAnswers = [...clarifyAnswers, ...submittedAnswers];
    setClarifyEvaluationError(null);

    if (clarifyRound === 2) {
      markDiscoveryRoundComplete(2);
      setWorkflowStage('generation');
      await startGeneration(requirement, mergedAnswers);
      return;
    }

    setClarifyAnswers(mergedAnswers);
    setIsEvaluatingDiscovery(true);
    setWorkflowStage('sufficiency_check');
    try {
      const evaluation = await api.evaluateSufficiency({
        sessionId: sessionIdRef.current,
        requirement,
        answers: mergedAnswers,
        askedQuestions: clarifyQuestions.map((question) => ({
          categoryKey: question.categoryKey,
          intent: question.intent,
          question: question.question,
        })),
        followupCap: clarifyContext?.discoveryProfile?.followupCap,
        initialQuestionCount: clarifyContext?.initialQuestionCount ?? clarifyQuestions.length,
        pipelineAudit: pipelineAuditActiveRef.current,
        auditRunId: pipelineAuditRunIdRef.current ?? undefined,
      }) as any;

      setWorkflowTokenUsage(prev => addTokenUsage(prev, evaluation?.tokenUsage ?? null));
      const followupQuestions = Array.isArray(evaluation?.questions) ? evaluation.questions : [];
      const nextContext = applyDiscoveryEvaluationToContext(clarifyContext, evaluation ?? {}, followupQuestions.length);
      setClarifyContext(nextContext);
      const evaluationWarning = typeof evaluation?.warning === 'string' ? evaluation.warning : null;

      if (!evaluation?.sufficient && followupQuestions.length > 0) {
        setClarifyAnswers(mergedAnswers);
        setClarifyRound(2);
        setClarifyQuestions(followupQuestions as ClarifyQuestion[]);
        setClarifyEvaluationError(null);
        setIsWorking(false);
        setWorkflowStage('clarify_round_2');
        return;
      }

      markDiscoveryRoundComplete(1);
      setWorkflowStage('generation');
      await startGeneration(requirement, mergedAnswers, evaluationWarning ?? undefined);
    } catch (err) {
      console.error('Discovery sufficiency evaluation failed', err);
      markDiscoveryRoundComplete(1);
      setWorkflowStage('generation');
      await startGeneration(requirement, mergedAnswers);
    } finally {
      setIsEvaluatingDiscovery(false);
    }
  };

  const handleClarifySkip = async () => {
    setClarifyBlockingError(null);
    setClarifyEvaluationError(null);
    if (clarifyRound === 2) {
      markDiscoveryRoundComplete(2);
      setWorkflowStage('generation');
      await startGeneration(requirement, clarifyAnswers);
      return;
    }

    markDiscoveryRoundComplete(1);
    setWorkflowStage('generation');
    await startGeneration(requirement, []);
  };

  const handleCancelWorkflow = async () => {
    const clarifyActive = Boolean(pendingClarifySessionId || isClarifying);
    const generationActive = Boolean(pendingSessionId || isGenerating);

    if (!clarifyActive && !generationActive) return;

    setWorkflowRunId(prev => prev + 1);
    setIsWorking(false);
    setPendingClarifySessionId(null);
    setPendingSessionId(null);
    setGenerationProgressMeta(null);
    setClarifyQuestions([]);
    setClarifyAnswers([]);
    setClarifyRound(1);
    setClarifyBlockingError(null);
    setClarifyEvaluationError(null);
    setIsEvaluatingDiscovery(false);
    setWorkflowStage('idle');

    if (clarifyActive) {
      await cancelClarify();
    }
    if (generationActive) {
      await cancelGeneration();
    }
    pipelineAuditRunIdRef.current = null;
    pipelineAuditActiveRef.current = false;
    setPipelineAuditBanner(null);
  };

  const resolveDiscoverySessionId = async () => {
    const currentSessionId = sessionIdRef.current;
    const boundSignature = activeSessionInputSignatureRef.current;
    const shouldReuseCurrentSession =
      !boundSignature || (
        boundSignature === discoveryInputSignature
        && (!restoredSessionInputSignature || restoredSessionInputSignature === discoveryInputSignature)
      );

    if (shouldReuseCurrentSession) {
      setSessionSignatures(discoveryInputSignature, restoredSessionInputSignatureRef.current);
      await persistSessionPointers(currentSessionId, originIssueKey);
      return currentSessionId;
    }

    const freshSessionId = createSessionId();
    setSessionId(freshSessionId);
    setSessionSignatures(discoveryInputSignature, discoveryInputSignature);
    await persistSessionPointers(freshSessionId, originIssueKey);
    return freshSessionId;
  };

  const handleStartBrainstorm = async () => {
    if (!requirement.trim() && !runAttachments.length) return;
    const attachmentText = runAttachments
      .map(attachment => `--- ${attachment.filename} ---\n${attachment.text}`)
      .join('\n\n');
    setIsWorking(true);
    setWorkflowRunId(prev => prev + 1);
    setGenerationError(null);
    setGenerationWarning(null);
    setFeatures([]);
    setGenerationContext(null);
    setGenerationProgressMeta(null);
    setClarifyContext(null);
    setWorkflowTokenUsage(null);
    setClarifyQuestions([]);
    setClarifyAnswers([]);
    setClarifyRound(1);
    setClarifyBlockingError(null);
    setClarifyEvaluationError(null);
    setIsEvaluatingDiscovery(false);
    setWorkflowStage('clarify_round_1');

    if (recordPipelineAuditForRun && workspacePipelineAuditEnabled) {
      pipelineAuditRunIdRef.current = crypto.randomUUID();
      pipelineAuditActiveRef.current = true;
    } else {
      pipelineAuditRunIdRef.current = null;
      pipelineAuditActiveRef.current = false;
    }
    setPipelineAuditBanner(null);

    try {
      const clarifySessionId = await resolveDiscoverySessionId();
      const res = await api.startClarify({
        sessionId: clarifySessionId,
        requirement,
        attachmentText,
        projectKey,
        projectKeys,
        inputSignature: discoveryInputSignature,
        pipelineAudit: pipelineAuditActiveRef.current,
        auditRunId: pipelineAuditRunIdRef.current ?? undefined,
      }) as any;
      if (res.success) {
        setPendingClarifySessionId(clarifySessionId);
      } else {
        setIsWorking(false);
        setWorkflowStage('blocked');
        setClarifyContext({
          projectKey,
          domainRolesUsed: [],
          discoveryStatus: 'discovery_failed',
          failureReasonCode: 'queue_error',
        });
        setClarifyBlockingError({
          message: res.error || 'Discovery could not be started. Please retry.',
          reasonCode: 'queue_error',
        });
      }
    } catch (err: any) {
      setIsWorking(false);
      setWorkflowStage('blocked');
      setClarifyContext({
        projectKey,
        domainRolesUsed: [],
        discoveryStatus: 'discovery_failed',
        failureReasonCode: 'queue_error',
      });
      setClarifyBlockingError({
        message: err?.message ?? 'Discovery could not be started. Please retry.',
        reasonCode: 'queue_error',
      });
    }
  };

  const handleRetryClarify = async () => {
    const attachmentText = runAttachments
      .map(attachment => `--- ${attachment.filename} ---\n${attachment.text}`)
      .join('\n\n');

    setIsWorking(true);
    setWorkflowRunId(prev => prev + 1);
    setPendingClarifySessionId(sessionId);
    setClarifyBlockingError(null);
    setClarifyEvaluationError(null);
    setClarifyQuestions([]);
    setClarifyRound(1);
    setClarifyAnswers([]);
    setWorkflowStage('clarify_round_1');

    if (recordPipelineAuditForRun && workspacePipelineAuditEnabled) {
      pipelineAuditRunIdRef.current = crypto.randomUUID();
      pipelineAuditActiveRef.current = true;
    } else {
      pipelineAuditRunIdRef.current = null;
      pipelineAuditActiveRef.current = false;
    }
    setPipelineAuditBanner(null);

    try {
      const clarifySessionId = await resolveDiscoverySessionId();
      setPendingClarifySessionId(clarifySessionId);
      const res = await api.retryClarify({
        sessionId: clarifySessionId,
        requirement,
        attachmentText,
        projectKey,
        projectKeys,
        inputSignature: discoveryInputSignature,
        pipelineAudit: pipelineAuditActiveRef.current,
        auditRunId: pipelineAuditRunIdRef.current ?? undefined,
      }) as any;
      if (!res?.success) {
        setPendingClarifySessionId(null);
        setIsWorking(false);
        setWorkflowStage('blocked');
        setClarifyContext({
          projectKey,
          domainRolesUsed: [],
          discoveryStatus: 'discovery_failed',
          failureReasonCode: 'queue_error',
        });
        setClarifyBlockingError({
          message: res?.error || 'Discovery could not be retried. Please try again.',
          reasonCode: 'queue_error',
        });
      }
    } catch (err: any) {
      setPendingClarifySessionId(null);
      setIsWorking(false);
      setWorkflowStage('blocked');
      setClarifyContext({
        projectKey,
        domainRolesUsed: [],
        discoveryStatus: 'discovery_failed',
        failureReasonCode: 'queue_error',
      });
      setClarifyBlockingError({
        message: err?.message ?? 'Discovery could not be retried. Please try again.',
        reasonCode: 'queue_error',
      });
    }
  };

  // Helpers to avoid stale closures in effects
  const requirementRef = useRef(requirement);
  requirementRef.current = requirement;
  const startGeneration = async (
    reqText: string,
    clarifyAnswers: ClarifyAnswer[],
    continuationWarning?: string,
  ) => {
    const sid = sessionIdRef.current;
    const req = reqText || requirementRef.current;
    const attachmentText = runAttachments
      .map(attachment => `--- ${attachment.filename} ---\n${attachment.text}`)
      .join('\n\n');
    
    setIsWorking(true);
    setWorkflowRunId(prev => prev + 1);
    setGenerationError(null);
    setClarifyQuestions([]);
    setClarifyAnswers([]);
    setClarifyRound(1);
    setClarifyBlockingError(null);
    setClarifyEvaluationError(null);
    setIsEvaluatingDiscovery(false);
    setGenerationProgressMeta(null);
    setPendingClarifySessionId(null);
    setWorkflowStage('generation');

    try {
      setPendingSessionId(sid);

      const res = await api.startGeneration({
        sessionId: sid,
        requirement: req,
        clarifyAnswers,
        attachmentText,
        outputProfileOverride: runOutputProfileOverride,
        projectKey,
        projectKeys,
        clarifyDiscoveryProfile: clarifyContext?.discoveryProfile ?? undefined,
        clarifySizingContract: clarifyContext?.sizingContract ?? undefined,
        clarifyAdvisoryTriage: clarifyContext?.advisoryTriage ?? undefined,
        pipelineAudit: pipelineAuditActiveRef.current,
        auditRunId: pipelineAuditRunIdRef.current ?? undefined,
      }) as any;

      if (res?.success) {
        setGenerationWarning(res?.warning || continuationWarning || null);
      } else {
        setGenerationError(`Generation blocked: ${res?.error || JSON.stringify(res)}`);
        setIsWorking(false);
        setPendingSessionId(null);
        setGenerationProgressMeta(null);
        setWorkflowStage('blocked');
      }
    } catch (err: any) {
      setGenerationError(`Generation error: ${err?.message ?? String(err)}`);
      setIsWorking(false);
      setPendingSessionId(null);
      setGenerationProgressMeta(null);
      setWorkflowStage('blocked');
    }
  };

  const retryFailedFeatureGeneration = async (featureId: string) => {
    const sid = sessionIdRef.current;
    setRetryingFeatureId(featureId);
    setWorkflowRunId(prev => prev + 1);
    setGenerationError(null);
    setGenerationWarning(null);
    setPendingClarifySessionId(null);

    setFeatures((prev) => prev.map((feature) => (
      feature.id === featureId
        ? {
            ...feature,
            arGenerationStatus: 'retrying',
            arGenerationError: undefined,
          }
        : feature
    )));

    try {
      setPendingSessionId(sid);
      const res = await api.retryFailedFeatureGeneration({
        sessionId: sid,
        featureId,
      }) as any;
      if (!res?.success) {
        setGenerationError(`Generation blocked: ${res?.error || JSON.stringify(res)}`);
        setPendingSessionId(null);
        setRetryingFeatureId(null);
      }
    } catch (err: any) {
      setGenerationError(`Generation error: ${err?.message ?? String(err)}`);
      setPendingSessionId(null);
      setRetryingFeatureId(null);
    }
  };

  const handleCreateJiraFeature = async (formData: any) => {
    if (formData && formData.key && activePushFeatureIdx !== null) {
      const updatedFeatures = [...features];
      updatedFeatures[activePushFeatureIdx] = { 
        ...updatedFeatures[activePushFeatureIdx], 
        jiraIssueKey: formData.key, 
        jiraIssueUrl: formData.url 
      };
      
      setFeatures(updatedFeatures);
      setLastAiChange(null);
      
      // Persist the linked issue key back to Forge Storage
      api.updateConversationFeatures(sessionId, updatedFeatures, { clearLastAiChange: true }).catch(err => {
        console.error('Failed to persist created issue key:', err);
      });
    }
    setActivePushFeatureIdx(null);
  };

  const restoreSession = async (sid: string) => {
    try {
      const res = await api.getConversation(sid) as any;
      if (res.success && res.conversation) {
        setWorkflowRunId(prev => prev + 1);
        setPendingSessionId(null);
        setPendingClarifySessionId(null);
        setGenerationProgressMeta(null);
        setIsWorking(false);
        setClarifyQuestions([]);
        setClarifyAnswers([]);
        setClarifyRound(1);
        setClarifyBlockingError(null);
        setClarifyEvaluationError(null);
        setIsEvaluatingDiscovery(false);
        setRunAttachments([]);
        setRunAttachmentParseState(null);
        setRunAttachmentError(null);
        setWorkflowStage('idle');
        setLastAiChange(null);
        const restoredSignature = buildConversationInputSignature(res.conversation, {
          projectKey,
          contextMode,
        });
        setSessionId(res.conversation.sessionId);
        setSessionSignatures(restoredSignature, restoredSignature);
        hydrateConversationState(res.conversation);
        setViewMode('generate');
        void persistSessionPointers(
          res.conversation.sessionId,
          originIssueKey,
          Boolean(originIssueKey),
        ).catch((err) => {
          console.error('Failed to persist restored session pointers:', err);
        });
      }
    } catch (err) {
      console.error('Failed to restore session:', err);
    }
  };

  const handleUndoLastAiChange = async () => {
    try {
      const res = await api.undoLastAiChange(sessionId) as any;
      if (!res?.success || !Array.isArray(res.features)) {
        throw new Error(res?.error || 'Undo failed');
      }
      setFeatures(res.features);
      setLastAiChange(null);
      setGenerationError(null);
      setGenerationWarning(null);
      loadHistory();
    } catch (err: any) {
      setGenerationError(`Undo failed: ${err?.message ?? String(err)}`);
    }
  };

  const handleAddRunAttachments = async (files: File[]) => {
    if (!files.length) return;
    setRunAttachmentError(null);

    try {
      const parsedAttachments: RunAttachment[] = [];
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        const label = files.length > 1 ? `${file.name} (${i + 1}/${files.length})` : file.name;
        setRunAttachmentParseState({ filename: label, stage: 'reading' });
        const base64 = await fileToBase64(file);
        setRunAttachmentParseState({ filename: label, stage: 'parsing' });
        const res = await api.parseRunAttachment(file.name, base64) as any;
        if (res?.success === false) {
          throw new Error(res.error || `Could not parse ${file.name}`);
        }
        parsedAttachments.push({
          id: `${file.name}_${file.size}_${file.lastModified}`,
          filename: res?.filename || file.name,
          text: String(res?.text ?? ''),
          charCount: Number(res?.charCount ?? String(res?.text ?? '').length),
        });
      }

      setRunAttachments(prev => {
        const next = new Map(prev.map(attachment => [attachment.id, attachment]));
        parsedAttachments.forEach(attachment => {
          next.set(attachment.id, attachment);
        });
        return [...next.values()];
      });
    } catch (err: any) {
      console.error('Run attachment parsing failed', err);
      setRunAttachmentError(err?.message || 'Could not parse the selected attachment.');
    } finally {
      setRunAttachmentParseState(null);
    }
  };

  const handleRemoveRunAttachment = (attachmentId: string) => {
    setRunAttachments(prev => prev.filter(attachment => attachment.id !== attachmentId));
    setRunAttachmentError(null);
  };

  const downloadPipelineAuditJson = async () => {
    if (!pipelineAuditBanner) return;
    try {
      const res = (await api.getPipelineAudit({
        sessionId: pipelineAuditBanner.sessionId,
        auditRunId: pipelineAuditBanner.auditRunId,
      })) as any;
      if (!res?.success || !res.bundle) {
        alert(res?.error || 'Could not load audit bundle.');
        return;
      }
      const blob = new Blob([JSON.stringify(res.bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pipeline-audit-${pipelineAuditBanner.sessionId.slice(0, 8)}-${pipelineAuditBanner.auditRunId.slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(e?.message || 'Download failed');
    }
  };

  // Open settings: always collapse sidebar to give full screen
  const openSettings = () => {
    setViewMode('settings');
    if (sidebarOpen) closeSidebar();
  };

  const openProjectSettings = (tab: 'models' | 'jira' | 'domain' | 'billing', projectKeyForSettings: string) => {
    setSettingsStartTab(tab);
    setSettingsStartProjectKey(projectKeyForSettings);
    openSettings();
  };

  return (
    <div className="flex h-full w-full overflow-hidden text-[var(--rf-text)] font-sans bg-transparent">
      {/* Left Sidebar — animated & resizable */}
      <AnimatePresence>
        {(sidebarOpen || sidebarExiting) && (
          <motion.div
            key="sidebar"
            initial={{ opacity: 0, x: -16, width: 0 }}
            animate={{ opacity: 1, x: 0, width: resolvedSidebarWidth }}
            exit={{ opacity: 0, x: -16, width: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="shrink-0 overflow-hidden shadow-2xl z-40 relative"
          >
            <div className="relative h-full w-full flex">
              <Sidebar
              viewMode={viewMode}
              setViewMode={(mode: 'generate' | 'settings') => {
                if (mode === 'settings') { openSettings(); }
                else setViewMode(mode);
              }}
              requirement={requirement}
              setRequirement={setRequirement}
              onStartBrainstorm={() => { handleStartBrainstorm(); closeSidebar(); }}
              onNewSession={() => {
                let newSid: string;
                newSid = createSessionId();
                pipelineAuditRunIdRef.current = null;
                pipelineAuditActiveRef.current = false;
                setPipelineAuditBanner(null);

                setSessionSignatures(null, null);
                setRequirement('');
                setFeatures([]);
                setGenerationContext(null);
                setGenerationProgressMeta(null);
                setClarifyContext(null);
                setWorkflowTokenUsage(null);
                setClarifyQuestions([]);
                setPendingSessionId(null);
                setPendingClarifySessionId(null);
                setGenerationError(null);
                setWorkflowRunId(prev => prev + 1);
                setIsWorking(false);
                setRunAttachments([]);
                setRunAttachmentParseState(null);
                setRunAttachmentError(null);
                setSidebarOpen(true);
                setSidebarExiting(false);
                setSessionId(newSid);
                void persistSessionPointers(newSid, originIssueKey);
                if (preferredProjectKeys.length > 0) {
                  setSelectedProjectKeys(preferredProjectKeys);
                } else {
                  setSelectedProjectKeys([], { nextContextMode: 'undecided' });
                }
              }}
              conversations={conversations}
              currentSessionId={sessionId}
              onRestoreSession={async (sid: string) => { await restoreSession(sid); closeSidebar(); }}
              isWorking={isWorking || isGenerating}
              onToggleSidebar={closeSidebar}
              onOpenHistory={() => setHistoryModalOpen(true)}
              isAdmin={isAdmin}
              tier={tier}
              usage={usage}
              limits={limits}
              brandingLogoUrl={brandingLogoUrl}
              reviewBeforeARs={reviewBeforeARs}
              width={resolvedSidebarWidth}
              originIssueKey={originIssueKey}
              projectKeys={projectKeys}
              setProjectKeys={setSelectedProjectKeys}
              contextMode={contextMode}
              setContextMode={setContextMode}
              workspaceSelectionVersion={workspaceSelectionVersion}
              availableProjects={availableProjects}
              cacheCountsByProject={sidebarCacheCounts}
              wiDocs={wiDocs}
              onOpenProjectSettings={openProjectSettings}
              runAttachments={runAttachments}
              runAttachmentParseState={runAttachmentParseState}
              runAttachmentError={runAttachmentError}
              onAddRunAttachments={handleAddRunAttachments}
              onRemoveRunAttachment={handleRemoveRunAttachment}
              workspacePipelineAuditEnabled={workspacePipelineAuditEnabled}
              recordPipelineAuditForRun={recordPipelineAuditForRun}
              setRecordPipelineAuditForRun={setRecordPipelineAuditForRun}
            />
              {/* Resize Handle */}
              {sidebarOpen && (
                <div
                  onMouseDown={startResizing}
                  className="absolute top-0 -right-1.5 w-3 h-full cursor-col-resize hover:bg-[var(--rf-brand-muted)]0/20 group z-50 transition-colors flex items-center justify-center"
                  style={{ cursor: 'col-resize' }}
                >
                  <div className="w-1 h-8 bg-white/20 group-hover:bg-[var(--rf-brand-muted)]0 rounded-full transition-colors" />
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Right Pane / Settings */}
      {viewMode === 'settings' && isAdmin ? (
        <SettingsView
          onClose={() => {
            if (onCloseSettings) {
              onCloseSettings();
              return;
            }
            setViewMode('generate');
            setSidebarOpen(true);
            api.getConfig()
              .then((res: any) => {
                if (!res) return;
                setBrandingLogoUrl(res?.branding?.logoUrl || null);
                if (res.tier) setTier(res.tier);
                if (res.isAdmin !== undefined) setIsAdmin(!!res.isAdmin);
                const profile = res?.generationPreferences?.outputProfile;
                const normalizedProfile: OutputProfile = profile === 'balanced' || profile === 'technical_first' ? profile : 'business_first';
                setWorkspaceOutputProfile(normalizedProfile);
                setRunOutputProfileOverride(normalizedProfile);
                setWorkspacePipelineAuditEnabled(Boolean(res?.developerTools?.pipelineAuditEnabled));
              })
              .catch(() => {});
          }}
          initialTab={settingsStartTab}
          initialProjectKey={settingsStartProjectKey}
        />
      ) : (
        <div className="rf-main-shell rf-pane-seam flex-1 flex flex-col h-full relative overflow-hidden">
          <AnimatePresence>
            {pipelineAuditBanner && (
              <motion.div
                key="pipeline-audit-banner"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className="absolute top-3 left-1/2 z-50 -translate-x-1/2 max-w-[min(640px,calc(100%-2rem))] w-full px-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-3 shadow-lg">
                  <span className="text-[13px] font-semibold text-[var(--rf-text)]">Pipeline audit ready — export JSON for external review.</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => { void downloadPipelineAuditJson(); }}
                      className="rounded-lg bg-[var(--rf-brand)] px-3 py-1.5 text-[12px] font-bold text-white"
                    >
                      Download JSON
                    </button>
                    <button
                      type="button"
                      onClick={() => setPipelineAuditBanner(null)}
                      className="rounded-lg border border-[var(--rf-border)] px-3 py-1.5 text-[12px] font-semibold text-[var(--rf-text-secondary)]"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
            {generationError && (
              <motion.div
                className="w-full bg-[var(--rf-danger-subtle)]/80 backdrop-blur-md text-[var(--rf-danger)] border-b border-[var(--rf-danger-subtle)] px-6 py-3 text-sm font-bold flex items-start gap-3 z-50"
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
              >
                <span className="flex-1">{generationError}</span>
                <button onClick={() => setGenerationError(null)} className="text-rose-500 hover:text-rose-800 font-bold text-sm leading-none p-1 bg-white/50 rounded-md transition">&times;</button>
              </motion.div>
            )}
            {generationWarning && !generationError && (
              <motion.div
                className="w-full bg-[var(--rf-warning-subtle)] backdrop-blur-sm text-[var(--rf-warning)] border-b border-[rgba(160,81,30,0.12)] px-6 py-3 text-sm font-bold flex items-start gap-3 z-40"
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
              >
                <span className="flex-1">{generationWarning}</span>
                <button onClick={() => setGenerationWarning(null)} className="text-[var(--rf-warning)] hover:text-[var(--rf-text)] font-bold text-sm leading-none p-1 bg-white/50 rounded-md transition">&times;</button>
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence mode="wait">
            {((clarifyQuestions.length > 0 && (workflowStage === 'clarify_round_1' || workflowStage === 'clarify_round_2'))
              || clarifyBlockingError) ? (
              <motion.div
                key="clarify-view"
                className="flex-1 flex flex-col h-full overflow-hidden"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
              >
                <ClarifyQuestionsView 
                  key={`clarify-round-${clarifyRound}`}
                  questions={clarifyQuestions} 
                  onComplete={handleClarifyComplete}
                  onSkip={handleClarifySkip}
                  onRetry={handleRetryClarify}
                  round={clarifyRound}
                  isSubmitting={isEvaluatingDiscovery}
                  submitLabel={clarifyRound === 2 ? 'Generate Features' : 'Continue Discovery'}
                  skipLabel={clarifyRound === 2 ? 'Skip follow-up' : 'Skip all'}
                  contextMeta={clarifyContext}
                  blockingState={clarifyBlockingError}
                  inlineError={clarifyEvaluationError}
                  priorAnswers={clarifyRound === 1 ? clarifyAnswers : []}
                  sidebarOpen={sidebarOpen}
                  setSidebarOpen={setSidebarOpen}
                />
              </motion.div>
            ) : (
              <motion.div
                key="main-view"
                className="flex-1 flex flex-col h-full overflow-hidden"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
              >
                <MainContent
                  features={features}
                  setFeatures={setFeatures}
                  onSetLastAiChange={setLastAiChange}
                  onPushFeature={(idx: number) => setActivePushFeatureIdx(idx)}
                  isGenerating={isCanvasLoading}
                  progress={loadingProgress}
                  loadingTitle={loadingTitle}
                  onCancelLoading={handleCancelWorkflow}
                  canCancelLoading={isCanvasLoading}
                  sidebarOpen={sidebarOpen}
                  setSidebarOpen={setSidebarOpen}
                  sessionId={sessionId}
                  requirement={requirement}
                  generationContext={generationContext}
                  generationProgressMeta={generationProgressMeta}
                  clarifyContext={clarifyContext}
                  clarifyProgressMeta={clarifyLoadingMeta}
                  workflowStage={workflowStage}
                  projectKey={projectKey}
                  workflowTokenUsage={workflowTokenUsage}
                  isAdmin={isAdmin}
                  onOpenSettings={openSettings}
                  onRetryFailedFeature={retryFailedFeatureGeneration}
                  retryingFeatureId={retryingFeatureId}
                  onUndoLastAiChange={handleUndoLastAiChange}
                  undoActionLabel={lastAiChange?.label || null}
                  onRegenerate={(feedback) => {
                    const augmented = requirement?.trim()
                      ? `${requirement.trim()}\n\nADDITIONAL FEEDBACK FOR REGENERATION:\n${feedback}`
                      : feedback;
                    setRequirement(augmented);
                    requestAnimationFrame(() => handleStartBrainstorm());
                  }}
                  onWorkflowTokenUsage={(usageDelta) => {
                    setWorkflowTokenUsage(prev => {
                      const base = prev || { input: 0, output: 0, total: 0 };
                      return {
                        input: base.input + usageDelta.input,
                        output: base.output + usageDelta.output,
                        total: base.total + usageDelta.total
                      };
                    });
                  }}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Create Jira Modal */}
      {activePushFeatureIdx !== null && (
        <JiraModal
          onClose={() => setActivePushFeatureIdx(null)}
          onCreate={handleCreateJiraFeature}
          feature={features[activePushFeatureIdx]}
          originIssueKey={originIssueKey ?? undefined}
          sessionId={sessionId}
          defaultProjectKey={projectKey}
        />
      )}

      {/* History Modal */}
      {isHistoryModalOpen && (
        <HistoryModal
          onClose={() => setHistoryModalOpen(false)}
          onRestore={async (sid: string) => { await restoreSession(sid); closeSidebar(); }}
          conversations={conversations}
          currentSessionId={sessionId}
          refreshHistory={loadHistory}
        />
      )}
    </div>
  );
}

function detectQuickRefineSurface(ctx: any): 'issue-panel' | 'issue-action' | null {
  const moduleKey = String(
    ctx?.moduleKey
    || ctx?.extension?.moduleKey
    || ctx?.localId
    || '',
  );

  if (moduleKey.includes('quick-refine-issue-panel')) return 'issue-panel';
  return null;
}

export default function App() {
  const [surface, setSurface] = useState<'issue-panel' | 'issue-action' | null>(null);
  const [ready, setReady] = useState(false);
  const [openLegacyWorkflow, setOpenLegacyWorkflow] = useState(false);
  const [legacyLaunchMode, setLegacyLaunchMode] = useState<'generate' | 'settings'>('generate');
  const [legacySettingsTab, setLegacySettingsTab] = useState<'models' | 'jira' | 'domain' | 'billing'>('models');
  const [legacyPrefillRequirement, setLegacyPrefillRequirement] = useState('');
  const [quickRefineViewState, setQuickRefineViewState] = useState<QuickRefineViewState | null>(null);
  const [returnToQuickRefine, setReturnToQuickRefine] = useState(false);

  useEffect(() => {
    let cancelled = false;

    view.getContext()
      .then((ctx: any) => {
        if (cancelled) return;
        setSurface(detectQuickRefineSurface(ctx));
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return <div className="h-full w-full" />;
  }

  if (surface && !openLegacyWorkflow) {
    return (
      <QuickRefineApp
        surface={surface}
        initialState={quickRefineViewState}
        onStateChange={setQuickRefineViewState}
        onOpenFullWorkflow={(prefillInstruction) => {
          setLegacyPrefillRequirement(String(prefillInstruction ?? '').trim());
          setLegacyLaunchMode('generate');
          setLegacySettingsTab('models');
          setReturnToQuickRefine(false);
          setOpenLegacyWorkflow(true);
        }}
        onOpenSettings={() => {
          setLegacyLaunchMode('settings');
          setLegacySettingsTab('jira');
          setReturnToQuickRefine(true);
          setOpenLegacyWorkflow(true);
        }}
      />
    );
  }

  return (
    <LegacyApp
      initialViewMode={legacyLaunchMode}
      initialSettingsTab={legacySettingsTab}
      initialRequirement={legacyPrefillRequirement}
      onCloseSettings={returnToQuickRefine ? () => {
        setOpenLegacyWorkflow(false);
        setReturnToQuickRefine(false);
      } : undefined}
    />
  );
}
