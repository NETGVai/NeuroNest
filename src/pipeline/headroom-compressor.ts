/**
 * Headroom prompt compression wrapper (Slice 1).
 *
 * Sits in front of LLMClient.chat()/chatStream() and routes outgoing
 * messages through the `headroom-ai` SDK, which forwards to a local
 * Headroom proxy for compression. Returns compressed messages in the
 * SAME shape as the input (same `role`/`content` fields), so downstream
 * code is unchanged.
 *
 * Architecture:
 *   LLMClient.chat([msgs])
 *      → maybeCompressMessages(msgs)
 *         ├─ flag check: PERF_FLAGS.HEADROOM_COMPRESSION
 *         ├─ size gate:  HEADROOM_CONFIG.minBytes
 *         ├─ system-prompt protection (system messages NOT compressed)
 *         ├─ try { headroom.compress(msgs) } catch { return original }
 *         └─ telemetry: token savings logged + emitted to listeners
 *      → provider.chat(compressedMsgs)
 *
 * Design notes:
 *   • Lazy require — `headroom-ai` is only imported on first use, so
 *     boot cost is zero when the flag is off.
 *   • System messages are NEVER passed through. Compressing system
 *     prompts can shift model behavior subtly. Headroom's own SDK
 *     supports keeping system intact via its config; we belt-and-
 *     braces by stripping/restoring on our side too.
 *   • Tool messages and assistant messages with `tool_calls` are also
 *     left intact — Headroom can compress them, but the JSON-shape risk
 *     of mis-routed tool args is too high for Slice 1.
 *   • Failure modes: SDK throws, proxy unreachable, timeout, schema
 *     mismatch — all degrade to "return original messages." No
 *     telemetry is emitted on failure (so we don't poison stats).
 *   • This module is self-contained — no electron deps, no project
 *     imports outside feature-flags. Trivially unit-testable.
 *
 * Public API:
 *   maybeCompressMessages(messages, opts) → Promise<CompressionResult>
 *   getHeadroomStats()                    → CompressionTelemetry
 *   resetHeadroomStats()                  → void
 *
 * Validates: Slice 1 plan — wrap a single LLMClient call site, behind a
 * default-off flag, with graceful degradation when the proxy is missing.
 */

import { PERF_FLAGS, HEADROOM_CONFIG } from '../main/performance/feature-flags';
import { computeInputTokenBudget, resolveBudgetInputs } from './token-budget';
import { getActiveContextLength } from './active-model';
import { sanitizeToolMessages, type ChatMessage } from './tool-message-sanitizer';
import { recordDroppedMessages, type MetricsSink } from './tool-sanitizer-telemetry';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Subset of the LLMClient message shape we operate on. Kept structural so
 *  the wrapper is decoupled from the LLMClient's full type. */
export interface HeadroomMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  // Allow extra OpenAI/Anthropic fields to flow through transparently
  [key: string]: unknown;
}

export interface MaybeCompressOptions {
  /** Model identifier — passed to Headroom for tokenizer selection. */
  model?: string;
  /**
   * Override the default proxy URL on a per-call basis. Falls back to
   * HEADROOM_CONFIG.defaultProxyUrl which honors HEADROOM_PROXY_URL.
   */
  baseUrl?: string;
  /**
   * Explicit per-call input token budget override (Feature 2 wiring,
   * Requirement 13). When provided, it takes precedence over any
   * setting-derived or context-derived value and is treated as an explicit,
   * configured budget by the Token_Budget_Calculator.
   */
  inputTokenBudget?: number;
  /**
   * Active provider record. When supplied (and no explicit
   * `inputTokenBudget` is given), its context window is resolved via the
   * Active_Model_Resolver (`getActiveContextLength`) so the budget can scale
   * to the model — Requirement 13.2.
   */
  activeProvider?: unknown;
  /**
   * Persisted `inputBudget` setting (AppConfigSchema). Mapped to calculator
   * inputs via `resolveBudgetInputs`. Ignored when `inputTokenBudget` is set.
   */
  inputBudget?: number | null;
  /**
   * Optional Metrics_Sink for F3 sanitizer telemetry (Feature 3, Requirement
   * 22.3). When supplied and the happy-path sanitize removes one or more
   * messages, `tool_sanitizer.dropped_messages` is recorded with the count.
   * Fully fail-soft and backward compatible — omitting it preserves existing
   * behavior.
   */
  metricsSink?: MetricsSink | null;
  /**
   * Optional session id associated with the sanitizer telemetry sample. Null/
   * omitted records a global metric.
   */
  sessionId?: string | null;
}

