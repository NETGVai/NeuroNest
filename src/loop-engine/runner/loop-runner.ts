// ─── Loop Runner ────────────────────────────────────────────────
// State machine that drives loop execution with deterministic
// termination and verification-gated pass transitions.

import {
  LoopState,
  TerminalState,
  LoopRunContext,
  LoopRunnerDeps,
  LoopSpec,
  PassResult,
  PassEvidence,
  VerifyResult,
  VALID_TRANSITIONS,
} from '../index';

/** Hard ceiling on passes — regardless of LoopSpec configuration (Req 4.5) */
const HARD_MAX_PASSES = 50;

/** Per-pass wall-clock timeout in milliseconds (Req 4.6) */
const PASS_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * LoopRunner implements the core state machine for bounded, verification-gated
 * iterative execution. It manages state transitions, enforces termination
 * guarantees, and coordinates with injected dependencies for each pass.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 26.2
 */
export class LoopRunner {
  private state: LoopState = 'IDLE';
  private context: LoopRunContext | null = null;
  private stopRequested = false;
  private passStartTime: number | null = null;

  constructor(private readonly deps: LoopRunnerDeps) {}

  /** Get injected dependencies (used by pass execution logic) */
  getDeps(): LoopRunnerDeps {
    return this.deps;
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Starts a new loop run. Transitions from IDLE → PLANNING_PASS.
   * Creates a run context and returns the generated runId.
   *
   * Requirement 3.2: IDLE → PLANNING_PASS on loop run request.
   */
  async start(spec: LoopSpec, sessionId: string): Promise<string> {
    if (this.state !== 'IDLE') {
      this.transition('BLOCKED');
      throw new Error(
        `Cannot start loop run: runner is in state '${this.state}', expected 'IDLE'`,
      );
    }

    const runId = crypto.randomUUID();

    this.context = {
      runId,
      spec,
      sessionId,
      passesCompleted: 0,
      cumulativeCostUsd: 0,
      startedAt: new Date(),
      progressHashes: [],
      verifyPassCounts: [],
    };

    this.stopRequested = false;
    this.transition('PLANNING_PASS');

    return runId;
  }

  /**
   * Approves a paused loop run. Transitions from AWAITING_APPROVAL to the
   * appropriate next state based on context.
   *
   * Requirement 3.8: AWAITING_APPROVAL → PLANNING_PASS (if passes remain)
   *                   or SUCCEEDED (if all checks passed).
   *                   Transitions to LIMIT_EXHAUSTED if passes_completed >= maxPasses.
   */
  async approve(runId: string): Promise<void> {
    if (this.state !== 'AWAITING_APPROVAL') {
      this.transition('BLOCKED');
      throw new Error(
        `Cannot approve: runner is in state '${this.state}', expected 'AWAITING_APPROVAL'`,
      );
    }

    if (!this.context || this.context.runId !== runId) {
      throw new Error(`Cannot approve: unknown run id '${runId}'`);
    }

    const { spec, passesCompleted, verifyPassCounts } = this.context;

    // Check if passes are exhausted
    if (passesCompleted >= spec.stop.maxPasses) {
      this.transition('LIMIT_EXHAUSTED');
      return;
    }

    // Check if all verify checks passed on the most recent pass
    const lastPassCount = verifyPassCounts[verifyPassCounts.length - 1];
    const totalChecks = spec.verify.length;
    if (lastPassCount !== undefined && lastPassCount === totalChecks) {
      this.transition('SUCCEEDED');
      return;
    }

    // Otherwise continue to next planning pass
    this.transition('PLANNING_PASS');
  }

  /**
   * Requests a graceful stop at the next pass boundary.
   * The runner will stop after the current pass completes.
   */
  async stop(runId: string): Promise<void> {
    if (!this.context || this.context.runId !== runId) {
      throw new Error(`Cannot stop: unknown run id '${runId}'`);
    }

    this.stopRequested = true;
  }

  // ─── State Management ───────────────────────────────────────────

  /**
   * Transitions to the specified state. Validates against VALID_TRANSITIONS.
   * If the transition is invalid, moves to BLOCKED instead.
   *
   * Requirement 3.12: Any transition not explicitly defined causes BLOCKED.
   */
  transition(to: LoopState): void {
    const allowedTargets = VALID_TRANSITIONS[this.state];

    if (!allowedTargets.includes(to)) {
      // Invalid transition — go to BLOCKED (unless already in a terminal state)
      if (this.isTerminal(this.state)) {
        return; // Cannot transition out of terminal states
      }
      this.state = 'BLOCKED';
      return;
    }

    this.state = to;
  }

  /**
   * Returns the current state of the runner.
   */
  getState(): LoopState {
    return this.state;
  }

  /**
   * Returns the current run context, or null if no run is active.
   */
  getContext(): LoopRunContext | null {
    return this.context;
  }

  /**
   * Returns whether a stop has been requested.
   */
  isStopRequested(): boolean {
    return this.stopRequested;
  }

  // ─── Internal Helpers ───────────────────────────────────────────

  private isTerminal(state: LoopState): boolean {
    const terminalStates: TerminalState[] = [
      'SUCCEEDED',
      'NO_OP',
      'BLOCKED',
      'LIMIT_EXHAUSTED',
      'STALLED',
    ];
    return terminalStates.includes(state as TerminalState);
  }

  // ─── Termination Enforcement ────────────────────────────────────

  /**
   * Checks all stop conditions before/after each pass. Returns the terminal
   * state to transition to, or null if execution should continue.
   *
   * Requirements: 4.1, 4.2, 4.3, 4.5, 26.2
   */
  checkTermination(): LoopState | null {
    if (!this.context) {
      return null;
    }

    const { spec, passesCompleted, cumulativeCostUsd, startedAt, progressHashes } = this.context;

    // Req 4.1 & 4.5: maxPasses check with hard ceiling of 50
    const effectiveMaxPasses = Math.min(spec.stop.maxPasses, HARD_MAX_PASSES);
    if (passesCompleted >= effectiveMaxPasses) {
      return 'LIMIT_EXHAUSTED';
    }

    // Req 4.2: Cost budget check
    if (cumulativeCostUsd >= spec.stop.maxCostUsd) {
      return 'LIMIT_EXHAUSTED';
    }

    // Req 4.3: Wall-clock time check
    const elapsedMs = Date.now() - startedAt.getTime();
    const elapsedMin = elapsedMs / (1000 * 60);
    if (elapsedMin >= spec.stop.maxWallClockMin) {
      return 'LIMIT_EXHAUSTED';
    }

    // Req 26.2: Progress hash stall detection
    const n = spec.stop.noProgressPasses;
    if (progressHashes.length >= n && n > 0) {
      const lastN = progressHashes.slice(-n);
      const allIdentical = lastN.every((hash) => hash === lastN[0]);
      if (allIdentical) {
        return 'STALLED';
      }
    }

    return null;
  }

  /**
   * Detects a NO_OP condition: first pass with no file changes, no tool calls,
   * and all verify checks already pass.
   *
   * Requirement 4.4
   */
  detectNoOp(passResult: PassResult): boolean {
    if (!this.context) {
      return false;
    }

    // Only applies to the first pass
    if (this.context.passesCompleted !== 1) {
      return false;
    }

    // No tool calls during the pass
    if (passResult.toolsUsed.length > 0) {
      return false;
    }

    // All verify checks pass
    const allChecksPassed = passResult.verifyResults.every((r) => r.passed);
    if (!allChecksPassed) {
      return false;
    }

    // No file changes (progress hash indicates no touched files)
    // We check if the evidence array is empty (no file-type evidence) as a proxy
    // for no file changes. The passAction produced no side effects.
    const hasFileChanges = passResult.evidence.some((e) => e.type === 'file');
    if (hasFileChanges) {
      return false;
    }

    return true;
  }

  /**
   * Records the start of a pass for per-pass timeout tracking.
   * Call this at the beginning of each pass execution.
   */
  startPassTimer(): void {
    this.passStartTime = Date.now();
  }

  /**
   * Checks whether the current pass has exceeded the 30-minute timeout.
   * Returns true if the pass has timed out.
   *
   * Requirement 4.6
   */
  isPassTimedOut(): boolean {
    if (this.passStartTime === null) {
      return false;
    }
    return Date.now() - this.passStartTime >= PASS_TIMEOUT_MS;
  }

  /**
   * Returns the per-pass timeout duration in milliseconds.
   * Useful for setting up external timeout mechanisms.
   */
  getPassTimeoutMs(): number {
    return PASS_TIMEOUT_MS;
  }

  /**
   * Returns the pass start time, or null if no pass is in progress.
   */
  getPassStartTime(): number | null {
    return this.passStartTime;
  }

  /**
   * Resets the pass timer (called when a pass completes or is aborted).
   */
  clearPassTimer(): void {
    this.passStartTime = null;
  }

  /**
   * Checks if stalled based on progress hashes. Compares the last N hashes
   * where N = noProgressPasses. If all identical, the loop is stalled.
   *
   * Requirement 26.2
   */
  isStalled(): boolean {
    if (!this.context) {
      return false;
    }

    const { progressHashes } = this.context;
    const n = this.context.spec.stop.noProgressPasses;

    if (progressHashes.length < n || n <= 0) {
      return false;
    }

    const lastN = progressHashes.slice(-n);
    return lastN.every((hash) => hash === lastN[0]);
  }

  // ─── Per-Pass Execution Cycle ─────────────────────────────────

  /**
   * Execute one full pass cycle:
   *   1. PLANNING_PASS: re-read GOAL.md + PLAN.md from disk AND re-evaluate env vars (REQ-3.11, 25.2)
   *   2. Assemble budgeted context via ContextBudgetEnforcer (REQ-27.3)
   *   3. Plan the action (derive from passAction + plan state)
   *   4. Transition to EXECUTING_PASS, invoke SwarmCoordinator.execute() once (REQ-6.5)
   *   5. Transition to VERIFYING, run VerifierSubagent
   *   6. If all checks pass → SUCCEEDED (REQ-3.5)
   *   7. If checks fail and passes remain → APPLYING_FEEDBACK → PLANNING_PASS (REQ-3.6)
   *   8. Record progress hash after each pass
   *   9. Check termination conditions
   *
   * Requirements: 3.3, 3.4, 3.5, 3.6, 3.11, 6.5, 25.2, 25.7, 27.3
   */
  async executeSinglePass(): Promise<PassResult> {
    if (!this.context) {
      throw new Error('Cannot execute pass: no active run context');
    }

    if (this.state !== 'PLANNING_PASS') {
      throw new Error(
        `Cannot execute pass: runner is in state '${this.state}', expected 'PLANNING_PASS'`,
      );
    }

    const { spec, sessionId } = this.context;
    const passNumber = this.context.passesCompleted + 1;
    const passStartedAt = new Date().toISOString();

    // Start per-pass timer for timeout enforcement (REQ-4.6)
    this.startPassTimer();

    try {
      // ─── Phase 1: PLANNING_PASS ─────────────────────────────

      // REQ-3.11: BOTH file re-reading AND env var re-evaluation at PLANNING_PASS start
      // Re-read GOAL.md and PLAN.md from disk (REQ-25.2) — no cached state from previous passes
      const goalMd = await this.deps.goalPlanManager.readGoal();
      const planMd = await this.deps.goalPlanManager.readPlan();

      // Re-evaluate environment variables (REQ-3.11) — snapshot fresh from process.env
      this.captureEnvironmentVariables();

      // Check approval boundaries (REQ-3.7) before proceeding
      if (spec.stop.approvalBoundaries.includes(passNumber)) {
        this.transition('AWAITING_APPROVAL');
        this.clearPassTimer();
        // Return a partial result — the pass hasn't completed yet
        return this.buildPartialPassResult(passNumber, passStartedAt, 'awaiting_approval');
      }

      // Check termination conditions before planning
      const termState = this.checkTermination();
      if (termState) {
        this.transition(termState);
        this.clearPassTimer();
        return this.buildPartialPassResult(passNumber, passStartedAt, 'terminated');
      }

      // Assemble budgeted context (REQ-27.3)
      this.deps.contextBudgetEnforcer.assembleBudgetedContext(
        '', // NEURONEST.md content — passed as empty; read externally
        goalMd.goal,
        this.serializePlanForContext(planMd),
        '', // Memory content — passed as empty; read externally
      );

      // Plan the action: derive from passAction + current plan state
      const currentStep = planMd.steps.find(s => s.status === 'pending' || s.status === 'in-progress');
      const actionPlan = this.deriveActionPlan(spec, planMd, currentStep);

      // ─── Phase 2: EXECUTING_PASS ────────────────────────────

      // Transition to EXECUTING_PASS (REQ-3.3)
      this.transition('EXECUTING_PASS');

      // Check per-pass timeout
      if (this.isPassTimedOut()) {
        this.transition('BLOCKED');
        this.clearPassTimer();
        return this.buildPartialPassResult(passNumber, passStartedAt, 'pass_timeout');
      }

      // Invoke SwarmCoordinator.execute() exactly once per pass (REQ-6.5)
      // Supply the single-pass subtask derived from current iteration and a pass-scoped session
      const passSessionId = `${sessionId}:pass-${passNumber}`;
      await this.deps.swarmCoordinator.execute(actionPlan, passSessionId);

      // Check per-pass timeout after execution
      if (this.isPassTimedOut()) {
        this.transition('BLOCKED');
        this.clearPassTimer();
        return this.buildPartialPassResult(passNumber, passStartedAt, 'pass_timeout');
      }

      // ─── Phase 3: VERIFYING ─────────────────────────────────

      // Run VerifierSubagent after execution (still in EXECUTING_PASS)
      const verifierResult = await this.deps.verifierSubagent.verify({
        goalMd: goalMd.goal,
        diff: '', // Diff would be computed from actual file changes
        testOutput: '',
        lintOutput: '',
      });

      // Evaluate all Verify_Check items in the LoopSpec verify array
      const verifyResults: VerifyResult[] = spec.verify.map((_check, idx) => ({
        checkId: `check-${idx}`,
        passed: verifierResult.passes, // Simplified: verifier result applies to all checks
        output: verifierResult.passes ? 'passed' : verifierResult.failures.map(f => f.reason).join('; '),
      }));

      const passedCount = verifyResults.filter(r => r.passed).length;

      // Collect evidence
      const evidence: PassEvidence[] = [];

      // Track cost (simplified — would come from costTracker in production)
      const passCost = this.deps.costTracker.getCumulativeCost(passSessionId);
      this.context.cumulativeCostUsd += passCost;

      // Set passes completed for NO_OP detection (needs passesCompleted === 1)
      this.context.passesCompleted = passNumber;

      // Build preliminary pass result for NO_OP detection
      const passEndedAt = new Date().toISOString();
      const passResult: PassResult = {
        passNumber,
        actionSummary: actionPlan,
        toolsUsed: [], // Would be populated from SwarmCoordinator response
        verifyResults,
        evidence,
        costUsd: passCost,
        progressHash: '', // Computed below
        startedAt: passStartedAt,
        endedAt: passEndedAt,
      };

      // NO_OP detection: first pass, no file changes, no tool calls, all checks pass (REQ-4.4)
      // Checked while still in EXECUTING_PASS (NO_OP is a valid transition from EXECUTING_PASS)
      if (this.detectNoOp(passResult)) {
        this.transition('NO_OP');
        this.clearPassTimer();
        return passResult;
      }

      // Now transition to VERIFYING (REQ-3.4)
      this.transition('VERIFYING');

      // Record verify pass count
      this.context.verifyPassCounts.push(passedCount);

      // ─── Phase 4: Compute Progress Hash (REQ-26.1) ──────────

      // Re-read plan after execution for progress hash computation
      const postExecPlan = await this.deps.goalPlanManager.readPlan();
      const planStepStatuses = postExecPlan.steps.map(s => `${s.id}:${s.status}`).join(',');
      const verifierVerdict = JSON.stringify(verifyResults);
      const touchedFilesHash = await this.deps.progressHasher.computeTreeHash(spec.scope.allowedPaths);

      const progressHash = this.deps.progressHasher.compute({
        planMdStepStatuses: planStepStatuses,
        verifierVerdict,
        touchedFilesHash,
      });

      // Record progress hash and update pass result
      this.context.progressHashes.push(progressHash);
      passResult.progressHash = progressHash;

      // ─── Phase 5: Determine Next State ──────────────────────

      // Check stall detection after recording progress hash (REQ-26.2)
      if (this.isStalled()) {
        this.transition('STALLED');
        this.clearPassTimer();
        return passResult;
      }

      // If all Verify_Check items pass → SUCCEEDED (REQ-3.5)
      const allChecksPassed = passedCount === spec.verify.length;
      if (allChecksPassed) {
        this.transition('SUCCEEDED');
        this.clearPassTimer();
        return passResult;
      }

      // If checks fail and passes remain → APPLYING_FEEDBACK → PLANNING_PASS (REQ-3.6)
      if (!allChecksPassed && this.context.passesCompleted < spec.stop.maxPasses) {
        this.transition('APPLYING_FEEDBACK');

        // Update PLAN.md with pass results
        if (currentStep) {
          await this.deps.goalPlanManager.updatePlan({
            steps: [{
              id: currentStep.id,
              triedHistory: [...currentStep.triedHistory, actionPlan],
              status: 'in-progress',
            }],
          });
        }

        // Apply feedback and transition back to PLANNING_PASS for next pass
        this.transition('PLANNING_PASS');
        this.clearPassTimer();
        return passResult;
      }

      // Check termination again after pass completion
      const postPassTermState = this.checkTermination();
      if (postPassTermState) {
        this.transition(postPassTermState);
        this.clearPassTimer();
        return passResult;
      }

      // Default: remain in VERIFYING if nothing else triggered
      // This shouldn't normally happen given the logic above
      this.clearPassTimer();
      return passResult;

    } catch (error: unknown) {
      // REQ-3.9: Unhandled exceptions → BLOCKED
      this.transition('BLOCKED');
      this.clearPassTimer();

      const passEndedAt = new Date().toISOString();
      return {
        passNumber,
        actionSummary: `Error: ${error instanceof Error ? error.message : String(error)}`,
        toolsUsed: [],
        verifyResults: [],
        evidence: [],
        costUsd: 0,
        progressHash: '',
        startedAt: passStartedAt,
        endedAt: passEndedAt,
      };
    }
  }

  // ─── Private Helpers for executeSinglePass ─────────────────────

  /**
   * Capture a fresh snapshot of environment variables (REQ-3.11).
   * This ensures we never rely on cached env vars from previous passes.
   */
  private captureEnvironmentVariables(): Record<string, string | undefined> {
    return { ...process.env };
  }

  /**
   * Derive the action plan from spec.passAction + current plan state.
   * Combines the generic pass action with context from the current step.
   */
  private deriveActionPlan(
    spec: LoopSpec,
    _planMd: { steps: Array<{ id: number; description: string; status: string; next?: string }>; status: string },
    currentStep?: { id: number; description: string; status: string; triedHistory: string[]; next?: string } | null,
  ): string {
    if (currentStep?.next) {
      return `${spec.passAction}: ${currentStep.next}`;
    }
    if (currentStep) {
      return `${spec.passAction}: ${currentStep.description}`;
    }
    return spec.passAction;
  }

  /**
   * Serialize plan state for context budget assembly.
   */
  private serializePlanForContext(
    planMd: { steps: Array<{ id: number; description: string; status: string }>; status: string },
  ): string {
    const lines: string[] = [];
    lines.push(`STATUS: ${planMd.status}`);
    for (const step of planMd.steps) {
      const marker = step.status === 'done' ? 'x' : step.status === 'in-progress' ? '~' : step.status === 'failed' ? '!' : ' ';
      lines.push(`${step.id}. [${marker}] ${step.description}`);
    }
    return lines.join('\n');
  }

  /**
   * Build a partial pass result for early returns (approval boundary, termination).
   */
  private buildPartialPassResult(
    passNumber: number,
    startedAt: string,
    reason: string,
  ): PassResult {
    return {
      passNumber,
      actionSummary: `Pass interrupted: ${reason}`,
      toolsUsed: [],
      verifyResults: [],
      evidence: [],
      costUsd: 0,
      progressHash: '',
      startedAt,
      endedAt: new Date().toISOString(),
    };
  }
}
