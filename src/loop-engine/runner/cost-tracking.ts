// ─── Loop Cost Tracking ─────────────────────────────────────────
// Integrates loop pass/run cost reporting with the existing
// Cost_Tracking_Service and persists cost data to loop storage.
//
// Requirements: 16.1, 16.2, 16.3, 16.4

import type {
  CostTrackingServiceLike,
  LoopStorageLike,
  LoopRunContext,
} from '../index';

export interface LoopCostTrackerDeps {
  costTracker: CostTrackingServiceLike;
  loopStorage: LoopStorageLike;
}

/**
 * LoopCostTracker handles per-pass cost reporting, budget checking,
 * and cost accumulation for loop runs.
 *
 * - Reports pass token cost to Cost_Tracking_Service after each pass (REQ-16.1)
 * - Persists cost in loop_passes.cost_usd within 2 seconds (REQ-16.1)
 * - Accumulates in loop_runs.cost_usd (sum of all pass costs) (REQ-16.2)
 * - Queries budget status before each pass (REQ-16.3, 16.4)
 */
export class LoopCostTracker {
  /**
   * Reports the cost of a completed pass to the Cost_Tracking_Service
   * and persists it to loop storage.
   *
   * REQ-16.1: Report pass token cost and persist in loop_passes.cost_usd within 2 seconds.
   * REQ-16.2: Add pass cost to loop_runs.cost_usd cumulative total.
   *
   * @param runId - The loop run ID
   * @param passId - The pass record ID
   * @param passNumber - The pass number (1-based)
   * @param costUsd - The cost of the pass in USD
   * @param deps - Injected dependencies (costTracker, loopStorage)
   */
  async reportPassCost(
    runId: string,
    passId: string,
    passNumber: number,
    costUsd: number,
    deps: LoopCostTrackerDeps,
  ): Promise<void> {
    // Report cost to the existing Cost_Tracking_Service
    // Uses a session-scoped identifier tied to the run
    deps.costTracker.addCost(runId, costUsd);

    // Persist cost in loop_passes.cost_usd (REQ-16.1)
    await deps.loopStorage.updatePass(passId, { cost_usd: costUsd });

    // Accumulate in loop_runs.cost_usd (REQ-16.2)
    // Retrieve current run cost and add the new pass cost
    const run = await deps.loopStorage.getRun(runId);
    const currentCost = (run as { cost_usd?: number } | null)?.cost_usd ?? 0;
    const newTotalCost = currentCost + costUsd;

    await deps.loopStorage.updateRun(runId, { cost_usd: newTotalCost });
  }

  /**
   * Checks budget status before a pass begins.
   * Returns true if budget is available (execution may continue).
   * Returns false if budget is exceeded (caller should transition to LIMIT_EXHAUSTED).
   *
   * REQ-16.3: Query Cost_Tracking_Service for current budget status before each pass.
   * REQ-16.4: If budget exceeded after a pass cost is reported, transition to LIMIT_EXHAUSTED.
   *
   * The check considers both:
   * - The LoopSpec's maxCostUsd limit (internal loop budget)
   * - The Cost_Tracking_Service's session/daily budget (external system budget)
   *
   * @param context - The current loop run context
   * @param deps - Injected dependencies (costTracker, loopStorage)
   * @returns true if budget available, false if exceeded
   */
  checkBudget(
    context: LoopRunContext,
    deps: LoopCostTrackerDeps,
  ): boolean {
    // Check internal loop budget (LoopSpec maxCostUsd)
    if (context.cumulativeCostUsd >= context.spec.stop.maxCostUsd) {
      return false;
    }

    // Check external system budget via Cost_Tracking_Service (REQ-16.3)
    if (deps.costTracker.isBudgetExceeded(context.sessionId)) {
      return false;
    }

    return true;
  }
}
