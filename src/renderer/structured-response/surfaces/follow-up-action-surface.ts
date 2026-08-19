/**
 * Follow-Up Action Surface
 *
 * Renders exactly one follow-up action group when enabled and an eligible
 * completed revision has between 2 and 4 valid projected actions. Distinguishes
 * prompt insertion, prompt submission, navigation, and authority command.
 *
 * - Omits dismissed or stale actions unless policy requires a disabled reason.
 * - Preserves authority-disabled reasons for actions that remain visible.
 * - Prevents duplicate durable (non-idempotent) submission via idempotency keys.
 * - Integrates with existing Suggested Responses without rendering a second group.
 *
 * Requirements: 14.7–14.12, 21.11, 22.2
 */

import type { RenderIntentV1 } from '../../../harness/contracts/render-intent';
import type { FollowUpActionsBlockV1 } from '../../../harness/contracts/response-composition';
import type { ActionDescriptorV1 } from '../../../harness/contracts/response-support';

// ─── Public types ───────────────────────────────────────────────

export type FollowUpActionKind = 'insert_prompt' | 'submit_prompt' | 'navigate' | 'authority_command';

export type FollowUpActionState = 'idle' | 'pending' | 'confirmed' | 'rejected';

export interface FollowUpActionRequest {
  readonly actionId: string;
  readonly kind: FollowUpActionKind;
  readonly action: ActionDescriptorV1;
}

export interface FollowUpActionSurfaceHandle {
  readonly element: HTMLElement;
  readonly actionCount: number;
  readonly visibleActionIds: readonly string[];
  readonly pendingActionIds: ReadonlySet<string>;
  readonly confirmedActionIds: ReadonlySet<string>;
  readonly sourceRevision: number;
  readonly enabled: boolean;
  dispose(): void;
}

export interface FollowUpActionSurfaceOptions {
  /** Whether the follow-up action group is enabled for display. */
  readonly enabled?: boolean;
  /** Called when a user activates a follow-up action. */
  readonly onAction?: (request: FollowUpActionRequest) => void;
  /** Set of action IDs that have been dismissed by the user. */
  readonly dismissedActionIds?: ReadonlySet<string>;
  /** Set of action IDs that are stale (no longer valid for current session revision). */
  readonly staleActionIds?: ReadonlySet<string>;
  /** Whether policy requires stale/dismissed actions to remain visible (disabled with reason). */
  readonly policyRequiresDisabledReason?: boolean;
  /** Set of existing legacy suggestion IDs to avoid duplicate groups. */
  readonly existingSuggestionIds?: ReadonlySet<string>;
  /** Set of idempotency keys currently pending (for duplicate submission prevention). */
  readonly pendingIdempotencyKeys?: ReadonlySet<string>;
}

// ─── Constants ──────────────────────────────────────────────────

export const MIN_FOLLOW_UP_ACTIONS = 2;
export const MAX_FOLLOW_UP_ACTIONS = 4;

const ACTION_KIND_LABELS: Readonly<Record<FollowUpActionKind, string>> = Object.freeze({
  insert_prompt: 'Insert',
  submit_prompt: 'Send',
  navigate: 'Open',
  authority_command: 'Run',
});

const ACTION_KIND_DESCRIPTIONS: Readonly<Record<FollowUpActionKind, string>> = Object.freeze({
  insert_prompt: 'Inserts text into the composer without sending',
  submit_prompt: 'Sends this prompt immediately',
  navigate: 'Opens a location or resource',
  authority_command: 'Executes an authority command',
});

const VALID_ACTION_KINDS = new Set<string>([
  'insert_prompt',
  'submit_prompt',
  'navigate',
  'authority_command',
]);

const CSS_PREFIX = 'nn-follow-up-actions';

// ─── Helpers ────────────────────────────────────────────────────

function isValidActionKind(kind: string): kind is FollowUpActionKind {
  return VALID_ACTION_KINDS.has(kind);
}

function sanitizeLabel(text: string): string {
  return text.replace(/<[^>]*>/g, '').replace(/https?:\/\/\S+/g, '[link]');
}

function boundLabel(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '\u2026';
}

