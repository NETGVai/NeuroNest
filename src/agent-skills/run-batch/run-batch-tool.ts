//
// Implements the agent-facing `runBatch` tool. Fans out 1..50 tool-call
// descriptors via Promise.allSettled into a pre-sized result array, so
// each descriptor's outcome is written directly into `results[i]` —
// no post-hoc sort. One descriptor's failure NEVER aborts another:
// every per-descriptor pipeline catches its own throws and structured
// errors and emits a `BatchCallFailure` envelope into the matching
// slot. The wrapping promise only rejects on the length-bounds branch
// (calls.length < 1 OR calls.length > 50).
//
// Per-descriptor pipeline (Req 4.7, 4.8, 4.10):
//   1. ctx.resolveTool(descriptor.tool) → undefined → unknown_tool
//   2. ctx.toolGate.dispatch(toolId, featureName) → gated → tool_gated
//   3. Validate descriptor.input against the tool's inputSchema →
//      invalid → invalid_input
//   4. Invoke the tool's execute → thrown OR { success: false } →
//      tool_failed
//
// Validates: Requirements 4.1, 4.2, 4.4, 4.5, 4.7, 4.8, 4.9, 4.10

import type { ToolContext, ToolResult } from '../../shared/types.js';
import type { ExecutableToolDefinition } from '../../tools/tool-system.js';
import type {
  BatchCallFailure,
  BatchCallOutcome,
  BatchContext,
  RunBatchInput,
  RunBatchOutput,
  RunBatchTool,
  ToolCallDescriptor,
} from './types.js';

// ─── Bounds (Req 4.3, 4.4) ──────────────────────────────────────

/** Inclusive minimum descriptor count. Below → `invalid_input`. */
const MIN_CALLS = 1;
/** Inclusive maximum descriptor count. Above → `invalid_input`. */
const MAX_CALLS = 50;

// ─── Tool ID and metadata ───────────────────────────────────────

/** The agent-facing tool ID. The recursion guard at registration time
 *  (task 7.3) ensures `resolveTool('runBatch')` returns undefined so
 *  the tool can never appear inside its own descriptor surface. */
export const RUN_BATCH_TOOL_ID = 'runBatch' as const;

// ─── Implementation ─────────────────────────────────────────────

/**
 * Concrete `RunBatchTool` implementation. The class is stateless —
 * every call to `execute` is independent and shares no mutable state
 * across invocations.
 */
export class RunBatchToolImpl implements RunBatchTool {
  async execute(
    input: RunBatchInput,
    ctx: BatchContext,
  ): Promise<
    | { ok: true; output: RunBatchOutput }
    | { ok: false; error: { kind: 'invalid_input'; detail: string } }
  > {
    // ─── (1) Length-bounds validation, BEFORE any dispatch ──────
    //
    // Req 4.3, 4.4: `calls.length` MUST be in [1, 50] inclusive.
    // Anything outside that range is rejected on the wrapping promise
    // with `{ ok: false; error: { kind: 'invalid_input', ... } }`,
    // and zero descriptor tools are invoked. The detail message names
    // the inclusive limit of 50 explicitly.
    const calls = input?.calls;
    if (!Array.isArray(calls)) {
      return {
        ok: false,
        error: {
          kind: 'invalid_input',
          detail: `runBatch.calls must be an array of 1..${MAX_CALLS} tool-call descriptors (inclusive).`,
        },
      };
    }

    if (calls.length < MIN_CALLS) {
      return {
        ok: false,
        error: {
          kind: 'invalid_input',
          detail: `runBatch requires at least ${MIN_CALLS} tool-call descriptor; received ${calls.length}. The inclusive limit is ${MAX_CALLS}.`,
        },
      };
    }

    if (calls.length > MAX_CALLS) {
      return {
        ok: false,
        error: {
          kind: 'invalid_input',
          detail: `runBatch accepts at most ${MAX_CALLS} tool-call descriptors per invocation (inclusive); received ${calls.length}.`,
        },
      };
    }

    // ─── (2) Pre-sized result array (Req 4.2, 4.9) ──────────────
    //
    // Each descriptor's task writes its outcome directly into
    // `results[i]` — there is no post-hoc sort. The input-order
    // invariant is structural: regardless of completion order,
    // `results[i].index === i` for every i.
    const results = new Array<BatchCallOutcome>(calls.length);

    // ─── (3) Per-descriptor pipeline tasks ──────────────────────
    //
    // Each task is a self-contained Promise that runs the four-step
    // pipeline and writes its outcome into the matching slot. The
    // task NEVER throws — every failure path is converted into a
    // BatchCallFailure envelope before the slot is written. We still
    // wrap with Promise.allSettled as a defensive belt-and-braces
    // guarantee that one descriptor's failure never aborts another
    // (Req 4.5, 4.8, 4.10).
    const tasks = calls.map((descriptor, i) =>
      this.runDescriptor(descriptor, i, ctx).then((outcome) => {
        results[i] = outcome;
      }),
    );

    await Promise.allSettled(tasks);

    // Defensive: if any slot is still empty (shouldn't be possible
    // given runDescriptor never rejects, but allSettled lets us
    // tolerate a programming bug here), fill with a tool_failed
    // envelope rather than leaking an `undefined` to the caller.
    for (let i = 0; i < results.length; i++) {
      if (results[i] === undefined) {
        results[i] = {
          index: i,
          ok: false,
          error: {
            kind: 'tool_failed',
            detail: 'runBatch descriptor task did not produce an outcome',
          },
        };
      }
    }

    return { ok: true, output: { results } };
  }

