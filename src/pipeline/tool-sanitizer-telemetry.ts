/**
 * Tool_Message_Sanitizer telemetry (Feature 3, task 11.6)
 *
 * A tiny, fail-soft Metrics_Sink hook shared by the five F3_Integration_Sites
 * (`headroom-compressor.ts`, `trajectory-compressor.ts`, `context-condenser.ts`,
 * `context-summarizer.ts`, `event-log-compactor.ts`). When a site runs the
 * Tool_Message_Sanitizer over its compressed message array and the sanitizer
 * removes one or more messages, the site records a single observability
 * counter to the Metrics_Sink:
 *
 *   - `tool_sanitizer.dropped_messages` — the number of messages removed by the
 *                                         sanitizer (count, only when ≥ 1)
 *
 * The sanitizer module itself stays pure (no I/O, no flag read), so this
 * recorder lives next to the integration sites rather than inside
 * `tool-message-sanitizer.ts`. The structural {@link MetricsSink} type is
 * mirrored locally — as in `untrusted-telemetry.ts`, `swarm-coordinator.ts`,
 * and `graph-export.ts` — so the F3 leaf modules never import
 * `SessionTelemetryService` directly. Any object exposing
 * `recordMetric(sessionId, key, value)` satisfies it (notably
 * `SessionTelemetryService` from `src/session/session-telemetry.ts`).
 *
 * Every emit is fully fail-soft: a missing sink, a non-finite/non-positive
 * value, or a sink that throws can never break the compression path. When no
 * sink is supplied (or one throws) the observation is logged via the shared
 * logger instead.
 *
 * Validates: Requirements 22.3
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

/**
 * Metrics_Sink key: number of messages removed by the Tool_Message_Sanitizer
 * on a single sanitize pass, recorded only when ≥ 1 (Requirement 22.3).
 */
export const TOOL_SANITIZER_DROPPED_KEY = 'tool_sanitizer.dropped_messages';

/**
 * Record the count of messages dropped by the Tool_Message_Sanitizer at an
 * F3_Integration_Site, fully fail-soft.
 *
 * Per Requirement 22.3 the metric is emitted ONLY when the sanitizer removed
 * one or more messages, so this is a no-op when `droppedCount <= 0` (or is
 * non-finite). When a sink is supplied the count is recorded under
 * {@link TOOL_SANITIZER_DROPPED_KEY}; when no sink is supplied (or the sink
 * throws) the observation is logged instead so a telemetry regression can
 * never break the compression path.
 *
 * @param sink - The Metrics_Sink to record into. When omitted/null the
 *   observation is logged (still fail-soft).
 * @param droppedCount - `before.length - after.length` around the sanitize
 *   call. Values ≤ 0 are ignored (nothing was dropped).
 * @param sessionId - Session id for the metric sample. Null/omitted records a
 *   global metric.
 *
 * Validates: Requirements 22.3
 */
export function recordDroppedMessages(
  sink: MetricsSink | null | undefined,
  droppedCount: number,
  sessionId: string | null = null,
): void {
  // Requirement 22.3: only record when ≥ 1 message was removed.
  if (!Number.isFinite(droppedCount) || droppedCount <= 0) return;

  if (sink) {
    try {
      sink.recordMetric(sessionId, TOOL_SANITIZER_DROPPED_KEY, droppedCount);
      return;
    } catch (err) {
      logger.warn(
        '[tool-sanitizer-telemetry] Metrics_Sink emit failed; falling back to log:',
        (err as Error)?.message,
      );
    }
  }
  logger.debug('[tool-sanitizer-telemetry] metric', {
    key: TOOL_SANITIZER_DROPPED_KEY,
    value: droppedCount,
    sessionId,
  });
}
