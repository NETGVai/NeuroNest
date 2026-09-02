/**
 * Capability Registry — platform readiness records (D-05, D-17).
 *
 * Implements the CapabilityRegistry component (D-05) and the D-17 portability
 * capability matrix as revisioned, descriptive-only records for macOS, Windows,
 * and Linux architecture cells. Each record covers an adapter/version and its
 * control set, a status/reason, an optional evidence revision, and the
 * `ready | degraded | unavailable | blocked` scoped-health semantics reported
 * by readiness (D-19.4).
 *
 * Trust posture (NN-INV-001/002/011/014, NN-PLATFORM-002..007):
 *   - Probing is *non-risky*: a probe reports observed presence/absence of a
 *     control without executing the risky operation itself (no host spawn, no
 *     process launch, no credential read, no network install, no artifact
 *     selection). Verification of a real capability runs in controlled fixtures
 *     (D-17), never here.
 *   - Absence of strict isolation, an OS key store, a required native
 *     dependency, or a valid update target returns a typed `UNAVAILABLE`
 *     `ErrorEnvelope@1`. It NEVER relabels itself `ready`, and it authorizes no
 *     unsandboxed fallback, plaintext credential fallback, host spawn, or
 *     nearby-artifact selection (D-03.1, R6, CD-001).
 *   - Configuration presence is not readiness (D-05): a config file or manifest
 *     entry alone yields at most `degraded` and never `ready`.
 *
 * This task is deliberately additive (FUT-PKG-02-FOUNDATION/T-004): the registry
 * is *descriptive truth* only. It does not gate any consumer. Rollback disables
 * a capability adapter (removes/records a cell); it cannot relabel an
 * `unavailable` cell as `ready`.
 *
 * Design anchors: D-03, D-05, D-09, D-17, D-19.
 * Requirements: NN-INV-001/002/011/014, NN-PLATFORM-002..007, NN-OBS-005.
 */

import {
  CONTRACT_WRITE_VERSION,
  isRevision,
  isTimestamp,
  makeOpaqueId,
  type ErrorEnvelope,
  type RedactionClass,
} from './contract-primitives';

// ─── Platform / architecture cells (D-17, NN-PLATFORM-002/003) ──────────────

/** The three supported desktop platforms (D-17). */
export const PLATFORMS = Object.freeze(['macos', 'windows', 'linux'] as const);
export type Platform = (typeof PLATFORMS)[number];

/**
 * Canonical target architectures. `universal` is the macOS canonical identity
 * (NN-PLATFORM-003); `arm64`/`x64` are the measured cells. Windows/Linux use
 * `x64`/`arm64` (D-17 packaging identity row).
 */
export const ARCHITECTURES = Object.freeze([
  'universal',
  'arm64',
  'x64',
] as const);
export type Architecture = (typeof ARCHITECTURES)[number];

/** Whether a value is a known platform. */
export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);
}

/** Whether a value is a known architecture. */
export function isArchitecture(value: unknown): value is Architecture {
  return (
    typeof value === 'string' && (ARCHITECTURES as readonly string[]).includes(value)
  );
}

/**
 * Map a Node/Electron `process.platform` value to a canonical {@link Platform},
 * or `undefined` for an unrecognized platform (which must be treated as
 * unavailable, never assumed supported — NN-INV-001).
 */
export function canonicalPlatform(nodePlatform: string): Platform | undefined {
  switch (nodePlatform) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    case 'linux':
      return 'linux';
    default:
      return undefined;
  }
}

/**
 * Map a Node `os.arch()`/`process.arch` value to a canonical
 * {@link Architecture}, or `undefined` for an unrecognized architecture.
 * macOS resolves to the canonical `universal` identity (NN-PLATFORM-003); the
 * measured `arm64`/`intel` aliases stay resolution aliases only.
 */
export function canonicalArchitecture(
  platform: Platform,
  nodeArch: string,
): Architecture | undefined {
  if (platform === 'macos') {
    // macOS canonical identity is the universal artifact; arm64/x64 are
    // measured aliases that still resolve to the universal cell.
    if (nodeArch === 'arm64' || nodeArch === 'x64') return 'universal';
    return undefined;
  }
  if (nodeArch === 'arm64') return 'arm64';
  if (nodeArch === 'x64') return 'x64';
  return undefined;
}

// ─── Capability identities (D-17 matrix rows) ───────────────────────────────

