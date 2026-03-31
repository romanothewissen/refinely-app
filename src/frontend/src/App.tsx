import React, { useState, useEffect, useRef } from 'react';
import { requestJira, view } from '@forge/bridge';
import { motion, AnimatePresence } from 'framer-motion';
import { Sidebar } from './Sidebar';
import { MainContent } from './MainContent';
import { JiraModal } from './JiraModal';
import { SettingsView } from './SettingsView';
import { api } from './hooks/useForge';
import { useGenerationRealtime, useClarifyRealtime, type ClarifyFallthroughReason } from './hooks/useRealtime';
import { ClarifyQuestionsView } from './ClarifyQuestionsView';
import { HistoryModal } from './HistoryModal';
import { AiExecutionPolicy, DEFAULT_CONFIG, OutputMode, ReasoningMode } from './types';

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
  goldSources?: unknown[];
}

interface GenerationContextMeta {
  domainRolesUsed: string[];
  goldExamplesCount: number;
  referencedGoldExamples: Array<{ key: string; source: string; summary: string }>;
  projectKey: string;
  domainContextApplied?: boolean;
  attachmentIncluded?: boolean;
  wiDocsCount?: number;
  referencedWiDocs?: Array<{ docId: string; filename: string; chunkCount: number }>;
  similarStoriesCount?: number;
  referencedSimilarStories?: Array<{ key: string; summary: string; relevanceScore?: number; url?: string }>;
  initiativeGroups?: Array<{ id: string; title: string; summary: string; featureIds: string[] }>;
  discoveryCoverage?: DiscoveryCoverageSummary;
  discoveryTranscript?: DiscoveryRoundSummary[];
  tokenUsage?: { input: number; output: number; total: number; byStage?: Record<string, { input: number; output: number; total: number }> };
}

interface ClarifyContextMeta {
  projectKey: string;
  domainRolesUsed: string[];
  domainContextApplied?: boolean;
  attachmentIncluded?: boolean;
  goldExamplesCount?: number;
  referencedGoldExamples?: Array<{ key: string; source: string; summary: string }>;
  similarStoriesCount?: number;
  referencedSimilarStories?: Array<{ key: string; summary: string; relevanceScore?: number; url?: string }>;
  wiDocsCount?: number;
  referencedWiDocs?: Array<{ docId: string; filename: string; chunkCount: number }>;
  discoveryCoverage?: DiscoveryCoverageSummary;
  discoveryTranscript?: DiscoveryRoundSummary[];
  tokenUsage?: { input: number; output: number; total: number; byStage?: Record<string, { input: number; output: number; total: number }> };
}

interface DiscoveryCoverageSummary {
  sufficient: boolean;
  canGenerate: boolean;
  shouldContinueDiscovery: boolean;
  overallScore: number;
  summary: string;
  missingCritical: string[];
  dimensions: Array<{
    key: string;
    label: string;
    required: boolean;
    score: number;
    status: 'missing' | 'partial' | 'covered';
    evidence: string;
  }>;
  questions?: Array<{ category: string; question: string; suggestions: string[] }>;
  tokenUsage?: { input: number; output: number; total: number; byStage?: Record<string, { input: number; output: number; total: number }> };
}

interface DiscoveryRoundSummary {
  roundNumber: number;
  questions: Array<{ category: string; question: string; suggestions: string[] }>;
  answers: Array<{ question: string; answer: string }>;
  coverage?: DiscoveryCoverageSummary;
  submittedAt: string;
}

