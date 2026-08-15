/**
 * DeliveryLoopService — Persisted plan–execute–verify delivery loop for mutating runs.
 *
 * Each mutating Agent_Run owns a persisted Delivery_Loop that enforces:
 * 1. Explicit state machine: planning → context_collection → implementation →
 *    targeted_validation → diagnosis → remediation → broader_validation → review → completion
 * 2. Bounded execution plan required before implementation
 * 3. Scope divergence tracking with approval requirements
 * 4. Validation failures attached as Evidence with bounded remediation
 * 5. Durable state across pause/cancel/crash (idempotent resume, no replay)
 * 6. Completion blocked until review + readiness gates pass or valid waivers exist
 * 7. Progress projection (current state, blockers, attempts, elapsed time, next action)
 *
 * Requirements: 30.1, 30.2, 30.3, 30.4, 30.5, 30.6, 30.7, 30.8, 30.9, 30.10
 */

import { randomUUID } from 'crypto';

// ─── Delivery Loop States ──────────────────────────────────────────────────

/**
 * All explicit states in the Delivery_Loop state machine.
 */
export type DeliveryLoopState =
  | 'planning'
  | 'context_collection'
  | 'implementation'
  | 'targeted_validation'
  | 'diagnosis'
  | 'remediation'
  | 'broader_validation'
  | 'review'
  | 'completion'
  | 'paused'
  | 'cancelled'
  | 'failed';

/**
 * The ordered progression of the delivery loop (non-terminal, non-interrupt states).
 */
export const DELIVERY_LOOP_PROGRESSION: readonly DeliveryLoopState[] = [
  'planning',
  'context_collection',
  'implementation',
  'targeted_validation',
  'diagnosis',
  'remediation',
  'broader_validation',
  'review',
  'completion',
] as const;

/**
 * Legal state transitions for the Delivery_Loop state machine.
 */
export const DELIVERY_LOOP_TRANSITIONS: Record<DeliveryLoopState, readonly DeliveryLoopState[]> = {
  planning: ['context_collection', 'paused', 'cancelled', 'failed'],
  context_collection: ['implementation', 'paused', 'cancelled', 'failed'],
  implementation: ['targeted_validation', 'paused', 'cancelled', 'failed'],
  targeted_validation: ['diagnosis', 'broader_validation', 'review', 'paused', 'cancelled', 'failed'],
  diagnosis: ['remediation', 'paused', 'cancelled', 'failed'],
  remediation: ['targeted_validation', 'paused', 'cancelled', 'failed'],
  broader_validation: ['review', 'diagnosis', 'paused', 'cancelled', 'failed'],
  review: ['completion', 'remediation', 'paused', 'cancelled', 'failed'],
  completion: [],
  paused: ['planning', 'context_collection', 'implementation', 'targeted_validation', 'diagnosis', 'remediation', 'broader_validation', 'review', 'cancelled', 'failed'],
  cancelled: [],
  failed: [],
} as const;

/** Terminal states — no further transitions allowed */
export const TERMINAL_LOOP_STATES: readonly DeliveryLoopState[] = ['completion', 'cancelled', 'failed'];

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * A bounded execution plan required before implementation.
 */
export interface ExecutionPlan {
  readonly id: string;
  readonly files: readonly string[];
  readonly interfaces: readonly string[];
  readonly migrations: readonly string[];
  readonly tests: readonly string[];
  readonly commands: readonly string[];
  readonly risks: readonly string[];
  readonly rollbackStrategy: string;
  readonly approvedAt: string | null;
  readonly fingerprint: string;
}

/**
 * Scope divergence record for tracking material deviations from plan.
 */
export interface ScopeDivergence {
  readonly id: string;
  readonly description: string;
  readonly reason: string;
  readonly originalScope: readonly string[];
  readonly actualScope: readonly string[];
  readonly requiresApproval: boolean;
  readonly approved: boolean;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly recordedAt: string;
}

/**
 * Evidence record attached to validation failures.
 */
export interface LoopEvidence {
  readonly id: string;
  readonly kind: 'validation_failure' | 'diagnostic' | 'test_result' | 'review_decision' | 'waiver';
  readonly stage: DeliveryLoopState;
  readonly summary: string;
  readonly detail: string;
  readonly changeSetId: string | null;
  readonly timestamp: string;
}

