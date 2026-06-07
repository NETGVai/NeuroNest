import type Database from 'better-sqlite3';

export const version = 15;
export const description = 'Model packs, autonomy levels, plan versioning, smart context';

export function up(db: Database.Database): void {
  db.exec(`
    -- Model Packs: role-to-model mappings
    CREATE TABLE IF NOT EXISTS model_packs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      roles TEXT NOT NULL DEFAULT '{}',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Autonomy Levels: per-project autonomy configuration
    CREATE TABLE IF NOT EXISTS autonomy_config (
      project_id TEXT PRIMARY KEY,
      level TEXT NOT NULL DEFAULT 'basic' CHECK(level IN ('none', 'basic', 'plus', 'semi', 'full', 'custom')),
      auto_continue INTEGER NOT NULL DEFAULT 1,
      auto_build INTEGER NOT NULL DEFAULT 1,
      auto_load_context INTEGER NOT NULL DEFAULT 0,
      smart_context INTEGER NOT NULL DEFAULT 0,
      auto_apply INTEGER NOT NULL DEFAULT 0,
      auto_exec INTEGER NOT NULL DEFAULT 0,
      auto_debug INTEGER NOT NULL DEFAULT 0,
      auto_commit INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Plan Versions: version-controlled plan history with branches
    CREATE TABLE IF NOT EXISTS plan_versions (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT 'main',
      version_num INTEGER NOT NULL,
      action TEXT NOT NULL,
      description TEXT,
      snapshot TEXT NOT NULL DEFAULT '{}',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_plan_ver_plan ON plan_versions(plan_id, branch, version_num);

    -- Plan Branches
    CREATE TABLE IF NOT EXISTS plan_branches (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_branch TEXT DEFAULT 'main',
      fork_version INTEGER,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_plan_branch_plan ON plan_branches(plan_id);

    -- Smart Context: per-step context selections
    CREATE TABLE IF NOT EXISTS context_selections (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      step_num INTEGER NOT NULL DEFAULT 0,
      selected_files TEXT NOT NULL DEFAULT '[]',
      total_tokens INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ctx_sel_session ON context_selections(session_id);
  `);
}
