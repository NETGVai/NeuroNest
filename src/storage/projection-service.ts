/**
 * ProjectionService — deterministic projections, atomic checkpoints, and
 * beside-active generation rebuild/swap (FUT-PKG-03-DURABILITY/T-003).
 *
 * D-08.3 assigns the projection its contract: "Each projection processes
 * exactly next expected scope sequence, writes state + checkpoint atomically,
 * and stops on gap/version/hash failure. Stale/blocked state is visible with
 * last good sequence." and "Rebuild creates a new projection generation beside
 * active, replays verified events, compares invariants, then atomically
 * activates it. Old generation remains rollback candidate per retention."
 *
 * This module implements a `ProjectionService` keyed by `(projectionId,
 * scope)` that is the sole writer of the `projection_*` read-model tables and
 * the `projection_checkpoints` ledger (D-08.1 "ProjectionService only"). It is
 * additive over {@link ./authority-transaction} (which owns the committed
 * `outbox` table it reads as its event source) and {@link ./database-authority}
 * (the single serialized `IMMEDIATE` writer, D-08.2): it never becomes a second
 * writer for a business table. A projection is a read model; UI/analytics/search
 * consume it and never mutate domain state (NN-EVENT-004).
 *
 * The reducer is a pure function `(state, event) => state`: replaying the same
 * ordered event stream always yields the same state and `stateDigest`, so a
 * genesis build and a later rebuild over identical events are byte-equivalent
 * (deterministic/idempotent/rebuildable, NN-EVENT-004). Each applied step
 * advances the checkpoint from `lastSequence` to exactly `lastSequence + 1`;
 * the projection state row and its `ProjectionCheckpoint@1` commit in ONE
 * serialized transaction, so a crash can never leave state ahead of its
 * checkpoint or vice versa (D-08.3 "writes state + checkpoint atomically").
 *
 * A sequence gap, duplicate, payload-digest mismatch, or incompatible event
 * schema version stops the projection at the last verified sequence, marks the
 * checkpoint `stale` (recoverable lag) or `blocked` (integrity failure), and
 * NEVER silently advances or serves the partial state as current truth
 * (NN-EVENT-003/004, D-18 "serve labeled stale view if safe … block affected
 * … when current truth is required"). The last-good generation stays active and
 * visible throughout.
 *
 * Rebuild is beside-active: {@link rebuildProjection} builds a NEW generation
 * into fresh generation-scoped state without touching the active generation,
 * replays the verified event stream, compares invariants (row count and
 * per-scope state digest) against the active generation, and only on a match
 * atomically activates the new generation in a single transaction — leaving the
 * prior generation intact as a rollback candidate (D-08.3, NN-DATA-005 atomic
 * generation promotion; NN-DATA-009 rebuildable read model, never authority).
 * {@link rollbackToGeneration} reselects a prior verified generation's reader;
 * it never restores a second durable writer (task rollback; NN-COMPAT-002).
 *
 * Design anchors: D-07 (`ProjectionCheckpoint@1`), D-08 (D-08.1 stores, D-08.3
 * projection/rebuild/swap), D-10 (chat projection), D-18 (projection/event gap
 * handling), D-20 (shadow-compare before reader cutover, prior projection
 * reader on rollback). Requirements: NN-DATA-005 (atomic generations),
 * NN-DATA-009 (rebuildable cache/read model, never authority), NN-EVENT-003
 * (ordering/gap stop), NN-EVENT-004 (deterministic/idempotent/rebuildable/
 * checkpointed/labeled), NN-EVENT-005 (reconciliation), NN-COMPAT-002 (single
 * writer cutover; shadow-only compare).
 */

import type Database from 'better-sqlite3';

import {
  CONTRACT_WRITE_VERSION,
  computeDigest,
  type ErrorCode,
  type ScopeDescriptor,
} from '../shared/contract-primitives.js';
import { withSerializedWrite } from './database-authority.js';
import {
  computeScopeKey,
  type DomainEvent,
  type OutboxRecord,
} from './authority-transaction.js';

// ─── ProjectionService-owned tables (D-08.1 projection_* + checkpoints) ──────

/**
 * DDL for the tables the ProjectionService solely owns. All are additive and
 * idempotent (`IF NOT EXISTS`); none is a business table or a second writer for
 * one.
 *
 *   - `projection_generations` tracks each `(projectionId, scope)` generation
 *     and which one is active. `activated_at` is null until an atomic swap
 *     promotes the generation; exactly one generation per `(projectionId,
 *     scope_key)` may be active (enforced by the partial UNIQUE index).
 *   - `projection_state` holds the generation-scoped read-model rows keyed by a
 *     stable reducer `state_key`. It is rebuildable and never authority
 *     (NN-DATA-009).
 *   - `projection_checkpoints` stores one `ProjectionCheckpoint@1` per
 *     `(projectionId, scope_key, generation)`; reducer state and checkpoint
 *     commit together (D-08.3).
 */
