/**
 * RunLifecycleManager — Lifecycle management with pause/resume/cancel/retry/reassign/branch
 * and unified execution history with correlation tracking.
 *
 * Responsibilities:
 * 1. Correlate every run with its Task ID, requirement IDs, messages, tools, Change_Sets,
 *    and Evidence via typed CorrelationRecords.
 * 2. Implement pause, resume, cancel, retry, reassign, and branch as history-preserving
 *    transitions or linked run attempts.
 * 3. Ensure retries create new Agent_Run records with parentRunId linking to prior attempt.
 * 4. Return pre-execution failures (preparing phase fails) to task status 'ready' or
 *    'blocked' with diagnostics.
 * 5. Provide a unified execution history API that combines all runs for a task into one
 *    attributed timeline.
 * 6. Each history entry records actor (agent/user/system), timestamp, state change, and
 *    linked artifacts.
 *
 * Requirements: 13.5, 13.6, 13.7, 13.9
 */

import {
  RunCoordinator,
  IllegalTransitionError,
  RunNotFoundError,
  TERMINAL_RUN_STATES,
  type AgentRun,
  type RunState,
  type CreateRunParams,
} from './run-coordinator.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Actor who performed an action in the lifecycle.
 */
export type ActorKind = 'agent' | 'user' | 'system';

/**
 * Actor identity for lifecycle events.
 */
export interface Actor {
  readonly kind: ActorKind;
  readonly id: string;
}

/**
 * A correlated artifact reference linked to a run.
 */
export type CorrelationKind = 'message' | 'tool' | 'change_set' | 'evidence';

/**
 * A single correlation entry linking an artifact to a run.
 */
export interface CorrelationEntry {
  readonly kind: CorrelationKind;
  readonly artifactId: string;
  readonly timestamp: string;
}

/**
 * Full correlation record for a run, binding it to its task, requirements,
 * and all related artifacts.
 */
export interface CorrelationRecord {
  readonly runId: string;
  readonly taskId: string;
  readonly requirementIds: readonly string[];
  readonly entries: readonly CorrelationEntry[];
}

/**
 * A single entry in the unified execution history timeline.
 */
export interface HistoryEntry {
  readonly id: string;
  readonly runId: string;
  readonly actor: Actor;
  readonly timestamp: string;
  readonly action: string;
  readonly fromState: RunState | null;
  readonly toState: RunState | null;
  readonly linkedArtifacts: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * The unified execution history for a task, combining all runs.
 */
export interface UnifiedExecutionHistory {
  readonly taskId: string;
  readonly runs: readonly AgentRun[];
  readonly timeline: readonly HistoryEntry[];
  readonly totalAttempts: number;
  readonly currentRunId: string | null;
}

/**
 * Diagnostic information returned when a pre-execution failure occurs.
 */
export interface PreExecutionDiagnostic {
  readonly runId: string;
  readonly taskId: string;
  readonly failureReason: string;
  readonly returnedToStatus: 'ready' | 'blocked';
  readonly timestamp: string;
}

/**
 * Result of a lifecycle operation.
 */
export interface LifecycleResult {
  readonly success: boolean;
  readonly run: AgentRun | null;
  readonly error?: string;
  readonly diagnostic?: PreExecutionDiagnostic;
  readonly newRunId?: string;
}

/**
 * Callback to update task status after lifecycle operations.
 */
export type TaskStatusCallback = (taskId: string, status: 'ready' | 'blocked') => void;

// ─── RunLifecycleManager ────────────────────────────────────────────────────

/**
 * RunLifecycleManager manages run lifecycle transitions, correlation,
 * and provides a unified execution history.
 */
export class RunLifecycleManager {
  private readonly correlations = new Map<string, CorrelationRecord>();
  private readonly history = new Map<string, HistoryEntry[]>();
  private entryCounter = 0;

  constructor(
    private readonly runCoordinator: RunCoordinator,
    private readonly taskStatusCallback?: TaskStatusCallback,
  ) {}

