/**
 * Prompt Cache Discipline — Enforces canonical prompt ordering and cache-friendly
 * structure for LLM provider caching (Anthropic `cache_control`, OpenAI automatic
 * prefix caching).
 *
 * Key behaviors:
 * 1. Serializes stable blocks (system prompt, tool defs, agent defs) with sorted
 *    keys and no timestamps in the prefix.
 * 2. Places volatile values (current time, session context) in suffix only.
 * 3. For Anthropic providers, adds `cache_control: {type: 'ephemeral'}` breakpoints
 *    after the system block and condensed-summary block (ensuring prefix ≥ 1024 tokens).
 * 4. Logs cache-hit metrics from provider responses into cost-store.
 *
 * Requirements: 18.1, 18.2, 18.3, 18.4
 */

import type { LLMMessage } from './llm-client.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A block of prompt content with a label for ordering */
export interface PromptBlock {
  label: 'system' | 'tool_definitions' | 'agent_definitions' | 'condensed_summary' | 'recent_events' | 'current_task' | 'volatile';
  content: unknown;
}

/** Assembled prompt with stable prefix and volatile suffix clearly separated */
export interface AssembledPrompt {
  messages: LLMMessage[];
  /** Byte-stable prefix (system + tool defs + agent defs), deterministically serialized */
  stablePrefixHash?: string;
}

/** Cache metrics from provider responses */
export interface CacheMetrics {
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalInputTokens: number;
  cacheSavingsTokens: number;
  cacheHitRatio: number;
}

/** Options for prompt assembly with cache discipline */
export interface PromptCacheDisciplineOptions {
  provider: string;
  systemPrompt?: string;
  toolDefinitions?: Record<string, unknown>[];
  agentDefinitions?: Record<string, unknown>[];
  condensedSummary?: string;
  recentMessages?: LLMMessage[];
  currentTask?: string;
  volatileContext?: Record<string, unknown>;
}

// ─── Stable Serialization ────────────────────────────────────────────────────

/**
 * Deep-sort all object keys recursively to produce a deterministic JSON string.
 * This ensures the same logical content always serializes to the same bytes,
 * maximizing cache hit rates for provider-level prefix caching.
 */
export function sortKeysDeep(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (typeof value === 'object' && value !== null) {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Serialize a value deterministically with sorted keys and no whitespace variance.
 * Strips any `timestamp`, `currentTime`, `now`, or `sessionStart` fields from the
 * object to ensure volatile temporal values never appear in the stable prefix.
 */
export function serializeStable(value: unknown): string {
  const cleaned = stripVolatileFields(value);
  const sorted = sortKeysDeep(cleaned);
  return JSON.stringify(sorted);
}

/** Fields that contain volatile temporal values and must not appear in the cacheable prefix */
const VOLATILE_FIELD_NAMES = new Set([
  'timestamp',
  'currentTime',
  'now',
  'sessionStart',
  'sessionStartTime',
  'currentTimestamp',
  'date',
  'time',
]);

/**
 * Recursively strip volatile fields (timestamps, session-specific data) from an object.
 * Returns a new object without the volatile fields.
 */
export function stripVolatileFields(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map(stripVolatileFields);
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_FIELD_NAMES.has(key)) continue;
      result[key] = stripVolatileFields(val);
    }
    return result;
  }
  return value;
}

// ─── Stable Prefix Assembly ─────────────────────────────────────────────────

/**
 * Serialize the stable prefix blocks (system prompt, tool definitions, agent definitions)
 * into a deterministic byte-stable string. Two calls with the same logical content will
 * always produce identical output, regardless of insertion order or volatile values.
 *
 * Requirements: 18.1 — canonical prompt ordering with sorted keys, no timestamps in prefix
 */
