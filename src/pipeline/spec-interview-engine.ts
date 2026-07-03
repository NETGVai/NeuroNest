/**
 * SpecInterviewEngine — Unified spec-gathering interview engine.
 *
 * Replaces the existing `BrainstormMode` and `GrillMeSession` with a single
 * complexity-tiered interview engine that adapts depth to task complexity:
 *   - trivial: 0 questions, present inline confirmation card
 *   - medium: 3-4 questions batched in a single card
 *   - complex: 1-per-turn interview (Grill-Me style), max 7 questions
 *
 * When the `spec_interview_engine` feature flag is disabled, build tasks
 * route directly to orchestration without interviews.
 *
 * When `auto_spec_mode` is false, the engine is also disabled and build tasks
 * route directly to orchestration.
 *
 * Requirements: 5.1, 6.1, 7.1, 7.2, 14.2
 */

import crypto from 'node:crypto';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type { IntentDecision, ComplexityTier } from './intent-gate.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type InterviewStatus = 'pending' | 'active' | 'completed' | 'skipped' | 'cancelled' | 'stale';

export interface InterviewTurn {
  questionIndex: number;
  question: string;
  recommendation: string;
  answer: string | null; // null = unanswered
  answeredAt: number | null;
}

export interface InterviewState {
  id: string;
  sessionId: string;
  messageHash: string;
  complexity: ComplexityTier;
  status: InterviewStatus;
  turns: InterviewTurn[];
  maxQuestions: number; // 0 for trivial, 3-4 for medium, 7 for complex
  originalMessage: string;
  createdAt: number;
  updatedAt: number;
}

// ─── Synthesized Spec (forward declaration for skipToSpec / buildWithDefaults) ──

export interface AcceptanceCriterion {
  id: string;
  description: string;
  verifiable: boolean;
}

export interface ImplementationStep {
  order: number;
  description: string;
  files: string[];
}

export type ExecutionMode = 'flash' | 'standard' | 'pro' | 'ultra';

export interface CostEstimate {
  tokens: number;
  estimatedCostUsd: number;
  tier: string;
}

export interface SynthesizedSpec {
  id: string;
  title: string;
  overview: string;
  acceptanceCriteria: AcceptanceCriterion[];
  implementationPlan: ImplementationStep[];
  filesToChange: string[];
  testingStrategy: string;
  suggestedMode: ExecutionMode;
  costEstimate: CostEstimate;
  status: 'draft' | 'reviewed' | 'executing' | 'stale';
  createdAt: number;
}

// ─── Question Generator Interface ──────────────────────────────────────────

/**
 * Generates clarifying questions for a build request based on complexity.
 * This will be implemented by an LLM-backed question generator in a
 * subsequent task; here we define the contract.
 */
export interface QuestionGenerator {
  generateQuestions(
    message: string,
    complexity: ComplexityTier,
    maxCount: number,
  ): Promise<InterviewTurn[]>;
}

// ─── Spec Synthesis Interface ───────────────────────────────────────────────

/**
 * Synthesizes a spec from completed (or partially completed) interview state.
 * Implemented in a subsequent task (spec-synthesizer.ts).
 */
export interface SpecSynthesisProvider {
  synthesize(state: InterviewState): Promise<SynthesizedSpec>;
}

// ─── Persistence Interface ──────────────────────────────────────────────────

/**
 * Persistence adapter for interview state.
 * Uses the `interview_transcripts` SQLite table from migration 040.
 */
export interface InterviewPersistence {
  save(state: InterviewState): void;
  load(interviewId: string): InterviewState | null;
  findIncomplete(sessionId: string): InterviewState[];
  delete(interviewId: string): void;
}

// ─── SpecInterviewEngine Interface ──────────────────────────────────────────

export interface ISpecInterviewEngine {
  startInterview(decision: IntentDecision, message: string, sessionId: string): Promise<InterviewState>;
  answerQuestion(interviewId: string, questionIndex: number, answer: string): Promise<InterviewState>;
  skipToSpec(interviewId: string): Promise<SynthesizedSpec>;
  buildWithDefaults(interviewId: string): Promise<SynthesizedSpec>;
  resumeInterview(interviewId: string): Promise<InterviewState | null>;
  cancelInterview(interviewId: string): void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum questions for each complexity tier */
const COMPLEXITY_QUESTION_LIMITS: Record<ComplexityTier, number> = {
  trivial: 0,
  medium: 4,
  complex: 7,
};

/** Maximum questions before escalation to complex for medium tier */
const MEDIUM_MAX_QUESTIONS = 4;

// ─── SpecInterviewEngine Implementation ─────────────────────────────────────

export class SpecInterviewEngineImpl implements ISpecInterviewEngine {
  private readonly featureGate: FeatureGateSystem;
  private readonly questionGenerator: QuestionGenerator;
  private readonly specSynthesizer: SpecSynthesisProvider;
  private readonly persistence: InterviewPersistence;
  private readonly autoSpecModeProvider: () => boolean;

