/**
 * MentionChip — Renders resolved mentions as clickable chips in the chat input.
 *
 * Each chip displays:
 * - Type icon (file, folder, url, etc.)
 * - Target name/path
 * - Optional close button to remove the mention
 *
 * Chips are clickable to preview the resolved content.
 *
 * Requirements: 14.5
 */

import type { MentionType } from './mention-ipc-client';
import { MENTION_TYPE_ICONS } from './mention-autocomplete-dropdown';

// ─── Types ──────────────────────────────────────────────────────

/** Data for a single mention chip */
export interface MentionChipData {
  /** Unique ID for this chip (for tracking) */
  id: string;
  /** The mention type */
  type: MentionType;
  /** Display name (filename, folder name, URL, or type keyword) */
  displayName: string;
  /** Full value (complete path, URL, etc.) */
  fullValue: string;
  /** Whether content was successfully resolved */
  resolved: boolean;
  /** Estimated token count of resolved content */
  tokenEstimate: number;
}

/** Callback when a chip is clicked (for preview) */
export type ChipClickCallback = (chip: MentionChipData) => void;

/** Callback when a chip's remove button is clicked */
export type ChipRemoveCallback = (chip: MentionChipData) => void;

// ─── MentionChip ────────────────────────────────────────────────

/**
 * Creates a single mention chip DOM element.
 *
 * @param data - The chip data to render
 * @param onClick - Called when the chip body is clicked
 * @param onRemove - Called when the remove button is clicked
 * @returns The chip DOM element
 */
export function createMentionChip(
  data: MentionChipData,
  onClick?: ChipClickCallback,
  onRemove?: ChipRemoveCallback,
): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'nn-mention-chip';
  chip.dataset.mentionId = data.id;
  chip.dataset.mentionType = data.type;
  chip.setAttribute('role', 'button');
  chip.setAttribute('tabindex', '0');
  chip.setAttribute('aria-label', `${data.type}: ${data.displayName}`);

  if (!data.resolved) {
    chip.classList.add('nn-mention-chip--unresolved');
  }

  const icon = MENTION_TYPE_ICONS[data.type] ?? '📎';

  // Icon
  const iconEl = document.createElement('span');
  iconEl.className = 'nn-mention-chip__icon';
  iconEl.textContent = icon;
  iconEl.setAttribute('aria-hidden', 'true');
  chip.appendChild(iconEl);

  // Label
  const labelEl = document.createElement('span');
  labelEl.className = 'nn-mention-chip__label';
  labelEl.textContent = data.displayName;
  labelEl.title = data.fullValue;
  chip.appendChild(labelEl);

  // Remove button
  const removeBtn = document.createElement('button');
  removeBtn.className = 'nn-mention-chip__remove';
  removeBtn.setAttribute('type', 'button');
  removeBtn.setAttribute('aria-label', `Remove ${data.displayName}`);
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (onRemove) onRemove(data);
  });
  chip.appendChild(removeBtn);

  // Click handler for the chip body (preview)
  chip.addEventListener('click', () => {
    if (onClick) onClick(data);
  });

  // Keyboard support
  chip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (onClick) onClick(data);
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (onRemove) onRemove(data);
    }
  });

  return chip;
}

// ─── MentionChipContainer ───────────────────────────────────────

/**
 * MentionChipContainer — Manages a collection of mention chips in the chat input area.
 *
 * Handles adding/removing chips and provides a consistent layout.
 */
export class MentionChipContainer {
  private containerEl: HTMLElement | null = null;
  private chips: Map<string, MentionChipData> = new Map();
  private chipClickCallback: ChipClickCallback | null = null;
  private chipRemoveCallback: ChipRemoveCallback | null = null;

  /**
   * Mount the chip container into the given parent element.
   *
   * @param parent - The parent element to mount into
   */
  mount(parent: HTMLElement): void {
    this.containerEl = document.createElement('div');
    this.containerEl.className = 'nn-mention-chips';
    this.containerEl.setAttribute('role', 'list');
    this.containerEl.setAttribute('aria-label', 'Active mentions');
    this.containerEl.style.display = 'none';
    parent.appendChild(this.containerEl);
  }

  /**
   * Unmount and clean up.
   */
  unmount(): void {
    if (this.containerEl && this.containerEl.parentElement) {
      this.containerEl.parentElement.removeChild(this.containerEl);
    }
    this.containerEl = null;
    this.chips.clear();
  }

  /**
   * Register callback for chip clicks.
   */
  onChipClick(callback: ChipClickCallback): void {
    this.chipClickCallback = callback;
  }

  /**
   * Register callback for chip removal.
   */
  onChipRemove(callback: ChipRemoveCallback): void {
    this.chipRemoveCallback = callback;
  }

  /**
   * Add a mention chip.
   *
   * @param data - The chip data
   */
  addChip(data: MentionChipData): void {
    if (this.chips.has(data.id)) return; // Avoid duplicates

    this.chips.set(data.id, data);
    this.renderChips();
  }

  /**
   * Remove a mention chip by ID.
   *
   * @param id - The chip ID to remove
   */
  removeChip(id: string): void {
    this.chips.delete(id);
    this.renderChips();
  }

  /**
   * Remove all chips.
   */
  clearChips(): void {
    this.chips.clear();
    this.renderChips();
  }

  /**
   * Get all current chip data.
   */
  getChips(): MentionChipData[] {
    return Array.from(this.chips.values());
  }

  /**
   * Get the container DOM element (for testing).
   */
  getElement(): HTMLElement | null {
    return this.containerEl;
  }

  // ─── Internal ─────────────────────────────────────────────────

  private renderChips(): void {
    if (!this.containerEl) return;

    this.containerEl.innerHTML = '';

    for (const data of this.chips.values()) {
      const chipEl = createMentionChip(
        data,
        this.chipClickCallback ?? undefined,
        (chip) => {
          this.removeChip(chip.id);
          if (this.chipRemoveCallback) this.chipRemoveCallback(chip);
        },
      );
      this.containerEl.appendChild(chipEl);
    }

    // Hide container when empty, show when has chips
    this.containerEl.style.display = this.chips.size > 0 ? 'flex' : 'none';
  }
}

// ─── Styles ─────────────────────────────────────────────────────

/**
 * CSS styles for mention chips.
 */
export const MENTION_CHIP_STYLES = `
.nn-mention-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px 8px;
  min-height: 0;
}

.nn-mention-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  background: var(--chip-bg, rgba(59, 130, 246, 0.15));
  border: 1px solid var(--chip-border, rgba(59, 130, 246, 0.3));
  border-radius: 4px;
  font-size: 12px;
  color: var(--chip-text, #93c5fd);
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease;
  max-width: 200px;
}

.nn-mention-chip:hover {
  background: var(--chip-bg-hover, rgba(59, 130, 246, 0.25));
  border-color: var(--chip-border-hover, rgba(59, 130, 246, 0.5));
}

.nn-mention-chip:focus {
  outline: 2px solid var(--focus-ring, #3b82f6);
  outline-offset: 1px;
}

.nn-mention-chip--unresolved {
  background: var(--chip-bg-unresolved, rgba(245, 158, 11, 0.15));
  border-color: var(--chip-border-unresolved, rgba(245, 158, 11, 0.3));
  color: var(--chip-text-unresolved, #fbbf24);
}

.nn-mention-chip__icon {
  flex-shrink: 0;
  font-size: 12px;
}

.nn-mention-chip__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nn-mention-chip__remove {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.15s;
  padding: 0;
}

.nn-mention-chip__remove:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.1);
}
`;
