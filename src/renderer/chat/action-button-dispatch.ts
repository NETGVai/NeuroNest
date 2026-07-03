/**
 * Action Button Dispatch — wires inline action button clicks through
 * the message dispatch pipeline.
 *
 * When a user clicks an inline action button (confirm, cancel, or multi-choice),
 * this module:
 *   1. Sends the response text as a user message via the `chat:send-message` IPC channel
 *   2. Marks the button group as resolved with the appropriate visual state
 *
 * The submitted text appears in chat history as a regular user message,
 * matching the behavior of manually typed responses.
 *
 * Validates: Requirements 3.1, 3.2, 3.5, 12.4
 */

import { ipcInvoke } from '../services/ipc-client';
import type { ActionCallback, ButtonGroupInstance } from '../types/action-buttons';
import type { ActionButtonRenderer } from '../services/action-button-renderer';

// ─── IPC Channel ────────────────────────────────────────────────

const SEND_MESSAGE_CHANNEL = 'chat:send-message';

// ─── Types ──────────────────────────────────────────────────────

/** Payload sent to the main process when dispatching a message. */
interface SendMessagePayload {
  roomId: string;
  content: string;
}

/** Options for creating an action button dispatcher. */
export interface ActionButtonDispatcherOptions {
  /** The current room ID to send messages to. */
  roomId: string;
  /** The ActionButtonRenderer instance used to resolve button groups. */
  renderer: ActionButtonRenderer;
  /** The ButtonGroupInstance to resolve after dispatch. */
  instance: ButtonGroupInstance;
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Dispatch a message from an action button click through the standard
 * chat message pipeline via IPC.
 *
 * The message appears in chat history as a regular user message.
 *
 * @param content - The response text to send (e.g., "confirm", "cancel", option text)
 * @param roomId - The chat room to send the message to
 */
export async function dispatchActionMessage(content: string, roomId: string): Promise<void> {
  const payload: SendMessagePayload = { roomId, content };
  await ipcInvoke(SEND_MESSAGE_CHANNEL, payload);
}

/**
 * Create an ActionCallback that wires button clicks to the message dispatch pipeline.
 *
 * On confirm click: dispatches the extracted response text (e.g., "confirm", "yes", "proceed")
 * On cancel click: dispatches "cancel"
 * On multi-choice click: dispatches the selected option text
 *
 * After dispatch, calls resolve() on the button group instance to mark it resolved.
 *
 * @param options - Configuration for the dispatcher
 * @returns An ActionCallback suitable for passing to ActionButtonRenderer.render()
 */
export function createActionButtonCallback(options: ActionButtonDispatcherOptions): ActionCallback {
  const { roomId, renderer, instance } = options;

  const onAction: ActionCallback = (responseText: string, action: 'confirm' | 'cancel' | 'option') => {
    // Determine the text to dispatch
    const messageText = action === 'cancel' ? 'cancel' : responseText;

    // Send the message through the standard IPC pipeline.
    // The dispatch is fire-and-forget from the UI perspective — the button
    // group is resolved synchronously to prevent duplicate clicks, while
    // the IPC call completes asynchronously.
    dispatchActionMessage(messageText, roomId);

    // Resolve the button group visually: highlight the selected button, dim others
    const resolveAction = action === 'cancel' ? 'cancel' : 'confirm';
    renderer.resolve(instance, resolveAction);
  };

  return onAction;
}

/**
 * Create a standalone onAction callback for use when the ButtonGroupInstance
 * is created inline (i.e., the instance is returned from render() and the
 * callback is provided at render time).
 *
 * This is the primary integration pattern: the onAction callback is passed to
 * ActionButtonRenderer.render(), and the renderer internally calls it on button click.
 * Since the renderer already handles state transitions (disabling buttons) within
 * the click handler, this callback only needs to dispatch the message and resolve.
 *
 * @param roomId - The chat room to send the message to
 * @param renderer - The ActionButtonRenderer for resolving the button group
 * @returns A factory that creates the onAction callback, accepting the instance after render
 */
export function createOnActionFactory(
  roomId: string,
  renderer: ActionButtonRenderer,
): (instance: ButtonGroupInstance) => ActionCallback {
  return (instance: ButtonGroupInstance): ActionCallback => {
    return (responseText: string, action: 'confirm' | 'cancel' | 'option') => {
      // Dispatch the appropriate text:
      // - confirm: send the extracted response text (e.g., "confirm", "yes", "proceed")
      // - cancel: send "cancel"
      // - option (multi-choice): send the selected option text
      const messageText = action === 'cancel' ? 'cancel' : responseText;

      // Fire the IPC call to send the message as a user message
      dispatchActionMessage(messageText, roomId);

      // Mark the button group as resolved with visual feedback
      const resolveAction = action === 'cancel' ? 'cancel' : 'confirm';
      renderer.resolve(instance, resolveAction);
    };
  };
}

/**
 * Create a simple onAction callback for direct use with ActionButtonRenderer.render().
 *
 * This is the simplest integration point — pass it directly as the onAction parameter.
 * The renderer handles button disabling internally; this callback dispatches the
 * message and resolves the button group after dispatch.
 *
 * Usage:
 * ```typescript
 * const onAction = createDispatchCallback(roomId);
 * const instance = renderer.render(messageEl, detection, onAction);
 * ```
 *
 * Note: Since resolve() requires the instance which is returned from render(),
 * use createOnActionFactory() when you need post-render resolution, or
 * handle resolution externally.
 *
 * @param roomId - The chat room to send the message to
 * @returns An ActionCallback that dispatches the response text via IPC
 */
export function createDispatchCallback(roomId: string): ActionCallback {
  return (responseText: string, action: 'confirm' | 'cancel' | 'option') => {
    const messageText = action === 'cancel' ? 'cancel' : responseText;
    dispatchActionMessage(messageText, roomId);
  };
}
