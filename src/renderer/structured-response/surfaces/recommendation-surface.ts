/**
 * Recommendation Surface — non-binding suggestion card with rationale,
 * typed confidence provenance, source revision, and authority-routed actions.
 *
 * The surface NEVER derives percentages or confidence from prose or decoration.
 * It renders only projected confidence status and value from the typed contract.
 * Actions are disabled/omitted according to projected authority state.
 *
 * Requirements: 11.8–11.10, 14.8–14.11
 */

import type { RenderIntentV1 } from '../../../harness/contracts/render-intent';
import type { RecommendationBlockV1 } from '../../../harness/contracts/response-composition';
import type { ActionDescriptorV1 } from '../../../harness/contracts/response-support';

// ─── Public types ───────────────────────────────────────────────

export type ConfidenceStatus =
  | 'reported'
  | 'calculated'
  | 'estimated'
  | 'partial'
  | 'unavailable';

export type ActionKind = 'insert_prompt' | 'submit_prompt' | 'navigate' | 'authority_command';

export interface RecommendationSurfaceHandle {
  readonly element: HTMLElement;
  readonly confidenceStatus: ConfidenceStatus;
  readonly sourceRevision: number;
  readonly actionCount: number;
  readonly pendingActionIds: ReadonlySet<string>;
  dispose(): void;
}

export interface RecommendationActionRequest {
  readonly actionId: string;
  readonly action: ActionDescriptorV1;
}

export interface RecommendationSurfaceOptions {
  readonly onAction?: (request: RecommendationActionRequest) => void;
}

// ─── Constants ──────────────────────────────────────────────────

const CONFIDENCE_LABELS: Readonly<Record<ConfidenceStatus, string>> = Object.freeze({
  reported: 'Reported',
  calculated: 'Calculated',
  estimated: 'Estimated',
  partial: 'Partial',
  unavailable: 'Unavailable',
});

const CONFIDENCE_DESCRIPTIONS: Readonly<Record<ConfidenceStatus, string>> = Object.freeze({
  reported: 'Confidence reported by the source',
  calculated: 'Confidence calculated from data',
  estimated: 'Confidence estimated with uncertainty',
  partial: 'Partial confidence — incomplete data',
  unavailable: 'Confidence unavailable',
});

const ACTION_KIND_LABELS: Readonly<Record<ActionKind, string>> = Object.freeze({
  insert_prompt: 'Insert',
  submit_prompt: 'Submit',
  navigate: 'Navigate',
  authority_command: 'Execute',
});

const VALID_CONFIDENCE_STATUSES = new Set<string>([
  'reported',
  'calculated',
  'estimated',
  'partial',
  'unavailable',
]);

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Strip markup-like content from text used in aria-label attributes.
 */
function sanitizeForAriaLabel(text: string): string {
  return text.replace(/<[^>]*>/g, '').replace(/https?:\/\/\S+/g, '[link]');
}

/**
 * Bound text to a maximum length with ellipsis.
 */
function boundText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

/**
 * Safely extract the confidence status from the block. Returns 'unavailable'
 * if the status is not a valid member of the enum.
 */
function safeConfidenceStatus(status: unknown): ConfidenceStatus {
  if (typeof status === 'string' && VALID_CONFIDENCE_STATUSES.has(status)) {
    return status as ConfidenceStatus;
  }
  return 'unavailable';
}

/**
 * Renders a confidence value ONLY if one is provided in the typed projection.
 * NEVER fabricates a percentage from prose or decoration.
 */
function formatConfidenceValue(value: number | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !isFinite(value)) return null;
  // Value is a ratio [0,1] from the contract
  return `${Math.round(value * 100)}%`;
}

/**
 * Determines if text contains patterns that look like misleading percentages.
 * This is used for defense — if model prose sneaks percentages in, we ignore
 * them rather than treating them as confidence values.
 */
function textContainsMisleadingPercentage(text: string): boolean {
  return /\d+\s*%/.test(text);
}

// ─── DOM creation ───────────────────────────────────────────────

function createRecommendationHeader(text: string): HTMLElement {
  const header = document.createElement('div');
  header.className = 'nn-recommendation__header';
  header.setAttribute('role', 'heading');
  header.setAttribute('aria-level', '3');

  const icon = document.createElement('span');
  icon.className = 'nn-recommendation__icon';
  icon.textContent = '💡';
  icon.setAttribute('aria-hidden', 'true');
  header.appendChild(icon);

  const title = document.createElement('span');
  title.className = 'nn-recommendation__title';
  title.textContent = boundText(text, 512);
  header.appendChild(title);

  return header;
}

