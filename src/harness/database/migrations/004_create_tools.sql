-- 004_create_tools.sql
-- Expand phase: Create tool call records with lineage support.
-- Requirements: 13.1–13.9, 14.1–14.6, 34.3

CREATE TABLE IF NOT EXISTS harness_tool_calls (
  callId TEXT NOT NULL PRIMARY KEY,
  sessionId TEXT NOT NULL,
  turnId TEXT NOT NULL,
  stepId TEXT,
  toolName TEXT NOT NULL,
  toolVersion TEXT NOT NULL DEFAULT '1',
  modelOrderIndex INTEGER NOT NULL,
  parentCallId TEXT,
  state TEXT NOT NULL DEFAULT 'pending', -- pending|executing|completed|failed|cancelled
  inputDigest TEXT,
  canonicalValueDigest TEXT,
  riskLevel TEXT NOT NULL DEFAULT 'low',
  idempotencyKey TEXT UNIQUE,
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completedAt TEXT,
  FOREIGN KEY (parentCallId) REFERENCES harness_tool_calls(callId)
);

CREATE TABLE IF NOT EXISTS harness_canonical_tool_values (
  canonicalValueId TEXT NOT NULL PRIMARY KEY,
  callId TEXT NOT NULL,
  mediaType TEXT NOT NULL,
  value TEXT NOT NULL, -- JSON serialized
  valueDigest TEXT NOT NULL,
  retention TEXT NOT NULL DEFAULT '{}', -- JSON RetentionDescriptor
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (callId) REFERENCES harness_tool_calls(callId)
);

CREATE INDEX IF NOT EXISTS idx_harness_tool_calls_session_turn
  ON harness_tool_calls(sessionId, turnId, modelOrderIndex);

CREATE INDEX IF NOT EXISTS idx_harness_tool_calls_parent
  ON harness_tool_calls(parentCallId);

-- Immutability trigger: prevent UPDATE on canonical values
CREATE TRIGGER IF NOT EXISTS trg_harness_canonical_values_no_update
  BEFORE UPDATE ON harness_canonical_tool_values
BEGIN
  SELECT RAISE(ABORT, 'harness_canonical_tool_values rows are immutable');
END;

-- Immutability trigger: prevent DELETE on canonical values
CREATE TRIGGER IF NOT EXISTS trg_harness_canonical_values_no_delete
  BEFORE DELETE ON harness_canonical_tool_values
BEGIN
  SELECT RAISE(ABORT, 'harness_canonical_tool_values rows are immutable');
END;
