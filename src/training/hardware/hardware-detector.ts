/**
 * Hardware Detector — Training Hardware Detection Module.
 *
 * Probes the host system for GPU capabilities (NVIDIA CUDA, Apple Silicon MLX,
 * AMD ROCm) and provides optimal training hyperparameter suggestions based on
 * detected hardware.
 *
 * Detection strategy:
 *   - NVIDIA: `nvidia-smi` XML output → CUDA toolkit version, VRAM, compute capability
 *   - Apple Silicon: `sysctl` → chip name, unified memory, Metal GPU family
 *   - AMD: `rocm-smi` → GPU name, VRAM, ROCm version
 *   - CPU: `os.cpus()`, `os.totalmem()` — always available as fallback
 *
 * All subprocess operations use SafeExec (no shell interpretation).
 * Results are cached per session; re-probe only on explicit `forceRefresh`.
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4
 */

import os from 'node:os';
import type { SafeExecResult } from '../../security/safe-exec.js';

// ─── Types ──────────────────────────────────────────────────────

export type GPUVendor = 'nvidia' | 'apple' | 'amd' | 'none';

export interface HardwareProfile {
  vendor: GPUVendor;
  gpuName?: string;
  vramMB?: number;
  unifiedMemoryMB?: number;
  computeCapability?: string;
  metalFamily?: string;
  driverVersion?: string;
  cudaVersion?: string;
  rocmVersion?: string;
  cpuCores: number;
  systemMemoryMB: number;
}

export interface HyperparameterConfig {
  learningRate: number;
  batchSize: number;
  epochs: number;
  loraRank?: number;
  loraAlpha?: number;
  warmupSteps?: number;
  weightDecay?: number;
  gradientAccumulationSteps?: number;
}

// ─── SafeExec type ──────────────────────────────────────────────

/** Type signature for the SafeExec async function we depend on */
export type SafeExecFn = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; env?: Record<string, string> },
) => Promise<SafeExecResult>;

// ─── Constants ──────────────────────────────────────────────────

/** Timeout for hardware probe commands (ms) */
const PROBE_TIMEOUT_MS = 10000;

// ─── Hardware Detector ──────────────────────────────────────────

export class HardwareDetector {
  private cachedProfile: HardwareProfile | null = null;

  constructor(private safeExec: SafeExecFn) {}

  /**
   * Probe system hardware capabilities. Results are cached for the session
   * duration; set `forceRefresh` to re-probe.
   */
  async detect(forceRefresh?: boolean): Promise<HardwareProfile> {
    if (this.cachedProfile && !forceRefresh) {
      return this.cachedProfile;
    }

    const baseProfile: HardwareProfile = {
      vendor: 'none',
      cpuCores: os.cpus().length || 1,
      systemMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
    };

    // Try NVIDIA first (most common discrete GPU)
    const nvidiaProfile = await this.probeNvidia(baseProfile);
    if (nvidiaProfile) {
      this.cachedProfile = nvidiaProfile;
      return nvidiaProfile;
    }

    // Try Apple Silicon
    const appleProfile = await this.probeAppleSilicon(baseProfile);
    if (appleProfile) {
      this.cachedProfile = appleProfile;
      return appleProfile;
    }

    // Try AMD ROCm
    const amdProfile = await this.probeAMD(baseProfile);
    if (amdProfile) {
      this.cachedProfile = amdProfile;
      return amdProfile;
    }

    // No GPU detected — CPU-only
    this.cachedProfile = baseProfile;
    return baseProfile;
  }

  /**
   * Suggest optimal training hyperparameters based on hardware capabilities.
   * Adapts batch size, gradient accumulation, and precision settings to
   * available memory.
   */
  suggestConfig(profile: HardwareProfile, modelSize: number): Partial<HyperparameterConfig> {
    const availableMemoryMB = this.getAvailableTrainingMemory(profile);

    // Estimate memory needed per sample (rough heuristic: ~4x model params in MB for LoRA)
    const modelSizeMB = modelSize / (1024 * 1024);
    const perSampleMB = modelSizeMB * 0.1; // LoRA trains ~10% of parameters

    if (profile.vendor === 'none') {
      // CPU-only: minimal config
      return {
        learningRate: 2e-5,
        batchSize: 1,
        epochs: 3,
        loraRank: 8,
        loraAlpha: 16,
        warmupSteps: 5,
        weightDecay: 0.01,
        gradientAccumulationSteps: 16,
      };
    }

    // Determine batch size based on available memory
    let batchSize = 4;
    if (availableMemoryMB < 4096) {
      batchSize = 1;
    } else if (availableMemoryMB < 8192) {
      batchSize = 2;
    } else if (availableMemoryMB < 16384) {
      batchSize = 4;
    } else if (availableMemoryMB < 32768) {
      batchSize = 8;
    } else {
      batchSize = 16;
    }

    // Ensure at least 1 sample fits in memory
    if (perSampleMB > 0 && batchSize * perSampleMB > availableMemoryMB * 0.7) {
      batchSize = Math.max(1, Math.floor((availableMemoryMB * 0.7) / perSampleMB));
    }

    // Gradient accumulation to achieve effective batch size of 16
    const targetEffectiveBatch = 16;
    const gradientAccumulationSteps = Math.max(1, Math.round(targetEffectiveBatch / batchSize));

    // LoRA rank based on available memory
    let loraRank = 16;
    if (availableMemoryMB >= 24576) {
      loraRank = 64;
    } else if (availableMemoryMB >= 16384) {
      loraRank = 32;
    } else if (availableMemoryMB >= 8192) {
      loraRank = 16;
    } else {
      loraRank = 8;
    }

    // Learning rate — Apple Silicon benefits from slightly lower LR
    const learningRate = profile.vendor === 'apple' ? 1e-4 : 2e-4;

    return {
      learningRate,
      batchSize,
      epochs: 3,
      loraRank,
      loraAlpha: loraRank * 2,
      warmupSteps: 10,
      weightDecay: 0.01,
      gradientAccumulationSteps,
    };
  }

