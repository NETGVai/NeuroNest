/**
 * Error_Capture_Helper — single entry point for any catch block that wants
 * to land an `error.captured` Pipeline_Event.
 *
 * Task 14 of the 12-factor-agent-improvements spec. Requirement 2.7 names
 * this helper and pins the initial migration scope to the catch blocks in
 * `tool-call-recovery.ts`, `fallback-chain.ts`, and the orchestrator's
 * top-level chat-message dispatcher in `src/main/ipc.ts`.
 *
 * Behaviour:
 *   - Generates a stable `errorId` (UUIDv4 via `crypto.randomUUID`) and
 *     returns it so the caller can correlate the emitted event with the
 *     surrounding log lines and the existing error-handling flow.
 *   - Normalises any thrown value (Error, string, plain object, anything)
 *     into the design-mandated payload `{ errorId, scope, message, stack }`.
 *   - Emits `error.captured` via the main-process `EventLog` singleton when
 *     a sessionId is available AND `PERF_FLAGS.UNIFIED_EVENT_LOG` OR
 *     `PERF_FLAGS.UNIFIED_EVENT_LOG_SHADOW` is on (per design "Settings
 *     and feature flags": shadow mode default-on so Phase 0 telemetry
 *     flows even before the unified state block reaches the prompt).
 *   - Fully fail-soft: any exception inside `captureError` is swallowed
 *     so a logging path can never crash the error path it observes.
 *   - Augments existing error handling — never replaces it. Every
 *     migrated catch site keeps its console.warn / console.error /
 *     user-visible-response logic; `captureError` runs alongside.
 *
 * Cycle avoidance: this module sits in `src/pipeline/` and the EventLog
 * singleton lives in `src/main/ipc.ts`, which already imports from
 * `src/pipeline/`. Importing back the other way would form a cycle. The
 * helper therefore exposes a tiny registration hook
 * (`setEventLogResolver`) that the IPC layer calls once during init,
 * passing in its existing `getEventLog()` lazy resolver. With no resolver
 * registered (e.g. in renderer/test/CLI processes that never load
 * `ipc.ts`) the helper is a clean no-op.
 *
 * Requirements: 2.7
 */

import { randomUUID } from 'crypto';
import { PERF_FLAGS } from '../main/performance/feature-flags.js';

// ─── EventLog dependency (registered by ipc.ts) ───────────────

/**
 * Minimal structural shape of the main-process `EventLog`. We do NOT import
 * the class here to avoid a `pipeline → main → pipeline` import cycle. The
 * full type lives in `src/pipeline/event-log.ts`; consumers of this helper
 * should not need to know about it.
 */
export interface EventLogEmitter {
  emit(input: { sessionId: string; kind: string; payload: unknown }): unknown;
}

/** Returns the singleton EventLog (or null if the database is not yet ready). */
export type EventLogResolver = () => EventLogEmitter | null;

let eventLogResolver: EventLogResolver | null = null;

/**
 * Register the main-process EventLog resolver. Called once from `ipc.ts`
 * during handler registration, passing in the existing `getEventLog`
 * lazy-singleton accessor. Pass `null` to clear (used by tests).
 */
