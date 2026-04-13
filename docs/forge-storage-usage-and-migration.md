# Forge Storage Usage and Migration Options

This document operationalizes the storage-cost plan for this repository and tracks the implemented low-risk reductions.

## 1) Current KVS inventory and flow-level usage

### Key domains

- **Configuration and secrets**
  - `tenant_config`, `provider_api_key_*`
  - Source: `src/services/tenant-config.ts`, `src/services/cache.ts`
- **Workflow progress and cancellation**
  - `gen_progress_<sessionId>`, `clarify_progress_<sessionId>`, `refine_progress_<sessionId>`
  - Source: `src/resolvers/index.ts`, `src/queues/*.ts`
- **Conversation/session persistence**
  - `u_<accountId>_conv_<sessionId>`, `u_<accountId>_conv_index`
  - `u_<accountId>_last_session`, `u_<accountId>_issue_<issueKey>`
  - Source: `src/resolvers/index.ts`, `src/queues/generation.ts`
- **Backlog/WI retrieval caches**
  - `backlog_manifest_*`, `backlog_themes_*`, `backlog_docs_*`, `wi_docs`, `wi_chunks_*`, `wi_corpus_cache`
  - Source: `src/core/similar-stories.ts`, `src/core/wi-ingestion.ts`
- **Compliance/activity/audit**
  - `compliance_audit_trail`, `transparency_reports`, `project_activity`, `pipeline_audit_*`
  - Source: `src/services/compliance.ts`, `src/services/project-activity.ts`, `src/services/pipeline-audit-store.ts`

### Estimated high-frequency read/write paths

- **Generation/clarify polling**
  - Frontend polls every `~2s` while active in `src/frontend/src/hooks/useRealtime.ts`
  - Resolver read: `getProgress`, `getClarifyResult`, `getBulkRefineResult`
  - Approximate active read rate per session: `0.5 RPS` per polled endpoint while visible.
- **Queue heartbeats**
  - Progress heartbeats every `15s` in `generation.ts` and `clarify.ts`
  - Approximate write rate per running job: `0.067 WPS` plus stage-transition writes.
- **Conversation persistence**
  - Read-modify-write full conversation objects on generation/refine updates.
- **Compliance/activity append**
  - Read full array + rewrite array for each new event.

## 2) Quantifying billing impact in Forge

Use this workflow before/after each optimization release:

1. Open Forge developer console -> app -> **Usage and costs**.
2. Filter by:
   - environment (`development`/`staging`/`production`)
   - date range (last 7/30 days)
   - site (for installation-level hotspots)
3. Record:
   - `Storage reads (GB)`
   - `Storage writes (GB)`
   - `Functions (GB-seconds)` (to catch polling/loop side-effects)
4. Map spikes to app behavior:
   - read spikes -> polling-heavy flows
   - write spikes -> progress heartbeats, large object rewrites, append arrays
5. Keep a weekly baseline table in release notes:
   - `reads GB/day`, `writes GB/day`, `cost/day`, `top 3 invoking sites`

## 3) Implemented Option A (KVS optimization) changes

### A. Added small-value write fast path

- New helper `entitySetSmall()` in `src/services/cache.ts`.
- Behavior:
  - skips pre-read for values under inline threshold
  - falls back to `entitySet()` for large payloads
- Goal:
  - remove read amplification on hot small keys.

### B. Applied fast path to hot progress/status/pointer writes

- Updated queue and resolver write paths to use `entitySetSmall()` for:
  - generation/clarify/refine progress markers
  - cancel markers
  - backlog refresh status
  - lightweight session pointer keys (`userLastSession`, `userIssueSession`)

### C. Reduced hidden-tab polling pressure

- `useRealtime.ts`: when tab is hidden, polls are downsampled (effective ~8s cadence).
- `SettingsView.tsx`: backlog refresh status polling now backs off up to 10s and slows further when tab hidden.

## 4) Hybrid SQL boundary (recommended medium-term)

### Keep in KVS

- Progress/cancel state keys (ephemeral, low-latency)
- Small config and session pointer keys
- WI/backlog cache hot fragments that benefit from simple key lookup

### Move to SQL first

- Conversations and turns
- Compliance audit events
- Transparency reports
- Project activity events
- Pipeline audit bundles metadata

### Suggested SQL tables (first pass)

- `conversations`
  - `id`, `account_id`, `session_id`, `title`, `updated_at`, `is_pinned`
- `conversation_turns`
  - `id`, `conversation_id`, `turn_type`, `payload_json`, `created_at`
- `compliance_events`
  - `id`, `event_id`, `account_id`, `category`, `action`, `details_json`, `created_at`
- `transparency_reports`
  - `id`, `report_id`, `session_id`, `turn_type`, `model`, `payload_json`, `created_at`
- `project_activity_events`
  - `id`, `event_id`, `project_key`, `action`, `metadata_json`, `created_at`

Reference draft DDL: `docs/forge-sql-hybrid-schema.sql`

### Migration sequence

1. Add SQL module and schema.
2. Introduce storage adapter interface:
   - read from SQL first, fallback to KVS.
3. Dual-write selected domains for one release cycle.
4. Backfill historical KVS data in batches.
5. Flip reads fully to SQL; keep KVS fallback for one rollback window.

## 5) Rollout guardrails and rollback criteria

### Feature flags

- `storageOptimizations.smallWritesEnabled`
- `storageOptimizations.hiddenPollBackoffEnabled`
- `storageOptimizations.backlogStatusBackoffEnabled`
- future: `storageOptimizations.sqlReadPathEnabled`, `storageOptimizations.sqlDualWriteEnabled`

### Success targets

- `>=30%` reduction in storage reads (7-day moving average)
- `>=20%` reduction in storage writes (7-day moving average)
- no increase in user-visible latency/error rate for generation/clarify flows

### Rollback triggers

- progress polling becomes stale/incorrect in >1% sessions
- queue completion events missing or delayed beyond current SLA
- read/write cost increases for 3 consecutive days after rollout

### Deployment stages

1. Enable in development, monitor 48h.
2. Enable in staging with production-like traffic replay.
3. Enable in production for internal site first.
4. Expand to all sites after baseline confirms target reductions.

Operational checklist: `docs/forge-storage-rollout-checklist.md`
