/**
 * Accessibility Types — Semantic ARIA widget roles, keyboard navigation,
 * roving tabindex, focus retention, modal trapping, and status announcements.
 *
 * Requirements: 35.10, 37.12, 38.12, 39.7, 41.4, 46.1–46.5, 46.9–46.10, 46.14–46.15
 */

// ─── Widget Roles ───────────────────────────────────────────────

/**
 * Semantic ARIA roles used by the Chat_Interface composite widgets.
 *
 * - list/listitem: Canonical_Timeline nodes, Queue_Dock entries
 * - tree/treeitem: Tool-call lineage
 * - toolbar: Action groups (message actions, composer controls)
 * - form: Composer_Workbench, Collaboration takeovers
 * - dialog: Inspectors, lightboxes, approval modals
 * - status: Turn-state announcements, streaming notifications
 */
export type SemanticWidgetRole =
  | 'list'
  | 'listitem'
  | 'tree'
  | 'treeitem'
  | 'toolbar'
  | 'form'
  | 'dialog'
  | 'status'
  | 'group'
  | 'region';

/**
 * Orientation for navigation within composite widgets.
 */
export type NavigationOrientation = 'horizontal' | 'vertical' | 'both';

// ─── Widget Descriptor ──────────────────────────────────────────

/**
 * Describes a composite widget for the roving tabindex and keyboard
 * navigation system. Each widget has one active tab stop; internal
 * navigation uses arrow keys.
 */
export interface CompositeWidgetDescriptor {
  /** Unique widget identifier within the interface. */
  widgetId: string;
  /** Semantic ARIA role of the widget container. */
  role: SemanticWidgetRole;
  /** Navigation orientation (determines which arrows navigate). */
  orientation: NavigationOrientation;
  /** Whether the widget wraps at boundaries (first ↔ last). */
  wrap: boolean;
  /** Accessible label for the widget. */
  label: string;
  /** Optional description for the widget. */
  description?: string;
  /** Whether the widget is currently active (mounted and focusable). */
  active: boolean;
}

// ─── Focusable Item ─────────────────────────────────────────────

/**
 * A single focusable item within a composite widget.
 * Items participate in roving tabindex and projected-order navigation.
 */
export interface FocusableItem {
  /** Unique item identifier within the widget. */
  itemId: string;
  /** Stable key for correlation with projected nodes (if applicable). */
  stableKey?: string;
  /** Whether this item is currently focusable (visible, enabled). */
  focusable: boolean;
  /** Whether this item is the active tab stop in its widget. */
  activeTabStop: boolean;
  /** Projected order index for page navigation. */
  projectedIndex: number;
  /** Accessible label for the item. */
  label: string;
  /** Current ARIA expanded state (for tree items). */
  expanded?: boolean;
  /** Current ARIA selected state. */
  selected?: boolean;
  /** Additional ARIA attributes. */
  ariaAttributes?: Record<string, string | boolean | number>;
}

// ─── Focus Restoration Target ───────────────────────────────────

/**
 * Describes where focus should be restored when a modal/overlay closes.
 * Follows a deterministic fallback chain:
 * 1. Original invoking control
 * 2. Nearest surviving logical control in the same workflow
 * 3. Primary composer input (final fallback)
 */
export interface FocusRestorationTarget {
  /** The original control that invoked the surface. */
  invokingControlId: string;
  /** Widget containing the invoking control. */
  invokingWidgetId: string;
  /** Stable key of the invoking node (for windowed content). */
  invokingStableKey?: string;
  /** Workflow identifier for finding nearest surviving control. */
  workflowId?: string;
}

/**
 * Result of focus restoration attempt.
 */
export type FocusRestorationResult =
  | { restored: true; targetId: string; method: 'invoking_control' | 'nearest_surviving' | 'primary_composer' }
  | { restored: false; reason: string };

// ─── Keyboard Actions ───────────────────────────────────────────

/**
 * Standard keyboard actions that the Chat_Interface supports.
 */
export type KeyboardAction =
  | 'activate'         // Enter: activate selected item
  | 'close'            // Escape: close modal/overlay/disclosure
  | 'expand'           // ArrowRight on treeitem: expand
  | 'collapse'         // ArrowLeft on treeitem: collapse
  | 'next'             // ArrowDown/ArrowRight: next item (orientation-dependent)
  | 'previous'         // ArrowUp/ArrowLeft: previous item (orientation-dependent)
  | 'first'            // Home: first item
  | 'last'             // End: last item
  | 'select'           // Space: toggle selection
  | 'page_next'        // PageDown: next page
  | 'page_previous'    // PageUp: previous page
  | 'delete'           // Delete/Backspace: remove selected item
  | 'retry'            // r key: retry failed action
  | 'inspect'          // i key: open inspector
  | 'queue_alternate'  // Shift+Enter or configured shortcut for alternate queue/steer
  | 'move_up'          // Ctrl/Cmd+ArrowUp: reorder item up
  | 'move_down';       // Ctrl/Cmd+ArrowDown: reorder item down

/**
 * A keyboard event normalized for cross-platform handling.
 */
export interface NormalizedKeyEvent {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** Whether an IME composition is active (defer all actions). */
  composing: boolean;
}

/**
 * Keyboard action binding configuration.
 */
export interface KeyBinding {
  action: KeyboardAction;
  key: string;
  modifiers?: {
    shift?: boolean;
    ctrl?: boolean;
    alt?: boolean;
    meta?: boolean;
  };
  /** Context where this binding applies. */
  context: SemanticWidgetRole | 'global';
  /** Whether the binding is currently active. */
  enabled: boolean;
}

// ─── Focus Visibility ───────────────────────────────────────────

/**
 * Focus visibility state meeting WCAG focus-visible requirements.
 * The visible focus indicator is shown only for keyboard navigation,
 * not pointer interactions.
 */
export interface FocusVisibilityState {
  /** Whether keyboard-initiated focus is active (show indicator). */
  keyboardFocusActive: boolean;
  /** The currently focused item ID. */
  focusedItemId: string | null;
  /** The widget containing the focused item. */
  focusedWidgetId: string | null;
}

// ─── Page Navigation ────────────────────────────────────────────

/**
 * Deterministic page request emitted when keyboard navigation crosses
 * a window boundary. The windowing engine uses this to load more content.
 */
export interface DeterministicPageRequest {
  /** Direction of the page request. */
  direction: 'before' | 'after';
  /** Projected index that triggered the boundary crossing. */
  fromProjectedIndex: number;
  /** Session context. */
  sessionId: string;
  /** Branch context. */
  branchId: string;
  /** The stable key of the item that should receive focus after paging. */
  targetStableKey?: string;
}

// ─── Status Announcement ────────────────────────────────────────

/**
 * A status announcement for the polite live region.
 */
export interface StatusAnnouncement {
  /** Localized message text. */
  message: string;
  /** Politeness level (always 'polite' per design). */
  politeness: 'polite' | 'assertive';
  /** Source of the announcement. */
  source: string;
  /** Timestamp. */
  timestamp: number;
}

// ─── Modal Configuration ────────────────────────────────────────

/**
 * Configuration for a modal focus trap (dialog/lightbox).
 */
export interface ModalTrapConfig {
  /** Unique modal identity. */
  modalId: string;
  /** Whether Escape is permitted to close (policy-dependent). */
  escapeCloses: boolean;
  /** Restoration target when the modal closes. */
  restoreTarget: FocusRestorationTarget;
  /** ARIA role (dialog or alertdialog). */
  role: 'dialog' | 'alertdialog';
  /** Accessible label. */
  label: string;
  /** Optional description. */
  description?: string;
}
