/**
 * Task Progress Surface — durable keyed task/workflow/subagent/job/check rows
 * with stable identity, authoritative progress or indeterminate state,
 * trajectory detail, and authority-confirmed retry/cancel.
 *
 * Each Task_Row is keyed by the durable identity of its entity. Updates
 * apply only to changed rows and the aggregate summary; DOM identity of
 * unchanged rows is preserved across updates. Logs, dependencies, and
 * trajectory details stay in bounded detail views.
 *
 * The surface renders `task_progress` blocks whose `sourceIdentity.entityId`
 * starts with `tasks:` (the Tasks Card lineage). Blocks in the `thinking:`
 * lineage belong to the Thinking Card and are handled by the
 * `ThinkingCardSurface` in `turn-status-surface.ts`.
 *
 * Requirements: 8.1–8.8, 13.1–13.4, 13.7–13.9, 16.1
 */

import type {
  ResponseCompositionV1,
  TaskProgressBlockV1,
} from '../../../harness/contracts/response-composition';
import type { ActionDescriptorV1 } from '../../../harness/contracts/response-support';
import { stripHtmlTags } from '../../../main/security/html-sanitizer';

// ─── Public types ───────────────────────────────────────────────

export type TaskState =
  | 'queued'
  | 'running'
  | 'blocked'
  | 'waiting'
  | 'failed'
  | 'cancelled'
  | 'completed';

export type TaskKind =
  | 'plan'
  | 'task'
  | 'workflow'
  | 'subagent'
  | 'job'
  | 'check'
  | 'result_injection';

export interface TaskProgressItem {
  readonly taskId: string;
  readonly taskKind: TaskKind;
  readonly title: string;
  readonly owner: string;
  readonly state: TaskState;
  readonly progress: number | undefined;
  readonly outcome: string | undefined;
}

export interface TaskProgressSurfaceHandle {
  readonly element: HTMLElement;
  readonly items: readonly TaskProgressItem[];
  readonly pendingActions: ReadonlyMap<string, PendingTaskAction>;
  /** Update the surface in place. Preserves DOM identity of rows whose
   *  `taskId` is present in both the previous and next item set. */
  update(block: TaskProgressBlockV1): void;
  dispose(): void;
}

export interface PendingTaskAction {
  readonly taskId: string;
  readonly actionKind: 'retry' | 'cancel';
  readonly commandId: string;
}

export interface TaskProgressSurfaceOptions {
  readonly onRetry?: (taskId: string, action: ActionDescriptorV1) => void;
  readonly onCancel?: (taskId: string, action: ActionDescriptorV1) => void;
  readonly onTrajectoryDetail?: (taskId: string) => void;
  readonly retryAction?: (taskId: string) => ActionDescriptorV1 | undefined;
  readonly cancelAction?: (taskId: string) => ActionDescriptorV1 | undefined;
}

// ─── Constants ──────────────────────────────────────────────────

/** Entity ID prefix that identifies the Tasks Card lineage. */
export const TASK_ROW_ENTITY_PREFIX = 'tasks:';

/** Entity ID prefix owned by the Thinking Card (see turn-status-surface.ts). */
export const THINKING_ENTITY_PREFIX = 'thinking:';

const STATE_LABELS: Readonly<Record<TaskState, string>> = Object.freeze({
  queued: 'Queued',
  running: 'Running',
  blocked: 'Blocked',
  waiting: 'Waiting',
  failed: 'Failed',
  cancelled: 'Cancelled',
  completed: 'Completed',
});

const STATE_ICONS: Readonly<Record<TaskState, string>> = Object.freeze({
  queued: '○',
  running: '◐',
  blocked: '⊗',
  waiting: '⏳',
  failed: '✗',
  cancelled: '⊘',
  completed: '●',
});

const TERMINAL_STATES = new Set<TaskState>(['failed', 'cancelled', 'completed']);
const ACTIVE_STATES = new Set<TaskState>(['running', 'blocked', 'waiting']);
const PENDING_STATES = new Set<TaskState>(['queued']);
const RETRYABLE_STATES = new Set<TaskState>(['failed']);
const CANCELLABLE_STATES = new Set<TaskState>(['queued', 'running', 'blocked', 'waiting']);

const TITLE_TEXT_LIMIT = 256;
const OUTCOME_TEXT_LIMIT = 512;
const DETAILS_TEXT_LIMIT = 4_096;

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Strip markup-like content from text used in aria-label attributes.
 */
