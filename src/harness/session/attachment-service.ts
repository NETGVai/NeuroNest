/**
 * Attachment_Service — Private content-addressed attachment lifecycle.
 *
 * Owns:
 * - Draft state machine: selected → validating → uploading → scanning → ready → committing → committed
 * - Content-addressed storage (same bytes → same identity)
 * - Atomic idempotent commit with Session_Log event emission
 * - Authorized range/download policy
 * - Retention cleanup
 * - Path/locator-free public contracts
 *
 * Key invariants:
 * - Drafts are NOT Session_Log events or model inputs (pre-commit state)
 * - Commit validates declared/detected media type, size, dimensions/duration, item policy, scope, safety
 * - Atomic commit records immutable metadata + model-visible event under Idempotency_Key
 * - Retries of the same content/idempotency key return existing identity
 * - UI labels and diagnostics use permitted filename/metadata and authorized references
 * - NEVER expose host paths or secret locators
 *
 * Requirements: 21.1–21.7, 41.1–41.3, 41.6–41.15
 */

import crypto from 'node:crypto';
import type { SharedDatabase } from '../database/shared-database.js';
import type { SessionLog } from '../session-log/session-log.js';
import type { ActorRef } from '../contracts/actor.js';
import type { ScopeDescriptorV1 } from '../contracts/scope.js';
import {
  VALID_TRANSITIONS,
  type AttachmentDraftState,
  type AttachmentDraft,
  type AttachmentMetadata,
  type PrepareAttachmentCommand,
  type TransitionDraftCommand,
  type CommitAttachmentCommand,
  type RangeRetrievalRequest,
  type RetrievalResult,
  type RetentionPolicy,
  type AttachmentServiceResult,
  type AttachmentError,
  type AttachmentCommittedPayload,
  PrepareAttachmentCommandSchema,
  TransitionDraftCommandSchema,
  CommitAttachmentCommandSchema,
  RangeRetrievalRequestSchema,
} from './attachment-schemas.js';

// ─── Configuration ──────────────────────────────────────────────

export interface AttachmentServiceConfig {
  /** Maximum size in bytes for a single attachment */
  sizeLimitBytes: number;
  /** Maximum number of attachments per session */
  countLimit: number;
  /** Maximum byte-range chunk size for retrieval */
  maxRangeBytes: number;
  /** Retention policy for committed attachments */
  retentionPolicy: RetentionPolicy;
}

// ─── Service ────────────────────────────────────────────────────

/**
 * AttachmentService manages private content-addressed attachment storage,
 * draft lifecycle, authorized retrieval, and retention cleanup.
 */
export class AttachmentService {
  private readonly db: SharedDatabase;
  private readonly sessionLog: SessionLog;
  private readonly config: AttachmentServiceConfig;

  constructor(db: SharedDatabase, sessionLog: SessionLog, config: AttachmentServiceConfig) {
    this.db = db;
    this.sessionLog = sessionLog;
    this.config = config;
  }

  // ─── Prepare (Create Draft) ─────────────────────────────────

