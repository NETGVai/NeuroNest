/**
 * Approval contracts — `ApprovalRequest@1` / `ApprovalDecision@1` schemas and
 * the normalized exact digest that binds a decision to a request
 * (FUT-PKG-04-SECURITY/T-006).
 *
 * D-07 / D-16 / CD-010 / CD-030 require that a human approval authorizes ONLY
 * the exact normalized action it was shown, and nothing else. This module owns
 * the two schema-versioned records and the single normalization+digest
 * function that all authorization decisions bind to:
 *
 *   - {@link ApprovalRequest} — `ApprovalRequest@1`: the durable, schema-versioned
 *     request with scope, actor, kind, the exact action/arguments digest, risk,
 *     options, context references, plan revision, creation/expiry, state, and
 *     idempotency key (NN-APPROVAL-001).
 *   - {@link ApprovalDecision} — `ApprovalDecision@1`: the durable typed decision
 *     that carries the bound request digest it authorizes. A decision authorizes
 *     ONLY the normalized action, arguments, scope, risk, owner, plan revision,
 *     and expiry captured in that digest; any change invalidates it
 *     (NN-APPROVAL-002).
 *   - {@link computeApprovalDigest} — the ONE normalized digest. Two structurally
 *     equal requests (regardless of argument key order) produce the same digest;
 *     any change to a bound field produces a different digest, so a stale or
 *     mismatched decision can never authorize (NN-APPROVAL-002, CD-010).
 *
 * A natural-language / prose "decision" is NEVER represented here as an
 * authorizing decision; the heuristic adapter (see
 * {@link ./heuristic-display-adapter}) produces DISPLAY candidates only
 * (NN-APPROVAL-006).
 *
 * This module is additive over {@link ../shared/contract-primitives} and reuses
 * its canonical serializer and `computeDigest` so the approval digest shares the
 * same key-order-independent, structurally-stable definition as every other
 * contract digest (D-07).
 *
 * Design anchors: D-07 (`ApprovalRequest@1` / `ApprovalDecision@1`), D-11
 * (fail-closed tool sequence), D-16 (approvals), D-15/CD-030 (lifecycle).
 * Requirements: NN-APPROVAL-001/002/005/006, NN-EXEC-014, NN-EVENT-001,
 * NN-COMPAT-005. Canonical claims: CD-010, CD-030.
 */

import { z } from 'zod';

import {
  CONTRACT_WRITE_VERSION,
  DigestSchema,
  OpaqueIdSchema,
  RevisionSchema,
  TimestampSchema,
  computeDigest,
  type RedactionClass,
} from '../shared/contract-primitives';

// ─── Kind / risk / option vocabularies (NN-APPROVAL-001/004) ────────────────

/**
 * The approval kind. `agent-question` is an agent-initiated question;
 * `policy-approval` is a policy-triggered approval (the two that share ONE
 * accessible card, NN-APPROVAL-004). Both persist the same record shape.
 */
export const APPROVAL_KINDS = Object.freeze([
  'agent-question',
  'policy-approval',
] as const);
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
export const ApprovalKindSchema = z.enum(APPROVAL_KINDS);

/**
 * The risk tier of the requested work. `high` work REQUIRES a typed
 * `ApprovalDecision` produced by an explicit user action; a prose/heuristic
 * candidate can never authorize it (NN-APPROVAL-006). Risk is a BOUND field:
 * it participates in the digest, so a decision made at one risk tier cannot
 * authorize the same action re-issued at a higher tier (NN-APPROVAL-002).
 */
export const APPROVAL_RISKS = Object.freeze(['low', 'medium', 'high'] as const);
export type ApprovalRisk = (typeof APPROVAL_RISKS)[number];
export const ApprovalRiskSchema = z.enum(APPROVAL_RISKS);

/**
 * A selectable option on the shared card (NN-APPROVAL-004/007). `destructive`
 * options use risk styling in the renderer (a display concern the card contract
 * enforces). The `optionId` is the value a decision selects.
 */
export const ApprovalOptionSchema = z.strictObject({
  optionId: z.string().min(1).max(128),
  label: z.string().min(1).max(256),
  /** Whether this option authorizes the requested work (`approve`) or rejects it. */
  effect: z.enum(['approve', 'reject']),
  /** Destructive options use risk styling (NN-APPROVAL-007). */
  destructive: z.boolean(),
});
export type ApprovalOption = z.infer<typeof ApprovalOptionSchema>;

// ─── The normalized, digest-bound action (NN-APPROVAL-002) ──────────────────

