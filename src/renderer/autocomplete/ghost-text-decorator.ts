/**
 * Ghost-text decorator for Monaco editor inline completions.
 *
 * Renders autocomplete suggestions as gray ghost-text overlays at the cursor
 * position. Handles the visual lifecycle of suggestions: show, accept, dismiss.
 *
 * Tab accepts the suggestion (inserts the completion text).
 * Escape dismisses the suggestion (removes ghost-text).
 *
 * Requirements: 1.2, 1.3
 */

// ─── Types ──────────────────────────────────────────────────────

/** Monaco editor instance interface (subset needed for ghost-text) */
export interface MonacoEditor {
  /** Get the current editor model */
  getModel(): MonacoTextModel | null;
  /** Get the current cursor position */
  getPosition(): MonacoPosition | null;
  /** Execute an edit operation on the editor */
  executeEdits(source: string, edits: MonacoEditOperation[]): void;
  /** Set the cursor position */
  setPosition(position: MonacoPosition): void;
  /** Add a keyboard command binding */
  addCommand(keybinding: number, handler: () => void): string | null;
  /** Get the editor's decoration collection or manage decorations */
  createDecorationsCollection(decorations?: MonacoDecoration[]): MonacoDecorationsCollection;
}

/** Monaco text model interface (subset) */
export interface MonacoTextModel {
  /** Get the value of the entire model content */
  getValue(): string;
  /** Get a specific line's content */
  getLineContent(lineNumber: number): string;
  /** Get the total number of lines */
  getLineCount(): number;
}

/** Monaco position */
export interface MonacoPosition {
  lineNumber: number;
  column: number;
}

/** Monaco edit operation */
export interface MonacoEditOperation {
  range: MonacoRange;
  text: string;
}

/** Monaco range */
export interface MonacoRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** Monaco decoration */
export interface MonacoDecoration {
  range: MonacoRange;
  options: MonacoDecorationOptions;
}

/** Monaco decoration options */
export interface MonacoDecorationOptions {
  after?: {
    content: string;
    inlineClassName?: string;
  };
  className?: string;
  inlineClassName?: string;
  isWholeLine?: boolean;
}

/** Monaco decorations collection */
export interface MonacoDecorationsCollection {
  /** Set the decorations (replaces existing) */
  set(decorations: MonacoDecoration[]): void;
  /** Clear all decorations */
  clear(): void;
}

/** Monaco KeyCode constants (subset needed) */
export interface MonacoKeyCodes {
  Tab: number;
  Escape: number;
}

// ─── Ghost Text State ───────────────────────────────────────────

/** Current ghost-text suggestion state */
export interface GhostTextState {
  /** The suggestion text being displayed */
  text: string;
  /** Position where the suggestion starts */
  position: MonacoPosition;
  /** Whether the suggestion is currently visible */
  visible: boolean;
}

// ─── GhostTextDecorator ─────────────────────────────────────────

/**
 * GhostTextDecorator — Manages ghost-text rendering in Monaco editor.
 *
 * Responsibilities:
 * - Render gray ghost-text at the cursor using Monaco decorations
 * - Register Tab to accept (insert text) and Escape to dismiss
 * - Track current suggestion state
 * - Clean up decorations on dismiss or new suggestion
 */
export class GhostTextDecorator {
  private editor: MonacoEditor | null = null;
  private keyCodes: MonacoKeyCodes | null = null;
  private decorationsCollection: MonacoDecorationsCollection | null = null;
  private state: GhostTextState | null = null;
  private _tabCommandId: string | null = null;
  private _escapeCommandId: string | null = null;
  private onAcceptCallback: ((text: string) => void) | null = null;
  private onDismissCallback: (() => void) | null = null;

  /**
   * Attach the decorator to a Monaco editor instance.
   *
   * @param editor - The Monaco editor instance
   * @param keyCodes - Monaco KeyCode constants for Tab and Escape
   */
  attach(editor: MonacoEditor, keyCodes: MonacoKeyCodes): void {
    this.editor = editor;
    this.keyCodes = keyCodes;
    this.decorationsCollection = editor.createDecorationsCollection();
    this.registerKeyBindings();
  }

  /**
   * Detach from the editor and clean up all resources.
   */
  detach(): void {
    this.dismiss();
    this.decorationsCollection = null;
    this.editor = null;
    this.keyCodes = null;
    this._tabCommandId = null;
    this._escapeCommandId = null;
  }

