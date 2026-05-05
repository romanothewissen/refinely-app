import { migrationRunner, sql, type UpdateQueryResponse } from '@forge/sql';
import type {
  ProjectMemoryArtifactHeader,
  ProjectMemoryRefreshTrigger,
  ProjectMemorySelection,
  ProjectMemorySliceType,
} from '../v2/types';

type ConversationStatus =
  | 'preview_ready'
  | 'needs_scope_confirmation'
  | 'needs_discovery'
  | 'discovery_generation_failed'
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

interface ProjectMemoryArtifactRow {
  project_key: string;
  artifact_version: string;
  compiler_version: string;
  status: string;
  built_at: string;
  source_snapshot_json: string | null;
  quality_signals_json: string | null;
  header_json: string | null;
  created_at: string;
  updated_at: string;
}

interface ProjectMemorySliceRow {
  project_key: string;
  artifact_version: string;
  slice_type: string;
  slice_json: string;
  created_at: string;
  updated_at: string;
}

interface ProjectMemoryRefreshStateRow {
  project_key: string;
  active_artifact_version: string | null;
  last_built_at: string | null;
  next_due_at: string | null;
  last_source_hash: string | null;
  last_trigger: string | null;
  status: string;
  last_error: string | null;
  updated_at: string;
}

export interface StoredProjectMemoryArtifact {
  projectKey: string;
  artifactVersion: string;
  compilerVersion: string;
  status: string;
  builtAt: string;
  sourceSnapshot: Record<string, unknown> | null;
  qualitySignals: Record<string, unknown> | null;
  header: ProjectMemoryArtifactHeader | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredProjectMemorySelection {
  artifactVersion: string;
  selection: ProjectMemorySelection;
}

export interface StoredProjectMemoryRefreshState {
  projectKey: string;
  activeArtifactVersion: string | null;
  lastBuiltAt: string | null;
  nextDueAt: string | null;
  lastSourceHash: string | null;
  lastTrigger: ProjectMemoryRefreshTrigger | null;
  status: 'missing' | 'queued' | 'running' | 'ready' | 'error';
  lastError: string | null;
  updatedAt: string;
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
  {
    name: '007_project_memory_artifacts',
    statement: `
      CREATE TABLE IF NOT EXISTS project_memory_artifacts (
        project_key VARCHAR(64) NOT NULL,
        artifact_version VARCHAR(128) NOT NULL,
        compiler_version VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL,
        built_at VARCHAR(40) NOT NULL,
        source_snapshot_json LONGTEXT NULL,
        quality_signals_json LONGTEXT NULL,
        header_json LONGTEXT NULL,
        created_at VARCHAR(40) NOT NULL,
        updated_at VARCHAR(40) NOT NULL,
        PRIMARY KEY (project_key, artifact_version)
      )
    `,
  },
  {
    name: '008_project_memory_slices',
    statement: `
      CREATE TABLE IF NOT EXISTS project_memory_slices (
        project_key VARCHAR(64) NOT NULL,
        artifact_version VARCHAR(128) NOT NULL,
        slice_type VARCHAR(64) NOT NULL,
        slice_json LONGTEXT NOT NULL,
        created_at VARCHAR(40) NOT NULL,
        updated_at VARCHAR(40) NOT NULL,
        PRIMARY KEY (project_key, artifact_version, slice_type)
      )
    `,
  },
  {
    name: '009_project_memory_refresh_state',
    statement: `
      CREATE TABLE IF NOT EXISTS project_memory_refresh_state (
        project_key VARCHAR(64) PRIMARY KEY,
        active_artifact_version VARCHAR(128) NULL,
        last_built_at VARCHAR(40) NULL,
        next_due_at VARCHAR(40) NULL,
        last_source_hash VARCHAR(255) NULL,
        last_trigger VARCHAR(32) NULL,
        status VARCHAR(32) NOT NULL,
        last_error TEXT NULL,
        updated_at VARCHAR(40) NOT NULL
      )
    `,
  },
] as const;

let schemaPromise: Promise<void> | null = null;
let migrationsEnqueued = false;
const SQL_PARAM_SOFT_LIMIT_BYTES = 900 * 1024;
const MAX_PERSISTED_FEATURES = 40;
const MAX_PERSISTED_ARS_PER_FEATURE = 6;

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

function utf8ByteLength(value: string): number {
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(value, 'utf8');
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
  return value.length;
}

function pickSqlErrorDetail(error: unknown): string {
  const candidate = error as {
    message?: unknown;
    code?: unknown;
    debug?: { code?: unknown; message?: unknown; sqlMessage?: unknown } | null;
  };
  const message = typeof candidate?.message === 'string' ? candidate.message : 'Unknown SQL execution error';
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  const debugCode = typeof candidate?.debug?.code === 'string' ? candidate.debug.code : '';
  const debugMessage = typeof candidate?.debug?.message === 'string'
    ? candidate.debug.message
    : (typeof candidate?.debug?.sqlMessage === 'string' ? candidate.debug.sqlMessage : '');
  const parts = [message, code, debugCode, debugMessage].filter(Boolean);
  return parts.join(' | ');
}

function compactLatestResultForSql(latestResult: Record<string, unknown>): Record<string, unknown> {
  const initial = JSON.stringify(latestResult);
  if (utf8ByteLength(initial) <= SQL_PARAM_SOFT_LIMIT_BYTES) return latestResult;

  const reduced: Record<string, unknown> = { ...latestResult };
  const candidateResult = latestResult.result;
  if (candidateResult && typeof candidateResult === 'object') {
    const result = { ...(candidateResult as Record<string, unknown>) };
    const features = Array.isArray(result.features) ? result.features : null;
    if (features && features.length > MAX_PERSISTED_FEATURES) {
      result.features = features.slice(0, MAX_PERSISTED_FEATURES).map((feature) => {
        if (!feature || typeof feature !== 'object') return feature;
        const featureRecord = { ...(feature as Record<string, unknown>) };
        if (Array.isArray(featureRecord.acceptanceRequirements)) {
          featureRecord.acceptanceRequirements = featureRecord.acceptanceRequirements.slice(0, MAX_PERSISTED_ARS_PER_FEATURE);
        }
        return featureRecord;
      });
    }
    reduced.result = result;
  }

  const reducedJson = JSON.stringify(reduced);
  if (utf8ByteLength(reducedJson) <= SQL_PARAM_SOFT_LIMIT_BYTES) {
    return reduced;
  }

  return {
    result: {
      status: (latestResult.result && typeof latestResult.result === 'object')
        ? (latestResult.result as { status?: unknown }).status
        : undefined,
      triage: (latestResult.result && typeof latestResult.result === 'object')
        ? (latestResult.result as { triage?: unknown }).triage
        : undefined,
      scopeHypothesis: (latestResult.result && typeof latestResult.result === 'object')
        ? (latestResult.result as { scopeHypothesis?: unknown }).scopeHypothesis
        : undefined,
    },
    warning: 'Stored V2 conversation payload was compacted to satisfy Forge SQL request limits.',
  };
}

function sanitizeProjectKeys(projectKeys: string[] = []) {
  return [...new Set(projectKeys.map((key) => String(key ?? '').trim()).filter((key) => key && key !== '*'))].slice(0, 2);
}

function compactJsonForSql<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (utf8ByteLength(serialized) <= SQL_PARAM_SOFT_LIMIT_BYTES) return value;
  throw new Error('Payload exceeds Forge SQL parameter soft limit.');
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
  try {
    const result = await sql.prepare<T>(statement).bindParams(...params).execute();
    return result.rows;
  } catch (error) {
    throw new Error(`V2 SQL query failed: ${pickSqlErrorDetail(error)}`);
  }
}

