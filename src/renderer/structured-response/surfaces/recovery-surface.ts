/**
 * Recovery Surface — typed failure, retry, reconnection, interruption,
 * cancellation, stale projection, and recovery presentation.
 *
 * Renders the exact affected identity, plain-language summary, typed state,
 * affected authority, last verified state, correlation identity, retained
 * partial content, retry/reconnect metadata (attempt, limit, delay, budget,
 * route, error class), and eligible authority-approved actions.
 *
 * Numeric zero is preserved: zero retries remaining is semantically distinct
 * from undefined. Duplicate submission protection is established before any
 * non-idempotent action submission. Pending state is retained until a
 * compatible projection confirms the action. Recovery is never shown as
 * confirmed before actual authority submission and confirmation.
 *
 * Requirements: 13.1–13.12, 20.3, 22.4
 */

import type { RenderIntentV1 } from '../../../harness/contracts/render-intent';
import type { ErrorBlockV1 } from '../../../harness/contracts/response-composition';
import type { ActionDescriptorV1 } from '../../../harness/contracts/response-support';

// ─── Public Types ───────────────────────────────────────────────

export type RecoveryState =
  | 'failed'
  | 'retrying'
  | 'reconnecting'
  | 'interrupted'
  | 'cancelled'
  | 'stale';

/**
 * Retry metadata projected by the owning authority.
 * All numeric fields preserve zero — zero is a valid value
 * distinct from undefined/missing.
 */
export interface RetryMetadata {
  readonly attempt?: number;
  readonly limit?: number;
  readonly delay?: number;
  readonly budget?: number;
  readonly route?: string;
  readonly errorClass?: string;
}

export type RecoveryActionState = 'idle' | 'pending' | 'confirmed' | 'rejected';

export interface RecoveryActionEntry {
  readonly actionId: string;
  readonly action: ActionDescriptorV1;
  state: RecoveryActionState;
  idempotencyKey?: string;
}

export interface RecoverySurfaceHandle {
  readonly element: HTMLElement;
  readonly recoveryState: RecoveryState;
  readonly affectedIdentity: string;
  readonly correlationId: string;
  readonly hasPartialContent: boolean;
  readonly actionEntries: ReadonlyMap<string, RecoveryActionEntry>;
  readonly disposed: boolean;
  dispose(): void;
}

export interface RecoverySurfaceContext {
  /** Authority-approved actions eligible for this recovery card. */
  readonly actions?: readonly ActionDescriptorV1[];
  /** Retry/reconnect metadata from the projection. */
  readonly retryMetadata?: RetryMetadata;
  /** Set of action IDs with pending submissions awaiting confirmation. */
  readonly pendingActionIds?: ReadonlySet<string>;
  /** Set of action IDs confirmed by a compatible projection revision. */
  readonly confirmedActionIds?: ReadonlySet<string>;
  /** Set of action IDs rejected by the authority. */
  readonly rejectedActionIds?: ReadonlySet<string>;
  /** Callback invoked when a recovery action is activated by the user. */
  readonly onAction?: (entry: RecoveryActionEntry) => void;
}

// ─── Constants ──────────────────────────────────────────────────

export const RECOVERY_SURFACE_CSS_CLASS = 'nn-recovery-surface';

const RECOVERY_STATE_LABELS: Readonly<Record<RecoveryState, string>> = Object.freeze({
  failed: 'Failed',
  retrying: 'Retrying',
  reconnecting: 'Reconnecting',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
  stale: 'Stale',
});

const RECOVERY_STATE_ICONS: Readonly<Record<RecoveryState, string>> = Object.freeze({
  failed: '\u2717',       // ✗
  retrying: '\u21BB',     // ↻
  reconnecting: '\u21C4', // ⇄
  interrupted: '\u23F8',  // ⏸
  cancelled: '\u2298',    // ⊘
  stale: '\u26A0',        // ⚠
});

