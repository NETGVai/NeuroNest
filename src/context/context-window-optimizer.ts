/**
 * Context Window Optimizer — Token-budget-aware context assembly.
 *
 * Prioritizes context entries by: pinned → recency → relevance score.
 * Applies progressive summarization when total exceeds 60% of context window.
 * Chunks large entries into ≤2000-token segments and selects the most relevant
 * chunks based on text overlap with the current prompt.
 * Reserves ≥25% of context window for LLM response.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
 */

import type { AssembledContext, ContextEntry, ScoredSnippet } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Approximate characters per token (simple heuristic: 1 token ≈ 4 characters). */
const CHARS_PER_TOKEN = 4;

/** Maximum tokens per chunk when splitting large entries. */
const MAX_TOKENS_PER_CHUNK = 2000;

/** Threshold (fraction of available budget) at which progressive summarization kicks in. */
const SUMMARIZATION_THRESHOLD = 0.6;

/** Number of prompts without access before demotion to background priority. */
const BACKGROUND_DEMOTION_THRESHOLD = 10;

// ---------------------------------------------------------------------------
// Context Window Optimizer
// ---------------------------------------------------------------------------

export class ContextWindowOptimizer {
  private readonly modelContextWindow: number;
  private readonly responseBudgetRatio: number;

  constructor(options: { modelContextWindow: number; responseBudgetRatio: number }) {
    this.modelContextWindow = options.modelContextWindow;
    this.responseBudgetRatio = Math.max(0.25, options.responseBudgetRatio);
  }

  /**
   * Assemble context entries into a token-budgeted string for inclusion in a prompt.
   *
   * Priority ordering:
   *   1. Pinned entries (always included first)
   *   2. Active entries sorted by recency (most recently accessed first)
   *   3. Background entries (summary only)
   *
   * When total exceeds 60% of available budget, lower-priority entries are
   * progressively summarized. Entries not accessed for >10 prompts are demoted
   * to background (summary only).
   */
  assemble(
    entries: ContextEntry[],
    prompt: string,
    semanticResults?: ScoredSnippet[],
  ): AssembledContext {
    // Calculate available token budget (total minus response reservation)
    const availableBudget = Math.floor(this.modelContextWindow * (1 - this.responseBudgetRatio));
    const summarizationTrigger = Math.floor(availableBudget * SUMMARIZATION_THRESHOLD);

    // Build relevance scores from semantic results
    const relevanceScores = this.buildRelevanceScores(entries, semanticResults);

    // Classify and sort entries by priority
    const { pinned, active, background } = this.classifyEntries(entries, relevanceScores);

    const includedEntryIds: string[] = [];
    const summarizedEntryIds: string[] = [];
    const droppedEntryIds: string[] = [];
    const assembledParts: string[] = [];
    let totalTokens = 0;

    // Phase 1: Include all pinned entries (full content or chunked)
    for (const entry of pinned) {
      const result = this.includeEntry(entry, prompt, availableBudget - totalTokens, false);
      if (result.tokens > 0 && totalTokens + result.tokens <= availableBudget) {
        assembledParts.push(result.text);
        totalTokens += result.tokens;
        includedEntryIds.push(entry.id);
      } else if (result.tokens > 0) {
        // Pinned but can't fully fit — summarize
        const summary = this.summarizeEntry(entry);
        const summaryTokens = this.estimateTokens(summary);
        if (totalTokens + summaryTokens <= availableBudget) {
          assembledParts.push(summary);
          totalTokens += summaryTokens;
          summarizedEntryIds.push(entry.id);
        } else {
          droppedEntryIds.push(entry.id);
        }
      } else {
        droppedEntryIds.push(entry.id);
      }
    }

    // Check if we need progressive summarization
    const needsSummarization = totalTokens >= summarizationTrigger;

    // Phase 2: Include active entries (sorted by recency, then relevance)
    for (const entry of active) {
      const remainingBudget = availableBudget - totalTokens;
      if (remainingBudget <= 0) {
        droppedEntryIds.push(entry.id);
        continue;
      }

      if (needsSummarization || totalTokens >= summarizationTrigger) {
        // Progressive summarization: summarize lower-priority entries
        const summary = this.summarizeEntry(entry);
        const summaryTokens = this.estimateTokens(summary);
        if (totalTokens + summaryTokens <= availableBudget) {
          assembledParts.push(summary);
          totalTokens += summaryTokens;
          summarizedEntryIds.push(entry.id);
        } else {
          droppedEntryIds.push(entry.id);
        }
      } else {
        const result = this.includeEntry(entry, prompt, remainingBudget, false);
        if (result.tokens > 0 && totalTokens + result.tokens <= availableBudget) {
          assembledParts.push(result.text);
          totalTokens += result.tokens;
          includedEntryIds.push(entry.id);

          // Re-check if we've crossed the summarization threshold
          // Future entries will be summarized
        } else if (result.tokens > 0) {
          // Doesn't fit in full — summarize
          const summary = this.summarizeEntry(entry);
          const summaryTokens = this.estimateTokens(summary);
          if (totalTokens + summaryTokens <= availableBudget) {
            assembledParts.push(summary);
            totalTokens += summaryTokens;
            summarizedEntryIds.push(entry.id);
          } else {
            droppedEntryIds.push(entry.id);
          }
        } else {
          droppedEntryIds.push(entry.id);
        }
      }
    }

    // Phase 3: Include background entries (summary only)
    for (const entry of background) {
      const remainingBudget = availableBudget - totalTokens;
      if (remainingBudget <= 0) {
        droppedEntryIds.push(entry.id);
        continue;
      }

      const summary = this.summarizeEntry(entry);
      const summaryTokens = this.estimateTokens(summary);
      if (totalTokens + summaryTokens <= availableBudget) {
        assembledParts.push(summary);
        totalTokens += summaryTokens;
        summarizedEntryIds.push(entry.id);
      } else {
        droppedEntryIds.push(entry.id);
      }
    }

    return {
      text: assembledParts.join('\n\n'),
      tokenCount: totalTokens,
      includedEntryIds,
      summarizedEntryIds,
      droppedEntryIds,
    };
  }

