/**
 * Compatibility / Retirement Authority — itemized retirement inventory and the
 * FAIL-CLOSED zero-use / deletion-prerequisite GATE (FUT-PKG-09-RETIREMENT/T-001).
 *
 * This module is the OBSERVATION-ONLY foundation for P8 (adapter retirement and
 * orphan remediation). It DELETES NOTHING: the later leaf tasks
 * FUT-PKG-09-RETIREMENT/T-002..T-006 perform the actual removals, and each is
 * gated on a `RetirementInventory@1` item that this authority has cleared. The
 * gate here decides only ONE thing per item: whether that item's deletion may
 * PROCEED. An item whose evidence is incomplete stays INSTALLED-but-
 * NON-AUTHORITATIVE and its deletion is BLOCKED (fail-closed). No bulk deletion
 * is ever authorized from an incomplete inventory.
 *
 * Trust posture (the task Acceptance, verbatim): "Trigger is retirement
 * candidacy review; generated inventory/telemetry is observer; expected is
 * complete evidence-backed disposition; unknown use, data, owner, reachability,
 * parity, or rollback keeps item installed but non-authoritative and blocks
 * deletion." Six INDEPENDENT prerequisites must ALL be satisfied before an
 * item's deletion is cleared, and each is fail-closed on `unknown`:
 *
 *   1. USE — a zero-required-use window must be OBSERVED (measured), not merely
 *      asserted. Unknown usage keeps the item installed and blocks deletion
 *      (NN-COMPAT-001 measured deprecation, NN-VERIFY-001 criterion evidence).
 *   2. DATA — the item's data inventory must be KNOWN and either empty or
 *      migrated to the canonical owner. Unknown data blocks deletion so no
 *      state class is orphaned (NN-INV-008 one owner per data class).
 *   3. OWNER — a single canonical owner + disposition
 *      (`WIRE|MIGRATE|QUARANTINE|REMOVE`, NN-OPS-010) must be recorded. Unknown
 *      owner blocks deletion.
 *   4. REACHABILITY — production reachability must be resolved to a definite
 *      state (reachable-and-owned, or proven-unreachable). Reachability
 *      UNCERTAINTY blocks deletion (NN-INV-014 no orphan/inert path).
 *   5. PARITY — the replacement path must have a revision/profile-bound parity
 *      PASS in the observer evidence graph (FIX-RETIREMENT-PARITY-01). Missing
 *      or stale parity blocks deletion (NN-COMPAT-001 retire only after parity).
 *   6. ROLLBACK — a rescue/restore artifact must be recorded AND an independent
 *      rollback rehearsal must have a valid revision/profile-bound pass. A
 *      missing rehearsal blocks deletion (NN-INV-006 recoverability before
 *      mutation, NN-VERIFY-005 unrehearsed rollback blocks release).
 *
 * The gate is an OBSERVER over the Evidence/Observability graph
 * (src/shared/evidence-observability.ts) and the D-19.4 capability status
 * ladder (src/shared/capability-registry.ts). It re-implements NONE of the
 * P3–P8 adapters/writers; it only READS revision/profile-bound
 * `EvidenceRecord@1` passes and renders a per-item disposition. It performs NO
 * writes to any core table; clearing or blocking an item changes nothing about
 * core readiness (NN-INV-014, D-24). Rollback simply corrects a disposition —
 * the authority holds no durable business state (D-23).
 *
 * Design anchors: D-05 (components/responsibilities), D-20 (migration &
 * compatibility plan), D-23 (phased rollout/rollback), D-24 (risks).
 * Requirements: NN-INV-008, NN-INV-010, NN-INV-014, NN-COMPAT-001..004,
 * NN-OPS-010, NN-VERIFY-001, NN-VERIFY-005.
 */

import { type CapabilityStatus } from '../shared/capability-registry.js';
import {
  type EvidenceService,
  type EvidenceQuery,
  type EvidenceMismatchReason,
  evidenceSatisfies,
} from '../shared/evidence-observability.js';

// ─── Retirement candidate taxonomy (the task Deliverables) ───────────────────