const VALID_RECOVERY_STATES = new Set<string>([
  'failed',
  'retrying',
  'reconnecting',
  'interrupted',
  'cancelled',
  'stale',
]);

const TERMINAL_RECOVERY_STATES: ReadonlySet<RecoveryState> = new Set([
  'failed',
  'cancelled',
]);

const MAX_PARTIAL_CONTENT_DISPLAY = 2048;
const MAX_SUMMARY_DISPLAY = 512;

// ─── Duplicate Submission Protection ────────────────────────────

/**
 * Track submitted non-idempotent actions. An action that lacks an
 * idempotency key MUST NOT be submitted a second time while pending
 * or after acceptance when replay is not authorized.
 *
 * Requirement 13.8: establish duplicate-submission protection before accepting
 * any non-idempotent recovery submission.
 */
const submittedNonIdempotentActions = new Map<string, { correlationId: string; state: 'pending' | 'accepted' }>();

export function isDuplicateSubmission(actionId: string, correlationId: string): boolean {
  const entry = submittedNonIdempotentActions.get(actionId);
  if (!entry) return false;
  return entry.correlationId === correlationId && (entry.state === 'pending' || entry.state === 'accepted');
}

export function registerSubmission(actionId: string, correlationId: string): void {
  submittedNonIdempotentActions.set(actionId, { correlationId, state: 'pending' });
}

export function confirmSubmission(actionId: string): void {
  const entry = submittedNonIdempotentActions.get(actionId);
  if (entry) {
    entry.state = 'accepted';
  }
}

export function clearSubmission(actionId: string): void {
  submittedNonIdempotentActions.delete(actionId);
}

/**
 * Reset all tracked submissions. Used for testing only.
 */
export function resetSubmissionTracking(): void {
  submittedNonIdempotentActions.clear();
}

// ─── Helpers ────────────────────────────────────────────────────

function safeRecoveryState(state: unknown): RecoveryState {
  if (typeof state === 'string' && VALID_RECOVERY_STATES.has(state)) {
    return state as RecoveryState;
  }
  return 'failed';
}

function boundText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '\u2026';
}

/**
 * Format a numeric value for display. Preserves zero as "0" —
 * never treats zero as falsy/missing.
 *
 * Requirement 13.4: zero budget/limit are valid and must display accurately.
 */
function formatNumericValue(value: number | undefined, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `${label}: ${value}`;
}

/**
 * Format delay in human-readable form.
 */
function formatDelay(ms: number | undefined): string | null {
  if (ms === undefined || ms === null) return null;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  if (ms === 0) return 'Delay: 0ms';
  if (ms < 1000) return `Delay: ${ms}ms`;
  return `Delay: ${(ms / 1000).toFixed(1)}s`;
}

function isActionNonIdempotent(action: ActionDescriptorV1): boolean {
  return action.idempotencyKey === undefined;
}

function resolveActionState(
  actionId: string,
  context: RecoverySurfaceContext,
): RecoveryActionState {
  if (context.confirmedActionIds?.has(actionId)) return 'confirmed';
  if (context.rejectedActionIds?.has(actionId)) return 'rejected';
  if (context.pendingActionIds?.has(actionId)) return 'pending';
  return 'idle';
}

// ─── DOM Rendering ──────────────────────────────────────────────

function createStateHeader(state: RecoveryState): HTMLElement {
  const header = document.createElement('div');
  header.className = `${RECOVERY_SURFACE_CSS_CLASS}__header`;

  const icon = document.createElement('span');
  icon.className = `${RECOVERY_SURFACE_CSS_CLASS}__state-icon`;
  icon.textContent = RECOVERY_STATE_ICONS[state];
  icon.setAttribute('aria-hidden', 'true');
  header.appendChild(icon);

  const label = document.createElement('span');
  label.className = `${RECOVERY_SURFACE_CSS_CLASS}__state-label`;
  label.textContent = RECOVERY_STATE_LABELS[state];
  label.dataset.state = state;
  header.appendChild(label);

  return header;
}

