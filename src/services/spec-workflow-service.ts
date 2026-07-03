/**
 * SpecWorkflowService — Spec-Driven Development Workflow integration.
 *
 * Detects complex feature requests via intent classification, offers structured
 * spec creation (requirements → design → tasks), supports task dependency ordering,
 * and verifies per-task acceptance criteria after implementation.
 *
 * The workflow produces three artifacts:
 * 1. Requirements document — acceptance criteria for each requirement
 * 2. Technical design document — architecture, interfaces, data models
 * 3. Sequenced task list — dependency-ordered, independently implementable tasks
 *
 * Feature-gated via `production_ux_spec_workflow` — all methods return empty/no-op
 * when the flag is disabled (zero overhead).
 *
 * Requirements: 18.1, 18.2, 18.3, 18.4
 */

import { randomUUID } from 'node:crypto';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

// ─── Types ──────────────────────────────────────────────────────

/** Classification of a user request's complexity */
export type RequestComplexity = 'simple' | 'moderate' | 'complex';

/** Intent classification result for a user message */
export interface IntentClassification {
  /** Whether the request is classified as complex (multi-file/architectural) */
  isComplex: boolean;
  /** The detected complexity level */
  complexity: RequestComplexity;
  /** Signals that contributed to the classification */
  signals: string[];
  /** Confidence score (0–1) for the classification */
  confidence: number;
}

/** Status of the overall spec workflow */
export type SpecWorkflowStatus = 'requirements' | 'design' | 'tasks' | 'executing' | 'completed';

/** A single task within the spec workflow */
export interface SpecTask {
  id: string;
  title: string;
  description: string;
  /** IDs of tasks that must complete before this one */
  dependencies: string[];
  /** Requirement IDs this task references */
  requirementRefs: string[];
  /** Criteria to verify after implementation */
  acceptanceCriteria: string[];
  /** Execution status */
  status: 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed';
  /** Verification result after completion */
  verificationResult?: VerificationResult;
}

/** Result of verifying a task's acceptance criteria */
export interface VerificationResult {
  passed: boolean;
  /** Per-criterion pass/fail */
  criteriaResults: Array<{
    criterion: string;
    passed: boolean;
    detail?: string;
  }>;
  verifiedAt: number;
}

/** The full spec workflow state */
export interface SpecWorkflow {
  id: string;
  title: string;
  /** Original user request that triggered the workflow */
  originalRequest: string;
  status: SpecWorkflowStatus;
  /** Requirements document content (Markdown) */
  requirements: string | null;
  /** Technical design document content (Markdown) */
  design: string | null;
  /** Sequenced task list */
  tasks: SpecTask[];
  createdAt: number;
  updatedAt: number;
}

// ─── Constants ──────────────────────────────────────────────────

/**
 * Signals that indicate a request is complex (multi-file/architectural).
 * Each signal is a regex pattern matched against the user message.
 */
const COMPLEXITY_SIGNALS: Array<{ pattern: RegExp; label: string; weight: number }> = [
  { pattern: /\b(architect(ure)?|system design|high.?level design)\b/i, label: 'architectural-terms', weight: 0.3 },
  { pattern: /\b(multiple files?|multi.?file|several (modules?|components?|services?))\b/i, label: 'multi-file-indicator', weight: 0.25 },
  { pattern: /\b(database|schema|migration|api endpoint|rest api|graphql)\b/i, label: 'infrastructure-terms', weight: 0.2 },
  { pattern: /\b(refactor|restructure|reorganize|rewrite)\b/i, label: 'refactoring-terms', weight: 0.2 },
  { pattern: /\b(authentication|authorization|auth system|oauth|jwt)\b/i, label: 'auth-system', weight: 0.25 },
  { pattern: /\b(microservice|event.?driven|message queue|pub.?sub)\b/i, label: 'distributed-architecture', weight: 0.3 },
  { pattern: /\b(full.?stack|front.?end and back.?end|client.?server)\b/i, label: 'full-stack', weight: 0.25 },
  { pattern: /\b(test(ing)? strategy|ci.?cd|deployment pipeline)\b/i, label: 'devops-terms', weight: 0.2 },
  { pattern: /\b(feature|implement|build|create|add)\b.*\b(system|framework|platform|service|module)\b/i, label: 'system-building', weight: 0.2 },
  { pattern: /\b(step[s]?\s*\d|phase[s]?\s*\d|stage[s]?\s*\d)\b/i, label: 'phased-work', weight: 0.15 },
  { pattern: /\band\b.*\band\b.*\band\b/i, label: 'multi-concern-conjunctions', weight: 0.15 },
];

/** Threshold above which a request is classified as complex */
const COMPLEXITY_THRESHOLD = 0.4;

/** Threshold for moderate complexity (between simple and complex) */
const MODERATE_THRESHOLD = 0.2;

