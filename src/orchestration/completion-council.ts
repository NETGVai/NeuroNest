/**
 * CompletionCouncil — Blind-review validation for task completion.
 *
 * Spawns a reviewer sub-agent that independently evaluates completed work
 * against acceptance criteria, without access to the implementer's reasoning
 * or conversation history. Enforces a configurable maximum iteration count
 * to prevent infinite review-implementation cycles.
 *
 * When the specialist_roles Feature Gate is enabled, the reviewer uses the
 * "reviewer" specialist role for focused review permissions and prompts.
 *
 * Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6
 */

// ─── Types ──────────────────────────────────────────────────────

/**
 * Specialist role interface — minimal definition for integration with
 * SpecialistRoleLoader when specialist_roles Feature Gate is enabled.
 * This is compatible with the full SpecialistRole interface from
 * specialist-role-loader.ts once it is implemented.
 */
export interface SpecialistRole {
  id: string;
  name: string;
  systemPrompt: string;
  allowedTools: string[];
  filePermissions: string[];
}

/**
 * Interface for role loader integration.
 * When specialist_roles is enabled, provides the "reviewer" role configuration.
 */
export interface RoleLoader {
  getRole(name: string): SpecialistRole | null;
}

/**
 * Result of evaluating a single acceptance criterion.
 */
export interface CriterionResult {
  criterion: string;
  met: boolean;
  reason: string;
}

/**
 * The verdict produced by the blind reviewer for a task.
 */
export interface ReviewVerdict {
  taskId: string;
  criterionResults: CriterionResult[];
  overallVerdict: 'approved' | 'rejected';
  iteration: number;
}

/**
 * Configuration for the CompletionCouncil.
 */
export interface CompletionCouncilConfig {
  maxIterations: number;
}

/**
 * Input describing a completed task to be reviewed.
 */
export interface ReviewRequest {
  taskId: string;
  taskOutput: unknown;
  acceptanceCriteria: string[];
  implementerSessionId: string;
}

/**
 * A reviewer function type — represents the blind review execution.
 * The reviewer receives only the task output and acceptance criteria,
 * NOT the implementer's conversation history or reasoning.
 */
export type ReviewerFn = (
  taskOutput: unknown,
  acceptanceCriteria: string[],
  reviewerRole: SpecialistRole | null,
) => Promise<CriterionResult[]>;

// ─── Implementation ─────────────────────────────────────────────

export class CompletionCouncil {
  private maxIterations: number;

  /**
   * @param roleLoader Optional role loader for specialist_roles integration.
   *   When provided, the reviewer sub-agent uses the "reviewer" role.
   * @param maxIterations Maximum review-implementation loops before forced approval/final rejection (default 3).
   * @param reviewerFn The function that performs the blind review. Injected for testability
   *   and to decouple from specific LLM client implementations.
   */
  constructor(
    private roleLoader: RoleLoader | null,
    maxIterations: number = 3,
    private reviewerFn?: ReviewerFn,
  ) {
    this.maxIterations = maxIterations;
  }

  /**
   * Get the configured maximum iteration count.
   */
  getMaxIterations(): number {
    return this.maxIterations;
  }

  /**
   * Get the reviewer specialist role if specialist_roles is enabled.
   * Returns null if no role loader is configured or "reviewer" role is not found.
   */
  getReviewerRole(): SpecialistRole | null {
    if (!this.roleLoader) {
      return null;
    }
    return this.roleLoader.getRole('reviewer');
  }

  /**
   * Spawn a blind reviewer to validate task output against acceptance criteria.
   *
   * The reviewer does NOT have access to:
   * - The implementer's conversation history
   * - The implementer's reasoning or decision process
   * - The implementer's session context
   *
   * The reviewer DOES have access to:
   * - The task output (code, artifacts, etc.)
   * - The acceptance criteria to validate against
   *
   * This method handles a single review iteration. For the full review loop
   * with iteration bounding, use `reviewWithRetries()`.
   */
  async review(
    taskOutput: unknown,
    acceptanceCriteria: string[],
    implementerSessionId: string,
  ): Promise<ReviewVerdict> {
    return this.reviewAtIteration(taskOutput, acceptanceCriteria, implementerSessionId, 1);
  }