function createSummarySection(summary: string): HTMLElement {
  const el = document.createElement('p');
  el.className = `${RECOVERY_SURFACE_CSS_CLASS}__summary`;
  el.textContent = boundText(summary, MAX_SUMMARY_DISPLAY);
  return el;
}

function createIdentitySection(
  affectedIdentity: string,
  correlationId: string,
  lastVerifiedState: string,
  authority: string | undefined,
): HTMLElement {
  const section = document.createElement('dl');
  section.className = `${RECOVERY_SURFACE_CSS_CLASS}__identity`;

  const addEntry = (term: string, value: string): void => {
    const dt = document.createElement('dt');
    dt.textContent = term;
    section.appendChild(dt);
    const dd = document.createElement('dd');
    dd.textContent = value;
    section.appendChild(dd);
  };

  addEntry('Affected', affectedIdentity);
  addEntry('Last verified', lastVerifiedState);
  addEntry('Correlation', correlationId);
  if (authority) {
    addEntry('Authority', authority);
  }

  return section;
}

function createRetryMetadataSection(metadata: RetryMetadata): HTMLElement | null {
  const entries: string[] = [];

  const attempt = formatNumericValue(metadata.attempt, 'Attempt');
  if (attempt !== null) entries.push(attempt);

  const limit = formatNumericValue(metadata.limit, 'Limit');
  if (limit !== null) entries.push(limit);

  const delay = formatDelay(metadata.delay);
  if (delay !== null) entries.push(delay);

  const budget = formatNumericValue(metadata.budget, 'Budget');
  if (budget !== null) entries.push(budget);

  if (metadata.route) {
    entries.push(`Route: ${metadata.route}`);
  }

  if (metadata.errorClass) {
    entries.push(`Error class: ${metadata.errorClass}`);
  }

  if (entries.length === 0) return null;

  const section = document.createElement('div');
  section.className = `${RECOVERY_SURFACE_CSS_CLASS}__retry-metadata`;
  section.setAttribute('role', 'group');
  section.setAttribute('aria-label', 'Retry metadata');

  for (const entry of entries) {
    const span = document.createElement('span');
    span.className = `${RECOVERY_SURFACE_CSS_CLASS}__metadata-entry`;
    span.textContent = entry;
    section.appendChild(span);
  }

  return section;
}

function createPartialContentSection(content: string): HTMLElement {
  const section = document.createElement('div');
  section.className = `${RECOVERY_SURFACE_CSS_CLASS}__partial-content`;
  section.setAttribute('role', 'note');
  section.setAttribute('aria-label', 'Retained partial content');

  const label = document.createElement('span');
  label.className = `${RECOVERY_SURFACE_CSS_CLASS}__partial-label`;
  label.textContent = 'Partial content retained:';
  section.appendChild(label);

  const text = document.createElement('pre');
  text.className = `${RECOVERY_SURFACE_CSS_CLASS}__partial-text`;
  text.textContent = boundText(content, MAX_PARTIAL_CONTENT_DISPLAY);
  section.appendChild(text);

  return section;
}

