/**
 * AuthorityTransaction — serialized authority transactions and atomic command
 * receipts (FUT-PKG-03-DURABILITY/T-001).
 *
 * D-08.2 defines the one-authority mutation transaction that DatabaseAuthority
 * executes on behalf of a command owner. Inside a single bounded `IMMEDIATE`
 * transaction (the serialized writer from {@link ./database-authority}) this
 * module:
 *
 *   1. looks up any prior `CommandReceipt@1` bound to the command's
 *      idempotency key and returns it for a matching request digest (replay)
 *      or a typed `CONFLICT` for a diverging digest — with no business effect;
 *   2. applies the caller-supplied business-table mutation;
 *   3. bumps the per-authority monotonic revision;
 *   4. allocates a monotonic per-scope sequence;
 *   5. persists a `CommandReceipt@1` keyed by the idempotency digest;
 *   6. appends one same-transaction `OutboxRecord@1` (embedding a
 *      `DomainEvent@1`) per emitted event;
 *   7. commits — and only then reports success.
 *
 * A failed transaction (business mutation throws, lock contention, or a
 * simulated crash before commit) rolls back atomically: no business row, no
 * receipt, no outbox record, and no revision/sequence advance is visible. This
 * is the all-or-none visibility of Property 1 (design.md "Atomic authority
 * mutation and publication").
 *
 * This module is additive over {@link ./database} and {@link ./database-authority}:
 * it creates NEW canonical tables (`authority_revisions`, `scope_sequences`,
 * `command_receipts`, `outbox`) and never becomes a second writer for an
 * existing business table. Callers shadow their current writers and cut over
 * one data class at a time; rollback restores the prior reader while these
 * canonical writes remain single-owner (NN-COMPAT-001/002, NN-INV-008).
 *
 * Design anchors: D-04, D-07 (`CommandReceipt@1`, `DomainEvent@1`,
 * `OutboxRecord@1`), D-08 (D-08.1 stores, D-08.2 mutation transaction).
 * Requirements: NN-INV-003 (no false success), NN-INV-007 (idempotency),
 * NN-INV-008 (one owner), NN-DATA-002 (serialized writes),
 * NN-DATA-004 (versioned records), NN-EVENT-001/002 (ordered outbox),
 * NN-EVENT-008/009 (receipt/outbox atomicity).
 */

import type Database from 'better-sqlite3';

import {
  CONTRACT_WRITE_VERSION,
  computeDigest,
  makeOpaqueId,
  reconcileIdempotency,
  serializeContract,
  type CommandReceipt,
  type ErrorEnvelope,
  type RedactionClass,
  type ScopeDescriptor,
} from '../shared/contract-primitives.js';
import { withSerializedWrite } from './database-authority.js';

// ─── Canonical durable tables (D-08.1) ──────────────────────────────────────

/**
 * DDL for the canonical durability tables owned by DatabaseAuthority on behalf
 * of command owners. All are additive; none replaces an existing business
 * table. `IF NOT EXISTS` keeps {@link ensureAuthorityTables} idempotent so it
 * can run at startup and inside tests without a migration cutover.
 */
