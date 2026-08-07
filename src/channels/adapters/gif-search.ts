// ─── GIF Search Adapter ─────────────────────────────────────────
// Full ChannelAdapter implementation for GIF discovery via the Giphy
// API. Supports searching GIFs, fetching trending GIFs, and returning
// random GIFs. This is a SEND-ONLY adapter — no inbound messages.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 4.6, REQ 10.14

import { z } from 'zod';
import { BaseChannelAdapter } from './base-adapter';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';

// ─── Config Schema (REQ 1.6) ────────────────────────────────────

/**
 * Zod schema for GIF Search adapter configuration.
 * Requires a Giphy API key. Optionally specify content rating.
 */
export const GifSearchConfigSchema = z.object({
  /** Giphy API key (obtain from https://developers.giphy.com/) */
  apiKey: z.string().min(1),
  /** Content rating filter: g, pg, pg-13, r */
  rating: z.enum(['g', 'pg', 'pg-13', 'r']).optional().default('g'),
  /** Maximum number of results to return for search/trending */
  limit: z.number().int().min(1).max(50).optional().default(10),
});

export type GifSearchConfig = z.infer<typeof GifSearchConfigSchema>;

// ─── Types ──────────────────────────────────────────────────────

/** Supported GIF command actions */
type GifAction = 'search' | 'trending' | 'random';

/** Parsed inbound command structure */
interface GifCommand {
  action: GifAction;
  /** Search query (required for search action) */
  query?: string;
  /** Number of results to return */
  limit?: number;
}

/** Individual GIF result */
interface GifResult {
  id: string;
  title: string;
  url: string;
  originalUrl: string;
  previewUrl: string;
  width: number;
  height: number;
}

/** Search/trending response shape */
interface GifSearchResult {
  action: GifAction;
  query?: string;
  results: GifResult[];
  totalCount: number;
}

// ─── GIF Search Adapter ─────────────────────────────────────────

export class GifSearchAdapter extends BaseChannelAdapter {
  readonly channelId = 'gif-search';

  readonly capabilities: AdapterCapabilities = {
    direction: 'send-only',
    supportsTyping: false,
    supportsRichMedia: true,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'GIF Search',
    emoji: '🎞️',
    description: 'GIF discovery',
    actionTags: ['search GIFs', 'trending', 'random'],
    sortOrder: 1060,
  };

  readonly configSchema = GifSearchConfigSchema;

  private config: GifSearchConfig | null = null;

