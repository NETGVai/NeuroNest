/**
 * TombstoneManager — Preserves history of renamed/imported entities.
 *
 * - Never silently deletes — always creates a tombstone record
 * - Supports rebuild of projections from authoritative inputs deterministically
 * - Tracks original ID, new ID, reason, timestamp
 *
 * Requirements: 11.1, 11.3, 11.8, 11.10
 */

import { createHash, randomUUID } from 'node:crypto';
import type { TombstoneRecord } from './types.js';

export type TombstoneReason = 'renamed' | 'imported' | 'deleted' | 'merged' | 'superseded';

/**
 * TombstoneManager tracks entity lifecycle transitions without silent deletion.
 *
 * When an entity is renamed, deleted, merged, or superseded, a tombstone
 * record preserves the historical reference so that projections can be
 * rebuilt deterministically from authoritative inputs.
 */
export class TombstoneManager {
  private tombstones: Map<string, TombstoneRecord> = new Map();

  /**
   * Creates a tombstone for an entity that has been renamed.
   * The original ID is preserved, pointing to the new ID.
   */
  recordRename(originalId: string, newId: string, metadata?: Record<string, unknown>): TombstoneRecord {
    return this.createTombstone(originalId, newId, 'renamed', metadata);
  }

  /**
   * Creates a tombstone for an entity that has been imported under a new identity.
   */
  recordImport(originalId: string, newId: string, metadata?: Record<string, unknown>): TombstoneRecord {
    return this.createTombstone(originalId, newId, 'imported', metadata);
  }

  /**
   * Creates a tombstone for a deleted entity.
   * The entity is marked deleted but never silently removed.
   */
  recordDeletion(entityId: string, metadata?: Record<string, unknown>): TombstoneRecord {
    return this.createTombstone(entityId, null, 'deleted', metadata);
  }

  /**
   * Creates a tombstone for an entity merged into another.
   */
  recordMerge(originalId: string, targetId: string, metadata?: Record<string, unknown>): TombstoneRecord {
    return this.createTombstone(originalId, targetId, 'merged', metadata);
  }

  /**
   * Creates a tombstone for an entity superseded by a newer version.
   */
  recordSupersession(originalId: string, newId: string, metadata?: Record<string, unknown>): TombstoneRecord {
    return this.createTombstone(originalId, newId, 'superseded', metadata);
  }

  /**
   * Resolves the current effective ID for an entity, following the tombstone chain.
   * Returns null if the entity was deleted with no successor.
   */
  resolveCurrentId(originalId: string): string | null {
    let currentId: string | null = originalId;
    const visited = new Set<string>();

    while (currentId) {
      if (visited.has(currentId)) {
        // Cycle detected — return current position
        return currentId;
      }
      visited.add(currentId);

      const tombstone = this.tombstones.get(currentId);
      if (!tombstone) {
        // No tombstone means the ID is still live
        return currentId;
      }
      if (tombstone.reason === 'deleted' && !tombstone.newEntityId) {
        return null;
      }
      currentId = tombstone.newEntityId;
    }

    return null;
  }

  /**
   * Returns the full history chain for an entity ID.
   */
  getHistory(entityId: string): TombstoneRecord[] {
    const history: TombstoneRecord[] = [];
    let currentId: string | null = entityId;
    const visited = new Set<string>();

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const tombstone = this.tombstones.get(currentId);
      if (tombstone) {
        history.push(tombstone);
        currentId = tombstone.newEntityId;
      } else {
        break;
      }
    }

    return history;
  }

  /**
   * Returns all tombstone records (for deterministic projection rebuild).
   */
  getAll(): TombstoneRecord[] {
    return [...this.tombstones.values()];
  }

  /**
   * Returns a tombstone by the original entity ID.
   */
  get(originalEntityId: string): TombstoneRecord | undefined {
    return this.tombstones.get(originalEntityId);
  }

  /**
   * Checks if an entity has been tombstoned (renamed, deleted, etc.)
   */
  isTombstoned(entityId: string): boolean {
    return this.tombstones.has(entityId);
  }

  /**
   * Returns the count of tombstone records.
   */
  get size(): number {
    return this.tombstones.size;
  }

  /**
   * Loads tombstones from a serialized array (for deterministic rebuild from authority).
   */
  loadFrom(records: TombstoneRecord[]): void {
    this.tombstones.clear();
    for (const record of records) {
      this.tombstones.set(record.originalEntityId, record);
    }
  }

  /**
   * Serializes all tombstones for persistence.
   * Deterministic ordering by createdAt then by id.
   */
  serialize(): TombstoneRecord[] {
    return [...this.tombstones.values()].sort((a, b) => {
      const timeDiff = a.createdAt.localeCompare(b.createdAt);
      if (timeDiff !== 0) return timeDiff;
      return a.id.localeCompare(b.id);
    });
  }

  private createTombstone(
    originalEntityId: string,
    newEntityId: string | null,
    reason: TombstoneReason,
    metadata?: Record<string, unknown>
  ): TombstoneRecord {
    const record: TombstoneRecord = {
      id: randomUUID(),
      entityType: 'planning_entity',
      originalEntityId,
      newEntityId,
      reason,
      metadata: metadata ?? {},
      createdAt: new Date().toISOString(),
    };

    this.tombstones.set(originalEntityId, record);
    return record;
  }
}

/**
 * Computes a deterministic fingerprint for a tombstone record set.
 * Used to verify projection rebuild consistency.
 */
export function computeTombstoneSetFingerprint(records: TombstoneRecord[]): string {
  const sorted = [...records].sort((a, b) => a.originalEntityId.localeCompare(b.originalEntityId));
  const content = sorted.map((r) => `${r.originalEntityId}:${r.newEntityId ?? 'null'}:${r.reason}`).join('|');
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}
