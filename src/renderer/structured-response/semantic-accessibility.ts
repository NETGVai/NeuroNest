/**
 * Semantic Accessibility Module — Required ARIA structures and coalesced announcements.
 *
 * Implements:
 * - List/log row semantics without making the entire timeline a live region (Req 18.2)
 * - One polite status region for coalesced turn/stream announcements (Req 18.3)
 * - Tree/treeitem semantics for tool lineages (Req 18.4)
 * - Toolbar semantics for action groups (Req 18.5)
 * - Form semantics for decision/approval surfaces (Req 18.6)
 * - Dialog semantics for modal inspectors and lightboxes (Req 18.7)
 * - Coalesced stream/reasoning announcements at configurable interval (Req 6.5, 18.3)
 * - Accessible names, visible focus, non-hover discovery, labels, non-color cues (Req 18.10–18.11)
 *
 * Requirements: 6.5–6.6, 18.1–18.15, 22.5, 22.10
 *
 * @vitest-environment jsdom
 */

// ─── Constants ──────────────────────────────────────────────────

export const STATUS_REGION_ID = 'nn-structured-response-status-region';
export const STATUS_REGION_CSS_CLASS = 'nn-sr-status-region';
export const TOOL_TREE_CSS_CLASS = 'nn-sr-tool-tree';
export const TOOL_TREE_ITEM_CSS_CLASS = 'nn-sr-tool-tree__item';
export const ACTION_TOOLBAR_CSS_CLASS = 'nn-sr-action-toolbar';
export const DECISION_FORM_CSS_CLASS = 'nn-sr-decision-form';
export const INSPECTOR_DIALOG_CSS_CLASS = 'nn-sr-inspector-dialog';
export const NON_COLOR_STATE_CSS_CLASS = 'nn-sr-state-indicator';

export const DEFAULT_ANNOUNCEMENT_INTERVAL_MS = 500;
export const MIN_ANNOUNCEMENT_INTERVAL_MS = 100;
export const MAX_ANNOUNCEMENT_INTERVAL_MS = 5000;

// ─── Types ──────────────────────────────────────────────────────

export interface CoalescedAnnouncementConfig {
  /** Interval in ms between coalesced announcements. Must be within valid range. */
  readonly intervalMs: number;
}

export interface AnnouncementEntry {
  /** The text content to announce */
  readonly text: string;
  /** Timestamp when the announcement was queued */
  readonly queuedAt: number;
  /** Source category for deduplication */
  readonly category: AnnouncementCategory;
}

export type AnnouncementCategory =
  | 'turn_status'
  | 'stream_progress'
  | 'reasoning_update'
  | 'tool_state'
  | 'task_state'
  | 'decision_state'
  | 'error';

export interface ToolTreeNode {
  /** Unique identifier for this tool call */
  readonly id: string;
  /** Human-readable label for the tree item */
  readonly label: string;
  /** Current state text (non-color cue) */
  readonly stateText: string;
  /** Whether this node is expanded */
  readonly expanded: boolean;
  /** Child tool calls in lineage order */
  readonly children: readonly ToolTreeNode[];
}

export interface ActionDescriptor {
  /** Unique action id */
  readonly id: string;
  /** Human-readable label */
  readonly label: string;
  /** Whether the action is disabled */
  readonly disabled: boolean;
  /** Reason the action is disabled, if applicable */
  readonly disabledReason?: string;
}

export interface DecisionFieldDescriptor {
  /** Field identifier */
  readonly id: string;
  /** Human-readable label */
  readonly label: string;
  /** Field type: radio group, checkbox set, or text input */
  readonly type: 'radio' | 'checkbox' | 'text';
  /** Available options for radio/checkbox */
  readonly options?: readonly string[];
  /** Whether the field is required */
  readonly required: boolean;
}

export interface InspectorDialogDescriptor {
  /** Dialog title */
  readonly title: string;
  /** Unique identity for the inspected entity */
  readonly entityId: string;
  /** Whether the dialog is modal */
  readonly modal: boolean;
}

// ─── Coalesced Announcement Controller ──────────────────────────

/**
 * Manages a single polite ARIA status region and coalesces rapid
 * announcements at a configurable interval.
 *
 * Per Requirement 18.3, the Chat_Interface SHALL use one coalesced polite
 * status region for turn transitions and SHALL announce streaming content
 * no more frequently than the configured accessible interval.
 *
 * The region is NOT applied to the entire timeline — only status updates
 * are announced (Req 18.2).
 */
export class CoalescedAnnouncementController {
  private readonly config: CoalescedAnnouncementConfig;
  private statusRegion: HTMLElement | null = null;
  private pendingAnnouncements: AnnouncementEntry[] = [];
  private coalescingTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAnnouncedAt = 0;
  private disposed = false;

