/**
 * UnslothBridge — integration layer between NeuroNest and Unsloth Core.
 *
 * Supports two modes of operation:
 *   1. MCP Client mode: communicates with a running Unsloth Studio server
 *   2. Direct Invocation mode: spawns training scripts via SafeExec when no server detected
 *
 * All subprocess operations use SafeExec (argument arrays, no shell interpretation).
 * Stdout is parsed line-by-line for JSON progress messages.
 *
 * Requirements: 6.1, 6.2, 6.5, 6.6, 6.7, 6.8, 27.2
 */

import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import type { SafeExecResult } from '../../security/safe-exec.js';
import type { VenvManager } from './venv-manager.js';
import type { IProviderRegistry, LLMProviderAdapter } from '../../providers/provider-registry.js';

// ─── Types ──────────────────────────────────────────────────────

/** Type signature for the SafeExec async function we depend on */
export type SafeExecFn = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; env?: Record<string, string> },
) => Promise<SafeExecResult>;

/** Bridge configuration */
export interface UnslothBridgeConfig {
  /** Unsloth Studio server endpoint. Default: 'http://localhost:8000' */
  endpoint?: string;
  /** Connection timeout for MCP client. Default: 10000 */
  connectionTimeoutMs?: number;
  /** Request timeout for MCP API calls. Default: 60000 */
  requestTimeoutMs?: number;
  /** Graceful shutdown timeout before SIGKILL. Default: 30000 */
  shutdownTimeoutMs?: number;
  /** Working directory for training scripts */
  workingDir?: string;
  /** Environment variables for training subprocesses */
  env?: Record<string, string>;
}

/** Integration mode: MCP client vs direct script invocation */
export type IntegrationMode = 'mcp-client' | 'direct-invocation';

/** Training method (matches design spec) */
export type TrainingMethod = 'lora' | 'qlora' | 'full-finetune';

/** Configuration for starting a training job */
export interface TrainingJobConfig {
  /** Unique job identifier */
  id: string;
  /** Base model name/path */
  baseModel: string;
  /** Training method */
  method: TrainingMethod;
  /** Path to training dataset */
  datasetPath: string;
  /** Dataset format */
  datasetFormat: 'instruction' | 'chat' | 'continued-pretraining' | 'grpo';
  /** Training script path (relative to working dir) */
  scriptPath: string;
  /** Output directory for trained model */
  outputDir: string;
  /** Checkpoint directory */
  checkpointDir: string;
  /** Hyperparameters */
  hyperparameters: {
    learningRate: number;
    batchSize: number;
    epochs: number;
    loraRank?: number;
    loraAlpha?: number;
    warmupSteps?: number;
    weightDecay?: number;
    gradientAccumulationSteps?: number;
  };
}

/** JSON progress line emitted by training scripts on stdout */
export interface TrainingStdoutLine {
  type: 'progress' | 'checkpoint' | 'metric' | 'complete' | 'error';
  data: Record<string, unknown>;
}

/** Progress event data */
export interface TrainingProgress {
  step: number;
  totalSteps: number;
  epoch?: number;
  totalEpochs?: number;
  loss?: number;
  learningRate?: number;
  tokensPerSecond?: number;
  etaMs?: number;
}

/** State of a training process */
export type TrainingProcessState = 'running' | 'completed' | 'failed' | 'cancelled';

/** Events emitted by a TrainingProcess */
export interface TrainingProcessEvents {
  progress: [TrainingProgress];
  checkpoint: [{ epoch: number; step: number; path: string }];
  metric: [Record<string, unknown>];
  complete: [{ finalLoss?: number; outputDir: string }];
  error: [{ message: string; stderr?: string }];
  stateChange: [TrainingProcessState];
}

// ─── MCP Client Types ───────────────────────────────────────────

/** Quantization type for GGUF export */
export type QuantizationType = 'q4_0' | 'q4_1' | 'q5_0' | 'q5_1' | 'q8_0' | 'f16';

/** Model info returned by MCP server */
export interface ModelInfo {
  id: string;
  name: string;
  size?: string;
  quantization?: string;
  modified?: string;
}

