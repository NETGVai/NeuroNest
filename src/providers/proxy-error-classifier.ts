/**
 * Proxy error classification with redacted observability.
 *
 * Maps every failure mode of the NeuroNest proxy transport to a typed
 * discriminated union. Each classified error carries only non-secret
 * metadata (correlation identifier, logical provider/model, edition,
 * invocation source, request type, HTTP status, bounded retry delay) so
 * downstream code can decide how to fail closed, whether to offer a retry,
 * and how to attribute diagnostics — without ever forwarding prompt or
 * response content, credential material, tool payloads, or user paths.
 *
 * Design invariants (Requirements 6.6, 8.4–8.9, 15.10):
 *
 *  - The seven `ProxyErrorClass` values form a closed union. Adding a new
 *    value requires updating every mapping table and switch below, which
 *    fails to compile silently until it is done.
 *  - `retryAfterMs` is clamped to the closed interval [0, 600_000] before
 *    it leaves this module. The proxy contract permits up to 24 hours, but
 *    client policy for chat interruptions caps the retry offer at ten
 *    minutes to keep the renderer responsive and to bound stalled routes.
 *  - No branch of the classifier consults, produces, or preserves prompt
 *    text, response text, reasoning, tool payloads, credential values,
 *    resolved authorization headers, or private file paths. `summary`
 *    strings are constructed here from allowlisted templates and are then
 *    passed through {@link redactString} for defense in depth against a
 *    caller-supplied message that carries user content.
 *  - The classifier is total over its `ProxyFailureInput` union. Every
 *    input produces exactly one `ClassifiedProxyError` and every branch
 *    is exercised by `proxy-error-classifier.test.ts`.
 *  - The classifier is pure — it never issues network I/O, never touches
 *    the credential boundary, and never rewrites route metadata. Because
 *    it can never select a transport, an error path handled by this
 *    module cannot fall back to a public provider endpoint.
 */

import { randomUUID } from 'node:crypto';

import type { AppEdition } from '../shared/app-bootstrap-contracts.js';
import {
  MAX_PROXY_RETRY_AFTER_MS,
  ProxyErrorV1Schema,
  type ProxyErrorCodeV1,
  type ProxyErrorV1,
} from '../provider-routing/proxy-contracts.js';
import type { InferenceInvocationSource } from '../provider-routing/types.js';
import {
  redactForDiagnostic,
  redactForLog,
  redactForTelemetry,
  redactString,
} from '../shared/observable-redaction.js';

// ─── Closed classification union ────────────────────────────────────────────

/**
 * Closed set of typed error classes. Every proxy failure resolves to
 * exactly one of these values.
 *
 *  - `proxy_authentication` covers 401 responses and 403 responses whose
 *    parsed body identifies an authentication failure. The renderer must
 *    surface a re-authentication action; retry is not offered.
 *  - `proxy_entitlement` covers 403 responses whose parsed body identifies
 *    an entitlement failure and 402 responses (payment required / quota
 *    depleted). Retry is not offered until the caller resolves the
 *    entitlement condition or refreshes credits.
 *  - `proxy_quota` covers 429 responses (rate limits) and quota exhaustion
 *    reported through the proxy error code channel. The renderer offers a
 *    delayed retry using the clamped `retryAfterMs` value.
 *  - `proxy_network` covers transport-level failures (fetch rejection,
 *    connection reset, timeout, aborted request, DNS failure). Retry is
 *    permitted through the coordinated route path only.
 *  - `proxy_stream` covers mid-stream failures (SSE parse errors, aborted
 *    streams, malformed frames, unexpected end-of-stream). Retry is
 *    permitted through the coordinated route path only.
 *  - `proxy_upstream` covers 5xx responses from the proxy or an upstream
 *    provider surfaced by the proxy. Retry is permitted but must go through
 *    the same coordinator (no direct-provider fallback).
 *  - `proxy_transport_mismatch` is an internal invariant violation — the
 *    coordinator asked for a cloud transport but classification refused,
 *    or a caller attempted to reach a non-proxy origin. This class is
 *    unrecoverable and never retryable.
 */
export type ProxyErrorClass =
  | 'proxy_authentication'
  | 'proxy_entitlement'
  | 'proxy_quota'
  | 'proxy_network'
  | 'proxy_stream'
  | 'proxy_upstream'
  | 'proxy_transport_mismatch';

