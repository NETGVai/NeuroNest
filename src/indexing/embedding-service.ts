/**
 * Embedding Service — Vector embedding generation for SemanticIndex
 *
 * Supports configurable embedding providers (local Ollama, OpenAI text-embedding-3-small).
 * Implements batch embedding with configurable concurrency (default: 4 parallel).
 * Adds token counting to prevent oversized chunks (split if > 512 tokens).
 *
 * Follows NeuroNest's lazy-initialized singleton pattern.
 *
 * Requirements: 2.2
 */

import type { SemanticChunk } from './tree-sitter-chunker.js';

// ─── Types ──────────────────────────────────────────────────────

/** Supported embedding provider types */
export type EmbeddingProviderType = 'ollama' | 'openai';

/** Configuration for the embedding service */
export interface EmbeddingServiceConfig {
  /** Primary embedding provider (default: 'ollama') */
  provider: EmbeddingProviderType;
  /** Fallback provider when primary is unavailable */
  fallbackProvider?: EmbeddingProviderType;
  /** Maximum parallel embedding requests (default: 4) */
  concurrency: number;
  /** Maximum token count per chunk before splitting (default: 512) */
  maxTokensPerChunk: number;
  /** Ollama configuration */
  ollama?: {
    endpoint: string;
    model: string;
  };
  /** OpenAI configuration */
  openai?: {
    apiKey: string;
    model: string;
    endpoint?: string;
  };
  /** Vector dimensions for the embedding model */
  dimensions: number;
}

/** Result of embedding a single chunk */
export interface EmbeddingResult {
  /** Original chunk ID (or sub-chunk ID if split) */
  chunkId: string;
  /** The vector embedding */
  vector: Float32Array;
  /** Token count of the embedded content */
  tokenCount: number;
}

/** Result of embedding a batch of chunks */
export interface BatchEmbeddingResult {
  /** Successfully embedded results */
  results: EmbeddingResult[];
  /** Chunks that failed to embed */
  errors: Array<{ chunkId: string; error: string }>;
}

/** Provider interface for embedding implementations */
export interface EmbeddingProvider {
  /** Provider name for identification */
  readonly name: EmbeddingProviderType;
  /** Generate embedding for a single text */
  embed(text: string): Promise<Float32Array>;
  /** Generate embeddings for multiple texts */
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  /** Check if the provider is available and responding */
  isAvailable(): Promise<boolean>;
}

// ─── Token Counting ─────────────────────────────────────────────

/**
 * Approximate token count for a text string.
 * Uses a conservative estimate: ~4 characters per token for English text,
 * ~3 characters per token for code (due to shorter identifiers and symbols).
 *
 * This is deliberately conservative to avoid sending oversized chunks.
 */
export function estimateTokenCount(text: string): number {
  // Count whitespace-separated words and symbols as a base
  // Code typically tokenizes at ~3.5 chars per token on average
  const charCount = text.length;
  if (charCount === 0) return 0;

  // Heuristic: split on whitespace and common code separators
  const tokens = text.split(/[\s\n\r\t]+/).filter((t) => t.length > 0);
  const wordCount = tokens.length;

  // Use the higher estimate between character-based and word-based
  const charBasedEstimate = Math.ceil(charCount / 3.5);
  const wordBasedEstimate = wordCount;

  // Return the more conservative (higher) estimate
  return Math.max(charBasedEstimate, wordBasedEstimate);
}

/**
 * Split content into sub-chunks that each fit within the token limit.
 * Splits on line boundaries to preserve code semantics.
 */
export function splitByTokenLimit(content: string, maxTokens: number): string[] {
  if (maxTokens <= 0) {
    throw new Error('maxTokens must be positive');
  }

  const estimatedTokens = estimateTokenCount(content);
  if (estimatedTokens <= maxTokens) {
    return [content];
  }

  const lines = content.split('\n');
  const subChunks: string[] = [];
  let currentChunk: string[] = [];
  let currentTokens = 0;

  for (const line of lines) {
    const lineTokens = estimateTokenCount(line);

    // If a single line exceeds the limit, split it further by character
    if (lineTokens > maxTokens && currentChunk.length === 0) {
      const chars = line.length;
      const charsPerChunk = Math.floor((maxTokens * 3.5));
      for (let i = 0; i < chars; i += charsPerChunk) {
        subChunks.push(line.slice(i, i + charsPerChunk));
      }
      continue;
    }

    if (currentTokens + lineTokens > maxTokens && currentChunk.length > 0) {
      // Current chunk is full, start a new one
      subChunks.push(currentChunk.join('\n'));
      currentChunk = [line];
      currentTokens = lineTokens;
    } else {
      currentChunk.push(line);
      currentTokens += lineTokens;
    }
  }

  // Don't forget the last chunk
  if (currentChunk.length > 0) {
    subChunks.push(currentChunk.join('\n'));
  }

  return subChunks.filter((chunk) => chunk.trim().length > 0);
}