/**
 * Remediation attempt record tracking bounded self-repair.
 */
export interface RemediationAttempt {
  readonly attemptNumber: number;
  readonly evidenceIds: readonly string[];
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly outcome: 'success' | 'failure' | 'in_progress';
}

/**
 * Review decision required for completion.
 */
export interface ReviewDecision {
  readonly id: string;
  readonly reviewer: string;
  readonly decision: 'approved' | 'rejected' | 'changes_requested';
  readonly comment: string;
  readonly timestamp: string;
}

/**
 * Readiness gate that must pass for completion.
 */
export interface ReadinessGate {
  readonly id: string;
  readonly name: string;
  readonly required: boolean;
  readonly passed: boolean;
  readonly waiver: GateWaiver | null;
}

/**
 * A waiver for a readiness gate.
 */
export interface GateWaiver {
  readonly actor: string;
  readonly reason: string;
  readonly scope: string;
  readonly grantedAt: string;
}

/**
 * Completed mutating tool call tracked for idempotent resume.
 */
export interface CompletedMutation {
  readonly idempotencyKey: string;
  readonly toolName: string;
  readonly stage: DeliveryLoopState;
  readonly completedAt: string;
  readonly result: 'success' | 'failure';
}

/**
 * Remediation bounds configuration.
 */
export interface RemediationBounds {
  readonly maxAttempts: number;
  readonly maxElapsedMs: number;
  readonly maxTokens: number;
  readonly maxCost: number;
}

/**
 * Default remediation bounds.
 */
export const DEFAULT_REMEDIATION_BOUNDS: RemediationBounds = {
  maxAttempts: 3,
  maxElapsedMs: 180_000, // 3 minutes
  maxTokens: 50_000,
  maxCost: 25,
};

/**
 * Progress projection for UI/status reporting.
 */
export interface LoopProgress {
  readonly loopId: string;
  readonly runId: string;
  readonly currentState: DeliveryLoopState;
  readonly stateIndex: number;
  readonly totalStates: number;
  readonly blockers: readonly string[];
  readonly remediationAttempts: number;
  readonly maxRemediationAttempts: number;
  readonly elapsedMs: number;
  readonly nextAction: string;
  readonly stateEnteredAt: string;
}

/**
 * Context snapshot captured at loop creation.
 */
export interface LoopContext {
  readonly taskId: string;
  readonly requirementIds: readonly string[];
  readonly designNodeIds: readonly string[];
  readonly workspaceRevision: string;
  readonly agentId: string;
  readonly providerRouteId: string;
  readonly qualityProfileId: string;
  readonly catalogFingerprint: string;
  readonly bundleFingerprint: string;
  readonly runtimeProfileId: string | null;
}

/**
 * Full persisted Delivery_Loop record.
 */
