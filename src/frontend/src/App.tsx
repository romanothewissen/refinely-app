import React, { useState, useEffect, useMemo, useRef } from 'react';
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
import type {
  ClarifyAnswer,
  ClarifyCategoryKey,
  ClarifyContextMeta,
  ClarifyFailureReasonCode,
  ClarifyQuestion,
  GenerationContextMeta,
  TokenUsageSummary,
} from './types';

export interface Feature {
  id: string;
  summary: string;
  description: string;
  acceptanceRequirements: Array<{ given: string; when: string; then: string }>;
  storyPoints?: number;
  processCode?: string;
  markdown?: string;
  title?: string;
  isAccepted?: boolean;
  jiraIssueKey?: string;
  jiraIssueUrl?: string;
  pendingRefinement?: Feature;
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

function buildDiscoveryInputSignature(params: {
  requirement: string;
  projectKey: string;
  contextMode: 'undecided' | 'project' | 'global';
  attachments: RunAttachment[];
}): string {
  return JSON.stringify({
    requirement: params.requirement.trim(),
    projectKey: params.projectKey,
    contextMode: params.contextMode,
    attachments: params.attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      text: attachment.text,
    })),
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

export default function App() {
  const [viewMode, setViewMode] = useState<'generate' | 'settings'>('generate');
  const [settingsStartTab, setSettingsStartTab] = useState<'models' | 'jira' | 'domain' | 'billing'>('models');
  const [settingsStartProjectKey, setSettingsStartProjectKey] = useState<string>('*');
  const [requirement, setRequirement] = useState('');
  const [activePushFeatureIdx, setActivePushFeatureIdx] = useState<number | null>(null);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [generationContext, setGenerationContext] = useState<GenerationContextMeta | null>(null);
  const [generationProgressMeta, setGenerationProgressMeta] = useState<GenerationProgressPayload | null>(null);
  const [clarifyContext, setClarifyContext] = useState<ClarifyContextMeta | null>(null);
  const [workflowTokenUsage, setWorkflowTokenUsage] = useState<WorkflowTokenUsage | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string>(() => {
    try { return crypto.randomUUID(); } 
    catch(e) { return `fallback_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`; }
  });
  
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
  const [clarifyBlockingError, setClarifyBlockingError] = useState<{ message: string; reasonCode?: ClarifyFailureReasonCode } | null>(null);
  const [clarifyEvaluationError, setClarifyEvaluationError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarExiting, setSidebarExiting] = useState(false);
  const [isHistoryModalOpen, setHistoryModalOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [tier, setTier] = useState('free');
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
  const [projectKey, setProjectKey] = useState<string>('*');
  const [contextMode, setContextMode] = useState<'undecided' | 'project' | 'global'>('undecided');
  const [availableProjects, setAvailableProjects] = useState<Array<{ key: string; name: string }>>([]);
  const [brandingLogoUrl, setBrandingLogoUrl] = useState<string | null>(null);
  const [wiDocs, setWiDocs] = useState<any[]>([]);
  const [runAttachments, setRunAttachments] = useState<RunAttachment[]>([]);
  const [runAttachmentParseState, setRunAttachmentParseState] = useState<{ filename: string; stage: 'reading' | 'parsing' } | null>(null);
  const [runAttachmentError, setRunAttachmentError] = useState<string | null>(null);
  const activeDiscoveryInputSignatureRef = useRef<string | null>(null);

  // History
  const [conversations, setConversations] = useState<any[]>([]);

  // Animated sidebar close helper
  const closeSidebar = () => {
    setSidebarExiting(true);
    setTimeout(() => { setSidebarOpen(false); setSidebarExiting(false); }, 270);
  };

  // Fetch Atlassian account ID once on mount; detect issue context if launched via issueAction
  useEffect(() => {
    view.getContext().then(async (ctx: any) => {
      if (!ctx) return;
      const aid = ctx.accountId as string | undefined;
      if (!aid) return;
      setAccountId(aid);

      const issueKey = ctx.extension?.issue?.key as string | undefined;
      const ctxProjectKey =
        (ctx.extension?.project?.key as string | undefined) ||
        (ctx.extension?.projectKey as string | undefined) ||
        (issueKey ? issueKey.split('-')[0] : undefined);
      if (ctxProjectKey) {
        setProjectKey(ctxProjectKey);
        setContextMode('project');
      }

      if (issueKey) {
        setOriginIssueKey(issueKey);
        try {
          const issueSidRes = await api.getIssueSession(issueKey) as any;
          const issueSid = issueSidRes?.sessionId as string | null;
          if (issueSid) {
            setSessionId(issueSid);
          } else {
            const lastRes = await api.getLastSession() as any;
            const sid = lastRes?.sessionId ?? sessionId;
            await api.setIssueSession(issueKey, sid);
            setSessionId(sid);
          }

          const res = await requestJira(`/rest/api/3/issue/${issueKey}?fields=summary,description`);
          if (res.ok) {
            const data = await res.json() as any;
            const summary = data.fields?.summary ?? '';
            const description = extractAdfText(data.fields?.description);
            const text = [summary, description].filter(Boolean).join('\n\n');
            if (text) setRequirement(text);
          }
        } catch (e) { console.error('Issue context error', e); }
      } else {
        try {
          const lastRes = await api.getLastSession() as any;
          if (lastRes?.sessionId) setSessionId(lastRes.sessionId);
        } catch {}
      }
    }).catch(err => console.error('Context error', err));
  }, []); // eslint-disable-line

  useEffect(() => {
    api.discoverJira()
      .then((res: any) => {
        const projects = Array.isArray(res?.projects) ? res.projects : [];
        setAvailableProjects(projects);
        if (projectKey === '*' && projects.length === 1) {
          setProjectKey(projects[0].key);
          setContextMode('project');
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line

  useEffect(() => {
    api.getConfig()
      .then((res: any) => {
        setBrandingLogoUrl(res?.branding?.logoUrl || null);
      })
      .catch(() => {});
  }, []); // eslint-disable-line

  const loadWiDocs = async (nextProjectKey = projectKey) => {
    try {
      const res = await api.listWiDocs(nextProjectKey) as any;
      setWiDocs(Array.isArray(res?.docs) ? res.docs : []);
    } catch {}
  };

  useEffect(() => {
    loadWiDocs(projectKey);
  }, [projectKey]); // eslint-disable-line

  const discoveryInputSignature = useMemo(
    () => buildDiscoveryInputSignature({
      requirement,
      projectKey,
      contextMode,
      attachments: runAttachments,
    }),
    [requirement, projectKey, contextMode, runAttachments],
  );

  useEffect(() => {
    const activeSignature = activeDiscoveryInputSignatureRef.current;
    if (!activeSignature || activeSignature === discoveryInputSignature) return;

    const hasDiscoveryState =
      clarifyQuestions.length > 0
      || clarifyAnswers.length > 0
      || Boolean(clarifyContext)
      || Boolean(clarifyBlockingError)
      || Boolean(clarifyEvaluationError)
      || clarifyRound !== 1;

    activeDiscoveryInputSignatureRef.current = null;

    if (!hasDiscoveryState) return;

    setPendingClarifySessionId(null);
    setClarifyQuestions([]);
    setClarifyAnswers([]);
    setClarifyRound(1);
    setClarifyContext(null);
    setClarifyBlockingError(null);
    setClarifyEvaluationError(null);
    setIsEvaluatingDiscovery(false);
  }, [
    discoveryInputSignature,
    clarifyQuestions.length,
    clarifyAnswers.length,
    clarifyContext,
    clarifyBlockingError,
    clarifyEvaluationError,
    clarifyRound,
  ]);

  // Restore features from Forge Storage whenever sessionId or accountId changes
  useEffect(() => {
    if (!accountId) return;
    // Persist session pointer cross-device
    api.setLastSession(sessionId).catch(() => {});
    // Restore features from last conversation turn
    api.getConversation(sessionId).then((res: any) => {
      if (res?.success && res.conversation?.turns?.length > 0) {
        const lastTurn = res.conversation.turns[res.conversation.turns.length - 1];
        setWorkflowTokenUsage(sumWorkflowTokenUsage(res.conversation));
        setPendingSessionId(null);
        setPendingClarifySessionId(null);
        setIsWorking(false);
        if (lastTurn?.features?.length > 0) {
          setFeatures(lastTurn.features);
          setGenerationContext(lastTurn.generationContext ?? null);
          setSidebarOpen(false);
        }
      } else {
        setWorkflowTokenUsage(null);
      }
    }).catch(() => {});
    loadHistory();
  }, [sessionId, accountId]); // eslint-disable-line

  const [usage, setUsage] = useState<{ currentMonth: number } | null>(null);
  const [limits, setLimits] = useState<{ generationsPerMonth: number } | null>(null);

  const loadUsage = async () => {
    try {
      const res = await api.getUsage() as any;
      if (res?.usage) setUsage(res.usage);
      if (res?.limits) setLimits(res.limits);
    } catch {}
  };

  // Initial fetch of config and usage
  useEffect(() => {
    api.getConfig().then((res: any) => {
      if (!res) return;
      if (res.tier) setTier(res.tier);
      if (res.isAdmin !== undefined) setIsAdmin(!!res.isAdmin);
      setBrandingLogoUrl(res?.branding?.logoUrl || null);
    }).catch(e => console.error('Config fetch failed', e));
    loadUsage();
  }, []);

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
      setGenerationProgressMeta(null);
      setWorkflowTokenUsage(prev => addTokenUsage(prev, payload.generationContext?.tokenUsage ?? null));
      setPendingSessionId(null);
      setIsWorking(false);
      loadHistory();
      loadUsage();
    },
    (errMsg) => {
      setGenerationError(errMsg);
      setGenerationProgressMeta(null);
      setPendingSessionId(null);
      setIsWorking(false);
    }
    ,
    () => {
      setPendingSessionId(null);
      setGenerationProgressMeta(null);
      setIsWorking(false);
    }
  );

  useEffect(() => {
    setGenerationProgressMeta(liveGenerationPayload ?? null);
  }, [liveGenerationPayload]);

  const {
    cancelClarify,
    progress: clarifyProgress,
    isClarifying,
  } = useClarifyRealtime(
    pendingClarifySessionId,
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
        setClarifyQuestions(questions as ClarifyQuestion[]);
        setIsWorking(false);
      }
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
          discoveryStatus: 'blocked',
          failureReasonCode: reasonCode,
        },
      );
      setClarifyBlockingError({ message, reasonCode });
    },
    () => {
      setPendingClarifySessionId(null);
      setIsWorking(false);
    }
  );

  const isCanvasLoading = Boolean(pendingClarifySessionId || pendingSessionId || isClarifying || isGenerating);
  const loadingPhase: 'clarify' | 'generation' =
    pendingClarifySessionId || isClarifying ? 'clarify' : 'generation';
  const loadingTitle = loadingPhase === 'clarify' ? 'Exploring the requirement' : 'Crafting features';
  const loadingProgress = loadingPhase === 'clarify'
    ? (clarifyProgress || 'Analyzing requirement and gathering context…')
    : (generationProgress || (pendingSessionId ? 'Starting generation…' : 'Preparing generation…'));

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
      await startGeneration(requirement, mergedAnswers);
      return;
    }

