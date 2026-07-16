/**
 * FeatureGateStore — SQLite-backed centralized feature configuration authority.
 *
 * Provides persistent global/project overrides, dependency validation,
 * profile export/import, and an auditable change log. Replaces fragmented
 * hardcoded `new FeatureGateSystem({...})` instances with one shared store.
 *
 * Requirements: 2.1, 2.3, 2.4, 2.5, 2.7, 2.10, 2.12
 */

import type Database from 'better-sqlite3';
import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_DEPENDENCIES,
  ENHANCED_FEATURE_DEPENDENCIES,
  RUNTIME_SECURITY_DEPENDENCIES,
  LOOP_ENGINE_DEPENDENCIES,
  type FeatureDependency,
  type FeatureGateFlags,
} from './feature-gate-config.js';

// ─── Public Types ───────────────────────────────────────────────

export interface EffectiveState {
  enabled: boolean;
  source: 'default' | 'global' | 'project' | 'dependency' | 'runtime';
  available: boolean;
  reason?: string;
}

export interface FeatureProfile {
  version: number;
  exportedAt: string;
  global: Partial<Record<keyof FeatureGateFlags, boolean>>;
  projects: Record<string, Partial<Record<keyof FeatureGateFlags, boolean>>>;
}

export interface ImportResult {
  success: boolean;
  imported: number;
  skipped: number;
  errors: string[];
}

export interface AuditEntry {
  id: number;
  flag: string;
  scope: 'global' | 'project';
  projectId: string | null;
  prevValue: boolean | null;
  newValue: boolean;
  timestamp: string;
  source: string;
}

export interface AuditFilter {
  flag?: keyof FeatureGateFlags;
  scope?: 'global' | 'project';
  projectId?: string;
  since?: string;
  limit?: number;
}

export interface DependencyResult {
  valid: boolean;
  satisfied: (keyof FeatureGateFlags)[];
  missing: (keyof FeatureGateFlags)[];
  incompatible: (keyof FeatureGateFlags)[];
  missingAny?: (keyof FeatureGateFlags)[];
}

// ─── Internal Types ─────────────────────────────────────────────

interface ConfigRow {
  flag: string;
  scope: string;
  project_id: string | null;
  value: number;
  updated_at: string;
  source: string;
}

interface AuditRow {
  id: number;
  flag: string;
  scope: string;
  project_id: string | null;
  prev_value: number | null;
  new_value: number;
  timestamp: string;
  source: string;
}

// ─── FeatureGateStore ───────────────────────────────────────────

export class FeatureGateStore {
  private db: Database.Database;
  private runtimeDisabled: Set<keyof FeatureGateFlags> = new Set();
  private runtimeDisableReasons: Map<keyof FeatureGateFlags, string> = new Map();

  // Prepared statements
  private stmtGetGlobal: Database.Statement;
  private stmtGetProject: Database.Statement;
  private stmtUpsertConfig: Database.Statement;
  private stmtDeleteConfig: Database.Statement;
  private stmtInsertAudit: Database.Statement;
  private stmtGetAllGlobal: Database.Statement;
  private stmtGetAllConfigs: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.ensureSchema();

    this.stmtGetGlobal = db.prepare(
      `SELECT value FROM feature_gate_config WHERE flag = ? AND scope = 'global' AND project_id = ''`,
    );

    this.stmtGetProject = db.prepare(
      `SELECT value FROM feature_gate_config WHERE flag = ? AND scope = 'project' AND project_id = ?`,
    );

    this.stmtUpsertConfig = db.prepare(
      `INSERT INTO feature_gate_config (flag, scope, project_id, value, updated_at, source)
       VALUES (?, ?, ?, ?, datetime('now'), ?)
       ON CONFLICT(flag, scope, project_id) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at,
         source = excluded.source`,
    );

    this.stmtDeleteConfig = db.prepare(
      `DELETE FROM feature_gate_config WHERE flag = ? AND scope = ? AND project_id = ?`,
    );

    this.stmtInsertAudit = db.prepare(
      `INSERT INTO feature_gate_audit (flag, scope, project_id, prev_value, new_value, timestamp, source)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`,
    );

    this.stmtGetAllGlobal = db.prepare(
      `SELECT flag, value FROM feature_gate_config WHERE scope = 'global' AND project_id = ''`,
    );

