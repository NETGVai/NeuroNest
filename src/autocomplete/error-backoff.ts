/**
 * Error Backoff — Failure handling and rate limiting for autocomplete.
 *
 * Tracks consecutive failures per provider independently and enters exponential
 * backoff after 3 consecutive failures. After the backoff period, auto-resumes
 * with a health check (single test request). If the health check fails, backoff
 * is extended exponentially.
 *
 * Follows NeuroNest's lazy-initialized singleton pattern.
 *
 * Requirements: 1.6
 */

// ─── Types ──────────────────────────────────────────────────────

/** State of a provider's backoff tracking */
export type BackoffState = 'active' | 'backoff' | 'health_check';

/** Per-provider failure tracking record */
export interface ProviderBackoffRecord {
  /** Provider identifier */
  providerId: string;
  /** Current state of this provider */
  state: BackoffState;
  /** Number of consecutive failures (resets on success) */
  consecutiveFailures: number;
  /** Current backoff multiplier (increases on each health check failure) */
  backoffMultiplier: number;
  /** Timestamp (ms) when the backoff period expires and health check can be attempted */
  backoffUntil: number | null;
  /** Total failures since last successful request */
  totalFailuresSinceSuccess: number;
  /** Timestamp of the last recorded failure */
  lastFailureAt: number | null;
  /** Timestamp of the last recorded success */
  lastSuccessAt: number | null;
}

/** Configuration for the error backoff module */
export interface ErrorBackoffConfig {
  /** Number of consecutive failures before entering backoff (default: 3) */
  failureThreshold: number;
  /** Base backoff duration in milliseconds (default: 30000 = 30s) */
  baseBackoffMs: number;
  /** Maximum backoff duration in milliseconds (default: 300000 = 5min) */
  maxBackoffMs: number;
  /** Backoff multiplier factor applied after each health check failure (default: 2) */
  backoffFactor: number;
}

/** Result from checking whether a request should proceed */
export interface BackoffCheckResult {
  /** Whether the request is allowed to proceed */
  allowed: boolean;
  /** If not allowed, milliseconds remaining until backoff expires */
  retryAfterMs: number | null;
  /** Current state of the provider */
  state: BackoffState;
  /** Reason for the decision */
  reason: string;
}

/** Summary of all tracked providers' backoff states */
export interface BackoffSummary {
  /** Total number of tracked providers */
  totalProviders: number;
  /** Providers currently in active state */
  activeProviders: string[];
  /** Providers currently in backoff */
  backedOffProviders: string[];
  /** Providers currently in health check state */
  healthCheckProviders: string[];
}

// ─── Constants ──────────────────────────────────────────────────

/** Default configuration */
export const DEFAULT_ERROR_BACKOFF_CONFIG: ErrorBackoffConfig = {
  failureThreshold: 3,
  baseBackoffMs: 30_000,
  maxBackoffMs: 300_000,
  backoffFactor: 2,
};

// ─── ErrorBackoff Service ───────────────────────────────────────

/**
 * ErrorBackoff — Manages per-provider failure tracking with exponential backoff.
 *
 * Lazy-initialized singleton following NeuroNest's established patterns.
 *
 * Lifecycle per provider:
 * 1. ACTIVE — requests allowed, tracking consecutive failures
 * 2. BACKOFF — requests blocked after `failureThreshold` consecutive failures
 * 3. HEALTH_CHECK — one request allowed after backoff expires
 *    - Success → return to ACTIVE
 *    - Failure → return to BACKOFF with increased multiplier
 */
export class ErrorBackoff {
  private static instance: ErrorBackoff | null = null;
  private config: ErrorBackoffConfig;
  private providers: Map<string, ProviderBackoffRecord>;
  /** Injectable clock for testing — returns current time in ms */
  private clock: () => number;

  private constructor(config?: Partial<ErrorBackoffConfig>, clock?: () => number) {
    this.config = { ...DEFAULT_ERROR_BACKOFF_CONFIG, ...config };
    this.providers = new Map();
    this.clock = clock ?? (() => Date.now());
  }

  /** Get or create the singleton instance */
  static getInstance(config?: Partial<ErrorBackoffConfig>, clock?: () => number): ErrorBackoff {
    if (!ErrorBackoff.instance) {
      ErrorBackoff.instance = new ErrorBackoff(config, clock);
    }
    return ErrorBackoff.instance;
  }

  /** Reset singleton (for testing) */
  static resetInstance(): void {
    ErrorBackoff.instance = null;
  }

