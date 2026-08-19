/**
 * Response-group action router.
 *
 * Wires the projection-driven chat shell's `onResponseAction` callback into
 * the structured action port and a clipboard adapter with accessible
 * feedback. Copy uses the exact narrative text supplied by the projection
 * (never DOM-reconstructed) via the shared
 * {@link copyExactSourceToClipboard} helper — the same helper the code and
 * narrative surfaces call. Retry routes through
 * {@link StructuredActionPort.retryResponse}, and up/down feedback routes
 * through {@link StructuredActionPort.feedback} with optimistic pending
 * state reconciled against the returned {@link CommandTransportReceiptV1}.
 *
 * Requirements: 9.3–9.5, 10.9, 10.10, 13.8, 14.4, 14.5, 14.6
 *
 * @vitest-environment jsdom
 */

import type { CommandTransportReceiptV1 } from '../../harness/contracts/structured-command';
import {
  CLIPBOARD_COPY_MESSAGES,
  copyExactSourceToClipboard,
  type ClipboardAdapter,
  type ClipboardCopyFeedback,
} from './clipboard-copy';
import type {
  ResponseActionInvocation,
  ResponseActionKind,
} from './structured-chat-shell';
import type {
  StructuredActionPort,
  RetryResponseCommandInput,
  SubmitFeedbackCommandInput,
} from './structured-action-port';

// ─── Clipboard Adapter (re-export) ─────────────────────────────

/**
 * Minimal clipboard surface required by the router. Re-exported from the
 * shared {@link './clipboard-copy'} helper so external callers (integration
 * tests, telemetry harnesses) continue to import a single type.
 */
export type { ClipboardAdapter };

// ─── Feedback / Copy State Machine ─────────────────────────────

/** Outcome kind reported after a response action resolves. */
export type ResponseActionOutcomeKind =
  | 'copy_success'
  | 'copy_failure'
  | 'retry_delivered'
  | 'retry_rejected'
  | 'feedback_delivered'
  | 'feedback_rejected';

/**
 * Structured outcome descriptor emitted for observers (tests, telemetry,
 * live-region renderers). All strings are already authorized presentation
 * text; the router never renders untrusted content.
 */
export interface ResponseActionOutcome {
  readonly invocation: ResponseActionInvocation;
  readonly outcome: ResponseActionOutcomeKind;
  /** Optional receipt for retry/feedback outcomes; absent for copy. */
  readonly receipt?: CommandTransportReceiptV1;
  /** Optional error class for failure outcomes. */
  readonly errorCode?: string;
}

/**
 * Optimistic feedback state for one response-group's feedback action.
 * `chatNodeStableKey` identifies the response, `rating` is the pending
 * rating, and `commandId` is the port-issued command ID so a delivered or
 * rejected receipt reconciles unambiguously.
 */
export interface OptimisticFeedbackState {
  readonly chatNodeStableKey: string;
  readonly rating: 'up' | 'down';
  readonly commandId?: string;
  readonly phase: 'pending' | 'delivered' | 'rejected';
}

// ─── Live-Region Renderer ──────────────────────────────────────

/**
 * Accessible feedback surface for response actions. The router announces
 * copy success/failure and feedback delivery outcomes through this surface.
 * Copy uses `role="status"` (polite) so the announcement does not interrupt.
 * Failure outcomes use `role="alert"` (assertive) so users know to retry.
 *
 * Extends {@link ClipboardCopyFeedback} so any surface (code fence, message
 * copy, response-group toolbar) that already holds one of these can pass it
 * straight to {@link copyExactSourceToClipboard} for its own copy button.
 *
 * Requirement 14.6.
 */
export interface ResponseActionFeedbackSurface extends ClipboardCopyFeedback {
  setPendingFeedback(state: OptimisticFeedbackState | null): void;
}

/**
 * Build a live-region feedback surface backed by two DOM regions. The
 * `status` region is visually hidden but announced politely; the `alert`
 * region is announced assertively. The `pending` marker is exposed via a
 * `data-pending-feedback-*` attribute so per-response-group CSS can style
 * the pending button while the reconciliation is in flight.
 */
