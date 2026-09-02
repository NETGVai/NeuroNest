/**
 * Compatibility Release Authority — P8 RETIREMENT EXIT GATE
 * (FUT-PKG-09-RETIREMENT/T-007).
 *
 * This module is the FAIL-CLOSED aggregator that decides whether P8
 * (adapter/writer/alias/stub/orphan retirement) has cleared and P9 may be
 * admitted. It is the P8 EXIT GATE and it BLOCKS P9 on ANY finding. Like every
 * other retirement authority in this package it DELETES NOTHING and OWNS NO
 * durable business state: it is a pure OBSERVER that AGGREGATES the verdicts the
 * six P8 leaves already computed plus the removal-evidence graph, and renders a
 * single exit verdict. It creates NO parallel truth — it never re-derives a
 * leaf's clearance, it only consumes each leaf's own reported verdict and the
 * rehearsal matrix, and it verifies the removal evidence exists in the observer
 * Evidence/Observability graph.
 *
 * It BUILDS ON the established P8 authorities (never re-implements them):
 *
 *   - 8.1 RetirementInventory (src/retirement/retirement-inventory.ts
 *     `evaluateRetirementItem` / `reviewRetirementInventory` /
 *     `bulkDeletionAuthorized`): the itemized zero-use/deletion-prerequisite
 *     gate. This gate consumes the inventory review's per-item clearance.
 *   - 8.2 IPC/adapter retirement (ipc-adapter-retirement.ts).
 *   - 8.3 event/renderer writer retirement (event-renderer-writer-retirement.ts).
 *   - 8.4 root/secret/checkpoint/skill retirement
 *     (root-secret-checkpoint-skill-retirement.ts).
 *   - 8.5 static-catalog retirement (static-catalog-retirement.ts).
 *   - 8.6 platform/webview/adapter retirement (platform-retirement-gate.ts).
 *   - the Evidence/Observability service (src/shared/evidence-observability.ts)
 *     for the revision/profile-bound removal-evidence graph.
 *
 * Trust posture (the task Acceptance, verbatim): "Trigger is P8 gate; Release
 * Authority is observer; expected is no required legacy use, duplicate writer,
 * orphan reference, data loss, safety regression, or unrehearsed rollback; any
 * finding blocks P9." Six INDEPENDENT blocking conditions are enforced, each
 * fail-closed, and the verdict reports EVERY finding (not just the first):
 *
 *   1. REQUIRED-LEGACY-USE — any P8 leaf still observes required legacy use, or
 *      any old/new reader-writer matrix cell / zero-use window is not cleared.
 *   2. DUPLICATE-WRITER — any state class has more than one writer after
 *      retirement (NN-INV-008, NN-COMPAT-002 single-writer cutover).
 *   3. ORPHAN-REFERENCE — any shipped path is unreachable/unowned or any
 *      dangling reference to a removed surface remains (NN-INV-014, NN-OPS-010).
 *   4. DATA-LOSS — any migration crash/restart or data-restore rehearsal lost a
 *      committed fact / durable node (NN-INV-006, NN-VERIFY-005).
 *   5. SAFETY-REGRESSION — any retirement lowered an immutable safety floor
 *      (NN-COMPAT-003 safety never flag-disabled; NN-SEC controls preserved).
 *   6. UNREHEARSED-ROLLBACK — any leaf lacks a valid revision/profile-bound
 *      rollback rehearsal, or an adapter-restoration rehearsal is missing
 *      (NN-INV-006, NN-VERIFY-005 unrehearsed rollback blocks release).
 *
 * Removal evidence is PUBLISHED: the gate verifies each leaf's removal-evidence
 * query resolves to a valid, revision/profile-bound `EvidenceRecord@1` pass in
 * the observer graph; a missing/stale removal-evidence record is itself a
 * finding (it means the removal was not evidenced at the release revision).
 *
 * Rollback / restore rule (the task Migration, verbatim): "Restore an adapter
 * only through reviewed rollback with same safety floor." An adapter restore is
 * authorized ONLY through a REVIEWED rollback that preserves the SAME safety
 * floor — never a lowered floor. {@link adapterRestoreAuthorized} enforces this.
 *
 * Every verdict is pure over its input and the observer evidence store: NO
 * writes to any core table occur and `coreReadinessUnchanged` is true on every
 * path (NN-INV-014, D-24). The authority holds no durable business state (D-23).
 *
 * Design anchors: D-20 (migration & compatibility plan), D-22 (verification &
 * release-evidence strategy), D-23 (phased rollout/rollback), D-24 (risks).
 * Requirements: NN-INV-006/008/010/014/015, NN-COMPAT-001..017, NN-OPS-005/010,
 * NN-VERIFY-005.
 */

