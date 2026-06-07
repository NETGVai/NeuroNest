/**
 * Model_Ranker — ranks candidate open models against a detected HardwareProfile.
 *
 * Part of the Hardware_Fit_Cookbook (Feature 8). The fit-scoring heuristics,
 * VRAM-need estimation and bandwidth-derived throughput model below are
 * original TypeScript implementations.
 *
 * Design notes
 * ------------
 * - Pure and deterministic: given a fixed `profile` (and identical `options`),
 *   `rankModels` always returns the same ordered array. No clock, no RNG, no
 *   I/O, no global state.
 * - The composite `score` blends three normalised components:
 *     fit (VRAM headroom) + speed (bandwidth-derived) + quality (params + quant).
 * - Results are sorted by `score` descending with a deterministic tie-break on
 *   `id` (ascending) so ordering is stable across runs.
 *
 * _Requirements: 44, 47_
 */

import type { HardwareProfile } from './hardware-detector.js';

/**
 * A candidate model scored against the supplied {@link HardwareProfile}.
 */
export interface RankedModel {
  /** Stable model identifier, e.g. `'llama-3.1-8b'`. */
  id: string;
  /** Parameter count in billions. */
  params_b: number;
  /** Quantisation label the row was evaluated at, e.g. `'Q4_K_M'`. */
  quant: string;
  /** How comfortably the model fits the detected hardware. */
  fit_level: 'perfect' | 'good' | 'marginal' | 'too_tight';
  /** Estimated VRAM (GB) required to serve the model at `quant`. */
  required_gb: number;
  /** Estimated decode throughput in tokens/sec (bandwidth-bound estimate). */
  speed_tps: number;
  /** Composite score (0–100, higher is better). */
  score: number;
}

/** Options accepted by {@link rankModels}. */
export interface RankModelsOptions {
  /** Optional use-case tag to filter the candidate catalog (e.g. `'coding'`). */
  useCase?: string;
  /** Quantisation to evaluate every candidate at. Defaults to `'Q4_K_M'`. */
  quant?: string;
  /** Maximum number of rows to return (after sorting). */
  limit?: number;
  /** When `true`, omit `too_tight` rows from the result. */
  fitOnly?: boolean;
}

/** A model in the built-in candidate catalog. */
interface CandidateModel {
  id: string;
  params_b: number;
  /**
   * Whether the model uses a mixture-of-experts architecture. MoE models have
   * a much smaller active-parameter footprint, so their throughput is governed
   * by active params rather than total params.
   */
  moe?: boolean;
  /** Active parameters in billions for MoE models (read weights per token). */
  active_params_b?: number;
  /** Use-case tags. `'general'` matches any requested `useCase`. */
  useCases: string[];
}

/**
 * Bits-per-weight for common llama.cpp quantisation schemes. Values include
 * the small overhead k-quants carry over their nominal bit width. Used to
 * convert a parameter count into an on-device weight size.
 */
const QUANT_BITS: Readonly<Record<string, number>> = {
  Q2_K: 2.6,
  Q3_K_S: 3.0,
  Q3_K_M: 3.4,
  Q4_0: 4.5,
  Q4_K_S: 4.3,
  Q4_K_M: 4.8,
  Q5_K_M: 5.5,
  Q6_K: 6.6,
  Q8_0: 8.5,
  F16: 16,
  FP16: 16,
};

/** Fallback bits-per-weight when a quant label is unknown. */
const DEFAULT_QUANT_BITS = 4.8;

/** Default quantisation evaluated when the caller does not specify one. */
const DEFAULT_QUANT = 'Q4_K_M';

/**
 * Fixed non-weight VRAM overhead in GB (CUDA/Metal context, scratch buffers).
 * Mirrors the runtime-buffer constant used by the profile generator.
 */
const RUNTIME_OVERHEAD_GB = 0.8;

/**
 * KV-cache provisioning as a fraction of weight size. A coarse but stable
 * proxy for a moderate context window without requiring an explicit `ctx`.
 */
const KV_FRACTION = 0.12;

/**
 * Assumed effective memory bandwidth (GB/s) when no GPU bandwidth is known
 * (CPU / unified-memory fallback). Keeps `speed_tps` finite and deterministic.
 */
