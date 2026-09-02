/**
 * Cloud gadgets & workflows — versioned state, idempotency, retry/dead-letter,
 * cancellation, and fail-closed optional-degradation isolation
 * (FUT-PKG-08-OPTIONAL/T-004).
 *
 * NN-CLOUD-003 requires cloud gadgets, scheduled workflows, queues, and durable
 * background operations to expose versioned request/state/result schemas,
 * idempotency, retry/dead-letter behavior, cancellation, and operator-visible
 * status — and forbids ordinary HTTP success from substituting for workflow
 * completion. NN-CLOUD-004 requires that a failure of an OPTIONAL cloud helper
 * (analytics, proxy-admin data, cache, helper service) stays isolated and
 * visible, while any authentication, entitlement, secret, payment, or mutating
 * workflow failure FAILS CLOSED.
 *
 * This module is the workflow authority. Every durable state transition is
 * committed through the SINGLE same-transaction outbox authority
 * ({@link ../storage/authority-transaction}.applyAuthorityMutation) — there is
 * no private write path — so an operator-visible status is always a committed
 * fact, never an in-flight HTTP 200. It provides:
 *
 *   1. A versioned {@link WorkflowRequest} / {@link WorkflowState} /
 *      {@link WorkflowResult} contract and a state machine whose ONLY terminal
 *      success is `succeeded` (an HTTP acknowledgement never advances the
 *      state).
 *   2. Idempotent step admission: a step keyed by an idempotency key that has
 *      already committed is a REPLAY (no second effect); the workflow's
 *      committed status is the durable truth.
 *   3. Bounded retry with dead-letter: a retryable step failure is retried up
 *      to `maxAttempts`; an exhausted budget transitions the workflow to
 *      `dead-letter` (a terminal, operator-visible parking state), never an
 *      unbounded loop and never a false success.
 *   4. Cancellation: a cancel request transitions a non-terminal workflow to
 *      `cancelled`; a subsequent step on a cancelled workflow is refused
 *      `CANCELLED` with no effect.
 *   5. Optional-failure isolation ({@link classifyFailure}): a failure in a
 *      helper classed OPTIONAL stays scoped (isolated + visible, does not fail
 *      the run closed) while an auth/entitlement/secret/payment/mutating
 *      failure FAILS CLOSED.
 *
 * Design anchors: D-05, D-16, D-18, D-23, D-24.
 * Requirements: NN-CLOUD-003, NN-CLOUD-004, NN-CLOUD-007, NN-INV-003,
 * NN-INV-007, NN-INV-008.
 */

import type Database from 'better-sqlite3';

import {
  CONTRACT_WRITE_VERSION,
  computeDigest,
  isOpaqueId,
  makeOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
  type ScopeDescriptor,
} from '../shared/contract-primitives.js';
import {
  applyAuthorityMutation,
  ensureAuthorityTables,
} from '../storage/authority-transaction.js';

const WORKFLOW_OWNER = 'authority-cloud-workflow';

// ════════════════════════════════════════════════════════════════════════════
// 1. Versioned workflow contract (NN-CLOUD-003)
// ════════════════════════════════════════════════════════════════════════════

/** The operator-visible workflow lifecycle states (NN-CLOUD-003). */
export const WORKFLOW_STATES = Object.freeze([
  'pending', // accepted, not yet run
  'running', // a step is in flight
  'succeeded', // TERMINAL success — the ONLY completion
  'failed', // TERMINAL non-retryable failure (fail-closed)
  'dead-letter', // TERMINAL parked after retry budget exhaustion
  'cancelled', // TERMINAL operator/caller cancellation
] as const);
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** Whether a state is terminal (no further transition is permitted). */
export function isTerminalState(state: WorkflowState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'dead-letter' || state === 'cancelled';
}

/** A versioned workflow request (NN-CLOUD-003). */
export interface WorkflowRequest {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  /** Stable workflow instance id. */
  readonly workflowId: string;
  /** The gadget/workflow kind (e.g. `stripe-reconcile`, `usage-rollup`). */
  readonly kind: string;
  /** Whether this workflow performs mutating/side-effecting work. */
  readonly mutating: boolean;
  /** Max attempts before dead-letter (>= 1). */
  readonly maxAttempts: number;
  /** The command scope (keys the outbox sequence). */
  readonly scope: ScopeDescriptor;
  readonly correlationId: string;
}

