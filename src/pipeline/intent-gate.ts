/**
 * IntentGate — Unified classification entry point.
 *
 * Replaces the existing dual-classifier system (`intent-classifier.ts` +
 * `llm-intent-classifier.ts`) with a single three-stage cascade:
 *   Stage A: PatternClassifier (deterministic regex, <5ms)
 *   Stage B: LLMClassifier (LLM-based, 800ms hard timeout)
 *   Stage C: ContextPrior (conversation-history disambiguator)
 *
 * When the `unified_intent_gate` feature flag is disabled, existing
 * `classifyIntent` and `classifyIntentWithLLM` paths remain active.
 *
 * Requirements: 1.1, 1.2, 1.6, 14.1
 */

import { createHash } from 'crypto';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type IntentLabel = 'conversation' | 'quick_action' | 'build' | 'ambiguous';
export type ClassificationStage = 'pattern' | 'llm' | 'context_prior' | 'user_override';
export type ComplexityTier = 'trivial' | 'medium' | 'complex';

export interface IntentDecision {
  intent: IntentLabel;
  confidence: number; // 0–1
  stage: ClassificationStage;
  complexity: ComplexityTier | null; // non-null only for 'build'
  signals: string[]; // human-readable explanation array
  latencyMs: number;
  messageHash: string; // SHA-256 of normalized message
  timestamp: number;
}

export interface IntentGateConfig {
  patternConfidenceThreshold: number; // default 0.85
  llmTimeoutMs: number; // default 800
  contextPriorWindowSize: number; // default 6 turns
  enabled: boolean; // feature gate
}

// ─── Session Context ────────────────────────────────────────────────────────

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface SessionContext {
  recentTurns: ConversationTurn[]; // last N turns (configurable via contextPriorWindowSize)
  activeInterview: boolean;
  activeOrchestration: boolean;
  lastAssistantSubject: string | null;
}

// ─── Stage Interfaces (Placeholder) ────────────────────────────────────────
// These will be implemented as separate modules in subsequent tasks.

export interface PatternMatch {
  intent: IntentLabel;
  confidence: number;
  pattern: string; // the matching pattern identifier
  source: 'builtin' | 'learned';
}

export interface PatternClassifier {
  classify(message: string): PatternMatch;
  reloadPatterns(): void;
  getPatternCount(): number;
}

export interface LLMClassifierResult {
  intent: IntentLabel;
  confidence: number;
  complexity: ComplexityTier | null;
  reasoning: string;
}

export interface LLMClassifier {
  classify(message: string, timeout: number): Promise<LLMClassifierResult | null>;
}

export interface ContextPrior {
  disambiguate(
    message: string,
    stageResult: PatternMatch | LLMClassifierResult,
    context: SessionContext
  ): IntentDecision;
}

// ─── IntentGate Interface ───────────────────────────────────────────────────

export interface IIntentGate {
  classify(message: string, sessionContext: SessionContext): Promise<IntentDecision>;
  applyOverride(messageHash: string, newIntent: IntentLabel): Promise<IntentDecision>;
  getDecision(messageHash: string): IntentDecision | null;
}

// ─── Default Config ─────────────────────────────────────────────────────────

export const DEFAULT_INTENT_GATE_CONFIG: IntentGateConfig = {
  patternConfidenceThreshold: 0.85,
  llmTimeoutMs: 800,
  contextPriorWindowSize: 6,
  enabled: true,
};

// ─── Utilities ──────────────────────────────────────────────────────────────

/**
 * Compute SHA-256 hash of a normalized (trimmed, lowercased) message.
 */
export function computeMessageHash(message: string): string {
  const normalized = message.trim().toLowerCase();
  return createHash('sha256').update(normalized).digest('hex');
}

// ─── IntentGate Implementation ──────────────────────────────────────────────

export class IntentGateImpl implements IIntentGate {
  private readonly config: IntentGateConfig;
  private readonly featureGate: FeatureGateSystem;
  private readonly patternClassifier: PatternClassifier;
  private readonly llmClassifier: LLMClassifier;
  private readonly contextPrior: ContextPrior;
  private readonly decisions: Map<string, IntentDecision> = new Map();

