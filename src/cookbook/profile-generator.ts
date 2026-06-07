/**
 * Profile_Generator — F8 Hardware_Fit_Cookbook.
 *
 * Turns a (HardwareProfile, ModelDescriptor) pair into ready-to-launch
 * llama.cpp serve presets so a user does not have to hand-tune offload and
 * cache flags. Three presets are produced — Quality, Balanced, Speed — each a
 * concrete set of llama.cpp launch flags (`n_gpu_layers`, `n_cpu_moe`,
 * `cache_type`, `ctx`) plus an estimated VRAM footprint and a `fits` verdict.
 *
 * Algorithm (see design.md → Feature 8 → "Profile_Generator Algorithm"):
 *   For weights `W_GB` (params × bits-per-weight) and KV-cache cost
 *   `KV_GB(ctx, cache_type)`:
 *     1. Total VRAM need = W_GB + KV_GB + RUNTIME_BUFFER_GB.
 *     2. If need ≤ profile.vramGB → fits fully, n_cpu_moe = 0, n_gpu_layers = 999.
 *     3. For MoE: n_cpu_moe = ceil(overflow / per_expert_layer) to spill
 *        expert tensors to CPU, lowering the GPU-resident estimate.
 *     4. Quality preset: highest quant (Q6/Q8) that fits, f16 KV, large ctx.
 *     5. Balanced preset: Q4_K_M baseline, q8_0 KV, medium ctx.
 *     6. Speed preset: smallest quant (Q3) for throughput, q4_0 KV, small ctx.
 *
 * Contract: pure and deterministic. Given identical inputs the output array is
 * always identical — no clock, no RNG, no I/O, no global state. The function
 * never throws; structurally invalid inputs degrade to an empty array.
 *
 * Fit semantics (Requirement 45.2, 45.3): every candidate preset is evaluated
 * against the hardware. Only presets that fit (`est_vram_gb ≤ profile.vramGB`)
 * are returned, in Quality → Balanced → Speed order. When no preset fits — for
 * example when no GPU is detected (`vramGB = 0`) — an empty array is returned.
 *
 * Requirements: 45, 47
 */

import type { HardwareProfile } from './hardware-detector.js';

/**
 * A llama.cpp serve preset computed for a specific model + hardware pair. The
 * numeric fields map directly onto llama.cpp launch flags.
 */
export interface ServeProfile {
  /** Stable preset key. */
  key: 'quality' | 'balanced' | 'speed';
  /** Human-facing label (`'Quality' | 'Balanced' | 'Speed'`). */
  label: string;
  /** Quantisation the preset recommends downloading/serving, e.g. `'Q4_K_M'`. */
  quant: string;
  /** `--n-gpu-layers`; `999` requests offloading every layer to the GPU. */
  n_gpu_layers: number;
  /**
   * `--n-cpu-moe`; number of layers whose MoE expert tensors are kept on the
   * CPU. Always `0` for dense (non-MoE) models.
   */
  n_cpu_moe: number;
  /** `--cache-type-k/-v`; KV-cache precision. */
  cache_type: 'q4_0' | 'q8_0' | 'f16';
  /** `--ctx-size`; context window in tokens. */
  ctx: number;
  /** Estimated GPU-resident VRAM (GB) after any MoE expert offload. */
  est_vram_gb: number;
  /** Whether `est_vram_gb` fits within `profile.vramGB`. */
  fits: boolean;
}

/**
 * Minimal description of a model the cookbook reasons about. There is no
 * existing type in the codebase that captures this, so it is defined and
 * exported here.
 */
export interface ModelDescriptor {
  /** Stable model identifier, e.g. `'qwen2.5-7b'`. */
  id: string;
  /** Total parameter count in billions. */
  params_b: number;
  /**
   * The model's reference/native quantisation (e.g. the quant of the available
   * GGUF). Informational — each preset chooses its own quant for the
   * recommendation; this is not a hard upper bound.
   */
  quant: string;
  /** Transformer layer count. Used for per-layer MoE offload math. */
  n_layers?: number;
  /** Whether the model uses a mixture-of-experts architecture. */
  isMoE?: boolean;
  /** Number of experts per MoE layer (informational; not required for math). */
  n_experts?: number;
}

