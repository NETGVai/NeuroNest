/**
 * RemoteAccessBridge — Mobile and remote agent monitoring and control.
 *
 * Exposes a secure authenticated API endpoint for remote command submission and
 * status queries. Supports Telegram and web-based messaging bridges that forward
 * permission requests to the user and relay approval/denial responses back.
 *
 * Key behaviors:
 * - start() binds a secure HTTP API endpoint with token-based authentication
 * - requestPermission() forwards permission decisions to the remote client with timeout
 * - stop() gracefully shuts down the API server and messaging bridge
 * - Default deny policy applied when remote client does not respond within timeout
 * - Auth tokens have configurable expiry; expired tokens are rejected
 * - Supports both Telegram bot bridge and web-based WebSocket bridge
 *
 * Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6
 */

import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as crypto from 'node:crypto';

// ─── Interfaces ─────────────────────────────────────────────────

/** Configuration for the Remote Access Bridge */
export interface RemoteAccessConfig {
  /** Port to bind the HTTP API server on */
  port: number;
  /** Authentication token for API access */
  authToken: string;
  /** Token expiry in seconds (how long a token remains valid from issuance) */
  tokenExpiry: number;
  /** Bridge type: Telegram bot or web-based WebSocket */
  bridge: 'telegram' | 'web';
  /** Timeout in seconds for remote client to respond to permission requests */
  defaultDenyTimeout: number;
  /** Optional: Telegram bot token (required when bridge is 'telegram') */
  telegramBotToken?: string;
  /** Optional: Telegram chat ID to send messages to (required when bridge is 'telegram') */
  telegramChatId?: string;
}

/** A remote command submitted via the API */
export interface RemoteCommand {
  /** Unique command identifier */
  id: string;
  /** The command type (e.g., 'status', 'approve', 'deny', 'task') */
  type: 'status' | 'approve' | 'deny' | 'task';
  /** Command payload */
  payload: Record<string, unknown>;
  /** ISO 8601 timestamp when the command was received */
  receivedAt: string;
}

/** Permission request forwarded to the remote client */
export interface PermissionRequest {
  /** Unique request identifier */
  id: string;
  /** Description of what permission is being requested */
  details: string;
  /** ISO 8601 timestamp when the request was created */
  createdAt: string;
  /** ISO 8601 timestamp when the request will time out */
  expiresAt: string;
}

/** Status information exposed via the API */
export interface BridgeStatus {
  /** Whether the bridge is currently running */
  running: boolean;
  /** Bridge type in use */
  bridgeType: 'telegram' | 'web';
  /** Number of pending permission requests */
  pendingPermissions: number;
  /** ISO 8601 timestamp of when the bridge started */
  startedAt: string | null;
}

/** Authentication session representing a validated token */
export interface AuthSession {
  /** The token value */
  token: string;
  /** ISO 8601 timestamp when the token was issued */
  issuedAt: string;
  /** ISO 8601 timestamp when the token expires */
  expiresAt: string;
}

/** Interface for messaging bridge implementations */
export interface MessagingBridge {
  /** Connect and initialize the messaging bridge */
  connect(): Promise<void>;
  /** Send a message to the remote client */
  sendMessage(message: string): Promise<void>;
  /** Disconnect and clean up the messaging bridge */
  disconnect(): Promise<void>;
  /** Whether the bridge is currently connected */
  isConnected(): boolean;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_PORT = 9876;
const DEFAULT_DENY_TIMEOUT_SECONDS = 60;
const DEFAULT_TOKEN_EXPIRY_SECONDS = 3600; // 1 hour

// ─── Telegram Bridge ────────────────────────────────────────────

/**
 * TelegramBridge — Sends permission requests and status updates via Telegram Bot API.
 *
 * Uses HTTP polling/webhooks pattern. In this implementation, messages are sent
 * via the Telegram Bot API sendMessage endpoint. Responses (approve/deny) are
 * received through the main API endpoint.
 */
export class TelegramBridge implements MessagingBridge {
  private connected = false;

  constructor(
    private botToken: string,
    private chatId: string,
  ) {}

  async connect(): Promise<void> {
    if (!this.botToken || !this.chatId) {
      throw new Error('Telegram bridge requires botToken and chatId');
    }
    this.connected = true;
  }

