/**
 * PlanningProjectionStore — Single source of truth for the Visual_Taskbar.
 *
 * Both the compact editor-adjacent bar and the expandable planning view
 * render from this store. It is a read-only projection that receives
 * versioned snapshots and ordered deltas from the main process.
 *
 * This store never owns business state. It is a projection of the
 * PlanningGraphService authority in the main process.
 *
 * Requirements: 10.1, 10.2, 10.6, 10.7, 10.12
 */

import type {
  TaskbarEntity,
  TaskbarTypedLink,
  ProjectionSnapshot,
  ProjectionDelta,
  EntityCounts,
  TaskbarEntityKind,
  TaskbarEntityStatus,
} from './types.js';

/** Listener callback type */
export type ProjectionChangeListener = () => void;

/**
 * PlanningProjectionStore is the single source of truth for both
 * Visual_Taskbar layouts. It receives versioned snapshots and ordered
 * deltas, stores entity counts and the full entity set, and never
 * owns business state (read-only projection).
 */
export class PlanningProjectionStore {
  private entities: Map<string, TaskbarEntity> = new Map();
  private links: Map<string, TaskbarTypedLink> = new Map();
  private currentVersion: number = 0;
  private workspaceId: string = '';
  private lastTimestamp: string = '';
  private listeners: Set<ProjectionChangeListener> = new Set();

  /** Current projection version */
  getVersion(): number {
    return this.currentVersion;
  }

  /** Current workspace ID */
  getWorkspaceId(): string {
    return this.workspaceId;
  }

  /** Last update timestamp */
  getLastTimestamp(): string {
    return this.lastTimestamp;
  }

  /**
   * Applies a full snapshot, replacing all current state.
   * Rejects snapshots with a version older than the current.
   */
  applySnapshot(snapshot: ProjectionSnapshot): boolean {
    if (snapshot.version < this.currentVersion) {
      return false; // Reject stale snapshot
    }

    this.entities.clear();
    this.links.clear();

    for (const entity of snapshot.entities) {
      this.entities.set(entity.id, entity);
    }
    for (const link of snapshot.links) {
      this.links.set(link.id, link);
    }

    this.currentVersion = snapshot.version;
    this.workspaceId = snapshot.workspaceId;
    this.lastTimestamp = snapshot.timestamp;
    this.notifyListeners();
    return true;
  }

  /**
   * Applies an ordered delta on top of the current version.
   * Rejects deltas whose baseVersion doesn't match the current version.
   */
  applyDelta(delta: ProjectionDelta): boolean {
    if (delta.baseVersion !== this.currentVersion) {
      return false; // Reject out-of-order delta
    }

    for (const op of delta.operations) {
      switch (op.type) {
        case 'add':
          this.entities.set(op.entity.id, op.entity);
          break;
        case 'update': {
          const existing = this.entities.get(op.entityId);
          if (existing) {
            this.entities.set(op.entityId, { ...existing, ...op.changes });
          }
          break;
        }
        case 'remove':
          this.entities.delete(op.entityId);
          break;
        case 'add_link':
          this.links.set(op.link.id, op.link);
          break;
        case 'remove_link':
          this.links.delete(op.linkId);
          break;
      }
    }

    this.currentVersion = delta.newVersion;
    this.lastTimestamp = delta.timestamp;
    this.notifyListeners();
    return true;
  }

  /** Get all entities */
  getAllEntities(): TaskbarEntity[] {
    return [...this.entities.values()];
  }

  /** Get entity by ID */
  getEntity(id: string): TaskbarEntity | undefined {
    return this.entities.get(id);
  }

  /** Get entities by kind */
  getEntitiesByKind(kind: TaskbarEntityKind): TaskbarEntity[] {
    return [...this.entities.values()].filter((e) => e.kind === kind);
  }

  /** Get entities by status */
  getEntitiesByStatus(status: TaskbarEntityStatus): TaskbarEntity[] {
    return [...this.entities.values()].filter((e) => e.status === status);
  }

  /** Get all typed links */
  getAllLinks(): TaskbarTypedLink[] {
    return [...this.links.values()];
  }

  /** Get links for a specific entity (as source or target) */
  getLinksForEntity(entityId: string): TaskbarTypedLink[] {
    return [...this.links.values()].filter(
      (l) => l.sourceEntityId === entityId || l.targetEntityId === entityId
    );
  }

  /** Get outgoing links from an entity */
  getOutgoingLinks(entityId: string): TaskbarTypedLink[] {
    return [...this.links.values()].filter((l) => l.sourceEntityId === entityId);
  }

  /** Get incoming links to an entity */
  getIncomingLinks(entityId: string): TaskbarTypedLink[] {
    return [...this.links.values()].filter((l) => l.targetEntityId === entityId);
  }

  /** Compute entity counts by kind */
  getEntityCounts(): EntityCounts {
    let requirements = 0;
    let designNodes = 0;
    let tasks = 0;
    let executions = 0;

    for (const entity of this.entities.values()) {
      switch (entity.kind) {
        case 'requirement':
          requirements++;
          break;
        case 'design_node':
          designNodes++;
          break;
        case 'task':
          tasks++;
          break;
        case 'execution':
          executions++;
          break;
      }
    }

    return { requirements, designNodes, tasks, executions };
  }

  /** Get total entity count */
  getEntityCount(): number {
    return this.entities.size;
  }

  /** Get total link count */
  getLinkCount(): number {
    return this.links.size;
  }

  /** Subscribe to projection changes */
  subscribe(listener: ProjectionChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
