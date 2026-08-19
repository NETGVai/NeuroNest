/**
 * Typed Row Island Types
 *
 * Defines the contracts for row islands used during the strangler migration.
 * Row islands are typed presentation adapters that route existing rendering
 * helpers (Markdown, code, diff, diagram, image) through pure typed contracts.
 *
 * Row islands dispatch on intent.kind (not tool names) and produce
 * typed RowIslandOutput that replaces legacy DOM-based tool cards
 * and turn status rows.
 *
 * Requirements: 13.8, 35.3–35.6, 35.11, 36.1–36.17, 37.1–37.17
 */

import type { RenderIntentV1 } from '../../contracts/render-intent';
import type { CanonicalToolValueV1 } from '../../contracts/tool-value';
import type { TurnActivityState } from '../../runtime/turn-controller-schemas';
import type { PresentationOutput } from '../../presentation/types';
import type { TakeoverKind, TakeoverStatus, DecisionAction } from '../../presentation/collaboration/types';
import type { QueueType, EntryDeliveryState } from '../../runtime/queue-schemas';
import type { AttachmentDraftState } from '../../session/attachment-schemas';

// ─── Row Island Kinds ───────────────────────────────────────────

/**
 * The kind of row island — determines which component handles rendering.
 */
export type RowIslandKind = 'tool' | 'turn_status' | 'collaboration' | 'queue_dock' | 'attachment' | 'fallback';

// ─── Tool Row Island Input ──────────────────────────────────────

/**
 * Input to a tool row island. Carries the intent and canonical value
 * from which the island produces typed presentation output.
 * Tool names are display metadata only and are never used for dispatch.
 */
export interface ToolRowIslandInput {
  /** The render intent (dispatched on kind). */
  intent: unknown;
  /** The validated canonical tool value. */
  value: CanonicalToolValueV1;
  /** Tool display name (metadata only, never used for rendering dispatch). */
  toolDisplayName?: string;
  /** Model-order index for ordering in the timeline. */
  modelOrderIndex?: number;
  /** Call status for visual indicators. */
  status?: 'executing' | 'completed' | 'failed' | 'cancelled' | 'retrying';
}

// ─── Turn Status Row Island Input ───────────────────────────────

/**
 * Input to a turn status row island. Carries the projected
 * Turn_Activity_State and contextual information for rendering.
 */
export interface TurnStatusRowIslandInput {
  /** Turn identity. */
  turnId: string;
  /** Current projected lifecycle state. */
  state: TurnActivityState;
  /** Elapsed duration from durable start in milliseconds. */
  elapsedMs?: number;
  /** Whether this turn is terminal (completed, interrupted, failed). */
  isTerminal: boolean;
  /** Attempt number (1-based). */
  attempt?: number;
  /** Partial output retained from prior states. */
  partialOutput?: string;
  /** Whether stop control should be available. */
  stopAvailable?: boolean;
  /** Cancellation details if cancelling. */
  cancellationDetail?: {
    cause: string;
    pendingWorkCount: number;
    deadlineMs: number;
  };
  /** Reconnection details if reconnecting. */
  reconnectionDetail?: {
    disconnectedAt: string;
    attempt: number;
    maxAttempts: number;
  };
  /** Terminal outcome details. */
  terminalOutcome?: {
    kind: 'completed' | 'interrupted' | 'failed';
    reason?: string;
    durationMs?: number;
  };
}

// ─── Row Island Output ──────────────────────────────────────────

/**
 * The output of a row island adapter. Extends PresentationOutput with
 * island-specific metadata for the migration layer.
 */
export interface RowIslandOutput {
  /** Which row island kind produced this output. */
  islandKind: RowIslandKind;
  /** The presentation output (blocks, sanitization, etc.). */
  presentation: PresentationOutput;
  /** Stable key for this row island in the timeline. */
  stableKey: string;
  /** Accessibility label for the entire row. */
  accessibilityLabel: string;
  /** Whether this island used a fallback renderer. */
  usedFallback: boolean;
}

// ─── Row Island Interface ───────────────────────────────────────

/**
 * Interface for a typed row island adapter. Each island handles
 * one specific kind of row (tool, turn_status) and produces
 * RowIslandOutput by dispatching on typed contracts.
 */
export interface RowIsland<TInput> {
  /** The kind of row island. */
  readonly kind: RowIslandKind;
  /** Render the input into row island output. */
  render(input: TInput): RowIslandOutput;
}

// ─── Legacy Compatibility ───────────────────────────────────────

/**
 * Describes a legacy tool card that the row island replaces.
 * Used for compatibility mapping during the strangler migration.
 */
export interface LegacyToolCardData {
  /** Tool name from legacy rendering (only for compatibility mapping). */
  toolName: string;
  /** Raw arguments (to be adapted into canonical form). */
  rawArguments?: unknown;
  /** Raw output content. */
  rawOutput?: string;
  /** Whether the card was collapsed. */
  collapsed?: boolean;
}

/**
 * Describes a legacy turn status indicator that the row island replaces.
 */
export interface LegacyTurnStatusData {
  /** Legacy status string. */
  statusText: string;
  /** Whether an activity spinner was shown. */
  isActive: boolean;
  /** Legacy elapsed time display. */
  elapsedText?: string;
}

