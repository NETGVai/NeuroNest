/**
 * Structured Chat Shell — Canonical projection-driven chat controller.
 *
 * The shell renders a centered settings-derived reading column, compact
 * right-aligned user messages, open assistant compositions, concise metadata,
 * a persistent composer slot, a project-aware empty greeting/suggestions,
 * and local overflow for wide surfaces.
 *
 * The shell exposes two entry points:
 *
 * 1. `createStructuredChatShell(options)` — a static layout primitive that
 *    accepts pre-built turn descriptors. Used by focused unit tests and
 *    surface-composition fixtures.
 *
 * 2. `createProjectionDrivenChatShell(options)` — the canonical renderer
 *    controller. Its sole input is the projection page/delta stream from
 *    `chatProjection.subscribe()`/`chatProjection.getPage()`. It never
 *    subscribes to `chat-response`, `chat:stream`, `chat:done`, `chat:error`,
 *    or `chat:stream-chunk`. Renderer-local state is limited to disclosure,
 *    focus, detail selection, and scroll anchors keyed by stable identity.
 *
 * Both entry points preserve Session Header authority priorities and clear
 * grouping of each user turn with assistant status, content, evidence,
 * decisions, and actions.
 *
 * Requirements: 3.1–3.9, 9.1–9.7, 10.1–10.7, 13.8, 13.9, 15.1–15.7, 16.2
 *
 * @vitest-environment jsdom
 */

import type {
  ChatNodeV1,
  MessageNodeV1,
} from '../../harness/contracts/chat-node';
import type {
  ResponseBlockV1,
  ResponseCompositionV1,
} from '../../harness/contracts/response-composition';
import type {
  ChatProjectionCompositionQueryV1,
  ChatProjectionCompositionResultV1,
  ChatProjectionInvalidatedV1,
  ChatProjectionPageQueryV1,
  ChatProjectionPageResultV1,
  ChatProjectionScopeV1,
  ChatProjectionUnavailableReasonV1,
  ChatProjectionUnsubscribe,
  ScopedChatProjectionDeltaV1,
} from '../types/structured-chat-preload';
import {
  createProjectionRenderScheduler,
  deltaHasTerminalTransition,
  type ProjectionRenderScheduler,
  type ProjectionRenderSchedulerOptions,
} from './projection-render-scheduler';

// ─── Layout Constants ───────────────────────────────────────────

export const DEFAULT_MAX_READING_WIDTH = 720;
export const DEFAULT_MIN_READING_WIDTH = 320;
export const SHELL_CSS_CLASS = 'nn-structured-chat-shell';
export const TIMELINE_CSS_CLASS = 'nn-structured-chat-shell__timeline';
export const COMPOSER_SLOT_CSS_CLASS = 'nn-structured-chat-shell__composer';
export const EMPTY_STATE_CSS_CLASS = 'nn-structured-chat-shell__empty';
export const USER_MESSAGE_CSS_CLASS = 'nn-structured-chat-shell__user-message';
export const ASSISTANT_COMPOSITION_CSS_CLASS = 'nn-structured-chat-shell__assistant-composition';
export const BLOCK_WRAPPER_CSS_CLASS = 'nn-structured-chat-shell__block';
export const METADATA_CSS_CLASS = 'nn-structured-chat-shell__metadata';
export const OVERFLOW_WRAPPER_CSS_CLASS = 'nn-structured-chat-shell__overflow-wrapper';
export const TURN_GROUP_CSS_CLASS = 'nn-structured-chat-shell__turn-group';
export const STATUS_REGION_CSS_CLASS = 'nn-structured-chat-shell__status';
export const PENDING_INDICATOR_CSS_CLASS = 'nn-structured-chat-shell__pending';
export const UNAVAILABLE_INDICATOR_CSS_CLASS = 'nn-structured-chat-shell__unavailable';

/** Response group container (one per `(responseId, attempt)` lineage). */
export const RESPONSE_GROUP_CSS_CLASS = 'nn-structured-chat-shell__response-group';
/** Response group terminal-state indicator element. */
export const RESPONSE_TERMINAL_CSS_CLASS = 'nn-structured-chat-shell__response-terminal';
/** Response group post-content actions toolbar. */
export const RESPONSE_ACTIONS_CSS_CLASS = 'nn-structured-chat-shell__response-actions';
/** Response group attempt/retry badge element. */
export const RESPONSE_ATTEMPT_BADGE_CSS_CLASS = 'nn-structured-chat-shell__response-attempt';

/** Default projection page size when no override is supplied. */
export const DEFAULT_PROJECTION_PAGE_SIZE = 50;

// ─── Configuration Types ────────────────────────────────────────

export interface ShellLayoutBounds {
  /** Maximum reading column width in pixels */
  readonly maxReadingWidth: number;
  /** Minimum reading column width in pixels */
  readonly minReadingWidth: number;
}

export interface ChatMetadata {
  readonly agent?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly channel?: string;
  readonly branch?: string;
  readonly timestamp?: string;
}

export interface UserMessageDescriptor {
  readonly stableKey: string;
  readonly text: string;
  readonly attachments?: readonly string[];
  readonly mode?: string;
  readonly source?: string;
  readonly deliveryState?: 'sent' | 'pending' | 'failed';
}

export interface AssistantCompositionDescriptor {
  readonly stableKey: string;
  readonly composition: ResponseCompositionV1;
  readonly metadata?: ChatMetadata;
  /**
   * Attempt number for retry lineage. Retries share a `turnId` but bump
   * `attempt` and `requestId`; the projector emits a distinct assistant
   * chat node per attempt. When provided, the response group displays a
   * "Attempt N" badge to disambiguate retries within one turn.
   */
  readonly attempt?: number;
}

export interface EmptyStateDescriptor {
  readonly projectName?: string;
  readonly greeting?: string;
  readonly suggestions?: readonly string[];
}

export interface TurnGroupDescriptor {
  readonly turnId: string;
  readonly userMessage: UserMessageDescriptor;
  /**
   * @deprecated Use {@link assistantResponses} to represent one response
   *   group per attempt lineage. When both are provided,
   *   {@link assistantResponses} takes precedence. When only this field is
   *   provided, it is interpreted as a single-attempt response group.
   */
  readonly assistantComposition?: AssistantCompositionDescriptor;
  /**
   * Ordered list of assistant response groups within this turn. Retries in
   * the same turn add additional entries. Each entry is one response group
   * per `(responseId, attempt)` lineage.
   */
  readonly assistantResponses?: readonly AssistantCompositionDescriptor[];
}

// ─── Response-Group Post-Content Actions ───────────────────────

/**
 * Post-content action kinds a response group exposes when meaningful content
 * exists. The shell renders buttons for these kinds; the authority routing is
 * handled by the caller via {@link StructuredChatShellOptions.onResponseAction}
 * (task 9.5 wires this through the structured action port).
 */
export type ResponseActionKind = 'copy' | 'retry' | 'feedback_up' | 'feedback_down';

/** Descriptor passed to `onResponseAction` when a user invokes an action. */
export interface ResponseActionInvocation {
  readonly kind: ResponseActionKind;
  readonly chatNodeStableKey: string;
  readonly compositionId: string;
  /** Present when the action targets a narrative answer body. */
  readonly narrativeText?: string;
}

export interface StructuredChatShellOptions {
  readonly bounds: ShellLayoutBounds;
  readonly emptyState?: EmptyStateDescriptor;
  readonly turnGroups?: readonly TurnGroupDescriptor[];
  readonly renderBlock?: (block: ResponseBlockV1) => HTMLElement;
  /**
   * Callback invoked when a user activates a post-content action on a
   * response group. Optional so tests and fixtures can render without
   * wiring authority routing.
   */
  readonly onResponseAction?: (invocation: ResponseActionInvocation) => void;
}

// ─── Shell Handle ───────────────────────────────────────────────

export interface StructuredChatShellHandle {
  readonly element: HTMLElement;
  readonly timelineElement: HTMLElement;
  readonly composerSlot: HTMLElement;
  readonly isEmpty: boolean;
  /**
   * Update the reading-column max/min bounds after construction. Used by
   * the mode-aware width observer (task 11.3) so the timeline shrinks
   * with the available container width instead of forcing page-level
   * horizontal scrolling. The update mutates only inline `max-width`/
   * `min-width` on the timeline element and the CSS custom properties
   * on the shell root; no children remount.
   */
  setReadingBounds(bounds: ShellLayoutBounds): void;
  dispose(): void;
}

// ─── Metadata Rendering ─────────────────────────────────────────

/** Per-field metadata sub-class so individual fields are queryable/styleable. */
export const METADATA_FIELD_CSS_CLASS = `${METADATA_CSS_CLASS}__field`;
/** Non-semantic separator between rendered metadata fields. */
export const METADATA_SEPARATOR_CSS_CLASS = `${METADATA_CSS_CLASS}__separator`;

/**
 * Fields rendered by {@link renderMetadata}, in display order. `branch` is
 * rendered as `branch: <value>` and `timestamp` uses a `<time>` element so
 * assistive technology can identify it as a machine-readable timestamp.
 * Requirement 9.4: display responding agent, selected provider, and selected
 * model when available. Empty/missing values are omitted (no fabricated
 * placeholders — requirement 9.3).
 */
const METADATA_FIELD_ORDER: ReadonlyArray<keyof ChatMetadata> = [
  'agent',
  'model',
  'provider',
  'channel',
  'branch',
  'timestamp',
];

function metadataFieldDisplayValue(
  field: keyof ChatMetadata,
  raw: string,
): string {
  if (field === 'branch') return `branch: ${raw}`;
  return raw;
}

