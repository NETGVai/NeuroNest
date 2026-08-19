/**
 * Windowing and Bounded Rendering Controller Integration
 *
 * Composes `WindowedTimelineEngine`, `BoundedMountController`, `RowMeasurementCache`,
 * `CancellableLazyWorkManager`, `ProjectedKeyboardNavigator`, and `CoalescedRenderScheduler`
 * into a unified controller for the structured response renderer.
 *
 * Operates on canonical projected descriptors rather than DOM siblings.
 * Loads latest page initially, prepends bounded pages, pins eligible focused rows,
 * cancels heavy off-viewport work, and exposes configured/effective mount bounds.
 *
 * Requirements: 19.4–19.7, 19.9, 22.7
 *
 * @vitest-environment jsdom
 */

import {
  WindowedTimelineEngine,
  ProjectedKeyboardNavigator,
  type ProjectedNodeDescriptor,
  type WindowingBounds,
  type WindowedRange,
  type PageRequest,
  type PageDirection,
} from '../../harness/presentation/windowing';

import {
  BoundedMountController,
  CoalescedRenderScheduler,
  CancellableLazyWorkManager,
  RowMeasurementCache,
  type ResolvedRenderingBounds,
  type VisualDelta,
  type LazyWorkDescriptor,
  type LazyWorkStatus,
  type BoundedMountResult,
} from '../../harness/presentation/rendering';

import type { PageRequestHandler } from '../../harness/presentation/windowing/projected-keyboard-navigator';
import type { SchedulerTimer, FlushCallback } from '../../harness/presentation/rendering/coalesced-render-scheduler';
import type { LazyWorkTimer, LazyWorkExecutor, LazyWorkCancelHandler } from '../../harness/presentation/rendering/cancellable-lazy-work';
import type { AnchorCorrectionCallback } from '../../harness/presentation/rendering/row-measurement-cache';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Configuration for the windowing and bounded rendering integration.
 */
export interface WindowingControllerConfig {
  /** Session identity for page requests. */
  sessionId: string;
  /** Branch identity for page requests. */
  branchId: string;
  /** Windowing bounds from Settings_Service. */
  windowingBounds: WindowingBounds;
  /** Resolved rendering bounds from Settings_Service. */
  renderingBounds: ResolvedRenderingBounds;
  /** Timer abstraction for coalesced rendering and lazy work. */
  timer?: SchedulerTimer & LazyWorkTimer;
}

/**
 * A page of projected node descriptors.
 */
export interface ProjectedPage {
  /** The descriptors in projected order. */
  nodes: ProjectedNodeDescriptor[];
  /** Direction of this page relative to the existing timeline. */
  direction: 'initial' | 'prepend' | 'append';
  /** Stable key of the cursor for this page boundary (for deduplication). */
  cursorKey?: string;
}

/**
 * Effective bounds currently applied by the controller.
 */
export interface EffectiveBounds {
  /** Configured maximum mounted node count. */
  configuredMountLimit: number;
  /** Actual maximum including overscan and focus retention. */
  effectiveMaxMounted: number;
  /** Currently mounted node count. */
  currentlyMounted: number;
  /** Total projected node count. */
  totalProjected: number;
  /** Whether bounded rendering is active (timeline exceeds budget). */
  boundedRenderingActive: boolean;
  /** Settings source revision for these bounds. */
  boundsSourceRevision: number;
}

/**
 * Page load request emitted when the user navigates beyond the current window.
 */
export interface PageLoadRequest {
  direction: PageDirection;
  fromIndex: number;
  sessionId: string;
  branchId: string;
}

/**
 * Flush result passed to the consumer after coalesced visual updates.
 */
export interface FlushResult {
  deltas: VisualDelta[];
  latestRevision: number;
}

/**
 * Callbacks the consumer provides to the controller.
 */
