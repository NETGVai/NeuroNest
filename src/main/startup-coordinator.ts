/**
 * Phased startup coordinator (FUT-PKG-02-FOUNDATION/T-006).
 *
 * D-05 assigns the ElectronApplication composition root the responsibility for
 * "boot phases, process mode, authority wiring, readiness, window lifecycle,
 * shutdown. No domain logic." D-09 fixes the ordered startup/readiness
 * sequence:
 *
 *   instance/migration lease + canonical root
 *     → non-risky capability probe
 *     → database open / schema / migration
 *     → reconciliation (business/outbox/projections)
 *     → typed contract registration (owners)
 *     → required projections load/rebuild
 *     → hardened window + renderer bootstrap
 *
 * This module is the *coordinator* for that sequence. It is intentionally a
 * pure, dependency-injected orchestrator: every phase is supplied as a small
 * function returning a typed outcome, so the whole boot can run — and every
 * fault can be injected — without a live Electron runtime, a real BrowserWindow,
 * or a real SQLite file. `electron-app.ts` supplies the production phase
 * implementations (behind a developer-profile flag); the fault-matrix tests
 * supply deterministic fixtures.
 *
 * Truth invariants enforced here (NN-INV-001/003/011/015, D-09, D-19.4):
 *   - Handlers register only AFTER their authority is ready — the coordinator
 *     never runs the contract-registration or projection phases when a required
 *     authority/schema/integrity phase blocked (no handler race, D-09).
 *   - A required authority/schema/integrity failure BLOCKS mutation and puts
 *     the app in a diagnostic-only mode; it never reports optimistic readiness.
 *   - An optional-capability failure remains ISOLATED: it degrades that
 *     capability but never blocks the core boot (D-09 "optional service
 *     failures are scoped").
 *   - The readiness report is truthful and scoped: `ready` only when every
 *     required capability is `ready`, migration is `current`, and evidence is
 *     not stale (computeReadiness, D-19.4).
 *
 * Design anchors: D-05, D-09, D-17, D-18, D-19, D-20, D-23.
 * Requirements: NN-DATA-001..006/013, NN-EVENT-005/007, NN-PLATFORM-001/002/007,
 * NN-OBS-005, NN-COMPAT-001..003.
 */

import {
  buildLivenessReport,
  computeReadiness,
  type LivenessReport,
  type ReadinessReport,
  type ReadinessSignals,
  type RequiredCapabilityState,
  type ScopedHealthEntry,
} from '../shared/evidence-observability.js';
import type { CapabilityStatus } from '../shared/capability-registry.js';

// ─── Phase identity ──────────────────────────────────────────────────────────

/**
 * The ordered boot phases (D-09). `lease` acquires the instance/migration lease
 * and canonical root; `capability` runs the non-risky platform probe;
 * `database` opens/validates/migrates the store; `reconciliation` closes
 * business/outbox/projection gaps; `contracts` registers typed owners;
 * `projections` loads/rebuilds required read models; `window` creates the
 * hardened window and hands the renderer its bootstrap. The array order IS the
 * execution order and must not be reordered without a design change.
 */
export const BOOT_PHASES = Object.freeze([
  'lease',
  'capability',
  'database',
  'reconciliation',
  'contracts',
  'projections',
  'window',
] as const);
export type BootPhase = (typeof BOOT_PHASES)[number];

/**
 * Whether a phase is REQUIRED (its failure blocks mutation and forces
 * diagnostic-only startup) or OPTIONAL (its failure is isolated/scoped and does
 * not block the core boot). Per D-09: required authority, schema, integrity, or
 * isolation failures produce blocked/degraded surfaces; optional service
 * failures are scoped. The capability phase is required only for its MANDATORY
 * cells; an optional capability being unavailable is reported inside the phase
 * result as a scoped degrade, not a phase failure (see {@link CapabilityPhaseResult}).
 */
export const REQUIRED_PHASES: ReadonlySet<BootPhase> = new Set<BootPhase>([
  'lease',
  'capability',
  'database',
  'reconciliation',
  'contracts',
  'projections',
]);

/** The one phase that is best-effort UI and never blocks core mutation gating. */
export function isRequiredPhase(phase: BootPhase): boolean {
  return REQUIRED_PHASES.has(phase);
}

// ─── Per-phase outcome ─────────────────────────────────────────────────────

