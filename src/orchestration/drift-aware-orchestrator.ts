/**
 * Drift-Aware Orchestrator — Interfaces for automated drift recovery orchestration.
 *
 * Monitors drift signals and triggers recovery actions (session forking, checkpoint
 * restore, agent restart) when confidence drops below critical thresholds in parallel
 * agent sessions. Enforces max recovery attempts and respects concurrency limits.
 *
 * Requirements: 14.1–14.10
 */

import type { EnhancedDriftClassification, EnhancedDriftCategory } from '../drift/enhanced-drift-classifier.js';

// ─── Types ──────────────────────────────────────────────────────

/** Recovery attempt record */
export interface RecoveryAttempt {
  attemptNumber: number;
  sessionId: string;
  forkedSessionId?: string;
  checkpointId?: string;
  category: EnhancedDriftCategory;
  timestamp: string;
  outcome: 'pending' | 'success' | 'failed' | 'skipped';
}

/** Orchestrator configuration */
export interface DriftAwareOrchestratorConfig {
  maxRecoveryAttempts: number;   // default: 3
  recoveryDelayMs: number;       // delay before recovery attempt
  criticalThreshold: number;     // default: 0.3
}

/** Drift-Aware Orchestrator interface */
export interface IDriftAwareOrchestrator {
  onDriftDetected(classification: EnhancedDriftClassification, sessionId: string): Promise<void>;
  getRecoveryAttempts(sessionId: string): RecoveryAttempt[];
  getRecoveryCount(sessionId: string): number;
  isRecoveryExhausted(sessionId: string): boolean;
}
