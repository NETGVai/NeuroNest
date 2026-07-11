/**
 * Diff Risk Scorer
 *
 * Computes a deterministic risk score for each diff based on signals:
 * - Files touched count (weight: 0.15)
 * - Blast radius from dependency graph edges (weight: 0.25)
 * - Presence of security-sensitive paths (weight: 0.25)
 * - Churn history of touched files (weight: 0.15)
 * - Existing test coverage of touched code (weight: 0.20)
 *
 * Score → level mapping:
 * - Low (<0.3): lint + single Critic_Agent pass
 * - Medium (0.3–0.7): full Critic_Agent + Test-Gap Detector
 * - High (≥0.7): multi-agent review panel + mandatory summary
 *
 * Gated behind `diff_risk_scoring` feature flag.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6
 */

import type { AgentEdit, ProjectContext, DependencyGraph } from './verification-gate/types';

// ─── Types ──────────────────────────────────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high';

export interface RiskSignal {
  /** Signal name identifier */
  name: string;
  /** Weight of this signal in the final score (0.0–1.0) */
  weight: number;
  /** Normalized value of this signal (0.0–1.0) */
  value: number;
  /** Human-readable description of what was measured */
  description: string;
}

export interface DiffRiskResult {
  /** Overall risk score (0.0–1.0) */
  score: number;
  /** Categorized risk level derived from score */
  level: RiskLevel;
  /** Individual signals that contributed to the score */
  signals: RiskSignal[];
}

// ─── Feature Gate Interface ─────────────────────────────────────

export interface FeatureGateLike {
  isEnabled(feature: string): boolean;
}

// ─── Churn and Coverage Context ─────────────────────────────────

export interface ChurnData {
  /** Maps file path to number of commits touching that file */
  commitCounts: Map<string, number>;
}

export interface CoverageData {
  /** Maps file path to coverage ratio (0.0–1.0) */
  coverageRatios: Map<string, number>;
}

export interface DiffRiskContext extends ProjectContext {
  /** Optional churn history data for touched files */
  churnData?: ChurnData;
  /** Optional test coverage data for touched files */
  coverageData?: CoverageData;
}

// ─── Constants ──────────────────────────────────────────────────

/** Signal weights — must sum to 1.0 */
export const RISK_WEIGHTS = {
  filesTouched: 0.15,
  blastRadius: 0.25,
  securityPaths: 0.25,
  churnHistory: 0.15,
  testCoverage: 0.20,
} as const;

/** Security-sensitive path patterns */
const SECURITY_PATH_PATTERNS: RegExp[] = [
  /auth/i,
  /security/i,
  /credential/i,
  /secret/i,
  /token/i,
  /password/i,
  /permission/i,
  /access[_-]?control/i,
  /encryption/i,
  /crypto/i,
  /certificate/i,
  /oauth/i,
  /session/i,
  /firewall/i,
  /\.env/,
  /private[_-]?key/i,
];

/** Thresholds for risk level classification */
const LOW_THRESHOLD = 0.3;
const HIGH_THRESHOLD = 0.7;

// ─── Scorer Implementation ──────────────────────────────────────

export class DiffRiskScorer {
  private featureGate: FeatureGateLike | null;

  constructor(featureGate?: FeatureGateLike | null) {
    this.featureGate = featureGate ?? null;
  }

  /**
   * Compute a deterministic risk score for the given diff.
   * Returns null if the `diff_risk_scoring` feature flag is disabled.
   *
   * The computation is a pure function of the diff and repository state —
   * no randomness or non-deterministic I/O is involved.
   */
  score(diff: AgentEdit, context: DiffRiskContext): DiffRiskResult | null {
    // Gate behind feature flag
    if (this.featureGate && !this.featureGate.isEnabled('diff_risk_scoring')) {
      return null;
    }

    const signals: RiskSignal[] = [];

    // 1. Files touched signal
    const filesTouchedSignal = this.computeFilesTouchedSignal(diff);
    signals.push(filesTouchedSignal);

    // 2. Blast radius signal
    const blastRadiusSignal = this.computeBlastRadiusSignal(diff, context);
    signals.push(blastRadiusSignal);

    // 3. Security paths signal
    const securityPathsSignal = this.computeSecurityPathsSignal(diff);
    signals.push(securityPathsSignal);

    // 4. Churn history signal
    const churnHistorySignal = this.computeChurnHistorySignal(diff, context);
    signals.push(churnHistorySignal);

    // 5. Test coverage signal
    const testCoverageSignal = this.computeTestCoverageSignal(diff, context);
    signals.push(testCoverageSignal);

    // Compute weighted sum
    const score = signals.reduce((sum, signal) => sum + signal.weight * signal.value, 0);

    // Clamp to [0, 1]
    const clampedScore = Math.max(0, Math.min(1, score));

    // Determine risk level
    const level = this.classifyLevel(clampedScore);

    return {
      score: clampedScore,
      level,
      signals,
    };
  }

  /**
   * Classify a numeric score into a risk level.
   */
  private classifyLevel(score: number): RiskLevel {
    if (score < LOW_THRESHOLD) return 'low';
    if (score >= HIGH_THRESHOLD) return 'high';
    return 'medium';
  }

  /**
   * Signal 1: Files touched count.
   * Normalized using a logarithmic scale — more files = higher risk.
   * 1 file = ~0.0, 5 files = ~0.5, 10+ files = ~1.0
   */
  private computeFilesTouchedSignal(diff: AgentEdit): RiskSignal {
    const fileCount = diff.changes.length;

    // Normalize: log scale capped at 10 files
    // 0 files = 0, 1 file ≈ 0.0, 5 files ≈ 0.7, 10+ files = 1.0
    let value: number;
    if (fileCount <= 0) {
      value = 0;
    } else if (fileCount >= 10) {
      value = 1.0;
    } else {
      value = Math.log2(fileCount + 1) / Math.log2(11); // log2(11) ≈ 3.459
    }

    return {
      name: 'filesTouched',
      weight: RISK_WEIGHTS.filesTouched,
      value,
      description: `${fileCount} file(s) touched`,
    };
  }

