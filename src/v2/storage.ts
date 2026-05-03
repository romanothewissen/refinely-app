import { entityDelete, entityGet, entitySetSmall } from '../services/cache';
import { saveV2Conversation } from '../services/v2-sql';
import type { V2ConversationStore, V2WorkflowStateStore } from './types';

const V2_PROGRESS_PREFIX = 'v2_progress_';

export function createV2EphemeralWorkflowStateStore(): V2WorkflowStateStore {
  return {
    async getProgress(sessionId: string) {
      return await entityGet<Record<string, unknown>>(`${V2_PROGRESS_PREFIX}${sessionId}`) ?? null;
    },
    async setProgress(sessionId: string, payload: Record<string, unknown>) {
      await entitySetSmall(`${V2_PROGRESS_PREFIX}${sessionId}`, payload);
    },
    async clearProgress(sessionId: string) {
      await entityDelete(`${V2_PROGRESS_PREFIX}${sessionId}`);
    },
  };
}

export function createSqlConversationStore(): V2ConversationStore {
  return {
    async savePreview(sessionId, accountId, payload) {
      await saveV2Conversation({
        sessionId,
        accountId,
        projectKey: String(payload.projectKey ?? '*'),
        projectKeys: Array.isArray(payload.projectKeys) ? payload.projectKeys.map((key) => String(key ?? '')) : [],
        requirement: String(payload.requirement ?? ''),
        title: typeof payload.title === 'string' ? payload.title : undefined,
        status: String(payload.status ?? 'preview_ready') as 'preview_ready' | 'needs_scope_confirmation' | 'needs_discovery' | 'complete',
        latestResult: payload,
        turnType: String(payload.turnType ?? 'preview') as 'preview' | 'discovery' | 'generation',
      });
    },
    async saveGeneration(sessionId, accountId, payload) {
      await saveV2Conversation({
        sessionId,
        accountId,
        projectKey: String(payload.projectKey ?? '*'),
        projectKeys: Array.isArray(payload.projectKeys) ? payload.projectKeys.map((key) => String(key ?? '')) : [],
        requirement: String(payload.requirement ?? ''),
        title: typeof payload.title === 'string' ? payload.title : undefined,
        status: String(payload.status ?? 'complete') as 'preview_ready' | 'needs_scope_confirmation' | 'needs_discovery' | 'complete',
        latestResult: payload,
        turnType: String(payload.turnType ?? 'generation') as 'preview' | 'discovery' | 'generation',
      });
    },
  };
}
