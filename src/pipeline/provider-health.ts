/**
 * Provider Health Monitor — tracks latency, uptime, and stability of configured LLM providers.
 * Pings endpoints periodically with adaptive cadence (aggressive when active, idle when not).
 * Provides a stability score (0-100) for each provider based on p95 latency, jitter, spike rate, and uptime.
 */

export interface ProviderHealthStatus {
  providerId: string;
  providerName: string;
  model: string;
  healthy: boolean;
  latencyMs: number;        // last measured latency
  avgLatencyMs: number;     // rolling average
  p95LatencyMs: number;     // 95th percentile
  stabilityScore: number;   // 0-100 composite score
  uptime: number;           // 0.0-1.0 ratio of successful pings
  lastChecked: number;      // timestamp
  lastError?: string;
  consecutiveFailures: number;
  circuitOpen: boolean;     // true = provider is temporarily disabled
  tier?: string;            // S+, S, A, B, C quality tier
}

export interface HealthMonitorConfig {
  activeCadenceMs: number;    // ping interval when user is active (default 10s)
  idleCadenceMs: number;      // ping interval when idle (default 30s)
  burstCadenceMs: number;     // ping interval during burst (default 2s)
  burstDurationMs: number;    // how long burst mode lasts (default 60s)
  circuitBreakerThreshold: number; // consecutive failures before opening circuit (default 3)
  circuitRecoveryMs: number;  // how long to wait before retrying an open circuit (default 60s)
  timeoutMs: number;          // ping timeout (default 5s)
  historySize: number;        // number of latency samples to keep (default 30)
}

const DEFAULT_CONFIG: HealthMonitorConfig = {
  activeCadenceMs: 10000,
  idleCadenceMs: 30000,
  burstCadenceMs: 2000,
  burstDurationMs: 60000,
  circuitBreakerThreshold: 3,
  circuitRecoveryMs: 60000,
  timeoutMs: 5000,
  historySize: 30,
};

interface ProviderEntry {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  latencyHistory: number[];
  successHistory: boolean[];
  consecutiveFailures: number;
  circuitOpen: boolean;
  circuitOpenedAt: number;
  lastChecked: number;
  lastError?: string;
  tier?: string;
}

export class ProviderHealthMonitor {
  private providers: Map<string, ProviderEntry> = new Map();
  private config: HealthMonitorConfig;
  private interval: ReturnType<typeof setInterval> | null = null;
  private mode: 'burst' | 'active' | 'idle' = 'idle';
  private burstStartedAt = 0;
  private lastActivity = Date.now();
  private listeners: Array<(statuses: ProviderHealthStatus[]) => void> = [];

