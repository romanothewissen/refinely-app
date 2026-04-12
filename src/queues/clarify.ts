/**
 * Forge Queue Consumer: async clarifying question generation.
 *
 * Runs with 900s timeout — allows slow thinking models (e.g. Gemini 2.5 Pro)
 * to generate high-quality clarifying questions without hitting the 25s
 * resolver limit.
 *
 * Result is stored in Forge Storage; the frontend polls getClarifyResult.
 */

import { ClarifyContextMeta, ClarifyEvent, ClarifyFailureDiagnostics, ClarifyFailureReasonCode, ClarifyProgressPayload } from '../types';
import { assessRequirementWithLlm, buildClarifyFailureDiagnostics, ClarifyDiscoveryError, generateClarifyingQuestions } from '../core/story-generator';
import { formatSimilarStoriesText } from '../core/similar-stories';
import { getEffectiveTier } from '../services/billing';
import { entityGet, entitySet, KEYS } from '../services/cache';
import { appendComplianceAuditEvent, maskPiiInAnswers, maskPiiText, mergePiiMaskingStats, saveTransparencyReport } from '../services/compliance';
import { resolveEffectiveGeneratorConfig } from '../services/model-strategy';
import { recordProjectActivity } from '../services/project-activity';
import { getPipelineAuditWriter, isPipelineAuditRequested, runWithPipelineAuditContext } from '../services/pipeline-audit-context';
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
import { buildTriageEnrichedWiQuery, deriveRetrievalQuery, mergeWiContextResults } from '../services/retrieval-query';

const PROGRESS_HEARTBEAT_MS = 15000;