/**
 * The kinds of retirement candidates the inventory must catalog: "every
 * adapter/alias/duplicate writer/stub/orphan". Each real P8 leaf
 * (T-002..T-006) owns one or more of these kinds.
 */
export const RETIREMENT_KINDS = Object.freeze([
  'adapter',
  'alias',
  'duplicate-writer',
  'stub',
  'orphan',
] as const);
export type RetirementKind = (typeof RETIREMENT_KINDS)[number];

/** Whether a value is a known retirement kind. */
export function isRetirementKind(value: unknown): value is RetirementKind {
  return (
    typeof value === 'string' &&
    (RETIREMENT_KINDS as readonly string[]).includes(value)
  );
}

/**
 * The orphan-disposition verbs (NN-OPS-010): every suspect file/path receives a
 * recorded canonical owner plus one of these dispositions. `REMOVE` is the only
 * disposition that authorizes a later leaf's deletion — and only after every
 * prerequisite below is satisfied. `WIRE`/`MIGRATE`/`QUARANTINE` keep the item
 * installed (non-authoritative) and never authorize deletion.
 */
export const DISPOSITIONS = Object.freeze([
  'WIRE',
  'MIGRATE',
  'QUARANTINE',
  'REMOVE',
] as const);
export type Disposition = (typeof DISPOSITIONS)[number];

/** Whether a value is a known disposition. */
export function isDisposition(value: unknown): value is Disposition {
  return (
    typeof value === 'string' && (DISPOSITIONS as readonly string[]).includes(value)
  );
}

// ─── Fail-closed prerequisite signals ────────────────────────────────────────

/**
 * The three-valued observation for a prerequisite that is not itself an
 * evidence query. `unknown` is the fail-closed default: an unresolved signal
 * keeps the item installed and blocks deletion.
 */
export type TriState = 'known' | 'unknown';

/**
 * USAGE / VERSION telemetry for an item. `observedZeroUse` is meaningful ONLY
 * when `window` is `known`: a `known` window with `observedZeroUse: true` is a
 * measured zero-required-use window; anything else (unknown window, or observed
 * required use) blocks deletion. `versionsInUse` records legacy versions still
 * observed (for an alias/adapter support window); a non-empty set blocks
 * deletion because required legacy use remains.
 */
export interface UsageTelemetry {
  /** Whether the zero-use observation WINDOW has completed and been measured. */
  readonly window: TriState;
  /** Whether the measured window observed zero required use. */
  readonly observedZeroUse: boolean;
  /** Legacy versions still observed in use (empty => none observed). */
  readonly versionsInUse: readonly string[];
}

/**
 * DATA inventory for an item. `state` is fail-closed on `unknown`; a `known`
 * inventory is clearable only when it is empty or already migrated to the
 * canonical owner.
 */
export interface DataInventory {
  readonly state: TriState;
  /** Whether the item still holds durable data of any class. */
  readonly holdsDurableData: boolean;
  /** Whether all held data was migrated to the canonical owner. */
  readonly migratedToCanonicalOwner: boolean;
}

/**
 * REACHABILITY resolution. `resolved: false` means production reachability is
 * UNCERTAIN and blocks deletion (NN-INV-014). When resolved, `reachable`
 * distinguishes a still-reachable owned path (keep) from a proven-unreachable
 * path (removable, subject to the other gates).
 */
export interface ReachabilityResolution {
  readonly resolved: boolean;
  readonly reachable: boolean;
}

/**
 * The rescue/restore ARTIFACT descriptor. A restore artifact must be recorded
 * (`recorded: true` with a non-empty `artifactRef`) AND a rollback rehearsal
 * evidence pass must exist (see {@link RetirementItem.rollbackRehearsal}).
 */
export interface RescueArtifact {
  readonly recorded: boolean;
  /** A content-addressed / non-private-path reference to the rescue artifact. */
  readonly artifactRef: string;
}

// ─── RetirementInventory@1 item ──────────────────────────────────────────────

