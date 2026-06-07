/**
 * Tool_Call_Recovery_Handler — detects and repairs dangling tool-call entries
 * when a provider interrupts a tool-call loop (forced-stop response).
 *
 * Injects placeholder tool results, strips raw metadata, appends a system
 * recovery note, and tracks per-tool consecutive failure counts to disable
 * tools that fail repeatedly.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */

import type { LLMMessage } from './llm-client.js';
import type { RecoveryEvent, ToolCallRecoveryConfig } from './types/deerflow-types.js';
import { recordErrorSize } from './error-size-tap.js';
import { captureError } from './error-capture.js';
import { compactError } from './error-compactor.js';
import { estimateTokens } from '../session/context-compressor.js';
import { PERF_FLAGS } from '../main/performance/feature-flags.js';

// ─── Extended message type for tool-call fields ─────────────────

interface ToolCallEntry {
  id: string;
  function: { name: string };
}

export interface ExtendedLLMMessage extends LLMMessage {
  tool_calls?: ToolCallEntry[];
  function_call?: { name: string };
  tool_call_id?: string;
}

/**
 * Structural Metrics_Sink type — mirrored locally so this module does not
 * depend on `SessionTelemetryService`. Any object exposing `recordMetric`
 * satisfies it (notably `SessionTelemetryService`; tests pass a plain stub).
 *
 * Used to feed `errors.compacted.{input,output}_{bytes,estimated_tokens}`
 * per Requirement 5.2 when the Error_Compactor runs at this Tool_Retry_Site.
 */
export interface MetricsSink {
  recordMetric(sessionId: string | null, key: string, value: number): void;
}

/**
 * Constructor options for `ToolCallRecoveryHandler`. Extends the base
 * `ToolCallRecoveryConfig` with optional Error_Compactor wiring (task 18 of
 * the 12-factor-agent-improvements spec).
 */
export interface ToolCallRecoveryHandlerOptions extends Partial<ToolCallRecoveryConfig> {
  /**
   * Metrics_Sink used to record `errors.compacted.*` samples whenever the
   * Error_Compactor runs (active or shadow mode). Optional — when absent,
   * the compactor still executes per the flag gating but no metrics are
   * persisted.
   */
  metricsSink?: MetricsSink;
  /**
   * Source-root list forwarded to `compactError`. Defaults inside the
   * compactor to `[process.cwd()]` when omitted; callers with a resolved
   * project path SHOULD pass it explicitly.
   */
  compactorSourceRoots?: string[];
}

// ─── Default configuration ──────────────────────────────────────

const DEFAULT_CONFIG: ToolCallRecoveryConfig = {
  maxConsecutiveFailures: 3,
};

const RECOVERY_NOTE = 'Note: One or more tool calls were interrupted and could not complete.';

/** Raw placeholder text used when Error_Compactor is gated off. */
const RAW_PLACEHOLDER_TEXT = 'Error: Tool call interrupted';

// ─── ToolCallRecoveryHandler ────────────────────────────────────

export class ToolCallRecoveryHandler {
  private failureCounts: Map<string, number> = new Map();
  private disabledTools: Set<string> = new Set();
  private events: RecoveryEvent[] = [];
  private readonly config: ToolCallRecoveryConfig;
  private readonly metricsSink: MetricsSink | undefined;
  private readonly compactorSourceRoots: string[] | undefined;

  constructor(options?: ToolCallRecoveryHandlerOptions) {
    const { metricsSink, compactorSourceRoots, ...config } = options ?? {};
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.metricsSink = metricsSink;
    this.compactorSourceRoots = compactorSourceRoots;
  }

