import type Database from 'better-sqlite3';

export const version = 4;
export const description = 'Agent Skills SQLite Integration: Additional tables for Agent Skills system consolidation';

export function up(db: Database.Database): void {
  db.exec(`
    -- Skill Events Table (Enhanced Event Tracking)
    -- Replaces TimescaleDB event store with SQLite-based event tracking
    CREATE TABLE IF NOT EXISTS skill_events (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('skill', 'agent', 'assignment', 'task')),
      entity_id TEXT NOT NULL,
      event_data TEXT, -- JSON object containing event details
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      correlation_id TEXT, -- For tracking related events
      source TEXT, -- Source system/component
      session_id TEXT REFERENCES sessions(id), -- Link to NeuroNest session if applicable
      
      -- Time-series optimization for SQLite
      partition_date DATE
    );

    -- Agent Skills Configuration Table
    -- Centralized configuration for Agent Skills system
    CREATE TABLE IF NOT EXISTS agent_skills_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL, -- JSON serialized configuration value
      description TEXT,
      config_type TEXT DEFAULT 'system' CHECK(config_type IN ('system', 'user', 'project')),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Cache Backing Table
    -- SQLite backing store for in-memory cache persistence
    CREATE TABLE IF NOT EXISTS cache_entries (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL, -- JSON serialized value
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes for performance optimization
    CREATE INDEX IF NOT EXISTS idx_skill_events_timestamp ON skill_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_skill_events_type ON skill_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_skill_events_entity ON skill_events(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_skill_events_partition ON skill_events(partition_date, timestamp);
    CREATE INDEX IF NOT EXISTS idx_skill_events_correlation ON skill_events(correlation_id);
    CREATE INDEX IF NOT EXISTS idx_skill_events_session ON skill_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries(expires_at);
    CREATE INDEX IF NOT EXISTS idx_cache_accessed ON cache_entries(accessed_at);

    -- Trigger to automatically set partition_date
    CREATE TRIGGER IF NOT EXISTS skill_events_partition_date_trigger
    AFTER INSERT ON skill_events
    FOR EACH ROW
    WHEN NEW.partition_date IS NULL
    BEGIN
      UPDATE skill_events 
      SET partition_date = DATE(NEW.timestamp) 
      WHERE id = NEW.id;
    END;

    -- Insert default Agent Skills configuration
    INSERT OR IGNORE INTO agent_skills_config (key, value, description, config_type) VALUES
    ('auto_assignment_enabled', 'true', 'Enable automatic skill assignment', 'system'),
    ('competency_tracking_enabled', 'true', 'Enable competency score tracking', 'system'),
    ('skill_recommendation_threshold', '0.7', 'Minimum confidence for skill recommendations', 'system'),
    ('max_concurrent_assignments', '5', 'Maximum concurrent skill assignments per agent', 'system'),
    ('event_retention_days', '90', 'Number of days to retain skill events', 'system'),
    ('cache_default_ttl_seconds', '3600', 'Default TTL for cache entries in seconds', 'system'),
    ('performance_tracking_enabled', 'true', 'Enable performance analytics tracking', 'system');
  `);
}