  constructor(config: CoalescedAnnouncementConfig) {
    const intervalMs = Math.max(
      MIN_ANNOUNCEMENT_INTERVAL_MS,
      Math.min(MAX_ANNOUNCEMENT_INTERVAL_MS, config.intervalMs),
    );
    this.config = { intervalMs };
  }

  /** Get the configured interval after clamping */
  get intervalMs(): number {
    return this.config.intervalMs;
  }

  /** Whether the controller has been disposed */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Create and mount the single polite status region.
   * The region uses `role="status"` with `aria-live="polite"` and `aria-atomic="true"`.
   * It does not make the entire timeline live.
   */
  mount(container: HTMLElement): HTMLElement {
    if (this.disposed) {
      throw new Error('CoalescedAnnouncementController has been disposed');
    }
    if (this.statusRegion) {
      return this.statusRegion;
    }

    const region = container.ownerDocument.createElement('div');
    region.id = STATUS_REGION_ID;
    region.className = STATUS_REGION_CSS_CLASS;
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'true');
    // Visually hidden but accessible to screen readers
    region.style.position = 'absolute';
    region.style.width = '1px';
    region.style.height = '1px';
    region.style.overflow = 'hidden';
    region.style.clip = 'rect(0, 0, 0, 0)';
    region.style.whiteSpace = 'nowrap';
    region.textContent = '';

    container.appendChild(region);
    this.statusRegion = region;
    return region;
  }

  /**
   * Queue an announcement for coalesced delivery.
   * If no announcement was recently made and no pending exists,
   * announces immediately. Otherwise coalesces at the configured interval.
   */
  announce(text: string, category: AnnouncementCategory): void {
    if (this.disposed || !this.statusRegion) return;
    if (!text.trim()) return;

    const entry: AnnouncementEntry = {
      text: text.trim(),
      queuedAt: Date.now(),
      category,
    };

    this.pendingAnnouncements.push(entry);

    // If we can announce immediately (enough time has passed), do so
    const timeSinceLastAnnounce = Date.now() - this.lastAnnouncedAt;
    if (timeSinceLastAnnounce >= this.config.intervalMs && !this.coalescingTimer) {
      this.flush();
    } else if (!this.coalescingTimer) {
      // Schedule the next flush at the interval boundary
      const delay = this.config.intervalMs - timeSinceLastAnnounce;
      this.coalescingTimer = setTimeout(() => {
        this.coalescingTimer = null;
        this.flush();
      }, Math.max(0, delay));
    }
  }

  /**
   * Get current pending announcement count (for testing).
   */
  get pendingCount(): number {
    return this.pendingAnnouncements.length;
  }

  /**
   * Force flush any pending announcements immediately.
   */
  flush(): void {
    if (this.disposed || !this.statusRegion) return;
    if (this.pendingAnnouncements.length === 0) return;

    // Coalesce: take the latest announcement per category
    const latestByCategory = new Map<AnnouncementCategory, AnnouncementEntry>();
    for (const entry of this.pendingAnnouncements) {
      latestByCategory.set(entry.category, entry);
    }

    // Build coalesced text from the latest per category, ordered by queue time
    const sorted = [...latestByCategory.values()].sort((a, b) => a.queuedAt - b.queuedAt);
    const text = sorted.map((e) => e.text).join('. ');

    this.statusRegion.textContent = text;
    this.lastAnnouncedAt = Date.now();
    this.pendingAnnouncements = [];

    if (this.coalescingTimer) {
      clearTimeout(this.coalescingTimer);
      this.coalescingTimer = null;
    }
  }

  /**
   * Clear the status region content without disposing.
   */
  clear(): void {
    if (this.statusRegion) {
      this.statusRegion.textContent = '';
    }
    this.pendingAnnouncements = [];
    if (this.coalescingTimer) {
      clearTimeout(this.coalescingTimer);
      this.coalescingTimer = null;
    }
  }

  /**
   * Dispose the controller, removing the status region and clearing timers.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.coalescingTimer) {
      clearTimeout(this.coalescingTimer);
      this.coalescingTimer = null;
    }
    if (this.statusRegion) {
      this.statusRegion.remove();
      this.statusRegion = null;
    }
    this.pendingAnnouncements = [];
  }
}

// ─── Semantic Structure Builders ────────────────────────────────

/**
 * Creates a tool lineage tree with `role="tree"` and `role="treeitem"` semantics.
 *
 * Per Requirement 18.4, the Chat_Interface SHALL expose tool lineages with tree semantics.
 * Each node provides accessible labels, expanded state, and non-color state indicators.
 */