const AUTHORITY_TABLES_DDL = `
  -- Per-authority monotonic revision (D-04 authority revision, D-08.2 step 5).
  CREATE TABLE IF NOT EXISTS authority_revisions (
    authority TEXT PRIMARY KEY,
    revision INTEGER NOT NULL
  );

  -- Per-scope monotonic sequence allocator (D-07 DomainEvent (scope, sequence)
  -- uniqueness, D-08.2 step 6). The scope key is a canonical digest of the
  -- ScopeDescriptor identity anchors so equal scopes share one counter.
  CREATE TABLE IF NOT EXISTS scope_sequences (
    scope_key TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL
  );

  -- CommandReceipt@1 keyed by idempotency digest (D-08.1 command_receipts).
  -- idempotency_key is UNIQUE so a retry finds the prior receipt; the stored
  -- request_digest distinguishes replay (equal) from CONFLICT (different).
  CREATE TABLE IF NOT EXISTS command_receipts (
    receipt_id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    request_digest TEXT NOT NULL,
    authority TEXT NOT NULL,
    authority_revision INTEGER NOT NULL,
    receipt_json TEXT NOT NULL,
    committed_at TEXT NOT NULL
  );

  -- OutboxRecord@1 appended in the same transaction as the business mutation
  -- (D-08.1 outbox, D-08.2 step 6). (scope_key, sequence) is UNIQUE to mirror
  -- the (scope, sequence) uniqueness of the embedded DomainEvent@1.
  CREATE TABLE IF NOT EXISTS outbox (
    outbox_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    command_id TEXT NOT NULL,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    transaction_revision INTEGER NOT NULL,
    payload_digest TEXT NOT NULL,
    state TEXT NOT NULL,
    available_at TEXT NOT NULL,
    attempt_count INTEGER NOT NULL,
    record_json TEXT NOT NULL,
    UNIQUE (scope_key, sequence)
  );

  CREATE INDEX IF NOT EXISTS idx_command_receipts_command
    ON command_receipts (command_id);
  CREATE INDEX IF NOT EXISTS idx_outbox_scope_sequence
    ON outbox (scope_key, sequence);
  CREATE INDEX IF NOT EXISTS idx_outbox_state_available
    ON outbox (state, available_at);
`;

/**
 * Create the canonical durability tables/indexes if absent. Idempotent and
 * additive: safe to run at startup or in tests. Callers hold the migration or
 * write discipline of DatabaseAuthority; this never mutates a business table.
 */
export function ensureAuthorityTables(db: Database.Database): void {
  db.exec(AUTHORITY_TABLES_DDL);
}

// ─── Scope keying (stable per-scope sequence identity) ──────────────────────

/**
 * The identity anchors that define a scope for sequence allocation. Two scopes
 * with equal populated anchors share one monotonic sequence; volatile fields
 * (allowed roots/destinations) do not affect the key.
 */
const SCOPE_KEY_ANCHORS: readonly (keyof ScopeDescriptor)[] = Object.freeze([
  'userId',
  'owner',
  'projectId',
  'workspaceId',
  'repositoryId',
  'sessionId',
  'worktreeId',
  'turnId',
  'taskId',
  'agentId',
]);

/**
 * Compute a stable scope key: a canonical digest over the populated identity
 * anchors of a `ScopeDescriptor@1`. Used as the `scope_sequences` primary key
 * and the outbox `(scope_key, sequence)` uniqueness column.
 */
export function computeScopeKey(scope: ScopeDescriptor): string {
  const anchors: Record<string, unknown> = {};
  for (const anchor of SCOPE_KEY_ANCHORS) {
    const value = scope[anchor];
    if (value !== undefined && value !== null && value !== '') {
      anchors[anchor] = value;
    }
  }
  return computeDigest(anchors);
}

// ─── DomainEvent@1 / OutboxRecord@1 (D-07) ──────────────────────────────────

/**
 * The caller's intent to emit one `DomainEvent@1` from a committed mutation.
 * The transaction fills in the allocated `sequence`, `authorityRevision`,
 * ids/digests, and timestamps; the caller supplies the event's meaning.
 */
export interface EventIntent {
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payloadSchemaName: string;
  readonly payloadSchemaVersion: number;
  readonly payload: unknown;
  readonly redaction: RedactionClass;
  /** Optional causation event id; defaults to the command id. */
  readonly causationId?: string;
}

/** `DomainEvent@1` shape (D-07). Created from a committed outbox row. */
export interface DomainEvent {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  readonly eventId: string;
  readonly eventType: string;
  readonly scope: ScopeDescriptor;
  readonly sequence: number;
  readonly authorityRevision: number;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly idempotencyKey: string;
  readonly producer: string;
  readonly payloadSchemaName: string;
  readonly payloadSchemaVersion: number;
  readonly payload: unknown;
  readonly redaction: RedactionClass;
  readonly payloadDigest: string;
}

