/**
 * RetentionCompaction — protected-class-aware event compaction and per-class
 * retention over the committed outbox (FUT-PKG-03-DURABILITY/T-006).
 *
 * D-08.4 assigns retention its contract: "Retention policies are per class.
 * Deletion uses authority commands/outbox and does not orphan artifact
 * references; secure deletion is best-effort and honestly reported." NN-EVENT-006
 * further constrains event compaction: "Session-event compaction MAY begin
 * after 10,000 events or 30 days, but `chat.*`, `error.*`, `approval.*`, and
 * `checkpoint.*` events SHALL remain uncollapsed; compacted ranges retain
 * source sequence and deterministic replay access." NN-DATA-007 requires that
 * "Pinned, legal-hold, approval, checkpoint, chat, error, and recovery evidence
 * SHALL not be pruned contrary to policy."
 *
 * This module is a READ/PLAN + owned-ledger writer over the committed `outbox`
 * (owned by {@link ./authority-transaction}); it is NOT a second writer for a
 * business table and it NEVER deletes a durable outbox row. Compaction here is
 * a *summary/collapse of the projection-visible session-event view*: it plans
 * which contiguous ranges of NON-protected session events may be collapsed into
 * a single deterministic `CompactionRange@1` summary, and it records that plan
 * in an owned `event_compaction_ranges` ledger. The source outbox rows remain
 * intact so replay of any collapsed range is still deterministic and
 * byte-equivalent (NN-EVENT-006 "retain source sequence and deterministic
 * replay access"). A protected-class event is a HARD boundary: a range that
 * would include one is split so the protected event is never collapsed.
 *
 * The per-class retention planner ({@link planRetention}) partitions a class's
 * events into `retain` / `eligible-for-prune` by an authority-owned
 * count/age/size policy while ALWAYS retaining protected classes and any event
 * explicitly pinned/legal-held. It returns a plan; it performs no deletion (the
 * owning Domain Service issues the authority command/outbox that carries out a
 * bounded deletion, D-08.4). This keeps the durability gate honest: nothing in
 * this module can silently lose a protected business effect.
 *
 * Design anchors: D-07 (`DomainEvent@1`), D-08 (D-08.3 replay/projection,
 * D-08.4 retention), D-18 (integrity), D-19 (lag), D-20 (event authority).
 * Requirements: NN-DATA-007 (per-class retention; protected classes),
 * NN-EVENT-003 (ordering/gap), NN-EVENT-006 (compaction; protected classes;
 * deterministic replay of compacted ranges), NN-VERIFY-005 (data-loss blocker).
 */

import type Database from 'better-sqlite3';

import {
  computeDigest,
  type ScopeDescriptor,
} from '../shared/contract-primitives.js';
import { withSerializedWrite } from './database-authority.js';
import {
  computeScopeKey,
  type DomainEvent,
  type OutboxRecord,
} from './authority-transaction.js';

// ─── Protected event classes (NN-EVENT-006 / NN-DATA-007) ────────────────────

/**
 * The event-type prefixes that MUST remain uncollapsed by compaction and MUST
 * NOT be pruned contrary to policy (NN-EVENT-006 lists `chat.*`, `error.*`,
 * `approval.*`, `checkpoint.*`; NN-DATA-007 adds recovery evidence). A protected
 * event is a hard boundary for compaction and is always retained by retention.
 */
export const PROTECTED_EVENT_PREFIXES: readonly string[] = Object.freeze([
  'chat.',
  'error.',
  'approval.',
  'checkpoint.',
  'recovery.',
]);

/**
 * Whether an event type belongs to a protected class (never collapsed, never
 * pruned contrary to policy). Matching is by prefix so `chat.message`,
 * `error.tool`, `approval.granted`, `checkpoint.created`, and `recovery.*` are
 * all protected.
 */
export function isProtectedEventType(eventType: string): boolean {
  return PROTECTED_EVENT_PREFIXES.some((prefix) => eventType.startsWith(prefix));
}

