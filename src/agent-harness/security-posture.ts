/**
 * Security Posture — Configurable enforcement levels for agent operations.
 *
 * Supports three modes:
 * - strict: All tool calls require human approval
 * - auto: A risk classifier screens operations; escalates above threshold
 * - autonomous: No approval pauses except for policy denials
 *
 * Tightening rule: autonomous < auto < strict.
 * Project-level settings can only tighten (not loosen) workspace-level settings.
 *
 * Persistence: security_posture SQLite table (migration 063).
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5
 */

import type Database from 'better-sqlite3';
import type { SecurityPostureLevel, SecurityPostureConfig } from './types.js';

// ─── Constants ──────────────────────────────────────────────────

/**
 * Strictness ordering: higher value = stricter.
 * autonomous (0) < auto (1) < strict (2)
 */
const STRICTNESS_ORDER: Record<SecurityPostureLevel, number> = {
  autonomous: 0,
  auto: 1,
  strict: 2,
};

const VALID_LEVELS: Set<string> = new Set(['strict', 'auto', 'autonomous']);

const DEFAULT_RISK_THRESHOLD = 0.5;
const WORKSPACE_SCOPE_ID = 'workspace';

// ─── Interfaces ─────────────────────────────────────────────────

export interface SecurityPosture {
  /** Get effective posture for a project (project override if valid, otherwise workspace) */
  getEffective(projectId: string): SecurityPostureLevel;

  /** Set workspace-level posture */
  setWorkspacePosture(level: SecurityPostureLevel): void;

  /** Set project-level override (can only tighten); returns false if attempting to loosen */
  setProjectPosture(projectId: string, level: SecurityPostureLevel): boolean;

  /** Evaluate if a tool call needs human approval based on posture */
  requiresApproval(toolName: string, riskScore: number, projectId: string): boolean;

  /** Get the full current configuration (workspace + all project overrides) */
  getConfig(): SecurityPostureConfig;

  /** Get the configured risk threshold for auto mode */
  getRiskThreshold(): number;

  /** Set the risk threshold for auto mode (0-1) */
  setRiskThreshold(threshold: number): void;
}

// ─── Internal types ─────────────────────────────────────────────

interface PostureRow {
  scope_id: string;
  level: string;
  risk_threshold: number;
  updated_at: number;
}

// ─── Implementation ─────────────────────────────────────────────

export class SecurityPostureManager implements SecurityPosture {
  // Prepared statements for efficient repeated queries
  private stmtGet: Database.Statement;
  private stmtUpsert: Database.Statement;
  private stmtGetAll: Database.Statement;

  constructor(db: Database.Database) {
    this.stmtGet = db.prepare(
      `SELECT scope_id, level, risk_threshold, updated_at FROM security_posture WHERE scope_id = ?`,
    );

    this.stmtUpsert = db.prepare(
      `INSERT INTO security_posture (scope_id, level, risk_threshold, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(scope_id) DO UPDATE SET
         level = excluded.level,
         risk_threshold = excluded.risk_threshold,
         updated_at = excluded.updated_at`,
    );

    // Prepared for future use (removals)
    db.prepare(`DELETE FROM security_posture WHERE scope_id = ?`);

    this.stmtGetAll = db.prepare(
      `SELECT scope_id, level, risk_threshold, updated_at FROM security_posture`,
    );
  }

  // ─── Core API ─────────────────────────────────────────────────

  getEffective(projectId: string): SecurityPostureLevel {
    const workspaceLevel = this.getWorkspaceLevel();

    // Check for project-level override
    const projectRow = this.stmtGet.get(projectId) as PostureRow | undefined;
    if (projectRow && isValidLevel(projectRow.level)) {
      const projectLevel = projectRow.level as SecurityPostureLevel;
      // Only use project override if it's equal to or stricter than workspace
      if (isAtLeastAsStrict(projectLevel, workspaceLevel)) {
        return projectLevel;
      }
      // If project override has become invalid (workspace was tightened after),
      // fall back to workspace level
    }

    return workspaceLevel;
  }

