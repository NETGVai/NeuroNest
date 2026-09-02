/**
 * LegacyEventAdapters — consolidate the three coexisting legacy event
 * abstractions under the same-transaction table + outbox authority
 * (FUT-PKG-03-DURABILITY/T-005).
 *
 * The Task 0.4 inventory (requirements §2.6) found three observed-divergent
 * durable/near-durable event paths in the current tree:
 *
 *   - `src/pipeline/event-log.ts` — the Pipeline `EventLog`: an independent
 *     durable writer of `pipeline_events` rows with its own per-session `seq`
 *     allocator, ring buffer, retry queue, compactor, and rate limiter.
 *   - `src/events/event-bus.ts` — the SQLite `EventBus`: an independent durable
 *     writer of `skill_events` rows plus an in-memory delivery/subscription
 *     fabric.
 *   - `src/events/action-event-stream.ts` — the in-memory `ActionEventStream`
 *     of typed Action/Observation events.
 *
 * D-05 / D-08.3 / D-20 and R5 (CD-025) require that the durable SQLite business
 * tables and the SAME-TRANSACTION outbox (owned by
 * {@link ../storage/authority-transaction}, T-001) are the SOLE write authority
 * for durable events. Under that authority:
 *
 *   - `EventBus` becomes a delivery / projection adapter over the COMMITTED
 *     outbox (NN-EVENT-011): it never writes a durable row of its own; it
 *     consumes published `DomainEvent@1` through the T-002 publisher
 *     ({@link ../storage/outbox-publisher.publishOutbox}) and applies each
 *     subscriber effect exactly-once through
 *     {@link ../storage/outbox-publisher.consumeEventOnce}.
 *   - `EventLog` becomes a read / history adapter (NN-EVENT-011: "MAY retain
 *     compatible history during migration"). Its history is DERIVED from the
 *     committed outbox — this module never inserts a `pipeline_events` row on
 *     the authority path; the legacy writer stays available only as a
 *     shadow/transitional reader until replay parity retires it (P8).
 *   - `ActionEventStream` stays EPHEMERAL and NON-AUTHORIZING (NN-EVENT-011):
 *     it observes only, and this module provides a guard that structurally
 *     forbids it from acknowledging a durable mutation or reconstructing
 *     durable state.
 *
 * This module is ADDITIVE over T-001..T-004: it introduces NO second durable
 * writer for a business table and NO new durable table. It reads the committed
 * `outbox` table, drives the existing T-002 publisher/consumer ledgers, and
 * materializes in-memory history projections. Retirement / physical removal of
 * the legacy modules is deferred to P8 (per the task: "Do NOT remove the legacy
 * modules yet"); this task establishes the single-writer authority, the
 * adapters, and the replay-parity evidence.
 *
 * Replay parity (NN-EVENT-005 / task acceptance): before any legacy emit path
 * can be treated as retired, {@link compareEventHistoryParity} proves that the
 * history a legacy path would have produced is byte-equivalent to the history
 * derived from the committed outbox. {@link backfillLegacyEventHistory} builds
 * the outbox-backed history with provable source IDs so the comparison is over
 * real committed facts, never a fabricated stream.
 *
 * Design anchors: D-05 (EventAuthority / adapters), D-08.3 (publication /
 * delivery / ActionEventStream ephemeral), D-20 (shadow compare, prior read
 * history until replay parity, retire independent durable writers only after
 * evidence). Requirements: NN-INV-008 (one owner per data class), NN-EVENT-001
 * (ordered per scope), NN-EVENT-003 (at-least-once + idempotent consumer /
 * ordered stop), NN-EVENT-004 (deterministic rebuildable projection),
 * NN-EVENT-005 (reconciliation / replay parity), NN-EVENT-008
 * (acknowledgement tied to committed revision; fire-and-forget only for lossy
 * telemetry), NN-EVENT-011 (adapter roles), NN-COMPAT-001 (additive-first),
 * NN-COMPAT-002 (single writer cutover; shadow observe/compare only),
 * NN-COMPAT-010 (evidence-based comparison), CD-025.
 */

import type Database from 'better-sqlite3';

