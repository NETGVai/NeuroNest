/**
 * Production wiring for the phased startup coordinator (FUT-PKG-02-FOUNDATION/
 * T-006). This module turns the five completed foundation authorities into the
 * concrete {@link PhaseRunner}s the coordinator executes in D-09 order, and
 * exposes a single {@link runFoundationStartup} entry point that
 * `electron-app.ts` calls behind the developer-profile flag.
 *
 * It is deliberately kept out of `electron-app.ts` so the composition is unit-
 * and property-testable without a live Electron runtime: every collaborator is
 * injected through {@link FoundationStartupDeps}, defaulting to the real
 * foundation modules. Nothing here starts the legacy app or changes the 3.1
 * security posture; it composes descriptive/authority truth and returns a
 * typed startup result. The caller decides what to do with a diagnostic-only
 * result.
 *
 * Design anchors: D-05, D-09, D-17, D-18, D-19, D-20.
 * Requirements: NN-DATA-001..006/013, NN-EVENT-005/007, NN-PLATFORM-001/002/007,
 * NN-OBS-005, NN-COMPAT-001..003.
 */

import os from 'node:os';

import {
  resolveDataRootPaths,
  acquireInstanceLease,
  type DataRootPaths,
  type Lease,
} from '../storage/data-root.js';
import {
  startupDatabase,
  type StartupResult as DatabaseStartupResult,
  type StartupOptions as DatabaseStartupOptions,
} from '../storage/database-authority.js';
import {
  canonicalArchitecture,
  canonicalPlatform,
  evaluateCapability,
  UNAVAILABLE_ON_ABSENCE,
  type Architecture,
  type CapabilityCellInput,
  type CapabilityStatus,
  type Platform,
} from '../shared/capability-registry.js';
import { buildFoundationContractRegistry } from '../ipc/foundation-contract-catalog.js';
import type { ContractRegistry } from '../ipc/contract-registry.js';
import {
  buildDiagnosticExport,
  makeRegistryRevisionDescriptor,
  type DiagnosticExportOutcome,
  type ReadinessReport,
  type RequiredCapabilityState,
  type ScopedHealthEntry,
} from '../shared/evidence-observability.js';

import {
  runStartup,
  phaseOk,
  phaseFail,
  type BootPhase,
  type PhaseRunner,
  type StartupResult,
} from './startup-coordinator.js';

// ─── Injected collaborators ──────────────────────────────────────────────────

/**
 * A single capability probe fact the platform layer observes without executing
 * the risky operation (NN-INV-001). `capabilityId`, its control set, and the
 * observed present/missing controls are supplied by the caller; the coordinator
 * classifies them through {@link evaluateCapability}. Production passes the
 * live, non-risky observations; tests pass fixtures.
 */
export interface CapabilityObservation {
  readonly capabilityId: CapabilityCellInput['capabilityId'];
  readonly adapterId?: string | null;
  readonly adapterVersion?: string | null;
  readonly controlSet?: readonly string[];
  readonly controlsPresent: readonly string[];
  readonly controlsMissing: readonly string[];
  readonly configPresent?: boolean;
  readonly prerequisiteBlocked?: boolean;
  readonly evidenceRevision?: number;
  readonly note?: string;
}

export interface FoundationStartupDeps {
  /** Resolve the canonical DataRoot paths. Defaults to {@link resolveDataRootPaths}. */
  readonly resolvePaths?: (root?: string) => DataRootPaths;
  /** Acquire the single-instance lease. Defaults to {@link acquireInstanceLease}. */
  readonly acquireInstance?: typeof acquireInstanceLease;
  /** Run the phased database startup. Defaults to {@link startupDatabase}. */
  readonly startupDatabase?: (options?: DatabaseStartupOptions) => DatabaseStartupResult;
  /**
   * Non-risky capability observations for the current platform cell. Defaults
   * to a conservative empty set (which makes every mandatory capability
   * `unavailable` — the app then boots diagnostic-only rather than assuming
   * unproven platform support, NN-INV-001).
   */
  readonly capabilityObservations?: readonly CapabilityObservation[];
  /** Override the detected platform (tests). Defaults to the host platform. */
  readonly platform?: Platform;
  /** Override the detected architecture (tests). Defaults to the host arch. */
  readonly architecture?: Architecture;
  /** Build the target contract registry. Defaults to {@link buildFoundationContractRegistry}. */
  readonly buildContracts?: () => ContractRegistry;
  /**
   * Reconcile business/outbox/projection gaps. Defaults to a no-op success (the
   * durability package owns real reconciliation; the foundation gate only
   * requires the phase to run and report a typed result). Returning `false`
   * (with a reason) blocks the boot as a required failure.
   */
  readonly reconcile?: () => ReconcileOutcome | Promise<ReconcileOutcome>;
  /**
   * Load/rebuild the required projections. Defaults to a no-op success. Returns
   * a typed failure to block the boot.
   */
  readonly loadProjections?: () => ProjectionOutcome | Promise<ProjectionOutcome>;
  /**
   * Create the hardened window and hand the renderer its bootstrap. Defaults to
   * a no-op success. This is the ONLY non-required phase: a window failure is
   * isolated and does not prohibit core mutation gating.
   */
  readonly createHardenedWindow?: () => WindowOutcome | Promise<WindowOutcome>;
  /** Injectable clock. */
  readonly now?: () => number;
  /** Whether the event loop responded (liveness). Defaults to true. */
  readonly live?: boolean;
}

