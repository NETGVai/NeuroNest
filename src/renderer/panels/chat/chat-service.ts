/**
 * Chat service — IPC wrappers for chat operations.
 * Provides a typed abstraction over Electron IPC for sending/receiving chat messages,
 * managing rooms, and handling streaming responses.
 */

import type {
  ChatMessage,
  ChatRoom,
  ChatServiceEvent,
  ChatServiceListener,
  LoadMessagesRequest,
  LoadMessagesResponse,
  RoomId,
  SendMessageRequest,
  SendMessageResponse,
  StreamChunkPayload,
} from './types';

/** IPC channels used by the chat service. */
const IPC_CHANNELS = {
  SEND_MESSAGE: 'chat:send-message',
  LOAD_MESSAGES: 'chat:load-messages',
  CREATE_ROOM: 'chat:create-room',
  LIST_ROOMS: 'chat:list-rooms',
  DELETE_ROOM: 'chat:delete-room',
  MESSAGE_RECEIVED: 'chat:message-received',
  STREAM_CHUNK: 'chat:stream-chunk',
} as const;

/**
 * Typed wrapper around the preload-exposed IPC bridge.
 * Falls back to no-op if the bridge is unavailable (e.g. in unit tests).
 */
function getIpcBridge(): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  off: (channel: string, callback: (...args: unknown[]) => void) => void;
} {
  const bridge = (window as unknown as Record<string, unknown>).electronAPI as {
    invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on?: (channel: string, callback: (...args: unknown[]) => void) => void;
    off?: (channel: string, callback: (...args: unknown[]) => void) => void;
  } | undefined;

  return {
    invoke: bridge?.invoke ?? (async () => undefined),
    on: bridge?.on ?? (() => {}),
    off: bridge?.off ?? (() => {}),
  };
}

/**
 * Chat service providing IPC-backed operations for the chat panel.
 * Manages subscriptions to incoming messages and stream chunks.
 */
export class ChatService {
  private listeners: Set<ChatServiceListener> = new Set();
  private ipcMessageHandler: ((...args: unknown[]) => void) | null = null;
  private ipcStreamHandler: ((...args: unknown[]) => void) | null = null;
  private ipcChatResponseHandler: ((...args: unknown[]) => void) | null = null;
  private started = false;
  /** Tracks msgIds that have received a `start` event. */
  private startedStreams: Set<string> = new Set();
  /** The current project/room ID, used when creating placeholder messages. */
  currentProjectId: RoomId = 'default';

