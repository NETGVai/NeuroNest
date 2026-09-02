/**
 * Future dual-MCP non-promotion boundary (FUT-PKG-08-OPTIONAL/T-006).
 *
 * This module is the ARCHITECTURE GATE that keeps the two-executable
 * `FUTURE-DUAL-MCP` variant OUT of the current release baseline (NN-INTEGRATION-004,
 * CD-023). It is an observer/verifier, not an activator: it advertises nothing,
 * registers no executable, and NEVER makes the second MCP process available. It
 * has three jobs:
 *
 *   1. Non-promotion resolution ({@link resolveDualMcpAvailability}): any
 *      current attempt — at build, startup, or config — to make either the
 *      SESSION or RUNTIME dual-MCP executable available resolves to a typed
 *      `UNAVAILABLE` `ErrorEnvelope@1`. Current in-process / optional single
 *      adapter behavior is preserved and is the ONLY advertised MCP baseline
 *      (NN-INTEGRATION-003 stays the current path). Absence never infers
 *      permission (NN-INV-001/014): the future capability is visibly
 *      unavailable and returns no success.
 *
 *   2. No dual writer ({@link assertNoDualDurableWriter}): the durable business
 *      classes have exactly one writable authority (the same-transaction outbox
 *      authority; NN-INV-008, NN-COMPAT-002). This boundary refuses to admit a
 *      second durable writer for any state class, so an unpromoted dual-MCP
 *      deployment can never introduce a competing writer. Coordination between
 *      any two executables — IF ever promoted — is only through the versioned
 *      shared-database / outbox contract, never a second writer.
 *
 *   3. Future-lifecycle guard ({@link evaluatePromotionProposal}): a promotion
 *      is a REVIEWED future spec revision, not a runtime toggle. Before a
 *      dual-MCP promotion could even be considered, a proposal MUST FIRST supply
 *      the full NN-INTEGRATION-004 checklist — lifecycle promotion, process
 *      identity, packaging, protocol/schema version ranges, migration
 *      coordinator lease, outbox ownership, platform, security, and rollback
 *      design/evidence. A proposal missing ANY item is REFUSED. Critically,
 *      even a COMPLETE proposal only PASSES THE GUARD; passing the guard does
 *      NOT self-activate dual-MCP — activation still requires a separate
 *      reviewed spec revision (V-VERIFY-001/future-lifecycle-guard).
 *
 * Everything here is pure and side-effect free. It performs none of the risky
 * effects it evaluates: it starts no process, opens no second database
 * connection as a writer, reads no credential, and selects no artifact. The
 * no-dual-writer assertion is exercised against a real committed outbox in the
 * test harness; this module only classifies the observed writer set.
 *
 * Rollback (task contract): there is no current migration to roll back. A future
 * promotion requires a separate reviewed spec revision; rollback remains the
 * current in-process / optional adapter with no shared dual writer.
 *
 * Design anchors: D-02, D-03, D-17, D-20, D-23, D-24.
 * Requirements: NN-INTEGRATION-004, NN-INV-008, NN-INV-014, NN-COMPAT-002.
 */

import {
  CONTRACT_WRITE_VERSION,
  isOpaqueId,
  type ErrorEnvelope,
} from '../shared/contract-primitives.js';

// ════════════════════════════════════════════════════════════════════════════
// 1. Dual-MCP executable identities and the current advertised baseline
// ════════════════════════════════════════════════════════════════════════════

/**
 * The two executables of the `FUTURE-DUAL-MCP` variant (NN-INTEGRATION-004): an
 * independent SESSION MCP process and an independent RUNTIME MCP process. Both
 * are future/capability-gated and MUST NOT be advertised or registered in the
 * target profile. They are named so the non-promotion guarantee is testable and
 * stable — naming them here is descriptive truth, not a registration.
 */
export const DUAL_MCP_EXECUTABLES = Object.freeze([
  'session-mcp',
  'runtime-mcp',
] as const);
export type DualMcpExecutable = (typeof DUAL_MCP_EXECUTABLES)[number];

/** Whether a value names one of the two dual-MCP executables. */
export function isDualMcpExecutable(value: unknown): value is DualMcpExecutable {
  return (
    typeof value === 'string' &&
    (DUAL_MCP_EXECUTABLES as readonly string[]).includes(value)
  );
}

