/**
 * Message Action Bar and Selection Actions — typed, keyboard-discoverable
 * toolbar providing copy/expand/source/branch/edit-resend/retry/feedback
 * actions bound to exact node/block/source revision/range-or-digest.
 *
 * Selection actions bind to finalized ranges/digests and default to prompt
 * insertion (not submission). Direct submission or authority commands are
 * explicitly labeled. Actions invalidate when streaming or when a projection
 * update is incompatible. Focus restores to the selected block or the
 * Composer_Workbench on dismissal.
 *
 * Requirements: 14.1–14.6, 14.13, 18.5
 */

import type { ActionDescriptorV1 } from '../../../harness/contracts/response-support';

// ─── Public Types ───────────────────────────────────────────────

/** The types of message-level actions available in the action bar. */
export type MessageActionKind =
  | 'copy'
  | 'expand'
  | 'source'
  | 'branch'
  | 'edit_resend'
  | 'retry'
  | 'feedback';

/** Eligibility check result for a specific action. */
export interface ActionEligibility {
  readonly kind: MessageActionKind;
  readonly eligible: boolean;
  readonly disabledReason?: string;
}

/** Target identity for action binding. */
export interface ActionTargetIdentity {
  readonly chatNodeStableKey: string;
  readonly blockStableKey?: string;
  readonly sourceRevision: number;
  readonly projectionRevision: number;
}

/** The binding context supplied when constructing a message action bar. */
export interface MessageActionBarContextV1 {
  readonly schemaVersion: 1;
  readonly target: ActionTargetIdentity;
  /** Whether the associated node is currently streaming. */
  readonly isStreaming: boolean;
  /** Whether the node is finalized (terminal). */
  readonly isFinalized: boolean;
  /** The sender role: 'user' | 'assistant'. */
  readonly sender: 'user' | 'assistant';
  /** Whether the node has expandable content. */
  readonly hasExpandableContent: boolean;
  /** Whether source/provenance is available. */
  readonly hasSource: boolean;
  /** Whether branching is allowed from this node. */
  readonly branchAllowed: boolean;
  /** Whether edit-and-resend is available (user messages only). */
  readonly editResendAllowed: boolean;
  /** Whether retry is available (assistant messages after failure). */
  readonly retryAllowed: boolean;
  /** Whether feedback is enabled. */
  readonly feedbackAllowed: boolean;
  /** Current content text for copy action. */
  readonly contentText?: string;
  /** Authority action descriptors for each eligible action. */
  readonly actionDescriptors?: Partial<Record<MessageActionKind, ActionDescriptorV1>>;
}

/** Selection action kind distinguishing behavior. */
export type SelectionActionBehavior = 'insert_prompt' | 'submit_prompt' | 'authority_command';

/** A single selection action bound to a range/digest within a finalized block. */
export interface SelectionActionEntryV1 {
  readonly actionId: string;
  readonly label: string;
  readonly behavior: SelectionActionBehavior;
  readonly action: ActionDescriptorV1;
}

/** The binding context for a text selection action group. */
export interface SelectionActionContextV1 {
  readonly schemaVersion: 1;
  readonly target: ActionTargetIdentity;
  /** The selected text range or digest. */
  readonly rangeOrDigest: string;
  /** Whether the parent block is currently streaming. */
  readonly isStreaming: boolean;
  /** The source revision the selection was made against. */
  readonly selectionSourceRevision: number;
  /** Available selection actions. */
  readonly actions: readonly SelectionActionEntryV1[];
}

/** Callback interface for action invocations from the toolbar. */
export interface MessageActionBarCallbacksV1 {
  readonly onCopy?: (target: ActionTargetIdentity, contentText: string) => Promise<boolean>;
  readonly onExpand?: (target: ActionTargetIdentity) => void;
  readonly onSource?: (target: ActionTargetIdentity) => void;
  readonly onBranch?: (target: ActionTargetIdentity, action: ActionDescriptorV1) => void;
  readonly onEditResend?: (target: ActionTargetIdentity, action: ActionDescriptorV1) => void;
  readonly onRetry?: (target: ActionTargetIdentity, action: ActionDescriptorV1) => void;
  readonly onFeedback?: (target: ActionTargetIdentity) => void;
}

