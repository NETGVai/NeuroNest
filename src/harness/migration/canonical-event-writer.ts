/**
 * Canonical Event Writer
 *
 * Writes all new durable mutations as canonical events plus outbox records
 * through Session_Log. This implements the "write side" of the strangler
 * migration: every legacy mutation that passes through the adapter also
 * gets durably recorded in the canonical Session_Log with a corresponding
 * outbox record for downstream projection consumers.
 *
 * The writer does NOT replace the legacy mutation path. Both paths run
 * in parallel during the migration. The canonical path becomes the source
 * of truth only after parity is confirmed and the legacy path is retired.
 *
 * Requirements: 1.3–1.5, 3.1–3.7, 29.5–29.8, 35.1–35.4
 */

import type { SessionLog } from '../session-log/session-log.js';
import type { OutboxService, OutboxRecord } from '../outbox/outbox-service.js';
import type { AppendEventCommand, AppendReceipt } from '../session-log/types.js';
import type { ActorRef } from '../contracts/actor.js';
import type { ScopeDescriptorV1 } from '../contracts/scope.js';
import type { SessionEventPayloadV1 } from '../contracts/event.js';
import type { AdaptedEvent } from './legacy-session-adapter.js';

// ─── Configuration ──────────────────────────────────────────────

export interface CanonicalEventWriterConfig {
  /** Session ID for all written events */
  sessionId: string;
  /** Branch ID (defaults to 'main') */
  branchId?: string;
  /** Outbox topic for projection consumers */
  outboxTopic?: string;
  /** Whether to actually write to the log (false = dry-run/shadow mode) */
  writeEnabled: boolean;
  /** Actor for system-generated migration events */
  migrationActor: ActorRef;
  /** Scope descriptor for migration events */
  scope: ScopeDescriptorV1;
}

// ─── Write Result ───────────────────────────────────────────────

export interface CanonicalWriteResult {
  /** Whether the write was performed (false in dry-run mode) */
  written: boolean;
  /** Append receipt if written */
  receipt?: AppendReceipt;
  /** Outbox record ID if published */
  outboxId?: string;
  /** Idempotency key used */
  idempotencyKey: string;
  /** Event type written */
  eventType: string;
}

// ─── Writer Stats ───────────────────────────────────────────────

export interface WriterStats {
  sessionId: string;
  branchId: string;
  totalWritten: number;
  totalSkipped: number;
  totalDuplicates: number;
  lastWrittenSequence: number;
  writeEnabled: boolean;
}

// ─── Canonical Event Writer ─────────────────────────────────────

/**
 * CanonicalEventWriter takes adapted legacy events (from LegacySessionAdapter)
 * and writes them as canonical events to Session_Log with corresponding
 * outbox records for projection consumers.
 *
 * In shadow mode (writeEnabled=false), it tracks what would be written
 * without actually modifying the durable log. This supports parity
 * comparison before the canonical path becomes authoritative.
 */
export class CanonicalEventWriter {
  private readonly sessionLog: SessionLog;
  private readonly outbox: OutboxService;
  private readonly config: CanonicalEventWriterConfig;

  private totalWritten = 0;
  private totalSkipped = 0;
  private totalDuplicates = 0;
  private lastWrittenSequence = -1;
  private outboxOrdering = 0;

  constructor(
    sessionLog: SessionLog,
    outbox: OutboxService,
    config: CanonicalEventWriterConfig
  ) {
    this.sessionLog = sessionLog;
    this.outbox = outbox;
    this.config = config;
  }

