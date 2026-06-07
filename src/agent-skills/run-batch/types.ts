//
// Type definitions for the agent-facing `runBatch` tool. The runBatch
// tool fans out 1..50 tool-call descriptors, executes them concurrently
// via Promise.allSettled over a pre-sized result array, and returns
// per-descriptor envelopes in input order with per-call failure
// isolation (Req 4.1, 4.2, 4.5, 4.9). Each descriptor is consulted
// against the Phase 3 ToolGate before dispatch (Req 4.7), and the
// runBatch tool itself is excluded from the dispatch table to prevent
// recursive nesting (Req 4.6, enforced at registration time in 7.3).
//
// Validates: Requirements 4.1, 4.2, 4.3, 4.5, 4.7, 4.9, 4.10

import type { ExecutableToolDefinition } from '../../tools/tool-system.js';

// ─── Phase 3 forward-declarations (read-only references) ────────
//
// The design references `OnboardingState` and `ToolGate` as Phase 3
// types. They are declared locally here so this types module is
// self-contained at compile time; when the Phase 3 onboarding state
// machine lands, these aliases should be replaced with imports from
// the Phase 3 module without changing any consumer's call site shape.

/**
 * Phase 3 onboarding state — the set of states tracked by the
 * Onboarding_State_Machine. The two states `taskExecuting` and
 * `complete` are the ones that allow Code_Tool dispatch (Req 4.7,
 * 4.8); any other state forbids Code_Tool descriptors and yields a
 * `tool_gated` envelope.
 *
 * Declared as a string-literal union plus a generic string fallback
 * so that future Phase 3 state additions don't break this file's
 * compile while still type-narrowing on the two well-known states
 * the gating logic tests against.
 */
export type OnboardingState =
  | 'taskExecuting'
  | 'complete'
  | (string & { readonly __onboardingStateBrand?: unique symbol });

/**
 * Phase 3 ToolGate — consulted per descriptor before dispatch
 * (Req 4.7, 4.8). The minimal contract used by `RunBatchTool.execute`
 * is `dispatch(toolId, featureName)`, which returns either a
 * pass-through allowing dispatch to proceed or a gated rejection
 * carrying the current state for the failure envelope.
 */
export interface ToolGate {
  /**
   * Decide whether `toolId` is permitted under the current onboarding
   * state for `featureName`. Returns `{ allowed: true }` to proceed
   * with dispatch, or `{ allowed: false; currentState }` to reject
   * the descriptor with a `tool_gated` envelope.
   */
  dispatch(
    toolId: string,
    featureName: string,
  ): { allowed: true } | { allowed: false; currentState: OnboardingState };
}

// ─── Public types ───────────────────────────────────────────────

/**
 * A single tool call inside a runBatch invocation. The `tool` field
 * is a tool ID drawn from the union of Phase 1 + Phase 2 chat-tool-
 * registry IDs (Req 4.6); the runBatch tool itself is excluded from
 * this surface to prevent recursive batch nesting (enforced at
 * registration time in task 7.3).
 */
export interface ToolCallDescriptor {
  /** Tool ID from the union of Phase 1 + Phase 2 chat-tool-registry IDs
   *  (Req 4.6). The runBatch tool itself is excluded from this surface
   *  to avoid recursive batch nesting. */
  tool:  string;
  /** Tool input — the same shape that tool's standalone invocation
   *  accepts. Validated by the dispatched tool's own input schema. */
  input: unknown;
}

/**
 * Top-level input to the runBatch tool. The `calls` array is bounded
 * to 1..50 inclusive (Req 4.3, 4.4); inputs outside that range are
 * rejected before any descriptor is dispatched.
 */
export interface RunBatchInput {
  /** Length 1..50 inclusive (Req 4.3, 4.4). */
  calls: ReadonlyArray<ToolCallDescriptor>;
}

/**
 * Per-descriptor success envelope. The `index` field carries the
 * descriptor's input position (Req 4.2, 4.9), and `output` carries
 * the dispatched tool's result payload unchanged.
 */
export interface BatchCallSuccess {
  index:  number;       // input position — Req 4.2, 4.9
  ok:     true;
  output: unknown;
}

