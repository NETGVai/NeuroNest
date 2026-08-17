/**
 * Collaboration Schemas — Versioned question/approval contracts, exact answer
 * schemas and digests, permission presets, expiry, and human command events.
 *
 * Defines Zod schemas for the Collaboration_Service:
 * - Versioned question contracts with stable identity, revision, and answer schema
 * - Approval contracts bound to exact normalized args, scope, risk, owner, tool version, plan revision, and expiry digest
 * - Atomic one-shot consumption and dispatch records
 * - Permission presets with versioned revisions and bulk confirmation
 * - Fail-closed noninteractive outcomes
 * - Expiry semantics for questions and approvals
 * - Human command events for Session_Log
 * - Supersession of prior questions on the same contract
 *
 * Requirements: 8.4–8.5, 19.1–19.8, 38.1–38.6, 38.10–38.16
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema, ContractRefSchema } from '../contracts/primitives';
import { ScopeDescriptorV1Schema } from '../contracts/scope';

// ─── Collaboration Contract Kind ────────────────────────────────

/**
 * The kind of collaboration contract.
 */
export const CollaborationKindSchema = z.enum([
  'question',
  'approval',
  'plan_review',
]);

export type CollaborationKind = z.infer<typeof CollaborationKindSchema>;

// ─── Collaboration State ────────────────────────────────────────

/**
 * Lifecycle state for collaboration contracts.
 *
 * - pending: awaiting human decision
 * - answered: question has been answered (one-shot consumed)
 * - approved: approval granted (one-shot consumed)
 * - denied: approval denied (one-shot consumed)
 * - expired: contract expired before decision
 * - superseded: newer contract on same identity replaced this one
 */
export const CollaborationStateSchema = z.enum([
  'pending',
  'answered',
  'approved',
  'denied',
  'expired',
  'superseded',
]);

export type CollaborationState = z.infer<typeof CollaborationStateSchema>;

/**
 * Terminal collaboration states — once reached, no further transitions.
 */
export const TERMINAL_COLLABORATION_STATES: ReadonlySet<CollaborationState> = new Set([
  'answered',
  'approved',
  'denied',
  'expired',
  'superseded',
]);

// ─── Answer Schema ──────────────────────────────────────────────

/**
 * Defines the exact expected answer shape for a question contract.
 * The answer must validate against this schema before acceptance.
 *
 * Requirement 38.13: validate answer against exact projected answer schema.
 */
export const AnswerSchemaDefinitionSchema = z.object({
  /** Unique schema identity for this answer format. */
  schemaId: IdentifierSchema,
  /** Version of the answer schema. */
  schemaVersion: z.number().int().positive().finite(),
  /** Answer type discriminator. */
  answerType: z.enum(['text', 'choice', 'confirmation', 'structured']),
  /** For choice type: allowed values. */
  allowedValues: z.array(z.string()).optional(),
  /** For structured type: JSON schema descriptor. */
  structuredSchema: z.record(z.string(), z.unknown()).optional(),
  /** Whether the answer is required (non-empty). */
  required: z.boolean().default(true),
  /** Content digest of the schema definition for integrity. */
  digest: z.string().min(1),
}).passthrough();

export type AnswerSchemaDefinition = z.infer<typeof AnswerSchemaDefinitionSchema>;

// ─── Approval Digest ────────────────────────────────────────────

/**
 * The stable digest binding an approval to exact normalized arguments,
 * scope, risk, owner, plan revision when applicable, and expiry.
 *
 * Requirement 19.2: bind approval to tool version, exact normalized args digest,
 * scope, risk summary, owner, and expiry.
 * Requirement 38.6: invalidate if args/scope/risk/owner/tool version/plan revision changes.
 */
