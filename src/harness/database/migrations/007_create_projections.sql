-- 007_create_projections.sql
-- Expand phase: Create projection checkpoints, indexes, and insights.
-- Requirements: 28.1–28.10

CREATE TABLE IF NOT EXISTS harness_projection_checkpoints (
  checkpointId TEXT NOT NULL PRIMARY KEY,
  sessionId TEXT NOT NULL,
  branchId TEXT NOT NULL,
  projectionKind TEXT NOT NULL,
  sourceSequence INTEGER NOT NULL,
  projectionRevision INTEGER NOT NULL,
  checkpointHash TEXT NOT NULL,
  value TEXT NOT NULL, -- JSON serialized projection state
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS harness_projection_indexes (
  indexId TEXT NOT NULL PRIMARY KEY,
  sessionId TEXT NOT NULL,
  indexKind TEXT NOT NULL, -- fulltext|semantic|relationship|lineage
  entityId TEXT NOT NULL,
  entityKind TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}', -- JSON additional metadata
  sourceSequence INTEGER NOT NULL,
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS harness_insights (
  insightId TEXT NOT NULL PRIMARY KEY,
  sessionId TEXT NOT NULL,
  insightKind TEXT NOT NULL, -- usage|cost|latency|tokens|context
  value TEXT NOT NULL, -- JSON: numeric with unit and provenance
  sourceRange TEXT NOT NULL, -- JSON: { startSeq, endSeq }
  provenance TEXT NOT NULL, -- JSON provenance metadata
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_harness_projections_session_kind_seq
  ON harness_projection_checkpoints(sessionId, branchId, projectionKind, sourceSequence);

CREATE INDEX IF NOT EXISTS idx_harness_projection_indexes_session
  ON harness_projection_indexes(sessionId, indexKind, entityKind);

CREATE INDEX IF NOT EXISTS idx_harness_insights_session
  ON harness_insights(sessionId, insightKind);
