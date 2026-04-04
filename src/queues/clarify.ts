/**
 * Forge Queue Consumer: async clarifying question generation.
 *
 * Runs with 900s timeout — allows slow thinking models (e.g. Gemini 2.5 Pro)
 * to generate high-quality clarifying questions without hitting the 25s
 * resolver limit.
 *
 * Result is stored in Forge Storage; the frontend polls getClarifyResult.
 */

import { ClarifyContextMeta, ClarifyEvent, ClarifyFailureReasonCode } from '../types';
import { ClarifyDiscoveryError, generateClarifyingQuestions } from '../core/story-generator';
import { retrieveWiContext } from '../core/wi-ingestion';
import { findSimilarStories, formatSimilarStoriesText } from '../core/similar-stories';
import { getEffectiveTier } from '../services/billing';
import { entityGet, entitySet, KEYS } from '../services/cache';
import { appendComplianceAuditEvent, maskPiiText, saveTransparencyReport } from '../services/compliance';

/**
 * When the user provides only an attachment (empty requirement), fall back to
 * using the first 600 chars of the attachment as the BM25 retrieval query.
 */
function deriveRetrievalQuery(requirement: string, attachmentText: string): string {
  if ((requirement?.trim().length ?? 0) >= 30) return requirement.trim();
  const att = attachmentText?.trim() ?? '';
  return att ? att.slice(0, 600).replace(/\s+/g, ' ') : requirement;
}

