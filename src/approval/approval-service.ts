/**
 * ApprovalService — durable exact approvals and the CD-030 lifecycle
 * (FUT-PKG-04-SECURITY/T-006).
 *
 * The Approval Service is the sole writable owner of the `ApprovalRequest@1` /
 * `ApprovalDecision@1` class (D-07). It authorizes work ONLY through an exact
 * digest match on a normalized request (CD-010, NN-APPROVAL-002), commits
 * exactly ONE idempotent transition per decision over the single-writer
 * authority transaction (FUT-PKG-03-DURABILITY/T-001), and implements the
 * reload/quit/crash lifecycle of CD-030 (D-15):
 *
 *   - Renderer reload / unclean interruption leaves a pending request durable
 *     but `suspended`; it never simulates a decision (NN-APPROVAL-003).
 *   - On restart, a suspended request re-surfaces and its owning run resumes
 *     ONLY after revalidation of scope, action digest, plan revision, policy,
 *     entitlement, budget, credential reference, and expiry (NN-APPROVAL-003).
 *   - Explicit graceful quit, expiry, user/session cancel, or an unrecoverable
 *     owner creates a durable reject/cancel result before the owning run is
 *     unblocked (NN-APPROVAL-008). An unclean interruption never fabricates a
 *     cancellation (CD-030).
 *   - A duplicate within the legacy window remains a distinct auditable
 *     authority record even if it visually collapses; one decision never
 *     approves a distinct revision (NN-APPROVAL-005).
 *   - Stale, mismatched, or prose-only (natural-language) input NEVER authorizes
 *     — the heuristic adapter is display-only (NN-APPROVAL-006, CD-010).
 *
 * This module is additive: it owns two NEW canonical tables (`approval_requests`,
 * `approval_decisions`) and writes them ONLY through
 * {@link applyAuthorityMutation}, so the single-writer + idempotency discipline
 * of the durability layer gives it its "exactly one idempotent transition"
 * property for free. It never becomes a second writer for an existing table
 * (NN-INV-008). Rollback preserves pending/terminal records and may restore a
 * projection, never natural-language authority (task rollback rule).
 *
 * Design anchors: D-07 (`ApprovalRequest@1`/`ApprovalDecision@1`), D-11
 * (fail-closed tool sequence), D-15/CD-030 (lifecycle), D-16 (approvals).
 * Requirements: NN-APPROVAL-001–009, NN-EXEC-014, NN-EVENT-001, NN-COMPAT-005,
 * NN-INV-003/007/008. Canonical claims: CD-010, CD-030.
 */

import type Database from 'better-sqlite3';

import {
  CONTRACT_WRITE_VERSION,
  computeDigest,
  isOpaqueId,
  makeOpaqueId,
  serializeContract,
  type ErrorCode,
  type ErrorEnvelope,
  type ScopeDescriptor,
} from '../shared/contract-primitives.js';
import { applyAuthorityMutation, computeScopeKey } from '../storage/authority-transaction.js';
import {
  ApprovalRequestSchema,
  ApprovalDecisionSchema,
  computeApprovalDigest,
  isTerminalApprovalState,
  type ApprovalDecision,
  type ApprovalKind,
  type ApprovalOption,
  type ApprovalRequest,
  type ApprovalRisk,
  type ApprovalState,
  type DecisionOutcome,
  type NormalizedAction,
} from './approval-types.js';

const AUTHORITY = 'authority-approval';

// ─── Canonical durable tables (additive; solely owned here) ─────────────────

const APPROVAL_TABLES_DDL = `
  -- ApprovalRequest@1 durable record (NN-APPROVAL-001). One row per request;
  -- idempotency_key is UNIQUE so a re-raise of the same logical request finds
  -- the prior row rather than creating a second authority record.
  CREATE TABLE IF NOT EXISTS approval_requests (
    request_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    scope_key TEXT NOT NULL,
    owner TEXT NOT NULL,
    action_digest TEXT NOT NULL,
    plan_revision INTEGER NOT NULL,
    state TEXT NOT NULL,
    duplicate_of TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    record_json TEXT NOT NULL
  );

  -- ApprovalDecision@1 durable record (NN-APPROVAL-002). One row per committed
  -- decision. request_id is UNIQUE: exactly ONE terminal decision per request.
  CREATE TABLE IF NOT EXISTS approval_decisions (
    decision_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    bound_action_digest TEXT NOT NULL,
    outcome TEXT NOT NULL,
    channel TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    record_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_approval_requests_state
    ON approval_requests (state);
  CREATE INDEX IF NOT EXISTS idx_approval_requests_scope
    ON approval_requests (scope_key);
  CREATE INDEX IF NOT EXISTS idx_approval_requests_action
    ON approval_requests (action_digest);
`;

