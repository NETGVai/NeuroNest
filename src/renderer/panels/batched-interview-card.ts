/**
 * BatchedInterviewCard — Renderer component for medium-depth spec interviews.
 *
 * Displays a single card with 3-4 clarifying questions, each pre-filled with
 * a recommended answer. The user can modify any answers then submit, or
 * tap "Build" to proceed with defaults.
 *
 * IPC channels:
 *   - `interview:batched-card` (Main → Renderer): Delivers batched InterviewTurn[]
 *   - `interview:answer` (Renderer → Main): Submits individual answer
 *   - `interview:action` (Renderer → Main): 'defaults' | 'cancel'
 *
 * Behaviour:
 *   - "Build" button sends `interview:action { interviewId, action: 'defaults' }` and
 *     proceeds with recommended answers (one interaction).
 *   - Modifying answers + clicking "Submit" sends each modified answer via
 *     `interview:answer` then triggers spec synthesis (≤2 interactions).
 *   - Dismissing/abandoning the card (e.g. clicking cancel or navigating away)
 *     sends `interview:action { interviewId, action: 'cancel' }` — modifications
 *     are NOT incorporated.
 *
 * Feature-gated via `spec_interview_engine`.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */

import type { InterviewTurn } from '../../pipeline/spec-interview-engine.js';
import { createButton } from '../components/button.js';
import { shouldShowBuildWithDefaults } from '../components/build-with-defaults-button.js';

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

export interface BatchedInterviewCardOptions {
  /** Unique interview identifier */
  interviewId: string;
  /** Array of 3-4 interview turns with questions and recommendations */
  turns: InterviewTurn[];
  /** Original user message (shown as context header) */
  originalMessage: string;
  /** Callback fired after submission or build-with-defaults completes */
  onComplete?: () => void;
  /** Callback fired when the card is dismissed/cancelled */
  onDismiss?: () => void;
}

export type BatchedCardStatus = 'idle' | 'modified' | 'submitting' | 'submitted' | 'dismissed';

export interface BatchedCardState {
  status: BatchedCardStatus;
  /** Current answer values keyed by questionIndex */
  answers: Map<number, string>;
  /** Track which answers have been modified from recommendations */
  modified: Set<number>;
}

// ─── IPC Channel Constants ──────────────────────────────────────

export const INTERVIEW_IPC_CHANNELS = {
  /** Main → Renderer: batched interview card data */
  BATCHED_CARD: 'interview:batched-card',
  /** Renderer → Main: submit individual answer */
  ANSWER: 'interview:answer',
  /** Renderer → Main: action (defaults/cancel) */
  ACTION: 'interview:action',
} as const;

// ─── Pure Logic Functions (exported for testing) ────────────────

/**
 * Determines whether any answers have been modified from their recommendations.
 */
export function hasModifications(turns: InterviewTurn[], answers: Map<number, string>): boolean {
  for (const turn of turns) {
    const current = answers.get(turn.questionIndex);
    if (current !== undefined && current !== turn.recommendation) {
      return true;
    }
  }
  return false;
}

/**
 * Returns the list of modified question indices.
 */
export function getModifiedIndices(turns: InterviewTurn[], answers: Map<number, string>): number[] {
  const indices: number[] = [];
  for (const turn of turns) {
    const current = answers.get(turn.questionIndex);
    if (current !== undefined && current !== turn.recommendation) {
      indices.push(turn.questionIndex);
    }
  }
  return indices;
}

/**
 * Validates that the batched card data is well-formed for medium depth.
 * Medium interviews must have 3-4 questions.
 *
 * Requirement 6.1: 3 to 4 clarifying questions
 */
export function validateBatchedCard(turns: InterviewTurn[]): {
  valid: boolean;
  reason?: string;
} {
  if (!turns || turns.length < 3) {
    return { valid: false, reason: `Expected 3-4 questions, got ${turns?.length ?? 0}` };
  }
  if (turns.length > 4) {
    return { valid: false, reason: `Expected 3-4 questions, got ${turns.length} (should escalate to complex)` };
  }
  // Every turn must have a non-empty recommendation
  for (const turn of turns) {
    if (!turn.recommendation || turn.recommendation.trim() === '') {
      return { valid: false, reason: `Question ${turn.questionIndex} has no recommendation` };
    }
    if (!turn.question || turn.question.trim() === '') {
      return { valid: false, reason: `Question ${turn.questionIndex} has no question text` };
    }
  }
  return { valid: true };
}

// ─── BatchedInterviewCard Component ─────────────────────────────

