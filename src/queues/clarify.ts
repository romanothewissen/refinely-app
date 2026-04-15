/**
 * Forge Queue Consumer: async clarifying question generation.
 *
 * Runs with a long queue timeout so clarify models can reason without hitting
 * resolver limits. Results are persisted in Forge Storage for polling.
 */

import type {
  ClarifyContextMeta,
  ClarifyEvent,
  ClarifyFailureDiagnostics,
  ClarifyFailureReasonCode,
  ClarifyProgressPayload,
} from '../types';
import { extractActorSets } from '../core/story-assistant-default';
import { formatSimilarStoriesText } from '../core/similar-stories';
import { getEffectiveTier } from '../services/billing';
import { entityGet, entitySet, entitySetSmall, KEYS } from '../services/cache';
import { appendComplianceAuditEvent, maskPiiInAnswers, maskPiiText, mergePiiMaskingStats, saveTransparencyReport } from '../services/compliance';
import { buildStoryAssistantModelRoute, resolveEffectiveGeneratorConfig, resolveStoryAssistantPipelineProfile } from '../services/model-strategy';
import { getPipelineAuditWriter, isPipelineAuditRequested, runWithPipelineAuditContext } from '../services/pipeline-audit-context';
import { recordProjectActivity } from '../services/project-activity';
import {
  buildCombinedDomainContext,
  getCombinedPersonaRoles,
  normalizeProjectKeys,
  resolvePrimaryProjectKey,
} from '../services/project-selection';
import { deriveRetrievalQuery } from '../services/retrieval-query';
import { buildScopeContract } from '../core/story-assistant-default';
import { runStoryAssistantClarifyStage } from '../services/story-assistant-pipeline';
import { buildSharedPipelineEvidenceSignature, toSharedPipelineEvidenceBundle } from '../services/shared-pipeline-context';
import { runWithWiRetrievalCacheScope } from '../core/wi-ingestion';

const PROGRESS_HEARTBEAT_MS = 15000;

