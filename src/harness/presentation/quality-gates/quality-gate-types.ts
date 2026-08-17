/**
 * UI Quality Gate Types
 *
 * Defines interfaces and types for the automated UI quality gate system
 * that blocks publication of affected Chat_Interface revisions when
 * critical requirements are violated.
 *
 * Gate categories:
 * - Accessibility: keyboard access, focus containment, focus restoration,
 *   semantic roles, accessible names, critical contrast (Req 46.13, 46.17)
 * - Stable Identity: Chat_Node key stability across updates (Req 47.19)
 * - Bounded Mount: mounted node count within configured budget (Req 47.13, 47.19)
 * - Durable Equivalence: coalesced rendering equals full projection (Req 47.19)
 * - Lazy Cancellation: obsolete work cancelled within deadline (Req 47.19)
 * - Anchor: Semantic_Anchor preserved within tolerance (Req 47.19)
 * - Performance: configured budget compliance (Req 47.13)
 *
 * Requirements: 46.13, 46.17, 47.13, 47.19
 */

// ─── Gate Categories ────────────────────────────────────────────

/**
 * The kinds of UI quality gate checks that block publication.
 */
export type UIQualityGateKind =
  | 'accessibility'
  | 'stable_identity'
  | 'bounded_mount'
  | 'durable_equivalence'
  | 'lazy_cancellation'
  | 'anchor'
  | 'performance';

// ─── Gate Check Evidence ────────────────────────────────────────

/**
 * A single piece of evidence from a quality gate check.
 */
