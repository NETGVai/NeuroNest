/**
 * Active_Model_Resolver — resolves the active model's context window length.
 *
 * A single resolver that budget-aware pipeline stages call to discover the
 * active provider's context window, so no call site duplicates
 * provider-introspection logic. Pairs with the Adaptive_Token_Budget
 * calculator (`token-budget.ts`): its result feeds `contextLength` into
 * `computeInputTokenBudget`.
 *
 * Resolution strategy (first match wins):
 *   1. Direct numeric fields on the provider, checked in order —
 *      `contextLength`, `maxContextTokens`, `capabilities.maxContextTokens`.
 *      The first finite positive value is returned.
 *   2. Provider-catalog lookup via `getProviderCapabilities(type)` when
 *      `type` names a known provider.
 *   3. Tier-router heuristic via `getModelContextWindow(type, model)` as a
 *      fallback for known providers.
 *   4. `0` — when the provider is missing, malformed, a primitive, an array,
 *      names an unknown provider, or its context length is otherwise
 *      undeterminable.
 *
 * Defensive: never throws for any input.
 *
 * Design: see `.kiro/specs/efficiency-improvements/design.md`
 * (Feature 2: Adaptive_Token_Budget).
 *
 * Validates: Requirement 11
 */

import { getProviderCapabilities } from './provider-catalog.js';
import { getModelContextWindow } from './tier-router.js';

/**
 * Return `value` when it is a finite positive number, otherwise `null`.
 * Used to gate every candidate so non-finite, zero, or negative readings
 * never leak into the resolved budget.
 */
function finitePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Read a direct numeric context-length field off a provider record.
 * Tolerates missing / non-numeric fields by returning `null`.
 */
function readDirectField(record: Record<string, unknown>, key: string): number | null {
  return finitePositive(record[key]);
}

/**
 * Resolve the active model's context window length.
 *
 * Pure and total — returns a non-negative integer for every input and never
 * throws. Returns `0` when the context length cannot be determined by any
 * strategy. An outer guard converts any unexpected throw (e.g. a hostile
 * throwing getter on the provider object) into `0`.
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.4
 */
export function getActiveContextLength(activeProvider: unknown): number {
  try {
    return resolveContextLength(activeProvider);
  } catch {
    return 0;
  }
}

/** Inner resolver. May throw on pathological inputs; the public wrapper guards it. */
function resolveContextLength(activeProvider: unknown): number {
  // Defensive guard: only plain (non-null, non-array) objects can carry the
  // fields we read. Primitives, null/undefined, and arrays resolve to 0.
  if (
    activeProvider === null ||
    typeof activeProvider !== 'object' ||
    Array.isArray(activeProvider)
  ) {
    return 0;
  }

  const provider = activeProvider as Record<string, unknown>;

  // Strategy 1 — direct numeric fields, checked in the documented order.
  // First finite positive value wins.
  const direct =
    readDirectField(provider, 'contextLength') ?? readDirectField(provider, 'maxContextTokens');
  if (direct !== null) {
    return Math.floor(direct);
  }

  // capabilities.maxContextTokens (nested), guarded against non-object shapes.
  const capabilities = provider['capabilities'];
  if (capabilities !== null && typeof capabilities === 'object' && !Array.isArray(capabilities)) {
    const nested = finitePositive((capabilities as Record<string, unknown>)['maxContextTokens']);
    if (nested !== null) {
      return Math.floor(nested);
    }
  }

  // Strategies 2 & 3 require a known provider type. A non-string or unknown
  // type is undeterminable → 0 (rather than the tier-router default).
  const type = provider['type'];
  if (typeof type !== 'string' || type.length === 0) {
    return 0;
  }

  // Strategy 2 — provider-catalog lookup. A non-null result means the type is
  // a known provider; its `maxContextTokens` is the catalog reading.
  const caps = getProviderCapabilities(type);
  if (caps === null) {
    // Unknown provider — do not fall through to the tier-router heuristic,
    // whose default would mask an undeterminable type.
    return 0;
  }
  const catalog = finitePositive(caps.maxContextTokens);
  if (catalog !== null) {
    return Math.floor(catalog);
  }

  // Strategy 3 — tier-router heuristic, factoring in the model name when present.
  const model = typeof provider['model'] === 'string' ? (provider['model'] as string) : undefined;
  const heuristic = finitePositive(getModelContextWindow(type, model));
  if (heuristic !== null) {
    return Math.floor(heuristic);
  }

  // Strategy 4 — undeterminable.
  return 0;
}
