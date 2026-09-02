/**
 * Provider billing — versioned pricing, exact credit computation, idempotent
 * deduction, durable usage records, and usage↔credit reconciliation
 * (FUT-PKG-06-EXECUTION/T-007).
 *
 * D-04/D-07 make the {@link ../storage/budget-authority BudgetAuthority} the
 * single writable owner of credit balances; this module never writes the budget
 * ledger directly — it reserves before a forward and commits the actual cost
 * after, so a retried usage event bills EXACTLY ONCE (NN-PROXY-009). Usage
 * records are owned by this module in an additive `provider_usage` table
 * (single-writer, idempotent by request id), so reconciliation can prove that
 * the sum of committed usage equals the sum of billed credits.
 *
 * ## Versioned pricing (NN-PROXY-009, NN-OBS-003)
 *
 * Provider cost and the charged amount are computed from a versioned model
 * price, a markup, and a plan multiplier, with declared USD values rounded to
 * six decimals. All arithmetic is exact {@link Money} (integer minor units at
 * scale 6) — never a binary float. A caller-declared pricing version that does
 * not match the price sheet is rejected as `STALE_REVISION` with no charge.
 *
 * ## Idempotent billing (NN-PROXY-009, NN-INV-007)
 *
 * Billing keys every deduction by `requestId` + billing period. The BudgetAuthority
 * ledger is idempotent by reservation key, so a reserve→commit replayed under
 * the same keys is exactly-once. A cache hit creates NO billable usage
 * (NN-PROXY-012): it is recorded as a zero-cost `cacheHit` usage row and never
 * reserves or commits credits.
 *
 * Design anchors: D-04, D-07, D-10, D-11, D-18, D-19.
 * Requirements: NN-PROXY-009, NN-PROXY-012, NN-PROXY-014, NN-OBS-003,
 * NN-ORCH-013, NN-INV-007, NN-INV-008.
 */

import type Database from 'better-sqlite3';

import {
  computeDigest,
  makeOpaqueId,
  type ErrorEnvelope,
  type ScopeDescriptor,
} from '../shared/contract-primitives';
import {
  addMoney,
  compareMoney,
  formatDecimalMoney,
  fromMoneyWire,
  isNegativeMoney,
  money,
  subMoney,
  toMoneyWire,
  zeroMoney,
  type Money,
} from '../shared/decimal-money';
import {
  commit as budgetCommit,
  readBudget,
  refund as budgetRefund,
  reserve as budgetReserve,
  type BudgetOutcome,
} from '../storage/budget-authority';
import {
  providerError,
  type ProviderRoute,
  type RoutePlan,
  type UsageRecord,
  type UsageSource,
} from './provider-types';

/** Charged/cost amounts are declared in USD rounded to six decimals (NN-PROXY-009). */
export const BILLING_CURRENCY = 'USD';
export const BILLING_SCALE = 6;

// ─── Durable usage table (additive, single-writer) ───────────────────────────

const USAGE_TABLES_DDL = `
  CREATE TABLE IF NOT EXISTS provider_usage (
    usage_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    route_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    locality TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    usage_source TEXT NOT NULL,
    provider_cost_minor TEXT NOT NULL,
    charged_minor TEXT NOT NULL,
    currency TEXT NOT NULL,
    scale INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    upstream_status INTEGER NOT NULL,
    pricing_version TEXT NOT NULL,
    cache_hit INTEGER NOT NULL,
    partial INTEGER NOT NULL,
    budget_id TEXT NOT NULL,
    reservation_key TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_provider_usage_route ON provider_usage (route_id);
  CREATE INDEX IF NOT EXISTS idx_provider_usage_budget ON provider_usage (budget_id);
`;

/** Create the usage table/indexes if absent. Idempotent and additive. */
export function ensureBillingTables(db: Database.Database): void {
  db.exec(USAGE_TABLES_DDL);
}

// ─── Versioned pricing (NN-PROXY-009) ─────────────────────────────────────────

/**
 * A versioned model price sheet entry: the per-token provider prices (USD at
 * scale 6), the markup fraction, and the plan multiplier. Prices are exact
 * minor-unit amounts (micro-USD) — never floats.
 */
