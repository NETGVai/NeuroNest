/**
 * Retirement Gate
 *
 * Enforces automated gate checks that must pass before any legacy code
 * path can be removed. The gate evaluates four conditions:
 *
 * 1. **Parity** — shadow comparison between legacy and canonical paths passes
 * 2. **Accessibility** — ARIA compliance for replacement components
 * 3. **Performance** — replacement paths meet rendering budgets
 * 4. **Compatibility** — old sessions remain readable after removal
 *
 * The gate blocks removal of any legacy path whose required conditions
 * are not satisfied. This is the enforcement mechanism that ensures
 * legacy retirement is safe and evidence-based.
 *
 * Requirements: 1.1–1.6, 13.8, 35.12–35.13, 45.15, 47.13, 47.19
 */

import {
  RETIREMENT_MANIFEST,
  getEntriesByGate,
  getEntryById,
  type GateConditionKind,
  type RetirementManifestEntry,
} from './retirement-manifest.js';
import type {
  GateCheckResult,
  GateEvidence,
  RetirementGateConfig,
  ParityGateConfig,
  AccessibilityGateConfig,
  PerformanceGateConfig,
  CompatibilityGateConfig,
  ParityCheckProvider,
  AccessibilityCheckProvider,
  PerformanceCheckProvider,
  CompatibilityCheckProvider,
  PathRetirementEvaluation,
  RetirementReport,
} from './retirement-gate-types.js';

// ─── Default Configuration ──────────────────────────────────────

const DEFAULT_PARITY_CONFIG: ParityGateConfig = {
  minimumParityRatio: 1.0,
  maxUnexpectedDivergences: 0,
  minimumComparisonCount: 10,
  evaluationWindow: 50,
};

const DEFAULT_ACCESSIBILITY_CONFIG: AccessibilityGateConfig = {
  requireAccessibleNames: true,
  requireValidRoles: true,
  requireLogicalFocusOrder: true,
  requireKeyboardNavigation: true,
  requireLiveRegionAnnouncements: true,
};

const DEFAULT_PERFORMANCE_CONFIG: PerformanceGateConfig = {
  maxInitialRenderMs: 100,
  maxKeyedUpdateMs: 16,
  maxInputLatencyMs: 50,
  maxMemoryIncreaseBytes: 10 * 1024 * 1024, // 10 MB
  maxMountedNodes: 200,
};

const DEFAULT_COMPATIBILITY_CONFIG: CompatibilityGateConfig = {
  requireOldSessionReadability: true,
  requireExportIntegrity: true,
  minimumFixtureCount: 5,
  requireAllVersionsCovered: true,
};

export const DEFAULT_GATE_CONFIG: RetirementGateConfig = {
  parity: DEFAULT_PARITY_CONFIG,
  accessibility: DEFAULT_ACCESSIBILITY_CONFIG,
  performance: DEFAULT_PERFORMANCE_CONFIG,
  compatibility: DEFAULT_COMPATIBILITY_CONFIG,
};

// ─── Gate Check Implementations ─────────────────────────────────

/**
 * Evaluates the parity gate condition.
 *
 * Checks that the shadow comparison between legacy and canonical
 * projection paths produces equivalent outputs within the configured
 * thresholds.
 */
export function checkParityGate(
  provider: ParityCheckProvider,
  config: ParityGateConfig = DEFAULT_PARITY_CONFIG
): GateCheckResult {
  const start = Date.now();
  const evidence: GateEvidence[] = [];

  // Check comparison count
  const comparisonCount = provider.getComparisonCount();
  evidence.push({
    metric: 'comparison_count',
    actual: comparisonCount,
    expected: config.minimumComparisonCount,
    passes: comparisonCount >= config.minimumComparisonCount,
    detail: `At least ${config.minimumComparisonCount} comparisons required`,
  });

  // Check parity ratio
  const parityRatio = provider.getParityRatio(config.evaluationWindow);
  evidence.push({
    metric: 'parity_ratio',
    actual: parityRatio,
    expected: config.minimumParityRatio,
    passes: parityRatio >= config.minimumParityRatio,
    detail: `Parity ratio must be >= ${config.minimumParityRatio}`,
  });

  // Check unexpected divergences
  const unexpectedDivergences = provider.getUnexpectedDivergenceCount(config.evaluationWindow);
  evidence.push({
    metric: 'unexpected_divergences',
    actual: unexpectedDivergences,
    expected: config.maxUnexpectedDivergences,
    passes: unexpectedDivergences <= config.maxUnexpectedDivergences,
    detail: `At most ${config.maxUnexpectedDivergences} unexpected divergences allowed`,
  });

  const passed = evidence.every(e => e.passes);
  const durationMs = Date.now() - start;

  return {
    gate: 'parity',
    passed,
    summary: passed
      ? `Parity gate PASSED: ${parityRatio.toFixed(4)} ratio, ${unexpectedDivergences} unexpected divergences, ${comparisonCount} comparisons`
      : `Parity gate FAILED: ${evidence.filter(e => !e.passes).map(e => e.detail).join('; ')}`,
    evidence,
    checkedAt: new Date().toISOString(),
    durationMs,
  };
}

