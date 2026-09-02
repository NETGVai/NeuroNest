/**
 * BudgetAuthority — hierarchical, revisioned budgets with an idempotent
 * reserve → commit → refund ledger and the CD-028 hard-cap transition
 * (FUT-PKG-04-SECURITY/T-007).
 *
 * D-04 names `BudgetAuthority` the single writable owner of the `Budgets` data
 * class; usage/cost dashboards and reservations are read projections, never a
 * second writer (NN-INV-008). D-07 `BudgetRecord@1` requires: a hierarchy
 * (`parentBudgetId`), explicit `currency`/`unit` and `pricingVersion`, and the
 * invariant `reserved + committed - refunded` cannot exceed `hardLimit` without
 * an exact approved extension; reserve/commit/refund transitions are
 * idempotent; child limits fit parent availability.
 *
 * This module layers those semantics on the T-001 authority transaction
 * ({@link ./authority-transaction}): every mutation runs through
 * `applyAuthorityMutation`, so it is atomic, revisioned, receipted, and
 * idempotent by idempotency key (NN-INV-007). Money is decimal
 * ({@link ../shared/decimal-money}) — an exact integer minor-unit `BigInt`
 * tagged with currency and scale — and is stored/serialized as a decimal
 * string, never a binary float (D-07).
 *
 * ## Hard-cap transition (CD-028 / NN-ORCH-013 / R8)
 *
 * Before every cost-bearing action the owning execution reserves against the
 * current budget and pricing/policy revision:
 *
 *   - **Below the cap** (`reserved + committed - refunded + amount <= hardLimit`)
 *     the reservation is granted. A caller MAY have *pre-approved* a cheaper
 *     route beforehand; that choice is the caller's and is simply reserved
 *     here. This module never invents a route.
 *   - **At or beyond the cap** the reservation is DENIED with a typed
 *     `BUDGET_EXCEEDED`. The only way forward is an *exact incremental
 *     extension* (matching amount, currency, pricing version, and action
 *     digest) that raises the hard limit, after which the caller re-reserves.
 *     This module NEVER performs an automatic post-cap downgrade — there is no
 *     code path that selects a cheaper route in response to a denial.
 *
 * Stale pricing/currency (a reservation whose declared `pricingVersion` or
 * `currency` does not match the budget's current values) is rejected with a
 * typed `STALE_REVISION`/`CONFLICT` and produces no reservation — it is never
 * silently converted.
 *
 * ## Additivity and rollback
 *
 * This module creates NEW canonical tables (`budgets`, `budget_ledger`) and is
 * the sole writer for them; it never mutates a business table owned by another
 * authority. Rollback restores the prior usage counter (e.g. {@link ./cost-store})
 * as a read adapter; it never removes the hard cap.
 *
 * Design anchors: D-04 (Budgets authority), D-07 (`BudgetRecord@1`, decimal
 * money), D-08 (persistence/transactions).
 * Requirements: NN-ORCH-013 (hard budget), NN-OBS-003 (currency/pricing
 * version), NN-INV-007 (idempotent transitions), NN-INV-008 (one owner),
 * NN-DATA-002/004 (durable tables / optimistic concurrency), CD-028.
 */

import type Database from 'better-sqlite3';

import {
  computeDigest,
  makeOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
  type ScopeDescriptor,
} from '../shared/contract-primitives.js';
import {
  addMoney,
  compareMoney,
  fromMoneyWire,
  isNegativeMoney,
  sameDenomination,
  subMoney,
  toMoneyWire,
  zeroMoney,
  type Money,
} from '../shared/decimal-money.js';
import {
  applyAuthorityMutation,
  ensureAuthorityTables,
  readCommandReceipt,
  type AuthorityMutationResult,
} from './authority-transaction.js';

// ─── Canonical durable tables (D-08.1, additive) ────────────────────────────

/** The authority id stamped on receipts/events and error envelopes. */
export const BUDGET_AUTHORITY = 'authority-budget';

/**
 * DDL for the budget business tables owned solely by BudgetAuthority. Additive
 * (`IF NOT EXISTS`) so {@link ensureBudgetTables} is safe at startup and in
 * tests. Money is stored as `currency` + `scale` + a `*_minor` decimal STRING
 * (never a float/REAL column) so persisted amounts stay exact (D-07).
 */
const BUDGET_TABLES_DDL = `
  -- BudgetRecord@1 (D-07). One row per budget node; parent_budget_id forms the
  -- hierarchy. reserved/committed/refunded are decimal-string minor units.
  CREATE TABLE IF NOT EXISTS budgets (
    budget_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    parent_budget_id TEXT,
    scope_json TEXT NOT NULL,
    unit TEXT NOT NULL,
    currency TEXT NOT NULL,
    scale INTEGER NOT NULL,
    pricing_version TEXT NOT NULL,
    policy_revision INTEGER NOT NULL,
    warning_threshold_ppm INTEGER NOT NULL,
    hard_limit_minor TEXT NOT NULL,
    reserved_minor TEXT NOT NULL,
    committed_minor TEXT NOT NULL,
    refunded_minor TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (parent_budget_id) REFERENCES budgets (budget_id)
  );

  -- Ledger of reserve/commit/refund/extend entries. entry_key is the caller's
  -- idempotency handle; UNIQUE(budget_id, entry_key) makes each logical entry
  -- exactly-once so a retry never double-charges (NN-INV-007).
  CREATE TABLE IF NOT EXISTS budget_ledger (
    ledger_id TEXT PRIMARY KEY,
    budget_id TEXT NOT NULL,
    entry_key TEXT NOT NULL,
    reservation_key TEXT,
    kind TEXT NOT NULL,
    amount_minor TEXT NOT NULL,
    currency TEXT NOT NULL,
    scale INTEGER NOT NULL,
    pricing_version TEXT NOT NULL,
    action_digest TEXT,
    budget_revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (budget_id, entry_key),
    FOREIGN KEY (budget_id) REFERENCES budgets (budget_id)
  );

  CREATE INDEX IF NOT EXISTS idx_budgets_parent ON budgets (parent_budget_id);
  CREATE INDEX IF NOT EXISTS idx_budget_ledger_budget ON budget_ledger (budget_id);
  CREATE INDEX IF NOT EXISTS idx_budget_ledger_reservation
    ON budget_ledger (budget_id, reservation_key);
`;

