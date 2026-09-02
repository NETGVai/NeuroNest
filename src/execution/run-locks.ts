/**
 * RunLockManager — durable worktree / symbol locks with owner, range, version,
 * bounded lease, safe release, and stale-write detection
 * (FUT-PKG-06-EXECUTION/T-006).
 *
 * D-13 requires parallel mutations to use worktrees and/or symbol locks so that
 * concurrent runs on the SAME worktree/symbol never corrupt each other
 * (NN-ORCH-005). A lock has a stable owner/range/version, a bounded lease, a
 * safe release, and stale-write detection; ONE failed/cancelled run does not
 * terminate unrelated runs or discard their Change Sets (NN-WORKSPACE-007,
 * D-18).
 *
 * This module is a thin, additive authority over
 * {@link ../storage/authority-transaction}: it owns ONE new canonical table
 * (`run_locks`) and never becomes a second writer for a workspace/worktree
 * business table. Every mutation runs inside the single-writer,
 * idempotent-receipt transaction (D-08.2); a duplicated acquire click replays
 * the prior receipt (no second lock). A `run_locks` row is keyed by
 * `(resource_kind, resource_id, range_key)` UNIQUE so that two runs contending
 * for the same worktree/symbol range are serialized by the database itself —
 * the second acquire returns a typed `CONFLICT` (blocked) and NEITHER run's
 * work is discarded.
 *
 * Design anchors: D-08 (mutation transaction), D-13 (parallel orchestration,
 * conflict isolation), D-18 (failure isolation). Requirements: NN-ORCH-005,
 * NN-WORKSPACE-007, NN-INV-003/007/008/012.
 */

import type Database from 'better-sqlite3';

import {
  computeDigest,
  makeOpaqueId,
  serializeContract,
  type ErrorCode,
  type ScopeDescriptor,
} from '../shared/contract-primitives';
import {
  applyAuthorityMutation,
  ensureAuthorityTables,
  type AuthorityMutationResult,
} from '../storage/authority-transaction';

const AUTHORITY_ID = 'authority-orchestration';

// ─── Canonical durable table (additive) ──────────────────────────────────────

const RUN_LOCKS_DDL = `
  CREATE TABLE IF NOT EXISTS run_locks (
    lock_id TEXT PRIMARY KEY,
    resource_kind TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    range_key TEXT NOT NULL,
    owner_run_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    lease_until_ms INTEGER NOT NULL,
    state TEXT NOT NULL,
    record_json TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    UNIQUE (resource_kind, resource_id, range_key)
  );

  CREATE INDEX IF NOT EXISTS idx_run_locks_owner ON run_locks (owner_run_id);
  CREATE INDEX IF NOT EXISTS idx_run_locks_resource
    ON run_locks (resource_kind, resource_id);
`;

/** Create the canonical lock table (idempotent, additive). */
export function ensureRunLockTables(db: Database.Database): void {
  ensureAuthorityTables(db);
  db.exec(RUN_LOCKS_DDL);
}

// ─── Lock contract ────────────────────────────────────────────────────────────

/** The resource classes a run can lock (NN-ORCH-005). */
export type LockResourceKind = 'worktree' | 'symbol';

/** The lifecycle of a lock. `held` blocks a competing acquire; the terminals do not. */
export type LockState = 'held' | 'released' | 'expired';

/**
 * A `RunLock@1` record. A lock is identified by a stable owner (`ownerRunId`),
 * a resource `range` (the worktree id, or a `symbol@path` range), and a
 * monotonic `version` bumped on every safe release/refresh so a stale writer is
 * detected (NN-ORCH-005).
 */
export interface RunLock {
  readonly schemaVersion: 1;
  readonly lockId: string;
  readonly resourceKind: LockResourceKind;
  readonly resourceId: string;
  /** A stable sub-range within the resource (e.g. a symbol path). */
  readonly rangeKey: string;
  readonly ownerRunId: string;
  readonly version: number;
  readonly leaseUntilMs: number;
  readonly state: LockState;
  readonly acquiredAt: string;
  readonly redaction: 'internal';
}

