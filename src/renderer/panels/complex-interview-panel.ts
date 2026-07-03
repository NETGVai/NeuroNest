/**
 * ComplexInterviewPanel — Renderer component for complex-depth spec interviews.
 *
 * Displays one question at a time (Grill-Me style) with a maximum of 7 questions.
 * Each question includes a recommended answer that the user can accept with a
 * single tap or override with a custom answer.
 *
 * IPC channels:
 *   - `interview:turn` (Main → Renderer): Delivers current InterviewTurn
 *   - `interview:answer` (Renderer → Main): Submits { interviewId, questionIndex, answer }
 *   - `interview:action` (Renderer → Main): 'skip' | 'defaults' | 'cancel'
 *
 * Behaviour:
 *   - One question displayed per turn.
 *   - "Accept" button sends the recommendation as the answer (single-tap).
 *   - Custom answer input + "Submit" sends the user's text.
 *   - "Skip to spec" button on every turn sends
 *     `interview:action { interviewId, action: 'skip' }`, synthesizing the spec
 *     from answers so far + recommendations for unanswered.
 *   - After the last question is answered (or skip), transitions to spec synthesis.
 *
 * Feature-gated via `spec_interview_engine`.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4
 */

import type { InterviewTurn } from '../../pipeline/spec-interview-engine.js';
import { createButton } from '../components/button.js';

// ─── Electron API accessor ──────────────────────────────────────

function eapi(): {
  send(channel: string, ...args: unknown[]): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (...args: unknown[]) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
} {
  return (window as any).electronAPI;
}

// ─── Types ──────────────────────────────────────────────────────

export interface ComplexInterviewPanelOptions {
  /** Unique interview identifier */
  interviewId: string;
  /** Maximum number of questions (capped at 7) */
  maxQuestions: number;
  /** Original user message (shown as context header) */
  originalMessage: string;
  /** Callback fired after all questions are answered */
  onComplete?: () => void;
  /** Callback fired when the user skips to spec */
  onSkip?: () => void;
  /** Callback fired when the interview is cancelled */
  onCancel?: () => void;
}

export type ComplexPanelStatus =
  | 'waiting'       // waiting for next turn from main process
  | 'active'        // currently showing a question
  | 'answered'      // current turn answered, waiting for next
  | 'completed'     // all questions answered
  | 'skipped'       // user skipped to spec
  | 'cancelled';    // interview cancelled

export interface ComplexPanelState {
  status: ComplexPanelStatus;
  /** Index of the currently displayed question */
  currentQuestionIndex: number;
  /** All turns received so far */
  answeredTurns: InterviewTurn[];
  /** The current turn being displayed (null when waiting) */
  currentTurn: InterviewTurn | null;
  /** Total questions answered */
  questionsAnswered: number;
}

// ─── IPC Channel Constants ──────────────────────────────────────

export const COMPLEX_INTERVIEW_IPC = {
  /** Main → Renderer: current interview turn */
  TURN: 'interview:turn',
  /** Renderer → Main: submit individual answer */
  ANSWER: 'interview:answer',
  /** Renderer → Main: action (skip/defaults/cancel) */
  ACTION: 'interview:action',
} as const;

// ─── Constants ──────────────────────────────────────────────────

/** Hard cap on complex interview questions. Requirement 7.2 */
export const MAX_COMPLEX_QUESTIONS = 7;

// ─── Pure Logic Functions (exported for testing) ────────────────

/**
 * Validates a complex interview turn is well-formed.
 *
 * Requirement 7.3: Each question SHALL include a recommended answer.
 */
export function validateInterviewTurn(turn: InterviewTurn | null | undefined): {
  valid: boolean;
  reason?: string;
} {
  if (!turn) {
    return { valid: false, reason: 'Turn is null or undefined' };
  }
  if (!turn.question || turn.question.trim() === '') {
    return { valid: false, reason: `Question ${turn.questionIndex} has no question text` };
  }
  if (!turn.recommendation || turn.recommendation.trim() === '') {
    return { valid: false, reason: `Question ${turn.questionIndex} has no recommendation` };
  }
  if (turn.questionIndex < 0 || turn.questionIndex >= MAX_COMPLEX_QUESTIONS) {
    return { valid: false, reason: `Question index ${turn.questionIndex} out of range [0, ${MAX_COMPLEX_QUESTIONS - 1}]` };
  }
  return { valid: true };
}