export function serializeStablePrefix(options: {
  systemPrompt?: string;
  toolDefinitions?: Record<string, unknown>[];
  agentDefinitions?: Record<string, unknown>[];
}): string {
  const parts: string[] = [];

  if (options.systemPrompt) {
    parts.push(options.systemPrompt);
  }

  if (options.toolDefinitions && options.toolDefinitions.length > 0) {
    // Sort tool definitions by name/id for determinism
    const sortedTools = [...options.toolDefinitions].sort((a, b) => {
      const nameA = String((a as any).name || (a as any).id || '');
      const nameB = String((b as any).name || (b as any).id || '');
      return nameA.localeCompare(nameB);
    });
    parts.push(serializeStable(sortedTools));
  }

  if (options.agentDefinitions && options.agentDefinitions.length > 0) {
    // Sort agent definitions by name/id for determinism
    const sortedAgents = [...options.agentDefinitions].sort((a, b) => {
      const nameA = String((a as any).name || (a as any).id || '');
      const nameB = String((b as any).name || (b as any).id || '');
      return nameA.localeCompare(nameB);
    });
    parts.push(serializeStable(sortedAgents));
  }

  return parts.join('\n');
}

// ─── Token Estimation ───────────────────────────────────────────────────────

/** Rough token estimation: ~4 characters per token (conservative) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Anthropic Cache Control Breakpoints ────────────────────────────────────

/**
 * Anthropic message format with optional cache_control field.
 * Extends LLMMessage for Anthropic-specific cache control.
 */
export interface AnthropicMessage extends LLMMessage {
  cache_control?: { type: 'ephemeral' };
}

/**
 * Determines if a provider is Anthropic-class (supports cache_control breakpoints).
 */
export function isAnthropicProvider(provider: string): boolean {
  return provider === 'anthropic' || provider.startsWith('anthropic');
}

/**
 * Add `cache_control: {type: 'ephemeral'}` breakpoints to messages for Anthropic providers.
 *
 * Breakpoints are placed:
 * 1. After the system block (first system message or end of system messages)
 * 2. After the condensed-summary block (if present)
 *
 * Only adds breakpoints if the prefix meets the minimum 1024-token threshold
 * for cache eligibility.
 *
 * Requirements: 18.3 — cache_control breakpoints for Anthropic providers
 */
export function addAnthropicCacheBreakpoints(
  messages: LLMMessage[],
  condensedSummaryIndex?: number,
): AnthropicMessage[] {
  const result: AnthropicMessage[] = messages.map(m => ({ ...m }));

  if (result.length === 0) return result;

  // Find the end of the initial system block (contiguous system messages at the start)
  let systemBlockEndIndex = -1;
  for (let i = 0; i < result.length; i++) {
    if (result[i].role === 'system') {
      systemBlockEndIndex = i;
    } else {
      break;
    }
  }

  // If a condensedSummaryIndex is provided, the "system block" ends just before it
  // and the condensed summary gets its own breakpoint.
  let primaryBreakpointIndex = systemBlockEndIndex;
  if (condensedSummaryIndex !== undefined && condensedSummaryIndex > 0 && condensedSummaryIndex <= systemBlockEndIndex) {
    // The system block's last real system message is the one before the condensed summary
    primaryBreakpointIndex = condensedSummaryIndex - 1;
  }

  // Calculate prefix token count up to and including the primary breakpoint
  let prefixTokens = 0;
  for (let i = 0; i <= primaryBreakpointIndex && i < result.length; i++) {
    prefixTokens += estimateTokens(result[i].content);
  }

  // Only add cache breakpoint if the prefix meets the minimum 1024-token threshold
  if (prefixTokens >= 1024 && primaryBreakpointIndex >= 0) {
    result[primaryBreakpointIndex].cache_control = { type: 'ephemeral' };
  }

  // Add breakpoint after condensed-summary block if present and index is valid
  if (condensedSummaryIndex !== undefined && condensedSummaryIndex >= 0 && condensedSummaryIndex < result.length) {
    // Calculate token count up to condensed summary
    let summaryPrefixTokens = 0;
    for (let i = 0; i <= condensedSummaryIndex; i++) {
      summaryPrefixTokens += estimateTokens(result[i].content);
    }

    // Only add if the prefix up to this point meets the 1024-token minimum
    if (summaryPrefixTokens >= 1024) {
      result[condensedSummaryIndex].cache_control = { type: 'ephemeral' };
    }
  }

  return result;
}

