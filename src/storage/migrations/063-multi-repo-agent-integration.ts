/**
 * Multi-Repo Agent Integration: SQLite schema for agent catalog versioning,
 * audit chain, capability grants, budget controls, policy rules, target
 * allowlists, scope violations, background tasks, skill grants, and
 * security posture configuration.
 *
 * Creates:
 *   - `catalog_versions` — agent catalog version snapshots for rollback
 *   - `audit_events` — tamper-evident audit chain with SHA-256 hash linking
 *   - `capability_grants` — time-limited, scope-bound permission grants
 *   - `run_budgets` — per-run cost tracking and limits
 *   - `daily_budgets` — daily aggregate cost stop-loss controls
 *   - `policy_rules` — fail-closed policy engine rule definitions
 *   - `target_allowlists` — per-integration infrastructure target restrictions
 *   - `scope_violations` — scope access violation log
 *   - `background_tasks` — scheduled/watched background task definitions
 *   - `skill_grants` — grant-based skill sharing between scopes
 *   - `security_posture` — configurable security enforcement levels
 *
 * Requirements: 7.3, 8.3, 9.1, 10.5, 13.5, 19.1
 */
import type Database from 'better-sqlite3';

export const version = 63;
export const description = 'Multi-repo agent integration tables (catalog, audit, grants, budgets, policy, allowlists, scopes, tasks, skills, posture)';

export function up(db: Database.Database): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- Agent Catalog Versioning
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS catalog_versions (
      version INTEGER PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      registry_snapshot TEXT NOT NULL,
      permissions_snapshot TEXT NOT NULL,
      reason TEXT NOT NULL
    );

    -- ═══════════════════════════════════════════════════════════════
    -- Audit Chain
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      sequence_number INTEGER NOT NULL UNIQUE,
      timestamp INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      result_summary TEXT,
      duration_ms INTEGER,
      cost_usd REAL DEFAULT 0,
      previous_hash TEXT NOT NULL,
      current_hash TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_events(timestamp);

    -- ═══════════════════════════════════════════════════════════════
    -- Capability Grants
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS capability_grants (
      id TEXT PRIMARY KEY,
      environment TEXT NOT NULL,
      capability_type TEXT NOT NULL,
      target_set_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      proposed_by TEXT NOT NULL,
      approved_by TEXT,
      lifetime_ms INTEGER NOT NULL,
      max_executions INTEGER NOT NULL,
      remaining_executions INTEGER NOT NULL,
      dry_run_required INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'proposed',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      activated_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_grants_status ON capability_grants(status);
    CREATE INDEX IF NOT EXISTS idx_grants_env ON capability_grants(environment);

    -- ═══════════════════════════════════════════════════════════════
    -- Budget Tracking
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS run_budgets (
      run_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      max_cost_usd REAL NOT NULL,
      current_cost_usd REAL NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      terminated_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_budgets (
      date_utc TEXT PRIMARY KEY,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      stop_loss_usd REAL NOT NULL,
      blocked INTEGER NOT NULL DEFAULT 0
    );

    -- ═══════════════════════════════════════════════════════════════
    -- Policy Rules
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS policy_rules (
      id TEXT PRIMARY KEY,
      priority INTEGER NOT NULL,
      action TEXT NOT NULL,
      conditions_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_policy_priority ON policy_rules(priority);

    -- ═══════════════════════════════════════════════════════════════
    -- Target Allowlists
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS target_allowlists (
      id TEXT PRIMARY KEY,
      context_type TEXT NOT NULL,
      target_value TEXT NOT NULL,
      access_level TEXT NOT NULL DEFAULT 'read-only',
      validated INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_allowlist_type ON target_allowlists(context_type);

    -- ═══════════════════════════════════════════════════════════════
    -- Scope Violations Log
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS scope_violations (
      id TEXT PRIMARY KEY,
      agent_scope_json TEXT NOT NULL,
      requested_scope_json TEXT NOT NULL,
      resource TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );

    -- ═══════════════════════════════════════════════════════════════
    -- Background Tasks
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS background_tasks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      trigger_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      last_run INTEGER,
      next_run INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      created_at INTEGER NOT NULL
    );

    -- ═══════════════════════════════════════════════════════════════
    -- Skill Grants
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS skill_grants (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      source_scope_json TEXT NOT NULL,
      target_scope_json TEXT NOT NULL,
      permission_level TEXT NOT NULL,
      granted_at INTEGER NOT NULL,
      granted_by TEXT NOT NULL
    );

    -- ═══════════════════════════════════════════════════════════════
    -- Security Posture Configuration
    -- ═══════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS security_posture (
      scope_id TEXT PRIMARY KEY,
      level TEXT NOT NULL,
      risk_threshold REAL DEFAULT 0.5,
      updated_at INTEGER NOT NULL
    );
  `);
}
