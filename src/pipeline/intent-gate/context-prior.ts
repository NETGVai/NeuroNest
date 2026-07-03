/**
 * ContextPrior — Stage C conversation-history-based disambiguator.
 *
 * Applies three disambiguation rules in priority order:
 *   1. Continuation inheritance (Req 2.9): Short affirmations inherit prior turn subject
 *   2. Interview state rule (Req 2.7): Active interview captures replies (except escape commands)
 *   3. Orchestration amendment rule (Req 2.8): Imperatives during orchestration → amendments
 *
 * Falls back to the upstream stageResult when no rule applies.
 *
 * Requirements: 2.6, 2.7, 2.8, 2.9
 */

import type {
  ContextPrior,
  IntentDecision,
  IntentLabel,
  PatternMatch,
  LLMClassifierResult,
  SessionContext,
  ComplexityTier,
  ClassificationStage,
} from '../intent-gate.js';
import { computeMessageHash } from '../intent-gate.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Escape commands that bypass interview state classification.
 * These allow users to break out of an active interview.
 */
const ESCAPE_COMMANDS: ReadonlySet<string> = new Set([
  'help',
  'cancel',
  'exit interview',
]);

/**
 * Short affirmation patterns that trigger continuation inheritance.
 * Normalized to lowercase for matching.
 */
const CONTINUATION_PHRASES: ReadonlySet<string> = new Set([
  'do it',
  'yes',
  'go ahead',
  'yes go ahead',
  'go for it',
  'sure',
  'ok',
  'okay',
  'yep',
  'yeah',
  'proceed',
  'lets do it',
  "let's do it",
  'yes please',
  'do that',
]);

/**
 * Common imperative verbs that signal an action directive.
 * Used for the orchestration amendment rule.
 */
const IMPERATIVE_VERBS: ReadonlySet<string> = new Set([
  'add',
  'remove',
  'delete',
  'update',
  'change',
  'fix',
  'refactor',
  'rename',
  'move',
  'create',
  'implement',
  'modify',
  'replace',
  'extract',
  'inline',
  'optimize',
  'use',
  'apply',
  'install',
  'run',
  'test',
  'build',
  'deploy',
  'stop',
  'restart',
  'revert',
  'undo',
  'skip',
  'retry',
  'include',
  'exclude',
  'merge',
  'split',
  'wrap',
  'unwrap',
  'convert',
  'migrate',
  'upgrade',
  'downgrade',
  'enable',
  'disable',
  'set',
  'configure',
  'make',
  'put',
  'also',
]);

/**
 * Action-related words that can appear anywhere in the message,
 * indicating the message is about the current work.
 */
const AMENDMENT_SIGNAL_WORDS: ReadonlySet<string> = new Set([
  'instead',
  'also',
  'actually',
  'but',
  'wait',
  'rather',
  'too',
  'as well',
  'while you',
  'before that',
  'after that',
  'first',
  'then',
  'dont forget',
  "don't forget",
  'make sure',
  'remember to',
]);

// ─── Implementation ─────────────────────────────────────────────────────────

