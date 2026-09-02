/**
 * D-21 performance measurement model for the experience surface
 * (FUT-PKG-07-EXPERIENCE/T-008 — Performance Authority).
 *
 * This module binds the EXACT D-21 performance-profile catalog and enforces the
 * correctness-preserving measurement rules. D-21 defines a
 * `PerformanceEvidence@1` specialization of `EvidenceRecord@1` recording:
 * `{canonicalCriterion, operation, fixtureId/version/digest, dataSize, coldWarm,
 * hardware, OS, architecture, runtime/Electron/Node versions, power mode,
 * dependency/network mode, sampleCount, warmupCount, statistic/percentile,
 * boundaries, units, allowedVariance, baselineRevision, candidateRevision,
 * rawArtifactRef, result}` and the measurement rules:
 *   - monotonic clocks around named boundaries;
 *   - baseline and candidate use IDENTICAL fixtures/profiles/revisions;
 *   - report distribution and failures, not only mean; a TIMEOUT remains a
 *     failure, never a dropped sample;
 *   - preserve correctness/security checks during measurement; NO benchmark-only
 *     bypass (a benchmark that trades correctness for speed is rejected);
 *   - a target remains `pending-evidence` until a valid record exists.
 *
 * This is the PURE profiling/gate model — it does not wall-clock anything. It
 * classifies declared distributions from a raw artifact against a profile's SLO
 * threshold and asserts the fail-closed conditions the task mandates: a MISSING
 * profile, a DROPPED timeout, a benchmark BYPASS, a MISMATCHED baseline/candidate
 * revision, or a configured SLO MISS all remain failed/pending. It builds on the
 * system-monitor profile's nearest-rank p95 helper (src/experience/
 * system-monitor-profile.ts, T-006) rather than creating a parallel statistic,
 * and reuses the shared redaction authority (src/shared/observable-redaction.ts
 * containsRedactableContent) so no secret/private absolute path leaks into
 * PerformanceEvidence (V-OBS-001/performance-evidence-redaction).
 *
 * Verified against a REFERENCE fixture (FIX-PERF-REFERENCE-01) rather than
 * wall-clock flakiness (V-PERF-001).
 *
 * Design anchors: D-19 (metrics/observability), D-21 (performance measurement),
 * D-22 (verification/evidence).
 * Requirements: NN-PERF-001–015, NN-OBS-001/005/008, NN-VERIFY-001/005.
 */

import { p95 } from './system-monitor-profile.js';
import { containsRedactableContent } from '../shared/observable-redaction.js';

/**
 * The EXACT D-21 profile catalog required by FUT-PKG-07-EXPERIENCE/T-008:
 * startup, events, file tree, index, context/tools, UI/chat, monitor, sandbox,
 * proxy/license, notifications/tasks, build/test, and regression. Each id names
 * the NN-PERF criterion it profiles. A profile absent from a candidate report
 * is a MISSING profile and remains failed/pending (never a silent pass).
 */
export const D21_PROFILE_IDS = Object.freeze([
  'startup',
  'events',
  'file-tree',
  'index',
  'context-tools',
  'ui-chat',
  'monitor',
  'sandbox',
  'proxy-license',
  'notifications-tasks',
  'build-test',
  'regression',
] as const);

export type D21ProfileId = (typeof D21_PROFILE_IDS)[number];

/** The reported statistic for a profile (D-21 "statistic/percentile"). */
export type PerformanceStatistic = 'p95' | 'p99' | 'max' | 'mean';

/** Cold/warm measurement state (D-21 "coldWarm"). */
export type ColdWarm = 'cold' | 'warm';

/**
 * A single D-21 profile declaration: the operation, the NN-PERF criterion it
 * measures, its fixture, cold/warm state, the reported statistic, its SLO
 * threshold in milliseconds, and the allowed variance fraction. This is the
 * expected side of the measurement — the raw artifact supplies the observed
 * distribution.
 */
