/**
 * Training Cost Estimator — Server-side resource estimation for training jobs.
 *
 * Provides accurate estimations for:
 *   - Training time (ms)
 *   - Peak VRAM usage (MB)
 *   - Power consumption (kWh)
 *   - Disk space for checkpoints and output model (MB)
 *
 * Estimations are based on:
 *   - Model size (parameter count)
 *   - Dataset size (sample count + tokens per sample)
 *   - Training method (lora, qlora, full-finetune)
 *   - Number of epochs
 *   - Detected hardware capabilities (HardwareProfile)
 *
 * Integrates with the existing Cost_Tracker for per-session breakdown so training
 * costs appear alongside other session costs (LLM calls, etc.).
 *
 * Requirements: 21.1, 21.2, 21.3
 */

import type { HardwareProfile } from '../hardware/hardware-detector.js';
import type { CostTracker } from '../../pipeline/subagent-spawner.js';

// ─── Types ──────────────────────────────────────────────────────

/** Training method supported by the cost estimator */
export type TrainingMethod = 'lora' | 'qlora' | 'full-finetune';

/**
 * Input parameters for a cost estimation.
 */
export interface CostEstimationInput {
  /** Model parameter count (e.g., 7e9 for a 7B model) */
  modelSizeParams: number;
  /** Number of training samples in the dataset */
  datasetSamples: number;
  /** Average tokens per sample (default: 512) */
  tokensPerSample?: number;
  /** Training method */
  method: TrainingMethod;
  /** Number of training epochs */
  epochs: number;
  /** Batch size */
  batchSize: number;
  /** Gradient accumulation steps (default: 1) */
  gradientAccumulationSteps?: number;
  /** Detected hardware profile */
  hardware: HardwareProfile;
  /** LoRA rank (relevant for lora/qlora methods) */
  loraRank?: number;
  /** Quantization type for output model (affects disk estimate) */
  quantization?: 'q4_0' | 'q4_1' | 'q5_0' | 'q5_1' | 'q8_0' | 'f16';
  /** Maximum checkpoints retained (default: 3) */
  maxCheckpoints?: number;
}

/**
 * Result of a cost estimation.
 */
export interface CostEstimationResult {
  /** Estimated total training time in milliseconds */
  estimatedTimeMs: number;
  /** Estimated peak VRAM usage in megabytes */
  peakVramMB: number;
  /** Estimated power consumption in kilowatt-hours */
  powerConsumptionKWh: number;
  /** Estimated disk space in megabytes (checkpoints + output) */
  diskSpaceMB: number;
  /** Breakdown of disk space */
  diskBreakdown: {
    checkpointsMB: number;
    outputModelMB: number;
  };
  /** Estimated total training steps */
  totalSteps: number;
  /** Estimated tokens per second throughput */
  estimatedTokensPerSec: number;
  /** Whether the estimated VRAM exceeds available hardware memory */
  vramExceedsAvailable: boolean;
  /** Available VRAM/memory on the hardware (MB) */
  availableMemoryMB: number;
}

/**
 * A cost record for integration with the Cost_Tracker system.
 */
export interface TrainingCostRecord {
  /** Session identifier for Cost_Tracker */
  sessionId: string;
  /** Estimated cost in USD (compute-equivalent, power-based) */
  estimatedCostUSD: number;
  /** Metadata for the cost entry */
  metadata: {
    type: 'training-estimate';
    method: TrainingMethod;
    modelSizeParams: number;
    datasetSamples: number;
    epochs: number;
    estimatedTimeMs: number;
    peakVramMB: number;
    powerConsumptionKWh: number;
    diskSpaceMB: number;
  };
}

// ─── Constants ──────────────────────────────────────────────────

/**
 * VRAM multipliers for each training method relative to model memory footprint.
 * - lora: ~20% of full model VRAM (only adapter weights + activations)
 * - qlora: ~12% of full model VRAM (4-bit quantized base + adapter)
 * - full-finetune: ~100% of full model VRAM (full precision weights + optimizer)
 */
const VRAM_METHOD_MULTIPLIERS: Record<TrainingMethod, number> = {
  'lora': 0.20,
  'qlora': 0.12,
  'full-finetune': 1.0,
};

/**
 * Additional per-batch-sample VRAM overhead factor.
 * Each sample in a batch requires ~5% of model memory for activations/gradients.
 */
const VRAM_PER_SAMPLE_FACTOR = 0.05;

