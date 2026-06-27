/**
 * Enhanced Drift Classifier — Implementation for multi-category drift classification.
 *
 * Extends the base DriftMonitor with fine-grained category classification
 * (agent-drift, test-drift, specification-drift, context-drift), independent
 * confidence thresholds per category, and category-specific recovery strategies.
 *
 * Key behaviours:
 *   - classify() categorizes drift into exactly one of four categories
 *   - Uses existing DriftMonitor confidence scoring as input, extends with heuristics
 *   - Maintains independent configurable confidence thresholds per drift category
 *   - Maintains independent recovery strategies per drift category
 *   - Emits category-specific drift signals via CallbackEngine on-drift-signal event
 *   - Preserves all existing DriftMonitor behavior — classification is additive
 *   - Applies null-check guard when enhanced_drift_classification flag is disabled
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7
 */

import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type { CallbackEngine, HookContext, LifecycleEvent } from '../pipeline/callback-engine.js';
import type { DriftEvaluationResult } from './drift-monitor.js';
import { createDriftSignal } from './drift-signal.js';
import type {
  EnhancedDriftCategory,
  EnhancedDriftClassification,
  DriftCategoryThresholds,
  DriftRecoveryStrategy,
  EnhancedDriftConfig,
  IEnhancedDriftClassifier,
  ClassificationContext,
} from './enhanced-drift-classifier.js';

// ─── Default Configuration ──────────────────────────────────────

const DEFAULT_THRESHOLDS: DriftCategoryThresholds[] = [
  { category: 'agent-drift', warningThreshold: 0.6, criticalThreshold: 0.3 },
  { category: 'test-drift', warningThreshold: 0.5, criticalThreshold: 0.25 },
  { category: 'specification-drift', warningThreshold: 0.55, criticalThreshold: 0.3 },
  { category: 'context-drift', warningThreshold: 0.5, criticalThreshold: 0.2 },
];

const DEFAULT_STRATEGIES: DriftRecoveryStrategy[] = [
  { category: 'agent-drift', action: 'reconfirm', maxAttempts: 3 },
  { category: 'test-drift', action: 'checkpoint-restore', maxAttempts: 2 },
  { category: 'specification-drift', action: 'pause', maxAttempts: 1 },
  { category: 'context-drift', action: 'context-refresh', maxAttempts: 3 },
];

// ─── Heuristic Definitions ──────────────────────────────────────

/**
 * Heuristic indicators for each drift category.
 * These extend the base DriftMonitor confidence with category-specific signals.
 */

interface HeuristicResult {
  category: EnhancedDriftCategory;
  score: number;
  matchedHeuristics: string[];
}

// ─── EnhancedDriftClassifier Implementation ─────────────────────

/**
 * Classifies drift into fine-grained categories and applies category-specific
 * recovery strategies. Integrates additively with DriftMonitor — all existing
 * DriftMonitor behavior continues unchanged.
 */
export class EnhancedDriftClassifier implements IEnhancedDriftClassifier {
  private readonly featureGate: FeatureGateSystem;
  private readonly callbackEngine: CallbackEngine;
  private thresholds: Map<EnhancedDriftCategory, DriftCategoryThresholds>;
  private strategies: Map<EnhancedDriftCategory, DriftRecoveryStrategy>;

  constructor(
    featureGate: FeatureGateSystem,
    callbackEngine: CallbackEngine,
    config?: Partial<EnhancedDriftConfig>,
  ) {
    this.featureGate = featureGate;
    this.callbackEngine = callbackEngine;

    // Initialize thresholds from config or defaults (Requirement 13.3)
    const thresholdsList = config?.thresholds ?? DEFAULT_THRESHOLDS;
    this.thresholds = new Map(thresholdsList.map((t) => [t.category, t]));

    // Initialize strategies from config or defaults (Requirement 13.4)
    const strategiesList = config?.strategies ?? DEFAULT_STRATEGIES;
    this.strategies = new Map(strategiesList.map((s) => [s.category, s]));
  }

