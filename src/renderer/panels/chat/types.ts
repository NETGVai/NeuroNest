/**
 * Chat panel type definitions.
 * Defines the typed boundaries for the chat module's internal and external contracts.
 */

/** Unique identifier for a chat message. */
export type MessageId = string;

/** Unique identifier for a chat room / conversation. */
export type RoomId = string;

/** Identifies the sender of a message. */
export type SenderId = 'user' | 'assistant' | 'system';

/** Status of a message in the send lifecycle. */
export type MessageStatus = 'sending' | 'sent' | 'error';

/** A single chat message. */
export interface ChatMessage {
  id: MessageId;
  roomId: RoomId;
  sender: SenderId;
  content: string;
  timestamp: number;
  status: MessageStatus;
  /** Optional metadata attached by the assistant (e.g. model info). */
  metadata?: {
    /** Dispatch attribution — indicates where the message originated. */
    source?: 'dashboard' | 'direct';
    /** Agent display name (for dispatch-originated assistant messages). */
    agent?: string;
    /** Agent emoji from the registry (for dispatch-originated assistant messages). */
    agentEmoji?: string;
    /** Channel source metadata for inbound channel messages. @satisfies REQ 3.1 */
    channelSource?: {
      channelId: string;
      displayName: string;
      emoji: string;
      from: string;
    };
    /** Relay target metadata for outbound responses to channels. @satisfies REQ 3.2, REQ 3.3 */
    relayTarget?: {
      channelId: string;
      displayName: string;
      emoji: string;
      success: boolean;
    };
    /** Whether this is a channel-sourced message (for visual distinction). @satisfies REQ 3.5 */
    isChannelMessage?: boolean;
    /** Whether AI is streaming a response for a channel message. @satisfies REQ 3.4 */
    isChannelStreaming?: boolean;
    /** LLM reasoning/thinking content (chain of thought). */
    reasoning?: string;
    [key: string]: unknown;
  };
}

/** Represents a chat room / conversation thread. */
export interface ChatRoom {
  id: RoomId;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Number of messages in this room (for display in room list). */
  messageCount: number;
}

/** Payload received from the main process for a streaming chunk event. */
export interface StreamChunkPayload {
  /** The message ID this chunk belongs to. */
  messageId: string;
  /** The text chunk content. */
  chunk: string;
  /** First chunk — signals creation of a new assistant message placeholder. */
  start?: boolean;
  /** Agent name (provided on start). */
  agent?: string;
  /** Agent emoji (provided on start). */
  agentEmoji?: string;
  /** Source attribution for dispatch-originated streams. */
  source?: 'dashboard';
  /** Signals that the stream has completed. */
  done?: boolean;
  /** Signals a stream error with the error message. */
  error?: string;
  /** Reasoning content from LLM (delivered on stream complete or as metadata). */
  reasoning?: string;
}

/** Payload sent to the main process when the user submits a message. */
export interface SendMessageRequest {
  roomId: RoomId;
  content: string;
}

/** Response received from the main process after sending a message. */
export interface SendMessageResponse {
  success: boolean;
  message?: ChatMessage;
  error?: string;
}

/** Payload for loading message history for a room. */
export interface LoadMessagesRequest {
  roomId: RoomId;
  /** Number of messages to load (pagination). */
  limit: number;
  /** Load messages before this timestamp (for infinite scroll). */
  before?: number;
}

/** Response containing a batch of historical messages. */
export interface LoadMessagesResponse {
  messages: ChatMessage[];
  hasMore: boolean;
}

/**
 * Events emitted by the chat service layer.
 *
 * Task 13.2 (enhanced-chat-ui): after the canonical projection cutover,
 * ChatService only emits `message-received` for command-side send
 * acknowledgements. The other variants are retained on the union for
 * backward-compatible consumers; task 13.3 removes them along with the
 * transitional ChatList surface.
 */
export type ChatServiceEvent =
  | { type: 'message-received'; message: ChatMessage }
  | { type: 'message-status-changed'; messageId: MessageId; status: MessageStatus; reasoning?: string }
  | { type: 'room-created'; room: ChatRoom }
  | { type: 'room-updated'; room: ChatRoom }
  | { type: 'stream-chunk'; messageId: MessageId; chunk: string };

/** Listener callback for chat service events. */
export type ChatServiceListener = (event: ChatServiceEvent) => void;

/** Configuration for the chat input component. */
export interface ChatInputConfig {
  placeholder?: string;
  maxLength?: number;
  /** Whether the input should auto-focus on mount. */
  autoFocus?: boolean;
}

/** Callback invoked when the user submits a message from the input. */
export type OnSubmitCallback = (content: string) => void;

/** Configuration for the chat list component. */
export interface ChatListConfig {
  /** Number of messages to load per batch. */
  batchSize?: number;
  /** Whether to auto-scroll to bottom on new messages. */
  autoScroll?: boolean;
}
