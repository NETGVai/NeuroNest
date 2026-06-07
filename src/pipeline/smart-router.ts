/**
 * Smart Model Router — intelligent routing of LLM requests based on:
 * - Task type (background, reasoning, long-context, default)
 * - Token count thresholds (auto-route to large-context models)
 * - Provider health (failover to healthy providers)
 * - Circuit breaker state (skip broken providers)
 *
 * Integrates with ProviderHealthMonitor for real-time health data.
 */

import { ProviderHealthMonitor } from './provider-health';

export type TaskType = 'default' | 'background' | 'reasoning' | 'longContext' | 'webSearch' | 'image';

export interface RouterConfig {
  /** Token threshold for switching to long-context model (default 60000) */
  longContextThreshold: number;
  /** Maximum retries on failover (default 3) */
  maxRetries: number;
  /** Whether to enable automatic failover (default true) */
  enableFailover: boolean;
  /** Whether to enable task-based routing (default true) */
  enableTaskRouting: boolean;
  /** Model assignments per task type */
  routes: {
    default?: string;      // "provider,model"
    background?: string;   // cheaper/faster model for non-critical tasks
    reasoning?: string;    // reasoning model for complex planning
    longContext?: string;  // large context window model
    webSearch?: string;    // model with web search capability
    image?: string;        // model with vision capability
  };
}

export interface RouteDecision {
  provider: string;
  model: string;
  reason: string;
  taskType: TaskType;
  failoverAttempt: number;
  originalProvider?: string;
  originalModel?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  type: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  contextWindow?: number;
}

const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  longContextThreshold: 60000,
  maxRetries: 3,
  enableFailover: true,
  enableTaskRouting: true,
  routes: {},
};

export class SmartModelRouter {
  private config: RouterConfig;
  private healthMonitor: ProviderHealthMonitor | null = null;
  private providers: ProviderInfo[] = [];
  private activeOverride: { provider: string; model: string } | null = null;

  constructor(config?: Partial<RouterConfig>) {
    this.config = { ...DEFAULT_ROUTER_CONFIG, ...config };
  }

  /** Set the health monitor reference */
  setHealthMonitor(monitor: ProviderHealthMonitor): void {
    this.healthMonitor = monitor;
  }

