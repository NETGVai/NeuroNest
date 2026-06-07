import type Database from 'better-sqlite3';

export const version = 2;
export const description = 'Skills system tables';

export function up(db: Database.Database): void {
  db.exec(`
    -- Installed/discovered skills
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('local', 'bundled', 'custom', 'workspace')),
      version TEXT NOT NULL DEFAULT '1.0.0',
      category TEXT NOT NULL DEFAULT 'general',
      tags TEXT NOT NULL DEFAULT '[]',
      scope TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('global', 'workspace', 'project', 'agent')),
      entrypoint TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      installed BOOLEAN NOT NULL DEFAULT FALSE,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      bundled_skill_id TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Skill execution audit log
    CREATE TABLE IF NOT EXISTS skill_executions (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK(mode IN ('pure-instruction', 'shell-script', 'node-script', 'workspace-action')),
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      duration_ms INTEGER,
      success BOOLEAN NOT NULL,
      input_summary TEXT,
      output_summary TEXT,
      error TEXT,
      test BOOLEAN NOT NULL DEFAULT FALSE
    );

    -- Per-project routing preferences
    CREATE TABLE IF NOT EXISTS skill_routing_prefs (
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      weight_override REAL,
      enabled_override BOOLEAN,
      PRIMARY KEY (skill_id, project_id)
    );

    -- Bundled catalog cache
    CREATE TABLE IF NOT EXISTS catalog_skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT,
      tags TEXT,
      version TEXT,
      content TEXT NOT NULL,
      loaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_skill_executions_skill_id ON skill_executions(skill_id);
    CREATE INDEX IF NOT EXISTS idx_skill_routing_prefs_project_id ON skill_routing_prefs(project_id);
    CREATE INDEX IF NOT EXISTS idx_skills_source ON skills(source);
    CREATE INDEX IF NOT EXISTS idx_skills_scope ON skills(scope);
    CREATE INDEX IF NOT EXISTS idx_catalog_skills_category ON catalog_skills(category);
  `);
}
