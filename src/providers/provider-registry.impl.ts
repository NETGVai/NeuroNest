/**
 * ProviderRegistry Implementation — Multi-LLM provider management with
 * hot-swap, usage tracking, and rate-limit fallback.
 *
 * Maintains a registry of LLM backend adapters with priority-based routing,
 * persists usage records to SQLite, and supports in-flight request draining
 * during hot-swap transitions. Integrates with existing ProviderFailover
 * and ModelRouter for seamless operation.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type { ProviderFailover } from '../routing/provider-failover.js';
import type { ModelRouter } from '../routing/model-router.js';
import type {
  IProviderRegistry,
  LLMProviderAdapter,
  ProviderUsageRecord,
  ProviderStatus,
} from './provider-registry.js';

// ─── Internal Types ─────────────────────────────────────────────

interface RegisteredProvider {
  adapter: LLMProviderAdapter;
  priority: number;
  rateLimited: boolean;
  rateLimitedAt: number | null;
  totalTokensUsed: number;
  totalCostUsd: number;
  inFlightRequests: number;
}

// ─── Constants ──────────────────────────────────────────────────

/** Rate-limit cooldown period in milliseconds (5 minutes) */
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

/** Maximum time to wait for in-flight requests to drain during hot-swap (10 seconds) */
const HOT_SWAP_DRAIN_TIMEOUT_MS = 10_000;

/** Polling interval when waiting for in-flight requests to drain */
const DRAIN_POLL_INTERVAL_MS = 50;

// ─── Implementation ─────────────────────────────────────────────

export class ProviderRegistry implements IProviderRegistry {
  private providers: Map<string, RegisteredProvider> = new Map();
  private providerFailover: ProviderFailover | null;
  private modelRouter: ModelRouter | null;

  constructor(
    private db: Database.Database,
    private featureGate: FeatureGateSystem,
    providerFailover?: ProviderFailover | null,
    modelRouter?: ModelRouter | null,
  ) {
    this.providerFailover = providerFailover ?? null;
    this.modelRouter = modelRouter ?? null;
  }

  /**
   * Register a new LLM provider adapter with a given priority.
   *
   * Validates that the adapter implements the required interface methods:
   * chatCompletion, streamCompletion, countTokens.
   *
   * Lower priority numbers are preferred (higher priority).
   *
   * @throws Error if adapter does not implement required interface
   * @throws Error if provider with same ID is already registered
   *
   * Requirements: 7.1, 7.2
   */
  register(adapter: LLMProviderAdapter, priority: number): void {
    // Null-check guard: zero overhead when disabled (Req 7.7)
    if (!this.featureGate.isEnabled('provider_registry')) {
      return;
    }

    // Validate adapter implements required interface (Req 7.2)
    this.validateAdapter(adapter);

    if (this.providers.has(adapter.id)) {
      throw new Error(
        `Provider '${adapter.id}' is already registered. Unregister it first or use a different ID.`,
      );
    }

    this.providers.set(adapter.id, {
      adapter,
      priority,
      rateLimited: false,
      rateLimitedAt: null,
      totalTokensUsed: 0,
      totalCostUsd: 0,
      inFlightRequests: 0,
    });
  }

  /**
   * Unregister a provider by its ID.
   *
   * Removes the provider from the registry. Does nothing if not found.
   */
  unregister(providerId: string): void {
    // Null-check guard (Req 7.7)
    if (!this.featureGate.isEnabled('provider_registry')) {
      return;
    }

    this.providers.delete(providerId);
  }

