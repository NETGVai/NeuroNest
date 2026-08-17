-- 002_create_lineage.sql
-- Expand phase: Create fork lineage table for session branching.
-- Lineage must be recorded before any child events.
-- Requirements: 3.4, 28.3

CREATE TABLE IF NOT EXISTS harness_lineage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parentSessionId TEXT NOT NULL,
  parentSequence INTEGER NOT NULL,
  childSessionId TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Unique constraint: a child session can only fork once
CREATE UNIQUE INDEX IF NOT EXISTS idx_harness_lineage_child
  ON harness_lineage(childSessionId);

-- Fast parent lookup
CREATE INDEX IF NOT EXISTS idx_harness_lineage_parent
  ON harness_lineage(parentSessionId, parentSequence);
