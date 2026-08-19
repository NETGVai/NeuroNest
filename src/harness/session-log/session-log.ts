/**
 * Session_Log — Append-only event log with integrity, replay, and immutable forks.
 *
 * Provides:
 * - Atomic single-event append with sequence/hash computation
 * - Atomic multi-event batch append in one transaction
 * - Fork with lineage-before-child enforcement
 * - Range read with optional AbortSignal
 * - Integrity hash chain verification
 * - Idempotent resume (duplicate idempotencyKey returns existing receipt)
 * - Checkpoint-assisted replay
 * - Schema upcasting during replay
 * - Complete uncompressed payload retention
 *
 * Requirements: 3.1–3.7, 15.7–15.8, 28.4–28.6, 34.4, 44.2–44.3, 44.13
 */

import crypto from 'node:crypto';
import type { SharedDatabase } from '../database/shared-database.js';
import type { SessionEventV1 } from '../contracts/event.js';
import { computeIntegrityHash, verifyIntegrityChain } from './integrity.js';
import { DefaultUpcasterRegistry } from './upcasters.js';
import type {
  AppendEventCommand,
  AtomicEventBatchCommand,
  ForkSessionCommand,
  SessionRangeQuery,
  AppendReceipt,
  ForkReceipt,
  IntegrityReport,
  ReplayCheckpoint,
  UpcasterRegistry,
} from './types.js';

type IdempotentEventRow = {
  eventId: string;
  sessionId: string;
  branchId: string;
  sequence: number;
  integrityHash: string;
  idempotencyKey: string;
  eventType: string;
};

type IdempotentEventExpectation = {
  sessionId: string;
  eventType: string;
  eventId?: string;
};

/**
 * SessionLog — The append-only durable event log for harness sessions.
 *
 * All events are stored with complete uncompressed payloads. The integrity
 * hash chain (SHA-256) links each event to its predecessor, enabling
 * verification of log consistency at any point.
 */
export class SessionLog {
  private readonly db: SharedDatabase;
  private readonly upcasters: UpcasterRegistry;

  constructor(db: SharedDatabase, upcasters?: UpcasterRegistry) {
    this.db = db;
    this.upcasters = upcasters ?? new DefaultUpcasterRegistry();
  }

