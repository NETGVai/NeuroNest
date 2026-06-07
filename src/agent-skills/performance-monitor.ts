import { logger } from '../utils/logger.js';

/**
 * A single recorded timing measurement.
 */
export interface TimingEntry {
  operation: string;
  durationMs: number;
  timestamp: number;
}

/**
 * Summary statistics for a given operation.
 */
export interface OperationStats {
  operation: string;
  count: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p95Ms: number;
  totalMs: number;
}

/**
 * Snapshot of memory usage at a point in time.
 */
export interface MemorySnapshot {
  component: string;
  usedBytes: number;
  timestamp: number;
}

/**
 * Overall metrics report produced by the monitor.
 */
export interface MetricsReport {
  operationStats: OperationStats[];
  memorySnapshots: Map<string, MemorySnapshot[]>;
  collectedAt: number;
}

/**
 * Configuration for the PerformanceMonitor.
 */
export interface PerformanceMonitorConfig {
  /** Maximum number of timing entries to retain per operation. Default: 1000 */
  maxEntriesPerOperation: number;
  /** Maximum number of memory snapshots to retain per component. Default: 100 */
  maxSnapshotsPerComponent: number;
  /** Whether to log warnings when operations exceed a threshold. Default: true */
  enableSlowOperationWarnings: boolean;
  /** Threshold in ms above which an operation is considered slow. Default: 100 */
  slowOperationThresholdMs: number;
}

const DEFAULT_CONFIG: PerformanceMonitorConfig = {
  maxEntriesPerOperation: 1000,
  maxSnapshotsPerComponent: 100,
  enableSlowOperationWarnings: true,
  slowOperationThresholdMs: 100,
};

/**
 * Lightweight performance monitor for Agent Skills operations.
 *
 * Tracks operation response times, records memory snapshots, and
 * produces summary statistics for performance validation.
 *
 * Requirements: 10.1, 10.3
 */
export class PerformanceMonitor {
  private readonly config: PerformanceMonitorConfig;
  private readonly timings: Map<string, TimingEntry[]> = new Map();
  private readonly memorySnapshots: Map<string, MemorySnapshot[]> = new Map();

  constructor(config: Partial<PerformanceMonitorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Timing ────────────────────────────────────────────────

  /**
   * Record the duration of an operation.
   */
  recordTiming(operation: string, durationMs: number): void {
    const entry: TimingEntry = {
      operation,
      durationMs,
      timestamp: Date.now(),
    };

    let entries = this.timings.get(operation);
    if (!entries) {
      entries = [];
      this.timings.set(operation, entries);
    }

    entries.push(entry);

    // Evict oldest entries when over the limit
    if (entries.length > this.config.maxEntriesPerOperation) {
      entries.splice(0, entries.length - this.config.maxEntriesPerOperation);
    }

    if (
      this.config.enableSlowOperationWarnings &&
      durationMs > this.config.slowOperationThresholdMs
    ) {
      logger.warn('Slow Agent Skills operation detected', {
        operation,
        durationMs,
        thresholdMs: this.config.slowOperationThresholdMs,
      });
    }
  }

  /**
   * Measure an async operation and record its duration automatically.
   * Returns the result of the wrapped function.
   */
  async measure<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      const durationMs = performance.now() - start;
      this.recordTiming(operation, durationMs);
    }
  }

  /**
   * Measure a synchronous operation and record its duration.
   */
  measureSync<T>(operation: string, fn: () => T): T {
    const start = performance.now();
    try {
      return fn();
    } finally {
      const durationMs = performance.now() - start;
      this.recordTiming(operation, durationMs);
    }
  }

  /**
   * Get summary statistics for a single operation.
   * Returns null if no timings have been recorded for the operation.
   */
  getOperationStats(operation: string): OperationStats | null {
    const entries = this.timings.get(operation);
    if (!entries || entries.length === 0) return null;

    const durations = entries.map((e) => e.durationMs).sort((a, b) => a - b);
    const total = durations.reduce((sum, d) => sum + d, 0);
    const p95Index = Math.min(
      Math.ceil(durations.length * 0.95) - 1,
      durations.length - 1,
    );

    return {
      operation,
      count: durations.length,
      minMs: durations[0],
      maxMs: durations[durations.length - 1],
      avgMs: total / durations.length,
      p95Ms: durations[p95Index],
      totalMs: total,
    };
  }

  /**
   * Get summary statistics for all recorded operations.
   */
  getAllOperationStats(): OperationStats[] {
    const stats: OperationStats[] = [];
    for (const operation of this.timings.keys()) {
      const s = this.getOperationStats(operation);
      if (s) stats.push(s);
    }
    return stats;
  }

  // ── Memory Tracking ───────────────────────────────────────

  /**
   * Record a memory usage snapshot for a component.
   */
  recordMemorySnapshot(component: string, usedBytes: number): void {
    const snapshot: MemorySnapshot = {
      component,
      usedBytes,
      timestamp: Date.now(),
    };

    let snapshots = this.memorySnapshots.get(component);
    if (!snapshots) {
      snapshots = [];
      this.memorySnapshots.set(component, snapshots);
    }

    snapshots.push(snapshot);

    if (snapshots.length > this.config.maxSnapshotsPerComponent) {
      snapshots.splice(0, snapshots.length - this.config.maxSnapshotsPerComponent);
    }
  }

  /**
   * Get the latest memory snapshot for a component, or null.
   */
  getLatestMemorySnapshot(component: string): MemorySnapshot | null {
    const snapshots = this.memorySnapshots.get(component);
    if (!snapshots || snapshots.length === 0) return null;
    return snapshots[snapshots.length - 1];
  }

  /**
   * Get all memory snapshots for a component.
   */
  getMemorySnapshots(component: string): MemorySnapshot[] {
    return this.memorySnapshots.get(component) ?? [];
  }

  // ── Reporting ─────────────────────────────────────────────

  /**
   * Produce a full metrics report.
   */
  getMetricsReport(): MetricsReport {
    return {
      operationStats: this.getAllOperationStats(),
      memorySnapshots: new Map(this.memorySnapshots),
      collectedAt: Date.now(),
    };
  }

  /**
   * Compare two operations and return the ratio (opA avg / opB avg).
   * Useful for validating that integrated performance is within tolerance.
   * Returns null if either operation has no data.
   */
  compareOperations(
    operationA: string,
    operationB: string,
  ): { ratio: number; withinTolerance: boolean; tolerancePct: number } | null {
    const a = this.getOperationStats(operationA);
    const b = this.getOperationStats(operationB);
    if (!a || !b || b.avgMs === 0) return null;

    const ratio = a.avgMs / b.avgMs;
    // Requirement 10.1: within 10% of original performance → ratio ≤ 1.10
    const tolerancePct = 10;
    return {
      ratio,
      withinTolerance: ratio <= 1 + tolerancePct / 100,
      tolerancePct,
    };
  }

  // ── Housekeeping ──────────────────────────────────────────

  /**
   * Clear all recorded data.
   */
  reset(): void {
    this.timings.clear();
    this.memorySnapshots.clear();
  }

  /**
   * Number of distinct operations being tracked.
   */
  get trackedOperationCount(): number {
    return this.timings.size;
  }

  /**
   * Number of distinct components with memory snapshots.
   */
  get trackedComponentCount(): number {
    return this.memorySnapshots.size;
  }
}
