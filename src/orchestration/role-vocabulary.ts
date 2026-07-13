/**
 * Role Vocabulary — Single canonical definition of pipeline role names.
 *
 * ALL role-name references across skill-keyword triggers, PHASE_ROLE_MAP,
 * Role_Allowlists, resolveSkillsForRole, and WORKER_ROLES MUST reference
 * this module rather than maintaining their own divergent lists.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 19.2
 */

/**
 * The single canonical vocabulary of role names that the PhasedPipeline spawns.
 * Every role-name list in the codebase MUST derive from this definition.
 */
export const ROLE_VOCABULARY = ['architect', 'implementer', 'reviewer', 'tester'] as const;

/**
 * A role name from the canonical vocabulary.
 */
export type Role = typeof ROLE_VOCABULARY[number];

/**
 * Type guard: checks whether a string is an exact member of the Role_Vocabulary.
 * Used for exact-comparison matching when spawning roles (R10.2).
 */
export function isRole(value: string): value is Role {
  return (ROLE_VOCABULARY as readonly string[]).includes(value);
}

/**
 * Result of attempting to resolve skills for a role.
 * When the role is not in the vocabulary, `unmatched` is true and
 * an indication identifying the unmatched role name is surfaced (R10.5).
 */
export type RoleResolutionResult =
  | { matched: true; role: string }
  | { matched: false; role: string; unmatchedIndication: string };

/**
 * Validate a role against the vocabulary. Returns a resolution result
 * indicating whether the role is recognized, or an unmatched indication
 * identifying the unknown role name (R10.5).
 */
export function resolveRole(role: string): RoleResolutionResult {
  if (isRole(role)) {
    return { matched: true, role };
  }
  return {
    matched: false,
    role,
    unmatchedIndication: `Role "${role}" is not a member of the canonical Role_Vocabulary. Known roles: ${ROLE_VOCABULARY.join(', ')}`,
  };
}