import {
  type EvidenceService,
  type EvidenceQuery,
  type EvidenceMismatchReason,
  evidenceSatisfies,
} from '../shared/evidence-observability.js';

// ─── Rehearsal matrix (the task Deliverables) ────────────────────────────────

/**
 * The distinct rehearsals the P8 exit gate must confirm across all leaves (the
 * task Deliverables): "old/new reader-writer matrices, zero-use windows,
 * migration crash/restart, package/build/reachability, data restore, and
 * adapter restoration rehearsals". Each is an independent, evidence-backed
 * rehearsal; a missing/failed rehearsal is a finding.
 */
export const REHEARSAL_KINDS = Object.freeze([
  'reader-writer-matrix',
  'zero-use-window',
  'migration-crash-restart',
  'package-build-reachability',
  'data-restore',
  'adapter-restoration',
] as const);
export type RehearsalKind = (typeof REHEARSAL_KINDS)[number];

/** Whether a value is a known rehearsal kind. */
export function isRehearsalKind(value: unknown): value is RehearsalKind {
  return (
    typeof value === 'string' &&
    (REHEARSAL_KINDS as readonly string[]).includes(value)
  );
}

/**
 * One rehearsal observation for a P8 leaf. `passed` is the leaf's own reported
 * rehearsal outcome; `evidence` (when present) binds the rehearsal to a valid
 * revision/profile-bound `EvidenceRecord@1` pass in the observer graph. A
 * rehearsal is confirmed IFF `passed` is true AND, when an `evidence` query is
 * supplied, the graph holds a valid pass for it. A rehearsal with NO evidence
 * query is treated as UNREHEARSED (fail-closed): a rehearsal that is not
 * evidenced at the release revision is not a rehearsal.
 */
export interface RehearsalObservation {
  readonly kind: RehearsalKind;
  /** The leaf's reported rehearsal outcome. */
  readonly passed: boolean;
  /** Revision/profile-bound query proving the rehearsal at the release revision. */
  readonly evidence?: EvidenceQuery;
}

// ─── Per-leaf clearance summary (aggregated, not re-derived) ──────────────────

/**
 * The six P8 leaf ids the exit gate aggregates. These are the DEPENDS-ON leaves
 * of FUT-PKG-09-RETIREMENT/T-007. The gate consumes ONE {@link LeafClearance}
 * per leaf; a missing leaf is a fail-closed finding.
 */
export const P8_LEAF_IDS = Object.freeze([
  'FUT-PKG-09-RETIREMENT/T-001',
  'FUT-PKG-09-RETIREMENT/T-002',
  'FUT-PKG-09-RETIREMENT/T-003',
  'FUT-PKG-09-RETIREMENT/T-004',
  'FUT-PKG-09-RETIREMENT/T-005',
  'FUT-PKG-09-RETIREMENT/T-006',
] as const);
export type P8LeafId = (typeof P8_LEAF_IDS)[number];

/** Whether a value is a known P8 leaf id. */
export function isP8LeafId(value: unknown): value is P8LeafId {
  return (
    typeof value === 'string' && (P8_LEAF_IDS as readonly string[]).includes(value)
  );
}