export interface ReconcileOutcome {
  readonly ok: boolean;
  readonly reason?: string;
  readonly message?: string;
  readonly reconciled?: number;
  readonly unmatched?: number;
}

export interface ProjectionOutcome {
  readonly ok: boolean;
  readonly reason?: string;
  readonly message?: string;
  /** Projection lag after load/rebuild (0 when current). */
  readonly projectionLag?: number;
}

export interface WindowOutcome {
  readonly ok: boolean;
  readonly reason?: string;
  readonly message?: string;
}

// ─── Result carrying the built authorities ───────────────────────────────────

/**
 * The foundation startup outcome: the coordinator's typed result plus the
 * durable authorities it built when the boot reached them. In diagnostic-only
 * mode the database handle (if any) is a read-only/degraded or freshly-closed
 * handle and `contracts` is undefined (contracts never register when a required
 * authority blocked — no handler race).
 */
export interface FoundationStartupResult {
  readonly startup: StartupResult;
  /** The resolved canonical paths, when the lease/root phase ran. */
  readonly paths?: DataRootPaths;
  /** The database startup result, when the database phase ran. */
  readonly database?: DatabaseStartupResult;
  /** The registered contract authority, present ONLY in full mode. */
  readonly contracts?: ContractRegistry;
  /** Instance lease held for the process lifetime; release on shutdown. */
  readonly instanceLease?: Lease;
}

// ─── The composed boot ────────────────────────────────────────────────────────

const FOUNDATION_PROFILE = 'foundation-desktop';

/**
 * Compose and run the D-09 phased startup against the foundation authorities.
 * Returns the typed startup result and the authorities that were built. Never
 * throws for an expected fault: a faulted phase resolves to a typed
 * diagnostic-only result with `mutationAllowed=false`.
 */