/** Create the approval tables/indexes if absent. Idempotent and additive. */
export function ensureApprovalTables(db: Database.Database): void {
  db.exec(APPROVAL_TABLES_DDL);
}

// ─── Typed errors (NN-INV-011) ───────────────────────────────────────────────

function approvalError(
  code: ErrorCode,
  message: string,
  correlationId: string,
  operation: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: AUTHORITY,
    operation,
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: code === 'VALIDATION',
    redaction: 'internal',
  };
}

/** A typed result: a value or a typed {@link ErrorEnvelope}. */
export type ApprovalResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ErrorEnvelope };

// ─── Row <-> record mapping ──────────────────────────────────────────────────

function readRequestById(
  db: Database.Database,
  requestId: string,
): ApprovalRequest | undefined {
  const row = db
    .prepare('SELECT record_json FROM approval_requests WHERE request_id = ?')
    .get(requestId) as { record_json: string } | undefined;
  return row ? (JSON.parse(row.record_json) as ApprovalRequest) : undefined;
}

function readRequestByIdempotencyKey(
  db: Database.Database,
  idempotencyKey: string,
): ApprovalRequest | undefined {
  const row = db
    .prepare('SELECT record_json FROM approval_requests WHERE idempotency_key = ?')
    .get(idempotencyKey) as { record_json: string } | undefined;
  return row ? (JSON.parse(row.record_json) as ApprovalRequest) : undefined;
}

/** Read the committed decision for a request, if any. */
export function readDecisionForRequest(
  db: Database.Database,
  requestId: string,
): ApprovalDecision | undefined {
  const row = db
    .prepare('SELECT record_json FROM approval_decisions WHERE request_id = ?')
    .get(requestId) as { record_json: string } | undefined;
  return row ? (JSON.parse(row.record_json) as ApprovalDecision) : undefined;
}

/** Read one request by id (read-only). */
export function getApprovalRequest(
  db: Database.Database,
  requestId: string,
): ApprovalRequest | undefined {
  return readRequestById(db, requestId);
}

function upsertRequestRow(tx: Database.Database, record: ApprovalRequest): void {
  tx.prepare(
    `INSERT INTO approval_requests
       (request_id, idempotency_key, scope_key, owner, action_digest, plan_revision,
        state, duplicate_of, created_at, expires_at, updated_at, record_json)
     VALUES (@requestId, @idempotencyKey, @scopeKey, @owner, @actionDigest, @planRevision,
        @state, @duplicateOf, @createdAt, @expiresAt, @updatedAt, @recordJson)
     ON CONFLICT(request_id) DO UPDATE SET
       state = excluded.state,
       duplicate_of = excluded.duplicate_of,
       updated_at = excluded.updated_at,
       record_json = excluded.record_json`,
  ).run({
    requestId: record.requestId,
    idempotencyKey: record.idempotencyKey,
    scopeKey: record.scopeKey,
    owner: record.owner,
    actionDigest: record.actionDigest,
    planRevision: record.planRevision,
    state: record.state,
    duplicateOf: record.duplicateOf ?? null,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    updatedAt: record.createdAt,
    recordJson: serializeContract(record, { allowSecret: true }),
  });
}

// ─── Create a request (NN-APPROVAL-001/005) ─────────────────────────────────

/** Input to {@link createApprovalRequest}. */
export interface CreateApprovalInput {
  readonly scope: ScopeDescriptor;
  readonly actor: string;
  readonly kind: ApprovalKind;
  /** The exact normalized action this request binds to (NN-APPROVAL-002). */
  readonly action: NormalizedAction;
  /** A safe, secret-free label of the action for audit/display. */
  readonly actionLabel: string;
  readonly options: readonly ApprovalOption[];
  readonly contextRefs?: readonly string[];
  readonly correlationId: string;
  /** Idempotency key for the request/command. A retry finds the prior record. */
  readonly idempotencyKey: string;
  readonly now?: () => Date;
}

/**
 * Create a durable `ApprovalRequest@1` in the `pending` state through the
 * single-writer authority transaction. The request's `actionDigest` is the
 * {@link computeApprovalDigest} of `action`, so the decision that authorizes it
 * must match that exact normalized action (NN-APPROVAL-002).
 *
 * Duplicate handling (NN-APPROVAL-005): if a non-terminal request with the same
 * `actionDigest` and owner already exists within the legacy 60-second window,
 * this request is recorded as a distinct auditable authority row whose
 * `duplicateOf` points at the primary — it MAY collapse visually, but authority
 * is never collapsed. The idempotency key of the command still guarantees a
 * literal retry (same key) does not create a second row.
 */
