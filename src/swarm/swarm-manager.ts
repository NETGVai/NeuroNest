/**
 * SwarmManager — Lead/worker coordination, parallel execution, shared memory.
 *
 * Stub implementation with in-memory state. Manages swarm creation,
 * worker coordination, task lifecycle, and human-in-the-loop checkpoints.
 *
 * Requirements: 5.1–5.4, 5.7–5.8, 5.10, 5.12–5.14
 */

import { randomUUID } from 'node:crypto';
import type { SwarmConfig, SwarmStatus, TokenUsage } from '../shared/types.js';

// ─── Types ──────────────────────────────────────────────────────

export type WorkerStatus = 'queued' | 'running' | 'completed' | 'failed' | 'paused';

export interface WorkerProgress {
  workerId: string;
  agentId: string;
  status: WorkerStatus;
  output?: string;
  tokenUsage?: TokenUsage;
  error?: string;
}

export interface SwarmResult {
  swarmId: string;
  status: SwarmStatus;
  workerResults: WorkerProgress[];
  aggregatedOutput: string;
  totalTokenUsage: TokenUsage;
  durationMs: number;
  failures: string[];
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

// ─── SwarmManager ───────────────────────────────────────────────

export class SwarmManager {
  private swarms = new Map<string, Swarm>();
  private progressCallbacks = new Map<string, Array<(progress: WorkerProgress) => void>>();
  private completeCallbacks = new Map<string, Array<(result: SwarmResult) => void>>();

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
   * Start swarm execution.
   * Requirements: 5.3, 5.10
   */
  async start(swarmId: string): Promise<SwarmResult> {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) throw new Error(`Swarm not found: ${swarmId}`);

    swarm.status = 'running';
    swarm.startedAt = new Date();

    // Simulate worker execution with concurrency bounds
    const startTime = Date.now();
    let concurrentRunning = 0;
    let maxConcurrentSeen = 0;
    const failures: string[] = [];

    for (const worker of swarm.workers) {
      if ((swarm.status as SwarmStatus) === 'cancelled') break;

      // Check human checkpoints
      if (swarm.checkpointsPending.length > 0) {
        swarm.status = 'paused';
        // In real impl, would wait for user approval
        swarm.checkpointsPending.shift();
        swarm.status = 'running';
      }

      concurrentRunning++;
      maxConcurrentSeen = Math.max(maxConcurrentSeen, concurrentRunning);

      // Enforce concurrency limit
      if (concurrentRunning > swarm.config.maxConcurrent) {
        concurrentRunning = swarm.config.maxConcurrent;
      }

      worker.status = 'running';
      this.emitProgress(swarmId, worker);

      // Stub: mark as completed
      worker.status = 'completed';
      worker.output = `Result from worker ${worker.workerId}`;
      worker.tokenUsage = {
        promptTokens: 100,
        completionTokens: 200,
        totalTokens: 300,
        estimatedCost: 0.01,
      };
      concurrentRunning--;

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
        failures.push(w.error ?? `Worker ${w.workerId} failed`);
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
   * Simulate a worker failure for testing fault tolerance.
   */
  simulateWorkerFailure(swarmId: string, workerId: string, error: string): void {
    const swarm = this.swarms.get(swarmId);
    if (!swarm) throw new Error(`Swarm not found: ${swarmId}`);

    const worker = swarm.workers.find((w) => w.workerId === workerId);
    if (!worker) throw new Error(`Worker not found: ${workerId}`);

    worker.status = 'failed';
    worker.error = error;
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