/**
 * The capability rows of the D-17 portability matrix. These are the cells a
 * platform must declare (NN-PLATFORM-002). `strict-isolation`, `key-storage`,
 * `native-dependency`, and `update-target` are the four that MUST return typed
 * `UNAVAILABLE` when absent (task acceptance; D-17 "Required unavailable
 * behavior" column).
 */
export const CAPABILITY_IDS = Object.freeze([
  'strict-isolation',
  'degraded-read-only',
  'pty',
  'process-tree-cancellation',
  'key-storage',
  'path-filesystem',
  'packaging-identity',
  'update-target',
  'webview-guest',
  'native-dependency',
] as const);
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/**
 * The capabilities whose absence MUST yield a typed `UNAVAILABLE` with no risky
 * probe, host spawn, plaintext fallback, or nearby-artifact selection (task
 * acceptance). Kept as a named set so the guarantee is testable and stable.
 */
export const UNAVAILABLE_ON_ABSENCE = Object.freeze([
  'strict-isolation',
  'key-storage',
  'native-dependency',
  'update-target',
] as const);
export type MandatoryUnavailableCapability =
  (typeof UNAVAILABLE_ON_ABSENCE)[number];

/** Whether a value is a known capability id. */
export function isCapabilityId(value: unknown): value is CapabilityId {
  return (
    typeof value === 'string' &&
    (CAPABILITY_IDS as readonly string[]).includes(value)
  );
}

/** Whether a capability must return `UNAVAILABLE` on absence (task acceptance). */
export function requiresUnavailableOnAbsence(
  capabilityId: CapabilityId,
): capabilityId is MandatoryUnavailableCapability {
  return (UNAVAILABLE_ON_ABSENCE as readonly string[]).includes(capabilityId);
}

// ─── Scoped-health status semantics (D-19.4) ────────────────────────────────

/**
 * Scoped-health status ladder (D-19.4). `ready` requires the capability and its
 * evidence to be current; `degraded` is a named, audited reduced mode;
 * `unavailable` means the capability is absent (no adapter/control); `blocked`
 * means a current-truth prerequisite (schema/integrity/policy) is not met so
 * the capability cannot be advertised even though an adapter may exist.
 */