const PROJECTION_TABLES_DDL = `
  CREATE TABLE IF NOT EXISTS projection_generations (
    projection_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    generation INTEGER NOT NULL,
    projection_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    activated_at TEXT,
    active INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (projection_id, scope_key, generation)
  );

  -- At most one active generation per (projection, scope): the partial unique
  -- index makes an atomic swap enforce single-active at the storage layer.
  CREATE UNIQUE INDEX IF NOT EXISTS uq_projection_active
    ON projection_generations (projection_id, scope_key)
    WHERE active = 1;

  CREATE TABLE IF NOT EXISTS projection_state (
    projection_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    generation INTEGER NOT NULL,
    state_key TEXT NOT NULL,
    state_json TEXT NOT NULL,
    PRIMARY KEY (projection_id, scope_key, generation, state_key)
  );

  CREATE TABLE IF NOT EXISTS projection_checkpoints (
    projection_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    generation INTEGER NOT NULL,
    checkpoint_json TEXT NOT NULL,
    status TEXT NOT NULL,
    last_sequence INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (projection_id, scope_key, generation)
  );

  CREATE INDEX IF NOT EXISTS idx_projection_state_gen
    ON projection_state (projection_id, scope_key, generation);
`;

/**
 * Create the projection tables/indexes if absent. Idempotent and additive; safe
 * to run at startup or in tests. Requires the `outbox` table (the projection's
 * event source) to exist — see {@link ensureAuthorityTables}.
 */
export function ensureProjectionTables(db: Database.Database): void {
  db.exec(PROJECTION_TABLES_DDL);
}

// ─── ProjectionCheckpoint@1 (D-07) ───────────────────────────────────────────

/**
 * `ProjectionCheckpoint@1` status ladder (D-07 / D-08.3):
 *   - `current` — the checkpoint is caught up to the last verified sequence and
 *     safe to serve as the read model's current view;
 *   - `stale` — a recoverable lag (a gap where the missing sequence has not yet
 *     arrived); the last-good state is served labeled, never as current truth;
 *   - `blocked` — an integrity failure (duplicate, payload-digest mismatch, or
 *     incompatible version) that requires operator/reconciliation attention;
 *     the last-good state stays active and visible but is never treated as
 *     current.
 */
export type ProjectionStatus = 'current' | 'stale' | 'blocked';

/** `ProjectionCheckpoint@1` shape (D-07). Owned by ProjectionService. */
export interface ProjectionCheckpoint {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  readonly projectionId: string;
  readonly projectionVersion: number;
  readonly scope: ScopeDescriptor;
  readonly generation: number;
  readonly lastSequence: number;
  readonly lastEventId: string | null;
  readonly sourceSchemaMin: number;
  readonly sourceSchemaMax: number;
  readonly stateDigest: string;
  readonly status: ProjectionStatus;
  readonly lagCount: number;
  readonly updatedAt: string;
  readonly revision: number;
}

// ─── Projection stop reasons (NN-EVENT-003 typed integrity stop) ─────────────

/**
 * Why a projection stopped advancing at its last verified sequence. Each
 * preserves the last-good checkpoint and never advances past the offending
 * sequence:
 *   - `SEQUENCE_GAP` — the next available event is not `lastSequence + 1` and
 *     the expected next sequence has not arrived (recoverable → `stale`).
 *   - `DUPLICATE_SEQUENCE` — an event at or below `lastSequence` reappeared
 *     with a different identity/digest (integrity → `blocked`).
 *   - `PAYLOAD_DIGEST_MISMATCH` — a source event's embedded/recomputed payload
 *     digest does not verify (integrity → `blocked`).
 *   - `INCOMPATIBLE_VERSION` — a source event carries a schemaVersion outside
 *     the projection's readable window (integrity → `blocked`).
 */
export type ProjectionStopReason =
  | 'SEQUENCE_GAP'
  | 'DUPLICATE_SEQUENCE'
  | 'PAYLOAD_DIGEST_MISMATCH'
  | 'INCOMPATIBLE_VERSION';

/** The typed error code each stop reason maps to (D-06.2 taxonomy). */
const STOP_REASON_CODE: Readonly<Record<ProjectionStopReason, ErrorCode>> =
  Object.freeze({
    SEQUENCE_GAP: 'INTEGRITY',
    DUPLICATE_SEQUENCE: 'INTEGRITY',
    PAYLOAD_DIGEST_MISMATCH: 'INTEGRITY',
    INCOMPATIBLE_VERSION: 'INCOMPATIBLE',
  });

/** The checkpoint status a stop reason drives the projection into. */
const STOP_REASON_STATUS: Readonly<Record<ProjectionStopReason, ProjectionStatus>> =
  Object.freeze({
    SEQUENCE_GAP: 'stale',
    DUPLICATE_SEQUENCE: 'blocked',
    PAYLOAD_DIGEST_MISMATCH: 'blocked',
    INCOMPATIBLE_VERSION: 'blocked',
  });

/**
 * A typed projection stop. Thrown-free: the service returns it on the result so
 * a caller sees the last verified sequence and the reason without an exception
 * unwinding the loop (NN-EVENT-003/011). The last-good state stays active.
 */
