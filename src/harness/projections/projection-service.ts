/**
 * ProjectionService — Idempotent full-text projection, checkpoints, and rebuild.
 *
 * Provides:
 * - projectEvents: Idempotent full-text projection from session events. Cancellable via AbortSignal.
 * - checkpoint: Record a projection checkpoint with integrity hash.
 * - getHighestCompatibleCheckpoint: Return the highest verified checkpoint for recovery.
 * - rebuildFromScratch: Full rebuild when no valid checkpoint exists.
 * - snapshot/restoreSnapshot: Bounded projection state snapshots for fast restore.
 *
 * Requirements: 28.1, 28.4–28.6
 */

import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type { ChatNodeV1 } from '../contracts/chat-node.js';
import type { SessionEventV1 } from '../contracts/event.js';
import type { ProjectionEnvelopeV1 } from '../contracts/projection.js';
import type { ResponseCompositionV1 } from '../contracts/response-composition.js';
import {
  CanonicalTimelineReducer,
  decodePageCursor,
  type TimelineDelta,
  type TimelinePageQuery,
  type TimelinePageV1,
  type UnreadMetadata,
} from './canonical-timeline.js';
import { ResponseCompositionProjector } from './response-composition-projector.js';

// ─── Types ──────────────────────────────────────────────────────

export interface ProjectionCheckpoint {
  checkpointId: string;
  sessionId: string;
  branchId: string;
  projectionKind: string;
  sourceSequence: number;
  projectionRevision: number;
  checkpointHash: string;
  value: unknown;
  schemaVersion: number;
  createdAt: string;
}

export interface ProjectionEvent {
  eventId: string;
  sessionId: string;
  branchId: string;
  sequence: number;
  schemaVersion: number;
  eventType: string;
  payload: string;
  integrityHash: string;
  occurredAt: string;
}

export interface ProjectionState {
  sessionId: string;
  branchId: string;
  projectionKind: string;
  sourceSequence: number;
  projectionRevision: number;
  entries: Record<string, unknown>;
}

export interface ProjectionServiceConfig {
  /** Maximum events to process in a single projection batch */
  maxBatchSize: number;
  /** Current schema version for compatibility checks */
  currentSchemaVersion: number;
  /** Projection kind identifier */
  projectionKind: string;
}

// ─── ProjectionService ──────────────────────────────────────────

export class ProjectionService {
  private readonly db: Database.Database;
  private readonly config: ProjectionServiceConfig;

  constructor(db: Database.Database, config: ProjectionServiceConfig) {
    this.db = db;
    this.config = config;
  }

