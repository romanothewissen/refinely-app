import { recordGeneration, releaseGenerationReservation } from '../services/billing';
import { runV2Pipeline } from '../v2/pipeline';
import { createSqlConversationStore, createV2EphemeralWorkflowStateStore } from '../v2/storage';

interface V2GenerationEventBody {
  sessionId: string;
  accountId: string;
  requirement: string;
  attachmentText?: string;
  config: any;
  projectKey: string;
  projectKeys: string[];
  domainContext?: string;
  domainRoles?: string[];
  wiContextText?: string;
  similarStoriesText?: string;
  triageOverride?: unknown;
  confirmedScopeHypothesis?: unknown;
  discoveryAnswers?: unknown[];
}

async function setProgress(
  sessionId: string,
  message: string,
  extras?: Record<string, unknown>,
) {
  const stateStore = createV2EphemeralWorkflowStateStore();
  await stateStore.setProgress(sessionId, {
    type: 'progress',
    sessionId,
    message,
    updatedAt: Date.now(),
    ...(extras ?? {}),
  });
}

export async function handler(event: { body: V2GenerationEventBody }) {
  const payload = event.body;
  const stateStore = createV2EphemeralWorkflowStateStore();
  const conversationStore = createSqlConversationStore();

  try {
    await setProgress(payload.sessionId, 'Reasoning about capability boundaries…');

    const result = await runV2Pipeline({
      requirement: payload.requirement,
      attachmentText: payload.attachmentText,
      config: payload.config,
      domainContext: payload.domainContext,
      domainRoles: payload.domainRoles,
      wiContextText: payload.wiContextText,
      similarStoriesText: payload.similarStoriesText,
      triageOverride: payload.triageOverride as any,
      confirmedScopeHypothesis: payload.confirmedScopeHypothesis as any,
      discoveryAnswers: payload.discoveryAnswers as any,
    });

    await setProgress(payload.sessionId, result.status === 'complete'
      ? 'Writing the final backlog draft…'
      : 'Preparing the next V2 step…');

    await conversationStore.saveGeneration(payload.sessionId, payload.accountId, {
      sessionId: payload.sessionId,
      projectKey: payload.projectKey,
      projectKeys: payload.projectKeys,
      requirement: payload.requirement,
      status: result.status,
      turnType: result.status === 'complete' ? 'generation' : 'discovery',
      result,
    });

    if (result.status === 'complete') {
      await recordGeneration(payload.config, payload.accountId, payload.sessionId);
    }

    await stateStore.setProgress(payload.sessionId, {
      type: 'complete',
      sessionId: payload.sessionId,
      result,
      updatedAt: Date.now(),
    });
  } catch (error) {
    await releaseGenerationReservation(payload.config, payload.accountId, payload.sessionId);
    await stateStore.setProgress(payload.sessionId, {
      type: 'error',
      sessionId: payload.sessionId,
      message: error instanceof Error ? error.message : 'V2 generation failed.',
      updatedAt: Date.now(),
    });
  }
}
