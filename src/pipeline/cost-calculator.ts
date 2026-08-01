/**
 * Cost Calculator — Pure module for computing LLM API call costs.
 * Reads bundled pricing data and computes USD cost from token counts.
 *
 * Also provides integration hooks for the ExtendedBudgetManager,
 * enabling post-response cost tracking, budget termination via Audit Chain,
 * and daily stop-loss pre-run checks. All budget integration is gated
 * behind the `budget_stop_loss` feature flag.
 *
 * Requirements: 7.4, 7.6
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ExtendedBudgetManager, ModelUsageResult } from './budget-manager-extended';
import type { AuditChainInterface } from '../devops-engine/audit-chain';

export interface PricingEntry {
  input_mtok: number;
  output_mtok: number;
}

export interface PricingTable {
  [provider: string]: { [model: string]: PricingEntry };
}

export interface CostResult {
  cost: number;           // USD, 6+ decimal precision
  inputCost: number;
  outputCost: number;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Reads and parses model-prices.json into memory.
 * Returns an empty object on any error.
 */
export function loadPricingTable(): PricingTable {
  try {
    const filePath = path.join(__dirname, '../data/model-prices.json');
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as PricingTable;
  } catch (err) {
    console.error('Failed to load pricing table:', err);
    return {};
  }
}

/**
 * Computes the cost of an LLM call given provider, model, token counts, and pricing table.
 * Returns zero cost with console.warn for unknown provider-model pairs.
 * Clamps negative token counts to 0. Returns 0 for NaN/Infinity results.
 */
export function calculateCost(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  table: PricingTable
): CostResult {
  // Clamp negative token counts to 0
  const clampedPrompt = Math.max(0, promptTokens);
  const clampedCompletion = Math.max(0, completionTokens);

  const providerEntry = table[provider];
  let entry = providerEntry?.[model];

  // Fuzzy match: if exact model not found, try prefix/substring matching
  if (!entry && providerEntry && model) {
    const modelLower = model.toLowerCase();
    const modelKeys = Object.keys(providerEntry).filter(k => k !== '_default');
    // Try: model starts with a known key (e.g. "gpt-4o-2024-08-06" starts with "gpt-4o")
    for (let i = 0; i < modelKeys.length; i++) {
      const key = modelKeys[i]!;
      if (modelLower.startsWith(key.toLowerCase())) {
        entry = providerEntry[key];
        break;
      }
    }
    // Try: a known key starts with the model (e.g. model="claude-3-5-sonnet" matches "claude-3-5-sonnet-20241022")
    if (!entry) {
      for (let i = 0; i < modelKeys.length; i++) {
        const key = modelKeys[i]!;
        if (key.toLowerCase().startsWith(modelLower)) {
          entry = providerEntry[key];
          break;
        }
      }
    }
    // Try: model contains a known key or vice versa
    if (!entry) {
      for (let i = 0; i < modelKeys.length; i++) {
        const key = modelKeys[i]!;
        if (modelLower.includes(key.toLowerCase()) || key.toLowerCase().includes(modelLower)) {
          entry = providerEntry[key];
          break;
        }
      }
    }
    // Fallback: use _default entry (for local providers like ollama/llamacpp)
    if (!entry && providerEntry['_default']) {
      entry = providerEntry['_default'];
    }
  }

  // If model is empty but provider exists, use _default or first model as fallback
  if (!entry && providerEntry && !model) {
    if (providerEntry['_default']) {
      entry = providerEntry['_default'];
    } else {
      const firstKey = Object.keys(providerEntry).filter(k => k !== '_default')[0];
      if (firstKey) entry = providerEntry[firstKey];
    }
  }

  if (!entry) {
    return {
      cost: 0,
      inputCost: 0,
      outputCost: 0,
      provider,
      model,
      promptTokens: clampedPrompt,
      completionTokens: clampedCompletion,
    };
  }

  let inputCost = (clampedPrompt / 1_000_000) * entry.input_mtok;
  let outputCost = (clampedCompletion / 1_000_000) * entry.output_mtok;

  // Guard against NaN/Infinity
  if (!Number.isFinite(inputCost)) inputCost = 0;
  if (!Number.isFinite(outputCost)) outputCost = 0;

  const cost = inputCost + outputCost;

  return {
    cost,
    inputCost,
    outputCost,
    provider,
    model,
    promptTokens: clampedPrompt,
    completionTokens: clampedCompletion,
  };
}

/**
 * Formats a numeric cost as a USD string with exactly two decimal places.
 * e.g. formatCostUSD(1.5) => "$1.50"
 * Non-finite values (NaN, Infinity) are treated as 0.
 */
export function formatCostUSD(cost: number): string {
  const safeCost = Number.isFinite(cost) ? cost : 0;
  return '$' + safeCost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
}


// ─── Budget Manager Integration ─────────────────────────────────

/**
 * Result returned by the post-response budget hook.
 */
export interface BudgetHookResult {
  /** Whether the pipeline is allowed to continue */
  allowed: boolean;
  /** Whether the per-run budget was exceeded */
  runExceeded: boolean;
  /** Whether the daily stop-loss was exceeded */
  dailyExceeded: boolean;
  /** Cost of this individual model call in USD */
  cost: number;
}

/**
 * Options for creating a PipelineBudgetIntegration instance.
 */