/**
 * Non-secret metadata carried on every classified error. Every field is
 * either a validated identifier or a numeric status; none of them may
 * carry credential material, prompt or response content, reasoning,
 * tool payloads, or user file paths.
 */
export interface ProxyErrorMetadata {
  /** Correlation identifier attached to the request/response pair. */
  readonly correlationId: string;
  /** Logical provider identifier chosen by capability routing. */
  readonly provider: string;
  /** Logical model identifier chosen by capability routing. */
  readonly model: string;
  /** Active commercial edition at the time of the failure. */
  readonly edition: AppEdition;
  /** Caller category that initiated the inference request. */
  readonly invocationSource: InferenceInvocationSource;
  /** Whether the failing request expected an incremental stream. */
  readonly requestType: 'streaming' | 'non-streaming';
  /**
   * HTTP status code when the failure was surfaced by a proxy response.
   * Absent for network-level and stream-level failures that never received
   * a status line.
   */
  readonly httpStatus?: number;
  /**
   * Retry delay in milliseconds, clamped to
   * [0, {@link MAX_PROXY_ERROR_RETRY_AFTER_MS}]. Absent when the failure
   * did not carry a retry hint.
   */
  readonly retryAfterMs?: number;
}

interface BaseClassifiedError {
  /** Non-secret allowlisted summary safe for renderer display. */
  readonly summary: string;
  readonly metadata: ProxyErrorMetadata;
  /** Whether callers may retry through the coordinated route path. */
  readonly retryable: boolean;
}

export interface ProxyAuthenticationClassifiedError extends BaseClassifiedError {
  readonly errorClass: 'proxy_authentication';
  readonly retryable: false;
}

export interface ProxyEntitlementClassifiedError extends BaseClassifiedError {
  readonly errorClass: 'proxy_entitlement';
  readonly retryable: false;
}

export interface ProxyQuotaClassifiedError extends BaseClassifiedError {
  readonly errorClass: 'proxy_quota';
  readonly retryable: true;
}

export interface ProxyNetworkClassifiedError extends BaseClassifiedError {
  readonly errorClass: 'proxy_network';
  readonly retryable: true;
}

export interface ProxyStreamClassifiedError extends BaseClassifiedError {
  readonly errorClass: 'proxy_stream';
  readonly retryable: true;
}

export interface ProxyUpstreamClassifiedError extends BaseClassifiedError {
  readonly errorClass: 'proxy_upstream';
  readonly retryable: true;
}

export interface ProxyTransportMismatchClassifiedError extends BaseClassifiedError {
  readonly errorClass: 'proxy_transport_mismatch';
  readonly retryable: false;
}

export type ClassifiedProxyError =
  | ProxyAuthenticationClassifiedError
  | ProxyEntitlementClassifiedError
  | ProxyQuotaClassifiedError
  | ProxyNetworkClassifiedError
  | ProxyStreamClassifiedError
  | ProxyUpstreamClassifiedError
  | ProxyTransportMismatchClassifiedError;

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Upper bound (10 minutes) that the classifier enforces on any retry delay
 * before it reaches downstream retry policy. The proxy contract permits up
 * to {@link MAX_PROXY_RETRY_AFTER_MS} but the renderer/UX policy for a
 * single request must not stall longer than this bound.
 */
export const MAX_PROXY_ERROR_RETRY_AFTER_MS = 600_000;

/**
 * Case-insensitive HTTP header name used by the proxy to correlate a
 * response with its request when a body-level `correlationId` is not
 * available or when the body could not be parsed.
 */
export const PROXY_CORRELATION_HEADER = 'x-correlation-id';

// ─── Failure input contract ─────────────────────────────────────────────────

/**
 * A minimal headers view. Accepts the standard `Headers` shape (case-
 * insensitive `.get()`) or a plain `Record<string,string>`. The classifier
 * only reads two headers: `x-correlation-id` and `retry-after`.
 */
export type HeadersLike =
  | Headers
  | Readonly<Record<string, string | undefined>>
  | undefined;

/**
 * Context required to classify any proxy failure. Callers derive these
 * fields from the same route metadata that seeded the request, so
 * classification never invents attribution.
 */
