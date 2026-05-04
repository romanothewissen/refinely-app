import { recordGeneration, releaseGenerationReservation } from '../services/billing';
import { loadProjectMemoryRuntimeContext } from '../services/project-memory-runtime';
import {
  getPipelineAuditWriter,
  isPipelineAuditRequested,
  runWithPipelineAuditContext,
} from '../services/pipeline-audit-context';
import { buildV2AuditBasePatch, buildV2AuditResultPatch } from '../services/v2-pipeline-audit';
import {
  buildV2CompletionEvent,
  buildV2ErrorEvent,
  buildV2ProgressEvent,
} from '../v2/progress';
import { runV2Pipeline } from '../v2/pipeline';
import { createSqlConversationStore, createV2EphemeralWorkflowStateStore } from '../v2/storage';
import type { V2PipelineProgressUpdate } from '../v2/types';

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
  pipelineAudit?: boolean;
  auditRunId?: string;
}

async function setProgress(
  sessionId: string,
  update: V2PipelineProgressUpdate,
) {
  const stateStore = createV2EphemeralWorkflowStateStore();
  await stateStore.setProgress(sessionId, buildV2ProgressEvent(sessionId, update));
}

export async function handler(event: { body: V2GenerationEventBody }) {
  const payload = event.body;
  const stateStore = createV2EphemeralWorkflowStateStore();
  const conversationStore = createSqlConversationStore();
  const auditMeta = isPipelineAuditRequested(payload.config, payload.pipelineAudit, payload.auditRunId)
    ? { sessionId: payload.sessionId, auditRunId: String(payload.auditRunId), accountId: payload.accountId }
    : null;

  const runQueuedGeneration = async () => {
    await setProgress(payload.sessionId, {
      stage: 'context',
      message: 'Loading compiled project memory…',
    });
    const {
      memoryHeader: header,
      memoryStatus: status,
      memorySelection,
    } = await loadProjectMemoryRuntimeContext({
      projectKeys: payload.projectKeys ?? [],
      memoryStage: 'discovery_synthesis',
      requestedBy: payload.accountId,
    });

    const result = await runV2Pipeline({
      requirement: payload.requirement,
      attachmentText: payload.attachmentText,
      config: payload.config,
      domainContext: payload.domainContext,
      domainRoles: payload.domainRoles,
      memoryHeader: header,
      memorySelection,
      memoryStatus: status,
      triageOverride: payload.triageOverride as any,
      confirmedScopeHypothesis: payload.confirmedScopeHypothesis as any,
      discoveryAnswers: payload.discoveryAnswers as any,
    }, undefined, async (update) => {
      await setProgress(payload.sessionId, update);
    });

    const auditWriter = getPipelineAuditWriter();
    if (auditWriter) {
      await auditWriter.flushMerge({
        ...buildV2AuditBasePatch({
          accountId: payload.accountId,
          projectKey: payload.projectKey,
          projectKeys: payload.projectKeys,
          config: payload.config,
          requirement: payload.requirement,
          attachmentText: payload.attachmentText,
        }),
        ...buildV2AuditResultPatch({
          result,
          discoveryAnswers: Array.isArray(payload.discoveryAnswers) ? payload.discoveryAnswers as any : undefined,
        }),
      });
    }

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

    await stateStore.setProgress(
      payload.sessionId,
      buildV2CompletionEvent(payload.sessionId, result.status === 'complete' ? 'complete' : 'needs_discovery'),
    );
  };

  try {
    if (auditMeta) {
      await runWithPipelineAuditContext(auditMeta, runQueuedGeneration);
    } else {
      await runQueuedGeneration();
    }
  } catch (error) {
    await releaseGenerationReservation(payload.config, payload.accountId, payload.sessionId);
    await stateStore.setProgress(
      payload.sessionId,
      buildV2ErrorEvent(payload.sessionId, error instanceof Error ? error.message : 'V2 generation failed.'),
    );
  }
}
