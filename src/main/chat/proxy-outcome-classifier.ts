/**
 * Proxy outcome classification for chat lifecycle terminal events.
 *
 * Bridges the transport-level {@link ClassifiedProxyError} discriminated
 * union produced by `src/providers/proxy-error-classifier.ts` and the
 * canonical chat lifecycle terminal events consumed by projectors and the
 * renderer (`response.completed`, `response.stopped`, `response.interrupted`,
 * `response.failed`).
 *
 * Requirements: 8.4, 8.5, 8.6, 8.7, 8.9, 10.5, 10.6, 12.7, 15.8
 *
 * ─── Design contract ────────────────────────────────────────────────────────
 *
 *  - `proxy_authentication` (HTTP 401) and `proxy_entitlement` (HTTP 403) are
 *    NON-FALLBACK failures. The renderer must surface a fix-my-credentials or
 *    fix-my-entitlement action. The classifier emits `response.failed` with
 *    `retry.retryable = false`. The user turn already appended by the
 *    preflight service is retained. No direct-provider fallback ever happens.
 *
 *  - `proxy_quota` (HTTP 402 / 429) is an INTERRUPTIBLE failure. If any
 *    answer/reasoning content was committed to the durable log before the
 *    failure, we emit `response.interrupted` with `partialContentRetained =
 *    true` and a retryable retry envelope. Otherwise we emit `response.failed`
 *    with `retry.retryable = true` and the same retry envelope so the
 *    renderer can offer a delayed retry action. `retryAfterMs` is validated
 *    and clamped to [0, 600_000] (10 minutes).
 *
 *  - `proxy_network` (transport-level failure) and `proxy_stream` (mid-stream
 *    gap / malformed frame) are stream-gap conditions. If any answer or
 *    reasoning content was committed we emit `response.interrupted` with
 *    `partialContentRetained = true`; otherwise `response.failed` with
 *    `partialContentRetained = false`.
 *
 *  - `proxy_upstream` (HTTP 5xx / proxy-internal / request-shape) maps to a
 *    stream-gap-shaped terminal event using the same partial-content branch
 *    logic as `proxy_network`. Retry is coordinator-scoped.
 *
 *  - `proxy_transport_mismatch` is an internal invariant violation. The
 *    classifier emits `response.failed` with `errorClass = 'internal'` and
 *    `retry.retryable = false`. No retry is offered.
 *
 *  - A `SessionLog.appendBatch` failure (persistence error) surfaced through
 *    {@link classifyPersistenceFailure} yields `response.interrupted` when
 *    any content was committed, otherwise `response.failed`. `errorClass` is
 *    always `persistence`. `retry.retryable` is `true` — the renderer can
 *    retry from scratch after the underlying persistence issue clears.
 *
 * ─── Diagnostic allowlist ──────────────────────────────────────────────────
 *
 * Every terminal payload built here carries only:
 *
 *   - `identity` (session/branch/turn/response/request/attempt/entity IDs)
 *   - `route`    (routeId/transportClass/provider/model/edition)
 *   - `type`, `terminalState`, `partialContentRetained`
 *   - `errorId`, `errorClass`, `summary`, `correlationId`
 *   - `retry`    (retryable, retryAfterMs?, previous* linkage)
 *
 * The classifier NEVER attaches:
 *   - prompt text, response text, reasoning content, tool call arguments/
 *     outputs, tool payload data
 *   - credential values or bearer/authorization headers
 *   - user file paths
 *   - free-form provider error messages
 *
 * Summaries are drawn from an allowlisted template table and passed through
 * {@link redactString} for defense in depth.
 */

import { randomUUID } from 'node:crypto';