/**
 * Batched interview card for medium-complexity build tasks.
 *
 * Renders all 3-4 questions at once with pre-selected recommended answers.
 * Provides "Build" (proceed with defaults) and "Submit" (with modifications).
 *
 * Requirement 6.2: one-tap "Build" button proceeds with defaults
 * Requirement 6.3: modifications incorporated on submit; dismissed = not incorporated
 * Requirement 6.4: user reaches "Start build" within ≤2 interactions
 */
export class BatchedInterviewCard {
  private container: HTMLElement;
  private options: BatchedInterviewCardOptions;
  private state: BatchedCardState;
  private cardEl: HTMLElement | null = null;
  private batchedCardListener: ((...args: unknown[]) => void) | null = null;

  constructor(container: HTMLElement, options: BatchedInterviewCardOptions) {
    this.container = container;
    this.options = options;
    this.state = {
      status: 'idle',
      answers: new Map(),
      modified: new Set(),
    };

    // Initialize answers with recommendations
    for (const turn of options.turns) {
      this.state.answers.set(turn.questionIndex, turn.recommendation);
    }
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Render the card into the container.
   */
  render(): void {
    this.container.innerHTML = '';
    this.cardEl = this.buildCard();
    this.container.appendChild(this.cardEl);
  }

  /**
   * Get the current component state (for testing).
   */
  getState(): BatchedCardState {
    return {
      status: this.state.status,
      answers: new Map(this.state.answers),
      modified: new Set(this.state.modified),
    };
  }

  /**
   * Get the current answer for a given question index.
   */
  getAnswer(questionIndex: number): string | undefined {
    return this.state.answers.get(questionIndex);
  }

  /**
   * Programmatically set an answer (for testing or external updates).
   */
  setAnswer(questionIndex: number, answer: string): void {
    const turn = this.options.turns.find(t => t.questionIndex === questionIndex);
    if (!turn) return;

    this.state.answers.set(questionIndex, answer);

    if (answer !== turn.recommendation) {
      this.state.modified.add(questionIndex);
      this.state.status = 'modified';
    } else {
      this.state.modified.delete(questionIndex);
      if (this.state.modified.size === 0) {
        this.state.status = 'idle';
      }
    }

    this.updateButtonStates();
  }

  /**
   * Submit all answers (modified or not) to the main process.
   * Sends individual `interview:answer` messages for each modified answer,
   * then triggers spec synthesis.
   *
   * Requirement 6.3: modifications incorporated on submit
   */
  submit(): void {
    if (this.state.status === 'submitting' || this.state.status === 'submitted') return;

    this.state.status = 'submitting';
    this.updateButtonStates();

    const api = eapi();
    const { interviewId, turns } = this.options;

    // Send all answers (including unmodified ones — the engine uses them for synthesis)
    for (const turn of turns) {
      const answer = this.state.answers.get(turn.questionIndex) ?? turn.recommendation;
      api.send(INTERVIEW_IPC_CHANNELS.ANSWER, {
        interviewId,
        questionIndex: turn.questionIndex,
        answer,
      });
    }

    this.state.status = 'submitted';
    this.updateButtonStates();
    this.options.onComplete?.();
  }

  /**
   * Proceed with recommended defaults (the "Build" button action).
   * Sends `interview:action { interviewId, action: 'defaults' }` to main process.
   *
   * Requirement 6.2: one-tap "Build" button proceeds with defaults
   * Requirement 6.4: single interaction to start build
   */
  buildWithDefaults(): void {
    if (this.state.status === 'submitting' || this.state.status === 'submitted') return;

    this.state.status = 'submitting';
    this.updateButtonStates();

    eapi().send(INTERVIEW_IPC_CHANNELS.ACTION, {
      interviewId: this.options.interviewId,
      action: 'defaults',
    });

    this.state.status = 'submitted';
    this.updateButtonStates();
    this.options.onComplete?.();
  }

  /**
   * Dismiss/cancel the card. Modifications are NOT sent.
   *
   * Requirement 6.3: abandoned/dismissed modifications NOT incorporated
   */
  dismiss(): void {
    if (this.state.status === 'submitted') return;

    this.state.status = 'dismissed';

    eapi().send(INTERVIEW_IPC_CHANNELS.ACTION, {
      interviewId: this.options.interviewId,
      action: 'cancel',
    });

    this.container.innerHTML = '';
    this.options.onDismiss?.();
  }

  /**
   * Set up IPC listener for receiving batched card data from main process.
   */
  setupIPCListener(): void {
    this.batchedCardListener = (...args: unknown[]) => {
      const data = args[0] as {
        interviewId: string;
        turns: InterviewTurn[];
        originalMessage: string;
      };
      if (data && data.interviewId === this.options.interviewId) {
        this.options.turns = data.turns;
        this.options.originalMessage = data.originalMessage;
        // Reset answers to new recommendations
        this.state.answers.clear();
        this.state.modified.clear();
        this.state.status = 'idle';
        for (const turn of data.turns) {
          this.state.answers.set(turn.questionIndex, turn.recommendation);
        }
        this.render();
      }
    };
    eapi().on(INTERVIEW_IPC_CHANNELS.BATCHED_CARD, this.batchedCardListener);
  }

  /**
   * Clean up IPC listeners and DOM.
   */
  destroy(): void {
    if (this.batchedCardListener) {
      eapi().removeListener(INTERVIEW_IPC_CHANNELS.BATCHED_CARD, this.batchedCardListener);
      this.batchedCardListener = null;
    }
    this.container.innerHTML = '';
  }

  // ─── Private Rendering ────────────────────────────────────────

  private buildCard(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'batched-interview-card';
    card.setAttribute('role', 'form');
    card.setAttribute('aria-label', 'Spec interview — clarifying questions');
    Object.assign(card.style, {
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

    // Header
    card.appendChild(this.buildHeader());

    // Questions
    for (const turn of this.options.turns) {
      card.appendChild(this.buildQuestionField(turn));
    }

    // Action buttons
    card.appendChild(this.buildActionBar());

    return card;
  }

  private buildHeader(): HTMLElement {
    const header = document.createElement('div');
    header.className = 'batched-interview-card__header';
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: '4px',
    });

    const title = document.createElement('h3');
    title.className = 'batched-interview-card__title';
    title.textContent = '🔨 Quick spec questions';
    Object.assign(title.style, {
      margin: '0',
      fontSize: '14px',
      fontWeight: '600',
      color: 'var(--text-primary, #e0e0e0)',
    });
    header.appendChild(title);

    // Dismiss button (X)
    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'batched-interview-card__dismiss';
    dismissBtn.setAttribute('aria-label', 'Dismiss interview card');
    dismissBtn.textContent = '✕';
    Object.assign(dismissBtn.style, {
      background: 'transparent',
      border: 'none',
      color: 'var(--text-dim, #888)',
      fontSize: '14px',
      cursor: 'pointer',
      padding: '2px 6px',
      borderRadius: '4px',
      transition: 'color 0.15s',
    });
    dismissBtn.addEventListener('mouseenter', () => {
      dismissBtn.style.color = 'var(--text-primary, #e0e0e0)';
    });
    dismissBtn.addEventListener('mouseleave', () => {
      dismissBtn.style.color = 'var(--text-dim, #888)';
    });
    dismissBtn.addEventListener('click', () => this.dismiss());
    header.appendChild(dismissBtn);

    return header;
  }

  private buildQuestionField(turn: InterviewTurn): HTMLElement {
    const field = document.createElement('div');
    field.className = 'batched-interview-card__field';
    field.setAttribute('data-question-index', String(turn.questionIndex));
    Object.assign(field.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
    });

    // Question label
    const label = document.createElement('label');
    label.className = 'batched-interview-card__label';
    label.htmlFor = `interview-q-${turn.questionIndex}`;
    label.textContent = turn.question;
    Object.assign(label.style, {
      fontSize: '12px',
      fontWeight: '500',
      color: 'var(--text-primary, #e0e0e0)',
      lineHeight: '1.4',
    });
    field.appendChild(label);

    // Answer input (textarea for longer answers)
    const textarea = document.createElement('textarea');
    textarea.id = `interview-q-${turn.questionIndex}`;
    textarea.className = 'batched-interview-card__input';
    textarea.value = this.state.answers.get(turn.questionIndex) ?? turn.recommendation;
    textarea.rows = 2;
    textarea.setAttribute('data-question-index', String(turn.questionIndex));
    textarea.setAttribute('aria-label', `Answer for: ${turn.question}`);
    Object.assign(textarea.style, {
      padding: '8px 10px',
      borderRadius: '6px',
      border: '1px solid var(--border-color, #444)',
      backgroundColor: 'var(--input-bg, #2d2d2d)',
      color: 'var(--text-primary, #e0e0e0)',
      fontSize: '13px',
      fontFamily: 'inherit',
      outline: 'none',
      width: '100%',
      boxSizing: 'border-box',
      resize: 'vertical',
      minHeight: '40px',
      transition: 'border-color 0.15s',
      lineHeight: '1.4',
    });

    // Focus styling
    textarea.addEventListener('focus', () => {
      textarea.style.borderColor = 'var(--focus-border, #0078d4)';
    });
    textarea.addEventListener('blur', () => {
      textarea.style.borderColor = 'var(--border-color, #444)';
    });

    // Track modifications
    textarea.addEventListener('input', () => {
      const value = textarea.value;
      this.state.answers.set(turn.questionIndex, value);

      if (value !== turn.recommendation) {
        this.state.modified.add(turn.questionIndex);
      } else {
        this.state.modified.delete(turn.questionIndex);
      }

      // Update status
      this.state.status = this.state.modified.size > 0 ? 'modified' : 'idle';
      this.updateButtonStates();
    });

    field.appendChild(textarea);

    // Recommendation hint
    const hint = document.createElement('span');
    hint.className = 'batched-interview-card__hint';
    hint.textContent = `Recommended: ${turn.recommendation}`;
    Object.assign(hint.style, {
      fontSize: '11px',
      color: 'var(--text-dim, #888)',
      fontStyle: 'italic',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    });
    field.appendChild(hint);

    return field;
  }