interface WorkflowTokenUsage {
  input: number;
  output: number;
  total: number;
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

function getDefaultSidebarWidth(viewportWidth?: number): number {
  const width = typeof viewportWidth === 'number'
    ? viewportWidth
    : (typeof window !== 'undefined' ? window.innerWidth : 0);

  if (!width || width <= 0) return 420;
  if (width <= 720) return Math.max(300, width - 48);
  // Default to 50% of window as requested, but clamp it to reasonable max/min
  return Math.min(Math.max(Math.round(width * 0.5), 360), width * 0.7);
}

export default function App() {
  const [viewMode, setViewMode] = useState<'generate' | 'settings'>('generate');
  const [settingsStartTab, setSettingsStartTab] = useState<'models' | 'jira' | 'domain' | 'billing'>('models');
  const [settingsStartProjectKey, setSettingsStartProjectKey] = useState<string>('*');
  const [requirement, setRequirement] = useState('');
  const [activePushFeatureIdx, setActivePushFeatureIdx] = useState<number | null>(null);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [reasoningMode, setReasoningMode] = useState<ReasoningMode>('fast');
  const [outputMode, setOutputMode] = useState<OutputMode>('auto');
  const [outputInstructions, setOutputInstructions] = useState('');
  const [effectiveAiPolicy, setEffectiveAiPolicy] = useState<AiExecutionPolicy>(DEFAULT_CONFIG.aiExecutionPolicy);
  const [generationContext, setGenerationContext] = useState<GenerationContextMeta | null>(null);
  const [clarifyContext, setClarifyContext] = useState<ClarifyContextMeta | null>(null);
  const [discoveryCoverage, setDiscoveryCoverage] = useState<DiscoveryCoverageSummary | null>(null);
  const [workflowTokenUsage, setWorkflowTokenUsage] = useState<WorkflowTokenUsage | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string>(() => {
    try { return crypto.randomUUID(); } 
    catch(e) { return `fallback_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`; }
  });
  
  // Realtime Integration
  const [clarifyQuestions, setClarifyQuestions] = useState<any[]>([]);
  const [discoveryAnswers, setDiscoveryAnswers] = useState<any[]>([]);
  const [discoveryRound, setDiscoveryRound] = useState(0);
  const [isReviewingDiscovery, setIsReviewingDiscovery] = useState(false);
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [pendingClarifySessionId, setPendingClarifySessionId] = useState<string | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarExiting, setSidebarExiting] = useState(false);
  const [isHistoryModalOpen, setHistoryModalOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [tier, setTier] = useState('free');
  const [sidebarWidth, setSidebarWidth] = useState(() => getDefaultSidebarWidth());
  const isResizing = useRef(false);

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
    
    // Persist the new width to Forge Storage
    const latestWidth = sidebarWidthRef.current;
    if (latestWidth) {
      api.setSidebarWidth(latestWidth).catch(err => console.error('Failed to save sidebar width', err));
    }
  };

  const startResizing = (e: React.MouseEvent) => {
    isResizing.current = true;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', endResizing);
  };
  
  // Issue context (when launched from a Jira issue via issueAction)
  const [originIssueKey, setOriginIssueKey] = useState<string | null>(null);
  const [projectKey, setProjectKey] = useState<string>('*');
  const [availableProjects, setAvailableProjects] = useState<Array<{ key: string; name: string }>>([]);
  const [goldSources, setGoldSources] = useState<any[]>([]);
  const [wiDocs, setWiDocs] = useState<any[]>([]);

  // History
  const [conversations, setConversations] = useState<any[]>([]);

  const restoreInFlightSession = async (sid: string) => {
    try {
      const [generationRes, clarifyRes] = await Promise.all([
        api.getProgress(sid),
        api.getClarifyResult(sid),
      ]) as any[];

      const generation = generationRes?.progress;
      const clarify = clarifyRes?.result;

      // A completed generation with features is always safe to restore.
      if (generation?.type === 'complete' && generation?.payload?.features?.length) {
        setFeatures(generation.payload.features);
        setGenerationContext(generation.payload.generationContext ?? null);
        setPendingSessionId(null);
        setPendingClarifySessionId(null);
        setIsWorking(false);
        setIsGenerationStarted(false);
        return true;
      }

      // An active or newly-queued clarify session must take priority over any
      // stale generation progress still sitting in storage from a previous run.
      // Without this check, accountId loading after the user clicks Generate
      // would re-trigger this effect, find old gen_progress, and clobber the
      // live clarify session before questions ever reach the frontend.
      if (clarify?.type === 'complete' && Array.isArray(clarify.questions) && clarify.questions.length > 0) {
        setClarifyQuestions(clarify.questions);
        setClarifyContext((clarify.contextMeta as ClarifyContextMeta | undefined) ?? null);
        setDiscoveryRound(1);
        setPendingSessionId(null);
        setPendingClarifySessionId(null);
        setIsWorking(false);
        setIsGenerationStarted(false);
        return true;
      }

      if (clarify && (clarify.type === 'pending' || clarify.type === 'progress')) {
        setPendingSessionId(null);
        setPendingClarifySessionId(sid);
        setIsWorking(true);
        setIsGenerationStarted(false);
        return true;
      }

      if (generation?.type === 'progress') {
        if (generation?.payload?.features?.length) {
          setFeatures(generation.payload.features);
        }
        setPendingClarifySessionId(null);
        setPendingSessionId(sid);
        setIsWorking(true);
        setIsGenerationStarted(true);
        return true;
      }
    } catch (error) {
      console.warn('Failed to restore in-flight session state', error);
    }

    return false;
  };

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
      if (ctxProjectKey) setProjectKey(ctxProjectKey);

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

