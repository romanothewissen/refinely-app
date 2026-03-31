/**
 * Helpers for Forge Storage (key-value store).
 *
 * storage.set/get/delete → Forge Custom Storage (per-installation, isolated)
 * storage.entity(name) → named entity namespace for larger structured data
 */

import { storage } from '@forge/api';

// ─── Simple key-value storage ─────────────────────────────────────────────────

export async function entitySet(key: string, value: unknown): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await storage.set(key, value as any);
}

export async function entityGet<T = unknown>(key: string): Promise<T | undefined> {
  return storage.get(key) as Promise<T | undefined>;
}

export async function entityDelete(key: string): Promise<void> {
  await storage.delete(key);
}

// ─── Object Store (large data — store as base64-encoded JSON) ─────────────────

export async function objectWrite(key: string, data: unknown): Promise<boolean> {
  try {
    const bytes = Buffer.from(JSON.stringify(data), 'utf8');
    await storage.set(key, bytes.toString('base64'));
    return true;
  } catch (err) {
    console.error(`[cache] objectWrite failed for key=${key}:`, err);
    return false;
  }
}

export async function objectRead<T = unknown>(key: string): Promise<T | null> {
  try {
    const encoded = await storage.get(key) as string | undefined;
    if (!encoded) return null;
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as T;
  } catch (err) {
    console.error(`[cache] objectRead failed for key=${key}:`, err);
    return null;
  }
}

export async function objectDelete(key: string): Promise<void> {
  try {
    await storage.delete(key);
  } catch {
    // ignore
  }
}

// ─── Convenience keys ─────────────────────────────────────────────────────────

export const KEYS = {
  tenantConfig: 'tenant_config',
  goldStandards: 'gold_standards',
  goldCacheInfo: 'gold_cache_info',
  backlogIndex: (projectKey: string) => `backlog_index_${projectKey}`,
  wiChunks: 'wi_chunks',
  wiDocs: 'wi_docs',
  usageCurrentMonth: 'usage_current_month',
  // site-scoped (no accountId) — kept for backward compat
  conversations: (sessionId: string) => `conv_${sessionId}`,
  conversationIndex: 'conv_index',
  generationProgress: (sessionId: string) => `gen_progress_${sessionId}`,
  clarifyProgress: (sessionId: string) => `clarify_progress_${sessionId}`,
  userLastSession: (accountId: string) => `u_${accountId}_last_session`,
  userIssueSession: (accountId: string, issueKey: string) => `u_${accountId}_issue_${issueKey}`,
  // per-user scoped
  userConversations: (accountId: string, sessionId: string) => `u_${accountId}_conv_${sessionId}`,
  userConversationIndex: (accountId: string) => `u_${accountId}_conv_index`,
  complianceAuditTrail: 'compliance_audit_trail',
  transparencyReports: 'transparency_reports',
  complianceRuntimeVersion: 'compliance_runtime_version',
  aiSessionInsights: 'ai_session_insights',
} as const;