/**
 * Evaluates the accessibility gate condition.
 *
 * Checks that replacement components meet ARIA compliance requirements
 * including accessible names, valid roles, logical focus order, keyboard
 * navigation, and live region announcements.
 */
export function checkAccessibilityGate(
  provider: AccessibilityCheckProvider,
  config: AccessibilityGateConfig = DEFAULT_ACCESSIBILITY_CONFIG
): GateCheckResult {
  const start = Date.now();
  const evidence: GateEvidence[] = [];

  if (config.requireAccessibleNames) {
    const has = provider.hasAccessibleNames();
    evidence.push({
      metric: 'accessible_names',
      actual: has,
      expected: true,
      passes: has,
      detail: 'All interactive elements must have accessible names',
    });
  }

  if (config.requireValidRoles) {
    const has = provider.hasValidRoles();
    evidence.push({
      metric: 'valid_roles',
      actual: has,
      expected: true,
      passes: has,
      detail: 'ARIA roles must be valid for their context',
    });
  }

  if (config.requireLogicalFocusOrder) {
    const has = provider.hasLogicalFocusOrder();
    evidence.push({
      metric: 'logical_focus_order',
      actual: has,
      expected: true,
      passes: has,
      detail: 'Focus order must follow logical reading order',
    });
  }

  if (config.requireKeyboardNavigation) {
    const has = provider.hasKeyboardNavigation();
    evidence.push({
      metric: 'keyboard_navigation',
      actual: has,
      expected: true,
      passes: has,
      detail: 'Keyboard navigation must be fully functional',
    });
  }

  if (config.requireLiveRegionAnnouncements) {
    const has = provider.hasLiveRegionAnnouncements();
    evidence.push({
      metric: 'live_region_announcements',
      actual: has,
      expected: true,
      passes: has,
      detail: 'Live regions must announce state changes',
    });
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
    checkedAt: new Date().toISOString(),
    durationMs,
  };
}

/**
 * Evaluates the performance gate condition.
 *
 * Checks that replacement rendering paths meet configured performance
 * budgets for initial render, keyed updates, input latency, memory,
 * and mounted node count.
 */
export function checkPerformanceGate(
  provider: PerformanceCheckProvider,
  config: PerformanceGateConfig = DEFAULT_PERFORMANCE_CONFIG
): GateCheckResult {
  const start = Date.now();
  const evidence: GateEvidence[] = [];

  const initialRenderMs = provider.getInitialRenderMs();
  evidence.push({
    metric: 'initial_render_ms',
    actual: initialRenderMs,
    expected: config.maxInitialRenderMs,
    passes: initialRenderMs <= config.maxInitialRenderMs,
    detail: `Initial render must be <= ${config.maxInitialRenderMs}ms`,
  });

  const keyedUpdateMs = provider.getKeyedUpdateMs();
  evidence.push({
    metric: 'keyed_update_ms',
    actual: keyedUpdateMs,
    expected: config.maxKeyedUpdateMs,
    passes: keyedUpdateMs <= config.maxKeyedUpdateMs,
    detail: `Keyed update must be <= ${config.maxKeyedUpdateMs}ms`,
  });

  const inputLatencyMs = provider.getInputLatencyMs();
  evidence.push({
    metric: 'input_latency_ms',
    actual: inputLatencyMs,
    expected: config.maxInputLatencyMs,
    passes: inputLatencyMs <= config.maxInputLatencyMs,
    detail: `Input latency must be <= ${config.maxInputLatencyMs}ms`,
  });

  const memoryIncrease = provider.getMemoryIncreaseBytes();
  evidence.push({
    metric: 'memory_increase_bytes',
    actual: memoryIncrease,
    expected: config.maxMemoryIncreaseBytes,
    passes: memoryIncrease <= config.maxMemoryIncreaseBytes,
    detail: `Memory increase must be <= ${(config.maxMemoryIncreaseBytes / (1024 * 1024)).toFixed(1)}MB`,
  });

  const mountedNodes = provider.getMountedNodeCount();
  evidence.push({
    metric: 'mounted_node_count',
    actual: mountedNodes,
    expected: config.maxMountedNodes,
    passes: mountedNodes <= config.maxMountedNodes,
    detail: `Mounted nodes must be <= ${config.maxMountedNodes}`,
  });

  const passed = evidence.every(e => e.passes);
  const durationMs = Date.now() - start;

  return {
    gate: 'performance',
    passed,
    summary: passed
      ? `Performance gate PASSED: all ${evidence.length} metrics within budget`
      : `Performance gate FAILED: ${evidence.filter(e => !e.passes).map(e => `${e.metric}=${e.actual} (max ${e.expected})`).join(', ')}`,
    evidence,
    checkedAt: new Date().toISOString(),
    durationMs,
  };
}

