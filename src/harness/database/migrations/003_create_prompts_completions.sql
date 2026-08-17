-- 003_create_prompts_completions.sql
-- Expand phase: Create prompt assembly inputs and completion anchors.
-- Requirements: 12.1–12.8, 34.1–34.2

CREATE TABLE IF NOT EXISTS harness_prompt_inputs (
  promptInputId TEXT NOT NULL PRIMARY KEY,
  sessionId TEXT NOT NULL,
  turnId TEXT NOT NULL,
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  sections TEXT NOT NULL, -- JSON: ordered named sections
  variables TEXT NOT NULL, -- JSON: strict variables
  toolSchemas TEXT NOT NULL, -- JSON: normalized tool schemas
  routeIdentity TEXT NOT NULL,
  adapterVersion TEXT NOT NULL,
  attachmentIds TEXT NOT NULL DEFAULT '[]', -- JSON array
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS harness_prompt_fingerprints (
  fingerprintId TEXT NOT NULL PRIMARY KEY,
  promptInputId TEXT NOT NULL,
  digest TEXT NOT NULL, -- stable hash of normalized inputs
  assemblyVersion TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (promptInputId) REFERENCES harness_prompt_inputs(promptInputId)
);

CREATE TABLE IF NOT EXISTS harness_completion_anchors (
  anchorId TEXT NOT NULL PRIMARY KEY,
  sessionId TEXT NOT NULL,
  turnId TEXT NOT NULL,
  fingerprintId TEXT NOT NULL,
  routeIdentity TEXT NOT NULL,
  modelIdentity TEXT NOT NULL,
  completionToken TEXT, -- provider completion reference
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (fingerprintId) REFERENCES harness_prompt_fingerprints(fingerprintId)
);

CREATE INDEX IF NOT EXISTS idx_harness_prompt_inputs_session
  ON harness_prompt_inputs(sessionId, turnId);

CREATE INDEX IF NOT EXISTS idx_harness_completion_anchors_session
  ON harness_completion_anchors(sessionId, turnId);
