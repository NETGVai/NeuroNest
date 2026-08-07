// ─── Shazam Adapter ─────────────────────────────────────────────
// Full ChannelAdapter implementation for Shazam music recognition.
// Processes audio input for song identification using the Shazam API
// (via RapidAPI) and returns identified track information. Supports
// bidirectional communication: accepts audio data/file references as
// inbound and returns track info as outbound responses.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.4, REQ 9.5

import { z } from 'zod';
import { BaseChannelAdapter } from './base-adapter';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';

// ─── Config Schema (REQ 1.6) ────────────────────────────────────

/**
 * Zod schema for Shazam adapter configuration.
 * Requires a RapidAPI key for accessing the Shazam API, and an
 * optional RapidAPI host override.
 */
export const ShazamConfigSchema = z.object({
  /** RapidAPI key for Shazam API access */
  rapidApiKey: z.string().min(1),
  /** RapidAPI host override (default: shazam.p.rapidapi.com) */
  rapidApiHost: z.string().optional().default('shazam.p.rapidapi.com'),
});

export type ShazamConfig = z.infer<typeof ShazamConfigSchema>;

// ─── Types ──────────────────────────────────────────────────────

/** Supported Shazam command actions */
type ShazamAction = 'identify' | 'search';

/** Parsed inbound command structure */
interface ShazamCommand {
  action: ShazamAction;
  /** Base64-encoded audio data for identification */
  audioData?: string;
  /** File path reference to audio for identification */
  audioFilePath?: string;
  /** Search query for track/artist lookup */
  query?: string;
}

/** Track identification result from Shazam API */
interface ShazamTrackResult {
  title: string;
  artist: string;
  album?: string | undefined;
  genre?: string | undefined;
  releaseYear?: string | undefined;
  coverArt?: string | undefined;
  shazamUrl?: string | undefined;
  appleMusicUrl?: string | undefined;
  spotifyUrl?: string | undefined;
  lyrics?: string[] | undefined;
  isrc?: string | undefined;
}

/** Search result from Shazam API */
interface ShazamSearchResult {
  tracks: Array<{
    title: string;
    artist: string;
    album?: string | undefined;
    coverArt?: string | undefined;
    shazamUrl?: string | undefined;
  }>;
}

// ─── Shazam Adapter ─────────────────────────────────────────────