function createActionButton(
  entry: RecoveryActionEntry,
  correlationId: string,
  onAction?: RecoverySurfaceContext['onAction'],
): HTMLElement {
  const container = document.createElement('span');
  container.className = `${RECOVERY_SURFACE_CSS_CLASS}__action-container`;
  container.dataset.actionId = entry.actionId;
  container.dataset.actionState = entry.state;

  if (entry.state === 'pending') {
    const pending = document.createElement('span');
    pending.className = `${RECOVERY_SURFACE_CSS_CLASS}__action-pending`;
    pending.textContent = 'Pending\u2026';
    pending.setAttribute('aria-live', 'polite');
    pending.setAttribute('aria-label', `Action ${entry.action.label}: awaiting confirmation`);
    container.appendChild(pending);
    return container;
  }

  if (entry.state === 'confirmed') {
    const confirmed = document.createElement('span');
    confirmed.className = `${RECOVERY_SURFACE_CSS_CLASS}__action-confirmed`;
    confirmed.textContent = 'Confirmed';
    confirmed.setAttribute('aria-live', 'polite');
    confirmed.setAttribute('aria-label', `Action ${entry.action.label}: confirmed`);
    container.appendChild(confirmed);
    return container;
  }

  if (entry.state === 'rejected') {
    const rejected = document.createElement('span');
    rejected.className = `${RECOVERY_SURFACE_CSS_CLASS}__action-rejected`;
    rejected.textContent = 'Rejected';
    rejected.setAttribute('aria-live', 'polite');
    rejected.setAttribute('aria-label', `Action ${entry.action.label}: rejected by authority`);
    container.appendChild(rejected);
    return container;
  }

  // idle state — render a button
  const button = document.createElement('button');
  button.className = `${RECOVERY_SURFACE_CSS_CLASS}__action-button`;
  button.type = 'button';
  button.textContent = boundText(entry.action.label, 160);
  button.dataset.actionId = entry.actionId;

  button.setAttribute(
    'aria-label',
    `Recovery action: ${entry.action.label}`,
  );

  if (entry.action.disabledReason) {
    button.disabled = true;
    button.title = entry.action.disabledReason;
    button.setAttribute(
      'aria-label',
      `Recovery action: ${entry.action.label} (${entry.action.disabledReason})`,
    );
  }

  if (entry.action.risk && entry.action.risk !== 'none') {
    button.dataset.risk = entry.action.risk;
    button.classList.add(`${RECOVERY_SURFACE_CSS_CLASS}__action-button--risk-${entry.action.risk}`);
  }

  if (onAction && !entry.action.disabledReason) {
    button.addEventListener('click', () => {
      // Duplicate protection: if action is non-idempotent and already submitted, reject
      if (isActionNonIdempotent(entry.action)) {
        if (isDuplicateSubmission(entry.actionId, correlationId)) {
          return; // Silently reject duplicate
        }
        // Register before submitting
        registerSubmission(entry.actionId, correlationId);
      }

      entry.state = 'pending';
      container.dataset.actionState = 'pending';

      // Replace button with pending indicator
      const pending = document.createElement('span');
      pending.className = `${RECOVERY_SURFACE_CSS_CLASS}__action-pending`;
      pending.textContent = 'Pending\u2026';
      pending.setAttribute('aria-live', 'polite');
      pending.setAttribute('aria-label', `Action ${entry.action.label}: awaiting confirmation`);
      button.replaceWith(pending);

      onAction(entry);
    });
  }

  container.appendChild(button);
  return container;
}

function createActionsSection(
  entries: Map<string, RecoveryActionEntry>,
  correlationId: string,
  context: RecoverySurfaceContext,
): HTMLElement | null {
  if (entries.size === 0) return null;

  const section = document.createElement('div');
  section.className = `${RECOVERY_SURFACE_CSS_CLASS}__actions`;
  section.setAttribute('role', 'group');
  section.setAttribute('aria-label', 'Recovery actions');

  for (const entry of entries.values()) {
    section.appendChild(createActionButton(entry, correlationId, context.onAction));
  }

  return section;
}

