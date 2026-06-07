/**
 * Tool event emitter for the Pipeline_Event_Log.
 *
 * Task 10 of the 12-factor-agent-improvements spec: emit `tool.start`,
 * `tool.success`, and `tool.failure` Pipeline_Events from the
 * orchestrator's tool-dispatch loop. Per design.md "Event kinds":
 *
 *   - tool.start    payload: { callId, name, args }
 *   - tool.success  payload: { callId, result }
 *   - tool.failure  payload: { callId, error: { name, message, stack, code, output } }
 *
 * Validates: Requirements 2.1, 2.2, 2.3
 *
 * Identification of the dispatch site:
 *   The 12-factor design notes "the orchestrator's tool-dispatch loop"
 *   and points the implementer at `executeTool` callers. There is
 *   exactly one such call site in the codebase: the `tool:execute` IPC
 *   handler registered in `src/main/ipc.ts` (around the `// ── Tool
 *   Executor ──` block). The free functions in `src/pipeline/tool-executor.ts`
 *   themselves do NOT loop — they execute one request and return — so
 *   the emit pair (start / success | failure) belongs around the
 *   `executeTool` invocation in the IPC handler. That is the equivalent
 *   of a one-iteration dispatch loop today; if a future spec introduces
 *   a multi-call orchestrator loop, it should reuse this emitter at
 *   each iteration so the payload shape stays stable.
 *
 * Design constraints honored here:
 *   - Gated by `PERF_FLAGS.UNIFIED_EVENT_LOG ||
 *     PERF_FLAGS.UNIFIED_EVENT_LOG_SHADOW` so Phase 0 telemetry runs
 *     while the prompt assembler ignores the reducer output.
 *   - Fail-soft: any emit failure is swallowed with a console warning
 *     so a tool dispatch never tears down on an emitter regression.
 *   - Events flow through the single main-process EventLog instance
 *     supplied by the caller (Event_Bus_Bridge requirement) — the
 *     emitter never opens its own database handle.
 *   - The helper takes a structural `EventLog`-like emitter (mirrors
 *     `src/session/checkpoint-event-emitter.ts`) to keep the import
 *     graph acyclic with `src/main/ipc.ts`.
 *
 * Pulled into its own module so the per-emitter unit test can exercise
 * the gating + payload shape without booting the whole IPC layer.
 */

import { PERF_FLAGS } from '../main/performance/feature-flags.js';

// ─── Structural EventLog dependency (no import cycle) ─────────

/**
 * Minimal structural shape of the main-process `EventLog`. We do NOT
 * import the class here to avoid a `pipeline → main → pipeline` import
 * cycle (the `tool:execute` IPC handler in `src/main/ipc.ts` will be
 * the primary caller of this emitter).
 */
export interface EventLogEmitter {
  emit(input: { sessionId: string; kind: string; payload: unknown }): unknown;
}

// ─── Public input shapes ──────────────────────────────────────

/**
 * Input for `emitToolStart`. The `args` payload is whatever shape the
 * tool's IPC request had — we forward it as-is so the reducer and
 * downstream debugging tools see the same arguments the executor
 * received. The IPC handler is responsible for ensuring `args` is
 * JSON-safe; the EventLog writer JSON-encodes the payload before
 * persisting.
 */
export interface ToolStartInput {
  sessionId: string;
  callId: string;
  name: string;
  args: unknown;
}

/**
 * Input for `emitToolSuccess`. `result` is the executor's return value
 * (typically a `ToolExecResult` object) and is forwarded unmodified.
 */
export interface ToolSuccessInput {
  sessionId: string;
  callId: string;
  result: unknown;
}

/**
 * Input for `emitToolFailure`. The error structure mirrors the
 * design.md "Event kinds" payload: `{ name, message, stack, code,
 * output }`. The helper exposes the full structure so the IPC handler
 * can populate every field it has on hand (e.g. exit code from a
 * terminal failure, combined stdout+stderr in `output`).
 */
export interface ToolFailureInput {
  sessionId: string;
  callId: string;
  error: {
    name: string;
    message: string;
    stack?: string;
    code?: string | number;
    output?: string;
  };
}

// ─── Public API ───────────────────────────────────────────────

/** Returns true when either of the unified-event-log flags is on. */
export function isToolEmitEnabled(): boolean {
  return Boolean(
    PERF_FLAGS.UNIFIED_EVENT_LOG || PERF_FLAGS.UNIFIED_EVENT_LOG_SHADOW,
  );
}

