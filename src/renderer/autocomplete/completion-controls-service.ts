/**
 * CompletionControlsService — Keyboard acceptance, partial acceptance,
 * dismissal, and regeneration of completion suggestions.
 *
 * All actions require an explicit target URI (no active-editor target inference).
 *
 * Requirements: 4.6
 */

import type { CompletionResult } from './completion-controller';

// ─── Types ──────────────────────────────────────────────────────

/** Control action type */
export type CompletionAction = 'accept' | 'partial_accept' | 'dismiss' | 'regenerate';

/** Result of a control action */
export interface ControlActionResult {
  action: CompletionAction;
  /** Explicit URI the action applies to */
  targetUri: string;
  /** The completion result involved (null for dismiss/regenerate) */
  result: CompletionResult | null;
  /** For partial accept: the accepted portion */
  acceptedText?: string;
  /** For partial accept: remaining text */
  remainingText?: string;
  /** Timestamp of the action */
  timestamp: number;
}

/** Keyboard binding configuration */
export interface KeyBindingConfig {
  accept: string;
  partialAccept: string;
  dismiss: string;
  regenerate: string;
}

/** Regeneration request to be handled externally */
export interface RegenerationRequest {
  targetUri: string;
  documentVersion: number;
  cursorLine: number;
  cursorColumn: number;
  language: string;
  workspaceId: string;
  previousRequestId: string | null;
}

/** Pending completion state tracked by the service */
export interface PendingCompletion {
  result: CompletionResult;
  targetUri: string;
  documentVersion: number;
  cursorLine: number;
  cursorColumn: number;
  language: string;
  workspaceId: string;
}

// ─── CompletionControlsService ──────────────────────────────────

/**
 * CompletionControlsService manages user keyboard interactions with
 * active completion suggestions without inferring the active editor target.
 *
 * Every action requires an explicit URI binding — no ambient file inference.
 */
export class CompletionControlsService {
  private pendingCompletion: PendingCompletion | null = null;
  private keyBindings: KeyBindingConfig;
  private disposed = false;

  // Callbacks
  private acceptHandler: ((result: ControlActionResult) => void) | null = null;
  private dismissHandler: ((result: ControlActionResult) => void) | null = null;
  private regenerateHandler: ((request: RegenerationRequest) => void) | null = null;

  constructor(keyBindings?: Partial<KeyBindingConfig>) {
    this.keyBindings = {
      accept: keyBindings?.accept ?? 'Tab',
      partialAccept: keyBindings?.partialAccept ?? 'Ctrl+Right',
      dismiss: keyBindings?.dismiss ?? 'Escape',
      regenerate: keyBindings?.regenerate ?? 'Alt+]',
    };
  }

  // ─── Configuration ──────────────────────────────────────────

  /**
   * Get the current key binding configuration.
   */
  getKeyBindings(): Readonly<KeyBindingConfig> {
    return { ...this.keyBindings };
  }

  /**
   * Update key bindings.
   */
  setKeyBindings(bindings: Partial<KeyBindingConfig>): void {
    if (bindings.accept !== undefined) this.keyBindings.accept = bindings.accept;
    if (bindings.partialAccept !== undefined) this.keyBindings.partialAccept = bindings.partialAccept;
    if (bindings.dismiss !== undefined) this.keyBindings.dismiss = bindings.dismiss;
    if (bindings.regenerate !== undefined) this.keyBindings.regenerate = bindings.regenerate;
  }

  // ─── Event handlers ─────────────────────────────────────────

  onAccept(handler: (result: ControlActionResult) => void): void {
    this.acceptHandler = handler;
  }

  onDismiss(handler: (result: ControlActionResult) => void): void {
    this.dismissHandler = handler;
  }

  onRegenerate(handler: (request: RegenerationRequest) => void): void {
    this.regenerateHandler = handler;
  }

  // ─── Pending Completion State ───────────────────────────────

  /**
   * Set the active pending completion.
   * Requires explicit URI — never inferred.
   */
  setPending(completion: PendingCompletion): void {
    if (this.disposed) return;
    this.pendingCompletion = completion;
  }

  /**
   * Get the current pending completion.
   */
  getPending(): PendingCompletion | null {
    return this.pendingCompletion;
  }

  /**
   * Check if there is an active pending completion.
   */
  hasPending(): boolean {
    return this.pendingCompletion !== null;
  }

  /**
   * Clear pending completion without triggering any action.
   */
  clearPending(): void {
    this.pendingCompletion = null;
  }

  // ─── Actions ────────────────────────────────────────────────