/**
 * Minimum VRAM baseline (MB) to account for framework overhead.
 */
const MINIMUM_VRAM_MB = 512;

/**
 * Optimizer memory multiplier for full fine-tuning.
 * AdamW requires 2x model size (momentum + variance states).
 */
const OPTIMIZER_MULTIPLIER_FULL = 2.0;

/**
 * Optimizer memory multiplier for LoRA/QLoRA (only adapter params).
 */
const OPTIMIZER_MULTIPLIER_LORA = 0.1;

/**
 * Estimated tokens/sec throughput by hardware vendor and memory tier.
 * These are conservative estimates for typical training workloads.
 */
const THROUGHPUT_ESTIMATES: Record<string, { threshold: number; tokensPerSec: number }[]> = {
  nvidia: [
    { threshold: 24000, tokensPerSec: 2500 },  // High-end (A100, RTX 4090)
    { threshold: 16000, tokensPerSec: 2000 },  // Mid-high (RTX 3090, 4080)
    { threshold: 8000, tokensPerSec: 1200 },   // Mid (RTX 3070, 4060 Ti)
    { threshold: 0, tokensPerSec: 600 },       // Entry (GTX 1660, RTX 3060)
  ],
  apple: [
    { threshold: 64000, tokensPerSec: 1000 },  // M2 Ultra / M3 Max 128GB
    { threshold: 32000, tokensPerSec: 800 },   // M2 Max / M3 Pro
    { threshold: 16000, tokensPerSec: 500 },   // M2 Pro / base M3
    { threshold: 0, tokensPerSec: 300 },       // M1 / M2 base
  ],
  amd: [
    { threshold: 16000, tokensPerSec: 1500 },  // RX 7900 XTX
    { threshold: 8000, tokensPerSec: 700 },    // RX 7800 XT
    { threshold: 0, tokensPerSec: 400 },       // Entry AMD
  ],
  none: [
    { threshold: 0, tokensPerSec: 100 },       // CPU-only
  ],
};

/**
 * Typical TDP (Thermal Design Power) in watts by hardware vendor.
 * Used for power consumption estimation.
 */
const HARDWARE_TDP_WATTS: Record<string, number> = {
  nvidia: 250,
  apple: 30,
  amd: 200,
  none: 65,
};

/**
 * Quantization size multiplier relative to f16.
 * Maps quantization type to the fraction of f16 model size.
 */
const QUANTIZATION_SIZE_FACTOR: Record<string, number> = {
  'q4_0': 0.25,
  'q4_1': 0.28,
  'q5_0': 0.31,
  'q5_1': 0.34,
  'q8_0': 0.50,
  'f16': 1.0,
};

/**
 * Average electricity cost per kWh in USD (US average).
 * Used for rough cost-equivalent estimation.
 */
const ELECTRICITY_COST_PER_KWH_USD = 0.12;

/**
 * Default values for optional parameters.
 */
const DEFAULTS = {
  tokensPerSample: 512,
  gradientAccumulationSteps: 1,
  maxCheckpoints: 3,
  quantization: 'q4_0' as const,
  loraRank: 16,
};

// ─── Cost Estimator ─────────────────────────────────────────────

/**
 * TrainingCostEstimator — Estimates resource requirements for training jobs.
 *
 * This is the server-side estimator used by IPC handlers and the Training
 * Orchestrator to provide accurate cost estimates before job submission.
 * It replaces the basic renderer-side heuristics with a more detailed
 * calculation based on hardware profiling.
 */
export class TrainingCostEstimator {
  constructor(private readonly costTracker: CostTracker | null = null) {}

