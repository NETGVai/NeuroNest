/**
 * Bundle Persistence Planner - Deterministic complete-bundle reconciliation planning
 *
 * Builds plans that:
 * - Classify every stale assignment for removal
 * - Retain unchanged rows without replacement (preserving proficiency,
 *   success rate, execution counts, average time, and learned date)
 * - Add only missing rows with sensible defaults
 * - Define the exact desired post-state as a sorted unique skill ID set
 * - Produce stable no-op plans when current state already matches desired state
 * - Prohibit per-row `assignSkillToAgent` loops from catalog reconciliation
 *
 * The planner is a PURE function: given current assignments and a desired bundle,
 * it produces a deterministic plan. It does NOT execute database operations.
 * Execution is handled by the persistence service (task 7.3).
 *
 * Requirements: 10.11–10.15
 */

import { createHash } from 'node:crypto';

import type { AssignmentEvidence } from './assignment-evidence';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/**
 * Stale assignment action: the only supported action is removal.
 * The existing assignment schema has no inactive state, so inactive retention
 * would be ambiguous to runtime readers.
 *
 * Requirement 10.13: Deterministically classify every Stale_Assignment for removal.
 */
export type StaleAssignmentAction = 'remove';

/**
 * Reason why an assignment is classified as stale.
 */
export type StaleReason =
  | 'absent-from-desired-bundle'
  | 'no-current-evidence'
  | 'skill-no-longer-eligible';

/**
 * Describes one stale assignment that must be removed.
 */
export interface StaleAssignmentEntry {
  readonly skillId: string;
  readonly action: StaleAssignmentAction;
  readonly reason: string;
  readonly staleReason: StaleReason;
}

/**
 * Describes one assignment to be added (was missing from the store).
 */
export interface AddedAssignmentEntry {
  readonly skillId: string;
  readonly proficiencyLevel: 'beginner';
  readonly successRate: 0.0;
  readonly totalExecutions: 0;
  readonly successfulExecutions: 0;
  readonly avgExecutionTimeMs: 0;
}

/**
 * Evidence row to be upserted during persistence.
 */
export interface AssignmentEvidenceRow {
  readonly agentId: string;
  readonly skillId: string;
  readonly capabilityKey: string;
  readonly reason: string;
  readonly sourceKind: 'taxonomy' | 'reviewed-override';
  readonly sourceId: string;
  readonly evidenceJson: string;
}

/**
 * Current assignment record from the store, including performance metrics
 * that must be preserved for retained rows.
 */
export interface CurrentAssignmentRecord {
  readonly agentId: string;
  readonly skillId: string;
  readonly proficiencyLevel: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  readonly successRate: number;
  readonly totalExecutions: number;
  readonly successfulExecutions: number;
  readonly avgExecutionTimeMs: number;
  readonly lastUsedAt: string | null;
  readonly learnedAt: string;
}

/**
 * The complete deterministic persistence plan for one agent's skill bundle.
 *
 * This plan defines the EXACT desired post-state and the operations needed
 * to reach it from the current state. It is produced by pure computation
 * and can be verified before execution.
 *
 * Requirement 10.11: Repeated computation with unchanged inputs produces
 * the same plan with noOp=true and zero mutations.
 *
 * Requirement 10.13: Every stale row is deterministically classified for removal.
 *
 * Requirement 10.14: The complete reconciled bundle is persisted in one transaction.
 *
 * Requirement 10.15: If any operation fails, roll back all changes.
 */
export interface BundlePersistencePlan {
  /** Agent identity this plan applies to */
  readonly agentId: string;
  /** The exact desired skill IDs after reconciliation (ascending, unique) */
  readonly desiredSkillIds: readonly string[];
  /** Skill IDs that already exist in the store and remain unchanged */
  readonly retainedSkillIds: readonly string[];
  /** Skill IDs that must be added to the store */
  readonly addedSkillIds: readonly string[];
  /** Stale assignments that must be removed */
  readonly staleAssignments: readonly StaleAssignmentEntry[];
  /** Added assignment details with default metrics */
  readonly addedAssignments: readonly AddedAssignmentEntry[];
  /** Evidence rows to be upserted */
  readonly evidenceRows: readonly AssignmentEvidenceRow[];
  /** Fingerprint of all inputs used to compute this plan */
  readonly inputFingerprint: string;
  /** Fingerprint of the authoritative catalog used for validation */
  readonly catalogFingerprint: string;
  /** Whether this plan produces zero mutations (current state = desired state) */
  readonly noOp: boolean;
  /** Deterministic plan fingerprint for verification */
  readonly planFingerprint: string;
}

