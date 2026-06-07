/**
 * PythonBridge — JSON-RPC over stdio subprocess management.
 *
 * Stub implementation using in-memory mock (no actual Python subprocess).
 * Provides start, stop, isRunning, call, notify methods with error handling
 * and crash recovery callbacks.
 *
 * Requirements: 22.2
 */

import { randomUUID } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────

export interface PythonBridgeConfig {
  pythonPath: string;
  scriptPath: string;
  virtualEnvPath?: string;
  env?: Record<string, string>;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string;
  method: string;
  params: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ─── PythonBridge ───────────────────────────────────────────────

export class PythonBridge {
  private running = false;
  private config: PythonBridgeConfig | null = null;
  private errorCallbacks: Array<(error: Error) => void> = [];
  private crashCallbacks: Array<() => void> = [];
  private mockResponses = new Map<string, unknown>();
  private callLog: JsonRpcRequest[] = [];

  /**
   * Start the Python bridge subprocess (stub: sets running flag).
   */
  async start(config: PythonBridgeConfig): Promise<void> {
    if (this.running) {
      throw new Error('PythonBridge is already running');
    }
    if (!config.pythonPath) {
      throw new Error('pythonPath is required');
    }
    if (!config.scriptPath) {
      throw new Error('scriptPath is required');
    }
    this.config = config;
    this.running = true;
  }

  /**
   * Stop the Python bridge subprocess.
   */
  stop(): void {
    this.running = false;
    this.config = null;
  }

  /**
   * Check if the bridge subprocess is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Send a JSON-RPC call and wait for a response.
   */
  async call(method: string, params: unknown): Promise<unknown> {
    if (!this.running) {
      throw new Error('PythonBridge is not running');
    }

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: randomUUID(),
      method,
      params,
    };
    this.callLog.push(request);

    // Check for mock responses
    if (this.mockResponses.has(method)) {
      return this.mockResponses.get(method);
    }

    // Stub: return a default response
    return { status: 'ok', method, params };
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  notify(method: string, params: unknown): void {
    if (!this.running) {
      throw new Error('PythonBridge is not running');
    }

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.callLog.push(request);
  }

  /**
   * Register an error callback.
   */
  onError(callback: (error: Error) => void): void {
    this.errorCallbacks.push(callback);
  }

  /**
   * Register a crash recovery callback.
   */
  onCrash(callback: () => void): void {
    this.crashCallbacks.push(callback);
  }

  /**
   * Simulate a crash for testing — triggers crash callbacks and stops.
   */
  simulateCrash(): void {
    this.running = false;
    for (const cb of this.crashCallbacks) {
      cb();
    }
  }

  /**
   * Simulate an error for testing — triggers error callbacks.
   */
  simulateError(error: Error): void {
    for (const cb of this.errorCallbacks) {
      cb(error);
    }
  }

  /**
   * Get the current config (for testing).
   */
  getConfig(): PythonBridgeConfig | null {
    return this.config;
  }

  /**
   * Get the call log (for testing).
   */
  getCallLog(): JsonRpcRequest[] {
    return [...this.callLog];
  }

  /**
   * Set a mock response for a method (for testing).
   */
  setMockResponse(method: string, response: unknown): void {
    this.mockResponses.set(method, response);
  }
}