export interface ModelPrice {
  readonly pricingVersion: string;
  readonly modelId: string;
  /** Provider price per prompt token, in micro-USD (scale 6). */
  readonly promptMicroUsdPerToken: bigint;
  /** Provider price per completion token, in micro-USD (scale 6). */
  readonly completionMicroUsdPerToken: bigint;
  /** Markup applied to provider cost, in parts-per-million (1_000_000 = +100%). */
  readonly markupPpm: number;
  /** Plan multiplier applied to the charged amount, in ppm (1_000_000 = 1.0x). */
  readonly planMultiplierPpm: number;
}

/** The token counts a usage event bills against. */
export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly usageSource: UsageSource;
}

/** A computed cost: exact provider cost and charged amount (USD scale 6). */
export interface ComputedCost {
  readonly providerCost: Money;
  readonly chargedAmount: Money;
}

function microUsd(minor: bigint): Money {
  return money(BILLING_CURRENCY, BILLING_SCALE, minor);
}

/**
 * Compute exact provider cost and charged amount from a versioned price and
 * token usage. Provider cost = Σ tokens × per-token price. Charged amount =
 * providerCost × (1 + markup) × planMultiplier, rounded to six decimals via
 * exact integer arithmetic (ppm math with round-half-up on the final divide).
 * The result is always non-negative; negative token counts are treated as a
 * caller error upstream (validated before this is reached).
 */
export function computeCost(price: ModelPrice, usage: TokenUsage): ComputedCost {
  const prompt = BigInt(Math.max(0, Math.trunc(usage.promptTokens)));
  const completion = BigInt(Math.max(0, Math.trunc(usage.completionTokens)));
  const providerMinor =
    prompt * price.promptMicroUsdPerToken + completion * price.completionMicroUsdPerToken;

  // charged = provider × (1_000_000 + markupPpm)/1_000_000 × planMultiplierPpm/1_000_000
  const markupNum = BigInt(1_000_000 + price.markupPpm);
  const planNum = BigInt(price.planMultiplierPpm);
  const denom = 1_000_000n * 1_000_000n;
  const numerator = providerMinor * markupNum * planNum;
  // Round half up: (numerator + denom/2) / denom.
  const chargedMinor = (numerator + denom / 2n) / denom;

  return {
    providerCost: microUsd(providerMinor),
    chargedAmount: microUsd(chargedMinor),
  };
}

// ─── Reserve → commit / refund the charged amount (idempotent) ────────────────

/** Context needed to bill against the BudgetAuthority. */
export interface BillingContext {
  readonly budgetId: string;
  readonly scope: ScopeDescriptor;
  readonly correlationId: string;
  /**
   * The billing period; combined with the request id to form the idempotency
   * handle so a deduction is exactly-once per request per period (NN-PROXY-009).
   */
  readonly billingPeriod: string;
  readonly now?: () => Date;
}

/** A stable reservation key for a request within a billing period. */
export function reservationKeyFor(requestId: string, billingPeriod: string): string {
  return `provider:${billingPeriod}:${requestId}`;
}

/**
 * Reserve the charged amount before forwarding. Delegates to the BudgetAuthority
 * so the balance is checked, never goes negative, and the hard cap is enforced
 * (NN-PROXY-009, NN-ORCH-013). Idempotent by request id + period: a retried
 * reserve replays with no double-hold. Returns the typed budget outcome.
 */
export function reserveCharge(
  db: Database.Database,
  ctx: BillingContext,
  plan: RoutePlan,
  charged: Money,
  actionDigest: string,
): BudgetOutcome {
  const reservationKey = reservationKeyFor(chargeRequestId(ctx), ctx.billingPeriod);
  return budgetReserve(db, {
    budgetId: ctx.budgetId,
    idempotencyKey: `reserve:${reservationKey}`,
    correlationId: ctx.correlationId,
    scope: ctx.scope,
    reservationKey,
    amount: charged,
    pricingVersion: plan.route.pricingVersion,
    actionDigest,
    ...(ctx.now ? { now: ctx.now } : {}),
  });
}