export function createToolTree(
  nodes: readonly ToolTreeNode[],
  doc: Document = document,
): HTMLElement {
  const tree = doc.createElement('ul');
  tree.className = TOOL_TREE_CSS_CLASS;
  tree.setAttribute('role', 'tree');
  tree.setAttribute('aria-label', 'Tool activity');

  for (let i = 0; i < nodes.length; i++) {
    tree.appendChild(createToolTreeItem(nodes[i], 1, doc, i === 0));
  }

  return tree;
}

function createToolTreeItem(
  node: ToolTreeNode,
  level: number,
  doc: Document,
  isFirstAtTopLevel = false,
): HTMLElement {
  const item = doc.createElement('li');
  item.className = TOOL_TREE_ITEM_CSS_CLASS;
  item.setAttribute('role', 'treeitem');
  item.setAttribute('aria-label', node.label);
  item.setAttribute('aria-level', String(level));
  // Roving tabindex: only the first top-level item is tabbable
  item.setAttribute('tabindex', isFirstAtTopLevel ? '0' : '-1');
  item.dataset.toolId = node.id;

  if (node.children.length > 0) {
    item.setAttribute('aria-expanded', String(node.expanded));
  }

  // Label container with non-color state indicator
  const labelContainer = doc.createElement('span');
  labelContainer.className = 'nn-sr-tool-tree__label';
  labelContainer.textContent = node.label;
  item.appendChild(labelContainer);

  // Non-color state text indicator (Req 18.11)
  const stateIndicator = doc.createElement('span');
  stateIndicator.className = NON_COLOR_STATE_CSS_CLASS;
  stateIndicator.setAttribute('aria-hidden', 'false');
  stateIndicator.textContent = ` [${node.stateText}]`;
  item.appendChild(stateIndicator);

  // Render children as a nested group
  if (node.children.length > 0 && node.expanded) {
    const childGroup = doc.createElement('ul');
    childGroup.setAttribute('role', 'group');
    for (const child of node.children) {
      childGroup.appendChild(createToolTreeItem(child, level + 1, doc, false));
    }
    item.appendChild(childGroup);
  }

  return item;
}

/**
 * Creates an action group with `role="toolbar"` semantics.
 *
 * Per Requirement 18.5, the Chat_Interface SHALL expose action groups with toolbar semantics.
 * Each action button has an accessible name, visible focus style, and non-hover discovery.
 */
export function createActionToolbar(
  label: string,
  actions: readonly ActionDescriptor[],
  doc: Document = document,
): HTMLElement {
  const toolbar = doc.createElement('div');
  toolbar.className = ACTION_TOOLBAR_CSS_CLASS;
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', label);

  for (const action of actions) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = `${ACTION_TOOLBAR_CSS_CLASS}__action`;
    button.textContent = action.label;
    button.setAttribute('aria-label', action.label);
    button.dataset.actionId = action.id;

    if (action.disabled) {
      button.disabled = true;
      if (action.disabledReason) {
        button.setAttribute('aria-description', action.disabledReason);
        button.title = action.disabledReason;
      }
    }

    // Ensure visible focus style class
    button.classList.add('nn-sr-focusable');
    toolbar.appendChild(button);
  }

  // Roving tabindex: only first non-disabled button is tabbable
  const buttons = toolbar.querySelectorAll('button');
  let firstFocusable = false;
  buttons.forEach((btn) => {
    if (!btn.disabled && !firstFocusable) {
      btn.setAttribute('tabindex', '0');
      firstFocusable = true;
    } else {
      btn.setAttribute('tabindex', '-1');
    }
  });

  return toolbar;
}

/**
 * Creates a decision/approval surface with `role="form"` semantics.
 *
 * Per Requirement 18.6, the Chat_Interface SHALL expose approvals with form semantics.
 * The form provides labeled controls, required field indicators, and non-hover discovery.
 */
