import React, { useState, useEffect, useRef } from 'react';
import { requestJira, view } from '@forge/bridge';
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
}

interface ClarifyContextMeta {
  projectKey: string;
  domainRolesUsed: string[];
  domainContextApplied?: boolean;
  attachmentIncluded?: boolean;
  wiDocsCount?: number;
  referencedWiDocs?: Array<{ docId: string; filename: string; chunkCount: number }>;
  usesGoldenExamples: false;
  usesSimilarStories: false;
}

/** Recursively extract plain text from an Atlassian Document Format node */
function extractAdfText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { text?: string; content?: unknown[] };
  if (typeof n.text === 'string') return n.text;
  if (Array.isArray(n.content)) return n.content.map(extractAdfText).filter(Boolean).join(' ');
  return '';
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

  const startResizing = React.useCallback((e: React.MouseEvent) => {
    isResizing.current = true;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', endResizing);
  }, []);

  const handleMouseMove = React.useCallback((e: MouseEvent) => {
    if (!isResizing.current) return;
    // Limit between 280px and 70% of screen
    const newWidth = Math.min(Math.max(300, e.clientX), window.innerWidth * 0.7);
    setSidebarWidth(newWidth);
  }, []);

  const endResizing = React.useCallback(() => {
    isResizing.current = false;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', endResizing);
  }, []);
  
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
        if (lastTurn?.features?.length > 0) {
          setFeatures(lastTurn.features);
          setGenerationContext(lastTurn.generationContext ?? null);
          setSidebarOpen(false);
        }
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
      setPendingClarifySessionId(null);
      setClarifyContext((contextMeta as ClarifyContextMeta | undefined) ?? null);
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
    <div className="flex h-screen w-full overflow-hidden text-[var(--rf-text)] font-sans bg-[var(--rf-bg)]">
      {/* Left Sidebar — animated & resizable */}
      {(sidebarOpen || sidebarExiting) && (
        <div 
          className={sidebarExiting ? 'sidebar-exit' : 'sidebar-enter'}
          style={{ width: sidebarOpen ? sidebarWidth : 0 }}
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
                className="absolute top-0 -right-1 w-2 h-full cursor-col-resize hover:bg-[var(--rf-brand)] group z-50 transition-colors"
                style={{ cursor: 'col-resize' }}
              >
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-8 bg-[var(--rf-border)] group-hover:bg-white rounded-full transition-colors" />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main Right Pane / Settings */}
      {viewMode === 'settings' && isAdmin ? (
        <SettingsView
          onClose={() => { setViewMode('generate'); setSidebarOpen(true); }}
          initialTab={settingsStartTab}
          initialProjectKey={settingsStartProjectKey}
        />
      ) : (
        <div className="flex-1 flex flex-col h-full relative overflow-hidden bg-[var(--rf-bg)]">
          {generationError && (
            <div className="w-full bg-[var(--rf-danger-subtle)] text-[var(--rf-danger)] border-b border-red-300 px-6 py-3 text-sm font-medium flex items-start gap-3 z-50">
              <span className="flex-1">{generationError}</span>
              <button onClick={() => setGenerationError(null)} className="text-[var(--rf-danger)] hover:text-red-800 font-semibold text-sm leading-none">&times;</button>
            </div>
          )}
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
              tier={tier}
              usage={usage}
              limits={limits}
              generationContext={generationContext}
              projectKey={projectKey}
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
