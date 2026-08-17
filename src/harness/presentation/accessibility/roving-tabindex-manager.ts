/**
 * Roving Tabindex Manager
 *
 * Manages roving tabindex within composite widgets. Each widget has exactly one
 * active tab stop; arrow keys navigate internally while Tab moves between widgets.
 * Supports projected-order navigation independent of DOM mount state.
 *
 * Requirements: 35.10, 37.12, 46.2, 46.5, 46.14
 */

import type {
  CompositeWidgetDescriptor,
  FocusableItem,
  NavigationOrientation,
  FocusVisibilityState,
  DeterministicPageRequest,
} from './types';

/**
 * Callback for deterministic page requests at window boundaries.
 */
export interface PageBoundaryHandler {
  onPageRequest(request: DeterministicPageRequest): void;
}

/**
 * RovingTabindexManager coordinates keyboard focus within and between
 * composite ARIA widgets. It maintains:
 * - One active tab stop per widget (tabindex=0, others tabindex=-1)
 * - Arrow navigation within a widget (orientation-aware)
 * - Tab navigation between widgets
 * - Projected-order page navigation independent of DOM mount state
 * - Focus visibility state (keyboard vs pointer)
 */
export class RovingTabindexManager {
  private widgets: Map<string, CompositeWidgetDescriptor> = new Map();
  private items: Map<string, FocusableItem[]> = new Map();
  private activeItemPerWidget: Map<string, string> = new Map();
  private focusedWidgetId: string | null = null;
  private focusedItemId: string | null = null;
  private keyboardFocusActive: boolean = false;
  private pageBoundaryHandler: PageBoundaryHandler | null = null;
  private sessionId: string = '';
  private branchId: string = '';

  /**
   * Register a composite widget for roving tabindex management.
   */
  registerWidget(descriptor: CompositeWidgetDescriptor): void {
    this.widgets.set(descriptor.widgetId, descriptor);
    if (!this.items.has(descriptor.widgetId)) {
      this.items.set(descriptor.widgetId, []);
    }
  }

  /**
   * Unregister a widget and its items.
   */
  unregisterWidget(widgetId: string): void {
    this.widgets.delete(widgetId);
    this.items.delete(widgetId);
    this.activeItemPerWidget.delete(widgetId);
    if (this.focusedWidgetId === widgetId) {
      this.focusedWidgetId = null;
      this.focusedItemId = null;
    }
  }

  /**
   * Set the focusable items for a widget in projected order.
   */
  setWidgetItems(widgetId: string, items: FocusableItem[]): void {
    this.items.set(widgetId, items);

    // Preserve active item if still present, otherwise pick first focusable
    const currentActive = this.activeItemPerWidget.get(widgetId);
    const stillPresent = items.find(i => i.itemId === currentActive && i.focusable);
    if (!stillPresent) {
      const first = items.find(i => i.focusable);
      if (first) {
        this.activeItemPerWidget.set(widgetId, first.itemId);
      } else {
        this.activeItemPerWidget.delete(widgetId);
      }
    }
  }

  /**
   * Set session context for page requests.
   */
  setContext(sessionId: string, branchId: string): void {
    this.sessionId = sessionId;
    this.branchId = branchId;
  }

  /**
   * Register a page boundary handler.
   */
  setPageBoundaryHandler(handler: PageBoundaryHandler): void {
    this.pageBoundaryHandler = handler;
  }

  /**
   * Signal that focus was achieved via keyboard (show visible indicator).
   */
  setKeyboardFocusActive(active: boolean): void {
    this.keyboardFocusActive = active;
  }

  /**
   * Get current focus visibility state.
   */
  getFocusVisibility(): FocusVisibilityState {
    return {
      keyboardFocusActive: this.keyboardFocusActive,
      focusedItemId: this.focusedItemId,
      focusedWidgetId: this.focusedWidgetId,
    };
  }

  /**
   * Get the active tab stop item for a widget (tabindex=0).
   * All other items in the widget have tabindex=-1.
   */
  getActiveTabStop(widgetId: string): string | undefined {
    return this.activeItemPerWidget.get(widgetId);
  }

  /**
   * Get tabindex value for an item.
   * Returns 0 for the active tab stop, -1 for all others.
   */
  getTabIndex(widgetId: string, itemId: string): 0 | -1 {
    return this.activeItemPerWidget.get(widgetId) === itemId ? 0 : -1;
  }

