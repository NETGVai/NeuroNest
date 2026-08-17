/**
 * UI Quality Gate
 *
 * Enforces automated quality gate checks that block publication of
 * affected Chat_Interface revisions when critical requirements are violated.
 *
 * Gate categories that block publication:
 * - Accessibility: critical keyboard, focus, role, accessible-name, or
 *   contrast violations (Requirements 46.13, 46.17)
 * - Stable Identity: Chat_Node key stability failures (Requirement 47.19)
 * - Bounded Mount: mounted node count exceeding configured budget (Req 47.13, 47.19)
 * - Durable Equivalence: coalesced rendering diverging from projection (Req 47.19)
 * - Lazy Cancellation: obsolete work not cancelled within deadline (Req 47.19)
 * - Anchor: Semantic_Anchor drift beyond tolerance (Req 47.19)
 * - Performance: configured budget failures (Requirement 47.13)
 *
 * Follows the gate infrastructure pattern from src/harness/migration/retirement/.
 *
 * Requirements: 46.13, 46.17, 47.13, 47.19
 */

import type {
  UIQualityGateKind,
  UIQualityGateResult,
  UIQualityGateConfig,
  UIQualityGateProviders,
  QualityGateEvidence,
  QualityGateViolation,
  PublicationDecision,
  AccessibilityQualityConfig,
  StableIdentityQualityConfig,
  BoundedMountQualityConfig,
  DurableEquivalenceQualityConfig,
  LazyCancellationQualityConfig,
  AnchorQualityConfig,
  PerformanceQualityConfig,
  AccessibilityQualityCheckProvider,
  StableIdentityCheckProvider,
  BoundedMountCheckProvider,
  DurableEquivalenceCheckProvider,
  LazyCancellationCheckProvider,
  AnchorCheckProvider,
  PerformanceQualityCheckProvider,
} from './quality-gate-types.js';

// ─── Default Configuration ──────────────────────────────────────

const DEFAULT_ACCESSIBILITY_CONFIG: AccessibilityQualityConfig = {
  blockOnKeyboardAccessFailure: true,
  blockOnFocusContainmentFailure: true,
  blockOnFocusRestorationFailure: true,
  blockOnSemanticRoleFailure: true,
  blockOnAccessibleNameFailure: true,
  blockOnContrastFailure: true,
};

const DEFAULT_STABLE_IDENTITY_CONFIG: StableIdentityQualityConfig = {
  blockOnIdentityLoss: true,
};

const DEFAULT_BOUNDED_MOUNT_CONFIG: BoundedMountQualityConfig = {
  blockOnMountExceeded: true,
};

const DEFAULT_DURABLE_EQUIVALENCE_CONFIG: DurableEquivalenceQualityConfig = {
  blockOnEquivalenceFailure: true,
};

const DEFAULT_LAZY_CANCELLATION_CONFIG: LazyCancellationQualityConfig = {
  blockOnCancellationDeadlineMiss: true,
};

const DEFAULT_ANCHOR_CONFIG: AnchorQualityConfig = {
  blockOnAnchorDrift: true,
  anchorToleranceDip: 2,
};

const DEFAULT_PERFORMANCE_CONFIG: PerformanceQualityConfig = {
  blockOnInitialRenderBudget: true,
  blockOnKeyedUpdateBudget: true,
  blockOnInputLatencyBudget: true,
  blockOnMemoryBudget: true,
  blockOnMountedNodeBudget: true,
};

export const DEFAULT_UI_QUALITY_GATE_CONFIG: UIQualityGateConfig = {
  accessibility: DEFAULT_ACCESSIBILITY_CONFIG,
  stableIdentity: DEFAULT_STABLE_IDENTITY_CONFIG,
  boundedMount: DEFAULT_BOUNDED_MOUNT_CONFIG,
  durableEquivalence: DEFAULT_DURABLE_EQUIVALENCE_CONFIG,
  lazyCancellation: DEFAULT_LAZY_CANCELLATION_CONFIG,
  anchor: DEFAULT_ANCHOR_CONFIG,
  performance: DEFAULT_PERFORMANCE_CONFIG,
};

// ─── Individual Gate Check Functions ────────────────────────────

/**
 * Evaluates the accessibility quality gate.
 *
 * Blocks publication when critical accessibility violations are found:
 * keyboard access, focus containment, focus restoration, semantic roles,
 * accessible names, or critical contrast (Requirements 46.13, 46.17).
 */