export interface PerformanceProfile {
  readonly id: D21ProfileId;
  /** The NN-PERF criterion this profile binds, e.g. `NN-PERF-003`. */
  readonly canonicalCriterion: string;
  /** The named operation under measurement, e.g. `visible-shell-startup`. */
  readonly operation: string;
  readonly fixtureId: string;
  readonly coldWarm: ColdWarm;
  readonly statistic: PerformanceStatistic;
  /** The SLO ceiling in milliseconds; the reported statistic must be below it. */
  readonly thresholdMs: number;
  /** Allowed variance as a fraction of the threshold (D-21 "allowedVariance"). */
  readonly allowedVariance: number;
  /** Minimum sample count for a valid measurement (D-21 "sampleCount"). */
  readonly minSampleCount: number;
}

/**
 * The canonical D-21 profile catalog. Thresholds are the source-declared SLO
 * ceilings from NN-PERF-003–015 (the profile is the machine-checkable binding of
 * those criteria to fixtures; a value here is a planning threshold until a valid
 * PerformanceEvidence@1 record links it, NN-PERF-001/§6.2).
 */
export const D21_PROFILE_CATALOG: Readonly<Record<D21ProfileId, PerformanceProfile>> =
  Object.freeze({
    startup: Object.freeze({
      id: 'startup',
      canonicalCriterion: 'NN-PERF-003',
      operation: 'interactive-gui-workspace-startup',
      fixtureId: 'FIX-PERF-REFERENCE-01/startup',
      coldWarm: 'cold',
      statistic: 'p95',
      thresholdMs: 3000,
      allowedVariance: 0.1,
      minSampleCount: 30,
    }),
    events: Object.freeze({
      id: 'events',
      canonicalCriterion: 'NN-PERF-004',
      operation: 'cold-reduction-5000-events',
      fixtureId: 'FIX-PERF-REFERENCE-01/events',
      coldWarm: 'cold',
      statistic: 'p95',
      thresholdMs: 250,
      allowedVariance: 0.1,
      minSampleCount: 30,
    }),
    'file-tree': Object.freeze({
      id: 'file-tree',
      canonicalCriterion: 'NN-PERF-005',
      operation: 'write-notification-reflection',
      fixtureId: 'FIX-PERF-REFERENCE-01/file-tree',
      coldWarm: 'warm',
      statistic: 'p95',
      thresholdMs: 100,
      allowedVariance: 0.1,
      minSampleCount: 30,
    }),
    index: Object.freeze({
      id: 'index',
      canonicalCriterion: 'NN-PERF-006',
      operation: 'semantic-query-10000-chunks',
      fixtureId: 'FIX-PERF-REFERENCE-01/index',
      coldWarm: 'warm',
      statistic: 'p95',
      thresholdMs: 200,
      allowedVariance: 0.1,
      minSampleCount: 30,
    }),
    'context-tools': Object.freeze({
      id: 'context-tools',
      canonicalCriterion: 'NN-PERF-007',
      operation: 'skill-search-ui-filter',
      fixtureId: 'FIX-PERF-REFERENCE-01/context-tools',
      coldWarm: 'warm',
      statistic: 'p95',
      thresholdMs: 200,
      allowedVariance: 0.1,
      minSampleCount: 30,
    }),
    'ui-chat': Object.freeze({
      id: 'ui-chat',
      canonicalCriterion: 'NN-PERF-008',
      operation: 'first-contentful-paint',
      fixtureId: 'FIX-PERF-REFERENCE-01/ui-chat',
      coldWarm: 'cold',
      statistic: 'p95',
      thresholdMs: 3000,
      allowedVariance: 0.1,
      minSampleCount: 30,
    }),
    monitor: Object.freeze({
      id: 'monitor',
      canonicalCriterion: 'NN-PERF-010',
      operation: 'cold-monitor-enable',
      fixtureId: 'FIX-PERF-REFERENCE-01/monitor',
      coldWarm: 'cold',
      statistic: 'p95',
      thresholdMs: 3000,
      allowedVariance: 0.1,
      minSampleCount: 30,
    }),
    sandbox: Object.freeze({
      id: 'sandbox',
      canonicalCriterion: 'NN-PERF-011',
      operation: 'cold-sandbox-process-start',
      fixtureId: 'FIX-PERF-REFERENCE-01/sandbox',
      coldWarm: 'cold',
      statistic: 'p95',
      thresholdMs: 100,
      allowedVariance: 0.1,
      minSampleCount: 30,
    }),
    'proxy-license': Object.freeze({
      id: 'proxy-license',
      canonicalCriterion: 'NN-PERF-012',
      operation: 'activation-lookup',
      fixtureId: 'FIX-PERF-REFERENCE-01/proxy-license',
      coldWarm: 'warm',
      statistic: 'p95',
      thresholdMs: 200,
      allowedVariance: 0.1,
      minSampleCount: 30,
    }),
    'notifications-tasks': Object.freeze({
      id: 'notifications-tasks',
      canonicalCriterion: 'NN-PERF-013',
      operation: 'approval-resume',
      fixtureId: 'FIX-PERF-REFERENCE-01/notifications-tasks',
      coldWarm: 'warm',
      statistic: 'p95',
      thresholdMs: 300,
      allowedVariance: 0.1,
      minSampleCount: 30,
    }),
    'build-test': Object.freeze({
      id: 'build-test',
      canonicalCriterion: 'NN-PERF-014',
      operation: 'local-build-test-operation',
      fixtureId: 'FIX-PERF-REFERENCE-01/build-test',
      coldWarm: 'cold',
      statistic: 'max',
      thresholdMs: 120000,
      allowedVariance: 0.1,
      minSampleCount: 1,
    }),
    regression: Object.freeze({
      id: 'regression',
      canonicalCriterion: 'NN-PERF-015',
      operation: 'agent-skills-integration-regression',
      fixtureId: 'FIX-PERF-REFERENCE-01/regression',
      coldWarm: 'warm',
      statistic: 'p95',
      thresholdMs: 0, // computed per-run as 110% of the measured baseline
      allowedVariance: 0.1,
      minSampleCount: 30,
    }),
  });

