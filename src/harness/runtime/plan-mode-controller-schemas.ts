/**
 * Plan Mode Controller Schemas — State transitions, tool enforcement,
 * plan revisions, and approval contracts.
 *
 * Defines Zod schemas for Plan_Mode:
 * - Plan_Mode state transitions (enter/exit)
 * - Planning-safe tool classification
 * - Plan revision identity and linkage
 * - Approval bound to exact plan revision
 * - Approval expiry on plan change
 *
 * Requirements: 8.1–8.6
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema, ContractRefSchema } from '../contracts/primitives';
import { ScopeDescriptorV1Schema } from '../contracts/scope';

// ─── Plan Mode State ────────────────────────────────────────────

/**
 * Plan_Mode lifecycle states.
 */
export const PlanModeStateSchema = z.enum([
  'inactive',
  'active',
  'pending_approval',
  'approved',
]);

export type PlanModeState = z.infer<typeof PlanModeStateSchema>;

// ─── Plan Revision ──────────────────────────────────────────────

/**
 * A plan revision represents an immutable snapshot of a plan's content.
 * Each revision links to its predecessor for history tracking.
 *
 * Requirement 8.3: preserve amendment identity and link revisions.
 */
export const PlanRevisionSchema = z.object({
  /** Unique revision identity. */
  revisionId: IdentifierSchema,
  /** Plan identity (stable across revisions). */
  planId: IdentifierSchema,
  /** Sequence number within this plan's history (monotonically increasing). */
  sequenceNumber: z.number().int().positive().finite(),
  /** Link to the prior revision (null for initial). */
  priorRevisionId: IdentifierSchema.nullable(),
  /** Content digest for exact-match verification. */
  contentDigest: z.string().min(1),
  /** Actor who created this revision. */
  author: IdentifierSchema,
  /** Timestamp of revision creation. */
  createdAt: TimestampSchema,
  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type PlanRevision = z.infer<typeof PlanRevisionSchema>;

// ─── Plan Mode Transition Events ────────────────────────────────

/**
 * Transition event appended when Plan_Mode starts.
 * Requirement 8.1: append state transition and include planning prompt section.
 */
export const PlanModeEnterTransitionSchema = z.object({
  type: z.literal('plan_mode_enter'),
  /** Unique transition identity. */
  transitionId: IdentifierSchema,
  /** Session identity. */
  sessionId: IdentifierSchema,
  /** Turn identity. */
  turnId: IdentifierSchema,
  /** Named planning prompt section to include. */
  planningPromptSection: z.string().min(1),
  /** Initial plan revision (if plan exists). */
  initialRevisionId: IdentifierSchema.optional(),
  /** Reason for entering Plan_Mode. */
  reason: z.enum(['user_request', 'loop_guard_escalation', 'policy']),
  /** Timestamp. */
  occurredAt: TimestampSchema,
  schemaVersion: z.literal(1),
}).passthrough();

export type PlanModeEnterTransition = z.infer<typeof PlanModeEnterTransitionSchema>;

/**
 * Transition event appended when Plan_Mode exits.
 * Requirement 8.6: include approved plan identity and execution guidance.
 */
export const PlanModeExitTransitionSchema = z.object({
  type: z.literal('plan_mode_exit'),
  /** Unique transition identity. */
  transitionId: IdentifierSchema,
  /** Session identity. */
  sessionId: IdentifierSchema,
  /** Turn identity. */
  turnId: IdentifierSchema,
  /** Approved plan revision identity (if approved). */
  approvedRevisionId: IdentifierSchema.optional(),
  /** Execution guidance text appended to prompt. */
  executionGuidance: z.string().optional(),
  /** Reason for exiting. */
  reason: z.enum(['execution_approved', 'user_cancel', 'timeout', 'error']),
  /** Timestamp. */
  occurredAt: TimestampSchema,
  schemaVersion: z.literal(1),
}).passthrough();

export type PlanModeExitTransition = z.infer<typeof PlanModeExitTransitionSchema>;

// ─── Tool Safety Classification ─────────────────────────────────

/**
 * Tool classification for Plan_Mode enforcement.
 * Requirement 8.2: only tools classified as read-only or planning-safe are allowed.
 */
export const ToolSafetyClassSchema = z.enum([
  'read-only',
  'planning-safe',
  'mutating',
]);

export type ToolSafetyClass = z.infer<typeof ToolSafetyClassSchema>;

/**
 * Tool classification entry registered in Tool_Registry.
 */
export const ToolPlanModeClassificationSchema = z.object({
  toolContract: ContractRefSchema,
  safetyClass: ToolSafetyClassSchema,
});

export type ToolPlanModeClassification = z.infer<typeof ToolPlanModeClassificationSchema>;

// ─── Approval Contract ──────────────────────────────────────────

/**
 * Approval bound to the exact plan revision.
 * Requirement 8.4: require approval bound to exact plan revision.
 * Requirement 8.5: expire approval if plan changes before execution.
 */
export const PlanApprovalSchema = z.object({
  /** Unique approval identity. */
  approvalId: IdentifierSchema,
  /** Plan identity. */
  planId: IdentifierSchema,
  /** Exact plan revision this approval is bound to. */
  boundRevisionId: IdentifierSchema,
  /** Digest of the plan revision content (for verification). */
  revisionContentDigest: z.string().min(1),
  /** Actor who granted approval. */
  approvedBy: IdentifierSchema,
  /** Timestamp of approval. */
  approvedAt: TimestampSchema,
  /** Expiry time (approval expires if not consumed). */
  expiresAt: TimestampSchema.optional(),
  /** Whether this approval has been consumed for execution. */
  consumed: z.boolean().default(false),
  /** Whether this approval has been expired (plan changed). */
  expired: z.boolean().default(false),
  /** Reason for expiry if expired. */
  expiryReason: z.string().optional(),
  /** Scope context. */
  scope: ScopeDescriptorV1Schema.optional(),
  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type PlanApproval = z.infer<typeof PlanApprovalSchema>;

// ─── Plan Mode Tool Check Result ────────────────────────────────

/**
 * Result from checking whether a tool call is permitted in Plan_Mode.
 */
export const PlanModeToolCheckResultSchema = z.discriminatedUnion('permitted', [
  z.object({
    permitted: z.literal(true),
    toolContract: ContractRefSchema,
    safetyClass: ToolSafetyClassSchema,
  }),
  z.object({
    permitted: z.literal(false),
    toolContract: ContractRefSchema,
    safetyClass: ToolSafetyClassSchema,
    reason: z.string(),
  }),
]);

export type PlanModeToolCheckResult = z.infer<typeof PlanModeToolCheckResultSchema>;

// ─── Plan Mode Controller Configuration ─────────────────────────

/**
 * Configuration for the Plan_Mode controller.
 */
export const PlanModeControllerConfigSchema = z.object({
  /** Named planning prompt section identifier to include when Plan_Mode starts. */
  planningPromptSectionName: z.string().min(1).default('planning_mode'),
  /** Default expiry duration for approvals (milliseconds). Zero means no expiry. */
  approvalExpiryMs: z.number().int().nonnegative().finite().default(0),
  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type PlanModeControllerConfig = z.infer<typeof PlanModeControllerConfigSchema>;

// ─── Execution Request ──────────────────────────────────────────

/**
 * Request to execute from Plan_Mode (requires approval).
 * Requirement 8.4: execution requires approval bound to exact plan revision.
 */
export const PlanExecutionRequestSchema = z.object({
  /** Plan identity. */
  planId: IdentifierSchema,
  /** Revision to execute. */
  revisionId: IdentifierSchema,
  /** Content digest for verification. */
  contentDigest: z.string().min(1),
  /** Requesting actor. */
  requestedBy: IdentifierSchema,
  /** Timestamp. */
  requestedAt: TimestampSchema,
});

export type PlanExecutionRequest = z.infer<typeof PlanExecutionRequestSchema>;

/**
 * Result of an execution request validation.
 */
export const PlanExecutionValidationSchema = z.discriminatedUnion('valid', [
  z.object({
    valid: z.literal(true),
    approvalId: IdentifierSchema,
    boundRevisionId: IdentifierSchema,
  }),
  z.object({
    valid: z.literal(false),
    reason: z.enum([
      'no_approval',
      'approval_expired',
      'approval_consumed',
      'revision_mismatch',
      'digest_mismatch',
      'plan_mode_not_active',
    ]),
    details: z.string().optional(),
  }),
]);

export type PlanExecutionValidation = z.infer<typeof PlanExecutionValidationSchema>;