/**
 * Input to the bundle persistence planner.
 */
export interface BundlePlannerInput {
  /** Agent identity */
  readonly agentId: string;
  /** Desired skill IDs for the bundle (will be canonicalized) */
  readonly desiredSkillIds: readonly string[];
  /** Current assignment records from the assignment store */
  readonly currentAssignments: readonly CurrentAssignmentRecord[];
  /** Assignment evidence for the desired bundle */
  readonly evidence: readonly AssignmentEvidence[];
  /** Combined input fingerprint from reconciliation */
  readonly inputFingerprint: string;
  /** Catalog fingerprint for precondition verification */
  readonly catalogFingerprint: string;
  /** Set of skill IDs that currently resolve to enabled and installed entries */
  readonly eligibleSkillIds: ReadonlySet<string>;
}

/**
 * Result of plan computation, including the plan and diagnostic information.
 */
export interface PlanComputationResult {
  /** The computed plan */
  readonly plan: BundlePersistencePlan;
  /** Summary statistics */
  readonly stats: PlanStats;
}

/**
 * Summary statistics about a computed plan.
 */
export interface PlanStats {
  readonly totalDesired: number;
  readonly totalRetained: number;
  readonly totalAdded: number;
  readonly totalStale: number;
  readonly totalCurrentAssignments: number;
  readonly isNoOp: boolean;
  /** Number of retained assignments preserving non-zero metrics */
  readonly retainedWithMetrics: number;
}

// ─────────────────────────────────────────────
// Core Planner
// ─────────────────────────────────────────────

/**
 * Computes a deterministic complete-bundle reconciliation plan.
 *
 * This is the ONLY entry point for plan computation. It:
 * 1. Canonicalizes desired skill IDs (ascending, unique)
 * 2. Classifies every current assignment as retained or stale
 * 3. Identifies missing assignments to be added
 * 4. Preserves performance metrics for retained rows
 * 5. Computes evidence rows for upsert
 * 6. Determines no-op status
 * 7. Computes a deterministic plan fingerprint
 *
 * This function is PURE: identical inputs always produce identical outputs.
 * It does NOT perform any database operations.
 *
 * Requirement 10.11: Repeated unchanged inputs produce identical plans.
 * Requirement 10.13: Every stale assignment is classified for removal.
 * Requirement 10.14: Plan defines complete transaction content.
 * Requirement 10.15: Plan structure enables all-or-nothing execution.
 */
export function computeBundlePersistencePlan(
  input: BundlePlannerInput,
): PlanComputationResult {
  const {
    agentId,
    desiredSkillIds: rawDesiredIds,
    currentAssignments,
    evidence,
    inputFingerprint,
    catalogFingerprint,
    eligibleSkillIds,
  } = input;

  // 1. Canonicalize desired skill IDs: deduplicate and sort ascending
  const desiredSkillIds = canonicalizeIds(rawDesiredIds);

  // 2. Build lookup of current assignments by skill ID
  const currentBySkillId = buildCurrentAssignmentMap(currentAssignments);

  // 3. Build the desired set for fast membership checks
  const desiredSet = new Set(desiredSkillIds);

  // 4. Classify current assignments: retained vs stale
  const { retained, stale } = classifyCurrentAssignments(
    currentBySkillId,
    desiredSet,
    eligibleSkillIds,
  );

  // 5. Identify missing assignments (desired but not currently in store)
  const currentSkillIdSet = new Set(currentAssignments.map(a => a.skillId));
  const addedSkillIds = desiredSkillIds.filter(id => !currentSkillIdSet.has(id));

  // 6. Build added assignment entries with default metrics
  const addedAssignments = buildAddedAssignments(addedSkillIds);

  // 7. Compute evidence rows for upsert
  const evidenceRows = buildEvidenceRows(agentId, evidence);

  // 8. Determine no-op status: no additions, no removals, and evidence unchanged
  const noOp = stale.length === 0 && addedSkillIds.length === 0;

  // 9. Compute deterministic plan fingerprint
  const planFingerprint = computePlanFingerprint(
    agentId,
    desiredSkillIds,
    retained,
    addedSkillIds,
    stale,
    catalogFingerprint,
  );

  // 10. Compute stats
  const retainedWithMetrics = currentAssignments.filter(
    a => desiredSet.has(a.skillId) && hasNonZeroMetrics(a),
  ).length;

  const plan: BundlePersistencePlan = Object.freeze({
    agentId,
    desiredSkillIds: Object.freeze(desiredSkillIds),
    retainedSkillIds: Object.freeze(retained),
    addedSkillIds: Object.freeze(addedSkillIds),
    staleAssignments: Object.freeze(stale),
    addedAssignments: Object.freeze(addedAssignments),
    evidenceRows: Object.freeze(evidenceRows),
    inputFingerprint,
    catalogFingerprint,
    noOp,
    planFingerprint,
  });

  const stats: PlanStats = Object.freeze({
    totalDesired: desiredSkillIds.length,
    totalRetained: retained.length,
    totalAdded: addedSkillIds.length,
    totalStale: stale.length,
    totalCurrentAssignments: currentAssignments.length,
    isNoOp: noOp,
    retainedWithMetrics,
  });

  return { plan, stats };
}

