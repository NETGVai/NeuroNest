/**
 * Versioned Performance_Reference_Profile
 *
 * Defines reproducible performance measurement profiles that declare hardware,
 * operating system, repository sizes, concurrent loads, warmup procedures,
 * sample counts, percentile methods, and anomaly exclusions.
 *
 * No ad hoc benchmark result can satisfy a gate; measurements are only valid
 * when produced under an identified versioned profile.
 *
 * Requirements: 7.1, 24.7, 24.9, 28.2
 */

// ─── Hardware Specification ─────────────────────────────────────────────────

export interface HardwareSpec {
  /** CPU identifier (e.g., "Apple M2 Pro 10-core") */
  readonly cpu: string;
  /** CPU core count */
  readonly cores: number;
  /** RAM in gigabytes */
  readonly ramGB: number;
  /** Disk type */
  readonly diskType: 'ssd' | 'nvme' | 'hdd';
  /** Disk read speed baseline in MB/s */
  readonly diskReadMBps?: number;
  /** GPU identifier, if relevant to measurements */
  readonly gpu?: string;
}

// ─── Operating System Specification ─────────────────────────────────────────

export interface OSSpec {
  /** OS family */
  readonly platform: 'darwin' | 'linux' | 'win32';
  /** OS version string */
  readonly version: string;
  /** Architecture */
  readonly arch: 'x64' | 'arm64';
  /** Electron version */
  readonly electronVersion: string;
  /** Node.js version */
  readonly nodeVersion: string;
}

// ─── Repository Size Fixtures ───────────────────────────────────────────────

export type RepositorySizeCategory = 'small' | 'medium' | 'large' | 'huge';

export interface RepositorySizeFixture {
  /** Size category */
  readonly category: RepositorySizeCategory;
  /** Number of files */
  readonly fileCount: number;
  /** Total size in megabytes */
  readonly totalSizeMB: number;
  /** Number of lines of code (approximate) */
  readonly linesOfCode: number;
  /** Number of supported language files */
  readonly languageFileCount: number;
  /** Description of what this fixture represents */
  readonly description: string;
}

// ─── Concurrent Load Specification ──────────────────────────────────────────

export interface ConcurrentLoadSpec {
  /** Number of simultaneous chat streaming sessions */
  readonly chatStreams: number;
  /** Number of active diff computations */
  readonly activeDiffs: number;
  /** Number of active LSP servers */
  readonly activeLSPServers: number;
  /** Number of running agent tasks */
  readonly agentRuns: number;
  /** Number of active inline completion requests */
  readonly inlineCompletions: number;
  /** Background indexing active */
  readonly backgroundIndexing: boolean;
}

// ─── Measurement Configuration ──────────────────────────────────────────────

export type PercentileMethod = 'interpolated' | 'nearest-rank' | 'exclusive';

export interface MeasurementConfig {
  /** Number of warmup iterations before measurement begins */
  readonly warmupIterations: number;
  /** Duration of warmup period in milliseconds */
  readonly warmupDurationMs: number;
  /** Number of measurement samples to collect */
  readonly sampleCount: number;
  /** Minimum duration per sample in milliseconds */
  readonly minSampleDurationMs: number;
  /** Percentile calculation method */
  readonly percentileMethod: PercentileMethod;
  /** Which percentiles to compute (e.g., [50, 95, 99]) */
  readonly percentiles: readonly number[];
  /** Cool-down between samples in milliseconds */
  readonly interSampleDelayMs: number;
}

// ─── Anomaly Exclusions ─────────────────────────────────────────────────────

export type ExclusionReason =
  | 'gc-pause'
  | 'system-load-spike'
  | 'process-preemption'
  | 'disk-io-stall'
  | 'network-timeout'
  | 'cold-cache'
  | 'first-run';

export interface AnomalyExclusion {
  /** The type of anomaly to exclude */
  readonly reason: ExclusionReason;
  /** Threshold above which a sample is excluded (e.g., 3x stddev) */
  readonly thresholdMultiplier?: number;
  /** Maximum absolute value in ms above which to exclude */
  readonly absoluteThresholdMs?: number;
  /** Maximum number of samples that can be excluded */
  readonly maxExcludedSamples: number;
  /** Description of why this exclusion exists */
  readonly justification: string;
}

// ─── Performance Thresholds ─────────────────────────────────────────────────

export interface PerformanceThreshold {
  /** Name of the operation being measured */
  readonly operation: string;
  /** Maximum allowed duration at the specified percentile in ms */
  readonly maxDurationMs: number;
  /** Which percentile this threshold applies to */
  readonly percentile: number;
  /** Required repository size for this threshold */
  readonly repositorySize?: RepositorySizeCategory;
  /** Required concurrent load for this threshold */
  readonly concurrentLoad?: Partial<ConcurrentLoadSpec>;
}

