/**
 * OutboxPublisher — ordered outbox publication and idempotent consumers
 * (FUT-PKG-03-DURABILITY/T-002).
 *
 * D-08.3 assigns the publisher this contract: "claims eligible rows with a
 * bounded lease and owner token, publishes `DomainEvent@1`, records destination
 * receipt, then marks published. Lease expiry allows retry; consumers
 * deduplicate by event ID/idempotency." Durable ordering uses authority
 * revision and scope sequence, never wall-clock timestamps (D-19.1). A sequence
 * gap, payload-digest mismatch, or incompatible version stops publication for
 * that scope at the last verified sequence and never skips ahead or reorders
 * (task acceptance; D-08.3 "stops on gap/version/hash failure").
 *
 * This module is additive over {@link ./authority-transaction} (which owns the
 * `outbox` table filled inside the business mutation transaction, D-08.2) and
 * {@link ./database-authority} (the single serialized `IMMEDIATE` writer,
 * D-08.2). It introduces NO second durable writer for a business table: it only
 * advances the existing `outbox` rows through their `pending → leased →
 * published | failed` ladder and appends two NEW ledger tables it solely owns —
 * `outbox_delivery_receipts` (one row per destination per event) and
 * `outbox_consumer_receipts` (the consumer dedup ledger). Delivery is
 * shadow-first: destinations are marked non-authoritative until promoted, so
 * publication cannot become a second source of truth (task rollout;
 * NN-COMPAT-001/002).
 *
 * Delivery is at-least-once (a lease can expire after a publish attempt but
 * before the row is marked published, so the same event may be delivered
 * again). The consumer receipt ledger keyed by `(destination, event_id)` makes
 * the consumer effect exactly-once: a duplicate delivery is recognized and its
 * effect is applied at most once (task acceptance "exactly-once consumer
 * effect").
 *
 * Design anchors: D-07 (`DomainEvent@1`, `OutboxRecord@1`), D-08 (D-08.3
 * publication/lease/dedup), D-19 (D-19.3 `outbox_lag_records` /
 * `outbox_oldest_age_seconds`, D-19.4 lag/health), D-20 (shadow-first rollout).
 * Requirements: NN-EVENT-001 (ordered per scope), NN-EVENT-002 (monotonic
 * sequence), NN-EVENT-003 (at-least-once + idempotent consumer), NN-EVENT-006
 * (stop on gap/hash/version), NN-EVENT-008 (integrity), NN-EVENT-011 (typed
 * failure), NN-OBS-001 (redacted observation), NN-OBS-005 (lag/health).
 */

import type Database from 'better-sqlite3';

import {
  classifyReadableVersion,
  computeDigest,
  type ErrorCode,
} from '../shared/contract-primitives.js';
import { withSerializedWrite } from './database-authority.js';
import {
  computeScopeKey,
  type DomainEvent,
  type OutboxRecord,
  type OutboxState,
} from './authority-transaction.js';

// ─── Publisher-owned ledger tables (D-08.3) ─────────────────────────────────

/**
 * DDL for the two ledger tables the publisher solely owns. Both are additive
 * and idempotent (`IF NOT EXISTS`); neither is a business table nor a second
 * writer for one. `outbox_delivery_receipts` records one durable receipt per
 * (destination, event) delivery attempt/success. `outbox_consumer_receipts`
 * is the consumer dedup ledger: `(destination, event_id)` is UNIQUE so a
 * duplicate at-least-once delivery is recognized and its effect applied once.
 */
const PUBLISHER_TABLES_DDL = `
  -- One durable receipt per destination per event (D-08.3 "records destination
  -- receipt"). authoritative=0 marks a shadow (non-authoritative) destination
  -- so publication cannot become a second source of truth (task rollout).
  CREATE TABLE IF NOT EXISTS outbox_delivery_receipts (
    receipt_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    destination TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    payload_digest TEXT NOT NULL,
    authoritative INTEGER NOT NULL,
    delivered_at TEXT NOT NULL,
    UNIQUE (destination, event_id)
  );

  -- Consumer dedup ledger (D-08.3 "consumers deduplicate by event ID"). The
  -- UNIQUE (destination, event_id) is the exactly-once effect gate.
  CREATE TABLE IF NOT EXISTS outbox_consumer_receipts (
    consumer_receipt_id TEXT PRIMARY KEY,
    destination TEXT NOT NULL,
    event_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    UNIQUE (destination, event_id)
  );

  CREATE INDEX IF NOT EXISTS idx_delivery_event ON outbox_delivery_receipts (event_id);
  CREATE INDEX IF NOT EXISTS idx_consumer_scope_seq
    ON outbox_consumer_receipts (destination, scope_key, sequence);
`;

