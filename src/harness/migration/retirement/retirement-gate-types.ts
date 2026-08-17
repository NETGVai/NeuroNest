/**
 * Retirement Gate Types
 *
 * Defines the interfaces and types used by the retirement gate system
 * to enforce automated checks before legacy code paths can be removed.
 *
 * Each gate condition (parity, accessibility, performance, compatibility)
 * has a typed check result and configurable thresholds. The gate system
 * blocks removal of any legacy path whose required conditions are not met.
 *
 * Requirements: 1.1–1.6, 13.8, 35.12–35.13, 45.15, 47.13, 47.19
 */

import type { GateConditionKind, LegacyPathCategory } from './retirement-manifest.js';

// ─── Gate Check Results ─────────────────────────────────────────

/**
 * Result of a single gate condition check.
 */
export interface GateCheckResult {
  /** Which gate condition was evaluated */
  gate: GateConditionKind;
  /** Whether the gate condition passed */
  passed: boolean;
  /** Human-readable summary of the check outcome */
  summary: string;
  /** Detailed evidence supporting the result */
  evidence: GateEvidence[];
  /** When the check was performed */
  checkedAt: string;
  /** Duration of the check in milliseconds */
  durationMs: number;
}

/**
 * A single piece of evidence supporting a gate check result.
 */
export interface GateEvidence {
  /** What was measured or observed */
  metric: string;
  /** The measured/observed value */
  actual: number | string | boolean;
  /** The threshold or expected value */
  expected: number | string | boolean;
  /** Whether this individual evidence item passes */
  passes: boolean;
  /** Optional detail about what was tested */
  detail?: string;
}

// ─── Gate Configuration ─────────────────────────────────────────

/**
 * Configuration for the retirement gate system.
 */
export interface RetirementGateConfig {
  /** Parity gate configuration */
  parity: ParityGateConfig;
  /** Accessibility gate configuration */
  accessibility: AccessibilityGateConfig;
  /** Performance gate configuration */
  performance: PerformanceGateConfig;
  /** Compatibility gate configuration */
  compatibility: CompatibilityGateConfig;
}

/**
 * Configuration for the parity gate.
 * Verifies that the shadow comparison between legacy and canonical
 * projection paths produces equivalent outputs.
 */
export interface ParityGateConfig {
  /** Minimum parity ratio (0.0–1.0) required to pass. Default: 1.0 */
  minimumParityRatio: number;
  /** Maximum allowed unexpected divergences. Default: 0 */
  maxUnexpectedDivergences: number;
  /** Minimum number of comparison records required. Default: 10 */
  minimumComparisonCount: number;
  /** Rolling window of recent comparisons to evaluate. Default: 50 */
  evaluationWindow: number;
}

/**
 * Configuration for the accessibility gate.
 * Verifies ARIA compliance and semantic structure of replacement components.
 */
export interface AccessibilityGateConfig {
  /** Whether all interactive elements must have accessible names */
  requireAccessibleNames: boolean;
  /** Whether ARIA roles must be valid for their context */
  requireValidRoles: boolean;
  /** Whether focus order must follow logical reading order */
  requireLogicalFocusOrder: boolean;
  /** Whether keyboard navigation must be fully functional */
  requireKeyboardNavigation: boolean;
  /** Whether live regions must announce state changes */
  requireLiveRegionAnnouncements: boolean;
}

/**
 * Configuration for the performance gate.
 * Verifies that the replacement paths meet rendering budget constraints.
 */
export interface PerformanceGateConfig {
  /** Maximum allowed initial render time in milliseconds */
  maxInitialRenderMs: number;
  /** Maximum allowed keyed update time in milliseconds */
  maxKeyedUpdateMs: number;
  /** Maximum allowed input latency in milliseconds */
  maxInputLatencyMs: number;
  /** Maximum allowed memory increase in bytes over baseline */
  maxMemoryIncreaseBytes: number;
  /** Maximum mounted node count within budget */
  maxMountedNodes: number;
}

/**
 * Configuration for the compatibility gate.
 * Verifies that old sessions remain readable and exportable
 * after legacy paths are removed.
 */
