/**
 * EntityDetailService — Resolves the full detail view for a selected entity.
 *
 * Reveals linked design, tasks, runs, Change_Sets, Evidence, rationale,
 * files, dependencies, scope, agent, permission, and status details.
 *
 * Requirements: 10.3, 10.4, 10.5
 */

import type { PlanningProjectionStore } from './planning-projection-store.js';
import type {
  TaskbarEntity,
  TaskbarTypedLink,
  DetailViewModel,
  LinkedReference,
  TaskbarEntityStatus,
} from './types.js';

/**
 * Derives a LinkedReference from an entity.
 */
function entityToRef(entity: TaskbarEntity): LinkedReference {
  return {
    id: entity.id,
    kind: entity.kind,
    title: entity.title,
    status: entity.status,
  };
}

/**
 * Derives a LinkedReference from a link target, resolving the entity if present.
 */
function linkToRef(
  link: TaskbarTypedLink,
  entityId: string,
  store: PlanningProjectionStore,
): LinkedReference {
  const entity = store.getEntity(entityId);
  if (entity) {
    return entityToRef(entity);
  }
  return {
    id: entityId,
    kind: link.targetEntityId === entityId ? link.targetKind : link.sourceKind,
    title: entityId,
  };
}

/**
 * EntityDetailService resolves the full detail view for any selected entity
 * in the Visual_Taskbar, including linked design, tasks, runs, Change_Sets,
 * Evidence, rationale, files, dependencies, scope, agent, permission, and status.
 */
export class EntityDetailService {
  private store: PlanningProjectionStore;

  constructor(store: PlanningProjectionStore) {
    this.store = store;
  }

  /**
   * Resolves the complete DetailViewModel for a given entity ID.
   * Returns null if the entity is not found in the projection.
   */
  getDetail(entityId: string): DetailViewModel | null {
    const entity = this.store.getEntity(entityId);
    if (!entity) {
      return null;
    }

    const allLinks = this.store.getLinksForEntity(entityId);

    const linkedDesign: LinkedReference[] = [];
    const linkedTasks: LinkedReference[] = [];
    const linkedRuns: LinkedReference[] = [];
    const linkedChangeSets: LinkedReference[] = [];
    const linkedEvidence: LinkedReference[] = [];
    const dependencies: LinkedReference[] = [];

    for (const link of allLinks) {
      const targetId = link.sourceEntityId === entityId
        ? link.targetEntityId
        : link.sourceEntityId;
      const ref = linkToRef(link, targetId, this.store);
      const targetEntity = this.store.getEntity(targetId);

      // Classify by relationship type
      switch (link.relationship) {
        case 'derived_from':
        case 'satisfies':
          if (targetEntity?.kind === 'design_node' || ref.kind === 'design_node') {
            linkedDesign.push(ref);
          } else {
            linkedTasks.push(ref);
          }
          break;
        case 'implements':
          linkedTasks.push(ref);
          break;
        case 'depends_on':
          dependencies.push(ref);
          break;
        case 'traces_to':
          linkedRuns.push(ref);
          break;
        case 'produced_by':
          if (targetEntity?.kind === 'execution' || ref.kind === 'execution') {
            linkedRuns.push(ref);
          } else {
            linkedChangeSets.push(ref);
          }
          break;
        case 'verified_by':
          linkedEvidence.push(ref);
          break;
        default:
          // Generic link - classify by target kind
          if (targetEntity) {
            switch (targetEntity.kind) {
              case 'design_node':
                linkedDesign.push(ref);
                break;
              case 'task':
                linkedTasks.push(ref);
                break;
              case 'execution':
                linkedRuns.push(ref);
                break;
              default:
                linkedTasks.push(ref);
            }
          }
      }
    }

    // Resolve agent reference
    const agentRef: LinkedReference | null = entity.agent
      ? { id: entity.agent, kind: 'agent', title: entity.agent }
      : null;

    // Derive files from entity and linked entities
    const files: string[] = [];
    if (entity.file) {
      files.push(entity.file);
    }
    // Gather files from linked task/design entities
    for (const link of allLinks) {
      const targetId = link.sourceEntityId === entityId
        ? link.targetEntityId
        : link.sourceEntityId;
      const targetEntity = this.store.getEntity(targetId);
      if (targetEntity?.file && !files.includes(targetEntity.file)) {
        files.push(targetEntity.file);
      }
    }

    return {
      entity,
      linkedDesign,
      linkedTasks,
      linkedRuns,
      linkedChangeSets,
      linkedEvidence,
      rationale: null, // Rationale is stored in Design_Node prose; null for projection
      files,
      dependencies,
      scope: { inclusions: [], exclusions: [] },
      agent: agentRef,
      permissions: [],
      status: entity.status as TaskbarEntityStatus,
    };
  }
}