  /**
   * Estimate resource requirements for a training job.
   *
   * The estimation covers:
   *   - Training time: Based on total tokens, hardware throughput, and method overhead
   *   - Peak VRAM: Based on model size, method, batch size, and optimizer state
   *   - Power: Based on hardware TDP and estimated wall-clock time
   *   - Disk: Based on checkpoint count, model size, and quantization
   *
   * Requirements: 21.1, 21.2
   */
  estimate(input: CostEstimationInput): CostEstimationResult {
    const tokensPerSample = input.tokensPerSample ?? DEFAULTS.tokensPerSample;
    const gradAccum = input.gradientAccumulationSteps ?? DEFAULTS.gradientAccumulationSteps;
    const maxCheckpoints = input.maxCheckpoints ?? DEFAULTS.maxCheckpoints;
    const quantization = input.quantization ?? DEFAULTS.quantization;

    // ── Calculate total steps and tokens ──
    const effectiveBatchSize = input.batchSize * gradAccum;
    const stepsPerEpoch = Math.max(1, Math.ceil(input.datasetSamples / effectiveBatchSize));
    const totalSteps = stepsPerEpoch * input.epochs;
    const totalTokens = input.datasetSamples * tokensPerSample * input.epochs;

    // ── Estimate throughput ──
    const estimatedTokensPerSec = this.estimateThroughput(input.hardware, input.method);

    // ── Training Time ──
    // Time = total_tokens / throughput, with overhead for checkpointing and data loading
    const dataLoadingOverhead = 1.1; // 10% overhead for data loading
    const checkpointOverhead = 1.02; // 2% overhead for checkpoint saves
    const rawTimeMs = (totalTokens / estimatedTokensPerSec) * 1000;
    const estimatedTimeMs = Math.max(
      60_000, // Minimum 1 minute
      Math.round(rawTimeMs * dataLoadingOverhead * checkpointOverhead),
    );

    // ── Peak VRAM ──
    const peakVramMB = this.estimateVRAM(input);

    // ── Available Memory ──
    const availableMemoryMB = this.getAvailableMemory(input.hardware);

    // ── Disk Space ──
    const diskBreakdown = this.estimateDiskSpace(input, maxCheckpoints, quantization);

    // ── Power Consumption ──
    const powerConsumptionKWh = this.estimatePower(input.hardware, estimatedTimeMs);

    return {
      estimatedTimeMs,
      peakVramMB,
      powerConsumptionKWh,
      diskSpaceMB: diskBreakdown.checkpointsMB + diskBreakdown.outputModelMB,
      diskBreakdown,
      totalSteps,
      estimatedTokensPerSec,
      vramExceedsAvailable: peakVramMB > availableMemoryMB,
      availableMemoryMB,
    };
  }

  /**
   * Record a training cost estimate with the Cost_Tracker for per-session breakdown.
   *
   * This integrates cost estimates into the existing per-session cost tracking so
   * training resource usage appears alongside LLM call costs, subagent costs, etc.
   *
   * Requirements: 21.3
   */
  recordEstimate(sessionId: string, input: CostEstimationInput): TrainingCostRecord | null {
    const result = this.estimate(input);

    // Calculate a cost-equivalent in USD based on power consumption
    const estimatedCostUSD = result.powerConsumptionKWh * ELECTRICITY_COST_PER_KWH_USD;

    const record: TrainingCostRecord = {
      sessionId,
      estimatedCostUSD,
      metadata: {
        type: 'training-estimate',
        method: input.method,
        modelSizeParams: input.modelSizeParams,
        datasetSamples: input.datasetSamples,
        epochs: input.epochs,
        estimatedTimeMs: result.estimatedTimeMs,
        peakVramMB: result.peakVramMB,
        powerConsumptionKWh: result.powerConsumptionKWh,
        diskSpaceMB: result.diskSpaceMB,
      },
    };

    // Record with Cost_Tracker if available
    if (this.costTracker) {
      this.costTracker.recordCost(sessionId, estimatedCostUSD, record.metadata);
    }

    return record;
  }

  // ─── Private: VRAM Estimation ───────────────────────────────

  /**
   * Estimate peak VRAM usage based on model size, method, batch size,
   * and optimizer state requirements.
   */
  private estimateVRAM(input: CostEstimationInput): number {
    // Model memory footprint in MB (assuming float16: 2 bytes per param)
    const modelMemoryMB = (input.modelSizeParams * 2) / (1024 * 1024);

    // Method-specific VRAM for model weights
    const methodMultiplier = VRAM_METHOD_MULTIPLIERS[input.method];
    const modelVramMB = modelMemoryMB * methodMultiplier;

    // Optimizer state memory
    const optimizerMultiplier = input.method === 'full-finetune'
      ? OPTIMIZER_MULTIPLIER_FULL
      : OPTIMIZER_MULTIPLIER_LORA;
    const optimizerVramMB = modelVramMB * optimizerMultiplier;

    // Per-batch activation memory
    const activationVramMB = modelMemoryMB * VRAM_PER_SAMPLE_FACTOR * input.batchSize;

    // LoRA adapter memory (if applicable)
    let loraAdapterMB = 0;
    if (input.method !== 'full-finetune') {
      const loraRank = input.loraRank ?? DEFAULTS.loraRank;
      // LoRA adapter size is proportional to rank and model hidden dimension
      // Rough estimate: rank * hidden_dim * 2 * num_layers * 2 bytes / 1MB
      // Simplified: (loraRank / 16) * (modelSizeParams / 7e9) * 50 MB
      loraAdapterMB = (loraRank / 16) * (input.modelSizeParams / 7e9) * 50;
    }

    // Total peak VRAM
    const totalVramMB = modelVramMB + optimizerVramMB + activationVramMB + loraAdapterMB;

    // Apply minimum baseline
    return Math.max(MINIMUM_VRAM_MB, Math.round(totalVramMB));
  }

