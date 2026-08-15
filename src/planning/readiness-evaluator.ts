/**
 * ReadinessEvaluator — Evaluates task readiness and completion conditions.
 *
 * Readiness evaluates:
 * - Missing required fields
 * - Dependency completion (all deps must be completed)
 * - Dependency cycle detection (DAG validation)
 * - Requirement link or approved maintenance rationale
 * - Agent/skill availability
 * - Permission checks
 * - Budget sufficiency
 *
 * Permits `ready` only when ALL conditions pass.
 * Permits `completed` only with passing Evidence or recorded waiver.
 *
 * Requirements: 11.4, 11.5, 11.7, 12.1, 12.2, 12.3, 12.4, 12.7
 */

import { DependencyCycleDetector, type DependencyNode } from './dependency-cycle-detector.js';
import {
  TaskDefinitionService,
  type TaskDefinition,
  type TaskDiagnostic,
} from './task-definition-service.js';
import type { TaskStatus } from './types.js';

/** Status of a dependency task */
export interface DependencyStatus {
  taskId: string;
  status: TaskStatus;
}

/** Agent availability information */
export interface AgentAvailability {
  agentId: string;
  available: boolean;
  reason?: string;
}

/** Skill availability information */
export interface SkillAvailability {
  skillId: string;
  available: boolean;
  reason?: string;
}

/** Permission check result */
export interface PermissionCheck {
  permission: string;
  granted: boolean;
  reason?: string;
}

/** Budget check result */
export interface BudgetCheck {
  budgetAvailable: number;
  budgetRequired: number;
  sufficient: boolean;
}

/** Evidence for task completion */
export interface CompletionEvidence {
  evidenceId: string;
  outcome: 'pass' | 'fail' | 'waived';
  actor?: string;
  reason?: string;
}

/** Full readiness context for evaluation */
export interface ReadinessContext {
  task: Partial<TaskDefinition>;
  dependencyStatuses: DependencyStatus[];
  allDependencyNodes: DependencyNode[];
  agentAvailability?: AgentAvailability;
  skillAvailability?: SkillAvailability[];
  permissions?: PermissionCheck[];
  budget?: BudgetCheck;
}

/** Completion context for evaluating if a task can be marked completed */
export interface CompletionContext {
  task: Partial<TaskDefinition>;
  evidence: CompletionEvidence | null;
}

/** Individual readiness condition check */
export interface ReadinessCondition {
  name: string;
  passed: boolean;
  diagnostics: TaskDiagnostic[];
}

/** Full readiness evaluation report */
export interface ReadinessReport {
  taskId: string;
  isReady: boolean;
  conditions: ReadinessCondition[];
  summary: string;
}

/** Completion evaluation report */
export interface CompletionReport {
  taskId: string;
  canComplete: boolean;
  reason: string;
  diagnostics: TaskDiagnostic[];
}

/**
 * ReadinessEvaluator evaluates whether a task can transition to `ready` or `completed`.
 *
 * - `ready`: ALL readiness conditions must pass
 * - `completed`: requires passing Evidence or a recorded waiver
 */
export class ReadinessEvaluator {
  private definitionService: TaskDefinitionService;
  private cycleDetector: DependencyCycleDetector;

  constructor() {
    this.definitionService = new TaskDefinitionService();
    this.cycleDetector = new DependencyCycleDetector();
  }

