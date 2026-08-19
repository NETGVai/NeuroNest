/**
 * Approval Command Handler — main-process authority for authoritative
 * Approval Cards.
 *
 * The renderer submits `approve` commands whose envelope carries:
 *   - `targetIdentity`      = collaborationId
 *   - `expectedSourceRevision` = contract revision
 *   - `scopeDigest`         = contract digest
 *   - `idempotencyKey`      = derived from (collaborationId, revision, decision)
 *
 * The handler owns three responsibilities:
 *
 *   1. Staleness — reject envelopes whose contract revision or digest no
 *      longer match the projection-supplied approval scope (Requirement
 *      15.4). This is expressed via the exported `scopeAuthority`, which the
 *      structured-command IPC boundary consults before dispatch.
 *
 *   2. Idempotency — a duplicate submission carrying the same
 *      `idempotencyKey` after a terminal decision was recorded resolves to
 *      the same transport receipt without emitting a second event
 *      (Requirement 15.5).
 *
 *   3. Execution blocking — tool executors call `waitForDecision` /
 *      `isExecutionBlocked` and receive the authority-committed terminal
 *      state before running the underlying action (Requirement 13.6).
 *
 * All state is in-memory and scoped to the current process. Durable truth
 * lives in the Harness SessionLog via `emitApprovalDecision`, which
 * consumers wire to the projector for `approval.upserted` events. Consumers
 * that omit the emitter still see the correct in-memory state but do not
 * durably record the decision — used only in unit tests.
 *
 * Requirements: 13.5–13.9, 15.3–15.5
 */

import type {
  CommandEnvelopeForV1,
  CommandEnvelopeV1,
} from '../../harness/contracts';
import type {
  StructuredAuthorityDispatchResultV1,
  StructuredCommandScopeAuthorityV1,
  StructuredCommandScopeSnapshotV1,
} from './structured-command-ipc';

// ─── Types ──────────────────────────────────────────────────────

export type ApprovalDecision = 'approve' | 'reject';
export type ApprovalRecordStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalScopeRegistration {
  readonly collaborationId: string;
  readonly contractRevision: number;
  readonly contractDigest: string;
  /**
   * Optional projection revision under which the approval was registered.
   * When supplied, the scope authority validates it against the envelope's
   * `expectedProjectionRevision`. When omitted the envelope's value is
   * echoed back so the outer IPC boundary never sees a projection-revision
   * mismatch it did not itself observe.
   */
  readonly projectionRevision?: number;
}

export interface ApprovalRecord extends ApprovalScopeRegistration {
  readonly status: ApprovalRecordStatus;
  /** Present after a terminal decision has been recorded. */
  readonly decision?: ApprovalDecision;
  /** Envelope idempotency key of the committing command, when known. */
  readonly committingIdempotencyKey?: string;
}

export interface ApprovalDecisionEvent {
  readonly collaborationId: string;
  readonly contractRevision: number;
  readonly contractDigest: string;
  readonly decision: ApprovalDecision;
}

export interface ApprovalCommandHandlerOptions {
  /**
   * Session identity for the scope authority. Envelopes whose sessionId or
   * branchId disagree with these values are rejected as scope mismatches.
   */
  readonly sessionId: string;
  readonly branchId: string;
  /**
   * Optional emitter invoked once when a terminal decision is committed.
   * Second/duplicate commits for the same idempotency key never re-emit.
   */
  readonly emitApprovalDecision?: (event: ApprovalDecisionEvent) => void | Promise<void>;
}

export type ApprovalAuthorityMethod = (
  command: Readonly<CommandEnvelopeForV1<'approve'>>,
) => Promise<StructuredAuthorityDispatchResultV1>;