/** A typed, secret-free failure describing why a phase did not succeed. */
export interface PhaseFailure {
  /** Stable machine reason, e.g. `MIGRATION_LEASE_HELD`, `INTEGRITY_FAILED`. */
  readonly reason: string;
  /** Human-safe, secret-free, private-path-free message. */
  readonly message: string;
  /** Optional structured, secret-free detail. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

/**
 * The outcome of running a single phase. A phase either succeeds (optionally
 * carrying scoped-health entries and required-capability states it observed),
 * or fails with a typed reason. `scopedHealth` entries are advisory truth that
 * flow into the readiness report; `requiredCapabilities` are the capabilities
 * the readiness computation must find `ready` for the profile to be ready.
 */
export interface PhaseOutcome {
  readonly phase: BootPhase;
  readonly ok: boolean;
  readonly failure?: PhaseFailure;
  /** Scoped-health entries this phase contributes to the readiness report. */
  readonly scopedHealth?: readonly ScopedHealthEntry[];
  /** Required-capability states this phase attests for readiness. */
  readonly requiredCapabilities?: readonly RequiredCapabilityState[];
  /**
   * Optional-capability degrades observed by this phase (isolated, non-blocking).
   * Present chiefly on the capability phase; recorded for truthful reporting but
   * NEVER treated as a phase failure.
   */
  readonly isolatedDegrades?: readonly ScopedHealthEntry[];
  /** Signals this phase contributes (e.g. migration state after the database phase). */
  readonly signals?: Partial<ReadinessSignals>;
}

/** A phase function: given the accumulated context, produce a typed outcome. */
export type PhaseRunner = (ctx: PhaseContext) => PhaseOutcome | Promise<PhaseOutcome>;

/**
 * Read-only accumulated context handed to each phase. It exposes the outcomes
 * of prior phases so, e.g., the contract-registration phase can confirm the
 * database phase produced a writable authority before registering mutating
 * owners (no handler race).
 */
export interface PhaseContext {
  readonly profile: string;
  /** Prior phase outcomes in execution order. */
  readonly completed: readonly PhaseOutcome[];
  /** Whether every prior REQUIRED phase succeeded. */
  readonly requiredHealthy: boolean;
}

// ─── Startup result ─────────────────────────────────────────────────────────

/**
 * The startup mode the coordinator resolves to. `full` means every required
 * phase succeeded and readiness may be current; `diagnostic-only` means a
 * required phase blocked, so mutation is prohibited and only read-only /
 * diagnostic surfaces are exposed (D-09, D-19.4).
 */
export type StartupMode = 'full' | 'diagnostic-only';

/**
 * The outcome of a full boot. `mode` is `diagnostic-only` iff a required phase
 * failed. `mutationAllowed` is true only in `full` mode. `readiness` is the
 * truthful scoped readiness report. `firstRequiredFailure` names the blocking
 * phase when diagnostic-only. `phaseOutcomes` is the full ordered trace.
 */
export interface StartupResult {
  readonly profile: string;
  readonly mode: StartupMode;
  readonly mutationAllowed: boolean;
  /** Phases actually executed, in order. Phases after a required failure are skipped. */
  readonly phaseOutcomes: readonly PhaseOutcome[];
  /** The first required phase that failed, if any. */
  readonly firstRequiredFailure?: PhaseOutcome;
  /** Optional (scoped) phase failures that did NOT block the core boot. */
  readonly isolatedFailures: readonly PhaseOutcome[];
  readonly readiness: ReadinessReport;
  readonly liveness: LivenessReport;
}

// ─── Coordinator ─────────────────────────────────────────────────────────────

export interface RunStartupOptions {
  readonly profile: string;
  /**
   * The phase runners keyed by phase. Every phase in {@link BOOT_PHASES} must be
   * supplied; a missing phase is treated as a required failure (a boot cannot
   * silently skip a phase).
   */
  readonly phases: Readonly<Record<BootPhase, PhaseRunner>>;
  /** Liveness signal (the event loop responded). Defaults to true. */
  readonly live?: boolean;
  /** Injectable clock. */
  readonly now?: () => number;
  /**
   * Baseline operational signals. The database phase may override
   * `migrationState`; other signals default to a quiescent foundation.
   */
  readonly baselineSignals?: Partial<ReadinessSignals>;
}

const QUIESCENT_SIGNALS: ReadinessSignals = Object.freeze({
  migrationState: 'current',
  projectionLag: 0,
  outboxLag: 0,
  queueDepth: 0,
  budgetPressure: 'none',
  circuitState: 'closed',
  staleEvidence: false,
});

/**
 * Run the ordered boot phases and produce a truthful startup result.
 *
 * Ordering & gating rules (D-09):
 *   1. Phases run strictly in {@link BOOT_PHASES} order.
 *   2. A REQUIRED phase failure stops the sequence immediately: no later phase
 *      runs (so no handler/owner registers against a not-ready authority — no
 *      handler race), and the app resolves to `diagnostic-only` with mutation
 *      prohibited.
 *   3. An OPTIONAL phase failure is recorded as an isolated failure but the
 *      boot continues; it never flips the mode to diagnostic-only.
 *   4. Readiness is computed from the required-capability states and signals the
 *      phases attested. In diagnostic-only mode, migration state is forced to at
 *      least `pending`/`blocked` and staleEvidence is not asserted fresh, so a
 *      blocked boot can never report `ready` (defense in depth over rule 2).
 */
export async function runStartup(options: RunStartupOptions): Promise<StartupResult> {
  const now = options.now ?? Date.now;
  const phaseOutcomes: PhaseOutcome[] = [];
  const requiredCapabilities: RequiredCapabilityState[] = [];
  const scopedHealth: ScopedHealthEntry[] = [];
  const isolatedFailures: PhaseOutcome[] = [];
  let signals: ReadinessSignals = { ...QUIESCENT_SIGNALS, ...(options.baselineSignals ?? {}) };

  let firstRequiredFailure: PhaseOutcome | undefined;
  let requiredHealthy = true;

  for (const phase of BOOT_PHASES) {
    // Rule 2: once a required phase failed, run no further phases at all.
    if (firstRequiredFailure) break;

    const runner = options.phases[phase];
    const outcome: PhaseOutcome = runner
      ? normalizeOutcome(phase, await runner({
          profile: options.profile,
          completed: [...phaseOutcomes],
          requiredHealthy,
        }))
      : {
          phase,
          ok: false,
          failure: {
            reason: 'PHASE_NOT_PROVIDED',
            message: `boot phase '${phase}' has no runner; a boot cannot skip a phase`,
          },
        };

    phaseOutcomes.push(outcome);

    // Accumulate truthful readiness inputs from every phase that ran.
    if (outcome.requiredCapabilities) {
      requiredCapabilities.push(...outcome.requiredCapabilities);
    }
    if (outcome.scopedHealth) scopedHealth.push(...outcome.scopedHealth);
    if (outcome.isolatedDegrades) scopedHealth.push(...outcome.isolatedDegrades);
    if (outcome.signals) signals = { ...signals, ...outcome.signals };

    if (!outcome.ok) {
      if (isRequiredPhase(phase)) {
        firstRequiredFailure = outcome;
        requiredHealthy = false;
      } else {
        isolatedFailures.push(outcome);
      }
    }
  }

  const mode: StartupMode = firstRequiredFailure ? 'diagnostic-only' : 'full';

  // Defense in depth (rule 4): a blocked boot can never look ready. Mark the
  // blocking dimension so computeReadiness returns ready=false even if a phase
  // mistakenly attested a `ready` required capability before the block.
  if (mode === 'diagnostic-only') {
    if (signals.migrationState === 'current') {
      signals = { ...signals, migrationState: 'blocked' };
    }
    // Ensure the blocking phase is represented as a not-ready required cap.
    requiredCapabilities.push({
      capability: `boot:${firstRequiredFailure!.phase}`,
      status: 'blocked' satisfies CapabilityStatus,
    });
  }

  const readiness = computeReadiness({
    profile: options.profile,
    requiredCapabilities,
    scopedHealth,
    signals,
    now,
  });

  return {
    profile: options.profile,
    mode,
    mutationAllowed: mode === 'full',
    phaseOutcomes,
    ...(firstRequiredFailure ? { firstRequiredFailure } : {}),
    isolatedFailures,
    readiness,
    liveness: buildLivenessReport(options.live ?? true, now),
  };
}

/** Normalize a runner's return into a well-formed outcome bound to its phase. */
function normalizeOutcome(phase: BootPhase, raw: PhaseOutcome): PhaseOutcome {
  // A runner may return a differently-phased object by mistake; bind it to the
  // phase actually being executed so the trace is always accurate.
  return raw.phase === phase ? raw : { ...raw, phase };
}

// ─── Convenience builders (used by production wiring and tests) ───────────────

/** Build a successful phase outcome. */
export function phaseOk(
  phase: BootPhase,
  extra: Omit<PhaseOutcome, 'phase' | 'ok' | 'failure'> = {},
): PhaseOutcome {
  return { phase, ok: true, ...extra };
}

/** Build a failed phase outcome with a typed, secret-free reason. */
export function phaseFail(
  phase: BootPhase,
  failure: PhaseFailure,
  extra: Omit<PhaseOutcome, 'phase' | 'ok' | 'failure'> = {},
): PhaseOutcome {
  return { phase, ok: false, failure, ...extra };
}

/**
 * The capability phase's structured result. The capability probe is required
 * only for its MANDATORY cells (strict-isolation, key-storage,
 * native-dependency, update-target). An absent mandatory cell fails the phase
 * (required); an absent/degraded OPTIONAL cell is recorded as an isolated
 * degrade and the phase still succeeds (D-09 scoped optional failure).
 */
export interface CapabilityPhaseResult {
  /** Required cells and their attested status (each must be `ready` for readiness). */
  readonly requiredCapabilities: readonly RequiredCapabilityState[];
  /** Optional cells that are not `ready` — recorded, isolated, non-blocking. */
  readonly isolatedDegrades: readonly ScopedHealthEntry[];
  /** Whether any MANDATORY cell was not `ready` (fails the phase). */
  readonly mandatoryBlocked: boolean;
  /** The first mandatory failure reason, when `mandatoryBlocked`. */
  readonly mandatoryFailure?: PhaseFailure;
}