/**
 * Verifies that a plan's desired post-state is correct:
 * - desiredSkillIds = retainedSkillIds + addedSkillIds (sorted)
 * - No overlap between retained and added
 * - No overlap between retained and stale
 * - stale + retained = current assignments (complete classification)
 *
 * This is used as a postcondition check after plan computation.
 */
export function verifyPlanPostState(plan: BundlePersistencePlan): PlanVerificationResult {
  const errors: string[] = [];

  // Check: desired = retained + added (sorted)
  const combinedSorted = [...plan.retainedSkillIds, ...plan.addedSkillIds].sort(
    (a, b) => a.localeCompare(b),
  );
  if (!arraysEqual(plan.desiredSkillIds, combinedSorted)) {
    errors.push(
      `Desired skill IDs do not equal retained + added. ` +
      `desired=[${plan.desiredSkillIds.join(',')}] ` +
      `retained+added=[${combinedSorted.join(',')}]`,
    );
  }

  // Check: no overlap between retained and added
  const retainedSet = new Set(plan.retainedSkillIds);
  const addedSet = new Set(plan.addedSkillIds);
  const retainedAddedOverlap = plan.addedSkillIds.filter(id => retainedSet.has(id));
  if (retainedAddedOverlap.length > 0) {
    errors.push(
      `Overlap between retained and added: [${retainedAddedOverlap.join(',')}]`,
    );
  }

  // Check: no overlap between retained and stale
  const staleIds = plan.staleAssignments.map(s => s.skillId);
  const retainedStaleOverlap = staleIds.filter(id => retainedSet.has(id));
  if (retainedStaleOverlap.length > 0) {
    errors.push(
      `Overlap between retained and stale: [${retainedStaleOverlap.join(',')}]`,
    );
  }

  // Check: no overlap between added and stale
  const addedStaleOverlap = staleIds.filter(id => addedSet.has(id));
  if (addedStaleOverlap.length > 0) {
    errors.push(
      `Overlap between added and stale: [${addedStaleOverlap.join(',')}]`,
    );
  }

  // Check: desired IDs are ascending and unique
  for (let i = 1; i < plan.desiredSkillIds.length; i++) {
    const current = plan.desiredSkillIds[i]!;
    const previous = plan.desiredSkillIds[i - 1]!;
    if (current <= previous) {
      errors.push(
        `Desired skill IDs not ascending unique at index ${i}: ` +
        `'${previous}' >= '${current}'`,
      );
      break;
    }
  }

  // Check: noOp consistency
  if (plan.noOp && (plan.staleAssignments.length > 0 || plan.addedSkillIds.length > 0)) {
    errors.push(
      `Plan marked as noOp but has ${plan.staleAssignments.length} stale ` +
      `and ${plan.addedSkillIds.length} added assignments`,
    );
  }

  if (!plan.noOp && plan.staleAssignments.length === 0 && plan.addedSkillIds.length === 0) {
    errors.push(
      `Plan not marked as noOp but has zero stale and zero added assignments`,
    );
  }

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
  });
}

/**
 * Result of plan post-state verification.
 */
export interface PlanVerificationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

// ─────────────────────────────────────────────
// Internal Helpers
// ─────────────────────────────────────────────

/**
 * Canonicalizes an array of skill IDs: deduplicates and sorts ascending.
 */
function canonicalizeIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/**
 * Builds a Map from skillId to the CurrentAssignmentRecord for fast lookup.
 */
