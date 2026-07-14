/**
 * Semantic Search Tool — Agent-facing search tool for the SemanticIndex
 *
 * Registered in the agent tool registry with name `semantic_search`.
 * Accepts a natural language query, embeds it using the EmbeddingService,
 * searches the VectorStore for similar code chunks, and returns top-K results
 * formatted with file path, line range, chunk preview, and relevance score.
 *
 * Requirements: 2.4
 */

import type { ToolContext, ToolResult } from '../shared/types.js';
import type { ExecutableToolDefinition } from './tool-system.js';
import { safeExecute, type FieldSchema } from './built-in/input-validator.js';
import type { VectorStore, VectorSearchResult } from '../indexing/vector-store.js';
import type { EmbeddingService } from '../indexing/embedding-service.js';
import type { IndexingPipeline } from '../indexing/indexing-pipeline.js';

// ─── Types ──────────────────────────────────────────────────────

/** Input parameters for the semantic search tool */
export interface SemanticSearchInput {
  /** Natural language search query */
  query: string;
  /** Number of results to return (default: 10) */
  topK?: number;
}

/** A single formatted search result returned to the agent */
export interface SemanticSearchResultItem {
  /** Absolute or relative file path */
  filePath: string;
  /** Start line of the code chunk (1-indexed) */
  startLine: number;
  /** End line of the code chunk (1-indexed) */
  endLine: number;
  /** Name of the semantic chunk (function/class/method name) */
  chunkName: string;
  /** Type of the semantic chunk (function, class, method, block) */
  chunkType: string;
  /** Preview of the code chunk content */
  preview: string;
  /** Relevance score from 0 to 1 (cosine similarity) */
  relevanceScore: number;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 50;
const MAX_PREVIEW_LENGTH = 500;

// ─── Input Schema ───────────────────────────────────────────────

const semanticSearchSchema: FieldSchema[] = [
  { name: 'query', type: 'string' },
  { name: 'topK', type: 'number', required: false },
];

// ─── Result Formatting ──────────────────────────────────────────

/**
 * Format raw VectorSearchResult items into agent-friendly result objects.
 * Truncates long content previews and rounds relevance scores.
 */
export function formatSearchResults(
  results: VectorSearchResult[],
): SemanticSearchResultItem[] {
  return results.map((result) => ({
    filePath: result.filePath,
    startLine: result.startLine,
    endLine: result.endLine,
    chunkName: result.chunkName,
    chunkType: result.chunkType,
    preview: truncatePreview(result.content, MAX_PREVIEW_LENGTH),
    relevanceScore: Math.round(result.similarity * 1000) / 1000,
  }));
}

/**
 * Truncate content to a maximum length, adding an ellipsis indicator if truncated.
 */
export function truncatePreview(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength) + '...';
}

// ─── Execute Function Factory ───────────────────────────────────

/**
 * Create the semantic search execute function with injected dependencies.
 *
 * This factory pattern allows the tool to receive its dependencies
 * (VectorStore and EmbeddingService) at registration time, similar to
 * other factory-based tools in the built-in registry.
 *
 * @param deps - Dependencies providing access to the indexing pipeline
 */
export function createSemanticSearchExecute(deps: {
  getVectorStore: () => VectorStore | null;
  getEmbeddingService: () => EmbeddingService | null;
}): (input: unknown, context: ToolContext) => Promise<ToolResult> {
  return safeExecute<SemanticSearchInput>(
    semanticSearchSchema,
    async (input: SemanticSearchInput, _context: ToolContext): Promise<ToolResult> => {
      const { query, topK } = input;

      // Validate query is not empty
      if (!query.trim()) {
        return {
          success: false,
          output: null,
          error: 'Search query cannot be empty',
        };
      }

      // Resolve topK with bounds
      const k = Math.min(
        Math.max(typeof topK === 'number' && topK > 0 ? topK : DEFAULT_TOP_K, 1),
        MAX_TOP_K,
      );

      // Get the embedding service
      const embeddingService = deps.getEmbeddingService();
      if (!embeddingService) {
        return {
          success: false,
          output: null,
          error: 'Semantic index not initialized — embedding service unavailable',
        };
      }

      // Get the vector store
      const vectorStore = deps.getVectorStore();
      if (!vectorStore) {
        return {
          success: false,
          output: null,
          error: 'Semantic index not initialized — vector store unavailable',
        };
      }

      // 1. Embed the natural language query
      let queryVector: Float32Array;
      try {
        queryVector = await embeddingService.embedText(query);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          output: null,
          error: `Failed to embed query: ${message}`,
        };
      }

      // 2. Search the vector store for similar chunks
      let results: VectorSearchResult[];
      try {
        results = await vectorStore.search(queryVector, k);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          output: null,
          error: `Vector search failed: ${message}`,
        };
      }

      // 3. Format results for agent consumption
      const formattedResults = formatSearchResults(results);

      return {
        success: true,
        output: {
          query,
          results: formattedResults,
          totalResults: formattedResults.length,
          topK: k,
        },
      };
    },
  );
}

// ─── Tool Definition ────────────────────────────────────────────

/**
 * Create the SemanticSearchTool definition with injected dependencies.
 *
 * The tool is registered with id `semantic_search` and is available to
 * all agents for searching the codebase using natural language queries.
 *
 * @param deps - Dependencies providing access to the indexing pipeline components
 */
export function createSemanticSearchTool(deps: {
  getVectorStore: () => VectorStore | null;
  getEmbeddingService: () => EmbeddingService | null;
}): ExecutableToolDefinition {
  return {
    id: 'semantic_search',
    name: 'SemanticSearchTool',
    description:
      'Search the codebase using natural language. Returns relevant code chunks ' +
      'with file paths, line numbers, and relevance scores.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query describing the code to find',
        },
        topK: {
          type: 'number',
          description: 'Number of results to return (default: 10, max: 50)',
        },
      },
      required: ['query'],
    },
    riskLevel: 'read-only',
    execute: createSemanticSearchExecute(deps),
  };
}

// ─── Registration Helper ────────────────────────────────────────

/**
 * Register the semantic search tool with a ToolSystem instance.
 *
 * Uses the IndexingPipeline's accessors to provide the VectorStore
 * and EmbeddingService dependencies.
 *
 * @param toolSystem - The ToolSystem instance to register with
 * @param getIndexingPipeline - Getter that returns the IndexingPipeline (or null if not ready)
 */
export function registerSemanticSearchTool(
  toolSystem: { register: (tool: ExecutableToolDefinition) => void },
  getIndexingPipeline: () => IndexingPipeline | null,
): void {
  const tool = createSemanticSearchTool({
    getVectorStore: () => getIndexingPipeline()?.getVectorStore() ?? null,
    getEmbeddingService: () => getIndexingPipeline()?.getEmbeddingService() ?? null,
  });

  toolSystem.register(tool);
}
