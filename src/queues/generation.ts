/**
 * Forge Queue Consumer: two-pass feature generation.
 *
 * Runs with 900s (15 min) timeout — handles the full generation pipeline
 * including WI context retrieval, draft feature generation, review, and AR writing.
 *
 * Progress is streamed back to the UI via Forge Realtime.
 */

import { AdvisoryTriageContract, ClarifyAnswer, DraftReviewMetadata, EffectiveSizingContract, Feature, GenerationContextMeta, GenerationEvent, GenerationStageDurationsMs, TokenUsageSummary } from '../types';
import {
  AcceptanceRequirementsGenerationError,
  ArGenerationProgressSnapshot,
  GenerationCancelledError,
  generateFeatures,
  generateSessionTitle,
} from '../core/story-generator';
import { recordGeneration, getEffectiveTier } from '../services/billing';
import { entityGet, entitySet, KEYS } from '../services/cache';
import { formatSimilarStoriesText } from '../core/similar-stories';
import {
  buildWorkInstructionInsightArtifact,
  buildWorkInstructionRetrievalIntents,
  getWorkInstructionInsightCount,
} from '../core/wi-insights';
import { maskPiiText, maskPiiInAnswers, mergePiiMaskingStats, saveTransparencyReport, appendComplianceAuditEvent } from '../services/compliance';
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
import { deriveRetrievalQuery, mergeWiContextResults } from '../services/retrieval-query';
import { runWithWiRetrievalCacheScope } from '../core/wi-ingestion';

interface RealtimeEvent {
  type: 'progress' | 'complete' | 'error' | 'cancelled';
  sessionId: string;
  message?: string;
  pass?: 1 | 2;
  payload?: unknown;
}