  /**
   * Append a single event atomically.
   *
   * Computes sequence and integrity hash within the transaction.
   * If idempotencyKey is provided and already exists, returns the existing receipt.
   */
  append(command: AppendEventCommand): AppendReceipt {
    const branchId = command.branchId ?? 'main';

    // Check idempotency first (outside transaction for fast path)
    if (command.idempotencyKey) {
      const existing = this.findByIdempotencyKey(command.idempotencyKey);
      if (existing) {
        return this.receiptForIdempotentMatch(existing, command, branchId);
      }
    }

    const eventId = command.eventId ?? crypto.randomUUID();
    const payloadJson = JSON.stringify(command.payload);
    const occurredAt = command.occurredAt ?? new Date().toISOString();
    const actorJson = JSON.stringify(command.actor);
    const scopeJson = JSON.stringify(command.scope);

    const result = this.db.runImmediate<AppendReceipt>((exec) => {
      // Double-check idempotency inside the transaction
      if (command.idempotencyKey) {
        const existingRow = exec(
          `SELECT eventId, sessionId, branchId, sequence, integrityHash, idempotencyKey, eventType
           FROM harness_events WHERE idempotencyKey = ?`,
          command.idempotencyKey
        ).get() as IdempotentEventRow | undefined;

        if (existingRow) {
          return this.receiptForIdempotentMatch(existingRow, command, branchId);
        }
      }

      // Get current max sequence and previous hash
      const prevRow = exec(
        `SELECT sequence, integrityHash FROM harness_events
         WHERE sessionId = ? AND branchId = ?
         ORDER BY sequence DESC LIMIT 1`,
        command.sessionId, branchId
      ).get() as { sequence: number; integrityHash: string } | undefined;

      const sequence = prevRow ? prevRow.sequence + 1 : 0;
      const previousIntegrityHash = prevRow ? prevRow.integrityHash : null;

      // Compute integrity hash
      const integrityHash = computeIntegrityHash({
        sessionId: command.sessionId,
        branchId,
        sequence,
        eventType: command.eventType,
        payload: payloadJson,
        previousIntegrityHash,
      });

      // Insert the event
      exec(
        `INSERT INTO harness_events (eventId, sessionId, branchId, sequence, schemaVersion, eventType, payload, idempotencyKey, occurredAt, actor, scope, previousIntegrityHash, integrityHash)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        eventId, command.sessionId, branchId, sequence, command.eventType, payloadJson,
        command.idempotencyKey ?? null, occurredAt, actorJson, scopeJson,
        previousIntegrityHash, integrityHash
      ).run();

      return {
        eventId,
        sessionId: command.sessionId,
        branchId,
        sequence,
        integrityHash,
        idempotencyKey: command.idempotencyKey,
        alreadyExists: false,
      };
    });

    if (!result.ok) {
      throw new Error(`Failed to append event: ${result.error.message}`);
    }

    return result.value;
  }

  /**
   * Append multiple events atomically in a single transaction.
   *
   * All events share the same session and branch. Sequences and hashes
   * are computed incrementally within the transaction.
   */
  appendBatch(command: AtomicEventBatchCommand): AppendReceipt[] {
    const branchId = command.branchId ?? 'main';

    if (command.events.length === 0) {
      return [];
    }

    const result = this.db.runImmediate<AppendReceipt[]>((exec) => {
      const receipts: AppendReceipt[] = [];

      // Get current max sequence and previous hash
      const prevRow = exec(
        `SELECT sequence, integrityHash FROM harness_events
         WHERE sessionId = ? AND branchId = ?
         ORDER BY sequence DESC LIMIT 1`,
        command.sessionId, branchId
      ).get() as { sequence: number; integrityHash: string } | undefined;

      let currentSequence = prevRow ? prevRow.sequence + 1 : 0;
      let previousIntegrityHash: string | null = prevRow ? prevRow.integrityHash : null;

      for (const event of command.events) {
        // Check idempotency
        if (event.idempotencyKey) {
          const existingRow = exec(
            `SELECT eventId, sessionId, branchId, sequence, integrityHash, idempotencyKey, eventType
             FROM harness_events WHERE idempotencyKey = ?`,
            event.idempotencyKey
          ).get() as IdempotentEventRow | undefined;

          if (existingRow) {
            receipts.push(
              this.receiptForIdempotentMatch(
                existingRow,
                { ...event, sessionId: command.sessionId },
                branchId,
              ),
            );
            continue;
          }
        }

        const eventId = event.eventId ?? crypto.randomUUID();
        const payloadJson = JSON.stringify(event.payload);
        const occurredAt = event.occurredAt ?? new Date().toISOString();
        const actorJson = JSON.stringify(event.actor);
        const scopeJson = JSON.stringify(event.scope);

        const integrityHash = computeIntegrityHash({
          sessionId: command.sessionId,
          branchId,
          sequence: currentSequence,
          eventType: event.eventType,
          payload: payloadJson,
          previousIntegrityHash,
        });

        exec(
          `INSERT INTO harness_events (eventId, sessionId, branchId, sequence, schemaVersion, eventType, payload, idempotencyKey, occurredAt, actor, scope, previousIntegrityHash, integrityHash)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
          eventId, command.sessionId, branchId, currentSequence, event.eventType, payloadJson,
          event.idempotencyKey ?? null, occurredAt, actorJson, scopeJson,
          previousIntegrityHash, integrityHash
        ).run();

        receipts.push({
          eventId,
          sessionId: command.sessionId,
          branchId,
          sequence: currentSequence,
          integrityHash,
          idempotencyKey: event.idempotencyKey,
          alreadyExists: false,
        });

        previousIntegrityHash = integrityHash;
        currentSequence++;
      }

      return receipts;
    });

    if (!result.ok) {
      throw new Error(`Failed to append batch: ${result.error.message}`);
    }