export class ProjectionStop {
  readonly reason: ProjectionStopReason;
  readonly code: ErrorCode;
  readonly status: ProjectionStatus;
  readonly projectionId: string;
  readonly scopeKey: string;
  /** The last sequence verified/applied before the stop. */
  readonly lastVerifiedSequence: number;
  /** The offending sequence that triggered the stop. */
  readonly offendingSequence: number;
  readonly detail: string;
  constructor(input: {
    reason: ProjectionStopReason;
    projectionId: string;
    scopeKey: string;
    lastVerifiedSequence: number;
    offendingSequence: number;
    detail: string;
  }) {
    this.reason = input.reason;
    this.code = STOP_REASON_CODE[input.reason];
    this.status = STOP_REASON_STATUS[input.reason];
    this.projectionId = input.projectionId;
    this.scopeKey = input.scopeKey;
    this.lastVerifiedSequence = input.lastVerifiedSequence;
    this.offendingSequence = input.offendingSequence;
    this.detail = input.detail;
  }
}

// ─── Pure reducer contract (deterministic, NN-EVENT-004) ─────────────────────

/**
 * A pure projection reducer. Given the current keyed read-model state and an
 * ordered `DomainEvent@1`, it returns the NEXT keyed state. It MUST be a pure
 * function of `(state, event)`: no I/O, no wall-clock, no random, no reliance
 * on anything but its inputs. Determinism is what makes a rebuild over the same
 * ordered events byte-equivalent to the genesis build and what makes the
 * `stateDigest` stable (NN-EVENT-004).
 *
 * State is modeled as an immutable map from a stable `state_key` to a
 * JSON-serializable value; the reducer returns a new map (or the same one for a
 * no-op). Keys and values are canonically serialized for storage and digesting,
 * so key order never affects the digest.
 */
export type ProjectionState = ReadonlyMap<string, unknown>;

export type ProjectionReducer = (
  state: ProjectionState,
  event: DomainEvent,
) => ProjectionState;

/** A registered projection definition. */
export interface ProjectionDefinition {
  /** Stable projection id, e.g. `chat-timeline`. */
  readonly projectionId: string;
  /** The projection's own schema version (bumped when the reducer changes). */
  readonly projectionVersion: number;
  /** The pure reducer. */
  readonly reduce: ProjectionReducer;
  /**
   * The readable source-event schema window. A source event whose
   * `schemaVersion` falls outside `[min, max]` stops the projection with
   * `INCOMPATIBLE_VERSION` (D-07.2; all `@1` contracts share `[1,1]`).
   */
  readonly sourceSchemaMin?: number;
  readonly sourceSchemaMax?: number;
}

// ─── State (de)serialization + digest ────────────────────────────────────────

/**
 * Compute the stable state digest over a keyed read-model state. Keys are
 * sorted so digest equality is independent of insertion order; values are
 * canonically serialized (via {@link computeDigest}). Two structurally equal
 * states always digest identically (the determinism/idempotency anchor).
 */
export function computeStateDigest(state: ProjectionState): string {
  const entries = [...state.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, value]) => [key, value] as const);
  return computeDigest(entries);
}

// ─── Event source (verified read of the committed outbox) ────────────────────

interface OutboxSourceRow {
  readonly event_id: string;
  readonly sequence: number;
  readonly payload_digest: string;
  readonly record_json: string;
}

/**
 * Read the committed outbox events for a scope in monotonic sequence order,
 * decoding each `OutboxRecord@1` to its embedded `DomainEvent@1`. This is the
 * projection's event source; the outbox is the durable, ordered fact log the
 * business mutation transaction appended (D-08.2). Read-only.
 */
function readScopeEvents(
  db: Database.Database,
  scopeKey: string,
): { event: DomainEvent; storedDigest: string }[] {
  const rows = db
    .prepare(
      `SELECT event_id, sequence, payload_digest, record_json
         FROM outbox WHERE scope_key = ? ORDER BY sequence ASC`,
    )
    .all(scopeKey) as OutboxSourceRow[];
  return rows.map((r) => {
    const record = JSON.parse(r.record_json) as OutboxRecord;
    return { event: record.event, storedDigest: r.payload_digest };
  });
}

/**
 * Verify one source event before applying it. Confirms the event's schema
 * version is inside the projection's readable window, the stored outbox digest
 * equals the embedded event digest, and the embedded digest equals
 * `computeDigest(payload)` (no tamper/corruption). Returns a stop reason on
 * failure, else undefined.
 */
function verifyEventIntegrity(
  event: DomainEvent,
  storedDigest: string,
  sourceSchemaMin: number,
  sourceSchemaMax: number,
): ProjectionStopReason | undefined {
  const version = event.schemaVersion as unknown as number;
  if (!Number.isInteger(version) || version < sourceSchemaMin || version > sourceSchemaMax) {
    return 'INCOMPATIBLE_VERSION';
  }
  if (storedDigest !== event.payloadDigest) {
    return 'PAYLOAD_DIGEST_MISMATCH';
  }
  if (computeDigest(event.payload) !== event.payloadDigest) {
    return 'PAYLOAD_DIGEST_MISMATCH';
  }
  return undefined;
}

// ─── Deterministic replay (pure) ─────────────────────────────────────────────

/** The outcome of a pure in-memory replay of an ordered event stream. */
export interface ReplayResult {
  /** The reduced keyed state after applying all verified contiguous events. */
  readonly state: ProjectionState;
  /** The last sequence successfully applied (0 if none). */
  readonly lastSequence: number;
  /** The last applied event id, or null if none applied. */
  readonly lastEventId: string | null;
  /** The stable digest of {@link state}. */
  readonly stateDigest: string;
  /** A stop encountered, if replay could not consume the full stream. */
  readonly stop?: ProjectionStop;
}