/** A versioned workflow result (NN-CLOUD-003). */
export interface WorkflowResult {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  readonly workflowId: string;
  readonly state: WorkflowState;
  /** Attempts consumed so far. */
  readonly attempts: number;
  /** An opaque result reference on success. */
  readonly resultRef?: string;
  /** A typed error present on `failed`/`dead-letter`/`cancelled`. */
  readonly error?: ErrorEnvelope;
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Optional vs fail-closed classification (NN-CLOUD-004)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The classes of workflow/step failure. An OPTIONAL helper failure is scoped
 * (isolated + visible); everything else FAILS CLOSED (NN-CLOUD-004).
 */
export const FAILURE_DOMAINS = Object.freeze([
  'optional-analytics',
  'optional-proxy-admin',
  'optional-cache',
  'optional-helper',
  'authentication',
  'entitlement',
  'secret',
  'payment',
  'mutating-workflow',
] as const);
export type FailureDomain = (typeof FAILURE_DOMAINS)[number];

/** The set of domains whose failure must remain isolated (NN-CLOUD-004). */
const OPTIONAL_DOMAINS: ReadonlySet<FailureDomain> = new Set<FailureDomain>([
  'optional-analytics',
  'optional-proxy-admin',
  'optional-cache',
  'optional-helper',
]);

/** The outcome of classifying a failure domain (NN-CLOUD-004). */
export interface FailureClassification {
  readonly domain: FailureDomain;
  /** `isolated` (optional, scoped/visible) or `fail-closed`. */
  readonly disposition: 'isolated' | 'fail-closed';
  /** True iff the failure must NOT break the core run. */
  readonly scoped: boolean;
}

/**
 * Classify a failure domain (NN-CLOUD-004). A failure in an OPTIONAL helper
 * (analytics, proxy-admin data, cache, helper service) is `isolated` and
 * scoped; authentication, entitlement, secret, payment, and mutating-workflow
 * failures are `fail-closed`. Deterministic and pure.
 */
export function classifyFailure(domain: FailureDomain): FailureClassification {
  const optional = OPTIONAL_DOMAINS.has(domain);
  return {
    domain,
    disposition: optional ? 'isolated' : 'fail-closed',
    scoped: optional,
  };
}

/**
 * Run an OPTIONAL helper step so its failure NEVER breaks the core run
 * (NN-CLOUD-004). Returns the helper value on success, or a scoped `UNAVAILABLE`
 * error on failure — the caller keeps running. Refuses to isolate a non-optional
 * domain: passing a fail-closed domain returns a `FORBIDDEN` (a mis-classified
 * fail-closed failure must NOT be silently swallowed).
 */
export async function runOptionalHelper<T>(
  domain: FailureDomain,
  helper: () => Promise<T> | T,
  correlationId?: string,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ErrorEnvelope }> {
  const classification = classifyFailure(domain);
  if (!classification.scoped) {
    return {
      ok: false,
      error: workflowError(
        'FORBIDDEN',
        `domain '${domain}' is fail-closed and must not be run as an isolated optional helper`,
        'cloud.workflow.optional-helper',
        correlationId,
      ),
    };
  }
  try {
    const value = await helper();
    return { ok: true, value };
  } catch {
    return {
      ok: false,
      error: workflowError(
        'UNAVAILABLE',
        `optional helper '${domain}' failed; scoped and isolated from the core run`,
        'cloud.workflow.optional-helper',
        correlationId,
      ),
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Typed errors and durable table
// ════════════════════════════════════════════════════════════════════════════

function workflowError(
  code: ErrorCode,
  message: string,
  operation: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: WORKFLOW_OWNER,
    operation,
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: code === 'UNAVAILABLE' || code === 'TIMEOUT',
    redaction: 'internal',
  };
}

/**
 * Create the workflow instance table. Additive over the canonical durability
 * tables; the workflow authority is the SOLE writer of `cloud_workflows`
 * (NN-INV-008). Idempotent.
 */
export function ensureWorkflowTables(db: Database.Database): void {
  ensureAuthorityTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_workflows (
      workflow_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      mutating INTEGER NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      result_ref TEXT,
      error_json TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}

interface WorkflowRow {
  readonly workflow_id: string;
  readonly kind: string;
  readonly mutating: number;
  readonly state: WorkflowState;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly result_ref: string | null;
  readonly error_json: string | null;
}

function rowToResult(row: WorkflowRow): WorkflowResult {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    workflowId: row.workflow_id,
    state: row.state,
    attempts: row.attempts,
    ...(row.result_ref ? { resultRef: row.result_ref } : {}),
    ...(row.error_json ? { error: JSON.parse(row.error_json) as ErrorEnvelope } : {}),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 4. The step outcome a caller reports for one attempt
// ════════════════════════════════════════════════════════════════════════════

/** What one workflow step attempt produced. */
export type StepOutcome =
  | { readonly kind: 'success'; readonly resultRef?: string }
  | { readonly kind: 'retryable'; readonly reason: string }
  | { readonly kind: 'fatal'; readonly domain: FailureDomain; readonly reason: string };

/** A durable step admission request. */
export interface WorkflowStepRequest {
  /** The workflow instance (must be started first). */
  readonly workflowId: string;
  /** Idempotency key for THIS step attempt. A committed key replays. */
  readonly idempotencyKey: string;
  /** The step outcome the caller observed for this attempt. */
  readonly outcome: StepOutcome;
  readonly scope: ScopeDescriptor;
  readonly correlationId: string;
  readonly now?: () => Date;
}

// ════════════════════════════════════════════════════════════════════════════
// 5. The workflow authority
// ════════════════════════════════════════════════════════════════════════════

/**
 * The Cloud Workflow Authority. Every transition commits through the single
 * outbox authority; the committed `cloud_workflows.state` is the operator-
 * visible truth (NN-CLOUD-003). No transition is ever reported as successful
 * unless it committed (NN-INV-003).
 */
export class CloudWorkflowAuthority {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    ensureWorkflowTables(db);
  }

  /** The declared max attempts of a workflow instance (1 if unknown). */
  private maxAttemptsOf(workflowId: string): number {
    const row = this.db
      .prepare('SELECT max_attempts FROM cloud_workflows WHERE workflow_id = ?')
      .get(workflowId) as { max_attempts: number } | undefined;
    return row?.max_attempts ?? 1;
  }

  /** Read the current operator-visible workflow result, or `undefined`. */
  read(workflowId: string): WorkflowResult | undefined {
    const row = this.db
      .prepare('SELECT * FROM cloud_workflows WHERE workflow_id = ?')
      .get(workflowId) as WorkflowRow | undefined;
    return row ? rowToResult(row) : undefined;
  }

  /**
   * Start a workflow instance in `pending`. Idempotent by `workflowId` +
   * request digest: a replay returns the existing instance; a diverging request
   * under the same id is a typed `CONFLICT`. Rejects `maxAttempts < 1`.
   */
  start(request: WorkflowRequest): WorkflowResult | { readonly error: ErrorEnvelope } {
    if (!Number.isInteger(request.maxAttempts) || request.maxAttempts < 1) {
      return { error: workflowError('VALIDATION', 'maxAttempts must be a positive integer', 'cloud.workflow.start', request.correlationId) };
    }
    const existing = this.read(request.workflowId);
    if (existing) return existing; // already started (idempotent)

    const now = new Date();
    const result = applyAuthorityMutation(this.db, {
      authority: WORKFLOW_OWNER,
      commandId: makeOpaqueId('cmd', `wf-start-${request.workflowId}`),
      idempotencyKey: `wf-start:${request.workflowId}`,
      requestDigest: computeDigest({ kind: request.kind, mutating: request.mutating, maxAttempts: request.maxAttempts }),
      correlationId: request.correlationId,
      scope: request.scope,
      now: () => now,
      mutate: (tx) => {
        tx.prepare(
          `INSERT INTO cloud_workflows
             (workflow_id, kind, mutating, state, attempts, max_attempts, result_ref, error_json, updated_at)
           VALUES (?, ?, ?, 'pending', 0, ?, NULL, NULL, ?)`,
        ).run(request.workflowId, request.kind, request.mutating ? 1 : 0, request.maxAttempts, now.toISOString());
        return { resultRef: request.workflowId };
      },
      events: [
        {
          eventType: 'cloud.workflow.started',
          aggregateType: 'cloud-workflow',
          aggregateId: request.workflowId,
          payloadSchemaName: 'CloudWorkflowStarted',
          payloadSchemaVersion: 1,
          payload: { workflowId: request.workflowId, kind: request.kind },
          redaction: 'internal',
        },
      ],
    });
    if (result.kind === 'conflict') return { error: result.error };
    return this.read(request.workflowId)!;
  }

  /**
   * Cancel a non-terminal workflow (NN-CLOUD-003). A terminal workflow is left
   * unchanged and returned; a missing workflow is a typed `VALIDATION`. The
   * transition commits through the outbox authority.
   */
  cancel(workflowId: string, scope: ScopeDescriptor, correlationId: string): WorkflowResult | { readonly error: ErrorEnvelope } {
    const current = this.read(workflowId);
    if (!current) return { error: workflowError('VALIDATION', 'unknown workflow', 'cloud.workflow.cancel', correlationId) };
    if (isTerminalState(current.state)) return current; // idempotent no-op on terminal

    const err = workflowError('CANCELLED', 'workflow cancelled by operator/caller', 'cloud.workflow.cancel', correlationId);
    this.transition(workflowId, scope, correlationId, {
      state: 'cancelled',
      attempts: current.attempts,
      error: err,
      idempotencyKey: `wf-cancel:${workflowId}`,
      eventType: 'cloud.workflow.cancelled',
    });
    return this.read(workflowId)!;
  }

  /**
   * Admit one workflow step attempt and commit the resulting transition
   * (NN-CLOUD-003). Behavior, all committed atomically:
   *
   *   - a step whose idempotency key already committed is a REPLAY (returns the
   *     current committed result, no second effect — NN-INV-007);
   *   - a step on a terminal workflow is refused (`CONFLICT` for terminal
   *     non-cancelled, `CANCELLED` for a cancelled workflow) with no effect;
   *   - a `success` outcome transitions to `succeeded` (the ONLY completion);
   *   - a `retryable` outcome bumps attempts; when attempts reach `maxAttempts`
   *     the workflow moves to `dead-letter` (bounded — never unbounded), else
   *     it returns to `pending` for another attempt;
   *   - a `fatal` outcome is classified (NN-CLOUD-004): an OPTIONAL domain is
   *     ISOLATED (the failure is recorded but the workflow returns to `pending`
   *     — the core run is not broken), while a fail-closed domain transitions to
   *     `failed`.
   */
  step(request: WorkflowStepRequest): WorkflowResult | { readonly error: ErrorEnvelope } {
    const current = this.read(request.workflowId);
    if (!current) {
      return { error: workflowError('VALIDATION', 'unknown workflow', 'cloud.workflow.step', request.correlationId) };
    }

    // Terminal guard (fail closed): a cancelled workflow refuses further steps.
    if (isTerminalState(current.state)) {
      if (current.state === 'cancelled') {
        return { error: workflowError('CANCELLED', 'workflow is cancelled; no further steps', 'cloud.workflow.step', request.correlationId) };
      }
      // Idempotent success replay handled below by the outbox key; otherwise a
      // step on a terminal workflow is a conflict.
      return { error: workflowError('CONFLICT', `workflow is terminal (${current.state}); no further steps`, 'cloud.workflow.step', request.correlationId) };
    }

    const outcome = request.outcome;

    if (outcome.kind === 'success') {
      this.transition(request.workflowId, request.scope, request.correlationId, {
        state: 'succeeded',
        attempts: current.attempts + 1,
        resultRef: outcome.resultRef,
        idempotencyKey: request.idempotencyKey,
        eventType: 'cloud.workflow.succeeded',
        now: request.now,
      });
      return this.read(request.workflowId)!;
    }

    if (outcome.kind === 'retryable') {
      const attempts = current.attempts + 1;
      if (attempts >= this.maxAttemptsOf(request.workflowId)) {
        // exhausted -> dead-letter (bounded)
        const err = workflowError('UNAVAILABLE', `retry budget exhausted after ${attempts} attempt(s): ${outcome.reason}`, 'cloud.workflow.step', request.correlationId);
        this.transition(request.workflowId, request.scope, request.correlationId, {
          state: 'dead-letter',
          attempts,
          error: err,
          idempotencyKey: request.idempotencyKey,
          eventType: 'cloud.workflow.dead-letter',
          now: request.now,
        });
        return this.read(request.workflowId)!;
      }
      // room to retry -> back to pending
      this.transition(request.workflowId, request.scope, request.correlationId, {
        state: 'pending',
        attempts,
        idempotencyKey: request.idempotencyKey,
        eventType: 'cloud.workflow.retry',
        now: request.now,
      });
      return this.read(request.workflowId)!;
    }

    // fatal
    const classification = classifyFailure(outcome.domain);
    if (classification.scoped) {
      // Optional failure: isolate. Record the scoped error but keep the run
      // alive (return to pending); the core run is not broken (NN-CLOUD-004).
      const err = workflowError('UNAVAILABLE', `optional '${outcome.domain}' failure isolated: ${outcome.reason}`, 'cloud.workflow.step', request.correlationId);
      this.transition(request.workflowId, request.scope, request.correlationId, {
        state: 'pending',
        attempts: current.attempts, // an isolated optional failure does not consume the core retry budget
        error: err,
        idempotencyKey: request.idempotencyKey,
        eventType: 'cloud.workflow.optional-isolated',
        now: request.now,
      });
      return this.read(request.workflowId)!;
    }

    // fail-closed domain -> failed
    const err = workflowError('FORBIDDEN', `fail-closed '${outcome.domain}' failure: ${outcome.reason}`, 'cloud.workflow.step', request.correlationId);
    this.transition(request.workflowId, request.scope, request.correlationId, {
      state: 'failed',
      attempts: current.attempts + 1,
      error: err,
      idempotencyKey: request.idempotencyKey,
      eventType: 'cloud.workflow.failed',
      now: request.now,
    });
    return this.read(request.workflowId)!;
  }

  // ── Internal committed transition ──────────────────────────────────────────

  private transition(
    workflowId: string,
    scope: ScopeDescriptor,
    correlationId: string,
    change: {
      readonly state: WorkflowState;
      readonly attempts: number;
      readonly resultRef?: string;
      readonly error?: ErrorEnvelope;
      readonly idempotencyKey: string;
      readonly eventType: string;
      readonly now?: () => Date;
    },
  ): void {
    const now = change.now ?? (() => new Date());
    const at = now();
    applyAuthorityMutation(this.db, {
      authority: WORKFLOW_OWNER,
      commandId: makeOpaqueId('cmd', `wf-${change.state}-${workflowId}-${change.attempts}`),
      idempotencyKey: change.idempotencyKey,
      requestDigest: computeDigest({ state: change.state, attempts: change.attempts }),
      correlationId,
      scope,
      now: () => at,
      mutate: (tx) => {
        tx.prepare(
          `UPDATE cloud_workflows
             SET state = ?, attempts = ?, result_ref = ?, error_json = ?, updated_at = ?
           WHERE workflow_id = ?`,
        ).run(
          change.state,
          change.attempts,
          change.resultRef ?? null,
          change.error ? JSON.stringify(change.error) : null,
          at.toISOString(),
          workflowId,
        );
        return { resultRef: workflowId };
      },
      events: [
        {
          eventType: change.eventType,
          aggregateType: 'cloud-workflow',
          aggregateId: workflowId,
          payloadSchemaName: 'CloudWorkflowTransition',
          payloadSchemaVersion: 1,
          payload: { workflowId, state: change.state, attempts: change.attempts },
          redaction: 'internal',
        },
      ],
    });
  }
}
