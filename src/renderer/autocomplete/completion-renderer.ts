/**
 * CompletionRenderer — Renders completion results as ghost text or reviewable diffs.
 *
 * - Insert-only suggestions render as ghost text (using GhostTextDecorator)
 * - Non-insertions (replacements, deletions, cross-location) render as reviewable inline diffs
 *
 * Requirements: 4.5
 */

import type { CompletionResult } from './completion-controller';

// ─── Types ──────────────────────────────────────────────────────

/** The type of rendering applied to a completion result */
export type RenderMode = 'ghost_text' | 'inline_diff';

/** A rendered completion that is pending user action */
export interface RenderedCompletion {
  /** Unique identifier for this rendered completion */
  id: string;
  /** The completion result being rendered */
  result: CompletionResult;
  /** How it was rendered */
  mode: RenderMode;
  /** Whether the user has taken action */
  status: 'pending' | 'accepted' | 'rejected' | 'dismissed';
  /** When it was rendered */
  renderedAt: number;
}

/** Configuration for an inline diff marker */
export interface InlineDiffMarker {
  /** URI of the file this diff applies to */
  uri: string;
  /** Start line of the change */
  startLine: number;
  /** Start column of the change */
  startColumn: number;
  /** End line of the change */
  endLine: number;
  /** End column of the change */
  endColumn: number;
  /** The old text being replaced (empty for additions) */
  oldText: string;
  /** The new text proposed */
  newText: string;
  /** Classification of the change */
  changeType: 'replacement' | 'deletion' | 'cross_location';
}

/** Callback types for renderer events */
export type GhostTextShowHandler = (text: string, line: number, column: number) => void;
export type GhostTextDismissHandler = () => void;
export type InlineDiffShowHandler = (marker: InlineDiffMarker) => void;
export type InlineDiffDismissHandler = (id: string) => void;

// ─── CompletionRenderer ─────────────────────────────────────────

/**
 * CompletionRenderer — Routes completion results to the appropriate visual treatment.
 *
 * Decision logic:
 * - If the result has isInsertOnly=true and no replaceRange and no targetUri: ghost text
 * - Otherwise: inline diff (reviewable)
 */
export class CompletionRenderer {
  private currentRendered: RenderedCompletion | null = null;
  private pendingDiffs: Map<string, RenderedCompletion> = new Map();

  // Callbacks for rendering actions
  private ghostTextShowHandler: GhostTextShowHandler | null = null;
  private ghostTextDismissHandler: GhostTextDismissHandler | null = null;
  private inlineDiffShowHandler: InlineDiffShowHandler | null = null;
  private inlineDiffDismissHandler: InlineDiffDismissHandler | null = null;

  /**
   * Register handler for showing ghost text.
   */
  onGhostTextShow(handler: GhostTextShowHandler): void {
    this.ghostTextShowHandler = handler;
  }

  /**
   * Register handler for dismissing ghost text.
   */
  onGhostTextDismiss(handler: GhostTextDismissHandler): void {
    this.ghostTextDismissHandler = handler;
  }

  /**
   * Register handler for showing inline diff.
   */
  onInlineDiffShow(handler: InlineDiffShowHandler): void {
    this.inlineDiffShowHandler = handler;
  }

  /**
   * Register handler for dismissing inline diff.
   */
  onInlineDiffDismiss(handler: InlineDiffDismissHandler): void {
    this.inlineDiffDismissHandler = handler;
  }