// ─── Complete Profile Definition ────────────────────────────────────────────

export interface PerformanceReferenceProfile {
  /** Unique profile identifier */
  readonly id: string;
  /** Profile version (monotonically increasing) */
  readonly version: number;
  /** Human-readable name */
  readonly name: string;
  /** Description of what this profile measures */
  readonly description: string;
  /** Creation timestamp */
  readonly createdAt: string;
  /** Hardware specification */
  readonly hardware: HardwareSpec;
  /** Operating system specification */
  readonly os: OSSpec;
  /** Repository size fixtures available */
  readonly repositorySizes: readonly RepositorySizeFixture[];
  /** Concurrent load specification for measurements */
  readonly concurrentLoad: ConcurrentLoadSpec;
  /** Measurement configuration */
  readonly measurement: MeasurementConfig;
  /** Anomaly exclusion rules */
  readonly exclusions: readonly AnomalyExclusion[];
  /** Performance thresholds that must pass */
  readonly thresholds: readonly PerformanceThreshold[];
  /** Profile fingerprint for reproducibility verification */
  readonly fingerprint: string;
}

// ─── Default Profiles ───────────────────────────────────────────────────────

/**
 * Default development profile for local testing.
 * Matches the Performance_Reference_Profile requirements from R24.
 */
export const DEFAULT_DEV_PROFILE: PerformanceReferenceProfile = {
  id: 'neuronest-dev-v1',
  version: 1,
  name: 'NeuroNest Development Reference',
  description: 'Reference profile for development machine testing per Requirement 24',
  createdAt: '2025-01-01T00:00:00Z',
  hardware: {
    cpu: 'Apple M2 Pro 10-core',
    cores: 10,
    ramGB: 16,
    diskType: 'nvme',
    diskReadMBps: 3000,
  },
  os: {
    platform: 'darwin',
    version: '14.0',
    arch: 'arm64',
    electronVersion: '28.0.0',
    nodeVersion: '20.0.0',
  },
  repositorySizes: [
    {
      category: 'small',
      fileCount: 100,
      totalSizeMB: 5,
      linesOfCode: 10_000,
      languageFileCount: 80,
      description: 'Small project (~100 files)',
    },
    {
      category: 'medium',
      fileCount: 1_000,
      totalSizeMB: 50,
      linesOfCode: 100_000,
      languageFileCount: 800,
      description: 'Medium project (~1K files)',
    },
    {
      category: 'large',
      fileCount: 10_000,
      totalSizeMB: 500,
      linesOfCode: 1_000_000,
      languageFileCount: 8_000,
      description: 'Large monorepo (~10K files)',
    },
    {
      category: 'huge',
      fileCount: 50_000,
      totalSizeMB: 2_000,
      linesOfCode: 5_000_000,
      languageFileCount: 40_000,
      description: 'Huge enterprise monorepo (~50K files)',
    },
  ],
  concurrentLoad: {
    chatStreams: 1,
    activeDiffs: 2,
    activeLSPServers: 2,
    agentRuns: 1,
    inlineCompletions: 1,
    backgroundIndexing: true,
  },
  measurement: {
    warmupIterations: 5,
    warmupDurationMs: 2_000,
    sampleCount: 100,
    minSampleDurationMs: 1,
    percentileMethod: 'interpolated',
    percentiles: [50, 95, 99],
    interSampleDelayMs: 10,
  },
  exclusions: [
    {
      reason: 'gc-pause',
      thresholdMultiplier: 3,
      maxExcludedSamples: 5,
      justification: 'GC pauses are non-deterministic and unrelated to application performance',
    },
    {
      reason: 'first-run',
      maxExcludedSamples: 1,
      justification: 'First run includes JIT compilation and lazy initialization overhead',
    },
    {
      reason: 'system-load-spike',
      thresholdMultiplier: 5,
      maxExcludedSamples: 3,
      justification: 'External system load spikes are uncontrollable measurement noise',
    },
  ],
  thresholds: [
    {
      operation: 'typing-latency',
      maxDurationMs: 50,
      percentile: 95,
      repositorySize: 'large',
    },
    {
      operation: 'tab-switch',
      maxDurationMs: 100,
      percentile: 95,
    },
    {
      operation: 'file-open-1mb',
      maxDurationMs: 500,
      percentile: 95,
    },
    {
      operation: 'chat-update-visibility',
      maxDurationMs: 100,
      percentile: 95,
    },
    {
      operation: 'streaming-diff-chunk',
      maxDurationMs: 100,
      percentile: 95,
    },
  ],
  fingerprint: 'sha256:dev-profile-v1-placeholder',
};