/** Callback interface for selection action invocations. */
export interface SelectionActionCallbacksV1 {
  readonly onAction?: (entry: SelectionActionEntryV1, target: ActionTargetIdentity) => void;
  readonly onDismiss?: () => void;
}

/** The handle returned from creating a message action bar. */
export interface MessageActionBarHandle {
  readonly element: HTMLElement;
  readonly disposed: boolean;
  update(context: MessageActionBarContextV1): void;
  dispose(): void;
}

/** The handle returned from creating a selection action group. */
export interface SelectionActionGroupHandle {
  readonly element: HTMLElement;
  readonly disposed: boolean;
  /** True if the group was invalidated by streaming or projection update. */
  readonly invalidated: boolean;
  invalidate(reason: 'streaming' | 'projection_update'): void;
  dispose(): void;
}

// ─── Constants ──────────────────────────────────────────────────

export const MESSAGE_ACTION_BAR_CSS_CLASS = 'nn-msg-action-bar';
export const SELECTION_ACTION_GROUP_CSS_CLASS = 'nn-selection-action-group';

const ACTION_LABELS: Readonly<Record<MessageActionKind, string>> = Object.freeze({
  copy: 'Copy',
  expand: 'Expand',
  source: 'Source',
  branch: 'Branch',
  edit_resend: 'Edit & Resend',
  retry: 'Retry',
  feedback: 'Feedback',
});

const ACTION_ICONS: Readonly<Record<MessageActionKind, string>> = Object.freeze({
  copy: '\u{1F4CB}',      // clipboard
  expand: '\u2922',       // ⤢
  source: '\u{1F517}',    // link
  branch: '\u2387',       // ⎇
  edit_resend: '\u270E',  // ✎
  retry: '\u21BB',        // ↻
  feedback: '\u{1F4AC}',  // speech bubble
});

const BEHAVIOR_LABELS: Readonly<Record<SelectionActionBehavior, string>> = Object.freeze({
  insert_prompt: '',
  submit_prompt: 'Sends',
  authority_command: 'Command',
});

// ─── Eligibility Logic ──────────────────────────────────────────

/**
 * Determine which message actions are eligible given the bar context.
 *
 * Requirement 14.1: expose applicable copy/expand/source/branch/edit-resend/
 * retry/feedback when a ChatNode is eligible.
 * Requirement 14.2: every action remains keyboard discoverable without hover.
 */
export function resolveEligibility(context: MessageActionBarContextV1): ActionEligibility[] {
  const results: ActionEligibility[] = [];

  // Copy: always eligible for finalized content
  results.push({
    kind: 'copy',
    eligible: context.isFinalized && !!context.contentText,
    ...(context.isStreaming ? { disabledReason: 'Content is streaming' } : {}),
  });

  // Expand: available when there is expandable content
  results.push({
    kind: 'expand',
    eligible: context.hasExpandableContent && !context.isStreaming,
    ...(context.isStreaming ? { disabledReason: 'Content is streaming' } : {}),
  });

  // Source: available when source/provenance exists
  results.push({
    kind: 'source',
    eligible: context.hasSource && context.isFinalized,
    ...(!context.isFinalized ? { disabledReason: 'Waiting for completion' } : {}),
  });

  // Branch: available for assistant messages when branching is allowed
  results.push({
    kind: 'branch',
    eligible: context.sender === 'assistant' && context.branchAllowed && context.isFinalized,
    ...(context.isStreaming ? { disabledReason: 'Content is streaming' } : {}),
  });

  // Edit & Resend: user messages only
  results.push({
    kind: 'edit_resend',
    eligible: context.sender === 'user' && context.editResendAllowed,
  });

  // Retry: assistant messages after failure
  results.push({
    kind: 'retry',
    eligible: context.sender === 'assistant' && context.retryAllowed && context.isFinalized,
    ...(context.isStreaming ? { disabledReason: 'Content is streaming' } : {}),
  });

  // Feedback: eligible when enabled and finalized
  results.push({
    kind: 'feedback',
    eligible: context.feedbackAllowed && context.isFinalized,
    ...(context.isStreaming ? { disabledReason: 'Content is streaming' } : {}),
  });

  return results;
}