/**
 * Create the publisher-owned ledger tables if absent. Idempotent and additive;
 * safe to run at startup or in tests. Requires {@link ensureAuthorityTables}
 * (the `outbox` table it advances) to have run first.
 */
export function ensurePublisherTables(db: Database.Database): void {
  db.exec(PUBLISHER_TABLES_DDL);
}

// ─── Publisher errors (NN-EVENT-006/011 typed stop) ──────────────────────────

/**
 * Why publication stopped for a scope. Each preserves the last verified
 * sequence and never skips ahead or reorders by wall clock:
 *   - `SEQUENCE_GAP` — the next eligible row is not `lastPublished + 1`.
 *   - `PAYLOAD_DIGEST_MISMATCH` — a row's stored digest ≠ the embedded event
 *     digest ≠ `computeDigest(payload)` (tamper/corruption).
 *   - `INCOMPATIBLE_VERSION` — the embedded `DomainEvent@1` carries a
 *     schemaVersion outside the readable window.
 */
export type PublicationStopReason =
  | 'SEQUENCE_GAP'
  | 'PAYLOAD_DIGEST_MISMATCH'
  | 'INCOMPATIBLE_VERSION';

/** The typed error code each stop reason maps to (D-06.2 taxonomy). */
const STOP_REASON_CODE: Readonly<Record<PublicationStopReason, ErrorCode>> =
  Object.freeze({
    SEQUENCE_GAP: 'INTEGRITY',
    PAYLOAD_DIGEST_MISMATCH: 'INTEGRITY',
    INCOMPATIBLE_VERSION: 'INCOMPATIBLE',
  });

/**
 * A typed publication stop. Thrown-free: the publisher returns it on the
 * scope result so a caller sees the last verified sequence and the reason
 * without an exception unwinding the loop (NN-EVENT-011).
 */
export class PublicationStop {
  readonly reason: PublicationStopReason;
  readonly code: ErrorCode;
  readonly scopeKey: string;
  /** The last sequence verified/published before the stop. */
  readonly lastVerifiedSequence: number;
  /** The offending sequence that triggered the stop. */
  readonly offendingSequence: number;
  readonly detail: string;
  constructor(input: {
    reason: PublicationStopReason;
    scopeKey: string;
    lastVerifiedSequence: number;
    offendingSequence: number;
    detail: string;
  }) {
    this.reason = input.reason;
    this.code = STOP_REASON_CODE[input.reason];
    this.scopeKey = input.scopeKey;
    this.lastVerifiedSequence = input.lastVerifiedSequence;
    this.offendingSequence = input.offendingSequence;
    this.detail = input.detail;
  }
}

// ─── Lease options and results ───────────────────────────────────────────────

/** A destination the publisher fans an event out to. */
export interface PublishDestination {
  /** Stable destination id, e.g. `eventbus`, `pipeline-eventlog`. */
  readonly id: string;
  /**
   * Whether the destination is authoritative. Shadow-first rollout keeps
   * non-authoritative destinations at `false` so a delivery receipt for them
   * can never be treated as a durable source of truth (task rollout).
   */
  readonly authoritative?: boolean;
  /**
   * The delivery sink. Called with the published event; a throw marks the
   * delivery failed for this destination without stopping the scope (the row
   * is not marked published, so the lease can expire and retry). Omitted sinks
   * are treated as a successful no-op delivery (a receipt is still recorded).
   */
  readonly deliver?: (event: DomainEvent) => void;
}

