import type Database from 'better-sqlite3';

export const version = 75;
export const description = 'Idempotent legacy chat history import state';

/**
 * Stores only migration checkpoints and redacted quarantine metadata. Legacy
 * message tables remain untouched so rollback can continue reading them.
 */
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS legacy_history_import_markers (
      session_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      migration_version INTEGER NOT NULL,
      source_digest TEXT NOT NULL,
      source_count INTEGER NOT NULL,
      imported_count INTEGER NOT NULL,
      quarantined_count INTEGER NOT NULL,
      checkpoint_sequence INTEGER NOT NULL,
      checkpoint_hash TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      PRIMARY KEY (session_id, branch_id, migration_version)
    );

    CREATE TABLE IF NOT EXISTS legacy_history_import_quarantine (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      migration_version INTEGER NOT NULL,
      source_kind TEXT NOT NULL,
      source_identity_hash TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      observed_size INTEGER NOT NULL,
      payload_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (
        session_id,
        branch_id,
        migration_version,
        source_kind,
        source_identity_hash,
        reason_code
      )
    );

    CREATE INDEX IF NOT EXISTS idx_legacy_history_quarantine_session
      ON legacy_history_import_quarantine(session_id, branch_id, migration_version);
  `);
}

export function down(db: Database.Database): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_legacy_history_quarantine_session;
    DROP TABLE IF EXISTS legacy_history_import_quarantine;
    DROP TABLE IF EXISTS legacy_history_import_markers;
  `);
}