/**
 * The exact, normalized action an approval binds to. This is the ONLY thing a
 * decision authorizes. Every field here participates in {@link computeApprovalDigest};
 * a change to any of them yields a different digest and invalidates any prior
 * decision (NN-APPROVAL-002, CD-010).
 *
 *   - `action`      — the canonical action verb/tool identifier (e.g. `fs.write`).
 *   - `arguments`   — the structured, key-order-independent argument object.
 *   - `scopeKey`    — the digest of the owning scope's identity anchors (the
 *     same stable scope key the durability layer uses), so a decision for one
 *     scope cannot authorize an identical action in another scope.
 *   - `risk`        — the risk tier the user was shown.
 *   - `owner`       — the owning authority/run id.
 *   - `planRevision`— the plan revision the request was raised against; a plan
 *     change (new revision) invalidates the decision (NN-APPROVAL-002).
 *   - `expiresAt`   — the request's expiry instant; part of the bound identity
 *     so a re-issued request with a new expiry is a distinct authorization.
 */
export const NormalizedActionSchema = z.strictObject({
  action: z.string().min(1).max(512),
  /** Structured arguments; serialized canonically (key order does not matter). */
  arguments: z.record(z.string(), z.unknown()),
  scopeKey: DigestSchema,
  risk: ApprovalRiskSchema,
  owner: OpaqueIdSchema,
  planRevision: RevisionSchema,
  expiresAt: TimestampSchema,
});
export type NormalizedAction = z.infer<typeof NormalizedActionSchema>;

/**
 * Compute the ONE normalized approval digest over a {@link NormalizedAction}.
 *
 * This is the exact-binding primitive of CD-010 / NN-APPROVAL-002. It reuses the
 * shared canonical serializer via {@link computeDigest}, so:
 *
 *   - two structurally equal actions (arguments supplied in any key order)
 *     always produce the SAME digest — a re-surfaced request after reload binds
 *     to the same decision; and
 *   - any change to `action`, `arguments`, `scopeKey`, `risk`, `owner`,
 *     `planRevision`, or `expiresAt` produces a DIFFERENT digest — a stale or
 *     mismatched decision can never authorize (NN-APPROVAL-002).
 *
 * The digest is a normalized value: it never depends on volatile fields such as
 * the request id, creation timestamp, or presentation text. Only the bound
 * identity matters.
 */
export function computeApprovalDigest(action: NormalizedAction): string {
  // Normalize explicitly to the bound fields in a fixed shape so that adding an
  // unrelated presentation field to a caller's object can never change the
  // authorization identity.
  return computeDigest({
    action: action.action,
    arguments: action.arguments,
    scopeKey: action.scopeKey,
    risk: action.risk,
    owner: action.owner,
    planRevision: action.planRevision,
    expiresAt: action.expiresAt,
  });
}

// ─── ApprovalRequest@1 state ladder (NN-APPROVAL-001/003/008) ───────────────

/**
 * `ApprovalRequest@1` lifecycle state ladder (CD-030):
 *
 *   - `pending`   — awaiting a decision; the owning run is blocked.
 *   - `suspended` — a renderer reload or an unclean interruption left the
 *     request durable but not actively surfaced; it must be revalidated before
 *     it resumes (NN-APPROVAL-003). This is NOT a terminal state and NEVER
 *     implies a decision.
 *   - `approved`  — a typed approve decision committed; terminal.
 *   - `rejected`  — a typed reject decision, expiry, or a durable cancel
 *     committed; terminal.
 *   - `cancelled` — a durable cancel (explicit user cancel, session cancel,
 *     unrecoverable owner, or graceful quit) committed; terminal. Distinct from
 *     `rejected` for audit but likewise never implies approval (NN-APPROVAL-008).
 */
export const APPROVAL_STATES = Object.freeze([
  'pending',
  'suspended',
  'approved',
  'rejected',
  'cancelled',
] as const);
export type ApprovalState = (typeof APPROVAL_STATES)[number];
export const ApprovalStateSchema = z.enum(APPROVAL_STATES);

/** Whether an approval state is terminal (no further transition possible). */
export function isTerminalApprovalState(state: ApprovalState): boolean {
  return state === 'approved' || state === 'rejected' || state === 'cancelled';
}

/**
 * `ApprovalRequest@1` (NN-APPROVAL-001). The Approval Service is its sole
 * writable owner. It carries the request/revision id, scope, actor, kind, the
 * exact `actionDigest` (the {@link computeApprovalDigest} of the bound action),
 * risk, options, context references, plan revision, creation/expiry, state, and
 * idempotency key.
 */
