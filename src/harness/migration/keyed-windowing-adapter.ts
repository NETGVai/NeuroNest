/**
 * Keyed Windowing Adapter
 *
 * Replaces DOM-observer timeline behavior (MutationObserver for action bars,
 * IntersectionObserver for scroll counting, DOM-sibling-based paging) with
 * the stable-key windowing lifecycle and Semantic_Anchor control. Preserves
 * legacy feature parity while routing all behavior through projected order.
 *
 * Key behaviors migrated:
 * 1. Actions, paging, and unread counting use projected order (not DOM)
 * 2. Keyed row identity prevents remount of unchanged nodes, preserves disclosure/focus
 * 3. Keyboard navigation operates on projected order, requests pages at window edges
 * 4. Semantic_Anchor records first visible focusable node + offset, restores within 2 DIP
 * 5. Unread counting based on projected order (not DOM position)
 * 6. Bottom-follow is reader-owned; away-from-bottom increments unread without forcing scroll
 * 7. Focus retention: focused node pinned until focus moves
 * 8. Paging based on projected cursor, not DOM intersection observers
 *
 * Once parity is confirmed (task 11.7), legacy DOM observer code is removed.
 *
 * Requirements: 35.4, 35.7–35.10, 35.18, 35.22–35.23, 47.2–47.8
 */

import type { ChatNodeV1 } from '../contracts/chat-node.js';
import {
  WindowedTimelineEngine,
  SemanticAnchorController,
  ReaderScrollController,
  ProjectedKeyboardNavigator,
  type WindowingBounds,
  type ProjectedNodeDescriptor,
  type WindowedRange,
  type SemanticAnchor,
  type PageRequest,
  type PageDirection,
  type ReaderScrollMode,
  type AnchorResolutionResult,
  type ViewportMeasurement,
  type ScrollPositionProvider,
  type PageRequestHandler,
} from '../presentation/windowing/index.js';

// ─── Configuration ──────────────────────────────────────────────

/**
 * Configuration sourced from Settings_Service. All values are positive
 * finite as validated by the operational-bounds contract.
 */
export interface KeyedWindowingAdapterConfig {
  /** Windowing engine bounds from Settings_Service. */
  bounds: WindowingBounds;
  /** Session and branch context for anchor persistence. */
  sessionId: string;
  branchId: string;
  /** Initial projection revision (from Projection_Service). */
  projectionRevision: number;
  /** Callback to request a page of data. */
  onPageRequest: (request: PageRequest) => void;
  /** Callback when unread count changes. */
  onUnreadCountChange?: (count: number) => void;
  /** Callback when mode transitions. */
  onModeChange?: (mode: ReaderScrollMode) => void;
  /** Callback when the windowed range changes (for re-render). */
  onWindowChange?: (range: WindowedRange) => void;
  /** Callback when anchor becomes unavailable. */
  onAnchorUnavailable?: (reason: string) => void;
}

// ─── Legacy Compatibility Types ─────────────────────────────────

/**
 * Minimal interface for a legacy timeline node. The adapter maps these
 * to ProjectedNodeDescriptors using stable keys from the projection.
 */
export interface LegacyTimelineNode {
  id: string;
  element?: unknown;
  isExpanded?: boolean;
  isActionBarAttached?: boolean;
}

/**
 * Describes which legacy DOM behaviors are replaced by this adapter.
 * Used by parity diagnostics to verify feature coverage.
 */
export interface ReplacedBehavior {
  name: string;
  legacy: string;
  replacement: string;
}

// ─── Adapter State ──────────────────────────────────────────────

/**
 * Tracks the disclosure and focus state for a keyed row, preserved
 * across windowing updates (requirement 35.4, 35.18).
 */
export interface KeyedRowState {
  stableKey: string;
  disclosed: boolean;
  focused: boolean;
  /** Last known content revision to detect actual changes. */
  contentRevision: number;
}

// ─── Main Adapter ───────────────────────────────────────────────

/**
 * KeyedWindowingAdapter bridges the legacy DOM-observer timeline behavior
 * to the new keyed windowing engine. It:
 *
 * - Accepts ChatNode projections and converts them to windowed descriptors
 * - Manages the windowed range without DOM MutationObserver
 * - Tracks unread count from projected order without IntersectionObserver
 * - Preserves scroll position via SemanticAnchor instead of DOM offsets
 * - Routes keyboard navigation through projected order, not DOM siblings
 * - Pins focused nodes in the window until focus moves
 * - Emits page requests based on projected cursor position
 *
 * All legacy behavior (action bars, scroll counting, paging) is preserved
 * through the new mechanisms.
 */
