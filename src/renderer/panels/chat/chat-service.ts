/**
 * Chat service — IPC wrappers for chat operations.
 *
 * Provides a typed abstraction over Electron IPC for **command-side** chat
 * operations only: send/load messages, room CRUD, and the fixed
 * `chat:message-received` acknowledgement that the main process emits after a
 * successful send. Streaming and legacy chat delivery are handled by the
 * canonical projection integration (see
 * `src/renderer/panels/chat/projection-chat-integration.ts`).
 *
 * Task 13.2 (enhanced-chat-ui) — this service no longer subscribes to the
 * five legacy chat channels (`chat-response`, `chat:stream`, `chat:done`,
 * `chat:error`, `chat:stream-chunk`). Those channels still flow into the
 * main-process SessionLog through `LegacyCanonicalIngestion`
 * (`src/main/chat/legacy-canonical-ingestion.ts`) and are re-emitted as
 * canonical projection deltas. The renderer's sole rendering input is the
 * projection subscription surfaced through `chatProjection.*` in the
 * preload bridge; a rollback to direct legacy delivery is not permitted.
 *
 * Requirements: 5.7, 9.1, 9.6, 10.1–10.7, 15.3–15.5
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
} from './types';

/** IPC channels used by the chat service (command-side only). */
const IPC_CHANNELS = {
  SEND_MESSAGE: 'chat:send-message',
  LOAD_MESSAGES: 'chat:load-messages',
  CREATE_ROOM: 'chat:create-room',
  LIST_ROOMS: 'chat:list-rooms',
  DELETE_ROOM: 'chat:delete-room',
  MESSAGE_RECEIVED: 'chat:message-received',
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
 * Chat service providing IPC-backed command operations for the chat panel.
 *
 * Manages the `chat:message-received` send-acknowledgement subscription and
 * the invoke-based send/load/room CRUD channels. Streaming and legacy chat
 * deliveries (chat-response, chat:stream, chat:done, chat:error,
 * chat:stream-chunk) are NOT subscribed here; those flow through the
 * main-process compatibility ingress into SessionLog and are re-emitted as
 * canonical projection deltas that the projection integration renders.
 */
export class ChatService {
  private listeners: Set<ChatServiceListener> = new Set();
  private ipcMessageHandler: ((...args: unknown[]) => void) | null = null;
  private started = false;
  /** The current project/room ID. Retained for send/load scoping. */
  currentProjectId: RoomId = 'default';

  /** Start listening for the send-acknowledgement IPC event. */
  start(): void {
    if (this.started) return;
    this.started = true;

    const bridge = getIpcBridge();

    this.ipcMessageHandler = (...args: unknown[]) => {
      const message = args[0] as ChatMessage | undefined;
      if (message && typeof message.id === 'string' && message.id.length > 0) {
        this.emit({ type: 'message-received', message });
      }
    };

    bridge.on(IPC_CHANNELS.MESSAGE_RECEIVED, this.ipcMessageHandler);
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