/**
 * Filter actions to only those that should be rendered.
 * Dismissed and stale actions are omitted unless policy requires a disabled reason.
 */
function filterVisibleActions(
  actions: readonly ActionDescriptorV1[],
  options: FollowUpActionSurfaceOptions,
): readonly ActionDescriptorV1[] {
  const dismissed = options.dismissedActionIds ?? new Set();
  const stale = options.staleActionIds ?? new Set();

  return actions.filter((action) => {
    const isDismissed = dismissed.has(action.actionId);
    const isStale = stale.has(action.actionId);

    if (isDismissed || isStale) {
      // Keep visible only if policy requires disabled reason to remain
      return options.policyRequiresDisabledReason === true;
    }
    return true;
  });
}

/**
 * Determines whether the group should render at all.
 * Requires enabled=true and between 2-4 valid actions after filtering.
 */
function shouldRenderGroup(
  validActions: readonly ActionDescriptorV1[],
  options: FollowUpActionSurfaceOptions,
): boolean {
  if (options.enabled === false) return false;
  const count = validActions.length;
  return count >= MIN_FOLLOW_UP_ACTIONS && count <= MAX_FOLLOW_UP_ACTIONS;
}

/**
 * Determines if an action represents a duplicate submission that should be prevented.
 */
function isDuplicateDurableSubmission(
  action: ActionDescriptorV1,
  pendingIdempotencyKeys: ReadonlySet<string> | undefined,
): boolean {
  if (!pendingIdempotencyKeys || !action.idempotencyKey) return false;
  return pendingIdempotencyKeys.has(action.idempotencyKey);
}

/**
 * Determines the effective disabled reason for an action, considering
 * authority-disabled state, staleness, and dismissal policy.
 */
function getEffectiveDisabledReason(
  action: ActionDescriptorV1,
  options: FollowUpActionSurfaceOptions,
): string | undefined {
  // Authority-disabled reasons always take precedence
  if (action.disabledReason) return action.disabledReason;

  const dismissed = options.dismissedActionIds ?? new Set();
  const stale = options.staleActionIds ?? new Set();

  if (dismissed.has(action.actionId) && options.policyRequiresDisabledReason) {
    return 'Action dismissed';
  }
  if (stale.has(action.actionId) && options.policyRequiresDisabledReason) {
    return 'Action no longer available for this session';
  }

  return undefined;
}

// ─── DOM creation ───────────────────────────────────────────────

function createActionButton(
  action: ActionDescriptorV1,
  options: FollowUpActionSurfaceOptions,
): HTMLElement {
  const button = document.createElement('button');
  const kind = isValidActionKind(action.kind) ? action.kind : 'insert_prompt';
  button.className = `${CSS_PREFIX}__action ${CSS_PREFIX}__action--${kind}`;
  button.type = 'button';
  button.dataset.actionId = action.actionId;
  button.dataset.actionKind = kind;

  // Label content
  const labelText = boundLabel(action.label, 160);
  button.textContent = labelText;

  // Accessibility: distinguish kind in the label
  const kindLabel = ACTION_KIND_LABELS[kind];
  const kindDescription = ACTION_KIND_DESCRIPTIONS[kind];
  button.setAttribute(
    'aria-label',
    sanitizeLabel(`${kindLabel}: ${action.label}`),
  );
  button.title = kindDescription;

  // Add kind badge for visual distinction (non-color indicator)
  const badge = document.createElement('span');
  badge.className = `${CSS_PREFIX}__kind-badge`;
  badge.textContent = kindLabel;
  badge.setAttribute('aria-hidden', 'true');
  button.prepend(badge);

  // Handle disabled state
  const disabledReason = getEffectiveDisabledReason(action, options);
  if (disabledReason) {
    button.disabled = true;
    button.title = disabledReason;
    button.setAttribute(
      'aria-label',
      sanitizeLabel(`${kindLabel}: ${action.label} (${disabledReason})`),
    );
  }

  // Handle duplicate durable submission prevention
  if (isDuplicateDurableSubmission(action, options.pendingIdempotencyKeys)) {
    button.disabled = true;
    button.dataset.duplicatePrevented = 'true';
    button.title = 'Submission already in progress';
    button.setAttribute(
      'aria-label',
      sanitizeLabel(`${kindLabel}: ${action.label} (submission already in progress)`),
    );
  }

  // Click handler (only when enabled)
  if (!button.disabled && options.onAction) {
    button.addEventListener('click', () => {
      options.onAction!({
        actionId: action.actionId,
        kind,
        action,
      });
    });
  }

  return button;
}

