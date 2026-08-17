/**
 * Transactional Outbox and Consumer Checkpoints
 *
 * Provides atomic domain + outbox publication, checkpoint-based consumption,
 * and idempotent derived-effect commitment.
 *
 * Key invariant: no transaction may wait on model, tool, network, filesystem,
 * process, or human work. All I/O happens OUTSIDE transactions.
 *
 * Requirements: 15.7–15.8, 30.7, 31.2–31.5, 31.11–31.12, 35.14
 */

import type { SharedDatabase } from '../database/shared-database.js';
import type { BoundedExec, TransactionResult } from '../database/bounded-transaction.js';

/**
 * An outbox record to be committed alongside domain rows.
 */
export interface OutboxRecord {
  /** Unique identity for this outbox record */
  outboxId: string;
  /** Topic for routing to consumers */
  topic: string;
  /** JSON-serializable payload */
  payload: unknown;
  /** Monotonically increasing ordering within topic */
  ordering: number;
  /** Optional idempotency key for deduplication */
  idempotencyKey?: string;
}

/**
 * A consumed outbox record returned by consumeAfterCheckpoint.
 */
export interface ConsumedOutboxRecord {
  outboxId: string;
  topic: string;
  payload: unknown;
  ordering: number;
  idempotencyKey: string | null;
  schemaVersion: number;
  createdAt: string;
}

/**
 * Result of a publish operation.
 */
export interface PublishResult<T> {
  /** The domain function's return value */
  domainResult: T;
  /** Number of outbox records committed */
  outboxCount: number;
}

/**
 * Result of a commitWithCheckpoint operation.
 */
export interface CommitCheckpointResult<T> {
  /** The derived function's return value */
  derivedResult: T;
  /** The new checkpoint position */
  newCheckpoint: number;
  /** Number of records skipped due to idempotency */
  skippedCount: number;
}

/**
 * OutboxService provides transactional outbox pattern for cross-process
 * coordination through versioned SQLite records.
 *
 * Usage pattern:
 * 1. Producer calls publishWithDomain() to atomically commit domain rows + outbox
 * 2. Consumer calls consumeAfterCheckpoint() to read unconsumed records
 * 3. Consumer processes records OUTSIDE any transaction (I/O, network, etc.)
 * 4. Consumer calls commitWithCheckpoint() to persist derived effects + advance checkpoint
 */
export class OutboxService {
  private readonly db: SharedDatabase;

  constructor(db: SharedDatabase) {
    this.db = db;
  }

  /**
   * Atomically commit domain rows AND outbox records in ONE short transaction.
   *
   * The domainFn receives a BoundedExec and MUST NOT perform any I/O,
   * network, filesystem, process, or user-wait operations.
   *
   * @param domainFn - Function that commits domain-specific rows using the provided exec
   * @param outboxRecords - Ordered outbox records to commit alongside domain rows
   * @returns TransactionResult containing domain result and outbox count
   */
  publishWithDomain<T>(
    domainFn: (exec: BoundedExec) => T,
    outboxRecords: OutboxRecord[]
  ): TransactionResult<PublishResult<T>> {
    return this.db.runImmediate<PublishResult<T>>((exec) => {
      // Execute domain logic first
      const domainResult = domainFn(exec);

      // Insert outbox records in the same transaction
      for (const record of outboxRecords) {
        const payload = typeof record.payload === 'string'
          ? record.payload
          : JSON.stringify(record.payload);

        exec(
          `INSERT INTO harness_outbox (outboxId, topic, payload, ordering, idempotencyKey, state, schemaVersion)
           VALUES (?, ?, ?, ?, ?, 'pending', 1)`,
          record.outboxId,
          record.topic,
          payload,
          record.ordering,
          record.idempotencyKey ?? null
        ).run();
      }

      return { domainResult, outboxCount: outboxRecords.length };
    });
  }

