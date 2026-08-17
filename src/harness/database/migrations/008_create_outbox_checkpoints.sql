-- 008_create_outbox_checkpoints.sql
-- Expand phase: Create transactional outbox records and named consumer checkpoints.
-- Requirements: 15.7–15.8, 30.7, 31.2–31.5

CREATE TABLE IF NOT EXISTS harness_outbox (
  outboxId TEXT NOT NULL PRIMARY KEY,
  topic TEXT NOT NULL,
  payload TEXT NOT NULL, -- JSON serialized
  ordering INTEGER NOT NULL, -- monotonic within topic
  idempotencyKey TEXT UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending', -- pending|consumed|failed
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  consumedAt TEXT
);

CREATE TABLE IF NOT EXISTS harness_consumer_checkpoints (
  consumerId TEXT NOT NULL,
  topic TEXT NOT NULL,
  lastConsumedOrdering INTEGER NOT NULL DEFAULT 0,
  lastConsumedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (consumerId, topic)
);

CREATE INDEX IF NOT EXISTS idx_harness_outbox_topic_ordering
  ON harness_outbox(topic, ordering, state);

CREATE INDEX IF NOT EXISTS idx_harness_outbox_state
  ON harness_outbox(state, createdAt);
