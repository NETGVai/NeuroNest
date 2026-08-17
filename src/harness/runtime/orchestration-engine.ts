/**
 * Orchestration_Engine — Bounded subagent delegation with parent-child lineage.
 *
 * Extends the existing Orchestration_Engine authority for:
 * - In-process, fork-from-history, and isolated worker delegation (Req 5.1)
 * - Parent-child lineage in Session_Log (Req 5.2)
 * - Observe-only progress without parent mutation (Req 5.3)
 * - Validated result injection to parent inbox (Req 5.4)
 * - Time/token/cost/output/continuation budget enforcement (Req 5.5)
 * - Bounded competitive evaluation candidates (Req 5.6)
 * - Transfer durable children to Job_Service on parent end (Req 5.7)
 *
 * Requirements: 5.1–5.7
 */

import type {
  DelegationCommandV1,
  SubagentLineageRecordV1,
  SubagentProgressEventV1,
  SubagentResultV1,
  SubagentState,
  BudgetExceededResultV1,
  ResourceBudgetV1,
  OrchestrationConfig,
  InjectionPolicy,
  DelegationMode,
} from './orchestration-schemas';
import {
  DelegationCommandV1Schema,
  TERMINAL_SUBAGENT_STATES,
} from './orchestration-schemas';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Executor function provided by the delegation mode implementation.
 * Receives goal, scope, budgets, and an abort signal.
 * Returns a result payload or throws on failure.
 */
export type SubagentExecutor = (
  childId: string,
  goal: string,
  mode: DelegationMode,
  budget: ResourceBudgetV1,
  signal: AbortSignal,
  onProgress: (event: {
    childId: string;
    parentId: string;
    kind: 'status' | 'partial_result' | 'metric';
    payload: Record<string, unknown>;
    currentConsumption: {
      elapsedMs: number;
      tokensUsed: number;
      costIncurred: number;
      outputBytes: number;
      continuationsUsed: number;
    };
  }) => void,
) => Promise<unknown>;

/**
 * Validator function for subagent results before injection (Req 5.4).
 */
export type ResultValidator = (
  childId: string,
  payload: unknown,
) => { valid: boolean; errors?: string[] | undefined };

/**
 * Session log port for appending lineage and progress events.
 */
export interface OrchestrationSessionLogPort {
  appendLineage(record: SubagentLineageRecordV1): Promise<void>;
  appendProgress(event: SubagentProgressEventV1): Promise<void>;
  appendResult(result: SubagentResultV1): Promise<void>;
  appendBudgetExceeded(result: BudgetExceededResultV1): Promise<void>;
}

/**
 * Parent inbox port for injecting validated results.
 */
export interface ParentInboxPort {
  injectResult(parentId: string, result: SubagentResultV1): Promise<void>;
}

/**
 * Job_Service transfer port for durable children (Req 5.7).
 */
export interface JobServiceTransferPort {
  transferChild(childId: string, lineage: SubagentLineageRecordV1): Promise<void>;
}

/**
 * Internal tracking of an active subagent.
 */
interface ActiveSubagent {
  childId: string;
  parentId: string;
  lineage: SubagentLineageRecordV1;
  state: SubagentState;
  abortController: AbortController;
  startedAt: number;
  consumption: {
    elapsedMs: number;
    tokensUsed: number;
    costIncurred: number;
    outputBytes: number;
    continuationsUsed: number;
  };
  injectionPolicy: InjectionPolicy;
  durable: boolean;
}

/**
 * Result of a delegation attempt.
 */
export interface DelegationResult {
  childId: string;
  state: SubagentState;
  result?: SubagentResultV1 | undefined;
  budgetExceeded?: BudgetExceededResultV1 | undefined;
  error?: string | undefined;
}

/**
 * Configuration for creating an orchestration engine instance.
 */
export interface OrchestrationEngineConfig {
  config: OrchestrationConfig;
  sessionLog: OrchestrationSessionLogPort;
  parentInbox: ParentInboxPort;
  jobService: JobServiceTransferPort;
  executor: SubagentExecutor;
  resultValidator?: ResultValidator;
  generateId?: () => string;
  now?: () => string;
  clock?: () => number;
}

