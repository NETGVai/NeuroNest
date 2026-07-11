/**
 * Minimalism Dependency Ordering Check
 *
 * Enforces dependency ordering constraints for the Lean Minimalism Integration:
 *
 * - Requirement 10.1: Verifier reconciliation (Req 6) must be implemented and verified
 *   BEFORE the system prompt minimalism directive (Req 2) is enabled in production.
 * - Requirement 10.2: Bundled Skill (Req 1) and system prompt directive (Req 2)
 *   must be implemented before skill-aware subagent spawning (Req 5).
 * - Requirement 10.5: The minimalism enforcement system operates as a complete no-op
 *   when the `production_ux_minimalism` feature flag is disabled.
 *
 * This module is invoked during startup to validate that dependency ordering
 * constraints are satisfied before features are enabled.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.5
 */

import { getLogger } from '../utils/structured-logger';

const LOG_SOURCE = 'MinimalismDependencyCheck';

// ─── Types ─────────────────────────────────────────────────────

/**
 * Status of a dependency component.
 */
export interface ComponentStatus {
  /** Whether the component is implemented and available */
  implemented: boolean;
  /** Whether the component has been verified (tests passing) */
  verified: boolean;
  /** Optional message describing the component's state */
  message?: string;
}

/**
 * Result of a dependency ordering check.
 */
export interface DependencyCheckResult {
  /** Whether all dependency constraints are satisfied */
  satisfied: boolean;
  /** List of violations if not satisfied */
  violations: DependencyViolation[];
  /** List of successfully validated constraints */
  validated: string[];
}

/**
 * A specific dependency ordering violation.
 */
export interface DependencyViolation {
  /** Which requirement is violated */
  requirement: string;
  /** Description of the violation */
  description: string;
  /** The prerequisite that is missing or unverified */
  missingPrerequisite: string;
  /** The feature that should be disabled due to the violation */
  affectedFeature: string;
}

/**
 * Component availability registry used for dependency checks.
 */
export interface MinimalismComponentRegistry {
  /** Requirement 1: Bundled Lean Minimalism Skill */
  bundledSkill: ComponentStatus;
  /** Requirement 2: System Prompt Minimalism Directive */
  promptDirective: ComponentStatus;
  /** Requirement 5: Skill-Aware Subagent Spawning */
  skillAwareSpawning: ComponentStatus;
  /** Requirement 6: Verifier Reconciliation for Lean Comments */
  verifierReconciliation: ComponentStatus;
}

// ─── Default Registry ──────────────────────────────────────────

/**
 * Create a default component registry with all components marked as implemented.
 * In production, components are always present in the codebase; what matters
 * is whether they have been verified (tested and confirmed working).
 */
export function createDefaultRegistry(): MinimalismComponentRegistry {
  return {
    bundledSkill: { implemented: true, verified: true },
    promptDirective: { implemented: true, verified: true },
    skillAwareSpawning: { implemented: true, verified: false },
    verifierReconciliation: { implemented: true, verified: true },
  };
}

// ─── Dependency Check Logic ────────────────────────────────────

/**
 * Validate the dependency ordering constraints for the minimalism system.
 *
 * Constraints checked:
 * 1. REQ 10.1: Verifier reconciliation (Req 6) must be verified BEFORE
 *    the prompt directive (Req 2) can be enabled.
 * 2. REQ 10.2: Bundled Skill (Req 1) and prompt directive (Req 2) must
 *    be implemented BEFORE skill-aware spawning (Req 5).
 *
 * @param registry - The component status registry to validate against
 * @returns DependencyCheckResult with violations and validated constraints
 */