/**
 * Per-descriptor failure envelope. Failures are isolated per
 * descriptor (Req 4.5, 4.8, 4.10) and never abort sibling descriptors.
 * The `error` discriminator distinguishes the four failure modes:
 *   - `unknown_tool`  — `resolveTool` returned undefined (Req 4.10).
 *   - `tool_gated`    — Phase 3 ToolGate forbade dispatch under the
 *                       current onboarding state (Req 4.7, 4.8).
 *   - `invalid_input` — the descriptor input failed the dispatched
 *                       tool's input schema validation.
 *   - `tool_failed`   — the dispatched tool's `execute` threw or
 *                       returned a structured error (Req 4.5).
 */
export interface BatchCallFailure {
  index:  number;
  ok:     false;
  error:
    | { kind: 'unknown_tool';   tool: string }                            // Req 4.10
    | { kind: 'tool_gated';     tool: string; currentState: OnboardingState } // Req 4.7, 4.8
    | { kind: 'invalid_input';  detail: string }
    | { kind: 'tool_failed';    detail: string };                          // Req 4.5
}

/**
 * Discriminated union of per-descriptor outcomes. Each result envelope
 * carries `index` so consumers can correlate it back to the originating
 * descriptor regardless of how the underlying tools' `execute`
 * promises settle.
 */
export type BatchCallOutcome = BatchCallSuccess | BatchCallFailure;

/**
 * Top-level output of the runBatch tool. The `results` array length
 * matches the input `calls` length, and `results[i].index === i`
 * for every `i` (Req 4.2, 4.9) — the input-order invariant is
 * structural, achieved by writing each descriptor's outcome into a
 * pre-sized slot rather than via post-hoc sorting.
 */
export interface RunBatchOutput {
  results: ReadonlyArray<BatchCallOutcome>;     // length === calls.length
}

/**
 * The runBatch tool's public interface. Tool ID: `'runBatch'`.
 *
 * Hard invariants (Req 4.1, 4.2, 4.4, 4.5, 4.7, 4.8, 4.9, 4.10):
 *   - results.length === calls.length and results[i].index === i for
 *     all i.
 *   - calls.length < 1 OR calls.length > 50 → rejected before any
 *     dispatch with kind: 'invalid_input' on the wrapping promise;
 *     zero descriptors are executed.
 *   - One descriptor's rejection or thrown error is captured into
 *     its envelope and never aborts another descriptor.
 *   - Each descriptor goes through ToolGate.dispatch — Code_Tool
 *     descriptors are rejected with `tool_gated` when state forbids
 *     them, while Spec_Tool and other allowed descriptors continue
 *     in the same batch.
 *   - The runBatch tool itself is NEVER in the dispatch table for
 *     descriptors — recursion is prevented at registration time
 *     (task 7.3).
 */
export interface RunBatchTool {
  /**
   * Execute 1..50 descriptors in parallel and return one envelope
   * per descriptor at the same index. The wrapping promise only
   * rejects on the length-bounds branch; all per-descriptor failures
   * (including thrown errors and rejections) are captured into
   * `BatchCallFailure` envelopes inside the success-shaped result.
   */
  execute(input: RunBatchInput, ctx: BatchContext):
    Promise<{ ok: true;  output: RunBatchOutput }
          | { ok: false; error: { kind: 'invalid_input'; detail: string } }>;
}

/**
 * Execution context passed to `RunBatchTool.execute`. Wires the
 * Phase 3 ToolGate, the active spec featureName, the per-descriptor
 * tool resolver (which excludes `runBatch` itself by construction),
 * and the parent agent turn's cancellation signal.
 */
export interface BatchContext {
  /** Phase 3 — used per-descriptor (Req 4.7, 4.8). */
  toolGate:        ToolGate;
  /** The active spec featureName (used by ToolGate.dispatch). */
  featureName:     string;
  /** Resolves a tool ID to its registered ExecutableToolDefinition.
   *  Returns undefined for unknown tools (Req 4.10) — drives the
   *  `unknown_tool` error envelope. */
  resolveTool:     (toolId: string) => ExecutableToolDefinition | undefined;
  /** AbortSignal that fires when the parent agent turn is cancelled.
   *  All in-flight descriptors observe the same signal. */
  abortSignal:     AbortSignal;
}
