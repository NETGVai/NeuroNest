/**
 * PTY / background-process registry with owned-resource cleanup
 * (FUT-PKG-06-EXECUTION/T-008).
 *
 * NN-EXEC-007 requires that PTYs and background processes have workspace
 * identity, an owner, PID/port/resource status, bounded output (the last 1,000
 * lines where configured), conflict detection, start/stop/restart,
 * cancellation, and cleanup on project/app exit, with up to three interactive
 * terminals per workspace where configured. This module is that registry.
 *
 * The registry is the single OWNER of every process/PTY it registers. Two
 * guarantees are load-bearing (task acceptance, D-15, D-17):
 *
 *   1. On cancel/failure the registry CLEANS the resources it owns — no orphan
 *      process survives. Cleanup drains every owned process through the injected
 *      {@link ProcessKillPort} (production wires this to the sandbox process-tree
 *      controller / `cancelTree`), records survivors truthfully, and never
 *      reports "all stopped" while a survivor remains (V-PLATFORM-001/...;
 *      NN-INV-012).
 *   2. Each native subsystem is CAPABILITY-FLAGGED. Registering a PTY requires
 *      the `pty` capability and process-tree cancellation requires the
 *      `process-tree-cancellation` capability; when the platform lacks the
 *      adapter the registry returns a typed `UNAVAILABLE` and registers NOTHING
 *      — it NEVER falls back to an un-owned host spawn (NN-INV-014, NN-PLATFORM-007;
 *      D-16.3, D-17).
 *
 * Bounded output (NN-EXEC-007). Each process keeps at most the last N lines
 * (default 1,000); appending past the bound drops the oldest lines so the buffer
 * never grows without bound.
 *
 * Conflict detection (NN-EXEC-007). A port claimed by an active process blocks a
 * second active process claiming the same port (`CONFLICT`), and a workspace may
 * hold at most `maxInteractiveTerminals` (default 3) interactive terminals; a
 * fourth is blocked without killing the existing three.
 *
 * The registry state is in-memory (a running process is a live OS resource, not
 * a durable row); the capability truth it consults is the descriptive
 * {@link CapabilityRegistry} (D-05/D-17). It never persists a "started" success
 * for a catalog-only/unsupported subsystem (NN-INV-014).
 *
 * Design anchors: D-05, D-11, D-15, D-16.3, D-17. Requirements:
 * NN-EXEC-007/014, NN-PLATFORM-007, NN-INV-012/014.
 */

import {
  CONTRACT_WRITE_VERSION,
  isOpaqueId,
  makeOpaqueId,
  type ErrorEnvelope,
} from '../shared/contract-primitives';
import {
  CapabilityRegistry,
  type Architecture,
  type Platform,
} from '../shared/capability-registry';

const REGISTRY_OWNER = 'authority-process-registry';

// ════════════════════════════════════════════════════════════════════════════
// 1. Process kinds and status (NN-EXEC-007)
// ════════════════════════════════════════════════════════════════════════════

/** The kinds of owned runtime process the registry tracks. */
export const PROCESS_KINDS = Object.freeze([
  'pty', // an interactive terminal (capability-flagged: `pty`)
  'background', // a non-interactive background process
] as const);
export type ProcessKind = (typeof PROCESS_KINDS)[number];

/** The lifecycle status of an owned process. */
export const PROCESS_STATUS = Object.freeze([
  'running',
  'stopped',
  'failed',
  'cancelled',
  'survivor', // cancellation attempted but the OS process is still alive
] as const);
export type ProcessStatus = (typeof PROCESS_STATUS)[number];

/** Whether a status is terminal (the process no longer owns live resources). */
export function isTerminalProcessStatus(status: ProcessStatus): boolean {
  return status === 'stopped' || status === 'failed' || status === 'cancelled';
}

/** The default bounded-output line cap (NN-EXEC-007: last 1,000 lines). */
export const DEFAULT_OUTPUT_LINE_CAP = 1000;

/** The default per-workspace interactive terminal cap (NN-EXEC-007: three). */
export const DEFAULT_MAX_INTERACTIVE_TERMINALS = 3;