export function validateDependencyOrdering(
  registry: MinimalismComponentRegistry,
): DependencyCheckResult {
  const violations: DependencyViolation[] = [];
  const validated: string[] = [];

  // Constraint 1: REQ 10.1
  // Verifier reconciliation must be implemented AND verified before prompt directive is enabled
  if (registry.promptDirective.implemented && registry.promptDirective.verified) {
    if (!registry.verifierReconciliation.implemented || !registry.verifierReconciliation.verified) {
      violations.push({
        requirement: '10.1',
        description:
          'Verifier reconciliation (Requirement 6) must be implemented and verified before ' +
          'the system prompt minimalism directive (Requirement 2) is enabled in production.',
        missingPrerequisite: 'verifierReconciliation',
        affectedFeature: 'promptDirective',
      });
    } else {
      validated.push(
        'REQ 10.1: Verifier reconciliation verified before prompt directive enabled',
      );
    }
  } else {
    validated.push(
      'REQ 10.1: Prompt directive not yet enabled — constraint not applicable',
    );
  }

  // Constraint 2: REQ 10.2
  // Bundled Skill AND prompt directive must be implemented before skill-aware spawning
  if (registry.skillAwareSpawning.implemented && registry.skillAwareSpawning.verified) {
    const skillMissing = !registry.bundledSkill.implemented || !registry.bundledSkill.verified;
    const directiveMissing = !registry.promptDirective.implemented || !registry.promptDirective.verified;

    if (skillMissing) {
      violations.push({
        requirement: '10.2',
        description:
          'Bundled Skill (Requirement 1) must be implemented before ' +
          'skill-aware subagent spawning (Requirement 5) is enabled.',
        missingPrerequisite: 'bundledSkill',
        affectedFeature: 'skillAwareSpawning',
      });
    }

    if (directiveMissing) {
      violations.push({
        requirement: '10.2',
        description:
          'System prompt directive (Requirement 2) must be implemented before ' +
          'skill-aware subagent spawning (Requirement 5) is enabled.',
        missingPrerequisite: 'promptDirective',
        affectedFeature: 'skillAwareSpawning',
      });
    }

    if (!skillMissing && !directiveMissing) {
      validated.push(
        'REQ 10.2: Bundled skill and prompt directive verified before skill-aware spawning',
      );
    }
  } else {
    validated.push(
      'REQ 10.2: Skill-aware spawning not yet enabled — constraint not applicable',
    );
  }

  return {
    satisfied: violations.length === 0,
    violations,
    validated,
  };
}

/**
 * Check whether the minimalism system should operate as a no-op.
 *
 * REQ 10.5: When the `production_ux_minimalism` feature flag is disabled,
 * the entire minimalism enforcement system produces:
 * - No changes to system prompts
 * - No over-engineering review pass findings
 * - No verifier reconciliation behavior (lean comments not parsed)
 *
 * @param featureFlagEnabled - Whether production_ux_minimalism is enabled
 * @returns true if the system should be a no-op (flag disabled)
 */
export function isMinimalismNoOp(featureFlagEnabled: boolean): boolean {
  return !featureFlagEnabled;
}

/**
 * Run the full startup dependency check for the minimalism system.
 *
 * This is the main entry point called during application startup.
 * It validates dependency ordering and logs results.
 *
 * @param registry - Component status registry (defaults to production defaults)
 * @param featureFlagEnabled - Whether production_ux_minimalism is enabled
 * @returns DependencyCheckResult
 */
export function runMinimalismStartupCheck(
  registry: MinimalismComponentRegistry = createDefaultRegistry(),
  featureFlagEnabled: boolean = false,
): DependencyCheckResult {
  const logger = getLogger();

  // If the feature flag is disabled, the entire system is a no-op
  // No dependency checks needed — nothing is active
  if (isMinimalismNoOp(featureFlagEnabled)) {
    logger.info(LOG_SOURCE, 'Minimalism system disabled (feature flag off) — operating as no-op');
    return {
      satisfied: true,
      violations: [],
      validated: ['Feature flag disabled — minimalism system is a complete no-op'],
    };
  }

  // Feature flag is enabled — validate dependency ordering
  const result = validateDependencyOrdering(registry);

  if (result.satisfied) {
    logger.info(LOG_SOURCE, 'Minimalism dependency ordering validated successfully', {
      validatedCount: result.validated.length,
    });
  } else {
    logger.warn(LOG_SOURCE, 'Minimalism dependency ordering violations detected', {
      violationCount: result.violations.length,
      violations: result.violations.map(v => v.description),
    });

    // Log each violation as a warning
    for (const violation of result.violations) {
      logger.warn(LOG_SOURCE, `[${violation.requirement}] ${violation.description}`, {
        missingPrerequisite: violation.missingPrerequisite,
        affectedFeature: violation.affectedFeature,
      });
    }
  }

  return result;
}