/**
 * The current, advertised MCP capability profile (NN-INTEGRATION-003): a single
 * in-process / optional MCP adapter. This is the ONLY advertised MCP baseline;
 * the dual two-executable deployment is NOT part of it. The non-promotion
 * resolution below preserves this current behavior unchanged.
 */
export const CURRENT_MCP_PROFILE = Object.freeze({
  /** The current MCP capability id (the single optional/in-process adapter). */
  capabilityId: 'mcp-in-process-adapter',
  /** The deployment shape: one process, no second executable. */
  deployment: 'in-process-optional-adapter',
  /** Whether the dual two-executable variant is advertised. Always false. */
  dualExecutableAdvertised: false,
} as const);

/** The surfaces from which a current dual-MCP availability attempt can arrive. */
export const AVAILABILITY_TRIGGERS = Object.freeze([
  'build',
  'startup',
  'config',
] as const);
export type AvailabilityTrigger = (typeof AVAILABILITY_TRIGGERS)[number];

/** Whether a value is a recognized availability trigger. */
export function isAvailabilityTrigger(
  value: unknown,
): value is AvailabilityTrigger {
  return (
    typeof value === 'string' &&
    (AVAILABILITY_TRIGGERS as readonly string[]).includes(value)
  );
}

const BOUNDARY_OWNER = 'authority-architecture-gate';

// ════════════════════════════════════════════════════════════════════════════
// 2. Non-promotion availability resolution (NN-INTEGRATION-004, CD-023)
// ════════════════════════════════════════════════════════════════════════════

/** A request to make a dual-MCP executable available in the current profile. */
export interface DualMcpAvailabilityRequest {
  /** Which future executable is being requested. */
  readonly executable: DualMcpExecutable;
  /** Where the attempt originates (build / startup / config). */
  readonly trigger: AvailabilityTrigger;
  /** Optional correlation id threaded onto the typed error. */
  readonly correlationId?: string;
}

/**
 * The outcome of resolving a dual-MCP availability attempt. `available` is
 * ALWAYS false in the target profile: the future capability is visibly
 * unavailable and the current in-process adapter remains the advertised
 * baseline. The typed `UNAVAILABLE` error carries a safe remediation and
 * authorizes NO fallback (no process spawn, no second writer).
 */
export interface DualMcpAvailabilityResolution {
  /** Always false in the target profile (non-promotion). */
  readonly available: false;
  /** The typed UNAVAILABLE error a caller must surface. */
  readonly error: ErrorEnvelope;
  /** The current advertised baseline the caller falls back to (unchanged). */
  readonly currentBaseline: typeof CURRENT_MCP_PROFILE;
}

/**
 * Resolve a current attempt to make a dual-MCP executable available. In the
 * target profile this ALWAYS resolves to a typed `UNAVAILABLE` `ErrorEnvelope@1`
 * (NN-INTEGRATION-004, CD-023): neither the session nor the runtime executable
 * is advertised or registered, no process is started, and no second writer is
 * introduced. The current single in-process / optional MCP adapter behavior is
 * preserved and returned as `currentBaseline`. Producing this resolution is a
 * pure, side-effect-free classification (NN-INV-001/014).
 */
export function resolveDualMcpAvailability(
  request: DualMcpAvailabilityRequest,
): DualMcpAvailabilityResolution {
  return {
    available: false,
    error: makeDualMcpUnavailableError(
      request.executable,
      request.trigger,
      request.correlationId,
    ),
    currentBaseline: CURRENT_MCP_PROFILE,
  };
}

/**
 * Mint the typed `UNAVAILABLE` error for a dual-MCP executable that a current
 * profile is not permitted to make available. `retryable` is false: this is a
 * durable architecture fact until a separate reviewed promotion spec revision,
 * not a transient error. The remediation points at the promotion checklist and
 * authorizes no fallback (NN-INV-011; D-24 dual-writer risk mitigation).
 */