// ─── Typed outcomes ───────────────────────────────────────────────────────────

export interface RunLockError {
  readonly code: ErrorCode;
  readonly message: string;
}

export type RunLockOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly replayed: boolean }
  | { readonly ok: false; readonly error: RunLockError };

function fail<T>(code: ErrorCode, message: string): RunLockOutcome<T> {
  return { ok: false, error: { code, message } };
}

function mapResult<T>(result: AuthorityMutationResult, value: T): RunLockOutcome<T> {
  if (result.kind === 'conflict') {
    return { ok: false, error: { code: result.error.code, message: result.error.message } };
  }
  return { ok: true, value, replayed: result.kind === 'replayed' };
}

// ─── Read helpers ─────────────────────────────────────────────────────────────

interface LockRow {
  readonly record_json: string;
  readonly state: string;
  readonly lease_until_ms: number;
}

function rangeKeyOf(rangeKey?: string): string {
  return rangeKey && rangeKey.length > 0 ? rangeKey : '*';
}

/** Read the current lock on a resource range, or `undefined` when none. */
export function readLock(
  db: Database.Database,
  resourceKind: LockResourceKind,
  resourceId: string,
  rangeKey?: string,
): RunLock | undefined {
  const row = db
    .prepare(
      `SELECT record_json FROM run_locks
       WHERE resource_kind = ? AND resource_id = ? AND range_key = ?`,
    )
    .get(resourceKind, resourceId, rangeKeyOf(rangeKey)) as
    | { record_json: string }
    | undefined;
  return row ? (JSON.parse(row.record_json) as RunLock) : undefined;
}

/** All locks currently held by a run (for release-on-terminate). */
export function readLocksForRun(db: Database.Database, ownerRunId: string): RunLock[] {
  const rows = db
    .prepare('SELECT record_json FROM run_locks WHERE owner_run_id = ? ORDER BY lock_id')
    .all(ownerRunId) as { record_json: string }[];
  return rows.map((r) => JSON.parse(r.record_json) as RunLock);
}

/**
 * Whether a stored lock is effectively active at `nowMs`: state `held` AND its
 * lease has not elapsed. An elapsed lease is treated as reclaimable (a crashed
 * owner never holds a resource forever — bounded lease, NN-ORCH-005).
 */
function isActiveLock(row: LockRow, nowMs: number): boolean {
  return row.state === 'held' && row.lease_until_ms > nowMs;
}

// ─── Command context ───────────────────────────────────────────────────────────

export interface LockCommandContext {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly scope: ScopeDescriptor;
  readonly now?: () => Date;
}

function requestDigest(payload: unknown): string {
  return computeDigest(payload);
}

// ─── Acquire (NN-ORCH-005 isolation) ─────────────────────────────────────────

export interface AcquireLockInput extends LockCommandContext {
  readonly resourceKind: LockResourceKind;
  readonly resourceId: string;
  readonly rangeKey?: string;
  readonly ownerRunId: string;
  /** Lease duration in ms; the lock auto-expires after this (bounded lease). */
  readonly leaseMs: number;
  /** Injectable monotonic clock in ms for deterministic tests. */
  readonly nowMs?: () => number;
}

/**
 * Acquire a lock on a worktree or symbol range for `ownerRunId`
 * (NN-ORCH-005). Isolation rule:
 *
 *   - if NO active lock exists on the range, a new `held` lock at version 1 is
 *     committed;
 *   - if an active lock is held by a DIFFERENT run, the acquire returns a typed
 *     `CONFLICT` (blocked) — the competing run's lock and its in-flight work are
 *     untouched (no discard of unrelated work);
 *   - if the SAME run already holds the range, the lease is refreshed and the
 *     version bumps (re-entrant refresh, not a second lock);
 *   - if the prior lock's lease has ELAPSED, it is reclaimed (bounded lease):
 *     the row is replaced at a bumped version, so the previous owner's later
 *     write is detected as stale.
 *
 * All of this happens inside the single-writer transaction, and the
 * `(resource_kind, resource_id, range_key)` UNIQUE constraint guarantees that
 * two concurrent acquires cannot both succeed — the database serializes them.
 */
