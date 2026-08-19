/**
 * Reader Ownership Controller
 *
 * Integrates the headless ReaderScrollController with the structured chat
 * shell's timeline DOM. Manages the transition between bottom-follow and
 * away-from-bottom modes, drives the unread badge UI, and preserves the
 * read boundary across projection updates, prepends, stream coalescing,
 * and session restoration.
 *
 * Key contract: the reader owns scroll position. No projection update,
 * prepend, expansion, or coalesced delta forces the reader away from their
 * chosen position. Unread count is derived from canonical projection
 * (not mounted rows).
 *
 * The controller also exposes an explicit anchor capture/restore protocol
 * used by the projection-driven chat shell (task 11.4) to preserve the
 * reader's viewport across reconciles when content above the reader's
 * position is remeasured or re-rendered. The captured anchor is a stable
 * block key plus its offset from the timeline scrollTop; restore locates
 * the same key in the post-reconcile DOM and adjusts scrollTop so the
 * anchored block returns to the same viewport offset.
 *
 * Requirements: 10.3, 10.4, 14.4, 14.7, 19.1–19.3, 21.11, 22.4
 */

import {
  ReaderScrollController,
  type ScrollPositionProvider,
} from '../../harness/presentation/windowing/reader-scroll-controller';
import type { SemanticAnchor } from '../../harness/presentation/windowing/types';

// ─── Configuration ──────────────────────────────────────────────

/**
 * Configuration for the Reader Ownership Controller.
 * All thresholds come from settings, not hard-coded product values.
 */
export interface ReaderOwnershipConfig {
  /**
   * Threshold in pixels from the bottom below which the reader is
   * considered "near bottom". While near-bottom, bottom-follow keeps
   * the latest streamed content visible. Once the reader scrolls farther
   * than the threshold, bottom-follow turns off and the anchor is
   * captured. Typical values are 48–100 px (roughly one line of chrome).
   */
  bottomThresholdPx: number;
  /** Whether to auto-follow on initial mount (new sessions start following). */
  autoFollowOnMount: boolean;
}

export const DEFAULT_READER_OWNERSHIP_CONFIG: ReaderOwnershipConfig = {
  bottomThresholdPx: 48,
  autoFollowOnMount: true,
};

// ─── Scroll Anchor Snapshot ────────────────────────────────────

/**
 * Snapshot of the reader's scroll anchor captured immediately before a
 * projection re-render. The controller uses this to restore the reader's
 * viewport onto the same block after the DOM is reconciled.
 *
 * Only meaningful when the reader is not following the bottom. When the
 * reader is at the bottom, projection updates that add content trigger a
 * re-scroll to bottom instead of an anchor restore.
 */
export interface ScrollAnchorSnapshot {
  /**
   * `data-stable-key` of the block whose top edge is at or just above the
   * viewport top when the snapshot is taken. The controller only anchors
   * onto elements with a stable identity — retry lineage, block kind, and
   * response-group re-renders all preserve this key.
   */
  readonly stableKey: string;
  /**
   * Pixel offset between the block's `offsetTop` and the timeline
   * `scrollTop` at the time of capture. Restore uses this to place the
   * anchored block at the same position within the viewport.
   */
  readonly viewportOffset: number;
}

// ─── Unread Badge State ─────────────────────────────────────────

/**
 * State emitted to the unread badge UI component.
 */
export interface UnreadBadgeState {
  /** Whether the badge should be visible. */
  visible: boolean;
  /** Exact unread node count (0 if following bottom). */
  unreadCount: number;
  /** Label for accessibility (e.g., "3 new messages, jump to latest"). */
  ariaLabel: string;
}

// ─── Listener ───────────────────────────────────────────────────

export type ReaderOwnershipListener = (state: UnreadBadgeState) => void;

// ─── Controller ─────────────────────────────────────────────────

/**
 * ReaderOwnershipController bridges the headless ReaderScrollController
 * with the structured chat shell timeline DOM element.
 */
export class ReaderOwnershipController {
  private readonly scrollController: ReaderScrollController;
  private readonly config: ReaderOwnershipConfig;
  private timelineElement: HTMLElement | null = null;
  private listeners: ReaderOwnershipListener[] = [];
  private disposed: boolean = false;
  private boundOnScroll: (() => void) | null = null;
  private lastProjectedNodeCount: number = 0;
  private lastReadStableKey: string | null = null;