export const ApprovalRequestSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_WRITE_VERSION),
  requestId: OpaqueIdSchema,
  /** Monotonic revision of THIS request record. */
  revision: RevisionSchema,
  scopeKey: DigestSchema,
  actor: OpaqueIdSchema,
  kind: ApprovalKindSchema,
  /** The exact normalized action/arguments digest the decision must match. */
  actionDigest: DigestSchema,
  /** A safe, secret-free label of the action for audit (never the raw args). */
  actionLabel: z.string().min(1).max(512),
  risk: ApprovalRiskSchema,
  owner: OpaqueIdSchema,
  planRevision: RevisionSchema,
  options: z.array(ApprovalOptionSchema).min(1),
  /** Opaque context references (e.g. file refs); never inline secret context. */
  contextRefs: z.array(OpaqueIdSchema),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  state: ApprovalStateSchema,
  /** Idempotency key: the same logical request reuses it (NN-APPROVAL-005). */
  idempotencyKey: z.string().min(1).max(512),
  /**
   * The idempotency key of the request this one visually duplicates, if any.
   * Set for a duplicate within the legacy window: the duplicate remains an
   * auditable distinct authority record but MAY collapse visually to its
   * primary (NN-APPROVAL-005). Authority is NEVER collapsed.
   */
  duplicateOf: OpaqueIdSchema.optional(),
  redaction: z.enum(['public', 'internal', 'sensitive', 'secret']),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

// ─── ApprovalDecision@1 (NN-APPROVAL-002) ───────────────────────────────────

/**
 * The channel a decision was produced through. Only `typed-user-action`
 * authorizes work: it is a decision produced by an explicit user action on the
 * card. `heuristic-display` NEVER appears on an authorizing decision — the
 * heuristic adapter cannot mint decisions (NN-APPROVAL-006, CD-010). It exists
 * in the schema so an attempt to forge one is a typed rejection, not a silent
 * pass.
 */
export const DECISION_CHANNELS = Object.freeze([
  'typed-user-action',
  'heuristic-display',
] as const);
export type DecisionChannel = (typeof DECISION_CHANNELS)[number];
export const DecisionChannelSchema = z.enum(DECISION_CHANNELS);

/** The terminal outcome a decision records. */
export const DECISION_OUTCOMES = Object.freeze([
  'approved',
  'rejected',
  'cancelled',
] as const);
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];
export const DecisionOutcomeSchema = z.enum(DECISION_OUTCOMES);

/**
 * `ApprovalDecision@1` (NN-APPROVAL-002). A durable typed decision bound to the
 * exact request digest it authorizes. `boundActionDigest` MUST equal the
 * request's `actionDigest` for an approval to authorize; any mismatch is a
 * rejection with no effect. `channel` MUST be `typed-user-action` for an
 * `approved` outcome.
 */
export const ApprovalDecisionSchema = z
  .strictObject({
    schemaVersion: z.literal(CONTRACT_WRITE_VERSION),
    decisionId: OpaqueIdSchema,
    requestId: OpaqueIdSchema,
    /** The exact action digest this decision authorizes (NN-APPROVAL-002). */
    boundActionDigest: DigestSchema,
    /** The plan revision at decision time; must match the request. */
    boundPlanRevision: RevisionSchema,
    outcome: DecisionOutcomeSchema,
    selectedOptionId: z.string().min(1).max(128),
    channel: DecisionChannelSchema,
    /** The user actor that produced a typed decision. */
    decidedBy: OpaqueIdSchema,
    /** Optional free-text answer for an agent question (secret-free). */
    freeText: z.string().max(4096).optional(),
    decidedAt: TimestampSchema,
    /** The reason for a non-user terminal (expiry/cancel), if applicable. */
    terminalReason: z
      .enum([
        'user-decision',
        'expiry',
        'user-cancel',
        'session-cancel',
        'unrecoverable-owner',
        'graceful-quit',
      ])
      .optional(),
    redaction: z.enum(['public', 'internal', 'sensitive', 'secret']),
  })
  .refine((d) => !(d.outcome === 'approved' && d.channel !== 'typed-user-action'), {
    message:
      'an approved decision must be produced by an explicit typed user action (NN-APPROVAL-006)',
    path: ['channel'],
  });
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

// ─── Redaction default ──────────────────────────────────────────────────────

/** Default redaction for approval records surfaced to the renderer card. */
export const DEFAULT_APPROVAL_REDACTION: RedactionClass = 'internal';
