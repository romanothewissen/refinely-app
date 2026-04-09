/**
 * Forge Queue Consumer: async clarifying question generation.
 *
 * Runs with 900s timeout — allows slow thinking models (e.g. Gemini 2.5 Pro)
 * to generate high-quality clarifying questions without hitting the 25s
 * resolver limit.
 *
 * Result is stored in Forge Storage; the frontend polls getClarifyResult.
 */

import { ClarifyContextMeta, ClarifyEvent, ClarifyFailureReasonCode, ClarifyProgressPayload } from '../types';
import { ClarifyDiscoveryError, generateClarifyingQuestions } from '../core/story-generator';
import { extractDiscoverySignals } from '../core/discovery';
import { formatSimilarStoriesText } from '../core/similar-stories';
import { getEffectiveTier } from '../services/billing';
import { entityGet, entitySet, KEYS } from '../services/cache';
import { appendComplianceAuditEvent, maskPiiText, mergePiiMaskingStats, saveTransparencyReport } from '../services/compliance';
import { resolveEffectiveGeneratorConfig } from '../services/model-strategy';
import { recordProjectActivity } from '../services/project-activity';
import {
  buildCombinedDomainContext,
  getCombinedPersonaRoles,
  normalizeProjectKeys,
  resolvePrimaryProjectKey,
  retrieveScopedSimilarStories,
  retrieveScopedWiContext,
  summarizeReferencedSimilarStories,
  summarizeReferencedWiSections,
} from '../services/project-selection';

/**
 * When the user provides only an attachment (empty requirement), fall back to
 * using the first 600 chars of the attachment as the BM25 retrieval query.
 */
