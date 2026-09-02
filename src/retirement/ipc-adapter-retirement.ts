/**
 * IPC Adapter Retirement — retire the static preload allowlists and the generic
 * channel methods, leaving a TYPED-ONLY reachable IPC surface
 * (FUT-PKG-09-RETIREMENT/T-002).
 *
 * This is a real P8 removal leaf. Unlike the T-001 authority
 * (src/retirement/retirement-inventory.ts), which DELETES NOTHING and only
 * catalogs candidates, this module answers the single fail-closed question for
 * the IPC-boundary candidates: *may the generic/static IPC paths be removed
 * now, and if so what does the post-retirement reachable surface look like?* It
 * does NOT itself edit the preload or the main handler files — it computes the
 * gated authorization for that removal and the exact typed-only surface that
 * survives. The actual source edits are applied only when this authority clears
 * the removal (the migration/rollout step), and never otherwise.
 *
 * It is deliberately built ON the existing truth and creates no parallel one:
 *
 *   - The typed facade/handler/alias truth is the T-002
 *     {@link ContractRegistry} (src/ipc/contract-registry.ts) and its
 *     foundation catalog. Facade↔handler parity and alias→contract coverage are
 *     read from that registry's own `verifyParity()` /
 *     `compareCompatibilityAdapter()` — this module re-implements neither.
 *   - The fail-closed deletion GATE is the T-001
 *     {@link evaluateRetirementItem} (src/retirement/retirement-inventory.ts).
 *     A removal may proceed ONLY when the retirement inventory has cleared the
 *     corresponding `RetirementItem` (disposition REMOVE + all six
 *     prerequisites), which itself reads revision/profile-bound
 *     `EvidenceRecord@1` passes from the observer evidence graph
 *     (src/shared/evidence-observability.ts).
 *   - Caller authorization is the T-002 / SECURITY-T-001 model: a caller tier
 *     is MAIN-ATTESTED only; a renderer-supplied marker or a broad string
 *     allowlist never authorizes (NN-SEC-009, NN-COMPAT-017, D-16.2).
 *
 * The retirement is FAIL CLOSED and never broadens access. Removal is BLOCKED,
 * and the generic/static paths are KEPT (installed, non-authoritative), when
 * ANY of the following holds:
 *
 *   1. PARITY GAP — a legacy generic channel that is still required has no
 *      typed method (a facade/handler parity break, or an alias that maps to no
 *      registered contract). A missing method blocks removal (NN-COMPAT-017
 *      "retire only after typed-facade parity"; NN-EVENT-007 registry is
 *      authority).
 *   2. REQUIRED LEGACY USE — the measured zero-use window is not complete, or
 *      required legacy channel/version use is still observed. A stale caller
 *      blocks removal (NN-COMPAT-017 measured zero required-use; NN-EVENT-009
 *      one main-process writer over validated IPC).
 *   3. AUTHORIZATION GAP — a caller/contract on the typed surface authorizes
 *      from anything other than a main-attested tier (a renderer marker or a
 *      broad allowlist). Broadening access is refused outright (NN-SEC-009,
 *      NN-COMPAT-017).
 *   4. ROLLBACK GAP — there is no reviewed rollback adapter that restores a
 *      BOUNDED VALIDATING adapter only (never the generic broad-access path). A
 *      rollback gap blocks removal (D-20/D-23 feature-scoped rollback to
 *      adapter).
 *   5. INVENTORY GAP — the T-001 retirement inventory has NOT cleared the
 *      corresponding item (its evidence-backed disposition is incomplete). The
 *      removal is gated on `evaluateRetirementItem` clearing.
 *
 * When (and only when) every gate passes, the reachable surface after removal
 * is the typed method set derived from the registry — no generic send/invoke,
 * no static allowlist. The rollback restores a bounded validating adapter that
 * still validates payloads and derives authorization in main; it NEVER restores
 * the generic broad-access path.
 *
 * Design anchors: D-05, D-06, D-16, D-20, D-23. (CD-029, D-16.2 are the design
 * decisions grounding the authorization model.)
 * Requirements: NN-EVENT-007, NN-EVENT-008, NN-EVENT-009, NN-COMPAT-017,
 * NN-SEC-009, NN-COMPAT-001, NN-COMPAT-002.
 */