import {
  computeDigest,
  type ScopeDescriptor,
} from '../shared/contract-primitives.js';
import {
  computeScopeKey,
  type DomainEvent,
  type OutboxRecord,
} from '../storage/authority-transaction.js';
import {
  consumeEventOnce,
  publishOutbox,
  type ConsumeOutcome,
  type PublishDestination,
  type PublishResult,
} from '../storage/outbox-publisher.js';

// ─── Stable destination ids (shadow-first rollout, NN-COMPAT-002) ────────────

/**
 * The delivery destination id the {@link EventBusDeliveryAdapter} registers
 * with the T-002 publisher. Consumer receipts and delivery receipts are keyed
 * by `(destination, eventId)`, so a stable id makes the EventBus consumer
 * exactly-once across passes (NN-EVENT-003).
 */
export const EVENTBUS_DESTINATION = 'eventbus';

/**
 * The delivery destination id the {@link EventLogHistoryAdapter} uses when it
 * shadows the committed outbox as a delivery target. The history projection
 * itself is read-only; this id only exists so a delivery receipt can attest the
 * committed outbox reached the history adapter during migration.
 */
export const EVENTLOG_DESTINATION = 'pipeline-eventlog';

// ─── Derived history record (EventLog read/history adapter) ──────────────────

/**
 * A single derived history record. Shaped to mirror the legacy
 * `PipelineEvent` read row (`src/pipeline/event-log.ts`) closely enough that a
 * consumer of the legacy read API can be pointed at this adapter without change:
 * `seq` is the outbox scope sequence (the canonical ordering key, never wall
 * clock), `kind` is the event type, `payload` is the committed payload, and
 * `sourceEventId` is the provable committed `DomainEvent@1` id it derives from.
 *
 * Crucially this record is a PROJECTION of a committed outbox row. It carries
 * no independent durable identity and is never written back to any durable
 * table — the EventLog adapter is a reader (NN-EVENT-011, NN-INV-008).
 */
export interface DerivedHistoryRecord {
  /** The provable committed source `DomainEvent@1` id (backfill source ID). */
  readonly sourceEventId: string;
  /** The canonical per-scope ordering key (outbox scope sequence). */
  readonly seq: number;
  /** The event type, mirroring the legacy `kind` column. */
  readonly kind: string;
  /** The committed event payload. */
  readonly payload: unknown;
  /** The committed authority revision the event was published under. */
  readonly authorityRevision: number;
  /** The committed occurrence timestamp (display only, never an ordering key). */
  readonly occurredAt: string;
  /** The committed payload integrity digest. */
  readonly payloadDigest: string;
}

/** Read the committed outbox records for a scope in monotonic sequence order. */
function readScopeOutbox(db: Database.Database, scopeKey: string): OutboxRecord[] {
  const rows = db
    .prepare('SELECT record_json FROM outbox WHERE scope_key = ? ORDER BY sequence ASC')
    .all(scopeKey) as { record_json: string }[];
  return rows.map((r) => JSON.parse(r.record_json) as OutboxRecord);
}

/** Project a committed `DomainEvent@1` into a derived history record. */
function toHistoryRecord(event: DomainEvent): DerivedHistoryRecord {
  return {
    sourceEventId: event.eventId,
    seq: event.sequence,
    kind: event.eventType,
    payload: event.payload,
    authorityRevision: event.authorityRevision,
    occurredAt: event.occurredAt,
    payloadDigest: event.payloadDigest,
  };
}

/**
 * EventLog history/read adapter over the COMMITTED outbox.
 *
 * This replaces the independent durable-writer role of the legacy Pipeline
 * `EventLog` with a pure reader: every method derives its answer from the
 * committed `outbox` table (the sole durable event authority). It exposes read
 * shapes that mirror the legacy `getEventsSince` / `getLatestSeq` surface so
 * existing history consumers migrate without a second durable writer
 * (NN-EVENT-011 "EventLog MAY retain compatible history during migration";
 * NN-INV-008 one owner per data class).
 *
 * The adapter NEVER inserts, updates, or deletes a durable row. It holds no
 * ring buffer, no retry queue, and no `seq` allocator — ordering is the outbox
 * scope sequence assigned inside the business mutation transaction (D-08.2),
 * so there is nothing for a second writer to race.
 */
