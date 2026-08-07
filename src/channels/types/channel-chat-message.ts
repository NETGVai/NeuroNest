// ─── Channel Chat Message Types ─────────────────────────────────
// Extended chat-response payload structure for channel relay display.
// These types are shared between the main process (IPC sender) and
// the renderer (chat panel display).
//
// @satisfies REQ 3.1, 3.2, 3.3, 3.4, 3.5

/**
 * Source metadata for a message received from an external channel.
 * Displayed as a channel badge (emoji + name) on inbound messages.
 */
export interface ChannelSource {
  /** The adapter's channelId (e.g. 'signal', 'notion'). */
  channelId: string;
  /** Human-readable channel name (e.g. 'Signal', 'Notion'). */
  displayName: string;
  /** Channel emoji for visual identification (e.g. '📱', '📝'). */
  emoji: string;
  /** The sender identifier on the external channel. */
  from: string;
}

/**
 * Relay metadata for a response that was sent to an external channel.
 * Displayed as a relay indicator badge after delivery confirmation.
 */
export interface RelayTarget {
  /** The adapter's channelId (e.g. 'signal', 'notion'). */
  channelId: string;
  /** Human-readable channel name (e.g. 'Signal', 'Notion'). */
  displayName: string;
  /** Channel emoji for visual identification (e.g. '📱', '📝'). */
  emoji: string;
  /** Whether the delivery was successful. */
  success: boolean;
}

/**
 * Extended chat-response IPC payload with channel relay display metadata.
 * Extends the existing payload structure (role, content, agent, isCommand)
 * with optional channelSource and relayTarget fields.
 *
 * When `channelSource` is present, the chat panel renders a source badge.
 * When `relayTarget` is present, the chat panel renders a relay indicator.
 * When `isChannelStreaming` is true, a streaming progress indicator is shown.
 */
export interface ChannelChatMessage {
  role: 'user' | 'assistant';
  content: string;
  agent?: string;
  isCommand?: boolean;
  /** Source metadata for inbound channel messages. @satisfies REQ 3.1 */
  channelSource?: ChannelSource;
  /** Relay metadata for outbound responses. @satisfies REQ 3.2, REQ 3.3 */
  relayTarget?: RelayTarget;
  /** Whether this is a channel-sourced message (for visual distinction). @satisfies REQ 3.5 */
  isChannelMessage?: boolean;
  /** Whether the AI is currently streaming a response for this channel message. @satisfies REQ 3.4 */
  isChannelStreaming?: boolean;
}