import {
  ChatEventPayloadV1Schema,
  MAX_RETRY_AFTER_MS,
  RetryMetadataV1Schema,
  type ChatEventPayloadV1,
  type ChatEventRouteV1,
  type ChatResponseIdentityV1,
  type ChatStreamErrorClassV1,
  type ResponseFailedV1,
  type ResponseInterruptedV1,
  type RetryMetadataV1,
} from '../../harness/contracts/chat-stream-event.js';
import type {
  ClassifiedProxyError,
  ProxyErrorClass,
} from '../../providers/proxy-error-classifier.js';
import { redactString } from '../../shared/observable-redaction.js';

// ─── Bounds ────────────────────────────────────────────────────────────────

/**
 * Upper bound on any `retryAfterMs` value that leaves this module. Matches
 * the transport-level classifier's ceiling so the two layers agree on the
 * maximum stall duration the renderer will be asked to wait through.
 *
 * The renderer contract accepts up to {@link MAX_RETRY_AFTER_MS} (24 hours)
 * on the wire, but chat interruptions must not stall a request longer than
 * 10 minutes — beyond that we degrade to a failed state and let the user
 * initiate a retry manually.
 */
export const MAX_INTERRUPTION_RETRY_AFTER_MS = 600_000;

// ─── Terminal state derivation ─────────────────────────────────────────────

/**
 * Whether the terminal state should carry `partialContentRetained = true`.
 * `true` when any answer or reasoning content was committed to the durable
 * log before the failure, `false` otherwise. Tool/task/approval/thinking
 * upserts do not affect this flag by themselves — those are always retained
 * on any non-completed terminal event, but the flag specifically communicates
 * whether the user-visible ANSWER or REASONING surface has partial text to
 * show. This aligns with Requirement 8.7 and 12.7.
 */
export interface CommittedContentSnapshot {
  /** True when at least one `answer.delta` was durably appended. */
  readonly hasAnswerContent: boolean;
  /** True when at least one `reasoning.delta` was durably appended. */
  readonly hasReasoningContent: boolean;
}

/**
 * Whether interruption is preferable to failure for a given proxy error class.
 * Interruption preserves partial user-visible content and offers a retry
 * action; failure is used when no content survives to display.
 */
function supportsInterruption(errorClass: ProxyErrorClass): boolean {
  switch (errorClass) {
    case 'proxy_quota':
    case 'proxy_network':
    case 'proxy_stream':
    case 'proxy_upstream':
      return true;
    case 'proxy_authentication':
    case 'proxy_entitlement':
    case 'proxy_transport_mismatch':
      return false;
    default: {
      const exhaustive: never = errorClass;
      void exhaustive;
      return false;
    }
  }
}

/**
 * Whether the mapped chat error class permits a retryable retry envelope.
 * `retry.retryable` is TRUE only when the underlying failure can be
 * meaningfully re-attempted through the coordinated route path with a fresh
 * `requestId`/attempt.
 */
function isRetryable(errorClass: ProxyErrorClass): boolean {
  switch (errorClass) {
    case 'proxy_authentication':
    case 'proxy_entitlement':
    case 'proxy_transport_mismatch':
      return false;
    case 'proxy_quota':
    case 'proxy_network':
    case 'proxy_stream':
    case 'proxy_upstream':
      return true;
    default: {
      const exhaustive: never = errorClass;
      void exhaustive;
      return false;
    }
  }
}

/**
 * Map the transport-level proxy error class onto the canonical chat stream
 * error class. Total over the closed `ProxyErrorClass` union.
 */
function toChatErrorClass(errorClass: ProxyErrorClass): ChatStreamErrorClassV1 {
  switch (errorClass) {
    case 'proxy_authentication':
      return 'proxy_authentication';
    case 'proxy_entitlement':
      return 'proxy_entitlement';
    case 'proxy_quota':
      return 'proxy_quota';
    case 'proxy_network':
      // Transport-level failures surface as `network` to the renderer so the
      // retry action and diagnostic copy are network-shaped rather than
      // proxy-shaped. The proxy status is still on the diagnostic record.
      return 'network';
    case 'proxy_stream':
      return 'stream_gap';
    case 'proxy_upstream':
      // Upstream/5xx failures on the proxy layer surface as `network` at the
      // chat error class level. The distinction is preserved in the
      // classified diagnostic record but the renderer treats it as a
      // transport-shaped condition.
      return 'network';
    case 'proxy_transport_mismatch':
      return 'internal';
    default: {
      const exhaustive: never = errorClass;
      void exhaustive;
      return 'internal';
    }
  }
}

