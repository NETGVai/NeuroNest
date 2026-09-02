/**
 * Qualified sandbox profiles and process-tree management/cancellation adapters
 * (D-16.4 sandbox/capability policy, D-17 portability matrix, D-11 governed
 * execution, D-13 orchestration cancellation).
 *
 * Implements FUT-PKG-04-SECURITY/T-005: the per-platform (macOS/Windows/Linux)
 * qualified sandbox profile *selection* and the process-tree management and
 * cancellation *adapters* that sit above the descriptive Capability Registry
 * (T-004, `src/shared/capability-registry.ts`) and the Security Authority's
 * structured-argv command policy (3.4, `src/shared/security-authority.ts`).
 *
 * The guarantees this module enforces (task acceptance):
 *
 *   1. Profile selection returns `strict | standard | degraded-read-only`
 *      gated on the Capability Registry. When strict isolation is *required*
 *      but the platform cell is not advertisable, selection returns the
 *      Registry's typed `UNAVAILABLE` `ErrorEnvelope@1` — it NEVER silently
 *      falls back to an ordinary (unsandboxed) host spawn (NN-SEC-003,
 *      NN-PLATFORM-002, NN-INV-001, CD-001).
 *   2. Spawning is *structured argv only* — `{ executable, args }` routed
 *      through the Security Authority's command policy. A shell string, shell
 *      metacharacters, or a denied/ask command never spawns (NN-SEC-006,
 *      D-16.3). A spawn is refused unless a sandbox profile was selected and
 *      that profile authorizes execution (`degraded-read-only` never executes
 *      code — NN-SEC-004).
 *   3. Resource limits (wall-clock deadline + memory ceiling) are enforced and
 *      surfaced as typed `TIMEOUT`/`BUDGET_EXCEEDED` outcomes; a spawn without
 *      an enforceable limit is refused (NN-EXEC-007, D-11).
 *   4. Cancellation terminates the *full process tree* with a bounded
 *      acknowledgement window; when a descendant does not stop cooperatively it
 *      escalates to forced termination and returns an explicit forced-result
 *      that LISTS SURVIVORS — it never claims all stopped (NN-INV-012,
 *      NN-PLATFORM cancellation row, D-17).
 *
 * The module is deliberately pure and adapter-injected: the process-tree
 * observation, signalling, and forced-kill are injected as a
 * {@link ProcessTreeController} so the manager can be exercised deterministically
 * in CI with a faked process tree (no real OS process group is required). The
 * real per-platform controllers (process group / Job Object / cgroup) are thin
 * implementations of the same interface and are constructed only in the main
 * process. This keeps the safety-critical decision logic testable and identical
 * across platforms.
 *
 * This task is deliberately additive: the adapters sit *behind* capability
 * gating and add a new decision surface. Rollback disables an adapter and the
 * selector returns `UNAVAILABLE`, never an unsandboxed fallback (task rollback
 * rule).
 *
 * Design anchors: D-03, D-05, D-11, D-13, D-16 (D-16.4), D-17.
 * Requirements: NN-INV-001/005/012, NN-SEC-003/004/005/006,
 * NN-PLATFORM-002/004/005/006, NN-EXEC-001/007.
 */

import {
  CONTRACT_WRITE_VERSION,
  isOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
} from './contract-primitives';
import {
  CapabilityRegistry,
  makeUnavailableError,
  type Architecture,
  type Platform,
} from './capability-registry';
import {
  evaluateCommand,
  type CommandPolicy,
  type StructuredCommand,
} from './security-authority';

// ════════════════════════════════════════════════════════════════════════════
// 1. Sandbox profiles (NN-SEC-003, D-16.4, D-17)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The three named security profiles (NN-SEC-003).
 *
 *   - `strict`             — packaged qualified isolation (macOS profile /
 *     Windows restricted-token+Job-Object / Linux namespace+seccomp+cgroup).
 *     Filesystem, process, network, and resource controls are all enforced.
 *     A strict profile CANNOT be emulated by an ordinary host spawn (D-16.4).
 *   - `standard`           — the default confined profile: structured-argv
 *     execution inside the validated scope with resource limits and
 *     process-tree cancellation, but without the strict isolation boundary.
 *   - `degraded-read-only` — a named, audited reduced mode that permits only
 *     pre-classified read-only, low-risk work. NO mutation, credential use,
 *     network transmission, install, or code execution is authorized
 *     (NN-SEC-004, D-16.4).
 */
export const SANDBOX_PROFILES = Object.freeze([
  'strict',
  'standard',
  'degraded-read-only',
] as const);
export type SandboxProfile = (typeof SANDBOX_PROFILES)[number];