// ─── Ollama Provider ────────────────────────────────────────────

/**
 * Embedding provider using local Ollama instance.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name: EmbeddingProviderType = 'ollama';
  private endpoint: string;
  private model: string;

  constructor(config: { endpoint: string; model: string }) {
    this.endpoint = config.endpoint.replace(/\/$/, '');
    this.model = config.model;
  }

  async embed(text: string): Promise<Float32Array> {
    const response = await fetch(`${this.endpoint}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama embedding request failed: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as { embedding: number[] };
    if (!data.embedding || !Array.isArray(data.embedding)) {
      throw new Error('Invalid Ollama embedding response: missing embedding array');
    }

    return new Float32Array(data.embedding);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    // Ollama doesn't have a native batch endpoint, so we embed individually
    const results: Float32Array[] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// ─── OpenAI Provider ────────────────────────────────────────────

/**
 * Embedding provider using OpenAI's text-embedding API.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name: EmbeddingProviderType = 'openai';
  private apiKey: string;
  private model: string;
  private endpoint: string;

  constructor(config: { apiKey: string; model: string; endpoint?: string }) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.endpoint = (config.endpoint ?? 'https://api.openai.com').replace(/\/$/, '');
  }

  async embed(text: string): Promise<Float32Array> {
    const results = await this.embedBatch([text]);
    return results[0]!;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const response = await fetch(`${this.endpoint}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI embedding request failed: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    if (!data.data || !Array.isArray(data.data)) {
      throw new Error('Invalid OpenAI embedding response: missing data array');
    }

    // Sort by index to ensure order matches input
    const sorted = [...data.data].sort((a, b) => a.index - b.index);
    return sorted.map((item) => new Float32Array(item.embedding));
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/v1/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// ─── Embedding Service ──────────────────────────────────────────

/** Default configuration values */
const DEFAULT_CONFIG: EmbeddingServiceConfig = {
  provider: 'ollama',
  fallbackProvider: 'openai',
  concurrency: 4,
  maxTokensPerChunk: 512,
  dimensions: 384,
  ollama: {
    endpoint: 'http://localhost:11434',
    model: 'nomic-embed-text',
  },
  openai: {
    apiKey: '',
    model: 'text-embedding-3-small',
  },
};

/**
 * EmbeddingService — Orchestrates vector embedding generation for code chunks.
 *
 * Features:
 * - Configurable primary and fallback providers (Ollama, OpenAI)
 * - Batch embedding with bounded concurrency (default: 4 parallel)
 * - Token counting and automatic chunk splitting (> 512 tokens)
 * - Provider availability checking with automatic fallback
 *
 * Follows NeuroNest's lazy-initialized singleton pattern.
 */
export class EmbeddingService {
  private config: EmbeddingServiceConfig;
  private primaryProvider: EmbeddingProvider;
  private fallbackProviderInstance: EmbeddingProvider | null = null;

  constructor(config: Partial<EmbeddingServiceConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Merge nested configs
    if (config.ollama) {
      this.config.ollama = { ...DEFAULT_CONFIG.ollama!, ...config.ollama };
    }
    if (config.openai) {
      this.config.openai = { ...DEFAULT_CONFIG.openai!, ...config.openai };
    }

    this.primaryProvider = this.createProvider(this.config.provider);

    if (this.config.fallbackProvider && this.config.fallbackProvider !== this.config.provider) {
      this.fallbackProviderInstance = this.createProvider(this.config.fallbackProvider);
    }
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Generate an embedding for a single text string.
   * Falls back to the secondary provider if the primary is unavailable.
   */
  async embedText(text: string): Promise<Float32Array> {
    const provider = await this.getAvailableProvider();
    return provider.embed(text);
  }

  /**
   * Generate embeddings for a batch of semantic chunks.
   * Applies token counting and splits oversized chunks before embedding.
   * Uses bounded concurrency for parallel processing.
   */
  async embedChunks(chunks: SemanticChunk[]): Promise<BatchEmbeddingResult> {
    const results: EmbeddingResult[] = [];
    const errors: Array<{ chunkId: string; error: string }> = [];

    // Prepare all embedding tasks (with token-based splitting)
    const tasks = this.prepareEmbeddingTasks(chunks);

    // Process in batches with bounded concurrency
    const provider = await this.getAvailableProvider();
    const batchSize = this.config.concurrency;

    for (let i = 0; i < tasks.length; i += batchSize) {
      const batch = tasks.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(
        batch.map(async (task) => {
          const vector = await provider.embed(task.content);
          return {
            chunkId: task.chunkId,
            vector,
            tokenCount: task.tokenCount,
          } satisfies EmbeddingResult;
        })
      );

      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j]!;
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          const task = batch[j]!;
          errors.push({
            chunkId: task.chunkId,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      }
    }

    return { results, errors };
  }

  /**
   * Generate embeddings for multiple raw text strings.
   * Uses bounded concurrency for parallel processing.
   */
  async embedTexts(texts: string[]): Promise<Float32Array[]> {
    const provider = await this.getAvailableProvider();
    const batchSize = this.config.concurrency;
    const allResults: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchResults = await provider.embedBatch(batch);
      allResults.push(...batchResults);
    }

    return allResults;
  }

