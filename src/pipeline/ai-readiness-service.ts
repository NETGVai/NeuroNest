/**
 * Production Readiness Service — Extended production-readiness grading.
 *
 * Computes a 0–100 overall score with 7 dimensions:
 *   - testCoverage: percentage of code with test coverage
 *   - e2ePassRate: pass rate of E2E acceptance tests
 *   - accessibilityScore: operability friction score
 *   - docsFreshness: documentation staleness vs. exports
 *   - adrPresence: architecture decision records present
 *   - dependencyAuditAge: how recently deps were audited (days since last audit)
 *   - bloatScore: over-engineering / bloat dimension
 *
 * Also includes auditAgentSetup() for detecting:
 *   - Missing skill assignments for configured agents
 *   - Over-broad tool permissions
 *   - Disabled firewall tiers
 *
 * Gated behind the `production_readiness` feature flag.
 *
 * Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

// ─── Interfaces ─────────────────────────────────────────────────

/**
 * Per-dimension breakdown of the production readiness grade.
 */
export interface ProductionReadinessDimensions {
  /** Test coverage percentage (0–100) */
  testCoverage: number;
  /** E2E acceptance test pass rate (0–100) */
  e2ePassRate: number;
  /** Accessibility operability score (0–100, 100 = no issues) */
  accessibilityScore: number;
  /** Documentation freshness score (0–100, 100 = fully fresh) */
  docsFreshness: number;
  /** ADR presence score (0–100, 100 = all decisions recorded) */
  adrPresence: number;
  /** Dependency audit age score (0–100, 100 = recently audited) */
  dependencyAuditAge: number;
  /** Bloat score (0–100, 100 = no bloat) */
  bloatScore: number;
}


/**
 * The production readiness grade computed by ProductionReadinessService.
 */
export interface ProductionReadinessGrade {
  /** Overall score 0–100 (weighted average of dimensions) */
  overall: number;
  /** Per-dimension breakdown */
  dimensions: ProductionReadinessDimensions;
  /** Blockers that prevent deployment */
  blockers: string[];
  /** ISO 8601 timestamp of when the grade was computed */
  timestamp: string;
}

/**
 * Result of auditing the agent setup for security/config issues.
 */
export interface SetupAuditResult {
  /** Whether the setup passes all checks */
  passed: boolean;
  /** Issues that block deployment */
  issues: SetupAuditIssue[];
}

/**
 * A single agent setup audit issue.
 */
export interface SetupAuditIssue {
  /** Category of the issue */
  category: 'missing-skill-assignment' | 'over-broad-permissions' | 'disabled-firewall-tier';
  /** Detailed description */
  description: string;
  /** Severity: all setup audit issues are blockers */
  severity: 'blocker';
}

/**
 * A single time-series data point for trend rendering.
 */
export interface GradeTrend {
  /** Overall score at this snapshot */
  overall: number;
  /** Per-dimension scores */
  dimensions: ProductionReadinessDimensions;
  /** ISO 8601 timestamp of the snapshot */
  timestamp: string;
}

/**
 * Configuration for dimension data providers.
 * Allows dependency injection for testing and flexible integration.
 */
export interface ReadinessDimensionProviders {
  /** Returns test coverage percentage (0–100) */
  getTestCoverage: () => number;
  /** Returns E2E pass rate (0–100) */
  getE2EPassRate: () => number;
  /** Returns accessibility score (0–100) */
  getAccessibilityScore: () => number;
  /** Returns documentation freshness (0–100) */
  getDocsFreshness: () => number;
  /** Returns ADR presence score (0–100) */
  getAdrPresence: () => number;
  /** Returns days since last dependency audit */
  getDependencyAuditAgeDays: () => number;
  /** Returns bloat score (0–100, 100 = no bloat) */
  getBloatScore: () => number;
}

/**
 * Configuration for agent setup audit providers.
 */