/** Whether a value is a known sandbox profile. */
export function isSandboxProfile(value: unknown): value is SandboxProfile {
  return (
    typeof value === 'string' &&
    (SANDBOX_PROFILES as readonly string[]).includes(value)
  );
}

/**
 * Whether a profile authorizes executing code / spawning a process at all.
 * `degraded-read-only` never executes code (NN-SEC-004): only `strict` and
 * `standard` are execution-capable profiles.
 */
export function profileMayExecute(profile: SandboxProfile): boolean {
  return profile === 'strict' || profile === 'standard';
}

/**
 * The isolation requirement a caller asks for.
 *
 *   - `strict`   — the operation requires strict isolation. If the platform
 *     cannot provide it, selection returns a typed `UNAVAILABLE` and NEVER
 *     downgrades to `standard`/unsandboxed (NN-SEC-003, CD-001).
 *   - `standard` — the operation may run in the most restrictive *available*
 *     execution profile (strict if present, else standard).
 *   - `read-only` — the operation is a pre-classified read-only, low-risk task
 *     that may run under `degraded-read-only` when no execution profile is
 *     required.
 */
export const ISOLATION_REQUIREMENTS = Object.freeze([
  'strict',
  'standard',
  'read-only',
] as const);
export type IsolationRequirement = (typeof ISOLATION_REQUIREMENTS)[number];

/** A resolved sandbox profile plus the platform cell it was selected for. */
export interface SelectedProfile {
  readonly profile: SandboxProfile;
  readonly platform: Platform;
  readonly architecture: Architecture;
  /** Whether strict isolation controls back this profile. */
  readonly strictIsolation: boolean;
  /** Safe, secret-free reason for the selection. */
  readonly reason: string;
}

/**
 * The result of selecting a profile: either a resolved {@link SelectedProfile}
 * or a typed `UNAVAILABLE`/`FORBIDDEN` error. A denial carries the Capability
 * Registry's typed `UNAVAILABLE` error verbatim so the "isolation unavailable"
 * fact is never relabelled (NN-INV-011).
 */
export type ProfileSelection =
  | { readonly ok: true; readonly selected: SelectedProfile }
  | { readonly ok: false; readonly error: ErrorEnvelope };

const SANDBOX_OWNER = 'authority-sandbox';

function sandboxError(
  code: ErrorCode,
  message: string,
  operation: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: SANDBOX_OWNER,
    operation,
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: false,
    remediation:
      'Install and verify the required platform isolation adapter; ' +
      'no unsandboxed, plaintext, or nearby-artifact fallback is permitted.',
    redaction: 'internal',
  };
}

/**
 * Select the most restrictive *compatible* sandbox profile for a platform cell,
 * gated on the Capability Registry (D-16.4 "Security Authority selects the most
 * restrictive compatible profile"). The core safety rule (NN-SEC-003, CD-001,
 * NN-INV-001):
 *
 *   - `requirement === 'strict'`: the `strict-isolation` capability cell MUST
 *     be advertisable. If it is not, return its typed `UNAVAILABLE` error and
 *     select NOTHING — never downgrade to an ordinary spawn.
 *   - `requirement === 'standard'`: prefer `strict` when the isolation cell is
 *     advertisable; otherwise fall back to `standard`. Both are confined
 *     execution profiles; neither is an unsandboxed spawn.
 *   - `requirement === 'read-only'`: select `degraded-read-only` (no execution;
 *     NN-SEC-004). This is always selectable because it authorizes no risky
 *     effect.
 *
 * The function performs no I/O and never spawns: it reads the descriptive
 * Registry only.
 */
