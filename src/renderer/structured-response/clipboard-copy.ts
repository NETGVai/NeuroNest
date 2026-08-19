/**
 * Exact-source clipboard helper for structured-response surfaces.
 *
 * Task 10.5 (enhanced-chat-ui) — a single copy path used by every canonical
 * surface (code, narrative, response-group toolbar). The helper:
 *
 *   1. Accepts the exact-source string retained in the block descriptor
 *      (`CodeBlockV1.content.code`, `NarrativeBlockV1.content.text`, or the
 *      projection-supplied narrative text at the response-group level).
 *      It NEVER receives DOM `textContent` or highlighted HTML — those
 *      reconstructions are prohibited by requirement 10.9.
 *   2. Writes to the clipboard through `navigator.clipboard.writeText` only.
 *      There is no `document.execCommand('copy')` fallback (requirement
 *      10.10; audit-unsafe-behavior regression 1). When the async API is
 *      unavailable or rejects, the helper reports failure through the
 *      supplied {@link ClipboardCopyFeedback} channel and returns a typed
 *      failure result.
 *   3. Announces success on a polite `role="status"` live region and
 *      failure on an assertive `role="alert"` live region so screen-reader
 *      users are told what happened (requirements 14.4–14.6).
 *
 * The helper is deliberately narrow. It has no notion of retry, feedback
 * ratings, or authority routing — those live in
 * {@link './response-action-router'}. Surfaces that need only the clipboard
 * write plus its accessible feedback consume this module directly and pass
 * their own {@link ClipboardCopyFeedback} implementation (typically the same
 * live-region pair used by the response-action router).
 *
 * Requirements: 10.9, 10.10, 14.4, 14.5, 14.6
 *
 * @module src/renderer/structured-response/clipboard-copy
 */

// ─── Clipboard adapter ─────────────────────────────────────────

/**
 * Minimal clipboard surface consumed by {@link copyExactSourceToClipboard}.
 * Defaults to `navigator.clipboard.writeText`; tests inject a stub so the
 * helper is observable without touching the real OS clipboard.
 *
 * The interface intentionally omits `readText`, `write`, and `read` — the
 * copy path only needs to place a canonical string on the clipboard. Any
 * broader clipboard access is an escalation of scope that should live on a
 * different, purpose-built adapter.
 */
export interface ClipboardAdapter {
  writeText(text: string): Promise<void>;
}

/**
 * Resolve the default clipboard adapter from `navigator.clipboard`. Returns
 * `null` when no async clipboard API is available — the helper reports this
 * as a failure through the feedback channel rather than falling back to
 * `document.execCommand`.
 */
export function defaultClipboardAdapter(): ClipboardAdapter | null {
  if (typeof navigator === 'undefined') return null;
  const clip = navigator.clipboard;
  if (!clip || typeof clip.writeText !== 'function') return null;
  return {
    writeText: (text: string) => clip.writeText(text),
  };
}

// ─── Feedback surface ──────────────────────────────────────────

/**
 * Accessible feedback channel used to announce copy outcomes. The
 * `announceStatus` message goes to a polite `role="status"` region and
 * describes success. The `announceAlert` message goes to an assertive
 * `role="alert"` region and describes failure so the user knows to retry.
 *
 * This is a structural subset of the router's
 * `ResponseActionFeedbackSurface`: any object that satisfies this contract
 * (including the response-group live-region pair) can be passed in. Keeping
 * the interface narrow lets surfaces reuse the existing live regions
 * without dragging in feedback-rating state.
 */
export interface ClipboardCopyFeedback {
  announceStatus(message: string): void;
  announceAlert(message: string): void;
}

// ─── Failure taxonomy ──────────────────────────────────────────

/**
 * Reasons the copy helper can report a failure. Every value is
 * translation-key stable — surfaces map it to their own message text as
 * needed. `unknown_error` is the fallback for a rejection whose Error type
 * cannot be classified.
 */
export type ClipboardCopyFailureReason =
  | 'clipboard_unavailable'
  | 'empty_content'
  | 'permission_denied'
  | 'unknown_error';

/**
 * Structured outcome of a copy attempt. Success carries the exact string
 * that was placed on the clipboard so callers can render a visible
 * confirmation ("Copied 128 characters") without re-reading the source.
 */
export type ClipboardCopyResult =
  | { readonly success: true; readonly copiedText: string }
  | {
      readonly success: false;
      readonly failureReason: ClipboardCopyFailureReason;
      readonly errorName?: string;
    };

