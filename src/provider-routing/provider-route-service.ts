/**
 * ProviderRouteService — Capability-aware provider routing with resilient fallback.
 *
 * Selects per-role routes from registry capabilities, privacy, locality, trust,
 * health, context size, latency, cost, and user locks. Fallback chains are
 * pre-approved and monotonic in trust: a fallback may not expose data to a
 * less-trusted destination.
 *
 * Features:
 * - Independent routes for every configured role (R36.2)
 * - Auto-route with explanation and pause for unavailable providers (R36.3, R36.4)
 * - Trust-monotonic fallback that never silently weakens source-data trust (R36.5)
 * - Correlation, timeout, cancellation, retry classification, per-route concurrency (R36.6)
 * - Provider-appropriate token accounting (R36.7)
 * - Observed health based on success, error class, latency, and availability (R36.8)
 * - User locks at task/session level with disabled fallback (R36.9)
 * - Cost attribution to Task, Agent_Run, stage, role, and route (R36.10)
 *
 * Requirements: 36.1, 36.2, 36.3, 36.4, 36.5, 36.6, 36.7, 36.8, 36.9, 36.10
 */

import {
  type CostAttribution,
  type FallbackChainConfig,
  type FallbackEntry,
  type ModelRole,
  type ProviderCapabilities,
  type ProviderErrorClass,
  type ProviderHealthObservation,
  type ProviderRequestEnvelope,
  type ResponseMetadata,
  type RouteConcurrencyConfig,
  type RoutingConstraints,
  type RoutingDecision,
  type UserLock,
  TrustLevel,
  isRetryableError,
} from './types.js';

// ─── Constants ──────────────────────────────────────────────────

/** Maximum health observations retained per provider/model pair */
const MAX_HEALTH_OBSERVATIONS = 100;

/** Health score weight for recent observations (exponential decay) */
const HEALTH_DECAY_FACTOR = 0.95;

/** Minimum observations needed before health score influences routing */
const MIN_OBSERVATIONS_FOR_HEALTH = 5;

/** Default timeout for provider requests in milliseconds */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Default max concurrent requests per route */
const DEFAULT_MAX_CONCURRENT = 10;

/** Threshold below which a provider is considered unhealthy */
const UNHEALTHY_THRESHOLD = 0.3;

/** Threshold above which a provider recovers to healthy */
const HEALTHY_RECOVERY_THRESHOLD = 0.5;

// ─── ProviderRouteService ───────────────────────────────────────

export class ProviderRouteService {
  private providers: Map<string, ProviderCapabilities> = new Map();
  private fallbackChains: Map<ModelRole, FallbackChainConfig> = new Map();
  private healthObservations: Map<string, ProviderHealthObservation[]> = new Map();
  private userLocks: Map<string, UserLock> = new Map();
  private concurrency: Map<string, RouteConcurrencyConfig> = new Map();
  private costRecords: CostAttribution[] = [];
  private correlationCounter = 0;

  // ─── Provider Registration ──────────────────────────────────────

  /**
   * Register a provider with its capabilities.
   * Requirement 36.1: describe context, tools, structured output, images, etc.
   */
  registerProvider(capabilities: ProviderCapabilities): void {
    const key = this.providerKey(capabilities.providerId, capabilities.modelId);
    this.providers.set(key, { ...capabilities });
  }

  /**
   * Unregister a provider.
   */
  unregisterProvider(providerId: string, modelId: string): void {
    const key = this.providerKey(providerId, modelId);
    this.providers.delete(key);
  }

  /**
   * Get all registered providers.
   */
  getRegisteredProviders(): ProviderCapabilities[] {
    return Array.from(this.providers.values());
  }

  // ─── Fallback Chain Configuration ─────────────────────────────

  /**
   * Configure a pre-approved fallback chain for a role.
   * Validates that the chain is monotonic in trust.
   *
   * Requirement 36.5: Fallback never silently weakens source-data trust.
   *
   * @throws Error if the chain is not monotonically non-decreasing in trust level.
   */
  setFallbackChain(config: FallbackChainConfig): void {
    this.validateFallbackChainMonotonicity(config.chain);
    this.fallbackChains.set(config.role, { ...config });
  }

  /**
   * Get the fallback chain for a role.
   */
  getFallbackChain(role: ModelRole): FallbackChainConfig | undefined {
    return this.fallbackChains.get(role);
  }