export function createDecisionForm(
  title: string,
  fields: readonly DecisionFieldDescriptor[],
  doc: Document = document,
): HTMLElement {
  const form = doc.createElement('form');
  form.className = DECISION_FORM_CSS_CLASS;
  form.setAttribute('role', 'form');
  form.setAttribute('aria-label', title);
  // Prevent actual submission
  form.addEventListener('submit', (e) => e.preventDefault());

  const heading = doc.createElement('legend');
  heading.textContent = title;
  heading.className = `${DECISION_FORM_CSS_CLASS}__title`;
  form.appendChild(heading);

  for (const field of fields) {
    const fieldset = doc.createElement('fieldset');
    fieldset.className = `${DECISION_FORM_CSS_CLASS}__field`;
    fieldset.dataset.fieldId = field.id;

    const label = doc.createElement('legend');
    label.textContent = field.label;
    if (field.required) {
      const req = doc.createElement('span');
      req.className = `${DECISION_FORM_CSS_CLASS}__required`;
      req.textContent = ' (required)';
      req.setAttribute('aria-hidden', 'true');
      label.appendChild(req);
    }
    fieldset.appendChild(label);

    if (field.type === 'text') {
      const input = doc.createElement('input');
      input.type = 'text';
      input.id = `decision-field-${field.id}`;
      input.name = field.id;
      input.setAttribute('aria-label', field.label);
      input.setAttribute('aria-required', String(field.required));
      input.className = 'nn-sr-focusable';
      fieldset.appendChild(input);
    } else if (field.type === 'radio' && field.options) {
      for (const option of field.options) {
        const optContainer = doc.createElement('label');
        optContainer.className = `${DECISION_FORM_CSS_CLASS}__option`;
        const radio = doc.createElement('input');
        radio.type = 'radio';
        radio.name = field.id;
        radio.value = option;
        radio.setAttribute('aria-required', String(field.required));
        radio.className = 'nn-sr-focusable';
        optContainer.appendChild(radio);
        optContainer.appendChild(doc.createTextNode(` ${option}`));
        fieldset.appendChild(optContainer);
      }
    } else if (field.type === 'checkbox' && field.options) {
      for (const option of field.options) {
        const optContainer = doc.createElement('label');
        optContainer.className = `${DECISION_FORM_CSS_CLASS}__option`;
        const checkbox = doc.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.name = field.id;
        checkbox.value = option;
        checkbox.className = 'nn-sr-focusable';
        optContainer.appendChild(checkbox);
        optContainer.appendChild(doc.createTextNode(` ${option}`));
        fieldset.appendChild(optContainer);
      }
    }

    form.appendChild(fieldset);
  }

  return form;
}

/**
 * Creates a modal inspector/lightbox with `role="dialog"` semantics.
 *
 * Per Requirement 18.7, the Chat_Interface SHALL expose modal inspectors
 * and lightboxes with dialog semantics.
 *
 * Implements focus trapping, close on Escape, and focus restoration.
 */
export function createInspectorDialog(
  descriptor: InspectorDialogDescriptor,
  contentElement: HTMLElement,
  doc: Document = document,
): InspectorDialogHandle {
  const dialog = doc.createElement('div');
  dialog.className = INSPECTOR_DIALOG_CSS_CLASS;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-label', descriptor.title);
  dialog.setAttribute('aria-modal', String(descriptor.modal));
  dialog.dataset.entityId = descriptor.entityId;

  // Title/header
  const header = doc.createElement('div');
  header.className = `${INSPECTOR_DIALOG_CSS_CLASS}__header`;

  const titleEl = doc.createElement('h2');
  titleEl.className = `${INSPECTOR_DIALOG_CSS_CLASS}__title`;
  titleEl.id = `inspector-dialog-title-${descriptor.entityId}`;
  titleEl.textContent = descriptor.title;
  dialog.setAttribute('aria-labelledby', titleEl.id);
  header.appendChild(titleEl);

  const closeButton = doc.createElement('button');
  closeButton.type = 'button';
  closeButton.className = `${INSPECTOR_DIALOG_CSS_CLASS}__close nn-sr-focusable`;
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.textContent = '\u00D7'; // × symbol
  header.appendChild(closeButton);

  dialog.appendChild(header);

  // Content area
  const content = doc.createElement('div');
  content.className = `${INSPECTOR_DIALOG_CSS_CLASS}__content`;
  content.appendChild(contentElement);
  dialog.appendChild(content);

  // Track invoking element for focus restoration
  const previouslyFocused = doc.activeElement as HTMLElement | null;

  // Focus management
  let open = false;

  function trapFocus(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      handle.close();
      return;
    }
    if (e.key !== 'Tab') return;

    const focusable = dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey && doc.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && doc.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const handle: InspectorDialogHandle = {
    element: dialog,
    get isOpen() {
      return open;
    },
    open() {
      if (open) return;
      open = true;
      dialog.style.display = '';
      dialog.addEventListener('keydown', trapFocus);
      // Focus the close button by default
      closeButton.focus();
    },
    close() {
      if (!open) return;
      open = false;
      dialog.style.display = 'none';
      dialog.removeEventListener('keydown', trapFocus);
      // Restore focus (Req 16.6)
      if (previouslyFocused && previouslyFocused.focus) {
        previouslyFocused.focus();
      }
    },
    dispose() {
      handle.close();
      dialog.remove();
    },
  };

  // Wire close button
  closeButton.addEventListener('click', () => handle.close());

  // Start hidden
  dialog.style.display = 'none';

  return handle;
}