  constructor(config?: Partial<HealthMonitorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Register a provider to monitor */
  registerProvider(id: string, name: string, baseUrl: string, model: string, apiKey?: string, tier?: string): void {
    if (this.providers.has(id)) {
      // Update existing
      const existing = this.providers.get(id)!;
      existing.baseUrl = baseUrl;
      existing.apiKey = apiKey;
      existing.model = model;
      existing.tier = tier;
      return;
    }
    this.providers.set(id, {
      id, name, baseUrl, apiKey, model, tier,
      latencyHistory: [],
      successHistory: [],
      consecutiveFailures: 0,
      circuitOpen: false,
      circuitOpenedAt: 0,
      lastChecked: 0,
      lastError: undefined,
    });
  }

  /** Remove providers that are no longer in the given ID set */
  syncProviderIds(activeIds: string[]): void {
    const activeSet = new Set(activeIds);
    for (const id of this.providers.keys()) {
      if (!activeSet.has(id)) {
        this.providers.delete(id);
      }
    }
  }

  /** Remove a provider from monitoring */
  unregisterProvider(id: string): void {
    this.providers.delete(id);
  }

  /** Signal user activity (switches to active/burst mode) */
  signalActivity(): void {
    this.lastActivity = Date.now();
    if (this.mode === 'idle') {
      this.mode = 'active';
      this.restartInterval();
    }
  }

  /** Start burst mode (aggressive probing for 60s) */
  startBurst(): void {
    this.mode = 'burst';
    this.burstStartedAt = Date.now();
    this.restartInterval();
  }

  /** Start the health monitor */
  start(): void {
    if (this.interval) return;
    this.mode = 'active';
    this.lastActivity = Date.now();
    this.restartInterval();
    // Initial probe
    this.probeAll();
  }

  /** Stop the health monitor */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Subscribe to health status updates */
  onUpdate(listener: (statuses: ProviderHealthStatus[]) => void): void {
    this.listeners.push(listener);
  }

  /** Get current health status for all providers */
  getStatuses(): ProviderHealthStatus[] {
    const statuses: ProviderHealthStatus[] = [];
    for (const [, entry] of this.providers) {
      statuses.push(this.computeStatus(entry));
    }
    return statuses.sort((a, b) => b.stabilityScore - a.stabilityScore);
  }

  /** Get the healthiest provider ID (for failover selection) */
  getHealthiestProvider(): string | null {
    const statuses = this.getStatuses().filter(s => !s.circuitOpen && s.healthy);
    return statuses.length > 0 ? statuses[0].providerId : null;
  }

  /** Check if a specific provider's circuit is open (should be skipped) */
  isCircuitOpen(providerId: string): boolean {
    const entry = this.providers.get(providerId);
    if (!entry) return false;
    if (!entry.circuitOpen) return false;
    // Check if recovery time has passed
    if (Date.now() - entry.circuitOpenedAt > this.config.circuitRecoveryMs) {
      entry.circuitOpen = false;
      entry.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  /** Record a successful request to a provider */
  recordSuccess(providerId: string, latencyMs: number): void {
    const entry = this.providers.get(providerId);
    if (!entry) return;
    entry.consecutiveFailures = 0;
    entry.circuitOpen = false;
    entry.latencyHistory.push(latencyMs);
    entry.successHistory.push(true);
    this.trimHistory(entry);
  }

  /** Record a failed request to a provider */
  recordFailure(providerId: string, error?: string, isAuthError?: boolean): void {
    const entry = this.providers.get(providerId);
    if (!entry) return;
    entry.lastError = error;
    entry.successHistory.push(false);
    if (!isAuthError) {
      entry.consecutiveFailures++;
      if (entry.consecutiveFailures >= this.config.circuitBreakerThreshold) {
        entry.circuitOpen = true;
        entry.circuitOpenedAt = Date.now();
      }
    }
    this.trimHistory(entry);
  }

  // ── Internal ──

  private restartInterval(): void {
    if (this.interval) clearInterval(this.interval);
    const cadence = this.getCurrentCadence();
    this.interval = setInterval(() => this.tick(), cadence);
  }

  private getCurrentCadence(): number {
    if (this.mode === 'burst') return this.config.burstCadenceMs;
    if (this.mode === 'active') return this.config.activeCadenceMs;
    return this.config.idleCadenceMs;
  }

  private tick(): void {
    // Check mode transitions
    if (this.mode === 'burst' && Date.now() - this.burstStartedAt > this.config.burstDurationMs) {
      this.mode = 'active';
      this.restartInterval();
    } else if (this.mode === 'active' && Date.now() - this.lastActivity > 120000) {
      this.mode = 'idle';
      this.restartInterval();
    }
    this.probeAll();
  }

  private async probeAll(): Promise<void> {
    const probes: Promise<void>[] = [];
    for (const [, entry] of this.providers) {
      // Skip providers with open circuits (unless recovery time passed)
      if (entry.circuitOpen && Date.now() - entry.circuitOpenedAt < this.config.circuitRecoveryMs) {
        continue;
      }
      probes.push(this.probeProvider(entry));
    }
    await Promise.allSettled(probes);
    // Notify listeners
    const statuses = this.getStatuses();
    for (const listener of this.listeners) {
      try { listener(statuses); } catch {}
    }
  }

  private async probeProvider(entry: ProviderEntry): Promise<void> {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

      // Construct the models endpoint URL from the base URL
      let url = entry.baseUrl.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '');
      // Ensure we hit /models (or /v1/models)
      if (url.endsWith('/v1')) {
        url += '/models';
      } else if (url.includes('/v1/')) {
        url = url.replace(/\/v1\/.*$/, '/v1/models');
      } else {
        url += '/models';
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (entry.apiKey) headers['Authorization'] = 'Bearer ' + entry.apiKey;

      const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      clearTimeout(timeout);

      const latency = Date.now() - start;
      entry.lastChecked = Date.now();

      if (response.ok || response.status === 401 || response.status === 403) {
        // 401/403 means the endpoint is alive but auth failed — still counts as "up"
        entry.latencyHistory.push(latency);
        entry.successHistory.push(true);
        entry.consecutiveFailures = 0;
        if (entry.circuitOpen) {
          entry.circuitOpen = false;
        }
      } else {
        entry.successHistory.push(false);
        entry.consecutiveFailures++;
        entry.lastError = `HTTP ${response.status}`;
        if (entry.consecutiveFailures >= this.config.circuitBreakerThreshold) {
          entry.circuitOpen = true;
          entry.circuitOpenedAt = Date.now();
        }
      }
    } catch (err: any) {
      entry.lastChecked = Date.now();
      entry.successHistory.push(false);
      entry.consecutiveFailures++;
      entry.lastError = err.message || 'Timeout';
      if (entry.consecutiveFailures >= this.config.circuitBreakerThreshold) {
        entry.circuitOpen = true;
        entry.circuitOpenedAt = Date.now();
      }
    }
    this.trimHistory(entry);
  }

  private computeStatus(entry: ProviderEntry): ProviderHealthStatus {
    const history = entry.latencyHistory;
    const successes = entry.successHistory;

    // Average latency
    const avgLatency = history.length > 0 ? history.reduce((a, b) => a + b, 0) / history.length : 0;

    // P95 latency
    const sorted = [...history].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    const p95Latency = sorted.length > 0 ? sorted[Math.min(p95Index, sorted.length - 1)] : 0;

    // Uptime ratio
    const totalChecks = successes.length;
    const successCount = successes.filter(s => s).length;
    const uptime = totalChecks > 0 ? successCount / totalChecks : 0;

    // Jitter (standard deviation of latency)
    let jitter = 0;
    if (history.length > 1) {
      const mean = avgLatency;
      const variance = history.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / history.length;
      jitter = Math.sqrt(variance);
    }

    // Spike rate (% of pings > 2x average)
    const spikeThreshold = avgLatency * 2;
    const spikes = history.filter(l => l > spikeThreshold).length;
    const spikeRate = history.length > 0 ? spikes / history.length : 0;

    // Stability score: p95 (30%) + jitter (30%) + spike rate (20%) + uptime (20%)
    const p95Score = Math.max(0, 100 - (p95Latency / 50)); // 0ms=100, 5000ms=0
    const jitterScore = Math.max(0, 100 - (jitter / 20));   // low jitter = high score
    const spikeScore = (1 - spikeRate) * 100;
    const uptimeScore = uptime * 100;
    const stabilityScore = Math.round(
      p95Score * 0.3 + jitterScore * 0.3 + spikeScore * 0.2 + uptimeScore * 0.2
    );

    return {
      providerId: entry.id,
      providerName: entry.name,
      model: entry.model,
      healthy: !entry.circuitOpen && uptime > 0.5,
      latencyMs: history.length > 0 ? history[history.length - 1] : 0,
      avgLatencyMs: Math.round(avgLatency),
      p95LatencyMs: Math.round(p95Latency),
      stabilityScore: Math.max(0, Math.min(100, stabilityScore)),
      uptime,
      lastChecked: entry.lastChecked,
      lastError: entry.lastError,
      consecutiveFailures: entry.consecutiveFailures,
      circuitOpen: entry.circuitOpen,
      tier: entry.tier,
    };
  }

  private trimHistory(entry: ProviderEntry): void {
    if (entry.latencyHistory.length > this.config.historySize) {
      entry.latencyHistory = entry.latencyHistory.slice(-this.config.historySize);
    }
    if (entry.successHistory.length > this.config.historySize * 2) {
      entry.successHistory = entry.successHistory.slice(-this.config.historySize * 2);
    }
  }
}
