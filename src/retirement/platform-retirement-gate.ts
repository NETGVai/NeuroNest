/**
 * Platform / Update Alias, Legacy Webview, and Optional Adapter RETIREMENT gate
 * (FUT-PKG-09-RETIREMENT/T-006).
 *
 * This module is the FAIL-CLOSED evaluator for the P8 retirement matrix that
 * removes EXPIRED platform/update aliases, a legacy guest webview, and disposed
 * optional adapters. It DELETES NOTHING and OWNS NO durable state: it is a pure
 * OBSERVER that renders a per-target verdict. Every actual removal is performed
 * by the leaf only after this gate — and the 8.1 RetirementInventory gate it
 * composes — CLEAR the target. An unsupported architecture, required legacy
 * use, a security regression, or a failed restore keeps the target INSTALLED
 * and BLOCKS retirement (the task Acceptance, verbatim).
 *
 * It does NOT create parallel truth. It BUILDS ON the established authorities:
 *
 *   - The 8.1 RetirementInventory deletion gate
 *     (src/retirement/retirement-inventory.ts `evaluateRetirementItem`): the
 *     six independent prerequisites (use/data/owner/reachability/parity/
 *     rollback) MUST clear first. This module NEVER re-implements them; it
 *     requires a cleared inventory verdict as the base of every retirement.
 *   - The Platform/Capability Registry + package resolver (SECURITY T-001,
 *     src/shared/capability-registry.ts `Architecture`/`canonicalArchitecture`):
 *     exact package/update identity means the removal's replacement is SIGNED,
 *     on a SUPPORTED architecture, and the CANONICAL target is what selection
 *     resolves for a retired alias (NN-PLATFORM-003/004, NN-COMPAT-011).
 *   - The webview/guest security authority (SECURITY T-005,
 *     src/main/security/window-hardener.ts `validateWebviewGuestPolicy`): a
 *     legacy webview retirement is DISABLEMENT. A security regression on the
 *     guest can NEVER be resolved by (insecure) re-enablement; rollback of a
 *     webview retirement is disablement only (NN-SEC-017, CD-024).
 *   - The 7.7 Optional Capability release gate (src/optional/
 *     optional-capability-gate.ts `evaluateCapabilityGate`): an optional
 *     adapter may be DISPOSED only when the optional gate has WITHDRAWN its
 *     advertisement (it is not advertising) — a still-advertised adapter is a
 *     live capability and must not be disposed (NN-PLATFORM-007).
 *
 * Trust posture (the task Acceptance): "Trigger is platform/update/webview/
 * adapter retirement matrix; Capability Registry/package resolver is observer;
 * expected is canonical target selection and disabled/removed obsolete
 * capability; unsupported architecture, required legacy use, security
 * regression, or failed restore blocks retirement." Every one of those blocking
 * conditions is enforced here, and each is independent so the verdict reports
 * EVERY reason, not just the first.
 *
 * Rollout / rollback (the task Migration): respect the declared alias support
 * window (retire an alias only AFTER the window expires AND telemetry shows
 * zero required legacy use). Rollback restores a SIGNED, COMPATIBLE alias or
 * adapter ONLY; a legacy webview rollback is DISABLEMENT, never insecure
 * enablement. Core readiness is never changed by any retirement outcome
 * (NN-INV-014, D-24).
 *
 * Design anchors: D-16 (browser/webview), D-17 (portability capability matrix),
 * D-20 (migration & compatibility plan), D-23 (phased rollout/rollback).
 * Requirements: NN-PLATFORM-003/004/007, NN-SEC-017, NN-COMPAT-003/011,
 * NN-INV-014.
 */

import {
  type Architecture,
  type CapabilityStatus,
  isArchitecture,
} from '../shared/capability-registry.js';
import { type EvidenceService } from '../shared/evidence-observability.js';
import { type WebviewGuestPolicy } from '../main/security/window-hardener.js';
import {
  evaluateRetirementItem,
  type RetirementItem,
  type RetirementVerdict,
} from './retirement-inventory.js';
import {
  evaluateCapabilityGate,
  type CapabilityGateInput,
  type CapabilityGateVerdict,
} from '../optional/optional-capability-gate.js';

// ─── Retirement matrix targets (the task Trigger) ────────────────────────────

