/**
 * Forge Queue Consumer: two-pass feature generation.
 *
 * Runs with 900s (15 min) timeout — handles the full generation pipeline
 * including gold standard fetching, WI context retrieval, pass 1 + pass 2.
 *
 * Progress is streamed back to the UI via Forge Realtime.
 */

import { GenerationContextMeta, GenerationEvent, SimilarStory, TokenUsageSummary } from '../types';
import { buildHeuristicPlannerDecision } from '../core/planner';
import { generateFeatures, generateSessionTitle, normalizeConversationTitle } from '../core/story-generator';
import { findSimilarStoriesWithUsage, formatSimilarStoriesText } from '../core/similar-stories';
import { fetchGoldExamples, formatGoldExamplesText } from '../core/gold-standard';
import { retrieveWiContext } from '../core/wi-ingestion';
import { upsertAiSessionInsight } from '../services/ai-insights';
import { recordGeneration, getEffectiveTier } from '../services/billing';
import { entityGet, entitySet, KEYS } from '../services/cache';
import { maskPiiText, maskPiiInAnswers, saveTransparencyReport, appendComplianceAuditEvent } from '../services/compliance';

interface RealtimeEvent {
  type: 'progress' | 'complete' | 'error';
  sessionId: string;
  runId?: string;
  jobId?: string;
  message?: string;
  pass?: 1 | 2;
  payload?: unknown;
}

async function writeGenerationProgress(
  sessionId: string,
  runId: string,
  patch: Record<string, unknown>,
) {
  const current = await entityGet<Record<string, any>>(KEYS.generationProgress(sessionId));
  if (current?.runId && current.runId !== runId) {
    console.warn('[generation-queue] Skipping stale progress write for superseded run', {
      sessionId,
      activeRunId: current.runId,
      staleRunId: runId,
    });
    return false;
  }

  await entitySet(KEYS.generationProgress(sessionId), {
    ...(current ?? {}),
    ...patch,
    runId,
    updatedAt: Date.now(),
  });
  return true;
}

async function sendProgress(
  sessionId: string,
  runId: string,
  message: string,
  pass?: 1 | 2,
  payload?: unknown,
  extra?: Record<string, unknown>,
) {
  await writeGenerationProgress(sessionId, runId, {
    type: 'progress',
    sessionId,
    message,
    pass,
    payload,
    ...(extra ?? {}),
  });
}