export const CAPABILITY_STATUSES = Object.freeze([
  'ready',
  'degraded',
  'unavailable',
  'blocked',
] as const);
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/** Whether a value is a known capability status. */
export function isCapabilityStatus(value: unknown): value is CapabilityStatus {
  return (
    typeof value === 'string' &&
    (CAPABILITY_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Whether a status means the capability may be advertised/consumed as present.
 * Only `ready` and `degraded` are "present" states; `degraded` callers must
 * still honor the reduced-mode constraints (D-18 degraded read-only).
 */
export function isAdvertisableStatus(status: CapabilityStatus): boolean {
  return status === 'ready' || status === 'degraded';
}

// ─── Probe result (non-risky) ───────────────────────────────────────────────

/**
 * The outcome of a *non-risky* capability probe. A probe observes whether a
 * control is present without exercising it. `controlsPresent` lists the
 * concrete controls observed; `controlsMissing` lists required controls that
 * were not observed. A probe MUST NOT spawn a host, launch a process, read a
 * credential, perform network I/O, or select an artifact (NN-INV-001).
 */
export interface CapabilityProbe {
  /** Controls observed present (e.g. `sandbox-profile`, `keychain`). */
  readonly controlsPresent: readonly string[];
  /** Required controls observed absent. Non-empty means the cell is not ready. */
  readonly controlsMissing: readonly string[];
  /**
   * Whether a config/manifest entry is present. Config presence alone is NOT
   * readiness (D-05); it can raise a cell to at most `degraded`.
   */
  readonly configPresent?: boolean;
  /**
   * Whether a current-truth prerequisite (schema/integrity/policy) is
   * unsatisfied. When true, the cell is `blocked` even if controls are present.
   */
  readonly prerequisiteBlocked?: boolean;
  /** Human-safe, secret-free note about how the observation was made. */
  readonly note?: string;
}

// ─── Capability record (D-17) ───────────────────────────────────────────────

/**
 * A revisioned capability record for one platform/architecture cell (D-17):
 * `{capabilityId, platform, architecture, status, adapterId/version,
 * controlSet, evidenceRevision?, lastCheckedAt, reason}`. `recordRevision` is
 * the monotonic revision of this descriptive record (D-06.1 revisions);
 * `evidenceRevision` is the revision of the fixture evidence that justified a
 * `ready` status, absent until controlled verification runs (D-17).
 */
export interface CapabilityRecord {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  /** Opaque id of this record cell, e.g. `capability-strict_isolation_macos_universal`. */
  readonly capabilityCellId: string;
  readonly capabilityId: CapabilityId;
  readonly platform: Platform;
  readonly architecture: Architecture;
  readonly status: CapabilityStatus;
  /** Adapter that would implement the capability; `null` when none is declared. */
  readonly adapterId: string | null;
  /** Adapter version; `null` when no adapter is declared. */
  readonly adapterVersion: string | null;
  /** The required control set for this capability cell (may be empty). */
  readonly controlSet: readonly string[];
  /** Controls observed present at probe time. */
  readonly controlsPresent: readonly string[];
  /** Required controls observed missing at probe time. */
  readonly controlsMissing: readonly string[];
  /** Fixture evidence revision justifying a `ready` status (D-17); optional. */
  readonly evidenceRevision?: number;
  /** Monotonic revision of this descriptive record. */
  readonly recordRevision: number;
  /** RFC 3339 UTC timestamp of the last non-risky check. */
  readonly lastCheckedAt: string;
  /** Safe, secret-free, private-path-free status reason. */
  readonly reason: string;
  /** Redaction class of this record; always observable (never `secret`). */
  readonly redaction: RedactionClass;
}

/** Deterministic opaque id for a capability cell. */
export function capabilityCellId(
  capabilityId: CapabilityId,
  platform: Platform,
  architecture: Architecture,
): string {
  return makeOpaqueId(
    'capability',
    `${capabilityId}_${platform}_${architecture}`,
  );
}

// ─── UNAVAILABLE error minting (NN-INV-011, D-06.2) ─────────────────────────

const REGISTRY_OWNER = 'authority-capability-registry';

/**
 * Mint a typed `UNAVAILABLE` `ErrorEnvelope@1` for an absent capability cell.
 * The message and remediation are safe (no secrets, no private absolute paths).
 * `retryable` is false: absence is a durable platform fact until an adapter is
 * added, not a transient error. The envelope authorizes no fallback of any kind
 * (NN-INV-001/011; D-17 "Required unavailable behavior").
 */
export function makeUnavailableError(args: {
  readonly capabilityId: CapabilityId;
  readonly platform: Platform;
  readonly architecture: Architecture;
  readonly missingControls: readonly string[];
  readonly correlationId?: string;
  readonly operation?: string;
}): ErrorEnvelope {
  const missing =
    args.missingControls.length > 0
      ? args.missingControls.join(', ')
      : 'required adapter/control set';
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code: 'UNAVAILABLE',
    message:
      `capability '${args.capabilityId}' is unavailable on ` +
      `${args.platform}/${args.architecture}: missing ${missing}`,
    owner: REGISTRY_OWNER,
    operation: args.operation ?? 'capability.probe',
    correlationId: isNonEmptyId(args.correlationId)
      ? (args.correlationId as string)
      : 'corr-unset',
    retryable: false,
    remediation:
      'Install and verify the required platform adapter and controls; ' +
      'no unsandboxed, plaintext, host-spawn, or nearby-artifact fallback is permitted.',
    redaction: 'internal',
  };
}

function isNonEmptyId(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

// ─── Status derivation (descriptive; non-risky) ─────────────────────────────

/**
 * Derive a capability status from a non-risky probe and whether an adapter is
 * declared, using the D-19.4 ladder and the D-05 "config is not readiness" rule:
 *
 *   - `blocked`     — a current-truth prerequisite is unsatisfied
 *     (`prerequisiteBlocked`), regardless of controls.
 *   - `unavailable` — no adapter is declared, or any required control is
 *     missing. For the four mandatory capabilities this is the typed-UNAVAILABLE
 *     case (see {@link evaluateCapability}).
 *   - `degraded`    — an adapter and all required controls are present but no
 *     current fixture evidence exists yet (`evidenceRevision` absent), OR only
 *     configuration presence was observed. Config presence never reaches
 *     `ready` (D-05).
 *   - `ready`       — adapter + all controls present AND a current fixture
 *     evidence revision justifies it.
 *
 * This function performs no I/O and never mutates anything; it is a pure
 * classifier over already-observed facts.
 */
export function deriveStatus(input: {
  readonly adapterDeclared: boolean;
  readonly probe: CapabilityProbe;
  readonly evidenceRevision?: number;
}): CapabilityStatus {
  const { adapterDeclared, probe, evidenceRevision } = input;

  if (probe.prerequisiteBlocked === true) {
    return 'blocked';
  }
  if (!adapterDeclared || probe.controlsMissing.length > 0) {
    return 'unavailable';
  }
  // Adapter + controls present. Config presence alone (no controls) already
  // handled above via controlsMissing. Readiness requires current evidence.
  if (isRevision(evidenceRevision)) {
    return 'ready';
  }
  return 'degraded';
}

// ─── Evaluate a cell into a record (+ optional typed UNAVAILABLE) ───────────

/**
 * The result of evaluating one capability cell: always a descriptive
 * {@link CapabilityRecord}, plus a typed `UNAVAILABLE` `ErrorEnvelope@1` when
 * the cell is a mandatory-unavailable capability observed absent (task
 * acceptance). The error is *descriptive*: producing it performs no risky
 * probe, host spawn, plaintext fallback, or artifact selection.
 */
export interface CapabilityEvaluation {
  readonly record: CapabilityRecord;
  /** Present only for mandatory capabilities evaluated as `unavailable`. */
  readonly unavailableError?: ErrorEnvelope;
}

/** Input describing a single cell to evaluate (all facts are pre-observed). */
export interface CapabilityCellInput {
  readonly capabilityId: CapabilityId;
  readonly platform: Platform;
  readonly architecture: Architecture;
  readonly adapterId?: string | null;
  readonly adapterVersion?: string | null;
  readonly controlSet?: readonly string[];
  readonly probe: CapabilityProbe;
  readonly evidenceRevision?: number;
  readonly recordRevision?: number;
  readonly lastCheckedAt?: string;
  readonly correlationId?: string;
}

/**
 * Evaluate one capability cell into a descriptive record. Pure and non-risky:
 * it classifies the pre-observed probe and mints the record; for a mandatory
 * capability observed `unavailable` it also mints the typed `UNAVAILABLE`
 * error. Never spawns, reads credentials, performs network I/O, or selects an
 * artifact (NN-INV-001).
 */
export function evaluateCapability(
  input: CapabilityCellInput,
): CapabilityEvaluation {
  const adapterId = input.adapterId ?? null;
  const adapterVersion = input.adapterVersion ?? null;
  const adapterDeclared = adapterId !== null;
  const controlSet = input.controlSet ?? [];
  const status = deriveStatus({
    adapterDeclared,
    probe: input.probe,
    evidenceRevision: input.evidenceRevision,
  });

  const reason = deriveReason(status, input);

  const record: CapabilityRecord = {
    schemaVersion: CONTRACT_WRITE_VERSION,
    capabilityCellId: capabilityCellId(
      input.capabilityId,
      input.platform,
      input.architecture,
    ),
    capabilityId: input.capabilityId,
    platform: input.platform,
    architecture: input.architecture,
    status,
    adapterId,
    adapterVersion,
    controlSet,
    controlsPresent: input.probe.controlsPresent,
    controlsMissing: input.probe.controlsMissing,
    ...(isRevision(input.evidenceRevision) && status === 'ready'
      ? { evidenceRevision: input.evidenceRevision }
      : {}),
    recordRevision: isRevision(input.recordRevision) ? input.recordRevision : 0,
    lastCheckedAt: isTimestamp(input.lastCheckedAt)
      ? (input.lastCheckedAt as string)
      : '1970-01-01T00:00:00.000Z',
    reason,
    redaction: 'internal',
  };

  if (status === 'unavailable' && requiresUnavailableOnAbsence(input.capabilityId)) {
    return {
      record,
      unavailableError: makeUnavailableError({
        capabilityId: input.capabilityId,
        platform: input.platform,
        architecture: input.architecture,
        missingControls: input.probe.controlsMissing,
        correlationId: input.correlationId,
      }),
    };
  }

  return { record };
}

function deriveReason(
  status: CapabilityStatus,
  input: CapabilityCellInput,
): string {
  switch (status) {
    case 'blocked':
      return 'current-truth prerequisite unsatisfied; capability not advertised';
    case 'unavailable':
      return input.adapterId == null
        ? 'no capability adapter declared for this cell'
        : `required controls missing: ${input.probe.controlsMissing.join(', ') || 'unspecified'}`;
    case 'degraded':
      return input.probe.configPresent === true
        ? 'configuration present but not verified; config presence is not readiness'
        : 'adapter and controls present; awaiting fixture evidence';
    case 'ready':
      return 'adapter, controls, and fixture evidence current';
    default:
      return 'unknown';
  }
}

// ─── Registry ───────────────────────────────────────────────────────────────

/**
 * The Capability Registry: a descriptive, revisioned store of capability cells
 * for the current (or a specified) platform. It is *observer-only* truth
 * (D-05); it gates no consumer. All reads return frozen snapshots so callers
 * cannot mutate registry state.
 */
export class CapabilityRegistry {
  private readonly cells = new Map<string, CapabilityRecord>();
  private readonly errors = new Map<string, ErrorEnvelope>();

  /**
   * Register (or replace) a cell by evaluating a non-risky probe. Returns the
   * evaluation. Replacing a cell requires the new `recordRevision` to be >= the
   * existing one; a lower revision is rejected without mutation (monotonic
   * revisions, D-06.1) and the prior record is preserved.
   */
  register(input: CapabilityCellInput): CapabilityEvaluation {
    const evaluation = evaluateCapability(input);
    const key = evaluation.record.capabilityCellId;
    const existing = this.cells.get(key);
    if (existing && evaluation.record.recordRevision < existing.recordRevision) {
      // Reject stale descriptive update; preserve prior truth (no mutation).
      return {
        record: existing,
        ...(this.errors.has(key)
          ? { unavailableError: this.errors.get(key) as ErrorEnvelope }
          : {}),
      };
    }
    this.cells.set(key, evaluation.record);
    if (evaluation.unavailableError) {
      this.errors.set(key, evaluation.unavailableError);
    } else {
      this.errors.delete(key);
    }
    return evaluation;
  }

  /** Get a single cell record by capability/platform/architecture. */
  get(
    capabilityId: CapabilityId,
    platform: Platform,
    architecture: Architecture,
  ): CapabilityRecord | undefined {
    return this.cells.get(capabilityCellId(capabilityId, platform, architecture));
  }

  /**
   * Get the typed `UNAVAILABLE` error for a mandatory capability cell that was
   * evaluated absent, or `undefined` if the cell is present or non-mandatory.
   */
  getUnavailableError(
    capabilityId: CapabilityId,
    platform: Platform,
    architecture: Architecture,
  ): ErrorEnvelope | undefined {
    return this.errors.get(
      capabilityCellId(capabilityId, platform, architecture),
    );
  }

  /**
   * Query readiness of a capability cell without any side effect. Returns the
   * status when the cell is present/advertisable, or the typed `UNAVAILABLE`
   * error for a mandatory absent capability, or a synthesized `UNAVAILABLE`
   * for an unknown cell. This is the "unavailable produces no effect" contract
   * (V-INV-001/unavailable-no-effect): it returns a typed error and changes
   * nothing.
   */
  query(
    capabilityId: CapabilityId,
    platform: Platform,
    architecture: Architecture,
    correlationId?: string,
  ):
    | { readonly ok: true; readonly record: CapabilityRecord }
    | { readonly ok: false; readonly error: ErrorEnvelope } {
    const record = this.get(capabilityId, platform, architecture);
    if (record && isAdvertisableStatus(record.status)) {
      return { ok: true, record };
    }
    const existingError = this.getUnavailableError(
      capabilityId,
      platform,
      architecture,
    );
    if (existingError) {
      return { ok: false, error: existingError };
    }
    // Unknown or blocked/unavailable non-mandatory cell: synthesize a typed
    // UNAVAILABLE. Absence never infers permission (NN-INV-001).
    return {
      ok: false,
      error: makeUnavailableError({
        capabilityId,
        platform,
        architecture,
        missingControls: record?.controlsMissing ?? [],
        correlationId,
        operation: 'capability.query',
      }),
    };
  }

  /** Snapshot every registered record, sorted by cell id for determinism. */
  snapshot(): readonly CapabilityRecord[] {
    return Object.freeze(
      [...this.cells.values()].sort((a, b) =>
        a.capabilityCellId < b.capabilityCellId
          ? -1
          : a.capabilityCellId > b.capabilityCellId
            ? 1
            : 0,
      ),
    );
  }

  /** Number of registered cells. */
  get size(): number {
    return this.cells.size;
  }
}