export function checkAccessibilityQualityGate(
  provider: AccessibilityQualityCheckProvider,
  config: AccessibilityQualityConfig = DEFAULT_ACCESSIBILITY_CONFIG
): UIQualityGateResult {
  const start = Date.now();
  const evidence: QualityGateEvidence[] = [];
  let blocksPublication = false;

  if (config.blockOnKeyboardAccessFailure) {
    const has = provider.hasKeyboardAccess();
    evidence.push({
      metric: 'keyboard_access',
      actual: has,
      expected: true,
      passes: has,
      detail: 'All interactive elements must be keyboard-accessible',
    });
    if (!has) blocksPublication = true;
  }

  if (config.blockOnFocusContainmentFailure) {
    const has = provider.hasFocusContainment();
    evidence.push({
      metric: 'focus_containment',
      actual: has,
      expected: true,
      passes: has,
      detail: 'Modal/dialog focus must be contained',
    });
    if (!has) blocksPublication = true;
  }

  if (config.blockOnFocusRestorationFailure) {
    const has = provider.hasFocusRestoration();
    evidence.push({
      metric: 'focus_restoration',
      actual: has,
      expected: true,
      passes: has,
      detail: 'Focus must restore to invoking control on surface close',
    });
    if (!has) blocksPublication = true;
  }

  if (config.blockOnSemanticRoleFailure) {
    const has = provider.hasValidSemanticRoles();
    evidence.push({
      metric: 'semantic_roles',
      actual: has,
      expected: true,
      passes: has,
      detail: 'Semantic roles must be valid and complete',
    });
    if (!has) blocksPublication = true;
  }

  if (config.blockOnAccessibleNameFailure) {
    const has = provider.hasAccessibleNames();
    evidence.push({
      metric: 'accessible_names',
      actual: has,
      expected: true,
      passes: has,
      detail: 'All interactive elements must have accessible names',
    });
    if (!has) blocksPublication = true;
  }

  if (config.blockOnContrastFailure) {
    const has = provider.hasCriticalContrast();
    evidence.push({
      metric: 'critical_contrast',
      actual: has,
      expected: true,
      passes: has,
      detail: 'Critical contrast ratios must be met',
    });
    if (!has) blocksPublication = true;
  }

  const passed = evidence.every(e => e.passes);
  const violations = provider.getViolations();
  const durationMs = Date.now() - start;

  return {
    gate: 'accessibility',
    passed,
    summary: passed
      ? `Accessibility gate PASSED: all ${evidence.length} checks satisfied`
      : `Accessibility gate FAILED: ${violations.length} violation(s) — ${evidence.filter(e => !e.passes).map(e => e.metric).join(', ')}`,
    evidence,
    violations,
    blocksPublication,
    checkedAt: new Date().toISOString(),
    durationMs,
  };
}

/**
 * Evaluates the stable identity quality gate.
 *
 * Blocks publication when Chat_Node keys lose stability during incremental
 * updates (Requirement 47.19).
 */
export function checkStableIdentityGate(
  provider: StableIdentityCheckProvider,
  config: StableIdentityQualityConfig = DEFAULT_STABLE_IDENTITY_CONFIG
): UIQualityGateResult {
  const start = Date.now();
  const evidence: QualityGateEvidence[] = [];
  let blocksPublication = false;

  const hasStable = provider.hasStableIdentity();
  evidence.push({
    metric: 'stable_node_identity',
    actual: hasStable,
    expected: true,
    passes: hasStable,
    detail: 'Chat_Node keys must remain stable across incremental updates',
  });

  if (!hasStable && config.blockOnIdentityLoss) {
    blocksPublication = true;
  }

  const losses = provider.getIdentityLosses();
  const violations: QualityGateViolation[] = losses.map(loss => ({
    gate: 'stable_identity' as UIQualityGateKind,
    severity: 'critical' as const,
    target: loss.nodeKey,
    description: `Node lost identity: ${loss.context}`,
    rule: 'stable-node-key',
  }));

  const passed = hasStable;
  const durationMs = Date.now() - start;

  return {
    gate: 'stable_identity',
    passed,
    summary: passed
      ? 'Stable identity gate PASSED: all node keys preserved'
      : `Stable identity gate FAILED: ${losses.length} node(s) lost identity`,
    evidence,
    violations,
    blocksPublication,
    checkedAt: new Date().toISOString(),
    durationMs,
  };
}