  /**
   * Set focus to a specific item within a widget.
   * Updates roving tabindex state.
   */
  setFocus(widgetId: string, itemId: string): boolean {
    const widgetItems = this.items.get(widgetId);
    if (!widgetItems) return false;

    const item = widgetItems.find(i => i.itemId === itemId && i.focusable);
    if (!item) return false;

    this.activeItemPerWidget.set(widgetId, itemId);
    this.focusedWidgetId = widgetId;
    this.focusedItemId = itemId;
    this.keyboardFocusActive = true;
    return true;
  }

  /**
   * Navigate to the next item in projected order within the current widget.
   * Emits a page request if crossing a window boundary.
   * Returns the target item ID or null if at boundary (with no wrapping).
   */
  navigateNext(widgetId: string, windowEndIndex?: number): string | null {
    return this.navigateInDirection(widgetId, 'next', windowEndIndex);
  }

  /**
   * Navigate to the previous item in projected order within the current widget.
   * Emits a page request if crossing a window boundary.
   * Returns the target item ID or null if at boundary (with no wrapping).
   */
  navigatePrevious(widgetId: string, windowStartIndex?: number): string | null {
    return this.navigateInDirection(widgetId, 'previous', windowStartIndex);
  }

  /**
   * Navigate to the first focusable item in the widget.
   */
  navigateFirst(widgetId: string): string | null {
    const widgetItems = this.items.get(widgetId);
    if (!widgetItems) return null;

    const first = widgetItems.find(i => i.focusable);
    if (!first) return null;

    this.activeItemPerWidget.set(widgetId, first.itemId);
    this.focusedWidgetId = widgetId;
    this.focusedItemId = first.itemId;
    return first.itemId;
  }

  /**
   * Navigate to the last focusable item in the widget.
   */
  navigateLast(widgetId: string): string | null {
    const widgetItems = this.items.get(widgetId);
    if (!widgetItems) return null;

    for (let i = widgetItems.length - 1; i >= 0; i--) {
      if (widgetItems[i]!.focusable) {
        this.activeItemPerWidget.set(widgetId, widgetItems[i]!.itemId);
        this.focusedWidgetId = widgetId;
        this.focusedItemId = widgetItems[i]!.itemId;
        return widgetItems[i]!.itemId;
      }
    }
    return null;
  }

  /**
   * Move focus to the next widget in tab order.
   * Returns the widget ID and active item, or null if no next widget.
   */
  tabToNextWidget(): { widgetId: string; itemId: string } | null {
    const activeWidgets = this.getActiveWidgetIds();
    if (activeWidgets.length === 0) return null;

    const currentIdx = this.focusedWidgetId
      ? activeWidgets.indexOf(this.focusedWidgetId)
      : -1;

    const nextIdx = (currentIdx + 1) % activeWidgets.length;
    const nextWidgetId = activeWidgets[nextIdx]!;
    const activeItem = this.activeItemPerWidget.get(nextWidgetId);

    if (activeItem) {
      this.focusedWidgetId = nextWidgetId;
      this.focusedItemId = activeItem;
      return { widgetId: nextWidgetId, itemId: activeItem };
    }
    return null;
  }

  /**
   * Move focus to the previous widget in tab order.
   */
  tabToPreviousWidget(): { widgetId: string; itemId: string } | null {
    const activeWidgets = this.getActiveWidgetIds();
    if (activeWidgets.length === 0) return null;

    const currentIdx = this.focusedWidgetId
      ? activeWidgets.indexOf(this.focusedWidgetId)
      : 0;

    const prevIdx = (currentIdx - 1 + activeWidgets.length) % activeWidgets.length;
    const prevWidgetId = activeWidgets[prevIdx]!;
    const activeItem = this.activeItemPerWidget.get(prevWidgetId);

    if (activeItem) {
      this.focusedWidgetId = prevWidgetId;
      this.focusedItemId = activeItem;
      return { widgetId: prevWidgetId, itemId: activeItem };
    }
    return null;
  }

  /**
   * Check whether a navigation direction applies based on widget orientation.
   */
  isDirectionValid(widgetId: string, _direction: 'next' | 'previous'): boolean {
    const widget = this.widgets.get(widgetId);
    if (!widget) return false;
    // Both directions are always valid; the orientation determines which
    // physical key maps to which direction (handled by KeyboardActionDispatcher)
    return true;
  }

