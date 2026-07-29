/**
 * URLFetcher — Background HTTP fetcher with TTL caching, retry logic, and HTML stripping.
 *
 * Provides:
 *   - Background HTTP fetching with max concurrency of 3 (semaphore pattern)
 *   - TTL caching (default 30 minutes) with configurable expiry
 *   - Retry logic: 3 retries with exponential backoff (1s, 2s, 4s)
 *   - HTML stripping to extract text-only content
 *   - 512KB max response size enforcement
 *   - Max 20 URL sources per session
 *   - Background refresh for expired TTL entries
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 8.4
 */

import { createHash } from 'node:crypto';
import type { FetchResult } from './types';

// ─── Constants ──────────────────────────────────────────────────

/** Default TTL for cached URL content (30 minutes) */
export const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** Maximum response size in bytes (512KB) */
export const MAX_RESPONSE_BYTES = 512 * 1024;

/** Maximum concurrent URL sources per session */
export const MAX_URL_SOURCES = 20;

/** Maximum number of retries for failed fetches */
export const MAX_RETRIES = 3;

/** Exponential backoff intervals in milliseconds */
export const BACKOFF_INTERVALS_MS = [1000, 2000, 4000];

/** Maximum concurrent HTTP requests */
export const MAX_CONCURRENCY = 3;

// ─── Types ──────────────────────────────────────────────────────

/** Options for constructing a URLFetcher instance */
export interface URLFetcherOptions {
  maxConcurrency: number;
  defaultTTLMs: number;
  maxResponseBytes: number;
}

/** Cached content entry with TTL metadata */
export interface CachedContent {
  content: string;
  hash: string;
  fetchedAt: number;
  expiresAt: number;
  url: string;
}

/** Internal state for tracking in-flight fetch operations */
interface InFlightFetch {
  promise: Promise<FetchResult>;
  abortController: AbortController;
}

// ─── HTML Stripping ─────────────────────────────────────────────

/**
 * Strip HTML tags and extract text-only content.
 *
 * Removes script and style blocks entirely, strips all remaining HTML tags,
 * collapses whitespace, and decodes common HTML entities.
 *
 * @param html - Raw HTML string
 * @returns Plain text content extracted from HTML
 */
export function stripHtml(html: string): string {
  let text = html;

  // Remove script blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');

  // Remove style blocks
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // Replace block-level elements with newlines for readability
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));

  // Collapse multiple whitespace (preserving newlines)
  text = text.replace(/[^\S\n]+/g, ' ');

  // Collapse multiple consecutive newlines into at most two
  text = text.replace(/\n{3,}/g, '\n\n');

  // Trim each line and remove empty lines at start/end
  text = text
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .trim();

  return text;
}

/**
 * Compute SHA-256 hash of content.
 *
 * @param content - String to hash
 * @returns Hex-encoded SHA-256 hash
 */
export function computeHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

// ─── Semaphore ──────────────────────────────────────────────────

/**
 * Simple counting semaphore for limiting concurrency.
 */
class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }

    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next();
    }
  }
}

// ─── URLFetcher ─────────────────────────────────────────────────

/**
 * URLFetcher — Manages background HTTP fetching with caching, retries,
 * and concurrency control.
 *
 * Implements Requirements 3.1–3.7 and 8.4.
 */