/**
 * A raw performance artifact for one profile: the observed sample durations in
 * milliseconds, the count of samples that TIMED OUT (which remain failures, not
 * dropped samples, D-21), the sample/warmup counts, and the baseline/candidate
 * revisions. `correctnessPreserved` records whether the measured operation still
 * produced a correct result during measurement (D-21 — no benchmark-only bypass);
 * `securityPreserved` records whether required security checks stayed active.
 */
export interface RawPerformanceArtifact {
  readonly profileId: D21ProfileId;
  readonly samplesMs: readonly number[];
  readonly timeoutCount: number;
  readonly warmupCount: number;
  readonly baselineRevision: string;
  readonly candidateRevision: string;
  readonly correctnessPreserved: boolean;
  readonly securityPreserved: boolean;
  /**
   * For the regression profile only: the measured original baseline statistic in
   * milliseconds. The effective threshold is 110% of this value (NN-PERF-015).
   */
  readonly regressionBaselineMs?: number;
}

/** Why a profile measurement is failing/pending (fail-closed reasons). */
export type PerformanceFailureReason =
  | 'missing-profile'
  | 'dropped-timeout'
  | 'insufficient-samples'
  | 'mismatched-revision'
  | 'benchmark-bypass'
  | 'security-bypass'
  | 'slo-miss'
  | 'missing-regression-baseline';

/** The result of gating a single profile's raw artifact against its SLO. */
export interface ProfileGateResult {
  readonly profileId: D21ProfileId;
  /** True only when every gate passes (a valid, correctness-preserving pass). */
  readonly pass: boolean;
  /** The computed reported statistic value in milliseconds. */
  readonly statisticMs: number;
  /** The effective SLO ceiling applied (may be derived, e.g. regression). */
  readonly effectiveThresholdMs: number;
  /** Every fail-closed reason this profile violated (empty when passing). */
  readonly failureReasons: readonly PerformanceFailureReason[];
}

