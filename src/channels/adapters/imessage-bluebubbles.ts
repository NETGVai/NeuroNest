// ─── iMessage BlueBubbles Adapter ───────────────────────────────
// Full ChannelAdapter implementation for iMessage via BlueBubbles server.
// Uses the BlueBubbles REST API for sending and polling for new messages.
// BlueBubbles is a self-hosted macOS server that bridges iMessage to HTTP.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5, REQ 4.1, REQ 6.7

import { z } from 'zod';
import { BaseChannelAdapter } from './base-adapter';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';

// ─── Config Schema ──────────────────────────────────────────────

/**
 * Zod schema for BlueBubbles adapter configuration.
 * Requires the server URL and password for the BlueBubbles REST API.
 */
export const BlueBubblesConfigSchema = z.object({
  /** BlueBubbles server URL (e.g. http://192.168.1.100:1234) */
  serverUrl: z.string().url(),
  /** BlueBubbles server password for API authentication */
  password: z.string().min(1),
  /** Polling interval in milliseconds (default: 5000) */
  pollInterval: z.number().int().min(1000).optional().default(5000),
});

/** Inferred config type from BlueBubblesConfigSchema. */
export type BlueBubblesConfig = z.infer<typeof BlueBubblesConfigSchema>;

// ─── BlueBubbles Adapter ────────────────────────────────────────

export class BlueBubblesAdapter extends BaseChannelAdapter {
  readonly channelId = 'imessage-bluebubbles';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: true,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'iMessage BlueBubbles',
    emoji: '🫧',
    description: 'Via BlueBubbles server',
    actionTags: ['send message', 'receive message', 'group chat'],
    sortOrder: 12,
  };

  readonly configSchema = BlueBubblesConfigSchema;

  private config: BlueBubblesConfig | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageTimestamp = 0;

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Parse and validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg = 'BlueBubbles config requires serverUrl and password.';
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Verify connectivity by pinging the server info endpoint
    try {
      const response = await this.apiRequest('GET', '/api/v1/server/info');
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return this.authFailed('Invalid BlueBubbles server password');
        }
        const msg = `BlueBubbles server returned status ${response.status}`;
        return {
          success: false,
          message: msg,
          error: { code: 'PROVIDER_ERROR', message: msg },
        };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const msg = `Cannot reach BlueBubbles server: ${errMsg}`;
      return {
        success: false,
        message: msg,
        error: { code: 'PROVIDER_ERROR', message: msg },
      };
    }

    // Set initial timestamp to now to avoid replaying old messages
    this.lastMessageTimestamp = Date.now();

    // Start polling for new messages
    this.startPolling();

    this.connected = true;
    context.logger.info('Connected', { channelId: this.channelId });

    return {
      success: true,
      message: 'Connected to BlueBubbles server',
    };
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    this.config = null;
    this.connected = false;
    this.ctx = null;
    this.lastMessageTimestamp = 0;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config) {
      return { success: false, message: 'BlueBubbles adapter is not connected' };
    }

    try {
      const body = {
        chatGuid: message.to,
        message: message.content,
        tempGuid: `nn-${Date.now()}`,
      };

      const response = await this.apiRequest('POST', '/api/v1/message/text', body);

      if (!response.ok) {
        const errText = await response.text().catch(() => 'Unknown error');
        return {
          success: false,
          message: `Send failed (${response.status}): ${errText}`,
        };
      }

      return { success: true, message: 'Message sent via BlueBubbles' };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Send failed: ${errMsg}` };
    }
  }

  // ─── Private helpers ────────────────────────────────────────────

  /**
   * Make an authenticated request to the BlueBubbles REST API.
   * Appends the password as a query parameter per BlueBubbles API convention.
   */
  private async apiRequest(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Response> {
    if (!this.config) {
      throw new Error('BlueBubbles adapter not configured');
    }

    const baseUrl = this.config.serverUrl.replace(/\/$/, '');
    const url = new URL(path, baseUrl);
    url.searchParams.set('password', this.config.password);

    const options: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    return fetch(url.toString(), options);
  }

  /**
   * Start polling the BlueBubbles server for new messages.
   */
  private startPolling(): void {
    if (!this.config) return;

    const interval = this.config.pollInterval;
    this.pollTimer = setInterval(() => {
      this.pollMessages().catch((err) => {
        this.log('error', 'Polling error', { error: String(err) });
      });
    }, interval);
  }

  /**
   * Stop the message polling timer.
   */
  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Fetch new messages from the BlueBubbles server since the last poll.
   * Emits inbound messages for each new message received.
   */
  private async pollMessages(): Promise<void> {
    if (!this.connected || !this.config) return;

    try {
      const body = {
        after: this.lastMessageTimestamp,
        withChats: true,
        limit: 50,
        sort: 'ASC',
      };

      const response = await this.apiRequest('POST', '/api/v1/message/query', body);

      if (!response.ok) {
        this.log('warn', `Poll returned status ${response.status}`);
        return;
      }

      const data = (await response.json()) as {
        status: number;
        data: Array<{
          guid: string;
          text: string | null;
          dateCreated: number;
          isFromMe: boolean;
          handle?: { address: string } | null;
          chats?: Array<{ guid: string }>;
        }>;
      };

      if (!data.data || !Array.isArray(data.data)) return;

      for (const msg of data.data) {
        // Skip messages sent by us
        if (msg.isFromMe) continue;

        // Skip messages without text content
        if (!msg.text) continue;

        // Extract sender address from the handle
        const from = msg.handle?.address ?? 'unknown';

        // Use the chat GUID as contextual metadata for routing replies
        const chatGuid = msg.chats?.[0]?.guid ?? from;

        // Update the last timestamp for next poll
        if (msg.dateCreated > this.lastMessageTimestamp) {
          this.lastMessageTimestamp = msg.dateCreated;
        }

        // Emit the inbound message
        this.emitInbound(chatGuid, msg.text, 'text');
      }
    } catch (err: unknown) {
      this.log('error', 'Failed to poll messages', { error: String(err) });
    }
  }
}
