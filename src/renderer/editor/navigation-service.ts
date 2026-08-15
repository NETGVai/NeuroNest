/**
 * NavigationService — Unified Back/Forward navigation history across surfaces.
 *
 * Records navigation entries from all surfaces (editor, chat citations, task files,
 * diff views) and supports goBack()/goForward() with stack semantics.
 * Navigates targets in a chosen or context-appropriate editor group.
 *
 * Requirements: 2.3, 2.4
 */

import { canonicalizeUri } from './uri-canonicalization';

/**
 * Surface types from which navigation can originate.
 */
export type NavigationSurfaceType =
  | 'definition'
  | 'reference'
  | 'diagnostic'
  | 'citation'
  | 'task'
  | 'diff-hunk'
  | 'symbol'
  | 'file'
  | 'planning-artifact';

/**
 * A single navigation history entry.
 */
export interface NavigationEntry {
  uri: string;
  position: { lineNumber: number; column: number };
  symbolName?: string;
  surfaceType: NavigationSurfaceType;
  groupId?: string;
  timestamp: number;
}

/**
 * Result of a navigation attempt.
 */
export interface NavigationResult {
  success: boolean;
  entry?: NavigationEntry;
  reason?: string;
}

/**
 * Callback to focus a file/position in an editor group.
 */
export type NavigationFocusHandler = (
  uri: string,
  position: { lineNumber: number; column: number },
  groupId?: string,
) => boolean;

/**
 * NavigationService maintains unified Back/Forward history
 * across files, symbols, diffs, and planning artifacts.
 */
export class NavigationService {
  private readonly backStack: NavigationEntry[] = [];
  private readonly forwardStack: NavigationEntry[] = [];
  private currentEntry: NavigationEntry | null = null;
  private readonly maxHistorySize: number;
  private focusHandler: NavigationFocusHandler | null = null;

  constructor(options?: { maxHistorySize?: number }) {
    this.maxHistorySize = options?.maxHistorySize ?? 100;
  }

  /**
   * Register a handler that focuses a file at a position in a group.
   */
  setFocusHandler(handler: NavigationFocusHandler): void {
    this.focusHandler = handler;
  }

  /**
   * Record a navigation to a target in a chosen or context-appropriate group.
   * Clears the forward stack (standard browser-like behavior).
   */
  recordNavigation(
    uri: string,
    position: { lineNumber: number; column: number },
    surfaceType: NavigationSurfaceType,
    options?: { groupId?: string; symbolName?: string },
  ): void {
    const canonicalUri = canonicalizeUri(uri);

    // Push current entry to back stack before overwriting
    if (this.currentEntry) {
      this.backStack.push(this.currentEntry);
      if (this.backStack.length > this.maxHistorySize) {
        this.backStack.shift();
      }
    }

    // Clear forward stack on new navigation
    this.forwardStack.length = 0;

    this.currentEntry = {
      uri: canonicalUri,
      position,
      symbolName: options?.symbolName,
      surfaceType,
      groupId: options?.groupId,
      timestamp: Date.now(),
    };
  }

  /**
   * Navigate back to the previous entry.
   */
  goBack(): NavigationResult {
    if (this.backStack.length === 0) {
      return { success: false, reason: 'No back history available.' };
    }

    // Push current to forward stack
    if (this.currentEntry) {
      this.forwardStack.push(this.currentEntry);
    }

    const entry = this.backStack.pop()!;
    this.currentEntry = entry;

    // Focus the target
    if (this.focusHandler) {
      this.focusHandler(entry.uri, entry.position, entry.groupId);
    }

    return { success: true, entry };
  }

  /**
   * Navigate forward to the next entry.
   */
  goForward(): NavigationResult {
    if (this.forwardStack.length === 0) {
      return { success: false, reason: 'No forward history available.' };
    }

    // Push current to back stack
    if (this.currentEntry) {
      this.backStack.push(this.currentEntry);
      if (this.backStack.length > this.maxHistorySize) {
        this.backStack.shift();
      }
    }

    const entry = this.forwardStack.pop()!;
    this.currentEntry = entry;

    // Focus the target
    if (this.focusHandler) {
      this.focusHandler(entry.uri, entry.position, entry.groupId);
    }

    return { success: true, entry };
  }

  /**
   * Whether back navigation is available.
   */
  canGoBack(): boolean {
    return this.backStack.length > 0;
  }

  /**
   * Whether forward navigation is available.
   */
  canGoForward(): boolean {
    return this.forwardStack.length > 0;
  }

  /**
   * Get the current navigation entry.
   */
  getCurrentEntry(): NavigationEntry | null {
    return this.currentEntry;
  }

  /**
   * Get all back entries (oldest first).
   */
  getBackStack(): ReadonlyArray<NavigationEntry> {
    return this.backStack;
  }

  /**
   * Get all forward entries (oldest first).
   */
  getForwardStack(): ReadonlyArray<NavigationEntry> {
    return this.forwardStack;
  }

  /**
   * Clear all history.
   */
  clear(): void {
    this.backStack.length = 0;
    this.forwardStack.length = 0;
    this.currentEntry = null;
  }
}
