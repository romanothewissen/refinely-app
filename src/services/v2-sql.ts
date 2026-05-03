import { migrationRunner, sql, type Result, type UpdateQueryResponse } from '@forge/sql';

type ConversationStatus =
  | 'preview_ready'
  | 'needs_scope_confirmation'
  | 'needs_discovery'
  | 'complete';

interface ConversationRow {
  session_id: string;
  account_id: string;
  title: string;
  requirement: string;
  status: ConversationStatus;
  project_key: string | null;
  project_keys_json: string | null;
  latest_result_json: string | null;
  created_at: string;
  updated_at: string;
}

interface TurnRow {
  turn_id: string;
  session_id: string;
  account_id: string;
  turn_type: string;
  payload_json: string;
  created_at: string;
}

export interface V2ConversationHistoryEntry {
  sessionId: string;
  title: string;
  requirement: string;
  status: ConversationStatus;
  projectKey: string | null;
  projectKeys: string[];
  createdAt: string;
  updatedAt: string;
}

export interface V2ConversationRecord extends V2ConversationHistoryEntry {
  latestResult: Record<string, unknown> | null;
  turns: Array<{
    turnId: string;
    turnType: string;
    createdAt: string;
    payload: Record<string, unknown>;
  }>;
}

export interface SaveV2ConversationInput {
  sessionId: string;
  accountId: string;
  projectKey?: string | null;
  projectKeys?: string[];
  requirement: string;
  title?: string;
  status: ConversationStatus;
  latestResult: Record<string, unknown>;
  turnType: 'preview' | 'discovery' | 'generation';
}

const MIGRATIONS = [
  {
    name: '001_v2_conversations',
    statement: `
      CREATE TABLE IF NOT EXISTS v2_conversations (
        session_id VARCHAR(128) PRIMARY KEY,
        account_id VARCHAR(255) NOT NULL,
        title VARCHAR(255) NOT NULL,
        requirement TEXT NOT NULL,
        status VARCHAR(64) NOT NULL,
        project_key VARCHAR(64) NULL,
        project_keys_json TEXT NULL,
        latest_result_json LONGTEXT NULL,
        created_at VARCHAR(40) NOT NULL,
        updated_at VARCHAR(40) NOT NULL
      )
    `,
  },
  {
    name: '002_v2_conversations_account_updated_idx',
    statement: 'CREATE INDEX IF NOT EXISTS idx_v2_conversations_account_updated ON v2_conversations (account_id, updated_at)',
  },
  {
    name: '003_v2_turns',
    statement: `
      CREATE TABLE IF NOT EXISTS v2_conversation_turns (
        turn_id VARCHAR(128) PRIMARY KEY,
        session_id VARCHAR(128) NOT NULL,
        account_id VARCHAR(255) NOT NULL,
        turn_type VARCHAR(64) NOT NULL,
        payload_json LONGTEXT NOT NULL,
        created_at VARCHAR(40) NOT NULL
      )
    `,
  },
  {
    name: '004_v2_turns_session_created_idx',
    statement: 'CREATE INDEX IF NOT EXISTS idx_v2_turns_session_created ON v2_conversation_turns (session_id, created_at)',
  },
  {
    name: '005_v2_benchmark_examples',
    statement: `
      CREATE TABLE IF NOT EXISTS v2_benchmark_examples (
        example_id VARCHAR(128) PRIMARY KEY,
        source VARCHAR(128) NOT NULL,
        summary TEXT NOT NULL,
        description LONGTEXT NOT NULL,
        acceptance_requirements_json LONGTEXT NOT NULL,
        metadata_json LONGTEXT NULL,
        created_at VARCHAR(40) NOT NULL,
        updated_at VARCHAR(40) NOT NULL
      )
    `,
  },
  {
    name: '006_v2_benchmark_runs',
    statement: `
      CREATE TABLE IF NOT EXISTS v2_benchmark_runs (
        run_id VARCHAR(128) PRIMARY KEY,
        example_id VARCHAR(128) NOT NULL,
        model VARCHAR(255) NOT NULL,
        status VARCHAR(64) NOT NULL,
        scores_json LONGTEXT NULL,
        payload_json LONGTEXT NULL,
        created_at VARCHAR(40) NOT NULL
      )
    `,
  },
] as const;

let schemaPromise: Promise<void> | null = null;
let migrationsEnqueued = false;

function enqueueMigrations() {
  if (migrationsEnqueued) return;
  MIGRATIONS.forEach((migration) => {
    migrationRunner.enqueue(migration.name, migration.statement);
  });
  migrationsEnqueued = true;
}