function sanitizeForAriaLabel(text: string): string {
  return text.replace(/<[^>]*>/g, '').replace(/https?:\/\/\S+/g, '[link]');
}

/**
 * Bound inline presentation text. `textContent` provides the XSS
 * boundary; we only clamp length so long titles/outcomes never bloat
 * the DOM.
 */
function boundText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Sanitize expandable-details content: strip HTML tag remnants before
 * insertion via `textContent`. This is the defense-in-depth surface
 * required by the task specification for the details section.
 */
function sanitizeDetail(text: string, limit: number): string {
  const stripped = stripHtmlTags(text);
  if (stripped.length <= limit) return stripped;
  return `${stripped.slice(0, Math.max(0, limit - 1))}…`;
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(value)
    : value.replace(/[^\w-]/g, '\\$&');
}

// ─── Lineage identification ─────────────────────────────────────

/**
 * True if a `task_progress` block belongs to the Task Rows lineage — i.e.
 * its `sourceIdentity.entityId` starts with the `tasks:` prefix. Blocks
 * whose entity ID starts with `thinking:` (or any other future lineage)
 * are handled by the corresponding surface, not by the Task Rows.
 */
export function isTaskRowBlock(block: TaskProgressBlockV1): boolean {
  return block.sourceIdentity.entityId.startsWith(TASK_ROW_ENTITY_PREFIX);
}

/**
 * Locate the Task Rows block within a response composition, if any.
 * Returns `undefined` when no `task_progress` block belongs to the tasks
 * lineage. Thinking-lineage blocks are ignored.
 */
export function findTaskRowBlock(
  composition: ResponseCompositionV1,
): TaskProgressBlockV1 | undefined {
  for (const block of composition.blocks) {
    if (block.kind === 'task_progress' && isTaskRowBlock(block)) {
      return block;
    }
  }
  return undefined;
}

// ─── Extraction ─────────────────────────────────────────────────

/**
 * Extract task progress items from a TaskProgressBlockV1.
 */
export function extractTaskItems(block: TaskProgressBlockV1): readonly TaskProgressItem[] {
  return block.content.items.map((item) => Object.freeze({
    taskId: item.taskId,
    taskKind: item.taskKind as TaskKind,
    title: item.title,
    owner: item.owner,
    state: item.state as TaskState,
    progress: item.progress,
    outcome: item.outcome,
  }));
}

// ─── DOM construction / mutation ────────────────────────────────

function createSpan(className: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  return el;
}

function createPendingIndicator(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'nn-task-progress__pending';
  el.textContent = 'Pending…';
  el.setAttribute('aria-live', 'polite');
  return el;
}

function computeAriaLabel(item: TaskProgressItem): string {
  const safeTitle = sanitizeForAriaLabel(item.title);
  const parts = [
    STATE_LABELS[item.state],
    safeTitle,
    `Owner: ${item.owner}`,
  ];
  if (!TERMINAL_STATES.has(item.state)) {
    parts.push(
      item.progress === undefined
        ? 'Progress: indeterminate'
        : `Progress: ${Math.round(item.progress * 100)}%`,
    );
  }
  if (item.outcome && TERMINAL_STATES.has(item.state)) {
    parts.push(`Outcome: ${sanitizeForAriaLabel(item.outcome)}`);
  }
  return parts.join('. ');
}

function applyProgressElement(row: HTMLElement, item: TaskProgressItem): void {
  const existing = row.querySelector('.nn-task-progress__progress') as HTMLElement | null;
  if (TERMINAL_STATES.has(item.state)) {
    if (existing) existing.remove();
    return;
  }
  const el = existing ?? createSpan('nn-task-progress__progress');
  if (item.progress === undefined) {
    el.textContent = 'In progress';
    el.setAttribute('aria-label', 'Progress indeterminate');
    el.dataset.indeterminate = 'true';
    el.removeAttribute('aria-valuenow');
    el.removeAttribute('aria-valuemin');
    el.removeAttribute('aria-valuemax');
    el.removeAttribute('role');
  } else {
    const percent = Math.round(item.progress * 100);
    el.textContent = `${percent}%`;
    el.setAttribute('aria-label', `Progress ${percent} percent`);
    el.setAttribute('aria-valuenow', String(percent));
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', '100');
    el.setAttribute('role', 'progressbar');
    delete el.dataset.indeterminate;
  }
  if (!existing) row.appendChild(el);
}