export async function handler(event: { body: ClarifyEvent }) {
  const {
    sessionId,
    accountId,
    requirement,
    inputSignature,
    attachmentText,
    license,
    config: eventConfig,
    projectKey,
    projectKeys,
    priorAnswers,
  } = event.body;

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
    const workflowStartedAt = Date.now();
    const queueWaitMs = Math.max(0, workflowStartedAt - Number(event.body.enqueuedAt ?? workflowStartedAt));
    const modelRoute = buildStoryAssistantModelRoute(config.generatorConfig);
    const pipelineProfile = resolveStoryAssistantPipelineProfile(config.generatorConfig);
    let currentProgress: { message?: string; payload?: ClarifyProgressPayload } = {};
    let stopHeartbeat: (() => void) | null = null;
    let firstProgressSentAt: number | null = null;

    const sendProgress = async (message: string, payload?: ClarifyProgressPayload) => {
      if (firstProgressSentAt == null) firstProgressSentAt = Date.now();
      currentProgress = { message, payload };
      await sendClarifyProgress(sessionId, message, inputSignature, payload);
    };

    try {
      const piiEnabled = Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled);
      const maskedRequirement = maskPiiText(requirement, piiEnabled);
      const maskedAttachment = maskPiiText(attachmentText ?? '', piiEnabled);
      const maskedPriorAnswers = maskPiiInAnswers(priorAnswers ?? [], piiEnabled);
      const retrievalAnswers = maskedPriorAnswers.answers;

      stopHeartbeat = startClarifyProgressHeartbeat(sessionId, inputSignature, () => currentProgress);
      await sendProgress('Reading shared evidence context for discovery…', {
        stage: 'context',
        sources: {
          projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
          projectCount: selectedProjectKeys.length,
          attachmentIncluded: Boolean(attachmentText?.trim()),
          domainContextApplied: Boolean(config.domainContext?.trim()),
        },
      });

      await sendProgress('Writing the business questions that are still genuinely ambiguous…', {
        stage: 'question_generation',
        sources: {
          projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
          projectCount: selectedProjectKeys.length,
          attachmentIncluded: Boolean(attachmentText?.trim()),
          domainContextApplied: Boolean(config.domainContext?.trim()),
        },
      });

      const clarifyStartedAt = Date.now();
      getPipelineAuditWriter()?.setPhase('clarify.questions');
      const { sharedContext, result } = await runStoryAssistantClarifyStage({
        requirement: maskedRequirement.text,
        attachmentText: maskedAttachment.text,
        priorAnswers: retrievalAnswers,
        config,
        projectKey,
        projectKeys,
      });
      const {
        questions,
        tokenUsage,
        ambiguityAssessment,
        discoveryProfile,
        discoveryAssessment,
        coverageQualityScore,
        coverageRetryTriggered,
        promptAssemblyMs,
      } = result;
      const initialClarifyDurationMs = Date.now() - clarifyStartedAt;

      if (await isWorkflowCancelled(sessionId)) {
        await markCancelled(sessionId, inputSignature);
        return;
      }

      await sendProgress('Finalizing discovery questions…', {
        stage: 'finalize',
        discoveryAssessment,
        discoveryProfile,
        coverageQualityScore,
        coverageRetryTriggered,
        ambiguityAssessment,
        latencyMs: {
          queueWaitMs,
          retrievalMs: sharedContext.timings.retrievalMs,
          wiInsightExtractionMs: sharedContext.timings.wiInsightExtractionMs,
          promptAssemblyMs,
          firstProgressEventMs: firstProgressSentAt == null ? undefined : Math.max(0, firstProgressSentAt - workflowStartedAt),
        },
        modelRoute,
        pipelineProfile,
        sources: {
          projectKey: sharedContext.projectKey,
          projectCount: sharedContext.projectCount,
          attachmentIncluded: sharedContext.sources.attachmentIncluded,
          domainContextApplied: sharedContext.sources.domainContextApplied,
          wiDocsCount: sharedContext.sources.wiDocsCount,
          linkedWiDocCount: sharedContext.sources.linkedWiDocCount,
          retrievedWiDocCount: sharedContext.sources.retrievedWiDocCount,
          retrievedWiChunkCount: sharedContext.sources.retrievedWiChunkCount,
          wiInsightCount: sharedContext.sources.wiInsightCount,
          similarStoriesCount: sharedContext.sources.similarStoriesCount,
        },
      });

      const clarifyContext: ClarifyContextMeta = {
        projectKey: sharedContext.projectKey,
        projectKeys: sharedContext.projectKeys,
        projectCount: sharedContext.projectCount,
        pipelineMode: 'story_assistant_default',
        domainRolesUsed: sharedContext.domainRoles,
        discoveryStatus: questions.length > 0 ? 'needs_clarification' : 'ready_for_generation',
        domainContextApplied: sharedContext.sources.domainContextApplied,
        attachmentIncluded: sharedContext.sources.attachmentIncluded,
        similarStoriesCount: sharedContext.sources.similarStoriesCount,
        referencedSimilarStories: sharedContext.sources.referencedSimilarStories,
        discoveryAssessment,
        discoveryProfile,
        discoveryDepth: discoveryAssessment.discoveryDepth,
        reasoningLevel: discoveryAssessment.reasoningLevel,
        coverageObligations: discoveryAssessment.coverageObligations,
        recommendedQuestionRange: discoveryAssessment.recommendedQuestionRange,
        assessmentRationale: discoveryAssessment.rationale,
        coverageQualityScore,
        coverageRetryTriggered,
        ambiguityAssessment,
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
        actorSets: extractActorSets(maskedRequirement.text, retrievalAnswers),
        latencyMs: {
          queueWaitMs,
          retrievalMs: sharedContext.timings.retrievalMs,
          wiInsightExtractionMs: sharedContext.timings.wiInsightExtractionMs,
          promptAssemblyMs,
          firstProgressEventMs: firstProgressSentAt == null ? undefined : Math.max(0, firstProgressSentAt - workflowStartedAt),
        },
        modelRoute,
        pipelineProfile,
        wiDocsCount: sharedContext.sources.wiDocsCount,
        linkedWiDocCount: sharedContext.sources.linkedWiDocCount,
        retrievedWiDocCount: sharedContext.sources.retrievedWiDocCount,
        retrievedWiChunkCount: sharedContext.sources.retrievedWiChunkCount,
        wiInsightCount: sharedContext.sources.wiInsightCount,
        referencedWiDocs: sharedContext.sources.referencedWiDocs,
        referencedWiSections: sharedContext.sources.referencedWiSections,
        wiInsights: sharedContext.wiInsights,
        scopeContract: buildScopeContract(retrievalAnswers),
      };
      const sharedEvidenceSignature = buildSharedPipelineEvidenceSignature({
        requirement: maskedRequirement.text,
        attachmentText: maskedAttachment.text,
        projectKey: sharedContext.projectKey,
        projectKeys: sharedContext.projectKeys,
        pipelineMode: 'story_assistant_default',
        includeSimilarStories: true,
      });
      clarifyContext.sharedEvidenceSignature = sharedEvidenceSignature;
      await entitySet(
        KEYS.sharedPipelineEvidence(sessionId),
        toSharedPipelineEvidenceBundle(sharedContext, sharedEvidenceSignature),
      );

      const persistenceStartedAt = Date.now();
      await saveClarifyTurn(sessionId, accountId, maskedRequirement.text, clarifyContext, inputSignature);
      clarifyContext.latencyMs = {
        ...(clarifyContext.latencyMs ?? {}),
        persistenceMs: Date.now() - persistenceStartedAt,
      };

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
              ? `Generated ${questions.length} discovery questions in the initial Story Assistant round.`
              : 'Discovery determined no clarifying questions were needed before generation.',
            `Loaded ${sharedContext.sources.retrievedWiDocCount} work instruction documents and ${sharedContext.sources.similarStoriesCount} related backlog references into the shared evidence bundle.`,
          ],
          contextUsage: {
            similarStoriesCount: sharedContext.sources.similarStoriesCount,
            linkedWiDocCount: sharedContext.sources.linkedWiDocCount,
            retrievedWiDocCount: sharedContext.sources.retrievedWiDocCount,
            retrievedWiChunkCount: sharedContext.sources.retrievedWiChunkCount,
            wiInsightCount: sharedContext.sources.wiInsightCount,
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
        details: { sessionId, projectKey, model: config.generatorConfig.clarifyModel, pipelineMode: 'story_assistant_default' },
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
        try {
          const auditWriteStartedAt = Date.now();
          await auditWriter.flushMerge({
            accountId,
            mergeHeader: {
              primaryProjectKey: sharedContext.projectKey,
              projectKeys: sharedContext.projectKeys,
              generatorModels: {
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
              wiRetrievalQuery: deriveRetrievalQuery(maskedRequirement.text, maskedAttachment.text, retrievalAnswers),
              wiContextText: sharedContext.wiContext.text,
              similarStoriesText: formatSimilarStoriesText(sharedContext.similarStories, 3),
              domainContext: sharedContext.domainContext,
              domainRoles: sharedContext.domainRoles,
              wiInsights: sharedContext.wiInsights,
            },
            clarify: {
              questions,
              contextMeta: clarifyContext,
              completedAt: new Date().toISOString(),
            },
            completePhase: 'clarify',
          });
          clarifyContext.latencyMs = {
            ...(clarifyContext.latencyMs ?? {}),
            auditWriteMs: Date.now() - auditWriteStartedAt,
          };
        } catch (auditErr) {
          console.warn('[clarify-queue] pipeline audit merge failed:', auditErr);
        }
      }

      await entitySetSmall(KEYS.clarifyProgress(sessionId), {
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

      const diagnostics = buildClarifyFailureDiagnostics('queue_error', {
        technicalSummary: err instanceof Error ? err.message : 'Clarify failed',
      });
      const message = err instanceof Error ? err.message : 'Discovery could not prepare clarifying questions.';

      await entitySetSmall(KEYS.clarifyProgress(sessionId), {
        type: 'blocked',
        error: message,
        reasonCode: 'queue_error',
        contextMeta: buildBlockedClarifyContext(
          resolvePrimaryProjectKey(projectKey, projectKeys),
          'queue_error',
          diagnostics,
        ),
        ...(inputSignature ? { inputSignature } : {}),
        updatedAt: Date.now(),
      });
    } finally {
      stopHeartbeat?.();
    }
  };

  const runScoped = () => runWithWiRetrievalCacheScope(exec);
  if (auditMeta) {
    return runWithPipelineAuditContext(auditMeta, runScoped);
  }
  return runScoped();
}