export function createResponseActionFeedbackSurface(
  container: HTMLElement,
): ResponseActionFeedbackSurface {
  const status = document.createElement('div');
  status.className = 'nn-response-action-feedback nn-response-action-feedback--status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  status.dataset['responseActionFeedback'] = 'status';

  const alert = document.createElement('div');
  alert.className = 'nn-response-action-feedback nn-response-action-feedback--alert';
  alert.setAttribute('role', 'alert');
  alert.setAttribute('aria-live', 'assertive');
  alert.setAttribute('aria-atomic', 'true');
  alert.dataset['responseActionFeedback'] = 'alert';

  container.appendChild(status);
  container.appendChild(alert);

  return {
    announceStatus(message: string) {
      // Clear then set so re-announcing an identical string still fires.
      status.textContent = '';
      status.textContent = message;
    },
    announceAlert(message: string) {
      alert.textContent = '';
      alert.textContent = message;
    },
    setPendingFeedback(state: OptimisticFeedbackState | null) {
      if (state === null || state.phase !== 'pending') {
        container.removeAttribute('data-pending-feedback-response');
        container.removeAttribute('data-pending-feedback-rating');
        return;
      }
      container.dataset['pendingFeedbackResponse'] = state.chatNodeStableKey;
      container.dataset['pendingFeedbackRating'] = state.rating;
    },
  };
}

// ─── Router Configuration ──────────────────────────────────────

export interface ResponseActionRouterOptions {
  /** Structured action port that owns retry/feedback dispatch. */
  readonly port: StructuredActionPort;
  /** Accessible feedback surface for copy + feedback outcomes. */
  readonly feedbackSurface: ResponseActionFeedbackSurface;
  /** Clipboard adapter used by the copy action. Defaults to `navigator.clipboard`. */
  readonly clipboard?: ClipboardAdapter | null;
  /** Optional observer for tests/telemetry. */
  readonly onOutcome?: (outcome: ResponseActionOutcome) => void;
  /** Retry strategy override; defaults to `same_route`. */
  readonly retryStrategy?: RetryResponseCommandInput['strategy'];
  /**
   * Optional correlation-ID factory. When omitted the port derives a stable
   * key from the target identity, source revision, and rating.
   */
  readonly createFeedbackCorrelationId?: (
    invocation: ResponseActionInvocation,
  ) => string | undefined;
}

// ─── Router ────────────────────────────────────────────────────

// Copy messages are canonical across every surface; the router re-exports
// them so existing tests continue to import them from this module.
const COPY_SUCCESS_MESSAGE = CLIPBOARD_COPY_MESSAGES.response.success;
const COPY_FAILURE_MESSAGE = CLIPBOARD_COPY_MESSAGES.response.failure;
const RETRY_DELIVERED_MESSAGE = 'Retry sent.';
const RETRY_REJECTED_MESSAGE = 'Retry could not be delivered. Try again.';
const FEEDBACK_DELIVERED_MESSAGES: Record<'up' | 'down', string> = {
  up: 'Thanks for the positive feedback.',
  down: 'Thanks. Your feedback has been recorded.',
};
const FEEDBACK_REJECTED_MESSAGE = 'Feedback could not be delivered. Try again.';

/**
 * Response-action router. Returned as a plain function so callers can pass it
 * to {@link ProjectionDrivenChatShellHandle} as the `onResponseAction`
 * callback. The router never throws — all failures are surfaced through the
 * feedback surface and the optional {@link ResponseActionRouterOptions.onOutcome}
 * observer.
 */
