/**
 * Forge Queue Consumer: two-pass feature generation.
 *
 * Runs with 900s (15 min) timeout — handles the full generation pipeline
 * including WI context retrieval, triage, pass 1 + pass 2.
 *
 * Progress is streamed back to the UI via Forge Realtime.
 */

import { ClarifyAnswer, EffectiveSizingContract, Feature, GenerationContextMeta, GenerationEvent, GenerationSizingAssessment, GenerationStageDurationsMs, TokenUsageSummary } from '../types';
import { TriageResult, triageToSizingContract } from '../core/story-generator';
import { extractDiscoverySignals } from '../core/discovery';
import {
  AcceptanceRequirementsGenerationError,
  ArGenerationProgressSnapshot,
  assessRequirementWithLlm,
  GenerationCancelledError,
  generateFeatures,
  generateSessionTitle,
  Pass1DraftReviewRequiredError,
  shouldPauseForDraftReview,
} from '../core/story-generator';
import { recordGeneration, getEffectiveTier } from '../services/billing';
import { entityGet, entitySet, KEYS } from '../services/cache';
import { formatSimilarStoriesText } from '../core/similar-stories';
import { maskPiiText, maskPiiInAnswers, mergePiiMaskingStats, saveTransparencyReport, appendComplianceAuditEvent } from '../services/compliance';
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

function sizingContractToTriage(contract: EffectiveSizingContract): TriageResult {
  return {
    estimatedFeatures: Math.max(1, Math.round(contract.featureTarget)),
    estimatedQuestions: Math.max(0, Math.round(contract.estimatedQuestions)),
    shape: contract.shape,
    complexity: contract.complexity,
    arDepth: contract.arDepth,
  };
}

interface RealtimeEvent {
  type: 'progress' | 'complete' | 'error' | 'cancelled' | 'review';
  sessionId: string;
  message?: string;
  pass?: 1 | 2;
  payload?: unknown;
}

interface GenerationProgressPayload {
  stage?: 'context' | 'triage' | 'decomposition' | 'draft_review' | 'acceptance_requirements';
  triage?: EffectiveSizingContract;
  arProgress?: { completed: number; total: number; phase?: 'initial' | 'backfill' };
  draftFeatures?: Array<Pick<Feature, 'id' | 'summary' | 'description' | 'storyPoints'>>;
  draftFeatureCount?: number;
  featureProgress?: Array<{ id: string; status: 'pending' | 'active' | 'retrying' | 'complete' | 'failed' }>;
  failedFeatureIds?: string[];
  sizingAssessment?: GenerationSizingAssessment | GenerationSizingAssessment['decomposition'];
  stageDurationsMs?: GenerationStageDurationsMs;
  reviewDecision?: { suggestedAction: 'consolidate'; reason: string };
  resumeContext?: {
    requirement: string;
    clarifyAnswers: ClarifyAnswer[];
    attachmentText: string;
    projectKey: string;
    projectKeys: string[];
    draftFeatures: Feature[];
    triage: EffectiveSizingContract;
    priorStageDurationsMs?: GenerationStageDurationsMs;
  };
  sources?: Pick<GenerationContextMeta, 'projectKey' | 'projectKeys' | 'projectCount' | 'domainContextApplied' | 'attachmentIncluded' | 'wiDocsCount' | 'referencedWiDocs' | 'similarStoriesCount' | 'referencedSimilarStories' | 'referencedWiSections'>;
}

const PROGRESS_HEARTBEAT_MS = 15000;

/**
 * When the user provides only an attachment (empty requirement), use the
 * first 600 chars of the attachment as the retrieval query for WI and
 * similar-stories BM25 search. This ensures relevant chunks are returned
 * instead of an empty-string query producing meaningless results.
 */
