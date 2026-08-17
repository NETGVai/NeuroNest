/**
 * Bounded Timeline Windowing and Semantic_Anchor Types
 *
 * Defines the Semantic_Anchor contract and windowing configuration bounds
 * for the projection-driven timeline renderer. The windowing engine mounts
 * at most Settings_Service-selected node bound plus documented overscan and
 * focus-retention allowance.
 *
 * Requirements: 35.7–35.10, 35.22–35.23, 42.9, 47.2–47.8, 47.17
 */

import { z } from 'zod';
import { IdentifierSchema, SequenceSchema } from '../../contracts/primitives';

// ─── Semantic Anchor ────────────────────────────────────────────

/**
 * A Semantic_Anchor records a reader's viewport position relative to a stable
 * Chat_Node identity. Used to preserve location across paging, expansion,
 * lazy render, streaming, and asynchronous measurement.
 */
export const SemanticAnchorSchema = z.object({
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  stableKey: IdentifierSchema,
  subAnchor: IdentifierSchema.optional(),
  /** Device-independent pixel offset from the viewport top to the anchored node. */
  viewportOffsetDip: z.number().finite(),
  /** The projection revision when this anchor was recorded. */
  projectionRevision: z.number().int().positive(),
});

export type SemanticAnchor = z.infer<typeof SemanticAnchorSchema>;

// ─── Windowing Bounds ───────────────────────────────────────────

/**
 * Windowing bounds from Settings_Service. All values must be positive finite.
 * No hard-coded product limits.
 */
export const WindowingBoundsSchema = z.object({
  /** Maximum number of Chat_Nodes to mount in the viewport. */
  mountedNodeBound: z.number().int().positive().finite(),
  /** Number of additional nodes to mount above/below the visible range. */
  overscan: z.number().int().nonnegative().finite(),
  /** Number of extra nodes retained to keep focused content mounted. */
  focusRetentionAllowance: z.number().int().nonnegative().finite(),
  /** Maximum tolerable error in DIP when restoring a Semantic_Anchor. */
  anchorToleranceDip: z.number().positive().finite(),
  /** Timeout in milliseconds for layout stabilization before anchor settle. */
  layoutStabilizationTimeoutMs: z.number().positive().finite(),
});

export type WindowingBounds = z.infer<typeof WindowingBoundsSchema>;

// ─── Projected Node Descriptor ──────────────────────────────────

/**
 * A lightweight descriptor of a Chat_Node within the projection for windowing
 * purposes. The windowing engine operates on projected order, not DOM siblings.
 */
export interface ProjectedNodeDescriptor {
  /** Unique stable key from the Projection_Service. */
  stableKey: string;
  /** Projected ordering index (sessionSequence, intraEventOrdinal, stableKey). */
  projectedIndex: number;
  /** Whether this node currently has user focus (input, keyboard, aria-active). */
  focused: boolean;
  /** Measured height in DIP (undefined if not yet measured). */
  measuredHeightDip?: number;
  /** Whether this node is focusable for keyboard navigation. */
  focusable: boolean;
}

// ─── Windowed Range ─────────────────────────────────────────────

/**
 * The computed range of nodes that should be mounted in the DOM.
 */
export interface WindowedRange {
  /** Index of the first node to mount (inclusive). */
  startIndex: number;
  /** Index of the last node to mount (exclusive). */
  endIndex: number;
  /** Total number of projected nodes (for scrollbar calculation). */
  totalCount: number;
  /** Indices of focused nodes that are pinned outside the normal window. */
  pinnedIndices: number[];
}

// ─── Anchor Resolution Result ───────────────────────────────────

export type AnchorResolutionResult =
  | { resolved: true; index: number; offsetDip: number; errorDip: number }
  | { resolved: false; reason: 'key_not_found' | 'projection_incompatible'; followLatest: true };

// ─── Reader Mode ────────────────────────────────────────────────

/**
 * Tracks whether the reader owns bottom-follow behavior or is scrolled away.
 */
export type ReaderScrollMode =
  | { mode: 'bottom_follow' }
  | { mode: 'away_from_bottom'; unreadCount: number; savedAnchor: SemanticAnchor };

// ─── Page Request ───────────────────────────────────────────────

export type PageDirection = 'before' | 'after';

/**
 * Emitted when keyboard navigation crosses a window edge and needs more data.
 */
export interface PageRequest {
  direction: PageDirection;
  fromIndex: number;
  sessionId: string;
  branchId: string;
}

// ─── Anchor Unavailable Label ───────────────────────────────────

export interface AnchorUnavailableState {
  unavailable: true;
  reason: string;
  lastKnownStableKey: string;
  followingLatest: true;
}