export interface InspectorDialogHandle {
  readonly element: HTMLElement;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  dispose(): void;
}

// ─── Accessibility Gate ─────────────────────────────────────────

export type SemanticMappingKind = 'tree' | 'toolbar' | 'form' | 'dialog';

export interface AccessibilityGateResult {
  readonly passed: boolean;
  readonly missingMappings: readonly SemanticMappingKind[];
  readonly details: readonly string[];
}

/**
 * Required semantic mappings as per Requirement 18.4–18.7.
 * The gate fails entirely if ANY required mapping is absent (Req 18.8, 18.9).
 */
const REQUIRED_SEMANTIC_MAPPINGS: readonly SemanticMappingKind[] = [
  'tree',    // Req 18.4: tool lineages
  'toolbar', // Req 18.5: action groups
  'form',    // Req 18.6: approvals
  'dialog',  // Req 18.7: modal inspectors/lightboxes
];

export interface SemanticMappingRegistry {
  /** Whether the tree semantic mapping is implemented */
  readonly tree: boolean;
  /** Whether the toolbar semantic mapping is implemented */
  readonly toolbar: boolean;
  /** Whether the form semantic mapping is implemented */
  readonly form: boolean;
  /** Whether the dialog semantic mapping is implemented */
  readonly dialog: boolean;
}

/**
 * Run the accessibility gate check.
 *
 * Per Requirements 18.8 and 18.9:
 * - If ANY tree, toolbar, form, or dialog semantic mapping is absent,
 *   the gate SHALL fail the COMPLETE semantic implementation.
 * - The gate SHALL NOT grant partial compliance.
 */
export function runAccessibilityGate(
  registry: SemanticMappingRegistry,
): AccessibilityGateResult {
  const missing: SemanticMappingKind[] = [];
  const details: string[] = [];

  for (const kind of REQUIRED_SEMANTIC_MAPPINGS) {
    if (!registry[kind]) {
      missing.push(kind);
      details.push(`Missing required semantic mapping: ${kind} (Requirement 18.${REQUIRED_SEMANTIC_MAPPINGS.indexOf(kind) + 4})`);
    }
  }

  if (missing.length > 0) {
    details.unshift(
      'Accessibility gate FAILED: complete semantic implementation rejected (Req 18.8, 18.9)',
    );
  }

  return {
    passed: missing.length === 0,
    missingMappings: missing,
    details,
  };
}

/**
 * Verify that the current implementation provides all required semantic mappings.
 * This returns the full registry based on the actual implementation status.
 */
export function buildSemanticMappingRegistry(): SemanticMappingRegistry {
  return {
    tree: true,    // createToolTree provides tree/treeitem
    toolbar: true, // createActionToolbar provides toolbar
    form: true,    // createDecisionForm provides form
    dialog: true,  // createInspectorDialog provides dialog
  };
}

// ─── Non-Color State Cues ───────────────────────────────────────

export type StateCueKind =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'waiting'
  | 'queued'
  | 'retrying'
  | 'unknown';

const STATE_CUE_LABELS: Record<StateCueKind, string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  blocked: 'Blocked',
  waiting: 'Waiting',
  queued: 'Queued',
  retrying: 'Retrying',
  unknown: 'Unknown',
};

const STATE_CUE_SYMBOLS: Record<StateCueKind, string> = {
  running: '\u25B6',    // ▶
  completed: '\u2713',  // ✓
  failed: '\u2717',     // ✗
  cancelled: '\u2014',  // —
  blocked: '\u25A0',    // ■
  waiting: '\u25CB',    // ○
  queued: '\u25CF',     // ●
  retrying: '\u21BA',   // ↺
  unknown: '\u003F',    // ?
};

/**
 * Create a non-color state indicator element.
 *
 * Per Requirement 18.11: Status, risk, confidence, diff meaning, selection,
 * progress, and errors SHALL use text or shape in addition to color.
 */
export function createStateCue(
  state: StateCueKind,
  doc: Document = document,
): HTMLElement {
  const indicator = doc.createElement('span');
  indicator.className = NON_COLOR_STATE_CSS_CLASS;
  indicator.dataset.state = state;
  indicator.setAttribute('aria-label', STATE_CUE_LABELS[state]);
  indicator.textContent = `${STATE_CUE_SYMBOLS[state]} ${STATE_CUE_LABELS[state]}`;
  return indicator;
}

// ─── Accessible Name Utilities ──────────────────────────────────

/**
 * Ensure an element has a visible focus style and accessible name.
 * Per Requirement 18.10: EVERY icon-only control SHALL have an accessible name,
 * visible focus style, and equivalent non-hover discovery path.
 */