/**
 * Evaluates the bounded mount quality gate.
 *
 * Blocks publication when the mounted node count exceeds the configured
 * bound plus documented allowances (Requirements 47.13, 47.19).
 */
export function checkBoundedMountGate(
  provider: BoundedMountCheckProvider,
  config: BoundedMountQualityConfig = DEFAULT_BOUNDED_MOUNT_CONFIG
): UIQualityGateResult {
  const start = Date.now();
  const evidence: QualityGateEvidence[] = [];
  let blocksPublication = false;

  const bound = provider.getConfiguredBound();
  const allowances = provider.getConfiguredAllowances();
  const maxAllowed = bound + allowances;
  const peakMounted = provider.getPeakMountedCount();

  const withinBound = peakMounted <= maxAllowed;
  evidence.push({
    metric: 'mounted_node_count',
    actual: peakMounted,
    expected: maxAllowed,
    passes: withinBound,
    detail: `Peak mounted nodes must be <= ${bound} (bound) + ${allowances} (allowances) = ${maxAllowed}`,
  });

  if (!withinBound && config.blockOnMountExceeded) {
    blocksPublication = true;
  }

  const violations: QualityGateViolation[] = withinBound
    ? []
    : [
        {
          gate: 'bounded_mount',
          severity: 'critical',
          target: 'windowed-timeline',
          description: `Peak mounted count ${peakMounted} exceeds max allowed ${maxAllowed} (bound=${bound}, allowances=${allowances})`,
          rule: 'bounded-mount-limit',
        },
      ];

  const passed = withinBound;
  const durationMs = Date.now() - start;

  return {
    gate: 'bounded_mount',
    passed,
    summary: passed
      ? `Bounded mount gate PASSED: peak ${peakMounted} within limit ${maxAllowed}`
      : `Bounded mount gate FAILED: peak ${peakMounted} exceeds limit ${maxAllowed}`,
    evidence,
    violations,
    blocksPublication,
    checkedAt: new Date().toISOString(),
    durationMs,
  };
}

/**
 * Evaluates the durable equivalence quality gate.
 *
 * Blocks publication when coalesced rendering does not produce content
 * equivalent to the latest compatible durable projection (Requirement 47.19).
 */
export function checkDurableEquivalenceGate(
  provider: DurableEquivalenceCheckProvider,
  config: DurableEquivalenceQualityConfig = DEFAULT_DURABLE_EQUIVALENCE_CONFIG
): UIQualityGateResult {
  const start = Date.now();
  const evidence: QualityGateEvidence[] = [];
  let blocksPublication = false;

  const hasEquivalence = provider.hasDurableEquivalence();
  evidence.push({
    metric: 'durable_equivalence',
    actual: hasEquivalence,
    expected: true,
    passes: hasEquivalence,
    detail: 'Coalesced rendering must equal full projection after settlement',
  });

  if (!hasEquivalence && config.blockOnEquivalenceFailure) {
    blocksPublication = true;
  }

  const divergences = provider.getDivergences();
  const violations: QualityGateViolation[] = divergences.map(d => ({
    gate: 'durable_equivalence' as UIQualityGateKind,
    severity: 'critical' as const,
    target: d.nodeKey,
    description: `Field "${d.field}" diverged: expected "${d.expected}", got "${d.actual}"`,
    rule: 'durable-projection-equivalence',
  }));

  const passed = hasEquivalence;
  const durationMs = Date.now() - start;

  return {
    gate: 'durable_equivalence',
    passed,
    summary: passed
      ? 'Durable equivalence gate PASSED: coalesced rendering equals projection'
      : `Durable equivalence gate FAILED: ${divergences.length} divergence(s) found`,
    evidence,
    violations,
    blocksPublication,
    checkedAt: new Date().toISOString(),
    durationMs,
  };
}

/**
 * Evaluates the lazy cancellation quality gate.
 *
 * Blocks publication when obsolete lazy work is not cancelled within
 * the configured deadline (Requirement 47.19).
 */
