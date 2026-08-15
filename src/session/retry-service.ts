/**
 * RetryService — Provides in-place retry with the same or alternate model
 * without clearing the session. Surfaces failure reason from first attempt.
 *
 * Requirements: 22.3, 22.7
 */

import { randomUUID } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────

export interface FailureRecord {
  id: string;
  sessionId: string;
  /** Sequence number of the failed interaction */
  sequenceNumber: number;
  /** The model that was used in the failed attempt */
  modelId: string;
  /** Structured failure reason */
  failureReason: FailureReason;
  /** The original request/prompt that failed */
  originalRequest: string;
  /** Context state at time of failure */
  contextAtFailure: Record<string, unknown>;
  /** Timestamp of the failure */
  failedAt: string;
}

export interface FailureReason {
  /** High-level classification of the failure */
  category: 'model_error' | 'timeout' | 'rate_limit' | 'context_overflow' | 'tool_failure' | 'validation_error' | 'network_error' | 'unknown';
  /** Human-readable description of what went wrong */
  message: string;
  /** Raw error code or status if available */
  code?: string;
  /** Technical details for debugging */
  details?: Record<string, unknown>;
}

export interface RetryOptions {
  sessionId: string;
  /** The sequence number of the interaction to retry */
  sequenceNumber: number;
  /** Model to use for retry (defaults to the same model that failed) */
  modelId?: string;
  /** Optional modified prompt for the retry */
  modifiedRequest?: string;
}

export interface RetryResult {
  success: boolean;
  retryId: string;
  /** The failure reason from the first attempt (surfaced to user) */
  previousFailure: FailureReason;
  /** Model used for the retry */
  modelUsed: string;
  /** Whether an alternate model was used */
  usedAlternateModel: boolean;
  /** The retry attempt number */
  attemptNumber: number;
  error?: string;
}

export interface RetryAttempt {
  id: string;
  sessionId: string;
  failureRecordId: string;
  sequenceNumber: number;
  modelId: string;
  attemptNumber: number;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  result?: unknown;
  createdAt: string;
  completedAt?: string;
}

// ─── Service ────────────────────────────────────────────────────

export class RetryService {
  constructor(private readonly db: any) {
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS failure_records (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        model_id TEXT NOT NULL,
        failure_reason TEXT NOT NULL,
        original_request TEXT NOT NULL,
        context_at_failure TEXT NOT NULL,
        failed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_failure_records_session
        ON failure_records(session_id, sequence_number DESC);

      CREATE TABLE IF NOT EXISTS retry_attempts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        failure_record_id TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        model_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (failure_record_id) REFERENCES failure_records(id)
      );
      CREATE INDEX IF NOT EXISTS idx_retry_attempts_failure
        ON retry_attempts(failure_record_id, attempt_number ASC);
    `);
  }

  /**
   * Record a failure for a session interaction.
   * This stores the failure context so it can be surfaced on retry.
   */
  recordFailure(
    sessionId: string,
    sequenceNumber: number,
    modelId: string,
    failureReason: FailureReason,
    originalRequest: string,
    contextAtFailure: Record<string, unknown>,
  ): FailureRecord {
    const id = randomUUID();
    const failedAt = new Date().toISOString();

    const record: FailureRecord = {
      id,
      sessionId,
      sequenceNumber,
      modelId,
      failureReason,
      originalRequest,
      contextAtFailure,
      failedAt,
    };

    this.db
      .prepare(
        `INSERT INTO failure_records
         (id, session_id, sequence_number, model_id, failure_reason, original_request, context_at_failure, failed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sessionId,
        sequenceNumber,
        modelId,
        JSON.stringify(failureReason),
        originalRequest,
        JSON.stringify(contextAtFailure),
        failedAt,
      );

    return record;
  }