/**
 * The kinds of target the platform/update/webview/adapter retirement matrix
 * removes. Each maps onto a distinct extra gate layered ON TOP of the shared
 * 8.1 inventory clearance:
 *
 *   - `platform-alias` / `update-alias` — an expired resolution alias (e.g.
 *     `macos-arm64`/`macos-intel`, or a legacy platform-specific update field)
 *     whose canonical target must be selected and whose support window must
 *     have expired with zero required legacy use (NN-PLATFORM-003/004,
 *     NN-COMPAT-011).
 *   - `legacy-webview` — the legacy guest webview surface, retired by
 *     DISABLEMENT (NN-SEC-017).
 *   - `optional-adapter` — an optional adapter disposed after the 7.7 gate has
 *     withdrawn its advertisement (NN-PLATFORM-007).
 */
export const RETIREMENT_TARGET_KINDS = Object.freeze([
  'platform-alias',
  'update-alias',
  'legacy-webview',
  'optional-adapter',
] as const);
export type RetirementTargetKind = (typeof RETIREMENT_TARGET_KINDS)[number];

/** Whether a value is a known retirement-target kind. */
export function isRetirementTargetKind(
  value: unknown,
): value is RetirementTargetKind {
  return (
    typeof value === 'string' &&
    (RETIREMENT_TARGET_KINDS as readonly string[]).includes(value)
  );
}

// ─── Exact package / update identity (SECURITY T-001, NN-COMPAT-011) ─────────

/**
 * The identity a replacement package/update must present for a retirement to be
 * cleared. Rollback likewise restores only a SIGNED, COMPATIBLE alias/adapter,
 * so the same descriptor gates a rollback restore. Fail-closed on every field:
 *
 *   - `signed` MUST be true (an unsigned replacement blocks — no unsigned
 *     package/update identity, NN-COMPAT-011).
 *   - `architecture` MUST be a known {@link Architecture} the running host
 *     supports; an unsupported/unknown architecture BLOCKS retirement (the task
 *     Acceptance).
 *   - `canonicalTargetSelected` MUST be true — selection for a retired alias
 *     resolves the CANONICAL target, not the retired alias itself
 *     (NN-PLATFORM-004 canonical-first resolution).
 */
export interface PackageIdentity {
  /** Whether the replacement package/update is signed (and, for macOS, notarized). */
  readonly signed: boolean;
  /** The replacement's target architecture (must be host-supported). */
  readonly architecture: Architecture | string;
  /** Whether selection resolves the canonical target for the retired alias. */
  readonly canonicalTargetSelected: boolean;
}

/**
 * A webview retirement descriptor (NN-SEC-017). A webview is retired by
 * DISABLEMENT. `securityRegression` records whether an active guest security
 * regression exists; if so, retirement (and any rollback) may ONLY disable —
 * never re-enable. `rollbackReEnablesGuest` records whether the proposed
 * rollback would (insecurely) re-enable the guest: it MUST be false, because a
 * webview rollback is disablement only.
 */
export interface WebviewRetirement {
  /** Whether the retirement action disables the guest (must be true). */
  readonly disablesGuest: boolean;
  /** Whether an active guest security regression has been observed. */
  readonly securityRegression: boolean;
  /**
   * The guest policy that a rollback would restore, if any. A webview rollback
   * is disablement, so a rollback MUST NOT restore an enabled guest: this is
   * used only to reject an insecure re-enable (see {@link rollbackReEnablesGuest}).
   */
  readonly rollbackGuestPolicy?: WebviewGuestPolicy | null;
  /** Whether the proposed rollback re-enables the guest (must be false). */
  readonly rollbackReEnablesGuest: boolean;
}

// ─── The per-target retirement input ─────────────────────────────────────────

/**
 * The input for ONE retirement-matrix target. The `inventoryItem` is the shared
 * 8.1 candidate whose six prerequisites this gate composes; the extra fields
 * layer the target-specific gate (identity / webview / optional). Only the
 * field(s) relevant to `kind` are consulted:
 *
 *   - `platform-alias` / `update-alias` -> `identity` (signed + supported arch
 *     + canonical target selected).
 *   - `legacy-webview` -> `webview` (disablement, no security regression, no
 *     insecure rollback re-enable).
 *   - `optional-adapter` -> `optionalGate` (the 7.7 gate input; the adapter must
 *     be WITHDRAWN, i.e. not advertising).
 */
