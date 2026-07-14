import type Database from 'better-sqlite3';

export const version = 47;
export const description = 'Network sandbox: policy-based request logging (network_requests table)';

export function up(db: Database.Database): void {
  db.exec(`
    -- Network Sandbox: logs all allowed/blocked network requests with policy attribution
    -- Requirements: 10.4, 10.7
    CREATE TABLE IF NOT EXISTS network_requests (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      domain TEXT NOT NULL,
      action TEXT NOT NULL,
      policy_rule TEXT,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nr_session ON network_requests(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_nr_domain ON network_requests(domain, timestamp);
    CREATE INDEX IF NOT EXISTS idx_nr_action ON network_requests(action, timestamp);
  `);
}