  /** In-memory cache of active interviews for fast access */
  private readonly activeInterviews: Map<string, InterviewState> = new Map();

  constructor(opts: {
    featureGate: FeatureGateSystem;
    questionGenerator: QuestionGenerator;
    specSynthesizer: SpecSynthesisProvider;
    persistence: InterviewPersistence;
    /** Returns true if auto_spec_mode is enabled for the current project */
    autoSpecModeProvider: () => boolean;
  }) {
    this.featureGate = opts.featureGate;
    this.questionGenerator = opts.questionGenerator;
    this.specSynthesizer = opts.specSynthesizer;
    this.persistence = opts.persistence;
    this.autoSpecModeProvider = opts.autoSpecModeProvider;
  }

  /**
   * Check if the engine is active (feature gate + auto_spec_mode).
   *
   * When disabled, callers should route build tasks directly to orchestration.
   *
   * Requirement 14.2: When `auto_spec_mode` is false, build tasks route directly
   * to orchestration without interviews.
   */
  isEnabled(): boolean {
    return (
      this.featureGate.isEnabled('spec_interview_engine') &&
      this.autoSpecModeProvider()
    );
  }

  /**
   * Start a new interview for a build intent.
   *
   * Routes based on complexity tier:
   *   - trivial: InterviewState with 0 turns, status 'completed' immediately
   *   - medium: Generates 3-4 batched questions. If generator produces >4, escalates to complex.
   *   - complex: Generates up to 7 questions, delivered one-per-turn.
   *
   * Requirements: 5.1, 6.1, 7.1, 7.2
   */
  async startInterview(
    decision: IntentDecision,
    message: string,
    sessionId: string,
  ): Promise<InterviewState> {
    const complexity = decision.complexity ?? 'trivial';
    const id = crypto.randomUUID();
    const now = Date.now();

    // ── Trivial: zero questions, immediate completion ───────────────
    // Requirement 5.1: trivial → zero interview questions, present inline confirmation
    if (complexity === 'trivial') {
      const state: InterviewState = {
        id,
        sessionId,
        messageHash: decision.messageHash,
        complexity: 'trivial',
        status: 'completed',
        turns: [],
        maxQuestions: 0,
        originalMessage: message,
        createdAt: now,
        updatedAt: now,
      };
      this.activeInterviews.set(id, state);
      this.persistence.save(state);
      return state;
    }

    // ── Medium & Complex: generate questions ────────────────────────
    let effectiveComplexity = complexity;

    // For medium, request up to MEDIUM_MAX_QUESTIONS + 1 so we can detect escalation.
    // If the generator produces more than MEDIUM_MAX_QUESTIONS, escalate to complex.
    // For complex, request up to the hard cap (7).
    const requestCount = complexity === 'medium'
      ? MEDIUM_MAX_QUESTIONS + 1  // Ask for 5 to detect if generator wants more than 4
      : COMPLEXITY_QUESTION_LIMITS.complex;

    const generatedTurns = await this.questionGenerator.generateQuestions(
      message,
      complexity,
      requestCount,
    );

    // Requirement 6.1: If medium tier generates more than 4, escalate to complex
    if (complexity === 'medium' && generatedTurns.length > MEDIUM_MAX_QUESTIONS) {
      effectiveComplexity = 'complex';
      // Re-generate with complex limits (up to 7)
      const complexTurns = await this.questionGenerator.generateQuestions(
        message,
        'complex',
        COMPLEXITY_QUESTION_LIMITS.complex,
      );
      return this.createInterviewState(
        id,
        sessionId,
        decision.messageHash,
        'complex',
        complexTurns,
        message,
        now,
      );
    }

    // For medium: cap at MEDIUM_MAX_QUESTIONS; for complex: cap at 7
    const finalTurns = complexity === 'medium'
      ? generatedTurns.slice(0, MEDIUM_MAX_QUESTIONS)
      : generatedTurns.slice(0, COMPLEXITY_QUESTION_LIMITS.complex);

    return this.createInterviewState(
      id,
      sessionId,
      decision.messageHash,
      effectiveComplexity,
      finalTurns,
      message,
      now,
    );
  }

  /**
   * Answer a specific question in an active interview.
   *
   * For medium complexity: all questions are batched, answers can arrive in any order.
   * For complex: one-per-turn — answering one question advances to the next.
   *
   * Requirements: 6.3, 7.1
   */
  async answerQuestion(
    interviewId: string,
    questionIndex: number,
    answer: string,
  ): Promise<InterviewState> {
    const state = this.getInterviewState(interviewId);
    if (!state) {
      throw new Error(`Interview not found: ${interviewId}`);
    }
    if (state.status === 'completed' || state.status === 'cancelled' || state.status === 'skipped') {
      throw new Error(`Interview ${interviewId} is not active (status: ${state.status})`);
    }

    // Find the turn to update
    const turn = state.turns.find(t => t.questionIndex === questionIndex);
    if (!turn) {
      throw new Error(`Question index ${questionIndex} not found in interview ${interviewId}`);
    }

    // Record the answer
    turn.answer = answer;
    turn.answeredAt = Date.now();
    state.updatedAt = Date.now();

    // Transition status if appropriate
    if (state.status === 'pending') {
      state.status = 'active';
    }

    // Check if all questions are answered → mark completed
    const allAnswered = state.turns.every(t => t.answer !== null);
    if (allAnswered) {
      state.status = 'completed';
    }

    // Persist updated state
    this.activeInterviews.set(interviewId, state);
    this.persistence.save(state);

    return state;
  }