export interface RetirementTarget {
  /** Stable target id, e.g. `alias:macos-arm64`, `webview:legacy-guest`. */
  readonly targetId: string;
  readonly kind: RetirementTargetKind;
  /** The shared 8.1 inventory candidate (its clearance is the base gate). */
  readonly inventoryItem: RetirementItem;
  /** Set of architectures the running host supports (for identity checks). */
  readonly supportedArchitectures?: readonly Architecture[];
  /** Exact package/update identity (platform/update alias retirements). */
  readonly identity?: PackageIdentity;
  /** Webview disablement descriptor (legacy-webview retirements). */
  readonly webview?: WebviewRetirement;
  /** The 7.7 optional-capability gate input (optional-adapter retirements). */
  readonly optionalGate?: CapabilityGateInput;
}

/** Which extra gate blocked a retirement (beyond the shared inventory gate). */
export type RetirementGateBlock =
  | 'inventory'
  | 'unsupported-architecture'
  | 'unsigned-package'
  | 'non-canonical-target'
  | 'security-regression'
  | 'webview-not-disabled'
  | 'insecure-rollback-reenable'
  | 'adapter-still-advertised'
  | 'missing-target-input';

/** A structured, human-safe reason a retirement is blocked. */
export interface RetirementBlockReason {
  readonly gate: RetirementGateBlock;
  readonly detail: string;
}

/**
 * The verdict for ONE retirement-matrix target. `clearedForRetirement` is the
 * single fail-closed decision. `installedRetained` is its complement: whenever
 * retirement is blocked the target stays installed (for a webview, that means
 * it stays DISABLED-but-not-removed; never insecurely re-enabled).
 * `inventoryVerdict` is the composed 8.1 clearance. `status` is the D-19.4
 * ladder position of the CANDIDATE (never the core). `coreReadinessUnchanged`
 * is ALWAYS true (NN-INV-014, D-24).
 */
export interface RetirementGateVerdict {
  readonly targetId: string;
  readonly kind: RetirementTargetKind;
  readonly clearedForRetirement: boolean;
  readonly installedRetained: boolean;
  readonly status: CapabilityStatus;
  /** The composed 8.1 inventory clearance for this target. */
  readonly inventoryVerdict: RetirementVerdict;
  /** The composed 7.7 optional-gate verdict (optional-adapter only). */
  readonly optionalVerdict?: CapabilityGateVerdict;
  /** Every independent reason retirement is blocked (empty iff cleared). */
  readonly blockReasons: readonly RetirementBlockReason[];
  readonly coreReadinessUnchanged: true;
}

/**
 * Evaluate the fail-closed retirement gate for ONE matrix target. Pure and
 * total over its input and the observer evidence store — NO writes, NO throws.
 * All gates are evaluated so the verdict reports EVERY unmet condition.
 *
 * A target is cleared for retirement IFF:
 *   (base) its shared 8.1 inventory item is cleared for deletion, AND
 *   (extra, per kind)
 *     - platform/update alias: the replacement is signed, on a host-supported
 *       architecture, and the canonical target is selected;
 *     - legacy webview: the action disables the guest, there is NO active
 *       security regression, and the rollback does NOT re-enable the guest;
 *     - optional adapter: the 7.7 gate has WITHDRAWN advertisement (the adapter
 *       is not advertising).
 * Anything else keeps the target installed and BLOCKS retirement.
 */
export function evaluateRetirementTarget(
  target: RetirementTarget,
  evidence: EvidenceService,
): RetirementGateVerdict {
  const blockReasons: RetirementBlockReason[] = [];

  // ── Base gate: the shared 8.1 inventory clearance MUST hold. ──────────────
  const inventoryVerdict = evaluateRetirementItem(target.inventoryItem, evidence);
  if (!inventoryVerdict.clearedForDeletion) {
    blockReasons.push({
      gate: 'inventory',
      detail: `${target.targetId} is not cleared by the retirement inventory: ${inventoryVerdict.blockReasons
        .map((r) => r.prerequisite)
        .join(', ')}.`,
    });
  }

  // ── Extra, kind-specific gate. ────────────────────────────────────────────
  let optionalVerdict: CapabilityGateVerdict | undefined;
  switch (target.kind) {
    case 'platform-alias':
    case 'update-alias': {
      evaluatePackageIdentity(target, blockReasons);
      break;
    }
    case 'legacy-webview': {
      evaluateWebviewRetirement(target, blockReasons);
      break;
    }
    case 'optional-adapter': {
      optionalVerdict = evaluateOptionalAdapterDisposal(target, evidence, blockReasons);
      break;
    }
  }

  const clearedForRetirement = blockReasons.length === 0;
  const status = deriveTargetStatus(
    clearedForRetirement,
    inventoryVerdict,
    blockReasons,
  );

  return Object.freeze({
    targetId: target.targetId,
    kind: target.kind,
    clearedForRetirement,
    installedRetained: !clearedForRetirement,
    status,
    inventoryVerdict,
    ...(optionalVerdict ? { optionalVerdict } : {}),
    blockReasons: Object.freeze(blockReasons),
    coreReadinessUnchanged: true as const,
  });
}

