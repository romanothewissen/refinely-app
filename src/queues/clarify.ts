/**
 * Forge Queue Consumer: async clarifying question generation.
 *
 * Runs with 900s timeout — allows slow thinking models (e.g. Gemini 2.5 Pro)
 * to generate high-quality clarifying questions without hitting the 25s
 * resolver limit.
 *
 * Result is stored in Forge Storage; the frontend polls getClarifyResult.
 */

import { AsyncEvent } from '@forge/events';
import { ClarifyContextMeta, ClarifyEvent, PlannerDecision, TokenUsageSummary } from '../types';
import { buildHeuristicPlannerDecision } from '../core/planner';
import { generateClarifyingQuestions, normalizeConversationTitle } from '../core/story-generator';
import { retrieveWiContext } from '../core/wi-ingestion';
import { fetchGoldExamples, formatGoldExamplesText } from '../core/gold-standard';
import { findSimilarStoriesWithUsage, formatSimilarStoriesText } from '../core/similar-stories';
import { getEffectiveTier } from '../services/billing';
import { upsertAiSessionInsight } from '../services/ai-insights';
import { entityGet, entitySet, KEYS } from '../services/cache';
import { appendComplianceAuditEvent, maskPiiText, saveTransparencyReport } from '../services/compliance';

async function writeClarifyProgress(
  sessionId: string,
  runId: string,
  patch: Record<string, unknown>,
) {
  const current = await entityGet<Record<string, any>>(KEYS.clarifyProgress(sessionId));
  if (current?.runId && current.runId !== runId) {
    console.warn('[clarify-queue] Skipping stale progress write for superseded run', {
      sessionId,
      activeRunId: current.runId,
      staleRunId: runId,
    });
    return false;
  }

  await entitySet(KEYS.clarifyProgress(sessionId), {
    ...(current ?? {}),
    ...patch,
    runId,
    updatedAt: Date.now(),
  });
  return true;
}

async function sendClarifyProgress(
  sessionId: string,
  runId: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  await writeClarifyProgress(sessionId, runId, {
    type: 'pending',
    message,
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
    console.warn(`[clarify-queue] ${label} lookup failed, continuing without it:`, err);
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function throwAfterTimeout(timeoutMs: number, label: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`[clarify-queue] ${label} exceeded ${timeoutMs}ms — aborting to surface error`)),
      timeoutMs,
    );
  });
}

function resolveRelevantGoldSources(
  sources: ClarifyEvent['config']['goldSources'],
  projectKey: string,
) {
  const exact = sources.filter(s => s.targetProjects?.includes(projectKey));
  const global = sources.filter(s => s.targetProjects?.includes('*'));
  if (projectKey === '*') return global;

  const deduped = new Map<string, (typeof sources)[number]>();
  [...exact, ...global].forEach(source => deduped.set(source.key, source));
  return Array.from(deduped.values());
}

interface ClarifyRetrievalStrategy {
  wiTopK: number;
  wiMaxChars: number;
  goldLimit: number;
  includeSimilarStories: boolean;
  contextTimeoutMs: number;
  plannerDeadlineMs: number;
  questionDeadlineMs: number;
  contextMessage: string;
}

function zeroClarifyTokenUsage(): TokenUsageSummary {
  return {
    input: 0,
    output: 0,
    total: 0,
    byStage: {
      clarify: { input: 0, output: 0, total: 0 },
    },
  };
}