export function checkLazyCancellationGate(
  provider: LazyCancellationCheckProvider,
  config: LazyCancellationQualityConfig = DEFAULT_LAZY_CANCELLATION_CONFIG
): UIQualityGateResult {
  const start = Date.now();
  const evidence: QualityGateEvidence[] = [];
  let blocksPublication = false;

  const deadlineMs = provider.getConfiguredDeadlineMs();
  const worstMs = provider.getWorstCancellationMs();
  const timely = provider.hasTimelyCancellation();

  evidence.push({
    metric: 'cancellation_within_deadline',
    actual: worstMs,
    expected: deadlineMs,
    passes: timely,
    detail: `Obsolete work must be cancelled within ${deadlineMs}ms; worst-case was ${worstMs}ms`,
  });

  if (!timely && config.blockOnCancellationDeadlineMiss) {
    blocksPublication = true;
  }

  const violations: QualityGateViolation[] = timely
    ? []
    : [
        {
          gate: 'lazy_cancellation',
          severity: 'critical',
          target: 'cancellable-lazy-work',
          description: `Worst cancellation latency ${worstMs}ms exceeds deadline ${deadlineMs}ms`,
          rule: 'lazy-cancellation-deadline',
        },
      ];

  const passed = timely;
  const durationMs = Date.now() - start;

  return {
    gate: 'lazy_cancellation',
    passed,
    summary: passed
      ? `Lazy cancellation gate PASSED: worst-case ${worstMs}ms within ${deadlineMs}ms deadline`
      : `Lazy cancellation gate FAILED: worst-case ${worstMs}ms exceeds ${deadlineMs}ms deadline`,
    evidence,
    violations,
    blocksPublication,
    checkedAt: new Date().toISOString(),
    durationMs,
  };
}

/**
 * Evaluates the anchor quality gate.
 *
 * Blocks publication when the Semantic_Anchor drifts beyond 2 device-
 * independent pixels after layout stabilization (Requirement 47.19).
 */
export function checkAnchorGate(
  provider: AnchorCheckProvider,
  config: AnchorQualityConfig = DEFAULT_ANCHOR_CONFIG
): UIQualityGateResult {
  const start = Date.now();
  const evidence: QualityGateEvidence[] = [];
  let blocksPublication = false;

  const tolerance = config.anchorToleranceDip;
  const preserved = provider.hasAnchorPreservation(tolerance);
  const worstDrift = provider.getWorstAnchorDriftDip();

  evidence.push({
    metric: 'anchor_drift_dip',
    actual: worstDrift,
    expected: tolerance,
    passes: preserved,
    detail: `Semantic_Anchor must stay within ${tolerance}dip after layout stabilization; worst drift was ${worstDrift}dip`,
  });

  if (!preserved && config.blockOnAnchorDrift) {
    blocksPublication = true;
  }

  const violations: QualityGateViolation[] = preserved
    ? []
    : [
        {
          gate: 'anchor',
          severity: 'critical',
          target: 'semantic-anchor',
          description: `Anchor drifted ${worstDrift}dip, exceeding ${tolerance}dip tolerance`,
          rule: 'semantic-anchor-preservation',
        },
      ];

  const passed = preserved;
  const durationMs = Date.now() - start;

  return {
    gate: 'anchor',
    passed,
    summary: passed
      ? `Anchor gate PASSED: worst drift ${worstDrift}dip within ${tolerance}dip tolerance`
      : `Anchor gate FAILED: worst drift ${worstDrift}dip exceeds ${tolerance}dip tolerance`,
    evidence,
    violations,
    blocksPublication,
    checkedAt: new Date().toISOString(),
    durationMs,
  };
}

/**
 * Evaluates the performance quality gate.
 *
 * Blocks publication when a required performance budget fails
 * (Requirement 47.13). All budgets come from Settings_Service — no
 * hard-coded product thresholds.
 */