// ─── Input types ───────────────────────────────────────────────────────────

/**
 * Optional linkage back to a prior attempt so the emitted retry envelope
 * preserves turn lineage. Ignored for non-retryable classifications.
 */
export interface ProxyOutcomeRetryContext {
  readonly previousRequestId?: string;
  readonly previousAttempt?: number;
  readonly completionAnchorId?: string;
}

/**
 * Everything the classifier needs to produce a terminal event payload from a
 * classified proxy failure. `identity`, `route`, and `content` come from the
 * lifecycle state at the moment the failure was observed; `error` comes from
 * the transport-level classifier.
 */
export interface ProxyOutcomeInput {
  readonly identity: ChatResponseIdentityV1;
  readonly route: ChatEventRouteV1;
  readonly error: ClassifiedProxyError;
  readonly content: CommittedContentSnapshot;
  readonly retryContext?: ProxyOutcomeRetryContext;
  /**
   * Optional error identifier. Callers wanting deterministic identifiers
   * (tests, replay) supply one. Otherwise a fresh UUID is generated.
   */
  readonly errorId?: string;
  /**
   * Optional correlation identifier override. When absent the classifier
   * uses `error.metadata.correlationId` (already validated non-empty).
   */
  readonly correlationId?: string;
}

/**
 * Persistence failure input. Used when `SessionLog.appendBatch` throws
 * during stream event ingestion.
 */
export interface PersistenceOutcomeInput {
  readonly identity: ChatResponseIdentityV1;
  readonly route: ChatEventRouteV1;
  readonly correlationId: string;
  readonly content: CommittedContentSnapshot;
  readonly reason: string;
  readonly retryContext?: ProxyOutcomeRetryContext;
  readonly errorId?: string;
}

/**
 * Extended proxy error class union that includes non-transport failure
 * sources exposed by this module (currently: SessionLog persistence
 * failures). Distinct from {@link ProxyErrorClass} so callers who need to
 * dispatch on the underlying transport-level classification still get a
 * closed union, while diagnostics can attribute non-transport failures
 * without pretending they came from the proxy.
 */
export type OutcomeProxyErrorClass = ProxyErrorClass | 'persistence';

/**
 * Discriminated result: either an interruption (partial content preserved)
 * or a hard failure. Callers wrap the payload in the durable `SessionEventV1`
 * envelope through the lifecycle writer.
 */
export type ProxyOutcome =
  | {
      readonly kind: 'interrupted';
      readonly payload: ResponseInterruptedV1;
      readonly errorClass: ChatStreamErrorClassV1;
      readonly proxyErrorClass: OutcomeProxyErrorClass;
      readonly correlationId: string;
      readonly errorId: string;
      readonly retry: RetryMetadataV1;
      readonly partialContentRetained: true;
    }
  | {
      readonly kind: 'failed';
      readonly payload: ResponseFailedV1;
      readonly errorClass: ChatStreamErrorClassV1;
      readonly proxyErrorClass: OutcomeProxyErrorClass;
      readonly correlationId: string;
      readonly errorId: string;
      readonly retry: RetryMetadataV1;
      readonly partialContentRetained: boolean;
    };

// ─── Allowlisted summary templates ─────────────────────────────────────────

/**
 * Renderer-safe summary strings. Never include the raw proxy `message` body
 * because it can echo prompt/response content. Every string here is a fixed
 * template with at most an HTTP status code interpolated.
 */
