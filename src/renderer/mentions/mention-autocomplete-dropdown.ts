/**
 * MentionAutocompleteDropdown — Autocomplete dropdown UI for @-mentions in chat input.
 *
 * Triggered when the user types `@` in the chat input field. Displays a
 * filterable dropdown of mention suggestions sourced via IPC.
 *
 * Features:
 * - Triggered by `@` character detection in the input
 * - Keyboard navigation (ArrowUp, ArrowDown, Enter, Escape)
 * - Fuzzy filtering as user types after `@`
 * - Grouped results by category with type icons
 * - Accessible: ARIA roles and keyboard support
 *
 * Requirements: 14.2
 */

import type { MentionSuggestionItem, MentionType } from './mention-ipc-client';
import { getMentionIpcClient } from './mention-ipc-client';

// ─── Constants ──────────────────────────────────────────────────

/** Maximum visible items in the dropdown */
export const MAX_VISIBLE_ITEMS = 10;

/** Debounce delay for fetching suggestions (ms) */
export const SUGGESTION_DEBOUNCE_MS = 150;

/** Icons for each mention type */
export const MENTION_TYPE_ICONS: Record<MentionType, string> = {
  file: '📄',
  folder: '📁',
  url: '🔗',
  'git-diff': '📊',
  problems: '⚠️',
  terminal: '💻',
  selection: '✂️',
};

// ─── Types ──────────────────────────────────────────────────────

/** Configuration for the dropdown */
export interface MentionDropdownConfig {
  /** Maximum number of items to display */
  maxItems?: number;
  /** Debounce delay for fetching suggestions */
  debounceMs?: number;
}

/** Callback when a suggestion is selected */
export type MentionSelectCallback = (suggestion: MentionSuggestionItem) => void;

/** Callback when the dropdown is dismissed */
export type MentionDismissCallback = () => void;

// ─── MentionAutocompleteDropdown ────────────────────────────────

/**
 * MentionAutocompleteDropdown — Renders an autocomplete dropdown for @-mentions.
 *
 * Attaches to a chat input element and monitors for `@` triggers.
 * Fetches suggestions from the main process via IPC and renders them
 * in a positioned dropdown below the cursor.
 */
export class MentionAutocompleteDropdown {
  private dropdownEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | HTMLTextAreaElement | null = null;
  private config: Required<MentionDropdownConfig>;
  private suggestions: MentionSuggestionItem[] = [];
  private activeIndex = -1;
  private visible = false;
  private mentionStartIndex = -1;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  private selectCallback: MentionSelectCallback | null = null;
  private dismissCallback: MentionDismissCallback | null = null;

  // Bound event handlers (for cleanup)
  private boundOnInput: ((e: Event) => void) | null = null;
  private boundOnKeyDown: ((e: Event) => void) | null = null;
  private boundOnBlur: ((e: Event) => void) | null = null;