  setWorkspacePosture(level: SecurityPostureLevel): void {
    if (!isValidLevel(level)) {
      throw new Error(`Invalid security posture level: ${level}`);
    }

    const threshold = this.getRiskThreshold();
    this.stmtUpsert.run(WORKSPACE_SCOPE_ID, level, threshold, Date.now());
  }

  setProjectPosture(projectId: string, level: SecurityPostureLevel): boolean {
    if (!isValidLevel(level)) {
      throw new Error(`Invalid security posture level: ${level}`);
    }

    const workspaceLevel = this.getWorkspaceLevel();

    // Tightening rule: project can only be equal to or stricter than workspace
    if (!isAtLeastAsStrict(level, workspaceLevel)) {
      return false;
    }

    const threshold = this.getRiskThreshold();
    this.stmtUpsert.run(projectId, level, threshold, Date.now());
    return true;
  }

  requiresApproval(_toolName: string, riskScore: number, projectId: string): boolean {
    const effectiveLevel = this.getEffective(projectId);

    switch (effectiveLevel) {
      case 'strict':
        // All tool calls require approval
        return true;

      case 'auto': {
        // Only escalate when risk score exceeds threshold
        const threshold = this.getRiskThreshold();
        return riskScore > threshold;
      }

      case 'autonomous':
        // No approval pauses (except policy denials handled elsewhere)
        return false;

      default:
        // Fail-safe: unknown posture defaults to requiring approval
        return true;
    }
  }

  getConfig(): SecurityPostureConfig {
    const workspaceLevel = this.getWorkspaceLevel();
    const threshold = this.getRiskThreshold();

    const allRows = this.stmtGetAll.all() as PostureRow[];
    const projectOverrides: Record<string, SecurityPostureLevel> = {};

    for (const row of allRows) {
      if (row.scope_id !== WORKSPACE_SCOPE_ID && isValidLevel(row.level)) {
        projectOverrides[row.scope_id] = row.level as SecurityPostureLevel;
      }
    }

    return {
      workspaceLevel,
      projectOverrides,
      riskThreshold: threshold,
    };
  }

  getRiskThreshold(): number {
    const row = this.stmtGet.get(WORKSPACE_SCOPE_ID) as PostureRow | undefined;
    if (row && typeof row.risk_threshold === 'number') {
      return row.risk_threshold;
    }
    return DEFAULT_RISK_THRESHOLD;
  }

  setRiskThreshold(threshold: number): void {
    if (threshold < 0 || threshold > 1) {
      throw new Error(`Risk threshold must be between 0 and 1, got: ${threshold}`);
    }

    const workspaceLevel = this.getWorkspaceLevel();
    this.stmtUpsert.run(WORKSPACE_SCOPE_ID, workspaceLevel, threshold, Date.now());
  }

  // ─── Helpers ──────────────────────────────────────────────────

  /**
   * Get the current workspace-level posture. Defaults to 'auto' if not configured.
   */
  private getWorkspaceLevel(): SecurityPostureLevel {
    const row = this.stmtGet.get(WORKSPACE_SCOPE_ID) as PostureRow | undefined;
    if (row && isValidLevel(row.level)) {
      return row.level as SecurityPostureLevel;
    }
    return 'auto';
  }
}

// ─── Utility Functions ──────────────────────────────────────────

/**
 * Check if a level string is a valid SecurityPostureLevel.
 */
function isValidLevel(level: string): level is SecurityPostureLevel {
  return VALID_LEVELS.has(level);
}

/**
 * Check if `level` is at least as strict as `reference`.
 * Returns true when level >= reference in the strictness ordering.
 */
function isAtLeastAsStrict(
  level: SecurityPostureLevel,
  reference: SecurityPostureLevel,
): boolean {
  return STRICTNESS_ORDER[level] >= STRICTNESS_ORDER[reference];
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Create a SecurityPostureManager instance backed by the given database.
 * The database must have the security_posture table (migration 063).
 */
export function createSecurityPosture(db: Database.Database): SecurityPosture {
  return new SecurityPostureManager(db);
}