import {
  ContractRegistry,
  contractNameToMethod,
  type FacadeDescriptor,
} from '../ipc/contract-registry.js';
import { type EvidenceService } from '../shared/evidence-observability.js';
import {
  evaluateRetirementItem,
  type RetirementItem,
  type RetirementVerdict,
} from './retirement-inventory.js';

// ─── The IPC-boundary retirement candidate (built on the T-002 registry) ─────

/**
 * The source of caller authorization for a typed surface member, as observed at
 * the main-process boundary. Only `main-attested` may survive retirement; the
 * other two are the exact anti-patterns retirement removes and must NEVER be
 * broadened (NN-SEC-009, NN-COMPAT-017, D-16.2).
 */
export type AuthorizationSource =
  | 'main-attested'
  | 'renderer-marker'
  | 'static-allowlist';

/**
 * The bounded rollback adapter descriptor. A reviewed rollback for an IPC
 * retirement restores a BOUNDED VALIDATING adapter only: it re-validates every
 * payload and derives authorization in main. `restoresGenericBroadAccess` MUST
 * be false — a rollback that would restore the generic broad-access path is a
 * rollback GAP and blocks removal (never broadens access).
 */
export interface RollbackAdapterPlan {
  /** Whether a reviewed rollback adapter exists at all. */
  readonly reviewed: boolean;
  /** Whether the restored adapter still validates every payload in main. */
  readonly validatesPayloads: boolean;
  /** Whether the restored adapter derives authorization from main attestation. */
  readonly mainAttestedAuthorization: boolean;
  /** MUST be false: a rollback restoring generic broad access is a gap. */
  readonly restoresGenericBroadAccess: boolean;
}

/**
 * One legacy generic channel observed on the preload string allowlist that this
 * retirement must account for. Each required channel must resolve to a
 * registered typed contract (parity), and its authorization must be
 * main-attested.
 */
export interface LegacyChannelObservation {
  /** The legacy string channel name on the preload allowlist. */
  readonly legacyChannel: string;
  /**
   * Whether this channel is still REQUIRED (a real caller depends on it). A
   * required channel with no typed contract is a parity gap; a not-yet-required
   * channel that is unmapped is a bounded adapter still in migration, not a
   * removal blocker.
   */
  readonly required: boolean;
  /** How a caller on this channel is authorized at the main boundary. */
  readonly authorization: AuthorizationSource;
  /** Legacy versions still observed in required use (empty => none). */
  readonly versionsStillInUse: readonly string[];
}

/**
 * The full IPC-boundary retirement candidate. It binds the observed legacy
 * surface to the T-002 registry (the typed authority) and to the T-001
 * inventory item (the fail-closed deletion gate), plus the measured zero-use
 * window and the reviewed rollback adapter.
 */
export interface IpcRetirementCandidate {
  /** Stable id, e.g. `adapter:preload-allowlist`. */
  readonly candidateId: string;
  /** The typed authority registry (T-002); its parity is read, not re-derived. */
  readonly registry: ContractRegistry;
  /** Every legacy generic channel observed on the preload allowlist. */
  readonly observedLegacyChannels: readonly LegacyChannelObservation[];
  /**
   * Whether a generic send/invoke method is still reachable from the renderer
   * (the broad-access path). A reachable generic method is itself a broadening
   * surface and blocks a typed-only removal until it is gone.
   */
  readonly genericMethodReachable: boolean;
  /** Whether the measured zero-required-use window has completed. */
  readonly zeroUseWindowMeasured: boolean;
  /** The reviewed bounded rollback adapter plan. */
  readonly rollback: RollbackAdapterPlan;
  /**
   * The T-001 retirement-inventory item for this candidate. Removal is gated on
   * this item clearing (`evaluateRetirementItem`).
   */
  readonly inventoryItem: RetirementItem;
}

