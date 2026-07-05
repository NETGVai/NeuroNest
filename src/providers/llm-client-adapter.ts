/**
 * LLM Client Adapter — Bridges existing createLLMClient providers to the
 * formal LLMProviderAdapter interface used by ProviderRegistry.
 *
 * This allows the existing provider JSON config (type, baseUrl, apiKey, model)
 * to work seamlessly with the new registry-based priority routing, hot-swap,
 * and usage tracking system.
 */

import { createLLMClientWithProMode } from '../pipeline/pro-mode-state';
import type {
  LLMProviderAdapter,
  ChatMessage,
  CompletionOptions,
  CompletionResult,
  CompletionChunk,
} from './provider-registry';

/**
 * Shape of a provider config record from the user's saved providers JSON.
 */
export interface ProviderConfig {
  id?: string;
  name?: string;
  type: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  nLoops?: number;
  [key: string]: unknown;
}

/**
 * Wraps an existing provider config into an LLMProviderAdapter.
 * Uses createLLMClientWithProMode internally for the actual LLM calls.
 */
export function createProviderAdapter(config: ProviderConfig): LLMProviderAdapter {
  const id = config.id || config.name || config.type || 'unknown';
  const name = config.name || config.type || id;

  return {
    id,
    name,

    async chatCompletion(messages: ChatMessage[], options?: CompletionOptions): Promise<CompletionResult> {
      const client = createLLMClientWithProMode(config);
      if (!client) {
        throw new Error(`Failed to create LLM client for provider '${id}'`);
      }

      const llmMessages = messages.map(m => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
      }));

      const result = await client.chat(llmMessages, {
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      });

      return {
        content: result.content || '',
        tokensUsed: {
          prompt: result.promptTokens ?? 0,
          completion: result.completionTokens ?? 0,
        },
        finishReason: 'stop',
      };
    },

    async *streamCompletion(messages: ChatMessage[], _options?: CompletionOptions): AsyncIterable<CompletionChunk> {
      // Fallback: use chatCompletion and yield the full result as a single chunk
      // since the LLMClient class doesn't expose a standard async iterable stream
      const result = await this.chatCompletion(messages, _options);
      yield { content: result.content, done: true };
    },

    countTokens(text: string): number {
      // Simple heuristic: ~4 chars per token (matches pipeline convention)
      return Math.ceil(text.length / 4);
    },

    async isAvailable(): Promise<boolean> {
      try {
        const client = createLLMClientWithProMode(config);
        return client !== null;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Convert an array of provider configs into LLMProviderAdapter instances
 * with priority based on their position in the array (first = highest priority).
 */
export function createAdaptersFromConfigs(
  configs: ProviderConfig[],
): Array<{ adapter: LLMProviderAdapter; priority: number }> {
  return configs.map((config, index) => ({
    adapter: createProviderAdapter(config),
    priority: index + 1,
  }));
}
