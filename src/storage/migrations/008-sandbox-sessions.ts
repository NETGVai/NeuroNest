import type Database from 'better-sqlite3';

export const version = 8;
export const description = 'Sandbox sessions table';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sandbox_sessions (
      id            TEXT PRIMARY KEY,
      backend       TEXT NOT NULL CHECK(backend IN ('local', 'docker')),
      uploads_dir   TEXT NOT NULL,
      workspace_dir TEXT NOT NULL,
      outputs_dir   TEXT NOT NULL,
      status        TEXT NOT NULL CHECK(status IN ('running', 'completed', 'timed_out', 'error')),
      exit_code     INTEGER,
      timeout_ms    INTEGER NOT NULL DEFAULT 120000,
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at  DATETIME
    );
  `);
}