  /**
   * Accept the full pending completion for the given URI.
   * Returns null if no pending completion or URI mismatch.
   */
  accept(targetUri: string): ControlActionResult | null {
    if (this.disposed) return null;
    if (!this.pendingCompletion) return null;
    if (this.pendingCompletion.targetUri !== targetUri) return null;

    const result: ControlActionResult = {
      action: 'accept',
      targetUri,
      result: this.pendingCompletion.result,
      timestamp: Date.now(),
    };

    this.pendingCompletion = null;

    if (this.acceptHandler) {
      this.acceptHandler(result);
    }

    return result;
  }

  /**
   * Accept a partial portion of the pending completion (word-by-word).
   * Returns null if no pending completion, URI mismatch, or partial accept not supported.
   */
  partialAccept(targetUri: string): ControlActionResult | null {
    if (this.disposed) return null;
    if (!this.pendingCompletion) return null;
    if (this.pendingCompletion.targetUri !== targetUri) return null;

    const fullText = this.pendingCompletion.result.text;
    if (!fullText || fullText.length === 0) return null;

    // Extract the next word (word boundary: space, punctuation, etc.)
    const nextWord = this.extractNextWord(fullText);
    if (!nextWord) return null;

    const remainingText = fullText.slice(nextWord.length);

    const result: ControlActionResult = {
      action: 'partial_accept',
      targetUri,
      result: this.pendingCompletion.result,
      acceptedText: nextWord,
      remainingText,
      timestamp: Date.now(),
    };

    if (remainingText.length > 0) {
      // Update pending with remaining text
      this.pendingCompletion = {
        ...this.pendingCompletion,
        result: {
          ...this.pendingCompletion.result,
          text: remainingText,
        },
      };
    } else {
      // Fully accepted via partial accept
      this.pendingCompletion = null;
    }

    if (this.acceptHandler) {
      this.acceptHandler(result);
    }

    return result;
  }

  /**
   * Dismiss the current pending completion for the given URI.
   * Returns null if no pending completion or URI mismatch.
   */
  dismiss(targetUri: string): ControlActionResult | null {
    if (this.disposed) return null;
    if (!this.pendingCompletion) return null;
    if (this.pendingCompletion.targetUri !== targetUri) return null;

    const result: ControlActionResult = {
      action: 'dismiss',
      targetUri,
      result: this.pendingCompletion.result,
      timestamp: Date.now(),
    };

    this.pendingCompletion = null;

    if (this.dismissHandler) {
      this.dismissHandler(result);
    }

    return result;
  }

  /**
   * Request regeneration of the completion for the given URI.
   * Dismisses the current completion and requests a new one.
   * Returns null if no pending completion or URI mismatch.
   */
  regenerate(targetUri: string): ControlActionResult | null {
    if (this.disposed) return null;
    if (!this.pendingCompletion) return null;
    if (this.pendingCompletion.targetUri !== targetUri) return null;

    const pending = this.pendingCompletion;

    const result: ControlActionResult = {
      action: 'regenerate',
      targetUri,
      result: pending.result,
      timestamp: Date.now(),
    };

    const regenerationRequest: RegenerationRequest = {
      targetUri: pending.targetUri,
      documentVersion: pending.documentVersion,
      cursorLine: pending.cursorLine,
      cursorColumn: pending.cursorColumn,
      language: pending.language,
      workspaceId: pending.workspaceId,
      previousRequestId: pending.result.requestId,
    };

    this.pendingCompletion = null;

    if (this.regenerateHandler) {
      this.regenerateHandler(regenerationRequest);
    }

    return result;
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  dispose(): void {
    this.disposed = true;
    this.pendingCompletion = null;
    this.acceptHandler = null;
    this.dismissHandler = null;
    this.regenerateHandler = null;
  }

  // ─── Internal ─────────────────────────────────────────────────

  /**
   * Extract the next word from text.
   * A "word" is defined as: contiguous non-whitespace chars up to the next
   * whitespace or punctuation boundary.
   */
  private extractNextWord(text: string): string | null {
    if (!text) return null;

    // Match a word: start of text through first word boundary
    const match = text.match(/^(\S+?)(?=[\s.,;:!?(){}[\]<>]|$)/);
    if (match && match[1]) {
      return match[1];
    }

    // If no match, try to get at least one character
    if (text.length > 0) {
      // Try word characters
      const wordMatch = text.match(/^\w+/);
      if (wordMatch) return wordMatch[0];
      // Return first char as fallback
      return text[0];
    }

    return null;
  }
}
