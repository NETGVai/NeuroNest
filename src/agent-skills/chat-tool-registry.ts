// Register `runBatch` in the chat tool registry.
//
// This module wires `RunBatchToolInstance` (the agent-facing `runBatch`
// tool exported by `src/agent-skills/run-batch/run-batch-tool.ts`)
// against the union of Phase 1 + Phase 2 tool IDs that the chat
// agent already exposes.
//
// The Phase 4 design treats this file as a stitching layer: it does
// NOT introduce a new execution path for `runBatch`. It only:
//
//   1. Builds a dispatch table over the Phase 1 + Phase 2 tools.
//   2. Constructs the `BatchContext.resolveTool` function from that
//      table — with a hard exclusion of `runBatch` itself, enforced
//      at registration time.
//   3. Exposes a `registerRunBatch` factory that returns the tool's
//      `ExecutableToolDefinition` ready to be inserted into the
//      chat agent's `ToolSystem` (`src/tools/tool-system.ts`).
//
// ─── Recursion guard (Req 4.6, design § Item 4) ─────────────────
//
// `runBatch` MUST NOT be reachable through `BatchContext.resolveTool`.
// If it were, a malicious or broken LLM could submit a descriptor
// targeting `runBatch` and recurse without bound. The guard runs
// at registration time — before any descriptor is dispatched — and
// fails the build/test if the invariant is violated. This is the key
// invariant of task 7.3.
//
// The guard is encoded as:
//   - A runtime assertion in `buildResolveTool` that throws on
//     registration if any phase-1+2 entry uses the runBatch tool ID.
//   - A `assertRunBatchUnreachable` helper that callers (including
//     the unit-test-style assertion file at
//     `src/agent-skills/__tests__/chat-tool-registry-recursion-guard.test.ts`)
//     can invoke against a constructed resolver to prove the guard
//     fires when the invariant is violated.
//
// Validates: Requirements 4.6

import type { ExecutableToolDefinition, ToolSystem } from '../tools/tool-system.js';
import type { ToolContext, ToolResult } from '../shared/types.js';
import {
  RUN_BATCH_TOOL_ID,
  RunBatchToolInstance,
} from './run-batch/run-batch-tool.js';
import type {
  BatchContext,
  RunBatchInput,
  ToolGate,
} from './run-batch/types.js';

// ─── Public types ───────────────────────────────────────────────

/**
 * Map of tool ID → `ExecutableToolDefinition` for the union of
 * Phase 1 + Phase 2 tools that the chat agent exposes. The runBatch
 * tool MUST NOT be a key in this map (Req 4.6) — adding it triggers
 * the registration-time recursion guard below.
 */
export type ChatToolDispatchTable = ReadonlyMap<string, ExecutableToolDefinition>;

/**
 * Per-turn context the chat agent supplies when registering runBatch.
 * The factory uses this to wire `BatchContext` for every invocation
 * of the tool's `execute` method.
 */
export interface ChatToolRegistryContext {
  /** Phase 3 ToolGate — consulted per descriptor (Req 4.7, 4.8). */
  toolGate:    ToolGate;
  /** The active spec featureName (used by ToolGate.dispatch). */
  featureName: string;
  /** AbortSignal that fires when the parent agent turn is cancelled. */
  abortSignal: AbortSignal;
}

// ─── Phase 1 + Phase 2 tool IDs ─────────────────────────────────
//
// The full list lives in the task: writeFile, writeSpec, editSpec
// (Phase 1 spec / write surface) + the Phase 2 media / web / browser /
// LSP tools. Those modules are not all present in the current tree
// yet — design § Phase 1–3 dependencies treats them as read-only
// references. The registry consumes whatever subset its caller
// supplies and applies the recursion guard against it.
//
// The single hard rule is: `runBatch` is NEVER one of these IDs.

/** Tool IDs forbidden from appearing inside a runBatch descriptor's
 *  dispatch table. Currently a singleton — `runBatch` itself — but
 *  declared as a frozen `Set` so future stitching layers can extend
 *  it without changing the guard's call sites. */
