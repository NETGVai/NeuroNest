/**
 * GCF KB Integration — Hooks KB retrieval into the GCF prompt assembly pipeline.
 *
 * This module integrates the KB Retriever into the existing GCF Prompt Enrichment
 * pipeline by:
 *   1. Gating all logic behind NEURONEST_KB_SYSTEM feature flag (zero overhead when disabled)
 *   2. Retrieving relevant KB chunks after semantic search completes
 *   3. Merging KB results with GCF semantic search results via Reciprocal Rank Fusion
 *   4. Producing a compressible KB context block (subject to Context_Compression_V2 60% threshold)
 *   5. Integrating with Drift_Monitor for on-task evaluation of KB context
 *
 * The KB context block is positioned after semantic search results and before edit history
 * in the GCF prompt assembly pipeline.
 *
 * Requirements: 3.2, 3.4, 3.5, 38.1, 38.3
 */

import type { FeatureGateSystem } from '../../feature-gate/feature-gate-system.js';
import type { DriftMonitor } from '../../drift/drift-monitor.js';

// ─── Types ──────────────────────────────────────────────────────

/** Configuration for KB context injection into the GCF prompt assembly */
export interface GCFKBIntegrationConfig {
  /** Token budget allocated by Context_Window_Optimizer for KB context (default: 2048) */
  kbTokenBudget: number;
  /** RRF weight — proportion of total context budget allocated to KB results (default: 0.4 = 40%) */
  rrfWeight: number;
  /** Relevance threshold — chunks below this similarity are excluded (default: 0.65) */
  relevanceThreshold: number;
  /** Maximum number of KB chunks to include (default: 10) */
  maxChunks: number;
  /** Context_Compression_V2 trigger threshold — KB block is compressible at this ratio (default: 0.6) */
  compressionThreshold: number;
}

/** A context block in the GCF prompt assembly pipeline */
export interface GCFContextBlock {
  /** Label identifying this block in the prompt assembly */
  label: string;
  /** The textual content of this context block */
  content: string;
  /** Estimated token count of this block */
  tokenCount: number;
  /** Whether this block is subject to Context_Compression_V2 compression */
  compressible: boolean;
  /** Compression priority (lower = compressed later). KB context has medium priority */
  compressionPriority: number;
  /** Source identifier for audit/debug purposes */
  source: string;
}

/** GCF semantic search result (from existing SemanticSearchIndex) */
export interface GCFSemanticResult {
  /** Unique identifier */
  id: string;
  /** Content text */
  content: string;
  /** Source URI */
  sourceUri: string;
  /** Similarity/relevance score */
  similarity: number;
}

/** Result of the KB integration hook */
export interface GCFKBIntegrationResult {
  /** The KB context block to be inserted into the prompt, or null if no relevant results */
  contextBlock: GCFContextBlock | null;
  /** Whether KB retrieval was performed (false when feature is disabled) */
  wasRetrieved: boolean;
  /** Total tokens consumed by KB context */
  totalTokens: number;
  /** Query execution time in milliseconds */
  queryTimeMs: number;
  /** Number of KB chunks included in the context */
  chunkCount: number;
}

/** Drift evaluation metadata for KB context */
export interface KBDriftContext {
  /** The KB context content that was injected */
  kbContent: string;
  /** Source URIs contributing to this context */
  sourceUris: string[];
  /** Total tokens of KB context */
  tokenCount: number;
}

// ─── Default Configuration ──────────────────────────────────────

const DEFAULT_GCF_KB_CONFIG: GCFKBIntegrationConfig = {
  kbTokenBudget: 2048,
  rrfWeight: 0.4,
  relevanceThreshold: 0.65,
  maxChunks: 10,
  compressionThreshold: 0.6,
};

/** Compression priority for KB context (medium — compressed before stable system prompt, after verbose logs) */
const KB_COMPRESSION_PRIORITY = 50;

// ─── GCF KB Integration ─────────────────────────────────────────

/**
 * GCFKBIntegration — Hooks KB retrieval into the GCF prompt assembly pipeline.
 *
 * This is the main integration point between the KB_System and the GCF pipeline.
 * All KB logic is gated behind the NEURONEST_KB_SYSTEM feature flag; when the flag
 * is disabled, all methods return immediately with no-op results (zero overhead).
 *
 * Usage in the prompt assembly pipeline:
 * ```ts
 * const kbIntegration = createGCFKBIntegration(featureGate, config);
 *
 * // After semantic search completes, before edit history:
 * const kbResult = await kbIntegration.retrieveAndMerge(query, gcfResults, driftMonitor);
 * if (kbResult.contextBlock) {
 *   promptBlocks.push(kbResult.contextBlock); // Insert after semantic search block
 * }
 * ```
 */
export interface GCFKBIntegration {
  /**
   * Retrieve KB context and merge with existing GCF semantic search results.
   *
   * This is the main hook called during prompt assembly, positioned after
   * the semantic search step and before the edit history block.
   *
   * @param query - The current query/task being processed
   * @param gcfSemanticResults - Existing GCF semantic search results to merge with
   * @param driftMonitor - Optional Drift_Monitor instance for on-task evaluation
   * @returns Integration result containing the KB context block (or null)
   */
  retrieveAndMerge(
    query: string,
    gcfSemanticResults: GCFSemanticResult[],
    driftMonitor?: DriftMonitor | null,
  ): Promise<GCFKBIntegrationResult>;

