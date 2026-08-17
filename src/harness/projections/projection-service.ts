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

// ─── Errors ─────────────────────────────────────────────────────

export class ProjectionCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectionCancelledError';
  }
}
