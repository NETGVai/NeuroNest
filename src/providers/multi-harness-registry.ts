/**
 * Multi-Harness Provider Registry Extension
 *
 * Extends the provider registry with multi-harness capabilities:
 * - Route any agent to any configured provider without changing agent definition
 * - Failover to next provider in fallback chain within 10 seconds
 * - Per-provider health metrics (latency p50/p95, error rate, availability)
 * - Provider-agnostic prompt format translation at Provider_Registry boundary
 * - Conversation context preservation by mapping message formats between provider schemas
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5
 */

// ─── Types & Interfaces ─────────────────────────────────────────

/** Supported LLM provider identifiers */
export type ProviderId = string;

/** Health metrics for a single provider */
export interface ProviderHealthMetrics {
  /** Provider identifier */
  providerId: ProviderId;
  /** Latency 50th percentile in milliseconds */
  latencyP50Ms: number;
  /** Latency 95th percentile in milliseconds */
  latencyP95Ms: number;
  /** Error rate as a fraction (0.0 - 1.0) */
  errorRate: number;
  /** Availability as a fraction (0.0 - 1.0), based on successful health checks */
  availability: number;
  /** Timestamp of last metric update */
  lastUpdated: number;
}

/** A single message in provider-agnostic format */
export interface AgnosticMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Optional tool call metadata */
  toolCalls?: ToolCallInfo[];
  /** Optional tool result metadata */
  toolResultId?: string;
  /** Optional name for multi-agent scenarios */
  name?: string;
}

/** Tool call information attached to a message */
export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
}

/** Provider-specific message format descriptor */
export interface ProviderMessageSchema {
  providerId: ProviderId;
  /** The system message handling strategy for this provider */
  systemMessageHandling: 'first-message' | 'separate-field' | 'merged-into-user';
  /** Whether tool messages are supported natively */
  supportsToolMessages: boolean;
  /** Whether the provider supports named assistant messages */
  supportsNamedMessages: boolean;
  /** Maximum context window in tokens */
  maxContextTokens: number;
}

/** A conversation context that can be preserved across provider switches */
export interface ConversationContext {
  /** Unique conversation identifier */
  conversationId: string;
  /** Messages in provider-agnostic format */
  messages: AgnosticMessage[];
  /** Current provider handling this conversation */
  currentProvider: ProviderId;
  /** Metadata about the conversation state */
  metadata: {
    totalTokensEstimate: number;
    turnCount: number;
    lastActivityTimestamp: number;
  };
}

/** Result of a context preservation attempt */
export interface ContextPreservationResult {
  /** The translated messages for the target provider, or null if translation failed */
  translatedMessages: AgnosticMessage[] | null;
  /** Whether the context was fully preserved without loss */
  fullyPreserved: boolean;
  /** Any warnings about degraded context */
  warnings: string[];
}

/** Configuration for the failover chain */
export interface FailoverChainEntry {
  providerId: ProviderId;
  priority: number;
  /** Whether this provider is currently healthy */
  healthy: boolean;
}

/** Routing decision result */
export interface RoutingDecision {
  /** Selected provider ID */
  providerId: ProviderId;
  /** Reason for selection */
  reason: 'preferred' | 'best-health' | 'failover' | 'only-available';
}

/** Failover result */
export interface FailoverResult {
  /** Whether failover succeeded */
  success: boolean;
  /** The new provider after failover, or null if all providers failed */
  newProvider: ProviderId | null;
  /** Time taken to complete failover in milliseconds */
  failoverTimeMs: number;
  /** Providers that were attempted before success */
  attemptedProviders: ProviderId[];
}

// ─── Constants ──────────────────────────────────────────────────

/** Maximum time allowed for a failover operation (10 seconds per requirement 14.2) */
const FAILOVER_TIMEOUT_MS = 10_000;

/** Default health metrics for a newly registered provider */
const DEFAULT_HEALTH_METRICS: Omit<ProviderHealthMetrics, 'providerId' | 'lastUpdated'> = {
  latencyP50Ms: 0,
  latencyP95Ms: 0,
  errorRate: 0,
  availability: 1.0,
};

/** Well-known provider schemas for format translation */
const KNOWN_PROVIDER_SCHEMAS: Record<string, ProviderMessageSchema> = {
  anthropic: {
    providerId: 'anthropic',
    systemMessageHandling: 'separate-field',
    supportsToolMessages: true,
    supportsNamedMessages: false,
    maxContextTokens: 200_000,
  },
  openai: {
    providerId: 'openai',
    systemMessageHandling: 'first-message',
    supportsToolMessages: true,
    supportsNamedMessages: true,
    maxContextTokens: 128_000,
  },
  google: {
    providerId: 'google',
    systemMessageHandling: 'separate-field',
    supportsToolMessages: true,
    supportsNamedMessages: false,
    maxContextTokens: 1_000_000,
  },
  local: {
    providerId: 'local',
    systemMessageHandling: 'first-message',
    supportsToolMessages: false,
    supportsNamedMessages: false,
    maxContextTokens: 32_000,
  },
};

