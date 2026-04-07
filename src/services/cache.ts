/**
 * Helpers for Forge Key-Value Store.
 *
 * kvs.set/get/delete → Forge-hosted storage (per-installation, isolated)
 */

import { kvs } from '@forge/kvs';

// ─── Simple key-value storage ─────────────────────────────────────────────────

export async function entitySet(key: string, value: unknown): Promise<void> {
  if (value === undefined || value === null) {
    console.warn(`[cache] entitySet called with null/undefined value for key=${key}, skipping write`);
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await kvs.set(key, value as any);
}

export async function entityGet<T = unknown>(key: string): Promise<T | undefined> {
  return kvs.get<T>(key);
}

export async function entityDelete(key: string): Promise<void> {
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
    const bytes = Buffer.from(JSON.stringify(data), 'utf8');
    await kvs.set(key, bytes.toString('base64'));
    return true;
  } catch (err) {
    console.error(`[cache] objectWrite failed for key=${key}:`, err);
    return false;
  }
}

export async function objectRead<T = unknown>(key: string): Promise<T | null> {
  try {
    const encoded = await kvs.get<string>(key);
    if (!encoded) return null;
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as T;
  } catch (err) {
    console.error(`[cache] objectRead failed for key=${key}:`, err);
    return null;
  }
}

export async function objectDelete(key: string): Promise<void> {
  try {
    await kvs.delete(key);
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
} as const;