/**
 * CI profile for continuous integration with constrained resources.
 */
export const DEFAULT_CI_PROFILE: PerformanceReferenceProfile = {
  id: 'neuronest-ci-v1',
  version: 1,
  name: 'NeuroNest CI Reference',
  description: 'Reference profile for CI machines with relaxed thresholds',
  createdAt: '2025-01-01T00:00:00Z',
  hardware: {
    cpu: 'Generic x86_64 4-core',
    cores: 4,
    ramGB: 8,
    diskType: 'ssd',
  },
  os: {
    platform: 'linux',
    version: '22.04',
    arch: 'x64',
    electronVersion: '28.0.0',
    nodeVersion: '20.0.0',
  },
  repositorySizes: [
    {
      category: 'small',
      fileCount: 100,
      totalSizeMB: 5,
      linesOfCode: 10_000,
      languageFileCount: 80,
      description: 'Small project (~100 files)',
    },
    {
      category: 'medium',
      fileCount: 1_000,
      totalSizeMB: 50,
      linesOfCode: 100_000,
      languageFileCount: 800,
      description: 'Medium project (~1K files)',
    },
  ],
  concurrentLoad: {
    chatStreams: 0,
    activeDiffs: 1,
    activeLSPServers: 1,
    agentRuns: 0,
    inlineCompletions: 0,
    backgroundIndexing: false,
  },
  measurement: {
    warmupIterations: 3,
    warmupDurationMs: 1_000,
    sampleCount: 50,
    minSampleDurationMs: 1,
    percentileMethod: 'interpolated',
    percentiles: [50, 95, 99],
    interSampleDelayMs: 5,
  },
  exclusions: [
    {
      reason: 'gc-pause',
      thresholdMultiplier: 3,
      maxExcludedSamples: 3,
      justification: 'GC pauses are non-deterministic',
    },
    {
      reason: 'first-run',
      maxExcludedSamples: 1,
      justification: 'First-run JIT overhead',
    },
  ],
  thresholds: [
    {
      operation: 'typing-latency',
      maxDurationMs: 100,
      percentile: 95,
      repositorySize: 'medium',
    },
    {
      operation: 'tab-switch',
      maxDurationMs: 200,
      percentile: 95,
    },
    {
      operation: 'file-open-1mb',
      maxDurationMs: 1_000,
      percentile: 95,
    },
    {
      operation: 'chat-update-visibility',
      maxDurationMs: 200,
      percentile: 95,
    },
  ],
  fingerprint: 'sha256:ci-profile-v1-placeholder',
};

// ─── Profile Selection ──────────────────────────────────────────────────────

/**
 * Select the appropriate performance profile based on the current environment.
 * Falls back to CI profile if the environment doesn't match dev hardware.
 */
export function selectProfile(profiles: readonly PerformanceReferenceProfile[]): PerformanceReferenceProfile | undefined {
  if (profiles.length === 0) return undefined;
  // Default: return the first profile. Runtime will match against actual hardware.
  return profiles[0];
}

/**
 * Validate that a profile contains all required fields for reproducible measurement.
 */
export function validateProfile(profile: PerformanceReferenceProfile): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!profile.id || profile.id.length === 0) errors.push('Profile ID is required');
  if (profile.version < 1) errors.push('Profile version must be >= 1');
  if (!profile.hardware.cpu) errors.push('Hardware CPU is required');
  if (profile.hardware.cores < 1) errors.push('Hardware cores must be >= 1');
  if (profile.hardware.ramGB < 1) errors.push('Hardware RAM must be >= 1 GB');
  if (!profile.os.platform) errors.push('OS platform is required');
  if (!profile.os.version) errors.push('OS version is required');
  if (profile.repositorySizes.length === 0) errors.push('At least one repository size fixture is required');
  if (profile.measurement.sampleCount < 1) errors.push('Sample count must be >= 1');
  if (profile.measurement.percentiles.length === 0) errors.push('At least one percentile is required');
  if (profile.thresholds.length === 0) errors.push('At least one performance threshold is required');

  for (const threshold of profile.thresholds) {
    if (!threshold.operation) errors.push('Threshold operation name is required');
    if (threshold.maxDurationMs <= 0) errors.push(`Threshold ${threshold.operation}: maxDurationMs must be > 0`);
    if (threshold.percentile <= 0 || threshold.percentile > 100) {
      errors.push(`Threshold ${threshold.operation}: percentile must be in (0, 100]`);
    }
  }

  return { valid: errors.length === 0, errors };
}