export interface WindowingControllerCallbacks {
  /** Called when a coalesced batch of visual deltas is ready to render. */
  onFlush: (result: FlushResult) => void;
  /** Called when a page load is requested (keyboard navigation at edge). */
  onPageRequest: (request: PageLoadRequest) => void;
  /** Called when lazy work should be executed. */
  onLazyWorkExecute: LazyWorkExecutor;
  /** Called when lazy work is cancelled. */
  onLazyWorkCancel: LazyWorkCancelHandler;
  /** Called when anchor correction is needed after measurement invalidation. */
  onAnchorCorrection: AnchorCorrectionCallback;
}

// ─── Default Timer ──────────────────────────────────────────────

const defaultCombinedTimer: SchedulerTimer & LazyWorkTimer = {
  now: () => Date.now(),
  schedule: (cb: () => void, delay: number) => setTimeout(cb, delay),
  cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// ─── Controller ─────────────────────────────────────────────────

/**
 * WindoowingControllerIntegration unifies windowing, bounded mounts, measurement
 * caching, lazy work cancellation, coalesced rendering, and projected keyboard
 * navigation into a single coherent controller for the structured response renderer.
 *
 * It operates exclusively on canonical projected descriptors, not DOM siblings.
 */
export class WindowingControllerIntegration {
  private readonly windowEngine: WindowedTimelineEngine;
  private readonly mountController: BoundedMountController;
  private readonly measurementCache: RowMeasurementCache;
  private readonly lazyWorkManager: CancellableLazyWorkManager;
  private readonly renderScheduler: CoalescedRenderScheduler;
  private readonly keyboardNavigator: ProjectedKeyboardNavigator;

  private readonly config: WindowingControllerConfig;
  private readonly callbacks: WindowingControllerCallbacks;

  private allNodes: ProjectedNodeDescriptor[] = [];
  private pageKeys: Set<string> = new Set();
  private disposed: boolean = false;
  private latestPageLoaded: boolean = false;

  constructor(config: WindowingControllerConfig, callbacks: WindowingControllerCallbacks) {
    this.config = config;
    this.callbacks = callbacks;

    const timer = config.timer ?? defaultCombinedTimer;

    // Initialize windowing engine
    this.windowEngine = new WindowedTimelineEngine(config.windowingBounds);

    // Initialize bounded mount controller
    this.mountController = new BoundedMountController(config.renderingBounds);

    // Initialize measurement cache
    this.measurementCache = new RowMeasurementCache(config.renderingBounds);
    this.measurementCache.onAnchorCorrection(callbacks.onAnchorCorrection);

    // Initialize lazy work manager
    this.lazyWorkManager = new CancellableLazyWorkManager(
      config.renderingBounds,
      callbacks.onLazyWorkExecute,
      callbacks.onLazyWorkCancel,
      timer,
    );

    // Initialize coalesced render scheduler
    this.renderScheduler = new CoalescedRenderScheduler(
      config.renderingBounds,
      (deltas: VisualDelta[], latestRevision: number) => {
        callbacks.onFlush({ deltas, latestRevision });
      },
      timer,
    );

    // Initialize keyboard navigator with page request routing
    this.keyboardNavigator = new ProjectedKeyboardNavigator();
    this.keyboardNavigator.setContext(config.sessionId, config.branchId);
    this.keyboardNavigator.setPageRequestHandler({
      requestPage: (request: PageRequest) => {
        callbacks.onPageRequest({
          direction: request.direction,
          fromIndex: request.fromIndex,
          sessionId: request.sessionId,
          branchId: request.branchId,
        });
      },
    });
  }

  // ─── Page Management ────────────────────────────────────────────

  /**
   * Load the initial (latest) page of projected nodes.
   * The controller starts with the latest page and positions the viewport
   * at the end to follow bottom.
   */
  loadInitialPage(page: ProjectedPage): void {
    if (this.disposed) return;

    this.allNodes = [...page.nodes];
    this.latestPageLoaded = true;
    if (page.cursorKey) this.pageKeys.add(page.cursorKey);

    this.syncProjectedNodes();

    // Position viewport at end for bottom-follow
    const lastIndex = Math.max(0, this.allNodes.length - 1);
    this.windowEngine.setViewportCenter(lastIndex);
    this.mountController.setViewportCenter(lastIndex);
  }

  /**
   * Prepend a bounded page of older nodes to the timeline.
   * Deduplicates by cursor key to prevent double-loading.
   */
  prependPage(page: ProjectedPage): void {
    if (this.disposed) return;
    if (page.cursorKey && this.pageKeys.has(page.cursorKey)) return; // deduplicate

    if (page.cursorKey) this.pageKeys.add(page.cursorKey);

    // Prepend older nodes before existing
    this.allNodes = [...page.nodes, ...this.allNodes];

    this.syncProjectedNodes();
  }

  /**
   * Append a page of newer nodes to the timeline.
   * Deduplicates by cursor key.
   */
  appendPage(page: ProjectedPage): void {
    if (this.disposed) return;
    if (page.cursorKey && this.pageKeys.has(page.cursorKey)) return;

    if (page.cursorKey) this.pageKeys.add(page.cursorKey);

    this.allNodes = [...this.allNodes, ...page.nodes];

    this.syncProjectedNodes();
  }

  // ─── Projection Updates ─────────────────────────────────────────

  /**
   * Apply incremental projection deltas via the coalesced scheduler.
   * New nodes are appended; updated nodes have their descriptors replaced;
   * removed nodes are filtered out.
   */
  applyDeltas(deltas: VisualDelta[]): void {
    if (this.disposed) return;

    for (const delta of deltas) {
      if (delta.type === 'remove') {
        // Remove from projected list
        this.allNodes = this.allNodes.filter(n => n.stableKey !== delta.stableKey);
        // Cancel any lazy work for removed nodes
        this.lazyWorkManager.onLeaveViewportMargin(delta.stableKey);
        // Invalidate measurement
        this.measurementCache.invalidateByStableKey(delta.stableKey);
      }
    }

    // Push visual deltas for coalesced rendering
    this.renderScheduler.pushDeltas(deltas);
    this.syncProjectedNodes();
  }

  /**
   * Replace the full set of projected nodes (e.g. after a session switch or
   * full re-projection).
   */
  replaceAllNodes(nodes: ProjectedNodeDescriptor[]): void {
    if (this.disposed) return;

    this.allNodes = [...nodes];
    this.pageKeys.clear();
    this.latestPageLoaded = true;

    this.syncProjectedNodes();
  }

  // ─── Viewport Control ───────────────────────────────────────────

  /**
   * Update the viewport center index. This drives which nodes are mounted.
   */
  setViewportCenter(index: number): void {
    if (this.disposed) return;

    this.windowEngine.setViewportCenter(index);
    this.mountController.setViewportCenter(index);
    this.updateLazyWorkVisibility();
  }

  /**
   * Mark a node as focused. The windowing engine pins focused nodes within
   * the focus-retention allowance even if outside the normal window.
   */
  setFocusedNode(stableKey: string): void {
    if (this.disposed) return;

    // Update the focused flag on the matching descriptor
    for (const node of this.allNodes) {
      node.focused = node.stableKey === stableKey;
    }

    this.syncProjectedNodes();
    this.keyboardNavigator.setFocusByKey(stableKey);
  }

  /**
   * Clear focus from all nodes.
   */
  clearFocus(): void {
    if (this.disposed) return;

    for (const node of this.allNodes) {
      node.focused = false;
    }

    this.syncProjectedNodes();
  }

  // ─── Keyboard Navigation ────────────────────────────────────────

  /**
   * Navigate to the next focusable node in projected order.
   */
  navigateNext(): ProjectedNodeDescriptor | null {
    if (this.disposed) return null;

    const range = this.windowEngine.computeWindowedRange();
    return this.keyboardNavigator.moveNext(range);
  }

  /**
   * Navigate to the previous focusable node in projected order.
   */
  navigatePrevious(): ProjectedNodeDescriptor | null {
    if (this.disposed) return null;

    const range = this.windowEngine.computeWindowedRange();
    return this.keyboardNavigator.movePrevious(range);
  }

  /**
   * Navigate to the first focusable node.
   */
  navigateToFirst(): ProjectedNodeDescriptor | null {
    if (this.disposed) return null;

    const range = this.windowEngine.computeWindowedRange();
    return this.keyboardNavigator.moveToFirst(range);
  }

  /**
   * Navigate to the last focusable node.
   */
  navigateToLast(): ProjectedNodeDescriptor | null {
    if (this.disposed) return null;

    const range = this.windowEngine.computeWindowedRange();
    return this.keyboardNavigator.moveToLast(range);
  }

  // ─── Lazy Work ──────────────────────────────────────────────────

  /**
   * Register deferred heavy work for a node (Markdown, highlighting, etc).
   * Work is executed when the node enters the viewport margin and cancelled
   * when it leaves or becomes obsolete.
   */
  registerLazyWork(descriptor: LazyWorkDescriptor): void {
    if (this.disposed) return;
    this.lazyWorkManager.register(descriptor);
  }

  /**
   * Mark a lazy work item as completed.
   */
  completeLazyWork(workId: string): void {
    if (this.disposed) return;
    this.lazyWorkManager.markCompleted(workId);
  }

  /**
   * Mark lazy work as obsolete (e.g. content revision changed).
   */
  obsoleteLazyWork(workId: string): void {
    if (this.disposed) return;
    this.lazyWorkManager.markObsolete(workId);
  }

  /**
   * Get the status of a lazy work item.
   */
  getLazyWorkStatus(workId: string): LazyWorkStatus | undefined {
    return this.lazyWorkManager.getWorkStatus(workId);
  }

  // ─── Measurement Cache ──────────────────────────────────────────

  /**
   * Record a measured row height for a node.
   */
  recordMeasurement(
    stableKey: string,
    contentRevision: number,
    widthClass: string,
    textScaleClass: string,
    heightDip: number,
  ): void {
    if (this.disposed) return;

    this.measurementCache.set(
      { stableKey, contentRevision, widthClass, textScaleClass },
      { heightDip, measuredAt: Date.now() },
    );
  }

  /**
   * Invalidate measurements for a node (e.g. content revision changed).
   */
  invalidateMeasurement(stableKey: string): void {
    if (this.disposed) return;
    this.measurementCache.invalidateByStableKey(stableKey);
  }

  /**
   * Handle a theme revision change. Only theme-dependent measurement/style
   * caches invalidate; identity/stable-key structures (window engine, mount
   * controller, lazy work tracking, keyboard navigator, pageKeys, allNodes)
   * remain untouched — the same stable keys continue to project the same
   * rows and lazy work stays owned by the same descriptors.
   *
   * Consumers subscribe `ThemeRevisionService` and forward the callback here.
   *
   * Requirements: 14.1–14.2, 15.9.
   */
  onThemeRevisionChange(): void {
    if (this.disposed) return;
    this.measurementCache.invalidateByThemeRevision();
  }

  // ─── Query API ──────────────────────────────────────────────────

  /**
   * Compute the current windowed range of nodes to mount.
   */
  computeWindowedRange(): WindowedRange {
    return this.windowEngine.computeWindowedRange();
  }

  /**
   * Compute the bounded mount result (indices of nodes to actually mount).
   */
  computeMountedIndices(): BoundedMountResult {
    return this.mountController.computeMountedIndices();
  }

  /**
   * Get the effective bounds currently in use.
   */
  getEffectiveBounds(): EffectiveBounds {
    const mountResult = this.mountController.computeMountedIndices();
    const resolvedBounds = this.mountController.getResolvedBounds();

    return {
      configuredMountLimit: resolvedBounds.bounds.mountedNodeBound,
      effectiveMaxMounted: this.mountController.maxAllowedMounts(),
      currentlyMounted: mountResult.mountedIndices.length,
      totalProjected: mountResult.totalProjectedCount,
      boundedRenderingActive: mountResult.atBound,
      boundsSourceRevision: mountResult.boundsSourceRevision,
    };
  }

  /**
   * Get the total projected node count.
   */
  getTotalNodeCount(): number {
    return this.allNodes.length;
  }

  /**
   * Get a node by stable key.
   */
  getNodeByKey(stableKey: string): ProjectedNodeDescriptor | undefined {
    return this.allNodes.find(n => n.stableKey === stableKey);
  }

  /**
   * Whether the initial (latest) page has been loaded.
   */
  isInitialPageLoaded(): boolean {
    return this.latestPageLoaded;
  }

  /**
   * Whether the coalesced scheduler has settled (all pending deltas flushed).
   */
  isSettled(): boolean {
    return this.renderScheduler.isSettled();
  }

  /**
   * Force immediate flush of all pending coalesced deltas.
   */
  flushNow(): void {
    if (this.disposed) return;
    this.renderScheduler.flushNow();
  }

  /**
   * Get the measurement cache size (for memory diagnostics).
   */
  getMeasurementCacheSize(): number {
    return this.measurementCache.size();
  }

  /**
   * Get estimated memory usage of the measurement cache in bytes.
   */
  getEstimatedMemoryBytes(): number {
    return this.measurementCache.estimatedMemoryBytes();
  }

  // ─── Bounds Updates ─────────────────────────────────────────────

  /**
   * Update windowing bounds from a Settings_Service revision.
   */
  updateWindowingBounds(bounds: WindowingBounds): void {
    if (this.disposed) return;
    this.windowEngine.setBounds(bounds);
  }

  /**
   * Update rendering bounds from a Settings_Service revision.
   */
  updateRenderingBounds(resolvedBounds: ResolvedRenderingBounds): void {
    if (this.disposed) return;
    this.mountController.updateBounds(resolvedBounds);
    this.measurementCache.updateBounds(resolvedBounds);
    this.lazyWorkManager.updateBounds(resolvedBounds);
    this.renderScheduler.updateBounds(resolvedBounds);
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  /**
   * Dispose all sub-controllers and release resources.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.renderScheduler.dispose();
    this.lazyWorkManager.dispose();
    this.measurementCache.dispose();
    this.allNodes = [];
    this.pageKeys.clear();
  }

  /**
   * Whether the controller has been disposed.
   */
  isDisposed(): boolean {
    return this.disposed;
  }

  // ─── Private ────────────────────────────────────────────────────

  /**
   * Synchronize all sub-controllers with the current node list.
   */
  private syncProjectedNodes(): void {
    // Re-index projected nodes
    const indexed = this.allNodes.map((node, i) => ({
      ...node,
      projectedIndex: i,
    }));
    this.allNodes = indexed;

    this.windowEngine.setProjectedNodes(indexed);
    this.mountController.setProjectedNodes(indexed);
    this.keyboardNavigator.setProjectedNodes(indexed);
  }

  /**
   * Update lazy work visibility based on current viewport position.
   * Nodes entering the viewport margin trigger work; nodes leaving cancel it.
   */
  private updateLazyWorkVisibility(): void {
    const range = this.windowEngine.computeWindowedRange();
    const allWork = this.lazyWorkManager.getAllWork();

    for (const [, tracked] of allWork) {
      if (tracked.status !== 'pending' && tracked.status !== 'active') continue;

      const nodeIndex = this.allNodes.findIndex(
        n => n.stableKey === tracked.descriptor.stableKey,
      );

      if (nodeIndex === -1) {
        // Node removed — cancel
        this.lazyWorkManager.onLeaveViewportMargin(tracked.descriptor.stableKey);
        continue;
      }

      const inWindow = nodeIndex >= range.startIndex && nodeIndex < range.endIndex;
      if (inWindow && tracked.status === 'pending') {
        this.lazyWorkManager.onEnterViewportMargin(tracked.descriptor.stableKey);
      } else if (!inWindow && tracked.status === 'active') {
        this.lazyWorkManager.onLeaveViewportMargin(tracked.descriptor.stableKey);
      }
    }
  }
}
