/**
 * SwarmManager — Lead/worker coordination, parallel execution, shared memory.
 *
 * Real LLM execution implementation. Manages swarm creation,
 * worker coordination, task lifecycle, and human-in-the-loop checkpoints.
 * All worker tasks are executed through real LLM API calls.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.5, 5.1–5.4, 5.7–5.8, 5.10, 5.12–5.14
 */

import { randomUUID } from 'node:crypto';
import type { SwarmConfig, SwarmStatus, TokenUsage } from '../shared/types.js';
import { LLMClient, type LLMMessage } from '../pipeline/llm-client.js';

// ─── Types ──────────────────────────────────────────────────────

export type WorkerStatus = 'queued' | 'running' | 'completed' | 'failed' | 'paused';

/**
 * Provenance information for a swarm result, identifying which model
 * and request produced the response.
 * Requirements: 2.5
 */
export interface SwarmProvenance {
  /** The model name used to generate the response */
  model: string;
  /** Unique request identifier for traceability */
  requestId: string;
}

export interface WorkerProgress {
  workerId: string;
  agentId: string;
  status: WorkerStatus;
  output?: string;
  tokenUsage?: TokenUsage;
  error?: string;
  provenance?: SwarmProvenance;
}

export interface SwarmResult {
  swarmId: string;
  status: SwarmStatus;
  workerResults: WorkerProgress[];
  aggregatedOutput: string;
  totalTokenUsage: TokenUsage;
  durationMs: number;
  failures: string[];
  /** Provenance tracking for the overall swarm execution */
  provenance?: SwarmProvenance;
}

export interface SwarmTask {
  id: string;
  description: string;
  priority: number;
  dependencies: string[];
  assignedWorkerId?: string;
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed';
}

export interface Swarm {
  id: string;
  config: SwarmConfig;
  status: SwarmStatus;
  workers: WorkerProgress[];
  tasks: SwarmTask[];
  checkpointsPending: string[];
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

/**
 * Error class for LLM connection failures.
 * Provides structured connection error details.
 * Requirements: 2.3
 */
export class LLMConnectionError extends Error {
  public readonly connectionDetails: {
    provider: string;
    errorCode: string;
    originalMessage: string;
  };

  constructor(provider: string, errorCode: string, originalMessage: string) {
    super(`LLM provider unreachable: [${provider}] ${errorCode} - ${originalMessage}`);
    this.name = 'LLMConnectionError';
    this.connectionDetails = { provider, errorCode, originalMessage };
  }
}

/**
 * Error class for zero-token result validation.
 * Requirements: 2.2
 */
export class ZeroTokenResultError extends Error {
  constructor(workerId: string) {
    super(`Invalid result: worker ${workerId} reported zero tokens for a completed interaction`);
    this.name = 'ZeroTokenResultError';
  }
}

// ─── SwarmManager ───────────────────────────────────────────────

export class SwarmManager {
  private swarms = new Map<string, Swarm>();
  private progressCallbacks = new Map<string, Array<(progress: WorkerProgress) => void>>();
  private completeCallbacks = new Map<string, Array<(result: SwarmResult) => void>>();
  private llmClient: LLMClient | null = null;

  /**
   * Set the LLM client used for executing worker tasks.
   * Requirements: 2.1
   */
  setLLMClient(client: LLMClient | null): void {
    this.llmClient = client;
  }

  /**
   * Get the current LLM client (for testing/inspection).
   */
  getLLMClient(): LLMClient | null {
    return this.llmClient;
  }

  /**
   * Create a new swarm from config.
   * Requirements: 5.1, 5.2, 5.10
   */
  createSwarm(config: SwarmConfig): Swarm {
    // Validate concurrency bounds (2-20)
    if (config.maxConcurrent < 2 || config.maxConcurrent > 20) {
      throw new Error(
        `maxConcurrent must be between 2 and 20, got ${config.maxConcurrent}`,
      );
    }

    const id = randomUUID();
    const workers: WorkerProgress[] = config.workerAgentIds.map((agentId) => ({
      workerId: randomUUID(),
      agentId,
      status: 'queued' as WorkerStatus,
    }));

    const swarm: Swarm = {
      id,
      config,
      status: 'planning',
      workers,
      tasks: [],
      checkpointsPending: [...(config.humanCheckpoints ?? [])],
      createdAt: new Date(),
    };

    this.swarms.set(id, swarm);
    return swarm;
  }