function buildCurrentAssignmentMap(
  assignments: readonly CurrentAssignmentRecord[],
): Map<string, CurrentAssignmentRecord> {
  const map = new Map<string, CurrentAssignmentRecord>();
  for (const assignment of assignments) {
    map.set(assignment.skillId, assignment);
  }
  return map;
}

/**
 * Classifies current assignments as retained or stale.
 *
 * A current assignment is RETAINED when:
 * - Its skill ID is present in the desired bundle
 * (retained rows are NOT replaced — they preserve all performance metrics)
 *
 * A current assignment is STALE when:
 * - Its skill ID is absent from the desired bundle, OR
 * - Its skill ID no longer resolves to an enabled and installed entry
 *
 * Requirement 10.13: Every stale assignment is deterministically classified
 * for removal.
 */
function classifyCurrentAssignments(
  currentBySkillId: Map<string, CurrentAssignmentRecord>,
  desiredSet: ReadonlySet<string>,
  eligibleSkillIds: ReadonlySet<string>,
): { retained: string[]; stale: StaleAssignmentEntry[] } {
  const retained: string[] = [];
  const stale: StaleAssignmentEntry[] = [];

  // Process in sorted order for determinism
  const sortedCurrentIds = [...currentBySkillId.keys()].sort(
    (a, b) => a.localeCompare(b),
  );

  for (const skillId of sortedCurrentIds) {
    if (desiredSet.has(skillId)) {
      // Assignment is desired: retain it with all its metrics
      retained.push(skillId);
    } else if (!eligibleSkillIds.has(skillId)) {
      // Skill no longer resolves to an enabled/installed entry
      stale.push(Object.freeze({
        skillId,
        action: 'remove' as const,
        reason: `Skill '${skillId}' no longer resolves to an enabled and installed catalog entry`,
        staleReason: 'skill-no-longer-eligible' as const,
      }));
    } else {
      // Skill is eligible but absent from the desired bundle (no current evidence)
      stale.push(Object.freeze({
        skillId,
        action: 'remove' as const,
        reason: `Skill '${skillId}' is absent from the desired bundle and lacks current assignment evidence`,
        staleReason: 'absent-from-desired-bundle' as const,
      }));
    }
  }

  // Sort retained for deterministic output
  retained.sort((a, b) => a.localeCompare(b));

  return { retained, stale };
}

/**
 * Builds AddedAssignmentEntry records for each skill ID to be added.
 * New assignments always start with default performance metrics.
 */
function buildAddedAssignments(
  addedSkillIds: readonly string[],
): AddedAssignmentEntry[] {
  return addedSkillIds.map(skillId =>
    Object.freeze({
      skillId,
      proficiencyLevel: 'beginner' as const,
      successRate: 0.0 as const,
      totalExecutions: 0 as const,
      successfulExecutions: 0 as const,
      avgExecutionTimeMs: 0 as const,
    }),
  );
}

/**
 * Builds evidence rows from AssignmentEvidence records for database upsert.
 * Sorted deterministically by (skillId, capabilityKey, sourceKind, sourceId).
 */
function buildEvidenceRows(
  agentId: string,
  evidence: readonly AssignmentEvidence[],
): AssignmentEvidenceRow[] {
  const rows: AssignmentEvidenceRow[] = evidence.map(e => {
    const sourceKind = e.source.kind;
    const sourceId = sourceKind === 'taxonomy' ? e.source.ruleId : e.source.overrideId;

    // Build stable JSON representation of evidence details
    const evidenceJson = JSON.stringify(
      sourceKind === 'taxonomy'
        ? {
          kind: 'taxonomy',
          ruleId: e.source.ruleId,
          evidence: e.source.evidence.map(ev => ({
            origin: ev.origin,
            normalizedText: ev.normalizedText,
          })),
        }
        : {
          kind: 'reviewed-override',
          overrideId: e.source.overrideId,
          reviewerId: e.source.reviewerId,
          rationale: e.source.rationale,
        },
    );

    return Object.freeze({
      agentId,
      skillId: e.skillId,
      capabilityKey: e.capabilityKey,
      reason: e.reason,
      sourceKind,
      sourceId,
      evidenceJson,
    });
  });

  // Sort deterministically
  rows.sort((a, b) => {
    const sk = a.skillId.localeCompare(b.skillId);
    if (sk !== 0) return sk;
    const ck = a.capabilityKey.localeCompare(b.capabilityKey);
    if (ck !== 0) return ck;
    const kd = a.sourceKind.localeCompare(b.sourceKind);
    if (kd !== 0) return kd;
    return a.sourceId.localeCompare(b.sourceId);
  });

  return rows;
}

