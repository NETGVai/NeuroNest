/**
 * DriftIntegration — Wire DriftMonitor, Enhanced Drift Classifier, and Drift-Aware Orchestrator.
 *
 * Connects DriftMonitor confidence signals to the Enhanced Drift Classifier,
 * connects Enhanced Drift Classifier output to the Drift-Aware Orchestrator's
 * `onDriftDetected()`, and ensures both DriftMonitor auto-pause and orchestrator
 * recovery are active simultaneously.
 *
 * Event flow:
 *   DriftMonitor.evaluateConfidence() → on-drift-signal event
 *     → DriftIntegration handler
 *       → EnhancedDriftClassifier.classify()
 *         → DriftAwareOrchestrator.onDriftDetected()
 *
 * The DriftMonitor's own auto-pause behavior (paused=true when confidence ≤ 0.3)
 * is preserved — the orchestrator recovery runs in parallel without disabling it.
 *
 * Requirements: 14.1, 14.2, 14.9, 13.2, 13.5
 */

import type { CallbackEngine, HookContext } from '../pipeline/callback-engine.js';
import type { DriftMonitor, DriftEvaluationResult } from '../drift/drift-monitor.js';
import type { DriftSignal } from '../drift/drift-signal.js';
import type {
  IEnhancedDriftClassifier,
  ClassificationContext,
  EnhancedDriftClassification,
} from '../drift/enhanced-drift-classifier.js';
import type { IDriftAwareOrchestrator } from '../orchestration/drift-aware-orchestrator.js';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Dependencies required to wire the drift integration pipeline.
 */
export interface DriftIntegrationDeps {
  /** The shared CallbackEngine for lifecycle event dispatch. */
  callbackEngine: CallbackEngine;
  /** The existing DriftMonitor instance (auto-pause remains active). */
  driftMonitor: DriftMonitor;
  /** The Enhanced Drift Classifier (categorizes drift signals). */
  enhancedDriftClassifier: IEnhancedDriftClassifier;
  /** The Drift-Aware Orchestrator (triggers recovery on critical drift). */
  driftAwareOrchestrator: IDriftAwareOrchestrator;
  /** Feature gate system for null-check guards. */
  featureGate: FeatureGateSystem;
}

/**
 * Context provider function — supplies session-specific classification context.
 * Callers can provide a function that retrieves real-time context for a given session.
 * When not provided, the integration uses sensible defaults derived from the signal.
 */
export type ClassificationContextProvider = (
  sessionId: string,
  signal: DriftSignal,
) => ClassificationContext;

/**
 * Configuration options for the drift integration.
 */
export interface DriftIntegrationConfig {
  /**
   * Optional provider for classification context.
   * If not supplied, a default context is synthesized from the drift signal.
   */
  contextProvider?: ClassificationContextProvider;
}

// ─── Default Context Provider ───────────────────────────────────

/**
 * Creates a minimal ClassificationContext when no provider is configured.
 * Uses the drift signal metadata to populate available fields.
 */
function defaultContextProvider(sessionId: string, signal: DriftSignal): ClassificationContext {
  return {
    sessionId,
    iteration: signal.iteration,
    recentToolCalls: [],
    recentFailures: 0,
    conversationLength: 0,
    lastCheckpointAge: 0,
  };
}

// ─── DriftIntegration ───────────────────────────────────────────

/**
 * Wires the drift subsystems together via CallbackEngine event handlers.
 *
 * Lifecycle:
 *   1. Call `wire()` to register the on-drift-signal handler on CallbackEngine.
 *   2. DriftMonitor emits drift signals (confidence decay, scope violations, etc.).
 *   3. The handler classifies the signal via EnhancedDriftClassifier.
 *   4. If classification indicates critical drift, the handler invokes
 *      DriftAwareOrchestrator.onDriftDetected() to trigger recovery.
 *   5. DriftMonitor's auto-pause (paused=true) remains independently active —
 *      the orchestrator's recovery is additive, not a replacement.
 *
 * Call `teardown()` to unregister all handlers (useful for testing and session cleanup).
 */
export class DriftIntegration {
  private readonly deps: DriftIntegrationDeps;
  private readonly contextProvider: ClassificationContextProvider;
  private boundHandler: ((ctx: HookContext) => Promise<void>) | null = null;
  private wired = false;

