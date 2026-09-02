/**
 * System-monitor cold-load profile for the experience surface
 * (FUT-PKG-07-EXPERIENCE/T-006).
 *
 * NN-PERF-010 sets the budget: "A cold enable on the declared dashboard fixture
 * SHALL display CPU, memory, process, and chart data in <3 seconds at p95
 * (targeting the source's 2–3 second bound), preserve refresh accuracy, and
 * clean up when hidden." NN-COMPAT-014 requires cold monitor loading to meet
 * NN-PERF-010 "while preserving refresh interval, accuracy, cleanup, and
 * unrelated dashboard performance."
 *
 * This module owns the PURE profiling model: it classifies a set of measured
 * cold-load samples against the NN-PERF-010 budget (p95 < 3000 ms, targeting a
 * 2–3 s bound) and asserts that the required signals (CPU, memory, process,
 * chart) all resolved on cold enable and that cleanup releases in-flight work
 * when the surface is hidden. It builds on the async system monitor
 * (src/main/performance/async-system-monitor.ts) which already collects the
 * signals with per-command timeouts; the profile is verified against a REFERENCE
 * fixture rather than wall-clock flakiness (FIX-PERF-REFERENCE-01, V-PERF-001).
 *
 * Design anchors: D-19 (metrics/health), D-21 (performance measurement model).
 * Requirements: NN-PERF-010, NN-COMPAT-014.
 */

/** The NN-PERF-010 cold-load p95 ceiling in milliseconds (<3 s). */
export const COLD_LOAD_P95_CEILING_MS = 3000;

/**
 * The NN-PERF-010 target bound in milliseconds (the source's 2–3 s bound). A
 * profile whose p95 falls within `[TARGET_LOW, TARGET_HIGH]` meets the target;
 * anything up to the ceiling is a pass-with-headroom, and at/above the ceiling
 * is a failure (a missed timing target is a performance failure, never a bypass
 * of required behavior, NN-PERF).
 */
export const COLD_LOAD_TARGET_LOW_MS = 2000;
export const COLD_LOAD_TARGET_HIGH_MS = 3000;

/** The required signals a cold enable MUST display (NN-PERF-010). */
export const REQUIRED_MONITOR_SIGNALS = Object.freeze([
  'cpu',
  'memory',
  'process',
  'chart',
] as const);

export type MonitorSignal = (typeof REQUIRED_MONITOR_SIGNALS)[number];

/**
 * A single cold-enable sample: the signals that resolved and the cold-load
 * duration in milliseconds. A sample is only valid if it displayed every
 * required signal (NN-PERF-010 "display CPU, memory, process, and chart data").
 */
export interface ColdLoadSample {
  readonly durationMs: number;
  readonly signals: readonly MonitorSignal[];
}

/** How a cold-load profile classified against the NN-PERF-010 budget. */
export type MonitorProfileVerdict = 'meets-target' | 'within-ceiling' | 'exceeds-ceiling';

/** The result of profiling a set of cold-load samples. */
export interface MonitorProfile {
  readonly verdict: MonitorProfileVerdict;
  /** Whether the profile passes NN-PERF-010 (p95 below the ceiling). */
  readonly pass: boolean;
  /** The computed p95 cold-load duration in milliseconds. */
  readonly p95Ms: number;
  /** The sample count profiled. */
  readonly sampleCount: number;
  /** Whether every sample displayed all required signals on cold enable. */
  readonly allSignalsPresent: boolean;
  /** Whether cleanup released in-flight work when the surface was hidden. */
  readonly cleanupVerified: boolean;
}

/**
 * The p95 of a set of durations using the nearest-rank method. Deterministic and
 * pure: sorts ascending and returns the value at the ceil(0.95 * n) rank (1-based).
 * An empty set yields 0.
 */
export function p95(durationsMs: readonly number[]): number {
  if (durationsMs.length === 0) return 0;
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

/**
 * Whether a sample displayed EVERY required signal (CPU, memory, process, chart)
 * on cold enable. A sample missing any signal is not a complete cold enable
 * (NN-PERF-010).
 */
export function sampleHasAllSignals(sample: ColdLoadSample): boolean {
  return REQUIRED_MONITOR_SIGNALS.every((s) => sample.signals.includes(s));
}

/**
 * Profile a set of cold-enable samples against the NN-PERF-010 budget. The
 * profile:
 *   - computes the p95 cold-load duration;
 *   - classifies it: `meets-target` when p95 ≤ 2 s, `within-ceiling` when
 *     2 s < p95 < 3 s, `exceeds-ceiling` when p95 ≥ 3 s;
 *   - passes only when p95 is strictly below the 3 s ceiling AND every sample
 *     displayed all required signals AND cleanup was verified. A missed timing
 *     target is a failure, never a bypass of the required signals/cleanup
 *     (NN-PERF-010, NN-COMPAT-014).
 */
export function profileColdLoad(input: {
  readonly samples: readonly ColdLoadSample[];
  readonly cleanupVerified: boolean;
}): MonitorProfile {
  const durations = input.samples.map((s) => s.durationMs);
  const p95Ms = p95(durations);
  const allSignalsPresent =
    input.samples.length > 0 && input.samples.every(sampleHasAllSignals);

  let verdict: MonitorProfileVerdict;
  if (p95Ms >= COLD_LOAD_P95_CEILING_MS) {
    verdict = 'exceeds-ceiling';
  } else if (p95Ms <= COLD_LOAD_TARGET_LOW_MS) {
    verdict = 'meets-target';
  } else {
    verdict = 'within-ceiling';
  }

  const pass =
    verdict !== 'exceeds-ceiling' && allSignalsPresent && input.cleanupVerified;

  return {
    verdict,
    pass,
    p95Ms,
    sampleCount: input.samples.length,
    allSignalsPresent,
    cleanupVerified: input.cleanupVerified,
  };
}
