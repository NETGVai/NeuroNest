/**
 * Rollback Criteria Recording
 *
 * Records stage rollback criteria for crashes, integrity, typing latency,
 * failed transactions, and visible regressions. Preserves themes and
 * reports any configuration reset.
 *
 * Each gate stage defines thresholds that, when exceeded, trigger automatic
 * rollback consideration or user notification.
 *
 * Requirements: 28.6, 28.7
 */

import type { EditorChatGateId } from './editor-chat-gates.js';

// ─── Criteria Types ─────────────────────────────────────────────

export interface CrashCriteria {
  /** Maximum crash count within the observation window */
  maxCrashCount: number;
  /** Observation window in milliseconds */
  windowMs: number;
  /** Current crash count within the window */
  currentCount: number;
  /** Timestamps of recent crashes */
  recentCrashes: string[];
}

export interface IntegrityCriteria {
  /** Whether data integrity checks are passing */
  integrityPassing: boolean;
  /** Last integrity check timestamp */
  lastCheckAt: string | null;
  /** Number of integrity failures detected */
  failureCount: number;
  /** Description of the latest failure */
  latestFailure: string | null;
}

export interface TypingLatencyCriteria {
  /** Maximum acceptable p95 typing latency in ms */
  maxP95Ms: number;
  /** Current measured p95 latency in ms */
  currentP95Ms: number;
  /** Number of samples in current measurement window */
  sampleCount: number;
  /** Whether latency is within acceptable bounds */
  withinBounds: boolean;
}

export interface TransactionCriteria {
  /** Maximum acceptable transaction failure rate (0.0 - 1.0) */
  maxFailureRate: number;
  /** Current failure rate */
  currentFailureRate: number;
  /** Total transactions attempted */
  totalAttempted: number;
  /** Total transactions failed */
  totalFailed: number;
  /** Observation window in milliseconds */
  windowMs: number;
}

export interface RegressionCriteria {
  /** Whether any visible regressions are detected */
  hasRegressions: boolean;
  /** List of detected regression descriptions */
  regressions: string[];
  /** Timestamp of latest regression detection */
  detectedAt: string | null;
}

export interface ThemePreservation {
  /** Whether themes are preserved during rollback */
  themesPreserved: boolean;
  /** Active theme at time of capture */
  activeThemeId: string | null;
  /** All available themes remain accessible */
  allThemesAccessible: boolean;
}

export interface ConfigurationResetReport {
  /** Whether any configuration was reset during rollout/rollback */
  wasReset: boolean;
  /** Which configuration keys were reset */
  resetKeys: string[];
  /** Timestamp of the reset */
  resetAt: string | null;
  /** Whether the user has been notified */
  userNotified: boolean;
}

// ─── Combined Stage Criteria ────────────────────────────────────

export interface StageRollbackCriteria {
  gateId: EditorChatGateId;
  /** Crash frequency criteria */
  crashes: CrashCriteria;
  /** Data integrity criteria */
  integrity: IntegrityCriteria;
  /** Typing latency criteria */
  typingLatency: TypingLatencyCriteria;
  /** Transaction failure criteria */
  transactions: TransactionCriteria;
  /** Visible regression criteria */
  regressions: RegressionCriteria;
  /** Theme preservation status */
  themePreservation: ThemePreservation;
  /** Configuration reset report */
  configResets: ConfigurationResetReport;
  /** Overall verdict: should this gate be rolled back? */
  shouldRollback: boolean;
  /** Reasons for rollback recommendation */
  rollbackReasons: string[];
  /** Last evaluation timestamp */
  evaluatedAt: string;
}

// ─── Default Thresholds ─────────────────────────────────────────

export interface RollbackThresholds {
  maxCrashesPerWindow: number;
  crashWindowMs: number;
  maxTypingLatencyP95Ms: number;
  maxTransactionFailureRate: number;
  transactionWindowMs: number;
}

export const DEFAULT_ROLLBACK_THRESHOLDS: RollbackThresholds = {
  maxCrashesPerWindow: 3,
  crashWindowMs: 300_000, // 5 minutes
  maxTypingLatencyP95Ms: 50,
  maxTransactionFailureRate: 0.05, // 5%
  transactionWindowMs: 60_000, // 1 minute
};