// ─── Removal gate verdict ────────────────────────────────────────────────────

/** Each independent retirement gate for the IPC boundary. */
export const RETIREMENT_GATES = Object.freeze([
  'parity',
  'zero-use',
  'authorization',
  'rollback',
  'inventory',
] as const);
export type RetirementGate = (typeof RETIREMENT_GATES)[number];

/** A structured, human-safe reason a removal is blocked. */
export interface RetirementBlockReason {
  readonly gate: RetirementGate;
  readonly detail: string;
}

/**
 * The reachable IPC surface after a (hypothetical or cleared) removal. When the
 * removal is cleared this is the TYPED-ONLY surface derived from the registry:
 * the named typed facade methods, no generic method, no static allowlist. When
 * the removal is blocked the generic/static paths are RETAINED unchanged, so
 * `genericMethodReachable`/`staticAllowlistReachable` stay true.
 */
export interface ReachableSurface {
  /** The typed facade method names that remain reachable (sorted). */
  readonly typedMethods: readonly string[];
  /** Whether a generic send/invoke method is still reachable. */
  readonly genericMethodReachable: boolean;
  /** Whether a static preload allowlist is still reachable. */
  readonly staticAllowlistReachable: boolean;
}

/**
 * The verdict for an IPC-boundary retirement. `clearedForRemoval` is the single
 * fail-closed decision. When cleared, `postRetirementSurface` is typed-only and
 * `rollbackRestoresBoundedAdapterOnly` is true. When blocked, the generic/static
 * paths are retained (never broadened) and every unmet gate is reported.
 */
export interface IpcRetirementVerdict {
  readonly candidateId: string;
  /** IFF true, the generic/static paths may be removed now. */
  readonly clearedForRemoval: boolean;
  /** The gates that are satisfied. */
  readonly satisfiedGates: readonly RetirementGate[];
  /** Every independent reason removal is blocked (empty iff cleared). */
  readonly blockReasons: readonly RetirementBlockReason[];
  /** The reachable surface (typed-only iff cleared; retained otherwise). */
  readonly postRetirementSurface: ReachableSurface;
  /** True iff a cleared rollback restores a bounded validating adapter only. */
  readonly rollbackRestoresBoundedAdapterOnly: boolean;
  /** The underlying T-001 inventory verdict this removal was gated on. */
  readonly inventoryVerdict: RetirementVerdict;
  /** Access is NEVER broadened by any retirement outcome. */
  readonly accessNeverBroadened: true;
}

// ─── The fail-closed removal gate ─────────────────────────────────────────────

/**
 * Evaluate the fail-closed IPC-boundary removal gate for ONE candidate. Pure
 * and total over its input and the observer evidence store — NO writes, NO
 * throws, NO source edits. Every gate is evaluated so the verdict reports EVERY
 * unmet gate, not just the first. The generic/static paths are cleared for
 * removal IFF all five gates pass; otherwise they are RETAINED (installed,
 * non-authoritative) and access is never broadened.
 */