  /**
   * Validate that a fallback chain is monotonically non-decreasing in trust level.
   * This ensures fallback never weakens source-data trust.
   *
   * @throws Error if the chain violates trust monotonicity
   */
  validateFallbackChainMonotonicity(chain: FallbackEntry[]): void {
    for (let i = 1; i < chain.length; i++) {
      const prev = chain[i - 1]!;
      const curr = chain[i]!;
      if (curr.trustLevel < prev.trustLevel) {
        throw new Error(
          `Fallback chain violates trust monotonicity: entry ${i} (trust=${curr.trustLevel}) ` +
          `is more trusted than entry ${i - 1} (trust=${prev.trustLevel}). ` +
          'Fallback must never expose data to a less-trusted destination.',
        );
      }
    }
  }

  // ─── User Locks ───────────────────────────────────────────────

  /**
   * Lock a role to a specific provider/model.
   * Requirement 36.9: lock a Task or session to a model and disable all fallback.
   */
  lockProvider(lock: UserLock): void {
    const key = this.lockKey(lock);
    this.userLocks.set(key, { ...lock });
  }

  /**
   * Unlock a role for a given scope.
   */
  unlockProvider(role: ModelRole, scope: 'global' | 'session' | 'task', scopeId?: string): void {
    const key = this.buildLockKey(role, scope, scopeId);
    this.userLocks.delete(key);
  }

  /**
   * Check if a role is locked for a given scope.
   */
  getLock(role: ModelRole, scope: 'global' | 'session' | 'task', scopeId?: string): UserLock | undefined {
    const key = this.buildLockKey(role, scope, scopeId);
    return this.userLocks.get(key);
  }

  // ─── Concurrency Management ───────────────────────────────────

  /**
   * Set the concurrency limit for a provider/model route.
   * Requirement 36.6: per-route concurrency limits.
   */
  setConcurrencyLimit(providerId: string, modelId: string, maxConcurrent: number): void {
    const key = this.providerKey(providerId, modelId);
    const existing = this.concurrency.get(key);
    this.concurrency.set(key, {
      maxConcurrent,
      activeCount: existing?.activeCount ?? 0,
    });
  }

  /**
   * Acquire a concurrency slot for a route. Returns false if at capacity.
   */
  acquireConcurrencySlot(providerId: string, modelId: string): boolean {
    const key = this.providerKey(providerId, modelId);
    const config = this.concurrency.get(key) ?? {
      maxConcurrent: DEFAULT_MAX_CONCURRENT,
      activeCount: 0,
    };

    if (config.activeCount >= config.maxConcurrent) {
      return false;
    }

    config.activeCount += 1;
    this.concurrency.set(key, config);
    return true;
  }

  /**
   * Release a concurrency slot for a route.
   */
  releaseConcurrencySlot(providerId: string, modelId: string): void {
    const key = this.providerKey(providerId, modelId);
    const config = this.concurrency.get(key);
    if (config && config.activeCount > 0) {
      config.activeCount -= 1;
      this.concurrency.set(key, config);
    }
  }

  /**
   * Get current concurrency state for a route.
   */
  getConcurrencyState(providerId: string, modelId: string): RouteConcurrencyConfig {
    const key = this.providerKey(providerId, modelId);
    return this.concurrency.get(key) ?? { maxConcurrent: DEFAULT_MAX_CONCURRENT, activeCount: 0 };
  }

  // ─── Provider Selection ───────────────────────────────────────