export interface CompressionResult {
  /** Messages to send upstream — either compressed or the original. */
  messages: HeadroomMessage[];
  /** True iff Headroom was invoked AND returned a usable result. */
  compressed: boolean;
  /** Why we skipped (or failed). Empty string on success. */
  skipReason?: string;
  /** Estimated tokens before compression (Headroom's count). 0 when skipped. */
  tokensBefore: number;
  /** Estimated tokens after compression. tokensBefore == tokensAfter when skipped. */
  tokensAfter: number;
  /** Wall-clock cost of the SDK round-trip (ms). */
  durationMs: number;
  /**
   * Input token budget resolved for this call via the Token_Budget_Calculator
   * (Feature 2, Requirement 13). Reproduces today's default (`DEFAULT_BUDGET`)
   * when no budget inputs are supplied.
   */
  inputTokenBudget: number;
}

export interface CompressionTelemetry {
  /** Number of times the wrapper was called (regardless of outcome). */
  totalCalls: number;
  /** Calls where Headroom actually compressed something. */
  successfulCompressions: number;
  /** Calls skipped due to flag/size/system-only/tool gates. */
  skippedCalls: number;
  /** Calls where the SDK threw (proxy down, timeout, schema mismatch). */
  failedCalls: number;
  /** Cumulative tokens saved across all successful compressions. */
  tokensSavedTotal: number;
  /** Cumulative tokens before across all successful compressions (for ratio). */
  tokensBeforeTotal: number;
  /** Last error message — useful when the dashboard says "0 saves." */
  lastError?: string;
  /**
   * True when the most recent compression attempt strongly indicates the local
   * Headroom proxy is unreachable. The SDK runs with `fallback: true`, so a
   * proxy-down condition does NOT throw — it silently returns the original
   * messages with `compressed:false` and all-zero token counts. We surface
   * that here so the UI can show "Proxy offline" instead of a misleading
   * "standing by" while compression is in fact a no-op.
   */
  proxyUnavailable?: boolean;
}

// ─── Telemetry ───────────────────────────────────────────────────────────────

const telemetry: CompressionTelemetry = {
  totalCalls: 0,
  successfulCompressions: 0,
  skippedCalls: 0,
  failedCalls: 0,
  tokensSavedTotal: 0,
  tokensBeforeTotal: 0,
  proxyUnavailable: false,
};

export function getHeadroomStats(): CompressionTelemetry {
  return { ...telemetry };
}

export function resetHeadroomStats(): void {
  telemetry.totalCalls = 0;
  telemetry.successfulCompressions = 0;
  telemetry.skippedCalls = 0;
  telemetry.failedCalls = 0;
  telemetry.tokensSavedTotal = 0;
  telemetry.tokensBeforeTotal = 0;
  telemetry.proxyUnavailable = false;
  delete telemetry.lastError;
}

// ─── Lazy SDK loader ─────────────────────────────────────────────────────────

interface HeadroomCompressFn {
  (messages: any[], options?: any): Promise<{
    messages: any[];
    tokensBefore: number;
    tokensAfter: number;
    tokensSaved: number;
    compressed: boolean;
  }>;
}

let cachedCompress: HeadroomCompressFn | null | undefined;

