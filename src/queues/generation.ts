/**
 * Forge Queue Consumer: single-pass feature generation.
 *
 * Runs with 900s timeout, but the generation path itself now performs one
 * prompt-driven LLM call after retrieving supporting context.
 */

import { GenerationContextMeta, GenerationEvent, TokenUsageSummary } from '../types';
import { fetchReferenceExamples } from '../core/reference-examples';
import { generateFeatures, generateSessionTitle, normalizeConversationTitle } from '../core/story-generator';
import { findSimilarStoriesWithUsage, formatSimilarStoriesText } from '../core/similar-stories';
import { retrieveWiContext } from '../core/wi-ingestion';
import { upsertAiSessionInsight } from '../services/ai-insights';
import { recordGeneration, getEffectiveTier } from '../services/billing';
import { entityGet, entitySet, KEYS } from '../services/cache';
import { maskPiiText, maskPiiInAnswers, saveTransparencyReport, appendComplianceAuditEvent } from '../services/compliance';

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
  extra?: Record<string, unknown>,
) {
  await writeGenerationProgress(sessionId, runId, {
    type: 'progress',
    sessionId,
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

async function getLatestDiscoveryCoverage(sessionId: string, accountId: string) {
  const conversation = await entityGet<{ turns?: Array<Record<string, any>> }>(KEYS.userConversations(accountId, sessionId));
  const rawTurns = conversation?.turns;
  const turns = Array.isArray(rawTurns) ? rawTurns : [];
  const latestClarifyTurn = [...turns]
    .reverse()
    .find((turn) => turn?.turnType === 'clarify' && turn?.clarifyContext?.discoveryCoverage);
  return latestClarifyTurn?.clarifyContext?.discoveryCoverage;
}

async function getLatestDiscoveryTranscript(sessionId: string, accountId: string) {
  const conversation = await entityGet<{ turns?: Array<Record<string, any>> }>(KEYS.userConversations(accountId, sessionId));
  const rawTurns = conversation?.turns;
  const turns = Array.isArray(rawTurns) ? rawTurns : [];
  const latestClarifyTurn = [...turns]
    .reverse()
    .find((turn) => turn?.turnType === 'clarify' && turn?.clarifyContext?.discoveryTranscript?.length);
  return latestClarifyTurn?.clarifyContext?.discoveryTranscript;
}

export async function handler(event: { body: GenerationEvent }) {
  const { runId, sessionId, accountId, requirement, clarifyAnswers, attachmentText, license, config: eventConfig, projectKey } = event.body;

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
    const maskedAnswers = maskPiiInAnswers(clarifyAnswers ?? [], piiEnabled);
    const reasoningMode = event.body.reasoningMode ?? config.aiExecutionPolicy.defaultReasoningMode;
    const outputMode = event.body.outputMode ?? config.aiExecutionPolicy.defaultOutputMode;
    const retrievalBudget = reasoningMode === 'deep'
      ? { wiTopK: 24, wiMaxChars: 70000, contextTimeoutMs: 45000 }
      : { wiTopK: 8, wiMaxChars: 25000, contextTimeoutMs: 25000 };
    const projectLabel = projectKey && projectKey !== '*' ? projectKey : 'workspace';

    await sendProgress(sessionId, runId, `Loading context for ${projectLabel}…`);

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
      withTimeoutFallback(
        findSimilarStoriesWithUsage(maskedRequirement.text, config, projectKey),
        retrievalBudget.contextTimeoutMs,
        { stories: [], tokenUsage: { input: 0, output: 0, total: 0, byStage: {} } },
        'similar stories',
      ),
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
    const referenceContextText = [referenceExamplesResult.text, formatSimilarStoriesText(similarStories, 12)]
      .filter(Boolean)
      .join('\n\n---\n\n');
    const contextParts: string[] = [];
    if (similarStories.length > 0) contextParts.push(`${similarStories.length} related stor${similarStories.length !== 1 ? 'ies' : 'y'}`);
    if (wiContext.docs.length > 0) contextParts.push(`${wiContext.docs.length} work instruction${wiContext.docs.length !== 1 ? 's' : ''}`);
    if (referenceExamplesResult.count > 0) contextParts.push(`${referenceExamplesResult.count} reference example${referenceExamplesResult.count !== 1 ? 's' : ''}`);
    const contextSummary = contextParts.length > 0 ? contextParts.join(', ') : 'no prior context';
    await sendProgress(sessionId, runId, `Context loaded (${contextSummary}).`);

    await sendProgress(sessionId, runId, 'Generating features and acceptance requirements...');

    const result = await generateFeatures({
      requirement,
      clarifyAnswers: maskedAnswers.answers,
      attachmentText: maskedAttachment.text,
      similarStoriesText: referenceContextText,
      wiContextText: wiContext.text,
      config,
      reasoningMode,
      outputMode,
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
      similarStoriesCount: similarStories.length,
      referencedSimilarStories: similarStories.slice(0, 12).map((item) => ({
        key: item.key,
        summary: item.summary,
        relevanceScore: item.relevanceScore,
        url: item.url,
      })),
      discoveryCoverage: latestDiscoveryCoverage,
      discoveryTranscript: latestDiscoveryTranscript,
      tokenUsage: result.tokenUsage,
      wiDocsCount: wiContext.docs.length,
      referencedWiDocs: wiContext.docs.slice(0, 12).map((doc) => ({
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
        reasoningMode,
        outputMode,
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
            'Generated features and acceptance requirements in a single prompt-driven pass.',
            `Applied ${wiContext.docs.length} work instruction documents and ${similarStories.length} backlog references.`,
            `Produced ${result.features.length} feature${result.features.length === 1 ? '' : 's'} with validation checks after generation.`,
          ],
          contextUsage: {
            similarStoriesCount: similarStories.length,
            wiDocsCount: wiContext.docs.length,
            domainRolesCount: config.domainRoles?.length ?? 0,
            reasoningMode,
            outputMode,
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
          reasoningMode,
          outputMode,
          featureCount: result.features.length,
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

    const indexKey = KEYS.userConversationIndex(accountId);
    const index = await entityGet<ConvIndex[]>(indexKey) ?? [];
    const entry = index.find((e) => e.sessionId === sessionId);
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
    const existing = index.find((e) => e.sessionId === sessionId);
    if (existing) {
      existing.updatedAt = new Date().toISOString();
      existing.turnCount = (existing.turnCount ?? 0) + 1;
    } else {
      index.unshift({ sessionId, title, updatedAt: new Date().toISOString(), turnCount: 1 });
    }
    await entitySet(indexKey, index.slice(0, 100));
  } catch {
    // ignore
  }
}
