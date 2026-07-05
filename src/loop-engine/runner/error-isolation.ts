// ─── Error Isolation Layer ──────────────────────────────────────
// Provides error isolation and graceful degradation for loop execution.
// Ensures unhandled Loop_Engine errors abort the affected loop, write a
// BLOCKED receipt with 'internal_error', and return the session to
// single-shot pipeline behavior without affecting other active sessions.
//
// Implements the global kill switch at pass boundaries that operates
// independently of loops_enabled status (REQ-15.5).
//
// Requirements: 15.4, 15.5

import type {
  EventBusLike,
  LoopRunContext,
  LoopStorageLike,
  PassResult,
} from '../index';
import { ReceiptGenerator } from '../receipt/receipt-generator';
import { LOOP_EVENT_TOPICS } from './event-emitter';

// ─── Types ──────────────────────────────────────────────────────

export interface ErrorIsolationDeps {
  eventBus: EventBusLike;
  loopStorage: LoopStorageLike;
  logger?: {
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
}

// ─── ErrorIsolationLayer ────────────────────────────────────────

/**
 * ErrorIsolationLayer wraps loop execution to provide:
 * 1. Try/catch isolation — unhandled errors abort only the affected loop
 * 2. BLOCKED receipt generation with 'internal_error' stop reason
 * 3. Session return to single-shot mode on error
 * 4. Global kill switch — operates independently of loops_enabled (REQ-15.5)
 *
 * The kill switch can be triggered via loops:stop IPC with 'all' run_id.
 * It works even when the loops_enabled feature flag is disabled.
 */
export class ErrorIsolationLayer {
  private killSwitchActive = false;
  private readonly deps: ErrorIsolationDeps;
  private readonly receiptGenerator: ReceiptGenerator;

  constructor(deps: ErrorIsolationDeps) {
    this.deps = deps;
    this.receiptGenerator = new ReceiptGenerator();
  }

  /**
   * Wraps a loop execution function in a try/catch boundary.
   *
   * On unhandled error:
   * - Generates a BLOCKED receipt with stop_reason 'internal_error'
   * - Publishes loop:stop event
   * - Does NOT propagate the error to other sessions
   * - Returns the session to single-shot pipeline behavior
   *
   * REQ-15.4: Unhandled errors abort the loop, write BLOCKED receipt,
   * and return session to single-shot without affecting other sessions.
   */
  async wrapExecution(
    fn: () => Promise<void>,
    runId: string,
    context: LoopRunContext,
    passes: PassResult[],
  ): Promise<void> {
    try {
      await fn();
    } catch (error) {
      // ── Isolate the error to this session only ──────────────
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.log('error', `Unhandled Loop_Engine error in run ${runId}: ${errorMessage}`, {
        runId,
        sessionId: context.sessionId,
        error: errorMessage,
      });

      // ── Generate BLOCKED receipt with 'internal_error' ──────
      const receipt = this.receiptGenerator.generate(
        context,
        passes,
        'internal_error',
      );

      // Persist receipt to storage
      try {
        await this.deps.loopStorage.writeReceipt(runId, JSON.stringify(receipt));
      } catch (persistError) {
        this.log('warn', `Failed to persist BLOCKED receipt for run ${runId}`, {
          runId,
          error: persistError instanceof Error ? persistError.message : String(persistError),
        });
      }

      // Update run status to failed
      try {
        await this.deps.loopStorage.updateRun(runId, {
          status: 'failed',
          stop_reason: 'internal_error',
          ended_at: new Date().toISOString(),
        });
      } catch (updateError) {
        this.log('warn', `Failed to update run status for ${runId}`, {
          runId,
          error: updateError instanceof Error ? updateError.message : String(updateError),
        });
      }

      // ── Publish loop:stop event ─────────────────────────────
      try {
        await this.deps.eventBus.publish(LOOP_EVENT_TOPICS.STOP, {
          run_id: runId,
          final_status: 'BLOCKED',
          stop_reason: 'internal_error',
          timestamp: new Date().toISOString(),
          passes_completed: context.passesCompleted,
        });
      } catch (eventError) {
        // REQ-7.5: Log warning and continue even if event publish fails
        this.log('warn', `Failed to publish loop:stop event for run ${runId}`, {
          runId,
          error: eventError instanceof Error ? eventError.message : String(eventError),
        });
      }

      // ── Error is NOT propagated ─────────────────────────────
      // The session returns to single-shot mode — no throw, no rethrow.
      // Other active sessions are unaffected because the error is caught here.
    }
  }

  /**
   * Checks whether the global kill switch has been activated.
   *
   * The kill switch operates independently of loops_enabled status (REQ-15.5).
   * It always blocks all loops regardless of feature flag configuration
   * or other runtime conditions.
   */
  isKillSwitchActive(): boolean {
    return this.killSwitchActive;
  }

  /**
   * Activates the global kill switch.
   *
   * Once active, all running loops should transition to BLOCKED with
   * stop_reason 'kill_switch' at their next pass boundary.
   *
   * REQ-15.5: The kill switch operates independently of all other system
   * states including loops_enabled status — it always blocks all loops.
   */
  triggerKillSwitch(): void {
    this.killSwitchActive = true;
  }

  /**
   * Deactivates the global kill switch after all loops have stopped.
   *
   * Should be called once all running loops have been terminated,
   * allowing new loops to start in the future.
   */
  resetKillSwitch(): void {
    this.killSwitchActive = false;
  }

  // ─── Private Helpers ────────────────────────────────────────────

  private log(
    level: 'warn' | 'error',
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    if (this.deps.logger) {
      this.deps.logger[level](message, meta);
    }
  }
}
