/**
 * Chat panel module.
 *
 * Implements the PanelModule interface to integrate with the application router.
 * Coordinates the chat input composer, chat service (command-side IPC), and
 * the canonical projection rendering surface into a cohesive panel.
 *
 * Task 13.2 (enhanced-chat-ui) — the canonical projection integration
 * (`createProjectionChatIntegration`) is the sole rendering input for chat
 * content in production. Rendering never falls back to the legacy chat IPC
 * channels (`chat-response`, `chat:stream`, `chat:done`, `chat:error`,
 * `chat:stream-chunk`) — those channels flow through the main-process
 * SessionLog compatibility ingress and reach the renderer only as canonical
 * projection deltas.
 *
 * Task 13.3 (enhanced-chat-ui) — the duplicate Markdown/code/copy renderers
 * that lived under `panels/chat/` (`code-block-renderer.ts`,
 * `rich-content-renderer.ts`) have been retired, and the top-level unsafe
 * legacy renderer helpers (`chat-streaming.ts`, `chat-message-actions.ts`,
 * `chat-enhancements.ts`, `chat-empty-state.ts`, `chat-scroll-controller.ts`)
 * are removed. `ChatList` remains mounted as a transitional draft-receipt
 * surface for locally-created user drafts and command-side
 * `chat:message-received` acknowledgements only; its assistant-body
 * rendering was simplified to escaped plain text plus file-reference links
 * so it can never diverge from the canonical projection's structured
 * response. All Markdown parsing, code highlighting, and rich-content
 * rendering flow through the canonical structured-response surfaces.
 *
 * Requirements: 5.1–5.9, 7.1–7.8, 9.6, 10.7–10.10, 15.1–15.9
 */

import type { PanelModule } from '../../types';
import type { ChatMessage, ChatServiceEvent, RoomId } from './types';
import type { ChatProjectionScopeV1 } from '../../types/structured-chat-preload';
import { ChatList } from './chat-list';
import { ChatInput } from './chat-input';
import { ChatService } from './chat-service';
import {
  createProjectionChatIntegration,
  type ChatProjectionPreloadSurface,
  type ProjectionChatIntegrationHandle,
} from './projection-chat-integration';
import { buttonGroupManager } from '../../services';

export type { ChatMessage, ChatRoom, RoomId, MessageId } from './types';

/** Default room ID used when no room is explicitly selected. */
const DEFAULT_ROOM_ID: RoomId = 'default';

/** Default branch ID for canonical projection scoping. */
const DEFAULT_BRANCH_ID = 'main';

/** Number of messages to load per batch. */
const MESSAGE_BATCH_SIZE = 50;

/**
 * Typed wrapper for accessing the preload-exposed IPC bridge.
 * Falls back to no-op if the bridge is unavailable (e.g. in unit tests).
 */
function getIpcBridge(): {
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
} {
  const bridge = (window as unknown as Record<string, unknown>).electronAPI as {
    on?: (channel: string, callback: (...args: unknown[]) => void) => void;
    removeListener?: (channel: string, callback: (...args: unknown[]) => void) => void;
  } | undefined;

  return {
    on: bridge?.on ?? (() => {}),
    removeListener: bridge?.removeListener ?? (() => {}),
  };
}

/**
 * Extract the canonical chat projection preload surface from the exposed
 * `electronAPI` bridge. Returns `null` when any of the four fixed projection
 * methods is missing — in that case the panel keeps the composer usable but
 * does not mount a projection integration.
 *
 * The panel never falls back to legacy chat IPC channels when this surface is
 * unavailable; the main-side compatibility ingress is the sole path.
 */
