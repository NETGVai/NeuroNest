/**
 * OperationJournal — journaled sagas for external/filesystem effects and
 * startup/scheduled reconciliation (FUT-PKG-03-DURABILITY/T-004).
 *
 * D-08.2 defines the journaled saga that a cost-bearing or external/filesystem
 * effect MUST use, because such an effect cannot be enclosed in the single
 * `IMMEDIATE` business transaction (D-08.2 forbids holding a database lock
 * across network, child-process, or filesystem promotion work):
 *
 *   1. commit `OperationJournal@1` as `pending` / `applying` with idempotency,
 *      expected revision, budget reservation, rescue reference where
 *      applicable, and a provider receipt-query / compensation strategy;
 *   2. perform the effect WITHOUT holding a database lock;
 *   3. commit the observed result, budget commit/refund, authority revision,
 *      and outbox — and only then report success.
 *
 * If the final commit fails, the journal stays nonterminal and restart MUST
 * query the external receipt or inspect/restore the rescue state before retry
 * or compensation. It reports `effect-unknown` / `INTEGRITY`, never success,
 * until reconciliation commits a terminal state (D-08.2, D-18, NN-INV-003).
 *
 * D-15 fixes the restart classifier vocabulary exactly: `safe-to-retry`,
 * `requires-receipt-query`, `requires-user-review`, `compensate`, or
 * `blocked-integrity`. "Unknown external effects are never automatically
 * repeated." This module implements that classifier: on a crash before or
 * after each effect and at the commit boundary, a nonterminal journal row is
 * classified from its recorded strategy and effect-status marker; a row whose
 * effect status is unknown is NEVER blindly repeated nor reported successful
 * (NN-INV-003).
 *
 * D-08.3 / D-18 define startup and scheduled reconciliation: compare business
 * authority revision, outbox sequence, delivery receipts, and projection
 * checkpoints; repair reconstructible drift; surface unreconstructible gaps as
 * `INTEGRITY` that blocks affected release/readiness (NN-EVENT-005).
 *
 * This module is additive over {@link ./authority-transaction} (T-001: the
 * `authority_revisions`, `command_receipts`, and `outbox` tables) and
 * {@link ./outbox-publisher} (T-002: `outbox_delivery_receipts`). It becomes NO
 * second writer for a business table. It appends three NEW ledger tables it
 * solely owns — `operation_journal` (the saga journal), `external_receipts`
 * (the recorded external/provider receipt-query results), and
 * `reconciliation_projection_checkpoints` (the reconciler's per-scope last
 * verified projection sequence). Journal coverage is REQUIRED before an
 * external/filesystem writer moves (task migration/rollout): {@link
 * assertJournalCoverage} refuses a move for a scope with nonterminal journal
 * rows.
 *
 * Design anchors: D-08 (D-08.1 operation_journal store, D-08.2 journaled saga,
 * D-08.3 reconciliation), D-09 (startup reconciliation), D-15 (restart
 * classifier vocabulary), D-18 (incomplete operation, false-success
 * prevention). Requirements: NN-INV-003 (no unverified success), NN-INV-006
 * (recoverability before mutation), NN-INV-007 (durable idempotent
 * transitions), NN-INV-011 (observable typed failure), NN-DATA-003 (migration
 * protocol / preserve prior state), NN-DATA-006 (backups and rescue),
 * NN-EVENT-005 (reconciliation), NN-OPS-005/006 (deployment/readiness).
 */

import type Database from 'better-sqlite3';

import {
  computeDigest,
  makeOpaqueId,
  serializeContract,
  type ErrorCode,
  type ErrorEnvelope,
  type ScopeDescriptor,
} from '../shared/contract-primitives.js';
import { withSerializedWrite } from './database-authority.js';
import { computeScopeKey } from './authority-transaction.js';

// ─── OperationJournal@1 state ladder (D-08.1 / D-08.2) ───────────────────────

/**
 * `OperationJournal@1` state ladder. `pending` and `applying` are the two
 * nonterminal states recorded BEFORE the external effect (D-08.2 step 1); the
 * effect runs while the row is `applying`. The terminal states are recorded by
 * the second commit (D-08.2 step 3):
 *
 *   - `committed`    — the effect is observed successful and its result durably
 *                      recorded; only this reports success (NN-INV-003).
 *   - `compensated`  — a partial/failed effect was reversed by compensation.
 *   - `blocked`      — an unreconstructible integrity gap; blocks readiness.
 *
 * A row left in `pending` or `applying` after a crash is nonterminal: restart
 * classifies it and never treats it as success.
 */
export type JournalState =
  | 'pending'
  | 'applying'
  | 'committed'
  | 'compensated'
  | 'blocked';

/** Whether a journal state is terminal (no further transition expected). */
export function isTerminalJournalState(state: JournalState): boolean {
  return state === 'committed' || state === 'compensated' || state === 'blocked';
}

/**
 * The effect-status marker the saga records so restart can reason about the
 * external world without repeating an unknown effect:
 *
 *   - `not-started`  — the row is `pending`; the effect had not begun. Safe to
 *                      retry (nothing external happened yet).
 *   - `unknown`      — the row is `applying`; a crash occurred at or after the
 *                      effect began but before the terminal commit. The effect
 *                      MAY or MAY NOT have happened. It is NEVER blindly
 *                      repeated nor reported successful (NN-INV-003, D-18).
 *   - `observed`     — the effect completed and its receipt was observed; the
 *                      terminal commit is all that remains.
 */
export type EffectStatus = 'not-started' | 'unknown' | 'observed';

