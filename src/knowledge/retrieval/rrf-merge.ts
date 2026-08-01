/**
 * Reciprocal Rank Fusion (RRF) Merge — Merges KB results with GCF semantic search results.
 *
 * Implements the standard RRF formula:
 *   score(d) = sum of 1/(k + rank(d)) for each result list containing d
 *
 * Where k is a constant (default: 60) that mitigates the impact of high rankings
 * in individual result lists.
 *
 * Configurable budget allocation between KB and GCF results:
 *   - Default: 60% code (GCF semantic search), 40% KB
 *   - Budget constraints are applied after RRF scoring to select items within token limits
 *
 * Requirements: 38.2, 38.5
 */

import type { RetrievedChunk, VectorSearchResult } from './kb-retriever.js';

// ─── Types ──────────────────────────────────────────────────────

/** Configuration for RRF merge with budget allocation */
export interface RRFMergeOptions {
  /** RRF constant k (default: 60). Higher values reduce the impact of top-ranked items. */
  k?: number;
  /** Total token budget available for merged results (default: unlimited) */
  totalTokenBudget: number;
  /** Fraction of token budget allocated to code/GCF results (default: 0.6 = 60%) */
  codeBudgetRatio?: number;
}

/** Simpler config for use without budget constraints (e.g., from gcf-kb-integration) */
export interface RRFConfig {
  /** RRF constant k (default: 60) */
  k?: number;
  /** Weight multiplier for KB results (default: 0.4 = 40%) */
  kbWeight?: number;
  /** Weight multiplier for GCF results (default: 0.6 = 60%) */
  gcfWeight?: number;
}

/** A merged result with computed RRF score and origin tracking */
export interface MergedResult {
  /** Unique item identifier */
  id: string;
  /** The text content */
  content: string;
  /** Source URI */
  sourceUri: string;
  /** Computed RRF score (sum of reciprocal ranks across input lists containing this item) */
  rrfScore: number;
  /** Origin list(s): 'kb', 'gcf', or 'both' */
  origin: 'kb' | 'gcf' | 'both';
  /** Token count of this item */
  tokenCount: number;
}

// ─── Default Configuration ──────────────────────────────────────

const DEFAULT_K = 60;
const DEFAULT_CODE_BUDGET_RATIO = 0.6;

// ─── Token Estimation ───────────────────────────────────────────

/** Estimate token count for a text string (matches pipeline-wide heuristic: ~4 chars per token) */
function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const charCount = text.length;
  const wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;
  const charBasedEstimate = Math.ceil(charCount / 4);
  const wordBasedEstimate = Math.ceil(wordCount * 1.3);
  return Math.max(charBasedEstimate, wordBasedEstimate);
}

// ─── RRF Score Computation (no budget filtering) ────────────────

/**
 * Compute RRF scores for all items without applying budget constraints.
 * Returns all items sorted by descending RRF score.
 *
 * This is useful for computing raw relevance before budget allocation.
 *
 * @param kbResults - Ranked results from KB retrieval (sorted by similarity, descending)
 * @param gcfResults - Ranked results from GCF semantic search (sorted by similarity, descending)
 * @param k - RRF constant (default: 60)
 * @returns All merged results sorted by RRF score (descending), no budget filtering
 */
export function computeRRFScores(
  kbResults: RetrievedChunk[],
  gcfResults: VectorSearchResult[],
  k: number = DEFAULT_K,
): MergedResult[] {
  const scoreMap = new Map<string, {
    score: number;
    content: string;
    sourceUri: string;
    tokenCount: number;
    origins: Set<'kb' | 'gcf'>;
  }>();

  // Process KB results (rank is 1-based: rank 1 → index 0)
  for (let rank = 0; rank < kbResults.length; rank++) {
    const item = kbResults[rank]!;
    const rrfScore = 1 / (k + rank + 1);
    const existing = scoreMap.get(item.id);
    if (existing) {
      existing.score += rrfScore;
      existing.origins.add('kb');
    } else {
      scoreMap.set(item.id, {
        score: rrfScore,
        content: item.content,
        sourceUri: item.sourceUri,
        tokenCount: item.tokenCount,
        origins: new Set<'kb' | 'gcf'>(['kb']),
      });
    }
  }

  // Process GCF results (rank is 1-based: rank 1 → index 0)
  for (let rank = 0; rank < gcfResults.length; rank++) {
    const item = gcfResults[rank]!;
    const rrfScore = 1 / (k + rank + 1);
    const existing = scoreMap.get(item.id);
    if (existing) {
      existing.score += rrfScore;
      existing.origins.add('gcf');
    } else {
      scoreMap.set(item.id, {
        score: rrfScore,
        content: item.content,
        sourceUri: item.sourceUri,
        tokenCount: estimateTokens(item.content),
        origins: new Set<'kb' | 'gcf'>(['gcf']),
      });
    }
  }

  // Convert to sorted merged array
  return buildSortedResults(scoreMap);
}