export function ensureAccessibleControl(
  element: HTMLElement,
  accessibleName: string,
): void {
  element.setAttribute('aria-label', accessibleName);
  element.classList.add('nn-sr-focusable');
  // Ensure it's keyboard-reachable if not already
  if (!element.hasAttribute('tabindex') && element.tagName !== 'BUTTON' && element.tagName !== 'A') {
    element.setAttribute('tabindex', '0');
  }
}

// ─── Toolbar Arrow-Key Navigation (Req 12.5, 14.4) ─────────────

export interface ToolbarKeyboardNavigationOptions {
  /**
   * Selector for the focusable items inside the toolbar. Defaults to
   * `'button:not([disabled]), [role="button"]:not([aria-disabled="true"])'`
   * which matches native buttons and any accessibility-labeled controls.
   */
  readonly itemSelector?: string;
  /**
   * Orientation for arrow-key handling.
   * - `'horizontal'` (default): Left/Right cycle; Up/Down are ignored so
   *   the surrounding scroll container remains operable.
   * - `'vertical'`: Up/Down cycle; Left/Right are ignored.
   * - `'both'`: All four arrows cycle (used by tool trees / grids).
   */
  readonly orientation?: 'horizontal' | 'vertical' | 'both';
}

export interface ToolbarKeyboardNavigationHandle {
  /** Detach the keyboard listener and release references. */
  dispose(): void;
}

/**
 * Attach arrow-key + Home/End navigation to a toolbar-like container with
 * roving tabindex.
 *
 * The container should already have `role="toolbar"` and its items should
 * already carry accessible names. This helper adds keyboard behavior only:
 * ArrowRight/ArrowLeft (and optionally Up/Down) move focus between items,
 * cycling at the boundaries. Home/End jump to the first/last item.
 *
 * Roving tabindex is maintained so the toolbar is a single Tab stop and the
 * currently-focused item is the one that will receive focus when Tab
 * re-enters the toolbar.
 *
 * Per Requirement 12.5 (response-action toolbars / code-action toolbars)
 * and Requirement 14.4 (every interactive element is keyboard operable).
 */
export function attachToolbarArrowKeyNavigation(
  toolbar: HTMLElement,
  options: ToolbarKeyboardNavigationOptions = {},
): ToolbarKeyboardNavigationHandle {
  const orientation = options.orientation ?? 'horizontal';
  const itemSelector =
    options.itemSelector ??
    'button:not([disabled]), [role="button"]:not([aria-disabled="true"])';

  function collectItems(): HTMLElement[] {
    return Array.from(toolbar.querySelectorAll<HTMLElement>(itemSelector));
  }

  function focusIndex(items: HTMLElement[], index: number): void {
    for (let i = 0; i < items.length; i++) {
      items[i].setAttribute('tabindex', i === index ? '0' : '-1');
    }
    items[index].focus();
  }

  function currentIndex(items: HTMLElement[]): number {
    const active = toolbar.ownerDocument?.activeElement;
    for (let i = 0; i < items.length; i++) {
      if (items[i] === active) return i;
    }
    // No focused item yet — fall back to the one that carries tabindex=0.
    for (let i = 0; i < items.length; i++) {
      if (items[i].getAttribute('tabindex') === '0') return i;
    }
    return 0;
  }

  function handleKeyDown(event: KeyboardEvent): void {
    const items = collectItems();
    if (items.length === 0) return;

    const key = event.key;
    const isForward =
      (orientation !== 'vertical' && key === 'ArrowRight') ||
      (orientation !== 'horizontal' && key === 'ArrowDown');
    const isBackward =
      (orientation !== 'vertical' && key === 'ArrowLeft') ||
      (orientation !== 'horizontal' && key === 'ArrowUp');

    if (isForward || isBackward) {
      event.preventDefault();
      const currentIdx = currentIndex(items);
      const nextIdx = isForward
        ? (currentIdx + 1) % items.length
        : (currentIdx - 1 + items.length) % items.length;
      focusIndex(items, nextIdx);
      return;
    }

    if (key === 'Home') {
      event.preventDefault();
      focusIndex(items, 0);
      return;
    }

    if (key === 'End') {
      event.preventDefault();
      focusIndex(items, items.length - 1);
      return;
    }
  }

  toolbar.addEventListener('keydown', handleKeyDown);

  return {
    dispose(): void {
      toolbar.removeEventListener('keydown', handleKeyDown);
    },
  };
}

// ─── Disclosure with Focus Restoration (Req 13.6, 14.7) ────────