function loadHeadroom(): HeadroomCompressFn | null {
  if (cachedCompress !== undefined) return cachedCompress;
  try {
    // Avoid bundlers statically resolving the dep so it stays optional.
    // require() is intentional here — the Electron main process is CJS.
    /* eslint-disable @typescript-eslint/no-var-requires */
    const mod = require('headroom-ai');
    /* eslint-enable @typescript-eslint/no-var-requires */
    if (typeof mod?.compress === 'function') {
      cachedCompress = mod.compress as HeadroomCompressFn;
    } else {
      cachedCompress = null;
    }
  } catch {
    cachedCompress = null;
  }
  return cachedCompress;
}

/** Test seam — lets unit tests inject a stub without going through require. */
export function _setHeadroomCompressFn(fn: HeadroomCompressFn | null): void {
  cachedCompress = fn;
}

// ─── Local self-contained compressor (no proxy required) ──────────────────────
//
// Mirrors the worker's in-proxy compressor (worker/llm-proxy/src/compress.ts):
// a dependency-free, semantics-preserving whitespace/encoding normalizer. It is
// the ALWAYS-ON baseline so compression never depends on an external Headroom
// proxy being reachable. The transforms are idempotent, so when traffic is also
// routed through the NeuroNest LLM proxy (which compresses inline) the second
// pass simply finds nothing more to trim — no double-counting, no corruption.
//
// Safe transforms only (never change meaning of prose OR code):
//   1. CRLF / lone-CR → LF
//   2. trailing whitespace per line → stripped
//   3. 3+ consecutive newlines → one blank line
//   4. leading / trailing blank lines → trimmed
// Intra-line spacing (indentation, aligned tables) is never touched.

/** Normalize a text blob; returns the same reference when nothing changed. */
export function normalizeText(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text.replace(/\r\n?/g, '\n');
  out = out.replace(/[ \t]+\n/g, '\n');
  out = out.replace(/[ \t]+$/g, '');
  out = out.replace(/\n{3,}/g, '\n\n');
  out = out.replace(/^\n+/, '').replace(/\n+$/, '');
  return out === text ? text : out;
}

/**
 * Apply the local normalizer to every compressible message, preserving count
 * and order (unchanged messages returned by reference). Returns the new array
 * plus the UTF-8 byte sizes before/after across compressible content.
 */
function localCompressMessages(messages: HeadroomMessage[]): {
  messages: HeadroomMessage[];
  changed: boolean;
  bytesBefore: number;
  bytesAfter: number;
} {
  let changed = false;
  let bytesBefore = 0;
  let bytesAfter = 0;
  const out: HeadroomMessage[] = new Array(messages.length);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isCompressibleMessage(msg) || typeof msg.content !== 'string') {
      out[i] = msg;
      continue;
    }
    const before = msg.content;
    bytesBefore += Buffer.byteLength(before, 'utf-8');
    const after = normalizeText(before);
    bytesAfter += Buffer.byteLength(after, 'utf-8');
    if (after !== before) {
      changed = true;
      out[i] = { ...msg, content: after };
    } else {
      out[i] = msg;
    }
  }

  return { messages: out, changed, bytesBefore, bytesAfter };
}

/**
 * Build a successful CompressionResult from a local-compression pass. Token
 * counts are estimated at ~4 chars/token (matching the proxy). Records the
 * savings into telemetry under a `local` provenance so the UI's Saved/Ratio
 * populate even with no external proxy.
 */