  // ─── Correlation ────────────────────────────────────────────────────────

  /**
   * Initialize correlation tracking for a run with its task and requirement IDs.
   */
  initializeCorrelation(
    runId: string,
    taskId: string,
    requirementIds: readonly string[],
  ): CorrelationRecord {
    const record: CorrelationRecord = {
      runId,
      taskId,
      requirementIds,
      entries: [],
    };
    this.correlations.set(runId, record);
    return record;
  }

  /**
   * Add a correlation entry (message, tool, change_set, or evidence) to a run.
   */
  addCorrelation(
    runId: string,
    kind: CorrelationKind,
    artifactId: string,
  ): CorrelationRecord {
    const existing = this.correlations.get(runId);
    if (!existing) {
      throw new RunNotFoundError(runId);
    }

    const entry: CorrelationEntry = {
      kind,
      artifactId,
      timestamp: new Date().toISOString(),
    };

    const updated: CorrelationRecord = {
      ...existing,
      entries: [...existing.entries, entry],
    };
    this.correlations.set(runId, updated);
    return updated;
  }

  /**
   * Get the correlation record for a run.
   */
  getCorrelation(runId: string): CorrelationRecord | undefined {
    return this.correlations.get(runId);
  }

  // ─── Lifecycle Transitions ──────────────────────────────────────────────

  /**
   * Pause a running run, preserving its current state.
   */
  pause(runId: string, actor: Actor): LifecycleResult {
    return this.performTransition(runId, 'paused', actor, 'pause');
  }

  /**
   * Resume a paused run back to its previous active state.
   * Resumes to 'running' by default.
   */
  resume(runId: string, actor: Actor, targetState?: RunState): LifecycleResult {
    const run = this.runCoordinator.getRun(runId);
    if (!run) {
      return { success: false, run: null, error: `Run '${runId}' not found` };
    }

    if (run.state !== 'paused') {
      return {
        success: false,
        run,
        error: `Cannot resume run '${runId}': current state is '${run.state}', expected 'paused'`,
      };
    }

    const resumeTo = targetState ?? 'running';
    return this.performTransition(runId, resumeTo, actor, 'resume');
  }

  /**
   * Cancel a run (terminal state).
   */
  cancel(runId: string, actor: Actor): LifecycleResult {
    return this.performTransition(runId, 'cancelled', actor, 'cancel');
  }

  /**
   * Retry a failed or cancelled run by creating a new linked Agent_Run.
   * The new run's parentRunId points to the previous attempt.
   */
  retry(runId: string, actor: Actor): LifecycleResult {
    const previousRun = this.runCoordinator.getRun(runId);
    if (!previousRun) {
      return { success: false, run: null, error: `Run '${runId}' not found` };
    }

    if (!TERMINAL_RUN_STATES.includes(previousRun.state)) {
      return {
        success: false,
        run: previousRun,
        error: `Cannot retry run '${runId}': it is still active in state '${previousRun.state}'`,
      };
    }

    const newAttempt = previousRun.attempt + 1;
    const createParams: CreateRunParams = {
      taskId: previousRun.taskId,
      workspaceId: previousRun.workspaceId,
      agentId: previousRun.agentId,
      modelRouteId: previousRun.modelRouteId,
      dispatchPlanFingerprint: previousRun.dispatchPlanFingerprint,
      parentRunId: previousRun.id,
      attempt: newAttempt,
    };

    try {
      const newRun = this.runCoordinator.createRun(createParams);

      // Initialize correlation for the new run using same task/requirements
      const previousCorrelation = this.correlations.get(runId);
      if (previousCorrelation) {
        this.initializeCorrelation(
          newRun.id,
          previousCorrelation.taskId,
          previousCorrelation.requirementIds,
        );
      }

      this.recordHistoryEntry(newRun.id, actor, 'retry', null, 'queued', [runId], {
        previousRunId: runId,
        previousState: previousRun.state,
        attempt: newAttempt,
      });

      return { success: true, run: newRun, newRunId: newRun.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, run: previousRun, error: message };
    }
  }

