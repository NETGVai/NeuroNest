/**
 * Reader Scroll Controller
 *
 * Manages reader-owned bottom follow/unread behavior. Bottom follow is an
 * explicit reader-owned mode; away-from-bottom mode increments unread nodes
 * without forcing scroll. No projection or layout operation forces the reader
 * away from their chosen scroll position.
 *
 * Requirements: 35.8–35.9, 47.8
 */

import type {
  SemanticAnchor,
  ReaderScrollMode,
  ProjectedNodeDescriptor,
} from './types';

/**
 * Provides scroll position information from the viewport.
 */
export interface ScrollPositionProvider {
  /** Whether the viewport is scrolled to the bottom (within a small threshold). */
  isAtBottom(): boolean;
  /** Scroll to the bottom of the content. */
  scrollToBottom(): void;
  /** Get the current viewport offset in DIP. */
  getViewportOffsetDip(): number;
}

/**
 * ReaderScrollController tracks the reader's scroll mode and manages
 * the transition between bottom-follow and away-from-bottom modes.
 *
 * Key invariants:
 * - Bottom follow is explicitly reader-owned: only the reader can activate it.
 * - Away-from-bottom mode increments unread count without forcing scroll.
 * - No system operation (prepend, expansion, streaming) forces the reader's position.
 */
export class ReaderScrollController {
  private mode: ReaderScrollMode;
  private lastKnownNodeCount: number = 0;
  private sessionId: string;
  private branchId: string;

  constructor(sessionId: string, branchId: string, initialMode?: ReaderScrollMode) {
    this.sessionId = sessionId;
    this.branchId = branchId;
    this.mode = initialMode ?? { mode: 'bottom_follow' };
  }

  /**
   * Get the current reader scroll mode.
   */
  getMode(): ReaderScrollMode {
    return this.mode;
  }

  /**
   * Check if the reader is in bottom-follow mode.
   */
  isBottomFollow(): boolean {
    return this.mode.mode === 'bottom_follow';
  }

  /**
   * Get the unread count (0 if in bottom-follow mode).
   */
  getUnreadCount(): number {
    if (this.mode.mode === 'away_from_bottom') {
      return this.mode.unreadCount;
    }
    return 0;
  }

  /**
   * Called when the reader scrolls. Detects transitions between
   * bottom-follow and away-from-bottom modes.
   */
  onScroll(scrollProvider: ScrollPositionProvider, anchor: SemanticAnchor): void {
    if (scrollProvider.isAtBottom()) {
      // Reader scrolled to bottom — activate bottom follow
      this.mode = { mode: 'bottom_follow' };
    } else if (this.mode.mode === 'bottom_follow') {
      // Reader scrolled away from bottom — enter away-from-bottom mode
      this.mode = {
        mode: 'away_from_bottom',
        unreadCount: 0,
        savedAnchor: anchor,
      };
    } else {
      // Already in away-from-bottom mode — update the anchor
      this.mode = {
        ...this.mode,
        savedAnchor: anchor,
      };
    }
  }

  /**
   * Called when new projected nodes arrive. If in away-from-bottom mode,
   * increments the unread count for newly appended nodes. If in bottom-follow
   * mode, requests scroll to bottom.
   *
   * Returns true if the caller should scroll to bottom.
   */
  onProjectionUpdate(
    newNodeCount: number,
    scrollProvider: ScrollPositionProvider,
  ): boolean {
    const addedCount = Math.max(0, newNodeCount - this.lastKnownNodeCount);
    this.lastKnownNodeCount = newNodeCount;

    if (addedCount === 0) {
      return false;
    }

    if (this.mode.mode === 'bottom_follow') {
      // Keep following bottom — caller should scroll
      scrollProvider.scrollToBottom();
      return true;
    }

    // Away from bottom: increment unread without forcing scroll
    this.mode = {
      ...this.mode,
      unreadCount: this.mode.unreadCount + addedCount,
    };
    return false;
  }

  /**
   * Explicitly activate bottom-follow mode (reader choice).
   * Resets unread count and scrolls to bottom.
   */
  followBottom(scrollProvider: ScrollPositionProvider): void {
    this.mode = { mode: 'bottom_follow' };
    this.lastKnownNodeCount = this.lastKnownNodeCount; // Preserve known count
    scrollProvider.scrollToBottom();
  }

  /**
   * Get the saved anchor from away-from-bottom mode (for session persistence).
   */
  getSavedAnchor(): SemanticAnchor | null {
    if (this.mode.mode === 'away_from_bottom') {
      return this.mode.savedAnchor;
    }
    return null;
  }

  /**
   * Reset the node count tracker (e.g., when session changes).
   */
  resetNodeCount(count: number): void {
    this.lastKnownNodeCount = count;
  }

  /**
   * Get the session context.
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get the branch context.
   */
  getBranchId(): string {
    return this.branchId;
  }
}