export interface ProxyErrorRequestContext {
  readonly provider: string;
  readonly model: string;
  readonly edition: AppEdition;
  readonly invocationSource: InferenceInvocationSource;
  readonly requestType: 'streaming' | 'non-streaming';
  /**
   * Fallback correlation identifier when the proxy response body and
   * headers do not carry one. Callers typically pass the same identifier
   * they attached to `response.started` for the durable event log.
   */
  readonly fallbackCorrelationId?: string;
}

/** HTTP failure: the proxy returned a non-2xx status line. */
export interface ProxyHttpFailureInput {
  readonly kind: 'http';
  readonly httpStatus: number;
  readonly headers?: HeadersLike;
  /**
   * Best-effort parse of the proxy body. May be `undefined` when the body
   * was empty or could not be parsed. The classifier consumes only the
   * `code`, `status`, `retryAfterMs`, and `correlationId` fields — never
   * the free-form `message`.
   */
  readonly proxyErrorBody?: unknown;
  /** Optional underlying cause for diagnostics; never surfaced verbatim. */
  readonly cause?: unknown;
}

/** Network-level failure surfaced by the fetch implementation. */
export interface ProxyNetworkFailureInput {
  readonly kind: 'network';
  readonly cause?: unknown;
  /** Optional headers if the transport captured any before the failure. */
  readonly headers?: HeadersLike;
}

/** Mid-stream failure surfaced by the stream decoder. */
export interface ProxyStreamFailureInput {
  readonly kind: 'stream';
  /** HTTP status of the stream response, if known. */
  readonly httpStatus?: number;
  readonly headers?: HeadersLike;
  readonly cause?: unknown;
  /**
   * The wire-level summary provided by the stream decoder. Passed through
   * {@link redactString} before it becomes a renderer-visible summary.
   */
  readonly decodeSummary?: string;
}

/**
 * Transport mismatch failure surfaced by the coordinator or transport
 * when a caller reached this classifier without a validated proxy
 * transport. Unrecoverable.
 */
export interface ProxyTransportMismatchFailureInput {
  readonly kind: 'transport-mismatch';
  readonly cause?: unknown;
  /** Optional allowlisted reason, e.g. `'unclassified-transport'`. */
  readonly reason?: string;
}

export type ProxyFailureInput =
  | ProxyHttpFailureInput
  | ProxyNetworkFailureInput
  | ProxyStreamFailureInput
  | ProxyTransportMismatchFailureInput;

// ─── Public classifier surface ──────────────────────────────────────────────

/**
 * Classify a proxy failure into the canonical typed union. Total over the
 * `ProxyFailureInput` union. Never throws. Never returns a leaked value.
 */
export function classifyProxyError(
  input: ProxyFailureInput,
  context: ProxyErrorRequestContext,
): ClassifiedProxyError {
  switch (input.kind) {
    case 'http':
      return classifyHttpFailure(input, context);
    case 'network':
      return classifyNetworkFailure(input, context);
    case 'stream':
      return classifyStreamFailure(input, context);
    case 'transport-mismatch':
      return classifyTransportMismatchFailure(input, context);
    default: {
      // Defense in depth: a future variant added to `ProxyFailureInput`
      // without a corresponding branch here must not silently be treated
      // as a network failure. We refuse to attribute a transport at all.
      const exhaustive: never = input;
      void exhaustive;
      return buildClassifiedError({
        errorClass: 'proxy_transport_mismatch',
        retryable: false,
        summary: 'The proxy failure could not be classified.',
        context,
        httpStatus: undefined,
        retryAfterMs: undefined,
        correlationId: undefined,
      });
    }
  }
}

// ─── HTTP failure ───────────────────────────────────────────────────────────

/**
 * Map a proxy `code` from the parsed body to a `ProxyErrorClass`. Absent
 * body codes are handled by status-only classification.
 */
function classifyProxyBodyCode(
  code: ProxyErrorCodeV1,
): ProxyErrorClass | undefined {
  switch (code) {
    case 'authentication':
      return 'proxy_authentication';
    case 'entitlement':
      return 'proxy_entitlement';
    case 'quota':
    case 'rate_limit':
      return 'proxy_quota';
    case 'network':
      return 'proxy_network';
    case 'stream':
      return 'proxy_stream';
    case 'upstream':
      return 'proxy_upstream';
    case 'invalid_request':
      // 400 / 422 / 415 — treated as an upstream failure so retry policy
      // routes through the coordinator (which will fail closed on repeat).
      // We deliberately do not classify this as network or stream.
      return 'proxy_upstream';
    case 'internal':
      // Proxy-internal defects surface as upstream failures to the renderer
      // since they are not a client-fixable authentication or entitlement
      // problem, and they are not caused by the local network.
      return 'proxy_upstream';
    default: {
      const exhaustive: never = code;
      void exhaustive;
      return undefined;
    }
  }
}

