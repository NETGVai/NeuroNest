/**
 * Static-catalog / duplicate-watcher / success-stub / unreachable-code
 * RETIREMENT GATE — the fail-closed leaf that executes the per-path
 * `WIRE|MIGRATE|QUARANTINE|REMOVE` cascade (FUT-PKG-09-RETIREMENT/T-005).
 *
 * This module is OBSERVATION-ONLY and FAIL-CLOSED. It DELETES NOTHING and
 * writes to NO core table; it only decides, per candidate, whether a removal
 * may PROCEED. Every removal here is additionally gated on a
 * `RetirementInventory@1` item the 8.1 authority
 * ({@link ./retirement-inventory}.evaluateRetirementItem) has already cleared —
 * this leaf never re-derives the six deletion prerequisites, it reuses them.
 *
 * It RESOLVES the CD-014 concern flagged by the 8.1 inventory: the legacy
 * channel adapter bootstrap (src/channels/adapters/index.ts) declares
 * `implementationStatus: 'available'` on ALL 43 adapters, including the 36
 * catalog-only ones. That is a static, success-shaped whitelist that lies about
 * capability truth. The canonical `ChannelRegistryAuthority` (7.1) is the SINGLE
 * SOURCE OF TRUTH: 7 REAL adapters are `available`, the 36 catalog-only entries
 * are `coming-soon`/UNAVAILABLE. This gate reconciles the static whitelist
 * against the registry-derived truth and BLOCKS retirement whenever the whitelist
 * would advertise a catalog-only id as available (a false `available`/success).
 *
 * The four fail-closed triggers the task Acceptance enumerates — a COUNT
 * MISMATCH, a LOST CAPABILITY, an UNRESOLVED IMPORT, or a FALSE
 * UNAVAILABLE/SUCCESS — each BLOCKS the removal:
 *
 *   1. COUNT PARITY ({@link compareRuntimeCount}) — a static/historic total
 *      (e.g. 43, 83, 537, 77) must be replaced by the count DERIVED from the
 *      owning runtime registry at the current revision (NN-DATA-013,
 *      NN-IDENT-004). The post-retirement runtime count MUST equal the
 *      registry-derived count; any mismatch blocks (V-IDENT-001/
 *      runtime-count-postretirement).
 *   2. SINGLE WATCHER OWNER ({@link resolveWatcherOwnership}) — exactly ONE
 *      owner may own a watched data class; a second/duplicate owner blocks the
 *      retirement of the duplicate until it is a bounded read consumer
 *      (NN-INDEX-001, NN-INV-008; V-INDEX-001/single-watcher-owner).
 *   3. CAPABILITY TRUTH ({@link reconcileCatalogAvailability}) — a static
 *      whitelist entry that advertises a catalog-only id as `available`
 *      (a false success) blocks removal until the whitelist defers to the
 *      registry-derived availability (NN-INV-014, CD-014;
 *      FIX-CATALOG-ASSIGNMENT-01).
 *   4. SUCCESS-STUB TRUTH ({@link classifyOptionalStub}) — a success-shaped
 *      optional stub that reports success/ready while its capability is
 *      unavailable blocks removal; a stub must be CONVERTED to a typed
 *      unavailable record or REMOVED, never left returning false success
 *      (NN-INV-014).
 *
 * The per-path cascade ({@link evaluatePathRetirement}) folds all four checks
 * PLUS a reachability/package check PLUS the 8.1 inventory clearance. A removal
 * is authorized IFF: the 8.1 item is cleared, no shipped inert path remains, the
 * count parity holds, the watcher owner is single, no catalog-only id is falsely
 * advertised available, no success-shaped stub remains, and every import the
 * removal touches still resolves (an unresolved import blocks — no dangling
 * reference is ever shipped). The batch driver ({@link runRetirementCascade})
 * authorizes a bulk removal ONLY when the inventory is non-empty and every path
 * is cleared.
 *
 * Design anchors: D-04 (channel/index architecture), D-05 (components), D-20
 * (migration & compatibility), D-24 (risks). Requirements: NN-DATA-013,
 * NN-IDENT-004, NN-INDEX-001, NN-INV-008, NN-INV-014, NN-OPS-010.
 */

