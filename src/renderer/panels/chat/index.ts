/**
 * Chat panel module.
 * Implements the PanelModule interface to integrate with the application router.
 * Coordinates the chat list, chat input, and chat service into a cohesive panel.
 */

import type { PanelModule } from '../../types';
import type { ChatMessage, ChatServiceEvent, MessageId, RoomId } from './types';
import { ChatList } from './chat-list';
import { ChatInput } from './chat-input';
import { ChatService } from './chat-service';

export type { ChatMessage, ChatRoom, RoomId, MessageId } from './types';

/** Default room ID used when no room is explicitly selected. */
const DEFAULT_ROOM_ID: RoomId = 'default';

/** Number of messages to load per batch. */
const MESSAGE_BATCH_SIZE = 50;

/**
 * Chat panel implementing the PanelModule lifecycle.
 * Manages message display, user input, and communication with the main process via IPC.
 */
class ChatPanel implements PanelModule {
  private chatList: ChatList;
  private chatInput: ChatInput;
  private chatService: ChatService;
  private container: HTMLElement | null = null;
  private unsubscribeService: (() => void) | null = null;
  private currentRoomId: RoomId = DEFAULT_ROOM_ID;
  private messages: ChatMessage[] = [];
  private hasMoreMessages = false;
  private streamingMessageContent: Map<MessageId, string> = new Map();

  constructor() {
    this.chatList = new ChatList({ batchSize: MESSAGE_BATCH_SIZE, autoScroll: true });
    this.chatInput = new ChatInput({ placeholder: 'Ask NeuroNest anything...', autoFocus: false });
    this.chatService = new ChatService();
  }

  /** Mount the chat panel into the given container element. */
  mount(container: HTMLElement): void {
    this.container = container;

    // Apply panel-level styles
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.height = '100%';

    // Mount sub-components
    this.chatList.mount(container);
    this.chatInput.mount(container);

    // Wire up submit handler
    this.chatInput.setOnSubmit(this.handleSubmit);

    // Wire up load-more
    this.chatList.setOnLoadMore(this.handleLoadMore);

    // Start the service and subscribe to events
    this.chatService.start();
    this.unsubscribeService = this.chatService.subscribe(this.handleServiceEvent);

    // Load initial messages
    this.loadInitialMessages();
  }

  /** Unmount the chat panel and clean up resources. */
  unmount(): void {
    if (this.unsubscribeService) {
      this.unsubscribeService();
      this.unsubscribeService = null;
    }
    this.chatService.stop();
    this.chatList.unmount();
    this.chatInput.unmount();
    this.container = null;
    this.messages = [];
    this.streamingMessageContent.clear();
  }

  /** Called when the panel receives focus. */
  onFocus(): void {
    this.chatInput.focus();
  }

  /** Called when the panel loses focus. */
  onBlur(): void {
    // No special cleanup needed when the panel loses focus.
  }

  /** Handle message submission from the input. */
  private handleSubmit = async (content: string): Promise<void> => {
    // Create an optimistic local message
    const localMessage: ChatMessage = {
      id: generateLocalId(),
      roomId: this.currentRoomId,
      sender: 'user',
      content,
      timestamp: Date.now(),
      status: 'sending',
    };

    // Add to local state and render
    this.messages.push(localMessage);
    this.chatList.appendMessage(localMessage);

    // Disable input while sending
    this.chatInput.setDisabled(true);
    this.chatInput.clear();

    // Send via IPC
    const response = await this.chatService.sendMessage({
      roomId: this.currentRoomId,
      content,
    });

    // Update message status based on response
    if (response.success) {
      // Update the local message with server-assigned data
      localMessage.status = 'sent';
      if (response.message) {
        localMessage.id = response.message.id;
      }
      this.chatList.updateMessageStatus(localMessage.id, 'sent');
    } else {
      localMessage.status = 'error';
      this.chatList.updateMessageStatus(localMessage.id, 'error');
    }

    // Re-enable input
    this.chatInput.setDisabled(false);
    this.chatInput.focus();
  };

  /** Handle events from the chat service (incoming messages, streaming). */
  private handleServiceEvent = (event: ChatServiceEvent): void => {
    switch (event.type) {
      case 'message-received':
        this.handleIncomingMessage(event.message);
        break;
      case 'stream-chunk':
        this.handleStreamChunk(event.messageId, event.chunk);
        break;
      case 'message-status-changed':
        this.chatList.updateMessageStatus(event.messageId, event.status);
        break;
      default:
        break;
    }
  };

  /** Handle an incoming message from the assistant. */
  private handleIncomingMessage(message: ChatMessage): void {
    if (message.roomId !== this.currentRoomId) return;

    // If we were streaming this message, finalize it
    if (this.streamingMessageContent.has(message.id)) {
      this.streamingMessageContent.delete(message.id);
      this.chatList.updateMessageContent(message.id, message.content);
      this.chatList.updateMessageStatus(message.id, message.status);
    } else {
      this.messages.push(message);
      this.chatList.appendMessage(message);
    }
  }

  /** Handle a streaming chunk for an in-progress assistant response. */
  private handleStreamChunk(messageId: MessageId, chunk: string): void {
    const existing = this.streamingMessageContent.get(messageId);

    if (existing === undefined) {
      // First chunk — create a placeholder message in the list
      const placeholderMessage: ChatMessage = {
        id: messageId,
        roomId: this.currentRoomId,
        sender: 'assistant',
        content: chunk,
        timestamp: Date.now(),
        status: 'sending',
      };
      this.messages.push(placeholderMessage);
      this.chatList.appendMessage(placeholderMessage);
      this.streamingMessageContent.set(messageId, chunk);
    } else {
      // Subsequent chunk — append to accumulated content
      const updated = existing + chunk;
      this.streamingMessageContent.set(messageId, updated);
      this.chatList.updateMessageContent(messageId, updated);
    }
  }

  /** Load initial messages for the current room. */
  private async loadInitialMessages(): Promise<void> {
    const response = await this.chatService.loadMessages({
      roomId: this.currentRoomId,
      limit: MESSAGE_BATCH_SIZE,
    });

    this.messages = response.messages;
    this.hasMoreMessages = response.hasMore;
    this.chatList.setMessages(this.messages);

    if (this.hasMoreMessages) {
      this.chatList.showLoadMore();
    }
  }

  /** Load earlier messages (pagination). */
  private handleLoadMore = async (): Promise<void> => {
    if (!this.hasMoreMessages || this.messages.length === 0) return;

    const oldestTimestamp = this.messages[0]?.timestamp;
    const response = await this.chatService.loadMessages({
      roomId: this.currentRoomId,
      limit: MESSAGE_BATCH_SIZE,
      before: oldestTimestamp,
    });

    if (response.messages.length > 0) {
      this.messages = [...response.messages, ...this.messages];
      this.chatList.prependMessages(response.messages);
    }

    this.hasMoreMessages = response.hasMore;
    if (!this.hasMoreMessages) {
      this.chatList.hideLoadMore();
    }
  };
}

/** Generate a unique local ID for optimistic messages. */
function generateLocalId(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Create and export the chat panel module singleton. */
export function createChatPanel(): PanelModule {
  return new ChatPanel();
}

/** Default export: a ready-to-use chat panel instance. */
export const chatPanel: PanelModule = createChatPanel();
