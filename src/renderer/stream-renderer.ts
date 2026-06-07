import { renderMarkdown } from './format-engine';

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
}

const THROTTLE_MS = 50;
const SCROLL_THRESHOLD = 50;

/**
 * Start a new streaming session for an incoming message.
 * Initializes the buffer and scroll tracking state.
 */
export function startStream(messageEl: HTMLElement): StreamSession {
  return {
    messageEl,
    buffer: '',
    userScrolledUp: false,
    lastRenderTime: 0,
    renderTimer: null,
  };
}

/**
 * Append a text chunk to the stream and re-render with throttling.
 * Re-renders the full accumulated buffer through renderMarkdown(),
 * throttled to at most once per 50ms to avoid layout thrashing.
 */
export function appendChunk(session: StreamSession, chunk: string): void {
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
 * Finalize the stream — cancel any pending throttled render and
 * do one final unthrottled render for completeness.
 */
export function finalizeStream(session: StreamSession): void {
  if (session.renderTimer !== null) {
    clearTimeout(session.renderTimer);
    session.renderTimer = null;
  }
  renderSession(session);
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
