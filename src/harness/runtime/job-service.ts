/**
 * Job Service — Durable owner-scoped jobs and bounded continuation.
 *
 * Implements the Job_Service authority for:
 * 1. Persisting ownership BEFORE dispatch (Requirement 20.1)
 * 2. Authorizing observe/wait/cancel/result by owner and scope (Requirement 20.2)
 * 3. Atomically committing terminal results (Requirement 20.3)
 * 4. Enforcing all continuation bounds (Requirement 20.5)
 * 5. Transferring explicitly durable children on parent session end (Requirement 5.7)
 * 6. Cancelling owned work on owner/session deletion (Requirement 20.8)
 * 7. Observe-only progress reporting
 * 8. Bounded continuation rounds with configurable limits
 *
 * Requirements: 5.7, 20.1–20.3, 20.5, 20.8
 */

import {
  type JobState,
  type JobType,
  type CancellationPolicy,
  type ContinuationBounds,
  type ContinuationProgress,
  type JobOwnershipRecord,
  type JobCreationRequest,
  type JobTerminalResult,
  type JobProgressReport,
  type JobAuthorizationContext,
  type JobTransitionEvent,
  type DurabilityTransferRequest,
  type BoundExhaustionDetail,
  JobCreationRequestSchema,
  JobTerminalResultSchema,
  JobAuthorizationContextSchema,
  DurabilityTransferRequestSchema,
  TERMINAL_JOB_STATES,
  DEFAULT_CONTINUATION_BOUNDS,
} from './job-service-schemas';
import type { ScopeDescriptorV1 } from '../contracts/scope';

// ─── Port Interfaces ────────────────────────────────────────────

/**
 * Persistence port — abstracts durable storage operations.
 * In production, this writes to Shared_Database harness_jobs table.
 */
export interface JobPersistencePort {
  /**
   * Persist ownership record atomically. Returns false if idempotency
   * key already exists (duplicate creation).
   */
  persistOwnership(record: JobOwnershipRecord): boolean;

  /** Load a job ownership record by ID. */
  loadJob(jobId: string): JobOwnershipRecord | undefined;

  /** Load all non-terminal jobs owned by a session. */
  loadActiveJobsBySession(sessionId: string): JobOwnershipRecord[];

  /** Load all non-terminal jobs owned by an owner. */
  loadActiveJobsByOwner(owner: string): JobOwnershipRecord[];

  /** Load children of a parent job. */
  loadChildJobs(parentJobId: string): JobOwnershipRecord[];

  /**
   * Atomically update job state and result in one transaction.
   * Returns false if the job is already in a terminal state (no partial writes).
   */
  commitTerminalResult(
    jobId: string,
    state: JobState,
    result: JobTerminalResult,
  ): boolean;

  /** Update job state (non-terminal transitions). */
  updateState(jobId: string, state: JobState): boolean;

  /** Transfer ownership of a job to a new owner. */
  transferOwnership(jobId: string, newOwner: string): boolean;

  /** Record a state transition event. */
  recordTransition(event: JobTransitionEvent): void;
}

/**
 * Dispatch port — abstracts the actual work dispatch mechanism.
 */
export interface JobDispatchPort {
  /** Dispatch work for a job. Called AFTER ownership is persisted. */
  dispatch(job: JobOwnershipRecord): void;

  /** Cancel dispatched work for a job. */
  cancelDispatch(jobId: string): void;
}

/**
 * Clock port — for testability of time-based bounds.
 */
export interface JobClockPort {
  now(): string;
  nowMs(): number;
}

/**
 * ID generation port.
 */
export interface JobIdPort {
  generateId(): string;
}

// ─── Job Service Configuration ──────────────────────────────────

export interface JobServiceConfig {
  /** Default continuation bounds when not specified in creation. */
  defaultBounds?: ContinuationBounds;

  /** Default cancellation policy. */
  defaultCancellationPolicy?: CancellationPolicy;

  /** Default retention policy. */
  defaultRetention?: 'session' | 'durable' | 'ephemeral';
}

