/**
 * Forge Queue Consumer: bounded two-pass feature generation.
 *
 * Active pipeline:
 * shared context -> pass 1 features -> pass 2 acceptance requirements
 */

import type {
  AdvisoryTriageContract,
  ClarifyAnswer,
  DraftReviewMetadata,
  EffectiveSizingContract,
  Feature,
  GenerationContextMeta,
  GenerationEvent,
  GenerationStageDurationsMs,
  TokenUsageSummary,
} from '../types';
import { GenerationCancelledError } from '../core/feature-output';
import { generateSessionTitle } from '../core/session-title';
import { formatSimilarStoriesText } from '../core/similar-stories';
import { recordGeneration, getEffectiveTier } from '../services/billing';
import { entityGet, entitySet, KEYS } from '../services/cache';
import { appendComplianceAuditEvent, maskPiiInAnswers, maskPiiText, mergePiiMaskingStats, saveTransparencyReport } from '../services/compliance';
import { buildGenerationModelRoute, resolveEffectiveGeneratorConfig } from '../services/model-strategy';
import { getPipelineAuditWriter, isPipelineAuditRequested, runWithPipelineAuditContext } from '../services/pipeline-audit-context';
import { recordProjectActivity } from '../services/project-activity';
import {
  buildCombinedDomainContext,
  getCombinedPersonaRoles,
  normalizeProjectKeys,
  resolvePrimaryProjectKey,
} from '../services/project-selection';
import { deriveRetrievalQuery } from '../services/retrieval-query';
import { runStoryAssistantGenerationStage } from '../services/story-assistant-pipeline';
import { runWithWiRetrievalCacheScope } from '../core/wi-ingestion';

interface RealtimeEvent {
  type: 'progress' | 'complete' | 'error' | 'cancelled' | 'needs_clarification';
  sessionId: string;
  message?: string;
  pass?: 1 | 2;
  payload?: unknown;
  questions?: unknown[];
  sufficiencyResult?: unknown;
}

interface GenerationProgressPayload {
  stage?: 'context' | 'triage' | 'decomposition' | 'acceptance_requirements';
  outputProfile?: GenerationContextMeta['outputProfile'];
  triage?: EffectiveSizingContract;
  sizingContract?: EffectiveSizingContract;
  advisoryTriage?: AdvisoryTriageContract;
  latencyMs?: GenerationContextMeta['latencyMs'];
  modelRoute?: GenerationContextMeta['modelRoute'];
  qualityMode?: GenerationContextMeta['qualityMode'];
  arProgress?: { completed: number; total: number; phase?: 'initial' | 'backfill' };
  draftFeatures?: Array<Pick<Feature, 'id' | 'summary' | 'description' | 'storyPoints' | 'featureClass' | 'confidence' | 'actorSource'>>;
  draftFeatureCount?: number;
  featureProgress?: Array<{ id: string; status: 'pending' | 'active' | 'retrying' | 'complete' | 'failed' }>;
  failedFeatureIds?: string[];
  draftReview?: DraftReviewMetadata;
  stageDurationsMs?: GenerationStageDurationsMs;
  sources?: Pick<GenerationContextMeta, 'projectKey' | 'projectKeys' | 'projectCount' | 'domainContextApplied' | 'attachmentIncluded' | 'linkedWiDocCount' | 'retrievedWiDocCount' | 'retrievedWiChunkCount' | 'wiInsightCount' | 'referencedWiDocs' | 'similarStoriesCount' | 'referencedSimilarStories' | 'referencedWiSections'>;
}

const PROGRESS_HEARTBEAT_MS = 15000;

async function sendProgress(sessionId: string, message: string, pass?: 1 | 2, payload?: GenerationProgressPayload) {
  await entitySet(KEYS.generationProgress(sessionId), {
    type: 'progress',
    sessionId,
    message,
    pass,
    payload,
    updatedAt: Date.now(),
  } as RealtimeEvent);
}