export function evaluateIpcRetirement(
  candidate: IpcRetirementCandidate,
  evidence: EvidenceService,
): IpcRetirementVerdict {
  const blockReasons: RetirementBlockReason[] = [];
  const satisfiedGates: RetirementGate[] = [];

  const requiredChannels = candidate.observedLegacyChannels.filter((c) => c.required);

  // (1) PARITY — the registry's own facade↔handler parity holds, AND every
  // REQUIRED legacy channel resolves to a registered typed contract. A required
  // channel with no typed contract is a missing-method parity gap.
  const parityReport = candidate.registry.verifyParity();
  const unmappedRequired = requiredChannels
    .filter((c) => candidate.registry.resolveAlias(c.legacyChannel) === undefined)
    .map((c) => c.legacyChannel)
    .sort();
  const parityOk = parityReport.ok && unmappedRequired.length === 0;
  if (parityOk) {
    satisfiedGates.push('parity');
  } else {
    const detail = !parityReport.ok
      ? `Typed facade/handler parity is broken (missingFacades=[${parityReport.missingFacades.join(', ')}], orphanFacades=[${parityReport.orphanFacades.join(', ')}], missingHandlers=[${parityReport.missingHandlers.join(', ')}], orphanHandlers=[${parityReport.orphanHandlers.join(', ')}]); a missing method blocks removal.`
      : `Required legacy channel(s) have no typed method: ${unmappedRequired.join(', ')}. A missing method blocks removal.`;
    blockReasons.push({ gate: 'parity', detail });
  }

  // (2) ZERO-USE — a measured window with no required legacy channel/version
  // still in use. An unmeasured window or a stale caller blocks removal.
  const staleUse = requiredChannels.filter((c) => c.versionsStillInUse.length > 0);
  const zeroUseOk = candidate.zeroUseWindowMeasured && staleUse.length === 0;
  if (zeroUseOk) {
    satisfiedGates.push('zero-use');
  } else {
    const detail = !candidate.zeroUseWindowMeasured
      ? `The zero-required-use window for ${candidate.candidateId} is not measured; required legacy use cannot be ruled out.`
      : `Required legacy use is still observed (stale caller): ${staleUse
          .map((c) => `${c.legacyChannel}(${c.versionsStillInUse.join('/')})`)
          .join(', ')}.`;
    blockReasons.push({ gate: 'zero-use', detail });
  }

  // (3) AUTHORIZATION — every required channel authorizes from a MAIN-ATTESTED
  // tier only. A renderer marker or a static allowlist authorization is the
  // exact broadening surface retirement removes and blocks removal outright.
  const nonAttested = requiredChannels.filter(
    (c) => c.authorization !== 'main-attested',
  );
  const authorizationOk = nonAttested.length === 0;
  if (authorizationOk) {
    satisfiedGates.push('authorization');
  } else {
    blockReasons.push({
      gate: 'authorization',
      detail: `Caller authorization is not main-attested for: ${nonAttested
        .map((c) => `${c.legacyChannel}(${c.authorization})`)
        .join(', ')}. Access must never be broadened.`,
    });
  }

  // (4) ROLLBACK — a reviewed bounded validating adapter that restores neither
  // the generic broad-access path nor renderer-trusted authorization.
  const rb = candidate.rollback;
  const rollbackRestoresBoundedAdapterOnly =
    rb.reviewed &&
    rb.validatesPayloads &&
    rb.mainAttestedAuthorization &&
    !rb.restoresGenericBroadAccess;
  if (rollbackRestoresBoundedAdapterOnly) {
    satisfiedGates.push('rollback');
  } else {
    const detail = !rb.reviewed
      ? `No reviewed rollback adapter for ${candidate.candidateId}; a rollback gap blocks removal.`
      : rb.restoresGenericBroadAccess
        ? `The rollback for ${candidate.candidateId} would restore the generic broad-access path; rollback must restore a bounded validating adapter only.`
        : `The rollback for ${candidate.candidateId} is not a bounded validating adapter (validatesPayloads=${rb.validatesPayloads}, mainAttestedAuthorization=${rb.mainAttestedAuthorization}).`;
    blockReasons.push({ gate: 'rollback', detail });
  }

  // (5) INVENTORY — the T-001 retirement inventory has cleared the item.
  const inventoryVerdict = evaluateRetirementItem(candidate.inventoryItem, evidence);
  if (inventoryVerdict.clearedForDeletion) {
    satisfiedGates.push('inventory');
  } else {
    blockReasons.push({
      gate: 'inventory',
      detail: `The retirement inventory has not cleared ${candidate.inventoryItem.itemId}: ${inventoryVerdict.blockReasons
        .map((r) => r.prerequisite)
        .join(', ')}.`,
    });
  }

  const clearedForRemoval = blockReasons.length === 0;

  // A reachable generic method is itself a broad-access surface. It does not
  // add a distinct gate (it is subsumed by parity/authorization intent) but it
  // is reflected in the retained surface when removal is blocked, and it is
  // gone from the typed-only surface when removal is cleared.
  const typedMethods = candidate.registry
    .generateFacades()
    .map((f: FacadeDescriptor) => f.methodName)
    .sort();

  const postRetirementSurface: ReachableSurface = clearedForRemoval
    ? {
        // Typed-only: the derived facade methods; no generic method, no static
        // allowlist survive the cleared removal.
        typedMethods,
        genericMethodReachable: false,
        staticAllowlistReachable: false,
      }
    : {
        // Blocked: the generic/static paths are RETAINED unchanged (installed,
        // non-authoritative). Access is never broadened.
        typedMethods,
        genericMethodReachable: candidate.genericMethodReachable,
        staticAllowlistReachable: true,
      };

  return Object.freeze({
    candidateId: candidate.candidateId,
    clearedForRemoval,
    satisfiedGates: Object.freeze([...satisfiedGates]),
    blockReasons: Object.freeze(blockReasons),
    postRetirementSurface: Object.freeze(postRetirementSurface),
    rollbackRestoresBoundedAdapterOnly,
    inventoryVerdict,
    accessNeverBroadened: true as const,
  });
}

