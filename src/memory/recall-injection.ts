/**
 * Recall Injection — retrieves relevant cross-session memories and formats
 * them as a cost-budgeted system block for injection at turn start.
 *
 * Provides:
 *   - Keyword extraction from user prompts
 *   - Memory search via CrossSessionMemory FTS5
 *   - Formatted injection block: "From memory:\n- fact 1\n- fact 2"
 *   - Cap enforcement: max 5 entries, max 500 tokens (~2000 chars)
 *
 * Requirements: 19.4, 19.5, 19.6
 */

import type { CrossSessionMemory, MemoryEntry } from './cross-session-memory.js';

// ─── Types ──────────────────────────────────────────────────────

export interface RecallOptions {
  /** Maximum number of memory entries to include. Default: 5 */
  maxEntries?: number;
  /** Maximum token budget (approximated as chars / 4). Default: 500 */
  maxTokens?: number;
}

export interface RecallResult {
  /** Formatted injection text, or null if no relevant memories found */
  text: string | null;
  /** Number of entries included */
  entryCount: number;
  /** Approximate token count of the injection block */
  tokenEstimate: number;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_MAX_ENTRIES = 5;
const DEFAULT_MAX_TOKENS = 500;
const CHARS_PER_TOKEN = 4;
const RECALL_PREFIX = 'From memory:';

/**
 * Common stop words to filter from keyword extraction.
 * These add noise to FTS5 searches.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'must',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it',
  'they', 'them', 'their', 'this', 'that', 'these', 'those',
  'what', 'which', 'who', 'whom', 'where', 'when', 'why', 'how',
  'and', 'but', 'or', 'nor', 'not', 'no', 'so', 'if', 'then',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
  'up', 'about', 'into', 'through', 'during', 'before', 'after',
  'above', 'below', 'between', 'out', 'off', 'over', 'under',
  'again', 'further', 'once', 'here', 'there', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such',
  'than', 'too', 'very', 'just', 'also', 'now', 'please', 'help',
  'want', 'like', 'make', 'get', 'let', 'use', 'try',
]);

// ─── Keyword Extraction ─────────────────────────────────────────

/**
 * Extract meaningful keywords from a user prompt for memory search.
 * Removes stop words, short tokens, and punctuation.
 */
export function extractKeywords(prompt: string): string[] {
  if (!prompt || !prompt.trim()) {
    return [];
  }

  // Normalize: lowercase, remove special characters except hyphens and underscores
  const normalized = prompt
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = normalized.split(' ');

  // Filter: remove stop words, short words (< 3 chars), and duplicates
  const seen = new Set<string>();
  const keywords: string[] = [];

  for (const word of words) {
    if (word.length < 3) continue;
    if (STOP_WORDS.has(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    keywords.push(word);
  }

  return keywords;
}

// ─── Token Estimation ───────────────────────────────────────────

/**
 * Approximate token count from character count.
 * Uses the standard ~4 chars/token heuristic.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ─── Block Formatting ───────────────────────────────────────────

/**
 * Format memory entries into the injection block text.
 * Returns the formatted string or null if entries array is empty.
 *
 * Format:
 *   From memory:
 *   - entry content 1
 *   - entry content 2
 */
export function buildRecallBlock(entries: MemoryEntry[]): string | null {
  if (!entries || entries.length === 0) {
    return null;
  }

  const lines = entries.map((entry) => `- ${entry.content}`);
  return `${RECALL_PREFIX}\n${lines.join('\n')}`;
}

// ─── Main Recall Function ───────────────────────────────────────

/**
 * Search cross-session memory for relevant entries based on user prompt keywords,
 * and return a formatted injection block within cost budget.
 *
 * At turn start:
 * 1. Extract keywords from the user prompt
 * 2. Search memory for relevant entries
 * 3. Cap at maxEntries (default 5) and maxTokens (default 500)
 * 4. Format as "From memory:\n- fact 1\n- fact 2"
 *
 * Returns null if no relevant memories found.
 */
export function recall(
  prompt: string,
  memory: CrossSessionMemory,
  projectDir: string,
  options?: RecallOptions,
): RecallResult {
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;

  // Extract keywords from prompt
  const keywords = extractKeywords(prompt);

  if (keywords.length === 0) {
    return { text: null, entryCount: 0, tokenEstimate: 0 };
  }

  // Build search query from keywords using OR logic for broader matching
  // Append * for prefix matching (e.g. "fix" matches "fixed", "fixing")
  const query = keywords.map((k) => `${k}*`).join(' OR ');

  // Search memory — request more than maxEntries to account for token budget trimming
  const searchResults = memory.search(query, { limit: maxEntries * 2 });

  if (searchResults.length === 0) {
    return { text: null, entryCount: 0, tokenEstimate: 0 };
  }

  // Filter to project-specific entries
  const projectEntries = searchResults.filter((entry) => entry.projectDir === projectDir);

  // Fall back to all entries if no project-specific ones found
  const candidates = projectEntries.length > 0 ? projectEntries : searchResults;

  // Apply caps: max entries and max tokens
  const selected: MemoryEntry[] = [];
  let currentTokens = estimateTokens(RECALL_PREFIX + '\n');

  for (const entry of candidates) {
    if (selected.length >= maxEntries) break;

    const entryText = `- ${entry.content}\n`;
    const entryTokens = estimateTokens(entryText);

    if (currentTokens + entryTokens > maxTokens) break;

    selected.push(entry);
    currentTokens += entryTokens;
  }

  if (selected.length === 0) {
    return { text: null, entryCount: 0, tokenEstimate: 0 };
  }

  const text = buildRecallBlock(selected);
  const tokenEstimate = estimateTokens(text || '');

  return {
    text,
    entryCount: selected.length,
    tokenEstimate,
  };
}

export default recall;