function mergeTokenUsage(
  existing?: TokenUsageSummary,
  next?: TokenUsageSummary,
): TokenUsageSummary {
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

function buildAmbiguityAssessment(decision: PlannerDecision, generatedQuestions: number) {
  return {
    level: decision.questionPlan.clarity,
    score: decision.ambiguityScore,
    reasons: decision.ambiguityReasons.slice(0, 4),
    questionPlan: {
      min: decision.questionPlan.min,
      max: decision.questionPlan.max,
      target: decision.questionPlan.target,
    },
    generatedQuestions,
  };
}

function formatAssessmentMessage(decision: PlannerDecision): string {
  if (decision.questionPlan.max <= 0) {
    return 'Quick assessment: this looks clear and bounded, so clarifying questions can be skipped.';
  }

  const target = Math.max(decision.questionPlan.min, decision.questionPlan.target);
  const questionLabel = `${target} clarifying question${target === 1 ? '' : 's'}`;
  return `Quick assessment: ${decision.questionPlan.clarity} ambiguity and ${decision.scopeMode} scope. Aiming for ${questionLabel}.`;
}

function buildRetrievalStrategy(
  decision: PlannerDecision,
  wiConfig: { topKChunks: number; maxChars: number },
  reasoningMode: 'fast' | 'deep',
  includeSimilarStories: boolean,
): ClarifyRetrievalStrategy {
  const isDeepPass =
    reasoningMode === 'deep' ||
    decision.clarificationMode === 'deep' ||
    decision.scopeMode === 'initiative';
  const isLightPass =
    !isDeepPass &&
    (decision.clarificationMode === 'light' || (decision.scopeMode === 'atomic' && decision.questionPlan.max <= 4));

  if (isDeepPass) {
    return {
      wiTopK: Math.min(wiConfig.topKChunks, 6),
      wiMaxChars: Math.min(wiConfig.maxChars, 22000),
      goldLimit: 6,
      includeSimilarStories,
      contextTimeoutMs: 18000,
      plannerDeadlineMs: 12000,
      questionDeadlineMs: 45000,
      contextMessage: 'Loading a deeper context pass to sharpen discovery coverage…',
    };
  }

  if (isLightPass) {
    return {
      wiTopK: Math.min(wiConfig.topKChunks, 2),
      wiMaxChars: Math.min(wiConfig.maxChars, 6000),
      goldLimit: 2,
      includeSimilarStories,
      contextTimeoutMs: 9000,
      plannerDeadlineMs: 7000,
      questionDeadlineMs: 22000,
      contextMessage: 'Loading a light context pass to refine the most important questions…',
    };
  }

  return {
    wiTopK: Math.min(wiConfig.topKChunks, 4),
    wiMaxChars: Math.min(wiConfig.maxChars, 12000),
    goldLimit: 4,
    includeSimilarStories,
    contextTimeoutMs: 14000,
    plannerDeadlineMs: 9000,
    questionDeadlineMs: 30000,
    contextMessage: 'Loading supporting context to tighten the discovery plan…',
  };
}

export async function handler(event: AsyncEvent<Record<string, unknown>> & { body: ClarifyEvent }) {
  const { sessionId, accountId, requirement, attachmentText, license, config: eventConfig, projectKey, runId } = event.body;
  const retryCount = event.retryContext?.retryCount ?? 0;
  const retryReason = event.retryContext?.retryReason ?? null;
  
  // Resolve project-specific context
  const relevantContext = eventConfig.domainContexts?.find(c => c.projectKey === projectKey) 
    || eventConfig.domainContexts?.find(c => c.projectKey === '*')
    || { context: eventConfig.domainContext || '' };
    
  const config = { 
    ...eventConfig, 
    domainContext: relevantContext.context,
    goldSources: resolveRelevantGoldSources(eventConfig.goldSources, projectKey),
    tier: getEffectiveTier(eventConfig, { license }) 
  };

  try {
    const piiEnabled = Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled);
    const maskedRequirement = maskPiiText(requirement, piiEnabled);
    const maskedAttachment = maskPiiText(attachmentText ?? '', piiEnabled);
    const reasoningMode = event.body.reasoningMode ?? config.aiExecutionPolicy.defaultReasoningMode;
    const outputMode = event.body.outputMode ?? config.aiExecutionPolicy.defaultOutputMode;
    const plannerDecision = buildHeuristicPlannerDecision({
      requirement: maskedRequirement.text,
      attachmentText: maskedAttachment.text,
      reasoningMode,
      outputMode,
      policy: config.aiExecutionPolicy,
    });
    const retrievalStrategy = buildRetrievalStrategy(
      plannerDecision,
      config.wiConfig,
      reasoningMode,
      config.tier !== 'free',
    );
    const includeBacklogContext =
      reasoningMode !== 'deep' && plannerDecision.clarificationMode !== 'deep';

    if (retryCount > 1) {
      await writeClarifyProgress(sessionId, runId, {
        type: 'error',
        error: 'Discovery restarted multiple times and was stopped to avoid looping. Please try again.',
        phase: 'retry_aborted',
        retryCount,
        retryReason,
        jobId: event.jobId,
        eventId: event.eventId,
      });
      return;
    }

    if (retryCount > 0) {
      await sendClarifyProgress(
        sessionId,
        runId,
        `Retrying discovery after an interrupted attempt (retry ${retryCount})…`,
        {
          phase: 'retrying',
          retryCount,
          retryReason,
          jobId: event.jobId,
          eventId: event.eventId,
        },
      );
    }

    await sendClarifyProgress(sessionId, runId, 'Assessing context and drafting discovery questions…', {
      phase: 'preflight',
      retryCount,
      retryReason,
      jobId: event.jobId,
      eventId: event.eventId,
    });
    await sendClarifyProgress(sessionId, runId, retrievalStrategy.contextMessage, {
      phase: 'context_retrieval',
      retryCount,
      retryReason,
      jobId: event.jobId,
      eventId: event.eventId,
    });
    const [wiContext, goldItems, similarStoriesResult] = await Promise.all([
      config.wiConfig.enabled
        ? withTimeoutFallback(
            retrieveWiContext(
              maskedRequirement.text,
              retrievalStrategy.wiTopK,
              retrievalStrategy.wiMaxChars,
              projectKey,
            ),
            retrievalStrategy.contextTimeoutMs,
            { text: '', docs: [] },
            'work-instruction context',
          )
        : Promise.resolve({ text: '', docs: [] }),
      includeBacklogContext && config.goldSources.length
        ? withTimeoutFallback(
            fetchGoldExamples(config.goldSources, retrievalStrategy.goldLimit),
            retrievalStrategy.contextTimeoutMs,
            [],
            'gold examples',
          )
        : Promise.resolve([]),
      includeBacklogContext && retrievalStrategy.includeSimilarStories
        ? withTimeoutFallback(
            findSimilarStoriesWithUsage(maskedRequirement.text, config, projectKey),
            retrievalStrategy.contextTimeoutMs,
            { stories: [], tokenUsage: zeroClarifyTokenUsage() },
            'similar stories',
          )
        : Promise.resolve({ stories: [], tokenUsage: zeroClarifyTokenUsage() }),
    ]);
    const similarStories = similarStoriesResult.stories;

    let questions: Awaited<ReturnType<typeof generateClarifyingQuestions>>['questions'] = [];
    let tokenUsage: TokenUsageSummary = zeroClarifyTokenUsage();
    let ambiguityAssessment = buildAmbiguityAssessment(plannerDecision, 0);

    const targetQuestionCount = Math.max(
      plannerDecision.questionPlan.min,
      plannerDecision.questionPlan.target,
    );
    await sendClarifyProgress(
      sessionId,
      runId,
      `Drafting ${targetQuestionCount} domain-specific clarifying question${targetQuestionCount === 1 ? '' : 's'}…`,
      {
        phase: 'question_generation',
        retryCount,
        retryReason,
        jobId: event.jobId,
        eventId: event.eventId,
      },
    );
    const clarifyResult = await generateClarifyingQuestions({
      requirement: maskedRequirement.text,
      attachmentText: maskedAttachment.text,
      wiContextText: wiContext.text,
      goldExamplesText: formatGoldExamplesText(goldItems, 6, 900, 900),
      similarStoriesText: formatSimilarStoriesText(similarStories, 8),
      config,
      reasoningMode,
      outputMode,
      plannerDecision,
      timeoutMs: retrievalStrategy.questionDeadlineMs,
    });
    questions = clarifyResult.questions;
    tokenUsage = mergeTokenUsage(clarifyResult.tokenUsage, similarStoriesResult.tokenUsage);
    ambiguityAssessment = clarifyResult.ambiguityAssessment;

    const clarifyContext: ClarifyContextMeta = {
      projectKey,
      domainRolesUsed: config.domainRoles ?? [],
      domainContextApplied: Boolean(config.domainContext?.trim()),
      attachmentIncluded: Boolean(attachmentText?.trim()),
      plannerDecision,
      goldExamplesCount: goldItems.length,
      referencedGoldExamples: goldItems.slice(0, 12).map(item => ({
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
      ambiguityAssessment: {
        ...ambiguityAssessment,
        generatedQuestions: questions.length,
      },
      tokenUsage: questions.length > 0 || tokenUsage.total > 0 ? tokenUsage : zeroClarifyTokenUsage(),
      wiDocsCount: wiContext.docs.length,
      referencedWiDocs: wiContext.docs.slice(0, 12).map(doc => ({
        docId: doc.docId,
        filename: doc.filename,
        chunkCount: doc.chunkCount,
      })),
    };

    await writeClarifyProgress(sessionId, runId, {
      type: 'complete',
      questions,
      contextMeta: clarifyContext,
      phase: 'complete',
      retryCount,
      retryReason,
      jobId: event.jobId,
      eventId: event.eventId,
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
        initialClarifyQuestionCount: questions.length,
      });

      await saveClarifyTurn(sessionId, accountId, maskedRequirement.text, clarifyContext);
      if (config.compliance?.enabled && config.compliance?.transparencyReportsEnabled) {
        await saveTransparencyReport({
          sessionId,
          turnType: 'clarify',
          actorAccountId: accountId,
          provider: config.generatorConfig.provider,
          model: config.generatorConfig.clarifyModel,
          projectKey,
          requirementExcerpt: maskedRequirement.text.slice(0, 240),
          decisionSummary: [
            `Discovery was calibrated to ${plannerDecision.clarificationMode} depth for a ${plannerDecision.scopeMode} request.`,
            `Generated ${questions.length} clarifying questions for ${ambiguityAssessment.level} ambiguity input.`,
            `Question plan targeted ${ambiguityAssessment.questionPlan.min}-${ambiguityAssessment.questionPlan.max} based on requirement clarity.`,
          ],
          contextUsage: {
            goldExamplesCount: goldItems.length,
            similarStoriesCount: similarStories.length,
            wiDocsCount: wiContext.docs.length,
            ambiguityScore: ambiguityAssessment.score,
            scopeMode: plannerDecision.scopeMode,
            clarificationMode: plannerDecision.clarificationMode,
          },
          tokenUsage,
          piiMasking: {
            enabled: piiEnabled,
            totalRedactions: maskedRequirement.stats.totalRedactions + maskedAttachment.stats.totalRedactions,
            byType: {
              ...maskedRequirement.stats.byType,
              ...maskedAttachment.stats.byType,
            },
          },
        });
      }
      await appendComplianceAuditEvent({
        actorAccountId: accountId,
        category: 'runtime',
        action: 'CLARIFY_WORKFLOW_EXECUTED',
        details: {
          sessionId,
          projectKey,
          model: config.generatorConfig.clarifyModel,
          scopeMode: plannerDecision.scopeMode,
          clarificationMode: plannerDecision.clarificationMode,
        },
        enabled: Boolean(config.compliance?.enabled && config.compliance?.auditTrailEnabled),
      });
    } catch (tailErr) {
      console.warn('[clarify-queue] Non-blocking post-processing failed:', tailErr);
    }
  } catch (err) {
    console.error('[clarify-queue] Error:', err);
    await writeClarifyProgress(sessionId, runId, {
      type: 'error',
      error: err instanceof Error ? err.message : 'Clarify failed',
      phase: 'error',
      retryCount,
      retryReason,
      jobId: event.jobId,
      eventId: event.eventId,
    });
  }
}

async function saveClarifyTurn(
  sessionId: string,
  accountId: string,
  requirement: string,
  clarifyContext: ClarifyContextMeta,
) {
  try {
    const key = KEYS.userConversations(accountId, sessionId);
    const existing = await entityGet<{ turns: unknown[] }>(key) ?? { turns: [] };
    existing.turns.push({
      turnType: 'clarify',
      requirement,
      features: [],
      similarStories: [],
      clarifyContext,
      tokenUsage: clarifyContext.tokenUsage,
      timestamp: new Date().toISOString(),
    });
    await entitySet(key, existing);
    await updateConversationIndex(sessionId, accountId, normalizeConversationTitle('', requirement));
  } catch (err) {
    console.warn('[clarify-queue] Failed to save clarify turn:', err);
  }
}

interface ConvIndex {
  sessionId: string;
  title: string;
  updatedAt: string;
  turnCount: number;
  isPinned?: boolean;
}

async function updateConversationIndex(sessionId: string, accountId: string, title: string) {
  try {
    const indexKey = KEYS.userConversationIndex(accountId);
    const index = await entityGet<ConvIndex[]>(indexKey) ?? [];
    const existing = index.find(entry => entry.sessionId === sessionId);
    if (existing) {
      existing.updatedAt = new Date().toISOString();
      existing.turnCount = (existing.turnCount ?? 0) + 1;
    } else {
      index.unshift({ sessionId, title, updatedAt: new Date().toISOString(), turnCount: 1 });
    }
    await entitySet(indexKey, index.slice(0, 100));
  } catch (err) {
    console.warn('[clarify-queue] Failed to update conversation index:', err);
  }
}