  constructor(config: MentionDropdownConfig = {}) {
    this.config = {
      maxItems: config.maxItems ?? MAX_VISIBLE_ITEMS,
      debounceMs: config.debounceMs ?? SUGGESTION_DEBOUNCE_MS,
    };
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  /**
   * Attach the dropdown to a chat input element.
   *
   * @param inputEl - The input/textarea element to monitor
   */
  attach(inputEl: HTMLInputElement | HTMLTextAreaElement): void {
    this.inputEl = inputEl;
    this.createDropdownElement();

    this.boundOnInput = this.handleInput.bind(this);
    this.boundOnKeyDown = this.handleKeyDown.bind(this) as (e: Event) => void;
    this.boundOnBlur = this.handleBlur.bind(this) as (e: Event) => void;

    inputEl.addEventListener('input', this.boundOnInput);
    inputEl.addEventListener('keydown', this.boundOnKeyDown);
    inputEl.addEventListener('blur', this.boundOnBlur);
  }

  /**
   * Detach from the input and clean up resources.
   */
  detach(): void {
    if (this.inputEl) {
      if (this.boundOnInput) this.inputEl.removeEventListener('input', this.boundOnInput);
      if (this.boundOnKeyDown) this.inputEl.removeEventListener('keydown', this.boundOnKeyDown);
      if (this.boundOnBlur) this.inputEl.removeEventListener('blur', this.boundOnBlur);
    }

    this.hide();
    this.removeDropdownElement();
    this.inputEl = null;
    this.clearDebounce();
  }

  /**
   * Register callback for when a suggestion is selected.
   */
  onSelect(callback: MentionSelectCallback): void {
    this.selectCallback = callback;
  }

  /**
   * Register callback for when the dropdown is dismissed.
   */
  onDismiss(callback: MentionDismissCallback): void {
    this.dismissCallback = callback;
  }

  // ─── Visibility ───────────────────────────────────────────────

  /**
   * Show the dropdown with the given suggestions.
   */
  show(suggestions: MentionSuggestionItem[]): void {
    this.suggestions = suggestions.slice(0, this.config.maxItems);
    this.activeIndex = this.suggestions.length > 0 ? 0 : -1;
    this.visible = true;
    this.render();

    if (this.dropdownEl) {
      this.dropdownEl.style.display = 'block';
      this.dropdownEl.setAttribute('aria-hidden', 'false');
    }
  }

  /**
   * Hide the dropdown.
   */
  hide(): void {
    this.visible = false;
    this.suggestions = [];
    this.activeIndex = -1;
    this.mentionStartIndex = -1;

    if (this.dropdownEl) {
      this.dropdownEl.style.display = 'none';
      this.dropdownEl.setAttribute('aria-hidden', 'true');
    }
  }

  /**
   * Whether the dropdown is currently visible.
   */
  isVisible(): boolean {
    return this.visible;
  }

  /**
   * Get the current suggestions.
   */
  getSuggestions(): MentionSuggestionItem[] {
    return this.suggestions;
  }

  /**
   * Get the active (highlighted) suggestion index.
   */
  getActiveIndex(): number {
    return this.activeIndex;
  }

  /**
   * Get the dropdown DOM element (for testing/positioning).
   */
  getElement(): HTMLElement | null {
    return this.dropdownEl;
  }

  // ─── Input Handling ───────────────────────────────────────────

  private handleInput(e: Event): void {
    const input = e.target as HTMLInputElement | HTMLTextAreaElement;
    const value = input.value;
    const cursorPos = input.selectionStart ?? value.length;

    // Find the `@` that triggered this mention
    const atIndex = this.findMentionTrigger(value, cursorPos);

    if (atIndex === -1) {
      // No active mention trigger
      if (this.visible) this.hide();
      return;
    }

    this.mentionStartIndex = atIndex;
    const query = value.slice(atIndex + 1, cursorPos);

    this.fetchSuggestions(query);
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (!this.visible) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.moveSelection(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.moveSelection(-1);
        break;
      case 'Enter':
      case 'Tab':
        if (this.activeIndex >= 0 && this.activeIndex < this.suggestions.length) {
          const selected = this.suggestions[this.activeIndex];
          if (selected) {
            e.preventDefault();
            this.acceptSuggestion(selected);
          }
        }
        break;
      case 'Escape':
        e.preventDefault();
        this.hide();
        if (this.dismissCallback) this.dismissCallback();
        break;
    }
  }

  private handleBlur(_e: FocusEvent): void {
    // Delay hide to allow click events on dropdown items to fire first
    setTimeout(() => {
      if (this.visible) {
        this.hide();
        if (this.dismissCallback) this.dismissCallback();
      }
    }, 200);
  }

  // ─── Suggestion Fetching ──────────────────────────────────────

  private fetchSuggestions(query: string): void {
    this.clearDebounce();

    this.debounceTimer = setTimeout(async () => {
      const client = getMentionIpcClient();
      const suggestions = await client.listMentionables(query);

      if (suggestions.length > 0) {
        this.show(suggestions);
      } else {
        this.hide();
      }
    }, this.config.debounceMs);
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // ─── Selection Logic ──────────────────────────────────────────

  private moveSelection(direction: number): void {
    if (this.suggestions.length === 0) return;

    this.activeIndex += direction;
    if (this.activeIndex < 0) this.activeIndex = this.suggestions.length - 1;
    if (this.activeIndex >= this.suggestions.length) this.activeIndex = 0;

    this.render();
  }

  private acceptSuggestion(suggestion: MentionSuggestionItem): void {
    if (!this.inputEl || this.mentionStartIndex === -1) return;

    const value = this.inputEl.value;
    const cursorPos = this.inputEl.selectionStart ?? value.length;

    // Replace the `@query` text with the full mention insert text
    const before = value.slice(0, this.mentionStartIndex);
    const after = value.slice(cursorPos);
    const insertText = `@${suggestion.insertText} `;
    const newValue = before + insertText + after;

    this.inputEl.value = newValue;

    // Move cursor after the inserted mention
    const newCursorPos = before.length + insertText.length;
    this.inputEl.setSelectionRange(newCursorPos, newCursorPos);

    // Dispatch input event so other listeners pick up the change
    this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

    this.hide();

    if (this.selectCallback) {
      this.selectCallback(suggestion);
    }
  }

  // ─── Trigger Detection ────────────────────────────────────────

  /**
   * Find the position of the `@` that triggered the current mention.
   *
   * Scans backwards from cursor position looking for `@` that is either
   * at the start of the input or preceded by whitespace.
   *
   * @returns Index of `@` or -1 if no valid trigger found
   */
  private findMentionTrigger(value: string, cursorPos: number): number {
    for (let i = cursorPos - 1; i >= 0; i--) {
      const char = value.charAt(i);

      // Found whitespace before finding @; no trigger
      if (char === ' ' || char === '\n' || char === '\t') {
        return -1;
      }

      if (char === '@') {
        // Valid trigger if at start or preceded by whitespace
        if (i === 0 || /\s/.test(value.charAt(i - 1))) {
          return i;
        }
        return -1;
      }
    }
    return -1;
  }

  // ─── DOM Rendering ────────────────────────────────────────────

  private createDropdownElement(): void {
    this.dropdownEl = document.createElement('div');
    this.dropdownEl.className = 'nn-mention-dropdown';
    this.dropdownEl.setAttribute('role', 'listbox');
    this.dropdownEl.setAttribute('aria-label', 'Mention suggestions');
    this.dropdownEl.setAttribute('aria-hidden', 'true');
    this.dropdownEl.style.display = 'none';

    this.listEl = document.createElement('ul');
    this.listEl.className = 'nn-mention-dropdown__list';
    this.listEl.setAttribute('role', 'group');
    this.dropdownEl.appendChild(this.listEl);

    // Insert into the DOM relative to the input
    if (this.inputEl?.parentElement) {
      this.inputEl.parentElement.style.position = 'relative';
      this.inputEl.parentElement.appendChild(this.dropdownEl);
    } else {
      document.body.appendChild(this.dropdownEl);
    }
  }

  private removeDropdownElement(): void {
    if (this.dropdownEl && this.dropdownEl.parentElement) {
      this.dropdownEl.parentElement.removeChild(this.dropdownEl);
    }
    this.dropdownEl = null;
    this.listEl = null;
  }

  private render(): void {
    if (!this.listEl) return;

    this.listEl.innerHTML = '';

    for (let i = 0; i < this.suggestions.length; i++) {
      const suggestion = this.suggestions[i];
      if (!suggestion) continue;

      const li = document.createElement('li');
      li.className = 'nn-mention-dropdown__item';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === this.activeIndex));
      li.dataset.index = String(i);

      if (i === this.activeIndex) {
        li.classList.add('nn-mention-dropdown__item--active');
      }

      const icon = MENTION_TYPE_ICONS[suggestion.type] ?? '📎';

      li.innerHTML = `
        <span class="nn-mention-dropdown__icon" aria-hidden="true">${icon}</span>
        <span class="nn-mention-dropdown__label">${this.escapeHtml(suggestion.label)}</span>
        ${suggestion.description ? `<span class="nn-mention-dropdown__desc">${this.escapeHtml(suggestion.description)}</span>` : ''}
      `;

      li.addEventListener('mousedown', (e: MouseEvent) => {
        e.preventDefault(); // Prevent blur
        this.acceptSuggestion(suggestion);
      });

      li.addEventListener('mouseenter', () => {
        this.activeIndex = i;
        this.render();
      });

      this.listEl!.appendChild(li);
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// ─── Styles ─────────────────────────────────────────────────────

/**
 * CSS styles for the mention autocomplete dropdown.
 * Should be injected into the document or defined in a stylesheet.
 */
export const MENTION_DROPDOWN_STYLES = `
.nn-mention-dropdown {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  max-height: 300px;
  overflow-y: auto;
  background: var(--bg-overlay, #1e1e1e);
  border: 1px solid var(--border-color, #3c3c3c);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  z-index: 1000;
  margin-bottom: 4px;
}

.nn-mention-dropdown__list {
  list-style: none;
  margin: 0;
  padding: 4px;
}

.nn-mention-dropdown__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary, #e0e0e0);
  transition: background-color 0.1s ease;
}

.nn-mention-dropdown__item:hover,
.nn-mention-dropdown__item--active {
  background-color: var(--bg-hover, rgba(255, 255, 255, 0.08));
}

.nn-mention-dropdown__icon {
  flex-shrink: 0;
  font-size: 14px;
}

.nn-mention-dropdown__label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nn-mention-dropdown__desc {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-dim, #6b7280);
}
`;