export interface AgentSetupProviders {
  /** Returns list of agents with their assigned skill IDs */
  getAgentSkillAssignments: () => Array<{ agentId: string; skillIds: string[] }>;
  /** Returns agents with their tool permissions */
  getAgentToolPermissions: () => Array<{ agentId: string; tools: string[]; scope: string }>;
  /** Returns firewall configuration tiers and their enabled status */
  getFirewallTiers: () => Array<{ tier: string; enabled: boolean }>;
}

/**
 * Dimension weights used for overall score calculation.
 * All weights must sum to 1.0.
 */
export const DIMENSION_WEIGHTS: Record<keyof ProductionReadinessDimensions, number> = {
  testCoverage: 0.20,
  e2ePassRate: 0.15,
  accessibilityScore: 0.15,
  docsFreshness: 0.10,
  adrPresence: 0.10,
  dependencyAuditAge: 0.15,
  bloatScore: 0.15,
};

// ─── Service ────────────────────────────────────────────────────

/**
 * ProductionReadinessService — computes and tracks production readiness grades.
 *
 * Gated behind the `production_readiness` feature flag.
 *
 * Requirements:
 *   19.1 — Compute 0–100 grade with per-dimension breakdown
 *   19.2 — Seven dimensions scored
 *   19.3 — Audit agent setup for misconfigurations
 *   19.4 — Block deployment on security/config issues
 *   19.5 — Snapshot grade after session for trends
 *   19.6 — Render time-series trends
 */
export class ProductionReadinessService {
  constructor(
    private readonly db: Database.Database,
    private readonly dimensionProviders: ReadinessDimensionProviders,
    private readonly agentSetupProviders: AgentSetupProviders,
  ) {
    this.ensureTable();
  }

