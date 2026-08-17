/**
 * Feedback_Service — Separated feedback storage with explicit injection events.
 *
 * Provides:
 * - Record local feedback separately from model context (Req 29.3)
 * - Query feedback entries by session/owner
 * - Inject feedback into model context via explicit injection events (Req 29.4)
 * - Track injection state and revision
 * - Feedback entries never appear in model context unless explicitly injected
 *
 * Requirements: 29.1, 29.3–29.4
 */

import crypto from 'node:crypto';
import type { SharedDatabase } from '../database/shared-database.js';
import type { SessionLog } from '../session-log/session-log.js';
import type { ActorRef } from '../contracts/actor.js';
import type { ScopeDescriptorV1 } from '../contracts/scope.js';
import type {
  FeedbackEntryV1,
  FeedbackKind,
  RecordFeedbackCommand,
  InjectFeedbackCommand,
} from './schemas.js';

// ─── Error Types ────────────────────────────────────────────────

export class FeedbackNotFoundError extends Error {
  constructor(feedbackId: string) {
    super(`Feedback not found: ${feedbackId}`);
    this.name = 'FeedbackNotFoundError';
  }
}

export class FeedbackAlreadyInjectedError extends Error {
  constructor(feedbackId: string) {
    super(`Feedback already injected into model context: ${feedbackId}`);
    this.name = 'FeedbackAlreadyInjectedError';
  }
}

export class FeedbackOwnerMismatchError extends Error {
  constructor(feedbackId: string, requestedOwner: string) {
    super(`Owner mismatch: feedback=${feedbackId} is not owned by ${requestedOwner}`);
    this.name = 'FeedbackOwnerMismatchError';
  }
}

export class FeedbackSessionMismatchError extends Error {
  constructor(feedbackId: string, requestedSession: string) {
    super(`Session mismatch: feedback=${feedbackId} does not belong to session ${requestedSession}`);
    this.name = 'FeedbackSessionMismatchError';
  }
}

// ─── FeedbackService ────────────────────────────────────────────

export class FeedbackService {
  private readonly db: SharedDatabase;
  private readonly sessionLog: SessionLog;

  constructor(db: SharedDatabase, sessionLog: SessionLog) {
    this.db = db;
    this.sessionLog = sessionLog;
  }

  /**
   * Record local feedback, stored separately from model context.
   *
   * Feedback is never part of model-visible content until explicitly injected
   * through `injectFeedback()`.
   *
   * Requirements: 29.3
   */
  recordFeedback(command: RecordFeedbackCommand): FeedbackEntryV1 {
    const feedbackId = crypto.randomUUID();
    const now = new Date().toISOString();

    const entry: FeedbackEntryV1 = {
      feedbackId,
      sessionId: command.sessionId,
      ownerId: command.ownerId,
      kind: command.kind ?? 'general',
      content: command.content ?? '',
      targetEventId: command.targetEventId ?? null,
      targetSequence: command.targetSequence ?? null,
      injected: false,
      injectionEventId: null,
      revision: 1,
      metadata: command.metadata ?? {},
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
    };

    this.db.raw.prepare(
      `INSERT INTO harness_feedback (feedbackId, sessionId, ownerId, kind, content, targetEventId, targetSequence, injected, injectionEventId, revision, metadata, schemaVersion, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, 1, ?, ?)`
    ).run(
      entry.feedbackId,
      entry.sessionId,
      entry.ownerId,
      entry.kind,
      entry.content,
      entry.targetEventId,
      entry.targetSequence,
      entry.injectionEventId,
      JSON.stringify(entry.metadata),
      entry.createdAt,
      entry.updatedAt
    );

    return entry;
  }

