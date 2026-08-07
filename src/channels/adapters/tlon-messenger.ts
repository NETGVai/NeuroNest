// ─── Tlon Messenger Adapter ─────────────────────────────────────
// Full ChannelAdapter implementation for Tlon Messenger via the Urbit
// HTTP API. Uses SSE (Server-Sent Events) channel subscriptions for
// real-time inbound message reception and POST pokes for sending.
// Authentication uses the ship's +code (web login code).
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5, REQ 4.1, REQ 6.9

import { z } from 'zod';
import * as https from 'node:https';
import * as http from 'node:http';
import type { ChannelAdapter, AdapterContext } from '../types/adapter';
import type { IncomingMessage, OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';

// ─── Config Schema ──────────────────────────────────────────────

/**
 * Zod schema for Tlon Messenger adapter configuration.
 * Requires the ship URL and authentication code (+code from the ship).
 */
export const TlonMessengerConfigSchema = z.object({
  /** Base URL of the Urbit ship (e.g. http://localhost:8080 or https://myship.arvo.network) */
  shipUrl: z.string().url(),
  /** The ship's +code (authentication code from the dojo) */
  authCode: z.string().min(1),
  /** Our ship name (e.g. ~zod, ~sampel-palnet). Used to filter own messages. */
  shipName: z.string().min(1).regex(/^~[a-z-]+$/),
});

/** Inferred config type from TlonMessengerConfigSchema. */
export type TlonMessengerConfig = z.infer<typeof TlonMessengerConfigSchema>;

// ─── Tlon Messenger Adapter ─────────────────────────────────────

export class TlonMessengerAdapter implements ChannelAdapter {
  readonly channelId = 'tlon-messenger';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'websocket',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Tlon Messenger',
    emoji: '⛵',
    description: 'Urbit P2P messaging via Tlon',
    actionTags: ['send message', 'receive message'],
    sortOrder: 1050,
  };

  readonly configSchema = TlonMessengerConfigSchema;

  private connected = false;
  private ctx: AdapterContext | null = null;
  private config: TlonMessengerConfig | null = null;
  private cookie: string | null = null;
  private sseRequest: http.ClientRequest | null = null;
  private channelId_sse: string | null = null;
  private eventId = 0;

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Parse and validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Tlon Messenger requires a ship URL, auth code, and ship name.\n\n' +
        'Setup steps:\n' +
        '1. Get your ship\'s +code by running +code in the Dojo\n' +
        '2. Find your ship URL (e.g. http://localhost:8080)\n' +
        '3. Your ship name starts with ~ (e.g. ~zod, ~sampel-palnet)\n' +
        '4. Connect with: shipUrl, authCode, shipName';
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Step 1: Authenticate with the ship (POST /~/login)
    try {
      const loginResult = await this.authenticate();
      if (!loginResult.success) {
        return loginResult;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to authenticate with Urbit ship: ${errMsg}`,
        error: { code: 'AUTH_FAILED', message: errMsg },
      };
    }

    // Step 2: Open an SSE channel and subscribe to chat messages
    try {
      this.channelId_sse = `neuronest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await this.openChannel();
      await this.subscribe();
      this.startSSEListener();
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to open Urbit channel: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    this.connected = true;
    context.logger.info('Connected', {
      channelId: 'tlon-messenger',
      ship: this.config.shipName,
    });

    return {
      success: true,
      message: `Tlon Messenger connected as ${this.config.shipName}`,
    };
  }

  async disconnect(): Promise<void> {
    // Close SSE connection
    if (this.sseRequest) {
      this.sseRequest.destroy();
      this.sseRequest = null;
    }

    // Delete the channel (best-effort)
    if (this.channelId_sse && this.cookie && this.config) {
      try {
        await this.poke('hood', 'helm-hi', 'closing');
      } catch {
        // Best-effort cleanup
      }
    }

    this.connected = false;
    this.config = null;
    this.ctx = null;
    this.cookie = null;
    this.channelId_sse = null;
    this.eventId = 0;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config || !this.cookie) {
      return { success: false, message: 'Tlon Messenger adapter is not connected' };
    }

    // The `to` field is the recipient ship name (e.g. ~sampel-palnet)
    const recipientShip = message.to;

    if (!recipientShip || !recipientShip.startsWith('~')) {
      return { success: false, message: `Invalid ship name: ${recipientShip}. Must start with ~` };
    }

    // Send a DM via the chat graph-store poke
    try {
      const now = Date.now();
      const action = {
        'add-nodes': {
          resource: {
            ship: this.config.shipName,
            name: `dm-inbox`,
          },
          nodes: {
            [`/${now}`]: {
              post: {
                author: this.config.shipName,
                index: `/${now}`,
                'time-sent': now,
                contents: [{ text: message.content }],
                hash: null,
                signatures: [],
              },
              children: null,
            },
          },
        },
      };

      await this.poke('graph-store', 'graph-update-3', action);
      return { success: true, message: 'Message sent via Tlon Messenger' };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (this.ctx) {
        this.ctx.logger.error('Send failed', { error: errMsg });
      }
      return { success: false, message: `Send failed: ${errMsg}` };
    }
  }

  // ─── Private: Authentication ──────────────────────────────────

  private async authenticate(): Promise<ConnectResult> {
    if (!this.config) {
      return { success: false, message: 'No config', error: { code: 'CONFIG_INVALID', message: 'No config' } };
    }

    const body = `password=${encodeURIComponent(this.config.authCode)}`;

    const response = await this.httpRequest('POST', '/~/login', body, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    if (response.statusCode === 204 || response.statusCode === 200) {
      // Extract the urbauth cookie from set-cookie headers
      const setCookie = response.headers['set-cookie'];
      if (setCookie) {
        const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
        if (cookieStr) {
          const match = cookieStr.match(/urbauth[^=]*=[^;]+/);
          if (match) {
            this.cookie = match[0];
            return { success: true, message: 'Authenticated' };
          }
          // No urbauth pattern found — use the raw cookie value
          this.cookie = cookieStr.split(';')[0] ?? '';
          return { success: true, message: 'Authenticated' };
        }
      }
      // No set-cookie header but 204 means success
      this.cookie = '';
      return { success: true, message: 'Authenticated' };
    }

    if (response.statusCode === 400 || response.statusCode === 401 || response.statusCode === 403) {
      return {
        success: false,
        message: 'Authentication failed: invalid +code',
        error: { code: 'AUTH_FAILED', message: 'Invalid +code' },
      };
    }

    return {
      success: false,
      message: `Unexpected login response: HTTP ${response.statusCode}`,
      error: { code: 'PROVIDER_ERROR', message: `HTTP ${response.statusCode}` },
    };
  }

  // ─── Private: Urbit Channel Management ────────────────────────

  /**
   * Opens the Urbit SSE channel by sending an initial poke.
   * The channel is created implicitly when the first PUT to /~/channel/<id> is made.
   */
  private async openChannel(): Promise<void> {
    const action = {
      id: this.nextEventId(),
      action: 'poke',
      ship: this.config!.shipName.slice(1), // Remove leading ~
      app: 'hood',
      mark: 'helm-hi',
      json: 'opening channel',
    };

    await this.putChannel([action]);
  }

  /**
   * Subscribes to chat/DM updates through the Urbit channel.
   */
  private async subscribe(): Promise<void> {
    const action = {
      id: this.nextEventId(),
      action: 'subscribe',
      ship: this.config!.shipName.slice(1),
      app: 'graph-store',
      path: '/updates',
    };

    await this.putChannel([action]);
  }

  /**
   * Sends actions to the Urbit channel via PUT request.
   */
  private async putChannel(actions: any[]): Promise<void> {
    const body = JSON.stringify(actions);
    const path = `/~/channel/${this.channelId_sse}`;

    const response = await this.httpRequest('PUT', path, body, {
      'Content-Type': 'application/json',
    });

    if (response.statusCode !== 204 && response.statusCode !== 200) {
      throw new Error(`Channel PUT failed: HTTP ${response.statusCode}`);
    }
  }

  /**
   * Sends a poke to an Urbit app via the channel.
   */
  private async poke(app: string, mark: string, json: unknown): Promise<void> {
    const action = {
      id: this.nextEventId(),
      action: 'poke',
      ship: this.config!.shipName.slice(1),
      app,
      mark,
      json,
    };

    await this.putChannel([action]);
  }

  /**
   * Acknowledges receipt of an SSE event to the Urbit ship.
   */
  private async ack(eventId: number): Promise<void> {
    const action = {
      id: this.nextEventId(),
      action: 'ack',
      'event-id': eventId,
    };

    await this.putChannel([action]);
  }

  // ─── Private: SSE Listener ────────────────────────────────────

  /**
   * Opens a GET request to the Urbit SSE channel endpoint and
   * parses incoming Server-Sent Events for chat messages.
   */
  private startSSEListener(): void {
    if (!this.config || !this.channelId_sse || !this.cookie) return;

    const url = new URL(`/~/channel/${this.channelId_sse}`, this.config.shipUrl);
    const isHttps = url.protocol === 'https:';

    const headers: Record<string, string> = {
      'Accept': 'text/event-stream',
      'Cookie': this.cookie,
    };

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers,
    };

    const transport = isHttps ? https : http;

    this.sseRequest = transport.request(options, (res) => {
      let buffer = '';

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        // Process complete SSE events (separated by double newline)
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          this.processSSEEvent(part);
        }
      });

      res.on('end', () => {
        // SSE connection closed — if still connected, log and allow reconnect logic
        if (this.connected && this.ctx) {
          this.ctx.logger.warn('SSE connection closed');
        }
      });

      res.on('error', (err) => {
        if (this.connected && this.ctx) {
          this.ctx.logger.error('SSE stream error', { error: err.message });
        }
      });
    });

    this.sseRequest.on('error', (err) => {
      if (this.connected && this.ctx) {
        this.ctx.logger.error('SSE request error', { error: err.message });
      }
    });

    this.sseRequest.end();
  }

  /**
   * Parses a single SSE event block and emits inbound messages
   * for graph-store update events containing new chat posts.
   */
  private processSSEEvent(eventBlock: string): void {
    if (!this.ctx || !this.config) return;

    let id: number | null = null;
    let data = '';

    for (const line of eventBlock.split('\n')) {
      if (line.startsWith('id:')) {
        id = parseInt(line.slice(3).trim(), 10);
      } else if (line.startsWith('data:')) {
        data += line.slice(5).trim();
      }
    }

    if (id !== null) {
      // Acknowledge the event (fire-and-forget)
      this.ack(id).catch(() => {});
    }

    if (!data) return;

    // Parse the JSON data
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // Not valid JSON — skip
    }

    // Look for graph-update events with add-nodes
    const graphUpdate = parsed?.json?.['graph-update'] ?? parsed?.json;
    if (!graphUpdate || !graphUpdate['add-nodes']) return;

    const addNodes = graphUpdate['add-nodes'];
    const nodes = addNodes.nodes;
    if (!nodes || typeof nodes !== 'object') return;

    // Process each node
    for (const [_index, node] of Object.entries(nodes)) {
      const post = (node as any)?.post;
      if (!post) continue;

      const author = post.author;
      // Skip messages from ourselves
      if (author === this.config.shipName || author === this.config.shipName.slice(1)) {
        continue;
      }

      // Extract text content from post contents array
      const contents = post.contents;
      if (!Array.isArray(contents)) continue;

      const textParts: string[] = [];
      for (const content of contents) {
        if (content.text && typeof content.text === 'string') {
          textParts.push(content.text);
        }
      }

      if (textParts.length === 0) continue;

      const textContent = textParts.join(' ');
      const senderShip = author.startsWith('~') ? author : `~${author}`;

      const incoming: IncomingMessage = {
        channelId: 'tlon-messenger',
        from: senderShip,
        content: textContent,
        timestamp: post['time-sent'] ? new Date(post['time-sent']) : new Date(),
        contentType: 'text',
        providerMetadata: {
          channelId: 'tlon-messenger' as const,
        },
      };

      this.ctx.emit(incoming);
    }
  }

  // ─── Private: HTTP Request Helper ─────────────────────────────

  private httpRequest(
    method: string,
    path: string,
    body?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<{ statusCode: number; body: string; headers: Record<string, string | string[] | undefined> }> {
    return new Promise((resolve, reject) => {
      if (!this.config) {
        return reject(new Error('Adapter not configured'));
      }

      const url = new URL(path, this.config.shipUrl);
      const isHttps = url.protocol === 'https:';

      const headers: Record<string, string> = {
        ...extraHeaders,
      };

      if (this.cookie) {
        headers['Cookie'] = this.cookie;
      }

      if (body) {
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
          resolve({
            statusCode: res.statusCode ?? 0,
            body: responseBody,
            headers: res.headers as Record<string, string | string[] | undefined>,
          });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        const err = new Error('Urbit API request timed out') as any;
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

  // ─── Private: Utilities ───────────────────────────────────────

  private nextEventId(): number {
    return ++this.eventId;
  }
}
