import type Database from 'better-sqlite3';

export const version = 18;
export const description = 'Recipes, subagents, MCP apps, ACP, adversary reviewer, custom distros, response schemas, deeplinks, tool permissions, malware scan, OAuth, context compaction, REST API, SSE extensions, turn management';

export function up(db: Database.Database): void {
  db.exec(`
    -- Recipes: portable YAML workflow configs
    CREATE TABLE IF NOT EXISTS recipes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT DEFAULT '1.0.0',
      description TEXT,
      parameters TEXT NOT NULL DEFAULT '[]',
      extensions TEXT NOT NULL DEFAULT '[]',
      instructions TEXT NOT NULL,
      sub_recipes TEXT DEFAULT '[]',
      response_schema TEXT,
      author TEXT,
      source TEXT,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_recipes_name ON recipes(name);

    -- Recipe Runs: execution history
    CREATE TABLE IF NOT EXISTS recipe_runs (
      id TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      project_id TEXT,
      parameters TEXT DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed')),
      output TEXT,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_recipe_runs_recipe ON recipe_runs(recipe_id);

    -- Subagent Tasks: agent-spawned parallel workers
    CREATE TABLE IF NOT EXISTS subagent_tasks (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL,
      instructions TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed')),
      result TEXT,
      model TEXT,
      max_turns INTEGER DEFAULT 10,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_subagent_parent ON subagent_tasks(parent_session_id);

    -- Tool Permissions: per-tool allow/confirm/deny
    CREATE TABLE IF NOT EXISTS tool_permissions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'confirm' CHECK(level IN ('allow', 'confirm', 'deny')),
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, tool_name)
    );
    CREATE INDEX IF NOT EXISTS idx_tool_perm_project ON tool_permissions(project_id);

    -- Adversary Review Log: security monitoring of agent actions
    CREATE TABLE IF NOT EXISTS adversary_reviews (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      action_detail TEXT NOT NULL,
      risk_level TEXT NOT NULL DEFAULT 'low' CHECK(risk_level IN ('low', 'medium', 'high', 'critical')),
      flagged INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      reviewed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_adversary_session ON adversary_reviews(session_id);

    -- Response Schemas: structured output validation
    CREATE TABLE IF NOT EXISTS response_schemas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      schema TEXT NOT NULL,
      description TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Context Compaction Log
    CREATE TABLE IF NOT EXISTS context_compactions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tokens_before INTEGER NOT NULL,
      tokens_after INTEGER NOT NULL,
      messages_removed INTEGER NOT NULL DEFAULT 0,
      compacted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_compaction_session ON context_compactions(session_id);

    -- Turn Limits: per-session turn management
    CREATE TABLE IF NOT EXISTS turn_limits (
      session_id TEXT PRIMARY KEY,
      max_turns INTEGER NOT NULL DEFAULT 100,
      current_turn INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Recipe Deeplinks
    CREATE TABLE IF NOT EXISTS recipe_deeplinks (
      id TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      short_code TEXT NOT NULL UNIQUE,
      parameters TEXT DEFAULT '{}',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