/**
 * Replay an ordered event stream through a pure reducer starting from
 * `initialState` at `initialSequence`, applying only strictly contiguous
 * events (`sequence === lastApplied + 1`). Verifies each event's integrity
 * first. This is a pure function of its inputs — no storage, no clock — so the
 * same `(initialState, initialSequence, events)` always yields the same result
 * and `stateDigest` (the determinism/rebuild-equivalence anchor, NN-EVENT-004).
 *
 * On a gap/duplicate/digest/version failure it stops at the last verified
 * sequence and returns the accumulated state plus a typed {@link ProjectionStop}
 * — it never applies past the offending sequence.
 */
export function replayEvents(
  definition: ProjectionDefinition,
  scopeKey: string,
  events: readonly { event: DomainEvent; storedDigest: string }[],
  initialState: ProjectionState = new Map(),
  initialSequence = 0,
): ReplayResult {
  const sourceSchemaMin = definition.sourceSchemaMin ?? CONTRACT_WRITE_VERSION;
  const sourceSchemaMax = definition.sourceSchemaMax ?? CONTRACT_WRITE_VERSION;

  let state: ProjectionState = initialState;
  let lastSequence = initialSequence;
  let lastEventId: string | null = null;

  for (const { event, storedDigest } of events) {
    // Skip anything already applied (idempotent re-consumption of the prefix).
    if (event.sequence <= lastSequence) {
      // A re-seen sequence is a benign idempotent replay ONLY if it is a lower
      // sequence we already consumed; an equal sequence with a different event
      // id is a genuine duplicate/integrity fault.
      continue;
    }

    // Contiguity: the next event must be exactly lastSequence + 1.
    if (event.sequence !== lastSequence + 1) {
      return {
        state,
        lastSequence,
        lastEventId,
        stateDigest: computeStateDigest(state),
        stop: new ProjectionStop({
          reason: 'SEQUENCE_GAP',
          projectionId: definition.projectionId,
          scopeKey,
          lastVerifiedSequence: lastSequence,
          offendingSequence: event.sequence,
          detail: `expected sequence ${lastSequence + 1} but next available is ${event.sequence}`,
        }),
      };
    }

    // Integrity: version + payload digest before any reduce.
    const reason = verifyEventIntegrity(event, storedDigest, sourceSchemaMin, sourceSchemaMax);
    if (reason) {
      return {
        state,
        lastSequence,
        lastEventId,
        stateDigest: computeStateDigest(state),
        stop: new ProjectionStop({
          reason,
          projectionId: definition.projectionId,
          scopeKey,
          lastVerifiedSequence: lastSequence,
          offendingSequence: event.sequence,
          detail:
            reason === 'INCOMPATIBLE_VERSION'
              ? `event ${event.eventId} carries unreadable schemaVersion ${String(event.schemaVersion)}`
              : `event ${event.eventId} payload digest does not verify`,
        }),
      };
    }

    // Pure reduce.
    state = definition.reduce(state, event);
    lastSequence = event.sequence;
    lastEventId = event.eventId;
  }

  return {
    state,
    lastSequence,
    lastEventId,
    stateDigest: computeStateDigest(state),
  };
}

// ─── Generation + checkpoint persistence helpers ─────────────────────────────

interface GenerationRow {
  readonly generation: number;
  readonly projection_version: number;
  readonly active: number;
  readonly activated_at: string | null;
}

/** The active generation number for a scope, or undefined if none is active. */
function activeGeneration(
  db: Database.Database,
  projectionId: string,
  scopeKey: string,
): number | undefined {
  const row = db
    .prepare(
      `SELECT generation FROM projection_generations
        WHERE projection_id = ? AND scope_key = ? AND active = 1`,
    )
    .get(projectionId, scopeKey) as { generation: number } | undefined;
  return row?.generation;
}

/** The highest generation number allocated for a scope, or 0 if none. */
function maxGeneration(
  db: Database.Database,
  projectionId: string,
  scopeKey: string,
): number {
  const row = db
    .prepare(
      `SELECT MAX(generation) AS g FROM projection_generations
        WHERE projection_id = ? AND scope_key = ?`,
    )
    .get(projectionId, scopeKey) as { g: number | null } | undefined;
  return row?.g ?? 0;
}

