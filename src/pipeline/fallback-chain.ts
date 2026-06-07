/**
 * Fallback Chain — Cascading Provider Failover
 *
 * Wraps LLM calls with a fallback chain. If the primary provider fails,
 * cascades through configured fallback providers before giving up.
 */

import { LLMClient, type LLMMessage } from './llm-client';
import { createLLMClientWithProMode } from './pro-mode-state';
import { recordErrorSize } from './error-size-tap';
import { captureError } from './error-capture';
import { compactError } from './error-compactor';
import { estimateTokens } from '../session/context-compressor';
import { PERF_FLAGS } from '../main/performance/feature-flags';
import type { MetricsSink } from './tool-call-recovery';

interface LLMResponse {
  content: string;
  reasoning?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export interface FallbackChainConfig {
  primary: LLMClient;
  fallbacks: LLMClient[];
  maxRetries?: number;
  /**
   * Metrics_Sink used to record `errors.compacted.*` samples whenever the
   * Error_Compactor runs (active or shadow mode). Optional — when absent,
   * the compactor still executes per the flag gating but no metrics are
   * persisted. See Requirement 5.2 / task 19.
   */
  metricsSink?: MetricsSink;
  /**
   * Session id used to attribute compaction metrics samples. May be `null`
   * for global / unattributed retries.
   */
  sessionId?: string | null;
  /**
   * Source-root list forwarded to `compactError`. Defaults inside the
   * compactor to `[process.cwd()]` when omitted; callers with a resolved
   * project path SHOULD pass it explicitly.
   */
  compactorSourceRoots?: string[];
}

export interface FallbackResult {
  response: LLMResponse;
  usedFallback: boolean;
  providerUsed: string;
  attemptsMade: number;
}

/**
 * Errors that should trigger a fallback (transient failures).
 * Permanent errors (invalid API key, model not found) should NOT fallback.
 */
function isTransientError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('socket hang up') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('overloaded') ||
    msg.includes('capacity')
  );
}

/**
 * Build a JSON-friendly serialisation of the raw error. Error instances do
 * not stringify usefully via `JSON.stringify` because `name`, `message`, and
 * `stack` are non-enumerable, so a naive `JSON.stringify(lastError)` would
 * report `{}` and the `errors.compacted.input_*` telemetry would always
 * read zero. Mirrors the shape `compactError` consumes so input/output size
 * comparisons in the dashboard are apples-to-apples.
 */
function serialiseErrorForMetrics(err: Error): string {
  const anyErr = err as Error & { code?: string | number; output?: string };
  const shape: Record<string, unknown> = {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };
  if (anyErr.code !== undefined) shape['code'] = anyErr.code;
  if (typeof anyErr.output === 'string') shape['output'] = anyErr.output;
  try {
    return JSON.stringify(shape);
  } catch {
    return String(err);
  }
}

/**
 * Execute an LLM chat call with fallback chain support.
 * Tries the primary provider first, then each fallback in order.
 */