function applyOutcomeElement(row: HTMLElement, item: TaskProgressItem): void {
  const existing = row.querySelector('.nn-task-progress__outcome') as HTMLElement | null;
  const shouldShow = item.outcome !== undefined && TERMINAL_STATES.has(item.state);
  if (!shouldShow) {
    if (existing) existing.remove();
    return;
  }
  const el = existing ?? createSpan('nn-task-progress__outcome');
  el.textContent = boundText(item.outcome ?? '', OUTCOME_TEXT_LIMIT);
  if (!existing) row.appendChild(el);
}

function applyDetailsElement(row: HTMLElement, item: TaskProgressItem): void {
  // Optional expandable details revealing the sanitized full outcome for
  // terminal rows whose outcome exceeds the inline bound.
  const previous = row.querySelector('.nn-task-progress__details') as HTMLDetailsElement | null;
  const wasOpen = previous?.open ?? false;
  const outcome = item.outcome ?? '';
  const shouldShow = TERMINAL_STATES.has(item.state) && outcome.length > OUTCOME_TEXT_LIMIT;
  if (!shouldShow) {
    if (previous) previous.remove();
    return;
  }
  const details = previous ?? document.createElement('details');
  details.className = 'nn-task-progress__details';
  details.replaceChildren();

  const summaryToggle = document.createElement('summary');
  summaryToggle.className = 'nn-task-progress__details-toggle';
  summaryToggle.textContent = 'Details';
  details.appendChild(summaryToggle);

  const body = document.createElement('div');
  body.className = 'nn-task-progress__details-body';
  body.textContent = sanitizeDetail(outcome, DETAILS_TEXT_LIMIT);
  details.appendChild(body);

  summaryToggle.addEventListener('click', (event) => {
    event.stopPropagation();
  });
  summaryToggle.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.stopPropagation();
    }
  });

  if (wasOpen) details.open = true;

  if (!previous) row.appendChild(details);
}

function applyActionsContainer(
  row: HTMLElement,
  item: TaskProgressItem,
  options: TaskProgressSurfaceOptions,
  pendingActions: Map<string, PendingTaskAction>,
): void {
  const existing = row.querySelector('.nn-task-progress__actions') as HTMLElement | null;
  const container = existing ?? document.createElement('span');
  container.className = 'nn-task-progress__actions';
  container.replaceChildren();

  const pendingAction = pendingActions.get(item.taskId);
  if (pendingAction) {
    container.appendChild(createPendingIndicator());
  } else {
    if (RETRYABLE_STATES.has(item.state)) {
      const retryDescriptor = options.retryAction?.(item.taskId);
      if (retryDescriptor) {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'nn-task-progress__action nn-task-progress__action--retry';
        retryBtn.type = 'button';
        retryBtn.dataset.actionKind = 'retry';
        retryBtn.textContent = 'Retry';
        if (retryDescriptor.disabledReason) {
          retryBtn.disabled = true;
          retryBtn.title = retryDescriptor.disabledReason;
          retryBtn.setAttribute('aria-label', `Retry (${retryDescriptor.disabledReason})`);
        }
        retryBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          options.onRetry?.(item.taskId, retryDescriptor);
        });
        container.appendChild(retryBtn);
      }
    }
    if (CANCELLABLE_STATES.has(item.state)) {
      const cancelDescriptor = options.cancelAction?.(item.taskId);
      if (cancelDescriptor) {
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'nn-task-progress__action nn-task-progress__action--cancel';
        cancelBtn.type = 'button';
        cancelBtn.dataset.actionKind = 'cancel';
        cancelBtn.textContent = 'Cancel';
        if (cancelDescriptor.disabledReason) {
          cancelBtn.disabled = true;
          cancelBtn.title = cancelDescriptor.disabledReason;
          cancelBtn.setAttribute('aria-label', `Cancel (${cancelDescriptor.disabledReason})`);
        }
        cancelBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          options.onCancel?.(item.taskId, cancelDescriptor);
        });
        container.appendChild(cancelBtn);
      }
    }
  }

  if (container.children.length > 0) {
    if (!existing) row.appendChild(container);
  } else {
    if (existing) existing.remove();
  }
}

