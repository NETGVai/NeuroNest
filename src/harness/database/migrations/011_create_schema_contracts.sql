-- 011_create_schema_contracts.sql
-- Expand phase: Create schema version compatibility declarations.
-- Requirements: 31.6–31.10

CREATE TABLE IF NOT EXISTS harness_schema_contracts (
  contractId TEXT NOT NULL PRIMARY KEY,
  processName TEXT NOT NULL, -- neuronest-session-mcp | neuronest-runtime-mcp
  readMinVersion INTEGER NOT NULL,
  readMaxVersion INTEGER NOT NULL,
  writeMinVersion INTEGER NOT NULL,
  writeMaxVersion INTEGER NOT NULL,
  observedVersion INTEGER NOT NULL,
  compatible INTEGER NOT NULL DEFAULT 1, -- boolean: 0 or 1
  registeredAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  schemaVersion INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_harness_schema_contracts_process
  ON harness_schema_contracts(processName);