// ─── Focus Management ───────────────────────────────────────────

/**
 * Restore focus to the invoking element or the composer workbench fallback.
 *
 * Requirement 14.6: restore focus to the selected block or Composer_Workbench
 * when the action group is dismissed.
 */
export function restoreFocus(invokingElement?: HTMLElement | null): void {
  if (invokingElement && invokingElement.isConnected) {
    invokingElement.focus();
    return;
  }
  // Fallback to composer workbench
  const composer = document.querySelector<HTMLElement>(
    '[data-role="composer-workbench"] textarea, [data-role="composer-workbench"] [contenteditable]',
  );
  if (composer) {
    composer.focus();
  }
}

// ─── Staleness Validation ───────────────────────────────────────

/**
 * Check if a selection action group's range/digest is still valid against
 * the current projection state.
 *
 * Requirement 14.5: dismiss/disable when streaming or projection update
 * invalidates the selected range or digest.
 */
export function isSelectionStale(
  context: SelectionActionContextV1,
  currentSourceRevision: number,
  currentIsStreaming: boolean,
): boolean {
  if (currentIsStreaming) return true;
  if (currentSourceRevision !== context.selectionSourceRevision) return true;
  return false;
}

// ─── DOM Rendering: Message Action Bar ──────────────────────────

/**
 * Create a message action bar toolbar element.
 *
 * Requirement 18.5: action groups use toolbar semantics.
 * Requirement 14.2: keyboard discoverable and operable without hover.
 */
export function createMessageActionBar(
  context: MessageActionBarContextV1,
  callbacks: MessageActionBarCallbacksV1,
): MessageActionBarHandle {
  let disposed = false;
  let currentContext = context;
  let focusedIndex = 0;

  const bar = document.createElement('div');
  bar.className = MESSAGE_ACTION_BAR_CSS_CLASS;
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Message actions');
  bar.setAttribute('aria-orientation', 'horizontal');

  // Initial render
  renderButtons(bar, currentContext, callbacks);

  // Keyboard navigation: roving tabindex within the toolbar
  bar.addEventListener('keydown', (e: KeyboardEvent) => {
    const buttons = Array.from(bar.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
    if (buttons.length === 0) return;

    let handled = false;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      focusedIndex = (focusedIndex + 1) % buttons.length;
      handled = true;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      focusedIndex = (focusedIndex - 1 + buttons.length) % buttons.length;
      handled = true;
    } else if (e.key === 'Home') {
      focusedIndex = 0;
      handled = true;
    } else if (e.key === 'End') {
      focusedIndex = buttons.length - 1;
      handled = true;
    }

    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      updateRovingTabindex(buttons, focusedIndex);
      buttons[focusedIndex].focus();
    }
  });

  const handle: MessageActionBarHandle = {
    get element() {
      return bar;
    },
    get disposed() {
      return disposed;
    },
    update(newContext: MessageActionBarContextV1) {
      if (disposed) return;
      currentContext = newContext;
      focusedIndex = 0;
      renderButtons(bar, currentContext, callbacks);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      bar.remove();
    },
  };

  return handle;
}

