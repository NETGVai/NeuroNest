/**
 * Session Header Schemas — Authority-attributed header fields and controls.
 *
 * Defines Zod schemas for:
 * - HeaderFieldStatus: verified, inherited, estimated, stale, unavailable
 * - AttributedFieldV1: value + status + source authority + source revision + actor
 * - DryRunImpactV1: projected impact of route/profile changes
 * - SessionHeaderProjectionV1: full composite projection envelope
 * - HeaderChangeCommandV1: revisioned command for header changes
 * - HeaderLayoutMode: responsive layout configuration
 * - ConnectionStatus: provider connectivity state
 *
 * Every field carries value, status, source authority, source revision, and actor
 * where applicable. Change controls invoke the owning authority and require
 * dry-run impact where route/profile changes affect model, tools, prompts,
 * permissions, context, cache, cost, or budgets.
 *
 * Requirements: 43.1-43.17
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema, SequenceSchema } from '../../contracts/primitives';

// ─── Header Field Status ────────────────────────────────────────

/**
 * The verification status of a header field value.
 * Requirements: 43.2, 43.10, 43.17
 */
export const HeaderFieldStatusSchema = z.enum([
  'verified',
  'inherited',
  'estimated',
  'stale',
  'unavailable',
]);

export type HeaderFieldStatus = z.infer<typeof HeaderFieldStatusSchema>;

// ─── Connection Status ──────────────────────────────────────────

/**
 * Provider connectivity state from Provider_Registry and Diagnostics_Service.
 * Requirements: 43.11
 */
export const ConnectionStatusSchema = z.enum([
  'connected',
  'degraded',
  'reconnecting',
  'disconnected',
  'incompatible',
]);

export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

// ─── Header Field Kind ──────────────────────────────────────────

/**
 * The logical kind of a header field, identifying what it represents.
 * Requirements: 43.1
 */
export const HeaderFieldKindSchema = z.enum([
  'project',
  'session',
  'agent_or_orchestrator',
  'model',
  'profile',
  'autonomy',
  'permission_preset',
  'plan_state',
  'provider_connection',
  'context_pressure',
  'token_usage',
  'cache_usage',
  'cost',
  'latency',
  'budget',
  'task',
  'run',
]);

export type HeaderFieldKind = z.infer<typeof HeaderFieldKindSchema>;

// ─── Source Authority ───────────────────────────────────────────

/**
 * The owning authority and its revision for a header field.
 * Requirements: 43.2, 43.6, 43.12
 */
export const SourceAuthoritySchema = z.object({
  /** The authority that owns this field. */
  authorityId: IdentifierSchema,
  /** The authority name for display. */
  authorityName: z.string().min(1),
  /** The source revision at which this value was produced. */
  sourceRevision: z.number().int().nonnegative(),
  /** Timestamp of the source revision. */
  sourceTimestamp: TimestampSchema.optional(),
}).passthrough();

export type SourceAuthority = z.infer<typeof SourceAuthoritySchema>;

// ─── Attributed Field V1 ───────────────────────────────────────

/**
 * A single header field with full attribution: value, status,
 * source authority, source revision, and actor where applicable.
 *
 * Requirements: 43.1, 43.2, 43.6, 43.10, 43.14, 43.17
 */
export const AttributedFieldV1Schema = z.object({
  /** The field kind identifying what this field represents. */
  kind: HeaderFieldKindSchema,
  /** Display label for the field. */
  label: z.string().min(1),
  /** The current value (string for display). */
  value: z.string(),
  /** Numeric value when applicable. */
  numericValue: z.number().finite().optional(),
  /** Unit for numeric values. */
  unit: z.string().optional(),
  /** Verification status. */
  status: HeaderFieldStatusSchema,
  /** Source authority and revision. */
  sourceAuthority: SourceAuthoritySchema,
  /** Actor that last changed this field, where applicable. */
  actor: IdentifierSchema.optional(),
  /** Last verified source revision when status is not 'verified'. */
  lastVerifiedRevision: z.number().int().nonnegative().optional(),
  /** Last verified timestamp when status is not 'verified'. */
  lastVerifiedAt: TimestampSchema.optional(),
  /** Whether this field supports change controls. */
  changeable: z.boolean(),
  /** The authority to invoke for changes (if changeable). */
  changeAuthority: IdentifierSchema.optional(),
}).passthrough();

