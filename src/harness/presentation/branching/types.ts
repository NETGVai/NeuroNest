/**
 * Branching, Edit-and-Resend, and Exact Retry Types
 *
 * Zod schemas and TypeScript types for immutable message branching,
 * edit-and-resend, and exact retry actions. Branch/edit/retry never
 * mutate prior events. Branch creation first appends lineage.
 * Edit-and-resend appends edited content to a child branch. Exact
 * retry binds a new attempt to the selected Completion_Anchor and
 * matching Prompt_Fingerprint only after precondition checks.
 * "Branch with current configuration" is a separate action and never
 * masquerades as exact retry.
 *
 * Requirements: 44.1-44.16
 */

import { z } from 'zod';
import { IdentifierSchema, SequenceSchema, TimestampSchema } from '../../contracts/primitives';
import { ActorRefSchema } from '../../contracts/actor';

// ─── Branch Lineage ─────────────────────────────────────────────

/**
 * Lineage record appended to Session_Log before any child events.
 * Contains parent session, parent sequence, selected Chat_Node,
 * actor, and branch identity (Requirement 44.2).
 */
export const BranchLineageV1Schema = z.object({
  parentSessionId: IdentifierSchema,
  parentSequence: SequenceSchema,
  selectedChatNodeKey: IdentifierSchema,
  actor: ActorRefSchema,
  childBranchId: IdentifierSchema,
  createdAt: TimestampSchema,
}).passthrough();

export type BranchLineageV1 = z.infer<typeof BranchLineageV1Schema>;

// ─── Completion Anchor & Prompt Fingerprint ─────────────────────

/**
 * Completion_Anchor identifies the exact assistant completion to retry.
 * Bound at retry-time by the user's explicit selection (Requirement 44.4, 44.14).
 */
export const CompletionAnchorSchema = z.object({
  anchorId: IdentifierSchema,
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  sequence: SequenceSchema,
  completionDigest: z.string().min(1),
}).passthrough();

export type CompletionAnchor = z.infer<typeof CompletionAnchorSchema>;

/**
 * Prompt_Fingerprint captures the exact prompt state used for the original
 * completion. Exact retry must match this fingerprint (Requirement 44.4, 44.14).
 */
export const PromptFingerprintSchema = z.object({
  fingerprintId: IdentifierSchema,
  routeId: IdentifierSchema,
  adapterId: IdentifierSchema,
  profileId: IdentifierSchema,
  contextDigest: z.string().min(1),
  modelId: z.string().min(1),
}).passthrough();

export type PromptFingerprint = z.infer<typeof PromptFingerprintSchema>;

// ─── Provenance Display ─────────────────────────────────────────

/**
 * Detailed completion provenance for display in the UI.
 * Shows Completion_Anchor, Prompt_Fingerprint, route, adapter, profile,
 * and source sequence (Requirement 44.8).
 */
export const CompletionProvenanceV1Schema = z.object({
  anchor: CompletionAnchorSchema,
  fingerprint: PromptFingerprintSchema,
  sourceSequence: SequenceSchema,
  displayRoute: z.string().min(1),
  displayAdapter: z.string().min(1),
  displayProfile: z.string().min(1),
}).passthrough();

export type CompletionProvenanceV1 = z.infer<typeof CompletionProvenanceV1Schema>;

// ─── Action Availability ────────────────────────────────────────

/**
 * Reasons an action can be unavailable (Requirement 44.6).
 */
export const UnavailabilityReasonSchema = z.enum([
  'lineage_missing',
  'reconstruction_failed',
  'route_incompatible',
  'attachment_unavailable',
  'policy_incompatible',
  'ownership_denied',
  'budget_insufficient',
]);

export type UnavailabilityReason = z.infer<typeof UnavailabilityReasonSchema>;

/**
 * Availability state for a single message action.
 * When unavailable, the specific reason is provided (Requirement 44.6).
 */
export const ActionAvailabilitySchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true) }),
  z.object({
    available: z.literal(false),
    reason: UnavailabilityReasonSchema,
    displayReason: z.string().min(1),
  }),
]);

export type ActionAvailability = z.infer<typeof ActionAvailabilitySchema>;

// ─── Message Actions ────────────────────────────────────────────

/**
 * The set of actions applicable to an eligible Chat_Node (Requirement 44.1).
 * Each action carries its own availability state.
 */
export const MessageActionKindSchema = z.enum([
  'copy',
  'expand',
  'open_source',
  'branch',
  'edit_and_resend',
  'retry_from_exact_completion',
  'branch_with_current_config',
]);

export type MessageActionKind = z.infer<typeof MessageActionKindSchema>;

/**
 * A single message action with availability and optional provenance.
 */
export const MessageActionV1Schema = z.object({
  kind: MessageActionKindSchema,
  availability: ActionAvailabilitySchema,
  targetNodeKey: IdentifierSchema,
  targetSequence: SequenceSchema.optional(),
  provenance: CompletionProvenanceV1Schema.optional(),
}).passthrough();

export type MessageActionV1 = z.infer<typeof MessageActionV1Schema>;

// ─── Confirmation Requirements ──────────────────────────────────

/**
 * Actions that appear to replace history, discard drafts, cancel active work,
 * or switch visible branch require confirmation (Requirement 44.10).
 */
export const ConfirmationReasonSchema = z.enum([
  'replaces_history',
  'discards_draft',
  'cancels_active_work',
  'switches_branch',
]);