export class URLFetcher {
  private readonly cache: Map<string, CachedContent> = new Map();
  private readonly inFlight: Map<string, InFlightFetch> = new Map();
  private readonly semaphore: Semaphore;
  private readonly defaultTTLMs: number;
  private readonly maxResponseBytes: number;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: URLFetcherOptions) {
    this.semaphore = new Semaphore(options.maxConcurrency);
    this.defaultTTLMs = options.defaultTTLMs;
    this.maxResponseBytes = options.maxResponseBytes;
  }

  /**
   * Fetch URL content with caching, retry logic, and HTML stripping.
   *
   * If the URL is already cached and not expired, returns the cached result.
   * Otherwise performs a new fetch with concurrency limiting and exponential
   * backoff retry on failure.
   *
   * @param url - The URL to fetch
   * @returns FetchResult with stripped text content and metadata
   * @throws Error if max URL sources exceeded or all retries fail
   *
   * Requirements: 3.1, 3.2, 3.4, 3.5, 3.6, 3.7
   */
  async fetch(url: string): Promise<FetchResult> {
    // Enforce max URL sources (Req 3.6)
    if (!this.cache.has(url) && this.cache.size >= MAX_URL_SOURCES) {
      throw new Error(
        `Maximum URL sources exceeded (${MAX_URL_SOURCES}). Remove an existing URL source before adding a new one.`
      );
    }

    // Return cached content if still valid (Req 3.2)
    const cached = this.cache.get(url);
    if (cached && Date.now() < cached.expiresAt) {
      return {
        content: cached.content,
        hash: cached.hash,
        fetchedAt: cached.fetchedAt,
        expiresAt: cached.expiresAt,
      };
    }

    // If already in-flight for this URL, reuse the pending request
    const existing = this.inFlight.get(url);
    if (existing) {
      return existing.promise;
    }

    // Start a new fetch with concurrency control
    const abortController = new AbortController();
    const promise = this.fetchWithRetry(url, abortController.signal);

    this.inFlight.set(url, { promise, abortController });

    try {
      const result = await promise;
      return result;
    } finally {
      this.inFlight.delete(url);
    }
  }

  /**
   * Get cached content for a URL without triggering a fetch.
   *
   * @param url - The URL to check
   * @returns CachedContent if available, null otherwise
   *
   * Requirement: 3.2
   */
  getCached(url: string): CachedContent | null {
    const cached = this.cache.get(url);
    if (!cached) {
      return null;
    }
    return cached;
  }

  /**
   * Refresh all entries whose TTL has expired.
   *
   * Re-fetches stale entries in the background and updates the cache
   * if the content hash differs.
   *
   * Requirement: 3.3
   */
  async refreshStale(): Promise<void> {
    const now = Date.now();
    const staleUrls: string[] = [];

    for (const [url, entry] of this.cache.entries()) {
      if (now >= entry.expiresAt) {
        staleUrls.push(url);
      }
    }

    // Refresh all stale entries concurrently (respecting semaphore limits)
    const refreshPromises = staleUrls.map(async (url) => {
      try {
        await this.fetch(url);
      } catch {
        // If refresh fails after retries, keep stale content
        // The entry remains in cache with the old content (Req 3.4)
      }
    });

    await Promise.allSettled(refreshPromises);
  }

  /**
   * Cancel an in-flight fetch for a URL and remove it from cache.
   *
   * @param url - The URL to cancel
   */
  cancel(url: string): void {
    // Abort in-flight request if any
    const inFlight = this.inFlight.get(url);
    if (inFlight) {
      inFlight.abortController.abort();
      this.inFlight.delete(url);
    }

    // Remove from cache
    this.cache.delete(url);
  }

  /**
   * Start the background refresh timer.
   *
   * Periodically checks for expired TTL entries and refreshes them.
   *
   * @param intervalMs - How often to check for stale entries (defaults to TTL / 2)
   */
  startBackgroundRefresh(intervalMs?: number): void {
    if (this.refreshTimer) {
      return;
    }

    const interval = intervalMs ?? Math.floor(this.defaultTTLMs / 2);
    this.refreshTimer = setInterval(() => {
      void this.refreshStale();
    }, interval);

    // Unref the timer so it doesn't prevent process exit
    if (this.refreshTimer && typeof this.refreshTimer === 'object' && 'unref' in this.refreshTimer) {
      this.refreshTimer.unref();
    }
  }

  /**
   * Stop the background refresh timer.
   */
  stopBackgroundRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Get the number of currently cached URLs.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Clear all cached entries and cancel in-flight requests.
   */
  dispose(): void {
    this.stopBackgroundRefresh();

    // Abort all in-flight requests
    for (const [, inFlight] of this.inFlight) {
      inFlight.abortController.abort();
    }
    this.inFlight.clear();
    this.cache.clear();
  }

  // ─── Private Methods ────────────────────────────────────────────

  /**
   * Fetch a URL with exponential backoff retry logic.
   *
   * Retries up to MAX_RETRIES times with intervals of 1s, 2s, 4s.
   *
   * @param url - The URL to fetch
   * @param signal - AbortSignal for cancellation
   * @returns FetchResult on success
   * @throws Error if all retries exhausted
   *
   * Requirements: 3.4, 3.5, 3.7, 8.4
   */
  private async fetchWithRetry(url: string, signal: AbortSignal): Promise<FetchResult> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Wait for backoff on retries (not on first attempt)
      if (attempt > 0) {
        const backoffMs = BACKOFF_INTERVALS_MS[attempt - 1];
        if (backoffMs !== undefined) {
          await this.delay(backoffMs);
        }
      }

      // Check if cancelled before attempting
      if (signal.aborted) {
        throw new Error('Fetch cancelled');
      }

      try {
        await this.semaphore.acquire();
        try {
          const result = await this.performFetch(url, signal);
          return result;
        } finally {
          this.semaphore.release();
        }
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on abort
        if (signal.aborted) {
          throw lastError;
        }

        // Don't retry on response too large (not a transient error)
        if (lastError.message.includes('exceeds maximum allowed size')) {
          throw lastError;
        }
      }
    }

    // All retries exhausted — mark as stale (Req 3.4)
    throw lastError ?? new Error(`Failed to fetch ${url} after ${MAX_RETRIES} retries`);
  }

  /**
   * Perform a single HTTP fetch operation.
   *
   * @param url - The URL to fetch
   * @param signal - AbortSignal for cancellation
   * @returns FetchResult with stripped content
   *
   * Requirements: 3.1, 3.5, 3.7
   */
  private async performFetch(url: string, signal: AbortSignal): Promise<FetchResult> {
    const response = await fetch(url, {
      signal,
      headers: {
        'User-Agent': 'NeuroNest-URLFetcher/1.0',
        'Accept': 'text/html, text/plain, application/json, */*',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Check Content-Length header first for early rejection (Req 3.5)
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > this.maxResponseBytes) {
      throw new Error(
        `Response size (${contentLength} bytes) exceeds maximum allowed size (${this.maxResponseBytes} bytes)`
      );
    }

    // Read response with size limiting
    const body = await this.readResponseWithLimit(response);

    // Strip HTML to extract text content (Req 3.7)
    const content = stripHtml(body);

    // Compute hash for cache comparison
    const hash = computeHash(content);

    const now = Date.now();
    const fetchResult: FetchResult = {
      content,
      hash,
      fetchedAt: now,
      expiresAt: now + this.defaultTTLMs,
    };

    // Update cache
    this.cache.set(url, {
      ...fetchResult,
      url,
    });

    return fetchResult;
  }

  /**
   * Read response body with size limit enforcement.
   *
   * @param response - The HTTP Response object
   * @returns The response text, guaranteed to be within size limits
   * @throws Error if response exceeds max size
   *
   * Requirement: 3.5
   */
  private async readResponseWithLimit(response: Response): Promise<string> {
    // If the response has a body reader, we can stream and limit
    if (!response.body) {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf-8') > this.maxResponseBytes) {
        throw new Error(
          `Response size exceeds maximum allowed size (${this.maxResponseBytes} bytes)`
        );
      }
      return text;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalBytes += value.byteLength;
        if (totalBytes > this.maxResponseBytes) {
          reader.cancel().catch(() => {});
          throw new Error(
            `Response size exceeds maximum allowed size (${this.maxResponseBytes} bytes)`
          );
        }

        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const buffer = Buffer.concat(chunks);
    return buffer.toString('utf-8');
  }

  /**
   * Delay execution for a specified duration.
   *
   * @param ms - Milliseconds to wait
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