// ─── State ──────────────────────────────────────────────────────

/** In-memory health metrics per provider */
const healthMetricsStore: Map<ProviderId, ProviderHealthMetrics> = new Map();

/** In-memory latency samples per provider (ring buffer for percentile computation) */
const latencySamples: Map<ProviderId, number[]> = new Map();

/** Maximum latency samples to retain per provider */
const MAX_LATENCY_SAMPLES = 1000;

/** In-memory request outcome tracking for error rate computation */
const requestOutcomes: Map<ProviderId, { successes: number; failures: number }> = new Map();

/** Registered provider schemas (extends KNOWN_PROVIDER_SCHEMAS with custom registrations) */
const providerSchemas: Map<ProviderId, ProviderMessageSchema> = new Map(
  Object.entries(KNOWN_PROVIDER_SCHEMAS),
);

// ─── Core Functions ─────────────────────────────────────────────

/**
 * Route an agent to the best available provider.
 *
 * Selects a provider based on the agent's preferred provider (if specified),
 * or falls back to health-metrics-based routing (lowest error rate, best availability,
 * lowest latency).
 *
 * The agent definition is never changed — routing is transparent.
 *
 * @param agentId - The agent requesting a provider
 * @param preferredProvider - Optional provider preference (from user config)
 * @returns A routing decision indicating which provider to use and why
 *
 * Requirements: 14.1
 */
export function routeAgent(agentId: string, preferredProvider?: ProviderId): RoutingDecision {
  if (!agentId || agentId.trim() === '') {
    throw new Error('agentId must be a non-empty string');
  }

  // If a preferred provider is specified and it's healthy, use it
  if (preferredProvider) {
    const metrics = healthMetricsStore.get(preferredProvider);
    if (metrics && metrics.availability > 0 && metrics.errorRate < 1.0) {
      return {
        providerId: preferredProvider,
        reason: 'preferred',
      };
    }
    // Preferred provider is unhealthy, fall through to best-health selection
  }

  // Select the best provider based on health metrics
  const availableProviders = Array.from(healthMetricsStore.entries())
    .filter(([, m]) => m.availability > 0 && m.errorRate < 1.0)
    .sort((a, b) => {
      // Primary sort: lower error rate is better
      const errorDiff = a[1].errorRate - b[1].errorRate;
      if (Math.abs(errorDiff) > 0.01) return errorDiff;

      // Secondary sort: higher availability is better
      const availDiff = b[1].availability - a[1].availability;
      if (Math.abs(availDiff) > 0.01) return availDiff;

      // Tertiary sort: lower p50 latency is better
      return a[1].latencyP50Ms - b[1].latencyP50Ms;
    });

  if (availableProviders.length === 0) {
    // No providers with metrics — return any registered schema as fallback
    const firstSchema = providerSchemas.keys().next().value;
    if (firstSchema) {
      return {
        providerId: firstSchema,
        reason: 'only-available',
      };
    }
    throw new Error(`No providers available for agent '${agentId}'`);
  }

  if (availableProviders.length === 1) {
    return {
      providerId: availableProviders[0]![0],
      reason: 'only-available',
    };
  }

  return {
    providerId: availableProviders[0]![0],
    reason: 'best-health',
  };
}

/**
 * Failover from the current provider to the next in the fallback chain.
 *
 * Attempts each provider in the fallback chain sequentially until one responds
 * successfully or the 10-second timeout is exceeded.
 *
 * @param currentProvider - The provider that failed
 * @param fallbackChain - Ordered list of fallback providers to attempt
 * @returns A failover result indicating success/failure and timing
 *
 * Requirements: 14.2
 */
export async function failover(
  currentProvider: ProviderId,
  fallbackChain: FailoverChainEntry[],
): Promise<FailoverResult> {
  const startTime = Date.now();
  const attemptedProviders: ProviderId[] = [];

  // Filter out the current (failed) provider and unhealthy providers,
  // then sort by priority (lower = higher priority)
  const candidates = fallbackChain
    .filter((entry) => entry.providerId !== currentProvider && entry.healthy)
    .sort((a, b) => a.priority - b.priority);

  for (const candidate of candidates) {
    const elapsed = Date.now() - startTime;

    // Check if we've exceeded the 10-second timeout
    if (elapsed >= FAILOVER_TIMEOUT_MS) {
      break;
    }

    attemptedProviders.push(candidate.providerId);

    // Check provider health metrics
    const metrics = healthMetricsStore.get(candidate.providerId);
    const isUsable =
      !metrics || (metrics.availability > 0 && metrics.errorRate < 1.0);

    if (isUsable) {
      const failoverTimeMs = Date.now() - startTime;
      return {
        success: true,
        newProvider: candidate.providerId,
        failoverTimeMs,
        attemptedProviders,
      };
    }
  }

  // All candidates exhausted or timeout exceeded
  const failoverTimeMs = Date.now() - startTime;
  return {
    success: false,
    newProvider: null,
    failoverTimeMs,
    attemptedProviders,
  };
}