export function setEventLogResolver(resolver: EventLogResolver | null): void {
  eventLogResolver = resolver;
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Payload shape for the `error.captured` Pipeline_Event. Matches design.md
 * → "Event kinds" exactly. New fields require a design-level change.
 */
export interface ErrorCapturedPayload {
  errorId: string;
  scope: string;
  message: string;
  stack: string;
}

/**
 * Capture an error: generate a correlation id, normalise the error, and
 * (best-effort) emit an `error.captured` Pipeline_Event so the unified
 * event log sees it. Returns the errorId so the caller can include it
 * in its existing log line / user-facing message.
 *
 * @param scope     Free-form short string identifying where the error was
 *                  caught (e.g. `"ipc.chat-message"`,
 *                  `"fallback-chain.provider-failure"`). Surfaces in the
 *                  payload so dashboards can group by call site.
 * @param err       The thrown value. Anything is accepted — Error, string,
 *                  plain object, undefined. The helper normalises it.
 * @param sessionId Optional session id. The EventLog needs a session to
 *                  allocate `seq`, so when this is missing the emit is
 *                  skipped. The errorId is still generated and returned
 *                  for correlation in console output.
 *
 * @returns The generated errorId. Always a valid UUID even when the emit
 *          is skipped.
 */
export function captureError(
  scope: string,
  err: unknown,
  sessionId?: string | null,
): string {
  const errorId = generateErrorId();

  // The whole helper is wrapped in a defensive try/catch so any failure in
  // emit / payload-building can never propagate up into the catch block
  // that called us. Logging is the lowest priority; the user's error path
  // must survive a broken EventLog.
  try {
    if (!isFlagOn()) return errorId;
    if (!sessionId) return errorId;

    const log = eventLogResolver ? eventLogResolver() : null;
    if (!log) return errorId;

    const payload: ErrorCapturedPayload = {
      errorId,
      scope,
      message: extractMessage(err),
      stack: extractStack(err),
    };

    // Fire-and-forget. EventLog.emit returns a Promise that resolves after
    // enqueue (not after flush). We swallow rejections defensively even
    // though emit is documented as never-rejecting.
    const result = log.emit({ sessionId, kind: 'error.captured', payload });
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<unknown>).catch(() => {
        // Swallow: logging failures are not user-visible.
      });
    }
  } catch {
    // Swallow any synchronous failure (resolver throws, emit throws,
    // payload extraction throws). The errorId is still useful and the
    // caller's existing error-handling logic continues unchanged.
  }

  return errorId;
}

// ─── Internals ─────────────────────────────────────────────────

/**
 * Whether the `error.captured` emit path is active. Active in either of
 * the two unified-event-log flag states: full (Phase 1+) or shadow
 * (Phase 0 default). When both are off the helper is a pure errorId
 * generator — useful for correlation-only callers.
 */
function isFlagOn(): boolean {
  return Boolean(
    (PERF_FLAGS as Record<string, unknown>).UNIFIED_EVENT_LOG ||
      (PERF_FLAGS as Record<string, unknown>).UNIFIED_EVENT_LOG_SHADOW,
  );
}

/**
 * Generate a fresh errorId. UUIDv4 via the Node built-in is sufficient
 * here — the EventLog row's primary key is UUIDv7 (event id), which is
 * a separate identifier; this errorId is just a correlation label that
 * lives inside the payload.
 */
function generateErrorId(): string {
  return randomUUID();
}

/**
 * Extract a human-readable message from any thrown value.
 *
 * Errors and "Error-like" objects (anything with a `message` property)
 * are common, but tools also throw strings, numbers, and POJOs — handle
 * each in turn so the dashboard never sees "[object Object]".
 */
function extractMessage(err: unknown): string {
  if (err === null || err === undefined) return '';
  if (err instanceof Error) return err.message ?? '';
  if (typeof err === 'string') return err;
  if (typeof err === 'number' || typeof err === 'boolean') return String(err);
  if (typeof err === 'object') {
    const maybe = (err as { message?: unknown }).message;
    if (typeof maybe === 'string') return maybe;
    if (maybe !== undefined) {
      try {
        return String(maybe);
      } catch {
        /* fall through */
      }
    }
    try {
      return JSON.stringify(err);
    } catch {
      /* fall through */
    }
  }
  try {
    return String(err);
  } catch {
    return '';
  }
}

/**
 * Extract a stack trace from any thrown value. Returns an empty string
 * when no stack is available (string throws, etc.) so the payload shape
 * stays consistent (`stack` always present, possibly empty).
 */
function extractStack(err: unknown): string {
  if (err instanceof Error && typeof err.stack === 'string') return err.stack;
  if (err && typeof err === 'object') {
    const maybe = (err as { stack?: unknown }).stack;
    if (typeof maybe === 'string') return maybe;
  }
  return '';
}