async function executeMutation(statement: string, ...params: unknown[]) {
  try {
    return await sql.prepare<UpdateQueryResponse>(statement).bindParams(...params).execute();
  } catch (error) {
    throw new Error(`V2 SQL mutation failed: ${pickSqlErrorDetail(error)}`);
  }
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

  const payload = JSON.stringify(compactLatestResultForSql(input.latestResult));
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
    JSON.stringify(compactLatestResultForSql(input.latestResult)),
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

function mapProjectMemoryArtifactRow(row: ProjectMemoryArtifactRow): StoredProjectMemoryArtifact {
  return {
    projectKey: row.project_key,
    artifactVersion: row.artifact_version,
    compilerVersion: row.compiler_version,
    status: row.status,
    builtAt: row.built_at,
    sourceSnapshot: parseJson<Record<string, unknown> | null>(row.source_snapshot_json, null),
    qualitySignals: parseJson<Record<string, unknown> | null>(row.quality_signals_json, null),
    header: parseJson<ProjectMemoryArtifactHeader | null>(row.header_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProjectMemoryRefreshStateRow(row: ProjectMemoryRefreshStateRow): StoredProjectMemoryRefreshState {
  const normalizedStatus = row.status === 'queued' || row.status === 'running' || row.status === 'ready' || row.status === 'error'
    ? row.status
    : 'missing';
  const normalizedTrigger = row.last_trigger === 'weekly' || row.last_trigger === 'manual' || row.last_trigger === 'threshold'
    ? row.last_trigger
    : null;
  return {
    projectKey: row.project_key,
    activeArtifactVersion: row.active_artifact_version,
    lastBuiltAt: row.last_built_at,
    nextDueAt: row.next_due_at,
    lastSourceHash: row.last_source_hash,
    lastTrigger: normalizedTrigger,
    status: normalizedStatus,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

export async function saveProjectMemoryArtifact(input: {
  projectKey: string;
  artifactVersion: string;
  compilerVersion: string;
  builtAt: string;
  sourceSnapshot: Record<string, unknown>;
  qualitySignals: Record<string, unknown>;
  header: ProjectMemoryArtifactHeader;
  selection: ProjectMemorySelection;
  sourceHash: string;
  trigger: ProjectMemoryRefreshTrigger;
  nextDueAt: string;
}): Promise<void> {
  await ensureV2SqlSchema();
  const now = new Date().toISOString();
  const existingArtifact = await queryRows<Pick<ProjectMemoryArtifactRow, 'project_key'>>(
    'SELECT project_key FROM project_memory_artifacts WHERE project_key = ? AND artifact_version = ? LIMIT 1',
    input.projectKey,
    input.artifactVersion,
  );

  const sourceSnapshotJson = JSON.stringify(compactJsonForSql(input.sourceSnapshot));
  const qualitySignalsJson = JSON.stringify(compactJsonForSql(input.qualitySignals));
  const headerJson = JSON.stringify(compactJsonForSql(input.header));

  if (existingArtifact.length) {
    await executeMutation(
      `
        UPDATE project_memory_artifacts
        SET compiler_version = ?, status = ?, built_at = ?, source_snapshot_json = ?, quality_signals_json = ?, header_json = ?, updated_at = ?
        WHERE project_key = ? AND artifact_version = ?
      `,
      input.compilerVersion,
      'ready',
      input.builtAt,
      sourceSnapshotJson,
      qualitySignalsJson,
      headerJson,
      now,
      input.projectKey,
      input.artifactVersion,
    );
    await executeMutation(
      'DELETE FROM project_memory_slices WHERE project_key = ? AND artifact_version = ?',
      input.projectKey,
      input.artifactVersion,
    );
  } else {
    await executeMutation(
      `
        INSERT INTO project_memory_artifacts (
          project_key,
          artifact_version,
          compiler_version,
          status,
          built_at,
          source_snapshot_json,
          quality_signals_json,
          header_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      input.projectKey,
      input.artifactVersion,
      input.compilerVersion,
      'ready',
      input.builtAt,
      sourceSnapshotJson,
      qualitySignalsJson,
      headerJson,
      now,
      now,
    );
  }

  const sliceEntries = Object.entries(input.selection)
    .filter(([key, value]) => key !== 'artifactVersion' && value !== undefined)
    .map(([key, value]) => ({ sliceType: key as ProjectMemorySliceType, sliceJson: JSON.stringify(compactJsonForSql(value)) }));

  for (const entry of sliceEntries) {
    await executeMutation(
      `
        INSERT INTO project_memory_slices (
          project_key,
          artifact_version,
          slice_type,
          slice_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      input.projectKey,
      input.artifactVersion,
      entry.sliceType,
      entry.sliceJson,
      now,
      now,
    );
  }

  await upsertProjectMemoryRefreshState({
    projectKey: input.projectKey,
    activeArtifactVersion: input.artifactVersion,
    lastBuiltAt: input.builtAt,
    nextDueAt: input.nextDueAt,
    lastSourceHash: input.sourceHash,
    lastTrigger: input.trigger,
    status: 'ready',
    lastError: null,
  });
}

export async function upsertProjectMemoryRefreshState(input: {
  projectKey: string;
  activeArtifactVersion?: string | null;
  lastBuiltAt?: string | null;
  nextDueAt?: string | null;
  lastSourceHash?: string | null;
  lastTrigger?: ProjectMemoryRefreshTrigger | null;
  status: 'missing' | 'queued' | 'running' | 'ready' | 'error';
  lastError?: string | null;
}): Promise<void> {
  await ensureV2SqlSchema();
  const now = new Date().toISOString();
  const existing = await queryRows<ProjectMemoryRefreshStateRow>(
    'SELECT project_key, active_artifact_version, last_built_at, next_due_at, last_source_hash, last_trigger, status, last_error, updated_at FROM project_memory_refresh_state WHERE project_key = ? LIMIT 1',
    input.projectKey,
  );

  if (existing.length) {
    const row = existing[0]!;
    await executeMutation(
      `
        UPDATE project_memory_refresh_state
        SET active_artifact_version = ?, last_built_at = ?, next_due_at = ?, last_source_hash = ?, last_trigger = ?, status = ?, last_error = ?, updated_at = ?
        WHERE project_key = ?
      `,
      input.activeArtifactVersion ?? row.active_artifact_version,
      input.lastBuiltAt ?? row.last_built_at,
      input.nextDueAt ?? row.next_due_at,
      input.lastSourceHash ?? row.last_source_hash,
      input.lastTrigger ?? row.last_trigger,
      input.status,
      input.lastError ?? null,
      now,
      input.projectKey,
    );
    return;
  }

  await executeMutation(
    `
      INSERT INTO project_memory_refresh_state (
        project_key,
        active_artifact_version,
        last_built_at,
        next_due_at,
        last_source_hash,
        last_trigger,
        status,
        last_error,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    input.projectKey,
    input.activeArtifactVersion ?? null,
    input.lastBuiltAt ?? null,
    input.nextDueAt ?? null,
    input.lastSourceHash ?? null,
    input.lastTrigger ?? null,
    input.status,
    input.lastError ?? null,
    now,
  );
}

export async function getProjectMemoryRefreshState(projectKey: string): Promise<StoredProjectMemoryRefreshState | null> {
  await ensureV2SqlSchema();
  const rows = await queryRows<ProjectMemoryRefreshStateRow>(
    'SELECT project_key, active_artifact_version, last_built_at, next_due_at, last_source_hash, last_trigger, status, last_error, updated_at FROM project_memory_refresh_state WHERE project_key = ? LIMIT 1',
    projectKey,
  );
  const row = rows[0];
  return row ? mapProjectMemoryRefreshStateRow(row) : null;
}

export async function listProjectMemoryRefreshStates(limit = 250): Promise<StoredProjectMemoryRefreshState[]> {
  await ensureV2SqlSchema();
  const rows = await queryRows<ProjectMemoryRefreshStateRow>(
    `
      SELECT project_key, active_artifact_version, last_built_at, next_due_at, last_source_hash, last_trigger, status, last_error, updated_at
      FROM project_memory_refresh_state
      ORDER BY updated_at DESC
      LIMIT ?
    `,
    limit,
  );
  return rows.map(mapProjectMemoryRefreshStateRow);
}

export async function getActiveProjectMemoryArtifact(projectKey: string): Promise<StoredProjectMemoryArtifact | null> {
  await ensureV2SqlSchema();
  const refreshState = await getProjectMemoryRefreshState(projectKey);
  if (!refreshState?.activeArtifactVersion) return null;
  const rows = await queryRows<ProjectMemoryArtifactRow>(
    `
      SELECT project_key, artifact_version, compiler_version, status, built_at, source_snapshot_json, quality_signals_json, header_json, created_at, updated_at
      FROM project_memory_artifacts
      WHERE project_key = ? AND artifact_version = ?
      LIMIT 1
    `,
    projectKey,
    refreshState.activeArtifactVersion,
  );
  const row = rows[0];
  return row ? mapProjectMemoryArtifactRow(row) : null;
}

export async function getActiveProjectMemorySelection(
  projectKey: string,
  sliceTypes: ProjectMemorySliceType[],
): Promise<StoredProjectMemorySelection | null> {
  await ensureV2SqlSchema();
  const refreshState = await getProjectMemoryRefreshState(projectKey);
  if (!refreshState?.activeArtifactVersion) return null;

  const selection: ProjectMemorySelection = {
    artifactVersion: refreshState.activeArtifactVersion,
  };
  for (const sliceType of sliceTypes) {
    const rows = await queryRows<ProjectMemorySliceRow>(
      `
        SELECT project_key, artifact_version, slice_type, slice_json, created_at, updated_at
        FROM project_memory_slices
        WHERE project_key = ? AND artifact_version = ? AND slice_type = ?
        LIMIT 1
      `,
      projectKey,
      refreshState.activeArtifactVersion,
      sliceType,
    );
    const row = rows[0];
    if (!row) continue;
    (selection as Record<string, unknown>)[sliceType] = parseJson<unknown>(row.slice_json, null);
  }
  return {
    artifactVersion: refreshState.activeArtifactVersion,
    selection,
  };
}