  /** Start listening for incoming IPC events from the main process. */
  start(): void {
    if (this.started) return;
    this.started = true;

    const bridge = getIpcBridge();

    this.ipcMessageHandler = (...args: unknown[]) => {
      const message = args[0] as ChatMessage;
      if (message && message.id) {
        this.emit({ type: 'message-received', message });
      }
    };

    this.ipcStreamHandler = (...args: unknown[]) => {
      const data = args[0] as StreamChunkPayload | undefined;
      if (!data || !data.messageId) return;

      if (data.done) {
        this.startedStreams.delete(data.messageId);
        this.emit({ type: 'message-status-changed', messageId: data.messageId, status: 'sent', reasoning: data.reasoning || undefined });
        return;
      }

      if (data.error) {
        this.startedStreams.delete(data.messageId);
        this.emit({ type: 'message-status-changed', messageId: data.messageId, status: 'error' });
        return;
      }

      if (data.start) {
        this.startedStreams.add(data.messageId);
        this.emit({
          type: 'message-received',
          message: {
            id: data.messageId,
            roomId: this.currentProjectId,
            sender: 'assistant',
            content: '',
            timestamp: Date.now(),
            status: 'sending',
            metadata: {
              source: data.source,
              agent: data.agent,
              agentEmoji: data.agentEmoji,
            },
          },
        });
        return;
      }

      // Regular token — if no start event was received for this msgId, create a placeholder first (Req 2.7)
      if (!this.startedStreams.has(data.messageId)) {
        this.startedStreams.add(data.messageId);
        this.emit({
          type: 'message-received',
          message: {
            id: data.messageId,
            roomId: this.currentProjectId,
            sender: 'assistant',
            content: '',
            timestamp: Date.now(),
            status: 'sending',
          },
        });
      }

      this.emit({ type: 'stream-chunk', messageId: data.messageId, chunk: data.chunk });
    };

    bridge.on(IPC_CHANNELS.MESSAGE_RECEIVED, this.ipcMessageHandler);
    bridge.on(IPC_CHANNELS.STREAM_CHUNK, this.ipcStreamHandler);

    // Listen to legacy chat-response events for channel messages (REQ 3.1, 3.2, 3.3, 3.4, 3.5)
    this.ipcChatResponseHandler = (...args: unknown[]) => {
      const data = args[0] as Record<string, unknown> | undefined;
      if (!data) return;
      // Only handle channel messages — non-channel messages are handled by legacy renderer
      if (!data.isChannelMessage && !data.channelSource && !data.relayTarget) return;

      const message: ChatMessage = {
        id: `channel-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        roomId: this.currentProjectId,
        sender: (data.role as 'user' | 'assistant') === 'user' ? 'user' : 'assistant',
        content: (data.content as string) || '',
        timestamp: Date.now(),
        status: 'sent',
        metadata: {
          agent: (data.agent as string) || undefined,
          channelSource: data.channelSource as ChatMessage['metadata'] extends infer M ? M extends { channelSource?: infer C } ? C : never : never,
          relayTarget: data.relayTarget as ChatMessage['metadata'] extends infer M ? M extends { relayTarget?: infer R } ? R : never : never,
          isChannelMessage: true,
          isChannelStreaming: (data.isChannelStreaming as boolean) || undefined,
        },
      };
      this.emit({ type: 'message-received', message });
    };
    bridge.on('chat-response', this.ipcChatResponseHandler);
  }

  /** Stop listening for IPC events and clean up subscriptions. */
  stop(): void {
    if (!this.started) return;
    this.started = false;

    const bridge = getIpcBridge();

    if (this.ipcMessageHandler) {
      bridge.off(IPC_CHANNELS.MESSAGE_RECEIVED, this.ipcMessageHandler);
      this.ipcMessageHandler = null;
    }
    if (this.ipcStreamHandler) {
      bridge.off(IPC_CHANNELS.STREAM_CHUNK, this.ipcStreamHandler);
      this.ipcStreamHandler = null;
    }
    if (this.ipcChatResponseHandler) {
      bridge.off('chat-response', this.ipcChatResponseHandler);
      this.ipcChatResponseHandler = null;
    }

    this.startedStreams.clear();
  }

  /** Subscribe to chat service events. Returns an unsubscribe function. */
  subscribe(listener: ChatServiceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Send a message to the assistant via IPC. */
  async sendMessage(request: SendMessageRequest): Promise<SendMessageResponse> {
    const bridge = getIpcBridge();
    try {
      const result = await bridge.invoke(IPC_CHANNELS.SEND_MESSAGE, request);
      return (result as SendMessageResponse) ?? { success: false, error: 'No response from main process' };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error sending message';
      return { success: false, error: errorMessage };
    }
  }

  /** Load historical messages for a room. */
  async loadMessages(request: LoadMessagesRequest): Promise<LoadMessagesResponse> {
    const bridge = getIpcBridge();
    try {
      const result = await bridge.invoke(IPC_CHANNELS.LOAD_MESSAGES, request);
      return (result as LoadMessagesResponse) ?? { messages: [], hasMore: false };
    } catch {
      return { messages: [], hasMore: false };
    }
  }

  /** Create a new chat room. */
  async createRoom(title: string): Promise<ChatRoom | null> {
    const bridge = getIpcBridge();
    try {
      const result = await bridge.invoke(IPC_CHANNELS.CREATE_ROOM, { title });
      return (result as ChatRoom) ?? null;
    } catch {
      return null;
    }
  }

  /** List all chat rooms. */
  async listRooms(): Promise<ChatRoom[]> {
    const bridge = getIpcBridge();
    try {
      const result = await bridge.invoke(IPC_CHANNELS.LIST_ROOMS);
      return (result as ChatRoom[]) ?? [];
    } catch {
      return [];
    }
  }

  /** Delete a chat room by ID. */
  async deleteRoom(roomId: RoomId): Promise<boolean> {
    const bridge = getIpcBridge();
    try {
      const result = await bridge.invoke(IPC_CHANNELS.DELETE_ROOM, { roomId });
      return (result as { success: boolean })?.success ?? false;
    } catch {
      return false;
    }
  }

  /** Emit an event to all registered listeners. */
  private emit(event: ChatServiceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Swallow listener errors to prevent cascading failures.
      }
    }
  }
}