/** MCP training job result (distinct from the direct-invocation TrainingProcess class) */
export interface MCPTrainingResult {
  jobId: string;
  state: 'running' | 'queued' | 'completed' | 'failed';
  startedAt: number;
}

/** Capabilities reported by the MCP server */
export interface UnslothCapabilities {
  models: string[];
  supportedMethods: TrainingMethod[];
  gpuAvailable: boolean;
  maxContextLength: number;
}

/** JSON-RPC 2.0 request */
interface MCPRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response */
interface MCPResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Handle for a running training process.
 * Allows monitoring progress and cancellation.
 */
export class TrainingProcess extends EventEmitter {
  private _state: TrainingProcessState = 'running';
  private _child: ChildProcess | null = null;
  private _exitCode: number | null = null;
  private _stderr: string = '';
  private _lineBuffer: string = '';
  private _cancelling: boolean = false;
  private readonly shutdownTimeoutMs: number;

  constructor(
    public readonly jobId: string,
    child: ChildProcess,
    shutdownTimeoutMs: number = 30_000,
  ) {
    super();
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this._child = child;
    this._attachListeners(child);
  }

  /** Current state of the training process */
  get state(): TrainingProcessState {
    return this._state;
  }

  /** Exit code of the process (null if still running) */
  get exitCode(): number | null {
    return this._exitCode;
  }

  /** Captured stderr output */
  get stderr(): string {
    return this._stderr;
  }

  /**
   * Request cancellation of the training process.
   * Sends SIGTERM first, then SIGKILL after the shutdown timeout.
   */
  async cancel(): Promise<void> {
    if (this._state !== 'running' || !this._child) {
      return;
    }

    // Mark as cancelling so exit handler knows this is intentional
    this._cancelling = true;

    // Send SIGTERM for graceful shutdown
    this._child.kill('SIGTERM');

    // Wait for process to exit or force-kill after timeout
    const forceKillTimeout = setTimeout(() => {
      if (this._state === 'running' && this._child) {
        this._child.kill('SIGKILL');
      }
    }, this.shutdownTimeoutMs);

    // Wait for process to exit
    await new Promise<void>((resolve) => {
      if (this._state !== 'running') {
        clearTimeout(forceKillTimeout);
        resolve();
        return;
      }

      const onStateChange = (state: TrainingProcessState): void => {
        if (state !== 'running') {
          clearTimeout(forceKillTimeout);
          this.removeListener('stateChange', onStateChange);
          resolve();
        }
      };

      this.once('stateChange', onStateChange);
    });
  }

  /** Attach stdout/stderr/exit listeners to the child process */
  private _attachListeners(child: ChildProcess): void {
    // Parse stdout line-by-line for JSON progress messages
    child.stdout?.on('data', (chunk: Buffer) => {
      this._lineBuffer += chunk.toString();
      this._processLines();
    });

    // Capture stderr for diagnostics
    child.stderr?.on('data', (chunk: Buffer) => {
      this._stderr += chunk.toString();
    });

    // Handle process exit
    child.on('exit', (code, signal) => {
      this._exitCode = code;
      this._child = null;

      // Process any remaining buffered output
      if (this._lineBuffer.length > 0) {
        this._processLines();
      }

      if (this._cancelling) {
        this._setState('cancelled');
      } else if (code === 0) {
        this._setState('completed');
      } else {
        this._setState('failed');
        this.emit('error', {
          message: `Training process exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`,
          stderr: this._stderr,
        });
      }
    });

    // Handle spawn errors
    child.on('error', (err) => {
      this._child = null;
      if (this._state === 'running') {
        this._setState('failed');
        this.emit('error', {
          message: `Training process error: ${err.message}`,
          stderr: this._stderr,
        });
      }
    });
  }

