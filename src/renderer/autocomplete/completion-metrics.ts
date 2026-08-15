/**
 * CompletionMetrics — Source-free metrics for completion requests.
 *
 * Records latency and anonymous outcome IDs only.
 * Does NOT include source content unless explicit opt-in.
 *
 * Requirements: 4.8
 */

// ─── Types ──────────────────────────────────────────────────────

/** Outcome of a completion request */
export type CompletionOutcome =
  | 'accepted'
  | 'partially_accepted'
  | 'rejected'
  | 'dismissed'
  | 'timeout'
  | 'error'
  | 'cancelled'
  | 'superseded'
  | 'cached';

/** A single metric record — source-free by default */
export interface CompletionMetricRecord {
  /** Anonymous identifier for correlation (not content-based) */
  outcomeId: string;
  /** The outcome type */
  outcome: CompletionOutcome;
  /** Latency in milliseconds (time from request to response) */
  latencyMs: number;
  /** Timestamp of the event */
  timestamp: number;
  /** Model role that generated this completion */
  role: string;
  /** Whether this was served from cache */
  fromCache: boolean;
  /** Source content — only present if opt-in is enabled */
  sourceContent?: string;
  /** Language identifier (not source content) */
  language?: string;
}

/** Aggregated metrics summary */
export interface MetricsSummary {
  totalRequests: number;
  outcomes: Record<CompletionOutcome, number>;
  averageLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  cacheHitRate: number;
  /** Time window of this summary */
  windowStart: number;
  windowEnd: number;
}

/** Configuration for the metrics module */
export interface MetricsConfig {
  /** Whether source content opt-in is enabled */
  sourceContentOptIn: boolean;
  /** Maximum number of records to keep in memory */
  maxRecords: number;
  /** Whether metrics collection is enabled */
  enabled: boolean;
}

// ─── CompletionMetrics ──────────────────────────────────────────

/**
 * CompletionMetrics collects source-free completion metrics.
 *
 * By default, only latency and anonymous outcome IDs are recorded.
 * Source content is NEVER included unless explicitly opted in.
 */
export class CompletionMetrics {
  private records: CompletionMetricRecord[] = [];
  private config: MetricsConfig;
  private outcomeCounter = 0;

  constructor(config?: Partial<MetricsConfig>) {
    this.config = {
      sourceContentOptIn: config?.sourceContentOptIn ?? false,
      maxRecords: config?.maxRecords ?? 1000,
      enabled: config?.enabled ?? true,
    };
  }

  // ─── Configuration ──────────────────────────────────────────

  /**
   * Get the current configuration.
   */
  getConfig(): Readonly<MetricsConfig> {
    return { ...this.config };
  }

  /**
   * Update configuration.
   */
  updateConfig(config: Partial<MetricsConfig>): void {
    if (config.sourceContentOptIn !== undefined) {
      this.config.sourceContentOptIn = config.sourceContentOptIn;
    }
    if (config.maxRecords !== undefined) {
      this.config.maxRecords = Math.max(1, config.maxRecords);
    }
    if (config.enabled !== undefined) {
      this.config.enabled = config.enabled;
    }
  }

  /**
   * Check if source content is opted in.
   */
  isSourceContentOptedIn(): boolean {
    return this.config.sourceContentOptIn;
  }

  // ─── Recording ────────────────────────────────────────────────

  /**
   * Record a completion outcome.
   * Source content is only included if explicitly opted in.
   */
  record(params: {
    outcome: CompletionOutcome;
    latencyMs: number;
    role: string;
    fromCache: boolean;
    language?: string;
    /** Source content — will be stripped unless opt-in is active */
    sourceContent?: string;
  }): CompletionMetricRecord {
    if (!this.config.enabled) {
      // Still return a record shape but don't store it
      return this.createRecord(params);
    }

    const record = this.createRecord(params);
    this.records.push(record);

    // Enforce max records (FIFO eviction)
    while (this.records.length > this.config.maxRecords) {
      this.records.shift();
    }

    return record;
  }

  /**
   * Record a latency measurement for a request.
   */
  recordLatency(params: {
    outcome: CompletionOutcome;
    latencyMs: number;
    role: string;
    fromCache: boolean;
    language?: string;
  }): CompletionMetricRecord {
    return this.record({ ...params });
  }

  // ─── Querying ─────────────────────────────────────────────────

  /**
   * Get all recorded metrics.
   */
  getRecords(): ReadonlyArray<CompletionMetricRecord> {
    return [...this.records];
  }

  /**
   * Get the number of recorded metrics.
   */
  getRecordCount(): number {
    return this.records.length;
  }

  /**
   * Get an aggregated metrics summary for a time window.
   */
  getSummary(windowStart?: number, windowEnd?: number): MetricsSummary {
    const start = windowStart ?? 0;
    const end = windowEnd ?? Date.now();

    const filtered = this.records.filter(r => r.timestamp >= start && r.timestamp <= end);

    const outcomes: Record<CompletionOutcome, number> = {
      accepted: 0,
      partially_accepted: 0,
      rejected: 0,
      dismissed: 0,
      timeout: 0,
      error: 0,
      cancelled: 0,
      superseded: 0,
      cached: 0,
    };

    const latencies: number[] = [];
    let cacheHits = 0;

    for (const record of filtered) {
      outcomes[record.outcome]++;
      latencies.push(record.latencyMs);
      if (record.fromCache) cacheHits++;
    }

    latencies.sort((a, b) => a - b);

    return {
      totalRequests: filtered.length,
      outcomes,
      averageLatencyMs: filtered.length > 0
        ? latencies.reduce((a, b) => a + b, 0) / filtered.length
        : 0,
      p50LatencyMs: this.percentile(latencies, 50),
      p95LatencyMs: this.percentile(latencies, 95),
      p99LatencyMs: this.percentile(latencies, 99),
      cacheHitRate: filtered.length > 0 ? cacheHits / filtered.length : 0,
      windowStart: start,
      windowEnd: end,
    };
  }

  /**
   * Get metrics filtered by role.
   */
  getByRole(role: string): ReadonlyArray<CompletionMetricRecord> {
    return this.records.filter(r => r.role === role);
  }

  /**
   * Get metrics filtered by outcome.
   */
  getByOutcome(outcome: CompletionOutcome): ReadonlyArray<CompletionMetricRecord> {
    return this.records.filter(r => r.outcome === outcome);
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  /**
   * Clear all recorded metrics.
   */
  clear(): void {
    this.records = [];
  }

  /**
   * Dispose the metrics module.
   */
  dispose(): void {
    this.records = [];
    this.config.enabled = false;
  }

  // ─── Internal ─────────────────────────────────────────────────

  private createRecord(params: {
    outcome: CompletionOutcome;
    latencyMs: number;
    role: string;
    fromCache: boolean;
    language?: string;
    sourceContent?: string;
  }): CompletionMetricRecord {
    const record: CompletionMetricRecord = {
      outcomeId: this.generateOutcomeId(),
      outcome: params.outcome,
      latencyMs: params.latencyMs,
      timestamp: Date.now(),
      role: params.role,
      fromCache: params.fromCache,
      language: params.language,
    };

    // Only include source content if explicitly opted in
    if (this.config.sourceContentOptIn && params.sourceContent) {
      record.sourceContent = params.sourceContent;
    }

    return record;
  }

  private generateOutcomeId(): string {
    this.outcomeCounter++;
    return `outcome_${this.outcomeCounter}_${Math.random().toString(36).slice(2, 9)}`;
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
  }
}
