/**
 * Provider/Proxy route contracts — `ProviderRoute@1`, typed Auth Broker
 * principals, model/channel validation, and the typed failure taxonomy for the
 * governed provider path (FUT-PKG-06-EXECUTION/T-007).
 *
 * A provider request is a governed, cost-bearing tool path (D-11): before any
 * upstream byte is forwarded a route must be validated, an entitlement/plan
 * must permit it, a budget reservation must commit, and — only for a
 * non-local route — a proxy credential principal must be established through
 * ONE explicit versioned Auth Broker (NN-PROXY-001). This module owns only the
 * *shapes* and the *pure validators*; the effectful orchestration lives in
 * {@link ./provider-route-service}, streaming in {@link ./streaming}, and
 * pricing/credits in {@link ./billing}.
 *
 * ## `ProviderRoute@1` (D-10 ProviderRegistry, NN-PROXY-006/007)
 *
 * A route is either `local` (a directly-usable on-device provider) or `proxy`
 * (an approved non-local provider reached through `https://llm.neuronest.cc/v1`,
 * NN-PROXY-006). A route declares its provider, the models/channels it supports
 * with capability metadata, its trust level, and the pricing revision it was
 * priced against. Validation is deterministic and typed: an unsupported model,
 * an unknown/unhealthy channel, a missing upstream key reference, or a stale
 * pricing revision each yields a distinct typed failure with NO forbidden
 * forward, NO deduction, and NO fallback to a less-trusted route
 * (NN-PROXY-007/009/010, NN-ORCH-010).
 *
 * ## Typed Auth Broker (NN-PROXY-001/003)
 *
 * The broker parses ONE auth scheme, validates the typed issuer/audience, and
 * returns a typed principal. There is no "try one regex then another" fallback:
 * an `NN_`-shaped bearer is a proxy credential; a JWT is valid only for its
 * separately audienced session contract and is NEVER inferred merely because a
 * bearer does not match `NN_` (NN-PROXY-003). `LK-` acceptance is disabled by
 * default (NN-PROXY-004) and not implemented here.
 *
 * Design anchors: D-05, D-10, D-11, D-16, D-18, D-19.
 * Requirements: NN-PROXY-001, NN-PROXY-003, NN-PROXY-006, NN-PROXY-007,
 * NN-PROXY-009, NN-PROXY-010, NN-PROXY-014, NN-LICENSE-006, NN-CHAT-004,
 * NN-ORCH-010, NN-OBS-003.
 */

import {
  computeDigest,
  isOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
  type RedactionClass,
} from '../shared/contract-primitives';
import { isCurrencyCode, isScale, type Money } from '../shared/decimal-money';

/** The authority id stamped on provider receipts/events and error envelopes. */
export const PROVIDER_AUTHORITY = 'authority-provider-proxy';

// ─── Route locality and trust (NN-PROXY-006, NN-ORCH-010) ────────────────────

/**
 * Where a route runs. `local` providers remain directly usable regardless of
 * proxy auth (NN-PROXY-006); `proxy` routes forward through the professional
 * proxy edge and require a validated proxy principal.
 */
export type RouteLocality = 'local' | 'proxy';

/**
 * Trust ordinal. Fallback and route selection are trust-monotonic: source
 * context never moves silently to a less-trusted provider (NN-ORCH-010). Higher
 * is more trusted.
 */
export const TRUST_ORDER = Object.freeze({
  untrusted: 0,
  community: 1,
  standard: 2,
  professional: 3,
} as const);

export type TrustLevel = keyof typeof TRUST_ORDER;

/** Whether `candidate` is at least as trusted as `floor`. */
export function trustAtLeast(candidate: TrustLevel, floor: TrustLevel): boolean {
  return TRUST_ORDER[candidate] >= TRUST_ORDER[floor];
}

// ─── Channel + model capability metadata (NN-PROXY-007) ──────────────────────

/** Channel health as observed by the registry (NN-PROXY-007, NN-OBS-005). */
export type ChannelHealth = 'healthy' | 'degraded' | 'unavailable';

/**
 * A capability-checked channel binding for a route. Channels carry
 * priority/weight/health for failover selection (NN-PROXY-007). A channel that
 * is not `healthy` is not eligible to forward.
 */