function summaryForProxy(errorClass: ProxyErrorClass, httpStatus: number | undefined): string {
  const withStatus = httpStatus !== undefined ? ` (HTTP ${httpStatus})` : '';
  switch (errorClass) {
    case 'proxy_authentication':
      return `NeuroNest proxy rejected the request: authentication failure${withStatus}.`;
    case 'proxy_entitlement':
      return `NeuroNest proxy rejected the request: entitlement failure${withStatus}.`;
    case 'proxy_quota':
      return `NeuroNest proxy rate-limited or quota-limited the request${withStatus}.`;
    case 'proxy_network':
      return `NeuroNest proxy transport failed${withStatus}.`;
    case 'proxy_stream':
      return `NeuroNest proxy stream ended before delivering a complete response${withStatus}.`;
    case 'proxy_upstream':
      return `NeuroNest proxy reported an upstream failure${withStatus}.`;
    case 'proxy_transport_mismatch':
      return `NeuroNest proxy transport classification refused the request${withStatus}.`;
    default: {
      const exhaustive: never = errorClass;
      void exhaustive;
      return `NeuroNest proxy request failed${withStatus}.`;
    }
  }
}

// ─── Retry envelope construction ───────────────────────────────────────────

/**
 * Build a canonical retry envelope with `retryAfterMs` clamped to
 * [0, MAX_INTERRUPTION_RETRY_AFTER_MS]. Passing a non-retryable envelope
 * drops the delay entirely (the schema forbids `retryAfterMs` on
 * non-retryable metadata).
 */
function buildRetry(input: {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly retryContext?: ProxyOutcomeRetryContext;
}): RetryMetadataV1 {
  const clampedRetryAfter =
    input.retryable && input.retryAfterMs !== undefined
      ? clampRetryAfterMs(input.retryAfterMs)
      : undefined;
  const retry: RetryMetadataV1 = {
    retryable: input.retryable,
    ...(clampedRetryAfter !== undefined ? { retryAfterMs: clampedRetryAfter } : {}),
    ...(input.retryContext?.previousRequestId !== undefined
      ? { previousRequestId: input.retryContext.previousRequestId }
      : {}),
    ...(input.retryContext?.previousAttempt !== undefined
      ? { previousAttempt: input.retryContext.previousAttempt }
      : {}),
    ...(input.retryContext?.completionAnchorId !== undefined
      ? { completionAnchorId: input.retryContext.completionAnchorId }
      : {}),
  };
  // Parse through the canonical schema for defense in depth. This surfaces
  // any drift between the retry rules here and the schema-level refinement
  // (e.g. previousRequestId/previousAttempt paired constraint) as an
  // exception at the classifier boundary rather than at the projection.
  return RetryMetadataV1Schema.parse(retry);
}

/**
 * Clamp `retryAfterMs` to the closed interval [0, MAX_INTERRUPTION_RETRY_AFTER_MS].
 * Any non-finite value collapses to zero. The additional upper cap at
 * {@link MAX_RETRY_AFTER_MS} in the schema is never approached because our
 * ceiling is 100x smaller.
 */
function clampRetryAfterMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const floored = Math.max(0, Math.floor(value));
  return Math.min(floored, MAX_INTERRUPTION_RETRY_AFTER_MS);
}

// ─── Partial content decision ──────────────────────────────────────────────

/**
 * True when interruption after any answer/reasoning content is preferable to
 * outright failure. Follows Requirement 8.7 and 12.7: partial user-visible
 * output must be retained under interruption.
 */