export const FORBIDDEN_DESCRIPTOR_TOOL_IDS: ReadonlySet<string> =
  Object.freeze(new Set<string>([RUN_BATCH_TOOL_ID]));

// ─── Registration-time recursion guard ──────────────────────────

/**
 * Thrown when `runBatch` (or any other forbidden tool ID) appears in
 * the Phase 1 + Phase 2 dispatch table at registration time. The
 * error message names the offending tool ID(s) explicitly so the
 * build / test failure points the developer at the exact violation.
 */
export class RunBatchRecursionError extends Error {
  override readonly name = 'RunBatchRecursionError' as const;
  /** Tool IDs that triggered the guard. */
  readonly offendingToolIds: ReadonlyArray<string>;

  constructor(offendingToolIds: ReadonlyArray<string>) {
    super(
      `runBatch recursion guard: dispatch table contains forbidden tool ID(s) ` +
        `${JSON.stringify([...offendingToolIds])}. ` +
        `runBatch MUST NOT be reachable through BatchContext.resolveTool ` +
        `(see Phase 4 design § Item 4, Requirement 4.6).`,
    );
    this.offendingToolIds = offendingToolIds;
  }
}

/**
 * Build a `BatchContext.resolveTool` function from a Phase 1 + Phase 2
 * dispatch table. Throws `RunBatchRecursionError` at registration
 * time if the table contains any forbidden tool ID — this is the
 * registration-time assertion that fails the build/test if `runBatch`
 * is reachable through `resolveTool('runBatch')`.
 *
 * The returned function is total: for any tool ID outside the table
 * (including `runBatch` itself, which is excluded by construction)
 * it returns `undefined` so the per-descriptor pipeline emits the
 * structured `unknown_tool` envelope (Req 4.10).
 */
export function buildResolveTool(
  table: ChatToolDispatchTable,
): (toolId: string) => ExecutableToolDefinition | undefined {
  // ─── Recursion guard ──────────────────────────────────────────
  const offending: string[] = [];
  for (const forbiddenId of FORBIDDEN_DESCRIPTOR_TOOL_IDS) {
    if (table.has(forbiddenId)) {
      offending.push(forbiddenId);
    }
  }
  if (offending.length > 0) {
    throw new RunBatchRecursionError(offending);
  }

  // ─── Dispatch closure ─────────────────────────────────────────
  return (toolId: string): ExecutableToolDefinition | undefined => {
    // Belt-and-braces: even if a future caller mutates the underlying
    // Map (it shouldn't — `ChatToolDispatchTable` is `ReadonlyMap`),
    // the runtime check below blocks `runBatch` from ever being
    // reachable through this closure.
    if (FORBIDDEN_DESCRIPTOR_TOOL_IDS.has(toolId)) {
      return undefined;
    }
    return table.get(toolId);
  };
}

/**
 * Standalone post-construction assertion that the recursion guard
 * holds for an already-built resolver. Used by the unit-test-style
 * assertion file at
 * `src/agent-skills/__tests__/chat-tool-registry-recursion-guard.test.ts`
 * to prove the guard fires.
 *
 * Returns `void` on success; throws `RunBatchRecursionError` if the
 * resolver returns a defined entry for any forbidden tool ID.
 */
export function assertRunBatchUnreachable(
  resolveTool: (toolId: string) => ExecutableToolDefinition | undefined,
): void {
  const reachable: string[] = [];
  for (const forbiddenId of FORBIDDEN_DESCRIPTOR_TOOL_IDS) {
    if (resolveTool(forbiddenId) !== undefined) {
      reachable.push(forbiddenId);
    }
  }
  if (reachable.length > 0) {
    throw new RunBatchRecursionError(reachable);
  }
}

// ─── Tool-definition factory ────────────────────────────────────