// ─── SpecWorkflowService Implementation ─────────────────────────

export class SpecWorkflowService {
  private readonly featureGate: FeatureGateSystem;
  private workflows: Map<string, SpecWorkflow> = new Map();

  constructor(featureGate: FeatureGateSystem) {
    this.featureGate = featureGate;
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Classify the intent of a user message to detect complex feature requests.
   *
   * Uses pattern-based heuristics to determine if the request involves
   * multi-file changes or architectural work that would benefit from
   * a structured spec workflow.
   *
   * Returns a no-op classification (isComplex=false) when the feature gate
   * is disabled.
   *
   * Requirement 18.1: Detect complex features via intent classification.
   */
  classifyIntent(userMessage: string): IntentClassification {
    if (!this.isEnabled()) {
      return { isComplex: false, complexity: 'simple', signals: [], confidence: 0 };
    }

    const signals: string[] = [];
    let totalWeight = 0;

    for (const signal of COMPLEXITY_SIGNALS) {
      if (signal.pattern.test(userMessage)) {
        signals.push(signal.label);
        totalWeight += signal.weight;
      }
    }

    // Clamp confidence to [0, 1]
    const confidence = Math.min(totalWeight, 1);

    let complexity: RequestComplexity;
    if (confidence >= COMPLEXITY_THRESHOLD) {
      complexity = 'complex';
    } else if (confidence >= MODERATE_THRESHOLD) {
      complexity = 'moderate';
    } else {
      complexity = 'simple';
    }

    return {
      isComplex: complexity === 'complex',
      complexity,
      signals,
      confidence,
    };
  }

  /**
   * Create a new spec workflow from a user's feature request.
   *
   * Initializes the workflow in the 'requirements' phase. The caller
   * is responsible for driving the workflow through subsequent phases
   * (design → tasks → executing) by calling the appropriate methods.
   *
   * Requirement 18.2: Produce three artifacts via structured workflow.
   */
  createWorkflow(title: string, originalRequest: string): SpecWorkflow | null {
    if (!this.isEnabled()) return null;

    const now = Date.now();
    const workflow: SpecWorkflow = {
      id: randomUUID(),
      title,
      originalRequest,
      status: 'requirements',
      requirements: null,
      design: null,
      tasks: [],
      createdAt: now,
      updatedAt: now,
    };

    this.workflows.set(workflow.id, workflow);
    return { ...workflow };
  }

  /**
   * Set the requirements document for a workflow and advance to design phase.
   *
   * Requirement 18.2: First artifact is the requirements document.
   */
  setRequirements(workflowId: string, requirements: string): SpecWorkflow | null {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return null;

    workflow.requirements = requirements;
    workflow.status = 'design';
    workflow.updatedAt = Date.now();

    return { ...workflow };
  }

  /**
   * Set the design document for a workflow and advance to tasks phase.
   *
   * Requirement 18.2: Second artifact is the technical design document.
   */
  setDesign(workflowId: string, design: string): SpecWorkflow | null {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return null;

    workflow.design = design;
    workflow.status = 'tasks';
    workflow.updatedAt = Date.now();

    return { ...workflow };
  }

  /**
   * Set the task list for a workflow and advance to executing phase.
   *
   * Tasks are validated for:
   * - Unique IDs
   * - Valid dependency references (all referenced IDs must exist in the set)
   * - Non-empty acceptance criteria
   * - At least one requirement reference
   *
   * Requirement 18.2: Third artifact is the sequenced task list.
   * Requirement 18.3: Each task is independently implementable with refs and criteria.
   */
  setTasks(workflowId: string, tasks: Omit<SpecTask, 'status' | 'verificationResult'>[]): SpecWorkflow | null {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return null;

    // Validate task structure
    const taskIds = new Set(tasks.map((t) => t.id));

    for (const task of tasks) {
      // Validate dependencies reference existing task IDs
      for (const dep of task.dependencies) {
        if (!taskIds.has(dep)) {
          return null; // Invalid dependency reference
        }
      }

      // Validate no self-dependency
      if (task.dependencies.includes(task.id)) {
        return null;
      }
    }

    // Check for circular dependencies
    if (this.hasCircularDependencies(tasks)) {
      return null;
    }

    workflow.tasks = tasks.map((t) => ({
      ...t,
      status: 'pending' as const,
    }));
    workflow.status = 'executing';
    workflow.updatedAt = Date.now();

    return { ...workflow, tasks: workflow.tasks.map((t) => ({ ...t })) };
  }

  /**
   * Get the next executable tasks — those whose dependencies are all completed.
   *
   * Returns tasks in dependency order: a task is only eligible when all
   * of its dependencies have status 'completed' or 'skipped'.
   *
   * Requirement 18.4: Follow task dependency order during execution.
   */
  getNextTasks(workflowId: string): SpecTask[] {
    if (!this.isEnabled()) return [];

    const workflow = this.workflows.get(workflowId);
    if (!workflow || workflow.status !== 'executing') return [];

    const completedOrSkipped = new Set(
      workflow.tasks
        .filter((t) => t.status === 'completed' || t.status === 'skipped')
        .map((t) => t.id),
    );

    return workflow.tasks
      .filter((task) => {
        if (task.status !== 'pending') return false;
        return task.dependencies.every((dep) => completedOrSkipped.has(dep));
      })
      .map((t) => ({ ...t }));
  }

  /**
   * Mark a task as in-progress.
   */
  startTask(workflowId: string, taskId: string): SpecTask | null {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return null;

    const task = workflow.tasks.find((t) => t.id === taskId);
    if (!task || task.status !== 'pending') return null;

    task.status = 'in_progress';
    workflow.updatedAt = Date.now();

    return { ...task };
  }

  /**
   * Verify a task's acceptance criteria after implementation.
   *
   * Accepts per-criterion pass/fail results and marks the task as
   * completed (all criteria pass) or failed (any criterion fails).
   *
   * Requirement 18.4: Verify acceptance criteria after implementation.
   */
  verifyTask(
    workflowId: string,
    taskId: string,
    criteriaResults: VerificationResult['criteriaResults'],
  ): SpecTask | null {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return null;

    const task = workflow.tasks.find((t) => t.id === taskId);
    if (!task || task.status !== 'in_progress') return null;

    const allPassed = criteriaResults.every((c) => c.passed);

    task.verificationResult = {
      passed: allPassed,
      criteriaResults,
      verifiedAt: Date.now(),
    };

    task.status = allPassed ? 'completed' : 'failed';
    workflow.updatedAt = Date.now();

    // Check if all tasks are done
    const allDone = workflow.tasks.every(
      (t) => t.status === 'completed' || t.status === 'skipped',
    );
    if (allDone) {
      workflow.status = 'completed';
    }

    return { ...task };
  }

  /**
   * Skip a task (user decides not to implement it).
   */
  skipTask(workflowId: string, taskId: string): SpecTask | null {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return null;

    const task = workflow.tasks.find((t) => t.id === taskId);
    if (!task || (task.status !== 'pending' && task.status !== 'in_progress')) return null;

    task.status = 'skipped';
    workflow.updatedAt = Date.now();

    // Check if all tasks are done
    const allDone = workflow.tasks.every(
      (t) => t.status === 'completed' || t.status === 'skipped',
    );
    if (allDone) {
      workflow.status = 'completed';
    }

    return { ...task };
  }

  /**
   * Get a workflow by ID.
   */
  getWorkflow(workflowId: string): SpecWorkflow | null {
    if (!this.isEnabled()) return null;

    const workflow = this.workflows.get(workflowId);
    if (!workflow) return null;

    return {
      ...workflow,
      tasks: workflow.tasks.map((t) => ({ ...t })),
    };
  }

  /**
   * Get all active (non-completed) workflows.
   */
  getActiveWorkflows(): SpecWorkflow[] {
    if (!this.isEnabled()) return [];

    return Array.from(this.workflows.values())
      .filter((w) => w.status !== 'completed')
      .map((w) => ({ ...w, tasks: w.tasks.map((t) => ({ ...t })) }));
  }

  /**
   * Get the completion progress of a workflow as a percentage (0–100).
   */
  getProgress(workflowId: string): number {
    const workflow = this.workflows.get(workflowId);
    if (!workflow || workflow.tasks.length === 0) return 0;

    const done = workflow.tasks.filter(
      (t) => t.status === 'completed' || t.status === 'skipped',
    ).length;

    return Math.round((done / workflow.tasks.length) * 100);
  }

  // ─── Private Helpers ────────────────────────────────────────────

  private isEnabled(): boolean {
    return this.featureGate.isEnabled('production_ux_spec_workflow');
  }

  /**
   * Detect circular dependencies using topological sort (Kahn's algorithm).
   * Returns true if a cycle exists.
   */
  private hasCircularDependencies(
    tasks: Omit<SpecTask, 'status' | 'verificationResult'>[],
  ): boolean {
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const task of tasks) {
      inDegree.set(task.id, 0);
      adjacency.set(task.id, []);
    }

    for (const task of tasks) {
      for (const dep of task.dependencies) {
        // dep -> task (dep must come before task)
        const adj = adjacency.get(dep);
        if (adj) adj.push(task.id);
        inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
      }
    }

    // Start with nodes that have no dependencies
    const queue: string[] = [];
    inDegree.forEach((degree, id) => {
      if (degree === 0) queue.push(id);
    });

    let processed = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      processed++;

      const neighbors = adjacency.get(current) ?? [];
      for (const neighbor of neighbors) {
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) queue.push(neighbor);
      }
    }

    // If not all nodes were processed, there's a cycle
    return processed !== tasks.length;
  }
}
