/**
 * Agent Skill Bundle Evidence & State: Schema migration for complete-bundle
 * reconciliation persistence.
 *
 * Creates:
 *   - `agent_skill_assignment_evidence` — canonical evidence rows linking
 *     each agent/skill assignment to grounded capability-based evidence
 *   - `agent_skill_bundle_state` — per-agent bundle metadata including
 *     input, catalog, and bundle fingerprints for idempotent reconciliation
 *
 * Design principles:
 *   - Both tables are additive and do not alter the existing
 *     `agent_skill_assignments` table or its performance columns
 *     (proficiency_level, success_rate, total_executions, successful_executions,
 *     avg_execution_time_ms, last_used_at, learned_at).
 *   - The evidence table references agent_skill_assignments via a composite
 *     foreign key (agent_id, skill_id) with CASCADE delete to stay consistent
 *     when assignments are removed during stale cleanup.
 *   - The bundle_state table is keyed by agent_id and stores the overall
 *     reconciliation metadata for deterministic no-op detection.
 *   - Indexes support the complete-bundle transaction: fingerprint pre-checks,
 *     stale evidence cleanup, and exact postcondition verification.
 *   - Rollback (down) drops both tables and their indexes cleanly.
 *
 * Requirements: 10.13, 10.14, 10.15, 10.16
 */
import type Database from 'better-sqlite3';

export const version = 73;
export const description = 'Agent skill assignment evidence and bundle state tables for complete-bundle reconciliation';

/**
 * Forward migration: creates evidence and bundle-state tables with required
 * indexes and constraints, fully compatible with existing assignment rows.
 */
export function up(db: Database.Database): void {
  db.exec(`
    -- ═══════════════════════════════════════════════════════════════
    -- Agent Skill Assignment Evidence
    -- ═══════════════════════════════════════════════════════════════
    -- Stores canonical evidence connecting each (agent, skill) assignment
    -- to a material capability through a taxonomy rule or reviewed override.
    -- Multiple evidence rows per (agent, skill) pair are allowed when
    -- multiple capabilities support the same skill assignment.

    CREATE TABLE IF NOT EXISTS agent_skill_assignment_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      -- Assignment identity (composite FK to agent_skill_assignments)
      agent_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,

      -- Evidence fields
      capability_key TEXT NOT NULL,
      reason TEXT NOT NULL,

      -- Source discriminator: 'taxonomy' or 'reviewed-override'
      source_kind TEXT NOT NULL CHECK(source_kind IN ('taxonomy', 'reviewed-override')),

      -- Taxonomy source fields (NULL when source_kind = 'reviewed-override')
      rule_id TEXT,
      evidence_json TEXT,  -- JSON array of CapabilityEvidence records

      -- Override source fields (NULL when source_kind = 'taxonomy')
      override_id TEXT,
      reviewer_id TEXT,
      rationale TEXT,

      -- Timestamps for auditing
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),

      -- Composite FK ensures evidence is removed when the parent assignment is deleted
      FOREIGN KEY (agent_id, skill_id)
        REFERENCES agent_skill_assignments(agent_id, skill_id)
        ON DELETE CASCADE
    );

    -- ═══════════════════════════════════════════════════════════════
    -- Agent Skill Bundle State
    -- ═══════════════════════════════════════════════════════════════
    -- Per-agent metadata for deterministic reconciliation:
    -- stores fingerprints so repeated unchanged reconciliation is a no-op.

    CREATE TABLE IF NOT EXISTS agent_skill_bundle_state (
      -- One row per effective agent
      agent_id TEXT PRIMARY KEY,

      -- Fingerprint of all inputs that produced this bundle
      -- (agent definition, duplicate group, taxonomy, overrides, catalog, assignments)
      input_fingerprint TEXT NOT NULL,

      -- Fingerprint of the authoritative catalog snapshot used during reconciliation
      catalog_fingerprint TEXT NOT NULL,

      -- Fingerprint of the resulting canonical bundle (skill IDs + evidence)
      bundle_fingerprint TEXT NOT NULL,

      -- Canonical JSON array of ascending unique skill IDs in the bundle
      skill_ids_json TEXT NOT NULL,

      -- The reconciliation policy version used (for future schema evolution)
      reconciliation_version INTEGER NOT NULL DEFAULT 1,

      -- Whether the last reconciliation resulted in actual mutations
      last_reconciliation_changed INTEGER NOT NULL DEFAULT 0,

      -- Timestamps
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══════════════════════════════════════════════════════════════
    -- Indexes
    -- ═══════════════════════════════════════════════════════════════

    -- Evidence: lookup by agent+skill for upsert/cleanup during reconciliation
    CREATE INDEX IF NOT EXISTS idx_skill_evidence_agent_skill
      ON agent_skill_assignment_evidence(agent_id, skill_id);

    -- Evidence: lookup by agent for full-bundle evidence retrieval
    CREATE INDEX IF NOT EXISTS idx_skill_evidence_agent
      ON agent_skill_assignment_evidence(agent_id);

    -- Evidence: lookup by capability key for coverage verification
    CREATE INDEX IF NOT EXISTS idx_skill_evidence_capability
      ON agent_skill_assignment_evidence(capability_key);

    -- Evidence: source kind for diagnostics/auditing
    CREATE INDEX IF NOT EXISTS idx_skill_evidence_source_kind
      ON agent_skill_assignment_evidence(source_kind);

    -- Bundle state: fingerprint lookup for stale-catalog detection
    CREATE INDEX IF NOT EXISTS idx_bundle_state_catalog_fp
      ON agent_skill_bundle_state(catalog_fingerprint);

    -- Bundle state: input fingerprint for no-op detection
    CREATE INDEX IF NOT EXISTS idx_bundle_state_input_fp
      ON agent_skill_bundle_state(input_fingerprint);
  `);
}

/**
 * Reverse migration: drops both tables and their indexes.
 * This is safe because:
 * - Evidence and bundle-state are derived/computed data, not primary sources.
 * - The parent agent_skill_assignments table is untouched.
 * - Re-running reconciliation will regenerate all rows.
 */
export function down(db: Database.Database): void {
  db.exec(`
    -- Drop indexes first (some SQLite versions require this before table drop)
    DROP INDEX IF EXISTS idx_skill_evidence_agent_skill;
    DROP INDEX IF EXISTS idx_skill_evidence_agent;
    DROP INDEX IF EXISTS idx_skill_evidence_capability;
    DROP INDEX IF EXISTS idx_skill_evidence_source_kind;
    DROP INDEX IF EXISTS idx_bundle_state_catalog_fp;
    DROP INDEX IF EXISTS idx_bundle_state_input_fp;

    -- Drop tables
    DROP TABLE IF EXISTS agent_skill_assignment_evidence;
    DROP TABLE IF EXISTS agent_skill_bundle_state;
  `);
}
