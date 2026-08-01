/**
 * ProviderFailover — Automatic LLM provider failover with exponential backoff.
 *
 * Wraps LLM calls with retry logic and provider failover. When the primary
 * provider fails with a retryable error (5xx, 429, timeout, network errors),
 * retries with exponential backoff. When retries are exhausted for a provider,
 * fails over to the next provider in the chain.
 *
 * Key behaviors:
 * - callWithFailover() tries each provider in the chain, retrying with backoff
 *   on retryable errors (5xx, 429, timeout, network)
 * - calculateBackoff(n) = min(initialBackoffMs × backoffFactor^n, maxBackoffMs)
 * - Logs failover events via CallbackEngine when switching providers
 * - When all providers exhausted, throws AllProvidersExhaustedError
 * - When model_routing is enabled, the failover chain is scoped by task type
 *
 * Performance: Zero overhead on success path. Adds latency only on failure
 * (backoff wait time between retries).
 *
 * Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6
 */

import type { CallbackEngine } from '../pipeline/callback-engine.js';
import type { ModelRouter, TaskType } from './model-router.js';

// ─── Types & Interfaces ─────────────────────────────────────────

/**
 * Configuration for the failover behavior.
 */
export interface FailoverConfig {
  /** Initial backoff delay in milliseconds before retrying the same provider. Default: 1000 */
  initialBackoffMs: number;
  /** Maximum backoff delay in milliseconds. Default: 30000 */
  maxBackoffMs: number;
  /** Multiplier applied to backoff on each retry attempt. Default: 2 */
  backoffFactor: number;
  /** Maximum retry attempts per provider before failing over to next. Default: 3 */
  maxRetries: number;
  /** HTTP status codes considered retryable. Default: [429, 500, 502, 503, 504] */
  retryableStatusCodes: number[];
}

/**
 * Event emitted when a failover occurs (switching from one provider to the next).
 */
export interface FailoverEvent {
  /** The provider that failed. */
  originalProvider: string;
  /** The type/category of error that caused the failover. */
  errorType: string;
  /** The provider being failed over to. */
  fallbackProvider: string;
  /** ISO timestamp of when the failover occurred. */
  timestamp: string;
}

/**
 * Error thrown when all providers in the failover chain have been exhausted.
 */
export class AllProvidersExhaustedError extends Error {
  public readonly failoverEvents: FailoverEvent[];

  constructor(failoverEvents: FailoverEvent[]) {
    const providers = failoverEvents.map((e) => e.originalProvider).join(', ');
    super(
      `All providers in the failover chain are unavailable: [${providers}]. ` +
      'Please check provider status or configure additional fallback providers.',
    );
    this.name = 'AllProvidersExhaustedError';
    this.failoverEvents = failoverEvents;
  }
}

// ─── Default Configuration ──────────────────────────────────────

/**
 * Default failover configuration values.
 */
export const DEFAULT_FAILOVER_CONFIG: FailoverConfig = {
  initialBackoffMs: 1000,
  maxBackoffMs: 30000,
  backoffFactor: 2,
  maxRetries: 3,
  retryableStatusCodes: [429, 500, 502, 503, 504],
};

// ─── ProviderFailover Class ─────────────────────────────────────

export class ProviderFailover {
  private readonly config: FailoverConfig;
  private readonly callbackEngine: CallbackEngine | null;
  private readonly modelRouter: ModelRouter | null;

  constructor(
    config: Partial<FailoverConfig>,
    callbackEngine?: CallbackEngine | null,
    modelRouter?: ModelRouter | null,
  ) {
    this.config = { ...DEFAULT_FAILOVER_CONFIG, ...config };
    this.callbackEngine = callbackEngine ?? null;
    this.modelRouter = modelRouter ?? null;
  }

  /**
   * Wrap an LLM call with automatic retry and failover logic.
   *
   * Iterates through the failover chain, attempting each provider up to
   * `maxRetries` times with exponential backoff between attempts. When a
   * provider is exhausted, fails over to the next one in the chain.
   *
   * When model_routing is enabled and a taskType is provided, the failover
   * chain is scoped to providers configured for that task type.
   *
   * @param call - Function that makes the LLM call given a provider and model.
   * @param failoverChain - Ordered list of provider-model pairs to try.
   * @param taskType - Optional task type to scope failover chain via ModelRouter.
   * @returns The result of the successful LLM call.
   * @throws AllProvidersExhaustedError when all providers fail.
   *
   * Requirements: 17.1, 17.2, 17.4, 17.5
   */
  async callWithFailover<T>(
    call: (provider: string, model: string) => Promise<T>,
    failoverChain: Array<{ providerId: string; model: string }>,
    taskType?: TaskType,
  ): Promise<T> {
    // Scope failover chain by task type when ModelRouter is available
    const chain = this.resolveFailoverChain(failoverChain, taskType);

    if (chain.length === 0) {
      throw new AllProvidersExhaustedError([]);
    }

    const failoverEvents: FailoverEvent[] = [];

    for (let providerIndex = 0; providerIndex < chain.length; providerIndex++) {
      const entry = chain[providerIndex]!;
      const { providerId, model } = entry;

      for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
        try {
          // Apply backoff before retry (not before first attempt)
          if (attempt > 0) {
            const backoffMs = this.calculateBackoff(attempt - 1);
            await this.sleep(backoffMs);
          }

          return await call(providerId, model);
        } catch (error) {
          if (!this.isRetryableError(error)) {
            // Non-retryable error — throw immediately
            throw error;
          }

          // If this is the last attempt for this provider, fail over
          if (attempt === this.config.maxRetries - 1) {
            const nextProvider = chain[providerIndex + 1];

            if (nextProvider) {
              const event: FailoverEvent = {
                originalProvider: providerId,
                errorType: this.classifyError(error),
                fallbackProvider: nextProvider.providerId,
                timestamp: new Date().toISOString(),
              };
              failoverEvents.push(event);
              await this.logFailoverEvent(event);
            }
          }
          // Otherwise, continue retrying with backoff
        }
      }
    }

