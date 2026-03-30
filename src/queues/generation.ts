/**
 * Forge Queue Consumer: two-pass feature generation.
 *
 * Runs with 900s (15 min) timeout — handles the full generation pipeline
 * including gold standard fetching, WI context retrieval, pass 1 + pass 2.
 *
 * Progress is streamed back to the UI via Forge Realtime.
 */

import { GenerationContextMeta, GenerationEvent, SimilarStory } from '../types';
import { generateFeatures, generateSessionTitle } from '../core/story-generator';
import { findSimilarStories, formatSimilarStoriesText } from '../core/similar-stories';
import { fetchGoldExamples, formatGoldExamplesText } from '../core/gold-standard';
import { retrieveWiContext } from '../core/wi-ingestion';
import { recordGeneration, getEffectiveTier } from '../services/billing';
import { getConfig } from '../services/tenant-config';
import { entityGet, entitySet, KEYS } from '../services/cache';

interface RealtimeEvent {
  type: 'progress' | 'complete' | 'error';
  sessionId: string;
  message?: string;
  pass?: 1 | 2;
  payload?: unknown;
}

async function sendProgress(sessionId: string, message: string, pass?: 1 | 2) {
  await entitySet(KEYS.generationProgress(sessionId), {
    type: 'progress',
    sessionId,
    message,
    pass,
    updatedAt: Date.now(),
  } as RealtimeEvent);
}

export async function handler(event: { body: GenerationEvent }) {
  const { sessionId, accountId, requirement, clarifyAnswers, attachmentText, license, config: eventConfig, projectKey } = event.body;
  
  // Resolve project-specific context and filter gold sources
  const relevantContext = eventConfig.domainContexts?.find(c => c.projectKey === projectKey) 
    || eventConfig.domainContexts?.find(c => c.projectKey === '*')
    || { context: eventConfig.domainContext || '' };
    
  // STRICT PROJECT-LEVEL: Only sources that explicitly target this project. No global fallback.
  const relevantGoldSources = eventConfig.goldSources.filter(s => 
    s.targetProjects?.includes(projectKey)
  );
  
  const config = { 
    ...eventConfig, 
    domainContext: relevantContext.context,
    goldSources: relevantGoldSources,
    tier: getEffectiveTier(eventConfig, { license }) 
  };

  try {
    const goldCount = relevantGoldSources.length;
    await sendProgress(sessionId, `Found ${goldCount} reference examples for ${projectKey}. initializing…`);

    const [goldItems, wiContext, similarStories] = await Promise.all([
      goldCount
        ? fetchGoldExamples(config.goldSources, 8)
        : Promise.resolve([]),
      config.wiConfig.enabled
        ? retrieveWiContext(requirement, config.wiConfig.topKChunks, config.wiConfig.maxChars)
        : Promise.resolve(''),
      config.tier !== 'free'
        ? findSimilarStories(requirement, config)
        : Promise.resolve([]),
    ]);

    const goldExamplesText = formatGoldExamplesText(goldItems);
    const similarStoriesText = formatSimilarStoriesText(similarStories);

    // Progress: pass 1
    await sendProgress(sessionId, 'Decomposing requirement into features…', 1);

    const result = await generateFeatures({
      requirement,
      clarifyAnswers,
      attachmentText,
      goldExamplesText,
      similarStoriesText,
      wiContextText: wiContext,
      config,
      onPass1Complete: async (featureCount) => {
        await sendProgress(sessionId, `Writing acceptance criteria for ${featureCount} feature${featureCount !== 1 ? 's' : ''}…`, 2);
      },
    });

    result.similarStories = similarStories;
    result.sessionId = sessionId;
    const generationContext: GenerationContextMeta = {
      domainRolesUsed: config.domainRoles ?? [],
      goldExamplesCount: goldItems.length,
      referencedGoldExamples: goldItems.slice(0, 15).map(item => ({
        key: item.key,
        source: item.source,
        summary: item.summary,
      })),
    };
    result.generationContext = generationContext;

    // Record usage
    await recordGeneration();

    // Save to conversation history
    await saveConversationTurn(
      sessionId,
      accountId,
      requirement,
      result.features,
      similarStories,
      config.generatorConfig.arModel,
      generationContext,
    );

    // Generate session title (non-critical; should not fail the generation run)
    try {
      const title = await generateSessionTitle(requirement, config);
      await updateConversationTitle(sessionId, accountId, title);
    } catch (titleErr) {
      console.warn('[generation-queue] Title generation failed, using fallback title:', titleErr);
      await updateConversationTitle(sessionId, accountId, requirement.slice(0, 80));
    }

    // Write completed state to storage (frontend polls for this)
    await entitySet(KEYS.generationProgress(sessionId), {
      type: 'complete',
      sessionId,
      payload: result,
      updatedAt: Date.now(),
    } as RealtimeEvent);

  } catch (err) {
    console.error('[generation-queue] Error:', err);
    await entitySet(KEYS.generationProgress(sessionId), {
      type: 'error',
      sessionId,
      message: err instanceof Error ? err.message : 'Generation failed. Please try again.',
      updatedAt: Date.now(),
    } as RealtimeEvent);
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
