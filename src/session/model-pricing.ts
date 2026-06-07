/**
 * Model Pricing Table — per-model token pricing configuration.
 *
 * Provides built-in defaults for common models, supports user overrides
 * via `model-pricing.json`, and calculates costs with 6 decimal place
 * precision using half-up rounding.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';

/**
 * Per-model token pricing rate.
 */
export interface ModelRate {
  /** Cost per million input tokens in USD (0.00–9999.99) */
  inputPerMillion: number;
  /** Cost per million output tokens in USD (0.00–9999.99) */
  outputPerMillion: number;
}

/**
 * Schema for the user-provided model-pricing.json file.
 */
export interface ModelPricingConfig {
  models?: Record<string, Partial<ModelRate>>;
  fallbackRate?: Partial<ModelRate>;
}

/**
 * Built-in default pricing for common models.
 */
export const DEFAULT_PRICING: Record<string, ModelRate> = {
  'gpt-4': { inputPerMillion: 30.00, outputPerMillion: 60.00 },
  'gpt-4o': { inputPerMillion: 2.50, outputPerMillion: 10.00 },
  'claude-sonnet': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'claude-opus': { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  'gemini-pro': { inputPerMillion: 1.25, outputPerMillion: 5.00 },
  'ollama/*': { inputPerMillion: 0.00, outputPerMillion: 0.00 },
};

/**
 * Default fallback rate for unknown models.
 */
export const DEFAULT_FALLBACK_RATE: ModelRate = {
  inputPerMillion: 0.00,
  outputPerMillion: 0.00,
};

/** Minimum valid rate value */
const RATE_MIN = 0.00;
/** Maximum valid rate value */
const RATE_MAX = 9999.99;

/**
 * Validates that a rate value is within the acceptable range [0.00, 9999.99].
 */
export function isValidRate(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(value) && value >= RATE_MIN && value <= RATE_MAX;
}

/**
 * Validates a ModelRate entry. Both inputPerMillion and outputPerMillion
 * must be valid numbers in range [0.00, 9999.99].
 */
export function isValidModelRate(rate: unknown): rate is ModelRate {
  if (rate === null || typeof rate !== 'object') {
    return false;
  }
  const r = rate as Record<string, unknown>;
  return isValidRate(r.inputPerMillion) && isValidRate(r.outputPerMillion);
}

/**
 * Model Pricing Table implementation.
 *
 * Manages per-model token pricing with built-in defaults, user overrides,
 * and wildcard pattern matching (e.g., 'ollama/*' matches 'ollama/llama3').
 */
export class ModelPricingTable {
  private rates: Record<string, ModelRate>;
  private fallbackRate: ModelRate;

  constructor() {
    this.rates = { ...DEFAULT_PRICING };
    this.fallbackRate = { ...DEFAULT_FALLBACK_RATE };
  }

  /**
   * Get the pricing rate for a model.
   *
   * Lookup order:
   * 1. Exact match in the pricing table
   * 2. Wildcard pattern match (e.g., 'ollama/*' matches 'ollama/llama3')
   * 3. Fallback rate (default 0.00/0.00)
   */
  getRate(modelId: string): ModelRate {
    // 1. Exact match
    if (this.rates[modelId]) {
      return { ...this.rates[modelId] };
    }

    // 2. Wildcard pattern match
    for (const pattern of Object.keys(this.rates)) {
      if (pattern.includes('*') && this.matchWildcard(pattern, modelId)) {
        return { ...this.rates[pattern] };
      }
    }

    // 3. Fallback rate
    logger.warn('Unknown model identifier, using fallback rate', { modelId });
    return { ...this.fallbackRate };
  }

  /**
   * Load user pricing overrides from a model-pricing.json file.
   *
   * User entries override matching model identifiers in the built-in defaults.
   * Non-matching built-in entries are preserved. Invalid entries are discarded
   * with a logged error; valid entries in the same file are still loaded.
   *
   * @param projectPath - Path to the project root containing model-pricing.json
   */
  loadUserPricing(projectPath: string): void {
    const filePath = join(projectPath, 'model-pricing.json');

    if (!existsSync(filePath)) {
      logger.info('No model-pricing.json found, using built-in defaults', { projectPath });
      return;
    }

    let fileContent: string;
    try {
      fileContent = readFileSync(filePath, 'utf-8');
    } catch (err) {
      logger.warn('Cannot read model-pricing.json, falling back to built-in defaults', {
        path: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let config: ModelPricingConfig;
    try {
      config = JSON.parse(fileContent);
    } catch (err) {
      logger.error('Invalid JSON in model-pricing.json, falling back to built-in defaults', {
        path: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Process model entries
    if (config.models && typeof config.models === 'object') {
      for (const [modelId, rateEntry] of Object.entries(config.models)) {
        if (rateEntry === null || typeof rateEntry !== 'object') {
          logger.error('Invalid rate entry for model, skipping', { modelId });
          continue;
        }

        const candidate: ModelRate = {
          inputPerMillion: (rateEntry as Record<string, unknown>).inputPerMillion as number,
          outputPerMillion: (rateEntry as Record<string, unknown>).outputPerMillion as number,
        };

        if (!isValidRate(candidate.inputPerMillion)) {
          logger.error('Invalid inputPerMillion rate for model, skipping', {
            modelId,
            value: candidate.inputPerMillion,
          });
          continue;
        }

        if (!isValidRate(candidate.outputPerMillion)) {
          logger.error('Invalid outputPerMillion rate for model, skipping', {
            modelId,
            value: candidate.outputPerMillion,
          });
          continue;
        }

        // Valid entry — override or add to the pricing table
        this.rates[modelId] = candidate;
      }
    }

    // Process fallback rate
    if (config.fallbackRate && typeof config.fallbackRate === 'object') {
      const fb = config.fallbackRate as Record<string, unknown>;
      const candidateFallback: ModelRate = {
        inputPerMillion: fb.inputPerMillion as number,
        outputPerMillion: fb.outputPerMillion as number,
      };

      if (isValidRate(candidateFallback.inputPerMillion) && isValidRate(candidateFallback.outputPerMillion)) {
        this.fallbackRate = candidateFallback;
      } else {
        logger.error('Invalid fallbackRate in model-pricing.json, using default fallback', {
          fallbackRate: config.fallbackRate,
        });
      }
    }
  }

  /**
   * Calculate the cost for a given model and token counts.
   *
   * Formula: (tokensIn * inputPerMillion + tokensOut * outputPerMillion) / 1_000_000
   * Result is rounded to 6 decimal places using half-up rounding.
   *
   * @param modelId - The model identifier
   * @param tokensIn - Number of input tokens (non-negative integer)
   * @param tokensOut - Number of output tokens (non-negative integer)
   * @returns Cost in USD rounded to 6 decimal places
   */
  calculateCost(modelId: string, tokensIn: number, tokensOut: number): number {
    const rate = this.getRate(modelId);
    const rawCost = (tokensIn * rate.inputPerMillion + tokensOut * rate.outputPerMillion) / 1_000_000;
    return roundHalfUp(rawCost, 6);
  }

  /**
   * Get the current fallback rate.
   */
  getFallbackRate(): ModelRate {
    return { ...this.fallbackRate };
  }

  /**
   * Get all currently loaded rates (built-in + user overrides).
   */
  getAllRates(): Record<string, ModelRate> {
    const result: Record<string, ModelRate> = {};
    for (const [key, value] of Object.entries(this.rates)) {
      result[key] = { ...value };
    }
    return result;
  }

  /**
   * Simple wildcard pattern matching.
   * Supports '*' as a match-any-sequence wildcard at the end of a pattern prefix.
   * E.g., 'ollama/*' matches 'ollama/llama3', 'ollama/mistral', etc.
   */
  private matchWildcard(pattern: string, value: string): boolean {
    // Handle trailing wildcard: 'prefix/*' matches 'prefix/anything'
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1); // 'ollama/'
      return value.startsWith(prefix);
    }

    // General wildcard: split on '*' and check segments match in order
    const segments = pattern.split('*');
    let pos = 0;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (segment === '') continue;

      const idx = value.indexOf(segment, pos);
      if (idx === -1) return false;

      // First segment must match at the start
      if (i === 0 && idx !== 0) return false;

      pos = idx + segment.length;
    }

    // Last segment must match at the end (if non-empty)
    const lastSegment = segments[segments.length - 1];
    if (lastSegment !== '' && !value.endsWith(lastSegment)) {
      return false;
    }

    return true;
  }
}

/**
 * Round a number to the specified decimal places using half-up rounding.
 *
 * This avoids floating-point issues by using the multiply-round-divide approach
 * with Number.EPSILON correction.
 */
export function roundHalfUp(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
