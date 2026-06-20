import type Database from 'better-sqlite3';

export const version = 37;
export const description = 'Add provenance columns to trace_entries for drift management';

export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE trace_entries ADD COLUMN correlation_id TEXT DEFAULT NULL;
    ALTER TABLE trace_entries ADD COLUMN parent_entry_id TEXT DEFAULT NULL;
    ALTER TABLE trace_entries ADD COLUMN intent_purpose TEXT DEFAULT NULL;
    ALTER TABLE trace_entries ADD COLUMN confidence_at_decision REAL DEFAULT NULL;

    CREATE INDEX IF NOT EXISTS idx_trace_entries_correlation
      ON trace_entries(correlation_id)
      WHERE correlation_id IS NOT NULL;
  `);
}
