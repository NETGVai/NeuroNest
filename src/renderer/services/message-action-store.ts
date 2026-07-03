/**
 * MessageActionStore — stores and retrieves MessageActionMeta for resolved prompts.
 *
 * Maintains an in-memory map keyed by message ID, enabling re-rendering of
 * historical messages with their original button group state (disabled with
 * the selected button visually indicated).
 *
 * Also provides `renderHistoricalActionButtons` which reads stored meta for a
 * message and renders the button group in its resolved/disabled state.
 *
 * Validates: Requirements 7.4
 */

import type { MessageActionMeta } from '../types/action-buttons';
import { ActionButtonRenderer } from './action-button-renderer';

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const store = new Map<string, MessageActionMeta>();

/**
 * Store action metadata for a message.
 * Overwrites any previously stored meta for the same message ID.
 */
export function storeActionMeta(messageId: string, meta: MessageActionMeta): void {
  store.set(messageId, meta);
}

/**
 * Retrieve stored action metadata for a message.
 * Returns null if no meta exists for the given message ID.
 */
export function getActionMeta(messageId: string): MessageActionMeta | null {
  return store.get(messageId) ?? null;
}

/**
 * Remove stored action metadata for a message.
 */
export function clearActionMeta(messageId: string): void {
  store.delete(messageId);
}

// ---------------------------------------------------------------------------
// Historical Rendering
// ---------------------------------------------------------------------------

/**
 * Render a historical (already-resolved) button group for a message.
 *
 * Reads the stored MessageActionMeta for the given messageId. If meta exists
 * and has a detection result:
 *  1. Renders the button group via ActionButtonRenderer
 *  2. Immediately disables the instance (since it's historical)
 *  3. If a resolution exists, calls resolve() to highlight the selected button
 *
 * No-ops if no meta exists or if the detection is null.
 */
export function renderHistoricalActionButtons(
  messageEl: HTMLElement,
  messageId: string
): void {
  const meta = getActionMeta(messageId);
  if (!meta || !meta.detection) {
    return;
  }

  const renderer = new ActionButtonRenderer();

  // Render the button group (no-op callback since it's historical)
  const instance = renderer.render(messageEl, meta.detection, () => {});

  if (meta.resolution) {
    // Resolve with the stored action to highlight the selected button
    const selectedAction = meta.resolution.action === 'cancel' ? 'cancel' : 'confirm';
    renderer.resolve(instance, selectedAction);
  } else {
    // No resolution — just disable the buttons
    renderer.disable(instance);
  }
}