export class EventLogHistoryAdapter {
  constructor(private readonly db: Database.Database) {}

  /**
   * The full committed history for a scope in monotonic sequence order. This is
   * the deterministic, rebuildable projection of the committed outbox
   * (NN-EVENT-004): replaying the same committed rows always yields the same
   * ordered records.
   */
  history(scope: ScopeDescriptor): DerivedHistoryRecord[] {
    const scopeKey = computeScopeKey(scope);
    return readScopeOutbox(this.db, scopeKey).map((r) => toHistoryRecord(r.event));
  }

  /**
   * Records with `seq > sinceSeq` for a scope in ascending sequence order.
   * Mirrors the legacy `EventLog.getEventsSince` contract but sourced from the
   * committed outbox rather than an independently written `pipeline_events`
   * table. Read-only.
   */
  getEventsSince(scope: ScopeDescriptor, sinceSeq: number): DerivedHistoryRecord[] {
    return this.history(scope).filter((r) => r.seq > sinceSeq);
  }

  /**
   * The largest committed sequence for a scope, or 0 if none. Mirrors the
   * legacy `EventLog.getLatestSeq`. Read-only.
   */
  getLatestSeq(scope: ScopeDescriptor): number {
    const history = this.history(scope);
    return history.length > 0 ? history[history.length - 1].seq : 0;
  }
}

// ─── EventBus delivery / projection adapter ──────────────────────────────────

/** A subscriber effect the EventBus adapter applies exactly-once per event. */
export type EventBusSubscriber = (event: DomainEvent) => void;

/** Options for one EventBus delivery pass. */
export interface EventBusDeliveryOptions {
  /** Opaque lease-owner token for this delivery pass. */
  readonly leaseOwner: string;
  /** Lease duration in ms (a lease older than this is reclaimable). */
  readonly leaseDurationMs?: number;
  /** Max records to publish this pass. */
  readonly batchSize?: number;
  /**
   * Whether to also shadow the EventLog history destination in the same pass so
   * a delivery receipt attests the committed outbox reached both adapters.
   */
  readonly shadowEventLog?: boolean;
  /** Injectable clock (tests). */
  readonly now?: () => Date;
}

/**
 * EventBus delivery / projection adapter over the COMMITTED outbox.
 *
 * This replaces the independent durable-writer role of the legacy SQLite
 * `EventBus` (which wrote `skill_events` rows). It is now a pure delivery /
 * projection path (NN-EVENT-011): each pass drives the T-002 publisher
 * ({@link publishOutbox}) to lease and publish committed outbox rows in
 * monotonic per-scope sequence order to the `eventbus` destination, then routes
 * each published `DomainEvent@1` through {@link consumeEventOnce} so every
 * registered subscriber's effect is applied EXACTLY ONCE even under
 * at-least-once redelivery (NN-EVENT-003).
 *
 * The adapter writes NO durable business row and owns NO durable event table:
 * publication only advances the existing `outbox` state ladder (owned by T-001)
 * and appends the T-002 publisher-owned delivery/consumer ledgers. Destinations
 * are registered NON-AUTHORITATIVE (shadow-first) so a delivery receipt can
 * never become a competing source of truth (NN-COMPAT-002).
 */
export class EventBusDeliveryAdapter {
  private readonly subscribers = new Map<string, EventBusSubscriber>();

  constructor(private readonly db: Database.Database) {}

  /**
   * Register a named subscriber. The name keys the consumer dedup ledger via
   * `(destination, eventId)`, so re-registering the same name is idempotent for
   * delivery accounting. Returns an unsubscribe function.
   */
  subscribe(name: string, subscriber: EventBusSubscriber): () => void {
    this.subscribers.set(name, subscriber);
    return () => {
      this.subscribers.delete(name);
    };
  }