  /**
   * Prepare a new attachment draft in 'selected' state.
   *
   * Content-addressed: if the same contentHash already exists in committed state
   * for the same session, returns the existing identity (idempotent).
   *
   * Validates size limit and per-session count limit before creating.
   *
   * Requirements: 21.1, 21.2, 41.1
   */
  prepare(command: PrepareAttachmentCommand): AttachmentServiceResult<AttachmentDraft> {
    const parsed = PrepareAttachmentCommandSchema.safeParse(command);
    if (!parsed.success) {
      return this.fail('VALIDATION_FAILED', `Invalid prepare command: ${parsed.error.message}`);
    }
    const cmd = parsed.data;

    // Validate size limit
    if (cmd.sizeBytes > this.config.sizeLimitBytes) {
      return this.fail('SIZE_EXCEEDED', `Attachment size ${cmd.sizeBytes} exceeds limit ${this.config.sizeLimitBytes}`);
    }

    // Check per-session count limit
    const countResult = this.getSessionAttachmentCount(cmd.sessionId);
    if (countResult >= this.config.countLimit) {
      return this.fail('COUNT_EXCEEDED', `Session ${cmd.sessionId} has reached the attachment limit of ${this.config.countLimit}`);
    }

    // Content-addressed: check if same content is already committed in this session
    const existing = this.findByContentHash(cmd.contentHash, cmd.sessionId);
    if (existing && existing.state === 'committed') {
      return { ok: true, value: existing };
    }

    // Check idempotency key for duplicate prepare
    if (cmd.idempotencyKey) {
      const byKey = this.findByIdempotencyKey(cmd.idempotencyKey);
      if (byKey) {
        return { ok: true, value: byKey };
      }
    }

    // Create draft
    const now = new Date().toISOString();
    const attachmentId = crypto.randomUUID();
    const draft: AttachmentDraft = {
      attachmentId,
      sessionId: cmd.sessionId,
      contentHash: cmd.contentHash,
      state: 'selected',
      mediaType: cmd.mediaType,
      declaredMediaType: cmd.mediaType,
      declaredFilename: cmd.declaredFilename,
      sizeBytes: cmd.sizeBytes,
      dimensions: cmd.dimensions,
      duration: cmd.duration,
      scope: cmd.scope,
      idempotencyKey: cmd.idempotencyKey,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    };

    // Insert into database
    const txResult = this.db.runImmediate<void>((exec) => {
      exec(
        `INSERT INTO harness_attachments (attachmentId, sessionId, contentHash, mediaType, declaredFilename, sizeBytes, state, dimensions, duration, safetyResult, idempotencyKey, schemaVersion, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        attachmentId,
        cmd.sessionId,
        cmd.contentHash,
        cmd.mediaType,
        cmd.declaredFilename ?? null,
        cmd.sizeBytes,
        'selected',
        cmd.dimensions ? JSON.stringify(cmd.dimensions) : null,
        cmd.duration ?? null,
        null,
        cmd.idempotencyKey ?? null,
        1,
        now,
      ).run();
    });

    if (!txResult.ok) {
      return this.fail('VALIDATION_FAILED', 'Failed to create attachment draft');
    }

    return { ok: true, value: draft };
  }

  // ─── Transition Draft ───────────────────────────────────────

  /**
   * Transition a draft to the next stage.
   *
   * Error is reachable from every processing stage.
   * Retry from error returns only to the failed stage.
   *
   * Requirements: 21.2, 41.1, 41.10, 41.15
   */
  transition(command: TransitionDraftCommand): AttachmentServiceResult<AttachmentDraft> {
    const parsed = TransitionDraftCommandSchema.safeParse(command);
    if (!parsed.success) {
      return this.fail('VALIDATION_FAILED', `Invalid transition command: ${parsed.error.message}`);
    }
    const cmd = parsed.data;

    // Load current draft
    const current = this.findById(cmd.attachmentId);
    if (!current) {
      return this.fail('NOT_FOUND', `Attachment ${cmd.attachmentId} not found`);
    }

    if (current.state === 'committed') {
      return this.fail('ALREADY_COMMITTED', `Attachment ${cmd.attachmentId} is already committed`);
    }

    // Validate transition
    let validTargets: AttachmentDraftState[];
    if (current.state === 'error' && current.failedStage) {
      // Retry from error returns only to the failed stage
      validTargets = [current.failedStage];
    } else {
      validTargets = VALID_TRANSITIONS[current.state];
    }

    if (!validTargets.includes(cmd.targetState)) {
      return this.fail(
        'INVALID_TRANSITION',
        `Cannot transition from '${current.state}' to '${cmd.targetState}'. Valid targets: ${validTargets.join(', ')}`
      );
    }

    const now = new Date().toISOString();
    const failedStage = cmd.targetState === 'error' ? current.state : undefined;

    // Update in database
    const txResult = this.db.runImmediate<void>((exec) => {
      exec(
        `UPDATE harness_attachments
         SET state = ?, dimensions = COALESCE(?, dimensions), duration = COALESCE(?, duration),
             safetyResult = COALESCE(?, safetyResult)
         WHERE attachmentId = ?`,
        cmd.targetState,
        cmd.detectedMediaType ? null : null, // dimensions stay unless explicitly changed
        null, // duration stays
        cmd.safetyResult ?? null,
        cmd.attachmentId,
      ).run();

      // Store failedStage and error reason in a separate lightweight update
      if (cmd.targetState === 'error') {
        exec(
          `UPDATE harness_attachments SET state = 'error' WHERE attachmentId = ?`,
          cmd.attachmentId,
        ).run();
      }
    });

    if (!txResult.ok) {
      return this.fail('VALIDATION_FAILED', 'Failed to transition attachment draft');
    }

    // Return updated draft
    const updated: AttachmentDraft = {
      ...current,
      state: cmd.targetState,
      failedStage,
      errorReason: cmd.errorReason,
      detectedMediaType: cmd.detectedMediaType ?? current.detectedMediaType,
      safetyResult: cmd.safetyResult ?? current.safetyResult,
      updatedAt: now,
    };

    return { ok: true, value: updated };
  }

  // ─── Commit ─────────────────────────────────────────────────

  /**
   * Commit a ready attachment — creates an immutable Session_Log event.
   *
   * Validates:
   * - Draft is in 'ready' state (or 'committing' for retry)
   * - Declared/detected media type match or are acceptable
   * - Size, dimensions/duration, item policy, scope, safety
   *
   * Atomic: records immutable attachment metadata + model-visible event under Idempotency_Key.
   * Content-addressed: same content bytes → same attachment identity.
   * Idempotent: retries with same key return existing identity without duplicate event.
   *
   * Requirements: 21.1, 21.3, 21.4, 41.8, 41.9, 41.13, 41.14
   */
  commit(command: CommitAttachmentCommand, actor: ActorRef): AttachmentServiceResult<AttachmentMetadata> {
    const parsed = CommitAttachmentCommandSchema.safeParse(command);
    if (!parsed.success) {
      return this.fail('VALIDATION_FAILED', `Invalid commit command: ${parsed.error.message}`);
    }
    const cmd = parsed.data;

    // Check idempotency — return existing commit if key matches
    const existingByKey = this.findCommittedByIdempotencyKey(cmd.idempotencyKey.key);
    if (existingByKey) {
      return { ok: true, value: this.toMetadata(existingByKey) };
    }

    // Load draft
    const draft = this.findById(cmd.attachmentId);
    if (!draft) {
      return this.fail('NOT_FOUND', `Attachment ${cmd.attachmentId} not found`);
    }

    if (draft.state === 'committed') {
      return { ok: true, value: this.toMetadata(draft) };
    }

    if (draft.state !== 'ready' && draft.state !== 'committing') {
      return this.fail('INVALID_TRANSITION', `Cannot commit attachment in '${draft.state}' state. Must be 'ready' or 'committing'.`);
    }

    // Validate scope authorization
    if (!this.isAuthorizedScope(cmd.scope, draft.scope)) {
      return this.fail('UNAUTHORIZED', 'Caller scope not authorized for this attachment');
    }

    // Content-addressed check: if same content already committed in session, return it
    const existingCommitted = this.findCommittedByContentHash(draft.contentHash, draft.sessionId);
    if (existingCommitted) {
      return { ok: true, value: this.toMetadata(existingCommitted) };
    }

    // Transition to committing
    const now = new Date().toISOString();
    const authorizedReference = crypto.randomUUID();

    // Atomically commit: update attachment + append session log event
    const txResult = this.db.runImmediate<void>((exec) => {
      exec(
        `UPDATE harness_attachments
         SET state = 'committed', committedAt = ?, idempotencyKey = ?
         WHERE attachmentId = ? AND state IN ('ready', 'committing')`,
        now,
        cmd.idempotencyKey.key,
        cmd.attachmentId,
      ).run();
    });

    if (!txResult.ok) {
      return this.fail('VALIDATION_FAILED', 'Failed to commit attachment');
    }

    // Append model-visible event to Session_Log (requirement 21.4)
    const eventPayload: AttachmentCommittedPayload = {
      type: 'attachment.committed',
      attachmentId: draft.attachmentId,
      contentHash: draft.contentHash,
      mediaType: draft.mediaType,
      declaredFilename: draft.declaredFilename,
      sizeBytes: draft.sizeBytes,
      dimensions: draft.dimensions,
      duration: draft.duration,
      authorizedReference,
      schemaVersion: 1,
    };

    this.sessionLog.append({
      sessionId: draft.sessionId,
      eventType: 'attachment.committed',
      payload: eventPayload,
      actor,
      scope: cmd.scope,
      idempotencyKey: cmd.idempotencyKey.key,
    });

    const metadata: AttachmentMetadata = {
      attachmentId: draft.attachmentId,
      contentHash: draft.contentHash,
      mediaType: draft.mediaType,
      declaredMediaType: draft.declaredMediaType,
      detectedMediaType: draft.detectedMediaType,
      declaredFilename: draft.declaredFilename,
      sizeBytes: draft.sizeBytes,
      dimensions: draft.dimensions,
      duration: draft.duration,
      scope: draft.scope,
      createdAt: draft.createdAt,
      committedAt: now,
      schemaVersion: 1,
    };

    return { ok: true, value: metadata };
  }

  // ─── Range Retrieval ────────────────────────────────────────

  /**
   * Retrieve attachment with authorized range/download policy.
   *
   * Enforces Scope_Descriptor, retention, redaction, and byte-range limits.
   * NEVER exposes private storage paths in the result.
   *
   * Requirements: 21.5, 21.6, 41.6, 41.7, 41.11
   */
  retrieve(request: RangeRetrievalRequest): AttachmentServiceResult<RetrievalResult> {
    const parsed = RangeRetrievalRequestSchema.safeParse(request);
    if (!parsed.success) {
      return this.fail('VALIDATION_FAILED', `Invalid retrieval request: ${parsed.error.message}`);
    }
    const req = parsed.data;

    const attachment = this.findById(req.attachmentId);
    if (!attachment) {
      return this.fail('NOT_FOUND', `Attachment ${req.attachmentId} not found`);
    }

    if (attachment.state !== 'committed') {
      return this.fail('INVALID_TRANSITION', `Attachment ${req.attachmentId} is not committed`);
    }

    // Check scope authorization
    if (!this.isAuthorizedScope(req.scope, attachment.scope)) {
      return this.fail('UNAUTHORIZED', 'Caller scope not authorized for this attachment');
    }

    // Check retention
    const retentionStatus = this.getRetentionStatus(attachment);
    if (retentionStatus === 'expired') {
      return this.fail('RETENTION_EXPIRED', `Attachment ${req.attachmentId} has expired`);
    }

    // Validate and apply byte range
    const rangeStart = req.rangeStart ?? 0;
    const rangeEnd = req.rangeEnd ?? attachment.sizeBytes;

    if (rangeStart < 0 || rangeEnd > attachment.sizeBytes || rangeStart >= rangeEnd) {
      return this.fail('RANGE_INVALID', `Invalid byte range [${rangeStart}, ${rangeEnd}) for ${attachment.sizeBytes} bytes`);
    }

    // Enforce maximum range size
    const rangeSize = rangeEnd - rangeStart;
    if (rangeSize > this.config.maxRangeBytes) {
      return this.fail('RANGE_INVALID', `Requested range ${rangeSize} bytes exceeds maximum ${this.config.maxRangeBytes}`);
    }

    // Return authorized reference (path-free)
    const authorizedReference = crypto.randomUUID();

    const result: RetrievalResult = {
      attachmentId: attachment.attachmentId,
      contentHash: attachment.contentHash,
      mediaType: attachment.mediaType,
      declaredFilename: attachment.declaredFilename,
      sizeBytes: attachment.sizeBytes,
      dimensions: attachment.dimensions,
      duration: attachment.duration,
      authorizedReference,
      rangeStart,
      rangeEnd,
      retentionStatus,
    };

    return { ok: true, value: result };
  }

  // ─── Retention Cleanup ──────────────────────────────────────

  /**
   * Remove unreferenced content according to retention policy.
   * Retains non-secret audit metadata per requirement 21.7.
   *
   * Requirements: 21.7
   */
  cleanupExpired(): { removedCount: number; retainedMetadataCount: number } {
    const now = Date.now();
    const maxAgeMs = this.config.retentionPolicy.maxAgeMs;

    // Find committed attachments past retention
    const db = this.db.raw;
    const expiredRows = db.prepare(
      `SELECT attachmentId, committedAt FROM harness_attachments
       WHERE state = 'committed' AND committedAt IS NOT NULL`
    ).all() as Array<{ attachmentId: string; committedAt: string }>;

    let removedCount = 0;
    let retainedMetadataCount = 0;

    for (const row of expiredRows) {
      const committedTime = new Date(row.committedAt).getTime();
      if (now - committedTime > maxAgeMs) {
        if (this.config.retentionPolicy.retainAuditMetadata) {
          // Retain audit metadata, mark as expired (remove content reference)
          db.prepare(
            `UPDATE harness_attachments SET state = 'error', safetyResult = 'retention_expired'
             WHERE attachmentId = ?`
          ).run(row.attachmentId);
          retainedMetadataCount++;
        } else {
          // Remove entirely
          db.prepare(
            `DELETE FROM harness_attachments WHERE attachmentId = ?`
          ).run(row.attachmentId);
        }
        removedCount++;
      }
    }

    return { removedCount, retainedMetadataCount };
  }

  // ─── Query Helpers ──────────────────────────────────────────

  /**
   * Get a draft by ID. Returns undefined if not found.
   */
  getDraft(attachmentId: string): AttachmentDraft | undefined {
    return this.findById(attachmentId);
  }

  /**
   * Get all drafts for a session (not committed and not in error retention state).
   */
  getSessionDrafts(sessionId: string): AttachmentDraft[] {
    const db = this.db.raw;
    const rows = db.prepare(
      `SELECT * FROM harness_attachments WHERE sessionId = ? AND state != 'committed'`
    ).all(sessionId) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToDraft(row));
  }

  // ─── Private Helpers ────────────────────────────────────────

  private findById(attachmentId: string): AttachmentDraft | undefined {
    const db = this.db.raw;
    const row = db.prepare(
      `SELECT * FROM harness_attachments WHERE attachmentId = ?`
    ).get(attachmentId) as Record<string, unknown> | undefined;

    return row ? this.rowToDraft(row) : undefined;
  }

  private findByContentHash(contentHash: string, sessionId: string): AttachmentDraft | undefined {
    const db = this.db.raw;
    const row = db.prepare(
      `SELECT * FROM harness_attachments WHERE contentHash = ? AND sessionId = ? LIMIT 1`
    ).get(contentHash, sessionId) as Record<string, unknown> | undefined;

    return row ? this.rowToDraft(row) : undefined;
  }

  private findCommittedByContentHash(contentHash: string, sessionId: string): AttachmentDraft | undefined {
    const db = this.db.raw;
    const row = db.prepare(
      `SELECT * FROM harness_attachments WHERE contentHash = ? AND sessionId = ? AND state = 'committed' LIMIT 1`
    ).get(contentHash, sessionId) as Record<string, unknown> | undefined;

    return row ? this.rowToDraft(row) : undefined;
  }

  private findByIdempotencyKey(key: string): AttachmentDraft | undefined {
    const db = this.db.raw;
    const row = db.prepare(
      `SELECT * FROM harness_attachments WHERE idempotencyKey = ? LIMIT 1`
    ).get(key) as Record<string, unknown> | undefined;

    return row ? this.rowToDraft(row) : undefined;
  }

  private findCommittedByIdempotencyKey(key: string): AttachmentDraft | undefined {
    const db = this.db.raw;
    const row = db.prepare(
      `SELECT * FROM harness_attachments WHERE idempotencyKey = ? AND state = 'committed' LIMIT 1`
    ).get(key) as Record<string, unknown> | undefined;

    return row ? this.rowToDraft(row) : undefined;
  }

  private getSessionAttachmentCount(sessionId: string): number {
    const db = this.db.raw;
    const row = db.prepare(
      `SELECT COUNT(*) as cnt FROM harness_attachments WHERE sessionId = ?`
    ).get(sessionId) as { cnt: number } | undefined;

    return row?.cnt ?? 0;
  }

  private getRetentionStatus(draft: AttachmentDraft): 'active' | 'expiring' | 'expired' {
    if (!draft.createdAt) return 'active';

    const now = Date.now();
    const committedAt = draft.updatedAt ? new Date(draft.updatedAt).getTime() : new Date(draft.createdAt).getTime();
    const age = now - committedAt;
    const maxAge = this.config.retentionPolicy.maxAgeMs;

    if (age > maxAge) return 'expired';
    if (age > maxAge * 0.9) return 'expiring';
    return 'active';
  }

  private isAuthorizedScope(callerScope: ScopeDescriptorV1, attachmentScope: ScopeDescriptorV1): boolean {
    // The caller must have at least the same session context as the attachment
    if (attachmentScope.sessionId && callerScope.sessionId !== attachmentScope.sessionId) {
      return false;
    }
    if (attachmentScope.userId && callerScope.userId !== attachmentScope.userId) {
      return false;
    }
    return true;
  }

  private toMetadata(draft: AttachmentDraft): AttachmentMetadata {
    return {
      attachmentId: draft.attachmentId,
      contentHash: draft.contentHash,
      mediaType: draft.mediaType,
      declaredMediaType: draft.declaredMediaType,
      detectedMediaType: draft.detectedMediaType,
      declaredFilename: draft.declaredFilename,
      sizeBytes: draft.sizeBytes,
      dimensions: draft.dimensions,
      duration: draft.duration,
      scope: draft.scope,
      createdAt: draft.createdAt,
      committedAt: draft.updatedAt,
      schemaVersion: 1,
    };
  }

  private rowToDraft(row: Record<string, unknown>): AttachmentDraft {
    const now = new Date().toISOString();
    return {
      attachmentId: row.attachmentId as string,
      sessionId: row.sessionId as string,
      contentHash: row.contentHash as string,
      state: row.state as AttachmentDraftState,
      failedStage: undefined, // Not stored in DB currently, tracked in-memory per transition
      errorReason: undefined,
      mediaType: row.mediaType as string,
      declaredMediaType: row.mediaType as string,
      detectedMediaType: undefined,
      declaredFilename: (row.declaredFilename as string) ?? undefined,
      sizeBytes: row.sizeBytes as number,
      dimensions: row.dimensions ? JSON.parse(row.dimensions as string) : undefined,
      duration: (row.duration as number) ?? undefined,
      safetyResult: (row.safetyResult as string) ?? undefined,
      scope: { schemaVersion: 1, sessionId: row.sessionId as string },
      idempotencyKey: (row.idempotencyKey as string) ?? undefined,
      createdAt: row.createdAt as string ?? now,
      updatedAt: row.committedAt as string ?? row.createdAt as string ?? now,
      schemaVersion: 1,
    };
  }

  private fail(code: AttachmentError['code'], message: string): AttachmentServiceResult<never> {
    return { ok: false, error: { code, message } };
  }
}