function createPendingIndicator(actionId: string): HTMLElement {
  const el = document.createElement('span');
  el.className = `${CSS_PREFIX}__pending`;
  el.textContent = 'Pending\u2026';
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('role', 'status');
  el.dataset.pendingActionId = actionId;
  return el;
}

function createEmptyPlaceholder(): HTMLElement {
  const el = document.createElement('div');
  el.className = `${CSS_PREFIX}--empty`;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

// ─── Main render function ───────────────────────────────────────

/**
 * Renders the follow-up action group.
 *
 * Returns a handle with an empty non-visible element if:
 * - The surface is not enabled
 * - Fewer than 2 or more than 4 valid actions exist after filtering
 * - Integration with existing suggestions would create a duplicate group
 */
export function renderFollowUpActionSurface(
  block: FollowUpActionsBlockV1,
  options: FollowUpActionSurfaceOptions = {},
): FollowUpActionSurfaceHandle {
  const pendingActionIds = new Set<string>();
  const confirmedActionIds = new Set<string>();
  let disposed = false;

  const root = document.createElement('div');
  root.dataset.stableKey = block.stableKey;

  // Filter to visible actions
  const visibleActions = filterVisibleActions(block.content.actions, options);

  // Check if existing suggestion group would cause duplication (Req 14.12)
  const existingSuggestions = options.existingSuggestionIds ?? new Set();
  const hasDuplicateSuggestions = visibleActions.some(
    (a) => existingSuggestions.has(a.actionId),
  );

  // Determine if we should render
  const shouldRender = shouldRenderGroup(visibleActions, options) && !hasDuplicateSuggestions;

  if (!shouldRender) {
    // Return an empty hidden element
    root.className = `${CSS_PREFIX} ${CSS_PREFIX}--hidden`;
    root.setAttribute('aria-hidden', 'true');
    root.appendChild(createEmptyPlaceholder());

    return {
      element: root,
      actionCount: 0,
      visibleActionIds: [],
      pendingActionIds,
      confirmedActionIds,
      sourceRevision: block.content.sourceRevision,
      enabled: false,
      dispose() {
        if (disposed) return;
        disposed = true;
        root.remove();
      },
    };
  }

  // Render the visible group
  root.className = CSS_PREFIX;
  root.setAttribute('role', 'toolbar');
  root.setAttribute('aria-label', 'Follow-up actions');

  // Cap at MAX_FOLLOW_UP_ACTIONS
  const cappedActions = visibleActions.slice(0, MAX_FOLLOW_UP_ACTIONS);

  for (const action of cappedActions) {
    if (pendingActionIds.has(action.actionId)) {
      root.appendChild(createPendingIndicator(action.actionId));
    } else {
      root.appendChild(createActionButton(action, options));
    }
  }

  const visibleActionIds = cappedActions.map((a) => a.actionId);

  return {
    element: root,
    actionCount: cappedActions.length,
    visibleActionIds,
    pendingActionIds,
    confirmedActionIds,
    sourceRevision: block.content.sourceRevision,
    enabled: true,
    dispose() {
      if (disposed) return;
      disposed = true;
      root.remove();
    },
  };
}

// ─── Update function ────────────────────────────────────────────

/**
 * Re-renders the follow-up action surface with a new block, carrying forward
 * pending state for actions that still exist.
 */
export function updateFollowUpActionSurface(
  handle: FollowUpActionSurfaceHandle,
  block: FollowUpActionsBlockV1,
  options: FollowUpActionSurfaceOptions = {},
): FollowUpActionSurfaceHandle {
  const previousPending = new Set(handle.pendingActionIds);
  const previousConfirmed = new Set(handle.confirmedActionIds);

  const parent = handle.element.parentNode;
  const existingElement = handle.element;

  handle.dispose();
  const newHandle = renderFollowUpActionSurface(block, options);

  // Transfer pending/confirmed state for surviving actions
  const currentActionIds = new Set(block.content.actions.map((a) => a.actionId));
  for (const pendingId of previousPending) {
    if (currentActionIds.has(pendingId)) {
      (newHandle.pendingActionIds as Set<string>).add(pendingId);
    }
  }
  for (const confirmedId of previousConfirmed) {
    if (currentActionIds.has(confirmedId)) {
      (newHandle.confirmedActionIds as Set<string>).add(confirmedId);
    }
  }

  // Replace element in parent if still attached
  if (parent && parent.contains(existingElement)) {
    parent.replaceChild(newHandle.element, existingElement);
  } else if (parent) {
    parent.appendChild(newHandle.element);
  }

  return newHandle;
}

// ─── Action state management ────────────────────────────────────

/**
 * Mark an action as pending (submitted to authority, awaiting confirmation).
 */
export function markFollowUpActionPending(
  handle: FollowUpActionSurfaceHandle,
  actionId: string,
): void {
  (handle.pendingActionIds as Set<string>).add(actionId);

  const button = handle.element.querySelector(
    `[data-action-id="${actionId}"]`,
  ) as HTMLElement | null;
  if (button) {
    const pending = createPendingIndicator(actionId);
    button.replaceWith(pending);
  }
}

/**
 * Confirm a pending action based on compatible projection revision.
 */
export function confirmFollowUpAction(
  handle: FollowUpActionSurfaceHandle,
  actionId: string,
): void {
  (handle.pendingActionIds as Set<string>).delete(actionId);
  (handle.confirmedActionIds as Set<string>).add(actionId);
}

// ─── Surface Adapter ────────────────────────────────────────────

/**
 * Closed surface adapter conforming to ResponseSurfaceAdapter interface.
 */
export const FollowUpActionSurface = Object.freeze({
  kind: 'follow_up_actions' as const,

  render(
    block: FollowUpActionsBlockV1,
    context: Record<string, unknown>,
    _options: { refinement?: RenderIntentV1 },
  ): FollowUpActionSurfaceHandle {
    return renderFollowUpActionSurface(block, {
      enabled: context['followUpEnabled'] as boolean | undefined,
      onAction: context['onAction'] as FollowUpActionSurfaceOptions['onAction'],
      dismissedActionIds: context['dismissedActionIds'] as ReadonlySet<string> | undefined,
      staleActionIds: context['staleActionIds'] as ReadonlySet<string> | undefined,
      policyRequiresDisabledReason: context['policyRequiresDisabledReason'] as boolean | undefined,
      existingSuggestionIds: context['existingSuggestionIds'] as ReadonlySet<string> | undefined,
      pendingIdempotencyKeys: context['pendingIdempotencyKeys'] as ReadonlySet<string> | undefined,
    });
  },

  update(
    handle: object,
    _previous: FollowUpActionsBlockV1,
    next: FollowUpActionsBlockV1,
    context: Record<string, unknown>,
    _options: { refinement?: RenderIntentV1 },
  ): void {
    const surfaceHandle = handle as FollowUpActionSurfaceHandle;
    updateFollowUpActionSurface(surfaceHandle, next, {
      enabled: context['followUpEnabled'] as boolean | undefined,
      onAction: context['onAction'] as FollowUpActionSurfaceOptions['onAction'],
      dismissedActionIds: context['dismissedActionIds'] as ReadonlySet<string> | undefined,
      staleActionIds: context['staleActionIds'] as ReadonlySet<string> | undefined,
      policyRequiresDisabledReason: context['policyRequiresDisabledReason'] as boolean | undefined,
      existingSuggestionIds: context['existingSuggestionIds'] as ReadonlySet<string> | undefined,
      pendingIdempotencyKeys: context['pendingIdempotencyKeys'] as ReadonlySet<string> | undefined,
    });
  },

  dispose(handle: object): void {
    const surfaceHandle = handle as FollowUpActionSurfaceHandle;
    surfaceHandle.dispose();
  },
});
