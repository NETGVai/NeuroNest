// ─── Spotify Adapter ────────────────────────────────────────────
// Full ChannelAdapter implementation for Spotify music streaming.
// Communicates with the Spotify Web API using OAuth 2.0 (client
// credentials + refresh token) for playback control, search, and
// queue management. Responses are formatted as playback status
// objects per Media channel requirements.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.4, REQ 9.1, REQ 9.2

import { z } from 'zod';
import { BaseChannelAdapter } from './base-adapter';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';

// ─── Config Schema (REQ 1.6) ────────────────────────────────────

/**
 * Zod schema for Spotify adapter configuration.
 * Uses OAuth 2.0 with client credentials and a refresh token for
 * persistent access without re-authentication.
 */
export const SpotifyConfigSchema = z.object({
  /** Spotify application client ID */
  clientId: z.string().min(1),
  /** Spotify application client secret */
  clientSecret: z.string().min(1),
  /** OAuth 2.0 refresh token for persistent access */
  refreshToken: z.string().min(1),
  /** Polling interval in ms for playback status updates (default: 30000ms = 30s) */
  pollingIntervalMs: z.number().int().min(5000).default(30000),
});

export type SpotifyConfig = z.infer<typeof SpotifyConfigSchema>;

// ─── Types ──────────────────────────────────────────────────────

/** Supported Spotify command actions */
type SpotifyAction = 'play' | 'pause' | 'skip' | 'previous' | 'search' | 'get-queue' | 'get-status' | 'set-volume' | 'seek';

/** Parsed inbound command structure */
interface SpotifyCommand {
  action: SpotifyAction;
  query?: string;
  volumePercent?: number;
  positionMs?: number;
  uri?: string;
  contextUri?: string;
}

/** Playback status response object */
interface SpotifyPlaybackStatus {
  isPlaying: boolean;
  track: {
    name: string;
    artist: string;
    album: string;
    durationMs: number;
    progressMs: number;
    uri: string;
    albumArt?: string | undefined;
  } | undefined;
  device: {
    name: string;
    type: string;
    volumePercent: number;
  } | undefined;
  shuffleState: boolean;
  repeatState: string;
}

/** Search result entry */
interface SpotifySearchResult {
  tracks: Array<{
    name: string;
    artist: string;
    album: string;
    uri: string;
    durationMs: number;
  }>;
}

/** Queue response */
interface SpotifyQueueResponse {
  currentlyPlaying: {
    name: string;
    artist: string;
    uri: string;
  } | undefined;
  queue: Array<{
    name: string;
    artist: string;
    uri: string;
  }>;
}

// ─── Spotify Adapter ────────────────────────────────────────────

