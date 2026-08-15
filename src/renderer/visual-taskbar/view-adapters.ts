/**
 * View adapters for the Visual_Taskbar visualization modes.
 *
 * Each adapter reads from the shared PlanningProjectionStore and produces
 * a view model for its specific rendering mode. Adapters never own
 * business state — they are pure projections.
 *
 * Requirements: 10.1, 10.2, 10.6, 10.7, 10.12
 */

import type { PlanningProjectionStore } from './planning-projection-store.js';
import type {
  TaskbarEntity,
  TaskbarTypedLink,
  TaskbarFilter,
  TaskbarEntityStatus,
  TaskbarRiskLevel,
  CompactBarViewModel,
  ListViewItem,
  KanbanColumn,
  DependencyGraphNode,
} from './types.js';

/**
 * Filters entities based on the provided filter criteria.
 * Supports status, priority, kind, requirementId, component, workspaceId,
 * file, agent, run, risk, and milestone filters.
 *
 * Requirements: 10.11
 */
export function applyFilter(entities: TaskbarEntity[], filter: TaskbarFilter): TaskbarEntity[] {
  return entities.filter((entity) => {
    if (filter.status && filter.status.length > 0 && !filter.status.includes(entity.status)) {
      return false;
    }
    if (filter.priority && filter.priority.length > 0 && !filter.priority.includes(entity.priority)) {
      return false;
    }
    if (filter.kind && filter.kind.length > 0 && !filter.kind.includes(entity.kind)) {
      return false;
    }
    if (filter.requirementId && entity.requirementId !== filter.requirementId) {
      return false;
    }
    if (filter.component && entity.component !== filter.component) {
      return false;
    }
    if (filter.workspaceId && entity.workspaceId !== filter.workspaceId) {
      return false;
    }
    if (filter.file && entity.file !== filter.file) {
      return false;
    }
    if (filter.agent && entity.agent !== filter.agent) {
      return false;
    }
    if (filter.run && entity.runId !== filter.run) {
      return false;
    }
    if (filter.risk && filter.risk.length > 0 && (!entity.risk || !filter.risk.includes(entity.risk))) {
      return false;
    }
    if (filter.milestone && entity.milestone !== filter.milestone) {
      return false;
    }
    return true;
  });
}

/**
 * CompactBarViewAdapter — produces a minimal counts and status summary
 * for the editor-adjacent compact bar.
 */
export class CompactBarViewAdapter {
  private store: PlanningProjectionStore;

  constructor(store: PlanningProjectionStore) {
    this.store = store;
  }

  getViewModel(filter?: TaskbarFilter): CompactBarViewModel {
    let entities = this.store.getAllEntities();
    if (filter) {
      entities = applyFilter(entities, filter);
    }

    const counts = {
      requirements: 0,
      designNodes: 0,
      tasks: 0,
      executions: 0,
    };

    const statusSummary: Record<string, number> = {};
    let hasWarnings = false;

    for (const entity of entities) {
      switch (entity.kind) {
        case 'requirement':
          counts.requirements++;
          break;
        case 'design_node':
          counts.designNodes++;
          break;
        case 'task':
          counts.tasks++;
          break;
        case 'execution':
          counts.executions++;
          break;
      }

      statusSummary[entity.status] = (statusSummary[entity.status] || 0) + 1;

      if (
        entity.status === 'blocked' ||
        entity.status === 'failed' ||
        entity.status === 'needs_review' ||
        entity.status === 'uncovered'
      ) {
        hasWarnings = true;
      }
    }

    return {
      counts,
      statusSummary: statusSummary as Record<TaskbarEntityStatus, number>,
      hasWarnings,
    };
  }
}

/**
 * ListViewAdapter — produces a flat sorted list of entities with depth
 * information derived from parent relationships.
 */
export class ListViewAdapter {
  private store: PlanningProjectionStore;

  constructor(store: PlanningProjectionStore) {
    this.store = store;
  }

