-- 006_create_attachments.sql
-- Expand phase: Create attachment metadata and CAS references.
-- Requirements: 21.1–21.7, 41.1–41.15

CREATE TABLE IF NOT EXISTS harness_attachments (
  attachmentId TEXT NOT NULL PRIMARY KEY,
  sessionId TEXT NOT NULL,
  contentHash TEXT NOT NULL, -- content-addressed storage reference
  mediaType TEXT NOT NULL,
  declaredFilename TEXT, -- user-visible filename, no path
  sizeBytes INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'selected', -- selected|validating|uploading|scanning|ready|committing|committed|error
  dimensions TEXT, -- JSON: { width, height } or null
  duration REAL, -- media duration in seconds or null
  safetyResult TEXT, -- JSON safety scan result
  idempotencyKey TEXT UNIQUE,
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  committedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_harness_attachments_session
  ON harness_attachments(sessionId, state);

CREATE INDEX IF NOT EXISTS idx_harness_attachments_content
  ON harness_attachments(contentHash);
