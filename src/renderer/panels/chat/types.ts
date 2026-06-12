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
  metadata?: Record<string, unknown>;
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

/** Events emitted by the chat service layer. */
export type ChatServiceEvent =
  | { type: 'message-received'; message: ChatMessage }
  | { type: 'message-status-changed'; messageId: MessageId; status: MessageStatus }
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