  /**
   * Get a provider by ID or the best available provider by priority.
   *
   * When no providerId is specified, returns the highest-priority provider
   * that is not currently rate-limited. Implements automatic rate-limit
   * fallback: skips rate-limited providers and routes to the next available
   * one in priority order (Req 7.5).
   *
   * Rate-limited providers are reconsidered after a cooldown period.
   *
   * @param providerId - Optional specific provider to retrieve
   * @returns The provider adapter
   * @throws Error if no providers are available or specified provider not found
   *
   * Requirements: 7.1, 7.5
   */
  getProvider(providerId?: string): LLMProviderAdapter {
    // Null-check guard (Req 7.7)
    if (!this.featureGate.isEnabled('provider_registry')) {
      throw new Error('Provider registry feature is disabled.');
    }

    if (providerId) {
      const entry = this.providers.get(providerId);
      if (!entry) {
        throw new Error(`Provider '${providerId}' is not registered.`);
      }
      return entry.adapter;
    }

    // Get best available provider by priority, skipping rate-limited ones (Req 7.5)
    const sortedProviders = this.getSortedProviders();

    for (const entry of sortedProviders) {
      // Check if rate-limit cooldown has expired
      if (entry.rateLimited && entry.rateLimitedAt !== null) {
        const elapsed = Date.now() - entry.rateLimitedAt;
        if (elapsed >= RATE_LIMIT_COOLDOWN_MS) {
          // Cooldown expired — mark as available again
          entry.rateLimited = false;
          entry.rateLimitedAt = null;
        }
      }

      if (!entry.rateLimited) {
        return entry.adapter;
      }
    }

    // All providers are rate-limited — return the one with the longest cooldown elapsed
    // (closest to becoming available again)
    if (sortedProviders.length > 0) {
      const byElapsed = [...sortedProviders].sort((a, b) => {
        const elapsedA = a.rateLimitedAt ? Date.now() - a.rateLimitedAt : Infinity;
        const elapsedB = b.rateLimitedAt ? Date.now() - b.rateLimitedAt : Infinity;
        return elapsedB - elapsedA; // Most elapsed first
      });
      const best = byElapsed[0];
      if (best) {
        return best.adapter;
      }
    }

    throw new Error('No providers registered in the registry.');
  }