  /**
   * Render a completion result using the appropriate visual treatment.
   *
   * @param result - The completion result to render
   * @param cursorLine - Current cursor line (for ghost text positioning)
   * @param cursorColumn - Current cursor column
   * @returns The rendered completion record
   */
  render(result: CompletionResult, cursorLine: number, cursorColumn: number): RenderedCompletion {
    // Dismiss any existing ghost text
    this.dismissCurrent();

    const mode = this.determineRenderMode(result);
    const rendered: RenderedCompletion = {
      id: `render_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      result,
      mode,
      status: 'pending',
      renderedAt: Date.now(),
    };

    if (mode === 'ghost_text') {
      this.currentRendered = rendered;
      if (this.ghostTextShowHandler) {
        this.ghostTextShowHandler(result.text, cursorLine, cursorColumn);
      }
    } else {
      this.pendingDiffs.set(rendered.id, rendered);
      if (this.inlineDiffShowHandler) {
        const marker = this.createDiffMarker(result, cursorLine, cursorColumn);
        this.inlineDiffShowHandler(marker);
      }
    }

    return rendered;
  }

  /**
   * Determine how to render a given completion result.
   */
  determineRenderMode(result: CompletionResult): RenderMode {
    // Ghost text for pure insertions without a replace range or cross-location target
    if (result.isInsertOnly && !result.replaceRange && !result.targetUri) {
      return 'ghost_text';
    }
    // Everything else gets an inline diff
    return 'inline_diff';
  }

  /**
   * Dismiss the current ghost text rendering.
   */
  dismissCurrent(): void {
    if (this.currentRendered) {
      if (this.currentRendered.status === 'pending') {
        this.currentRendered.status = 'dismissed';
      }
      this.currentRendered = null;
      if (this.ghostTextDismissHandler) {
        this.ghostTextDismissHandler();
      }
    }
  }

  /**
   * Accept the current ghost text rendering.
   */
  acceptCurrent(): CompletionResult | null {
    if (this.currentRendered && this.currentRendered.status === 'pending') {
      this.currentRendered.status = 'accepted';
      const result = this.currentRendered.result;
      this.currentRendered = null;
      if (this.ghostTextDismissHandler) {
        this.ghostTextDismissHandler();
      }
      return result;
    }
    return null;
  }

  /**
   * Accept an inline diff by ID.
   */
  acceptDiff(id: string): CompletionResult | null {
    const rendered = this.pendingDiffs.get(id);
    if (rendered && rendered.status === 'pending') {
      rendered.status = 'accepted';
      this.pendingDiffs.delete(id);
      if (this.inlineDiffDismissHandler) {
        this.inlineDiffDismissHandler(id);
      }
      return rendered.result;
    }
    return null;
  }

  /**
   * Reject an inline diff by ID.
   */
  rejectDiff(id: string): void {
    const rendered = this.pendingDiffs.get(id);
    if (rendered && rendered.status === 'pending') {
      rendered.status = 'rejected';
      this.pendingDiffs.delete(id);
      if (this.inlineDiffDismissHandler) {
        this.inlineDiffDismissHandler(id);
      }
    }
  }

  /**
   * Dismiss all inline diffs.
   */
  dismissAllDiffs(): void {
    for (const [id, rendered] of this.pendingDiffs) {
      if (rendered.status === 'pending') {
        rendered.status = 'dismissed';
      }
      if (this.inlineDiffDismissHandler) {
        this.inlineDiffDismissHandler(id);
      }
    }
    this.pendingDiffs.clear();
  }

  /**
   * Get the current rendered ghost text, if any.
   */
  getCurrentRendered(): RenderedCompletion | null {
    return this.currentRendered;
  }

  /**
   * Get all pending inline diffs.
   */
  getPendingDiffs(): ReadonlyMap<string, RenderedCompletion> {
    return this.pendingDiffs;
  }

  /**
   * Check if there is an active ghost text suggestion.
   */
  hasGhostText(): boolean {
    return this.currentRendered !== null && this.currentRendered.status === 'pending';
  }

  /**
   * Check if there are pending inline diffs.
   */
  hasPendingDiffs(): boolean {
    return this.pendingDiffs.size > 0;
  }

  /**
   * Dispose the renderer and clear all state.
   */
  dispose(): void {
    this.dismissCurrent();
    this.dismissAllDiffs();
    this.ghostTextShowHandler = null;
    this.ghostTextDismissHandler = null;
    this.inlineDiffShowHandler = null;
    this.inlineDiffDismissHandler = null;
  }

  // ─── Internal ─────────────────────────────────────────────────

  private createDiffMarker(result: CompletionResult, cursorLine: number, cursorColumn: number): InlineDiffMarker {
    const range = result.replaceRange ?? {
      startLine: cursorLine,
      startColumn: cursorColumn,
      endLine: cursorLine,
      endColumn: cursorColumn,
    };

    let changeType: InlineDiffMarker['changeType'];
    if (result.targetUri) {
      changeType = 'cross_location';
    } else if (result.text === '') {
      changeType = 'deletion';
    } else {
      changeType = 'replacement';
    }

    return {
      uri: result.targetUri ?? '',
      startLine: range.startLine,
      startColumn: range.startColumn,
      endLine: range.endLine,
      endColumn: range.endColumn,
      oldText: '', // Old text would be fetched from the model in the real implementation
      newText: result.text,
      changeType,
    };
  }
}