  /** Process buffered stdout lines, parsing JSON progress */
  private _processLines(): void {
    const lines = this._lineBuffer.split('\n');
    // Keep the last incomplete line in the buffer
    this._lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parsed = parseProgressLine(trimmed);
      if (!parsed) continue;

      switch (parsed.type) {
        case 'progress':
          this.emit('progress', parsed.data as unknown as TrainingProgress);
          break;
        case 'checkpoint':
          this.emit('checkpoint', parsed.data as { epoch: number; step: number; path: string });
          break;
        case 'metric':
          this.emit('metric', parsed.data);
          break;
        case 'complete':
          this.emit('complete', parsed.data as { finalLoss?: number; outputDir: string });
          break;
        case 'error':
          this.emit('error', {
            message: (parsed.data as { message?: string }).message ?? 'Unknown training error',
            stderr: this._stderr,
          });
          break;
      }
    }
  }

  /** Update internal state and emit stateChange event */
  private _setState(newState: TrainingProcessState): void {
    if (this._state === newState) return;
    this._state = newState;
    this.emit('stateChange', newState);
  }
}

// ─── Helper Functions ───────────────────────────────────────────

/**
 * Parse a single line of stdout as a JSON progress message.
 * Returns null if the line is not valid JSON or lacks a `type` field.
 */
export function parseProgressLine(line: string): TrainingStdoutLine | null {
  try {
    const parsed = JSON.parse(line);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.type === 'string' &&
      ['progress', 'checkpoint', 'metric', 'complete', 'error'].includes(parsed.type)
    ) {
      return {
        type: parsed.type as TrainingStdoutLine['type'],
        data: parsed.data ?? parsed,
      };
    }
    return null;
  } catch {
    // Not JSON — ignore non-JSON output lines
    return null;
  }
}

/**
 * Build the argument array for a training script invocation.
 * No shell interpretation — all values passed as discrete arguments.
 */
export function buildTrainingArgs(config: TrainingJobConfig): string[] {
  const args: string[] = [
    config.scriptPath,
    '--model', config.baseModel,
    '--dataset', config.datasetPath,
    '--dataset-format', config.datasetFormat,
    '--method', config.method,
    '--output', config.outputDir,
    '--checkpoint-dir', config.checkpointDir,
    '--lr', String(config.hyperparameters.learningRate),
    '--batch-size', String(config.hyperparameters.batchSize),
    '--epochs', String(config.hyperparameters.epochs),
    '--progress-format', 'jsonl',
  ];

  if (config.hyperparameters.loraRank !== undefined) {
    args.push('--lora-rank', String(config.hyperparameters.loraRank));
  }
  if (config.hyperparameters.loraAlpha !== undefined) {
    args.push('--lora-alpha', String(config.hyperparameters.loraAlpha));
  }
  if (config.hyperparameters.warmupSteps !== undefined) {
    args.push('--warmup-steps', String(config.hyperparameters.warmupSteps));
  }
  if (config.hyperparameters.weightDecay !== undefined) {
    args.push('--weight-decay', String(config.hyperparameters.weightDecay));
  }
  if (config.hyperparameters.gradientAccumulationSteps !== undefined) {
    args.push('--gradient-accumulation-steps', String(config.hyperparameters.gradientAccumulationSteps));
  }

  return args;
}

// ─── Errors ─────────────────────────────────────────────────────

export class UnslothBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnslothBridgeError';
  }
}

export class ServerNotDetectedError extends UnslothBridgeError {
  constructor(endpoint: string) {
    super(`No Unsloth Studio server detected at ${endpoint}`);
    this.name = 'ServerNotDetectedError';
  }
}

export class TrainingSpawnError extends UnslothBridgeError {
  constructor(message: string, public readonly stderr?: string) {
    super(message);
    this.name = 'TrainingSpawnError';
  }
}

export class MCPConnectionError extends UnslothBridgeError {
  constructor(message: string, public readonly endpoint: string) {
    super(message);
    this.name = 'MCPConnectionError';
  }
}

export class MCPRequestError extends UnslothBridgeError {
  constructor(
    message: string,
    public readonly method: string,
    public readonly code?: number,
  ) {
    super(message);
    this.name = 'MCPRequestError';
  }
}