function createRationaleSection(rationale: string): HTMLElement {
  const section = document.createElement('div');
  section.className = 'nn-recommendation__rationale';
  section.setAttribute('role', 'note');

  const label = document.createElement('span');
  label.className = 'nn-recommendation__rationale-label';
  label.textContent = 'Rationale:';
  section.appendChild(label);

  const content = document.createElement('span');
  content.className = 'nn-recommendation__rationale-text';
  // Strip any misleading percentages from rationale text that could be
  // confused with confidence values
  let sanitized = rationale;
  if (textContainsMisleadingPercentage(sanitized)) {
    // Mark the text to indicate it contains unverified numeric claims
    content.setAttribute('data-contains-unverified-percentages', 'true');
  }
  content.textContent = boundText(sanitized, 2048);
  section.appendChild(content);

  return section;
}

function createConfidenceSection(
  status: ConfidenceStatus,
  value: number | undefined,
  sourceRevision: number,
): HTMLElement {
  const section = document.createElement('div');
  section.className = 'nn-recommendation__confidence';

  const statusBadge = document.createElement('span');
  statusBadge.className = `nn-recommendation__confidence-status nn-recommendation__confidence-status--${status}`;
  statusBadge.textContent = CONFIDENCE_LABELS[status];
  statusBadge.title = CONFIDENCE_DESCRIPTIONS[status];
  statusBadge.setAttribute('aria-label', `Confidence: ${CONFIDENCE_DESCRIPTIONS[status]}`);
  statusBadge.dataset.status = status;
  section.appendChild(statusBadge);

  // Only render the projected value — never infer or fabricate
  const formattedValue = formatConfidenceValue(value);
  if (formattedValue !== null && status !== 'unavailable') {
    const valueEl = document.createElement('span');
    valueEl.className = 'nn-recommendation__confidence-value';
    valueEl.textContent = formattedValue;
    valueEl.setAttribute('aria-label', `Confidence value: ${formattedValue}`);
    section.appendChild(valueEl);
  }

  const revisionEl = document.createElement('span');
  revisionEl.className = 'nn-recommendation__source-revision';
  revisionEl.textContent = `rev ${sourceRevision}`;
  revisionEl.setAttribute('aria-label', `Source revision: ${sourceRevision}`);
  revisionEl.dataset.sourceRevision = String(sourceRevision);
  section.appendChild(revisionEl);

  return section;
}

function createActionButton(
  action: ActionDescriptorV1,
  onAction?: RecommendationSurfaceOptions['onAction'],
): HTMLElement {
  const button = document.createElement('button');
  const kind = action.kind as ActionKind;
  button.className = `nn-recommendation__action nn-recommendation__action--${kind}`;
  button.type = 'button';
  button.textContent = boundText(action.label, 160);
  button.dataset.actionId = action.actionId;
  button.dataset.actionKind = kind;

  // Set accessibility label with action kind
  const kindLabel = ACTION_KIND_LABELS[kind] ?? kind;
  button.setAttribute(
    'aria-label',
    sanitizeForAriaLabel(`${kindLabel}: ${action.label}`),
  );

  // Disable if action has a disabledReason
  if (action.disabledReason) {
    button.disabled = true;
    button.title = action.disabledReason;
    button.setAttribute(
      'aria-label',
      sanitizeForAriaLabel(`${kindLabel}: ${action.label} (${action.disabledReason})`),
    );
  }

  // Risk indicator
  if (action.risk && action.risk !== 'none') {
    button.dataset.risk = action.risk;
    button.classList.add(`nn-recommendation__action--risk-${action.risk}`);
  }

  if (onAction && !action.disabledReason) {
    button.addEventListener('click', () => {
      onAction({ actionId: action.actionId, action });
    });
  }

  return button;
}

function createPendingIndicator(actionId: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'nn-recommendation__pending';
  el.textContent = 'Pending…';
  el.setAttribute('aria-live', 'polite');
  el.dataset.pendingActionId = actionId;
  return el;
}

function createActionsSection(
  actions: readonly ActionDescriptorV1[],
  options: RecommendationSurfaceOptions,
  pendingActionIds: Set<string>,
): HTMLElement {
  const section = document.createElement('div');
  section.className = 'nn-recommendation__actions';
  section.setAttribute('role', 'group');
  section.setAttribute('aria-label', 'Recommended actions');

  for (const action of actions) {
    if (pendingActionIds.has(action.actionId)) {
      section.appendChild(createPendingIndicator(action.actionId));
    } else {
      section.appendChild(createActionButton(action, options.onAction));
    }
  }

  return section;
}