    // All providers exhausted — notify user and throw
    throw new AllProvidersExhaustedError(failoverEvents);
  }

  /**
   * Calculate exponential backoff delay for a given attempt number.
   *
   * Formula: min(initialBackoffMs × backoffFactor^attempt, maxBackoffMs)
   *
   * @param attempt - Zero-based attempt number (0 = first retry).
   * @returns Backoff delay in milliseconds.
   *
   * Requirements: 17.4
   */
  calculateBackoff(attempt: number): number {
    const backoff = this.config.initialBackoffMs * Math.pow(this.config.backoffFactor, attempt);
    return Math.min(backoff, this.config.maxBackoffMs);
  }

  /**
   * Determine if an error is retryable based on status codes and error types.
   *
   * Retryable conditions:
   * - HTTP status codes in retryableStatusCodes (429, 5xx)
   * - Timeout errors (ETIMEDOUT, ESOCKETTIMEDOUT, timeout in message)
   * - Network errors (ECONNREFUSED, ECONNRESET, ENOTFOUND, EAI_AGAIN)
   *
   * Requirements: 17.1
   */
  isRetryableError(error: unknown): boolean {
    if (error == null) return false;

    // Check for HTTP status code
    const statusCode = this.extractStatusCode(error);
    if (statusCode !== null && this.config.retryableStatusCodes.includes(statusCode)) {
      return true;
    }

    // Check for timeout errors
    const errorCode = this.extractErrorCode(error);
    const timeoutCodes = ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED'];
    if (errorCode && timeoutCodes.includes(errorCode)) {
      return true;
    }

    // Check for network errors
    const networkCodes = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'];
    if (errorCode && networkCodes.includes(errorCode)) {
      return true;
    }

    // Check error message for timeout indication
    const message = this.extractErrorMessage(error);
    if (message && /time\s*out|timed\s*out/i.test(message)) {
      return true;
    }

    return false;
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Resolve the failover chain, potentially scoping by task type when
   * ModelRouter is available.
   *
   * Requirements: 17.1 (scoping by task type when model_routing enabled)
   */
  private resolveFailoverChain(
    fallbackChain: Array<{ providerId: string; model: string }>,
    taskType?: TaskType,
  ): Array<{ providerId: string; model: string }> {
    // When ModelRouter is available and a task type is provided, use the
    // router's failover chain (scoped to the task type's routing tier)
    if (this.modelRouter && taskType) {
      const routerChain = this.modelRouter.getFailoverChain(taskType);
      if (routerChain.length > 0) {
        return routerChain;
      }
    }

    return fallbackChain;
  }

  /**
   * Classify the error into a human-readable error type string.
   */
  private classifyError(error: unknown): string {
    const statusCode = this.extractStatusCode(error);
    if (statusCode === 429) return 'rate_limit';
    if (statusCode !== null && statusCode >= 500) return `server_error_${statusCode}`;

    const errorCode = this.extractErrorCode(error);
    if (errorCode && ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED'].includes(errorCode)) {
      return 'timeout';
    }
    if (errorCode && ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(errorCode)) {
      return 'network_error';
    }

    const message = this.extractErrorMessage(error);
    if (message && /time\s*out|timed\s*out/i.test(message)) return 'timeout';

    return 'unknown';
  }

  /**
   * Extract HTTP status code from an error object.
   */
  private extractStatusCode(error: unknown): number | null {
    if (typeof error !== 'object' || error === null) return null;
    const err = error as Record<string, unknown>;

    // Common patterns: error.status, error.statusCode, error.response?.status
    if (typeof err['status'] === 'number') return err['status'];
    if (typeof err['statusCode'] === 'number') return err['statusCode'];
    if (typeof err['response'] === 'object' && err['response'] !== null) {
      const response = err['response'] as Record<string, unknown>;
      if (typeof response['status'] === 'number') return response['status'];
    }

    return null;
  }

  /**
   * Extract error code (e.g., ECONNREFUSED) from an error object.
   */
  private extractErrorCode(error: unknown): string | null {
    if (typeof error !== 'object' || error === null) return null;
    const err = error as Record<string, unknown>;
    if (typeof err['code'] === 'string') return err['code'];
    return null;
  }

  /**
   * Extract error message string from an error object.
   */
  private extractErrorMessage(error: unknown): string | null {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    if (typeof error === 'object' && error !== null) {
      const err = error as Record<string, unknown>;
      if (typeof err['message'] === 'string') return err['message'];
    }
    return null;
  }

  /**
   * Log a failover event through the CallbackEngine.
   *
   * Emits via the 'on-error' lifecycle event with failover-specific metadata
   * so downstream listeners (trace visualization, UI) can track provider switches.
   *
   * Requirements: 17.3
   */
  private async logFailoverEvent(event: FailoverEvent): Promise<void> {
    if (!this.callbackEngine) return;

    try {
      await this.callbackEngine.emit({
        event: 'on-error',
        toolName: 'provider-failover',
        input: {
          originalProvider: event.originalProvider,
          errorType: event.errorType,
        },
        output: {
          fallbackProvider: event.fallbackProvider,
          failoverEvent: event,
        },
        sessionId: '',
        iteration: 0,
      });
    } catch {
      // Failover logging should never interrupt the failover process
    }
  }

  /**
   * Sleep utility for backoff delays. Separated for testability.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