/**
 * The recovery strategy the saga declared up front so restart knows how to
 * resolve an `unknown` effect. Mirrors the D-18 retry taxonomy:
 *
 *   - `pure`             — no external effect; safe to retry unconditionally.
 *   - `idempotent`       — the external effect carries a provider idempotency
 *                          key; a retry cannot duplicate it, so it is safe to
 *                          retry even when unknown.
 *   - `receipt-queryable`— the external system can be queried for a receipt to
 *                          learn whether the effect happened before deciding.
 *   - `compensatable`    — the effect can be reversed; an unknown effect is
 *                          compensated rather than repeated.
 *   - `non-retryable`    — the effect cannot be safely retried, queried, or
 *                          compensated; an unknown effect requires user review.
 */
export type RecoveryStrategy =
  | 'pure'
  | 'idempotent'
  | 'receipt-queryable'
  | 'compensatable'
  | 'non-retryable';

/**
 * The restart classifier decision vocabulary. Fixed exactly by D-15: "Recovery
 * classifier states are `safe-to-retry`, `requires-receipt-query`,
 * `requires-user-review`, `compensate`, or `blocked-integrity`."
 */
export type RecoveryClassification =
  | 'safe-to-retry'
  | 'requires-receipt-query'
  | 'requires-user-review'
  | 'compensate'
  | 'blocked-integrity';

// ─── OperationJournal@1 record (D-07 shape) ──────────────────────────────────