  // ─── IEnhancedDriftClassifier Implementation ────────────────────

  /**
   * Classify drift into one of four categories based on DriftMonitor evaluation
   * and context-specific heuristics.
   *
   * Requirement 13.1: Classify into agent-drift, test-drift, specification-drift, context-drift.
   * Requirement 13.2: Use DriftMonitor confidence as input, extend with heuristics.
   * Requirement 13.5: Emit category-specific drift signals via CallbackEngine.
   * Requirement 13.6: Preserve existing DriftMonitor behavior (additive).
   * Requirement 13.7: Zero overhead when disabled.
   */
  classify(evaluation: DriftEvaluationResult, context: ClassificationContext): EnhancedDriftClassification {
    // Null-check guard: zero overhead when disabled (Requirement 13.7)
    if (!this.featureGate.isEnabled('enhanced_drift_classification')) {
      // Return a minimal no-op classification.
      // DriftMonitor continues functioning identically — this is purely additive.
      const noOpSignal = createDriftSignal({
        category: 'confidence_decay',
        severity: 'info',
        currentConfidence: evaluation.confidence,
        message: 'Enhanced drift classification disabled',
        iteration: Math.max(1, context.iteration),
      });

      return {
        category: 'agent-drift',
        confidence: 0,
        baseConfidence: evaluation.confidence,
        heuristics: [],
        recoveryStrategy: this.getStrategy('agent-drift'),
        signal: noOpSignal,
      };
    }

    // Score each category using heuristics (Requirement 13.2)
    const heuristicResults = this.evaluateHeuristics(evaluation, context);

    // Select the category with the highest score
    const bestMatch = this.selectBestCategory(heuristicResults, evaluation.confidence);

    // Compute final confidence for the chosen category
    const categoryThreshold = this.getThreshold(bestMatch.category);
    const confidence = this.computeCategoryConfidence(
      evaluation.confidence,
      bestMatch.score,
    );

    // Determine severity based on category-specific thresholds (Requirement 13.3)
    const severity = confidence <= categoryThreshold.criticalThreshold
      ? 'critical'
      : confidence <= categoryThreshold.warningThreshold
        ? 'warning'
        : 'info';

    // Create drift signal for emission
    const signal = createDriftSignal({
      category: 'confidence_decay',
      severity,
      currentConfidence: confidence,
      message: `Enhanced drift classification: ${bestMatch.category} (confidence: ${confidence.toFixed(3)}, heuristics: ${bestMatch.matchedHeuristics.join(', ')})`,
      iteration: Math.max(1, context.iteration),
    });

    // Get recovery strategy for this category (Requirement 13.4)
    const recoveryStrategy = this.getStrategy(bestMatch.category);

    const result: EnhancedDriftClassification = {
      category: bestMatch.category,
      confidence,
      baseConfidence: evaluation.confidence,
      heuristics: bestMatch.matchedHeuristics,
      recoveryStrategy,
      signal,
    };

    // Emit category-specific drift signal via CallbackEngine (Requirement 13.5)
    this.emitDriftSignal(result, context);

    return result;
  }

  /**
   * Get all configured thresholds.
   * Requirement 13.3: Independent confidence thresholds per category.
   */
  getThresholds(): DriftCategoryThresholds[] {
    return Array.from(this.thresholds.values());
  }