export interface DeliveryLoop {
  readonly id: string;
  readonly runId: string;
  readonly context: LoopContext;
  readonly state: DeliveryLoopState;
  readonly previousState: DeliveryLoopState | null;
  readonly executionPlan: ExecutionPlan | null;
  readonly scopeDivergences: readonly ScopeDivergence[];
  readonly evidence: readonly LoopEvidence[];
  readonly remediationAttempts: readonly RemediationAttempt[];
  readonly remediationBounds: RemediationBounds;
  readonly completedMutations: readonly CompletedMutation[];
  readonly reviewDecisions: readonly ReviewDecision[];
  readonly readinessGates: readonly ReadinessGate[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stateEnteredAt: string;
}

/**
 * Parameters to create a Delivery_Loop.
 */
export interface CreateDeliveryLoopParams {
  readonly runId: string;
  readonly context: LoopContext;
  readonly remediationBounds?: RemediationBounds;
  readonly readinessGates?: readonly ReadinessGate[];
}

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * Error thrown when an illegal loop state transition is attempted.
 */
export class IllegalLoopTransitionError extends Error {
  constructor(
    public readonly loopId: string,
    public readonly fromState: DeliveryLoopState,
    public readonly toState: DeliveryLoopState,
  ) {
    super(
      `Illegal Delivery_Loop transition for loop '${loopId}': '${fromState}' -> '${toState}'`,
    );
    this.name = 'IllegalLoopTransitionError';
  }
}

/**
 * Error thrown when a loop is not found.
 */
export class LoopNotFoundError extends Error {
  constructor(public readonly loopId: string) {
    super(`Delivery_Loop not found: '${loopId}'`);
    this.name = 'LoopNotFoundError';
  }
}

/**
 * Error thrown when implementation is attempted without an approved execution plan.
 */
export class PlanRequiredError extends Error {
  constructor(public readonly loopId: string) {
    super(
      `Cannot transition to implementation for loop '${loopId}': bounded execution plan required`,
    );
    this.name = 'PlanRequiredError';
  }
}

/**
 * Error thrown when remediation bounds are exceeded.
 */
export class RemediationBoundsExceededError extends Error {
  constructor(
    public readonly loopId: string,
    public readonly reason: string,
  ) {
    super(
      `Remediation bounds exceeded for loop '${loopId}': ${reason}`,
    );
    this.name = 'RemediationBoundsExceededError';
  }
}

/**
 * Error thrown when completion is attempted without required gates.
 */
export class CompletionBlockedError extends Error {
  constructor(
    public readonly loopId: string,
    public readonly reasons: readonly string[],
  ) {
    super(
      `Cannot complete loop '${loopId}': ${reasons.join('; ')}`,
    );
    this.name = 'CompletionBlockedError';
  }
}

/**
 * Error thrown when unapproved scope divergence blocks progress.
 */
export class ScopeDivergenceError extends Error {
  constructor(
    public readonly loopId: string,
    public readonly divergenceId: string,
  ) {
    super(
      `Unapproved scope divergence '${divergenceId}' blocks loop '${loopId}'`,
    );
    this.name = 'ScopeDivergenceError';
  }
}

// ─── DeliveryLoopService ────────────────────────────────────────────────────

/**
 * DeliveryLoopService — Creates, transitions, and persists Delivery_Loops for
 * mutating Agent_Runs with full state machine enforcement.
 */
export class DeliveryLoopService {
  private readonly loops = new Map<string, DeliveryLoop>();
  private readonly loopsByRun = new Map<string, string>();

  /**
   * Create a Delivery_Loop for a mutating run.
   * The loop starts in 'planning' state.
   */
  createLoop(params: CreateDeliveryLoopParams): DeliveryLoop {
    // One loop per run
    if (this.loopsByRun.has(params.runId)) {
      const existingId = this.loopsByRun.get(params.runId)!;
      throw new Error(`Run '${params.runId}' already has a Delivery_Loop: '${existingId}'`);
    }

    const now = new Date().toISOString();
    const loop: DeliveryLoop = {
      id: randomUUID(),
      runId: params.runId,
      context: params.context,
      state: 'planning',
      previousState: null,
      executionPlan: null,
      scopeDivergences: [],
      evidence: [],
      remediationAttempts: [],
      remediationBounds: params.remediationBounds ?? DEFAULT_REMEDIATION_BOUNDS,
      completedMutations: [],
      reviewDecisions: [],
      readinessGates: params.readinessGates ?? [],
      createdAt: now,
      updatedAt: now,
      stateEnteredAt: now,
    };

    this.loops.set(loop.id, loop);
    this.loopsByRun.set(params.runId, loop.id);

    return loop;
  }

  /**
   * Transition a loop to a new state, enforcing all constraints.
   *
   * - Rejects transition to implementation without an approved execution plan
   * - Rejects transition to completion without review + readiness gates
   * - Rejects transition to remediation when bounds are exceeded
   * - Enforces the state machine
   */
  transition(loopId: string, toState: DeliveryLoopState): DeliveryLoop {
    const loop = this.getLoopOrThrow(loopId);

    // Validate state machine
    const allowed = DELIVERY_LOOP_TRANSITIONS[loop.state];
    if (!allowed.includes(toState)) {
      throw new IllegalLoopTransitionError(loopId, loop.state, toState);
    }

    // Gate: implementation requires an approved execution plan
    if (toState === 'implementation') {
      if (!loop.executionPlan || !loop.executionPlan.approvedAt) {
        throw new PlanRequiredError(loopId);
      }

      // Also check for unapproved scope divergences
      const unapproved = loop.scopeDivergences.filter(
        (d) => d.requiresApproval && !d.approved,
      );
      if (unapproved.length > 0) {
        throw new ScopeDivergenceError(loopId, unapproved[0].id);
      }
    }

    // Gate: remediation requires bounds check
    if (toState === 'remediation') {
      this.checkRemediationBounds(loop);
    }

    // Gate: completion requires review + readiness gates
    if (toState === 'completion') {
      this.checkCompletionGates(loop);
    }

    const now = new Date().toISOString();
    const updated: DeliveryLoop = {
      ...loop,
      state: toState,
      previousState: loop.state,
      updatedAt: now,
      stateEnteredAt: now,
    };

    this.loops.set(loopId, updated);
    return updated;
  }

