import { Feature, RefineEvent } from '../types';
import { refineFeatures } from '../core/story-generator';
import { getEffectiveTier } from '../services/billing';
import { entityGet, entitySet, KEYS } from '../services/cache';
import { maskPiiText, mergePiiMaskingStats, saveTransparencyReport } from '../services/compliance';
import { recordProjectActivity } from '../services/project-activity';
import { normalizeProjectKeys, resolvePrimaryProjectKey } from '../services/project-selection';

interface RefineProgressEvent {
  type: 'progress' | 'complete' | 'error' | 'cancelled';
  sessionId: string;
  message?: string;
  features?: Feature[];
  tokenUsage?: unknown;
  updatedAt: number;
}

export async function handler(event: { body: RefineEvent }) {
  const { sessionId, accountId, requirement, feedback, features, license, config: eventConfig, projectKey, projectKeys } = event.body;
  const selectedProjectKeys = normalizeProjectKeys(projectKey, projectKeys);
  const config = {
    ...eventConfig,
    tier: getEffectiveTier(eventConfig, { license }),
  };

  try {
    await sendRefineProgress(sessionId, 'Preparing bulk refinement context…');

    const piiEnabled = Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled);
    const maskedRequirement = maskPiiText(requirement ?? '', piiEnabled);
    const maskedFeedback = maskPiiText(feedback ?? '', piiEnabled);

    if (await isWorkflowCancelled(sessionId)) {
      await markCancelled(sessionId);
      return;
    }

    await sendRefineProgress(sessionId, `Refining ${Array.isArray(features) ? features.length : 0} features in the background…`);

    const result = await refineFeatures({
      requirement: maskedRequirement.text,
      features,
      feedback: maskedFeedback.text,
      config,
    });

    if (await isWorkflowCancelled(sessionId)) {
      await markCancelled(sessionId);
      return;
    }

    await updateLatestTurnFeatures(sessionId, accountId, result.features, feedback, result.tokenUsage);
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
          'Bulk refinement applied from explicit user feedback.',
          'Existing features were preserved where the feedback did not require structural changes.',
        ],
        contextUsage: {
          featureCount: Array.isArray(features) ? features.length : 0,
          feedbackLength: String(feedback ?? '').length,
        },
        tokenUsage: result.tokenUsage,
        piiMasking: mergePiiMaskingStats(maskedRequirement.stats, maskedFeedback.stats),
      });
    }
    await recordProjectActivity({
      action: 'refine',
      projectKeys: selectedProjectKeys,
      projectKey: resolvePrimaryProjectKey(projectKey, projectKeys),
      sessionId,
      model: config.generatorConfig.refineModel,
      tokenUsage: result.tokenUsage ?? null,
    });

    await entitySet(KEYS.refineProgress(sessionId), {
      type: 'complete',
      sessionId,
      message: 'Bulk refinement complete.',
      features: result.features,
      tokenUsage: result.tokenUsage,
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
      message: err instanceof Error ? err.message : 'Bulk refinement failed',
      updatedAt: Date.now(),
    } as RefineProgressEvent);
  }
}

async function sendRefineProgress(sessionId: string, message: string) {
  await entitySet(KEYS.refineProgress(sessionId), {
    type: 'progress',
    sessionId,
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
