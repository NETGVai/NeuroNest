/**
 * GUI / CLI / JSON-RPC surface parity over one shared core authority
 * (FUT-PKG-06-EXECUTION/T-008).
 *
 * NN-EXEC-011 requires GUI, CLI, JSON event, JSON-RPC, and outbound MCP entry
 * points to share the SAME core authorities and safety contracts; headless
 * requests SHALL have typed exit/error states, request IDs, cancellation,
 * license/entitlement checks, and no renderer dependency. NN-PLATFORM-008
 * requires the desktop and standalone CLI to share the same
 * projects/providers/agents/skills/commands/tools/safety/evidence contracts
 * while preserving environment-appropriate interaction.
 *
 * This module is the parity core. Every surface expresses an operation as a
 * {@link ParityRequest} and dispatches it through the ONE {@link CoreOperationPort}
 * — the same authority the rest of the system uses. The surface only adapts the
 * ENVELOPE (how the request/result is carried); it MUST NOT change the DECISION.
 * The load-bearing guarantee (V-EXEC-001/runtime-cli-parity, task acceptance):
 * the same operation through GUI, CLI, and JSON-RPC produces EQUIVALENT typed
 * results, and NO surface has a privileged bypass — the core's safety/license/
 * entitlement checks run identically regardless of surface.
 *
 * Determinism / no-renderer-dependency (NN-EXEC-011). The core operation is a
 * pure function of the request; the surface adapters carry no renderer state and
 * add no capability. A headless (CLI/JSON-RPC) request has a typed exit/error
 * state, a request id, and a cancellation token, exactly like the GUI request.
 *
 * Design anchors: D-05, D-11, D-16, D-19. Requirements:
 * NN-EXEC-011, NN-PLATFORM-008, NN-INV-014.
 */

import {
  CONTRACT_WRITE_VERSION,
  computeDigest,
  isOpaqueId,
  type ErrorEnvelope,
} from '../shared/contract-primitives';

const PARITY_OWNER = 'authority-surface-parity';

// ════════════════════════════════════════════════════════════════════════════
// 1. Surfaces (NN-EXEC-011)
// ════════════════════════════════════════════════════════════════════════════

/** The entry-point surfaces that MUST share the one core (NN-EXEC-011). */
export const SURFACES = Object.freeze([
  'gui',
  'cli',
  'json-event',
  'json-rpc',
  'outbound-mcp',
] as const);
export type Surface = (typeof SURFACES)[number];

/** Whether a surface is headless (no renderer dependency). */
export function isHeadlessSurface(surface: Surface): boolean {
  return surface !== 'gui';
}

// ════════════════════════════════════════════════════════════════════════════
// 2. The surface-neutral request/result
// ════════════════════════════════════════════════════════════════════════════

/** A surface-neutral operation request. Identical fields across every surface. */
export interface ParityRequest {
  /** Stable request id (present on headless AND GUI requests, NN-EXEC-011). */
  readonly requestId: string;
  /** The core operation name (shared vocabulary across surfaces). */
  readonly operation: string;
  /** Structured, surface-neutral arguments. */
  readonly args: unknown;
  /** The cancellation token id the request runs under. */
  readonly cancellationTokenId: string;
  /** The license/entitlement principal (checked identically per surface). */
  readonly principal: string;
  readonly correlationId?: string;
}

/**
 * The surface-neutral typed result. `exitCode` gives a headless surface a typed
 * exit state (0 success, non-zero failure) derived from the SAME decision the
 * GUI renders. `resultDigest` binds the decision so two surfaces can be proven
 * equivalent by digest equality.
 */
export interface ParityResult {
  readonly requestId: string;
  readonly ok: boolean;
  /** Typed exit state for headless surfaces (0 iff ok). */
  readonly exitCode: number;
  /** Opaque success result reference; absent on failure. */
  readonly resultRef?: string;
  readonly error?: ErrorEnvelope;
  /** A digest binding the decision (operation + args + outcome). */
  readonly resultDigest: string;
}

// ════════════════════════════════════════════════════════════════════════════
// 3. The one core operation port (shared authority)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The single core operation the surfaces share. Production wires this to the
 * governed authority (e.g. the tool pipeline / orchestration service) plus the
 * license/entitlement check. It is a pure decision over the request — no surface
 * state, no renderer dependency (NN-EXEC-011).
 */
