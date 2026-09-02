/**
 * Subscription Lifecycle — idempotent Stripe entitlement processing
 * (FUT-PKG-04-SECURITY/T-003).
 *
 * Implements the Stripe subscription lifecycle (NN-LICENSE-007/008) over the
 * single-writer authority transaction (`applyAuthorityMutation`,
 * FUT-PKG-03-DURABILITY/T-001):
 *
 *   - **Idempotent webhook processing (NN-LICENSE-007;
 *     V-LICENSE-001/subscription-idempotency).** Each Stripe event carries a
 *     stable `eventId` used as the idempotency key. Processing an event is a
 *     durable authority mutation: created/updated/paid/canceled/deleted/past-due
 *     transitions update the entitlement/subscription record and emit exactly
 *     one outbox event *exactly once*. A redelivery of the same event id
 *     replays the prior receipt with no duplicated effect; a *different* event
 *     body under the same id is a `CONFLICT` (no last-writer-wins). This holds
 *     across retries, reconnects, and restarts (NN-INV-007).
 *
 *   - **Signature verification / authenticated endpoints (NN-LICENSE-007).**
 *     The raw webhook signature is verified through an injected verifier before
 *     any effect; an unverified payload is rejected with no mutation. The
 *     Stripe subscription id is a distinct credential class and is never reused
 *     (NN-LICENSE-001).
 *
 *   - **Cancellation / upgrade evidence preservation (NN-LICENSE-008;
 *     NN-UI-014).** A cancel/upgrade updates the service authority *before* the
 *     UI projection and never erases credential/subscription evidence before
 *     confirmation: prior states are retained in the durable transition log so
 *     recoverable UI state survives a failure.
 *
 *   - **Fail-closed cloud posture (NN-CLOUD-004).** Authentication, entitlement,
 *     secret, payment, or mutating workflow failure fails closed; there is no
 *     optimistic "accepted HTTP == success" path (D-18 false-success prevention).
 *
 * The subscription record is the current-state authority row; the outbox event
 * feeds history/projections (D-04, D-06 outbox). The processor does not fake
 * distributed atomicity — the row, the receipt, and the outbox event commit in
 * one transaction (D-04 saga note).
 *
 * Design anchors: D-04 (entitlement/subscription authority), D-07
 * (CommandReceipt@1/OutboxRecord@1), D-18 (idempotency/fail-closed),
 * D-20 (subscription evidence preservation).
 * Requirements: NN-LICENSE-001/007/008, NN-INV-003/007/008, NN-UI-014,
 * NN-CLOUD-001/002/004/006, CD-005.
 */

import type Database from 'better-sqlite3';

import { z } from 'zod';

import {
  CONTRACT_WRITE_VERSION,
  computeDigest,
  makeOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
  type ScopeDescriptor,
} from '../shared/contract-primitives';
import {
  applyAuthorityMutation,
  ensureAuthorityTables,
  type AuthorityMutationResult,
} from '../storage/authority-transaction';
import { EntitlementPlanSchema, type EntitlementPlan } from './entitlement-authority';

// ─── Stripe event model ──────────────────────────────────────────────────────

/**
 * The Stripe lifecycle event types this processor maps to entitlement
 * transitions (NN-LICENSE-007). Names mirror Stripe's event families.
 */
export const STRIPE_EVENT_TYPES = Object.freeze([
  'customer.subscription.created',
  'customer.subscription.updated',
  'invoice.paid',
  'customer.subscription.canceled',
  'customer.subscription.deleted',
  'invoice.payment_failed', // past-due
] as const);
export type StripeEventType = (typeof STRIPE_EVENT_TYPES)[number];
export const StripeEventTypeSchema = z.enum(STRIPE_EVENT_TYPES);