  // ─── Private: Throughput Estimation ─────────────────────────

  /**
   * Estimate tokens/sec throughput based on hardware capabilities.
   */
  private estimateThroughput(hardware: HardwareProfile, method: TrainingMethod): number {
    const vendor = hardware.vendor;
    const defaultTier = [{ threshold: 0, tokensPerSec: 100 }];
    const tiers = THROUGHPUT_ESTIMATES[vendor] ?? defaultTier;
    const memoryMB = this.getAvailableMemory(hardware);

    // Find the appropriate tier based on available memory
    const lastTier = tiers[tiers.length - 1];
    let tokensPerSec = lastTier ? lastTier.tokensPerSec : 100; // Fallback to lowest
    for (const tier of tiers) {
      if (memoryMB >= tier.threshold) {
        tokensPerSec = tier.tokensPerSec;
        break;
      }
    }

    // Method penalty: full fine-tuning is slower due to larger gradient computation
    if (method === 'full-finetune') {
      tokensPerSec *= 0.6; // 40% slower than LoRA
    } else if (method === 'qlora') {
      tokensPerSec *= 0.85; // 15% slower than LoRA due to dequantization
    }

    return Math.max(10, Math.round(tokensPerSec));
  }

  // ─── Private: Disk Space Estimation ─────────────────────────

  /**
   * Estimate disk space for checkpoints and the output model.
   */
  private estimateDiskSpace(
    input: CostEstimationInput,
    maxCheckpoints: number,
    quantization: string,
  ): { checkpointsMB: number; outputModelMB: number } {
    // Model size in MB at float16 precision
    const modelF16MB = (input.modelSizeParams * 2) / (1024 * 1024);

    // Checkpoint size depends on method
    let perCheckpointMB: number;
    if (input.method === 'full-finetune') {
      // Full model weights + optimizer state
      perCheckpointMB = modelF16MB * 3; // weights + 2x optimizer
    } else {
      // Only LoRA adapter weights + optimizer state for adapter
      const loraRank = input.loraRank ?? DEFAULTS.loraRank;
      const adapterFraction = (loraRank / 16) * 0.01; // Fraction of full model
      perCheckpointMB = modelF16MB * adapterFraction * 3;
      // Minimum checkpoint size
      perCheckpointMB = Math.max(50, perCheckpointMB);
    }

    const checkpointsMB = Math.round(perCheckpointMB * maxCheckpoints);

    // Output model size after quantization
    const quantFactor = QUANTIZATION_SIZE_FACTOR[quantization] ?? 0.25;
    const outputModelMB = Math.round(modelF16MB * quantFactor);

    return { checkpointsMB, outputModelMB };
  }

  // ─── Private: Power Estimation ──────────────────────────────

  /**
   * Estimate power consumption based on hardware TDP and training duration.
   */
  private estimatePower(hardware: HardwareProfile, timeMs: number): number {
    const watts = HARDWARE_TDP_WATTS[hardware.vendor] ?? 65;
    const hours = timeMs / 3_600_000;
    const kwh = (watts * hours) / 1000;
    // Round to 4 decimal places
    return Math.round(kwh * 10000) / 10000;
  }

  // ─── Private: Available Memory ──────────────────────────────

  /**
   * Determine available memory for training based on hardware profile.
   * For Apple Silicon, uses 75% of unified memory.
   * For discrete GPUs, uses VRAM directly.
   * For CPU-only, uses a conservative fraction of system RAM.
   */
  private getAvailableMemory(hardware: HardwareProfile): number {
    if (hardware.vendor === 'apple' && hardware.unifiedMemoryMB) {
      return Math.round(hardware.unifiedMemoryMB * 0.75);
    }
    if (hardware.vramMB) {
      return hardware.vramMB;
    }
    // CPU-only: limited to a conservative amount of system RAM
    return Math.min(hardware.systemMemoryMB * 0.5, 8192);
  }
}
