/**
 * Concurrency_Controller — Bounded Tool Concurrency and Model-Order Commitment.
 *
 * Assigns immutable call IDs/order before dispatch, executes only configured safe
 * groups in parallel, treats exclusive/unknown calls as barriers, and commits
 * one real or synthetic result at each model-order position.
 *
 * Requirements: 14.1–14.6, 34.3
 */

import type {
  RuntimeConcurrencyClass,
  ToolCallIdentityV1,
  CommittedResultV1,
  DispatchGroupV1,
  CallResultKind,
} from './concurrency-schemas';
import {
  BARRIER_CLASSES,
  ToolCallIdentityV1Schema,
  CommittedResultV1Schema,
  DispatchGroupV1Schema,
} from './concurrency-schemas';

// ─── Types ──────────────────────────────────────────────────────

/**
 * A tool call executor function supplied by the caller.
 * Returns a canonical value ID on success, or throws/rejects on failure.
 */
export type ToolCallExecutor = (
  callIdentity: ToolCallIdentityV1,
  args: unknown,
  signal: AbortSignal,
) => Promise<string>;

/**
 * Result of executing a single call within the dispatcher.
 */
export interface CallExecutionOutcome {
  callId: string;
  modelOrderIndex: number;
  success: boolean;
  canonicalValueId?: string;
  error?: Error;
}

/**
 * The full dispatch result containing committed results in model order.
 */
export interface DispatchResult {
  /** Committed results in model-order (one per call). */
  committedResults: CommittedResultV1[];
  /** Dispatch groups that were formed. */
  groups: DispatchGroupV1[];
  /** Call identities assigned before dispatch. */
  identities: ToolCallIdentityV1[];
}

/**
 * Input for a single call within a dispatch request.
 */
export interface CallInput {
  toolName: string;
  toolVersion: string;
  concurrencyClass: RuntimeConcurrencyClass;
  parentCallId?: string;
  arguments: unknown;
}

// ─── Configuration ──────────────────────────────────────────────

export interface ConcurrencyControllerConfig {
  /** Maximum parallel safe calls (from Settings_Service). */
  parallelToolLimit: number;
  /** ID generator for call IDs and group IDs. */
  generateId?: () => string;
  /** Time source for testability. */
  now?: () => string;
}

// ─── Controller ─────────────────────────────────────────────────

let idCounter = 0;
function defaultGenerateId(): string {
  return `call_${Date.now()}_${++idCounter}`;
}

function defaultNow(): string {
  return new Date().toISOString();
}

/**
 * Creates a ConcurrencyController that orchestrates bounded tool call dispatch
 * with model-order commitment.
 *
 * The controller:
 * 1. Assigns immutable monotonic call identities before dispatch (Req 14.1)
 * 2. Groups contiguous safe calls for parallel execution (Req 14.3)
 * 3. Treats exclusive/unknown calls as barriers (Req 14.3, 14.6)
 * 4. Respects configured parallel limit (Req 14.2)
 * 5. Commits exactly one real or synthetic result at each position (Req 14.5)
 * 6. Cancels pending calls when a barrier call fails (Req 14.6 implied by 14.5)
 * 7. Preserves provider-returned tool call order (Req 34.3)
 */