interface GenerationProgressPayload {
  stage?: 'context' | 'triage' | 'decomposition' | 'acceptance_requirements';
  outputProfile?: GenerationContextMeta['outputProfile'];
  triage?: EffectiveSizingContract;
  sizingContract?: EffectiveSizingContract;
  advisoryTriage?: AdvisoryTriageContract;
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

function buildFeatureProgressState(
  draftFeatures: Array<Pick<Feature, 'id'>>,
  snapshot: Pick<ArGenerationProgressSnapshot, 'completedFeatureIds' | 'activeFeatureIds' | 'backfillFeatureIds' | 'failedFeatureIds'>,
): Array<{ id: string; status: 'pending' | 'active' | 'retrying' | 'complete' | 'failed' }> {
  const completedIds = new Set(snapshot.completedFeatureIds);
  const activeIds = new Set(snapshot.activeFeatureIds);
  const retryingIds = new Set(snapshot.backfillFeatureIds);
  const failedIds = new Set(snapshot.failedFeatureIds);
  return draftFeatures.map((feature) => ({
    id: feature.id,
    status: completedIds.has(feature.id)
      ? 'complete'
      : retryingIds.has(feature.id)
        ? 'retrying'
        : activeIds.has(feature.id)
          ? 'active'
          : failedIds.has(feature.id)
            ? 'failed'
            : 'pending',
  }));
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
  sources?: GenerationProgressPayload['sources'];
}): { message: string; payload: GenerationProgressPayload } {
  const {
    retryFeatureId,
    retryFeature,
    outputProfile,
    advisorySizingContract,
    advisoryTriage,
    sources,
  } = opts;

  const seededDraftFeatures = retryFeature
    ? mapDraftFeatures([retryFeature])
    : [];

  const stage: GenerationProgressPayload['stage'] = retryFeatureId
    ? 'acceptance_requirements'
    : 'decomposition';

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
    priorStageDurationsMs,
    outputProfileOverride,
    retryFeatureId,
    retryFeature,
    retryBaseFeatures,
    pipelineAudit,
    auditRunId,
  } = event.body;
  const selectedProjectKeys = normalizeProjectKeys(projectKey, projectKeys);
  const config = {
    ...eventConfig,
    generatorConfig: resolveEffectiveGeneratorConfig(eventConfig.generatorConfig),
    domainContext: buildCombinedDomainContext(eventConfig, selectedProjectKeys),
    domainRoles: getCombinedPersonaRoles(eventConfig, selectedProjectKeys).map((row) => row.role).filter(Boolean),
    tier: getEffectiveTier(eventConfig, { license }),
  };
  const auditMeta = isPipelineAuditRequested(config, pipelineAudit, auditRunId)
    ? { sessionId, auditRunId: auditRunId!, accountId }
    : null;

  const exec = async () => {
  let stopHeartbeat: (() => void) | null = null;
  let progressSourcesSnapshot: GenerationProgressPayload['sources'] | undefined;
  const piiEnabled = Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled);
  const maskedRequirement = maskPiiText(requirement, piiEnabled);
  const maskedAttachment = maskPiiText(attachmentText ?? '', piiEnabled);
  const maskedAnswers = maskPiiInAnswers(clarifyAnswers ?? [], piiEnabled);

  try {
    let currentProgress: { message?: string; pass?: 1 | 2; payload?: GenerationProgressPayload } = {};
    const updateProgress = async (message: string, pass?: 1 | 2, payload?: GenerationProgressPayload) => {
      currentProgress = { message, pass, payload };
      await sendProgress(sessionId, message, pass, payload);
    };
    stopHeartbeat = startProgressHeartbeat(sessionId, () => currentProgress);
    const projectLabel = selectedProjectKeys.length === 1
      ? selectedProjectKeys[0]
      : selectedProjectKeys.length > 1
        ? `${selectedProjectKeys.length} projects`
        : 'no project selected';
    await updateProgress(`Reading work instructions and related stories for ${projectLabel}…`, 1, {
      stage: 'context',
      sources: {
        projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
        projectKeys: selectedProjectKeys,
        projectCount: selectedProjectKeys.length,
        domainContextApplied: Boolean(config.domainContext?.trim()),
        attachmentIncluded: Boolean(attachmentText?.trim()),
      },
    });

    const baseSources: GenerationProgressPayload['sources'] = {
      projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
      projectKeys: selectedProjectKeys,
      projectCount: selectedProjectKeys.length,
      domainContextApplied: Boolean(config.domainContext?.trim()),
      attachmentIncluded: Boolean(attachmentText?.trim()),
    };
    const advisorySizingContract = clarifySizingContract;
    const advisoryTriage = clarifyAdvisoryTriage;
    const [initialWiContext, similarStories] = await Promise.all([
      config.wiConfig.enabled
        ? retrieveScopedWiContext(
            deriveRetrievalQuery(maskedRequirement.text, maskedAttachment.text, maskedAnswers.answers),
            config.wiConfig.topKChunks,
            config.wiConfig.maxChars,
            selectedProjectKeys,
          )
        : Promise.resolve({ text: '', docs: [], chunks: [], linkedDocs: [] }),
      config.tier !== 'free'
        ? retrieveScopedSimilarStories({
            requirement: deriveRetrievalQuery(maskedRequirement.text, maskedAttachment.text, maskedAnswers.answers),
            attachmentText: maskedAttachment.text,
            clarifyAnswers: maskedAnswers.answers,
            config,
            projectKeys: selectedProjectKeys,
            maxResults: 12,
          })
        : Promise.resolve([]),
    ]);
    let wiContext = initialWiContext;
    if (config.wiConfig.enabled && advisoryTriage?.reasoning?.trim()) {
      const intents = buildWorkInstructionRetrievalIntents(maskedRequirement.text, advisoryTriage.reasoning);
      for (const intent of intents) {
        try {
          const focused = await retrieveScopedWiContext(
            intent,
            Math.min(2, Math.max(1, config.wiConfig.topKChunks)),
            Math.min(2500, config.wiConfig.maxChars),
            selectedProjectKeys,
          );
          if (focused.chunks.length > 0) {
            wiContext = mergeWiContextResults(wiContext, focused, config.wiConfig.maxChars);
          }
        } catch {
          // keep existing WI context
        }
      }
    }

    if (await isWorkflowCancelled(sessionId)) {
      await markCancelled(sessionId);
      return;
    }
    const similarStoriesText = formatSimilarStoriesText(similarStories);
    const wiInsights = buildWorkInstructionInsightArtifact(wiContext.chunks);
    const linkedWiDocCount = wiContext.linkedDocs.length;
    const retrievedWiDocCount = wiContext.docs.length;
    const retrievedWiChunkCount = wiContext.chunks.length;
    const wiInsightCount = getWorkInstructionInsightCount(wiInsights);
    const progressSources: GenerationProgressPayload['sources'] = {
      ...baseSources,
      similarStoriesCount: similarStories.length,
      referencedSimilarStories: similarStories.slice(0, 6).map(item => ({
        key: item.key,
        summary: item.summary,
        relevanceScore: item.relevanceScore,
        url: item.url,
        jiraIssueUrl: item.url,
      })),
      linkedWiDocCount,
      retrievedWiDocCount,
      retrievedWiChunkCount,
      wiInsightCount,
      referencedWiDocs: wiContext.docs.slice(0, 6).map(doc => ({
        docId: doc.docId,
        filename: doc.filename,
        chunkCount: doc.chunkCount,
      })),
      referencedWiSections: summarizeReferencedWiSections(wiContext.chunks.slice(0, 4)),
    };
    progressSourcesSnapshot = progressSources;

    const startProgress = buildGenerationStartProgressUpdate({
      retryFeatureId,
      retryFeature,
      outputProfile: outputProfileOverride ?? config.generationPreferences?.outputProfile ?? 'business_first',
      advisorySizingContract,
      advisoryTriage,
      sources: progressSources,
    });

    await updateProgress(startProgress.message, 1, startProgress.payload);

    let liveDraftFeatures: Array<Pick<Feature, 'id' | 'summary' | 'description' | 'storyPoints' | 'featureClass' | 'confidence' | 'actorSource'>> =
      startProgress.payload.draftFeatures ?? [];

    getPipelineAuditWriter()?.setPhase('generate.pipeline');
    const result = await generateFeatures({
      requirement,
      clarifyAnswers: maskedAnswers.answers,
      attachmentText: maskedAttachment.text,
      similarStoriesText,
      wiContextText: wiContext.text,
      wiInsightsArtifact: wiInsights,
      config,
      outputProfileOverride,
      advisoryTriage,
      projectKeys: selectedProjectKeys,
      clarifyDiscoveryProfile: clarifyDiscoveryProfile ?? undefined,
      similarStories,
      precomputedDraftFeatures: retryFeature ? [retryFeature] : undefined,
      allowPartialArFailure: Boolean(retryFeatureId && retryBaseFeatures?.length),
      priorStageDurationsMs,
      shouldCancel: () => isWorkflowCancelled(sessionId),
      onPass1DraftFeatures: async (drafts) => {
        liveDraftFeatures = mapDraftFeatures(drafts);
        await updateProgress(
          `Sketching features (${drafts.length} draft${drafts.length === 1 ? '' : 's'})…`,
          1,
          {
            stage: 'decomposition',
            triage: advisorySizingContract,
            sizingContract: advisorySizingContract,
            advisoryTriage,
            draftFeatures: liveDraftFeatures,
            draftFeatureCount: liveDraftFeatures.length,
            sources: progressSources,
          },
        );
      },
      onArProgress: async (snapshot) => {
        const completed = snapshot.completedFeatureIds.length;
        const retrying = snapshot.backfillFeatureIds.length;
        const failed = snapshot.failedFeatureIds.length;
        const total = snapshot.total;
        const message = snapshot.phase === 'backfill'
          ? `Retrying incomplete acceptance requirements: ${completed}/${total} features complete${retrying ? `, ${retrying} retrying` : ''}${failed ? `, ${failed} still incomplete` : ''}…`
          : `Writing acceptance requirements: ${completed}/${total} features complete${snapshot.activeFeatureIds.length ? `, ${snapshot.activeFeatureIds.length} in progress` : ''}…`;
        await updateProgress(message, 2, {
          stage: 'acceptance_requirements',
          triage: advisorySizingContract,
          sizingContract: advisorySizingContract,
          advisoryTriage,
          draftFeatures: liveDraftFeatures,
          draftFeatureCount: liveDraftFeatures.length,
          featureProgress: buildFeatureProgressState(liveDraftFeatures, snapshot),
          arProgress: { completed, total, phase: snapshot.phase },
          failedFeatureIds: snapshot.failedFeatureIds,
          sources: progressSources,
        });
      },
    });

    result.similarStories = similarStories;
    result.sessionId = sessionId;
    if (retryFeatureId && retryBaseFeatures?.length) {
      const replacementFeature = result.features[0] ?? retryFeature;
      const mergedFeatures = retryBaseFeatures.map((feature) => (
        feature.id === retryFeatureId
          ? replacementFeature
          : feature
      ));
      result.features = mergedFeatures;
      const failedFeatureIds = mergedFeatures
        .filter((feature) => feature.arGenerationStatus === 'failed')
        .map((feature) => feature.id);
      result.generationContext = {
        ...(result.generationContext ?? { projectKey: resolvePrimaryProjectKey(projectKey, projectKeys), domainRolesUsed: config.domainRoles ?? [] }),
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
      projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
      projectKeys: selectedProjectKeys,
      projectCount: selectedProjectKeys.length,
      domainRolesUsed: config.domainRoles ?? [],
      domainContextApplied: Boolean(config.domainContext?.trim()),
      attachmentIncluded: Boolean(attachmentText?.trim()),
      pass2BatchWiChunkCount: result.generationContext?.pass2BatchWiChunkCount,
      pass2ArPatternStoryKeys: result.generationContext?.pass2ArPatternStoryKeys,
      similarStoriesCount: similarStories.length,
      referencedSimilarStories: summarizeReferencedSimilarStories(similarStories.slice(0, 12)),
      sizingContract: advisorySizingContract,
      advisoryTriage,
      pass1DraftFeatureCount: liveDraftFeatures.length || result.features.length,
      coverageReview: result.generationContext?.coverageReview,
      failedFeatureIds: result.generationContext?.failedFeatureIds ?? [],
      partialSuccess: result.generationContext?.partialSuccess,
      partialSuccessMessage: result.generationContext?.partialSuccessMessage,
      stageDurationsMs: result.generationContext?.stageDurationsMs ?? priorStageDurationsMs,
      tokenUsage: result.tokenUsage,
      wiDocsCount: retrievedWiDocCount,
      linkedWiDocCount,
      retrievedWiDocCount,
      retrievedWiChunkCount,
      wiInsightCount,
      referencedWiDocs: wiContext.docs.slice(0, 12).map(doc => ({
        docId: doc.docId,
        filename: doc.filename,
        chunkCount: doc.chunkCount,
      })),
      referencedWiSections: summarizeReferencedWiSections(wiContext.chunks.slice(0, 8)),
      wiInsights,
    };
    result.generationContext = generationContext;

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
      {
        clarifyAnswers: maskedAnswers.answers,
        attachmentText: maskedAttachment.text,
        projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
        projectKeys: selectedProjectKeys,
        sizingContract: generationContext.sizingContract,
        advisoryTriage: generationContext.advisoryTriage,
      },
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
          `Generated features using ${similarStories.length} backlog references.`,
          `Retrieved ${retrievedWiDocCount} work instruction documents from ${linkedWiDocCount} linked documents and ${config.domainRoles?.length ?? 0} roles.`,
          'Acceptance requirements were produced in a dedicated second pass for consistency.',
        ],
        contextUsage: {
          similarStoriesCount: similarStories.length,
          linkedWiDocCount,
          retrievedWiDocCount,
          retrievedWiChunkCount,
          wiInsightCount,
          domainRolesCount: config.domainRoles?.length ?? 0,
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
        model: config.generatorConfig.arModel,
      },
      enabled: Boolean(config.compliance?.enabled && config.compliance?.auditTrailEnabled),
    });
    await recordProjectActivity({
      action: 'generate',
      projectKeys: selectedProjectKeys,
      projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
      sessionId,
      model: config.generatorConfig.arModel,
      tokenUsage: result.tokenUsage ?? null,
    });

    if (await isWorkflowCancelled(sessionId)) {
      await markCancelled(sessionId);
      return;
    }

    const genAuditWriter = getPipelineAuditWriter();
    if (genAuditWriter) {
      try {
        await genAuditWriter.flushMerge({
          accountId,
          mergeHeader: {
            primaryProjectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
            projectKeys: selectedProjectKeys,
            generatorModels: {
              decompositionModel: config.generatorConfig.decompositionModel,
              arModel: config.generatorConfig.arModel,
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
            wiContextText: wiContext.text,
            similarStoriesText,
            domainContext: config.domainContext,
            domainRoles: config.domainRoles,
            wiInsights,
          },
          generation: {
            clarifyAnswers: maskedAnswers.answers,
            features: result.features,
            generationContext: result.generationContext,
            completedAt: new Date().toISOString(),
          },
          completePhase: 'generation',
        });
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
    const genAuditErr = getPipelineAuditWriter();
    if (genAuditErr) {
      try {
        await genAuditErr.flushMerge({
          accountId,
          mergeHeader: {
            primaryProjectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
            projectKeys: selectedProjectKeys,
          },
        });
      } catch (auditErr) {
        console.warn('[generation-queue] pipeline audit merge (error path) failed:', auditErr);
      }
    }
    if (await isWorkflowCancelled(sessionId) || err instanceof GenerationCancelledError || String((err as { name?: string })?.name ?? '') === 'GenerationCancelledError') {
      await markCancelled(sessionId);
      return;
    }
    if (err instanceof AcceptanceRequirementsGenerationError) {
      const arError = err as AcceptanceRequirementsGenerationError;
      const failedFeatureIds = arError.failedFeatureIndexes
        .map((index) => arError.draftFeatures[index]?.id)
        .filter((id): id is string => Boolean(id));
      const arFailurePayload: GenerationProgressPayload = {
        stage: 'acceptance_requirements',
        outputProfile: outputProfileOverride ?? config.generationPreferences?.outputProfile ?? 'business_first',
        triage: clarifySizingContract,
        sizingContract: clarifySizingContract,
        advisoryTriage: clarifyAdvisoryTriage,
        draftFeatures: mapDraftFeatures(arError.draftFeatures),
        featureProgress: arError.draftFeatures.map((feature) => ({
          id: feature.id,
          status: failedFeatureIds.includes(feature.id) ? 'active' : 'complete',
        })),
        arProgress: {
          completed: arError.draftFeatures.length - failedFeatureIds.length,
          total: arError.draftFeatures.length,
        },
        failedFeatureIds,
        sources: progressSourcesSnapshot,
      };
      await entitySet(KEYS.generationProgress(sessionId), {
        type: 'error',
        sessionId,
        message: arError.message,
        payload: arFailurePayload,
        updatedAt: Date.now(),
      } as RealtimeEvent);
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

    // Update per-user conversation index
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

    // Update per-user index with title
    const indexKey = KEYS.userConversationIndex(accountId);
    const index = await entityGet<ConvIndex[]>(indexKey) ?? [];
    const entry = index.find(e => e.sessionId === sessionId);
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