function deriveRetrievalQuery(requirement: string, attachmentText: string): string {
  const requirementText = requirement?.trim() ?? '';
  const attachmentSnippet = (attachmentText?.trim() ?? '').slice(0, 600).replace(/\s+/g, ' ');
  const signalContext = extractDiscoverySignals([requirementText, attachmentSnippet]).join(' ').slice(0, 250);
  if (requirementText.length >= 30) return [requirementText, signalContext].filter(Boolean).join(' ').slice(0, 900).trim();
  return [requirementText, signalContext, attachmentSnippet].filter(Boolean).join(' ').slice(0, 900).trim();
}
export async function handler(event: { body: ClarifyEvent }) {
  const { sessionId, accountId, requirement, inputSignature, attachmentText, license, config: eventConfig, projectKey, projectKeys } = event.body;
  const selectedProjectKeys = normalizeProjectKeys(projectKey, projectKeys);
  const config = {
    ...eventConfig,
    generatorConfig: resolveEffectiveGeneratorConfig(eventConfig.generatorConfig),
    domainContext: buildCombinedDomainContext(eventConfig, selectedProjectKeys),
    domainRoles: getCombinedPersonaRoles(eventConfig, selectedProjectKeys).map((row) => row.role).filter(Boolean),
    tier: getEffectiveTier(eventConfig, { license }),
  };

  try {
    const piiEnabled = Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled);
    const maskedRequirement = maskPiiText(requirement, piiEnabled);
    const maskedAttachment = maskPiiText(attachmentText ?? '', piiEnabled);
    await sendClarifyProgress(sessionId, 'Reading project guidance, work instructions, and related stories…', inputSignature, {
      stage: 'context',
      sources: {
        projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
        projectCount: selectedProjectKeys.length,
        attachmentIncluded: Boolean(attachmentText?.trim()),
        domainContextApplied: Boolean(config.domainContext?.trim()),
      },
    });
    const [wiContext, similarStories] = await Promise.all([
      config.wiConfig.enabled
        ? retrieveScopedWiContext(deriveRetrievalQuery(maskedRequirement.text, maskedAttachment.text), 4, 20000, selectedProjectKeys)
        : Promise.resolve({ text: '', docs: [], chunks: [] }),
      config.tier !== 'free'
        ? retrieveScopedSimilarStories({
            requirement: maskedRequirement.text,
            attachmentText: maskedAttachment.text,
            config,
            projectKeys: selectedProjectKeys,
            maxResults: 8,
          })
        : Promise.resolve([]),
    ]);

    if (await isWorkflowCancelled(sessionId)) {
      await markCancelled(sessionId, inputSignature);
      return;
    }

    await sendClarifyProgress(sessionId, 'Assessing scope, ambiguity, and question budget…', inputSignature, {
      stage: 'assessment',
      sources: {
        projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
        projectCount: selectedProjectKeys.length,
        attachmentIncluded: Boolean(attachmentText?.trim()),
        domainContextApplied: Boolean(config.domainContext?.trim()),
        wiDocsCount: wiContext.docs.length,
        similarStoriesCount: similarStories.length,
      },
    });
    const clarifyStartedAt = Date.now();
    const { questions, tokenUsage, ambiguityAssessment, discoveryProfile, sizingContract } = await generateClarifyingQuestions({
      requirement: maskedRequirement.text,
      attachmentText: maskedAttachment.text,
      wiContextText: wiContext.text,
      similarStoriesText: formatSimilarStoriesText(similarStories, 8),
      config,
      onTriageComplete: async (assessment) => {
        const questionText = assessment.questionPlan.target > 0
          ? `targeting about ${assessment.questionPlan.target} questions`
          : 'letting the discovery model decide how many questions are actually needed';
        await sendClarifyProgress(
          sessionId,
          `Discovery is sizing the ambiguity, ${questionText}, with ${assessment.clarity} clarity so far…`,
          inputSignature,
          {
            stage: 'question_generation',
            assessment,
            sizingContract: assessment.shape && assessment.complexity && typeof assessment.featureTarget === 'number' && assessment.arDepth
              ? ({
                  shape: assessment.shape,
                  complexity: assessment.complexity,
                  featureTarget: assessment.featureTarget,
                  arDepth: assessment.arDepth,
                  arTarget: assessment.arTarget,
                  estimatedQuestions: assessment.estimatedQuestions ?? assessment.questionPlan.target,
                } as const)
              : undefined,
            sources: {
              projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
              projectCount: selectedProjectKeys.length,
              attachmentIncluded: Boolean(attachmentText?.trim()),
              domainContextApplied: Boolean(config.domainContext?.trim()),
              wiDocsCount: wiContext.docs.length,
              similarStoriesCount: similarStories.length,
            },
          },
        );
      },
    });
    const initialClarifyDurationMs = Date.now() - clarifyStartedAt;

    if (await isWorkflowCancelled(sessionId)) {
      await markCancelled(sessionId, inputSignature);
      return;
    }

    await sendClarifyProgress(sessionId, 'Finalizing discovery questions and coverage gaps…', inputSignature, {
      stage: 'finalize',
      sizingContract,
      discoveryProfile,
      ambiguityAssessment: {
        ...ambiguityAssessment,
        generatedQuestions: questions.length,
      },
      sources: {
        projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
        projectCount: selectedProjectKeys.length,
        attachmentIncluded: Boolean(attachmentText?.trim()),
        domainContextApplied: Boolean(config.domainContext?.trim()),
        wiDocsCount: wiContext.docs.length,
        similarStoriesCount: similarStories.length,
      },
    });
    const clarifyContext: ClarifyContextMeta = {
      projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
      projectKeys: selectedProjectKeys,
      projectCount: selectedProjectKeys.length,
      domainRolesUsed: config.domainRoles ?? [],
      discoveryStatus: questions.length > 0 ? 'needs_clarification' : 'ready_for_generation',
      domainContextApplied: Boolean(config.domainContext?.trim()),
      attachmentIncluded: Boolean(attachmentText?.trim()),
      similarStoriesCount: similarStories.length,
      referencedSimilarStories: summarizeReferencedSimilarStories(similarStories.slice(0, 12)),
      sizingContract,
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
      referencedWiSections: summarizeReferencedWiSections(wiContext.chunks.slice(0, 8)),
    };

    await saveClarifyTurn(sessionId, accountId, maskedRequirement.text, clarifyContext, inputSignature);
    if (questions.length === 0) {
      console.info('[clarify-queue] discovery completed without clarifying questions', {
        sessionId,
        projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
      });
    }
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
          questions.length > 0
            ? `Generated ${questions.length} initial discovery questions with a ${discoveryProfile.followupCap}-question follow-up cap.`
            : 'Discovery determined no clarifying questions were needed before generation.',
          `Discovery profile: ${discoveryProfile.scope} scope, ${discoveryProfile.complexity} complexity, ${discoveryProfile.ambiguity} ambiguity.`,
        ],
        contextUsage: {
          similarStoriesCount: similarStories.length,
          wiDocsCount: wiContext.docs.length,
          ambiguityScore: ambiguityAssessment.score,
          initialClarifyDurationMs,
        },
        tokenUsage,
        piiMasking: mergePiiMaskingStats(maskedRequirement.stats, maskedAttachment.stats),
      });
    }
    await appendComplianceAuditEvent({
      actorAccountId: accountId,
      category: 'runtime',
      action: 'CLARIFY_WORKFLOW_EXECUTED',
      details: { sessionId, projectKey, model: config.generatorConfig.clarifyModel },
      enabled: Boolean(config.compliance?.enabled && config.compliance?.auditTrailEnabled),
    });
    await recordProjectActivity({
      action: 'clarify',
      projectKeys: selectedProjectKeys,
      projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
      sessionId,
      model: config.generatorConfig.clarifyModel,
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
      contextMeta: buildBlockedClarifyContext(resolvePrimaryProjectKey(projectKey, projectKeys), failureReasonCode),
      ...(inputSignature ? { inputSignature } : {}),
      updatedAt: Date.now(),
    });
  }
}

async function sendClarifyProgress(
  sessionId: string,
  message: string,
  inputSignature?: string,
  payload?: ClarifyProgressPayload,
) {
  await entitySet(KEYS.clarifyProgress(sessionId), {
    type: 'progress',
    sessionId,
    ...(inputSignature ? { inputSignature } : {}),
    message,
    ...(payload ? { payload } : {}),
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
    discoveryStatus: 'discovery_failed',
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
