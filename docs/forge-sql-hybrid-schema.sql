-- Draft schema for a hybrid Forge SQL migration.
-- Notes:
-- - Keep KVS for ephemeral progress/cancel keys and small pointers.
-- - Move high-churn/history domains to SQL.
-- - Forge SQL does not support foreign keys; relationships are enforced in app logic.

CREATE TABLE IF NOT EXISTS conversations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  account_id VARCHAR(255) NOT NULL,
  session_id VARCHAR(255) NOT NULL,
  title VARCHAR(255) NULL,
  is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY ux_conversations_account_session (account_id, session_id)
);

CREATE TABLE IF NOT EXISTS conversation_turns (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  account_id VARCHAR(255) NOT NULL,
  session_id VARCHAR(255) NOT NULL,
  turn_type VARCHAR(64) NOT NULL,
  payload_json JSON NOT NULL,
  created_at DATETIME NOT NULL,
  KEY ix_turns_account_session_created (account_id, session_id, created_at)
);

CREATE TABLE IF NOT EXISTS compliance_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id VARCHAR(64) NOT NULL,
  actor_account_id VARCHAR(255) NULL,
  category VARCHAR(64) NOT NULL,
  action VARCHAR(128) NOT NULL,
  details_json JSON NOT NULL,
  prev_hash VARCHAR(128) NULL,
  hash VARCHAR(128) NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY ux_compliance_event_id (event_id),
  KEY ix_compliance_category_created (category, created_at)
);

CREATE TABLE IF NOT EXISTS transparency_reports (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  report_id VARCHAR(64) NOT NULL,
  session_id VARCHAR(255) NOT NULL,
  turn_type VARCHAR(64) NOT NULL,
  actor_account_id VARCHAR(255) NULL,
  provider VARCHAR(64) NULL,
  model VARCHAR(128) NULL,
  project_key VARCHAR(64) NULL,
  payload_json JSON NOT NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY ux_transparency_report_id (report_id),
  KEY ix_transparency_session_created (session_id, created_at)
);

CREATE TABLE IF NOT EXISTS project_activity_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id VARCHAR(64) NOT NULL,
  project_key VARCHAR(64) NULL,
  action VARCHAR(64) NOT NULL,
  session_id VARCHAR(255) NULL,
  model VARCHAR(128) NULL,
  token_usage_input INT NULL,
  token_usage_output INT NULL,
  token_usage_total INT NULL,
  metadata_json JSON NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY ux_activity_event_id (event_id),
  KEY ix_activity_project_created (project_key, created_at),
  KEY ix_activity_action_created (action, created_at)
);

CREATE TABLE IF NOT EXISTS pipeline_audit_bundles (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(255) NOT NULL,
  audit_run_id VARCHAR(255) NOT NULL,
  account_id VARCHAR(255) NULL,
  phase VARCHAR(64) NULL,
  payload_json JSON NOT NULL,
  updated_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY ux_pipeline_audit_session_run (session_id, audit_run_id)
);