import type { CapabilityStatus } from '../shared/capability-registry.js';
import type { EvidenceService } from '../shared/evidence-observability.js';
import {
  evaluateRetirementItem,
  type RetirementItem,
  type RetirementVerdict,
  type Disposition,
} from './retirement-inventory.js';

/** The owner id stamped on this gate's findings/telemetry. */
export const RETIREMENT_T005_OWNER = 'authority-static-catalog-retirement';

// ════════════════════════════════════════════════════════════════════════════
// 1. Count parity — replace a static/historic total with a registry-derived one
// ════════════════════════════════════════════════════════════════════════════

/**
 * Historic/static totals that were once shipped as live application constants
 * and MUST NOT be reintroduced (NN-IDENT-004). Present only so a static total
 * that happens to equal one of these can be named in a finding — the parity
 * check itself compares the static total to the registry-derived count, not to
 * this set.
 */
export const FORBIDDEN_STATIC_TOTALS: readonly number[] = Object.freeze([
  83, 109, 110, 118, 198, 230, 300, 537, 77,
]);

/** The outcome of comparing a static/declared total to the registry-derived count. */
export interface CountParityResult {
  /** The count computed from the owning runtime registry at the current revision. */
  readonly registryDerived: number;
  /** The static/declared total the retirement replaces (a historic constant). */
  readonly staticTotal: number;
  /** True IFF the static total exactly equals the registry-derived count. */
  readonly parity: boolean;
  /** True IFF the static total is one of the forbidden historic constants. */
  readonly staticIsForbiddenConstant: boolean;
  /** A human-safe explanation (never a private path or secret). */
  readonly detail: string;
}

/**
 * Compare a static/declared total against the count DERIVED from the owning
 * runtime registry (NN-DATA-013, NN-IDENT-004). Pure and total. Parity holds
 * IFF the two are exactly equal; a mismatch means the static total is stale and
 * removing it would drop or invent capability, so the caller MUST block. This
 * never treats the registry-derived count as authoritative-because-equal to a
 * historic constant — it is authoritative because it is computed from the
 * registry; the historic-constant flag is diagnostic only.
 */