// requestId is threaded through the reservation key; we keep it on the ctx via
// a symbol-free approach: the caller sets it through {@link withRequestId}.
const REQUEST_ID = new WeakMap<BillingContext, string>();

/** Bind the request id to a billing context (used to key the reservation). */
export function withRequestId(ctx: BillingContext, requestId: string): BillingContext {
  REQUEST_ID.set(ctx, requestId);
  return ctx;
}

function chargeRequestId(ctx: BillingContext): string {
  const id = REQUEST_ID.get(ctx);
  if (!id) throw new Error('billing: request id was not bound to the context');
  return id;
}

/**
 * Commit the ACTUAL charged amount against a prior reservation after a
 * successful forward, and persist the usage record in the same logical step.
 * Idempotent by request id: a retried commit replays and re-reads the existing
 * usage row rather than inserting a duplicate or double-charging (NN-INV-007).
 */
export function settleSuccess(
  db: Database.Database,
  ctx: BillingContext,
  plan: RoutePlan,
  computed: ComputedCost,
  reservedAmount: Money,
  tokens: TokenUsage,
  meta: SettleMeta,
  actionDigest: string,
): {
  readonly outcome: BudgetOutcome;
  readonly usage: UsageRecord;
  readonly overCap?: true;
  readonly overCapError?: ErrorEnvelope;
} {
  const requestId = chargeRequestId(ctx);
  const reservationKey = reservationKeyFor(requestId, ctx.billingPeriod);

  // The commit against the original reservation is capped at the reserved
  // amount so it can never exceed the reservation (the BudgetAuthority rejects
  // an over-run). Charge min(actual, reserved) here.
  const primary =
    compareMoney(computed.chargedAmount, reservedAmount) <= 0
      ? computed.chargedAmount
      : reservedAmount;
  const outcome = budgetCommit(db, {
    budgetId: ctx.budgetId,
    idempotencyKey: `commit:${reservationKey}`,
    correlationId: ctx.correlationId,
    scope: ctx.scope,
    reservationKey,
    actualAmount: primary,
    pricingVersion: plan.route.pricingVersion,
    ...(ctx.now ? { now: ctx.now } : {}),
  });

  // If the actual exceeded the up-front reservation, charge the exact delta as
  // its own cap-safe reserve→commit so the total billed equals the actual
  // charged amount (or a typed over-cap failure if the delta breaches the cap).
  let overCap: true | undefined;
  let overCapError: ErrorEnvelope | undefined;
  const delta = subMoney(computed.chargedAmount, primary);
  if (!isNegativeMoney(delta) && delta.minorUnits > 0n) {
    const deltaKey = `${reservationKey}:delta`;
    const deltaReserve = budgetReserve(db, {
      budgetId: ctx.budgetId,
      idempotencyKey: `reserve:${deltaKey}`,
      correlationId: ctx.correlationId,
      scope: ctx.scope,
      reservationKey: deltaKey,
      amount: delta,
      pricingVersion: plan.route.pricingVersion,
      actionDigest,
      ...(ctx.now ? { now: ctx.now } : {}),
    });
    if (deltaReserve.kind === 'error') {
      overCap = true;
      overCapError = deltaReserve.error;
    } else {
      budgetCommit(db, {
        budgetId: ctx.budgetId,
        idempotencyKey: `commit:${deltaKey}`,
        correlationId: ctx.correlationId,
        scope: ctx.scope,
        reservationKey: deltaKey,
        actualAmount: delta,
        pricingVersion: plan.route.pricingVersion,
        ...(ctx.now ? { now: ctx.now } : {}),
      });
    }
  }

  // The usage row records the amount actually billed: the full actual when the
  // delta committed, else the capped primary when the delta was denied.
  const billed = overCap ? { providerCost: computed.providerCost, chargedAmount: primary } : computed;
  const usage = upsertUsage(db, ctx, plan, billed, tokens, {
    ...meta,
    reservationKey,
    cacheHit: false,
    partial: false,
  });
  return {
    outcome,
    usage,
    ...(overCap ? { overCap } : {}),
    ...(overCapError ? { overCapError } : {}),
  };
}

