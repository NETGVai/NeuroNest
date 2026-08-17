/**
 * Bounded Rendering Types
 *
 * Types for bounded mount enforcement, coalesced rendering, cancellable lazy
 * work, and row measurement caching. All operational bounds are sourced from
 * Settings_Service with source revisions — no hard-coded product limits.
 *
 * Requirements: 35.10, 47.1–47.9, 47.14–47.21
 */

import { z } from 'zod';
import { PositiveFiniteSchema } from '../../settings/operational-bounds-schema';

// ─── Rendering Bounds from Settings_Service ─────────────────────

/**
 * Complete rendering bounds consumed from Settings_Service.
 * Every field must be positive and finite. Source revisions track provenance.
 */
export const RenderingBoundsSchema = z.object({
  /** Maximum mounted nodes (base window). From Settings_Service `renderer.mountLimit`. */
  mountedNodeBound: z.number().int().positive().finite(),
  /** Overscan allowance: extra nodes above/below viewport. */
  overscanAllowance: z.number().int().nonnegative().finite(),
  /** Focus-retention: extra nodes to keep focused content mounted. */
  focusRetentionAllowance: z.number().int().nonnegative().finite(),
  /** Visual update coalescing rate in milliseconds. */
  updateRateMs: PositiveFiniteSchema,
  /** Viewport margin in pixels for lazy-work triggering. */
  viewportMarginPx: PositiveFiniteSchema,
  /** Preview size limit in bytes for lazy content. */
  previewSizeLimitBytes: PositiveFiniteSchema,
  /** Cancellation deadline in milliseconds for obsolete lazy work. */
  cancellationDeadlineMs: PositiveFiniteSchema,
  /** Latency budget in milliseconds for initial render. */
  latencyBudgetMs: PositiveFiniteSchema,
  /** Memory budget in bytes for steady-state renderer. */
  memoryBudgetBytes: PositiveFiniteSchema,
  /** Measurement fixture budget in milliseconds. */
  fixtureBudgetMs: PositiveFiniteSchema,
});

export type RenderingBounds = z.infer<typeof RenderingBoundsSchema>;

/**
 * A rendering bounds value with full Settings_Service provenance.
 */
export interface ResolvedRenderingBounds {
  bounds: RenderingBounds;
  /** Source revision from Settings_Service when these bounds were resolved. */
  sourceRevision: number;
  /** The scope level that produced the resolved bounds. */
  resolvedFrom: string;
}

// ─── Content Revision for Row Measurement ───────────────────────

/**
 * Cache key for row measurement. Cached by:
 * (stableKey, contentRevision, widthClass, textScaleClass)
 */
export interface RowMeasurementKey {
  stableKey: string;
  contentRevision: number;
  widthClass: string;
  textScaleClass: string;
}

/**
 * Cached row measurement value.
 */
export interface RowMeasurement {
  heightDip: number;
  measuredAt: number; // timestamp
}

// ─── Lazy Work Descriptor ───────────────────────────────────────

/**
 * The kinds of heavy rendering work that can be deferred and cancelled.
 */
export type LazyWorkKind =
  | 'markdown'
  | 'highlighting'
  | 'mermaid'
  | 'diff'
  | 'image'
  | 'terminal'
  | 'web'
  | 'spill';

/**
 * Describes a unit of lazy rendering work that is cancellable.
 */
export interface LazyWorkDescriptor {
  /** Unique identifier for this work unit. */
  id: string;
  /** The stable key of the Chat_Node this work belongs to. */
  stableKey: string;
  /** Kind of heavy work to perform. */
  kind: LazyWorkKind;
  /** Ownership token for cancellation. */
  ownershipToken: string;
  /** Deadline timestamp in milliseconds. */
  deadline: number;
  /** Whether this work is within the viewport margin. */
  inViewportMargin: boolean;
}

/**
 * Status of a lazy work unit.
 */
export type LazyWorkStatus =
  | 'pending'
  | 'active'
  | 'completed'
  | 'cancelled';

/**
 * A tracked lazy work item with its current status.
 */
export interface TrackedLazyWork {
  descriptor: LazyWorkDescriptor;
  status: LazyWorkStatus;
  /** Set when the work was started. */
  startedAt?: number;
  /** Set when the work completed or was cancelled. */
  resolvedAt?: number;
}

// ─── Coalesced Update ───────────────────────────────────────────

/**
 * A visual delta representing a projected node change.
 */
export interface VisualDelta {
  stableKey: string;
  /** The projection revision that produced this delta. */
  projectionRevision: number;
  /** Type of change. */
  type: 'insert' | 'update' | 'remove';
  /** Opaque payload to apply. */
  payload?: unknown;
}

/**
 * The state of the coalesced render scheduler.
 */
export interface CoalescedState {
  /** Pending deltas waiting to be flushed. */
  pendingDeltas: VisualDelta[];
  /** The latest projection revision among all pending deltas. */
  latestRevision: number;
  /** Whether a flush is currently scheduled. */
  flushScheduled: boolean;
  /** Timestamp of the last flush. */
  lastFlushAt: number;
}

// ─── Mount Enforcement ──────────────────────────────────────────

/**
 * Result of a bounded mount computation.
 */
export interface BoundedMountResult {
  /** Indices of nodes to mount. */
  mountedIndices: number[];
  /** Total count of projected nodes. */
  totalProjectedCount: number;
  /** Whether the mount is at the configured maximum. */
  atBound: boolean;
  /** Source revision of the bounds used. */
  boundsSourceRevision: number;
}