/**
 * The normalized clearance summary a single P8 leaf reports UP to the exit gate.
 * Each field mirrors the leaf's OWN computed verdict — the exit gate never
 * re-derives it, it only aggregates it. Fail-closed booleans: the safe default
 * for every field is the BLOCKING value.
 *
 *   - `cleared` — the leaf's own overall clearance (e.g. the 8.1
 *     `bulkDeletionAuthorized` / 8.6 `retirementMatrixAuthorized` result). A
 *     leaf that did not clear is not eligible for retirement.
 *   - `requiredLegacyUseObserved` — the leaf still observes required legacy use
 *     (any old/new reader-writer matrix cell or zero-use window uncleared).
 *   - `duplicateWriterObserved` — more than one writer remains for a state class.
 *   - `orphanReferenceObserved` — a dangling/unreachable reference remains.
 *   - `dataLossObserved` — a crash/restart or data-restore rehearsal lost a fact.
 *   - `safetyFloorLowered` — a retirement lowered an immutable safety floor.
 *   - `removalEvidence` — the revision/profile-bound query that must resolve to
 *     a valid removal-evidence pass in the observer graph (published evidence).
 *   - `rehearsals` — the leaf's rehearsal observations (a subset of
 *     {@link REHEARSAL_KINDS} relevant to the leaf).
 */
export interface LeafClearance {
  readonly leafId: P8LeafId;
  readonly cleared: boolean;
  readonly requiredLegacyUseObserved: boolean;
  readonly duplicateWriterObserved: boolean;
  readonly orphanReferenceObserved: boolean;
  readonly dataLossObserved: boolean;
  readonly safetyFloorLowered: boolean;
  /** Revision/profile-bound removal-evidence query (published removal proof). */
  readonly removalEvidence: EvidenceQuery;
  readonly rehearsals: readonly RehearsalObservation[];
}

// ─── Blocking findings (any finding blocks P9) ───────────────────────────────

/**
 * The six independent P8 exit-gate finding categories, plus the structural
 * `leaf-not-cleared` (a leaf that did not clear its own gate) and
 * `missing-removal-evidence` (published removal proof absent/stale) and
 * `missing-leaf` (a required leaf did not report). Any finding blocks P9.
 */
export type ExitFindingCategory =
  | 'required-legacy-use'
  | 'duplicate-writer'
  | 'orphan-reference'
  | 'data-loss'
  | 'safety-regression'
  | 'unrehearsed-rollback'
  | 'leaf-not-cleared'
  | 'missing-removal-evidence'
  | 'missing-leaf';

/** A structured, human-safe P8 exit-gate finding. Any finding blocks P9. */
export interface ExitFinding {
  readonly category: ExitFindingCategory;
  /** The leaf the finding pertains to (or `overall` for matrix-wide findings). */
  readonly leafId: P8LeafId | 'overall';
  readonly detail: string;
  /** For an evidence-backed finding, the first mismatch reason. */
  readonly evidenceReason?: EvidenceMismatchReason | 'missing';
}

/** The P8 exit-gate verdict. `pass` iff there are ZERO findings. */
export interface RetirementExitVerdict {
  /** True IFF the gate PASSES (zero findings); false BLOCKS P9. */
  readonly pass: boolean;
  /** True IFF the gate BLOCKS P9 (the complement of {@link pass}). */
  readonly p9Blocked: boolean;
  /** Every independent finding (empty iff the gate passes). */
  readonly findings: readonly ExitFinding[];
  /** Leaf ids that cleared their own gate AND contributed no finding. */
  readonly clearedLeaves: readonly P8LeafId[];
  /** Leaf ids that contributed at least one finding. */
  readonly blockingLeaves: readonly P8LeafId[];
  /** The rehearsal kinds confirmed across all leaves (deterministic order). */
  readonly rehearsalsConfirmed: readonly RehearsalKind[];
  /** The rehearsal kinds NOT confirmed across all leaves (unrehearsed). */
  readonly rehearsalsUnconfirmed: readonly RehearsalKind[];
  /** Always true: no exit verdict changes core readiness (NN-INV-014, D-24). */
  readonly coreReadinessUnchanged: true;
}

/**
 * The full exit-gate input: exactly one {@link LeafClearance} per P8 leaf. The
 * six DEPENDS-ON leaves must ALL report; a missing leaf is a fail-closed
 * finding (`missing-leaf`) and blocks P9. Duplicate leaf reports are ignored
 * after the first (deterministic by leaf id order).
 */
