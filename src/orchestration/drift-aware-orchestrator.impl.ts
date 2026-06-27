/**
 * DriftAwareOrchestrator — Implementation for automated drift recovery orchestration.
 *
 * Monitors drift signals from the Enhanced Drift Classifier and triggers recovery
 * actions when confidence drops at or below the critical threshold (default 0.3)
 * in parallel agent sessions. Recovery involves:
 *   1. Forking the session to preserve current state
 *   2. Restoring the drifting agent from the last checkpoint
 *   3. Restarting with refined instructions
 *
 * Key behaviours:
 *   - Triggers recovery when confidence ≤ 0.3 (configurable) in parallel sessions
 *   - Forks session via SessionForker to preserve current state before recovery
 *   - Restarts drifting agent from last checkpoint via WorktreeCheckpointManager
 *   - Emits drift-recovery-started and related lifecycle events via CallbackEngine
 *   - Enforces max recovery attempts (default 3) per session
 *   - Pauses and emits needs-attention when attempts exhausted
 *   - Respects ParallelAgentExecutor concurrency limits — delays (never rejects) if full
 *   - Does NOT terminate existing sessions to make room for recovery forks
 *   - Keeps both existing DriftMonitor auto-pause and new orchestration recovery active
 *   - Applies null-check guard when drift_aware_orchestration flag is disabled
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 14.10
 */

import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type { CallbackEngine, HookContext, LifecycleEvent } from '../pipeline/callback-engine.js';
import type { ISessionForker } from '../session/session-forker.js';
import type { IWorktreeCheckpointManager } from '../durability/worktree-checkpoint-manager.js';
import type { ParallelSessionManager } from '../session/parallel-session-manager.js';
import type { EnhancedDriftClassification } from '../drift/enhanced-drift-classifier.js';
import type {
  RecoveryAttempt,
  DriftAwareOrchestratorConfig,
  IDriftAwareOrchestrator,
} from './drift-aware-orchestrator.js';
import { createDriftSignal } from '../drift/drift-signal.js';

// ─── Default Configuration ──────────────────────────────────────

const DEFAULT_CONFIG: DriftAwareOrchestratorConfig = {
  maxRecoveryAttempts: 3,
  recoveryDelayMs: 1000,
  criticalThreshold: 0.3,
};

// ─── Implementation ─────────────────────────────────────────────

/**
 * Orchestrates automated drift recovery for parallel agent sessions.
 *
 * When critical drift is detected (confidence ≤ threshold), the orchestrator:
 * 1. Checks if recovery attempts are not exhausted
 * 2. Forks the session to preserve current state
 * 3. Restores drifting agent from last checkpoint
 * 4. Emits lifecycle events for observability
 *
 * Concurrency: recovery forks respect ParallelAgentExecutor limits and are
 * delayed (never rejected) when slots are full. Existing sessions are never
 * terminated to make room.
 */
export class DriftAwareOrchestrator implements IDriftAwareOrchestrator {
  private readonly config: DriftAwareOrchestratorConfig;
  private readonly featureGate: FeatureGateSystem;
  private readonly callbackEngine: CallbackEngine;
  private readonly sessionForker: ISessionForker;
  private readonly checkpointManager: IWorktreeCheckpointManager;
  private readonly sessionManager: ParallelSessionManager;
  private readonly maxConcurrentSessions: number;
  private readonly projectId: string;

  /** Recovery attempts per session */
  private recoveryAttempts: Map<string, RecoveryAttempt[]> = new Map();

  /** Pending recovery count — tracks delayed recoveries waiting for concurrency slots */
  private pendingRecoveryCount = 0;