export interface PipelineBudgetIntegrationOptions {
  /** The ExtendedBudgetManager instance to use for cost tracking */
  budgetManager: ExtendedBudgetManager;
  /** Optional AuditChain for recording termination events (already wired in BudgetManager, but exposed for direct events) */
  auditChain?: AuditChainInterface;
  /** Feature gate check function — returns true if budget_stop_loss is enabled */
  isEnabled: () => boolean;
}

/**
 * Pipeline Budget Integration — Connects the cost calculator pipeline
 * to the ExtendedBudgetManager for real-time cost tracking and enforcement.
 *
 * Provides three hooks:
 * 1. `postResponseHook` — Called after every LLM response to record usage
 * 2. `canInitiateRun` — Pre-run check for daily stop-loss
 * 3. `onBudgetTermination` — Records termination event to audit chain
 *
 * All operations are no-ops when the feature gate is disabled.
 *
 * Requirements: 7.4, 7.6
 */
export class PipelineBudgetIntegration {
  private readonly budgetManager: ExtendedBudgetManager;
  private readonly auditChain: AuditChainInterface | undefined;
  private readonly isEnabled: () => boolean;

  constructor(options: PipelineBudgetIntegrationOptions) {
    this.budgetManager = options.budgetManager;
    this.auditChain = options.auditChain;
    this.isEnabled = options.isEnabled;
  }

  /**
   * Post-response hook: Called after every LLM response to record token usage
   * and check budget limits. Returns whether the pipeline should continue.
   *
   * When the budget is exceeded, signals the pipeline to terminate by returning
   * `allowed: false`. Budget termination events are automatically recorded in
   * the Audit Chain by the underlying ExtendedBudgetManager.
   *
   * @param runId - The current pipeline run identifier
   * @param modelId - The model that produced the response
   * @param promptTokens - Number of input/prompt tokens consumed
   * @param completionTokens - Number of output/completion tokens produced
   * @returns BudgetHookResult indicating whether the pipeline may continue
   */
  postResponseHook(
    runId: string,
    modelId: string,
    promptTokens: number,
    completionTokens: number,
  ): BudgetHookResult {
    // No-op when feature gate is disabled
    if (!this.isEnabled()) {
      return { allowed: true, runExceeded: false, dailyExceeded: false, cost: 0 };
    }

    const result: ModelUsageResult = this.budgetManager.recordModelUsage(
      runId,
      { input: promptTokens, output: completionTokens },
      modelId,
    );

    return {
      allowed: result.allowed,
      runExceeded: result.runExceeded,
      dailyExceeded: result.dailyExceeded,
      cost: result.cost,
    };
  }

  /**
   * Pre-run check: Verifies the daily stop-loss allows a new run to start.
   * Should be called at the beginning of any pipeline run initiation flow.
   *
   * Returns true if the run can proceed, false if the daily budget is exhausted.
   * When false, callers should block the run and inform the user that the daily
   * stop-loss threshold has been reached.
   *
   * @returns true if a new run is allowed, false if daily stop-loss is active
   */
  canInitiateRun(): boolean {
    // When feature gate is disabled, always allow runs
    if (!this.isEnabled()) {
      return true;
    }

    return this.budgetManager.canStartRun();
  }

  /**
   * Record a budget termination event directly to the Audit Chain.
   * This is useful for callers that need to record additional context
   * beyond what the ExtendedBudgetManager records automatically.
   *
   * @param runId - The terminated run identifier
   * @param agentId - The agent that was running
   * @param finalCost - The final accumulated cost at termination
   * @param limitType - Which limit was exceeded ('per-run' | 'daily-stop-loss')
   */
  onBudgetTermination(
    runId: string,
    agentId: string,
    finalCost: number,
    limitType: 'per-run' | 'daily-stop-loss',
  ): void {
    if (!this.isEnabled() || !this.auditChain) {
      return;
    }

    try {
      this.auditChain.append({
        timestamp: Date.now(),
        agentId,
        toolName: 'pipeline:budget-termination',
        arguments: { runId, limitType, finalCostUSD: finalCost },
        resultSummary: `Pipeline terminated: ${limitType} limit exceeded at $${finalCost.toFixed(6)}`,
        duration: 0,
        cost: finalCost,
      });
    } catch {
      // Best-effort audit logging — do not let audit failures affect pipeline flow
    }
  }
}

/**
 * Factory function to create a PipelineBudgetIntegration instance.
 * Returns null if the required dependencies are not available.
 *
 * Usage:
 * ```ts
 * const integration = createPipelineBudgetIntegration({
 *   budgetManager,
 *   auditChain,
 *   isEnabled: () => featureGateStore.getEffective('budget_stop_loss').enabled,
 * });
 *
 * // In run initiation:
 * if (integration && !integration.canInitiateRun()) {
 *   throw new Error('Daily budget stop-loss active');
 * }
 *
 * // After each LLM response:
 * const result = integration?.postResponseHook(runId, modelId, promptTokens, completionTokens);
 * if (result && !result.allowed) {
 *   // Terminate the pipeline run
 * }
 * ```
 */
export function createPipelineBudgetIntegration(
  options: PipelineBudgetIntegrationOptions,
): PipelineBudgetIntegration {
  return new PipelineBudgetIntegration(options);
}