  /**
   * Show a ghost-text suggestion at the given position.
   *
   * Replaces any existing suggestion. The text is rendered as a gray
   * inline decoration after the cursor.
   *
   * @param text - The completion text to display
   * @param position - The cursor position where to show the ghost-text
   */
  show(text: string, position: MonacoPosition): void {
    if (!this.editor || !this.decorationsCollection || !text) {
      return;
    }

    // Clear any existing suggestion
    this.clearDecorations();

    // Split multi-line completions to render the first line inline
    // and subsequent lines as whole-line decorations
    const lines = text.split('\n');
    const decorations: MonacoDecoration[] = [];

    // First line: inline after cursor
    if (lines[0]) {
      decorations.push({
        range: {
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        },
        options: {
          after: {
            content: lines[0],
            inlineClassName: 'nn-ghost-text',
          },
        },
      });
    }

    // Subsequent lines: render as whole-line decorations below
    for (let i = 1; i < lines.length; i++) {
      const lineNum = position.lineNumber + i;
      decorations.push({
        range: {
          startLineNumber: lineNum,
          startColumn: 1,
          endLineNumber: lineNum,
          endColumn: 1,
        },
        options: {
          after: {
            content: lines[i] ?? '',
            inlineClassName: 'nn-ghost-text',
          },
          isWholeLine: true,
        },
      });
    }

    this.decorationsCollection.set(decorations);

    this.state = {
      text,
      position,
      visible: true,
    };
  }

  /**
   * Dismiss the current ghost-text suggestion.
   * Removes all decorations and resets state.
   */
  dismiss(): void {
    this.clearDecorations();
    const wasVisible = this.state?.visible ?? false;
    this.state = null;

    if (wasVisible && this.onDismissCallback) {
      this.onDismissCallback();
    }
  }

  /**
   * Accept the current ghost-text suggestion.
   * Inserts the completion text at the suggestion position and clears decorations.
   */
  accept(): void {
    if (!this.editor || !this.state || !this.state.visible) {
      return;
    }

    const { text, position } = this.state;

    // Insert the completion text at the cursor position
    this.editor.executeEdits('autocomplete.accept', [
      {
        range: {
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        },
        text,
      },
    ]);

    // Move cursor to end of inserted text
    const lines = text.split('\n');
    const lastLine = lines[lines.length - 1] ?? '';
    const newPosition: MonacoPosition = lines.length > 1
      ? { lineNumber: position.lineNumber + lines.length - 1, column: lastLine.length + 1 }
      : { lineNumber: position.lineNumber, column: position.column + text.length };

    this.editor.setPosition(newPosition);

    // Clear decorations and state
    this.clearDecorations();
    const acceptedText = this.state.text;
    this.state = null;

    if (this.onAcceptCallback) {
      this.onAcceptCallback(acceptedText);
    }
  }

  /**
   * Get the current ghost-text state.
   */
  getState(): Readonly<GhostTextState> | null {
    return this.state ? { ...this.state } : null;
  }

  /**
   * Check if a suggestion is currently visible.
   */
  isVisible(): boolean {
    return this.state?.visible ?? false;
  }

  /**
   * Register a callback for when a suggestion is accepted.
   */
  onAccept(callback: (text: string) => void): void {
    this.onAcceptCallback = callback;
  }

  /**
   * Register a callback for when a suggestion is dismissed.
   */
  onDismiss(callback: () => void): void {
    this.onDismissCallback = callback;
  }

  // ─── Internal ─────────────────────────────────────────────────

  private registerKeyBindings(): void {
    if (!this.editor || !this.keyCodes) return;

    // Tab → accept current suggestion
    this._tabCommandId = this.editor.addCommand(this.keyCodes.Tab, () => {
      if (this.state?.visible) {
        this.accept();
      }
    });

    // Escape → dismiss current suggestion
    this._escapeCommandId = this.editor.addCommand(this.keyCodes.Escape, () => {
      if (this.state?.visible) {
        this.dismiss();
      }
    });
  }

  private clearDecorations(): void {
    if (this.decorationsCollection) {
      this.decorationsCollection.clear();
    }
  }
}

/** CSS class name for ghost-text styling */
export const GHOST_TEXT_CLASS = 'nn-ghost-text';

/**
 * CSS styles for the ghost-text decoration.
 * Should be injected into the document or defined in a stylesheet.
 */
export const GHOST_TEXT_STYLES = `
.nn-ghost-text {
  color: #6b7280;
  opacity: 0.6;
  font-style: italic;
  pointer-events: none;
}
`;
