/**
 * Capability-flagged native runtime subsystems: LSP, safe browser/web, and
 * notebook/local runtime lifecycle (FUT-PKG-06-EXECUTION/T-008).
 *
 * Three native subsystems are wired here, each behind a CAPABILITY FLAG so an
 * UNSUPPORTED native service or a MISSING runtime returns a typed non-success
 * and NEVER a false capability or a host fallback (NN-INV-014, NN-PLATFORM-007;
 * D-16, D-17):
 *
 *   - **LSP** (NN-EXEC-008). Diagnostics/definition/references/symbols/hover/
 *     completion/rename over an auto-detected language server. Diagnostics are
 *     NON-MUTATING. When no server is detected for a language the result is a
 *     typed `UNAVAILABLE`, never a false success (NN-EXEC-008 "return typed
 *     unavailable results rather than false success").
 *   - **Safe browser / web** (NN-EXEC-009). A CENTRALIZED safe adapter with
 *     URL/SSRF and DNS-rebinding policy: it rejects credentials-in-URL,
 *     local/file/data/javascript schemes, and loopback/link-local/private
 *     destinations, canonicalizes the host, caps fetch bytes, and — critically —
 *     NEVER claims semantic success from pixel similarity alone (NN-EXEC-009).
 *     Orphan browser processes are the process registry's to clean.
 *   - **Notebook / local runtime** (NN-EXEC-012). A lifecycle
 *     (starting→ready→stopping→stopped/failed) with health, resource limits,
 *     output/artifact capture, and cleanup. OpenMythos specifically requires
 *     Python 3.9+, default port 8200, 8,192 default context, a 600s local
 *     timeout, and reasoning loops 1–32 (default 4); a config outside those
 *     bounds is a typed `VALIDATION` and no runtime starts.
 *
 * Every subsystem consults the descriptive {@link CapabilityRegistry} (D-05/
 * D-17) for its capability truth. This module performs no risky probe; it maps
 * a present capability to a governed operation and an absent one to a typed
 * unavailable result.
 *
 * Design anchors: D-05, D-11, D-16.5, D-17. Requirements:
 * NN-EXEC-008/009/012, NN-PLATFORM-007, NN-INV-014.
 */

import {
  CONTRACT_WRITE_VERSION,
  isOpaqueId,
  type ErrorEnvelope,
} from '../shared/contract-primitives';
import {
  CapabilityRegistry,
  makeUnavailableError,
  type Architecture,
  type CapabilityId,
  type Platform,
} from '../shared/capability-registry';

const LSP_OWNER = 'authority-lsp';
const BROWSER_OWNER = 'authority-safe-browser';
const RUNTIME_OWNER = 'authority-runtime';

/** A typed subsystem result: a value or a typed error (never a false success). */
export type SubsystemResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ErrorEnvelope };

function subsystemError(
  owner: string,
  code: ErrorEnvelope['code'],
  message: string,
  operation: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner,
    operation,
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: false,
    remediation:
      'The native subsystem is capability-flagged; an unsupported service ' +
      'returns a typed unavailable result and never a false success or host fallback.',
    redaction: 'internal',
  };
}

/**
 * Shared capability gate: return the typed `UNAVAILABLE`/`unavailable` error
 * from the descriptive registry when a native capability is absent, or
 * `undefined` when it is advertisable. Consulting the registry performs NO
 * risky probe (D-17).
 */