export interface RetirementExitInput {
  readonly leaves: readonly LeafClearance[];
}

/**
 * Classify whether the observer evidence graph holds a valid revision/profile-
 * bound pass for a query, or the precise reason it does not (`missing` when no
 * record even links the criterion; otherwise the first mismatch reason). Mirror
 * of the 8.1 inventory's evidence classifier so the exit gate speaks the same
 * evidence language as the leaves.
 */
function classifyEvidence(
  query: EvidenceQuery,
  evidence: EvidenceService,
): 'ok' | EvidenceMismatchReason | 'missing' {
  if (evidence.hasValidPass(query)) return 'ok';
  const candidate = evidence
    .snapshot()
    .find((r) => r.canonicalLinks.includes(query.canonicalCriterion));
  if (!candidate) return 'missing';
  const why = evidenceSatisfies(candidate, query);
  return why.ok ? 'not-pass' : why.reason;
}

/**
 * Evaluate the fail-closed P8 RETIREMENT EXIT GATE. Pure and total over its
 * input and the observer evidence store — NO writes, NO throws. Every leaf and
 * every blocking condition is evaluated so the verdict reports EVERY finding.
 *
 * The gate PASSES (and admits P9) IFF:
 *   - all six DEPENDS-ON leaves reported, AND
 *   - every leaf's own gate cleared, AND
 *   - NO leaf reports required legacy use, a duplicate writer, an orphan
 *     reference, data loss, or a lowered safety floor, AND
 *   - every leaf's published removal-evidence query resolves to a valid
 *     revision/profile-bound pass, AND
 *   - every rehearsal a leaf declares is CONFIRMED (passed AND evidenced), and
 *     the union of confirmed rehearsals covers every rehearsal kind a leaf
 *     declared (an unrehearsed/failed/​unevidenced rollback blocks).
 * Anything else yields at least one finding and BLOCKS P9.
 */