/**
 * Emit a `tool.start` Pipeline_Event through the supplied EventLog.
 *
 * Returns `true` if an emit was attempted (even when the EventLog
 * subsequently rejects asynchronously), `false` if the emitter
 * skipped: gating disabled, missing log, or missing required fields.
 */
export function emitToolStart(
  log: EventLogEmitter | null | undefined,
  input: ToolStartInput,
): boolean {
  if (!isToolEmitEnabled()) return false;
  if (!log) return false;

  const sessionId = input.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;

  const callId = input.callId;
  if (typeof callId !== 'string' || callId.length === 0) return false;

  const name = input.name;
  if (typeof name !== 'string' || name.length === 0) return false;

  // Build the payload exactly as design.md "Event kinds" specifies.
  // `args` is forwarded as-is — even `undefined` is preserved as the
  // explicit `args: undefined` shape so consumers see a consistent
  // discriminated union.
  const payload = {
    callId,
    name,
    args: input.args,
  };

  return safeEmit(log, sessionId, 'tool.start', payload);
}

/**
 * Emit a `tool.success` Pipeline_Event through the supplied EventLog.
 *
 * Returns `true` if an emit was attempted, `false` if the emitter
 * skipped: gating disabled, missing log, missing sessionId, or missing
 * `callId`.
 */
export function emitToolSuccess(
  log: EventLogEmitter | null | undefined,
  input: ToolSuccessInput,
): boolean {
  if (!isToolEmitEnabled()) return false;
  if (!log) return false;

  const sessionId = input.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;

  const callId = input.callId;
  if (typeof callId !== 'string' || callId.length === 0) return false;

  const payload = {
    callId,
    result: input.result,
  };

  return safeEmit(log, sessionId, 'tool.success', payload);
}

/**
 * Emit a `tool.failure` Pipeline_Event through the supplied EventLog.
 *
 * Returns `true` if an emit was attempted, `false` if the emitter
 * skipped: gating disabled, missing log, missing sessionId, missing
 * `callId`, or missing the error object.
 *
 * The error payload is built from the supplied `error` object by
 * extracting only the documented fields (`name`, `message`, `stack`,
 * `code`, `output`). Optional fields are omitted from the emitted
 * payload when not provided so the output matches the design's shape
 * even when the executor doesn't have, say, a `code` to report.
 */
export function emitToolFailure(
  log: EventLogEmitter | null | undefined,
  input: ToolFailureInput,
): boolean {
  if (!isToolEmitEnabled()) return false;
  if (!log) return false;

  const sessionId = input.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;

  const callId = input.callId;
  if (typeof callId !== 'string' || callId.length === 0) return false;

  if (!input.error || typeof input.error !== 'object') return false;

  // Normalize the error payload. `name` and `message` are required by
  // the design; `stack`, `code`, and `output` are optional. We attach
  // optional fields only when they're present so the persisted JSON
  // doesn't carry empty/undefined entries that pollute the reducer's
  // view.
  const errorPayload: {
    name: string;
    message: string;
    stack?: string;
    code?: string | number;
    output?: string;
  } = {
    name: typeof input.error.name === 'string' ? input.error.name : 'Error',
    message:
      typeof input.error.message === 'string' ? input.error.message : '',
  };
  if (typeof input.error.stack === 'string' && input.error.stack.length > 0) {
    errorPayload.stack = input.error.stack;
  }
  if (
    (typeof input.error.code === 'string' && input.error.code.length > 0) ||
    typeof input.error.code === 'number'
  ) {
    errorPayload.code = input.error.code;
  }
  if (typeof input.error.output === 'string' && input.error.output.length > 0) {
    errorPayload.output = input.error.output;
  }

  const payload = { callId, error: errorPayload };

  return safeEmit(log, sessionId, 'tool.failure', payload);
}

// ─── Internals ────────────────────────────────────────────────

/**
 * Common emit wrapper: synchronous throws are caught and logged; async
 * rejections from a returned Promise are silenced with a `.catch` so
 * the dispatch path never sees an unhandled rejection.
 */
function safeEmit(
  log: EventLogEmitter,
  sessionId: string,
  kind: string,
  payload: unknown,
): boolean {
  try {
    const result = log.emit({ sessionId, kind, payload });
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<unknown>).catch(() => {
        // Swallow async rejection: emitter is best-effort.
      });
    }
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[tool-event-emitter] ${kind} emit threw:`,
      (e as Error)?.message,
    );
    return false;
  }
}