/**
 * Build the `ExecutableToolDefinition` for `runBatch` ready to be
 * inserted into the chat agent's `ToolSystem` (`src/tools/tool-system.ts`).
 *
 * Hard invariants enforced here:
 *   - The dispatch table passed in MUST NOT contain `runBatch` —
 *     the recursion guard runs at registration time and throws
 *     `RunBatchRecursionError` if the invariant is violated.
 *   - The returned `ExecutableToolDefinition.execute` builds a fresh
 *     `BatchContext` per invocation using the supplied `ctxFactory`,
 *     so each chat turn gets its own ToolGate / featureName /
 *     abortSignal triple.
 *   - `RunBatchToolInstance.execute` itself is stateless; this
 *     factory just adapts its calling convention to the
 *     `ExecutableToolDefinition.execute` shape.
 */
export function createRunBatchToolDefinition(
  table: ChatToolDispatchTable,
  ctxFactory: (toolContext: ToolContext) => ChatToolRegistryContext,
): ExecutableToolDefinition {
  // ─── Registration-time recursion guard ──────────────────────
  //
  // `buildResolveTool` throws RunBatchRecursionError if `runBatch`
  // appears in the dispatch table. The error escapes the factory
  // synchronously, failing the build/test before the agent ever
  // sees a registered runBatch tool. This is the assertion called
  // out by task 7.3.
  const resolveTool = buildResolveTool(table);

  // Belt-and-braces post-construction assertion — also throws on
  // registration if the closure somehow leaks a defined entry for
  // any forbidden tool ID. This is purely defensive; the in-table
  // check above already rejects the only realistic violation.
  assertRunBatchUnreachable(resolveTool);

  return {
    id:          RUN_BATCH_TOOL_ID,
    name:        'RunBatchTool',
    description:
      'Execute up to 50 tool calls in parallel and return per-call ' +
      'result envelopes in input order. The runBatch tool itself is ' +
      'NOT available as a descriptor target — recursion is blocked ' +
      'at registration time.',
    inputSchema: {
      type: 'object',
      properties: {
        calls: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              tool:  { type: 'string' },
              input: {},
            },
            required: ['tool', 'input'],
          },
        },
      },
      required: ['calls'],
    },
    riskLevel: 'execute',
    execute: async (
      input: unknown,
      toolContext: ToolContext,
    ): Promise<ToolResult> => {
      // Build the BatchContext for this invocation. The ctxFactory
      // is supplied by the chat agent and yields the ToolGate /
      // featureName / abortSignal for the current turn.
      const turnCtx = ctxFactory(toolContext);
      const batchCtx: BatchContext = {
        toolGate:    turnCtx.toolGate,
        featureName: turnCtx.featureName,
        resolveTool,
        abortSignal: turnCtx.abortSignal,
      };

      const result = await RunBatchToolInstance.execute(
        input as RunBatchInput,
        batchCtx,
      );

      if (result.ok) {
        return { success: true, output: result.output };
      }
      return {
        success: false,
        output:  null,
        error:   `runBatch ${result.error.kind}: ${result.error.detail}`,
      };
    },
  };
}

// ─── Top-level registration helper ──────────────────────────────

/**
 * Register `runBatch` against the chat agent's `ToolSystem`. This is
 * the single entry-point chat-agent wiring code should call.
 *
 * The function:
 *   1. Runs the registration-time recursion guard against `table`.
 *   2. Builds the `ExecutableToolDefinition` via
 *      `createRunBatchToolDefinition`.
 *   3. Calls `toolSystem.register(...)` to wire it in.
 *
 * If the recursion guard fires, `RunBatchRecursionError` propagates
 * synchronously and `toolSystem.register` is NEVER called — so the
 * tool is never reachable in a build that violates the invariant.
 *
 * Returns the registered `ExecutableToolDefinition` for caller-side
 * introspection (e.g. asserting it shows up in `toolSystem.list()`).
 */
export function registerRunBatch(
  toolSystem: ToolSystem,
  table:      ChatToolDispatchTable,
  ctxFactory: (toolContext: ToolContext) => ChatToolRegistryContext,
): ExecutableToolDefinition {
  const definition = createRunBatchToolDefinition(table, ctxFactory);
  toolSystem.register(definition);
  return definition;
}
