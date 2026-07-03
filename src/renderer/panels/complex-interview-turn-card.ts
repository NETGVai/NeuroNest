/**
 * ComplexInterviewTurnCard — Renderer component for complex-depth one-per-turn interviews.
 *
 * Displays a single interview question with:
 *   - Question text
 *   - Recommended answer (single-tap accept)
 *   - Text input for custom answer
 *   - "Accept recommendation" button
 *   - "Skip to spec" button (exits interview, uses gathered info so far)
 *   - "Build with defaults" button (fills all unanswered with recommendations)
 *
 * The "Build with defaults" button is hidden when no unresolved questions remain
 * (Requirement 8.2).
 *
 * IPC channels:
 *   - `interview:turn` (Main → Renderer): Delivers current InterviewTurn
 *   - `interview:answer` (Renderer → Main): Submits answer for current question
 *   - `interview:action` (Renderer → Main): 'skip' | 'defaults' | 'cancel'
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 8.1, 8.2
 */

import type { InterviewTurn } from '../../pipeline/spec-interview-engine.js';
import { createButton, setButtonDisabled } from '../components/button.js';
import {
  BuildWithDefaultsButton,
  shouldShowBuildWithDefaults,
} from '../components/build-with-defaults-button.js';

// ─── Electron API accessor ──────────────────────────────────────

function eapi(): {
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, cb: (...args: unknown[]) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
} {
  return (window as any).electronAPI;
}

// ─── Types ──────────────────────────────────────────────────────

export interface ComplexInterviewTurnCardOptions {
  /** Unique interview identifier */
  interviewId: string;
  /** The current question turn to display */
  currentTurn: InterviewTurn;
  /** All turns in the interview (for progress and "build with defaults" logic) */
  allTurns: InterviewTurn[];
  /** Current turn index (0-based) out of total */
  currentIndex: number;
  /** Total number of questions */
  totalQuestions: number;
  /** Callback fired after an answer is submitted */
  onAnswerSubmitted?: (questionIndex: number, answer: string) => void;
  /** Callback fired when "Skip to spec" is activated */
  onSkipToSpec?: () => void;
  /** Callback fired when "Build with defaults" is activated */
  onBuildWithDefaults?: () => void;
}

export type ComplexTurnStatus = 'idle' | 'answered' | 'skipped' | 'defaults_triggered';

// ─── IPC Channel Constants ──────────────────────────────────────

export const COMPLEX_IPC_CHANNELS = {
  /** Main → Renderer: current interview turn */
  TURN: 'interview:turn',
  /** Renderer → Main: submit answer */
  ANSWER: 'interview:answer',
  /** Renderer → Main: action (skip/defaults/cancel) */
  ACTION: 'interview:action',
} as const;

// ─── ComplexInterviewTurnCard Component ─────────────────────────

/**
 * Renders a single interview turn for complex-depth interviews.
 *
 * Requirement 7.1: one-question-per-turn interview
 * Requirement 7.3: each question includes recommended answer (single-tap accept)
 * Requirement 7.4: "Skip to spec" button on every turn
 * Requirement 8.1: "Build with defaults" button at every depth tier
 * Requirement 8.2: Not displayed when no unresolved questions remain
 */
export class ComplexInterviewTurnCard {
  private container: HTMLElement;
  private options: ComplexInterviewTurnCardOptions;
  private status: ComplexTurnStatus = 'idle';
  private cardEl: HTMLElement | null = null;
  private answerInput: HTMLTextAreaElement | null = null;
  private buildWithDefaultsBtn: BuildWithDefaultsButton | null = null;
  private turnListener: ((...args: unknown[]) => void) | null = null;