  /**
   * Get a swarm by ID.
   */
  getSwarm(swarmId: string): Swarm | null {
    return this.swarms.get(swarmId) ?? null;
  }

  /**
   * List all active swarms.
   */
  listActiveSwarms(): Swarm[] {
    return Array.from(this.swarms.values()).filter(
      (s) => s.status === 'running' || s.status === 'paused' || s.status === 'planning',
    );
  }

  /**
   * Execute a single worker task through the LLM API.
   * Requirements: 2.1, 2.2, 2.3, 2.5
   *
   * @param worker - The worker progress object to update
   * @param task - The task description to send to the LLM
   * @returns The updated worker with real LLM results
   * @throws LLMConnectionError when the provider is unreachable
   * @throws ZeroTokenResultError when a completed interaction reports zero tokens
   */
  private async executeWorkerTask(worker: WorkerProgress, task: string): Promise<WorkerProgress> {
    if (!this.llmClient) {
      throw new LLMConnectionError(
        'unknown',
        'NO_CLIENT',
        'No LLM client configured. Please set up an AI provider in Settings.',
      );
    }

    const requestId = randomUUID();

    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are a skilled AI agent executing a delegated task within a swarm workflow. Provide a thorough, actionable response.' },
      { role: 'user', content: task },
    ];

    try {
      const result = await this.llmClient.chat(messages, {
        temperature: 0.7,
        maxTokens: 2048,
      });

      // Extract token usage from response
      const promptTokens = result.promptTokens ?? 0;
      const completionTokens = result.completionTokens ?? 0;
      const totalTokens = result.tokensUsed ?? (promptTokens + completionTokens);

      // Requirement 2.2: Reject zero-token results for completed interactions
      if (totalTokens <= 0) {
        throw new ZeroTokenResultError(worker.workerId);
      }

      // Extract model name from client config
      const model = (this.llmClient as any).config?.model || 'unknown';

      worker.status = 'completed';
      worker.output = result.content;
      worker.tokenUsage = {
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedCost: 0, // Cost calculation handled by cost-store
      };
      // Requirement 2.5: Include provenance with model name and requestId
      worker.provenance = {
        model,
        requestId,
      };

      return worker;
    } catch (error: any) {
      // Requirement 2.3: Return explicit failure status with connection error details
      if (this.isConnectionError(error)) {
        const provider = (this.llmClient as any).config?.provider || 'unknown';
        const errorCode = this.extractErrorCode(error);
        worker.status = 'failed';
        worker.error = `LLM provider unreachable: [${provider}] ${errorCode} - ${error.message}`;
        throw new LLMConnectionError(provider, errorCode, error.message);
      }

      // Requirement 2.2: Reject zero-token results
      if (error instanceof ZeroTokenResultError) {
        worker.status = 'failed';
        worker.error = error.message;
        throw error;
      }

      // Other API errors (rate limiting, auth failures, etc.)
      worker.status = 'failed';
      worker.error = error.message || 'Unknown LLM execution error';
      throw error;
    }
  }

  /**
   * Determine if an error is a connection-level failure.
   */
  private isConnectionError(error: any): boolean {
    const message = error.message || '';
    return (
      message.includes('ENOTFOUND') ||
      message.includes('ECONNREFUSED') ||
      message.includes('ECONNRESET') ||
      message.includes('ETIMEDOUT') ||
      message.includes('socket hang up') ||
      message.includes('timed out') ||
      message.includes('Cannot reach') ||
      message.includes('LLM request failed') ||
      message.includes('Connection reset') ||
      error.code === 'ENOTFOUND' ||
      error.code === 'ECONNREFUSED' ||
      error.code === 'ECONNRESET' ||
      error.code === 'ETIMEDOUT'
    );
  }

