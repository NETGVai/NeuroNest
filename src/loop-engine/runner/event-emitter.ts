// ─── Loop Event Emitter ─────────────────────────────────────────
// Publishes loop lifecycle events on the Event Bus.
// Ensures subscribers observe events before state transitions complete.
//
// Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6

import type { EventBusLike, VerifyResult, TerminalState } from '../index';

/** Maximum character limits for event payloads */
const MAX_ACTION_SUMMARY_CHARS = 10_000;
const MAX_STOP_REASON_CHARS = 500;
const MAX_APPROVAL_REASON_CHARS = 1_000;

/** Event topic constants */
export const LOOP_EVENT_TOPICS = {
  PASS_START: 'loop:pass:start',
  VERIFY_RESULT: 'loop:verify:result',
  STOP: 'loop:stop',
  AWAITING_APPROVAL: 'loop:awaiting-approval',
} as const;

export interface LoopEventEmitterDeps {
  eventBus: EventBusLike;
  logger?: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * LoopEventEmitter publishes lifecycle events on the Event Bus before
 * each phase transition completes (REQ-7.6).
 *
 * On Event Bus failure:
 * - For loop:awaiting-approval: returns false to block the state transition (REQ-7.4)
 * - For all other events: logs a warning and continues execution (REQ-7.5)
 */
export class LoopEventEmitter {
  private readonly eventBus: EventBusLike;
  private readonly logger: { warn(message: string, meta?: Record<string, unknown>): void };

  constructor(deps: LoopEventEmitterDeps) {
    this.eventBus = deps.eventBus;
    this.logger = deps.logger ?? {
      warn: (_message: string, _meta?: Record<string, unknown>) => {
        // Default: silent (no-op logger)
      },
    };
  }

  /**
   * Publish loop:pass:start event when a pass begins.
   * Truncates actionSummary to 10K characters (REQ-7.1).
   *
   * On Event Bus failure: logs warning and continues (REQ-7.5).
   */
  async emitPassStart(
    runId: string,
    passNumber: number,
    actionSummary: string,
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      run_id: runId,
      pass_number: passNumber,
      timestamp: new Date().toISOString(),
      action_summary: actionSummary.slice(0, MAX_ACTION_SUMMARY_CHARS),
    };

    try {
      await this.eventBus.publish(LOOP_EVENT_TOPICS.PASS_START, payload);
    } catch (error) {
      this.logger.warn(`Event Bus unavailable for ${LOOP_EVENT_TOPICS.PASS_START}`, {
        run_id: runId,
        error: error instanceof Error ? error.message : String(error),
      });
      // REQ-7.5: Log warning and continue
    }
  }

  /**
   * Publish loop:verify:result event when verification completes.
   * Includes per-check pass/fail results (REQ-7.2).
   *
   * On Event Bus failure: logs warning and continues (REQ-7.5).
   */
  async emitVerifyResult(
    runId: string,
    passNumber: number,
    results: VerifyResult[],
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      run_id: runId,
      pass_number: passNumber,
      timestamp: new Date().toISOString(),
      results: results.map((r) => ({
        check_id: r.checkId,
        passed: r.passed,
      })),
    };

    try {
      await this.eventBus.publish(LOOP_EVENT_TOPICS.VERIFY_RESULT, payload);
    } catch (error) {
      this.logger.warn(`Event Bus unavailable for ${LOOP_EVENT_TOPICS.VERIFY_RESULT}`, {
        run_id: runId,
        error: error instanceof Error ? error.message : String(error),
      });
      // REQ-7.5: Log warning and continue
    }
  }

  /**
   * Publish loop:stop event when a loop reaches a terminal state.
   * Truncates stopReason to 500 characters (REQ-7.3).
   *
   * On Event Bus failure: logs warning and continues (REQ-7.5).
   */
  async emitStop(
    runId: string,
    finalStatus: TerminalState,
    stopReason: string,
    passesCompleted: number,
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      run_id: runId,
      final_status: finalStatus,
      stop_reason: stopReason.slice(0, MAX_STOP_REASON_CHARS),
      timestamp: new Date().toISOString(),
      passes_completed: passesCompleted,
    };

    try {
      await this.eventBus.publish(LOOP_EVENT_TOPICS.STOP, payload);
    } catch (error) {
      this.logger.warn(`Event Bus unavailable for ${LOOP_EVENT_TOPICS.STOP}`, {
        run_id: runId,
        error: error instanceof Error ? error.message : String(error),
      });
      // REQ-7.5: Log warning and continue
    }
  }

  /**
   * Publish loop:awaiting-approval event when a loop enters AWAITING_APPROVAL.
   * Truncates reason to 1K characters (REQ-7.4).
   *
   * Returns false if the publish fails — the caller MUST block the state
   * transition to AWAITING_APPROVAL until the event is successfully published (REQ-7.4).
   *
   * On Event Bus failure: returns false (BLOCKS transition per REQ-7.4).
   */
  async emitAwaitingApproval(
    runId: string,
    passNumber: number,
    reason: string,
  ): Promise<boolean> {
    const payload: Record<string, unknown> = {
      run_id: runId,
      pass_number: passNumber,
      timestamp: new Date().toISOString(),
      reason: reason.slice(0, MAX_APPROVAL_REASON_CHARS),
    };

    try {
      await this.eventBus.publish(LOOP_EVENT_TOPICS.AWAITING_APPROVAL, payload);
      return true;
    } catch (error) {
      this.logger.warn(
        `Event Bus unavailable for ${LOOP_EVENT_TOPICS.AWAITING_APPROVAL} — blocking transition`,
        {
          run_id: runId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      // REQ-7.4: Block transition if publish fails
      return false;
    }
  }
}