function renderMetadata(metadata: ChatMetadata): HTMLElement | null {
  const entries: Array<{ field: keyof ChatMetadata; value: string }> = [];
  for (const field of METADATA_FIELD_ORDER) {
    const raw = metadata[field];
    if (typeof raw === 'string' && raw.length > 0) {
      entries.push({ field, value: raw });
    }
  }
  if (entries.length === 0) return null;

  const el = document.createElement('div');
  el.className = METADATA_CSS_CLASS;
  el.setAttribute('role', 'note');
  el.setAttribute('aria-label', 'Message metadata');
  // Task 11.3: metadata rows wrap on narrow widths so long localized
  // agent/provider/model strings never force page-level horizontal
  // scroll (Requirement 9.7, 14.10). The style is applied inline so the
  // guarantee holds even if the canonical stylesheet fails to load
  // (Requirement 15.9).
  el.style.display = 'flex';
  el.style.flexWrap = 'wrap';
  el.style.minWidth = '0';
  el.style.maxWidth = '100%';

  entries.forEach((entry, index) => {
    if (index > 0) {
      const sep = document.createElement('span');
      sep.className = METADATA_SEPARATOR_CSS_CLASS;
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = ' · ';
      el.appendChild(sep);
    }
    // Timestamps get semantic `<time>` for AT identification and datetime
    // preservation. All other fields render as `<span>`. Requirement 9.4.
    const fieldEl =
      entry.field === 'timestamp'
        ? document.createElement('time')
        : document.createElement('span');
    fieldEl.className = `${METADATA_FIELD_CSS_CLASS} ${METADATA_FIELD_CSS_CLASS}--${entry.field}`;
    fieldEl.dataset['field'] = entry.field;
    fieldEl.style.minWidth = '0';
    fieldEl.style.maxWidth = '100%';
    if (entry.field === 'timestamp') {
      (fieldEl as HTMLTimeElement).dateTime = entry.value;
    }
    fieldEl.textContent = metadataFieldDisplayValue(entry.field, entry.value);
    el.appendChild(fieldEl);
  });

  return el;
}

// ─── User Message Rendering ─────────────────────────────────────

function renderUserMessage(descriptor: UserMessageDescriptor): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = USER_MESSAGE_CSS_CLASS;
  wrapper.setAttribute('role', 'article');
  wrapper.setAttribute('aria-label', 'User message');
  wrapper.dataset['stableKey'] = descriptor.stableKey;
  // Task 11.3: user messages shrink and wrap long text on narrow widths
  // so no message forces a horizontal page scroll (Requirement 15.10).
  wrapper.style.minWidth = '0';
  wrapper.style.maxWidth = '100%';
  wrapper.style.boxSizing = 'border-box';
  wrapper.style.overflowWrap = 'anywhere';

  const content = document.createElement('p');
  content.textContent = descriptor.text;
  content.style.minWidth = '0';
  content.style.maxWidth = '100%';
  content.style.overflowWrap = 'anywhere';
  wrapper.appendChild(content);

  if (descriptor.attachments && descriptor.attachments.length > 0) {
    const attachmentList = document.createElement('ul');
    attachmentList.className = `${USER_MESSAGE_CSS_CLASS}__attachments`;
    attachmentList.setAttribute('aria-label', 'Attachments');
    for (const attachment of descriptor.attachments) {
      const item = document.createElement('li');
      item.textContent = attachment;
      attachmentList.appendChild(item);
    }
    wrapper.appendChild(attachmentList);
  }

  if (descriptor.mode) {
    wrapper.dataset['mode'] = descriptor.mode;
  }
  if (descriptor.deliveryState) {
    wrapper.dataset['deliveryState'] = descriptor.deliveryState;
  }

  return wrapper;
}

// ─── Assistant Composition Rendering ────────────────────────────

/**
 * Turn-status states that mark a response as terminal (no more streaming).
 * Used to gate the "active cursor" indicator and reveal post-content actions.
 */
const TERMINAL_TURN_STATES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

/** Non-success terminal outcomes surfaced with an explicit outcome class. */
const NON_SUCCESS_TURN_STATES: ReadonlySet<string> = new Set([
  'failed',
  'cancelled',
  'interrupted',
]);

/** Extract the concise turn state from a response composition, if present. */
function pickTurnState(composition: ResponseCompositionV1): {
  state: string;
  label?: string;
} | null {
  for (const block of composition.blocks) {
    if (block.kind === 'turn_status') {
      const content = (block as unknown as { content?: { state?: unknown; label?: unknown } }).content;
      const state = content?.state;
      if (typeof state === 'string') {
        const label = typeof content?.label === 'string' ? content.label : undefined;
        return label !== undefined ? { state, label } : { state };
      }
    }
  }
  return null;
}

/**
 * Extract the finalized narrative answer text from a composition. Used by the
 * "copy answer" action; returns `undefined` when no answer body is present or
 * the narrative is still streaming (no finalized text to copy).
 */
function pickNarrativeText(composition: ResponseCompositionV1): string | undefined {
  for (const block of composition.blocks) {
    if (block.kind === 'narrative' && block.role === 'primary') {
      const content = (block as unknown as { content?: { text?: unknown } }).content;
      const text = content?.text;
      if (typeof text === 'string' && text.length > 0) {
        return text;
      }
    }
  }
  return undefined;
}

/**
 * Render the metadata header, activity blocks, Response Card, terminal state,
 * and post-content actions for a single response group. One response group per
 * `(responseId, attempt)` lineage — the projector emits a distinct assistant
 * chat node per attempt, so the assistant `chatNodeStableKey` serves as the
 * response identity here.
 */
function renderAssistantComposition(
  descriptor: AssistantCompositionDescriptor,
  renderBlock?: (block: ResponseBlockV1) => HTMLElement,
  onResponseAction?: (invocation: ResponseActionInvocation) => void,
): HTMLElement {
  const wrapper = document.createElement('div');
  // Preserve the historical class for compatibility. The response-group class
  // is added alongside so consumers can style either level.
  wrapper.classList.add(ASSISTANT_COMPOSITION_CSS_CLASS, RESPONSE_GROUP_CSS_CLASS);
  wrapper.setAttribute('role', 'article');
  wrapper.setAttribute('aria-label', 'Assistant response');
  wrapper.dataset['stableKey'] = descriptor.stableKey;
  wrapper.dataset['compositionId'] = descriptor.composition.compositionId;
  if (typeof descriptor.attempt === 'number' && descriptor.attempt > 0) {
    wrapper.dataset['attempt'] = String(descriptor.attempt);
  }
  // Task 11.3: response groups shrink with the reading column so cards
  // wrap instead of overflowing. Requirement 15.10.
  wrapper.style.minWidth = '0';
  wrapper.style.maxWidth = '100%';
  wrapper.style.boxSizing = 'border-box';

  // 1. Metadata header (agent, provider, model)
  if (descriptor.metadata) {
    const metaEl = renderMetadata(descriptor.metadata);
    if (metaEl) {
      wrapper.appendChild(metaEl);
    }
  }

  // 1b. Attempt/retry badge sits with the metadata header so it is visually
  //     grouped with other identity info, not with the content body.
  if (typeof descriptor.attempt === 'number' && descriptor.attempt > 1) {
    const badge = document.createElement('span');
    badge.className = RESPONSE_ATTEMPT_BADGE_CSS_CLASS;
    badge.setAttribute('role', 'note');
    badge.setAttribute('aria-label', `Retry attempt ${descriptor.attempt}`);
    badge.textContent = `Attempt ${descriptor.attempt}`;
    // Task 11.3: shrink hints so a long localized retry label wraps.
    badge.style.minWidth = '0';
    badge.style.maxWidth = '100%';
    badge.style.overflowWrap = 'anywhere';
    wrapper.appendChild(badge);
  }

  // 2. Activity + Response Card blocks in the composition's declared order.
  //    The projector composes blocks in semantic order (thinking/reasoning,
  //    tools/tasks/approvals, then the answer narrative), so we render as-is.
  for (const block of descriptor.composition.blocks) {
    const overflowWrapper = renderBlockOverflow(block, renderBlock);
    wrapper.appendChild(overflowWrapper);
  }

  // 3. Terminal state indicator — mirrors the turn_status block so a caller
  //    that toggles the composition's turn_status can see a stable, response-
  //    group-level indicator without walking blocks.
  const turnState = pickTurnState(descriptor.composition);
  if (turnState !== null) {
    const terminal = document.createElement('div');
    terminal.className = RESPONSE_TERMINAL_CSS_CLASS;
    terminal.setAttribute('role', 'status');
    terminal.dataset['state'] = turnState.state;
    if (TERMINAL_TURN_STATES.has(turnState.state)) {
      terminal.dataset['terminal'] = 'true';
    }
    if (NON_SUCCESS_TURN_STATES.has(turnState.state)) {
      terminal.dataset['outcome'] = 'non_success';
    }
    terminal.textContent = turnState.label ?? turnState.state;
    // Task 11.3: shrink hints so a long localized terminal state wraps.
    terminal.style.minWidth = '0';
    terminal.style.maxWidth = '100%';
    terminal.style.overflowWrap = 'anywhere';
    wrapper.appendChild(terminal);
  }

  // 4. Post-content actions — copy the narrative answer, retry the response,
  //    and up/down feedback. The shell only renders these when meaningful
  //    content exists (the narrative answer body). Task 9.5 wires the actual
  //    authority routing; here we only expose intent through the callback.
  const narrativeText = pickNarrativeText(descriptor.composition);
  const isTerminal = turnState !== null && TERMINAL_TURN_STATES.has(turnState.state);
  if (narrativeText !== undefined && (isTerminal || turnState === null)) {
    const actions = renderResponseActions({
      chatNodeStableKey: descriptor.stableKey,
      compositionId: descriptor.composition.compositionId,
      narrativeText,
      onResponseAction,
    });
    wrapper.appendChild(actions);
  }

  return wrapper;
}

