/**
 * RunCoordinator — Creates immutable Agent_Run records and enforces legal
 * state transitions. It is the sole writer of run state.
 *
 * Key invariants:
 * 1. Every accepted dispatch creates exactly ONE Agent_Run in 'queued' state
 *    BEFORE any backend action.
 * 2. Rejected dispatches create NO Agent_Run.
 * 3. State transitions are enforced against a defined state machine.
 * 4. Retries/branches create new attempt or child-run records linked to prior history.
 *
 * Requirements: 13.1, 13.3, 13.4
 */

import { randomUUID } from 'crypto';

// ─── Run State Machine ─────────────────────────────────────────────────────

/**
 * All legal states for an Agent_Run.
 */
export type RunState =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'awaiting_approval'
  | 'validating'
  | 'review_required'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused'
  | 'blocked';

/**
 * Legal state transitions from a given state.
 */
export const VALID_RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ['preparing', 'blocked', 'failed', 'cancelled'],
  preparing: ['running', 'blocked', 'failed', 'cancelled', 'paused'],
  running: ['awaiting_approval', 'validating', 'review_required', 'completed', 'failed', 'cancelled', 'paused'],
  awaiting_approval: ['running', 'failed', 'cancelled', 'paused'],
  validating: ['review_required', 'completed', 'failed', 'cancelled', 'paused'],
  review_required: ['completed', 'failed', 'cancelled', 'paused'],
  completed: [],
  failed: [],
  cancelled: [],
  paused: ['queued', 'preparing', 'running', 'cancelled', 'failed'],
  blocked: ['queued', 'failed', 'cancelled'],
} as const;

/** Terminal states — no further transitions allowed */
export const TERMINAL_RUN_STATES: readonly RunState[] = ['completed', 'failed', 'cancelled'];

// ─── Agent Run Types ────────────────────────────────────────────────────────

/**
 * Immutable Agent_Run record.
 */
export interface AgentRun {
  /** Unique stable identifier */
  readonly id: string;
  /** The task this run belongs to */
  readonly taskId: string;
  /** Workspace where this run operates */
  readonly workspaceId: string;
  /** Agent assigned to execute */
  readonly agentId: string;
  /** Model route identifier */
  readonly modelRouteId: string;
  /** Current state */
  readonly state: RunState;
  /** Parent run ID (for retry/branch) */
  readonly parentRunId: string | null;
  /** Attempt number (1-based) */
  readonly attempt: number;
  /** Creation timestamp (ISO 8601) */
  readonly createdAt: string;
  /** Last state transition timestamp (ISO 8601) */
  readonly updatedAt: string;
  /** Immutable dispatch plan fingerprint */
  readonly dispatchPlanFingerprint: string;
}

/**
 * Parameters needed to create an Agent_Run.
 */
export interface CreateRunParams {
  taskId: string;
  workspaceId: string;
  agentId: string;
  modelRouteId: string;
  dispatchPlanFingerprint: string;
  parentRunId?: string;
  attempt?: number;
}

/**
 * Error thrown when an illegal state transition is attempted.
 */
export class IllegalTransitionError extends Error {
  constructor(
    public readonly runId: string,
    public readonly fromState: RunState,
    public readonly toState: RunState,
  ) {
    super(
      `Illegal run state transition for run '${runId}': '${fromState}' -> '${toState}'`,
    );
    this.name = 'IllegalTransitionError';
  }
}

/**
 * Error thrown when attempting to operate on a non-existent run.
 */
export class RunNotFoundError extends Error {
  constructor(public readonly runId: string) {
    super(`Agent_Run not found: '${runId}'`);
    this.name = 'RunNotFoundError';
  }
}

/**
 * Error thrown when a duplicate run creation is detected.
 */
export class DuplicateRunError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly existingRunId: string,
  ) {
    super(
      `Duplicate run detected for task '${taskId}': existing active run '${existingRunId}'`,
    );
    this.name = 'DuplicateRunError';
  }
}

// ─── RunCoordinator ─────────────────────────────────────────────────────────

/**
 * RunCoordinator — Single authority for creating and transitioning Agent_Run records.
 */
export class RunCoordinator {
  private readonly runs = new Map<string, AgentRun>();
  private readonly runsByTask = new Map<string, string[]>();

  /**
   * Create an immutable Agent_Run in 'queued' state.
   * This MUST be called before any backend action begins.
   *
   * @throws DuplicateRunError if an active (non-terminal) run already exists for the task.
   */
  createRun(params: CreateRunParams): AgentRun {
    // Check for duplicate active runs for this task
    const existingRuns = this.runsByTask.get(params.taskId) ?? [];
    for (const existingRunId of existingRuns) {
      const existing = this.runs.get(existingRunId);
      if (existing && !TERMINAL_RUN_STATES.includes(existing.state)) {
        throw new DuplicateRunError(params.taskId, existingRunId);
      }
    }

    const now = new Date().toISOString();
    const run: AgentRun = {
      id: randomUUID(),
      taskId: params.taskId,
      workspaceId: params.workspaceId,
      agentId: params.agentId,
      modelRouteId: params.modelRouteId,
      state: 'queued',
      parentRunId: params.parentRunId ?? null,
      attempt: params.attempt ?? 1,
      createdAt: now,
      updatedAt: now,
      dispatchPlanFingerprint: params.dispatchPlanFingerprint,
    };

    this.runs.set(run.id, run);

    const taskRuns = this.runsByTask.get(params.taskId) ?? [];
    taskRuns.push(run.id);
    this.runsByTask.set(params.taskId, taskRuns);

    return run;
  }

  /**
   * Transition a run to a new state, enforcing legal transitions.
   *
   * @throws RunNotFoundError if run doesn't exist.
   * @throws IllegalTransitionError if transition is not allowed.
   */
  transitionRun(runId: string, toState: RunState): AgentRun {
    const run = this.runs.get(runId);
    if (!run) {
      throw new RunNotFoundError(runId);
    }

    const allowedTransitions = VALID_RUN_TRANSITIONS[run.state];
    if (!allowedTransitions.includes(toState)) {
      throw new IllegalTransitionError(runId, run.state, toState);
    }

    const updated: AgentRun = {
      ...run,
      state: toState,
      updatedAt: new Date().toISOString(),
    };

    this.runs.set(runId, updated);
    return updated;
  }

  /**
   * Get a run by its ID.
   */
  getRun(runId: string): AgentRun | undefined {
    return this.runs.get(runId);
  }

  /**
   * Get all runs for a given task (including terminal ones).
   */
  getRunsForTask(taskId: string): AgentRun[] {
    const runIds = this.runsByTask.get(taskId) ?? [];
    return runIds
      .map((id) => this.runs.get(id))
      .filter((r): r is AgentRun => r !== undefined);
  }

  /**
   * Get the active (non-terminal) run for a task, if any.
   */
  getActiveRunForTask(taskId: string): AgentRun | undefined {
    const runs = this.getRunsForTask(taskId);
    return runs.find((r) => !TERMINAL_RUN_STATES.includes(r.state));
  }

  /**
   * Check whether a state transition would be legal without performing it.
   */
  isTransitionValid(fromState: RunState, toState: RunState): boolean {
    return VALID_RUN_TRANSITIONS[fromState].includes(toState);
  }
}