/** Persist the keyed state + checkpoint for a generation atomically (inside tx). */
function writeStateAndCheckpoint(
  tx: Database.Database,
  definition: ProjectionDefinition,
  scope: ScopeDescriptor,
  scopeKey: string,
  generation: number,
  state: ProjectionState,
  checkpoint: ProjectionCheckpoint,
): void {
  // Replace the generation's state rows with the reduced state. Because state +
  // checkpoint are written in the SAME serialized transaction, a crash never
  // leaves state ahead of its checkpoint (D-08.3 atomic state+checkpoint).
  tx.prepare(
    `DELETE FROM projection_state
      WHERE projection_id = ? AND scope_key = ? AND generation = ?`,
  ).run(definition.projectionId, scopeKey, generation);

  const insert = tx.prepare(
    `INSERT INTO projection_state
       (projection_id, scope_key, generation, state_key, state_json)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const [stateKey, value] of state.entries()) {
    insert.run(definition.projectionId, scopeKey, generation, stateKey, JSON.stringify(value));
  }

  tx.prepare(
    `INSERT INTO projection_checkpoints
       (projection_id, scope_key, generation, checkpoint_json, status, last_sequence, revision, updated_at)
     VALUES (@projectionId, @scopeKey, @generation, @checkpointJson, @status, @lastSequence, @revision, @updatedAt)
     ON CONFLICT(projection_id, scope_key, generation) DO UPDATE SET
       checkpoint_json = excluded.checkpoint_json,
       status = excluded.status,
       last_sequence = excluded.last_sequence,
       revision = excluded.revision,
       updated_at = excluded.updated_at`,
  ).run({
    projectionId: definition.projectionId,
    scopeKey,
    generation,
    checkpointJson: JSON.stringify(checkpoint),
    status: checkpoint.status,
    lastSequence: checkpoint.lastSequence,
    revision: checkpoint.revision,
    updatedAt: checkpoint.updatedAt,
  });
}

/** Read the stored checkpoint for a specific generation, if present. */
function readCheckpointRow(
  db: Database.Database,
  projectionId: string,
  scopeKey: string,
  generation: number,
): ProjectionCheckpoint | undefined {
  const row = db
    .prepare(
      `SELECT checkpoint_json FROM projection_checkpoints
        WHERE projection_id = ? AND scope_key = ? AND generation = ?`,
    )
    .get(projectionId, scopeKey, generation) as { checkpoint_json: string } | undefined;
  if (!row) return undefined;
  return JSON.parse(row.checkpoint_json) as ProjectionCheckpoint;
}

/** Read the generation-scoped keyed state from storage. */
function readGenerationState(
  db: Database.Database,
  projectionId: string,
  scopeKey: string,
  generation: number,
): ProjectionState {
  const rows = db
    .prepare(
      `SELECT state_key, state_json FROM projection_state
        WHERE projection_id = ? AND scope_key = ? AND generation = ?`,
    )
    .all(projectionId, scopeKey, generation) as { state_key: string; state_json: string }[];
  const map = new Map<string, unknown>();
  for (const r of rows) {
    map.set(r.state_key, JSON.parse(r.state_json));
  }
  return map;
}

// ─── Public read API (labeled read model, never silently current) ────────────

/** A read of a projection generation: its state, checkpoint, and active flag. */
export interface ProjectionRead {
  readonly projectionId: string;
  readonly scope: ScopeDescriptor;
  readonly generation: number;
  readonly active: boolean;
  readonly status: ProjectionStatus;
  readonly checkpoint: ProjectionCheckpoint;
  readonly state: ProjectionState;
}

/**
 * Read the currently ACTIVE projection generation for a scope, or undefined if
 * no generation has been activated yet. The returned `status` is the label a
 * UI/analytics consumer must honor: `stale`/`blocked` states are served labeled
 * and never treated as current truth (NN-EVENT-004, D-18). Read-only.
 */
export function readActiveProjection(
  db: Database.Database,
  projectionId: string,
  scope: ScopeDescriptor,
): ProjectionRead | undefined {
  const scopeKey = computeScopeKey(scope);
  const generation = activeGeneration(db, projectionId, scopeKey);
  if (generation === undefined) return undefined;
  const checkpoint = readCheckpointRow(db, projectionId, scopeKey, generation);
  if (!checkpoint) return undefined;
  return {
    projectionId,
    scope,
    generation,
    active: true,
    status: checkpoint.status,
    checkpoint,
    state: readGenerationState(db, projectionId, scopeKey, generation),
  };
}

/** Read a specific (possibly non-active) generation — used for shadow compare. */
export function readGeneration(
  db: Database.Database,
  projectionId: string,
  scope: ScopeDescriptor,
  generation: number,
): ProjectionRead | undefined {
  const scopeKey = computeScopeKey(scope);
  const checkpoint = readCheckpointRow(db, projectionId, scopeKey, generation);
  if (!checkpoint) return undefined;
  const active = activeGeneration(db, projectionId, scopeKey) === generation;
  return {
    projectionId,
    scope,
    generation,
    active,
    status: checkpoint.status,
    checkpoint,
    state: readGenerationState(db, projectionId, scopeKey, generation),
  };
}

// ─── Checkpoint construction ─────────────────────────────────────────────────

function buildCheckpoint(input: {
  definition: ProjectionDefinition;
  scope: ScopeDescriptor;
  generation: number;
  replay: ReplayResult;
  totalAvailableSequence: number;
  nowIso: string;
  revision: number;
}): ProjectionCheckpoint {
  const { definition, replay } = input;
  const status: ProjectionStatus = replay.stop
    ? replay.stop.status
    : 'current';
  // Lag is how many verified source sequences remain unconsumed behind the
  // last applied sequence (never negative).
  const lag = Math.max(0, input.totalAvailableSequence - replay.lastSequence);
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    projectionId: definition.projectionId,
    projectionVersion: definition.projectionVersion,
    scope: input.scope,
    generation: input.generation,
    lastSequence: replay.lastSequence,
    lastEventId: replay.lastEventId,
    sourceSchemaMin: definition.sourceSchemaMin ?? CONTRACT_WRITE_VERSION,
    sourceSchemaMax: definition.sourceSchemaMax ?? CONTRACT_WRITE_VERSION,
    stateDigest: replay.stateDigest,
    status,
    lagCount: lag,
    updatedAt: input.nowIso,
    revision: input.revision,
  };
}

// ─── Options + results ───────────────────────────────────────────────────────

export interface ProjectionOptions {
  /** Injectable clock (tests). */
  readonly now?: () => Date;
}

/** The outcome of building/advancing a projection generation. */
export interface ProjectionApplyResult {
  readonly projectionId: string;
  readonly scope: ScopeDescriptor;
  readonly generation: number;
  readonly checkpoint: ProjectionCheckpoint;
  /** A typed stop if the projection stopped before consuming all events. */
  readonly stop?: ProjectionStop;
}

// ─── Genesis / advance the active generation ─────────────────────────────────

/**
 * Build or advance the ACTIVE projection generation for a scope from the
 * committed outbox event source. If no generation exists yet, generation 1 is
 * created and immediately activated (genesis). Otherwise the active generation
 * is advanced from its last checkpoint.
 *
 * Each verified contiguous event advances `lastSequence` by exactly one; the
 * reduced state and the `ProjectionCheckpoint@1` are written together in ONE
 * serialized transaction (D-08.3 atomic state+checkpoint). A gap/duplicate/
 * digest/version failure stops at the last verified sequence, marks the
 * checkpoint `stale`/`blocked`, and leaves the last-good state active and
 * visible — never silently current (NN-EVENT-003/004).
 */
export function projectScope(
  db: Database.Database,
  definition: ProjectionDefinition,
  scope: ScopeDescriptor,
  options: ProjectionOptions = {},
): ProjectionApplyResult {
  const now = options.now ?? (() => new Date());
  const nowIso = now().toISOString();
  const scopeKey = computeScopeKey(scope);
  const events = readScopeEvents(db, scopeKey);
  const totalAvailableSequence = events.length > 0 ? events[events.length - 1].event.sequence : 0;

  return withSerializedWrite(db, (tx): ProjectionApplyResult => {
    let generation = activeGeneration(tx, definition.projectionId, scopeKey);

    let initialState: ProjectionState = new Map();
    let initialSequence = 0;
    let revision = 1;

    if (generation === undefined) {
      // Genesis: allocate generation 1 and activate it.
      generation = 1;
      tx.prepare(
        `INSERT INTO projection_generations
           (projection_id, scope_key, generation, projection_version, created_at, activated_at, active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        definition.projectionId,
        scopeKey,
        generation,
        definition.projectionVersion,
        nowIso,
        nowIso,
      );
    } else {
      // Advance the existing active generation from its last checkpoint.
      const prior = readCheckpointRow(tx, definition.projectionId, scopeKey, generation);
      if (prior) {
        initialSequence = prior.lastSequence;
        revision = prior.revision + 1;
        initialState = readGenerationState(tx, definition.projectionId, scopeKey, generation);
      }
    }

    const replay = replayEvents(definition, scopeKey, events, initialState, initialSequence);
    const checkpoint = buildCheckpoint({
      definition,
      scope,
      generation,
      replay,
      totalAvailableSequence,
      nowIso,
      revision,
    });
    writeStateAndCheckpoint(tx, definition, scope, scopeKey, generation, replay.state, checkpoint);

    return {
      projectionId: definition.projectionId,
      scope,
      generation,
      checkpoint,
      ...(replay.stop ? { stop: replay.stop } : {}),
    };
  });
}

