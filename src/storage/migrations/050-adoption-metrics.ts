import type Database from 'better-sqlite3';

export const version = 50;
export const description = 'Adoption metrics table for analytics dashboard';

export function up(db: Database.Database): void {
  db.exec(`
    -- Adoption Dashboard: event-level metrics for analytics collection
    -- Requirements: 23.1, 23.2, 23.3
    CREATE TABLE IF NOT EXISTS adoption_metrics (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      team_id TEXT,
      org_id TEXT,
      event_type TEXT NOT NULL,
      agent_id TEXT,
      value REAL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_adoption_metrics_user ON adoption_metrics(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_adoption_metrics_team ON adoption_metrics(team_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_adoption_metrics_org ON adoption_metrics(org_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_adoption_metrics_event_type ON adoption_metrics(event_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_adoption_metrics_agent ON adoption_metrics(agent_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_adoption_metrics_retention ON adoption_metrics(created_at);
  `);
}