/**
 * Compute the reported statistic for a set of durations. p95 reuses the
 * nearest-rank helper from the system-monitor profile (no parallel statistic);
 * p99 uses the same nearest-rank method at the 0.99 rank; max/mean are direct.
 * An empty set yields 0.
 */
export function computeStatistic(
  statistic: PerformanceStatistic,
  durationsMs: readonly number[],
): number {
  if (durationsMs.length === 0) return 0;
  switch (statistic) {
    case 'p95':
      return p95(durationsMs);
    case 'p99': {
      const sorted = [...durationsMs].sort((a, b) => a - b);
      const rank = Math.ceil(0.99 * sorted.length);
      return sorted[Math.min(rank, sorted.length) - 1];
    }
    case 'max':
      return Math.max(...durationsMs);
    case 'mean':
      return durationsMs.reduce((sum, d) => sum + d, 0) / durationsMs.length;
    default: {
      const _exhaustive: never = statistic;
      return _exhaustive;
    }
  }
}

/**
 * The effective SLO ceiling for a profile+artifact. For the regression profile
 * the ceiling is 110% of the measured original baseline (NN-PERF-015); for every
 * other profile it is the declared threshold. Returns `null` when the regression
 * profile has no baseline (a missing regression baseline is fail-closed).
 */
export function effectiveThreshold(
  profile: PerformanceProfile,
  artifact: RawPerformanceArtifact,
): number | null {
  if (profile.id === 'regression') {
    if (
      typeof artifact.regressionBaselineMs !== 'number' ||
      !Number.isFinite(artifact.regressionBaselineMs) ||
      artifact.regressionBaselineMs < 0
    ) {
      return null;
    }
    return artifact.regressionBaselineMs * 1.1;
  }
  return profile.thresholdMs;
}

/**
 * Gate a single profile's raw artifact against its SLO with fail-closed rules.
 * A profile PASSES only when EVERY condition holds:
 *   - the baseline and candidate revisions are identical and non-empty
 *     (mismatched revision is fail-closed, D-21);
 *   - there are at least `minSampleCount` samples (a report cannot pass on too
 *     few samples);
 *   - there are ZERO timeouts (a timeout is a failure, never a dropped sample);
 *   - correctness was preserved (a benchmark that skipped real work / traded
 *     correctness for speed is a bypass and is rejected, D-21);
 *   - security checks stayed active during measurement (no security bypass);
 *   - the reported statistic is strictly below the effective SLO ceiling.
 * Any violation makes the profile fail and records every reason.
 */
export function gateProfile(
  profile: PerformanceProfile,
  artifact: RawPerformanceArtifact,
): ProfileGateResult {
  const reasons: PerformanceFailureReason[] = [];

  const baseline = artifact.baselineRevision.trim();
  const candidate = artifact.candidateRevision.trim();
  if (baseline.length === 0 || candidate.length === 0 || baseline !== candidate) {
    reasons.push('mismatched-revision');
  }

  if (artifact.samplesMs.length < profile.minSampleCount) {
    reasons.push('insufficient-samples');
  }

  if (artifact.timeoutCount > 0) {
    reasons.push('dropped-timeout');
  }

  if (!artifact.correctnessPreserved) {
    reasons.push('benchmark-bypass');
  }

  if (!artifact.securityPreserved) {
    reasons.push('security-bypass');
  }

  const ceiling = effectiveThreshold(profile, artifact);
  const statisticMs = computeStatistic(profile.statistic, artifact.samplesMs);
  let effectiveThresholdMs: number;
  if (ceiling === null) {
    reasons.push('missing-regression-baseline');
    effectiveThresholdMs = 0;
  } else {
    effectiveThresholdMs = ceiling;
    if (!(statisticMs < ceiling)) {
      reasons.push('slo-miss');
    }
  }

  return {
    profileId: profile.id,
    pass: reasons.length === 0,
    statisticMs,
    effectiveThresholdMs,
    failureReasons: reasons,
  };
}