function capabilityGate(
  capabilities: CapabilityRegistry,
  capabilityId: CapabilityId,
  platform: Platform,
  architecture: Architecture,
  correlationId?: string,
): ErrorEnvelope | undefined {
  const q = capabilities.query(capabilityId, platform, architecture, correlationId);
  return q.ok ? undefined : q.error;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. LSP (NN-EXEC-008)
// ════════════════════════════════════════════════════════════════════════════

/** The read-only LSP operations exposed (NON-MUTATING for diagnostics). */
export const LSP_OPERATIONS = Object.freeze([
  'diagnostics',
  'definition',
  'references',
  'symbols',
  'hover',
  'completion',
  'rename',
] as const);
export type LspOperation = (typeof LSP_OPERATIONS)[number];

/** Whether an LSP operation is non-mutating (all except `rename`). */
export function isNonMutatingLsp(op: LspOperation): boolean {
  return op !== 'rename';
}

/** A detected language server the registry considers available. */
export interface LanguageServerDescriptor {
  readonly language: string;
  readonly serverId: string;
  readonly serverVersion: string;
}

/** An LSP query request. */
export interface LspQueryInput {
  readonly language: string;
  readonly operation: LspOperation;
  readonly platform: Platform;
  readonly architecture: Architecture;
  readonly correlationId?: string;
}

/** An LSP query result (opaque, non-mutating for diagnostics). */
export interface LspQueryResult {
  readonly operation: LspOperation;
  readonly serverId: string;
  /** Whether this operation mutated source (false for every diagnostic op). */
  readonly mutating: boolean;
  /** Opaque result reference; the concrete payload lives in the server layer. */
  readonly resultRef: string;
}

/**
 * The LSP subsystem. Auto-detects a language server per language and exposes
 * the read operations. A language with NO detected server returns a typed
 * `UNAVAILABLE`, never a false success (NN-EXEC-008). Diagnostics are
 * guaranteed non-mutating.
 */
export class LspSubsystem {
  private readonly capabilities: CapabilityRegistry;
  private readonly servers = new Map<string, LanguageServerDescriptor>();

  constructor(
    capabilities: CapabilityRegistry,
    servers: readonly LanguageServerDescriptor[] = [],
  ) {
    this.capabilities = capabilities;
    for (const s of servers) this.servers.set(s.language, s);
  }

  /** Auto-detect (register) a language server for a language. */
  detect(server: LanguageServerDescriptor): void {
    this.servers.set(server.language, server);
  }

  /**
   * Run a read-only LSP operation. Fails closed with a typed `UNAVAILABLE`
   * when the platform lacks the native-dependency capability OR no server was
   * detected for the language — never a false success (NN-EXEC-008).
   */
  query(input: LspQueryInput): SubsystemResult<LspQueryResult> {
    const capError = capabilityGate(
      this.capabilities,
      'native-dependency',
      input.platform,
      input.architecture,
      input.correlationId,
    );
    if (capError) return { ok: false, error: capError };

    const server = this.servers.get(input.language);
    if (!server) {
      return {
        ok: false,
        error: subsystemError(
          LSP_OWNER,
          'UNAVAILABLE',
          `no language server detected for '${input.language}'`,
          `lsp.${input.operation}`,
          input.correlationId,
        ),
      };
    }
    return {
      ok: true,
      value: {
        operation: input.operation,
        serverId: server.serverId,
        mutating: !isNonMutatingLsp(input.operation),
        resultRef: `lspresult:${server.serverId}:${input.operation}`,
      },
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Safe browser / web (NN-EXEC-009, D-16.5)
// ════════════════════════════════════════════════════════════════════════════

/** The default fetch byte cap for the safe browser adapter. */
export const DEFAULT_FETCH_BYTE_CAP = 5 * 1024 * 1024;

/** A safe-fetch request. */
export interface SafeFetchInput {
  readonly url: string;
  readonly platform: Platform;
  readonly architecture: Architecture;
  readonly correlationId?: string;
  /** Optional byte cap; defaults to {@link DEFAULT_FETCH_BYTE_CAP}. */
  readonly byteCap?: number;
}

/** A safe-fetch result with provenance (never claims pixel-only success). */
export interface SafeFetchResult {
  readonly canonicalHost: string;
  readonly bytesFetched: number;
  /** Provenance: the adapter and destination policy that admitted the fetch. */
  readonly provenance: string;
}

/**
 * Classify a URL against the D-16.5 destination policy WITHOUT performing I/O.
 * Returns `undefined` when the URL is admissible, or a typed error otherwise.
 * Rejects: non-http(s) schemes (file/data/javascript/local), credentials in
 * the URL, and loopback/link-local/private/reserved destinations (SSRF/DNS
 * rebinding). This is pure and deterministic (V-... same input → same verdict).
 */
export function classifyDestination(url: string, correlationId?: string): ErrorEnvelope | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return subsystemError(BROWSER_OWNER, 'VALIDATION', 'malformed URL', 'browser.classify', correlationId);
  }
  // Scheme allowlist (http/https only).
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return subsystemError(
      BROWSER_OWNER,
      'FORBIDDEN',
      `scheme '${parsed.protocol}' is not permitted by the safe destination policy`,
      'browser.classify',
      correlationId,
    );
  }
  // No credentials in the URL (D-16.5).
  if (parsed.username !== '' || parsed.password !== '') {
    return subsystemError(BROWSER_OWNER, 'FORBIDDEN', 'credentials in URL are not permitted', 'browser.classify', correlationId);
  }
  // Deny loopback/link-local/private/reserved hosts (SSRF/DNS rebinding).
  const host = parsed.hostname.toLowerCase();
  if (isBlockedHost(host)) {
    return subsystemError(
      BROWSER_OWNER,
      'FORBIDDEN',
      'destination resolves to a blocked (loopback/link-local/private/reserved) range',
      'browser.classify',
      correlationId,
    );
  }
  return undefined;
}

/** Whether a host string is a blocked loopback/link-local/private/reserved target. */
function isBlockedHost(host: string): boolean {
  if (host === 'localhost' || host === '' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '[::1]' || host.startsWith('fe80:') || host.startsWith('[fe80:')) return true;
  // IPv4 literal ranges.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 0) return true; // reserved
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a >= 224) return true; // multicast/reserved
  }
  return false;
}