export interface RouteChannel {
  readonly channelId: string;
  readonly priority: number;
  readonly weight: number;
  readonly health: ChannelHealth;
  /** Whether this channel supports incremental streaming (NN-PROXY-011). */
  readonly supportsStreaming: boolean;
}

/** A model the route supports, with the capabilities validation depends on. */
export interface RouteModel {
  readonly modelId: string;
  readonly supportsStreaming: boolean;
  /** Whether the model requires a paid plan (NN-PROXY-010). */
  readonly paidOnly: boolean;
}

// ─── ProviderRoute@1 (D-10) ──────────────────────────────────────────────────

/**
 * `ProviderRoute@1`. A schema-versioned route record owned by the provider
 * authority. `upstreamCredentialRefId` is a REFERENCE only for proxy routes —
 * the raw upstream secret is never stored here and is resolved late at the
 * forward boundary (D-16.6). Local routes carry no upstream credential.
 */
export interface ProviderRoute {
  readonly schemaVersion: 1;
  readonly routeId: string;
  readonly locality: RouteLocality;
  readonly providerId: string;
  readonly trust: TrustLevel;
  readonly models: readonly RouteModel[];
  readonly channels: readonly RouteChannel[];
  /** Pricing revision this route is priced against (NN-OBS-003). */
  readonly pricingVersion: string;
  /**
   * Reference to the envelope-encrypted upstream provider secret for a proxy
   * route (NN-PROXY-008). Absent for a local route. Never a raw secret.
   */
  readonly upstreamCredentialRefId?: string;
  /** Audience the upstream credential must be resolved for. */
  readonly upstreamAudience?: string;
  /** Scope the upstream credential must authorize. */
  readonly upstreamScope?: string;
}

/**
 * Non-stream and stream timeouts in milliseconds (NN-PROXY-011: 120s / 300s).
 */
export const NON_STREAM_TIMEOUT_MS = 120_000;
export const STREAM_TIMEOUT_MS = 300_000;

/** Default bounded retry budget for a route attempt (D-18). */
export const DEFAULT_MAX_RETRIES = 3;

// ─── Typed Auth Broker (NN-PROXY-001/003) ────────────────────────────────────

/** The canonical newly-issued proxy credential shape (NN-PROXY-002). */
export const PROXY_CREDENTIAL_PATTERN = /^NN_[0-9a-f]{32}$/;

/** Auth scheme the broker recognizes. */
export type AuthScheme = 'proxy-credential' | 'session-jwt';

/** A typed principal returned by the Auth Broker. Carries no raw bearer. */
export interface AuthPrincipal {
  readonly scheme: AuthScheme;
  readonly subject: string;
  readonly audience: string;
  /** Masked credential hint; never a prefix/suffix of the real bearer. */
  readonly maskedBearer: string;
}

/** Result of an Auth Broker parse: a typed principal or a typed failure. */
export type AuthBrokerResult =
  | { readonly ok: true; readonly principal: AuthPrincipal }
  | { readonly ok: false; readonly error: ErrorEnvelope };

// ─── Route selection input / typed request ───────────────────────────────────

/** What the caller asks the provider authority to run. */
export interface ProviderRequest {
  /** Requested model id. */
  readonly modelId: string;
  /** Optional explicit channel id; otherwise the healthiest is chosen. */
  readonly channelId?: string;
  /** Whether the caller wants an incremental stream (NN-PROXY-011). */
  readonly stream: boolean;
  /** The pricing revision the caller priced this request against (NN-OBS-003). */
  readonly declaredPricingVersion: string;
  /** Whether the requester's plan grants paid-only models (NN-PROXY-010). */
  readonly paidPlanActive: boolean;
  /** The trust floor the source context requires (NN-ORCH-010). */
  readonly requiredTrust: TrustLevel;
  /** Estimated prompt tokens used to size the up-front budget reservation. */
  readonly estimatedPromptTokens?: number;
  /** Estimated completion tokens used to size the up-front reservation. */
  readonly estimatedCompletionTokens?: number;
}

// ─── Typed failure taxonomy ───────────────────────────────────────────────────