export function createApprovalRequest(
  db: Database.Database,
  input: CreateApprovalInput,
): ApprovalResult<ApprovalRequest> {
  const now = input.now ?? (() => new Date());

  // Literal retry: same idempotency key returns the prior request record.
  const existing = readRequestByIdempotencyKey(db, input.idempotencyKey);
  if (existing) {
    return { ok: true, value: existing };
  }

  const scopeKey = computeScopeKey(input.scope);
  const boundScopeKey = input.action.scopeKey;
  if (boundScopeKey !== scopeKey) {
    return {
      ok: false,
      error: approvalError(
        'VALIDATION',
        'action.scopeKey does not match the request scope (exact binding requires the true scope)',
        input.correlationId,
        'create-approval',
      ),
    };
  }

  const createdAt = now();
  const createdIso = createdAt.toISOString();
  const actionDigest = computeApprovalDigest(input.action);

  // Duplicate detection within the legacy 60s window (NN-APPROVAL-005).
  const duplicateOf = findVisualDuplicate(
    db,
    actionDigest,
    input.action.owner,
    createdAt,
  );

  const requestId = makeOpaqueId('appr', input.idempotencyKey);
  const candidate: ApprovalRequest = {
    schemaVersion: CONTRACT_WRITE_VERSION,
    requestId,
    revision: 0,
    scopeKey,
    actor: input.actor,
    kind: input.kind,
    actionDigest,
    actionLabel: input.actionLabel,
    risk: input.action.risk,
    owner: input.action.owner,
    planRevision: input.action.planRevision,
    options: [...input.options],
    contextRefs: input.contextRefs ? [...input.contextRefs] : [],
    createdAt: createdIso,
    expiresAt: input.action.expiresAt,
    state: 'pending',
    idempotencyKey: input.idempotencyKey,
    ...(duplicateOf !== undefined ? { duplicateOf } : {}),
    redaction: 'internal',
  };

  const parsed = ApprovalRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      error: approvalError(
        'VALIDATION',
        `invalid ApprovalRequest: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        input.correlationId,
        'create-approval',
      ),
    };
  }
  const record = parsed.data;

  const outcome = applyAuthorityMutation(db, {
    authority: AUTHORITY,
    commandId: makeOpaqueId('cmd', `create${input.idempotencyKey}`),
    idempotencyKey: `approval-create:${input.idempotencyKey}`,
    requestDigest: computeDigest({ op: 'create', actionDigest, requestId }),
    correlationId: input.correlationId,
    scope: input.scope,
    mutate: (tx) => {
      upsertRequestRow(tx, record);
      return { resultRef: requestId };
    },
    events: [
      {
        eventType: 'approval.requested',
        aggregateType: 'approval',
        aggregateId: requestId,
        payloadSchemaName: 'ApprovalRequested',
        payloadSchemaVersion: 1,
        payload: { requestId, actionDigest, kind: input.kind, risk: input.action.risk },
        redaction: 'internal',
      },
    ],
    now,
  });

  if (outcome.kind === 'conflict') {
    return { ok: false, error: outcome.error };
  }
  return { ok: true, value: record };
}

/**
 * Find a still-pending/suspended request with the same action digest and owner
 * created within the legacy 60-second duplicate window. Returns its request id
 * so the new request can record `duplicateOf` (NN-APPROVAL-005) — a visual
 * hint only, never an authority merge.
 */
function findVisualDuplicate(
  db: Database.Database,
  actionDigest: string,
  owner: string,
  now: Date,
): string | undefined {
  const rows = db
    .prepare(
      `SELECT record_json FROM approval_requests
       WHERE action_digest = ? AND owner = ? AND state IN ('pending','suspended')
       ORDER BY created_at ASC`,
    )
    .all(actionDigest, owner) as { record_json: string }[];
  const windowMs = 60_000;
  for (const row of rows) {
    const rec = JSON.parse(row.record_json) as ApprovalRequest;
    const age = now.getTime() - new Date(rec.createdAt).getTime();
    if (age >= 0 && age <= windowMs && rec.duplicateOf === undefined) {
      return rec.requestId;
    }
  }
  return undefined;
}

// ─── Decide: exactly one idempotent transition, exact-digest bound ──────────

/** Input to {@link decideApproval}. */
export interface DecideApprovalInput {
  readonly requestId: string;
  /** The exact action digest the caller believes it is authorizing. */
  readonly boundActionDigest: string;
  /** The plan revision at decision time; must match the request. */
  readonly boundPlanRevision: number;
  readonly outcome: DecisionOutcome;
  readonly selectedOptionId: string;
  /** The user actor producing an explicit typed decision. */
  readonly decidedBy: string;
  readonly freeText?: string;
  readonly correlationId: string;
  readonly now?: () => Date;
}

/**
 * Commit a typed `ApprovalDecision@1`, the ONE authorizing path (CD-010).
 *
 * Fail-closed order (NN-APPROVAL-002/006, NN-INV-001):
 *   1. the request must exist and be non-terminal (`pending`/`suspended`);
 *   2. the request must not be expired (an expired request cannot be approved —
 *      it can only be terminated by {@link expireApproval});
 *   3. `boundActionDigest` MUST equal the request's `actionDigest`, and
 *      `boundPlanRevision` MUST equal the request's `planRevision` — any
 *      mismatch is a stale/mismatched decision and is REJECTED with no effect;
 *   4. the decision is a `typed-user-action` (this API never mints a
 *      heuristic-display decision; NN-APPROVAL-006).
 *
 * On success exactly ONE terminal transition is committed over the single-writer
 * authority transaction: the request row flips to its terminal state and the
 * `ApprovalDecision@1` row is inserted (UNIQUE on `request_id`), atomically. A
 * second decide for the same request replays the prior decision idempotently
 * rather than committing a second transition (NN-INV-007).
 */
export function decideApproval(
  db: Database.Database,
  input: DecideApprovalInput,
): ApprovalResult<ApprovalDecision> {
  const now = input.now ?? (() => new Date());
  const request = readRequestById(db, input.requestId);
  if (!request) {
    return {
      ok: false,
      error: approvalError('VALIDATION', 'unknown approval request', input.correlationId, 'decide-approval'),
    };
  }

  // Idempotent replay: a request already terminal returns its committed decision
  // without a second transition (NN-INV-007). A distinct request is untouched.
  const prior = readDecisionForRequest(db, input.requestId);
  if (prior) {
    return { ok: true, value: prior };
  }

  if (isTerminalApprovalState(request.state)) {
    // Terminal state with no decision row is impossible in normal flow, but
    // fail closed: never authorize.
    return {
      ok: false,
      error: approvalError(
        'CONFLICT',
        `request is already ${request.state}`,
        input.correlationId,
        'decide-approval',
      ),
    };
  }

  // Expiry guard: an expired request can never be approved.
  if (input.outcome === 'approved' && new Date(request.expiresAt).getTime() <= now().getTime()) {
    return {
      ok: false,
      error: approvalError(
        'CONFLICT',
        'approval request has expired; a decision can no longer approve it',
        input.correlationId,
        'decide-approval',
      ),
    };
  }

  // Exact binding (NN-APPROVAL-002): stale/mismatched decisions never authorize.
  if (input.outcome === 'approved') {
    if (input.boundActionDigest !== request.actionDigest) {
      return {
        ok: false,
        error: approvalError(
          'CONFLICT',
          'decision action digest does not match the request; the action changed and the decision is invalid',
          input.correlationId,
          'decide-approval',
        ),
      };
    }
    if (input.boundPlanRevision !== request.planRevision) {
      return {
        ok: false,
        error: approvalError(
          'CONFLICT',
          'decision plan revision does not match the request; the plan changed and the decision is invalid',
          input.correlationId,
          'decide-approval',
        ),
      };
    }
    // The selected option must be an approve option of this request.
    const opt = request.options.find((o) => o.optionId === input.selectedOptionId);
    if (!opt || opt.effect !== 'approve') {
      return {
        ok: false,
        error: approvalError(
          'VALIDATION',
          'selected option is not a valid approve option of this request',
          input.correlationId,
          'decide-approval',
        ),
      };
    }
  }

  const terminalState: ApprovalState =
    input.outcome === 'approved' ? 'approved' : input.outcome === 'rejected' ? 'rejected' : 'cancelled';

  const decision = buildDecision({
    request,
    boundActionDigest: request.actionDigest,
    boundPlanRevision: request.planRevision,
    outcome: input.outcome,
    selectedOptionId: input.selectedOptionId,
    channel: 'typed-user-action',
    decidedBy: input.decidedBy,
    freeText: input.freeText,
    terminalReason: 'user-decision',
    now,
  });
  if (!decision.ok) return decision;

  return commitTerminal(db, request, decision.value, terminalState, input.correlationId, 'decide-approval', now);
}

// ─── Expiry / cancel (NN-APPROVAL-008) ──────────────────────────────────────

/** The non-user terminal reasons that create a durable reject/cancel result. */
export type TerminalReason =
  | 'expiry'
  | 'user-cancel'
  | 'session-cancel'
  | 'unrecoverable-owner'
  | 'graceful-quit';

/**
 * Terminate a pending/suspended request with a durable reject/cancel decision
 * for a non-user reason (NN-APPROVAL-008). No cancellation path implies
 * approval: the outcome is always `rejected` (expiry) or `cancelled` (the
 * cancel reasons), never `approved`. Exactly one idempotent transition; a
 * request already terminal replays its decision.
 */
export function terminateApproval(
  db: Database.Database,
  input: {
    readonly requestId: string;
    readonly reason: TerminalReason;
    readonly correlationId: string;
    readonly now?: () => Date;
  },
): ApprovalResult<ApprovalDecision> {
  const now = input.now ?? (() => new Date());
  const request = readRequestById(db, input.requestId);
  if (!request) {
    return {
      ok: false,
      error: approvalError('VALIDATION', 'unknown approval request', input.correlationId, 'terminate-approval'),
    };
  }

  const prior = readDecisionForRequest(db, input.requestId);
  if (prior) {
    return { ok: true, value: prior };
  }

  const outcome: DecisionOutcome = input.reason === 'expiry' ? 'rejected' : 'cancelled';
  const terminalState: ApprovalState = outcome === 'rejected' ? 'rejected' : 'cancelled';

  const decision = buildDecision({
    request,
    boundActionDigest: request.actionDigest,
    boundPlanRevision: request.planRevision,
    outcome,
    // A non-user terminal has no user-selected option; use a reserved id.
    selectedOptionId: `terminal:${input.reason}`,
    channel: 'typed-user-action',
    decidedBy: AUTHORITY,
    terminalReason: input.reason,
    now,
  });
  if (!decision.ok) return decision;

  return commitTerminal(
    db,
    request,
    decision.value,
    terminalState,
    input.correlationId,
    'terminate-approval',
    now,
  );
}

/**
 * Expire a request whose expiry instant has passed (NN-APPROVAL-008). A no-op
 * that returns `ok:false` VALIDATION if the request is not yet expired, so a
 * caller cannot force-expire a live request. Commits a durable `rejected`
 * result with reason `expiry`.
 */
export function expireApproval(
  db: Database.Database,
  input: { readonly requestId: string; readonly correlationId: string; readonly now?: () => Date },
): ApprovalResult<ApprovalDecision> {
  const now = input.now ?? (() => new Date());
  const request = readRequestById(db, input.requestId);
  if (!request) {
    return {
      ok: false,
      error: approvalError('VALIDATION', 'unknown approval request', input.correlationId, 'expire-approval'),
    };
  }
  const prior = readDecisionForRequest(db, input.requestId);
  if (prior) return { ok: true, value: prior };

  if (new Date(request.expiresAt).getTime() > now().getTime()) {
    return {
      ok: false,
      error: approvalError('VALIDATION', 'request has not expired yet', input.correlationId, 'expire-approval'),
    };
  }
  return terminateApproval(db, { requestId: input.requestId, reason: 'expiry', correlationId: input.correlationId, now });
}

// ─── Suspension / resume (CD-030, NN-APPROVAL-003) ──────────────────────────

/**
 * Suspend a pending request on renderer reload or an unclean interruption
 * (NN-APPROVAL-003). This flips a `pending` request to `suspended` WITHOUT
 * committing a decision — the request stays durable and never implies a
 * cancellation (CD-030). Idempotent: a request already suspended or terminal is
 * left unchanged. This is the ONLY transition an unclean interruption may cause;
 * it can never fabricate a terminal decision.
 */
export function suspendPendingRequests(
  db: Database.Database,
  input: { readonly correlationId: string; readonly now?: () => Date } = { correlationId: 'corr-suspend' },
): number {
  const now = input.now ?? (() => new Date());
  const rows = db
    .prepare(`SELECT record_json FROM approval_requests WHERE state = 'pending'`)
    .all() as { record_json: string }[];
  let suspended = 0;
  for (const row of rows) {
    const record = JSON.parse(row.record_json) as ApprovalRequest;
    const updated: ApprovalRequest = { ...record, state: 'suspended' };
    const outcome = applyAuthorityMutation(db, {
      authority: AUTHORITY,
      commandId: makeOpaqueId('cmd', `suspend${record.requestId}`),
      idempotencyKey: `approval-suspend:${record.requestId}`,
      requestDigest: computeDigest({ op: 'suspend', requestId: record.requestId }),
      correlationId: input.correlationId,
      scope: syntheticScope(record),
      mutate: (tx) => {
        upsertRequestRow(tx, updated);
      },
      now,
    });
    if (outcome.kind === 'committed') suspended += 1;
  }
  return suspended;
}

/**
 * The result of a resume attempt for one suspended request (NN-APPROVAL-003).
 * A request resumes ONLY after every named check revalidates; otherwise the
 * service commits a typed cancellation with the failing reason. Recovery never
 * invents a decision.
 */
export type ResumeResult =
  | { readonly kind: 'resumed'; readonly request: ApprovalRequest }
  | { readonly kind: 'cancelled'; readonly decision: ApprovalDecision; readonly failing: string }
  | { readonly kind: 'noop'; readonly reason: string };

/**
 * The revalidation inputs the owning execution supplies at restart. Every field
 * MUST still match the suspended request for it to resume (NN-APPROVAL-003):
 * scope, action digest, plan/authority revisions, policy, entitlement, budget,
 * credential reference, and non-expiry. Any mismatch (or an unrecoverable owner)
 * causes a typed cancellation rather than a resume — and NEVER an approval.
 */
export interface RevalidationInput {
  /** Whether the owning execution is recoverable at all (NN-APPROVAL-003). */
  readonly ownerRecoverable: boolean;
  readonly scopeKey: string;
  readonly actionDigest: string;
  readonly planRevision: number;
  /** Whether policy still permits the action. */
  readonly policyValid: boolean;
  /** Whether the entitlement still permits the action. */
  readonly entitlementValid: boolean;
  /** Whether the budget reservation is still valid. */
  readonly budgetValid: boolean;
  /** Whether the referenced credential is still valid. */
  readonly credentialValid: boolean;
}

/**
 * Attempt to resume ONE suspended request after an unclean interruption
 * (NN-APPROVAL-003, CD-030). The request re-surfaces and resumes only if:
 *   - it is `suspended` (a terminal/pending request is a no-op / already
 *     resolved),
 *   - a decision was NOT already committed before interruption (if it was, that
 *     decision is idempotently reused — never inferred from UI/clock),
 *   - the owner is recoverable AND every revalidation field matches AND the
 *     request has not expired.
 *
 * If revalidation fails for any reason, the service commits a durable typed
 * `cancelled` decision naming the failing check (`unrecoverable-owner` or a
 * mismatch reason) — recovery never invents an approval.
 */
export function resumeSuspendedRequest(
  db: Database.Database,
  input: { readonly requestId: string; readonly revalidation: RevalidationInput; readonly correlationId: string; readonly now?: () => Date },
): ResumeResult {
  const now = input.now ?? (() => new Date());
  const request = readRequestById(db, input.requestId);
  if (!request) return { kind: 'noop', reason: 'unknown request' };

  // A decision committed BEFORE interruption is idempotently reused, never
  // re-derived (CD-030 "a decision committed before interruption is
  // idempotently reused").
  const committed = readDecisionForRequest(db, input.requestId);
  if (committed) {
    return { kind: 'noop', reason: `decision already committed (${committed.outcome})` };
  }
  if (request.state !== 'suspended') {
    return { kind: 'noop', reason: `request is ${request.state}, not suspended` };
  }

  const failing = firstRevalidationFailure(request, input.revalidation, now());
  if (failing) {
    // Commit a typed cancellation naming the failing reason. Never an approval.
    const reason: TerminalReason =
      failing === 'owner-unrecoverable' ? 'unrecoverable-owner' : 'session-cancel';
    const decision = buildDecision({
      request,
      boundActionDigest: request.actionDigest,
      boundPlanRevision: request.planRevision,
      outcome: 'cancelled',
      selectedOptionId: `terminal:${reason}`,
      channel: 'typed-user-action',
      decidedBy: AUTHORITY,
      terminalReason: reason,
      now,
    });
    if (!decision.ok) {
      return { kind: 'noop', reason: 'failed to build cancellation decision' };
    }
    const committedCancel = commitTerminal(
      db,
      request,
      decision.value,
      'cancelled',
      input.correlationId,
      'resume-approval',
      now,
    );
    if (!committedCancel.ok) {
      return { kind: 'noop', reason: 'failed to commit cancellation' };
    }
    return { kind: 'cancelled', decision: committedCancel.value, failing };
  }

  // Revalidation passed: re-surface the request as `pending` again so the owning
  // run can resume the same idempotent run.
  const resumed: ApprovalRequest = { ...request, state: 'pending' };
  const outcome = applyAuthorityMutation(db, {
    authority: AUTHORITY,
    commandId: makeOpaqueId('cmd', `resume${request.requestId}`),
    idempotencyKey: `approval-resume:${request.requestId}`,
    requestDigest: computeDigest({ op: 'resume', requestId: request.requestId }),
    correlationId: input.correlationId,
    scope: syntheticScope(request),
    mutate: (tx) => {
      upsertRequestRow(tx, resumed);
    },
    events: [
      {
        eventType: 'approval.resumed',
        aggregateType: 'approval',
        aggregateId: request.requestId,
        payloadSchemaName: 'ApprovalResumed',
        payloadSchemaVersion: 1,
        payload: { requestId: request.requestId },
        redaction: 'internal',
      },
    ],
    now,
  });
  if (outcome.kind === 'conflict') {
    return { kind: 'noop', reason: 'resume conflicted' };
  }
  return { kind: 'resumed', request: resumed };
}

/**
 * Return the first failing revalidation check, or `undefined` if all pass. The
 * order mirrors NN-APPROVAL-003's enumerated checks. `owner-unrecoverable` is
 * checked first because an unrecoverable owner cannot resume regardless of the
 * rest.
 */
function firstRevalidationFailure(
  request: ApprovalRequest,
  reval: RevalidationInput,
  now: Date,
): string | undefined {
  if (!reval.ownerRecoverable) return 'owner-unrecoverable';
  if (reval.scopeKey !== request.scopeKey) return 'scope-mismatch';
  if (reval.actionDigest !== request.actionDigest) return 'action-digest-mismatch';
  if (reval.planRevision !== request.planRevision) return 'plan-revision-mismatch';
  if (!reval.policyValid) return 'policy-invalid';
  if (!reval.entitlementValid) return 'entitlement-invalid';
  if (!reval.budgetValid) return 'budget-invalid';
  if (!reval.credentialValid) return 'credential-invalid';
  if (new Date(request.expiresAt).getTime() <= now.getTime()) return 'expired';
  return undefined;
}

// ─── Graceful vs unclean shutdown (CD-030) ──────────────────────────────────

/** The outcome of a graceful shutdown pass over pending requests. */
export interface GracefulShutdownResult {
  /** The decisions committed (one per affected request). */
  readonly cancelled: readonly ApprovalDecision[];
}

/**
 * Explicit graceful quit (CD-030 / NN-APPROVAL-008): durably cancel/reject every
 * pending or suspended request BEFORE the owning runs are unblocked or
 * terminated. Each affected request receives a durable `cancelled` decision with
 * reason `graceful-quit`. This is the ONLY path that turns "app is quitting"
 * into a committed cancellation — and it commits BEFORE reporting a clean
 * shutdown.
 *
 * Contrast {@link suspendPendingRequests}, which models an UNCLEAN interruption:
 * it only suspends, never cancels, so a crash can never fabricate a shutdown
 * decision (CD-030).
 */
export function gracefulShutdown(
  db: Database.Database,
  input: { readonly correlationId: string; readonly now?: () => Date } = { correlationId: 'corr-quit' },
): GracefulShutdownResult {
  const now = input.now ?? (() => new Date());
  const rows = db
    .prepare(`SELECT request_id FROM approval_requests WHERE state IN ('pending','suspended')`)
    .all() as { request_id: string }[];
  const cancelled: ApprovalDecision[] = [];
  for (const row of rows) {
    const result = terminateApproval(db, {
      requestId: row.request_id,
      reason: 'graceful-quit',
      correlationId: input.correlationId,
      now,
    });
    if (result.ok) cancelled.push(result.value);
  }
  return { cancelled };
}

// ─── Shared: build + commit a decision (one idempotent transition) ──────────

function buildDecision(input: {
  readonly request: ApprovalRequest;
  readonly boundActionDigest: string;
  readonly boundPlanRevision: number;
  readonly outcome: DecisionOutcome;
  readonly selectedOptionId: string;
  readonly channel: 'typed-user-action' | 'heuristic-display';
  readonly decidedBy: string;
  readonly freeText?: string;
  readonly terminalReason:
    | 'user-decision'
    | 'expiry'
    | 'user-cancel'
    | 'session-cancel'
    | 'unrecoverable-owner'
    | 'graceful-quit';
  readonly now: () => Date;
}): ApprovalResult<ApprovalDecision> {
  const decidedAt = input.now().toISOString();
  const candidate: ApprovalDecision = {
    schemaVersion: CONTRACT_WRITE_VERSION,
    decisionId: makeOpaqueId('decn', `${input.request.requestId}${input.outcome}`),
    requestId: input.request.requestId,
    boundActionDigest: input.boundActionDigest,
    boundPlanRevision: input.boundPlanRevision,
    outcome: input.outcome,
    selectedOptionId: input.selectedOptionId,
    channel: input.channel,
    decidedBy: input.decidedBy,
    ...(input.freeText !== undefined ? { freeText: input.freeText } : {}),
    decidedAt,
    terminalReason: input.terminalReason,
    redaction: 'internal',
  };
  const parsed = ApprovalDecisionSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      error: approvalError(
        'VALIDATION',
        `invalid ApprovalDecision: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        input.request.requestId,
        'build-decision',
      ),
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Commit exactly one terminal transition (NN-INV-007): flip the request row to
 * `terminalState` and insert the `ApprovalDecision@1` row in the SAME
 * single-writer transaction. The decision table's `UNIQUE(request_id)` plus the
 * command idempotency key guarantee a second attempt cannot commit a second
 * decision.
 */
function commitTerminal(
  db: Database.Database,
  request: ApprovalRequest,
  decision: ApprovalDecision,
  terminalState: ApprovalState,
  correlationId: string,
  operation: string,
  now: () => Date,
): ApprovalResult<ApprovalDecision> {
  const updated: ApprovalRequest = { ...request, state: terminalState };
  try {
    const outcome = applyAuthorityMutation(db, {
      authority: AUTHORITY,
      commandId: makeOpaqueId('cmd', `${operation}${request.requestId}`),
      idempotencyKey: `approval-decide:${request.requestId}`,
      requestDigest: computeDigest({
        op: 'decide',
        requestId: request.requestId,
        outcome: decision.outcome,
        boundActionDigest: decision.boundActionDigest,
      }),
      correlationId,
      scope: syntheticScope(request),
      mutate: (tx) => {
        upsertRequestRow(tx, updated);
        tx.prepare(
          `INSERT INTO approval_decisions
             (decision_id, request_id, bound_action_digest, outcome, channel, decided_at, record_json)
           VALUES (@decisionId, @requestId, @boundActionDigest, @outcome, @channel, @decidedAt, @recordJson)`,
        ).run({
          decisionId: decision.decisionId,
          requestId: decision.requestId,
          boundActionDigest: decision.boundActionDigest,
          outcome: decision.outcome,
          channel: decision.channel,
          decidedAt: decision.decidedAt,
          recordJson: serializeContract(decision, { allowSecret: true }),
        });
        return { resultRef: decision.decisionId };
      },
      events: [
        {
          eventType: 'approval.decided',
          aggregateType: 'approval',
          aggregateId: request.requestId,
          payloadSchemaName: 'ApprovalDecided',
          payloadSchemaVersion: 1,
          payload: {
            requestId: request.requestId,
            outcome: decision.outcome,
            boundActionDigest: decision.boundActionDigest,
          },
          redaction: 'internal',
        },
      ],
      now,
    });
    if (outcome.kind === 'conflict') {
      return { ok: false, error: outcome.error };
    }
    if (outcome.kind === 'replayed') {
      // The transition already committed; return the durable decision.
      const durable = readDecisionForRequest(db, request.requestId);
      if (durable) return { ok: true, value: durable };
    }
    return { ok: true, value: decision };
  } catch (err) {
    // A UNIQUE(request_id) violation means a decision already committed
    // concurrently: reuse it idempotently rather than surfacing a raw error.
    const durable = readDecisionForRequest(db, request.requestId);
    if (durable) return { ok: true, value: durable };
    return {
      ok: false,
      error: approvalError(
        'INTEGRITY',
        `failed to commit approval decision: ${err instanceof Error ? err.message : 'unknown'}`,
        correlationId,
        operation,
      ),
    };
  }
}

/**
 * Rebuild a minimal `ScopeDescriptor` sufficient for {@link computeScopeKey} to
 * reproduce the request's stored `scopeKey`. The approval row persists only the
 * scope key (never the full scope), so for the internal lifecycle transitions we
 * carry the key directly by minting a scope whose `owner`/`userId` encode it.
 *
 * NOTE: the sequence allocation in the durability layer keys on the scope key;
 * because we do not have the original anchors here, we pass a scope whose digest
 * is deterministic per request. This keeps each request's lifecycle events in
 * their own sequence lane without leaking or fabricating identity anchors.
 */
function syntheticScope(request: ApprovalRequest): ScopeDescriptor {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    userId: request.actor,
    owner: request.owner,
    allowedRoots: [],
    allowedDestinations: [],
  };
}

// ─── Read helpers (projection support) ──────────────────────────────────────

/** List requests in a given state (read-only projection support). */
export function listRequestsByState(
  db: Database.Database,
  state: ApprovalState,
): ApprovalRequest[] {
  const rows = db
    .prepare('SELECT record_json FROM approval_requests WHERE state = ? ORDER BY created_at')
    .all(state) as { record_json: string }[];
  return rows.map((r) => JSON.parse(r.record_json) as ApprovalRequest);
}

/** The risk tier helper: whether a request requires a typed decision. */
export function requiresTypedDecision(risk: ApprovalRisk): boolean {
  // High-risk work always requires an explicit typed decision (NN-APPROVAL-006).
  return risk === 'high';
}