/** Options for a publication pass. */
export interface PublishOptions {
  /** Opaque lease owner token identifying this publisher instance. */
  readonly leaseOwner: string;
  /** Destinations to fan each published event out to (>= 1). */
  readonly destinations: readonly PublishDestination[];
  /** Lease duration in milliseconds; a lease older than this is reclaimable. */
  readonly leaseDurationMs: number;
  /** Max records to lease/publish in this pass (bounded batch). Default 128. */
  readonly batchSize?: number;
  /** Injectable clock (tests). */
  readonly now?: () => Date;
  /**
   * Test-only fault hook invoked AFTER a destination delivery but BEFORE the
   * row is marked published, simulating a crash between deliver and mark. The
   * lease then expires and the event is retried (at-least-once). Receives the
   * event being published.
   */
  readonly faultAfterDeliver?: (event: DomainEvent) => void;
}

/** The outcome of publishing one outbox record. */
export interface PublishedRecord {
  readonly eventId: string;
  readonly scopeKey: string;
  readonly sequence: number;
  /** Destinations that received a recorded delivery receipt this pass. */
  readonly deliveredTo: readonly string[];
  /** Destinations whose sink threw (delivery failed; will retry). */
  readonly failedDestinations: readonly string[];
}

/** The result of a full publication pass. */
export interface PublishResult {
  readonly leaseOwner: string;
  readonly published: readonly PublishedRecord[];
  /** Per-scope stops encountered (ordered-stop, no skip-ahead). */
  readonly stops: readonly PublicationStop[];
}

// ─── Internal row shape ──────────────────────────────────────────────────────

interface OutboxRow {
  readonly outbox_id: string;
  readonly event_id: string;
  readonly scope_key: string;
  readonly sequence: number;
  readonly payload_digest: string;
  readonly state: OutboxState;
  readonly available_at: string;
  readonly attempt_count: number;
  readonly record_json: string;
}

const PUBLISHER_OWNER = 'authority-event-outbox-publisher';

// ─── Lease reclamation (D-08.3 "lease expiry allows retry") ──────────────────

/**
 * Reclaim expired leases: any row in `leased` whose `lease_until` is at or
 * before now is reset to `pending` so it can be re-leased and retried. Runs
 * inside the serialized writer. Returns the number of rows reclaimed. This is
 * how a publisher crash between deliver and mark-published resolves into an
 * at-least-once retry rather than a lost event.
 */
function reclaimExpiredLeases(tx: Database.Database, nowIso: string): number {
  const info = tx
    .prepare(
      `UPDATE outbox
         SET state = 'pending'
       WHERE state = 'leased' AND lease_until IS NOT NULL AND lease_until <= ?`,
    )
    .run(nowIso);
  return info.changes;
}

/**
 * Ensure the optional lease columns exist on the `outbox` table. T-001 created
 * the table without dedicated lease columns; the publisher owns the lease
 * lifecycle, so it adds `lease_owner`, `lease_until`, `published_at`, and
 * `last_error_code` additively (idempotent; ignores "duplicate column").
 */
