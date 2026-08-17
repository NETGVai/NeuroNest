/**
 * Keyboard Action Dispatcher
 *
 * Maps physical keyboard events to logical keyboard actions based on the
 * active widget context, orientation, and configured bindings. Handles
 * IME composition deferral, modifier awareness, and platform-specific keys.
 *
 * Requirements: 37.12, 38.12, 39.7, 41.4, 46.2, 46.5
 */

import type {
  KeyboardAction,
  NormalizedKeyEvent,
  KeyBinding,
  SemanticWidgetRole,
  NavigationOrientation,
} from './types';

/**
 * Callback for resolved keyboard actions.
 */
export interface KeyboardActionHandler {
  onAction(action: KeyboardAction, context: KeyboardActionContext): void;
}

/**
 * Context provided alongside a resolved keyboard action.
 */
export interface KeyboardActionContext {
  /** The widget where the action occurred. */
  widgetId: string;
  /** The widget role. */
  widgetRole: SemanticWidgetRole;
  /** The item that was focused when the action occurred. */
  focusedItemId: string | null;
  /** Original key event (for custom handling). */
  originalEvent: NormalizedKeyEvent;
}

/**
 * Default keyboard bindings for the Chat_Interface.
 * These cover all required keyboard actions per the design.
 */
export const DEFAULT_KEY_BINDINGS: KeyBinding[] = [
  // Universal actions
  { action: 'activate', key: 'Enter', context: 'global', enabled: true },
  { action: 'close', key: 'Escape', context: 'global', enabled: true },
  { action: 'select', key: ' ', context: 'global', enabled: true },
  { action: 'first', key: 'Home', context: 'global', enabled: true },
  { action: 'last', key: 'End', context: 'global', enabled: true },
  { action: 'page_next', key: 'PageDown', context: 'global', enabled: true },
  { action: 'page_previous', key: 'PageUp', context: 'global', enabled: true },
  { action: 'delete', key: 'Delete', context: 'global', enabled: true },
  { action: 'delete', key: 'Backspace', context: 'global', enabled: true },

  // Tree-specific actions
  { action: 'expand', key: 'ArrowRight', context: 'tree', enabled: true },
  { action: 'collapse', key: 'ArrowLeft', context: 'tree', enabled: true },

  // Tool tree and attachment inspection
  { action: 'inspect', key: 'i', context: 'list', enabled: true },
  { action: 'inspect', key: 'i', context: 'tree', enabled: true },
  { action: 'retry', key: 'r', context: 'tree', enabled: true },
  { action: 'retry', key: 'r', context: 'list', enabled: true },

  // Queue alternate action (Requirement 39.7)
  { action: 'queue_alternate', key: 'Enter', modifiers: { shift: true }, context: 'form', enabled: true },

  // Attachment reordering (Requirement 41.4)
  { action: 'move_up', key: 'ArrowUp', modifiers: { ctrl: true }, context: 'list', enabled: true },
  { action: 'move_down', key: 'ArrowDown', modifiers: { ctrl: true }, context: 'list', enabled: true },
  { action: 'move_up', key: 'ArrowUp', modifiers: { meta: true }, context: 'list', enabled: true },
  { action: 'move_down', key: 'ArrowDown', modifiers: { meta: true }, context: 'list', enabled: true },
];

/**
 * KeyboardActionDispatcher resolves physical key events into logical
 * actions based on widget context, orientation, and configured bindings.
 *
 * Key behaviors:
 * - IME composition defers all actions (Requirement 39.8 context)
 * - Arrow keys respect widget orientation for next/previous
 * - Modifier-qualified bindings (Shift+Enter, Ctrl+Arrow) are matched first
 * - Platform-adaptive (Cmd vs Ctrl)
 */
export class KeyboardActionDispatcher {
  private bindings: KeyBinding[];
  private handlers: Map<string, KeyboardActionHandler> = new Map();
  private globalHandler: KeyboardActionHandler | null = null;

  constructor(bindings?: KeyBinding[]) {
    this.bindings = bindings ?? [...DEFAULT_KEY_BINDINGS];
  }

  /**
   * Register an action handler for a specific widget.
   */
  registerHandler(widgetId: string, handler: KeyboardActionHandler): void {
    this.handlers.set(widgetId, handler);
  }

  /**
   * Register a global fallback handler.
   */
  setGlobalHandler(handler: KeyboardActionHandler): void {
    this.globalHandler = handler;
  }

  /**
   * Unregister a widget handler.
   */
  unregisterHandler(widgetId: string): void {
    this.handlers.delete(widgetId);
  }

  /**
   * Add or override a key binding.
   */
  addBinding(binding: KeyBinding): void {
    this.bindings.push(binding);
  }

  /**
   * Remove bindings for an action in a context.
   */
  removeBindings(action: KeyboardAction, context: SemanticWidgetRole | 'global'): void {
    this.bindings = this.bindings.filter(
      b => !(b.action === action && b.context === context),
    );
  }