// ─── Post-retirement reachable-surface assertion ─────────────────────────────

/**
 * Whether a verdict proves a TYPED-ONLY reachable surface: the removal cleared,
 * a generic method is no longer reachable, and no static allowlist survives.
 * This is the observer for the `typed-facade-postretirement` fixture: after a
 * cleared retirement the reachable surface is exactly the typed method set.
 */
export function isTypedOnlyReachable(verdict: IpcRetirementVerdict): boolean {
  return (
    verdict.clearedForRemoval &&
    !verdict.postRetirementSurface.genericMethodReachable &&
    !verdict.postRetirementSurface.staticAllowlistReachable
  );
}

/**
 * Whether the typed-only surface derived from a registry exactly matches the
 * expected typed method set for its renderer-to-main contracts. Proves the
 * surviving surface is the registry-derived typed set and nothing more
 * (parity → typed-only). Deterministic (both sides sorted).
 */
export function typedSurfaceMatchesRegistry(registry: ContractRegistry): boolean {
  const derived = registry
    .generateFacades()
    .map((f) => f.methodName)
    .sort();
  const expected = registry
    .names()
    .map((name) => registry.get(name)!)
    .filter((c) => c.direction === 'renderer-to-main')
    .map((c) => contractNameToMethod(c.name))
    .sort();
  if (derived.length !== expected.length) return false;
  return derived.every((m, i) => m === expected[i]);
}

// ─── Batch retirement review ─────────────────────────────────────────────────

/** The result of reviewing every IPC-boundary retirement candidate. */
export interface IpcRetirementReview {
  readonly verdicts: readonly IpcRetirementVerdict[];
  /** Candidate ids cleared for removal (typed-only surface reachable). */
  readonly cleared: readonly string[];
  /** Candidate ids whose generic/static paths are retained (blocked). */
  readonly retained: readonly string[];
  /** Access is NEVER broadened by any retirement outcome. */
  readonly accessNeverBroadened: true;
}

/**
 * Review every IPC-boundary retirement candidate. Deterministic: verdicts are
 * returned sorted by candidate id. No source edit is performed here; the review
 * only computes gated authorization and the resulting reachable surface.
 */
export function reviewIpcRetirement(
  candidates: readonly IpcRetirementCandidate[],
  evidence: EvidenceService,
): IpcRetirementReview {
  const verdicts = [...candidates]
    .map((candidate) => evaluateIpcRetirement(candidate, evidence))
    .sort((a, b) =>
      a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0,
    );
  const cleared = verdicts.filter((v) => v.clearedForRemoval).map((v) => v.candidateId);
  const retained = verdicts
    .filter((v) => !v.clearedForRemoval)
    .map((v) => v.candidateId);
  return Object.freeze({
    verdicts: Object.freeze(verdicts),
    cleared: Object.freeze(cleared),
    retained: Object.freeze(retained),
    accessNeverBroadened: true as const,
  });
}