export function evaluateRetirementExitGate(
  input: RetirementExitInput,
  evidence: EvidenceService,
): RetirementExitVerdict {
  const findings: ExitFinding[] = [];

  // Deduplicate leaves by id (first report wins), sorted for determinism.
  const byId = new Map<P8LeafId, LeafClearance>();
  for (const leaf of input.leaves) {
    if (!byId.has(leaf.leafId)) byId.set(leaf.leafId, leaf);
  }

  // ── Structural: every DEPENDS-ON leaf must report. ────────────────────────
  for (const leafId of P8_LEAF_IDS) {
    if (!byId.has(leafId)) {
      findings.push({
        category: 'missing-leaf',
        leafId,
        detail: `Required P8 leaf ${leafId} did not report a clearance to the exit gate; a missing leaf blocks P9.`,
      });
    }
  }

  const confirmedKinds = new Set<RehearsalKind>();
  const declaredKinds = new Set<RehearsalKind>();
  const blockingLeaves = new Set<P8LeafId>();

  const sortedLeaves = [...byId.values()].sort((a, b) =>
    a.leafId < b.leafId ? -1 : a.leafId > b.leafId ? 1 : 0,
  );

  for (const leaf of sortedLeaves) {
    const before = findings.length;

    // ── (structural) the leaf's own gate must have cleared. ─────────────────
    if (!leaf.cleared) {
      findings.push({
        category: 'leaf-not-cleared',
        leafId: leaf.leafId,
        detail: `${leaf.leafId} did not clear its own retirement gate; an uncleared leaf blocks the P8 exit gate.`,
      });
    }

    // ── (1) required legacy use. ────────────────────────────────────────────
    if (leaf.requiredLegacyUseObserved) {
      findings.push({
        category: 'required-legacy-use',
        leafId: leaf.leafId,
        detail: `${leaf.leafId} still observes required legacy use (an old/new reader-writer matrix cell or zero-use window is not cleared).`,
      });
    }

    // ── (2) duplicate writer. ───────────────────────────────────────────────
    if (leaf.duplicateWriterObserved) {
      findings.push({
        category: 'duplicate-writer',
        leafId: leaf.leafId,
        detail: `${leaf.leafId} leaves more than one writer for a state class; single-writer cutover (NN-INV-008/NN-COMPAT-002) is violated.`,
      });
    }

    // ── (3) orphan reference. ───────────────────────────────────────────────
    if (leaf.orphanReferenceObserved) {
      findings.push({
        category: 'orphan-reference',
        leafId: leaf.leafId,
        detail: `${leaf.leafId} leaves a dangling/unreachable reference to a removed surface (NN-INV-014/NN-OPS-010).`,
      });
    }

    // ── (4) data loss. ──────────────────────────────────────────────────────
    if (leaf.dataLossObserved) {
      findings.push({
        category: 'data-loss',
        leafId: leaf.leafId,
        detail: `${leaf.leafId} lost a committed fact / durable node in a crash-restart or data-restore rehearsal (NN-INV-006/NN-VERIFY-005).`,
      });
    }

    // ── (5) safety regression. ──────────────────────────────────────────────
    if (leaf.safetyFloorLowered) {
      findings.push({
        category: 'safety-regression',
        leafId: leaf.leafId,
        detail: `${leaf.leafId} lowered an immutable safety floor; safety controls are never flag-disabled or weakened by a retirement (NN-COMPAT-003).`,
      });
    }

    // ── published removal evidence must resolve to a valid pass. ────────────
    const removalFinding = classifyEvidence(leaf.removalEvidence, evidence);
    if (removalFinding !== 'ok') {
      findings.push({
        category: 'missing-removal-evidence',
        leafId: leaf.leafId,
        detail: `${leaf.leafId} has no valid revision/profile-bound removal-evidence pass for ${leaf.removalEvidence.canonicalCriterion} (${removalFinding}).`,
        evidenceReason: removalFinding,
      });
    }

    // ── (6) rollback / rehearsal matrix. Each declared rehearsal must be
    //    CONFIRMED (passed AND evidenced at the release revision). ────────────
    for (const rehearsal of leaf.rehearsals) {
      declaredKinds.add(rehearsal.kind);
      const confirmed = isRehearsalConfirmed(rehearsal, evidence);
      if (confirmed) {
        confirmedKinds.add(rehearsal.kind);
      } else {
        const reason = !rehearsal.passed
          ? 'the leaf reported the rehearsal did not pass'
          : rehearsal.evidence === undefined
            ? 'no revision/profile-bound rehearsal evidence was supplied'
            : `no valid rehearsal evidence for ${rehearsal.evidence.canonicalCriterion} (${classifyEvidence(rehearsal.evidence, evidence)})`;
        findings.push({
          category: 'unrehearsed-rollback',
          leafId: leaf.leafId,
          detail: `${leaf.leafId} ${rehearsal.kind} rehearsal is not confirmed: ${reason}. An unrehearsed rollback blocks release (NN-INV-006/NN-VERIFY-005).`,
          ...(rehearsal.passed && rehearsal.evidence !== undefined
            ? { evidenceReason: classifyEvidence(rehearsal.evidence, evidence) as EvidenceMismatchReason | 'missing' }
            : {}),
        });
      }
    }

    if (findings.length > before) blockingLeaves.add(leaf.leafId);
  }

  const pass = findings.length === 0;
  const clearedLeaves = P8_LEAF_IDS.filter(
    (id) => byId.has(id) && !blockingLeaves.has(id),
  );

  const rehearsalsConfirmed = REHEARSAL_KINDS.filter((k) => confirmedKinds.has(k));
  const rehearsalsUnconfirmed = REHEARSAL_KINDS.filter(
    (k) => declaredKinds.has(k) && !confirmedKinds.has(k),
  );

  return Object.freeze({
    pass,
    p9Blocked: !pass,
    findings: Object.freeze(findings),
    clearedLeaves: Object.freeze(clearedLeaves),
    blockingLeaves: Object.freeze([...blockingLeaves].sort()),
    rehearsalsConfirmed: Object.freeze(rehearsalsConfirmed),
    rehearsalsUnconfirmed: Object.freeze(rehearsalsUnconfirmed),
    coreReadinessUnchanged: true as const,
  });
}

