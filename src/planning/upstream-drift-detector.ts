/**
 * UpstreamDriftDetector — Monitors linked requirements/design for content changes.
 *
 * When upstream content changes (requirements or design nodes), marks affected
 * ready Tasks as `needs_review` and shows the exact upstream delta.
 *
 * Works with PlanningIndexProjection to detect content fingerprint changes.
 *
 * Requirements: 12.5, 12.6
 */

import type { PlanningEntity, PlanningTask, TaskStatus } from './types.js';
import type { TraceLink } from './trace-link-service.js';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** Describes a change in upstream content */
export interface UpstreamDelta {
  entityId: string;
  entityTitle: string | null;
  previousFingerprint: string;
  currentFingerprint: string;
  changeKind: 'content_modified' | 'entity_removed' | 'entity_added';
  description: string;
}

/** A task affected by upstream drift */
export interface AffectedTask {
  taskId: string;
  taskTitle: string;
  previousStatus: TaskStatus;
  newStatus: 'needs_review';
  upstreamDeltas: UpstreamDelta[];
  linkIds: string[];
}

/** Result of a drift detection scan */
export interface DriftDetectionResult {
  affectedTasks: AffectedTask[];
  totalDeltas: number;
  scanTimestamp: string;
}

/** Interface for querying planning entities with fingerprints */
export interface EntityFingerprintProvider {
  getEntity(entityId: string): PlanningEntity | undefined;
  getCurrentFingerprint(entityId: string): string | null;
}

/** Interface for querying tasks */
export interface TaskProvider {
  getTask(taskId: string): PlanningTask | undefined;
  getTasksByStatus(status: TaskStatus): PlanningTask[];
  updateTaskStatus(taskId: string, status: TaskStatus): void;
}

/** Interface for querying trace links */
export interface TraceLinkProvider {
  getLinksTo(targetEntityId: string): TraceLink[];
  getLinksFrom(sourceEntityId: string): TraceLink[];
  getAllLinks(): TraceLink[];
}

// ═══════════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════════

/**
 * UpstreamDriftDetector monitors linked requirements and design nodes for
 * content changes and marks affected ready tasks as `needs_review`.
 *
 * The detector compares stored fingerprints against current content fingerprints
 * to identify when upstream content has drifted. Affected tasks receive the
 * exact upstream delta showing what changed and where.
 */
export class UpstreamDriftDetector {
  private entityProvider: EntityFingerprintProvider;
  private taskProvider: TaskProvider;
  private linkProvider: TraceLinkProvider;
  private storedFingerprints: Map<string, string> = new Map();
  private driftHistory: DriftDetectionResult[] = [];

  constructor(
    entityProvider: EntityFingerprintProvider,
    taskProvider: TaskProvider,
    linkProvider: TraceLinkProvider
  ) {
    this.entityProvider = entityProvider;
    this.taskProvider = taskProvider;
    this.linkProvider = linkProvider;
  }

  /**
   * Stores the current fingerprints for all tracked entities.
   * Call this after a successful index rebuild to establish a baseline.
   */
  snapshotFingerprints(entities: Array<{ id: string; fingerprint: string }>): void {
    for (const entity of entities) {
      this.storedFingerprints.set(entity.id, entity.fingerprint);
    }
  }

  /**
   * Updates the stored fingerprint for a specific entity.
   */
  updateFingerprint(entityId: string, fingerprint: string): void {
    this.storedFingerprints.set(entityId, fingerprint);
  }

  /**
   * Detects upstream drift by comparing stored fingerprints against current content.
   * Marks affected ready tasks as `needs_review` and returns the exact deltas.
   */
  detectDrift(): DriftDetectionResult {
    const deltas: UpstreamDelta[] = [];
    const affectedTaskMap = new Map<string, AffectedTask>();

    // Check each stored entity for fingerprint drift
    for (const [entityId, storedFingerprint] of this.storedFingerprints) {
      const currentFingerprint = this.entityProvider.getCurrentFingerprint(entityId);
      const entity = this.entityProvider.getEntity(entityId);

      if (currentFingerprint === null) {
        // Entity was removed
        const delta: UpstreamDelta = {
          entityId,
          entityTitle: entity?.title ?? null,
          previousFingerprint: storedFingerprint,
          currentFingerprint: '',
          changeKind: 'entity_removed',
          description: `Entity "${entity?.title ?? entityId}" was removed from upstream source`,
        };
        deltas.push(delta);
        this.markAffectedTasks(entityId, delta, affectedTaskMap);
      } else if (currentFingerprint !== storedFingerprint) {
        // Content changed
        const delta: UpstreamDelta = {
          entityId,
          entityTitle: entity?.title ?? null,
          previousFingerprint: storedFingerprint,
          currentFingerprint,
          changeKind: 'content_modified',
          description: `Content of "${entity?.title ?? entityId}" changed (fingerprint: ${storedFingerprint.slice(0, 8)}... -> ${currentFingerprint.slice(0, 8)}...)`,
        };
        deltas.push(delta);
        this.markAffectedTasks(entityId, delta, affectedTaskMap);
      }
    }

    // Apply status changes
    for (const affected of affectedTaskMap.values()) {
      this.taskProvider.updateTaskStatus(affected.taskId, 'needs_review');
    }

    const result: DriftDetectionResult = {
      affectedTasks: [...affectedTaskMap.values()],
      totalDeltas: deltas.length,
      scanTimestamp: new Date().toISOString(),
    };

    this.driftHistory.push(result);
    return result;
  }