function applyRowContent(
  row: HTMLElement,
  item: TaskProgressItem,
  options: TaskProgressSurfaceOptions,
  pendingActions: Map<string, PendingTaskAction>,
): void {
  row.dataset.taskId = item.taskId;
  row.dataset.state = item.state;
  row.dataset.taskKind = item.taskKind;
  row.dataset.lifecycle = TERMINAL_STATES.has(item.state)
    ? 'terminal'
    : PENDING_STATES.has(item.state)
      ? 'pending'
      : 'active';

  if (ACTIVE_STATES.has(item.state)) {
    row.setAttribute('aria-busy', 'true');
  } else {
    row.removeAttribute('aria-busy');
  }

  row.setAttribute('aria-label', computeAriaLabel(item));

  // Icon
  const iconEl = row.querySelector('.nn-task-progress__state-icon') as HTMLElement | null
    ?? row.appendChild(createSpan('nn-task-progress__state-icon'));
  iconEl.textContent = STATE_ICONS[item.state];
  iconEl.setAttribute('aria-hidden', 'true');

  // State label
  const stateEl = row.querySelector('.nn-task-progress__state') as HTMLElement | null
    ?? row.appendChild(createSpan('nn-task-progress__state'));
  stateEl.className = `nn-task-progress__state nn-task-progress__state--${item.state}`;
  stateEl.textContent = STATE_LABELS[item.state];

  // Title
  const titleEl = row.querySelector('.nn-task-progress__title') as HTMLElement | null
    ?? row.appendChild(createSpan('nn-task-progress__title'));
  titleEl.textContent = boundText(item.title, TITLE_TEXT_LIMIT);

  // Owner
  const ownerEl = row.querySelector('.nn-task-progress__owner') as HTMLElement | null
    ?? row.appendChild(createSpan('nn-task-progress__owner'));
  ownerEl.textContent = item.owner;

  // Progress (non-terminal)
  applyProgressElement(row, item);

  // Outcome (terminal)
  applyOutcomeElement(row, item);

  // Optional expandable details (long outcomes)
  applyDetailsElement(row, item);

  // Actions
  applyActionsContainer(row, item, options, pendingActions);

  // Ensure ordering: icon, state, title, owner, progress?, outcome?, actions?, details?
  const orderedChildren: HTMLElement[] = [iconEl, stateEl, titleEl, ownerEl];
  const progressEl = row.querySelector('.nn-task-progress__progress') as HTMLElement | null;
  if (progressEl) orderedChildren.push(progressEl);
  const outcomeEl = row.querySelector('.nn-task-progress__outcome') as HTMLElement | null;
  if (outcomeEl) orderedChildren.push(outcomeEl);
  const actionsEl = row.querySelector('.nn-task-progress__actions') as HTMLElement | null;
  if (actionsEl) orderedChildren.push(actionsEl);
  const detailsEl = row.querySelector('.nn-task-progress__details') as HTMLElement | null;
  if (detailsEl) orderedChildren.push(detailsEl);
  for (const child of orderedChildren) row.appendChild(child);
}

function createRowSkeleton(): HTMLElement {
  const row = document.createElement('div');
  row.className = 'nn-task-progress__row';
  row.setAttribute('role', 'listitem');
  row.setAttribute('tabindex', '0');
  return row;
}

function attachRowInteractionHandlers(
  row: HTMLElement,
  taskId: string,
  onTrajectoryDetail: TaskProgressSurfaceOptions['onTrajectoryDetail'],
): void {
  row.addEventListener('click', () => {
    onTrajectoryDetail?.(taskId);
  });
  row.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onTrajectoryDetail?.(taskId);
    }
  });
}

// ─── Aggregate summary ──────────────────────────────────────────