export class KeyedWindowingAdapter {
  private readonly config: KeyedWindowingAdapterConfig;
  private readonly engine: WindowedTimelineEngine;
  private readonly anchorController: SemanticAnchorController;
  private readonly scrollController: ReaderScrollController;
  private readonly keyboardNavigator: ProjectedKeyboardNavigator;

  /** Preserved per-key disclosure/focus state across windowing updates. */
  private rowStates: Map<string, KeyedRowState> = new Map();

  /** The current projected nodes derived from ChatNodes. */
  private currentNodes: ProjectedNodeDescriptor[] = [];

  /** Track which nodes have been "seen" (mounted + visible). */
  private seenKeys: Set<string> = new Set();

  /** Whether a layout change is in progress (anchor should be restored after). */
  private layoutChangeInProgress: boolean = false;

  constructor(config: KeyedWindowingAdapterConfig) {
    this.config = config;

    // Initialize the windowing engine
    this.engine = new WindowedTimelineEngine(config.bounds);

    // Initialize the semantic anchor controller
    this.anchorController = new SemanticAnchorController(config.bounds);
    this.anchorController.setContext(
      config.sessionId,
      config.branchId,
      config.projectionRevision,
    );

    // Initialize the reader scroll controller
    this.scrollController = new ReaderScrollController(
      config.sessionId,
      config.branchId,
    );

    // Initialize the keyboard navigator
    this.keyboardNavigator = new ProjectedKeyboardNavigator();
    this.keyboardNavigator.setContext(config.sessionId, config.branchId);
    this.keyboardNavigator.setPageRequestHandler({
      requestPage: (request: PageRequest) => {
        config.onPageRequest(request);
      },
    });
  }

  // ─── Projection Updates ─────────────────────────────────────────

  /**
   * Accept a new set of ChatNodes from the Projection_Service.
   * Converts them to windowed descriptors, preserves keyed row state,
   * and computes the new windowed range.
   *
   * This replaces the legacy MutationObserver that watched for added/removed
   * DOM nodes and triggered action bar attachment and scroll counting.
   */
  updateProjection(
    nodes: ChatNodeV1[],
    projectionRevision: number,
    viewport?: ViewportMeasurement,
  ): WindowedRange {
    // Record anchor before layout change if viewport is available
    if (viewport && !this.layoutChangeInProgress) {
      this.layoutChangeInProgress = true;
      this.anchorController.recordAnchor(viewport);
    }

    // Update projection revision
    this.anchorController.setContext(
      this.config.sessionId,
      this.config.branchId,
      projectionRevision,
    );

    // Convert ChatNodes to ProjectedNodeDescriptors, preserving keyed state
    const descriptors = this.mapNodesToDescriptors(nodes);
    this.currentNodes = descriptors;

    // Update all subsystems with new projected nodes
    this.engine.setProjectedNodes(descriptors);
    this.anchorController.setProjectedNodes(descriptors);
    this.keyboardNavigator.setProjectedNodes(descriptors);

    // Compute the windowed range
    const range = this.engine.computeWindowedRange();

    // Update unread counting from projected order
    const scrollProvider = this.getScrollProviderStub();
    if (scrollProvider) {
      const shouldScroll = this.scrollController.onProjectionUpdate(
        descriptors.length,
        scrollProvider,
      );
      if (!shouldScroll) {
        this.config.onUnreadCountChange?.(this.scrollController.getUnreadCount());
      }
    } else {
      // No scroll provider yet — just track node count
      this.scrollController.resetNodeCount(descriptors.length);
    }

    // Notify listener of window change
    this.config.onWindowChange?.(range);

    return range;
  }

  /**
   * Called after layout stabilization completes. Restores the semantic
   * anchor within 2 DIP tolerance.
   *
   * This replaces the legacy approach of using scroll position offsets
   * stored as raw pixel values relative to DOM elements.
   */
  onLayoutStabilized(viewport: ViewportMeasurement): AnchorResolutionResult {
    this.layoutChangeInProgress = false;
    const result = this.anchorController.restoreAnchor(viewport);

    if (!result.resolved) {
      this.config.onAnchorUnavailable?.(
        this.anchorController.getUnavailableState()?.reason ?? 'unknown',
      );
    }

    return result;
  }