function renderButtons(
  bar: HTMLElement,
  context: MessageActionBarContextV1,
  callbacks: MessageActionBarCallbacksV1,
): void {
  // Clear existing buttons
  bar.innerHTML = '';

  const eligibility = resolveEligibility(context);
  const eligibleActions = eligibility.filter((e) => e.eligible);

  if (eligibleActions.length === 0) {
    bar.setAttribute('aria-hidden', 'true');
    return;
  }
  bar.removeAttribute('aria-hidden');

  eligibleActions.forEach((entry, index) => {
    const btn = createActionButton(entry.kind, context, callbacks);
    if (index === 0) {
      btn.setAttribute('tabindex', '0');
    } else {
      btn.setAttribute('tabindex', '-1');
    }
    bar.appendChild(btn);
  });
}

function createActionButton(
  kind: MessageActionKind,
  context: MessageActionBarContextV1,
  callbacks: MessageActionBarCallbacksV1,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = `${MESSAGE_ACTION_BAR_CSS_CLASS}__btn`;
  btn.setAttribute('type', 'button');
  btn.setAttribute('aria-label', ACTION_LABELS[kind]);
  btn.setAttribute('data-action', kind);
  btn.title = ACTION_LABELS[kind];

  const icon = document.createElement('span');
  icon.className = `${MESSAGE_ACTION_BAR_CSS_CLASS}__btn-icon`;
  icon.textContent = ACTION_ICONS[kind];
  icon.setAttribute('aria-hidden', 'true');
  btn.appendChild(icon);

  const label = document.createElement('span');
  label.className = `${MESSAGE_ACTION_BAR_CSS_CLASS}__btn-label`;
  label.textContent = ACTION_LABELS[kind];
  btn.appendChild(label);

  btn.addEventListener('click', (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    handleActionClick(kind, context, callbacks);
  });

  return btn;
}

function handleActionClick(
  kind: MessageActionKind,
  context: MessageActionBarContextV1,
  callbacks: MessageActionBarCallbacksV1,
): void {
  const target = context.target;
  const descriptor = context.actionDescriptors?.[kind];

  switch (kind) {
    case 'copy':
      if (callbacks.onCopy && context.contentText) {
        // Fire-and-forget with error suppression — copy failures are
        // surfaced through the callback return value, not thrown.
        callbacks.onCopy(target, context.contentText).catch(() => {
          /* Copy failure is non-fatal; UI feedback handled by caller. */
        });
      }
      break;
    case 'expand':
      callbacks.onExpand?.(target);
      break;
    case 'source':
      callbacks.onSource?.(target);
      break;
    case 'branch':
      if (callbacks.onBranch && descriptor) {
        callbacks.onBranch(target, descriptor);
      }
      break;
    case 'edit_resend':
      if (callbacks.onEditResend && descriptor) {
        callbacks.onEditResend(target, descriptor);
      }
      break;
    case 'retry':
      if (callbacks.onRetry && descriptor) {
        callbacks.onRetry(target, descriptor);
      }
      break;
    case 'feedback':
      callbacks.onFeedback?.(target);
      break;
  }
}

function updateRovingTabindex(buttons: HTMLButtonElement[], activeIndex: number): void {
  buttons.forEach((btn, i) => {
    btn.setAttribute('tabindex', i === activeIndex ? '0' : '-1');
  });
}

// ─── DOM Rendering: Selection Action Group ──────────────────────

/**
 * Create a selection action group bound to a text selection range/digest.
 *
 * Requirement 14.3: expose authority-approved Selection_Action group bound to
 * exact Chat_Node identity, Response_Block identity, source revision, and
 * selected range or digest.
 *
 * Requirement 14.4: each selection action identifies whether it inserts a
 * typed prompt, submits a prompt, or invokes a durable authority command.
 * Prompt insertion is the default unless direct submission is explicitly
 * labeled and authorized.
 *
 * Requirement 14.6: remain operable without precise pointer input; restore
 * focus on dismissal.
 */
