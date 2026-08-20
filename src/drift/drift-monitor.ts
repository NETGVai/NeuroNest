/**
 * DriftMonitor — Coordinator for AuthR drift management.
 *
 * Orchestrates intent anchoring, confidence decay evaluation, scope validation,
 * signal deduplication, and dispatch through CallbackEngine and IPC.
 *
 * All drift features are opt-in. The monitor is initialized once per agent execution
 * and evaluated per iteration. Signals are deduplicated: at most one warning and one
 * critical signal per threshold crossing, and stale_intent signals emit exactly once
 * at staleAfter and once at 2× staleAfter.
 *
 * Requirements: 1.1, 1.5, 2.7, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.4, 4.5, 4.6,
 *              6.3, 6.4, 6.5, 6.7, 7.6, 7.7
 */

import type { CallbackEngine, HookContext, LifecycleEvent } from '../pipeline/callback-engine.js';
import type { TaskClassification } from '../shared/feature-integration-types.js';

import {
  resolveDriftParams,
  validateDriftConfig,
  type DriftConfig,
  type ResolvedDriftParams,
} from './drift-config.js';
import {
  computeConfidence,
  type ConfidenceInputs,
} from './confidence-model.js';
import {
  createScopeEnvelope,
  validateToolScope,
  validatePathScope,
  type ScopeEnvelope,
} from './scope-envelope.js';
import {
  createIntentAnchor,
  type IntentAnchor,
  STALE_AFTER_SECONDS,
  EXPECTED_ITERATIONS,
} from './intent-anchor.js';
import {
  createDriftSignal,
  type DriftSignal,
} from './drift-signal.js';
export type { DriftSignal };

// ─── Interfaces ─────────────────────────────────────────────────

export interface DriftMonitorDeps {
  callbackEngine: CallbackEngine | null;
  ipcSend?: (channel: string, data: unknown) => void;
  registeredTools: readonly string[];
}

export interface DriftEvaluationResult {
  confidence: number;
  signals: DriftSignal[];
  paused: boolean;
}

export interface ScopeCheckResult {
  blocked: boolean;
  penalty: number;
  signal?: DriftSignal;
  error?: string;
}

export interface DriftDashboardState {
  active: boolean;
  confidence: number;
  thresholds: {
    warning: number;
    critical: number;
  };
  signals: DriftSignal[];
  scope: {
    toolsUsed: number;
    toolsAllowed: number;
    pathsModified: number;
    pathsAllowed: number;
  };
  staleCountdownMs: number;
  anchor: {
    purpose: string;
    statement: string;
    createdAt: string;
  } | null;
}

// ─── Deduplication Tracking ─────────────────────────────────────

interface DeduplicationState {
  warningEmitted: boolean;
  criticalEmitted: boolean;
  staleWarningEmitted: boolean;
  staleCriticalEmitted: boolean;
}

// ─── DriftMonitor Class ─────────────────────────────────────────

export class DriftMonitor {
  private readonly config: DriftConfig;
  private readonly params: ResolvedDriftParams;
  private readonly deps: DriftMonitorDeps;

  private anchor: IntentAnchor | null = null;
  private scopeEnvelope: ScopeEnvelope | null = null;
  private currentConfidence: number = 1.0;
  private consecutiveFailures: number = 0;
  private outOfScopeToolCalls: number = 0;
  private active: boolean = true;
  private initialized: boolean = false;
  private lastIteration: number = 0;

  private emittedSignals: DriftSignal[] = [];
  private toolsUsed: Set<string> = new Set();
  private pathsModified: Set<string> = new Set();

  private dedup: DeduplicationState = {
    warningEmitted: false,
    criticalEmitted: false,
    staleWarningEmitted: false,
    staleCriticalEmitted: false,
  };

  constructor(config: DriftConfig, deps: DriftMonitorDeps) {
    validateDriftConfig(config);
    this.config = config;
    this.params = resolveDriftParams(config);
    this.deps = deps;
  }

