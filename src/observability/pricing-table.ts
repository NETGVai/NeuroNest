/**
 * Default Pricing Table — Known provider/model pricing for cost tracking.
 *
 * Provides sensible defaults for known providers (OpenAI, Anthropic, Google, Mistral)
 * with USD per 1M input/output tokens. Users can override via a JSON configuration file
 * that is hot-reloadable without restart (Req 1.7).
 *
 * Requirements: 1.1, 1.7
 */

import type { PricingEntry } from './cost-tracking-service.js';

/**
 * Build a composite key for the pricing table lookup.
 * Format: "provider:model" (lowercased for case-insensitive matching).
 */
export function buildPricingKey(provider: string, model: string): string {
  return `${provider.toLowerCase()}:${model.toLowerCase()}`;
}

/**
 * Default pricing entries for known providers.
 * Prices are approximate USD per 1M tokens as of mid-2024.
 * Users should update via their own pricing JSON for accuracy.
 */
export const DEFAULT_PRICING_ENTRIES: PricingEntry[] = [
  // OpenAI
  { provider: 'openai', model: 'gpt-4o', inputPer1M: 2.50, outputPer1M: 10.00 },
  { provider: 'openai', model: 'gpt-4o-mini', inputPer1M: 0.15, outputPer1M: 0.60 },
  { provider: 'openai', model: 'gpt-4-turbo', inputPer1M: 10.00, outputPer1M: 30.00 },
  { provider: 'openai', model: 'gpt-4', inputPer1M: 30.00, outputPer1M: 60.00 },
  { provider: 'openai', model: 'gpt-3.5-turbo', inputPer1M: 0.50, outputPer1M: 1.50 },
  { provider: 'openai', model: 'o1', inputPer1M: 15.00, outputPer1M: 60.00 },
  { provider: 'openai', model: 'o1-mini', inputPer1M: 3.00, outputPer1M: 12.00 },

  // Anthropic
  { provider: 'anthropic', model: 'claude-sonnet-4-20250514', inputPer1M: 3.00, outputPer1M: 15.00 },
  { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', inputPer1M: 3.00, outputPer1M: 15.00 },
  { provider: 'anthropic', model: 'claude-3-5-haiku-20241022', inputPer1M: 0.80, outputPer1M: 4.00 },
  { provider: 'anthropic', model: 'claude-3-opus-20240229', inputPer1M: 15.00, outputPer1M: 75.00 },

  // Google
  { provider: 'google', model: 'gemini-1.5-pro', inputPer1M: 3.50, outputPer1M: 10.50 },
  { provider: 'google', model: 'gemini-1.5-flash', inputPer1M: 0.075, outputPer1M: 0.30 },
  { provider: 'google', model: 'gemini-2.0-flash', inputPer1M: 0.10, outputPer1M: 0.40 },
  { provider: 'google', model: 'gemini-pro', inputPer1M: 0.50, outputPer1M: 1.50 },

  // Mistral
  { provider: 'mistral', model: 'mistral-large', inputPer1M: 2.00, outputPer1M: 6.00 },
  { provider: 'mistral', model: 'mistral-medium', inputPer1M: 2.70, outputPer1M: 8.10 },
  { provider: 'mistral', model: 'mistral-small', inputPer1M: 0.20, outputPer1M: 0.60 },
  { provider: 'mistral', model: 'codestral', inputPer1M: 0.20, outputPer1M: 0.60 },
];

/**
 * Build a pricing table Map from an array of PricingEntry items.
 */
export function buildPricingTable(entries: PricingEntry[]): Map<string, PricingEntry> {
  const table = new Map<string, PricingEntry>();
  for (const entry of entries) {
    const key = buildPricingKey(entry.provider, entry.model);
    table.set(key, entry);
  }
  return table;
}
