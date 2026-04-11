import { CanvasEditIntent, Feature, RefineEvent, StructuralRestructureProposal } from '../types';
import { addFeaturesFromFeedback, addRequirementsFromFeedback, refineFeatures, restructureFeatures } from '../core/story-generator';
import { getEffectiveTier } from '../services/billing';
import { entityGet, entitySet, KEYS } from '../services/cache';
import { maskPiiText, mergePiiMaskingStats, saveTransparencyReport } from '../services/compliance';
import { resolveEffectiveGeneratorConfig } from '../services/model-strategy';
import { recordProjectActivity } from '../services/project-activity';
import { normalizeProjectKeys, resolvePrimaryProjectKey } from '../services/project-selection';

interface RefineProgressEvent {
  type: 'progress' | 'complete' | 'error' | 'cancelled';
  sessionId: string;
  operationType?: 'light_refine' | 'add_requirements' | 'add_feature' | 'reorganize';
  intent?: CanvasEditIntent;
  message?: string;
  features?: Feature[];
  proposal?: StructuralRestructureProposal;
  tokenUsage?: unknown;
  updatedAt: number;
}

export async function handler(event: { body: RefineEvent }) {
  const { sessionId, accountId, requirement, feedback, features, license, config: eventConfig, projectKey, projectKeys } = event.body;
  const selectedProjectKeys = normalizeProjectKeys(projectKey, projectKeys);
  const intent: CanvasEditIntent = event.body.intent
    ?? (event.body.mode === 'restructure' ? 'reorganize' : event.body.mode === 'add_feature' ? 'add_feature' : 'light_refine');
  const operationType = intent;
  const config = {
    ...eventConfig,
    generatorConfig: resolveEffectiveGeneratorConfig(eventConfig.generatorConfig),
    tier: getEffectiveTier(eventConfig, { license }),
  };
  const selectedFeatureIds = Array.isArray(event.body.selectedFeatureIds) ? event.body.selectedFeatureIds : [];
  const targetedFeatures = selectedFeatureIds.length
    ? features.filter((feature) => selectedFeatureIds.includes(feature.id))
    : features;

  try {
    await sendRefineProgress(
      sessionId,
      operationType === 'reorganize'
        ? 'Preparing reorganization preview…'
        : operationType === 'add_feature'
          ? 'Preparing missing feature coverage…'
          : operationType === 'add_requirements'
            ? 'Preparing requirement coverage update…'
            : 'Preparing draft refinement…',
      operationType,
      intent,
    );

    const piiEnabled = Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled);
    const maskedRequirement = maskPiiText(requirement ?? '', piiEnabled);
    const maskedFeedback = maskPiiText(feedback ?? '', piiEnabled);

    if (await isWorkflowCancelled(sessionId)) {
      await markCancelled(sessionId);
      return;
    }

    await sendRefineProgress(
      sessionId,
      operationType === 'reorganize'
        ? `Reorganizing ${event.body.restructureScope === 'selected' ? event.body.selectedFeatureIds?.length ?? 0 : Array.isArray(features) ? features.length : 0} features in the background…`
        : operationType === 'add_feature'
          ? 'Adding missing feature coverage in the background…'
          : `Updating ${Array.isArray(targetedFeatures) ? targetedFeatures.length : 0} feature${targetedFeatures.length === 1 ? '' : 's'} in the background…`,
      operationType,
      intent,
    );

    let tokenUsage;
    let resultFeatures: Feature[];
    let proposal: StructuralRestructureProposal | undefined;

    if (operationType === 'reorganize') {
      const result = await restructureFeatures({
        requirement: maskedRequirement.text,
        features,
        feedback: maskedFeedback.text,
        selectedFeatureIds,
        scope: event.body.restructureScope ?? 'all',
        config,
      });
      tokenUsage = result.tokenUsage;
      proposal = result.proposal;
      resultFeatures = result.proposal.proposedFeatures;
    } else if (operationType === 'add_feature') {
      const result = await addFeaturesFromFeedback({
        requirement: maskedRequirement.text,
        features,
        feedback: maskedFeedback.text,
        config,
        selectedFeatureIds,
      });
      tokenUsage = result.tokenUsage;
      resultFeatures = [...features, ...result.features];
    } else if (operationType === 'add_requirements') {
      const result = await addRequirementsFromFeedback({
        requirement: maskedRequirement.text,
        features: targetedFeatures,
        feedback: maskedFeedback.text,
        config,
        onProgress: (message) => sendRefineProgress(sessionId, message, operationType, intent),
      });
      tokenUsage = result.tokenUsage;
      if (selectedFeatureIds.length) {
        const refinedById = new Map(result.features.map((feature) => [feature.id, feature]));
        resultFeatures = features.map((feature) => refinedById.get(feature.id) ?? feature);
      } else {
        resultFeatures = result.features;
      }
    } else {
      const result = await refineFeatures({
        requirement: maskedRequirement.text,
        features: targetedFeatures,
        feedback: maskedFeedback.text,
        config,
        onProgress: (message) => sendRefineProgress(sessionId, message, operationType, intent),
      });
      tokenUsage = result.tokenUsage;
      if (selectedFeatureIds.length) {
        const refinedById = new Map(result.features.map((feature) => [feature.id, feature]));
        resultFeatures = features.map((feature) => refinedById.get(feature.id) ?? feature);
      } else {
        resultFeatures = result.features;
      }
    }

    if (await isWorkflowCancelled(sessionId)) {
      await markCancelled(sessionId);
      return;
    }

    await updateLatestTurnFeatures(sessionId, accountId, resultFeatures, feedback, tokenUsage);
    if (config.compliance?.enabled && config.compliance?.transparencyReportsEnabled) {
      await saveTransparencyReport({
        sessionId,
        turnType: 'refine',
        actorAccountId: accountId,
        provider: config.generatorConfig.provider,
        model: config.generatorConfig.refineModel,
        projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
        requirementExcerpt: maskedRequirement.text.slice(0, 240),
        decisionSummary: [
          operationType === 'reorganize'
            ? 'Feature structure proposal generated from explicit user restructure feedback.'
            : operationType === 'add_feature'
              ? 'Missing feature coverage was added without rewriting the existing canvas.'
              : 'Canvas changes were applied from explicit user feedback.',
          operationType === 'reorganize'
            ? 'Existing feature coverage was preserved through explicit source-feature and AR provenance.'
            : operationType === 'add_feature'
              ? 'Existing features were preserved and any new coverage was appended as separate features.'
              : 'Existing features were preserved outside the requested change scope.',
        ],
        contextUsage: {
          featureCount: Array.isArray(features) ? features.length : 0,
          feedbackLength: String(feedback ?? '').length,
          operationType,
        },
        tokenUsage,
        piiMasking: mergePiiMaskingStats(maskedRequirement.stats, maskedFeedback.stats),
      });
    }
    await recordProjectActivity({
      action: 'refine',
      projectKeys: selectedProjectKeys,
      projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
      sessionId,
      model: config.generatorConfig.refineModel,
      tokenUsage: tokenUsage ?? null,
      metadata: { operationType, restructureScope: event.body.restructureScope ?? null },
    });

    await entitySet(KEYS.refineProgress(sessionId), {
      type: 'complete',
      sessionId,
      operationType,
      intent,
      message: operationType === 'reorganize'
        ? 'Reorganization preview ready.'
        : operationType === 'add_feature'
          ? 'Missing feature coverage ready.'
          : operationType === 'add_requirements'
            ? 'Requirement coverage update ready.'
            : 'Draft refinement ready.',
      features: resultFeatures,
      proposal,
      tokenUsage,
      updatedAt: Date.now(),
    } as RefineProgressEvent);
  } catch (err) {
    console.error('[refine-queue] Error:', err);
    if (await isWorkflowCancelled(sessionId)) {
      await markCancelled(sessionId);
      return;
    }
    await entitySet(KEYS.refineProgress(sessionId), {
      type: 'error',
      sessionId,
      operationType,
      intent,
      message: err instanceof Error ? err.message : 'Bulk refinement failed',
      updatedAt: Date.now(),
    } as RefineProgressEvent);
  }
}