  /**
   * Check if KB integration is active (feature flag enabled and retriever initialized).
   */
  isActive(): boolean;

  /**
   * Get the current integration configuration.
   */
  getConfig(): Readonly<GCFKBIntegrationConfig>;

  /**
   * Update the integration configuration at runtime.
   */
  updateConfig(config: Partial<GCFKBIntegrationConfig>): void;
}

// ─── Lazy-loaded dependencies (only imported when feature is enabled) ───

type LazyRRFMerge = typeof import('./rrf-merge.js');

// ─── Factory Function ───────────────────────────────────────────

/**
 * Create a GCFKBIntegration instance.
 *
 * The feature gate check happens immediately at creation time. If the
 * NEURONEST_KB_SYSTEM flag is disabled, a no-op implementation is returned
 * that has zero runtime overhead (no imports, no computation).
 *
 * @param featureGate - The feature gate system for checking NEURONEST_KB_SYSTEM
 * @param config - Optional configuration overrides
 * @returns GCFKBIntegration instance (active or no-op depending on feature gate)
 */
export function createGCFKBIntegration(
  featureGate: FeatureGateSystem | null,
  config?: Partial<GCFKBIntegrationConfig>,
): GCFKBIntegration {
  // ─── Feature Gate Check (early exit for zero overhead when disabled) ───
  if (!featureGate || !featureGate.isEnabled('neuronest_kb_system')) {
    return createNoOpIntegration();
  }

  return createActiveIntegration(config);
}

// ─── No-Op Implementation (zero overhead when disabled) ─────────

/**
 * No-op implementation returned when NEURONEST_KB_SYSTEM is disabled.
 * All methods return immediately with empty/false values.
 * No imports are performed, no computation happens.
 */
function createNoOpIntegration(): GCFKBIntegration {
  const emptyResult: GCFKBIntegrationResult = {
    contextBlock: null,
    wasRetrieved: false,
    totalTokens: 0,
    queryTimeMs: 0,
    chunkCount: 0,
  };

  return {
    async retrieveAndMerge(): Promise<GCFKBIntegrationResult> {
      return emptyResult;
    },
    isActive(): boolean {
      return false;
    },
    getConfig(): Readonly<GCFKBIntegrationConfig> {
      return DEFAULT_GCF_KB_CONFIG;
    },
    updateConfig(): void {
      // No-op: feature is disabled
    },
  };
}

// ─── Active Implementation (when feature is enabled) ────────────