  /**
   * Retry a failed interaction in-place without clearing the session.
   * Surfaces the failure reason from the first attempt.
   */
  retry(options: RetryOptions): RetryResult {
    const { sessionId, sequenceNumber, modelId, modifiedRequest } = options;

    // Find the failure record for this interaction
    const failureRow = this.db
      .prepare(
        `SELECT id, session_id, sequence_number, model_id, failure_reason, original_request, context_at_failure, failed_at
         FROM failure_records
         WHERE session_id = ? AND sequence_number = ?
         ORDER BY failed_at DESC
         LIMIT 1`,
      )
      .get(sessionId, sequenceNumber) as any;

    if (!failureRow) {
      return {
        success: false,
        retryId: '',
        previousFailure: { category: 'unknown', message: 'No failure record found' },
        modelUsed: modelId ?? 'unknown',
        usedAlternateModel: false,
        attemptNumber: 0,
        error: `No failure record found for session ${sessionId} at sequence ${sequenceNumber}`,
      };
    }

    const previousFailure: FailureReason = JSON.parse(failureRow.failure_reason);
    const originalModelId = failureRow.model_id;
    const retryModelId = modelId ?? originalModelId;
    const usedAlternateModel = retryModelId !== originalModelId;

    // Determine attempt number
    const lastAttempt = this.db
      .prepare(
        `SELECT MAX(attempt_number) as max_attempt
         FROM retry_attempts
         WHERE failure_record_id = ?`,
      )
      .get(failureRow.id) as { max_attempt: number | null };

    const attemptNumber = (lastAttempt?.max_attempt ?? 0) + 1;

    // Create retry attempt record
    const retryId = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO retry_attempts
         (id, session_id, failure_record_id, sequence_number, model_id, attempt_number, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(retryId, sessionId, failureRow.id, sequenceNumber, retryModelId, attemptNumber, now);

    return {
      success: true,
      retryId,
      previousFailure,
      modelUsed: retryModelId,
      usedAlternateModel,
      attemptNumber,
    };
  }

  /**
   * Mark a retry attempt as completed (success or failure).
   */
  completeRetry(retryId: string, status: 'completed' | 'failed', result?: unknown): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE retry_attempts
         SET status = ?, result = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(status, result ? JSON.stringify(result) : null, now, retryId);
  }

  /**
   * Get the failure record for a specific interaction.
   */
  getFailure(sessionId: string, sequenceNumber: number): FailureRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, session_id, sequence_number, model_id, failure_reason, original_request, context_at_failure, failed_at
         FROM failure_records
         WHERE session_id = ? AND sequence_number = ?
         ORDER BY failed_at DESC
         LIMIT 1`,
      )
      .get(sessionId, sequenceNumber) as any;

    if (!row) return null;

    return {
      id: row.id,
      sessionId: row.session_id,
      sequenceNumber: row.sequence_number,
      modelId: row.model_id,
      failureReason: JSON.parse(row.failure_reason),
      originalRequest: row.original_request,
      contextAtFailure: JSON.parse(row.context_at_failure),
      failedAt: row.failed_at,
    };
  }

  /**
   * Get all retry attempts for a specific failure.
   */
  getRetryAttempts(failureRecordId: string): RetryAttempt[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, failure_record_id, sequence_number, model_id, attempt_number, status, result, created_at, completed_at
         FROM retry_attempts
         WHERE failure_record_id = ?
         ORDER BY attempt_number ASC`,
      )
      .all(failureRecordId) as any[];

    return rows.map((row: any) => ({
      id: row.id,
      sessionId: row.session_id,
      failureRecordId: row.failure_record_id,
      sequenceNumber: row.sequence_number,
      modelId: row.model_id,
      attemptNumber: row.attempt_number,
      status: row.status,
      result: row.result ? JSON.parse(row.result) : undefined,
      createdAt: row.created_at,
      completedAt: row.completed_at ?? undefined,
    }));
  }

  /**
   * Get all failures for a session.
   */
  getSessionFailures(sessionId: string): FailureRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, sequence_number, model_id, failure_reason, original_request, context_at_failure, failed_at
         FROM failure_records
         WHERE session_id = ?
         ORDER BY failed_at DESC`,
      )
      .all(sessionId) as any[];

    return rows.map((row: any) => ({
      id: row.id,
      sessionId: row.session_id,
      sequenceNumber: row.sequence_number,
      modelId: row.model_id,
      failureReason: JSON.parse(row.failure_reason),
      originalRequest: row.original_request,
      contextAtFailure: JSON.parse(row.context_at_failure),
      failedAt: row.failed_at,
    }));
  }

  /**
   * Clear all failure records and retry attempts for a session.
   */
  clearSession(sessionId: string): void {
    // Delete retry attempts linked to this session's failures
    this.db
      .prepare(
        `DELETE FROM retry_attempts WHERE failure_record_id IN (
          SELECT id FROM failure_records WHERE session_id = ?
        )`,
      )
      .run(sessionId);

    this.db.prepare('DELETE FROM failure_records WHERE session_id = ?').run(sessionId);
  }
}
