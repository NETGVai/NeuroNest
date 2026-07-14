import type Database from 'better-sqlite3';

export const version = 46;
export const description = 'Background processes: persistent process lifecycle management (background_processes table)';

export function up(db: Database.Database): void {
  db.exec(`
    -- Background Processes: tracks managed background processes across sessions
    -- Requirements: 11.1, 11.2, 11.3
    CREATE TABLE IF NOT EXISTS background_processes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      pid INTEGER,
      port INTEGER,
      status TEXT NOT NULL DEFAULT 'stopped',
      started_at INTEGER,
      stopped_at INTEGER
    );
  `);
}
