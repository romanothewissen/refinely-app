import React, { useState, useEffect, useRef } from 'react';
import { requestJira, view } from '@forge/bridge';
import { motion, AnimatePresence } from 'framer-motion';
import { Sidebar } from './Sidebar';
import { MainContent } from './MainContent';
import { JiraModal } from './JiraModal';
import { SettingsView } from './SettingsView';
import { api } from './hooks/useForge';
import { useGenerationRealtime, useClarifyRealtime } from './hooks/useRealtime';
import { ClarifyQuestionsView } from './ClarifyQuestionsView';
import { HistoryModal } from './HistoryModal';

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
  referencedSimilarStories?: Array<{ key: string; summary: string; relevanceScore?: number }>;
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
  referencedSimilarStories?: Array<{ key: string; summary: string; relevanceScore?: number }>;
  wiDocsCount?: number;
  referencedWiDocs?: Array<{ docId: string; filename: string; chunkCount: number }>;
  tokenUsage?: { input: number; output: number; total: number; byStage?: Record<string, { input: number; output: number; total: number }> };
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

export default function App() {
  const [viewMode, setViewMode] = useState<'generate' | 'settings'>('generate');
  const [settingsStartTab, setSettingsStartTab] = useState<'models' | 'jira' | 'domain' | 'billing'>('models');
  const [settingsStartProjectKey, setSettingsStartProjectKey] = useState<string>('*');
  const [requirement, setRequirement] = useState('');
  const [activePushFeatureIdx, setActivePushFeatureIdx] = useState<number | null>(null);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [generationContext, setGenerationContext] = useState<GenerationContextMeta | null>(null);
  const [clarifyContext, setClarifyContext] = useState<ClarifyContextMeta | null>(null);
  const [workflowTokenUsage, setWorkflowTokenUsage] = useState<WorkflowTokenUsage | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string>(() => {
    try { return crypto.randomUUID(); } 
    catch(e) { return `fallback_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`; }
  });
  
  // Realtime Integration
  const [clarifyQuestions, setClarifyQuestions] = useState<any[]>([]);
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [pendingClarifySessionId, setPendingClarifySessionId] = useState<string | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarExiting, setSidebarExiting] = useState(false);
  const [isHistoryModalOpen, setHistoryModalOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [tier, setTier] = useState('free');
  const [sidebarWidth, setSidebarWidth] = useState(window.innerWidth / 2);
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
    api.getConfig()
      .then((res: any) => {
        setGoldSources(Array.isArray(res?.goldSources) ? res.goldSources : []);
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
  );

  useClarifyRealtime(
    pendingClarifySessionId,
    ({ questions, contextMeta }) => {
      const nextClarifyContext = (contextMeta as ClarifyContextMeta | undefined) ?? null;
      setPendingClarifySessionId(null);
      setClarifyContext(nextClarifyContext);
      setWorkflowTokenUsage(prev => addTokenUsage(prev, nextClarifyContext?.tokenUsage ?? null));
      if (questions.length > 0) {
        setClarifyQuestions(questions);
        setIsWorking(false);
      } else {
        startGeneration(requirement, []);
      }
    },
    () => {
      // Error or timeout — skip clarify and go straight to generation
      setPendingClarifySessionId(null);
      startGeneration(requirement, []);
    },
  );

  const handleStartBrainstorm = async () => {
    if (!requirement.trim()) return;
    setIsWorking(true);
    setGenerationError(null);
    setFeatures([]);
    setGenerationContext(null);
    setClarifyContext(null);
    setWorkflowTokenUsage(null);

    // Bind this session to the originating issue so re-launching restores it
    if (originIssueKey) {
      api.setIssueSession(originIssueKey, sessionId).catch(() => {});
    }

    try {
      const res = await api.startClarify(sessionId, requirement, undefined, projectKey) as any;
      if (res.success) {
        setPendingClarifySessionId(sessionId);
      } else {
        await startGeneration(requirement, []);
      }
    } catch {
      await startGeneration(requirement, []);
    }
  };

  // Helpers to avoid stale closures in effects
  const requirementRef = useRef(requirement);
  requirementRef.current = requirement;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const [isGenerationStarted, setIsGenerationStarted] = useState(false);

  const startGeneration = async (reqText: string, clarifyAnswers: any[]) => {
    const sid = sessionIdRef.current;
    const req = reqText || requirementRef.current;
    
    setIsWorking(true);
    setIsGenerationStarted(true);
    setGenerationError(null);
    setClarifyQuestions([]);
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
      }) as any;

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
          setGenerationContext(lastTurn.generationContext ?? null);
          setClarifyContext(lastTurn.clarifyContext ?? null);
        }
        setWorkflowTokenUsage(sumWorkflowTokenUsage(res.conversation));
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
              onStartBrainstorm={() => { handleStartBrainstorm(); closeSidebar(); }}
              onNewSession={() => {
                let newSid: string;
                try { newSid = crypto.randomUUID(); }
                catch(e) { newSid = `sid_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`; }
                
                setRequirement('');
                setFeatures([]);
                setGenerationContext(null);
                setClarifyContext(null);
                setWorkflowTokenUsage(null);
                setClarifyQuestions([]);
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
          onClose={() => { setViewMode('generate'); setSidebarOpen(true); }}
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
              onComplete={(answers: any[]) => {
                startGeneration(requirement, answers);
              }}
              onSkip={() => {
                startGeneration(requirement, []);
              }}
              contextMeta={clarifyContext}
              sidebarOpen={sidebarOpen}
              setSidebarOpen={setSidebarOpen}
            />
          ) : (
            <MainContent
              features={features}
              setFeatures={setFeatures}
              onPushFeature={(idx: number) => setActivePushFeatureIdx(idx)}
              isGenerating={isGenerating || isWorking}
              progress={
                isWorking && !isGenerating 
                  ? (isGenerationStarted ? 'Preparing generation engine...' : 'Discovery phase: Deep-dive requirement analysis...') 
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