async function sendRefineProgress(
  sessionId: string,
  message: string,
  operationType: 'light_refine' | 'add_requirements' | 'add_feature' | 'reorganize',
  intent?: CanvasEditIntent,
) {
  await entitySet(KEYS.refineProgress(sessionId), {
    type: 'progress',
    sessionId,
    operationType,
    intent,
    message,
    updatedAt: Date.now(),
  } as RefineProgressEvent);
}

async function isWorkflowCancelled(sessionId: string): Promise<boolean> {
  const progress = await entityGet<{ type?: string }>(KEYS.refineProgress(sessionId));
  return progress?.type === 'cancelled';
}

async function markCancelled(sessionId: string) {
  await entitySet(KEYS.refineProgress(sessionId), {
    type: 'cancelled',
    sessionId,
    operationType: 'light_refine',
    message: 'Canvas change cancelled.',
    updatedAt: Date.now(),
  } as RefineProgressEvent);
}

async function updateLatestTurnFeatures(
  sessionId: string,
  accountId: string,
  features: Feature[],
  feedback: string,
  tokenUsage?: unknown,
) {
  try {
    const key = KEYS.userConversations(accountId, sessionId);
    const existing = await entityGet<{ turns: Array<Record<string, unknown>> }>(key);
    if (!existing?.turns) return;
    existing.turns.push({
      turnType: 'refine',
      features,
      feedback,
      tokenUsage,
      timestamp: new Date().toISOString(),
    });
    await entitySet(key, existing);
  } catch {
    // ignore persistence failures so the queue result can still be returned
  }
}