const FALLBACK_BANDWIDTH_GBPS = 50;

/** Composite score component weights (sum to 1). */
const WEIGHT_FIT = 0.4;
const WEIGHT_SPEED = 0.3;
const WEIGHT_QUALITY = 0.3;

/** Throughput (tps) treated as "fast enough" for full speed credit. */
const SPEED_SATURATION_TPS = 80;

/** Parameter count (billions) treated as "large enough" for full quality credit. */
const QUALITY_PARAM_SATURATION_B = 70;

/**
 * Built-in catalog of common open-weight models. Kept intentionally compact and
 * representative rather than exhaustive. `params_b` is the published parameter
 * count; MoE entries also carry `active_params_b`.
 */
const CANDIDATE_MODELS: readonly CandidateModel[] = [
  { id: 'llama-3.2-1b', params_b: 1.23, useCases: ['general', 'chat'] },
  { id: 'llama-3.2-3b', params_b: 3.21, useCases: ['general', 'chat'] },
  { id: 'llama-3.1-8b', params_b: 8.03, useCases: ['general', 'chat', 'coding'] },
  { id: 'llama-3.3-70b', params_b: 70.6, useCases: ['general', 'chat', 'coding', 'reasoning'] },
  { id: 'qwen2.5-0.5b', params_b: 0.49, useCases: ['general'] },
  { id: 'qwen2.5-1.5b', params_b: 1.54, useCases: ['general', 'chat'] },
  { id: 'qwen2.5-3b', params_b: 3.09, useCases: ['general', 'chat'] },
  { id: 'qwen2.5-7b', params_b: 7.62, useCases: ['general', 'chat', 'coding'] },
  { id: 'qwen2.5-14b', params_b: 14.8, useCases: ['general', 'coding', 'reasoning'] },
  { id: 'qwen2.5-32b', params_b: 32.5, useCases: ['general', 'coding', 'reasoning'] },
  { id: 'qwen2.5-72b', params_b: 72.7, useCases: ['general', 'coding', 'reasoning'] },
  { id: 'qwen2.5-coder-7b', params_b: 7.62, useCases: ['coding'] },
  { id: 'qwen2.5-coder-32b', params_b: 32.5, useCases: ['coding'] },
  { id: 'gemma-2-2b', params_b: 2.61, useCases: ['general', 'chat'] },
  { id: 'gemma-2-9b', params_b: 9.24, useCases: ['general', 'chat'] },
  { id: 'gemma-2-27b', params_b: 27.2, useCases: ['general', 'chat', 'reasoning'] },
  { id: 'mistral-7b', params_b: 7.25, useCases: ['general', 'chat'] },
  { id: 'phi-3-mini', params_b: 3.82, useCases: ['general', 'reasoning'] },
  { id: 'phi-3-medium', params_b: 14.0, useCases: ['general', 'reasoning'] },
  {
    id: 'mixtral-8x7b',
    params_b: 46.7,
    moe: true,
    active_params_b: 12.9,
    useCases: ['general', 'reasoning'],
  },
  {
    id: 'deepseek-coder-v2-lite-16b',
    params_b: 15.7,
    moe: true,
    active_params_b: 2.4,
    useCases: ['coding'],
  },
];

/** Resolve bits-per-weight for a quant label (case-insensitive). */
function quantBits(quant: string): number {
  const key = quant.trim().toUpperCase();
  return QUANT_BITS[key] ?? DEFAULT_QUANT_BITS;
}

/**
 * Estimate VRAM (GB) required to serve `params_b` billion parameters at the
 * given bits-per-weight, including a KV-cache allowance and fixed runtime
 * overhead. Weight bytes = params * (bits / 8); params_b is in billions so the
 * 1e9 and 1e9-byte-per-GB factors cancel.
 */
function estimateRequiredGb(params_b: number, bits: number): number {
  const weightGb = params_b * (bits / 8);
  return weightGb * (1 + KV_FRACTION) + RUNTIME_OVERHEAD_GB;
}

/**
 * Classify how comfortably `required_gb` fits within `availableGb`.
 * Thresholds are expressed as fractions of available memory.
 */