      // Load saved sidebar width
      try {
        const widthRes = await api.getSidebarWidth() as any;
        if (widthRes?.success && typeof widthRes.width === 'number') {
          setSidebarWidth(widthRes.width);
        }
      } catch (e) {
        console.warn('Failed to load sidebar width', e);
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
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line

  useEffect(() => {
    api.listWiDocs(projectKey)
      .then((res: any) => {
        setWiDocs(Array.isArray(res?.docs) ? res.docs : []);
      })
      .catch(() => {});
  }, [projectKey]);

  useEffect(() => {
    const syncSidebarWidth = () => {
      setSidebarWidth((current) => {
        const maxAllowed = window.innerWidth * 0.7;
        if (!current || current < 300) {
          return getDefaultSidebarWidth(window.innerWidth);
        }
        return Math.min(current, maxAllowed);
      });
    };

    syncSidebarWidth();
    window.addEventListener('resize', syncSidebarWidth);
    return () => window.removeEventListener('resize', syncSidebarWidth);
  }, []);

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
        setRequirement(lastTurn?.requirement ?? '');
        setClarifyContext(lastTurn?.clarifyContext ?? null);
        if (lastTurn?.features?.length > 0) {
          setFeatures(lastTurn.features);
          setGenerationContext(lastTurn.generationContext ?? null);
          setSidebarOpen(false);
        } else {
          void restoreInFlightSession(sessionId).then((restored) => {
            if (restored) setSidebarOpen(false);
          });
        }
      } else {
        setWorkflowTokenUsage(null);
        void restoreInFlightSession(sessionId).then((restored) => {
          if (restored) setSidebarOpen(false);
        });
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

  const loadWorkspaceConfig = async (selectedProjectKey = projectKey) => {
    try {
      const res = await api.getConfig({ projectKey: selectedProjectKey }) as any;
      if (!res) return;
      setGoldSources(Array.isArray(res?.goldSources) ? res.goldSources : []);
      if (res.tier) setTier(res.tier);
      if (res.isAdmin !== undefined) setIsAdmin(!!res.isAdmin);
      const nextPolicy = (res.effectiveAiPolicy as AiExecutionPolicy | undefined) ?? DEFAULT_CONFIG.aiExecutionPolicy;
      setEffectiveAiPolicy(nextPolicy);
      setReasoningMode(nextPolicy.defaultReasoningMode);
      setOutputMode(nextPolicy.defaultOutputMode);
    } catch (e) {
      console.error('Config fetch failed', e);
    }
  };

  // Initial fetch of config and usage
  useEffect(() => {
    loadWorkspaceConfig(projectKey);
    loadUsage();
  }, [projectKey]); // eslint-disable-line

  // Restore features from Forge Storage whenever sessionId or accountId changes

  const loadHistory = async () => {
    try {
      const res = await api.getHistory(50) as any;
      if (res.success && res.conversations) {
        setConversations(res.conversations);
      }
    } catch {}
  };

  const { isGenerating, progress } = useGenerationRealtime(
    pendingSessionId,
    (payload: any) => {
      if (payload.features) {
        setFeatures(payload.features);
      }
      setGenerationContext(payload.generationContext ?? null);
      setWorkflowTokenUsage(prev => addTokenUsage(prev, payload.generationContext?.tokenUsage ?? null));
      setPendingSessionId(null);
      setIsWorking(false);
      setIsGenerationStarted(false);
      loadHistory();
      loadUsage();
    },
    (errMsg) => {
      setGenerationError(errMsg);
      setPendingSessionId(null);
      setIsWorking(false);
      setIsGenerationStarted(false);
    }
    ,
    (payload: any) => {
      if (payload?.features && Array.isArray(payload.features) && payload.features.length > 0) {
        setFeatures(payload.features);
      }
    }
  );

  const { progress: clarifyProgress } = useClarifyRealtime(
    pendingClarifySessionId,
    ({ questions, contextMeta }) => {
      const nextClarifyContext = (contextMeta as ClarifyContextMeta | undefined) ?? null;
      setPendingClarifySessionId(null);
      setIsReviewingDiscovery(false);
      setClarifyContext(nextClarifyContext);
      setDiscoveryCoverage(null);
      setWorkflowTokenUsage(prev => addTokenUsage(prev, nextClarifyContext?.tokenUsage ?? null));
      if (questions.length > 0) {
        setClarifyQuestions(questions);
        setDiscoveryRound(1);
        setIsWorking(false);
      } else {
        setIsWorking(false);
        setGenerationError('Discovery completed without returning questions. Please try again.');
      }
    },
    (reason: ClarifyFallthroughReason) => {
      setPendingClarifySessionId(null);
      setIsReviewingDiscovery(false);
      setDiscoveryCoverage(null);
      setIsWorking(false);
      setGenerationError(
        reason === 'timeout'
          ? 'Discovery timed out. Please try again, or use Fast mode for quicker results.'
          : reason === 'no_questions'
            ? 'Discovery returned no questions. Please try again.'
            : 'Discovery could not complete. Please try again.',
      );
    },
  );

  const handleStartBrainstorm = async () => {
    if (!requirement.trim()) return;
    setIsWorking(true);
    setGenerationError(null);
    setFeatures([]);
    setGenerationContext(null);
    setClarifyContext(null);
    setClarifyQuestions([]);
    setDiscoveryCoverage(null);
    setWorkflowTokenUsage(null);
    setDiscoveryAnswers([]);
    setDiscoveryRound(0);
    setIsReviewingDiscovery(false);
    setPendingSessionId(null);
    setPendingClarifySessionId(null);
    setIsGenerationStarted(false);

    // Bind this session to the originating issue so re-launching restores it
    if (originIssueKey) {
      api.setIssueSession(originIssueKey, sessionId).catch(() => {});
    }

    try {
      console.log('[App] startClarify', { sessionId, projectKey, reasoningMode, outputMode, outputInstructions });
      const res = await api.startClarify(sessionId, requirement, undefined, projectKey, reasoningMode, outputMode, outputInstructions) as any;
      console.log('[App] startClarify result', res);
      if (res.success) {
        setPendingSessionId(null);
        setPendingClarifySessionId(sessionId);
      } else {
        setIsWorking(false);
        setGenerationError(`Discovery could not start: ${res?.error || 'Unknown error'}`);
      }
    } catch (err: any) {
      setIsWorking(false);
      setGenerationError(`Discovery could not start: ${err?.message || 'Unknown error'}`);
    }
  };

  // Helpers to avoid stale closures in effects
  const requirementRef = useRef(requirement);
  requirementRef.current = requirement;
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const discoveryAnswersRef = useRef<any[]>([]);
  discoveryAnswersRef.current = discoveryAnswers;
  const [isGenerationStarted, setIsGenerationStarted] = useState(false);

  const startGeneration = async (reqText: string, clarifyAnswers: any[]) => {
    const sid = sessionIdRef.current;
    const req = reqText || requirementRef.current;
    
    console.log('[App] startGeneration', {
      sessionId: sid,
      requirementLength: req.length,
      clarifyAnswerCount: clarifyAnswers.length,
      projectKey,
      reasoningMode,
      outputMode,
      outputInstructions,
    });
    setIsWorking(true);
    setIsGenerationStarted(true);
    setIsReviewingDiscovery(false);
    setGenerationError(null);
    setClarifyQuestions([]);
    setDiscoveryCoverage(null);
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
        projectKey,
        reasoningMode,
        outputMode,
        outputInstructions,
      }) as any;