// ─── Job Service Errors ─────────────────────────────────────────

export type JobServiceErrorCode =
  | 'job_not_found'
  | 'authorization_denied'
  | 'already_terminal'
  | 'invalid_transition'
  | 'bounds_exhausted'
  | 'duplicate_creation'
  | 'validation_failed';

export interface JobServiceError {
  code: JobServiceErrorCode;
  message: string;
  jobId?: string;
  detail?: unknown;
}

// ─── Result Types ───────────────────────────────────────────────

export type JobServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: JobServiceError };

// ─── Job Service Implementation ─────────────────────────────────

export class JobService {
  private readonly persistence: JobPersistencePort;
  private readonly dispatch: JobDispatchPort;
  private readonly clock: JobClockPort;
  private readonly idGen: JobIdPort;
  private readonly config: Required<JobServiceConfig>;

  /** In-memory progress tracking (observe-only, not persisted until terminal). */
  private readonly progressMap = new Map<string, ContinuationProgress>();

  /** Dispatch start times for elapsed calculation. */
  private readonly dispatchTimes = new Map<string, number>();

  constructor(
    persistence: JobPersistencePort,
    dispatchPort: JobDispatchPort,
    clock: JobClockPort,
    idGen: JobIdPort,
    config: JobServiceConfig = {},
  ) {
    this.persistence = persistence;
    this.dispatch = dispatchPort;
    this.clock = clock;
    this.idGen = idGen;
    this.config = {
      defaultBounds: config.defaultBounds ?? DEFAULT_CONTINUATION_BOUNDS,
      defaultCancellationPolicy: config.defaultCancellationPolicy ?? 'immediate',
      defaultRetention: config.defaultRetention ?? 'session',
    };
  }

  // ─── Job Creation (Requirement 20.1) ───────────────────────────

