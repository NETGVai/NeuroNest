-- 010_create_operational_bounds.sql
-- Expand phase: Create operational bounds persistence table.
-- Requirements: 5.6, 7.4, 11.3, 14.2, 22.4–22.8, 31.1

CREATE TABLE IF NOT EXISTS harness_operational_bounds (
  boundsId TEXT NOT NULL PRIMARY KEY,
  scope TEXT NOT NULL, -- JSON ScopeDescriptor
  category TEXT NOT NULL,
  key TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  sourceRevision TEXT NOT NULL,
  validatedAt TEXT NOT NULL,
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_harness_bounds_scope_key
  ON harness_operational_bounds(scope, category, key);

CREATE INDEX IF NOT EXISTS idx_harness_bounds_category
  ON harness_operational_bounds(category);