  constructor(
    config: Partial<IntentGateConfig>,
    featureGate: FeatureGateSystem,
    patternClassifier: PatternClassifier,
    llmClassifier: LLMClassifier,
    contextPrior: ContextPrior,
  ) {
    this.config = { ...DEFAULT_INTENT_GATE_CONFIG, ...config };
    this.featureGate = featureGate;
    this.patternClassifier = patternClassifier;
    this.llmClassifier = llmClassifier;
    this.contextPrior = contextPrior;
  }

  /**
   * Three-stage classification cascade.
   *
   * 1. Stage A (Pattern): If confidence ≥ threshold → accept immediately.
   * 2. Stage B (LLM): If Stage A is below threshold → invoke LLM with hard timeout.
   *    On timeout/error → fall back to Stage A result.
   * 3. Stage C (ContextPrior): Apply conversation-history disambiguation to refine.
   *
   * Requirements: 1.1, 1.2, 2.2, 2.3, 2.4, 2.5
   */
  async classify(message: string, sessionContext: SessionContext): Promise<IntentDecision> {
    if (!this.featureGate.isEnabled('unified_intent_gate')) {
      // Feature gate disabled — return a minimal decision that callers can ignore.
      // The existing classifyIntent/classifyIntentWithLLM paths should be used instead.
      const hash = computeMessageHash(message);
      const fallbackDecision: IntentDecision = {
        intent: 'ambiguous',
        confidence: 0,
        stage: 'pattern',
        complexity: null,
        signals: ['unified_intent_gate disabled — using legacy classification'],
        latencyMs: 0,
        messageHash: hash,
        timestamp: Date.now(),
      };
      this.decisions.set(hash, fallbackDecision);
      return fallbackDecision;
    }

    const startTime = performance.now();
    const messageHash = computeMessageHash(message);

    // ── Stage A: PatternClassifier ──────────────────────────────────────
    const patternResult = this.patternClassifier.classify(message);

    // Determine whether Stage B (LLM) is needed based on Stage A confidence.
    // Confidence ≥ 0.85 → skip LLM; (0.4, 0.85) or ≤ 0.4 → invoke LLM.
    let stageResult: PatternMatch | LLMClassifierResult = patternResult;

    if (patternResult.confidence < this.config.patternConfidenceThreshold) {
      // ── Stage B: LLMClassifier ────────────────────────────────────────
      let llmResult: LLMClassifierResult | null = null;

      try {
        llmResult = await this.llmClassifier.classify(message, this.config.llmTimeoutMs);
      } catch {
        // LLM failed — fall through to use pattern result with context prior
        llmResult = null;
      }

      // Use LLM result if available, otherwise fall back to Stage A
      stageResult = llmResult ?? patternResult;
    }

    // ── Stage C: ContextPrior ───────────────────────────────────────────
    // Always applied — after Stage B resolves, or after Stage A if B not needed.
    const contextDecision = this.contextPrior.disambiguate(
      message,
      stageResult,
      sessionContext,
    );

    // Build final decision using context prior output
    const decision: IntentDecision = {
      ...contextDecision,
      latencyMs: Math.round((performance.now() - startTime) * 100) / 100,
      messageHash,
      timestamp: Date.now(),
    };

    // Ensure complexity is null for non-build intents
    if (decision.intent !== 'build') {
      decision.complexity = null;
    }

    this.decisions.set(messageHash, decision);
    return decision;
  }

  /**
   * Apply a user override to an existing decision.
   * Creates a new IntentDecision with stage='user_override'.
   *
   * Requirements: 4.5, 3.2
   */
  async applyOverride(messageHash: string, newIntent: IntentLabel): Promise<IntentDecision> {
    const existing = this.decisions.get(messageHash);

    const decision: IntentDecision = {
      intent: newIntent,
      confidence: 1.0, // User override has maximum confidence
      stage: 'user_override',
      complexity: existing?.complexity ?? null,
      signals: [
        `User override: ${existing?.intent ?? 'unknown'} → ${newIntent}`,
        ...(existing?.signals ?? []),
      ],
      latencyMs: 0,
      messageHash,
      timestamp: Date.now(),
    };

    // For non-build intents, ensure complexity is null
    if (decision.intent !== 'build') {
      decision.complexity = null;
    }

    this.decisions.set(messageHash, decision);
    return decision;
  }

  /**
   * Retrieve a stored decision by message hash.
   * Returns null if no decision exists for the given hash.
   */
  getDecision(messageHash: string): IntentDecision | null {
    return this.decisions.get(messageHash) ?? null;
  }

}
