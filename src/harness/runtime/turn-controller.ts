/**
 * Turn_Controller — Legal Turn/Step Lifecycle, Cancellation Convergence, and Recovery
 *
 * The sole transition authority for turn and step lifecycles. Persists explicit
 * transitions, rejects illegal/terminal reversals, propagates Abort_Signal through
 * all owned work, retains the wake latch to quiescence, contains plugin failures,
 * and records teardown completeness.
 *
 * Requirements: 15.1, 15.3–15.6, 36.1–36.8, 36.13–36.17
 */

import type {
  TurnActivityState,
  TurnTransitionRecord,
  OwnedWorkEntry,
  OwnedWorkKind,
  OwnedWorkTerminalStatus,
  PluginFailureRecord,
  TeardownRecord,
  CancellationRequest,
  TurnControllerConfig,
  TransitionCause,
} from './turn-controller-schemas';
import {
  TERMINAL_STATES,
  LEGAL_TRANSITIONS,
  TurnTransitionRecordSchema,
  DEFAULT_TURN_CONTROLLER_CONFIG,
} from './turn-controller-schemas';

// ─── Transition Result ──────────────────────────────────────────

export interface TransitionSuccess {
  success: true;
  record: TurnTransitionRecord;
}

export interface TransitionRejection {
  success: false;
  reason: 'illegal_transition' | 'terminal_state' | 'unknown_turn';
  turnId: string;
  currentState: TurnActivityState | undefined;
  requestedState: TurnActivityState;
}

export type TransitionResult = TransitionSuccess | TransitionRejection;

// ─── Cancellation Convergence Result ────────────────────────────

export interface ConvergenceStatus {
  /** Whether all owned work has reached terminal state. */
  converged: boolean;
  /** Total owned work items. */
  totalWork: number;
  /** Work items that are terminal. */
  terminalCount: number;
  /** Work items still nonterminal. */
  pendingWork: OwnedWorkEntry[];
  /** Plugin failures contained during convergence. */
  pluginFailures: PluginFailureRecord[];
}

// ─── Turn State ─────────────────────────────────────────────────

/**
 * Internal state for a single turn managed by Turn_Controller.
 */
export interface TurnState {
  turnId: string;
  owner: string;
  currentState: TurnActivityState;
  /** All transitions for this turn (append-only). */
  transitions: TurnTransitionRecord[];
  /** All work owned by this turn. */
  ownedWork: Map<string, OwnedWorkEntry & { abortController?: AbortController }>;
  /** Plugin failures contained during this turn. */
  pluginFailures: PluginFailureRecord[];
  /** Teardown record once the turn reaches a terminal state. */
  teardownRecord?: TeardownRecord;
  /** Cancellation request if active. */
  cancellationRequest?: CancellationRequest;
  /** Whether wake latch is active (preventing sleep during cancellation). */
  wakeLatchActive: boolean;
}

// ─── Turn Controller Configuration ─────────────────────────────

export interface TurnControllerDeps {
  /** Configuration for deadlines and timeouts. */
  config?: Partial<TurnControllerConfig>;
  /** ID generator for records. */
  generateId?: () => string;
  /** Time source for testability. */
  now?: () => number;
}

// ─── Turn Controller ────────────────────────────────────────────

/**
 * Turn_Controller: the sole transition authority for turn lifecycles.
 *
 * - Persists explicit turn-created, step-started, step-completed, turn-completed,
 *   cancellation-requested, and teardown-completed events (Requirement 15.1).
 * - Rejects illegal transitions without appending state events.
 * - Terminal states are irreversible (Requirement 36.13, 36.15).
 * - Propagates Abort_Signal through all owned work (Requirement 15.3).
 * - Retains wake latch until quiescence (Requirement 15.4).
 * - Contains plugin failures (Requirement 15.6).
 * - Records teardown completeness (Requirement 15.5).
 */
