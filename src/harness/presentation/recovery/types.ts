/**
 * Recovery and Reconciliation Presentation Types
 *
 * Schemas and types for typed recovery surfaces in the Chat_Interface.
 * Defines error classification, recovery actions, preserved state,
 * reconciliation lifecycle, and stale projection labels.
 *
 * During reconciliation the UI preserves rendered history, partial output,
 * draft, anchor, unread count, queue projection, and collaboration identity
 * but disables durable mutation controls. A stale projection is labeled
 * with last verified revision/time. Recovery never replays committed
 * mutating effects; it resumes through Idempotency_Key or requires an
 * explicit new attempt.
 *
 * Requirements: 45.1–45.16
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema, SequenceSchema } from '../../contracts/primitives';

// ─── Error Classification ───────────────────────────────────────

/**
 * Typed error class for recovery surface presentation (Requirement 45.1).
 * Distinguishes recoverable from terminal failures.
 */
export const RecoveryErrorClassSchema = z.enum([
  'connectivity_interrupted',
  'schema_incompatible',
  'history_load_failed',
  'projection_stale',
  'reconciliation_failed',
  'retry_exhausted',
  'authority_unavailable',
  'terminal_failure',
]);
export type RecoveryErrorClass = z.infer<typeof RecoveryErrorClassSchema>;

/**
 * Whether the error is recoverable or terminal (Requirement 45.1, 45.9).
 */
export const RecoverabilitySchema = z.enum(['recoverable', 'terminal']);
export type Recoverability = z.infer<typeof RecoverabilitySchema>;

// ─── Recovery Action Kind ───────────────────────────────────────

/**
 * Typed recovery actions applicable to the failure (Requirement 45.7, 45.11).
 */
export const RecoveryActionKindSchema = z.enum([
  'resume',
  'retry',
  'reload',
  'export_diagnostics',
  'new_attempt',
  'remediation',
]);
export type RecoveryActionKind = z.infer<typeof RecoveryActionKindSchema>;

/**
 * A single authority-provided recovery action exposed by the surface.
 */
export const RecoveryActionSchema = z.object({
  actionId: IdentifierSchema,
  kind: RecoveryActionKindSchema,
  label: z.string().min(1),
  accessibilityLabel: z.string().min(1),
  /** Whether this action would repeat a committed effect (Requirement 45.11). */
  requiresNewAttempt: z.boolean(),
  /** Idempotency key for safe resume (Requirement 45.11). */
  idempotencyKey: IdentifierSchema.optional(),
  /** Whether this action is currently available. */
  available: z.boolean(),
  /** Reason the action is unavailable. */
  unavailableReason: z.string().optional(),
});
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;

// ─── Retry Presentation ─────────────────────────────────────────

/**
 * Retry state presentation (Requirement 45.2).
 * Shows attempt number, limit, delay, budget, route, and error class.
 */
export const RetryPresentationSchema = z.object({
  attemptNumber: z.number().int().positive().finite(),
  attemptLimit: z.number().int().positive().finite(),
  scheduledDelayMs: z.number().nonnegative().finite(),
  elapsedRetryBudgetMs: z.number().nonnegative().finite(),
  route: IdentifierSchema,
  errorClass: RecoveryErrorClassSchema,
});
export type RetryPresentation = z.infer<typeof RetryPresentationSchema>;

// ─── Connectivity Interruption ──────────────────────────────────

/**
 * Connectivity interruption presentation (Requirement 45.3).
 */
export const ConnectivityInterruptionSchema = z.object({
  /** Current state label. */
  status: z.literal('reconnecting'),
  /** Number of reconnection attempts. */
  attemptCount: z.number().int().nonnegative(),
  /** Next scheduled delay in ms. */
  nextDelayMs: z.number().nonnegative().finite(),
  /** Capabilities affected by the interruption. */
  affectedCapabilities: z.array(z.string().min(1)),
  /** Whether cancellation is available during reconnection. */
  cancellationAvailable: z.boolean(),
});
export type ConnectivityInterruption = z.infer<typeof ConnectivityInterruptionSchema>;

// ─── Schema Incompatibility ─────────────────────────────────────

/**
 * Schema incompatibility presentation (Requirement 45.5).
 */
export const SchemaIncompatibilitySchema = z.object({
  processVersion: z.string().min(1),
  compatibleSchemaRange: z.object({
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
  }),
  observedSchemaVersion: z.number().int().nonnegative(),
  /** Authority-provided remediation text from Diagnostics_Service. */
  remediation: z.string().min(1),
});
export type SchemaIncompatibility = z.infer<typeof SchemaIncompatibilitySchema>;