// ─── Collaboration Row Island Input ─────────────────────────────

/**
 * Input to a collaboration row island. Carries the projected takeover
 * contract details for rendering question/approval/plan-review items
 * as typed row islands in the Canonical_Timeline.
 *
 * Routes through Collaboration_Service projection/command ports.
 * Preserves old-session readability and authority ownership.
 *
 * Requirements: 38.1–38.16
 */
export interface CollaborationRowIslandInput {
  /** Stable collaboration identity. */
  collaborationId: string;
  /** Canonical stable key from the projection (replaces independent derivation). */
  canonicalStableKey: string;
  /** Collaboration kind (question, approval, plan_review). */
  kind: TakeoverKind;
  /** Human-readable text describing the collaboration. */
  displayText: string;
  /** Owner identity (agent/tool that asked). */
  owner: string;
  /** Revision of the collaboration contract. */
  revision: number;
  /** Session ID this belongs to. */
  sessionId: string;
  /** Turn that triggered the collaboration. */
  turnId: string;
  /** Current takeover status. */
  status: TakeoverStatus;
  /** Risk summary (for approvals). */
  riskSummary?: string;
  /** Available decision actions. */
  availableActions: DecisionAction[];
  /** Plan revision identity (for plan reviews). */
  planRevisionId?: string;
  /** Change summary (for plan reviews). */
  changeSummary?: string;
  /** Expiry timestamp. */
  expiresAt?: string;
  /** Whether the owning authority is available. */
  authorityAvailable: boolean;
  /** Projection revision this was derived from. */
  sourceProjectionRevision: number;
}

// ─── Queue Dock Row Island Input ────────────────────────────────

/**
 * Input to a queue dock row island. Carries a single projected queue
 * entry for rendering as a typed row island in the Canonical_Timeline.
 *
 * Routes through Turn_Controller projection/command ports.
 * Preserves old-session readability and authority ownership.
 *
 * Requirements: 39.1–39.18
 */
export interface QueueDockRowIslandInput {
  /** Stable entry identity. */
  entryId: string;
  /** Queue type (follow_up, steer, inject). */
  queueType: QueueType;
  /** Current entry revision. */
  revision: number;
  /** Committed order position. */
  position: number;
  /** Entry owner identity. */
  owner: string;
  /** Current delivery state. */
  deliveryState: EntryDeliveryState;
  /** Entry content (user text). */
  content: string;
  /** Session ID. */
  sessionId: string;
  /** Turn ID. */
  turnId: string;
  /** Projection revision this was derived from. */
  sourceProjectionRevision: number;
  /** Whether a mutation is pending for this entry. */
  mutationPending: boolean;
  /** Whether the owning authority is available. */
  authorityAvailable: boolean;
  /** Subagent ownership incompatibility reason if any. */
  subagentIncompatibilityReason?: string;
}

// ─── Attachment Row Island Input ────────────────────────────────

/**
 * Input to an attachment row island. Carries a single projected attachment
 * (draft or committed) for rendering as a typed row island.
 *
 * Routes through Attachment_Service projection/command ports.
 * Preserves old-session readability and authority ownership.
 *
 * Requirements: 41.1–41.15
 */
export interface AttachmentRowIslandInput {
  /** Stable attachment identity. */
  attachmentId: string;
  /** Current state in the draft lifecycle. */
  state: AttachmentDraftState;
  /** Media type. */
  mediaType: string;
  /** Declared filename (metadata only, no private paths). */
  declaredFilename?: string;
  /** Size in bytes. */
  sizeBytes: number;
  /** Image dimensions if applicable. */
  dimensions?: { width: number; height: number };
  /** Duration in seconds (audio/video). */
  duration?: number;
  /** Content hash for committed attachments. */
  contentHash?: string;
  /** Session ID. */
  sessionId: string;
  /** Whether this is committed (immutable). */
  isCommitted: boolean;
  /** Retention status. */
  retentionStatus?: 'active' | 'expiring' | 'expired';
  /** Failed stage (if in error state). */
  failedStage?: string;
  /** Error reason (redacted, no private paths). */
  errorReason?: string;
  /** Projection revision this was derived from. */
  sourceProjectionRevision: number;
  /** Whether the owning authority is available. */
  authorityAvailable: boolean;
}

// ─── Legacy Compatibility for New Islands ───────────────────────

/**
 * Legacy collaboration item from older session formats.
 */
export interface LegacyCollaborationData {
  /** Type indicator. */
  type: string;
  /** Human-readable description. */
  description: string;
  /** Owner/agent name. */
  owner?: string;
  /** Whether it was resolved. */
  resolved?: boolean;
}

/**
 * Legacy queue item from older session formats.
 */
export interface LegacyQueueEntryData {
  /** Content text. */
  content: string;
  /** Type label. */
  type?: string;
  /** Whether it was delivered. */
  delivered?: boolean;
}

/**
 * Legacy attachment reference from older session formats.
 */
export interface LegacyAttachmentData {
  /** Filename. */
  filename?: string;
  /** Media type. */
  mediaType?: string;
  /** Size in bytes. */
  sizeBytes?: number;
  /** Status label. */
  status?: string;
}