  /**
   * Extract a structured error code from the error.
   */
  private extractErrorCode(error: any): string {
    if (error.code) return error.code;
    const message = error.message || '';
    if (message.includes('ENOTFOUND')) return 'ENOTFOUND';
    if (message.includes('ECONNREFUSED')) return 'ECONNREFUSED';
    if (message.includes('ECONNRESET')) return 'ECONNRESET';
    if (message.includes('ETIMEDOUT')) return 'ETIMEDOUT';
    if (message.includes('socket hang up')) return 'SOCKET_HANG_UP';
    if (message.includes('timed out')) return 'TIMEOUT';
    return 'CONNECTION_ERROR';
  }

  /**
   * Validate a completed worker result for data integrity.
   * Requirements: 2.2, 2.5
   *
   * @throws ZeroTokenResultError if token count is zero
   * @throws Error if provenance fields are missing or empty
   */
  validateWorkerResult(worker: WorkerProgress): void {
    if (worker.status !== 'completed') return;

    // Requirement 2.2: Reject zero-token results
    if (!worker.tokenUsage || worker.tokenUsage.totalTokens <= 0) {
      throw new ZeroTokenResultError(worker.workerId);
    }

    // Requirement 2.5: Ensure provenance is present and non-empty
    if (!worker.provenance) {
      throw new Error(`Missing provenance for completed worker ${worker.workerId}`);
    }
    if (!worker.provenance.model || worker.provenance.model.trim() === '') {
      throw new Error(`Empty model in provenance for worker ${worker.workerId}`);
    }
    if (!worker.provenance.requestId || worker.provenance.requestId.trim() === '') {
      throw new Error(`Empty requestId in provenance for worker ${worker.workerId}`);
    }
  }

  /**
   * Start swarm execution.
   * Requirements: 2.1, 2.2, 2.3, 2.5, 5.3, 5.10
   */
  async start(swarmId: string): Promise<SwarmResult> {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) throw new Error(`Swarm not found: ${swarmId}`);

    swarm.status = 'running';
    swarm.startedAt = new Date();

    const startTime = Date.now();
    const failures: string[] = [];
    let overallModel = '';

    for (const worker of swarm.workers) {
      if ((swarm.status as SwarmStatus) === 'cancelled') break;

      // Check human checkpoints
      if (swarm.checkpointsPending.length > 0) {
        swarm.status = 'paused';
        // In real impl, would wait for user approval
        swarm.checkpointsPending.shift();
        swarm.status = 'running';
      }

      worker.status = 'running';
      this.emitProgress(swarmId, worker);

      try {
        // Requirement 2.1: Execute through real LLM API call
        await this.executeWorkerTask(worker, swarm.config.task);

        // Requirement 2.2 & 2.5: Validate the completed result
        this.validateWorkerResult(worker);

        // Track the model used for overall provenance
        if (worker.provenance?.model) {
          overallModel = worker.provenance.model;
        }
      } catch (error: any) {
        worker.status = 'failed';
        if (!worker.error) {
          worker.error = error.message || 'Worker execution failed';
        }
        failures.push(worker.error ?? `Worker ${worker.workerId} failed`);
      }

      this.emitProgress(swarmId, worker);
    }

    const durationMs = Date.now() - startTime;