export function createResponseActionRouter(
  options: ResponseActionRouterOptions,
): (invocation: ResponseActionInvocation) => void {
  // Preserve the caller's explicit `clipboard: null` so tests can force the
  // "clipboard unavailable" branch; only when the property is omitted does
  // the helper fall back to `navigator.clipboard` on its own.
  const clipboardOverride = options.clipboard;
  const feedbackStrategy = options.retryStrategy ?? 'same_route';

  function report(outcome: ResponseActionOutcome): void {
    try {
      options.onOutcome?.(outcome);
    } catch {
      // Never let observer failures block routing.
    }
  }

  async function handleCopy(invocation: ResponseActionInvocation): Promise<void> {
    // Copy is delegated to the shared exact-source helper so every surface
    // uses one clipboard write path. `narrativeText` on the invocation is
    // the projection-supplied canonical string — the router never inspects
    // the DOM. Task 10.9 requires the exact-source contract; task 10.10
    // requires no silent execCommand fallback.
    const result = await copyExactSourceToClipboard({
      exactSource: invocation.narrativeText ?? '',
      feedback: options.feedbackSurface,
      surfaceKind: 'response',
      ...(clipboardOverride !== undefined ? { clipboard: clipboardOverride } : {}),
    });
    if (result.success) {
      report({ invocation, outcome: 'copy_success' });
      return;
    }
    // Preserve the observable errorCode taxonomy the router previously
    // emitted. `permission_denied` and `unknown_error` are both surfaced
    // through the shared helper; the router maps them to the same shape.
    const errorCode =
      result.failureReason === 'permission_denied'
        ? (result.errorName ?? 'NotAllowedError')
        : result.failureReason === 'unknown_error'
          ? (result.errorName ?? 'unknown_error')
          : result.failureReason;
    report({ invocation, outcome: 'copy_failure', errorCode });
  }

  async function handleRetry(invocation: ResponseActionInvocation): Promise<void> {
    try {
      const receipt = await options.port.retryResponse({
        chatNodeStableKey: invocation.chatNodeStableKey,
        strategy: feedbackStrategy,
      });
      if (receipt.transportStatus === 'delivered') {
        options.feedbackSurface.announceStatus(RETRY_DELIVERED_MESSAGE);
        report({ invocation, outcome: 'retry_delivered', receipt });
      } else {
        options.feedbackSurface.announceAlert(RETRY_REJECTED_MESSAGE);
        report({
          invocation,
          outcome: 'retry_rejected',
          receipt,
          ...(receipt.rejectionCode !== undefined
            ? { errorCode: receipt.rejectionCode }
            : {}),
        });
      }
    } catch (err) {
      options.feedbackSurface.announceAlert(RETRY_REJECTED_MESSAGE);
      report({
        invocation,
        outcome: 'retry_rejected',
        errorCode: err instanceof Error ? err.name : 'unknown_error',
      });
    }
  }

  async function handleFeedback(
    invocation: ResponseActionInvocation,
    kind: 'feedback_up' | 'feedback_down',
  ): Promise<void> {
    const rating: 'up' | 'down' = kind === 'feedback_up' ? 'up' : 'down';
    // Optimistic: mark pending immediately so the toolbar can reflect it.
    options.feedbackSurface.setPendingFeedback({
      chatNodeStableKey: invocation.chatNodeStableKey,
      rating,
      phase: 'pending',
    });
    const correlationId = options.createFeedbackCorrelationId?.(invocation);
    const commandInput: SubmitFeedbackCommandInput = {
      chatNodeStableKey: invocation.chatNodeStableKey,
      rating,
      ...(correlationId !== undefined ? { correlationId } : {}),
    };
    try {
      const receipt = await options.port.feedback(commandInput);
      if (receipt.transportStatus === 'delivered') {
        options.feedbackSurface.setPendingFeedback(null);
        options.feedbackSurface.announceStatus(FEEDBACK_DELIVERED_MESSAGES[rating]);
        report({ invocation, outcome: 'feedback_delivered', receipt });
      } else {
        options.feedbackSurface.setPendingFeedback(null);
        options.feedbackSurface.announceAlert(FEEDBACK_REJECTED_MESSAGE);
        report({
          invocation,
          outcome: 'feedback_rejected',
          receipt,
          ...(receipt.rejectionCode !== undefined
            ? { errorCode: receipt.rejectionCode }
            : {}),
        });
      }
    } catch (err) {
      options.feedbackSurface.setPendingFeedback(null);
      options.feedbackSurface.announceAlert(FEEDBACK_REJECTED_MESSAGE);
      report({
        invocation,
        outcome: 'feedback_rejected',
        errorCode: err instanceof Error ? err.name : 'unknown_error',
      });
    }
  }

  return (invocation: ResponseActionInvocation): void => {
    switch (invocation.kind satisfies ResponseActionKind) {
      case 'copy':
        void handleCopy(invocation);
        return;
      case 'retry':
        void handleRetry(invocation);
        return;
      case 'feedback_up':
      case 'feedback_down':
        void handleFeedback(
          invocation,
          invocation.kind as 'feedback_up' | 'feedback_down',
        );
        return;
    }
  };
}

/** Test-only export of the canonical status/alert messages. */
export const RESPONSE_ACTION_MESSAGES = Object.freeze({
  COPY_SUCCESS_MESSAGE,
  COPY_FAILURE_MESSAGE,
  RETRY_DELIVERED_MESSAGE,
  RETRY_REJECTED_MESSAGE,
  FEEDBACK_DELIVERED_MESSAGES,
  FEEDBACK_REJECTED_MESSAGE,
});