/** Fixed non-weight VRAM overhead in GB (CUDA/Metal context, scratch buffers). */
const RUNTIME_BUFFER_GB = 0.6;

/**
 * `--n-gpu-layers` value that asks llama.cpp to offload every layer to the GPU.
 * llama.cpp treats any value ≥ the model's layer count as "all layers".
 */
const ALL_GPU_LAYERS = 999;

/** Default transformer layer count when a descriptor omits `n_layers`. */
const DEFAULT_LAYERS = 32;

/**
 * Fraction of an MoE model's weights that live in expert tensors. MoE models
 * are dominated by experts, so spilling them to CPU frees most of the VRAM.
 */
const MOE_EXPERT_FRACTION = 0.9;

/**
 * Bits-per-weight for the quant labels the presets use. Values include the
 * small overhead k-quants carry over their nominal bit width. Mirrors the
 * model-ranker table for cross-module consistency.
 */
const QUANT_BITS: Readonly<Record<string, number>> = {
  Q2_K: 2.6,
  Q3_K_M: 3.4,
  Q4_K_M: 4.8,
  Q6_K: 6.6,
  Q8_0: 8.5,
};

/**
 * KV-cache size relative to an f16 cache, keyed by `cache_type`. q8_0 halves
 * the f16 cost; q4_0 roughly quarters it (with a little k-quant overhead).
 */
const CACHE_FACTOR: Readonly<Record<ServeProfile['cache_type'], number>> = {
  f16: 1.0,
  q8_0: 0.5,
  q4_0: 0.28,
};

/**
 * KV-cache coefficient (GB per billion params per context token at f16).
 * Calibrated so a 7B model at 8K context with an f16 cache lands near ~1.7 GB,
 * a reasonable GQA-era estimate. Deterministic and monotonic in params/ctx.
 */
const KV_COEFF_GB = 3e-5;

/** Round to a fixed number of decimal places without floating-point drift. */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Resolve bits-per-weight for a quant label (case-insensitive). */
function quantBits(quant: string): number {
  return QUANT_BITS[quant.trim().toUpperCase()] ?? QUANT_BITS.Q4_K_M;
}

/** On-device weight size (GB) for `params_b` billion params at `quant`. */
function weightGb(params_b: number, quant: string): number {
  return params_b * (quantBits(quant) / 8);
}

/** Estimated KV-cache size (GB) for the given context and cache precision. */
function kvCacheGb(
  params_b: number,
  ctx: number,
  cacheType: ServeProfile['cache_type'],
): number {
  return params_b * ctx * KV_COEFF_GB * CACHE_FACTOR[cacheType];
}

/** Static shape of a preset before hardware-dependent fields are filled in. */
interface PresetSpec {
  key: ServeProfile['key'];
  label: string;
  /** Candidate quants in descending fidelity; the highest that fits is used. */
  quantCandidates: readonly string[];
  cache_type: ServeProfile['cache_type'];
  ctx: number;
}

/**
 * The three preset shapes. Quality favours fidelity (high quant, f16 cache,
 * large context); Speed favours throughput (low quant, q4_0 cache, small
 * context); Balanced sits between them.
 */
const PRESETS: readonly PresetSpec[] = [
  {
    key: 'quality',
    label: 'Quality',
    quantCandidates: ['Q8_0', 'Q6_K'],
    cache_type: 'f16',
    ctx: 16384,
  },
  {
    key: 'balanced',
    label: 'Balanced',
    quantCandidates: ['Q4_K_M'],
    cache_type: 'q8_0',
    ctx: 8192,
  },
  {
    key: 'speed',
    label: 'Speed',
    quantCandidates: ['Q3_K_M'],
    cache_type: 'q4_0',
    ctx: 4096,
  },
];

/**
 * Compute the GPU-resident VRAM estimate and MoE offload count for one quant
 * choice on the given hardware.
 *
 * For MoE models the expert tensors are spilled to CPU one layer at a time
 * (`n_cpu_moe = ceil(overflow / per_expert_layer)`) until the residual fits or
 * every expert layer has been offloaded. Dense models never offload experts
 * (`n_cpu_moe = 0`).
 */