export type AttributedFieldV1 = z.infer<typeof AttributedFieldV1Schema>;

// ─── Dry Run Impact Category ────────────────────────────────────

/**
 * The categories of impact that a route/profile change may affect.
 * Requirements: 43.4, 43.15
 */
export const DryRunImpactCategorySchema = z.enum([
  'model',
  'tools',
  'prompts',
  'permissions',
  'context_capacity',
  'cache_behavior',
  'cost',
  'budgets',
]);

export type DryRunImpactCategory = z.infer<typeof DryRunImpactCategorySchema>;

// ─── Dry Run Impact Entry ───────────────────────────────────────

/**
 * A single impact entry from a dry-run evaluation.
 * Requirements: 43.4
 */
export const DryRunImpactEntrySchema = z.object({
  /** Category affected. */
  category: DryRunImpactCategorySchema,
  /** Human-readable description of the impact. */
  description: z.string().min(1),
  /** Current value (before change). */
  currentValue: z.string().optional(),
  /** Projected value (after change). */
  projectedValue: z.string().optional(),
  /** Severity of the impact. */
  severity: z.enum(['info', 'warning', 'breaking']),
}).passthrough();

export type DryRunImpactEntry = z.infer<typeof DryRunImpactEntrySchema>;

// ─── Dry Run Result V1 ──────────────────────────────────────────

/**
 * The result of a dry-run evaluation for a proposed route/profile change.
 * Requirements: 43.4, 43.15
 */
export const DryRunResultV1Schema = z.object({
  /** Whether the dry run was successful (authority generated impacts). */
  success: z.boolean(),
  /** Impacts of the change. */
  impacts: z.array(DryRunImpactEntrySchema),
  /** Authority that performed the dry run. */
  authority: SourceAuthoritySchema,
  /** Whether commit is blocked due to incompatibility. */
  commitBlocked: z.boolean(),
  /** Reason commit is blocked (when blocked). */
  blockReason: z.string().optional(),
  /** The dry run source revision for staleness detection. */
  dryRunRevision: z.number().int().nonnegative(),
  /** Whether this dry run result is stale. */
  stale: z.boolean(),
}).passthrough();

export type DryRunResultV1 = z.infer<typeof DryRunResultV1Schema>;

// ─── Header Change Command V1 ───────────────────────────────────

/**
 * A revisioned command to change a header field value.
 * Includes source authority, source revision, selected value, actor.
 *
 * Requirements: 43.3, 43.5, 43.6, 43.12, 43.13
 */
export const HeaderChangeCommandV1Schema = z.object({
  /** Unique command identity. */
  commandId: IdentifierSchema,
  /** Idempotency key. */
  idempotencyKey: IdentifierSchema,
  /** The field kind being changed. */
  fieldKind: HeaderFieldKindSchema,
  /** The selected new value. */
  selectedValue: z.string().min(1),
  /** Numeric selected value when applicable. */
  numericSelectedValue: z.number().finite().optional(),
  /** Source authority displayed when the command was created. */
  displayedSourceAuthority: SourceAuthoritySchema,
  /** Source revision the UI was showing when the command was issued. */
  sourceRevision: z.number().int().nonnegative(),
  /** Actor issuing the command. */
  actor: IdentifierSchema,
  /** Target authority to route this command to. */
  targetAuthority: IdentifierSchema,
  /** Optional dry-run result attached (for route/profile changes). */
  dryRunResult: DryRunResultV1Schema.optional(),
}).passthrough();

export type HeaderChangeCommandV1 = z.infer<typeof HeaderChangeCommandV1Schema>;

// ─── Pending Header Change ──────────────────────────────────────

