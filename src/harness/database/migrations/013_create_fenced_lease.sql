-- 013_create_fenced_lease.sql
-- Expand phase: Create renewable migration lease with fencing token.
-- Requirements: 30.8, 30.12, 31.6–31.10

CREATE TABLE IF NOT EXISTS harness_fenced_lease (
  leaseId TEXT NOT NULL PRIMARY KEY DEFAULT 'migration_lease',
  owner TEXT NOT NULL, -- process identity holding the lease
  fencingToken INTEGER NOT NULL DEFAULT 1, -- monotonically increasing
  acquiredAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expiresAt TEXT NOT NULL,
  renewedAt TEXT,
  schemaVersion INTEGER NOT NULL DEFAULT 1
);

-- Only one lease row ever exists (singleton pattern)
CREATE UNIQUE INDEX IF NOT EXISTS idx_harness_fenced_lease_singleton
  ON harness_fenced_lease(leaseId);