export async function ensureV2SqlSchema() {
  if (!schemaPromise) {
    enqueueMigrations();
    schemaPromise = (async () => {
      await migrationRunner.initialize();
      await migrationRunner.run();
    })();
  }
  return await schemaPromise;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function sanitizeProjectKeys(projectKeys: string[] = []) {
  return [...new Set(projectKeys.map((key) => String(key ?? '').trim()).filter((key) => key && key !== '*'))].slice(0, 2);
}

function deriveConversationTitle(input: { title?: string; requirement: string; latestResult: Record<string, unknown> }) {
  const explicitTitle = String(input.title ?? '').trim();
  if (explicitTitle) return explicitTitle.slice(0, 255);

  const scopeCapabilities = Array.isArray((input.latestResult as { scopeHypothesis?: { capabilities?: Array<{ label?: string }> } })?.scopeHypothesis?.capabilities)
    ? (input.latestResult as { scopeHypothesis?: { capabilities?: Array<{ label?: string }> } }).scopeHypothesis?.capabilities ?? []
    : [];
  const firstCapability = String(scopeCapabilities[0]?.label ?? '').trim();
  if (firstCapability) return firstCapability.slice(0, 255);

  const featureSummary = Array.isArray((input.latestResult as { features?: Array<{ summary?: string }> })?.features)
    ? String((input.latestResult as { features?: Array<{ summary?: string }> }).features?.[0]?.summary ?? '').trim()
    : '';
  if (featureSummary) return featureSummary.slice(0, 255);

  return input.requirement.replace(/\s+/g, ' ').trim().slice(0, 255) || 'Untitled V2 session';
}

async function queryRows<T>(statement: string, ...params: unknown[]) {
  const result = await sql.prepare<T>(statement).bindParams(...params).execute();
  return result.rows;
}

async function executeMutation(statement: string, ...params: unknown[]) {
  return await sql.prepare<UpdateQueryResponse>(statement).bindParams(...params).execute();
}

async function upsertConversation(input: SaveV2ConversationInput) {
  const now = new Date().toISOString();
  const projectKeys = sanitizeProjectKeys(input.projectKeys);
  const title = deriveConversationTitle(input);
  const existing = await queryRows<Pick<ConversationRow, 'session_id'>>(
    'SELECT session_id FROM v2_conversations WHERE session_id = ? AND account_id = ? LIMIT 1',
    input.sessionId,
    input.accountId,
  );

  const payload = JSON.stringify(input.latestResult);
  if (existing.length) {
    await executeMutation(
      `
        UPDATE v2_conversations
        SET title = ?, requirement = ?, status = ?, project_key = ?, project_keys_json = ?, latest_result_json = ?, updated_at = ?
        WHERE session_id = ? AND account_id = ?
      `,
      title,
      input.requirement,
      input.status,
      input.projectKey ?? null,
      JSON.stringify(projectKeys),
      payload,
      now,
      input.sessionId,
      input.accountId,
    );
    return;
  }

  await executeMutation(
    `
      INSERT INTO v2_conversations (
        session_id,
        account_id,
        title,
        requirement,
        status,
        project_key,
        project_keys_json,
        latest_result_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    input.sessionId,
    input.accountId,
    title,
    input.requirement,
    input.status,
    input.projectKey ?? null,
    JSON.stringify(projectKeys),
    payload,
    now,
    now,
  );
}

async function insertTurn(input: SaveV2ConversationInput) {
  const turnId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `v2_turn_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  await executeMutation(
    `
      INSERT INTO v2_conversation_turns (
        turn_id,
        session_id,
        account_id,
        turn_type,
        payload_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    turnId,
    input.sessionId,
    input.accountId,
    input.turnType,
    JSON.stringify(input.latestResult),
    new Date().toISOString(),
  );
}

export async function saveV2Conversation(input: SaveV2ConversationInput) {
  await ensureV2SqlSchema();
  await upsertConversation(input);
  await insertTurn(input);
}

export async function listV2Conversations(accountId: string, limit = 30): Promise<V2ConversationHistoryEntry[]> {
  await ensureV2SqlSchema();
  const rows = await queryRows<ConversationRow>(
    `
      SELECT session_id, account_id, title, requirement, status, project_key, project_keys_json, latest_result_json, created_at, updated_at
      FROM v2_conversations
      WHERE account_id = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `,
    accountId,
    limit,
  );

  return rows.map((row) => ({
    sessionId: row.session_id,
    title: row.title,
    requirement: row.requirement,
    status: row.status,
    projectKey: row.project_key,
    projectKeys: parseJson<string[]>(row.project_keys_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getV2Conversation(accountId: string, sessionId: string): Promise<V2ConversationRecord | null> {
  await ensureV2SqlSchema();
  const rows = await queryRows<ConversationRow>(
    `
      SELECT session_id, account_id, title, requirement, status, project_key, project_keys_json, latest_result_json, created_at, updated_at
      FROM v2_conversations
      WHERE session_id = ? AND account_id = ?
      LIMIT 1
    `,
    sessionId,
    accountId,
  );
  const row = rows[0];
  if (!row) return null;

  const turns = await queryRows<TurnRow>(
    `
      SELECT turn_id, session_id, account_id, turn_type, payload_json, created_at
      FROM v2_conversation_turns
      WHERE session_id = ? AND account_id = ?
      ORDER BY created_at ASC
    `,
    sessionId,
    accountId,
  );

  return {
    sessionId: row.session_id,
    title: row.title,
    requirement: row.requirement,
    status: row.status,
    projectKey: row.project_key,
    projectKeys: parseJson<string[]>(row.project_keys_json, []),
    latestResult: parseJson<Record<string, unknown> | null>(row.latest_result_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    turns: turns.map((turn) => ({
      turnId: turn.turn_id,
      turnType: turn.turn_type,
      createdAt: turn.created_at,
      payload: parseJson<Record<string, unknown>>(turn.payload_json, {}),
    })),
  };
}

export async function deleteV2Conversation(accountId: string, sessionId: string) {
  await ensureV2SqlSchema();
  await executeMutation('DELETE FROM v2_conversation_turns WHERE session_id = ? AND account_id = ?', sessionId, accountId);
  await executeMutation('DELETE FROM v2_conversations WHERE session_id = ? AND account_id = ?', sessionId, accountId);
}
