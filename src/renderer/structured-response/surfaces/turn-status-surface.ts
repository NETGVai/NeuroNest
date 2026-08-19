/**
 * TurnStatusSurface — singular, keyed lifecycle surface per turn.
 *
 * Renders exactly one status element for queued, reasoning, tool_running,
 * streaming, waiting_for_user, retrying, cancelling, cancelled, interrupted,
 * completed, failed, and reconnecting states. Updates in place. Derives
 * elapsed time only when both settings enable it AND authority timestamps
 * exist. Freezes duration at terminalAt. Shows exact non-success outcomes and
 * authority-routed stop/cancel eligibility and unavailable reason.
 *
 * This module also exports the Thinking Card renderer, which reads the
 * canonical `task_progress` block whose `sourceIdentity.entityId` starts with
 * `thinking:`. The Thinking Card shows ordered live progress steps, each with
 * a non-color state indicator, label, and an elapsed timer that ticks while
 * the step is `running` and freezes on transition to a terminal state. When
 * a composition contains no thinking block, the Thinking Card renders nothing.
 * The surface never fabricates steps and never infers or exposes hidden
 * chain-of-thought — only what the projection explicitly emits.
 *
 * Requirements: 4.1–4.7, 4.11–4.12, 11.1–11.9, 13.3–13.5
 *
 * @vitest-environment jsdom
 */

import { z } from 'zod';
import {
  TurnStatusBlockV1Schema,
  type ResponseCompositionV1,
  type TaskProgressBlockV1,
} from '../../../harness/contracts/response-composition';

// ─── Types ──────────────────────────────────────────────────────

export type TurnActivityState =
  | 'queued'
  | 'reasoning'
  | 'tool_running'
  | 'streaming'
  | 'waiting_for_user'
  | 'retrying'
  | 'cancelling'
  | 'cancelled'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'reconnecting';

export const TERMINAL_STATES: ReadonlySet<TurnActivityState> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

export const NON_SUCCESS_TERMINAL_STATES: ReadonlySet<TurnActivityState> = new Set([
  'failed',
  'cancelled',
  'interrupted',
]);

export type TurnStatusBlockV1 = z.infer<typeof TurnStatusBlockV1Schema>;

export interface TurnStatusSurfaceConfig {
  /** Whether elapsed-time display is enabled in settings */
  readonly elapsedTimeEnabled: boolean;
  /** Interval for timer updates in ms (default 1000) */
  readonly timerIntervalMs?: number;
}

export interface CancelAction {
  readonly available: boolean;
  readonly unavailableReason?: string;
}

export interface TurnStatusSurfaceHandle {
  readonly element: HTMLElement;
  readonly stableKey: string;
  readonly state: TurnActivityState;
  readonly elapsedMs: number | null;
  readonly timerActive: boolean;
  readonly cancelAction: CancelAction | null;
  update(block: TurnStatusBlockV1, config: TurnStatusSurfaceConfig): void;
  dispose(): void;
}

// ─── Constants ──────────────────────────────────────────────────

export const TURN_STATUS_CSS_CLASS = 'nn-turn-status-surface';
export const DEFAULT_TIMER_INTERVAL_MS = 1000;

const STATE_LABELS: Readonly<Record<TurnActivityState, string>> = Object.freeze({
  queued: 'Queued',
  reasoning: 'Reasoning',
  tool_running: 'Running tools',
  streaming: 'Streaming',
  waiting_for_user: 'Waiting for you',
  retrying: 'Retrying',
  cancelling: 'Cancelling',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
  completed: 'Completed',
  failed: 'Failed',
  reconnecting: 'Reconnecting',
});

const STATE_SYMBOLS: Readonly<Record<TurnActivityState, string>> = Object.freeze({
  queued: '\u25CB', // ○
  reasoning: '\u2026', // …
  tool_running: '\u2699', // ⚙
  streaming: '\u25B6', // ▶
  waiting_for_user: '\u270B', // ✋
  retrying: '\u21BA', // ↺
  cancelling: '\u2718', // ✘
  cancelled: '\u2014', // —
  interrupted: '\u26A0', // ⚠
  completed: '\u2713', // ✓
  failed: '\u2717', // ✗
  reconnecting: '\u21C4', // ⇄
});

