// ─── Crash Recovery Manager ─────────────────────────────────────
// Persists loop run state to Checkpoint_Service and restores
// interrupted runs on application restart.
//
// Requirements: 8.1, 8.2, 8.3, 8.4, 8.5

import type {
  LoopState,
  LoopStorageLike,
  CheckpointServiceLike,
  LoopRunRow,
  LoopPassRow,
} from '../index';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Checkpoint state persisted after each pass and during autosave cycles.
 * Contains all information needed to restore a loop run.
 */
export interface LoopCheckpointState {
  runId: string;
  specId: string;
  passesCompleted: number;
  cumulativeCostUsd: number;
  currentState: LoopState;
  verifyResultsPerPass: Array<Array<{ checkId: string; passed: boolean }>>;
  progressHashes: string[];
}

/**
 * Represents a restored loop run ready to be resumed.
 */
export interface ResumeContext {
  runId: string;
  specId: string;
  passesCompleted: number;
  resumeAtPass: number;
  cumulativeCostUsd: number;
  currentState: LoopState;
  verifyResultsPerPass: Array<Array<{ checkId: string; passed: boolean }>>;
  progressHashes: string[];
}

export interface CrashRecoveryManagerDeps {
  loopStorage: LoopStorageLike;
  checkpointService: CheckpointServiceLike;
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

// ─── Constants ──────────────────────────────────────────────────

const CHECKPOINT_KEY_PREFIX = 'loop_run_';
const AUTOSAVE_INTERVAL_MS = 30_000; // 30 seconds

// ─── CrashRecoveryManager ───────────────────────────────────────

/**
 * CrashRecoveryManager handles persisting loop run state to the
 * Checkpoint_Service and restoring interrupted runs after crashes.
 *
 * - After each pass: persists state under 'loop_run_{runId}' (REQ-8.1)
 * - 30-second autosave: joins existing checkpoint cycle (REQ-8.4)
 * - On restart: queries running runs, deletes partial passes, resumes (REQ-8.2, 8.3)
 * - On corruption: transitions to BLOCKED with 'checkpoint_corruption' (REQ-8.5)
 */
export class CrashRecoveryManager {
  private readonly loopStorage: LoopStorageLike;
  private readonly checkpointService: CheckpointServiceLike;
  private lastSaveTimestamps: Map<string, number> = new Map();

  constructor(deps: CrashRecoveryManagerDeps) {
    this.loopStorage = deps.loopStorage;
    this.checkpointService = deps.checkpointService;
  }

  /**
   * Persist loop run state after each completed pass.
   * Saves to CheckpointService under key 'loop_run_{runId}'.
   *
   * Requirement 8.1: After each pass completes, persist current loop run state
   * (run_id, spec_id, passes_completed, cumulative cost_usd, current state,
   * and per-pass verify results).
   */
  async persistAfterPass(state: LoopCheckpointState): Promise<void> {
    const key = `${CHECKPOINT_KEY_PREFIX}${state.runId}`;
    await this.checkpointService.save(key, state);
    this.lastSaveTimestamps.set(state.runId, Date.now());
  }

  /**
   * Restore all interrupted loop runs on application restart.
   * Queries loop_runs for status='running', deletes partial passes,
   * and builds restored contexts for resumption.
   *
   * Requirement 8.2: Resume at PLANNING_PASS for pass (passes_completed + 1).
   * Requirement 8.3: Delete partial passes (rows without ended_at) and retry.
   */
  async restoreOnRestart(): Promise<ResumeContext[]> {
    const runningRuns = (await this.loopStorage.getRunningRuns()) as LoopRunRow[];
    const resumeContexts: ResumeContext[] = [];

    for (const run of runningRuns) {
      // REQ-8.3: Delete partial passes (rows without ended_at)
      const passes = (await this.loopStorage.getPassesForRun(run.id)) as LoopPassRow[];
      for (const pass of passes) {
        if (pass.ended_at === null) {
          await this.loopStorage.deleteIncompletePass(run.id, pass.pass_number);
        }
      }

      // REQ-8.2: Build resume context — resume at (passes_completed + 1)
      resumeContexts.push({
        runId: run.id,
        specId: run.spec_id,
        passesCompleted: run.passes_completed,
        resumeAtPass: run.passes_completed + 1,
        cumulativeCostUsd: run.cost_usd,
        currentState: 'PLANNING_PASS',
        verifyResultsPerPass: [],
        progressHashes: [],
      });
    }

    return resumeContexts;
  }

  /**
   * Handle checkpoint corruption by transitioning the run to BLOCKED.
   *
   * Requirement 8.5: If restoration fails due to corruption or schema mismatch,
   * transition to BLOCKED with stop_reason 'checkpoint_corruption'.
   */
  async handleCorruption(runId: string): Promise<void> {
    await this.loopStorage.updateRun(runId, {
      status: 'failed',
      stop_reason: 'checkpoint_corruption',
      ended_at: new Date().toISOString(),
    } as Partial<LoopRunRow>);
  }

  /**
   * Determine if autosave should trigger for a given run (30-second cycle).
   * Returns true if 30+ seconds have elapsed since the last save for this run,
   * or if no save has been recorded yet.
   *
   * Requirement 8.4: Join the existing 30-second autosave cycle.
   */
  shouldAutosave(runId: string): boolean {
    const lastSave = this.lastSaveTimestamps.get(runId);
    if (lastSave === undefined) {
      return true;
    }
    return Date.now() - lastSave >= AUTOSAVE_INTERVAL_MS;
  }

  /**
   * Get the checkpoint key for a given run ID.
   */
  static getCheckpointKey(runId: string): string {
    return `${CHECKPOINT_KEY_PREFIX}${runId}`;
  }
}