  // ─── Private: NVIDIA Detection ──────────────────────────────────

  private async probeNvidia(base: HardwareProfile): Promise<HardwareProfile | null> {
    try {
      const result = await this.safeExec(
        'nvidia-smi',
        ['-q', '-x'],
        { timeout: PROBE_TIMEOUT_MS },
      );

      if (result.exitCode !== 0) {
        return null;
      }

      return this.parseNvidiaSmiXml(result.stdout, base);
    } catch {
      return null;
    }
  }

  /**
   * Parse nvidia-smi XML output to extract GPU name, VRAM, compute capability,
   * driver version, and CUDA version.
   */
  private parseNvidiaSmiXml(xml: string, base: HardwareProfile): HardwareProfile | null {
    if (!xml || xml.trim().length === 0) {
      return null;
    }

    const profile: HardwareProfile = {
      ...base,
      vendor: 'nvidia',
    };

    // Extract GPU product name
    const nameMatch = xml.match(/<product_name>([^<]+)<\/product_name>/);
    if (nameMatch?.[1]) {
      profile.gpuName = nameMatch[1].trim();
    }

    // Extract total VRAM (fb_memory_usage → total)
    const vramMatch = xml.match(/<fb_memory_usage>[\s\S]*?<total>(\d+)\s*MiB<\/total>[\s\S]*?<\/fb_memory_usage>/);
    if (vramMatch?.[1]) {
      const vramMiB = parseInt(vramMatch[1], 10);
      if (Number.isFinite(vramMiB) && vramMiB > 0) {
        profile.vramMB = vramMiB;
      }
    }

    // Extract compute capability (e.g., "8.6")
    const computeMatch = xml.match(/<compute_capability>([^<]+)<\/compute_capability>/);
    if (computeMatch?.[1]) {
      // nvidia-smi may report as "8.6" or individual major/minor
      profile.computeCapability = computeMatch[1].trim();
    } else {
      // Try major.minor pattern
      const majorMatch = xml.match(/<cuda_compute_capability_major>(\d+)<\/cuda_compute_capability_major>/);
      const minorMatch = xml.match(/<cuda_compute_capability_minor>(\d+)<\/cuda_compute_capability_minor>/);
      if (majorMatch?.[1] && minorMatch?.[1]) {
        profile.computeCapability = `${majorMatch[1]}.${minorMatch[1]}`;
      }
    }

    // Extract driver version
    const driverMatch = xml.match(/<driver_version>([^<]+)<\/driver_version>/);
    if (driverMatch?.[1]) {
      profile.driverVersion = driverMatch[1].trim();
    }

    // Extract CUDA version
    const cudaMatch = xml.match(/<cuda_version>([^<]+)<\/cuda_version>/);
    if (cudaMatch?.[1]) {
      profile.cudaVersion = cudaMatch[1].trim();
    }

    // Only return if we actually detected something meaningful
    if (!profile.gpuName && !profile.vramMB) {
      return null;
    }

    return profile;
  }

  // ─── Private: Apple Silicon Detection ───────────────────────────