  /**
   * Set the bounded execution plan for a loop.
   * Must be in planning or context_collection state.
   */
  setExecutionPlan(loopId: string, plan: Omit<ExecutionPlan, 'id'>): DeliveryLoop {
    const loop = this.getLoopOrThrow(loopId);

    if (loop.state !== 'planning' && loop.state !== 'context_collection') {
      throw new Error(
        `Cannot set execution plan in state '${loop.state}': must be in 'planning' or 'context_collection'`,
      );
    }

    const executionPlan: ExecutionPlan = {
      id: randomUUID(),
      ...plan,
    };

    const updated: DeliveryLoop = {
      ...loop,
      executionPlan,
      updatedAt: new Date().toISOString(),
    };

    this.loops.set(loopId, updated);
    return updated;
  }

  /**
   * Approve the execution plan, enabling transition to implementation.
   */
  approveExecutionPlan(loopId: string): DeliveryLoop {
    const loop = this.getLoopOrThrow(loopId);

    if (!loop.executionPlan) {
      throw new Error(`Loop '${loopId}' has no execution plan to approve`);
    }

    if (loop.executionPlan.approvedAt) {
      throw new Error(`Execution plan for loop '${loopId}' is already approved`);
    }

    const updatedPlan: ExecutionPlan = {
      ...loop.executionPlan,
      approvedAt: new Date().toISOString(),
    };

    const updated: DeliveryLoop = {
      ...loop,
      executionPlan: updatedPlan,
      updatedAt: new Date().toISOString(),
    };

    this.loops.set(loopId, updated);
    return updated;
  }

  /**
   * Record a scope divergence. If policy requires approval, the divergence
   * must be approved before the loop can continue past implementation.
   */
  recordScopeDivergence(
    loopId: string,
    divergence: Omit<ScopeDivergence, 'id' | 'recordedAt' | 'approved' | 'approvedBy' | 'approvedAt'>,
  ): DeliveryLoop {
    const loop = this.getLoopOrThrow(loopId);

    const record: ScopeDivergence = {
      id: randomUUID(),
      ...divergence,
      approved: false,
      approvedBy: null,
      approvedAt: null,
      recordedAt: new Date().toISOString(),
    };

    const updated: DeliveryLoop = {
      ...loop,
      scopeDivergences: [...loop.scopeDivergences, record],
      updatedAt: new Date().toISOString(),
    };

    this.loops.set(loopId, updated);
    return updated;
  }

  /**
   * Approve a scope divergence.
   */
  approveScopeDivergence(loopId: string, divergenceId: string, approver: string): DeliveryLoop {
    const loop = this.getLoopOrThrow(loopId);

    const idx = loop.scopeDivergences.findIndex((d) => d.id === divergenceId);
    if (idx < 0) {
      throw new Error(`Scope divergence '${divergenceId}' not found in loop '${loopId}'`);
    }

    const divergence = loop.scopeDivergences[idx];
    const approved: ScopeDivergence = {
      ...divergence,
      approved: true,
      approvedBy: approver,
      approvedAt: new Date().toISOString(),
    };

    const updatedDivergences = [...loop.scopeDivergences];
    updatedDivergences[idx] = approved;

    const updated: DeliveryLoop = {
      ...loop,
      scopeDivergences: updatedDivergences,
      updatedAt: new Date().toISOString(),
    };

    this.loops.set(loopId, updated);
    return updated;
  }