/** `OutboxRecord@1` state ladder (D-07 / D-08.3). */
export type OutboxState = 'pending' | 'leased' | 'published' | 'failed';

/** `OutboxRecord@1` shape (D-07). Inserted in the business mutation txn. */
export interface OutboxRecord {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  readonly outboxId: string;
  readonly event: DomainEvent;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly scope: ScopeDescriptor;
  readonly sequence: number;
  readonly transactionRevision: number;
  readonly payloadDigest: string;
  readonly state: OutboxState;
  readonly availableAt: string;
  readonly attemptCount: number;
  readonly leaseOwner?: string;
  readonly leaseUntil?: string;
  readonly publishedAt?: string;
  readonly publicationReceiptRef?: string;
  readonly lastErrorCode?: string;
}

// ─── Mutation request / result ──────────────────────────────────────────────

/**
 * A durable authority mutation request. The `mutate` callback runs inside the
 * committed transaction and performs the business-table change; it returns an
 * optional `resultRef` recorded on the success receipt. Throwing from `mutate`
 * (or a lock/crash before commit) rolls the whole transaction back.
 */
export interface AuthorityMutationRequest {
  /** The owning authority id (e.g. `authority-task-plan`). */
  readonly authority: string;
  /** Opaque command id. */
  readonly commandId: string;
  /** Idempotency key; a retry reuses it to find the prior receipt. */
  readonly idempotencyKey: string;
  /**
   * The canonical request digest for idempotency reconciliation. Typically the
   * `payloadDigest` of the originating `CommandEnvelope@1`. Equal digests
   * replay; a changed digest under the same key is a `CONFLICT`.
   */
  readonly requestDigest: string;
  /** Correlation id threaded onto receipts/events. */
  readonly correlationId: string;
  /** The command scope; keys the per-scope sequence. */
  readonly scope: ScopeDescriptor;
  /**
   * The business-table mutation. Runs inside the committed transaction. Return
   * an optional opaque `resultRef` to record on the success receipt.
   */
  readonly mutate: (tx: Database.Database) => { readonly resultRef?: string } | void;
  /** Domain events to append to the outbox in the same transaction. */
  readonly events?: readonly EventIntent[];
  /** Injectable clock (tests). */
  readonly now?: () => Date;
  /**
   * Test-only fault hook invoked AFTER all writes but BEFORE commit. Throwing
   * here simulates a crash at the commit boundary and must roll everything
   * back, leaving nothing visible (Property 1 fault case).
   */
  readonly faultBeforeCommit?: () => void;
}

/** The outcome of {@link applyAuthorityMutation}. */
export type AuthorityMutationResult =
  | {
      readonly kind: 'committed';
      readonly receipt: CommandReceipt;
      readonly authorityRevision: number;
      readonly outbox: readonly OutboxRecord[];
      readonly resultRef?: string;
    }
  | { readonly kind: 'replayed'; readonly receipt: CommandReceipt }
  | { readonly kind: 'conflict'; readonly error: ErrorEnvelope };

// ─── Revision / sequence allocators (run inside the txn) ─────────────────────

function nextAuthorityRevision(tx: Database.Database, authority: string): number {
  const row = tx
    .prepare('SELECT revision FROM authority_revisions WHERE authority = ?')
    .get(authority) as { revision: number } | undefined;
  const next = (row?.revision ?? 0) + 1;
  tx.prepare(
    `INSERT INTO authority_revisions (authority, revision) VALUES (?, ?)
     ON CONFLICT(authority) DO UPDATE SET revision = excluded.revision`,
  ).run(authority, next);
  return next;
}

function nextScopeSequence(tx: Database.Database, scopeKey: string): number {
  const row = tx
    .prepare('SELECT sequence FROM scope_sequences WHERE scope_key = ?')
    .get(scopeKey) as { sequence: number } | undefined;
  const next = (row?.sequence ?? 0) + 1;
  tx.prepare(
    `INSERT INTO scope_sequences (scope_key, sequence) VALUES (?, ?)
     ON CONFLICT(scope_key) DO UPDATE SET sequence = excluded.sequence`,
  ).run(scopeKey, next);
  return next;
}

