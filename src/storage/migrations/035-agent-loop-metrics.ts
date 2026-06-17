import type Database from 'better-sqlite3';

export const version = 35;
export const description = 'Agent loop metrics columns on session_telemetry';

export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE session_telemetry ADD COLUMN loop_iterations INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE session_telemetry ADD COLUMN tool_success_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE session_telemetry ADD COLUMN tool_failure_count INTEGER NOT NULL DEFAULT 0;
  `);
}