export const ApprovalDigestSchema = z.object({
  /** Digest of normalized tool arguments. */
  normalizedArgsDigest: z.string().min(1),
  /** Tool contract reference (name + version). */
  toolContract: ContractRefSchema,
  /** Scope descriptor for the approval. */
  scope: ScopeDescriptorV1Schema,
  /** Risk classification summary. */
  riskSummary: z.string().min(1),
  /** Owner identity. */
  owner: IdentifierSchema,
  /** Plan revision identity (when plan-mode approval). */
  planRevisionId: IdentifierSchema.optional(),
  /** Expiry timestamp bound into the digest. */
  expiresAt: TimestampSchema.optional(),
  /** The composite digest of all above fields. */
  compositeDigest: z.string().min(1),
}).passthrough();

export type ApprovalDigest = z.infer<typeof ApprovalDigestSchema>;

// ─── Question Contract ──────────────────────────────────────────

/**
 * A versioned provider-neutral question issued to the user.
 *
 * Requirement 19.1: issue provider-neutral question with stable identity,
 * expected answer schema, expiry, and owning session.
 */
export const QuestionContractSchema = z.object({
  /** Stable question identity (survives revisions). */
  questionId: IdentifierSchema,
  /** Revision number (monotonically increasing per questionId). */
  revision: z.number().int().positive().finite(),
  /** Session this question belongs to. */
  sessionId: IdentifierSchema,
  /** Turn that triggered the question. */
  turnId: IdentifierSchema,
  /** Owner (agent/tool that asked). */
  owner: IdentifierSchema,
  /** Kind of collaboration. */
  kind: z.literal('question'),
  /** Human-readable question text. */
  questionText: z.string().min(1),
  /** Exact expected answer schema. */
  answerSchema: AnswerSchemaDefinitionSchema,
  /** Content digest of the question contract for integrity verification. */
  contractDigest: z.string().min(1),
  /** Expiry timestamp (question expires to fail-closed). */
  expiresAt: TimestampSchema.optional(),
  /** Current state. */
  state: CollaborationStateSchema,
  /** Scope context. */
  scope: ScopeDescriptorV1Schema.optional(),
  /** Timestamp of creation. */
  createdAt: TimestampSchema,
  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type QuestionContract = z.infer<typeof QuestionContractSchema>;

// ─── Approval Contract ──────────────────────────────────────────

/**
 * A versioned approval contract bound to exact execution context.
 *
 * Requirement 19.2: bind approval to tool version, exact normalized args digest,
 * scope, risk summary, owner, and expiry.
 */
export const ApprovalContractSchema = z.object({
  /** Stable approval identity (survives revisions). */
  approvalId: IdentifierSchema,
  /** Revision number (monotonically increasing per approvalId). */
  revision: z.number().int().positive().finite(),
  /** Session this approval belongs to. */
  sessionId: IdentifierSchema,
  /** Turn that triggered the approval. */
  turnId: IdentifierSchema,
  /** Owner (agent/tool that requested). */
  owner: IdentifierSchema,
  /** Kind of collaboration. */
  kind: z.literal('approval'),
  /** Human-readable description of what is being approved. */
  description: z.string().min(1),
  /** The approval digest binding to exact context. */
  approvalDigest: ApprovalDigestSchema,
  /** Content digest of the full contract for integrity. */
  contractDigest: z.string().min(1),
  /** Expiry timestamp (approval expires to fail-closed). */
  expiresAt: TimestampSchema.optional(),
  /** Current state. */
  state: CollaborationStateSchema,
  /** Scope context. */
  scope: ScopeDescriptorV1Schema.optional(),
  /** Timestamp of creation. */
  createdAt: TimestampSchema,
  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type ApprovalContract = z.infer<typeof ApprovalContractSchema>;

// ─── Collaboration Decision ─────────────────────────────────────

/**
 * A human decision (answer/approve/deny) submitted against a collaboration contract.
 *
 * Requirement 19.3: mark approval consumed in same transaction as authorized dispatch.
 * Requirement 38.14: commit no more than one applicable decision per identity.
 */
export const CollaborationDecisionSchema = z.object({
  /** Unique decision identity. */
  decisionId: IdentifierSchema,
  /** Target collaboration identity. */
  collaborationId: IdentifierSchema,
  /** Expected revision of the collaboration contract. */
  expectedRevision: z.number().int().positive().finite(),
  /** Decision type. */
  decisionType: z.enum(['answer', 'approve', 'deny']),
  /** Answer value (for question answers). Validated against answer schema. */
  answerValue: z.unknown().optional(),
  /** Actor who made the decision. */
  actor: IdentifierSchema,
  /** Scope of the decision. */
  scope: ScopeDescriptorV1Schema.optional(),
  /** Timestamp of decision. */
  decidedAt: TimestampSchema,
  /** Idempotency key. */
  idempotencyKey: IdentifierSchema.optional(),
  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type CollaborationDecision = z.infer<typeof CollaborationDecisionSchema>;

// ─── Permission Preset ──────────────────────────────────────────

/**
 * A versioned collection of pre-approved permissions.
 *
 * Requirement 19.5: persist preset identity and revision at scope.
 */
export const PermissionPresetSchema = z.object({
  /** Stable preset identity. */
  presetId: IdentifierSchema,
  /** Revision number (monotonically increasing). */
  revision: z.number().int().positive().finite(),
  /** Human-readable name. */
  name: z.string().min(1),
  /** Description of what this preset permits. */
  description: z.string().optional(),
  /** Scope at which this preset is persisted (user/workspace/project/session). */
  scope: ScopeDescriptorV1Schema,
  /** Pre-approved permission entries. */
  permissions: z.array(z.object({
    /** Tool contract this permission applies to. */
    toolContract: ContractRefSchema,
    /** Scope under which this permission is valid. */
    permissionScope: ScopeDescriptorV1Schema.optional(),
    /** Risk classes auto-approved. */
    allowedRiskClasses: z.array(z.string().min(1)),
    /** Expiry behavior for individual auto-approvals. */
    expiresAt: TimestampSchema.optional(),
  }).passthrough()),
  /** Expiry for the entire preset. */
  expiresAt: TimestampSchema.optional(),
  /** Source authority that created/manages this preset. */
  sourceAuthority: IdentifierSchema,
  /** Timestamp of creation/revision. */
  createdAt: TimestampSchema,
  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type PermissionPreset = z.infer<typeof PermissionPresetSchema>;

// ─── Bulk Confirmation ──────────────────────────────────────────

/**
 * Bulk confirmation request when an operation exceeds configured thresholds.
 *
 * Requirement 19.6: require confirmation describing the bounded operation set.
 */
export const BulkConfirmationRequestSchema = z.object({
  /** Unique confirmation identity. */
  confirmationId: IdentifierSchema,
  /** Session identity. */
  sessionId: IdentifierSchema,
  /** Owner. */
  owner: IdentifierSchema,
  /** Description of the bounded operation set. */
  operationDescription: z.string().min(1),
  /** Threshold that was exceeded. */
  exceededThreshold: z.object({
    kind: z.enum(['item_count', 'byte_size', 'cost', 'risk']),
    configuredLimit: z.number().finite().positive(),
    actualValue: z.number().finite().nonnegative(),
  }),
  /** Items in the bulk operation. */
  itemCount: z.number().int().nonnegative().finite(),
  /** Total cost estimate (if applicable). */
  estimatedCost: z.number().finite().nonnegative().optional(),
  /** Risk summary. */
  riskSummary: z.string().optional(),
  /** Expiry. */
  expiresAt: TimestampSchema.optional(),
  /** State. */
  state: CollaborationStateSchema,
  /** Timestamp. */
  createdAt: TimestampSchema,
  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type BulkConfirmationRequest = z.infer<typeof BulkConfirmationRequestSchema>;

// ─── Human Command Event ────────────────────────────────────────

/**
 * Durable event recorded in Session_Log when a human command changes runtime state.
 *
 * Requirement 19.8: append command identity, actor, scope, and resulting transition.
 */
export const HumanCommandEventSchema = z.object({
  /** Event type discriminator. */
  type: z.literal('human_command'),
  /** Unique command identity. */
  commandId: IdentifierSchema,
  /** Collaboration identity this command responds to (if applicable). */
  collaborationId: IdentifierSchema.optional(),
  /** Actor who issued the command. */
  actor: IdentifierSchema,
  /** Scope of the command. */
  scope: ScopeDescriptorV1Schema.optional(),
  /** Decision type (answer/approve/deny/confirm/reject). */
  decisionType: z.enum(['answer', 'approve', 'deny', 'confirm', 'reject']),
  /** Resulting state transition. */
  resultingTransition: z.object({
    fromState: CollaborationStateSchema,
    toState: CollaborationStateSchema,
  }),
  /** Timestamp. */
  occurredAt: TimestampSchema,
  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type HumanCommandEvent = z.infer<typeof HumanCommandEventSchema>;

// ─── Collaboration Service Configuration ────────────────────────

/**
 * Configuration for the Collaboration_Service.
 */
export const CollaborationServiceConfigSchema = z.object({
  /** Default expiry duration for questions (milliseconds). 0 means no expiry. */
  defaultQuestionExpiryMs: z.number().int().nonnegative().finite().default(300000),
  /** Default expiry duration for approvals (milliseconds). 0 means no expiry. */
  defaultApprovalExpiryMs: z.number().int().nonnegative().finite().default(300000),
  /** Whether this is a noninteractive session (fail-closed when true). */
  noninteractive: z.boolean().default(false),
  /** Bulk confirmation thresholds. */
  bulkThresholds: z.object({
    itemCount: z.number().int().positive().finite().default(10),
    byteSize: z.number().int().positive().finite().default(10_485_760),
    cost: z.number().positive().finite().default(1.0),
    risk: z.number().positive().finite().default(5.0),
  }).default({ itemCount: 10, byteSize: 10_485_760, cost: 1.0, risk: 5.0 }),
  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type CollaborationServiceConfig = z.infer<typeof CollaborationServiceConfigSchema>;

// ─── Decision Result ────────────────────────────────────────────

/**
 * Result of attempting to submit a collaboration decision.
 */
export const DecisionResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('accepted'),
    decisionId: IdentifierSchema,
    collaborationId: IdentifierSchema,
    newState: CollaborationStateSchema,
    dispatchRecord: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    status: z.literal('rejected'),
    reason: z.enum([
      'already_consumed',
      'expired',
      'superseded',
      'revision_mismatch',
      'invalid_answer',
      'digest_mismatch',
      'noninteractive',
      'not_found',
    ]),
    details: z.string().optional(),
    currentRevision: z.number().int().positive().finite().optional(),
    currentState: CollaborationStateSchema.optional(),
  }),
]);

export type DecisionResult = z.infer<typeof DecisionResultSchema>;

// ─── Noninteractive Outcome ─────────────────────────────────────

/**
 * Fail-closed outcome when no interactive user is available.
 *
 * Requirement 19.7: fail closed and return structured pending-approval outcome.
 */
export const NoninteractiveOutcomeSchema = z.object({
  type: z.literal('noninteractive_denial'),
  collaborationId: IdentifierSchema,
  reason: z.literal('no_interactive_user_available'),
  policy: z.literal('fail_closed'),
  occurredAt: TimestampSchema,
  schemaVersion: z.literal(1),
}).passthrough();

export type NoninteractiveOutcome = z.infer<typeof NoninteractiveOutcomeSchema>;

// ─── Supersession Record ────────────────────────────────────────

/**
 * Record that a newer contract superseded a prior one.
 *
 * Design: A newer question on the same contract supersedes the prior one.
 */
export const SupersessionRecordSchema = z.object({
  /** Prior collaboration identity that was superseded. */
  supersededId: IdentifierSchema,
  /** New collaboration identity that replaced it. */
  supersedingId: IdentifierSchema,
  /** Reason for supersession. */
  reason: z.enum(['new_revision', 'context_changed', 'owner_replaced']),
  /** Timestamp. */
  occurredAt: TimestampSchema,
}).passthrough();

export type SupersessionRecord = z.infer<typeof SupersessionRecordSchema>;
