/**
 * Hardware_Detector — F8 Hardware_Fit_Cookbook.
 *
 * Detects the host machine's architecture, system RAM, and (best-effort) GPU
 * so the model ranker can base recommendations on real hardware rather than
 * guesses.
 *
 * Detection strategy:
 *   - arch / RAM:  Node's `os` module (`os.arch()`, `os.totalmem()`).
 *   - GPU (macOS): `system_profiler SPDisplaysDataType` — parses the
 *                  "Chipset Model" and any reported VRAM.
 *   - GPU (Linux/Windows): `nvidia-smi` — queries name + total memory.
 *
 * Contract: `detectHardware` NEVER throws. Every child-process probe is wrapped
 * in try/catch; any failure degrades to `gpuName` absent, `vramGB = 0`, and
 * `gpuBandwidthGBps = 0` rather than propagating an error (Requirement 42.2,
 * 42.3).
 *
 * Requirements: 42
 */

import os from 'node:os';
import { execSync } from 'node:child_process';
import { lookupBandwidth } from './gpu-bandwidth-table.js';

export interface HardwareProfile {
  arch: 'arm64' | 'x64' | 'unknown';
  ramGB: number;
  gpuName?: string;
  vramGB: number; // 0 when unknown
  gpuBandwidthGBps: number; // 0 when unknown
}

/** Bytes-per-gibibyte conversion factor. */
const BYTES_PER_GB = 1024 ** 3;

/** Max time (ms) to wait on any single GPU-detection child process. */
const PROBE_TIMEOUT_MS = 5000;

/** Round to a single decimal place (keeps VRAM/RAM readouts tidy). */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Map `os.arch()` onto the narrow set this profile reports. */
function normalizeArch(arch: string): HardwareProfile['arch'] {
  if (arch === 'arm64') return 'arm64';
  if (arch === 'x64') return 'x64';
  return 'unknown';
}

/** Result of a best-effort GPU probe. `vramGB` is 0 when unknown. */
interface GpuProbe {
  gpuName?: string;
  vramGB: number;
}

/**
 * Parse `system_profiler SPDisplaysDataType` output for the chipset model and
 * any reported VRAM. Apple Silicon shares unified memory and reports no
 * dedicated VRAM line, so `vramGB` stays 0 in that case.
 */
function parseSystemProfiler(output: string): GpuProbe {
  const result: GpuProbe = { vramGB: 0 };

  const chipMatch = output.match(/Chipset Model:\s*(.+)/);
  if (chipMatch && chipMatch[1]) {
    const name = chipMatch[1].trim();
    if (name.length > 0) {
      result.gpuName = name;
    }
  }

  // Dedicated GPUs report e.g. "VRAM (Total): 8 GB" or "VRAM (Dynamic, Max): 1536 MB".
  const vramMatch = output.match(/VRAM\s*\([^)]*\):\s*(\d+(?:\.\d+)?)\s*(GB|MB)/i);
  if (vramMatch && vramMatch[1] && vramMatch[2]) {
    const amount = Number.parseFloat(vramMatch[1]);
    if (Number.isFinite(amount)) {
      const gb = vramMatch[2].toUpperCase() === 'GB' ? amount : amount / 1024;
      result.vramGB = round1(gb);
    }
  }

  return result;
}

/**
 * Parse `nvidia-smi` CSV output of the form `name, memoryTotalMiB`.
 * Uses the first GPU line. Returns an empty probe when nothing parses.
 */
function parseNvidiaSmi(output: string): GpuProbe {
  const result: GpuProbe = { vramGB: 0 };

  const firstLine = output
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return result;

  const parts = firstLine.split(',');
  const name = parts[0]?.trim();
  if (name && name.length > 0) {
    result.gpuName = name;
  }

  const memRaw = parts[1]?.trim();
  if (memRaw) {
    const memMiB = Number.parseFloat(memRaw);
    if (Number.isFinite(memMiB) && memMiB > 0) {
      result.vramGB = round1(memMiB / 1024);
    }
  }

  return result;
}

/** macOS GPU probe via `system_profiler`. Never throws. */
function detectGpuDarwin(): GpuProbe {
  try {
    const output = execSync('system_profiler SPDisplaysDataType', {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseSystemProfiler(output);
  } catch {
    return { vramGB: 0 };
  }
}

/** Linux/Windows GPU probe via `nvidia-smi`. Never throws. */
function detectGpuNvidia(): GpuProbe {
  try {
    const output = execSync(
      'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits',
      {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return parseNvidiaSmi(output);
  } catch {
    return { vramGB: 0 };
  }
}

/**
 * Dispatch GPU detection by platform. Any unsupported platform or failed probe
 * degrades to an empty probe (`vramGB = 0`, no `gpuName`).
 */
function detectGpu(): GpuProbe {
  try {
    switch (process.platform) {
      case 'darwin':
        return detectGpuDarwin();
      case 'linux':
      case 'win32':
        return detectGpuNvidia();
      default:
        return { vramGB: 0 };
    }
  } catch {
    return { vramGB: 0 };
  }
}

/**
 * Detect the host hardware profile. Architecture and RAM come from Node's `os`
 * module; GPU details are probed best-effort per platform. When a GPU name is
 * detected, its memory bandwidth is resolved via the static lookup table.
 *
 * This function never throws — any failed probe degrades to the corresponding
 * `0`/absent field (Requirement 42.2, 42.3).
 */
export function detectHardware(): HardwareProfile {
  let arch: HardwareProfile['arch'] = 'unknown';
  let ramGB = 0;

  try {
    arch = normalizeArch(os.arch());
  } catch {
    arch = 'unknown';
  }

  try {
    const total = os.totalmem();
    if (Number.isFinite(total) && total > 0) {
      ramGB = round1(total / BYTES_PER_GB);
    }
  } catch {
    ramGB = 0;
  }

  const gpu = detectGpu();

  let gpuBandwidthGBps = 0;
  if (gpu.gpuName) {
    try {
      const bandwidth = lookupBandwidth(gpu.gpuName);
      gpuBandwidthGBps = Number.isFinite(bandwidth) && bandwidth > 0 ? bandwidth : 0;
    } catch {
      gpuBandwidthGBps = 0;
    }
  }

  return {
    arch,
    ramGB,
    ...(gpu.gpuName ? { gpuName: gpu.gpuName } : {}),
    vramGB: gpu.vramGB,
    gpuBandwidthGBps,
  };
}