export async function runFoundationStartup(
  deps: FoundationStartupDeps = {},
): Promise<FoundationStartupResult> {
  const resolvePaths = deps.resolvePaths ?? resolveDataRootPaths;
  const acquireInstance = deps.acquireInstance ?? acquireInstanceLease;
  const runDb = deps.startupDatabase ?? startupDatabase;
  const buildContracts = deps.buildContracts ?? (() => buildFoundationContractRegistry());
  const now = deps.now ?? Date.now;
  const nowIso = () => new Date(now()).toISOString();

  const platform =
    deps.platform ?? canonicalPlatform(process.platform);
  const architecture =
    deps.architecture ??
    (platform ? canonicalArchitecture(platform, os.arch()) : undefined);

  // Mutable carriers the phase runners populate as the boot progresses.
  const built: {
    paths?: DataRootPaths;
    database?: DatabaseStartupResult;
    contracts?: ContractRegistry;
    instanceLease?: Lease;
  } = {};

  const phases: Record<BootPhase, PhaseRunner> = {
    // 1) instance/migration lease + canonical root.
    lease: () => {
      let paths: DataRootPaths;
      try {
        paths = resolvePaths();
      } catch (err) {
        return phaseFail('lease', {
          reason: 'ROOT_UNRESOLVED',
          message: 'canonical data root could not be resolved/created',
          detail: { error: safeErr(err) },
        });
      }
      built.paths = paths;
      const leaseResult = acquireInstance(paths, { now });
      if (!leaseResult.acquired) {
        return phaseFail('lease', {
          reason: 'INSTANCE_LEASE_HELD',
          message: 'another application instance holds the single-instance lease',
        });
      }
      built.instanceLease = leaseResult.lease;
      return phaseOk('lease');
    },

    // 2) non-risky capability probe.
    capability: () => {
      if (!platform || !architecture) {
        // Unsupported/unknown platform cell: never assume support (NN-INV-001).
        return phaseFail('capability', {
          reason: 'UNSUPPORTED_PLATFORM',
          message: 'running platform/architecture is not a declared target cell',
          detail: { nodePlatform: process.platform, nodeArch: os.arch() },
        });
      }
      const observations = deps.capabilityObservations ?? [];
      const byId = new Map(observations.map((o) => [o.capabilityId, o]));
      const requiredCapabilities: RequiredCapabilityState[] = [];
      const isolatedDegrades: ScopedHealthEntry[] = [];
      let mandatoryFailure: { reason: string; message: string; detail?: Record<string, unknown> } | undefined;

      // Evaluate every mandatory cell; an absent mandatory cell fails the phase.
      for (const capabilityId of UNAVAILABLE_ON_ABSENCE) {
        const obs = byId.get(capabilityId);
        const evaluation = evaluateCapability({
          capabilityId,
          platform,
          architecture,
          adapterId: obs?.adapterId ?? null,
          adapterVersion: obs?.adapterVersion ?? null,
          controlSet: obs?.controlSet ?? [],
          probe: {
            controlsPresent: obs?.controlsPresent ?? [],
            controlsMissing: obs?.controlsMissing ?? [],
            ...(obs?.configPresent !== undefined ? { configPresent: obs.configPresent } : {}),
            ...(obs?.prerequisiteBlocked !== undefined
              ? { prerequisiteBlocked: obs.prerequisiteBlocked }
              : {}),
            ...(obs?.note !== undefined ? { note: obs.note } : {}),
          },
          ...(obs?.evidenceRevision !== undefined ? { evidenceRevision: obs.evidenceRevision } : {}),
          lastCheckedAt: nowIso(),
        });
        const status = evaluation.record.status;
        requiredCapabilities.push({ capability: `capability:${capabilityId}`, status });
        if (status !== 'ready' && status !== 'degraded' && !mandatoryFailure) {
          mandatoryFailure = {
            reason: 'MANDATORY_CAPABILITY_UNAVAILABLE',
            message: `mandatory capability '${capabilityId}' is ${status} on ${platform}/${architecture}`,
            detail: { capabilityId, status },
          };
        }
      }

      // Evaluate any additional (optional) observed cells; degrades are isolated.
      for (const obs of observations) {
        if ((UNAVAILABLE_ON_ABSENCE as readonly string[]).includes(obs.capabilityId)) continue;
        const evaluation = evaluateCapability({
          capabilityId: obs.capabilityId,
          platform,
          architecture,
          adapterId: obs.adapterId ?? null,
          adapterVersion: obs.adapterVersion ?? null,
          controlSet: obs.controlSet ?? [],
          probe: {
            controlsPresent: obs.controlsPresent,
            controlsMissing: obs.controlsMissing,
            ...(obs.configPresent !== undefined ? { configPresent: obs.configPresent } : {}),
            ...(obs.prerequisiteBlocked !== undefined
              ? { prerequisiteBlocked: obs.prerequisiteBlocked }
              : {}),
          },
          lastCheckedAt: nowIso(),
        });
        if (evaluation.record.status !== 'ready') {
          isolatedDegrades.push({
            capability: `capability:${obs.capabilityId}`,
            status: evaluation.record.status,
            lastCheckedAt: evaluation.record.lastCheckedAt,
            reason: evaluation.record.reason,
          });
        }
      }

      if (mandatoryFailure) {
        return phaseFail('capability', mandatoryFailure, {
          requiredCapabilities,
          isolatedDegrades,
        });
      }
      return phaseOk('capability', { requiredCapabilities, isolatedDegrades });
    },

    // 3) database open / schema / migration.
    database: () => {
      const result = runDb(built.paths ? { paths: built.paths } : {});
      built.database = result;
      if (!result.ok) {
        return phaseFail('database', {
          reason: result.error.reason,
          message: result.error.message,
        }, {
          requiredCapabilities: [
            { capability: 'schema', status: 'blocked' },
            { capability: 'integrity', status: 'blocked' },
          ],
          signals: { migrationState: 'blocked' },
        });
      }
      if (result.mode === 'degraded-read-only') {
        // Newer on-disk schema: no writer. This is a required-authority degrade;
        // mutation must not proceed, so it blocks the boot (diagnostic-only).
        return phaseFail('database', {
          reason: result.reason,
          message: 'on-disk schema is newer than this build supports; read-only',
          detail: { schemaVersion: result.schemaVersion },
        }, {
          requiredCapabilities: [{ capability: 'schema', status: 'degraded' }],
          signals: { migrationState: 'blocked' },
        });
      }
      return phaseOk('database', {
        requiredCapabilities: [
          { capability: 'schema', status: 'ready' },
          { capability: 'integrity', status: 'ready' },
        ],
        signals: { migrationState: 'current' },
      });
    },

    // 4) reconciliation.
    reconciliation: async () => {
      const outcome = deps.reconcile ? await deps.reconcile() : { ok: true };
      if (!outcome.ok) {
        return phaseFail('reconciliation', {
          reason: outcome.reason ?? 'RECONCILIATION_FAILED',
          message: outcome.message ?? 'startup reconciliation did not complete',
        });
      }
      return phaseOk('reconciliation', {
        requiredCapabilities: [{ capability: 'reconciliation', status: 'ready' }],
      });
    },

    // 5) typed contract registration (owners) — only reached when required
    //    authorities above are ready, so handlers never register against a
    //    not-ready authority (no handler race, D-09).
    contracts: () => {
      try {
        built.contracts = buildContracts();
      } catch (err) {
        return phaseFail('contracts', {
          reason: 'CONTRACT_REGISTRATION_FAILED',
          message: 'typed contract registry could not be built',
          detail: { error: safeErr(err) },
        });
      }
      return phaseOk('contracts', {
        requiredCapabilities: [{ capability: 'contracts', status: 'ready' }],
      });
    },

    // 6) required projections load/rebuild.
    projections: async () => {
      const outcome = deps.loadProjections ? await deps.loadProjections() : { ok: true };
      if (!outcome.ok) {
        return phaseFail('projections', {
          reason: outcome.reason ?? 'PROJECTION_LOAD_FAILED',
          message: outcome.message ?? 'required projections did not load/rebuild',
        });
      }
      return phaseOk('projections', {
        requiredCapabilities: [{ capability: 'projections', status: 'ready' }],
        ...(outcome.projectionLag !== undefined
          ? { signals: { projectionLag: outcome.projectionLag } }
          : {}),
      });
    },

    // 7) hardened window + renderer bootstrap (isolated: best-effort UI).
    window: async () => {
      const outcome = deps.createHardenedWindow ? await deps.createHardenedWindow() : { ok: true };
      if (!outcome.ok) {
        return phaseFail('window', {
          reason: outcome.reason ?? 'WINDOW_CREATE_FAILED',
          message: outcome.message ?? 'hardened window creation failed',
        });
      }
      return phaseOk('window');
    },
  };

  const startup = await runStartup({
    profile: FOUNDATION_PROFILE,
    phases,
    ...(deps.live !== undefined ? { live: deps.live } : {}),
    now,
  });

  // Enforce the no-handler-race invariant at the boundary: if the boot did not
  // reach full mode, the contract authority is NOT exposed even if a later
  // (skipped) code path had populated it. In practice contracts is only set by
  // the contracts phase, which only runs when required authorities are ready.
  const contracts = startup.mode === 'full' ? built.contracts : undefined;

  return {
    startup,
    ...(built.paths ? { paths: built.paths } : {}),
    ...(built.database ? { database: built.database } : {}),
    ...(contracts ? { contracts } : {}),
    ...(built.instanceLease ? { instanceLease: built.instanceLease } : {}),
  };
}