/**
 * Exact package/update identity gate (SECURITY T-001, NN-PLATFORM-003/004,
 * NN-COMPAT-011). The replacement must be signed, on a host-supported
 * architecture, and resolve the CANONICAL target for the retired alias. A
 * missing identity descriptor is a fail-closed block (no identity => no proof).
 */
function evaluatePackageIdentity(
  target: RetirementTarget,
  blockReasons: RetirementBlockReason[],
): void {
  const identity = target.identity;
  if (!identity) {
    blockReasons.push({
      gate: 'missing-target-input',
      detail: `${target.targetId} is a ${target.kind} but carries no package/update identity to verify.`,
    });
    return;
  }

  if (!identity.signed) {
    blockReasons.push({
      gate: 'unsigned-package',
      detail: `${target.targetId} replacement package/update is not signed; unsigned identity blocks retirement.`,
    });
  }

  const supported = target.supportedArchitectures ?? [];
  const archSupported =
    isArchitecture(identity.architecture) &&
    supported.includes(identity.architecture);
  if (!archSupported) {
    blockReasons.push({
      gate: 'unsupported-architecture',
      detail: `${target.targetId} replacement targets architecture "${identity.architecture}", which the host does not support; unsupported architecture blocks retirement.`,
    });
  }

  if (!identity.canonicalTargetSelected) {
    blockReasons.push({
      gate: 'non-canonical-target',
      detail: `${target.targetId} selection does not resolve the canonical target for the retired alias; replacement-flow parity requires canonical target selection.`,
    });
  }
}

/**
 * Legacy webview retirement gate (SECURITY T-005, NN-SEC-017, CD-024). A
 * webview retirement is DISABLEMENT: the action must disable the guest, there
 * must be NO active security regression left unresolved by disablement, and the
 * rollback must NOT re-enable the guest (a webview rollback is disablement, not
 * insecure enablement). A missing webview descriptor is a fail-closed block.
 * When a rollback guest policy is supplied it must itself be complete/valid —
 * an incomplete policy can never be the target of an (already-rejected)
 * re-enable, so it is folded into the re-enable guard.
 */
function evaluateWebviewRetirement(
  target: RetirementTarget,
  blockReasons: RetirementBlockReason[],
): void {
  const webview = target.webview;
  if (!webview) {
    blockReasons.push({
      gate: 'missing-target-input',
      detail: `${target.targetId} is a legacy-webview retirement but carries no disablement descriptor.`,
    });
    return;
  }

  if (!webview.disablesGuest) {
    blockReasons.push({
      gate: 'webview-not-disabled',
      detail: `${target.targetId} retirement does not disable the legacy guest; a webview is retired by disablement only.`,
    });
  }

  if (webview.securityRegression) {
    blockReasons.push({
      gate: 'security-regression',
      detail: `${target.targetId} has an active guest security regression; it must stay disabled and can never be resolved by re-enablement.`,
    });
  }

  // A webview rollback is DISABLEMENT, never insecure enablement. Any proposed
  // rollback that re-enables the guest is refused outright. We also treat a
  // supplied-but-incomplete rollback guest policy as an attempted re-enable
  // signal, since the only reason to carry a guest policy on a retirement
  // rollback is to bring the guest back — which is never permitted.
  const suppliedRollbackPolicy = webview.rollbackGuestPolicy != null;
  if (webview.rollbackReEnablesGuest || suppliedRollbackPolicy) {
    blockReasons.push({
      gate: 'insecure-rollback-reenable',
      detail: `${target.targetId} rollback would re-enable the legacy guest; a webview rollback is disablement, never insecure enablement.`,
    });
  }
}

/**
 * Optional adapter disposal gate (7.7 / OPTIONAL T-007, NN-PLATFORM-007). The
 * adapter may be disposed only when the 7.7 optional-capability gate has
 * WITHDRAWN its advertisement — i.e. the gate verdict is NOT advertising. A
 * still-advertised adapter is a live capability and must be retained. A missing
 * optional-gate input is a fail-closed block. Returns the composed 7.7 verdict.
 */
