/**
 * Collaboration Takeover Presentation Types
 *
 * Schemas and types for exact collaboration takeover surfaces in the
 * Composer_Workbench. Defines the projected takeover state, decision
 * controls, accessibility data, and submission/confirmation lifecycle.
 *
 * Exactly one unanswered question, approval, or plan review may own the
 * Composer_Workbench. Takeover suppresses the duplicate timeline card,
 * preserves the draft transaction, validates answers against the exact
 * projected schema, and commits at most one decision through
 * Collaboration_Service.
 *
 * Requirements: 38.1–38.16
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema } from '../../contracts/primitives';
import { ScopeDescriptorV1Schema } from '../../contracts/scope';
import {
  CollaborationKindSchema,
  ApprovalDigestSchema,
  AnswerSchemaDefinitionSchema,
} from '../../runtime/collaboration-schemas';

// ─── Takeover Kind ──────────────────────────────────────────────

/**
 * The kind of collaboration contract currently taking over the composer.
 */
export const TakeoverKindSchema = z.enum(['question', 'approval', 'plan_review']);
export type TakeoverKind = z.infer<typeof TakeoverKindSchema>;

// ─── Takeover Status ────────────────────────────────────────────

/**
 * The lifecycle status of a collaboration takeover in the UI.
 *
 * - active: the takeover is owning the composer
 * - submitting: a decision has been submitted, awaiting projection confirmation
 * - committed: decision confirmed by projection
 * - expired: contract expired before a decision
 * - superseded: another collaboration contract replaced this one
 * - unavailable: owning authority/process is unavailable
 * - rejected: decision was rejected (stale revision, invalid answer, etc.)
 */
export const TakeoverStatusSchema = z.enum([
  'active',
  'submitting',
  'committed',
  'expired',
  'superseded',
  'unavailable',
  'rejected',
]);
export type TakeoverStatus = z.infer<typeof TakeoverStatusSchema>;

// ─── Decision Action ────────────────────────────────────────────

/**
 * Available decision actions for the current takeover.
 */
export const DecisionActionSchema = z.enum([
  'answer',
  'approve',
  'deny',
  'select_preset',
]);
export type DecisionAction = z.infer<typeof DecisionActionSchema>;

// ─── Projected Takeover Contract ────────────────────────────────

/**
 * The projected collaboration contract that is taking over the composer.
 * This is a presentation-layer read model derived from Collaboration_Service projections.
 *
 * Req 38.1: exact question, expected answer schema, owner, and expiry
 * Req 38.2: exact Approval_Digest, scope, risk summary, owner, and expiry
 * Req 38.3: exact plan revision, change summary, execution scope, and Approval_Digest
 * Req 38.5: preset identity, revision, effective scope, expiry behavior, and source authority
 */