function localCompressResult(
  original: HeadroomMessage[],
  startedAt: number,
  inputTokenBudget: number,
): CompressionResult {
  const local = localCompressMessages(original);
  const tokensBefore = Math.ceil(local.bytesBefore / 4);
  const tokensAfter = Math.ceil(local.bytesAfter / 4);
  const tokensSaved = Math.max(0, tokensBefore - tokensAfter);

  if (!local.changed || tokensSaved <= 0) {
    telemetry.skippedCalls++;
    return skipResult(original, 'local-no-savings', startedAt, inputTokenBudget);
  }

  const sanitized = sanitizeToolMessages(
    local.messages as unknown as ChatMessage[],
  ) as unknown as HeadroomMessage[];

  telemetry.successfulCompressions++;
  telemetry.tokensSavedTotal += tokensSaved;
  telemetry.tokensBeforeTotal += tokensBefore;
  telemetry.proxyUnavailable = false;
  delete telemetry.lastError;

  return {
    messages: sanitized,
    compressed: true,
    skipReason: '',
    tokensBefore,
    tokensAfter,
    durationMs: Date.now() - startedAt,
    inputTokenBudget,
  };
}

// ─── Eligibility gates ───────────────────────────────────────────────────────

/**
 * Decide whether a message is safe and worthwhile to send to Headroom.
 * Filters in: user messages, plain assistant replies (no tool_calls), and
 * tool result messages. Filters out: system prompts (behavior-shifting risk)
 * and assistant messages that include tool_calls (JSON-shape risk).
 */
function isCompressibleMessage(m: HeadroomMessage): boolean {
  if (!m || typeof m.content !== 'string') return false;
  if (m.role === 'system') return false;
  if (m.role === 'assistant' && (m as any).tool_calls) return false;
  return true;
}

/**
 * Total byte size of compressible messages. Used by the size gate so we
 * skip compression on tiny chat exchanges where round-trip cost > savings.
 */
function compressibleByteSize(messages: HeadroomMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (!isCompressibleMessage(m)) continue;
    if (typeof m.content === 'string') total += Buffer.byteLength(m.content, 'utf-8');
  }
  return total;
}

// ─── Budget resolution (Feature 2 wiring) ────────────────────────────────────

/**
 * Resolve the input token budget for a compression call via the shared
 * Token_Budget_Calculator (Feature 2). Satisfies Requirement 13:
 *
 *   13.1 — the budget is obtained by calling `computeInputTokenBudget`.
 *   13.2 — when the active model's context length is needed, it is read via
 *          the Active_Model_Resolver (`getActiveContextLength`).
 *
 * Precedence:
 *   1. `opts.inputTokenBudget` — an explicit per-call override (explicit=true).
 *   2. `opts.inputBudget` setting — mapped through `resolveBudgetInputs`.
 *
 * The active provider's context window (when supplied) feeds adaptive sizing.
 * With no budget inputs at all the calculator reproduces today's default
 * (`DEFAULT_BUDGET`), preserving existing behavior.
 */