  /**
   * Get the status of all registered providers.
   *
   * Returns availability, rate-limit status, usage totals, and priority
   * for each registered provider.
   *
   * Requirements: 7.1
   */
  getStatus(): ProviderStatus[] {
    // Null-check guard (Req 7.7)
    if (!this.featureGate.isEnabled('provider_registry')) {
      return [];
    }

    const statuses: ProviderStatus[] = [];

    for (const [id, entry] of this.providers) {
      // Check cooldown expiry for accurate status
      let isRateLimited = entry.rateLimited;
      if (isRateLimited && entry.rateLimitedAt !== null) {
        const elapsed = Date.now() - entry.rateLimitedAt;
        if (elapsed >= RATE_LIMIT_COOLDOWN_MS) {
          isRateLimited = false;
          entry.rateLimited = false;
          entry.rateLimitedAt = null;
        }
      }

      statuses.push({
        id,
        name: entry.adapter.name,
        available: !isRateLimited,
        rateLimited: isRateLimited,
        totalTokensUsed: entry.totalTokensUsed,
        totalCostUsd: entry.totalCostUsd,
        priority: entry.priority,
      });
    }

    return statuses.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Record a usage event for a provider and persist it to SQLite.
   *
   * Updates in-memory totals and rate-limit status. When a usage record
   * indicates the provider is rate-limited, marks that provider as rate-limited
   * to enable automatic fallback routing (Req 7.5).
   *
   * Requirements: 7.4, 7.5
   */
  recordUsage(record: ProviderUsageRecord): void {
    // Null-check guard (Req 7.7)
    if (!this.featureGate.isEnabled('provider_registry')) {
      return;
    }

    // Persist to SQLite (Req 7.4)
    this.persistUsageRecord(record);

    // Update in-memory state
    const entry = this.providers.get(record.providerId);
    if (entry) {
      entry.totalTokensUsed += record.tokensUsed;
      entry.totalCostUsd += record.costUsd;

      // Mark as rate-limited if the record indicates it (Req 7.5)
      if (record.rateLimited) {
        entry.rateLimited = true;
        entry.rateLimitedAt = Date.now();
      }
    }
  }

  /**
   * Hot-swap from one provider to another, allowing in-flight requests on
   * the old provider to complete before routing new requests to the new one.
   *
   * The swap process:
   * 1. Validate both providers exist
   * 2. Wait for in-flight requests on the old provider to drain (with timeout)
   * 3. Swap priority values so new provider takes precedence
   *
   * This allows a brief session interruption for a clean transition (Req 7.3).
   *
   * @throws Error if either provider is not registered
   *
   * Requirements: 7.3
   */
  async hotSwap(fromProviderId: string, toProviderId: string): Promise<void> {
    // Null-check guard (Req 7.7)
    if (!this.featureGate.isEnabled('provider_registry')) {
      return;
    }

    const fromEntry = this.providers.get(fromProviderId);
    const toEntry = this.providers.get(toProviderId);

    if (!fromEntry) {
      throw new Error(`Source provider '${fromProviderId}' is not registered.`);
    }
    if (!toEntry) {
      throw new Error(`Target provider '${toProviderId}' is not registered.`);
    }

    // Wait for in-flight requests on the old provider to drain
    await this.drainInFlightRequests(fromEntry);

    // Swap priorities so the new provider takes over routing
    const fromPriority = fromEntry.priority;
    fromEntry.priority = toEntry.priority;
    toEntry.priority = fromPriority;

    // If the target has a higher (worse) priority number, ensure it becomes primary
    if (toEntry.priority > fromEntry.priority) {
      toEntry.priority = fromEntry.priority - 1;
    }
  }

  // ─── In-Flight Request Tracking ──────────────────────────────

  /**
   * Increment in-flight request counter for a provider.
   * Call this before making a request to enable hot-swap draining.
   */
  beginRequest(providerId: string): void {
    const entry = this.providers.get(providerId);
    if (entry) {
      entry.inFlightRequests++;
    }
  }

  /**
   * Decrement in-flight request counter for a provider.
   * Call this after a request completes (success or failure).
   */
  endRequest(providerId: string): void {
    const entry = this.providers.get(providerId);
    if (entry && entry.inFlightRequests > 0) {
      entry.inFlightRequests--;
    }
  }

  // ─── Integration with ProviderFailover & ModelRouter ──────────

  /**
   * Get the failover chain for the registry, integrating with
   * ProviderFailover and ModelRouter (Req 7.6).
   *
   * Returns providers sorted by priority, excluding rate-limited ones.
   */
  getFailoverChain(): Array<{ providerId: string; model: string }> {
    if (!this.featureGate.isEnabled('provider_registry')) {
      return [];
    }

    const sortedProviders = this.getSortedProviders();
    return sortedProviders
      .filter((entry) => !entry.rateLimited)
      .map((entry) => ({
        providerId: entry.adapter.id,
        model: entry.adapter.name,
      }));
  }

  /**
   * Get the ProviderFailover instance for external use.
   */
  getProviderFailover(): ProviderFailover | null {
    return this.providerFailover;
  }

  /**
   * Get the ModelRouter instance for external use.
   */
  getModelRouter(): ModelRouter | null {
    return this.modelRouter;
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Validate that an adapter implements the required LLMProviderAdapter interface.
   *
   * Required methods: chatCompletion, streamCompletion, countTokens
   * Required fields: id, name
   *
   * Requirements: 7.2
   */
  private validateAdapter(adapter: LLMProviderAdapter): void {
    if (!adapter) {
      throw new Error('Adapter must not be null or undefined.');
    }

    if (typeof adapter.id !== 'string' || adapter.id.trim() === '') {
      throw new Error('Adapter must have a non-empty string "id" property.');
    }

    if (typeof adapter.name !== 'string' || adapter.name.trim() === '') {
      throw new Error('Adapter must have a non-empty string "name" property.');
    }

    if (typeof adapter.chatCompletion !== 'function') {
      throw new Error(
        `Adapter '${adapter.id}' does not implement required method 'chatCompletion'.`,
      );
    }

    if (typeof adapter.streamCompletion !== 'function') {
      throw new Error(
        `Adapter '${adapter.id}' does not implement required method 'streamCompletion'.`,
      );
    }

    if (typeof adapter.countTokens !== 'function') {
      throw new Error(
        `Adapter '${adapter.id}' does not implement required method 'countTokens'.`,
      );
    }
  }

  /**
   * Get all providers sorted by priority (ascending — lower number = higher priority).
   */
  private getSortedProviders(): RegisteredProvider[] {
    return [...this.providers.values()].sort((a, b) => a.priority - b.priority);
  }

  /**
   * Wait for in-flight requests on a provider to drain, with a timeout.
   *
   * Polls every DRAIN_POLL_INTERVAL_MS until in-flight count reaches 0
   * or the timeout expires.
   */
  private async drainInFlightRequests(entry: RegisteredProvider): Promise<void> {
    if (entry.inFlightRequests <= 0) {
      return;
    }

    const deadline = Date.now() + HOT_SWAP_DRAIN_TIMEOUT_MS;

    while (entry.inFlightRequests > 0 && Date.now() < deadline) {
      await this.sleep(DRAIN_POLL_INTERVAL_MS);
    }
  }

  /**
   * Persist a usage record to the SQLite provider_usage table.
   *
   * Requirements: 7.4
   */
  private persistUsageRecord(record: ProviderUsageRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO provider_usage (id, provider_id, tokens_used, cost_usd, rate_limited, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      randomUUID(),
      record.providerId,
      record.tokensUsed,
      record.costUsd,
      record.rateLimited ? 1 : 0,
      record.timestamp,
    );
  }

  /**
   * Sleep utility for drain polling. Separated for testability.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