// ─── Stale Projection Label ─────────────────────────────────────

/**
 * Stale projection label (Requirement 45.6).
 * Applied when projected data becomes stale.
 */
export const StaleProjectionLabelSchema = z.object({
  /** Last verified projection revision. */
  lastVerifiedRevision: SequenceSchema,
  /** Timestamp of last verified projection. */
  lastVerifiedAt: TimestampSchema,
  /** Whether mutations should be presented as committed (false when stale). */
  mutationsCommitted: z.literal(false),
});
export type StaleProjectionLabel = z.infer<typeof StaleProjectionLabelSchema>;

// ─── Preserved State ────────────────────────────────────────────

/**
 * State preserved during recovery (Requirement 45.8).
 *
 * Recovery preserves the per-session draft, Semantic_Anchor, unread count,
 * partial assistant content, queue projection, and collaboration identity.
 */
export const PreservedRecoveryStateSchema = z.object({
  /** Per-session draft text content. */
  draftText: z.string(),
  /** Semantic anchor (stable key + viewport offset). */
  semanticAnchor: z.object({
    stableKey: IdentifierSchema,
    viewportOffsetPx: z.number().finite(),
  }).optional(),
  /** Unread count preserved during recovery. */
  unreadCount: z.number().int().nonnegative(),
  /** Partial assistant content visible during recovery. */
  partialAssistantContent: z.string().optional(),
  /** Queue projection snapshot preserved during recovery. */
  queueProjectionSnapshot: z.object({
    entryCount: z.number().int().nonnegative(),
    entryIds: z.array(IdentifierSchema),
  }).optional(),
  /** Collaboration identity preserved during recovery. */
  collaborationIdentity: z.object({
    collaborationId: IdentifierSchema,
    revision: z.number().int().positive().finite(),
  }).optional(),
  /** Rendered history retained during recovery (Requirement 45.4). */
  historyRetained: z.boolean(),
});
export type PreservedRecoveryState = z.infer<typeof PreservedRecoveryStateSchema>;

// ─── Mutation Control State ─────────────────────────────────────

/**
 * Durable mutation control disabled state (Requirement 45.13).
 */
export const MutationControlStateSchema = z.object({
  /** Whether durable mutation controls are disabled. */
  disabled: z.boolean(),
  /** Affected authority causing the disable. */
  affectedAuthority: IdentifierSchema,
  /** Last verified revision before disable. */
  lastVerifiedRevision: SequenceSchema,
  /** Remediation action for incompatible state (Requirement 45.14). */
  remediationAction: RecoveryActionSchema.optional(),
});
export type MutationControlState = z.infer<typeof MutationControlStateSchema>;

// ─── Reconciliation Status ──────────────────────────────────────

/**
 * The reconciliation lifecycle status.
 */
export const ReconciliationStatusSchema = z.enum([
  'idle',
  'verifying_compatibility',
  'reconciling',
  'completed',
  'incompatible',
  'failed',
]);
export type ReconciliationStatus = z.infer<typeof ReconciliationStatusSchema>;

// ─── Recovery Surface State ─────────────────────────────────────

/**
 * The full presentation state of the recovery/reconciliation surface.
 *
 * Requirements: 45.1–45.16
 */
export interface RecoverySurfaceState {
  /** Whether recovery or reconciliation is actively displayed. */
  active: boolean;

  /** The typed error class of the current failure (Requirement 45.1). */
  errorClass: RecoveryErrorClass | null;

  /** Whether the error is recoverable or terminal (Requirements 45.1, 45.9). */
  recoverability: Recoverability | null;

  /** Affected authority identity (Requirement 45.1). */
  affectedAuthority: string | null;

  /** Correlation identity for this failure (Requirement 45.1). */
  correlationId: string | null;

  /** Last verified state description (Requirement 45.1). */
  lastVerifiedState: string | null;

  /** Retry presentation if a retry is scheduled (Requirement 45.2). */
  retryPresentation: RetryPresentation | null;

  /** Connectivity interruption details (Requirement 45.3). */
  connectivityInterruption: ConnectivityInterruption | null;

  /** Schema incompatibility details (Requirement 45.5). */
  schemaIncompatibility: SchemaIncompatibility | null;

  /** Stale projection label (Requirement 45.6). */
  staleLabel: StaleProjectionLabel | null;