  /**
   * Produce a concise summary of a context entry.
   * Extracts the first few meaningful lines as a representative summary.
   */
  summarizeEntry(entry: ContextEntry): string {
    const content = entry.content ?? '';
    if (!content) {
      return `[${entry.type}] ${entry.source} (no content)`;
    }

    // Take first 3 non-empty lines as summary
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    const summaryLines = lines.slice(0, 3);
    const summaryText = summaryLines.join('\n');

    // If the summary is much shorter than full content, indicate truncation
    if (lines.length > 3) {
      return `[${entry.type}: ${entry.source}]\n${summaryText}\n... (${lines.length - 3} more lines)`;
    }

    return `[${entry.type}: ${entry.source}]\n${summaryText}`;
  }

  /**
   * Split a context entry's content into chunks of ≤maxTokensPerChunk tokens.
   * Splits on line boundaries where possible to preserve semantic coherence.
   */
  chunkEntry(entry: ContextEntry, maxTokensPerChunk: number = MAX_TOKENS_PER_CHUNK): string[] {
    const content = entry.content ?? '';
    if (!content) return [];

    const maxChars = maxTokensPerChunk * CHARS_PER_TOKEN;

    // If content fits in one chunk, return as-is
    if (content.length <= maxChars) {
      return [content];
    }

    const chunks: string[] = [];
    const lines = content.split('\n');
    let currentChunk = '';

    for (const line of lines) {
      const lineWithNewline = currentChunk ? '\n' + line : line;

      if (currentChunk.length + lineWithNewline.length > maxChars) {
        // Current line would exceed chunk limit
        if (currentChunk) {
          chunks.push(currentChunk);
          currentChunk = '';
        }

        // If single line is too long, split it at character boundaries
        if (line.length > maxChars) {
          let remaining = line;
          while (remaining.length > maxChars) {
            chunks.push(remaining.slice(0, maxChars));
            remaining = remaining.slice(maxChars);
          }
          if (remaining) {
            currentChunk = remaining;
          }
        } else {
          currentChunk = line;
        }
      } else {
        currentChunk += lineWithNewline;
      }
    }

    // Don't forget the last chunk
    if (currentChunk) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  // ─── Private Helpers ──────────────────────────────────────────────

  /**
   * Classify entries into pinned, active, and background categories.
   * Entries not accessed for >10 prompts are demoted to background.
   */
  private classifyEntries(
    entries: ContextEntry[],
    relevanceScores: Map<string, number>,
  ): {
    pinned: ContextEntry[];
    active: ContextEntry[];
    background: ContextEntry[];
  } {
    const pinned: ContextEntry[] = [];
    const active: ContextEntry[] = [];
    const background: ContextEntry[] = [];

    for (const entry of entries) {
      // Demote to background if not accessed for >10 prompts (Requirement 7.5)
      if (entry.promptsSinceLastAccess > BACKGROUND_DEMOTION_THRESHOLD) {
        background.push(entry);
        continue;
      }

      switch (entry.priority) {
        case 'pinned':
          pinned.push(entry);
          break;
        case 'active':
          active.push(entry);
          break;
        case 'background':
          background.push(entry);
          break;
      }
    }

    // Sort active entries by recency (most recently accessed first), then relevance
    active.sort((a, b) => {
      // Primary: recency (most recent first)
      const recencyDiff = b.lastAccessedAt - a.lastAccessedAt;
      if (recencyDiff !== 0) return recencyDiff;

      // Secondary: relevance score (higher first)
      const scoreA = relevanceScores.get(a.id) ?? 0;
      const scoreB = relevanceScores.get(b.id) ?? 0;
      return scoreB - scoreA;
    });

    // Sort background by relevance (most relevant first for inclusion priority)
    background.sort((a, b) => {
      const scoreA = relevanceScores.get(a.id) ?? 0;
      const scoreB = relevanceScores.get(b.id) ?? 0;
      return scoreB - scoreA;
    });

    return { pinned, active, background };
  }

  /**
   * Build a relevance score map from semantic search results.
   * Entries with matching sources in the semantic results receive their similarity score.
   */
  private buildRelevanceScores(
    entries: ContextEntry[],
    semanticResults?: ScoredSnippet[],
  ): Map<string, number> {
    const scores = new Map<string, number>();

    if (!semanticResults || semanticResults.length === 0) {
      return scores;
    }

    // Build lookup: source path → best similarity score
    const sourceScores = new Map<string, number>();
    for (const result of semanticResults) {
      const existing = sourceScores.get(result.symbol.filePath) ?? 0;
      if (result.score > existing) {
        sourceScores.set(result.symbol.filePath, result.score);
      }
    }

    // Map source scores to entry IDs
    for (const entry of entries) {
      const score = sourceScores.get(entry.source);
      if (score !== undefined) {
        scores.set(entry.id, score);
      }
    }

    return scores;
  }

  /**
   * Attempt to include an entry within the remaining token budget.
   * For large entries, chunks and selects the most relevant chunks by text overlap with prompt.
   */
  private includeEntry(
    entry: ContextEntry,
    prompt: string,
    remainingBudget: number,
    _summarize: boolean,
  ): { text: string; tokens: number } {
    const content = entry.content ?? '';
    if (!content) {
      return { text: '', tokens: 0 };
    }

    const contentTokens = this.estimateTokens(content);

    // If full content fits within budget, include it all
    if (contentTokens <= remainingBudget) {
      return { text: this.formatEntry(entry, content), tokens: contentTokens };
    }

    // Content too large — chunk and select best chunks
    const chunks = this.chunkEntry(entry, MAX_TOKENS_PER_CHUNK);
    if (chunks.length === 0) {
      return { text: '', tokens: 0 };
    }

    // Score chunks by text overlap with prompt
    const scoredChunks = chunks.map((chunk, index) => ({
      chunk,
      index,
      score: this.computeTextOverlap(chunk, prompt),
      tokens: this.estimateTokens(chunk),
    }));

    // Sort by relevance score (descending)
    scoredChunks.sort((a, b) => b.score - a.score);

    // Greedily select chunks within budget
    const selectedChunks: { chunk: string; index: number }[] = [];
    let selectedTokens = 0;

    for (const scored of scoredChunks) {
      if (selectedTokens + scored.tokens > remainingBudget) continue;
      selectedChunks.push({ chunk: scored.chunk, index: scored.index });
      selectedTokens += scored.tokens;
    }

    if (selectedChunks.length === 0) {
      return { text: '', tokens: 0 };
    }

    // Sort selected chunks by original order for coherence
    selectedChunks.sort((a, b) => a.index - b.index);
    const selectedText = selectedChunks.map((c) => c.chunk).join('\n...\n');
    const formattedText = this.formatEntry(entry, selectedText);

    return { text: formattedText, tokens: selectedTokens };
  }

  /**
   * Format an entry with a header indicating its source.
   */
  private formatEntry(entry: ContextEntry, content: string): string {
    return `[${entry.type}: ${entry.source}]\n${content}`;
  }

  /**
   * Compute a simple text overlap score between a chunk and the prompt.
   * Uses word-level intersection (Jaccard-like similarity).
   */
  private computeTextOverlap(chunk: string, prompt: string): number {
    const chunkWords = this.extractWords(chunk);
    const promptWords = this.extractWords(prompt);

    if (promptWords.size === 0) return 0;

    let overlap = 0;
    for (const word of promptWords) {
      if (chunkWords.has(word)) {
        overlap++;
      }
    }

    return overlap / promptWords.size;
  }

  /**
   * Extract unique lowercase words from text for overlap computation.
   */
  private extractWords(text: string): Set<string> {
    const words = text.toLowerCase().match(/\b[a-z][a-z0-9_]*\b/g);
    return new Set(words ?? []);
  }

  /**
   * Estimate the number of tokens in a string using the 4-char heuristic.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }
}