export interface QualityGateEvidence {
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

// ─── Gate Check Results ─────────────────────────────────────────

/**
 * Severity of a quality gate violation.
 */
export type ViolationSeverity = 'critical' | 'serious' | 'moderate' | 'minor';

/**
 * A single quality gate violation record.
 */
export interface QualityGateViolation {
  /** The gate category that was violated */
  gate: UIQualityGateKind;
  /** Severity of the violation */
  severity: ViolationSeverity;
  /** Affected element/component/node identifier */
  target: string;
  /** Human-readable description of the violation */
  description: string;
  /** The specific check that failed */
  rule: string;
}

/**
 * Result of a single UI quality gate check.
 */
export interface UIQualityGateResult {
  /** Which gate was evaluated */
  gate: UIQualityGateKind;
  /** Whether the gate passed (no critical violations) */
  passed: boolean;
  /** Human-readable summary of the check outcome */
  summary: string;
  /** Detailed evidence supporting the result */
  evidence: QualityGateEvidence[];
  /** Violations found during the check */
  violations: QualityGateViolation[];
  /** Whether this gate failure blocks publication */
  blocksPublication: boolean;
  /** When the check was performed */
  checkedAt: string;
  /** Duration of the check in milliseconds */
  durationMs: number;
}

// ─── Gate Configuration ─────────────────────────────────────────

/**
 * Configuration for accessibility quality gate checks.
 * Corresponds to Requirement 46.13 and 46.17.
 */
export interface AccessibilityQualityConfig {
  /** Block on missing keyboard access */
  blockOnKeyboardAccessFailure: boolean;
  /** Block on focus containment failure */
  blockOnFocusContainmentFailure: boolean;
  /** Block on focus restoration failure */
  blockOnFocusRestorationFailure: boolean;
  /** Block on invalid semantic roles */
  blockOnSemanticRoleFailure: boolean;
  /** Block on missing accessible names */
  blockOnAccessibleNameFailure: boolean;
  /** Block on critical contrast failure */
  blockOnContrastFailure: boolean;
}

/**
 * Configuration for stable identity quality gate checks.
 * Corresponds to Requirement 47.19.
 */
export interface StableIdentityQualityConfig {
  /** Block if any keyed node loses identity during update */
  blockOnIdentityLoss: boolean;
}

/**
 * Configuration for bounded mount quality gate checks.
 * Corresponds to Requirements 47.13 and 47.19.
 */
export interface BoundedMountQualityConfig {
  /** Block if mounted nodes exceed configured bound + allowances */
  blockOnMountExceeded: boolean;
}

/**
 * Configuration for durable equivalence quality gate checks.
 * Corresponds to Requirement 47.19.
 */
export interface DurableEquivalenceQualityConfig {
  /** Block if coalesced rendering does not equal full projection */
  blockOnEquivalenceFailure: boolean;
}

/**
 * Configuration for lazy cancellation quality gate checks.
 * Corresponds to Requirement 47.19.
 */
export interface LazyCancellationQualityConfig {
  /** Block if obsolete work is not cancelled within deadline */
  blockOnCancellationDeadlineMiss: boolean;
}

/**
 * Configuration for anchor quality gate checks.
 * Corresponds to Requirement 47.19.
 */
export interface AnchorQualityConfig {
  /** Block if Semantic_Anchor drifts beyond tolerance after layout stabilization */
  blockOnAnchorDrift: boolean;
  /** Maximum anchor drift tolerance in device-independent pixels */
  anchorToleranceDip: number;
}

/**
 * Configuration for performance quality gate checks.
 * Corresponds to Requirement 47.13.
 */
export interface PerformanceQualityConfig {
  /** Block if initial render exceeds budget */
  blockOnInitialRenderBudget: boolean;
  /** Block if keyed update exceeds budget */
  blockOnKeyedUpdateBudget: boolean;
  /** Block if input latency exceeds budget */
  blockOnInputLatencyBudget: boolean;
  /** Block if memory exceeds budget */
  blockOnMemoryBudget: boolean;
  /** Block if mounted nodes exceed budget */
  blockOnMountedNodeBudget: boolean;
}

/**
 * Complete quality gate configuration.
 */
export interface UIQualityGateConfig {
  accessibility: AccessibilityQualityConfig;
  stableIdentity: StableIdentityQualityConfig;
  boundedMount: BoundedMountQualityConfig;
  durableEquivalence: DurableEquivalenceQualityConfig;
  lazyCancellation: LazyCancellationQualityConfig;
  anchor: AnchorQualityConfig;
  performance: PerformanceQualityConfig;
}

// ─── Check Providers ────────────────────────────────────────────

/**
 * Provider for accessibility check data.
 * Implementation pulls from automated accessibility test results.
 */
export interface AccessibilityQualityCheckProvider {
  /** Check if keyboard access is fully functional */
  hasKeyboardAccess(): boolean;
  /** Check if focus containment works for modals/dialogs */
  hasFocusContainment(): boolean;
  /** Check if focus restoration works after surface close */
  hasFocusRestoration(): boolean;
  /** Check if semantic roles are valid and complete */
  hasValidSemanticRoles(): boolean;
  /** Check if all interactive elements have accessible names */
  hasAccessibleNames(): boolean;
  /** Check if critical contrast requirements are met */
  hasCriticalContrast(): boolean;
  /** Get all violations found */
  getViolations(): QualityGateViolation[];
}

/**
 * Provider for stable identity check data.
 * Implementation verifies Chat_Node keys persist across updates.
 */
export interface StableIdentityCheckProvider {
  /** Check if keyed nodes retain identity across incremental updates */
  hasStableIdentity(): boolean;
  /** Get nodes that lost identity */
  getIdentityLosses(): Array<{ nodeKey: string; context: string }>;
}

/**
 * Provider for bounded mount check data.
 * Implementation reads from the bounded mount controller.
 */
export interface BoundedMountCheckProvider {
  /** Get the configured mount bound (from Settings_Service) */
  getConfiguredBound(): number;
  /** Get the configured allowances (overscan + focus retention) */
  getConfiguredAllowances(): number;
  /** Get the measured peak mounted node count */
  getPeakMountedCount(): number;
}

/**
 * Provider for durable equivalence check data.
 * Implementation compares coalesced rendering output with full projection.
 */
export interface DurableEquivalenceCheckProvider {
  /** Check if coalesced rendering equals full projection */
  hasDurableEquivalence(): boolean;
  /** Get divergences found between coalesced and full rendering */
  getDivergences(): Array<{ nodeKey: string; field: string; expected: string; actual: string }>;
}

/**
 * Provider for lazy cancellation check data.
 * Implementation verifies obsolete work cancellation timing.
 */
export interface LazyCancellationCheckProvider {
  /** Check if all obsolete work was cancelled within deadline */
  hasTimelyCancellation(): boolean;
  /** Get the configured cancellation deadline in ms */
  getConfiguredDeadlineMs(): number;
  /** Get the worst-case cancellation latency in ms */
  getWorstCancellationMs(): number;
}

/**
 * Provider for anchor preservation check data.
 * Implementation measures Semantic_Anchor drift after layout changes.
 */
export interface AnchorCheckProvider {
  /** Check if anchor stays within tolerance after layout stabilization */
  hasAnchorPreservation(toleranceDip: number): boolean;
  /** Get the worst-case measured anchor drift in device-independent pixels */
  getWorstAnchorDriftDip(): number;
}

/**
 * Provider for performance budget check data.
 * Implementation reads from renderer benchmark measurements.
 */
export interface PerformanceQualityCheckProvider {
  /** Get the configured initial render budget in ms */
  getInitialRenderBudgetMs(): number;
  /** Get the measured initial render time in ms */
  getMeasuredInitialRenderMs(): number;
  /** Get the configured keyed update budget in ms */
  getKeyedUpdateBudgetMs(): number;
  /** Get the measured keyed update time in ms */
  getMeasuredKeyedUpdateMs(): number;
  /** Get the configured input latency budget in ms */
  getInputLatencyBudgetMs(): number;
  /** Get the measured input latency in ms */
  getMeasuredInputLatencyMs(): number;
  /** Get the configured memory budget in bytes */
  getMemoryBudgetBytes(): number;
  /** Get the measured memory usage in bytes */
  getMeasuredMemoryBytes(): number;
  /** Get the configured mounted node budget */
  getMountedNodeBudget(): number;
  /** Get the measured mounted node count */
  getMeasuredMountedNodes(): number;
}

// ─── Gate Providers Bundle ──────────────────────────────────────

/**
 * Complete bundle of all check providers for the UI quality gate.
 */
export interface UIQualityGateProviders {
  accessibility: AccessibilityQualityCheckProvider;
  stableIdentity: StableIdentityCheckProvider;
  boundedMount: BoundedMountCheckProvider;
  durableEquivalence: DurableEquivalenceCheckProvider;
  lazyCancellation: LazyCancellationCheckProvider;
  anchor: AnchorCheckProvider;
  performance: PerformanceQualityCheckProvider;
}

// ─── Publication Decision ───────────────────────────────────────

/**
 * The publication decision from the quality gate evaluation.
 */
export interface PublicationDecision {
  /** Whether publication is allowed */
  allowed: boolean;
  /** Reason for blocking (if blocked) */
  blockReason?: string;
  /** Which gates are blocking publication */
  blockingGates: UIQualityGateKind[];
  /** Full results for all gates evaluated */
  gateResults: UIQualityGateResult[];
  /** Total violation count across all gates */
  totalViolations: number;
  /** Count of critical violations that block publication */
  criticalViolations: number;
  /** When this decision was made */
  decidedAt: string;
  /** The Chat_Interface revision being evaluated */
  revisionId: string;
}
