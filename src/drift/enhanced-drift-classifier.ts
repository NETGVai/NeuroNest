/**
 * Enhanced Drift Classifier — Interfaces for multi-category drift classification.
 *
 * Extends the base DriftMonitor with fine-grained category classification
 * (agent-drift, test-drift, specification-drift, context-drift), independent
 * confidence thresholds per category, and category-specific recovery strategies.
 *
 * Requirements: 13.1–13.7
 */

import type { DriftEvaluationResult } from './drift-monitor.js';
import type { DriftSignal } from './drift-signal.js';

// ─── Types ──────────────────────────────────────────────────────

/** Extended drift categories */
export type EnhancedDriftCategory =
  | 'agent-drift'          // agent wandering from task
  | 'test-drift'           // tests breaking due to code evolution
  | 'specification-drift'  // code diverging from requirements
  | 'context-drift';       // LLM losing conversation context

/** Category-specific confidence thresholds */
export interface DriftCategoryThresholds {
  category: EnhancedDriftCategory;
  warningThreshold: number;
  criticalThreshold: number;
}

/** Category-specific recovery strategy */
export interface DriftRecoveryStrategy {
  category: EnhancedDriftCategory;
  action: 'reconfirm' | 'fork-and-restart' | 'checkpoint-restore' | 'context-refresh' | 'pause';
  maxAttempts: number;
}

/** Enhanced classification result */
export interface EnhancedDriftClassification {
  category: EnhancedDriftCategory;
  confidence: number;
  baseConfidence: number;      // from DriftMonitor
  heuristics: string[];        // which heuristics triggered
  recoveryStrategy: DriftRecoveryStrategy;
  signal: DriftSignal;
}

/** Configuration for the enhanced classifier */
export interface EnhancedDriftConfig {
  thresholds: DriftCategoryThresholds[];
  strategies: DriftRecoveryStrategy[];
}

/** Enhanced Drift Classifier interface */
export interface IEnhancedDriftClassifier {
  classify(evaluation: DriftEvaluationResult, context: ClassificationContext): EnhancedDriftClassification;
  getThresholds(): DriftCategoryThresholds[];
  updateThreshold(category: EnhancedDriftCategory, thresholds: Partial<DriftCategoryThresholds>): void;
}

export interface ClassificationContext {
  sessionId: string;
  iteration: number;
  recentToolCalls: string[];
  recentFailures: number;
  conversationLength: number;
  lastCheckpointAge: number;   // ms since last checkpoint
}
