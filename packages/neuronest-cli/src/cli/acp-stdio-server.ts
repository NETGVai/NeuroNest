// File: packages/neuronest-cli/src/cli/acp-stdio-server.ts
//
// ACP (Agent Communication Protocol) server — JSON-RPC 2.0 over stdio
// with LSP-style Content-Length framing.
//
// The `neuronest agent stdio` subcommand starts this server. External
// tools, editors, and CI systems communicate with NeuroNest
// programmatically through this interface.
//
// Framing: Content-Length header (LSP style)
//   Request:  Content-Length: N\r\n\r\n{...json...}
//   Response: Content-Length: N\r\n\r\n{...json...}
//
// Methods:
//   agent/start   — Initialize a new session
//   agent/message — Send a prompt to the agent
//   agent/status  — Get current session state
//   agent/stop    — End the session
//
// Validates: Requirements 16.1, 16.2, 16.3, 20.1, 20.2, 20.8, 20.9

import { randomUUID } from 'node:crypto';

// ─── JSON-RPC 2.0 Types ────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Standard JSON-RPC error codes
export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Custom codes
  SESSION_NOT_STARTED: -32001,
  SESSION_ALREADY_STARTED: -32002,
  SESSION_STOPPED: -32003,
} as const;

// ─── Session State ──────────────────────────────────────────────

export type SessionStatus = 'idle' | 'active' | 'processing' | 'stopped';

export interface SessionState {
  sessionId: string;
  status: SessionStatus;
  projectDir: string;
  createdAt: string;
  messageCount: number;
}

// ─── Content-Length Framing Parser ──────────────────────────────

/**
 * Parses LSP-style Content-Length framed messages from a byte stream.
 * Each message has the format:
 *   Content-Length: <number>\r\n\r\n<json-payload>
 *
 * The parser accumulates incoming data chunks and emits complete
 * JSON-RPC messages as they become available.
 */
export class ContentLengthFrameParser {
  private buffer = Buffer.alloc(0);
  private expectedLength: number | null = null;

  /**
   * Feed a chunk of data into the parser.
   * Returns an array of complete message strings parsed from the
   * accumulated buffer.
   */
  feed(chunk: Buffer): string[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: string[] = [];

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.expectedLength === null) {
        // Look for the header separator \r\n\r\n
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;

        // Parse the Content-Length header
        const headerStr = this.buffer.subarray(0, headerEnd).toString('ascii');
        const match = /^Content-Length:\s*(\d+)/i.exec(headerStr);
        if (!match) {
          // Invalid header — skip to after the separator and try again
          this.buffer = this.buffer.subarray(headerEnd + 4);
          continue;
        }

        this.expectedLength = parseInt(match[1]!, 10);
        this.buffer = this.buffer.subarray(headerEnd + 4);
      }

      // Check if we have enough bytes for the message body
      if (this.buffer.length < this.expectedLength) break;

      // Extract the message
      const messageBytes = this.buffer.subarray(0, this.expectedLength);
      messages.push(messageBytes.toString('utf-8'));

      // Advance past the message
      this.buffer = this.buffer.subarray(this.expectedLength);
      this.expectedLength = null;
    }

    return messages;
  }

  /** Reset the parser state (useful for testing). */
  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.expectedLength = null;
  }
}

// ─── Content-Length Frame Encoder ───────────────────────────────

/**
 * Encodes a JSON object into an LSP-style Content-Length framed
 * message suitable for writing to stdout.
 */
