/**
 * Superagent Schema Migration — Consolidates all SQLite table creation
 * statements from the superagent subsystems into a single migration function.
 *
 * Executes table creation conditionally based on which feature gates are
 * enabled. Uses CREATE TABLE IF NOT EXISTS for idempotent execution, allowing
 * the migration to run safely on every startup.
 *
 * Tables consolidated:
 * - cost_records (CostTrackingService) — Req 1.5
 * - behavioral_rules (BehavioralRulesEngine) — Req 11.3
 * - scheduled_tasks (SchedulerService) — Req 22.3
 * - skills (SkillExtractor) — Req 21.4
 * - spec_gap_reports (BackpropagationEngine) — Req 30.3
 * - compliance_audits (ComplianceGateRunner) — Req 27.5
 * - trace_entries extensions (TraceVisualizationService) — Req 12.1
 *
 * Requirements: 1.5, 12.1, 11.3, 22.3, 27.5, 30.3, 21.4
 */

import { COST_RECORDS_TABLE_SQL } from '../observability/cost-tracking-service.js';
import { BEHAVIORAL_RULES_TABLE_SQL } from '../intelligence/behavioral-rules-engine.js';
import { SCHEDULED_TASKS_TABLE_SQL } from '../durability/scheduler-service.js';
import { SKILLS_TABLE_SQL } from '../devex/skill-extractor.js';
import { SPEC_GAP_REPORTS_TABLE_SQL } from '../intelligence/backpropagation-engine.js';
import { COMPLIANCE_AUDITS_TABLE_SQL } from '../devex/compliance-gate-runner.js';
import { TRACE_VISUALIZATION_COLUMNS_SQL } from '../observability/trace-visualization-service.js';
import type { FeatureGateFlags } from '../feature-gate/feature-gate-config.js';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Minimal database interface required for migration execution.
 * Compatible with better-sqlite3's Database.exec() method.
 */
export interface MigrationDatabase {
  exec(sql: string): void;
}

/**
 * Subset of FeatureGateFlags indicating which features are currently enabled.
 * Only features that require schema changes are included.
 */
export type EnabledFeatures = Partial<Pick<
  FeatureGateFlags,
  | 'cost_tracking'
  | 'self_improvement'
  | 'scheduled_tasks'
  | 'skill_creation'
  | 'backpropagation'
  | 'compliance_gates'
  | 'trace_visualization'
>>;

/**
 * Result of running the schema migration.
 */
export interface MigrationResult {
  /** Tables that were created or already existed */
  tablesProcessed: string[];
  /** Any errors encountered (non-fatal, logged for diagnostics) */
  warnings: string[];
}

// ─── Migration Definitions ──────────────────────────────────────

interface MigrationEntry {
  /** Name of the table being created */
  tableName: string;
  /** The feature gate flag that controls this migration */
  featureFlag: keyof EnabledFeatures;
  /** SQL statement(s) to execute */
  sql: string;
  /** Whether this is a column extension rather than a new table */
  isExtension?: boolean;
}

/**
 * All superagent schema migrations, ordered by subsystem.
 * Each entry is gated behind its corresponding feature flag.
 */
const MIGRATIONS: MigrationEntry[] = [
  {
    tableName: 'cost_records',
    featureFlag: 'cost_tracking',
    sql: COST_RECORDS_TABLE_SQL,
  },
  {
    tableName: 'behavioral_rules',
    featureFlag: 'self_improvement',
    sql: BEHAVIORAL_RULES_TABLE_SQL,
  },
  {
    tableName: 'scheduled_tasks',
    featureFlag: 'scheduled_tasks',
    sql: SCHEDULED_TASKS_TABLE_SQL,
  },
  {
    tableName: 'skills',
    featureFlag: 'skill_creation',
    sql: SKILLS_TABLE_SQL,
  },
  {
    tableName: 'spec_gap_reports',
    featureFlag: 'backpropagation',
    sql: SPEC_GAP_REPORTS_TABLE_SQL,
  },
  {
    tableName: 'compliance_audits',
    featureFlag: 'compliance_gates',
    sql: COMPLIANCE_AUDITS_TABLE_SQL,
  },
  {
    tableName: 'trace_entries (extensions)',
    featureFlag: 'trace_visualization',
    sql: TRACE_VISUALIZATION_COLUMNS_SQL,
    isExtension: true,
  },
];

// ─── Public API ─────────────────────────────────────────────────

/**
 * Run all superagent schema migrations conditionally based on enabled features.
 *
 * This function is idempotent — it uses CREATE TABLE IF NOT EXISTS and
 * safely handles duplicate ALTER TABLE calls for column extensions.
 * It should be called during application startup after the FeatureGateSystem
 * has resolved its configuration.
 *
 * @param db - A database instance with an exec() method (e.g., better-sqlite3)
 * @param enabledFeatures - Map of feature flags indicating which are currently enabled
 * @returns Migration result with processed tables and any warnings
 *
 * @example
 * ```typescript
 * import Database from 'better-sqlite3';
 * import { runSuperagentMigrations } from './superagent-schema-migration.js';
 *
 * const db = new Database('neuronest.db');
 * const result = runSuperagentMigrations(db, {
 *   cost_tracking: true,
 *   trace_visualization: true,
 * });
 * ```
 */
export function runSuperagentMigrations(
  db: MigrationDatabase,
  enabledFeatures: EnabledFeatures,
): MigrationResult {
  const tablesProcessed: string[] = [];
  const warnings: string[] = [];

  for (const migration of MIGRATIONS) {
    // Only run migration if the corresponding feature gate is enabled
    if (!enabledFeatures[migration.featureFlag]) {
      continue;
    }

    try {
      if (migration.isExtension) {
        // Column extensions need special handling — each ALTER TABLE may fail
        // individually if the column already exists, which is expected.
        executeSafeColumnExtension(db, migration.sql);
      } else {
        db.exec(migration.sql);
      }
      tablesProcessed.push(migration.tableName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Migration for '${migration.tableName}' encountered an issue: ${message}`);
    }
  }

  return { tablesProcessed, warnings };
}

// ─── Internal Helpers ───────────────────────────────────────────

/**
 * Execute column extension SQL safely by running each statement individually.
 * ALTER TABLE ADD COLUMN will throw if the column already exists, which is
 * expected on repeated runs. Each statement is executed independently so that
 * a failure on one doesn't prevent the others from running.
 */
function executeSafeColumnExtension(db: MigrationDatabase, sql: string): void {
  // Split on semicolons and execute each statement individually
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    try {
      db.exec(stmt);
    } catch {
      // Column/index already exists — safe to ignore on idempotent re-runs
    }
  }
}
