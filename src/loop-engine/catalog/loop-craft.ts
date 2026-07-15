// ─── Loop Craft: Q&A Flow for Loop Authoring ───────────────────
// Guided authoring flow that detects iteration signals and walks
// users through 4 questions to produce a validated LoopSpec draft.
// Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5

import { randomUUID } from 'node:crypto';
import { validateLoopSpec } from '../schema/loop-spec.js';
import type { LoopSpec } from '../schema/loop-spec.js';

// ─── Types ──────────────────────────────────────────────────────

export interface QAQuestion {
  field: string;
  prompt: string;
  required: boolean;
}

export interface QAFlowState {
  currentQuestion: number;
  questions: QAQuestion[];
  answers: string[];
  complete: boolean;
}

// ─── Constants ──────────────────────────────────────────────────

/**
 * Keywords and patterns that indicate the user wants iterative work.
 * Matched case-insensitively against user messages.
 */
const ITERATION_KEYWORDS: string[] = [
  'iterate',
  'iterative',
  'iteratively',
  'loop',
  'repeat',
  'repeatedly',
  'keep trying',
  'keep fixing',
  'until all',
  'until no',
  'until zero',
  'fix all',
  'fix every',
  'repair all',
  'retry',
  're-run',
  'rerun',
  'run again',
  'each time',
  'pass by pass',
  'one by one',
  'incrementally',
  'continuously',
  'keep going',
  'cycle through',
  'do this until',
  'run until',
];

/**
 * Regex patterns for detecting iteration signals in user messages.
 */
const ITERATION_PATTERNS: RegExp[] = [
  /\buntil\b.*\b(?:pass|succeed|fix|resolve|clear|clean)\b/i,
  /\bkeep\b.*\b(?:running|fixing|trying|going|iterating)\b/i,
  /\brepeat(?:edly)?\b.*\b(?:until|while)\b/i,
  /\bfor\s+each\b.*\b(?:error|issue|failure|test|file)\b/i,
  /\bloop\b.*\b(?:over|through|until)\b/i,
  /\bone\s+at\s+a\s+time\b/i,
];

/**
 * The 4 Q&A questions that map to LoopSpec fields.
 */
const CRAFT_QUESTIONS: QAQuestion[] = [
  {
    field: 'goal',
    prompt:
      'What is the goal of this loop? Describe what you want accomplished and the action to take each pass.',
    required: true,
  },
  {
    field: 'verify',
    prompt:
      'How should success be verified after each pass? Describe commands to run, files to check, or metrics to evaluate.',
    required: true,
  },
  {
    field: 'feedback',
    prompt:
      'What feedback strategy should guide the next pass when verification fails? Describe how the agent should interpret and act on failures.',
    required: true,
  },
  {
    field: 'stop',
    prompt:
      'What are the stopping conditions? Specify max passes (1-50), max cost in USD, max wall-clock time in minutes, and how many no-progress passes before stopping.',
    required: true,
  },
];

// ─── LoopCraftFlow ──────────────────────────────────────────────

export class LoopCraftFlow {
  private state: QAFlowState;