export class SpotifyAdapter extends BaseChannelAdapter {
  readonly channelId = 'spotify';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Spotify',
    emoji: '🎵',
    description: 'Music playback control and search',
    actionTags: ['play', 'pause', 'skip', 'search', 'queue'],
    sortOrder: 1040,
  };

  readonly configSchema = SpotifyConfigSchema;

  private config: SpotifyConfig | null = null;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastPlaybackStatus: SpotifyPlaybackStatus | null = null;

  /** Base URL for the Spotify Web API */
  private readonly API_BASE = 'https://api.spotify.com/v1';
  /** Token endpoint for OAuth */
  private readonly TOKEN_URL = 'https://accounts.spotify.com/api/token';

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Spotify adapter requires client ID, client secret, and refresh token.\n\n' +
        'Setup steps:\n' +
        '1. Create an app at https://developer.spotify.com/dashboard\n' +
        '2. Get your client ID and client secret\n' +
        '3. Generate a refresh token with appropriate scopes\n' +
        '   (user-read-playback-state, user-modify-playback-state, user-read-currently-playing)\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Obtain an access token using the refresh token
    try {
      const tokenResult = await this.refreshAccessToken();
      if (!tokenResult.success) {
        return tokenResult;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to authenticate with Spotify: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    // Verify connection by fetching current playback state
    try {
      await this.fetchPlaybackStatus();
    } catch (err: unknown) {
      // Non-fatal: player might simply not be active
      this.log('info', 'No active playback detected (this is normal if nothing is playing)');
    }

    // Start polling for playback changes
    this.startPolling();

    this.connected = true;
    this.log('info', 'Connected', { channelId: 'spotify' });

    return {
      success: true,
      message: 'Spotify connected successfully',
    };
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    this.connected = false;
    this.config = null;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.lastPlaybackStatus = null;
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config) {
      return { success: false, message: 'Spotify adapter is not connected' };
    }

    // Ensure token is fresh
    await this.ensureValidToken();

    // Parse the outbound message content as a command
    const command = this.parseCommand(message.content);
    if (!command) {
      // Default to get-status if we can't parse the command
      return this.getPlaybackStatus();
    }

    // Execute the parsed command
    try {
      switch (command.action) {
        case 'play':
          return this.play(command.uri, command.contextUri);

        case 'pause':
          return this.pause();

        case 'skip':
          return this.skip();

        case 'previous':
          return this.previous();

        case 'search':
          return this.search(command.query ?? '');

        case 'get-queue':
          return this.getQueue();

        case 'get-status':
          return this.getPlaybackStatus();

        case 'set-volume':
          return this.setVolume(command.volumePercent ?? 50);

        case 'seek':
          return this.seek(command.positionMs ?? 0);

        default:
          return { success: false, message: `Unknown Spotify action: ${command.action}` };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Send failed', { error: errMsg });
      return { success: false, message: `Spotify operation failed: ${errMsg}` };
    }
  }

  // ─── Private: OAuth Token Management ────────────────────────────

  /**
   * Refresh the access token using the stored refresh token.
   * Spotify OAuth tokens expire after ~1 hour.
   */
  private async refreshAccessToken(): Promise<ConnectResult> {
    if (!this.config) {
      return { success: false, message: 'Not configured', error: { code: 'CONFIG_INVALID', message: 'Not configured' } };
    }

    const credentials = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
    ).toString('base64');

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.config.refreshToken,
    });

    const response = await fetch(this.TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      if (response.status === 400 || response.status === 401) {
        return this.authFailed(
          'Invalid client credentials or refresh token. ' +
          'Please verify your Spotify app credentials and generate a new refresh token.',
        );
      }
      const errorBody = await response.text();
      return {
        success: false,
        message: `Spotify token refresh failed (${response.status}): ${errorBody}`,
        error: { code: 'PROVIDER_ERROR', message: errorBody },
      };
    }

    const result = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      token_type?: string;
    };

    if (!result.access_token) {
      return this.authFailed('No access token returned from Spotify.');
    }

    this.accessToken = result.access_token;
    // Set expiry with a 60-second buffer to avoid edge-case expirations
    this.tokenExpiresAt = Date.now() + ((result.expires_in ?? 3600) - 60) * 1000;

    return { success: true, message: 'Token refreshed' };
  }

  /**
   * Ensure we have a valid access token, refreshing if needed.
   */
  private async ensureValidToken(): Promise<void> {
    if (Date.now() >= this.tokenExpiresAt) {
      const result = await this.refreshAccessToken();
      if (!result.success) {
        throw new Error(`Token refresh failed: ${result.message}`);
      }
    }
  }

  // ─── Private: Playback Commands ─────────────────────────────────

  /**
   * Start or resume playback.
   * Optionally play a specific track URI or context (album/playlist).
   */
  private async play(uri?: string, contextUri?: string): Promise<SendResult> {
    const body: Record<string, unknown> = {};
    if (contextUri) {
      body['context_uri'] = contextUri;
    }
    if (uri) {
      body['uris'] = [uri];
    }

    const hasBody = Object.keys(body).length > 0;
    const response = await this.apiFetch('/me/player/play', {
      method: 'PUT',
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Play failed: ${errorBody}` };
    }

    // Fetch updated status after command
    await this.delay(300);
    return this.getPlaybackStatus();
  }

  /**
   * Pause playback on the active device.
   */
  private async pause(): Promise<SendResult> {
    const response = await this.apiFetch('/me/player/pause', {
      method: 'PUT',
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Pause failed: ${errorBody}` };
    }

    return {
      success: true,
      message: JSON.stringify({
        action: 'pause',
        status: 'paused',
      }),
    };
  }

  /**
   * Skip to the next track.
   */
  private async skip(): Promise<SendResult> {
    const response = await this.apiFetch('/me/player/next', {
      method: 'POST',
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Skip failed: ${errorBody}` };
    }

    // Fetch updated status after skip
    await this.delay(300);
    return this.getPlaybackStatus();
  }

  /**
   * Go back to the previous track.
   */
  private async previous(): Promise<SendResult> {
    const response = await this.apiFetch('/me/player/previous', {
      method: 'POST',
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Previous failed: ${errorBody}` };
    }

    await this.delay(300);
    return this.getPlaybackStatus();
  }

  /**
   * Search Spotify for tracks matching a query.
   */
  private async search(query: string): Promise<SendResult> {
    if (!query.trim()) {
      return { success: false, message: 'Search query cannot be empty' };
    }

    const params = new URLSearchParams({
      q: query,
      type: 'track',
      limit: '10',
    });

    const response = await this.apiFetch(`/search?${params.toString()}`);

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Search failed: ${errorBody}` };
    }

    const result = (await response.json()) as {
      tracks?: {
        items?: Array<{
          name?: string;
          artists?: Array<{ name?: string }>;
          album?: { name?: string };
          uri?: string;
          duration_ms?: number;
        }>;
      };
    };

    const tracks = (result.tracks?.items ?? []).map((item) => ({
      name: item.name ?? 'Unknown',
      artist: item.artists?.map((a) => a.name).join(', ') ?? 'Unknown',
      album: item.album?.name ?? 'Unknown',
      uri: item.uri ?? '',
      durationMs: item.duration_ms ?? 0,
    }));

    const searchResult: SpotifySearchResult = { tracks };

    return {
      success: true,
      message: JSON.stringify(searchResult, null, 2),
    };
  }

  /**
   * Get the user's current playback queue.
   */
  private async getQueue(): Promise<SendResult> {
    const response = await this.apiFetch('/me/player/queue');

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Get queue failed: ${errorBody}` };
    }

    const result = (await response.json()) as {
      currently_playing?: {
        name?: string;
        artists?: Array<{ name?: string }>;
        uri?: string;
      };
      queue?: Array<{
        name?: string;
        artists?: Array<{ name?: string }>;
        uri?: string;
      }>;
    };

    const queueResponse: SpotifyQueueResponse = {
      currentlyPlaying: result.currently_playing
        ? {
            name: result.currently_playing.name ?? 'Unknown',
            artist: result.currently_playing.artists?.map((a) => a.name).join(', ') ?? 'Unknown',
            uri: result.currently_playing.uri ?? '',
          }
        : undefined,
      queue: (result.queue ?? []).slice(0, 20).map((item) => ({
        name: item.name ?? 'Unknown',
        artist: item.artists?.map((a) => a.name).join(', ') ?? 'Unknown',
        uri: item.uri ?? '',
      })),
    };

    return {
      success: true,
      message: JSON.stringify(queueResponse, null, 2),
    };
  }

  /**
   * Get the current playback status.
   * Returns a formatted playback status object per REQ 4.4 / REQ 9.1.
   */
  private async getPlaybackStatus(): Promise<SendResult> {
    const status = await this.fetchPlaybackStatus();

    if (!status) {
      return {
        success: true,
        message: JSON.stringify({
          isPlaying: false,
          track: null,
          device: null,
          shuffleState: false,
          repeatState: 'off',
        }),
      };
    }

    return {
      success: true,
      message: JSON.stringify(status, null, 2),
    };
  }

  /**
   * Set playback volume.
   */
  private async setVolume(volumePercent: number): Promise<SendResult> {
    const clamped = Math.max(0, Math.min(100, Math.round(volumePercent)));

    const response = await this.apiFetch(
      `/me/player/volume?volume_percent=${clamped}`,
      { method: 'PUT' },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Set volume failed: ${errorBody}` };
    }

    return {
      success: true,
      message: JSON.stringify({
        action: 'set-volume',
        volumePercent: clamped,
        status: 'applied',
      }),
    };
  }

  /**
   * Seek to a position in the current track.
   */
  private async seek(positionMs: number): Promise<SendResult> {
    const clamped = Math.max(0, Math.round(positionMs));

    const response = await this.apiFetch(
      `/me/player/seek?position_ms=${clamped}`,
      { method: 'PUT' },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Seek failed: ${errorBody}` };
    }

    return {
      success: true,
      message: JSON.stringify({
        action: 'seek',
        positionMs: clamped,
        status: 'applied',
      }),
    };
  }

  // ─── Private: Status Fetching ───────────────────────────────────

  /**
   * Fetch the current playback status from the Spotify API.
   * Returns null if no active playback session exists.
   */
  private async fetchPlaybackStatus(): Promise<SpotifyPlaybackStatus | null> {
    const response = await this.apiFetch('/me/player/currently-playing');

    // 204 = no active playback
    if (response.status === 204) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Playback status fetch failed: ${response.status}`);
    }

    const result = (await response.json()) as {
      is_playing?: boolean;
      item?: {
        name?: string;
        artists?: Array<{ name?: string }>;
        album?: { name?: string; images?: Array<{ url?: string }> };
        duration_ms?: number;
        uri?: string;
      };
      device?: {
        name?: string;
        type?: string;
        volume_percent?: number;
      };
      progress_ms?: number;
      shuffle_state?: boolean;
      repeat_state?: string;
    };

    const status: SpotifyPlaybackStatus = {
      isPlaying: result.is_playing ?? false,
      track: result.item
        ? {
            name: result.item.name ?? 'Unknown',
            artist: result.item.artists?.map((a) => a.name).join(', ') ?? 'Unknown',
            album: result.item.album?.name ?? 'Unknown',
            durationMs: result.item.duration_ms ?? 0,
            progressMs: result.progress_ms ?? 0,
            uri: result.item.uri ?? '',
            albumArt: result.item.album?.images?.[0]?.url,
          }
        : undefined,
      device: result.device
        ? {
            name: result.device.name ?? 'Unknown',
            type: result.device.type ?? 'Unknown',
            volumePercent: result.device.volume_percent ?? 0,
          }
        : undefined,
      shuffleState: result.shuffle_state ?? false,
      repeatState: result.repeat_state ?? 'off',
    };

    this.lastPlaybackStatus = status;
    return status;
  }

  // ─── Private: Polling for playback changes ──────────────────────

  /**
   * Start polling for playback status changes.
   * Emits inbound messages when track changes or playback state toggles.
   */
  private startPolling(): void {
    if (!this.config) return;

    this.pollTimer = setInterval(() => {
      this.pollForChanges().catch((err) => {
        this.log('error', 'Polling failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.config.pollingIntervalMs);
  }

  /**
   * Stop the polling timer.
   */
  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Poll playback status and emit inbound messages on significant changes.
   */
  private async pollForChanges(): Promise<void> {
    await this.ensureValidToken();

    let currentStatus: SpotifyPlaybackStatus | null;
    try {
      currentStatus = await this.fetchPlaybackStatus();
    } catch {
      this.log('warn', 'Poll status fetch failed');
      return;
    }

    // Detect meaningful changes and emit inbound
    if (this.hasPlaybackChanged(this.lastPlaybackStatus, currentStatus)) {
      const changeContent = JSON.stringify({
        event: 'playback-changed',
        previous: this.lastPlaybackStatus
          ? {
              isPlaying: this.lastPlaybackStatus.isPlaying,
              track: this.lastPlaybackStatus.track?.name,
              artist: this.lastPlaybackStatus.track?.artist,
            }
          : null,
        current: currentStatus
          ? {
              isPlaying: currentStatus.isPlaying,
              track: currentStatus.track?.name,
              artist: currentStatus.track?.artist,
            }
          : null,
      });

      this.emitInbound('spotify-player', changeContent, 'text');
    }

    this.lastPlaybackStatus = currentStatus;
  }

  /**
   * Compare two playback statuses to detect meaningful changes.
   * A change is when the track URI changes or play/pause state toggles.
   */
  private hasPlaybackChanged(
    prev: SpotifyPlaybackStatus | null,
    curr: SpotifyPlaybackStatus | null,
  ): boolean {
    // Both null — no change
    if (!prev && !curr) return false;
    // One null, one not — change
    if (!prev || !curr) return true;
    // Different play state
    if (prev.isPlaying !== curr.isPlaying) return true;
    // Different track
    if (prev.track?.uri !== curr.track?.uri) return true;
    return false;
  }

  // ─── Private: Command parsing ───────────────────────────────────

  /**
   * Parse message content into a structured Spotify command.
   * Supports JSON-format commands and natural language patterns:
   * - "play" / "play <uri>" / "play <search query>"
   * - "pause" / "stop"
   * - "skip" / "next"
   * - "previous" / "prev" / "back"
   * - "search <query>"
   * - "queue" / "get queue"
   * - "status" / "now playing" / "what's playing"
   * - "volume <0-100>"
   * - "seek <ms>"
   */
  private parseCommand(content: string): SpotifyCommand | null {
    // Try JSON parsing first
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.action) {
        return parsed as SpotifyCommand;
      }
    } catch {
      // Not JSON, try natural language patterns
    }

    const lower = content.toLowerCase().trim();

    // Pattern: "pause" or "stop"
    if (/^(pause|stop)$/i.test(lower)) {
      return { action: 'pause' };
    }

    // Pattern: "skip" or "next"
    if (/^(skip|next)$/i.test(lower)) {
      return { action: 'skip' };
    }

    // Pattern: "previous" or "prev" or "back"
    if (/^(previous|prev|back)$/i.test(lower)) {
      return { action: 'previous' };
    }

    // Pattern: "queue" or "get queue"
    if (/^(get\s+)?queue$/i.test(lower)) {
      return { action: 'get-queue' };
    }

    // Pattern: "status" or "now playing" or "what's playing"
    if (/^(status|now\s+playing|what'?s?\s+playing|get\s+status|currently\s+playing)$/i.test(lower)) {
      return { action: 'get-status' };
    }

    // Pattern: "volume <number>"
    const volumeMatch = lower.match(/^(?:set\s+)?volume\s+(\d+)$/i);
    if (volumeMatch) {
      return { action: 'set-volume', volumePercent: parseInt(volumeMatch[1]!, 10) };
    }

    // Pattern: "seek <ms>" or "seek <m:ss>"
    const seekMatch = lower.match(/^seek\s+(\d+)(?::(\d{2}))?$/i);
    if (seekMatch) {
      let positionMs: number;
      if (seekMatch[2]) {
        // m:ss format → convert to ms
        positionMs = (parseInt(seekMatch[1]!, 10) * 60 + parseInt(seekMatch[2], 10)) * 1000;
      } else {
        positionMs = parseInt(seekMatch[1]!, 10);
      }
      return { action: 'seek', positionMs };
    }

    // Pattern: "search <query>"
    const searchMatch = content.match(/^search\s+(.+)$/i);
    if (searchMatch) {
      return { action: 'search', query: searchMatch[1]!.trim() };
    }

    // Pattern: "play <spotify:track:...>" (explicit URI)
    const playUriMatch = content.match(/^play\s+(spotify:\w+:\w+)$/i);
    if (playUriMatch) {
      return { action: 'play', uri: playUriMatch[1]! };
    }

    // Pattern: "play" (resume)
    if (/^play$/i.test(lower)) {
      return { action: 'play' };
    }

    // Pattern: "play <query>" (search and play first result)
    const playQueryMatch = content.match(/^play\s+(.+)$/i);
    if (playQueryMatch) {
      return { action: 'search', query: playQueryMatch[1]!.trim() };
    }

    return null;
  }

  // ─── Private: API fetch helper ──────────────────────────────────

  /**
   * Make an authenticated request to the Spotify Web API.
   * Uses Bearer token auth with the OAuth access token.
   */
  private async apiFetch(
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    if (!this.accessToken) {
      throw new Error('Spotify adapter is not authenticated');
    }

    const url = path.startsWith('http') ? path : `${this.API_BASE}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.accessToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers as Record<string, string> ?? {}),
    };

    return fetch(url, {
      ...options,
      headers,
    });
  }

  // ─── Private: Utilities ─────────────────────────────────────────

  /**
   * Simple delay utility for waiting between API calls.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