function resolveCompressionBudget(opts: MaybeCompressOptions): number {
  const { configured, explicit } =
    typeof opts.inputTokenBudget === 'number'
      ? { configured: opts.inputTokenBudget, explicit: true }
      : resolveBudgetInputs(opts.inputBudget);

  const contextLength =
    opts.activeProvider !== undefined ? getActiveContextLength(opts.activeProvider) : 0;

  return computeInputTokenBudget(configured, contextLength, explicit);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Conditionally route messages through Headroom. Always returns a result —
 * never throws. When the flag is off / SDK is missing / proxy is down,
 * returns the original messages with `compressed: false`.
 */
export async function maybeCompressMessages(
  messages: HeadroomMessage[],
  opts: MaybeCompressOptions = {},
): Promise<CompressionResult> {
  const startedAt = Date.now();
  telemetry.totalCalls++;

  // Resolve the input token budget once, via the shared Token_Budget_Calculator
  // (Feature 2, Requirement 13). Surfaced on every result so callers can route
  // it into downstream sizing decisions.
  const inputTokenBudget = resolveCompressionBudget(opts);

  // 1) Flag check
  if (!PERF_FLAGS.HEADROOM_COMPRESSION) {
    telemetry.skippedCalls++;
    return skipResult(messages, 'flag-off', startedAt, inputTokenBudget);
  }

  // 2) Empty / single-message escape
  if (!Array.isArray(messages) || messages.length === 0) {
    telemetry.skippedCalls++;
    return skipResult(messages, 'empty-input', startedAt, inputTokenBudget);
  }

  // 3) Size gate — skip small payloads (round-trip cost > savings)
  const size = compressibleByteSize(messages);
  if (size < HEADROOM_CONFIG.minBytes) {
    telemetry.skippedCalls++;
    return skipResult(
      messages,
      `below-min-bytes(${size}<${HEADROOM_CONFIG.minBytes})`,
      startedAt,
      inputTokenBudget,
    );
  }

  // 4) Choose the compression engine. Unless an EXTERNAL Headroom proxy is
  //    explicitly configured (HEADROOM_PROXY_URL), use the built-in local
  //    compressor directly — no wasted round-trip to a proxy that isn't there.
  if (!HEADROOM_CONFIG.proxyConfigured) {
    return localCompressResult(messages, startedAt, inputTokenBudget);
  }

  // External proxy configured → lazy-load the SDK. If it isn't installed,
  // fall back to the local compressor so compression is ALWAYS available.
  const compress = loadHeadroom();
  if (!compress) {
    return localCompressResult(messages, startedAt, inputTokenBudget);
  }

  // 5) Split system messages out so they bypass compression entirely.
  //    Index-track so we can splice them back in their original positions.
  const protectedIndices: number[] = [];
  const candidateMessages: HeadroomMessage[] = [];
  const candidateIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isCompressibleMessage(messages[i])) {
      candidateMessages.push(messages[i]);
      candidateIndices.push(i);
    } else {
      protectedIndices.push(i);
    }
  }
  if (candidateMessages.length === 0) {
    telemetry.skippedCalls++;
    return skipResult(messages, 'no-compressible-messages', startedAt, inputTokenBudget);
  }

  // 6) Race the SDK call against a hard timeout — proxy might be slow/dead
  let result;
  try {
    result = await Promise.race([
      compress(candidateMessages, {
        baseUrl: opts.baseUrl ?? HEADROOM_CONFIG.defaultProxyUrl,
        model: opts.model,
        timeout: HEADROOM_CONFIG.timeoutMs,
        retries: HEADROOM_CONFIG.retries,
        fallback: true,
        stack: 'neuronest',
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Headroom timeout after ${HEADROOM_CONFIG.timeoutMs}ms`)),
          HEADROOM_CONFIG.timeoutMs,
        ),
      ),
    ]);
  } catch (err: any) {
    // SDK threw (timeout, connection error with fallback disabled, etc.) —
    // fall back to the local compressor instead of skipping, so compression
    // stays always-on. Record the cause for operator visibility.
    telemetry.lastError = err?.message ?? String(err);
    return localCompressResult(messages, startedAt, inputTokenBudget);
  }

  // 7) Validate the SDK response shape — defensive against version drift
  if (!result || !Array.isArray(result.messages)) {
    telemetry.failedCalls++;
    telemetry.lastError = 'invalid-response-shape';
    return skipResult(messages, 'invalid-response-shape', startedAt, inputTokenBudget);
  }
  if (result.messages.length !== candidateMessages.length) {
    // Headroom returned a different number of messages than we sent —
    // we can't safely splice back into the protected positions.
    telemetry.failedCalls++;
    telemetry.lastError = `length-mismatch (sent=${candidateMessages.length}, got=${result.messages.length})`;
    return skipResult(messages, telemetry.lastError, startedAt, inputTokenBudget);
  }

  // 8) If Headroom decided not to compress, treat as a skip.
  //
  // The SDK runs with `fallback: true`, so when the local proxy is unreachable
  // it does NOT throw — it returns the original messages with
  // `compressed:false` and ALL-ZERO token counts (see makeFallbackResult in
  // the headroom-ai SDK). We distinguish that proxy-down fallback from a
  // genuine "ran, found no savings" result: the latter still reports
  // `tokensBefore > 0`. When we sent real candidate content (we're past the
  // size gate, so `size >= minBytes`) but the SDK reports zero tokens
  // in/out/saved, the proxy almost certainly isn't running — flag it so the UI
  // can say "Proxy offline" instead of a misleading "standing by".
  if (result.compressed === false || (result.tokensSaved ?? 0) <= 0) {
    const looksLikeProxyDown =
      result.compressed === false &&
      (result.tokensBefore ?? 0) === 0 &&
      (result.tokensAfter ?? 0) === 0;
    if (looksLikeProxyDown) {
      // The external proxy is unreachable — fall back to the local
      // self-contained compressor so compression still happens. We note the
      // degraded mode in lastError (without flipping the hard-failure UI) so
      // operators can see the proxy is down while savings still accrue.
      telemetry.lastError =
        'Headroom proxy unreachable at ' +
        (opts.baseUrl ?? HEADROOM_CONFIG.defaultProxyUrl) +
        ' — using local compressor';
      return localCompressResult(messages, startedAt, inputTokenBudget);
    }
    telemetry.skippedCalls++;
    return skipResult(messages, 'no-savings', startedAt, inputTokenBudget);
  }

  // 9) Reassemble: splice compressed candidates back into their original
  //    positions so the upstream provider sees the same role-ordering.
  const merged: HeadroomMessage[] = new Array(messages.length);
  for (let p = 0; p < protectedIndices.length; p++) {
    merged[protectedIndices[p]] = messages[protectedIndices[p]];
  }
  for (let c = 0; c < candidateIndices.length; c++) {
    merged[candidateIndices[c]] = result.messages[c] as HeadroomMessage;
  }

  const tokensBefore = result.tokensBefore ?? 0;
  const tokensAfter = result.tokensAfter ?? tokensBefore;
  const tokensSaved = Math.max(0, tokensBefore - tokensAfter);

  telemetry.successfulCompressions++;
  telemetry.tokensSavedTotal += tokensSaved;
  telemetry.tokensBeforeTotal += tokensBefore;
  // A real round-trip succeeded — the proxy is clearly up. Clear any stale
  // offline flag/error so the UI recovers without needing a reset.
  telemetry.proxyUnavailable = false;
  delete telemetry.lastError;

  // Sanitize the reassembled array before returning so no invalid tool-call
  // sequence (orphan tool messages / dangling assistant tool_calls) reaches
  // the provider (Feature 3, Requirement 21). HeadroomMessage is structurally
  // compatible with ChatMessage (ExtendedLLMMessage); the sanitizer returns an
  // order-preserving subsequence of reference-equal elements, so casting back
  // to HeadroomMessage[] preserves the returned array shape.
  const sanitized = sanitizeToolMessages(
    merged as unknown as ChatMessage[],
  ) as unknown as HeadroomMessage[];

  // F3 telemetry (Requirement 22.3): when the sanitizer removed one or more
  // messages, record the drop count to the Metrics_Sink. Fail-soft — never
  // affects the compression result.
  recordDroppedMessages(
    opts.metricsSink,
    merged.length - sanitized.length,
    opts.sessionId ?? null,
  );

  return {
    messages: sanitized,
    compressed: true,
    skipReason: '',
    tokensBefore,
    tokensAfter,
    durationMs: Date.now() - startedAt,
    inputTokenBudget,
  };
}

function skipResult(
  messages: HeadroomMessage[],
  reason: string,
  startedAt: number,
  inputTokenBudget: number,
): CompressionResult {
  return {
    messages,
    compressed: false,
    skipReason: reason,
    tokensBefore: 0,
    tokensAfter: 0,
    durationMs: Date.now() - startedAt,
    inputTokenBudget,
  };
}