function classifyByStatus(status: number): ProxyErrorClass {
  if (status === 401) return 'proxy_authentication';
  if (status === 402) return 'proxy_entitlement';
  if (status === 403) return 'proxy_authentication';
  if (status === 429) return 'proxy_quota';
  if (status >= 500 && status <= 599) return 'proxy_upstream';
  // 4xx that is not one of the above (400, 404, 422, ...) is treated as an
  // upstream request-shape defect. We never classify these as network so
  // retry policy stays with the coordinator.
  if (status >= 400 && status <= 499) return 'proxy_upstream';
  // Anything else (unusual 1xx/3xx that reached this branch): refuse to
  // route further.
  return 'proxy_transport_mismatch';
}

function classifyHttpFailure(
  input: ProxyHttpFailureInput,
  context: ProxyErrorRequestContext,
): ClassifiedProxyError {
  const parsedBody = parseProxyBody(input.proxyErrorBody);
  const bodyClass = parsedBody
    ? classifyProxyBodyCode(parsedBody.code)
    : undefined;
  const statusClass = classifyByStatus(input.httpStatus);

  // Body classification takes precedence when it is a stricter refinement
  // of the status-only class. Specifically:
  //   - 403 with body code `entitlement` becomes `proxy_entitlement`
  //     (renderer offers different recovery action than authentication).
  //   - 402 with body code `quota` becomes `proxy_quota` because the
  //     server signaled a rate-limit-style delay rather than a permanent
  //     credit exhaustion (still not retryable without action, but the
  //     retryAfter hint applies).
  //   - Otherwise, we prefer the status-derived class so a hostile body
  //     cannot downgrade a 5xx to `proxy_entitlement`.
  const preferredClass = decidePreferredClass(statusClass, bodyClass);

  // Extract retry delay only when the class supports it (proxy_quota).
  // Even if the body advertises retryAfterMs elsewhere, it is dropped so
  // downstream policy cannot honor an unauthorized delay hint.
  const retryAfterMs =
    preferredClass === 'proxy_quota'
      ? extractRetryAfterMs(parsedBody, input.headers)
      : undefined;

  const summary = buildHttpSummary(preferredClass, input.httpStatus);
  return buildClassifiedError({
    errorClass: preferredClass,
    retryable: isRetryable(preferredClass),
    summary,
    context,
    httpStatus: input.httpStatus,
    retryAfterMs,
    correlationId: extractCorrelationId(parsedBody, input.headers, context),
  });
}

function decidePreferredClass(
  statusClass: ProxyErrorClass,
  bodyClass: ProxyErrorClass | undefined,
): ProxyErrorClass {
  if (bodyClass === undefined) return statusClass;
  // Only permit body to REFINE a status-derived class within a safe
  // family. Otherwise defer to the status classifier.
  if (statusClass === 'proxy_authentication' && bodyClass === 'proxy_entitlement') {
    return bodyClass;
  }
  if (statusClass === 'proxy_entitlement' && bodyClass === 'proxy_authentication') {
    return bodyClass;
  }
  if (statusClass === 'proxy_entitlement' && bodyClass === 'proxy_quota') {
    return bodyClass;
  }
  if (statusClass === 'proxy_quota' && bodyClass === 'proxy_entitlement') {
    return bodyClass;
  }
  if (statusClass === 'proxy_upstream' && bodyClass === 'proxy_upstream') {
    return bodyClass;
  }
  if (statusClass === bodyClass) return bodyClass;
  // Body wanted a class outside the safe family — trust the status line.
  return statusClass;
}