  /**
   * Evaluates all readiness conditions for a task.
   * Returns a detailed report with conditions, diagnostics, and remediation.
   */
  evaluateReadiness(context: ReadinessContext): ReadinessReport {
    const conditions: ReadinessCondition[] = [];

    // 1. Validate required fields
    conditions.push(this.checkRequiredFields(context.task));

    // 2. Validate linked clauses (requirement link or maintenance rationale)
    conditions.push(this.checkLinkedClauses(context.task));

    // 3. Check dependency completion
    conditions.push(this.checkDependencyCompletion(context));

    // 4. Check for dependency cycles
    conditions.push(this.checkDependencyCycles(context));

    // 5. Check agent availability
    if (context.agentAvailability !== undefined) {
      conditions.push(this.checkAgentAvailability(context.agentAvailability));
    }

    // 6. Check skill availability
    if (context.skillAvailability !== undefined) {
      conditions.push(this.checkSkillAvailability(context.skillAvailability));
    }

    // 7. Check permissions
    if (context.permissions !== undefined) {
      conditions.push(this.checkPermissions(context.permissions));
    }

    // 8. Check budget
    if (context.budget !== undefined) {
      conditions.push(this.checkBudget(context.budget));
    }

    const isReady = conditions.every((c) => c.passed);
    const failedConditions = conditions.filter((c) => !c.passed);

    let summary: string;
    if (isReady) {
      summary = 'Task is ready for dispatch';
    } else {
      const failureNames = failedConditions.map((c) => c.name).join(', ');
      summary = `Task is not ready: failed conditions: ${failureNames}`;
    }

    return {
      taskId: context.task.id ?? 'unknown',
      isReady,
      conditions,
      summary,
    };
  }