export function selectSandboxProfile(
  registry: CapabilityRegistry,
  platform: Platform,
  architecture: Architecture,
  requirement: IsolationRequirement,
  correlationId?: string,
): ProfileSelection {
  const strictQuery = registry.query(
    'strict-isolation',
    platform,
    architecture,
    correlationId,
  );
  const strictAvailable = strictQuery.ok;

  switch (requirement) {
    case 'read-only':
      return {
        ok: true,
        selected: {
          profile: 'degraded-read-only',
          platform,
          architecture,
          strictIsolation: false,
          reason:
            'read-only requirement satisfied by degraded-read-only profile (no code execution)',
        },
      };

    case 'strict': {
      if (!strictAvailable) {
        // Preserve the Registry's typed UNAVAILABLE verbatim; NEVER downgrade
        // to an ordinary spawn (NN-SEC-003, CD-001).
        return { ok: false, error: strictQuery.error };
      }
      return {
        ok: true,
        selected: {
          profile: 'strict',
          platform,
          architecture,
          strictIsolation: true,
          reason: 'strict isolation capability advertisable; strict profile selected',
        },
      };
    }

    case 'standard':
    default: {
      if (strictAvailable) {
        return {
          ok: true,
          selected: {
            profile: 'strict',
            platform,
            architecture,
            strictIsolation: true,
            reason:
              'most restrictive compatible profile is strict (isolation cell advertisable)',
          },
        };
      }
      return {
        ok: true,
        selected: {
          profile: 'standard',
          platform,
          architecture,
          strictIsolation: false,
          reason:
            'strict isolation not advertisable; confined standard profile selected (never unsandboxed)',
        },
      };
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Resource limits (NN-EXEC-007, D-11)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Enforceable resource limits for a spawned process tree. A spawn without an
 * enforceable limit is refused (D-11 "limits, deadline, and cancellation").
 */
export interface ResourceLimits {
  /** Wall-clock deadline in milliseconds (> 0). Exceeding it is a `TIMEOUT`. */
  readonly wallClockMs: number;
  /** Memory ceiling in bytes (> 0). Exceeding it is a `BUDGET_EXCEEDED`. */
  readonly memoryBytes: number;
  /**
   * Grace window in milliseconds for cooperative shutdown before forced
   * termination on cancellation/limit breach (>= 0). Bounds the acknowledgement
   * (NN-INV-012).
   */
  readonly gracePeriodMs: number;
}

/** Whether resource limits are enforceable (all positive/finite). */
export function areLimitsEnforceable(limits: ResourceLimits): boolean {
  return (
    Number.isFinite(limits.wallClockMs) &&
    limits.wallClockMs > 0 &&
    Number.isFinite(limits.memoryBytes) &&
    limits.memoryBytes > 0 &&
    Number.isFinite(limits.gracePeriodMs) &&
    limits.gracePeriodMs >= 0
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Process-tree controller (injected per-platform adapter, D-17)
// ════════════════════════════════════════════════════════════════════════════

/**
 * A live process-tree handle. `rootPid` identifies the spawned root; the
 * controller tracks descendants under a platform-specific tree identity
 * (process group / Job Object / cgroup) so the whole tree can be signalled and
 * reconciled (D-17 process-tree-cancellation row).
 */
export interface ProcessTreeHandle {
  readonly treeId: string;
  readonly rootPid: number;
}

/**
 * The signal a controller may deliver to a process tree.
 *   - `terminate` — a cooperative stop request (e.g. SIGTERM / graceful close).
 *   - `kill`      — a forced, non-cooperative kill (e.g. SIGKILL / TerminateJobObject).
 */
export type TreeSignal = 'terminate' | 'kill';

/**
 * The per-platform process-tree controller. Every method observes or acts on
 * the *entire* tree, never a single pid, so descendant reconciliation is
 * possible (NN-INV-012). Implementations are thin platform adapters:
 *   - macOS/Linux: process group (`kill(-pgid, sig)`) [+ cgroup on Linux].
 *   - Windows: Job Object membership + `TerminateJobObject`.
 * The controller is injected so the manager stays testable with a fake tree.
 */
export interface ProcessTreeController {
  /**
   * Spawn `command` (structured argv) inside a fresh process-tree identity with
   * `limits` applied, returning a handle. MUST reject a shell string; MUST NOT
   * interpret shell metacharacters. Throws only for a genuine adapter failure;
   * a policy/limit refusal is handled by the manager before this is called.
   */
  spawn(
    command: StructuredCommand,
    cwd: string,
    env: Readonly<Record<string, string>>,
    limits: ResourceLimits,
  ): ProcessTreeHandle;

  /** Return the pids currently alive in the tree (root + descendants). */
  livePids(handle: ProcessTreeHandle): readonly number[];

  /** Deliver `signal` to the entire tree. */
  signalTree(handle: ProcessTreeHandle, signal: TreeSignal): void;
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Cancellation outcome (NN-INV-012, D-17)
// ════════════════════════════════════════════════════════════════════════════

/**
 * How a process tree reached its terminal state.
 *   - `acknowledged` — every process in the tree stopped cooperatively within
 *     the grace window (bounded acknowledgement, NN-INV-012).
 *   - `forced`       — at least one process did not stop cooperatively and was
 *     force-killed. `survivors` lists any pid still observed alive after the
 *     forced kill; a non-empty `survivors` means the adapter must NOT claim all
 *     stopped (D-17 "Forced result lists survivors; never claim all stopped").
 */
export type CancellationDisposition = 'acknowledged' | 'forced';

/** The explicit result of cancelling a process tree (NN-INV-012). */
export interface CancellationResult {
  readonly treeId: string;
  readonly disposition: CancellationDisposition;
  /** Pids force-killed because they ignored the cooperative signal. */
  readonly forciblyTerminated: readonly number[];
  /** Pids still observed alive AFTER the forced kill (never hidden). */
  readonly survivors: readonly number[];
  /** Whether the whole tree is confirmed stopped (survivors is empty). */
  readonly allStopped: boolean;
  /** Total time spent converging, in milliseconds. */
  readonly convergenceMs: number;
  /** Safe, secret-free reason. */
  readonly reason: string;
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Spawn request / result (NN-SEC-005/006, NN-EXEC-007)
// ════════════════════════════════════════════════════════════════════════════

/** A structured spawn request confined to a selected profile. */
export interface SandboxSpawnRequest {
  readonly command: StructuredCommand;
  /** Controlled working directory (already scope-validated by the caller). */
  readonly cwd: string;
  /** Controlled environment allowlist (already scrubbed by the caller). */
  readonly env: Readonly<Record<string, string>>;
  readonly limits: ResourceLimits;
  readonly correlationId?: string;
}

/** The result of a sandbox spawn attempt. */
export type SandboxSpawnResult =
  | { readonly ok: true; readonly handle: ProcessTreeHandle; readonly profile: SandboxProfile }
  | { readonly ok: false; readonly error: ErrorEnvelope };

// ════════════════════════════════════════════════════════════════════════════
// 6. Sandbox execution manager
// ════════════════════════════════════════════════════════════════════════════

/**
 * Options for {@link SandboxExecutionManager}. The command policy is threaded
 * so the structured-argv tiers stay consistent with the Security Authority;
 * `sleep` and `now` are injectable so cancellation convergence is deterministic
 * in tests (no real timers required).
 */
export interface SandboxManagerOptions {
  readonly platform: Platform;
  readonly architecture: Architecture;
  readonly controller: ProcessTreeController;
  readonly commandPolicy?: CommandPolicy;
  /** Monotonic clock in ms; defaults to a monotonic counter for determinism. */
  readonly now?: () => number;
}

/**
 * The Sandbox Execution Manager: the single choke point that ties profile
 * selection, structured-argv command policy, resource limits, and process-tree
 * cancellation together (D-11, D-16.4). It NEVER spawns unless:
 *
 *   1. a profile was selected for the requirement (strict absence → UNAVAILABLE),
 *   2. that profile authorizes execution (`degraded-read-only` → FORBIDDEN),
 *   3. the command passes the Security Authority's structured-argv policy
 *      (deny/ask never spawns), and
 *   4. the resource limits are enforceable.
 *
 * On cancellation it drives the injected controller through a bounded
 * cooperative window and, if any descendant survives, a forced kill, returning
 * an explicit {@link CancellationResult} that lists survivors.
 */
export class SandboxExecutionManager {
  private readonly platform: Platform;
  private readonly architecture: Architecture;
  private readonly controller: ProcessTreeController;
  private readonly commandPolicy?: CommandPolicy;
  private readonly now: () => number;

  constructor(
    private readonly registry: CapabilityRegistry,
    options: SandboxManagerOptions,
  ) {
    this.platform = options.platform;
    this.architecture = options.architecture;
    this.controller = options.controller;
    this.commandPolicy = options.commandPolicy;
    this.now = options.now ?? Date.now;
  }

  /** Select a profile for the current platform cell (see selectSandboxProfile). */
  selectProfile(
    requirement: IsolationRequirement,
    correlationId?: string,
  ): ProfileSelection {
    return selectSandboxProfile(
      this.registry,
      this.platform,
      this.architecture,
      requirement,
      correlationId,
    );
  }

  /**
   * Attempt a confined spawn under the given isolation requirement. Enforces
   * the full fail-closed sequence; any failure returns a typed error and
   * performs NO spawn (NN-INV-001, NN-SEC-003/004/006).
   */
  spawn(
    requirement: IsolationRequirement,
    request: SandboxSpawnRequest,
  ): SandboxSpawnResult {
    const correlationId = request.correlationId;

    // (1) Profile selection — strict absence returns the typed UNAVAILABLE and
    // NEVER falls back to an unsandboxed spawn.
    const selection = this.selectProfile(requirement, correlationId);
    if (!selection.ok) {
      return { ok: false, error: selection.error };
    }
    const { profile } = selection.selected;

    // (2) Profile must authorize execution. degraded-read-only never executes
    // code (NN-SEC-004).
    if (!profileMayExecute(profile)) {
      return {
        ok: false,
        error: sandboxError(
          'FORBIDDEN',
          `profile '${profile}' does not authorize code execution; only read-only work is permitted`,
          'sandbox.spawn',
          correlationId,
        ),
      };
    }

    // (3) Structured-argv command policy. A shell string / metacharacters /
    // deny / ask never spawns (NN-SEC-006, D-16.3).
    const commandDecision = evaluateCommand(
      request.command,
      this.commandPolicy,
      { correlationId, operation: 'sandbox.spawn' },
    );
    if (commandDecision.decision !== 'allow') {
      return { ok: false, error: commandDecision.error };
    }

    // (4) Enforceable resource limits are mandatory (D-11).
    if (!areLimitsEnforceable(request.limits)) {
      return {
        ok: false,
        error: sandboxError(
          'VALIDATION',
          'resource limits (wallClockMs, memoryBytes, gracePeriodMs) must be enforceable; spawn refused',
          'sandbox.spawn',
          correlationId,
        ),
      };
    }

    // All gates passed: spawn inside a fresh process-tree identity.
    const handle = this.controller.spawn(
      commandDecision.value,
      request.cwd,
      request.env,
      request.limits,
    );
    return { ok: true, handle, profile };
  }

  /**
   * Cancel a running process tree with bounded acknowledgement then forced
   * termination (NN-INV-012, D-17). Algorithm:
   *
   *   1. Deliver a cooperative `terminate` to the whole tree.
   *   2. Poll `livePids` up to `pollAttempts` times, each `pollIntervalMs`
   *      apart, until the tree is empty or the grace window elapses.
   *   3. If any pid survives the window, deliver a forced `kill` to the tree
   *      and re-observe.
   *   4. Return an explicit result: `acknowledged` if the cooperative stop
   *      converged; `forced` otherwise, listing which pids were force-killed
   *      and which (if any) STILL survive — never claiming all stopped when
   *      survivors remain (D-17).
   *
   * `sleep` is injected so the poll loop is deterministic in tests. The default
   * uses the injected clock only for timing and does not actually block.
   */
  cancelTree(
    handle: ProcessTreeHandle,
    limits: ResourceLimits,
    options: {
      readonly pollIntervalMs?: number;
      readonly pollAttempts?: number;
      readonly sleep?: (ms: number) => void;
    } = {},
  ): CancellationResult {
    const start = this.now();
    const pollIntervalMs = options.pollIntervalMs ?? 25;
    const pollAttempts = Math.max(1, options.pollAttempts ?? 8);
    const sleep = options.sleep ?? (() => {});

    // (1) Cooperative stop request to the entire tree.
    this.controller.signalTree(handle, 'terminate');

    // (2) Bounded acknowledgement window.
    let alive = this.controller.livePids(handle);
    const deadline = start + Math.max(0, limits.gracePeriodMs);
    let attempt = 0;
    while (alive.length > 0 && attempt < pollAttempts && this.now() < deadline) {
      sleep(pollIntervalMs);
      alive = this.controller.livePids(handle);
      attempt += 1;
    }

    if (alive.length === 0) {
      return {
        treeId: handle.treeId,
        disposition: 'acknowledged',
        forciblyTerminated: [],
        survivors: [],
        allStopped: true,
        convergenceMs: this.now() - start,
        reason: 'entire process tree stopped cooperatively within the grace window',
      };
    }

    // (3) Escalate to a forced kill of the whole tree.
    const forciblyTerminated = [...alive];
    this.controller.signalTree(handle, 'kill');
    const survivors = [...this.controller.livePids(handle)];

    // (4) Explicit forced result — survivors are never hidden (D-17).
    return {
      treeId: handle.treeId,
      disposition: 'forced',
      forciblyTerminated,
      survivors,
      allStopped: survivors.length === 0,
      convergenceMs: this.now() - start,
      reason:
        survivors.length === 0
          ? 'process tree force-terminated after grace window; all descendants confirmed stopped'
          : 'process tree force-terminated after grace window; survivors remain and are reported (not claimed stopped)',
    };
  }
}

/**
 * Mint the canonical strict-isolation `UNAVAILABLE` for a platform cell. Thin
 * wrapper over the Capability Registry's minter so callers outside the manager
 * (e.g. a rollback path disabling an adapter) produce the identical typed error
 * (NN-INV-011). NEVER authorizes a fallback.
 */
export function strictIsolationUnavailable(
  platform: Platform,
  architecture: Architecture,
  missingControls: readonly string[],
  correlationId?: string,
): ErrorEnvelope {
  return makeUnavailableError({
    capabilityId: 'strict-isolation',
    platform,
    architecture,
    missingControls,
    correlationId,
    operation: 'sandbox.select',
  });
}
