/**
 * IntegrityWarningService — Detects integrity issues in the planning projection.
 *
 * Highlights:
 * - Orphan requirements (no implementing task link)
 * - Unimplemented design nodes (no task link)
 * - Incomplete tasks (missing required fields or evidence)
 * - Unresolved dependencies
 * - Completed tasks lacking Evidence
 *
 * Requirement: 10.8
 */

import type { PlanningProjectionStore } from './planning-projection-store.js';
import type {
  TaskbarEntity,
  TaskbarTypedLink,
  IntegrityWarning,
  IntegrityWarningKind,
  WarningSeverity,
} from './types.js';

/**
 * IntegrityWarningService evaluates the planning projection for structural
 * and traceability issues and returns typed warnings with severity.
 */
export class IntegrityWarningService {
  private store: PlanningProjectionStore;

  constructor(store: PlanningProjectionStore) {
    this.store = store;
  }

  /**
   * Compute all integrity warnings for the current projection state.
   */
  getWarnings(): IntegrityWarning[] {
    const warnings: IntegrityWarning[] = [];

    warnings.push(...this.detectOrphanRequirements());
    warnings.push(...this.detectUnimplementedDesignNodes());
    warnings.push(...this.detectIncompleteTasks());
    warnings.push(...this.detectUnresolvedDependencies());
    warnings.push(...this.detectCompletedTasksLackingEvidence());

    return warnings;
  }

  /**
   * Detect requirements that have no implementing task link.
   */
  detectOrphanRequirements(): IntegrityWarning[] {
    const warnings: IntegrityWarning[] = [];
    const requirements = this.store.getEntitiesByKind('requirement');
    const allLinks = this.store.getAllLinks();

    for (const req of requirements) {
      const hasImplementingLink = allLinks.some(
        (link) =>
          (link.sourceEntityId === req.id || link.targetEntityId === req.id) &&
          (link.relationship === 'satisfies' ||
            link.relationship === 'implements' ||
            link.relationship === 'derived_from'),
      );

      if (!hasImplementingLink) {
        warnings.push({
          kind: 'orphan_requirement',
          severity: 'warning',
          entityId: req.id,
          entityKind: 'requirement',
          message: `Requirement "${req.title}" has no implementing task or design link`,
        });
      }
    }

    return warnings;
  }

  /**
   * Detect design nodes that have no linked task.
   */
  detectUnimplementedDesignNodes(): IntegrityWarning[] {
    const warnings: IntegrityWarning[] = [];
    const designNodes = this.store.getEntitiesByKind('design_node');
    const allLinks = this.store.getAllLinks();

    for (const node of designNodes) {
      const hasTaskLink = allLinks.some(
        (link) =>
          (link.sourceEntityId === node.id || link.targetEntityId === node.id) &&
          (link.relationship === 'implements' ||
            link.relationship === 'satisfies' ||
            link.relationship === 'derived_from') &&
          (link.sourceKind === 'task' || link.targetKind === 'task'),
      );

      if (!hasTaskLink) {
        warnings.push({
          kind: 'unimplemented_design_node',
          severity: 'warning',
          entityId: node.id,
          entityKind: 'design_node',
          message: `Design node "${node.title}" has no implementing task`,
        });
      }
    }

    return warnings;
  }

  /**
   * Detect tasks that are missing required fields (acceptance criteria via links)
   * or have incomplete status indicators.
   */
  detectIncompleteTasks(): IntegrityWarning[] {
    const warnings: IntegrityWarning[] = [];
    const tasks = this.store.getEntitiesByKind('task');
    const allLinks = this.store.getAllLinks();

    for (const task of tasks) {
      // A task needs at least one requirement link or other justification
      const hasRequirementLink = allLinks.some(
        (link) =>
          (link.sourceEntityId === task.id || link.targetEntityId === task.id) &&
          (link.relationship === 'satisfies' || link.relationship === 'implements'),
      );

      if (!hasRequirementLink && task.status !== 'completed' && task.status !== 'cancelled') {
        warnings.push({
          kind: 'incomplete_task',
          severity: 'info',
          entityId: task.id,
          entityKind: 'task',
          message: `Task "${task.title}" has no linked requirement`,
        });
      }
    }

    return warnings;
  }

  /**
   * Detect tasks with unresolved dependencies (depends_on links to
   * entities that are not completed).
   */
  detectUnresolvedDependencies(): IntegrityWarning[] {
    const warnings: IntegrityWarning[] = [];
    const tasks = this.store.getEntitiesByKind('task');
    const allLinks = this.store.getAllLinks();

    for (const task of tasks) {
      if (task.status === 'completed' || task.status === 'cancelled') {
        continue;
      }

      const dependsOnLinks = allLinks.filter(
        (link) =>
          link.sourceEntityId === task.id && link.relationship === 'depends_on',
      );

      for (const dep of dependsOnLinks) {
        const target = this.store.getEntity(dep.targetEntityId);
        if (target && target.status !== 'completed') {
          warnings.push({
            kind: 'unresolved_dependency',
            severity: 'warning',
            entityId: task.id,
            entityKind: 'task',
            message: `Task "${task.title}" depends on incomplete "${target.title}"`,
          });
        }
      }
    }

    return warnings;
  }

  /**
   * Detect completed tasks that have no linked Evidence (verified_by link).
   */
  detectCompletedTasksLackingEvidence(): IntegrityWarning[] {
    const warnings: IntegrityWarning[] = [];
    const tasks = this.store.getEntitiesByKind('task');
    const allLinks = this.store.getAllLinks();

    for (const task of tasks) {
      if (task.status !== 'completed') {
        continue;
      }

      const hasEvidence = allLinks.some(
        (link) =>
          (link.sourceEntityId === task.id || link.targetEntityId === task.id) &&
          link.relationship === 'verified_by',
      );

      if (!hasEvidence) {
        warnings.push({
          kind: 'completed_task_lacking_evidence',
          severity: 'error',
          entityId: task.id,
          entityKind: 'task',
          message: `Completed task "${task.title}" has no linked Evidence`,
        });
      }
    }

    return warnings;
  }
}