function createActiveIntegration(
  configOverrides?: Partial<GCFKBIntegrationConfig>,
): GCFKBIntegration & { _setRetriever: (r: unknown) => void } {
  let config: GCFKBIntegrationConfig = { ...DEFAULT_GCF_KB_CONFIG, ...configOverrides };

  // Lazy-loaded module references (populated on first use)
  let rrfMergeModule: LazyRRFMerge | null = null;
  let retrieverInstance: { retrieve: (query: string, budget?: number) => Promise<{ chunks: Array<{ id: string; content: string; sourceUri: string; similarity: number; tokenCount: number }> }> } | null = null;

  /**
   * Ensure the RRF merge module is loaded.
   * Uses dynamic import to avoid loading heavy modules when the feature
   * gate is enabled but no KB query has been made yet.
   */
  async function ensureModulesLoaded(): Promise<boolean> {
    if (rrfMergeModule) {
      return true;
    }

    try {
      rrfMergeModule = await import('./rrf-merge.js');
      return true;
    } catch {
      // Module load failed — graceful degradation
      return false;
    }
  }

  /**
   * Format merged results into a text block for prompt injection.
   */
  function formatKBContextBlock(
    mergedChunks: Array<{ id: string; content: string; sourceUri: string; rrfScore: number }>,
  ): string {
    if (mergedChunks.length === 0) return '';

    const lines: string[] = ['[Knowledge Base Context]'];
    for (const chunk of mergedChunks) {
      lines.push(`--- Source: ${chunk.sourceUri} (relevance: ${chunk.rrfScore.toFixed(3)}) ---`);
      lines.push(chunk.content);
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * Estimate token count for a text string (matches the pipeline-wide heuristic).
   */
  function estimateTokens(text: string): number {
    if (text.length === 0) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Notify Drift_Monitor of the KB context injection for on-task evaluation.
   * This allows the Drift_Monitor to factor KB context into its scope
   * and confidence calculations.
   */
  function notifyDriftMonitor(
    driftMonitor: DriftMonitor | null | undefined,
    kbContext: KBDriftContext,
  ): void {
    if (!driftMonitor || !driftMonitor.isActive()) {
      return;
    }

    // Validate scope for the KB retrieval operation — uses 'kb_retrieve' as
    // a synthetic tool name so the Drift_Monitor can track KB context usage
    // in its scope evaluation.
    try {
      driftMonitor.validateScope('kb_retrieve');
    } catch {
      // Graceful degradation: drift monitor errors do not block KB retrieval
    }

    // Record the KB retrieval as a successful tool operation
    try {
      driftMonitor.recordToolResult('kb_retrieve', kbContext.tokenCount > 0);
    } catch {
      // Graceful degradation
    }
  }

  return {
    async retrieveAndMerge(
      query: string,
      gcfSemanticResults: GCFSemanticResult[],
      driftMonitor?: DriftMonitor | null,
    ): Promise<GCFKBIntegrationResult> {
      const startTime = Date.now();

      // Guard: empty query
      if (!query.trim()) {
        return {
          contextBlock: null,
          wasRetrieved: true,
          totalTokens: 0,
          queryTimeMs: Date.now() - startTime,
          chunkCount: 0,
        };
      }

      // Guard: no retriever instance configured
      if (!retrieverInstance) {
        return {
          contextBlock: null,
          wasRetrieved: false,
          totalTokens: 0,
          queryTimeMs: Date.now() - startTime,
          chunkCount: 0,
        };
      }

      // Ensure modules are loaded (lazy import)
      const modulesReady = await ensureModulesLoaded();
      if (!modulesReady || !rrfMergeModule) {
        return {
          contextBlock: null,
          wasRetrieved: false,
          totalTokens: 0,
          queryTimeMs: Date.now() - startTime,
          chunkCount: 0,
        };
      }

      // Retrieve KB chunks using the configured token budget (40% allocation by default)
      const kbBudget = Math.floor(config.kbTokenBudget * config.rrfWeight);

      try {
        // Use the RRF merge module to get merged results
        const { mergeWithRRF } = rrfMergeModule;

        // Get KB retrieval results
        const kbResult = await retrieverInstance.retrieve(query, kbBudget);
        const kbChunks = kbResult.chunks;

        // Merge KB results with GCF semantic search results using RRF
        // The mergeWithRRF function handles budget allocation internally
        const mergedResults = mergeWithRRF(
          kbChunks,
          gcfSemanticResults,
          { totalTokenBudget: config.kbTokenBudget, codeBudgetRatio: 1 - config.rrfWeight },
        );

        // Limit to maxChunks
        const selectedResults = mergedResults.slice(0, config.maxChunks);

        // If no results survived filtering, return null block
        if (selectedResults.length === 0) {
          return {
            contextBlock: null,
            wasRetrieved: true,
            totalTokens: 0,
            queryTimeMs: Date.now() - startTime,
            chunkCount: 0,
          };
        }

        // Format the KB context block
        const blockContent = formatKBContextBlock(selectedResults);
        const blockTokens = estimateTokens(blockContent);

        // Build the compressible context block (subject to Context_Compression_V2)
        const contextBlock: GCFContextBlock = {
          label: 'kb_context',
          content: blockContent,
          tokenCount: blockTokens,
          compressible: true, // Subject to Context_Compression_V2 at 60% threshold
          compressionPriority: KB_COMPRESSION_PRIORITY,
          source: 'neuronest_kb_system',
        };

        // Notify Drift_Monitor for on-task evaluation
        const driftContext: KBDriftContext = {
          kbContent: blockContent,
          sourceUris: selectedResults.map((r) => r.sourceUri),
          tokenCount: blockTokens,
        };
        notifyDriftMonitor(driftMonitor, driftContext);

        return {
          contextBlock,
          wasRetrieved: true,
          totalTokens: blockTokens,
          queryTimeMs: Date.now() - startTime,
          chunkCount: selectedResults.length,
        };
      } catch {
        // Graceful degradation: KB retrieval errors don't crash the pipeline
        return {
          contextBlock: null,
          wasRetrieved: false,
          totalTokens: 0,
          queryTimeMs: Date.now() - startTime,
          chunkCount: 0,
        };
      }
    },

    isActive(): boolean {
      return true;
    },

    getConfig(): Readonly<GCFKBIntegrationConfig> {
      return { ...config };
    },

    updateConfig(newConfig: Partial<GCFKBIntegrationConfig>): void {
      config = { ...config, ...newConfig };
    },

    _setRetriever(r: unknown): void {
      retrieverInstance = r as typeof retrieverInstance;
    },
  };
}

/**
 * Initialize the GCF KB Integration with a live retriever instance.
 *
 * Called during KB subsystem startup to wire the retriever into the
 * integration layer. This avoids circular dependencies by using a
 * post-construction initialization pattern.
 *
 * @param integration - The GCF KB integration instance
 * @param retriever - The initialized KBRetriever instance
 */
export function initializeGCFKBRetriever(
  integration: GCFKBIntegration,
  retriever: unknown,
): void {
  // Set the retriever instance on the active integration.
  // The no-op implementation does not have _setRetriever, so this is a no-op.
  const impl = integration as unknown as Record<string, unknown>;
  if (typeof impl['_setRetriever'] === 'function') {
    (impl['_setRetriever'] as (r: unknown) => void)(retriever);
  }
}
