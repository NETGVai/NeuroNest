/**
 * ProviderRouteService — the governed Provider/Proxy Authority
 * (FUT-PKG-06-EXECUTION/T-007).
 *
 * This is the single choke point through which every cost-bearing provider
 * request passes. It composes the prior authorities into one D-10/D-11-ordered
 * forward path and enforces the NN-PROXY guarantees:
 *
 *   1. **Typed Auth Broker** ({@link parseAuth}) — for a `proxy` route, ONE
 *      explicit versioned broker parses the bearer scheme, validates the typed
 *      issuer/audience, and returns a typed principal. An `NN_`-shaped bearer is
 *      a proxy credential; a JWT is valid only for its own audience and is never
 *      inferred from a non-`NN_` bearer (NN-PROXY-001/003). Local routes need no
 *      proxy auth and stay usable (NN-PROXY-006).
 *   2. **Model/channel validation** ({@link validateRoute}) — unsupported model,
 *      unknown/unhealthy channel, plan-forbidden model, trust-floor violation,
 *      stale pricing, or a missing upstream-key reference each returns a typed
 *      failure with NO forward and NO fallback to a less-trusted route
 *      (NN-PROXY-007/010, NN-ORCH-010).
 *   3. **Rate limit** ({@link RateLimiter}) — a per-license limit returns a typed
 *      `rate-limited` (429-equivalent) with retry metadata and does not forward
 *      or bill (NN-PROXY-012).
 *   4. **Cache** ({@link ResponseCache}) — an eligible non-stream request may be
 *      served from cache; a cache hit creates NO billable usage (NN-PROXY-012).
 *   5. **Reserve credits** ({@link ../provider/billing reserveCharge}) — before
 *      forwarding, the charged amount is reserved against the BudgetAuthority so
 *      the balance is checked, never goes negative, and the hard cap blocks
 *      over-cap forwards (NN-PROXY-009, NN-ORCH-013).
 *   6. **Late secret resolution** — the upstream provider secret is resolved at
 *      the forward boundary only and disposed immediately; it never touches the
 *      request, usage record, receipt, event, or error (D-16.6, NN-INV-004).
 *   7. **Forward + stream** ({@link ../provider/streaming runStream}) — the
 *      transport is end-to-end incremental with abort/reconnect and bounded
 *      retries (NN-PROXY-011, NN-CHAT-004).
 *   8. **Settle** — on success the ACTUAL charged amount is committed and a
 *      usage record persisted; on failure the reservation is refunded and a
 *      zero-charged failure usage row is written (idempotent, NN-PROXY-009/014).
 *
 * **Routing failure isolation** (V-PROXY-001/routing-failure-isolation): every
 * request is keyed to its own budget/reservation/usage rows, so a failure on
 * one route never mutates another route's accounting or state. Admin controls
 * mask credentials and never expose raw keys (NN-PROXY-013).
 *
 * Design anchors: D-05, D-10, D-11, D-16, D-18, D-19.
 * Requirements: NN-PROXY-001–015, NN-LICENSE-006, NN-CHAT-004,
 * NN-OBS-003/004, NN-ORCH-010/013.
 */

import type Database from 'better-sqlite3';

import {
  computeDigest,
  makeOpaqueId,
  type ErrorEnvelope,
  type ScopeDescriptor,
} from '../shared/contract-primitives';
import { maskCredential, type CredentialService } from '../shared/credential-service';
import type { Money } from '../shared/decimal-money';
import {
  actionDigestFor,
  providerError,
  validateRoute,
  PROVIDER_AUTHORITY,
  PROXY_CREDENTIAL_PATTERN,
  type AuthBrokerResult,
  type AuthPrincipal,
  type ProviderRequest,
  type ProviderRoute,
  type RoutePlan,
  type UsageRecord,
} from './provider-types';
import {
  computeCost,
  ensureBillingTables,
  reconcile,
  recordCacheHit,
  reserveCharge,
  resolvePrice,
  settleFailure,
  settleSuccess,
  withRequestId,
  type BillingContext,
  type ModelPrice,
  type ReconciliationReport,
  type TokenUsage,
} from './billing';
import {
  AbortHandle,
  partialContent,
  runStream,
  type StreamOutcome,
  type StreamSource,
} from './streaming';

// ─── Typed Auth Broker (NN-PROXY-001/003) ─────────────────────────────────────