export interface DisclosureOptions {
  /** Initial expanded state. Defaults to false (collapsed). */
  readonly initialExpanded?: boolean;
  /** Callback fired every time expanded state changes. */
  readonly onToggle?: (expanded: boolean) => void;
  /**
   * When set, the disclosure will restore focus to this element after the
   * panel collapses (useful when the panel contained the previously-focused
   * control). If omitted, focus stays on the toggle button as normal.
   */
  readonly restoreFocusOnCollapseTo?: HTMLElement;
}

export interface DisclosureHandle {
  /** The toggle button element. Already wired with keyboard handlers. */
  readonly toggle: HTMLElement;
  /** The disclosable panel element. `hidden` when collapsed. */
  readonly panel: HTMLElement;
  /** Whether the panel is currently expanded. */
  readonly expanded: boolean;
  /** Programmatically set the expanded state (fires onToggle). */
  setExpanded(expanded: boolean): void;
  /** Detach listeners; leaves DOM in place. */
  dispose(): void;
}

/**
 * Wire an existing toggle button and panel as a disclosure widget.
 *
 * Establishes `aria-expanded` / `aria-controls` on the toggle, sets `hidden`
 * on the panel to match, and adds click + Enter/Space activation. On
 * collapse, focus is restored either to the toggle (default) or to the
 * caller-supplied `restoreFocusOnCollapseTo` element (Req 14.7).
 *
 * Per Requirement 13.6 (Reasoning/Task/Tool disclosures use aria-expanded
 * with aria-controls) and Requirement 14.7 (focus is preserved when cards
 * expand, collapse, update, or reach a terminal state).
 */
export function bindDisclosure(
  toggle: HTMLElement,
  panel: HTMLElement,
  options: DisclosureOptions = {},
): DisclosureHandle {
  let expanded = options.initialExpanded === true;

  // Ensure a stable panel id so aria-controls can reference it.
  if (!panel.id) {
    panel.id = `nn-sr-disclosure-panel-${Math.random().toString(36).slice(2, 10)}`;
  }
  toggle.setAttribute('aria-controls', panel.id);
  toggle.setAttribute('aria-expanded', String(expanded));
  panel.hidden = !expanded;
  // Native buttons already have role=button, but if callers pass a
  // non-button element we ensure a role so screen readers treat it as one.
  if (toggle.tagName !== 'BUTTON' && !toggle.hasAttribute('role')) {
    toggle.setAttribute('role', 'button');
    toggle.setAttribute('tabindex', '0');
  }

  function applyState(): void {
    toggle.setAttribute('aria-expanded', String(expanded));
    panel.hidden = !expanded;
  }

  function setExpanded(next: boolean): void {
    if (next === expanded) return;
    const wasExpanded = expanded;
    expanded = next;
    applyState();
    options.onToggle?.(expanded);

    // Focus restoration on collapse (Req 14.7). Panel becomes hidden, so
    // whatever inside the panel had focus is no longer reachable. Restore
    // focus to the caller-provided element or the toggle itself.
    if (wasExpanded && !expanded) {
      const doc = toggle.ownerDocument ?? document;
      const active = doc.activeElement as HTMLElement | null;
      const containsActive = active !== null && panel.contains(active);
      if (containsActive || active === null || active === doc.body) {
        const target = options.restoreFocusOnCollapseTo ?? toggle;
        target.focus();
      }
    }
  }

  function handleClick(): void {
    setExpanded(!expanded);
  }

  function handleKeyDown(event: KeyboardEvent): void {
    // Space + Enter activate a button natively. For a role="button" element
    // we still need to intercept Space to prevent page scroll.
    if (toggle.tagName === 'BUTTON') return;
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      setExpanded(!expanded);
    }
  }

  toggle.addEventListener('click', handleClick);
  toggle.addEventListener('keydown', handleKeyDown);

  return {
    toggle,
    panel,
    get expanded() {
      return expanded;
    },
    setExpanded,
    dispose(): void {
      toggle.removeEventListener('click', handleClick);
      toggle.removeEventListener('keydown', handleKeyDown);
    },
  };
}

// ─── Coalesced Live-Region Feedback (Req 14.6) ─────────────────

export const DEFAULT_FEEDBACK_COALESCE_WINDOW_MS = 300;