  /**
   * Select the best provider for the given constraints.
   *
   * Selection priority:
   * 1. User-locked provider (if set, with optional fallback disabling)
   * 2. Best matching provider from registry based on:
   *    - Capability match (required features)
   *    - Privacy/trust constraints
   *    - Health status
   *    - Latency requirements
   *    - Cost limits
   *    - Context size requirements
   *    - Route concurrency availability
   *
   * Requirement 36.3: Auto Route SHALL choose a model only when its capabilities
   * satisfy the Task and Tool_Manifest requirements and SHALL explain the selection.
   *
   * Requirement 36.4: When unavailable, rate limited, over budget, or incompatible,
   * pause or use a pre-approved privacy-preserving fallback.
   *
   * @returns RoutingDecision with selected provider, explanation, and pause state
   */
  selectProvider(
    constraints: RoutingConstraints,
    context?: { taskId?: string; sessionId?: string },
  ): RoutingDecision {
    // Check user locks in priority order: task > session > global
    const lock = this.resolveActiveLock(constraints, context);

    if (lock) {
      const lockedProvider = this.findProvider(lock.providerId, lock.modelId);
      if (lockedProvider && lockedProvider.healthy) {
        return this.buildDecision(
          lockedProvider,
          constraints.role,
          `User-locked provider selected: ${lockedProvider.providerName} (${lock.scope} scope)`,
          false,
          false,
        );
      }

      // Locked but unhealthy — if fallback disabled, pause
      if (lock.disableFallback || constraints.disableFallback) {
        if (lockedProvider) {
          return this.buildDecision(
            lockedProvider,
            constraints.role,
            `User-locked provider ${lockedProvider.providerName} is unhealthy; fallback is disabled`,
            false,
            true,
            `Provider '${lockedProvider.providerName}' is unhealthy and fallback is disabled by user lock`,
          );
        }
        return this.buildPausedDecision(
          constraints.role,
          `Locked provider '${lock.providerId}/${lock.modelId}' is not registered and fallback is disabled`,
        );
      }

      // Locked but unhealthy, fallback allowed — continue to normal routing
      if (lockedProvider) {
        // Try the locked provider anyway with a warning
        return this.buildDecision(
          lockedProvider,
          constraints.role,
          `User-locked provider selected (unhealthy — consider unlocking for automatic fallback)`,
          false,
          false,
        );
      }
    }

    // Filter and score providers
    const candidates = this.getCandidates(constraints);

    if (candidates.length > 0) {
      const best = candidates[0]!;
      // Verify concurrency availability
      const concurrencyAvailable = this.checkConcurrencyAvailable(
        best.provider.providerId,
        best.provider.modelId,
      );

      if (concurrencyAvailable) {
        return this.buildDecision(
          best.provider,
          constraints.role,
          best.explanation,
          false,
          false,
        );
      }

      // Best candidate is at capacity, try others
      for (let i = 1; i < candidates.length; i++) {
        const candidate = candidates[i]!;
        if (this.checkConcurrencyAvailable(candidate.provider.providerId, candidate.provider.modelId)) {
          return this.buildDecision(
            candidate.provider,
            constraints.role,
            `${candidate.explanation} (primary route at concurrency limit)`,
            false,
            false,
          );
        }
      }
    }

    // No direct candidates — try fallback chain
    if (!constraints.disableFallback) {
      const fallbackDecision = this.tryFallback(constraints);
      if (fallbackDecision) {
        return fallbackDecision;
      }
    }

    // No provider available — pause
    return this.buildPausedDecision(
      constraints.role,
      this.buildUnavailabilityReason(constraints),
    );
  }

  // ─── Request Envelope ─────────────────────────────────────────

  /**
   * Create a request envelope with correlation ID, timeout, and cancellation.
   * Requirement 36.6: correlation, timeout, cancellation.
   */
  createRequestEnvelope(
    routingDecision: RoutingDecision,
    options?: {
      timeoutMs?: number;
      taskId?: string;
      runId?: string;
      deliveryStage?: string;
    },
  ): ProviderRequestEnvelope {
    this.correlationCounter += 1;
    const envelope: ProviderRequestEnvelope = {
      correlationId: `req-${Date.now()}-${this.correlationCounter}`,
      role: routingDecision.role,
      routingDecision,
      timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      cancelled: false,
      createdAt: Date.now(),
    };
    if (options?.taskId !== undefined) envelope.taskId = options.taskId;
    if (options?.runId !== undefined) envelope.runId = options.runId;
    if (options?.deliveryStage !== undefined) envelope.deliveryStage = options.deliveryStage;
    return envelope;
  }

  /**
   * Cancel a request envelope.
   */
  cancelRequest(envelope: ProviderRequestEnvelope): void {
    envelope.cancelled = true;
  }

  /**
   * Check if a request has timed out.
   */
  isTimedOut(envelope: ProviderRequestEnvelope): boolean {
    return Date.now() - envelope.createdAt > envelope.timeoutMs;
  }

  // ─── Retry Classification ─────────────────────────────────────