export class ShazamAdapter extends BaseChannelAdapter {
  readonly channelId = 'shazam';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: true,
    deliveryMode: 'push',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Shazam',
    emoji: '🎤',
    description: 'Music recognition',
    actionTags: ['identify song', 'get lyrics', 'search tracks'],
    sortOrder: 1046,
  };

  readonly configSchema = ShazamConfigSchema;

  private config: ShazamConfig | null = null;

  /** Base URL for the Shazam API via RapidAPI */
  private readonly apiBase = 'https://shazam.p.rapidapi.com';

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Shazam adapter requires a RapidAPI key for API access.\n\n' +
        'Setup steps:\n' +
        '1. Sign up at https://rapidapi.com\n' +
        '2. Subscribe to the Shazam API\n' +
        '3. Copy your RapidAPI key from the dashboard\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Verify API access by making a lightweight test request
    try {
      const testResult = await this.verifyApiAccess();
      if (!testResult.success) {
        return testResult;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to connect to Shazam API: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    this.connected = true;
    this.log('info', 'Connected', { channelId: 'shazam' });

    return {
      success: true,
      message: 'Shazam connected successfully',
    };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.config = null;
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config) {
      return { success: false, message: 'Shazam adapter is not connected' };
    }

    // Parse the outbound message content as a command
    const command = this.parseCommand(message.content);
    if (!command) {
      return {
        success: false,
        message: 'Could not parse Shazam command. Supported actions: identify (with audio data), search (with query).',
      };
    }

    // Execute the parsed command
    try {
      switch (command.action) {
        case 'identify':
          return this.identifySong(command);

        case 'search':
          return this.searchTracks(command.query ?? '');

        default:
          return { success: false, message: `Unknown Shazam action: ${command.action}` };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Send failed', { error: errMsg });
      return { success: false, message: `Shazam operation failed: ${errMsg}` };
    }
  }

  // ─── Private: API verification ──────────────────────────────────

  /**
   * Verify API access by attempting a lightweight search request.
   * This confirms the API key is valid and the subscription is active.
   */
  private async verifyApiAccess(): Promise<ConnectResult> {
    const response = await this.apiFetch('/search', {
      params: { term: 'test', locale: 'en-US', offset: '0', limit: '1' },
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return this.authFailed(
          'Invalid or expired RapidAPI key. Please verify your Shazam API subscription.',
        );
      }
      if (response.status === 429) {
        // Rate limited but API key works
        return { success: true, message: 'API key verified (rate limited, will retry)' };
      }
      const errorBody = await response.text();
      return {
        success: false,
        message: `Shazam API verification failed (${response.status}): ${errorBody}`,
        error: { code: 'PROVIDER_ERROR', message: errorBody },
      };
    }

    return { success: true, message: 'API access verified' };
  }

  // ─── Private: Song identification ───────────────────────────────

  /**
   * Identify a song from audio data using the Shazam recognition API.
   * Accepts base64-encoded audio data or a file path reference.
   * Returns identified track information per REQ 9.5.
   */
  private async identifySong(command: ShazamCommand): Promise<SendResult> {
    if (!command.audioData && !command.audioFilePath) {
      return {
        success: false,
        message: 'Song identification requires audio data (base64) or an audio file path.',
      };
    }

    let audioBase64 = command.audioData;

    // If a file path was provided, read it (in a real environment this
    // would use fs to read the file and convert to base64)
    if (!audioBase64 && command.audioFilePath) {
      try {
        const fs = await import('fs/promises');
        const buffer = await fs.readFile(command.audioFilePath);
        audioBase64 = buffer.toString('base64');
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          message: `Failed to read audio file: ${errMsg}`,
        };
      }
    }

    if (!audioBase64) {
      return { success: false, message: 'No audio data available for identification' };
    }

    // Call the Shazam detect/recognize endpoint
    const rawAudio = Buffer.from(audioBase64, 'base64');

    const response = await this.apiFetch('/songs/v2/detect', {
      method: 'POST',
      body: rawAudio,
      headers: {
        'Content-Type': 'text/plain',
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return {
        success: false,
        message: `Song identification failed (${response.status}): ${errorBody}`,
      };
    }

    const result = (await response.json()) as {
      track?: {
        title?: string;
        subtitle?: string;
        genres?: { primary?: string };
        sections?: Array<{
          type?: string;
          text?: string[];
          metadata?: Array<{ title?: string; text?: string }>;
        }>;
        images?: { coverart?: string };
        url?: string;
        hub?: {
          actions?: Array<{ type?: string; uri?: string }>;
          providers?: Array<{ type?: string; actions?: Array<{ uri?: string }> }>;
        };
        isrc?: string;
      };
      matches?: Array<{ id?: string }>;
    };

    if (!result.track) {
      return {
        success: true,
        message: JSON.stringify({
          identified: false,
          message: 'No song match found for the provided audio.',
        }),
      };
    }

    const track = result.track;

    // Extract metadata from sections
    const lyricsSection = track.sections?.find((s) => s.type === 'LYRICS');
    const metadataSection = track.sections?.find((s) => s.type === 'SONG');

    // Extract album and release year from metadata
    const albumMeta = metadataSection?.metadata?.find((m) => m.title === 'Album');
    const releaseMeta = metadataSection?.metadata?.find((m) => m.title === 'Released');

    // Extract streaming URLs
    const appleMusicAction = track.hub?.actions?.find((a) => a.type === 'applemusicplay');
    const spotifyProvider = track.hub?.providers?.find((p) => p.type === 'SPOTIFY');

    const trackResult: ShazamTrackResult = {
      title: track.title ?? 'Unknown',
      artist: track.subtitle ?? 'Unknown',
      album: albumMeta?.text,
      genre: track.genres?.primary,
      releaseYear: releaseMeta?.text,
      coverArt: track.images?.coverart,
      shazamUrl: track.url,
      appleMusicUrl: appleMusicAction?.uri,
      spotifyUrl: spotifyProvider?.actions?.[0]?.uri,
      lyrics: lyricsSection?.text,
      isrc: track.isrc,
    };

    // Emit inbound with the identification result so the AI pipeline
    // can process it and format a user-friendly response
    this.emitInbound('shazam-detect', JSON.stringify(trackResult), 'text');

    return {
      success: true,
      message: JSON.stringify({
        identified: true,
        track: trackResult,
      }, null, 2),
    };
  }

  // ─── Private: Track search ──────────────────────────────────────

  /**
   * Search for tracks by title or artist name.
   */
  private async searchTracks(query: string): Promise<SendResult> {
    if (!query.trim()) {
      return { success: false, message: 'Search requires a query string (track or artist name).' };
    }

    const response = await this.apiFetch('/search', {
      params: {
        term: query,
        locale: 'en-US',
        offset: '0',
        limit: '5',
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return {
        success: false,
        message: `Track search failed (${response.status}): ${errorBody}`,
      };
    }

    const result = (await response.json()) as {
      tracks?: {
        hits?: Array<{
          track?: {
            title?: string;
            subtitle?: string;
            images?: { coverart?: string };
            url?: string;
          };
        }>;
      };
    };

    const hits = result.tracks?.hits ?? [];
    const searchResult: ShazamSearchResult = {
      tracks: hits.map((hit) => ({
        title: hit.track?.title ?? 'Unknown',
        artist: hit.track?.subtitle ?? 'Unknown',
        coverArt: hit.track?.images?.coverart,
        shazamUrl: hit.track?.url,
      })),
    };

    return {
      success: true,
      message: JSON.stringify(searchResult, null, 2),
    };
  }

  // ─── Private: Command parsing ───────────────────────────────────

  /**
   * Parse message content into a structured Shazam command.
   * Supports JSON-format commands and natural language patterns:
   * - "identify" with audioData or audioFilePath
   * - "search <query>" / "find <query>"
   */
  private parseCommand(content: string): ShazamCommand | null {
    // Try JSON parsing first
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.action) {
        return parsed as ShazamCommand;
      }
    } catch {
      // Not JSON, try natural language patterns
    }

    const lower = content.toLowerCase().trim();

    // Pattern: "identify" — expects audioData to be provided via structured message
    if (/^identify$/i.test(lower)) {
      return { action: 'identify' };
    }

    // Pattern: "search <query>" or "find <query>"
    const searchMatch = content.match(/^(?:search|find)\s+(.+)$/i);
    if (searchMatch) {
      return {
        action: 'search',
        query: searchMatch[1]!.trim(),
      };
    }

    // Pattern: "what song is this" — expects audio in structured payload
    if (/^what\s+(?:song|track)\s+is\s+this/i.test(lower)) {
      return { action: 'identify' };
    }

    // If content looks like it might be a search query (no recognized command prefix)
    if (lower.length > 2 && !lower.startsWith('{')) {
      return {
        action: 'search',
        query: content.trim(),
      };
    }

    return null;
  }

  // ─── Private: API fetch helper ──────────────────────────────────

  /**
   * Make an authenticated request to the Shazam API via RapidAPI.
   * Attaches the required X-RapidAPI-Key and X-RapidAPI-Host headers.
   */
  private async apiFetch(
    path: string,
    options: {
      method?: string;
      params?: Record<string, string>;
      body?: Buffer | string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    if (!this.config) {
      throw new Error('Shazam adapter is not configured');
    }

    const host = this.config.rapidApiHost;
    const baseUrl = this.apiBase;

    // Build URL with query parameters
    const url = new URL(path, baseUrl);
    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        url.searchParams.set(key, value);
      }
    }

    const headers: Record<string, string> = {
      'X-RapidAPI-Key': this.config.rapidApiKey,
      'X-RapidAPI-Host': host,
      ...(options.headers ?? {}),
    };

    const fetchOptions: RequestInit = {
      method: options.method ?? 'GET',
      headers,
    };

    if (options.body !== undefined) {
      if (options.body instanceof Buffer) {
        fetchOptions.body = new Uint8Array(options.body.buffer, options.body.byteOffset, options.body.byteLength) as unknown as BodyInit;
      } else {
        fetchOptions.body = options.body as BodyInit;
      }
    }

    return fetch(url.toString(), fetchOptions);
  }
}