function buildAriaLabel(block: ErrorBlockV1, state: RecoveryState, metadata?: RetryMetadata): string {
  const parts: string[] = [
    `Recovery: ${RECOVERY_STATE_LABELS[state]}`,
    `Summary: ${boundText(block.content.summary, 200)}`,
    `Affected: ${block.content.affectedIdentity}`,
    `Last verified: ${block.content.lastVerifiedState}`,
  ];

  if (metadata) {
    if (metadata.attempt !== undefined) parts.push(`Attempt: ${metadata.attempt}`);
    if (metadata.limit !== undefined) parts.push(`Limit: ${metadata.limit}`);
    if (metadata.budget !== undefined) parts.push(`Budget: ${metadata.budget}`);
    if (metadata.errorClass) parts.push(`Error class: ${metadata.errorClass}`);
  }

  if (block.content.partialContent) {
    parts.push('Partial content retained');
  }

  return parts.join('. ');
}

// ─── Surface Render ─────────────────────────────────────────────

/**
 * Render a RecoverySurface card for a typed error/recovery block.
 *
 * - Renders affected identity, summary, typed state, authority,
 *   last verified state, correlation, partial content, retry/reconnect metadata
 * - Preserves numeric zero for attempt/limit/delay/budget
 * - Establishes duplicate protection before non-idempotent submission
 * - Retains pending until compatible projection confirmation
 * - Never shows recovery confirmed before submission/confirmation
 *
 * Requirements: 13.1–13.12, 20.3, 22.4
 */
export function renderRecoverySurface(
  block: ErrorBlockV1,
  context: RecoverySurfaceContext = {},
): RecoverySurfaceHandle {
  const state = safeRecoveryState(block.content.recoveryState);
  const metadata = context.retryMetadata;
  const actions = context.actions ?? [];

  // Build action entries from provided actions
  const actionEntries = new Map<string, RecoveryActionEntry>();
  for (const action of actions) {
    const actionState = resolveActionState(action.actionId, context);
    actionEntries.set(action.actionId, {
      actionId: action.actionId,
      action,
      state: actionState,
    });
  }

  const root = document.createElement('article');
  root.className = RECOVERY_SURFACE_CSS_CLASS;
  root.setAttribute('role', 'alert');
  root.setAttribute('aria-live', 'assertive');
  root.dataset.stableKey = block.stableKey;
  root.dataset.recoveryState = state;
  root.dataset.correlationId = block.content.correlationId;
  root.dataset.affectedIdentity = block.content.affectedIdentity;
  root.setAttribute('aria-label', buildAriaLabel(block, state, metadata));

  // Header with state icon and label
  root.appendChild(createStateHeader(state));

  // Summary
  root.appendChild(createSummarySection(block.content.summary));

  // Identity details
  const authorityLabel = block.authority
    ? `${block.authority.authorityKind}/${block.authority.authorityId}`
    : undefined;
  root.appendChild(createIdentitySection(
    block.content.affectedIdentity,
    block.content.correlationId,
    block.content.lastVerifiedState,
    authorityLabel,
  ));

  // Retry/reconnect metadata
  if (metadata) {
    const metadataSection = createRetryMetadataSection(metadata);
    if (metadataSection) {
      root.appendChild(metadataSection);
    }
  }

  // Partial content
  if (block.content.partialContent && block.content.partialContent.trim().length > 0) {
    root.appendChild(createPartialContentSection(block.content.partialContent));
  }

  // Actions — only authority-approved actions
  const actionsSection = createActionsSection(actionEntries, block.content.correlationId, context);
  if (actionsSection) {
    root.appendChild(actionsSection);
  }

  let disposed = false;

  const handle: RecoverySurfaceHandle = {
    get element() { return root; },
    get recoveryState() { return state; },
    get affectedIdentity() { return block.content.affectedIdentity; },
    get correlationId() { return block.content.correlationId; },
    get hasPartialContent() { return !!(block.content.partialContent && block.content.partialContent.trim().length > 0); },
    get actionEntries() { return actionEntries; },
    get disposed() { return disposed; },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.remove();
      root.replaceChildren();
    },
  };

  return handle;
}

// ─── Update ─────────────────────────────────────────────────────

/**
 * Update an existing RecoverySurface with new block data.
 * Preserves pending state and duplicate-protection invariants.
 */