  // ─── Keyboard Navigation ────────────────────────────────────────

  /**
   * Navigate to the next focusable node in projected order.
   * Requests a page if crossing window edges.
   *
   * This replaces DOM-sibling-based Tab/Arrow navigation that depended
   * on which elements were currently mounted in the DOM.
   */
  navigateNext(): ProjectedNodeDescriptor | null {
    const range = this.engine.computeWindowedRange();
    const target = this.keyboardNavigator.moveNext(range);

    if (target) {
      this.updateFocusState(target.stableKey);
    }

    return target;
  }

  /**
   * Navigate to the previous focusable node in projected order.
   * Requests a page if crossing window edges.
   */
  navigatePrevious(): ProjectedNodeDescriptor | null {
    const range = this.engine.computeWindowedRange();
    const target = this.keyboardNavigator.movePrevious(range);

    if (target) {
      this.updateFocusState(target.stableKey);
    }

    return target;
  }

  /**
   * Navigate to the first focusable node in projected order.
   */
  navigateFirst(): ProjectedNodeDescriptor | null {
    const range = this.engine.computeWindowedRange();
    const target = this.keyboardNavigator.moveToFirst(range);

    if (target) {
      this.updateFocusState(target.stableKey);
    }

    return target;
  }

  /**
   * Navigate to the last focusable node in projected order.
   */
  navigateLast(): ProjectedNodeDescriptor | null {
    const range = this.engine.computeWindowedRange();
    const target = this.keyboardNavigator.moveToLast(range);

    if (target) {
      this.updateFocusState(target.stableKey);
    }

    return target;
  }

  /**
   * Set focus to a specific stable key (e.g., from a click or restored focus).
   */
  setFocus(stableKey: string): boolean {
    const result = this.keyboardNavigator.setFocusByKey(stableKey);
    if (result) {
      this.updateFocusState(stableKey);
    }
    return result;
  }

  // ─── Scroll and Reader Mode ─────────────────────────────────────

  /**
   * Called on user scroll events. Detects bottom-follow transitions.
   *
   * This replaces the IntersectionObserver that watched the last message
   * element to detect "near bottom" state.
   */
  onScroll(scrollProvider: ScrollPositionProvider, viewport: ViewportMeasurement): void {
    // Build a semantic anchor from the current viewport
    const anchorData = viewport.getFirstVisibleFocusableNode();
    if (anchorData) {
      const anchor: SemanticAnchor = {
        sessionId: this.config.sessionId,
        branchId: this.config.branchId,
        stableKey: anchorData.stableKey,
        viewportOffsetDip: anchorData.viewportOffsetDip,
        projectionRevision: this.anchorController.getCurrentAnchor()?.projectionRevision
          ?? this.config.projectionRevision,
      };
      this.scrollController.onScroll(scrollProvider, anchor);
    } else {
      // Fallback: create a minimal anchor for the scroll state
      const currentAnchor = this.anchorController.getCurrentAnchor();
      if (currentAnchor) {
        this.scrollController.onScroll(scrollProvider, currentAnchor);
      }
    }

    // Update viewport center for windowing based on scroll position
    this.updateViewportCenterFromScroll(viewport);

    // Notify mode change
    this.config.onModeChange?.(this.scrollController.getMode());
  }

  /**
   * Explicitly activate bottom-follow mode (reader choice).
   *
   * This replaces the legacy "jump to bottom" button that called
   * chatArea.scrollTop = chatArea.scrollHeight.
   */
  followBottom(scrollProvider: ScrollPositionProvider): void {
    this.scrollController.followBottom(scrollProvider);
    this.config.onModeChange?.(this.scrollController.getMode());
    this.config.onUnreadCountChange?.(0);
  }

  /**
   * Get the current reader scroll mode.
   */
  getReaderMode(): ReaderScrollMode {
    return this.scrollController.getMode();
  }

  /**
   * Get the current unread count.
   */
  getUnreadCount(): number {
    return this.scrollController.getUnreadCount();
  }

  // ─── Paging ─────────────────────────────────────────────────────

  /**
   * Request a page of older content (prepend).
   * Uses projected cursor position, not DOM intersection observers.
   *
   * This replaces the IntersectionObserver on a sentinel element at the
   * top of the chat area that triggered loading older messages.
   */
  requestPageBefore(): void {
    this.config.onPageRequest({
      direction: 'before',
      fromIndex: this.engine.computeWindowedRange().startIndex,
      sessionId: this.config.sessionId,
      branchId: this.config.branchId,
    });
  }

