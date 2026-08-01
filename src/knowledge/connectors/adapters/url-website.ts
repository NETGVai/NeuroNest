/**
 * URL/Website Connector Adapter — fetches web pages with security sandboxing,
 * robots.txt compliance, rate limiting, and aggregate resource limits.
 *
 * Lifecycle:
 *   connect() → validate domain against NetworkSandbox + security profile allowedDomains
 *   list()    → discover pages via basic link crawling from root URL (depth-limited)
 *   fetch()   → download pages with 1 req/s/domain rate limiting, robots.txt respect
 *   disconnect() → release resources
 *
 * Requirements: 1.5, 32.3, 43.1, 43.2, 43.3, 43.4
 */

import { createHash } from 'node:crypto';
import {
  type KBConnector,
  type ConnectorConfig,
  type SourceEntry,
  type RawDocument,
  type ConnectorSecurityProfile,
} from '../types';
import {
  NetworkSandbox,
  domainMatchesPattern,
} from '../../../security/network-sandbox';

// ─── Constants ──────────────────────────────────────────────────

/** Default maximum number of URLs per project */
const DEFAULT_MAX_URLS_PER_PROJECT = 100;

/** Default maximum aggregate storage for URL-sourced content (2 GB) */
const DEFAULT_MAX_AGGREGATE_BYTES = 2 * 1024 * 1024 * 1024;

/** Default maximum crawl depth for link discovery */
const DEFAULT_MAX_CRAWL_DEPTH = 3;

/** Default rate limit: 1 request per second per domain */
const RATE_LIMIT_INTERVAL_MS = 1000;

/** Default per-document size limit (10 MB) */
const DEFAULT_MAX_FETCH_SIZE_BYTES = 10 * 1024 * 1024;

/** Default execution timeout for individual fetch operations (30s) */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

// ─── Types ──────────────────────────────────────────────────────

/** Parsed robots.txt rules for a domain */
interface RobotsTxtRules {
  disallowedPaths: string[];
  allowedPaths: string[];
  crawlDelay?: number;
  fetchedAt: number;
}

/** Rate limiter state per domain */
interface DomainRateState {
  lastRequestTime: number;
}

/** Options for the URL/Website connector */
export interface UrlWebsiteConnectorOptions {
  /** Maximum URLs per project (default: 100) */
  maxUrlsPerProject?: number;
  /** Maximum aggregate size in bytes (default: 2 GB) */
  maxAggregateBytes?: number;
  /** Maximum crawl depth for link discovery (default: 3) */
  maxCrawlDepth?: number;
  /** Custom fetch implementation (for testing) */
  fetchImpl?: typeof globalThis.fetch;
}

// ─── URL/Website Connector ──────────────────────────────────────

/**
 * Connector adapter for URL/website sources.
 * Implements the KBConnector interface with full security integration.
 */
export class UrlWebsiteConnector implements KBConnector {
  readonly type = 'url-website' as const;

  private config: ConnectorConfig | null = null;
  private securityProfile: ConnectorSecurityProfile | null = null;
  private rootUrl: URL | null = null;
  private connected = false;

  // Resource tracking
  private discoveredEntries: SourceEntry[] = [];
  private totalFetchedBytes = 0;

  // Robots.txt cache per domain
  private robotsCache: Map<string, RobotsTxtRules> = new Map();

  // Rate limiting per domain
  private rateLimitState: Map<string, DomainRateState> = new Map();

