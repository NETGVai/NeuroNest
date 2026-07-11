/**
 * WebSearch Tool — Searches DuckDuckGo Instant Answer API and returns structured results.
 *
 * Provides:
 * - `parseDuckDuckGoResponse`: Pure function that parses DDG API response into SearchResult[]
 * - `webSearchExecute`: Full tool execute function with timeout, input validation, and error handling
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8
 */

import type { ToolContext, ToolResult } from '../../shared/types.js';
import { safeExecute, type FieldSchema } from './input-validator.js';

// ─── Types ──────────────────────────────────────────────────────

export interface WebSearchInput {
  query: string;
  maxResults?: number;
}

export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

/**
 * Shape of a single RelatedTopic entry from the DuckDuckGo API.
 * Topics can be either a direct result or a group containing subtopics.
 */
export interface DuckDuckGoTopic {
  Text?: string;
  FirstURL?: string;
  Result?: string;
  Name?: string;
  Topics?: DuckDuckGoTopic[];
}

/**
 * Shape of the DuckDuckGo Instant Answer API JSON response.
 */
export interface DuckDuckGoAPIResponse {
  Abstract?: string;
  AbstractText?: string;
  AbstractSource?: string;
  AbstractURL?: string;
  Heading?: string;
  RelatedTopics?: DuckDuckGoTopic[];
}

// ─── Constants ──────────────────────────────────────────────────

const DDG_API_ENDPOINT = 'https://api.duckduckgo.com/';
const DEFAULT_MAX_RESULTS = 10;
const REQUEST_TIMEOUT_MS = 10_000;

// ─── Input Schema ───────────────────────────────────────────────

const webSearchSchema: FieldSchema[] = [
  { name: 'query', type: 'string' },
  { name: 'maxResults', type: 'number', required: false },
];

// ─── parseDuckDuckGoResponse ────────────────────────────────────

/**
 * Pure function: parses a DuckDuckGo Instant Answer API response into an array of SearchResult objects.
 *
 * - If AbstractText is present and non-empty, it becomes the first result.
 * - Each RelatedTopic with a Text and FirstURL is parsed into a result.
 * - Nested topic groups (Topics array) are flattened.
 * - Results are capped at `maxResults`.
 *
 * @param response - The raw DuckDuckGo API JSON response
 * @param maxResults - Maximum number of results to return
 * @returns Array of SearchResult objects with title, snippet, and url
 */
export function parseDuckDuckGoResponse(
  response: DuckDuckGoAPIResponse,
  maxResults: number,
): SearchResult[] {
  const results: SearchResult[] = [];

  // Include AbstractText as the first result if present
  if (response.AbstractText && response.AbstractText.trim().length > 0) {
    results.push({
      title: response.Heading || response.AbstractSource || 'Abstract',
      snippet: response.AbstractText,
      url: response.AbstractURL || '',
    });
  }

  // Parse RelatedTopics into results
  if (Array.isArray(response.RelatedTopics)) {
    for (const topic of response.RelatedTopics) {
      if (results.length >= maxResults) break;

      // Direct topic with Text and FirstURL
      if (topic.Text && topic.FirstURL) {
        results.push({
          title: extractTitle(topic.Text),
          snippet: topic.Text,
          url: topic.FirstURL,
        });
      } else if (Array.isArray(topic.Topics)) {
        // Nested topic group — flatten subtopics
        for (const subtopic of topic.Topics) {
          if (results.length >= maxResults) break;

          if (subtopic.Text && subtopic.FirstURL) {
            results.push({
              title: extractTitle(subtopic.Text),
              snippet: subtopic.Text,
              url: subtopic.FirstURL,
            });
          }
        }
      }
    }
  }

  return results.slice(0, maxResults);
}

/**
 * Extracts a title from the topic Text field.
 * DDG topics often have the format "Title - description...", so we grab the first part.
 * If no dash separator exists, use the first 80 characters.
 */
function extractTitle(text: string): string {
  const dashIndex = text.indexOf(' - ');
  if (dashIndex > 0 && dashIndex < 80) {
    return text.substring(0, dashIndex);
  }
  // Fallback: use first 80 chars or full text if shorter
  return text.length > 80 ? text.substring(0, 80) + '...' : text;
}

// ─── webSearchExecute ───────────────────────────────────────────

/**
 * Searches DuckDuckGo Instant Answer API and returns structured results.
 *
 * - Validates input (query string required, optional maxResults number)
 * - Sends GET request to DDG API with 10000ms timeout via AbortController
 * - Parses the JSON response using parseDuckDuckGoResponse
 * - Returns ToolResult with success and array of SearchResult objects
 * - On any failure (network, timeout, parse error), returns success: false with error message
 *
 * @param input - Unknown input to be validated against schema
 * @param context - ToolContext with agentId, sessionId, etc.
 * @returns ToolResult with SearchResult[] output on success
 */
export const webSearchExecute = safeExecute<WebSearchInput>(
  webSearchSchema,
  async (input: WebSearchInput, _context: ToolContext): Promise<ToolResult> => {
    const { query, maxResults } = input;
    const limit = typeof maxResults === 'number' && maxResults > 0
      ? maxResults
      : DEFAULT_MAX_RESULTS;

    // Build the API URL
    const url = `${DDG_API_ENDPOINT}?q=${encodeURIComponent(query)}&format=json&no_html=1`;

    // Set up timeout with AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          success: false,
          output: null,
          error: `DuckDuckGo API returned ${response.status} ${response.statusText}`,
        };
      }

      const data = (await response.json()) as DuckDuckGoAPIResponse;
      const results = parseDuckDuckGoResponse(data, limit);

      return {
        success: true,
        output: results,
      };
    } catch (err: unknown) {
      clearTimeout(timeoutId);

      if (err instanceof Error && err.name === 'AbortError') {
        return {
          success: false,
          output: null,
          error: `Web search timed out after ${REQUEST_TIMEOUT_MS}ms`,
        };
      }

      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: null,
        error: `Web search failed: ${message}`,
      };
    }
  },
);