  /**
   * Compute the production readiness grade with per-dimension breakdown.
   *
   * Returns a grade with overall score (0–100), each dimension scored,
   * and any blockers that prevent deployment.
   *
   * Requirement 19.1, 19.2
   */
  computeGrade(): ProductionReadinessGrade {
    const dimensions = this.computeDimensions();
    const overall = this.computeOverallScore(dimensions);
    const auditResult = this.auditAgentSetup();
    const blockers = auditResult.issues.map((issue) => issue.description);

    return {
      overall,
      dimensions,
      blockers,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Audit agent setup for misconfigurations that block deployment.
   *
   * Detects:
   *   - Missing skill assignments (agents without required skills)
   *   - Over-broad tool permissions (agents with wildcard/unrestricted access)
   *   - Disabled firewall tiers (security tiers not active)
   *
   * Requirement 19.3, 19.4
   */
  auditAgentSetup(): SetupAuditResult {
    const issues: SetupAuditIssue[] = [];

    // Check for missing skill assignments
    const assignments = this.agentSetupProviders.getAgentSkillAssignments();
    for (const agent of assignments) {
      if (!agent.skillIds || agent.skillIds.length === 0) {
        issues.push({
          category: 'missing-skill-assignment',
          description: `Agent "${agent.agentId}" has no skills assigned`,
          severity: 'blocker',
        });
      }
    }

    // Check for over-broad tool permissions
    const permissions = this.agentSetupProviders.getAgentToolPermissions();
    for (const agent of permissions) {
      if (agent.scope === '*' || agent.scope === 'all') {
        issues.push({
          category: 'over-broad-permissions',
          description: `Agent "${agent.agentId}" has unrestricted tool scope "${agent.scope}"`,
          severity: 'blocker',
        });
      }
      if (agent.tools.includes('*')) {
        issues.push({
          category: 'over-broad-permissions',
          description: `Agent "${agent.agentId}" has wildcard tool permission`,
          severity: 'blocker',
        });
      }
    }

    // Check for disabled firewall tiers
    const tiers = this.agentSetupProviders.getFirewallTiers();
    for (const tier of tiers) {
      if (!tier.enabled) {
        issues.push({
          category: 'disabled-firewall-tier',
          description: `Firewall tier "${tier.tier}" is disabled`,
          severity: 'blocker',
        });
      }
    }

    return {
      passed: issues.length === 0,
      issues,
    };
  }

  /**
   * Snapshot the grade after a session for trend tracking.
   *
   * Persists the grade to the `readiness_snapshots` SQLite table.
   *
   * Requirement 19.5
   */
  snapshotGrade(grade: ProductionReadinessGrade): void {
    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO readiness_snapshots (id, overall_score, dimensions, blockers, snapshot_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      id,
      grade.overall,
      JSON.stringify(grade.dimensions),
      JSON.stringify(grade.blockers),
      grade.timestamp,
    );
  }

  /**
   * Retrieve time-series trends of readiness grades since a given date.
   *
   * Requirement 19.6
   */
  getTrends(since: Date): GradeTrend[] {
    const sinceIso = since.toISOString();
    const rows = this.db.prepare(
      'SELECT overall_score, dimensions, snapshot_at FROM readiness_snapshots WHERE snapshot_at >= ? ORDER BY snapshot_at ASC',
    ).all(sinceIso) as Array<{
      overall_score: number;
      dimensions: string;
      snapshot_at: string;
    }>;

    return rows.map((row) => ({
      overall: row.overall_score,
      dimensions: JSON.parse(row.dimensions) as ProductionReadinessDimensions,
      timestamp: row.snapshot_at,
    }));
  }

  /**
   * Check whether deployment should be blocked based on audit results.
   *
   * Returns true if there are blockers (deployment should be blocked).
   *
   * Requirement 19.4
   */
  shouldBlockDeployment(): boolean {
    const audit = this.auditAgentSetup();
    return !audit.passed;
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Compute all seven dimension scores.
   */
  private computeDimensions(): ProductionReadinessDimensions {
    const auditAgeDays = this.dimensionProviders.getDependencyAuditAgeDays();

    return {
      testCoverage: clamp(this.dimensionProviders.getTestCoverage(), 0, 100),
      e2ePassRate: clamp(this.dimensionProviders.getE2EPassRate(), 0, 100),
      accessibilityScore: clamp(this.dimensionProviders.getAccessibilityScore(), 0, 100),
      docsFreshness: clamp(this.dimensionProviders.getDocsFreshness(), 0, 100),
      adrPresence: clamp(this.dimensionProviders.getAdrPresence(), 0, 100),
      dependencyAuditAge: computeAuditAgeScore(auditAgeDays),
      bloatScore: clamp(this.dimensionProviders.getBloatScore(), 0, 100),
    };
  }

  /**
   * Compute the weighted overall score from dimensions.
   */
  private computeOverallScore(dimensions: ProductionReadinessDimensions): number {
    let total = 0;
    for (const [key, weight] of Object.entries(DIMENSION_WEIGHTS)) {
      const dimKey = key as keyof ProductionReadinessDimensions;
      total += dimensions[dimKey] * weight;
    }
    return Math.round(clamp(total, 0, 100));
  }

  /**
   * Ensure the readiness_snapshots table exists.
   */
  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS readiness_snapshots (
        id TEXT PRIMARY KEY,
        overall_score INTEGER NOT NULL,
        dimensions TEXT NOT NULL,
        blockers TEXT NOT NULL,
        snapshot_at TEXT NOT NULL
      )
    `);
  }
}

// ─── Utility Functions ──────────────────────────────────────────

/**
 * Clamp a value between min and max.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Convert days since last dependency audit into a 0–100 score.
 * - 0 days → 100 (freshly audited)
 * - 7 days → 85
 * - 30 days → 50
 * - 90+ days → 0
 */
export function computeAuditAgeScore(days: number): number {
  if (days <= 0) return 100;
  if (days >= 90) return 0;
  // Linear decay from 100 to 0 over 90 days
  return Math.round(clamp(100 - (days / 90) * 100, 0, 100));
}