    this.stmtGetAllConfigs = db.prepare(
      `SELECT flag, scope, project_id, value, updated_at, source FROM feature_gate_config`,
    );
  }

  // ─── Core API ───────────────────────────────────────────────────

  /**
   * Resolve the effective state of a feature flag.
   * Priority: runtime disable > project override > global override > default.
   */
  getEffective(flag: keyof FeatureGateFlags, projectId?: string): EffectiveState {
    // Check runtime disable first
    if (this.runtimeDisabled.has(flag)) {
      return {
        enabled: false,
        source: 'runtime',
        available: false,
        reason: this.runtimeDisableReasons.get(flag) ?? 'Disabled at runtime',
      };
    }

    // Check dependency satisfaction — if dependencies not met, feature unavailable
    const depResult = this.validateDependencies(flag);
    if (!depResult.valid) {
      const missing = depResult.missing.length > 0
        ? `Missing prerequisites: ${depResult.missing.join(', ')}`
        : depResult.incompatible.length > 0
          ? `Incompatible with: ${depResult.incompatible.join(', ')}`
          : depResult.missingAny && depResult.missingAny.length > 0
            ? `Requires at least one of: ${depResult.missingAny.join(', ')}`
            : 'Dependency validation failed';

      return {
        enabled: false,
        source: 'dependency',
        available: false,
        reason: missing,
      };
    }

    // Project override takes precedence
    if (projectId) {
      const projectRow = this.stmtGetProject.get(flag, projectId) as { value: number } | undefined;
      if (projectRow !== undefined) {
        return {
          enabled: projectRow.value === 1,
          source: 'project',
          available: true,
        };
      }
    }

    // Global override
    const globalRow = this.stmtGetGlobal.get(flag) as { value: number } | undefined;
    if (globalRow !== undefined) {
      return {
        enabled: globalRow.value === 1,
        source: 'global',
        available: true,
      };
    }

    // Default value
    return {
      enabled: DEFAULT_FEATURE_FLAGS[flag] ?? false,
      source: 'default',
      available: true,
    };
  }

  /**
   * Set a global override for a feature flag.
   */
  setGlobal(flag: keyof FeatureGateFlags, value: boolean, source: string = 'user'): void {
    const prev = this.getGlobalValue(flag);
    const numValue = value ? 1 : 0;

    this.stmtUpsertConfig.run(flag, 'global', '', numValue, source);
    this.stmtInsertAudit.run(
      flag,
      'global',
      null,
      prev !== null ? (prev ? 1 : 0) : null,
      numValue,
      source,
    );
  }

  /**
   * Set a project-scoped override for a feature flag.
   */
  setProject(flag: keyof FeatureGateFlags, projectId: string, value: boolean, source: string = 'user'): void {
    const prev = this.getProjectValue(flag, projectId);
    const numValue = value ? 1 : 0;

    this.stmtUpsertConfig.run(flag, 'project', projectId, numValue, source);
    this.stmtInsertAudit.run(
      flag,
      'project',
      projectId,
      prev !== null ? (prev ? 1 : 0) : null,
      numValue,
      source,
    );
  }

  /**
   * Reset a flag to its default by removing the override.
   */
  resetToDefault(flag: keyof FeatureGateFlags, scope: 'global' | 'project', projectId?: string): void {
    if (scope === 'global') {
      const prev = this.getGlobalValue(flag);
      this.stmtDeleteConfig.run(flag, 'global', '');
      if (prev !== null) {
        this.stmtInsertAudit.run(
          flag,
          'global',
          null,
          prev ? 1 : 0,
          DEFAULT_FEATURE_FLAGS[flag] ? 1 : 0,
          'reset',
        );
      }
    } else if (scope === 'project' && projectId) {
      const prev = this.getProjectValue(flag, projectId);
      this.stmtDeleteConfig.run(flag, 'project', projectId);
      if (prev !== null) {
        this.stmtInsertAudit.run(
          flag,
          'project',
          projectId,
          prev ? 1 : 0,
          DEFAULT_FEATURE_FLAGS[flag] ? 1 : 0,
          'reset',
        );
      }
    }
  }

  /**
   * Export all configuration overrides as a portable profile.
   */
  exportProfile(): FeatureProfile {
    const globalRows = this.stmtGetAllGlobal.all() as Array<{ flag: string; value: number }>;
    const allConfigs = this.stmtGetAllConfigs.all() as ConfigRow[];

    const global: Partial<Record<keyof FeatureGateFlags, boolean>> = {};
    for (const row of globalRows) {
      global[row.flag as keyof FeatureGateFlags] = row.value === 1;
    }

    const projects: Record<string, Partial<Record<keyof FeatureGateFlags, boolean>>> = {};
    for (const row of allConfigs) {
      if (row.scope === 'project' && row.project_id && row.project_id !== '') {
        if (!projects[row.project_id]) {
          projects[row.project_id] = {};
        }
        projects[row.project_id]![row.flag as keyof FeatureGateFlags] = row.value === 1;
      }
    }

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      global,
      projects,
    };
  }

  /**
   * Import a feature profile, overwriting existing overrides.
   */
  importProfile(profile: FeatureProfile): ImportResult {
    const errors: string[] = [];
    let imported = 0;
    let skipped = 0;

    if (!profile || profile.version !== 1) {
      return { success: false, imported: 0, skipped: 0, errors: ['Unsupported profile version'] };
    }

    const transaction = this.db.transaction(() => {
      // Import global overrides
      if (profile.global) {
        for (const [flag, value] of Object.entries(profile.global)) {
          if (!isValidFlag(flag)) {
            errors.push(`Unknown flag: ${flag}`);
            skipped++;
            continue;
          }
          if (typeof value !== 'boolean') {
            errors.push(`Invalid value for ${flag}: ${value}`);
            skipped++;
            continue;
          }
          this.setGlobal(flag as keyof FeatureGateFlags, value, 'import');
          imported++;
        }
      }

      // Import project overrides
      if (profile.projects) {
        for (const [projectId, flags] of Object.entries(profile.projects)) {
          if (!flags || typeof flags !== 'object') continue;
          for (const [flag, value] of Object.entries(flags)) {
            if (!isValidFlag(flag)) {
              errors.push(`Unknown flag: ${flag}`);
              skipped++;
              continue;
            }
            if (typeof value !== 'boolean') {
              errors.push(`Invalid value for ${flag}: ${value}`);
              skipped++;
              continue;
            }
            this.setProject(flag as keyof FeatureGateFlags, projectId, value, 'import');
            imported++;
          }
        }
      }
    });

    transaction();

    return {
      success: errors.length === 0,
      imported,
      skipped,
      errors,
    };
  }

  /**
   * Retrieve the audit log, optionally filtered.
   */
  getAuditLog(filter?: AuditFilter): AuditEntry[] {
    let sql = 'SELECT id, flag, scope, project_id, prev_value, new_value, timestamp, source FROM feature_gate_audit WHERE 1=1';
    const params: unknown[] = [];

    if (filter?.flag) {
      sql += ' AND flag = ?';
      params.push(filter.flag);
    }
    if (filter?.scope) {
      sql += ' AND scope = ?';
      params.push(filter.scope);
    }
    if (filter?.projectId) {
      sql += ' AND project_id = ?';
      params.push(filter.projectId);
    }
    if (filter?.since) {
      sql += ' AND timestamp >= ?';
      params.push(filter.since);
    }

    sql += ' ORDER BY id DESC';

    if (filter?.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as AuditRow[];

    return rows.map((row) => ({
      id: row.id,
      flag: row.flag,
      scope: row.scope as 'global' | 'project',
      projectId: row.project_id,
      prevValue: row.prev_value !== null ? row.prev_value === 1 : null,
      newValue: row.new_value === 1,
      timestamp: row.timestamp,
      source: row.source,
    }));
  }

  /**
   * Validate all dependencies for a given flag.
   * Returns which prerequisites are met, missing, or incompatible.
   */
  validateDependencies(flag: keyof FeatureGateFlags): DependencyResult {
    const allDeps = this.getAllDependencies();
    const satisfied: (keyof FeatureGateFlags)[] = [];
    const missing: (keyof FeatureGateFlags)[] = [];
    const incompatible: (keyof FeatureGateFlags)[] = [];
    let missingAny: (keyof FeatureGateFlags)[] | undefined;

    // Find dependency declarations for this flag
    const flagDeps = allDeps.filter((d) => d.feature === flag);

    if (flagDeps.length === 0) {
      // No dependency declarations — always valid
      return { valid: true, satisfied: [], missing: [], incompatible: [] };
    }

    for (const dep of flagDeps) {
      // Check hard prerequisites
      if (dep.requires) {
        for (const req of dep.requires) {
          if (this.isEffectivelyEnabled(req)) {
            satisfied.push(req);
          } else {
            missing.push(req);
          }
        }
      }

      // Check requiresAny
      if (dep.requiresAny && dep.requiresAny.length > 0) {
        const hasAny = dep.requiresAny.some((req) => this.isEffectivelyEnabled(req));
        if (!hasAny) {
          missingAny = dep.requiresAny as (keyof FeatureGateFlags)[];
        } else {
          for (const req of dep.requiresAny) {
            if (this.isEffectivelyEnabled(req)) {
              satisfied.push(req);
            }
          }
        }
      }

      // Check incompatibilities
      if (dep.incompatible) {
        for (const incompat of dep.incompatible) {
          if (this.isEffectivelyEnabled(incompat)) {
            incompatible.push(incompat);
          }
        }
      }
    }

    const valid = missing.length === 0 && incompatible.length === 0 && !missingAny;

    const result: DependencyResult = { valid, satisfied, missing, incompatible };
    if (missingAny) {
      result.missingAny = missingAny;
    }
    return result;
  }

  // ─── Runtime State Management ─────────────────────────────────

  /**
   * Mark a feature as disabled at runtime (e.g., native module failed to load).
   */
  disableAtRuntime(flag: keyof FeatureGateFlags, reason: string): void {
    this.runtimeDisabled.add(flag);
    this.runtimeDisableReasons.set(flag, reason);
  }

  /**
   * Re-enable a feature that was previously disabled at runtime.
   */
  enableAtRuntime(flag: keyof FeatureGateFlags): void {
    this.runtimeDisabled.delete(flag);
    this.runtimeDisableReasons.delete(flag);
  }

  /**
   * Check if a feature is disabled at runtime.
   */
  isRuntimeDisabled(flag: keyof FeatureGateFlags): boolean {
    return this.runtimeDisabled.has(flag);
  }

  /**
   * Get the reason a feature was disabled at runtime.
   */
  getRuntimeDisableReason(flag: keyof FeatureGateFlags): string | undefined {
    return this.runtimeDisableReasons.get(flag);
  }

  // ─── Helpers ──────────────────────────────────────────────────

  /**
   * Check if a flag is effectively enabled (considering global override and default)
   * without doing full dependency check (avoids recursion in validateDependencies).
   */
  private isEffectivelyEnabled(flag: keyof FeatureGateFlags): boolean {
    if (this.runtimeDisabled.has(flag)) return false;

    const globalRow = this.stmtGetGlobal.get(flag) as { value: number } | undefined;
    if (globalRow !== undefined) return globalRow.value === 1;

    return DEFAULT_FEATURE_FLAGS[flag] ?? false;
  }

  /**
   * Get the current global override value for a flag, or null if no override.
   */
  private getGlobalValue(flag: keyof FeatureGateFlags): boolean | null {
    const row = this.stmtGetGlobal.get(flag) as { value: number } | undefined;
    return row !== undefined ? row.value === 1 : null;
  }

  /**
   * Get the current project override value for a flag, or null if no override.
   */
  private getProjectValue(flag: keyof FeatureGateFlags, projectId: string): boolean | null {
    const row = this.stmtGetProject.get(flag, projectId) as { value: number } | undefined;
    return row !== undefined ? row.value === 1 : null;
  }

  /**
   * Get all dependency declarations across all sources.
   */
  private getAllDependencies(): FeatureDependency[] {
    return [
      ...FEATURE_DEPENDENCIES,
      ...ENHANCED_FEATURE_DEPENDENCIES,
      ...RUNTIME_SECURITY_DEPENDENCIES,
      ...LOOP_ENGINE_DEPENDENCIES,
    ];
  }

  /**
   * Ensure the schema exists (idempotent).
   */
  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feature_gate_config (
        flag TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
        project_id TEXT NOT NULL DEFAULT '',
        value INTEGER NOT NULL CHECK (value IN (0, 1)),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        source TEXT NOT NULL DEFAULT 'user',
        PRIMARY KEY (flag, scope, project_id)
      );

      CREATE TABLE IF NOT EXISTS feature_gate_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        flag TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
        project_id TEXT,
        prev_value INTEGER,
        new_value INTEGER NOT NULL CHECK (new_value IN (0, 1)),
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        source TEXT NOT NULL DEFAULT 'user'
      );
    `);
  }
}

// ─── Utility ────────────────────────────────────────────────────

/**
 * Check if a string is a valid FeatureGateFlags key.
 */
function isValidFlag(flag: string): flag is keyof FeatureGateFlags {
  return flag in DEFAULT_FEATURE_FLAGS;
}