  private async probeAppleSilicon(base: HardwareProfile): Promise<HardwareProfile | null> {
    // Only probe on macOS
    if (process.platform !== 'darwin') {
      return null;
    }

    try {
      // Check for Apple Silicon via sysctl
      const brandResult = await this.safeExec(
        'sysctl',
        ['-n', 'machdep.cpu.brand_string'],
        { timeout: PROBE_TIMEOUT_MS },
      );

      if (brandResult.exitCode !== 0) {
        return null;
      }

      const brandString = brandResult.stdout.trim();
      if (!brandString.toLowerCase().includes('apple')) {
        return null;
      }

      const profile: HardwareProfile = {
        ...base,
        vendor: 'apple',
        gpuName: brandString,
      };

      // Get unified memory (total system RAM is unified on Apple Silicon)
      profile.unifiedMemoryMB = base.systemMemoryMB;

      // Detect Metal GPU family
      profile.metalFamily = await this.detectMetalFamily();

      return profile;
    } catch {
      return null;
    }
  }

  /**
   * Detect the Metal GPU family for Apple Silicon.
   * Uses system_profiler to determine the Metal family support level.
   */
  private async detectMetalFamily(): Promise<string | undefined> {
    try {
      const result = await this.safeExec(
        'system_profiler',
        ['SPDisplaysDataType'],
        { timeout: PROBE_TIMEOUT_MS },
      );

      if (result.exitCode !== 0) {
        return undefined;
      }

      const output = result.stdout;

      // Look for Metal Family or Metal Support
      const metalMatch = output.match(/Metal Family:\s*(.+)/i)
        ?? output.match(/Metal Support:\s*(.+)/i);

      if (metalMatch?.[1]) {
        return metalMatch[1].trim().toLowerCase().replace(/\s+/g, '');
      }

      // If we're on Apple Silicon, it's at least apple7
      return 'apple7';
    } catch {
      return undefined;
    }
  }

  // ─── Private: AMD ROCm Detection ────────────────────────────────

  private async probeAMD(base: HardwareProfile): Promise<HardwareProfile | null> {
    try {
      const result = await this.safeExec(
        'rocm-smi',
        ['--showproductname', '--showmeminfo', 'vram', '--csv'],
        { timeout: PROBE_TIMEOUT_MS },
      );

      if (result.exitCode !== 0) {
        return null;
      }

      return this.parseRocmSmi(result.stdout, base);
    } catch {
      return null;
    }
  }

  /**
   * Parse rocm-smi CSV output to extract GPU name and VRAM.
   */
  private async parseRocmSmi(output: string, base: HardwareProfile): Promise<HardwareProfile | null> {
    if (!output || output.trim().length === 0) {
      return null;
    }

    const profile: HardwareProfile = {
      ...base,
      vendor: 'amd',
    };

    // Parse GPU name from product name output
    const lines = output.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

    // Look for card series name (typically after header line)
    for (const line of lines) {
      // Skip CSV header lines and separator lines
      if (line.startsWith('=') || (line.toLowerCase().includes('gpu') && line.toLowerCase().includes('name'))) {
        continue;
      }
      // First non-header line with content could be the GPU name
      const nameMatch = line.match(/card\d*[,\s]+(.+)/i) ?? line.match(/^[^,]*,\s*(.+)/);
      if (nameMatch?.[1]) {
        const name = nameMatch[1].trim();
        if (name && !name.startsWith('=')) {
          profile.gpuName = name;
          break;
        }
      }
    }

    // Parse VRAM from memory info
    const vramMatch = output.match(/(\d+)\s*(MB|MiB)/i);
    if (vramMatch?.[1]) {
      const vramMB = parseInt(vramMatch[1], 10);
      if (Number.isFinite(vramMB) && vramMB > 0) {
        profile.vramMB = vramMB;
      }
    }

    // Try to get ROCm version
    profile.rocmVersion = await this.detectRocmVersion();

    // Only return if we detected something meaningful
    if (!profile.gpuName && !profile.vramMB) {
      return null;
    }

    return profile;
  }

  /**
   * Get ROCm version from rocm-smi or rocminfo.
   */
  private async detectRocmVersion(): Promise<string | undefined> {
    try {
      const result = await this.safeExec(
        'rocm-smi',
        ['--showdriverversion'],
        { timeout: PROBE_TIMEOUT_MS },
      );

      if (result.exitCode !== 0) {
        return undefined;
      }

      const versionMatch = result.stdout.match(/(\d+\.\d+(?:\.\d+)?)/);
      return versionMatch?.[1];
    } catch {
      return undefined;
    }
  }

  // ─── Private: Helpers ───────────────────────────────────────────

  /**
   * Determine available memory for training based on hardware profile.
   * Uses VRAM for discrete GPUs, unified memory for Apple Silicon.
   */
  private getAvailableTrainingMemory(profile: HardwareProfile): number {
    if (profile.vendor === 'apple' && profile.unifiedMemoryMB) {
      // Apple Silicon: ~75% of unified memory available for ML
      return Math.round(profile.unifiedMemoryMB * 0.75);
    }

    if (profile.vramMB) {
      return profile.vramMB;
    }

    // CPU-only: use system RAM but capped lower
    return Math.min(profile.systemMemoryMB, 8192);
  }
}