/** The normalized, validated Stripe event body. */
export const StripeEventSchema = z.strictObject({
  /** Stripe event id (e.g. `evt_...`); the idempotency key. */
  eventId: z.string().min(3).max(256),
  type: StripeEventTypeSchema,
  /** Stripe subscription id (distinct credential class; NN-LICENSE-001). */
  subscriptionId: z.string().min(3).max(256),
  /** The account this subscription belongs to. */
  accountId: z.string().min(1).max(256),
  /** The plan the subscription resolves to after this event. */
  plan: EntitlementPlanSchema,
  /** Stripe-configured price id used for the transition (evidence). */
  priceId: z.string().min(1).max(256),
  /** Event creation time (epoch seconds), for ordering diagnostics. */
  createdAtEpoch: z.number().int().nonnegative().finite(),
});
export type StripeEvent = z.infer<typeof StripeEventSchema>;

/** The resulting subscription entitlement state after applying an event. */
export const SUBSCRIPTION_STATES = Object.freeze([
  'active',
  'canceled',
  'deleted',
  'past-due',
] as const);
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

/** Map an event type to the resulting subscription state. */
export function stateForEvent(type: StripeEventType): SubscriptionState {
  switch (type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'invoice.paid':
      return 'active';
    case 'customer.subscription.canceled':
      return 'canceled';
    case 'customer.subscription.deleted':
      return 'deleted';
    case 'invoice.payment_failed':
      return 'past-due';
  }
}

// ─── Signature verification (injected) ──────────────────────────────────────

/**
 * Verifies a raw Stripe webhook payload+signature. Production wires Stripe's
 * signing-secret HMAC scheme; tests inject a deterministic verifier. The raw
 * signing secret never appears here (it is resolved through the
 * CredentialService at the boundary).
 */
export interface WebhookSignatureVerifier {
  verify(rawBody: string, signatureHeader: string): boolean;
}

// ─── Persistence: subscription current-state table (additive) ───────────────

/**
 * Create the additive subscription current-state table. This is a NEW canonical
 * business table owned by the Entitlement Authority; it never becomes a second
 * writer for an existing table (NN-INV-008, D-20 "add typed records and read
 * adapters before cutover"). Idempotent.
 */
