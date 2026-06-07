/**
 * Embedding Daemon (Worker Thread)
 *
 * Background worker that keeps the embedding model loaded in memory for
 * low-latency inference. Uses `worker_threads` to avoid blocking the
 * Electron main process.
 *
 * Features:
 * - Request queuing (max 1000 items) when daemon is unavailable
 * - Health check reporting model loaded status, memory usage, queue depth
 * - Configurable provider ('ollama' | 'openai' | 'local') and endpoint
 * - Exponential backoff restart on worker crash (1s, 2s, 4s, max 30s)
 * - Configurable memory limit (default 512 MB)
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
 */

import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/**
 * Configuration for the embedding daemon.
 */
export interface EmbeddingDaemonConfig {
  model: string;
  provider: 'ollama' | 'openai' | 'mistral' | 'gemini' | 'local';
  endpoint: string;
  maxMemoryMB: number;
  apiKey?: string;
  dimensions?: number;
  /** Optional custom path to the worker script (used for testing) */
  workerPath?: string;
  /** Optional worker options override (used for testing with TypeScript loaders) */
  workerOptions?: Record<string, unknown>;
}

/**
 * A request to embed text, sent to the worker thread.
 */
export interface EmbeddingRequest {
  id: string;
  text: string;
}

/**
 * A response from the worker thread containing the embedding vector.
 */
export interface EmbeddingResponse {
  id: string;
  vector: Float32Array;
  durationMs: number;
}

/**
 * Health status of the embedding daemon.
 */
export interface DaemonHealth {
  modelLoaded: boolean;
  memoryUsageMB: number;
  queueDepth: number;
  uptime: number;
}

/**
 * Internal message types for worker communication.
 */
interface WorkerMessage {
  type: 'embed' | 'embedBatch' | 'health' | 'init';
  id: string;
  payload?: unknown;
}

interface WorkerResponse {
  type: 'result' | 'error' | 'health' | 'ready';
  id: string;
  payload?: unknown;
  error?: string;
}

/**
 * Pending request stored in the queue when the daemon is unavailable.
 */
interface PendingRequest {
  id: string;
  text: string;
  resolve: (value: Float32Array) => void;
  reject: (reason: Error) => void;
}

/**
 * In-flight request awaiting a response from the worker.
 */
interface InFlightRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Maximum number of queued requests when daemon is unavailable */
const MAX_QUEUE_SIZE = 1000;

/** Maximum backoff delay in milliseconds */
const MAX_BACKOFF_MS = 30_000;

/** Base backoff delay in milliseconds */
const BASE_BACKOFF_MS = 1_000;

/** Request timeout in milliseconds */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Client interface for the embedding daemon worker thread.
 *
 * Manages the lifecycle of the worker thread, handles request queuing
 * when the daemon is unavailable, and implements exponential backoff
 * restart on crashes.
 */
export class EmbeddingDaemonClient {
  private worker: Worker | null = null;
  private isRunning = false;
  private modelLoaded = false;
  private startTime = 0;
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  /** Queue for requests when daemon is unavailable */
  private queue: PendingRequest[] = [];

  /** In-flight requests awaiting worker response */
  private inFlight: Map<string, InFlightRequest> = new Map();

  /** Memory usage reported by the worker (in MB) */
  private memoryUsageMB = 0;

  constructor(private config: EmbeddingDaemonConfig) {
    if (!config.maxMemoryMB || config.maxMemoryMB <= 0) {
      this.config = { ...config, maxMemoryMB: 512 };
    }
  }

  /**
   * Start the worker thread and load the embedding model.
   * Resolves when the worker signals it is ready.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      try {
        const workerPath = this.config.workerPath ?? path.join(__dirname, 'embedding-worker.js');

        const workerOptions: Record<string, unknown> = {
          workerData: {
            model: this.config.model,
            provider: this.config.provider,
            endpoint: this.config.endpoint,
            maxMemoryMB: this.config.maxMemoryMB,
            apiKey: this.config.apiKey || '',
            dimensions: this.config.dimensions || 0,
          },
          resourceLimits: {
            maxOldGenerationSizeMb: this.config.maxMemoryMB,
          },
          ...this.config.workerOptions,
        };

        this.worker = new Worker(workerPath, workerOptions as any);

        this.worker.on('message', (msg: WorkerResponse) => {
          this.handleWorkerMessage(msg);
          if (msg.type === 'ready') {
            this.isRunning = true;
            this.modelLoaded = true;
            this.startTime = Date.now();
            this.restartCount = 0;
            this.flushQueue();
            resolve();
          }
        });

        this.worker.on('error', (err: Error) => {
          console.error('[IndexingPipeline:EmbeddingDaemon] Worker error:', err.message);
          this.handleWorkerCrash();
          if (!this.isRunning) {
            reject(err);
          }
        });

        this.worker.on('exit', (code: number) => {
          if (code !== 0) {
            console.error(`[IndexingPipeline:EmbeddingDaemon] Worker exited with code ${code}`);
            this.handleWorkerCrash();
          } else {
            this.isRunning = false;
            this.modelLoaded = false;
            this.worker = null;
          }
        });

        // Send initialization message
        this.sendToWorker({
          type: 'init',
          id: randomUUID(),
          payload: {
            model: this.config.model,
            provider: this.config.provider,
            endpoint: this.config.endpoint,
          },
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Embed a single text string.
   * If the daemon is unavailable, the request is queued (up to MAX_QUEUE_SIZE).
   */
  async embed(text: string): Promise<Float32Array> {
    if (!this.isRunning || !this.worker) {
      return this.enqueueRequest(text);
    }

    return this.sendEmbedRequest(text);
  }