export function encodeFrame(payload: unknown): Buffer {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, 'utf-8');
  const header = `Content-Length: ${body.length}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, 'ascii'), body]);
}

// ─── ACP Server ─────────────────────────────────────────────────

export interface ACPServerOptions {
  /** Readable stream for incoming messages (default: process.stdin). */
  stdin?: NodeJS.ReadableStream;
  /** Writable stream for outgoing messages (default: process.stdout). */
  stdout?: NodeJS.WritableStream;
  /** Optional session ID generator (for testing). */
  generateSessionId?: () => string;
}

/**
 * The ACP stdio server. Reads JSON-RPC requests from stdin using
 * Content-Length framing and writes JSON-RPC responses to stdout.
 *
 * Session lifecycle:
 *   idle → active (via agent/start)
 *   active → processing (via agent/message, auto-transitions back)
 *   active → stopped (via agent/stop)
 *   processing → stopped (via agent/stop)
 *
 * Requirement 20.8: Reuses the same Tool_System and Authorization_Pipeline
 * paths — the server itself contains no independent orchestration logic.
 * Requirement 20.9: ACP transport code contains no orchestration logic.
 */
export class ACPStdioServer {
  private readonly stdin: NodeJS.ReadableStream;
  private readonly stdout: NodeJS.WritableStream;
  private readonly generateSessionId: () => string;
  private readonly parser: ContentLengthFrameParser;
  private session: SessionState | null = null;
  private running = false;
  private stdinDataHandler: ((chunk: Buffer) => void) | null = null;
  private stdinEndHandler: (() => void) | null = null;

  constructor(options: ACPServerOptions = {}) {
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
    this.generateSessionId = options.generateSessionId ?? (() => randomUUID());
    this.parser = new ContentLengthFrameParser();
  }

  /**
   * Start listening for incoming JSON-RPC messages on stdin.
   * The server runs until stdin closes or `stop()` is called.
   */
  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.running = true;

    return new Promise<void>((resolve) => {
      this.stdinDataHandler = (chunk: Buffer) => {
        const messages = this.parser.feed(chunk);
        for (const raw of messages) {
          this.handleRawMessage(raw);
        }
      };

      this.stdinEndHandler = () => {
        this.running = false;
        resolve();
      };

      this.stdin.on('data', this.stdinDataHandler);
      this.stdin.on('end', this.stdinEndHandler);
    });
  }

  /**
   * Stop the server and clean up listeners.
   */
  stop(): void {
    this.running = false;
    if (this.stdinDataHandler) {
      this.stdin.removeListener('data', this.stdinDataHandler);
      this.stdinDataHandler = null;
    }
    if (this.stdinEndHandler) {
      this.stdin.removeListener('end', this.stdinEndHandler);
      this.stdinEndHandler = null;
    }
  }

  /** Whether the server is currently running. */
  isRunning(): boolean {
    return this.running;
  }

  /** Get a snapshot of the current session state (for testing). */
  getSession(): SessionState | null {
    return this.session ? { ...this.session } : null;
  }

  // ─── Message Routing ────────────────────────────────────────

  private handleRawMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.sendError(null, JSON_RPC_ERRORS.PARSE_ERROR, 'Parse error');
      return;
    }

    // Validate JSON-RPC structure
    if (!isJsonRpcRequest(parsed)) {
      this.sendError(
        extractId(parsed),
        JSON_RPC_ERRORS.INVALID_REQUEST,
        'Invalid Request',
      );
      return;
    }

    const request = parsed as JsonRpcRequest;

    switch (request.method) {
      case 'agent/start':
        this.handleAgentStart(request);
        break;
      case 'agent/message':
        this.handleAgentMessage(request);
        break;
      case 'agent/status':
        this.handleAgentStatus(request);
        break;
      case 'agent/stop':
        this.handleAgentStop(request);
        break;
      default:
        this.sendError(
          request.id,
          JSON_RPC_ERRORS.METHOD_NOT_FOUND,
          `Method not found: ${request.method}`,
        );
    }
  }

  // ─── Method Handlers ────────────────────────────────────────

  private handleAgentStart(request: JsonRpcRequest): void {
    if (this.session && this.session.status !== 'stopped') {
      this.sendError(
        request.id,
        JSON_RPC_ERRORS.SESSION_ALREADY_STARTED,
        'Session already active',
      );
      return;
    }

    const params = request.params ?? {};
    const projectDir = typeof params['projectDir'] === 'string'
      ? params['projectDir']
      : process.cwd();

    this.session = {
      sessionId: this.generateSessionId(),
      status: 'active',
      projectDir,
      createdAt: new Date().toISOString(),
      messageCount: 0,
    };

    this.sendResult(request.id, {
      sessionId: this.session.sessionId,
      status: this.session.status,
    });
  }

  private handleAgentMessage(request: JsonRpcRequest): void {
    if (!this.session || this.session.status === 'stopped') {
      this.sendError(
        request.id,
        this.session ? JSON_RPC_ERRORS.SESSION_STOPPED : JSON_RPC_ERRORS.SESSION_NOT_STARTED,
        this.session ? 'Session has been stopped' : 'No active session. Call agent/start first.',
      );
      return;
    }

    if (this.session.status === 'idle') {
      this.sendError(
        request.id,
        JSON_RPC_ERRORS.SESSION_NOT_STARTED,
        'No active session. Call agent/start first.',
      );
      return;
    }

    const params = request.params ?? {};
    const content = typeof params['content'] === 'string' ? params['content'] : '';

    if (content.length === 0) {
      this.sendError(
        request.id,
        JSON_RPC_ERRORS.INVALID_PARAMS,
        'Missing or empty "content" parameter',
      );
      return;
    }

    // Track message and transition to processing momentarily
    this.session.messageCount++;
    this.session.status = 'processing';

    // In the full implementation, this would route to
    // AgentLoopController.submit() and stream results back.
    // For now, acknowledge the message and return to active.
    const messageId = randomUUID();

    // Emit notification for the message event
    this.sendNotification('agent/event', {
      type: 'message_received',
      messageId,
      sessionId: this.session.sessionId,
    });

    // Return to active after "processing"
    this.session.status = 'active';

    this.sendResult(request.id, {
      messageId,
      status: 'received',
      sessionId: this.session.sessionId,
    });
  }

  private handleAgentStatus(request: JsonRpcRequest): void {
    if (!this.session) {
      this.sendResult(request.id, {
        status: 'idle',
        sessionId: null,
      });
      return;
    }

    this.sendResult(request.id, {
      sessionId: this.session.sessionId,
      status: this.session.status,
      projectDir: this.session.projectDir,
      createdAt: this.session.createdAt,
      messageCount: this.session.messageCount,
    });
  }

  private handleAgentStop(request: JsonRpcRequest): void {
    if (!this.session || this.session.status === 'stopped') {
      this.sendError(
        request.id,
        this.session ? JSON_RPC_ERRORS.SESSION_STOPPED : JSON_RPC_ERRORS.SESSION_NOT_STARTED,
        this.session ? 'Session already stopped' : 'No active session to stop.',
      );
      return;
    }

    const sessionId = this.session.sessionId;
    this.session.status = 'stopped';

    this.sendResult(request.id, {
      sessionId,
      status: 'stopped',
    });
  }

  // ─── Response Helpers ───────────────────────────────────────

  private sendResult(id: number | string | null, result: unknown): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: id ?? 0,
      result,
    };
    this.writeFrame(response);
  }

  private sendError(id: number | string | null, code: number, message: string, data?: unknown): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: id ?? 0,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    };
    this.writeFrame(response);
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.writeFrame(notification);
  }

  private writeFrame(payload: unknown): void {
    const frame = encodeFrame(payload);
    this.stdout.write(frame);
  }
}

// ─── Validation Helpers ─────────────────────────────────────────

function isJsonRpcRequest(obj: unknown): obj is JsonRpcRequest {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false;
  const r = obj as Record<string, unknown>;
  return (
    r['jsonrpc'] === '2.0' &&
    (typeof r['id'] === 'number' || typeof r['id'] === 'string') &&
    typeof r['method'] === 'string'
  );
}

function extractId(obj: unknown): number | string | null {
  if (typeof obj !== 'object' || obj === null) return null;
  const r = obj as Record<string, unknown>;
  if (typeof r['id'] === 'number' || typeof r['id'] === 'string') return r['id'];
  return null;
}

// ─── CLI Entrypoint ─────────────────────────────────────────────

/**
 * Start the ACP stdio server. Called by the `neuronest agent stdio`
 * CLI subcommand. Returns a promise that resolves when stdin closes
 * or the server is stopped.
 *
 * Validates: Requirements 16.1, 20.1
 */
export async function startACPStdioServer(options?: ACPServerOptions): Promise<0> {
  const server = new ACPStdioServer(options);
  await server.start();
  return 0;
}