  /**
   * Inject feedback into model context by appending an explicit `feedback.injected`
   * event to the Session_Log.
   *
   * The event identifies the feedback revision so that the model receives exactly
   * the feedback content as it existed at injection time.
   *
   * Requirements: 29.4
   */
  injectFeedback(command: InjectFeedbackCommand, actor: ActorRef, scope: ScopeDescriptorV1): FeedbackEntryV1 {
    const existing = this.getFeedbackById(command.feedbackId);

    if (!existing) {
      throw new FeedbackNotFoundError(command.feedbackId);
    }

    if (existing.sessionId !== command.sessionId) {
      throw new FeedbackSessionMismatchError(command.feedbackId, command.sessionId);
    }

    if (existing.ownerId !== command.ownerId) {
      throw new FeedbackOwnerMismatchError(command.feedbackId, command.ownerId);
    }

    if (existing.injected) {
      throw new FeedbackAlreadyInjectedError(command.feedbackId);
    }

    const now = new Date().toISOString();

    // Append the feedback.injected event to the Session_Log
    const receipt = this.sessionLog.append({
      sessionId: command.sessionId,
      eventType: 'feedback.injected',
      payload: {
        type: 'feedback.injected',
        feedbackId: existing.feedbackId,
        feedbackRevision: existing.revision,
        kind: existing.kind,
        content: existing.content,
        targetEventId: existing.targetEventId,
        targetSequence: existing.targetSequence,
        injectedAt: now,
      },
      actor,
      scope,
      idempotencyKey: `feedback-injected-${command.feedbackId}`,
    });

    // Update the feedback record to reflect injection
    this.db.raw.prepare(
      `UPDATE harness_feedback SET injected = 1, injectionEventId = ?, updatedAt = ? WHERE feedbackId = ?`
    ).run(receipt.eventId, now, command.feedbackId);

    return {
      ...existing,
      injected: true,
      injectionEventId: receipt.eventId,
      updatedAt: now,
    };
  }

  /**
   * Get a single feedback entry by ID.
   */
  getFeedbackById(feedbackId: string): FeedbackEntryV1 | null {
    const row = this.db.raw.prepare(
      `SELECT feedbackId, sessionId, ownerId, kind, content, targetEventId, targetSequence, injected, injectionEventId, revision, metadata, schemaVersion, createdAt, updatedAt
       FROM harness_feedback WHERE feedbackId = ?`
    ).get(feedbackId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToFeedback(row);
  }

  /**
   * Query feedback entries for a session and owner.
   * Optionally filter by injection status or kind.
   */
  queryFeedback(
    sessionId: string,
    ownerId: string,
    options?: { injected?: boolean; kind?: FeedbackKind }
  ): FeedbackEntryV1[] {
    let sql = `SELECT feedbackId, sessionId, ownerId, kind, content, targetEventId, targetSequence, injected, injectionEventId, revision, metadata, schemaVersion, createdAt, updatedAt
               FROM harness_feedback WHERE sessionId = ? AND ownerId = ?`;
    const params: unknown[] = [sessionId, ownerId];

    if (options?.injected !== undefined) {
      sql += ' AND injected = ?';
      params.push(options.injected ? 1 : 0);
    }

    if (options?.kind) {
      sql += ' AND kind = ?';
      params.push(options.kind);
    }

    sql += ' ORDER BY createdAt ASC';

    const rows = this.db.raw.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToFeedback(row));
  }

  /**
   * Query all feedback entries for a session (regardless of owner).
   * Used for projection surfaces.
   */
  querySessionFeedback(sessionId: string): FeedbackEntryV1[] {
    const rows = this.db.raw.prepare(
      `SELECT feedbackId, sessionId, ownerId, kind, content, targetEventId, targetSequence, injected, injectionEventId, revision, metadata, schemaVersion, createdAt, updatedAt
       FROM harness_feedback WHERE sessionId = ? ORDER BY createdAt ASC`
    ).all(sessionId) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToFeedback(row));
  }

  /**
   * Get feedback entries targeted at a specific event.
   */
  getFeedbackForEvent(sessionId: string, targetEventId: string): FeedbackEntryV1[] {
    const rows = this.db.raw.prepare(
      `SELECT feedbackId, sessionId, ownerId, kind, content, targetEventId, targetSequence, injected, injectionEventId, revision, metadata, schemaVersion, createdAt, updatedAt
       FROM harness_feedback WHERE sessionId = ? AND targetEventId = ? ORDER BY createdAt ASC`
    ).all(sessionId, targetEventId) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToFeedback(row));
  }

  // ─── Internal ─────────────────────────────────────────────────

  private rowToFeedback(row: Record<string, unknown>): FeedbackEntryV1 {
    return {
      feedbackId: row.feedbackId as string,
      sessionId: row.sessionId as string,
      ownerId: row.ownerId as string,
      kind: row.kind as FeedbackKind,
      content: row.content as string,
      targetEventId: (row.targetEventId as string) ?? null,
      targetSequence: (row.targetSequence as number) ?? null,
      injected: Boolean(row.injected),
      injectionEventId: (row.injectionEventId as string) ?? null,
      revision: row.revision as number,
      metadata: JSON.parse(row.metadata as string),
      schemaVersion: 1,
      createdAt: row.createdAt as string,
      updatedAt: row.updatedAt as string,
    };
  }
}
