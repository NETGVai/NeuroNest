/**
 * Composition Suppressor — IME composition state tracker and command filter.
 *
 * Tracks input-method composition lifecycle (compositionstart/compositionend)
 * and suppresses command-semantic keyboard shortcuts while composition is active.
 *
 * While an input-method composition is active:
 * - Enter is treated as composition input (no send/submit)
 * - No queue mutation shortcuts fire
 * - No steer commands fire
 * - No commit actions fire
 * - No slash/command actions fire
 *
 * After composition ends, all shortcuts resume normal behavior.
 *
 * Requirements: 39.8, 39.18
 */

// ─── Key Event Types ────────────────────────────────────────────

/**
 * Represents a keyboard event in the composer or queue editor context.
 */
export interface ComposerKeyEvent {
  /** Key identifier (e.g., 'Enter', 'Escape', 'a', 'Tab'). */
  readonly key: string;

  /** Whether Ctrl/Cmd is held. */
  readonly ctrlKey?: boolean;

  /** Whether Shift is held. */
  readonly shiftKey?: boolean;

  /** Whether Alt/Option is held. */
  readonly altKey?: boolean;

  /** Whether Meta/Command is held. */
  readonly metaKey?: boolean;
}

// ─── Composition Events ─────────────────────────────────────────

/**
 * Types of events in a composer/queue key sequence.
 */
export type ComposerEventKind =
  | 'compositionstart'
  | 'compositionend'
  | 'keydown';

/**
 * A single event in a composer/queue key sequence.
 */
export type ComposerSequenceEvent =
  | { readonly kind: 'compositionstart' }
  | { readonly kind: 'compositionend' }
  | { readonly kind: 'keydown'; readonly event: ComposerKeyEvent };

// ─── Command Semantics ──────────────────────────────────────────

/**
 * The command actions that can be triggered by keyboard shortcuts.
 * These are suppressed while composition is active.
 */
export type CommandAction =
  | 'send'
  | 'command'
  | 'queue'
  | 'steer'
  | 'commit';

/**
 * Result of processing a key event through the composition suppressor.
 */
export interface KeyProcessingResult {
  /** Whether the key event was suppressed due to active composition. */
  readonly suppressed: boolean;

  /** The action that would have been triggered, or undefined if no action matches. */
  readonly action: CommandAction | undefined;

  /** Whether composition is currently active after processing this event. */
  readonly compositionActive: boolean;
}

// ─── Shortcut Definitions ───────────────────────────────────────

/**
 * A keyboard shortcut definition mapped to a command action.
 */
export interface ShortcutDefinition {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly action: CommandAction;
}

/**
 * Default shortcut bindings for composer and queue contexts.
 */
export const DEFAULT_SHORTCUTS: readonly ShortcutDefinition[] = [
  // Send: Enter without modifiers
  { key: 'Enter', action: 'send' },
  // Queue: Ctrl+Enter or Cmd+Enter
  { key: 'Enter', ctrlKey: true, action: 'queue' },
  { key: 'Enter', metaKey: true, action: 'queue' },
  // Steer: Shift+Enter
  { key: 'Enter', shiftKey: true, action: 'steer' },
  // Commit: Ctrl+Shift+Enter
  { key: 'Enter', ctrlKey: true, shiftKey: true, action: 'commit' },
  // Command: slash
  { key: '/', ctrlKey: true, action: 'command' },
];

// ─── Composition Suppressor ─────────────────────────────────────

/**
 * Tracks IME composition state and determines whether keyboard shortcuts
 * should fire or be suppressed.
 *
 * Usage:
 * ```ts
 * const suppressor = new CompositionSuppressor();
 *
 * // Process events from the composer/queue editor
 * for (const event of keySequence) {
 *   const result = suppressor.process(event);
 *   if (!result.suppressed && result.action) {
 *     // Execute the action
 *   }
 * }
 * ```
 */
export class CompositionSuppressor {
  private _composing = false;
  private readonly shortcuts: readonly ShortcutDefinition[];

  constructor(shortcuts: readonly ShortcutDefinition[] = DEFAULT_SHORTCUTS) {
    this.shortcuts = shortcuts;
  }

  /** Whether an input-method composition is currently active. */
  get isComposing(): boolean {
    return this._composing;
  }

  /**
   * Process a single event in the composer/queue sequence.
   *
   * Composition start/end events update internal state.
   * Key events are checked against shortcuts:
   * - If composition is active, any matching action is suppressed.
   * - If composition is not active, the action is allowed.
   */
  process(event: ComposerSequenceEvent): KeyProcessingResult {
    switch (event.kind) {
      case 'compositionstart':
        this._composing = true;
        return {
          suppressed: false,
          action: undefined,
          compositionActive: true,
        };

      case 'compositionend':
        this._composing = false;
        return {
          suppressed: false,
          action: undefined,
          compositionActive: false,
        };

      case 'keydown': {
        const action = this.matchShortcut(event.event);
        if (action && this._composing) {
          // Suppress the action — composition is active (Requirements 39.8, 39.18)
          return {
            suppressed: true,
            action,
            compositionActive: true,
          };
        }
        return {
          suppressed: false,
          action,
          compositionActive: this._composing,
        };
      }
    }
  }

  /**
   * Process an entire sequence of events and return all results.
   */
  processSequence(events: readonly ComposerSequenceEvent[]): KeyProcessingResult[] {
    return events.map((e) => this.process(e));
  }

  /**
   * Reset composition state (e.g., on focus loss or editor unmount).
   */
  reset(): void {
    this._composing = false;
  }

  /**
   * Match a key event against registered shortcuts.
   * Returns the first matching action, or undefined if no match.
   *
   * Shortcuts with more modifiers are matched more specifically first.
   */
  private matchShortcut(event: ComposerKeyEvent): CommandAction | undefined {
    // Sort shortcuts by specificity (more modifiers = more specific = higher priority)
    const sorted = [...this.shortcuts].sort((a, b) => {
      const aScore = (a.ctrlKey ? 1 : 0) + (a.shiftKey ? 1 : 0) + (a.altKey ? 1 : 0) + (a.metaKey ? 1 : 0);
      const bScore = (b.ctrlKey ? 1 : 0) + (b.shiftKey ? 1 : 0) + (b.altKey ? 1 : 0) + (b.metaKey ? 1 : 0);
      return bScore - aScore; // more specific first
    });

    for (const shortcut of sorted) {
      if (this.matchesSingle(event, shortcut)) {
        return shortcut.action;
      }
    }
    return undefined;
  }

  private matchesSingle(event: ComposerKeyEvent, shortcut: ShortcutDefinition): boolean {
    if (event.key !== shortcut.key) return false;

    const eventCtrl = event.ctrlKey ?? false;
    const eventShift = event.shiftKey ?? false;
    const eventAlt = event.altKey ?? false;
    const eventMeta = event.metaKey ?? false;

    const shortcutCtrl = shortcut.ctrlKey ?? false;
    const shortcutShift = shortcut.shiftKey ?? false;
    const shortcutAlt = shortcut.altKey ?? false;
    const shortcutMeta = shortcut.metaKey ?? false;

    return (
      eventCtrl === shortcutCtrl &&
      eventShift === shortcutShift &&
      eventAlt === shortcutAlt &&
      eventMeta === shortcutMeta
    );
  }
}
