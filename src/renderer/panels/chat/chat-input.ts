/**
 * Chat input component.
 * Provides a text area with submit-on-Enter, shift+Enter for newline,
 * character limit, and disabled state while sending.
 * Uses vanilla DOM manipulation (matching the project's existing pattern).
 */

import type { ChatInputConfig, OnSubmitCallback } from './types';

/** CSS class names scoped to the chat input. */
const CSS = {
  container: 'nn-chat-input',
  textarea: 'nn-chat-input__textarea',
  actions: 'nn-chat-input__actions',
  sendBtn: 'nn-chat-input__send',
  charCount: 'nn-chat-input__char-count',
  charCountWarning: 'nn-chat-input__char-count--warning',
  disabled: 'nn-chat-input--disabled',
} as const;

/** Default configuration values. */
const DEFAULTS: Required<ChatInputConfig> = {
  placeholder: 'Type a message...',
  maxLength: 10000,
  autoFocus: true,
};

/** Injects scoped styles for the chat input. */
function injectStyles(): void {
  if (document.getElementById('nn-chat-input-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-chat-input-styles';
  style.textContent = `
    .${CSS.container} {
      display: flex;
      flex-direction: column;
      padding: 8px 16px 12px;
      border-top: 1px solid var(--border-color, #2d2d2d);
      background: var(--bg-input-area, #1e1e1e);
      gap: 6px;
    }
    .${CSS.container}.${CSS.disabled} {
      opacity: 0.6;
      pointer-events: none;
    }
    .${CSS.textarea} {
      width: 100%;
      min-height: 40px;
      max-height: 160px;
      padding: 8px 12px;
      background: var(--bg-input, #2d2d2d);
      border: 1px solid var(--border-color, #3d3d3d);
      border-radius: 8px;
      color: var(--text-primary, #e0e0e0);
      font-family: inherit;
      font-size: 14px;
      line-height: 1.4;
      resize: none;
      outline: none;
      transition: border-color 0.15s;
    }
    .${CSS.textarea}:focus {
      border-color: var(--focus-border, #007acc);
    }
    .${CSS.textarea}::placeholder {
      color: var(--text-placeholder, #666666);
    }
    .${CSS.actions} {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .${CSS.sendBtn} {
      padding: 6px 14px;
      background: var(--btn-primary-bg, #007acc);
      color: var(--btn-primary-text, #ffffff);
      border: none;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s, opacity 0.15s;
    }
    .${CSS.sendBtn}:hover {
      background: var(--btn-primary-hover, #0098ff);
    }
    .${CSS.sendBtn}:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .${CSS.charCount} {
      font-size: 11px;
      color: var(--text-secondary, #666666);
    }
    .${CSS.charCountWarning} {
      color: var(--chat-error-border, #f44336);
    }
  `;
  document.head.appendChild(style);
}

/**
 * Chat input component.
 * Manages the text input area, submit button, and character count.
 */
export class ChatInput {
  private container: HTMLElement | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private charCountEl: HTMLElement | null = null;
  private config: Required<ChatInputConfig>;
  private onSubmit: OnSubmitCallback | null = null;
  private isDisabled = false;

  constructor(config?: ChatInputConfig) {
    this.config = { ...DEFAULTS, ...config };
  }

  /** Mount the chat input into a DOM container. */
  mount(parent: HTMLElement): void {
    injectStyles();

    this.container = document.createElement('div');
    this.container.className = CSS.container;
    this.container.setAttribute('role', 'form');
    this.container.setAttribute('aria-label', 'Message input');

    // Textarea
    this.textarea = document.createElement('textarea');
    this.textarea.className = CSS.textarea;
    this.textarea.placeholder = this.config.placeholder;
    this.textarea.maxLength = this.config.maxLength;
    this.textarea.setAttribute('aria-label', 'Type your message');
    this.textarea.setAttribute('rows', '1');
    this.textarea.addEventListener('keydown', this.handleKeyDown);
    this.textarea.addEventListener('input', this.handleInput);

    this.container.appendChild(this.textarea);

    // Actions row
    const actions = document.createElement('div');
    actions.className = CSS.actions;

    this.charCountEl = document.createElement('span');
    this.charCountEl.className = CSS.charCount;
    this.charCountEl.textContent = `0 / ${this.config.maxLength}`;
    actions.appendChild(this.charCountEl);

    this.sendBtn = document.createElement('button');
    this.sendBtn.className = CSS.sendBtn;
    this.sendBtn.textContent = 'Send';
    this.sendBtn.setAttribute('aria-label', 'Send message');
    this.sendBtn.disabled = true;
    this.sendBtn.addEventListener('click', this.handleSend);
    actions.appendChild(this.sendBtn);

    this.container.appendChild(actions);
    parent.appendChild(this.container);

    if (this.config.autoFocus) {
      this.textarea.focus();
    }
  }

  /** Unmount the input and clean up event listeners. */
  unmount(): void {
    if (this.textarea) {
      this.textarea.removeEventListener('keydown', this.handleKeyDown);
      this.textarea.removeEventListener('input', this.handleInput);
    }
    if (this.sendBtn) {
      this.sendBtn.removeEventListener('click', this.handleSend);
    }
    if (this.container?.parentElement) {
      this.container.parentElement.removeChild(this.container);
    }
    this.container = null;
    this.textarea = null;
    this.sendBtn = null;
    this.charCountEl = null;
  }

  /** Register the submit callback. */
  setOnSubmit(callback: OnSubmitCallback): void {
    this.onSubmit = callback;
  }

  /** Set the disabled state (e.g. while a message is being sent). */
  setDisabled(disabled: boolean): void {
    this.isDisabled = disabled;
    if (this.container) {
      if (disabled) {
        this.container.classList.add(CSS.disabled);
      } else {
        this.container.classList.remove(CSS.disabled);
      }
    }
    if (this.textarea) {
      this.textarea.disabled = disabled;
    }
    if (this.sendBtn) {
      this.sendBtn.disabled = disabled || this.getContent().length === 0;
    }
  }

  /** Focus the textarea. */
  focus(): void {
    this.textarea?.focus();
  }

  /** Clear the input content. */
  clear(): void {
    if (this.textarea) {
      this.textarea.value = '';
      this.autoResize();
      this.updateCharCount();
      this.updateSendButton();
    }
  }

  /** Get the current input content (trimmed). */
  getContent(): string {
    return this.textarea?.value.trim() ?? '';
  }

  /** Handle Enter to submit, Shift+Enter for newline. */
  private handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.handleSend();
    }
  };

  /** Handle input changes for auto-resize and character count. */
  private handleInput = (): void => {
    this.autoResize();
    this.updateCharCount();
    this.updateSendButton();
  };

  /** Submit the message. */
  private handleSend = (): void => {
    if (this.isDisabled) return;
    const content = this.getContent();
    if (content.length === 0) return;
    if (this.onSubmit) {
      this.onSubmit(content);
    }
  };

  /** Auto-resize textarea to fit content. */
  private autoResize(): void {
    if (!this.textarea) return;
    this.textarea.style.height = 'auto';
    this.textarea.style.height = `${Math.min(this.textarea.scrollHeight, 160)}px`;
  }

  /** Update the character count display. */
  private updateCharCount(): void {
    if (!this.charCountEl || !this.textarea) return;
    const length = this.textarea.value.length;
    this.charCountEl.textContent = `${length} / ${this.config.maxLength}`;

    const isWarning = length > this.config.maxLength * 0.9;
    if (isWarning) {
      this.charCountEl.classList.add(CSS.charCountWarning);
    } else {
      this.charCountEl.classList.remove(CSS.charCountWarning);
    }
  }

  /** Enable/disable the send button based on content. */
  private updateSendButton(): void {
    if (!this.sendBtn) return;
    this.sendBtn.disabled = this.isDisabled || this.getContent().length === 0;
  }
}