  /**
   * Check if the configured primary provider is available.
   */
  async isPrimaryAvailable(): Promise<boolean> {
    return this.primaryProvider.isAvailable();
  }

  /**
   * Check if any provider (primary or fallback) is available.
   */
  async isAvailable(): Promise<boolean> {
    if (await this.primaryProvider.isAvailable()) return true;
    if (this.fallbackProviderInstance) {
      return this.fallbackProviderInstance.isAvailable();
    }
    return false;
  }

  /**
   * Get the current configuration.
   */
  getConfig(): Readonly<EmbeddingServiceConfig> {
    return { ...this.config };
  }

  /**
   * Get the active provider name.
   */
  getActiveProviderName(): EmbeddingProviderType {
    return this.config.provider;
  }

  /**
   * Get the embedding dimensions.
   */
  getDimensions(): number {
    return this.config.dimensions;
  }

  /**
   * Estimate tokens for a given text.
   */
  estimateTokens(text: string): number {
    return estimateTokenCount(text);
  }

  // ─── Private Helpers ────────────────────────────────────────

  /**
   * Create a provider instance from configuration.
   */
  private createProvider(type: EmbeddingProviderType): EmbeddingProvider {
    switch (type) {
      case 'ollama':
        return new OllamaEmbeddingProvider({
          endpoint: this.config.ollama?.endpoint ?? 'http://localhost:11434',
          model: this.config.ollama?.model ?? 'nomic-embed-text',
        });
      case 'openai':
        return new OpenAIEmbeddingProvider({
          apiKey: this.config.openai?.apiKey ?? '',
          model: this.config.openai?.model ?? 'text-embedding-3-small',
          endpoint: this.config.openai?.endpoint,
        });
      default:
        throw new Error(`Unsupported embedding provider: ${type}`);
    }
  }

  /**
   * Get the first available provider (primary first, then fallback).
   * Throws if no provider is available.
   */
  private async getAvailableProvider(): Promise<EmbeddingProvider> {
    if (await this.primaryProvider.isAvailable()) {
      return this.primaryProvider;
    }

    if (this.fallbackProviderInstance && (await this.fallbackProviderInstance.isAvailable())) {
      return this.fallbackProviderInstance;
    }

    // If no availability check succeeds, still try primary (network may be intermittent)
    return this.primaryProvider;
  }

  /**
   * Prepare embedding tasks by splitting oversized chunks.
   * Chunks exceeding maxTokensPerChunk are split into sub-chunks.
   */
  private prepareEmbeddingTasks(
    chunks: SemanticChunk[]
  ): Array<{ chunkId: string; content: string; tokenCount: number }> {
    const tasks: Array<{ chunkId: string; content: string; tokenCount: number }> = [];

    for (const chunk of chunks) {
      const tokenCount = estimateTokenCount(chunk.content);

      if (tokenCount <= this.config.maxTokensPerChunk) {
        tasks.push({
          chunkId: chunk.id,
          content: chunk.content,
          tokenCount,
        });
      } else {
        // Split oversized chunks
        const subContents = splitByTokenLimit(chunk.content, this.config.maxTokensPerChunk);
        for (let i = 0; i < subContents.length; i++) {
          const subContent = subContents[i]!;
          tasks.push({
            chunkId: `${chunk.id}_part${i}`,
            content: subContent,
            tokenCount: estimateTokenCount(subContent),
          });
        }
      }
    }

    return tasks;
  }
}

// ─── Singleton Instance ─────────────────────────────────────────

let instance: EmbeddingService | null = null;

/**
 * Get or create the singleton EmbeddingService instance.
 * Follows NeuroNest's lazy-initialized singleton pattern.
 */
export function getEmbeddingService(config?: Partial<EmbeddingServiceConfig>): EmbeddingService {
  if (!instance) {
    instance = new EmbeddingService(config);
  }
  return instance;
}

/**
 * Reset the singleton (for testing purposes).
 */
export function resetEmbeddingService(): void {
  instance = null;
}