// ─── Prior-receipt lookup (idempotency, D-08.2 step 3) ──────────────────────

interface StoredReceiptRow {
  readonly idempotency_key: string;
  readonly request_digest: string;
  readonly receipt_json: string;
}

function findPriorReceipt(
  tx: Database.Database,
  idempotencyKey: string,
): CommandReceipt | undefined {
  const row = tx
    .prepare(
      `SELECT idempotency_key, request_digest, receipt_json
       FROM command_receipts WHERE idempotency_key = ?`,
    )
    .get(idempotencyKey) as StoredReceiptRow | undefined;
  if (!row) return undefined;
  return JSON.parse(row.receipt_json) as CommandReceipt;
}

/**
 * Read the prior receipt for an idempotency key without opening a transaction.
 * Returns `undefined` if none exists. Useful for read-side reconciliation.
 */
export function readCommandReceipt(
  db: Database.Database,
  idempotencyKey: string,
): CommandReceipt | undefined {
  return findPriorReceipt(db, idempotencyKey);
}

/** Read all outbox records for a scope in monotonic sequence order. */
export function readOutboxForScope(
  db: Database.Database,
  scope: ScopeDescriptor,
): OutboxRecord[] {
  const scopeKey = computeScopeKey(scope);
  const rows = db
    .prepare('SELECT record_json FROM outbox WHERE scope_key = ? ORDER BY sequence')
    .all(scopeKey) as { record_json: string }[];
  return rows.map((r) => JSON.parse(r.record_json) as OutboxRecord);
}

// ─── The atomic authority mutation (D-08.2) ─────────────────────────────────

/**
 * Apply a durable authority mutation atomically (Property 1). Inside one
 * bounded `IMMEDIATE` transaction:
 *
 *   - a prior receipt bound to the idempotency key is reconciled: equal
 *     request digest replays it (no business effect); a changed digest returns
 *     `CONFLICT` (no effect);
 *   - otherwise the business mutation runs, the authority revision bumps, a
 *     per-scope sequence is allocated, a `CommandReceipt@1` is persisted keyed
 *     by the idempotency digest, and one `OutboxRecord@1` per event is
 *     appended — all committed together.
 *
 * Any throw (business error, lock, or `faultBeforeCommit`) rolls the whole
 * transaction back; nothing becomes visible and no success is reported
 * (NN-INV-003).
 */