// ─── Rollback Criteria Recorder ─────────────────────────────────

export class RollbackCriteriaRecorder {
  private criteria: Map<EditorChatGateId, StageRollbackCriteria> = new Map();
  private thresholds: RollbackThresholds;

  constructor(thresholds: Partial<RollbackThresholds> = {}) {
    this.thresholds = { ...DEFAULT_ROLLBACK_THRESHOLDS, ...thresholds };
  }

  /**
   * Initialize criteria tracking for a gate.
   */
  initializeGate(gateId: EditorChatGateId): StageRollbackCriteria {
    const criteria: StageRollbackCriteria = {
      gateId,
      crashes: {
        maxCrashCount: this.thresholds.maxCrashesPerWindow,
        windowMs: this.thresholds.crashWindowMs,
        currentCount: 0,
        recentCrashes: [],
      },
      integrity: {
        integrityPassing: true,
        lastCheckAt: null,
        failureCount: 0,
        latestFailure: null,
      },
      typingLatency: {
        maxP95Ms: this.thresholds.maxTypingLatencyP95Ms,
        currentP95Ms: 0,
        sampleCount: 0,
        withinBounds: true,
      },
      transactions: {
        maxFailureRate: this.thresholds.maxTransactionFailureRate,
        currentFailureRate: 0,
        totalAttempted: 0,
        totalFailed: 0,
        windowMs: this.thresholds.transactionWindowMs,
      },
      regressions: {
        hasRegressions: false,
        regressions: [],
        detectedAt: null,
      },
      themePreservation: {
        themesPreserved: true,
        activeThemeId: null,
        allThemesAccessible: true,
      },
      configResets: {
        wasReset: false,
        resetKeys: [],
        resetAt: null,
        userNotified: false,
      },
      shouldRollback: false,
      rollbackReasons: [],
      evaluatedAt: new Date().toISOString(),
    };

    this.criteria.set(gateId, criteria);
    return criteria;
  }

  /**
   * Record a crash event for a gate.
   */
  recordCrash(gateId: EditorChatGateId): void {
    const criteria = this.getOrInitialize(gateId);
    const now = new Date().toISOString();
    criteria.crashes.recentCrashes.push(now);

    // Evict crashes outside the observation window
    const windowStart = Date.now() - criteria.crashes.windowMs;
    criteria.crashes.recentCrashes = criteria.crashes.recentCrashes.filter(
      (ts) => new Date(ts).getTime() >= windowStart,
    );
    criteria.crashes.currentCount = criteria.crashes.recentCrashes.length;

    this.evaluate(gateId);
  }

  /**
   * Record an integrity check result.
   */
  recordIntegrityCheck(gateId: EditorChatGateId, passing: boolean, failure?: string): void {
    const criteria = this.getOrInitialize(gateId);
    criteria.integrity.lastCheckAt = new Date().toISOString();
    criteria.integrity.integrityPassing = passing;
    if (!passing) {
      criteria.integrity.failureCount++;
      criteria.integrity.latestFailure = failure ?? 'Unknown integrity failure';
    }
    this.evaluate(gateId);
  }

  /**
   * Record a typing latency measurement.
   */
  recordTypingLatency(gateId: EditorChatGateId, p95Ms: number, sampleCount: number): void {
    const criteria = this.getOrInitialize(gateId);
    criteria.typingLatency.currentP95Ms = p95Ms;
    criteria.typingLatency.sampleCount = sampleCount;
    criteria.typingLatency.withinBounds = p95Ms <= criteria.typingLatency.maxP95Ms;
    this.evaluate(gateId);
  }

  /**
   * Record transaction outcomes.
   */
  recordTransactions(gateId: EditorChatGateId, attempted: number, failed: number): void {
    const criteria = this.getOrInitialize(gateId);
    criteria.transactions.totalAttempted += attempted;
    criteria.transactions.totalFailed += failed;
    criteria.transactions.currentFailureRate =
      criteria.transactions.totalAttempted > 0
        ? criteria.transactions.totalFailed / criteria.transactions.totalAttempted
        : 0;
    this.evaluate(gateId);
  }

