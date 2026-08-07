// ─── Nextcloud Talk Adapter ─────────────────────────────────────
// Full ChannelAdapter implementation for Nextcloud Talk using the OCS API.
// Polls for new messages in a conversation and sends chat messages via
// the REST API. Authentication uses app passwords (Basic Auth).
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5, REQ 4.1, REQ 6.8

import { z } from 'zod';
import * as https from 'node:https';
import * as http from 'node:http';
import type { ChannelAdapter, AdapterContext } from '../types/adapter';
import type { IncomingMessage, OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';

// ─── Config Schema ──────────────────────────────────────────────

/**
 * Zod schema for Nextcloud Talk adapter configuration.
 * Requires server URL, username, and app password for Basic Auth.
 */
export const NextcloudTalkConfigSchema = z.object({
  /** Base URL of the Nextcloud server (e.g. https://cloud.example.com) */
  serverUrl: z.string().url(),
  /** Nextcloud username */
  username: z.string().min(1),
  /** App password generated in Nextcloud security settings */
  appPassword: z.string().min(1),
  /** Conversation token (the room/channel to listen on) */
  conversationToken: z.string().min(1),
  /** Polling interval in milliseconds (default: 3000) */
  pollInterval: z.number().int().min(1000).default(3000),
});

/** Inferred config type from NextcloudTalkConfigSchema. */
export type NextcloudTalkConfig = z.infer<typeof NextcloudTalkConfigSchema>;

// ─── Nextcloud Talk Adapter ─────────────────────────────────────

export class NextcloudTalkAdapter implements ChannelAdapter {
  readonly channelId = 'nextcloud-talk';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Nextcloud Talk',
    emoji: '☁️',
    description: 'Nextcloud Talk OCS API messaging',
    actionTags: ['send message', 'receive message'],
    sortOrder: 1040,
  };

  readonly configSchema = NextcloudTalkConfigSchema;

  private connected = false;
  private ctx: AdapterContext | null = null;
  private config: NextcloudTalkConfig | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastKnownMessageId = 0;

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Parse and validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Nextcloud Talk requires a server URL, username, app password, and conversation token.\n\n' +
        'Setup steps:\n' +
        '1. Go to Nextcloud → Settings → Security → App Passwords\n' +
        '2. Generate a new app password for NeuroNest\n' +
        '3. Find the conversation token from the Talk URL (last path segment)\n' +
        '4. Connect with: serverUrl, username, appPassword, conversationToken';
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Verify connectivity by fetching conversation info
    try {
      await this.apiRequest('GET', `/ocs/v2.php/apps/spreed/api/v4/room/${this.config.conversationToken}`);
    } catch (err: unknown) {
      const errorCode = this.mapErrorCode(err);
      const errMsg = err instanceof Error ? err.message : String(err);

      if (errorCode === 'AUTH_FAILED') {
        return {
          success: false,
          message: `Authentication failed: ${errMsg}`,
          error: { code: 'AUTH_FAILED', message: errMsg },
        };
      }

      return {
        success: false,
        message: `Failed to connect to Nextcloud Talk: ${errMsg}`,
        error: { code: errorCode, message: errMsg },
      };
    }

    // Fetch initial messages to establish baseline (get the last known message ID)
    try {
      const messages = await this.fetchMessages();
      if (messages.length > 0) {
        this.lastKnownMessageId = Math.max(...messages.map((m: any) => m.id));
      }
    } catch {
      // Non-fatal — we start polling from zero
    }

    // Start polling for new messages
    this.pollTimer = setInterval(() => {
      this.pollNewMessages().catch((err) => {
        if (this.ctx) {
          this.ctx.logger.error('Poll error', { error: String(err) });
        }
      });
    }, this.config.pollInterval);

    this.connected = true;
    context.logger.info('Connected', {
      channelId: 'nextcloud-talk',
      server: this.config.serverUrl,
      conversation: this.config.conversationToken,
    });

    return {
      success: true,
      message: `Nextcloud Talk connected, polling conversation ${this.config.conversationToken}`,
    };
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.connected = false;
    this.config = null;
    this.ctx = null;
    this.lastKnownMessageId = 0;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config) {
      return { success: false, message: 'Nextcloud Talk adapter is not connected' };
    }

    // The `to` field is the conversation token (may override the default)
    const conversationToken = message.to || this.config.conversationToken;

    try {
      await this.apiRequest(
        'POST',
        `/ocs/v2.php/apps/spreed/api/v1/chat/${conversationToken}`,
        JSON.stringify({ message: message.content }),
      );
      return { success: true, message: 'Message sent to Nextcloud Talk' };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (this.ctx) {
        this.ctx.logger.error('Send failed', { error: errMsg });
      }
      return { success: false, message: `Send failed: ${errMsg}` };
    }
  }

  // ─── Private: Polling ─────────────────────────────────────────

  private async pollNewMessages(): Promise<void> {
    if (!this.connected || !this.config || !this.ctx) return;

    const messages = await this.fetchMessages(this.lastKnownMessageId);

    for (const msg of messages) {
      // Skip messages from ourselves (the bot user)
      if (msg.actorId === this.config.username) continue;
      // Skip system messages
      if (msg.systemMessage && msg.systemMessage !== '') continue;
      // Only process messages newer than the last known
      if (msg.id <= this.lastKnownMessageId) continue;

      const incoming: IncomingMessage = {
        channelId: 'nextcloud-talk',
        from: msg.actorId ?? msg.actorDisplayName ?? 'unknown',
        content: msg.message ?? '',
        timestamp: new Date(msg.timestamp * 1000),
        contentType: 'text',
        providerMetadata: {
          channelId: 'nextcloud-talk',
          messageId: msg.id,
          conversationToken: this.config.conversationToken,
          actorDisplayName: msg.actorDisplayName,
        },
      };

      this.ctx.emit(incoming);
    }

    // Update last known message ID
    if (messages.length > 0) {
      const maxId = Math.max(...messages.map((m: any) => m.id));
      if (maxId > this.lastKnownMessageId) {
        this.lastKnownMessageId = maxId;
      }
    }
  }

  private async fetchMessages(lookIntoFuture = 0): Promise<any[]> {
    if (!this.config) return [];

    const params = new URLSearchParams({
      lookIntoFuture: lookIntoFuture > 0 ? '1' : '0',
      limit: '100',
      includeLastKnown: '0',
    });

    if (lookIntoFuture > 0) {
      params.set('lastKnownMessageId', String(lookIntoFuture));
    }

    const path = `/ocs/v2.php/apps/spreed/api/v1/chat/${this.config.conversationToken}?${params.toString()}`;

    try {
      const response = await this.apiRequest('GET', path);
      const data = JSON.parse(response.body);
      return data?.ocs?.data ?? [];
    } catch (err: unknown) {
      // 304 Not Modified means no new messages — not an error
      if (err && typeof err === 'object' && (err as any).statusCode === 304) {
        return [];
      }
      throw err;
    }
  }

  // ─── Private: API Request Helper ─────────────────────────────

  private apiRequest(
    method: string,
    path: string,
    body?: string,
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      if (!this.config) {
        return reject(new Error('Adapter not configured'));
      }

      const url = new URL(path, this.config.serverUrl);
      const isHttps = url.protocol === 'https:';

      const auth = Buffer.from(`${this.config.username}:${this.config.appPassword}`).toString('base64');

      const headers: Record<string, string> = {
        'Authorization': `Basic ${auth}`,
        'OCS-APIRequest': 'true',
        'Accept': 'application/json',
      };

      if (body) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(Buffer.byteLength(body));
      }

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
        timeout: 30000,
      };

      const transport = isHttps ? https : http;

      const req = transport.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8');
          const statusCode = res.statusCode ?? 0;

          if (statusCode >= 200 && statusCode < 300) {
            resolve({ statusCode, body: responseBody });
          } else {
            const err = new Error(`Nextcloud API error: HTTP ${statusCode}`) as any;
            err.statusCode = statusCode;
            err.responseBody = responseBody;
            reject(err);
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        const err = new Error('Nextcloud API request timed out') as any;
        err.code = 'ETIMEDOUT';
        reject(err);
      });

      req.on('error', (err) => {
        reject(err);
      });

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  // ─── Private: Error Code Mapping ─────────────────────────────

  private mapErrorCode(err: unknown): 'AUTH_FAILED' | 'NETWORK_ERROR' | 'PROVIDER_ERROR' {
    if (err && typeof err === 'object') {
      const statusCode = (err as any).statusCode;
      if (statusCode === 401 || statusCode === 403) {
        return 'AUTH_FAILED';
      }

      const code = (err as any).code;
      const networkCodes = ['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EPIPE'];
      if (networkCodes.includes(code)) {
        return 'NETWORK_ERROR';
      }
    }
    return 'PROVIDER_ERROR';
  }
}