export function createConcurrencyController(config: ConcurrencyControllerConfig) {
  const {
    parallelToolLimit,
    generateId = defaultGenerateId,
    now = defaultNow,
  } = config;

  if (parallelToolLimit < 1 || !Number.isFinite(parallelToolLimit)) {
    throw new Error(
      `parallelToolLimit must be a positive finite integer, got: ${parallelToolLimit}`,
    );
  }

  /**
   * Assign immutable call identities to all calls before dispatch (Req 14.1, 34.3).
   *
   * Model-order indices are assigned in the provider-returned order,
   * preserving Requirement 34.3.
   */
  function assignIdentities(
    turnId: string,
    stepId: string,
    calls: CallInput[],
  ): ToolCallIdentityV1[] {
    const timestamp = now();
    return calls.map((call, index) => {
      const identity: ToolCallIdentityV1 = {
        callId: generateId(),
        turnId,
        stepId,
        parentCallId: call.parentCallId,
        modelOrderIndex: index,
        toolName: call.toolName,
        toolVersion: call.toolVersion,
        concurrencyClass: call.concurrencyClass,
        assignedAt: timestamp,
        schemaVersion: 1,
      };
      // Validate the generated identity
      ToolCallIdentityV1Schema.parse(identity);
      return identity;
    });
  }

  /**
   * Form dispatch groups from ordered call identities (Req 14.2, 14.3, 14.6).
   *
   * Contiguous safe calls form parallel groups. Exclusive or unknown calls
   * form single-call barrier groups.
   */
  function formDispatchGroups(identities: ToolCallIdentityV1[]): DispatchGroupV1[] {
    const groups: DispatchGroupV1[] = [];
    let currentSafeGroup: ToolCallIdentityV1[] = [];

    function flushSafeGroup(): void {
      if (currentSafeGroup.length === 0) return;
      const first = currentSafeGroup[0]!;
      const last = currentSafeGroup[currentSafeGroup.length - 1]!;
      const group: DispatchGroupV1 = {
        groupId: generateId(),
        kind: 'parallel_safe',
        callIds: currentSafeGroup.map((c) => c.callId),
        modelOrderRange: [
          first.modelOrderIndex,
          last.modelOrderIndex,
        ],
        parallelLimit: parallelToolLimit,
        schemaVersion: 1,
      };
      DispatchGroupV1Schema.parse(group);
      groups.push(group);
      currentSafeGroup = [];
    }

    for (const identity of identities) {
      if (BARRIER_CLASSES.has(identity.concurrencyClass)) {
        // Flush any accumulated safe group first
        flushSafeGroup();
        // Create a barrier group for this single call
        const barrierGroup: DispatchGroupV1 = {
          groupId: generateId(),
          kind: 'barrier',
          callIds: [identity.callId],
          modelOrderRange: [identity.modelOrderIndex, identity.modelOrderIndex],
          parallelLimit: 1,
          schemaVersion: 1,
        };
        DispatchGroupV1Schema.parse(barrierGroup);
        groups.push(barrierGroup);
      } else {
        // Accumulate safe calls
        currentSafeGroup.push(identity);
      }
    }

    // Flush remaining safe calls
    flushSafeGroup();

    return groups;
  }

  /**
   * Execute a parallel-safe group with bounded concurrency (Req 14.2).
   *
   * Runs up to `parallelToolLimit` calls concurrently using a semaphore pattern.
   * If the abort signal fires, remaining calls receive synthetic cancelled results.
   */
  async function executeParallelGroup(
    identities: ToolCallIdentityV1[],
    callArgs: Map<string, unknown>,
    executor: ToolCallExecutor,
    signal: AbortSignal,
  ): Promise<CallExecutionOutcome[]> {
    const outcomes: CallExecutionOutcome[] = [];
    let activeCount = 0;
    let nextIndex = 0;
    const total = identities.length;

    return new Promise<CallExecutionOutcome[]>((resolve) => {
      function tryLaunchNext(): void {
        while (activeCount < parallelToolLimit && nextIndex < total) {
          if (signal.aborted) {
            // Cancel all remaining
            for (let i = nextIndex; i < total; i++) {
              const remaining = identities[i]!;
              outcomes.push({
                callId: remaining.callId,
                modelOrderIndex: remaining.modelOrderIndex,
                success: false,
                error: new Error('Cancelled by abort signal'),
              });
            }
            nextIndex = total;
            checkComplete();
            return;
          }

          const identity = identities[nextIndex]!;
          const args = callArgs.get(identity.callId);
          nextIndex++;
          activeCount++;

          executor(identity, args, signal)
            .then((canonicalValueId) => {
              outcomes.push({
                callId: identity.callId,
                modelOrderIndex: identity.modelOrderIndex,
                success: true,
                canonicalValueId,
              });
            })
            .catch((error) => {
              outcomes.push({
                callId: identity.callId,
                modelOrderIndex: identity.modelOrderIndex,
                success: false,
                error: error instanceof Error ? error : new Error(String(error)),
              });
            })
            .finally(() => {
              activeCount--;
              tryLaunchNext();
              checkComplete();
            });
        }
        checkComplete();
      }

      function checkComplete(): void {
        if (outcomes.length === total) {
          resolve(outcomes);
        }
      }

      tryLaunchNext();
    });
  }

  /**
   * Execute a barrier group (single exclusive/unknown call) (Req 14.3, 14.6).
   */
  async function executeBarrierGroup(
    identity: ToolCallIdentityV1,
    args: unknown,
    executor: ToolCallExecutor,
    signal: AbortSignal,
  ): Promise<CallExecutionOutcome> {
    if (signal.aborted) {
      return {
        callId: identity.callId,
        modelOrderIndex: identity.modelOrderIndex,
        success: false,
        error: new Error('Cancelled by abort signal'),
      };
    }

    try {
      const canonicalValueId = await executor(identity, args, signal);
      return {
        callId: identity.callId,
        modelOrderIndex: identity.modelOrderIndex,
        success: true,
        canonicalValueId,
      };
    } catch (error) {
      return {
        callId: identity.callId,
        modelOrderIndex: identity.modelOrderIndex,
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Commit results in model order (Req 14.4, 14.5, 34.3).
   *
   * Produces exactly one CommittedResultV1 per model-order position.
   * Failed calls receive synthetic results. After a barrier failure,
   * subsequent calls in later groups receive synthetic_barrier_failure.
   */
  function commitResultsInModelOrder(
    identities: ToolCallIdentityV1[],
    outcomes: CallExecutionOutcome[],
    barrierFailed: boolean,
    failedBarrierIndex: number,
  ): CommittedResultV1[] {
    const outcomeMap = new Map<string, CallExecutionOutcome>();
    for (const outcome of outcomes) {
      outcomeMap.set(outcome.callId, outcome);
    }

    const timestamp = now();
    const committed: CommittedResultV1[] = [];

    // Sort identities by model order to commit in order
    const sorted = [...identities].sort(
      (a, b) => a.modelOrderIndex - b.modelOrderIndex,
    );

    for (const identity of sorted) {
      const outcome = outcomeMap.get(identity.callId);
      let resultKind: CallResultKind;
      let canonicalValueId: string | undefined;
      let syntheticReason: string | undefined;

      if (
        barrierFailed &&
        identity.modelOrderIndex > failedBarrierIndex
      ) {
        // Calls after a failed barrier get synthetic barrier failure (Req 14.6)
        resultKind = 'synthetic_barrier_failure';
        syntheticReason = `Skipped: barrier call at position ${failedBarrierIndex} failed`;
      } else if (!outcome) {
        // No outcome — call was never dispatched
        resultKind = 'synthetic_cancelled';
        syntheticReason = 'Call was not dispatched';
      } else if (outcome.success) {
        resultKind = 'real';
        canonicalValueId = outcome.canonicalValueId;
      } else if (outcome.error?.message.includes('abort') || outcome.error?.message.includes('Cancel')) {
        resultKind = 'synthetic_cancelled';
        syntheticReason = outcome.error?.message ?? 'Cancelled';
      } else {
        // Failed execution — still commit a synthetic result
        resultKind = 'synthetic_denied';
        syntheticReason = outcome.error?.message ?? 'Execution failed';
      }

      const result: CommittedResultV1 = {
        callId: identity.callId,
        modelOrderIndex: identity.modelOrderIndex,
        resultKind,
        canonicalValueId,
        syntheticReason,
        committedAt: timestamp,
        schemaVersion: 1,
      };
      CommittedResultV1Schema.parse(result);
      committed.push(result);
    }

    return committed;
  }

  /**
   * Dispatch a batch of tool calls with bounded concurrency and model-order commitment.
   *
   * This is the main entry point. It:
   * 1. Assigns immutable identities in provider-returned order (Req 14.1, 34.3)
   * 2. Forms dispatch groups based on concurrency classification (Req 14.3)
   * 3. Executes groups sequentially; safe groups run calls in parallel (Req 14.2)
   * 4. Treats exclusive/unknown as barriers (Req 14.3, 14.6)
   * 5. When a barrier fails, cancels all subsequent groups (Req 14.6 via 14.5)
   * 6. Commits exactly one result at each model-order position (Req 14.5, 34.3)
   */
  async function dispatch(
    turnId: string,
    stepId: string,
    calls: CallInput[],
    executor: ToolCallExecutor,
    signal: AbortSignal,
  ): Promise<DispatchResult> {
    // 1. Assign immutable identities preserving provider-returned order
    const identities = assignIdentities(turnId, stepId, calls);

    // Build a map of callId → arguments for executor lookup
    const callArgs = new Map<string, unknown>();
    for (let i = 0; i < identities.length; i++) {
      const identity = identities[i]!;
      const call = calls[i]!;
      callArgs.set(identity.callId, call.arguments);
    }

    // 2. Form dispatch groups
    const groups = formDispatchGroups(identities);

    // 3. Execute groups sequentially, collecting outcomes
    const allOutcomes: CallExecutionOutcome[] = [];
    let barrierFailed = false;
    let failedBarrierIndex = -1;

    // Build identity lookup by callId
    const identityMap = new Map<string, ToolCallIdentityV1>();
    for (const identity of identities) {
      identityMap.set(identity.callId, identity);
    }

    for (const group of groups) {
      if (barrierFailed || signal.aborted) {
        // All calls in subsequent groups get synthetic barrier failure
        for (const callId of group.callIds) {
          const identity = identityMap.get(callId)!;
          allOutcomes.push({
            callId,
            modelOrderIndex: identity.modelOrderIndex,
            success: false,
            error: new Error(
              barrierFailed
                ? `Skipped: barrier at position ${failedBarrierIndex} failed`
                : 'Cancelled by abort signal',
            ),
          });
        }
        continue;
      }

      if (group.kind === 'parallel_safe') {
        // Execute safe group in parallel with bounded concurrency
        const groupIdentities = group.callIds.map((id) => identityMap.get(id)!);
        const outcomes = await executeParallelGroup(
          groupIdentities,
          callArgs,
          executor,
          signal,
        );
        allOutcomes.push(...outcomes);
      } else {
        // Barrier group — single call executed sequentially
        const barrierCallId = group.callIds[0]!;
        const identity = identityMap.get(barrierCallId)!;
        const args = callArgs.get(identity.callId);
        const outcome = await executeBarrierGroup(identity, args, executor, signal);
        allOutcomes.push(outcome);

        // If barrier fails, mark so subsequent groups are cancelled (Req 14.6)
        if (!outcome.success) {
          barrierFailed = true;
          failedBarrierIndex = identity.modelOrderIndex;
        }
      }
    }

    // 4. Commit results in model order
    const committedResults = commitResultsInModelOrder(
      identities,
      allOutcomes,
      barrierFailed,
      failedBarrierIndex,
    );

    return {
      committedResults,
      groups,
      identities,
    };
  }

  return {
    dispatch,
    assignIdentities,
    formDispatchGroups,
  };
}

export type ConcurrencyController = ReturnType<typeof createConcurrencyController>;
