/**
 * AdaptiveReplanner — GOAP-Lite replanning mechanism for the Orchestrator.
 *
 * When a subtask within a PhasedPipeline fails, the AdaptiveReplanner
 * replans from the current state (informed by failed-trajectory memory)
 * rather than retrying the identical failed plan.
 *
 * Key behaviors:
 * - Retrieves failed trajectory context from TrajectoryStore
 * - Limits replanning to max 3 attempts per pipeline run
 * - Logs original plan, failure reason, and new plan BEFORE proceeding
 * - If logging fails → does NOT proceed with the replan
 * - Gated behind the `adaptive_replanning` feature flag
 *
 * Requirements: 23.1, 23.2, 23.3, 23.4
 */

import { PERF_FLAGS } from '../main/performance/feature-flags.js';
import type { TrajectoryRecord } from '../agents/compounding-memory.js';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Represents the current state of a pipeline at the point of failure.
 */
export interface PipelineState {
  /** Current phase of the pipeline (e.g., 'specification', 'architecture') */
  currentPhase: string;
  /** Phases already completed successfully */
  completedPhases: string[];
  /** Artifacts produced so far */
  availableArtifacts: string[];
  /** Any partial results from the failed subtask */
  partialResults?: string;
}

/**
 * Context provided to the replanner for generating a new plan.
 */
export interface ReplanContext {
  /** The original plan that was being executed when failure occurred */
  originalPlan: string;
  /** Reason the original plan (or subtask) failed */
  failureReason: string;
  /** Failed trajectories retrieved from memory for "what failed" context */
  failedTrajectories: TrajectoryRecord[];
  /** Current pipeline state at point of failure */
  currentState: PipelineState;
  /** 1-indexed replan attempt number (max 3) */
  replanAttempt: number;
}

/**
 * Result of a replan operation.
 */
export interface PlanResult {
  /** Whether replanning was successful */
  success: boolean;
  /** The new plan generated (undefined if replanning failed or was blocked) */
  newPlan?: string;
  /** Reason if replanning was blocked or failed */
  reason?: string;
  /** The replan attempt number */
  attempt: number;
}

/**
 * Log entry written before a replan is executed.
 * All three fields must be logged before proceeding.
 */
export interface ReplanLogEntry {
  /** The original plan that failed */
  originalPlan: string;
  /** Why the original plan failed */
  failureReason: string;
  /** The new plan that will be executed */
  newPlan: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Attempt number */
  attempt: number;
}

/**
 * Interface for a logger that persists replan log entries.
 * Implementations must throw on failure — the replanner uses this
 * to gate execution (if logging fails, replan does NOT proceed).
 */
export interface ReplanLogger {
  /**
   * Log a replan entry. Must throw if logging fails.
   * The replanner will NOT proceed with the new plan if this throws.
   */
  log(entry: ReplanLogEntry): Promise<void>;
}

/**
 * Interface for the plan generator that creates a new plan
 * from current state + failure context.
 */
export interface PlanGenerator {
  /**
   * Generate a new plan based on the current state and failure context.
   * Returns the new plan as a string.
   */
  generatePlan(context: ReplanContext): Promise<string>;
}

/**
 * Interface for retrieving failed trajectories from the TrajectoryStore.
 */
export interface TrajectoryRetriever {
  /**
   * Retrieve failed trajectories relevant to the current task context.
   * Returns trajectory records marked as failed.
   */
  retrieveFailedTrajectories(
    taskEmbedding: Float32Array,
    topK: number,
  ): Promise<TrajectoryRecord[]>;
}

// ─── AdaptiveReplanner ──────────────────────────────────────────

/**
 * AdaptiveReplanner — Replans from current state on subtask failure.
 *
 * Instead of retrying the same failed plan, generates a new plan informed
 * by the failure context and historical failed trajectories from memory.
 *
 * Constraints:
 * - Maximum 3 replan attempts per pipeline run (prevents infinite loops)
 * - Must log original plan, failure reason, and new plan BEFORE executing
 * - If logging fails, replan does NOT proceed
 * - Gated behind `adaptive_replanning` feature flag
 *
 * Requirements: 23.1, 23.2, 23.3, 23.4
 */
export class AdaptiveReplanner {
  /** Maximum number of replan attempts per pipeline run */
  static readonly MAX_REPLANS = 3;

  private readonly logger: ReplanLogger;
  private readonly planGenerator: PlanGenerator;
  private readonly trajectoryRetriever?: TrajectoryRetriever;
  private replanCount = 0;

