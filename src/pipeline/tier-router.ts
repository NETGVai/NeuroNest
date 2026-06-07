/**
 * Per-Model Tier Routing — Routes different task complexities to different providers/models.
 *
 * Tiers:
 * - heavy: Complex reasoning, architecture, multi-step planning → best available model
 * - standard: Normal coding, explanations, moderate tasks → default model
 * - fast: Simple questions, confirmations, quick lookups → cheapest/fastest model
 */

import { type LLMClient } from './llm-client';
import { createLLMClientWithProMode } from './pro-mode-state';

export type TaskTier = 'heavy' | 'standard' | 'fast';

export interface TierRoutingConfig {
  heavy?: { provider: string; model: string };   // Complex tasks
  standard?: { provider: string; model: string }; // Normal tasks (default)
  fast?: { provider: string; model: string };     // Quick/simple tasks
}

/**
 * Classify a user message into a task tier based on complexity signals.
 */
export function classifyTaskTier(message: string, agentCount?: number): TaskTier {
  const msgLower = message.toLowerCase();
  const wordCount = message.split(/\s+/).length;

  // Heavy: long messages, architecture keywords, multi-step requests
  if (wordCount > 100) return 'heavy';
  if (agentCount && agentCount > 5) return 'heavy';
  if (/architect|design|refactor|migrate|rewrite|overhaul|comprehensive|entire|all files/i.test(msgLower)) return 'heavy';
  if (/plan.*implement|step.*by.*step|full.*application|from scratch/i.test(msgLower)) return 'heavy';

  // Fast: very short messages, simple questions, lookups
  if (wordCount <= 8) return 'fast';
  if (/^(what|how|why|where|when|which|who|can you|is it|does it)/i.test(msgLower) && wordCount <= 15) return 'fast';
  if (/explain|what does|what is|show me|list|tell me about/i.test(msgLower) && wordCount <= 20) return 'fast';

  // Standard: everything else
  return 'standard';
}

/**
 * Resolve the LLM client for a given task tier.
 * Falls back to the default client if no tier-specific config exists.
 */
export function resolveClientForTier(
  tier: TaskTier,
  tierConfig: TierRoutingConfig,
  providers: any[],
  defaultClient: LLMClient | null
): LLMClient | null {
  const tierEntry = tierConfig[tier];
  if (!tierEntry) return defaultClient;

  // Find the provider matching the tier config
  const prov = providers.find((p: any) =>
    p.type === tierEntry.provider || p.name === tierEntry.provider || p.id === tierEntry.provider
  );

  if (prov) {
    const client = createLLMClientWithProMode({ ...prov, model: tierEntry.model });
    if (client) return client;
  }

  return defaultClient;
}

/**
 * Get the context window size for a provider type.
 * Used to set appropriate compaction thresholds.
 */
export function getModelContextWindow(providerType: string, model?: string): number {
  // Known context windows (conservative estimates)
  const modelLower = (model || '').toLowerCase();

  // Check specific models first
  if (modelLower.includes('gpt-4o')) return 128000;
  if (modelLower.includes('gpt-4-turbo')) return 128000;
  if (modelLower.includes('gpt-4')) return 8192;
  if (modelLower.includes('gpt-3.5')) return 16384;
  if (modelLower.includes('claude-3-opus')) return 200000;
  if (modelLower.includes('claude-3-sonnet') || modelLower.includes('claude-3.5')) return 200000;
  if (modelLower.includes('claude')) return 200000;
  if (modelLower.includes('gemini-pro')) return 1000000;
  if (modelLower.includes('gemini')) return 128000;
  if (modelLower.includes('deepseek')) return 64000;
  if (modelLower.includes('mistral-large')) return 128000;
  if (modelLower.includes('mistral')) return 32000;
  if (modelLower.includes('llama-3.1-405b')) return 128000;
  if (modelLower.includes('llama')) return 8192;
  if (modelLower.includes('qwen')) return 32000;

  // Provider-level defaults
  switch (providerType) {
    case 'openai': return 128000;
    case 'anthropic': return 200000;
    case 'gemini': return 128000;
    case 'deepseek': return 64000;
    case 'mistral': return 32000;
    case 'groq': return 32000;
    case 'ollama': return 8192;
    case 'llamacpp': return 8192;
    default: return 16000;
  }
}

/**
 * Calculate the appropriate compaction threshold for a model.
 * Returns the token count at which compression should trigger.
 * Uses ~60% of the model's context window as the threshold.
 */
export function getCompactionThreshold(providerType: string, model?: string): number {
  const contextWindow = getModelContextWindow(providerType, model);
  return Math.floor(contextWindow * 0.6);
}