/** The result of gating a full candidate performance report. */
export interface PerformanceReportGate {
  /** True only when EVERY D-21 profile is present and passes. */
  readonly pass: boolean;
  /** Per-profile gate results, in D-21 catalog order. */
  readonly profiles: readonly ProfileGateResult[];
  /** D-21 profile ids absent from the candidate report (fail-closed). */
  readonly missingProfiles: readonly D21ProfileId[];
}

/**
 * Gate a candidate performance report — a set of raw artifacts keyed by profile
 * id — against the FULL D-21 catalog. A report PASSES only when every one of the
 * 12 D-21 profiles is present AND passes its own gate. A missing profile is a
 * fail-closed gap (the release cannot pass by omitting a profile, D-21/NN-VERIFY-005).
 */
export function gatePerformanceReport(
  artifactsByProfile: Readonly<Partial<Record<D21ProfileId, RawPerformanceArtifact>>>,
): PerformanceReportGate {
  const profiles: ProfileGateResult[] = [];
  const missingProfiles: D21ProfileId[] = [];

  for (const id of D21_PROFILE_IDS) {
    const artifact = artifactsByProfile[id];
    if (!artifact) {
      missingProfiles.push(id);
      profiles.push({
        profileId: id,
        pass: false,
        statisticMs: 0,
        effectiveThresholdMs: D21_PROFILE_CATALOG[id].thresholdMs,
        failureReasons: ['missing-profile'],
      });
      continue;
    }
    profiles.push(gateProfile(D21_PROFILE_CATALOG[id], artifact));
  }

  return {
    pass: missingProfiles.length === 0 && profiles.every((p) => p.pass),
    profiles,
    missingProfiles,
  };
}

/**
 * A `PerformanceEvidence@1` record — the D-21 specialization of
 * `EvidenceRecord@1`. It carries the full measurement declaration so that a
 * value can be classified as release evidence rather than a planning target
 * (NN-PERF-001). `rawArtifactRef` points to the raw distribution (never a
 * private absolute path); `result` is `pass` only for a valid, correctness- and
 * security-preserving pass, else `fail` or `pending`.
 */
export interface PerformanceEvidence {
  readonly schemaVersion: 1;
  readonly evidenceId: string;
  readonly canonicalCriterion: string;
  readonly operation: string;
  readonly profileId: D21ProfileId;
  readonly fixtureId: string;
  readonly fixtureVersion: string;
  readonly fixtureDigest: string;
  readonly dataSize: string;
  readonly coldWarm: ColdWarm;
  readonly hardware: string;
  readonly os: string;
  readonly architecture: string;
  readonly runtimeVersions: string;
  readonly powerMode: string;
  readonly networkMode: string;
  readonly sampleCount: number;
  readonly warmupCount: number;
  readonly statistic: PerformanceStatistic;
  readonly statisticMs: number;
  readonly boundaries: string;
  readonly units: 'milliseconds';
  readonly allowedVariance: number;
  readonly baselineRevision: string;
  readonly candidateRevision: string;
  readonly rawArtifactRef: string;
  readonly result: 'pass' | 'fail' | 'pending';
}

/** Input to build a PerformanceEvidence@1 record from a gate result. */
export interface PerformanceEvidenceInput {
  readonly evidenceId: string;
  readonly fixtureVersion: string;
  readonly fixtureDigest: string;
  readonly dataSize: string;
  readonly hardware: string;
  readonly os: string;
  readonly architecture: string;
  readonly runtimeVersions: string;
  readonly powerMode: string;
  readonly networkMode: string;
  readonly boundaries: string;
  readonly rawArtifactRef: string;
}