  /**
   * Embed multiple texts in a batch.
   * If the daemon is unavailable, requests are queued individually.
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (!this.isRunning || !this.worker) {
      // Queue each text individually
      const promises = texts.map((text) => this.enqueueRequest(text));
      return Promise.all(promises);
    }

    const id = randomUUID();

    return new Promise<Float32Array[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inFlight.delete(id);
        reject(new Error('Embedding batch request timed out'));
      }, REQUEST_TIMEOUT_MS * texts.length);

      this.inFlight.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.sendToWorker({
        type: 'embedBatch',
        id,
        payload: { texts },
      });
    });
  }

  /**
   * Check daemon health status.
   * Returns current model loaded state, memory usage, queue depth, and uptime.
   */
  health(): DaemonHealth {
    return {
      modelLoaded: this.modelLoaded,
      memoryUsageMB: this.memoryUsageMB,
      queueDepth: this.queue.length,
      uptime: this.isRunning ? Date.now() - this.startTime : 0,
    };
  }

  /**
   * Stop the worker thread gracefully.
   * Rejects all pending and in-flight requests.
   */
  async stop(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    // Reject all queued requests
    for (const pending of this.queue) {
      pending.reject(new Error('Embedding daemon stopped'));
    }
    this.queue = [];

    // Reject all in-flight requests
    for (const [id, request] of this.inFlight) {
      clearTimeout(request.timer);
      request.reject(new Error('Embedding daemon stopped'));
    }
    this.inFlight.clear();

    if (this.worker) {
      const worker = this.worker;
      this.worker = null;
      this.isRunning = false;
      this.modelLoaded = false;

      return new Promise<void>((resolve) => {
        const exitTimeout = setTimeout(() => {
          worker.terminate();
          resolve();
        }, 5000);

        worker.once('exit', () => {
          clearTimeout(exitTimeout);
          resolve();
        });

        worker.terminate();
      });
    }

    this.isRunning = false;
    this.modelLoaded = false;
  }

  /**
   * Send an embed request to the worker and return a promise for the result.
   */
  private sendEmbedRequest(text: string): Promise<Float32Array> {
    const id = randomUUID();

    return new Promise<Float32Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inFlight.delete(id);
        reject(new Error('Embedding request timed out'));
      }, REQUEST_TIMEOUT_MS);

      this.inFlight.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.sendToWorker({
        type: 'embed',
        id,
        payload: { text },
      });
    });
  }

  /**
   * Enqueue a request when the daemon is unavailable.
   * Rejects immediately if the queue is full.
   */
  private enqueueRequest(text: string): Promise<Float32Array> {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      return Promise.reject(
        new Error(`Embedding request queue full (max ${MAX_QUEUE_SIZE} items)`)
      );
    }

    return new Promise<Float32Array>((resolve, reject) => {
      this.queue.push({
        id: randomUUID(),
        text,
        resolve,
        reject,
      });
    });
  }

  /**
   * Flush queued requests by sending them to the worker.
   * Called when the daemon recovers after a crash.
   */
  private flushQueue(): void {
    const pending = [...this.queue];
    this.queue = [];

    for (const request of pending) {
      this.sendEmbedRequest(request.text).then(request.resolve, request.reject);
    }
  }

  /**
   * Handle a message received from the worker thread.
   */
  private handleWorkerMessage(msg: WorkerResponse): void {
    if (msg.type === 'health') {
      const payload = msg.payload as { memoryUsageMB?: number; modelLoaded?: boolean } | undefined;
      if (payload) {
        this.memoryUsageMB = payload.memoryUsageMB ?? this.memoryUsageMB;
        this.modelLoaded = payload.modelLoaded ?? this.modelLoaded;
      }
      return;
    }

    if (msg.type === 'ready') {
      // Handled in start() promise
      return;
    }

    const request = this.inFlight.get(msg.id);
    if (!request) {
      return;
    }

    this.inFlight.delete(msg.id);
    clearTimeout(request.timer);

    if (msg.type === 'error') {
      request.reject(new Error(msg.error ?? 'Unknown worker error'));
    } else if (msg.type === 'result') {
      const payload = msg.payload as { vector?: number[]; vectors?: number[][] } | undefined;
      if (payload?.vector) {
        request.resolve(new Float32Array(payload.vector));
      } else if (payload?.vectors) {
        request.resolve(payload.vectors.map((v) => new Float32Array(v)));
      } else {
        request.reject(new Error('Invalid response payload from worker'));
      }
    }
  }

  /**
   * Handle worker crash with exponential backoff restart.
   * Backoff: 1s, 2s, 4s, 8s, 16s, 30s (max).
   */
  private handleWorkerCrash(): void {
    this.isRunning = false;
    this.modelLoaded = false;
    this.worker = null;

    // Reject all in-flight requests
    for (const [id, request] of this.inFlight) {
      clearTimeout(request.timer);
      request.reject(new Error('Embedding daemon crashed'));
    }
    this.inFlight.clear();

    // Schedule restart with exponential backoff
    const backoffMs = Math.min(
      BASE_BACKOFF_MS * Math.pow(2, this.restartCount),
      MAX_BACKOFF_MS
    );
    this.restartCount++;

    console.error(
      `[IndexingPipeline:EmbeddingDaemon] Scheduling restart in ${backoffMs}ms (attempt ${this.restartCount})`
    );

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start().catch((err) => {
        console.error('[IndexingPipeline:EmbeddingDaemon] Restart failed:', err.message);
      });
    }, backoffMs);
  }

  /**
   * Send a message to the worker thread.
   */
  private sendToWorker(msg: WorkerMessage): void {
    if (this.worker) {
      this.worker.postMessage(msg);
    }
  }
}