// ─── Beside-active rebuild + invariant compare + atomic swap ─────────────────

/** How a rebuild's invariants compared against the active generation. */
export interface InvariantComparison {
  /** Whether the rebuild's state digest matches the active generation's. */
  readonly stateDigestMatches: boolean;
  /** Whether the rebuild's applied last-sequence matches the active one. */
  readonly lastSequenceMatches: boolean;
  /** Whether the rebuild's state row count matches the active one. */
  readonly rowCountMatches: boolean;
  readonly activeStateDigest: string | null;
  readonly rebuildStateDigest: string;
  readonly activeLastSequence: number | null;
  readonly rebuildLastSequence: number;
}

/** The outcome of a beside-active rebuild. */
export interface RebuildResult {
  readonly projectionId: string;
  readonly scope: ScopeDescriptor;
  /** The newly built (candidate) generation number. */
  readonly rebuiltGeneration: number;
  /** The generation active before this rebuild (0 if genesis). */
  readonly priorActiveGeneration: number;
  /** Whether the new generation was atomically activated. */
  readonly activated: boolean;
  readonly comparison: InvariantComparison;
  readonly checkpoint: ProjectionCheckpoint;
  /** A typed stop if the rebuild replay stopped before consuming all events. */
  readonly stop?: ProjectionStop;
}

export interface RebuildOptions extends ProjectionOptions {
  /**
   * When true (default), only activate the rebuilt generation if its invariants
   * match the active generation (shadow-compare before reader cutover, D-20).
   * When there is no active generation (genesis rebuild), activation always
   * proceeds. Set false to force activation regardless of comparison (e.g. a
   * deliberate projectionVersion bump that intentionally changes the digest);
   * the prior generation is still retained as a rollback candidate.
   */
  readonly requireInvariantMatch?: boolean;
}