function deriveRetrievalQuery(
  requirement: string,
  attachmentText: string,
  clarifyAnswers: Array<{ answer?: string }> = [],
): string {
  const requirementText = requirement?.trim() ?? '';
  const attachmentSnippet = (attachmentText?.trim() ?? '').slice(0, 600).replace(/\s+/g, ' ');
  const answerContext = clarifyAnswers
    .map((answer) => String(answer?.answer ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 500);
  const signalContext = extractDiscoverySignals([requirementText, attachmentSnippet, answerContext]).join(' ').slice(0, 250);

  if (requirementText.length >= 30) {
    return [requirementText, signalContext, answerContext].filter(Boolean).join(' ').slice(0, 900).trim();
  }
  return [requirementText, signalContext, answerContext, attachmentSnippet].filter(Boolean).join(' ').slice(0, 900).trim();
}

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

function buildTriagePayload(triageResult: Awaited<ReturnType<typeof assessRequirementWithLlm>>) {
  if (!triageResult) return undefined;
  return triageToSizingContract(triageResult);
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
    reviewedDraftFeatures,
    reviewedDraftDecision,
    reviewedTriageSizingContract,
    priorStageDurationsMs,
    retryFeatureId,
    retryFeature,
    retryBaseFeatures,
  } = event.body;
  const selectedProjectKeys = normalizeProjectKeys(projectKey, projectKeys);
  const config = {
    ...eventConfig,
    generatorConfig: resolveEffectiveGeneratorConfig(eventConfig.generatorConfig),
    domainContext: buildCombinedDomainContext(eventConfig, selectedProjectKeys),
    domainRoles: getCombinedPersonaRoles(eventConfig, selectedProjectKeys).map((row) => row.role).filter(Boolean),
    tier: getEffectiveTier(eventConfig, { license }),
  };
  let stopHeartbeat: (() => void) | null = null;
  let triageSnapshot: Awaited<ReturnType<typeof assessRequirementWithLlm>> = null;
  let progressSourcesSnapshot: GenerationProgressPayload['sources'] | undefined;
  let sizingAssessmentSnapshot: GenerationSizingAssessment | undefined;
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

    const committedSizingContract = reviewedTriageSizingContract ?? clarifySizingContract;
    const triagePromise: Promise<Awaited<ReturnType<typeof assessRequirementWithLlm>>> = committedSizingContract
      ? Promise.resolve(sizingContractToTriage(committedSizingContract)).then(async result => {
          const triage = buildTriagePayload(result);
          if (triage) {
            const arText = ` with ${triage.arDepth} acceptance depth`;
            await updateProgress(
              `Committed sizing: ${triage.shape} scope, ${triage.complexity} complexity — drafting about ${triage.featureTarget} features${arText}`,
              1,
              { stage: 'triage', triage, sources: baseSources },
            );
          }
          return result;
        })
      : assessRequirementWithLlm({
          requirement: maskedRequirement.text,
          clarifyAnswers: maskedAnswers.answers,
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
        }).then(async triageResult => {
          const triage = buildTriagePayload(triageResult);
          if (triage) {
            const arText = ` with ${triage.arDepth} acceptance depth`;
            await updateProgress(
              `Initial read: ${triage.shape} scope, ${triage.complexity} complexity — likely ${triage.featureTarget} features${arText}`,
              1,
              { stage: 'triage', triage, sources: baseSources },
            );
          }
          return triageResult;
        });

    const [wiContext, similarStories, effectiveTriageResult] = await Promise.all([
      config.wiConfig.enabled
        ? retrieveScopedWiContext(
            deriveRetrievalQuery(maskedRequirement.text, maskedAttachment.text, maskedAnswers.answers),
            config.wiConfig.topKChunks,
            config.wiConfig.maxChars,
            selectedProjectKeys,
          )
        : Promise.resolve({ text: '', docs: [], chunks: [] }),
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
      triagePromise,
    ]);

    triageSnapshot = effectiveTriageResult;

    if (await isWorkflowCancelled(sessionId)) {
      await markCancelled(sessionId);
      return;
    }
    const similarStoriesText = formatSimilarStoriesText(similarStories);
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
      wiDocsCount: wiContext.docs.length,
      referencedWiDocs: wiContext.docs.slice(0, 6).map(doc => ({
        docId: doc.docId,
        filename: doc.filename,
        chunkCount: doc.chunkCount,
      })),
      referencedWiSections: summarizeReferencedWiSections(wiContext.chunks.slice(0, 4)),
    };
    progressSourcesSnapshot = progressSources;

    // Progress: pass 1
    await updateProgress(
      retryFeatureId
        ? 'Retrying acceptance requirements for the selected feature…'
        : reviewedDraftFeatures?.length
          ? 'Resuming generation from reviewed draft features…'
          : 'Planning feature structure from gathered context…',
      1,
      {
        stage: retryFeatureId
          ? 'acceptance_requirements'
          : reviewedDraftFeatures?.length ? 'draft_review' : 'decomposition',
        triage: buildTriagePayload(effectiveTriageResult),
        sources: progressSources,
      },
    );

    let liveDraftFeatures: Array<Pick<Feature, 'id' | 'summary' | 'description' | 'storyPoints'>> = [];

    const result = await generateFeatures({
      requirement,
      clarifyAnswers: maskedAnswers.answers,
      attachmentText: maskedAttachment.text,
      similarStoriesText,
      wiContextText: wiContext.text,
      config,
      precomputedTriage: effectiveTriageResult,
      precomputedDraftFeatures: retryFeature ? [retryFeature] : reviewedDraftFeatures,
      draftReviewDecision: retryFeatureId ? 'keep' : reviewedDraftDecision,
      allowPartialArFailure: Boolean(retryFeatureId && retryBaseFeatures?.length),
      priorStageDurationsMs,
      shouldCancel: () => isWorkflowCancelled(sessionId),
      onTriageComplete: async (triage) => {
        if (!effectiveTriageResult) {
          const arText = typeof triage.arTarget === 'number'
            ? `, about ${triage.arTarget} ARs each`
            : ` with ${triage.arDepth} acceptance depth`;
          await updateProgress(`Assessed as ${triage.shape} scope, ${triage.complexity} complexity — drafting about ${triage.featureTarget} features${arText}`, 1, {
            stage: 'triage',
            triage,
            sources: progressSources,
          });
        }
      },
      onPass1Complete: async (draftFeatures, decompositionSizingAssessment, triageContract, stageDurationsMs) => {
        liveDraftFeatures = draftFeatures.map(feature => ({
          id: feature.id,
          summary: feature.summary,
          description: feature.description,
          storyPoints: feature.storyPoints,
        }));
        const needsReview = !reviewedDraftFeatures?.length && shouldPauseForDraftReview({
          draftFeatureCount: draftFeatures.length,
          triageFeatureTarget: triageContract.featureTarget,
          sizingAssessment: decompositionSizingAssessment,
        });
        if (needsReview) {
          await updateProgress(`Draft review required: ${draftFeatures.length} features were sketched before AR generation.`, 1, {
            stage: 'draft_review',
            triage: triageContract,
            draftFeatures: liveDraftFeatures,
            draftFeatureCount: draftFeatures.length,
            sizingAssessment: decompositionSizingAssessment,
            stageDurationsMs,
            reviewDecision: {
              suggestedAction: 'consolidate',
              reason: `The draft exceeds the earlier forecast and looks oversized for this ask.`,
            },
            resumeContext: {
              requirement,
              clarifyAnswers: maskedAnswers.answers,
              attachmentText: maskedAttachment.text,
              projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
              projectKeys: selectedProjectKeys,
              draftFeatures,
              triage: triageContract,
              priorStageDurationsMs: stageDurationsMs,
            },
            sources: progressSources,
          });
          return;
        }
        await updateProgress(`Writing acceptance requirements for ${draftFeatures.length} feature${draftFeatures.length !== 1 ? 's' : ''}…`, 2, {
          stage: 'acceptance_requirements',
          triage: triageContract,
          draftFeatures: liveDraftFeatures,
          draftFeatureCount: draftFeatures.length,
          featureProgress: buildFeatureProgressState(liveDraftFeatures, {
            completedFeatureIds: [],
            activeFeatureIds: draftFeatures.map((feature) => feature.id),
            backfillFeatureIds: [],
            failedFeatureIds: [],
          }),
          arProgress: { completed: 0, total: draftFeatures.length, phase: 'initial' },
          stageDurationsMs,
          sources: progressSources,
        });
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
          triage: buildTriagePayload(effectiveTriageResult),
          draftFeatures: liveDraftFeatures,
          draftFeatureCount: liveDraftFeatures.length,
          featureProgress: buildFeatureProgressState(liveDraftFeatures, snapshot),
          arProgress: { completed, total, phase: snapshot.phase },
          failedFeatureIds: snapshot.failedFeatureIds,
          sources: progressSources,
        });
      },
      onSizingAssessment: async (sizingAssessment) => {
        sizingAssessmentSnapshot = sizingAssessment;
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
      similarStoriesCount: similarStories.length,
      referencedSimilarStories: summarizeReferencedSimilarStories(similarStories.slice(0, 12)),
      sizingContract: buildTriagePayload(effectiveTriageResult),
      sizingAssessment: sizingAssessmentSnapshot,
      pass1DraftFeatureCount: liveDraftFeatures.length || result.features.length,
      draftReviewTriggered: Boolean(reviewedDraftDecision || false),
      draftReviewDecision: reviewedDraftDecision,
      failedFeatureIds: result.generationContext?.failedFeatureIds ?? [],
      partialSuccess: result.generationContext?.partialSuccess,
      partialSuccessMessage: result.generationContext?.partialSuccessMessage,
      stageDurationsMs: result.generationContext?.stageDurationsMs ?? priorStageDurationsMs,
      tokenUsage: result.tokenUsage,
      wiDocsCount: wiContext.docs.length,
      referencedWiDocs: wiContext.docs.slice(0, 12).map(doc => ({
        docId: doc.docId,
        filename: doc.filename,
        chunkCount: doc.chunkCount,
      })),
      referencedWiSections: summarizeReferencedWiSections(wiContext.chunks.slice(0, 8)),
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
          `Applied ${wiContext.docs.length} work instruction documents and ${config.domainRoles?.length ?? 0} roles.`,
          'Acceptance requirements were produced in a dedicated second pass for consistency.',
        ],
        contextUsage: {
          similarStoriesCount: similarStories.length,
          wiDocsCount: wiContext.docs.length,
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

    await entitySet(KEYS.generationProgress(sessionId), {
      type: 'complete',
      sessionId,
      payload: result,
      updatedAt: Date.now(),
    } as RealtimeEvent);

    void generateSessionTitle(maskedRequirement.text, config)
      .then(async (title) => {
        await updateConversationTitle(sessionId, accountId, title);
      })
      .catch(async (titleErr) => {
        console.warn('[generation-queue] Title generation failed, using fallback title:', titleErr);
        await updateConversationTitle(sessionId, accountId, requirement.slice(0, 80));
      });

  } catch (err) {
    if (await isWorkflowCancelled(sessionId) || err instanceof GenerationCancelledError || String((err as { name?: string })?.name ?? '') === 'GenerationCancelledError') {
      await markCancelled(sessionId);
      return;
    }
    if (err instanceof Pass1DraftReviewRequiredError) {
      await entitySet(KEYS.generationProgress(sessionId), {
        type: 'review',
        sessionId,
        message: 'Review drafted features before continuing.',
        payload: {
          stage: 'draft_review',
          triage: err.triage,
          draftFeatures: err.draftFeatures.map((feature) => ({
            id: feature.id,
            summary: feature.summary,
            description: feature.description,
            storyPoints: feature.storyPoints,
          })),
          draftFeatureCount: err.draftFeatures.length,
          sizingAssessment: err.sizingAssessment,
          stageDurationsMs: err.stageDurationsMs,
          reviewDecision: {
            suggestedAction: 'consolidate',
            reason: 'This draft looks inflated relative to the earlier estimate or preferred sizing range.',
          },
          resumeContext: {
            requirement,
            clarifyAnswers: maskedAnswers.answers,
            attachmentText: maskedAttachment.text,
            projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
            projectKeys: selectedProjectKeys,
            draftFeatures: err.draftFeatures,
            triage: err.triage,
            priorStageDurationsMs: err.stageDurationsMs,
          },
          sources: progressSourcesSnapshot,
        } as GenerationProgressPayload,
        updatedAt: Date.now(),
      } as RealtimeEvent);
      return;
    }
    if (err instanceof AcceptanceRequirementsGenerationError) {
      const arError = err as AcceptanceRequirementsGenerationError;
      const failedFeatureIds = arError.failedFeatureIndexes
        .map((index) => arError.draftFeatures[index]?.id)
        .filter((id): id is string => Boolean(id));
      const arFailurePayload: GenerationProgressPayload = {
        stage: 'acceptance_requirements',
        triage: buildTriagePayload(triageSnapshot),
        draftFeatures: arError.draftFeatures.map((feature) => ({
          id: feature.id,
          summary: feature.summary,
          description: feature.description,
          storyPoints: feature.storyPoints,
        })),
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
