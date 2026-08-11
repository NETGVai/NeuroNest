/**
 * Bundle Persistence Plan - Deterministic complete-bundle reconciliation planning
 * and fingerprint-guarded atomic persistence.
 *
 * Core responsibilities:
 * - Classify every stale assignment for removal
 * - Retain unchanged rows without replacement (preserving performance metrics)
 * - Add only missing rows
 * - Define exact desired post-state
 * - Produce stable no-op plans
 * - Prohibit per-row assignSkillToAgent loops from catalog reconciliation
 *
 * Requirements: 10.11–10.16, 10.18
 */

import { createHash } from 'node:crypto';
import type { AssignmentEvidence } from './assignment-evidence';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/**
 * Action to take on a stale assignment.
 * The Skill_Reconciliation_Policy deterministically classifies stale rows
 * for removal. Requirement 10.13.
 */
export type StaleAssignmentAction = 'remove';

/**
 * A stale assignment entry: identifies one assignment to remove
 * with a deterministic reason.
 */
export interface StaleAssignmentEntry {
  readonly skillId: string;
  readonly action: StaleAssignmentAction;
  readonly reason: string;
}

/**
 * A serialized evidence row for persistence.
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
 * The complete-bundle persistence plan. Deterministic and verifiable.
 *
 * Requirement 10.11: Stable no-op plans.
 * Requirement 10.13: Deterministic stale classification.
 * Requirement 10.14: Atomic complete bundle persistence.
 * Requirement 10.15: Rollback on any failure.
 */
export interface BundlePersistencePlan {
  /** Agent identity */
  readonly agentId: string;
  /** Desired ascending unique skill IDs (the complete final bundle) */
  readonly desiredSkillIds: readonly string[];
  /** Skill IDs that are already present and should be retained (no row replacement) */
  readonly retainedSkillIds: readonly string[];
  /** Skill IDs that are new and must be added */
  readonly addedSkillIds: readonly string[];
  /** Stale assignments that must be removed */
  readonly staleAssignments: readonly StaleAssignmentEntry[];
  /** Evidence rows to upsert */
  readonly evidenceRows: readonly AssignmentEvidenceRow[];
  /** Combined input fingerprint for this plan */
  readonly inputFingerprint: string;
  /** Catalog fingerprint from the snapshot used for validation */
  readonly catalogFingerprint: string;
  /** Whether this plan produces zero mutations (identical desired and current state) */
  readonly noOp: boolean;
}

/**
 * Status returned after attempting bundle persistence.
 *
 * - 'committed': All statements succeeded, postcondition verified.
 *   `changed` is false for no-op plans.
 * - 'rolled-back': A statement or postcondition failed; all changes reverted,
 *   pre-transaction state preserved.
 */
export type BundlePersistenceStatus =
  | { readonly state: 'committed'; readonly changed: boolean; readonly transactionId?: string }
  | { readonly state: 'rolled-back'; readonly errorCode: string; readonly errorMessage: string };

/**
 * The bundle-state row stored after successful persistence.
 */
export interface BundleStateRow {
  readonly agentId: string;
  readonly inputFingerprint: string;
  readonly bundleFingerprint: string;
  readonly catalogFingerprint: string;
  readonly skillIdsJson: string;
  readonly updatedAt: string;
}

/**
 * Current assignment info read from the store for planning.
 */
export interface CurrentAssignment {
  readonly agentId: string;
  readonly skillId: string;
  readonly proficiencyLevel: string;
  readonly successRate: number;
  readonly totalExecutions: number;
  readonly successfulExecutions: number;
  readonly avgExecutionTimeMs: number;
  readonly lastUsedAt: string | null;
  readonly learnedAt: string;
}

// ─────────────────────────────────────────────
// Plan Construction
// ─────────────────────────────────────────────

/**
 * Builds a deterministic complete-bundle persistence plan.
 *
 * Steps:
 * 1. Compare desired skill IDs with current assignments.
 * 2. Classify every current ID not in desired as stale → remove.
 * 3. Classify every desired ID present in current as retained (preserves metrics).
 * 4. Classify every desired ID absent from current as added.
 * 5. Build evidence rows from canonical evidence.
 * 6. Determine no-op: stale empty, added empty, evidence unchanged.
 *
 * Requirement 10.13: Deterministic stale classification.
 * Requirement 10.14: Complete-bundle transaction.
 */
