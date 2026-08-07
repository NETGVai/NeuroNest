// ─── Webhooks Adapter ───────────────────────────────────────────
// Full ChannelAdapter implementation for a local Webhooks HTTP listener.
// Starts a local HTTP server that accepts POST requests as inbound
// messages. Validates optional HMAC-SHA256 webhook secrets for
// request authenticity. Responses to webhook triggers are returned
// as HTTP response bodies or via the standard send() method.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.5, REQ 10.6, REQ 10.7

import { z } from 'zod';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';
import { BaseChannelAdapter } from './base-adapter';

// ─── Config Schema (REQ 1.6) ────────────────────────────────────

/**
 * Zod schema for Webhooks adapter configuration.
 * - port: local HTTP listener port (default: 9881)
 * - secret: optional HMAC-SHA256 secret for payload signature validation
 */
export const WebhooksConfigSchema = z.object({
  /** Port number for the local HTTP listener (default: 9881) */
  port: z.number().int().min(1).max(65535).default(9881),
  /** Optional HMAC-SHA256 secret for validating webhook signatures */
  secret: z.string().optional(),
});

export type WebhooksConfig = z.infer<typeof WebhooksConfigSchema>;

// ─── Webhooks Adapter ───────────────────────────────────────────

export class WebhooksAdapter extends BaseChannelAdapter {
  readonly channelId = 'webhooks';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'webhook',
    requiresListener: true,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Webhooks',
    emoji: '🪝',
    description: 'Local HTTP listener accepting POST requests as inbound messages',
    actionTags: ['receive webhook', 'send response'],
    sortOrder: 1120,
  };

  readonly configSchema = WebhooksConfigSchema;

  private config: WebhooksConfig | null = null;
  private httpServer: http.Server | null = null;
  /** Pending responses keyed by request ID for async reply via send() */
  private pendingResponses = new Map<string, (body: string) => void>();

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Webhooks adapter configuration is invalid.\n\n' +
        'Configuration:\n' +
        '  port: number (1-65535, default: 9881)\n' +
        '  secret: string (optional, HMAC-SHA256 secret)\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Start HTTP server
    try {
      await this.startServer();
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to start Webhooks server: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    this.connected = true;
    this.log('info', 'Connected', { port: this.config.port, hasSecret: !!this.config.secret });

    return {
      success: true,
      message: `Webhooks listener active on http://127.0.0.1:${this.config.port}`,
    };
  }

  async disconnect(): Promise<void> {
    // Reject any pending responses
    for (const [, reject] of this.pendingResponses) {
      reject('');
    }
    this.pendingResponses.clear();

    // Shut down HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }

    this.connected = false;
    this.config = null;
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected) {
      return { success: false, message: 'Webhooks adapter is not connected' };
    }

    // Check if there's a pending HTTP response for this request ID
    const resolver = this.pendingResponses.get(message.to);
    if (resolver) {
      resolver(message.content);
      this.pendingResponses.delete(message.to);
      return { success: true, message: `Response delivered to webhook request ${message.to}` };
    }

    // No pending request — log that we can't deliver this response
    this.log('warn', 'No pending webhook request for response target', { to: message.to });
    return {
      success: false,
      message: `No pending webhook request found for ID: ${message.to}`,
    };
  }

  // ─── Private: Start HTTP Server ───────────────────────────────

  private startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.config) {
        return reject(new Error('No configuration'));
      }

      const { port } = this.config;

      this.httpServer = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      // Listen on loopback only
      this.httpServer.listen(port, '127.0.0.1', () => {
        resolve();
      });

      this.httpServer.on('error', (err) => {
        reject(err);
      });
    });
  }

  // ─── Private: Handle incoming HTTP requests ───────────────────

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Health check endpoint
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        channelId: 'webhooks',
        hasSecret: !!this.config?.secret,
      }));
      return;
    }

    // Only accept POST requests for webhook inbound
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
      return;
    }

    // Collect body
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      const bodyStr = rawBody.toString('utf8');

      // Validate HMAC signature if a secret is configured (REQ 10.7)
      if (this.config?.secret) {
        if (!this.validateSignature(req, rawBody)) {
          this.log('warn', 'Invalid webhook signature', {
            url: req.url,
            ip: req.socket.remoteAddress,
          });
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid signature' }));
          return;
        }
      }

      // Parse the payload
      let content: string;
      let from: string;

      try {
        const parsed = JSON.parse(bodyStr);
        // Support flexible payload shapes:
        // { content: "...", from: "..." } or { body: "...", source: "..." } or plain text
        content = parsed.content ?? parsed.body ?? parsed.message ?? parsed.text ?? bodyStr;
        from = parsed.from ?? parsed.source ?? parsed.sender ?? `webhook-${req.socket.remoteAddress ?? 'unknown'}`;
      } catch {
        // Non-JSON body — treat entire body as message content
        content = bodyStr;
        from = `webhook-${req.socket.remoteAddress ?? 'unknown'}`;
      }

      // Ignore empty payloads
      if (!content || content.trim().length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Empty payload' }));
        return;
      }

      // Generate a unique request ID for routing responses back
      const requestId = `wh-${crypto.randomUUID()}`;

      // Emit inbound message (REQ 10.6)
      this.emitInbound(from, content.trim());

      // Set up a pending response with a timeout
      const responsePromise = new Promise<string>((resolve) => {
        this.pendingResponses.set(requestId, resolve);

        // Auto-resolve after 30 seconds if no response arrives
        setTimeout(() => {
          if (this.pendingResponses.has(requestId)) {
            this.pendingResponses.delete(requestId);
            resolve('');
          }
        }, 30_000);
      });

      // Respond immediately with 202 Accepted and the request ID
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        accepted: true,
        requestId,
        message: 'Webhook received and queued for processing',
      }));
    });

    req.on('error', (err) => {
      this.log('error', 'Request read error', { error: err.message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    });
  }

  // ─── Private: HMAC Signature Validation ───────────────────────

  /**
   * Validates the HMAC-SHA256 signature of the request body.
   * Checks for signature in the following headers (in order):
   * - X-Hub-Signature-256 (GitHub-style: "sha256=<hex>")
   * - X-Webhook-Signature (plain hex)
   * - X-Signature (plain hex)
   *
   * @param req - Incoming HTTP request
   * @param body - Raw request body buffer
   * @returns true if signature is valid, false otherwise
   */
  private validateSignature(req: http.IncomingMessage, body: Buffer): boolean {
    if (!this.config?.secret) return true;

    const expectedHmac = crypto
      .createHmac('sha256', this.config.secret)
      .update(body)
      .digest('hex');

    // Check common webhook signature headers
    const hubSignature = req.headers['x-hub-signature-256'] as string | undefined;
    if (hubSignature) {
      // GitHub-style: "sha256=<hex>"
      const provided = hubSignature.startsWith('sha256=')
        ? hubSignature.slice(7)
        : hubSignature;
      return crypto.timingSafeEqual(
        Buffer.from(provided, 'hex'),
        Buffer.from(expectedHmac, 'hex'),
      );
    }

    const webhookSignature = req.headers['x-webhook-signature'] as string | undefined;
    if (webhookSignature) {
      return crypto.timingSafeEqual(
        Buffer.from(webhookSignature, 'hex'),
        Buffer.from(expectedHmac, 'hex'),
      );
    }

    const plainSignature = req.headers['x-signature'] as string | undefined;
    if (plainSignature) {
      return crypto.timingSafeEqual(
        Buffer.from(plainSignature, 'hex'),
        Buffer.from(expectedHmac, 'hex'),
      );
    }

    // No signature header present — reject when secret is configured
    return false;
  }
}