  /**
   * Record a visible regression.
   */
  recordRegression(gateId: EditorChatGateId, description: string): void {
    const criteria = this.getOrInitialize(gateId);
    criteria.regressions.hasRegressions = true;
    criteria.regressions.regressions.push(description);
    criteria.regressions.detectedAt = new Date().toISOString();
    this.evaluate(gateId);
  }

  /**
   * Record theme preservation status.
   */
  recordThemeStatus(gateId: EditorChatGateId, activeThemeId: string, allAccessible: boolean): void {
    const criteria = this.getOrInitialize(gateId);
    criteria.themePreservation.activeThemeId = activeThemeId;
    criteria.themePreservation.allThemesAccessible = allAccessible;
    criteria.themePreservation.themesPreserved = allAccessible;
  }

  /**
   * Record a configuration reset and whether the user was notified.
   */
  recordConfigReset(gateId: EditorChatGateId, resetKeys: string[], userNotified: boolean): void {
    const criteria = this.getOrInitialize(gateId);
    criteria.configResets.wasReset = true;
    criteria.configResets.resetKeys.push(...resetKeys);
    criteria.configResets.resetAt = new Date().toISOString();
    criteria.configResets.userNotified = userNotified;
  }

  /**
   * Get current criteria state for a gate.
   */
  getCriteria(gateId: EditorChatGateId): StageRollbackCriteria | undefined {
    return this.criteria.get(gateId);
  }

  /**
   * Get all gates that recommend rollback.
   */
  getGatesRecommendingRollback(): EditorChatGateId[] {
    return Array.from(this.criteria.entries())
      .filter(([_, c]) => c.shouldRollback)
      .map(([id]) => id);
  }

  /**
   * Reset criteria for a gate (e.g. after successful rollback or recovery).
   */
  resetCriteria(gateId: EditorChatGateId): void {
    this.criteria.delete(gateId);
  }

  // ─── Private ────────────────────────────────────────────────────

  private getOrInitialize(gateId: EditorChatGateId): StageRollbackCriteria {
    let criteria = this.criteria.get(gateId);
    if (!criteria) {
      criteria = this.initializeGate(gateId);
    }
    return criteria;
  }

  /**
   * Evaluate whether a gate should be rolled back based on all criteria.
   */
  private evaluate(gateId: EditorChatGateId): void {
    const criteria = this.criteria.get(gateId);
    if (!criteria) return;

    const reasons: string[] = [];

    // Check crash rate
    if (criteria.crashes.currentCount >= criteria.crashes.maxCrashCount) {
      reasons.push(
        `Crash count (${criteria.crashes.currentCount}) exceeds threshold (${criteria.crashes.maxCrashCount}) within observation window`,
      );
    }

    // Check integrity
    if (!criteria.integrity.integrityPassing) {
      reasons.push(`Data integrity check failing: ${criteria.integrity.latestFailure}`);
    }

    // Check typing latency
    if (!criteria.typingLatency.withinBounds && criteria.typingLatency.sampleCount > 10) {
      reasons.push(
        `Typing latency p95 (${criteria.typingLatency.currentP95Ms}ms) exceeds threshold (${criteria.typingLatency.maxP95Ms}ms)`,
      );
    }

    // Check transaction failure rate
    if (
      criteria.transactions.currentFailureRate > criteria.transactions.maxFailureRate &&
      criteria.transactions.totalAttempted > 10
    ) {
      reasons.push(
        `Transaction failure rate (${(criteria.transactions.currentFailureRate * 100).toFixed(1)}%) exceeds threshold (${(criteria.transactions.maxFailureRate * 100).toFixed(1)}%)`,
      );
    }

    // Check regressions
    if (criteria.regressions.hasRegressions) {
      reasons.push(
        `Visible regressions detected: ${criteria.regressions.regressions.length} issues`,
      );
    }

    criteria.shouldRollback = reasons.length > 0;
    criteria.rollbackReasons = reasons;
    criteria.evaluatedAt = new Date().toISOString();
  }
}