  async sendMessage(message: string): Promise<void> {
    if (!this.connected) {
      throw new Error('Telegram bridge is not connected');
    }

    // Send via Telegram Bot API
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const body = JSON.stringify({
      chat_id: this.chatId,
      text: message,
      parse_mode: 'Markdown',
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Telegram API error: ${response.status} - ${errorText}`);
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

// ─── Web Bridge ─────────────────────────────────────────────────

/**
 * WebBridge — Manages web-based remote access via HTTP long-polling pattern.
 *
 * Messages are queued and served to web clients that poll the /messages endpoint.
 * Responses (approve/deny) are submitted via POST to the main API endpoint.
 */
export class WebBridge implements MessagingBridge {
  private connected = false;
  private messageQueue: string[] = [];

  async connect(): Promise<void> {
    this.connected = true;
    this.messageQueue = [];
  }

  async sendMessage(message: string): Promise<void> {
    if (!this.connected) {
      throw new Error('Web bridge is not connected');
    }
    this.messageQueue.push(message);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.messageQueue = [];
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Drain the message queue (called by the API to serve pending messages to web clients) */
  drainMessages(): string[] {
    const messages = [...this.messageQueue];
    this.messageQueue = [];
    return messages;
  }
}

// ─── RemoteAccessBridge Class ───────────────────────────────────

export class RemoteAccessBridge extends EventEmitter {
  private server: http.Server | null = null;
  private messagingBridge: MessagingBridge | null = null;
  private running = false;
  private startedAt: string | null = null;
  private authSession: AuthSession | null = null;
  private actualPort = 0;
  private pendingPermissions: Map<string, {
    request: PermissionRequest;
    resolve: (decision: 'approved' | 'denied') => void;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();

  constructor(private config: RemoteAccessConfig) {
    super();
  }

  /** Get the actual port the server is listening on (resolves port 0 to the OS-assigned port). */
  getPort(): number {
    return this.actualPort || this.config.port;
  }

  /**
   * Start the Remote Access Bridge.
   *
   * Binds the secure HTTP API endpoint and initializes the messaging bridge
   * (Telegram or web-based). Creates an initial auth session from the configured token.
   *
   * Requirements: 23.1, 23.5
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error('RemoteAccessBridge is already running');
    }

    // Initialize auth session
    this.authSession = this.createAuthSession(this.config.authToken);

    // Initialize messaging bridge
    this.messagingBridge = this.createMessagingBridge();
    await this.messagingBridge.connect();

    // Create and start HTTP server
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.on('error', reject);
      this.server!.listen(this.config.port, () => {
        // Record the actual port (important when config.port is 0)
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.actualPort = addr.port;
        } else {
          this.actualPort = this.config.port;
        }
        resolve();
      });
    });

    this.running = true;
    this.startedAt = new Date().toISOString();
    this.emit('started', { port: this.actualPort, bridge: this.config.bridge });
  }

  /**
   * Forward a permission request to the remote client and await response.
   *
   * Sends the permission details to the configured messaging bridge and waits
   * for the remote client to approve or deny within the configured timeout.
   * If the timeout expires, applies default deny policy.
   *
   * Requirements: 23.2, 23.3, 23.4
   */
  async requestPermission(details: string): Promise<'approved' | 'denied'> {
    if (!this.running || !this.messagingBridge) {
      return 'denied'; // Default deny when bridge not running
    }

    const request: PermissionRequest = {
      id: crypto.randomUUID(),
      details,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(
        Date.now() + this.config.defaultDenyTimeout * 1000,
      ).toISOString(),
    };

    // Send to remote client
    const message = this.formatPermissionMessage(request);

    try {
      await this.messagingBridge.sendMessage(message);
    } catch (error) {
      // If we can't reach the remote client, default deny
      this.emit('permission-send-failed', { requestId: request.id, error });
      return 'denied';
    }

    // Wait for response or timeout
    return new Promise<'approved' | 'denied'>((resolve) => {
      const timer = setTimeout(() => {
        // Timeout — apply default deny policy (Req 23.4)
        this.pendingPermissions.delete(request.id);
        this.emit('permission-timeout', { requestId: request.id });
        resolve('denied');
      }, this.config.defaultDenyTimeout * 1000);

      this.pendingPermissions.set(request.id, { request, resolve, timer });
      this.emit('permission-requested', { request });
    });
  }

  /**
   * Gracefully shutdown the Remote Access Bridge.
   *
   * Closes the HTTP server, disconnects the messaging bridge, and resolves
   * any pending permission requests with 'denied' (default deny on shutdown).
   *
   * Requirements: 23.1 (API lifecycle)
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    // Resolve all pending permissions with 'denied'
    for (const [id, pending] of this.pendingPermissions) {
      clearTimeout(pending.timer);
      pending.resolve('denied');
    }
    this.pendingPermissions.clear();

    // Disconnect messaging bridge
    if (this.messagingBridge) {
      await this.messagingBridge.disconnect();
      this.messagingBridge = null;
    }

    // Close HTTP server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    this.running = false;
    this.authSession = null;
    this.startedAt = null;
    this.emit('stopped');
  }

  /**
   * Resolve a pending permission request with a decision.
   * Called when a remote client submits an approve/deny response.
   */
  resolvePermission(requestId: string, decision: 'approved' | 'denied'): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      return false; // No matching pending request
    }

    clearTimeout(pending.timer);
    this.pendingPermissions.delete(requestId);
    pending.resolve(decision);
    this.emit('permission-resolved', { requestId, decision });
    return true;
  }

  /**
   * Get current bridge status information.
   */
  getStatus(): BridgeStatus {
    return {
      running: this.running,
      bridgeType: this.config.bridge,
      pendingPermissions: this.pendingPermissions.size,
      startedAt: this.startedAt,
    };
  }

  /**
   * Check whether the bridge is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  // ─── Private Methods ──────────────────────────────────────────

  /**
   * Create the appropriate messaging bridge based on config.
   */
  private createMessagingBridge(): MessagingBridge {
    if (this.config.bridge === 'telegram') {
      if (!this.config.telegramBotToken || !this.config.telegramChatId) {
        throw new Error(
          'Telegram bridge requires telegramBotToken and telegramChatId in config',
        );
      }
      return new TelegramBridge(
        this.config.telegramBotToken,
        this.config.telegramChatId,
      );
    }

    return new WebBridge();
  }

  /**
   * Create an auth session with the configured token and expiry.
   *
   * Requirements: 23.5
   */
  private createAuthSession(token: string): AuthSession {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.tokenExpiry * 1000);

    return {
      token,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Validate an incoming request's authentication token.
   *
   * Checks that the token matches and has not expired.
   *
   * Requirements: 23.5
   */
  private validateAuth(token: string | null): boolean {
    if (!token || !this.authSession) {
      return false;
    }

    // Constant-time comparison to prevent timing attacks
    const tokenBuffer = Buffer.from(token);
    const sessionBuffer = Buffer.from(this.authSession.token);

    if (tokenBuffer.length !== sessionBuffer.length) {
      return false;
    }

    if (!crypto.timingSafeEqual(tokenBuffer, sessionBuffer)) {
      return false;
    }

    // Check expiry
    const now = new Date();
    const expiresAt = new Date(this.authSession.expiresAt);
    if (now >= expiresAt) {
      return false;
    }

    return true;
  }

  /**
   * Handle an incoming HTTP request to the API endpoint.
   *
   * Routes: 
   * - GET /status — returns bridge status
   * - GET /messages — returns pending messages (web bridge only)
   * - POST /command — submit a remote command
   * - POST /permission/:id — respond to a permission request
   *
   * Requirements: 23.1
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS headers for web bridge
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Extract auth token from Authorization header
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null;

    if (!this.validateAuth(token)) {
      this.sendJson(res, 401, { error: 'Unauthorized', message: 'Invalid or expired token' });
      return;
    }

    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    if (method === 'GET' && url === '/status') {
      this.handleStatusRequest(res);
    } else if (method === 'GET' && url === '/messages') {
      this.handleMessagesRequest(res);
    } else if (method === 'POST' && url === '/command') {
      this.handleCommandRequest(req, res);
    } else if (method === 'POST' && url.startsWith('/permission/')) {
      this.handlePermissionResponse(req, res, url);
    } else {
      this.sendJson(res, 404, { error: 'Not Found' });
    }
  }

  /**
   * Handle GET /status — return bridge status.
   */
  private handleStatusRequest(res: http.ServerResponse): void {
    this.sendJson(res, 200, this.getStatus());
  }

  /**
   * Handle GET /messages — drain pending messages for web bridge clients.
   */
  private handleMessagesRequest(res: http.ServerResponse): void {
    if (this.config.bridge !== 'web' || !(this.messagingBridge instanceof WebBridge)) {
      this.sendJson(res, 400, { error: 'Messages endpoint only available for web bridge' });
      return;
    }

    const messages = this.messagingBridge.drainMessages();
    this.sendJson(res, 200, { messages });
  }

  /**
   * Handle POST /command — process a remote command.
   */
  private handleCommandRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req).then((body) => {
      try {
        const parsed = JSON.parse(body);
        const command: RemoteCommand = {
          id: crypto.randomUUID(),
          type: parsed.type ?? 'task',
          payload: parsed.payload ?? {},
          receivedAt: new Date().toISOString(),
        };

        this.emit('command-received', command);
        this.sendJson(res, 200, { id: command.id, status: 'accepted' });
      } catch {
        this.sendJson(res, 400, { error: 'Invalid JSON body' });
      }
    }).catch(() => {
      this.sendJson(res, 400, { error: 'Failed to read request body' });
    });
  }

  /**
   * Handle POST /permission/:id — process a permission decision response.
   */
  private handlePermissionResponse(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
  ): void {
    const requestId = url.replace('/permission/', '');

    this.readBody(req).then((body) => {
      try {
        const parsed = JSON.parse(body);
        const decision = parsed.decision === 'approved' ? 'approved' : 'denied';

        const resolved = this.resolvePermission(requestId, decision);
        if (resolved) {
          this.sendJson(res, 200, { requestId, decision, status: 'resolved' });
        } else {
          this.sendJson(res, 404, { error: 'No pending permission with that ID' });
        }
      } catch {
        this.sendJson(res, 400, { error: 'Invalid JSON body' });
      }
    }).catch(() => {
      this.sendJson(res, 400, { error: 'Failed to read request body' });
    });
  }

  /**
   * Format a permission request into a human-readable message.
   */
  private formatPermissionMessage(request: PermissionRequest): string {
    return (
      `🔐 *Permission Request*\n\n` +
      `ID: \`${request.id}\`\n` +
      `Details: ${request.details}\n\n` +
      `Expires: ${request.expiresAt}\n\n` +
      `Reply with /approve or /deny to respond.`
    );
  }

  /**
   * Read the full body of an incoming HTTP request.
   */
  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }

  /**
   * Send a JSON response.
   */
  private sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}