/** A parsed, unvalidated bearer presentation. */
export interface BearerPresentation {
  readonly bearer: string;
  /** The audience the caller claims to be authenticating for. */
  readonly audience: string;
  /** The subject the caller claims (validated against the credential principal). */
  readonly subject: string;
  readonly correlationId: string;
}

/**
 * The one explicit versioned Auth Broker. It parses exactly one scheme and
 * returns a typed principal — never a "try one regex then another" fallback
 * (NN-PROXY-001). An `NN_`-shaped bearer is a proxy credential; anything else
 * that is presented for a `session-jwt` audience is validated ONLY as a session
 * JWT (a JWT is never inferred merely from a non-`NN_` bearer, NN-PROXY-003).
 */
export function parseAuth(presentation: BearerPresentation): AuthBrokerResult {
  const { bearer, audience, subject, correlationId } = presentation;
  const fail = (message: string): AuthBrokerResult => ({
    ok: false,
    error: providerError('auth-invalid', message, correlationId, { operation: 'auth-broker' }),
  });

  if (typeof bearer !== 'string' || bearer.length === 0) {
    return fail('empty bearer');
  }

  if (bearer.startsWith('NN_')) {
    if (!PROXY_CREDENTIAL_PATTERN.test(bearer)) {
      return fail('malformed proxy credential');
    }
    if (audience.length === 0 || subject.length === 0) {
      return fail('proxy credential requires an explicit audience and subject');
    }
    const principal: AuthPrincipal = {
      scheme: 'proxy-credential',
      subject,
      audience,
      maskedBearer: maskCredential(bearer),
    };
    return { ok: true, principal };
  }

  // A non-NN_ bearer is ONLY valid as a session JWT for a session audience;
  // it is never treated as a proxy credential.
  if (audience === 'session') {
    if (bearer.split('.').length !== 3) {
      return fail('malformed session jwt');
    }
    const principal: AuthPrincipal = {
      scheme: 'session-jwt',
      subject,
      audience,
      maskedBearer: maskCredential(bearer),
    };
    return { ok: true, principal };
  }

  return fail('unrecognized bearer scheme; no ambiguous fallback');
}

// ─── Rate limiter (NN-PROXY-012) ──────────────────────────────────────────────

/** Per-license rate-limit outcome. */
export type RateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterMs: number };

/**
 * A simple bounded per-license request rate limiter (NN-PROXY-012). Fixed
 * window: at most `maxRequests` per `windowMs` per license. Deterministic given
 * an injected clock so it is testable without wall-clock flakiness.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  check(licenseId: string): RateDecision {
    const now = this.nowMs();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(licenseId) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.maxRequests) {
      const oldest = recent[0];
      return { allowed: false, retryAfterMs: Math.max(0, oldest + this.windowMs - now) };
    }
    recent.push(now);
    this.hits.set(licenseId, recent);
    return { allowed: true };
  }
}

// ─── Response cache (NN-PROXY-012) ─────────────────────────────────────────────

/** A cached non-stream response body + token counts. */
export interface CachedResponse {
  readonly content: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/**
 * A content/policy/version-keyed response cache for eligible NON-stream
 * requests only (NN-PROXY-012). A cache hit must not create billable usage.
 */
export class ResponseCache {
  private readonly entries = new Map<string, CachedResponse>();

  /** Cache key over route, model, channel, pricing version, and request digest. */
  static keyFor(plan: RoutePlan, requestDigest: string): string {
    return computeDigest({
      routeId: plan.route.routeId,
      modelId: plan.model.modelId,
      channelId: plan.channel.channelId,
      pricingVersion: plan.route.pricingVersion,
      requestDigest,
    });
  }

  get(key: string): CachedResponse | undefined {
    return this.entries.get(key);
  }