    return result.value;
  }

  /**
   * Fork a session by creating a child branch with lineage record.
   *
   * Lineage-before-child enforcement: the lineage record is committed
   * BEFORE any child events can be appended (unique constraint on childSessionId
   * in harness_lineage ensures fork is recorded once).
   */
  fork(command: ForkSessionCommand): ForkReceipt {
    const parentBranchId = command.parentBranchId ?? 'main';
    const childBranchId = command.childBranchId ?? 'main';

    const result = this.db.runImmediate<ForkReceipt>((exec) => {
      // Verify parent sequence exists
      const parentEvent = exec(
        `SELECT sequence FROM harness_events
         WHERE sessionId = ? AND branchId = ? AND sequence = ?`,
        command.parentSessionId, parentBranchId, command.parentSequence
      ).get() as { sequence: number } | undefined;

      if (!parentEvent) {
        throw new Error(
          `Parent event not found: session=${command.parentSessionId}, branch=${parentBranchId}, sequence=${command.parentSequence}`
        );
      }

      // Insert lineage record (unique constraint on childSessionId enforces one fork per child)
      const lineageResult = exec(
        `INSERT INTO harness_lineage (parentSessionId, parentSequence, childSessionId, createdAt)
         VALUES (?, ?, ?, ?)`,
        command.parentSessionId, command.parentSequence, command.childSessionId,
        new Date().toISOString()
      ).run();

      return {
        parentSessionId: command.parentSessionId,
        parentSequence: command.parentSequence,
        childSessionId: command.childSessionId,
        childBranchId,
        lineageId: Number(lineageResult.lastInsertRowid),
      };
    });

    if (!result.ok) {
      throw new Error(`Failed to fork session: ${result.error.message}`);
    }

    return result.value;
  }

  /**
   * Read events for a session/branch within an optional sequence range.
   *
   * Returns complete uncompressed event records. Respects AbortSignal
   * for cancellation of potentially large reads.
   */
  readRange(query: SessionRangeQuery, signal?: AbortSignal): SessionEventV1[] {
    const branchId = query.branchId ?? 'main';

    if (signal?.aborted) {
      throw new Error('Read aborted');
    }

    let sql = `SELECT eventId, sessionId, branchId, sequence, schemaVersion, eventType, payload, idempotencyKey, occurredAt, actor, scope, previousIntegrityHash, integrityHash
               FROM harness_events
               WHERE sessionId = ? AND branchId = ?`;
    const params: unknown[] = [query.sessionId, branchId];

    if (query.fromSequence !== undefined) {
      sql += ' AND sequence >= ?';
      params.push(query.fromSequence);
    }
    if (query.toSequence !== undefined) {
      sql += ' AND sequence <= ?';
      params.push(query.toSequence);
    }

    sql += ' ORDER BY sequence ASC';

    const stmt = this.db.raw.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      eventId: string;
      sessionId: string;
      branchId: string;
      sequence: number;
      schemaVersion: number;
      eventType: string;
      payload: string;
      idempotencyKey: string | null;
      occurredAt: string;
      actor: string;
      scope: string;
      previousIntegrityHash: string | null;
      integrityHash: string;
    }>;

    return rows.map((row) => {
      if (signal?.aborted) {
        throw new Error('Read aborted');
      }

      const event: SessionEventV1 = {
        eventId: row.eventId,
        sessionId: row.sessionId,
        branchId: row.branchId,
        sequence: row.sequence,
        schemaVersion: row.schemaVersion as 1,
        eventType: row.eventType,
        payload: JSON.parse(row.payload),
        occurredAt: row.occurredAt,
        actor: JSON.parse(row.actor),
        scope: JSON.parse(row.scope),
        previousIntegrityHash: row.previousIntegrityHash,
        integrityHash: row.integrityHash,
      };

      if (row.idempotencyKey) {
        event.idempotencyKey = row.idempotencyKey;
      }

      return event;
    });
  }

  /**
   * Verify the integrity hash chain for a range of events.
   *
   * Checks that each event's integrityHash correctly chains from its
   * previousIntegrityHash, and that the computed hash matches the stored hash.
   * Stops at the first fault.
   */
  verify(range: SessionRangeQuery): IntegrityReport {
    const branchId = range.branchId ?? 'main';

    let sql = `SELECT sessionId, branchId, sequence, eventType, payload, previousIntegrityHash, integrityHash
               FROM harness_events
               WHERE sessionId = ? AND branchId = ?`;
    const params: unknown[] = [range.sessionId, branchId];

    if (range.fromSequence !== undefined) {
      sql += ' AND sequence >= ?';
      params.push(range.fromSequence);
    }
    if (range.toSequence !== undefined) {
      sql += ' AND sequence <= ?';
      params.push(range.toSequence);
    }

    sql += ' ORDER BY sequence ASC';

    const stmt = this.db.raw.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      sessionId: string;
      branchId: string;
      sequence: number;
      eventType: string;
      payload: string;
      previousIntegrityHash: string | null;
      integrityHash: string;
    }>;

    if (rows.length === 0) {
      return {
        sessionId: range.sessionId,
        branchId,
        fromSequence: range.fromSequence ?? 0,
        toSequence: range.toSequence ?? 0,
        totalEvents: 0,
        valid: true,
      };
    }

    // Determine expected previousIntegrityHash for the first event in range
    let expectedFirstPrevHash: string | null = null;
    if (rows[0].sequence > 0) {
      const preceedingRow = this.db.raw.prepare(
        `SELECT integrityHash FROM harness_events
         WHERE sessionId = ? AND branchId = ? AND sequence = ?`
      ).get(range.sessionId, branchId, rows[0].sequence - 1) as { integrityHash: string } | undefined;

      expectedFirstPrevHash = preceedingRow?.integrityHash ?? null;
    }

    const chainResult = verifyIntegrityChain(rows, expectedFirstPrevHash);

    const report: IntegrityReport = {
      sessionId: range.sessionId,
      branchId,
      fromSequence: rows[0].sequence,
      toSequence: rows[rows.length - 1].sequence,
      totalEvents: rows.length,
      valid: chainResult.valid,
    };

    if (!chainResult.valid) {
      report.firstFaultSequence = rows[chainResult.faultIndex].sequence;
      report.firstFaultReason = chainResult.faultReason;
    }

    return report;
  }

  /**
   * Replay events from a known-good checkpoint forward.
   *
   * Verifies the checkpoint hash matches, then returns events from
   * checkpoint.sequence + 1 onward with optional schema upcasting.
   */
  replayFromCheckpoint(
    checkpoint: ReplayCheckpoint,
    targetSchemaVersion?: number
  ): SessionEventV1[] {
    const branchId = checkpoint.branchId;

    // Verify checkpoint integrity
    const checkpointEvent = this.db.raw.prepare(
      `SELECT integrityHash FROM harness_events
       WHERE sessionId = ? AND branchId = ? AND sequence = ?`
    ).get(checkpoint.sessionId, branchId, checkpoint.sequence) as { integrityHash: string } | undefined;

    if (!checkpointEvent) {
      throw new Error(
        `Checkpoint event not found: session=${checkpoint.sessionId}, branch=${branchId}, sequence=${checkpoint.sequence}`
      );
    }

    if (checkpointEvent.integrityHash !== checkpoint.integrityHash) {
      throw new Error(
        `Checkpoint integrity mismatch: expected "${checkpoint.integrityHash}" but found "${checkpointEvent.integrityHash}"`
      );
    }

    // Read events after the checkpoint
    const events = this.readRange({
      sessionId: checkpoint.sessionId,
      branchId,
      fromSequence: checkpoint.sequence + 1,
    });

    // Apply schema upcasting if needed
    if (targetSchemaVersion) {
      return events.map((event) => this.upcasters.upcast(event, targetSchemaVersion));
    }

    return events;
  }

  /** Look up an existing durable event by its globally unique idempotency key. */
  private findByIdempotencyKey(key: string): IdempotentEventRow | undefined {
    return this.db.raw.prepare(
      `SELECT eventId, sessionId, branchId, sequence, integrityHash, idempotencyKey, eventType
       FROM harness_events WHERE idempotencyKey = ?`
    ).get(key) as IdempotentEventRow | undefined;
  }

  /**
   * A repeated key is idempotent only for the same durable authority target.
   * Reusing a key across a session, branch, event type, or explicit event ID
   * is a correlation violation rather than permission to return another
   * response's receipt.
   */
  private receiptForIdempotentMatch(
    row: IdempotentEventRow,
    expected: IdempotentEventExpectation,
    branchId: string,
  ): AppendReceipt {
    if (
      row.sessionId !== expected.sessionId ||
      row.branchId !== branchId ||
      row.eventType !== expected.eventType ||
      (expected.eventId !== undefined && row.eventId !== expected.eventId)
    ) {
      throw new Error('Idempotency key was already used by a different event authority');
    }

    return {
      eventId: row.eventId,
      sessionId: row.sessionId,
      branchId: row.branchId,
      sequence: row.sequence,
      integrityHash: row.integrityHash,
      idempotencyKey: row.idempotencyKey,
      alreadyExists: true,
    };
  }
}