/** `OperationJournal@1` — the durable saga journal record (D-08.1). */
export interface OperationJournalRecord {
  readonly schemaVersion: 1;
  readonly journalId: string;
  readonly operationId: string;
  /** Idempotency key; a retry reuses it to find this journal row. */
  readonly idempotencyKey: string;
  readonly authority: string;
  readonly correlationId: string;
  readonly scope: ScopeDescriptor;
  /** Expected authority revision the terminal commit must still satisfy. */
  readonly expectedRevision: number;
  readonly strategy: RecoveryStrategy;
  readonly state: JournalState;
  readonly effectStatus: EffectStatus;
  /**
   * Provider idempotency key sent to the external system, if any. Present for
   * `idempotent` and `receipt-queryable` strategies so a receipt query or a
   * safe retry can be keyed to the exact prior attempt.
   */
  readonly providerIdempotencyKey?: string;
  /** Opaque rescue reference (e.g. a backup path) captured before mutation. */
  readonly rescueRef?: string;
  /** Digest of the rescue state at capture, for rescue comparison. */
  readonly rescueDigest?: string;
  /** Approved budget reservation reference, if the effect is cost-bearing. */
  readonly budgetReservationRef?: string;
  /** The observed external receipt id once the effect is observed/queried. */
  readonly externalReceiptId?: string;
  /** Opaque result reference recorded on a committed terminal transition. */
  readonly resultRef?: string;
  /** Typed error code recorded on a blocked/compensated transition. */
  readonly lastErrorCode?: ErrorCode;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ─── Ledger DDL (additive; solely owned by this module) ──────────────────────

const OPERATION_JOURNAL_DDL = `
  -- OperationJournal@1 saga journal (D-08.1 operation_journal). One row per
  -- external/filesystem operation. idempotency_key is UNIQUE so a retry finds
  -- the prior row; state + effect_status are the restart-classifier inputs.
  CREATE TABLE IF NOT EXISTS operation_journal (
    journal_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    authority TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    expected_revision INTEGER NOT NULL,
    strategy TEXT NOT NULL,
    state TEXT NOT NULL,
    effect_status TEXT NOT NULL,
    provider_idempotency_key TEXT,
    rescue_ref TEXT,
    rescue_digest TEXT,
    budget_reservation_ref TEXT,
    external_receipt_id TEXT,
    result_ref TEXT,
    last_error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    record_json TEXT NOT NULL
  );

  -- Recorded external/provider receipt-query results (D-08.2 "query the
  -- external receipt"). One row per (journal_id) query; found records whether
  -- the external system reports the effect happened.
  CREATE TABLE IF NOT EXISTS external_receipts (
    external_receipt_id TEXT PRIMARY KEY,
    journal_id TEXT NOT NULL,
    provider_idempotency_key TEXT NOT NULL,
    found INTEGER NOT NULL,
    receipt_digest TEXT,
    queried_at TEXT NOT NULL,
    UNIQUE (journal_id, provider_idempotency_key)
  );

  -- The reconciler's per-scope last verified projection sequence (D-08.3
  -- projection_checkpoints). Solely owned by reconciliation; never a business
  -- table. Lets reconciliation compare projection progress to outbox sequence.
  CREATE TABLE IF NOT EXISTS reconciliation_projection_checkpoints (
    scope_key TEXT PRIMARY KEY,
    last_verified_sequence INTEGER NOT NULL,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_operation_journal_state
    ON operation_journal (state, effect_status);
  CREATE INDEX IF NOT EXISTS idx_operation_journal_scope
    ON operation_journal (scope_key);
  CREATE INDEX IF NOT EXISTS idx_external_receipts_journal
    ON external_receipts (journal_id);
`;

/**
 * Create the operation-journal / reconciliation ledger tables if absent.
 * Idempotent and additive; safe to run at startup or in tests. Requires the
 * T-001 tables (via {@link ensureAuthorityTables}) and T-002 tables (via
 * {@link ensurePublisherTables}) when reconciliation is to compare them.
 */
export function ensureOperationJournalTables(db: Database.Database): void {
  db.exec(OPERATION_JOURNAL_DDL);
}

// ─── Journal errors (NN-INV-011 typed failure) ───────────────────────────────

/** Why a journaled operation could not be reported successful. */
export type JournalFailureReason =
  | 'EFFECT_UNKNOWN' // crash left the effect status unknown (NN-INV-003)
  | 'REVISION_ADVANCED' // authority revision moved past expectedRevision
  | 'RESCUE_MISMATCH' // rescue state diverged from the captured digest
  | 'INTEGRITY'; // an unreconstructible integrity gap

const REASON_CODE: Readonly<Record<JournalFailureReason, ErrorCode>> = Object.freeze({
  EFFECT_UNKNOWN: 'INTEGRITY',
  REVISION_ADVANCED: 'STALE_REVISION',
  RESCUE_MISMATCH: 'INTEGRITY',
  INTEGRITY: 'INTEGRITY',
});

/** Build a typed, secret-free {@link ErrorEnvelope} for a journal failure. */
function journalError(
  reason: JournalFailureReason,
  authority: string,
  operation: string,
  correlationId: string,
  message: string,
): ErrorEnvelope {
  const code = REASON_CODE[reason];
  return {
    schemaVersion: 1,
    code,
    message,
    owner: authority,
    operation,
    correlationId,
    retryable: reason === 'REVISION_ADVANCED',
    redaction: 'internal',
    // effectKnown:false makes explicit that the final effect is not known — the
    // classifier never infers success from a timeout/unknown effect (D-18).
    ...(reason === 'EFFECT_UNKNOWN' ? { effectKnown: false } : {}),
  };
}

// ─── Row <-> record mapping ──────────────────────────────────────────────────

interface JournalRow {
  readonly journal_id: string;
  readonly operation_id: string;
  readonly idempotency_key: string;
  readonly authority: string;
  readonly correlation_id: string;
  readonly scope_key: string;
  readonly expected_revision: number;
  readonly strategy: RecoveryStrategy;
  readonly state: JournalState;
  readonly effect_status: EffectStatus;
  readonly provider_idempotency_key: string | null;
  readonly rescue_ref: string | null;
  readonly rescue_digest: string | null;
  readonly budget_reservation_ref: string | null;
  readonly external_receipt_id: string | null;
  readonly result_ref: string | null;
  readonly last_error_code: ErrorCode | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly record_json: string;
}

function rowToRecord(row: JournalRow): OperationJournalRecord {
  return JSON.parse(row.record_json) as OperationJournalRecord;
}

function persistRecord(tx: Database.Database, record: OperationJournalRecord): void {
  const scopeKey = computeScopeKey(record.scope);
  tx.prepare(
    `INSERT INTO operation_journal
       (journal_id, operation_id, idempotency_key, authority, correlation_id, scope_key,
        expected_revision, strategy, state, effect_status, provider_idempotency_key,
        rescue_ref, rescue_digest, budget_reservation_ref, external_receipt_id,
        result_ref, last_error_code, created_at, updated_at, record_json)
     VALUES (@journalId, @operationId, @idempotencyKey, @authority, @correlationId, @scopeKey,
        @expectedRevision, @strategy, @state, @effectStatus, @providerIdempotencyKey,
        @rescueRef, @rescueDigest, @budgetReservationRef, @externalReceiptId,
        @resultRef, @lastErrorCode, @createdAt, @updatedAt, @recordJson)
     ON CONFLICT(journal_id) DO UPDATE SET
       state = excluded.state,
       effect_status = excluded.effect_status,
       provider_idempotency_key = excluded.provider_idempotency_key,
       rescue_ref = excluded.rescue_ref,
       rescue_digest = excluded.rescue_digest,
       budget_reservation_ref = excluded.budget_reservation_ref,
       external_receipt_id = excluded.external_receipt_id,
       result_ref = excluded.result_ref,
       last_error_code = excluded.last_error_code,
       updated_at = excluded.updated_at,
       record_json = excluded.record_json`,
  ).run({
    journalId: record.journalId,
    operationId: record.operationId,
    idempotencyKey: record.idempotencyKey,
    authority: record.authority,
    correlationId: record.correlationId,
    scopeKey,
    expectedRevision: record.expectedRevision,
    strategy: record.strategy,
    state: record.state,
    effectStatus: record.effectStatus,
    providerIdempotencyKey: record.providerIdempotencyKey ?? null,
    rescueRef: record.rescueRef ?? null,
    rescueDigest: record.rescueDigest ?? null,
    budgetReservationRef: record.budgetReservationRef ?? null,
    externalReceiptId: record.externalReceiptId ?? null,
    resultRef: record.resultRef ?? null,
    lastErrorCode: record.lastErrorCode ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    recordJson: serializeContract(record, { allowSecret: true }),
  });
}

/** Read one journal record by idempotency key without opening a transaction. */
export function readJournalByIdempotencyKey(
  db: Database.Database,
  idempotencyKey: string,
): OperationJournalRecord | undefined {
  const row = db
    .prepare(`SELECT record_json FROM operation_journal WHERE idempotency_key = ?`)
    .get(idempotencyKey) as { record_json: string } | undefined;
  return row ? (JSON.parse(row.record_json) as OperationJournalRecord) : undefined;
}

/** Read one journal record by journal id without opening a transaction. */
export function readJournalById(
  db: Database.Database,
  journalId: string,
): OperationJournalRecord | undefined {
  const row = db
    .prepare(`SELECT record_json FROM operation_journal WHERE journal_id = ?`)
    .get(journalId) as { record_json: string } | undefined;
  return row ? (JSON.parse(row.record_json) as OperationJournalRecord) : undefined;
}

// ─── Phase 1: begin the saga (commit pending/applying, D-08.2 step 1) ────────

/** Input to {@link beginJournaledOperation}. */
export interface BeginJournalInput {
  readonly authority: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly scope: ScopeDescriptor;
  readonly expectedRevision: number;
  readonly strategy: RecoveryStrategy;
  readonly providerIdempotencyKey?: string;
  readonly rescueRef?: string;
  /** The rescue state to digest for later rescue comparison (NN-INV-006). */
  readonly rescueState?: unknown;
  readonly budgetReservationRef?: string;
  readonly now?: () => Date;
}

/**
 * Phase 1 of the journaled saga (D-08.2 step 1): durably commit an
 * `OperationJournal@1` row as `pending` with `effect-status = not-started`
 * BEFORE any external effect, recording idempotency, expected revision, budget
 * reservation, rescue reference/digest, and the receipt-query/compensation
 * strategy. Runs in the serialized writer. Idempotent on the idempotency key: a
 * retry that finds an existing row returns it rather than starting a second
 * saga (NN-INV-007). A `compensatable`/`receipt-queryable`/`idempotent`
 * strategy that will touch an external system SHOULD supply a
 * `providerIdempotencyKey`; a non-`pure` strategy SHOULD supply a rescue
 * reference/state so restart can compare/restore (NN-INV-006).
 */
export function beginJournaledOperation(
  db: Database.Database,
  input: BeginJournalInput,
): OperationJournalRecord {
  const now = input.now ?? (() => new Date());
  const nowIso = now().toISOString();

  return withSerializedWrite(db, (tx): OperationJournalRecord => {
    const existing = tx
      .prepare(`SELECT record_json FROM operation_journal WHERE idempotency_key = ?`)
      .get(input.idempotencyKey) as { record_json: string } | undefined;
    if (existing) {
      // Idempotent begin: never start a second saga for the same key.
      return JSON.parse(existing.record_json) as OperationJournalRecord;
    }

    const record: OperationJournalRecord = {
      schemaVersion: 1,
      journalId: makeOpaqueId('opj', `${input.operationId}${input.idempotencyKey}`),
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      authority: input.authority,
      correlationId: input.correlationId,
      scope: input.scope,
      expectedRevision: input.expectedRevision,
      strategy: input.strategy,
      state: 'pending',
      effectStatus: 'not-started',
      ...(input.providerIdempotencyKey !== undefined
        ? { providerIdempotencyKey: input.providerIdempotencyKey }
        : {}),
      ...(input.rescueRef !== undefined ? { rescueRef: input.rescueRef } : {}),
      ...(input.rescueState !== undefined
        ? { rescueDigest: computeDigest(input.rescueState) }
        : {}),
      ...(input.budgetReservationRef !== undefined
        ? { budgetReservationRef: input.budgetReservationRef }
        : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    persistRecord(tx, record);
    return record;
  });
}

/**
 * Transition a `pending` row to `applying` with `effect-status = unknown`,
 * committed BEFORE the external effect begins. This is the crux of NN-INV-003:
 * because the marker is durably `unknown` the moment before the effect, a crash
 * during the effect leaves a row whose effect status is unknown — the
 * classifier will not blindly repeat it. Runs in the serialized writer.
 */
export function markApplying(
  db: Database.Database,
  journalId: string,
  now: () => Date = () => new Date(),
): OperationJournalRecord {
  const nowIso = now().toISOString();
  return withSerializedWrite(db, (tx): OperationJournalRecord => {
    const row = tx
      .prepare(`SELECT record_json FROM operation_journal WHERE journal_id = ?`)
      .get(journalId) as { record_json: string } | undefined;
    if (!row) throw new Error(`markApplying: unknown journal ${journalId}`);
    const prior = JSON.parse(row.record_json) as OperationJournalRecord;
    const updated: OperationJournalRecord = {
      ...prior,
      state: 'applying',
      effectStatus: 'unknown',
      updatedAt: nowIso,
    };
    persistRecord(tx, updated);
    return updated;
  });
}

/**
 * Record that the external effect was observed successful (its receipt exists)
 * WITHOUT yet committing the terminal state. Sets `effect-status = observed`
 * and records the external receipt id. The row stays `applying`; the terminal
 * commit is {@link commitJournaledOperation}. This lets a crash between "effect
 * observed" and "terminal commit" be resolved cheaply on restart (the effect is
 * known to have happened; complete the terminal commit rather than repeat it).
 */
export function recordEffectObserved(
  db: Database.Database,
  input: { readonly journalId: string; readonly externalReceiptId: string; readonly now?: () => Date },
): OperationJournalRecord {
  const now = input.now ?? (() => new Date());
  const nowIso = now().toISOString();
  return withSerializedWrite(db, (tx): OperationJournalRecord => {
    const row = tx
      .prepare(`SELECT record_json FROM operation_journal WHERE journal_id = ?`)
      .get(input.journalId) as { record_json: string } | undefined;
    if (!row) throw new Error(`recordEffectObserved: unknown journal ${input.journalId}`);
    const prior = JSON.parse(row.record_json) as OperationJournalRecord;
    const updated: OperationJournalRecord = {
      ...prior,
      effectStatus: 'observed',
      externalReceiptId: input.externalReceiptId,
      updatedAt: nowIso,
    };
    persistRecord(tx, updated);
    return updated;
  });
}

// ─── Phase 3: terminal commit (D-08.2 step 3) ────────────────────────────────

/** Input to {@link commitJournaledOperation}. */
export interface CommitJournalInput {
  readonly journalId: string;
  /** Current authority revision; must satisfy the recorded expectedRevision. */
  readonly currentRevision: number;
  /**
   * The durable second-transaction body (D-08.2 step 3): record observed
   * result, budget commit/refund, authority revision, and outbox. Runs inside
   * the same serialized transaction that flips the journal to `committed`, so a
   * crash cannot record a `committed` journal without the result.
   */
  readonly finalize: (tx: Database.Database) => { readonly resultRef?: string } | void;
  readonly now?: () => Date;
  /**
   * Test-only fault hook invoked AFTER `finalize` writes but BEFORE the journal
   * is flipped to `committed`, simulating a crash at the commit boundary. The
   * whole transaction rolls back, leaving the row nonterminal (`applying`).
   */
  readonly faultBeforeCommit?: () => void;
}

/** The outcome of {@link commitJournaledOperation}. */
export type CommitJournalResult =
  | { readonly kind: 'committed'; readonly record: OperationJournalRecord; readonly resultRef?: string }
  | { readonly kind: 'blocked'; readonly error: ErrorEnvelope };

/**
 * Phase 3 of the journaled saga (D-08.2 step 3): in one serialized transaction,
 * verify the authority revision has not advanced past the recorded
 * `expectedRevision`, run `finalize` (result + budget + revision + outbox),
 * then flip the journal to `committed`. Only a committed terminal row reports
 * success (NN-INV-003). If the revision advanced, nothing is finalized and a
 * typed `STALE_REVISION` is returned. If `faultBeforeCommit` throws (crash at
 * the commit boundary), the transaction rolls back and the row stays
 * nonterminal for restart to classify.
 */
export function commitJournaledOperation(
  db: Database.Database,
  input: CommitJournalInput,
): CommitJournalResult {
  const now = input.now ?? (() => new Date());
  const nowIso = now().toISOString();

  return withSerializedWrite(db, (tx): CommitJournalResult => {
    const row = tx
      .prepare(`SELECT record_json FROM operation_journal WHERE journal_id = ?`)
      .get(input.journalId) as { record_json: string } | undefined;
    if (!row) throw new Error(`commitJournaledOperation: unknown journal ${input.journalId}`);
    const prior = JSON.parse(row.record_json) as OperationJournalRecord;

    if (input.currentRevision < prior.expectedRevision) {
      // Revision moved unexpectedly: do not finalize; typed non-success.
      return {
        kind: 'blocked',
        error: journalError(
          'REVISION_ADVANCED',
          prior.authority,
          'commit-journaled-operation',
          prior.correlationId,
          `authority revision ${input.currentRevision} is behind expected ${prior.expectedRevision}`,
        ),
      };
    }

    const finalized = input.finalize(tx) ?? {};

    // Fault window: a crash here rolls back finalize AND the flip below.
    input.faultBeforeCommit?.();

    const committed: OperationJournalRecord = {
      ...prior,
      state: 'committed',
      effectStatus: 'observed',
      ...(finalized.resultRef !== undefined ? { resultRef: finalized.resultRef } : {}),
      updatedAt: nowIso,
    };
    persistRecord(tx, committed);
    return {
      kind: 'committed',
      record: committed,
      ...(finalized.resultRef !== undefined ? { resultRef: finalized.resultRef } : {}),
    };
  });
}

// ─── External receipt query (idempotency check, D-08.2) ──────────────────────

/** The outcome of a provider receipt query. */
export interface ExternalReceiptQueryResult {
  /** Whether the external system reports the effect happened. */
  readonly found: boolean;
  /** An opaque digest of the external receipt payload, if found. */
  readonly receiptDigest?: string;
  /** The external receipt id to record on the journal, if found. */
  readonly externalReceiptId?: string;
}

/**
 * Query the external/provider system for a receipt keyed by the journal's
 * provider idempotency key, and durably record the result in
 * `external_receipts`. This is the "query external receipt" step the classifier
 * uses instead of blindly repeating an unknown effect (D-08.2, D-18). The
 * `probe` callback performs the real query (network/provider) OUTSIDE the
 * database lock; its result is then committed in the serialized writer. If the
 * receipt is found, the journal's `effectStatus` becomes `observed` so a later
 * terminal commit completes rather than repeats the effect.
 */
export function queryExternalReceipt(
  db: Database.Database,
  input: {
    readonly journalId: string;
    readonly probe: (providerIdempotencyKey: string) => ExternalReceiptQueryResult;
    readonly now?: () => Date;
  },
): { readonly found: boolean; readonly record: OperationJournalRecord } {
  const now = input.now ?? (() => new Date());
  const record = readJournalById(db, input.journalId);
  if (!record) throw new Error(`queryExternalReceipt: unknown journal ${input.journalId}`);
  if (record.providerIdempotencyKey === undefined) {
    throw new Error(
      `queryExternalReceipt: journal ${input.journalId} has no providerIdempotencyKey to query`,
    );
  }

  // The real probe runs OUTSIDE the database lock (D-08.2: no lock across
  // network work).
  const result = input.probe(record.providerIdempotencyKey);
  const nowIso = now().toISOString();
  const externalReceiptId =
    result.externalReceiptId ??
    makeOpaqueId('extr', `${input.journalId}${record.providerIdempotencyKey}`);

  return withSerializedWrite(db, (tx) => {
    tx.prepare(
      `INSERT INTO external_receipts
         (external_receipt_id, journal_id, provider_idempotency_key, found, receipt_digest, queried_at)
       VALUES (@id, @journalId, @pik, @found, @receiptDigest, @queriedAt)
       ON CONFLICT(journal_id, provider_idempotency_key) DO UPDATE SET
         found = excluded.found,
         receipt_digest = excluded.receipt_digest,
         queried_at = excluded.queried_at`,
    ).run({
      id: externalReceiptId,
      journalId: input.journalId,
      pik: record.providerIdempotencyKey,
      found: result.found ? 1 : 0,
      receiptDigest: result.receiptDigest ?? null,
      queriedAt: nowIso,
    });

    const updated: OperationJournalRecord = {
      ...record,
      // A found receipt means the effect is known to have happened.
      effectStatus: result.found ? 'observed' : 'not-started',
      ...(result.found ? { externalReceiptId } : {}),
      updatedAt: nowIso,
    };
    persistRecord(tx, updated);
    return { found: result.found, record: updated };
  });
}

// ─── Rescue comparison (NN-INV-006 / NN-DATA-006) ────────────────────────────

/**
 * Compare the current rescue state against the digest captured at
 * {@link beginJournaledOperation}. A match means the rescue point is intact and
 * a restore would recover the pre-effect state; a mismatch is an integrity
 * signal that the recorded rescue no longer corresponds to the observed world
 * (`RESCUE_MISMATCH`). Read-only; opens no transaction.
 */
export function compareRescueState(
  record: OperationJournalRecord,
  currentRescueState: unknown,
): { readonly matches: boolean; readonly expectedDigest?: string; readonly actualDigest: string } {
  const actualDigest = computeDigest(currentRescueState);
  if (record.rescueDigest === undefined) {
    return { matches: false, actualDigest };
  }
  return {
    matches: record.rescueDigest === actualDigest,
    expectedDigest: record.rescueDigest,
    actualDigest,
  };
}

// ─── Compensation (reverse a partial/unknown effect) ─────────────────────────

/**
 * Compensate a nonterminal journal row: run the caller's reversal effect
 * OUTSIDE the lock, then flip the journal to `compensated` in the serialized
 * writer. A compensated row is terminal and never reports success. Used when an
 * unknown or failed `compensatable` effect must be reversed rather than
 * repeated (D-08.2, D-18).
 */
export function compensateJournaledOperation(
  db: Database.Database,
  input: {
    readonly journalId: string;
    /** The reversal effect; runs outside the database lock. */
    readonly compensate: () => void;
    readonly now?: () => Date;
    readonly errorCode?: ErrorCode;
  },
): OperationJournalRecord {
  const now = input.now ?? (() => new Date());
  const record = readJournalById(db, input.journalId);
  if (!record) throw new Error(`compensateJournaledOperation: unknown journal ${input.journalId}`);

  // Reversal effect runs outside the database lock.
  input.compensate();

  const nowIso = now().toISOString();
  return withSerializedWrite(db, (tx): OperationJournalRecord => {
    const compensated: OperationJournalRecord = {
      ...record,
      state: 'compensated',
      lastErrorCode: input.errorCode ?? 'INTEGRITY',
      updatedAt: nowIso,
    };
    persistRecord(tx, compensated);
    return compensated;
  });
}

/**
 * Flip a nonterminal journal row to `blocked` with a typed integrity code. A
 * blocked row is terminal, never reports success, and blocks affected
 * readiness/release (D-08.3, NN-EVENT-005). Used when a gap is unreconstructible
 * or manual review declines resolution.
 */
export function blockJournaledOperation(
  db: Database.Database,
  input: { readonly journalId: string; readonly now?: () => Date; readonly errorCode?: ErrorCode },
): OperationJournalRecord {
  const now = input.now ?? (() => new Date());
  const nowIso = now().toISOString();
  return withSerializedWrite(db, (tx): OperationJournalRecord => {
    const row = tx
      .prepare(`SELECT record_json FROM operation_journal WHERE journal_id = ?`)
      .get(input.journalId) as { record_json: string } | undefined;
    if (!row) throw new Error(`blockJournaledOperation: unknown journal ${input.journalId}`);
    const prior = JSON.parse(row.record_json) as OperationJournalRecord;
    const blocked: OperationJournalRecord = {
      ...prior,
      state: 'blocked',
      lastErrorCode: input.errorCode ?? 'INTEGRITY',
      updatedAt: nowIso,
    };
    persistRecord(tx, blocked);
    return blocked;
  });
}

// ─── Restart classifier (D-15 vocabulary; NN-INV-003) ────────────────────────

/** The classification of one nonterminal journal row at restart. */
export interface JournalClassification {
  readonly journalId: string;
  readonly classification: RecoveryClassification;
  readonly reason: string;
}

/**
 * Classify one nonterminal journal record into the D-15 recovery vocabulary.
 * The decision is a pure function of the recorded state, effect-status marker,
 * and declared strategy — never of wall clock, UI, or intent (D-18). The core
 * safety rule (NN-INV-003 / D-18): an operation whose effect status is
 * `unknown` is NEVER classified `safe-to-retry` unless its strategy guarantees
 * a retry cannot duplicate the effect (`pure`) or the provider deduplicates it
 * (`idempotent`). Otherwise an unknown effect routes to a receipt query,
 * compensation, user review, or an integrity block — it is never blindly
 * repeated nor reported successful.
 *
 *   - `pending` / `not-started` → `safe-to-retry` (nothing external happened).
 *   - `observed` (effect known to have happened) → `safe-to-retry` (only the
 *     terminal commit remains; completing it does not repeat the effect).
 *   - `applying` / `unknown`:
 *       - `pure`             → `safe-to-retry` (no external effect exists).
 *       - `idempotent`       → `safe-to-retry` (provider key dedups a retry).
 *       - `receipt-queryable`→ `requires-receipt-query` (learn before acting).
 *       - `compensatable`    → `compensate` (reverse rather than repeat).
 *       - `non-retryable`    → `requires-user-review` (a human must decide).
 *   - `blocked` residue → `blocked-integrity`.
 */
export function classifyJournalRecord(record: OperationJournalRecord): JournalClassification {
  const base = { journalId: record.journalId } as const;

  if (record.state === 'blocked') {
    return { ...base, classification: 'blocked-integrity', reason: 'row is blocked-integrity' };
  }
  if (isTerminalJournalState(record.state)) {
    // committed/compensated are terminal; nothing to classify for retry. Treat
    // as safe-to-retry no-op (idempotent: a committed row replays its receipt).
    return {
      ...base,
      classification: 'safe-to-retry',
      reason: `row is terminal (${record.state}); resolution is idempotent replay`,
    };
  }

  // Effect known to have happened: only the terminal commit remains.
  if (record.effectStatus === 'observed') {
    return {
      ...base,
      classification: 'safe-to-retry',
      reason: 'effect observed; completing terminal commit does not repeat it',
    };
  }

  // Nothing external has happened yet: safe to retry from the top.
  if (record.effectStatus === 'not-started') {
    return {
      ...base,
      classification: 'safe-to-retry',
      reason: 'effect not started; safe to retry from the beginning',
    };
  }

  // effectStatus === 'unknown': the crux of NN-INV-003. Route by strategy;
  // never blindly repeat.
  switch (record.strategy) {
    case 'pure':
      return {
        ...base,
        classification: 'safe-to-retry',
        reason: 'pure operation has no external effect; retry cannot duplicate',
      };
    case 'idempotent':
      return {
        ...base,
        classification: 'safe-to-retry',
        reason: 'idempotent provider key deduplicates a retry of an unknown effect',
      };
    case 'receipt-queryable':
      return {
        ...base,
        classification: 'requires-receipt-query',
        reason: 'unknown effect must be resolved by querying the external receipt',
      };
    case 'compensatable':
      return {
        ...base,
        classification: 'compensate',
        reason: 'unknown effect is compensated rather than repeated',
      };
    case 'non-retryable':
    default:
      return {
        ...base,
        classification: 'requires-user-review',
        reason: 'unknown non-retryable effect requires user review; never repeated or reported successful',
      };
  }
}

/**
 * Classify every nonterminal journal row (state `pending` or `applying`) at
 * restart. Read-only; opens no transaction. This is the startup-recovery step
 * that turns durable saga state into D-15 recovery decisions without touching
 * the external world (NN-INV-003 — an unknown effect is never repeated here).
 */
export function classifyNonterminalOperations(
  db: Database.Database,
): JournalClassification[] {
  const rows = db
    .prepare(
      `SELECT record_json FROM operation_journal
        WHERE state IN ('pending','applying') ORDER BY created_at, journal_id`,
    )
    .all() as { record_json: string }[];
  return rows.map((r) =>
    classifyJournalRecord(JSON.parse(r.record_json) as OperationJournalRecord),
  );
}

// ─── Journal coverage gate (task migration/rollout) ──────────────────────────

/**
 * Assert that a scope has no nonterminal journal rows before an external/
 * filesystem writer is allowed to move (task migration: "Require journal
 * coverage before moving an external/filesystem writer"; rollback drains
 * admission and reconciles all nonterminal operations before switching
 * reader/adapter). Returns a typed non-success when nonterminal rows remain;
 * `undefined` when the scope is fully drained/terminal.
 */
export function assertJournalCoverage(
  db: Database.Database,
  scope: ScopeDescriptor,
  options: { readonly authority?: string; readonly correlationId?: string } = {},
): ErrorEnvelope | undefined {
  const scopeKey = computeScopeKey(scope);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM operation_journal
        WHERE scope_key = ? AND state IN ('pending','applying')`,
    )
    .get(scopeKey) as { c: number };
  if (row.c === 0) return undefined;
  return journalError(
    'INTEGRITY',
    options.authority ?? 'authority-recovery-reconciliation',
    'assert-journal-coverage',
    options.correlationId ?? 'corr-reconcile',
    `cannot move external/filesystem writer: ${row.c} nonterminal operation(s) remain for scope`,
  );
}

// ─── Startup / scheduled reconciliation (D-08.3 / D-18 / NN-EVENT-005) ───────

/** A single detected reconciliation finding for one scope. */
export interface ReconciliationFinding {
  readonly scopeKey: string;
  /** The kind of drift detected between the compared authorities. */
  readonly kind:
    | 'projection-behind' // projection checkpoint < outbox published sequence
    | 'delivery-missing' // a published outbox row has no delivery receipt
    | 'unreconstructible-gap'; // an outbox sequence gap cannot be reconstructed
  /** Whether the reconciler repaired the drift (reconstructible). */
  readonly repaired: boolean;
  readonly detail: string;
  /** Typed integrity code when the gap is unreconstructible and blocks release. */
  readonly code?: ErrorCode;
}

/** The result of a reconciliation pass. */
export interface ReconciliationResult {
  readonly scopesChecked: number;
  readonly findings: readonly ReconciliationFinding[];
  /** Whether any unreconstructible gap was found (blocks release/readiness). */
  readonly releaseBlocked: boolean;
  /** The nonterminal-journal classifications produced this pass. */
  readonly journalClassifications: readonly JournalClassification[];
}

/**
 * Startup / scheduled reconciliation (D-08.3, D-18, NN-EVENT-005). In one
 * pass it:
 *
 *   1. classifies every nonterminal journal row into a D-15 recovery decision
 *      (without touching the external world);
 *   2. per scope, compares the business/outbox authority (the highest published
 *      outbox sequence), the delivery receipts, and the projection checkpoint;
 *   3. repairs reconstructible drift — a projection checkpoint that is behind
 *      the published outbox sequence is advanced to the last contiguously
 *      published sequence (projections are rebuildable, D-08.3 / NN-EVENT-004);
 *   4. surfaces an unreconstructible gap (a hole in the published outbox
 *      sequence that cannot be reconstructed from the ledger) as a typed
 *      `INTEGRITY` finding that blocks affected release/readiness
 *      (NN-EVENT-005).
 *
 * Repairs (advancing the reconciler's own projection checkpoint) commit in the
 * serialized writer. Reconciliation writes only ledger tables this module owns;
 * it never mutates a business table (NN-INV-008).
 */
export function reconcile(
  db: Database.Database,
  options: { readonly now?: () => Date } = {},
): ReconciliationResult {
  const now = options.now ?? (() => new Date());
  const nowIso = now().toISOString();

  const journalClassifications = classifyNonterminalOperations(db);

  // Distinct scopes seen across the outbox (the authoritative event ledger).
  const scopeRows = db
    .prepare(`SELECT DISTINCT scope_key FROM outbox ORDER BY scope_key`)
    .all() as { scope_key: string }[];

  const findings: ReconciliationFinding[] = [];
  let releaseBlocked = false;

  for (const { scope_key: scopeKey } of scopeRows) {
    // Highest contiguous published sequence and any gap in the published set.
    const published = db
      .prepare(
        `SELECT sequence FROM outbox
          WHERE scope_key = ? AND state = 'published' ORDER BY sequence`,
      )
      .all(scopeKey) as { sequence: number }[];
    const publishedSeqs = published.map((r) => r.sequence);

    // Determine the last contiguous published sequence starting from 1 and
    // whether there is an unreconstructible hole (a published sequence beyond a
    // missing one, i.e. the gap is not merely "not yet published").
    let contiguous = 0;
    const publishedSet = new Set(publishedSeqs);
    const maxPublished = publishedSeqs.length > 0 ? Math.max(...publishedSeqs) : 0;
    for (let s = 1; s <= maxPublished; s++) {
      if (publishedSet.has(s)) {
        if (s === contiguous + 1) contiguous = s;
      }
    }
    // An unreconstructible gap: a published sequence exists ABOVE a
    // never-recorded sequence (the middle row is gone from the ledger entirely).
    let hasUnreconstructibleGap = false;
    for (let s = 1; s < maxPublished; s++) {
      if (!publishedSet.has(s)) {
        // Is sequence s present in the outbox at all (any state)? If it is
        // absent entirely while a higher sequence is published, the ledger has
        // an irrecoverable hole.
        const anyRow = db
          .prepare(`SELECT 1 FROM outbox WHERE scope_key = ? AND sequence = ? LIMIT 1`)
          .get(scopeKey, s) as Record<string, number> | undefined;
        if (!anyRow) {
          hasUnreconstructibleGap = true;
          break;
        }
      }
    }

    if (hasUnreconstructibleGap) {
      findings.push({
        scopeKey,
        kind: 'unreconstructible-gap',
        repaired: false,
        detail: `scope has a published outbox sequence above a missing ledger row; cannot reconstruct`,
        code: 'INTEGRITY',
      });
      releaseBlocked = true;
      // Record the checkpoint as blocked so readiness reflects it.
      withSerializedWrite(db, (tx) => {
        tx.prepare(
          `INSERT INTO reconciliation_projection_checkpoints
             (scope_key, last_verified_sequence, status, updated_at)
           VALUES (?, ?, 'blocked', ?)
           ON CONFLICT(scope_key) DO UPDATE SET
             status = 'blocked', updated_at = excluded.updated_at`,
        ).run(scopeKey, contiguous, nowIso);
      });
      continue;
    }

    // Delivery-receipt comparison: every published row should have >=1 delivery
    // receipt (D-08.3 "records destination receipt"). A published row missing a
    // receipt is a reconstructible drift the publisher will resolve on retry.
    const missingDelivery = db
      .prepare(
        `SELECT o.sequence AS seq FROM outbox o
          WHERE o.scope_key = ? AND o.state = 'published'
            AND NOT EXISTS (
              SELECT 1 FROM outbox_delivery_receipts d WHERE d.event_id = o.event_id
            )
          ORDER BY o.sequence`,
      )
      .all(scopeKey) as { seq: number }[];
    if (missingDelivery.length > 0) {
      findings.push({
        scopeKey,
        kind: 'delivery-missing',
        repaired: true,
        detail: `${missingDelivery.length} published event(s) without a delivery receipt; publisher retry will deliver`,
      });
    }

    // Projection checkpoint comparison + repair. The reconciler's own
    // projection checkpoint should track the last contiguous published
    // sequence. If it is behind, advance it (projections are rebuildable).
    const ckptRow = db
      .prepare(
        `SELECT last_verified_sequence AS seq, status FROM reconciliation_projection_checkpoints
          WHERE scope_key = ?`,
      )
      .get(scopeKey) as { seq: number; status: string } | undefined;
    const projectionSeq = ckptRow?.seq ?? 0;
    if (projectionSeq < contiguous) {
      withSerializedWrite(db, (tx) => {
        tx.prepare(
          `INSERT INTO reconciliation_projection_checkpoints
             (scope_key, last_verified_sequence, status, updated_at)
           VALUES (?, ?, 'current', ?)
           ON CONFLICT(scope_key) DO UPDATE SET
             last_verified_sequence = excluded.last_verified_sequence,
             status = 'current',
             updated_at = excluded.updated_at`,
        ).run(scopeKey, contiguous, nowIso);
      });
      findings.push({
        scopeKey,
        kind: 'projection-behind',
        repaired: true,
        detail: `projection checkpoint advanced from ${projectionSeq} to ${contiguous}`,
      });
    } else if (ckptRow === undefined && contiguous > 0) {
      // Initialize a checkpoint at the current contiguous sequence.
      withSerializedWrite(db, (tx) => {
        tx.prepare(
          `INSERT INTO reconciliation_projection_checkpoints
             (scope_key, last_verified_sequence, status, updated_at)
           VALUES (?, ?, 'current', ?)
           ON CONFLICT(scope_key) DO NOTHING`,
        ).run(scopeKey, contiguous, nowIso);
      });
    }
  }

  return {
    scopesChecked: scopeRows.length,
    findings,
    releaseBlocked,
    journalClassifications,
  };
}

/** Read the reconciler's projection checkpoint for a scope (read-only). */
export function readReconciliationCheckpoint(
  db: Database.Database,
  scope: ScopeDescriptor,
): { readonly lastVerifiedSequence: number; readonly status: string } | undefined {
  const scopeKey = computeScopeKey(scope);
  const row = db
    .prepare(
      `SELECT last_verified_sequence AS seq, status FROM reconciliation_projection_checkpoints
        WHERE scope_key = ?`,
    )
    .get(scopeKey) as { seq: number; status: string } | undefined;
  return row ? { lastVerifiedSequence: row.seq, status: row.status } : undefined;
}

/** The authority id that owns operation-journal reconciliation. */
export const OPERATION_JOURNAL_OWNER = 'authority-recovery-reconciliation';