// ─── Prompt Assembly with Cache Discipline ──────────────────────────────────

/**
 * Assemble messages with prompt cache discipline applied.
 *
 * Enforces canonical ordering:
 * 1. Stable prefix: system prompt + tool defs + agent defs (sorted, no timestamps)
 * 2. Condensed summary (if any)
 * 3. Recent events/messages
 * 4. Current task
 * 5. Volatile suffix: current time, session context
 *
 * Requirements: 18.1, 18.2
 */
export function assembleWithCacheDiscipline(options: PromptCacheDisciplineOptions): AssembledPrompt {
  const messages: LLMMessage[] = [];
  let condensedSummaryIndex: number | undefined;

  // 1. Stable system prefix — serialized deterministically, no volatile fields
  const stableSystemContent = serializeStablePrefix({
    systemPrompt: options.systemPrompt,
    toolDefinitions: options.toolDefinitions,
    agentDefinitions: options.agentDefinitions,
  });

  if (stableSystemContent) {
    messages.push({
      role: 'system',
      content: stableSystemContent,
    });
  }

  // 2. Condensed summary block (if present)
  if (options.condensedSummary) {
    condensedSummaryIndex = messages.length;
    messages.push({
      role: 'system',
      content: options.condensedSummary,
    });
  }

  // 3. Recent messages/events (verbatim, order-preserved)
  if (options.recentMessages) {
    for (const msg of options.recentMessages) {
      messages.push({ ...msg });
    }
  }

  // 4. Current task
  if (options.currentTask) {
    messages.push({
      role: 'user',
      content: options.currentTask,
    });
  }

  // 5. Volatile suffix — timestamps, session state go HERE, never in prefix
  if (options.volatileContext && Object.keys(options.volatileContext).length > 0) {
    const volatileContent = `[Session Context]\n${JSON.stringify(options.volatileContext)}`;
    // Append volatile data to the last user message or as a new system message
    if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
      messages[messages.length - 1].content += '\n\n' + volatileContent;
    } else {
      messages.push({
        role: 'system',
        content: volatileContent,
      });
    }
  }

  // Apply Anthropic cache breakpoints if applicable
  let finalMessages: LLMMessage[];
  if (isAnthropicProvider(options.provider)) {
    finalMessages = addAnthropicCacheBreakpoints(messages, condensedSummaryIndex);
  } else {
    finalMessages = messages;
  }

  return {
    messages: finalMessages,
    stablePrefixHash: stableSystemContent ? hashString(stableSystemContent) : undefined,
  };
}

// ─── Cache Metrics Extraction ───────────────────────────────────────────────

/**
 * Extract cache metrics from an Anthropic API response.
 * Anthropic responses include `usage.cache_creation_input_tokens` and
 * `usage.cache_read_input_tokens` when cache_control breakpoints are used.
 */
export function extractCacheMetrics(providerResponse: Record<string, any>): CacheMetrics | null {
  const usage = providerResponse?.usage;
  if (!usage) return null;

  const cacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadInputTokens = usage.cache_read_input_tokens ?? 0;
  const totalInputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;

  // No cache activity detected
  if (cacheCreationInputTokens === 0 && cacheReadInputTokens === 0) {
    return null;
  }

  const cacheSavingsTokens = cacheReadInputTokens;
  const cacheHitRatio = totalInputTokens > 0
    ? cacheReadInputTokens / totalInputTokens
    : 0;

  return {
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalInputTokens,
    cacheSavingsTokens,
    cacheHitRatio,
  };
}

/**
 * Extract cache metrics from an OpenAI API response.
 * OpenAI includes `usage.prompt_tokens_details.cached_tokens` for automatic prefix caching.
 */
export function extractOpenAICacheMetrics(providerResponse: Record<string, any>): CacheMetrics | null {
  const usage = providerResponse?.usage;
  if (!usage) return null;

  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const totalInputTokens = usage.prompt_tokens ?? 0;

  if (cachedTokens === 0) return null;

  return {
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cachedTokens,
    totalInputTokens,
    cacheSavingsTokens: cachedTokens,
    cacheHitRatio: totalInputTokens > 0 ? cachedTokens / totalInputTokens : 0,
  };
}