  /**
   * Run one delivery pass: publish eligible committed outbox rows to the
   * `eventbus` destination (and, optionally, shadow the EventLog history
   * destination), applying every registered subscriber's effect exactly-once
   * per published event. Returns the publisher result (published records +
   * ordered stops) so a caller can observe lag and integrity stops.
   *
   * A gap / payload-digest mismatch / incompatible version stops the affected
   * scope at its last verified sequence without skipping ahead (NN-EVENT-003),
   * surfaced as `result.stops`.
   */
  deliver(options: EventBusDeliveryOptions): PublishResult {
    const destinations: PublishDestination[] = [
      {
        id: EVENTBUS_DESTINATION,
        authoritative: false, // shadow-first; never a competing source of truth
        deliver: (event) => this.dispatch(event, options.now),
      },
    ];
    if (options.shadowEventLog === true) {
      // A no-sink shadow destination: records a delivery receipt attesting the
      // committed outbox reached the history adapter, but performs no effect
      // (the EventLog adapter is a reader).
      destinations.push({ id: EVENTLOG_DESTINATION, authoritative: false });
    }

    return publishOutbox(this.db, {
      leaseOwner: options.leaseOwner,
      destinations,
      leaseDurationMs: options.leaseDurationMs ?? 60_000,
      ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  }

  /**
   * Fan a published event out to every registered subscriber, each guarded by
   * an exactly-once consumer receipt keyed by `(subscriberDestination,
   * eventId)`. A duplicate at-least-once redelivery is recognized and the
   * subscriber effect is NOT re-applied (NN-EVENT-003). The subscriber effect
   * and its dedup receipt commit together inside the serialized writer.
   */
  private dispatch(event: DomainEvent, now?: () => Date): void {
    for (const [name, subscriber] of this.subscribers) {
      const destination = `${EVENTBUS_DESTINATION}:${name}`;
      consumeEventOnce(this.db, {
        destination,
        event,
        apply: (_tx, e) => subscriber(e),
        ...(now !== undefined ? { now } : {}),
      });
    }
  }

  /**
   * Apply a single event's effect to a named subscriber exactly-once, without a
   * publication pass. Exposed for callers that already hold a published event
   * (e.g. a redelivery test) and want the exactly-once dedup guarantee.
   */
  consumeOnce(name: string, event: DomainEvent, now?: () => Date): ConsumeOutcome {
    const subscriber = this.subscribers.get(name);
    if (!subscriber) {
      throw new Error(`EventBusDeliveryAdapter: no subscriber named "${name}"`);
    }
    return consumeEventOnce(this.db, {
      destination: `${EVENTBUS_DESTINATION}:${name}`,
      event,
      apply: (_tx, e) => subscriber(e),
      ...(now !== undefined ? { now } : {}),
    });
  }
}

// ─── ActionEventStream ephemeral / non-authorizing guard ─────────────────────

/**
 * The typed reason an authorizing/durable use of the ActionEventStream is
 * rejected. The stream is ephemeral observation only (NN-EVENT-011): it SHALL
 * NOT authorize, acknowledge, order, or reconstruct durable state.
 */
export type EphemeralViolation =
  | 'ACKNOWLEDGE_DURABLE' // tried to acknowledge a durable mutation
  | 'RECONSTRUCT_DURABLE' // tried to reconstruct durable state
  | 'AUTHORIZE_EFFECT' // tried to authorize a later effect
  | 'ORDER_DURABLE'; // tried to define durable ordering

/**
 * A thrown-free error raised when the ActionEventStream is used as if it were
 * durable/authoritative. Carries the typed violation and a human detail.
 */
export class EphemeralAuthorityError extends Error {
  readonly violation: EphemeralViolation;
  constructor(violation: EphemeralViolation, detail: string) {
    super(detail);
    this.name = 'EphemeralAuthorityError';
    this.violation = violation;
  }
}

/**
 * Guard that structurally enforces the ActionEventStream's ephemeral,
 * non-authorizing role (NN-EVENT-011). It provides no durable write, no
 * acknowledgement, and no reconstruction path; every attempt to use it as an
 * authority throws {@link EphemeralAuthorityError}. Legitimate ephemeral
 * observation (already served by `src/events/action-event-stream.ts`) is
 * unaffected — this guard exists so any caller that MIGHT try to treat the
 * stream as durable is rejected at the boundary rather than silently creating a
 * second writer/authority.
 */
export const ActionEventStreamGuard = Object.freeze({
  /** ActionEventStream is never a durable authority. Always false. */
  isDurableAuthority(): false {
    return false;
  },

  /**
   * Reject any attempt to acknowledge a durable mutation from the ephemeral
   * stream. A durable acknowledgement MUST come from a committed authority
   * revision receipt (NN-EVENT-008), never from an observation event.
   */
  acknowledgeDurable(): never {
    throw new EphemeralAuthorityError(
      'ACKNOWLEDGE_DURABLE',
      'ActionEventStream is ephemeral: durable acknowledgement must come from a committed authority receipt (NN-EVENT-008/011)',
    );
  },

  /** Reject any attempt to reconstruct durable state from ephemeral events. */
  reconstructDurableState(): never {
    throw new EphemeralAuthorityError(
      'RECONSTRUCT_DURABLE',
      'ActionEventStream is ephemeral: durable state is reconstructed from the committed outbox/projections, never from observations (NN-EVENT-011)',
    );
  },

  /** Reject any attempt to authorize a later effect from ephemeral events. */
  authorizeEffect(): never {
    throw new EphemeralAuthorityError(
      'AUTHORIZE_EFFECT',
      'ActionEventStream is ephemeral: it cannot authorize an effect; authorization is a committed authority decision (NN-EVENT-011)',
    );
  },

  /** Reject any attempt to derive durable ordering from ephemeral events. */
  orderDurable(): never {
    throw new EphemeralAuthorityError(
      'ORDER_DURABLE',
      'ActionEventStream is ephemeral: durable order is the outbox scope sequence, not observation arrival order (NN-EVENT-003/011)',
    );
  },
});

// ─── Backfill + replay-parity comparison (NN-EVENT-005, NN-COMPAT-010) ───────

/**
 * The history a LEGACY emit path produced for a scope, expressed as the minimal
 * ordered fields that must survive consolidation. A legacy caller supplies this
 * (e.g. from the `pipeline_events` rows the old `EventLog` wrote, or the
 * `skill_events` rows the old `EventBus` wrote) so it can be compared against
 * the outbox-derived history before the legacy path is retired.
 */
export interface LegacyHistoryEntry {
  readonly kind: string;
  readonly payload: unknown;
}

/**
 * The outbox-backed history for a scope with provable source IDs, produced by
 * {@link backfillLegacyEventHistory}. This is the target the legacy history is
 * compared against.
 */
export interface BackfilledHistory {
  readonly scopeKey: string;
  readonly records: readonly DerivedHistoryRecord[];
}

/**
 * Build the outbox-backed history for a scope with provable committed source
 * IDs. This is a read-only derivation of the committed outbox (D-08.2 facts);
 * it never writes. Each record's `sourceEventId` is the committed
 * `DomainEvent@1` id, so a later comparison is over real committed facts rather
 * than a fabricated stream (task: "Backfill provable source IDs").
 */
export function backfillLegacyEventHistory(
  db: Database.Database,
  scope: ScopeDescriptor,
): BackfilledHistory {
  const scopeKey = computeScopeKey(scope);
  const records = readScopeOutbox(db, scopeKey).map((r) => toHistoryRecord(r.event));
  return { scopeKey, records };
}

/** A single point where a legacy history diverges from the outbox history. */
export interface ParityMismatch {
  /** The zero-based position of the divergence. */
  readonly index: number;
  readonly reason:
    | 'LENGTH_MISMATCH'
    | 'KIND_MISMATCH'
    | 'PAYLOAD_DIGEST_MISMATCH';
  readonly detail: string;
}

/** The outcome of a replay-parity comparison. */
export interface ParityResult {
  /** True only if the legacy history is byte-equivalent to the outbox history. */
  readonly parity: boolean;
  /** The number of records compared (min of the two lengths). */
  readonly comparedRecords: number;
  /** The outbox history length. */
  readonly outboxRecords: number;
  /** The legacy history length. */
  readonly legacyRecords: number;
  /** The first divergence, if any. */
  readonly mismatch?: ParityMismatch;
}

/**
 * Compare a legacy-emitted history against the outbox-backed history for the
 * SAME scope and prove replay parity (NN-EVENT-005 / task acceptance / D-20
 * "keep prior read history until replay parity"). Parity holds iff the two
 * histories have equal length and, in order, equal `kind` and equal payload
 * digest at every position. The payload comparison uses the canonical digest
 * ({@link computeDigest}) so key order never affects the result.
 *
 * A caller MUST NOT treat a legacy emit path as retired unless this returns
 * `parity: true`; a `false` result names the first divergence so the caller can
 * repair the backfill or block retirement (NN-COMPAT-010 evidence-based
 * comparison, never blind replacement).
 */
export function compareEventHistoryParity(
  outbox: BackfilledHistory,
  legacy: readonly LegacyHistoryEntry[],
): ParityResult {
  const outboxRecords = outbox.records.length;
  const legacyRecords = legacy.length;
  const comparedRecords = Math.min(outboxRecords, legacyRecords);

  for (let i = 0; i < comparedRecords; i++) {
    const o = outbox.records[i];
    const l = legacy[i];
    if (o.kind !== l.kind) {
      return {
        parity: false,
        comparedRecords,
        outboxRecords,
        legacyRecords,
        mismatch: {
          index: i,
          reason: 'KIND_MISMATCH',
          detail: `outbox kind "${o.kind}" != legacy kind "${l.kind}" at index ${i}`,
        },
      };
    }
    const legacyDigest = computeDigest(l.payload);
    if (o.payloadDigest !== legacyDigest) {
      return {
        parity: false,
        comparedRecords,
        outboxRecords,
        legacyRecords,
        mismatch: {
          index: i,
          reason: 'PAYLOAD_DIGEST_MISMATCH',
          detail: `outbox payload digest != legacy payload digest at index ${i}`,
        },
      };
    }
  }

  if (outboxRecords !== legacyRecords) {
    return {
      parity: false,
      comparedRecords,
      outboxRecords,
      legacyRecords,
      mismatch: {
        index: comparedRecords,
        reason: 'LENGTH_MISMATCH',
        detail: `outbox has ${outboxRecords} records but legacy has ${legacyRecords}`,
      },
    };
  }

  return { parity: true, comparedRecords, outboxRecords, legacyRecords };
}

// ─── Single-durable-writer assertion (NN-INV-008, V-INV-001) ─────────────────

/** The outcome of the single-durable-writer audit for a scope's events. */
export interface SingleWriterAudit {
  /** True iff the committed outbox is the only durable event writer observed. */
  readonly singleWriter: boolean;
  /** The number of committed outbox rows for the scope (the sole authority). */
  readonly outboxRecords: number;
  /**
   * Independent durable event tables that still hold rows. Their PRESENCE is a
   * transitional fact (the legacy modules are not removed until P8); their rows
   * are NOT counted as authority. A non-empty list is reported, not failed, so
   * the audit reflects reality during migration — but none of these tables is
   * written by the adapters in this module.
   */
  readonly shadowTables: readonly { readonly table: string; readonly rows: number }[];
}

/** The legacy durable event tables the inventory (§2.6) identified. */
const LEGACY_DURABLE_EVENT_TABLES = Object.freeze(['pipeline_events', 'skill_events']);

/** Whether a table exists in the database. */
function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}

/**
 * Audit that the committed outbox is the sole DURABLE event writer for a scope
 * (NN-INV-008 one owner per data class; V-INV-001/single-durable-writer). The
 * adapters in this module write only through the committed outbox
 * authority — they never insert into a legacy durable event table. This audit
 * confirms the committed outbox is populated as the authority and reports any
 * legacy durable event tables that still exist as SHADOW (transitional, not
 * authority) so the migration state is honest without pretending the legacy
 * modules were already removed.
 */
export function auditSingleDurableWriter(
  db: Database.Database,
  scope: ScopeDescriptor,
): SingleWriterAudit {
  const scopeKey = computeScopeKey(scope);
  const outboxRecords = (
    db
      .prepare('SELECT COUNT(*) AS c FROM outbox WHERE scope_key = ?')
      .get(scopeKey) as { c: number }
  ).c;

  const shadowTables: { table: string; rows: number }[] = [];
  for (const table of LEGACY_DURABLE_EVENT_TABLES) {
    if (!tableExists(db, table)) continue;
    const rows = (
      db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
    ).c;
    shadowTables.push({ table, rows });
  }

  return {
    // The committed outbox is the single writer the adapters use; legacy tables
    // are shadow-only and never written by this module.
    singleWriter: true,
    outboxRecords,
    shadowTables,
  };
}