export async function handler(event: { body: ClarifyEvent }) {
  const { sessionId, accountId, requirement, inputSignature, attachmentText, license, config: eventConfig, projectKey, projectKeys, priorAnswers } = event.body;
  const selectedProjectKeys = normalizeProjectKeys(projectKey, projectKeys);
  const config = {
    ...eventConfig,
    generatorConfig: resolveEffectiveGeneratorConfig(eventConfig.generatorConfig),
    domainContext: buildCombinedDomainContext(eventConfig, selectedProjectKeys),
    domainRoles: getCombinedPersonaRoles(eventConfig, selectedProjectKeys).map((row) => row.role).filter(Boolean),
    tier: getEffectiveTier(eventConfig, { license }),
  };
  const auditMeta = isPipelineAuditRequested(config, event.body.pipelineAudit, event.body.auditRunId)
    ? { sessionId, auditRunId: event.body.auditRunId!, accountId }
    : null;

  const exec = async () => {
  let currentProgress: { message?: string; payload?: ClarifyProgressPayload } = {};
  let stopHeartbeat: (() => void) | null = null;

  const sendProgress = async (
    message: string,
    payload?: ClarifyProgressPayload,
  ) => {
    currentProgress = { message, payload };
    await sendClarifyProgress(sessionId, message, inputSignature, payload);
  };

  try {
    const piiEnabled = Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled);
    const maskedRequirement = maskPiiText(requirement, piiEnabled);
    const maskedAttachment = maskPiiText(attachmentText ?? '', piiEnabled);
    const maskedPriorAnswers = maskPiiInAnswers(priorAnswers ?? [], piiEnabled);
    const retrievalAnswers = maskedPriorAnswers.answers;
    const broadWiTopK = Math.min(Math.max(1, config.wiConfig.topKChunks), 8);
    const broadWiMaxChars = config.wiConfig.maxChars;
    await sendProgress('Reading project guidance, work instructions, and related stories…', {
      stage: 'context',
      sources: {
        projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
        projectCount: selectedProjectKeys.length,
        attachmentIncluded: Boolean(attachmentText?.trim()),
        domainContextApplied: Boolean(config.domainContext?.trim()),
      },
    });
    stopHeartbeat = startClarifyProgressHeartbeat(sessionId, inputSignature, () => currentProgress);
    getPipelineAuditWriter()?.setPhase('clarify.triage');
    const triagePromise = assessRequirementWithLlm({
      requirement: maskedRequirement.text,
      generatorConfig: config.generatorConfig,
      tier: config.tier,
      providerOpts: {
        provider: config.generatorConfig.provider,
        geminiApiKey: config.generatorConfig.geminiApiKey,
        geminiBaseUrl: config.generatorConfig.geminiBaseUrl,
        openaiApiKey: config.generatorConfig.openaiApiKey,
        openaiBaseUrl: config.generatorConfig.openaiBaseUrl,
        azureOpenAIApiKey: config.generatorConfig.azureOpenAIApiKey,
        azureOpenAIBaseUrl: config.generatorConfig.azureOpenAIBaseUrl,
        azureOpenAIApiVersion: config.generatorConfig.azureOpenAIApiVersion,
        modelCatalogs: config.generatorConfig.modelCatalogs,
        piiMaskingEnabled: piiEnabled,
      },
    });

    const [wiBroad, similarStories, precomputedTriage] = await Promise.all([
      config.wiConfig.enabled
        ? retrieveScopedWiContext(
            deriveRetrievalQuery(maskedRequirement.text, maskedAttachment.text, retrievalAnswers),
            broadWiTopK,
            broadWiMaxChars,
            selectedProjectKeys,
          )
        : Promise.resolve({ text: '', docs: [], chunks: [] }),
      config.tier !== 'free'
        ? retrieveScopedSimilarStories({
            requirement: deriveRetrievalQuery(maskedRequirement.text, maskedAttachment.text, retrievalAnswers),
            attachmentText: maskedAttachment.text,
            clarifyAnswers: retrievalAnswers,
            config,
            projectKeys: selectedProjectKeys,
            maxResults: 8,
          })
        : Promise.resolve([]),
      triagePromise,
    ]);

    let wiContext = wiBroad;
    if (config.wiConfig.enabled && precomputedTriage) {
      const narrowQuery = buildTriageEnrichedWiQuery(precomputedTriage);
      if (narrowQuery.trim()) {
        try {
          const narrowWi = await retrieveScopedWiContext(
            narrowQuery,
            Math.min(4, Math.max(2, config.wiConfig.topKChunks)),
            Math.min(12000, config.wiConfig.maxChars),
            selectedProjectKeys,
          );
          if (narrowWi.text.trim()) {
            wiContext = mergeWiContextResults(
              wiContext,
              narrowWi,
              Math.min(20000, config.wiConfig.maxChars),
            );
          }
        } catch {
          // keep broad WI only
        }
      }
    }

    if (await isWorkflowCancelled(sessionId)) {
      await markCancelled(sessionId, inputSignature);
      return;
    }

    await sendProgress('Assessing scope, ambiguity, and question budget…', {
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
    getPipelineAuditWriter()?.setPhase('clarify.questions');
    const { questions, tokenUsage, ambiguityAssessment, discoveryProfile, advisoryTriage, sizingContract } = await generateClarifyingQuestions({
      requirement: maskedRequirement.text,
      attachmentText: maskedAttachment.text,
      wiContextText: wiContext.text,
      similarStoriesText: formatSimilarStoriesText(similarStories, 8),
      config,
      wiPromptSliceMaxChars: Math.min(20000, config.wiConfig.maxChars),
      precomputedTriage,
      onTriageComplete: async (assessment) => {
        const questionText = typeof assessment.discoveryForecast?.recommendedInitialCount === 'number'
          ? `with an early forecast of about ${assessment.discoveryForecast.recommendedInitialCount} questions`
          : 'letting the discovery model decide how many questions are actually needed';
        await sendProgress(
          `Discovery is sizing the ambiguity, ${questionText}, from the unresolved business logic it still sees…`,
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
                  estimatedQuestions: assessment.estimatedQuestions ?? assessment.discoveryForecast?.recommendedInitialCount ?? 0,
                } as const)
              : undefined,
            advisoryTriage: assessment.deliveryForecast && assessment.discoveryForecast
              ? {
                  reasoning: assessment.reasoning ?? '',
                  confidence: assessment.confidence ?? 'medium',
                  deliveryForecast: assessment.deliveryForecast,
                  discoveryForecast: assessment.discoveryForecast,
                }
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

    await sendProgress('Finalizing discovery questions and coverage gaps…', {
      stage: 'finalize',
      sizingContract,
      advisoryTriage,
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
      advisoryTriage,
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
        piiMasking: mergePiiMaskingStats(maskedRequirement.stats, maskedAttachment.stats, maskedPriorAnswers.stats),
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

    const auditWriter = getPipelineAuditWriter();
    if (auditWriter) {
      const similarStoriesText = formatSimilarStoriesText(similarStories, 8);
      try {
        await auditWriter.flushMerge({
          accountId,
          mergeHeader: {
            primaryProjectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
            projectKeys: selectedProjectKeys,
            generatorModels: {
              triageModel: config.generatorConfig.triageModel,
              clarifyModel: config.generatorConfig.clarifyModel,
            },
            piiMaskingEnabled: piiEnabled,
            piiMaskingStats: mergePiiMaskingStats(maskedRequirement.stats, maskedAttachment.stats, maskedPriorAnswers.stats),
          },
          userInputs: {
            requirement: maskedRequirement.text,
            attachmentText: maskedAttachment.text,
          },
          discoveryContextClarify: {
            wiContextText: wiContext.text,
            similarStoriesText,
            domainContext: config.domainContext,
            domainRoles: config.domainRoles,
          },
          clarify: {
            questions,
            contextMeta: clarifyContext,
            completedAt: new Date().toISOString(),
          },
          completePhase: 'clarify',
        });
      } catch (auditErr) {
        console.warn('[clarify-queue] pipeline audit merge failed:', auditErr);
      }
    }

    await entitySet(KEYS.clarifyProgress(sessionId), {
      type: 'complete',
      questions,
      contextMeta: clarifyContext,
      ...(inputSignature ? { inputSignature } : {}),
      updatedAt: Date.now(),
    });
  } catch (err) {
    const auditWriterErr = getPipelineAuditWriter();
    if (auditWriterErr) {
      try {
        await auditWriterErr.flushMerge({
          accountId,
          mergeHeader: {
            primaryProjectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
            projectKeys: selectedProjectKeys,
          },
        });
      } catch (auditErr) {
        console.warn('[clarify-queue] pipeline audit merge (error path) failed:', auditErr);
      }
    }
    console.error('[clarify-queue] Error:', err);
    if (await isWorkflowCancelled(sessionId)) {
      await markCancelled(sessionId, inputSignature);
      return;
    }
    const failureReasonCode: ClarifyFailureReasonCode =
      err instanceof ClarifyDiscoveryError
        ? err.reasonCode
        : 'queue_error';
    const failureDiagnostics: ClarifyFailureDiagnostics =
      err instanceof ClarifyDiscoveryError
        ? err.diagnostics
        : buildClarifyFailureDiagnostics('queue_error', {
            technicalSummary: err instanceof Error ? err.message : 'Clarify failed',
          });
    const message = err instanceof ClarifyDiscoveryError
      ? err.message
      : 'Discovery could not prepare clarifying questions.';
    await entitySet(KEYS.clarifyProgress(sessionId), {
      type: 'blocked',
      error: message,
      reasonCode: failureReasonCode,
      contextMeta: buildBlockedClarifyContext(
        resolvePrimaryProjectKey(projectKey, projectKeys),
        failureReasonCode,
        failureDiagnostics,
      ),
      ...(inputSignature ? { inputSignature } : {}),
      updatedAt: Date.now(),
    });
  } finally {
    stopHeartbeat?.();
  }
  };

  if (auditMeta) {
    return runWithPipelineAuditContext(auditMeta, exec);
  }
  return exec();
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

function startClarifyProgressHeartbeat(
  sessionId: string,
  inputSignature: string | undefined,
  getCurrentProgress: () => { message?: string; payload?: ClarifyProgressPayload },
) {
  let stopped = false;
  let inFlight = false;
  const timer = setInterval(() => {
    const current = getCurrentProgress();
    if (stopped || inFlight || !current.message) return;
    inFlight = true;
    void sendClarifyProgress(sessionId, current.message, inputSignature, current.payload).finally(() => {
      inFlight = false;
    });
  }, PROGRESS_HEARTBEAT_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
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

export function buildBlockedClarifyContext(
  projectKey: string,
  failureReasonCode: ClarifyFailureReasonCode,
  failureDiagnostics?: ClarifyFailureDiagnostics,
): ClarifyContextMeta {
  return {
    projectKey,
    domainRolesUsed: [],
    discoveryStatus: 'discovery_failed',
    failureReasonCode,
    ...(failureDiagnostics ? { failureDiagnostics } : {}),
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