/**
 * A header change that is pending projection confirmation.
 * Requirements: 43.13, 43.14, 43.16
 */
export const PendingHeaderChangeSchema = z.object({
  /** The submitted command. */
  command: HeaderChangeCommandV1Schema,
  /** Status of the pending change. */
  status: z.enum(['pending', 'confirmed', 'rejected', 'timeout', 'stale']),
  /** The committed (prior) value retained while pending. */
  committedValue: z.string(),
  /** Rejection reason from authority. */
  rejectionReason: z.string().optional(),
  /** Confirming projection revision when confirmed. */
  confirmingRevision: z.number().int().nonnegative().optional(),
  /** Submitted at timestamp. */
  submittedAt: TimestampSchema,
}).passthrough();

export type PendingHeaderChange = z.infer<typeof PendingHeaderChangeSchema>;

// ─── Header Layout Mode ─────────────────────────────────────────

/**
 * Responsive layout mode for session header.
 * Requirements: 43.7, 43.8
 */
export const HeaderLayoutModeSchema = z.enum(['narrow', 'wide']);

export type HeaderLayoutMode = z.infer<typeof HeaderLayoutModeSchema>;

// ─── Layout Priority ────────────────────────────────────────────

/**
 * Priority classification for responsive field placement.
 * Primary fields stay in the primary row on narrow layouts.
 * Requirements: 43.7, 43.8, 43.9
 */
export const LayoutPrioritySchema = z.enum(['primary', 'secondary']);

export type LayoutPriority = z.infer<typeof LayoutPrioritySchema>;

// ─── Header Field with Layout ───────────────────────────────────

/**
 * An attributed field combined with its layout priority.
 */
export const LayoutAttributedFieldSchema = z.object({
  field: AttributedFieldV1Schema,
  priority: LayoutPrioritySchema,
}).passthrough();

export type LayoutAttributedField = z.infer<typeof LayoutAttributedFieldSchema>;

// ─── Conflict Reason ────────────────────────────────────────────

/**
 * Reason why a header change was rejected by the authority.
 * Requirements: 43.5
 */
export const ConflictReasonSchema = z.object({
  /** Kind of conflict. */
  kind: z.enum([
    'ownership_conflict',
    'policy_conflict',
    'compatibility_conflict',
    'turn_state_conflict',
  ]),
  /** Human-readable explanation. */
  message: z.string().min(1),
  /** The authority that rejected. */
  authority: IdentifierSchema,
}).passthrough();

export type ConflictReason = z.infer<typeof ConflictReasonSchema>;

// ─── Session Header Projection V1 ──────────────────────────────

/**
 * The full composite projection envelope for the session header.
 * Every field is attributed with authority, revision, and status.
 *
 * Requirements: 43.1-43.17
 */
export const SessionHeaderProjectionV1Schema = z.object({
  /** Session identity. */
  sessionId: IdentifierSchema,
  /** All attributed fields with layout priorities. */
  fields: z.array(LayoutAttributedFieldSchema),
  /** Current provider connection status. */
  connectionStatus: ConnectionStatusSchema,
  /** Connection status source authority. */
  connectionAuthority: SourceAuthoritySchema,
  /** Active pending changes. */
  pendingChanges: z.array(PendingHeaderChangeSchema),
  /** Current layout mode. */
  layoutMode: HeaderLayoutModeSchema,
  /** Projection revision. */
  projectionRevision: z.number().int().nonnegative(),
  /** Source sequence end. */
  sourceSequence: SequenceSchema,
  schemaVersion: z.literal(1),
}).passthrough();

export type SessionHeaderProjectionV1 = z.infer<typeof SessionHeaderProjectionV1Schema>;

// ─── Narrow Layout Primary Fields ───────────────────────────────

/**
 * The field kinds that remain visible in narrow layout primary row.
 * Requirements: 43.7
 */
export const NARROW_LAYOUT_PRIMARY_FIELDS: ReadonlySet<HeaderFieldKind> = new Set([
  'project',
  'provider_connection',
  'context_pressure',
  'budget',
]);