export interface CoreOperationPort {
  /** License / entitlement check for the principal + operation (shared). */
  checkEntitled(input: {
    readonly principal: string;
    readonly operation: string;
  }): { readonly ok: true } | { readonly ok: false; readonly error: ErrorEnvelope };
  /** The governed core decision. Same for every surface. */
  execute(input: {
    readonly operation: string;
    readonly args: unknown;
    readonly correlationId: string;
  }): { readonly ok: true; readonly resultRef: string } | { readonly ok: false; readonly error: ErrorEnvelope };
}

// ════════════════════════════════════════════════════════════════════════════
// 4. The parity dispatcher
// ════════════════════════════════════════════════════════════════════════════

function parityError(
  code: ErrorEnvelope['code'],
  message: string,
  operation: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: PARITY_OWNER,
    operation,
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: false,
    remediation:
      'Every surface dispatches through the one core authority; no surface has a privileged bypass.',
    redaction: 'internal',
  };
}

/** The exit code convention: 0 success, non-zero typed failure. */
export function exitCodeFor(result: { readonly ok: boolean; readonly error?: ErrorEnvelope }): number {
  if (result.ok) return 0;
  // A stable, code-derived non-zero exit so headless callers can branch.
  switch (result.error?.code) {
    case 'VALIDATION':
      return 2;
    case 'UNAUTHORIZED':
    case 'FORBIDDEN':
      return 3;
    case 'UNAVAILABLE':
      return 4;
    case 'CANCELLED':
      return 5;
    case 'BUDGET_EXCEEDED':
      return 6;
    default:
      return 1;
  }
}

/**
 * Dispatch a request through the ONE core, from ANY surface. The surface is
 * used ONLY for the envelope/exit conventions; the DECISION (entitlement +
 * core execute) is identical regardless of surface, so no surface can bypass a
 * check (NN-EXEC-011, NN-PLATFORM-008).
 *
 * Order (identical per surface):
 *   1. entitlement/license check (shared) — a denied principal is `UNAUTHORIZED`;
 *   2. core execute (shared governed decision);
 *   3. the result is wrapped with the surface-neutral typed envelope + exit code
 *      + decision digest.
 *
 * A cancelled token id (checked by the injected `isCancelled` predicate) short
 * circuits to a typed `CANCELLED` on every surface identically.
 */
export function dispatchOnSurface(
  surface: Surface,
  request: ParityRequest,
  core: CoreOperationPort,
  isCancelled: (tokenId: string) => boolean,
): ParityResult {
  const correlationId = request.correlationId ?? 'corr-unset';

  // The decision digest binds the surface-INDEPENDENT decision inputs. Two
  // surfaces running the same operation/args yield the SAME digest.
  const decisionKey = {
    operation: request.operation,
    args: request.args ?? null,
    principal: request.principal,
  };

  const wrap = (
    inner: { readonly ok: true; readonly resultRef: string } | { readonly ok: false; readonly error: ErrorEnvelope },
  ): ParityResult => {
    const resultDigest = computeDigest({
      ...decisionKey,
      ok: inner.ok,
      code: inner.ok ? 'OK' : inner.error.code,
    });
    if (inner.ok) {
      return {
        requestId: request.requestId,
        ok: true,
        exitCode: 0,
        resultRef: inner.resultRef,
        resultDigest,
      };
    }
    return {
      requestId: request.requestId,
      ok: false,
      exitCode: exitCodeFor({ ok: false, error: inner.error }),
      error: inner.error,
      resultDigest,
    };
  };

  // (0) Cancellation — identical on every surface.
  if (isCancelled(request.cancellationTokenId)) {
    return wrap({
      ok: false,
      error: parityError('CANCELLED', 'request cancelled before dispatch', request.operation, correlationId),
    });
  }

  // (1) Entitlement / license — the SAME check on every surface (no bypass).
  const entitled = core.checkEntitled({ principal: request.principal, operation: request.operation });
  if (!entitled.ok) {
    return wrap({ ok: false, error: entitled.error });
  }

  // (2) Core governed decision — the SAME core on every surface.
  const executed = core.execute({
    operation: request.operation,
    args: request.args,
    correlationId,
  });
  return wrap(executed);
}

/**
 * Whether two parity results are EQUIVALENT (surface parity). Two results are
 * equivalent when they agree on success, decision digest, and error code — i.e.
 * the same DECISION was reached, regardless of surface. Exit codes and result
 * refs are envelope details; the digest + ok + code is the decision identity.
 */
export function resultsEquivalent(a: ParityResult, b: ParityResult): boolean {
  return (
    a.ok === b.ok &&
    a.resultDigest === b.resultDigest &&
    (a.error?.code ?? null) === (b.error?.code ?? null)
  );
}