/**
 * A single `RetirementInventory@1` item: one adapter/alias/duplicate-writer/
 * stub/orphan candidate with the full evidence-backed disposition the task
 * Deliverables enumerate. The queries bind to the observer evidence graph at
 * the EXACT criterion + source revision + implementation revision + fixture
 * profile (D-07); a stale/mismatched pass never satisfies them.
 */
export interface RetirementItem {
  /** Stable candidate id, e.g. `adapter:channel-bootstrap`, `alias:skill-path`. */
  readonly itemId: string;
  /** Human-safe path/surface this item covers (never a private absolute path). */
  readonly surface: string;
  readonly kind: RetirementKind;
  /** The single canonical owner authority id; empty string => unknown owner. */
  readonly owner: string;
  /** The recorded disposition (NN-OPS-010). */
  readonly disposition: Disposition;
  /** The P8 leaf task that will perform the removal once this item is cleared. */
  readonly retiringLeaf: string;
  readonly usage: UsageTelemetry;
  readonly data: DataInventory;
  readonly reachability: ReachabilityResolution;
  readonly rescue: RescueArtifact;
  /** Revision/profile-bound query for the replacement PARITY pass. */
  readonly parity: EvidenceQuery;
  /** Revision/profile-bound query for the independent ROLLBACK rehearsal pass. */
  readonly rollbackRehearsal: EvidenceQuery;
}

// ─── Deletion gate verdict ───────────────────────────────────────────────────

/** Each independent deletion prerequisite. */
export const DELETION_PREREQUISITES = Object.freeze([
  'use',
  'data',
  'owner',
  'reachability',
  'parity',
  'rollback',
] as const);
export type DeletionPrerequisite = (typeof DELETION_PREREQUISITES)[number];

/** A structured, human-safe reason a deletion is blocked. */
export interface DeletionBlockReason {
  readonly prerequisite: DeletionPrerequisite;
  readonly detail: string;
  /** For a parity/rollback evidence gap, the first mismatch reason. */
  readonly evidenceReason?: EvidenceMismatchReason | 'missing';
}

/**
 * The disposition verdict for ONE inventory item. `clearedForDeletion` is the
 * single fail-closed decision. `installedNonAuthoritative` is its complement:
 * whenever deletion is blocked the item stays installed but non-authoritative.
 * `status` is the D-19.4 ladder position of the CANDIDATE (never the core):
 * `ready` means cleared for its leaf's removal, `blocked` means a prerequisite
 * is unmet, `unavailable` means proven-unreachable-but-still-gated,
 * `degraded` means installed-non-authoritative pending observation.
 * `coreReadinessUnchanged` is ALWAYS true (NN-INV-014, D-24).
 */
export interface RetirementVerdict {
  readonly itemId: string;
  readonly kind: RetirementKind;
  readonly disposition: Disposition;
  readonly clearedForDeletion: boolean;
  readonly installedNonAuthoritative: boolean;
  readonly status: CapabilityStatus;
  /** Which of the six prerequisites are satisfied. */
  readonly satisfied: readonly DeletionPrerequisite[];
  /** Every independent reason deletion is blocked (empty iff cleared). */
  readonly blockReasons: readonly DeletionBlockReason[];
  readonly coreReadinessUnchanged: true;
}

/**
 * Evaluate the fail-closed deletion gate for ONE retirement item. Pure and
 * total over its input and the observer evidence store — NO writes, NO throws.
 * All six prerequisites are evaluated so the verdict reports EVERY unmet
 * prerequisite, not just the first. An item is cleared for deletion IFF its
 * disposition is `REMOVE` AND all six prerequisites are satisfied; anything
 * else keeps the item installed-but-non-authoritative and blocks deletion.
 */