  /** Update configuration at runtime */
  updateConfig(config: Partial<ErrorBackoffConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Get current configuration */
  getConfig(): Readonly<ErrorBackoffConfig> {
    return { ...this.config };
  }

  // ─── Core Methods ───────────────────────────────────────────

  /**
   * Check whether a request to the given provider is allowed.
   *
   * Returns immediately with the decision — does NOT block.
   * The caller should check `allowed` and either proceed or display a backoff message.
   */
  canRequest(providerId: string): BackoffCheckResult {
    const record = this.getOrCreateRecord(providerId);
    const now = this.clock();

    switch (record.state) {
      case 'active':
        return {
          allowed: true,
          retryAfterMs: null,
          state: 'active',
          reason: 'Provider is active',
        };

      case 'backoff': {
        const backoffUntil = record.backoffUntil ?? 0;
        if (now >= backoffUntil) {
          // Backoff period has expired — transition to health check
          record.state = 'health_check';
          return {
            allowed: true,
            retryAfterMs: null,
            state: 'health_check',
            reason: 'Backoff expired — attempting health check',
          };
        }
        const retryAfterMs = backoffUntil - now;
        return {
          allowed: false,
          retryAfterMs,
          state: 'backoff',
          reason: `Provider in backoff for ${Math.ceil(retryAfterMs / 1000)}s (${record.consecutiveFailures} consecutive failures)`,
        };
      }

      case 'health_check':
        // Health check is already in progress — only one request is allowed
        // The first caller gets the health check slot; subsequent calls are blocked
        // until the health check result is recorded
        return {
          allowed: true,
          retryAfterMs: null,
          state: 'health_check',
          reason: 'Health check in progress — request allowed as probe',
        };

      default:
        return {
          allowed: true,
          retryAfterMs: null,
          state: 'active',
          reason: 'Unknown state — defaulting to active',
        };
    }
  }

  /**
   * Record a successful request for the given provider.
   *
   * Resets consecutive failure count and returns the provider to active state.
   */
  recordSuccess(providerId: string): void {
    const record = this.getOrCreateRecord(providerId);
    record.consecutiveFailures = 0;
    record.totalFailuresSinceSuccess = 0;
    record.backoffMultiplier = 1;
    record.backoffUntil = null;
    record.lastSuccessAt = this.clock();
    record.state = 'active';
  }

  /**
   * Record a failed request for the given provider.
   *
   * Increments the consecutive failure count. If the threshold is reached,
   * enters backoff state. If already in health_check state, extends backoff.
   */
  recordFailure(providerId: string): void {
    const record = this.getOrCreateRecord(providerId);
    const now = this.clock();

    record.consecutiveFailures++;
    record.totalFailuresSinceSuccess++;
    record.lastFailureAt = now;

    if (record.state === 'health_check') {
      // Health check failed — extend backoff with increased multiplier
      record.backoffMultiplier = Math.min(
        record.backoffMultiplier * this.config.backoffFactor,
        this.config.maxBackoffMs / this.config.baseBackoffMs,
      );
      record.backoffUntil = now + this.calculateBackoffDuration(record.backoffMultiplier);
      record.state = 'backoff';
    } else if (record.consecutiveFailures >= this.config.failureThreshold) {
      // Threshold reached — enter backoff
      record.backoffUntil = now + this.calculateBackoffDuration(record.backoffMultiplier);
      record.state = 'backoff';
    }
    // Otherwise, remain in 'active' state and keep counting
  }

  /**
   * Get the current backoff record for a provider.
   * Returns null if the provider has never been tracked.
   */
  getProviderRecord(providerId: string): Readonly<ProviderBackoffRecord> | null {
    const record = this.providers.get(providerId);
    return record ? { ...record } : null;
  }

  /**
   * Get a summary of all tracked providers' backoff states.
   */
  getSummary(): BackoffSummary {
    const activeProviders: string[] = [];
    const backedOffProviders: string[] = [];
    const healthCheckProviders: string[] = [];

    // Refresh states before summarizing (check for expired backoffs)
    for (const [id, record] of this.providers) {
      const effectiveState = this.getEffectiveState(record);
      switch (effectiveState) {
        case 'active':
          activeProviders.push(id);
          break;
        case 'backoff':
          backedOffProviders.push(id);
          break;
        case 'health_check':
          healthCheckProviders.push(id);
          break;
      }
    }

    return {
      totalProviders: this.providers.size,
      activeProviders,
      backedOffProviders,
      healthCheckProviders,
    };
  }

  /**
   * Manually reset the backoff state for a specific provider.
   * Forces the provider back to active state.
   */
  resetProvider(providerId: string): void {
    const record = this.providers.get(providerId);
    if (record) {
      record.state = 'active';
      record.consecutiveFailures = 0;
      record.totalFailuresSinceSuccess = 0;
      record.backoffMultiplier = 1;
      record.backoffUntil = null;
    }
  }

  /**
   * Reset all provider tracking. Useful for testing or configuration changes.
   */
  resetAll(): void {
    this.providers.clear();
  }

  /**
   * Check if a specific provider is currently in a backoff state
   * (either actively backed off or in health check).
   */
  isInBackoff(providerId: string): boolean {
    const record = this.providers.get(providerId);
    if (!record) return false;
    const effectiveState = this.getEffectiveState(record);
    return effectiveState === 'backoff';
  }

  // ─── Private Helpers ────────────────────────────────────────

  /**
   * Get or create a tracking record for a provider.
   */
  private getOrCreateRecord(providerId: string): ProviderBackoffRecord {
    let record = this.providers.get(providerId);
    if (!record) {
      record = {
        providerId,
        state: 'active',
        consecutiveFailures: 0,
        backoffMultiplier: 1,
        backoffUntil: null,
        totalFailuresSinceSuccess: 0,
        lastFailureAt: null,
        lastSuccessAt: null,
      };
      this.providers.set(providerId, record);
    }
    return record;
  }

  /**
   * Calculate backoff duration based on the current multiplier.
   * Caps at maxBackoffMs.
   */
  private calculateBackoffDuration(multiplier: number): number {
    const duration = this.config.baseBackoffMs * multiplier;
    return Math.min(duration, this.config.maxBackoffMs);
  }

  /**
   * Get the effective state of a provider, accounting for expired backoff periods.
   * This does NOT mutate the record — use `canRequest` for state transitions.
   */
  private getEffectiveState(record: ProviderBackoffRecord): BackoffState {
    if (record.state === 'backoff' && record.backoffUntil !== null) {
      if (this.clock() >= record.backoffUntil) {
        return 'health_check';
      }
    }
    return record.state;
  }
}