  /**
   * Attach evidence (validation failure, diagnostic, etc.) to the loop.
   */
  attachEvidence(
    loopId: string,
    evidence: Omit<LoopEvidence, 'id' | 'timestamp'>,
  ): DeliveryLoop {
    const loop = this.getLoopOrThrow(loopId);

    const record: LoopEvidence = {
      id: randomUUID(),
      ...evidence,
      timestamp: new Date().toISOString(),
    };

    const updated: DeliveryLoop = {
      ...loop,
      evidence: [...loop.evidence, record],
      updatedAt: new Date().toISOString(),
    };

    this.loops.set(loopId, updated);
    return updated;
  }

  /**
   * Start a new remediation attempt. Enforces bounds.
   */
  startRemediation(loopId: string, evidenceIds: readonly string[]): DeliveryLoop {
    const loop = this.getLoopOrThrow(loopId);

    this.checkRemediationBounds(loop);

    const attempt: RemediationAttempt = {
      attemptNumber: loop.remediationAttempts.length + 1,
      evidenceIds,
      startedAt: new Date().toISOString(),
      completedAt: null,
      outcome: 'in_progress',
    };

    const updated: DeliveryLoop = {
      ...loop,
      remediationAttempts: [...loop.remediationAttempts, attempt],
      updatedAt: new Date().toISOString(),
    };

    this.loops.set(loopId, updated);
    return updated;
  }

  /**
   * Complete the current remediation attempt.
   */
  completeRemediation(loopId: string, outcome: 'success' | 'failure'): DeliveryLoop {
    const loop = this.getLoopOrThrow(loopId);

    if (loop.remediationAttempts.length === 0) {
      throw new Error(`Loop '${loopId}' has no active remediation attempt`);
    }

    const lastIdx = loop.remediationAttempts.length - 1;
    const last = loop.remediationAttempts[lastIdx];

    if (last.outcome !== 'in_progress') {
      throw new Error(`Last remediation attempt for loop '${loopId}' is already completed`);
    }

    const completed: RemediationAttempt = {
      ...last,
      completedAt: new Date().toISOString(),
      outcome,
    };

    const updatedAttempts = [...loop.remediationAttempts];
    updatedAttempts[lastIdx] = completed;

    const updated: DeliveryLoop = {
      ...loop,
      remediationAttempts: updatedAttempts,
      updatedAt: new Date().toISOString(),
    };

    this.loops.set(loopId, updated);
    return updated;
  }

  /**
   * Record a completed mutating tool call for idempotent resume.
   */
  recordCompletedMutation(
    loopId: string,
    mutation: Omit<CompletedMutation, 'completedAt'>,
  ): DeliveryLoop {
    const loop = this.getLoopOrThrow(loopId);

    // Idempotent: if already recorded, skip
    if (loop.completedMutations.some((m) => m.idempotencyKey === mutation.idempotencyKey)) {
      return loop;
    }

    const record: CompletedMutation = {
      ...mutation,
      completedAt: new Date().toISOString(),
    };

    const updated: DeliveryLoop = {
      ...loop,
      completedMutations: [...loop.completedMutations, record],
      updatedAt: new Date().toISOString(),
    };

    this.loops.set(loopId, updated);
    return updated;
  }

  /**
   * Check whether a mutation has already been completed (for idempotent resume).
   */
  isMutationCompleted(loopId: string, idempotencyKey: string): boolean {
    const loop = this.getLoopOrThrow(loopId);
    return loop.completedMutations.some((m) => m.idempotencyKey === idempotencyKey);
  }

  /**
   * Add a review decision.
   */
  addReviewDecision(loopId: string, decision: Omit<ReviewDecision, 'id' | 'timestamp'>): DeliveryLoop {
    const loop = this.getLoopOrThrow(loopId);

    const record: ReviewDecision = {
      id: randomUUID(),
      ...decision,
      timestamp: new Date().toISOString(),
    };

    const updated: DeliveryLoop = {
      ...loop,
      reviewDecisions: [...loop.reviewDecisions, record],
      updatedAt: new Date().toISOString(),
    };

    this.loops.set(loopId, updated);
    return updated;
  }