/**
 * Evaluates the compatibility gate condition.
 *
 * Checks that old sessions remain readable and exportable after
 * legacy paths are removed, verifying upcasters cover all known
 * prior schema versions.
 */
export function checkCompatibilityGate(
  provider: CompatibilityCheckProvider,
  config: CompatibilityGateConfig = DEFAULT_COMPATIBILITY_CONFIG
): GateCheckResult {
  const start = Date.now();
  const evidence: GateEvidence[] = [];

  if (config.requireOldSessionReadability) {
    const readable = provider.canReadOldSessions();
    evidence.push({
      metric: 'old_session_readability',
      actual: readable,
      expected: true,
      passes: readable,
      detail: 'Old session formats must be readable',
    });
  }

  if (config.requireExportIntegrity) {
    const hasIntegrity = provider.hasExportIntegrity();
    evidence.push({
      metric: 'export_integrity',
      actual: hasIntegrity,
      expected: true,
      passes: hasIntegrity,
      detail: 'Exports from old sessions must remain valid',
    });
  }

  const fixtureCount = provider.getVerifiedFixtureCount();
  evidence.push({
    metric: 'verified_fixture_count',
    actual: fixtureCount,
    expected: config.minimumFixtureCount,
    passes: fixtureCount >= config.minimumFixtureCount,
    detail: `At least ${config.minimumFixtureCount} legacy session fixtures must be verified`,
  });

  if (config.requireAllVersionsCovered) {
    const covered = provider.hasAllVersionsCovered();
    evidence.push({
      metric: 'all_versions_covered',
      actual: covered,
      expected: true,
      passes: covered,
      detail: 'Upcasters must handle all known prior schema versions',
    });
  }

  const passed = evidence.every(e => e.passes);
  const issues = provider.getIssues();
  const durationMs = Date.now() - start;

  return {
    gate: 'compatibility',
    passed,
    summary: passed
      ? `Compatibility gate PASSED: ${fixtureCount} fixtures verified, all versions covered`
      : `Compatibility gate FAILED: ${issues.filter(i => i.blocking).length} blocking issue(s) — ${evidence.filter(e => !e.passes).map(e => e.detail).join('; ')}`,
    evidence,
    checkedAt: new Date().toISOString(),
    durationMs,
  };
}

// ─── Gate Dispatcher ────────────────────────────────────────────

/**
 * Providers bundle for all gate checks.
 */
export interface GateProviders {
  parity: ParityCheckProvider;
  accessibility: AccessibilityCheckProvider;
  performance: PerformanceCheckProvider;
  compatibility: CompatibilityCheckProvider;
}

/**
 * Evaluate a single gate condition using the appropriate provider.
 */
export function evaluateGate(
  gate: GateConditionKind,
  providers: GateProviders,
  config: RetirementGateConfig = DEFAULT_GATE_CONFIG
): GateCheckResult {
  switch (gate) {
    case 'parity':
      return checkParityGate(providers.parity, config.parity);
    case 'accessibility':
      return checkAccessibilityGate(providers.accessibility, config.accessibility);
    case 'performance':
      return checkPerformanceGate(providers.performance, config.performance);
    case 'compatibility':
      return checkCompatibilityGate(providers.compatibility, config.compatibility);
  }
}

// ─── Retirement Gate Class ──────────────────────────────────────

/**
 * RetirementGate orchestrates the evaluation of all gate conditions
 * for each legacy path entry in the manifest and produces a
 * comprehensive retirement report.
 *
 * The gate blocks removal of any legacy path whose required conditions
 * are not met, ensuring retirement is safe and evidence-based.
 */
