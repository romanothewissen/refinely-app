import React, { useEffect, useMemo, useState } from 'react';
import { requestJira, view } from '@forge/bridge';
import { api } from './hooks/useForge';
import './styles/v2-compat.css';
import type { LlmProvider, TenantConfig } from './types';
import { DEFAULT_CONFIG } from './types';

type DiscoveryMode = 'light' | 'standard' | 'deep' | 'very_deep';
type ConversationStatus = 'preview_ready' | 'needs_scope_confirmation' | 'needs_discovery' | 'complete';

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

interface ConversationHistoryEntry {
  sessionId: string;
  title: string;
  requirement: string;
  status: ConversationStatus;
  projectKey: string | null;
  projectKeys: string[];
  createdAt: string;
  updatedAt: string;
}

interface ConversationRecord extends ConversationHistoryEntry {
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

type V2SettingsDraft = {
  provider: LlmProvider;
  clarifyModel: string;
  decompositionModel: string;
  arModel: string;
  domainContext: string;
  wiEnabled: boolean;
};

const PROVIDER_OPTIONS: Array<{ value: LlmProvider; label: string }> = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'fireworks', label: 'Fireworks' },
  { value: 'azure_openai', label: 'Azure OpenAI' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'groq', label: 'Groq' },
  { value: 'forge_llms', label: 'Forge LLMs' },
];

function buildSettingsDraft(config?: Partial<TenantConfig> | null): V2SettingsDraft {
  const generatorConfig = config?.generatorConfig ?? DEFAULT_CONFIG.generatorConfig;
  return {
    provider: (generatorConfig.provider ?? DEFAULT_CONFIG.generatorConfig.provider) as LlmProvider,
    clarifyModel: String(generatorConfig.clarifyModel ?? DEFAULT_CONFIG.generatorConfig.clarifyModel),
    decompositionModel: String(generatorConfig.decompositionModel ?? DEFAULT_CONFIG.generatorConfig.decompositionModel),
    arModel: String(generatorConfig.arModel ?? DEFAULT_CONFIG.generatorConfig.arModel),
    domainContext: String(config?.domainContext ?? DEFAULT_CONFIG.domainContext ?? ''),
    wiEnabled: Boolean(config?.wiConfig?.enabled ?? DEFAULT_CONFIG.wiConfig.enabled),
  };
}