  /**
   * Run the four-step pipeline for a single descriptor and return its
   * BatchCallOutcome. NEVER throws — every failure mode (unknown tool,
   * gating, schema mismatch, thrown error, structured error) is
   * mapped to a `BatchCallFailure` envelope.
   */
  private async runDescriptor(
    descriptor: ToolCallDescriptor,
    index: number,
    ctx: BatchContext,
  ): Promise<BatchCallOutcome> {
    // ─── Step 1: resolve the tool ID (Req 4.10) ─────────────────
    //
    // `ctx.resolveTool` excludes `runBatch` itself by construction
    // (registration-time recursion guard, task 7.3). For unknown
    // tools — including `runBatch` itself — this step returns the
    // structured `unknown_tool` envelope.
    let tool: ExecutableToolDefinition | undefined;
    try {
      tool = ctx.resolveTool(descriptor.tool);
    } catch (err) {
      return failure(index, {
        kind: 'tool_failed',
        detail: `resolveTool threw: ${errorMessage(err)}`,
      });
    }

    if (tool === undefined) {
      return failure(index, {
        kind: 'unknown_tool',
        tool: descriptor.tool,
      });
    }

    // ─── Step 2: consult the onboarding-state ToolGate ──────────
    //
    // Req 4.7, 4.8: each descriptor is gated independently. Code_Tool
    // descriptors are rejected with `tool_gated` when state forbids
    // them; Spec_Tool descriptors and Code_Tool descriptors under
    // permissive states (`taskExecuting`, `complete`) proceed to the
    // next pipeline step. Gated descriptors NEVER invoke the
    // underlying tool's `execute` — verified by spy-based property
    // test 7.6.
    let gateDecision: ReturnType<BatchContext['toolGate']['dispatch']>;
    try {
      gateDecision = ctx.toolGate.dispatch(descriptor.tool, ctx.featureName);
    } catch (err) {
      return failure(index, {
        kind: 'tool_failed',
        detail: `toolGate.dispatch threw: ${errorMessage(err)}`,
      });
    }

    if (!gateDecision.allowed) {
      return failure(index, {
        kind: 'tool_gated',
        tool: descriptor.tool,
        currentState: gateDecision.currentState,
      });
    }

    // ─── Step 3: validate descriptor input against inputSchema ──
    //
    // The dispatched tool's `inputSchema` is a JSON Schema document.
    // We run a focused, dependency-free validator against the
    // top-level `type`, `required`, and per-property `type` fields —
    // covering the shape used by every Phase 1 + Phase 2 tool's
    // inputSchema (see `src/tools/built-in/index.ts`). Anything that
    // fails validation yields the structured `invalid_input`
    // envelope without dispatching the tool.
    const inputValidation = validateAgainstSchema(
      descriptor.input,
      tool.inputSchema,
    );
    if (!inputValidation.ok) {
      return failure(index, {
        kind: 'invalid_input',
        detail: inputValidation.detail,
      });
    }

    // ─── Step 4: invoke the tool's execute ──────────────────────
    //
    // Both thrown errors and structured errors (`{ success: false }`)
    // are captured into the `tool_failed` envelope (Req 4.5). The
    // tool receives a ToolContext augmented with `ctx.abortSignal`
    // so cancellation propagates from the parent agent turn into
    // every in-flight descriptor.
    const toolContext = buildToolContext(ctx);

    let result: ToolResult;
    try {
      result = await tool.execute(descriptor.input, toolContext);
    } catch (err) {
      return failure(index, {
        kind: 'tool_failed',
        detail: errorMessage(err),
      });
    }

    if (!result || result.success !== true) {
      return failure(index, {
        kind: 'tool_failed',
        detail:
          (result && typeof result.error === 'string' && result.error) ||
          'tool returned a structured failure',
      });
    }

    return {
      index,
      ok: true,
      output: result.output,
    };
  }
}