export const ProjectedTakeoverContractSchema = z.object({
  /** Stable collaboration identity. */
  collaborationId: IdentifierSchema,

  /** Revision of the collaboration contract. */
  revision: z.number().int().positive().finite(),

  /** Kind of collaboration. */
  kind: TakeoverKindSchema,

  /** Session this belongs to. */
  sessionId: IdentifierSchema,

  /** Turn that triggered the collaboration. */
  turnId: IdentifierSchema,

  /** Owner identity (agent/tool that asked). */
  owner: IdentifierSchema,

  /** Human-readable text describing the question/approval/plan review. */
  displayText: z.string().min(1),

  /** Scope context for the decision. */
  scope: ScopeDescriptorV1Schema.optional(),

  /** Risk classification summary (for approvals). */
  riskSummary: z.string().optional(),

  /** Expected answer schema (for questions). */
  answerSchema: AnswerSchemaDefinitionSchema.optional(),

  /** Approval digest (for approvals and plan reviews). */
  approvalDigest: ApprovalDigestSchema.optional(),

  /** Plan revision identity (for plan reviews). */
  planRevisionId: IdentifierSchema.optional(),

  /** Change summary for plan reviews. */
  changeSummary: z.string().optional(),

  /** Execution scope for plan reviews. */
  executionScope: ScopeDescriptorV1Schema.optional(),

  /** Expiry timestamp. */
  expiresAt: TimestampSchema.optional(),

  /** Available actions for this contract. */
  availableActions: z.array(DecisionActionSchema),

  /** Permission presets selectable for this takeover. */
  selectablePresets: z.array(z.object({
    presetId: IdentifierSchema,
    revision: z.number().int().positive().finite(),
    name: z.string().min(1),
    effectiveScope: ScopeDescriptorV1Schema,
    expiryBehavior: z.string().optional(),
    sourceAuthority: IdentifierSchema,
  })).optional(),

  /** Contract integrity digest. */
  contractDigest: z.string().min(1),

  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type ProjectedTakeoverContract = z.infer<typeof ProjectedTakeoverContractSchema>;

// ─── Accessibility Decision Data ────────────────────────────────

/**
 * Complete decision data exposed to keyboard and screen-reader users
 * without requiring hover (Req 38.12).
 */
export interface AccessibilityDecisionData {
  /** Human-readable label for the decision surface. */
  ariaLabel: string;
  /** Full decision text. */
  decisionText: string;
  /** Scope description. */
  scopeDescription: string;
  /** Risk description. */
  riskDescription: string;
  /** Expiry description. */
  expiryDescription: string;
  /** Available controls with their labels. */
  controls: Array<{
    action: DecisionAction;
    label: string;
    ariaDescription: string;
    disabled: boolean;
    disabledReason?: string;
  }>;
  /** Role for screen reader announcement. */
  role: 'dialog' | 'alertdialog';
  /** Whether the takeover is live (for aria-live). */
  live: boolean;
}

// ─── Decision Submission ────────────────────────────────────────

/**
 * Input to submit a collaboration decision from the takeover surface.
 */
export const TakeoverDecisionSubmissionSchema = z.object({
  /** Collaboration identity being answered. */
  collaborationId: IdentifierSchema,

  /** Expected revision of the collaboration contract. */
  expectedRevision: z.number().int().positive().finite(),

  /** Decision action. */
  action: DecisionActionSchema,

  /** Answer value (for questions). Validated against the answer schema. */
  answerValue: z.unknown().optional(),

  /** Selected preset ID (for select_preset action). */
  selectedPresetId: IdentifierSchema.optional(),

  /** Actor making the decision. */
  actor: IdentifierSchema,

  /** Idempotency key to prevent duplicate decisions. */
  idempotencyKey: IdentifierSchema,

  /** Timestamp of submission. */
  submittedAt: TimestampSchema,
}).passthrough();

export type TakeoverDecisionSubmission = z.infer<typeof TakeoverDecisionSubmissionSchema>;

// ─── Takeover State ─────────────────────────────────────────────

/**
 * The full ephemeral state of a collaboration takeover in the presentation layer.
 */
export interface CollaborationTakeoverState {
  /** Whether a takeover is currently active. */
  active: boolean;

  /** The projected contract owning the composer (null if none). */
  contract: ProjectedTakeoverContract | null;

  /** Current lifecycle status of the takeover. */
  status: TakeoverStatus;

  /** Suppressed timeline node stable keys for this collaboration identity. */
  suppressedTimelineKeys: Set<string>;

  /** The prior draft state preserved for restoration (Req 38.8). */
  preservedDraft: PreservedDraft | null;

  /** The pending decision submission if awaiting projection confirmation (Req 38.10). */
  pendingDecision: TakeoverDecisionSubmission | null;

  /** Projection revision at which the takeover was activated. */
  sourceProjectionRevision: number;

  /** Rejection or unavailability reason. */
  failureReason?: string;

  /** Current collaboration identity and revision for duplicate detection (Req 38.15). */
  currentIdentity?: { collaborationId: string; revision: number };

  /** The canonical stable key from projection (Req 9.1–9.2). No independent key derivation. */
  canonicalStableKey?: string;
}

// ─── Preserved Draft ────────────────────────────────────────────

/**
 * Snapshot of the composer draft state preserved during takeover (Req 38.8).
 */
export interface PreservedDraft {
  /** Text content. */
  text: string;
  /** Selection/cursor position. */
  selectionStart: number;
  selectionEnd: number;
  /** Focus target to restore to. */
  focusTarget: string;
}

// ─── Takeover Configuration ─────────────────────────────────────

/**
 * Configuration for the collaboration takeover store.
 * All values are positive finite per Settings_Service contract.
 */
export const TakeoverConfigSchema = z.object({
  /** Timeout (ms) for awaiting projection confirmation after submitting a decision. */
  projectionConfirmTimeoutMs: z.number().positive().finite(),

  /** Maximum number of resolved takeovers to retain. */
  maxResolvedRetention: z.number().int().positive().finite(),
});

export type TakeoverConfig = z.infer<typeof TakeoverConfigSchema>;

export const DEFAULT_TAKEOVER_CONFIG: TakeoverConfig = {
  projectionConfirmTimeoutMs: 30_000,
  maxResolvedRetention: 20,
};

// ─── Takeover Projection Input ──────────────────────────────────

/**
 * Input from Projection_Service for resolving takeover state.
 */
export interface TakeoverProjectionUpdate {
  /** New projection revision. */
  projectionRevision: number;

  /** Confirmed decision IDs. */
  confirmedDecisionIds: string[];

  /** Current collaboration state (updated from projection). */
  collaborationState?: 'pending' | 'answered' | 'approved' | 'denied' | 'expired' | 'superseded';

  /** Timestamp of the projection. */
  projectedAt: string;
}

// ─── Takeover View ──────────────────────────────────────────────

/**
 * The presentation view for rendering the collaboration takeover surface.
 */
export interface CollaborationTakeoverView {
  /** Whether the takeover is active and displayed. */
  visible: boolean;

  /** Kind of collaboration (for rendering the appropriate controls). */
  kind: TakeoverKind | null;

  /** Display text (question text or approval description). */
  displayText: string;

  /** Accessibility data for keyboard/screen-reader users. */
  accessibility: AccessibilityDecisionData;

  /** Current status. */
  status: TakeoverStatus;

  /** Whether submission is disabled (unavailable authority or expired). */
  submitDisabled: boolean;

  /** Reason submission is disabled. */
  submitDisabledReason?: string;

  /** Whether an answer is being validated. */
  validating: boolean;

  /** Timeline keys to suppress. */
  suppressedTimelineKeys: ReadonlySet<string>;
}