  /**
   * Process a message history, detecting and repairing dangling tool calls.
   *
   * A "dangling" tool call is an assistant message with `tool_calls` entries
   * where no subsequent message has `role: 'tool'` with a matching `tool_call_id`.
   *
   * For each dangling call:
   * 1. Inject a tool-role placeholder result with error status
   * 2. Strip `function_call` and `tool_calls` from the assistant message
   * 3. Track consecutive failures per tool name
   * 4. Disable tools that reach maxConsecutiveFailures
   *
   * Appends a system note explaining the interruption.
   *
   * When `PERF_FLAGS.ERROR_COMPACTION || PERF_FLAGS.ERROR_COMPACTION_SHADOW`,
   * the synthetic error placeholder is routed through `compactError` and the
   * resulting `errors.compacted.*` metrics are recorded on the configured
   * Metrics_Sink. Only when `PERF_FLAGS.ERROR_COMPACTION === true` is the
   * compacted text actually fed back to the LLM; in shadow mode the raw
   * placeholder text is preserved (pre-refactor behaviour).
   *
   * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 3.7, 4.4
   *
   * @param messages   The message history to process.
   * @param sessionId  Optional session id used to attribute metrics samples.
   *                   Pass `null` for global / unattributed retries.
   */
  recover(
    messages: LLMMessage[],
    sessionId: string | null = null,
  ): { messages: LLMMessage[]; events: RecoveryEvent[] } {
    const extended = messages as ExtendedLLMMessage[];
    const recoveryEvents: RecoveryEvent[] = [];

    // Collect all tool_call_ids that already have a tool-role response
    const answeredIds = new Set<string>();
    for (const msg of extended) {
      if ((msg as any).role === 'tool' && (msg as any).tool_call_id) {
        answeredIds.add((msg as any).tool_call_id);
      }
    }

    // Find dangling tool calls
    const danglingCalls: Array<{ msgIndex: number; call: ToolCallEntry }> = [];
    for (let i = 0; i < extended.length; i++) {
      const msg = extended[i];
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        for (const call of msg.tool_calls) {
          if (!answeredIds.has(call.id)) {
            danglingCalls.push({ msgIndex: i, call });
          }
        }
      }
    }

    // No dangling calls — return as-is
    if (danglingCalls.length === 0) {
      return { messages: [...messages], events: [] };
    }

    // Build repaired message list
    const result: ExtendedLLMMessage[] = [];
    const strippedIndices = new Set<number>();
    const interruptedTools: string[] = [];

    for (const { msgIndex, call } of danglingCalls) {
      strippedIndices.add(msgIndex);
      const toolName = call.function.name;
      interruptedTools.push(toolName);

      // Track consecutive failures
      const currentCount = (this.failureCounts.get(toolName) ?? 0) + 1;
      this.failureCounts.set(toolName, currentCount);

      // Disable if threshold reached
      if (currentCount >= this.config.maxConsecutiveFailures) {
        this.disabledTools.add(toolName);
      }
    }

    // Deduplicate tool names for event logging
    const uniqueInterrupted = [...new Set(interruptedTools)];

