// ─── Chunking Types & Interfaces ────────────────────────────────
// Defines the configuration and output types for the KB chunking system.
// All chunking strategies produce KBChunk arrays conforming to these types.
//
// Requirements: 30.1, 30.2, 30.3, 30.4, 30.5, 30.6

import { createHash } from 'crypto';

// ─── ChunkingConfig ─────────────────────────────────────────────

/**
 * Configuration for a chunking strategy.
 */
export interface ChunkingConfig {
  /** The chunking strategy to apply. */
  strategy: 'fixed-size' | 'semantic-boundary' | 'document-structure';
  /** Maximum tokens per chunk (default: 512). */
  maxTokens: number;
  /** Token overlap between consecutive chunks (fixed-size only, default: 64). */
  overlapTokens: number;
  /** Tokenizer to use for counting. */
  tokenizer: 'cl100k_base' | 'model-specific';
}

// ─── ChunkMetadata ──────────────────────────────────────────────

/**
 * Metadata associated with a chunk for retrieval context.
 */
export interface ChunkMetadata {
  /** Nearest heading above the chunk content. */
  heading?: string;
  /** Detected language (for code blocks). */
  language?: string;
  /** Starting line number in the original document. */
  lineStart?: number;
  /** Ending line number in the original document. */
  lineEnd?: number;
}

// ─── KBChunk ────────────────────────────────────────────────────

/**
 * A single chunk produced by the ingest pipeline.
 * Contains content, token counts for both embedding and LLM budget,
 * and metadata for retrieval context.
 */
export interface KBChunk {
  /** Unique identifier (uuidv7). */
  id: string;
  /** Source URI identifying the origin document. */
  sourceUri: string;
  /** Zero-based index of this chunk within its source. */
  chunkIndex: number;
  /** The actual text content of the chunk. */
  content: string;
  /** SHA-256 hash of the content for deduplication. */
  contentHash: string;
  /** Token count using the embedding model tokenizer. */
  tokenCount: number;
  /** Token count using cl100k_base for LLM context budget. */
  llmTokenCount: number;
  /** Links chunks that were split from an oversized atomic unit. */
  continuationGroupId?: string;
  /** Contextual metadata for retrieval. */
  metadata: ChunkMetadata;
}

// ─── ChunkingStrategy Interface ─────────────────────────────────

/**
 * Interface that all chunking strategies must implement.
 */
export interface ChunkingStrategy {
  /**
   * Chunk a document into KBChunk pieces.
   * @param content - The full text content to chunk.
   * @param sourceUri - The source URI for provenance tracking.
   * @param config - The chunking configuration.
   * @returns An array of KBChunk objects.
   */
  chunk(content: string, sourceUri: string, config: ChunkingConfig): KBChunk[];
}

// ─── Token Counting ─────────────────────────────────────────────

/**
 * Approximate token count using a word/subword heuristic.
 * Uses the cl100k_base approximation: ~4 characters per token for English text,
 * with adjustments for code (more tokens per character due to symbols).
 *
 * This is a reasonable approximation suitable for chunk boundary decisions.
 * For production, this can be swapped with tiktoken or a model-specific tokenizer.
 */
export function countTokens(text: string): number {
  if (text.length === 0) return 0;

  // Heuristic: split on whitespace and punctuation boundaries,
  // then estimate subword tokens. cl100k_base averages ~4 chars/token
  // for English prose, ~3.5 for code.
  // We use a conservative estimate of ~4 chars/token to avoid exceeding limits.
  const charCount = text.length;
  const wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;

  // Use a blend: word count tends to undercount (compound tokens),
  // char/4 tends to overcount for short words. Average gives reasonable results.
  const charBasedEstimate = Math.ceil(charCount / 4);
  const wordBasedEstimate = Math.ceil(wordCount * 1.3); // Most words are 1-2 tokens

  // Return the higher estimate to be conservative (never exceed maxTokens)
  return Math.max(charBasedEstimate, wordBasedEstimate);
}

/**
 * Count tokens for LLM budget calculation (cl100k_base approximation).
 * This uses the same heuristic since we don't have tiktoken available.
 */
export function countLLMTokens(text: string): number {
  return countTokens(text);
}

// ─── Content Hashing ────────────────────────────────────────────

/**
 * Generate a SHA-256 hash of chunk content for deduplication and freshness.
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

// ─── Sentence Splitting ─────────────────────────────────────────

/**
 * Split text at sentence boundaries for use when atomic units exceed maxTokens.
 * Returns an array of sentences (preserving trailing whitespace/newlines).
 */
export function splitAtSentenceBoundaries(text: string): string[] {
  // Match sentences ending with ., !, ? followed by whitespace or end of string.
  // Also handles code statements ending with ; or } followed by newline.
  const sentences: string[] = [];
  const pattern = /[^.!?;}\n]+(?:[.!?;}\n]|\s*$)+\s*/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match[0].trim().length > 0) {
      sentences.push(match[0]);
    }
  }

  // If regex didn't capture everything (e.g., text without punctuation),
  // return the whole text as a single "sentence"
  if (sentences.length === 0 && text.trim().length > 0) {
    sentences.push(text);
  }

  return sentences;
}

// ─── Default Config ─────────────────────────────────────────────

/**
 * Returns a default ChunkingConfig with sensible production defaults.
 */
export function defaultChunkingConfig(
  strategy: ChunkingConfig['strategy'] = 'semantic-boundary',
): ChunkingConfig {
  return {
    strategy,
    maxTokens: 512,
    overlapTokens: 64,
    tokenizer: 'cl100k_base',
  };
}