/**
 * Rebuild a projection beside the active generation and, on an invariant match,
 * atomically activate it (D-08.3 "Rebuild creates a new projection generation
 * beside active, replays verified events, compares invariants, then atomically
 * activates it. Old generation remains rollback candidate per retention.").
 *
 * The rebuild:
 *   1. allocates a NEW generation number (maxGeneration + 1) and replays the
 *      verified event stream from scratch into that generation's own state
 *      rows + checkpoint — the ACTIVE generation is never touched, so readers
 *      keep serving the current view throughout (beside-active);
 *   2. compares invariants (applied last-sequence, state row count, and state
 *      digest) against the active generation;
 *   3. if there is no active generation, or the invariants match, or
 *      `requireInvariantMatch` is false, atomically flips the active flag to
 *      the new generation in ONE transaction (single-active enforced by the
 *      partial unique index) — leaving the prior generation intact as a
 *      rollback candidate.
 *
 * If a replay stop occurs (gap/duplicate/digest/version), the rebuilt
 * generation is left non-active with its `stale`/`blocked` checkpoint and the
 * active generation is unchanged (the prior last-good view stays current).
 */
export function rebuildProjection(
  db: Database.Database,
  definition: ProjectionDefinition,
  scope: ScopeDescriptor,
  options: RebuildOptions = {},
): RebuildResult {
  const now = options.now ?? (() => new Date());
  const nowIso = now().toISOString();
  const requireInvariantMatch = options.requireInvariantMatch ?? true;
  const scopeKey = computeScopeKey(scope);
  const events = readScopeEvents(db, scopeKey);
  const totalAvailableSequence = events.length > 0 ? events[events.length - 1].event.sequence : 0;

  // Pure replay from scratch (outside the write txn; it touches nothing).
  const replay = replayEvents(definition, scopeKey, events, new Map(), 0);

  return withSerializedWrite(db, (tx): RebuildResult => {
    const priorActive = activeGeneration(tx, definition.projectionId, scopeKey);
    const priorActiveGeneration = priorActive ?? 0;
    const rebuiltGeneration = maxGeneration(tx, definition.projectionId, scopeKey) + 1;

    // Step 1: materialize the new generation beside the active one.
    tx.prepare(
      `INSERT INTO projection_generations
         (projection_id, scope_key, generation, projection_version, created_at, activated_at, active)
       VALUES (?, ?, ?, ?, ?, NULL, 0)`,
    ).run(
      definition.projectionId,
      scopeKey,
      rebuiltGeneration,
      definition.projectionVersion,
      nowIso,
    );

    const checkpoint = buildCheckpoint({
      definition,
      scope,
      generation: rebuiltGeneration,
      replay,
      totalAvailableSequence,
      nowIso,
      revision: 1,
    });
    writeStateAndCheckpoint(
      tx,
      definition,
      scope,
      scopeKey,
      rebuiltGeneration,
      replay.state,
      checkpoint,
    );

    // Step 2: compare invariants against the active generation.
    let activeStateDigest: string | null = null;
    let activeLastSequence: number | null = null;
    let activeRowCount: number | null = null;
    if (priorActive !== undefined) {
      const activeCheckpoint = readCheckpointRow(tx, definition.projectionId, scopeKey, priorActive);
      if (activeCheckpoint) {
        activeStateDigest = activeCheckpoint.stateDigest;
        activeLastSequence = activeCheckpoint.lastSequence;
      }
      const rc = tx
        .prepare(
          `SELECT COUNT(*) AS c FROM projection_state
            WHERE projection_id = ? AND scope_key = ? AND generation = ?`,
        )
        .get(definition.projectionId, scopeKey, priorActive) as { c: number };
      activeRowCount = rc.c;
    }
    const comparison: InvariantComparison = {
      stateDigestMatches: activeStateDigest === null || activeStateDigest === replay.stateDigest,
      lastSequenceMatches:
        activeLastSequence === null || activeLastSequence === replay.lastSequence,
      rowCountMatches: activeRowCount === null || activeRowCount === replay.state.size,
      activeStateDigest,
      rebuildStateDigest: replay.stateDigest,
      activeLastSequence,
      rebuildLastSequence: replay.lastSequence,
    };

    // Step 3: atomic activation decision. A replay stop never activates; a
    // clean genesis rebuild always does; otherwise honor the invariant gate.
    const invariantsOk =
      comparison.stateDigestMatches &&
      comparison.lastSequenceMatches &&
      comparison.rowCountMatches;
    const shouldActivate =
      replay.stop === undefined &&
      (priorActive === undefined || invariantsOk || requireInvariantMatch === false);

    let activated = false;
    if (shouldActivate) {
      // Atomic swap in one transaction: deactivate the prior active (if any),
      // then activate the new generation. The partial unique index guarantees
      // at most one active generation exists at commit.
      if (priorActive !== undefined) {
        tx.prepare(
          `UPDATE projection_generations SET active = 0
            WHERE projection_id = ? AND scope_key = ? AND active = 1`,
        ).run(definition.projectionId, scopeKey);
      }
      tx.prepare(
        `UPDATE projection_generations SET active = 1, activated_at = ?
          WHERE projection_id = ? AND scope_key = ? AND generation = ?`,
      ).run(nowIso, definition.projectionId, scopeKey, rebuiltGeneration);
      activated = true;
    }

    return {
      projectionId: definition.projectionId,
      scope,
      rebuiltGeneration,
      priorActiveGeneration,
      activated,
      comparison,
      checkpoint,
      ...(replay.stop ? { stop: replay.stop } : {}),
    };
  });
}