function computeSummaryText(items: readonly TaskProgressItem[]): string {
  const total = items.length;
  const completed = items.filter((i) => i.state === 'completed').length;
  const failed = items.filter((i) => i.state === 'failed').length;
  const running = items.filter((i) => ACTIVE_STATES.has(i.state)).length;

  const parts: string[] = [`${total} tasks`];
  if (completed > 0) parts.push(`${completed} completed`);
  if (running > 0) parts.push(`${running} active`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(' · ');
}

function applyGroupLabel(root: HTMLElement, groupLabel: string | undefined): void {
  const existing = root.querySelector('.nn-task-progress__group-label') as HTMLElement | null;
  if (groupLabel === undefined) {
    if (existing) existing.remove();
    return;
  }
  const el = existing ?? document.createElement('div');
  el.className = 'nn-task-progress__group-label';
  el.setAttribute('aria-hidden', 'true');
  el.textContent = boundText(groupLabel, TITLE_TEXT_LIMIT);
  if (!existing) root.prepend(el);
}

function applyAggregateSummary(root: HTMLElement, items: readonly TaskProgressItem[]): void {
  const existing = root.querySelector('.nn-task-progress__summary') as HTMLElement | null;
  const el = existing ?? document.createElement('div');
  el.className = 'nn-task-progress__summary';
  el.setAttribute('aria-live', 'polite');
  el.textContent = computeSummaryText(items);
  if (!existing) {
    // Position summary after the group label (if any) and before rows.
    const groupLabel = root.querySelector('.nn-task-progress__group-label');
    if (groupLabel && groupLabel.nextSibling) {
      root.insertBefore(el, groupLabel.nextSibling);
    } else if (groupLabel) {
      root.appendChild(el);
    } else {
      root.prepend(el);
    }
  }
}

// ─── Surface state and rendering ────────────────────────────────

interface TaskProgressInternalState {
  root: HTMLElement;
  /** taskId → row element */
  rows: Map<string, HTMLElement>;
  pendingActions: Map<string, PendingTaskAction>;
  items: readonly TaskProgressItem[];
  disposed: boolean;
  options: TaskProgressSurfaceOptions;
}

function reconcileRows(state: TaskProgressInternalState, block: TaskProgressBlockV1): void {
  const items = extractTaskItems(block);
  const newIds = new Set(items.map((i) => i.taskId));

  // Remove rows for taskIds no longer present.
  for (const [taskId, row] of state.rows) {
    if (!newIds.has(taskId)) {
      row.remove();
      state.rows.delete(taskId);
    }
  }

  // Group label and aggregate summary.
  applyGroupLabel(state.root, block.content.groupLabel);
  applyAggregateSummary(state.root, items);
  state.root.setAttribute(
    'aria-label',
    sanitizeForAriaLabel(block.content.groupLabel ?? 'Task progress'),
  );

  // Upsert rows in order.
  for (const item of items) {
    let row = state.rows.get(item.taskId);
    if (!row) {
      row = createRowSkeleton();
      state.rows.set(item.taskId, row);
      attachRowInteractionHandlers(row, item.taskId, state.options.onTrajectoryDetail);
    }
    applyRowContent(row, item, state.options, state.pendingActions);
    state.root.appendChild(row);
  }

  state.items = items;

  // Drop pending actions whose task became terminal (authority confirmed).
  for (const [taskId] of state.pendingActions) {
    const item = items.find((i) => i.taskId === taskId);
    if (!item || TERMINAL_STATES.has(item.state)) {
      state.pendingActions.delete(taskId);
      const row = state.rows.get(taskId);
      if (row) {
        applyActionsContainer(row, item ?? {
          taskId,
          taskKind: 'task',
          title: '',
          owner: '',
          state: 'completed',
          progress: undefined,
          outcome: undefined,
        }, state.options, state.pendingActions);
      }
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Render the TaskProgressSurface from a TaskProgressBlockV1.
 *
 * This is the low-level entrypoint. Callers who dispatch by lineage should
 * prefer `renderTaskRows` or `renderTaskRowsFromComposition`, which filter
 * `thinking:`-lineage blocks (owned by the Thinking Card surface).
 */
export function renderTaskProgressSurface(
  block: TaskProgressBlockV1,
  options: TaskProgressSurfaceOptions = {},
): TaskProgressSurfaceHandle {
  const root = document.createElement('div');
  root.className = 'nn-task-progress';
  root.setAttribute('role', 'list');

  const state: TaskProgressInternalState = {
    root,
    rows: new Map(),
    pendingActions: new Map(),
    items: [],
    disposed: false,
    options,
  };

  reconcileRows(state, block);

  return Object.freeze({
    element: root,
    get items() {
      return state.items;
    },
    get pendingActions() {
      return state.pendingActions as ReadonlyMap<string, PendingTaskAction>;
    },
    update(next: TaskProgressBlockV1) {
      if (state.disposed) return;
      reconcileRows(state, next);
    },
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      state.rows.clear();
      state.pendingActions.clear();
      root.remove();
      root.replaceChildren();
    },
  });
}

/**
 * Render a Task Rows surface directly from a `task_progress` block that
 * belongs to the tasks lineage. Returns `null` for blocks in another
 * lineage (e.g. the Thinking Card's `thinking:` lineage) — callers must
 * never fabricate Task Rows for other lineages.
 */
export function renderTaskRows(
  block: TaskProgressBlockV1,
  options: TaskProgressSurfaceOptions = {},
): TaskProgressSurfaceHandle | null {
  if (!isTaskRowBlock(block)) return null;
  return renderTaskProgressSurface(block, options);
}

/**
 * Scan a response composition for the Task Rows block and render it.
 * Returns `null` when the composition contains no tasks-lineage block or
 * when the block has no items. Never invents rows.
 */
export function renderTaskRowsFromComposition(
  composition: ResponseCompositionV1,
  options: TaskProgressSurfaceOptions = {},
): TaskProgressSurfaceHandle | null {
  const block = findTaskRowBlock(composition);
  if (block === undefined) return null;
  // Absence contract: never render an empty Task Rows card.
  if (block.content.items.length === 0) return null;
  return renderTaskProgressSurface(block, options);
}

/**
 * Update an existing TaskProgressSurface with new block data.
 * Preserves DOM identity of rows whose `taskId` persists between
 * updates. Focus on a persisted row is preserved by DOM identity alone.
 */
export function updateTaskProgressSurface(
  handle: TaskProgressSurfaceHandle,
  block: TaskProgressBlockV1,
  _options: TaskProgressSurfaceOptions = {},
): TaskProgressSurfaceHandle {
  handle.update(block);
  return handle;
}

/**
 * Mark a task action as pending (submitted to authority, awaiting confirmation).
 */
export function markActionPending(
  handle: TaskProgressSurfaceHandle,
  taskId: string,
  actionKind: 'retry' | 'cancel',
  commandId: string,
): void {
  (handle.pendingActions as Map<string, PendingTaskAction>).set(taskId, {
    taskId,
    actionKind,
    commandId,
  });

  // Update the DOM to show pending state
  const row = handle.element.querySelector(
    `[data-task-id="${cssEscape(taskId)}"]`,
  ) as HTMLElement | null;
  if (row) {
    const actionsContainer = row.querySelector('.nn-task-progress__actions');
    if (actionsContainer) {
      actionsContainer.replaceChildren(createPendingIndicator());
    } else {
      const container = document.createElement('span');
      container.className = 'nn-task-progress__actions';
      container.appendChild(createPendingIndicator());
      row.appendChild(container);
    }
  }
}

/**
 * Confirm or reject a pending action based on projection revision.
 */
export function confirmAction(
  handle: TaskProgressSurfaceHandle,
  taskId: string,
): void {
  (handle.pendingActions as Map<string, PendingTaskAction>).delete(taskId);
}

/**
 * Surface adapter conforming to the ResponseSurfaceRegistry pattern.
 * Renders the block through `renderTaskProgressSurface`; callers that
 * dispatch by lineage should invoke `renderTaskRows` before creating a
 * surface for a `thinking:`-lineage block.
 */
export const TaskProgressSurface = Object.freeze({
  kind: 'task_progress' as const,
  entityPrefix: TASK_ROW_ENTITY_PREFIX,

  render(
    block: TaskProgressBlockV1,
    context: Record<string, unknown>,
    _options: { refinement?: unknown },
  ): TaskProgressSurfaceHandle {
    return renderTaskProgressSurface(block, {
      onRetry: context['onRetry'] as TaskProgressSurfaceOptions['onRetry'],
      onCancel: context['onCancel'] as TaskProgressSurfaceOptions['onCancel'],
      onTrajectoryDetail: context['onTrajectoryDetail'] as TaskProgressSurfaceOptions['onTrajectoryDetail'],
      retryAction: context['retryAction'] as TaskProgressSurfaceOptions['retryAction'],
      cancelAction: context['cancelAction'] as TaskProgressSurfaceOptions['cancelAction'],
    });
  },

  update(
    handle: object,
    _previous: TaskProgressBlockV1,
    next: TaskProgressBlockV1,
    _context: Record<string, unknown>,
    _options: { refinement?: unknown },
  ): void {
    const surfaceHandle = handle as TaskProgressSurfaceHandle;
    surfaceHandle.update(next);
  },

  dispose(handle: object): void {
    const surfaceHandle = handle as TaskProgressSurfaceHandle;
    surfaceHandle.dispose();
  },
});

/** Convenience alias matching the design's `TaskRowSurface` name. */
export const TaskRowSurface = TaskProgressSurface;