  /**
   * Detects drift for a specific set of entity IDs only.
   */
  detectDriftForEntities(entityIds: string[]): DriftDetectionResult {
    const deltas: UpstreamDelta[] = [];
    const affectedTaskMap = new Map<string, AffectedTask>();

    for (const entityId of entityIds) {
      const storedFingerprint = this.storedFingerprints.get(entityId);
      if (!storedFingerprint) continue;

      const currentFingerprint = this.entityProvider.getCurrentFingerprint(entityId);
      const entity = this.entityProvider.getEntity(entityId);

      if (currentFingerprint === null) {
        const delta: UpstreamDelta = {
          entityId,
          entityTitle: entity?.title ?? null,
          previousFingerprint: storedFingerprint,
          currentFingerprint: '',
          changeKind: 'entity_removed',
          description: `Entity "${entity?.title ?? entityId}" was removed`,
        };
        deltas.push(delta);
        this.markAffectedTasks(entityId, delta, affectedTaskMap);
      } else if (currentFingerprint !== storedFingerprint) {
        const delta: UpstreamDelta = {
          entityId,
          entityTitle: entity?.title ?? null,
          previousFingerprint: storedFingerprint,
          currentFingerprint,
          changeKind: 'content_modified',
          description: `Content of "${entity?.title ?? entityId}" was modified`,
        };
        deltas.push(delta);
        this.markAffectedTasks(entityId, delta, affectedTaskMap);
      }
    }

    // Apply status changes
    for (const affected of affectedTaskMap.values()) {
      this.taskProvider.updateTaskStatus(affected.taskId, 'needs_review');
    }

    const result: DriftDetectionResult = {
      affectedTasks: [...affectedTaskMap.values()],
      totalDeltas: deltas.length,
      scanTimestamp: new Date().toISOString(),
    };

    this.driftHistory.push(result);
    return result;
  }

  /**
   * Returns the history of drift detection scans.
   */
  getDriftHistory(): readonly DriftDetectionResult[] {
    return this.driftHistory;
  }

  /**
   * Returns the current stored fingerprint map (for inspection/testing).
   */
  getStoredFingerprints(): ReadonlyMap<string, string> {
    return this.storedFingerprints;
  }

  /**
   * Acknowledges drift for a task, resetting its review status.
   * Typically called after a user reviews the delta and confirms the task is still valid.
   */
  acknowledgeDrift(taskId: string, newStatus: TaskStatus): void {
    this.taskProvider.updateTaskStatus(taskId, newStatus);
  }

  // ─────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────

  private markAffectedTasks(
    entityId: string,
    delta: UpstreamDelta,
    affectedMap: Map<string, AffectedTask>
  ): void {
    // Find all tasks linked to this entity (as source or target)
    const linksTo = this.linkProvider.getLinksTo(entityId);
    const linksFrom = this.linkProvider.getLinksFrom(entityId);
    const relevantLinks = [...linksTo, ...linksFrom];

    for (const link of relevantLinks) {
      // Determine which end is the task
      const taskId = this.resolveTaskId(link, entityId);
      if (!taskId) continue;

      const task = this.taskProvider.getTask(taskId);
      if (!task) continue;

      // Only mark tasks that are currently in a ready-like state
      if (task.status !== 'ready' && task.status !== 'queued') continue;

      if (!affectedMap.has(taskId)) {
        affectedMap.set(taskId, {
          taskId,
          taskTitle: task.title,
          previousStatus: task.status,
          newStatus: 'needs_review',
          upstreamDeltas: [],
          linkIds: [],
        });
      }

      const affected = affectedMap.get(taskId)!;
      affected.upstreamDeltas.push(delta);
      affected.linkIds.push(link.id);
    }
  }

  private resolveTaskId(link: TraceLink, entityId: string): string | null {
    // The task is the other end of the link from the changed entity
    if (link.sourceEntityId === entityId) {
      // The target might be a task
      if (link.targetEntityType === 'task') {
        return link.targetEntityId;
      }
    }
    if (link.targetEntityId === entityId) {
      // The source might be a task
      if (link.sourceEntityType === 'task') {
        return link.sourceEntityId;
      }
    }
    return null;
  }
}