export function makeDualMcpUnavailableError(
  executable: DualMcpExecutable,
  trigger: AvailabilityTrigger,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code: 'UNAVAILABLE',
    message:
      `dual-MCP executable '${executable}' is a future capability and is not ` +
      `available in the target profile (attempted via ${trigger})`,
    owner: BOUNDARY_OWNER,
    operation: `dual-mcp.availability.${trigger}`,
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: false,
    remediation:
      'The two-executable dual-MCP deployment is future/capability-gated. ' +
      'Promotion requires a separate reviewed spec revision supplying the full ' +
      'lifecycle/identity/packaging/protocol/lease/outbox/platform/security/rollback ' +
      'checklist; the current in-process optional MCP adapter remains the only ' +
      'advertised baseline. No process spawn or second durable writer is permitted.',
    redaction: 'internal',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 3. No-dual-writer boundary (NN-INV-008, NN-COMPAT-002)
// ════════════════════════════════════════════════════════════════════════════

/**
 * A claim that some executable/adapter WRITES a durable state class. The
 * boundary uses the observed set of writer claims to prove exactly one writable
 * authority owns each class (NN-INV-008): caches, event streams, adapters,
 * legacy stores, UI models, and a would-be second MCP process must NOT become
 * competing writers.
 */
export interface DurableWriterClaim {
  /** The durable state class being written (e.g. an outbox scope / table). */
  readonly stateClass: string;
  /** The authority/executable that claims write ownership of the class. */
  readonly writer: string;
}

/** The result of auditing writer claims for a single durable state class. */
export interface DualWriterFinding {
  readonly stateClass: string;
  /** Every distinct writer observed for the class (sorted, deduped). */
  readonly writers: readonly string[];
  /** True iff exactly one writer owns the class (the required invariant). */
  readonly singleWriter: boolean;
}

/** The verdict of a no-dual-writer audit across all observed state classes. */
export interface NoDualWriterVerdict {
  /** `pass` iff every state class has exactly one writer; `block` otherwise. */
  readonly verdict: 'pass' | 'block';
  /** Per-class findings, sorted by state class for determinism. */
  readonly findings: readonly DualWriterFinding[];
  /** A typed CONFLICT error present only when the verdict is `block`. */
  readonly error?: ErrorEnvelope;
}

/**
 * Audit a set of durable writer claims and prove no state class has more than
 * one writer (NN-INV-008, NN-COMPAT-002). Any class with two or more distinct
 * writers is a dual-writer violation and forces `block` with a typed `CONFLICT`
 * error. This is how an unpromoted dual-MCP deployment is prevented from
 * introducing a competing durable writer: registering the second MCP as a
 * writer for an already-owned class is refused. Pure and read-only.
 */
export function assertNoDualDurableWriter(
  claims: readonly DurableWriterClaim[],
  correlationId?: string,
): NoDualWriterVerdict {
  const byClass = new Map<string, Set<string>>();
  for (const claim of claims) {
    const set = byClass.get(claim.stateClass) ?? new Set<string>();
    set.add(claim.writer);
    byClass.set(claim.stateClass, set);
  }

  const findings: DualWriterFinding[] = [...byClass.entries()]
    .map(([stateClass, writers]) => ({
      stateClass,
      writers: [...writers].sort(),
      singleWriter: writers.size === 1,
    }))
    .sort((a, b) =>
      a.stateClass < b.stateClass ? -1 : a.stateClass > b.stateClass ? 1 : 0,
    );

  const violations = findings.filter((f) => !f.singleWriter);
  if (violations.length === 0) {
    return { verdict: 'pass', findings };
  }

  return {
    verdict: 'block',
    findings,
    error: {
      schemaVersion: CONTRACT_WRITE_VERSION,
      code: 'CONFLICT',
      message:
        `dual durable writer detected for state class(es): ` +
        violations
          .map((v) => `${v.stateClass} [${v.writers.join(', ')}]`)
          .join('; '),
      owner: BOUNDARY_OWNER,
      operation: 'dual-mcp.no-dual-writer',
      correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
      retryable: false,
      remediation:
        'Exactly one authority may write each durable state class. Remove the ' +
        'competing writer; coordinate only through the versioned shared-database ' +
        'outbox contract, never a second durable writer.',
      redaction: 'internal',
    },
  };
}

/**
 * Determine whether admitting a NEW writer for a state class would create a
 * second writer, given the writers already observed for that class. Returns
 * `true` when the new writer is a distinct additional owner (which must be
 * refused). If the class has no existing writer, or the new writer is the same
 * authority already owning it, admission is safe (`false`). This is the
 * admission-time form of the no-dual-writer invariant used to reject a would-be
 * second MCP writer at registration.
 */
export function wouldCreateSecondWriter(
  existingWriters: readonly string[],
  candidateWriter: string,
): boolean {
  const distinct = new Set(existingWriters);
  if (distinct.size === 0) return false;
  if (distinct.size === 1 && distinct.has(candidateWriter)) return false;
  return true;
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Future-lifecycle promotion guard (V-VERIFY-001/future-lifecycle-guard)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The full checklist a dual-MCP promotion PROPOSAL must supply before it can be
 * reviewed (NN-INTEGRATION-004). Each item is a design/evidence obligation. A
 * proposal missing ANY item is refused by {@link evaluatePromotionProposal}.
 * The order is stable so the guard's report is deterministic.
 */
export const PROMOTION_CHECKLIST_ITEMS = Object.freeze([
  'lifecycle-promotion',
  'process-identity',
  'packaging',
  'protocol-schema-ranges',
  'migration-lease',
  'outbox-ownership',
  'platform',
  'security',
  'rollback',
] as const);
export type PromotionChecklistItem = (typeof PROMOTION_CHECKLIST_ITEMS)[number];

/**
 * A promotion proposal: for each checklist item, whether the proposal supplies
 * a real design/evidence artifact for it. This is a PROPOSAL to be validated,
 * NOT an activation request — the guard never turns dual-MCP on.
 */
export type PromotionProposal = Readonly<
  Record<PromotionChecklistItem, boolean>
>;

/** The result of validating a promotion proposal against the checklist. */
export interface PromotionGuardResult {
  /**
   * `true` iff every checklist item is supplied. A `true` result means the
   * proposal PASSES THE GUARD — it does NOT activate dual-MCP.
   */
  readonly complete: boolean;
  /**
   * ALWAYS false. Passing the guard never self-activates the future capability;
   * activation requires a separate reviewed spec revision (task contract).
   */
  readonly activated: false;
  /** The checklist items the proposal failed to supply (empty on complete). */
  readonly missing: readonly PromotionChecklistItem[];
  /**
   * A typed error present when the proposal is incomplete (`VALIDATION`) — the
   * proposal is refused. Never present on a complete proposal.
   */
  readonly error?: ErrorEnvelope;
}

/**
 * Validate a dual-MCP promotion proposal against the full NN-INTEGRATION-004
 * checklist (V-VERIFY-001/future-lifecycle-guard). A proposal missing ANY item
 * is refused with a typed `VALIDATION` error listing the gaps. A complete
 * proposal PASSES the guard (`complete: true`) but is STILL NOT activated
 * (`activated: false`): the guard validates a proposal, it does not promote.
 * Actual promotion requires a separate reviewed spec revision. Pure and
 * side-effect free.
 */
export function evaluatePromotionProposal(
  proposal: PromotionProposal,
  correlationId?: string,
): PromotionGuardResult {
  const missing = PROMOTION_CHECKLIST_ITEMS.filter(
    (item) => proposal[item] !== true,
  );

  if (missing.length === 0) {
    // Complete proposal: passes the guard, but activation is NOT performed here.
    return { complete: true, activated: false, missing: [] };
  }

  return {
    complete: false,
    activated: false,
    missing,
    error: {
      schemaVersion: CONTRACT_WRITE_VERSION,
      code: 'VALIDATION',
      message:
        `dual-MCP promotion proposal is incomplete; missing required ` +
        `checklist item(s): ${missing.join(', ')}`,
      owner: BOUNDARY_OWNER,
      operation: 'dual-mcp.promotion-proposal',
      correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
      retryable: false,
      remediation:
        'A dual-MCP promotion proposal must supply lifecycle promotion, process ' +
        'identity, packaging, protocol/schema ranges, migration lease, outbox ' +
        'ownership, platform, security, and rollback design/evidence before it can ' +
        'be reviewed. Passing this guard does not activate dual-MCP; promotion ' +
        'requires a separate reviewed spec revision.',
      redaction: 'internal',
    },
  };
}

/**
 * Build an empty (all-false) promotion proposal. Useful for callers that want
 * to fill items in explicitly; an empty proposal is always refused by the
 * guard.
 */
export function emptyPromotionProposal(): PromotionProposal {
  const proposal = {} as Record<PromotionChecklistItem, boolean>;
  for (const item of PROMOTION_CHECKLIST_ITEMS) proposal[item] = false;
  return proposal;
}
