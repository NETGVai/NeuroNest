/**
 * Cost Calculator — Pure module for computing LLM API call costs.
 * Reads bundled pricing data and computes USD cost from token counts.
 */

import * as fs from 'fs';
import * as path from 'path';

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
      if (modelLower.startsWith(modelKeys[i].toLowerCase())) {
        entry = providerEntry[modelKeys[i]];
        break;
      }
    }
    // Try: a known key starts with the model (e.g. model="claude-3-5-sonnet" matches "claude-3-5-sonnet-20241022")
    if (!entry) {
      for (let i = 0; i < modelKeys.length; i++) {
        if (modelKeys[i].toLowerCase().startsWith(modelLower)) {
          entry = providerEntry[modelKeys[i]];
          break;
        }
      }
    }
    // Try: model contains a known key or vice versa
    if (!entry) {
      for (let i = 0; i < modelKeys.length; i++) {
        if (modelLower.includes(modelKeys[i].toLowerCase()) || modelKeys[i].toLowerCase().includes(modelLower)) {
          entry = providerEntry[modelKeys[i]];
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