export class ContextPriorImpl implements ContextPrior {
  /**
   * Disambiguate a user message using conversation context.
   *
   * Applies rules in priority order:
   *   1. Continuation inheritance (highest precedence when applicable)
   *   2. Interview state rule
   *   3. Orchestration amendment rule
   *   4. Pass-through (no override)
   */
  disambiguate(
    message: string,
    stageResult: PatternMatch | LLMClassifierResult,
    context: SessionContext,
  ): IntentDecision {
    const normalized = message.trim().toLowerCase();
    const startTime = performance.now();

    // ── Rule 1: Continuation inheritance (Req 2.9) ──────────────────────
    // Takes precedence over all other rules when both conditions apply.
    if (this.isContinuationPhrase(normalized) && context.lastAssistantSubject !== null) {
      return this.buildDecision(
        'build',
        0.9,
        'context_prior',
        this.extractComplexity(stageResult),
        [
          `Continuation inheritance: "${message}" inherits prior subject "${context.lastAssistantSubject}"`,
          ...this.extractUpstreamSignals(stageResult),
        ],
        startTime,
        message,
      );
    }

    // ── Rule 2: Interview state rule (Req 2.7) ──────────────────────────
    // When interview is active, classify as interview answer unless escape command.
    if (context.activeInterview) {
      if (this.isEscapeCommand(normalized)) {
        // Escape commands bypass interview classification
        return this.buildDecision(
          stageResult.intent,
          stageResult.confidence,
          'context_prior',
          this.extractComplexity(stageResult),
          [
            `Escape command detected during interview: "${message}"`,
            ...this.extractUpstreamSignals(stageResult),
          ],
          startTime,
          message,
        );
      }

      // All other messages during interview → interview answer (build)
      return this.buildDecision(
        'build',
        0.95,
        'context_prior',
        this.extractComplexity(stageResult) ?? 'medium',
        [
          'Interview state rule: classified as interview answer (activeInterview=true)',
          ...this.extractUpstreamSignals(stageResult),
        ],
        startTime,
        message,
      );
    }

    // ── Rule 3: Orchestration amendment rule (Req 2.8) ──────────────────
    // During orchestration, imperatives about current work → amendments.
    if (context.activeOrchestration && this.isImperativeAboutCurrentWork(normalized)) {
      return this.buildDecision(
        'build',
        0.85,
        'context_prior',
        this.extractComplexity(stageResult) ?? 'medium',
        [
          `Orchestration amendment rule: imperative during active orchestration "${message}"`,
          ...this.extractUpstreamSignals(stageResult),
        ],
        startTime,
        message,
      );
    }

    // ── Fallback: Pass through upstream result ──────────────────────────
    return this.buildDecision(
      stageResult.intent,
      stageResult.confidence,
      'context_prior',
      this.extractComplexity(stageResult),
      [
        'Context prior: no disambiguation rule applied, passing through stage result',
        ...this.extractUpstreamSignals(stageResult),
      ],
      startTime,
      message,
    );
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  /**
   * Check if the normalized message is a short affirmation/continuation phrase.
   */
  private isContinuationPhrase(normalized: string): boolean {
    return CONTINUATION_PHRASES.has(normalized);
  }

  /**
   * Check if the normalized message is an escape command.
   */
  private isEscapeCommand(normalized: string): boolean {
    return ESCAPE_COMMANDS.has(normalized);
  }

  /**
   * Determine if the message is an imperative about the current work.
   * Checks for:
   *   - Starts with an imperative verb
   *   - Contains amendment signal words
   */
  private isImperativeAboutCurrentWork(normalized: string): boolean {
    const words = normalized.split(/\s+/);
    const firstWord = words[0];

    // Check if starts with imperative verb
    if (firstWord && IMPERATIVE_VERBS.has(firstWord)) {
      return true;
    }

    // Check for amendment signal words anywhere in the message
    for (const signal of AMENDMENT_SIGNAL_WORDS) {
      if (normalized.includes(signal)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Extract complexity from a stage result.
   * PatternMatch does not carry complexity, LLMClassifierResult may.
   */
  private extractComplexity(stageResult: PatternMatch | LLMClassifierResult): ComplexityTier | null {
    if ('complexity' in stageResult) {
      return stageResult.complexity ?? null;
    }
    return null;
  }

  /**
   * Extract upstream signals for inclusion in the decision signals array.
   */
  private extractUpstreamSignals(stageResult: PatternMatch | LLMClassifierResult): string[] {
    if ('pattern' in stageResult) {
      return [`Upstream (pattern): ${stageResult.pattern} [${stageResult.source}] conf=${stageResult.confidence}`];
    }
    if ('reasoning' in stageResult) {
      return [`Upstream (llm): ${stageResult.reasoning} conf=${stageResult.confidence}`];
    }
    return [];
  }

  /**
   * Build a complete IntentDecision.
   */
  private buildDecision(
    intent: IntentLabel,
    confidence: number,
    stage: ClassificationStage,
    complexity: ComplexityTier | null,
    signals: string[],
    startTime: number,
    message: string,
  ): IntentDecision {
    return {
      intent,
      confidence: Math.max(0, Math.min(1, confidence)),
      stage,
      complexity: intent === 'build' ? complexity : null,
      signals,
      latencyMs: Math.round((performance.now() - startTime) * 100) / 100,
      messageHash: computeMessageHash(message),
      timestamp: Date.now(),
    };
  }
}