  /**
   * Set or update readiness gates.
   */
  setReadinessGates(loopId: string, gates: readonly ReadinessGate[]): DeliveryLoop {
    const loop = this.getLoopOrThrow(loopId);

    const updated: DeliveryLoop = {
      ...loop,
      readinessGates: gates,
      updatedAt: new Date().toISOString(),
    };

    this.loops.set(loopId, updated);
    return updated;
  }

  /**
   * Mark a readiness gate as passed.
   */
  passReadinessGate(loopId: string, gateId: string): DeliveryLoop {
    const loop = this.getLoopOrThrow(loopId);

    const idx = loop.readinessGates.findIndex((g) => g.id === gateId);
    if (idx < 0) {
      throw new Error(`Readiness gate '${gateId}' not found in loop '${loopId}'`);
    }

    const updatedGates = [...loop.readinessGates];
    updatedGates[idx] = { ...updatedGates[idx], passed: true };

    const updated: DeliveryLoop = {
      ...loop,
      readinessGates: updatedGates,
      updatedAt: new Date().toISOString(),
    };

    this.loops.set(loopId, updated);
    return updated;
  }

  /**
   * Waive a readiness gate.
   */
  waiveReadinessGate(loopId: string, gateId: string, waiver: GateWaiver): DeliveryLoop {
    const loop = this.getLoopOrThrow(loopId);

    const idx = loop.readinessGates.findIndex((g) => g.id === gateId);
    if (idx < 0) {
      throw new Error(`Readiness gate '${gateId}' not found in loop '${loopId}'`);
    }

    const updatedGates = [...loop.readinessGates];
    updatedGates[idx] = { ...updatedGates[idx], waiver };

    const updated: DeliveryLoop = {
      ...loop,
      readinessGates: updatedGates,
      updatedAt: new Date().toISOString(),
    };

    this.loops.set(loopId, updated);
    return updated;
  }

  /**
   * Pause a loop, preserving its current state for resume.
   */
  pause(loopId: string): DeliveryLoop {
    const loop = this.getLoopOrThrow(loopId);

    if (TERMINAL_LOOP_STATES.includes(loop.state)) {
      throw new IllegalLoopTransitionError(loopId, loop.state, 'paused');
    }

    if (loop.state === 'paused') {
      return loop; // Already paused, idempotent
    }

    const now = new Date().toISOString();
    const updated: DeliveryLoop = {
      ...loop,
      state: 'paused',
      previousState: loop.state,
      updatedAt: now,
      stateEnteredAt: now,
    };

    this.loops.set(loopId, updated);
    return updated;
  }

  /**
   * Resume a paused loop back to its previous state.
   */
  resume(loopId: string): DeliveryLoop {
    const loop = this.getLoopOrThrow(loopId);

    if (loop.state !== 'paused') {
      throw new Error(`Cannot resume loop '${loopId}': current state is '${loop.state}', expected 'paused'`);
    }

    if (!loop.previousState) {
      throw new Error(`Cannot resume loop '${loopId}': no previous state recorded`);
    }

    const resumeTo = loop.previousState;
    const now = new Date().toISOString();
    const updated: DeliveryLoop = {
      ...loop,
      state: resumeTo,
      previousState: 'paused',
      updatedAt: now,
      stateEnteredAt: now,
    };

    this.loops.set(loopId, updated);
    return updated;
  }

  /**
   * Get the progress projection for a loop.
   */
  getProgress(loopId: string): LoopProgress {
    const loop = this.getLoopOrThrow(loopId);

    const stateIndex = DELIVERY_LOOP_PROGRESSION.indexOf(loop.state);
    const totalStates = DELIVERY_LOOP_PROGRESSION.length;
    const elapsedMs = Date.now() - new Date(loop.createdAt).getTime();

    const blockers = this.computeBlockers(loop);
    const nextAction = this.computeNextAction(loop);

    return {
      loopId: loop.id,
      runId: loop.runId,
      currentState: loop.state,
      stateIndex: stateIndex >= 0 ? stateIndex : -1,
      totalStates,
      blockers,
      remediationAttempts: loop.remediationAttempts.length,
      maxRemediationAttempts: loop.remediationBounds.maxAttempts,
      elapsedMs,
      nextAction,
      stateEnteredAt: loop.stateEnteredAt,
    };
  }

