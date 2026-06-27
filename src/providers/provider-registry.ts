/**
 * Provider Registry — Interfaces for multi-LLM provider management.
 *
 * Provides a standardized adapter interface for LLM providers, usage tracking,
 * priority-based routing, rate-limit fallback, and hot-swap capabilities.
 *
 * Requirements: 7.1–7.7
 */

// Dependencies: better-sqlite3 (used at implementation time)

// ─── Types ──────────────────────────────────────────────────────

/** Standardized LLM provider adapter interface */
export interface LLMProviderAdapter {
  id: string;
  name: string;
  chatCompletion(messages: ChatMessage[], options?: CompletionOptions): Promise<CompletionResult>;
  streamCompletion(messages: ChatMessage[], options?: CompletionOptions): AsyncIterable<CompletionChunk>;
  countTokens(text: string): number;
  isAvailable(): Promise<boolean>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
}

export interface CompletionResult {
  content: string;
  tokensUsed: { prompt: number; completion: number };
  finishReason: 'stop' | 'length' | 'tool_call';
}

export interface CompletionChunk {
  content: string;
  done: boolean;
}

/** Provider usage record */
export interface ProviderUsageRecord {
  providerId: string;
  timestamp: string;
  tokensUsed: number;
  costUsd: number;
  rateLimited: boolean;
}

/** Provider status */
export interface ProviderStatus {
  id: string;
  name: string;
  available: boolean;
  rateLimited: boolean;
  totalTokensUsed: number;
  totalCostUsd: number;
  priority: number;
}

/** Provider Registry interface */
export interface IProviderRegistry {
  register(adapter: LLMProviderAdapter, priority: number): void;
  unregister(providerId: string): void;
  getProvider(providerId?: string): LLMProviderAdapter;  // returns best available if no id
  getStatus(): ProviderStatus[];
  recordUsage(record: ProviderUsageRecord): void;
  hotSwap(fromProviderId: string, toProviderId: string): Promise<void>;
}