      console.log('[App] startGeneration result', res);

      if (res?.success) {
        // resolver confirmed OK — polling is already running
      } else {
        setGenerationError(`Generation blocked: ${res?.error || JSON.stringify(res)}`);
        setIsWorking(false);
        setIsGenerationStarted(false);
        setPendingSessionId(null);
      }
    } catch (err: any) {
      setGenerationError(`Generation error: ${err?.message ?? String(err)}`);
      setIsWorking(false);
      setIsGenerationStarted(false);
      setPendingSessionId(null);
    }
  };

  const handleClarifyComplete = async (answers: any[]) => {
    const currentRoundQuestions = [...clarifyQuestions];
    const currentRoundNumber = discoveryRound || 1;
    const nextAnswers = [...discoveryAnswersRef.current, ...answers];
    setDiscoveryAnswers(nextAnswers);
    setClarifyQuestions([]);
    setIsReviewingDiscovery(false);
    setDiscoveryCoverage(null);

    await api.saveDiscoveryRound({
      sessionId: sessionIdRef.current,
      roundNumber: currentRoundNumber,
      questions: currentRoundQuestions,
      answers,
    }).catch(err => {
      console.error('Failed to persist discovery round', err);
    });

    console.log('[App] moving from discovery to generation', {
      round: currentRoundNumber,
      accumulatedAnswers: nextAnswers.length,
      reasoningMode,
    });
    await startGeneration(requirementRef.current, nextAnswers);
  };

  const handleClarifySkip = async () => {
    const currentAnswers = discoveryAnswersRef.current;
    await startGeneration(requirementRef.current, currentAnswers);
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
        setSessionId(res.conversation.sessionId);
        const lastTurn = res.conversation.turns[res.conversation.turns.length - 1];
        if (lastTurn) {
          setFeatures(lastTurn.features ?? []);
          setRequirement(lastTurn.requirement ?? '');
          setOutputInstructions(lastTurn.outputInstructions ?? '');
          setGenerationContext(lastTurn.generationContext ?? null);
          setClarifyContext(lastTurn.clarifyContext ?? null);
        }
        setClarifyQuestions([]);
        setDiscoveryAnswers([]);
        setDiscoveryRound(0);
        setDiscoveryCoverage(null);
        setIsReviewingDiscovery(false);
        setWorkflowTokenUsage(sumWorkflowTokenUsage(res.conversation));
        if (!lastTurn?.features?.length) {
          await restoreInFlightSession(res.conversation.sessionId);
        }
        setViewMode('generate');
      }
    } catch {}
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
            animate={{ opacity: 1, x: 0, width: sidebarWidth }}
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
              outputInstructions={outputInstructions}
              setOutputInstructions={setOutputInstructions}
              onStartBrainstorm={() => { handleStartBrainstorm(); closeSidebar(); }}
              onNewSession={() => {
                let newSid: string;
                try { newSid = crypto.randomUUID(); }
                catch(e) { newSid = `sid_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`; }
                
                setRequirement('');
                setOutputInstructions('');
                setFeatures([]);
                setGenerationContext(null);
                setClarifyContext(null);
                setWorkflowTokenUsage(null);
                setClarifyQuestions([]);
                setDiscoveryAnswers([]);
                setDiscoveryRound(0);
                setIsReviewingDiscovery(false);
                setSidebarOpen(true);
                setSidebarExiting(false);
                setSessionId(newSid);
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
              width={sidebarWidth}
              originIssueKey={originIssueKey}
              projectKey={projectKey}
              setProjectKey={setProjectKey}
              availableProjects={availableProjects}
              goldSources={goldSources}
              wiDocs={wiDocs}
              onOpenProjectSettings={openProjectSettings}
              reasoningMode={reasoningMode}
              setReasoningMode={setReasoningMode}
              outputMode={outputMode}
              setOutputMode={setOutputMode}
              allowReasoningModeOverride={effectiveAiPolicy.allowReasoningModeOverride}
              allowOutputModeOverride={effectiveAiPolicy.allowOutputModeOverride}
            />
              {/* Resize Handle */}
              {sidebarOpen && (
                <div
                  onMouseDown={startResizing}
                  className="absolute top-0 -right-1.5 w-3 h-full cursor-col-resize hover:bg-[var(--rf-brand)]/20 group z-50 transition-colors flex items-center justify-center"
                  style={{ cursor: 'col-resize' }}
                >
                  <div className="w-1 h-8 bg-white/20 group-hover:bg-[var(--rf-brand)] rounded-full transition-colors" />
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
            loadWorkspaceConfig(projectKey);
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
          {clarifyQuestions.length > 0 ? (
            <ClarifyQuestionsView 
              questions={clarifyQuestions} 
              onComplete={handleClarifyComplete}
              onSkip={handleClarifySkip}
              contextMeta={clarifyContext}
              coverageSummary={discoveryCoverage}
              sidebarOpen={sidebarOpen}
              setSidebarOpen={setSidebarOpen}
              roundNumber={discoveryRound}
              reasoningMode={reasoningMode}
              skipLabel={discoveryAnswers.length > 0 ? 'Generate now' : 'Skip questions'}
            />
          ) : (
            <MainContent
              features={features}
              setFeatures={setFeatures}
              onPushFeature={(idx: number) => setActivePushFeatureIdx(idx)}
              outputInstructions={outputInstructions}
              isGenerating={isGenerating || isWorking}
              loadingTitle={
                isWorking && !isGenerating && !isGenerationStarted
                  ? 'Analyzing context & clarifying requirements'
                  : 'Crafting features'
              }
              progress={
                isWorking && !isGenerating 
                  ? (isGenerationStarted
                      ? 'Preparing generation engine...'
                        : isReviewingDiscovery
                          ? 'Reviewing discovery coverage...'
                        : clarifyProgress || 'Preparing discovery workflow...')
                  : progress
              }
              sidebarOpen={sidebarOpen}
              setSidebarOpen={setSidebarOpen}
              sessionId={sessionId}
              requirement={requirement}
              generationContext={generationContext}
              projectKey={projectKey}
              workflowTokenUsage={workflowTokenUsage}
              onWorkflowTokenUsage={(usageDelta) => {
                setWorkflowTokenUsage(prev => addTokenUsage(prev, usageDelta));
              }}
            />
          )}
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