function hasVisibleContent(snapshot: CommittedContentSnapshot): boolean {
  return snapshot.hasAnswerContent || snapshot.hasReasoningContent;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Classify a proxy failure into a canonical chat lifecycle terminal event.
 * Total over the closed `ProxyErrorClass` union. Never throws for well-formed
 * input; the payload is validated through the canonical Zod schema before
 * return so schema drift surfaces here rather than at the projection.
 */
export function classifyProxyOutcome(input: ProxyOutcomeInput): ProxyOutcome {
  const proxyClass = input.error.errorClass;
  const chatErrorClass = toChatErrorClass(proxyClass);
  const retryable = isRetryable(proxyClass);
  const retryAfterMs = input.error.metadata.retryAfterMs;
  const correlationId =
    input.correlationId !== undefined && input.correlationId.length > 0
      ? input.correlationId
      : input.error.metadata.correlationId;
  const errorId = input.errorId ?? randomUUID();
  const summary = redactString(summaryForProxy(proxyClass, input.error.metadata.httpStatus));

  const retry = buildRetry({
    retryable,
    retryAfterMs,
    retryContext: input.retryContext,
  });

  const preferInterruption = supportsInterruption(proxyClass) && hasVisibleContent(input.content);

  if (preferInterruption) {
    const payload: ResponseInterruptedV1 = ChatEventPayloadV1Schema.parse({
      schemaVersion: 1,
      type: 'response.interrupted',
      identity: input.identity,
      route: input.route,
      terminalState: 'interrupted',
      partialContentRetained: true,
      errorId,
      errorClass: chatErrorClass,
      summary,
      correlationId,
      retry,
    }) as ResponseInterruptedV1;
    return {
      kind: 'interrupted',
      payload,
      errorClass: chatErrorClass,
      proxyErrorClass: proxyClass,
      correlationId,
      errorId,
      retry,
      partialContentRetained: true,
    };
  }

  const partialContentRetained = hasVisibleContent(input.content);
  const payload: ResponseFailedV1 = ChatEventPayloadV1Schema.parse({
    schemaVersion: 1,
    type: 'response.failed',
    identity: input.identity,
    route: input.route,
    terminalState: 'failed',
    partialContentRetained,
    errorId,
    errorClass: chatErrorClass,
    summary,
    correlationId,
    retry,
  }) as ResponseFailedV1;
  return {
    kind: 'failed',
    payload,
    errorClass: chatErrorClass,
    proxyErrorClass: proxyClass,
    correlationId,
    errorId,
    retry,
    partialContentRetained,
  };
}

/**
 * Classify a `SessionLog.appendBatch` (or equivalent persistence) failure
 * into a canonical terminal event. When any content was already committed
 * (i.e. the failing append is not the first) the outcome is `interrupted`;
 * otherwise `failed`.
 *
 * The renderer sees `errorClass = 'persistence'` in both branches. The
 * committed portion of the log survives because the appendBatch failure is
 * atomic — either the batch is fully applied or fully rejected.
 */
export function classifyPersistenceFailure(input: PersistenceOutcomeInput): ProxyOutcome {
  const errorId = input.errorId ?? randomUUID();
  const correlationId =
    input.correlationId !== undefined && input.correlationId.length > 0
      ? input.correlationId
      : randomUUID();
  const summary = redactString(
    `NeuroNest failed to durably persist a stream event (${input.reason}); the response was interrupted.`,
  );
  const retry = buildRetry({
    retryable: true,
    retryContext: input.retryContext,
  });

  if (hasVisibleContent(input.content)) {
    const payload: ResponseInterruptedV1 = ChatEventPayloadV1Schema.parse({
      schemaVersion: 1,
      type: 'response.interrupted',
      identity: input.identity,
      route: input.route,
      terminalState: 'interrupted',
      partialContentRetained: true,
      errorId,
      errorClass: 'persistence' as const,
      summary,
      correlationId,
      retry,
    }) as ResponseInterruptedV1;
    return {
      kind: 'interrupted',
      payload,
      errorClass: 'persistence',
      proxyErrorClass: 'persistence',
      correlationId,
      errorId,
      retry,
      partialContentRetained: true,
    };
  }

  const payload: ResponseFailedV1 = ChatEventPayloadV1Schema.parse({
    schemaVersion: 1,
    type: 'response.failed',
    identity: input.identity,
    route: input.route,
    terminalState: 'failed',
    partialContentRetained: false,
    errorId,
    errorClass: 'persistence' as const,
    summary,
    correlationId,
    retry,
  }) as ResponseFailedV1;
  return {
    kind: 'failed',
    payload,
    errorClass: 'persistence',
    proxyErrorClass: 'persistence',
    correlationId,
    errorId,
    retry,
    partialContentRetained: false,
  };
}

// ─── Discriminated diagnostic record ───────────────────────────────────────

/**
 * Allowlisted diagnostic snapshot suitable for log/telemetry export. Every
 * field is a bounded identifier, an enum, a status code, or a bounded
 * numeric bound. Never includes prompt/response content, tool payloads,
 * reasoning text, credential values, or file paths.
 */
export interface ProxyOutcomeDiagnosticRecord {
  readonly outcome: 'interrupted' | 'failed';
  readonly errorClass: ChatStreamErrorClassV1;
  readonly proxyErrorClass: OutcomeProxyErrorClass;
  readonly correlationId: string;
  readonly errorId: string;
  readonly partialContentRetained: boolean;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
  readonly provider: string;
  readonly model: string;
  readonly edition: string;
  readonly transportClass: string;
}

/** Extract a redacted diagnostic record from a classified proxy outcome. */
export function toProxyOutcomeDiagnostic(
  outcome: ProxyOutcome,
  input: ProxyOutcomeInput | PersistenceOutcomeInput,
  httpStatus?: number,
): ProxyOutcomeDiagnosticRecord {
  const retryAfterMs =
    outcome.retry.retryAfterMs !== undefined ? outcome.retry.retryAfterMs : undefined;
  return {
    outcome: outcome.kind,
    errorClass: outcome.errorClass,
    proxyErrorClass: outcome.proxyErrorClass,
    correlationId: outcome.correlationId,
    errorId: outcome.errorId,
    partialContentRetained: outcome.partialContentRetained,
    retryable: outcome.retry.retryable,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    provider: input.route.provider,
    model: input.route.model,
    edition: input.route.edition,
    transportClass: input.route.transportClass,
  };
}

// ─── Compile-time exhaustiveness check ─────────────────────────────────────

/**
 * Adding a new `ProxyErrorClass` value without updating every switch above
 * causes this reference to fail to compile. Never executed.
 */
function _assertExhaustiveProxyClass(): void {
  const values: readonly ProxyErrorClass[] = [
    'proxy_authentication',
    'proxy_entitlement',
    'proxy_quota',
    'proxy_network',
    'proxy_stream',
    'proxy_upstream',
    'proxy_transport_mismatch',
  ];
  for (const v of values) {
    void supportsInterruption(v);
    void isRetryable(v);
    void toChatErrorClass(v);
    void summaryForProxy(v, undefined);
  }
}
void _assertExhaustiveProxyClass;

// ─── Convenience helper for typed transport failure attribution ────────────

/**
 * Build a lightweight `ProxyOutcomeInput` from a classified proxy error plus
 * the response identity/route. Callers that already have the classified
 * error attached to a `LLMProxyTransportError` (which is the common case)
 * use this to avoid repeating the field spread at every failure site.
 */
export function buildProxyOutcomeInput(input: {
  readonly identity: ChatResponseIdentityV1;
  readonly route: ChatEventRouteV1;
  readonly error: ClassifiedProxyError;
  readonly content: CommittedContentSnapshot;
  readonly retryContext?: ProxyOutcomeRetryContext;
  readonly errorId?: string;
  readonly correlationId?: string;
}): ProxyOutcomeInput {
  return input;
}

// Re-export types callers commonly need.
export type { ChatStreamErrorClassV1, ProxyErrorClass };

/**
 * Re-export the canonical schema for callers that want to double-parse a
 * payload built by this module before appending it durably.
 */
export function isTerminalPayload(payload: unknown): payload is ChatEventPayloadV1 {
  const parsed = ChatEventPayloadV1Schema.safeParse(payload);
  if (!parsed.success) return false;
  return (
    parsed.data.type === 'response.completed' ||
    parsed.data.type === 'response.stopped' ||
    parsed.data.type === 'response.interrupted' ||
    parsed.data.type === 'response.failed'
  );
}
