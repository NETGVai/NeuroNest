import type Database from 'better-sqlite3';

export const version = 76;
export const description =
  'Enhanced chat UI foundations: revisioned non-secret migration audit';

/**
 * Adds only the audit history that cannot be represented safely by the existing
 * config value. Revisioned settings remain in `config`, credentials remain in
 * `secrets_v2`, and response/activity history remains in Harness event tables.
 *
 * The ledger intentionally stores aggregate counts and status codes only. It
 * has no value, payload, provider-key, credential, prompt, or response columns.
 *
 * Requirements: 1.5, 1.8, 6.1, 7.1-7.8, 11.7, 12.6, 13.9
 */
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS enhanced_chat_ui_migration_audit (
      migration_key TEXT NOT NULL CHECK(length(trim(migration_key)) > 0),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      status TEXT NOT NULL CHECK(status IN ('not-started', 'complete', 'partial', 'failed')),
      records_examined INTEGER NOT NULL DEFAULT 0 CHECK(records_examined >= 0),
      records_disabled INTEGER NOT NULL DEFAULT 0 CHECK(records_disabled >= 0),
      selections_preserved INTEGER NOT NULL DEFAULT 0 CHECK(selections_preserved >= 0),
      records_removed INTEGER NOT NULL DEFAULT 0 CHECK(records_removed >= 0),
      failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count >= 0),
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (migration_key, revision),
      CHECK(records_disabled <= records_examined),
      CHECK(selections_preserved <= records_examined),
      CHECK(records_removed <= records_examined),
      CHECK(failure_count <= records_examined)
    );

    CREATE INDEX IF NOT EXISTS idx_enhanced_chat_ui_migration_audit_latest
      ON enhanced_chat_ui_migration_audit(migration_key, revision DESC);
  `);
}

/** Drops only structures owned by this migration. */
export function down(db: Database.Database): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_enhanced_chat_ui_migration_audit_latest;
    DROP TABLE IF EXISTS enhanced_chat_ui_migration_audit;
  `);
}