function startProgressHeartbeat(
  sessionId: string,
  getCurrentProgress: () => { message?: string; pass?: 1 | 2; payload?: GenerationProgressPayload },
) {
  let stopped = false;
  let inFlight = false;
  const timer = setInterval(() => {
    const current = getCurrentProgress();
    if (stopped || inFlight || !current.message) return;
    inFlight = true;
    void sendProgress(sessionId, current.message, current.pass, current.payload).finally(() => {
      inFlight = false;
    });
  }, PROGRESS_HEARTBEAT_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function mapDraftFeatures(features: Feature[]): Array<Pick<Feature, 'id' | 'summary' | 'description' | 'storyPoints' | 'featureClass' | 'confidence' | 'actorSource'>> {
  return features.map((feature) => ({
    id: feature.id,
    summary: feature.summary,
    description: feature.description,
    ...(feature.storyPoints != null ? { storyPoints: feature.storyPoints } : {}),
    ...(feature.featureClass ? { featureClass: feature.featureClass } : {}),
    ...(feature.confidence ? { confidence: feature.confidence } : {}),
    ...(feature.actorSource ? { actorSource: feature.actorSource } : {}),
  }));
}

export function buildGenerationStartProgressUpdate(opts: {
  retryFeatureId?: string;
  retryFeature?: Feature;
  outputProfile?: GenerationContextMeta['outputProfile'];
  advisorySizingContract?: EffectiveSizingContract;
  advisoryTriage?: AdvisoryTriageContract;
  qualityMode?: GenerationContextMeta['qualityMode'];
  modelRoute?: GenerationContextMeta['modelRoute'];
  sources?: GenerationProgressPayload['sources'];
}): { message: string; payload: GenerationProgressPayload } {
  const {
    retryFeatureId,
    retryFeature,
    outputProfile,
    advisorySizingContract,
    advisoryTriage,
    qualityMode,
    modelRoute,
    sources,
  } = opts;

  const seededDraftFeatures = retryFeature ? mapDraftFeatures([retryFeature]) : [];
  const stage: GenerationProgressPayload['stage'] = retryFeatureId ? 'acceptance_requirements' : 'decomposition';
  const message = retryFeatureId
    ? 'Retrying acceptance requirements for the selected feature…'
    : 'Planning feature structure from gathered context…';

  return {
    message,
    payload: {
      stage,
      outputProfile,
      triage: advisorySizingContract,
      sizingContract: advisorySizingContract,
      advisoryTriage,
      qualityMode,
      modelRoute,
      ...(seededDraftFeatures.length
        ? {
            draftFeatures: seededDraftFeatures,
            draftFeatureCount: seededDraftFeatures.length,
          }
        : {}),
      sources,
    },
  };
}

export async function handler(event: { body: GenerationEvent }) {
  const {
    sessionId,
    accountId,
    requirement,
    clarifyAnswers,
    attachmentText,
    license,
    config: eventConfig,
    projectKey,
    projectKeys,
    clarifySizingContract,
    clarifyAdvisoryTriage,
    clarifyDiscoveryProfile,
    clarifyFinalSufficiency: preEvaluatedSufficiency,
    clarifyQuestionsAsked,
    priorStageDurationsMs,
    outputProfileOverride,
    retryFeatureId,
    retryFeature,
    retryBaseFeatures,
    pipelineAudit,
    auditRunId,
    qualityMode = 'speed',
    modelOverrides,
    enqueuedAt,
  } = event.body;

  const selectedProjectKeys = normalizeProjectKeys(projectKey, projectKeys);
  const config = {
    ...eventConfig,
    generatorConfig: resolveEffectiveGeneratorConfig(eventConfig.generatorConfig),
    domainContext: buildCombinedDomainContext(eventConfig, selectedProjectKeys),
    domainRoles: getCombinedPersonaRoles(eventConfig, selectedProjectKeys).map((row) => row.role).filter(Boolean),
    tier: getEffectiveTier(eventConfig, { license }),
  };
  const runConfig = {
    ...config,
    generatorConfig: {
      ...config.generatorConfig,
      ...(modelOverrides ?? {}),
    },
  };
  const modelRoute = buildGenerationModelRoute(config.generatorConfig, modelOverrides);
  const auditMeta = isPipelineAuditRequested(config, pipelineAudit, auditRunId)
    ? { sessionId, auditRunId: auditRunId!, accountId }
    : null;

  const exec = async () => {
    const workflowStartedAt = Date.now();
    const queueWaitMs = Math.max(0, workflowStartedAt - Number(enqueuedAt ?? workflowStartedAt));
    let stopHeartbeat: (() => void) | null = null;
    const piiEnabled = Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled);
    const maskedRequirement = maskPiiText(requirement, piiEnabled);
    const maskedAttachment = maskPiiText(attachmentText ?? '', piiEnabled);
    const maskedAnswers = maskPiiInAnswers(clarifyAnswers ?? [], piiEnabled);
    let firstProgressSentAt: number | null = null;

    try {
      let currentProgress: { message?: string; pass?: 1 | 2; payload?: GenerationProgressPayload } = {};
      const updateProgress = async (message: string, pass?: 1 | 2, payload?: GenerationProgressPayload) => {
        if (firstProgressSentAt == null) firstProgressSentAt = Date.now();
        currentProgress = { message, pass, payload };
        await sendProgress(sessionId, message, pass, payload);
      };
      stopHeartbeat = startProgressHeartbeat(sessionId, () => currentProgress);

      const projectLabel = selectedProjectKeys.length === 1
        ? selectedProjectKeys[0]
        : selectedProjectKeys.length > 1
          ? `${selectedProjectKeys.length} projects`
          : 'no project selected';
      const baseSources: GenerationProgressPayload['sources'] = {
        projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
        projectKeys: selectedProjectKeys,
        projectCount: selectedProjectKeys.length,
        domainContextApplied: Boolean(config.domainContext?.trim()),
        attachmentIncluded: Boolean(attachmentText?.trim()),
      };
      const advisorySizingContract = clarifySizingContract;
      const advisoryTriage = clarifyAdvisoryTriage;
      let clarifyFinalSufficiency = preEvaluatedSufficiency;

      if (!clarifyFinalSufficiency?.evaluated && !retryFeatureId) {
        await updateProgress(`Evaluating requirement sufficiency…`, 1, {
          stage: 'context',
          sources: baseSources,
        });
        getPipelineAuditWriter()?.setPhase('clarify.sufficiency');

        const { runStoryAssistantSufficiencyStage } = await import('../services/story-assistant-pipeline');
        const { result: sufficiencyResult } = await runStoryAssistantSufficiencyStage({
          requirement: maskedRequirement.text,
          attachmentText: maskedAttachment.text,
          answers: maskedAnswers.answers,
          askedQuestions: clarifyQuestionsAsked,
          config: runConfig,
          projectKey,
          projectKeys,
        });

        if (sufficiencyResult.status === 'ask_followup' && Array.isArray(sufficiencyResult.questions) && sufficiencyResult.questions.length > 0) {
          await entitySet(KEYS.generationProgress(sessionId), {
            type: 'needs_clarification',
            sessionId,
            message: 'Discovery evaluation determined follow-up questions are required.',
            questions: sufficiencyResult.questions,
            sufficiencyResult,
            updatedAt: Date.now(),
          } as RealtimeEvent);
          const w = getPipelineAuditWriter();
          if (w) {
            await w.flushMerge({
              accountId,
              sufficiency: { evaluation: sufficiencyResult as any, completedAt: new Date().toISOString() },
              completePhase: 'sufficiency',
            });
          }
          return;
        }
        
        clarifyFinalSufficiency = {
          evaluated: true,
          sufficient: sufficiencyResult.sufficient,
          status: sufficiencyResult.status,
          roundEvaluated: 1,
          missingCategoryKeys: sufficiencyResult.missingCategoryKeys,
          reasonCodes: sufficiencyResult.reasonCodes,
        };
        
        const w = getPipelineAuditWriter();
        if (w) {
          await w.flushMerge({
            accountId,
            sufficiency: { evaluation: sufficiencyResult as any, completedAt: new Date().toISOString() },
            completePhase: 'sufficiency',
          });
        }
      }

      await updateProgress(`Reading shared evidence context for ${projectLabel}…`, 1, {
        stage: 'context',
        sources: baseSources,
      });
      getPipelineAuditWriter()?.setPhase('generate.pipeline');

      let liveDraftFeatures: Array<Pick<Feature, 'id' | 'summary' | 'description' | 'storyPoints' | 'featureClass' | 'confidence' | 'actorSource'>> = [];
      const { sharedContext, result } = await runStoryAssistantGenerationStage({
        requirement: maskedRequirement.text,
        attachmentText: maskedAttachment.text,
        clarifyAnswers: maskedAnswers.answers,
        clarifyDiscoveryProfile,
        config: runConfig,
        projectKey,
        projectKeys,
        precomputedDraftFeatures: retryFeature ? [retryFeature] : undefined,
        priorStageDurationsMs,
        shouldCancel: () => isWorkflowCancelled(sessionId),
        onPass1DraftFeatures: async (drafts) => {
          liveDraftFeatures = mapDraftFeatures(drafts);
          await updateProgress(
            `Sketching features (${drafts.length} draft${drafts.length === 1 ? '' : 's'})…`,
            1,
            {
              stage: 'decomposition',
              outputProfile: outputProfileOverride ?? config.generationPreferences?.outputProfile ?? 'business_first',
              triage: advisorySizingContract,
              sizingContract: advisorySizingContract,
              advisoryTriage,
              draftFeatures: liveDraftFeatures,
              draftFeatureCount: liveDraftFeatures.length,
              qualityMode,
              modelRoute,
              sources: {
                ...baseSources,
                similarStoriesCount: sharedContext.sources.similarStoriesCount,
                referencedSimilarStories: sharedContext.sources.referencedSimilarStories,
                linkedWiDocCount: sharedContext.sources.linkedWiDocCount,
                retrievedWiDocCount: sharedContext.sources.retrievedWiDocCount,
                retrievedWiChunkCount: sharedContext.sources.retrievedWiChunkCount,
                wiInsightCount: sharedContext.sources.wiInsightCount,
                referencedWiDocs: sharedContext.sources.referencedWiDocs,
                referencedWiSections: sharedContext.sources.referencedWiSections,
              },
            },
          );
          await updateProgress(
            `Writing acceptance requirements in one full pass for ${drafts.length} feature${drafts.length === 1 ? '' : 's'}…`,
            2,
            {
              stage: 'acceptance_requirements',
              outputProfile: outputProfileOverride ?? config.generationPreferences?.outputProfile ?? 'business_first',
              triage: advisorySizingContract,
              sizingContract: advisorySizingContract,
              advisoryTriage,
              draftFeatures: liveDraftFeatures,
              draftFeatureCount: liveDraftFeatures.length,
              arProgress: { completed: 0, total: drafts.length, phase: 'initial' },
              qualityMode,
              modelRoute,
              sources: {
                ...baseSources,
                similarStoriesCount: sharedContext.sources.similarStoriesCount,
                referencedSimilarStories: sharedContext.sources.referencedSimilarStories,
                linkedWiDocCount: sharedContext.sources.linkedWiDocCount,
                retrievedWiDocCount: sharedContext.sources.retrievedWiDocCount,
                retrievedWiChunkCount: sharedContext.sources.retrievedWiChunkCount,
                wiInsightCount: sharedContext.sources.wiInsightCount,
                referencedWiDocs: sharedContext.sources.referencedWiDocs,
                referencedWiSections: sharedContext.sources.referencedWiSections,
              },
            },
          );
        },
      });

      if (await isWorkflowCancelled(sessionId)) {
        await markCancelled(sessionId);
        return;
      }

      const progressSources: GenerationProgressPayload['sources'] = {
        projectKey: sharedContext.projectKey,
        projectKeys: sharedContext.projectKeys,
        projectCount: sharedContext.projectCount,
        domainContextApplied: sharedContext.sources.domainContextApplied,
        attachmentIncluded: sharedContext.sources.attachmentIncluded,
        similarStoriesCount: sharedContext.sources.similarStoriesCount,
        referencedSimilarStories: sharedContext.sources.referencedSimilarStories,
        linkedWiDocCount: sharedContext.sources.linkedWiDocCount,
        retrievedWiDocCount: sharedContext.sources.retrievedWiDocCount,
        retrievedWiChunkCount: sharedContext.sources.retrievedWiChunkCount,
        wiInsightCount: sharedContext.sources.wiInsightCount,
        referencedWiDocs: sharedContext.sources.referencedWiDocs,
        referencedWiSections: sharedContext.sources.referencedWiSections,
      };
      const startProgress = buildGenerationStartProgressUpdate({
        retryFeatureId,
        retryFeature,
        outputProfile: outputProfileOverride ?? config.generationPreferences?.outputProfile ?? 'business_first',
        advisorySizingContract,
        advisoryTriage,
        qualityMode,
        modelRoute,
        sources: progressSources,
      });

      await updateProgress(startProgress.message, 1, startProgress.payload);
      liveDraftFeatures = startProgress.payload.draftFeatures ?? liveDraftFeatures;

      result.similarStories = sharedContext.similarStories;
      result.sessionId = sessionId;
      if (retryFeatureId && retryBaseFeatures?.length) {
        const replacementFeature = result.features[0] ?? retryFeature;
        const mergedFeatures = retryBaseFeatures.map((feature) => (
          feature.id === retryFeatureId ? replacementFeature : feature
        ));
        result.features = mergedFeatures;
        const failedFeatureIds = mergedFeatures
          .filter((feature) => feature.arGenerationStatus === 'failed')
          .map((feature) => feature.id);
        result.generationContext = {
          ...(result.generationContext ?? { projectKey: sharedContext.projectKey, domainRolesUsed: sharedContext.domainRoles }),
          failedFeatureIds,
          partialSuccess: failedFeatureIds.length > 0,
          partialSuccessMessage: failedFeatureIds.length > 0
            ? `Acceptance requirements could not be completed for ${failedFeatureIds.length} feature${failedFeatureIds.length === 1 ? '' : 's'}. Retry the highlighted feature${failedFeatureIds.length === 1 ? '' : 's'} from the canvas.`
            : undefined,
        };
      }

      if (await isWorkflowCancelled(sessionId)) {
        await markCancelled(sessionId);
        return;
      }

      const generationContext: GenerationContextMeta = {
        projectKey: sharedContext.projectKey,
        projectKeys: sharedContext.projectKeys,
        projectCount: sharedContext.projectCount,
        pipelineMode: 'story_assistant_default',
        domainRolesUsed: sharedContext.domainRoles,
        domainContextApplied: sharedContext.sources.domainContextApplied,
        attachmentIncluded: sharedContext.sources.attachmentIncluded,
        similarStoriesCount: sharedContext.sources.similarStoriesCount,
        referencedSimilarStories: sharedContext.sources.referencedSimilarStories,
        outputProfile: outputProfileOverride ?? config.generationPreferences?.outputProfile ?? 'business_first',
        qualityMode,
        sizingContract: advisorySizingContract,
        advisoryTriage,
        pass1DraftFeatureCount: liveDraftFeatures.length || result.features.length,
        pass2ArPatternStoryKeys: result.generationContext?.pass2ArPatternStoryKeys ?? sharedContext.sources.arPatternStoryKeys,
        failedFeatureIds: result.generationContext?.failedFeatureIds ?? [],
        partialSuccess: result.generationContext?.partialSuccess,
        partialSuccessMessage: result.generationContext?.partialSuccessMessage,
        stageDurationsMs: result.generationContext?.stageDurationsMs ?? priorStageDurationsMs,
        latencyMs: {
          queueWaitMs,
          retrievalMs: sharedContext.timings.retrievalMs,
          wiInsightExtractionMs: sharedContext.timings.wiInsightExtractionMs,
          promptAssemblyMs: result.generationContext?.latencyMs?.promptAssemblyMs,
          firstProgressEventMs: firstProgressSentAt == null ? undefined : Math.max(0, firstProgressSentAt - workflowStartedAt),
        },
        modelRoute,
        actorSets: result.generationContext?.actorSets,
        tokenUsage: result.tokenUsage,
        wiDocsCount: sharedContext.sources.wiDocsCount,
        linkedWiDocCount: sharedContext.sources.linkedWiDocCount,
        retrievedWiDocCount: sharedContext.sources.retrievedWiDocCount,
        retrievedWiChunkCount: sharedContext.sources.retrievedWiChunkCount,
        wiInsightCount: sharedContext.sources.wiInsightCount,
        referencedWiDocs: sharedContext.sources.referencedWiDocs,
        referencedWiSections: sharedContext.sources.referencedWiSections,
        wiInsights: sharedContext.wiInsights,
        ...(clarifyFinalSufficiency?.status ? { sufficiencyStatus: clarifyFinalSufficiency.status } : {}),
        ...(clarifyFinalSufficiency?.reasonCodes?.length ? { sufficiencyReasonCodes: clarifyFinalSufficiency.reasonCodes } : {}),
      };
      result.generationContext = generationContext;

      await recordGeneration();
      const persistenceStartedAt = Date.now();
      await saveConversationTurn(
        sessionId,
        accountId,
        maskedRequirement.text,
        result.features,
        sharedContext.similarStories,
        modelRoute.ar ?? runConfig.generatorConfig.arModel,
        generationContext,
        result.tokenUsage,
        {
          clarifyAnswers: maskedAnswers.answers,
          attachmentText: maskedAttachment.text,
          projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
          projectKeys: selectedProjectKeys,
          sizingContract: generationContext.sizingContract,
          advisoryTriage: generationContext.advisoryTriage,
        },
      );
      generationContext.latencyMs = {
        ...(generationContext.latencyMs ?? {}),
        persistenceMs: Date.now() - persistenceStartedAt,
      };

      if (config.compliance?.enabled && config.compliance?.transparencyReportsEnabled) {
        await saveTransparencyReport({
          sessionId,
          turnType: 'generate',
          actorAccountId: accountId,
          provider: config.generatorConfig.provider,
          model: modelRoute.ar ?? runConfig.generatorConfig.arModel,
          projectKey,
          requirementExcerpt: maskedRequirement.text.slice(0, 240),
          decisionSummary: [
            'Generated features with the Story Assistant bounded two-pass path.',
            `Reused one shared evidence bundle with ${sharedContext.sources.retrievedWiDocCount} work instruction documents and ${sharedContext.sources.similarStoriesCount} related backlog references.`,
            'Used pass 1 for feature decomposition and pass 2 for acceptance requirements only.',
          ],
          contextUsage: {
            similarStoriesCount: sharedContext.sources.similarStoriesCount,
            linkedWiDocCount: sharedContext.sources.linkedWiDocCount,
            retrievedWiDocCount: sharedContext.sources.retrievedWiDocCount,
            retrievedWiChunkCount: sharedContext.sources.retrievedWiChunkCount,
            wiInsightCount: sharedContext.sources.wiInsightCount,
            domainRolesCount: sharedContext.domainRoles.length,
          },
          tokenUsage: result.tokenUsage,
          piiMasking: mergePiiMaskingStats(maskedRequirement.stats, maskedAttachment.stats, maskedAnswers.stats),
        });
      }

      await appendComplianceAuditEvent({
        actorAccountId: accountId,
        category: 'runtime',
        action: 'GENERATION_WORKFLOW_EXECUTED',
        details: {
          sessionId,
          projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
          model: modelRoute.ar ?? runConfig.generatorConfig.arModel,
          pipelineMode: 'story_assistant_default',
        },
        enabled: Boolean(config.compliance?.enabled && config.compliance?.auditTrailEnabled),
      });

      await recordProjectActivity({
        action: 'generate',
        projectKeys: selectedProjectKeys,
        projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
        sessionId,
        model: modelRoute.ar ?? runConfig.generatorConfig.arModel,
        tokenUsage: result.tokenUsage ?? null,
      });

      const genAuditWriter = getPipelineAuditWriter();
      if (genAuditWriter) {
        try {
          const auditWriteStartedAt = Date.now();
          await genAuditWriter.flushMerge({
            accountId,
            mergeHeader: {
              primaryProjectKey: sharedContext.projectKey,
              projectKeys: sharedContext.projectKeys,
              generatorModels: {
                decompositionModel: modelRoute.decomposition,
                arModel: modelRoute.ar,
              },
              piiMaskingEnabled: piiEnabled,
              piiMaskingStats: mergePiiMaskingStats(maskedRequirement.stats, maskedAttachment.stats, maskedAnswers.stats),
            },
            userInputs: {
              requirement: maskedRequirement.text,
              attachmentText: maskedAttachment.text,
              outputProfile: outputProfileOverride ?? config.generationPreferences?.outputProfile ?? 'business_first',
              clarifyDiscoveryProfile,
              clarifySizingContract,
              clarifyAdvisoryTriage,
            },
            discoveryContextGeneration: {
              wiRetrievalQuery: deriveRetrievalQuery(maskedRequirement.text, maskedAttachment.text, maskedAnswers.answers),
              wiContextText: sharedContext.wiContext.text,
              similarStoriesText: formatSimilarStoriesText(sharedContext.similarStories, 4),
              domainContext: sharedContext.domainContext,
              domainRoles: sharedContext.domainRoles,
              wiInsights: sharedContext.wiInsights,
            },
            generation: {
              clarifyAnswers: maskedAnswers.answers,
              features: result.features,
              generationContext: result.generationContext,
              completedAt: new Date().toISOString(),
            },
            completePhase: 'generation',
          });
          generationContext.latencyMs = {
            ...(generationContext.latencyMs ?? {}),
            auditWriteMs: Date.now() - auditWriteStartedAt,
          };
        } catch (auditErr) {
          console.warn('[generation-queue] pipeline audit merge failed:', auditErr);
        }
      }

      await entitySet(KEYS.generationProgress(sessionId), {
        type: 'complete',
        sessionId,
        payload: result,
        updatedAt: Date.now(),
      } as RealtimeEvent);

      setImmediate(() => {
        void generateSessionTitle(maskedRequirement.text, config)
          .then(async (title) => {
            await updateConversationTitle(sessionId, accountId, title);
          })
          .catch(async (titleErr) => {
            console.warn('[generation-queue] Title generation failed, using fallback title:', titleErr);
            await updateConversationTitle(sessionId, accountId, requirement.slice(0, 80));
          });
      });
    } catch (err) {
      if (await isWorkflowCancelled(sessionId) || err instanceof GenerationCancelledError) {
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
  };

  const runScoped = () => runWithWiRetrievalCacheScope(exec);
  if (auditMeta) {
    return runWithPipelineAuditContext(auditMeta, runScoped);
  }
  return runScoped();
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

async function saveConversationTurn(
  sessionId: string,
  accountId: string,
  requirement: string,
  features: unknown[],
  similarStories: unknown[],
  model: string,
  generationContext?: GenerationContextMeta,
  tokenUsage?: TokenUsageSummary,
  retryContext?: {
    clarifyAnswers: ClarifyAnswer[];
    attachmentText: string;
    projectKey: string;
    projectKeys: string[];
    sizingContract?: EffectiveSizingContract;
    advisoryTriage?: AdvisoryTriageContract;
  },
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
      retryContext,
      model,
      timestamp: new Date().toISOString(),
    });
    await entitySet(key, existing);

    await updateConversationIndex(sessionId, accountId, requirement.slice(0, 80));
  } catch (err) {
    console.warn('[generation-queue] Failed to save conversation turn:', err);
  }
}

async function updateConversationTitle(sessionId: string, accountId: string, title: string) {
  try {
    const key = KEYS.userConversations(accountId, sessionId);
    const existing = await entityGet<{ turns: unknown[]; title?: string; titleEditedAt?: string; updatedAt?: string }>(key);
    if (existing) {
      if (existing.titleEditedAt) return;
      existing.title = title;
      existing.updatedAt = new Date().toISOString();
      await entitySet(key, existing);
    }

    const indexKey = KEYS.userConversationIndex(accountId);
    const index = await entityGet<ConvIndex[]>(indexKey) ?? [];
    const entry = index.find((item) => item.sessionId === sessionId);
    if (entry) {
      entry.title = title;
      entry.updatedAt = new Date().toISOString();
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
    const existing = index.find((item) => item.sessionId === sessionId);
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
