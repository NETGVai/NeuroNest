-- 001_create_events.sql
-- Expand phase: Create the core session events table.
-- Events are append-only and immutable. No UPDATE or DELETE triggers are allowed.
-- Requirements: 3.1–3.3, 3.5–3.7

CREATE TABLE IF NOT EXISTS harness_events (
  eventId TEXT NOT NULL PRIMARY KEY,
  sessionId TEXT NOT NULL,
  branchId TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  eventType TEXT NOT NULL,
  payload TEXT NOT NULL, -- JSON serialized canonical payload
  idempotencyKey TEXT UNIQUE,
  occurredAt TEXT NOT NULL, -- ISO-8601 timestamp
  actor TEXT NOT NULL, -- JSON serialized ActorRef
  scope TEXT NOT NULL, -- JSON serialized ScopeDescriptorV1
  previousIntegrityHash TEXT,
  integrityHash TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Enforce monotonic sequence per session+branch
CREATE UNIQUE INDEX IF NOT EXISTS idx_harness_events_session_branch_seq
  ON harness_events(sessionId, branchId, sequence);

-- Fast lookup by session
CREATE INDEX IF NOT EXISTS idx_harness_events_session
  ON harness_events(sessionId, occurredAt);

-- Fast lookup by event type
CREATE INDEX IF NOT EXISTS idx_harness_events_type
  ON harness_events(sessionId, eventType);

-- Immutability trigger: prevent UPDATE on harness_events
CREATE TRIGGER IF NOT EXISTS trg_harness_events_no_update
  BEFORE UPDATE ON harness_events
BEGIN
  SELECT RAISE(ABORT, 'harness_events rows are immutable: UPDATE is forbidden');
END;

-- Immutability trigger: prevent DELETE on harness_events
CREATE TRIGGER IF NOT EXISTS trg_harness_events_no_delete
  BEFORE DELETE ON harness_events
BEGIN
  SELECT RAISE(ABORT, 'harness_events rows are immutable: DELETE is forbidden');
END;