function evaluateOptionalAdapterDisposal(
  target: RetirementTarget,
  evidence: EvidenceService,
  blockReasons: RetirementBlockReason[],
): CapabilityGateVerdict | undefined {
  const gateInput = target.optionalGate;
  if (!gateInput) {
    blockReasons.push({
      gate: 'missing-target-input',
      detail: `${target.targetId} is an optional-adapter retirement but carries no optional-capability gate input.`,
    });
    return undefined;
  }

  const optionalVerdict = evaluateCapabilityGate(gateInput, evidence);
  if (optionalVerdict.advertise) {
    blockReasons.push({
      gate: 'adapter-still-advertised',
      detail: `${target.targetId} optional adapter is still advertised (${optionalVerdict.capabilityId} status ${optionalVerdict.status}); a live capability must not be disposed.`,
    });
  }
  return optionalVerdict;
}

/**
 * Map the retirement decision onto the D-19.4 ladder for the CANDIDATE (never
 * the core). `ready` = cleared for removal; `unavailable` = proven-unreachable
 * (per the inventory) but still gated on an extra condition; `blocked` = a hard
 * gate is unmet with no proven-unreachable inventory signal.
 */
function deriveTargetStatus(
  cleared: boolean,
  inventoryVerdict: RetirementVerdict,
  blockReasons: readonly RetirementBlockReason[],
): CapabilityStatus {
  if (cleared) return 'ready';
  // If the shared inventory has proven the path unreachable (an inert path
  // pending its remaining gates), reflect that as `unavailable`; otherwise the
  // target is `blocked` on a hard prerequisite.
  if (
    inventoryVerdict.status === 'unavailable' &&
    !blockReasons.some((r) => r.gate === 'inventory')
  ) {
    return 'unavailable';
  }
  return 'blocked';
}

// ─── Batch review (the retirement matrix trigger) ────────────────────────────

/** The result of a full platform/update/webview/adapter retirement review. */
export interface RetirementMatrixResult {
  readonly verdicts: readonly RetirementGateVerdict[];
  /** Target ids cleared for retirement (fully evidenced + kind gate passed). */
  readonly cleared: readonly string[];
  /** Target ids kept installed/retained (retirement blocked). */
  readonly retained: readonly string[];
  /** Always true: no retirement verdict changes core readiness (NN-INV-014). */
  readonly coreReadinessUnchanged: true;
}

/**
 * Evaluate the gate over every retirement-matrix target (the "retirement
 * matrix" trigger). Deterministic: verdicts are returned sorted by target id.
 * The Capability Registry / package resolver and the evidence graph are
 * observers; NO removal is performed here.
 */
export function reviewRetirementMatrix(
  targets: readonly RetirementTarget[],
  evidence: EvidenceService,
): RetirementMatrixResult {
  const verdicts = [...targets]
    .map((target) => evaluateRetirementTarget(target, evidence))
    .sort((a, b) => (a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0));
  const cleared = verdicts.filter((v) => v.clearedForRetirement).map((v) => v.targetId);
  const retained = verdicts.filter((v) => !v.clearedForRetirement).map((v) => v.targetId);
  return Object.freeze({
    verdicts: Object.freeze(verdicts),
    cleared: Object.freeze(cleared),
    retained: Object.freeze(retained),
    coreReadinessUnchanged: true as const,
  });
}

/**
 * Whether the whole retirement matrix may proceed. Fail-closed: authorized ONLY
 * when the matrix is non-empty AND every target is cleared — no matrix-wide
 * retirement from an incomplete/blocked matrix (mirrors the 8.1 bulk-deletion
 * rule and the task Migration posture).
 */
export function retirementMatrixAuthorized(result: RetirementMatrixResult): boolean {
  return result.verdicts.length > 0 && result.retained.length === 0;
}

// ─── Rollback restore gate (signed, compatible only) ─────────────────────────

/**
 * Whether a rollback may RESTORE a retired alias/adapter. The task Migration
 * rule: rollback restores a SIGNED, COMPATIBLE alias/adapter ONLY. A restore is
 * therefore authorized IFF the restored artifact is signed AND its architecture
 * is host-supported. (A legacy webview is never "restored"; its rollback is
 * disablement, so a webview target has no signed-restore path — callers must
 * NOT route a webview through this restore gate.)
 */
export function rollbackRestoreAuthorized(
  identity: PackageIdentity,
  supportedArchitectures: readonly Architecture[],
): boolean {
  return (
    identity.signed &&
    isArchitecture(identity.architecture) &&
    supportedArchitectures.includes(identity.architecture)
  );
}