  /**
   * Write a single adapted event to Session_Log with an outbox record.
   *
   * Uses the legacy event ID as part of the idempotency key to prevent
   * duplicate writes during replays or retries.
   */
  writeAdaptedEvent(adapted: AdaptedEvent): CanonicalWriteResult {
    const idempotencyKey = this.buildIdempotencyKey(adapted);
    const eventType = adapted.canonicalEventType;

    if (!this.config.writeEnabled) {
      this.totalSkipped++;
      return {
        written: false,
        idempotencyKey,
        eventType,
      };
    }

    const command: AppendEventCommand = {
      sessionId: this.config.sessionId,
      branchId: this.config.branchId ?? 'main',
      eventType,
      payload: adapted.canonicalPayload,
      actor: this.config.migrationActor,
      scope: this.config.scope,
      idempotencyKey,
    };

    const receipt = this.sessionLog.append(command);

    if (receipt.alreadyExists) {
      this.totalDuplicates++;
      return {
        written: false,
        receipt,
        idempotencyKey,
        eventType,
      };
    }

    // Publish outbox record for projection consumers
    const outboxId = `migration-outbox-${receipt.eventId}`;
    this.outboxOrdering++;

    const outboxRecord: OutboxRecord = {
      outboxId,
      topic: this.config.outboxTopic ?? 'migration.canonical_events',
      payload: {
        eventId: receipt.eventId,
        sessionId: receipt.sessionId,
        branchId: receipt.branchId,
        sequence: receipt.sequence,
        eventType,
        source: 'strangler_migration',
      },
      ordering: this.outboxOrdering,
      idempotencyKey: `outbox-${idempotencyKey}`,
    };

    this.outbox.publishWithDomain(
      (_exec) => { /* domain row already written via sessionLog.append */ },
      [outboxRecord]
    );

    this.totalWritten++;
    this.lastWrittenSequence = receipt.sequence;

    return {
      written: true,
      receipt,
      outboxId,
      idempotencyKey,
      eventType,
    };
  }

  /**
   * Write a batch of adapted events in order.
   */
  writeBatch(adaptedEvents: AdaptedEvent[]): CanonicalWriteResult[] {
    return adaptedEvents.map((adapted) => this.writeAdaptedEvent(adapted));
  }

  /**
   * Write a raw canonical event command directly (for new mutations that
   * don't originate from legacy adaptation).
   */
  writeCanonicalEvent(
    eventType: string,
    payload: SessionEventPayloadV1,
    idempotencyKey: string
  ): CanonicalWriteResult {
    if (!this.config.writeEnabled) {
      this.totalSkipped++;
      return {
        written: false,
        idempotencyKey,
        eventType,
      };
    }

    const command: AppendEventCommand = {
      sessionId: this.config.sessionId,
      branchId: this.config.branchId ?? 'main',
      eventType,
      payload,
      actor: this.config.migrationActor,
      scope: this.config.scope,
      idempotencyKey,
    };

    const receipt = this.sessionLog.append(command);

    if (receipt.alreadyExists) {
      this.totalDuplicates++;
      return { written: false, receipt, idempotencyKey, eventType };
    }

    // Publish outbox record
    const outboxId = `canonical-outbox-${receipt.eventId}`;
    this.outboxOrdering++;

    const outboxRecord: OutboxRecord = {
      outboxId,
      topic: this.config.outboxTopic ?? 'migration.canonical_events',
      payload: {
        eventId: receipt.eventId,
        sessionId: receipt.sessionId,
        branchId: receipt.branchId,
        sequence: receipt.sequence,
        eventType,
        source: 'canonical_write',
      },
      ordering: this.outboxOrdering,
      idempotencyKey: `outbox-${idempotencyKey}`,
    };

    this.outbox.publishWithDomain(
      (_exec) => { /* domain already written */ },
      [outboxRecord]
    );

    this.totalWritten++;
    this.lastWrittenSequence = receipt.sequence;

    return {
      written: true,
      receipt,
      outboxId,
      idempotencyKey,
      eventType,
    };
  }

  /**
   * Get redacted write statistics.
   */
  getStats(): WriterStats {
    return {
      sessionId: this.config.sessionId,
      branchId: this.config.branchId ?? 'main',
      totalWritten: this.totalWritten,
      totalSkipped: this.totalSkipped,
      totalDuplicates: this.totalDuplicates,
      lastWrittenSequence: this.lastWrittenSequence,
      writeEnabled: this.config.writeEnabled,
    };
  }

  /**
   * Check if the writer is in active (write-enabled) or shadow (dry-run) mode.
   */
  isWriteEnabled(): boolean {
    return this.config.writeEnabled;
  }

  /**
   * Build idempotency key from adapted event data.
   */
  private buildIdempotencyKey(adapted: AdaptedEvent): string {
    return `migration:${this.config.sessionId}:${adapted.legacyEvent.id}:${adapted.legacyEvent.sequence}`;
  }
}