  /**
   * Initialize the monitor at execution start.
   * Creates IntentAnchor and ScopeEnvelope. Called once.
   */
  initialize(classification: TaskClassification, message: string): void {
    const staleAfterMs = this.config.staleAfterOverrideMs
      ?? (STALE_AFTER_SECONDS[classification.type] * 1000);

    this.anchor = createIntentAnchor({
      classification,
      message,
      registeredTools: this.deps.registeredTools,
      staleAfterMs,
    });

    this.scopeEnvelope = createScopeEnvelope(this.anchor.predictedScope);
    this.currentConfidence = 1.0;
    this.consecutiveFailures = 0;
    this.outOfScopeToolCalls = 0;
    this.emittedSignals = [];
    this.toolsUsed = new Set();
    this.pathsModified = new Set();
    this.lastIteration = 0;
    this.active = true;
    this.initialized = true;

    this.dedup = {
      warningEmitted: false,
      criticalEmitted: false,
      staleWarningEmitted: false,
      staleCriticalEmitted: false,
    };
  }

  /**
   * Evaluate confidence at current iteration. Called per iteration.
   * Returns current confidence, any new signals, and whether to pause.
   */
  evaluateConfidence(iteration: number, elapsedMs: number): DriftEvaluationResult {
    if (!this.initialized || !this.anchor) {
      return { confidence: 1.0, signals: [], paused: false };
    }

    this.lastIteration = iteration;

    const staleAfterMs = this.config.staleAfterOverrideMs
      ?? (STALE_AFTER_SECONDS[this.anchor.purpose] * 1000);
    const expectedIterations = EXPECTED_ITERATIONS[this.anchor.purpose];

    const inputs: ConfidenceInputs = {
      elapsedMs,
      staleAfterMs,
      currentIteration: iteration,
      expectedIterations,
      outOfScopeToolCalls: this.outOfScopeToolCalls,
      consecutiveFailures: this.consecutiveFailures,
    };

    const state = computeConfidence(inputs, {
      toolMismatchPenalty: this.params.toolMismatchPenalty,
      failurePenalty: this.params.failurePenalty,
    });

    this.currentConfidence = state.currentScore;

    const signals: DriftSignal[] = [];

    // Check confidence threshold crossings with deduplication
    if (this.currentConfidence <= this.params.criticalThreshold && !this.dedup.criticalEmitted) {
      const signal = createDriftSignal({
        category: 'confidence_decay',
        severity: 'critical',
        currentConfidence: this.currentConfidence,
        message: `Confidence dropped to ${this.currentConfidence.toFixed(3)} (below critical threshold ${this.params.criticalThreshold})`,
        iteration,
      });
      signals.push(signal);
      this.dedup.criticalEmitted = true;
    } else if (
      this.currentConfidence <= this.params.warningThreshold &&
      this.currentConfidence > this.params.criticalThreshold &&
      !this.dedup.warningEmitted
    ) {
      const signal = createDriftSignal({
        category: 'confidence_decay',
        severity: 'warning',
        currentConfidence: this.currentConfidence,
        message: `Confidence dropped to ${this.currentConfidence.toFixed(3)} (below warning threshold ${this.params.warningThreshold})`,
        iteration,
      });
      signals.push(signal);
      this.dedup.warningEmitted = true;
    }

    // Check stale intent detection
    const now = Date.now();
    const staleAfterTimestamp = this.anchor.staleAfter;
    const doubleStaleTimestamp = this.anchor.createdAt + (staleAfterMs * 2);

    if (now >= doubleStaleTimestamp && !this.dedup.staleCriticalEmitted) {
      const signal = createDriftSignal({
        category: 'stale_intent',
        severity: 'critical',
        currentConfidence: this.currentConfidence,
        message: `Intent anchor is critically stale (elapsed exceeds 2× staleAfter duration)`,
        iteration,
      });
      signals.push(signal);
      this.dedup.staleCriticalEmitted = true;
    } else if (now >= staleAfterTimestamp && !this.dedup.staleWarningEmitted) {
      const signal = createDriftSignal({
        category: 'stale_intent',
        severity: 'warning',
        currentConfidence: this.currentConfidence,
        message: `Intent anchor is stale (elapsed exceeds staleAfter duration)`,
        iteration,
      });
      signals.push(signal);
      this.dedup.staleWarningEmitted = true;
    }

    // Dispatch all signals
    for (const signal of signals) {
      this.dispatchSignal(signal);
      this.emittedSignals.push(signal);
    }

    // Determine if execution should pause
    const paused = this.params.driftPauseOnCritical && this.currentConfidence <= 0.3;

    return {
      confidence: this.currentConfidence,
      signals,
      paused,
    };
  }