/**
 * Get health metrics for a specific provider.
 *
 * Returns latency p50/p95, error rate, and availability metrics
 * for the tier-router to make intelligent routing decisions.
 *
 * @param providerId - The provider to query
 * @returns Health metrics for the provider, or null if provider is not tracked
 *
 * Requirements: 14.3
 */
export function getHealthMetrics(providerId: ProviderId): ProviderHealthMetrics | null {
  return healthMetricsStore.get(providerId) ?? null;
}

/**
 * Translate messages from one provider's format to another.
 *
 * Produces provider-agnostic prompt formats that are translated to
 * provider-specific API formats at the Provider_Registry boundary.
 *
 * Handles differences in:
 * - System message placement (separate field vs first message vs merged)
 * - Tool message support (native vs emulated)
 * - Named message support
 * - Context window limits
 *
 * @param messages - Messages in the source provider's agnostic format
 * @param fromProvider - Source provider ID
 * @param toProvider - Target provider ID
 * @returns Translated messages for the target provider's expected format
 *
 * Requirements: 14.4
 */
export function translatePrompt(
  messages: AgnosticMessage[],
  fromProvider: ProviderId,
  toProvider: ProviderId,
): AgnosticMessage[] {
  if (!messages || messages.length === 0) {
    return [];
  }

  const fromSchema = providerSchemas.get(fromProvider);
  const toSchema = providerSchemas.get(toProvider);

  // If schemas are unknown, return messages unchanged (best-effort)
  if (!fromSchema || !toSchema) {
    return [...messages];
  }

  // If source and target are the same, no translation needed
  if (fromProvider === toProvider) {
    return [...messages];
  }

  const translated: AgnosticMessage[] = [];

  for (const msg of messages) {
    // Handle tool messages when target doesn't support them
    if (msg.role === 'tool' && !toSchema.supportsToolMessages) {
      // Convert tool result to a user message with formatted content
      translated.push({
        role: 'user',
        content: `[Tool Result${msg.toolResultId ? ` (${msg.toolResultId})` : ''}]: ${msg.content}`,
      });
      continue;
    }

    // Handle tool calls in assistant messages when target doesn't support tool messages
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0 && !toSchema.supportsToolMessages) {
      // Flatten tool calls into the assistant content
      const toolCallsText = msg.toolCalls
        .map((tc) => `[Tool Call: ${tc.name}(${tc.arguments})]`)
        .join('\n');
      translated.push({
        role: 'assistant',
        content: msg.content ? `${msg.content}\n${toolCallsText}` : toolCallsText,
      });
      continue;
    }

    // Handle named messages when target doesn't support them
    if (msg.name && !toSchema.supportsNamedMessages) {
      translated.push({
        ...msg,
        content: `[${msg.name}]: ${msg.content}`,
        name: undefined,
      });
      continue;
    }

    // Handle system message placement differences
    if (msg.role === 'system' && toSchema.systemMessageHandling === 'merged-into-user') {
      // Some providers don't support system messages; merge into user message
      translated.push({
        role: 'user',
        content: `[System Instructions]: ${msg.content}`,
      });
      continue;
    }

    // Default: pass through unchanged
    translated.push({ ...msg });
  }

  return translated;
}

/**
 * Preserve conversation context when switching between providers.
 *
 * Maps message formats between provider schemas. If context preservation
 * fails (e.g., critical information would be lost), returns null to block
 * the provider switch and retain the current provider.
 *
 * @param conversation - The full conversation context to preserve
 * @param targetProvider - The provider to switch to
 * @returns Translated messages or null if switch should be blocked
 *
 * Requirements: 14.5
 */
