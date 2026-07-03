import { renderMarkdown } from './format-engine';
import { PromptDetector } from './services/prompt-detector';
import { ActionButtonRenderer } from './services/action-button-renderer';
import { ButtonGroupManager } from './services/button-group-manager';
import { dispatchMessage } from './chat/message-dispatcher';
import { showToast } from './components/toast';
import type { MessageDispatcherContext } from './chat/message-dispatcher';
import type { ActionCallback } from './types/action-buttons';

// ---------------------------------------------------------------------------
// Module-level service singletons — persist across calls
// ---------------------------------------------------------------------------

const promptDetector = new PromptDetector();
const actionButtonRenderer = new ActionButtonRenderer();
const buttonGroupManager = new ButtonGroupManager();

/**
 * Module-level dispatcher context. Must be set via `setDispatcherContext()`
 * before button clicks can dispatch messages. If not set, button actions
 * fall back to a no-op with a console warning.
 */
let dispatcherContext: MessageDispatcherContext | null = null;

/**
 * Set the MessageDispatcherContext used by inline action button clicks.
 * Call this once during app initialization (when the Phase 3 GUI substrate
 * wires up its context). Until called, button clicks will log a warning.
 */
export function setDispatcherContext(ctx: MessageDispatcherContext): void {
  dispatcherContext = ctx;
}

/**
 * Get the module-level ButtonGroupManager instance.
 * Used by external code (e.g., chat input handlers) to call onManualInput()
 * or disableAll() when new agent messages arrive.
 */
export function getButtonGroupManager(): ButtonGroupManager {
  return buttonGroupManager;
}

/**
 * Optional reference to the SpecOrchestrator for session cleanup.
 * Set via `setSpecOrchestrator()` during app initialization.
 */
let specOrchestratorRef: { cancel(): void } | null = null;

/**
 * Set a reference to the SpecOrchestrator for session cleanup.
 * Call this during app initialization when the orchestrator is available.
 */
export function setSpecOrchestrator(orchestrator: { cancel(): void }): void {
  specOrchestratorRef = orchestrator;
}

/**
 * Clean up all active button groups and cancel spec mode on session end.
 * Call this when the chat session is terminated or reset.
 *
 * Validates: Requirements 7.3
 */
export function onSessionEnd(): void {
  buttonGroupManager.removeAll();
  if (specOrchestratorRef) {
    specOrchestratorRef.cancel();
  }
}

/**
 * Represents an active streaming session for an incoming message.
 */
export interface StreamSession {
  /** The DOM element whose .message-body is being updated */
  messageEl: HTMLElement;
  /** Accumulated raw markdown text so far */
  buffer: string;
  /** Whether user has scrolled away from bottom */
  userScrolledUp: boolean;
  /** Timestamp of last render (for throttling) */
  lastRenderTime: number;
  /** Pending throttled render timer */
  renderTimer: number | null;
  /** Whether the cursor animation is displayed */
  cursorVisible: boolean;
  /** Whether the session has been cancelled via stop button */
  cancelled: boolean;
  /** Sequence-based token buffer for out-of-order delivery */
  tokenBuffer: Map<number, string>;
  /** Next expected sequence number */
  nextSeq: number;
}

export const THROTTLE_MS = 50;
export const SCROLL_THRESHOLD = 50;
export const CURSOR_CLASS = 'streaming-cursor';

/**
 * Start a new streaming session for an incoming message.
 * Initializes the buffer, scroll tracking, cursor, and token ordering state.
 */
export function startStream(messageEl: HTMLElement): StreamSession {
  const session: StreamSession = {
    messageEl,
    buffer: '',
    userScrolledUp: false,
    lastRenderTime: 0,
    renderTimer: null,
    cursorVisible: true,
    cancelled: false,
    tokenBuffer: new Map(),
    nextSeq: 0,
  };

  // Show the cursor animation at stream start
  showCursor(session);

  return session;
}

/**
 * Append a text chunk to the stream and re-render with throttling.
 * Re-renders the full accumulated buffer through renderMarkdown(),
 * throttled to at most once per 50ms to avoid layout thrashing.
 *
 * If the session has been cancelled, the chunk is silently discarded.
 */
export function appendChunk(session: StreamSession, chunk: string): void {
  if (session.cancelled) return;

  session.buffer += chunk;

  const now = Date.now();
  const elapsed = now - session.lastRenderTime;

  if (elapsed >= THROTTLE_MS) {
    // Enough time has passed — render immediately
    if (session.renderTimer !== null) {
      clearTimeout(session.renderTimer);
      session.renderTimer = null;
    }
    renderSession(session);
  } else if (session.renderTimer === null) {
    // Schedule a deferred render for the remaining throttle window
    const delay = THROTTLE_MS - elapsed;
    session.renderTimer = window.setTimeout(() => {
      session.renderTimer = null;
      renderSession(session);
    }, delay);
  }
  // If a timer is already pending, do nothing — it will pick up the latest buffer
}

/**
 * Append a sequenced token to the stream, handling out-of-order delivery.
 * Tokens arriving out of order are buffered and flushed once the gap is filled.
 */