  constructor(container: HTMLElement, options: ComplexInterviewTurnCardOptions) {
    this.container = container;
    this.options = options;
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Render the turn card.
   */
  render(): void {
    this.container.innerHTML = '';
    this.status = 'idle';
    this.cardEl = this.buildCard();
    this.container.appendChild(this.cardEl);
  }

  /**
   * Get the current component status.
   */
  getStatus(): ComplexTurnStatus {
    return this.status;
  }

  /**
   * Get the current answer text from the input.
   */
  getCurrentAnswer(): string {
    return this.answerInput?.value ?? this.options.currentTurn.recommendation;
  }

  /**
   * Submit the current answer (programmatic).
   */
  submitAnswer(answer?: string): void {
    const finalAnswer = answer ?? this.getCurrentAnswer();
    this.handleSubmitAnswer(finalAnswer);
  }

  /**
   * Accept the recommended answer (programmatic).
   */
  acceptRecommendation(): void {
    this.handleSubmitAnswer(this.options.currentTurn.recommendation);
  }

  /**
   * Trigger "Skip to spec" (programmatic).
   */
  skipToSpec(): void {
    this.handleSkipToSpec();
  }

  /**
   * Trigger "Build with defaults" (programmatic).
   */
  buildWithDefaults(): void {
    if (this.buildWithDefaultsBtn) {
      this.buildWithDefaultsBtn.trigger();
    } else {
      // Fallback: send IPC directly if button is not rendered
      this.handleBuildWithDefaultsDirect();
    }
  }

  /**
   * Update the displayed turn (e.g., after advancing to next question).
   */
  updateTurn(options: Partial<ComplexInterviewTurnCardOptions>): void {
    Object.assign(this.options, options);
    this.render();
  }

  /**
   * Set up IPC listener for receiving turn data from main process.
   */
  setupIPCListener(): void {
    this.turnListener = (...args: unknown[]) => {
      const data = args[0] as {
        interviewId: string;
        turn: InterviewTurn;
        allTurns: InterviewTurn[];
        currentIndex: number;
        totalQuestions: number;
      };
      if (data && data.interviewId === this.options.interviewId) {
        this.options.currentTurn = data.turn;
        this.options.allTurns = data.allTurns;
        this.options.currentIndex = data.currentIndex;
        this.options.totalQuestions = data.totalQuestions;
        this.render();
      }
    };
    eapi().on(COMPLEX_IPC_CHANNELS.TURN, this.turnListener);
  }

  /**
   * Clean up IPC listeners and DOM.
   */
  destroy(): void {
    if (this.turnListener) {
      eapi().removeListener(COMPLEX_IPC_CHANNELS.TURN, this.turnListener);
      this.turnListener = null;
    }
    if (this.buildWithDefaultsBtn) {
      this.buildWithDefaultsBtn.dispose();
      this.buildWithDefaultsBtn = null;
    }
    this.container.innerHTML = '';
    this.cardEl = null;
    this.answerInput = null;
  }

  // ─── Private Rendering ────────────────────────────────────────

  private buildCard(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'complex-interview-turn-card';
    card.setAttribute('role', 'form');
    card.setAttribute('aria-label', `Interview question ${this.options.currentIndex + 1} of ${this.options.totalQuestions}`);
    Object.assign(card.style, {
      background: 'var(--bg-elevated, #1e1e1e)',
      border: '1px solid var(--border-color, #333)',
      borderRadius: '12px',
      padding: '16px',
      maxWidth: '520px',
      width: '100%',
      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.2)',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      animation: 'fadeIn 0.2s ease',
    });

    // Progress indicator
    card.appendChild(this.buildProgressBar());

    // Question text
    card.appendChild(this.buildQuestionSection());

    // Answer input
    card.appendChild(this.buildAnswerSection());

    // Action buttons
    card.appendChild(this.buildActionBar());

    return card;
  }

  private buildProgressBar(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'complex-interview-turn-card__progress';
    Object.assign(wrapper.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      fontSize: '11px',
      color: 'var(--text-dim, #888)',
    });

    const label = document.createElement('span');
    label.textContent = `Question ${this.options.currentIndex + 1} of ${this.options.totalQuestions}`;
    wrapper.appendChild(label);

