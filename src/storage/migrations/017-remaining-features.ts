import type Database from 'better-sqlite3';

export const version = 17;
export const description = 'Git worktree, notifications, image/URL context, prompt cache, profiles, auto-commit, session search, zoom, alerts, personas, sticky notes, plan archive, file-session links';

export function up(db: Database.Database): void {
  db.exec(`
    -- Git Worktrees: isolated AI coding sessions on separate branches
    CREATE TABLE IF NOT EXISTS git_worktrees (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      branch TEXT NOT NULL,
      base_branch TEXT DEFAULT 'main',
      session_id TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_worktree_project ON git_worktrees(project_id);

    -- Desktop Notifications config
    CREATE TABLE IF NOT EXISTS notification_config (
      project_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      on_agent_complete INTEGER NOT NULL DEFAULT 1,
      on_agent_needs_input INTEGER NOT NULL DEFAULT 1,
      on_check_failed INTEGER NOT NULL DEFAULT 1,
      sound_enabled INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Image/URL Context: loaded context items for AI sessions
    CREATE TABLE IF NOT EXISTS context_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('file', 'url', 'image', 'note', 'pipe')),
      source TEXT NOT NULL,
      content TEXT,
      token_estimate INTEGER DEFAULT 0,
      sticky INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_context_session ON context_items(session_id);

    -- Prompt Cache: cached LLM prompts for cost savings
    CREATE TABLE IF NOT EXISTS prompt_cache (
      hash TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      response TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_hit_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Configuration Profiles: switchable settings presets
    CREATE TABLE IF NOT EXISTS config_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      settings TEXT NOT NULL DEFAULT '{}',
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Team Personas: system prompt library grouped by domain
    CREATE TABLE IF NOT EXISTS personas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      domain TEXT NOT NULL DEFAULT 'general',
      system_prompt TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Session Status: real-time status tracking per session
    CREATE TABLE IF NOT EXISTS session_status (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'working', 'waiting', 'input_needed', 'completed', 'error')),
      last_activity TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- File-Session Links: track which files each session touched
    CREATE TABLE IF NOT EXISTS file_session_links (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT 'read' CHECK(action IN ('read', 'write', 'create', 'delete')),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_file_link_session ON file_session_links(session_id);
    CREATE INDEX IF NOT EXISTS idx_file_link_path ON file_session_links(file_path);

    -- Plan Archive: archived plans/sessions
    CREATE TABLE IF NOT EXISTS archived_plans (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      snapshot TEXT NOT NULL DEFAULT '{}',
      archived_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- In-Session Alerts: proactive health/context alerts
    CREATE TABLE IF NOT EXISTS session_alerts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('context_bloat', 'missing_tool', 'health', 'cost_warning', 'rate_limit')),
      severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info', 'warning', 'critical')),
      message TEXT NOT NULL,
      dismissed INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_alert_session ON session_alerts(session_id);

    -- Global Search index for cross-session search
    CREATE TABLE IF NOT EXISTS search_index (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      content_type TEXT NOT NULL CHECK(content_type IN ('message', 'file', 'task', 'note')),
      content TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      indexed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_search_session ON search_index(session_id);

    -- Walkthrough/Onboarding steps
    CREATE TABLE IF NOT EXISTS onboarding_progress (
      user_id TEXT PRIMARY KEY DEFAULT 'default',
      completed_steps TEXT NOT NULL DEFAULT '[]',
      current_step INTEGER NOT NULL DEFAULT 0,
      dismissed INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Decision Log: architectural decisions tracked as structured items
    CREATE TABLE IF NOT EXISTS decision_log (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      context TEXT,
      alternatives TEXT,
      reasoning TEXT,
      tradeoffs TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'superseded', 'reversed')),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_decision_project ON decision_log(project_id);

    -- App Zoom preference
    CREATE TABLE IF NOT EXISTS app_preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
