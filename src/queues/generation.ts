/**
 * Forge Queue Consumer: two-pass feature generation.
 *
 * Runs with 900s (15 min) timeout — handles the full generation pipeline
 * including gold standard fetching, WI context retrieval, pass 1 + pass 2.
 *
 * Progress is streamed back to the UI via Forge Realtime.
 */

import { GenerationContextMeta, GenerationEvent, SimilarStory, TokenUsageSummary } from '../types';
import { GenerationCancelledError, generateFeatures, generateSessionTitle } from '../core/story-generator';
import { findSimilarStories, formatSimilarStoriesText } from '../core/similar-stories';
import { fetchGoldExamples, formatGoldExamplesText } from '../core/gold-standard';
import { retrieveWiContext } from '../core/wi-ingestion';
import { recordGeneration, getEffectiveTier } from '../services/billing';
import { getConfig } from '../services/tenant-config';
import { entityGet, entitySet, KEYS } from '../services/cache';
import { maskPiiText, maskPiiInAnswers, saveTransparencyReport, appendComplianceAuditEvent } from '../services/compliance';

interface RealtimeEvent {
  type: 'progress' | 'complete' | 'error' | 'cancelled';
  sessionId: string;
  message?: string;
  pass?: 1 | 2;
  payload?: unknown;
}

const PROGRESS_HEARTBEAT_MS = 15000;

async function sendProgress(sessionId: string, message: string, pass?: 1 | 2) {
  await entitySet(KEYS.generationProgress(sessionId), {
    type: 'progress',
    sessionId,
    message,
    pass,
    updatedAt: Date.now(),
  } as RealtimeEvent);
}