export function appendToken(session: StreamSession, seq: number, token: string): void {
  if (session.cancelled) return;

  if (seq === session.nextSeq) {
    // In-order token — append directly and flush any consecutive buffered tokens
    appendChunk(session, token);
    session.nextSeq++;

    // Flush buffered tokens that are now in sequence
    while (session.tokenBuffer.has(session.nextSeq)) {
      const buffered = session.tokenBuffer.get(session.nextSeq)!;
      session.tokenBuffer.delete(session.nextSeq);
      appendChunk(session, buffered);
      session.nextSeq++;
    }
  } else if (seq > session.nextSeq) {
    // Out-of-order token — buffer it for later
    session.tokenBuffer.set(seq, token);
  }
  // seq < nextSeq means duplicate/already processed — silently discard
}

/**
 * Cancel the streaming session (triggered by stop button).
 * Stops accepting new tokens, removes cursor, and cleans up timers.
 */
export function cancelStream(session: StreamSession): void {
  session.cancelled = true;

  // Clear any pending render timer
  if (session.renderTimer !== null) {
    clearTimeout(session.renderTimer);
    session.renderTimer = null;
  }

  // Remove cursor
  hideCursor(session);

  // Do a final render of whatever we have so far
  renderSession(session);
}

/**
 * Finalize the stream — cancel any pending throttled render,
 * do one final unthrottled render, remove the cursor, and
 * detect confirmation prompts for inline action buttons.
 *
 * After rendering completes, the full text buffer is analyzed by the
 * PromptDetector. If a confirmation prompt is found, action buttons are
 * rendered into the message element and registered with the ButtonGroupManager.
 *
 * Validates: Requirements 1.1, 2.1, 2.6, 3.1, 3.2
 */
export function finalizeStream(session: StreamSession): void {
  if (session.renderTimer !== null) {
    clearTimeout(session.renderTimer);
    session.renderTimer = null;
  }

  // Remove cursor on completion
  hideCursor(session);

  renderSession(session);

  // Skip prompt detection for cancelled streams
  if (session.cancelled) return;

  // Analyze the finalized text buffer for confirmation prompts
  const detection = promptDetector.detect(session.buffer);
  if (!detection) return;

  // Disable all previously active button groups before rendering new ones.
  // This ensures that when a new agent message arrives with a prompt,
  // any prior button groups are invalidated first (Requirement 7.2).
  buttonGroupManager.disableAll();

  // Build the onAction callback that dispatches the response text.
  // The first click synchronously sets instance.state before the async dispatch,
  // preventing duplicate submissions from rapid clicks (Requirement 3.3).
  const onAction: ActionCallback = (responseText, _action) => {
    if (!dispatcherContext) {
      console.warn(
        '[stream-renderer] dispatcherContext not set — cannot dispatch action button response. ' +
        'Call setDispatcherContext() during app initialization.',
      );
      return;
    }
    dispatchMessage(responseText, dispatcherContext).catch((err) => {
      console.error('[stream-renderer] Failed to dispatch action button response:', err);
      // Show error toast so the user knows the dispatch failed
      showToast({
        message: 'Failed to send response. Please try again.',
        level: 'error',
        duration: 5000,
      });
      // Re-enable the button group for retry on dispatch failure
      if (instance.state !== 'active') {
        instance.state = 'active';
        const buttons = instance.containerEl.querySelectorAll('button');
        buttons.forEach((btn) => {
          (btn as HTMLButtonElement).disabled = false;
          btn.removeAttribute('aria-disabled');
        });
      }
    });
  };

  // Render action buttons into the message element
  const instance = detection.type === 'multi-choice' && detection.options
    ? actionButtonRenderer.renderMultiChoice(session.messageEl, detection.options, onAction)
    : actionButtonRenderer.render(session.messageEl, detection, onAction);

  // Register with the ButtonGroupManager for lifecycle management
  buttonGroupManager.register(instance);
}

/**
 * Show the blinking cursor element at the end of the message body.
 */
function showCursor(session: StreamSession): void {
  session.cursorVisible = true;
  const body = session.messageEl.querySelector('.message-body') as HTMLElement | null;
  if (!body) return;

  // Add cursor element if not present
  let cursor = body.querySelector(`.${CURSOR_CLASS}`) as HTMLElement | null;
  if (!cursor) {
    cursor = document.createElement('span');
    cursor.className = CURSOR_CLASS;
    body.appendChild(cursor);
  }
}

/**
 * Remove the cursor element from the message body.
 */
function hideCursor(session: StreamSession): void {
  session.cursorVisible = false;
  const body = session.messageEl.querySelector('.message-body') as HTMLElement | null;
  if (!body) return;

  const cursor = body.querySelector(`.${CURSOR_CLASS}`);
  if (cursor) {
    cursor.remove();
  }
}

/**
 * Internal: render the current buffer into the message element
 * and handle auto-scroll behavior.
 */
function renderSession(session: StreamSession): void {
  const body = session.messageEl.querySelector('.message-body') as HTMLElement | null;
  if (!body) return;

  const html = renderMarkdown(session.buffer);
  body.innerHTML = html;

  // Re-attach cursor if still streaming
  if (session.cursorVisible) {
    const cursor = document.createElement('span');
    cursor.className = CURSOR_CLASS;
    body.appendChild(cursor);
  }

  session.lastRenderTime = Date.now();

  // Auto-scroll: find the scrollable container (parent of the message element)
  const scrollContainer = session.messageEl.parentElement;
  if (scrollContainer) {
    // Detect if user has scrolled up
    const distanceFromBottom =
      scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
    session.userScrolledUp = distanceFromBottom >= SCROLL_THRESHOLD;

    if (!session.userScrolledUp) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  }
}