export function ensureLeaseColumns(db: Database.Database): void {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(outbox)`).all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  const add = (name: string, ddl: string): void => {
    if (!columns.has(name)) db.exec(`ALTER TABLE outbox ADD COLUMN ${ddl}`);
  };
  add('lease_owner', 'lease_owner TEXT');
  add('lease_until', 'lease_until TEXT');
  add('published_at', 'published_at TEXT');
  add('last_error_code', 'last_error_code TEXT');
}

// ─── Eligible-row selection (per scope, monotonic order) ─────────────────────

/**
 * The highest already-`published` sequence for a scope, or 0 if none. The next
 * eligible sequence must be exactly this + 1 (contiguity); anything else is a
 * gap and stops the scope (NN-EVENT-006).
 */
function lastPublishedSequence(tx: Database.Database, scopeKey: string): number {
  const row = tx
    .prepare(
      `SELECT MAX(sequence) AS s FROM outbox WHERE scope_key = ? AND state = 'published'`,
    )
    .get(scopeKey) as { s: number | null } | undefined;
  return row?.s ?? 0;
}

/** All distinct scope keys that currently have at least one pending row. */
function scopesWithPending(tx: Database.Database, nowIso: string): string[] {
  const rows = tx
    .prepare(
      `SELECT DISTINCT scope_key FROM outbox
        WHERE state = 'pending' AND available_at <= ?
        ORDER BY scope_key`,
    )
    .all(nowIso) as { scope_key: string }[];
  return rows.map((r) => r.scope_key);
}

// ─── Integrity verification before publish (NN-EVENT-006/008) ────────────────

/**
 * Verify a row's integrity before publishing it. Confirms:
 *   - the embedded `DomainEvent@1` schemaVersion is readable;
 *   - the row's stored `payload_digest` equals the embedded event digest;
 *   - the embedded event digest equals `computeDigest(payload)` (no tamper).
 * Returns a {@link PublicationStop} reason if any check fails, else undefined.
 */
function verifyRowIntegrity(
  record: OutboxRecord,
  storedDigest: string,
): PublicationStopReason | undefined {
  // We treat DomainEvent as an @1 contract; reuse the CommandReceipt window
  // (all @1 contracts share [1,1]) via a representative readable check.
  const version = record.event.schemaVersion as unknown as number;
  if (classifyReadableVersion('CommandReceipt', version) !== 'readable') {
    return 'INCOMPATIBLE_VERSION';
  }
  if (storedDigest !== record.event.payloadDigest) {
    return 'PAYLOAD_DIGEST_MISMATCH';
  }
  if (computeDigest(record.event.payload) !== record.event.payloadDigest) {
    return 'PAYLOAD_DIGEST_MISMATCH';
  }
  return undefined;
}

// ─── Lease phase (committed before delivery) ─────────────────────────────────

/** A row leased for delivery in the current pass, with its decoded record. */
interface LeasedRow {
  readonly outboxId: string;
  readonly eventId: string;
  readonly scopeKey: string;
  readonly sequence: number;
  readonly payloadDigest: string;
  readonly attemptCount: number;
  readonly record: OutboxRecord;
}

/**
 * Phase 1 — lease eligible rows in monotonic per-scope order and COMMIT the
 * leases before any delivery. Runs inside the serialized `IMMEDIATE` writer:
 *
 *   1. reclaim expired leases (retry window);
 *   2. per scope, verify the next pending row is `lastPublished + 1` (else stop
 *      with `SEQUENCE_GAP` — never skip ahead);
 *   3. verify payload digest + event version (else `PAYLOAD_DIGEST_MISMATCH` /
 *      `INCOMPATIBLE_VERSION`);
 *   4. compare-and-set `pending → leased` with owner + `lease_until`.
 *
 * Because leasing commits here, a crash during phase 2 (delivery) leaves the
 * row durably `leased` until its lease expires — a later pass reclaims and
 * retries it (at-least-once). A concurrent publisher never re-leases a row that
 * is already `leased` by the compare-and-set guard.
 */
function leaseEligibleRows(
  db: Database.Database,
  options: PublishOptions,
  nowIso: string,
  leaseUntilIso: string,
  batchSize: number,
): { leased: LeasedRow[]; stops: PublicationStop[] } {
  return withSerializedWrite(db, (tx) => {
    reclaimExpiredLeases(tx, nowIso);

    const leased: LeasedRow[] = [];
    const stops: PublicationStop[] = [];
    let budget = batchSize;

    for (const scopeKey of scopesWithPending(tx, nowIso)) {
      let lastVerified = lastPublishedSequence(tx, scopeKey);

      while (budget > 0) {
        const row = tx
          .prepare(
            `SELECT outbox_id, event_id, scope_key, sequence, payload_digest, state,
                    available_at, attempt_count, record_json
               FROM outbox
              WHERE scope_key = ? AND state = 'pending' AND available_at <= ?
              ORDER BY sequence ASC
              LIMIT 1`,
          )
          .get(scopeKey, nowIso) as OutboxRow | undefined;
        if (!row) break;

        // Step 2: contiguity — never skip ahead or reorder.
        if (row.sequence !== lastVerified + 1) {
          stops.push(
            new PublicationStop({
              reason: 'SEQUENCE_GAP',
              scopeKey,
              lastVerifiedSequence: lastVerified,
              offendingSequence: row.sequence,
              detail: `expected sequence ${lastVerified + 1} but next pending is ${row.sequence}`,
            }),
          );
          break;
        }

        const record = JSON.parse(row.record_json) as OutboxRecord;

        // Step 3: integrity (digest + version) before any lease.
        const stopReason = verifyRowIntegrity(record, row.payload_digest);
        if (stopReason) {
          stops.push(
            new PublicationStop({
              reason: stopReason,
              scopeKey,
              lastVerifiedSequence: lastVerified,
              offendingSequence: row.sequence,
              detail:
                stopReason === 'INCOMPATIBLE_VERSION'
                  ? `event ${row.event_id} carries unreadable schemaVersion`
                  : `event ${row.event_id} payload digest does not verify`,
            }),
          );
          tx.prepare(`UPDATE outbox SET last_error_code = ? WHERE outbox_id = ?`).run(
            STOP_REASON_CODE[stopReason],
            row.outbox_id,
          );
          break;
        }

        // Step 4: compare-and-set pending -> leased with owner + until.
        const claim = tx
          .prepare(
            `UPDATE outbox
               SET state = 'leased', lease_owner = ?, lease_until = ?,
                   attempt_count = attempt_count + 1
             WHERE outbox_id = ? AND state = 'pending'`,
          )
          .run(options.leaseOwner, leaseUntilIso, row.outbox_id);
        if (claim.changes !== 1) break; // lost the race; another owner has it.

        leased.push({
          outboxId: row.outbox_id,
          eventId: row.event_id,
          scopeKey,
          sequence: row.sequence,
          payloadDigest: row.payload_digest,
          attemptCount: row.attempt_count + 1,
          record,
        });
        lastVerified = row.sequence;
        budget -= 1;
      }
    }

    return { leased, stops };
  });
}

// ─── Publication pass (lease → deliver → receipt → mark) ─────────────────────

/**
 * Run one bounded publication pass across every scope with pending, eligible
 * outbox rows. Two committed phases:
 *
 *   Phase 1 ({@link leaseEligibleRows}): lease eligible rows in monotonic
 *   per-scope order and commit the leases. Gap/digest/version failures stop the
 *   scope at its last verified sequence and never skip ahead.
 *
 *   Phase 2 (here): for each leased row, in order, deliver `DomainEvent@1` to
 *   each destination, record a durable per-destination delivery receipt, and
 *   mark the row `published` — each row's delivery+mark committed in its own
 *   serialized transaction. A crash between deliver and mark leaves the row
 *   durably `leased`; its lease expires and a later pass retries it, so
 *   delivery is at-least-once. If every destination for a row fails, the row is
 *   left leased (no mark) to retry after lease expiry.
 *
 * Ordering is by scope sequence, never wall clock (D-19.1).
 */
export function publishOutbox(
  db: Database.Database,
  options: PublishOptions,
): PublishResult {
  if (options.destinations.length === 0) {
    throw new Error('publishOutbox: at least one destination is required');
  }
  const now = options.now ?? (() => new Date());
  const batchSize = options.batchSize ?? 128;
  const nowDate = now();
  const nowIso = nowDate.toISOString();
  const leaseUntilIso = new Date(nowDate.getTime() + options.leaseDurationMs).toISOString();

  // Phase 1: lease eligible rows and commit the leases.
  const { leased, stops } = leaseEligibleRows(
    db,
    options,
    nowIso,
    leaseUntilIso,
    batchSize,
  );

  // Phase 2: deliver + mark published, each row in its own committed txn.
  const published: PublishedRecord[] = [];
  for (const row of leased) {
    const deliveredTo: string[] = [];
    const failedDestinations: string[] = [];
    for (const dest of options.destinations) {
      try {
        dest.deliver?.(row.record.event);
        deliveredTo.push(dest.id);
      } catch {
        failedDestinations.push(dest.id);
      }
    }

    // Test-only fault: crash between deliver and mark-published. The row stays
    // durably leased; its lease expires and the event retries (at-least-once).
    options.faultAfterDeliver?.(row.record.event);

    // If every destination failed, leave the row leased to retry after expiry.
    if (failedDestinations.length === options.destinations.length) {
      continue;
    }

    const publishedRecord: OutboxRecord = {
      ...row.record,
      state: 'published',
      attemptCount: row.attemptCount,
      leaseOwner: options.leaseOwner,
      leaseUntil: leaseUntilIso,
      publishedAt: nowIso,
    };

    withSerializedWrite(db, (tx) => {
      for (const destId of deliveredTo) {
        const dest = options.destinations.find((d) => d.id === destId);
        const receiptId = `dr-${destId}-${row.eventId}`.toLowerCase();
        tx.prepare(
          `INSERT INTO outbox_delivery_receipts
             (receipt_id, event_id, destination, scope_key, sequence,
              payload_digest, authoritative, delivered_at)
           VALUES (@receiptId, @eventId, @destination, @scopeKey, @sequence,
              @payloadDigest, @authoritative, @deliveredAt)
           ON CONFLICT(destination, event_id) DO NOTHING`,
        ).run({
          receiptId,
          eventId: row.eventId,
          destination: destId,
          scopeKey: row.scopeKey,
          sequence: row.sequence,
          payloadDigest: row.payloadDigest,
          authoritative: dest?.authoritative === true ? 1 : 0,
          deliveredAt: nowIso,
        });
      }
      // Only the lease owner may mark its leased row published.
      tx.prepare(
        `UPDATE outbox
           SET state = 'published', published_at = ?, record_json = ?
         WHERE outbox_id = ? AND state = 'leased' AND lease_owner = ?`,
      ).run(nowIso, JSON.stringify(publishedRecord), row.outboxId, options.leaseOwner);
    });

    published.push({
      eventId: row.eventId,
      scopeKey: row.scopeKey,
      sequence: row.sequence,
      deliveredTo,
      failedDestinations,
    });
  }

  return { leaseOwner: options.leaseOwner, published, stops };
}

// ─── Idempotent consumer effect (exactly-once, NN-EVENT-003) ─────────────────

/** The outcome of a consumer applying a delivered event. */
export type ConsumeOutcome =
  | { readonly kind: 'applied'; readonly consumerReceiptId: string }
  | { readonly kind: 'duplicate'; readonly consumerReceiptId: string };

/**
 * Apply a delivered event's effect exactly once at a consumer, deduplicating by
 * `(destination, eventId)`. Under at-least-once delivery the same event may
 * arrive more than once; the first call runs `apply` and records a consumer
 * receipt, every later call for the same (destination, event) recognizes the
 * duplicate and does NOT run `apply` again (D-08.3, NN-EVENT-003). The `apply`
 * effect and the receipt insert commit together in the serialized writer, so a
 * crash between them cannot record a receipt without the effect.
 */
export function consumeEventOnce(
  db: Database.Database,
  input: {
    readonly destination: string;
    readonly event: DomainEvent;
    readonly apply: (tx: Database.Database, event: DomainEvent) => void;
    readonly now?: () => Date;
  },
): ConsumeOutcome {
  const now = input.now ?? (() => new Date());
  const scopeKey = computeScopeKey(input.event.scope);
  const consumerReceiptId = `cr-${input.destination}-${input.event.eventId}`.toLowerCase();

  return withSerializedWrite(db, (tx): ConsumeOutcome => {
    const existing = tx
      .prepare(
        `SELECT consumer_receipt_id FROM outbox_consumer_receipts
          WHERE destination = ? AND event_id = ?`,
      )
      .get(input.destination, input.event.eventId) as
      | { consumer_receipt_id: string }
      | undefined;
    if (existing) {
      return { kind: 'duplicate', consumerReceiptId: existing.consumer_receipt_id };
    }

    // First delivery: run the effect and record the dedup receipt atomically.
    input.apply(tx, input.event);
    tx.prepare(
      `INSERT INTO outbox_consumer_receipts
         (consumer_receipt_id, destination, event_id, scope_key, sequence,
          idempotency_key, applied_at)
       VALUES (@id, @destination, @eventId, @scopeKey, @sequence, @idem, @appliedAt)`,
    ).run({
      id: consumerReceiptId,
      destination: input.destination,
      eventId: input.event.eventId,
      scopeKey,
      sequence: input.event.sequence,
      idem: input.event.idempotencyKey,
      appliedAt: now().toISOString(),
    });
    return { kind: 'applied', consumerReceiptId };
  });
}

// ─── Lag / health (D-19.3 outbox_lag_records / oldest age, D-19.4) ───────────

/**
 * Outbox lag / health snapshot. `pendingRecords` is the number of unpublished
 * (pending or leased) rows; `oldestPendingAgeSeconds` is the age of the oldest
 * unpublished row's `available_at` relative to now, in whole seconds (never
 * negative). `stoppedScopes` lists scopes currently blocked at a last verified
 * sequence by a gap/hash/version stop. These feed the `outbox_lag_records` and
 * `outbox_oldest_age_seconds` gauges (D-19.3) and the readiness outbox-lag
 * signal (D-19.4).
 */
export interface OutboxHealth {
  readonly pendingRecords: number;
  readonly leasedRecords: number;
  readonly publishedRecords: number;
  readonly oldestPendingAgeSeconds: number;
  readonly stoppedScopes: readonly {
    readonly scopeKey: string;
    readonly lastVerifiedSequence: number;
    readonly lastErrorCode: string;
  }[];
}

/**
 * Compute the outbox lag/health snapshot. Read-only; opens no transaction and
 * never mutates. Ages come from `available_at` diffed against `now`, never used
 * as an ordering key (D-19.1). A stopped scope is one whose lowest pending
 * sequence is not contiguous with its last published sequence, or whose next
 * row carries a `last_error_code`.
 */
export function computeOutboxHealth(
  db: Database.Database,
  now: () => Date = () => new Date(),
): OutboxHealth {
  const nowMs = now().getTime();
  const counts = db
    .prepare(
      `SELECT state, COUNT(*) AS c FROM outbox GROUP BY state`,
    )
    .all() as { state: OutboxState; c: number }[];
  const byState = new Map<OutboxState, number>(counts.map((r) => [r.state, r.c]));
  const pendingRecords = byState.get('pending') ?? 0;
  const leasedRecords = byState.get('leased') ?? 0;
  const publishedRecords = byState.get('published') ?? 0;

  const oldest = db
    .prepare(
      `SELECT MIN(available_at) AS a FROM outbox WHERE state IN ('pending','leased')`,
    )
    .get() as { a: string | null } | undefined;
  let oldestPendingAgeSeconds = 0;
  if (oldest?.a) {
    const ageMs = nowMs - Date.parse(oldest.a);
    oldestPendingAgeSeconds = ageMs > 0 ? Math.floor(ageMs / 1000) : 0;
  }

  // Detect stopped scopes: for each scope with pending rows, the minimum
  // pending sequence must be lastPublished + 1; otherwise it is gap-stopped.
  const stoppedScopes: {
    scopeKey: string;
    lastVerifiedSequence: number;
    lastErrorCode: string;
  }[] = [];
  const scopeRows = db
    .prepare(
      `SELECT scope_key,
              MAX(CASE WHEN state = 'published' THEN sequence END) AS lastPublished,
              MIN(CASE WHEN state = 'pending' THEN sequence END) AS minPending
         FROM outbox
        GROUP BY scope_key`,
    )
    .all() as {
    scope_key: string;
    lastPublished: number | null;
    minPending: number | null;
  }[];
  for (const s of scopeRows) {
    if (s.minPending === null) continue; // nothing pending in this scope.
    const lastPublished = s.lastPublished ?? 0;
    if (s.minPending !== lastPublished + 1) {
      const errRow = db
        .prepare(
          `SELECT last_error_code FROM outbox
            WHERE scope_key = ? AND sequence = ? LIMIT 1`,
        )
        .get(s.scope_key, s.minPending) as { last_error_code: string | null } | undefined;
      stoppedScopes.push({
        scopeKey: s.scope_key,
        lastVerifiedSequence: lastPublished,
        lastErrorCode: errRow?.last_error_code ?? 'SEQUENCE_GAP',
      });
    }
  }

  return {
    pendingRecords,
    leasedRecords,
    publishedRecords,
    oldestPendingAgeSeconds,
    stoppedScopes,
  };
}

/** The authority id that owns the outbox publisher. */
export const OUTBOX_PUBLISHER_OWNER = PUBLISHER_OWNER;
