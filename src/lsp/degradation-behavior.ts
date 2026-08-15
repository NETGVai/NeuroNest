/**
 * DegradationBehavior — Precise LSP degradation and editability policy.
 *
 * Preserves editability in ALL degraded states. Does NOT infer editability
 * from normal-state policy. Shows degraded indicator only after CONFIRMED
 * disconnection. Implements bounded reconnect with exponential backoff
 * and exposes manual restart action.
 *
 * Requirements: 3.6, 3.8
 */

import { EventEmitter } from 'node:events';

// ─── Types ──────────────────────────────────────────────────────

/**
 * All possible degraded service states.
 * The editor MUST remain editable in every one of these states.
 */
export type DegradedState =
  | 'degraded'
  | 'reconnecting'
  | 'failed'
  | 'crashing'
  | 'disconnected'
  | 'unresponsive';

/**
 * Combined service condition covering both normal and degraded states.
 */
export type ServiceCondition = 'normal' | DegradedState;

/**
 * Whether a disconnection has been confirmed.
 * Degraded indicator shows ONLY after confirmed disconnection.
 */
export type DisconnectionStatus =
  | 'connected'
  | 'suspected'
  | 'confirmed';

/** Configuration for degradation behavior */
export interface DegradationConfig {
  /** Base delay for exponential backoff (ms) */
  reconnectBaseDelayMs: number;
  /** Maximum delay cap for reconnection (ms) */
  reconnectMaxDelayMs: number;
  /** Maximum reconnection attempts before transition to failed */
  maxReconnectAttempts: number;
  /** Time to wait before confirming disconnection (ms) */
  disconnectionConfirmationMs: number;
  /** Jitter factor for backoff (0-1) */
  jitterFactor: number;
}

/** Events emitted by DegradationBehavior */
export interface DegradationEvents {
  'degradation:stateChanged': {
    previous: ServiceCondition;
    current: ServiceCondition;
    editabilityPreserved: boolean;
  };
  'degradation:disconnectionConfirmed': {
    timestamp: number;
    showIndicator: boolean;
  };
  'degradation:reconnectAttempt': {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
  };
  'degradation:reconnected': {
    attempts: number;
    downtime: number;
  };
  'degradation:manualRestartRequested': {
    timestamp: number;
  };
}

/** Snapshot of the current degradation state */
export interface DegradationSnapshot {
  /** Current service condition */
  condition: ServiceCondition;
  /** Whether the editor is editable (always true in degraded states) */
  editable: boolean;
  /** Whether the degraded indicator should be shown */
  showDegradedIndicator: boolean;
  /** Disconnection status */
  disconnectionStatus: DisconnectionStatus;
  /** Current reconnect attempt count */
  reconnectAttempts: number;
  /** Maximum reconnect attempts allowed */
  maxReconnectAttempts: number;
  /** Whether manual restart is available */
  manualRestartAvailable: boolean;
  /** Timestamp of last state change */
  lastStateChangeAt: number;
  /** Timestamp when disconnection was confirmed (null if not confirmed) */
  disconnectionConfirmedAt: number | null;
}

// ─── Constants ──────────────────────────────────────────────────

export const DEFAULT_DEGRADATION_CONFIG: DegradationConfig = {
  reconnectBaseDelayMs: 1000,
  reconnectMaxDelayMs: 30000,
  maxReconnectAttempts: 5,
  disconnectionConfirmationMs: 3000,
  jitterFactor: 0.1,
};

/**
 * All states in which editability is explicitly preserved.
 * This list is exhaustive — degradation NEVER restricts editing.
 */
const DEGRADED_STATES: readonly DegradedState[] = [
  'degraded',
  'reconnecting',
  'failed',
  'crashing',
  'disconnected',
  'unresponsive',
] as const;

// ─── DegradationBehavior ────────────────────────────────────────

/**
 * DegradationBehavior — Manages editor behavior during LSP degradation.
 *
 * Core invariants:
 * 1. The editor ALWAYS remains editable during ANY degraded state.
 * 2. Editability is NOT inferred from normal-state policy.
 *    Another policy may restrict editing in normal state, but degradation
 *    NEVER restricts it.
 * 3. Degraded indicator shows ONLY after CONFIRMED disconnection.
 * 4. Temporary unresponsiveness (not yet classified as failure) is treated
 *    as fully functional from the user's perspective.
 * 5. Bounded reconnect with exponential backoff after confirmed disconnection.
 * 6. Manual restart action is always available in failed/disconnected states.
 *
 * Requirements: 3.6, 3.8
 */