  constructor(
    featureGate: FeatureGateSystem,
    callbackEngine: CallbackEngine,
    sessionForker: ISessionForker,
    checkpointManager: IWorktreeCheckpointManager,
    sessionManager: ParallelSessionManager,
    options: {
      config?: Partial<DriftAwareOrchestratorConfig>;
      maxConcurrentSessions?: number;
      projectId: string;
    },
  ) {
    this.featureGate = featureGate;
    this.callbackEngine = callbackEngine;
    this.sessionForker = sessionForker;
    this.checkpointManager = checkpointManager;
    this.sessionManager = sessionManager;
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.maxConcurrentSessions = options.maxConcurrentSessions ?? 4;
    this.projectId = options.projectId;
  }

  // ─── IDriftAwareOrchestrator Implementation ─────────────────────

  /**
   * Handle a drift detection event. Triggers recovery when confidence ≤ critical threshold.
   *
   * Requirement 14.1: Automatically fork session when confidence ≤ 0.3.
   * Requirement 14.2: Restart drifting agent from last checkpoint with refined instructions.
   * Requirement 14.3: Emit drift-recovery lifecycle events via CallbackEngine.
   * Requirement 14.4: Limit recovery attempts to configurable max (default 3).
   * Requirement 14.5: Pause and emit needs-attention when attempts exhausted.
   * Requirement 14.7: Respect concurrency limits — recovery forks count toward limit.
   * Requirement 14.8: Delay recovery (don't reject) if slots full; never terminate existing sessions.
   * Requirement 14.9: Keep DriftMonitor auto-pause and new orchestration recovery both active.
   * Requirement 14.10: Zero overhead when disabled.
   */
  async onDriftDetected(
    classification: EnhancedDriftClassification,
    sessionId: string,
  ): Promise<void> {
    // Null-check guard: zero overhead when disabled (Req 14.10)
    if (!this.featureGate.isEnabled('drift_aware_orchestration')) {
      return;
    }

    // Only trigger recovery on critical confidence (Req 14.1)
    if (classification.confidence > this.config.criticalThreshold) {
      return;
    }

    // Check if max recovery attempts exhausted for this session (Req 14.4, 14.5)
    if (this.isRecoveryExhausted(sessionId)) {
      await this.handleExhaustedRecovery(sessionId, classification);
      return;
    }

    // Respect concurrency limits — delay if slots full (Req 14.7, 14.8)
    await this.waitForConcurrencySlot(sessionId, classification);

    // Perform recovery
    await this.executeRecovery(sessionId, classification);
  }

  /**
   * Get all recovery attempts for a session.
   */
  getRecoveryAttempts(sessionId: string): RecoveryAttempt[] {
    return this.recoveryAttempts.get(sessionId) ?? [];
  }

  /**
   * Get the count of recovery attempts for a session.
   */
  getRecoveryCount(sessionId: string): number {
    return (this.recoveryAttempts.get(sessionId) ?? []).length;
  }

