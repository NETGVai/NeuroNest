/**
 * Chat message list component.
 * Renders a scrollable list of chat messages with auto-scroll behavior,
 * timestamp formatting, and sender differentiation.
 * Uses vanilla DOM manipulation (matching the project's existing pattern).
 */

import type { ChatListConfig, ChatMessage, MessageId } from './types';

/** CSS class names scoped to the chat list. */
const CSS = {
  container: 'nn-chat-list',
  scrollArea: 'nn-chat-list__scroll',
  message: 'nn-chat-list__message',
  messageUser: 'nn-chat-list__message--user',
  messageAssistant: 'nn-chat-list__message--assistant',
  messageSystem: 'nn-chat-list__message--system',
  messageSending: 'nn-chat-list__message--sending',
  messageError: 'nn-chat-list__message--error',
  messageBubble: 'nn-chat-list__bubble',
  messageContent: 'nn-chat-list__content',
  messageMeta: 'nn-chat-list__meta',
  loadMore: 'nn-chat-list__load-more',
  empty: 'nn-chat-list__empty',
} as const;

/** Default configuration values for the chat list. */
const DEFAULTS: Required<ChatListConfig> = {
  batchSize: 50,
  autoScroll: true,
};

/** Formats a timestamp into a short time string. */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Injects scoped styles for the chat list. */
function injectStyles(): void {
  if (document.getElementById('nn-chat-list-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-chat-list-styles';
  style.textContent = `
    .${CSS.container} {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    .${CSS.scrollArea} {
      flex: 1;
      overflow-y: auto;
      padding: 12px 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .${CSS.message} {
      display: flex;
      flex-direction: column;
      max-width: 80%;
      animation: nn-chat-fade-in 0.15s ease-out;
    }
    @keyframes nn-chat-fade-in {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .${CSS.messageUser} {
      align-self: flex-end;
    }
    .${CSS.messageAssistant} {
      align-self: flex-start;
    }
    .${CSS.messageSystem} {
      align-self: center;
      max-width: 90%;
    }
    .${CSS.messageBubble} {
      padding: 8px 12px;
      border-radius: 12px;
      word-wrap: break-word;
      white-space: pre-wrap;
      line-height: 1.4;
      font-size: 14px;
    }
    .${CSS.messageUser} .${CSS.messageBubble} {
      background: var(--chat-user-bg, #264f78);
      color: var(--chat-user-text, #ffffff);
      border-bottom-right-radius: 4px;
    }
    .${CSS.messageAssistant} .${CSS.messageBubble} {
      background: var(--chat-assistant-bg, #2d2d2d);
      color: var(--chat-assistant-text, #e0e0e0);
      border-bottom-left-radius: 4px;
    }
    .${CSS.messageSystem} .${CSS.messageBubble} {
      background: var(--chat-system-bg, #1e1e1e);
      color: var(--chat-system-text, #888888);
      font-style: italic;
      font-size: 12px;
      text-align: center;
    }
    .${CSS.messageSending} .${CSS.messageBubble} {
      opacity: 0.7;
    }
    .${CSS.messageError} .${CSS.messageBubble} {
      border: 1px solid var(--chat-error-border, #f44336);
    }
    .${CSS.messageMeta} {
      font-size: 11px;
      color: var(--chat-meta-text, #666666);
      margin-top: 2px;
      padding: 0 4px;
    }
    .${CSS.messageUser} .${CSS.messageMeta} {
      text-align: right;
    }
    .${CSS.loadMore} {
      text-align: center;
      padding: 8px;
    }
    .${CSS.loadMore} button {
      background: none;
      border: 1px solid var(--border-color, #3d3d3d);
      color: var(--text-secondary, #aaaaaa);
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    .${CSS.loadMore} button:hover {
      background: rgba(255, 255, 255, 0.04);
    }
    .${CSS.empty} {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-secondary, #666666);
      font-size: 14px;
    }
    .nn-chat-badge-dispatch {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      background: var(--chat-badge-dispatch-bg, #3a6b35);
      color: var(--chat-badge-dispatch-text, #c8e6c9);
      padding: 2px 6px;
      border-radius: 4px;
      margin-bottom: 4px;
      line-height: 1;
    }
    .nn-chat-agent-label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      color: var(--chat-agent-label-text, #9cdcfe);
      margin-bottom: 4px;
      line-height: 1.2;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Chat list component.
 * Manages rendering and updating a scrollable list of chat messages.
 */
export class ChatList {
  private container: HTMLElement | null = null;
  private scrollArea: HTMLElement | null = null;
  private messageElements: Map<MessageId, HTMLElement> = new Map();
  private config: Required<ChatListConfig>;
  private onLoadMore: (() => void) | null = null;
  private isAtBottom = true;

  constructor(config?: ChatListConfig) {
    this.config = { ...DEFAULTS, ...config };
  }

  /** Mount the chat list into a DOM container. */
  mount(parent: HTMLElement): void {
    injectStyles();

    this.container = document.createElement('div');
    this.container.className = CSS.container;
    this.container.setAttribute('role', 'log');
    this.container.setAttribute('aria-label', 'Chat messages');
    this.container.setAttribute('aria-live', 'polite');

    this.scrollArea = document.createElement('div');
    this.scrollArea.className = CSS.scrollArea;
    this.scrollArea.addEventListener('scroll', this.handleScroll);

    this.container.appendChild(this.scrollArea);
    parent.appendChild(this.container);

    this.showEmpty();
  }

  /** Unmount the chat list and clean up. */
  unmount(): void {
    if (this.scrollArea) {
      this.scrollArea.removeEventListener('scroll', this.handleScroll);
    }
    if (this.container?.parentElement) {
      this.container.parentElement.removeChild(this.container);
    }
    this.container = null;
    this.scrollArea = null;
    this.messageElements.clear();
  }

  /** Set the callback for loading more messages (infinite scroll). */
  setOnLoadMore(callback: () => void): void {
    this.onLoadMore = callback;
  }

  /** Render a batch of messages (replaces existing content). */
  setMessages(messages: ChatMessage[]): void {
    if (!this.scrollArea) return;

    this.scrollArea.innerHTML = '';
    this.messageElements.clear();

    if (messages.length === 0) {
      this.showEmpty();
      return;
    }

    for (const msg of messages) {
      this.appendMessageElement(msg);
    }

    if (this.config.autoScroll) {
      this.scrollToBottom();
    }
  }

  /** Prepend older messages at the top (for pagination). */
  prependMessages(messages: ChatMessage[]): void {
    if (!this.scrollArea || messages.length === 0) return;

    this.removeEmpty();

    const previousScrollHeight = this.scrollArea.scrollHeight;
    const previousScrollTop = this.scrollArea.scrollTop;
    const fragment = document.createDocumentFragment();

    for (const msg of messages) {
      const el = this.createMessageElement(msg);
      this.messageElements.set(msg.id, el);
      fragment.appendChild(el);
    }

    this.scrollArea.insertBefore(fragment, this.scrollArea.firstChild);

    // Maintain scroll position after prepending
    const newScrollHeight = this.scrollArea.scrollHeight;
    this.scrollArea.scrollTop = previousScrollTop + (newScrollHeight - previousScrollHeight);
  }

  /** Append a single new message at the bottom. */
  appendMessage(message: ChatMessage): void {
    if (!this.scrollArea) return;
    this.removeEmpty();
    this.appendMessageElement(message);

    if (this.config.autoScroll && this.isAtBottom) {
      this.scrollToBottom();
    }
  }

  /** Update the content of an existing message (e.g. for streaming). */
  updateMessageContent(messageId: MessageId, content: string): void {
    const el = this.messageElements.get(messageId);
    if (!el) return;

    const contentEl = el.querySelector(`.${CSS.messageContent}`);
    if (contentEl) {
      contentEl.textContent = content;
    }

    if (this.config.autoScroll && this.isAtBottom) {
      this.scrollToBottom();
    }
  }

  /** Update the status of a message (sending → sent, error). */
  updateMessageStatus(messageId: MessageId, status: ChatMessage['status']): void {
    const el = this.messageElements.get(messageId);
    if (!el) return;

    el.classList.remove(CSS.messageSending, CSS.messageError);
    if (status === 'sending') el.classList.add(CSS.messageSending);
    if (status === 'error') el.classList.add(CSS.messageError);
  }

  /** Show the "load more" button at the top. */
  showLoadMore(): void {
    if (!this.scrollArea) return;
    if (this.scrollArea.querySelector(`.${CSS.loadMore}`)) return;

    const loadMoreEl = document.createElement('div');
    loadMoreEl.className = CSS.loadMore;

    const btn = document.createElement('button');
    btn.textContent = 'Load earlier messages';
    btn.setAttribute('aria-label', 'Load earlier messages');
    btn.addEventListener('click', () => {
      if (this.onLoadMore) this.onLoadMore();
    });

    loadMoreEl.appendChild(btn);
    this.scrollArea.insertBefore(loadMoreEl, this.scrollArea.firstChild);
  }

  /** Hide the "load more" button. */
  hideLoadMore(): void {
    if (!this.scrollArea) return;
    const el = this.scrollArea.querySelector(`.${CSS.loadMore}`);
    if (el) el.remove();
  }

  /** Scroll to the bottom of the message list. */
  scrollToBottom(): void {
    if (!this.scrollArea) return;
    this.scrollArea.scrollTop = this.scrollArea.scrollHeight;
  }

  /** Track whether user is scrolled to bottom. */
  private handleScroll = (): void => {
    if (!this.scrollArea) return;
    const { scrollTop, scrollHeight, clientHeight } = this.scrollArea;
    this.isAtBottom = scrollHeight - scrollTop - clientHeight < 30;
  };

  /** Create and append a message element. */
  private appendMessageElement(message: ChatMessage): void {
    if (!this.scrollArea) return;
    const el = this.createMessageElement(message);
    this.messageElements.set(message.id, el);
    this.scrollArea.appendChild(el);
  }

  /** Build the DOM element for a single message. */
  private createMessageElement(message: ChatMessage): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = CSS.message;
    wrapper.dataset.messageId = message.id;

    // Apply sender class
    if (message.sender === 'user') wrapper.classList.add(CSS.messageUser);
    else if (message.sender === 'assistant') wrapper.classList.add(CSS.messageAssistant);
    else wrapper.classList.add(CSS.messageSystem);

    // Apply status class
    if (message.status === 'sending') wrapper.classList.add(CSS.messageSending);
    if (message.status === 'error') wrapper.classList.add(CSS.messageError);

    // Bubble
    const bubble = document.createElement('div');
    bubble.className = CSS.messageBubble;

    // Dispatch source badge (inserted before content so it doesn't obscure text)
    if (message.metadata?.source === 'dashboard') {
      const badge = document.createElement('span');
      badge.className = 'nn-chat-badge-dispatch';
      badge.textContent = 'Dashboard';
      badge.setAttribute('aria-label', 'Dispatched from Agent Dashboard');
      bubble.appendChild(badge);
    }

    // Agent label for assistant messages with agent metadata or orchestrator fallback
    if (message.sender === 'assistant') {
      let agentDisplayName: string | undefined;
      let agentEmoji: string | undefined;

      if (message.metadata?.agent) {
        agentDisplayName = message.metadata.agent;
        agentEmoji = message.metadata.agentEmoji;
      } else if (message.metadata?.source === 'dashboard') {
        // Fallback: no agent name but dispatched from dashboard → show "Orchestrator"
        agentDisplayName = 'Orchestrator';
      }

      if (agentDisplayName) {
        const agentLabel = document.createElement('span');
        agentLabel.className = 'nn-chat-agent-label';
        agentLabel.textContent = ((agentEmoji || '') + ' ' + agentDisplayName).trim();
        bubble.appendChild(agentLabel);
      }
    }

    const content = document.createElement('span');
    content.className = CSS.messageContent;
    content.textContent = message.content;
    bubble.appendChild(content);

    wrapper.appendChild(bubble);

    // Meta (timestamp)
    const meta = document.createElement('div');
    meta.className = CSS.messageMeta;
    meta.textContent = formatTime(message.timestamp);
    if (message.status === 'error') {
      meta.textContent += ' · Failed to send';
    }
    wrapper.appendChild(meta);

    return wrapper;
  }

  /** Show empty state placeholder. */
  private showEmpty(): void {
    if (!this.scrollArea) return;
    if (this.scrollArea.querySelector(`.${CSS.empty}`)) return;

    const empty = document.createElement('div');
    empty.className = CSS.empty;
    empty.textContent = 'No messages yet. Start a conversation!';
    this.scrollArea.appendChild(empty);
  }

  /** Remove the empty state placeholder. */
  private removeEmpty(): void {
    if (!this.scrollArea) return;
    const emptyEl = this.scrollArea.querySelector(`.${CSS.empty}`);
    if (emptyEl) emptyEl.remove();
  }
}