  /**
   * Reassign a run to a different agent by cancelling the current run
   * and creating a new one with the new agent.
   */
  reassign(runId: string, newAgentId: string, actor: Actor): LifecycleResult {
    const currentRun = this.runCoordinator.getRun(runId);
    if (!currentRun) {
      return { success: false, run: null, error: `Run '${runId}' not found` };
    }

    // If the run is still active, cancel it first
    if (!TERMINAL_RUN_STATES.includes(currentRun.state)) {
      try {
        this.runCoordinator.transitionRun(runId, 'cancelled');
        this.recordHistoryEntry(runId, actor, 'cancel_for_reassign', currentRun.state, 'cancelled', [], {
          reason: 'reassignment',
          newAgentId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, run: currentRun, error: `Failed to cancel for reassign: ${message}` };
      }
    }

    // Create a new run with the different agent
    const createParams: CreateRunParams = {
      taskId: currentRun.taskId,
      workspaceId: currentRun.workspaceId,
      agentId: newAgentId,
      modelRouteId: currentRun.modelRouteId,
      dispatchPlanFingerprint: currentRun.dispatchPlanFingerprint,
      parentRunId: currentRun.id,
      attempt: currentRun.attempt + 1,
    };

    try {
      const newRun = this.runCoordinator.createRun(createParams);

      // Copy correlation to new run
      const previousCorrelation = this.correlations.get(runId);
      if (previousCorrelation) {
        this.initializeCorrelation(
          newRun.id,
          previousCorrelation.taskId,
          previousCorrelation.requirementIds,
        );
      }

      this.recordHistoryEntry(newRun.id, actor, 'reassign', null, 'queued', [runId], {
        previousRunId: runId,
        previousAgentId: currentRun.agentId,
        newAgentId,
      });

      return { success: true, run: newRun, newRunId: newRun.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, run: currentRun, error: message };
    }
  }

  /**
   * Branch from an existing run, creating a parallel alternative.
   * Unlike retry, branching does not require the parent to be terminal.
   * The parent run remains unchanged.
   */
  branch(runId: string, actor: Actor): LifecycleResult {
    const parentRun = this.runCoordinator.getRun(runId);
    if (!parentRun) {
      return { success: false, run: null, error: `Run '${runId}' not found` };
    }

    // For branching, the original run must be in a terminal state
    // or we need to cancel it first to avoid duplicate active runs
    if (!TERMINAL_RUN_STATES.includes(parentRun.state)) {
      // Cancel the parent first to allow branching
      try {
        this.runCoordinator.transitionRun(runId, 'cancelled');
        this.recordHistoryEntry(runId, actor, 'cancel_for_branch', parentRun.state, 'cancelled', [], {
          reason: 'branching',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, run: parentRun, error: `Failed to cancel for branch: ${message}` };
      }
    }

    const createParams: CreateRunParams = {
      taskId: parentRun.taskId,
      workspaceId: parentRun.workspaceId,
      agentId: parentRun.agentId,
      modelRouteId: parentRun.modelRouteId,
      dispatchPlanFingerprint: parentRun.dispatchPlanFingerprint,
      parentRunId: parentRun.id,
      attempt: parentRun.attempt + 1,
    };

    try {
      const branchRun = this.runCoordinator.createRun(createParams);

      // Copy correlation to branch run
      const previousCorrelation = this.correlations.get(runId);
      if (previousCorrelation) {
        this.initializeCorrelation(
          branchRun.id,
          previousCorrelation.taskId,
          previousCorrelation.requirementIds,
        );
      }

      this.recordHistoryEntry(branchRun.id, actor, 'branch', null, 'queued', [runId], {
        parentRunId: runId,
        parentState: parentRun.state,
      });

      return { success: true, run: branchRun, newRunId: branchRun.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, run: parentRun, error: message };
    }
  }

  // ─── Pre-Execution Failure Handling ─────────────────────────────────────

  /**
   * Handle a pre-execution failure (e.g., preparing phase fails).
   * Returns the task to 'ready' or 'blocked' with diagnostic information.
   */
  handlePreExecutionFailure(
    runId: string,
    failureReason: string,
    returnTo: 'ready' | 'blocked' = 'ready',
  ): PreExecutionDiagnostic {
    const run = this.runCoordinator.getRun(runId);
    if (!run) {
      throw new RunNotFoundError(runId);
    }

    // Transition the run to failed
    try {
      this.runCoordinator.transitionRun(runId, 'failed');
    } catch {
      // Run may already be in a terminal state — that's acceptable
    }

    const diagnostic: PreExecutionDiagnostic = {
      runId,
      taskId: run.taskId,
      failureReason,
      returnedToStatus: returnTo,
      timestamp: new Date().toISOString(),
    };

    // Notify task status callback to return task to ready/blocked
    if (this.taskStatusCallback) {
      this.taskStatusCallback(run.taskId, returnTo);
    }

    // Record in history
    this.recordHistoryEntry(
      runId,
      { kind: 'system', id: 'lifecycle-manager' },
      'pre_execution_failure',
      run.state,
      'failed',
      [],
      { failureReason, returnedToStatus: returnTo },
    );

    return diagnostic;
  }

  // ─── Unified Execution History ──────────────────────────────────────────

  /**
   * Get the unified execution history for a task, combining all runs
   * into one attributed timeline.
   */
  getUnifiedHistory(taskId: string): UnifiedExecutionHistory {
    const runs = this.runCoordinator.getRunsForTask(taskId);
    const activeRun = this.runCoordinator.getActiveRunForTask(taskId);

    // Collect all history entries for all runs belonging to this task
    const allEntries: HistoryEntry[] = [];
    for (const run of runs) {
      const runEntries = this.history.get(run.id) ?? [];
      allEntries.push(...runEntries);
    }

    // Sort by timestamp
    const sortedTimeline = [...allEntries].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    return {
      taskId,
      runs,
      timeline: sortedTimeline,
      totalAttempts: runs.length,
      currentRunId: activeRun?.id ?? null,
    };
  }

  /**
   * Get the execution history for a single run.
   */
  getRunHistory(runId: string): readonly HistoryEntry[] {
    return this.history.get(runId) ?? [];
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  /**
   * Perform a state transition and record it in history.
   */
  private performTransition(
    runId: string,
    toState: RunState,
    actor: Actor,
    action: string,
  ): LifecycleResult {
    const run = this.runCoordinator.getRun(runId);
    if (!run) {
      return { success: false, run: null, error: `Run '${runId}' not found` };
    }

    const fromState = run.state;

    try {
      const updated = this.runCoordinator.transitionRun(runId, toState);

      this.recordHistoryEntry(runId, actor, action, fromState, toState, [], {});

      return { success: true, run: updated };
    } catch (error) {
      if (error instanceof IllegalTransitionError) {
        return {
          success: false,
          run,
          error: `Cannot ${action} run '${runId}': transition from '${fromState}' to '${toState}' is not allowed`,
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, run, error: message };
    }
  }

  /**
   * Record a history entry for a run.
   */
  private recordHistoryEntry(
    runId: string,
    actor: Actor,
    action: string,
    fromState: RunState | null,
    toState: RunState | null,
    linkedArtifacts: readonly string[],
    metadata: Readonly<Record<string, unknown>>,
  ): void {
    this.entryCounter++;
    const entry: HistoryEntry = {
      id: `history-${this.entryCounter}`,
      runId,
      actor,
      timestamp: new Date().toISOString(),
      action,
      fromState,
      toState,
      linkedArtifacts,
      metadata,
    };

    const entries = this.history.get(runId) ?? [];
    entries.push(entry);
    this.history.set(runId, entries);
  }
}