async function withTimeoutFallback<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), timeoutMs);
    });
    return await Promise.race([promise, timeoutPromise]);
  } catch (err) {
    console.warn(`[generation-queue] ${label} lookup failed, continuing without it:`, err);
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mergeTokenUsage(
  existing?: TokenUsageSummary,
  next?: TokenUsageSummary,
): TokenUsageSummary | undefined {
  if (!existing && !next) return undefined;
  return {
    input: (existing?.input ?? 0) + (next?.input ?? 0),
    output: (existing?.output ?? 0) + (next?.output ?? 0),
    total: (existing?.total ?? 0) + (next?.total ?? 0),
    byStage: {
      ...(existing?.byStage ?? {}),
      ...(next?.byStage ?? {}),
    },
  };
}

function buildGenerationRetrievalBudget(reasoningMode: 'fast' | 'deep') {
  if (reasoningMode === 'deep') {
    return {
      wiTopK: 6,
      wiMaxChars: 18000,
      goldLimit: 6,
      contextTimeoutMs: 40000,
    };
  }

  return {
    wiTopK: 4,
    wiMaxChars: 9000,
    goldLimit: 4,
    contextTimeoutMs: 22000,
  };
}

function resolveRelevantGoldSources(
  sources: GenerationEvent['config']['goldSources'],
  projectKey: string,
) {
  const exact = sources.filter(s => s.targetProjects?.includes(projectKey));
  const global = sources.filter(s => s.targetProjects?.includes('*'));
  if (projectKey === '*') return global;

  const deduped = new Map<string, (typeof sources)[number]>();
  [...exact, ...global].forEach(source => deduped.set(source.key, source));
  return Array.from(deduped.values());
}

async function getLatestDiscoveryCoverage(sessionId: string, accountId: string) {
  const conversation = await entityGet<{ turns?: Array<Record<string, any>> }>(KEYS.userConversations(accountId, sessionId));
  const rawTurns = conversation?.turns;
  const turns = Array.isArray(rawTurns) ? rawTurns : [];
  const latestClarifyTurn = [...turns]
    .reverse()
    .find(turn => turn?.turnType === 'clarify' && turn?.clarifyContext?.discoveryCoverage);
  return latestClarifyTurn?.clarifyContext?.discoveryCoverage;
}

async function getLatestDiscoveryTranscript(sessionId: string, accountId: string) {
  const conversation = await entityGet<{ turns?: Array<Record<string, any>> }>(KEYS.userConversations(accountId, sessionId));
  const rawTurns = conversation?.turns;
  const turns = Array.isArray(rawTurns) ? rawTurns : [];
  const latestClarifyTurn = [...turns]
    .reverse()
    .find(turn => turn?.turnType === 'clarify' && turn?.clarifyContext?.discoveryTranscript?.length);
  return latestClarifyTurn?.clarifyContext?.discoveryTranscript;
}

export async function handler(event: { body: GenerationEvent }) {
  const { runId, sessionId, accountId, requirement, clarifyAnswers, attachmentText, license, config: eventConfig, projectKey } = event.body;
  
  // Resolve project-specific context and filter gold sources
  const relevantContext = eventConfig.domainContexts?.find(c => c.projectKey === projectKey) 
    || eventConfig.domainContexts?.find(c => c.projectKey === '*')
    || { context: eventConfig.domainContext || '' };
    
  // STRICT PROJECT-LEVEL: Only sources that explicitly target this project. No global fallback.
  const relevantGoldSources = resolveRelevantGoldSources(eventConfig.goldSources, projectKey);
  
  const config = { 
    ...eventConfig, 
    domainContext: relevantContext.context,
    goldSources: relevantGoldSources,
    tier: getEffectiveTier(eventConfig, { license }) 
  };

  try {
    const piiEnabled = Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled);
    const maskedRequirement = maskPiiText(requirement, piiEnabled);
    const maskedAttachment = maskPiiText(attachmentText ?? '', piiEnabled);
    const maskedAnswers = maskPiiInAnswers(clarifyAnswers ?? [], piiEnabled);
    const reasoningMode = event.body.reasoningMode ?? config.aiExecutionPolicy.defaultReasoningMode;
    const retrievalBudget = buildGenerationRetrievalBudget(reasoningMode);
    const goldCount = relevantGoldSources.length;
    const projectLabel = projectKey && projectKey !== '*' ? projectKey : 'workspace';
    await sendProgress(sessionId, runId, `Loading context for ${projectLabel}…`);

    const [goldItems, wiContext, similarStoriesResult] = await Promise.all([
      goldCount
        ? withTimeoutFallback(
            fetchGoldExamples(config.goldSources, retrievalBudget.goldLimit),
            retrievalBudget.contextTimeoutMs,
            [],
            'gold examples',
          )
        : Promise.resolve([]),
      config.wiConfig.enabled
        ? withTimeoutFallback(
            retrieveWiContext(
              maskedRequirement.text,
              Math.min(config.wiConfig.topKChunks, retrievalBudget.wiTopK),
              Math.min(config.wiConfig.maxChars, retrievalBudget.wiMaxChars),
              projectKey,
            ),
            retrievalBudget.contextTimeoutMs,
            { text: '', docs: [] },
            'work-instruction context',
          )
        : Promise.resolve({ text: '', docs: [] }),
      withTimeoutFallback(
        findSimilarStoriesWithUsage(maskedRequirement.text, config, projectKey),
        retrievalBudget.contextTimeoutMs,
        { stories: [], tokenUsage: { input: 0, output: 0, total: 0, byStage: {} } },
        'similar stories',
      ),
    ]);

    const similarStories = similarStoriesResult.stories;
    const goldExamplesText = formatGoldExamplesText(goldItems);
    const similarStoriesText = formatSimilarStoriesText(similarStories);

    const contextParts: string[] = [];
    if (goldItems.length > 0) contextParts.push(`${goldItems.length} curated example${goldItems.length !== 1 ? 's' : ''}`);
    if (similarStories.length > 0) contextParts.push(`${similarStories.length} related stor${similarStories.length !== 1 ? 'ies' : 'y'}`);
    if (wiContext.docs.length > 0) contextParts.push(`${wiContext.docs.length} work instruction${wiContext.docs.length !== 1 ? 's' : ''}`);
    const contextSummary = contextParts.length > 0 ? contextParts.join(', ') : 'no prior context';
    await sendProgress(sessionId, runId, `Context loaded (${contextSummary}). Planning features…`);

    const plannerDecision = buildHeuristicPlannerDecision({
      requirement: maskedRequirement.text,
      clarifyAnswers: maskedAnswers.answers,
      attachmentText: maskedAttachment.text,
      goldExamplesText,
      similarStoriesText,
      wiContextText: wiContext.text,
      reasoningMode,
      outputMode: event.body.outputMode ?? config.aiExecutionPolicy.defaultOutputMode,
      policy: config.aiExecutionPolicy,
    });

    // Progress: pass 1
    await sendProgress(sessionId, runId, 'Decomposing requirement into features…', 1);

    const result = await generateFeatures({
      requirement,
      clarifyAnswers: maskedAnswers.answers,
      attachmentText: maskedAttachment.text,
      goldExamplesText,
      similarStoriesText,
      wiContextText: wiContext.text,
      config,
      reasoningMode,
      outputMode: event.body.outputMode ?? config.aiExecutionPolicy.defaultOutputMode,
      plannerDecision,
      onPass1Complete: async ({ featureCount, draftFeatures, arBatchCount }) => {
        const batchHint = arBatchCount > 1 ? ` across ${arBatchCount} batches` : '';
        await sendProgress(
          sessionId,
          runId,
          `Drafted ${featureCount} feature${featureCount !== 1 ? 's' : ''}. Writing acceptance requirements${batchHint}…`,
          2,
          { features: draftFeatures, draft: true },
        );
      },
    });

    result.similarStories = similarStories;
    result.sessionId = sessionId;
    result.tokenUsage = mergeTokenUsage(result.tokenUsage, similarStoriesResult.tokenUsage) ?? result.tokenUsage;
    const latestDiscoveryCoverage = await getLatestDiscoveryCoverage(sessionId, accountId);
    const latestDiscoveryTranscript = await getLatestDiscoveryTranscript(sessionId, accountId);
    const generationContext: GenerationContextMeta = {
      projectKey,
      domainRolesUsed: config.domainRoles ?? [],
      domainContextApplied: Boolean(config.domainContext?.trim()),
      attachmentIncluded: Boolean(attachmentText?.trim()),
      plannerDecision,
      goldExamplesCount: goldItems.length,
      referencedGoldExamples: goldItems.slice(0, 15).map(item => ({
        key: item.key,
        source: item.source,
        summary: item.summary,
      })),
      similarStoriesCount: similarStories.length,
      referencedSimilarStories: similarStories.slice(0, 12).map(item => ({
        key: item.key,
        summary: item.summary,
        relevanceScore: item.relevanceScore,
        url: item.url,
      })),
      initiativeGroups: result.initiativeGroups,
      discoveryCoverage: latestDiscoveryCoverage,
      discoveryTranscript: latestDiscoveryTranscript,
      tokenUsage: result.tokenUsage,
      wiDocsCount: wiContext.docs.length,
      referencedWiDocs: wiContext.docs.slice(0, 12).map(doc => ({
        docId: doc.docId,
        filename: doc.filename,
        chunkCount: doc.chunkCount,
      })),
    };
    result.generationContext = generationContext;

    await writeGenerationProgress(sessionId, runId, {
      type: 'complete',
      sessionId,
      payload: result,
    });

    try {
      await upsertAiSessionInsight({
        sessionId,
        projectKey,
        reasoningMode: plannerDecision.reasoningMode,
        outputMode: plannerDecision.outputMode,
        scopeMode: plannerDecision.scopeMode,
        clarificationMode: plannerDecision.clarificationMode,
        plannedFeatureTarget: plannerDecision.featurePlan.target,
        plannedQuestionTarget: plannerDecision.questionPlan.target,
        latestCoverageScore: latestDiscoveryCoverage?.overallScore ?? null,
        latestMissingCriticalCount: latestDiscoveryCoverage?.missingCritical?.length ?? 0,
        discoveryRounds: Array.isArray(latestDiscoveryTranscript) ? latestDiscoveryTranscript.length : undefined,
        totalDiscoveryQuestions: Array.isArray(latestDiscoveryTranscript)
          ? latestDiscoveryTranscript.reduce((sum, round) => sum + (Array.isArray(round?.questions) ? round.questions.length : 0), 0)
          : undefined,
        totalDiscoveryAnswers: Array.isArray(latestDiscoveryTranscript)
          ? latestDiscoveryTranscript.reduce((sum, round) => sum + (Array.isArray(round?.answers) ? round.answers.length : 0), 0)
          : undefined,
        generatedFeatureCount: result.features.length,
        initiativeGroupCount: result.initiativeGroups?.length ?? 0,
      });

      await recordGeneration();

      await saveConversationTurn(
        sessionId,
        accountId,
        maskedRequirement.text,
        result.features,
        similarStories,
        config.generatorConfig.arModel,
        generationContext,
        result.tokenUsage,
      );

      if (config.compliance?.enabled && config.compliance?.transparencyReportsEnabled) {
        await saveTransparencyReport({
          sessionId,
          turnType: 'generate',
          actorAccountId: accountId,
          provider: config.generatorConfig.provider,
          model: config.generatorConfig.arModel,
          projectKey,
          requirementExcerpt: maskedRequirement.text.slice(0, 240),
          decisionSummary: [
            `Planner classified this request as ${plannerDecision.scopeMode} with ${plannerDecision.featurePlan.target} target feature(s).`,
            `Generated features using ${goldItems.length} curated examples and ${similarStories.length} backlog references.`,
            `Applied ${wiContext.docs.length} work instruction documents and ${config.domainRoles?.length ?? 0} roles.`,
            result.initiativeGroups?.length
              ? `Organized the output into ${result.initiativeGroups.length} initiative group(s) for easier backlog review.`
              : 'Returned a flat feature list because no initiative grouping was needed.',
            'Acceptance requirements were produced in a dedicated second pass for consistency.',
          ],
          contextUsage: {
            goldExamplesCount: goldItems.length,
            similarStoriesCount: similarStories.length,
            wiDocsCount: wiContext.docs.length,
            domainRolesCount: config.domainRoles?.length ?? 0,
            scopeMode: plannerDecision.scopeMode,
            featureTarget: plannerDecision.featurePlan.target,
            initiativeGroupCount: result.initiativeGroups?.length ?? 0,
          },
          tokenUsage: result.tokenUsage,
          piiMasking: {
            enabled: piiEnabled,
            totalRedactions: maskedRequirement.stats.totalRedactions + maskedAttachment.stats.totalRedactions + maskedAnswers.stats.totalRedactions,
            byType: {
              ...maskedRequirement.stats.byType,
              ...maskedAttachment.stats.byType,
              ...maskedAnswers.stats.byType,
            },
          },
        });
      }
      await appendComplianceAuditEvent({
        actorAccountId: accountId,
        category: 'runtime',
        action: 'GENERATION_WORKFLOW_EXECUTED',
        details: {
          sessionId,
          projectKey,
          model: config.generatorConfig.arModel,
          scopeMode: plannerDecision.scopeMode,
          featureTarget: plannerDecision.featurePlan.target,
          initiativeGroupCount: result.initiativeGroups?.length ?? 0,
        },
        enabled: Boolean(config.compliance?.enabled && config.compliance?.auditTrailEnabled),
      });

      try {
        const title = await generateSessionTitle(maskedRequirement.text, config);
        await updateConversationTitle(sessionId, accountId, title);
      } catch (titleErr) {
        console.warn('[generation-queue] Title generation failed, using fallback title:', titleErr);
        await updateConversationTitle(sessionId, accountId, normalizeConversationTitle('', requirement));
      }
    } catch (tailErr) {
      console.warn('[generation-queue] Non-blocking post-processing failed:', tailErr);
    }

  } catch (err) {
    console.error('[generation-queue] Error:', err);
    await writeGenerationProgress(sessionId, runId, {
      type: 'error',
      sessionId,
      message: err instanceof Error ? err.message : 'Generation failed. Please try again.',
    });
  }
}