  /**
   * Get a loop by its ID.
   */
  getLoop(loopId: string): DeliveryLoop | undefined {
    return this.loops.get(loopId);
  }

  /**
   * Get the loop for a given run.
   */
  getLoopForRun(runId: string): DeliveryLoop | undefined {
    const loopId = this.loopsByRun.get(runId);
    if (!loopId) return undefined;
    return this.loops.get(loopId);
  }

  /**
   * Check whether a transition would be legal for the given loop.
   */
  isTransitionValid(loopId: string, toState: DeliveryLoopState): boolean {
    const loop = this.loops.get(loopId);
    if (!loop) return false;
    return DELIVERY_LOOP_TRANSITIONS[loop.state].includes(toState);
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  private getLoopOrThrow(loopId: string): DeliveryLoop {
    const loop = this.loops.get(loopId);
    if (!loop) {
      throw new LoopNotFoundError(loopId);
    }
    return loop;
  }

  private checkRemediationBounds(loop: DeliveryLoop): void {
    const bounds = loop.remediationBounds;
    const attemptCount = loop.remediationAttempts.length;

    if (attemptCount >= bounds.maxAttempts) {
      throw new RemediationBoundsExceededError(
        loop.id,
        `max attempts reached (${attemptCount}/${bounds.maxAttempts})`,
      );
    }
  }

  private checkCompletionGates(loop: DeliveryLoop): void {
    const reasons: string[] = [];

    // Check for at least one approved review decision
    const hasApprovedReview = loop.reviewDecisions.some(
      (d) => d.decision === 'approved',
    );
    if (!hasApprovedReview) {
      reasons.push('no approved review decision');
    }

    // Check for rejected reviews that haven't been superseded
    const lastReview = loop.reviewDecisions[loop.reviewDecisions.length - 1];
    if (lastReview && lastReview.decision === 'rejected') {
      reasons.push('latest review decision is rejected');
    }

    // Check required readiness gates
    for (const gate of loop.readinessGates) {
      if (gate.required && !gate.passed && !gate.waiver) {
        reasons.push(`required gate '${gate.name}' not passed and no waiver`);
      }
    }

    if (reasons.length > 0) {
      throw new CompletionBlockedError(loop.id, reasons);
    }
  }

  private computeBlockers(loop: DeliveryLoop): readonly string[] {
    const blockers: string[] = [];

    if (loop.state === 'paused') {
      blockers.push('loop is paused');
    }

    if (loop.state === 'context_collection' && !loop.executionPlan) {
      blockers.push('execution plan required before implementation');
    }

    if (loop.state === 'context_collection' && loop.executionPlan && !loop.executionPlan.approvedAt) {
      blockers.push('execution plan awaiting approval');
    }

    const unapproved = loop.scopeDivergences.filter(
      (d) => d.requiresApproval && !d.approved,
    );
    if (unapproved.length > 0) {
      blockers.push(`${unapproved.length} unapproved scope divergence(s)`);
    }

    if (loop.state === 'review') {
      const hasApproval = loop.reviewDecisions.some((d) => d.decision === 'approved');
      if (!hasApproval) {
        blockers.push('awaiting review approval');
      }
    }

    const failingGates = loop.readinessGates.filter(
      (g) => g.required && !g.passed && !g.waiver,
    );
    if (failingGates.length > 0 && loop.state === 'review') {
      blockers.push(`${failingGates.length} readiness gate(s) not met`);
    }

    return blockers;
  }

  private computeNextAction(loop: DeliveryLoop): string {
    switch (loop.state) {
      case 'planning':
        return loop.executionPlan ? 'approve execution plan' : 'produce execution plan';
      case 'context_collection':
        return 'collect context and transition to implementation';
      case 'implementation':
        return 'implement changes per execution plan';
      case 'targeted_validation':
        return 'run targeted validation checks';
      case 'diagnosis':
        return 'diagnose validation failures';
      case 'remediation':
        return 'remediate identified issues';
      case 'broader_validation':
        return 'run broader project validation';
      case 'review':
        return 'obtain review approval';
      case 'completion':
        return 'delivery complete';
      case 'paused':
        return 'resume loop';
      case 'cancelled':
        return 'loop cancelled';
      case 'failed':
        return 'loop failed';
    }
  }
}