    setIsEvaluatingDiscovery(true);
    try {
      const evaluation = await api.evaluateSufficiency({
        requirement,
        answers: mergedAnswers,
        askedQuestions: clarifyQuestions.map((question) => ({
          categoryKey: question.categoryKey,
          intent: question.intent,
          question: question.question,
        })),
        followupCap: clarifyContext?.discoveryProfile?.followupCap,
        initialQuestionCount: clarifyContext?.initialQuestionCount ?? clarifyQuestions.length,
        totalQuestionBudget: 20,
      }) as any;

      setWorkflowTokenUsage(prev => addTokenUsage(prev, evaluation?.tokenUsage ?? null));
      const followupQuestions = Array.isArray(evaluation?.questions) ? evaluation.questions : [];
      const nextContext = applyDiscoveryEvaluationToContext(clarifyContext, evaluation ?? {}, followupQuestions.length);
      setClarifyContext(nextContext);

      if (!evaluation?.sufficient && followupQuestions.length > 0) {
        setClarifyAnswers(mergedAnswers);
        setClarifyRound(2);
        setClarifyQuestions(followupQuestions as ClarifyQuestion[]);
        setClarifyEvaluationError(null);
        setIsWorking(false);
        return;
      }

      markDiscoveryRoundComplete(1);
      await startGeneration(requirement, mergedAnswers);
    } catch (err) {
      console.error('Discovery sufficiency evaluation failed', err);
      setClarifyEvaluationError('Discovery could not evaluate the current answers. Please retry discovery or skip explicitly if you want to continue without it.');
      setIsWorking(false);
    } finally {
      setIsEvaluatingDiscovery(false);
    }
  };

  const handleClarifySkip = async () => {
    activeDiscoveryInputSignatureRef.current = null;
    setClarifyBlockingError(null);
    setClarifyEvaluationError(null);
    if (clarifyRound === 2) {
      markDiscoveryRoundComplete(2);
      await startGeneration(requirement, clarifyAnswers);
      return;
    }

    markDiscoveryRoundComplete(1);
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
    activeDiscoveryInputSignatureRef.current = null;
    setClarifyQuestions([]);
    setClarifyAnswers([]);
    setClarifyRound(1);
    setClarifyBlockingError(null);
    setClarifyEvaluationError(null);
    setIsEvaluatingDiscovery(false);

    if (clarifyActive) {
      await cancelClarify();
    }
    if (generationActive) {
      await cancelGeneration();
    }
  };

  const handleStartBrainstorm = async () => {
    if (!requirement.trim() && !runAttachments.length) return;
    const attachmentText = runAttachments
      .map(attachment => `--- ${attachment.filename} ---\n${attachment.text}`)
      .join('\n\n');
    setIsWorking(true);
    setWorkflowRunId(prev => prev + 1);
    setGenerationError(null);
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
    activeDiscoveryInputSignatureRef.current = discoveryInputSignature;

    // Bind this session to the originating issue so re-launching restores it
    if (originIssueKey) {
      api.setIssueSession(originIssueKey, sessionId).catch(() => {});
    }

    try {
      const res = await api.startClarify(sessionId, requirement, attachmentText, projectKey) as any;
      if (res.success) {
        setPendingClarifySessionId(sessionId);
      } else {
        setIsWorking(false);
        setClarifyContext({
          projectKey,
          domainRolesUsed: [],
          discoveryStatus: 'blocked',
          failureReasonCode: 'queue_error',
        });
        setClarifyBlockingError({
          message: res.error || 'Discovery could not be started. Please retry.',
          reasonCode: 'queue_error',
        });
      }
    } catch (err: any) {
      setIsWorking(false);
      setClarifyContext({
        projectKey,
        domainRolesUsed: [],
        discoveryStatus: 'blocked',
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
    activeDiscoveryInputSignatureRef.current = discoveryInputSignature;

    try {
      const res = await api.retryClarify(sessionId, requirement, attachmentText, projectKey) as any;
      if (!res?.success) {
        setPendingClarifySessionId(null);
        setIsWorking(false);
        setClarifyContext({
          projectKey,
          domainRolesUsed: [],
          discoveryStatus: 'blocked',
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
      setClarifyContext({
        projectKey,
        domainRolesUsed: [],
        discoveryStatus: 'blocked',
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
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const startGeneration = async (reqText: string, clarifyAnswers: ClarifyAnswer[]) => {
    const sid = sessionIdRef.current;
    const req = reqText || requirementRef.current;
    const attachmentText = runAttachments
      .map(attachment => `--- ${attachment.filename} ---\n${attachment.text}`)
      .join('\n\n');
    
    setIsWorking(true);
    setWorkflowRunId(prev => prev + 1);
    setGenerationError(null);
    activeDiscoveryInputSignatureRef.current = null;
    setClarifyQuestions([]);
    setClarifyAnswers([]);
    setClarifyRound(1);
    setClarifyBlockingError(null);
    setClarifyEvaluationError(null);
    setIsEvaluatingDiscovery(false);
    setGenerationProgressMeta(null);
    // CRITICAL: Stop clarify polling if it was active
    setPendingClarifySessionId(null);

    try {
      // Set pending SID early so the polling hook starts immediately
      // This ensures 'isGenerating' becomes true and shows the skeleton
      setPendingSessionId(sid);

      const res = await api.startGeneration({
        sessionId: sid,
        requirement: req,
        clarifyAnswers,
        attachmentText,
        projectKey,
      }) as any;

      if (res?.success) {
        // resolver confirmed OK — polling is already running
      } else {
        setGenerationError(`Generation blocked: ${res?.error || JSON.stringify(res)}`);
        setIsWorking(false);
        setPendingSessionId(null);
        setGenerationProgressMeta(null);
      }
    } catch (err: any) {
      setGenerationError(`Generation error: ${err?.message ?? String(err)}`);
      setIsWorking(false);
      setPendingSessionId(null);
      setGenerationProgressMeta(null);
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
      
      // Persist the linked issue key back to Forge Storage
      api.updateConversationFeatures(sessionId, updatedFeatures).catch(err => {
        console.error('Failed to persist created issue key:', err);
      });
    }
    setActivePushFeatureIdx(null);
  };

  const restoreSession = async (sid: string) => {
    try {
      const res = await api.getConversation(sid) as any;
      if (res.success && res.conversation) {
        activeDiscoveryInputSignatureRef.current = null;
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
        setSessionId(res.conversation.sessionId);
        const lastTurn = res.conversation.turns[res.conversation.turns.length - 1];
        if (lastTurn) {
          setFeatures(lastTurn.features ?? []);
          setRequirement(lastTurn.requirement ?? '');
          setGenerationContext(lastTurn.generationContext ?? null);
          setClarifyContext(lastTurn.clarifyContext ?? null);
        }
        setWorkflowTokenUsage(sumWorkflowTokenUsage(res.conversation));
        setViewMode('generate');
      }
    } catch {}
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
                try { newSid = crypto.randomUUID(); }
                catch(e) { newSid = `sid_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`; }
                
                activeDiscoveryInputSignatureRef.current = null;
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
                setProjectKey('*');
                setContextMode('undecided');
              }}
              conversations={conversations}
              currentSessionId={sessionId}
              onRestoreSession={(sid: string) => { restoreSession(sid); closeSidebar(); }}
              isWorking={isWorking || isGenerating}
              onToggleSidebar={closeSidebar}
              onOpenHistory={() => setHistoryModalOpen(true)}
              isAdmin={isAdmin}
              tier={tier}
              usage={usage}
              limits={limits}
              brandingLogoUrl={brandingLogoUrl}
              width={resolvedSidebarWidth}
              originIssueKey={originIssueKey}
              projectKey={projectKey}
              setProjectKey={setProjectKey}
              contextMode={contextMode}
              setContextMode={setContextMode}
              availableProjects={availableProjects}
              wiDocs={wiDocs}
              onOpenProjectSettings={openProjectSettings}
              runAttachments={runAttachments}
              runAttachmentParseState={runAttachmentParseState}
              runAttachmentError={runAttachmentError}
              onAddRunAttachments={handleAddRunAttachments}
              onRemoveRunAttachment={handleRemoveRunAttachment}
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
            setViewMode('generate');
            setSidebarOpen(true);
            api.getConfig()
              .then((res: any) => {
                if (!res) return;
                setBrandingLogoUrl(res?.branding?.logoUrl || null);
                if (res.tier) setTier(res.tier);
                if (res.isAdmin !== undefined) setIsAdmin(!!res.isAdmin);
              })
              .catch(() => {});
          }}
          initialTab={settingsStartTab}
          initialProjectKey={settingsStartProjectKey}
        />
      ) : (
        <div className="rf-main-shell rf-pane-seam flex-1 flex flex-col h-full relative overflow-hidden">
          <AnimatePresence>
            {generationError && (
              <motion.div
                className="w-full bg-[var(--rf-danger-subtle)]/95 backdrop-blur-sm text-[var(--rf-danger)] border-b border-[var(--rf-danger-subtle)] px-6 py-3 text-sm font-bold flex items-start gap-3 z-50 shadow-sm"
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
              >
                <span className="flex-1">{generationError}</span>
                <button onClick={() => setGenerationError(null)} className="text-rose-500 hover:text-rose-800 font-bold text-sm leading-none p-1 bg-white/50 rounded-md transition">&times;</button>
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence mode="wait">
            {(clarifyQuestions.length > 0 || clarifyBlockingError) && !isEvaluatingDiscovery ? (
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
                  onPushFeature={(idx: number) => setActivePushFeatureIdx(idx)}
                  isGenerating={isCanvasLoading || isEvaluatingDiscovery}
                  progress={isEvaluatingDiscovery ? 'Validating information sufficiency...' : loadingProgress}
                  loadingTitle={isEvaluatingDiscovery ? 'Assessing scope' : loadingTitle}
                  onCancelLoading={handleCancelWorkflow}
                  canCancelLoading={isCanvasLoading}
                  sidebarOpen={sidebarOpen}
                  setSidebarOpen={setSidebarOpen}
                  sessionId={sessionId}
                  requirement={requirement}
                  generationContext={generationContext}
                  generationProgressMeta={generationProgressMeta}
                  projectKey={projectKey}
                  workflowTokenUsage={workflowTokenUsage}
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
          onRestore={(sid: string) => { restoreSession(sid); closeSidebar(); }}
          conversations={conversations}
          currentSessionId={sessionId}
          refreshHistory={loadHistory}
        />
      )}
    </div>
  );
}