  /**
   * Validate a tool call against scope. Called before each tool execution.
   */
  validateScope(toolName: string, filePath?: string): ScopeCheckResult {
    if (!this.initialized || !this.scopeEnvelope) {
      return { blocked: false, penalty: 0 };
    }

    this.toolsUsed.add(toolName);

    // Validate tool name against scope
    const toolResult = validateToolScope(toolName, this.scopeEnvelope);
    if (!toolResult.allowed) {
      return this.handleScopeViolation(toolName, 'tool', toolName);
    }

    // Validate file path against scope (if provided)
    if (filePath) {
      this.pathsModified.add(filePath);
      const pathResult = validatePathScope(filePath, this.scopeEnvelope);
      if (!pathResult.allowed) {
        return this.handleScopeViolation(toolName, 'path', filePath);
      }
    } else if (filePath === undefined) {
      // No path to validate — tool is allowed
    }

    return { blocked: false, penalty: 0 };
  }

  /**
   * Record a tool execution result. Tool scope and generic execution outcomes
   * share the same consecutive-failure component of the confidence model.
   */
  recordToolResult(_toolName: string, success: boolean): void {
    this.recordOutcome(success);
  }

  /** Record a truthful non-tool execution outcome (phase, task, or agent). */
  recordOutcome(success: boolean): void {
    if (!this.initialized || !this.active) return;
    if (success) {
      this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures += 1;
    }
  }

  /**
   * Stop monitoring and return an immutable final dashboard snapshot.
   * Idempotent so abort, error, and normal-completion paths can converge.
   */
  stop(): DriftDashboardState {
    this.active = false;
    return this.getState();
  }

  /**
   * Handle user re-confirmation. Resets or creates new anchor.
   */
  reconfirm(updatedStatement?: string): void {
    if (updatedStatement && updatedStatement.trim().length > 0) {
      // Re-confirmation with updated statement: reset to 1.0
      if (this.anchor) {
        // Create a new anchor with the updated statement, keeping the same classification
        const staleAfterMs = this.config.staleAfterOverrideMs
          ?? (STALE_AFTER_SECONDS[this.anchor.purpose] * 1000);

        const classification: TaskClassification = {
          type: this.anchor.purpose,
          confidence: 1.0, // Re-confirmation means high confidence
        };

        this.anchor = createIntentAnchor({
          classification,
          message: updatedStatement,
          registeredTools: this.deps.registeredTools,
          staleAfterMs,
        });

        this.scopeEnvelope = createScopeEnvelope(this.anchor.predictedScope);
      }
      this.currentConfidence = 1.0;
    } else {
      // Re-confirmation without updated statement: reset to 0.8
      this.currentConfidence = 0.8;
    }

    // Reset deduplication state so thresholds can fire again
    this.dedup = {
      warningEmitted: false,
      criticalEmitted: false,
      staleWarningEmitted: false,
      staleCriticalEmitted: false,
    };
  }