  private buildActionBar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'batched-interview-card__actions';
    Object.assign(bar.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: '8px',
      marginTop: '4px',
      paddingTop: '8px',
      borderTop: '1px solid var(--border-color, #333)',
    });

    // "Build with defaults" button — proceed with defaults (primary, prominent)
    // Requirement 8.1: Display "Build with defaults" at every depth tier
    // Requirement 8.2: Not displayed when no unresolved questions remain
    const buildBtn = createButton({
      label: 'Build with defaults',
      icon: '🚀',
      variant: 'primary',
      size: 'medium',
      ariaLabel: 'Build with defaults — use recommended answers for all questions',
      className: 'batched-interview-card__build-btn',
      onClick: () => this.buildWithDefaults(),
    });
    buildBtn.setAttribute('data-action', 'build');
    // Hide if no unresolved questions remain
    if (!shouldShowBuildWithDefaults(this.options.turns)) {
      buildBtn.style.display = 'none';
    }
    bar.appendChild(buildBtn);

    // "Submit changes" button — shown when modifications exist
    const submitBtn = createButton({
      label: 'Submit changes',
      icon: '✓',
      variant: 'secondary',
      size: 'medium',
      ariaLabel: 'Submit modified answers',
      className: 'batched-interview-card__submit-btn',
      onClick: () => this.submit(),
    });
    submitBtn.setAttribute('data-action', 'submit');
    // Initially hidden — shown only when answers are modified
    submitBtn.style.display = this.state.modified.size > 0 ? 'inline-flex' : 'none';
    bar.appendChild(submitBtn);

    return bar;
  }

  /**
   * Update button visibility/disabled states based on current card state.
   * Requirement 8.2: "Build with defaults" not displayed when no unresolved questions remain.
   */
  private updateButtonStates(): void {
    if (!this.cardEl) return;

    const buildBtn = this.cardEl.querySelector('[data-action="build"]') as HTMLButtonElement | null;
    const submitBtn = this.cardEl.querySelector('[data-action="submit"]') as HTMLButtonElement | null;

    const isTerminal = this.state.status === 'submitting' || this.state.status === 'submitted' || this.state.status === 'dismissed';

    if (buildBtn) {
      buildBtn.disabled = isTerminal;
      buildBtn.style.opacity = isTerminal ? '0.5' : '1';
      buildBtn.style.cursor = isTerminal ? 'not-allowed' : 'pointer';
      // Requirement 8.2: Hide when all questions are answered (no unresolved remain)
      const hasUnresolved = shouldShowBuildWithDefaults(this.options.turns);
      buildBtn.style.display = hasUnresolved && !isTerminal ? 'inline-flex' : isTerminal ? 'inline-flex' : 'none';
    }

    if (submitBtn) {
      const hasChanges = this.state.modified.size > 0;
      submitBtn.style.display = hasChanges && !isTerminal ? 'inline-flex' : 'none';
      submitBtn.disabled = isTerminal;
    }
  }
}

// ─── Factory Function ───────────────────────────────────────────

/**
 * Create and render a BatchedInterviewCard.
 *
 * Call this when the main process sends a medium-depth interview via
 * `interview:batched-card` IPC.
 *
 * Requirement 6.4: User reaches "Start build" within ≤2 interactions.
 * - Interaction 1: Card appears with pre-filled recommendations.
 *   - Tap "Build" → immediate handoff (1 interaction total)
 *   - Modify + tap "Submit changes" → synthesis begins (1 interaction for modifications + 1 for submit = ≤2)
 */
export function createBatchedInterviewCard(
  container: HTMLElement,
  options: BatchedInterviewCardOptions,
): BatchedInterviewCard {
  const card = new BatchedInterviewCard(container, options);
  card.render();
  return card;
}
