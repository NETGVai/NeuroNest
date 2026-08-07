// ─── Zalo Adapter ───────────────────────────────────────────────
// Full ChannelAdapter implementation for Zalo using the Zalo Official
// Account (OA) API. Starts a local webhook listener to receive inbound
// messages and uses the OA Send Message API to deliver outbound responses.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5, REQ 4.1, REQ 6.10

import { z } from 'zod';
import * as http from 'node:http';
import * as https from 'node:https';
import * as crypto from 'node:crypto';
import type { AdapterContext } from '../types/adapter';
import type { IncomingMessage as NodeIncomingMessage } from 'node:http';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';
import { BaseChannelAdapter } from './base-adapter';

// ─── Config Schema ──────────────────────────────────────────────

/**
 * Zod schema for Zalo OA adapter configuration.
 * Requires app ID, secret key, and access token from the Zalo OA dashboard.
 */
export const ZaloConfigSchema = z.object({
  /** Zalo OA App ID from the developer dashboard */
  appId: z.string().min(1),
  /** Zalo OA Secret Key used for webhook signature verification */
  secretKey: z.string().min(1),
  /** OA Access Token for authenticating API requests */
  accessToken: z.string().min(1),
  /** Local port for the webhook listener (default: 4007) */
  webhookPort: z.number().int().min(1024).max(65535).default(4007),
  /** Optional OA ID (useful for multi-OA setups) */
  oaId: z.string().optional(),
});

/** Inferred config type from ZaloConfigSchema. */
export type ZaloConfig = z.infer<typeof ZaloConfigSchema>;

// ─── Constants ──────────────────────────────────────────────────

const ZALO_OA_API_BASE = 'https://openapi.zalo.me';
const ZALO_SEND_MESSAGE_PATH = '/v3.0/oa/message/cs';

// ─── Zalo Adapter ───────────────────────────────────────────────

