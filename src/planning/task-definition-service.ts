/**
 * TaskDefinitionService — Validates task definitions for planning readiness.
 *
 * - Defines required and optional task fields
 * - Validates task completeness for readiness evaluation
 * - Ensures templates cannot bypass the same readiness checks
 *
 * Requirements: 11.4, 11.5, 11.7, 12.1, 12.2, 12.3, 12.4, 12.7
 */

import type { TaskStatus } from './types.js';

/** Risk level for a task */
export type TaskRisk = 'critical' | 'high' | 'medium' | 'low';

/** Priority level for a task */
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

/** Linked clause: either a requirement link or maintenance rationale */
export type LinkedClause =
  | { kind: 'requirement'; requirementId: string }
  | { kind: 'maintenance'; rationale: string; approvedBy: string };

/** Dependency reference to another task */
export interface TaskDependency {
  taskId: string;
  relationship: 'blocks' | 'requires';
}

/** Scope boundary for a task */
export interface ScopeBoundary {
  includedPaths: string[];
  excludedPaths: string[];
  description: string;
}

/** Expected component involved in the task */
export interface ExpectedComponent {
  name: string;
  role: string;
}

/** Validation strategy for verifying task completion */
export interface ValidationStrategy {
  commands: string[];
  expectedOutcome: string;
  timeout?: number;
}

/** Optional execution preferences */
export interface ExecutionPreferences {
  agentPreference?: string;
  budgetLimit?: number;
  timeoutSeconds?: number;
  worktreeRequired?: boolean;
}

/** Full task definition with all required and optional fields */
export interface TaskDefinition {
  id: string;
  workspaceId: string;
  objective: string;
  linkedClauses: LinkedClause[];
  acceptanceCriteria: string[];
  dependencies: TaskDependency[];
  scopeBoundaries: ScopeBoundary;
  expectedComponents: ExpectedComponent[];
  validationStrategy: ValidationStrategy;
  risk: TaskRisk;
  priority: TaskPriority;
  status: TaskStatus;
  // Optional fields
  executionPreferences?: ExecutionPreferences;
  templateId?: string;
}

/** Result of validating a task definition for completeness */
export interface TaskValidationResult {
  valid: boolean;
  missingFields: string[];
  diagnostics: TaskDiagnostic[];
}

/** A single diagnostic about a task's readiness */
export interface TaskDiagnostic {
  field: string;
  severity: 'error' | 'warning';
  message: string;
  remediation: string;
}

/**
 * TaskDefinitionService validates task definitions against the required schema.
 *
 * All tasks — whether created directly or from templates — go through the same
 * validation. Templates cannot bypass readiness checks.
 */
