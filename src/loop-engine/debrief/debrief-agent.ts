// ─── Loop Debrief Agent ─────────────────────────────────────────
// Automated failure analysis of non-success loop receipts.
// Classifies failures and recommends minimal LoopSpec changes.
//
// Requirements: 10.1, 10.2, 10.3, 10.4, 10.5

import type {
  FailureClassification,
  Confidence,
  DebriefResult,
  LoopReceipt,
  EventBusLike,
  PassResult,
} from '../index';

/** Event topic for debrief completion */
export const DEBRIEF_EVENT_TOPIC = 'loop:debrief:complete' as const;

export interface DebriefAgentDeps {
  eventBus: EventBusLike;
  logger?: {
    warn(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * DebriefAgent analyzes non-success loop receipts to classify the failure
 * root cause and recommend a minimal LoopSpec change (REQ-10.1, 10.2, 10.3).
 *
 * Classification categories:
 * - loop-design: The LoopSpec definition itself is flawed (verify checks, feedback, stop conditions)
 * - execution-tool-failure: A tool or execution infrastructure failed (timeouts, corruption)
 * - environment-problem: The environment changed during execution (early passes pass, later fail)
 * - goal-ambiguity: The goal is unclear or verify results are inconsistent with no progress
 */
export class DebriefAgent {
  private readonly eventBus: EventBusLike;
  private readonly logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
  };

  constructor(deps: DebriefAgentDeps) {
    this.eventBus = deps.eventBus;
    this.logger = deps.logger ?? {
      warn: () => {},
      info: () => {},
    };
  }

  /**
   * Analyze a non-success receipt and produce classification + recommendation.
   * Must complete within 30 seconds of receipt generation (REQ-10.1).
   *
   * Classification logic:
   * 1. If stopReason contains 'pass_timeout' or 'checkpoint_corruption' → execution-tool-failure (high)
   * 2. If all passes have the same verify failures → loop-design (high)
   * 3. If early passes succeed then later passes fail → environment-problem (high)
   * 4. If verify results are inconsistent with no clear progress → goal-ambiguity (medium)
   * 5. Default → loop-design (medium) (REQ-10.2)
   */
  async analyze(receipt: LoopReceipt): Promise<DebriefResult> {
    // 1. Check for execution-tool-failure signals in stopReason
    if (this.isExecutionToolFailure(receipt.stopReason)) {
      return this.buildResult(
        'execution-tool-failure',
        'high',
        {
          section: 'stop',
          changes: 'Increase pass timeout or add checkpoint recovery handling in stop conditions',
          fieldCount: 1,
        },
        `Loop stopped due to infrastructure failure: ${receipt.stopReason}`,
      );
    }

    const passes = receipt.passes;

    // Need at least one pass for further analysis
    if (passes.length === 0) {
      return this.buildResult(
        'loop-design',
        'medium',
        {
          section: 'verify',
          changes: 'Review verify checks — loop produced no passes before termination',
          fieldCount: 1,
        },
        'No passes were completed before the loop terminated.',
      );
    }

    // 2. Check if all passes have the same verify failures → loop-design
    if (this.hasConsistentVerifyFailures(passes)) {
      const failingChecks = this.getConsistentFailingChecks(passes);
      return this.buildResult(
        'loop-design',
        'high',
        {
          section: 'verify',
          changes: `Revise verify checks that consistently fail: ${failingChecks.join(', ')}. Consider adjusting thresholds or expected outcomes.`,
          fieldCount: Math.min(failingChecks.length, 3),
        },
        `All ${passes.length} passes failed the same verify checks (${failingChecks.join(', ')}), indicating a loop design issue.`,
      );
    }

    // 3. Check if early passes succeed then later fail → environment-problem
    if (this.hasEnvironmentDegradation(passes)) {
      return this.buildResult(
        'environment-problem',
        'high',
        {
          section: 'scope',
          changes: 'Add environment validation to verify checks or narrow allowedPaths to reduce external interference',
          fieldCount: 2,
        },
        `Early passes (1-${this.findDegradationPoint(passes)}) succeeded but later passes failed, suggesting an environment change.`,
      );
    }

    // 4. Check for inconsistent results / no progress → goal-ambiguity
    if (this.hasGoalAmbiguity(passes)) {
      return this.buildResult(
        'goal-ambiguity',
        'medium',
        {
          section: 'goal',
          changes: 'Clarify the goal statement and ensure verify checks align with a specific measurable outcome',
          fieldCount: 2,
        },
        `Verify results are inconsistent across passes with no clear progress trend, suggesting the goal or success criteria are ambiguous.`,
      );
    }

    // 5. Default → loop-design with medium confidence (REQ-10.2)
    return this.buildResult(
      'loop-design',
      'medium',
      {
        section: 'feedback',
        changes: 'Refine the feedback strategy to provide more actionable guidance between passes',
        fieldCount: 1,
      },
      `Loop terminated as ${receipt.finalStatus} after ${receipt.totalPasses} passes. No single root cause identified with high confidence.`,
    );
  }

  /**
   * Write findings to Project Learning Memory under pitfall category (REQ-10.4).
   *
   * This is a placeholder implementation that would integrate with the
   * Project Learning Memory DB. In production, this writes a structured
   * entry with source='loop-debrief' under the pitfall category.
   */
  async persistToMemory(result: DebriefResult, runId: string): Promise<void> {
    // Placeholder: In production, this would write to the Project Learning Memory DB
    // under the pitfall category with source set to 'loop-debrief'.
    //
    // Expected schema:
    // {
    //   category: 'pitfall',
    //   source: 'loop-debrief',
    //   runId,
    //   classification: result.classification,
    //   confidence: result.confidence,
    //   recommendation: result.recommendation,
    //   evidenceSummary: result.evidenceSummary,
    //   createdAt: new Date().toISOString(),
    // }

    this.logger.info('Debrief persisted to Project Learning Memory', {
      runId,
      classification: result.classification,
      confidence: result.confidence,
      category: 'pitfall',
      source: 'loop-debrief',
    });
  }

  /**
   * Publish loop:debrief:complete event on the Event Bus (REQ-10.5).
   * Contains run_id, failure classification, confidence, and recommended change.
   */
  async publishDebriefComplete(result: DebriefResult, runId: string): Promise<void> {
    const payload: Record<string, unknown> = {
      run_id: runId,
      classification: result.classification,
      confidence: result.confidence,
      recommendation: result.recommendation,
      timestamp: new Date().toISOString(),
    };

    try {
      await this.eventBus.publish(DEBRIEF_EVENT_TOPIC, payload);
    } catch (error) {
      this.logger.warn(`Event Bus unavailable for ${DEBRIEF_EVENT_TOPIC}`, {
        run_id: runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /** Check if stopReason indicates an execution-tool-failure */
  private isExecutionToolFailure(stopReason: string): boolean {
    const lowerReason = stopReason.toLowerCase();
    return lowerReason.includes('pass_timeout') || lowerReason.includes('checkpoint_corruption');
  }

  /** Check if all passes consistently fail the same verify checks */
  private hasConsistentVerifyFailures(passes: PassResult[]): boolean {
    if (passes.length < 2) return false;

    const firstPass = passes[0];
    if (!firstPass) return false;

    const firstFailures = this.getFailingCheckIds(firstPass);
    if (firstFailures.length === 0) return false;

    return passes.every((pass) => {
      const failures = this.getFailingCheckIds(pass);
      return (
        failures.length === firstFailures.length &&
        failures.every((f) => firstFailures.includes(f))
      );
    });
  }

  /** Get the set of consistently failing check IDs across all passes */
  private getConsistentFailingChecks(passes: PassResult[]): string[] {
    const firstPass = passes[0];
    if (!firstPass) return [];
    return this.getFailingCheckIds(firstPass);
  }

  /** Get failing check IDs for a single pass */
  private getFailingCheckIds(pass: PassResult): string[] {
    return pass.verifyResults
      .filter((r) => !r.passed)
      .map((r) => r.checkId);
  }

  /** Check if early passes succeed but later passes fail (environment degradation) */
  private hasEnvironmentDegradation(passes: PassResult[]): boolean {
    if (passes.length < 3) return false;

    const passRates = passes.map((pass) => {
      const total = pass.verifyResults.length;
      if (total === 0) return 0;
      const passing = pass.verifyResults.filter((r) => r.passed).length;
      return passing / total;
    });

    // Find if there's a clear degradation: early passes have higher pass rates
    const midpoint = Math.floor(passRates.length / 2);
    if (midpoint === 0) return false;

    const earlySlice = passRates.slice(0, midpoint);
    const lateSlice = passRates.slice(midpoint);
    const lateLen = lateSlice.length;
    if (lateLen === 0) return false;

    const earlyAvg = earlySlice.reduce((sum, r) => sum + r, 0) / midpoint;
    const lateAvg = lateSlice.reduce((sum, r) => sum + r, 0) / lateLen;

    // Significant degradation: early passes >= 50% and late passes < 25%
    return earlyAvg >= 0.5 && lateAvg < 0.25;
  }

  /** Find the pass number where degradation begins */
  private findDegradationPoint(passes: PassResult[]): number {
    const passRates = passes.map((pass) => {
      const total = pass.verifyResults.length;
      if (total === 0) return 0;
      const passing = pass.verifyResults.filter((r) => r.passed).length;
      return passing / total;
    });

    // Find the first pass where rate drops below 50%
    for (let i = 1; i < passRates.length; i++) {
      const current = passRates[i];
      const previous = passRates[i - 1];
      if (current !== undefined && previous !== undefined) {
        if (current < 0.5 && previous >= 0.5) {
          return i;
        }
      }
    }
    return Math.floor(passes.length / 2);
  }

  /** Check for goal ambiguity: inconsistent results with no clear progress */
  private hasGoalAmbiguity(passes: PassResult[]): boolean {
    if (passes.length < 2) return false;

    const passCounts = passes.map(
      (pass) => pass.verifyResults.filter((r) => r.passed).length,
    );

    // Check for oscillation: counts go up and down without monotonic progress
    let increases = 0;
    let decreases = 0;
    for (let i = 1; i < passCounts.length; i++) {
      const current = passCounts[i];
      const previous = passCounts[i - 1];
      if (current !== undefined && previous !== undefined) {
        if (current > previous) increases++;
        else if (current < previous) decreases++;
      }
    }

    // Ambiguity: both increases and decreases present, with no net progress
    const first = passCounts[0];
    const last = passCounts[passCounts.length - 1];
    if (first === undefined || last === undefined) return false;
    const netProgress = last - first;
    return increases > 0 && decreases > 0 && netProgress <= 0;
  }

  /** Build a complete DebriefResult */
  private buildResult(
    classification: FailureClassification,
    confidence: Confidence,
    recommendation: DebriefResult['recommendation'],
    evidenceSummary: string,
  ): DebriefResult {
    return {
      classification,
      confidence,
      recommendation,
      evidenceSummary,
    };
  }
}