  /**
   * Update threshold for a specific category without affecting others.
   * Requirement 13.3: Each configurable separately.
   */
  updateThreshold(category: EnhancedDriftCategory, update: Partial<DriftCategoryThresholds>): void {
    const existing = this.thresholds.get(category);
    if (!existing) {
      // Create a new entry with reasonable defaults
      this.thresholds.set(category, {
        category,
        warningThreshold: update.warningThreshold ?? 0.5,
        criticalThreshold: update.criticalThreshold ?? 0.3,
      });
      return;
    }

    this.thresholds.set(category, {
      ...existing,
      ...update,
      category, // Ensure category can't be changed
    });
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Evaluate heuristics for each drift category based on the evaluation result
   * and classification context.
   *
   * Requirement 13.2: Extend DriftMonitor confidence with category-specific heuristics.
   */
  private evaluateHeuristics(
    evaluation: DriftEvaluationResult,
    context: ClassificationContext,
  ): HeuristicResult[] {
    const results: HeuristicResult[] = [];

    // ── Agent-drift heuristics ──
    // Agent wandering from task: high iteration count, diverse tool calls, no failures
    {
      let score = 0;
      const matched: string[] = [];

      // High iteration count relative to expected suggests agent is wandering
      if (context.iteration > 10) {
        score += 0.3;
        matched.push('high-iteration-count');
      }

      // Diverse tool calls suggest agent is exploring instead of focused work
      const uniqueTools = new Set(context.recentToolCalls).size;
      if (uniqueTools > 5) {
        score += 0.25;
        matched.push('diverse-tool-usage');
      }

      // Low failures but low confidence suggests drift without errors
      if (context.recentFailures === 0 && evaluation.confidence < 0.5) {
        score += 0.2;
        matched.push('low-failure-low-confidence');
      }

      // DriftMonitor signals containing scope_exceeded boost agent-drift
      const scopeSignals = evaluation.signals.filter((s) => s.category === 'scope_exceeded');
      if (scopeSignals.length > 0) {
        score += 0.25;
        matched.push('scope-exceeded-signals');
      }

      results.push({ category: 'agent-drift', score, matchedHeuristics: matched });
    }

    // ── Test-drift heuristics ──
    // Tests breaking due to code evolution: recent failures from test-related tools
    {
      let score = 0;
      const matched: string[] = [];

      // Test-related tool calls indicate testing activity
      const testTools = context.recentToolCalls.filter(
        (t) => t.includes('test') || t.includes('vitest') || t.includes('jest'),
      );
      if (testTools.length > 0) {
        score += 0.3;
        matched.push('test-related-tools');
      }

      // High failure count in test context
      if (context.recentFailures > 2 && testTools.length > 0) {
        score += 0.3;
        matched.push('repeated-test-failures');
      }

      // DriftMonitor signals containing tool_mismatch during test activity
      const toolMismatch = evaluation.signals.filter((s) => s.category === 'tool_mismatch');
      if (toolMismatch.length > 0 && testTools.length > 0) {
        score += 0.2;
        matched.push('tool-mismatch-during-tests');
      }

      results.push({ category: 'test-drift', score, matchedHeuristics: matched });
    }

    // ── Specification-drift heuristics ──
    // Code diverging from requirements: intent divergence signals, no clear task alignment
    {
      let score = 0;
      const matched: string[] = [];

      // DriftMonitor intent_divergence signals are strong indicators
      const intentSignals = evaluation.signals.filter((s) => s.category === 'intent_divergence');
      if (intentSignals.length > 0) {
        score += 0.4;
        matched.push('intent-divergence-signals');
      }

      // Stale intent signals suggest work has drifted from original spec
      const staleSignals = evaluation.signals.filter((s) => s.category === 'stale_intent');
      if (staleSignals.length > 0) {
        score += 0.3;
        matched.push('stale-intent-signals');
      }

      // Long-running session without checkpoint suggests gradual divergence
      if (context.lastCheckpointAge > 300_000) { // > 5 minutes
        score += 0.15;
        matched.push('stale-checkpoint');
      }

      results.push({ category: 'specification-drift', score, matchedHeuristics: matched });
    }

    // ── Context-drift heuristics ──
    // LLM losing conversation context: long conversations, repeated patterns
    {
      let score = 0;
      const matched: string[] = [];

      // Very long conversations are prone to context loss
      if (context.conversationLength > 50) {
        score += 0.35;
        matched.push('long-conversation');
      }

      // Repeated tool calls (same tool called multiple times in sequence)
      const recentCalls = context.recentToolCalls;
      if (recentCalls.length >= 3) {
        const lastThree = recentCalls.slice(-3);
        if (lastThree[0] === lastThree[1] && lastThree[1] === lastThree[2]) {
          score += 0.3;
          matched.push('repeated-tool-pattern');
        }
      }

      // High iteration count combined with long conversation
      if (context.iteration > 15 && context.conversationLength > 30) {
        score += 0.2;
        matched.push('high-iteration-long-context');
      }

      // Confidence decay without clear scope or intent signals
      const noDirectionalSignals = evaluation.signals.every(
        (s) => s.category === 'confidence_decay',
      );
      if (noDirectionalSignals && evaluation.confidence < 0.4) {
        score += 0.25;
        matched.push('undirected-confidence-decay');
      }

      results.push({ category: 'context-drift', score, matchedHeuristics: matched });
    }

    return results;
  }

  /**
   * Select the best-matching category from heuristic results.
   * If no heuristics triggered, falls back to agent-drift as default.
   */
  private selectBestCategory(
    results: HeuristicResult[],
    _baseConfidence: number,
  ): HeuristicResult {
    // Sort by score descending
    const sorted = [...results].sort((a, b) => b.score - a.score);

    // If no results or the top score is 0 (no heuristics matched), default to agent-drift
    if (sorted.length === 0 || sorted[0]!.score === 0) {
      return {
        category: 'agent-drift',
        score: 0,
        matchedHeuristics: ['default-fallback'],
      };
    }

    return sorted[0]!;
  }

  /**
   * Compute final category confidence by combining base DriftMonitor confidence
   * with heuristic score.
   *
   * The formula blends the base confidence (from DriftMonitor) with the
   * heuristic match strength. A higher heuristic score means the drift
   * is more strongly classified — we invert it to represent "remaining confidence".
   */
  private computeCategoryConfidence(baseConfidence: number, heuristicScore: number): number {
    // Normalize heuristic score to [0, 1] (cap at 1.0)
    const normalizedHeuristic = Math.min(heuristicScore, 1.0);

    // Blend: use base confidence as starting point, reduce further by heuristic match
    // This preserves the DriftMonitor's confidence decay while adding category specificity
    const categoryConfidence = baseConfidence * (1 - normalizedHeuristic * 0.5);

    // Clamp to [0, 1]
    return Math.max(0, Math.min(1, categoryConfidence));
  }

  /**
   * Get the threshold configuration for a category.
   */
  private getThreshold(category: EnhancedDriftCategory): DriftCategoryThresholds {
    return this.thresholds.get(category) ?? {
      category,
      warningThreshold: 0.5,
      criticalThreshold: 0.3,
    };
  }

  /**
   * Get the recovery strategy for a category.
   * Requirement 13.4: Independent recovery strategies per category.
   */
  private getStrategy(category: EnhancedDriftCategory): DriftRecoveryStrategy {
    return this.strategies.get(category) ?? {
      category,
      action: 'pause',
      maxAttempts: 1,
    };
  }

  /**
   * Emit category-specific drift signal via CallbackEngine on-drift-signal event.
   * Requirement 13.5: Emit via CallbackEngine on-drift-signal event.
   */
  private emitDriftSignal(
    classification: EnhancedDriftClassification,
    context: ClassificationContext,
  ): void {
    const hookContext: HookContext = {
      event: 'on-drift-signal' as LifecycleEvent,
      sessionId: context.sessionId,
      iteration: context.iteration,
      driftSignal: classification.signal,
      input: {
        type: 'enhanced-drift-classification',
        category: classification.category,
        confidence: classification.confidence,
        baseConfidence: classification.baseConfidence,
        heuristics: classification.heuristics,
        recoveryStrategy: classification.recoveryStrategy,
      },
    };

    // Fire-and-forget — errors are handled by CallbackEngine internally
    this.callbackEngine.emit(hookContext).catch(() => {
      // Graceful degradation: callback engine failure doesn't interrupt drift classification
    });
  }
}