export interface CompatibilityGateConfig {
  /** Whether old session formats must be readable */
  requireOldSessionReadability: boolean;
  /** Whether exports from old sessions must remain valid */
  requireExportIntegrity: boolean;
  /** Minimum number of legacy session fixtures to verify */
  minimumFixtureCount: number;
  /** Whether upcasters must handle all known prior schema versions */
  requireAllVersionsCovered: boolean;
}

// ─── Retirement Evaluation ──────────────────────────────────────

/**
 * The evaluation result for a single legacy path entry.
 */
export interface PathRetirementEvaluation {
  /** The legacy path entry ID */
  entryId: string;
  /** Whether all required gates pass for this entry */
  eligible: boolean;
  /** Results for each required gate */
  gateResults: GateCheckResult[];
  /** Which gates blocked retirement (if any) */
  blockers: GateConditionKind[];
  /** When this evaluation was performed */
  evaluatedAt: string;
}

/**
 * The full retirement evaluation report across all manifest entries.
 */
export interface RetirementReport {
  /** Overall: can any legacy paths be retired? */
  anyEligible: boolean;
  /** Count of entries eligible for retirement */
  eligibleCount: number;
  /** Count of entries blocked from retirement */
  blockedCount: number;
  /** Per-entry evaluation results */
  evaluations: PathRetirementEvaluation[];
  /** Summary of blocking gate conditions across all entries */
  blockingSummary: Record<GateConditionKind, number>;
  /** When this report was generated */
  generatedAt: string;
}

// ─── Gate Check Providers ───────────────────────────────────────

/**
 * Interface for providing parity check data to the gate.
 * Implementations pull from ParityDiagnostics or ShadowProjectionRunner.
 */
export interface ParityCheckProvider {
  /** Get the parity ratio from recent comparisons */
  getParityRatio(window: number): number;
  /** Get the count of unexpected divergences in the evaluation window */
  getUnexpectedDivergenceCount(window: number): number;
  /** Get the total number of comparison records available */
  getComparisonCount(): number;
}

/**
 * Interface for providing accessibility check data to the gate.
 * Implementations scan replacement components for ARIA compliance.
 */
export interface AccessibilityCheckProvider {
  /** Check if all interactive elements have accessible names */
  hasAccessibleNames(): boolean;
  /** Check if ARIA roles are valid */
  hasValidRoles(): boolean;
  /** Check if focus order is logical */
  hasLogicalFocusOrder(): boolean;
  /** Check if keyboard navigation is complete */
  hasKeyboardNavigation(): boolean;
  /** Check if live regions announce changes */
  hasLiveRegionAnnouncements(): boolean;
  /** Get the list of violations found */
  getViolations(): AccessibilityViolation[];
}

/**
 * A single accessibility violation.
 */
export interface AccessibilityViolation {
  /** Which rule was violated */
  rule: string;
  /** Severity level */
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  /** Affected element or component */
  target: string;
  /** Description of the violation */
  description: string;
}

/**
 * Interface for providing performance check data to the gate.
 * Implementations pull from renderer benchmark fixtures.
 */
export interface PerformanceCheckProvider {
  /** Get the measured initial render time in milliseconds */
  getInitialRenderMs(): number;
  /** Get the measured keyed update time in milliseconds */
  getKeyedUpdateMs(): number;
  /** Get the measured input latency in milliseconds */
  getInputLatencyMs(): number;
  /** Get the measured memory increase in bytes */
  getMemoryIncreaseBytes(): number;
  /** Get the current mounted node count */
  getMountedNodeCount(): number;
}

/**
 * Interface for providing compatibility check data to the gate.
 * Implementations verify old sessions and exports through upcasters.
 */
export interface CompatibilityCheckProvider {
  /** Check if old sessions are readable */
  canReadOldSessions(): boolean;
  /** Check if exports from old sessions are valid */
  hasExportIntegrity(): boolean;
  /** Get the number of legacy fixtures verified */
  getVerifiedFixtureCount(): number;
  /** Check if all prior schema versions have upcasters */
  hasAllVersionsCovered(): boolean;
  /** Get the list of compatibility issues found */
  getIssues(): CompatibilityIssue[];
}

/**
 * A single compatibility issue.
 */
export interface CompatibilityIssue {
  /** Which legacy format was affected */
  format: string;
  /** Schema version that failed */
  version: number;
  /** Description of the issue */
  description: string;
  /** Whether the issue is blocking */
  blocking: boolean;
}
