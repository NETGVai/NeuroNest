import type Database from 'better-sqlite3';

export const version = 48;
export const description = 'Session portability: export/import/share tracking (session_exports table)';

export function up(db: Database.Database): void {
  db.exec(`
    -- Session Portability: tracks export, import, and share-link operations
    -- Requirements: 6.1, 6.3, 6.4
    CREATE TABLE IF NOT EXISTS session_exports (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      export_type TEXT NOT NULL DEFAULT 'export',
      status TEXT NOT NULL DEFAULT 'pending',
      metadata TEXT,
      archive_size INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      accessed_count INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_session_exports_session ON session_exports(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_session_exports_type ON session_exports(export_type, status);
    CREATE INDEX IF NOT EXISTS idx_session_exports_expires ON session_exports(expires_at);
  `);
}