interface ResponseActionsOptions {
  readonly chatNodeStableKey: string;
  readonly compositionId: string;
  readonly narrativeText: string;
  readonly onResponseAction?: (invocation: ResponseActionInvocation) => void;
}

function renderResponseActions(options: ResponseActionsOptions): HTMLElement {
  const toolbar = document.createElement('div');
  toolbar.className = RESPONSE_ACTIONS_CSS_CLASS;
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Response actions');
  // Task 11.3: response actions wrap on narrow widths (Requirements 9.7
  // and 14.9). Inline flex + wrap keeps the toolbar operable when the
  // canonical stylesheet fails to load (Requirement 15.9). Buttons keep
  // `min-width: 0` so long localized labels shrink instead of forcing
  // horizontal overflow.
  toolbar.style.display = 'flex';
  toolbar.style.flexWrap = 'wrap';
  toolbar.style.minWidth = '0';
  toolbar.style.maxWidth = '100%';

  const actions: ReadonlyArray<{ kind: ResponseActionKind; label: string }> = [
    { kind: 'copy', label: 'Copy' },
    { kind: 'retry', label: 'Retry' },
    { kind: 'feedback_up', label: 'Good response' },
    { kind: 'feedback_down', label: 'Poor response' },
  ];

  for (const { kind, label } of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `${RESPONSE_ACTIONS_CSS_CLASS}__btn ${RESPONSE_ACTIONS_CSS_CLASS}__btn--${kind}`;
    btn.dataset['actionKind'] = kind;
    btn.setAttribute('aria-label', label);
    btn.textContent = label;
    btn.style.minWidth = '0';
    btn.style.maxWidth = '100%';
    btn.addEventListener('click', () => {
      options.onResponseAction?.({
        kind,
        chatNodeStableKey: options.chatNodeStableKey,
        compositionId: options.compositionId,
        narrativeText: options.narrativeText,
      });
    });
    toolbar.appendChild(btn);
  }

  return toolbar;
}

function renderBlockOverflow(
  block: ResponseBlockV1,
  renderBlock?: (block: ResponseBlockV1) => HTMLElement,
): HTMLElement {
  const blockWrapper = document.createElement('div');
  blockWrapper.className = BLOCK_WRAPPER_CSS_CLASS;
  blockWrapper.dataset['blockKind'] = block.kind;
  blockWrapper.dataset['stableKey'] = block.stableKey;
  blockWrapper.dataset['role'] = block.role;
  // Task 11.3: the block wrapper must shrink with its parent so nested
  // code/table/diff surfaces contain their own overflow. Requirement 15.10.
  blockWrapper.style.minWidth = '0';
  blockWrapper.style.maxWidth = '100%';
  blockWrapper.style.boxSizing = 'border-box';

  if (renderBlock) {
    const rendered = renderBlock(block);
    blockWrapper.appendChild(rendered);
  } else {
    const placeholder = document.createElement('div');
    placeholder.textContent = `[${block.kind}]`;
    blockWrapper.appendChild(placeholder);
  }

  const overflowWrapper = document.createElement('div');
  overflowWrapper.className = OVERFLOW_WRAPPER_CSS_CLASS;
  // The overflow wrapper is the local seam that prevents any block from
  // pushing the page horizontally. Hidden overflow-x here forces nested
  // surfaces (code, tables) to opt into their own scroll containers.
  overflowWrapper.style.minWidth = '0';
  overflowWrapper.style.maxWidth = '100%';
  overflowWrapper.style.overflowX = 'hidden';
  overflowWrapper.style.boxSizing = 'border-box';
  overflowWrapper.appendChild(blockWrapper);
  return overflowWrapper;
}

// ─── Empty State Rendering ──────────────────────────────────────

function renderEmptyState(descriptor: EmptyStateDescriptor): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = EMPTY_STATE_CSS_CLASS;
  wrapper.setAttribute('role', 'status');
  wrapper.setAttribute('aria-label', 'Empty chat');

  const greeting = document.createElement('h2');
  greeting.className = `${EMPTY_STATE_CSS_CLASS}__greeting`;
  if (descriptor.projectName) {
    greeting.textContent = descriptor.greeting ?? `Welcome to ${descriptor.projectName}`;
  } else {
    greeting.textContent = descriptor.greeting ?? 'How can I help?';
  }
  wrapper.appendChild(greeting);

  if (descriptor.suggestions && descriptor.suggestions.length > 0) {
    const suggestionsEl = document.createElement('ul');
    suggestionsEl.className = `${EMPTY_STATE_CSS_CLASS}__suggestions`;
    suggestionsEl.setAttribute('role', 'list');
    suggestionsEl.setAttribute('aria-label', 'Suggested prompts');
    for (const suggestion of descriptor.suggestions) {
      const item = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = suggestion;
      btn.className = `${EMPTY_STATE_CSS_CLASS}__suggestion-btn`;
      item.appendChild(btn);
      suggestionsEl.appendChild(item);
    }
    wrapper.appendChild(suggestionsEl);
  }

  return wrapper;
}

// ─── Turn Group Rendering ───────────────────────────────────────

function renderTurnGroup(
  descriptor: TurnGroupDescriptor,
  renderBlock?: (block: ResponseBlockV1) => HTMLElement,
  onResponseAction?: (invocation: ResponseActionInvocation) => void,
): HTMLElement {
  const group = document.createElement('section');
  group.className = TURN_GROUP_CSS_CLASS;
  group.dataset['turnId'] = descriptor.turnId;
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', `Turn ${descriptor.turnId}`);
  // Task 11.3: turn groups inherit the shrink hints so nested response
  // groups can wrap their metadata/actions/cards on narrow widths.
  group.style.minWidth = '0';
  group.style.maxWidth = '100%';
  group.style.boxSizing = 'border-box';

  // User message (compact, right-aligned via CSS class)
  group.appendChild(renderUserMessage(descriptor.userMessage));

  // Assistant response groups. Retries share the same `turnId` but produce
  // separate response groups (one per `(responseId, attempt)` lineage).
  const responses = descriptor.assistantResponses
    ?? (descriptor.assistantComposition
      ? [descriptor.assistantComposition]
      : undefined);
  if (responses) {
    for (const response of responses) {
      group.appendChild(renderAssistantComposition(response, renderBlock, onResponseAction));
    }
  }

  return group;
}

// ─── Shell Construction ─────────────────────────────────────────

interface ShellSkeleton {
  readonly shell: HTMLElement;
  readonly timeline: HTMLElement;
  readonly composerSlot: HTMLElement;
  readonly statusRegion: HTMLElement;
  readonly maxWidth: number;
  readonly minWidth: number;
}

function buildShellSkeleton(bounds: ShellLayoutBounds): ShellSkeleton {
  // Clamp bounds within safe range
  const maxWidth = Math.max(bounds.minReadingWidth, bounds.maxReadingWidth);
  const minWidth = Math.max(
    DEFAULT_MIN_READING_WIDTH,
    Math.min(bounds.minReadingWidth, maxWidth),
  );

  // Root shell container. Task 11.3 anchors the local overflow containment
  // inline so a stylesheet-load failure (Requirement 15.9) cannot leak
  // horizontal scrolling to `document.documentElement`.
  const shell = document.createElement('div');
  shell.className = SHELL_CSS_CLASS;
  shell.setAttribute('role', 'main');
  shell.setAttribute('aria-label', 'Chat');
  shell.style.setProperty('--nn-shell-max-reading-width', `${maxWidth}px`);
  shell.style.setProperty('--nn-shell-min-reading-width', `${minWidth}px`);
  shell.style.boxSizing = 'border-box';
  shell.style.maxWidth = '100%';
  shell.style.minWidth = '0';
  shell.style.overflowX = 'hidden';

  // Timeline scrollable region. `margin-inline: auto` keeps the reading
  // column centered in both LTR and RTL flows (Requirement 14.10).
  // `max-width: 100%` guarantees the timeline never demands more
  // horizontal space than the shell has, even when the caller-provided
  // maxReadingWidth exceeds the current container.
  const timeline = document.createElement('div');
  timeline.className = TIMELINE_CSS_CLASS;
  timeline.setAttribute('role', 'log');
  timeline.setAttribute('aria-label', 'Conversation');
  timeline.style.boxSizing = 'border-box';
  timeline.style.maxWidth = `${maxWidth}px`;
  timeline.style.minWidth = `${minWidth}px`;
  timeline.style.marginInline = 'auto';
  timeline.style.overflowY = 'auto';
  timeline.style.overflowX = 'hidden';

  // Status region for projection availability messaging
  const statusRegion = document.createElement('div');
  statusRegion.className = STATUS_REGION_CSS_CLASS;
  statusRegion.setAttribute('role', 'status');
  statusRegion.setAttribute('aria-live', 'polite');
  statusRegion.setAttribute('aria-label', 'Chat availability');

  // Persistent composer slot. Same reading-column max so send/stop and
  // validation stay under the timeline instead of drifting into Inspector
  // territory. Uses `min-width: 0` so a long localized model label does
  // not force overflow (Requirement 14.10).
  const composerSlot = document.createElement('div');
  composerSlot.className = COMPOSER_SLOT_CSS_CLASS;
  composerSlot.setAttribute('role', 'region');
  composerSlot.setAttribute('aria-label', 'Message composer');
  composerSlot.style.boxSizing = 'border-box';
  composerSlot.style.maxWidth = `${maxWidth}px`;
  composerSlot.style.minWidth = '0';
  composerSlot.style.marginInline = 'auto';
  composerSlot.style.overflowX = 'hidden';

  shell.appendChild(statusRegion);
  shell.appendChild(timeline);
  shell.appendChild(composerSlot);

  return { shell, timeline, composerSlot, statusRegion, maxWidth, minWidth };
}