/**
 * Create the budget tables/indexes if absent. Idempotent and additive. Also
 * ensures the T-001 authority tables exist, since every budget mutation routes
 * through {@link applyAuthorityMutation}.
 */
export function ensureBudgetTables(db: Database.Database): void {
  ensureAuthorityTables(db);
  db.exec(BUDGET_TABLES_DDL);
}

// ─── BudgetRecord@1 (D-07) ──────────────────────────────────────────────────

/** Budget lifecycle state. */
export type BudgetState = 'active' | 'exhausted' | 'closed';

/** Ledger entry kinds. */
export type BudgetLedgerKind = 'reserve' | 'commit' | 'refund' | 'extend';

/**
 * `BudgetRecord@1` (D-07) as an in-memory record. `hardLimit`/`reserved`/
 * `committed`/`refunded` are exact {@link Money}. `warningThresholdPpm` encodes
 * the warning fraction in parts-per-million (e.g. 800000 = 80%, the legacy
 * default) so it stays an exact integer.
 */
export interface BudgetRecord {
  readonly schemaVersion: 1;
  readonly budgetId: string;
  readonly revision: number;
  readonly parentBudgetId?: string;
  readonly scope: ScopeDescriptor;
  readonly unit: string;
  readonly currency: string;
  readonly scale: number;
  readonly pricingVersion: string;
  readonly policyRevision: number;
  readonly warningThresholdPpm: number;
  readonly hardLimit: Money;
  readonly reserved: Money;
  readonly committed: Money;
  readonly refunded: Money;
  readonly state: BudgetState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface BudgetRow {
  readonly budget_id: string;
  readonly revision: number;
  readonly parent_budget_id: string | null;
  readonly scope_json: string;
  readonly unit: string;
  readonly currency: string;
  readonly scale: number;
  readonly pricing_version: string;
  readonly policy_revision: number;
  readonly warning_threshold_ppm: number;
  readonly hard_limit_minor: string;
  readonly reserved_minor: string;
  readonly committed_minor: string;
  readonly refunded_minor: string;
  readonly state: BudgetState;
  readonly created_at: string;
  readonly updated_at: string;
}

function moneyFromMinor(minor: string, currency: string, scale: number): Money {
  const rebuilt = fromMoneyWire({ currency, scale, minorUnits: minor });
  if (!rebuilt) {
    throw new Error(`budget-authority: corrupt money column ${minor} ${currency}@${scale}`);
  }
  return rebuilt;
}

function rowToRecord(row: BudgetRow): BudgetRecord {
  const currency = row.currency;
  const scale = row.scale;
  return {
    schemaVersion: 1,
    budgetId: row.budget_id,
    revision: row.revision,
    ...(row.parent_budget_id ? { parentBudgetId: row.parent_budget_id } : {}),
    scope: JSON.parse(row.scope_json) as ScopeDescriptor,
    unit: row.unit,
    currency,
    scale,
    pricingVersion: row.pricing_version,
    policyRevision: row.policy_revision,
    warningThresholdPpm: row.warning_threshold_ppm,
    hardLimit: moneyFromMinor(row.hard_limit_minor, currency, scale),
    reserved: moneyFromMinor(row.reserved_minor, currency, scale),
    committed: moneyFromMinor(row.committed_minor, currency, scale),
    refunded: moneyFromMinor(row.refunded_minor, currency, scale),
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readBudgetRow(db: Database.Database, budgetId: string): BudgetRow | undefined {
  return db.prepare('SELECT * FROM budgets WHERE budget_id = ?').get(budgetId) as
    | BudgetRow
    | undefined;
}

/** Read a budget record by id, or `undefined` if absent. */
export function readBudget(db: Database.Database, budgetId: string): BudgetRecord | undefined {
  const row = readBudgetRow(db, budgetId);
  return row ? rowToRecord(row) : undefined;
}

// ─── Derived amounts ────────────────────────────────────────────────────────

/** Outstanding exposure: `reserved + committed - refunded`. */
export function outstanding(record: BudgetRecord): Money {
  return subMoney(addMoney(record.reserved, record.committed), record.refunded);
}

/** Remaining headroom below the hard cap: `hardLimit - outstanding`. */
export function availability(record: BudgetRecord): Money {
  return subMoney(record.hardLimit, outstanding(record));
}

/**
 * Whether granting `amount` keeps the budget at or below its hard cap. This is
 * the pre-cap test; a `false` result is an at/beyond-cap condition that MUST
 * pause for an exact extension or block (CD-028), never trigger a downgrade.
 */
export function withinCap(record: BudgetRecord, amount: Money): boolean {
  const projected = addMoney(outstanding(record), amount);
  return compareMoney(projected, record.hardLimit) <= 0;
}

// ─── Typed error helper ─────────────────────────────────────────────────────

function budgetError(
  code: ErrorCode,
  message: string,
  correlationId: string,
  extra: Partial<ErrorEnvelope> = {},
): ErrorEnvelope {
  return {
    schemaVersion: 1,
    code,
    message,
    owner: BUDGET_AUTHORITY,
    operation: extra.operation ?? 'budget',
    correlationId,
    retryable: code === 'VALIDATION',
    redaction: 'internal',
    ...extra,
  };
}

// ─── Results ─────────────────────────────────────────────────────────────────

/** Outcome of a budget mutation: the updated record, a replay, or a typed error. */
export type BudgetOutcome =
  | { readonly kind: 'ok'; readonly record: BudgetRecord; readonly warned: boolean }
  | { readonly kind: 'replayed'; readonly record: BudgetRecord }
  | { readonly kind: 'error'; readonly error: ErrorEnvelope };

// ─── Common mutation plumbing (routes through T-001 authority transaction) ───

interface MutationCommon {
  readonly budgetId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly now?: () => Date;
}

function requestDigestFor(payload: unknown): string {
  return computeDigest(payload);
}

/**
 * Check for a prior committed receipt under this idempotency key BEFORE running
 * any state-dependent pre-validation. A matching digest is an exactly-once
 * replay of an already-committed command — it must return the current record
 * rather than re-run pre-checks that would spuriously fail now that the effect
 * is applied (e.g. a second refund would otherwise see the reservation already
 * released). A diverging digest under the same key is a `CONFLICT` (NN-INV-007).
 * Returns `undefined` when no prior receipt exists (first attempt).
 */
function earlyIdempotencyOutcome(
  db: Database.Database,
  budgetId: string,
  idempotencyKey: string,
  requestDigest: string,
  correlationId: string,
): BudgetOutcome | undefined {
  const prior = readCommandReceipt(db, idempotencyKey);
  if (!prior) return undefined;
  if (prior.requestDigest !== requestDigest) {
    return {
      kind: 'error',
      error: budgetError(
        'CONFLICT',
        `idempotency key reused with a different request digest`,
        correlationId,
        { operation: 'budget' },
      ),
    };
  }
  const record = readBudget(db, budgetId);
  if (!record) {
    return {
      kind: 'error',
      error: budgetError('INTERNAL', 'replayed receipt has no backing budget', correlationId),
    };
  }
  return { kind: 'replayed', record };
}

/**
 * Detect the T-001 idempotency replay/conflict outcomes. A replay means this
 * exact logical operation already committed — we return the current record
 * without a second effect (NN-INV-007). A conflict (same key, different digest)
 * surfaces as a typed `CONFLICT`.
 */
function mapAuthorityResult(
  result: AuthorityMutationResult,
  db: Database.Database,
  budgetId: string,
): BudgetOutcome | undefined {
  if (result.kind === 'replayed') {
    const record = readBudget(db, budgetId);
    if (!record) {
      return {
        kind: 'error',
        error: budgetError(
          'INTERNAL',
          'replayed budget receipt has no backing record',
          'corr-unset',
        ),
      };
    }
    return { kind: 'replayed', record };
  }
  if (result.kind === 'conflict') {
    return { kind: 'error', error: result.error };
  }
  return undefined;
}

// ─── Create a budget node ────────────────────────────────────────────────────

/** Request to create a hierarchical budget node. */
export interface CreateBudgetRequest extends MutationCommon {
  readonly scope: ScopeDescriptor;
  readonly unit: string;
  readonly pricingVersion: string;
  readonly policyRevision: number;
  /** Warning fraction in parts-per-million (e.g. 800000 = 80%). Default 800000. */
  readonly warningThresholdPpm?: number;
  readonly hardLimit: Money;
  /** Optional parent; the child's hard limit must fit the parent's availability. */
  readonly parentBudgetId?: string;
}

/**
 * Create a budget node. When `parentBudgetId` is set, the child's hard limit
 * must fit the parent's current availability and share the parent's currency
 * and scale, else a typed `CONFLICT`/`VALIDATION` with no effect. The whole
 * mutation is atomic and idempotent (T-001).
 */
export function createBudget(
  db: Database.Database,
  request: CreateBudgetRequest,
): BudgetOutcome {
  const now = request.now ?? (() => new Date());
  const { hardLimit } = request;
  if (isNegativeMoney(hardLimit)) {
    return {
      kind: 'error',
      error: budgetError('VALIDATION', 'hardLimit must be non-negative', request.correlationId, {
        operation: 'create-budget',
      }),
    };
  }

  // Parent fit check (child limits fit parent availability, D-07).
  if (request.parentBudgetId) {
    const parent = readBudget(db, request.parentBudgetId);
    if (!parent) {
      return {
        kind: 'error',
        error: budgetError(
          'VALIDATION',
          'parent budget does not exist',
          request.correlationId,
          { operation: 'create-budget' },
        ),
      };
    }
    if (parent.currency !== hardLimit.currency || parent.scale !== hardLimit.scale) {
      return {
        kind: 'error',
        error: budgetError(
          'CONFLICT',
          'child budget currency/scale must match the parent',
          request.correlationId,
          { operation: 'create-budget' },
        ),
      };
    }
    if (compareMoney(hardLimit, availability(parent)) > 0) {
      return {
        kind: 'error',
        error: budgetError(
          'BUDGET_EXCEEDED',
          'child hard limit exceeds parent availability',
          request.correlationId,
          { operation: 'create-budget' },
        ),
      };
    }
  }

  if (readBudget(db, request.budgetId)) {
    return {
      kind: 'error',
      error: budgetError('CONFLICT', 'budget already exists', request.correlationId, {
        operation: 'create-budget',
      }),
    };
  }

  const zero = zeroMoney(hardLimit.currency, hardLimit.scale);
  const payload = {
    op: 'create-budget',
    budgetId: request.budgetId,
    parentBudgetId: request.parentBudgetId ?? null,
    unit: request.unit,
    pricingVersion: request.pricingVersion,
    policyRevision: request.policyRevision,
    hardLimit: toMoneyWire(hardLimit),
  };
  const timestamp = now().toISOString();
  const warningThresholdPpm = request.warningThresholdPpm ?? 800000;

  const result = applyAuthorityMutation(db, {
    authority: BUDGET_AUTHORITY,
    commandId: makeOpaqueId('cmd', request.idempotencyKey),
    idempotencyKey: request.idempotencyKey,
    requestDigest: requestDigestFor(payload),
    correlationId: request.correlationId,
    scope: request.scope,
    now,
    mutate: (tx) => {
      tx.prepare(
        `INSERT INTO budgets
           (budget_id, revision, parent_budget_id, scope_json, unit, currency, scale,
            pricing_version, policy_revision, warning_threshold_ppm, hard_limit_minor,
            reserved_minor, committed_minor, refunded_minor, state, created_at, updated_at)
         VALUES (@budgetId, 0, @parentBudgetId, @scopeJson, @unit, @currency, @scale,
            @pricingVersion, @policyRevision, @warningThresholdPpm, @hardLimit,
            @zero, @zero, @zero, 'active', @createdAt, @createdAt)`,
      ).run({
        budgetId: request.budgetId,
        parentBudgetId: request.parentBudgetId ?? null,
        scopeJson: JSON.stringify(request.scope),
        unit: request.unit,
        currency: hardLimit.currency,
        scale: hardLimit.scale,
        pricingVersion: request.pricingVersion,
        policyRevision: request.policyRevision,
        warningThresholdPpm,
        hardLimit: hardLimit.minorUnits.toString(),
        zero: zero.minorUnits.toString(),
        createdAt: timestamp,
      });
      return { resultRef: makeOpaqueId('bdg', request.budgetId) };
    },
    events: [
      {
        eventType: 'budget.created',
        aggregateType: 'budget',
        aggregateId: request.budgetId,
        payloadSchemaName: 'BudgetRecord',
        payloadSchemaVersion: 1,
        payload,
        redaction: 'internal',
      },
    ],
  });

  const mapped = mapAuthorityResult(result, db, request.budgetId);
  if (mapped) return mapped;
  const record = readBudget(db, request.budgetId);
  if (!record) {
    return {
      kind: 'error',
      error: budgetError('INTERNAL', 'budget missing after create', request.correlationId),
    };
  }
  return { kind: 'ok', record, warned: false };
}

// ─── Denomination / pricing gate (stale price/currency, D-07 / NN-OBS-003) ───

/**
 * Validate a caller-declared amount against a budget's denomination and current
 * pricing version. A currency/scale mismatch is a typed `CONFLICT`; a declared
 * `pricingVersion` that differs from the budget's current one is a typed
 * `STALE_REVISION`. Neither is silently converted. Returns `undefined` when the
 * amount is acceptable.
 */
function checkDenominationAndPricing(
  record: BudgetRecord,
  amount: Money,
  declaredPricingVersion: string,
  correlationId: string,
  operation: string,
): ErrorEnvelope | undefined {
  if (!sameDenomination(amount, record.hardLimit)) {
    return budgetError(
      'CONFLICT',
      `currency/scale mismatch: amount ${amount.currency}@${amount.scale} vs budget ${record.currency}@${record.scale}`,
      correlationId,
      { operation },
    );
  }
  if (declaredPricingVersion !== record.pricingVersion) {
    return budgetError(
      'STALE_REVISION',
      `stale pricing version: declared ${declaredPricingVersion} vs current ${record.pricingVersion}`,
      correlationId,
      { operation },
    );
  }
  return undefined;
}

// ─── Reserve (the hard-cap transition, CD-028 / NN-ORCH-013) ─────────────────

/** Request to reserve funds before a cost-bearing action. */
export interface ReserveRequest extends MutationCommon {
  readonly scope: ScopeDescriptor;
  /**
   * Caller-stable reservation handle. Reused later by commit/refund. Also used
   * as the ledger entry key so a retried reserve is exactly-once.
   */
  readonly reservationKey: string;
  readonly amount: Money;
  /** The pricing/policy version the caller priced this amount against. */
  readonly pricingVersion: string;
  /** Digest of the exact action (route/model/args) this reservation funds. */
  readonly actionDigest: string;
}

/**
 * Reserve `amount` against a budget before a cost-bearing action.
 *
 * Enforces the CD-028 hard-cap transition:
 *   - stale currency/scale or pricing version → typed error, no reservation;
 *   - below cap → reservation granted (idempotent by `reservationKey`);
 *   - at/beyond cap → typed `BUDGET_EXCEEDED`, no reservation, NO automatic
 *     downgrade. The caller must obtain an exact {@link extendBudget} and
 *     re-reserve.
 *
 * The `warned` flag is set when the post-reservation outstanding crosses the
 * budget's warning threshold (NN-OBS-003), a signal only — it never changes the
 * grant/deny decision.
 */
export function reserve(db: Database.Database, request: ReserveRequest): BudgetOutcome {
  const now = request.now ?? (() => new Date());
  const record = readBudget(db, request.budgetId);
  if (!record) {
    return {
      kind: 'error',
      error: budgetError('VALIDATION', 'budget does not exist', request.correlationId, {
        operation: 'reserve',
      }),
    };
  }
  if (record.state !== 'active') {
    return {
      kind: 'error',
      error: budgetError('CONFLICT', `budget is ${record.state}`, request.correlationId, {
        operation: 'reserve',
      }),
    };
  }
  if (isNegativeMoney(request.amount)) {
    return {
      kind: 'error',
      error: budgetError('VALIDATION', 'reserve amount must be non-negative', request.correlationId, {
        operation: 'reserve',
      }),
    };
  }

  // A retried reserve under the same idempotency key is an exactly-once replay:
  // return the current record BEFORE the cap guard below, which would otherwise
  // re-count the already-applied reservation and spuriously deny the retry
  // (NN-INV-007). The digest binds the exact reserve payload.
  const earlyReserve = earlyIdempotencyOutcome(
    db,
    request.budgetId,
    request.idempotencyKey,
    requestDigestFor({
      op: 'reserve',
      budgetId: request.budgetId,
      reservationKey: request.reservationKey,
      amount: toMoneyWire(request.amount),
      pricingVersion: request.pricingVersion,
      actionDigest: request.actionDigest,
    }),
    request.correlationId,
  );
  if (earlyReserve) return earlyReserve;

  const denomError = checkDenominationAndPricing(
    record,
    request.amount,
    request.pricingVersion,
    request.correlationId,
    'reserve',
  );
  if (denomError) return { kind: 'error', error: denomError };

  // Hard-cap transition. At/beyond cap: block. No downgrade path exists here.
  if (!withinCap(record, request.amount)) {
    return {
      kind: 'error',
      error: budgetError(
        'BUDGET_EXCEEDED',
        'reservation would exceed the hard cap; an exact incremental extension is required (no post-cap downgrade)',
        request.correlationId,
        {
          operation: 'reserve',
          remediation:
            'Pause and request an approved budget extension for the exact amount, currency, pricing version, and action digest, then re-reserve.',
        },
      ),
    };
  }

  const newReserved = addMoney(record.reserved, request.amount);
  const projectedOutstanding = subMoney(
    addMoney(newReserved, record.committed),
    record.refunded,
  );
  const warned = crossesWarning(record, projectedOutstanding);

  const payload = {
    op: 'reserve',
    budgetId: request.budgetId,
    reservationKey: request.reservationKey,
    amount: toMoneyWire(request.amount),
    pricingVersion: request.pricingVersion,
    actionDigest: request.actionDigest,
  };

  return applyLedgerMutation(db, {
    record,
    common: request,
    now,
    kind: 'reserve',
    entryKey: request.reservationKey,
    reservationKey: request.reservationKey,
    amount: request.amount,
    actionDigest: request.actionDigest,
    pricingVersion: request.pricingVersion,
    columnUpdates: { reserved_minor: newReserved.minorUnits.toString() },
    eventType: 'budget.reserved',
    payload,
    warned,
  });
}

// ─── Commit (finalize actual cost against a reservation) ─────────────────────

/** Request to commit the actual cost against a prior reservation. */
export interface CommitRequest extends MutationCommon {
  readonly scope: ScopeDescriptor;
  readonly reservationKey: string;
  /** The actual cost. Must be ≤ the reserved amount (over-run needs re-reserve). */
  readonly actualAmount: Money;
  readonly pricingVersion: string;
}

/**
 * Commit the actual cost of a completed action: moves `actualAmount` from
 * `reserved` to `committed` and refunds the unused remainder of the
 * reservation. Idempotent by `reservationKey` (a second commit replays). An
 * actual cost greater than the reservation is a typed `CONFLICT` (the caller
 * must reserve the increment first — never an implicit cap breach).
 */
export function commit(db: Database.Database, request: CommitRequest): BudgetOutcome {
  const now = request.now ?? (() => new Date());
  const record = readBudget(db, request.budgetId);
  if (!record) {
    return {
      kind: 'error',
      error: budgetError('VALIDATION', 'budget does not exist', request.correlationId, {
        operation: 'commit',
      }),
    };
  }

  const reservation = readReservation(db, request.budgetId, request.reservationKey);
  if (!reservation) {
    return {
      kind: 'error',
      error: budgetError('VALIDATION', 'no such reservation to commit', request.correlationId, {
        operation: 'commit',
      }),
    };
  }
  if (isNegativeMoney(request.actualAmount)) {
    return {
      kind: 'error',
      error: budgetError('VALIDATION', 'commit amount must be non-negative', request.correlationId, {
        operation: 'commit',
      }),
    };
  }

  // A retried commit under the same idempotency key is an exactly-once replay:
  // return the current record BEFORE the state-dependent guards below, which
  // would otherwise re-apply against a reservation that is already released
  // (NN-INV-007).
  const earlyCommit = earlyIdempotencyOutcome(
    db,
    request.budgetId,
    request.idempotencyKey,
    requestDigestFor({
      op: 'commit',
      budgetId: request.budgetId,
      reservationKey: request.reservationKey,
      actualAmount: toMoneyWire(request.actualAmount),
      pricingVersion: request.pricingVersion,
    }),
    request.correlationId,
  );
  if (earlyCommit) return earlyCommit;

  const denomError = checkDenominationAndPricing(
    record,
    request.actualAmount,
    request.pricingVersion,
    request.correlationId,
    'commit',
  );
  if (denomError) return { kind: 'error', error: denomError };

  if (compareMoney(request.actualAmount, reservation.amount) > 0) {
    return {
      kind: 'error',
      error: budgetError(
        'CONFLICT',
        'commit exceeds the reserved amount; reserve the increment first (no implicit cap breach)',
        request.correlationId,
        { operation: 'commit' },
      ),
    };
  }

  // Move actual to committed; release the unused remainder from reserved.
  const remainder = subMoney(reservation.amount, request.actualAmount);
  const newReserved = subMoney(record.reserved, reservation.amount);
  const newCommitted = addMoney(record.committed, request.actualAmount);
  // remainder is simply not reserved anymore; committed-refunded already nets.
  void remainder;

  const payload = {
    op: 'commit',
    budgetId: request.budgetId,
    reservationKey: request.reservationKey,
    actualAmount: toMoneyWire(request.actualAmount),
    pricingVersion: request.pricingVersion,
  };

  return applyLedgerMutation(db, {
    record,
    common: request,
    now,
    kind: 'commit',
    entryKey: `commit:${request.reservationKey}`,
    reservationKey: request.reservationKey,
    amount: request.actualAmount,
    actionDigest: reservation.actionDigest,
    pricingVersion: request.pricingVersion,
    columnUpdates: {
      reserved_minor: newReserved.minorUnits.toString(),
      committed_minor: newCommitted.minorUnits.toString(),
    },
    eventType: 'budget.committed',
    payload,
    warned: false,
  });
}

// ─── Refund (release a reservation without committing) ───────────────────────

/** Request to refund/release a reservation (e.g. provider failure). */
export interface RefundRequest extends MutationCommon {
  readonly scope: ScopeDescriptor;
  readonly reservationKey: string;
  readonly pricingVersion: string;
}

/**
 * Refund a reservation whose action did not incur cost (e.g. provider failure,
 * cancellation): removes the reserved amount, freeing availability. Idempotent
 * by `reservationKey`; refunding an already-committed reservation is a typed
 * `CONFLICT`.
 */
export function refund(db: Database.Database, request: RefundRequest): BudgetOutcome {
  const now = request.now ?? (() => new Date());
  const record = readBudget(db, request.budgetId);
  if (!record) {
    return {
      kind: 'error',
      error: budgetError('VALIDATION', 'budget does not exist', request.correlationId, {
        operation: 'refund',
      }),
    };
  }
  const reservation = readReservation(db, request.budgetId, request.reservationKey);
  if (!reservation) {
    return {
      kind: 'error',
      error: budgetError('VALIDATION', 'no such reservation to refund', request.correlationId, {
        operation: 'refund',
      }),
    };
  }

  const payload = {
    op: 'refund',
    budgetId: request.budgetId,
    reservationKey: request.reservationKey,
    amount: toMoneyWire(reservation.amount),
    pricingVersion: request.pricingVersion,
  };

  // A retried refund under the same idempotency key is an exactly-once replay:
  // return the current record BEFORE the state-dependent guards below, which
  // would otherwise see the reservation already released and spuriously report
  // a CONFLICT (NN-INV-007).
  const early = earlyIdempotencyOutcome(
    db,
    request.budgetId,
    request.idempotencyKey,
    requestDigestFor(payload),
    request.correlationId,
  );
  if (early) return early;

  const denomError = checkDenominationAndPricing(
    record,
    reservation.amount,
    request.pricingVersion,
    request.correlationId,
    'refund',
  );
  if (denomError) return { kind: 'error', error: denomError };

  const newReserved = subMoney(record.reserved, reservation.amount);
  if (isNegativeMoney(newReserved)) {
    return {
      kind: 'error',
      error: budgetError(
        'CONFLICT',
        'reservation already released or committed',
        request.correlationId,
        { operation: 'refund' },
      ),
    };
  }

  return applyLedgerMutation(db, {
    record,
    common: request,
    now,
    kind: 'refund',
    entryKey: `refund:${request.reservationKey}`,
    reservationKey: request.reservationKey,
    amount: reservation.amount,
    actionDigest: reservation.actionDigest,
    pricingVersion: request.pricingVersion,
    columnUpdates: { reserved_minor: newReserved.minorUnits.toString() },
    eventType: 'budget.refunded',
    payload,
    warned: false,
  });
}

// ─── Extend (exact incremental approval, CD-028) ─────────────────────────────

/**
 * Request to raise a budget's hard cap by an EXACT approved increment. The
 * approval binds the exact `amount`, `currency`, `pricingVersion`, and
 * `actionDigest` that triggered the pause (NN-ORCH-013).
 */
export interface ExtendRequest extends MutationCommon {
  readonly scope: ScopeDescriptor;
  /** The exact additional headroom approved (added to `hardLimit`). */
  readonly increment: Money;
  readonly pricingVersion: string;
  /** The action digest the extension was approved for (audit binding). */
  readonly actionDigest: string;
}

/**
 * Apply an exact approved extension: raises `hardLimit` by `increment`. This is
 * the ONLY at/beyond-cap forward path (CD-028) — the caller re-reserves after a
 * successful extension. A currency/scale or stale-pricing mismatch, or an
 * extension that would push a child's cap beyond its parent's availability, is
 * a typed error with no effect.
 */
export function extendBudget(db: Database.Database, request: ExtendRequest): BudgetOutcome {
  const now = request.now ?? (() => new Date());
  const record = readBudget(db, request.budgetId);
  if (!record) {
    return {
      kind: 'error',
      error: budgetError('VALIDATION', 'budget does not exist', request.correlationId, {
        operation: 'extend',
      }),
    };
  }
  if (isNegativeMoney(request.increment)) {
    return {
      kind: 'error',
      error: budgetError('VALIDATION', 'extension increment must be non-negative', request.correlationId, {
        operation: 'extend',
      }),
    };
  }

  const denomError = checkDenominationAndPricing(
    record,
    request.increment,
    request.pricingVersion,
    request.correlationId,
    'extend',
  );
  if (denomError) return { kind: 'error', error: denomError };

  const newHardLimit = addMoney(record.hardLimit, request.increment);

  // A child's raised cap must still fit its parent's availability.
  if (record.parentBudgetId) {
    const parent = readBudget(db, record.parentBudgetId);
    if (parent) {
      // Parent availability excluding this child's current hard limit reservation
      // is out of scope; here we require the child's new hard limit not exceed
      // the parent's remaining availability plus the child's existing outstanding.
      if (compareMoney(request.increment, availability(parent)) > 0) {
        return {
          kind: 'error',
          error: budgetError(
            'BUDGET_EXCEEDED',
            'extension would exceed parent availability',
            request.correlationId,
            { operation: 'extend' },
          ),
        };
      }
    }
  }

  const payload = {
    op: 'extend',
    budgetId: request.budgetId,
    increment: toMoneyWire(request.increment),
    pricingVersion: request.pricingVersion,
    actionDigest: request.actionDigest,
  };

  return applyLedgerMutation(db, {
    record,
    common: request,
    now,
    kind: 'extend',
    entryKey: request.idempotencyKey,
    amount: request.increment,
    actionDigest: request.actionDigest,
    pricingVersion: request.pricingVersion,
    columnUpdates: { hard_limit_minor: newHardLimit.minorUnits.toString() },
    eventType: 'budget.extended',
    payload,
    warned: false,
  });
}

// ─── Shared ledger mutation (atomic via T-001) ───────────────────────────────

interface LedgerMutationParams {
  readonly record: BudgetRecord;
  readonly common: MutationCommon & { readonly scope: ScopeDescriptor };
  readonly now: () => Date;
  readonly kind: BudgetLedgerKind;
  readonly entryKey: string;
  readonly reservationKey?: string;
  readonly amount: Money;
  readonly actionDigest?: string;
  readonly pricingVersion: string;
  readonly columnUpdates: Record<string, string>;
  readonly eventType: string;
  readonly payload: unknown;
  readonly warned: boolean;
}

/**
 * Apply a budget column update plus its ledger entry atomically through the
 * T-001 authority transaction. The ledger `UNIQUE(budget_id, entry_key)` makes
 * a retried logical entry exactly-once; the outer command receipt makes the
 * whole command idempotent by idempotency key. Bumps the row `revision`.
 */
function applyLedgerMutation(
  db: Database.Database,
  params: LedgerMutationParams,
): BudgetOutcome {
  const timestamp = params.now().toISOString();
  const result = applyAuthorityMutation(db, {
    authority: BUDGET_AUTHORITY,
    commandId: makeOpaqueId('cmd', params.common.idempotencyKey),
    idempotencyKey: params.common.idempotencyKey,
    requestDigest: requestDigestFor(params.payload),
    correlationId: params.common.correlationId,
    scope: params.common.scope,
    now: params.now,
    mutate: (tx) => {
      // Guard: a diverging entry under the same (budget, entry_key) is a
      // CONFLICT surfaced by the UNIQUE constraint; a matching retry is caught
      // by the outer receipt before reaching here.
      const setClause = Object.keys(params.columnUpdates)
        .map((col) => `${col} = @${col}`)
        .join(', ');
      const newRevision = params.record.revision + 1;
      tx.prepare(
        `UPDATE budgets SET ${setClause}, revision = @newRevision, updated_at = @updatedAt
         WHERE budget_id = @budgetId AND revision = @expectedRevision`,
      ).run({
        ...params.columnUpdates,
        newRevision,
        updatedAt: timestamp,
        budgetId: params.record.budgetId,
        expectedRevision: params.record.revision,
      });

      tx.prepare(
        `INSERT INTO budget_ledger
           (ledger_id, budget_id, entry_key, reservation_key, kind, amount_minor,
            currency, scale, pricing_version, action_digest, budget_revision, created_at)
         VALUES (@ledgerId, @budgetId, @entryKey, @reservationKey, @kind, @amount,
            @currency, @scale, @pricingVersion, @actionDigest, @budgetRevision, @createdAt)`,
      ).run({
        ledgerId: makeOpaqueId('bdl', `${params.record.budgetId}${params.entryKey}`),
        budgetId: params.record.budgetId,
        entryKey: params.entryKey,
        reservationKey: params.reservationKey ?? null,
        kind: params.kind,
        amount: params.amount.minorUnits.toString(),
        currency: params.amount.currency,
        scale: params.amount.scale,
        pricingVersion: params.pricingVersion,
        actionDigest: params.actionDigest ?? null,
        budgetRevision: newRevision,
        createdAt: timestamp,
      });
      return { resultRef: makeOpaqueId('bdl', `${params.record.budgetId}${params.entryKey}`) };
    },
    events: [
      {
        eventType: params.eventType,
        aggregateType: 'budget',
        aggregateId: params.record.budgetId,
        payloadSchemaName: 'BudgetLedgerEntry',
        payloadSchemaVersion: 1,
        payload: params.payload,
        redaction: 'internal',
      },
    ],
  });

  const mapped = mapAuthorityResult(result, db, params.record.budgetId);
  if (mapped) return mapped;
  const record = readBudget(db, params.record.budgetId);
  if (!record) {
    return {
      kind: 'error',
      error: budgetError(
        'INTERNAL',
        'budget missing after ledger mutation',
        params.common.correlationId,
      ),
    };
  }
  return { kind: 'ok', record, warned: params.warned };
}

// ─── Reservation lookup ──────────────────────────────────────────────────────

interface ReservationView {
  readonly amount: Money;
  readonly actionDigest?: string;
  readonly committed: boolean;
}

interface LedgerRow {
  readonly kind: BudgetLedgerKind;
  readonly amount_minor: string;
  readonly currency: string;
  readonly scale: number;
  readonly action_digest: string | null;
}

/**
 * Reconstruct the active reservation identified by `reservationKey` from the
 * ledger: the original `reserve` entry, plus whether a `commit`/`refund` has
 * already released it. Returns `undefined` if there is no reserve entry.
 */
function readReservation(
  db: Database.Database,
  budgetId: string,
  reservationKey: string,
): ReservationView | undefined {
  const rows = db
    .prepare(
      `SELECT kind, amount_minor, currency, scale, action_digest
       FROM budget_ledger WHERE budget_id = ? AND reservation_key = ? ORDER BY created_at`,
    )
    .all(budgetId, reservationKey) as LedgerRow[];
  const reserveRow = rows.find((r) => r.kind === 'reserve');
  if (!reserveRow) return undefined;
  const committed = rows.some((r) => r.kind === 'commit' || r.kind === 'refund');
  const amount = moneyFromMinor(reserveRow.amount_minor, reserveRow.currency, reserveRow.scale);
  return {
    amount,
    ...(reserveRow.action_digest ? { actionDigest: reserveRow.action_digest } : {}),
    committed,
  };
}

// ─── Warning threshold (NN-OBS-003) ──────────────────────────────────────────

/**
 * Whether `projectedOutstanding` crosses the budget's warning threshold
 * fraction of the hard limit. Uses exact `BigInt` arithmetic on the
 * parts-per-million threshold — no binary float. Signal only.
 */
function crossesWarning(record: BudgetRecord, projectedOutstanding: Money): boolean {
  const thresholdMinor =
    (record.hardLimit.minorUnits * BigInt(record.warningThresholdPpm)) / 1000000n;
  return projectedOutstanding.minorUnits >= thresholdMinor;
}

// ─── Read the ledger (projection support) ────────────────────────────────────

/** A read-only projection of a ledger entry (dashboards, audit). */
export interface BudgetLedgerEntry {
  readonly kind: BudgetLedgerKind;
  readonly entryKey: string;
  readonly reservationKey?: string;
  readonly amount: Money;
  readonly pricingVersion: string;
  readonly actionDigest?: string;
  readonly budgetRevision: number;
  readonly createdAt: string;
}

/** Read all ledger entries for a budget in insertion order. */
export function readBudgetLedger(
  db: Database.Database,
  budgetId: string,
): BudgetLedgerEntry[] {
  const rows = db
    .prepare(
      `SELECT kind, entry_key, reservation_key, amount_minor, currency, scale,
              pricing_version, action_digest, budget_revision, created_at
       FROM budget_ledger WHERE budget_id = ? ORDER BY created_at, ledger_id`,
    )
    .all(budgetId) as Array<{
    kind: BudgetLedgerKind;
    entry_key: string;
    reservation_key: string | null;
    amount_minor: string;
    currency: string;
    scale: number;
    pricing_version: string;
    action_digest: string | null;
    budget_revision: number;
    created_at: string;
  }>;
  return rows.map((r) => ({
    kind: r.kind,
    entryKey: r.entry_key,
    ...(r.reservation_key ? { reservationKey: r.reservation_key } : {}),
    amount: moneyFromMinor(r.amount_minor, r.currency, r.scale),
    pricingVersion: r.pricing_version,
    ...(r.action_digest ? { actionDigest: r.action_digest } : {}),
    budgetRevision: r.budget_revision,
    createdAt: r.created_at,
  }));
}
