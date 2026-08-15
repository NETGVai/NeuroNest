/**
 * AuditHistory — Records every traceability mutation.
 *
 * - Records every traceability mutation
 * - Captures: actor, timestamp, previous value, new value, entity ID, mutation type
 * - Supports querying audit history by entity, by actor, by time range
 * - Immutable audit records (append-only)
 *
 * Requirements: 11.9
 */

import { randomUUID } from 'node:crypto';

/** Types of traceability mutations that are audited */
export type AuditMutationType =
  | 'link_created'
  | 'link_deleted'
  | 'link_updated'
  | 'coverage_changed'
  | 'status_changed'
  | 'entity_created'
  | 'entity_renamed'
  | 'entity_deleted'
  | 'entity_merged';

/** An immutable audit record */
export interface AuditRecord {
  readonly id: string;
  readonly entityId: string;
  readonly entityType: string;
  readonly mutationType: AuditMutationType;
  readonly actor: string;
  readonly timestamp: string;
  readonly previousValue: unknown;
  readonly newValue: unknown;
  readonly metadata?: Record<string, unknown>;
}

/** Input for recording an audit event */
export interface AuditInput {
  entityId: string;
  entityType: string;
  mutationType: AuditMutationType;
  actor: string;
  previousValue: unknown;
  newValue: unknown;
  metadata?: Record<string, unknown>;
}

/** Query filter for audit history */
export interface AuditQuery {
  entityId?: string;
  actor?: string;
  mutationType?: AuditMutationType;
  startTime?: string;
  endTime?: string;
  limit?: number;
}

/**
 * AuditHistory is an append-only store for traceability mutation records.
 *
 * Every change to trace links, coverage, entity status, or planning entities
 * is recorded with actor, timestamp, previous value, and new value.
 *
 * Records are immutable once created — they cannot be modified or deleted.
 */
export class AuditHistory {
  private records: AuditRecord[] = [];

  /**
   * Records a traceability mutation. Returns the created immutable record.
   */
  record(input: AuditInput): AuditRecord {
    const record: AuditRecord = Object.freeze({
      id: randomUUID(),
      entityId: input.entityId,
      entityType: input.entityType,
      mutationType: input.mutationType,
      actor: input.actor,
      timestamp: new Date().toISOString(),
      previousValue: input.previousValue,
      newValue: input.newValue,
      metadata: input.metadata,
    });

    this.records.push(record);
    return record;
  }

  /**
   * Queries audit history with optional filters.
   * Returns records in chronological order (oldest first).
   */
  query(filter: AuditQuery): AuditRecord[] {
    let results = this.records;

    if (filter.entityId !== undefined) {
      results = results.filter((r) => r.entityId === filter.entityId);
    }

    if (filter.actor !== undefined) {
      results = results.filter((r) => r.actor === filter.actor);
    }

    if (filter.mutationType !== undefined) {
      results = results.filter((r) => r.mutationType === filter.mutationType);
    }

    if (filter.startTime !== undefined) {
      results = results.filter((r) => r.timestamp >= filter.startTime!);
    }

    if (filter.endTime !== undefined) {
      results = results.filter((r) => r.timestamp <= filter.endTime!);
    }

    if (filter.limit !== undefined && filter.limit > 0) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  /**
   * Gets all audit records for a specific entity in chronological order.
   */
  getEntityHistory(entityId: string): AuditRecord[] {
    return this.records.filter((r) => r.entityId === entityId);
  }

  /**
   * Gets all audit records by a specific actor.
   */
  getActorHistory(actor: string): AuditRecord[] {
    return this.records.filter((r) => r.actor === actor);
  }

  /**
   * Gets the total number of audit records.
   */
  get size(): number {
    return this.records.length;
  }

  /**
   * Gets all records (for persistence/testing). Records are immutable.
   */
  getAll(): readonly AuditRecord[] {
    return this.records;
  }
}