  /** Update router configuration */
  updateConfig(updates: Partial<RouterConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /** Get current router configuration */
  getConfig(): RouterConfig {
    return { ...this.config };
  }

  /** Register available providers */
  setProviders(providers: ProviderInfo[]): void {
    this.providers = providers;
  }

  /** Set a manual model override (from /model command) */
  setOverride(provider: string, model: string): void {
    this.activeOverride = { provider, model };
  }

  /** Clear the manual override */
  clearOverride(): void {
    this.activeOverride = null;
  }

  /** Get current override */
  getOverride(): { provider: string; model: string } | null {
    return this.activeOverride;
  }

  /**
   * Route a request to the best provider/model based on context.
   * @param tokenCount - estimated token count of the prompt
   * @param taskType - type of task being performed
   * @param currentProvider - the currently configured default provider
   * @param currentModel - the currently configured default model
   */
  route(
    tokenCount: number,
    taskType: TaskType = 'default',
    currentProvider?: string,
    currentModel?: string,
  ): RouteDecision {
    // Manual override takes highest priority
    if (this.activeOverride) {
      return {
        provider: this.activeOverride.provider,
        model: this.activeOverride.model,
        reason: 'Manual override via /model command',
        taskType,
        failoverAttempt: 0,
      };
    }

    // Task-based routing
    if (this.config.enableTaskRouting && taskType !== 'default') {
      const routeKey = this.config.routes[taskType];
      if (routeKey) {
        const [provider, model] = routeKey.split(',').map(s => s.trim());
        if (provider && model) {
          return {
            provider,
            model,
            reason: `Task-based routing: ${taskType}`,
            taskType,
            failoverAttempt: 0,
            originalProvider: currentProvider,
            originalModel: currentModel,
          };
        }
      }
    }

    // Long context auto-routing
    if (tokenCount > this.config.longContextThreshold) {
      const longContextRoute = this.config.routes.longContext;
      if (longContextRoute) {
        const [provider, model] = longContextRoute.split(',').map(s => s.trim());
        if (provider && model) {
          return {
            provider,
            model,
            reason: `Long context (${tokenCount} tokens > ${this.config.longContextThreshold} threshold)`,
            taskType: 'longContext',
            failoverAttempt: 0,
            originalProvider: currentProvider,
            originalModel: currentModel,
          };
        }
      }
      // Fallback: find any provider with a large context window
      const largeContextProvider = this.providers.find(p => (p.contextWindow || 0) > tokenCount);
      if (largeContextProvider) {
        return {
          provider: largeContextProvider.type,
          model: largeContextProvider.model,
          reason: `Auto-routed to ${largeContextProvider.name} (${largeContextProvider.contextWindow} context window)`,
          taskType: 'longContext',
          failoverAttempt: 0,
          originalProvider: currentProvider,
          originalModel: currentModel,
        };
      }
    }

    // Default: use current provider/model
    return {
      provider: currentProvider || '',
      model: currentModel || '',
      reason: 'Default routing',
      taskType: 'default',
      failoverAttempt: 0,
    };
  }

  /**
   * Get the next failover provider when the current one fails.
   * Skips providers with open circuits.
   * @param failedProviderId - the provider that just failed
   * @param attempt - current retry attempt number
   */
  getFailoverProvider(failedProviderId: string, attempt: number): ProviderInfo | null {
    if (!this.config.enableFailover) return null;
    if (attempt >= this.config.maxRetries) return null;

    // Get providers sorted by health (if monitor available)
    let candidates = this.providers.filter(p => p.id !== failedProviderId);

    if (this.healthMonitor) {
      // Filter out providers with open circuits
      candidates = candidates.filter(p => !this.healthMonitor!.isCircuitOpen(p.id));

      // Sort by stability score (healthiest first)
      const statuses = this.healthMonitor.getStatuses();
      const statusMap = new Map(statuses.map(s => [s.providerId, s]));
      candidates.sort((a, b) => {
        const scoreA = statusMap.get(a.id)?.stabilityScore || 0;
        const scoreB = statusMap.get(b.id)?.stabilityScore || 0;
        return scoreB - scoreA;
      });
    }

    return candidates.length > 0 ? candidates[0] : null;
  }

  /**
   * Detect the task type from the prompt content.
   * Used for automatic task-based routing when not explicitly specified.
   */
  detectTaskType(prompt: string, agentRole?: string): TaskType {
    const lower = prompt.toLowerCase();

    // Reasoning indicators
    if (agentRole === 'planner' || agentRole === 'architect') return 'reasoning';
    if (lower.includes('plan') && lower.includes('architecture')) return 'reasoning';
    if (lower.includes('design system') || lower.includes('technical design')) return 'reasoning';

    // Background task indicators
    if (agentRole === 'commitMessages' || agentRole === 'names') return 'background';
    if (lower.includes('commit message') || lower.includes('variable name')) return 'background';
    if (lower.includes('lint') || lower.includes('format')) return 'background';

    // Web search indicators
    if (lower.includes('search') && (lower.includes('web') || lower.includes('latest'))) return 'webSearch';
    if (lower.includes('current version') || lower.includes('documentation for')) return 'webSearch';

    // Image indicators
    if (lower.includes('screenshot') || lower.includes('image') || lower.includes('diagram')) return 'image';

    return 'default';
  }

  /**
   * LLM-based task type detection. Uses a reasoning model to understand the task
   * semantically rather than relying on keyword presence.
   * Falls back to the pattern-based detectTaskType() if LLM is unavailable.
   */
  async detectTaskTypeLLM(prompt: string, llmClient?: any, agentRole?: string): Promise<TaskType> {
    if (llmClient) {
      try {
        const { classifyTaskType } = require('./llm-decision-engine');
        const result = await classifyTaskType(prompt, llmClient);
        if (result) {
          // Map LLM decision engine types to smart-router types
          const typeMap: Record<string, TaskType> = {
            reasoning: 'reasoning',
            coding: 'default',
            background: 'background',
            webSearch: 'webSearch',
            image: 'image',
            general: 'default',
          };
          const mapped = typeMap[result.taskType] || 'default';
          console.log('[SmartRouter] LLM task type:', result.taskType, '→', mapped, '—', result.reasoning);
          return mapped;
        }
      } catch (err: any) {
        console.warn('[SmartRouter] LLM task type detection failed, using pattern fallback:', err?.message);
      }
    }
    return this.detectTaskType(prompt, agentRole);
  }
}