export function compareRuntimeCount(
  staticTotal: number,
  registryDerived: number,
): CountParityResult {
  const parity = Number.isInteger(staticTotal) && staticTotal === registryDerived;
  const staticIsForbiddenConstant = FORBIDDEN_STATIC_TOTALS.includes(staticTotal);
  const detail = parity
    ? `Static total ${staticTotal} equals the registry-derived count ${registryDerived}; the static total may be replaced by the registry query.`
    : `Static total ${staticTotal} does not equal the registry-derived count ${registryDerived}; removing the static total would change capability (count mismatch).`;
  return Object.freeze({
    registryDerived,
    staticTotal,
    parity,
    staticIsForbiddenConstant,
    detail,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Single watcher owner — one owner per watched data class (NN-INDEX-001)
// ════════════════════════════════════════════════════════════════════════════

/** A recorded watcher over a data class (e.g. the workspace file tree). */
export interface WatcherOwnerClaim {
  /** The owner authority id. */
  readonly ownerId: string;
  /**
   * Whether this owner is the SINGLE authoritative coordinator (true) or a
   * bounded READ CONSUMER routed through it (false). A bounded read consumer is
   * NOT a competing owner and never blocks single-owner resolution.
   */
  readonly authoritative: boolean;
  /** Human-safe surface this claim covers. */
  readonly surface: string;
}

/** The result of resolving watcher ownership for one data class. */
export interface WatcherOwnershipResult {
  readonly dataClass: string;
  /** The single authoritative owner id, or `undefined` if none/ambiguous. */
  readonly owner: string | undefined;
  /** True IFF exactly one authoritative owner exists. */
  readonly singleOwner: boolean;
  /** The ids of any additional authoritative (competing) owners. */
  readonly duplicateOwners: readonly string[];
  readonly detail: string;
}

/**
 * Resolve whether exactly ONE authoritative owner owns a watched data class
 * (NN-INDEX-001, NN-INV-008). Bounded read consumers are allowed and ignored.
 * Fail-closed: zero authoritative owners OR more than one authoritative owner
 * yields `singleOwner: false` (a duplicate watcher owner blocks retirement of
 * the duplicate until it becomes a bounded read consumer). Deterministic: the
 * winning owner and any duplicates are reported in claim order.
 */
export function resolveWatcherOwnership(
  dataClass: string,
  claims: readonly WatcherOwnerClaim[],
): WatcherOwnershipResult {
  const authoritative = claims.filter((c) => c.authoritative && c.ownerId.trim().length > 0);
  const distinct: string[] = [];
  for (const c of authoritative) {
    if (!distinct.includes(c.ownerId)) distinct.push(c.ownerId);
  }
  const singleOwner = distinct.length === 1;
  const owner = singleOwner ? distinct[0] : undefined;
  const duplicateOwners = singleOwner ? [] : distinct.slice(singleOwner ? 1 : 0);
  const detail = singleOwner
    ? `Data class '${dataClass}' has a single authoritative owner '${owner}'; competing watchers are bounded read consumers.`
    : distinct.length === 0
      ? `Data class '${dataClass}' has no recorded authoritative owner.`
      : `Data class '${dataClass}' has ${distinct.length} competing authoritative owners: ${distinct.join(', ')}.`;
  return Object.freeze({
    dataClass,
    owner,
    singleOwner,
    duplicateOwners: Object.freeze(duplicateOwners),
    detail,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Capability truth — reconcile a static whitelist against the registry
//    (CD-014 resolution: catalog-only ids must not be advertised available)
// ════════════════════════════════════════════════════════════════════════════

/** One entry in a static availability whitelist (e.g. an adapter's declared status). */
export interface StaticAvailabilityEntry {
  readonly id: string;
  /** The status the STATIC surface declares (may be a false success). */
  readonly declaredAvailable: boolean;
}

/** One entry of registry-derived truth (the canonical single source). */
export interface RegistryAvailabilityEntry {
  readonly id: string;
  /** Whether the registry says this id is a REAL, connectable capability. */
  readonly registryAvailable: boolean;
}

/** A single divergence between the static whitelist and the registry. */
export interface AvailabilityDivergence {
  readonly id: string;
  readonly declaredAvailable: boolean;
  readonly registryAvailable: boolean;
  /**
   * `false-available` — the static surface advertises a catalog-only id as
   *   available (a false success); this is the CD-014 defect and blocks removal.
   * `false-unavailable` — the static surface hides a real capability; also a
   *   defect (lost capability) and blocks removal.
   * `unknown-id` — the static surface names an id absent from the registry
   *   (an orphan reference).
   */
  readonly kind: 'false-available' | 'false-unavailable' | 'unknown-id';
}

/** The reconciliation of a static whitelist against the registry-derived truth. */
export interface CatalogReconciliation {
  /** True IFF the static whitelist matches the registry-derived truth exactly. */
  readonly consistent: boolean;
  /** Registry-derived count of available ids (the authoritative available total). */
  readonly registryAvailableCount: number;
  /** The static whitelist's count of declared-available ids. */
  readonly declaredAvailableCount: number;
  /** Every divergence, in registry order then extra static ids. */
  readonly divergences: readonly AvailabilityDivergence[];
  readonly detail: string;
}

/**
 * Reconcile a static availability whitelist against the registry-derived truth
 * (NN-INV-014, CD-014). The registry is the single source of truth; the static
 * whitelist must DEFER to it. Fail-closed: ANY divergence (a false-available
 * catalog-only id, a false-unavailable real id, or an unknown id) makes the
 * reconciliation inconsistent and blocks removal. Pure and total; the available
 * total returned is ALWAYS the registry-derived count, never the static one.
 */
export function reconcileCatalogAvailability(
  staticWhitelist: readonly StaticAvailabilityEntry[],
  registry: readonly RegistryAvailabilityEntry[],
): CatalogReconciliation {
  const registryById = new Map(registry.map((e) => [e.id, e.registryAvailable]));
  const staticById = new Map(staticWhitelist.map((e) => [e.id, e.declaredAvailable]));
  const divergences: AvailabilityDivergence[] = [];

  for (const entry of registry) {
    const declared = staticById.get(entry.id);
    if (declared === undefined) continue; // whitelist need not cover every id.
    if (declared && !entry.registryAvailable) {
      divergences.push({
        id: entry.id,
        declaredAvailable: true,
        registryAvailable: false,
        kind: 'false-available',
      });
    } else if (!declared && entry.registryAvailable) {
      divergences.push({
        id: entry.id,
        declaredAvailable: false,
        registryAvailable: true,
        kind: 'false-unavailable',
      });
    }
  }
  for (const entry of staticWhitelist) {
    if (!registryById.has(entry.id)) {
      divergences.push({
        id: entry.id,
        declaredAvailable: entry.declaredAvailable,
        registryAvailable: false,
        kind: 'unknown-id',
      });
    }
  }

  const registryAvailableCount = registry.filter((e) => e.registryAvailable).length;
  const declaredAvailableCount = staticWhitelist.filter((e) => e.declaredAvailable).length;
  const consistent = divergences.length === 0;
  const detail = consistent
    ? `Static whitelist defers to the registry: ${registryAvailableCount} available id(s) match the registry-derived truth.`
    : `Static whitelist diverges from the registry in ${divergences.length} id(s): ${divergences
        .map((d) => `${d.id}:${d.kind}`)
        .join(', ')}.`;

  return Object.freeze({
    consistent,
    registryAvailableCount,
    declaredAvailableCount,
    divergences: Object.freeze(divergences),
    detail,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Success-stub truth — convert/remove success-shaped optional stubs
// ════════════════════════════════════════════════════════════════════════════

/** A description of an optional stub's runtime behavior. */
export interface OptionalStubBehavior {
  readonly id: string;
  /** Whether the underlying capability is actually available at runtime. */
  readonly capabilityAvailable: boolean;
  /** Whether the stub's calls resolve as success/ready (vs. a typed unavailable). */
  readonly reportsSuccess: boolean;
}

/** How an optional stub must be treated during retirement. */
export type StubTreatment =
  | 'ok-unavailable' // typed unavailable while capability is off — honest, may remove/keep.
  | 'ok-available' // reports success and the capability is genuinely available — honest.
  | 'false-success'; // reports success while unavailable — a LIE; blocks removal.

/** The classification of a success-shaped optional stub. */
export interface StubClassification {
  readonly id: string;
  readonly treatment: StubTreatment;
  /** True IFF the stub is honest (never a false success). */
  readonly honest: boolean;
  readonly detail: string;
}

/**
 * Classify an optional stub's behavior (NN-INV-014 "catalog-only future
 * capabilities SHALL be visibly unavailable and SHALL never return success").
 * Pure and total. Fail-closed: a stub that reports success while its capability
 * is unavailable is a FALSE SUCCESS and is dishonest — it must be CONVERTED to a
 * typed unavailable record or REMOVED before its removal can be authorized.
 */
export function classifyOptionalStub(stub: OptionalStubBehavior): StubClassification {
  let treatment: StubTreatment;
  if (!stub.capabilityAvailable && stub.reportsSuccess) {
    treatment = 'false-success';
  } else if (stub.capabilityAvailable && stub.reportsSuccess) {
    treatment = 'ok-available';
  } else {
    treatment = 'ok-unavailable';
  }
  const honest = treatment !== 'false-success';
  const detail = honest
    ? `Stub '${stub.id}' is honest (${treatment}); no false success.`
    : `Stub '${stub.id}' reports success while its capability is unavailable (false success); it must be converted to a typed unavailable record or removed.`;
  return Object.freeze({ id: stub.id, treatment, honest, detail });
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Per-path WIRE|MIGRATE|QUARANTINE|REMOVE cascade with reachability/package
// ════════════════════════════════════════════════════════════════════════════

/**
 * The independent block reasons a path's retirement can carry. Mirrors the four
 * fail-closed triggers plus the inventory clearance and the import/package
 * check.
 */
export type PathBlockKind =
  | 'inventory' // the 8.1 RetirementInventory item is not cleared for removal.
  | 'count-mismatch' // a static total does not equal the registry-derived count.
  | 'duplicate-watcher' // more than one authoritative watcher owner remains.
  | 'false-available' // a catalog-only id is advertised available (CD-014).
  | 'false-success' // a success-shaped stub reports success while unavailable.
  | 'unresolved-import' // removal would leave a dangling/unresolved import.
  | 'inert-path'; // a shipped path would remain inert (unreachable but present).

/** A structured, human-safe reason a path's retirement is blocked. */
export interface PathBlockReason {
  readonly kind: PathBlockKind;
  readonly detail: string;
}

/**
 * The per-path retirement inputs. `dispositionPlan` is the recorded NN-OPS-010
 * verb; only `REMOVE` authorizes deletion (and only after every gate passes).
 * The optional checks are omitted when they do not apply to a path (e.g. a
 * duplicate-writer path has no catalog reconciliation).
 */
export interface PathRetirementInput {
  /** Human-safe path/surface (never a private absolute path). */
  readonly path: string;
  /** The recorded disposition for this path (NN-OPS-010). */
  readonly dispositionPlan: Disposition;
  /** The 8.1 inventory item that must clear before this path may be removed. */
  readonly inventoryItem: RetirementItem;
  /**
   * Whether every import/reference the removal touches still resolves after the
   * removal. `false` means the removal would leave an unresolved import — a
   * dangling reference — and blocks (fail-closed on unknown => callers pass an
   * explicit boolean).
   */
  readonly importsResolve: boolean;
  /**
   * Whether the path would remain a SHIPPED but UNREACHABLE (inert) path after
   * the cascade. `true` blocks removal (NN-INV-014 no shipped inert path).
   */
  readonly leavesInertPath: boolean;
  /** Optional count-parity check that applies to this path. */
  readonly countParity?: CountParityResult;
  /** Optional watcher-ownership resolution that applies to this path. */
  readonly watcher?: WatcherOwnershipResult;
  /** Optional catalog reconciliation (the CD-014 channel whitelist). */
  readonly catalog?: CatalogReconciliation;
  /** Optional success-stub classifications that apply to this path. */
  readonly stubs?: readonly StubClassification[];
}

/** The retirement verdict for ONE path. */
export interface PathRetirementVerdict {
  readonly path: string;
  readonly dispositionPlan: Disposition;
  /** The 8.1 inventory verdict, reused verbatim (never re-derived). */
  readonly inventoryVerdict: RetirementVerdict;
  /** True IFF the removal of this path is authorized. */
  readonly clearedForRemoval: boolean;
  /** The candidate's ladder status (never the core's). */
  readonly status: CapabilityStatus;
  /** Every independent reason removal is blocked (empty iff cleared). */
  readonly blockReasons: readonly PathBlockReason[];
  /** ALWAYS true: no retirement outcome changes core readiness (NN-INV-014). */
  readonly coreReadinessUnchanged: true;
}

/**
 * Evaluate the fail-closed per-path retirement cascade. Pure and total over its
 * input and the observer evidence store — NO writes, NO throws. It reuses the
 * 8.1 {@link evaluateRetirementItem} verdict verbatim (the six deletion
 * prerequisites are NOT re-implemented here) and adds the T-005 checks. A path
 * is cleared for removal IFF ALL of:
 *
 *   - its `dispositionPlan` is `REMOVE`;
 *   - the 8.1 inventory item is cleared for deletion;
 *   - imports still resolve after removal (no unresolved import);
 *   - no shipped inert path remains;
 *   - any count-parity check holds (no count mismatch);
 *   - any watcher resolution is single-owner (no duplicate watcher);
 *   - any catalog reconciliation is consistent (no false-available / CD-014);
 *   - no success-shaped stub reports a false success.
 *
 * Every unmet condition contributes an independent block reason.
 */
export function evaluatePathRetirement(
  input: PathRetirementInput,
  evidence: EvidenceService,
): PathRetirementVerdict {
  const blockReasons: PathBlockReason[] = [];

  const inventoryVerdict = evaluateRetirementItem(input.inventoryItem, evidence);
  if (!inventoryVerdict.clearedForDeletion) {
    const first = inventoryVerdict.blockReasons[0];
    blockReasons.push({
      kind: 'inventory',
      detail: `8.1 inventory item '${input.inventoryItem.itemId}' is not cleared for deletion${
        first ? ` (${first.prerequisite}: ${first.detail})` : ''
      }.`,
    });
  }

  if (!input.importsResolve) {
    blockReasons.push({
      kind: 'unresolved-import',
      detail: `Removing '${input.path}' would leave an unresolved import (dangling reference); removal blocked.`,
    });
  }

  if (input.leavesInertPath) {
    blockReasons.push({
      kind: 'inert-path',
      detail: `'${input.path}' would remain a shipped but unreachable (inert) path; removal blocked (NN-INV-014).`,
    });
  }

  if (input.countParity && !input.countParity.parity) {
    blockReasons.push({ kind: 'count-mismatch', detail: input.countParity.detail });
  }

  if (input.watcher && !input.watcher.singleOwner) {
    blockReasons.push({ kind: 'duplicate-watcher', detail: input.watcher.detail });
  }

  if (input.catalog && !input.catalog.consistent) {
    // A false-available divergence is the CD-014 defect; any other divergence
    // (a hidden real capability or an orphan id) is likewise a shipped-inert /
    // capability-truth defect. Both block removal; we surface the CD-014 kind.
    blockReasons.push({
      kind: 'false-available',
      detail: input.catalog.detail,
    });
  }

  if (input.stubs) {
    for (const s of input.stubs) {
      if (!s.honest) {
        blockReasons.push({ kind: 'false-success', detail: s.detail });
      }
    }
  }

  const dispositionAllowsRemoval = input.dispositionPlan === 'REMOVE';
  const clearedForRemoval = dispositionAllowsRemoval && blockReasons.length === 0;

  const status: CapabilityStatus = clearedForRemoval
    ? 'ready'
    : input.leavesInertPath
      ? 'unavailable'
      : 'blocked';

  return Object.freeze({
    path: input.path,
    dispositionPlan: input.dispositionPlan,
    inventoryVerdict,
    clearedForRemoval,
    status,
    blockReasons: Object.freeze(blockReasons),
    coreReadinessUnchanged: true as const,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Batch cascade driver — no bulk removal from an incomplete cascade
// ════════════════════════════════════════════════════════════════════════════

/** The result of running the retirement cascade over a set of paths. */
export interface RetirementCascadeResult {
  readonly verdicts: readonly PathRetirementVerdict[];
  /** Paths cleared for removal (fully gated). */
  readonly cleared: readonly string[];
  /** Paths kept installed-but-non-authoritative (removal blocked). */
  readonly blocked: readonly string[];
  readonly coreReadinessUnchanged: true;
}

/**
 * Run the per-path cascade over a set of paths (the retirement trigger).
 * Deterministic: verdicts are sorted by path. The generated findings and the
 * evidence graph are observers; NO deletion is performed here.
 */
export function runRetirementCascade(
  inputs: readonly PathRetirementInput[],
  evidence: EvidenceService,
): RetirementCascadeResult {
  const verdicts = [...inputs]
    .map((i) => evaluatePathRetirement(i, evidence))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const cleared = verdicts.filter((v) => v.clearedForRemoval).map((v) => v.path);
  const blocked = verdicts.filter((v) => !v.clearedForRemoval).map((v) => v.path);
  return Object.freeze({
    verdicts: Object.freeze(verdicts),
    cleared: Object.freeze(cleared),
    blocked: Object.freeze(blocked),
    coreReadinessUnchanged: true as const,
  });
}

/**
 * Whether a bulk removal may proceed. Fail-closed: authorized ONLY when the
 * cascade is non-empty AND every path is cleared. An incomplete cascade (any
 * blocked path) authorizes NO bulk removal — nothing is removed in dependency
 * order until zero-use/parity holds for ALL of it (the task Migration rule).
 */
export function bulkRemovalAuthorized(result: RetirementCascadeResult): boolean {
  return result.verdicts.length > 0 && result.blocked.length === 0;
}
