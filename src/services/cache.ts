/**
 * Helpers for Forge Key-Value Store.
 *
 * kvs.set/get/delete → Forge-hosted storage (per-installation, isolated)
 */

import { kvs } from '@forge/kvs';

const LARGE_VALUE_POINTER_VERSION = 1;
const INLINE_VALUE_CHAR_LIMIT = 200000;
const SHARD_VALUE_CHAR_LIMIT = 160000;

type LargeValuePointer = {
  __largeValue: true;
  version: number;
  storageKey: string;
  shardCount: number;
};

function isLargeValuePointer(value: unknown): value is LargeValuePointer {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as { __largeValue?: boolean }).__largeValue === true
    && typeof (value as { storageKey?: unknown }).storageKey === 'string'
    && typeof (value as { shardCount?: unknown }).shardCount === 'number',
  );
}

function buildLargeValueManifestKey(storageKey: string): string {
  return `${storageKey}__manifest`;
}

function buildLargeValueShardKey(storageKey: string, index: number): string {
  return `${storageKey}__chunk_${index}`;
}

function splitSerializedValue(serialized: string, maxChars = SHARD_VALUE_CHAR_LIMIT): string[] {
  if (!serialized) return [''];

  const shards: string[] = [];
  for (let index = 0; index < serialized.length; index += maxChars) {
    shards.push(serialized.slice(index, index + maxChars));
  }
  return shards;
}

async function deleteLargeValueStorage(storageKey: string, shardCount: number): Promise<void> {
  await Promise.all([
    kvs.delete(buildLargeValueManifestKey(storageKey)),
    ...Array.from({ length: shardCount }, (_, index) => kvs.delete(buildLargeValueShardKey(storageKey, index))),
  ]);
}

async function writeLargeValue(storageKey: string, serialized: string): Promise<LargeValuePointer> {
  const shards = splitSerializedValue(serialized);
  await kvs.set(buildLargeValueManifestKey(storageKey), {
    version: LARGE_VALUE_POINTER_VERSION,
    storageKey,
    shardCount: shards.length,
  });
  await Promise.all(
    shards.map((shard, index) => kvs.set(buildLargeValueShardKey(storageKey, index), shard)),
  );
  return {
    __largeValue: true,
    version: LARGE_VALUE_POINTER_VERSION,
    storageKey,
    shardCount: shards.length,
  };
}

async function readLargeValue(pointer: LargeValuePointer): Promise<string | null> {
  const shards = await Promise.all(
    Array.from({ length: pointer.shardCount }, (_, index) => kvs.get<string>(buildLargeValueShardKey(pointer.storageKey, index))),
  );
  if (shards.some((shard) => typeof shard !== 'string')) return null;
  return shards.join('');
}

// ─── Simple key-value storage ─────────────────────────────────────────────────

