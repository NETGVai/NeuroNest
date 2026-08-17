-- 005_create_turns_queues.sql
-- Expand phase: Create turns, steps, inbox/queue entries, and collaboration records.
-- Requirements: 15.1–15.6, 39.1–39.18

CREATE TABLE IF NOT EXISTS harness_turns (
  turnId TEXT NOT NULL PRIMARY KEY,
  sessionId TEXT NOT NULL,
  branchId TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  attempt INTEGER NOT NULL DEFAULT 1,
  owner TEXT NOT NULL, -- JSON ActorRef
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS harness_turn_steps (
  stepId TEXT NOT NULL PRIMARY KEY,
  turnId TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  stepType TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (turnId) REFERENCES harness_turns(turnId)
);

CREATE TABLE IF NOT EXISTS harness_queue_entries (
  entryId TEXT NOT NULL PRIMARY KEY,
  sessionId TEXT NOT NULL,
  turnId TEXT,
  entryType TEXT NOT NULL DEFAULT 'follow_up', -- follow_up|steer|inject
  content TEXT NOT NULL, -- JSON serialized
  placement TEXT NOT NULL DEFAULT 'end', -- front|end|after:<entryId>
  revision INTEGER NOT NULL DEFAULT 1,
  owner TEXT NOT NULL, -- JSON ActorRef
  state TEXT NOT NULL DEFAULT 'pending', -- pending|delivered|cancelled
  idempotencyKey TEXT UNIQUE,
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deliveredAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_harness_turns_session
  ON harness_turns(sessionId, branchId, createdAt);

CREATE INDEX IF NOT EXISTS idx_harness_turn_steps_turn
  ON harness_turn_steps(turnId, sequence);

CREATE INDEX IF NOT EXISTS idx_harness_queue_session
  ON harness_queue_entries(sessionId, state, createdAt);