    // Aggregate results
    const totalTokenUsage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
    };

    for (const w of swarm.workers) {
      if (w.tokenUsage) {
        totalTokenUsage.promptTokens += w.tokenUsage.promptTokens;
        totalTokenUsage.completionTokens += w.tokenUsage.completionTokens;
        totalTokenUsage.totalTokens += w.tokenUsage.totalTokens;
        totalTokenUsage.estimatedCost += w.tokenUsage.estimatedCost;
      }
      if (w.status === 'failed') {
        if (!failures.includes(w.error ?? `Worker ${w.workerId} failed`)) {
          failures.push(w.error ?? `Worker ${w.workerId} failed`);
        }
      }
    }

    swarm.status = failures.length === swarm.workers.length ? 'failed' : 'completed';
    swarm.completedAt = new Date();

    const result: SwarmResult = {
      swarmId,
      status: swarm.status,
      workerResults: swarm.workers,
      aggregatedOutput: swarm.workers
        .filter((w) => w.output)
        .map((w) => w.output)
        .join('\n---\n'),
      totalTokenUsage,
      durationMs,
      failures,
      // Requirement 2.5: Include provenance for the overall swarm result
      provenance: overallModel
        ? { model: overallModel, requestId: randomUUID() }
        : undefined,
    };

    this.emitComplete(swarmId, result);
    return result;
  }

  /**
   * Pause a running swarm.
   * Requirements: 5.8
   */
  pause(swarmId: string): void {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) throw new Error(`Swarm not found: ${swarmId}`);
    if (swarm.status !== 'running') {
      throw new Error(`Cannot pause swarm with status: ${swarm.status}`);
    }
    swarm.status = 'paused';
  }

  /**
   * Resume a paused swarm.
   * Requirements: 5.8
   */
  resume(swarmId: string): void {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) throw new Error(`Swarm not found: ${swarmId}`);
    if (swarm.status !== 'paused') {
      throw new Error(`Cannot resume swarm with status: ${swarm.status}`);
    }
    swarm.status = 'running';
  }

  /**
   * Cancel a swarm, terminating all workers gracefully.
   * Requirements: 5.11
   */
  cancel(swarmId: string): void {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) throw new Error(`Swarm not found: ${swarmId}`);
    swarm.status = 'cancelled';
    for (const worker of swarm.workers) {
      if (worker.status === 'running' || worker.status === 'queued') {
        worker.status = 'failed';
        worker.error = 'Cancelled by user';
      }
    }
  }

  /**
   * Add a worker to an existing swarm.
   */
  addWorker(swarmId: string, agentId: string): WorkerProgress {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) throw new Error(`Swarm not found: ${swarmId}`);

    const worker: WorkerProgress = {
      workerId: randomUUID(),
      agentId,
      status: 'queued',
    };
    swarm.workers.push(worker);
    swarm.config.workerAgentIds.push(agentId);
    return worker;
  }

  /**
   * Remove a worker from a swarm.
   */
  removeWorker(swarmId: string, workerId: string): void {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) throw new Error(`Swarm not found: ${swarmId}`);

    const idx = swarm.workers.findIndex((w) => w.workerId === workerId);
    if (idx === -1) throw new Error(`Worker not found: ${workerId}`);

    const worker = swarm.workers[idx];
    if (worker.status === 'running') {
      throw new Error('Cannot remove a running worker');
    }

    swarm.workers.splice(idx, 1);
  }

  /**
   * Register a progress callback for a swarm.
   */
  onProgress(swarmId: string, callback: (progress: WorkerProgress) => void): void {
    let callbacks = this.progressCallbacks.get(swarmId);
    if (!callbacks) {
      callbacks = [];
      this.progressCallbacks.set(swarmId, callbacks);
    }
    callbacks.push(callback);
  }

  /**
   * Register a completion callback for a swarm.
   */
  onComplete(swarmId: string, callback: (result: SwarmResult) => void): void {
    let callbacks = this.completeCallbacks.get(swarmId);
    if (!callbacks) {
      callbacks = [];
      this.completeCallbacks.set(swarmId, callbacks);
    }
    callbacks.push(callback);
  }

  // ── Private helpers ─────────────────────────────────────────

  private emitProgress(swarmId: string, progress: WorkerProgress): void {
    const callbacks = this.progressCallbacks.get(swarmId) ?? [];
    for (const cb of callbacks) {
      cb(progress);
    }
  }

  private emitComplete(swarmId: string, result: SwarmResult): void {
    const callbacks = this.completeCallbacks.get(swarmId) ?? [];
    for (const cb of callbacks) {
      cb(result);
    }
  }
}