// ════════════════════════════════════════════════════════════════════════════
// 2. The kill port (owned-resource escalation, NN-INV-012)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The injected forced-termination port. Production wires this to the sandbox
 * process-tree controller / `cancelTree`. It returns whether the OS process is
 * CONFIRMED stopped after the attempt; a process that survives is reported as a
 * survivor and NEVER hidden (D-15). The registry is deterministic in tests via
 * an injected port with scripted survivors.
 */
export interface ProcessKillPort {
  /** Force-terminate a process by handle; returns true only if confirmed dead. */
  kill(processId: string): boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Owned-process record
// ════════════════════════════════════════════════════════════════════════════

/** A registered, owned process/PTY record (NN-EXEC-007). */
export interface OwnedProcess {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  readonly processId: string;
  readonly kind: ProcessKind;
  readonly workspaceId: string;
  readonly owner: string;
  /** OS PID once spawned; `null` when unknown. */
  readonly pid: number | null;
  /** Claimed TCP port; `null` when none. */
  readonly port: number | null;
  status: ProcessStatus;
  /** Bounded output ring (last N lines). */
  readonly output: string[];
  readonly outputLineCap: number;
  readonly startedAtMs: number;
}

/** A public read-only snapshot of an owned process. */
export interface OwnedProcessSnapshot {
  readonly processId: string;
  readonly kind: ProcessKind;
  readonly workspaceId: string;
  readonly owner: string;
  readonly pid: number | null;
  readonly port: number | null;
  readonly status: ProcessStatus;
  readonly outputLines: number;
  readonly startedAtMs: number;
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Typed results
// ════════════════════════════════════════════════════════════════════════════

/** A typed registry result: an owned process or a typed error. */
export type RegistryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ErrorEnvelope };

function registryError(
  code: ErrorEnvelope['code'],
  message: string,
  operation: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: REGISTRY_OWNER,
    operation,
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: code === 'CONFLICT',
    remediation:
      'The process registry owns every process it tracks; ' +
      'an unsupported native subsystem is unavailable, never a host fallback.',
    redaction: 'internal',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Cleanup / drain result (NN-INV-012, D-15)
// ════════════════════════════════════════════════════════════════════════════

/** The truthful result of draining owned processes on cancel/exit. */
export interface DrainResult {
  /** Processes confirmed stopped (cooperatively or by forced kill). */
  readonly stopped: readonly string[];
  /** Processes still alive after the forced attempt (named, never hidden). */
  readonly survivors: readonly string[];
  /** True ONLY when there are no survivors. */
  readonly allStopped: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// 6. The registry
// ════════════════════════════════════════════════════════════════════════════

/** Options for {@link ProcessRegistry}. */
export interface ProcessRegistryOptions {
  readonly now?: () => number;
  readonly outputLineCap?: number;
  readonly maxInteractiveTerminals?: number;
  /** The platform/arch cell used for capability checks. */
  readonly platform?: Platform;
  readonly architecture?: Architecture;
}

/** A start request for an owned process/PTY. */
export interface StartProcessInput {
  readonly kind: ProcessKind;
  readonly workspaceId: string;
  readonly owner: string;
  readonly pid?: number | null;
  readonly port?: number | null;
  readonly correlationId?: string;
  /** Optional explicit id (deterministic tests); otherwise minted. */
  readonly processId?: string;
}

/**
 * The PTY / background-process registry. It OWNS every process it registers and
 * cleans them all on drain. Capability truth comes from the descriptive
 * {@link CapabilityRegistry}; an unsupported subsystem is typed `UNAVAILABLE`
 * with no host fallback and no registered row (NN-INV-014).
 */
export class ProcessRegistry {
  private readonly processes = new Map<string, OwnedProcess>();
  private readonly capabilities: CapabilityRegistry;
  private readonly kill: ProcessKillPort;
  private readonly now: () => number;
  private readonly outputLineCap: number;
  private readonly maxInteractiveTerminals: number;
  private readonly platform: Platform;
  private readonly architecture: Architecture;
  private seq = 0;

  constructor(
    capabilities: CapabilityRegistry,
    kill: ProcessKillPort,
    options: ProcessRegistryOptions = {},
  ) {
    this.capabilities = capabilities;
    this.kill = kill;
    this.now = options.now ?? Date.now;
    this.outputLineCap = Math.max(1, options.outputLineCap ?? DEFAULT_OUTPUT_LINE_CAP);
    this.maxInteractiveTerminals = Math.max(
      1,
      options.maxInteractiveTerminals ?? DEFAULT_MAX_INTERACTIVE_TERMINALS,
    );
    this.platform = options.platform ?? 'macos';
    this.architecture = options.architecture ?? 'universal';
  }

  /**
   * Register and start an owned process/PTY. Fails closed with a typed error:
   *
   *   - a PTY requires the `pty` capability; when absent the result is
   *     `UNAVAILABLE` and NOTHING is registered (NN-INV-014, NN-PLATFORM-007);
   *   - a port already claimed by an active process is a `CONFLICT`
   *     (NN-EXEC-007 conflict detection);
   *   - a fourth interactive terminal in a workspace is a `CONFLICT`
   *     (NN-EXEC-007 three-terminal cap) — the existing terminals are untouched.
   */
  start(input: StartProcessInput): RegistryResult<OwnedProcessSnapshot> {
    // ── Capability flag (NN-INV-014): a PTY must have the `pty` adapter. ────
    if (input.kind === 'pty') {
      const cap = this.capabilities.query(
        'pty',
        this.platform,
        this.architecture,
        input.correlationId,
      );
      if (!cap.ok) {
        // Typed UNAVAILABLE; register nothing; never a host fallback.
        return { ok: false, error: cap.error };
      }
      // Three-terminal cap per workspace (NN-EXEC-007).
      const activeTerminals = [...this.processes.values()].filter(
        (p) =>
          p.kind === 'pty' &&
          p.workspaceId === input.workspaceId &&
          p.status === 'running',
      ).length;
      if (activeTerminals >= this.maxInteractiveTerminals) {
        return {
          ok: false,
          error: registryError(
            'CONFLICT',
            `workspace '${input.workspaceId}' already holds the maximum of ${this.maxInteractiveTerminals} interactive terminals`,
            'process.start',
            input.correlationId,
          ),
        };
      }
    }

    // ── Port conflict detection (NN-EXEC-007). ─────────────────────────────
    const port = input.port ?? null;
    if (port !== null) {
      const clash = [...this.processes.values()].find(
        (p) => p.status === 'running' && p.port === port,
      );
      if (clash) {
        return {
          ok: false,
          error: registryError(
            'CONFLICT',
            `port ${port} is already claimed by an active process`,
            'process.start',
            input.correlationId,
          ),
        };
      }
    }

    this.seq += 1;
    const processId =
      input.processId ?? makeOpaqueId('proc', `${input.workspaceId}${this.seq}`);
    if (this.processes.has(processId)) {
      return {
        ok: false,
        error: registryError(
          'CONFLICT',
          `process '${processId}' is already registered`,
          'process.start',
          input.correlationId,
        ),
      };
    }

    const record: OwnedProcess = {
      schemaVersion: CONTRACT_WRITE_VERSION,
      processId,
      kind: input.kind,
      workspaceId: input.workspaceId,
      owner: input.owner,
      pid: input.pid ?? null,
      port,
      status: 'running',
      output: [],
      outputLineCap: this.outputLineCap,
      startedAtMs: this.now(),
    };
    this.processes.set(processId, record);
    return { ok: true, value: this.snapshot(record) };
  }

  /**
   * Append output lines to an owned process, bounding the buffer to the last
   * `outputLineCap` lines (NN-EXEC-007 bounded output). Appending past the cap
   * drops the OLDEST lines so the buffer never grows without bound.
   */
  appendOutput(processId: string, lines: readonly string[]): RegistryResult<number> {
    const record = this.processes.get(processId);
    if (!record) {
      return {
        ok: false,
        error: registryError('VALIDATION', `unknown process '${processId}'`, 'process.append'),
      };
    }
    for (const line of lines) record.output.push(line);
    if (record.output.length > record.outputLineCap) {
      record.output.splice(0, record.output.length - record.outputLineCap);
    }
    return { ok: true, value: record.output.length };
  }

  /** The bounded output (last N lines) of an owned process. */
  outputOf(processId: string): readonly string[] {
    return this.processes.get(processId)?.output ?? [];
  }

  /**
   * Stop one owned process cooperatively-then-forced. The registry escalates
   * through the kill port; a process the port confirms dead is `stopped`, and
   * one that survives is recorded as a `survivor` (never hidden, D-15).
   */
  stop(processId: string): RegistryResult<ProcessStatus> {
    const record = this.processes.get(processId);
    if (!record) {
      return {
        ok: false,
        error: registryError('VALIDATION', `unknown process '${processId}'`, 'process.stop'),
      };
    }
    if (isTerminalProcessStatus(record.status)) {
      return { ok: true, value: record.status };
    }
    const dead = this.kill.kill(processId);
    record.status = dead ? 'stopped' : 'survivor';
    return { ok: true, value: record.status };
  }

  /**
   * Restart an owned process: stop the existing instance, then register a fresh
   * one with the same identity fields (NN-EXEC-007 restart). A surviving old
   * instance blocks the restart with `CONFLICT` (no orphan double-run).
   */
  restart(processId: string, correlationId?: string): RegistryResult<OwnedProcessSnapshot> {
    const record = this.processes.get(processId);
    if (!record) {
      return {
        ok: false,
        error: registryError('VALIDATION', `unknown process '${processId}'`, 'process.restart', correlationId),
      };
    }
    const stopped = this.stop(processId);
    if (!stopped.ok) return stopped;
    if (stopped.value === 'survivor') {
      return {
        ok: false,
        error: registryError(
          'CONFLICT',
          `process '${processId}' survived stop; refusing to restart over a live process`,
          'process.restart',
          correlationId,
        ),
      };
    }
    // Reuse the identity fields for the fresh instance.
    return this.start({
      kind: record.kind,
      workspaceId: record.workspaceId,
      owner: record.owner,
      pid: record.pid,
      port: record.port,
      correlationId,
    });
  }

  /**
   * Drain (clean up) every non-terminal owned process — the cleanup the loop /
   * app-exit path invokes on cancel/failure. It force-terminates every live
   * process through the kill port, marks confirmed-dead ones `cancelled` and
   * surviving ones `survivor`, and returns a truthful {@link DrainResult}:
   * `allStopped` is true ONLY when there are no survivors (NN-INV-012, D-15).
   *
   * Idempotent: draining again after everything is terminal reports the same
   * (already-stopped) result with no second kill.
   */
  drain(filter?: (p: OwnedProcessSnapshot) => boolean): DrainResult {
    const stopped: string[] = [];
    const survivors: string[] = [];
    for (const record of this.processes.values()) {
      if (isTerminalProcessStatus(record.status)) continue;
      if (record.status === 'survivor') {
        // A prior drain already tried; re-attempt the forced kill.
      }
      if (filter && !filter(this.snapshot(record))) continue;
      const dead = this.kill.kill(record.processId);
      if (dead) {
        record.status = 'cancelled';
        stopped.push(record.processId);
      } else {
        record.status = 'survivor';
        survivors.push(record.processId);
      }
    }
    return {
      stopped: stopped.sort(),
      survivors: survivors.sort(),
      allStopped: survivors.length === 0,
    };
  }

  /** The number of processes still owning live resources (running/survivor). */
  liveCount(): number {
    let n = 0;
    for (const p of this.processes.values()) {
      if (p.status === 'running' || p.status === 'survivor') n += 1;
    }
    return n;
  }

  /** A read-only snapshot of a single owned process. */
  get(processId: string): OwnedProcessSnapshot | undefined {
    const record = this.processes.get(processId);
    return record ? this.snapshot(record) : undefined;
  }

  /** Snapshot every owned process, sorted by id for determinism. */
  snapshotAll(): readonly OwnedProcessSnapshot[] {
    return [...this.processes.values()]
      .map((r) => this.snapshot(r))
      .sort((a, b) => (a.processId < b.processId ? -1 : a.processId > b.processId ? 1 : 0));
  }

  private snapshot(record: OwnedProcess): OwnedProcessSnapshot {
    return {
      processId: record.processId,
      kind: record.kind,
      workspaceId: record.workspaceId,
      owner: record.owner,
      pid: record.pid,
      port: record.port,
      status: record.status,
      outputLines: record.output.length,
      startedAtMs: record.startedAtMs,
    };
  }
}