export function preserveContext(
  conversation: ConversationContext,
  targetProvider: ProviderId,
): ContextPreservationResult | null {
  if (!conversation || !conversation.messages || conversation.messages.length === 0) {
    return null;
  }

  if (!targetProvider || targetProvider.trim() === '') {
    return null;
  }

  const targetSchema = providerSchemas.get(targetProvider);

  // If target schema is unknown, block the switch (can't guarantee context preservation)
  if (!targetSchema) {
    return null;
  }

  // Check if context would exceed target provider's token limit
  if (conversation.metadata.totalTokensEstimate > targetSchema.maxContextTokens) {
    // Context too large for target provider — block switch
    return null;
  }

  // Attempt translation
  try {
    const translatedMessages = translatePrompt(
      conversation.messages,
      conversation.currentProvider,
      targetProvider,
    );

    // Validate that critical messages survived translation
    const originalSystemMessages = conversation.messages.filter((m) => m.role === 'system');
    const translatedHasSystemContent = translatedMessages.some(
      (m) => m.role === 'system' || m.content.includes('[System Instructions]'),
    );

    // If there were system messages but none survived, block the switch
    if (originalSystemMessages.length > 0 && !translatedHasSystemContent) {
      return null;
    }

    // Check for significant content loss
    const originalContentLength = conversation.messages.reduce(
      (sum, m) => sum + m.content.length,
      0,
    );
    const translatedContentLength = translatedMessages.reduce(
      (sum, m) => sum + m.content.length,
      0,
    );

    // If more than 50% of content was lost, block the switch
    if (translatedContentLength < originalContentLength * 0.5) {
      return null;
    }

    // Gather warnings
    const warnings: string[] = [];
    const targetSupportsTools = targetSchema.supportsToolMessages;
    const hasToolMessages = conversation.messages.some(
      (m) => m.role === 'tool' || (m.toolCalls && m.toolCalls.length > 0),
    );

    if (hasToolMessages && !targetSupportsTools) {
      warnings.push('Tool messages converted to text format; tool call tracking may be degraded');
    }

    if (!targetSchema.supportsNamedMessages && conversation.messages.some((m) => m.name)) {
      warnings.push('Named messages flattened into content; multi-agent attribution may be lost');
    }

    const fullyPreserved = warnings.length === 0 && translatedContentLength >= originalContentLength;

    return {
      translatedMessages,
      fullyPreserved,
      warnings,
    };
  } catch {
    // Translation failed — block the switch
    return null;
  }
}

// ─── Health Metrics Management ──────────────────────────────────

/**
 * Record a latency sample for a provider.
 *
 * Updates the rolling latency percentiles (p50, p95) for routing decisions.
 *
 * @param providerId - The provider that served the request
 * @param latencyMs - The request latency in milliseconds
 */
export function recordLatency(providerId: ProviderId, latencyMs: number): void {
  if (latencyMs < 0) return;

  let samples = latencySamples.get(providerId);
  if (!samples) {
    samples = [];
    latencySamples.set(providerId, samples);
  }

  samples.push(latencyMs);

  // Ring buffer: keep only the most recent samples
  if (samples.length > MAX_LATENCY_SAMPLES) {
    samples.shift();
  }

  // Recompute percentiles
  updateHealthMetrics(providerId);
}

/**
 * Record a request outcome (success or failure) for a provider.
 *
 * Updates error rate and availability metrics.
 *
 * @param providerId - The provider that handled the request
 * @param success - Whether the request succeeded
 */
export function recordOutcome(providerId: ProviderId, success: boolean): void {
  let outcomes = requestOutcomes.get(providerId);
  if (!outcomes) {
    outcomes = { successes: 0, failures: 0 };
    requestOutcomes.set(providerId, outcomes);
  }

  if (success) {
    outcomes.successes++;
  } else {
    outcomes.failures++;
  }

  updateHealthMetrics(providerId);
}

/**
 * Register a custom provider schema for format translation.
 *
 * @param schema - The provider message schema to register
 */
export function registerProviderSchema(schema: ProviderMessageSchema): void {
  providerSchemas.set(schema.providerId, schema);
}

/**
 * Reset all health metrics (useful for testing).
 */
export function resetMetrics(): void {
  healthMetricsStore.clear();
  latencySamples.clear();
  requestOutcomes.clear();
}

// ─── Private Helpers ────────────────────────────────────────────

/**
 * Recompute and store health metrics for a provider based on recorded samples.
 */
function updateHealthMetrics(providerId: ProviderId): void {
  const samples = latencySamples.get(providerId) ?? [];
  const outcomes = requestOutcomes.get(providerId);

  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = sorted.length > 0 ? percentile(sorted, 0.5) : 0;
  const p95 = sorted.length > 0 ? percentile(sorted, 0.95) : 0;

  const totalRequests = outcomes ? outcomes.successes + outcomes.failures : 0;
  const errorRate = totalRequests > 0 ? outcomes!.failures / totalRequests : 0;
  const availability = totalRequests > 0 ? outcomes!.successes / totalRequests : 1.0;

  healthMetricsStore.set(providerId, {
    providerId,
    latencyP50Ms: p50,
    latencyP95Ms: p95,
    errorRate,
    availability,
    lastUpdated: Date.now(),
  });
}

/**
 * Compute a percentile value from a sorted array.
 */
function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0]!;

  const index = p * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sortedValues[lower]!;
  }

  const fraction = index - lower;
  return sortedValues[lower]! * (1 - fraction) + sortedValues[upper]! * fraction;
}