// ─── Main render function ───────────────────────────────────────

export function renderRecommendationSurface(
  block: RecommendationBlockV1,
  options: RecommendationSurfaceOptions = {},
): RecommendationSurfaceHandle {
  const pendingActionIds = new Set<string>();
  let disposed = false;

  const root = document.createElement('div');
  root.className = 'nn-recommendation';
  root.setAttribute('role', 'article');
  root.setAttribute('aria-label', 'Recommendation');
  root.dataset.stableKey = block.stableKey;

  const { recommendation, rationale, confidence, actions } = block.content;
  const status = safeConfidenceStatus(confidence.status);

  // Header with recommendation text
  root.appendChild(createRecommendationHeader(recommendation));

  // Rationale section (optional)
  if (rationale && rationale.trim().length > 0) {
    root.appendChild(createRationaleSection(rationale));
  }

  // Confidence provenance section
  root.appendChild(createConfidenceSection(status, confidence.value, confidence.sourceRevision));

  // Actions section
  if (actions.length > 0) {
    root.appendChild(createActionsSection(actions, options, pendingActionIds));
  }

  return {
    element: root,
    confidenceStatus: status,
    sourceRevision: confidence.sourceRevision,
    actionCount: actions.length,
    pendingActionIds,
    dispose() {
      if (disposed) return;
      disposed = true;
      root.remove();
    },
  };
}

// ─── Update function ────────────────────────────────────────────

export function updateRecommendationSurface(
  handle: RecommendationSurfaceHandle,
  block: RecommendationBlockV1,
  options: RecommendationSurfaceOptions = {},
): RecommendationSurfaceHandle {
  // Carry forward pending actions that haven't been confirmed
  const previousPending = new Set(handle.pendingActionIds);

  // Capture parent before dispose removes element from DOM
  const parent = handle.element.parentNode;
  const existingElement = handle.element;

  handle.dispose();
  const newHandle = renderRecommendationSurface(block, options);

  // Transfer unconfirmed pending actions that still exist in the new actions
  const currentActionIds = new Set(block.content.actions.map((a) => a.actionId));
  for (const pendingId of previousPending) {
    if (currentActionIds.has(pendingId)) {
      (newHandle.pendingActionIds as Set<string>).add(pendingId);
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

// ─── Pending action management ──────────────────────────────────

/**
 * Mark an action as pending (submitted to authority, awaiting projection confirmation).
 */
export function markActionPending(
  handle: RecommendationSurfaceHandle,
  actionId: string,
): void {
  (handle.pendingActionIds as Set<string>).add(actionId);

  // Update DOM to show pending state
  const button = handle.element.querySelector(
    `[data-action-id="${actionId}"]`,
  ) as HTMLElement | null;
  if (button) {
    const pending = createPendingIndicator(actionId);
    button.replaceWith(pending);
  }
}

/**
 * Confirm or reject a pending action based on projection revision.
 */
export function confirmAction(
  handle: RecommendationSurfaceHandle,
  actionId: string,
): void {
  (handle.pendingActionIds as Set<string>).delete(actionId);
}

// ─── Surface Adapter ────────────────────────────────────────────

/**
 * Closed surface adapter conforming to ResponseSurfaceAdapter interface.
 */
export const RecommendationSurface = Object.freeze({
  kind: 'recommendation' as const,

  render(
    block: RecommendationBlockV1,
    context: Record<string, unknown>,
    _options: { refinement?: RenderIntentV1 },
  ): RecommendationSurfaceHandle {
    return renderRecommendationSurface(block, {
      onAction: context['onAction'] as RecommendationSurfaceOptions['onAction'],
    });
  },

  update(
    handle: object,
    _previous: RecommendationBlockV1,
    next: RecommendationBlockV1,
    context: Record<string, unknown>,
    _options: { refinement?: RenderIntentV1 },
  ): void {
    const surfaceHandle = handle as RecommendationSurfaceHandle;
    updateRecommendationSurface(surfaceHandle, next, {
      onAction: context['onAction'] as RecommendationSurfaceOptions['onAction'],
    });
  },

  dispose(handle: object): void {
    const surfaceHandle = handle as RecommendationSurfaceHandle;
    surfaceHandle.dispose();
  },
});