// ─── Engine ─────────────────────────────────────────────────────

let idCounter = 0;
function defaultGenerateId(): string {
  return `orch_${Date.now()}_${++idCounter}`;
}

function defaultNow(): string {
  return new Date().toISOString();
}

function defaultClock(): number {
  return Date.now();
}

/**
 * Creates an Orchestration_Engine that manages bounded subagent delegation.
 *
 * The engine:
 * 1. Accepts delegation commands under one canonical subagent contract (Req 5.1)
 * 2. Records lineage in Session_Log before child execution (Req 5.2)
 * 3. Appends observe-only progress events without parent mutation (Req 5.3)
 * 4. Validates and durably records results before parent inbox injection (Req 5.4)
 * 5. Enforces time/token/cost/output/continuation budgets with cancellation (Req 5.5)
 * 6. Limits parallel candidates to configured bound (Req 5.6)
 * 7. Cancels non-durable children and transfers durable ones on parent end (Req 5.7)
 */
export function createOrchestrationEngine(engineConfig: OrchestrationEngineConfig) {
  const {
    config,
    sessionLog,
    parentInbox,
    jobService,
    executor,
    resultValidator,
    generateId = defaultGenerateId,
    now = defaultNow,
    clock = defaultClock,
  } = engineConfig;

  /** Active subagents by child ID. */
  const activeSubagents = new Map<string, ActiveSubagent>();

  /** Active subagents grouped by parent ID. */
  const parentChildren = new Map<string, Set<string>>();

  /**
   * Validate a delegation command.
   */
  function validateDelegationCommand(command: DelegationCommandV1): { valid: boolean; error?: string } {
    const parsed = DelegationCommandV1Schema.safeParse(command);
    if (!parsed.success) {
      return { valid: false, error: parsed.error.message };
    }

    // Check max concurrent subagents per parent
    const existing = parentChildren.get(command.parentId);
    const activeCount = existing ? existing.size : 0;
    if (activeCount >= config.maxConcurrentSubagents) {
      return {
        valid: false,
        error: `Parent ${command.parentId} already has ${activeCount} active subagents (max: ${config.maxConcurrentSubagents})`,
      };
    }

    // Check competitive evaluation bounds
    if (command.competitiveEvaluation?.enabled) {
      const candidates = command.competitiveEvaluation.maxCandidates;
      if (candidates > config.maxCompetitiveCandidates) {
        return {
          valid: false,
          error: `Competitive candidates ${candidates} exceeds configured bound ${config.maxCompetitiveCandidates}`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Create a budget monitoring timer that cancels the child on budget exceed.
   */
  function createBudgetMonitor(
    subagent: ActiveSubagent,
    budget: ResourceBudgetV1,
  ): NodeJS.Timeout {
    const interval = setInterval(() => {
      const elapsed = clock() - subagent.startedAt;
      subagent.consumption.elapsedMs = elapsed;

      // Check time budget
      if (elapsed > budget.maxTimeMs) {
        handleBudgetExceeded(subagent, 'time', budget.maxTimeMs, elapsed);
        return;
      }

      // Check token budget
      if (subagent.consumption.tokensUsed > budget.maxTokens) {
        handleBudgetExceeded(subagent, 'tokens', budget.maxTokens, subagent.consumption.tokensUsed);
        return;
      }

      // Check cost budget
      if (subagent.consumption.costIncurred > budget.maxCost) {
        handleBudgetExceeded(subagent, 'cost', budget.maxCost, subagent.consumption.costIncurred);
        return;
      }

      // Check output budget
      if (subagent.consumption.outputBytes > budget.maxOutputBytes) {
        handleBudgetExceeded(subagent, 'output', budget.maxOutputBytes, subagent.consumption.outputBytes);
        return;
      }

      // Check continuation budget
      if (subagent.consumption.continuationsUsed > budget.maxContinuations) {
        handleBudgetExceeded(subagent, 'continuations', budget.maxContinuations, subagent.consumption.continuationsUsed);
        return;
      }
    }, 100);

    return interval;
  }

  /**
   * Handle a budget being exceeded — cancel child and publish partial result (Req 5.5).
   */
  async function handleBudgetExceeded(
    subagent: ActiveSubagent,
    exceededBudget: 'time' | 'tokens' | 'cost' | 'output' | 'continuations',
    limit: number,
    actual: number,
  ): Promise<void> {
    if (TERMINAL_SUBAGENT_STATES.has(subagent.state)) return;

    subagent.state = 'cancelled_budget_exceeded';
    subagent.abortController.abort();

    const budgetExceeded: BudgetExceededResultV1 = {
      childId: subagent.childId,
      exceededBudget,
      budgetLimit: limit,
      actualValue: actual,
      recordedAt: now(),
      schemaVersion: 1,
    };

    await sessionLog.appendBudgetExceeded(budgetExceeded);
    cleanupSubagent(subagent.childId);
  }

  /**
   * Handle progress from a child (Req 5.3).
   * Observe-only: no parent context mutation unless injection policy selects.
   */
  async function handleProgress(
    subagent: ActiveSubagent,
    progressData: {
      childId: string;
      parentId: string;
      kind: 'status' | 'partial_result' | 'metric';
      payload: Record<string, unknown>;
      currentConsumption: {
        elapsedMs: number;
        tokensUsed: number;
        costIncurred: number;
        outputBytes: number;
        continuationsUsed: number;
      };
    },
  ): Promise<void> {
    // Update consumption tracking
    subagent.consumption = { ...progressData.currentConsumption };

    const event: SubagentProgressEventV1 = {
      ...progressData,
      progressId: generateId(),
      reportedAt: now(),
      schemaVersion: 1,
    };

    // Always append observe-only progress event to session log
    await sessionLog.appendProgress(event);
  }

  /**
   * Validate and record a subagent result (Req 5.4).
   */
  async function handleCompletion(
    subagent: ActiveSubagent,
    payload: unknown,
  ): Promise<SubagentResultV1> {
    // Validate result if validator is configured
    let validated = true;
    let validationErrors: string[] | undefined;

    if (resultValidator) {
      const validation = resultValidator(subagent.childId, payload);
      validated = validation.valid;
      validationErrors = validation.errors;
    }

    subagent.state = 'completed';
    subagent.consumption.elapsedMs = clock() - subagent.startedAt;

    const result: SubagentResultV1 = {
      resultId: generateId(),
      childId: subagent.childId,
      terminalState: 'completed',
      validated,
      validationErrors,
      payload,
      finalConsumption: { ...subagent.consumption },
      injectedToParent: false,
      recordedAt: now(),
      schemaVersion: 1,
    };

    // Durably record the result
    await sessionLog.appendResult(result);

    // Inject to parent if policy allows and result is validated (Req 5.3, 5.4)
    if (validated && subagent.injectionPolicy === 'on_completion') {
      result.injectedToParent = true;
      await parentInbox.injectResult(subagent.parentId, result);
    }

    cleanupSubagent(subagent.childId);
    return result;
  }

  /**
   * Clean up internal tracking for a subagent.
   */
  function cleanupSubagent(childId: string): void {
    const subagent = activeSubagents.get(childId);
    if (!subagent) return;

    activeSubagents.delete(childId);
    const siblings = parentChildren.get(subagent.parentId);
    if (siblings) {
      siblings.delete(childId);
      if (siblings.size === 0) {
        parentChildren.delete(subagent.parentId);
      }
    }
  }

  /**
   * Delegate work to a subagent (Requirements 5.1–5.6).
   *
   * Records lineage, starts execution with budget monitoring, and handles
   * completion or failure.
   */
  async function delegate(command: DelegationCommandV1): Promise<DelegationResult> {
    // Validate command
    const validation = validateDelegationCommand(command);
    if (!validation.valid) {
      return {
        childId: '',
        state: 'failed',
        error: validation.error,
      };
    }

    const childId = generateId();
    const abortController = new AbortController();

    // Record lineage BEFORE execution (Req 5.2)
    const lineage: SubagentLineageRecordV1 = {
      lineageId: generateId(),
      parentId: command.parentId,
      childId,
      sourceSequence: command.sourceSequence,
      goal: command.goal,
      scope: command.scope,
      budget: command.budget,
      delegationMode: command.delegationMode,
      completionAnchorId: command.completionAnchorId,
      durable: command.durable,
      createdAt: now(),
      schemaVersion: 1,
    };

    await sessionLog.appendLineage(lineage);

    // Create active subagent tracking
    const subagent: ActiveSubagent = {
      childId,
      parentId: command.parentId,
      lineage,
      state: 'running',
      abortController,
      startedAt: clock(),
      consumption: {
        elapsedMs: 0,
        tokensUsed: 0,
        costIncurred: 0,
        outputBytes: 0,
        continuationsUsed: 0,
      },
      injectionPolicy: command.injectionPolicy,
      durable: command.durable,
    };

    activeSubagents.set(childId, subagent);

    // Track under parent
    if (!parentChildren.has(command.parentId)) {
      parentChildren.set(command.parentId, new Set());
    }
    parentChildren.get(command.parentId)!.add(childId);

    // Start budget monitor
    const budgetMonitor = createBudgetMonitor(subagent, command.budget);

    try {
      // Execute subagent
      const payload = await executor(
        childId,
        command.goal,
        command.delegationMode,
        command.budget,
        abortController.signal,
        (progressData) => {
          // Fire-and-forget progress handling (observe-only)
          handleProgress(subagent, progressData).catch(() => {
            // Progress failures are non-fatal
          });
        },
      );

      clearInterval(budgetMonitor);

      // Handle successful completion
      if (!TERMINAL_SUBAGENT_STATES.has(subagent.state)) {
        const result = await handleCompletion(subagent, payload);
        return { childId, state: 'completed', result };
      }

      // Budget was already exceeded during execution
      return { childId, state: subagent.state };
    } catch (error) {
      clearInterval(budgetMonitor);

      if (TERMINAL_SUBAGENT_STATES.has(subagent.state)) {
        // Already handled (budget exceeded or cancelled)
        return { childId, state: subagent.state };
      }

      subagent.state = 'failed';
      subagent.consumption.elapsedMs = clock() - subagent.startedAt;

      const result: SubagentResultV1 = {
        resultId: generateId(),
        childId,
        terminalState: 'failed',
        validated: false,
        payload: null,
        finalConsumption: { ...subagent.consumption },
        injectedToParent: false,
        recordedAt: now(),
        schemaVersion: 1,
      };

      await sessionLog.appendResult(result);
      cleanupSubagent(childId);

      return {
        childId,
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Run competitive evaluation with bounded candidates (Req 5.6).
   *
   * Launches up to maxCandidates parallel executions and selects the winner
   * based on the configured criteria. Cancels losers after selection.
   */
  async function delegateCompetitive(
    command: DelegationCommandV1,
  ): Promise<DelegationResult> {
    const evalConfig = command.competitiveEvaluation;
    if (!evalConfig?.enabled) {
      return delegate(command);
    }

    const candidateCount = Math.min(
      evalConfig.maxCandidates,
      config.maxCompetitiveCandidates,
    );

    // Launch bounded candidates
    const candidates: Promise<DelegationResult>[] = [];
    for (let i = 0; i < candidateCount; i++) {
      const candidateCommand = {
        ...command,
        commandId: generateId(),
      } as DelegationCommandV1;
      delete (candidateCommand as Record<string, unknown>)['competitiveEvaluation'];
      candidates.push(delegate(candidateCommand));
    }

    // Select based on criteria
    if (evalConfig.selectionCriteria === 'first_complete') {
      // Return the first successful result using race-based approach
      let winner: DelegationResult | null = null;
      const settled = await Promise.allSettled(
        candidates.map(async (p) => {
          const r = await p;
          if (r.state === 'completed' && !winner) {
            winner = r;
          }
          return r;
        }),
      );

      // Cancel remaining candidates
      for (const s of settled) {
        if (s.status === 'fulfilled' && s.value.childId && s.value.state !== 'completed') {
          cancelChild(s.value.childId);
        }
      }

      if (winner) return winner;

      // All failed — return first result
      const first = settled.find(
        (r) => r.status === 'fulfilled',
      ) as PromiseFulfilledResult<DelegationResult> | undefined;
      return first?.value ?? { childId: '', state: 'failed', error: 'All candidates failed' };
    }

    // For best_quality and lowest_cost: wait for all, then select
    const allResults = await Promise.allSettled(candidates);
    const completedResults = allResults
      .filter((r): r is PromiseFulfilledResult<DelegationResult> =>
        r.status === 'fulfilled' && r.value.state === 'completed',
      )
      .map((r) => r.value);

    if (completedResults.length === 0) {
      return { childId: '', state: 'failed', error: 'All competitive candidates failed' };
    }

    if (evalConfig.selectionCriteria === 'lowest_cost') {
      completedResults.sort((a, b) =>
        (a.result?.finalConsumption.costIncurred ?? Infinity) -
        (b.result?.finalConsumption.costIncurred ?? Infinity),
      );
    }

    return completedResults[0]!;
  }

  /**
   * Cancel a specific child (used internally and for parent-end cleanup).
   */
  function cancelChild(childId: string): void {
    const subagent = activeSubagents.get(childId);
    if (!subagent || TERMINAL_SUBAGENT_STATES.has(subagent.state)) return;

    subagent.state = 'cancelled_parent_ended';
    subagent.abortController.abort();
    cleanupSubagent(childId);
  }

  /**
   * Handle parent session ending (Req 5.7).
   *
   * Cancels non-durable children and transfers explicitly durable children
   * to Job_Service ownership.
   */
  async function handleParentSessionEnd(parentId: string): Promise<void> {
    const children = parentChildren.get(parentId);
    if (!children) return;

    const childIds = [...children];
    for (const childId of childIds) {
      const subagent = activeSubagents.get(childId);
      if (!subagent) continue;

      if (subagent.durable) {
        // Transfer to Job_Service (Req 5.7)
        subagent.state = 'transferred_to_job_service';
        await jobService.transferChild(childId, subagent.lineage);
        cleanupSubagent(childId);
      } else {
        // Cancel non-durable children
        cancelChild(childId);
      }
    }
  }

  /**
   * Get current state of an active subagent.
   */
  function getSubagentState(childId: string): ActiveSubagent | undefined {
    return activeSubagents.get(childId);
  }

  /**
   * Get all active children for a parent.
   */
  function getActiveChildren(parentId: string): string[] {
    const children = parentChildren.get(parentId);
    return children ? [...children] : [];
  }

  /**
   * Update consumption metrics for a child (called by executor).
   */
  function updateConsumption(
    childId: string,
    updates: Partial<ActiveSubagent['consumption']>,
  ): void {
    const subagent = activeSubagents.get(childId);
    if (!subagent) return;

    if (updates.tokensUsed !== undefined) subagent.consumption.tokensUsed = updates.tokensUsed;
    if (updates.costIncurred !== undefined) subagent.consumption.costIncurred = updates.costIncurred;
    if (updates.outputBytes !== undefined) subagent.consumption.outputBytes = updates.outputBytes;
    if (updates.continuationsUsed !== undefined) subagent.consumption.continuationsUsed = updates.continuationsUsed;
  }

  return {
    delegate,
    delegateCompetitive,
    cancelChild,
    handleParentSessionEnd,
    getSubagentState,
    getActiveChildren,
    updateConsumption,
    validateDelegationCommand,
  };
}

export type OrchestrationEngine = ReturnType<typeof createOrchestrationEngine>;