// ─── Cache Metrics Logging ──────────────────────────────────────────────────

/** Interface for the cost-store cache metrics recording */
export interface CacheMetricsStore {
  recordCacheMetrics(entry: {
    provider: string;
    model: string;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalInputTokens: number;
    cacheSavingsTokens: number;
    cacheHitRatio: number;
    sessionId?: string;
  }): void;
}

/**
 * Log cache metrics from a provider response into the cost-store.
 *
 * Requirements: 18.4 — log cache-hit metrics from provider responses into cost-store
 */
export function logCacheMetrics(
  store: CacheMetricsStore | null,
  provider: string,
  model: string,
  providerResponse: Record<string, any>,
  sessionId?: string,
): CacheMetrics | null {
  if (!store) return null;

  let metrics: CacheMetrics | null = null;

  if (isAnthropicProvider(provider)) {
    metrics = extractCacheMetrics(providerResponse);
  } else {
    metrics = extractOpenAICacheMetrics(providerResponse);
  }

  if (metrics) {
    store.recordCacheMetrics({
      provider,
      model,
      cacheCreationTokens: metrics.cacheCreationInputTokens,
      cacheReadTokens: metrics.cacheReadInputTokens,
      totalInputTokens: metrics.totalInputTokens,
      cacheSavingsTokens: metrics.cacheSavingsTokens,
      cacheHitRatio: metrics.cacheHitRatio,
      sessionId,
    });

    console.log(
      `[PromptCacheDiscipline] Cache metrics: provider=${provider} ` +
      `cacheRead=${metrics.cacheReadInputTokens} cacheCreate=${metrics.cacheCreationInputTokens} ` +
      `total=${metrics.totalInputTokens} hitRatio=${(metrics.cacheHitRatio * 100).toFixed(1)}%`,
    );
  }

  return metrics;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Simple hash for prefix stability tracking (not cryptographic) */
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(36);
}

/**
 * Apply prompt cache discipline to an existing message array.
 * This is the integration point for the LLM client — it reorders messages
 * to enforce stable prefix ordering and adds Anthropic cache breakpoints.
 *
 * For messages that are already assembled (e.g., from the agent loop),
 * this ensures:
 * - System messages are at the front (stable prefix)
 * - No volatile timestamps in system messages
 * - Anthropic cache_control breakpoints are added where applicable
 *
 * Requirements: 18.1, 18.2, 18.3
 */
export function applyPromptCacheDiscipline(
  messages: LLMMessage[],
  provider: string,
): LLMMessage[] {
  if (messages.length === 0) return messages;

  // Separate system messages (stable prefix) from conversation messages (volatile)
  const systemMessages: LLMMessage[] = [];
  const conversationMessages: LLMMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemMessages.push(msg);
    } else {
      conversationMessages.push(msg);
    }
  }

  // Stabilize system messages: strip volatile fields from content if it's JSON-like
  const stabilizedSystemMessages = systemMessages.map(msg => {
    const content = msg.content;
    // If content looks like JSON, try to stabilize it
    if (content.startsWith('{') || content.startsWith('[')) {
      try {
        const parsed = JSON.parse(content);
        return { ...msg, content: serializeStable(parsed) };
      } catch {
        // Not valid JSON, keep as-is
        return msg;
      }
    }
    return msg;
  });

  // Rebuild: system messages first (stable prefix), then conversation (includes volatile)
  const reordered = [...stabilizedSystemMessages, ...conversationMessages];

  // Apply Anthropic cache breakpoints
  if (isAnthropicProvider(provider)) {
    // Find condensed summary index (look for a system message that contains summary markers)
    let condensedSummaryIndex: number | undefined;
    for (let i = 0; i < reordered.length; i++) {
      if (reordered[i].role === 'system' && (
        reordered[i].content.includes('[Conversation Summary') ||
        reordered[i].content.includes('[Condensed Summary')
      )) {
        condensedSummaryIndex = i;
        break;
      }
    }

    return addAnthropicCacheBreakpoints(reordered, condensedSummaryIndex);
  }

  return reordered;
}
