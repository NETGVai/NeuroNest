/**
 * WebFetch Tool — Fetches URL content, strips HTML, enforces timeout, truncates output.
 *
 * Uses Node's native fetch (available in Node 18+) with AbortController for timeout.
 * Sets User-Agent: "NeuroNest/1.0" on all requests.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8
 */

import type { ToolContext, ToolResult } from '../../shared/types.js';
import { safeExecute, type FieldSchema } from './input-validator.js';

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const USER_AGENT = 'NeuroNest/1.0';
const MAX_OUTPUT_CHARS = 100_000;
const TRUNCATION_NOTICE = '\n\n[Content truncated: output exceeded 100,000 characters]';

// ─── Input Schema ───────────────────────────────────────────────

const WEB_FETCH_SCHEMA: FieldSchema[] = [
  { name: 'url', type: 'string' },
  { name: 'timeout', type: 'number', required: false },
];

// ─── stripHtml ──────────────────────────────────────────────────

/**
 * Pure function: strips HTML tags, <script> elements, <style> elements,
 * and normalizes whitespace. Exported separately for unit testing.
 *
 * @param html - Raw HTML string
 * @returns Plain text with no markup and normalized whitespace
 */
export function stripHtml(html: string): string {
  let text = html;

  // Remove <script> elements and their content
  text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

  // Remove <style> elements and their content
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

  // Remove all remaining HTML tags (replace with space to preserve word boundaries)
  text = text.replace(/<[^>]*>/g, ' ');

  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');

  // Normalize whitespace: collapse multiple spaces/tabs/newlines into single space
  text = text.replace(/\s+/g, ' ');

  // Trim leading and trailing whitespace
  text = text.trim();

  return text;
}

// ─── webFetchExecute ────────────────────────────────────────────

interface WebFetchInput {
  url: string;
  timeout?: number;
}

/**
 * Core fetch logic — called by safeExecute after input validation.
 */
async function fetchCore(input: WebFetchInput, _context: ToolContext): Promise<ToolResult> {
  const { url, timeout } = input;
  const timeoutMs = typeof timeout === 'number' && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS;

  // Set up AbortController for timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    });

    // Handle HTTP error responses (4xx/5xx)
    if (!response.ok) {
      return {
        success: false,
        output: null,
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    // Read response body
    let body = await response.text();

    // Strip HTML if content type is HTML
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      body = stripHtml(body);
    }

    // Truncate at 100k characters
    if (body.length > MAX_OUTPUT_CHARS) {
      body = body.slice(0, MAX_OUTPUT_CHARS) + TRUNCATION_NOTICE;
    }

    return {
      success: true,
      output: body,
    };
  } catch (err: unknown) {
    // Handle abort/timeout
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        success: false,
        output: null,
        error: `Request timed out after ${timeoutMs}ms`,
      };
    }

    // Handle network errors
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: null,
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches URL content, strips HTML, enforces timeout, truncates at 100k chars.
 * Wrapped with safeExecute for input validation and exception safety.
 */
export const webFetchExecute = safeExecute<WebFetchInput>(WEB_FETCH_SCHEMA, fetchCore);