  /**
   * Skip remaining questions and proceed directly to spec synthesis.
   *
   * Uses answers given so far + recommendations for any unanswered questions.
   * For complex interviews, this is the "Skip to spec" button.
   *
   * Requirement 7.4: "Skip to spec" button on every interview turn.
   */
  async skipToSpec(interviewId: string): Promise<SynthesizedSpec> {
    const state = this.getInterviewState(interviewId);
    if (!state) {
      throw new Error(`Interview not found: ${interviewId}`);
    }

    // Fill unanswered questions with recommendations
    this.fillWithRecommendations(state);
    state.status = 'skipped';
    state.updatedAt = Date.now();

    this.activeInterviews.set(interviewId, state);
    this.persistence.save(state);

    // Synthesize the spec
    return this.specSynthesizer.synthesize(state);
  }

  /**
   * Build immediately using recommended defaults for all unresolved questions.
   *
   * Requirement 8.2: "Build with defaults" synthesizes spec using recommendation
   * values for all unresolved questions.
   */
  async buildWithDefaults(interviewId: string): Promise<SynthesizedSpec> {
    const state = this.getInterviewState(interviewId);
    if (!state) {
      throw new Error(`Interview not found: ${interviewId}`);
    }

    // Fill all unanswered with recommendations
    this.fillWithRecommendations(state);
    state.status = 'completed';
    state.updatedAt = Date.now();

    this.activeInterviews.set(interviewId, state);
    this.persistence.save(state);

    // Synthesize the spec
    return this.specSynthesizer.synthesize(state);
  }

  /**
   * Resume an interrupted interview from persistence.
   *
   * Requirement 9.2: On restart, detect incomplete interviews and resume from
   * the last persisted turn.
   *
   * Returns null if no interview found for the given ID.
   */
  async resumeInterview(interviewId: string): Promise<InterviewState | null> {
    // Try in-memory first
    const cached = this.activeInterviews.get(interviewId);
    if (cached) return cached;

    // Load from persistence
    const persisted = this.persistence.load(interviewId);
    if (!persisted) return null;

    // Only resume interviews that are in a resumable state
    if (persisted.status === 'completed' || persisted.status === 'cancelled') {
      return persisted;
    }

    // Cache for future access
    this.activeInterviews.set(interviewId, persisted);
    return persisted;
  }

  /**
   * Cancel an in-progress interview.
   *
   * Marks the interview as cancelled and removes from active cache.
   */
  cancelInterview(interviewId: string): void {
    const state = this.getInterviewState(interviewId);
    if (!state) return;

    state.status = 'cancelled';
    state.updatedAt = Date.now();

    this.activeInterviews.set(interviewId, state);
    this.persistence.save(state);
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Retrieve interview state from memory or persistence.
   */
  private getInterviewState(interviewId: string): InterviewState | null {
    const cached = this.activeInterviews.get(interviewId);
    if (cached) return cached;

    const persisted = this.persistence.load(interviewId);
    if (persisted) {
      this.activeInterviews.set(interviewId, persisted);
    }
    return persisted;
  }

  /**
   * Create and persist a new interview state with generated turns.
   */
  private createInterviewState(
    id: string,
    sessionId: string,
    messageHash: string,
    complexity: ComplexityTier,
    turns: InterviewTurn[],
    originalMessage: string,
    createdAt: number,
  ): InterviewState {
    const maxQuestions = complexity === 'trivial'
      ? 0
      : complexity === 'medium'
        ? Math.min(turns.length, MEDIUM_MAX_QUESTIONS)
        : COMPLEXITY_QUESTION_LIMITS.complex;

    const state: InterviewState = {
      id,
      sessionId,
      messageHash,
      complexity,
      status: turns.length === 0 ? 'completed' : 'pending',
      turns,
      maxQuestions,
      originalMessage,
      createdAt,
      updatedAt: createdAt,
    };

    this.activeInterviews.set(id, state);
    this.persistence.save(state);
    return state;
  }

  /**
   * Fill all unanswered turns with their recommended answers.
   * Used by skipToSpec() and buildWithDefaults().
   *
   * Requirement 8.2: Every unanswered question's resolution uses the
   * corresponding `recommendation` value.
   */
  private fillWithRecommendations(state: InterviewState): void {
    const now = Date.now();
    for (const turn of state.turns) {
      if (turn.answer === null) {
        turn.answer = turn.recommendation;
        turn.answeredAt = now;
      }
    }
  }
}
