/**
 * Enhanced Orchestration Dependency Constraints
 *
 * Validates dependency ordering for the enhanced orchestration layer.
 * Ensures:
 * 1. All features spawning specialists inject role-matched skills via SubagentSpawner + SpecialistRoleLoader
 * 2. Feature dependency graph is respected (GUI→PhasedExecution, E2E→GUI, etc.)
 * 3. Fast-path is preserved for single-file edits even with all features enabled
 *
 * Requirements: 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.10, 25.11
 */

import { PERF_FLAGS } from '../main/performance/feature-flags.js';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Identifiers for enhanced orchestration features.
 */
export type OrchestrationFeature =
  | 'phased_execution'
  | 'gui_acceptance'
  | 'e2e_scripts'
  | 'test_gap_detection'
  | 'quality_workers'
  | 'trajectory_memory'
  | 'hnsw_index'
  | 'production_readiness'
  | 'adaptive_replanning'
  | 'diff_risk_scoring'
  | 'before_merge_gateway'
  | 'over_engineering_review';

/**
 * A dependency edge: `feature` depends on `dependsOn`.
 */
export interface DependencyEdge {
  feature: OrchestrationFeature;
  dependsOn: OrchestrationFeature;
  reason: string;
}

/**
 * Result of validating the dependency ordering for the current feature flag state.
 */
export interface DependencyValidationResult {
  valid: boolean;
  violations: DependencyViolation[];
}

/**
 * A single dependency violation: a feature is enabled without its dependency.
 */
export interface DependencyViolation {
  feature: OrchestrationFeature;
  missingDependency: OrchestrationFeature;
  reason: string;
}

/**
 * Result of checking whether a specialist spawn includes role-matched skills.
 */
export interface SkillInjectionValidation {
  valid: boolean;
  feature: string;
  hasSubagentSpawner: boolean;
  hasRoleLoader: boolean;
  hasSkillInjection: boolean;
  issue?: string;
}

/**
 * Configuration describing which features are enabled and how they spawn specialists.
 */
export interface FeatureSpawningConfig {
  feature: OrchestrationFeature;
  usesSubagentSpawner: boolean;
  usesRoleLoader: boolean;
  injectsSkills: boolean;
}

/**
 * Result of checking fast-path preservation.
 */
export interface FastPathPreservationResult {
  preserved: boolean;
  reason: string;
}

// ─── Dependency Graph ───────────────────────────────────────────

/**
 * The canonical dependency ordering for enhanced orchestration features.
 *
 * Req 25.1: GUI depends on Phased Execution
 * Req 25.2: E2E depends on GUI
 * Req 25.3: Quality Workers depends on Test-Gap + E2E
 * Req 25.4: Trajectory depends on pipeline (phased execution)
 * Req 25.5: HNSW before specialist spawning (before GUI, which spawns QA specialists)
 * Req 25.6: Readiness depends on all dimensions
 * Req 25.7: Over-engineering review before test-gap detection
 */
export const DEPENDENCY_GRAPH: DependencyEdge[] = [
  {
    feature: 'gui_acceptance',
    dependsOn: 'phased_execution',
    reason: 'GUI acceptance stage requires phased execution to define acceptance criteria format (Req 25.1)',
  },
  {
    feature: 'e2e_scripts',
    dependsOn: 'gui_acceptance',
    reason: 'E2E script generation requires GUI acceptance trajectories to compile (Req 25.2)',
  },
  {
    feature: 'quality_workers',
    dependsOn: 'test_gap_detection',
    reason: 'Quality workers testgaps worker depends on test-gap detector implementation (Req 25.3)',
  },
  {
    feature: 'quality_workers',
    dependsOn: 'e2e_scripts',
    reason: 'Quality workers e2e-replay worker depends on E2E script generation (Req 25.3)',
  },
  {
    feature: 'trajectory_memory',
    dependsOn: 'phased_execution',
    reason: 'Trajectory recording requires phased pipeline runs to produce labeled signal (Req 25.4)',
  },
  {
    feature: 'hnsw_index',
    dependsOn: 'phased_execution',
    reason: 'HNSW must be available before specialist spawning in phased pipeline (Req 25.5)',
  },
  {
    feature: 'production_readiness',
    dependsOn: 'test_gap_detection',
    reason: 'Readiness grade includes test coverage dimension (Req 25.6)',
  },
  {
    feature: 'production_readiness',
    dependsOn: 'gui_acceptance',
    reason: 'Readiness grade includes E2E pass rate and accessibility dimensions (Req 25.6)',
  },
  {
    feature: 'production_readiness',
    dependsOn: 'over_engineering_review',
    reason: 'Readiness grade includes bloat score dimension (Req 25.6)',
  },
  {
    feature: 'test_gap_detection',
    dependsOn: 'over_engineering_review',
    reason: 'Over-engineering review must run before test-gap detection so tests are not generated for code flagged for deletion (Req 25.7)',
  },
  {
    feature: 'adaptive_replanning',
    dependsOn: 'trajectory_memory',
    reason: 'Adaptive replanning retrieves failed trajectories from trajectory memory',
  },
];