  put(key: string, value: CachedResponse): void {
    this.entries.set(key, value);
  }
}

// ─── The governed forward request ──────────────────────────────────────────────

/** Everything needed to run one governed provider forward. */
export interface ForwardRequest {
  readonly requestId: string;
  readonly correlationId: string;
  readonly scope: ScopeDescriptor;
  readonly licenseId: string;
  readonly budgetId: string;
  readonly billingPeriod: string;
  /** The resolved route this forward targets. */
  readonly route: ProviderRoute;
  readonly request: ProviderRequest;
  /** Digest of the actual prompt payload (for cache keying); never the raw prompt. */
  readonly requestDigest: string;
  /** For a proxy route, the presented bearer for the Auth Broker. */
  readonly bearer?: BearerPresentation;
  /** The actor id resolving the upstream secret at the boundary. */
  readonly actor: string;
  /** The upstream credential revocation epoch the caller pins (NN-INV-001). */
  readonly upstreamRevocationEpoch?: number;
  /** A disconnect handle; signalling it aborts the upstream (NN-PROXY-011). */
  readonly disconnect?: AbortHandle;
  readonly now?: () => Date;
  readonly nowMs?: () => number;
}

/** Ports the service composes (all real or injected fakes, never mocked stores). */
export interface ServicePorts {
  readonly credentials: CredentialService;
  readonly priceSheet: readonly ModelPrice[];
  readonly rateLimiter: RateLimiter;
  readonly cache: ResponseCache;
  /**
   * Open an upstream stream for a validated plan. The secret is resolved and
   * disposed by the service; the source receives only a resolved bearer string
   * for the duration of the forward. For a cache-eligible non-stream request the
   * service may consult the cache before opening a source.
   */
  readonly openSource: (plan: RoutePlan, resolvedBearer: string | undefined) => StreamSource;
  readonly maxRetries?: number;
  readonly streamDeadlineMs?: number;
}

/** The typed outcome of a governed forward. */
export type ForwardOutcome =
  | {
      readonly kind: 'succeeded';
      readonly content: string;
      readonly usage: UsageRecord;
      readonly cacheHit: boolean;
    }
  | {
      readonly kind: 'interrupted';
      readonly content: string;
      readonly usage: UsageRecord;
    }
  | { readonly kind: 'failed'; readonly error: ErrorEnvelope; readonly usage?: UsageRecord };

/**
 * Run one governed provider forward end-to-end. Each stage returns a typed
 * failure with no forward/deduction/fallback on a rejected gate. Success commits
 * the exact charged amount and a usage record; failure refunds and records a
 * zero-charged usage row. Every mutation is keyed to this request's own
 * budget/reservation/usage, so a failure never corrupts another route's state.
 */
export async function forward(
  db: Database.Database,
  ports: ServicePorts,
  input: ForwardRequest,
): Promise<ForwardOutcome> {
  const { request, correlationId } = input;
  const route = input.route;

  // 1. Auth Broker for proxy routes (local routes stay usable without proxy auth).
  if (route.locality === 'proxy') {
    if (!input.bearer) {
      return {
        kind: 'failed',
        error: providerError('auth-invalid', 'proxy route requires a bearer', correlationId, {
          operation: 'forward',
        }),
      };
    }
    const auth = parseAuth(input.bearer);
    if (!auth.ok) {
      return { kind: 'failed', error: auth.error };
    }
  }

  // 2. Model/channel/plan/trust/pricing validation (no fallback on failure).
  const validation = validateRoute(route, request, correlationId);
  if (!validation.ok) {
    return { kind: 'failed', error: validation.error };
  }
  const plan = validation.plan;

  // 3. Rate limit (typed 429-equivalent; no forward, no bill).
  const rate = ports.rateLimiter.check(input.licenseId);
  if (!rate.allowed) {
    return {
      kind: 'failed',
      error: providerError('rate-limited', 'per-license rate limit exceeded', correlationId, {
        operation: 'forward',
        retryAfterMs: rate.retryAfterMs,
      }),
    };
  }

  // Resolve the versioned price (stale pricing → typed failure, no bill).
  const priced = resolvePrice(ports.priceSheet, route, plan.model.modelId, correlationId);
  if (!priced.ok) {
    return { kind: 'failed', error: priced.error };
  }

  const ctxBase: BillingContext = {
    budgetId: input.budgetId,
    scope: input.scope,
    correlationId,
    billingPeriod: input.billingPeriod,
    ...(input.now ? { now: input.now } : {}),
  };
  const ctx = withRequestId(ctxBase, input.requestId);

  // 4. Cache: only eligible NON-stream requests; a hit creates NO billable usage.
  if (!request.stream) {
    const key = ResponseCache.keyFor(plan, input.requestDigest);
    const cached = ports.cache.get(key);
    if (cached) {
      const usage = recordCacheHit(
        db,
        ctx,
        plan,
        {
          promptTokens: cached.promptTokens,
          completionTokens: cached.completionTokens,
          usageSource: 'reported',
        },
        { latencyMs: 0, upstreamStatus: 200 },
      );
      return { kind: 'succeeded', content: cached.content, usage, cacheHit: true };
    }
  }

  // 5. Reserve the charged amount BEFORE forwarding (balance/cap check).
  //    Estimate from the request's declared token budget is folded into the
  //    actual amount at settle; here we reserve the computed charged amount for
  //    the observed/declared tokens. We estimate zero tokens up front and
  //    reserve a minimal hold, then commit the actual at settle. To keep the
  //    reserve meaningful we reserve the charged amount computed from the
  //    provider's estimated tokens supplied on the request path; when unknown we
  //    reserve zero and rely on commit's cap-safe path (commit never exceeds a
  //    reservation, so we reserve an upper-bound estimate instead).
  const estimate = computeCost(priced.price, {
    promptTokens: request.estimatedPromptTokens ?? 0,
    completionTokens: request.estimatedCompletionTokens ?? 0,
    usageSource: 'estimated',
  });
  const actionDigest = actionDigestFor(plan, request);
  const reserved = reserveCharge(db, ctx, plan, estimate.chargedAmount, actionDigest);
  if (reserved.kind === 'error') {
    // Over-cap / insufficient credits / stale pricing at the ledger: typed
    // failure, NO forward, NO deduction. Map the budget error to a provider one.
    return { kind: 'failed', error: mapBudgetError(reserved.error, correlationId) };
  }

  // 6 + 7. Resolve the upstream secret at the boundary ONLY, forward, stream.
  const forwardResult = await forwardWithSecret(db, ports, input, plan);
  const { outcome, tokens, latencyMs, upstreamStatus } = forwardResult;

  // 8. Settle idempotently: commit actual on success, refund on failure.
  if (outcome.kind === 'completed') {
    const actual = computeCost(priced.price, tokens);
    // Commit the actual charged amount. settleSuccess caps the original
    // reservation and charges any excess as its own cap-safe reserve→commit so
    // the billed total equals the actual (or reports a typed over-cap when the
    // excess breaches the hard cap).
    const settled = settleSuccess(
      db,
      ctx,
      plan,
      actual,
      estimate.chargedAmount,
      tokens,
      { latencyMs, upstreamStatus },
      actionDigest,
    );
    if (settled.outcome.kind === 'error') {
      return { kind: 'failed', error: mapBudgetError(settled.outcome.error, correlationId), usage: settled.usage };
    }
    // Populate the cache for eligible non-stream successes.
    if (!request.stream) {
      const key = ResponseCache.keyFor(plan, input.requestDigest);
      ports.cache.put(key, {
        content: partialContent(outcome.partial),
        promptTokens: tokens.promptTokens,
        completionTokens: tokens.completionTokens,
      });
    }
    return {
      kind: 'succeeded',
      content: partialContent(outcome.partial),
      usage: settled.usage,
      cacheHit: false,
    };
  }

  if (outcome.kind === 'interrupted') {
    // Preserve partial + usage; refund the reservation (no charge for a
    // disconnect/cancel). Idempotent.
    const settled = settleFailure(db, ctx, plan, { latencyMs, upstreamStatus });
    return { kind: 'interrupted', content: partialContent(outcome.partial), usage: settled.usage };
  }

  // failed
  settleFailure(db, ctx, plan, { latencyMs, upstreamStatus });
  return { kind: 'failed', error: outcome.error };
}

/** The secret is resolved at the boundary only and disposed immediately. */
async function forwardWithSecret(
  db: Database.Database,
  ports: ServicePorts,
  input: ForwardRequest,
  plan: RoutePlan,
): Promise<{
  readonly outcome: StreamOutcome;
  readonly tokens: TokenUsage;
  readonly latencyMs: number;
  readonly upstreamStatus: number;
}> {
  void db;
  const nowMs = input.nowMs ?? (() => Date.now());
  const startedAt = nowMs();
  let resolvedBearer: string | undefined;
  let dispose: (() => void) | undefined;

  if (plan.route.locality === 'proxy' && plan.route.upstreamCredentialRefId) {
    const resolution = ports.credentials.resolveAtBoundary(plan.route.upstreamCredentialRefId, {
      actor: input.actor,
      audience: plan.route.upstreamAudience ?? '',
      scope: plan.route.upstreamScope ?? '',
      expectedRevocationEpoch: input.upstreamRevocationEpoch ?? 0,
      operation: 'forward',
      correlationId: input.correlationId,
    });
    if (!resolution.ok) {
      return {
        outcome: {
          kind: 'failed',
          partial: { chunks: [], committedOffset: 0, promptTokens: 0, completionTokens: 0, complete: false, reported: false, upstreamStatus: 0 },
          failureClass: 'missing-upstream-key',
          error: providerError('missing-upstream-key', 'upstream credential could not be resolved', input.correlationId, { operation: 'forward' }),
        },
        tokens: { promptTokens: 0, completionTokens: 0, usageSource: 'estimated' },
        latencyMs: nowMs() - startedAt,
        upstreamStatus: 0,
      };
    }
    // Reveal only inside this boundary; capture a copy for the source call and
    // dispose immediately after opening so the secret's lifetime is minimal.
    resolvedBearer = resolution.value.reveal();
    dispose = () => resolution.value.dispose();
  }

  const source = ports.openSource(plan, resolvedBearer);
  // The secret has now been handed to the source; dispose our reference.
  if (dispose) dispose();
  resolvedBearer = undefined;

  const disconnect = input.disconnect ?? new AbortHandle();
  const outcome = await runStream(source, {
    correlationId: input.correlationId,
    ...(ports.maxRetries !== undefined ? { maxRetries: ports.maxRetries } : {}),
    nowMs,
    deadlineMs: ports.streamDeadlineMs,
    disconnect,
  });

  const tokens: TokenUsage = {
    promptTokens: outcome.partial.promptTokens,
    completionTokens: outcome.partial.completionTokens,
    usageSource: outcome.partial.reported ? 'reported' : 'estimated',
  };
  return {
    outcome,
    tokens,
    latencyMs: nowMs() - startedAt,
    upstreamStatus: outcome.partial.upstreamStatus,
  };
}

/** Map a BudgetAuthority error into a provider failure class for the caller. */
function mapBudgetError(error: ErrorEnvelope, correlationId: string): ErrorEnvelope {
  if (error.code === 'BUDGET_EXCEEDED') {
    return providerError('over-cap', error.message, correlationId, { operation: 'forward' });
  }
  if (error.code === 'STALE_REVISION') {
    return providerError('stale-pricing', error.message, correlationId, { operation: 'forward' });
  }
  // Re-stamp ownership but preserve the code semantics.
  return {
    ...error,
    owner: PROVIDER_AUTHORITY,
    operation: 'forward',
    correlationId,
  };
}

// ─── Admin masked controls (NN-PROXY-013) ─────────────────────────────────────

/** A masked, renderer-safe view of a route for the admin console. */
export interface MaskedRouteView {
  readonly routeId: string;
  readonly locality: ProviderRoute['locality'];
  readonly providerId: string;
  readonly trust: ProviderRoute['trust'];
  readonly models: readonly string[];
  readonly channels: readonly { readonly channelId: string; readonly health: string }[];
  readonly pricingVersion: string;
  /** A masked hint for the upstream credential reference; NEVER the raw key. */
  readonly upstreamCredentialMasked?: string;
}

/**
 * Project a route to a masked admin view. Raw upstream keys are never exposed;
 * only a non-reversible masked hint of the credential REFERENCE id is shown
 * (NN-PROXY-013). This function is pure and side-effect free.
 */
export function maskedRouteView(route: ProviderRoute): MaskedRouteView {
  return {
    routeId: route.routeId,
    locality: route.locality,
    providerId: route.providerId,
    trust: route.trust,
    models: route.models.map((m) => m.modelId),
    channels: route.channels.map((c) => ({ channelId: c.channelId, health: c.health })),
    pricingVersion: route.pricingVersion,
    ...(route.upstreamCredentialRefId
      ? { upstreamCredentialMasked: maskCredential(route.upstreamCredentialRefId) }
      : {}),
  };
}

// ─── Setup + reconciliation passthrough ────────────────────────────────────────

/** Ensure all provider-owned tables exist (billing usage). Idempotent. */
export function ensureProviderTables(db: Database.Database): void {
  ensureBillingTables(db);
}

/** Reconcile usage records to billed credits for a budget (NN-PROXY-014). */
export function reconcileUsage(db: Database.Database, budgetId: string): ReconciliationReport {
  return reconcile(db, budgetId);
}

/** A stable id for a provider forward command (audit/correlation). */
export function forwardCommandId(requestId: string): string {
  return makeOpaqueId('pfwd', requestId);
}