  /**
   * Request a page of newer content (append).
   * Uses projected cursor position, not DOM intersection observers.
   */
  requestPageAfter(): void {
    const range = this.engine.computeWindowedRange();
    this.config.onPageRequest({
      direction: 'after',
      fromIndex: range.endIndex - 1,
      sessionId: this.config.sessionId,
      branchId: this.config.branchId,
    });
  }

  // ─── Session Lifecycle ──────────────────────────────────────────

  /**
   * Save the current anchor for session persistence.
   * Called when the session is backgrounded or closed.
   */
  saveSessionAnchor(): SemanticAnchor | null {
    this.anchorController.saveAnchor();
    return this.anchorController.getSavedAnchor();
  }

  /**
   * Restore a previously saved anchor on session reopen.
   * Falls back to bottom-follow if unavailable (requirement 35.9).
   */
  restoreSessionAnchor(
    savedAnchor: SemanticAnchor | null,
    viewport: ViewportMeasurement,
  ): AnchorResolutionResult {
    if (!savedAnchor) {
      // No saved anchor — follow bottom (requirement 35.9)
      return { resolved: false, reason: 'key_not_found', followLatest: true };
    }

    this.anchorController.setSavedAnchor(savedAnchor);
    return this.anchorController.restoreSavedAnchor(viewport);
  }

  // ─── Query Methods ──────────────────────────────────────────────

  /**
   * Get the current windowed range (which nodes should be mounted).
   */
  getWindowedRange(): WindowedRange {
    return this.engine.computeWindowedRange();
  }

  /**
   * Check if a node at a given index should be mounted.
   */
  isMounted(index: number): boolean {
    return this.engine.isMounted(index);
  }

  /**
   * Get the total number of projected nodes.
   */
  getTotalNodeCount(): number {
    return this.currentNodes.length;
  }

  /**
   * Get the keyed row state for a node (disclosure, focus).
   * Returns undefined if no state is tracked for this key.
   */
  getRowState(stableKey: string): KeyedRowState | undefined {
    return this.rowStates.get(stableKey);
  }

  /**
   * Set disclosure state for a keyed row.
   * This state is preserved across windowing updates (requirement 35.18).
   */
  setDisclosed(stableKey: string, disclosed: boolean): void {
    const existing = this.rowStates.get(stableKey);
    if (existing) {
      existing.disclosed = disclosed;
    } else {
      this.rowStates.set(stableKey, {
        stableKey,
        disclosed,
        focused: false,
        contentRevision: 0,
      });
    }
  }

  /**
   * Get the list of replaced behaviors for parity diagnostics.
   */
  getReplacedBehaviors(): ReplacedBehavior[] {
    return REPLACED_BEHAVIORS;
  }

  /**
   * Get the current windowing bounds.
   */
  getBounds(): WindowingBounds {
    return this.engine.getBounds();
  }

  /**
   * Update windowing bounds from Settings_Service revision.
   */
  setBounds(bounds: WindowingBounds): void {
    this.engine.setBounds(bounds);
    this.anchorController.setBounds(bounds);
  }

  /**
   * Verify the mount bound invariant (never exceeds configured maximum).
   */
  verifyBoundInvariant(): boolean {
    return this.engine.verifyBoundInvariant();
  }

  // ─── Private ────────────────────────────────────────────────────

  /**
   * Map ChatNodes to ProjectedNodeDescriptors, preserving existing
   * disclosure and focus state for unchanged keys.
   */
  private mapNodesToDescriptors(nodes: ChatNodeV1[]): ProjectedNodeDescriptor[] {
    return nodes.map((node, index) => {
      const stableKey = node.stableKey;
      const existingState = this.rowStates.get(stableKey);

      // Update or create row state
      if (existingState) {
        existingState.contentRevision = node.contentRevision;
      } else {
        this.rowStates.set(stableKey, {
          stableKey,
          disclosed: false,
          focused: false,
          contentRevision: node.contentRevision,
        });
      }

      const rowState = this.rowStates.get(stableKey)!;

      return {
        stableKey,
        projectedIndex: index,
        focused: rowState.focused,
        focusable: this.isNodeFocusable(node),
        measuredHeightDip: undefined, // Will be set after DOM measurement
      };
    });
  }

