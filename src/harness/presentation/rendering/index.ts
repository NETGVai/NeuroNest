/**
 * Bounded Rendering Module
 *
 * Provides bounded mount enforcement, coalesced rendering with content equivalence,
 * cancellable lazy work, and row measurement caching for the harness Chat_Interface.
 *
 * All operational bounds are sourced from Settings_Service with source revisions.
 * No hard-coded product limits.
 *
 * Requirements: 35.10, 47.1–47.9, 47.14–47.21
 */

export {
  RenderingBoundsSchema,
  type RenderingBounds,
  type ResolvedRenderingBounds,
  type RowMeasurementKey,
  type RowMeasurement,
  type LazyWorkKind,
  type LazyWorkDescriptor,
  type LazyWorkStatus,
  type TrackedLazyWork,
  type VisualDelta,
  type CoalescedState,
  type BoundedMountResult,
} from './types';

export {
  BoundedMountController,
} from './bounded-mount-controller';

export {
  CoalescedRenderScheduler,
  defaultTimer,
  type FlushCallback,
  type SchedulerTimer,
} from './coalesced-render-scheduler';

export {
  CancellableLazyWorkManager,
  defaultLazyWorkTimer,
  type LazyWorkTimer,
  type LazyWorkExecutor,
  type LazyWorkCancelHandler,
} from './cancellable-lazy-work';

export {
  RowMeasurementCache,
  type AnchorCorrectionCallback,
} from './row-measurement-cache';
