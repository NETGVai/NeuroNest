import type Database from 'better-sqlite3';

export const version = 32;
export const description =
  "Add 'spec' to the message-mode CHECK constraints (message_mode_config.default_mode and message_queue.mode) so the chat prompt can offer a Spec mode that triggers the grill-me interview.";

/**
 * The chat prompt's message-mode selector originally offered three modes —
 * `send`, `steer`, `queue` — pinned by CHECK constraints in migration 021.
 * A fourth mode, `spec`, is added so that the grill-me pre-flight interview
 * is triggered ONLY when the user explicitly selects Spec mode (with `send`
 * reverting to its pre-grill-me straight-to-orchestrator behavior).
 *
 * SQLite cannot ALTER an existing CHECK constraint, so each affected table is
 * rebuilt with the widened constraint and its data copied over. The rebuild is
 * guarded by inspecting the live `CREATE TABLE` SQL in `sqlite_master`: if the
 * table already permits `'spec'` (this migration already ran, or a fresh
 * install created it with the new schema), that table is skipped. This makes
 * the migration fully idempotent and non-destructive — every existing row is
 * preserved.
 */
export function up(db: Database.Database): void {
  rebuildMessageModeConfig(db);
  rebuildMessageQueue(db);
}

/** Read the stored `CREATE TABLE` SQL for `table`, or `null` if absent. */
function tableSql(db: Database.Database, table: string): string | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { sql: string } | undefined;
  return row?.sql ?? null;
}

/**
 * Rebuild `message_mode_config` with `default_mode` permitting `'spec'`.
 * No-op when the table is absent (fresh install runs 021 with the widened
 * schema only if 021 itself is updated; here we always widen post-021) or
 * already allows `'spec'`.
 */
function rebuildMessageModeConfig(db: Database.Database): void {
  const sql = tableSql(db, 'message_mode_config');
  if (sql === null) return; // table not created yet (migration 021 absent)
  if (sql.includes("'spec'")) return; // already widened — idempotent skip

  db.exec(`
    CREATE TABLE message_mode_config_new (
      project_id TEXT PRIMARY KEY,
      default_mode TEXT NOT NULL DEFAULT 'send' CHECK(default_mode IN ('send', 'steer', 'queue', 'spec')),
      auto_process_queue INTEGER NOT NULL DEFAULT 1,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO message_mode_config_new (project_id, default_mode, auto_process_queue, updated_at)
      SELECT project_id, default_mode, auto_process_queue, updated_at FROM message_mode_config;
    DROP TABLE message_mode_config;
    ALTER TABLE message_mode_config_new RENAME TO message_mode_config;
  `);
}

/**
 * Rebuild `message_queue` with `mode` permitting `'spec'`, preserving rows and
 * recreating its indexes. No-op when absent or already widened.
 */
function rebuildMessageQueue(db: Database.Database): void {
  const sql = tableSql(db, 'message_queue');
  if (sql === null) return;
  if (sql.includes("'spec'")) return;

  db.exec(`
    CREATE TABLE message_queue_new (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      message TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'send' CHECK(mode IN ('send', 'steer', 'queue', 'spec')),
      priority INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'cancelled')),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME
    );
    INSERT INTO message_queue_new (id, project_id, message, mode, priority, status, created_at, processed_at)
      SELECT id, project_id, message, mode, priority, status, created_at, processed_at FROM message_queue;
    DROP TABLE message_queue;
    ALTER TABLE message_queue_new RENAME TO message_queue;
    CREATE INDEX IF NOT EXISTS idx_msgqueue_project ON message_queue(project_id);
    CREATE INDEX IF NOT EXISTS idx_msgqueue_status ON message_queue(status);
  `);
}