    for (let i = 0; i < extended.length; i++) {
      const msg = extended[i];

      if (strippedIndices.has(i)) {
        // Strip tool_calls and function_call from the assistant message (Req 7.3)
        const cleaned: ExtendedLLMMessage = {
          role: msg.role,
          content: msg.content || '',
        };
        result.push(cleaned);

        // Inject placeholder results for each dangling call on this message (Req 7.2)
        for (const { msgIndex, call } of danglingCalls) {
          if (msgIndex === i) {
            // Synthesise the structured error that represents this interrupted
            // tool call. Used by:
            //   - the always-on error-size tap (task 0, Req 5.5)
            //   - the Error_Capture_Helper migration (task 14, Req 2.7)
            //   - the Error_Compactor wiring (task 18, Req 3.7 / 4.4)
            const syntheticError = {
              name: 'ToolCallInterrupted',
              message: RAW_PLACEHOLDER_TEXT,
              tool_call_id: call.id,
              tool_name: call.function.name,
            };

            // Observation-only error-size tap (Requirement 5.5, task 0).
            // Always-on, no flag, no behaviour change.
            recordErrorSize(syntheticError, sessionId);

            // Error_Capture_Helper (task 14, Requirement 2.7). The
            // recovery handler does not own a session id — the EventLog
            // emit therefore skips silently — but invoking the helper
            // here keeps the migration uniform across the three Tool_Retry
            // sites and gives us a correlation id to thread through the
            // recovery event if a session ever becomes reachable from
            // this call site. Augments, never replaces, the recordErrorSize
            // tap above.
            captureError('tool-call-recovery.dangling-call', syntheticError);

            // ── Error_Compactor wiring (task 18, Requirements 3.7, 4.4) ──
            //
            // Run the compactor whenever EITHER flag is set. In shadow mode
            // we still record `errors.compacted.*` metrics but feed the raw
            // placeholder text to the LLM (zero behaviour change). When
            // ERROR_COMPACTION = true the compacted digest is sent instead.
            //
            // The compactor itself is a pure function — calling it cannot
            // throw under normal inputs — but we still wrap it in try/catch
            // to keep the recovery path strictly fail-soft. A compactor
            // failure must never break tool-call recovery.
            const shouldCompact =
              PERF_FLAGS.ERROR_COMPACTION || PERF_FLAGS.ERROR_COMPACTION_SHADOW;

            let compacted: string | null = null;
            if (shouldCompact) {
              try {
                compacted = compactError(syntheticError as any, {
                  sourceRoots: this.compactorSourceRoots,
                });
              } catch (err) {
                // Fail-soft: log once and continue with the raw placeholder.
                console.warn(
                  '[tool-call-recovery] compactError threw; falling back to raw placeholder:',
                  (err as Error)?.message,
                );
                compacted = null;
              }
            }

            // Record metrics whenever the compactor produced output, irrespective
            // of which flag drove it. This is what makes shadow-mode telemetry
            // work (Requirement 4.4 Phase 0). Best-effort; sink failures are
            // swallowed so they cannot break the retry path.
            if (compacted !== null && this.metricsSink) {
              try {
                const rawJson = JSON.stringify(syntheticError);
                this.metricsSink.recordMetric(
                  sessionId,
                  'errors.compacted.input_bytes',
                  Buffer.byteLength(rawJson, 'utf8'),
                );
                this.metricsSink.recordMetric(
                  sessionId,
                  'errors.compacted.output_bytes',
                  Buffer.byteLength(compacted, 'utf8'),
                );
                this.metricsSink.recordMetric(
                  sessionId,
                  'errors.compacted.input_estimated_tokens',
                  estimateTokens(rawJson),
                );
                this.metricsSink.recordMetric(
                  sessionId,
                  'errors.compacted.output_estimated_tokens',
                  estimateTokens(compacted),
                );
              } catch (err) {
                console.warn(
                  '[tool-call-recovery] metrics recording failed; continuing:',
                  (err as Error)?.message,
                );
              }
            }

            // Only the active flag actually changes what the LLM sees; in
            // shadow mode the raw placeholder is preserved verbatim.
            const placeholderText =
              PERF_FLAGS.ERROR_COMPACTION && compacted !== null
                ? compacted
                : RAW_PLACEHOLDER_TEXT;

            result.push({
              role: 'tool' as any,
              content: placeholderText,
              tool_call_id: call.id,
            } as any);
          }
        }
      } else {
        result.push({ ...msg });
      }
    }

    // Append system recovery note (Req 7.5)
    result.push({
      role: 'system',
      content: RECOVERY_NOTE,
    });

    // Create recovery events
    // One event for placeholder injections
    const placeholderEvent: RecoveryEvent = {
      timestamp: new Date(),
      interruptedTools: uniqueInterrupted,
      reason: 'Dangling tool calls detected — provider interrupted tool-call sequence',
      recoveryAction: 'placeholder_injected',
    };
    recoveryEvents.push(placeholderEvent);

    // Additional events for any tools that got disabled
    for (const toolName of uniqueInterrupted) {
      if (this.disabledTools.has(toolName)) {
        const disableEvent: RecoveryEvent = {
          timestamp: new Date(),
          interruptedTools: [toolName],
          reason: `Tool "${toolName}" disabled after ${this.config.maxConsecutiveFailures} consecutive failures`,
          recoveryAction: 'tool_disabled',
        };
        recoveryEvents.push(disableEvent);
      }
    }

    // Store events
    this.events.push(...recoveryEvents);

    return { messages: result as LLMMessage[], events: recoveryEvents };
  }

  /**
   * Check if a tool is temporarily disabled due to consecutive failures.
   *
   * Requirements: 7.6
   */
  isToolDisabled(toolName: string): boolean {
    return this.disabledTools.has(toolName);
  }

  /**
   * Reset failure count for a tool (e.g., after a successful call).
   * Also removes the tool from the disabled set.
   *
   * Requirements: 7.6
   */
  resetFailureCount(toolName: string): void {
    this.failureCounts.set(toolName, 0);
    this.disabledTools.delete(toolName);
  }

  /**
   * Get all recovery events for logging/audit.
   *
   * Requirements: 7.4
   */
  getEvents(): RecoveryEvent[] {
    return [...this.events];
  }
}

export default ToolCallRecoveryHandler;