function getChatProjectionPreloadSurface(): ChatProjectionPreloadSurface | null {
  const bridge = (window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI;
  if (!bridge) return null;
  const {
    getChatProjectionPage,
    getChatProjectionComposition,
    onChatProjectionDelta,
    onChatProjectionInvalidated,
  } = bridge;
  if (
    typeof getChatProjectionPage !== 'function' ||
    typeof getChatProjectionComposition !== 'function' ||
    typeof onChatProjectionDelta !== 'function' ||
    typeof onChatProjectionInvalidated !== 'function'
  ) {
    return null;
  }
  return bridge as unknown as ChatProjectionPreloadSurface;
}

/**
 * Build a canonical projection scope for a room. The `roomId` maps 1:1 onto
 * `sessionId` in the projection publisher; the panel targets the default
 * `main` branch unless a caller supplies a different one.
 */
function scopeForRoom(roomId: RoomId): ChatProjectionScopeV1 {
  return { schemaVersion: 1, sessionId: roomId, branchId: DEFAULT_BRANCH_ID };
}

/**
 * Chat panel implementing the PanelModule lifecycle.
 *
 * Renders the canonical projection surface below the transitional
 * {@link ChatList} draft receipt. Communicates with the main process via
 * command-side IPC only; incoming chat content is delivered exclusively
 * through the projection preload surface.
 */
class ChatPanel implements PanelModule {
  private chatList: ChatList;
  private chatInput: ChatInput;
  private chatService: ChatService;
  private container: HTMLElement | null = null;
  private projectionContainer: HTMLElement | null = null;
  private projectionHandle: ProjectionChatIntegrationHandle | null = null;
  private unsubscribeService: (() => void) | null = null;
  private currentRoomId: RoomId = DEFAULT_ROOM_ID;
  private messages: ChatMessage[] = [];
  private hasMoreMessages = false;
  private activeProjectHandler: ((...args: unknown[]) => void) | null = null;

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

    // Mount sub-components. ChatList is a transitional receipt surface for
    // locally-created user drafts and command-side `chat:message-received`
    // send-acknowledgement messages only; its enhanced Markdown/code/rich
    // renderers were retired in task 13.3 so it can never diverge from the
    // canonical projection surface below.
    this.chatList.mount(container);

    // Canonical projection rendering surface — the sole path for
    // assistant/tool/reasoning content in production. Never falls back to
    // legacy chat IPC channels.
    this.projectionContainer = document.createElement('div');
    this.projectionContainer.className = 'nn-chat-panel__projection';
    this.projectionContainer.dataset['role'] = 'canonical-chat-projection';
    this.projectionContainer.style.flex = '1';
    this.projectionContainer.style.display = 'flex';
    this.projectionContainer.style.flexDirection = 'column';
    this.projectionContainer.style.minHeight = '0';
    container.appendChild(this.projectionContainer);

    const projectionPreload = getChatProjectionPreloadSurface();
    if (projectionPreload !== null) {
      this.projectionHandle = createProjectionChatIntegration({
        preload: projectionPreload,
        container: this.projectionContainer,
        scope: scopeForRoom(this.currentRoomId),
      });
    }

    this.chatInput.mount(container);

    // Wire up submit handler
    this.chatInput.setOnSubmit(this.handleSubmit);

    // Wire up load-more
    this.chatList.setOnLoadMore(this.handleLoadMore);

    // Start the service and subscribe to events
    this.chatService.start();
    this.unsubscribeService = this.chatService.subscribe(this.handleServiceEvent);

    // Subscribe to active-project IPC event for project switching (Req 3.1, 3.2, 3.3)
    const bridge = getIpcBridge();
    this.activeProjectHandler = (...args: unknown[]) => {
      const payload = args[0] as { id?: string; name?: string } | undefined;
      if (payload && payload.id) {
        this.setCurrentRoom(payload.id);
      }
    };
    bridge.on('active-project', this.activeProjectHandler);

    // Load initial messages
    this.loadInitialMessages();
  }

  /** Unmount the chat panel and clean up resources. */
  unmount(): void {
    // Remove active-project IPC listener
    if (this.activeProjectHandler) {
      const bridge = getIpcBridge();
      bridge.removeListener('active-project', this.activeProjectHandler);
      this.activeProjectHandler = null;
    }

    if (this.unsubscribeService) {
      this.unsubscribeService();
      this.unsubscribeService = null;
    }
    this.chatService.stop();
    if (this.projectionHandle) {
      this.projectionHandle.dispose('manual');
      this.projectionHandle = null;
    }
    if (this.projectionContainer && this.projectionContainer.parentElement) {
      this.projectionContainer.parentElement.removeChild(this.projectionContainer);
    }
    this.projectionContainer = null;
    this.chatList.unmount();
    this.chatInput.unmount();
    this.container = null;
    this.messages = [];
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
    // Disable any active action button groups since the user chose to type manually
    // (Requirement 4.1, 4.2, 4.3)
    buttonGroupManager.onManualInput();

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

      // Show typing indicator while waiting for assistant response (Requirement 23.18)
      this.chatList.showTypingIndicator('NeuroNest', '🤖');
    } else {
      localMessage.status = 'error';
      this.chatList.updateMessageStatus(localMessage.id, 'error');
    }

    // Re-enable input
    this.chatInput.setDisabled(false);
    this.chatInput.focus();
  };

  /**
   * Handle events from the chat service. After task 13.2 the service only
   * emits `message-received` for command-side send acknowledgements; the
   * `stream-chunk` and `message-status-changed` variants of
   * {@link ChatServiceEvent} are no longer produced because streaming and
   * legacy chat-response deliveries are handled exclusively by the
   * canonical projection integration.
   */
  private handleServiceEvent = (event: ChatServiceEvent): void => {
    if (event.type === 'message-received') {
      this.handleIncomingMessage(event.message);
    }
    // Other variants of ChatServiceEvent are retained on the type union for
    // backward compatibility but are never emitted by ChatService in the
    // canonical rendering path. Task 13.3 removes them.
  };

  /** Handle an incoming message from the assistant. */
  private handleIncomingMessage(message: ChatMessage): void {
    if (message.roomId !== this.currentRoomId) return;

    // Hide typing indicator when a full message arrives (Requirement 23.18)
    this.chatList.hideTypingIndicator();

    this.messages.push(message);
    this.chatList.appendMessage(message);
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

  /**
   * Switch to a different project room.
   *
   * Clears the transitional ChatList messages, retargets the canonical
   * projection scope, updates the room ID, and reloads persisted messages
   * for the new project. Only messages with matching session_id (projectId)
   * are displayed (Requirements 3.1, 3.2, 3.3).
   */
  private setCurrentRoom(projectId: RoomId): void {
    if (projectId === this.currentRoomId) return;

    // Clear the ChatList receipt surface
    this.messages = [];
    this.hasMoreMessages = false;

    // Update currentRoomId to new projectId
    this.currentRoomId = projectId;
    this.chatService.currentProjectId = projectId;

    // Retarget the canonical projection surface to the new scope. Fire-and-
    // forget: switchScope's inner rejection surfaces through the shell's
    // render status; it must never trigger a fallback to legacy channels.
    if (this.projectionHandle !== null) {
      void this.projectionHandle.switchScope(scopeForRoom(projectId));
    }

    // Fetch persisted messages (including dispatch-sourced) for the new project
    this.loadInitialMessages();
  }
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