function createSessionId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `v2_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}

function extractAdfText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const candidate = node as { text?: string; content?: unknown[] };
  if (typeof candidate.text === 'string') return candidate.text;
  if (Array.isArray(candidate.content)) return candidate.content.map(extractAdfText).filter(Boolean).join(' ');
  return '';
}

function formatDate(value?: string | null) {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function resultFromConversation(conversation: ConversationRecord | null): V2Result | null {
  if (!conversation) return null;
  return conversation.latestResult?.result
    ?? conversation.turns[conversation.turns.length - 1]?.payload?.result
    ?? null;
}

function actorSlotEntries(scopeHypothesis?: ScopeHypothesis | null) {
  if (!scopeHypothesis) return [];
  return Object.entries(scopeHypothesis.actorSlots ?? {}).filter(([, value]) => Boolean(value));
}

function ActorSlots({ scopeHypothesis }: { scopeHypothesis?: ScopeHypothesis | null }) {
  const entries = actorSlotEntries(scopeHypothesis);
  if (!entries.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([slot, value]) => (
        <span key={slot} className="rounded-full border px-3 py-1 text-sm" style={{ borderColor: 'var(--rf-border)', color: 'var(--rf-text-secondary)', background: 'rgba(255,255,255,0.72)' }}>
          <strong className="capitalize">{slot.replace(/_/g, ' ')}</strong>: {value}
        </span>
      ))}
    </div>
  );
}

export default function V2App({ initialRequirement = '' }: { initialRequirement?: string }) {
  const [sessionId, setSessionId] = useState(() => createSessionId());
  const [requirement, setRequirement] = useState(initialRequirement);
  const [projectKeys, setProjectKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [result, setResult] = useState<V2Result | null>(null);
  const [history, setHistory] = useState<ConversationHistoryEntry[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [discoveryAnswers, setDiscoveryAnswers] = useState<Record<string, DiscoveryAnswer>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [configDraft, setConfigDraft] = useState<V2SettingsDraft>(() => buildSettingsDraft(DEFAULT_CONFIG));

  const activeScopeHypothesis = result?.scopeHypothesis ?? null;
  const activeDiscoveryQuestions = result?.status === 'needs_discovery' ? result.discoveryQuestions : [];

  const loadHistory = async () => {
    try {
      const response = await api.v2GetHistory(40) as { success?: boolean; conversations?: ConversationHistoryEntry[]; warning?: string };
      if (response?.success) {
        setHistory(response.conversations ?? []);
        if (response.warning) setWarning(response.warning);
      }
    } catch {
      // Keep the main flow usable even if SQL history is unavailable.
    }
  };

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const configRes = await api.getConfig() as Partial<TenantConfig>;
        if (!cancelled) {
          setConfigDraft(buildSettingsDraft(configRes));
        }

        const ctx = await view.getContext();
        const issueKey = ctx?.extension?.issue?.key as string | undefined;
        const projectKey =
          (ctx?.extension?.project?.key as string | undefined)
          || (ctx?.extension?.projectKey as string | undefined)
          || (issueKey ? issueKey.split('-')[0] : undefined);
        if (!cancelled && projectKey) setProjectKeys([projectKey]);

        if (issueKey) {
          const issueRes = await requestJira(`/rest/api/3/issue/${issueKey}?fields=summary,description`);
          if (issueRes.ok) {
            const data = await issueRes.json() as any;
            const summary = String(data?.fields?.summary ?? '').trim();
            const description = extractAdfText(data?.fields?.description);
            const prefill = [summary, description].filter(Boolean).join('\n\n');
            if (!cancelled && prefill.trim()) setRequirement(prefill);
          }
        }
      } catch {
        // Ignore context bootstrap issues and keep the app usable.
      }
    })();

    void loadHistory();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('rf-v2-scroll');
    document.body.classList.add('rf-v2-scroll');
    const root = document.getElementById('root');
    root?.classList.add('rf-v2-scroll-root');
    return () => {
      document.documentElement.classList.remove('rf-v2-scroll');
      document.body.classList.remove('rf-v2-scroll');
      root?.classList.remove('rf-v2-scroll-root');
    };
  }, []);

  const activeQuestionCount = useMemo(() => activeDiscoveryQuestions.length, [activeDiscoveryQuestions]);

  const activeModelSummary = useMemo(() => ([
    { label: 'Preview + discovery', value: configDraft.clarifyModel },
    { label: 'Reasoning + formatting', value: configDraft.decompositionModel },
    { label: 'Acceptance requirements', value: configDraft.arModel },
  ]), [configDraft]);

  async function handlePreview() {
    setLoading(true);
    setError(null);
    setWarning(null);
    setDiscoveryAnswers({});
    try {
      const response = await api.v2Preview({
        sessionId,
        requirement,
        projectKeys,
      }) as { success?: boolean; error?: string; warning?: string; sessionId?: string; result?: V2Result };
      if (!response?.success || !response.result) {
        throw new Error(response?.error ?? 'Preview failed.');
      }
      setSessionId(response.sessionId ?? sessionId);
      setSelectedConversationId(response.sessionId ?? sessionId);
      setResult(response.result);
      setWarning(response.warning ?? null);
      void loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed.');
    } finally {
      setLoading(false);
    }
  }

  async function saveSettings() {
    setSettingsSaving(true);
    setSettingsNotice(null);
    setError(null);
    try {
      await api.patchConfig({
        generatorConfig: {
          provider: configDraft.provider,
          clarifyModel: configDraft.clarifyModel.trim(),
          decompositionModel: configDraft.decompositionModel.trim(),
          arModel: configDraft.arModel.trim(),
        },
        domainContext: configDraft.domainContext,
        wiConfig: {
          enabled: configDraft.wiEnabled,
        },
      });
      setSettingsNotice('V2 test settings saved. New runs will use these models.');
      setSettingsOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save V2 settings.');
    } finally {
      setSettingsSaving(false);
    }
  }

  async function handleGenerate(answerOverride?: Record<string, DiscoveryAnswer>) {
    if (!activeScopeHypothesis) return;
    setLoading(true);
    setError(null);
    setWarning(null);
    try {
      const response = await api.v2Generate({
        sessionId,
        requirement,
        projectKeys,
        confirmedScopeHypothesis: activeScopeHypothesis,
        discoveryAnswers: Object.values(answerOverride ?? discoveryAnswers),
      }) as { success?: boolean; error?: string; warning?: string; sessionId?: string; result?: V2Result };
      if (!response?.success || !response.result) {
        throw new Error(response?.error ?? 'Generation failed.');
      }
      setSessionId(response.sessionId ?? sessionId);
      setSelectedConversationId(response.sessionId ?? sessionId);
      setResult(response.result);
      setWarning(response.warning ?? null);
      void loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed.');
    } finally {
      setLoading(false);
    }
  }

  async function loadConversation(nextSessionId: string) {
    setLoading(true);
    setError(null);
    try {
      const response = await api.v2GetConversation(nextSessionId) as { success?: boolean; conversation?: ConversationRecord | null; error?: string };
      if (!response?.success || !response.conversation) {
        throw new Error(response?.error ?? 'Conversation not found.');
      }
      setSelectedConversationId(nextSessionId);
      setSessionId(nextSessionId);
      setRequirement(response.conversation.requirement ?? '');
      setResult(resultFromConversation(response.conversation));
      setDiscoveryAnswers({});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load conversation.');
    } finally {
      setLoading(false);
    }
  }

  async function deleteConversation(sessionToDelete: string) {
    await api.v2DeleteConversation(sessionToDelete);
    if (selectedConversationId === sessionToDelete) {
      setSelectedConversationId(null);
      setSessionId(createSessionId());
      setRequirement('');
      setResult(null);
      setDiscoveryAnswers({});
    }
    void loadHistory();
  }

  function startFresh() {
    setSelectedConversationId(null);
    setSessionId(createSessionId());
    setResult(null);
    setDiscoveryAnswers({});
    setError(null);
    setWarning(null);
  }

  return (
    <div className="v2-root h-full min-h-0 w-full overflow-y-auto p-4 md:p-6">
      <div className="mx-auto flex min-h-full max-w-[1480px] gap-4">
        <aside className="rf-sidebar-card hidden w-[320px] shrink-0 overflow-hidden md:flex md:flex-col">
            <div className="border-b px-5 py-5" style={{ borderColor: 'var(--rf-border)' }}>
            <div className="text-xs uppercase tracking-[0.18em]" style={{ color: 'var(--rf-text-tertiary)' }}>Refinely Core V2</div>
            <h1 className="mt-2 text-2xl" style={{ color: 'var(--rf-text)' }}>Lean refinement</h1>
            <p className="mt-2 text-sm leading-6" style={{ color: 'var(--rf-text-secondary)' }}>
              Scope first, targeted discovery only when it matters, and SQL-backed history instead of giant KVS blobs.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                className="rounded-full px-4 py-2 text-sm font-medium"
                style={{ background: 'var(--rf-brand)', color: '#fff' }}
                onClick={startFresh}
                type="button"
              >
                New session
              </button>
              <button
                className="rounded-full border px-4 py-2 text-sm font-medium"
                style={{ borderColor: 'var(--rf-border)', color: 'var(--rf-text-secondary)', background: 'rgba(255,255,255,0.82)' }}
                onClick={() => setSettingsOpen(true)}
                type="button"
              >
                Setup
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3">
            {history.length === 0 ? (
              <div className="rounded-2xl border px-4 py-4 text-sm" style={{ borderColor: 'var(--rf-border)', color: 'var(--rf-text-secondary)', background: 'rgba(255,255,255,0.72)' }}>
                No V2 sessions yet. Start with a fast preview to shape the scope.
              </div>
            ) : history.map((entry) => (
              <div
                key={entry.sessionId}
                className="mb-3 rounded-2xl border p-4"
                style={{
                  borderColor: selectedConversationId === entry.sessionId ? 'var(--rf-brand)' : 'var(--rf-border)',
                  background: selectedConversationId === entry.sessionId ? 'rgba(43, 89, 74, 0.10)' : 'rgba(255,255,255,0.76)',
                }}
              >
                <button
                  className="w-full text-left"
                  onClick={() => void loadConversation(entry.sessionId)}
                  type="button"
                >
                  <div className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--rf-text-tertiary)' }}>
                    {entry.status.replace(/_/g, ' ')}
                  </div>
                  <div className="mt-2 text-sm font-semibold" style={{ color: 'var(--rf-text)' }}>{entry.title}</div>
                  <div className="mt-2 text-xs leading-5" style={{ color: 'var(--rf-text-secondary)' }}>
                    {entry.requirement.replace(/\s+/g, ' ').slice(0, 140)}
                  </div>
                  <div className="mt-3 text-xs" style={{ color: 'var(--rf-text-tertiary)' }}>
                    {formatDate(entry.updatedAt)}
                  </div>
                </button>
                <button
                  className="mt-3 text-xs"
                  style={{ color: 'var(--rf-danger)' }}
                  onClick={() => void deleteConversation(entry.sessionId)}
                  type="button"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </aside>

        <main className="flex min-h-0 flex-1 flex-col gap-4" style={{ paddingBottom: '1rem' }}>
          <section className="rf-card p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-[0.18em]" style={{ color: 'var(--rf-text-tertiary)' }}>Core workflow</div>
                <h2 className="mt-2 text-3xl" style={{ color: 'var(--rf-text)' }}>Preview scope, then deepen only where needed</h2>
              </div>
              <div className="flex flex-wrap gap-3">
                <button
                  className="rounded-2xl border px-4 py-3 text-sm"
                  style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.72)', color: 'var(--rf-text-secondary)' }}
                  onClick={() => setSettingsOpen(true)}
                  type="button"
                >
                  Provider: <strong>{PROVIDER_OPTIONS.find((option) => option.value === configDraft.provider)?.label ?? configDraft.provider}</strong>
                </button>
                <div className="rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.72)', color: 'var(--rf-text-secondary)' }}>
                  Session: <strong>{sessionId.slice(0, 8)}</strong>
                </div>
              </div>
            </div>

            <div className="mt-6 grid gap-4 lg:grid-cols-[1.6fr_0.8fr]">
              <div>
                <label className="mb-2 block text-sm font-medium" style={{ color: 'var(--rf-text-secondary)' }}>
                  Requirement or use case
                </label>
                <textarea
                  className="min-h-[220px] w-full rounded-[24px] border p-5 text-sm leading-7 outline-none"
                  style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.82)', color: 'var(--rf-text)' }}
                  placeholder="Describe the workflow, decision logic, edge cases, and any operational constraints."
                  value={requirement}
                  onChange={(event) => setRequirement(event.target.value)}
                />
              </div>

              <div className="space-y-4">
                <div className="rounded-[24px] border p-5" style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.72)' }}>
                  <div className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--rf-text-tertiary)' }}>Current project scope</div>
                  <div className="mt-3 text-sm" style={{ color: 'var(--rf-text)' }}>
                    {projectKeys.length ? projectKeys.join(', ') : 'Workspace-wide'}
                  </div>
                </div>

                {result && (
                  <div className="rounded-[24px] border p-5" style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.72)' }}>
                    <div className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--rf-text-tertiary)' }}>Triage</div>
                    <div className="mt-3 text-sm leading-7" style={{ color: 'var(--rf-text-secondary)' }}>
                      Discovery mode: <strong>{result.triage.discoveryMode}</strong><br />
                      Question budget (advisory): <strong>{result.triage.questionBudget}</strong><br />
                      Capability target (advisory): <strong>{result.triage.likelyCapabilityCount}</strong><br />
                      CRUD risk (heuristic): <strong>{result.triage.crudRisk}</strong>
                    </div>
                  </div>
                )}

                <div className="rounded-[24px] border p-5" style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.72)' }}>
                  <div className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--rf-text-tertiary)' }}>Active model route</div>
                  <div className="mt-3 space-y-2 text-sm leading-6" style={{ color: 'var(--rf-text-secondary)' }}>
                    {activeModelSummary.map((item) => (
                      <div key={item.label}>
                        {item.label}: <strong>{item.value}</strong>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-3">
                  <button
                    className="rounded-full px-5 py-3 text-sm font-semibold"
                    style={{ background: 'var(--rf-brand)', color: '#fff', opacity: loading ? 0.7 : 1 }}
                    disabled={loading || !requirement.trim()}
                    onClick={() => void handlePreview()}
                    type="button"
                  >
                    {loading ? 'Working…' : 'Fast preview'}
                  </button>
                  {activeScopeHypothesis && (
                    <button
                      className="rounded-full border px-5 py-3 text-sm font-semibold"
                      style={{ borderColor: 'var(--rf-brand)', color: 'var(--rf-brand)', background: 'rgba(255,255,255,0.78)' }}
                      disabled={loading}
                      onClick={() => void handleGenerate()}
                      type="button"
                    >
                      Continue into full refinement
                    </button>
                  )}
                </div>
              </div>
            </div>

            {warning && (
              <div className="mt-4 rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: 'rgba(160,81,30,0.2)', background: 'rgba(160,81,30,0.08)', color: 'var(--rf-warning)' }}>
                {warning}
              </div>
            )}
            {error && (
              <div className="mt-4 rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: 'rgba(155,53,69,0.2)', background: 'rgba(155,53,69,0.08)', color: 'var(--rf-danger)' }}>
                {error}
              </div>
            )}
            {settingsNotice && (
              <div className="mt-4 rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: 'rgba(46,125,86,0.2)', background: 'rgba(46,125,86,0.10)', color: 'var(--rf-success)' }}>
                {settingsNotice}
              </div>
            )}
          </section>

          {activeScopeHypothesis && (
            <section className="rf-card p-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--rf-text-tertiary)' }}>Scope hypothesis</div>
                  <h3 className="mt-2 text-2xl" style={{ color: 'var(--rf-text)' }}>Proposed business capabilities</h3>
                </div>
                <div className="rounded-full border px-3 py-1 text-xs uppercase tracking-[0.16em]" style={{ borderColor: 'var(--rf-border)', color: 'var(--rf-text-tertiary)' }}>
                  confidence {activeScopeHypothesis.confidence}
                </div>
              </div>

              <div className="mt-5 grid gap-4 lg:grid-cols-2">
                {activeScopeHypothesis.capabilities.map((capability) => (
                  <div key={capability.id} className="rounded-[24px] border p-5" style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.76)' }}>
                    <div className="text-sm font-semibold" style={{ color: 'var(--rf-text)' }}>{capability.label}</div>
                    <div className="mt-2 text-sm leading-7" style={{ color: 'var(--rf-text-secondary)' }}>{capability.rationale}</div>
                  </div>
                ))}
              </div>

              <div className="mt-5">
                <ActorSlots scopeHypothesis={activeScopeHypothesis} />
              </div>

              {activeScopeHypothesis.openQuestions.length > 0 && (
                <div className="mt-5 rounded-[24px] border p-5" style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.72)' }}>
                  <div className="text-sm font-semibold" style={{ color: 'var(--rf-text)' }}>Open uncertainty</div>
                  <ul className="mt-3 list-disc pl-5 text-sm leading-7" style={{ color: 'var(--rf-text-secondary)' }}>
                    {activeScopeHypothesis.openQuestions.map((question) => (
                      <li key={question}>{question}</li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {result?.status === 'needs_discovery' && (
            <section className="rf-card p-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--rf-text-tertiary)' }}>Targeted discovery</div>
                  <h3 className="mt-2 text-2xl" style={{ color: 'var(--rf-text)' }}>Only answer what changes the shape of the output</h3>
                </div>
                <div className="rounded-full border px-3 py-1 text-xs uppercase tracking-[0.16em]" style={{ borderColor: 'var(--rf-border)', color: 'var(--rf-text-tertiary)' }}>
                  {activeQuestionCount} questions
                </div>
              </div>

              <div className="mt-5 space-y-4">
                {result.materialityHints.map((hint) => (
                  <div key={hint} className="rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.72)', color: 'var(--rf-text-secondary)' }}>
                    {hint}
                  </div>
                ))}
              </div>

              <div className="mt-5 space-y-5">
                {result.discoveryQuestions.map((question) => {
                  const current = discoveryAnswers[question.id] ?? {
                    questionId: question.id,
                    categoryKey: question.categoryKey,
                    question: question.question,
                    answer: '',
                  };

                  return (
                    <div key={question.id} className="rounded-[24px] border p-5" style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.76)' }}>
                      <div className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--rf-text-tertiary)' }}>{question.categoryKey.replace(/_/g, ' ')}</div>
                      <div className="mt-2 text-base font-semibold" style={{ color: 'var(--rf-text)' }}>{question.question}</div>
                      <div className="mt-2 text-sm leading-7" style={{ color: 'var(--rf-text-secondary)' }}>{question.rationale}</div>

                      <div className="mt-4 flex flex-wrap gap-2">
                        {question.suggestions.map((suggestion) => (
                          <button
                            key={suggestion}
                            className="rounded-full border px-3 py-1 text-xs"
                            style={{
                              borderColor: current.selectedSuggestion === suggestion ? 'var(--rf-brand)' : 'var(--rf-border)',
                              background: current.selectedSuggestion === suggestion ? 'rgba(43, 89, 74, 0.10)' : 'rgba(255,255,255,0.85)',
                              color: current.selectedSuggestion === suggestion ? 'var(--rf-brand)' : 'var(--rf-text-secondary)',
                            }}
                            onClick={() => setDiscoveryAnswers((prev) => ({
                              ...prev,
                              [question.id]: {
                                ...current,
                                selectedSuggestion: suggestion,
                                answer: current.answer || suggestion,
                              },
                            }))}
                            type="button"
                          >
                            {suggestion}
                          </button>
                        ))}
                      </div>

                      <textarea
                        className="mt-4 min-h-[110px] w-full rounded-[20px] border p-4 text-sm leading-7 outline-none"
                        style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.88)', color: 'var(--rf-text)' }}
                        value={current.answer}
                        onChange={(event) => setDiscoveryAnswers((prev) => ({
                          ...prev,
                          [question.id]: {
                            ...current,
                            answer: event.target.value,
                          },
                        }))}
                        placeholder="Add only the detail that changes capability boundaries, actor accountability, rules, or lifecycle handling."
                      />
                    </div>
                  );
                })}
              </div>

              <button
                className="mt-6 rounded-full px-5 py-3 text-sm font-semibold"
                style={{ background: 'var(--rf-brand)', color: '#fff', opacity: loading ? 0.7 : 1 }}
                disabled={loading}
                onClick={() => void handleGenerate()}
                type="button"
              >
                Continue with discovery answers
              </button>
            </section>
          )}

          {result?.status === 'complete' && (
            <section className="rf-card flex min-h-0 flex-1 flex-col p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--rf-text-tertiary)' }}>Generated output</div>
                  <h3 className="mt-2 text-2xl" style={{ color: 'var(--rf-text)' }}>Capability-first refinement result</h3>
                </div>
                <div className="rounded-[24px] border px-4 py-3 text-sm" style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.72)', color: 'var(--rf-text-secondary)' }}>
                  Prompt usage: <strong>{result.promptUsage.input}</strong> in / <strong>{result.promptUsage.output}</strong> out
                </div>
              </div>

              {(result.discoveryChanges.length > 0 || result.quality.warnings.length > 0) && (
                <div className="mt-5 grid gap-4 lg:grid-cols-2">
                  {result.discoveryChanges.length > 0 && (
                    <div className="rounded-[24px] border p-5" style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.72)' }}>
                      <div className="text-sm font-semibold" style={{ color: 'var(--rf-text)' }}>What changed because of discovery</div>
                      <ul className="mt-3 list-disc pl-5 text-sm leading-7" style={{ color: 'var(--rf-text-secondary)' }}>
                        {result.discoveryChanges.map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    </div>
                  )}

                  <div className="rounded-[24px] border p-5" style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.72)' }}>
                    <div className="text-sm font-semibold" style={{ color: 'var(--rf-text)' }}>Quality guardrails</div>
                    <div className="mt-3 text-sm leading-7" style={{ color: 'var(--rf-text-secondary)' }}>
                      Capability depth score: <strong>{result.quality.capabilityDepthScore}</strong><br />
                      CRUD-like output: <strong>{result.quality.crudLike ? 'Yes' : 'No'}</strong>
                    </div>
                    {result.quality.warnings.length > 0 && (
                      <ul className="mt-3 list-disc pl-5 text-sm leading-7" style={{ color: 'var(--rf-warning)' }}>
                        {result.quality.warnings.map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    )}
                  </div>
                </div>
              )}

              <div className="mt-6 space-y-5 overflow-y-auto pr-1">
                {result.features.map((feature) => (
                  <article key={feature.id} className="rounded-[28px] border p-6" style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.80)' }}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h4 className="text-xl" style={{ color: 'var(--rf-text)' }}>{feature.summary}</h4>
                      {feature.storyPoints ? (
                        <span className="rounded-full border px-3 py-1 text-xs uppercase tracking-[0.16em]" style={{ borderColor: 'var(--rf-border)', color: 'var(--rf-text-tertiary)' }}>
                          {feature.storyPoints} points
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-3 text-sm leading-7" style={{ color: 'var(--rf-text-secondary)' }}>{feature.description}</p>

                    <div className="mt-5 space-y-3">
                      {feature.acceptanceRequirements.map((ar, index) => (
                        <div key={`${feature.id}_${index}`} className="rounded-[22px] border p-4" style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.66)' }}>
                          <div className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--rf-text-tertiary)' }}>Acceptance requirement {index + 1}</div>
                          <div className="mt-2 text-sm leading-7" style={{ color: 'var(--rf-text)' }}>
                            <strong>Given</strong> {ar.given}<br />
                            <strong>When</strong> {ar.when}<br />
                            <strong>Then</strong> {ar.then}
                          </div>
                        </div>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </main>
      </div>

      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(18,24,22,0.24)] p-4">
          <div className="rf-card w-full max-w-[760px] p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-[0.16em]" style={{ color: 'var(--rf-text-tertiary)' }}>V2 setup</div>
                <h3 className="mt-2 text-2xl" style={{ color: 'var(--rf-text)' }}>Test model routing</h3>
                <p className="mt-2 text-sm leading-6" style={{ color: 'var(--rf-text-secondary)' }}>
                  This is intentionally small: just the V2 stage models and a little core context for testing.
                </p>
              </div>
              <button
                className="rounded-full border px-3 py-1 text-sm"
                style={{ borderColor: 'var(--rf-border)', color: 'var(--rf-text-secondary)', background: 'rgba(255,255,255,0.8)' }}
                onClick={() => setSettingsOpen(false)}
                type="button"
              >
                Close
              </button>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <label className="block">
                <span className="mb-2 block text-sm font-medium" style={{ color: 'var(--rf-text-secondary)' }}>Provider</span>
                <select
                  className="w-full rounded-[18px] border px-4 py-3 text-sm"
                  style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.9)', color: 'var(--rf-text)' }}
                  value={configDraft.provider}
                  onChange={(event) => setConfigDraft((prev) => ({ ...prev, provider: event.target.value as LlmProvider }))}
                >
                  {PROVIDER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="mb-2 block text-sm font-medium" style={{ color: 'var(--rf-text-secondary)' }}>Work instructions</span>
                <button
                  className="flex w-full items-center justify-between rounded-[18px] border px-4 py-3 text-sm"
                  style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.9)', color: 'var(--rf-text)' }}
                  onClick={() => setConfigDraft((prev) => ({ ...prev, wiEnabled: !prev.wiEnabled }))}
                  type="button"
                >
                  <span>{configDraft.wiEnabled ? 'Enabled' : 'Disabled'}</span>
                  <span style={{ color: 'var(--rf-text-tertiary)' }}>{configDraft.wiEnabled ? 'Use WI grounding' : 'Skip WI grounding'}</span>
                </button>
              </label>

              <label className="block">
                <span className="mb-2 block text-sm font-medium" style={{ color: 'var(--rf-text-secondary)' }}>Clarify / discovery model</span>
                <input
                  className="w-full rounded-[18px] border px-4 py-3 text-sm"
                  style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.9)', color: 'var(--rf-text)' }}
                  value={configDraft.clarifyModel}
                  onChange={(event) => setConfigDraft((prev) => ({ ...prev, clarifyModel: event.target.value }))}
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-sm font-medium" style={{ color: 'var(--rf-text-secondary)' }}>Reasoning / formatting model</span>
                <input
                  className="w-full rounded-[18px] border px-4 py-3 text-sm"
                  style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.9)', color: 'var(--rf-text)' }}
                  value={configDraft.decompositionModel}
                  onChange={(event) => setConfigDraft((prev) => ({ ...prev, decompositionModel: event.target.value }))}
                />
              </label>

              <label className="block md:col-span-2">
                <span className="mb-2 block text-sm font-medium" style={{ color: 'var(--rf-text-secondary)' }}>Acceptance requirements model</span>
                <input
                  className="w-full rounded-[18px] border px-4 py-3 text-sm"
                  style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.9)', color: 'var(--rf-text)' }}
                  value={configDraft.arModel}
                  onChange={(event) => setConfigDraft((prev) => ({ ...prev, arModel: event.target.value }))}
                />
              </label>

              <label className="block md:col-span-2">
                <span className="mb-2 block text-sm font-medium" style={{ color: 'var(--rf-text-secondary)' }}>Workspace domain context</span>
                <textarea
                  className="min-h-[120px] w-full rounded-[18px] border px-4 py-3 text-sm leading-7"
                  style={{ borderColor: 'var(--rf-border)', background: 'rgba(255,255,255,0.9)', color: 'var(--rf-text)' }}
                  value={configDraft.domainContext}
                  onChange={(event) => setConfigDraft((prev) => ({ ...prev, domainContext: event.target.value }))}
                  placeholder="Optional global context for testing. Project-specific context still wins when configured."
                />
              </label>
            </div>

            <div className="mt-6 flex items-center justify-between gap-4">
              <div className="text-sm leading-6" style={{ color: 'var(--rf-text-tertiary)' }}>
                Changes apply to new V2 runs. This is a temporary testing surface, not the final admin experience.
              </div>
              <div className="flex gap-3">
                <button
                  className="rounded-full border px-5 py-3 text-sm font-semibold"
                  style={{ borderColor: 'var(--rf-border)', color: 'var(--rf-text-secondary)', background: 'rgba(255,255,255,0.82)' }}
                  onClick={() => {
                    setConfigDraft(buildSettingsDraft(DEFAULT_CONFIG));
                    setSettingsNotice(null);
                  }}
                  type="button"
                >
                  Reset to defaults
                </button>
                <button
                  className="rounded-full px-5 py-3 text-sm font-semibold"
                  style={{ background: 'var(--rf-brand)', color: '#fff', opacity: settingsSaving ? 0.7 : 1 }}
                  disabled={settingsSaving}
                  onClick={() => void saveSettings()}
                  type="button"
                >
                  {settingsSaving ? 'Saving…' : 'Save settings'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