  /**
   * Read compatible unconsumed outbox records after the named consumer's checkpoint.
   *
   * This is a read-only operation that does NOT modify state.
   * Processing should happen OUTSIDE any transaction.
   *
   * @param consumerName - Unique name identifying this consumer
   * @param topic - Topic to consume from
   * @param batchSize - Maximum number of records to return
   * @returns Array of unconsumed records after the consumer's checkpoint
   */
  consumeAfterCheckpoint(
    consumerName: string,
    topic: string,
    batchSize: number
  ): ConsumedOutboxRecord[] {
    const db = this.db.raw;

    // Get current checkpoint for this consumer+topic
    const checkpointStmt = db.prepare(
      `SELECT lastConsumedOrdering FROM harness_consumer_checkpoints
       WHERE consumerId = ? AND topic = ?`
    );
    const checkpoint = checkpointStmt.get(consumerName, topic) as
      | { lastConsumedOrdering: number }
      | undefined;

    const lastOrdering = checkpoint?.lastConsumedOrdering ?? 0;

    // Read unconsumed records after the checkpoint
    const recordsStmt = db.prepare(
      `SELECT outboxId, topic, payload, ordering, idempotencyKey, schemaVersion, createdAt
       FROM harness_outbox
       WHERE topic = ? AND ordering > ? AND state = 'pending'
       ORDER BY ordering ASC
       LIMIT ?`
    );
    const rows = recordsStmt.all(topic, lastOrdering, batchSize) as Array<{
      outboxId: string;
      topic: string;
      payload: string;
      ordering: number;
      idempotencyKey: string | null;
      schemaVersion: number;
      createdAt: string;
    }>;

    return rows.map((row) => ({
      outboxId: row.outboxId,
      topic: row.topic,
      payload: JSON.parse(row.payload),
      ordering: row.ordering,
      idempotencyKey: row.idempotencyKey,
      schemaVersion: row.schemaVersion,
      createdAt: row.createdAt,
    }));
  }

  /**
   * Atomically commit derived effects AND advance the consumer checkpoint
   * under idempotency guards.
   *
   * If any consumedId has already been marked as consumed (idempotency),
   * it is skipped without error.
   *
   * The derivedFn receives a BoundedExec and MUST NOT perform any I/O,
   * network, filesystem, process, or user-wait operations.
   *
   * @param consumerName - Unique name identifying this consumer
   * @param topic - Topic being consumed
   * @param derivedFn - Function that commits derived effects using the provided exec
   * @param consumedIds - Outbox record IDs that were processed
   * @returns TransactionResult containing derived result, new checkpoint, and skip count
   */
  commitWithCheckpoint<T>(
    consumerName: string,
    topic: string,
    derivedFn: (exec: BoundedExec) => T,
    consumedIds: string[]
  ): TransactionResult<CommitCheckpointResult<T>> {
    return this.db.runImmediate<CommitCheckpointResult<T>>((exec) => {
      let skippedCount = 0;
      let maxOrdering = 0;

      // Mark consumed records with idempotency check
      for (const id of consumedIds) {
        // Check current state for idempotency
        const current = exec(
          `SELECT state, ordering FROM harness_outbox WHERE outboxId = ?`,
          id
        ).get() as { state: string; ordering: number } | undefined;

        if (!current) {
          // Record doesn't exist - skip
          skippedCount++;
          continue;
        }

        if (current.state === 'consumed') {
          // Already consumed - idempotent skip
          skippedCount++;
          continue;
        }

        // Mark as consumed
        exec(
          `UPDATE harness_outbox SET state = 'consumed', consumedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE outboxId = ? AND state = 'pending'`,
          id
        ).run();

        if (current.ordering > maxOrdering) {
          maxOrdering = current.ordering;
        }
      }

      // Execute derived effects
      const derivedResult = derivedFn(exec);

      // Advance checkpoint atomically (only if we actually consumed something)
      if (maxOrdering > 0) {
        exec(
          `INSERT INTO harness_consumer_checkpoints (consumerId, topic, lastConsumedOrdering, lastConsumedAt, schemaVersion)
           VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 1)
           ON CONFLICT(consumerId, topic) DO UPDATE SET
             lastConsumedOrdering = MAX(excluded.lastConsumedOrdering, harness_consumer_checkpoints.lastConsumedOrdering),
             lastConsumedAt = excluded.lastConsumedAt`,
          consumerName,
          topic,
          maxOrdering
        ).run();
      }

      return {
        derivedResult,
        newCheckpoint: maxOrdering,
        skippedCount,
      };
    });
  }

  /**
   * Get the current checkpoint position for a consumer on a topic.
   * Returns 0 if no checkpoint exists.
   */
  getCheckpoint(consumerName: string, topic: string): number {
    const db = this.db.raw;
    const stmt = db.prepare(
      `SELECT lastConsumedOrdering FROM harness_consumer_checkpoints
       WHERE consumerId = ? AND topic = ?`
    );
    const row = stmt.get(consumerName, topic) as { lastConsumedOrdering: number } | undefined;
    return row?.lastConsumedOrdering ?? 0;
  }
}