    // Visual progress dots
    const dots = document.createElement('div');
    dots.style.display = 'flex';
    dots.style.gap = '4px';
    for (let i = 0; i < this.options.totalQuestions; i++) {
      const dot = document.createElement('span');
      dot.setAttribute('aria-hidden', 'true');
      Object.assign(dot.style, {
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: i < this.options.currentIndex
          ? 'var(--accent-color, #0078d4)'
          : i === this.options.currentIndex
            ? 'var(--text-primary, #e0e0e0)'
            : 'var(--border-color, #444)',
      });
      dots.appendChild(dot);
    }
    wrapper.appendChild(dots);

    return wrapper;
  }

  private buildQuestionSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'complex-interview-turn-card__question';

    const questionLabel = document.createElement('label');
    questionLabel.htmlFor = `complex-interview-answer-${this.options.currentTurn.questionIndex}`;
    questionLabel.textContent = this.options.currentTurn.question;
    Object.assign(questionLabel.style, {
      display: 'block',
      fontSize: '13px',
      fontWeight: '600',
      color: 'var(--text-primary, #e0e0e0)',
      lineHeight: '1.5',
      marginBottom: '4px',
    });
    section.appendChild(questionLabel);

    // Recommendation hint
    const hint = document.createElement('div');
    hint.className = 'complex-interview-turn-card__recommendation';
    hint.textContent = `💡 Recommended: ${this.options.currentTurn.recommendation}`;
    Object.assign(hint.style, {
      fontSize: '11px',
      color: 'var(--text-dim, #888)',
      fontStyle: 'italic',
      padding: '6px 8px',
      background: 'var(--bg-subtle, #262626)',
      borderRadius: '4px',
      lineHeight: '1.4',
    });
    section.appendChild(hint);

    return section;
  }

  private buildAnswerSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'complex-interview-turn-card__answer-section';

    this.answerInput = document.createElement('textarea');
    this.answerInput.id = `complex-interview-answer-${this.options.currentTurn.questionIndex}`;
    this.answerInput.className = 'complex-interview-turn-card__input';
    this.answerInput.value = this.options.currentTurn.recommendation;
    this.answerInput.rows = 3;
    this.answerInput.placeholder = 'Type your answer or accept the recommendation...';
    this.answerInput.setAttribute('aria-label', `Your answer for: ${this.options.currentTurn.question}`);
    Object.assign(this.answerInput.style, {
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 10px',
      borderRadius: '6px',
      border: '1px solid var(--border-color, #444)',
      backgroundColor: 'var(--input-bg, #2d2d2d)',
      color: 'var(--text-primary, #e0e0e0)',
      fontSize: '13px',
      fontFamily: 'inherit',
      lineHeight: '1.4',
      resize: 'vertical',
      minHeight: '50px',
      outline: 'none',
      transition: 'border-color 0.15s',
    });

    this.answerInput.addEventListener('focus', () => {
      if (this.answerInput) {
        this.answerInput.style.borderColor = 'var(--focus-border, #0078d4)';
      }
    });
    this.answerInput.addEventListener('blur', () => {
      if (this.answerInput) {
        this.answerInput.style.borderColor = 'var(--border-color, #444)';
      }
    });

    section.appendChild(this.answerInput);
    return section;
  }

  private buildActionBar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'complex-interview-turn-card__actions';
    Object.assign(bar.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      flexWrap: 'wrap',
      marginTop: '4px',
      paddingTop: '8px',
      borderTop: '1px solid var(--border-color, #333)',
    });

    // "Accept & Next" button (primary) — accepts recommendation
    const acceptBtn = createButton({
      label: 'Accept & next',
      icon: '✓',
      variant: 'primary',
      size: 'medium',
      ariaLabel: 'Accept recommended answer and continue to next question',
      className: 'complex-interview-turn-card__accept-btn',
      onClick: () => this.acceptRecommendation(),
    });
    acceptBtn.setAttribute('data-action', 'accept');
    bar.appendChild(acceptBtn);

    // "Submit answer" button (secondary) — submits custom answer
    const submitBtn = createButton({
      label: 'Submit',
      icon: '→',
      variant: 'secondary',
      size: 'medium',
      ariaLabel: 'Submit your custom answer and continue',
      className: 'complex-interview-turn-card__submit-btn',
      onClick: () => this.handleSubmitAnswer(this.getCurrentAnswer()),
    });
    submitBtn.setAttribute('data-action', 'submit');
    bar.appendChild(submitBtn);

    // Spacer
    const spacer = document.createElement('div');
    spacer.style.flex = '1';
    bar.appendChild(spacer);

    // "Skip to spec" button (ghost) — exits interview with gathered info
    // Requirement 7.4: "Skip to spec" button on every interview turn
    const skipBtn = createButton({
      label: 'Skip to spec',
      icon: '⏩',
      variant: 'ghost',
      size: 'medium',
      ariaLabel: 'Skip remaining questions and generate spec with answers so far',
      className: 'complex-interview-turn-card__skip-btn',
      onClick: () => this.handleSkipToSpec(),
    });
    skipBtn.setAttribute('data-action', 'skip');
    bar.appendChild(skipBtn);

    // "Build with defaults" button — escape hatch
    // Requirement 8.1: Display at every depth tier
    // Requirement 8.2: Not displayed when no unresolved questions remain
    const defaultsContainer = document.createElement('span');
    defaultsContainer.className = 'complex-interview-turn-card__defaults-container';

    if (shouldShowBuildWithDefaults(this.options.allTurns)) {
      this.buildWithDefaultsBtn = new BuildWithDefaultsButton({
        interviewId: this.options.interviewId,
        turns: this.options.allTurns,
        onDefaults: () => this.handleBuildWithDefaults(),
      });
      this.buildWithDefaultsBtn.render(defaultsContainer);
    }

    bar.appendChild(defaultsContainer);

    return bar;
  }

  // ─── Action Handlers ──────────────────────────────────────────

  private handleSubmitAnswer(answer: string): void {
    if (this.status !== 'idle') return;

    this.status = 'answered';

    eapi().send(COMPLEX_IPC_CHANNELS.ANSWER, {
      interviewId: this.options.interviewId,
      questionIndex: this.options.currentTurn.questionIndex,
      answer,
    });

    this.disableActions();
    this.options.onAnswerSubmitted?.(this.options.currentTurn.questionIndex, answer);
  }

  private handleSkipToSpec(): void {
    if (this.status !== 'idle') return;

    this.status = 'skipped';

    eapi().send(COMPLEX_IPC_CHANNELS.ACTION, {
      interviewId: this.options.interviewId,
      action: 'skip',
    });

    this.disableActions();
    this.options.onSkipToSpec?.();
  }

  private handleBuildWithDefaults(): void {
    if (this.status !== 'idle') return;

    this.status = 'defaults_triggered';

    // The BuildWithDefaultsButton already sends the IPC message,
    // so we just disable the rest and fire the callback
    this.disableActions();
    this.options.onBuildWithDefaults?.();
  }

  /**
   * Direct IPC send for "Build with defaults" — used as fallback when the
   * BuildWithDefaultsButton component is not rendered (e.g., all questions answered).
   */
  private handleBuildWithDefaultsDirect(): void {
    if (this.status !== 'idle') return;

    this.status = 'defaults_triggered';

    eapi().send(COMPLEX_IPC_CHANNELS.ACTION, {
      interviewId: this.options.interviewId,
      action: 'defaults',
    });

    this.disableActions();
    this.options.onBuildWithDefaults?.();
  }

  private disableActions(): void {
    if (!this.cardEl) return;

    const buttons = this.cardEl.querySelectorAll('button');
    buttons.forEach(btn => {
      setButtonDisabled(btn as HTMLButtonElement, true);
    });

    if (this.answerInput) {
      this.answerInput.disabled = true;
      this.answerInput.style.opacity = '0.6';
    }
  }
}

// ─── Factory Function ───────────────────────────────────────────

/**
 * Create and render a ComplexInterviewTurnCard.
 *
 * Call this when the main process sends a complex interview turn via
 * `interview:turn` IPC channel.
 */
export function createComplexInterviewTurnCard(
  container: HTMLElement,
  options: ComplexInterviewTurnCardOptions,
): ComplexInterviewTurnCard {
  const card = new ComplexInterviewTurnCard(container, options);
  card.render();
  return card;
}