  /**
   * Evaluates whether a task can transition to `completed`.
   * Requires passing Evidence or a recorded waiver.
   */
  evaluateCompletion(context: CompletionContext): CompletionReport {
    const diagnostics: TaskDiagnostic[] = [];
    const taskId = context.task.id ?? 'unknown';

    if (!context.evidence) {
      diagnostics.push({
        field: 'evidence',
        severity: 'error',
        message: 'Task completion requires passing evidence or a recorded waiver',
        remediation: 'Run validation and record evidence, or obtain a waiver with actor and reason',
      });
      return {
        taskId,
        canComplete: false,
        reason: 'No evidence or waiver provided',
        diagnostics,
      };
    }

    if (context.evidence.outcome === 'fail') {
      diagnostics.push({
        field: 'evidence',
        severity: 'error',
        message: 'Evidence indicates failure — task cannot be marked completed',
        remediation: 'Fix the failing validation and re-run, or obtain a waiver',
      });
      return {
        taskId,
        canComplete: false,
        reason: 'Evidence outcome is fail',
        diagnostics,
      };
    }

    if (context.evidence.outcome === 'waived') {
      if (!context.evidence.actor || !context.evidence.reason) {
        diagnostics.push({
          field: 'evidence',
          severity: 'error',
          message: 'A waiver must include an actor and a reason',
          remediation: 'Record who approved the waiver and why',
        });
        return {
          taskId,
          canComplete: false,
          reason: 'Waiver missing required actor or reason',
          diagnostics,
        };
      }
    }

    return {
      taskId,
      canComplete: true,
      reason:
        context.evidence.outcome === 'pass'
          ? 'Passing evidence recorded'
          : `Waiver approved by ${context.evidence.actor}`,
      diagnostics,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // Private condition checks
  // ═══════════════════════════════════════════════════════════════

  private checkRequiredFields(task: Partial<TaskDefinition>): ReadinessCondition {
    const validation = this.definitionService.validateCompleteness(task);
    return {
      name: 'required_fields',
      passed: validation.valid,
      diagnostics: validation.diagnostics,
    };
  }

  private checkLinkedClauses(task: Partial<TaskDefinition>): ReadinessCondition {
    if (!task.linkedClauses || task.linkedClauses.length === 0) {
      return {
        name: 'linked_clauses',
        passed: false,
        diagnostics: [
          {
            field: 'linkedClauses',
            severity: 'error',
            message: 'Task must have a requirement link or approved maintenance rationale',
            remediation: 'Link this task to a requirement or provide a maintenance rationale with approval',
          },
        ],
      };
    }

    const diagnostics = this.definitionService.validateLinkedClauses(task.linkedClauses);
    return {
      name: 'linked_clauses',
      passed: diagnostics.length === 0,
      diagnostics,
    };
  }

  private checkDependencyCompletion(context: ReadinessContext): ReadinessCondition {
    const diagnostics: TaskDiagnostic[] = [];
    const taskDeps = context.task.dependencies ?? [];

    for (const dep of taskDeps) {
      const status = context.dependencyStatuses.find((s) => s.taskId === dep.taskId);
      if (!status) {
        diagnostics.push({
          field: 'dependencies',
          severity: 'error',
          message: `Dependency "${dep.taskId}" status is unknown`,
          remediation: `Verify that task "${dep.taskId}" exists and check its status`,
        });
      } else if (status.status !== 'completed') {
        diagnostics.push({
          field: 'dependencies',
          severity: 'error',
          message: `Dependency "${dep.taskId}" is not completed (current: ${status.status})`,
          remediation: `Complete task "${dep.taskId}" before marking this task as ready`,
        });
      }
    }

    return {
      name: 'dependency_completion',
      passed: diagnostics.length === 0,
      diagnostics,
    };
  }

  private checkDependencyCycles(context: ReadinessContext): ReadinessCondition {
    const result = this.cycleDetector.detect(context.allDependencyNodes);
    const diagnostics: TaskDiagnostic[] = [];

    if (!result.isAcyclic) {
      for (const cycle of result.cycles) {
        diagnostics.push({
          field: 'dependencies',
          severity: 'error',
          message: `Dependency cycle detected: ${cycle.path.join(' → ')}`,
          remediation: cycle.remediationSuggestions[0]?.reason ?? 'Remove a dependency to break the cycle',
        });
      }
    }

    return {
      name: 'dependency_cycles',
      passed: result.isAcyclic,
      diagnostics,
    };
  }

  private checkAgentAvailability(agent: AgentAvailability): ReadinessCondition {
    if (!agent.available) {
      return {
        name: 'agent_availability',
        passed: false,
        diagnostics: [
          {
            field: 'agent',
            severity: 'error',
            message: `Agent "${agent.agentId}" is not available: ${agent.reason ?? 'unknown reason'}`,
            remediation: `Ensure agent "${agent.agentId}" is configured and operational`,
          },
        ],
      };
    }
    return { name: 'agent_availability', passed: true, diagnostics: [] };
  }

  private checkSkillAvailability(skills: SkillAvailability[]): ReadinessCondition {
    const diagnostics: TaskDiagnostic[] = [];

    for (const skill of skills) {
      if (!skill.available) {
        diagnostics.push({
          field: 'skills',
          severity: 'error',
          message: `Skill "${skill.skillId}" is not available: ${skill.reason ?? 'unknown reason'}`,
          remediation: `Ensure skill "${skill.skillId}" is installed and compatible`,
        });
      }
    }

    return {
      name: 'skill_availability',
      passed: diagnostics.length === 0,
      diagnostics,
    };
  }

  private checkPermissions(permissions: PermissionCheck[]): ReadinessCondition {
    const diagnostics: TaskDiagnostic[] = [];

    for (const perm of permissions) {
      if (!perm.granted) {
        diagnostics.push({
          field: 'permissions',
          severity: 'error',
          message: `Permission "${perm.permission}" is not granted: ${perm.reason ?? 'no reason'}`,
          remediation: `Grant permission "${perm.permission}" or adjust the task scope`,
        });
      }
    }

    return {
      name: 'permissions',
      passed: diagnostics.length === 0,
      diagnostics,
    };
  }

  private checkBudget(budget: BudgetCheck): ReadinessCondition {
    if (!budget.sufficient) {
      return {
        name: 'budget_sufficiency',
        passed: false,
        diagnostics: [
          {
            field: 'budget',
            severity: 'error',
            message: `Insufficient budget: ${budget.budgetAvailable} available, ${budget.budgetRequired} required`,
            remediation: 'Increase the budget allocation or reduce the task scope',
          },
        ],
      };
    }
    return { name: 'budget_sufficiency', passed: true, diagnostics: [] };
  }
}