function buildHttpSummary(
  errorClass: ProxyErrorClass,
  status: number,
): string {
  switch (errorClass) {
    case 'proxy_authentication':
      return `NeuroNest proxy rejected the request with an authentication failure (HTTP ${status}).`;
    case 'proxy_entitlement':
      return `NeuroNest proxy rejected the request with an entitlement failure (HTTP ${status}).`;
    case 'proxy_quota':
      return `NeuroNest proxy rate-limited the request (HTTP ${status}).`;
    case 'proxy_network':
      return `NeuroNest proxy reported a transport-level failure (HTTP ${status}).`;
    case 'proxy_stream':
      return `NeuroNest proxy stream failed (HTTP ${status}).`;
    case 'proxy_upstream':
      return `NeuroNest proxy reported an upstream failure (HTTP ${status}).`;
    case 'proxy_transport_mismatch':
      return `NeuroNest proxy returned an unrecognized status (HTTP ${status}).`;
    default: {
      const exhaustive: never = errorClass;
      void exhaustive;
      return `NeuroNest proxy request failed (HTTP ${status}).`;
    }
  }
}

// ─── Network failure ────────────────────────────────────────────────────────

function classifyNetworkFailure(
  input: ProxyNetworkFailureInput,
  context: ProxyErrorRequestContext,
): ClassifiedProxyError {
  return buildClassifiedError({
    errorClass: 'proxy_network',
    retryable: true,
    summary: 'The NeuroNest proxy request failed at the transport layer.',
    context,
    httpStatus: undefined,
    retryAfterMs: undefined,
    correlationId: extractCorrelationId(undefined, input.headers, context),
  });
}

// ─── Stream failure ─────────────────────────────────────────────────────────

function classifyStreamFailure(
  input: ProxyStreamFailureInput,
  context: ProxyErrorRequestContext,
): ClassifiedProxyError {
  // A stream failure with a 5xx status is still classified as a stream
  // failure — the renderer's stream-gap recovery path is more useful to
  // the user than an upstream retry hint.
  return buildClassifiedError({
    errorClass: 'proxy_stream',
    retryable: true,
    summary: input.decodeSummary
      ? redactString(input.decodeSummary)
      : 'The NeuroNest proxy stream ended before delivering a complete response.',
    context,
    httpStatus: input.httpStatus,
    retryAfterMs: undefined,
    correlationId: extractCorrelationId(undefined, input.headers, context),
  });
}

// ─── Transport mismatch ─────────────────────────────────────────────────────