export class TurnController {
  private readonly turns: Map<string, TurnState> = new Map();
  private readonly config: TurnControllerConfig;
  private readonly generateId: () => string;
  private readonly now: () => number;

  constructor(deps: TurnControllerDeps = {}) {
    this.config = { ...DEFAULT_TURN_CONTROLLER_CONFIG, ...deps.config };
    this.generateId = deps.generateId ?? (() => `tc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    this.now = deps.now ?? (() => Date.now());
  }

  // ─── Turn Creation ──────────────────────────────────────────────

  /**
   * Create a new turn in the 'queued' state (Requirement 15.1: turn-created event).
   */
  createTurn(turnId: string, owner: string): TurnTransitionRecord {
    const record = this.buildTransitionRecord({
      turnId,
      priorState: 'queued' as TurnActivityState, // Initial creation — prior is conceptual
      newState: 'queued',
      cause: 'system_policy',
      owner,
      attempt: 0,
    });

    const state: TurnState = {
      turnId,
      owner,
      currentState: 'queued',
      transitions: [record],
      ownedWork: new Map(),
      pluginFailures: [],
      wakeLatchActive: false,
    };

    this.turns.set(turnId, state);
    return record;
  }

  // ─── State Transitions ──────────────────────────────────────────

  /**
   * Attempt a state transition for a turn.
   *
   * - Rejects unknown turns.
   * - Rejects transitions FROM terminal states (Requirement 36.13, 36.15).
   * - Rejects illegal transitions not in the LEGAL_TRANSITIONS map.
   * - On success, appends the transition record.
   */
  transition(params: {
    turnId: string;
    newState: TurnActivityState;
    cause: TransitionCause;
    stepId?: string;
    causeEventId?: string;
    attempt?: number;
  }): TransitionResult {
    const turn = this.turns.get(params.turnId);

    if (!turn) {
      return {
        success: false,
        reason: 'unknown_turn',
        turnId: params.turnId,
        currentState: undefined,
        requestedState: params.newState,
      };
    }

    // Requirement 36.13, 36.15: Terminal states are irreversible
    if (TERMINAL_STATES.has(turn.currentState)) {
      return {
        success: false,
        reason: 'terminal_state',
        turnId: params.turnId,
        currentState: turn.currentState,
        requestedState: params.newState,
      };
    }

    // Check legal transitions
    const allowed = LEGAL_TRANSITIONS[turn.currentState];
    if (!allowed.has(params.newState)) {
      return {
        success: false,
        reason: 'illegal_transition',
        turnId: params.turnId,
        currentState: turn.currentState,
        requestedState: params.newState,
      };
    }

    const record = this.buildTransitionRecord({
      turnId: params.turnId,
      stepId: params.stepId,
      priorState: turn.currentState,
      newState: params.newState,
      cause: params.cause,
      causeEventId: params.causeEventId,
      owner: turn.owner,
      attempt: params.attempt ?? 0,
    });

    turn.currentState = params.newState;
    turn.transitions.push(record);

    // If entering cancelling, activate the wake latch
    if (params.newState === 'cancelling') {
      turn.wakeLatchActive = true;
    }

    // If reaching a terminal state, deactivate the wake latch
    if (TERMINAL_STATES.has(params.newState)) {
      turn.wakeLatchActive = false;
    }

    return { success: true, record };
  }

  // ─── Owned Work Registration ──────────────────────────────────

  /**
   * Register a piece of work owned by a turn (Requirement 15.4–15.5).
   * Returns an AbortController that the caller can use; the Turn_Controller
   * will signal it during cancellation propagation.
   */
  registerOwnedWork(params: {
    turnId: string;
    workId: string;
    kind: OwnedWorkKind;
    stepId?: string;
  }): AbortController | undefined {
    const turn = this.turns.get(params.turnId);
    if (!turn) return undefined;

    // Don't register work for turns already in terminal state
    if (TERMINAL_STATES.has(turn.currentState)) return undefined;

    const abortController = new AbortController();
    const entry: OwnedWorkEntry & { abortController?: AbortController } = {
      workId: params.workId,
      kind: params.kind,
      turnId: params.turnId,
      stepId: params.stepId,
      registeredAt: new Date(this.now()).toISOString(),
      abortController,
    };

    turn.ownedWork.set(params.workId, entry);

    // If turn is already cancelling, immediately abort the new work
    if (turn.currentState === 'cancelling') {
      abortController.abort();
    }

    return abortController;
  }

  /**
   * Record that a piece of owned work has reached terminal state.
   * Returns the updated convergence status.
   */
  recordWorkTerminal(params: {
    turnId: string;
    workId: string;
    status: OwnedWorkTerminalStatus;
  }): ConvergenceStatus | undefined {
    const turn = this.turns.get(params.turnId);
    if (!turn) return undefined;

    const work = turn.ownedWork.get(params.workId);
    if (!work) return undefined;

    work.terminalStatus = params.status;
    work.terminatedAt = new Date(this.now()).toISOString();

    return this.getConvergenceStatus(params.turnId);
  }

  // ─── Cancellation ─────────────────────────────────────────────

  /**
   * Request cancellation of a turn (Requirement 15.3).
   *
   * - Transitions the turn to 'cancelling' state.
   * - Propagates Abort_Signal to ALL owned work.
   * - Activates the wake latch.
   *
   * Returns the transition result and convergence status.
   */
  requestCancellation(params: {
    turnId: string;
    requestedBy: string;
    convergenceDeadlineMs?: number;
  }): { transition: TransitionResult; convergence?: ConvergenceStatus } {
    const turn = this.turns.get(params.turnId);
    if (!turn) {
      return {
        transition: {
          success: false,
          reason: 'unknown_turn',
          turnId: params.turnId,
          currentState: undefined,
          requestedState: 'cancelling',
        },
      };
    }

    // Attempt the transition to cancelling
    const result = this.transition({
      turnId: params.turnId,
      newState: 'cancelling',
      cause: 'cancellation_request',
    });

    if (!result.success) {
      return { transition: result };
    }

    // Record the cancellation request
    turn.cancellationRequest = {
      requestId: this.generateId(),
      turnId: params.turnId,
      requestedBy: params.requestedBy,
      requestedAt: new Date(this.now()).toISOString(),
      convergenceDeadlineMs: params.convergenceDeadlineMs ?? this.config.defaultConvergenceDeadlineMs,
    };

    // Requirement 15.3: Propagate Abort_Signal to ALL owned work
    this.propagateAbortSignal(params.turnId);

    // Return the convergence status
    const convergence = this.getConvergenceStatus(params.turnId);
    return { transition: result, convergence };
  }

  /**
   * Propagate Abort_Signal to all owned work in a turn (Requirement 15.3).
   * This aborts provider streams, tools, subagents, jobs, timers, and processes.
   */
  private propagateAbortSignal(turnId: string): void {
    const turn = this.turns.get(turnId);
    if (!turn) return;

    for (const work of turn.ownedWork.values()) {
      if (!work.terminalStatus && work.abortController) {
        try {
          work.abortController.abort();
        } catch {
          // Abort failure is silently caught — it's already signaled
        }
      }
    }
  }

  // ─── Wake Latch ───────────────────────────────────────────────

  /**
   * Check whether the wake latch is active for a turn (Requirement 15.4).
   * The wake latch prevents the turn worker from sleeping before all
   * owned work reaches terminal state.
   */
  isWakeLatchActive(turnId: string): boolean {
    const turn = this.turns.get(turnId);
    if (!turn) return false;
    return turn.wakeLatchActive;
  }

  /**
   * Get the convergence status of a turn (Requirement 15.5).
   * Verifies that no owned worker, child process, stream, timer,
   * or undispatched call remains without a terminal record.
   */
  getConvergenceStatus(turnId: string): ConvergenceStatus | undefined {
    const turn = this.turns.get(turnId);
    if (!turn) return undefined;

    const allWork = Array.from(turn.ownedWork.values());
    const pendingWork = allWork.filter((w) => !w.terminalStatus);
    const terminalCount = allWork.length - pendingWork.length;

    return {
      converged: pendingWork.length === 0,
      totalWork: allWork.length,
      terminalCount,
      pendingWork: pendingWork.map(({ abortController, ...entry }) => entry),
      pluginFailures: [...turn.pluginFailures],
    };
  }

  /**
   * Check convergence and finalize cancellation if quiescence is reached.
   * Returns the terminal transition if convergence is complete, or the
   * current status if still waiting (Requirement 15.5, 36.7, 36.8).
   */
  checkConvergence(turnId: string): {
    converged: boolean;
    transition?: TransitionResult;
    convergence: ConvergenceStatus;
  } | undefined {
    const turn = this.turns.get(turnId);
    if (!turn) return undefined;

    const convergence = this.getConvergenceStatus(turnId);
    if (!convergence) return undefined;

    if (convergence.converged && turn.currentState === 'cancelling') {
      // All owned work is terminal — transition to interrupted
      const transition = this.transition({
        turnId,
        newState: 'interrupted',
        cause: 'cancellation_convergence',
      });

      return { converged: true, transition, convergence };
    }

    return { converged: false, convergence };
  }

  // ─── Plugin Failure Containment ───────────────────────────────

  /**
   * Contain a plugin failure within the failing step (Requirement 15.6).
   * Records a structured plugin error and continues cancellation convergence.
   * The plugin failure does NOT abort other owned work or halt convergence.
   */
  containPluginFailure(params: {
    turnId: string;
    workId: string;
    pluginId: string;
    stepId?: string;
    errorMessage: string;
    errorCode?: string;
  }): PluginFailureRecord | undefined {
    const turn = this.turns.get(params.turnId);
    if (!turn) return undefined;

    const record: PluginFailureRecord = {
      failureId: this.generateId(),
      turnId: params.turnId,
      stepId: params.stepId,
      workId: params.workId,
      pluginId: params.pluginId,
      errorMessage: params.errorMessage,
      errorCode: params.errorCode,
      convergenceContinued: true,
      recordedAt: new Date(this.now()).toISOString(),
      schemaVersion: 1 as const,
    };

    turn.pluginFailures.push(record);

    // Mark the work as failed but continue convergence
    const work = turn.ownedWork.get(params.workId);
    if (work && !work.terminalStatus) {
      work.terminalStatus = 'failed';
      work.terminatedAt = new Date(this.now()).toISOString();
    }

    return record;
  }

  // ─── Teardown ─────────────────────────────────────────────────

  /**
   * Record teardown completeness for a turn (design recovery requirement).
   * Documents which resources were cleaned up and which timed out.
   */
  recordTeardown(turnId: string): TeardownRecord | undefined {
    const turn = this.turns.get(turnId);
    if (!turn) return undefined;

    // Teardown only applies to turns that have reached a terminal state
    if (!TERMINAL_STATES.has(turn.currentState)) return undefined;

    const startedAt = new Date(this.now()).toISOString();
    const allWork = Array.from(turn.ownedWork.values());

    const cleanedUp: TeardownRecord['cleanedUp'] = [];
    const timedOut: TeardownRecord['timedOut'] = [];

    for (const work of allWork) {
      if (work.terminalStatus) {
        const registeredTime = new Date(work.registeredAt).getTime();
        const terminatedTime = work.terminatedAt ? new Date(work.terminatedAt).getTime() : this.now();
        cleanedUp.push({
          workId: work.workId,
          kind: work.kind,
          status: work.terminalStatus,
          durationMs: terminatedTime - registeredTime,
        });
      } else {
        const registeredTime = new Date(work.registeredAt).getTime();
        timedOut.push({
          workId: work.workId,
          kind: work.kind,
          deadlineMs: this.config.perWorkTeardownTimeoutMs,
          elapsedMs: this.now() - registeredTime,
        });
      }
    }

    const completedAt = new Date(this.now()).toISOString();
    const record: TeardownRecord = {
      teardownId: this.generateId(),
      turnId,
      totalOwnedWork: allWork.length,
      cleanedUp,
      timedOut,
      allTerminal: timedOut.length === 0,
      startedAt,
      completedAt,
      durationMs: 0, // Synchronous teardown recording
      schemaVersion: 1 as const,
    };

    turn.teardownRecord = record;
    return record;
  }

  // ─── Query ────────────────────────────────────────────────────

  /**
   * Get the current state of a turn.
   */
  getCurrentState(turnId: string): TurnActivityState | undefined {
    return this.turns.get(turnId)?.currentState;
  }

  /**
   * Get the full transition history for a turn.
   */
  getTransitions(turnId: string): TurnTransitionRecord[] {
    return this.turns.get(turnId)?.transitions ?? [];
  }

  /**
   * Get the teardown record for a turn.
   */
  getTeardownRecord(turnId: string): TeardownRecord | undefined {
    return this.turns.get(turnId)?.teardownRecord;
  }

  /**
   * Get plugin failures for a turn.
   */
  getPluginFailures(turnId: string): PluginFailureRecord[] {
    return this.turns.get(turnId)?.pluginFailures ?? [];
  }

  /**
   * Get the cancellation request for a turn.
   */
  getCancellationRequest(turnId: string): CancellationRequest | undefined {
    return this.turns.get(turnId)?.cancellationRequest;
  }

  /**
   * Check if a turn exists.
   */
  hasTurn(turnId: string): boolean {
    return this.turns.has(turnId);
  }

  /**
   * Check if a turn is in a terminal state.
   */
  isTerminal(turnId: string): boolean {
    const state = this.getCurrentState(turnId);
    return state !== undefined && TERMINAL_STATES.has(state);
  }

  /**
   * Check if a transition from one state to another is legal.
   */
  isLegalTransition(from: TurnActivityState, to: TurnActivityState): boolean {
    if (TERMINAL_STATES.has(from)) return false;
    return LEGAL_TRANSITIONS[from].has(to);
  }

  // ─── Durable Transition Helpers ───────────────────────────────

  /**
   * Replay transitions from durable records (supports restart/resume).
   * Validates each transition against the state machine and applies
   * only legal transitions in sequence.
   */
  replayTransitions(turnId: string, owner: string, records: TurnTransitionRecord[]): {
    applied: number;
    rejected: number;
    finalState: TurnActivityState;
  } {
    // Create the turn if it doesn't exist
    if (!this.turns.has(turnId)) {
      this.createTurn(turnId, owner);
    }

    let applied = 0;
    let rejected = 0;

    for (const record of records) {
      // Skip the initial 'queued' creation record
      if (record.priorState === 'queued' && record.newState === 'queued') {
        continue;
      }

      const result = this.transition({
        turnId,
        newState: record.newState,
        cause: record.cause,
        stepId: record.stepId,
        causeEventId: record.causeEventId,
        attempt: record.attempt,
      });

      if (result.success) {
        applied++;
      } else {
        rejected++;
      }
    }

    return {
      applied,
      rejected,
      finalState: this.getCurrentState(turnId) ?? 'queued',
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────

  private buildTransitionRecord(params: {
    turnId: string;
    stepId?: string;
    priorState: TurnActivityState;
    newState: TurnActivityState;
    cause: TransitionCause;
    causeEventId?: string;
    owner: string;
    attempt: number;
  }): TurnTransitionRecord {
    return {
      transitionId: this.generateId(),
      turnId: params.turnId,
      stepId: params.stepId,
      priorState: params.priorState,
      newState: params.newState,
      cause: params.cause,
      causeEventId: params.causeEventId,
      owner: params.owner,
      attempt: params.attempt,
      timestamp: new Date(this.now()).toISOString(),
      schemaVersion: 1 as const,
    };
  }
}