  /** Base URL for the Giphy API */
  private readonly apiBase = 'https://api.giphy.com';

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'GIF Search adapter requires a Giphy API key.\n\n' +
        'Setup steps:\n' +
        '1. Sign up at https://developers.giphy.com/\n' +
        '2. Create an app and copy the API key\n' +
        '3. Provide the key in the adapter configuration\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Verify API access with a lightweight test request
    try {
      const testResult = await this.verifyApiAccess();
      if (!testResult.success) {
        return testResult;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to connect to Giphy API: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    this.connected = true;
    this.log('info', 'Connected', { channelId: 'gif-search', rating: this.config.rating });

    return {
      success: true,
      message: `GIF Search adapter connected (rating: ${this.config.rating})`,
    };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.config = null;
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config) {
      return { success: false, message: 'GIF Search adapter is not connected' };
    }

    // Parse the outbound message content as a command
    const command = this.parseCommand(message.content);
    if (!command) {
      return {
        success: false,
        message:
          'Could not parse GIF command. Supported: "search <query>", "trending", "random".',
      };
    }

    // Execute the parsed command
    try {
      switch (command.action) {
        case 'search':
          return this.searchGifs(command.query ?? '', command.limit);

        case 'trending':
          return this.getTrending(command.limit);

        case 'random':
          return this.getRandom(command.query);

        default:
          return { success: false, message: `Unknown GIF action: ${command.action}` };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Send failed', { error: errMsg });
      return { success: false, message: `GIF operation failed: ${errMsg}` };
    }
  }

  // ─── Private: API verification ──────────────────────────────────

  /**
   * Verify API access by making a lightweight trending request.
   * Confirms the API key is valid.
   */
  private async verifyApiAccess(): Promise<ConnectResult> {
    const response = await this.apiFetch('/v1/gifs/trending', {
      limit: '1',
      rating: this.config!.rating,
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return this.authFailed(
          'Invalid Giphy API key. Please verify your key at https://developers.giphy.com/dashboard/',
        );
      }
      const errorBody = await response.text();
      return {
        success: false,
        message: `Giphy API verification failed (${response.status}): ${errorBody}`,
        error: { code: 'PROVIDER_ERROR', message: errorBody },
      };
    }

    return { success: true, message: 'API access verified' };
  }

  // ─── Private: Search GIFs ─────────────────────────────────────

  /**
   * Search for GIFs matching a query string.
   * @satisfies REQ 10.14
   */
  private async searchGifs(query: string, limit?: number): Promise<SendResult> {
    if (!query.trim()) {
      return { success: false, message: 'Search query cannot be empty.' };
    }

    const effectiveLimit = limit ?? this.config!.limit;

    const response = await this.apiFetch('/v1/gifs/search', {
      q: query,
      limit: String(effectiveLimit),
      rating: this.config!.rating,
      lang: 'en',
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return {
        success: false,
        message: `GIF search failed (${response.status}): ${errorBody}`,
      };
    }

    const data = (await response.json()) as {
      data?: Array<GiphyGifObject>;
      pagination?: { total_count?: number };
    };

    const results = (data.data ?? []).map(this.mapGifObject);

    const result: GifSearchResult = {
      action: 'search',
      query,
      results,
      totalCount: data.pagination?.total_count ?? results.length,
    };

    return {
      success: true,
      message: JSON.stringify(result, null, 2),
    };
  }

  // ─── Private: Trending GIFs ───────────────────────────────────

  /**
   * Fetch currently trending GIFs.
   * @satisfies REQ 10.14
   */
  private async getTrending(limit?: number): Promise<SendResult> {
    const effectiveLimit = limit ?? this.config!.limit;

    const response = await this.apiFetch('/v1/gifs/trending', {
      limit: String(effectiveLimit),
      rating: this.config!.rating,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return {
        success: false,
        message: `GIF trending fetch failed (${response.status}): ${errorBody}`,
      };
    }

    const data = (await response.json()) as {
      data?: Array<GiphyGifObject>;
      pagination?: { total_count?: number };
    };

    const results = (data.data ?? []).map(this.mapGifObject);

    const result: GifSearchResult = {
      action: 'trending',
      results,
      totalCount: data.pagination?.total_count ?? results.length,
    };

    return {
      success: true,
      message: JSON.stringify(result, null, 2),
    };
  }

  // ─── Private: Random GIF ──────────────────────────────────────

  /**
   * Fetch a single random GIF, optionally filtered by tag.
   * @satisfies REQ 10.14
   */
  private async getRandom(tag?: string): Promise<SendResult> {
    const params: Record<string, string> = {
      rating: this.config!.rating,
    };
    if (tag?.trim()) {
      params.tag = tag.trim();
    }

    const response = await this.apiFetch('/v1/gifs/random', params);

    if (!response.ok) {
      const errorBody = await response.text();
      return {
        success: false,
        message: `GIF random fetch failed (${response.status}): ${errorBody}`,
      };
    }

    const data = (await response.json()) as { data?: GiphyGifObject };

    if (!data.data) {
      return { success: false, message: 'No random GIF found.' };
    }

    const gif = this.mapGifObject(data.data);

    const result: GifSearchResult = {
      action: 'random',
      query: tag,
      results: [gif],
      totalCount: 1,
    };

    return {
      success: true,
      message: JSON.stringify(result, null, 2),
    };
  }

  // ─── Private: Command parsing ───────────────────────────────────

  /**
   * Parse message content into a structured GIF command.
   * Supports JSON-format commands and natural language patterns:
   * - "search <query>"
   * - "trending"
   * - "random" / "random <tag>"
   */
  parseCommand(content: string): GifCommand | null {
    // Try JSON parsing first
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.action) {
        return parsed as GifCommand;
      }
    } catch {
      // Not JSON, try natural language patterns
    }

    const trimmed = content.trim();
    const lower = trimmed.toLowerCase();

    // Pattern: "search <query>"
    const searchMatch = trimmed.match(/^search\s+(.+)$/i);
    if (searchMatch) {
      return { action: 'search', query: searchMatch[1]!.trim() };
    }

    // Pattern: "trending" (with optional limit)
    const trendingMatch = trimmed.match(/^trending(?:\s+(\d+))?$/i);
    if (trendingMatch) {
      return {
        action: 'trending',
        limit: trendingMatch[1] ? parseInt(trendingMatch[1], 10) : undefined,
      };
    }

    // Pattern: "random" or "random <tag>"
    const randomMatch = trimmed.match(/^random(?:\s+(.+))?$/i);
    if (randomMatch) {
      return { action: 'random', query: randomMatch[1]?.trim() };
    }

    // Pattern: "gif <query>" or "find gif <query>"
    const gifMatch = trimmed.match(/^(?:find\s+)?gif(?:s)?\s+(.+)$/i);
    if (gifMatch) {
      return { action: 'search', query: gifMatch[1]!.trim() };
    }

    // If the content doesn't match any known pattern but is non-empty,
    // treat it as a search query
    if (trimmed.length > 0 && !lower.startsWith('{')) {
      return { action: 'search', query: trimmed };
    }

    return null;
  }

  // ─── Private: Helpers ─────────────────────────────────────────

  /**
   * Map a Giphy API GIF object to our normalized GifResult shape.
   */
  private mapGifObject = (gif: GiphyGifObject): GifResult => {
    return {
      id: gif.id ?? '',
      title: gif.title ?? '',
      url: gif.url ?? '',
      originalUrl: gif.images?.original?.url ?? '',
      previewUrl: gif.images?.preview_gif?.url ?? gif.images?.fixed_height_small?.url ?? '',
      width: parseInt(gif.images?.original?.width ?? '0', 10),
      height: parseInt(gif.images?.original?.height ?? '0', 10),
    };
  };

  // ─── Private: API fetch helper ──────────────────────────────────

  /**
   * Make an authenticated request to the Giphy API.
   * Automatically attaches the api_key query parameter.
   */
  private async apiFetch(
    path: string,
    params: Record<string, string> = {},
  ): Promise<Response> {
    if (!this.config) {
      throw new Error('GIF Search adapter is not configured');
    }

    const url = new URL(path, this.apiBase);
    url.searchParams.set('api_key', this.config.apiKey);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    return fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  }
}

// ─── Giphy API types (internal) ─────────────────────────────────

/** Simplified Giphy GIF object shape from the API response */
interface GiphyGifObject {
  id?: string;
  title?: string;
  url?: string;
  images?: {
    original?: { url?: string; width?: string; height?: string };
    preview_gif?: { url?: string };
    fixed_height_small?: { url?: string };
  };
}