  /**
   * Get current state for dashboard rendering.
   */
  getState(): DriftDashboardState {
    if (!this.initialized || !this.anchor) {
      return {
        active: false,
        confidence: 1.0,
        thresholds: {
          warning: this.params.warningThreshold,
          critical: this.params.criticalThreshold,
        },
        signals: [],
        scope: {
          toolsUsed: 0,
          toolsAllowed: 0,
          pathsModified: 0,
          pathsAllowed: 0,
        },
        staleCountdownMs: 0,
        anchor: null,
      };
    }

    const now = Date.now();
    const staleCountdownMs = Math.max(0, this.anchor.staleAfter - now);

    return {
      active: this.active,
      confidence: this.currentConfidence,
      thresholds: {
        warning: this.params.warningThreshold,
        critical: this.params.criticalThreshold,
      },
      signals: [...this.emittedSignals],
      scope: {
        toolsUsed: this.toolsUsed.size,
        toolsAllowed: this.scopeEnvelope?.allowedTools.length ?? 0,
        pathsModified: this.pathsModified.size,
        pathsAllowed: this.scopeEnvelope?.allowedPaths.length ?? 0,
      },
      staleCountdownMs,
      anchor: {
        purpose: this.anchor.purpose,
        statement: this.anchor.statement,
        createdAt: new Date(this.anchor.createdAt).toISOString(),
      },
    };
  }

  /**
   * Get the IntentAnchor (readonly).
   */
  getAnchor(): Readonly<IntentAnchor> | null {
    return this.anchor;
  }

  /**
   * Check if the monitor is still active (not disabled by error).
   */
  isActive(): boolean {
    return this.active && this.initialized;
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Handle a scope violation in either warn or block mode.
   */
  private handleScopeViolation(
    toolName: string,
    violationType: 'tool' | 'path',
    violationValue: string
  ): ScopeCheckResult {
    const iteration = this.lastIteration;

    if (this.params.scopeViolationMode === 'block') {
      const signal = createDriftSignal({
        category: 'scope_exceeded',
        severity: 'critical',
        currentConfidence: this.currentConfidence,
        message: `Scope violation (${violationType}): "${violationValue}" is not in the allowed scope. Tool call blocked.`,
        iteration: Math.max(1, iteration),
      });

      this.dispatchSignal(signal);
      this.emittedSignals.push(signal);

      return {
        blocked: true,
        penalty: 0,
        signal,
        error: `Tool call "${toolName}" blocked: ${violationType} "${violationValue}" exceeds scope envelope.`,
      };
    }

    // Warn mode: allow the tool call, apply penalty, emit warning
    this.outOfScopeToolCalls += 1;

    const signal = createDriftSignal({
      category: 'scope_exceeded',
      severity: 'warning',
      currentConfidence: this.currentConfidence,
      message: `Scope violation (${violationType}): "${violationValue}" is not in the allowed scope. Applying 0.15 penalty.`,
      iteration: Math.max(1, iteration),
    });

    this.dispatchSignal(signal);
    this.emittedSignals.push(signal);

    return {
      blocked: false,
      penalty: 0.15,
      signal,
    };
  }

  /**
   * Dispatch a drift signal through CallbackEngine and (for critical) IPC.
   */
  private dispatchSignal(signal: DriftSignal): void {
    // Dispatch via CallbackEngine
    if (this.deps.callbackEngine) {
      const context: HookContext = {
        event: 'on-drift-signal' as LifecycleEvent,
        sessionId: '',
        iteration: signal.iteration,
        input: signal,
      };

      // Fire-and-forget: emit is async but we don't await to stay within 5ms budget
      this.deps.callbackEngine.emit(context).catch(() => {
        // Graceful degradation: callback engine failure doesn't interrupt drift monitoring
      });
    }

    // Dispatch critical signals via IPC to renderer
    if (signal.severity === 'critical' && this.deps.ipcSend) {
      try {
        this.deps.ipcSend('drift:signal', signal);
      } catch {
        // Graceful degradation: IPC failure doesn't interrupt drift monitoring
      }
    }
  }
}