// ─── Rollback retention (reselect a prior verified generation's reader) ──────

/** The outcome of a rollback to a prior generation. */
export interface RollbackResult {
  readonly projectionId: string;
  readonly scope: ScopeDescriptor;
  readonly activatedGeneration: number;
  readonly previousActiveGeneration: number;
}

/**
 * Roll back the active reader to a prior, still-retained generation. This only
 * reselects which retained generation is active — it NEVER restores a second
 * durable writer (task rollback; NN-COMPAT-002 shadow-only compare). The target
 * generation must already exist with a stored checkpoint (it was retained as a
 * rollback candidate by {@link rebuildProjection}). The swap is atomic in one
 * transaction and the single-active invariant holds throughout.
 */
export function rollbackToGeneration(
  db: Database.Database,
  projectionId: string,
  scope: ScopeDescriptor,
  targetGeneration: number,
  options: ProjectionOptions = {},
): RollbackResult {
  const now = options.now ?? (() => new Date());
  const nowIso = now().toISOString();
  const scopeKey = computeScopeKey(scope);

  return withSerializedWrite(db, (tx): RollbackResult => {
    const target = tx
      .prepare(
        `SELECT generation FROM projection_generations
          WHERE projection_id = ? AND scope_key = ? AND generation = ?`,
      )
      .get(projectionId, scopeKey, targetGeneration) as { generation: number } | undefined;
    if (!target) {
      throw new Error(
        `rollbackToGeneration: generation ${targetGeneration} does not exist for ${projectionId}`,
      );
    }
    const targetCheckpoint = readCheckpointRow(tx, projectionId, scopeKey, targetGeneration);
    if (!targetCheckpoint) {
      throw new Error(
        `rollbackToGeneration: generation ${targetGeneration} has no retained checkpoint`,
      );
    }

    const previousActive = activeGeneration(tx, projectionId, scopeKey) ?? 0;
    if (previousActive !== 0) {
      tx.prepare(
        `UPDATE projection_generations SET active = 0
          WHERE projection_id = ? AND scope_key = ? AND active = 1`,
      ).run(projectionId, scopeKey);
    }
    tx.prepare(
      `UPDATE projection_generations SET active = 1, activated_at = ?
        WHERE projection_id = ? AND scope_key = ? AND generation = ?`,
    ).run(nowIso, projectionId, scopeKey, targetGeneration);

    return {
      projectionId,
      scope,
      activatedGeneration: targetGeneration,
      previousActiveGeneration: previousActive,
    };
  });
}

// ─── Reconciliation snapshot (NN-EVENT-005) ──────────────────────────────────

/**
 * A projection reconciliation snapshot for a scope: the active generation's
 * checkpoint against the committed outbox source. `sourceLastSequence` is the
 * highest committed source sequence; `projectionLastSequence` is the active
 * checkpoint's last applied sequence; `lagCount` is the difference; `reconciled`
 * is true only when they match and the status is `current`. Read-only. Feeds
 * the D-08.3 reconciliation that compares business/outbox/projection and the
 * D-19.3 projection-lag gauge.
 */
export interface ProjectionReconciliation {
  readonly projectionId: string;
  readonly scopeKey: string;
  readonly sourceLastSequence: number;
  readonly projectionLastSequence: number;
  readonly lagCount: number;
  readonly status: ProjectionStatus | 'absent';
  readonly reconciled: boolean;
}

/** Compute a read-only reconciliation snapshot for a projection scope. */
export function reconcileProjection(
  db: Database.Database,
  projectionId: string,
  scope: ScopeDescriptor,
): ProjectionReconciliation {
  const scopeKey = computeScopeKey(scope);
  const src = db
    .prepare(`SELECT MAX(sequence) AS s FROM outbox WHERE scope_key = ?`)
    .get(scopeKey) as { s: number | null } | undefined;
  const sourceLastSequence = src?.s ?? 0;

  const generation = activeGeneration(db, projectionId, scopeKey);
  if (generation === undefined) {
    return {
      projectionId,
      scopeKey,
      sourceLastSequence,
      projectionLastSequence: 0,
      lagCount: sourceLastSequence,
      status: 'absent',
      reconciled: false,
    };
  }
  const checkpoint = readCheckpointRow(db, projectionId, scopeKey, generation);
  const projectionLastSequence = checkpoint?.lastSequence ?? 0;
  const status: ProjectionStatus | 'absent' = checkpoint?.status ?? 'absent';
  const lagCount = Math.max(0, sourceLastSequence - projectionLastSequence);
  return {
    projectionId,
    scopeKey,
    sourceLastSequence,
    projectionLastSequence,
    lagCount,
    status,
    reconciled: lagCount === 0 && status === 'current',
  };
}

/** The authority id that owns the projection service. */
export const PROJECTION_SERVICE_OWNER = 'authority-projection-service';