function evaluateQuant(
  profile: HardwareProfile,
  model: ModelDescriptor,
  quant: string,
  cacheType: ServeProfile['cache_type'],
  ctx: number,
): { est_vram_gb: number; n_cpu_moe: number; fits: boolean } {
  const wGb = weightGb(model.params_b, quant);
  const kvGb = kvCacheGb(model.params_b, ctx, cacheType);
  const need = wGb + kvGb + RUNTIME_BUFFER_GB;

  // Dense models: no expert offload available.
  if (!model.isMoE) {
    const est = round(need, 2);
    return { est_vram_gb: est, n_cpu_moe: 0, fits: est <= profile.vramGB };
  }

  // MoE: spill expert tensors to CPU to cover any overflow.
  const layers = Math.max(1, Math.floor(model.n_layers ?? DEFAULT_LAYERS));
  const expertGb = wGb * MOE_EXPERT_FRACTION;
  const perLayerGb = expertGb / layers;

  const overflow = need - profile.vramGB;
  let n_cpu_moe = 0;
  if (overflow > 0 && perLayerGb > 0) {
    n_cpu_moe = Math.min(layers, Math.ceil(overflow / perLayerGb));
  }

  const est = round(need - n_cpu_moe * perLayerGb, 2);
  return { est_vram_gb: est, n_cpu_moe, fits: est <= profile.vramGB };
}

/**
 * Compute up to three llama.cpp serve presets (Quality, Balanced, Speed) for
 * `model` on `profile`.
 *
 * Each preset picks the highest-fidelity quant in its candidate list that fits
 * the hardware (Quality tries Q8_0 then Q6_K; Balanced and Speed have a single
 * quant). MoE models offload expert tensors to CPU via `n_cpu_moe` when VRAM is
 * tight; dense models always report `n_cpu_moe = 0`.
 *
 * Only presets whose estimated footprint fits `profile.vramGB` are returned, in
 * Quality → Balanced → Speed order. When nothing fits (including the no-GPU
 * `vramGB = 0` case) an empty array is returned (Requirement 45.3).
 *
 * Pure, deterministic, and never throws.
 *
 * @param profile Detected hardware. `vramGB` is the fit budget.
 * @param model   The model to generate presets for.
 * @returns A new array of fitting {@link ServeProfile} rows (never mutates inputs).
 *
 * _Requirements: 45.1, 45.2, 45.3_
 */
export function computeServeProfiles(
  profile: HardwareProfile,
  model: ModelDescriptor,
): ServeProfile[] {
  // Defensive guards — degrade to empty rather than throwing (cookbook ethos).
  if (
    !profile ||
    !model ||
    !Number.isFinite(profile.vramGB) ||
    profile.vramGB <= 0 ||
    !Number.isFinite(model.params_b) ||
    model.params_b <= 0
  ) {
    return [];
  }

  const profiles: ServeProfile[] = [];

  for (const spec of PRESETS) {
    // Pick the highest-fidelity candidate quant that fits; fall back to the
    // lowest candidate (which is then filtered out if it still does not fit).
    let chosen = evaluateQuant(
      profile,
      model,
      spec.quantCandidates[spec.quantCandidates.length - 1],
      spec.cache_type,
      spec.ctx,
    );
    let chosenQuant = spec.quantCandidates[spec.quantCandidates.length - 1];

    for (const quant of spec.quantCandidates) {
      const evaluated = evaluateQuant(profile, model, quant, spec.cache_type, spec.ctx);
      if (evaluated.fits) {
        chosen = evaluated;
        chosenQuant = quant;
        break;
      }
    }

    profiles.push({
      key: spec.key,
      label: spec.label,
      quant: chosenQuant,
      n_gpu_layers: ALL_GPU_LAYERS,
      n_cpu_moe: chosen.n_cpu_moe,
      cache_type: spec.cache_type,
      ctx: spec.ctx,
      est_vram_gb: chosen.est_vram_gb,
      fits: chosen.fits,
    });
  }

  // Requirement 45.3: return only fitting presets; empty when none fit.
  return profiles.filter((p) => p.fits);
}