// ─── Owned compaction ledger (D-08.1-style additive, never a business table) ─

/**
 * DDL for the compaction ledger this module solely owns. Additive and
 * idempotent (`IF NOT EXISTS`). A row records ONE collapsed contiguous range of
 * non-protected session events for a scope, with the deterministic summary
 * digest and the exact `[fromSequence, toSequence]` source span so replay of
 * the collapsed range stays deterministic and reconstructible (NN-EVENT-006).
 * The source outbox rows are NEVER deleted by this module.
 */
const COMPACTION_TABLES_DDL = `
  CREATE TABLE IF NOT EXISTS event_compaction_ranges (
    scope_key TEXT NOT NULL,
    from_sequence INTEGER NOT NULL,
    to_sequence INTEGER NOT NULL,
    event_count INTEGER NOT NULL,
    summary_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (scope_key, from_sequence, to_sequence)
  );
  CREATE INDEX IF NOT EXISTS idx_event_compaction_scope
    ON event_compaction_ranges (scope_key, from_sequence);
`;

/** Create the compaction ledger table/index if absent. Idempotent, additive. */
export function ensureCompactionTables(db: Database.Database): void {
  db.exec(COMPACTION_TABLES_DDL);
}

// ─── Compaction thresholds (NN-EVENT-006) ────────────────────────────────────

/** The compaction eligibility thresholds (NN-EVENT-006). */
export interface CompactionThresholds {
  /** Compaction MAY begin once a scope has at least this many events. */
  readonly minEventCount: number;
  /** Compaction MAY begin once the oldest event is at least this old (ms). */
  readonly minAgeMs: number;
}

/** The legacy default thresholds NN-EVENT-006 names (10,000 events or 30 days). */
export const DEFAULT_COMPACTION_THRESHOLDS: CompactionThresholds = Object.freeze({
  minEventCount: 10_000,
  minAgeMs: 30 * 24 * 60 * 60 * 1000,
});

// ─── Event read (verified, ordered) ──────────────────────────────────────────

interface EventRow {
  readonly sequence: number;
  readonly record_json: string;
}

/** Read a scope's committed outbox events in monotonic sequence order. */
function readScopeEvents(db: Database.Database, scopeKey: string): DomainEvent[] {
  const rows = db
    .prepare(
      `SELECT sequence, record_json FROM outbox WHERE scope_key = ? ORDER BY sequence ASC`,
    )
    .all(scopeKey) as EventRow[];
  return rows.map((r) => (JSON.parse(r.record_json) as OutboxRecord).event);
}

// ─── Compaction planning (protected-aware range collapse) ────────────────────

/**
 * A planned contiguous range of NON-protected session events that may be
 * collapsed into one deterministic summary. `fromSequence`/`toSequence` are the
 * inclusive source span; `summaryDigest` is a stable digest over the collapsed
 * events' `(sequence, eventType, payloadDigest)` tuples so a rebuild of the
 * summary from the retained source rows is byte-equivalent (NN-EVENT-006).
 */
export interface CompactionRange {
  readonly scopeKey: string;
  readonly fromSequence: number;
  readonly toSequence: number;
  readonly eventCount: number;
  readonly summaryDigest: string;
}

/** A planned compaction: the collapsible ranges and the protected boundaries. */
export interface CompactionPlan {
  readonly scopeKey: string;
  /** Whether the scope currently meets the count/age eligibility threshold. */
  readonly eligible: boolean;
  /** Contiguous ranges of non-protected events that may be collapsed. */
  readonly ranges: readonly CompactionRange[];
  /**
   * The sequences of protected events that were kept as hard boundaries and
   * never included in any range (audit/attestation of NN-EVENT-006).
   */
  readonly protectedSequences: readonly number[];
}