  /** Available recovery actions (Requirement 45.7). */
  availableActions: RecoveryAction[];

  /** State preserved during recovery (Requirement 45.8). */
  preservedState: PreservedRecoveryState | null;

  /** Durable mutation control state (Requirement 45.13). */
  mutationControlState: MutationControlState;

  /** Current reconciliation status (Requirement 45.12). */
  reconciliationStatus: ReconciliationStatus;

  /** Whether terminal outcome is displayed without success indicator (Requirement 45.9, 45.15). */
  terminalOutcomeLabel: string | null;

  /** Confirming projection revision after reconciliation (Requirement 45.16). */
  confirmingRevision: number | null;
}

// ─── Recovery Configuration ─────────────────────────────────────

/**
 * Configuration for recovery surface behavior.
 * All values are positive finite per Settings_Service contract.
 */
export const RecoverySurfaceConfigSchema = z.object({
  /** Timeout for reconciliation to complete before showing incompatible. */
  reconciliationTimeoutMs: z.number().positive().finite(),
  /** Maximum reconnection attempts before terminal. */
  maxReconnectionAttempts: z.number().int().positive().finite(),
});
export type RecoverySurfaceConfig = z.infer<typeof RecoverySurfaceConfigSchema>;

export const DEFAULT_RECOVERY_SURFACE_CONFIG: RecoverySurfaceConfig = {
  reconciliationTimeoutMs: 30_000,
  maxReconnectionAttempts: 10,
};

// ─── Recovery Projection Input ──────────────────────────────────

/**
 * Input from runtime/projection services to derive recovery surface state.
 */
export interface RecoveryProjectionInput {
  /** Current error classification. */
  errorClass: RecoveryErrorClass | null;
  /** Whether the failure is terminal. */
  terminal: boolean;
  /** Affected authority. */
  affectedAuthority: string | null;
  /** Correlation identity. */
  correlationId: string | null;
  /** Human-readable last verified state. */
  lastVerifiedState: string | null;

  /** Retry scheduling data. */
  retry?: {
    attemptNumber: number;
    attemptLimit: number;
    scheduledDelayMs: number;
    elapsedRetryBudgetMs: number;
    route: string;
  };

  /** Connectivity interruption data. */
  connectivity?: {
    attemptCount: number;
    nextDelayMs: number;
    affectedCapabilities: string[];
    cancellationAvailable: boolean;
  };

  /** Schema incompatibility data. */
  incompatibility?: {
    processVersion: string;
    compatibleSchemaRange: { min: number; max: number };
    observedSchemaVersion: number;
    remediation: string;
  };

  /** Stale projection data. */
  stale?: {
    lastVerifiedRevision: number;
    lastVerifiedAt: string;
  };

  /** Authority-provided recovery actions. */
  actions: Array<{
    actionId: string;
    kind: RecoveryActionKind;
    label: string;
    accessibilityLabel: string;
    requiresNewAttempt: boolean;
    idempotencyKey?: string;
    available: boolean;
    unavailableReason?: string;
  }>;

  /** Preserved state during recovery. */
  preserved?: {
    draftText: string;
    semanticAnchor?: { stableKey: string; viewportOffsetPx: number };
    unreadCount: number;
    partialAssistantContent?: string;
    queueProjectionSnapshot?: { entryCount: number; entryIds: string[] };
    collaborationIdentity?: { collaborationId: string; revision: number };
    historyRetained: boolean;
  };

  /** Reconciliation lifecycle. */
  reconciliation: {
    status: ReconciliationStatus;
    affectedAuthority: string;
    lastVerifiedRevision: number;
    remediationAction?: RecoveryAction;
    confirmingRevision?: number;
  };
}

// ─── Accessibility View ─────────────────────────────────────────

/**
 * Accessibility data for the recovery surface.
 * Exposes error, stale, and recovery data without requiring visual
 * interaction (extends screen reader and keyboard access).
 */
export interface RecoveryAccessibilityView {
  /** ARIA role for the recovery region. */
  role: 'alert' | 'status' | 'region';
  /** ARIA live assertiveness. */
  liveAssertiveness: 'polite' | 'assertive';
  /** Localized label for the recovery surface. */
  ariaLabel: string;
  /** Description of the error or state. */
  description: string;
  /** Available action labels for keyboard access. */
  actionLabels: string[];
  /** Whether a terminal outcome with no success indicator is displayed. */
  showsTerminalOutcome: boolean;
}