/**
 * The distinct provider-path failure classes. Each maps to exactly one D-06.2
 * `ErrorCode`. A typed failure NEVER forwards upstream, NEVER deducts credits,
 * and NEVER falls back to a less-trusted route.
 */
export type ProviderFailureClass =
  | 'unsupported-model'
  | 'unknown-channel'
  | 'channel-unavailable'
  | 'missing-upstream-key'
  | 'stale-pricing'
  | 'plan-forbidden'
  | 'trust-floor-violation'
  | 'insufficient-credits'
  | 'over-cap'
  | 'rate-limited'
  | 'auth-invalid'
  | 'upstream-error'
  | 'timeout'
  | 'cancelled'
  | 'stream-unsupported';

/** Map each provider failure class to its typed D-06.2 error code. */
export const FAILURE_CODE: Readonly<Record<ProviderFailureClass, ErrorCode>> = Object.freeze({
  'unsupported-model': 'VALIDATION',
  'unknown-channel': 'VALIDATION',
  'channel-unavailable': 'UNAVAILABLE',
  'missing-upstream-key': 'UNAVAILABLE',
  'stale-pricing': 'STALE_REVISION',
  'plan-forbidden': 'FORBIDDEN',
  'trust-floor-violation': 'FORBIDDEN',
  'insufficient-credits': 'BUDGET_EXCEEDED',
  'over-cap': 'BUDGET_EXCEEDED',
  'rate-limited': 'UNAVAILABLE',
  'auth-invalid': 'UNAUTHORIZED',
  'upstream-error': 'UNAVAILABLE',
  timeout: 'TIMEOUT',
  cancelled: 'CANCELLED',
  'stream-unsupported': 'VALIDATION',
});

/** Whether a failure class is retryable under a bounded retry budget (D-18). */
export function isRetryableFailure(cls: ProviderFailureClass): boolean {
  return cls === 'rate-limited' || cls === 'upstream-error' || cls === 'timeout';
}

/** Build a typed provider error envelope for a failure class. */
export function providerError(
  cls: ProviderFailureClass,
  message: string,
  correlationId: string,
  extra: Partial<ErrorEnvelope> = {},
): ErrorEnvelope {
  return {
    schemaVersion: 1,
    code: FAILURE_CODE[cls],
    message,
    owner: PROVIDER_AUTHORITY,
    operation: extra.operation ?? 'provider-route',
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: isRetryableFailure(cls),
    redaction: 'internal',
    ...extra,
  };
}

// ─── Route validation (pure, deterministic, typed) ───────────────────────────

/** A validated forwarding plan: the route, the model, and the chosen channel. */
export interface RoutePlan {
  readonly route: ProviderRoute;
  readonly model: RouteModel;
  readonly channel: RouteChannel;
}

/** Outcome of validating a request against a route. */
export type RouteValidation =
  | { readonly ok: true; readonly plan: RoutePlan; readonly failureClass?: undefined }
  | { readonly ok: false; readonly failureClass: ProviderFailureClass; readonly error: ErrorEnvelope };

/**
 * Validate a {@link ProviderRequest} against a single {@link ProviderRoute},
 * deterministically and with no side effect. The checks run in a fixed order so
 * that the FIRST applicable typed failure is returned; a failure never forwards
 * and never falls back. Order: model support → paid-plan → trust floor →
 * pricing freshness → channel resolution/health → streaming capability →
 * proxy upstream-key reference presence.
 */