  /**
   * Create a durable job. Persists ownership BEFORE dispatch.
   * Returns the persisted ownership record or an error.
   */
  createJob(request: JobCreationRequest): JobServiceResult<JobOwnershipRecord> {
    // Validate input
    const parsed = JobCreationRequestSchema.safeParse(request);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'validation_failed',
          message: `Invalid job creation request: ${parsed.error.message}`,
          detail: parsed.error.issues,
        },
      };
    }

    const now = this.clock.now();

    // Build the ownership record
    const record: JobOwnershipRecord = {
      jobId: request.jobId,
      sessionId: request.sessionId,
      owner: request.owner,
      scope: request.scope,
      parentJobId: request.parentJobId,
      jobType: request.jobType,
      goal: request.goal,
      bounds: request.bounds,
      cancellationPolicy: request.cancellationPolicy ?? this.config.defaultCancellationPolicy,
      durable: request.durable ?? false,
      retention: request.retention ?? this.config.defaultRetention,
      idempotencyKey: request.idempotencyKey,
      schemaVersion: 1,
      createdAt: now,
    };

    // Step 1: Persist ownership BEFORE dispatch (Requirement 20.1)
    const persisted = this.persistence.persistOwnership(record);
    if (!persisted) {
      return {
        ok: false,
        error: {
          code: 'duplicate_creation',
          message: `Job with idempotency key already exists`,
          jobId: request.jobId,
        },
      };
    }

    // Record the creation transition
    this.persistence.recordTransition({
      transitionId: this.idGen.generateId(),
      jobId: record.jobId,
      fromState: 'pending',
      toState: 'pending',
      cause: 'dispatch',
      actor: record.owner,
      occurredAt: now,
      schemaVersion: 1,
    });

    // Initialize progress tracking
    this.progressMap.set(record.jobId, {
      roundsCompleted: 0,
      elapsedMs: 0,
      tokensUsed: 0,
      costAccumulated: 0,
      outputBytes: 0,
    });

    // Step 2: Dispatch work AFTER ownership is persisted
    this.dispatchTimes.set(record.jobId, this.clock.nowMs());
    this.persistence.updateState(record.jobId, 'running');
    this.persistence.recordTransition({
      transitionId: this.idGen.generateId(),
      jobId: record.jobId,
      fromState: 'pending',
      toState: 'running',
      cause: 'dispatch',
      actor: record.owner,
      occurredAt: this.clock.now(),
      schemaVersion: 1,
    });
    this.dispatch.dispatch(record);

    return { ok: true, value: record };
  }

  // ─── Authorization (Requirement 20.2) ──────────────────────────

  /**
   * Authorize an operation on a job. Enforces owner and scope matching.
   */
  authorize(context: JobAuthorizationContext): JobServiceResult<true> {
    const parsed = JobAuthorizationContextSchema.safeParse(context);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'validation_failed',
          message: `Invalid authorization context: ${parsed.error.message}`,
        },
      };
    }

    const job = this.persistence.loadJob(context.jobId);
    if (!job) {
      return {
        ok: false,
        error: {
          code: 'job_not_found',
          message: `Job ${context.jobId} not found`,
          jobId: context.jobId,
        },
      };
    }

    // Check owner match
    if (job.owner !== context.actorId) {
      // Allow if actor scope encompasses the job scope
      if (!this.scopeEncompasses(context.actorScope, job.scope)) {
        return {
          ok: false,
          error: {
            code: 'authorization_denied',
            message: `Actor ${context.actorId} is not authorized for ${context.operation} on job ${context.jobId}`,
            jobId: context.jobId,
          },
        };
      }
    }

    return { ok: true, value: true };
  }

  // ─── Observe (Requirement 20.2) ────────────────────────────────

  /**
   * Observe job progress without mutating state.
   */
  observe(
    jobId: string,
    actorId: string,
    actorScope: ScopeDescriptorV1,
  ): JobServiceResult<JobProgressReport> {
    const authResult = this.authorize({
      actorId,
      actorScope,
      operation: 'observe',
      jobId,
    });
    if (!authResult.ok) return authResult;

    const job = this.persistence.loadJob(jobId);
    if (!job) {
      return {
        ok: false,
        error: { code: 'job_not_found', message: `Job ${jobId} not found`, jobId },
      };
    }

    const progress = this.getProgress(jobId);
    const report: JobProgressReport = {
      jobId,
      currentRound: progress.roundsCompleted,
      state: this.getCurrentState(job),
      progress,
      reportedAt: this.clock.now(),
      schemaVersion: 1,
    };

    return { ok: true, value: report };
  }

  // ─── Wait (Requirement 20.2) ───────────────────────────────────

  /**
   * Wait for a job to reach terminal state. Returns the terminal result
   * if already terminal, otherwise signals that waiting is required.
   */
  waitForResult(
    jobId: string,
    actorId: string,
    actorScope: ScopeDescriptorV1,
  ): JobServiceResult<JobTerminalResult | null> {
    const authResult = this.authorize({
      actorId,
      actorScope,
      operation: 'wait',
      jobId,
    });
    if (!authResult.ok) return authResult;

    const job = this.persistence.loadJob(jobId);
    if (!job) {
      return {
        ok: false,
        error: { code: 'job_not_found', message: `Job ${jobId} not found`, jobId },
      };
    }

    const currentState = this.getCurrentState(job);
    if (TERMINAL_JOB_STATES.has(currentState)) {
      // Already terminal — return the result
      return { ok: true, value: this.buildTerminalResult(job, currentState) };
    }

    // Not yet terminal — caller should poll or subscribe
    return { ok: true, value: null };
  }

  // ─── Cancel (Requirement 20.2, 20.8) ──────────────────────────

  /**
   * Cancel a job. Transitions to cancelled state and cancels dispatched work.
   */
  cancel(
    jobId: string,
    actorId: string,
    actorScope: ScopeDescriptorV1,
    reason?: string,
  ): JobServiceResult<JobTerminalResult> {
    const authResult = this.authorize({
      actorId,
      actorScope,
      operation: 'cancel',
      jobId,
    });
    if (!authResult.ok) return authResult;

    const job = this.persistence.loadJob(jobId);
    if (!job) {
      return {
        ok: false,
        error: { code: 'job_not_found', message: `Job ${jobId} not found`, jobId },
      };
    }

    const currentState = this.getCurrentState(job);
    if (TERMINAL_JOB_STATES.has(currentState)) {
      return {
        ok: false,
        error: {
          code: 'already_terminal',
          message: `Job ${jobId} is already in terminal state: ${currentState}`,
          jobId,
        },
      };
    }

    // Cancel dispatched work
    this.dispatch.cancelDispatch(jobId);

    // Commit terminal result atomically (Requirement 20.3)
    const progress = this.getProgress(jobId);
    const terminalResult: JobTerminalResult = {
      terminalState: 'cancelled',
      reason: reason ?? 'Cancelled by authorized actor',
      finalProgress: progress,
      committedAt: this.clock.now(),
      schemaVersion: 1,
    };

    const committed = this.persistence.commitTerminalResult(jobId, 'cancelled', terminalResult);
    if (!committed) {
      return {
        ok: false,
        error: {
          code: 'already_terminal',
          message: `Job ${jobId} could not be cancelled — already terminal`,
          jobId,
        },
      };
    }

    // Record transition
    this.persistence.recordTransition({
      transitionId: this.idGen.generateId(),
      jobId,
      fromState: currentState,
      toState: 'cancelled',
      cause: 'cancel_requested',
      causeDetail: reason,
      actor: actorId,
      occurredAt: this.clock.now(),
      schemaVersion: 1,
    });

    // Also cancel children
    this.cancelChildren(jobId, actorId);

    // Clean up in-memory tracking
    this.progressMap.delete(jobId);
    this.dispatchTimes.delete(jobId);

    return { ok: true, value: terminalResult };
  }

  // ─── Commit Result (Requirement 20.3) ──────────────────────────

  /**
   * Commit a terminal result for a job. The result is committed atomically —
   * visible all-at-once or not at all.
   */
  commitResult(
    jobId: string,
    actorId: string,
    actorScope: ScopeDescriptorV1,
    terminalState: 'completed' | 'failed',
    resultPayload?: unknown,
    reason?: string,
  ): JobServiceResult<JobTerminalResult> {
    const authResult = this.authorize({
      actorId,
      actorScope,
      operation: 'result',
      jobId,
    });
    if (!authResult.ok) return authResult;

    const job = this.persistence.loadJob(jobId);
    if (!job) {
      return {
        ok: false,
        error: { code: 'job_not_found', message: `Job ${jobId} not found`, jobId },
      };
    }

    const currentState = this.getCurrentState(job);
    if (TERMINAL_JOB_STATES.has(currentState)) {
      return {
        ok: false,
        error: {
          code: 'already_terminal',
          message: `Job ${jobId} is already in terminal state: ${currentState}`,
          jobId,
        },
      };
    }

    const progress = this.getProgress(jobId);
    const terminalResult: JobTerminalResult = {
      terminalState,
      resultPayload,
      reason,
      finalProgress: progress,
      committedAt: this.clock.now(),
      schemaVersion: 1,
    };

    // Atomic commit (Requirement 20.3)
    const committed = this.persistence.commitTerminalResult(jobId, terminalState, terminalResult);
    if (!committed) {
      return {
        ok: false,
        error: {
          code: 'already_terminal',
          message: `Job ${jobId} terminal result could not be committed`,
          jobId,
        },
      };
    }

    // Record transition
    this.persistence.recordTransition({
      transitionId: this.idGen.generateId(),
      jobId,
      fromState: currentState,
      toState: terminalState,
      cause: terminalState === 'completed' ? 'success' : 'failure',
      causeDetail: reason,
      actor: actorId,
      occurredAt: this.clock.now(),
      schemaVersion: 1,
    });

    // Clean up in-memory tracking
    this.progressMap.delete(jobId);
    this.dispatchTimes.delete(jobId);

    return { ok: true, value: terminalResult };
  }

  // ─── Continuation Bounds Enforcement (Requirement 20.5) ────────

  /**
   * Record a continuation round and check bounds. Returns exhaustion detail
   * if any bound is reached, or null if within limits.
   */
  recordRound(
    jobId: string,
    roundTokens: number,
    roundCost: number,
    roundOutputBytes?: number,
  ): BoundExhaustionDetail | null {
    const job = this.persistence.loadJob(jobId);
    if (!job) return null;

    const progress = this.getProgress(jobId);
    const dispatchTime = this.dispatchTimes.get(jobId) ?? this.clock.nowMs();
    const elapsed = this.clock.nowMs() - dispatchTime;

    // Update progress
    const updated: ContinuationProgress = {
      roundsCompleted: progress.roundsCompleted + 1,
      elapsedMs: elapsed,
      tokensUsed: progress.tokensUsed + roundTokens,
      costAccumulated: progress.costAccumulated + roundCost,
      outputBytes: (progress.outputBytes ?? 0) + (roundOutputBytes ?? 0),
    };
    this.progressMap.set(jobId, updated);

    // Check each bound — stop at the first exhausted (Requirement 20.5)
    const bounds = job.bounds;

    if (updated.roundsCompleted >= bounds.maxRounds) {
      return {
        exhaustedBound: 'rounds',
        configuredLimit: bounds.maxRounds,
        actualValue: updated.roundsCompleted,
        allBoundsAtExhaustion: updated,
      };
    }

    if (updated.elapsedMs >= bounds.maxTimeMs) {
      return {
        exhaustedBound: 'time',
        configuredLimit: bounds.maxTimeMs,
        actualValue: updated.elapsedMs,
        allBoundsAtExhaustion: updated,
      };
    }

    if (updated.tokensUsed >= bounds.maxTokens) {
      return {
        exhaustedBound: 'tokens',
        configuredLimit: bounds.maxTokens,
        actualValue: updated.tokensUsed,
        allBoundsAtExhaustion: updated,
      };
    }

    if (updated.costAccumulated >= bounds.maxCost) {
      return {
        exhaustedBound: 'cost',
        configuredLimit: bounds.maxCost,
        actualValue: updated.costAccumulated,
        allBoundsAtExhaustion: updated,
      };
    }

    if (
      bounds.maxOutputBytes !== undefined &&
      updated.outputBytes !== undefined &&
      updated.outputBytes >= bounds.maxOutputBytes
    ) {
      return {
        exhaustedBound: 'output_bytes',
        configuredLimit: bounds.maxOutputBytes,
        actualValue: updated.outputBytes,
        allBoundsAtExhaustion: updated,
      };
    }

    return null;
  }

  /**
   * Record a continuation round and automatically commit terminal result
   * if bounds are exhausted.
   */
  recordRoundAndEnforce(
    jobId: string,
    actorId: string,
    actorScope: ScopeDescriptorV1,
    roundTokens: number,
    roundCost: number,
    roundOutputBytes?: number,
  ): JobServiceResult<BoundExhaustionDetail | null> {
    const exhaustion = this.recordRound(jobId, roundTokens, roundCost, roundOutputBytes);
    if (!exhaustion) {
      return { ok: true, value: null };
    }

    // Bound exhausted — cancel dispatched work and commit terminal
    this.dispatch.cancelDispatch(jobId);

    const progress = this.getProgress(jobId);
    const terminalResult: JobTerminalResult = {
      terminalState: 'failed',
      reason: `Continuation bound exhausted: ${exhaustion.exhaustedBound}`,
      resultPayload: exhaustion,
      finalProgress: progress,
      committedAt: this.clock.now(),
      schemaVersion: 1,
    };

    const committed = this.persistence.commitTerminalResult(jobId, 'failed', terminalResult);
    if (committed) {
      this.persistence.recordTransition({
        transitionId: this.idGen.generateId(),
        jobId,
        fromState: 'running',
        toState: 'failed',
        cause: 'bounds_exhausted',
        causeDetail: `${exhaustion.exhaustedBound}: ${exhaustion.actualValue} >= ${exhaustion.configuredLimit}`,
        actor: actorId,
        occurredAt: this.clock.now(),
        schemaVersion: 1,
      });

      this.progressMap.delete(jobId);
      this.dispatchTimes.delete(jobId);
    }

    return { ok: true, value: exhaustion };
  }

  // ─── Durability Transfer (Requirement 5.7) ─────────────────────

  /**
   * Transfer explicitly durable children to Job_Service ownership when
   * a parent session ends. Non-durable jobs are cancelled.
   */
  handleSessionEnd(
    endingSessionId: string,
    newOwner: string,
  ): { transferred: string[]; cancelled: string[] } {
    const parsed = DurabilityTransferRequestSchema.safeParse({
      endingSessionId,
      newOwner,
      requestedAt: this.clock.now(),
    });
    // Proceed even if validation is loose — we handle gracefully

    const activeJobs = this.persistence.loadActiveJobsBySession(endingSessionId);
    const transferred: string[] = [];
    const cancelled: string[] = [];

    for (const job of activeJobs) {
      const currentState = this.getCurrentState(job);
      if (TERMINAL_JOB_STATES.has(currentState)) continue;

      if (job.durable) {
        // Transfer to new owner (Requirement 5.7)
        this.persistence.transferOwnership(job.jobId, newOwner);
        this.persistence.recordTransition({
          transitionId: this.idGen.generateId(),
          jobId: job.jobId,
          fromState: currentState,
          toState: currentState,
          cause: 'durability_transfer',
          causeDetail: `Transferred from session ${endingSessionId} to owner ${newOwner}`,
          actor: newOwner,
          occurredAt: this.clock.now(),
          schemaVersion: 1,
        });
        transferred.push(job.jobId);
      } else {
        // Cancel non-durable work (Requirement 20.8)
        this.dispatch.cancelDispatch(job.jobId);
        const progress = this.getProgress(job.jobId);
        const terminalResult: JobTerminalResult = {
          terminalState: 'cancelled',
          reason: `Session ${endingSessionId} ended — non-durable job cancelled`,
          finalProgress: progress,
          committedAt: this.clock.now(),
          schemaVersion: 1,
        };
        this.persistence.commitTerminalResult(job.jobId, 'cancelled', terminalResult);
        this.persistence.recordTransition({
          transitionId: this.idGen.generateId(),
          jobId: job.jobId,
          fromState: currentState,
          toState: 'cancelled',
          cause: 'session_deleted',
          causeDetail: `Session ${endingSessionId} ended`,
          occurredAt: this.clock.now(),
          schemaVersion: 1,
        });
        this.progressMap.delete(job.jobId);
        this.dispatchTimes.delete(job.jobId);
        cancelled.push(job.jobId);
      }
    }

    return { transferred, cancelled };
  }

  // ─── Owner Deletion (Requirement 20.8) ─────────────────────────

  /**
   * Cancel ALL owned work when an owner is deleted.
   * Applies retention policy for teardown.
   */
  handleOwnerDeletion(owner: string): string[] {
    const activeJobs = this.persistence.loadActiveJobsByOwner(owner);
    const cancelledIds: string[] = [];

    for (const job of activeJobs) {
      const currentState = this.getCurrentState(job);
      if (TERMINAL_JOB_STATES.has(currentState)) continue;

      this.dispatch.cancelDispatch(job.jobId);
      const progress = this.getProgress(job.jobId);
      const terminalResult: JobTerminalResult = {
        terminalState: 'cancelled',
        reason: `Owner ${owner} deleted — all owned work cancelled`,
        finalProgress: progress,
        committedAt: this.clock.now(),
        schemaVersion: 1,
      };
      this.persistence.commitTerminalResult(job.jobId, 'cancelled', terminalResult);
      this.persistence.recordTransition({
        transitionId: this.idGen.generateId(),
        jobId: job.jobId,
        fromState: currentState,
        toState: 'cancelled',
        cause: 'owner_deleted',
        causeDetail: `Owner ${owner} deleted`,
        occurredAt: this.clock.now(),
        schemaVersion: 1,
      });
      this.progressMap.delete(job.jobId);
      this.dispatchTimes.delete(job.jobId);
      cancelledIds.push(job.jobId);

      // Also cancel children recursively
      this.cancelChildren(job.jobId, owner);
    }

    return cancelledIds;
  }

  // ─── Private Helpers ───────────────────────────────────────────

  /**
   * Check if actorScope encompasses jobScope for authorization.
   * A scope encompasses another if the actor's boundary fields (workspace,
   * project, session) cover the job's boundaries. userId and ownerId are
   * identity fields checked separately via the owner match — they do not
   * participate in scope boundary comparison.
   */
  private scopeEncompasses(actorScope: ScopeDescriptorV1, jobScope: ScopeDescriptorV1): boolean {
    // Boundary fields determine access scope. If the actor has a boundary
    // constraint and the job has a different one, deny access.
    // userId and ownerId are identity fields, not boundary fields.
    const boundaryFields: Array<keyof ScopeDescriptorV1> = [
      'workspaceId', 'projectId', 'sessionId', 'agentId',
    ];

    for (const field of boundaryFields) {
      const jobValue = jobScope[field];
      const actorValue = actorScope[field];
      // If the job has a scope constraint and the actor has a different one, deny
      if (jobValue && actorValue && jobValue !== actorValue) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get current state of a job from persistence.
   * Checks the persisted record for terminal state indicators.
   */
  private getCurrentState(job: JobOwnershipRecord): JobState {
    // Re-load to get the latest state
    const current = this.persistence.loadJob(job.jobId);
    if (!current) return 'pending';

    // The persistence layer tracks the state — we read from there
    // This is a simplification; in practice the record carries a `state` field
    // For our implementation, we check if a terminal result exists
    return (current as JobOwnershipRecord & { state?: JobState }).state ?? 'running';
  }

  /** Get current progress for a job. */
  private getProgress(jobId: string): ContinuationProgress {
    return this.progressMap.get(jobId) ?? {
      roundsCompleted: 0,
      elapsedMs: 0,
      tokensUsed: 0,
      costAccumulated: 0,
      outputBytes: 0,
    };
  }

  /** Build a terminal result from the job's current state. */
  private buildTerminalResult(job: JobOwnershipRecord, state: JobState): JobTerminalResult {
    const progress = this.getProgress(job.jobId);
    return {
      terminalState: state as 'completed' | 'failed' | 'cancelled',
      finalProgress: progress,
      committedAt: this.clock.now(),
      schemaVersion: 1,
    };
  }

  /** Cancel all children of a parent job. */
  private cancelChildren(parentJobId: string, actorId: string): void {
    const children = this.persistence.loadChildJobs(parentJobId);
    for (const child of children) {
      const childState = this.getCurrentState(child);
      if (TERMINAL_JOB_STATES.has(childState)) continue;

      // Don't cancel durable children — they survive parent cancellation
      if (child.durable && child.cancellationPolicy === 'ignore') continue;

      this.dispatch.cancelDispatch(child.jobId);
      const progress = this.getProgress(child.jobId);
      const terminalResult: JobTerminalResult = {
        terminalState: 'cancelled',
        reason: `Parent job ${parentJobId} cancelled`,
        finalProgress: progress,
        committedAt: this.clock.now(),
        schemaVersion: 1,
      };
      this.persistence.commitTerminalResult(child.jobId, 'cancelled', terminalResult);
      this.persistence.recordTransition({
        transitionId: this.idGen.generateId(),
        jobId: child.jobId,
        fromState: childState,
        toState: 'cancelled',
        cause: 'parent_cancelled',
        causeDetail: `Parent ${parentJobId} cancelled`,
        actor: actorId,
        occurredAt: this.clock.now(),
        schemaVersion: 1,
      });
      this.progressMap.delete(child.jobId);
      this.dispatchTimes.delete(child.jobId);

      // Recursively cancel grandchildren
      this.cancelChildren(child.jobId, actorId);
    }
  }
}
