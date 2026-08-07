// ─── Sonos Adapter ──────────────────────────────────────────────
// Full ChannelAdapter implementation for Sonos multi-room audio.
// Communicates with the Sonos Cloud API (or local UPnP/SOAP API)
// for playback control, volume management, and room grouping.
// Responses are formatted as playback status objects per Media
// channel requirements.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.4, REQ 9.3, REQ 9.4

import { z } from 'zod';
import { BaseChannelAdapter } from './base-adapter';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';

// ─── Config Schema (REQ 1.6) ────────────────────────────────────

/**
 * Zod schema for Sonos adapter configuration.
 * Supports the Sonos Cloud API with OAuth credentials and household ID.
 */
export const SonosConfigSchema = z.object({
  /** Sonos household ID identifying the target home */
  householdId: z.string().min(1),
  /** Sonos API key (OAuth access token) */
  apiKey: z.string().min(1),
  /** Optional refresh token for token rotation */
  refreshToken: z.string().optional(),
  /** Optional polling interval in ms for playback status (default: 5000ms) */
  pollingIntervalMs: z.number().int().min(2000).default(5000),
});

export type SonosConfig = z.infer<typeof SonosConfigSchema>;

// ─── Types ──────────────────────────────────────────────────────

/** Supported Sonos command actions */
type SonosAction =
  | 'play'
  | 'pause'
  | 'stop'
  | 'next'
  | 'previous'
  | 'set-volume'
  | 'get-volume'
  | 'mute'
  | 'unmute'
  | 'get-playback'
  | 'group'
  | 'ungroup'
  | 'list-groups'
  | 'list-players';

/** Parsed inbound command structure */
interface SonosCommand {
  action: SonosAction;
  groupId?: string | undefined;
  playerId?: string | undefined;
  volume?: number | undefined;
  playerIds?: string[] | undefined;
}

/** Sonos player info */
interface SonosPlayer {
  id: string;
  name: string;
  websocketUrl?: string;
  softwareVersion?: string;
  capabilities?: string[];
}

/** Sonos group (room grouping) info */
interface SonosGroup {
  id: string;
  name: string;
  coordinatorId: string;
  playerIds: string[];
  playbackState?: string;
}

/** Playback status response object */
interface SonosPlaybackStatus {
  groupId: string;
  groupName?: string | undefined;
  state: 'playing' | 'paused' | 'stopped' | 'buffering' | 'idle';
  track?: {
    name?: string | undefined;
    artist?: string | undefined;
    album?: string | undefined;
    durationMs?: number | undefined;
    positionMs?: number | undefined;
    imageUrl?: string | undefined;
  } | undefined;
  volume?: number | undefined;
  muted?: boolean | undefined;
}

// ─── Sonos Adapter ──────────────────────────────────────────────