  constructor(deps: DriftIntegrationDeps, config?: DriftIntegrationConfig) {
    this.deps = deps;
    this.contextProvider = config?.contextProvider ?? defaultContextProvider;
  }

  /**
   * Register the integration handler on the CallbackEngine's `on-drift-signal` event.
   *
   * After wiring, every drift signal emitted by DriftMonitor flows through
   * the Enhanced Drift Classifier and into the Drift-Aware Orchestrator.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   *
   * Requirements: 13.2, 13.5, 14.1, 14.9
   */
  wire(): void {
    if (this.wired) return;

    this.boundHandler = this.handleDriftSignal.bind(this);
    this.deps.callbackEngine.register('on-drift-signal', this.boundHandler);
    this.wired = true;
  }

  /**
   * Unregister the integration handler from CallbackEngine.
   *
   * After teardown, DriftMonitor continues functioning independently
   * (auto-pause intact), but classification and recovery are disconnected.
   */
  teardown(): void {
    if (!this.wired || !this.boundHandler) return;

    this.deps.callbackEngine.unregister('on-drift-signal', this.boundHandler);
    this.boundHandler = null;
    this.wired = false;
  }

  /**
   * Check if the integration is currently wired and active.
   */
  isWired(): boolean {
    return this.wired;
  }

  // ─── Private Handler ──────────────────────────────────────────

  /**
   * Core handler: receives on-drift-signal events from DriftMonitor,
   * classifies via EnhancedDriftClassifier, and triggers orchestrator recovery.
   *
   * Guard chain:
   *   1. Feature gate check — both enhanced_drift_classification and
   *      drift_aware_orchestration must be enabled.
   *   2. Signal validation — must have a valid drift signal.
   *   3. Avoid re-entrance — skip signals originating from the classifier or
   *      orchestrator itself (identified by input.type prefix).
   *
   * Requirements: 13.2, 14.1, 14.2, 14.9
   */
  private async handleDriftSignal(context: HookContext): Promise<void> {
    // Guard: feature gates must be enabled
    if (
      !this.deps.featureGate.isEnabled('enhanced_drift_classification') ||
      !this.deps.featureGate.isEnabled('drift_aware_orchestration')
    ) {
      return;
    }

    // Guard: must have a drift signal
    const signal = context.driftSignal ?? (context.input as DriftSignal | undefined);
    if (!signal || !signal.signalId) {
      return;
    }

    // Guard: skip signals emitted by the classifier or orchestrator themselves
    // to prevent infinite re-entrance loops.
    const inputPayload = context.input as Record<string, unknown> | undefined;
    if (inputPayload && typeof inputPayload['type'] === 'string') {
      const originType = inputPayload['type'];
      if (
        originType === 'enhanced-drift-classification' ||
        originType.startsWith('drift-recovery')
      ) {
        return;
      }
    }

    // Build DriftEvaluationResult from the signal context
    const evaluation: DriftEvaluationResult = {
      confidence: signal.currentConfidence,
      signals: [signal],
      paused: signal.severity === 'critical' && signal.currentConfidence <= 0.3,
    };

    // Derive session ID from HookContext (if available)
    const sessionId = context.sessionId || 'unknown';

    // Build classification context
    const classificationContext = this.contextProvider(sessionId, signal);

    // Step 1: Classify via Enhanced Drift Classifier (Req 13.2)
    let classification: EnhancedDriftClassification;
    try {
      classification = this.deps.enhancedDriftClassifier.classify(
        evaluation,
        classificationContext,
      );
    } catch {
      // Classification failure should not break the pipeline.
      // DriftMonitor auto-pause remains active regardless.
      return;
    }

    // Step 2: Forward to Drift-Aware Orchestrator (Req 14.1, 14.2)
    // The orchestrator internally checks confidence threshold and recovery limits.
    // DriftMonitor's own auto-pause (paused flag) is unaffected — it operates
    // independently via the paused return value from evaluateConfidence().
    try {
      await this.deps.driftAwareOrchestrator.onDriftDetected(classification, sessionId);
    } catch {
      // Orchestrator failure should not break the pipeline.
      // DriftMonitor auto-pause remains active regardless.
    }
  }
}
