import { Feature, RefineEvent, StructuralRestructureProposal } from '../types';
import { refineFeatures, restructureFeatures } from '../core/story-generator';
import { getEffectiveTier } from '../services/billing';
import { entityGet, entitySet, KEYS } from '../services/cache';
import { maskPiiText, mergePiiMaskingStats, saveTransparencyReport } from '../services/compliance';
import { resolveEffectiveGeneratorConfig } from '../services/model-strategy';
import { recordProjectActivity } from '../services/project-activity';
import { normalizeProjectKeys, resolvePrimaryProjectKey } from '../services/project-selection';

interface RefineProgressEvent {
  type: 'progress' | 'complete' | 'error' | 'cancelled';
  sessionId: string;
  operationType?: 'refine' | 'restructure';
  message?: string;
  features?: Feature[];
  proposal?: StructuralRestructureProposal;
  tokenUsage?: unknown;
  updatedAt: number;
}

export async function handler(event: { body: RefineEvent }) {
  const { sessionId, accountId, requirement, feedback, features, license, config: eventConfig, projectKey, projectKeys } = event.body;
  const selectedProjectKeys = normalizeProjectKeys(projectKey, projectKeys);
  const operationType = event.body.mode === 'restructure' ? 'restructure' : 'refine';
  const config = {
    ...eventConfig,
    generatorConfig: resolveEffectiveGeneratorConfig(eventConfig.generatorConfig),
    tier: getEffectiveTier(eventConfig, { license }),
  };

  try {
    await sendRefineProgress(
      sessionId,
      operationType === 'restructure' ? 'Preparing restructure context…' : 'Preparing bulk refinement context…',
      operationType,
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
      operationType === 'restructure'
        ? `Restructuring ${event.body.restructureScope === 'selected' ? event.body.selectedFeatureIds?.length ?? 0 : Array.isArray(features) ? features.length : 0} features in the background…`
        : `Refining ${Array.isArray(features) ? features.length : 0} features in the background…`,
      operationType,
    );

    let tokenUsage;
    let resultFeatures: Feature[];
    let proposal: StructuralRestructureProposal | undefined;

    if (operationType === 'restructure') {
      const result = await restructureFeatures({
        requirement: maskedRequirement.text,
        features,
        feedback: maskedFeedback.text,
        selectedFeatureIds: event.body.selectedFeatureIds ?? [],
        scope: event.body.restructureScope ?? 'all',
        config,
      });
      tokenUsage = result.tokenUsage;
      proposal = result.proposal;
      resultFeatures = result.proposal.proposedFeatures;
    } else {
      const result = await refineFeatures({
        requirement: maskedRequirement.text,
        features,
        feedback: maskedFeedback.text,
        config,
        onProgress: (message) => sendRefineProgress(sessionId, message, operationType),
      });
      tokenUsage = result.tokenUsage;
      resultFeatures = result.features;
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
          operationType === 'restructure'
            ? 'Feature structure proposal generated from explicit user restructure feedback.'
            : 'Bulk refinement applied from explicit user feedback.',
          operationType === 'restructure'
            ? 'Existing feature coverage was preserved through explicit source-feature and AR provenance.'
            : 'Existing features were preserved where the feedback did not require structural changes.',
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
      message: operationType === 'restructure' ? 'Restructure proposal ready.' : 'Bulk refinement complete.',
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
      message: err instanceof Error ? err.message : 'Bulk refinement failed',
      updatedAt: Date.now(),
    } as RefineProgressEvent);
  }
}

async function sendRefineProgress(sessionId: string, message: string, operationType: 'refine' | 'restructure') {
  await entitySet(KEYS.refineProgress(sessionId), {
    type: 'progress',
    sessionId,
    operationType,
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
    operationType: 'refine',
    message: 'Bulk refinement cancelled.',
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
