import type Database from 'better-sqlite3';

export const version = 3;
export const description = 'Multica integration: Enhanced agent lifecycle, task management, and runtime monitoring';

export function up(db: Database.Database): void {
  db.exec(`
    -- Agent Runtimes (local daemons, cloud instances)
    CREATE TABLE IF NOT EXISTS agent_runtimes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('local', 'cloud', 'hybrid')),
      status TEXT NOT NULL DEFAULT 'inactive' CHECK(status IN ('active', 'inactive', 'error', 'maintenance')),
      capabilities TEXT NOT NULL DEFAULT '[]', -- JSON array of available CLIs/tools
      resources TEXT NOT NULL DEFAULT '{}', -- JSON: {cpu, memory, disk, gpu}
      config TEXT NOT NULL DEFAULT '{}', -- JSON: runtime-specific configuration
      last_heartbeat DATETIME,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Enhanced Agent Tasks (Multica-style task lifecycle)
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      assignee_type TEXT NOT NULL DEFAULT 'agent' CHECK(assignee_type IN ('human', 'agent')),
      assignee_id TEXT NOT NULL, -- Agent ID or human user ID
      assignee_name TEXT NOT NULL, -- Display name
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'claimed', 'in_progress', 'completed', 'failed', 'blocked')),
      priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
      labels TEXT NOT NULL DEFAULT '[]', -- JSON array of labels
      estimated_hours REAL,
      actual_hours REAL,
      progress_percentage INTEGER DEFAULT 0 CHECK(progress_percentage >= 0 AND progress_percentage <= 100),
      runtime_id TEXT REFERENCES agent_runtimes(id),
      parent_task_id TEXT REFERENCES agent_tasks(id),
      depends_on TEXT NOT NULL DEFAULT '[]', -- JSON array of task IDs this task depends on
      
      -- Lifecycle timestamps
      queued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      claimed_at DATETIME,
      started_at DATETIME,
      completed_at DATETIME,
      failed_at DATETIME,
      
      -- Metadata
      metadata TEXT NOT NULL DEFAULT '{}', -- JSON: additional task data
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Task Comments & Updates (human-agent collaboration)
    CREATE TABLE IF NOT EXISTS task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
      author_type TEXT NOT NULL CHECK(author_type IN ('human', 'agent')),
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      content TEXT NOT NULL,
      comment_type TEXT NOT NULL DEFAULT 'comment' CHECK(comment_type IN ('comment', 'blocker', 'progress_update', 'status_change')),
      metadata TEXT NOT NULL DEFAULT '{}', -- JSON: additional comment data
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Task Blockers (proactive issue reporting)
    CREATE TABLE IF NOT EXISTS task_blockers (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
      blocker_type TEXT NOT NULL CHECK(blocker_type IN ('dependency', 'resource', 'permission', 'technical', 'external')),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium' CHECK(severity IN ('low', 'medium', 'high', 'critical')),
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'resolved', 'wont_fix')),
      reported_by_type TEXT NOT NULL CHECK(reported_by_type IN ('human', 'agent')),
      reported_by_id TEXT NOT NULL,
      reported_by_name TEXT NOT NULL,
      resolved_by_type TEXT CHECK(resolved_by_type IN ('human', 'agent')),
      resolved_by_id TEXT,
      resolved_by_name TEXT,
      resolution_notes TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME
    );

    -- Enhanced Agent Skills (extending existing skills system)
    CREATE TABLE IF NOT EXISTS agent_skill_assignments (
      agent_id TEXT NOT NULL, -- References agent registry
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      proficiency_level TEXT NOT NULL DEFAULT 'beginner' CHECK(proficiency_level IN ('beginner', 'intermediate', 'advanced', 'expert')),
      success_rate REAL DEFAULT 0.0 CHECK(success_rate >= 0.0 AND success_rate <= 1.0),
      total_executions INTEGER DEFAULT 0,
      successful_executions INTEGER DEFAULT 0,
      avg_execution_time_ms INTEGER DEFAULT 0,
      last_used_at DATETIME,
      learned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (agent_id, skill_id)
    );

    -- Skill Learning History (how agents acquire skills)
    CREATE TABLE IF NOT EXISTS skill_learning_history (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      learning_method TEXT NOT NULL CHECK(learning_method IN ('successful_execution', 'manual_assignment', 'skill_sharing', 'template_inheritance')),
      source_task_id TEXT REFERENCES agent_tasks(id),
      source_agent_id TEXT, -- If learned from another agent
      confidence_score REAL DEFAULT 0.0 CHECK(confidence_score >= 0.0 AND confidence_score <= 1.0),
      notes TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Runtime Health Monitoring
    CREATE TABLE IF NOT EXISTS runtime_health_logs (
      id TEXT PRIMARY KEY,
      runtime_id TEXT NOT NULL REFERENCES agent_runtimes(id) ON DELETE CASCADE,
      cpu_usage REAL, -- Percentage 0-100
      memory_usage REAL, -- Percentage 0-100
      disk_usage REAL, -- Percentage 0-100
      active_agents INTEGER DEFAULT 0,
      queued_tasks INTEGER DEFAULT 0,
      completed_tasks_last_hour INTEGER DEFAULT 0,
      error_count_last_hour INTEGER DEFAULT 0,
      response_time_ms INTEGER,
      status TEXT NOT NULL CHECK(status IN ('healthy', 'warning', 'critical', 'offline')),
      metadata TEXT NOT NULL DEFAULT '{}', -- JSON: additional health data
      recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Agent Performance Analytics (enhanced from existing performance_records)
    CREATE TABLE IF NOT EXISTS agent_performance_analytics (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      runtime_id TEXT REFERENCES agent_runtimes(id),
      task_id TEXT REFERENCES agent_tasks(id),
      skill_id TEXT REFERENCES skills(id),
      
      -- Performance metrics
      execution_time_ms INTEGER NOT NULL,
      tokens_used INTEGER DEFAULT 0,
      estimated_cost REAL DEFAULT 0.0,
      quality_score REAL CHECK(quality_score >= 0.0 AND quality_score <= 1.0),
      success BOOLEAN NOT NULL,
      
      -- Context
      task_complexity TEXT CHECK(task_complexity IN ('simple', 'medium', 'complex', 'expert')),
      concurrent_agents INTEGER DEFAULT 1,
      resource_usage TEXT NOT NULL DEFAULT '{}', -- JSON: {cpu, memory, etc}
      
      -- Metadata
      error_details TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Task Dependencies (for complex workflows)
    CREATE TABLE IF NOT EXISTS task_dependencies (
      id TEXT PRIMARY KEY,
      dependent_task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
      dependency_task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
      dependency_type TEXT NOT NULL DEFAULT 'blocks' CHECK(dependency_type IN ('blocks', 'related', 'subtask')),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(dependent_task_id, dependency_task_id)
    );

    -- Agent Workload Balancing
    CREATE TABLE IF NOT EXISTS agent_workload (
      agent_id TEXT PRIMARY KEY,
      runtime_id TEXT REFERENCES agent_runtimes(id),
      current_tasks INTEGER DEFAULT 0,
      max_concurrent_tasks INTEGER DEFAULT 3,
      avg_task_duration_ms INTEGER DEFAULT 0,
      success_rate REAL DEFAULT 0.0 CHECK(success_rate >= 0.0 AND success_rate <= 1.0),
      last_task_completed_at DATETIME,
      status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available', 'busy', 'overloaded', 'offline')),
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_session_id ON agent_tasks(session_id);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_assignee ON agent_tasks(assignee_type, assignee_id);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_runtime_id ON agent_tasks(runtime_id);
    CREATE INDEX IF NOT EXISTS idx_task_comments_task_id ON task_comments(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_blockers_task_id ON task_blockers(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_blockers_status ON task_blockers(status);
    CREATE INDEX IF NOT EXISTS idx_agent_skill_assignments_agent_id ON agent_skill_assignments(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_skill_assignments_skill_id ON agent_skill_assignments(skill_id);
    CREATE INDEX IF NOT EXISTS idx_skill_learning_history_agent_id ON skill_learning_history(agent_id);
    CREATE INDEX IF NOT EXISTS idx_runtime_health_logs_runtime_id ON runtime_health_logs(runtime_id);
    CREATE INDEX IF NOT EXISTS idx_runtime_health_logs_recorded_at ON runtime_health_logs(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_agent_performance_analytics_agent_id ON agent_performance_analytics(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_performance_analytics_recorded_at ON agent_performance_analytics(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_task_dependencies_dependent ON task_dependencies(dependent_task_id);
    CREATE INDEX IF NOT EXISTS idx_task_dependencies_dependency ON task_dependencies(dependency_task_id);

    -- Insert default local runtime
    INSERT OR IGNORE INTO agent_runtimes (id, name, type, status, capabilities, resources) 
    VALUES (
      'local-default', 
      'Local Runtime', 
      'local', 
      'active',
      '["ollama", "llamacpp", "nodejs", "python"]',
      '{"cpu": 0, "memory": 0, "disk": 0}'
    );
  `);
}