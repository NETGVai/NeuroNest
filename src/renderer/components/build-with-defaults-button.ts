/**
 * BuildWithDefaultsButton — Shared renderer component for the "Build with defaults" escape hatch.
 *
 * Displayed across all depth tiers when there are unresolved (unanswered) interview
 * questions. When activated, sends `interview:action { interviewId, action: 'defaults' }`
 * to the main process, which fills all unanswered questions with their recommendations
 * and hands off to orchestration immediately.
 *
 * Visibility rule (Requirement 8.2):
 *   - SHOWN when there are unresolved questions remaining
 *   - HIDDEN when no unresolved questions remain (all answered)
 *
 * IPC channel:
 *   - `interview:action` (Renderer → Main): { interviewId, action: 'defaults' }
 *
 * Requirements: 8.1, 8.2
 */

import type { InterviewTurn } from '../../pipeline/spec-interview-engine.js';
import { createButton, setButtonDisabled } from './button.js';

// ─── Types ──────────────────────────────────────────────────────

export interface BuildWithDefaultsButtonOptions {
  /** Unique interview identifier */
  interviewId: string;
  /** Current interview turns — used to determine if unresolved questions exist */
  turns: InterviewTurn[];
  /** Callback fired after the defaults IPC message is sent */
  onDefaults?: (interviewId: string) => void;
}

export type BuildWithDefaultsStatus = 'visible' | 'hidden' | 'triggered';

// ─── IPC Constants ──────────────────────────────────────────────

export const INTERVIEW_ACTION_CHANNEL = 'interview:action' as const;
export const DEFAULTS_ACTION = 'defaults' as const;

// ─── Electron API accessor ──────────────────────────────────────

function getElectronAPI(): {
  send(channel: string, ...args: unknown[]): void;
} | null {
  return (window as any).electronAPI ?? null;
}

// ─── Pure Logic Functions (exported for testing) ────────────────

/**
 * Determines whether there are unresolved (unanswered) questions in the turns.
 *
 * Requirement 8.2: Button not displayed when no unresolved questions remain.
 */
export function hasUnresolvedQuestions(turns: InterviewTurn[]): boolean {
  return turns.some(t => t.answer === null);
}

/**
 * Counts the number of unresolved questions.
 */
export function countUnresolved(turns: InterviewTurn[]): number {
  return turns.filter(t => t.answer === null).length;
}

/**
 * Determines if the "Build with defaults" button should be visible.
 *
 * The button is shown when:
 *   1. There are turns (i.e., non-trivial interview)
 *   2. At least one question is unanswered
 *
 * Requirement 8.1: Display at every depth tier
 * Requirement 8.2: Not displayed when no unresolved questions remain
 */
export function shouldShowBuildWithDefaults(turns: InterviewTurn[]): boolean {
  if (!turns || turns.length === 0) return false;
  return hasUnresolvedQuestions(turns);
}

// ─── BuildWithDefaultsButton Component ──────────────────────────

/**
 * A button component that triggers the "Build with defaults" escape hatch.
 *
 * Renders a secondary button labeled "Build with defaults" when there are
 * unresolved questions. Sends `interview:action` IPC with action 'defaults'
 * when clicked, then disables itself.
 *
 * Requirements: 8.1, 8.2
 */
export class BuildWithDefaultsButton {
  private options: BuildWithDefaultsButtonOptions;
  private buttonEl: HTMLButtonElement | null = null;
  private status: BuildWithDefaultsStatus = 'visible';
  private containerEl: HTMLElement | null = null;

  constructor(options: BuildWithDefaultsButtonOptions) {
    this.options = options;
    this.status = shouldShowBuildWithDefaults(options.turns) ? 'visible' : 'hidden';
  }

  /**
   * Render the button into the given container.
   * Returns the container element wrapping the button (for easy insertion).
   */
  render(container: HTMLElement): HTMLElement {
    this.containerEl = container;
    this.updateDOM();
    return container;
  }

  /**
   * Get the current button status.
   */
  getStatus(): BuildWithDefaultsStatus {
    return this.status;
  }

  /**
   * Update the turns and re-evaluate visibility.
   * Call this after an answer is submitted so the button can hide if all questions are resolved.
   */
  updateTurns(turns: InterviewTurn[]): void {
    this.options.turns = turns;
    const shouldShow = shouldShowBuildWithDefaults(turns);

    if (!shouldShow && this.status !== 'triggered') {
      this.status = 'hidden';
    } else if (shouldShow && this.status === 'hidden') {
      this.status = 'visible';
    }

    this.updateDOM();
  }

  /**
   * Programmatically trigger "Build with defaults" (for testing).
   */
  trigger(): void {
    this.handleClick();
  }

  /**
   * Get the underlying button element (for direct DOM access/testing).
   */
  getButtonElement(): HTMLButtonElement | null {
    return this.buttonEl;
  }

  /**
   * Dispose of the component and clean up DOM.
   */
  dispose(): void {
    if (this.containerEl) {
      this.containerEl.innerHTML = '';
    }
    this.buttonEl = null;
    this.containerEl = null;
  }

  // ─── Private ────────────────────────────────────────────────────

  private updateDOM(): void {
    if (!this.containerEl) return;

    if (this.status === 'hidden') {
      this.containerEl.innerHTML = '';
      this.buttonEl = null;
      return;
    }

    if (this.status === 'triggered') {
      // Button was already rendered and triggered — keep it disabled
      if (this.buttonEl) {
        setButtonDisabled(this.buttonEl, true);
      }
      return;
    }

    // Render or re-render the button
    if (!this.buttonEl) {
      this.containerEl.innerHTML = '';
      this.buttonEl = createButton({
        label: 'Build with defaults',
        icon: '⚡',
        variant: 'ghost',
        size: 'medium',
        ariaLabel: 'Build with defaults — skip remaining questions and use recommended answers',
        className: 'build-with-defaults-btn',
        onClick: () => this.handleClick(),
      });
      this.containerEl.appendChild(this.buttonEl);
    }
  }

  /**
   * Handle button click — send IPC and disable.
   *
   * Requirement 8.2: synthesize spec using recommended answers for all unresolved,
   * hand off to orchestration immediately.
   */
  private handleClick(): void {
    if (this.status === 'triggered' || this.status === 'hidden') return;

    this.status = 'triggered';

    // Send IPC to main process
    const api = getElectronAPI();
    if (api) {
      api.send(INTERVIEW_ACTION_CHANNEL, {
        interviewId: this.options.interviewId,
        action: DEFAULTS_ACTION,
      });
    }

    // Disable button visually
    if (this.buttonEl) {
      setButtonDisabled(this.buttonEl, true);
    }

    // Fire callback
    this.options.onDefaults?.(this.options.interviewId);
  }
}

// ─── Factory Function ───────────────────────────────────────────

/**
 * Create a BuildWithDefaultsButton and render it into the given container.
 *
 * Returns null if the button should not be displayed (no unresolved questions).
 */
export function createBuildWithDefaultsButton(
  container: HTMLElement,
  options: BuildWithDefaultsButtonOptions,
): BuildWithDefaultsButton | null {
  if (!shouldShowBuildWithDefaults(options.turns)) {
    return null;
  }

  const button = new BuildWithDefaultsButton(options);
  button.render(container);
  return button;
}