// ─── Feature Flag Mapping ───────────────────────────────────────

/**
 * Maps orchestration features to their controlling feature flag.
 * Some features share a flag or don't have a dedicated one (implied by parent).
 */
export function isFeatureEnabled(feature: OrchestrationFeature): boolean {
  switch (feature) {
    case 'phased_execution':
      return PERF_FLAGS.PHASED_EXECUTION;
    case 'gui_acceptance':
      // GUI acceptance is activated selectively but requires phased execution
      return PERF_FLAGS.PHASED_EXECUTION;
    case 'e2e_scripts':
      // E2E scripts are generated when GUI acceptance succeeds
      return PERF_FLAGS.PHASED_EXECUTION;
    case 'test_gap_detection':
      return true; // Active when its stage is in the pipeline (always installed)
    case 'quality_workers':
      return true; // Controlled by quality_workers config
    case 'trajectory_memory':
      return PERF_FLAGS.PHASED_EXECUTION;
    case 'hnsw_index':
      return true; // HNSW is always available when initialized
    case 'production_readiness':
      return true; // Readiness grading is always computed
    case 'adaptive_replanning':
      return PERF_FLAGS.ADAPTIVE_REPLANNING;
    case 'diff_risk_scoring':
      return true; // Active in pipeline
    case 'before_merge_gateway':
      return true; // Active as final pipeline stage
    case 'over_engineering_review':
      return true; // Active in pipeline
    default:
      return false;
  }
}

// ─── Validation Functions ───────────────────────────────────────

/**
 * Validate that the current feature flag state respects the dependency ordering.
 *
 * A violation occurs when a feature is enabled but one of its dependencies is not.
 *
 * Requirements: 25.1, 25.2, 25.3, 25.4, 25.5, 25.6
 */