  /**
   * Enable or disable a specific action in a context.
   */
  setBindingEnabled(action: KeyboardAction, context: SemanticWidgetRole | 'global', enabled: boolean): void {
    for (const binding of this.bindings) {
      if (binding.action === action && binding.context === context) {
        binding.enabled = enabled;
      }
    }
  }

  /**
   * Resolve a keyboard event into a logical action.
   * Returns the resolved action or null if no binding matches.
   *
   * @param event - The normalized key event
   * @param widgetRole - The role of the widget containing the focused item
   * @param orientation - Navigation orientation of the widget
   */
  resolveAction(
    event: NormalizedKeyEvent,
    widgetRole: SemanticWidgetRole,
    orientation: NavigationOrientation,
  ): KeyboardAction | null {
    // IME composition blocks all actions
    if (event.composing) {
      return null;
    }

    // Try directional navigation first (orientation-aware)
    const directional = this.resolveDirectionalAction(event, orientation);
    if (directional) {
      return directional;
    }

    // Try context-specific bindings (most specific first)
    const contextMatch = this.findBinding(event, widgetRole);
    if (contextMatch) {
      return contextMatch;
    }

    // Try global bindings
    const globalMatch = this.findBinding(event, 'global');
    return globalMatch;
  }

  /**
   * Dispatch a resolved action to the appropriate handler.
   */
  dispatch(
    action: KeyboardAction,
    widgetId: string,
    widgetRole: SemanticWidgetRole,
    focusedItemId: string | null,
    event: NormalizedKeyEvent,
  ): boolean {
    const context: KeyboardActionContext = {
      widgetId,
      widgetRole,
      focusedItemId,
      originalEvent: event,
    };

    // Widget-specific handler first
    const widgetHandler = this.handlers.get(widgetId);
    if (widgetHandler) {
      widgetHandler.onAction(action, context);
      return true;
    }

    // Global handler fallback
    if (this.globalHandler) {
      this.globalHandler.onAction(action, context);
      return true;
    }

    return false;
  }

  /**
   * Full pipeline: resolve + dispatch. Returns true if an action was dispatched.
   */
  handleKeyEvent(
    event: NormalizedKeyEvent,
    widgetId: string,
    widgetRole: SemanticWidgetRole,
    orientation: NavigationOrientation,
    focusedItemId: string | null,
  ): boolean {
    const action = this.resolveAction(event, widgetRole, orientation);
    if (!action) return false;

    return this.dispatch(action, widgetId, widgetRole, focusedItemId, event);
  }

  /**
   * Get all active bindings for a context.
   */
  getBindingsForContext(context: SemanticWidgetRole | 'global'): readonly KeyBinding[] {
    return this.bindings.filter(b => b.context === context && b.enabled);
  }

  /**
   * Get all bindings (for inspection/testing).
   */
  getAllBindings(): readonly KeyBinding[] {
    return this.bindings;
  }

  // ─── Private ────────────────────────────────────────────────────

  private resolveDirectionalAction(
    event: NormalizedKeyEvent,
    orientation: NavigationOrientation,
  ): KeyboardAction | null {
    // Don't resolve directional if modifiers are held (those might be move actions)
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return null;
    }

    switch (orientation) {
      case 'vertical':
        if (event.key === 'ArrowDown') return 'next';
        if (event.key === 'ArrowUp') return 'previous';
        break;
      case 'horizontal':
        if (event.key === 'ArrowRight') return 'next';
        if (event.key === 'ArrowLeft') return 'previous';
        break;
      case 'both':
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') return 'next';
        if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') return 'previous';
        break;
    }

    return null;
  }

  private findBinding(event: NormalizedKeyEvent, context: SemanticWidgetRole | 'global'): KeyboardAction | null {
    // Match most-specific bindings first (with modifiers)
    const modifiedBindings = this.bindings.filter(
      b => b.context === context && b.enabled && b.modifiers !== undefined,
    );
    for (const binding of modifiedBindings) {
      if (this.matchesBinding(event, binding)) {
        return binding.action;
      }
    }

    // Then match unmodified bindings
    const plainBindings = this.bindings.filter(
      b => b.context === context && b.enabled && b.modifiers === undefined,
    );
    for (const binding of plainBindings) {
      if (this.matchesBinding(event, binding)) {
        return binding.action;
      }
    }

    return null;
  }

  private matchesBinding(event: NormalizedKeyEvent, binding: KeyBinding): boolean {
    if (event.key !== binding.key) return false;

    if (binding.modifiers) {
      if (binding.modifiers.shift && !event.shiftKey) return false;
      if (binding.modifiers.ctrl && !event.ctrlKey) return false;
      if (binding.modifiers.alt && !event.altKey) return false;
      if (binding.modifiers.meta && !event.metaKey) return false;

      // Also check that no extra modifiers are pressed for modified bindings
      if (!binding.modifiers.shift && event.shiftKey) return false;
      if (!binding.modifiers.ctrl && event.ctrlKey) return false;
      if (!binding.modifiers.alt && event.altKey) return false;
      if (!binding.modifiers.meta && event.metaKey) return false;
    } else {
      // Plain binding: no modifiers should be active
      if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;
    }

    return true;
  }
}