export function updateRecoverySurface(
  handle: RecoverySurfaceHandle,
  block: ErrorBlockV1,
  context: RecoverySurfaceContext = {},
): RecoverySurfaceHandle {
  if (handle.disposed) return handle;

  // Carry forward pending actions not yet confirmed by projection
  const updatedContext = { ...context };
  const pendingFromPrev = new Set<string>(context.pendingActionIds ?? []);
  for (const [actionId, entry] of handle.actionEntries) {
    if (entry.state === 'pending' && !context.confirmedActionIds?.has(actionId) && !context.rejectedActionIds?.has(actionId)) {
      pendingFromPrev.add(actionId);
    }
  }
  (updatedContext as { pendingActionIds: ReadonlySet<string> }).pendingActionIds = pendingFromPrev;

  const parent = handle.element.parentNode;
  const nextSibling = handle.element.nextSibling;
  handle.dispose();

  const newHandle = renderRecoverySurface(block, updatedContext);

  if (parent) {
    if (nextSibling) {
      parent.insertBefore(newHandle.element, nextSibling);
    } else {
      parent.appendChild(newHandle.element);
    }
  }

  return newHandle;
}

// ─── Action State Management ────────────────────────────────────

/**
 * Mark a recovery action as pending (submitted, awaiting projection confirmation).
 * Requirement 13.11: remain pending until compatible projection confirmation.
 */
export function markRecoveryActionPending(
  handle: RecoverySurfaceHandle,
  actionId: string,
): void {
  const entry = handle.actionEntries.get(actionId);
  if (!entry || entry.state !== 'idle') return;
  entry.state = 'pending';

  const container = handle.element.querySelector(
    `[data-action-id="${actionId}"]`,
  ) as HTMLElement | null;
  if (container) {
    container.dataset.actionState = 'pending';
    const button = container.querySelector('button');
    if (button) {
      const pending = document.createElement('span');
      pending.className = `${RECOVERY_SURFACE_CSS_CLASS}__action-pending`;
      pending.textContent = 'Pending\u2026';
      pending.setAttribute('aria-live', 'polite');
      pending.setAttribute('aria-label', `Action ${entry.action.label}: awaiting confirmation`);
      button.replaceWith(pending);
    }
  }
}

/**
 * Confirm a recovery action based on compatible projection revision.
 * Requirement 13.9: require compatible projection confirmation before
 * presenting any recovery action as confirmed.
 */
export function confirmRecoveryAction(
  handle: RecoverySurfaceHandle,
  actionId: string,
): void {
  const entry = handle.actionEntries.get(actionId);
  if (!entry || entry.state !== 'pending') return;
  entry.state = 'confirmed';
  confirmSubmission(actionId);

  const container = handle.element.querySelector(
    `[data-action-id="${actionId}"]`,
  ) as HTMLElement | null;
  if (container) {
    container.dataset.actionState = 'confirmed';
    const pendingEl = container.querySelector(`.${RECOVERY_SURFACE_CSS_CLASS}__action-pending`);
    if (pendingEl) {
      const confirmed = document.createElement('span');
      confirmed.className = `${RECOVERY_SURFACE_CSS_CLASS}__action-confirmed`;
      confirmed.textContent = 'Confirmed';
      confirmed.setAttribute('aria-live', 'polite');
      confirmed.setAttribute('aria-label', `Action ${entry.action.label}: confirmed`);
      pendingEl.replaceWith(confirmed);
    }
  }
}

/**
 * Reject a recovery action based on authority rejection.
 */