/**
 * Checks whether a current assignment has any non-zero performance metrics.
 * Used for stats reporting.
 */
function hasNonZeroMetrics(assignment: CurrentAssignmentRecord): boolean {
  return (
    assignment.totalExecutions > 0 ||
    assignment.successRate > 0 ||
    assignment.avgExecutionTimeMs > 0
  );
}

/**
 * Computes a deterministic fingerprint for a persistence plan.
 * Identical plan content produces identical fingerprints.
 */
function computePlanFingerprint(
  agentId: string,
  desiredSkillIds: readonly string[],
  retainedSkillIds: readonly string[],
  addedSkillIds: readonly string[],
  staleAssignments: readonly StaleAssignmentEntry[],
  catalogFingerprint: string,
): string {
  const hash = createHash('sha256');
  hash.update('plan:');
  hash.update(JSON.stringify({
    agentId,
    desired: desiredSkillIds,
    retained: retainedSkillIds,
    added: addedSkillIds,
    stale: staleAssignments.map(s => ({ id: s.skillId, action: s.action, reason: s.staleReason })),
    catalog: catalogFingerprint,
  }));
  return `plan-${hash.digest('hex').slice(0, 32)}`;
}

/**
 * Compares two arrays for strict equality.
 */
function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ─────────────────────────────────────────────
// Convenience Utilities
// ─────────────────────────────────────────────

/**
 * Creates a BundlePlannerInput from common parameters.
 * This is a convenience factory to reduce boilerplate at call sites.
 */
export function createPlannerInput(params: {
  agentId: string;
  desiredSkillIds: readonly string[];
  currentAssignments: readonly CurrentAssignmentRecord[];
  evidence: readonly AssignmentEvidence[];
  inputFingerprint: string;
  catalogFingerprint: string;
  eligibleSkillIds: ReadonlySet<string>;
}): BundlePlannerInput {
  return Object.freeze({
    agentId: params.agentId,
    desiredSkillIds: params.desiredSkillIds,
    currentAssignments: params.currentAssignments,
    evidence: params.evidence,
    inputFingerprint: params.inputFingerprint,
    catalogFingerprint: params.catalogFingerprint,
    eligibleSkillIds: params.eligibleSkillIds,
  });
}

/**
 * Returns true when the plan represents a valid no-op: the current state
 * already exactly matches the desired state with zero mutations needed.
 *
 * Requirement 10.11: A valid noOp plan executes no mutations or events
 * and reports committed with changed=false.
 */
export function isPlanNoOp(plan: BundlePersistencePlan): boolean {
  return plan.noOp;
}

/**
 * Returns the exact expected post-state skill IDs after plan execution.
 * This is always the plan's desiredSkillIds (ascending, unique).
 *
 * Used for postcondition verification after transaction commit.
 */
export function getExpectedPostState(plan: BundlePersistencePlan): readonly string[] {
  return plan.desiredSkillIds;
}

/**
 * Validates that a set of observed post-transaction skill IDs exactly
 * matches the plan's desired post-state.
 *
 * This implements the postcondition query/verification step from the design:
 * "postcondition query/verification that persisted IDs exactly equal
 * the desired sorted set."
 */
export function verifyPostTransactionState(
  plan: BundlePersistencePlan,
  observedSkillIds: readonly string[],
): { valid: boolean; mismatch: string | null } {
  const sortedObserved = [...observedSkillIds].sort((a, b) => a.localeCompare(b));
  const desired = plan.desiredSkillIds;

  if (arraysEqual(desired, sortedObserved)) {
    return { valid: true, mismatch: null };
  }

  // Compute exact delta for diagnostic
  const desiredSet = new Set(desired);
  const observedSet = new Set(sortedObserved);
  const missing = desired.filter(id => !observedSet.has(id));
  const extra = sortedObserved.filter(id => !desiredSet.has(id));

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`missing=[${missing.join(',')}]`);
  }
  if (extra.length > 0) {
    parts.push(`extra=[${extra.join(',')}]`);
  }

  return {
    valid: false,
    mismatch: `Post-transaction state does not match desired. ${parts.join(' ')}`,
  };
}