function classifyFit(
  required_gb: number,
  availableGb: number,
): RankedModel['fit_level'] {
  if (availableGb <= 0 || required_gb > availableGb) {
    return 'too_tight';
  }
  const ratio = required_gb / availableGb;
  if (ratio <= 0.6) return 'perfect';
  if (ratio <= 0.8) return 'good';
  return 'marginal';
}

/**
 * Bandwidth-bound throughput estimate. A decode step reads the active weight
 * set once, so tokens/sec ≈ bandwidth / active-weight-size.
 */
function estimateSpeedTps(activeWeightGb: number, bandwidthGBps: number): number {
  const effectiveBw = bandwidthGBps > 0 ? bandwidthGBps : FALLBACK_BANDWIDTH_GBPS;
  if (activeWeightGb <= 0) return 0;
  return effectiveBw / activeWeightGb;
}

/** Clamp a value into the inclusive [0, 1] range. */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Round to a fixed number of decimal places without floating-point drift. */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Rank candidate models against the supplied hardware profile.
 *
 * Each model is scored on a composite of fit (VRAM headroom), speed
 * (bandwidth-derived throughput) and quality (parameter count and quant
 * fidelity). Results are sorted by score descending with a deterministic
 * tie-break on `id`.
 *
 * @param profile Detected hardware. When `vramGB` is 0 (no GPU detected), fit
 *   is computed against system `ramGB` as a CPU/unified-memory fallback.
 * @param options Optional filters and tuning. See {@link RankModelsOptions}.
 * @returns A new array of {@link RankedModel} rows (never mutates inputs).
 *
 * _Requirements: 44.1, 44.2, 44.3_
 */
export function rankModels(
  profile: HardwareProfile,
  options?: RankModelsOptions,
): RankedModel[] {
  const opts = options ?? {};
  const quant = opts.quant && opts.quant.trim().length > 0 ? opts.quant : DEFAULT_QUANT;
  const bits = quantBits(quant);

  // Available memory for fit: prefer dedicated VRAM, fall back to system RAM.
  const availableGb = profile.vramGB > 0 ? profile.vramGB : profile.ramGB;
  const bandwidth = profile.gpuBandwidthGBps;

  const useCase = opts.useCase?.trim().toLowerCase();

  const ranked: RankedModel[] = CANDIDATE_MODELS
    .filter((m) => {
      if (!useCase) return true;
      return m.useCases.some((tag) => tag === 'general' || tag.toLowerCase() === useCase);
    })
    .map((m) => {
      const required_gb = estimateRequiredGb(m.params_b, bits);
      const fit_level = classifyFit(required_gb, availableGb);

      // MoE models only read their active expert set per token.
      const activeParams = m.moe && m.active_params_b ? m.active_params_b : m.params_b;
      const activeWeightGb = activeParams * (bits / 8);
      const speed_tps = round(estimateSpeedTps(activeWeightGb, bandwidth), 1);

      // --- Composite score components (each normalised to [0, 1]) ---
      // Fit: more headroom is better; too_tight scores 0.
      const fitComponent =
        fit_level === 'too_tight' ? 0 : clamp01((availableGb - required_gb) / availableGb);
      // Speed: saturating toward an "interactive" throughput target.
      const speedComponent = clamp01(speed_tps / SPEED_SATURATION_TPS);
      // Quality: parameter scale plus quant fidelity.
      const paramQuality = clamp01(m.params_b / QUALITY_PARAM_SATURATION_B);
      const quantQuality = clamp01(bits / 16);
      const qualityComponent = clamp01(0.7 * paramQuality + 0.3 * quantQuality);

      const score = round(
        100 *
          (WEIGHT_FIT * fitComponent +
            WEIGHT_SPEED * speedComponent +
            WEIGHT_QUALITY * qualityComponent),
        1,
      );

      return {
        id: m.id,
        params_b: m.params_b,
        quant,
        fit_level,
        required_gb: round(required_gb, 2),
        speed_tps,
        score,
      };
    });

  const filtered = opts.fitOnly ? ranked.filter((r) => r.fit_level !== 'too_tight') : ranked;

  // Sort by score descending; deterministic tie-break on id ascending.
  filtered.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  if (typeof opts.limit === 'number' && opts.limit >= 0) {
    return filtered.slice(0, Math.floor(opts.limit));
  }
  return filtered;
}