export function rejectRecoveryAction(
  handle: RecoverySurfaceHandle,
  actionId: string,
): void {
  const entry = handle.actionEntries.get(actionId);
  if (!entry || entry.state !== 'pending') return;
  entry.state = 'rejected';
  clearSubmission(actionId);

  const container = handle.element.querySelector(
    `[data-action-id="${actionId}"]`,
  ) as HTMLElement | null;
  if (container) {
    container.dataset.actionState = 'rejected';
    const pendingEl = container.querySelector(`.${RECOVERY_SURFACE_CSS_CLASS}__action-pending`);
    if (pendingEl) {
      const rejected = document.createElement('span');
      rejected.className = `${RECOVERY_SURFACE_CSS_CLASS}__action-rejected`;
      rejected.textContent = 'Rejected';
      rejected.setAttribute('aria-live', 'polite');
      rejected.setAttribute('aria-label', `Action ${entry.action.label}: rejected by authority`);
      pendingEl.replaceWith(rejected);
    }
  }
}

// ─── Surface Adapter ────────────────────────────────────────────

/**
 * Closed surface adapter conforming to ResponseSurfaceAdapter<'error'>.
 *
 * The adapter renders recovery-focused surfaces for error blocks with recovery
 * states. It enforces duplicate protection, pending-until-confirmation semantics,
 * and preserves numeric zero in retry metadata.
 *
 * Requirement 13.1: render Recovery_Card for typed failure/retry/interruption/
 *   cancellation/stale/reconnect.
 * Requirement 13.8: duplicate-submission protection before non-idempotent action.
 * Requirement 13.9: no confirmed state before compatible projection confirmation.
 * Requirement 13.10: no confirmed state before first submission.
 * Requirement 13.11: pending until compatible projection confirmation.
 */
export const RecoverySurface = Object.freeze({
  kind: 'error' as const,

  render(
    block: ErrorBlockV1,
    context: Record<string, unknown>,
    _options: { refinement?: RenderIntentV1 },
  ): RecoverySurfaceHandle {
    const surfaceContext = extractRecoveryContext(context);
    return renderRecoverySurface(block, surfaceContext);
  },

  update(
    handle: object,
    _previous: ErrorBlockV1,
    next: ErrorBlockV1,
    context: Record<string, unknown>,
    _options: { refinement?: RenderIntentV1 },
  ): RecoverySurfaceHandle {
    const surfaceHandle = handle as RecoverySurfaceHandle;
    const surfaceContext = extractRecoveryContext(context);
    return updateRecoverySurface(surfaceHandle, next, surfaceContext);
  },

  dispose(handle: object): void {
    const surfaceHandle = handle as RecoverySurfaceHandle;
    surfaceHandle.dispose();
  },
});

// ─── Context Extraction ─────────────────────────────────────────

function extractRecoveryContext(context: Record<string, unknown>): RecoverySurfaceContext {
  const result: RecoverySurfaceContext = {};

  if (Array.isArray(context['actions'])) {
    (result as { actions: readonly ActionDescriptorV1[] }).actions =
      context['actions'] as readonly ActionDescriptorV1[];
  }

  if (context['retryMetadata'] && typeof context['retryMetadata'] === 'object') {
    (result as { retryMetadata: RetryMetadata }).retryMetadata =
      context['retryMetadata'] as RetryMetadata;
  }

  if (context['pendingActionIds'] instanceof Set) {
    (result as { pendingActionIds: ReadonlySet<string> }).pendingActionIds =
      context['pendingActionIds'] as ReadonlySet<string>;
  }

  if (context['confirmedActionIds'] instanceof Set) {
    (result as { confirmedActionIds: ReadonlySet<string> }).confirmedActionIds =
      context['confirmedActionIds'] as ReadonlySet<string>;
  }

  if (context['rejectedActionIds'] instanceof Set) {
    (result as { rejectedActionIds: ReadonlySet<string> }).rejectedActionIds =
      context['rejectedActionIds'] as ReadonlySet<string>;
  }

  if (typeof context['onAction'] === 'function') {
    (result as { onAction: RecoverySurfaceContext['onAction'] }).onAction =
      context['onAction'] as RecoverySurfaceContext['onAction'];
  }

  return result;
}