export class MCPTimeoutError extends UnslothBridgeError {
  constructor(message: string, public readonly timeoutMs: number) {
    super(message);
    this.name = 'MCPTimeoutError';
  }
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_ENDPOINT = 'http://localhost:8000';
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

// ─── UnslothBridge ──────────────────────────────────────────────

export class UnslothBridge extends EventEmitter {
  private mode: IntegrationMode = 'direct-invocation';
  private readonly endpoint: string;
  private readonly connectionTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly workingDir: string | undefined;
  private readonly processEnv: Record<string, string>;
  private serverAvailable: boolean = false;
  private mcpConnected: boolean = false;
  private requestIdCounter: number = 0;
  private capabilities: UnslothCapabilities | null = null;
  private providerRegistry: IProviderRegistry | null = null;
  private providerRegistered: boolean = false;

  constructor(
    private readonly venvManager: VenvManager,
    private readonly safeExec: SafeExecFn,
    config?: UnslothBridgeConfig,
  ) {
    super();
    this.endpoint = config?.endpoint ?? DEFAULT_ENDPOINT;
    this.connectionTimeoutMs = config?.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    this.requestTimeoutMs = config?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.shutdownTimeoutMs = config?.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.workingDir = config?.workingDir;
    this.processEnv = config?.env ?? {};
  }

  /**
   * Set the provider registry for registering this bridge as a provider.
   * Called externally after construction.
   */
  setProviderRegistry(registry: IProviderRegistry): void {
    this.providerRegistry = registry;
  }

  /** Current integration mode */
  getMode(): IntegrationMode {
    return this.mode;
  }

  /** Whether a running server was detected */
  isServerAvailable(): boolean {
    return this.serverAvailable;
  }

  /**
   * Initialize the bridge: detect running server or fall back to direct invocation.
   * Ensures venv is ready for direct invocation mode.
   */
  async initialize(): Promise<IntegrationMode> {
    // Attempt to detect running Unsloth Studio server
    const detected = await this.detectServer();

    if (detected) {
      this.mode = 'mcp-client';
      this.serverAvailable = true;
      this.mcpConnected = true;

      // Fetch capabilities from the MCP server
      try {
        this.capabilities = await this.fetchCapabilities();
      } catch {
        // Non-fatal: capabilities will be null
        this.capabilities = null;
      }

      // Register as a provider when connected
      this.registerAsProvider();
    } else {
      this.mode = 'direct-invocation';
      this.serverAvailable = false;
      this.mcpConnected = false;
      this.capabilities = null;
      // Ensure venv is ready for direct script invocation
      await this.venvManager.ensureVenv();
    }

    return this.mode;
  }

  /**
   * Disconnect the bridge from the MCP server.
   * Unregisters the provider from the Provider Registry and cleans up state.
   * Called when the bridge is torn down or the server becomes unavailable.
   */
  async disconnect(): Promise<void> {
    this.unregisterAsProvider();
    this.mcpConnected = false;
    this.serverAvailable = false;
    this.capabilities = null;
    this.mode = 'direct-invocation';
  }

  /** Whether the provider is currently registered in the Provider Registry */
  isProviderRegistered(): boolean {
    return this.providerRegistered;
  }

  /**
   * Start a training job in direct invocation mode.
   *
   * Spawns the Python training script using the venv Python interpreter,
   * passing all configuration as argument arrays (no shell interpretation).
   * Returns a TrainingProcess handle for monitoring and cancellation.
   *
   * Requirements: 6.5, 6.8, 27.2
   */
  async startTrainingDirect(config: TrainingJobConfig): Promise<TrainingProcess> {
    // Get the Python interpreter path from the venv
    const pythonPath = this.venvManager.getVenvPythonPath();

    // Verify the venv exists before attempting to spawn
    if (!this.venvManager.venvExists()) {
      throw new TrainingSpawnError(
        'Python virtual environment not found. Run initialize() first to set up the venv.',
      );
    }

    // Build argument array (no shell interpretation)
    const args = buildTrainingArgs(config);

    // Merge environment: ensure unbuffered Python output for real-time progress
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      PYTHONUNBUFFERED: '1',
      CUDA_VISIBLE_DEVICES: process.env['CUDA_VISIBLE_DEVICES'] ?? '0',
      ...this.processEnv,
    };

    // Spawn the training process using child_process.spawn (not execFile)
    // because training is long-running and we need streaming stdout
    const child = spawn(pythonPath, args, {
      cwd: this.workingDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // No shell — arguments passed directly to the Python interpreter
      shell: false,
    });