export function createSelectionActionGroup(
  context: SelectionActionContextV1,
  callbacks: SelectionActionCallbacksV1,
  invokingElement?: HTMLElement | null,
): SelectionActionGroupHandle {
  let disposed = false;
  let invalidated = false;
  let focusedIndex = 0;

  const group = document.createElement('div');
  group.className = SELECTION_ACTION_GROUP_CSS_CLASS;
  group.setAttribute('role', 'toolbar');
  group.setAttribute('aria-label', 'Selection actions');
  group.setAttribute('aria-orientation', 'horizontal');

  // If already streaming, start invalidated
  if (context.isStreaming) {
    invalidated = true;
    group.setAttribute('aria-disabled', 'true');
  }

  // Render selection action buttons
  context.actions.forEach((entry, index) => {
    const btn = createSelectionActionButton(entry, context.target, callbacks, invalidated);
    if (index === 0) {
      btn.setAttribute('tabindex', '0');
    } else {
      btn.setAttribute('tabindex', '-1');
    }
    group.appendChild(btn);
  });

  // Keyboard navigation
  group.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handle.dispose();
      return;
    }

    const buttons = Array.from(group.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
    if (buttons.length === 0) return;

    let handled = false;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      focusedIndex = (focusedIndex + 1) % buttons.length;
      handled = true;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      focusedIndex = (focusedIndex - 1 + buttons.length) % buttons.length;
      handled = true;
    } else if (e.key === 'Home') {
      focusedIndex = 0;
      handled = true;
    } else if (e.key === 'End') {
      focusedIndex = buttons.length - 1;
      handled = true;
    }

    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      updateRovingTabindex(buttons, focusedIndex);
      buttons[focusedIndex].focus();
    }
  });

  const handle: SelectionActionGroupHandle = {
    get element() {
      return group;
    },
    get disposed() {
      return disposed;
    },
    get invalidated() {
      return invalidated;
    },
    invalidate(reason: 'streaming' | 'projection_update') {
      if (disposed || invalidated) return;
      invalidated = true;
      group.setAttribute('aria-disabled', 'true');
      // Disable all buttons
      const buttons = group.querySelectorAll<HTMLButtonElement>('button');
      buttons.forEach((btn) => {
        btn.disabled = true;
        btn.setAttribute('aria-disabled', 'true');
      });
      // Announce invalidation reason
      const announcement = reason === 'streaming'
        ? 'Selection actions unavailable: content is streaming'
        : 'Selection actions unavailable: content has been updated';
      group.setAttribute('aria-label', announcement);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      group.remove();
      restoreFocus(invokingElement);
      callbacks.onDismiss?.();
    },
  };

  return handle;
}

function createSelectionActionButton(
  entry: SelectionActionEntryV1,
  target: ActionTargetIdentity,
  callbacks: SelectionActionCallbacksV1,
  disabled: boolean,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = `${SELECTION_ACTION_GROUP_CSS_CLASS}__btn`;
  btn.setAttribute('type', 'button');
  btn.setAttribute('data-action-id', entry.actionId);
  btn.setAttribute('data-behavior', entry.behavior);

  // Build label with behavior indicator for non-insert actions
  const behaviorSuffix = BEHAVIOR_LABELS[entry.behavior];
  const fullLabel = behaviorSuffix
    ? `${entry.label} (${behaviorSuffix})`
    : entry.label;

  btn.setAttribute('aria-label', fullLabel);
  btn.title = fullLabel;

  const labelSpan = document.createElement('span');
  labelSpan.className = `${SELECTION_ACTION_GROUP_CSS_CLASS}__btn-label`;
  labelSpan.textContent = entry.label;
  btn.appendChild(labelSpan);

  // Add explicit behavior indicator for submit/command
  if (behaviorSuffix) {
    const badge = document.createElement('span');
    badge.className = `${SELECTION_ACTION_GROUP_CSS_CLASS}__btn-badge`;
    badge.textContent = behaviorSuffix;
    badge.setAttribute('aria-hidden', 'true');
    btn.appendChild(badge);
  }

  if (disabled) {
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
  }

  btn.addEventListener('click', (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (!btn.disabled) {
      callbacks.onAction?.(entry, target);
    }
  });

  return btn;
}