// ─── Conversation history helpers ─────────────────────────────────────────────

async function saveConversationTurn(
  sessionId: string,
  accountId: string,
  requirement: string,
  features: unknown[],
  similarStories: unknown[],
  model: string,
  generationContext?: GenerationContextMeta,
  tokenUsage?: TokenUsageSummary,
) {
  try {
    const key = KEYS.userConversations(accountId, sessionId);
    const existing = await entityGet<{ turns: unknown[] }>(key) ?? { turns: [] };
    existing.turns.push({
      turnType: 'generate',
      requirement,
      features,
      similarStories,
      generationContext,
      tokenUsage,
      model,
      timestamp: new Date().toISOString(),
    });
    await entitySet(key, existing);

    // Update per-user conversation index
    await updateConversationIndex(sessionId, accountId, normalizeConversationTitle('', requirement));
  } catch (err) {
    console.warn('[generation-queue] Failed to save conversation turn:', err);
  }
}

async function updateConversationTitle(sessionId: string, accountId: string, title: string) {
  try {
    const key = KEYS.userConversations(accountId, sessionId);
    const existing = await entityGet<{ turns: unknown[]; title?: string }>(key);
    if (existing) {
      existing.title = title;
      await entitySet(key, existing);
    }

    // Update per-user index with title
    const indexKey = KEYS.userConversationIndex(accountId);
    const index = await entityGet<ConvIndex[]>(indexKey) ?? [];
    const entry = index.find(e => e.sessionId === sessionId);
    if (entry) {
      entry.title = title;
      await entitySet(indexKey, index);
    }
  } catch {
    // ignore
  }
}

interface ConvIndex {
  sessionId: string;
  title: string;
  updatedAt: string;
  turnCount: number;
}

async function updateConversationIndex(sessionId: string, accountId: string, title: string) {
  try {
    const indexKey = KEYS.userConversationIndex(accountId);
    const index = await entityGet<ConvIndex[]>(indexKey) ?? [];
    const existing = index.find(e => e.sessionId === sessionId);
    if (existing) {
      existing.updatedAt = new Date().toISOString();
      existing.turnCount = (existing.turnCount ?? 0) + 1;
    } else {
      index.unshift({ sessionId, title, updatedAt: new Date().toISOString(), turnCount: 1 });
    }
    // Keep last 100 conversations per user in index
    await entitySet(indexKey, index.slice(0, 100));
  } catch {
    // ignore
  }
}