  /**
   * Execute the full review-implementation loop with iteration bounding.
   *
   * Spawns a blind reviewer for each iteration. If the reviewer rejects,
   * calls the implementer fix function with failure details. Repeats until
   * either approved or maxIterations is reached.
   *
   * @param request The initial review request.
   * @param fixFn A function that attempts to fix the task based on rejection details.
   *   Returns the updated task output after the fix attempt.
   * @returns The final ReviewVerdict (approved or rejected after max iterations).
   */
  async reviewWithRetries(
    request: ReviewRequest,
    fixFn: (verdict: ReviewVerdict) => Promise<unknown>,
  ): Promise<ReviewVerdict> {
    let currentOutput = request.taskOutput;
    let iteration = 1;

    while (iteration <= this.maxIterations) {
      const verdict = await this.reviewAtIteration(
        currentOutput,
        request.acceptanceCriteria,
        request.implementerSessionId,
        iteration,
      );

      // If approved, return immediately
      if (verdict.overallVerdict === 'approved') {
        return verdict;
      }

      // If this is the last iteration, return the rejection verdict
      if (iteration >= this.maxIterations) {
        return verdict;
      }

      // Return to implementer with failure details for correction (Req 16.3)
      currentOutput = await fixFn(verdict);
      iteration++;
    }

    // This should not be reached due to the loop logic above,
    // but serves as a safety net
    return {
      taskId: request.taskId,
      criterionResults: [],
      overallVerdict: 'rejected',
      iteration: this.maxIterations,
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Execute a single blind review at a specific iteration.
   *
   * Resolves the reviewer role (if specialist_roles enabled), then
   * delegates to the reviewer function with only the task output
   * and acceptance criteria — no implementer reasoning is passed.
   */
  private async reviewAtIteration(
    taskOutput: unknown,
    acceptanceCriteria: string[],
    _implementerSessionId: string, // explicitly unused — blind review
    iteration: number,
  ): Promise<ReviewVerdict> {
    // Get the reviewer role if specialist_roles is enabled (Req 16.1)
    const reviewerRole = this.getReviewerRole();

    // Execute blind review — no access to implementer reasoning (Req 16.2)
    const criterionResults = await this.executeBlindReview(
      taskOutput,
      acceptanceCriteria,
      reviewerRole,
    );

    // Determine overall verdict based on per-criterion results (Req 16.4)
    const allMet = criterionResults.every((r) => r.met);
    const overallVerdict: 'approved' | 'rejected' = allMet ? 'approved' : 'rejected';

    // Construct task ID from context
    const taskId = this.deriveTaskId(taskOutput);

    return {
      taskId,
      criterionResults,
      overallVerdict,
      iteration,
    };
  }

  /**
   * Execute the blind review using the injected reviewer function or
   * a default implementation.
   *
   * The blind review receives ONLY the task output and acceptance criteria.
   * It explicitly does NOT receive:
   * - implementer conversation history
   * - implementer reasoning/thoughts
   * - implementer session context
   */
  private async executeBlindReview(
    taskOutput: unknown,
    acceptanceCriteria: string[],
    reviewerRole: SpecialistRole | null,
  ): Promise<CriterionResult[]> {
    // Use injected reviewer function if available (testability)
    if (this.reviewerFn) {
      return this.reviewerFn(taskOutput, acceptanceCriteria, reviewerRole);
    }

    // Default implementation: evaluate each criterion independently
    // In a real integration, this would spawn a reviewer sub-agent
    // with an LLM call. For now, return a placeholder that marks
    // all criteria as met (actual LLM integration will be wired by
    // the AgentLoopController).
    return acceptanceCriteria.map((criterion) => ({
      criterion,
      met: true,
      reason: 'Criterion evaluation pending LLM reviewer integration',
    }));
  }

  /**
   * Derive a task ID from the task output for the verdict.
   * Attempts to read a taskId property from the output if it's an object.
   */
  private deriveTaskId(taskOutput: unknown): string {
    if (
      taskOutput !== null &&
      typeof taskOutput === 'object' &&
      'taskId' in taskOutput &&
      typeof (taskOutput as Record<string, unknown>).taskId === 'string'
    ) {
      return (taskOutput as Record<string, unknown>).taskId as string;
    }
    return 'unknown';
  }
}