export class RetirementGate {
  private readonly config: RetirementGateConfig;
  private readonly providers: GateProviders;
  private cachedResults: Map<GateConditionKind, GateCheckResult> = new Map();

  constructor(providers: GateProviders, config: Partial<RetirementGateConfig> = {}) {
    this.config = {
      parity: { ...DEFAULT_PARITY_CONFIG, ...config.parity },
      accessibility: { ...DEFAULT_ACCESSIBILITY_CONFIG, ...config.accessibility },
      performance: { ...DEFAULT_PERFORMANCE_CONFIG, ...config.performance },
      compatibility: { ...DEFAULT_COMPATIBILITY_CONFIG, ...config.compatibility },
    };
    this.providers = providers;
  }

  /**
   * Evaluate all gate conditions and cache results.
   * Returns the individual gate check results.
   */
  evaluateAllGates(): Map<GateConditionKind, GateCheckResult> {
    const gates: GateConditionKind[] = ['parity', 'accessibility', 'performance', 'compatibility'];
    this.cachedResults.clear();

    for (const gate of gates) {
      const result = evaluateGate(gate, this.providers, this.config);
      this.cachedResults.set(gate, result);
    }

    return new Map(this.cachedResults);
  }

  /**
   * Evaluate a single legacy path entry and determine if it is eligible
   * for retirement.
   */
  evaluateEntry(entryId: string): PathRetirementEvaluation {
    const entry = getEntryById(entryId);
    if (!entry) {
      return {
        entryId,
        eligible: false,
        gateResults: [],
        blockers: [],
        evaluatedAt: new Date().toISOString(),
      };
    }

    return this.evaluateManifestEntry(entry);
  }

  /**
   * Evaluate all manifest entries and produce a full retirement report.
   */
  evaluateAll(): RetirementReport {
    // Ensure all gates are evaluated
    if (this.cachedResults.size === 0) {
      this.evaluateAllGates();
    }

    const evaluations: PathRetirementEvaluation[] = [];
    const blockingSummary: Record<GateConditionKind, number> = {
      parity: 0,
      accessibility: 0,
      performance: 0,
      compatibility: 0,
    };

    for (const entry of RETIREMENT_MANIFEST) {
      const evaluation = this.evaluateManifestEntry(entry);
      evaluations.push(evaluation);

      for (const blocker of evaluation.blockers) {
        blockingSummary[blocker]++;
      }
    }

    const eligibleCount = evaluations.filter(e => e.eligible).length;
    const blockedCount = evaluations.filter(e => !e.eligible).length;

    return {
      anyEligible: eligibleCount > 0,
      eligibleCount,
      blockedCount,
      evaluations,
      blockingSummary,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Check if a specific legacy path is blocked from retirement.
   * Returns the list of blocking gate conditions, or empty if eligible.
   */
  getBlockersFor(entryId: string): GateConditionKind[] {
    const evaluation = this.evaluateEntry(entryId);
    return evaluation.blockers;
  }

  /**
   * Check if all entries in a specific category are eligible for retirement.
   */
  isCategoryEligible(category: string): boolean {
    const entries = RETIREMENT_MANIFEST.filter(e => e.category === category);
    return entries.length > 0 && entries.every(entry => {
      const evaluation = this.evaluateManifestEntry(entry);
      return evaluation.eligible;
    });
  }

  /**
   * Get the cached result for a specific gate, or evaluate it fresh.
   */
  getGateResult(gate: GateConditionKind): GateCheckResult {
    const cached = this.cachedResults.get(gate);
    if (cached) return cached;

    const result = evaluateGate(gate, this.providers, this.config);
    this.cachedResults.set(gate, result);
    return result;
  }

  /**
   * Clear cached gate results to force re-evaluation.
   */
  clearCache(): void {
    this.cachedResults.clear();
  }

  // ─── Private Helpers ────────────────────────────────────────────

  private evaluateManifestEntry(entry: RetirementManifestEntry): PathRetirementEvaluation {
    const gateResults: GateCheckResult[] = [];
    const blockers: GateConditionKind[] = [];

    for (const requiredGate of entry.requiredGates) {
      const result = this.getGateResult(requiredGate);
      gateResults.push(result);

      if (!result.passed) {
        blockers.push(requiredGate);
      }
    }

    return {
      entryId: entry.id,
      eligible: blockers.length === 0,
      gateResults,
      blockers,
      evaluatedAt: new Date().toISOString(),
    };
  }
}