  getViewModel(filter?: TaskbarFilter): ListViewItem[] {
    let entities = this.store.getAllEntities();
    if (filter) {
      entities = applyFilter(entities, filter);
    }

    const entityIds = new Set(entities.map((e) => e.id));

    return entities.map((entity) => {
      const linkCount = this.store.getLinksForEntity(entity.id).length;
      const depth = this.computeDepth(entity, entityIds);
      return { entity, depth, linkCount };
    });
  }

  private computeDepth(entity: TaskbarEntity, entityIds: Set<string>): number {
    let depth = 0;
    let current: TaskbarEntity | undefined = entity;
    const visited = new Set<string>();

    while (current?.parentId && entityIds.has(current.parentId) && !visited.has(current.id)) {
      visited.add(current.id);
      depth++;
      current = this.store.getEntity(current.parentId);
    }

    return depth;
  }
}

/** Kanban column definitions by status */
const KANBAN_COLUMNS: { status: TaskbarEntityStatus; label: string }[] = [
  { status: 'draft', label: 'Draft' },
  { status: 'ready', label: 'Ready' },
  { status: 'queued', label: 'Queued' },
  { status: 'running', label: 'Running' },
  { status: 'completed', label: 'Completed' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'failed', label: 'Failed' },
  { status: 'needs_review', label: 'Needs Review' },
  { status: 'cancelled', label: 'Cancelled' },
  { status: 'covered', label: 'Covered' },
  { status: 'uncovered', label: 'Uncovered' },
  { status: 'partial', label: 'Partial' },
  { status: 'implemented', label: 'Implemented' },
  { status: 'unimplemented', label: 'Unimplemented' },
  { status: 'active', label: 'Active' },
];

/**
 * KanbanViewAdapter — groups entities by status into columns.
 */
export class KanbanViewAdapter {
  private store: PlanningProjectionStore;

  constructor(store: PlanningProjectionStore) {
    this.store = store;
  }

  getViewModel(filter?: TaskbarFilter): KanbanColumn[] {
    let entities = this.store.getAllEntities();
    if (filter) {
      entities = applyFilter(entities, filter);
    }

    // Group entities by status
    const grouped = new Map<TaskbarEntityStatus, TaskbarEntity[]>();
    for (const entity of entities) {
      const existing = grouped.get(entity.status) || [];
      existing.push(entity);
      grouped.set(entity.status, existing);
    }

    // Build columns for statuses that have entities
    const columns: KanbanColumn[] = [];
    for (const col of KANBAN_COLUMNS) {
      const colEntities = grouped.get(col.status);
      if (colEntities && colEntities.length > 0) {
        columns.push({
          status: col.status,
          label: col.label,
          entities: colEntities,
        });
      }
    }

    return columns;
  }
}

/**
 * DependencyGraphViewAdapter — produces entities with relationship edges
 * for graph visualization.
 */
export class DependencyGraphViewAdapter {
  private store: PlanningProjectionStore;

  constructor(store: PlanningProjectionStore) {
    this.store = store;
  }

  getViewModel(filter?: TaskbarFilter): DependencyGraphNode[] {
    let entities = this.store.getAllEntities();
    if (filter) {
      entities = applyFilter(entities, filter);
    }

    const entityIds = new Set(entities.map((e) => e.id));
    const allLinks = this.store.getAllLinks();

    return entities.map((entity) => {
      // Only include links where both endpoints are in the filtered set
      const incomingEdges = allLinks.filter(
        (l) => l.targetEntityId === entity.id && entityIds.has(l.sourceEntityId)
      );
      const outgoingEdges = allLinks.filter(
        (l) => l.sourceEntityId === entity.id && entityIds.has(l.targetEntityId)
      );

      return { entity, incomingEdges, outgoingEdges };
    });
  }

  /** Get all edges between entities in the filtered set */
  getEdges(filter?: TaskbarFilter): TaskbarTypedLink[] {
    let entities = this.store.getAllEntities();
    if (filter) {
      entities = applyFilter(entities, filter);
    }

    const entityIds = new Set(entities.map((e) => e.id));
    return this.store.getAllLinks().filter(
      (l) => entityIds.has(l.sourceEntityId) && entityIds.has(l.targetEntityId)
    );
  }
}