/**
 * Compute the deterministic summary digest over a collapsed set of events. Uses
 * the `(sequence, eventType, payloadDigest)` tuple of each event in order so
 * the digest is stable and independent of payload key order. Rebuilding the
 * summary from the retained source rows yields the same digest — the anchor for
 * "deterministic replay access" to a compacted range.
 */
function summarizeRange(events: readonly DomainEvent[]): string {
  return computeDigest(
    events.map((e) => [e.sequence, e.eventType, e.payloadDigest] as const),
  );
}

/**
 * Plan compaction for a scope WITHOUT deleting anything. Non-protected session
 * events are grouped into maximal contiguous runs; every protected-class event
 * is a hard boundary that splits the runs so it is never collapsed. If the
 * scope does not meet the count/age threshold, the plan is `eligible: false`
 * with no ranges. This is a pure read/plan; the caller decides whether to
 * materialize the plan via {@link applyCompactionPlan}.
 */
export function planCompaction(
  db: Database.Database,
  scope: ScopeDescriptor,
  options: {
    readonly thresholds?: CompactionThresholds;
    readonly now?: () => Date;
  } = {},
): CompactionPlan {
  const thresholds = options.thresholds ?? DEFAULT_COMPACTION_THRESHOLDS;
  const now = options.now ?? (() => new Date());
  const scopeKey = computeScopeKey(scope);
  const events = readScopeEvents(db, scopeKey);

  const protectedSequences: number[] = [];
  for (const e of events) {
    if (isProtectedEventType(e.eventType)) protectedSequences.push(e.sequence);
  }

  // Eligibility: count OR age of the oldest event meets its threshold.
  const nowMs = now().getTime();
  const oldestMs = events.length > 0 ? Date.parse(events[0].occurredAt) : nowMs;
  const ageMs = Number.isFinite(oldestMs) ? nowMs - oldestMs : 0;
  const eligible =
    events.length >= thresholds.minEventCount || ageMs >= thresholds.minAgeMs;

  if (!eligible) {
    return { scopeKey, eligible: false, ranges: [], protectedSequences };
  }

  // Group non-protected events into maximal contiguous runs, split at every
  // protected event. A run of length < 2 is not worth collapsing (a single
  // event summarizes to itself), so only runs of >= 2 events become ranges.
  const ranges: CompactionRange[] = [];
  let run: DomainEvent[] = [];
  const flush = (): void => {
    if (run.length >= 2) {
      ranges.push({
        scopeKey,
        fromSequence: run[0].sequence,
        toSequence: run[run.length - 1].sequence,
        eventCount: run.length,
        summaryDigest: summarizeRange(run),
      });
    }
    run = [];
  };
  for (const e of events) {
    if (isProtectedEventType(e.eventType)) {
      // Hard boundary: never collapse a protected event; close the open run.
      flush();
      continue;
    }
    run.push(e);
  }
  flush();

  return { scopeKey, eligible: true, ranges, protectedSequences };
}

/**
 * Materialize a compaction plan by recording each range in the owned
 * `event_compaction_ranges` ledger inside the serialized writer. This does NOT
 * delete any source outbox row — the source sequence and payload remain for
 * deterministic replay (NN-EVENT-006). Idempotent per range (PK conflict is a
 * no-op). Returns the number of ranges recorded (new or already present).
 */
export function applyCompactionPlan(
  db: Database.Database,
  plan: CompactionPlan,
  options: { readonly now?: () => Date } = {},
): number {
  if (plan.ranges.length === 0) return 0;
  const now = options.now ?? (() => new Date());
  const nowIso = now().toISOString();
  return withSerializedWrite(db, (tx): number => {
    const insert = tx.prepare(
      `INSERT INTO event_compaction_ranges
         (scope_key, from_sequence, to_sequence, event_count, summary_digest, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_key, from_sequence, to_sequence) DO NOTHING`,
    );
    for (const range of plan.ranges) {
      insert.run(
        range.scopeKey,
        range.fromSequence,
        range.toSequence,
        range.eventCount,
        range.summaryDigest,
        nowIso,
      );
    }
    return plan.ranges.length;
  });
}