  constructor(
    sessionId: string,
    branchId: string,
    config: Partial<ReaderOwnershipConfig> = {},
  ) {
    this.config = { ...DEFAULT_READER_OWNERSHIP_CONFIG, ...config };
    this.scrollController = new ReaderScrollController(
      sessionId,
      branchId,
      this.config.autoFollowOnMount ? { mode: 'bottom_follow' } : undefined,
    );
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  /**
   * Attach to a timeline DOM element. Sets up scroll event listeners.
   */
  attach(timelineElement: HTMLElement): void {
    if (this.disposed) return;
    this.detach();
    this.timelineElement = timelineElement;

    this.boundOnScroll = () => this.handleScroll();
    this.timelineElement.addEventListener('scroll', this.boundOnScroll, { passive: true });

    // Emit initial state
    this.notifyListeners();
  }

  /**
   * Detach from the current timeline element. Removes event listeners.
   */
  detach(): void {
    if (this.timelineElement && this.boundOnScroll) {
      this.timelineElement.removeEventListener('scroll', this.boundOnScroll);
    }
    this.timelineElement = null;
    this.boundOnScroll = null;
  }

  /**
   * Dispose the controller entirely. No further operations are valid.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    this.listeners = [];
  }

  // ─── Projection Updates ─────────────────────────────────────────

  /**
   * Called when a projection delta arrives (new nodes appended, updated,
   * or prepended). Updates unread tracking without forcing scroll.
   *
   * @param totalNodeCount Total canonical projected node count for this session.
   * @param lastStableKey  The stable key of the latest (bottom-most) node.
   */
  onProjectionUpdate(totalNodeCount: number, lastStableKey?: string): void {
    if (this.disposed) return;

    const provider = this.createScrollProvider();
    const shouldScroll = this.scrollController.onProjectionUpdate(totalNodeCount, provider);

    // If bottom-follow and new content arrives, update the read boundary
    if (shouldScroll && lastStableKey) {
      this.lastReadStableKey = lastStableKey;
    }

    this.lastProjectedNodeCount = totalNodeCount;
    this.notifyListeners();
  }

  /**
   * Called when content expands in-place (e.g., Markdown finalization, lazy
   * render, image load). Does not change unread count; preserves position
   * unless following bottom.
   */
  onContentExpand(): void {
    if (this.disposed) return;

    if (this.scrollController.isBottomFollow() && this.timelineElement) {
      // Keep latest visible by scrolling to bottom
      this.scrollToBottom();
    }
    // Away mode: do nothing, preserving reader position
  }

  /**
   * Called when pages are prepended (loading history). Does not change
   * unread count or force scroll regardless of mode.
   */
  onPrepend(): void {
    // Prepending older content does not affect unread tracking.
    // The SemanticAnchorController handles preserving visual position.
    // This is intentionally a no-op for reader ownership.
  }

  /**
   * Called on stream coalescing (high-frequency token updates). If following
   * bottom, keeps latest visible. Otherwise no-op.
   */
  onStreamCoalesce(): void {
    if (this.disposed) return;
    if (this.scrollController.isBottomFollow() && this.timelineElement) {
      this.scrollToBottom();
    }
  }

  /**
   * Restore reader state from a previously persisted session anchor.
   * If the anchor indicates away-from-bottom, restores unread count
   * without forcing scroll.
   */
  restoreSession(
    savedMode: 'bottom_follow' | 'away_from_bottom',
    savedUnreadCount: number,
    totalNodeCount: number,
    lastReadKey: string | null,
  ): void {
    if (this.disposed) return;

    this.lastProjectedNodeCount = totalNodeCount;
    this.lastReadStableKey = lastReadKey;
    this.scrollController.resetNodeCount(totalNodeCount);

    if (savedMode === 'bottom_follow') {
      const provider = this.createScrollProvider();
      this.scrollController.followBottom(provider);
    } else {
      // Simulate away-from-bottom by creating a dummy anchor and scrolling away
      const anchor: SemanticAnchor = {
        sessionId: this.scrollController.getSessionId(),
        branchId: this.scrollController.getBranchId(),
        stableKey: lastReadKey ?? 'unknown',
        viewportOffsetDip: 0,
        projectionRevision: 1,
      };
      const awayProvider = this.createScrollProvider(false);
      this.scrollController.onScroll(awayProvider, anchor);
      // Manually set the unread count by simulating projection updates
      // that add the saved unread count
      if (savedUnreadCount > 0) {
        this.scrollController.resetNodeCount(totalNodeCount - savedUnreadCount);
        this.scrollController.onProjectionUpdate(totalNodeCount, awayProvider);
      }
    }

    this.notifyListeners();
  }

  // ─── Reader Actions ─────────────────────────────────────────────

  /**
   * Reader explicitly activates follow-latest (jump to bottom).
   * Resets unread count and scrolls to bottom.
   */
  followLatest(): void {
    if (this.disposed) return;
    const provider = this.createScrollProvider();
    this.scrollController.followBottom(provider);
    this.lastReadStableKey = null; // Fully caught up
    this.notifyListeners();
  }

  /**
   * Acknowledge that the reader has seen content up to a given stable key.
   * Used for explicit mark-read actions.
   */
  acknowledgeRead(stableKey: string): void {
    if (this.disposed) return;
    this.lastReadStableKey = stableKey;
  }

  // ─── Anchor Capture / Restore ──────────────────────────────────

  /**
   * Capture a scroll-anchor snapshot for the current viewport.
   *
   * The snapshot identifies the block whose top edge is at or just above
   * the viewport top and records its pixel offset from `scrollTop`. Returns
   * `null` when:
   *
   * - The controller is not attached to a timeline element.
   * - No `[data-stable-key]` element intersects or precedes the viewport top.
   * - The reader is currently following the bottom (bottom-follow already
   *   preserves the reader's position, so no anchor is needed).
   *
   * This method is idempotent and side-effect free — it inspects DOM
   * geometry only. Call it immediately before a reconcile pass, then pass
   * the snapshot to {@link restoreAnchor} once the pass completes.
   */
  captureAnchor(): ScrollAnchorSnapshot | null {
    if (this.disposed) return null;
    if (this.timelineElement === null) return null;
    if (this.scrollController.isBottomFollow()) return null;
    return this.findAnchorAtViewportTop();
  }

  /**
   * Restore a previously captured anchor across a reconcile pass.
   *
   * Locates the same `data-stable-key` element in the post-reconcile DOM
   * and adjusts `scrollTop` so the block returns to the same offset from
   * the viewport top. When the block is no longer present or the reader
   * is now following the bottom (an explicit reader choice), the restore
   * is a no-op — bottom-follow is a stronger signal than an anchor.
   *
   * Returns `true` when the anchor was successfully restored.
   */
  restoreAnchor(snapshot: ScrollAnchorSnapshot | null): boolean {
    if (this.disposed) return false;
    if (snapshot === null) return false;
    if (this.timelineElement === null) return false;
    if (this.scrollController.isBottomFollow()) return false;

    const target = this.findElementByStableKey(snapshot.stableKey);
    if (target === null) return false;

    // Position the anchored block at the same offset within the viewport
    // it occupied before the reconcile. Clamp negative values so we never
    // set an out-of-range scrollTop.
    const desiredScrollTop = Math.max(0, target.offsetTop - snapshot.viewportOffset);
    this.timelineElement.scrollTop = desiredScrollTop;
    return true;
  }

  // ─── Queries ────────────────────────────────────────────────────

  /**
   * Whether the reader is currently in bottom-follow mode.
   */
  isFollowingBottom(): boolean {
    return this.scrollController.isBottomFollow();
  }

  /**
   * Get the exact unread count (0 if following bottom).
   */
  getUnreadCount(): number {
    return this.scrollController.getUnreadCount();
  }

  /**
   * Get the current unread badge state for the UI.
   */
  getUnreadBadgeState(): UnreadBadgeState {
    const count = this.getUnreadCount();
    const visible = count > 0;
    const ariaLabel = count === 0
      ? ''
      : count === 1
        ? '1 new message, jump to latest'
        : `${count} new messages, jump to latest`;

    return { visible, unreadCount: count, ariaLabel };
  }

  /**
   * Get the last known read boundary stable key.
   */
  getLastReadStableKey(): string | null {
    return this.lastReadStableKey;
  }

  /**
   * Get the last known total projected node count.
   */
  getLastProjectedNodeCount(): number {
    return this.lastProjectedNodeCount;
  }

  // ─── Listeners ──────────────────────────────────────────────────

  /**
   * Subscribe to unread badge state changes.
   */
  addListener(listener: ReaderOwnershipListener): void {
    if (this.disposed) return;
    this.listeners.push(listener);
  }

  /**
   * Remove a listener.
   */
  removeListener(listener: ReaderOwnershipListener): void {
    this.listeners = this.listeners.filter(l => l !== listener);
  }

  // ─── Internal ───────────────────────────────────────────────────

  private handleScroll(): void {
    if (this.disposed || !this.timelineElement) return;

    const anchor = this.captureCurrentAnchor();
    const provider = this.createScrollProvider();
    this.scrollController.onScroll(provider, anchor);
    this.notifyListeners();
  }

  private captureCurrentAnchor(): SemanticAnchor {
    return {
      sessionId: this.scrollController.getSessionId(),
      branchId: this.scrollController.getBranchId(),
      stableKey: this.getFirstVisibleStableKey() ?? 'viewport-top',
      viewportOffsetDip: this.timelineElement?.scrollTop ?? 0,
      projectionRevision: 1,
    };
  }

  private getFirstVisibleStableKey(): string | null {
    const snapshot = this.findAnchorAtViewportTop();
    return snapshot?.stableKey ?? null;
  }

  /**
   * Locate the anchor block at the viewport top and record its pixel offset
   * relative to the current `scrollTop`.
   *
   * The anchor is chosen as the block whose top edge is at or just above
   * the viewport top (i.e., the block currently intersecting the top edge
   * of the viewport, or if the viewport starts before any block, the first
   * block below the top). This matches the "block at the top of the
   * viewport" semantic in the enhanced-chat-ui design.
   */
  private findAnchorAtViewportTop(): ScrollAnchorSnapshot | null {
    if (!this.timelineElement) return null;
    const scrollTop = this.timelineElement.scrollTop;
    const groups = this.timelineElement.querySelectorAll<HTMLElement>('[data-stable-key]');

    let candidate: HTMLElement | null = null;
    let candidateTop = -Infinity;
    let firstAfterTop: HTMLElement | null = null;
    let firstAfterTopOffset = Infinity;

    for (const group of groups) {
      const top = group.offsetTop;
      if (top <= scrollTop) {
        // Block whose top edge is at or above the viewport top. Prefer
        // the one closest to the top edge (largest offsetTop <= scrollTop).
        if (top > candidateTop) {
          candidate = group;
          candidateTop = top;
        }
      } else if (top < firstAfterTopOffset) {
        firstAfterTop = group;
        firstAfterTopOffset = top;
      }
    }

    // Prefer the block currently intersecting the viewport top. Fall back
    // to the first block below the top when the viewport starts above the
    // first tracked block (empty header space at the top of the timeline).
    const chosen = candidate ?? firstAfterTop;
    if (chosen === null) return null;
    const key = chosen.getAttribute('data-stable-key');
    if (key === null || key.length === 0) return null;
    return {
      stableKey: key,
      viewportOffset: chosen.offsetTop - scrollTop,
    };
  }

  private findElementByStableKey(stableKey: string): HTMLElement | null {
    if (!this.timelineElement) return null;
    // Escape the value for a safe attribute selector. CSS.escape may be
    // unavailable in some legacy jsdom runners, so fall back to attribute
    // selection through querySelectorAll iteration.
    const groups = this.timelineElement.querySelectorAll<HTMLElement>('[data-stable-key]');
    for (const group of groups) {
      if (group.getAttribute('data-stable-key') === stableKey) return group;
    }
    return null;
  }

  private createScrollProvider(forceAtBottom?: boolean): ScrollPositionProvider {
    const el = this.timelineElement;
    const threshold = this.config.bottomThresholdPx;

    return {
      isAtBottom(): boolean {
        if (forceAtBottom !== undefined) return forceAtBottom;
        if (!el) return true;
        const { scrollTop, scrollHeight, clientHeight } = el;
        return scrollHeight - scrollTop - clientHeight <= threshold;
      },
      scrollToBottom(): void {
        if (el) {
          el.scrollTop = el.scrollHeight - el.clientHeight;
        }
      },
      getViewportOffsetDip(): number {
        return el?.scrollTop ?? 0;
      },
    };
  }

  private scrollToBottom(): void {
    if (this.timelineElement) {
      this.timelineElement.scrollTop =
        this.timelineElement.scrollHeight - this.timelineElement.clientHeight;
    }
  }

  private notifyListeners(): void {
    const state = this.getUnreadBadgeState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