/**
 * Build the structured chat shell layout with pre-computed turn descriptors.
 *
 * The shell provides:
 * - A centered reading column bounded by settings-derived max/min width
 * - Right-aligned compact user messages
 * - Open assistant compositions with clear block spacing
 * - Local overflow containment for wide surfaces (code, tables, diffs)
 * - A persistent composer slot at the bottom
 * - Project-aware empty state with greeting and suggestions
 * - Clear turn grouping
 *
 * For a controller that consumes projection pages/deltas directly, see
 * {@link createProjectionDrivenChatShell}.
 */
export function createStructuredChatShell(
  options: StructuredChatShellOptions,
): StructuredChatShellHandle {
  const { bounds, emptyState, turnGroups, renderBlock, onResponseAction } = options;

  const skeleton = buildShellSkeleton(bounds);
  const { shell, timeline, composerSlot, statusRegion } = skeleton;

  // Status region is unused in the static path; hide it so tests reading the
  // timeline as the sole content surface remain stable.
  statusRegion.hidden = true;

  const hasTurns = turnGroups !== undefined && turnGroups.length > 0;

  if (!hasTurns && emptyState) {
    // Show empty/greeting state
    timeline.appendChild(renderEmptyState(emptyState));
  } else if (hasTurns && turnGroups) {
    // Render turn groups
    for (const turn of turnGroups) {
      timeline.appendChild(renderTurnGroup(turn, renderBlock, onResponseAction));
    }
  }

  let disposed = false;

  return Object.freeze({
    element: shell,
    timelineElement: timeline,
    composerSlot,
    get isEmpty() {
      return !hasTurns;
    },
    setReadingBounds(next: ShellLayoutBounds): void {
      if (disposed) return;
      applyReadingBoundsToSkeleton(skeleton, next);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      shell.remove();
      shell.replaceChildren();
    },
  });
}

/**
 * Update the timeline max/min and the shell's CSS custom properties from
 * a fresh {@link ShellLayoutBounds}. Extracted so both shell entry points
 * publish the same reconciled inline styles; the coalesced clamp mirrors
 * {@link buildShellSkeleton}.
 */
function applyReadingBoundsToSkeleton(
  skeleton: ShellSkeleton,
  next: ShellLayoutBounds,
): void {
  const maxWidth = Math.max(next.minReadingWidth, next.maxReadingWidth);
  const minWidth = Math.max(
    0,
    Math.min(next.minReadingWidth, maxWidth),
  );
  const { shell, timeline, composerSlot } = skeleton;
  shell.style.setProperty('--nn-shell-max-reading-width', `${maxWidth}px`);
  shell.style.setProperty('--nn-shell-min-reading-width', `${minWidth}px`);
  timeline.style.maxWidth = `${maxWidth}px`;
  timeline.style.minWidth = `${minWidth}px`;
  // Composer keeps a matching max so send/stop and validation stay under
  // the reading column and do not extend into inspector territory. The
  // slot itself has no fixed min — the composer surface fills to
  // whatever the timeline allows.
  composerSlot.style.maxWidth = `${maxWidth}px`;
}

// ─── Projection-Driven Chat Controller ──────────────────────────

/**
 * Renderer-local state permitted by the projection-driven contract.
 *
 * The projection composition is the single source of truth for chat content.
 * The renderer holds only the ephemeral local state that keyboard/mouse
 * interaction produces — nothing else. Every entry in this state is keyed by
 * a stable identity supplied by the projection.
 */
export interface RendererLocalState {
  /** Disclosure open/closed per stable identity (reasoning cards, tasks, code) */
  readonly disclosure: ReadonlyMap<string, boolean>;
  /** Focus target for keyboard navigation, keyed by stable identity */
  readonly focusTarget: string | null;
  /** Detail selection — which action feedback / detail dialog is open */
  readonly detailSelection: string | null;
  /** Scroll anchor keyed by stable block identity */
  readonly scrollAnchor: string | null;
}

/** Bindable renderer surface for the fixed chat projection preload bridge. */
export interface ChatProjectionBinding {
  getPage(query: ChatProjectionPageQueryV1): Promise<ChatProjectionPageResultV1>;
  getComposition(
    query: ChatProjectionCompositionQueryV1,
  ): Promise<ChatProjectionCompositionResultV1>;
  subscribeDeltas(
    scope: ChatProjectionScopeV1,
    callback: (delta: ScopedChatProjectionDeltaV1) => void,
  ): ChatProjectionUnsubscribe;
  subscribeInvalidations(
    scope: ChatProjectionScopeV1,
    callback: (event: ChatProjectionInvalidatedV1) => void,
  ): ChatProjectionUnsubscribe;
}

export type ProjectionRenderStatus =
  | { readonly kind: 'pending' }
  | {
      readonly kind: 'ready';
      readonly projectionRevision: number;
      readonly sourceRevision: number;
    }
  | {
      readonly kind: 'unavailable';
      readonly reasonCode: ChatProjectionUnavailableReasonV1;
      readonly projectionRevision: number;
      readonly sourceRevision: number;
    };

export type ProjectionDisposeReason =
  | 'scope_switch'
  | 'unload'
  | 'window_destroy'
  | 'manual';

/** Reason an unsubscribe was invoked, forwarded to the projection binding. */
export interface ProjectionDrivenChatShellOptions {
  readonly bounds: ShellLayoutBounds;
  readonly projection: ChatProjectionBinding;
  readonly scope: ChatProjectionScopeV1;
  readonly emptyState?: EmptyStateDescriptor;
  readonly renderBlock?: (block: ResponseBlockV1) => HTMLElement;
  readonly pageSize?: number;
  readonly onStatusChange?: (status: ProjectionRenderStatus) => void;
  /**
   * Called when the user activates a post-content action (copy, retry,
   * feedback) on a response group. Task 9.5 wires this into the structured
   * action port; here the shell only exposes the intent.
   */
  readonly onResponseAction?: (invocation: ResponseActionInvocation) => void;
  /** Attach a live event target (window/document) so `beforeunload` and
   *  `pagehide` events dispose the subscription. Defaults to the global
   *  `window` when available. Provide `null` to opt out. */
  readonly windowLifecycleTarget?: EventTarget | null;
  /**
   * Optional reconcile lifecycle hooks used by callers (task 11.4) to wire
   * an external reader-ownership controller. `onBeforeReconcile` runs
   * synchronously after the projection state is updated but before the DOM
   * is reconciled — a controller can capture the reader's scroll anchor
   * here. `onAfterReconcile` runs synchronously after the DOM is
   * reconciled — a controller restores the anchor or advances its
   * bottom-follow bookkeeping. The shell never forces scroll on
   * finalization; the callback receives the info needed to decide.
   */
  readonly onBeforeReconcile?: () => void;
  readonly onAfterReconcile?: (info: ReconcileInfo) => void;
  /**
   * Optional custom render scheduler (task 11.5). When omitted the shell
   * builds its own {@link ProjectionRenderScheduler} that coalesces
   * ordinary reconciliations to at most one per 50 ms and flushes
   * terminal states synchronously. Tests can pass a scheduler backed by a
   * mock clock to drive the coalescing window deterministically.
   */
  readonly renderScheduler?: ProjectionRenderScheduler;
  /**
   * Configuration passed to the default {@link ProjectionRenderScheduler}
   * factory when {@link renderScheduler} is not supplied. Ignored when a
   * pre-built scheduler is provided.
   */
  readonly renderSchedulerOptions?: ProjectionRenderSchedulerOptions;
}

/**
 * Post-reconcile summary passed to
 * {@link ProjectionDrivenChatShellOptions.onAfterReconcile}. The shell hands
 * the reader-ownership controller enough information to update unread
 * counts and restore the reader's anchor without forcing scroll.
 */
export interface ReconcileInfo {
  /** Total projected node count for the current scope after the reconcile. */
  readonly totalNodeCount: number;
  /**
   * `data-stable-key` of the last (visually bottom-most) rendered node, or
   * `null` when the timeline is empty. Callers use this as the read-boundary
   * marker when the reader is following the bottom.
   */
  readonly lastStableKey: string | null;
  /**
   * Kind of update that triggered this reconcile. Bottom-follow keeps
   * latest content visible on `delta` and `refresh`, but never on
   * `initial` alone when the shell first mounts (the reader has not yet
   * expressed intent). Task 11.4 leaves this classification to the
   * controller — the shell just reports the trigger.
   */
  readonly trigger: ReconcileTrigger;
}

/**
 * Reason the shell reconciled its DOM. `initial` is the first page load,
 * `delta` is an incremental projection delta, `refresh` is a full re-fetch
 * (invalidation), and `scope-switch` is a fresh subscription scope.
 */
export type ReconcileTrigger =
  | 'initial'
  | 'delta'
  | 'refresh'
  | 'scope-switch';