export class ZaloAdapter extends BaseChannelAdapter {
  readonly channelId = 'zalo';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'webhook',
    requiresListener: true,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Zalo',
    emoji: '💬',
    description: 'Zalo Official Account messaging via OA API',
    actionTags: ['send message', 'receive message'],
    sortOrder: 1070,
  };

  readonly configSchema = ZaloConfigSchema;

  private config: ZaloConfig | null = null;
  private webhookServer: http.Server | null = null;

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Zalo OA adapter requires an app ID, secret key, and access token.\n\n' +
        'Setup steps:\n' +
        '1. Create a Zalo Official Account at https://oa.zalo.me\n' +
        '2. Register an app at https://developers.zalo.me\n' +
        '3. Generate an OA access token (OAuth flow or from the dashboard)\n' +
        '4. Note your App ID and Secret Key from app settings\n' +
        '5. Connect with: appId, secretKey, accessToken\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Verify access token by calling the OA info endpoint
    try {
      await this.apiRequest('GET', '/v2.0/oa/getoa');
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (this.isAuthError(err)) {
        return {
          success: false,
          message: `Authentication failed: ${errMsg}`,
          error: { code: 'AUTH_FAILED', message: errMsg },
        };
      }
      return {
        success: false,
        message: `Failed to connect to Zalo OA API: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    // Start local webhook listener for inbound messages
    try {
      await this.startWebhookListener();
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to start webhook listener: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    this.connected = true;
    this.log('info', 'Connected', {
      channelId: 'zalo',
      appId: this.config.appId,
      webhookPort: this.config.webhookPort,
    });

    return {
      success: true,
      message: `Zalo OA connected (webhook listening on port ${this.config.webhookPort})`,
    };
  }

  async disconnect(): Promise<void> {
    await this.stopWebhookListener();
    this.connected = false;
    this.config = null;
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config) {
      return { success: false, message: 'Zalo adapter is not connected' };
    }

    const body = JSON.stringify({
      recipient: {
        user_id: message.to,
      },
      message: {
        text: message.content,
      },
    });

    try {
      const response = await this.apiRequest('POST', ZALO_SEND_MESSAGE_PATH, body);
      const data = JSON.parse(response.body);

      if (data.error !== 0 && data.error !== undefined) {
        const errMsg = data.message || `Zalo API error code: ${data.error}`;
        this.log('error', 'Send failed', { error: errMsg, to: message.to });
        return { success: false, message: `Send failed: ${errMsg}` };
      }

      return { success: true, message: `Message sent to Zalo user ${message.to}` };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Send failed', { error: errMsg, to: message.to });
      return { success: false, message: `Zalo send failed: ${errMsg}` };
    }
  }

  // ─── Private: Webhook Listener ────────────────────────────────

  private startWebhookListener(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.config) {
        return reject(new Error('Adapter not configured'));
      }

      const port = this.config.webhookPort;

      this.webhookServer = http.createServer((req, res) => {
        this.handleWebhookRequest(req, res);
      });

      this.webhookServer.on('error', (err) => {
        this.log('error', 'Webhook server error', { error: err.message });
        reject(err);
      });

      this.webhookServer.listen(port, () => {
        this.log('info', 'Webhook listener started', { port });
        resolve();
      });
    });
  }

  private stopWebhookListener(): Promise<void> {
    return new Promise((resolve) => {
      if (this.webhookServer) {
        this.webhookServer.close(() => {
          this.webhookServer = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private handleWebhookRequest(req: NodeIncomingMessage, res: http.ServerResponse): void {
    // Zalo OA webhook verification (GET with challenge)
    if (req.method === 'GET') {
      const url = new URL(req.url ?? '/', `http://localhost`);
      const challenge = url.searchParams.get('challenge');
      if (challenge) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(challenge);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
      return;
    }

    // Only accept POST for inbound events
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');

      // Verify webhook signature if present
      const signature = req.headers['x-zalooa-signature'] as string | undefined;
      if (signature && !this.verifySignature(rawBody, signature)) {
        this.log('warn', 'Webhook signature verification failed');
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }

      // Parse the event
      try {
        const event = JSON.parse(rawBody);
        this.handleZaloEvent(event);
      } catch (err) {
        this.log('warn', 'Failed to parse webhook payload', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Acknowledge receipt immediately
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
  }

  // ─── Private: Process Zalo Webhook Events ─────────────────────

  private handleZaloEvent(event: any): void {
    if (!this.ctx) return;

    // Zalo OA webhook event structure:
    // { event_name: 'user_send_text', sender: { id }, message: { text }, timestamp }
    const eventName = event.event_name;

    if (eventName === 'user_send_text') {
      const senderId = event.sender?.id;
      const text = event.message?.text;

      if (!senderId || !text) {
        this.log('warn', 'Incomplete user_send_text event', { event });
        return;
      }

      this.emitInbound(senderId, text, 'text');
    } else if (eventName === 'user_send_image') {
      const senderId = event.sender?.id;
      const imageUrl = event.message?.attachments?.[0]?.payload?.url;
      const content = imageUrl ?? '[image]';

      if (!senderId) return;
      this.emitInbound(senderId, content, 'image');
    } else if (eventName === 'user_send_file') {
      const senderId = event.sender?.id;
      const fileName = event.message?.attachments?.[0]?.payload?.name ?? '[file]';

      if (!senderId) return;
      this.emitInbound(senderId, fileName, 'file');
    } else if (eventName === 'user_send_audio') {
      const senderId = event.sender?.id;
      const audioUrl = event.message?.attachments?.[0]?.payload?.url;
      const content = audioUrl ?? '[audio]';

      if (!senderId) return;
      this.emitInbound(senderId, content, 'audio');
    }
    // Other event types (follow, unfollow, etc.) are ignored
  }

  // ─── Private: Signature Verification ──────────────────────────

  private verifySignature(body: string, signature: string): boolean {
    if (!this.config) return false;

    const computed = crypto
      .createHmac('sha256', this.config.secretKey)
      .update(body)
      .digest('hex');

    // Timing-safe comparison
    try {
      return crypto.timingSafeEqual(
        Buffer.from(computed, 'hex'),
        Buffer.from(signature, 'hex'),
      );
    } catch {
      return false;
    }
  }

  // ─── Private: API Request Helper ──────────────────────────────

  private apiRequest(
    method: string,
    path: string,
    body?: string,
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      if (!this.config) {
        return reject(new Error('Adapter not configured'));
      }

      const url = new URL(path, ZALO_OA_API_BASE);

      const headers: Record<string, string> = {
        'access_token': this.config.accessToken,
        'Accept': 'application/json',
      };

      if (body) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(Buffer.byteLength(body));
      }

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method,
        headers,
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
            const err = new Error(`Zalo API error: HTTP ${statusCode}`) as any;
            err.statusCode = statusCode;
            err.responseBody = responseBody;
            reject(err);
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        const err = new Error('Zalo API request timed out') as any;
        err.code = 'ETIMEDOUT';
        reject(err);
      });

      req.on('error', (err) => reject(err));

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  // ─── Private: Error Classification ────────────────────────────

  private isAuthError(err: unknown): boolean {
    if (err && typeof err === 'object') {
      const statusCode = (err as any).statusCode;
      if (statusCode === 401 || statusCode === 403) {
        return true;
      }
      // Zalo API returns 200 with error code for auth issues
      const responseBody = (err as any).responseBody;
      if (responseBody) {
        try {
          const data = JSON.parse(responseBody);
          // error codes -201, -202, -213, -216 are auth-related in Zalo API
          if ([-201, -202, -213, -216].includes(data.error)) {
            return true;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
    return false;
  }
}