export function checkPerformanceQualityGate(
  provider: PerformanceQualityCheckProvider,
  config: PerformanceQualityConfig = DEFAULT_PERFORMANCE_CONFIG
): UIQualityGateResult {
  const start = Date.now();
  const evidence: QualityGateEvidence[] = [];
  let blocksPublication = false;

  // Initial render
  if (config.blockOnInitialRenderBudget) {
    const budget = provider.getInitialRenderBudgetMs();
    const measured = provider.getMeasuredInitialRenderMs();
    const passes = measured <= budget;
    evidence.push({
      metric: 'initial_render_ms',
      actual: measured,
      expected: budget,
      passes,
      detail: `Initial render must be <= ${budget}ms`,
    });
    if (!passes) blocksPublication = true;
  }

  // Keyed update
  if (config.blockOnKeyedUpdateBudget) {
    const budget = provider.getKeyedUpdateBudgetMs();
    const measured = provider.getMeasuredKeyedUpdateMs();
    const passes = measured <= budget;
    evidence.push({
      metric: 'keyed_update_ms',
      actual: measured,
      expected: budget,
      passes,
      detail: `Keyed update must be <= ${budget}ms`,
    });
    if (!passes) blocksPublication = true;
  }

  // Input latency
  if (config.blockOnInputLatencyBudget) {
    const budget = provider.getInputLatencyBudgetMs();
    const measured = provider.getMeasuredInputLatencyMs();
    const passes = measured <= budget;
    evidence.push({
      metric: 'input_latency_ms',
      actual: measured,
      expected: budget,
      passes,
      detail: `Input latency must be <= ${budget}ms`,
    });
    if (!passes) blocksPublication = true;
  }

  // Memory
  if (config.blockOnMemoryBudget) {
    const budget = provider.getMemoryBudgetBytes();
    const measured = provider.getMeasuredMemoryBytes();
    const passes = measured <= budget;
    evidence.push({
      metric: 'memory_bytes',
      actual: measured,
      expected: budget,
      passes,
      detail: `Memory must be <= ${(budget / (1024 * 1024)).toFixed(1)}MB`,
    });
    if (!passes) blocksPublication = true;
  }

  // Mounted nodes
  if (config.blockOnMountedNodeBudget) {
    const budget = provider.getMountedNodeBudget();
    const measured = provider.getMeasuredMountedNodes();
    const passes = measured <= budget;
    evidence.push({
      metric: 'mounted_nodes',
      actual: measured,
      expected: budget,
      passes,
      detail: `Mounted nodes must be <= ${budget}`,
    });
    if (!passes) blocksPublication = true;
  }

  const passed = evidence.every(e => e.passes);
  const violations: QualityGateViolation[] = evidence
    .filter(e => !e.passes)
    .map(e => ({
      gate: 'performance' as UIQualityGateKind,
      severity: 'critical' as const,
      target: e.metric,
      description: `${e.metric} = ${e.actual} exceeds budget ${e.expected}`,
      rule: `performance-budget-${e.metric}`,
    }));

  const durationMs = Date.now() - start;

  return {
    gate: 'performance',
    passed,
    summary: passed
      ? `Performance gate PASSED: all ${evidence.length} budgets met`
      : `Performance gate FAILED: ${violations.length} budget(s) exceeded — ${evidence.filter(e => !e.passes).map(e => `${e.metric}=${e.actual} (max ${e.expected})`).join(', ')}`,
    evidence,
    violations,
    blocksPublication,
    checkedAt: new Date().toISOString(),
    durationMs,
  };
}

// ─── Gate Dispatcher ────────────────────────────────────────────

/**
 * Evaluate a single UI quality gate using the appropriate provider.
 */
export function evaluateUIQualityGate(
  gate: UIQualityGateKind,
  providers: UIQualityGateProviders,
  config: UIQualityGateConfig = DEFAULT_UI_QUALITY_GATE_CONFIG
): UIQualityGateResult {
  switch (gate) {
    case 'accessibility':
      return checkAccessibilityQualityGate(providers.accessibility, config.accessibility);
    case 'stable_identity':
      return checkStableIdentityGate(providers.stableIdentity, config.stableIdentity);
    case 'bounded_mount':
      return checkBoundedMountGate(providers.boundedMount, config.boundedMount);
    case 'durable_equivalence':
      return checkDurableEquivalenceGate(providers.durableEquivalence, config.durableEquivalence);
    case 'lazy_cancellation':
      return checkLazyCancellationGate(providers.lazyCancellation, config.lazyCancellation);
    case 'anchor':
      return checkAnchorGate(providers.anchor, config.anchor);
    case 'performance':
      return checkPerformanceQualityGate(providers.performance, config.performance);
  }
}

// ─── UI Quality Gate Class ──────────────────────────────────────

/**
 * All UI quality gate kinds in evaluation order.
 */