export async function entitySet(key: string, value: unknown): Promise<void> {
  if (value === undefined || value === null) {
    console.warn(`[cache] entitySet called with null/undefined value for key=${key}, skipping write`);
    return;
  }
  const existing = await kvs.get<unknown>(key);
  const serialized = JSON.stringify(value);

  if (serialized.length <= INLINE_VALUE_CHAR_LIMIT) {
    if (isLargeValuePointer(existing)) {
      await deleteLargeValueStorage(existing.storageKey, existing.shardCount);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await kvs.set(key, value as any);
    return;
  }

  const storageKey = `${key}__large`;
  if (isLargeValuePointer(existing)) {
    await deleteLargeValueStorage(existing.storageKey, existing.shardCount);
  }
  const pointer = await writeLargeValue(storageKey, serialized);
  await kvs.set(key, pointer);
}

export async function entityGet<T = unknown>(key: string): Promise<T | undefined> {
  const stored = await kvs.get<unknown>(key);
  if (!isLargeValuePointer(stored)) {
    return stored as T | undefined;
  }

  const serialized = await readLargeValue(stored);
  if (serialized == null) return undefined;

  try {
    return JSON.parse(serialized) as T;
  } catch (err) {
    console.error(`[cache] entityGet failed to parse sharded value for key=${key}:`, err);
    return undefined;
  }
}

export async function entityDelete(key: string): Promise<void> {
  const existing = await kvs.get<unknown>(key);
  if (isLargeValuePointer(existing)) {
    await deleteLargeValueStorage(existing.storageKey, existing.shardCount);
  }
  await kvs.delete(key);
}

export async function entitySetSecret(key: string, value: string): Promise<void> {
  if (!value) {
    await kvs.deleteSecret(key);
    return;
  }
  await kvs.setSecret(key, value);
}

export async function entityGetSecret(key: string): Promise<string | undefined> {
  return kvs.getSecret<string>(key);
}

export async function entityDeleteSecret(key: string): Promise<void> {
  await kvs.deleteSecret(key);
}

// ─── Object Store (large data — store as base64-encoded JSON) ─────────────────

export async function objectWrite(key: string, data: unknown): Promise<boolean> {
  try {
    await entitySet(key, data);
    return true;
  } catch (err) {
    console.error(`[cache] objectWrite failed for key=${key}:`, err);
    return false;
  }
}

export async function objectRead<T = unknown>(key: string): Promise<T | null> {
  try {
    const value = await entityGet<T>(key);
    return value ?? null;
  } catch (err) {
    console.error(`[cache] objectRead failed for key=${key}:`, err);
    return null;
  }
}

export async function objectDelete(key: string): Promise<void> {
  try {
    await entityDelete(key);
  } catch {
    // ignore
  }
}

// ─── Convenience keys ─────────────────────────────────────────────────────────

export const KEYS = {
  tenantConfig: 'tenant_config',
  backlogIndex: (projectKey: string) => `backlog_index_${projectKey}`,
  backlogManifest: (projectKey: string) => `backlog_manifest_${projectKey}`,
  backlogDocsShard: (projectKey: string, shardId: string) => `backlog_docs_${projectKey}_${shardId}`,
  backlogThemes: (projectKey: string) => `backlog_themes_${projectKey}`,
  backlogRefreshStatus: (projectKey: string) => `backlog_refresh_status_${projectKey}`,
  wiChunks: 'wi_chunks',
  wiChunksForDoc: (docId: string) => `wi_chunks_${docId}`,
  wiDocs: 'wi_docs',
  usageCurrentMonth: 'usage_current_month',
  // site-scoped (no accountId) — kept for backward compat
  conversations: (sessionId: string) => `conv_${sessionId}`,
  conversationIndex: 'conv_index',
  generationProgress: (sessionId: string) => `gen_progress_${sessionId}`,
  clarifyProgress: (sessionId: string) => `clarify_progress_${sessionId}`,
  refineProgress: (sessionId: string) => `refine_progress_${sessionId}`,
  quickRefineSession: (sessionId: string) => `quick_refine_${sessionId}`,
  userLastSession: (accountId: string) => `u_${accountId}_last_session`,
  userIssueSession: (accountId: string, issueKey: string) => `u_${accountId}_issue_${issueKey}`,
  userPreferences: (accountId: string) => `u_${accountId}_preferences`,
  // per-user scoped
  userConversations: (accountId: string, sessionId: string) => `u_${accountId}_conv_${sessionId}`,
  userConversationIndex: (accountId: string) => `u_${accountId}_conv_index`,
  complianceAuditTrail: 'compliance_audit_trail',
  transparencyReports: 'transparency_reports',
  complianceRuntimeVersion: 'compliance_runtime_version',
  projectActivity: 'project_activity',
  providerApiKey: (provider: 'anthropic' | 'gemini' | 'openai' | 'azure_openai') => `provider_api_key_${provider}`,
  pipelineAudit: (sessionId: string, auditRunId: string) => `pipeline_audit_${sessionId}_${auditRunId}`,
} as const;
