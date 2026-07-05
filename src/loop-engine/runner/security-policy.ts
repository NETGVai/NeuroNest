// ─── Security Policy Enforcer ───────────────────────────────────
// Enforces security policy constraints per LoopSpec scope.securityPolicy.
// Implements tightening-only semantics: standard → strict → enterprise.
//
// Requirements: 5.6, 5.7, 5.8

import type { LoopSpec, SecurityPolicy } from '../index';

// ─── Types ──────────────────────────────────────────────────────

export interface PolicyConstraints {
  maxPassesCap: number;
  requireApprovalTools: string[];
  disabledChecks: string[];
}

// ─── Policy Severity Ordering ───────────────────────────────────
// Used for tightening-only enforcement (can only go up, never down).

const POLICY_LEVEL: Record<SecurityPolicy, number> = {
  standard: 0,
  strict: 1,
  enterprise: 2,
};

// ─── Per-Policy Constraint Definitions ──────────────────────────

const POLICY_CONSTRAINTS: Record<SecurityPolicy, PolicyConstraints> = {
  standard: {
    maxPassesCap: 50,
    requireApprovalTools: [],
    disabledChecks: [],
  },
  strict: {
    maxPassesCap: 25,
    requireApprovalTools: ['shell', 'network'],
    disabledChecks: [],
  },
  enterprise: {
    maxPassesCap: 10,
    requireApprovalTools: ['shell', 'network', 'git-write'],
    disabledChecks: ['llmJudge'],
  },
};

// ─── SecurityPolicyEnforcer ─────────────────────────────────────

/**
 * Enforces security policy constraints for loop execution.
 *
 * - standard: no additional constraints (cap 50)
 * - strict: shell+network tools require approval, cap 25
 * - enterprise: shell+network+git-write require approval, llmJudge disabled, cap 10
 *
 * Tightening-only: standard(0) < strict(1) < enterprise(2)
 * Modifications can only increase severity, never decrease.
 */
export class SecurityPolicyEnforcer {
  /**
   * Returns the constraints associated with the given security policy.
   */
  getConstraints(policy: SecurityPolicy): PolicyConstraints {
    return { ...POLICY_CONSTRAINTS[policy] };
  }

  /**
   * Returns the effective maxPasses after applying the policy cap.
   * The result is the minimum of spec.stop.maxPasses and the policy's maxPassesCap.
   */
  capMaxPasses(spec: LoopSpec): number {
    const policyCap = POLICY_CONSTRAINTS[spec.scope.securityPolicy].maxPassesCap;
    return Math.min(spec.stop.maxPasses, policyCap);
  }

  /**
   * Checks if a given tool requires an approval boundary under the specified policy.
   */
  requiresApproval(policy: SecurityPolicy, toolName: string): boolean {
    const constraints = POLICY_CONSTRAINTS[policy];
    return constraints.requireApprovalTools.includes(toolName);
  }

  /**
   * Returns whether llmJudge verification checks are disabled under the given policy.
   * Enterprise policy disables llmJudge checks.
   */
  isLlmJudgeDisabled(policy: SecurityPolicy): boolean {
    const constraints = POLICY_CONSTRAINTS[policy];
    return constraints.disabledChecks.includes('llmJudge');
  }

  /**
   * Validates that a policy change only tightens (increases severity).
   * Returns true if the transition is valid (same level or tightening).
   * Returns false if the transition would loosen the policy.
   *
   * Ordering: standard(0) < strict(1) < enterprise(2)
   */
  validatePolicyTightening(currentPolicy: SecurityPolicy, newPolicy: SecurityPolicy): boolean {
    return POLICY_LEVEL[newPolicy] >= POLICY_LEVEL[currentPolicy];
  }
}