export function validateRoute(
  route: ProviderRoute,
  request: ProviderRequest,
  correlationId: string,
): RouteValidation {
  const fail = (cls: ProviderFailureClass, message: string): RouteValidation => ({
    ok: false,
    failureClass: cls,
    error: providerError(cls, message, correlationId, { operation: 'validate-route' }),
  });

  const model = route.models.find((m) => m.modelId === request.modelId);
  if (!model) {
    return fail('unsupported-model', `model ${request.modelId} is not supported by route ${route.routeId}`);
  }
  if (model.paidOnly && !request.paidPlanActive) {
    return fail('plan-forbidden', `model ${request.modelId} requires a paid plan`);
  }
  if (!trustAtLeast(route.trust, request.requiredTrust)) {
    return fail(
      'trust-floor-violation',
      `route trust ${route.trust} is below the required floor ${request.requiredTrust}`,
    );
  }
  if (request.declaredPricingVersion !== route.pricingVersion) {
    return fail(
      'stale-pricing',
      `stale pricing version: declared ${request.declaredPricingVersion} vs route ${route.pricingVersion}`,
    );
  }

  // Channel resolution + health.
  let channel: RouteChannel | undefined;
  if (request.channelId !== undefined) {
    channel = route.channels.find((c) => c.channelId === request.channelId);
    if (!channel) {
      return fail('unknown-channel', `channel ${request.channelId} is not configured on route ${route.routeId}`);
    }
  } else {
    channel = selectHealthiestChannel(route.channels);
    if (!channel) {
      return fail('channel-unavailable', `no healthy channel is available on route ${route.routeId}`);
    }
  }
  if (channel.health !== 'healthy') {
    return fail('channel-unavailable', `channel ${channel.channelId} is ${channel.health}`);
  }

  if (request.stream && (!model.supportsStreaming || !channel.supportsStreaming)) {
    return fail('stream-unsupported', `streaming is not supported for model ${model.modelId} on channel ${channel.channelId}`);
  }

  // Proxy routes must carry an upstream credential REFERENCE (NN-PROXY-008).
  if (route.locality === 'proxy') {
    if (
      !route.upstreamCredentialRefId ||
      !route.upstreamAudience ||
      !route.upstreamScope
    ) {
      return fail('missing-upstream-key', `proxy route ${route.routeId} has no upstream credential reference`);
    }
  }

  return { ok: true, plan: { route, model, channel } };
}

/**
 * Choose the healthiest eligible channel: only `healthy` channels are eligible;
 * among those, highest priority then highest weight then lexicographic id for a
 * deterministic tie-break. Returns `undefined` when none is eligible.
 */
export function selectHealthiestChannel(
  channels: readonly RouteChannel[],
): RouteChannel | undefined {
  const eligible = channels.filter((c) => c.health === 'healthy');
  if (eligible.length === 0) return undefined;
  return [...eligible].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.weight !== b.weight) return b.weight - a.weight;
    return a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0;
  })[0];
}

// ─── Usage record (NN-PROXY-014, NN-OBS-003) ─────────────────────────────────

/** Reported-vs-estimated token status (NN-PROXY-011, NN-OBS-003). */
export type UsageSource = 'reported' | 'estimated';

/**
 * A usage record distinguishing provider cost, charged amount, provider/model/
 * channel, latency, upstream status, plan, cache sentinel, and reported/
 * estimated usage (NN-PROXY-014). Money fields are exact {@link Money}.
 */
export interface UsageRecord {
  readonly schemaVersion: 1;
  readonly usageId: string;
  readonly requestId: string;
  readonly routeId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly channelId: string;
  readonly locality: RouteLocality;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly usageSource: UsageSource;
  readonly providerCost: Money;
  readonly chargedAmount: Money;
  readonly latencyMs: number;
  /** Upstream HTTP-like status or a typed sentinel. */
  readonly upstreamStatus: number;
  readonly pricingVersion: string;
  /** True when this record was served from cache (NON-billable, NN-PROXY-012). */
  readonly cacheHit: boolean;
  /** True when the record could not be fully parsed; excluded from aggregates. */
  readonly partial: boolean;
  readonly createdAt: string;
}

/** Whether a value is a valid currency+scale denomination pair. */
export function isDenomination(currency: unknown, scale: unknown): boolean {
  return isCurrencyCode(currency) && isScale(scale);
}

/** Redaction class every provider observable record carries. */
export const PROVIDER_REDACTION: RedactionClass = 'internal';

/** Stable digest of a forwarding action (route/model/channel) for reservations. */
export function actionDigestFor(plan: RoutePlan, request: ProviderRequest): string {
  return computeDigest({
    routeId: plan.route.routeId,
    modelId: plan.model.modelId,
    channelId: plan.channel.channelId,
    stream: request.stream,
    pricingVersion: plan.route.pricingVersion,
  });
}
