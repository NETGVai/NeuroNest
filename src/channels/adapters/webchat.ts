// ─── WebChat Adapter ────────────────────────────────────────────
// Full ChannelAdapter implementation for a local WebChat server.
// Starts an HTTP/WebSocket server that browser clients can connect to.
// Each WebSocket connection is assigned a unique session ID used as
// the inbound `from` identifier. AI responses are pushed back to
// clients via the same WebSocket connection.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.1, REQ 6.11

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
 * Zod schema for WebChat adapter configuration.
 * The only required field is the port number for the local server.
 */
export const WebChatConfigSchema = z.object({
  /** Port number for the local HTTP/WebSocket server (default: 9880) */
  port: z.number().int().min(1).max(65535).default(9880),
});

export type WebChatConfig = z.infer<typeof WebChatConfigSchema>;

// ─── Types ──────────────────────────────────────────────────────

interface WebChatClient {
  sessionId: string;
  ws: import('ws').WebSocket;
  connectedAt: number;
}

// ─── WebChat Adapter ────────────────────────────────────────────

export class WebChatAdapter extends BaseChannelAdapter {
  readonly channelId = 'webchat';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'websocket',
    requiresListener: true,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'WebChat',
    emoji: '💬',
    description: 'Local HTTP/WebSocket chat server for browser clients',
    actionTags: ['send message', 'receive message'],
    sortOrder: 1090,
  };

  readonly configSchema = WebChatConfigSchema;

  private config: WebChatConfig | null = null;
  private httpServer: http.Server | null = null;
  private wss: import('ws').WebSocketServer | null = null;
  private clients = new Map<string, WebChatClient>();

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'WebChat adapter configuration is invalid.\n\n' +
        'Configuration:\n' +
        '  port: number (1-65535, default: 9880)\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Dynamically import ws — return SDK_MISSING if not available
    let WebSocketServer: typeof import('ws').WebSocketServer;
    try {
      const wsModule = await import('ws');
      WebSocketServer = wsModule.WebSocketServer;
    } catch {
      return this.sdkMissing('ws');
    }

    // Start the HTTP server
    try {
      await this.startServer(WebSocketServer);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to start WebChat server: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    this.connected = true;
    this.log('info', 'Connected', { port: this.config.port });

    return {
      success: true,
      message: `WebChat server listening on ws://127.0.0.1:${this.config.port}`,
    };
  }

  async disconnect(): Promise<void> {
    // Close all client connections
    for (const client of this.clients.values()) {
      try {
        client.ws.close(1001, 'Server shutting down');
      } catch {
        // Ignore close errors during teardown
      }
    }
    this.clients.clear();

    // Shut down WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

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
      return { success: false, message: 'WebChat adapter is not connected' };
    }

    const client = this.clients.get(message.to);
    if (!client) {
      return { success: false, message: `No WebChat client found with session ID: ${message.to}` };
    }

    // Check WebSocket is open
    if (client.ws.readyState !== 1 /* WebSocket.OPEN */) {
      return { success: false, message: `WebSocket for session ${message.to} is not open` };
    }

    try {
      const payload = JSON.stringify({
        type: 'message',
        content: message.content,
        contentType: message.contentType ?? 'text',
        timestamp: new Date().toISOString(),
      });

      await new Promise<void>((resolve, reject) => {
        client.ws.send(payload, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      return { success: true, message: `Message sent to WebChat client ${message.to}` };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Send failed', { error: errMsg, to: message.to });
      return { success: false, message: `WebChat send failed: ${errMsg}` };
    }
  }

  // ─── Private: Start HTTP + WebSocket Server ───────────────────

  private startServer(
    WebSocketServer: typeof import('ws').WebSocketServer,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.config) {
        return reject(new Error('No configuration'));
      }

      const { port } = this.config;

      // Create HTTP server that responds with a basic health endpoint
      this.httpServer = http.createServer((req, res) => {
        if (req.url === '/health' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'ok',
            channelId: 'webchat',
            clients: this.clients.size,
          }));
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        }
      });

      // Create WebSocket server attached to the HTTP server
      this.wss = new WebSocketServer({ server: this.httpServer });

      this.wss.on('connection', (ws) => {
        this.handleNewConnection(ws);
      });

      this.wss.on('error', (err) => {
        this.log('error', 'WebSocket server error', { error: err.message });
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

  // ─── Private: Handle new WebSocket connection ─────────────────

  private handleNewConnection(ws: import('ws').WebSocket): void {
    // Assign a unique session ID to this client
    const sessionId = `webchat-${crypto.randomUUID()}`;

    const client: WebChatClient = {
      sessionId,
      ws,
      connectedAt: Date.now(),
    };

    this.clients.set(sessionId, client);

    this.log('info', 'Client connected', { sessionId });

    // Send welcome message with assigned session ID
    const welcome = JSON.stringify({
      type: 'connected',
      sessionId,
      timestamp: new Date().toISOString(),
    });
    ws.send(welcome);

    // Handle incoming messages
    ws.on('message', (data) => {
      this.handleClientMessage(sessionId, data);
    });

    // Handle disconnection
    ws.on('close', () => {
      this.clients.delete(sessionId);
      this.log('info', 'Client disconnected', { sessionId });
    });

    // Handle errors
    ws.on('error', (err) => {
      this.log('warn', 'Client WebSocket error', { sessionId, error: err.message });
      this.clients.delete(sessionId);
    });
  }

  // ─── Private: Handle messages from a client ───────────────────

  private handleClientMessage(sessionId: string, data: import('ws').RawData): void {
    if (!this.ctx) return;

    let content: string;

    try {
      const text = data.toString('utf8');

      // Try to parse as JSON first (structured messages)
      try {
        const parsed = JSON.parse(text);
        // Support both { content: "..." } and { message: "..." } formats
        content = parsed.content ?? parsed.message ?? parsed.text ?? text;
      } catch {
        // Plain text message
        content = text;
      }
    } catch {
      this.log('warn', 'Failed to read client message', { sessionId });
      return;
    }

    // Ignore empty messages
    if (!content || content.trim().length === 0) return;

    // Emit inbound with the session-bound client identifier (REQ 6.11)
    this.emitInbound(sessionId, content.trim());
  }
}
