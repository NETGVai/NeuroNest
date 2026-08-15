/**
 * LiveUpdateCoordinator — Subscribes to domain events from the main process
 * and applies projection updates within one second of authoritative events.
 *
 * Features:
 * - Subscribes to domain events (snapshots and deltas)
 * - Applies projection deltas within one second SLA
 * - Tracks latency of updates for SLA compliance
 * - Batches rapid updates for render efficiency
 *
 * Requirement: 10.10
 */

import type { PlanningProjectionStore } from './planning-projection-store.js';
import type {
  DomainEvent,
  ProjectionDelta,
  ProjectionSnapshot,
  UpdateLatencyRecord,
} from './types.js';

/** Listener for when a batch of updates is applied */
export type BatchAppliedListener = (latencies: UpdateLatencyRecord[]) => void;

/** Configuration for the LiveUpdateCoordinator */
export interface LiveUpdateCoordinatorConfig {
  /** Maximum time to batch events before flushing (ms). Default: 16 (one frame) */
  batchIntervalMs?: number;
  /** SLA threshold for update latency (ms). Default: 1000 */
  slaThresholdMs?: number;
  /** Maximum number of latency records to retain. Default: 100 */
  maxLatencyRecords?: number;
}

/**
 * LiveUpdateCoordinator manages the connection between domain events
 * from the main process and the PlanningProjectionStore. It batches
 * rapid updates to avoid excessive re-renders and tracks latency.
 */
export class LiveUpdateCoordinator {
  private store: PlanningProjectionStore;
  private config: Required<LiveUpdateCoordinatorConfig>;
  private pendingEvents: DomainEvent[] = [];
  private latencyRecords: UpdateLatencyRecord[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners: Set<BatchAppliedListener> = new Set();
  private disposed: boolean = false;

  constructor(store: PlanningProjectionStore, config?: LiveUpdateCoordinatorConfig) {
    this.store = store;
    this.config = {
      batchIntervalMs: config?.batchIntervalMs ?? 16,
      slaThresholdMs: config?.slaThresholdMs ?? 1000,
      maxLatencyRecords: config?.maxLatencyRecords ?? 100,
    };
  }

  /**
   * Receive a domain event from the main process event bus.
   * Events are batched for render efficiency.
   */
  receiveEvent(event: DomainEvent): void {
    if (this.disposed) {
      return;
    }

    this.pendingEvents.push(event);

    // Schedule flush if not already scheduled
    if (this.batchTimer === null) {
      this.batchTimer = setTimeout(() => {
        this.flush();
      }, this.config.batchIntervalMs);
    }
  }

  /**
   * Immediately flush all pending events without waiting for the batch interval.
   * Useful for testing or time-critical updates.
   */
  flush(): void {
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    if (this.pendingEvents.length === 0) {
      return;
    }

    const events = this.pendingEvents.slice();
    this.pendingEvents = [];

    const latencies: UpdateLatencyRecord[] = [];

    for (const event of events) {
      const receivedAt = Date.parse(event.timestamp);
      const applied = this.applyEvent(event);
      const appliedAt = Date.now();
      const latencyMs = appliedAt - receivedAt;

      if (applied) {
        const record: UpdateLatencyRecord = {
          eventId: event.id,
          receivedAt,
          appliedAt,
          latencyMs,
        };
        latencies.push(record);
        this.latencyRecords.push(record);
      }
    }

    // Trim latency records to max
    while (this.latencyRecords.length > this.config.maxLatencyRecords) {
      this.latencyRecords.shift();
    }

    if (latencies.length > 0) {
      this.notifyListeners(latencies);
    }
  }

  /**
   * Apply a single domain event to the store.
   */
  private applyEvent(event: DomainEvent): boolean {
    const payload = event.payload;

    if (event.type === 'snapshot' && 'entities' in payload) {
      return this.store.applySnapshot(payload as ProjectionSnapshot);
    }

    if (event.type === 'delta' && 'operations' in payload) {
      return this.store.applyDelta(payload as ProjectionDelta);
    }

    return false;
  }

  /**
   * Get latency statistics for SLA monitoring.
   */
  getLatencyStats(): {
    count: number;
    averageMs: number;
    maxMs: number;
    p95Ms: number;
    withinSla: number;
    slaViolations: number;
  } {
    if (this.latencyRecords.length === 0) {
      return { count: 0, averageMs: 0, maxMs: 0, p95Ms: 0, withinSla: 0, slaViolations: 0 };
    }

    const latencies = this.latencyRecords.map((r) => r.latencyMs);
    const sorted = [...latencies].sort((a, b) => a - b);

    const count = sorted.length;
    const averageMs = sorted.reduce((sum, v) => sum + v, 0) / count;
    const maxMs = sorted[sorted.length - 1];
    const p95Index = Math.min(Math.ceil(count * 0.95) - 1, count - 1);
    const p95Ms = sorted[p95Index];

    let withinSla = 0;
    let slaViolations = 0;
    for (const lat of latencies) {
      if (lat <= this.config.slaThresholdMs) {
        withinSla++;
      } else {
        slaViolations++;
      }
    }

    return { count, averageMs, maxMs, p95Ms, withinSla, slaViolations };
  }

  /**
   * Get all latency records (for inspection/debugging).
   */
  getLatencyRecords(): readonly UpdateLatencyRecord[] {
    return this.latencyRecords;
  }

  /**
   * Check if all recent updates met the SLA threshold.
   */
  isSlaCompliant(): boolean {
    return this.latencyRecords.every(
      (r) => r.latencyMs <= this.config.slaThresholdMs,
    );
  }

  /**
   * Get the number of pending events waiting to be flushed.
   */
  getPendingCount(): number {
    return this.pendingEvents.length;
  }

  /**
   * Subscribe to batch-applied events.
   */
  subscribe(listener: BatchAppliedListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Dispose the coordinator and clean up timers.
   */
  dispose(): void {
    this.disposed = true;
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.pendingEvents = [];
    this.listeners.clear();
  }

  private notifyListeners(latencies: UpdateLatencyRecord[]): void {
    for (const listener of this.listeners) {
      listener(latencies);
    }
  }
}