export function evaluateRetirementItem(
  item: RetirementItem,
  evidence: EvidenceService,
): RetirementVerdict {
  const blockReasons: DeletionBlockReason[] = [];
  const satisfied: DeletionPrerequisite[] = [];

  // (1) USE — a measured zero-required-use window with no legacy versions.
  const useOk =
    item.usage.window === 'known' &&
    item.usage.observedZeroUse &&
    item.usage.versionsInUse.length === 0;
  if (useOk) {
    satisfied.push('use');
  } else {
    const detail =
      item.usage.window !== 'known'
        ? `Zero-use window for ${item.itemId} is not measured (unknown); required use cannot be ruled out.`
        : item.usage.versionsInUse.length > 0
          ? `Legacy versions still observed in use for ${item.itemId}: ${item.usage.versionsInUse.join(', ')}.`
          : `A measured window observed required use for ${item.itemId}.`;
    blockReasons.push({ prerequisite: 'use', detail });
  }

  // (2) DATA — known inventory that is empty or migrated to the canonical owner.
  const dataOk =
    item.data.state === 'known' &&
    (!item.data.holdsDurableData || item.data.migratedToCanonicalOwner);
  if (dataOk) {
    satisfied.push('data');
  } else {
    const detail =
      item.data.state !== 'known'
        ? `Data inventory for ${item.itemId} is unknown; no state class may be orphaned.`
        : `${item.itemId} still holds durable data not migrated to the canonical owner.`;
    blockReasons.push({ prerequisite: 'data', detail });
  }

  // (3) OWNER — a single canonical owner is recorded.
  const ownerOk = item.owner.trim().length > 0;
  if (ownerOk) {
    satisfied.push('owner');
  } else {
    blockReasons.push({
      prerequisite: 'owner',
      detail: `${item.itemId} has no recorded canonical owner.`,
    });
  }

  // (4) REACHABILITY — resolved to proven-unreachable (removable). Uncertainty
  // OR a still-reachable owned path blocks deletion. (A reachable path is kept
  // installed and authoritative; it is not a deletion candidate yet.)
  const reachabilityOk = item.reachability.resolved && !item.reachability.reachable;
  if (reachabilityOk) {
    satisfied.push('reachability');
  } else {
    const detail = !item.reachability.resolved
      ? `Production reachability for ${item.itemId} is uncertain (unresolved).`
      : `${item.itemId} is still reachable from a production entry point and must not be deleted.`;
    blockReasons.push({ prerequisite: 'reachability', detail });
  }

  // (5) PARITY — a valid revision/profile-bound parity pass for the replacement.
  const parityFinding = classifyEvidence(item.parity, evidence);
  if (parityFinding === 'ok') {
    satisfied.push('parity');
  } else {
    blockReasons.push({
      prerequisite: 'parity',
      detail: `${item.itemId} has no valid revision/profile-bound parity pass for ${item.parity.canonicalCriterion} (${parityFinding}).`,
      evidenceReason: parityFinding,
    });
  }

  // (6) ROLLBACK — a recorded rescue artifact AND a valid rollback rehearsal.
  const rescueRecorded = item.rescue.recorded && item.rescue.artifactRef.trim().length > 0;
  const rollbackFinding = classifyEvidence(item.rollbackRehearsal, evidence);
  const rollbackOk = rescueRecorded && rollbackFinding === 'ok';
  if (rollbackOk) {
    satisfied.push('rollback');
  } else {
    const detail = !rescueRecorded
      ? `${item.itemId} has no recorded rescue/restore artifact.`
      : `${item.itemId} has no valid rollback rehearsal for ${item.rollbackRehearsal.canonicalCriterion} (${rollbackFinding}).`;
    blockReasons.push({
      prerequisite: 'rollback',
      detail,
      // A recorded rescue with an evidence gap surfaces the precise reason; a
      // missing rescue artifact is not an evidence-query mismatch.
      ...(rescueRecorded && rollbackFinding !== 'ok'
        ? { evidenceReason: rollbackFinding }
        : {}),
    });
  }

  const allSatisfied = satisfied.length === DELETION_PREREQUISITES.length;
  const dispositionAllowsRemoval = item.disposition === 'REMOVE';
  const clearedForDeletion = allSatisfied && dispositionAllowsRemoval;

  if (allSatisfied && !dispositionAllowsRemoval) {
    // Every prerequisite is met, but the disposition is not REMOVE, so the item
    // is intentionally kept installed (WIRE/MIGRATE/QUARANTINE). This is not a
    // fail-closed block; it is a recorded decision, surfaced for transparency.
    blockReasons.push({
      prerequisite: 'owner',
      detail: `${item.itemId} is fully evidenced but its disposition is ${item.disposition}, not REMOVE; it stays installed by decision.`,
    });
  }

  const status = deriveRetirementStatus({
    clearedForDeletion,
    reachabilityResolved: item.reachability.resolved,
    reachable: item.reachability.reachable,
    blockedCount: blockReasons.length,
    dispositionAllowsRemoval,
  });

  return Object.freeze({
    itemId: item.itemId,
    kind: item.kind,
    disposition: item.disposition,
    clearedForDeletion,
    installedNonAuthoritative: !clearedForDeletion,
    status,
    satisfied: Object.freeze([...satisfied]),
    blockReasons: Object.freeze(blockReasons),
    coreReadinessUnchanged: true as const,
  });
}