  /**
   * Classify a provider error and determine if retry is appropriate.
   * Requirement 36.6: retry classification.
   */
  classifyError(error: unknown): ProviderErrorClass {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();

      if (msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests')) {
        return 'rate_limited';
      }
      if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('etimedout')) {
        return 'transient';
      }
      if (msg.includes('auth') || msg.includes('401') || msg.includes('403') || msg.includes('unauthorized')) {
        return 'auth_failure';
      }
      if (msg.includes('invalid') || msg.includes('400') || msg.includes('bad request')) {
        return 'invalid_request';
      }
      if (msg.includes('overloaded') || msg.includes('capacity') || msg.includes('busy')) {
        return 'model_overloaded';
      }
      if (msg.includes('context') && (msg.includes('length') || msg.includes('exceeded') || msg.includes('too long'))) {
        return 'context_exceeded';
      }
      if (msg.includes('content') && (msg.includes('filter') || msg.includes('policy') || msg.includes('moderation'))) {
        return 'content_filter';
      }
      if (msg.includes('cancel')) {
        return 'cancelled';
      }
      if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('internal server')) {
        return 'server_error';
      }
      if (msg.includes('network') || msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('socket')) {
        return 'network_error';
      }
    }
    return 'unknown';
  }

  /**
   * Determine if a given error class is retryable.
   */
  isRetryable(errorClass: ProviderErrorClass): boolean {
    return isRetryableError(errorClass);
  }

  // ─── Health Recording ─────────────────────────────────────────

  /**
   * Record a health observation for a provider.
   * Requirement 36.8: health based on observed success, error class,
   * first-token latency, completion latency, and recent availability.
   */
  recordHealthObservation(observation: ProviderHealthObservation): void {
    const key = this.providerKey(observation.providerId, observation.modelId);
    let observations = this.healthObservations.get(key);
    if (!observations) {
      observations = [];
      this.healthObservations.set(key, observations);
    }

    observations.push(observation);

    // Trim to max size
    if (observations.length > MAX_HEALTH_OBSERVATIONS) {
      observations.splice(0, observations.length - MAX_HEALTH_OBSERVATIONS);
    }

    // Update provider health score
    this.updateProviderHealth(key);
  }

  /**
   * Get the health observations for a provider.
   */
  getHealthObservations(providerId: string, modelId: string): ProviderHealthObservation[] {
    const key = this.providerKey(providerId, modelId);
    return this.healthObservations.get(key) ?? [];
  }

  // ─── Token Accounting and Cost ────────────────────────────────

  /**
   * Calculate cost using provider-appropriate token accounting.
   * Requirement 36.7: actual or provider-appropriate token accounting
   * rather than a single fixed character approximation.
   */
  calculateCost(
    providerId: string,
    modelId: string,
    inputTokens: number,
    outputTokens: number,
  ): number {
    const provider = this.findProvider(providerId, modelId);
    if (!provider) {
      // Fallback to generic estimation
      return ((inputTokens + outputTokens) / 1000) * 0.01;
    }

    const unit = provider.tokenPricingUnit || 1000;
    const inputCost = (inputTokens / unit) * provider.inputCostPerUnit;
    const outputCost = (outputTokens / unit) * provider.outputCostPerUnit;
    return inputCost + outputCost;
  }

  /**
   * Build response metadata for a completed request.
   * Requirement 36.7: provider-appropriate token accounting.
   * Requirement 36.10: cost attributed to Task, Agent_Run, stage, role, route.
   */
  buildResponseMetadata(params: {
    actualProvider: string;
    actualModel: string;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    role: ModelRole;
    usedFallback: boolean;
    correlationId: string;
    taskId?: string;
    runId?: string;
    deliveryStage?: string;
  }): ResponseMetadata {
    const provider = this.findProvider(params.actualProvider, params.actualModel);
    const healthScore = this.getProviderHealthScore(params.actualProvider, params.actualModel);
    const costUsd = this.calculateCost(
      params.actualProvider,
      params.actualModel,
      params.inputTokens,
      params.outputTokens,
    );
    const tokenAccountingMethod = provider?.tokenAccountingMethod ?? 'estimated';

    // Record cost attribution
    const costRecord: CostAttribution = {
      correlationId: params.correlationId,
      role: params.role,
      providerId: params.actualProvider,
      modelId: params.actualModel,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      costUsd,
      tokenAccountingMethod,
      timestamp: Date.now(),
    };
    if (params.taskId !== undefined) costRecord.taskId = params.taskId;
    if (params.runId !== undefined) costRecord.runId = params.runId;
    if (params.deliveryStage !== undefined) costRecord.deliveryStage = params.deliveryStage;
    this.recordCost(costRecord);

    const metadata: ResponseMetadata = {
      actualModel: params.actualModel,
      actualProvider: params.actualProvider,
      latencyMs: params.latencyMs,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      totalTokens: params.inputTokens + params.outputTokens,
      costUsd,
      confidence: healthScore,
      role: params.role,
      usedFallback: params.usedFallback,
      correlationId: params.correlationId,
      tokenAccountingMethod,
    };
    if (params.taskId !== undefined) metadata.taskId = params.taskId;
    if (params.runId !== undefined) metadata.runId = params.runId;
    if (params.deliveryStage !== undefined) metadata.deliveryStage = params.deliveryStage;
    return metadata;
  }

  // ─── Cost Attribution ─────────────────────────────────────────

  /**
   * Record a cost attribution entry.
   * Requirement 36.10: cost attributed without recording source content.
   */
  recordCost(attribution: CostAttribution): void {
    this.costRecords.push(attribution);
  }

  /**
   * Get cost records filtered by scope.
   */
  getCostRecords(filter?: {
    taskId?: string;
    runId?: string;
    role?: ModelRole;
    providerId?: string;
  }): CostAttribution[] {
    if (!filter) return [...this.costRecords];

    return this.costRecords.filter((r) => {
      if (filter.taskId && r.taskId !== filter.taskId) return false;
      if (filter.runId && r.runId !== filter.runId) return false;
      if (filter.role && r.role !== filter.role) return false;
      if (filter.providerId && r.providerId !== filter.providerId) return false;
      return true;
    });
  }

  /**
   * Get total cost for a task.
   */
  getTaskCost(taskId: string): number {
    return this.costRecords
      .filter((r) => r.taskId === taskId)
      .reduce((sum, r) => sum + r.costUsd, 0);
  }

  /**
   * Get total cost for a run.
   */
  getRunCost(runId: string): number {
    return this.costRecords
      .filter((r) => r.runId === runId)
      .reduce((sum, r) => sum + r.costUsd, 0);
  }

  // ─── Trust Verification ───────────────────────────────────────

  /**
   * Verify that a routing decision does not weaken source-data trust.
   * This is the proof that fallback never silently weakens trust.
   *
   * Requirement 36.5: Fallback SHALL never silently move source context
   * from a local or trusted route to a less-trusted external provider.
   *
   * @returns true if the decision is safe, false if it would weaken trust
   */
  verifyTrustPreservation(
    originalTrustLevel: TrustLevel,
    decision: RoutingDecision,
  ): boolean {
    // The decision's trust level must not exceed (be less trusted than) the original
    return decision.trustLevel <= originalTrustLevel;
  }

  /**
   * Assert that a fallback chain preserves trust for a given starting trust level.
   * Used to prove the invariant at configuration time.
   */
  assertFallbackPreservesTrust(
    startingTrustLevel: TrustLevel,
    chain: FallbackEntry[],
  ): { valid: boolean; violations: string[] } {
    const violations: string[] = [];

    for (let i = 0; i < chain.length; i++) {
      const entry = chain[i]!;
      if (entry.trustLevel < startingTrustLevel) {
        // This would mean moving to a MORE trusted provider — this is safe
        continue;
      }
      if (entry.trustLevel > startingTrustLevel) {
        violations.push(
          `Entry ${i} (${entry.providerId}/${entry.modelId}) has trust=${entry.trustLevel} ` +
          `which is less trusted than starting level=${startingTrustLevel}`,
        );
      }
    }

    // Also verify monotonicity within the chain
    for (let i = 1; i < chain.length; i++) {
      const prev = chain[i - 1]!;
      const curr = chain[i]!;
      if (curr.trustLevel < prev.trustLevel) {
        violations.push(
          `Entry ${i} (trust=${curr.trustLevel}) is more trusted than entry ${i - 1} (trust=${prev.trustLevel}) — non-monotonic`,
        );
      }
    }

    return { valid: violations.length === 0, violations };
  }

  // ─── Private Methods ──────────────────────────────────────────

  private providerKey(providerId: string, modelId: string): string {
    return `${providerId}::${modelId}`;
  }

  private lockKey(lock: UserLock): string {
    return this.buildLockKey(lock.role, lock.scope, lock.taskId ?? lock.sessionId);
  }

  private buildLockKey(role: ModelRole, scope: string, scopeId?: string): string {
    return `${role}::${scope}::${scopeId ?? 'global'}`;
  }

  /**
   * Resolve the most specific active lock for the given constraints and context.
   * Priority: task lock > session lock > global lock > constraints lock
   */
  private resolveActiveLock(
    constraints: RoutingConstraints,
    context?: { taskId?: string; sessionId?: string },
  ): UserLock | undefined {
    // Check constraint-level lock first (explicit in request)
    if (constraints.lockedProviderId) {
      return {
        role: constraints.role,
        providerId: constraints.lockedProviderId,
        modelId: constraints.lockedModelId ?? '',
        scope: 'global',
        disableFallback: constraints.disableFallback ?? false,
      };
    }

    // Task-level lock (most specific)
    if (context?.taskId) {
      const taskLock = this.userLocks.get(this.buildLockKey(constraints.role, 'task', context.taskId));
      if (taskLock) return taskLock;
    }

    // Session-level lock
    if (context?.sessionId) {
      const sessionLock = this.userLocks.get(this.buildLockKey(constraints.role, 'session', context.sessionId));
      if (sessionLock) return sessionLock;
    }

    // Global lock
    const globalLock = this.userLocks.get(this.buildLockKey(constraints.role, 'global'));
    return globalLock;
  }

  private findProvider(providerId: string, modelId?: string): ProviderCapabilities | undefined {
    if (modelId) {
      return this.providers.get(this.providerKey(providerId, modelId));
    }
    for (const provider of this.providers.values()) {
      if (provider.providerId === providerId) {
        return provider;
      }
    }
    return undefined;
  }

  private checkConcurrencyAvailable(providerId: string, modelId: string): boolean {
    const key = this.providerKey(providerId, modelId);
    const config = this.concurrency.get(key);
    if (!config) return true; // No limit configured
    return config.activeCount < config.maxConcurrent;
  }

  /**
   * Get candidates that match the given constraints, scored and sorted.
   */
  private getCandidates(
    constraints: RoutingConstraints,
  ): Array<{ provider: ProviderCapabilities; score: number; explanation: string }> {
    const results: Array<{ provider: ProviderCapabilities; score: number; explanation: string }> = [];

    for (const provider of this.providers.values()) {
      const matchResult = this.matchesConstraints(provider, constraints);
      if (matchResult.matches) {
        const score = this.scoreProvider(provider, constraints);
        results.push({
          provider,
          score,
          explanation: matchResult.explanation,
        });
      }
    }

    // Sort by score descending (higher is better)
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Check if a provider matches the given constraints.
   */
  private matchesConstraints(
    provider: ProviderCapabilities,
    constraints: RoutingConstraints,
  ): { matches: boolean; explanation: string } {
    const reasons: string[] = [];

    // Must support the requested role
    if (!provider.supportedRoles.includes(constraints.role)) {
      return { matches: false, explanation: `Does not support role '${constraints.role}'` };
    }

    // Must be healthy
    if (!provider.healthy) {
      return { matches: false, explanation: 'Provider is unhealthy' };
    }

    // Context size check
    if (constraints.minContextSize && provider.contextWindow < constraints.minContextSize) {
      return { matches: false, explanation: `Context window ${provider.contextWindow} < required ${constraints.minContextSize}` };
    }

    // Trust/privacy constraint
    if (constraints.maxTrustLevel !== undefined && provider.trustLevel > constraints.maxTrustLevel) {
      return { matches: false, explanation: `Trust level ${provider.trustLevel} exceeds max ${constraints.maxTrustLevel}` };
    }

    // Locality constraint
    if (constraints.requiredLocality && provider.locality !== constraints.requiredLocality) {
      return { matches: false, explanation: `Locality '${provider.locality}' != required '${constraints.requiredLocality}'` };
    }

    // Latency constraint
    if (constraints.maxLatencyMs && provider.observedLatencyMs > constraints.maxLatencyMs) {
      return { matches: false, explanation: `Observed latency ${provider.observedLatencyMs}ms > max ${constraints.maxLatencyMs}ms` };
    }

    // Cost constraint
    if (constraints.maxCostPer1kTokens && provider.costPer1kTokens > constraints.maxCostPer1kTokens) {
      return { matches: false, explanation: `Cost ${provider.costPer1kTokens} > max ${constraints.maxCostPer1kTokens}` };
    }

    // Capability constraints
    if (constraints.requireToolCalling && !provider.toolCalling) {
      return { matches: false, explanation: 'Does not support tool calling' };
    }
    if (constraints.requireStructuredOutput && !provider.structuredOutput) {
      return { matches: false, explanation: 'Does not support structured output' };
    }
    if (constraints.requireImageSupport && !provider.imageSupport) {
      return { matches: false, explanation: 'Does not support image input' };
    }
    if (constraints.requireEditSuitability && !provider.editSuitability) {
      return { matches: false, explanation: 'Not suitable for edit tasks' };
    }
    if (constraints.requireReasoningControls && !provider.reasoningControls) {
      return { matches: false, explanation: 'Does not support reasoning controls' };
    }

    // Build explanation for selection
    reasons.push(`Supports role '${constraints.role}'`);
    reasons.push(`trust=${TrustLevel[provider.trustLevel]}`);
    reasons.push(`latency=${provider.observedLatencyMs}ms`);
    reasons.push(`cost=$${provider.costPer1kTokens}/1k`);
    reasons.push(`health=${(provider.healthScore * 100).toFixed(0)}%`);
    if (provider.toolCalling) reasons.push('tools');
    if (provider.structuredOutput) reasons.push('structured-output');
    if (provider.imageSupport) reasons.push('images');
    if (provider.editSuitability) reasons.push('edit/FIM');
    if (provider.reasoningControls) reasons.push('reasoning');

    return { matches: true, explanation: reasons.join(', ') };
  }

  /**
   * Score a provider for ranking. Higher score = better match.
   */
  private scoreProvider(provider: ProviderCapabilities, constraints: RoutingConstraints): number {
    let score = 0;

    // Health score (0-30 points)
    score += provider.healthScore * 30;

    // Availability score (0-20 points)
    score += provider.availability * 20;

    // Latency score (0-20 points)
    if (constraints.maxLatencyMs) {
      const latencyRatio = 1 - (provider.observedLatencyMs / constraints.maxLatencyMs);
      score += Math.max(0, latencyRatio) * 20;
    } else {
      const latencyScore = Math.max(0, 1 - (provider.observedLatencyMs / 5000));
      score += latencyScore * 20;
    }

    // Cost score (0-15 points)
    if (constraints.maxCostPer1kTokens) {
      const costRatio = 1 - (provider.costPer1kTokens / constraints.maxCostPer1kTokens);
      score += Math.max(0, costRatio) * 15;
    } else {
      const costScore = Math.max(0, 1 - (provider.costPer1kTokens / 0.1));
      score += costScore * 15;
    }

    // Trust score (0-15 points) — more trusted is better
    const trustScore = 1 - (provider.trustLevel / TrustLevel.External);
    score += trustScore * 15;

    return score;
  }

  /**
   * Try to find a provider through the pre-approved fallback chain.
   * Ensures the fallback never weakens trust (Requirement 36.5).
   */
  private tryFallback(constraints: RoutingConstraints): RoutingDecision | null {
    const chainConfig = this.fallbackChains.get(constraints.role);
    if (!chainConfig) {
      return null;
    }

    // Apply trust constraint from the original constraints
    const maxTrust = constraints.maxTrustLevel ?? chainConfig.maxTrustLevel;

    for (const entry of chainConfig.chain) {
      // Enforce trust monotonicity — never weaken trust
      if (entry.trustLevel > maxTrust) {
        continue;
      }

      const provider = this.findProvider(entry.providerId, entry.modelId);
      if (provider && provider.healthy) {
        // Verify concurrency
        if (!this.checkConcurrencyAvailable(provider.providerId, provider.modelId)) {
          continue;
        }

        return this.buildDecision(
          provider,
          constraints.role,
          `Fallback: ${provider.providerName} (trust=${TrustLevel[provider.trustLevel]}, preserves privacy constraints)`,
          true,
          false,
        );
      }
    }

    return null;
  }

  private buildDecision(
    provider: ProviderCapabilities,
    role: ModelRole,
    explanation: string,
    isFallback: boolean,
    paused: boolean,
    pauseReason?: string,
  ): RoutingDecision {
    const chainConfig = this.fallbackChains.get(role);
    const fallbackChain: FallbackEntry[] = chainConfig?.chain ?? [];

    const decision: RoutingDecision = {
      providerId: provider.providerId,
      modelId: provider.modelId,
      providerName: provider.providerName,
      role,
      trustLevel: provider.trustLevel,
      explanation,
      isFallback,
      fallbackChain,
      paused,
    };
    if (pauseReason !== undefined) decision.pauseReason = pauseReason;
    return decision;
  }

  private buildPausedDecision(role: ModelRole, pauseReason: string): RoutingDecision {
    const chainConfig = this.fallbackChains.get(role);
    const fallbackChain: FallbackEntry[] = chainConfig?.chain ?? [];

    return {
      providerId: '',
      modelId: '',
      providerName: '',
      role,
      trustLevel: TrustLevel.External,
      explanation: `Paused: ${pauseReason}`,
      isFallback: false,
      fallbackChain,
      paused: true,
      pauseReason,
    };
  }

  private buildUnavailabilityReason(constraints: RoutingConstraints): string {
    const parts: string[] = [`No provider available for role '${constraints.role}'`];

    if (constraints.maxTrustLevel !== undefined) {
      parts.push(`max trust=${TrustLevel[constraints.maxTrustLevel]}`);
    }
    if (constraints.requiredLocality) {
      parts.push(`locality=${constraints.requiredLocality}`);
    }
    if (constraints.requireToolCalling) parts.push('requires tool calling');
    if (constraints.requireStructuredOutput) parts.push('requires structured output');
    if (constraints.requireImageSupport) parts.push('requires image support');
    if (constraints.requireEditSuitability) parts.push('requires edit suitability');
    if (constraints.requireReasoningControls) parts.push('requires reasoning controls');
    if (constraints.maxLatencyMs) parts.push(`max latency=${constraints.maxLatencyMs}ms`);
    if (constraints.maxCostPer1kTokens) parts.push(`max cost=$${constraints.maxCostPer1kTokens}/1k`);
    if (constraints.disableFallback) parts.push('fallback disabled');

    return parts.join('; ');
  }

  /**
   * Update provider health score based on observations.
   */
  private updateProviderHealth(providerKey: string): void {
    const observations = this.healthObservations.get(providerKey);
    if (!observations || observations.length === 0) {
      return;
    }

    // Calculate weighted health score using exponential decay
    let weightedSuccesses = 0;
    let totalWeight = 0;

    for (let i = 0; i < observations.length; i++) {
      const weight = Math.pow(HEALTH_DECAY_FACTOR, observations.length - 1 - i);
      totalWeight += weight;
      if (observations[i]!.success) {
        weightedSuccesses += weight;
      }
    }

    const healthScore = totalWeight > 0 ? weightedSuccesses / totalWeight : 1;

    // Calculate average observed latency from recent successful observations
    const recentSuccessful = observations.filter(o => o.success).slice(-20);
    const avgLatency = recentSuccessful.length > 0
      ? recentSuccessful.reduce((sum, o) => sum + o.completionLatencyMs, 0) / recentSuccessful.length
      : 0;

    // Calculate availability from all observations
    const recentAll = observations.slice(-50);
    const availabilityScore = recentAll.length > 0
      ? recentAll.filter(o => o.success).length / recentAll.length
      : 1;

    // Update all providers matching this key
    for (const [key, provider] of this.providers.entries()) {
      if (key === providerKey) {
        provider.healthScore = healthScore;
        provider.availability = availabilityScore;
        if (avgLatency > 0) {
          provider.observedLatencyMs = avgLatency;
        }
        // Mark unhealthy if score drops below threshold with enough observations
        if (observations.length >= MIN_OBSERVATIONS_FOR_HEALTH && healthScore < UNHEALTHY_THRESHOLD) {
          provider.healthy = false;
        } else if (healthScore >= HEALTHY_RECOVERY_THRESHOLD) {
          provider.healthy = true;
        }
      }
    }
  }

  /**
   * Get the health score for a provider.
   */
  private getProviderHealthScore(providerId: string, modelId: string): number {
    const key = this.providerKey(providerId, modelId);
    const observations = this.healthObservations.get(key);
    if (!observations || observations.length < MIN_OBSERVATIONS_FOR_HEALTH) {
      return 1.0;
    }

    let weightedSuccesses = 0;
    let totalWeight = 0;

    for (let i = 0; i < observations.length; i++) {
      const weight = Math.pow(HEALTH_DECAY_FACTOR, observations.length - 1 - i);
      totalWeight += weight;
      if (observations[i]!.success) {
        weightedSuccesses += weight;
      }
    }

    return totalWeight > 0 ? weightedSuccesses / totalWeight : 1.0;
  }
}