  /**
   * Signal 2: Blast radius from dependency graph edges.
   * Measures how many other files depend on the touched files.
   */
  private computeBlastRadiusSignal(diff: AgentEdit, context: DiffRiskContext): RiskSignal {
    const dependencyGraph = context.dependencyGraph;

    if (!dependencyGraph) {
      return {
        name: 'blastRadius',
        weight: RISK_WEIGHTS.blastRadius,
        value: 0.5, // Unknown — assume medium risk
        description: 'No dependency graph available; assumed medium blast radius',
      };
    }

    const touchedFiles = new Set(diff.changes.map((c) => c.filePath));
    let totalDependents = 0;

    for (const filePath of touchedFiles) {
      const dependents = dependencyGraph.dependents.get(filePath);
      if (dependents) {
        // Count unique dependents not already in the touched set
        for (const dep of dependents) {
          if (!touchedFiles.has(dep)) {
            totalDependents++;
          }
        }
      }
    }

    // Normalize: 0 dependents = 0, 20+ = 1.0
    const value = Math.min(1.0, totalDependents / 20);

    return {
      name: 'blastRadius',
      weight: RISK_WEIGHTS.blastRadius,
      value,
      description: `${totalDependents} dependent file(s) affected beyond the diff`,
    };
  }

  /**
   * Signal 3: Security-sensitive paths.
   * Binary check — if ANY touched file matches a security path pattern, signal is 1.0.
   */
  private computeSecurityPathsSignal(diff: AgentEdit): RiskSignal {
    const touchedPaths = diff.changes.map((c) => c.filePath);
    const securityFiles: string[] = [];

    for (const filePath of touchedPaths) {
      for (const pattern of SECURITY_PATH_PATTERNS) {
        if (pattern.test(filePath)) {
          securityFiles.push(filePath);
          break;
        }
      }
    }

    const value = securityFiles.length > 0 ? 1.0 : 0.0;

    return {
      name: 'securityPaths',
      weight: RISK_WEIGHTS.securityPaths,
      value,
      description: securityFiles.length > 0
        ? `Security-sensitive path(s) touched: ${securityFiles.join(', ')}`
        : 'No security-sensitive paths touched',
    };
  }

  /**
   * Signal 4: Churn history of touched files.
   * High-churn files (frequently changed) are riskier.
   */
  private computeChurnHistorySignal(diff: AgentEdit, context: DiffRiskContext): RiskSignal {
    const churnData = context.churnData;

    if (!churnData || churnData.commitCounts.size === 0) {
      return {
        name: 'churnHistory',
        weight: RISK_WEIGHTS.churnHistory,
        value: 0.0, // No data — assume low churn
        description: 'No churn history available; assumed low churn',
      };
    }

    const touchedPaths = diff.changes.map((c) => c.filePath);
    let totalChurn = 0;
    let filesWithChurn = 0;

    for (const filePath of touchedPaths) {
      const commits = churnData.commitCounts.get(filePath);
      if (commits !== undefined) {
        totalChurn += commits;
        filesWithChurn++;
      }
    }

    if (filesWithChurn === 0) {
      return {
        name: 'churnHistory',
        weight: RISK_WEIGHTS.churnHistory,
        value: 0.0,
        description: 'Touched files have no churn history',
      };
    }

    // Average churn per file, normalized: 0 commits = 0, 50+ avg = 1.0
    const avgChurn = totalChurn / filesWithChurn;
    const value = Math.min(1.0, avgChurn / 50);

    return {
      name: 'churnHistory',
      weight: RISK_WEIGHTS.churnHistory,
      value,
      description: `Average ${avgChurn.toFixed(1)} commits per touched file`,
    };
  }

  /**
   * Signal 5: Test coverage of touched code.
   * Lower coverage = higher risk (inverted).
   */
  private computeTestCoverageSignal(diff: AgentEdit, context: DiffRiskContext): RiskSignal {
    const coverageData = context.coverageData;

    if (!coverageData || coverageData.coverageRatios.size === 0) {
      return {
        name: 'testCoverage',
        weight: RISK_WEIGHTS.testCoverage,
        value: 0.5, // Unknown — assume medium risk
        description: 'No coverage data available; assumed medium coverage risk',
      };
    }

    const touchedPaths = diff.changes.map((c) => c.filePath);
    let totalCoverage = 0;
    let filesWithCoverage = 0;

    for (const filePath of touchedPaths) {
      const coverage = coverageData.coverageRatios.get(filePath);
      if (coverage !== undefined) {
        totalCoverage += coverage;
        filesWithCoverage++;
      }
    }

    if (filesWithCoverage === 0) {
      return {
        name: 'testCoverage',
        weight: RISK_WEIGHTS.testCoverage,
        value: 1.0, // No coverage data for touched files = highest risk
        description: 'No test coverage data for touched files — maximum risk',
      };
    }

    // Average coverage (0–1), invert: low coverage = high risk
    const avgCoverage = totalCoverage / filesWithCoverage;
    const value = 1.0 - avgCoverage;

    return {
      name: 'testCoverage',
      weight: RISK_WEIGHTS.testCoverage,
      value,
      description: `Average test coverage: ${(avgCoverage * 100).toFixed(0)}% (risk inverted)`,
    };
  }
}