export interface ProjectionDrivenChatShellHandle {
  readonly element: HTMLElement;
  readonly timelineElement: HTMLElement;
  readonly composerSlot: HTMLElement;
  readonly statusRegion: HTMLElement;
  /** Current subscription scope. Updates atomically on `switchScope`. */
  currentScope(): ChatProjectionScopeV1;
  currentStatus(): ProjectionRenderStatus;
  currentLocalState(): RendererLocalState;
  setDisclosure(stableKey: string, expanded: boolean): void;
  setFocus(stableKey: string | null): void;
  setDetailSelection(stableKey: string | null): void;
  setScrollAnchor(stableKey: string | null): void;
  /**
   * Update the reading-column max/min bounds after construction (task
   * 11.3). Callers wire this to a `createChatWidthObserver` so the
   * timeline shrinks with the observed container width in both Classic
   * and Advanced modes without triggering page-level horizontal scroll.
   * Only inline styles on the shell skeleton mutate; block subtrees do
   * not remount.
   */
  setReadingBounds(bounds: ShellLayoutBounds): void;
  /**
   * Resolves after the current initial-page fetch (plus assistant composition
   * hydration) finishes. Used primarily by tests to wait deterministically for
   * the projection pipeline to settle.
   */
  whenReady(): Promise<void>;
  /** Force a page re-fetch and apply. Used after invalidation. */
  refresh(): Promise<void>;
  /** Switch the subscription scope. Cleans up prior subscriptions atomically. */
  switchScope(scope: ChatProjectionScopeV1): Promise<void>;
  dispose(reason?: ProjectionDisposeReason): void;
}

// ─── Projection Controller Internals ────────────────────────────

/**
 * Per-attempt response-group binding. One instance exists for every
 * `(responseId, attempt)` lineage rendered in the timeline. Retries share
 * the turn but produce distinct response-group bindings keyed by the
 * assistant `chatNodeStableKey`.
 */
interface ResponseGroupBinding {
  readonly chatNodeStableKey: string;
  compositionId: string;
  element: HTMLElement;
  /** Response-group-level chrome (metadata, terminal, actions) — cleared and
   *  re-built each reconcile pass. Block elements are preserved separately. */
  chromeElements: HTMLElement[];
  /** Preserve DOM node identity across block updates for stability tests. */
  blockElements: Map<string, HTMLElement>;
}

interface TurnGroupBinding {
  readonly turnId: string;
  element: HTMLElement;
  userMessageStableKey: string | null;
  userMessageElement: HTMLElement | null;
  /**
   * Ordered response-group bindings for this turn. Retries append additional
   * entries — the projector emits distinct assistant chat nodes per attempt.
   */
  responseGroups: Map<string, ResponseGroupBinding>;
  /** Insertion order of response groups within this turn. */
  responseGroupOrder: string[];
}

interface ProjectionState {
  /** Nodes keyed by stableKey, in projection order. */
  readonly nodes: Map<string, ChatNodeV1>;
  /** Compositions keyed by chatNodeStableKey. */
  readonly compositions: Map<string, ResponseCompositionV1>;
  /** Ordering derived from the last page (stable keys). */
  readonly orderedNodeKeys: string[];
  /** Turn group bindings keyed by turnId (or synthesized surrogate key). */
  readonly turnGroups: Map<string, TurnGroupBinding>;
}

function freezeScope(scope: ChatProjectionScopeV1): ChatProjectionScopeV1 {
  return Object.freeze({
    schemaVersion: 1 as const,
    sessionId: scope.sessionId,
    branchId: scope.branchId,
  });
}

function scopesEqual(
  a: ChatProjectionScopeV1,
  b: ChatProjectionScopeV1,
): boolean {
  return (
    a.schemaVersion === b.schemaVersion
    && a.sessionId === b.sessionId
    && a.branchId === b.branchId
  );
}

function makeInitialPageQuery(
  scope: ChatProjectionScopeV1,
  pageSize: number,
): ChatProjectionPageQueryV1 {
  return {
    kind: 'initial',
    position: 'latest',
    pageSize,
    schemaVersion: 1,
    sessionId: scope.sessionId,
    branchId: scope.branchId,
  };
}

/** Detect whether a node participates in a rendered turn (user/assistant message). */
function isMessageNode(node: ChatNodeV1): node is MessageNodeV1 {
  return node.nodeKind === 'message';
}

function pickTurnKey(node: ChatNodeV1, defaultKey: string): string {
  // Use turnId when available so a user message and its assistant
  // composition group together. Otherwise fall back to the stable key.
  const turnId = 'turnId' in node ? node.turnId : undefined;
  return typeof turnId === 'string' && turnId.length > 0 ? turnId : defaultKey;
}

/**
 * Extract a retry `attempt` field from an assistant message node's passthrough
 * fields when the projector provides one. Retries share a turn but bump
 * `attempt` and `requestId`. Non-retry (initial) responses have no attempt or
 * `attempt === 1`; the badge only renders when `attempt > 1`.
 */
function extractAttempt(node: MessageNodeV1 | null): number | undefined {
  if (node === null) return undefined;
  const raw = (node as unknown as Record<string, unknown>)['attempt'];
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
    return raw;
  }
  return undefined;
}

function toUserDescriptor(node: MessageNodeV1): UserMessageDescriptor {
  const attachments = node.attachmentIds;
  const base: UserMessageDescriptor = {
    stableKey: node.stableKey,
    text: node.text,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    deliveryState: 'sent',
  };
  return base;
}

function toAssistantDescriptor(
  composition: ResponseCompositionV1,
): AssistantCompositionDescriptor {
  return {
    stableKey: composition.chatNodeStableKey,
    composition,
  };
}

/**
 * Build the projection-driven chat controller.
 *
 * The controller subscribes to the projection page/delta stream and reconciles
 * the DOM in place — preserving stable identity for every rendered entity.
 * It never subscribes to legacy chat channels; direct legacy emissions are
 * consumed by main-process compatibility adapters before reaching this shell.
 */
