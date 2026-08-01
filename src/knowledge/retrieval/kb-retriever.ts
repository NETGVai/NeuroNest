/**
 * KB Retriever — Retrieves relevant knowledge chunks from the vector store.
 *
 * Performs similarity search against the KBVectorStore (LanceDB-backed) with:
 *   - Configurable relevance threshold (default: 0.65)
 *   - Token budget enforcement from Context_Window_Optimizer
 *   - Empty results when all similarities fall below threshold
 *   - Pagination/streaming support for large knowledgebases (100K+ chunks)
 *   - Reciprocal Rank Fusion merge stub (fully implemented in task 4.2)
 *
 * Requirements: 3.1, 3.3, 3.6, 34.1, 34.5
 */

import type { KBVectorStore, KBVectorSearchResult } from '../ingest/vector-store.js';
import type { KBEmbeddingService } from '../ingest/embedding-service.js';

// ─── Types ──────────────────────────────────────────────────────

/** Configuration for KB retrieval operations */
export interface KBRetrievalConfig {
  /** Minimum cosine similarity threshold for a chunk to be considered relevant (default: 0.65) */
  relevanceThreshold: number;
  /** Maximum number of chunks to return per query (default: 10) */
  maxChunks: number;
  /** Token budget allocated by the Context_Window_Optimizer (default: 2048) */
  tokenBudget: number;
  /** RRF weight — proportion of context budget allocated to KB results (default: 0.4 = 40%) */
  rrfWeight: number;
}

/** Result of a KB retrieval operation */
export interface KBRetrievalResult {
  /** Retrieved chunks sorted by descending similarity, filtered and budget-constrained */
  chunks: RetrievedChunk[];
  /** Total token count of all returned chunks */
  totalTokens: number;
  /** Query execution time in milliseconds */
  queryTimeMs: number;
}

/** A single retrieved chunk with retrieval metadata */
export interface RetrievedChunk {
  /** Unique chunk identifier */
  id: string;
  /** The raw chunk text content */
  content: string;
  /** Original source URI of the chunk */
  sourceUri: string;
  /** Cosine similarity score (0 to 1) */
  similarity: number;
  /** Token count of this chunk (estimated for LLM context budget) */
  tokenCount: number;
}

/** Result of an RRF merge between KB and GCF results */
export interface MergedResult {
  /** Unique item identifier */
  id: string;
  /** The text content */
  content: string;
  /** Source URI */
  sourceUri: string;
  /** Computed RRF score (sum of reciprocal ranks across all input lists containing this item) */
  rrfScore: number;
  /** Origin list(s): 'kb', 'gcf', or 'both' */
  origin: 'kb' | 'gcf' | 'both';
}

/** GCF vector search result (from existing SemanticSearchIndex) for RRF merge */
export interface VectorSearchResult {
  /** Unique identifier */
  id: string;
  /** Content text */
  content: string;
  /** Source URI */
  sourceUri: string;
  /** Similarity/relevance score */
  similarity: number;
}

// ─── Default Configuration ──────────────────────────────────────

const DEFAULT_KB_RETRIEVAL_CONFIG: KBRetrievalConfig = {
  relevanceThreshold: 0.65,
  maxChunks: 10,
  tokenBudget: 2048,
  rrfWeight: 0.4,
};

/** RRF constant k (standard default used in Reciprocal Rank Fusion) */
const RRF_K = 60;

/** Maximum chunks to request from the vector store per query (for large KBs) */
const VECTOR_STORE_QUERY_LIMIT = 50;

// ─── KB Retriever Class ─────────────────────────────────────────

/**
 * KBRetriever — Retrieves relevant knowledge chunks for GCF prompt enrichment.
 *
 * Integrates with the KBVectorStore and KBEmbeddingService to:
 *   1. Embed the user query
 *   2. Search the vector store for similar chunks
 *   3. Filter out results below the relevance threshold
 *   4. Respect the token budget (stops adding chunks when budget exhausted)
 *   5. Return empty results when nothing passes the threshold
 *
 * Usage:
 *   const retriever = new KBRetriever(vectorStore, embeddingService, config);
 *   const result = await retriever.retrieve('how does auth work?', 2048);
 *   // result.chunks contains relevant KB chunks within token budget
 */
export class KBRetriever {
  private config: KBRetrievalConfig;

