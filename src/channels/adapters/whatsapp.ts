// ─── WhatsApp Cloud API Adapter ─────────────────────────────────
// Full ChannelAdapter implementation for WhatsApp using the Meta Cloud API.
// Handles webhook verification, HMAC signature checking, inbound message
// parsing, and outbound sends via the Graph API.
//
// Requirements: REQ 7.1, REQ 8.1, REQ 8.2, REQ 8.3, REQ 8.4, REQ 8.5,
// REQ 8.6, REQ 15.5, REQ 18.1, REQ 18.4, REQ 19.1, REQ 19.4, REQ 21.1,
// REQ 21.2, REQ 21.3, REQ 22.1, REQ 23.1, REQ 23.3

import { z } from 'zod';
import * as http from 'node:http';
import * as https from 'node:https';
import * as crypto from 'node:crypto';
import type { ChannelAdapter, AdapterContext } from '../types/adapter';
import type { IncomingMessage, OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';
import { WHATSAPP_WEBHOOK_DEFAULT_PORT } from '../listener-config';
import { redactSecrets } from '../redact';

// ─── Config Schema (REQ 5.1) ────────────────────────────────────

/**
 * Zod schema for WhatsApp adapter configuration.
 * Validates required fields before any HTTP work begins.
 */
export const WhatsAppConfigSchema = z.object({
  accessToken: z.string().min(1),
  phoneNumberId: z.string().min(1),
  verifyToken: z.string().default('neuronest-whatsapp-verify'),
  appSecret: z.string().optional(),
  webhookPort: z.number().int().optional(),
  webhookHost: z.string().optional(),
});

type WhatsAppConfig = z.infer<typeof WhatsAppConfigSchema>;

// ─── WhatsApp Adapter ───────────────────────────────────────────

export class WhatsAppAdapter implements ChannelAdapter {
  readonly channelId = 'whatsapp';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'webhook',
    requiresListener: true,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'WhatsApp',
    emoji: '💬',
    description: 'Cloud API integration',
    actionTags: ['send message', 'receive message', 'send media'],
    sortOrder: 10,
  };

  readonly configSchema = WhatsAppConfigSchema;

  private server: http.Server | null = null;
  private connected = false;
  private ctx: AdapterContext | null = null;
  private config: WhatsAppConfig | null = null;

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Parse and validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      // Fallback error message for direct adapter usage bypassing ChannelManager
      const msg =
        'WhatsApp Cloud API requires an Access Token and Phone Number ID.\n\n' +
        'Setup steps:\n' +
        '1. Go to developers.facebook.com → Create App → Business type\n' +
        '2. Add WhatsApp product → API Setup\n' +
        '3. Copy the "Temporary access token" and "Phone number ID"\n' +
        '4. Connect with: /channel whatsapp accessToken=<token> phoneNumberId=<id>\n\n' +
        'The Cloud API is free for up to 1,000 conversations/month.\n' +
        'WhatsApp integration uses the official Cloud API exclusively.';
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;
    const { accessToken, phoneNumberId, verifyToken, appSecret } = this.config;

    // Secondary fallback: even if Zod passes (shouldn't happen with min(1)),
    // guard against empty strings in case of direct usage with empty strings.
    if (!accessToken || !phoneNumberId) {
      const msg =
        'WhatsApp Cloud API requires an Access Token and Phone Number ID.\n\n' +
        'Setup steps:\n' +
        '1. Go to developers.facebook.com → Create App → Business type\n' +
        '2. Add WhatsApp product → API Setup\n' +
        '3. Copy the "Temporary access token" and "Phone number ID"\n' +
        '4. Connect with: /channel whatsapp accessToken=<token> phoneNumberId=<id>\n\n' +
        'The Cloud API is free for up to 1,000 conversations/month.\n' +
        'WhatsApp integration uses the official Cloud API exclusively.';
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    // Reserve listener port (REQ 4.7, REQ 28.6)
    let listenerConfig;
    try {
      const reserveOpts: {
        port?: number;
        host?: string;
        defaultPort: number;
        name: string;
      } = {
        defaultPort: WHATSAPP_WEBHOOK_DEFAULT_PORT,
        name: 'WhatsApp webhook',
      };
      if (this.config.webhookPort !== undefined) reserveOpts.port = this.config.webhookPort;
      if (this.config.webhookHost !== undefined) reserveOpts.host = this.config.webhookHost;
      listenerConfig = context.reserveListener(reserveOpts);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      return {
        success: false,
        message: msg,
        error: { code: 'LISTENER_PORT_CONFLICT', message: msg },
      };
    }

    // Start HTTP webhook server
    try {
      this.server = http.createServer((req, res) => {
        if (req.method === 'GET') {
          this.handleVerification(req, res, verifyToken);
        } else if (req.method === 'POST') {
          this.handleInbound(req, res, appSecret);
        } else {
          res.writeHead(405);
          res.end();
        }
      });

      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(listenerConfig.port, listenerConfig.host, () => {
          this.server!.removeListener('error', reject);
          resolve();
        });
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      context.releaseListener();
      return {
        success: false,
        message: `Failed to start webhook server: ${msg}`,
        error: { code: 'NETWORK_ERROR', message: msg },
      };
    }

    this.connected = true;
    context.logger.info('Connected', { port: listenerConfig.port, host: listenerConfig.host });
    context.logger.info('Config (redacted)', redactSecrets({ accessToken, phoneNumberId, verifyToken, appSecret }) as Record<string, unknown>);

    return {
      success: true,
      message: `WhatsApp webhook listening on ${listenerConfig.host}:${listenerConfig.port}`,
    };
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
    this.connected = false;
    this.config = null;
    if (this.ctx) {
      this.ctx.releaseListener();
      this.ctx = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config) {
      return { success: false, message: 'WhatsApp adapter is not connected' };
    }

    const { accessToken, phoneNumberId } = this.config;

    const payload = JSON.stringify({
      messaging_product: 'whatsapp',
      to: message.to,
      type: 'text',
      text: { body: message.content },
    });

    try {
      const result = await this.graphApiRequest(
        `/v17.0/${phoneNumberId}/messages`,
        'POST',
        payload,
        accessToken,
      );
      return { success: true, message: `Message sent (${result.statusCode})` };
    } catch (err: any) {
      const mapped = this.mapApiError(err);
      if (this.ctx) {
        this.ctx.logger.error('Send failed', { error: mapped.message });
      }
      return { success: false, message: mapped.message };
    }
  }

  // ─── Private: Webhook verification (GET) ────────────────────────

  private handleVerification(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    verifyToken: string,
  ): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === verifyToken && challenge) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(challenge);
    } else {
      res.writeHead(403);
      res.end();
    }
  }

  // ─── Private: Inbound POST handling ─────────────────────────────

  private handleInbound(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    appSecret: string | undefined,
  ): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);

      // HMAC-SHA256 verification (REQ 19.1, REQ 19.4)
      if (appSecret) {
        const signature = req.headers['x-hub-signature-256'] as string | undefined;
        if (!this.verifySignature(body, signature, appSecret)) {
          const sourceIp =
            (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
            req.socket.remoteAddress ??
            'unknown';
          if (this.ctx) {
            this.ctx.logger.warn('HMAC verification failed', { sourceIp });
          }
          res.writeHead(401);
          res.end();
          return;
        }
      }

      // Parse payload
      let payload: any;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }

      // Respond 200 immediately (Meta expects quick acknowledgement)
      res.writeHead(200);
      res.end();

      // Extract and emit messages
      this.parseAndEmitMessages(payload);
    });
  }

  // ─── Private: Signature verification ────────────────────────────

  private verifySignature(
    body: Buffer,
    signatureHeader: string | undefined,
    appSecret: string,
  ): boolean {
    if (!signatureHeader) return false;

    const expectedSignature =
      'sha256=' + crypto.createHmac('sha256', appSecret).update(body).digest('hex');

    // Constant-time comparison
    try {
      return crypto.timingSafeEqual(
        Buffer.from(signatureHeader, 'utf8'),
        Buffer.from(expectedSignature, 'utf8'),
      );
    } catch {
      // Lengths differ — invalid signature
      return false;
    }
  }

  // ─── Private: Message parsing ───────────────────────────────────

  private parseAndEmitMessages(payload: any): void {
    if (!this.ctx) return;

    const entries = payload?.entry;
    if (!Array.isArray(entries)) return;

    for (const entry of entries) {
      const changes = entry?.changes;
      if (!Array.isArray(changes)) continue;

      for (const change of changes) {
        const messages = change?.value?.messages;
        if (!Array.isArray(messages)) continue;

        for (const msg of messages) {
          if (msg.type !== 'text') continue;

          const incoming: IncomingMessage = {
            channelId: 'whatsapp',
            from: msg.from ?? '',
            content: msg.text?.body ?? '',
            timestamp: new Date((msg.timestamp ?? 0) * 1000),
            contentType: 'text',
            providerMetadata: {
              channelId: 'whatsapp',
              waMessageId: msg.id,
              timestamp: msg.timestamp,
            },
          };

          this.ctx.emit(incoming);
        }
      }
    }
  }

  // ─── Private: Meta Graph API request ────────────────────────────

  private graphApiRequest(
    path: string,
    method: string,
    body: string,
    accessToken: string,
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: 'graph.facebook.com',
        path,
        method,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 30000,
      };

      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8');
          const statusCode = res.statusCode ?? 0;

          if (statusCode >= 200 && statusCode < 300) {
            resolve({ statusCode, body: responseBody });
          } else {
            const err = new Error(`Graph API error: HTTP ${statusCode}`) as any;
            err.statusCode = statusCode;
            err.responseBody = responseBody;
            reject(err);
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        const err = new Error('Graph API request timed out') as any;
        err.code = 'ETIMEDOUT';
        reject(err);
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.write(body);
      req.end();
    });
  }

  // ─── Private: Error mapping (REQ 21.1, REQ 21.2, REQ 21.3) ─────

  private mapApiError(err: any): { code: 'AUTH_FAILED' | 'NETWORK_ERROR' | 'PROVIDER_ERROR'; message: string } {
    // HTTP 401 → AUTH_FAILED
    if (err.statusCode === 401) {
      return {
        code: 'AUTH_FAILED',
        message: 'Meta API authentication failed (HTTP 401). Check your access token.',
      };
    }

    // Network-level errors → NETWORK_ERROR
    const networkCodes = ['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EPIPE'];
    if (networkCodes.includes(err.code)) {
      return {
        code: 'NETWORK_ERROR',
        message: `Network error communicating with Meta API: ${err.code}`,
      };
    }

    // Everything else → PROVIDER_ERROR
    return {
      code: 'PROVIDER_ERROR',
      message: err.message ?? String(err),
    };
  }
}