/**
 * Determines if the interview should be considered complete.
 *
 * Requirement 7.2: capped at 7 questions max.
 */
export function isInterviewComplete(
  questionsAnswered: number,
  maxQuestions: number,
): boolean {
  return questionsAnswered >= Math.min(maxQuestions, MAX_COMPLEX_QUESTIONS);
}

/**
 * Computes the progress fraction (0–1) for display.
 */
export function computeProgress(
  questionsAnswered: number,
  maxQuestions: number,
): number {
  const cap = Math.min(maxQuestions, MAX_COMPLEX_QUESTIONS);
  if (cap === 0) return 1;
  return Math.min(questionsAnswered / cap, 1);
}

// ─── ComplexInterviewPanel Component ────────────────────────────

/**
 * Complex interview panel for complex-depth build tasks.
 *
 * Renders one question at a time, advancing on answer. Provides "Accept"
 * for single-tap recommendation acceptance, custom input for overrides,
 * and "Skip to spec" on every turn.
 *
 * Requirement 7.1: one-question-per-turn interview (Grill-Me style)
 * Requirement 7.2: capped at 7 questions max
 * Requirement 7.3: each question includes recommended answer (single-tap accept)
 * Requirement 7.4: "Skip to spec" button on every interview turn
 */
export class ComplexInterviewPanel {
  private container: HTMLElement;
  private options: ComplexInterviewPanelOptions;
  private state: ComplexPanelState;
  private panelEl: HTMLElement | null = null;
  private turnListener: ((...args: unknown[]) => void) | null = null;

  constructor(container: HTMLElement, options: ComplexInterviewPanelOptions) {
    this.container = container;
    this.options = {
      ...options,
      maxQuestions: Math.min(options.maxQuestions, MAX_COMPLEX_QUESTIONS),
    };
    this.state = {
      status: 'waiting',
      currentQuestionIndex: -1,
      answeredTurns: [],
      currentTurn: null,
      questionsAnswered: 0,
    };
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Display a new turn (question). Called when `interview:turn` IPC arrives.
   *
   * Requirement 7.1: one question per turn.
   */
  showTurn(turn: InterviewTurn): void {
    const validation = validateInterviewTurn(turn);
    if (!validation.valid) return;

    this.state.currentTurn = turn;
    this.state.currentQuestionIndex = turn.questionIndex;
    this.state.status = 'active';
    this.render();
  }

  /**
   * Accept the recommended answer for the current turn with a single tap.
   *
   * Requirement 7.3: single-tap accept of recommendation.
   */
  acceptRecommendation(): void {
    if (!this.state.currentTurn || this.state.status !== 'active') return;

    this.submitAnswer(this.state.currentTurn.recommendation);
  }

  /**
   * Submit a custom answer for the current turn.
   */
  submitCustomAnswer(answer: string): void {
    if (!this.state.currentTurn || this.state.status !== 'active') return;
    if (!answer || answer.trim() === '') return;

    this.submitAnswer(answer.trim());
  }

  /**
   * Skip to spec — exit the interview and proceed with answers so far.
   *
   * Requirement 7.4: "Skip to spec" on every interview turn.
   */
  skipToSpec(): void {
    if (this.state.status === 'completed' || this.state.status === 'skipped' || this.state.status === 'cancelled') {
      return;
    }

    this.state.status = 'skipped';

    eapi().send(COMPLEX_INTERVIEW_IPC.ACTION, {
      interviewId: this.options.interviewId,
      action: 'skip',
    });

    this.renderCompletionState('Skipping to spec synthesis…');
    this.options.onSkip?.();
  }

  /**
   * Cancel the interview entirely.
   */
  cancel(): void {
    if (this.state.status === 'completed' || this.state.status === 'cancelled') return;

    this.state.status = 'cancelled';

    eapi().send(COMPLEX_INTERVIEW_IPC.ACTION, {
      interviewId: this.options.interviewId,
      action: 'cancel',
    });

    this.container.innerHTML = '';
    this.options.onCancel?.();
  }

  /**
   * Get the current component state (for testing).
   */
  getState(): ComplexPanelState {
    return { ...this.state, answeredTurns: [...this.state.answeredTurns] };
  }

  /**
   * Set up IPC listener for receiving turns from main process.
   */
  setupIPCListener(): void {
    this.turnListener = (...args: unknown[]) => {
      const data = args[0] as {
        interviewId: string;
        turn: InterviewTurn;
      };
      if (data && data.interviewId === this.options.interviewId && data.turn) {
        this.showTurn(data.turn);
      }
    };
    eapi().on(COMPLEX_INTERVIEW_IPC.TURN, this.turnListener);
  }

  /**
   * Clean up IPC listeners and DOM.
   */
  destroy(): void {
    if (this.turnListener) {
      eapi().removeListener(COMPLEX_INTERVIEW_IPC.TURN, this.turnListener);
      this.turnListener = null;
    }
    this.container.innerHTML = '';
  }

  // ─── Private Logic ────────────────────────────────────────────

  /**
   * Submit an answer (recommendation or custom) and advance the interview.
   */
  private submitAnswer(answer: string): void {
    const turn = this.state.currentTurn!;

    // Record the answered turn
    const answeredTurn: InterviewTurn = {
      ...turn,
      answer,
      answeredAt: Date.now(),
    };
    this.state.answeredTurns.push(answeredTurn);
    this.state.questionsAnswered++;

    // Send answer to main process
    eapi().send(COMPLEX_INTERVIEW_IPC.ANSWER, {
      interviewId: this.options.interviewId,
      questionIndex: turn.questionIndex,
      answer,
    });

    // Check if interview is complete
    if (isInterviewComplete(this.state.questionsAnswered, this.options.maxQuestions)) {
      this.state.status = 'completed';
      this.state.currentTurn = null;
      this.renderCompletionState('Interview complete — synthesizing spec…');
      this.options.onComplete?.();
    } else {
      // Advance to waiting state for next turn
      this.state.status = 'waiting';
      this.state.currentTurn = null;
      this.renderWaitingState();
    }
  }

  // ─── Private Rendering ────────────────────────────────────────

  /**
   * Render the current state of the panel.
   */
  render(): void {
    this.container.innerHTML = '';

    if (this.state.status === 'active' && this.state.currentTurn) {
      this.panelEl = this.buildQuestionPanel(this.state.currentTurn);
    } else if (this.state.status === 'waiting') {
      this.panelEl = this.buildWaitingPanel();
    } else {
      this.panelEl = this.buildCompletionPanel('');
    }

    this.container.appendChild(this.panelEl);
  }

  private buildQuestionPanel(turn: InterviewTurn): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'complex-interview-panel';
    panel.setAttribute('role', 'form');
    panel.setAttribute('aria-label', 'Spec interview — complex depth');
    Object.assign(panel.style, {
      background: 'var(--bg-elevated, #1e1e1e)',
      border: '1px solid var(--border-color, #333)',
      borderRadius: '12px',
      padding: '16px',
      maxWidth: '560px',
      width: '100%',
      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.2)',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      animation: 'fadeIn 0.2s ease',
    });

