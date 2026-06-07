/**
 * Model Backend — Unified LLM API, provider management, streaming, token tracking.
 *
 * Since we don't have the actual Pi_AI package, this is a stub implementation that:
 * - Manages provider configs in memory
 * - Tracks token usage per provider/session
 * - Implements provider fallback logic
 * - Stores default model per task category
 *
 * Requirements: 2.1–2.9
 */

import type {
  ProviderConfig,
  ChatRequest,
  ChatChunk,
  TokenUsage,
  ModelConfig,
  TaskCategory,
} from '../shared/types.js';

// ─── Additional types for ModelBackend ──────────────────────────

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export interface ProviderStatus {
  id: string;
  type: ProviderConfig['type'];
  reachable: boolean;
  models: string[];
  lastChecked: Date;
}

export interface ConnectionTestResult {
  success: boolean;
  latencyMs: number;
  error?: string;
}

export interface UsageFilter {
  providerId?: string;
  sessionId?: string;
  since?: Date;
  until?: Date;
}

export interface UsageRecord {
  providerId: string;
  model: string;
  sessionId?: string;
  usage: TokenUsage;
  timestamp: Date;
}

export interface UsageReport {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalEstimatedCost: number;
  records: UsageRecord[];
}

export interface BudgetAlert {
  providerId?: string;
  currentCost: number;
  threshold: number;
  message: string;
}

// ─── ModelBackend ───────────────────────────────────────────────

export class ModelBackend {
  private providers = new Map<string, ProviderConfig>();
  private providerReachability = new Map<string, boolean>();
  private defaultModels = new Map<TaskCategory, ModelConfig>();
  private usageRecords: UsageRecord[] = [];
  private budgetCallbacks: Array<(alert: BudgetAlert) => void> = [];
  private budgetThresholds = new Map<string, number>(); // providerId -> threshold

  // ── Provider management ─────────────────────────────────────

  async addProvider(config: ProviderConfig): Promise<ValidationResult> {
    if (!config.id || config.id.length === 0) {
      return { valid: false, error: 'Provider ID is required' };
    }
    if (!config.models || config.models.length === 0) {
      return { valid: false, error: 'At least one model must be specified' };
    }
    this.providers.set(config.id, config);
    this.providerReachability.set(config.id, true); // assume reachable initially
    return { valid: true };
  }

  removeProvider(providerId: string): void {
    this.providers.delete(providerId);
    this.providerReachability.delete(providerId);
  }

  listProviders(): ProviderStatus[] {
    const result: ProviderStatus[] = [];
    for (const [id, config] of this.providers) {
      result.push({
        id,
        type: config.type,
        reachable: this.providerReachability.get(id) ?? false,
        models: config.models,
        lastChecked: new Date(),
      });
    }
    return result;
  }

  async testConnection(providerId: string): Promise<ConnectionTestResult> {
    const config = this.providers.get(providerId);
    if (!config) {
      return { success: false, latencyMs: 0, error: 'Provider not found' };
    }
    // Stub: return based on current reachability state
    const reachable = this.providerReachability.get(providerId) ?? false;
    return {
      success: reachable,
      latencyMs: reachable ? 50 : 0,
      error: reachable ? undefined : 'Provider unreachable',
    };
  }

  // ── Request routing ─────────────────────────────────────────

  async *chat(request: ChatRequest): AsyncIterable<ChatChunk> {
    const providerId = request.model.providerId;
    const reachable = this.providerReachability.get(providerId) ?? false;

    let activeProviderId = providerId;

    if (!reachable) {
      // Fallback: find first reachable provider
      const fallback = this.findFallbackProvider(providerId);
      if (!fallback) {
        yield {
          type: 'done',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
        };
        return;
      }
      activeProviderId = fallback;
    }

    // Stub: yield a simple response
    yield { type: 'text', content: `Response from ${activeProviderId}` };

    const usage: TokenUsage = {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      estimatedCost: 0.001,
    };

    this.recordUsage(activeProviderId, request.model.model, undefined, usage);

    yield { type: 'usage', usage };
    yield { type: 'done' };
  }

  getDefaultModel(category: TaskCategory): ModelConfig {
    const config = this.defaultModels.get(category);
    if (!config) {
      return { providerId: '', model: '' };
    }
    return config;
  }

  setDefaultModel(category: TaskCategory, model: ModelConfig): void {
    this.defaultModels.set(category, model);
  }

  // ── Usage tracking ──────────────────────────────────────────

  recordUsage(
    providerId: string,
    model: string,
    sessionId: string | undefined,
    usage: TokenUsage,
  ): void {
    this.usageRecords.push({
      providerId,
      model,
      sessionId,
      usage,
      timestamp: new Date(),
    });
    this.checkBudgetAlerts(providerId);
  }

  getUsage(filter: UsageFilter): UsageReport {
    let records = this.usageRecords;

    if (filter.providerId) {
      records = records.filter((r) => r.providerId === filter.providerId);
    }
    if (filter.sessionId) {
      records = records.filter((r) => r.sessionId === filter.sessionId);
    }
    if (filter.since) {
      const since = filter.since;
      records = records.filter((r) => r.timestamp >= since);
    }
    if (filter.until) {
      const until = filter.until;
      records = records.filter((r) => r.timestamp <= until);
    }

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalTokens = 0;
    let totalEstimatedCost = 0;

    for (const r of records) {
      totalPromptTokens += r.usage.promptTokens;
      totalCompletionTokens += r.usage.completionTokens;
      totalTokens += r.usage.totalTokens;
      totalEstimatedCost += r.usage.estimatedCost;
    }

    return {
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens,
      totalEstimatedCost,
      records,
    };
  }

  onBudgetAlert(callback: (alert: BudgetAlert) => void): void {
    this.budgetCallbacks.push(callback);
  }

  setBudgetThreshold(providerId: string, threshold: number): void {
    this.budgetThresholds.set(providerId, threshold);
  }

  // ── Provider reachability (for testing) ─────────────────────

  setProviderReachability(providerId: string, reachable: boolean): void {
    this.providerReachability.set(providerId, reachable);
  }

  // ── Fallback logic ──────────────────────────────────────────

  findFallbackProvider(excludeId: string): string | null {
    for (const [id] of this.providers) {
      if (id === excludeId) continue;
      if (this.providerReachability.get(id) === true) {
        return id;
      }
    }
    return null;
  }

  // ── Private helpers ─────────────────────────────────────────

  private checkBudgetAlerts(providerId: string): void {
    const threshold = this.budgetThresholds.get(providerId);
    if (threshold === undefined) return;

    const report = this.getUsage({ providerId });
    if (report.totalEstimatedCost >= threshold) {
      const alert: BudgetAlert = {
        providerId,
        currentCost: report.totalEstimatedCost,
        threshold,
        message: `Budget threshold exceeded for provider ${providerId}: $${report.totalEstimatedCost.toFixed(4)} >= $${threshold.toFixed(4)}`,
      };
      for (const cb of this.budgetCallbacks) {
        cb(alert);
      }
    }
  }
}