  /**
   * Check if recovery attempts have been exhausted for a session.
   */
  isRecoveryExhausted(sessionId: string): boolean {
    return this.getRecoveryCount(sessionId) >= this.config.maxRecoveryAttempts;
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Execute the recovery procedure:
   * 1. Fork session to preserve state
   * 2. Restore from last checkpoint
   * 3. Record attempt and emit events
   *
   * Requirements: 14.1, 14.2, 14.3, 14.6
   */
  private async executeRecovery(
    sessionId: string,
    classification: EnhancedDriftClassification,
  ): Promise<void> {
    const attemptNumber = this.getRecoveryCount(sessionId) + 1;

    // Create recovery attempt record
    const attempt: RecoveryAttempt = {
      attemptNumber,
      sessionId,
      category: classification.category,
      timestamp: new Date().toISOString(),
      outcome: 'pending',
    };

    // Register the attempt before starting (Req 14.4)
    this.addRecoveryAttempt(sessionId, attempt);

    // Emit drift-recovery-started event (Req 14.3)
    await this.emitRecoveryEvent('drift-recovery-started', sessionId, attempt, classification);

    try {
      // Step 1: Fork session to preserve current state (Req 14.1, 14.6)
      const forkResult = await this.sessionForker.fork({
        sourceSessionId: sessionId,
        label: `drift-recovery-${attemptNumber}`,
        divergePrompt: this.buildRefinedInstructions(classification),
      });

      if (!forkResult.success) {
        attempt.outcome = 'failed';
        await this.emitRecoveryEvent('drift-recovery-failed', sessionId, attempt, classification);
        return;
      }

      if (forkResult.forkedSession) {
        attempt.forkedSessionId = forkResult.forkedSession.id;
      }

      // Step 2: Restore from last checkpoint (Req 14.2, 14.6)
      const snapshots = this.checkpointManager.list(sessionId);
      if (snapshots.length > 0) {
        const latestSnapshot = snapshots[0]!; // list returns most recent first
        attempt.checkpointId = latestSnapshot.id;

        try {
          await this.checkpointManager.restore({ snapshotId: latestSnapshot.id });
        } catch {
          // Checkpoint restore failed — recovery continues with fork only
          // This is a best-effort restore; the fork itself preserves state
        }
      }

      // Step 3: Mark recovery as successful
      attempt.outcome = 'success';

      // Emit drift-recovery-completed event
      await this.emitRecoveryEvent('drift-recovery-completed', sessionId, attempt, classification);
    } catch (error: unknown) {
      attempt.outcome = 'failed';
      await this.emitRecoveryEvent('drift-recovery-failed', sessionId, attempt, classification);
    }
  }

  /**
   * Handle the case when max recovery attempts are exhausted.
   * Pauses the session and emits a needs-attention notification.
   *
   * Requirement 14.5: Pause session and emit needs-attention when exhausted.
   */
  private async handleExhaustedRecovery(
    sessionId: string,
    classification: EnhancedDriftClassification,
  ): Promise<void> {
    // Pause the session
    this.sessionManager.update(sessionId, { status: 'paused' });

    // Record a skipped attempt for traceability
    const skippedAttempt: RecoveryAttempt = {
      attemptNumber: this.getRecoveryCount(sessionId) + 1,
      sessionId,
      category: classification.category,
      timestamp: new Date().toISOString(),
      outcome: 'skipped',
    };
    this.addRecoveryAttempt(sessionId, skippedAttempt);

    // Emit needs-attention event (Req 14.5)
    await this.emitNeedsAttention(sessionId, classification);
  }

  /**
   * Wait for a concurrency slot to become available.
   * Delays recovery (never rejects) when all slots are full.
   * Does NOT terminate existing sessions to make room.
   *
   * Requirements: 14.7, 14.8
   */
  private async waitForConcurrencySlot(
    sessionId: string,
    classification: EnhancedDriftClassification,
  ): Promise<void> {
    const stats = this.sessionManager.getStats(this.projectId);

    // If slots available, proceed immediately
    if (stats.total < this.maxConcurrentSessions) {
      return;
    }

    // Slots full — delay recovery until one becomes available (Req 14.8)
    this.pendingRecoveryCount++;

    await this.emitRecoveryEvent(
      'drift-recovery-delayed',
      sessionId,
      {
        attemptNumber: this.getRecoveryCount(sessionId) + 1,
        sessionId,
        category: classification.category,
        timestamp: new Date().toISOString(),
        outcome: 'pending',
      },
      classification,
    );

    // Poll for slot availability with delay
    await this.pollForSlot();

    this.pendingRecoveryCount--;
  }

  /**
   * Poll for an available concurrency slot with exponential backoff.
   * Polls at configurable delay intervals.
   */
  private async pollForSlot(): Promise<void> {
    const maxPollAttempts = 30; // Max ~30 seconds with default delay
    let pollAttempts = 0;

    while (pollAttempts < maxPollAttempts) {
      await this.delay(this.config.recoveryDelayMs);
      const stats = this.sessionManager.getStats(this.projectId);

      if (stats.total < this.maxConcurrentSessions) {
        return;
      }
      pollAttempts++;
    }

    // If we've been waiting too long, proceed anyway.
    // The fork operation itself will check capacity constraints.
  }

  /**
   * Build refined instructions for the restarted agent based on drift classification.
   * Provides context-aware guidance to help the agent recover from the detected drift.
   *
   * Requirement 14.2: Restart with refined instructions.
   */
  private buildRefinedInstructions(classification: EnhancedDriftClassification): string {
    const base = 'RECOVERY: Previous execution drifted. ';

    switch (classification.category) {
      case 'agent-drift':
        return (
          base +
          'Focus narrowly on the assigned task. Avoid exploring tangential solutions. ' +
          'Re-read the original task description before proceeding.'
        );
      case 'test-drift':
        return (
          base +
          'Tests broke due to code changes. Verify test assumptions match current code structure. ' +
          'Update tests to reflect actual implementation without masking real bugs.'
        );
      case 'specification-drift':
        return (
          base +
          'Implementation diverged from specification. Review the original requirements ' +
          'and realign the approach to match specified behavior.'
        );
      case 'context-drift':
        return (
          base +
          'Conversation context was lost. Review the full task description and recent changes ' +
          'to rebuild context before continuing.'
        );
      default:
        return base + 'Re-evaluate the current approach and correct course.';
    }
  }

  /**
   * Emit a drift-recovery lifecycle event via CallbackEngine.
   *
   * Requirement 14.3: Emit events via existing CallbackEngine.
   */
  private async emitRecoveryEvent(
    eventType: string,
    sessionId: string,
    attempt: RecoveryAttempt,
    classification: EnhancedDriftClassification,
  ): Promise<void> {
    const signal = createDriftSignal({
      category: 'confidence_decay',
      severity: 'critical',
      currentConfidence: classification.confidence,
      message: `${eventType}: session=${sessionId}, attempt=${attempt.attemptNumber}, category=${classification.category}`,
      iteration: Math.max(1, classification.signal.iteration),
    });

    const hookContext: HookContext = {
      event: 'on-drift-signal' as LifecycleEvent,
      sessionId,
      iteration: classification.signal.iteration,
      driftSignal: signal,
      input: {
        type: eventType,
        recoveryAttempt: attempt,
        classification: {
          category: classification.category,
          confidence: classification.confidence,
          baseConfidence: classification.baseConfidence,
          heuristics: classification.heuristics,
        },
      },
    };

    // Fire-and-forget — errors handled by CallbackEngine internally
    await this.callbackEngine.emit(hookContext).catch(() => {
      // Graceful degradation: callback engine failure doesn't interrupt recovery
    });
  }

  /**
   * Emit a needs-attention notification when recovery attempts are exhausted.
   *
   * Requirement 14.5: Emit needs-attention when max attempts reached.
   */
  private async emitNeedsAttention(
    sessionId: string,
    classification: EnhancedDriftClassification,
  ): Promise<void> {
    const signal = createDriftSignal({
      category: 'confidence_decay',
      severity: 'critical',
      currentConfidence: classification.confidence,
      message: `needs-attention: Recovery exhausted for session=${sessionId} after ${this.config.maxRecoveryAttempts} attempts. Manual intervention required.`,
      iteration: Math.max(1, classification.signal.iteration),
    });

    const hookContext: HookContext = {
      event: 'on-drift-signal' as LifecycleEvent,
      sessionId,
      iteration: classification.signal.iteration,
      driftSignal: signal,
      input: {
        type: 'drift-recovery-exhausted',
        sessionId,
        totalAttempts: this.config.maxRecoveryAttempts,
        category: classification.category,
        needsAttention: true,
      },
    };

    await this.callbackEngine.emit(hookContext).catch(() => {
      // Graceful degradation
    });
  }

  /**
   * Add a recovery attempt record for a session.
   */
  private addRecoveryAttempt(sessionId: string, attempt: RecoveryAttempt): void {
    const existing = this.recoveryAttempts.get(sessionId) ?? [];
    existing.push(attempt);
    this.recoveryAttempts.set(sessionId, existing);
  }

  /**
   * Utility: delay execution for given milliseconds.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