export class TaskDefinitionService {
  /**
   * Validates a task definition for field completeness.
   * Returns a detailed validation result with missing fields and diagnostics.
   */
  validateCompleteness(task: Partial<TaskDefinition>): TaskValidationResult {
    const missingFields: string[] = [];
    const diagnostics: TaskDiagnostic[] = [];

    // Check required fields
    if (!task.id) {
      missingFields.push('id');
      diagnostics.push({
        field: 'id',
        severity: 'error',
        message: 'Task must have a stable identifier',
        remediation: 'Assign a unique task ID',
      });
    }

    if (!task.workspaceId) {
      missingFields.push('workspaceId');
      diagnostics.push({
        field: 'workspaceId',
        severity: 'error',
        message: 'Task must be associated with a workspace',
        remediation: 'Assign the task to a workspace',
      });
    }

    if (!task.objective || task.objective.trim().length === 0) {
      missingFields.push('objective');
      diagnostics.push({
        field: 'objective',
        severity: 'error',
        message: 'Task must have a clear objective',
        remediation: 'Add a description of what this task should accomplish',
      });
    }

    if (!task.linkedClauses || task.linkedClauses.length === 0) {
      missingFields.push('linkedClauses');
      diagnostics.push({
        field: 'linkedClauses',
        severity: 'error',
        message: 'Task must link to at least one requirement or have an approved maintenance rationale',
        remediation: 'Add a requirement link or maintenance rationale with approval',
      });
    }

    if (!task.acceptanceCriteria || task.acceptanceCriteria.length === 0) {
      missingFields.push('acceptanceCriteria');
      diagnostics.push({
        field: 'acceptanceCriteria',
        severity: 'error',
        message: 'Task must have at least one acceptance criterion',
        remediation: 'Define acceptance criteria that describe when the task is done',
      });
    }

    // Dependencies can be empty but must be defined
    if (task.dependencies === undefined) {
      missingFields.push('dependencies');
      diagnostics.push({
        field: 'dependencies',
        severity: 'error',
        message: 'Task must declare its dependencies (even if empty)',
        remediation: 'Add a dependencies array (use [] if no dependencies)',
      });
    }

    if (!task.scopeBoundaries) {
      missingFields.push('scopeBoundaries');
      diagnostics.push({
        field: 'scopeBoundaries',
        severity: 'error',
        message: 'Task must define its scope boundaries',
        remediation: 'Specify included and excluded paths and a description of scope',
      });
    }

    if (!task.expectedComponents || task.expectedComponents.length === 0) {
      missingFields.push('expectedComponents');
      diagnostics.push({
        field: 'expectedComponents',
        severity: 'error',
        message: 'Task must list expected components involved',
        remediation: 'List the components this task will modify or create',
      });
    }

    if (!task.validationStrategy) {
      missingFields.push('validationStrategy');
      diagnostics.push({
        field: 'validationStrategy',
        severity: 'error',
        message: 'Task must have a validation strategy',
        remediation: 'Define commands and expected outcomes for verifying completion',
      });
    } else if (
      !task.validationStrategy.commands ||
      task.validationStrategy.commands.length === 0
    ) {
      missingFields.push('validationStrategy.commands');
      diagnostics.push({
        field: 'validationStrategy.commands',
        severity: 'error',
        message: 'Validation strategy must have at least one command',
        remediation: 'Add at least one validation command (e.g., test runner)',
      });
    }

    if (!task.risk) {
      missingFields.push('risk');
      diagnostics.push({
        field: 'risk',
        severity: 'error',
        message: 'Task must have a risk assessment',
        remediation: 'Set risk to critical, high, medium, or low',
      });
    }

    if (!task.priority) {
      missingFields.push('priority');
      diagnostics.push({
        field: 'priority',
        severity: 'error',
        message: 'Task must have a priority',
        remediation: 'Set priority to critical, high, medium, or low',
      });
    }

    return {
      valid: missingFields.length === 0,
      missingFields,
      diagnostics,
    };
  }

  /**
   * Validates that linked clauses are well-formed.
   * At least one requirement link or an approved maintenance rationale is needed.
   */
  validateLinkedClauses(clauses: LinkedClause[]): TaskDiagnostic[] {
    const diagnostics: TaskDiagnostic[] = [];

    if (clauses.length === 0) {
      diagnostics.push({
        field: 'linkedClauses',
        severity: 'error',
        message: 'At least one linked clause is required',
        remediation: 'Link to a requirement or provide an approved maintenance rationale',
      });
      return diagnostics;
    }

    for (const clause of clauses) {
      if (clause.kind === 'requirement' && !clause.requirementId) {
        diagnostics.push({
          field: 'linkedClauses',
          severity: 'error',
          message: 'Requirement link is missing the requirement ID',
          remediation: 'Specify which requirement this task satisfies',
        });
      }
      if (clause.kind === 'maintenance') {
        if (!clause.rationale || clause.rationale.trim().length === 0) {
          diagnostics.push({
            field: 'linkedClauses',
            severity: 'error',
            message: 'Maintenance rationale must have an explanation',
            remediation: 'Provide a reason for this maintenance task',
          });
        }
        if (!clause.approvedBy || clause.approvedBy.trim().length === 0) {
          diagnostics.push({
            field: 'linkedClauses',
            severity: 'error',
            message: 'Maintenance rationale must be approved by someone',
            remediation: 'Record who approved this maintenance work',
          });
        }
      }
    }

    return diagnostics;
  }

  /**
   * Creates a task from a template, applying the same validation.
   * Templates cannot bypass readiness checks.
   */
  createFromTemplate(
    template: Partial<TaskDefinition>,
    overrides: Partial<TaskDefinition>
  ): { task: Partial<TaskDefinition>; validation: TaskValidationResult } {
    const merged: Partial<TaskDefinition> = { ...template, ...overrides };
    const validation = this.validateCompleteness(merged);
    return { task: merged, validation };
  }
}