/**
 * Rebuild the deterministic summary digest for a previously recorded
 * compaction range directly from the RETAINED source outbox rows and compare it
 * to the stored digest. A match proves the collapsed range is still
 * deterministically replayable from source (NN-EVENT-006); a mismatch (or a
 * missing source sequence) is a data-loss/integrity signal that MUST block a
 * durable cutover. Read-only.
 */
export interface CompactionReplayCheck {
  readonly scopeKey: string;
  readonly fromSequence: number;
  readonly toSequence: number;
  /** True iff every source sequence in the range is present and the digest matches. */
  readonly replayable: boolean;
  readonly storedDigest: string;
  readonly rebuiltDigest: string;
  /** The sequences declared by the range that are missing from the source. */
  readonly missingSequences: readonly number[];
}

/** Verify every recorded compaction range for a scope is replayable from source. */
export function verifyCompactionReplay(
  db: Database.Database,
  scope: ScopeDescriptor,
): CompactionReplayCheck[] {
  const scopeKey = computeScopeKey(scope);
  const rangeRows = db
    .prepare(
      `SELECT from_sequence, to_sequence, summary_digest
         FROM event_compaction_ranges WHERE scope_key = ? ORDER BY from_sequence`,
    )
    .all(scopeKey) as {
    from_sequence: number;
    to_sequence: number;
    summary_digest: string;
  }[];
  const events = readScopeEvents(db, scopeKey);
  const bySeq = new Map<number, DomainEvent>(events.map((e) => [e.sequence, e]));

  return rangeRows.map((r) => {
    const missing: number[] = [];
    const span: DomainEvent[] = [];
    for (let s = r.from_sequence; s <= r.to_sequence; s++) {
      const e = bySeq.get(s);
      if (!e) {
        missing.push(s);
      } else {
        span.push(e);
      }
    }
    const rebuilt = missing.length === 0 ? summarizeRange(span) : '';
    return {
      scopeKey,
      fromSequence: r.from_sequence,
      toSequence: r.to_sequence,
      replayable: missing.length === 0 && rebuilt === r.summary_digest,
      storedDigest: r.summary_digest,
      rebuiltDigest: rebuilt,
      missingSequences: missing,
    };
  });
}

// ─── Per-class retention planning (NN-DATA-007) ──────────────────────────────

/** An authority-owned per-class retention policy (count/age/size). */
export interface RetentionClassPolicy {
  /** Maximum number of NON-protected events of a class to retain (>=0). */
  readonly maxCount?: number;
  /** Maximum age in ms for a NON-protected event of a class. */
  readonly maxAgeMs?: number;
}

/** The retention decision for one event. */
export interface RetentionDecision {
  readonly sequence: number;
  readonly eventType: string;
  readonly retained: boolean;
  /** Why the event was retained/pruned (audit). */
  readonly reason:
    | 'protected'
    | 'pinned'
    | 'within-policy'
    | 'over-count'
    | 'over-age';
}

/** A retention plan for a scope: per-event decisions, never a deletion. */
export interface RetentionPlan {
  readonly scopeKey: string;
  readonly decisions: readonly RetentionDecision[];
  /** Sequences eligible for a bounded deletion command (never protected). */
  readonly eligibleForPrune: readonly number[];
  /** Sequences that MUST be retained (protected/pinned/within policy). */
  readonly retained: readonly number[];
}

/**
 * Plan per-class retention for a scope WITHOUT deleting anything. Protected
 * classes and any explicitly pinned sequence are ALWAYS retained (NN-DATA-007).
 * For every other event, the class policy's `maxCount` (keep the newest N by
 * sequence) and `maxAgeMs` are applied; anything outside policy is
 * `eligibleForPrune`. The result is a plan the owning Domain Service turns into
 * a bounded authority-command deletion — this module performs no deletion and
 * can never orphan an artifact or lose a protected effect.
 */