/**
 * Whether ONE rehearsal is confirmed. Fail-closed: a rehearsal is confirmed IFF
 * the leaf reported it passed AND a revision/profile-bound evidence query was
 * supplied AND the observer graph holds a valid pass for it. A rehearsal with
 * no evidence query is UNREHEARSED (not evidenced at the release revision).
 */
export function isRehearsalConfirmed(
  rehearsal: RehearsalObservation,
  evidence: EvidenceService,
): boolean {
  if (!rehearsal.passed) return false;
  if (rehearsal.evidence === undefined) return false;
  return evidence.hasValidPass(rehearsal.evidence);
}

/**
 * Whether the whole P8 exit gate admits P9. Fail-closed convenience over
 * {@link evaluateRetirementExitGate}: P9 is admitted IFF the exit verdict
 * passes (zero findings). Any finding keeps P9 blocked.
 */
export function p9AdmissionAuthorized(verdict: RetirementExitVerdict): boolean {
  return verdict.pass;
}

// ─── Reviewed adapter-restoration (same safety floor only) ───────────────────

/**
 * A reviewed adapter-restoration request (the task Migration: "Restore an
 * adapter only through reviewed rollback with same safety floor"). A restore is
 * authorized ONLY when it is REVIEWED and it preserves the SAME safety floor:
 * the restored safety floor must be >= the retired safety floor. Restoring at a
 * LOWER floor is never authorized (that would be a safety regression), and an
 * unreviewed restore is never authorized (NN-OPS-005 explicit authorization,
 * NN-COMPAT-003 immutable safety).
 */
export interface AdapterRestoreRequest {
  /** The adapter being restored, e.g. `adapter:legacy-channel-bootstrap`. */
  readonly adapterId: string;
  /** Whether the rollback restoration was explicitly reviewed/authorized. */
  readonly reviewed: boolean;
  /**
   * The immutable safety-floor level the adapter carried BEFORE retirement.
   * Higher is stricter. The restore must not drop below this floor.
   */
  readonly retiredSafetyFloor: number;
  /** The safety-floor level the restored adapter would carry. */
  readonly restoredSafetyFloor: number;
  /**
   * Revision/profile-bound query proving the rollback restoration was
   * rehearsed at the release revision. A restore with no rehearsal evidence is
   * an UNREHEARSED rollback and is never authorized.
   */
  readonly rehearsal: EvidenceQuery;
}

/** Why an adapter restore is refused (empty iff authorized). */
export type AdapterRestoreBlock =
  | 'unreviewed'
  | 'lowered-safety-floor'
  | 'unrehearsed';

/** The result of evaluating a reviewed adapter-restoration request. */
export interface AdapterRestoreVerdict {
  readonly adapterId: string;
  readonly authorized: boolean;
  readonly blocks: readonly AdapterRestoreBlock[];
}

/**
 * Evaluate a reviewed adapter-restoration request. Pure and total over the
 * observer evidence store. Authorized IFF the restore is reviewed AND preserves
 * the same-or-stricter safety floor AND a valid revision/profile-bound rollback
 * rehearsal exists. Reports EVERY block reason.
 */
export function evaluateAdapterRestore(
  request: AdapterRestoreRequest,
  evidence: EvidenceService,
): AdapterRestoreVerdict {
  const blocks: AdapterRestoreBlock[] = [];
  if (!request.reviewed) blocks.push('unreviewed');
  if (request.restoredSafetyFloor < request.retiredSafetyFloor) {
    blocks.push('lowered-safety-floor');
  }
  if (!evidence.hasValidPass(request.rehearsal)) blocks.push('unrehearsed');
  return Object.freeze({
    adapterId: request.adapterId,
    authorized: blocks.length === 0,
    blocks: Object.freeze(blocks),
  });
}

/**
 * Boolean convenience over {@link evaluateAdapterRestore}: whether a reviewed
 * adapter restoration is authorized (reviewed + same safety floor + rehearsed).
 */
export function adapterRestoreAuthorized(
  request: AdapterRestoreRequest,
  evidence: EvidenceService,
): boolean {
  return evaluateAdapterRestore(request, evidence).authorized;
}