// ─── Diagnostic-only export (D-19.4, NN-SEC-015) ─────────────────────────────

/**
 * Build the bounded, redacted diagnostic export a blocked/diagnostic-only boot
 * exposes instead of mutation surfaces. It reuses the evidence authority's
 * abort-on-unredactable export so a diagnostic-only startup can never leak a
 * secret or private path (NN-SEC-015). `authorized` must be an explicit user
 * authorization; an unauthorized export aborts.
 */
export function buildStartupDiagnosticExport(
  result: FoundationStartupResult,
  options: { readonly authorized: boolean; readonly environmentFingerprint: string },
): DiagnosticExportOutcome {
  const readiness: ReadinessReport = result.startup.readiness;
  const capabilityMatrix: ScopedHealthEntry[] = [...readiness.scopedHealth];
  const registryDescriptors = result.contracts
    ? [
        makeRegistryRevisionDescriptor({
          registryType: 'ipc-contracts',
          applicationRevision: 1,
          count: result.contracts.size,
        }),
      ]
    : [];
  const schemas =
    result.database && result.database.ok
      ? [{ name: 'sqlite', version: result.database.schemaVersion }]
      : [];
  const errorCorrelations = result.startup.firstRequiredFailure
    ? [
        {
          correlationId: `boot-${result.startup.firstRequiredFailure.phase}`,
          code: result.startup.firstRequiredFailure.failure?.reason ?? 'UNKNOWN',
          count: 1,
        },
      ]
    : [];

  return buildDiagnosticExport({
    capabilityMatrix,
    registryDescriptors,
    schemas,
    readiness,
    errorCorrelations,
    environmentFingerprint: options.environmentFingerprint,
    authorized: options.authorized,
  });
}

function safeErr(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Strip anything that looks like an absolute home path so a phase detail can
  // never carry a private path across an observable boundary.
  return message.replace(/\/(Users|home)\/[^\s/]+/g, '/<home>');
}

export { FOUNDATION_PROFILE };