/**
 * Classify whether the evidence graph holds a valid revision/profile-bound pass
 * for a query, or the precise reason it does not (`missing` when no record even
 * links the criterion; otherwise the first mismatch reason).
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
 * Map the deletion decision + reachability onto the D-19.4 ladder for the
 * CANDIDATE (never the core). `ready` = cleared for removal; `unavailable` =
 * proven-unreachable but still gated (an inert path pending its other gates);
 * `blocked` = a hard prerequisite gap; `degraded` = installed-non-authoritative
 * pending observation (window not yet measured) with no other hard gap.
 */
function deriveRetirementStatus(signals: {
  readonly clearedForDeletion: boolean;
  readonly reachabilityResolved: boolean;
  readonly reachable: boolean;
  readonly blockedCount: number;
  readonly dispositionAllowsRemoval: boolean;
}): CapabilityStatus {
  if (signals.clearedForDeletion) return 'ready';
  if (signals.reachabilityResolved && !signals.reachable) return 'unavailable';
  return 'blocked';
}

// ─── Batch review (retirement candidacy review trigger) ──────────────────────

/** The result of a full retirement-candidacy review pass. */
export interface RetirementReviewResult {
  readonly verdicts: readonly RetirementVerdict[];
  /** Item ids cleared for their leaf's deletion (complete evidence-backed). */
  readonly cleared: readonly string[];
  /** Item ids kept installed-but-non-authoritative (deletion blocked). */
  readonly blocked: readonly string[];
  /** Always true: no retirement verdict changes core readiness (NN-INV-014). */
  readonly coreReadinessUnchanged: true;
}

/**
 * Evaluate the deletion gate over every inventory item (the "retirement
 * candidacy review" trigger). Deterministic: verdicts are returned sorted by
 * item id. The generated inventory/telemetry and the evidence graph are
 * observers; NO deletion is performed here.
 */
export function reviewRetirementInventory(
  items: readonly RetirementItem[],
  evidence: EvidenceService,
): RetirementReviewResult {
  const verdicts = [...items]
    .map((item) => evaluateRetirementItem(item, evidence))
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
  const cleared = verdicts.filter((v) => v.clearedForDeletion).map((v) => v.itemId);
  const blocked = verdicts.filter((v) => !v.clearedForDeletion).map((v) => v.itemId);
  return Object.freeze({
    verdicts: Object.freeze(verdicts),
    cleared: Object.freeze(cleared),
    blocked: Object.freeze(blocked),
    coreReadinessUnchanged: true as const,
  });
}

/**
 * Whether a bulk deletion may proceed for a review result. Fail-closed: a bulk
 * deletion is authorized ONLY when the inventory is complete (at least one
 * item) AND every item is cleared — an incomplete inventory (any blocked item)
 * authorizes NO bulk deletion (the task Migration/rollback rule). This models
 * "no bulk deletion from an incomplete inventory."
 */
export function bulkDeletionAuthorized(result: RetirementReviewResult): boolean {
  return result.verdicts.length > 0 && result.blocked.length === 0;
}
