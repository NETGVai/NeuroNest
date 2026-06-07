import type Database from 'better-sqlite3';

export const version = 24;
export const description = 'Grounding audit table for anti-hallucination guardrails';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS grounding_audit (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      coverage TEXT NOT NULL,
      source_count INTEGER NOT NULL,
      passed BOOLEAN NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_grounding_audit_project ON grounding_audit(project_id);
  `);
}