  constructor(deps: {
    logger: ReplanLogger;
    planGenerator: PlanGenerator;
    trajectoryRetriever?: TrajectoryRetriever;
  }) {
    this.logger = deps.logger;
    this.planGenerator = deps.planGenerator;
    this.trajectoryRetriever = deps.trajectoryRetriever;
  }

  /**
   * Replan from current state when a subtask fails.
   *
   * Flow:
   * 1. Check feature flag gate
   * 2. Check replan attempt limit (max 3)
   * 3. Generate a new plan from current state + failure context
   * 4. Log original plan, failure reason, and new plan
   * 5. If logging succeeds → return new plan
   * 6. If logging fails → block execution, return failure
   *
   * Requirements: 23.1, 23.2, 23.3, 23.4
   */
  async replan(context: ReplanContext): Promise<PlanResult> {
    // Gate behind adaptive_replanning feature flag
    if (!PERF_FLAGS.ADAPTIVE_REPLANNING) {
      return {
        success: false,
        reason: 'Adaptive replanning is disabled (feature flag off)',
        attempt: context.replanAttempt,
      };
    }

    // Enforce max replan limit (Requirement 23.3)
    if (context.replanAttempt > AdaptiveReplanner.MAX_REPLANS) {
      return {
        success: false,
        reason: `Maximum replan attempts (${AdaptiveReplanner.MAX_REPLANS}) exceeded`,
        attempt: context.replanAttempt,
      };
    }

    // Track internal count as well
    this.replanCount++;
    if (this.replanCount > AdaptiveReplanner.MAX_REPLANS) {
      return {
        success: false,
        reason: `Maximum replan attempts (${AdaptiveReplanner.MAX_REPLANS}) exceeded for this pipeline run`,
        attempt: context.replanAttempt,
      };
    }

    // Generate a new plan from current state (Requirement 23.1)
    // The plan generator uses failed trajectories for "what failed" context (Requirement 23.2)
    let newPlan: string;
    try {
      newPlan = await this.planGenerator.generatePlan(context);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        reason: `Plan generation failed: ${errorMsg}`,
        attempt: context.replanAttempt,
      };
    }

    // Log BEFORE proceeding (Requirement 23.4)
    // If logging fails → do NOT proceed with the replan
    const logEntry: ReplanLogEntry = {
      originalPlan: context.originalPlan,
      failureReason: context.failureReason,
      newPlan,
      timestamp: new Date().toISOString(),
      attempt: context.replanAttempt,
    };

    try {
      await this.logger.log(logEntry);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        reason: `Logging failed, replan blocked: ${errorMsg}`,
        attempt: context.replanAttempt,
      };
    }

    // Logging succeeded → return the new plan for execution
    return {
      success: true,
      newPlan,
      attempt: context.replanAttempt,
    };
  }

  /**
   * Build a ReplanContext from a subtask failure, retrieving failed
   * trajectory context from memory.
   *
   * This is a convenience method that combines trajectory retrieval
   * with context assembly.
   *
   * Requirement 23.2
   */
  async buildReplanContext(params: {
    originalPlan: string;
    failureReason: string;
    currentState: PipelineState;
    taskEmbedding: Float32Array;
    replanAttempt: number;
    topK?: number;
  }): Promise<ReplanContext> {
    let failedTrajectories: TrajectoryRecord[] = [];

    // Retrieve failed trajectories for "what failed" context (Requirement 23.2)
    if (this.trajectoryRetriever) {
      try {
        const allTrajectories = await this.trajectoryRetriever.retrieveFailedTrajectories(
          params.taskEmbedding,
          params.topK ?? 5,
        );
        // Filter to only failed trajectories
        failedTrajectories = allTrajectories.filter((t) => !t.passed);
      } catch {
        // Trajectory retrieval failure is non-fatal — continue with empty context
        failedTrajectories = [];
      }
    }

    return {
      originalPlan: params.originalPlan,
      failureReason: params.failureReason,
      failedTrajectories,
      currentState: params.currentState,
      replanAttempt: params.replanAttempt,
    };
  }

  /**
   * Get the number of replan attempts made so far in this pipeline run.
   */
  getReplanCount(): number {
    return this.replanCount;
  }

  /**
   * Get the maximum allowed replan attempts.
   */
  getMaxReplans(): number {
    return AdaptiveReplanner.MAX_REPLANS;
  }

  /**
   * Check whether more replanning attempts are available.
   */
  canReplan(): boolean {
    if (!PERF_FLAGS.ADAPTIVE_REPLANNING) return false;
    return this.replanCount < AdaptiveReplanner.MAX_REPLANS;
  }

  /**
   * Reset the replan counter. Called at the start of each pipeline run.
   */
  reset(): void {
    this.replanCount = 0;
  }
}
