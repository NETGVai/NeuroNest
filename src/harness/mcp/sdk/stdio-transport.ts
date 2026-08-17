/**
 * Stdio Transport — Internal Protocol Layer
 *
 * Handles JSON-RPC over stdio for MCP client connections. This module is
 * INTERNAL to the SDK boundary and its types do NOT leak into the typed
 * client SDK public interface.
 *
 * Requirements: 25.1, 32.1
 */

import { z } from 'zod';
import {
  JsonRpcRequestSchema,
  JsonRpcResponseSchema,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './json-rpc-envelope';
import {
  McpErrorCode,
  type McpStructuredError,
} from './protocol-errors';

// ─── Transport Types (Internal Only) ────────────────────────────

export interface StdioTransportOptions {
  /** Timeout for individual RPC calls in milliseconds */
  callTimeout?: number;
  /** Handler for progress notifications */
  onProgress?: (method: string, params: unknown) => void;
  /** Handler for log notifications */
  onLog?: (level: string, message: string) => void;
}

export interface PendingCall {
  resolve: (response: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Simulated stdio transport for the client SDK.
 * In production this would manage actual child_process stdio pipes.
 * Here it provides the typed call interface that the SDK clients use.
 */
export class StdioTransport {
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingCall>();
  private callTimeout: number;
  private connected = false;
  private onProgress?: (method: string, params: unknown) => void;
  private onLog?: (level: string, message: string) => void;

  /** Injected send function for testing/integration */
  private sendFn: ((request: JsonRpcRequest) => void) | null = null;

  constructor(options: StdioTransportOptions = {}) {
    this.callTimeout = options.callTimeout ?? 30_000;
    this.onProgress = options.onProgress;
    this.onLog = options.onLog;
  }

  /** Connect with an injected send function */
  connect(sendFn: (request: JsonRpcRequest) => void): void {
    this.sendFn = sendFn;
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
    this.sendFn = null;
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error('Transport disconnected'));
      this.pending.delete(id);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Send a JSON-RPC request and await the response.
   * Returns the result or throws a typed MCP error.
   */
  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.connected || !this.sendFn) {
      throw new McpTransportError('Transport is not connected', McpErrorCode.InternalError);
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = this.callTimeout > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new McpTransportError(
              `Call to '${method}' timed out after ${this.callTimeout}ms`,
              McpErrorCode.InternalError,
            ));
          }, this.callTimeout)
        : null;

      this.pending.set(id, { resolve: (resp) => resolve(resp), reject, timer });
      this.sendFn!(request);
    });
  }

  /**
   * Handle an incoming JSON-RPC response from the server.
   */
  handleResponse(raw: unknown): void {
    const parsed = JsonRpcResponseSchema.safeParse(raw);
    if (!parsed.success) return;

    const response = parsed.data;
    const pending = this.pending.get(response.id);
    if (!pending) return;

    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(response.id);

    if (response.error) {
      pending.reject(new McpTransportError(
        response.error.message,
        response.error.code,
        response.error.data as McpStructuredError['data'],
      ));
    } else {
      pending.resolve(response.result);
    }
  }

  /**
   * Handle an incoming notification (progress, log, etc.).
   */
  handleNotification(method: string, params: unknown): void {
    if (method === 'notifications/progress' && this.onProgress) {
      this.onProgress(method, params);
    } else if (method === 'notifications/message' && this.onLog) {
      const p = params as Record<string, unknown> | undefined;
      this.onLog(
        String(p?.['level'] ?? 'info'),
        String(p?.['data'] ?? ''),
      );
    }
  }
}

// ─── Transport Error ────────────────────────────────────────────

export class McpTransportError extends Error {
  readonly code: number;
  readonly data?: McpStructuredError['data'];

  constructor(message: string, code: number, data?: McpStructuredError['data']) {
    super(message);
    this.name = 'McpTransportError';
    this.code = code;
    this.data = data;
  }
}
