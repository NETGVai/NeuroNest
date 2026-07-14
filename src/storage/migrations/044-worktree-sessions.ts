import type Database from 'better-sqlite3';

export const version = 44;
export const description = 'Worktree sessions: Git worktree isolation tracking for parallel agent tasks (worktree_sessions table)';

export function up(db: Database.Database): void {
  db.exec(`
    -- Worktree Sessions: tracks git worktree lifecycle for agent isolation in Ultra mode
    -- Requirements: 3.1, 3.6
    CREATE TABLE IF NOT EXISTS worktree_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      diff_stats TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ws_project_status ON worktree_sessions(project_id, status);
  `);
}
