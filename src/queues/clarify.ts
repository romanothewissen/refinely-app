/**
 * Forge Queue Consumer: async clarifying question generation.
 *
 * Runs with 900s timeout so slower models still have time to complete, but the
 * actual clarify flow now uses a single self-calibrating LLM call.
 */

import { AsyncEvent } from '@forge/events';
import { ClarifyContextMeta, ClarifyEvent, TokenUsageSummary } from '../types';
import { generateClarifyingQuestions, normalizeConversationTitle } from '../core/story-generator';
import { fetchReferenceExamples } from '../core/reference-examples';
import { retrieveWiContext } from '../core/wi-ingestion';
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

export async function handler(event: AsyncEvent<Record<string, unknown>> & { body: ClarifyEvent }) {
  const { sessionId, accountId, requirement, attachmentText, license, config: eventConfig, projectKey, runId } = event.body;
  const retryCount = event.retryContext?.retryCount ?? 0;
  const retryReason = event.retryContext?.retryReason ?? null;

  const relevantContext = eventConfig.domainContexts?.find((c) => c.projectKey === projectKey)
    || eventConfig.domainContexts?.find((c) => c.projectKey === '*')
    || { context: eventConfig.domainContext || '' };

  const config = {
    ...eventConfig,
    domainContext: relevantContext.context,
    tier: getEffectiveTier(eventConfig, { license }),
  };

  try {
    const piiEnabled = Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled);
    const maskedRequirement = maskPiiText(requirement, piiEnabled);
    const maskedAttachment = maskPiiText(attachmentText ?? '', piiEnabled);
    const reasoningMode = event.body.reasoningMode ?? config.aiExecutionPolicy.defaultReasoningMode;
    const outputMode = event.body.outputMode ?? config.aiExecutionPolicy.defaultOutputMode;
    const retrievalBudget = reasoningMode === 'deep'
      ? { wiTopK: 24, wiMaxChars: 70000, contextTimeoutMs: 30000 }
      : { wiTopK: 8, wiMaxChars: 25000, contextTimeoutMs: 18000 };

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

    await sendClarifyProgress(sessionId, runId, 'Loading supporting context…', {
      phase: 'context_retrieval',
      retryCount,
      retryReason,
      jobId: event.jobId,
      eventId: event.eventId,
    });

    const [wiContext, similarStoriesResult, referenceExamplesResult] = await Promise.all([
      config.wiConfig.enabled
        ? withTimeoutFallback(
            retrieveWiContext(
              maskedRequirement.text,
              Math.min(config.wiConfig.topKChunks, retrievalBudget.wiTopK),
              Math.min(config.wiConfig.maxChars, retrievalBudget.wiMaxChars),
              projectKey,
              {
                enabled: Boolean(config.similarityConfig.useLlmRerank),
                model: config.generatorConfig.themeModel,
                provider: config.generatorConfig.provider,
                geminiApiKey: config.generatorConfig.geminiApiKey,
                geminiBaseUrl: config.generatorConfig.geminiBaseUrl,
                openaiApiKey: config.generatorConfig.openaiApiKey,
                openaiBaseUrl: config.generatorConfig.openaiBaseUrl,
                azureOpenaiApiKey: config.generatorConfig.azureOpenaiApiKey,
                azureOpenaiEndpoint: config.generatorConfig.azureOpenaiEndpoint,
                azureOpenaiDeployment: config.generatorConfig.azureOpenaiDeployment,
                azureOpenaiApiVersion: config.generatorConfig.azureOpenaiApiVersion,
                shortlistSize: reasoningMode === 'deep' ? 24 : 14,
                timeoutMs: reasoningMode === 'deep' ? 18000 : 12000,
              },
            ),
            retrievalBudget.contextTimeoutMs,
            { text: '', docs: [] },
            'work-instruction context',
          )
        : Promise.resolve({ text: '', docs: [] }),
      config.tier !== 'free'
        ? withTimeoutFallback(
            findSimilarStoriesWithUsage(maskedRequirement.text, config, projectKey),
            retrievalBudget.contextTimeoutMs,
            { stories: [], tokenUsage: zeroClarifyTokenUsage() },
            'similar stories',
          )
        : Promise.resolve({ stories: [], tokenUsage: zeroClarifyTokenUsage() }),
      withTimeoutFallback(
        fetchReferenceExamples(config, projectKey, {
          perSourceLimit: reasoningMode === 'deep' ? 6 : 3,
          overallLimit: reasoningMode === 'deep' ? 10 : 5,
        }),
        retrievalBudget.contextTimeoutMs,
        { text: '', count: 0, examples: [] },
        'reference examples',
      ),
    ]);
    const similarStories = similarStoriesResult.stories;
    const referenceContextText = [referenceExamplesResult.text, formatSimilarStoriesText(similarStories, 10)]
      .filter(Boolean)
      .join('\n\n---\n\n');

    await sendClarifyProgress(sessionId, runId, 'Generating clarifying questions...', {
      phase: 'question_generation',
      retryCount,
      retryReason,
      jobId: event.jobId,
      eventId: event.eventId,
    });

    const clarifyResult = await generateClarifyingQuestions({
      requirement: maskedRequirement.text,
      attachmentText: maskedAttachment.text,
      wiContextText: wiContext.text,
      similarStoriesText: referenceContextText,
      config,
      reasoningMode,
      outputMode,
      timeoutMs: reasoningMode === 'deep' ? 45000 : 30000,
    });

    const tokenUsage = mergeTokenUsage(clarifyResult.tokenUsage, similarStoriesResult.tokenUsage);
    const clarifyContext: ClarifyContextMeta = {
      projectKey,
      domainRolesUsed: config.domainRoles ?? [],
      domainContextApplied: Boolean(config.domainContext?.trim()),
      attachmentIncluded: Boolean(attachmentText?.trim()),
      similarStoriesCount: similarStories.length,
      referencedSimilarStories: similarStories.slice(0, 12).map((item) => ({
        key: item.key,
        summary: item.summary,
        relevanceScore: item.relevanceScore,
        url: item.url,
      })),
      tokenUsage: clarifyResult.questions.length > 0 || tokenUsage.total > 0 ? tokenUsage : zeroClarifyTokenUsage(),
      wiDocsCount: wiContext.docs.length,
      referencedWiDocs: wiContext.docs.slice(0, 12).map((doc) => ({
        docId: doc.docId,
        filename: doc.filename,
        chunkCount: doc.chunkCount,
      })),
    };

    await writeClarifyProgress(sessionId, runId, {
      type: 'complete',
      questions: clarifyResult.questions,
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
        reasoningMode,
        outputMode,
        initialClarifyQuestionCount: clarifyResult.questions.length,
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
            `Generated ${clarifyResult.questions.length} clarifying questions using a single prompt-driven discovery pass.`,
            `Applied ${wiContext.docs.length} work instruction documents and ${similarStories.length} similar backlog items.`,
          ],
          contextUsage: {
            similarStoriesCount: similarStories.length,
            wiDocsCount: wiContext.docs.length,
            reasoningMode,
            outputMode,
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
          reasoningMode,
          outputMode,
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
    const existing = index.find((entry) => entry.sessionId === sessionId);
    if (existing) {
      existing.updatedAt = new Date().toISOString();
      existing.title = existing.title || title;
      existing.turnCount = (existing.turnCount ?? 0) + 1;
    } else {
      index.unshift({ sessionId, title, updatedAt: new Date().toISOString(), turnCount: 1 });
    }
    await entitySet(indexKey, index.slice(0, 100));
  } catch {
    // ignore
  }
}
