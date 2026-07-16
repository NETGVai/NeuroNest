/**
 * ActionContextBridge — enriches chat messages with action context when
 * the user clicks a Confirm/Cancel button on an agent response.
 *
 * Problem solved:
 * When an agent presents a confirm/cancel choice and the user clicks "Confirm",
 * the bare word "confirm" is sent as a chat message. The pipeline then treats it
 * as an ambiguous freeform prompt. This bridge captures the preceding agent
 * proposal and attaches it as structured `actionContext` on the message so the
 * pipeline can interpret the confirmation correctly.
 *
 * Usage:
 * 1. When rendering action buttons, call `captureProposal(messageId, proposalText)`
 * 2. When the user clicks Confirm/Cancel, call `buildActionMessage(action, responseText)`
 *    which returns the full message object with actionContext attached
 * 3. Send the enriched message via `electronAPI.send('chat-message', enrichedMsg)`
 */

// ─── Types ──────────────────────────────────────────────────────

export interface ActionContext {
  /** The action taken: 'confirm' or 'cancel' */
  action: 'confirm' | 'cancel';
  /** The agent's proposal text that the user is responding to */
  proposal: string;
  /** ID of the message containing the proposal */
  messageId: string;
  /** Timestamp of the action */
  timestamp: number;
}

export interface EnrichedChatMessage {
  message: string;
  actionContext: ActionContext;
  projectId?: string;
}

// ─── State ──────────────────────────────────────────────────────

/** Map of message IDs to their proposal text (last N messages) */
const proposalCache = new Map<string, string>();
const MAX_CACHE_SIZE = 20;

/** The most recent proposal (for cases where messageId is not available) */
let lastProposal: { messageId: string; text: string } | null = null;

// ─── API ────────────────────────────────────────────────────────

/**
 * Capture the agent's proposal text when action buttons are rendered.
 * Call this when PromptDetector finds a confirm/cancel pattern.
 *
 * @param messageId - The message element ID or unique identifier
 * @param proposalText - The full text of the agent's response containing the proposal
 */
export function captureProposal(messageId: string, proposalText: string): void {
  // Trim to the relevant proposal portion (last ~500 chars before the confirm/cancel)
  const trimmed = proposalText.length > 1000
    ? proposalText.slice(-1000)
    : proposalText;

  proposalCache.set(messageId, trimmed);
  lastProposal = { messageId, text: trimmed };

  // Prune old entries
  if (proposalCache.size > MAX_CACHE_SIZE) {
    const firstKey = proposalCache.keys().next().value;
    if (firstKey) proposalCache.delete(firstKey);
  }
}

/**
 * Build an enriched chat message with action context.
 * Call this from the onAction callback when the user clicks Confirm/Cancel.
 *
 * @param action - 'confirm' or 'cancel'
 * @param responseText - The response text from the button (e.g., "yes", "confirm")
 * @param messageId - Optional message ID to look up the proposal
 * @returns Enriched message object ready to send via chat-message IPC
 */
export function buildActionMessage(
  action: 'confirm' | 'cancel',
  responseText: string,
  messageId?: string,
): EnrichedChatMessage {
  // Look up the proposal from the cache
  let proposal = '';
  if (messageId && proposalCache.has(messageId)) {
    proposal = proposalCache.get(messageId)!;
  } else if (lastProposal) {
    proposal = lastProposal.text;
  }

  return {
    message: responseText || action,
    actionContext: {
      action,
      proposal,
      messageId: messageId || lastProposal?.messageId || '',
      timestamp: Date.now(),
    },
  };
}

/**
 * Check if there's a pending proposal that hasn't been resolved yet.
 */
export function hasPendingProposal(): boolean {
  return lastProposal !== null;
}

/**
 * Clear the proposal cache (e.g., on session change).
 */
export function clearProposals(): void {
  proposalCache.clear();
  lastProposal = null;
}

// ─── Window export for vanilla JS renderer files ────────────────

if (typeof globalThis !== 'undefined' && 'document' in globalThis) {
  (globalThis as any)._actionContextBridge = {
    captureProposal,
    buildActionMessage,
    hasPendingProposal,
    clearProposals,
  };
}
