import type Database from 'better-sqlite3';

export const version = 5;
export const description = 'Cost records table for token cost tracking';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_records (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      cost REAL NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_cost_records_project_id ON cost_records(project_id);
    CREATE INDEX IF NOT EXISTS idx_cost_records_provider_id ON cost_records(provider_id);
  `);
}