const ALL_GATES: readonly UIQualityGateKind[] = [
  'accessibility',
  'stable_identity',
  'bounded_mount',
  'durable_equivalence',
  'lazy_cancellation',
  'anchor',
  'performance',
] as const;

/**
 * UIQualityGate orchestrates evaluation of all quality gate checks
 * and produces a publication decision for a Chat_Interface revision.
 *
 * The gate blocks publication of any revision that violates critical
 * accessibility, stable-identity, bounded-mount, durable-equivalence,
 * lazy-cancellation, anchor, or configured performance requirements.
 *
 * This follows the same gate infrastructure pattern used by the
 * retirement gate (src/harness/migration/retirement/).
 */
export class UIQualityGate {
  private readonly config: UIQualityGateConfig;
  private readonly providers: UIQualityGateProviders;
  private cachedResults: Map<UIQualityGateKind, UIQualityGateResult> = new Map();

  constructor(
    providers: UIQualityGateProviders,
    config: Partial<UIQualityGateConfig> = {}
  ) {
    this.config = {
      accessibility: { ...DEFAULT_ACCESSIBILITY_CONFIG, ...config.accessibility },
      stableIdentity: { ...DEFAULT_STABLE_IDENTITY_CONFIG, ...config.stableIdentity },
      boundedMount: { ...DEFAULT_BOUNDED_MOUNT_CONFIG, ...config.boundedMount },
      durableEquivalence: { ...DEFAULT_DURABLE_EQUIVALENCE_CONFIG, ...config.durableEquivalence },
      lazyCancellation: { ...DEFAULT_LAZY_CANCELLATION_CONFIG, ...config.lazyCancellation },
      anchor: { ...DEFAULT_ANCHOR_CONFIG, ...config.anchor },
      performance: { ...DEFAULT_PERFORMANCE_CONFIG, ...config.performance },
    };
    this.providers = providers;
  }

  /**
   * Evaluate all quality gate conditions and return results.
   */
  evaluateAllGates(): Map<UIQualityGateKind, UIQualityGateResult> {
    this.cachedResults.clear();

    for (const gate of ALL_GATES) {
      const result = evaluateUIQualityGate(gate, this.providers, this.config);
      this.cachedResults.set(gate, result);
    }

    return new Map(this.cachedResults);
  }

  /**
   * Evaluate all gates and produce a publication decision.
   *
   * Publication is blocked if ANY gate has `blocksPublication: true`.
   * This is the primary API for the build/test gate integration.
   */
  evaluateForPublication(revisionId: string): PublicationDecision {
    if (this.cachedResults.size === 0) {
      this.evaluateAllGates();
    }

    const gateResults = [...this.cachedResults.values()];
    const blockingGates: UIQualityGateKind[] = gateResults
      .filter(r => r.blocksPublication)
      .map(r => r.gate);

    const allViolations = gateResults.flatMap(r => r.violations);
    const criticalViolations = allViolations.filter(v => v.severity === 'critical');

    const allowed = blockingGates.length === 0;

    return {
      allowed,
      blockReason: allowed
        ? undefined
        : `Publication blocked by ${blockingGates.length} gate(s): ${blockingGates.join(', ')}`,
      blockingGates,
      gateResults,
      totalViolations: allViolations.length,
      criticalViolations: criticalViolations.length,
      decidedAt: new Date().toISOString(),
      revisionId,
    };
  }

  /**
   * Get the cached result for a specific gate, or evaluate it fresh.
   */
  getGateResult(gate: UIQualityGateKind): UIQualityGateResult {
    const cached = this.cachedResults.get(gate);
    if (cached) return cached;

    const result = evaluateUIQualityGate(gate, this.providers, this.config);
    this.cachedResults.set(gate, result);
    return result;
  }

  /**
   * Check if a specific gate is blocking publication.
   */
  isGateBlocking(gate: UIQualityGateKind): boolean {
    const result = this.getGateResult(gate);
    return result.blocksPublication;
  }

  /**
   * Get all gates that are currently blocking publication.
   */
  getBlockingGates(): UIQualityGateKind[] {
    if (this.cachedResults.size === 0) {
      this.evaluateAllGates();
    }
    return [...this.cachedResults.values()]
      .filter(r => r.blocksPublication)
      .map(r => r.gate);
  }

  /**
   * Clear cached gate results to force re-evaluation.
   */
  clearCache(): void {
    this.cachedResults.clear();
  }
}