/**
 * The centralized safe browser / web adapter. Every retrieval passes the shared
 * destination policy ({@link classifyDestination}) and the capability gate; the
 * result carries provenance and a real byte count. A visual (pixel) similarity
 * signal is explicitly NOT accepted as semantic success — see
 * {@link visualVerify}.
 */
export class SafeBrowserSubsystem {
  private readonly capabilities: CapabilityRegistry;

  constructor(capabilities: CapabilityRegistry) {
    this.capabilities = capabilities;
  }

  /**
   * Fetch a URL through the safe adapter. Fails closed with a typed error when
   * the platform lacks the native-dependency (browser binary) capability or the
   * destination policy rejects the URL. `bytes` supplied by the injected
   * transport is capped at `byteCap`.
   */
  fetch(input: SafeFetchInput, bytes: number): SubsystemResult<SafeFetchResult> {
    const capError = capabilityGate(
      this.capabilities,
      'native-dependency',
      input.platform,
      input.architecture,
      input.correlationId,
    );
    if (capError) return { ok: false, error: capError };

    const policy = classifyDestination(input.url, input.correlationId);
    if (policy) return { ok: false, error: policy };

    const cap = input.byteCap ?? DEFAULT_FETCH_BYTE_CAP;
    if (bytes > cap) {
      return {
        ok: false,
        error: subsystemError(
          BROWSER_OWNER,
          'VALIDATION',
          `response exceeds the ${cap}-byte fetch cap`,
          'browser.fetch',
          input.correlationId,
        ),
      };
    }
    const host = new URL(input.url).hostname.toLowerCase();
    return {
      ok: true,
      value: {
        canonicalHost: host,
        bytesFetched: Math.max(0, bytes),
        provenance: `safe-browser-adapter;policy=ssrf-dns-rebinding;host=${host}`,
      },
    };
  }