export function acquireLock(
  db: Database.Database,
  input: AcquireLockInput,
): RunLockOutcome<RunLock> {
  if (input.leaseMs <= 0 || !Number.isFinite(input.leaseMs)) {
    return fail('VALIDATION', 'leaseMs must be a positive finite number (bounded lease)');
  }
  const nowMs = (input.nowMs ?? (() => Date.now()))();
  const rangeKey = rangeKeyOf(input.rangeKey);
  const nowIso = (input.now ?? (() => new Date()))().toISOString();

  const existingRow = db
    .prepare(
      `SELECT record_json, state, lease_until_ms FROM run_locks
       WHERE resource_kind = ? AND resource_id = ? AND range_key = ?`,
    )
    .get(input.resourceKind, input.resourceId, rangeKey) as LockRow | undefined;

  if (existingRow && isActiveLock(existingRow, nowMs)) {
    const existing = JSON.parse(existingRow.record_json) as RunLock;
    if (existing.ownerRunId !== input.ownerRunId) {
      // Active lock held by a different run — conflict, block, discard nothing.
      return fail(
        'CONFLICT',
        `lock on ${input.resourceKind} '${input.resourceId}' range '${rangeKey}' is held by run '${existing.ownerRunId}'`,
      );
    }
  }

  const priorVersion = existingRow
    ? (JSON.parse(existingRow.record_json) as RunLock).version
    : 0;
  const version = priorVersion + 1;
  const record: RunLock = {
    schemaVersion: 1,
    lockId: makeOpaqueId('lock', `${input.resourceKind}${input.resourceId}${rangeKey}${version}`),
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    rangeKey,
    ownerRunId: input.ownerRunId,
    version,
    leaseUntilMs: nowMs + input.leaseMs,
    state: 'held',
    acquiredAt: nowIso,
    redaction: 'internal',
  };

  const result = applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({
      op: 'acquire-lock',
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      rangeKey,
      ownerRunId: input.ownerRunId,
    }),
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      tx.prepare(
        `INSERT INTO run_locks
           (lock_id, resource_kind, resource_id, range_key, owner_run_id, version,
            lease_until_ms, state, record_json, acquired_at)
         VALUES (@lockId, @resourceKind, @resourceId, @rangeKey, @ownerRunId, @version,
            @leaseUntilMs, @state, @recordJson, @acquiredAt)
         ON CONFLICT(resource_kind, resource_id, range_key) DO UPDATE SET
            lock_id = excluded.lock_id,
            owner_run_id = excluded.owner_run_id,
            version = excluded.version,
            lease_until_ms = excluded.lease_until_ms,
            state = excluded.state,
            record_json = excluded.record_json,
            acquired_at = excluded.acquired_at`,
      ).run({
        lockId: record.lockId,
        resourceKind: record.resourceKind,
        resourceId: record.resourceId,
        rangeKey: record.rangeKey,
        ownerRunId: record.ownerRunId,
        version: record.version,
        leaseUntilMs: record.leaseUntilMs,
        state: record.state,
        recordJson: serializeContract(record),
        acquiredAt: record.acquiredAt,
      });
      return { resultRef: record.lockId };
    },
    events: [
      {
        eventType: 'run.lock.acquired',
        aggregateType: 'run-lock',
        aggregateId: record.lockId,
        payloadSchemaName: 'RunLock',
        payloadSchemaVersion: 1,
        payload: {
          resourceKind: record.resourceKind,
          resourceId: record.resourceId,
          rangeKey,
          ownerRunId: record.ownerRunId,
          version,
        },
        redaction: 'internal',
      },
    ],
  });

  return mapResult(result, record);
}

// ─── Stale-write detection (NN-ORCH-005) ─────────────────────────────────────

