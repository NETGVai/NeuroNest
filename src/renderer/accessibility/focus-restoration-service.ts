/**
 * FocusRestorationService — Predictably restores focus after modal
 * interactions, approvals, file navigation, and review actions.
 *
 * Tracks a stack of focus origins so that after closing a dialog,
 * accepting a hunk, opening a file from chat, or completing an approval,
 * focus returns to a predictable prior location.
 *
 * Requirements: 23.7
 */

/** A recorded focus restoration point */
export interface FocusRestorationEntry {
  /** Unique identifier for this restoration point */
  readonly id: string;
  /** CSS selector or element reference for the focus target */
  readonly selector: string;
  /** Human-readable context description */
  readonly context: string;
  /** Timestamp when the entry was pushed */
  readonly timestamp: number;
  /** Optional scroll position to restore */
  readonly scrollTop?: number;
}

/**
 * FocusRestorationService maintains a stack of focus origins.
 *
 * Usage pattern:
 * 1. Before opening a modal/dialog, push the current focus
 * 2. After the modal closes, pop and restore focus
 * 3. If the original element is gone, fall back to a safe container
 */
export class FocusRestorationService {
  private readonly stack: FocusRestorationEntry[] = [];
  private readonly maxStackSize: number;
  private lastRestoredId: string | null = null;

  constructor(maxStackSize = 20) {
    this.maxStackSize = maxStackSize;
  }

  /**
   * Push a focus restoration point onto the stack.
   * Call this before opening a modal, navigating away, etc.
   */
  push(entry: Omit<FocusRestorationEntry, 'timestamp'>): void {
    const fullEntry: FocusRestorationEntry = {
      ...entry,
      timestamp: Date.now(),
    };

    this.stack.push(fullEntry);

    // Enforce max stack size
    if (this.stack.length > this.maxStackSize) {
      this.stack.shift();
    }
  }

  /**
   * Pop the most recent restoration entry and attempt to restore focus.
   * Returns the entry that was restored, or null if the stack was empty
   * or restoration failed.
   *
   * @param container - Root element to search within for the selector
   */
  pop(container: HTMLElement | Document = document): FocusRestorationEntry | null {
    const entry = this.stack.pop();
    if (!entry) return null;

    const restored = this.restoreFocus(entry, container);
    if (restored) {
      this.lastRestoredId = entry.id;
    }
    return restored ? entry : null;
  }

  /**
   * Peek at the top of the stack without removing it.
   */
  peek(): FocusRestorationEntry | null {
    return this.stack.length > 0
      ? this.stack[this.stack.length - 1]!
      : null;
  }

  /**
   * Get the number of entries on the stack.
   */
  getStackSize(): number {
    return this.stack.length;
  }

  /**
   * Get the ID of the last successfully restored entry.
   */
  getLastRestoredId(): string | null {
    return this.lastRestoredId;
  }

  /**
   * Clear the entire focus stack.
   */
  clear(): void {
    this.stack.length = 0;
  }

  /**
   * Remove a specific entry by ID (e.g., if its source element was removed).
   */
  removeById(id: string): boolean {
    const idx = this.stack.findIndex(e => e.id === id);
    if (idx >= 0) {
      this.stack.splice(idx, 1);
      return true;
    }
    return false;
  }

  /**
   * Attempt to restore focus to the target described by an entry.
   * Falls back to the container if the original target is unavailable.
   */
  private restoreFocus(
    entry: FocusRestorationEntry,
    container: HTMLElement | Document,
  ): boolean {
    const target = container.querySelector(entry.selector) as HTMLElement | null;

    if (target && typeof target.focus === 'function') {
      target.focus();
      if (entry.scrollTop !== undefined && target.scrollTop !== undefined) {
        target.scrollTop = entry.scrollTop;
      }
      return true;
    }

    // Fallback: focus the container or body
    if (container instanceof HTMLElement && typeof container.focus === 'function') {
      container.focus();
      return true;
    }

    return false;
  }
}