function classifyTransportMismatchFailure(
  input: ProxyTransportMismatchFailureInput,
  context: ProxyErrorRequestContext,
): ClassifiedProxyError {
  const reason = input.reason ?? 'unclassified-transport';
  return buildClassifiedError({
    errorClass: 'proxy_transport_mismatch',
    retryable: false,
    summary: `NeuroNest proxy transport classification refused the request (${reason}).`,
    context,
    httpStatus: undefined,
    retryAfterMs: undefined,
    correlationId: extractCorrelationId(undefined, undefined, context),
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseProxyBody(body: unknown): ProxyErrorV1 | undefined {
  if (body === undefined || body === null) return undefined;
  const parsed = ProxyErrorV1Schema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

function headerValue(headers: HeadersLike, name: string): string | undefined {
  if (!headers) return undefined;
  const canonical = name.toLowerCase();
  if (typeof (headers as Headers).get === 'function') {
    const value = (headers as Headers).get(canonical);
    return value === null ? undefined : value;
  }
  const record = headers as Readonly<Record<string, string | undefined>>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === canonical) {
      const value = record[key];
      return value === undefined ? undefined : String(value);
    }
  }
  return undefined;
}

/**
 * Extract a correlation identifier from the parsed body, then the response
 * headers, then the caller-supplied fallback, then a freshly generated
 * value. The identifier is always a string; it never contains user data.
 */
function extractCorrelationId(
  body: ProxyErrorV1 | undefined,
  headers: HeadersLike,
  context: ProxyErrorRequestContext,
): string {
  if (body?.correlationId) return body.correlationId;
  const header = headerValue(headers, PROXY_CORRELATION_HEADER);
  if (header && header.length > 0) return header;
  if (
    context.fallbackCorrelationId !== undefined &&
    context.fallbackCorrelationId.length > 0
  ) {
    return context.fallbackCorrelationId;
  }
  return randomUUID();
}

function clampRetryAfterMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const floored = Math.max(0, Math.floor(value));
  return Math.min(floored, MAX_PROXY_ERROR_RETRY_AFTER_MS);
}

/**
 * Extract retryAfterMs from the proxy body first, then from the standard
 * HTTP `Retry-After` header (numeric seconds or HTTP-date). Clamped to
 * [0, MAX_PROXY_ERROR_RETRY_AFTER_MS] regardless of source.
 */
function extractRetryAfterMs(
  body: ProxyErrorV1 | undefined,
  headers: HeadersLike,
): number | undefined {
  if (body?.retryAfterMs !== undefined) {
    return clampRetryAfterMs(body.retryAfterMs);
  }
  const raw = headerValue(headers, 'retry-after');
  if (raw === undefined) return undefined;
  const numeric = Number.parseInt(raw.trim(), 10);
  if (Number.isFinite(numeric) && String(numeric) === raw.trim()) {
    // Retry-After header uses seconds; convert to milliseconds.
    return clampRetryAfterMs(numeric * 1000);
  }
  const httpDateMs = Date.parse(raw);
  if (Number.isFinite(httpDateMs)) {
    const deltaMs = httpDateMs - Date.now();
    return clampRetryAfterMs(deltaMs);
  }
  return undefined;
}

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

/** Assemble a classified error with all summary and metadata scrubbed. */
function buildClassifiedError(input: {
  readonly errorClass: ProxyErrorClass;
  readonly retryable: boolean;
  readonly summary: string;
  readonly context: ProxyErrorRequestContext;
  readonly httpStatus: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly correlationId: string | undefined;
}): ClassifiedProxyError {
  const metadata: ProxyErrorMetadata = {
    correlationId:
      input.correlationId !== undefined && input.correlationId.length > 0
        ? input.correlationId
        : randomUUID(),
    provider: input.context.provider,
    model: input.context.model,
    edition: input.context.edition,
    invocationSource: input.context.invocationSource,
    requestType: input.context.requestType,
    ...(input.httpStatus !== undefined ? { httpStatus: input.httpStatus } : {}),
    ...(input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
  };
  const safeSummary = redactString(input.summary);
  return buildTyped(input.errorClass, safeSummary, metadata, input.retryable);
}

/**
 * Small helper that keeps TypeScript's narrowing aligned with the closed
 * union so each variant satisfies its `retryable` literal constraint.
 */
function buildTyped(
  errorClass: ProxyErrorClass,
  summary: string,
  metadata: ProxyErrorMetadata,
  retryable: boolean,
): ClassifiedProxyError {
  switch (errorClass) {
    case 'proxy_authentication':
      return { errorClass, summary, metadata, retryable: false };
    case 'proxy_entitlement':
      return { errorClass, summary, metadata, retryable: false };
    case 'proxy_quota':
      return { errorClass, summary, metadata, retryable: true };
    case 'proxy_network':
      return { errorClass, summary, metadata, retryable: true };
    case 'proxy_stream':
      return { errorClass, summary, metadata, retryable: true };
    case 'proxy_upstream':
      return { errorClass, summary, metadata, retryable: true };
    case 'proxy_transport_mismatch':
      return { errorClass, summary, metadata, retryable: false };
    default: {
      const exhaustive: never = errorClass;
      void exhaustive;
      // Unreachable — every case above returns. Keep the compiler happy.
      void retryable;
      return {
        errorClass: 'proxy_transport_mismatch',
        summary,
        metadata,
        retryable: false,
      };
    }
  }
}

// ─── Observability adapters ─────────────────────────────────────────────────

/**
 * Snapshot of a classified error that carries only allowlisted, non-secret
 * fields. Every string has been passed through {@link redactString}; the
 * outer object has additionally been scrubbed by
 * {@link redactForDiagnostic} to catch any escaped canary the caller might
 * have attached to metadata.
 */
export interface ProxyErrorDiagnosticRecord {
  readonly errorClass: ProxyErrorClass;
  readonly summary: string;
  readonly retryable: boolean;
  readonly correlationId: string;
  readonly provider: string;
  readonly model: string;
  readonly edition: AppEdition;
  readonly invocationSource: InferenceInvocationSource;
  readonly requestType: 'streaming' | 'non-streaming';
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
}

// ─── Coordinator/preflight classification ───────────────────────────────────

/**
 * Deterministic mapping from `InferenceRouteCoordinator` failure codes to
 * proxy error classes. Exposed so `CoordinatedInferenceClient` and preflight
 * services can attach a uniform classified error to every failure they
 * surface, keeping the renderer's typed handling one code path.
 *
 * The mapping is:
 *   - `proxy-credential-unavailable` → `proxy_authentication`
 *   - `entitlement-rejected`         → `proxy_entitlement`
 *   - `unregistered-provider`        → `proxy_transport_mismatch`
 *   - `cloud-fallback-transport-mismatch` → `proxy_transport_mismatch`
 *   - `no-provider-available`        → `proxy_transport_mismatch`
 *     (nothing was routable, so the classified surface refuses transport)
 *
 * Note: `no-provider-available` on its own is treated as a validation
 * condition by `PreflightResponseStartService`. This mapping preserves that
 * behavior by making the classified surface an unrecoverable transport
 * mismatch — the caller cannot ask the classifier to attempt any transport
 * because there is nothing to route to.
 */
export type CoordinatorFailureCodeInput =
  | 'no-provider-available'
  | 'proxy-credential-unavailable'
  | 'entitlement-rejected'
  | 'unregistered-provider'
  | 'cloud-fallback-transport-mismatch';

export function classifyCoordinatorFailure(
  failureCode: CoordinatorFailureCodeInput,
  context: ProxyErrorRequestContext,
): ClassifiedProxyError {
  switch (failureCode) {
    case 'proxy-credential-unavailable':
      return buildClassifiedError({
        errorClass: 'proxy_authentication',
        retryable: false,
        summary:
          'NeuroNest cloud access is unavailable — the proxy credential is missing or invalid.',
        context,
        httpStatus: undefined,
        retryAfterMs: undefined,
        correlationId: undefined,
      });
    case 'entitlement-rejected':
      return buildClassifiedError({
        errorClass: 'proxy_entitlement',
        retryable: false,
        summary:
          'The active edition does not entitle this provider or model. Update your entitlements and retry.',
        context,
        httpStatus: undefined,
        retryAfterMs: undefined,
        correlationId: undefined,
      });
    case 'unregistered-provider':
    case 'cloud-fallback-transport-mismatch':
    case 'no-provider-available':
      return buildClassifiedError({
        errorClass: 'proxy_transport_mismatch',
        retryable: false,
        summary:
          'The route coordinator refused to classify a transport for this request; no direct-provider fallback is permitted.',
        context,
        httpStatus: undefined,
        retryAfterMs: undefined,
        correlationId: undefined,
      });
    default: {
      const exhaustive: never = failureCode;
      void exhaustive;
      return buildClassifiedError({
        errorClass: 'proxy_transport_mismatch',
        retryable: false,
        summary:
          'The route coordinator returned an unrecognized failure; refusing to route.',
        context,
        httpStatus: undefined,
        retryAfterMs: undefined,
        correlationId: undefined,
      });
    }
  }
}

/** Produce a redacted diagnostic record from a classified error. */
export function toProxyErrorDiagnosticRecord(
  error: ClassifiedProxyError,
): ProxyErrorDiagnosticRecord {
  const record: ProxyErrorDiagnosticRecord = {
    errorClass: error.errorClass,
    summary: redactString(error.summary),
    retryable: error.retryable,
    correlationId: error.metadata.correlationId,
    provider: error.metadata.provider,
    model: error.metadata.model,
    edition: error.metadata.edition,
    invocationSource: error.metadata.invocationSource,
    requestType: error.metadata.requestType,
    ...(error.metadata.httpStatus !== undefined
      ? { httpStatus: error.metadata.httpStatus }
      : {}),
    ...(error.metadata.retryAfterMs !== undefined
      ? { retryAfterMs: error.metadata.retryAfterMs }
      : {}),
  };
  return redactForDiagnostic(record);
}

/** Produce a redacted log record from a classified error. */
export function toProxyErrorLogRecord(
  error: ClassifiedProxyError,
): ProxyErrorDiagnosticRecord {
  return redactForLog(toProxyErrorDiagnosticRecord(error));
}

/**
 * Produce a redacted telemetry payload from a classified error. Telemetry
 * events are aggregated and therefore must never carry credential material
 * or user content.
 */
export function toProxyErrorTelemetryRecord(
  error: ClassifiedProxyError,
): ProxyErrorDiagnosticRecord {
  const record = toProxyErrorDiagnosticRecord(error);
  return {
    ...record,
    summary: redactForTelemetry(record.summary),
  };
}