function buildWiExcerpt(text: string, maxChars = 180): string {
  const compact = (text || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars).trimEnd()}...`;
}

export async function handler(event: { body: ClarifyEvent }) {
  const { sessionId, accountId, requirement, inputSignature, attachmentText, license, config: eventConfig, projectKey } = event.body;
  
  // Resolve project-specific context
  const relevantContext = eventConfig.domainContexts?.find(c => c.projectKey === projectKey) 
    || eventConfig.domainContexts?.find(c => c.projectKey === '*')
    || { context: eventConfig.domainContext || '' };
    
  const config = { 
    ...eventConfig, 
    domainContext: relevantContext.context,
    tier: getEffectiveTier(eventConfig, { license }) 
  };

  try {
    const piiEnabled = Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled);
    const maskedRequirement = maskPiiText(requirement, piiEnabled);
    const maskedAttachment = maskPiiText(attachmentText ?? '', piiEnabled);
    await sendClarifyProgress(sessionId, 'Reading project guidance, work instructions, and related stories…', inputSignature);
    const [wiContext, similarStories] = await Promise.all([
      config.wiConfig.enabled
        ? retrieveWiContext(deriveRetrievalQuery(maskedRequirement.text, maskedAttachment.text), 4, 20000, projectKey)
        : Promise.resolve({ text: '', docs: [], chunks: [] }),
      config.tier !== 'free'
        ? findSimilarStories({
            requirement: maskedRequirement.text,
            attachmentText: maskedAttachment.text,
            config,
            projectKey,
          })
        : Promise.resolve([]),
    ]);

    if (await isWorkflowCancelled(sessionId)) {
      await markCancelled(sessionId, inputSignature);
      return;
    }

    await sendClarifyProgress(sessionId, 'Drafting clarifying questions from the gathered context…', inputSignature);
    const clarifyStartedAt = Date.now();
    const { questions, tokenUsage, ambiguityAssessment, discoveryProfile } = await generateClarifyingQuestions({
      requirement: maskedRequirement.text,
      attachmentText: maskedAttachment.text,
      wiContextText: wiContext.text,
      similarStoriesText: formatSimilarStoriesText(similarStories, 8),
      config,
    });
    const initialClarifyDurationMs = Date.now() - clarifyStartedAt;

    if (await isWorkflowCancelled(sessionId)) {
      await markCancelled(sessionId, inputSignature);
      return;
    }

    await sendClarifyProgress(sessionId, 'Finalizing discovery questions…', inputSignature);
    const clarifyContext: ClarifyContextMeta = {
      projectKey,
      domainRolesUsed: [],
      discoveryStatus: 'ready',
      domainContextApplied: Boolean(config.domainContext?.trim()),
      attachmentIncluded: Boolean(attachmentText?.trim()),
      similarStoriesCount: similarStories.length,
      referencedSimilarStories: similarStories.slice(0, 12).map(item => ({
        key: item.key,
        summary: item.summary,
        relevanceScore: item.relevanceScore,
        url: item.url,
        jiraIssueUrl: item.url,
      })),
      discoveryProfile,
      ambiguityAssessment: {
        ...ambiguityAssessment,
        generatedQuestions: questions.length,
      },
      roundsCompleted: 0,
      initialQuestionCount: questions.length,
      followupQuestionCount: 0,
      totalQuestionCount: questions.length,
      followupTriggered: false,
      initialClarifyDurationMs,
      totalDiscoveryDurationMs: initialClarifyDurationMs,
      finalSufficiency: {
        evaluated: false,
        sufficient: null,
        roundEvaluated: 0,
        missingCategoryKeys: discoveryProfile.missingCategoryKeys,
        reasonCodes: [],
      },
      tokenUsage,
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

    await saveClarifyTurn(sessionId, accountId, maskedRequirement.text, clarifyContext, inputSignature);
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
          `Generated ${questions.length} initial discovery questions with a ${discoveryProfile.followupCap}-question follow-up cap.`,
          `Discovery profile: ${discoveryProfile.scope} scope, ${discoveryProfile.complexity} complexity, ${discoveryProfile.ambiguity} ambiguity.`,
        ],
        contextUsage: {
          similarStoriesCount: similarStories.length,
          wiDocsCount: wiContext.docs.length,
          ambiguityScore: ambiguityAssessment.score,
          initialClarifyDurationMs,
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
      details: { sessionId, projectKey, model: config.generatorConfig.clarifyModel },
      enabled: Boolean(config.compliance?.enabled && config.compliance?.auditTrailEnabled),
    });

    await entitySet(KEYS.clarifyProgress(sessionId), {
      type: 'complete',
      questions,
      contextMeta: clarifyContext,
      ...(inputSignature ? { inputSignature } : {}),
      updatedAt: Date.now(),
    });
  } catch (err) {
    console.error('[clarify-queue] Error:', err);
    if (await isWorkflowCancelled(sessionId)) {
      await markCancelled(sessionId, inputSignature);
      return;
    }
    const failureReasonCode: ClarifyFailureReasonCode =
      err instanceof ClarifyDiscoveryError
        ? err.reasonCode
        : 'queue_error';
    const message = err instanceof Error ? err.message : 'Clarify failed';
    await entitySet(KEYS.clarifyProgress(sessionId), {
      type: 'blocked',
      error: message,
      reasonCode: failureReasonCode,
      contextMeta: buildBlockedClarifyContext(projectKey, failureReasonCode),
      ...(inputSignature ? { inputSignature } : {}),
      updatedAt: Date.now(),
    });
  }
}

async function sendClarifyProgress(sessionId: string, message: string, inputSignature?: string) {
  await entitySet(KEYS.clarifyProgress(sessionId), {
    type: 'progress',
    sessionId,
    ...(inputSignature ? { inputSignature } : {}),
    message,
    updatedAt: Date.now(),
  });
}

async function isWorkflowCancelled(sessionId: string): Promise<boolean> {
  const result = await entityGet<{ type?: string }>(KEYS.clarifyProgress(sessionId));
  return result?.type === 'cancelled';
}

async function markCancelled(sessionId: string, inputSignature?: string) {
  await entitySet(KEYS.clarifyProgress(sessionId), {
    type: 'cancelled',
    sessionId,
    ...(inputSignature ? { inputSignature } : {}),
    message: 'Clarifying questions cancelled.',
    updatedAt: Date.now(),
  });
}

function buildBlockedClarifyContext(
  projectKey: string,
  failureReasonCode: ClarifyFailureReasonCode,
): ClarifyContextMeta {
  return {
    projectKey,
    domainRolesUsed: [],
    discoveryStatus: 'blocked',
    failureReasonCode,
    roundsCompleted: 0,
    initialQuestionCount: 0,
    followupQuestionCount: 0,
    totalQuestionCount: 0,
    followupTriggered: false,
    finalSufficiency: {
      evaluated: false,
      sufficient: null,
      roundEvaluated: 0,
      missingCategoryKeys: [],
      reasonCodes: [failureReasonCode.toUpperCase()],
    },
  };
}

async function saveClarifyTurn(
  sessionId: string,
  accountId: string,
  requirement: string,
  clarifyContext: ClarifyContextMeta,
  inputSignature?: string,
) {
  try {
    const key = KEYS.userConversations(accountId, sessionId);
    const existing = await entityGet<{ turns: unknown[] }>(key) ?? { turns: [] };
    existing.turns.push({
      turnType: 'clarify',
      requirement,
      ...(inputSignature ? { inputSignature } : {}),
      features: [],
      similarStories: [],
      clarifyContext,
      tokenUsage: clarifyContext.tokenUsage,
      timestamp: new Date().toISOString(),
    });
    await entitySet(key, existing);
  } catch (err) {
    console.warn('[clarify-queue] Failed to save clarify turn:', err);
  }
}