export async function chatWithFallback(
  chain: FallbackChainConfig,
  messages: LLMMessage[],
  options?: { temperature?: number; maxTokens?: number }
): Promise<FallbackResult> {
  const maxRetries = chain.maxRetries ?? 3;
  const allClients = [chain.primary, ...chain.fallbacks.slice(0, maxRetries - 1)];

  let lastError: Error | null = null;
  let attemptsMade = 0;

  for (let i = 0; i < allClients.length; i++) {
    const client = allClients[i];
    attemptsMade++;

    try {
      const response = await client.chat(messages, options);
      const providerName = (client as any).config?.provider || (client as any).config?.type || `provider-${i}`;

      return {
        response,
        usedFallback: i > 0,
        providerUsed: providerName,
        attemptsMade,
      };
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Observation-only error-size tap (Requirement 5.5, task 0).
      // Always-on, no flag, no behaviour change: records the JSON-serialised
      // token size of the raw error so we can set the empirical floor for
      // `errors.compaction.maxTokens` before Error_Compactor ships.
      recordErrorSize(lastError);

      // Error_Capture_Helper (task 14, Requirement 2.7). Lands an
      // `error.captured` Pipeline_Event so the unified state log sees
      // every fallback-chain provider failure. Sessionless — the
      // fallback chain does not carry a session id today; the helper
      // skips the emit silently in that case but always returns a
      // correlation id, kept here for future log correlation.
      captureError('fallback-chain.provider-failure', lastError);

      // ── Error_Compactor wiring (task 19, Requirements 3.7, 3.8, 4.4) ──
      //
      // Run the compactor whenever EITHER flag is set. In shadow mode we
      // still record `errors.compacted.*` metrics but the raw error
      // semantics — including the message attached to the eventually-thrown
      // error and the `console.warn` log content — are preserved (zero
      // behaviour change). When `ERROR_COMPACTION = true` the compacted
      // digest replaces the raw `lastError.message` inside the
      // `console.warn` log line emitted between providers; the thrown
      // error itself is left untouched (Requirement 3.8 preserves error
      // semantics for upstream error-detection callers — e.g. things that
      // grep `error.message` for "rate limit").
      //
      // The compactor itself is a pure function — calling it cannot throw
      // under normal inputs — but we still wrap it in try/catch to keep
      // the retry path strictly fail-soft. A compactor failure must never
      // break the fallback chain.
      const shouldCompact =
        PERF_FLAGS.ERROR_COMPACTION || PERF_FLAGS.ERROR_COMPACTION_SHADOW;

      let compacted: string | null = null;
      if (shouldCompact) {
        try {
          compacted = compactError(lastError, {
            sourceRoots: chain.compactorSourceRoots,
          });
        } catch (compErr) {
          console.warn(
            '[FallbackChain] compactError threw; falling back to raw error message:',
            (compErr as Error)?.message,
          );
          compacted = null;
        }
      }

      // Record metrics whenever the compactor produced output, irrespective
      // of which flag drove it. This is what makes shadow-mode telemetry
      // work (Requirement 4.4 Phase 0). Best-effort; sink failures are
      // swallowed so they cannot break the retry path.
      if (compacted !== null && chain.metricsSink) {
        try {
          const rawJson = serialiseErrorForMetrics(lastError);
          const sessionId = chain.sessionId ?? null;
          chain.metricsSink.recordMetric(
            sessionId,
            'errors.compacted.input_bytes',
            Buffer.byteLength(rawJson, 'utf8'),
          );
          chain.metricsSink.recordMetric(
            sessionId,
            'errors.compacted.output_bytes',
            Buffer.byteLength(compacted, 'utf8'),
          );
          chain.metricsSink.recordMetric(
            sessionId,
            'errors.compacted.input_estimated_tokens',
            estimateTokens(rawJson),
          );
          chain.metricsSink.recordMetric(
            sessionId,
            'errors.compacted.output_estimated_tokens',
            estimateTokens(compacted),
          );
        } catch (sinkErr) {
          console.warn(
            '[FallbackChain] metrics recording failed; continuing:',
            (sinkErr as Error)?.message,
          );
        }
      }

      // Only fallback on transient errors. Permanent errors throw the
      // ORIGINAL `lastError` — never the compacted digest — so upstream
      // error-message inspection logic is unaffected (Requirement 3.8).
      if (!isTransientError(lastError)) {
        throw lastError;
      }

      // Transient: log a one-line warning before trying the next provider.
      // In active mode the compacted digest replaces the raw `message` in
      // the log; in shadow mode the raw message is preserved verbatim.
      const logBody =
        PERF_FLAGS.ERROR_COMPACTION && compacted !== null
          ? compacted
          : lastError.message;
      console.warn(`[FallbackChain] Provider ${i} failed (${logBody}), trying next...`);
    }
  }

  // All providers failed — throw the original `lastError` to preserve
  // error semantics for upstream callers (Requirement 3.8).
  throw lastError || new Error('All providers in fallback chain failed');
}

/**
 * Build a fallback chain from the user's configured providers.
 * Primary = default provider. Fallbacks = all other configured providers.
 */
export function buildFallbackChain(providers: any[], defaultProviderId?: string): FallbackChainConfig | null {
  if (!providers || providers.length === 0) return null;

  let primary: any = null;
  const fallbacks: LLMClient[] = [];

  // Find the default provider
  if (defaultProviderId) {
    primary = providers.find(p => p.id === defaultProviderId || p.name === defaultProviderId || p.type === defaultProviderId);
  }
  if (!primary) primary = providers[0];

  const primaryClient = createLLMClientWithProMode(primary);
  if (!primaryClient) return null;

  // All other providers become fallbacks
  for (const p of providers) {
    if (p === primary) continue;
    const client = createLLMClientWithProMode(p);
    if (client) fallbacks.push(client);
  }

  return { primary: primaryClient, fallbacks };
}