export function planRetention(
  db: Database.Database,
  scope: ScopeDescriptor,
  policyByClass: Readonly<Record<string, RetentionClassPolicy>>,
  options: {
    readonly pinnedSequences?: readonly number[];
    readonly now?: () => Date;
  } = {},
): RetentionPlan {
  const now = options.now ?? (() => new Date());
  const nowMs = now().getTime();
  const pinned = new Set(options.pinnedSequences ?? []);
  const scopeKey = computeScopeKey(scope);
  const events = readScopeEvents(db, scopeKey);

  // Determine the class of an event: the segment before the first '.'.
  const classOf = (eventType: string): string => {
    const dot = eventType.indexOf('.');
    return dot >= 0 ? eventType.slice(0, dot + 1) : eventType;
  };

  // Group non-protected, non-pinned events by class, newest sequence first.
  const byClass = new Map<string, DomainEvent[]>();
  const decisions: RetentionDecision[] = [];
  const eligibleForPrune: number[] = [];
  const retained: number[] = [];

  for (const e of events) {
    if (isProtectedEventType(e.eventType)) {
      decisions.push({ sequence: e.sequence, eventType: e.eventType, retained: true, reason: 'protected' });
      retained.push(e.sequence);
      continue;
    }
    if (pinned.has(e.sequence)) {
      decisions.push({ sequence: e.sequence, eventType: e.eventType, retained: true, reason: 'pinned' });
      retained.push(e.sequence);
      continue;
    }
    const cls = classOf(e.eventType);
    const list = byClass.get(cls) ?? [];
    list.push(e);
    byClass.set(cls, list);
  }

  for (const [cls, list] of byClass) {
    const policy = policyByClass[cls] ?? {};
    // Newest first for count-based retention.
    const sortedDesc = [...list].sort((a, b) => b.sequence - a.sequence);
    sortedDesc.forEach((e, index) => {
      const overCount =
        policy.maxCount !== undefined && index >= policy.maxCount;
      const ageMs = nowMs - Date.parse(e.occurredAt);
      const overAge =
        policy.maxAgeMs !== undefined &&
        Number.isFinite(ageMs) &&
        ageMs > policy.maxAgeMs;
      if (overCount) {
        decisions.push({ sequence: e.sequence, eventType: e.eventType, retained: false, reason: 'over-count' });
        eligibleForPrune.push(e.sequence);
      } else if (overAge) {
        decisions.push({ sequence: e.sequence, eventType: e.eventType, retained: false, reason: 'over-age' });
        eligibleForPrune.push(e.sequence);
      } else {
        decisions.push({ sequence: e.sequence, eventType: e.eventType, retained: true, reason: 'within-policy' });
        retained.push(e.sequence);
      }
    });
  }

  decisions.sort((a, b) => a.sequence - b.sequence);
  eligibleForPrune.sort((a, b) => a - b);
  retained.sort((a, b) => a - b);
  return { scopeKey, decisions, eligibleForPrune, retained };
}

/**
 * Assert that a retention plan never proposes pruning a protected-class or
 * pinned event. Returns the offending sequences (empty when the plan is safe).
 * A non-empty result is a HARD durability-gate failure (NN-DATA-007 /
 * NN-VERIFY-005): a protected business effect must never be lost.
 */
export function auditRetentionProtection(
  plan: RetentionPlan,
  pinnedSequences: readonly number[] = [],
): number[] {
  const pinned = new Set(pinnedSequences);
  const violations: number[] = [];
  for (const decision of plan.decisions) {
    if (decision.retained) continue;
    if (isProtectedEventType(decision.eventType) || pinned.has(decision.sequence)) {
      violations.push(decision.sequence);
    }
  }
  return violations.sort((a, b) => a - b);
}