async function sendClarifyProgress(
  sessionId: string,
  message: string,
  inputSignature?: string,
  payload?: ClarifyProgressPayload,
) {
  const existing = await entityGet<{ type?: string }>(KEYS.clarifyProgress(sessionId));
  if (existing?.type === 'complete' || existing?.type === 'blocked' || existing?.type === 'error' || existing?.type === 'cancelled') {
    return;
  }
  await entitySetSmall(KEYS.clarifyProgress(sessionId), {
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
  await entitySetSmall(KEYS.clarifyProgress(sessionId), {
    type: 'cancelled',
    sessionId,
    ...(inputSignature ? { inputSignature } : {}),
    message: 'Clarifying questions cancelled.',
    updatedAt: Date.now(),
  });
}

function buildClarifyFailureDiagnostics(
  _reasonCode: ClarifyFailureReasonCode,
  details: { technicalSummary?: string },
): ClarifyFailureDiagnostics {
  return {
    technicalSummary: details.technicalSummary ?? '',
    userActionHint: 'Retry discovery. If the problem keeps repeating, trim unusually large attachment context and try again.',
  };
}

async function saveClarifyTurn(
  sessionId: string,
  accountId: string,
  requirement: string,
  contextMeta: ClarifyContextMeta,
  inputSignature?: string,
) {
  const convKey = KEYS.userConversations(accountId, sessionId);
  const conversation = await entityGet<{ turns?: Array<Record<string, unknown>> }>(convKey);
  const existingTurns = conversation?.turns;
  const turns = Array.isArray(existingTurns) ? existingTurns : [];
  const now = new Date().toISOString();
  const nextTurns = [
    ...turns,
    {
      type: 'clarify',
      requirement,
      contextMeta,
      createdAt: now,
      updatedAt: now,
      ...(inputSignature ? { inputSignature } : {}),
    },
  ];

  await entitySet(convKey, {
    turns: nextTurns,
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
  };
}