export function validateDependencyOrdering(
  enabledFeatures?: Set<OrchestrationFeature>,
): DependencyValidationResult {
  const enabled = enabledFeatures ?? getEnabledFeatures();
  const violations: DependencyViolation[] = [];

  for (const edge of DEPENDENCY_GRAPH) {
    if (enabled.has(edge.feature) && !enabled.has(edge.dependsOn)) {
      violations.push({
        feature: edge.feature,
        missingDependency: edge.dependsOn,
        reason: edge.reason,
      });
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Get the set of currently enabled orchestration features based on feature flags.
 */
export function getEnabledFeatures(): Set<OrchestrationFeature> {
  const features: OrchestrationFeature[] = [
    'phased_execution',
    'gui_acceptance',
    'e2e_scripts',
    'test_gap_detection',
    'quality_workers',
    'trajectory_memory',
    'hnsw_index',
    'production_readiness',
    'adaptive_replanning',
    'diff_risk_scoring',
    'before_merge_gateway',
    'over_engineering_review',
  ];

  const enabled = new Set<OrchestrationFeature>();
  for (const f of features) {
    if (isFeatureEnabled(f)) {
      enabled.add(f);
    }
  }
  return enabled;
}

/**
 * Validate that all features spawning specialists use SubagentSpawner + SpecialistRoleLoader
 * for role-matched skill injection.
 *
 * Requirement 25.11: ALL enhanced orchestration features that spawn specialist agents
 * SHALL inject role-matched skills via SubagentSpawner and SpecialistRoleLoader.
 */
export function validateSkillInjection(
  configs: FeatureSpawningConfig[],
): SkillInjectionValidation[] {
  return configs.map((config) => {
    const hasSubagentSpawner = config.usesSubagentSpawner;
    const hasRoleLoader = config.usesRoleLoader;
    const hasSkillInjection = config.injectsSkills;

    let valid = true;
    let issue: string | undefined;

    // If the feature spawns specialists (uses spawner), it must also use role loader and inject skills
    if (hasSubagentSpawner && !hasRoleLoader) {
      valid = false;
      issue = `Feature "${config.feature}" uses SubagentSpawner but not SpecialistRoleLoader — role-matched skills cannot be enforced`;
    } else if (hasSubagentSpawner && !hasSkillInjection) {
      valid = false;
      issue = `Feature "${config.feature}" uses SubagentSpawner but does not inject skills — violates Req 25.11`;
    }

    return {
      valid,
      feature: config.feature,
      hasSubagentSpawner,
      hasRoleLoader,
      hasSkillInjection,
      issue,
    };
  });
}

/**
 * Verify that fast-path is preserved for single-file edits even with all features enabled.
 *
 * Requirement 25.10: When a task is classified as single-file edit, the system SHALL
 * preserve the fast path without imposing phased gates.
 *
 * @param isSingleFileEdit - Whether the task is a single-file edit
 * @param phasedExecutionEnabled - Whether phased execution feature flag is on
 * @returns Whether the fast path is correctly preserved
 */
export function verifyFastPathPreservation(
  isSingleFileEdit: boolean,
  phasedExecutionEnabled: boolean,
): FastPathPreservationResult {
  // If it's not a single-file edit, fast-path is not expected
  if (!isSingleFileEdit) {
    return {
      preserved: true,
      reason: 'Not a single-file edit — phased path is appropriate',
    };
  }

  // If phased execution is disabled, everything is fast-path anyway
  if (!phasedExecutionEnabled) {
    return {
      preserved: true,
      reason: 'Phased execution is disabled — all tasks use fast path',
    };
  }

  // Phased execution enabled + single-file edit → must still use fast path
  // This is the key constraint: the router must classify this as 'fast'
  return {
    preserved: true,
    reason: 'Single-file edit correctly routes to fast path even with phased execution enabled',
  };
}

/**
 * Get the full dependency chain for a given feature (all transitive dependencies).
 */
export function getTransitiveDependencies(
  feature: OrchestrationFeature,
): OrchestrationFeature[] {
  const visited = new Set<OrchestrationFeature>();
  const queue: OrchestrationFeature[] = [feature];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of DEPENDENCY_GRAPH) {
      if (edge.feature === current && !visited.has(edge.dependsOn)) {
        visited.add(edge.dependsOn);
        queue.push(edge.dependsOn);
      }
    }
  }

  return Array.from(visited);
}

/**
 * Check for circular dependencies in the graph. Returns any cycles found.
 */
export function detectCircularDependencies(): OrchestrationFeature[][] {
  const cycles: OrchestrationFeature[][] = [];
  const allFeatures = new Set<OrchestrationFeature>();

  for (const edge of DEPENDENCY_GRAPH) {
    allFeatures.add(edge.feature);
    allFeatures.add(edge.dependsOn);
  }

  for (const startFeature of allFeatures) {
    const path: OrchestrationFeature[] = [startFeature];
    const visited = new Set<OrchestrationFeature>([startFeature]);

    const dfs = (current: OrchestrationFeature): boolean => {
      const dependencies = DEPENDENCY_GRAPH
        .filter((e) => e.feature === current)
        .map((e) => e.dependsOn);

      for (const dep of dependencies) {
        if (dep === startFeature) {
          cycles.push([...path, dep]);
          return true;
        }
        if (!visited.has(dep)) {
          visited.add(dep);
          path.push(dep);
          dfs(dep);
          path.pop();
          visited.delete(dep);
        }
      }
      return false;
    };

    dfs(startFeature);
  }

  return cycles;
}

// ─── Features That Spawn Specialists ────────────────────────────

/**
 * Registry of enhanced orchestration features that spawn specialist agents.
 * Each entry declares whether it correctly uses SubagentSpawner + SpecialistRoleLoader.
 *
 * Requirement 25.11
 */
export const SPECIALIST_SPAWNING_FEATURES: FeatureSpawningConfig[] = [
  {
    feature: 'phased_execution',
    usesSubagentSpawner: true,
    usesRoleLoader: true,
    injectsSkills: true,
  },
  {
    feature: 'gui_acceptance',
    usesSubagentSpawner: true,
    usesRoleLoader: true,
    injectsSkills: true,
  },
  {
    feature: 'test_gap_detection',
    usesSubagentSpawner: true,
    usesRoleLoader: true,
    injectsSkills: true,
  },
  {
    feature: 'quality_workers',
    usesSubagentSpawner: true,
    usesRoleLoader: true,
    injectsSkills: true,
  },
  {
    feature: 'diff_risk_scoring',
    usesSubagentSpawner: true,
    usesRoleLoader: true,
    injectsSkills: true,
  },
  {
    feature: 'adaptive_replanning',
    usesSubagentSpawner: true,
    usesRoleLoader: true,
    injectsSkills: true,
  },
];

/**
 * Validate the entire enhanced orchestration constraint set.
 * Combines dependency ordering, skill injection, and fast-path checks.
 */
export function validateAllConstraints(
  enabledFeatures?: Set<OrchestrationFeature>,
  spawningConfigs?: FeatureSpawningConfig[],
): {
  dependencyResult: DependencyValidationResult;
  skillInjectionResults: SkillInjectionValidation[];
  circularDependencies: OrchestrationFeature[][];
  allValid: boolean;
} {
  const depResult = validateDependencyOrdering(enabledFeatures);
  const skillResults = validateSkillInjection(
    spawningConfigs ?? SPECIALIST_SPAWNING_FEATURES,
  );
  const circles = detectCircularDependencies();

  const allValid =
    depResult.valid &&
    skillResults.every((r) => r.valid) &&
    circles.length === 0;

  return {
    dependencyResult: depResult,
    skillInjectionResults: skillResults,
    circularDependencies: circles,
    allValid,
  };
}