// ─── RRF Merge with Budget Constraints ──────────────────────────

/**
 * Merge KB results with GCF semantic search results using Reciprocal Rank Fusion,
 * applying budget constraints based on the configurable code/KB split.
 *
 * The RRF formula is:
 *   score(d) = Σ 1/(k + rank(d)) for each result list containing d
 *
 * After scoring, results are filtered by their origin's budget allocation:
 *   - GCF-origin items consume from the code budget (default: 60%)
 *   - KB-origin items consume from the KB budget (default: 40%)
 *   - Items in both lists consume from whichever budget has more remaining
 *
 * @param kbResults - Ranked results from KB retrieval (sorted by similarity, descending)
 * @param gcfResults - Ranked results from GCF semantic search (sorted by similarity, descending)
 * @param options - Merge options with budget configuration
 * @returns Merged results sorted by RRF score (descending), budget-constrained
 */
export function mergeWithRRF(
  kbResults: RetrievedChunk[],
  gcfResults: VectorSearchResult[],
  options?: Partial<RRFMergeOptions> | Partial<RRFConfig>,
): MergedResult[] {
  const k = (options as RRFMergeOptions)?.k ?? (options as RRFConfig)?.k ?? DEFAULT_K;

  // Check if this is a budget-constrained call (RRFMergeOptions style)
  const hasBudget = 'totalTokenBudget' in (options ?? {});

  // Compute all RRF scores first
  const allResults = computeRRFScores(kbResults, gcfResults, k);

  // If no budget specified or budget is effectively unlimited, return all
  if (!hasBudget) {
    return allResults;
  }

  const totalBudget = (options as RRFMergeOptions)?.totalTokenBudget ?? Infinity;
  if (totalBudget <= 0) return [];

  const codeBudgetRatio = (options as RRFMergeOptions & { codeBudgetRatio?: number })?.codeBudgetRatio ?? DEFAULT_CODE_BUDGET_RATIO;
  const kbBudgetRatio = 1 - codeBudgetRatio;

  let codeBudgetRemaining = Math.floor(totalBudget * codeBudgetRatio);
  let kbBudgetRemaining = Math.floor(totalBudget * kbBudgetRatio);

  // Greedily select items in RRF score order, respecting per-category budgets
  const selected: MergedResult[] = [];

  for (const result of allResults) {
    const tokens = result.tokenCount;

    if (result.origin === 'gcf') {
      if (tokens <= codeBudgetRemaining) {
        selected.push(result);
        codeBudgetRemaining -= tokens;
      }
    } else if (result.origin === 'kb') {
      if (tokens <= kbBudgetRemaining) {
        selected.push(result);
        kbBudgetRemaining -= tokens;
      }
    } else {
      // 'both' — consume from whichever budget has more remaining
      if (kbBudgetRemaining >= codeBudgetRemaining) {
        if (tokens <= kbBudgetRemaining) {
          selected.push(result);
          kbBudgetRemaining -= tokens;
        }
      } else {
        if (tokens <= codeBudgetRemaining) {
          selected.push(result);
          codeBudgetRemaining -= tokens;
        }
      }
    }
  }

  return selected;
}

/**
 * Compute the RRF score for a single item given its ranks in the input lists.
 * Utility function for testing and debugging.
 *
 * @param ranks - Object with optional 'kb' and 'gcf' ranks (0-based)
 * @param k - RRF constant (default: 60)
 * @returns Computed RRF score
 */
export function computeRRFScore(
  ranks: { kb?: number; gcf?: number },
  k: number = DEFAULT_K,
): number {
  let score = 0;
  if (ranks.kb !== undefined) {
    score += 1 / (k + ranks.kb + 1);
  }
  if (ranks.gcf !== undefined) {
    score += 1 / (k + ranks.gcf + 1);
  }
  return score;
}

// ─── Private Helpers ────────────────────────────────────────────

function buildSortedResults(
  scoreMap: Map<string, {
    score: number;
    content: string;
    sourceUri: string;
    tokenCount: number;
    origins: Set<'kb' | 'gcf'>;
  }>,
): MergedResult[] {
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
      tokenCount: data.tokenCount,
    });
  }

  merged.sort((a, b) => b.rrfScore - a.rrfScore);
  return merged;
}