/**
 * Refund a reservation when the forward failed or was cancelled, and persist a
 * zero-charged usage record marking the failure. Idempotent by request id.
 */
export function settleFailure(
  db: Database.Database,
  ctx: BillingContext,
  plan: RoutePlan,
  meta: SettleMeta,
): { readonly outcome: BudgetOutcome; readonly usage: UsageRecord } {
  const requestId = chargeRequestId(ctx);
  const reservationKey = reservationKeyFor(requestId, ctx.billingPeriod);
  const outcome = budgetRefund(db, {
    budgetId: ctx.budgetId,
    idempotencyKey: `refund:${reservationKey}`,
    correlationId: ctx.correlationId,
    scope: ctx.scope,
    reservationKey,
    pricingVersion: plan.route.pricingVersion,
    ...(ctx.now ? { now: ctx.now } : {}),
  });
  const zero = zeroMoney(BILLING_CURRENCY, BILLING_SCALE);
  const usage = upsertUsage(
    db,
    ctx,
    plan,
    { providerCost: zero, chargedAmount: zero },
    { promptTokens: 0, completionTokens: 0, usageSource: 'estimated' },
    { ...meta, reservationKey, cacheHit: false, partial: false },
  );
  return { outcome, usage };
}

/**
 * Record a cache hit: NO reservation, NO commit, NO deduction (NN-PROXY-012).
 * A zero-cost usage row with `cacheHit=true` is persisted so dashboards see the
 * served response without any billable usage.
 */
export function recordCacheHit(
  db: Database.Database,
  ctx: BillingContext,
  plan: RoutePlan,
  tokens: TokenUsage,
  meta: SettleMeta,
): UsageRecord {
  const zero = zeroMoney(BILLING_CURRENCY, BILLING_SCALE);
  return upsertUsage(
    db,
    ctx,
    plan,
    { providerCost: zero, chargedAmount: zero },
    tokens,
    { ...meta, reservationKey: null, cacheHit: true, partial: false },
  );
}

// ─── Usage record persistence (single-writer, idempotent by request id) ──────

/** Non-cost metadata attached to a usage record. */
export interface SettleMeta {
  readonly latencyMs: number;
  readonly upstreamStatus: number;
}

interface UpsertMeta extends SettleMeta {
  readonly reservationKey: string | null;
  readonly cacheHit: boolean;
  readonly partial: boolean;
}

interface UsageRow {
  readonly usage_id: string;
  readonly request_id: string;
  readonly route_id: string;
  readonly provider_id: string;
  readonly model_id: string;
  readonly channel_id: string;
  readonly locality: string;
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly usage_source: string;
  readonly provider_cost_minor: string;
  readonly charged_minor: string;
  readonly currency: string;
  readonly scale: number;
  readonly latency_ms: number;
  readonly upstream_status: number;
  readonly pricing_version: string;
  readonly cache_hit: number;
  readonly partial: number;
  readonly budget_id: string;
  readonly reservation_key: string | null;
  readonly created_at: string;
}

function rowToUsage(row: UsageRow): UsageRecord {
  const providerCost = fromMoneyWire({
    currency: row.currency,
    scale: row.scale,
    minorUnits: row.provider_cost_minor,
  });
  const chargedAmount = fromMoneyWire({
    currency: row.currency,
    scale: row.scale,
    minorUnits: row.charged_minor,
  });
  if (!providerCost || !chargedAmount) {
    throw new Error('billing: corrupt money column on usage row');
  }
  return {
    schemaVersion: 1,
    usageId: row.usage_id,
    requestId: row.request_id,
    routeId: row.route_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    channelId: row.channel_id,
    locality: row.locality as UsageRecord['locality'],
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    usageSource: row.usage_source as UsageSource,
    providerCost,
    chargedAmount,
    latencyMs: row.latency_ms,
    upstreamStatus: row.upstream_status,
    pricingVersion: row.pricing_version,
    cacheHit: row.cache_hit === 1,
    partial: row.partial === 1,
    createdAt: row.created_at,
  };
}