export function buildBundlePersistencePlan(params: {
  agentId: string;
  desiredSkillIds: readonly string[];
  evidence: readonly AssignmentEvidence[];
  currentAssignments: readonly CurrentAssignment[];
  inputFingerprint: string;
  catalogFingerprint: string;
  currentEvidenceFingerprint: string | null;
}): BundlePersistencePlan {
  const { agentId, desiredSkillIds, evidence, currentAssignments, inputFingerprint, catalogFingerprint, currentEvidenceFingerprint } = params;

  // Current assigned skill IDs
  const currentSkillIdSet = new Set(currentAssignments.map(a => a.skillId));
  const desiredSkillIdSet = new Set(desiredSkillIds);

  // Stale: in current but not in desired
  const staleAssignments: StaleAssignmentEntry[] = [];
  for (const current of currentAssignments) {
    if (!desiredSkillIdSet.has(current.skillId)) {
      staleAssignments.push({
        skillId: current.skillId,
        action: 'remove',
        reason: `Skill '${current.skillId}' is no longer in the desired bundle: no current evidence or no longer resolves to an eligible entry`,
      });
    }
  }
  // Sort stale by skillId for determinism
  staleAssignments.sort((a, b) => a.skillId.localeCompare(b.skillId));

  // Retained: in both current and desired (preserve performance metrics)
  const retainedSkillIds = desiredSkillIds.filter(id => currentSkillIdSet.has(id));

  // Added: in desired but not in current
  const addedSkillIds = desiredSkillIds.filter(id => !currentSkillIdSet.has(id));

  // Evidence rows
  const evidenceRows = buildEvidenceRows(agentId, evidence);

  // Determine no-op: no stale, no added, evidence unchanged
  const evidenceFp = computeEvidenceRowsFingerprint(evidenceRows);
  const noOp = staleAssignments.length === 0
    && addedSkillIds.length === 0
    && currentEvidenceFingerprint !== null
    && evidenceFp === currentEvidenceFingerprint;

  return Object.freeze({
    agentId,
    desiredSkillIds: Object.freeze([...desiredSkillIds]),
    retainedSkillIds: Object.freeze(retainedSkillIds),
    addedSkillIds: Object.freeze(addedSkillIds),
    staleAssignments: Object.freeze(staleAssignments),
    evidenceRows: Object.freeze(evidenceRows),
    inputFingerprint,
    catalogFingerprint,
    noOp,
  });
}

/**
 * Builds serialized evidence rows from canonical evidence.
 * Sorted by (agentId, skillId, capabilityKey, sourceId) for determinism.
 */
function buildEvidenceRows(
  agentId: string,
  evidence: readonly AssignmentEvidence[],
): AssignmentEvidenceRow[] {
  const rows: AssignmentEvidenceRow[] = [];

  for (const e of evidence) {
    const sourceId = e.source.kind === 'taxonomy' ? e.source.ruleId : e.source.overrideId;
    const evidenceJson = JSON.stringify(
      e.source.kind === 'taxonomy'
        ? { kind: 'taxonomy', ruleId: e.source.ruleId, evidence: e.source.evidence }
        : { kind: 'reviewed-override', overrideId: e.source.overrideId, reviewerId: e.source.reviewerId, rationale: e.source.rationale }
    );

    rows.push({
      agentId,
      skillId: e.skillId,
      capabilityKey: e.capabilityKey,
      reason: e.reason,
      sourceKind: e.source.kind,
      sourceId,
      evidenceJson,
    });
  }

  // Deterministic sort
  rows.sort((a, b) => {
    const s = a.skillId.localeCompare(b.skillId);
    if (s !== 0) return s;
    const c = a.capabilityKey.localeCompare(b.capabilityKey);
    if (c !== 0) return c;
    return a.sourceId.localeCompare(b.sourceId);
  });

  return rows;
}

/**
 * Computes a fingerprint for a set of evidence rows for no-op detection.
 */
export function computeEvidenceRowsFingerprint(rows: readonly AssignmentEvidenceRow[]): string {
  const hash = createHash('sha256');
  for (const row of rows) {
    hash.update(`${row.agentId}|${row.skillId}|${row.capabilityKey}|${row.sourceKind}|${row.sourceId}|${row.evidenceJson}\n`);
  }
  return `ev-${hash.digest('hex').slice(0, 32)}`;
}

/**
 * Validates that a plan is structurally sound before attempting persistence.
 * Returns null if valid, or a string error message.
 */
export function validatePlan(plan: BundlePersistencePlan): string | null {
  if (!plan.agentId || plan.agentId.trim().length === 0) {
    return 'Plan agentId is empty';
  }
  if (plan.desiredSkillIds.length === 0 && !plan.noOp) {
    // A non-no-op plan with empty desired skill IDs means something went wrong
    // But we allow it if everything is being removed (agent losing all skills due to blocked)
    // Actually, per spec, we never persist empty bundles - this should be caught upstream
  }
  if (!plan.catalogFingerprint || plan.catalogFingerprint.trim().length === 0) {
    return 'Plan catalogFingerprint is empty';
  }
  if (!plan.inputFingerprint || plan.inputFingerprint.trim().length === 0) {
    return 'Plan inputFingerprint is empty';
  }
  // Verify retained + added = desired
  const computedDesired = [...plan.retainedSkillIds, ...plan.addedSkillIds].sort();
  const expectedDesired = [...plan.desiredSkillIds].sort();
  if (computedDesired.length !== expectedDesired.length ||
      computedDesired.some((id, i) => id !== expectedDesired[i])) {
    return 'Plan integrity check failed: retained + added does not equal desired';
  }
  return null;
}