  constructor(
    private vectorStore: KBVectorStore,
    private embeddingService: KBEmbeddingService,
    config?: Partial<KBRetrievalConfig>,
  ) {
    this.config = { ...DEFAULT_KB_RETRIEVAL_CONFIG, ...config };
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Retrieve relevant KB chunks for a query, respecting the token budget.
   *
   * Process:
   *   1. Embed the query using the EmbeddingService
   *   2. Search the vector store for top-K similar chunks
   *   3. Filter results below the relevance threshold
   *   4. Accumulate chunks until the token budget is exhausted
   *   5. Return the result set with timing metadata
   *
   * @param query - The natural language query to retrieve context for
   * @param tokenBudget - Token budget override (if provided, takes precedence over config)
   * @returns Retrieved chunks within budget, or empty result if nothing passes threshold
   */
  async retrieve(query: string, tokenBudget?: number): Promise<KBRetrievalResult> {
    const startTime = Date.now();
    const budget = tokenBudget ?? this.config.tokenBudget;

    // Edge case: empty query or zero budget
    if (!query.trim() || budget <= 0) {
      return this.emptyResult(startTime);
    }

    // Step 1: Embed the query
    const embeddingResult = await this.embeddingService.embed(query);
    const queryVector = embeddingResult.vector;

    // Step 2: Search the vector store
    // Request more than maxChunks to account for threshold filtering
    const searchLimit = Math.min(VECTOR_STORE_QUERY_LIMIT, this.config.maxChunks * 3);
    const searchResults = await this.vectorStore.search(queryVector, searchLimit);

    // Step 3: Filter by relevance threshold
    const relevantResults = searchResults.filter(
      (result) => result.similarity >= this.config.relevanceThreshold,
    );

    // If nothing passes the threshold, return empty
    if (relevantResults.length === 0) {
      return this.emptyResult(startTime);
    }

    // Step 4: Accumulate chunks within token budget
    const chunks = this.selectChunksWithinBudget(relevantResults, budget);

    // Step 5: Compute total tokens
    const totalTokens = chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0);

    return {
      chunks,
      totalTokens,
      queryTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Retrieve with pagination/streaming support for large knowledgebases (100K+ chunks).
   *
   * Uses an async generator to yield chunks one at a time, allowing the caller
   * to consume results incrementally without loading all results into memory.
   *
   * @param query - The natural language query
   * @param tokenBudget - Token budget for total retrieval
   * @param pageSize - Number of results to fetch per page from the vector store
   */
  async *retrieveStreaming(
    query: string,
    tokenBudget?: number,
    pageSize: number = 20,
  ): AsyncGenerator<RetrievedChunk, void, unknown> {
    const budget = tokenBudget ?? this.config.tokenBudget;

    if (!query.trim() || budget <= 0) {
      return;
    }

    // Embed the query
    const embeddingResult = await this.embeddingService.embed(query);
    const queryVector = embeddingResult.vector;

    // Paginated search: fetch in pages from the vector store
    let tokensUsed = 0;
    let chunksReturned = 0;
    let offset = 0;

    while (chunksReturned < this.config.maxChunks && tokensUsed < budget) {
      const searchResults = await this.vectorStore.search(queryVector, pageSize + offset);

      // Get only the page slice (skip already-processed results)
      const pageResults = searchResults.slice(offset);

      if (pageResults.length === 0) {
        break; // No more results available
      }

      for (const result of pageResults) {
        // Stop if we've hit our limits
        if (chunksReturned >= this.config.maxChunks || tokensUsed >= budget) {
          return;
        }

        // Filter by threshold
        if (result.similarity < this.config.relevanceThreshold) {
          // Results are sorted by similarity descending, so all subsequent will also be below
          return;
        }

        const tokenCount = this.estimateTokens(result.content);

        // Check if adding this chunk exceeds budget
        if (tokensUsed + tokenCount > budget) {
          // Skip this chunk but try smaller ones (in case subsequent chunks are smaller)
          continue;
        }

        const chunk: RetrievedChunk = {
          id: result.id,
          content: result.content,
          sourceUri: result.source_uri,
          similarity: result.similarity,
          tokenCount,
        };

        tokensUsed += tokenCount;
        chunksReturned++;
        yield chunk;
      }

      offset += pageResults.length;

      // Safety break: avoid infinite loops if vector store keeps returning same results
      if (offset > VECTOR_STORE_QUERY_LIMIT * 2) {
        break;
      }
    }
  }

  /**
   * Merge KB results with GCF semantic search results using Reciprocal Rank Fusion.
   *
   * RRF formula: score(d) = Σ 1/(k + rank(d)) for each result list containing d
   * where k is a constant (default: 60).
   *
   * The output is sorted by descending RRF score.
   *
   * Note: Full RRF implementation is in task 4.2 (rrf-merge.ts). This provides
   * a working baseline implementation.
   *
   * @param kbResults - Ranked results from KB retrieval (by similarity, descending)
   * @param gcfResults - Ranked results from GCF semantic search (by similarity, descending)
   * @returns Merged results sorted by RRF score (descending)
   */
  mergeWithRRF(kbResults: RetrievedChunk[], gcfResults: VectorSearchResult[]): MergedResult[] {
    const scoreMap = new Map<string, { score: number; content: string; sourceUri: string; origins: Set<string> }>();

    // Process KB results (rank is 1-based)
    for (let rank = 0; rank < kbResults.length; rank++) {
      const item = kbResults[rank]!;
      const rrfScore = 1 / (RRF_K + rank + 1);
      const existing = scoreMap.get(item.id);
      if (existing) {
        existing.score += rrfScore;
        existing.origins.add('kb');
      } else {
        scoreMap.set(item.id, {
          score: rrfScore,
          content: item.content,
          sourceUri: item.sourceUri,
          origins: new Set(['kb']),
        });
      }
    }

    // Process GCF results (rank is 1-based)
    for (let rank = 0; rank < gcfResults.length; rank++) {
      const item = gcfResults[rank]!;
      const rrfScore = 1 / (RRF_K + rank + 1);
      const existing = scoreMap.get(item.id);
      if (existing) {
        existing.score += rrfScore;
        existing.origins.add('gcf');
      } else {
        scoreMap.set(item.id, {
          score: rrfScore,
          content: item.content,
          sourceUri: item.sourceUri,
          origins: new Set(['gcf']),
        });
      }
    }

    // Convert to MergedResult array and sort by RRF score descending
    const merged: MergedResult[] = [];
    for (const [id, data] of scoreMap) {
      const origin: 'kb' | 'gcf' | 'both' =
        data.origins.has('kb') && data.origins.has('gcf')
          ? 'both'
          : data.origins.has('kb')
            ? 'kb'
            : 'gcf';

      merged.push({
        id,
        content: data.content,
        sourceUri: data.sourceUri,
        rrfScore: data.score,
        origin,
      });
    }

    merged.sort((a, b) => b.rrfScore - a.rrfScore);
    return merged;
  }

  // ─── Configuration Access ─────────────────────────────────────

  /**
   * Get the current retrieval configuration.
   */
  getConfig(): Readonly<KBRetrievalConfig> {
    return { ...this.config };
  }

  /**
   * Update the retrieval configuration.
   */
  updateConfig(newConfig: Partial<KBRetrievalConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Select chunks from search results that fit within the token budget.
   * Results are already sorted by similarity (descending) from the vector store.
   * Greedily adds chunks in order of relevance until budget is exhausted.
   */
  private selectChunksWithinBudget(
    results: KBVectorSearchResult[],
    budget: number,
  ): RetrievedChunk[] {
    const chunks: RetrievedChunk[] = [];
    let tokensUsed = 0;

    for (const result of results) {
      if (chunks.length >= this.config.maxChunks) {
        break;
      }

      const tokenCount = this.estimateTokens(result.content);

      // Skip chunk if it would exceed budget
      if (tokensUsed + tokenCount > budget) {
        continue;
      }

      chunks.push({
        id: result.id,
        content: result.content,
        sourceUri: result.source_uri,
        similarity: result.similarity,
        tokenCount,
      });

      tokensUsed += tokenCount;
    }

    return chunks;
  }

  /**
   * Estimate token count for a text string.
   * Uses the same heuristic as KBEmbeddingService for consistency.
   */
  private estimateTokens(text: string): number {
    if (text.length === 0) return 0;
    const charCount = text.length;
    const wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;
    const charBasedEstimate = Math.ceil(charCount / 4);
    const wordBasedEstimate = Math.ceil(wordCount * 1.3);
    return Math.max(charBasedEstimate, wordBasedEstimate);
  }

  /**
   * Create an empty retrieval result with timing.
   */
  private emptyResult(startTime: number): KBRetrievalResult {
    return {
      chunks: [],
      totalTokens: 0,
      queryTimeMs: Date.now() - startTime,
    };
  }
}