export class SonosAdapter extends BaseChannelAdapter {
  readonly channelId = 'sonos';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Sonos',
    emoji: '🔊',
    description: 'Multi-room audio playback control',
    actionTags: ['play', 'pause', 'volume', 'group rooms'],
    sortOrder: 1041,
  };

  readonly configSchema = SonosConfigSchema;

  private config: SonosConfig | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private groups: SonosGroup[] = [];
  private players: SonosPlayer[] = [];
  private lastPlaybackStates: Map<string, SonosPlaybackStatus> = new Map();

  /** Base URL for the Sonos Cloud Control API */
  private readonly API_BASE = 'https://api.ws.sonos.com/control/api/v1';

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Sonos adapter requires household ID and API key.\n\n' +
        'Setup steps:\n' +
        '1. Register a Sonos developer app at developer.sonos.com\n' +
        '2. Complete OAuth flow to obtain an access token\n' +
        '3. Provide your household ID (found via the /households endpoint)\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Verify credentials by fetching household info
    try {
      const response = await this.apiFetch(
        `/households/${this.config.householdId}/groups`,
      );

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return this.authFailed(
            'Invalid or expired Sonos API key. Re-authenticate via OAuth.',
          );
        }
        const errorBody = await response.text();
        return {
          success: false,
          message: `Sonos API error (${response.status}): ${errorBody}`,
          error: { code: 'PROVIDER_ERROR', message: errorBody },
        };
      }

      // Cache initial groups and players
      const data = (await response.json()) as {
        groups?: SonosGroup[];
        players?: SonosPlayer[];
      };
      this.groups = data.groups ?? [];
      this.players = data.players ?? [];
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to connect to Sonos API: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    // Start polling for playback status changes
    this.startPolling();

    this.connected = true;
    this.log('info', 'Connected', {
      channelId: 'sonos',
      householdId: this.config.householdId,
      groups: this.groups.length,
      players: this.players.length,
    });

    return {
      success: true,
      message: `Sonos connected — ${this.players.length} player(s), ${this.groups.length} group(s)`,
    };
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    this.connected = false;
    this.config = null;
    this.groups = [];
    this.players = [];
    this.lastPlaybackStates.clear();
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config) {
      return { success: false, message: 'Sonos adapter is not connected' };
    }

    // Parse the outbound message content as a command
    const command = this.parseCommand(message.content);
    if (!command) {
      // Default to get-playback if we can't parse the command
      return this.getPlaybackStatus(this.getDefaultGroupId());
    }

    // Execute the parsed command
    try {
      switch (command.action) {
        case 'play':
          return this.controlPlayback('play', command.groupId);
        case 'pause':
          return this.controlPlayback('pause', command.groupId);
        case 'stop':
          return this.controlPlayback('stop', command.groupId);
        case 'next':
          return this.controlPlayback('skipToNextTrack', command.groupId);
        case 'previous':
          return this.controlPlayback('skipToPreviousTrack', command.groupId);
        case 'set-volume':
          return this.setVolume(command.groupId, command.volume ?? 50);
        case 'get-volume':
          return this.getVolume(command.groupId);
        case 'mute':
          return this.setMute(command.groupId, true);
        case 'unmute':
          return this.setMute(command.groupId, false);
        case 'get-playback':
          return this.getPlaybackStatus(command.groupId);
        case 'group':
          return this.createGroup(command.playerIds ?? []);
        case 'ungroup':
          return this.ungroupPlayer(command.playerId);
        case 'list-groups':
          return this.listGroups();
        case 'list-players':
          return this.listPlayers();
        default:
          return { success: false, message: `Unknown Sonos action: ${command.action}` };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Send failed', { error: errMsg });
      return { success: false, message: `Sonos operation failed: ${errMsg}` };
    }
  }

  // ─── Private: Playback Control ──────────────────────────────────

  /**
   * Control playback on a group (play, pause, stop, skip).
   * Uses the Sonos Cloud playback endpoint.
   */
  private async controlPlayback(
    action: 'play' | 'pause' | 'stop' | 'skipToNextTrack' | 'skipToPreviousTrack',
    groupId?: string,
  ): Promise<SendResult> {
    const gid = groupId ?? this.getDefaultGroupId();
    if (!gid) {
      return { success: false, message: 'No Sonos group available' };
    }

    const response = await this.apiFetch(
      `/groups/${gid}/playback/${action}`,
      { method: 'POST' },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Playback ${action} failed: ${errorBody}` };
    }

    return {
      success: true,
      message: JSON.stringify({
        action,
        groupId: gid,
        status: 'applied',
      }),
    };
  }

  /**
   * Set volume for a group. Volume ranges from 0 to 100.
   */
  private async setVolume(groupId: string | undefined, volume: number): Promise<SendResult> {
    const gid = groupId ?? this.getDefaultGroupId();
    if (!gid) {
      return { success: false, message: 'No Sonos group available' };
    }

    const clampedVolume = Math.max(0, Math.min(100, Math.round(volume)));

    const response = await this.apiFetch(
      `/groups/${gid}/groupVolume`,
      {
        method: 'POST',
        body: JSON.stringify({ volume: clampedVolume }),
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Set volume failed: ${errorBody}` };
    }

    return {
      success: true,
      message: JSON.stringify({
        action: 'set-volume',
        groupId: gid,
        volume: clampedVolume,
        status: 'applied',
      }),
    };
  }

  /**
   * Get the current volume for a group.
   */
  private async getVolume(groupId: string | undefined): Promise<SendResult> {
    const gid = groupId ?? this.getDefaultGroupId();
    if (!gid) {
      return { success: false, message: 'No Sonos group available' };
    }

    const response = await this.apiFetch(`/groups/${gid}/groupVolume`);

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Get volume failed: ${errorBody}` };
    }

    const data = (await response.json()) as { volume?: number; muted?: boolean };

    return {
      success: true,
      message: JSON.stringify({
        action: 'get-volume',
        groupId: gid,
        volume: data.volume ?? 0,
        muted: data.muted ?? false,
      }),
    };
  }

  /**
   * Set mute state for a group.
   */
  private async setMute(groupId: string | undefined, muted: boolean): Promise<SendResult> {
    const gid = groupId ?? this.getDefaultGroupId();
    if (!gid) {
      return { success: false, message: 'No Sonos group available' };
    }

    const response = await this.apiFetch(
      `/groups/${gid}/groupVolume/mute`,
      {
        method: 'POST',
        body: JSON.stringify({ muted }),
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Mute operation failed: ${errorBody}` };
    }

    return {
      success: true,
      message: JSON.stringify({
        action: muted ? 'mute' : 'unmute',
        groupId: gid,
        muted,
        status: 'applied',
      }),
    };
  }

  /**
   * Get the current playback status for a group.
   * Returns track info, state, volume, and mute status.
   */
  private async getPlaybackStatus(groupId: string | undefined): Promise<SendResult> {
    const gid = groupId ?? this.getDefaultGroupId();
    if (!gid) {
      return { success: false, message: 'No Sonos group available' };
    }

    const response = await this.apiFetch(`/groups/${gid}/playback`);

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Get playback failed: ${errorBody}` };
    }

    const data = (await response.json()) as {
      playbackState?: string;
      item?: {
        track?: {
          name?: string;
          artist?: { name?: string };
          album?: { name?: string };
          durationMillis?: number;
          imageUrl?: string;
        };
      };
      positionMillis?: number;
    };

    const group = this.groups.find((g) => g.id === gid);

    const status: SonosPlaybackStatus = {
      groupId: gid,
      groupName: group?.name,
      state: this.mapPlaybackState(data.playbackState),
      track: data.item?.track
        ? {
            name: data.item.track.name,
            artist: data.item.track.artist?.name,
            album: data.item.track.album?.name,
            durationMs: data.item.track.durationMillis,
            positionMs: data.positionMillis,
            imageUrl: data.item.track.imageUrl,
          }
        : undefined,
    };

    return {
      success: true,
      message: JSON.stringify(status, null, 2),
    };
  }

  // ─── Private: Room Grouping ─────────────────────────────────────

  /**
   * Create a new group from a set of player IDs.
   * The first player in the list becomes the coordinator.
   */
  private async createGroup(playerIds: string[]): Promise<SendResult> {
    if (playerIds.length < 2) {
      return {
        success: false,
        message: 'Room grouping requires at least 2 player IDs',
      };
    }

    const response = await this.apiFetch(
      `/households/${this.config!.householdId}/groups/createGroup`,
      {
        method: 'POST',
        body: JSON.stringify({ playerIds }),
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Create group failed: ${errorBody}` };
    }

    const data = (await response.json()) as { group?: SonosGroup };

    // Refresh groups cache
    await this.refreshGroups();

    return {
      success: true,
      message: JSON.stringify({
        action: 'group',
        groupId: data.group?.id,
        playerIds,
        status: 'created',
      }),
    };
  }

  /**
   * Remove a player from its current group (ungroup / make standalone).
   */
  private async ungroupPlayer(playerId: string | undefined): Promise<SendResult> {
    if (!playerId) {
      return { success: false, message: 'Player ID is required for ungrouping' };
    }

    const response = await this.apiFetch(
      `/households/${this.config!.householdId}/groups/modifyGroupMembers`,
      {
        method: 'POST',
        body: JSON.stringify({
          playerIdsToRemove: [playerId],
        }),
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Ungroup player failed: ${errorBody}` };
    }

    // Refresh groups cache
    await this.refreshGroups();

    return {
      success: true,
      message: JSON.stringify({
        action: 'ungroup',
        playerId,
        status: 'applied',
      }),
    };
  }

  /**
   * List all current groups in the household.
   */
  private async listGroups(): Promise<SendResult> {
    await this.refreshGroups();

    return {
      success: true,
      message: JSON.stringify({
        action: 'list-groups',
        groups: this.groups.map((g) => ({
          id: g.id,
          name: g.name,
          coordinatorId: g.coordinatorId,
          playerIds: g.playerIds,
          playbackState: g.playbackState,
        })),
      }, null, 2),
    };
  }

  /**
   * List all players in the household.
   */
  private async listPlayers(): Promise<SendResult> {
    await this.refreshGroups();

    return {
      success: true,
      message: JSON.stringify({
        action: 'list-players',
        players: this.players.map((p) => ({
          id: p.id,
          name: p.name,
          softwareVersion: p.softwareVersion,
        })),
      }, null, 2),
    };
  }

  // ─── Private: Polling for playback changes ─────────────────────

  /**
   * Start polling for playback status changes across all groups.
   * Emits inbound messages when playback state changes (e.g., track change).
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
   * Poll all groups for playback status changes.
   * Emits an inbound message when a group's playback state changes.
   */
  private async pollForChanges(): Promise<void> {
    for (const group of this.groups) {
      try {
        const response = await this.apiFetch(`/groups/${group.id}/playback`);
        if (!response.ok) continue;

        const data = (await response.json()) as {
          playbackState?: string;
          item?: {
            track?: {
              name?: string;
              artist?: { name?: string };
              album?: { name?: string };
              durationMillis?: number;
              imageUrl?: string;
            };
          };
          positionMillis?: number;
        };

        const currentStatus: SonosPlaybackStatus = {
          groupId: group.id,
          groupName: group.name,
          state: this.mapPlaybackState(data.playbackState),
          track: data.item?.track
            ? {
                name: data.item.track.name,
                artist: data.item.track.artist?.name,
                album: data.item.track.album?.name,
                durationMs: data.item.track.durationMillis,
                imageUrl: data.item.track.imageUrl,
              }
            : undefined,
        };

        const prev = this.lastPlaybackStates.get(group.id);
        if (prev && this.hasPlaybackChanged(prev, currentStatus)) {
          const changeContent = JSON.stringify({
            event: 'playback-changed',
            groupId: group.id,
            groupName: group.name,
            previous: prev,
            current: currentStatus,
          });

          this.emitInbound(group.id, changeContent, 'text');
        }

        this.lastPlaybackStates.set(group.id, currentStatus);
      } catch {
        // Skip individual group poll failures
      }
    }
  }

  /**
   * Compare two playback statuses to detect meaningful changes.
   */
  private hasPlaybackChanged(
    prev: SonosPlaybackStatus,
    curr: SonosPlaybackStatus,
  ): boolean {
    return (
      prev.state !== curr.state ||
      prev.track?.name !== curr.track?.name ||
      prev.track?.artist !== curr.track?.artist
    );
  }

  // ─── Private: Helpers ───────────────────────────────────────────

  /**
   * Get the default group ID (first group in the household).
   */
  private getDefaultGroupId(): string | undefined {
    return this.groups[0]?.id;
  }

  /**
   * Refresh the groups and players cache from the Sonos API.
   */
  private async refreshGroups(): Promise<void> {
    if (!this.config) return;

    try {
      const response = await this.apiFetch(
        `/households/${this.config.householdId}/groups`,
      );
      if (response.ok) {
        const data = (await response.json()) as {
          groups?: SonosGroup[];
          players?: SonosPlayer[];
        };
        this.groups = data.groups ?? [];
        this.players = data.players ?? [];
      }
    } catch {
      this.log('warn', 'Failed to refresh groups');
    }
  }

  /**
   * Map Sonos API playback state strings to our normalized state type.
   */
  private mapPlaybackState(
    state?: string,
  ): 'playing' | 'paused' | 'stopped' | 'buffering' | 'idle' {
    switch (state?.toUpperCase()) {
      case 'PLAYBACK_STATE_PLAYING':
      case 'PLAYING':
        return 'playing';
      case 'PLAYBACK_STATE_PAUSED':
      case 'PAUSED':
        return 'paused';
      case 'PLAYBACK_STATE_BUFFERING':
      case 'BUFFERING':
        return 'buffering';
      case 'PLAYBACK_STATE_IDLE':
      case 'IDLE':
        return 'idle';
      default:
        return 'stopped';
    }
  }

  // ─── Private: Command parsing ───────────────────────────────────

  /**
   * Parse message content into a structured Sonos command.
   * Supports JSON-format commands and natural language patterns:
   * - "play" / "pause" / "stop" / "next" / "previous"
   * - "volume <0-100>" / "set volume <0-100>"
   * - "get volume"
   * - "mute" / "unmute"
   * - "status" / "get playback" / "now playing"
   * - "group <player1> <player2> ..."
   * - "ungroup <playerId>"
   * - "list groups" / "list players"
   */
  private parseCommand(content: string): SonosCommand | null {
    // Try JSON parsing first
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.action) {
        return parsed as SonosCommand;
      }
    } catch {
      // Not JSON, try natural language patterns
    }

    const lower = content.toLowerCase().trim();

    // Simple actions
    if (/^play$/i.test(lower)) return { action: 'play' };
    if (/^pause$/i.test(lower)) return { action: 'pause' };
    if (/^stop$/i.test(lower)) return { action: 'stop' };
    if (/^(next|skip)$/i.test(lower)) return { action: 'next' };
    if (/^(previous|prev|back)$/i.test(lower)) return { action: 'previous' };
    if (/^mute$/i.test(lower)) return { action: 'mute' };
    if (/^unmute$/i.test(lower)) return { action: 'unmute' };

    // Volume: "volume 50" or "set volume 50"
    const volMatch = lower.match(/^(?:set\s+)?volume\s+(\d+)$/);
    if (volMatch) {
      return { action: 'set-volume', volume: parseInt(volMatch[1]!, 10) };
    }

    // Get volume
    if (/^get\s+volume$/i.test(lower)) {
      return { action: 'get-volume' };
    }

    // Playback status: "status" / "get playback" / "now playing"
    if (/^(status|get\s+playback|now\s+playing|what'?s?\s+playing)$/i.test(lower)) {
      return { action: 'get-playback' };
    }

    // List commands
    if (/^list\s+groups?$/i.test(lower)) return { action: 'list-groups' };
    if (/^list\s+players?$/i.test(lower)) return { action: 'list-players' };

    // Group: "group <id1> <id2> ..."
    const groupMatch = content.match(/^group\s+(.+)$/i);
    if (groupMatch) {
      const playerIds = groupMatch[1]!.split(/[\s,]+/).filter(Boolean);
      if (playerIds.length >= 2) {
        return { action: 'group', playerIds };
      }
    }

    // Ungroup: "ungroup <playerId>"
    const ungroupMatch = content.match(/^ungroup\s+(\S+)$/i);
    if (ungroupMatch) {
      return { action: 'ungroup', playerId: ungroupMatch[1] };
    }

    return null;
  }

  // ─── Private: API fetch helper ──────────────────────────────────

  /**
   * Make an authenticated request to the Sonos Cloud Control API.
   * Uses Bearer token auth with the API key (OAuth access token).
   */
  private async apiFetch(
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    if (!this.config) {
      throw new Error('Sonos adapter is not configured');
    }

    const url = `${this.API_BASE}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> ?? {}),
    };

    return fetch(url, {
      ...options,
      headers,
    });
  }
}
