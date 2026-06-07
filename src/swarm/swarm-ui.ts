/**
 * SwarmUI — Progress tracking, result aggregation, and cancellation.
 *
 * Provides real-time progress display per worker, lead agent result
 * aggregation, and cancellation with graceful termination.
 *
 * Requirements: 5.5, 5.7, 5.9, 5.11
 */

import type { TokenUsage } from '../shared/types.js';
import type { SwarmManager, WorkerProgress, SwarmResult, Swarm } from './swarm-manager.js';

// ─── Types ──────────────────────────────────────────────────────

export interface SwarmProgressSnapshot {
  swarmId: string;
  status: string;
  totalWorkers: number;
  completedWorkers: number;
  failedWorkers: number;
  runningWorkers: number;
  queuedWorkers: number;
  workerDetails: WorkerProgressDetail[];
  totalTokenUsage: TokenUsage;
  elapsedMs: number;
}

export interface WorkerProgressDetail {
  workerId: string;
  agentId: string;
  status: string;
  output?: string;
  error?: string;
  tokenUsage?: TokenUsage;
}

export interface AggregatedResult {
  swarmId: string;
  combinedOutput: string;
  workerOutputs: Array<{ workerId: string; output: string }>;
  failures: Array<{ workerId: string; error: string }>;
  totalTokenUsage: TokenUsage;
  successRate: number;
}

// ─── SwarmUI ────────────────────────────────────────────────────

export class SwarmUI {
  private progressHistory = new Map<string, WorkerProgress[]>();

  constructor(private swarmManager: SwarmManager) {}

  /**
   * Get a snapshot of current swarm progress.
   * Requirements: 5.5
   */
  getProgressSnapshot(swarmId: string): SwarmProgressSnapshot | null {
    const swarm = this.swarmManager.getSwarm(swarmId);
    if (!swarm) return null;

    const workerDetails: WorkerProgressDetail[] = swarm.workers.map((w) => ({
      workerId: w.workerId,
      agentId: w.agentId,
      status: w.status,
      output: w.output,
      error: w.error,
      tokenUsage: w.tokenUsage,
    }));

    const totalTokenUsage = this.aggregateTokenUsage(swarm.workers);
    const elapsedMs = swarm.startedAt
      ? Date.now() - swarm.startedAt.getTime()
      : 0;

    return {
      swarmId,
      status: swarm.status,
      totalWorkers: swarm.workers.length,
      completedWorkers: swarm.workers.filter((w) => w.status === 'completed').length,
      failedWorkers: swarm.workers.filter((w) => w.status === 'failed').length,
      runningWorkers: swarm.workers.filter((w) => w.status === 'running').length,
      queuedWorkers: swarm.workers.filter((w) => w.status === 'queued').length,
      workerDetails,
      totalTokenUsage,
      elapsedMs,
    };
  }

  /**
   * Aggregate results from all workers into a unified result.
   * Requirements: 5.7
   */
  aggregateResults(swarmId: string): AggregatedResult | null {
    const swarm = this.swarmManager.getSwarm(swarmId);
    if (!swarm) return null;

    const workerOutputs: Array<{ workerId: string; output: string }> = [];
    const failures: Array<{ workerId: string; error: string }> = [];

    for (const worker of swarm.workers) {
      if (worker.status === 'completed' && worker.output) {
        workerOutputs.push({ workerId: worker.workerId, output: worker.output });
      }
      if (worker.status === 'failed') {
        failures.push({
          workerId: worker.workerId,
          error: worker.error ?? 'Unknown error',
        });
      }
    }

    const totalWorkers = swarm.workers.length;
    const successCount = workerOutputs.length;
    const successRate = totalWorkers > 0 ? successCount / totalWorkers : 0;

    return {
      swarmId,
      combinedOutput: workerOutputs.map((w) => w.output).join('\n---\n'),
      workerOutputs,
      failures,
      totalTokenUsage: this.aggregateTokenUsage(swarm.workers),
      successRate,
    };
  }

  /**
   * Cancel a swarm with graceful worker termination.
   * Requirements: 5.11
   */
  cancelSwarm(swarmId: string): void {
    this.swarmManager.cancel(swarmId);
  }

  /**
   * Start tracking progress for a swarm.
   */
  startTracking(swarmId: string): void {
    this.progressHistory.set(swarmId, []);
    this.swarmManager.onProgress(swarmId, (progress) => {
      const history = this.progressHistory.get(swarmId);
      if (history) {
        history.push(progress);
      }
    });
  }

  /**
   * Get progress history for a swarm.
   */
  getProgressHistory(swarmId: string): WorkerProgress[] {
    return [...(this.progressHistory.get(swarmId) ?? [])];
  }

  // ── Private helpers ─────────────────────────────────────────

  private aggregateTokenUsage(workers: WorkerProgress[]): TokenUsage {
    const total: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
    };

    for (const w of workers) {
      if (w.tokenUsage) {
        total.promptTokens += w.tokenUsage.promptTokens;
        total.completionTokens += w.tokenUsage.completionTokens;
        total.totalTokens += w.tokenUsage.totalTokens;
        total.estimatedCost += w.tokenUsage.estimatedCost;
      }
    }

    return total;
  }
}