  /**
   * Project events idempotently from a given sequence.
   * Updates the full-text projection index for searchable events.
   * Cancellable via AbortSignal.
   *
   * Requirements: 28.1
   */
  projectEvents(
    sessionId: string,
    branchId: string,
    fromSequence: number,
    signal?: AbortSignal
  ): ProjectionState {
    if (signal?.aborted) {
      throw new ProjectionCancelledError('Projection cancelled before start');
    }

    // Fetch events from the given sequence
    const events = this.db.prepare(
      `SELECT eventId, sessionId, branchId, sequence, schemaVersion, eventType, payload, integrityHash, occurredAt
       FROM harness_events
       WHERE sessionId = ? AND branchId = ? AND sequence >= ?
       ORDER BY sequence ASC
       LIMIT ?`
    ).all(sessionId, branchId, fromSequence, this.config.maxBatchSize) as ProjectionEvent[];

    const state: ProjectionState = {
      sessionId,
      branchId,
      projectionKind: this.config.projectionKind,
      sourceSequence: fromSequence > 0 ? fromSequence - 1 : -1,
      projectionRevision: 0,
      entries: {},
    };

    for (const event of events) {
      if (signal?.aborted) {
        throw new ProjectionCancelledError(`Projection cancelled at sequence ${event.sequence}`);
      }

      // Idempotent: skip events already indexed
      const existing = this.db.prepare(
        `SELECT indexId FROM harness_projection_indexes
         WHERE sessionId = ? AND entityId = ? AND indexKind = 'fulltext'`
      ).get(sessionId, event.eventId) as { indexId: string } | undefined;

      if (!existing) {
        // Build full-text content from event
        const content = this.buildSearchableContent(event);
        const indexId = crypto.randomUUID();

        this.db.prepare(
          `INSERT INTO harness_projection_indexes
           (indexId, sessionId, indexKind, entityId, entityKind, content, metadata, sourceSequence, schemaVersion, createdAt)
           VALUES (?, ?, 'fulltext', ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          indexId,
          sessionId,
          event.eventId,
          event.eventType,
          content,
          JSON.stringify({ branchId, occurredAt: event.occurredAt }),
          event.sequence,
          this.config.currentSchemaVersion,
          new Date().toISOString()
        );
      }

      state.sourceSequence = event.sequence;
      state.projectionRevision++;
      state.entries[event.eventId] = JSON.parse(event.payload);
    }

    return state;
  }

  /**
   * Record a projection checkpoint.
   *
   * Requirements: 28.4
   */
  checkpoint(
    sessionId: string,
    branchId: string,
    sequence: number,
    hash: string,
    value?: unknown
  ): ProjectionCheckpoint {
    const checkpointId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Get current revision count for this session/branch/kind
    const revRow = this.db.prepare(
      `SELECT COALESCE(MAX(projectionRevision), 0) + 1 AS nextRev
       FROM harness_projection_checkpoints
       WHERE sessionId = ? AND branchId = ? AND projectionKind = ?`
    ).get(sessionId, branchId, this.config.projectionKind) as { nextRev: number };

    const projectionRevision = revRow.nextRev;
    const serializedValue = JSON.stringify(value ?? {});

    this.db.prepare(
      `INSERT INTO harness_projection_checkpoints
       (checkpointId, sessionId, branchId, projectionKind, sourceSequence, projectionRevision, checkpointHash, value, schemaVersion, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      checkpointId,
      sessionId,
      branchId,
      this.config.projectionKind,
      sequence,
      projectionRevision,
      hash,
      serializedValue,
      this.config.currentSchemaVersion,
      now
    );

    return {
      checkpointId,
      sessionId,
      branchId,
      projectionKind: this.config.projectionKind,
      sourceSequence: sequence,
      projectionRevision,
      checkpointHash: hash,
      value: value ?? {},
      schemaVersion: this.config.currentSchemaVersion,
      createdAt: now,
    };
  }

  /**
   * Return the highest verified compatible checkpoint for recovery.
   *
   * Requirements: 28.5
   */
  getHighestCompatibleCheckpoint(
    sessionId: string,
    branchId: string
  ): ProjectionCheckpoint | null {
    const row = this.db.prepare(
      `SELECT checkpointId, sessionId, branchId, projectionKind, sourceSequence, projectionRevision, checkpointHash, value, schemaVersion, createdAt
       FROM harness_projection_checkpoints
       WHERE sessionId = ? AND branchId = ? AND projectionKind = ? AND schemaVersion <= ?
       ORDER BY sourceSequence DESC
       LIMIT 1`
    ).get(sessionId, branchId, this.config.projectionKind, this.config.currentSchemaVersion) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      checkpointId: row.checkpointId as string,
      sessionId: row.sessionId as string,
      branchId: row.branchId as string,
      projectionKind: row.projectionKind as string,
      sourceSequence: row.sourceSequence as number,
      projectionRevision: row.projectionRevision as number,
      checkpointHash: row.checkpointHash as string,
      value: JSON.parse(row.value as string),
      schemaVersion: row.schemaVersion as number,
      createdAt: row.createdAt as string,
    };
  }

  /**
   * Full rebuild from scratch when no valid checkpoint exists.
   * Drops all existing indexes for this session/branch and re-projects from sequence 0.
   *
   * Requirements: 28.6
   */
  rebuildFromScratch(
    sessionId: string,
    branchId: string,
    signal?: AbortSignal
  ): ProjectionState {
    if (signal?.aborted) {
      throw new ProjectionCancelledError('Rebuild cancelled before start');
    }

    // Clear existing indexes for this session
    this.db.prepare(
      `DELETE FROM harness_projection_indexes WHERE sessionId = ?`
    ).run(sessionId);

    // Re-project from the beginning
    return this.projectEvents(sessionId, branchId, 0, signal);
  }

  /**
   * Create a bounded snapshot of the current projection state.
   * The snapshot stores the full projection state at a given sequence for fast restore.
   */
  snapshot(
    sessionId: string,
    branchId: string,
    state: ProjectionState
  ): ProjectionCheckpoint {
    const hash = this.computeStateHash(state);
    return this.checkpoint(sessionId, branchId, state.sourceSequence, hash, state.entries);
  }

  /**
   * Restore projection state from the highest compatible checkpoint.
   * Falls back to rebuild if no checkpoint exists.
   */
  restoreOrRebuild(
    sessionId: string,
    branchId: string,
    signal?: AbortSignal
  ): ProjectionState {
    const cp = this.getHighestCompatibleCheckpoint(sessionId, branchId);

    if (cp) {
      // Resume from checkpoint
      return this.projectEvents(sessionId, branchId, cp.sourceSequence + 1, signal);
    }

    // No compatible checkpoint — full rebuild
    return this.rebuildFromScratch(sessionId, branchId, signal);
  }

  // ─── Internal helpers ───────────────────────────────────────────

  private buildSearchableContent(event: ProjectionEvent): string {
    let content = `${event.eventType} `;
    try {
      const payload = JSON.parse(event.payload);
      // Extract text fields from the payload for searchability
      const textFields = this.extractTextFields(payload);
      content += textFields.join(' ');
    } catch {
      content += event.payload;
    }
    return content;
  }

  private extractTextFields(obj: unknown, depth = 0): string[] {
    if (depth > 5) return [];
    const results: string[] = [];

    if (typeof obj === 'string') {
      results.push(obj);
    } else if (typeof obj === 'object' && obj !== null) {
      for (const value of Object.values(obj)) {
        results.push(...this.extractTextFields(value, depth + 1));
      }
    }
    return results;
  }

  private computeStateHash(state: ProjectionState): string {
    const serialized = JSON.stringify({
      sessionId: state.sessionId,
      branchId: state.branchId,
      projectionKind: state.projectionKind,
      sourceSequence: state.sourceSequence,
      entries: state.entries,
    });
    return crypto.createHash('sha256').update(serialized).digest('hex');
  }
}

// ─── Structured Chat Projection Service ────────────────────────

/** Typed reasons returned by bounded canonical projection reads and mutations. */
export type StructuredProjectionUnavailableReason =
  | 'cross_session'
  | 'stale_revision'
  | 'stale_source_revision'
  | 'unsupported_schema_version'
  | 'bound_exceeded'
  | 'invalid_identity'
  | 'duplicate_event_id'
  | 'malformed_cursor'
  | 'stale_cursor'
  | 'cancelled'
  | 'invalid_checkpoint';

export interface StructuredProjectionUnavailableV1 {
  ok: false;
  unavailable: true;
  reasonCode: StructuredProjectionUnavailableReason;
  projectionRevision: number;
  sourceRevision: number;
  schemaVersion: 1;
}

export interface StructuredProjectionQueryContext {
  /** Scope is optional for trusted in-process callers and mandatory at IPC boundaries. */
  sessionId?: string;
  branchId?: string;
  expectedProjectionRevision?: number;
  expectedSourceRevision?: number;
  signal?: AbortSignal;
}

export type StructuredTimelinePageQuery = TimelinePageQuery & StructuredProjectionQueryContext;

export interface StructuredCompositionQuery extends StructuredProjectionQueryContext {
  schemaVersion: 1;
  chatNodeStableKey: string;
}

export interface StructuredReadAcknowledgement extends StructuredProjectionQueryContext {
  schemaVersion: 1;
  stableKey: string;
  expectedProjectionRevision: number;
}

export type StructuredProjectionEnvelopeV1<T> = ProjectionEnvelopeV1<T> & {
  /** Alias used by response-composition and action contracts. */
  sourceRevision: number;
};

export type StructuredProjectionQueryResult<T> =
  | ({ ok: true; envelope: StructuredProjectionEnvelopeV1<T> } & StructuredProjectionEnvelopeV1<T>)
  | StructuredProjectionUnavailableV1;

export type StructuredProjectionMutationResult =
  | {
      ok: true;
      projectionRevision: number;
      sourceRevision: number;
      schemaVersion: 1;
      unread: UnreadMetadata;
    }
  | StructuredProjectionUnavailableV1;

export interface ProjectionRecordRejectionV1 {
  eventId?: string;
  reasonCode: StructuredProjectionUnavailableReason;
}

/** Node and composition changes published for one accepted canonical prefix. */
export interface ProjectionDeltaV1 extends TimelineDelta {
  schemaVersion: 1;
  sourceRevision: number;
  nodesAdded: ChatNodeV1[];
  nodesUpdated: ChatNodeV1[];
  nodesRemoved: string[];
  compositionsAdded: ResponseCompositionV1[];
  compositionsUpdated: ResponseCompositionV1[];
  compositionsRemoved: string[];
  rejected: ProjectionRecordRejectionV1[];
}

export interface StructuredChatProjectionServiceConfig {
  /** Settings_Service-selected maximum page size. */
  pageSize: number;
  schemaVersion: 1;
  /** Optional bound for a single reduction call. */
  maxRecordsPerReduce?: number;
  /** Injectable clock keeps query fixtures deterministic. */
  now?: () => string;
}

export interface StructuredChatCheckpointValueV1 {
  schemaVersion: 1;
  sessionId: string;
  branchId: string;
  sourceRevision: number;
  projectionRevision: number;
  events: SessionEventV1[];
  unread: UnreadMetadata;
}

const STRUCTURED_PROJECTION_KIND = 'structured_chat';
const STABLE_KEY_PATTERN = /^[a-f0-9]{32}$/;

/**
 * Read-only canonical chat projection facade. The service stages and validates
 * a Session_Log prefix before mutating either reducer, so cancellation and
 * incompatible records cannot leave the timeline and composition views split.
 */
export class StructuredChatProjectionService {
  private timeline: CanonicalTimelineReducer;
  private compositions: ResponseCompositionProjector;
  private readonly acceptedEvents = new Map<string, SessionEventV1>();
  private readonly now: () => string;
  private readonly maxRecordsPerReduce: number;
  private projectionRevision = 0;
  private sourceRevision = -1;

  constructor(
    private readonly sessionId: string,
    private readonly branchId: string,
    private readonly config: StructuredChatProjectionServiceConfig,
  ) {
    if (!sessionId || !branchId) throw new Error('Structured projection scope is required');
    if (config.schemaVersion !== 1) throw new Error('Unsupported structured projection schema');
    if (!Number.isSafeInteger(config.pageSize) || config.pageSize <= 0) {
      throw new Error('Structured projection pageSize must be a positive safe integer');
    }
    const maxRecords = config.maxRecordsPerReduce ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0) {
      throw new Error('Structured projection maxRecordsPerReduce must be a positive safe integer');
    }
    this.maxRecordsPerReduce = maxRecords;
    this.now = config.now ?? (() => new Date().toISOString());
    this.timeline = this.createTimeline();
    this.compositions = new ResponseCompositionProjector(sessionId, branchId);
  }

  /** Reduce one ordered source prefix atomically and return its net keyed delta. */
  reduce(records: readonly SessionEventV1[], signal?: AbortSignal): ProjectionDeltaV1 {
    if (signal?.aborted) return this.emptyDelta([{ reasonCode: 'cancelled' }]);
    if (records.length > this.maxRecordsPerReduce) {
      return this.emptyDelta([{ reasonCode: 'bound_exceeded' }]);
    }

    const accepted: SessionEventV1[] = [];
    const rejected: ProjectionRecordRejectionV1[] = [];
    let stagedSourceRevision = this.sourceRevision;

    for (const record of records) {
      if (signal?.aborted) return this.emptyDelta([{ reasonCode: 'cancelled' }]);
      const eventId = typeof record?.eventId === 'string' && record.eventId.length > 0
        ? record.eventId
        : undefined;
      if (record?.schemaVersion !== this.config.schemaVersion) {
        rejected.push({ ...(eventId ? { eventId } : {}), reasonCode: 'unsupported_schema_version' });
        continue;
      }
      if (record.sessionId !== this.sessionId || record.branchId !== this.branchId) {
        rejected.push({ ...(eventId ? { eventId } : {}), reasonCode: 'cross_session' });
        continue;
      }
      if (!eventId || !Number.isSafeInteger(record.sequence) || record.sequence < 0) {
        rejected.push({ ...(eventId ? { eventId } : {}), reasonCode: 'invalid_identity' });
        continue;
      }
      const prior = this.acceptedEvents.get(eventId);
      if (prior !== undefined) {
        if (!this.valuesEqual(prior, record)) {
          rejected.push({ eventId, reasonCode: 'duplicate_event_id' });
        }
        continue;
      }
      if (record.sequence <= stagedSourceRevision) {
        rejected.push({ eventId, reasonCode: 'stale_source_revision' });
        continue;
      }
      accepted.push(record);
      stagedSourceRevision = record.sequence;
    }

    if (signal?.aborted) return this.emptyDelta([{ reasonCode: 'cancelled' }]);
    if (accepted.length === 0) return this.emptyDelta(rejected);

    const previousNodes = this.nodeMap();
    const previousCompositions = this.compositionMap();

    this.timeline.reduce([...accepted]);
    this.compositions.reduce(accepted);
    for (const event of accepted) this.acceptedEvents.set(event.eventId, event);
    this.sourceRevision = stagedSourceRevision;

    const nodeDelta = this.diffMaps(previousNodes, this.nodeMap());
    const compositionDelta = this.diffMaps(previousCompositions, this.compositionMap());
    if (
      nodeDelta.added.length > 0 || nodeDelta.updated.length > 0 || nodeDelta.removed.length > 0
      || compositionDelta.added.length > 0 || compositionDelta.updated.length > 0
      || compositionDelta.removed.length > 0
    ) {
      this.projectionRevision++;
    }

    return {
      schemaVersion: 1,
      added: nodeDelta.added,
      updated: nodeDelta.updated,
      removed: nodeDelta.removed,
      nodesAdded: nodeDelta.added,
      nodesUpdated: nodeDelta.updated,
      nodesRemoved: nodeDelta.removed,
      compositionsAdded: compositionDelta.added,
      compositionsUpdated: compositionDelta.updated,
      compositionsRemoved: compositionDelta.removed,
      projectionRevision: this.projectionRevision,
      sourceSequence: this.sourceRevision,
      sourceRevision: this.sourceRevision,
      rejected,
    };
  }

  /** Bounded, versioned, scope-checked timeline paging. */
  getPage(query: StructuredTimelinePageQuery): StructuredProjectionQueryResult<TimelinePageV1> {
    const invalid = this.validateQuery(query);
    if (invalid) return invalid;
    if (
      query.pageSize !== undefined
      && (!Number.isSafeInteger(query.pageSize) || query.pageSize <= 0 || query.pageSize > this.config.pageSize)
    ) {
      return this.unavailable('bound_exceeded');
    }
    if (query.kind === 'cursor') {
      const cursor = decodePageCursor(query.cursor);
      if (!cursor) return this.unavailable('malformed_cursor');
      if (cursor.sessionId !== this.sessionId || cursor.branchId !== this.branchId) {
        return this.unavailable('cross_session');
      }
    }

    const result = this.timeline.queryPage(query);
    if (!result.ok) {
      const reason = result.reasonCode === 'invalid_page_size'
        ? 'bound_exceeded'
        : result.reasonCode;
      return this.unavailable(reason);
    }
    return this.successEnvelope('canonical_timeline', result.page);
  }

  getComposition(chatNodeStableKey: string): ResponseCompositionV1 | null;
  getComposition(
    query: StructuredCompositionQuery,
  ): StructuredProjectionQueryResult<ResponseCompositionV1>;
  getComposition(
    queryOrStableKey: StructuredCompositionQuery | string,
  ): StructuredProjectionQueryResult<ResponseCompositionV1> | ResponseCompositionV1 | null {
    if (typeof queryOrStableKey === 'string') {
      return this.compositions.getComposition(queryOrStableKey) ?? null;
    }
    const invalid = this.validateQuery(queryOrStableKey);
    if (invalid) return invalid;
    if (!STABLE_KEY_PATTERN.test(queryOrStableKey.chatNodeStableKey)) {
      return this.unavailable('invalid_identity');
    }
    const composition = this.compositions.getComposition(queryOrStableKey.chatNodeStableKey);
    if (!composition) return this.unavailable('invalid_identity');
    return this.successEnvelope('response_composition', composition);
  }

  acknowledgeRead(stableKey: string, expectedRevision: number): StructuredProjectionMutationResult;
  acknowledgeRead(query: StructuredReadAcknowledgement): StructuredProjectionMutationResult;
  acknowledgeRead(
    queryOrStableKey: StructuredReadAcknowledgement | string,
    expectedRevision?: number,
  ): StructuredProjectionMutationResult {
    const query: StructuredReadAcknowledgement = typeof queryOrStableKey === 'string'
      ? {
          schemaVersion: 1,
          stableKey: queryOrStableKey,
          expectedProjectionRevision: expectedRevision ?? -1,
        }
      : queryOrStableKey;
    const invalid = this.validateQuery(query);
    if (invalid) return invalid;
    if (query.expectedProjectionRevision !== this.projectionRevision) {
      return this.unavailable('stale_revision');
    }
    if (!STABLE_KEY_PATTERN.test(query.stableKey) || !this.timeline.hasNode(query.stableKey)) {
      return this.unavailable('invalid_identity');
    }
    this.timeline.markRead(query.stableKey);
    return {
      ok: true,
      projectionRevision: this.projectionRevision,
      sourceRevision: this.sourceRevision,
      schemaVersion: 1,
      unread: this.timeline.getUnreadMetadata(),
    };
  }

  /** Create a hash-verified canonical event-prefix checkpoint. */
  checkpoint(): ProjectionCheckpoint {
    const value = this.checkpointValue();
    const checkpointHash = this.computeCheckpointHash(value);
    return {
      checkpointId: `structured-${checkpointHash.slice(0, 32)}`,
      sessionId: this.sessionId,
      branchId: this.branchId,
      projectionKind: STRUCTURED_PROJECTION_KIND,
      sourceSequence: this.sourceRevision,
      projectionRevision: this.projectionRevision,
      checkpointHash,
      value,
      schemaVersion: 1,
      createdAt: this.now(),
    };
  }

  /** Atomically reconstruct both canonical reducers from a compatible checkpoint. */
  restoreCheckpoint(
    checkpoint: ProjectionCheckpoint,
    signal?: AbortSignal,
  ): StructuredProjectionMutationResult {
    if (signal?.aborted) return this.unavailable('cancelled');
    const value = this.parseCheckpoint(checkpoint);
    if (!value) return this.unavailable('invalid_checkpoint');

    const nextTimeline = this.createTimeline();
    const nextCompositions = new ResponseCompositionProjector(this.sessionId, this.branchId);
    if (signal?.aborted) return this.unavailable('cancelled');
    if (value.events.length > 0) {
      nextTimeline.reduce([...value.events]);
      nextCompositions.reduce(value.events);
    }
    if (!value.unread.bottomFollow) nextTimeline.setBottomFollow(false);
    if (value.unread.lastReadStableKey) {
      if (!nextTimeline.hasNode(value.unread.lastReadStableKey)) {
        return this.unavailable('invalid_checkpoint');
      }
      nextTimeline.markRead(value.unread.lastReadStableKey);
    }
    if (signal?.aborted) return this.unavailable('cancelled');

    this.timeline = nextTimeline;
    this.compositions = nextCompositions;
    this.acceptedEvents.clear();
    for (const event of value.events) this.acceptedEvents.set(event.eventId, event);
    this.sourceRevision = value.sourceRevision;
    this.projectionRevision = value.projectionRevision;

    return {
      ok: true,
      projectionRevision: this.projectionRevision,
      sourceRevision: this.sourceRevision,
      schemaVersion: 1,
      unread: this.timeline.getUnreadMetadata(),
    };
  }

  getProjectionRevision(): number {
    return this.projectionRevision;
  }

  getSourceRevision(): number {
    return this.sourceRevision;
  }

  private createTimeline(): CanonicalTimelineReducer {
    return new CanonicalTimelineReducer(this.sessionId, this.branchId, {
      pageSize: this.config.pageSize,
      schemaVersion: 1,
    });
  }

  private validateQuery(
    query: StructuredProjectionQueryContext & { schemaVersion: number },
  ): StructuredProjectionUnavailableV1 | null {
    if (query.signal?.aborted) return this.unavailable('cancelled');
    if (query.schemaVersion !== this.config.schemaVersion) {
      return this.unavailable('unsupported_schema_version');
    }
    if (
      (query.sessionId !== undefined && query.sessionId !== this.sessionId)
      || (query.branchId !== undefined && query.branchId !== this.branchId)
    ) {
      return this.unavailable('cross_session');
    }
    if (
      query.expectedProjectionRevision !== undefined
      && query.expectedProjectionRevision !== this.projectionRevision
    ) {
      return this.unavailable('stale_revision');
    }
    if (
      query.expectedSourceRevision !== undefined
      && query.expectedSourceRevision !== this.sourceRevision
    ) {
      return this.unavailable('stale_source_revision');
    }
    return null;
  }

  private successEnvelope<T>(
    projectionKind: string,
    value: T,
  ): StructuredProjectionQueryResult<T> {
    const envelope: StructuredProjectionEnvelopeV1<T> = {
      sessionId: this.sessionId,
      branchId: this.branchId,
      projectionKind,
      projectionRevision: this.projectionRevision,
      sourceSequence: this.sourceRevision,
      sourceRevision: this.sourceRevision,
      schemaVersion: 1,
      checkpointHash: this.computeCheckpointHash(this.checkpointValue()),
      generatedAt: this.now(),
      stale: false,
      value,
      confirmedCommandIds: [],
    };
    return { ok: true, envelope, ...envelope };
  }

  private unavailable(
    reasonCode: StructuredProjectionUnavailableReason,
  ): StructuredProjectionUnavailableV1 {
    return {
      ok: false,
      unavailable: true,
      reasonCode,
      projectionRevision: this.projectionRevision,
      sourceRevision: this.sourceRevision,
      schemaVersion: 1,
    };
  }

  private emptyDelta(rejected: ProjectionRecordRejectionV1[]): ProjectionDeltaV1 {
    return {
      schemaVersion: 1,
      added: [],
      updated: [],
      removed: [],
      nodesAdded: [],
      nodesUpdated: [],
      nodesRemoved: [],
      compositionsAdded: [],
      compositionsUpdated: [],
      compositionsRemoved: [],
      projectionRevision: this.projectionRevision,
      sourceSequence: this.sourceRevision,
      sourceRevision: this.sourceRevision,
      rejected,
    };
  }

  private nodeMap(): Map<string, ChatNodeV1> {
    return new Map(this.timeline.getSortedNodes().map((node) => [node.stableKey, node]));
  }

  private compositionMap(): Map<string, ResponseCompositionV1> {
    return new Map(
      this.compositions.getCompositions().map((composition) => [composition.chatNodeStableKey, composition]),
    );
  }

  private diffMaps<T>(
    previous: ReadonlyMap<string, T>,
    next: ReadonlyMap<string, T>,
  ): { added: T[]; updated: T[]; removed: string[] } {
    const added: T[] = [];
    const updated: T[] = [];
    const removed: string[] = [];
    for (const [key, value] of next) {
      const prior = previous.get(key);
      if (prior === undefined) added.push(value);
      else if (!this.valuesEqual(prior, value)) updated.push(value);
    }
    for (const key of previous.keys()) if (!next.has(key)) removed.push(key);
    return { added, updated, removed };
  }

  private checkpointValue(): StructuredChatCheckpointValueV1 {
    return {
      schemaVersion: 1,
      sessionId: this.sessionId,
      branchId: this.branchId,
      sourceRevision: this.sourceRevision,
      projectionRevision: this.projectionRevision,
      events: [...this.acceptedEvents.values()],
      unread: this.timeline.getUnreadMetadata(),
    };
  }

  private computeCheckpointHash(value: StructuredChatCheckpointValueV1): string {
    const canonicalContent = {
      schemaVersion: value.schemaVersion,
      sessionId: value.sessionId,
      branchId: value.branchId,
      sourceRevision: value.sourceRevision,
      events: value.events,
      unread: value.unread,
    };
    return crypto.createHash('sha256').update(JSON.stringify(canonicalContent)).digest('hex');
  }

  private parseCheckpoint(checkpoint: ProjectionCheckpoint): StructuredChatCheckpointValueV1 | null {
    if (
      checkpoint.sessionId !== this.sessionId
      || checkpoint.branchId !== this.branchId
      || checkpoint.projectionKind !== STRUCTURED_PROJECTION_KIND
      || checkpoint.schemaVersion !== this.config.schemaVersion
      || !checkpoint.value || typeof checkpoint.value !== 'object'
    ) {
      return null;
    }
    const value = checkpoint.value as Partial<StructuredChatCheckpointValueV1>;
    if (
      value.schemaVersion !== 1
      || value.sessionId !== this.sessionId
      || value.branchId !== this.branchId
      || !Number.isSafeInteger(value.sourceRevision) || (value.sourceRevision ?? -2) < -1
      || !Number.isSafeInteger(value.projectionRevision) || (value.projectionRevision ?? -1) < 0
      || !Array.isArray(value.events)
      || !value.unread || typeof value.unread !== 'object'
      || checkpoint.sourceSequence !== value.sourceRevision
      || checkpoint.projectionRevision !== value.projectionRevision
    ) {
      return null;
    }
    let priorSequence = -1;
    const ids = new Set<string>();
    for (const event of value.events) {
      if (
        !event || typeof event !== 'object'
        || event.schemaVersion !== 1
        || event.sessionId !== this.sessionId
        || event.branchId !== this.branchId
        || typeof event.eventId !== 'string' || event.eventId.length === 0
        || ids.has(event.eventId)
        || !Number.isSafeInteger(event.sequence) || event.sequence <= priorSequence
      ) {
        return null;
      }
      ids.add(event.eventId);
      priorSequence = event.sequence;
    }
    if (priorSequence !== value.sourceRevision && value.events.length > 0) return null;
    if (value.events.length === 0 && value.sourceRevision !== -1) return null;
    const typedValue = value as StructuredChatCheckpointValueV1;
    if (this.computeCheckpointHash(typedValue) !== checkpoint.checkpointHash) return null;
    return typedValue;
  }

  private valuesEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }
}

// ─── Errors ─────────────────────────────────────────────────────

export class ProjectionCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectionCancelledError';
  }
}