export type ConfirmationReason = z.infer<typeof ConfirmationReasonSchema>;

/**
 * Confirmation prompt describing preserved history and resulting active branch.
 */
export const ActionConfirmationSchema = z.object({
  required: z.boolean(),
  reasons: z.array(ConfirmationReasonSchema),
  preservedHistoryDescription: z.string(),
  resultingBranchId: IdentifierSchema,
  resultingBranchLabel: z.string(),
}).passthrough();

export type ActionConfirmation = z.infer<typeof ActionConfirmationSchema>;

// ─── Precondition Check Results ─────────────────────────────────

/**
 * Precondition checks for exact retry (Requirement 44.5):
 * reconstructability, route compatibility, attachment availability,
 * policy compatibility, and budget eligibility.
 */
export const RetryPreconditionKindSchema = z.enum([
  'reconstructability',
  'route_compatibility',
  'attachment_availability',
  'policy_compatibility',
  'budget_eligibility',
]);

export type RetryPreconditionKind = z.infer<typeof RetryPreconditionKindSchema>;

export const PreconditionResultSchema = z.object({
  kind: RetryPreconditionKindSchema,
  passed: z.boolean(),
  detail: z.string().optional(),
}).passthrough();

export type PreconditionResult = z.infer<typeof PreconditionResultSchema>;

// ─── Branch Action Commands ─────────────────────────────────────

/**
 * Command to create a new branch from a Chat_Node.
 */
export const BranchCommandSchema = z.object({
  type: z.literal('branch'),
  sourceNodeKey: IdentifierSchema,
  sourceSequence: SequenceSchema,
  sessionId: IdentifierSchema,
  actor: ActorRefSchema,
  idempotencyKey: IdentifierSchema,
}).passthrough();

export type BranchCommand = z.infer<typeof BranchCommandSchema>;

/**
 * Command to edit and resend a prior user message in a new child branch.
 */
export const EditAndResendCommandSchema = z.object({
  type: z.literal('edit_and_resend'),
  sourceNodeKey: IdentifierSchema,
  sourceSequence: SequenceSchema,
  editedText: z.string(),
  sessionId: IdentifierSchema,
  actor: ActorRefSchema,
  idempotencyKey: IdentifierSchema,
}).passthrough();

export type EditAndResendCommand = z.infer<typeof EditAndResendCommandSchema>;

/**
 * Command to retry an exact completion (Requirement 44.4, 44.14).
 * Binds to the exact Completion_Anchor and Prompt_Fingerprint without
 * substitution.
 */
export const ExactRetryCommandSchema = z.object({
  type: z.literal('exact_retry'),
  anchor: CompletionAnchorSchema,
  fingerprint: PromptFingerprintSchema,
  sessionId: IdentifierSchema,
  actor: ActorRefSchema,
  idempotencyKey: IdentifierSchema,
}).passthrough();

export type ExactRetryCommand = z.infer<typeof ExactRetryCommandSchema>;

/**
 * Command to branch with current configuration (distinct from exact retry,
 * per design). Never masquerades as exact retry (Requirement 44.12).
 */
export const BranchWithCurrentConfigCommandSchema = z.object({
  type: z.literal('branch_with_current_config'),
  sourceNodeKey: IdentifierSchema,
  sourceSequence: SequenceSchema,
  sessionId: IdentifierSchema,
  actor: ActorRefSchema,
  idempotencyKey: IdentifierSchema,
}).passthrough();

export type BranchWithCurrentConfigCommand = z.infer<typeof BranchWithCurrentConfigCommandSchema>;

/**
 * Discriminated union of all branch action commands.
 */
export const BranchActionCommandSchema = z.discriminatedUnion('type', [
  BranchCommandSchema,
  EditAndResendCommandSchema,
  ExactRetryCommandSchema,
  BranchWithCurrentConfigCommandSchema,
]);

export type BranchActionCommand = z.infer<typeof BranchActionCommandSchema>;

// ─── Action Outcomes ────────────────────────────────────────────

/**
 * Result of a branch action. Mirrors projection-confirmed state.
 * On failure, preserves active branch, draft, selection, and history
 * (Requirement 44.15, 44.16).
 */
export const BranchActionOutcomeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('pending'),
    commandId: IdentifierSchema,
  }).passthrough(),
  z.object({
    status: z.literal('committed'),
    commandId: IdentifierSchema,
    resultingBranchId: IdentifierSchema,
    lineage: BranchLineageV1Schema,
  }).passthrough(),
  z.object({
    status: z.literal('failed'),
    commandId: IdentifierSchema,
    reason: z.string(),
    preservedBranchId: IdentifierSchema,
    preservedDraft: z.boolean(),
    preservedSelection: z.boolean(),
    preservedHistory: z.boolean(),
  }).passthrough(),
]);

export type BranchActionOutcome = z.infer<typeof BranchActionOutcomeSchema>;

// ─── Active Branch State ────────────────────────────────────────

/**
 * The current branch state displayed in the UI.
 * Shows parent-child lineage and active branch identity (Requirement 44.7).
 */
export const ActiveBranchStateSchema = z.object({
  activeBranchId: IdentifierSchema,
  sessionId: IdentifierSchema,
  lineageChain: z.array(BranchLineageV1Schema),
  parentBranchId: IdentifierSchema.optional(),
  childBranchIds: z.array(IdentifierSchema),
  label: z.string(),
}).passthrough();

export type ActiveBranchState = z.infer<typeof ActiveBranchStateSchema>;