  constructor() {
    this.state = this.createInitialState();
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Detect whether a user message implies iterative work.
   * Uses keyword matching and regex pattern matching.
   * REQ-11.1: detect iteration signal in Brainstorm Mode.
   */
  detectIterationSignal(userMessage: string): boolean {
    const lower = userMessage.toLowerCase();

    // Check keyword matches
    for (const keyword of ITERATION_KEYWORDS) {
      if (lower.includes(keyword)) {
        return true;
      }
    }

    // Check regex pattern matches
    for (const pattern of ITERATION_PATTERNS) {
      if (pattern.test(userMessage)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Start the Q&A flow. Resets state to initial.
   * REQ-11.1: extend Q&A flow with 4 questions.
   */
  startQAFlow(): QAFlowState {
    this.state = this.createInitialState();
    return { ...this.state };
  }

  /**
   * Process an answer for a given question index.
   * Advances to the next question or marks complete.
   * REQ-11.1: require all 4 questions answered; auto-mark complete.
   */
  answerQuestion(questionIndex: number, answer: string): QAFlowState {
    if (questionIndex < 0 || questionIndex >= this.state.questions.length) {
      return { ...this.state };
    }

    this.state.answers[questionIndex] = answer;

    // Advance to next unanswered question or mark complete
    const nextUnanswered = this.findNextUnanswered(questionIndex);
    if (nextUnanswered === -1) {
      // All questions answered — auto-complete (REQ-11.1)
      this.state.complete = true;
      this.state.currentQuestion = this.state.questions.length - 1;
    } else {
      this.state.currentQuestion = nextUnanswered;
    }

    return { ...this.state };
  }

  /**
   * Emit a draft LoopSpec from the collected answers.
   * Validates against Zod schema before presenting (REQ-11.4).
   * REQ-11.2: emit draft for user approval.
   * REQ-11.5: if validation fails, return errors with field reference.
   */
  emitDraftSpec(): { valid: boolean; spec?: LoopSpec; errors?: string[] } {
    if (!this.state.complete) {
      return {
        valid: false,
        errors: ['Q&A flow is not complete. All 4 questions must be answered.'],
      };
    }

    const draft = this.buildDraftFromAnswers();
    const result = validateLoopSpec(draft);

    if (result.success) {
      return { valid: true, spec: result.data };
    }

    // REQ-11.5: display validation errors with field references
    const errors = result.error!.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    return { valid: false, errors };
  }

  /**
   * Handle rejection of the draft LoopSpec.
   * Returns to Q&A with preserved defaults (REQ-11.3).
   */
  handleRejection(): QAFlowState {
    // REQ-11.3: return to first question, preserve answers as defaults
    this.state.complete = false;
    this.state.currentQuestion = 0;
    return { ...this.state };
  }

  /**
   * Get the question index whose field caused a validation error.
   * Used for REQ-11.5: return to relevant question on validation failure.
   */
  getQuestionIndexForField(fieldPath: string): number {
    if (fieldPath.startsWith('goal') || fieldPath.startsWith('passAction')) {
      return 0;
    }
    if (fieldPath.startsWith('verify')) {
      return 1;
    }
    if (fieldPath.startsWith('feedback')) {
      return 2;
    }
    if (fieldPath.startsWith('stop')) {
      return 3;
    }
    return 0;
  }

  /**
   * Get current flow state (read-only snapshot).
   */
  getState(): QAFlowState {
    return { ...this.state };
  }

  // ── Private Helpers ─────────────────────────────────────────────

  private createInitialState(): QAFlowState {
    return {
      currentQuestion: 0,
      questions: [...CRAFT_QUESTIONS],
      answers: ['', '', '', ''],
      complete: false,
    };
  }

  private findNextUnanswered(afterIndex: number): number {
    // Look for the next empty answer after the current index
    for (let i = afterIndex + 1; i < this.state.answers.length; i++) {
      if (!this.state.answers[i]) {
        return i;
      }
    }
    // Also check before (in case user jumped ahead)
    for (let i = 0; i <= afterIndex; i++) {
      if (!this.state.answers[i]) {
        return i;
      }
    }
    return -1; // All answered
  }

  /**
   * Build a raw LoopSpec object from the user's answers.
   * Maps answers to LoopSpec fields:
   *   Q0 (goal) → goal + passAction
   *   Q1 (verify) → verify array
   *   Q2 (feedback) → feedback
   *   Q3 (stop) → stop conditions
   */
  private buildDraftFromAnswers(): Record<string, unknown> {
    const [goalAnswer, verifyAnswer, feedbackAnswer, stopAnswer] = this.state.answers;

    return {
      id: randomUUID(),
      version: '1.0.0',
      name: this.extractName(goalAnswer),
      useWhen: this.extractUseWhen(goalAnswer),
      goal: this.extractGoal(goalAnswer),
      passAction: this.extractPassAction(goalAnswer),
      verify: this.parseVerifyAnswer(verifyAnswer),
      feedback: feedbackAnswer,
      stop: this.parseStopAnswer(stopAnswer),
      scope: {
        allowedPaths: ['src/**'],
        allowedTools: ['Read', 'Write', 'Bash'],
        securityPolicy: 'standard',
      },
      source: 'user',
    };
  }

  private extractName(goalAnswer: string): string {
    // Use first sentence or first 128 chars as name
    const firstSentence = goalAnswer.split(/[.!?\n]/)[0]?.trim() || goalAnswer;
    return firstSentence.slice(0, 128) || 'Custom Loop';
  }

  private extractUseWhen(goalAnswer: string): string {
    return `When user wants to: ${goalAnswer.slice(0, 480)}`;
  }

  private extractGoal(goalAnswer: string): string {
    return goalAnswer.slice(0, 1024) || 'Complete the iterative task';
  }

  private extractPassAction(goalAnswer: string): string {
    // Attempt to extract action from goal answer — use the whole thing as pass action
    return goalAnswer.slice(0, 512) || 'Execute next iteration step';
  }

  private parseVerifyAnswer(verifyAnswer: string): unknown[] {
    // Parse the verify answer into check objects.
    // If it looks like a command, create a command check.
    // Otherwise create a file or llmJudge check.
    const checks: unknown[] = [];
    const lines = verifyAnswer.split(/[\n;,]/).map((l) => l.trim()).filter(Boolean);

    for (const line of lines) {
      if (this.looksLikeCommand(line)) {
        checks.push({
          type: 'command',
          command: line.slice(0, 1024),
          expectedExitCode: 0,
        });
      } else if (this.looksLikeFilePath(line)) {
        checks.push({
          type: 'file',
          filePath: line.slice(0, 512),
          assertion: 'exists',
        });
      } else {
        checks.push({
          type: 'llmJudge',
          rubric: line.slice(0, 2048),
          threshold: 0.8,
        });
      }
    }

    // Ensure at least one check
    if (checks.length === 0) {
      checks.push({
        type: 'llmJudge',
        rubric: verifyAnswer.slice(0, 2048) || 'Verify the task is complete',
        threshold: 0.8,
      });
    }

    return checks;
  }

  private parseStopAnswer(stopAnswer: string): Record<string, unknown> {
    // Parse stop conditions from natural language.
    // Look for numbers and map them to fields.
    const defaults = {
      maxPasses: 10,
      maxCostUsd: 5.0,
      maxWallClockMin: 30.0,
      noProgressPasses: 3,
      approvalBoundaries: [] as number[],
    };

    if (!stopAnswer) return defaults;

    // Try to extract max passes
    const passesMatch = stopAnswer.match(/(\d+)\s*(?:pass|passes|iterations?|tries?|attempts?)/i);
    if (passesMatch) {
      defaults.maxPasses = Math.min(Math.max(parseInt(passesMatch[1], 10), 1), 50);
    }

    // Try to extract max cost (requires $ prefix or cost/budget/usd suffix)
    const costMatch = stopAnswer.match(/\$([\d.]+)|\b([\d.]+)\s*(?:usd|dollars?|cost|budget)/i);
    if (costMatch) {
      const cost = parseFloat(costMatch[1] || costMatch[2]);
      if (cost >= 0.01 && cost <= 10000) {
        defaults.maxCostUsd = cost;
      }
    }

    // Try to extract max time
    const timeMatch = stopAnswer.match(/(\d+)\s*(?:min|minutes?|mins?)/i);
    if (timeMatch) {
      const time = parseFloat(timeMatch[1]);
      if (time >= 0.1 && time <= 1440) {
        defaults.maxWallClockMin = time;
      }
    }

    // Try to extract no-progress passes
    const stalledMatch = stopAnswer.match(/(\d+)\s*(?:stall|no.?progress|stuck|same)/i);
    if (stalledMatch) {
      const stalled = parseInt(stalledMatch[1], 10);
      if (stalled >= 1 && stalled <= defaults.maxPasses) {
        defaults.noProgressPasses = stalled;
      }
    }

    return defaults;
  }

  private looksLikeCommand(text: string): boolean {
    const commandIndicators = [
      /^(?:npm|npx|yarn|pnpm)\s/,
      /^(?:tsc|eslint|vitest|jest|pytest|cargo|go|make)\b/,
      /^(?:sh|bash|zsh)\s/,
      /^(?:node|python|ruby)\s/,
      /^(?:git|docker|kubectl)\s/,
      /\s--\w/,
      /^\w+\s+-\w/,
    ];
    return commandIndicators.some((re) => re.test(text.trim()));
  }

  private looksLikeFilePath(text: string): boolean {
    return /^[\w./-]+\.\w+$/.test(text.trim()) || text.trim().startsWith('./') || text.trim().startsWith('/');
  }
}