function startProgressHeartbeat(
  sessionId: string,
  getCurrentProgress: () => { message?: string; pass?: 1 | 2 },
) {
  let stopped = false;
  let inFlight = false;
  const timer = setInterval(() => {
    const current = getCurrentProgress();
    if (stopped || inFlight || !current.message) return;
    inFlight = true;
    void sendProgress(sessionId, current.message, current.pass).finally(() => {
      inFlight = false;
    });
  }, PROGRESS_HEARTBEAT_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
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

function buildWiExcerpt(text: string, maxChars = 180): string {
  const compact = (text || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars).trimEnd()}...`;
}

export async function handler(event: { body: GenerationEvent }) {
  const { sessionId, accountId, requirement, clarifyAnswers, attachmentText, license, config: eventConfig, projectKey } = event.body;
  
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
  let stopHeartbeat: (() => void) | null = null;

  try {
    let currentProgress: { message?: string; pass?: 1 | 2 } = {};
    const updateProgress = async (message: string, pass?: 1 | 2) => {
      currentProgress = { message, pass };
      await sendProgress(sessionId, message, pass);
    };
    stopHeartbeat = startProgressHeartbeat(sessionId, () => currentProgress);
    const piiEnabled = Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled);
    const maskedRequirement = maskPiiText(requirement, piiEnabled);
    const maskedAttachment = maskPiiText(attachmentText ?? '', piiEnabled);
    const maskedAnswers = maskPiiInAnswers(clarifyAnswers ?? [], piiEnabled);
    const goldCount = relevantGoldSources.length;
    const projectLabel = projectKey && projectKey !== '*' ? projectKey : 'no project selected';
    await updateProgress(`Reading reference examples, work instructions, and related stories for ${projectLabel}…`);

    const [goldItems, wiContext, similarStories] = await Promise.all([
      goldCount
        ? fetchGoldExamples(config.goldSources, 8)
        : Promise.resolve([]),
      config.wiConfig.enabled
        ? retrieveWiContext(maskedRequirement.text, config.wiConfig.topKChunks, config.wiConfig.maxChars, projectKey)
        : Promise.resolve({ text: '', docs: [], chunks: [] }),
      config.tier !== 'free'
        ? findSimilarStories(maskedRequirement.text, config, projectKey)
        : Promise.resolve([]),
    ]);

    if (await isWorkflowCancelled(sessionId)) {
      await markCancelled(sessionId);
      return;
    }

    const goldExamplesText = formatGoldExamplesText(goldItems);
    const similarStoriesText = formatSimilarStoriesText(similarStories);

    // Progress: pass 1
    await updateProgress('Planning feature structure from gathered context…', 1);

    const result = await generateFeatures({
      requirement,
      clarifyAnswers: maskedAnswers.answers,
      attachmentText: maskedAttachment.text,
      goldExamplesText,
      similarStoriesText,
      wiContextText: wiContext.text,
      config,
      shouldCancel: () => isWorkflowCancelled(sessionId),
      onTriageComplete: async (triage) => {
        if (await isWorkflowCancelled(sessionId)) return;
        await updateProgress(`Assessed as ${triage.shape} scope, ${triage.complexity} complexity — targeting ~${triage.featureTarget} features with ${triage.arDepth} acceptance requirements`, 1);
      },
      onPass1Complete: async (featureCount) => {
        if (await isWorkflowCancelled(sessionId)) return;
        await updateProgress(`Writing acceptance requirements for ${featureCount} feature${featureCount !== 1 ? 's' : ''}…`, 2);
      },
      onArProgress: async (completed, total) => {
        if (await isWorkflowCancelled(sessionId)) return;
        await updateProgress(`Writing acceptance requirements: ${completed}/${total} features…`, 2);
      },
    });

    result.similarStories = similarStories;
    result.sessionId = sessionId;

    if (await isWorkflowCancelled(sessionId)) {
      await markCancelled(sessionId);
      return;
    }

    const generationContext: GenerationContextMeta = {
      projectKey,
      domainRolesUsed: config.domainRoles ?? [],
      domainContextApplied: Boolean(config.domainContext?.trim()),
      attachmentIncluded: Boolean(attachmentText?.trim()),
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
        jiraIssueUrl: item.url,
      })),
      tokenUsage: result.tokenUsage,
      wiDocsCount: wiContext.docs.length,
      referencedWiDocs: wiContext.docs.slice(0, 12).map(doc => ({
        docId: doc.docId,
        filename: doc.filename,
        chunkCount: doc.chunkCount,
      })),
      referencedWiSections: wiContext.chunks.slice(0, 8).map(chunk => ({
        docId: chunk.docId,
        filename: chunk.filename,
        chunkIndex: chunk.chunkIndex,
        excerpt: buildWiExcerpt(chunk.text),
      })),
    };
    result.generationContext = generationContext;

    if (await isWorkflowCancelled(sessionId)) {
      await markCancelled(sessionId);
      return;
    }

    // Record usage
    await recordGeneration();

    // Save to conversation history
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

    if (await isWorkflowCancelled(sessionId)) {
      await markCancelled(sessionId);
      return;
    }

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
          `Generated features using ${goldItems.length} curated examples and ${similarStories.length} backlog references.`,
          `Applied ${wiContext.docs.length} work instruction documents and ${config.domainRoles?.length ?? 0} roles.`,
          'Acceptance requirements were produced in a dedicated second pass for consistency.',
        ],
        contextUsage: {
          goldExamplesCount: goldItems.length,
          similarStoriesCount: similarStories.length,
          wiDocsCount: wiContext.docs.length,
          domainRolesCount: config.domainRoles?.length ?? 0,
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

    if (await isWorkflowCancelled(sessionId)) {
      await markCancelled(sessionId);
      return;
    }

    await appendComplianceAuditEvent({
      actorAccountId: accountId,
      category: 'runtime',
      action: 'GENERATION_WORKFLOW_EXECUTED',
      details: {
        sessionId,
        projectKey,
        model: config.generatorConfig.arModel,
      },
      enabled: Boolean(config.compliance?.enabled && config.compliance?.auditTrailEnabled),
    });

    if (await isWorkflowCancelled(sessionId)) {
      await markCancelled(sessionId);
      return;
    }

    // Generate session title (non-critical; should not fail the generation run)
    try {
      if (await isWorkflowCancelled(sessionId)) {
        await markCancelled(sessionId);
        return;
      }
      const title = await generateSessionTitle(maskedRequirement.text, config);
      if (await isWorkflowCancelled(sessionId)) {
        await markCancelled(sessionId);
        return;
      }
      await updateConversationTitle(sessionId, accountId, title);
    } catch (titleErr) {
      console.warn('[generation-queue] Title generation failed, using fallback title:', titleErr);
      await updateConversationTitle(sessionId, accountId, requirement.slice(0, 80));
    }

    if (await isWorkflowCancelled(sessionId)) {
      await markCancelled(sessionId);
      return;
    }

    // Write completed state to storage (frontend polls for this)
    await entitySet(KEYS.generationProgress(sessionId), {
      type: 'complete',
      sessionId,
      payload: result,
      updatedAt: Date.now(),
    } as RealtimeEvent);

  } catch (err) {
    if (await isWorkflowCancelled(sessionId) || err instanceof GenerationCancelledError || String((err as { name?: string })?.name ?? '') === 'GenerationCancelledError') {
      await markCancelled(sessionId);
      return;
    }
    console.error('[generation-queue] Error:', err);
    await entitySet(KEYS.generationProgress(sessionId), {
      type: 'error',
      sessionId,
      message: err instanceof Error ? err.message : 'Generation failed. Please try again.',
      updatedAt: Date.now(),
    } as RealtimeEvent);
  } finally {
    stopHeartbeat?.();
  }
}

async function isWorkflowCancelled(sessionId: string): Promise<boolean> {
  const progress = await entityGet<{ type?: string }>(KEYS.generationProgress(sessionId));
  return progress?.type === 'cancelled';
}

async function markCancelled(sessionId: string) {
  await entitySet(KEYS.generationProgress(sessionId), {
    type: 'cancelled',
    sessionId,
    message: 'Generation cancelled.',
    updatedAt: Date.now(),
  } as RealtimeEvent);
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
    await updateConversationIndex(sessionId, accountId, requirement.slice(0, 80));
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