/**
 * Whether a write carrying `writerVersion` from `writerRunId` against a
 * resource range is a STALE write and must be rejected. A write is stale when:
 *
 *   - there is no active lock on the range (the writer never held it), OR
 *   - the active lock is owned by a DIFFERENT run, OR
 *   - the active lock's version is NEWER than the writer's version (the lock was
 *     re-acquired/refreshed since the writer captured it).
 *
 * A run that still holds the range at the exact version it captured writes
 * safely; every other case is a stale write. Pure read; no mutation.
 */
export function isStaleWrite(
  db: Database.Database,
  input: {
    readonly resourceKind: LockResourceKind;
    readonly resourceId: string;
    readonly rangeKey?: string;
    readonly writerRunId: string;
    readonly writerVersion: number;
    readonly nowMs: number;
  },
): boolean {
  const row = db
    .prepare(
      `SELECT record_json, state, lease_until_ms FROM run_locks
       WHERE resource_kind = ? AND resource_id = ? AND range_key = ?`,
    )
    .get(input.resourceKind, input.resourceId, rangeKeyOf(input.rangeKey)) as
    | LockRow
    | undefined;
  if (!row || !isActiveLock(row, input.nowMs)) return true;
  const lock = JSON.parse(row.record_json) as RunLock;
  if (lock.ownerRunId !== input.writerRunId) return true;
  if (lock.version !== input.writerVersion) return true;
  return false;
}

// ─── Safe release (NN-ORCH-005) ──────────────────────────────────────────────

export interface ReleaseLockInput extends LockCommandContext {
  readonly resourceKind: LockResourceKind;
  readonly resourceId: string;
  readonly rangeKey?: string;
  readonly ownerRunId: string;
  /** The version the releaser believes it holds (safe-release guard). */
  readonly expectedVersion: number;
}

/**
 * Safely release a lock (NN-ORCH-005). The release is guarded by
 * `expectedVersion`: only the current owner at the exact version may release,
 * so a stale releaser cannot free a lock another owner now holds. On success
 * the row transitions to `released` (a terminal state that no longer blocks a
 * competing acquire) with a bumped version. Releasing an absent/foreign/stale
 * lock is a typed `CONFLICT` with NO effect — it never discards another run's
 * lock or work.
 */
export function releaseLock(
  db: Database.Database,
  input: ReleaseLockInput,
): RunLockOutcome<RunLock> {
  const rangeKey = rangeKeyOf(input.rangeKey);
  const existing = readLock(db, input.resourceKind, input.resourceId, rangeKey);
  if (!existing || existing.state !== 'held') {
    return fail('CONFLICT', 'no held lock to release on this resource range');
  }
  if (existing.ownerRunId !== input.ownerRunId) {
    return fail('CONFLICT', 'lock is held by a different run; refusing to release another run’s lock');
  }
  if (existing.version !== input.expectedVersion) {
    return fail('STALE_REVISION', 'lock version has advanced; a stale releaser cannot release');
  }

  const released: RunLock = {
    ...existing,
    version: existing.version + 1,
    state: 'released',
  };
  const nowIso = (input.now ?? (() => new Date()))().toISOString();

  const result = applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({
      op: 'release-lock',
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      rangeKey,
      ownerRunId: input.ownerRunId,
      version: input.expectedVersion,
    }),
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      tx.prepare(
        `UPDATE run_locks SET version = ?, state = 'released', record_json = ?, acquired_at = ?
         WHERE resource_kind = ? AND resource_id = ? AND range_key = ?`,
      ).run(
        released.version,
        serializeContract(released),
        nowIso,
        input.resourceKind,
        input.resourceId,
        rangeKey,
      );
      return { resultRef: released.lockId };
    },
    events: [
      {
        eventType: 'run.lock.released',
        aggregateType: 'run-lock',
        aggregateId: released.lockId,
        payloadSchemaName: 'RunLock',
        payloadSchemaVersion: 1,
        payload: {
          resourceKind: input.resourceKind,
          resourceId: input.resourceId,
          rangeKey,
          ownerRunId: input.ownerRunId,
          version: released.version,
        },
        redaction: 'internal',
      },
    ],
  });

  return mapResult(result, released);
}
