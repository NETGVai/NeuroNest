/**
 * Projected Keyboard Navigator
 *
 * Keyboard navigation operates on projected order rather than mounted DOM
 * siblings. Requests pages when crossing window edges, does not depend on
 * mounted DOM siblings. Focused nodes are pinned in the windowing engine.
 *
 * Requirements: 35.10, 47.2, 47.5
 */

import type {
  ProjectedNodeDescriptor,
  PageRequest,
  PageDirection,
  WindowedRange,
} from './types';

/**
 * Callback interface for page requests triggered by keyboard navigation.
 */
export interface PageRequestHandler {
  requestPage(request: PageRequest): void;
}

/**
 * ProjectedKeyboardNavigator handles arrow-key navigation through the
 * projected timeline in canonical order, without depending on which
 * nodes are currently mounted in the DOM.
 */
export class ProjectedKeyboardNavigator {
  private nodes: ProjectedNodeDescriptor[] = [];
  private currentIndex: number = -1;
  private sessionId: string = '';
  private branchId: string = '';
  private pageRequestHandler: PageRequestHandler | null = null;

  /**
   * Set the projected nodes (in canonical order).
   */
  setProjectedNodes(nodes: ProjectedNodeDescriptor[]): void {
    this.nodes = nodes;
    // Clamp current index if the list shrank
    if (this.currentIndex >= nodes.length) {
      this.currentIndex = nodes.length - 1;
    }
  }

  /**
   * Set the session context for page requests.
   */
  setContext(sessionId: string, branchId: string): void {
    this.sessionId = sessionId;
    this.branchId = branchId;
  }

  /**
   * Register a handler for page requests (triggered at window edges).
   */
  setPageRequestHandler(handler: PageRequestHandler): void {
    this.pageRequestHandler = handler;
  }

  /**
   * Get the current focused index in projected order.
   */
  getCurrentIndex(): number {
    return this.currentIndex;
  }

  /**
   * Get the current focused node descriptor.
   */
  getCurrentNode(): ProjectedNodeDescriptor | undefined {
    if (this.currentIndex < 0 || this.currentIndex >= this.nodes.length) {
      return undefined;
    }
    return this.nodes[this.currentIndex];
  }

  /**
   * Set focus to a specific projected index.
   */
  setFocusIndex(index: number): void {
    if (index >= 0 && index < this.nodes.length) {
      this.currentIndex = index;
    }
  }

  /**
   * Set focus to a specific stable key.
   * Returns true if the key was found and focus was set.
   */
  setFocusByKey(stableKey: string): boolean {
    const index = this.nodes.findIndex(n => n.stableKey === stableKey);
    if (index !== -1) {
      this.currentIndex = index;
      return true;
    }
    return false;
  }

  /**
   * Navigate to the next focusable node in projected order.
   * Returns the target node descriptor, or null if at the end.
   * Emits a page request if crossing a window edge.
   */
  moveNext(windowedRange: WindowedRange): ProjectedNodeDescriptor | null {
    let next = this.currentIndex + 1;

    // Skip non-focusable nodes
    while (next < this.nodes.length && !this.nodes[next]!.focusable) {
      next++;
    }

    if (next >= this.nodes.length) {
      // At the end — request next page
      this.emitPageRequest('after', this.nodes.length - 1);
      return null;
    }

    this.currentIndex = next;

    // Check if we're crossing the window edge
    if (next >= windowedRange.endIndex) {
      this.emitPageRequest('after', next);
    }

    return this.nodes[next]!;
  }

  /**
   * Navigate to the previous focusable node in projected order.
   * Returns the target node descriptor, or null if at the beginning.
   * Emits a page request if crossing a window edge.
   */
  movePrevious(windowedRange: WindowedRange): ProjectedNodeDescriptor | null {
    let prev = this.currentIndex - 1;

    // Skip non-focusable nodes
    while (prev >= 0 && !this.nodes[prev]!.focusable) {
      prev--;
    }

    if (prev < 0) {
      // At the beginning — request previous page
      this.emitPageRequest('before', 0);
      return null;
    }

    this.currentIndex = prev;

    // Check if we're crossing the window edge
    if (prev < windowedRange.startIndex) {
      this.emitPageRequest('before', prev);
    }

    return this.nodes[prev]!;
  }

  /**
   * Navigate to the first focusable node.
   */
  moveToFirst(windowedRange: WindowedRange): ProjectedNodeDescriptor | null {
    for (let i = 0; i < this.nodes.length; i++) {
      if (this.nodes[i]!.focusable) {
        this.currentIndex = i;
        if (i < windowedRange.startIndex) {
          this.emitPageRequest('before', i);
        }
        return this.nodes[i]!;
      }
    }
    return null;
  }

  /**
   * Navigate to the last focusable node.
   */
  moveToLast(windowedRange: WindowedRange): ProjectedNodeDescriptor | null {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      if (this.nodes[i]!.focusable) {
        this.currentIndex = i;
        if (i >= windowedRange.endIndex) {
          this.emitPageRequest('after', i);
        }
        return this.nodes[i]!;
      }
    }
    return null;
  }

  /**
   * Check whether the currently focused node is at a window edge.
   */
  isAtWindowEdge(windowedRange: WindowedRange): { atStart: boolean; atEnd: boolean } {
    return {
      atStart: this.currentIndex <= windowedRange.startIndex,
      atEnd: this.currentIndex >= windowedRange.endIndex - 1,
    };
  }

  // ─── Private ────────────────────────────────────────────────────

  private emitPageRequest(direction: PageDirection, fromIndex: number): void {
    if (this.pageRequestHandler) {
      this.pageRequestHandler.requestPage({
        direction,
        fromIndex,
        sessionId: this.sessionId,
        branchId: this.branchId,
      });
    }
  }
}
