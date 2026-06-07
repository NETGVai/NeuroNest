/**
 * Adaptive Token Budget — pure calculator for the input token budget.
 *
 * A single side-effect-free function that all budget-aware pipeline stages
 * share, replacing the ad-hoc hard-coded budgets previously scattered across
 * compressors, condensers, loaders, and isolators. It reproduces today's
 * behavior when no explicit `inputBudget` setting is present, so it ships
 * unconditionally (no feature flag).
 *
 * Design: see `.kiro/specs/efficiency-improvements/design.md`
 * (Feature 2: Adaptive_Token_Budget).
 *
 * Validates: Requirements 7, 8, 9, 10, 12.2, 12.3
 */

/** Default budget used when no context length or configured value is known. */
export const DEFAULT_BUDGET = 6000;
/** Fraction of a model's context window reserved for input during adaptive sizing. */
export const DEFAULT_HEADROOM = 0.85;
/** Absolute ceiling for any computed budget, regardless of model capacity. */
export const DEFAULT_HARD_MAX = 200_000;

export interface BudgetOptions {
  default?: number;
  headroom?: number;
  hardMax?: number;
}

/**
 * Coerce an arbitrary numeric input to a finite number.
 * Non_Finite inputs (`NaN`, `+Infinity`, `-Infinity`) become `0`.
 */
function toFinite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Resolve an opts field: substitute the documented default when the supplied
 * value is Non_Finite or `<= 0`.
 */
function resolveOption(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Clamp `value` to the inclusive range `[lo, hi]`. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Compute the input token budget for a pipeline stage.
 *
 * Pure function — no I/O, no flag reads, no clock. Never throws for any
 * numeric input. Always returns an integer in `[1, hardMax]`.
 *
 * Branch table (after Non_Finite coercion of `configured`/`contextLength`):
 *   explicit=true,  contextLength>0  → clamp(min(configured, contextLength), 1, hardMax)
 *   explicit=true,  contextLength<=0 → clamp(configured, 1, hardMax)
 *   explicit=false, contextLength>0  → min(hardMax, floor(headroom * contextLength))
 *   explicit=false, contextLength<=0 → clamp(configured>0 ? configured : default, 1, hardMax)
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 9.1, 9.2, 9.3,
 * 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
 */
export function computeInputTokenBudget(
  configured: number,
  contextLength: number,
  explicit: boolean,
  opts?: BudgetOptions,
): number {
  // Resolve options, substituting defaults for any Non_Finite or <= 0 field.
  const defaultBudget = resolveOption(opts?.default, DEFAULT_BUDGET);
  const headroom = resolveOption(opts?.headroom, DEFAULT_HEADROOM);
  const hardMax = resolveOption(opts?.hardMax, DEFAULT_HARD_MAX);

  // Coerce Non_Finite numeric inputs to 0 before applying the branch table.
  const cfg = toFinite(configured);
  const ctx = toFinite(contextLength);

  let raw: number;
  if (explicit) {
    raw =
      ctx > 0
        ? clamp(Math.min(cfg, ctx), 1, hardMax)
        : clamp(cfg, 1, hardMax);
  } else {
    raw =
      ctx > 0
        ? Math.min(hardMax, Math.floor(headroom * ctx))
        : clamp(cfg > 0 ? cfg : defaultBudget, 1, hardMax);
  }

  // Final safety net: integer, never below 1, never above hardMax.
  return Math.max(1, Math.floor(Math.min(raw, hardMax)));
}

/**
 * Adapt the persisted `inputBudget` setting into calculator inputs.
 *
 * A positive finite `inputBudget` is treated as an explicit override; anything
 * else (`null` / `undefined` / absent / `<= 0` / Non_Finite) maps to adaptive
 * sizing with no configured value.
 *
 * Validates: Requirements 12.2, 12.3
 */
export function resolveBudgetInputs(
  inputBudget: number | null | undefined,
): { configured: number; explicit: boolean } {
  if (typeof inputBudget === 'number' && Number.isFinite(inputBudget) && inputBudget > 0) {
    return { configured: inputBudget, explicit: true };
  }
  return { configured: 0, explicit: false };
}