export function applyAuthorityMutation(
  db: Database.Database,
  request: AuthorityMutationRequest,
): AuthorityMutationResult {
  const now = request.now ?? (() => new Date());
  const scopeKey = computeScopeKey(request.scope);

  return withSerializedWrite(db, (tx): AuthorityMutationResult => {
    // Step 3 (D-08.2): idempotency reconciliation before any effect.
    const prior = findPriorReceipt(tx, request.idempotencyKey);
    if (prior) {
      const outcome = reconcileIdempotency(prior, request.requestDigest, {
        owner: request.authority,
        operation: 'apply-authority-mutation',
        correlationId: request.correlationId,
      });
      if (outcome.kind === 'replay') {
        return { kind: 'replayed', receipt: outcome.receipt };
      }
      // Conflict: reconciliation is the first step, so no business effect has
      // occurred inside this transaction. Return the typed non-success
      // directly; the transaction commits nothing new (no rows were written).
      return { kind: 'conflict', error: outcome.error };
    }

    // Step 5: apply the business mutation and bump the authority revision.
    const mutation = request.mutate(tx) ?? {};
    const authorityRevision = nextAuthorityRevision(tx, request.authority);

    // Step 6: allocate scope sequences and append outbox records.
    const committedAt = now().toISOString();
    const events = request.events ?? [];
    const outboxRecords: OutboxRecord[] = [];
    const outboxEventIds: string[] = [];

    for (const intent of events) {
      const sequence = nextScopeSequence(tx, scopeKey);
      const eventId = makeOpaqueId('evt', `${request.commandId}${sequence}`);
      const payloadDigest = computeDigest(intent.payload);
      const event: DomainEvent = {
        schemaVersion: CONTRACT_WRITE_VERSION,
        eventId,
        eventType: intent.eventType,
        scope: request.scope,
        sequence,
        authorityRevision,
        occurredAt: committedAt,
        correlationId: request.correlationId,
        causationId: intent.causationId ?? request.commandId,
        idempotencyKey: request.idempotencyKey,
        producer: request.authority,
        payloadSchemaName: intent.payloadSchemaName,
        payloadSchemaVersion: intent.payloadSchemaVersion,
        payload: intent.payload,
        redaction: intent.redaction,
        payloadDigest,
      };
      const outboxId = makeOpaqueId('obx', `${request.commandId}${sequence}`);
      const record: OutboxRecord = {
        schemaVersion: CONTRACT_WRITE_VERSION,
        outboxId,
        event,
        aggregateType: intent.aggregateType,
        aggregateId: intent.aggregateId,
        scope: request.scope,
        sequence,
        transactionRevision: authorityRevision,
        payloadDigest,
        state: 'pending',
        availableAt: committedAt,
        attemptCount: 0,
      };
      tx.prepare(
        `INSERT INTO outbox
           (outbox_id, event_id, command_id, aggregate_type, aggregate_id, scope_key,
            sequence, transaction_revision, payload_digest, state, available_at,
            attempt_count, record_json)
         VALUES (@outboxId, @eventId, @commandId, @aggregateType, @aggregateId, @scopeKey,
            @sequence, @transactionRevision, @payloadDigest, @state, @availableAt,
            @attemptCount, @recordJson)`,
      ).run({
        outboxId,
        eventId,
        commandId: request.commandId,
        aggregateType: intent.aggregateType,
        aggregateId: intent.aggregateId,
        scopeKey,
        sequence,
        transactionRevision: authorityRevision,
        payloadDigest,
        state: record.state,
        availableAt: committedAt,
        attemptCount: 0,
        recordJson: serializeContract(record, { allowSecret: true }),
      });
      outboxRecords.push(record);
      outboxEventIds.push(eventId);
    }

    // Step 7: persist the CommandReceipt@1 keyed by the idempotency digest.
    const receipt: CommandReceipt = {
      schemaVersion: CONTRACT_WRITE_VERSION,
      receiptId: makeOpaqueId('rcpt', request.commandId),
      commandId: request.commandId,
      idempotencyKey: request.idempotencyKey,
      requestDigest: request.requestDigest,
      authority: request.authority,
      authorityRevision,
      outboxEventIds,
      ...(mutation.resultRef !== undefined ? { resultRef: mutation.resultRef } : {}),
      committedAt,
    };
    tx.prepare(
      `INSERT INTO command_receipts
         (receipt_id, command_id, idempotency_key, request_digest, authority,
          authority_revision, receipt_json, committed_at)
       VALUES (@receiptId, @commandId, @idempotencyKey, @requestDigest, @authority,
          @authorityRevision, @receiptJson, @committedAt)`,
    ).run({
      receiptId: receipt.receiptId,
      commandId: receipt.commandId,
      idempotencyKey: receipt.idempotencyKey,
      requestDigest: receipt.requestDigest,
      authority: receipt.authority,
      authorityRevision: receipt.authorityRevision,
      receiptJson: serializeContract(receipt, { allowSecret: true }),
      committedAt,
    });

    // Step 8 (fault window): a crash here rolls back everything above.
    request.faultBeforeCommit?.();

    // Step 8: commit is performed by withSerializedWrite on return.
    return {
      kind: 'committed',
      receipt,
      authorityRevision,
      outbox: outboxRecords,
      ...(mutation.resultRef !== undefined ? { resultRef: mutation.resultRef } : {}),
    };
  });
}