export class DegradationBehavior extends EventEmitter {
  private condition: ServiceCondition = 'normal';
  private disconnectionStatus: DisconnectionStatus = 'connected';
  private reconnectAttempts: number = 0;
  private config: DegradationConfig;
  private lastStateChangeAt: number = Date.now();
  private disconnectionConfirmedAt: number | null = null;
  private disconnectionTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config?: Partial<DegradationConfig>) {
    super();
    this.config = { ...DEFAULT_DEGRADATION_CONFIG, ...config };
  }

  // ─── Editability ──────────────────────────────────────────────

  /**
   * Query whether the editor should be editable.
   *
   * CRITICAL: In ANY degraded state, this ALWAYS returns true.
   * This method does NOT infer editability from normal-state policy.
   * Normal-state editability is determined elsewhere; this module only
   * guarantees that degradation never restricts editing.
   *
   * Requirements: 3.8
   */
  isEditableInDegradedState(): boolean {
    // If we're in any degraded state, editability is preserved
    if (this.isDegraded()) {
      return true;
    }
    // In normal state, this module does not make an editability decision.
    // Another policy may restrict it. We return true because we don't restrict.
    return true;
  }

  /**
   * Check if the current state is any form of degradation.
   */
  isDegraded(): boolean {
    return DEGRADED_STATES.includes(this.condition as DegradedState);
  }

  // ─── State Transitions ────────────────────────────────────────

  /**
   * Report that the service has entered a degraded state.
   *
   * Requirements: 3.6, 3.8
   */
  reportDegraded(state: DegradedState): void {
    const previous = this.condition;
    this.condition = state;
    this.lastStateChangeAt = Date.now();

    this.emit('degradation:stateChanged', {
      previous,
      current: state,
      editabilityPreserved: true, // Always true in degraded states
    });

    // Start disconnection confirmation only for disconnected state.
    // 'failed' is a terminal state that doesn't need reconnection —
    // it requires manual restart.
    if (state === 'disconnected') {
      this.startDisconnectionConfirmation();
    }
  }

  /**
   * Report that the service has returned to normal operation.
   */
  reportNormal(): void {
    const previous = this.condition;
    this.condition = 'normal';
    this.disconnectionStatus = 'connected';
    this.lastStateChangeAt = Date.now();
    this.disconnectionConfirmedAt = null;

    // Clear timers
    this.clearDisconnectionTimer();
    this.clearReconnectTimer();

    // Record successful reconnection if we were reconnecting
    if (previous === 'reconnecting' && this.reconnectAttempts > 0) {
      this.emit('degradation:reconnected', {
        attempts: this.reconnectAttempts,
        downtime: Date.now() - (this.disconnectionConfirmedAt ?? this.lastStateChangeAt),
      });
    }

    this.reconnectAttempts = 0;

    this.emit('degradation:stateChanged', {
      previous,
      current: 'normal',
      editabilityPreserved: true,
    });
  }

  // ─── Disconnection Confirmation ───────────────────────────────

  /**
   * Start the disconnection confirmation timer.
   * Degraded indicator shows ONLY after confirmed disconnection.
   *
   * Requirements: 3.6
   */
  private startDisconnectionConfirmation(): void {
    if (this.disconnectionStatus === 'confirmed') return;

    this.disconnectionStatus = 'suspected';
    this.clearDisconnectionTimer();

    this.disconnectionTimer = setTimeout(() => {
      this.confirmDisconnection();
    }, this.config.disconnectionConfirmationMs);
  }

  /**
   * Confirm that disconnection has occurred.
   * Only NOW should the degraded indicator be shown.
   *
   * Requirements: 3.6
   */
  private confirmDisconnection(): void {
    this.disconnectionStatus = 'confirmed';
    this.disconnectionConfirmedAt = Date.now();
    this.disconnectionTimer = null;

    this.emit('degradation:disconnectionConfirmed', {
      timestamp: this.disconnectionConfirmedAt,
      showIndicator: true,
    });

    // Start bounded reconnect
    this.startReconnect();
  }

  /**
   * Explicitly confirm disconnection (e.g., from server process exit).
   * Bypasses the confirmation timer.
   */
  confirmDisconnectionImmediately(): void {
    this.clearDisconnectionTimer();
    this.disconnectionStatus = 'confirmed';
    this.disconnectionConfirmedAt = Date.now();

    this.emit('degradation:disconnectionConfirmed', {
      timestamp: this.disconnectionConfirmedAt,
      showIndicator: true,
    });

    this.startReconnect();
  }

  // ─── Bounded Reconnect ────────────────────────────────────────

  /**
   * Start the bounded reconnect process with exponential backoff.
   *
   * Requirements: 3.8
   */
  private startReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      // Max attempts reached — transition to failed
      this.reportDegraded('failed');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.calculateBackoffDelay();

    const previous = this.condition;
    this.condition = 'reconnecting';
    this.lastStateChangeAt = Date.now();

    this.emit('degradation:stateChanged', {
      previous,
      current: 'reconnecting',
      editabilityPreserved: true,
    });

    this.emit('degradation:reconnectAttempt', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.config.maxReconnectAttempts,
      delayMs: delay,
    });

    this.reconnectTimer = setTimeout(() => {
      // The actual reconnection logic is handled by the caller
      // This just manages the timing and state
      this.reconnectTimer = null;
    }, delay);
  }

  /**
   * Notify that a reconnection attempt has failed.
   * Triggers the next attempt or transitions to failed.
   */
  reconnectFailed(): void {
    this.clearReconnectTimer();
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.reportDegraded('failed');
    } else {
      this.startReconnect();
    }
  }

  /**
   * Calculate the backoff delay using exponential backoff with jitter.
   */
  calculateBackoffDelay(): number {
    const exponential = this.config.reconnectBaseDelayMs * Math.pow(2, this.reconnectAttempts - 1);
    const capped = Math.min(exponential, this.config.reconnectMaxDelayMs);
    const jitter = capped * this.config.jitterFactor * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(capped + jitter));
  }

  // ─── Manual Restart ───────────────────────────────────────────

  /**
   * Check if manual restart is available.
   * Available in failed state (always), or disconnected state after confirmation.
   */
  isManualRestartAvailable(): boolean {
    if (this.condition === 'failed') {
      return true;
    }
    return (
      this.condition === 'disconnected' && this.disconnectionStatus === 'confirmed'
    );
  }

  /**
   * Request a manual restart of the service.
   * Resets reconnection attempts and state.
   *
   * Requirements: 3.8
   */
  requestManualRestart(): boolean {
    if (!this.isManualRestartAvailable()) return false;

    this.reconnectAttempts = 0;
    this.clearReconnectTimer();

    this.emit('degradation:manualRestartRequested', {
      timestamp: Date.now(),
    });

    return true;
  }

  // ─── Degraded Indicator ───────────────────────────────────────

  /**
   * Determine whether the degraded indicator should be shown.
   *
   * The indicator is shown ONLY after CONFIRMED disconnection.
   * Temporary unresponsiveness or suspected disconnection does NOT
   * show the indicator.
   *
   * Requirements: 3.6
   */
  shouldShowDegradedIndicator(): boolean {
    return this.disconnectionStatus === 'confirmed';
  }

  // ─── Snapshot ─────────────────────────────────────────────────

  /**
   * Get a snapshot of the current degradation state.
   */
  getSnapshot(): DegradationSnapshot {
    return {
      condition: this.condition,
      editable: this.isEditableInDegradedState(),
      showDegradedIndicator: this.shouldShowDegradedIndicator(),
      disconnectionStatus: this.disconnectionStatus,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.config.maxReconnectAttempts,
      manualRestartAvailable: this.isManualRestartAvailable(),
      lastStateChangeAt: this.lastStateChangeAt,
      disconnectionConfirmedAt: this.disconnectionConfirmedAt,
    };
  }

  // ─── Queries ──────────────────────────────────────────────────

  /**
   * Get the current service condition.
   */
  getCondition(): ServiceCondition {
    return this.condition;
  }

  /**
   * Get the disconnection status.
   */
  getDisconnectionStatus(): DisconnectionStatus {
    return this.disconnectionStatus;
  }

  /**
   * Get the current reconnect attempt count.
   */
  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  // ─── Cleanup ──────────────────────────────────────────────────

  /**
   * Clear the disconnection confirmation timer.
   */
  private clearDisconnectionTimer(): void {
    if (this.disconnectionTimer !== null) {
      clearTimeout(this.disconnectionTimer);
      this.disconnectionTimer = null;
    }
  }

  /**
   * Clear the reconnect timer.
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Dispose of all resources.
   */
  dispose(): void {
    this.clearDisconnectionTimer();
    this.clearReconnectTimer();
    this.removeAllListeners();
  }
}