/**
 * Build a `PerformanceEvidence@1` record for one profile from its raw artifact,
 * gate result, and declaration input. The `result` is `pass` ONLY when the gate
 * passed; a gate that failed for ANY fail-closed reason produces `fail` (a real
 * SLO miss, timeout, bypass, or mismatched revision is never softened to
 * `pending`). A profile with a valid but not-yet-measured baseline is `pending`
 * only when no samples were collected at all.
 */
export function buildPerformanceEvidence(
  profile: PerformanceProfile,
  artifact: RawPerformanceArtifact,
  gate: ProfileGateResult,
  input: PerformanceEvidenceInput,
): PerformanceEvidence {
  const result: PerformanceEvidence['result'] = gate.pass
    ? 'pass'
    : artifact.samplesMs.length === 0
      ? 'pending'
      : 'fail';

  return {
    schemaVersion: 1,
    evidenceId: input.evidenceId,
    canonicalCriterion: profile.canonicalCriterion,
    operation: profile.operation,
    profileId: profile.id,
    fixtureId: profile.fixtureId,
    fixtureVersion: input.fixtureVersion,
    fixtureDigest: input.fixtureDigest,
    dataSize: input.dataSize,
    coldWarm: profile.coldWarm,
    hardware: input.hardware,
    os: input.os,
    architecture: input.architecture,
    runtimeVersions: input.runtimeVersions,
    powerMode: input.powerMode,
    networkMode: input.networkMode,
    sampleCount: artifact.samplesMs.length,
    warmupCount: artifact.warmupCount,
    statistic: profile.statistic,
    statisticMs: gate.statisticMs,
    boundaries: input.boundaries,
    units: 'milliseconds',
    allowedVariance: profile.allowedVariance,
    baselineRevision: artifact.baselineRevision,
    candidateRevision: artifact.candidateRevision,
    rawArtifactRef: input.rawArtifactRef,
    result,
  };
}

/**
 * The fields of a PerformanceEvidence@1 record that are surfaced to an observable
 * boundary (evidence store, log, export). None may carry a secret or a private
 * absolute path (V-OBS-001/performance-evidence-redaction, NN-OBS-001,
 * NN-SEC-014). The measurement statistics themselves are numeric and inert.
 */
function redactableEvidenceFields(evidence: PerformanceEvidence): readonly string[] {
  return [
    evidence.evidenceId,
    evidence.canonicalCriterion,
    evidence.operation,
    evidence.profileId,
    evidence.fixtureId,
    evidence.fixtureVersion,
    evidence.fixtureDigest,
    evidence.dataSize,
    evidence.hardware,
    evidence.os,
    evidence.architecture,
    evidence.runtimeVersions,
    evidence.powerMode,
    evidence.networkMode,
    evidence.boundaries,
    evidence.baselineRevision,
    evidence.candidateRevision,
    evidence.rawArtifactRef,
  ];
}

/**
 * Whether a PerformanceEvidence@1 record is safe to surface: no text field
 * carries a secret or a private absolute path per the shared redaction authority
 * (containsRedactableContent). A record that fails this check MUST NOT be
 * emitted (V-OBS-001/performance-evidence-redaction).
 */
export function isPerformanceEvidenceRedactionSafe(
  evidence: PerformanceEvidence,
): boolean {
  return redactableEvidenceFields(evidence).every(
    (field) => !containsRedactableContent(field),
  );
}

/**
 * Assert a PerformanceEvidence@1 record is redaction-safe before it is surfaced.
 * Throws a visible error when a secret or private absolute path survives, so an
 * unsafe record can never be silently emitted (NN-SEC-014, D-19.4).
 */
export function assertPerformanceEvidenceRedactionSafe(
  evidence: PerformanceEvidence,
): void {
  if (!isPerformanceEvidenceRedactionSafe(evidence)) {
    throw new Error(
      `PerformanceEvidence ${evidence.evidenceId} contains a secret or private path and cannot be surfaced`,
    );
  }
}