// ─── Timer Utility ──────────────────────────────────────────────

function computeElapsedMs(startedAt: string | undefined, terminalAt: string | undefined, now: number): number | null {
  if (!startedAt) return null;

  const startMs = new Date(startedAt).getTime();
  if (Number.isNaN(startMs)) return null;

  if (terminalAt) {
    const terminalMs = new Date(terminalAt).getTime();
    if (!Number.isNaN(terminalMs)) {
      return Math.max(0, terminalMs - startMs);
    }
  }

  return Math.max(0, now - startMs);
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function isTimerEligible(
  config: TurnStatusSurfaceConfig,
  startedAt: string | undefined,
  terminalAt: string | undefined,
  state: TurnActivityState,
): boolean {
  // Timer is eligible only when:
  // 1. Settings enable elapsed-time display
  // 2. An authority-derived start time exists
  // 3. The turn is non-terminal (or we show final frozen time)
  if (!config.elapsedTimeEnabled) return false;
  if (!startedAt) return false;
  // Timer is active (ticking) only for non-terminal states
  // For terminal states, we show frozen time but timer is not active
  return !terminalAt && !TERMINAL_STATES.has(state);
}

// ─── Render ─────────────────────────────────────────────────────

/**
 * Render a singular TurnStatusSurface for one turn identity.
 *
 * - Exactly one per turn (keyed by block stableKey)
 * - Updates in place on state transitions
 * - Derives elapsed time only from eligible settings + authority timestamps
 * - Freezes at terminalAt
 * - Shows exact non-success outcome and cancel eligibility/reason
 */
export function renderTurnStatusSurface(
  block: TurnStatusBlockV1,
  config: TurnStatusSurfaceConfig,
): TurnStatusSurfaceHandle {
  const root = document.createElement('div');
  root.className = TURN_STATUS_CSS_CLASS;
  root.setAttribute('role', 'status');
  root.setAttribute('aria-atomic', 'true');
  root.dataset.stableKey = block.stableKey;

  // State indicator
  const stateContainer = document.createElement('span');
  stateContainer.className = `${TURN_STATUS_CSS_CLASS}__state`;
  root.appendChild(stateContainer);

  // Symbol (non-color cue)
  const symbolEl = document.createElement('span');
  symbolEl.className = `${TURN_STATUS_CSS_CLASS}__symbol`;
  symbolEl.setAttribute('aria-hidden', 'true');
  stateContainer.appendChild(symbolEl);

  // Label
  const labelEl = document.createElement('span');
  labelEl.className = `${TURN_STATUS_CSS_CLASS}__label`;
  stateContainer.appendChild(labelEl);

  // Elapsed time container
  const timerEl = document.createElement('span');
  timerEl.className = `${TURN_STATUS_CSS_CLASS}__timer`;
  timerEl.setAttribute('aria-label', 'Elapsed time');
  root.appendChild(timerEl);

  // Cancel/stop action container
  const cancelContainer = document.createElement('span');
  cancelContainer.className = `${TURN_STATUS_CSS_CLASS}__cancel`;
  root.appendChild(cancelContainer);

  // Cancel button
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = `${TURN_STATUS_CSS_CLASS}__cancel-btn nn-sr-focusable`;
  cancelBtn.textContent = 'Stop';
  cancelBtn.setAttribute('aria-label', 'Stop generation');
  cancelContainer.appendChild(cancelBtn);

  // Cancel unavailable reason
  const cancelReasonEl = document.createElement('span');
  cancelReasonEl.className = `${TURN_STATUS_CSS_CLASS}__cancel-reason`;
  cancelContainer.appendChild(cancelReasonEl);

  // Internal state
  let currentState: TurnActivityState = block.content.state;
  let currentStableKey = block.stableKey;
  let currentConfig = config;
  let currentBlock = block;
  let timerId: ReturnType<typeof setInterval> | null = null;
  let currentElapsedMs: number | null = null;
  let isTimerActive = false;
  let disposed = false;
  let cancelCallback: (() => void) | null = null;

  function updateDOM(): void {
    const state = currentBlock.content.state;
    const label = currentBlock.content.label || STATE_LABELS[state];

    root.dataset.state = state;
    symbolEl.textContent = STATE_SYMBOLS[state];
    labelEl.textContent = label;

    // Accessibility: set aria-label with full status info
    const ariaLabel = buildAriaLabel(state, label, currentElapsedMs, currentBlock.content.cancellation);
    root.setAttribute('aria-label', ariaLabel);

    // Non-success terminal outcome: add explicit outcome class
    if (NON_SUCCESS_TERMINAL_STATES.has(state)) {
      root.dataset.outcome = 'non_success';
    } else {
      delete root.dataset.outcome;
    }

    // Timer display
    updateTimerDisplay();

    // Cancel action display
    updateCancelDisplay();
  }

  function updateTimerDisplay(): void {
    const { startedAt, terminalAt } = currentBlock.content;

    // Elapsed time is only derived when settings enable it AND authority timestamps exist
    if (!currentConfig.elapsedTimeEnabled) {
      currentElapsedMs = null;
      timerEl.textContent = '';
      timerEl.style.display = 'none';
      return;
    }

    const now = Date.now();
    currentElapsedMs = computeElapsedMs(startedAt, terminalAt, now);

    if (currentElapsedMs === null) {
      timerEl.textContent = '';
      timerEl.style.display = 'none';
      return;
    }

    timerEl.style.display = '';
    timerEl.textContent = formatElapsed(currentElapsedMs);
  }

  function updateCancelDisplay(): void {
    const cancellation = currentBlock.content.cancellation;

    if (!cancellation) {
      cancelContainer.style.display = 'none';
      return;
    }

    cancelContainer.style.display = '';

    if (cancellation.available) {
      cancelBtn.style.display = '';
      cancelBtn.disabled = false;
      cancelReasonEl.style.display = 'none';
      cancelReasonEl.textContent = '';
    } else {
      cancelBtn.style.display = 'none';
      cancelBtn.disabled = true;
      if (cancellation.unavailableReason) {
        cancelReasonEl.style.display = '';
        cancelReasonEl.textContent = cancellation.unavailableReason;
      } else {
        cancelReasonEl.style.display = 'none';
        cancelReasonEl.textContent = '';
      }
    }
  }

  function startTimer(): void {
    stopTimer();
    const intervalMs = currentConfig.timerIntervalMs ?? DEFAULT_TIMER_INTERVAL_MS;
    isTimerActive = true;
    timerId = setInterval(() => {
      if (disposed) {
        stopTimer();
        return;
      }
      updateTimerDisplay();
    }, intervalMs);
  }

  function stopTimer(): void {
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
    isTimerActive = false;
  }

  function syncTimer(): void {
    const shouldTick = isTimerEligible(
      currentConfig,
      currentBlock.content.startedAt,
      currentBlock.content.terminalAt,
      currentBlock.content.state,
    );

    if (shouldTick && !isTimerActive) {
      startTimer();
    } else if (!shouldTick && isTimerActive) {
      stopTimer();
    }
  }

  // Wire cancel button
  cancelBtn.addEventListener('click', () => {
    if (cancelCallback && currentBlock.content.cancellation?.available) {
      cancelCallback();
    }
  });

  // Initial render
  updateDOM();
  syncTimer();

  function buildAriaLabel(
    state: TurnActivityState,
    label: string,
    elapsedMs: number | null,
    cancellation?: { available: boolean; unavailableReason?: string },
  ): string {
    const parts: string[] = [`Turn status: ${label}`];

    if (elapsedMs !== null && currentConfig.elapsedTimeEnabled) {
      parts.push(`Elapsed: ${formatElapsed(elapsedMs)}`);
    }

    if (cancellation) {
      if (cancellation.available) {
        parts.push('Stop available');
      } else if (cancellation.unavailableReason) {
        parts.push(`Stop unavailable: ${cancellation.unavailableReason}`);
      }
    }

    return parts.join('. ');
  }

  const handle: TurnStatusSurfaceHandle = {
    get element() {
      return root;
    },
    get stableKey() {
      return currentStableKey;
    },
    get state() {
      return currentState;
    },
    get elapsedMs() {
      return currentElapsedMs;
    },
    get timerActive() {
      return isTimerActive;
    },
    get cancelAction(): CancelAction | null {
      const cancellation = currentBlock.content.cancellation;
      if (!cancellation) return null;
      return {
        available: cancellation.available,
        unavailableReason: cancellation.unavailableReason,
      };
    },

    update(nextBlock: TurnStatusBlockV1, nextConfig: TurnStatusSurfaceConfig): void {
      if (disposed) return;

      currentBlock = nextBlock;
      currentConfig = nextConfig;
      currentState = nextBlock.content.state;
      currentStableKey = nextBlock.stableKey;
      root.dataset.stableKey = nextBlock.stableKey;

      updateDOM();
      syncTimer();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      stopTimer();
      cancelCallback = null;
      root.remove();
      root.replaceChildren();
    },
  };

  return handle;
}

/**
 * Set a cancel action callback on the handle.
 * This is separated from the handle to maintain the immutable handle pattern.
 */
export function setTurnStatusCancelCallback(handle: TurnStatusSurfaceHandle, callback: (() => void) | null): void {
  // Access internal cancel callback via the closure by reaching into the DOM
  const btn = handle.element.querySelector(`.${TURN_STATUS_CSS_CLASS}__cancel-btn`) as HTMLButtonElement | null;
  if (btn) {
    // Replace click handler
    const newBtn = btn.cloneNode(true) as HTMLButtonElement;
    btn.replaceWith(newBtn);
    if (callback) {
      newBtn.addEventListener('click', callback);
    }
  }
}

/** Closed surface adapter conforming to ResponseSurfaceAdapter interface. */
export const TurnStatusSurface = Object.freeze({
  kind: 'turn_status' as const,
  render: renderTurnStatusSurface,
});

// ─── Thinking Card ──────────────────────────────────────────────
//
// The Thinking Card is rendered from a `task_progress` block whose
// `sourceIdentity.entityId` starts with `thinking:`. The Thinking Card is
// ordered, updates its items in place, and provides a per-item elapsed timer
// that ticks while the item is `running` and freezes on transition to a
// terminal state. If no thinking block exists in a composition, the Thinking
// Card renders nothing — it never fabricates steps.
//
// Requirements: 11.1–11.9

export const THINKING_CARD_CSS_CLASS = 'nn-thinking-card';
export const THINKING_ITEM_CSS_CLASS = 'nn-thinking-card__item';
export const THINKING_ENTITY_PREFIX = 'thinking:';
export const THINKING_DEFAULT_TIMER_INTERVAL_MS = 1000;

/** State value for a single thinking step, as projected from the canonical projection. */
export type ThinkingItemState = TaskProgressBlockV1['content']['items'][number]['state'];

/** Terminal step states — the elapsed timer for the item is frozen. */
export const TERMINAL_THINKING_ITEM_STATES: ReadonlySet<ThinkingItemState> = new Set<ThinkingItemState>([
  'completed',
  'failed',
  'cancelled',
]);

/** Non-success terminal step states. */
export const NON_SUCCESS_THINKING_ITEM_STATES: ReadonlySet<ThinkingItemState> = new Set<ThinkingItemState>([
  'failed',
  'cancelled',
]);

const THINKING_ITEM_STATE_LABELS: Readonly<Record<ThinkingItemState, string>> = Object.freeze({
  queued: 'Queued',
  running: 'Running',
  blocked: 'Blocked',
  waiting: 'Waiting',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
});

const THINKING_ITEM_STATE_SYMBOLS: Readonly<Record<ThinkingItemState, string>> = Object.freeze({
  queued: '\u25CB', // ○
  running: '\u25B6', // ▶
  blocked: '\u2716', // ✖
  waiting: '\u23F3', // ⏳
  completed: '\u2713', // ✓
  failed: '\u2717', // ✗
  cancelled: '\u2014', // —
});

/** Configuration for the Thinking Card. */
export interface ThinkingCardConfig {
  /**
   * Whether an elapsed-time counter is shown next to running items and, once
   * frozen, next to terminal items. Elapsed time is derived from a first-seen
   * timestamp per item stable identity — it is presentation state only and is
   * never used to fabricate content.
   */
  readonly elapsedTimeEnabled?: boolean;
  /** Timer refresh interval in ms (default 1000). */
  readonly timerIntervalMs?: number;
  /** Whether the disclosure is expanded by default (default true). */
  readonly defaultExpanded?: boolean;
  /** Override "now" for deterministic tests. Falls back to `Date.now`. */
  readonly now?: () => number;
}

/** Handle for a Thinking Card. */
export interface ThinkingCardHandle {
  readonly element: HTMLElement;
  readonly stableKey: string;
  readonly expanded: boolean;
  readonly itemCount: number;
  readonly runningCount: number;
  readonly timerActive: boolean;
  /** Elapsed milliseconds observed for the identified running item. */
  elapsedForItem(taskId: string): number | null;
  setExpanded(expanded: boolean): void;
  update(nextBlock: TaskProgressBlockV1, nextConfig?: ThinkingCardConfig): void;
  dispose(): void;
}

/**
 * True if a `task_progress` block belongs to the Thinking Card lineage — i.e.
 * its `sourceIdentity.entityId` starts with the `thinking:` prefix.
 */
export function isThinkingCardBlock(block: TaskProgressBlockV1): boolean {
  return block.sourceIdentity.entityId.startsWith(THINKING_ENTITY_PREFIX);
}

/**
 * Locate the Thinking Card block within a response composition, if any.
 * Returns `undefined` when no `task_progress` block belongs to the thinking
 * lineage.
 */
export function findThinkingBlock(composition: ResponseCompositionV1): TaskProgressBlockV1 | undefined {
  for (const block of composition.blocks) {
    if (block.kind === 'task_progress' && isThinkingCardBlock(block)) {
      return block;
    }
  }
  return undefined;
}

/**
 * Render a Thinking Card directly from a `task_progress` block belonging to
 * the thinking lineage. Returns `null` if the block does not belong to the
 * thinking lineage — callers must never fabricate a Thinking Card for other
 * block kinds.
 */
export function renderThinkingCard(
  block: TaskProgressBlockV1,
  config: ThinkingCardConfig = {},
): ThinkingCardHandle | null {
  if (!isThinkingCardBlock(block)) return null;
  return renderThinkingCardInternal(block, config);
}

/**
 * Scan a response composition for a Thinking Card block and render it.
 * Returns `null` when the composition contains no thinking-lineage block.
 * Never invents steps and never displays an empty Thinking Card.
 */
export function renderThinkingCardFromComposition(
  composition: ResponseCompositionV1,
  config: ThinkingCardConfig = {},
): ThinkingCardHandle | null {
  const block = findThinkingBlock(composition);
  if (block === undefined) return null;
  // Rendering an empty items array is still valid — the projector never emits
  // a thinking block without at least one recorded step, but if it did the
  // absence contract (Requirement 11.8) requires us to return nothing.
  if (block.content.items.length === 0) return null;
  return renderThinkingCardInternal(block, config);
}

function computeThinkingItemElapsedMs(
  firstSeenMs: number | undefined,
  frozenElapsedMs: number | undefined,
  nowMs: number,
): number | null {
  if (frozenElapsedMs !== undefined) {
    return Math.max(0, frozenElapsedMs);
  }
  if (firstSeenMs === undefined) return null;
  return Math.max(0, nowMs - firstSeenMs);
}

function formatThinkingElapsedMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

interface ThinkingItemTimingRecord {
  firstSeenAtMs: number | undefined;
  frozenElapsedMs: number | undefined;
  lastKnownState: ThinkingItemState;
}

function renderThinkingCardInternal(block: TaskProgressBlockV1, config: ThinkingCardConfig): ThinkingCardHandle {
  const nowFn: () => number = config.now ?? (() => Date.now());
  const timerIntervalMs = config.timerIntervalMs ?? THINKING_DEFAULT_TIMER_INTERVAL_MS;
  const elapsedTimeEnabled = config.elapsedTimeEnabled === true;

  let currentBlock: TaskProgressBlockV1 = block;
  let expanded = config.defaultExpanded !== false; // default true
  let disposed = false;
  let timerId: ReturnType<typeof setInterval> | null = null;

  // Renderer-local timing state — presentation only. Never used for content.
  const timings = new Map<string, ThinkingItemTimingRecord>();

  const root = document.createElement('section');
  root.className = THINKING_CARD_CSS_CLASS;
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Thinking activity');
  root.dataset['stableKey'] = block.stableKey;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = `${THINKING_CARD_CSS_CLASS}__toggle`;
  toggle.setAttribute('aria-expanded', String(expanded));
  root.appendChild(toggle);

  const toggleLabel = document.createElement('span');
  toggleLabel.className = `${THINKING_CARD_CSS_CLASS}__toggle-label`;
  toggle.appendChild(toggleLabel);

  const runningBadge = document.createElement('span');
  runningBadge.className = `${THINKING_CARD_CSS_CLASS}__running-badge`;
  runningBadge.setAttribute('aria-hidden', 'true');
  toggle.appendChild(runningBadge);

  const list = document.createElement('ol');
  list.className = `${THINKING_CARD_CSS_CLASS}__list`;
  list.setAttribute('role', 'list');
  const panelId = `thinking-panel-${block.stableKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  list.id = panelId;
  toggle.setAttribute('aria-controls', panelId);
  root.appendChild(list);

  // Track item DOM nodes by taskId so we can update items in place. Stable
  // identity per (blockStableKey, taskId) — Requirement 11.7 (retained across
  // navigation) is upheld by the projection contract; here we only preserve
  // element identity while the card lives.
  const itemNodes = new Map<string, HTMLElement>();

  function computeRunningCount(): number {
    let count = 0;
    for (const item of currentBlock.content.items) {
      if (item.state === 'running') count += 1;
    }
    return count;
  }

  function renderToggleLabel(): void {
    const groupLabel = currentBlock.content.groupLabel ?? 'Thinking';
    const running = computeRunningCount();
    toggleLabel.textContent = groupLabel;
    if (running > 0) {
      runningBadge.hidden = false;
      runningBadge.textContent = `${running} in progress`;
    } else {
      runningBadge.hidden = true;
      runningBadge.textContent = '';
    }
  }

  function applyExpandedState(): void {
    toggle.setAttribute('aria-expanded', String(expanded));
    list.hidden = !expanded;
    root.dataset['expanded'] = String(expanded);
  }

  function ensureItemNode(taskId: string): HTMLElement {
    const existing = itemNodes.get(taskId);
    if (existing !== undefined) return existing;
    const node = document.createElement('li');
    node.className = THINKING_ITEM_CSS_CLASS;
    node.dataset['taskId'] = taskId;

    const symbol = document.createElement('span');
    symbol.className = `${THINKING_ITEM_CSS_CLASS}__symbol`;
    symbol.setAttribute('aria-hidden', 'true');
    node.appendChild(symbol);

    const stateLabel = document.createElement('span');
    stateLabel.className = `${THINKING_ITEM_CSS_CLASS}__state`;
    node.appendChild(stateLabel);

    const title = document.createElement('span');
    title.className = `${THINKING_ITEM_CSS_CLASS}__title`;
    node.appendChild(title);

    const elapsed = document.createElement('span');
    elapsed.className = `${THINKING_ITEM_CSS_CLASS}__elapsed`;
    elapsed.hidden = true;
    node.appendChild(elapsed);

    const outcome = document.createElement('span');
    outcome.className = `${THINKING_ITEM_CSS_CLASS}__outcome`;
    outcome.hidden = true;
    node.appendChild(outcome);

    itemNodes.set(taskId, node);
    return node;
  }

  function updateTimingForItem(taskId: string, state: ThinkingItemState, nowMs: number): ThinkingItemTimingRecord {
    const previous = timings.get(taskId);
    if (previous === undefined) {
      // First observation of this item. Record firstSeenAtMs only when the
      // item is running so queued items don't accumulate false elapsed time.
      const record: ThinkingItemTimingRecord = {
        firstSeenAtMs: state === 'running' ? nowMs : undefined,
        frozenElapsedMs: undefined,
        lastKnownState: state,
      };
      timings.set(taskId, record);
      return record;
    }

    // Existing record — transition-driven updates.
    if (previous.lastKnownState !== state) {
      if (state === 'running' && previous.firstSeenAtMs === undefined) {
        // Transition into running (from queued/waiting/blocked). Start clock.
        previous.firstSeenAtMs = nowMs;
        previous.frozenElapsedMs = undefined;
      } else if (TERMINAL_THINKING_ITEM_STATES.has(state) && previous.frozenElapsedMs === undefined) {
        // Freeze at first terminal observation. If we never saw the item run,
        // frozen elapsed is 0 (we cannot invent unobserved time).
        if (previous.firstSeenAtMs !== undefined) {
          previous.frozenElapsedMs = Math.max(0, nowMs - previous.firstSeenAtMs);
        } else {
          previous.frozenElapsedMs = 0;
        }
      }
      previous.lastKnownState = state;
    }
    return previous;
  }

  function renderItem(
    node: HTMLElement,
    item: TaskProgressBlockV1['content']['items'][number],
    timing: ThinkingItemTimingRecord,
    nowMs: number,
  ): void {
    const state = item.state;
    node.dataset['state'] = state;

    if (NON_SUCCESS_THINKING_ITEM_STATES.has(state)) {
      node.dataset['outcome'] = 'non_success';
    } else {
      delete node.dataset['outcome'];
    }

    const symbol = node.querySelector<HTMLElement>(`.${THINKING_ITEM_CSS_CLASS}__symbol`);
    if (symbol !== null) symbol.textContent = THINKING_ITEM_STATE_SYMBOLS[state];

    const stateLabel = node.querySelector<HTMLElement>(`.${THINKING_ITEM_CSS_CLASS}__state`);
    if (stateLabel !== null) stateLabel.textContent = THINKING_ITEM_STATE_LABELS[state];

    const title = node.querySelector<HTMLElement>(`.${THINKING_ITEM_CSS_CLASS}__title`);
    if (title !== null) title.textContent = item.title;

    const elapsed = node.querySelector<HTMLElement>(`.${THINKING_ITEM_CSS_CLASS}__elapsed`);
    if (elapsed !== null) {
      const elapsedMs = elapsedTimeEnabled
        ? computeThinkingItemElapsedMs(timing.firstSeenAtMs, timing.frozenElapsedMs, nowMs)
        : null;
      if (elapsedMs === null) {
        elapsed.hidden = true;
        elapsed.textContent = '';
      } else {
        elapsed.hidden = false;
        elapsed.textContent = formatThinkingElapsedMs(elapsedMs);
        elapsed.setAttribute('aria-label', `Elapsed ${formatThinkingElapsedMs(elapsedMs)}`);
      }
    }

    const outcome = node.querySelector<HTMLElement>(`.${THINKING_ITEM_CSS_CLASS}__outcome`);
    if (outcome !== null) {
      if (item.outcome !== undefined && item.outcome.length > 0) {
        outcome.hidden = false;
        outcome.textContent = item.outcome;
      } else {
        outcome.hidden = true;
        outcome.textContent = '';
      }
    }

    const accessibleParts = [`Step: ${item.title}`, `State: ${THINKING_ITEM_STATE_LABELS[state]}`];
    if (item.outcome !== undefined && item.outcome.length > 0) {
      accessibleParts.push(`Outcome: ${item.outcome}`);
    }
    node.setAttribute('aria-label', accessibleParts.join('. '));
  }

  function renderAllItems(): void {
    const nowMs = nowFn();
    const seen = new Set<string>();
    let previousSibling: HTMLElement | null = null;

    for (const item of currentBlock.content.items) {
      seen.add(item.taskId);
      const timing = updateTimingForItem(item.taskId, item.state, nowMs);
      const node = ensureItemNode(item.taskId);

      renderItem(node, item, timing, nowMs);

      // Maintain order: insert after the previous sibling, or as the first child.
      const expected: ChildNode | null = previousSibling === null ? list.firstChild : previousSibling.nextSibling;
      if (node !== expected) {
        list.insertBefore(node, expected);
      }
      previousSibling = node;
    }

    // Remove any nodes for items no longer present. This preserves the
    // canonical projection as the sole source of truth — we never keep a
    // fabricated step that the projection has dropped.
    for (const [taskId, node] of [...itemNodes.entries()]) {
      if (!seen.has(taskId)) {
        node.remove();
        itemNodes.delete(taskId);
        timings.delete(taskId);
      }
    }
  }

  function tickTimers(): void {
    if (disposed) return;
    const nowMs = nowFn();
    for (const item of currentBlock.content.items) {
      if (item.state !== 'running') continue;
      const timing = timings.get(item.taskId);
      if (timing === undefined) continue;
      const node = itemNodes.get(item.taskId);
      if (node === undefined) continue;
      const elapsed = node.querySelector<HTMLElement>(`.${THINKING_ITEM_CSS_CLASS}__elapsed`);
      if (elapsed === null) continue;
      const elapsedMs = computeThinkingItemElapsedMs(timing.firstSeenAtMs, timing.frozenElapsedMs, nowMs);
      if (elapsedMs === null) {
        elapsed.hidden = true;
        elapsed.textContent = '';
      } else {
        elapsed.hidden = false;
        elapsed.textContent = formatThinkingElapsedMs(elapsedMs);
        elapsed.setAttribute('aria-label', `Elapsed ${formatThinkingElapsedMs(elapsedMs)}`);
      }
    }
  }

  function shouldTimerTick(): boolean {
    if (!elapsedTimeEnabled) return false;
    return currentBlock.content.items.some((item) => item.state === 'running');
  }

  function syncTimer(): void {
    const shouldTick = shouldTimerTick();
    if (shouldTick && timerId === null) {
      timerId = setInterval(tickTimers, timerIntervalMs);
    } else if (!shouldTick && timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
  }

  toggle.addEventListener('click', () => {
    if (disposed) return;
    expanded = !expanded;
    applyExpandedState();
  });

  // Initial render.
  applyExpandedState();
  renderToggleLabel();
  renderAllItems();
  syncTimer();

  const handle: ThinkingCardHandle = {
    get element(): HTMLElement {
      return root;
    },
    get stableKey(): string {
      return currentBlock.stableKey;
    },
    get expanded(): boolean {
      return expanded;
    },
    get itemCount(): number {
      return currentBlock.content.items.length;
    },
    get runningCount(): number {
      return computeRunningCount();
    },
    get timerActive(): boolean {
      return timerId !== null;
    },

    elapsedForItem(taskId: string): number | null {
      const timing = timings.get(taskId);
      if (timing === undefined) return null;
      return computeThinkingItemElapsedMs(timing.firstSeenAtMs, timing.frozenElapsedMs, nowFn());
    },

    setExpanded(next: boolean): void {
      if (disposed || next === expanded) return;
      expanded = next;
      applyExpandedState();
    },

    update(nextBlock: TaskProgressBlockV1): void {
      if (disposed) return;
      if (!isThinkingCardBlock(nextBlock)) return;
      currentBlock = nextBlock;
      root.dataset['stableKey'] = nextBlock.stableKey;
      renderToggleLabel();
      renderAllItems();
      syncTimer();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timerId !== null) {
        clearInterval(timerId);
        timerId = null;
      }
      root.remove();
      root.replaceChildren();
      itemNodes.clear();
      timings.clear();
    },
  };

  return handle;
}

/**
 * Closed surface adapter for the Thinking Card. Consumers should call
 * {@link renderThinkingCardFromComposition} directly to honor the
 * absence-when-not-supplied contract at the composition level. The adapter
 * exists so that a `renderBlock` dispatcher may still route thinking-lineage
 * `task_progress` blocks to this surface.
 */
export const ThinkingCardSurface = Object.freeze({
  kind: 'task_progress' as const,
  entityPrefix: THINKING_ENTITY_PREFIX,
  render(block: TaskProgressBlockV1, config: ThinkingCardConfig = {}): ThinkingCardHandle | null {
    return renderThinkingCard(block, config);
  },
});