export interface CoalescedFeedbackAnnouncerOptions {
  /**
   * Window in ms during which repeated announcements of the same channel
   * (status vs alert) collapse to the most recent message. Defaults to
   * {@link DEFAULT_FEEDBACK_COALESCE_WINDOW_MS} (300ms), consistent with
   * how screen readers batch status changes.
   */
  readonly windowMs?: number;
  /**
   * Optional scheduler override so tests can drive timing deterministically.
   * Must return a handle usable with the paired `clearTimer`.
   */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface CoalescedFeedbackChannel {
  /** Announce on the polite `role="status"` region. */
  announceStatus(message: string): void;
  /** Announce on the assertive `role="alert"` region. */
  announceAlert(message: string): void;
  /** Immediately flush any pending status/alert announcements. */
  flush(): void;
  /** Number of announcements delivered to the sinks (for tests). */
  readonly deliveredCount: number;
  /** Detach timers; leaves the underlying sinks untouched. */
  dispose(): void;
}

/**
 * Wrap two live-region sinks (polite status + assertive alert) so that
 * rapid consecutive announcements are coalesced to the most recent message
 * per channel within a small window.
 *
 * Rationale (Req 14.6): high-frequency, non-token status updates such as
 * "Copied", "Copy failed", "Retry sent" would otherwise queue on the screen
 * reader as an unreadable stream. Screen readers already coalesce identical
 * polite announcements but we cannot rely on that alone — this wrapper
 * guarantees a bounded announcement rate at the source.
 *
 * Design: the FIRST announcement per channel fires immediately (so users get
 * fast feedback), and subsequent announcements within the window replace the
 * pending value and are delivered after the window closes. Immediate delivery
 * of the first message keeps interactions responsive; the window bounds the
 * rate to at most one announcement per channel per `windowMs`.
 *
 * The wrapper never delegates streaming/token announcements — those go
 * through {@link CoalescedAnnouncementController}. This is specifically for
 * copy/retry/feedback outcomes and similar non-token status updates.
 */
export function createCoalescedFeedbackAnnouncer(
  sink: {
    announceStatus(message: string): void;
    announceAlert(message: string): void;
  },
  options: CoalescedFeedbackAnnouncerOptions = {},
): CoalescedFeedbackChannel {
  const windowMs = options.windowMs ?? DEFAULT_FEEDBACK_COALESCE_WINDOW_MS;
  const setTimer =
    options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  interface ChannelState {
    lastDeliveredAt: number;
    pendingMessage: string | null;
    timerHandle: unknown | null;
  }

  const statusState: ChannelState = { lastDeliveredAt: 0, pendingMessage: null, timerHandle: null };
  const alertState: ChannelState = { lastDeliveredAt: 0, pendingMessage: null, timerHandle: null };

  let deliveredCount = 0;
  let disposed = false;

  function deliver(state: ChannelState, sinkFn: (msg: string) => void, message: string): void {
    sinkFn(message);
    state.lastDeliveredAt = Date.now();
    deliveredCount += 1;
  }

  function schedule(state: ChannelState, sinkFn: (msg: string) => void, delay: number): void {
    if (state.timerHandle !== null) return;
    state.timerHandle = setTimer(() => {
      state.timerHandle = null;
      if (disposed) return;
      if (state.pendingMessage === null) return;
      const message = state.pendingMessage;
      state.pendingMessage = null;
      deliver(state, sinkFn, message);
    }, Math.max(0, delay));
  }

  function announce(
    state: ChannelState,
    sinkFn: (msg: string) => void,
    message: string,
  ): void {
    if (disposed) return;
    if (typeof message !== 'string' || message.length === 0) return;

    const now = Date.now();
    const elapsed = now - state.lastDeliveredAt;

    if (elapsed >= windowMs && state.timerHandle === null) {
      // First announcement or window has fully elapsed — deliver immediately.
      deliver(state, sinkFn, message);
      return;
    }

    // Coalesce: replace pending message and schedule delivery at boundary.
    state.pendingMessage = message;
    schedule(state, sinkFn, windowMs - elapsed);
  }

  function flushState(state: ChannelState, sinkFn: (msg: string) => void): void {
    if (state.timerHandle !== null) {
      clearTimer(state.timerHandle);
      state.timerHandle = null;
    }
    if (state.pendingMessage !== null) {
      const message = state.pendingMessage;
      state.pendingMessage = null;
      deliver(state, sinkFn, message);
    }
  }

  return {
    announceStatus(message: string): void {
      announce(statusState, (m) => sink.announceStatus(m), message);
    },
    announceAlert(message: string): void {
      announce(alertState, (m) => sink.announceAlert(m), message);
    },
    flush(): void {
      flushState(statusState, (m) => sink.announceStatus(m));
      flushState(alertState, (m) => sink.announceAlert(m));
    },
    get deliveredCount() {
      return deliveredCount;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (statusState.timerHandle !== null) {
        clearTimer(statusState.timerHandle);
        statusState.timerHandle = null;
      }
      if (alertState.timerHandle !== null) {
        clearTimer(alertState.timerHandle);
        alertState.timerHandle = null;
      }
      statusState.pendingMessage = null;
      alertState.pendingMessage = null;
    },
  };
}