export function ensureSubscriptionTables(db: Database.Database): void {
  ensureAuthorityTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscription_entitlements (
      subscription_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      plan TEXT NOT NULL,
      state TEXT NOT NULL,
      price_id TEXT NOT NULL,
      last_event_id TEXT NOT NULL,
      last_event_type TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at_epoch INTEGER NOT NULL
    );
    -- Append-only transition log so cancellation/upgrade never erases prior
    -- subscription evidence before confirmation (NN-LICENSE-008, D-20).
    CREATE TABLE IF NOT EXISTS subscription_transitions (
      transition_id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      from_plan TEXT,
      to_plan TEXT NOT NULL,
      recorded_at_epoch INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sub_transitions_sub
      ON subscription_transitions (subscription_id, recorded_at_epoch);
  `);
}

/** The current subscription entitlement row (read projection). */
export interface SubscriptionRecord {
  readonly subscriptionId: string;
  readonly accountId: string;
  readonly plan: EntitlementPlan;
  readonly state: SubscriptionState;
  readonly priceId: string;
  readonly lastEventId: string;
  readonly lastEventType: StripeEventType;
  readonly revision: number;
  readonly updatedAtEpoch: number;
}

/** Read the current subscription record, or `undefined`. */
export function readSubscription(
  db: Database.Database,
  subscriptionId: string,
): SubscriptionRecord | undefined {
  const row = db
    .prepare(
      `SELECT subscription_id, account_id, plan, state, price_id, last_event_id,
              last_event_type, revision, updated_at_epoch
       FROM subscription_entitlements WHERE subscription_id = ?`,
    )
    .get(subscriptionId) as
    | {
        subscription_id: string;
        account_id: string;
        plan: EntitlementPlan;
        state: SubscriptionState;
        price_id: string;
        last_event_id: string;
        last_event_type: StripeEventType;
        revision: number;
        updated_at_epoch: number;
      }
    | undefined;
  if (!row) return undefined;
  return {
    subscriptionId: row.subscription_id,
    accountId: row.account_id,
    plan: row.plan,
    state: row.state,
    priceId: row.price_id,
    lastEventId: row.last_event_id,
    lastEventType: row.last_event_type,
    revision: row.revision,
    updatedAtEpoch: row.updated_at_epoch,
  };
}

/** Count the retained transition-log rows for a subscription (evidence). */
export function countTransitions(db: Database.Database, subscriptionId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM subscription_transitions WHERE subscription_id = ?')
    .get(subscriptionId) as { n: number };
  return row.n;
}

// ─── Typed errors / results ──────────────────────────────────────────────────

const AUTHORITY_OWNER = 'authority-entitlement';

function subscriptionError(
  code: ErrorCode,
  message: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: AUTHORITY_OWNER,
    operation: 'subscription-webhook',
    correlationId: correlationId ?? 'corr-unset',
    retryable: code === 'UNAVAILABLE',
    redaction: 'internal',
  };
}

/** The outcome of processing a webhook event. */
export type ProcessResult =
  | { readonly kind: 'applied'; readonly record: SubscriptionRecord; readonly authorityRevision: number }
  | { readonly kind: 'replayed'; readonly record: SubscriptionRecord }
  | { readonly kind: 'conflict'; readonly error: ErrorEnvelope }
  | { readonly kind: 'rejected'; readonly error: ErrorEnvelope };

// ─── The processor ───────────────────────────────────────────────────────────

export interface SubscriptionLifecycleOptions {
  readonly db: Database.Database;
  readonly verifier: WebhookSignatureVerifier;
  /** The user/scope the entitlement authority writes under. */
  readonly scope: ScopeDescriptor;
  readonly now?: () => Date;
}

export class SubscriptionLifecycle {
  private readonly db: Database.Database;
  private readonly verifier: WebhookSignatureVerifier;
  private readonly scope: ScopeDescriptor;
  private readonly now: () => Date;

  constructor(options: SubscriptionLifecycleOptions) {
    this.db = options.db;
    this.verifier = options.verifier;
    this.scope = options.scope;
    this.now = options.now ?? (() => new Date());
    ensureSubscriptionTables(this.db);
  }

  /**
   * Verify and process a raw Stripe webhook (NN-LICENSE-007). The signature is
   * checked first; an unverified payload is rejected with no effect
   * (fail closed, NN-CLOUD-004). A valid event is then applied idempotently.
   */
  handleWebhook(
    rawBody: string,
    signatureHeader: string,
    options: { correlationId?: string } = {},
  ): ProcessResult {
    if (!this.verifier.verify(rawBody, signatureHeader)) {
      return { kind: 'rejected', error: subscriptionError('UNAUTHORIZED', 'webhook signature did not verify', options.correlationId) };
    }
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return { kind: 'rejected', error: subscriptionError('VALIDATION', 'webhook body is not valid JSON', options.correlationId) };
    }
    const parsed = StripeEventSchema.safeParse(json);
    if (!parsed.success) {
      return { kind: 'rejected', error: subscriptionError('VALIDATION', 'webhook event failed schema validation', options.correlationId) };
    }
    return this.applyEvent(parsed.data, options);
  }

  /**
   * Apply a validated event as a durable, idempotent authority mutation
   * (NN-INV-007). The event id is the idempotency key and its canonical digest
   * distinguishes a replay from a conflicting re-use. The current-state row is
   * upserted, an append-only transition is logged (preserving prior evidence),
   * and exactly one outbox event is emitted — all in one transaction.
   */
  applyEvent(event: StripeEvent, options: { correlationId?: string } = {}): ProcessResult {
    const correlationId = options.correlationId ?? makeOpaqueId('corr', event.eventId);
    const requestDigest = computeDigest(event);
    const toState = stateForEvent(event.type);
    const nowEpoch = Math.floor(this.now().getTime() / 1000);

    const mutation: AuthorityMutationResult = applyAuthorityMutation(this.db, {
      authority: AUTHORITY_OWNER,
      commandId: makeOpaqueId('cmd', event.eventId),
      idempotencyKey: `stripe:${event.eventId}`,
      requestDigest,
      correlationId,
      scope: this.scope,
      now: this.now,
      mutate: (tx) => {
        const prior = readSubscription(tx, event.subscriptionId);
        const nextRevision = (prior?.revision ?? 0) + 1;

        // Append-only transition log FIRST — never erase prior evidence
        // (NN-LICENSE-008, D-20). Retains from-state/from-plan for recovery.
        tx.prepare(
          `INSERT INTO subscription_transitions
             (transition_id, subscription_id, event_id, event_type, from_state,
              to_state, from_plan, to_plan, recorded_at_epoch)
           VALUES (@transitionId, @subscriptionId, @eventId, @eventType, @fromState,
              @toState, @fromPlan, @toPlan, @recordedAtEpoch)`,
        ).run({
          transitionId: makeOpaqueId('subx', `${event.eventId}${nextRevision}`),
          subscriptionId: event.subscriptionId,
          eventId: event.eventId,
          eventType: event.type,
          fromState: prior?.state ?? null,
          toState,
          fromPlan: prior?.plan ?? null,
          toPlan: event.plan,
          recordedAtEpoch: nowEpoch,
        });

        // Upsert the current-state authority row (service authority updated
        // before any UI projection; NN-LICENSE-008).
        tx.prepare(
          `INSERT INTO subscription_entitlements
             (subscription_id, account_id, plan, state, price_id, last_event_id,
              last_event_type, revision, updated_at_epoch)
           VALUES (@subscriptionId, @accountId, @plan, @state, @priceId, @lastEventId,
              @lastEventType, @revision, @updatedAtEpoch)
           ON CONFLICT(subscription_id) DO UPDATE SET
             account_id = excluded.account_id,
             plan = excluded.plan,
             state = excluded.state,
             price_id = excluded.price_id,
             last_event_id = excluded.last_event_id,
             last_event_type = excluded.last_event_type,
             revision = excluded.revision,
             updated_at_epoch = excluded.updated_at_epoch`,
        ).run({
          subscriptionId: event.subscriptionId,
          accountId: event.accountId,
          plan: event.plan,
          state: toState,
          priceId: event.priceId,
          lastEventId: event.eventId,
          lastEventType: event.type,
          revision: nextRevision,
          updatedAtEpoch: nowEpoch,
        });

        return { resultRef: makeOpaqueId('sub', event.subscriptionId) };
      },
      events: [
        {
          eventType: `entitlement.subscription.${toState}`,
          aggregateType: 'subscription',
          aggregateId: event.subscriptionId,
          payloadSchemaName: 'SubscriptionTransition',
          payloadSchemaVersion: 1,
          // No secret in the payload — the subscription id is a reference, not
          // a bearer secret; the plan/state are display facts.
          payload: {
            subscriptionId: event.subscriptionId,
            accountId: event.accountId,
            plan: event.plan,
            state: toState,
            eventType: event.type,
          },
          redaction: 'internal',
        },
      ],
    });

    if (mutation.kind === 'conflict') {
      return { kind: 'conflict', error: mutation.error };
    }
    if (mutation.kind === 'replayed') {
      const record = readSubscription(this.db, event.subscriptionId);
      // The record must exist because a receipt exists; guard defensively.
      if (!record) {
        return { kind: 'rejected', error: subscriptionError('INTEGRITY', 'replay receipt without a subscription row', correlationId) };
      }
      return { kind: 'replayed', record };
    }
    const record = readSubscription(this.db, event.subscriptionId);
    if (!record) {
      return { kind: 'rejected', error: subscriptionError('INTEGRITY', 'committed mutation without a subscription row', correlationId) };
    }
    return { kind: 'applied', record, authorityRevision: mutation.authorityRevision };
  }
}