  // Configurable limits
  private readonly maxUrlsPerProject: number;
  private readonly maxAggregateBytes: number;
  private readonly maxCrawlDepth: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options?: UrlWebsiteConnectorOptions) {
    this.maxUrlsPerProject = options?.maxUrlsPerProject ?? DEFAULT_MAX_URLS_PER_PROJECT;
    this.maxAggregateBytes = options?.maxAggregateBytes ?? DEFAULT_MAX_AGGREGATE_BYTES;
    this.maxCrawlDepth = options?.maxCrawlDepth ?? DEFAULT_MAX_CRAWL_DEPTH;
    this.fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  }

  // ─── Lifecycle: connect() ─────────────────────────────────────

  /**
   * Validate the domain against NetworkSandbox policies and security profile allowedDomains.
   * Throws if the domain is not permitted.
   */
  async connect(config: ConnectorConfig): Promise<void> {
    if (config.type !== 'url-website') {
      throw new Error(`UrlWebsiteConnector: expected type 'url-website', got '${config.type}'`);
    }

    // Parse and validate the root URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(config.uri);
    } catch {
      throw new Error(`UrlWebsiteConnector: invalid URI '${config.uri}'`);
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error(
        `UrlWebsiteConnector: unsupported protocol '${parsedUrl.protocol}', only http/https allowed`,
      );
    }

    const domain = parsedUrl.hostname;

    // Build security profile from config
    this.securityProfile = config.securityProfile
      ? {
          allowedDomains: config.securityProfile.allowedDomains ?? undefined,
          maxFetchSizeBytes: config.securityProfile.maxFetchSizeBytes ?? DEFAULT_MAX_FETCH_SIZE_BYTES,
          maxTotalSizeBytes: config.securityProfile.maxTotalSizeBytes ?? DEFAULT_MAX_AGGREGATE_BYTES,
          executionTimeoutMs: config.securityProfile.executionTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
        }
      : {
          maxFetchSizeBytes: DEFAULT_MAX_FETCH_SIZE_BYTES,
          maxTotalSizeBytes: DEFAULT_MAX_AGGREGATE_BYTES,
          executionTimeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
        };

    // Check security profile allowedDomains
    if (this.securityProfile.allowedDomains && this.securityProfile.allowedDomains.length > 0) {
      const domainAllowed = this.securityProfile.allowedDomains.some(
        (pattern) => domainMatchesPattern(domain, pattern),
      );
      if (!domainAllowed) {
        throw new Error(
          `UrlWebsiteConnector: domain '${domain}' is not in the security profile allowedDomains`,
        );
      }
    }

    // Validate against NetworkSandbox policy
    const sandbox = NetworkSandbox.getInstance();
    const port = parsedUrl.port
      ? parseInt(parsedUrl.port, 10)
      : parsedUrl.protocol === 'https:' ? 443 : 80;
    const evalResult = sandbox.evaluateRequest('GET', config.uri);

    if (!evalResult.allowed) {
      throw new Error(
        `UrlWebsiteConnector: NetworkSandbox blocked domain '${domain}': ${evalResult.reason}`,
      );
    }

    this.config = config;
    this.rootUrl = parsedUrl;
    this.connected = true;
    this.discoveredEntries = [];
    this.totalFetchedBytes = 0;
  }

  // ─── Lifecycle: list() ────────────────────────────────────────

  /**
   * Discover pages starting from the root URL using basic link crawling
   * with a configurable depth limit. Respects the URL count limit.
   */
  async list(): Promise<SourceEntry[]> {
    this.assertConnected();

    const visited = new Set<string>();
    const entries: SourceEntry[] = [];
    const queue: Array<{ url: string; depth: number }> = [
      { url: this.rootUrl!.href, depth: 0 },
    ];

    while (queue.length > 0 && entries.length < this.maxUrlsPerProject) {
      const item = queue.shift()!;
      const normalizedUrl = this.normalizeUrl(item.url);

      if (visited.has(normalizedUrl)) continue;
      if (item.depth > this.maxCrawlDepth) continue;

      visited.add(normalizedUrl);

      // Validate that this URL's domain is allowed
      if (!this.isDomainAllowed(normalizedUrl)) continue;

      // Check robots.txt before adding
      const robotsAllowed = await this.isAllowedByRobots(normalizedUrl);
      if (!robotsAllowed) continue;

      entries.push({
        uri: normalizedUrl,
        name: this.extractPageName(normalizedUrl),
        mimeType: 'text/html',
        metadata: { depth: item.depth },
      });

      // If we haven't reached max depth, crawl for more links
      if (item.depth < this.maxCrawlDepth && entries.length < this.maxUrlsPerProject) {
        try {
          await this.enforceRateLimit(normalizedUrl);
          const links = await this.discoverLinks(normalizedUrl);
          for (const link of links) {
            if (!visited.has(link) && entries.length + queue.length < this.maxUrlsPerProject) {
              queue.push({ url: link, depth: item.depth + 1 });
            }
          }
        } catch {
          // Failed to discover links from this page, continue with others
        }
      }
    }

    this.discoveredEntries = entries;
    return entries;
  }

  // ─── Lifecycle: fetch() ───────────────────────────────────────

  /**
   * Download pages with rate limiting, robots.txt compliance, and size enforcement.
   * Yields RawDocument for each successfully fetched page.
   */
  async *fetch(entries: SourceEntry[]): AsyncIterable<RawDocument> {
    this.assertConnected();

    for (const entry of entries) {
      // Check aggregate storage limit
      if (this.totalFetchedBytes >= this.maxAggregateBytes) {
        break;
      }

      // Check robots.txt before each fetch
      const allowed = await this.isAllowedByRobots(entry.uri);
      if (!allowed) continue;

      // Enforce rate limit (1 req/s/domain)
      await this.enforceRateLimit(entry.uri);

      try {
        const document = await this.fetchPage(entry.uri);
        if (document) {
          this.totalFetchedBytes += document.byteSize;
          yield document;
        }
      } catch {
        // Skip pages that fail to fetch, continue with remaining
        continue;
      }
    }
  }

  // ─── Lifecycle: disconnect() ──────────────────────────────────

  /**
   * Release resources and reset connector state.
   */
  async disconnect(): Promise<void> {
    this.config = null;
    this.securityProfile = null;
    this.rootUrl = null;
    this.connected = false;
    this.discoveredEntries = [];
    this.totalFetchedBytes = 0;
    this.robotsCache.clear();
    this.rateLimitState.clear();
  }

  // ─── Robots.txt Handling ──────────────────────────────────────

  /**
   * Check if a URL is allowed by the robots.txt rules for its domain.
   * Caches robots.txt per domain to avoid repeated fetches.
   */
  async isAllowedByRobots(url: string): Promise<boolean> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return false;
    }

    const domain = parsedUrl.hostname;
    let rules = this.robotsCache.get(domain);

    if (!rules) {
      rules = await this.fetchRobotsTxt(parsedUrl);
      this.robotsCache.set(domain, rules);
    }

    const path = parsedUrl.pathname;

    // Check allow rules first (more specific)
    for (const allowedPath of rules.allowedPaths) {
      if (path.startsWith(allowedPath)) {
        return true;
      }
    }

    // Check disallow rules
    for (const disallowedPath of rules.disallowedPaths) {
      if (disallowedPath === '' || disallowedPath === '/') {
        // Disallow all only if it's exactly '/' with no allow overrides
        if (disallowedPath === '/' && rules.allowedPaths.length === 0) {
          return false;
        }
        continue;
      }
      if (path.startsWith(disallowedPath)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Fetch and parse robots.txt for a given URL's domain.
   * Returns permissive rules if robots.txt is unavailable.
   */
  private async fetchRobotsTxt(parsedUrl: URL): Promise<RobotsTxtRules> {
    const robotsUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}/robots.txt`;
    const defaultRules: RobotsTxtRules = {
      disallowedPaths: [],
      allowedPaths: [],
      fetchedAt: Date.now(),
    };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const response = await this.fetchImpl(robotsUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'NeuroNest-KB-Crawler/1.0' },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        // If robots.txt doesn't exist (404) or is inaccessible, assume all allowed
        return defaultRules;
      }

      const text = await response.text();
      return this.parseRobotsTxt(text);
    } catch {
      // If we can't fetch robots.txt, assume all allowed
      return defaultRules;
    }
  }

  /**
   * Parse robots.txt content into structured rules.
   * Looks for User-agent: * directives (or any user-agent that applies).
   */
  private parseRobotsTxt(content: string): RobotsTxtRules {
    const rules: RobotsTxtRules = {
      disallowedPaths: [],
      allowedPaths: [],
      fetchedAt: Date.now(),
    };

    const lines = content.split('\n');
    let inRelevantBlock = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();

      // Skip comments and empty lines
      if (line.startsWith('#') || line === '') continue;

      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const directive = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();

      if (directive === 'user-agent') {
        // We respect rules for all user-agents (*) or our specific crawler
        inRelevantBlock =
          value === '*' || value.toLowerCase().includes('neuronest');
      } else if (inRelevantBlock) {
        if (directive === 'disallow' && value) {
          rules.disallowedPaths.push(value);
        } else if (directive === 'allow' && value) {
          rules.allowedPaths.push(value);
        } else if (directive === 'crawl-delay') {
          const delay = parseFloat(value);
          if (!isNaN(delay) && delay > 0) {
            rules.crawlDelay = delay;
          }
        }
      }
    }

    return rules;
  }

  // ─── Rate Limiting ────────────────────────────────────────────

  /**
   * Enforce crawl rate limit of 1 request per second per domain.
   * Also respects crawl-delay from robots.txt if it's longer.
   */
  private async enforceRateLimit(url: string): Promise<void> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return;
    }

    const domain = parsedUrl.hostname;
    const now = Date.now();
    const state = this.rateLimitState.get(domain);

    // Determine the effective rate limit interval
    const robotsRules = this.robotsCache.get(domain);
    const crawlDelayMs = robotsRules?.crawlDelay
      ? robotsRules.crawlDelay * 1000
      : RATE_LIMIT_INTERVAL_MS;
    const effectiveInterval = Math.max(RATE_LIMIT_INTERVAL_MS, crawlDelayMs);

    if (state) {
      const elapsed = now - state.lastRequestTime;
      if (elapsed < effectiveInterval) {
        const waitTime = effectiveInterval - elapsed;
        await this.sleep(waitTime);
      }
    }

    this.rateLimitState.set(domain, { lastRequestTime: Date.now() });
  }

  // ─── Page Fetching ────────────────────────────────────────────

  /**
   * Fetch a single page, enforcing per-document size limits.
   * Returns null if the page exceeds size limits (truncated content returned with warning).
   */
  private async fetchPage(url: string): Promise<RawDocument | null> {
    const maxSize = this.securityProfile?.maxFetchSizeBytes ?? DEFAULT_MAX_FETCH_SIZE_BYTES;
    const timeout = this.securityProfile?.executionTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'NeuroNest-KB-Crawler/1.0',
          Accept: 'text/html, application/xhtml+xml, text/plain, */*',
        },
        redirect: 'follow',
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return null;
      }

      // Read response body with size limit enforcement
      const contentType = response.headers.get('content-type') || 'text/html';
      const mimeType = contentType.split(';')[0]!.trim();

      const bodyBuffer = await this.readResponseWithLimit(response, maxSize);

      const contentHash = createHash('sha256').update(bodyBuffer).digest('hex');

      return {
        content: Buffer.from(bodyBuffer),
        mimeType,
        sourceUri: url,
        fetchTimestamp: Date.now(),
        contentHash,
        byteSize: bodyBuffer.byteLength,
      };
    } catch {
      clearTimeout(timeoutId);
      return null;
    }
  }

  /**
   * Read a response body up to the specified byte limit.
   * Truncates at the limit if the content is larger.
   */
  private async readResponseWithLimit(
    response: Response,
    maxBytes: number,
  ): Promise<Uint8Array> {
    if (!response.body) {
      const arrayBuf = await response.arrayBuffer();
      const full = new Uint8Array(arrayBuf);
      return full.byteLength > maxBytes ? full.slice(0, maxBytes) : full;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalSize = 0;

    try {
      while (totalSize < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;

        if (totalSize + value.byteLength > maxBytes) {
          // Truncate this chunk to fit within the limit
          const remaining = maxBytes - totalSize;
          chunks.push(value.slice(0, remaining));
          totalSize += remaining;
          break;
        }

        chunks.push(value);
        totalSize += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }

    // Combine chunks into a single Uint8Array
    const result = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return result;
  }

  // ─── Link Discovery ───────────────────────────────────────────

  /**
   * Discover links from a page by fetching it and extracting href attributes.
   * Only returns links within the same domain.
   */
  private async discoverLinks(url: string): Promise<string[]> {
    const maxSize = this.securityProfile?.maxFetchSizeBytes ?? DEFAULT_MAX_FETCH_SIZE_BYTES;
    const timeout = this.securityProfile?.executionTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'NeuroNest-KB-Crawler/1.0',
          Accept: 'text/html, application/xhtml+xml',
        },
        redirect: 'follow',
      });

      clearTimeout(timeoutId);

      if (!response.ok) return [];

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        return [];
      }

      const body = await this.readResponseWithLimit(response, maxSize);
      const html = new TextDecoder().decode(body);

      return this.extractLinks(html, url);
    } catch {
      clearTimeout(timeoutId);
      return [];
    }
  }

  /**
   * Extract links from HTML content. Uses a simple regex-based approach
   * to avoid heavy DOM parsing dependencies.
   * Only returns same-domain links.
   */
  private extractLinks(html: string, baseUrl: string): string[] {
    const links: string[] = [];
    const baseUrlObj = new URL(baseUrl);
    const rootDomain = this.rootUrl!.hostname;

    // Match href attributes in anchor tags
    const hrefRegex = /<a[^>]+href\s*=\s*["']([^"']+)["']/gi;
    let match: RegExpExecArray | null;

    while ((match = hrefRegex.exec(html)) !== null) {
      const href = match[1];
      if (!href) continue;

      // Skip fragment-only, javascript:, mailto:, tel: links
      if (
        href.startsWith('#') ||
        href.startsWith('javascript:') ||
        href.startsWith('mailto:') ||
        href.startsWith('tel:')
      ) {
        continue;
      }

      try {
        const resolvedUrl = new URL(href, baseUrl);

        // Only follow same-domain links
        if (resolvedUrl.hostname !== rootDomain) continue;

        // Only follow http/https
        if (!['http:', 'https:'].includes(resolvedUrl.protocol)) continue;

        // Remove fragment
        resolvedUrl.hash = '';

        const normalized = this.normalizeUrl(resolvedUrl.href);
        links.push(normalized);
      } catch {
        // Invalid URL, skip
      }
    }

    // Deduplicate
    return [...new Set(links)];
  }

  // ─── Domain Validation ────────────────────────────────────────

  /**
   * Check if a URL's domain is allowed by the security profile.
   */
  private isDomainAllowed(url: string): boolean {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return false;
    }

    const domain = parsedUrl.hostname;

    // Must be same domain as root URL or explicitly allowed
    if (domain === this.rootUrl!.hostname) {
      return true;
    }

    // Check against security profile allowedDomains
    if (this.securityProfile?.allowedDomains && this.securityProfile.allowedDomains.length > 0) {
      return this.securityProfile.allowedDomains.some(
        (pattern) => domainMatchesPattern(domain, pattern),
      );
    }

    // If no explicit allowedDomains, only allow root domain
    return false;
  }

  // ─── Utility Methods ──────────────────────────────────────────

  /**
   * Normalize a URL by removing trailing slashes, fragments, and lowercasing the host.
   */
  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      // Remove trailing slash from path (except for root path)
      if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
        parsed.pathname = parsed.pathname.slice(0, -1);
      }
      return parsed.href;
    } catch {
      return url;
    }
  }

  /**
   * Extract a human-readable page name from a URL.
   */
  private extractPageName(url: string): string {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname;

      if (path === '/' || path === '') {
        return parsed.hostname;
      }

      // Use the last path segment as the name
      const segments = path.split('/').filter(Boolean);
      const lastSegment = segments[segments.length - 1] || parsed.hostname;

      // Remove common extensions for cleaner display
      return decodeURIComponent(lastSegment.replace(/\.(html?|php|aspx?)$/i, ''));
    } catch {
      return url;
    }
  }

  /**
   * Assert that the connector is in a connected state.
   */
  private assertConnected(): void {
    if (!this.connected || !this.config || !this.rootUrl) {
      throw new Error('UrlWebsiteConnector: not connected. Call connect() first.');
    }
  }

  /**
   * Sleep for the specified number of milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─── Public Getters (for testing/monitoring) ──────────────────

  /** Get the total bytes fetched so far */
  get fetchedBytes(): number {
    return this.totalFetchedBytes;
  }

  /** Get the number of discovered entries */
  get discoveredCount(): number {
    return this.discoveredEntries.length;
  }

  /** Check if connected */
  get isConnected(): boolean {
    return this.connected;
  }
}