export function createProjectionDrivenChatShell(
  options: ProjectionDrivenChatShellOptions,
): ProjectionDrivenChatShellHandle {
  const {
    bounds,
    projection,
    emptyState,
    renderBlock,
    pageSize = DEFAULT_PROJECTION_PAGE_SIZE,
    onStatusChange,
    onResponseAction,
    onBeforeReconcile,
    onAfterReconcile,
  } = options;

  const skeleton = buildShellSkeleton(bounds);
  const { shell, timeline, composerSlot, statusRegion } = skeleton;

  // Stable-root invariant (Task 11.5, Requirement 15.6):
  //
  // `shell` / `composerSlot` / `statusRegion` are appended to `shell`
  // exactly once by {@link buildShellSkeleton} and never mounted or
  // remounted by any subsequent reconciliation. Only the `timeline`
  // container is mutated during ordinary reconciliation
  // (see {@link reconcileTimeline}). This guarantees Prompt Bar and
  // control subtrees do not lose focus or transient state (draft text,
  // pending IME composition, in-flight autocomplete) when a token-
  // frequency delta causes a coalesced reconcile.
  //
  // Downstream refactors MUST preserve this invariant: no code path
  // should call `shell.replaceChildren()`, remove/re-append
  // `composerSlot`, or wrap the composer in a container that is
  // recreated per reconcile.

  // Task 11.5: render scheduler.
  //
  // - When the caller supplies `renderScheduler`, the shell routes every
  //   ordinary delta through it and calls `flushTerminal` for terminal
  //   transitions. Production callers pass a `{ windowMs: 50 }` scheduler
  //   to hit the "at most one ordinary reconciliation per 50 ms" target
  //   (Requirement 15.6).
  // - When the caller supplies `renderSchedulerOptions` but no
  //   `renderScheduler`, the shell builds one from those options.
  // - When neither is supplied, the shell builds a synchronous scheduler
  //   (`windowMs: 0`, no rAF) that flushes each delta immediately. This
  //   preserves the shell's historical contract: unit tests assert DOM
  //   state right after `emitDelta` without waiting for a timer. Callers
  //   that want coalescing must explicitly opt in.
  const ownsRenderScheduler = options.renderScheduler === undefined;
  const renderScheduler: ProjectionRenderScheduler =
    options.renderScheduler ??
    createProjectionRenderScheduler(
      options.renderSchedulerOptions ?? { windowMs: 0, animationFrame: null },
    );

  let currentScope = freezeScope(options.scope);
  let disposed = false;
  let currentStatus: ProjectionRenderStatus = { kind: 'pending' };
  let lastProjectionRevision = -1;
  let lastSourceRevision = -1;

  const state: ProjectionState = {
    nodes: new Map(),
    compositions: new Map(),
    orderedNodeKeys: [],
    turnGroups: new Map(),
  };

  const localState: {
    disclosure: Map<string, boolean>;
    focusTarget: string | null;
    detailSelection: string | null;
    scrollAnchor: string | null;
  } = {
    disclosure: new Map(),
    focusTarget: null,
    detailSelection: null,
    scrollAnchor: null,
  };

  let deltaUnsubscribe: ChatProjectionUnsubscribe | null = null;
  let invalidationUnsubscribe: ChatProjectionUnsubscribe | null = null;
  const lifecycleTarget: EventTarget | null = resolveLifecycleTarget(options.windowLifecycleTarget);
  const lifecycleHandler = (): void => {
    dispose('window_destroy');
  };
  if (lifecycleTarget !== null) {
    lifecycleTarget.addEventListener('beforeunload', lifecycleHandler);
    lifecycleTarget.addEventListener('pagehide', lifecycleHandler);
  }

  // Render the initial pending status synchronously so the shell surfaces
  // "no projection yet" before the first async page fetch settles.
  renderStatusRegion(currentStatus);

  // Kick off the initial subscription cycle. Failures are surfaced through
  // status; they never throw out of the constructor.
  let readyPromise: Promise<void> = initialize();

  function initialize(): Promise<void> {
    const scope = currentScope;
    openSubscriptions(scope);
    return loadInitialPage(scope, 'initial');
  }

  /**
   * Compute the last stable key that is currently rendered in the timeline.
   * Used by {@link runReconcile} to hand the reader-ownership controller
   * enough context for its read-boundary bookkeeping.
   */
  function computeLastStableKey(): string | null {
    // Look up the last mounted node with a stable key. Turn groups render
    // in projection order, so the last group holds the newest content.
    if (state.orderedNodeKeys.length === 0) return null;
    for (let i = state.orderedNodeKeys.length - 1; i >= 0; i -= 1) {
      const key = state.orderedNodeKeys[i];
      if (typeof key === 'string' && key.length > 0) return key;
    }
    return null;
  }

  /**
   * Wrap a reconcile pass with the optional lifecycle callbacks so
   * reader-ownership controllers can capture/restore scroll anchors and
   * update unread bookkeeping without the shell needing to know about
   * their internals. Callback failures are swallowed — the shell must
   * remain operable if an external hook throws.
   */
  function runReconcile(trigger: ReconcileTrigger): void {
    if (onBeforeReconcile !== undefined) {
      try {
        onBeforeReconcile();
      } catch {
        // Never let a hook error abort the reconcile.
      }
    }
    reconcileTimeline();
    if (onAfterReconcile !== undefined) {
      try {
        onAfterReconcile({
          totalNodeCount: state.orderedNodeKeys.length,
          lastStableKey: computeLastStableKey(),
          trigger,
        });
      } catch {
        // Same — post-reconcile hook errors are non-fatal.
      }
    }
  }

  function openSubscriptions(scope: ChatProjectionScopeV1): void {
    if (disposed) return;
    deltaUnsubscribe = projection.subscribeDeltas(scope, (delta) => {
      if (disposed) return;
      if (delta.sessionId !== scope.sessionId || delta.branchId !== scope.branchId) return;
      applyDelta(delta);
    });
    invalidationUnsubscribe = projection.subscribeInvalidations(scope, (event) => {
      if (disposed) return;
      if (event.sessionId !== scope.sessionId || event.branchId !== scope.branchId) return;
      // Any invalidation reason drives a full re-fetch. Source-revision
      // changes surface here as either dedicated invalidations or via delta
      // gaps handled below.
      void refresh();
    });
  }

  async function loadInitialPage(
    scope: ChatProjectionScopeV1,
    trigger: ReconcileTrigger,
  ): Promise<void> {
    if (disposed) return;
    const query = makeInitialPageQuery(scope, pageSize);
    let result: ChatProjectionPageResultV1;
    try {
      result = await projection.getPage(query);
    } catch {
      // Treat unexpected transport errors as an unavailable status so the
      // renderer surfaces the availability signal without throwing.
      updateStatus({
        kind: 'unavailable',
        reasonCode: 'query_failed',
        projectionRevision: lastProjectionRevision,
        sourceRevision: lastSourceRevision,
      });
      return;
    }
    if (disposed) return;

    if (!scopesEqual(scope, currentScope)) return;

    if (result.ok === false) {
      updateStatus({
        kind: 'unavailable',
        reasonCode: result.reasonCode,
        projectionRevision: result.projectionRevision,
        sourceRevision: result.sourceRevision,
      });
      return;
    }

    lastProjectionRevision = result.projectionRevision;
    lastSourceRevision = result.sourceRevision;

    resetTimelineState();
    for (const node of result.value.nodes) {
      state.nodes.set(node.stableKey, node);
      state.orderedNodeKeys.push(node.stableKey);
    }
    // Compositions are populated by delta stream; the initial page returns
    // only nodes. Hydrate assistant compositions by chatNodeStableKey.
    await hydrateAssistantCompositions(scope);
    if (disposed) return;
    if (!scopesEqual(scope, currentScope)) return;

    updateStatus({
      kind: 'ready',
      projectionRevision: lastProjectionRevision,
      sourceRevision: lastSourceRevision,
    });
    runReconcile(trigger);
  }

  async function hydrateAssistantCompositions(scope: ChatProjectionScopeV1): Promise<void> {
    const assistantKeys: string[] = [];
    for (const node of state.nodes.values()) {
      if (isMessageNode(node) && node.role === 'assistant') {
        assistantKeys.push(node.stableKey);
      }
    }
    if (assistantKeys.length === 0) return;

    const query = (chatNodeStableKey: string): ChatProjectionCompositionQueryV1 => ({
      schemaVersion: 1,
      sessionId: scope.sessionId,
      branchId: scope.branchId,
      chatNodeStableKey,
    });

    const results = await Promise.all(
      assistantKeys.map((key) => projection.getComposition(query(key)).catch(() => null)),
    );
    if (disposed || !scopesEqual(scope, currentScope)) return;
    for (let i = 0; i < assistantKeys.length; i += 1) {
      const key = assistantKeys[i];
      const result = results[i];
      if (typeof key !== 'string' || result === null || result === undefined) continue;
      if (result.ok === true) {
        state.compositions.set(key, result.value);
      }
    }
  }

  function applyDelta(delta: ScopedChatProjectionDeltaV1): void {
    // Detect out-of-order or gap deltas by monotonic revision. When either
    // revision moves backward we refetch to reconcile. When it advances by
    // more than one atomic transition without corresponding node/composition
    // changes we also refetch, since the projector may have coalesced.
    const advancingRevision = delta.projectionRevision >= lastProjectionRevision;
    if (!advancingRevision) {
      void refresh();
      return;
    }

    // Update projection state synchronously — canonical state is always
    // up to date the instant a delta lands. Only the DOM reconciliation
    // is gated by the render scheduler (task 11.5): ordinary deltas are
    // coalesced within a 50 ms window, terminal deltas flush immediately.
    for (const node of delta.nodesAdded) {
      if (!state.nodes.has(node.stableKey)) {
        state.orderedNodeKeys.push(node.stableKey);
      }
      state.nodes.set(node.stableKey, node);
    }
    for (const node of delta.nodesUpdated) {
      state.nodes.set(node.stableKey, node);
    }
    for (const removedKey of delta.nodesRemoved) {
      state.nodes.delete(removedKey);
      const idx = state.orderedNodeKeys.indexOf(removedKey);
      if (idx >= 0) state.orderedNodeKeys.splice(idx, 1);
      // Any turn groups holding a stale reference to this node purge on
      // reconcile below.
    }

    for (const composition of delta.compositionsAdded) {
      state.compositions.set(composition.chatNodeStableKey, composition);
    }
    for (const composition of delta.compositionsUpdated) {
      state.compositions.set(composition.chatNodeStableKey, composition);
    }
    for (const removedKey of delta.compositionsRemoved) {
      state.compositions.delete(removedKey);
    }

    lastProjectionRevision = delta.projectionRevision;
    lastSourceRevision = delta.sourceRevision;
    updateStatus({
      kind: 'ready',
      projectionRevision: lastProjectionRevision,
      sourceRevision: lastSourceRevision,
    });

    // Route the reconcile through the render scheduler so ordinary
    // token-frequency updates coalesce to at most one DOM reconciliation
    // per 50 ms while terminal state transitions flush immediately.
    const isTerminal = deltaHasTerminalTransition(delta);
    const scopeAtSchedule = currentScope;
    const reconcileWork = (flushedRevision: number): void => {
      if (disposed) return;
      // Guard against scope switches that happened between schedule and
      // flush — a newer scope owns its own scheduler, but a delta from
      // the retired scope must never reconcile into the new timeline.
      if (!scopesEqual(scopeAtSchedule, currentScope)) return;
      // Discard a stale flush whose revision is older than the current
      // projection. The scheduler holds only one pending work slot, so
      // this branch is defensive against out-of-order flush ordering
      // (e.g. terminal preempting ordinary).
      if (flushedRevision < lastProjectionRevision) return;
      runReconcile('delta');
    };

    if (isTerminal) {
      renderScheduler.flushTerminal(delta.projectionRevision, reconcileWork);
    } else {
      renderScheduler.schedule(delta.projectionRevision, reconcileWork);
    }
  }

  function resetTimelineState(): void {
    state.nodes.clear();
    state.compositions.clear();
    state.orderedNodeKeys.length = 0;
    for (const binding of state.turnGroups.values()) {
      binding.element.remove();
    }
    state.turnGroups.clear();
    // Purge empty-state placeholder if it exists.
    timeline.replaceChildren();
  }

  function reconcileTimeline(): void {
    // 1. Build the desired sequence of turn identifiers in projection order.
    //    Each turn may contain multiple assistant response groups (one per
    //    `(responseId, attempt)` lineage — retries share the turn but each
    //    attempt is a distinct assistant chat node with its own composition).
    interface AssistantEntry {
      readonly chatNodeStableKey: string;
      readonly composition: ResponseCompositionV1;
      readonly assistantNode: MessageNodeV1 | null;
    }
    interface TurnPlan {
      readonly turnKey: string;
      userNode: MessageNodeV1 | null;
      assistants: AssistantEntry[];
    }

    const planByTurnKey = new Map<string, TurnPlan>();
    const turnOrder: string[] = [];

    for (const stableKey of state.orderedNodeKeys) {
      const node = state.nodes.get(stableKey);
      if (!node) continue;
      if (!isMessageNode(node)) continue;
      if (node.role === 'system') continue;

      const turnKey = pickTurnKey(node, stableKey);
      let plan = planByTurnKey.get(turnKey);
      if (!plan) {
        plan = { turnKey, userNode: null, assistants: [] };
        planByTurnKey.set(turnKey, plan);
        turnOrder.push(turnKey);
      }
      if (node.role === 'user') {
        plan.userNode = node;
      } else if (node.role === 'assistant') {
        const composition = state.compositions.get(node.stableKey);
        if (composition) {
          plan.assistants.push({
            chatNodeStableKey: node.stableKey,
            composition,
            assistantNode: node,
          });
        }
      }
    }

    // Only render turns with a user message. Assistant-only turns without
    // a paired user message are still shown as synthetic groups so the
    // projection remains the authority.
    const orphanAssistants: string[] = [];
    for (const [key, comp] of state.compositions) {
      const assistantNode = state.nodes.get(key);
      if (!assistantNode) {
        // Composition present but node not indexed yet — surface as its own
        // turn keyed by chatNodeStableKey.
        if (!planByTurnKey.has(key)) {
          planByTurnKey.set(key, {
            turnKey: key,
            userNode: null,
            assistants: [
              { chatNodeStableKey: key, composition: comp, assistantNode: null },
            ],
          });
          orphanAssistants.push(key);
        }
      }
    }
    for (const key of orphanAssistants) turnOrder.push(key);

    // 2. Dispose turn groups no longer in the plan.
    const desiredSet = new Set(turnOrder);
    for (const [existingKey, binding] of state.turnGroups) {
      if (!desiredSet.has(existingKey)) {
        binding.element.remove();
        state.turnGroups.delete(existingKey);
      }
    }

    // 3. Ensure each turn has a group element and correct content.
    let previousElement: HTMLElement | null = null;
    for (const turnKey of turnOrder) {
      const plan = planByTurnKey.get(turnKey);
      if (!plan) continue;
      const binding = ensureTurnGroup(turnKey, plan.userNode, plan.assistants);

      // Position the element after the previous one (or as first child).
      if (previousElement === null) {
        if (timeline.firstElementChild !== binding.element) {
          timeline.insertBefore(binding.element, timeline.firstElementChild);
        }
      } else if (previousElement.nextElementSibling !== binding.element) {
        previousElement.after(binding.element);
      }
      previousElement = binding.element;
    }

    // 4. Empty-state placeholder appears only when there are no turns and an
    //    empty-state descriptor is configured.
    if (turnOrder.length === 0 && emptyState) {
      if (timeline.firstElementChild === null) {
        timeline.appendChild(renderEmptyState(emptyState));
      }
    } else {
      // Remove any lingering empty state.
      const emptyEl = timeline.querySelector(`.${EMPTY_STATE_CSS_CLASS}`);
      if (emptyEl) emptyEl.remove();
    }
  }

  function ensureTurnGroup(
    turnKey: string,
    userNode: MessageNodeV1 | null,
    assistants: ReadonlyArray<{
      chatNodeStableKey: string;
      composition: ResponseCompositionV1;
      assistantNode: MessageNodeV1 | null;
    }>,
  ): TurnGroupBinding {
    let binding = state.turnGroups.get(turnKey);
    if (!binding) {
      const groupEl = document.createElement('section');
      groupEl.className = TURN_GROUP_CSS_CLASS;
      groupEl.dataset['turnId'] = turnKey;
      groupEl.setAttribute('role', 'group');
      groupEl.setAttribute('aria-label', `Turn ${turnKey}`);
      // Task 11.3: keep the reconciled turn group shrinkable so nested
      // response-group flex children can wrap on narrow widths without
      // punching through the reading column (Requirement 15.10).
      groupEl.style.minWidth = '0';
      groupEl.style.maxWidth = '100%';
      groupEl.style.boxSizing = 'border-box';
      binding = {
        turnId: turnKey,
        element: groupEl,
        userMessageStableKey: null,
        userMessageElement: null,
        responseGroups: new Map(),
        responseGroupOrder: [],
      };
      state.turnGroups.set(turnKey, binding);
    }

    // Reconcile user message DOM
    if (userNode !== null) {
      if (binding.userMessageStableKey !== userNode.stableKey) {
        // Different user message — rebuild.
        binding.userMessageElement?.remove();
        const el = renderUserMessage(toUserDescriptor(userNode));
        binding.element.insertBefore(el, binding.element.firstChild);
        binding.userMessageElement = el;
        binding.userMessageStableKey = userNode.stableKey;
      } else if (binding.userMessageElement) {
        // Same stableKey — update text if changed.
        const p = binding.userMessageElement.querySelector('p');
        if (p && p.textContent !== userNode.text) {
          p.textContent = userNode.text;
        }
      }
    } else if (binding.userMessageElement) {
      binding.userMessageElement.remove();
      binding.userMessageElement = null;
      binding.userMessageStableKey = null;
    }

    // Reconcile response groups. Retries emit distinct assistant chat nodes
    // per attempt, so we key by `chatNodeStableKey` and preserve order in
    // `responseGroupOrder`. Groups no longer present are pruned; existing
    // groups reuse their DOM subtree so block-level identity survives.
    const desiredKeys = new Set(assistants.map((a) => a.chatNodeStableKey));
    for (const key of [...binding.responseGroups.keys()]) {
      if (!desiredKeys.has(key)) {
        const rg = binding.responseGroups.get(key);
        rg?.element.remove();
        binding.responseGroups.delete(key);
      }
    }
    // Drop stale ids from the order list; append new ones at the tail so
    // retry lineage is preserved in projection order.
    binding.responseGroupOrder = binding.responseGroupOrder.filter((k) =>
      desiredKeys.has(k),
    );
    for (const entry of assistants) {
      if (!binding.responseGroupOrder.includes(entry.chatNodeStableKey)) {
        binding.responseGroupOrder.push(entry.chatNodeStableKey);
      }
      reconcileResponseGroup(binding, entry);
    }

    // Reposition response groups in projection order so retries render after
    // their preceding attempts even if they arrive via delta out of order.
    let cursor: HTMLElement | null = binding.userMessageElement;
    for (const key of binding.responseGroupOrder) {
      const rg = binding.responseGroups.get(key);
      if (!rg) continue;
      if (cursor === null) {
        if (binding.element.firstElementChild !== rg.element) {
          binding.element.insertBefore(rg.element, binding.element.firstElementChild);
        }
      } else if (cursor.nextElementSibling !== rg.element) {
        cursor.after(rg.element);
      }
      cursor = rg.element;
    }

    return binding;
  }

  function reconcileResponseGroup(
    binding: TurnGroupBinding,
    entry: {
      chatNodeStableKey: string;
      composition: ResponseCompositionV1;
      assistantNode: MessageNodeV1 | null;
    },
  ): void {
    let rg = binding.responseGroups.get(entry.chatNodeStableKey);
    if (!rg) {
      const wrapper = document.createElement('div');
      wrapper.classList.add(ASSISTANT_COMPOSITION_CSS_CLASS, RESPONSE_GROUP_CSS_CLASS);
      wrapper.setAttribute('role', 'article');
      wrapper.setAttribute('aria-label', 'Assistant response');
      wrapper.dataset['stableKey'] = entry.chatNodeStableKey;
      wrapper.dataset['compositionId'] = entry.composition.compositionId;
      // Task 11.3: mirror the static-shell shrink hints so projection-
      // driven response groups can wrap their metadata/actions/cards on
      // narrow widths without pushing the timeline wider than its
      // reading column (Requirements 9.7, 14.9, 15.10).
      wrapper.style.minWidth = '0';
      wrapper.style.maxWidth = '100%';
      wrapper.style.boxSizing = 'border-box';
      binding.element.appendChild(wrapper);
      rg = {
        chatNodeStableKey: entry.chatNodeStableKey,
        compositionId: entry.composition.compositionId,
        element: wrapper,
        chromeElements: [],
        blockElements: new Map(),
      };
      binding.responseGroups.set(entry.chatNodeStableKey, rg);
    } else if (rg.compositionId !== entry.composition.compositionId) {
      // Composition swapped underneath — keep the same DOM element and clear
      // all children so block identity resets cleanly.
      rg.compositionId = entry.composition.compositionId;
      rg.element.dataset['compositionId'] = entry.composition.compositionId;
      rg.element.replaceChildren();
      rg.chromeElements = [];
      rg.blockElements.clear();
    }

    // Reflect the assistant node's declared attempt (if present as a
    // passthrough field on MessageNodeV1) so consumers can style retries.
    const attempt = extractAttempt(entry.assistantNode);
    if (attempt !== undefined) {
      rg.element.dataset['attempt'] = String(attempt);
    } else {
      delete rg.element.dataset['attempt'];
    }

    reconcileBlocks(rg, entry.composition);
    reconcileResponseGroupChrome(rg, entry.composition, attempt);
  }

  function reconcileBlocks(
    rg: ResponseGroupBinding,
    composition: ResponseCompositionV1,
  ): void {
    const wrapper = rg.element;
    const desiredKeys = new Set(composition.blocks.map((b) => b.stableKey));

    // Remove blocks no longer present.
    for (const [key, el] of rg.blockElements) {
      if (!desiredKeys.has(key)) {
        el.remove();
        rg.blockElements.delete(key);
        localState.disclosure.delete(key);
      }
    }

    // Upsert blocks by stable key, preserving DOM identity when possible.
    for (const block of composition.blocks) {
      const existing = rg.blockElements.get(block.stableKey);
      if (existing) {
        // Update in place if the block kind is unchanged.
        const inner = existing.querySelector<HTMLElement>(`.${BLOCK_WRAPPER_CSS_CLASS}`);
        if (inner && inner.dataset['blockKind'] === block.kind) {
          // Preserve identity: clear inner children and re-render.
          inner.replaceChildren();
          if (renderBlock) {
            inner.appendChild(renderBlock(block));
          } else {
            const placeholder = document.createElement('div');
            placeholder.textContent = `[${block.kind}]`;
            inner.appendChild(placeholder);
          }
          inner.dataset['role'] = block.role;
        } else {
          // Kind changed — remount but keep the outer overflow wrapper if
          // possible. To be conservative, rebuild the whole overflow node.
          const rebuilt = renderBlockOverflow(block, renderBlock);
          wrapper.replaceChild(rebuilt, existing);
          rg.blockElements.set(block.stableKey, rebuilt);
        }
      } else {
        // New block — append; positioning is finalized in the reorder pass
        // that `reconcileResponseGroupChrome` calls after chrome placement.
        const newEl = renderBlockOverflow(block, renderBlock);
        rg.blockElements.set(block.stableKey, newEl);
        wrapper.appendChild(newEl);
      }
    }
  }

  /**
   * Rebuild the response-group chrome (attempt badge, terminal state, and
   * post-content actions toolbar) and finalize child ordering. Chrome is
   * cheap to render, so we recreate it every reconcile pass to reflect the
   * latest composition state. Block elements retain their DOM identity via
   * `reconcileBlocks`.
   *
   * Final child order within the response group:
   *
   *   [attempt badge]?
   *   block[0] .. block[n]   (in composition.blocks order)
   *   [terminal state]?
   *   [actions toolbar]?
   */
  function reconcileResponseGroupChrome(
    rg: ResponseGroupBinding,
    composition: ResponseCompositionV1,
    attempt: number | undefined,
  ): void {
    // 1. Remove prior chrome — this leaves block elements intact because they
    //    are tracked separately in `rg.blockElements`.
    for (const el of rg.chromeElements) {
      el.remove();
    }
    rg.chromeElements = [];

    // 2. Assemble the desired child sequence and reposition in one pass so
    //    both blocks and chrome land in the correct visual order.
    const desiredChildren: HTMLElement[] = [];

    if (typeof attempt === 'number' && attempt > 1) {
      const badge = document.createElement('span');
      badge.className = RESPONSE_ATTEMPT_BADGE_CSS_CLASS;
      badge.setAttribute('role', 'note');
      badge.setAttribute('aria-label', `Retry attempt ${attempt}`);
      badge.textContent = `Attempt ${attempt}`;
      // Task 11.3: badges and terminal state indicators shrink so they
      // never force the response group wider than its reading column.
      badge.style.minWidth = '0';
      badge.style.maxWidth = '100%';
      badge.style.overflowWrap = 'anywhere';
      rg.chromeElements.push(badge);
      desiredChildren.push(badge);
    }

    for (const block of composition.blocks) {
      const el = rg.blockElements.get(block.stableKey);
      if (el) desiredChildren.push(el);
    }

    const turnState = pickTurnState(composition);
    if (turnState !== null) {
      const terminal = document.createElement('div');
      terminal.className = RESPONSE_TERMINAL_CSS_CLASS;
      terminal.setAttribute('role', 'status');
      terminal.dataset['state'] = turnState.state;
      if (TERMINAL_TURN_STATES.has(turnState.state)) {
        terminal.dataset['terminal'] = 'true';
      }
      if (NON_SUCCESS_TURN_STATES.has(turnState.state)) {
        terminal.dataset['outcome'] = 'non_success';
      }
      terminal.textContent = turnState.label ?? turnState.state;
      // Task 11.3: shrink hints so a long localized terminal label
      // wraps within the response group.
      terminal.style.minWidth = '0';
      terminal.style.maxWidth = '100%';
      terminal.style.overflowWrap = 'anywhere';
      rg.chromeElements.push(terminal);
      desiredChildren.push(terminal);
    }

    const narrativeText = pickNarrativeText(composition);
    const isTerminal = turnState !== null && TERMINAL_TURN_STATES.has(turnState.state);
    if (narrativeText !== undefined && (isTerminal || turnState === null)) {
      const actions = renderResponseActions({
        chatNodeStableKey: rg.chatNodeStableKey,
        compositionId: composition.compositionId,
        narrativeText,
        onResponseAction,
      });
      rg.chromeElements.push(actions);
      desiredChildren.push(actions);
    }

    // 3. Reposition to match desired order — reuse existing nodes for blocks,
    //    append new chrome nodes into place.
    let cursor: HTMLElement | null = null;
    for (const child of desiredChildren) {
      if (cursor === null) {
        if (rg.element.firstElementChild !== child) {
          rg.element.insertBefore(child, rg.element.firstElementChild);
        }
      } else if (cursor.nextElementSibling !== child) {
        cursor.after(child);
      }
      cursor = child;
    }
  }

  function updateStatus(next: ProjectionRenderStatus): void {
    currentStatus = next;
    renderStatusRegion(next);
    onStatusChange?.(next);
  }

  function renderStatusRegion(status: ProjectionRenderStatus): void {
    statusRegion.replaceChildren();
    statusRegion.hidden = false;
    if (status.kind === 'pending') {
      statusRegion.dataset['status'] = 'pending';
      const el = document.createElement('span');
      el.className = PENDING_INDICATOR_CSS_CLASS;
      el.textContent = 'Preparing conversation…';
      statusRegion.appendChild(el);
    } else if (status.kind === 'unavailable') {
      statusRegion.dataset['status'] = 'unavailable';
      const el = document.createElement('span');
      el.className = UNAVAILABLE_INDICATOR_CSS_CLASS;
      el.dataset['reasonCode'] = status.reasonCode;
      el.textContent = `Chat temporarily unavailable (${status.reasonCode})`;
      statusRegion.appendChild(el);
    } else {
      statusRegion.dataset['status'] = 'ready';
      statusRegion.hidden = true;
    }
  }

  function closeSubscriptions(): void {
    try {
      deltaUnsubscribe?.();
    } catch {
      // Never let unsubscribe errors escape.
    }
    try {
      invalidationUnsubscribe?.();
    } catch {
      // Same.
    }
    deltaUnsubscribe = null;
    invalidationUnsubscribe = null;
  }

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    // Cancel any pending coalesced reconcile; the refresh will replace
    // timeline state wholesale and run its own synchronous reconcile.
    renderScheduler.cancelPending();
    const next = loadInitialPage(currentScope, 'refresh');
    readyPromise = next;
    return next;
  }

  async function switchScope(scope: ChatProjectionScopeV1): Promise<void> {
    if (disposed) return;
    if (scopesEqual(currentScope, scope)) return;
    closeSubscriptions();
    // Drop any pending coalesced reconcile from the retired scope so
    // the new scope starts on a clean scheduler slot. The scoped guard
    // inside `reconcileWork` would also skip it, but cancelling avoids
    // even the wasted flush callback.
    renderScheduler.cancelPending();
    currentScope = freezeScope(scope);
    // Reset render state so stale identity does not bleed into the new scope.
    updateStatus({ kind: 'pending' });
    resetTimelineState();
    openSubscriptions(currentScope);
    const next = loadInitialPage(currentScope, 'scope-switch');
    readyPromise = next;
    await next;
  }

  function dispose(reason: ProjectionDisposeReason = 'manual'): void {
    if (disposed) return;
    disposed = true;
    closeSubscriptions();
    // Only dispose the scheduler when this shell owns it. Callers that
    // injected a shared scheduler retain ownership and disposal.
    if (ownsRenderScheduler) {
      renderScheduler.dispose();
    }
    if (lifecycleTarget !== null) {
      lifecycleTarget.removeEventListener('beforeunload', lifecycleHandler);
      lifecycleTarget.removeEventListener('pagehide', lifecycleHandler);
    }
    void reason; // reason is informational; expose via handle if needed later.
    shell.remove();
    shell.replaceChildren();
    state.nodes.clear();
    state.compositions.clear();
    state.orderedNodeKeys.length = 0;
    state.turnGroups.clear();
    localState.disclosure.clear();
    localState.focusTarget = null;
    localState.detailSelection = null;
    localState.scrollAnchor = null;
  }

  return {
    element: shell,
    timelineElement: timeline,
    composerSlot,
    statusRegion,
    currentScope(): ChatProjectionScopeV1 {
      return currentScope;
    },
    currentStatus(): ProjectionRenderStatus {
      return currentStatus;
    },
    currentLocalState(): RendererLocalState {
      return {
        disclosure: new Map(localState.disclosure),
        focusTarget: localState.focusTarget,
        detailSelection: localState.detailSelection,
        scrollAnchor: localState.scrollAnchor,
      };
    },
    setDisclosure(stableKey: string, expanded: boolean): void {
      if (disposed) return;
      localState.disclosure.set(stableKey, expanded);
    },
    setFocus(stableKey: string | null): void {
      if (disposed) return;
      localState.focusTarget = stableKey;
    },
    setDetailSelection(stableKey: string | null): void {
      if (disposed) return;
      localState.detailSelection = stableKey;
    },
    setScrollAnchor(stableKey: string | null): void {
      if (disposed) return;
      localState.scrollAnchor = stableKey;
    },
    setReadingBounds(next: ShellLayoutBounds): void {
      if (disposed) return;
      applyReadingBoundsToSkeleton(skeleton, next);
    },
    whenReady(): Promise<void> {
      return readyPromise;
    },
    refresh,
    switchScope,
    dispose,
  };
}

function resolveLifecycleTarget(
  provided: EventTarget | null | undefined,
): EventTarget | null {
  if (provided === null) return null;
  if (provided !== undefined) return provided;
  if (typeof globalThis !== 'undefined') {
    const globalWindow = (globalThis as { window?: EventTarget }).window;
    if (globalWindow) return globalWindow;
  }
  return null;
}