/** Read a usage record by request id, or `undefined` if none exists. */
export function readUsageByRequest(
  db: Database.Database,
  requestId: string,
): UsageRecord | undefined {
  const row = db.prepare('SELECT * FROM provider_usage WHERE request_id = ?').get(requestId) as
    | UsageRow
    | undefined;
  return row ? rowToUsage(row) : undefined;
}

/**
 * Insert a usage record for a request, or return the existing one when the
 * request id already has a row (exactly-once by request id). This keeps usage
 * records one-per-request so reconciliation is exact.
 */
function upsertUsage(
  db: Database.Database,
  ctx: BillingContext,
  plan: RoutePlan,
  computed: ComputedCost,
  tokens: TokenUsage,
  meta: UpsertMeta,
): UsageRecord {
  const requestId = chargeRequestId(ctx);
  const existing = readUsageByRequest(db, requestId);
  if (existing) return existing;

  const now = (ctx.now ?? (() => new Date()))().toISOString();
  const usageId = makeOpaqueId('usg', `${requestId}${meta.cacheHit ? 'c' : 'f'}`);
  db.prepare(
    `INSERT INTO provider_usage
       (usage_id, request_id, route_id, provider_id, model_id, channel_id, locality,
        prompt_tokens, completion_tokens, usage_source, provider_cost_minor, charged_minor,
        currency, scale, latency_ms, upstream_status, pricing_version, cache_hit, partial,
        budget_id, reservation_key, created_at)
     VALUES (@usageId, @requestId, @routeId, @providerId, @modelId, @channelId, @locality,
        @promptTokens, @completionTokens, @usageSource, @providerCostMinor, @chargedMinor,
        @currency, @scale, @latencyMs, @upstreamStatus, @pricingVersion, @cacheHit, @partial,
        @budgetId, @reservationKey, @createdAt)`,
  ).run({
    usageId,
    requestId,
    routeId: plan.route.routeId,
    providerId: plan.route.providerId,
    modelId: plan.model.modelId,
    channelId: plan.channel.channelId,
    locality: plan.route.locality,
    promptTokens: Math.max(0, Math.trunc(tokens.promptTokens)),
    completionTokens: Math.max(0, Math.trunc(tokens.completionTokens)),
    usageSource: tokens.usageSource,
    providerCostMinor: computed.providerCost.minorUnits.toString(),
    chargedMinor: computed.chargedAmount.minorUnits.toString(),
    currency: BILLING_CURRENCY,
    scale: BILLING_SCALE,
    latencyMs: Math.max(0, Math.trunc(meta.latencyMs)),
    upstreamStatus: Math.trunc(meta.upstreamStatus),
    pricingVersion: plan.route.pricingVersion,
    cacheHit: meta.cacheHit ? 1 : 0,
    partial: meta.partial ? 1 : 0,
    budgetId: ctx.budgetId,
    reservationKey: meta.reservationKey,
    createdAt: now,
  });
  const inserted = readUsageByRequest(db, requestId);
  if (!inserted) throw new Error('billing: usage row missing after insert');
  return inserted;
}

// ─── Reconciliation (NN-PROXY-014) ────────────────────────────────────────────

/** The result of reconciling usage records to billed credits for a budget. */
export interface ReconciliationReport {
  readonly budgetId: string;
  /** Sum of `chargedAmount` over non-cache, non-partial usage rows. */
  readonly usageChargedTotal: Money;
  /** The budget's committed credits (the authoritative billed total). */
  readonly billedCommitted: Money;
  /** Whether the usage total exactly equals the billed committed total. */
  readonly reconciled: boolean;
  /** Count of malformed rows omitted from the aggregate (labeled partial). */
  readonly partialOmitted: number;
  /** Count of cache-hit rows excluded from billable totals. */
  readonly cacheExcluded: number;
}

/**
 * Reconcile the usage records for a budget against the BudgetAuthority's
 * committed credits. Cache-hit rows contribute zero billable usage
 * (NN-PROXY-012) and malformed/partial rows are omitted from the aggregate and
 * counted separately (NN-PROXY-014). `reconciled` is true iff the summed
 * charged amount over billable rows equals the budget's committed total —
 * proving usage records reconcile to billed credits.
 */