  /**
   * Determine if a ChatNode is focusable for keyboard navigation.
   * Messages, tool calls, and interactive elements are focusable.
   */
  private isNodeFocusable(node: ChatNodeV1): boolean {
    // All standard node kinds are focusable except compaction markers
    const nonFocusableKinds = new Set([
      'compaction',
      'context_injection',
    ]);
    return !nonFocusableKinds.has(node.nodeKind);
  }

  /**
   * Update focus state: clear previous focus, set new focus, and
   * update the windowing engine (to keep focused node pinned).
   */
  private updateFocusState(newFocusKey: string): void {
    // Clear all previous focus
    for (const [key, state] of this.rowStates) {
      if (state.focused && key !== newFocusKey) {
        state.focused = false;
      }
    }

    // Set new focus
    const state = this.rowStates.get(newFocusKey);
    if (state) {
      state.focused = true;
    }

    // Update the descriptors in the engine to reflect focus change
    const updatedNodes = this.currentNodes.map(n => ({
      ...n,
      focused: n.stableKey === newFocusKey,
    }));
    this.currentNodes = updatedNodes;
    this.engine.setProjectedNodes(updatedNodes);
  }

  /**
   * Update the viewport center index based on current scroll position.
   * Used to drive the windowed range computation.
   */
  private updateViewportCenterFromScroll(viewport: ViewportMeasurement): void {
    const firstVisible = viewport.getFirstVisibleFocusableNode();
    if (firstVisible) {
      const index = this.currentNodes.findIndex(n => n.stableKey === firstVisible.stableKey);
      if (index >= 0) {
        this.engine.setViewportCenter(index);
      }
    }
  }

  /**
   * Create a stub scroll provider that delegates to the scroll controller's
   * current mode. Used during projection updates when no DOM reference is
   * available.
   */
  private getScrollProviderStub(): ScrollPositionProvider | null {
    // Return a minimal provider that reflects current mode
    if (this.scrollController.isBottomFollow()) {
      return {
        isAtBottom: () => true,
        scrollToBottom: () => { /* no-op in projection update */ },
        getViewportOffsetDip: () => 0,
      };
    }
    return {
      isAtBottom: () => false,
      scrollToBottom: () => { /* no-op in projection update */ },
      getViewportOffsetDip: () => 0,
    };
  }
}

// ─── Replaced Behaviors Catalog ─────────────────────────────────

/**
 * Documents which legacy DOM-observer behaviors are replaced by this
 * adapter. Used by parity diagnostics and the retirement gate (task 11.7).
 */
const REPLACED_BEHAVIORS: ReplacedBehavior[] = [
  {
    name: 'action_bar_attachment',
    legacy: 'MutationObserver watching for added child nodes to attach action bars',
    replacement: 'Keyed row lifecycle: action bars are part of the typed row component, mounted/unmounted with the node',
  },
  {
    name: 'scroll_counting',
    legacy: 'IntersectionObserver on last message element for near-bottom detection',
    replacement: 'ReaderScrollController.onProjectionUpdate tracking projected node count',
  },
  {
    name: 'unread_badge',
    legacy: 'MutationObserver counting added message elements while scrolled up',
    replacement: 'ReaderScrollController.getUnreadCount from projected order delta',
  },
  {
    name: 'paging_trigger',
    legacy: 'IntersectionObserver on sentinel element at top of chat area',
    replacement: 'ProjectedKeyboardNavigator page requests at window edges + explicit requestPageBefore',
  },
  {
    name: 'focus_retention',
    legacy: 'DOM focus lost on element removal during scroll-based virtualization',
    replacement: 'WindowedTimelineEngine pins focused nodes via focusRetentionAllowance',
  },
  {
    name: 'scroll_position_preservation',
    legacy: 'Raw scrollTop/scrollHeight arithmetic on DOM prepend',
    replacement: 'SemanticAnchorController records/restores stable key + DIP offset within 2 DIP',
  },
  {
    name: 'keyboard_navigation',
    legacy: 'Tab/Arrow keys traversing mounted DOM siblings only',
    replacement: 'ProjectedKeyboardNavigator operates on full projected order, independent of mount state',
  },
  {
    name: 'bottom_follow',
    legacy: 'scrollTop comparison with BOTTOM_THRESHOLD constant',
    replacement: 'ReaderScrollController.isBottomFollow as reader-owned mode',
  },
];