export interface ApprovalCommandHandler {
  /**
   * The approve authority method to install into
   * `StructuredCommandAuthorityV1['approve']`.
   */
  readonly authority: ApprovalAuthorityMethod;
  /**
   * The scope authority to install into `registerStructuredCommandIPC`.
   * Combines session/branch identity with the currently-recorded contract
   * revision and digest so stale envelopes are rejected before reaching the
   * authority method.
   */
  readonly scopeAuthority: StructuredCommandScopeAuthorityV1;
  /**
   * Register a new pending approval scope (typically called when the
   * projector emits an `approval.upserted:pending` event).
   */
  registerPendingApproval(scope: ApprovalScopeRegistration): void;
  /**
   * Query the current in-memory record for a collaboration. Returns `null`
   * when no approval has ever been registered for the identifier.
   */
  getRecord(collaborationId: string): ApprovalRecord | null;
  /**
   * True when the collaboration is registered but has no terminal decision.
   * Tool executors gate execution on this.
   */
  isExecutionBlocked(collaborationId: string): boolean;
  /**
   * Resolve when a terminal decision is committed for the collaboration.
   * Resolves immediately if a decision was already recorded. Rejects if the
   * supplied `AbortSignal` fires before a decision is available.
   */
  waitForDecision(
    collaborationId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ApprovalRecord>;
  /** Clear all in-memory records — primarily for tests. */
  reset(): void;
}

// ─── Implementation ─────────────────────────────────────────────

interface Waiter {
  readonly resolve: (record: ApprovalRecord) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

export function createApprovalCommandHandler(
  options: ApprovalCommandHandlerOptions,
): ApprovalCommandHandler {
  const records = new Map<string, ApprovalRecord>();
  /** Idempotency ledger keyed by envelope idempotencyKey. */
  const idempotency = new Map<string, StructuredAuthorityDispatchResultV1>();
  /** Waiters keyed by collaborationId. */
  const waiters = new Map<string, Set<Waiter>>();

  function registerPendingApproval(scope: ApprovalScopeRegistration): void {
    const existing = records.get(scope.collaborationId);
    if (existing && existing.contractRevision > scope.contractRevision) {
      // Never regress a later revision to an earlier one; the projector is
      // still the source of truth for authoritative ordering.
      return;
    }
    if (existing && existing.contractRevision === scope.contractRevision) {
      // Same revision — refresh the digest but preserve any committed
      // decision (a terminal record is authoritative).
      if (existing.status !== 'pending') {
        records.set(scope.collaborationId, {
          ...existing,
          contractDigest: scope.contractDigest,
          projectionRevision: scope.projectionRevision ?? existing.projectionRevision,
        });
        return;
      }
    }
    records.set(scope.collaborationId, {
      collaborationId: scope.collaborationId,
      contractRevision: scope.contractRevision,
      contractDigest: scope.contractDigest,
      projectionRevision: scope.projectionRevision,
      status: 'pending',
    });
  }

  function getRecord(collaborationId: string): ApprovalRecord | null {
    return records.get(collaborationId) ?? null;
  }

  function isExecutionBlocked(collaborationId: string): boolean {
    const record = records.get(collaborationId);
    if (!record) return true; // unknown scope stays blocked defensively
    return record.status === 'pending';
  }

  function waitForDecision(
    collaborationId: string,
    waitOptions: { readonly signal?: AbortSignal } = {},
  ): Promise<ApprovalRecord> {
    const record = records.get(collaborationId);
    if (record && record.status !== 'pending') {
      return Promise.resolve(record);
    }
    const signal = waitOptions.signal;
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error('Approval wait aborted'));
    }
    return new Promise<ApprovalRecord>((resolve, reject) => {
      const bucket = waiters.get(collaborationId) ?? new Set<Waiter>();
      const onAbort = signal
        ? () => {
            bucket.delete(waiter);
            reject(signal.reason ?? new Error('Approval wait aborted'));
          }
        : undefined;
      const waiter: Waiter = { resolve, reject, ...(signal ? { signal } : {}), ...(onAbort ? { onAbort } : {}) };
      bucket.add(waiter);
      waiters.set(collaborationId, bucket);
      if (signal && onAbort) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  function resolveWaiters(record: ApprovalRecord): void {
    const bucket = waiters.get(record.collaborationId);
    if (!bucket || bucket.size === 0) return;
    for (const waiter of bucket) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.resolve(record);
    }
    bucket.clear();
    waiters.delete(record.collaborationId);
  }

  const scopeAuthority: StructuredCommandScopeAuthorityV1 = {
    async getCurrentScope(command: Readonly<CommandEnvelopeV1>): Promise<StructuredCommandScopeSnapshotV1 | null> {
      if (command.payload.actionKind !== 'approve') return null;
      if (command.sessionId !== options.sessionId) return null;
      if (command.branchId !== options.branchId) return null;

      const record = records.get(command.targetIdentity);
      if (!record) return null;

      return {
        schemaVersion: 1,
        sessionId: options.sessionId,
        branchId: options.branchId,
        targetIdentity: command.targetIdentity,
        projectionRevision: record.projectionRevision ?? command.expectedProjectionRevision,
        sourceRevision: record.contractRevision,
        scopeDigest: record.contractDigest,
      };
    },
  };

  const authority: ApprovalAuthorityMethod = async (
    command: Readonly<CommandEnvelopeForV1<'approve'>>,
  ): Promise<StructuredAuthorityDispatchResultV1> => {
    // Idempotency ledger — replay support.
    const key = command.idempotencyKey;
    if (key !== undefined) {
      const prior = idempotency.get(key);
      if (prior) {
        return prior;
      }
    }

    const decision = command.payload.decision;
    if (decision !== 'approve' && decision !== 'reject') {
      return { delivered: false, rejectionCode: 'invalid_command' };
    }

    const record = records.get(command.targetIdentity);
    if (!record) {
      // The scope authority normally short-circuits before we get here. As
      // defence-in-depth, we still refuse to synthesize a scope that was
      // never registered.
      return { delivered: false, rejectionCode: 'scope_mismatch' };
    }

    // Explicit staleness re-check. The outer scope authority is expected to
    // reject stale envelopes but a race between register and submit could
    // slip past it if the caller supplies a custom envelope.
    if (command.expectedSourceRevision !== record.contractRevision) {
      return { delivered: false, rejectionCode: 'stale_command' };
    }
    if (command.scopeDigest !== record.contractDigest) {
      return { delivered: false, rejectionCode: 'stale_command' };
    }

    // Idempotent re-run of an already-terminal record with a fresh envelope:
    // if the decision matches the recorded one, we still accept and echo a
    // delivered receipt without re-emitting. If it disagrees, we reject —
    // the projection is authoritative and a second contradictory command
    // cannot rewrite it.
    if (record.status !== 'pending') {
      if (record.decision === decision) {
        const result: StructuredAuthorityDispatchResultV1 = { delivered: true };
        if (key !== undefined) idempotency.set(key, result);
        return result;
      }
      return { delivered: false, rejectionCode: 'stale_command' };
    }

    // First-time commit — record the terminal decision and emit.
    const terminalStatus: ApprovalRecordStatus = decision === 'approve' ? 'approved' : 'rejected';
    const committed: ApprovalRecord = {
      collaborationId: record.collaborationId,
      contractRevision: record.contractRevision,
      contractDigest: record.contractDigest,
      projectionRevision: record.projectionRevision,
      status: terminalStatus,
      decision,
      ...(key !== undefined ? { committingIdempotencyKey: key } : {}),
    };
    records.set(record.collaborationId, committed);

    try {
      await options.emitApprovalDecision?.({
        collaborationId: committed.collaborationId,
        contractRevision: committed.contractRevision,
        contractDigest: committed.contractDigest,
        decision,
      });
    } catch (err) {
      // Emitter failures propagate as transport_failure to the renderer but
      // still leave the in-memory record committed so subsequent duplicate
      // submissions remain idempotent.
      const result: StructuredAuthorityDispatchResultV1 = {
        delivered: false,
        rejectionCode: 'transport_failure',
      };
      if (key !== undefined) idempotency.set(key, result);
      // Do not resolve waiters — the emitter failure means the durable
      // record was not persisted; the tool executor should keep blocking.
      void err;
      return result;
    }

    resolveWaiters(committed);

    const result: StructuredAuthorityDispatchResultV1 = { delivered: true };
    if (key !== undefined) idempotency.set(key, result);
    return result;
  };

  function reset(): void {
    records.clear();
    idempotency.clear();
    for (const bucket of waiters.values()) {
      for (const waiter of bucket) {
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener('abort', waiter.onAbort);
        }
        waiter.reject(new Error('Approval handler reset'));
      }
    }
    waiters.clear();
  }

  return {
    authority,
    scopeAuthority,
    registerPendingApproval,
    getRecord,
    isExecutionBlocked,
    waitForDecision,
    reset,
  };
}
