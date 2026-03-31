/**
 * Forge Queue Consumer: async clarifying question generation.
 *
 * Runs with 900s timeout — allows slow thinking models (e.g. Gemini 2.5 Pro)
 * to generate high-quality clarifying questions without hitting the 25s
 * resolver limit.
 *
 * Result is stored in Forge Storage; the frontend polls getClarifyResult.
 */

import { ClarifyContextMeta, ClarifyEvent } from '../types';
import { buildPlannerDecision } from '../core/planner';
import { generateClarifyingQuestions } from '../core/story-generator';
import { retrieveWiContext } from '../core/wi-ingestion';
import { fetchGoldExamples, formatGoldExamplesText } from '../core/gold-standard';
import { findSimilarStories, formatSimilarStoriesText } from '../core/similar-stories';
import { getEffectiveTier } from '../services/billing';
import { upsertAiSessionInsight } from '../services/ai-insights';
import { entityGet, entitySet, KEYS } from '../services/cache';
import { appendComplianceAuditEvent, maskPiiText, saveTransparencyReport } from '../services/compliance';

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

export async function handler(event: { body: ClarifyEvent }) {
  const { sessionId, accountId, requirement, attachmentText, license, config: eventConfig, projectKey } = event.body;
  
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
    const [wiContext, goldItems, similarStories] = await Promise.all([
      config.wiConfig.enabled
        ? retrieveWiContext(maskedRequirement.text, 4, 20000, projectKey)
        : Promise.resolve({ text: '', docs: [] }),
      config.goldSources.length
        ? fetchGoldExamples(config.goldSources, 6)
        : Promise.resolve([]),
      config.tier !== 'free'
        ? findSimilarStories(maskedRequirement.text, config, projectKey)
        : Promise.resolve([]),
    ]);

    const plannerDecision = buildPlannerDecision({
      requirement: maskedRequirement.text,
      attachmentText: maskedAttachment.text,
      wiContextText: wiContext.text,
      goldExamplesText: formatGoldExamplesText(goldItems, 6, 900, 900),
      similarStoriesText: formatSimilarStoriesText(similarStories, 8),
      reasoningMode: event.body.reasoningMode ?? config.aiExecutionPolicy.defaultReasoningMode,
      outputMode: event.body.outputMode ?? config.aiExecutionPolicy.defaultOutputMode,
      policy: config.aiExecutionPolicy,
    });

    const { questions, tokenUsage, ambiguityAssessment } = await generateClarifyingQuestions({
      requirement: maskedRequirement.text,
      attachmentText: maskedAttachment.text,
      wiContextText: wiContext.text,
      goldExamplesText: formatGoldExamplesText(goldItems, 6, 900, 900),
      similarStoriesText: formatSimilarStoriesText(similarStories, 8),
      config,
      plannerDecision,
    });

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
      tokenUsage,
      wiDocsCount: wiContext.docs.length,
      referencedWiDocs: wiContext.docs.slice(0, 12).map(doc => ({
        docId: doc.docId,
        filename: doc.filename,
        chunkCount: doc.chunkCount,
      })),
    };

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
          `Planner classified this request as ${plannerDecision.scopeMode} with ${plannerDecision.clarificationMode} discovery.`,
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

    await entitySet(KEYS.clarifyProgress(sessionId), {
      type: 'complete',
      questions,
      contextMeta: clarifyContext,
      updatedAt: Date.now(),
    });
  } catch (err) {
    console.error('[clarify-queue] Error:', err);
    await entitySet(KEYS.clarifyProgress(sessionId), {
      type: 'error',
      error: err instanceof Error ? err.message : 'Clarify failed',
      updatedAt: Date.now(),
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
    await updateConversationIndex(sessionId, accountId, requirement.slice(0, 80));
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