  /**
   * Get orientation for a widget.
   */
  getOrientation(widgetId: string): NavigationOrientation | undefined {
    return this.widgets.get(widgetId)?.orientation;
  }

  /**
   * Get all registered widget IDs that are active.
   */
  getActiveWidgetIds(): string[] {
    const result: string[] = [];
    for (const [id, desc] of this.widgets) {
      if (desc.active) {
        result.push(id);
      }
    }
    return result;
  }

  /**
   * Get the item for a given item ID within a widget.
   */
  getItem(widgetId: string, itemId: string): FocusableItem | undefined {
    return this.items.get(widgetId)?.find(i => i.itemId === itemId);
  }

  /**
   * Get all items for a widget.
   */
  getWidgetItems(widgetId: string): readonly FocusableItem[] {
    return this.items.get(widgetId) ?? [];
  }

  /**
   * Clear all focus state (e.g., when pointer click occurs).
   */
  clearKeyboardFocus(): void {
    this.keyboardFocusActive = false;
  }

  // ─── Private ────────────────────────────────────────────────────

  private navigateInDirection(
    widgetId: string,
    direction: 'next' | 'previous',
    windowBoundaryIndex?: number,
  ): string | null {
    const widgetItems = this.items.get(widgetId);
    const widget = this.widgets.get(widgetId);
    if (!widgetItems || !widget) return null;

    const currentActive = this.activeItemPerWidget.get(widgetId);
    const currentIdx = currentActive
      ? widgetItems.findIndex(i => i.itemId === currentActive)
      : -1;

    if (direction === 'next') {
      // Search forward for next focusable item
      for (let i = currentIdx + 1; i < widgetItems.length; i++) {
        if (widgetItems[i]!.focusable) {
          const item = widgetItems[i]!;
          this.activeItemPerWidget.set(widgetId, item.itemId);
          this.focusedWidgetId = widgetId;
          this.focusedItemId = item.itemId;

          // Check window boundary
          if (windowBoundaryIndex !== undefined && item.projectedIndex >= windowBoundaryIndex) {
            this.emitPageRequest('after', item.projectedIndex, item.stableKey);
          }

          return item.itemId;
        }
      }

      // At end — wrap if configured, otherwise emit page request
      if (widget.wrap && widgetItems.length > 0) {
        const first = widgetItems.find(i => i.focusable);
        if (first) {
          this.activeItemPerWidget.set(widgetId, first.itemId);
          this.focusedWidgetId = widgetId;
          this.focusedItemId = first.itemId;
          return first.itemId;
        }
      }

      // Emit page request at end boundary
      if (currentIdx >= 0) {
        this.emitPageRequest('after', widgetItems[currentIdx]!.projectedIndex);
      }
      return null;
    } else {
      // Search backward for previous focusable item
      for (let i = currentIdx - 1; i >= 0; i--) {
        if (widgetItems[i]!.focusable) {
          const item = widgetItems[i]!;
          this.activeItemPerWidget.set(widgetId, item.itemId);
          this.focusedWidgetId = widgetId;
          this.focusedItemId = item.itemId;

          // Check window boundary
          if (windowBoundaryIndex !== undefined && item.projectedIndex < windowBoundaryIndex) {
            this.emitPageRequest('before', item.projectedIndex, item.stableKey);
          }

          return item.itemId;
        }
      }

      // At start — wrap if configured, otherwise emit page request
      if (widget.wrap && widgetItems.length > 0) {
        for (let i = widgetItems.length - 1; i >= 0; i--) {
          if (widgetItems[i]!.focusable) {
            this.activeItemPerWidget.set(widgetId, widgetItems[i]!.itemId);
            this.focusedWidgetId = widgetId;
            this.focusedItemId = widgetItems[i]!.itemId;
            return widgetItems[i]!.itemId;
          }
        }
      }

      // Emit page request at start boundary
      if (currentIdx >= 0) {
        this.emitPageRequest('before', widgetItems[currentIdx]!.projectedIndex);
      }
      return null;
    }
  }

  private emitPageRequest(direction: 'before' | 'after', fromIndex: number, targetStableKey?: string): void {
    if (this.pageBoundaryHandler) {
      const request: DeterministicPageRequest = {
        direction,
        fromProjectedIndex: fromIndex,
        sessionId: this.sessionId,
        branchId: this.branchId,
      };
      if (targetStableKey !== undefined) {
        request.targetStableKey = targetStableKey;
      }
      this.pageBoundaryHandler.onPageRequest(request);
    }
  }
}
