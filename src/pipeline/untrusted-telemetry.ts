/**
 * Untrusted_Source_Wrapper telemetry (Feature 1, task 3.5)
 *
 * A tiny, fail-soft Metrics_Sink hook shared by the four F1_Call_Sites
 * (`web-browser.ts`, `context-references.ts`, `skill-loader.ts`,
 * `memory/agentmemory-client.ts`). When a call site wraps a content segment
 * through the Untrusted_Wrapper (flag on), it records two observability
 * counters to the Metrics_Sink:
 *
 *   - `untrusted_wrap.invocations`  — incremented by 1 per wrapped segment
 *   - `untrusted_wrap.wrapped_bytes`— the UTF-8 byte length of the wrapped
 *                                     segment
 *
 * The wrapper modules themselves stay pure (no I/O, no flag read), so this
 * recorder lives next to them rather than inside `untrusted-context.ts`. The
 * structural {@link MetricsSink} type is mirrored locally — as in
 * `orchestrator-manager.ts`, `swarm-coordinator.ts`, and `graph-export.ts` —
 * so the F1 leaf modules never import `SessionTelemetryService` directly. Any
 * object exposing `recordMetric(sessionId, key, value)` satisfies it (notably
 * `SessionTelemetryService` from `src/session/session-telemetry.ts`).
 *
 * Every emit is fully fail-soft: a missing sink, a non-finite value, or a sink
 * that throws can never break the wrap path. When no sink is supplied (or one
 * throws) the observation is logged via the shared logger instead.
 *
 * Validates: Requirements 5.5, 5.6
 */

import { logger } from '../utils/logger.js';

/**
 * Structural Metrics_Sink type — mirrored locally so this module does not
 * depend on `SessionTelemetryService`. Any object exposing
 * `recordMetric(sessionId, key, value)` satisfies it.
 */
export interface MetricsSink {
  recordMetric(sessionId: string | null, key: string, value: number): void;
}

/** Metrics_Sink key: incremented by 1 per wrapped segment (Requirement 5.5). */
export const UNTRUSTED_WRAP_INVOCATIONS_KEY = 'untrusted_wrap.invocations';

/**
 * Metrics_Sink key: UTF-8 byte length of the wrapped segment
 * (Requirement 5.6).
 */
export const UNTRUSTED_WRAP_BYTES_KEY = 'untrusted_wrap.wrapped_bytes';

/**
 * Record a single metric, fully fail-soft. When no Metrics_Sink is supplied
 * (or the sink throws), the observation is logged instead so a telemetry
 * regression can never break the F1 wrap path.
 */
function emitMetric(
  sink: MetricsSink | null | undefined,
  sessionId: string | null,
  key: string,
  value: number,
): void {
  if (!Number.isFinite(value)) return;
  if (sink) {
    try {
      sink.recordMetric(sessionId, key, value);
      return;
    } catch (err) {
      logger.warn(
        '[untrusted-telemetry] Metrics_Sink emit failed; falling back to log:',
        (err as Error)?.message,
      );
    }
  }
  logger.debug('[untrusted-telemetry] metric', { key, value, sessionId });
}

/**
 * Record telemetry for one Untrusted_Wrapper wrap of a single content segment.
 *
 * Call this exactly once per actual wrap (flag on) so counts are not
 * double-recorded. Emits {@link UNTRUSTED_WRAP_INVOCATIONS_KEY} (value `1`) and
 * {@link UNTRUSTED_WRAP_BYTES_KEY} (the UTF-8 byte length of `wrapped`).
 *
 * @param sink - The Metrics_Sink to record into. When omitted/null the
 *   observation is logged (still fail-soft).
 * @param wrapped - The framed (post-`wrapUntrusted`) segment whose byte length
 *   is recorded.
 * @param sessionId - Session id for the metric sample. Null/omitted records a
 *   global metric.
 *
 * Validates: Requirements 5.5, 5.6
 */
export function recordUntrustedWrap(
  sink: MetricsSink | null | undefined,
  wrapped: string,
  sessionId: string | null = null,
): void {
  const bytes = Buffer.byteLength(wrapped, 'utf8');
  emitMetric(sink, sessionId, UNTRUSTED_WRAP_INVOCATIONS_KEY, 1);
  emitMetric(sink, sessionId, UNTRUSTED_WRAP_BYTES_KEY, bytes);
}