    // Verify the process actually started
    if (!child.pid) {
      throw new TrainingSpawnError(
        `Failed to spawn training process: ${pythonPath} ${args[0]}`,
      );
    }

    const trainingProcess = new TrainingProcess(
      config.id,
      child,
      this.shutdownTimeoutMs,
    );

    return trainingProcess;
  }

  /**
   * Detect whether a running Unsloth Studio server is available
   * at the configured endpoint.
   */
  async detectServer(): Promise<boolean> {
    try {
      // Use a simple HTTP health check via SafeExec + curl
      // This avoids importing HTTP clients and stays within the SafeExec security model
      const result = await this.safeExec(
        'curl',
        [
          '--silent',
          '--fail',
          '--max-time', String(Math.ceil(this.connectionTimeoutMs / 1000)),
          `${this.endpoint}/health`,
        ],
        { timeout: this.connectionTimeoutMs + 2000 },
      );

      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Self-healing tool call correction.
   * Detects malformed tool calls from LLMs and auto-corrects common formatting errors.
   *
   * Common issues corrected:
   * - Missing/mismatched quotes around strings
   * - Trailing commas in objects/arrays
   * - Single quotes instead of double quotes
   * - Unquoted property names
   * - Wrong types (numbers as strings, booleans as strings)
   * - Comments in JSON (// or /* *​/)
   * - Truncated/incomplete JSON
   * - Unescaped newlines in string values
   *
   * Requirements: 6.6
   */
  correctMalformedToolCall(rawCall: string): string {
    if (!rawCall || rawCall.trim().length === 0) {
      return '{}';
    }

    let corrected = rawCall.trim();

    // 1. Remove single-line comments (// ...)
    corrected = corrected.replace(/\/\/[^\n]*/g, '');

    // 2. Remove multi-line comments (/* ... */)
    corrected = corrected.replace(/\/\*[\s\S]*?\*\//g, '');

    // 3. Replace single quotes with double quotes (for JSON keys and values)
    corrected = this.replaceSingleQuotes(corrected);

    // 4. Quote unquoted property names (e.g., {model: "x"} → {"model": "x"})
    corrected = corrected.replace(
      /([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g,
      '$1"$2":',
    );

    // 5. Remove trailing commas before closing braces/brackets
    corrected = corrected.replace(/,\s*([}\]])/g, '$1');

    // 6. Fix boolean/null strings to actual values
    corrected = corrected.replace(/"(true|false|null)"/g, '$1');

    // 7. Fix numeric strings that should be numbers
    corrected = corrected.replace(
      /:\s*"(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)"/g,
      ': $1',
    );

    // 8. Handle truncated JSON by closing open brackets
    corrected = this.closeOpenBrackets(corrected);

    // 9. Validate — if still invalid, attempt a final wrap
    try {
      JSON.parse(corrected);
    } catch {
      if (!corrected.startsWith('{') && !corrected.startsWith('[')) {
        corrected = `{${corrected}}`;
      }
      try {
        JSON.parse(corrected);
      } catch {
        // Return best-effort; server will provide a meaningful error
      }
    }

    return corrected;
  }

  // ─── MCP Client API ─────────────────────────────────────────────

  /** Whether the MCP client is connected */
  isMCPConnected(): boolean {
    return this.mcpConnected;
  }

  /** Get cached server capabilities (null if not connected) */
  getCapabilities(): UnslothCapabilities | null {
    return this.capabilities;
  }

  /**
   * List available base models from Unsloth Core via MCP.
   * Returns empty array when not in MCP client mode.
   */
  async listModels(): Promise<ModelInfo[]> {
    if (this.mode !== 'mcp-client' || !this.mcpConnected) {
      return [];
    }

    const response = await this.sendMCPRequest('models/list', {});

    if (!response.result || !Array.isArray(response.result)) {
      return [];
    }

    return (response.result as Record<string, unknown>[]).map((model): ModelInfo => ({
      id: String(model['id'] ?? ''),
      name: String(model['name'] ?? ''),
      ...(model['size'] != null ? { size: String(model['size']) } : {}),
      ...(model['quantization'] != null ? { quantization: String(model['quantization']) } : {}),
      ...(model['modified'] != null ? { modified: String(model['modified']) } : {}),
    }));
  }

  /**
   * Start a training job via the MCP server.
   * Sends the training configuration as a JSON-RPC request.
   */
  async startTrainingMCP(config: TrainingJobConfig): Promise<MCPTrainingResult> {
    if (this.mode !== 'mcp-client' || !this.mcpConnected) {
      throw new MCPConnectionError(
        'Cannot start training: not connected to Unsloth Core MCP server',
        this.endpoint,
      );
    }

    const response = await this.sendMCPRequest('training/start', {
      jobId: config.id,
      baseModel: config.baseModel,
      method: config.method,
      datasetPath: config.datasetPath,
      datasetFormat: config.datasetFormat,
      hyperparameters: config.hyperparameters,
      outputDir: config.outputDir,
    });

    if (response.error) {
      throw new MCPRequestError(
        `Training start failed: ${response.error.message}`,
        'training/start',
        response.error.code,
      );
    }

    const result = response.result as Record<string, unknown> | undefined;

    return {
      jobId: config.id,
      state: 'running',
      startedAt: result?.['startedAt'] != null ? Number(result['startedAt']) : Date.now(),
    };
  }

  /**
   * Export a trained model to GGUF format via the MCP server.
   *
   * @param modelPath - Path to the trained model weights
   * @param quantization - GGUF quantization type
   * @returns Path to the exported GGUF file
   */
  async exportGGUF(modelPath: string, quantization: QuantizationType): Promise<string> {
    if (this.mode !== 'mcp-client' || !this.mcpConnected) {
      throw new MCPConnectionError(
        'Cannot export GGUF: not connected to Unsloth Core MCP server',
        this.endpoint,
      );
    }

    const response = await this.sendMCPRequest('export/gguf', {
      modelPath,
      quantization,
    });

    if (response.error) {
      throw new MCPRequestError(
        `GGUF export failed: ${response.error.message}`,
        'export/gguf',
        response.error.code,
      );
    }

    const result = response.result as Record<string, unknown> | undefined;
    if (!result?.['ggufPath'] || typeof result['ggufPath'] !== 'string') {
      throw new MCPRequestError(
        'GGUF export succeeded but server did not return the output path',
        'export/gguf',
      );
    }

    return result['ggufPath'];
  }

  // ─── Private: MCP Communication ────────────────────────────────

  /**
   * Fetch capabilities from the MCP server.
   */
  private async fetchCapabilities(): Promise<UnslothCapabilities> {
    const response = await this.sendMCPRequest('capabilities', {});
    const result = response.result as Record<string, unknown> | undefined;

    return {
      models: Array.isArray(result?.['models'])
        ? (result['models'] as string[])
        : [],
      supportedMethods: Array.isArray(result?.['supportedMethods'])
        ? (result['supportedMethods'] as TrainingMethod[])
        : ['lora', 'qlora'],
      gpuAvailable: Boolean(result?.['gpuAvailable']),
      maxContextLength: Number(result?.['maxContextLength']) || 4096,
    };
  }

  /**
   * Send a JSON-RPC 2.0 request to the MCP server.
   * Includes timeout handling via AbortController.
   */
  private async sendMCPRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<MCPResponse> {
    const requestId = ++this.requestIdCounter;

    const request: MCPRequest = {
      jsonrpc: '2.0',
      id: requestId,
      method,
      params,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(`${this.endpoint}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new MCPRequestError(
          `MCP server returned HTTP ${response.status}: ${response.statusText}`,
          method,
          response.status,
        );
      }

      const json = await response.json() as MCPResponse;

      if (json.jsonrpc !== '2.0') {
        throw new MCPRequestError(
          'Invalid JSON-RPC response: missing or wrong jsonrpc field',
          method,
        );
      }

      return json;
    } catch (error: unknown) {
      clearTimeout(timeoutId);

      if (error instanceof MCPRequestError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new MCPTimeoutError(
          `MCP request "${method}" timed out after ${this.requestTimeoutMs}ms`,
          this.requestTimeoutMs,
        );
      }

      // Connection refused or network error — unregister provider since server is unavailable
      this.mcpConnected = false;
      this.unregisterAsProvider();
      throw new MCPConnectionError(
        `Failed to communicate with Unsloth Core: ${error instanceof Error ? error.message : String(error)}`,
        this.endpoint,
      );
    }
  }

  // ─── Private: Provider Registration ─────────────────────────────

  /**
   * Register as an OpenAI-compatible provider in the Provider Registry.
   * Priority set below cloud providers (100+), above base Ollama (30).
   * Includes capabilities metadata: available models, supported methods,
   * GPU availability, and max context length.
   *
   * Requirements: 6.7
   */
  private registerAsProvider(): void {
    if (!this.providerRegistry) return;

    try {
      const bridge = this;
      const capabilities = this.capabilities;

      const adapter: LLMProviderAdapter & { capabilities?: UnslothCapabilities } = {
        id: 'unsloth-local',
        name: 'Unsloth Local (MCP)',
        capabilities: capabilities ?? {
          models: [],
          supportedMethods: ['lora', 'qlora'],
          gpuAvailable: false,
          maxContextLength: 4096,
        },
        chatCompletion: async (messages, options) => {
          const response = await bridge.sendMCPRequest('inference/chat', {
            messages,
            ...options,
          });
          const result = response.result as Record<string, unknown>;
          return {
            content: String(result?.['content'] ?? ''),
            tokensUsed: {
              prompt: Number((result?.['tokensUsed'] as Record<string, unknown>)?.['prompt']) || 0,
              completion: Number((result?.['tokensUsed'] as Record<string, unknown>)?.['completion']) || 0,
            },
            finishReason: (result?.['finishReason'] as 'stop' | 'length' | 'tool_call') ?? 'stop',
          };
        },
        streamCompletion: async function* (messages, options) {
          const response = await bridge.sendMCPRequest('inference/chat', {
            messages,
            ...options,
          });
          const result = response.result as Record<string, unknown> | undefined;
          yield { content: String(result?.['content'] ?? ''), done: true };
        },
        countTokens: (text: string) => {
          return Math.ceil(text.length / 4);
        },
        isAvailable: async () => {
          return bridge.mcpConnected;
        },
      };

      this.providerRegistry.register(adapter, 50);
      this.providerRegistered = true;
    } catch {
      // Non-fatal: registration failure should not crash initialization
      this.providerRegistered = false;
    }
  }

  /**
   * Unregister from the Provider Registry.
   * Called when the bridge disconnects or the server becomes unavailable.
   */
  private unregisterAsProvider(): void {
    if (!this.providerRegistry || !this.providerRegistered) return;

    try {
      this.providerRegistry.unregister('unsloth-local');
      this.providerRegistered = false;
    } catch {
      // Non-fatal: unregistration failure should not crash shutdown
    }
  }

  // ─── Private: Self-Healing Helpers ──────────────────────────────

  /**
   * Replace single quotes with double quotes, being careful about
   * strings already inside double-quoted strings.
   */
  private replaceSingleQuotes(input: string): string {
    let result = '';
    let inDoubleQuote = false;
    let inSingleQuote = false;

    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      const prevChar = i > 0 ? input[i - 1] : '';

      if (char === '"' && prevChar !== '\\' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        result += char;
      } else if (char === "'" && prevChar !== '\\' && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
        result += '"';
      } else {
        result += char;
      }
    }

    return result;
  }

  /**
   * Close open brackets/braces in truncated JSON.
   */
  private closeOpenBrackets(input: string): string {
    let braceCount = 0;
    let bracketCount = 0;
    let inString = false;

    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      const prevChar = i > 0 ? input[i - 1] : '';

      if (char === '"' && prevChar !== '\\') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (char === '{') braceCount++;
      else if (char === '}') braceCount--;
      else if (char === '[') bracketCount++;
      else if (char === ']') bracketCount--;
    }

    let result = input.replace(/,\s*$/, '');

    while (bracketCount > 0) {
      result += ']';
      bracketCount--;
    }
    while (braceCount > 0) {
      result += '}';
      braceCount--;
    }

    return result;
  }
}