export function reconcile(db: Database.Database, budgetId: string): ReconciliationReport {
  const rows = db
    .prepare('SELECT * FROM provider_usage WHERE budget_id = ?')
    .all(budgetId) as UsageRow[];

  let usageCharged = zeroMoney(BILLING_CURRENCY, BILLING_SCALE);
  let partialOmitted = 0;
  let cacheExcluded = 0;
  for (const row of rows) {
    if (row.partial === 1) {
      partialOmitted += 1;
      continue;
    }
    if (row.cache_hit === 1) {
      cacheExcluded += 1;
      continue;
    }
    const charged = fromMoneyWire({
      currency: row.currency,
      scale: row.scale,
      minorUnits: row.charged_minor,
    });
    if (!charged) {
      partialOmitted += 1;
      continue;
    }
    usageCharged = addMoney(usageCharged, charged);
  }

  const budget = readBudget(db, budgetId);
  const billedCommitted = budget
    ? budget.committed
    : zeroMoney(BILLING_CURRENCY, BILLING_SCALE);

  const reconciled =
    budget !== undefined &&
    billedCommitted.currency === usageCharged.currency &&
    billedCommitted.scale === usageCharged.scale &&
    compareMoney(usageCharged, billedCommitted) === 0;

  return {
    budgetId,
    usageChargedTotal: usageCharged,
    billedCommitted,
    reconciled,
    partialOmitted,
    cacheExcluded,
  };
}

// ─── Pricing sheet lookup + staleness gate ────────────────────────────────────

/** Look up a model price on a versioned sheet. */
export function lookupPrice(
  sheet: readonly ModelPrice[],
  pricingVersion: string,
  modelId: string,
): ModelPrice | undefined {
  return sheet.find((p) => p.pricingVersion === pricingVersion && p.modelId === modelId);
}

/**
 * Resolve the price for a plan/request, returning a typed `STALE_REVISION` error
 * when the route's pricing version is not present on the sheet for the model
 * (never a silent conversion or a guessed price).
 */
export function resolvePrice(
  sheet: readonly ModelPrice[],
  route: ProviderRoute,
  modelId: string,
  correlationId: string,
): { readonly ok: true; readonly price: ModelPrice } | { readonly ok: false; readonly error: ErrorEnvelope } {
  const price = lookupPrice(sheet, route.pricingVersion, modelId);
  if (!price) {
    return {
      ok: false,
      error: providerError(
        'stale-pricing',
        `no price for model ${modelId} at pricing version ${route.pricingVersion}`,
        correlationId,
        { operation: 'resolve-price' },
      ),
    };
  }
  return { ok: true, price };
}

/** Human-readable USD string for a money amount (six decimals). */
export function formatUsd(amount: Money): string {
  return formatDecimalMoney(amount);
}

/** Whether a computed cost is well-formed (non-negative in the billing denom). */
export function isValidCost(cost: ComputedCost): boolean {
  return (
    cost.providerCost.currency === BILLING_CURRENCY &&
    cost.chargedAmount.currency === BILLING_CURRENCY &&
    !isNegativeMoney(cost.providerCost) &&
    !isNegativeMoney(cost.chargedAmount)
  );
}

/** Stable digest of a price sheet entry (for audit/versioning). */
export function priceDigest(price: ModelPrice): string {
  return computeDigest({
    pricingVersion: price.pricingVersion,
    modelId: price.modelId,
    prompt: price.promptMicroUsdPerToken.toString(),
    completion: price.completionMicroUsdPerToken.toString(),
    markupPpm: price.markupPpm,
    planMultiplierPpm: price.planMultiplierPpm,
  });
}

/** Convert a wire money back to Money or throw (internal helper for tests). */
export function moneyFromWireOrThrow(currency: string, scale: number, minor: string): Money {
  const m = fromMoneyWire({ currency, scale, minorUnits: minor });
  if (!m) throw new Error('billing: invalid money wire');
  return m;
}

/** Re-export the billing denomination as a helper zero. */
export function zeroCharge(): Money {
  return zeroMoney(BILLING_CURRENCY, BILLING_SCALE);
}

/** Convert a token-count Money-free tuple; used by tests to build prices. */
export function toWire(amount: Money) {
  return toMoneyWire(amount);
}