/** Singleton instance — `RunBatchToolImpl` is stateless. */
export const RunBatchToolInstance: RunBatchTool = new RunBatchToolImpl();

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Construct the per-descriptor `ToolContext`. The standard
 * `ToolContext` shape does not currently carry an `abortSignal`, so
 * we attach it as an additional non-enumerable-friendly field that
 * tools can read defensively (`(context as any).abortSignal`). This
 * keeps the `ToolContext` interface untouched while still propagating
 * cancellation per Req 4.5 (failure isolation extends to in-flight
 * descriptors when the parent turn is cancelled).
 */
function buildToolContext(ctx: BatchContext): ToolContext {
  const base: ToolContext = {
    agentId: RUN_BATCH_TOOL_ID,
    sessionId: ctx.featureName,
    permissionMode: 'auto-approve',
  };
  // Attach abortSignal as an extension field — tools that observe it
  // can chain it into their own fetch/spawn/etc. calls.
  return Object.assign(base, { abortSignal: ctx.abortSignal });
}

function failure(
  index: number,
  error: BatchCallFailure['error'],
): BatchCallFailure {
  return { index, ok: false, error };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || 'Error';
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ─── JSON Schema validator (focused, dependency-free) ──────────
//
// Validates the descriptor's input against the tool's declared
// `inputSchema`. Coverage is intentionally focused on the shape
// every Phase 1 + Phase 2 tool actually uses today:
//
//   {
//     type: 'object',
//     properties: { foo: { type: 'string' }, ... },
//     required: ['foo', ...]
//   }
//
// Schemas that omit `type` or use unrecognized shapes are accepted
// (no constraint to violate); schemas with constraints are checked
// strictly. This keeps the runBatch dispatch path independent of any
// JSON-Schema library while still catching the common wrong-shape
// inputs an LLM might emit.

interface ValidationOk {
  ok: true;
}
interface ValidationErr {
  ok: false;
  detail: string;
}
type ValidationResult = ValidationOk | ValidationErr;

function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown> | undefined,
): ValidationResult {
  if (!schema || typeof schema !== 'object') {
    // No schema declared — nothing to validate against.
    return { ok: true };
  }

  const schemaType = (schema as { type?: unknown }).type;
  if (typeof schemaType !== 'string') {
    return { ok: true };
  }

  const typeOk = checkJsonType(value, schemaType);
  if (!typeOk.ok) return typeOk;

  if (schemaType === 'object') {
    return validateObjectSchema(value as Record<string, unknown>, schema);
  }

  return { ok: true };
}

function validateObjectSchema(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
): ValidationResult {
  const required = Array.isArray((schema as { required?: unknown }).required)
    ? ((schema as { required?: unknown[] }).required as unknown[])
    : [];

  for (const key of required) {
    if (typeof key === 'string' && !(key in value)) {
      return {
        ok: false,
        detail: `missing required property '${key}'`,
      };
    }
  }

  const properties = (schema as { properties?: unknown }).properties;
  if (properties && typeof properties === 'object') {
    for (const [propKey, propSchemaRaw] of Object.entries(
      properties as Record<string, unknown>,
    )) {
      if (!(propKey in value)) continue;
      const propSchema = propSchemaRaw as Record<string, unknown>;
      const propType = (propSchema as { type?: unknown }).type;
      if (typeof propType !== 'string') continue;
      const propTypeOk = checkJsonType(value[propKey], propType);
      if (!propTypeOk.ok) {
        return {
          ok: false,
          detail: `property '${propKey}' ${propTypeOk.detail}`,
        };
      }
    }
  }

  return { ok: true };
}

function checkJsonType(value: unknown, jsonType: string): ValidationResult {
  let actual: string;
  if (value === null) actual = 'null';
  else if (Array.isArray(value)) actual = 'array';
  else if (Number.isInteger(value)) actual = 'integer';
  else actual = typeof value;

  switch (jsonType) {
    case 'string':
    case 'boolean':
    case 'object':
    case 'array':
    case 'null':
      if (actual === jsonType) return { ok: true };
      // 'object' must reject arrays and null.
      if (
        jsonType === 'object' &&
        (actual === 'array' || actual === 'null' || actual !== 'object')
      ) {
        return {
          ok: false,
          detail: `expected type '${jsonType}' but got '${actual}'`,
        };
      }
      return {
        ok: false,
        detail: `expected type '${jsonType}' but got '${actual}'`,
      };
    case 'number':
      if (actual === 'number' || actual === 'integer') return { ok: true };
      return {
        ok: false,
        detail: `expected type 'number' but got '${actual}'`,
      };
    case 'integer':
      if (actual === 'integer') return { ok: true };
      return {
        ok: false,
        detail: `expected type 'integer' but got '${actual}'`,
      };
    default:
      // Unknown JSON types are accepted (no constraint to violate).
      return { ok: true };
  }
}
