-- 012_create_migrations.sql
-- Expand phase: Create migration history and status tracking.
-- Requirements: 31.3–31.12

CREATE TABLE IF NOT EXISTS harness_migration_history (
  migrationId TEXT NOT NULL PRIMARY KEY,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'expand', -- expand|contract
  state TEXT NOT NULL DEFAULT 'pending', -- pending|applied|rolled_back|failed
  checksum TEXT NOT NULL,
  appliedBy TEXT, -- process owner identity
  appliedAt TEXT,
  rolledBackAt TEXT,
  failureReason TEXT,
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_harness_migration_version_phase
  ON harness_migration_history(version, phase);

CREATE INDEX IF NOT EXISTS idx_harness_migration_state
  ON harness_migration_history(state);