// ─── Canonical presentation messages ───────────────────────────

/**
 * Presentation-layer copy messages used by every surface that copies a raw
 * code block. Announced through the live-status / live-alert channel;
 * never rendered as untrusted content.
 */
export const CLIPBOARD_COPY_MESSAGES = Object.freeze({
  code: Object.freeze({
    success: 'Code copied to clipboard.',
    failure: 'Copy failed. The code is still available in the block.',
  }),
  narrative: Object.freeze({
    success: 'Message copied to clipboard.',
    failure: 'Copy failed. The message is still available.',
  }),
  response: Object.freeze({
    success: 'Response copied to clipboard.',
    failure: 'Copy failed. The response is still available.',
  }),
} as const);

export type ClipboardCopySurfaceKind = keyof typeof CLIPBOARD_COPY_MESSAGES;

// ─── Helper implementation ─────────────────────────────────────

/**
 * Options for a single {@link copyExactSourceToClipboard} invocation.
 *
 * `exactSource` MUST be the canonical string retained by the block
 * descriptor. Passing DOM `textContent` or highlighted HTML would silently
 * bypass the audit's exact-source contract and is prohibited.
 */
export interface CopyExactSourceOptions {
  /**
   * The canonical raw string that must be placed on the clipboard. Always
   * read from the block descriptor's original field (code, text,
   * narrativeText), never from a rendered DOM element.
   */
  readonly exactSource: string;
  /** Live-region feedback channel. Required — silent copy is prohibited. */
  readonly feedback: ClipboardCopyFeedback;
  /**
   * Surface-specific message set. Selects which pair of `success` / `failure`
   * strings the helper announces. Defaults to the generic response wording
   * so unknown surface kinds still produce a working announcement.
   */
  readonly surfaceKind?: ClipboardCopySurfaceKind;
  /**
   * Clipboard adapter override. Defaults to
   * {@link defaultClipboardAdapter}. Tests inject a stub; production
   * callers should not override this.
   */
  readonly clipboard?: ClipboardAdapter | null;
}

/**
 * Copy the descriptor-provided `exactSource` to the clipboard and announce
 * the outcome on the supplied live-region channel.
 *
 * The function is safe to call from any surface — it never throws. Every
 * failure path returns a typed {@link ClipboardCopyResult} and emits an
 * assertive alert message describing what went wrong. Success emits a
 * polite status message. The helper does not manage focus or visible
 * button-state; those concerns stay in the caller so surface-specific
 * ergonomics (colour, timing, aria attributes on the button) remain the
 * surface's responsibility.
 */
export async function copyExactSourceToClipboard(
  options: CopyExactSourceOptions,
): Promise<ClipboardCopyResult> {
  const { exactSource, feedback } = options;
  const surfaceKind: ClipboardCopySurfaceKind = options.surfaceKind ?? 'response';
  const messages = CLIPBOARD_COPY_MESSAGES[surfaceKind];
  const clipboard =
    options.clipboard === undefined ? defaultClipboardAdapter() : options.clipboard;

  if (typeof exactSource !== 'string' || exactSource.length === 0) {
    feedback.announceAlert(messages.failure);
    return { success: false, failureReason: 'empty_content' };
  }

  if (clipboard === null) {
    feedback.announceAlert(messages.failure);
    return { success: false, failureReason: 'clipboard_unavailable' };
  }

  try {
    await clipboard.writeText(exactSource);
    feedback.announceStatus(messages.success);
    return { success: true, copiedText: exactSource };
  } catch (err) {
    feedback.announceAlert(messages.failure);
    const failureReason = classifyClipboardError(err);
    const errorName = err instanceof Error ? err.name : undefined;
    return errorName !== undefined
      ? { success: false, failureReason, errorName }
      : { success: false, failureReason };
  }
}

// ─── Error classification ──────────────────────────────────────

/**
 * Map a rejection from `navigator.clipboard.writeText` to a stable failure
 * class. `NotAllowedError` is the DOM name for permission denial; other
 * error names fall through to `unknown_error` so downstream telemetry can
 * still learn the raw name via `errorName`.
 */
function classifyClipboardError(err: unknown): ClipboardCopyFailureReason {
  if (err instanceof Error) {
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
      return 'permission_denied';
    }
  }
  return 'unknown_error';
}