    // Header with progress
    panel.appendChild(this.buildHeader(turn));

    // Progress bar
    panel.appendChild(this.buildProgressBar());

    // Question display
    panel.appendChild(this.buildQuestionSection(turn));

    // Recommendation + Accept button
    panel.appendChild(this.buildRecommendationSection(turn));

    // Custom answer input
    panel.appendChild(this.buildCustomAnswerSection());

    // Action bar (Skip to spec)
    panel.appendChild(this.buildActionBar());

    return panel;
  }

  private buildHeader(turn: InterviewTurn): HTMLElement {
    const header = document.createElement('div');
    header.className = 'complex-interview-panel__header';
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
    });

    const titleGroup = document.createElement('div');
    titleGroup.style.display = 'flex';
    titleGroup.style.alignItems = 'center';
    titleGroup.style.gap = '8px';

    const icon = document.createElement('span');
    icon.textContent = '🔍';
    icon.setAttribute('aria-hidden', 'true');
    titleGroup.appendChild(icon);

    const title = document.createElement('h3');
    title.className = 'complex-interview-panel__title';
    title.textContent = 'Deep spec interview';
    Object.assign(title.style, {
      margin: '0',
      fontSize: '14px',
      fontWeight: '600',
      color: 'var(--text-primary, #e0e0e0)',
    });
    titleGroup.appendChild(title);
    header.appendChild(titleGroup);

    // Progress counter
    const counter = document.createElement('span');
    counter.className = 'complex-interview-panel__counter';
    counter.textContent = `${turn.questionIndex + 1} / ${this.options.maxQuestions}`;
    Object.assign(counter.style, {
      fontSize: '12px',
      color: 'var(--text-dim, #888)',
      fontWeight: '500',
    });
    counter.setAttribute('aria-label', `Question ${turn.questionIndex + 1} of ${this.options.maxQuestions}`);
    header.appendChild(counter);

    return header;
  }

  private buildProgressBar(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'complex-interview-panel__progress-wrapper';
    Object.assign(wrapper.style, {
      width: '100%',
      height: '4px',
      borderRadius: '2px',
      background: 'var(--bg-subtle, #2d2d2d)',
      overflow: 'hidden',
    });
    wrapper.setAttribute('role', 'progressbar');
    wrapper.setAttribute('aria-valuemin', '0');
    wrapper.setAttribute('aria-valuemax', String(this.options.maxQuestions));
    wrapper.setAttribute('aria-valuenow', String(this.state.questionsAnswered));

    const fill = document.createElement('div');
    fill.className = 'complex-interview-panel__progress-fill';
    const progress = computeProgress(this.state.questionsAnswered, this.options.maxQuestions);
    Object.assign(fill.style, {
      width: `${progress * 100}%`,
      height: '100%',
      borderRadius: '2px',
      background: 'var(--accent-color, #0078d4)',
      transition: 'width 0.3s ease',
    });
    wrapper.appendChild(fill);

    return wrapper;
  }

  private buildQuestionSection(turn: InterviewTurn): HTMLElement {
    const section = document.createElement('div');
    section.className = 'complex-interview-panel__question';
    Object.assign(section.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
    });

    const questionText = document.createElement('p');
    questionText.className = 'complex-interview-panel__question-text';
    questionText.textContent = turn.question;
    Object.assign(questionText.style, {
      margin: '0',
      fontSize: '13px',
      fontWeight: '500',
      color: 'var(--text-primary, #e0e0e0)',
      lineHeight: '1.5',
    });
    section.appendChild(questionText);

    return section;
  }

  private buildRecommendationSection(turn: InterviewTurn): HTMLElement {
    const section = document.createElement('div');
    section.className = 'complex-interview-panel__recommendation';
    Object.assign(section.style, {
      display: 'flex',
      alignItems: 'flex-start',
      gap: '10px',
      padding: '10px 12px',
      borderRadius: '8px',
      background: 'var(--bg-subtle, #252526)',
      border: '1px solid var(--border-color, #333)',
    });

    // Recommendation text
    const recText = document.createElement('span');
    recText.className = 'complex-interview-panel__recommendation-text';
    recText.textContent = turn.recommendation;
    Object.assign(recText.style, {
      flex: '1',
      fontSize: '12px',
      color: 'var(--text-secondary, #aaa)',
      lineHeight: '1.5',
      wordBreak: 'break-word',
    });
    section.appendChild(recText);

    // Accept button — single-tap to accept recommendation (Requirement 7.3)
    const acceptBtn = createButton({
      label: 'Accept',
      icon: '✓',
      variant: 'primary',
      size: 'small',
      ariaLabel: 'Accept recommended answer',
      className: 'complex-interview-panel__accept-btn',
      onClick: () => this.acceptRecommendation(),
    });
    acceptBtn.setAttribute('data-action', 'accept');
    section.appendChild(acceptBtn);

    return section;
  }

  private buildCustomAnswerSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'complex-interview-panel__custom-answer';
    Object.assign(section.style, {
      display: 'flex',
      gap: '8px',
      alignItems: 'flex-end',
    });

    // Custom answer textarea
    const textarea = document.createElement('textarea');
    textarea.className = 'complex-interview-panel__input';
    textarea.placeholder = 'Or type a custom answer…';
    textarea.rows = 2;
    textarea.setAttribute('aria-label', 'Custom answer');
    Object.assign(textarea.style, {
      flex: '1',
      padding: '8px 10px',
      borderRadius: '6px',
      border: '1px solid var(--border-color, #444)',
      backgroundColor: 'var(--input-bg, #2d2d2d)',
      color: 'var(--text-primary, #e0e0e0)',
      fontSize: '13px',
      fontFamily: 'inherit',
      outline: 'none',
      resize: 'vertical',
      minHeight: '40px',
      transition: 'border-color 0.15s',
      lineHeight: '1.4',
    });
    textarea.addEventListener('focus', () => {
      textarea.style.borderColor = 'var(--focus-border, #0078d4)';
    });
    textarea.addEventListener('blur', () => {
      textarea.style.borderColor = 'var(--border-color, #444)';
    });
    section.appendChild(textarea);

    // Submit custom answer button
    const submitBtn = createButton({
      label: 'Submit',
      variant: 'secondary',
      size: 'small',
      ariaLabel: 'Submit custom answer',
      className: 'complex-interview-panel__submit-btn',
      onClick: () => {
        this.submitCustomAnswer(textarea.value);
      },
    });
    submitBtn.setAttribute('data-action', 'submit-custom');
    section.appendChild(submitBtn);

    return section;
  }

  private buildActionBar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'complex-interview-panel__actions';
    Object.assign(bar.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: '8px',
      marginTop: '4px',
      paddingTop: '8px',
      borderTop: '1px solid var(--border-color, #333)',
    });

    // "Skip to spec" button — visible on every turn (Requirement 7.4)
    const skipBtn = createButton({
      label: 'Skip to spec',
      icon: '⏭',
      variant: 'ghost',
      size: 'medium',
      ariaLabel: 'Skip remaining questions and generate spec',
      className: 'complex-interview-panel__skip-btn',
      onClick: () => this.skipToSpec(),
    });
    skipBtn.setAttribute('data-action', 'skip');
    bar.appendChild(skipBtn);

    return bar;
  }

  private buildWaitingPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'complex-interview-panel complex-interview-panel--waiting';
    Object.assign(panel.style, {
      background: 'var(--bg-elevated, #1e1e1e)',
      border: '1px solid var(--border-color, #333)',
      borderRadius: '12px',
      padding: '16px',
      maxWidth: '560px',
      width: '100%',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      alignItems: 'center',
    });

    const spinner = document.createElement('span');
    spinner.textContent = '⏳';
    spinner.style.fontSize = '20px';
    spinner.setAttribute('aria-hidden', 'true');
    panel.appendChild(spinner);

    const text = document.createElement('p');
    text.textContent = 'Preparing next question…';
    Object.assign(text.style, {
      margin: '0',
      fontSize: '12px',
      color: 'var(--text-dim, #888)',
    });
    panel.appendChild(text);

    // Still show "Skip to spec" while waiting (Requirement 7.4)
    const skipBtn = createButton({
      label: 'Skip to spec',
      icon: '⏭',
      variant: 'ghost',
      size: 'medium',
      ariaLabel: 'Skip remaining questions and generate spec',
      className: 'complex-interview-panel__skip-btn',
      onClick: () => this.skipToSpec(),
    });
    skipBtn.setAttribute('data-action', 'skip');
    panel.appendChild(skipBtn);

    return panel;
  }

  private buildCompletionPanel(message: string): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'complex-interview-panel complex-interview-panel--done';
    Object.assign(panel.style, {
      background: 'var(--bg-elevated, #1e1e1e)',
      border: '1px solid var(--border-color, #333)',
      borderRadius: '12px',
      padding: '16px',
      maxWidth: '560px',
      width: '100%',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      alignItems: 'center',
    });

    const icon = document.createElement('span');
    icon.textContent = '✅';
    icon.style.fontSize = '20px';
    icon.setAttribute('aria-hidden', 'true');
    panel.appendChild(icon);

    const text = document.createElement('p');
    text.className = 'complex-interview-panel__completion-text';
    text.textContent = message;
    Object.assign(text.style, {
      margin: '0',
      fontSize: '12px',
      color: 'var(--text-dim, #888)',
    });
    panel.appendChild(text);

    return panel;
  }

  private renderWaitingState(): void {
    this.container.innerHTML = '';
    this.panelEl = this.buildWaitingPanel();
    this.container.appendChild(this.panelEl);
  }

  private renderCompletionState(message: string): void {
    this.container.innerHTML = '';
    this.panelEl = this.buildCompletionPanel(message);
    this.container.appendChild(this.panelEl);
  }
}

// ─── Factory Function ───────────────────────────────────────────

/**
 * Create and initialize a ComplexInterviewPanel.
 *
 * Call this when the main process starts a complex-depth interview.
 * The panel will listen for `interview:turn` IPC messages and display
 * questions one at a time.
 *
 * Requirement 7.1: One-question-per-turn interview (Grill-Me style).
 * Requirement 7.2: Maximum 7 questions.
 * Requirement 7.4: "Skip to spec" button on every turn.
 */
export function createComplexInterviewPanel(
  container: HTMLElement,
  options: ComplexInterviewPanelOptions,
): ComplexInterviewPanel {
  const panel = new ComplexInterviewPanel(container, options);
  panel.setupIPCListener();
  return panel;
}