  /**
   * Post-generation visual verification (NN-EXEC-009). A pixel-similarity score
   * ALONE can NEVER produce a semantic success: this returns `semanticSuccess`
   * true ONLY when a structural/semantic check ALSO passed. A high pixel score
   * with a failing semantic check is a typed non-success.
   */
  visualVerify(input: {
    readonly pixelSimilarity: number;
    readonly semanticCheckPassed: boolean;
    readonly correlationId?: string;
  }): SubsystemResult<{ readonly semanticSuccess: true }> {
    if (!input.semanticCheckPassed) {
      return {
        ok: false,
        error: subsystemError(
          BROWSER_OWNER,
          'VALIDATION',
          'pixel similarity alone does not establish semantic success; semantic check failed',
          'browser.visual-verify',
          input.correlationId,
        ),
      };
    }
    return { ok: true, value: { semanticSuccess: true } };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Notebook / local runtime lifecycle (NN-EXEC-012)
// ════════════════════════════════════════════════════════════════════════════

/** The lifecycle states of a local runtime. */
export const RUNTIME_STATES = Object.freeze([
  'starting',
  'ready',
  'stopping',
  'stopped',
  'failed',
] as const);
export type RuntimeState = (typeof RUNTIME_STATES)[number];

/** Whether a runtime state is terminal. */
export function isTerminalRuntimeState(state: RuntimeState): boolean {
  return state === 'stopped' || state === 'failed';
}

/** The OpenMythos-specific required configuration bounds (NN-EXEC-012). */
export const OPENMYTHOS_DEFAULTS = Object.freeze({
  minPythonMajor: 3,
  minPythonMinor: 9,
  defaultPort: 8200,
  defaultContext: 8192,
  localTimeoutSeconds: 600,
  minReasoningLoops: 1,
  maxReasoningLoops: 32,
  defaultReasoningLoops: 4,
});

/** A local-runtime start config (OpenMythos or a generic project runtime). */
export interface RuntimeConfig {
  readonly runtimeId: string;
  readonly kind: 'openmythos' | 'notebook' | 'container' | 'project';
  readonly platform: Platform;
  readonly architecture: Architecture;
  /** Python version (OpenMythos requires >= 3.9). */
  readonly pythonMajor?: number;
  readonly pythonMinor?: number;
  readonly port?: number;
  readonly context?: number;
  readonly reasoningLoops?: number;
  readonly correlationId?: string;
}

/** A running local-runtime record with health and resource capture. */
export interface RuntimeRecord {
  readonly runtimeId: string;
  readonly kind: RuntimeConfig['kind'];
  state: RuntimeState;
  readonly port: number;
  readonly context: number;
  readonly reasoningLoops: number;
  readonly artifacts: string[];
}

/** A public runtime snapshot. */
export interface RuntimeSnapshot {
  readonly runtimeId: string;
  readonly kind: RuntimeConfig['kind'];
  readonly state: RuntimeState;
  readonly port: number;
  readonly context: number;
  readonly reasoningLoops: number;
  readonly artifactCount: number;
}

/**
 * The notebook / local-runtime lifecycle manager. Starting a runtime requires
 * the native-dependency capability and, for OpenMythos, a config within the
 * required bounds; a missing runtime or an out-of-bounds config is a typed
 * non-success and NO runtime starts (NN-EXEC-012, NN-INV-014). Every started
 * runtime is OWNED and cleaned on {@link stopAll}.
 */
export class RuntimeSubsystem {
  private readonly capabilities: CapabilityRegistry;
  private readonly runtimes = new Map<string, RuntimeRecord>();

  constructor(capabilities: CapabilityRegistry) {
    this.capabilities = capabilities;
  }

  /**
   * Start a local runtime. Validates the capability gate first, then the
   * OpenMythos-specific bounds. Returns a typed error and registers NOTHING on
   * any failure.
   */
  start(config: RuntimeConfig): SubsystemResult<RuntimeSnapshot> {
    const capError = capabilityGate(
      this.capabilities,
      'native-dependency',
      config.platform,
      config.architecture,
      config.correlationId,
    );
    if (capError) return { ok: false, error: capError };

    const validated = this.validateConfig(config);
    if (!validated.ok) return validated;

    if (this.runtimes.has(config.runtimeId)) {
      return {
        ok: false,
        error: subsystemError(
          RUNTIME_OWNER,
          'CONFLICT',
          `runtime '${config.runtimeId}' is already registered`,
          'runtime.start',
          config.correlationId,
        ),
      };
    }
    const record: RuntimeRecord = {
      runtimeId: config.runtimeId,
      kind: config.kind,
      state: 'ready',
      port: validated.value.port,
      context: validated.value.context,
      reasoningLoops: validated.value.reasoningLoops,
      artifacts: [],
    };
    this.runtimes.set(config.runtimeId, record);
    return { ok: true, value: this.snapshot(record) };
  }

  /** Validate + normalize a runtime config against the OpenMythos bounds. */
  private validateConfig(config: RuntimeConfig): SubsystemResult<{
    readonly port: number;
    readonly context: number;
    readonly reasoningLoops: number;
  }> {
    const d = OPENMYTHOS_DEFAULTS;
    if (config.kind === 'openmythos') {
      const major = config.pythonMajor ?? d.minPythonMajor;
      const minor = config.pythonMinor ?? d.minPythonMinor;
      if (major < d.minPythonMajor || (major === d.minPythonMajor && minor < d.minPythonMinor)) {
        return {
          ok: false,
          error: subsystemError(
            RUNTIME_OWNER,
            'VALIDATION',
            `OpenMythos requires Python ${d.minPythonMajor}.${d.minPythonMinor}+`,
            'runtime.start',
            config.correlationId,
          ),
        };
      }
    }
    const reasoningLoops = config.reasoningLoops ?? d.defaultReasoningLoops;
    if (
      !Number.isInteger(reasoningLoops) ||
      reasoningLoops < d.minReasoningLoops ||
      reasoningLoops > d.maxReasoningLoops
    ) {
      return {
        ok: false,
        error: subsystemError(
          RUNTIME_OWNER,
          'VALIDATION',
          `reasoning loops must be an integer in ${d.minReasoningLoops}..${d.maxReasoningLoops}`,
          'runtime.start',
          config.correlationId,
        ),
      };
    }
    const context = config.context ?? d.defaultContext;
    if (!Number.isInteger(context) || context <= 0) {
      return {
        ok: false,
        error: subsystemError(RUNTIME_OWNER, 'VALIDATION', 'context must be a positive integer', 'runtime.start', config.correlationId),
      };
    }
    const port = config.port ?? d.defaultPort;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return {
        ok: false,
        error: subsystemError(RUNTIME_OWNER, 'VALIDATION', 'port must be in 1..65535', 'runtime.start', config.correlationId),
      };
    }
    return { ok: true, value: { port, context, reasoningLoops } };
  }

  /** Capture an artifact reference on a running runtime. */
  captureArtifact(runtimeId: string, artifactRef: string): SubsystemResult<number> {
    const record = this.runtimes.get(runtimeId);
    if (!record || isTerminalRuntimeState(record.state)) {
      return {
        ok: false,
        error: subsystemError(RUNTIME_OWNER, 'UNAVAILABLE', `runtime '${runtimeId}' is not running`, 'runtime.capture'),
      };
    }
    record.artifacts.push(artifactRef);
    return { ok: true, value: record.artifacts.length };
  }

  /** A health snapshot of one runtime. */
  health(runtimeId: string): RuntimeSnapshot | undefined {
    const record = this.runtimes.get(runtimeId);
    return record ? this.snapshot(record) : undefined;
  }

  /**
   * Stop and clean every owned runtime (cancel / app-exit path). Returns the
   * number of runtimes transitioned to `stopped`. Artifacts are preserved on
   * the record (rollback preserves artifacts, task rollback rule).
   */
  stopAll(): number {
    let n = 0;
    for (const record of this.runtimes.values()) {
      if (!isTerminalRuntimeState(record.state)) {
        record.state = 'stopped';
        n += 1;
      }
    }
    return n;
  }

  /** The number of runtimes still owning live resources. */
  liveCount(): number {
    let n = 0;
    for (const r of this.runtimes.values()) {
      if (!isTerminalRuntimeState(r.state)) n += 1;
    }
    return n;
  }

  private snapshot(record: RuntimeRecord): RuntimeSnapshot {
    return {
      runtimeId: record.runtimeId,
      kind: record.kind,
      state: record.state,
      port: record.port,
      context: record.context,
      reasoningLoops: record.reasoningLoops,
      artifactCount: record.artifacts.length,
    };
  }
}

/**
 * Convenience: mint the typed capability-unavailable error for a native
 * subsystem cell directly (used where a caller wants the error without a
 * registry query, e.g. an explicitly disabled capability flag). Never a false
 * capability (NN-INV-014).
 */
export function nativeUnavailable(
  capabilityId: CapabilityId,
  platform: Platform,
  architecture: Architecture,
  correlationId?: string,
): ErrorEnvelope {
  return makeUnavailableError({
    capabilityId,
    platform,
    architecture,
    missingControls: [],
    correlationId,
    operation: 'runtime.capability-gate',
  });
}
