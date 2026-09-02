/**
 * Governed MCP adapter — typed manifests, transports, OAuth, lazy lifecycle,
 * health, and bounded reconnect (FUT-PKG-08-OPTIONAL/T-002).
 *
 * NN-INTEGRATION-003 requires MCP servers to use typed manifests, stdio/SSE/
 * WebSocket transport as declared, a lazy lifecycle, OAuth through the
 * Credential Service, schema/firewall checks, health/reconnect, managed config,
 * provenance, and the SAME tool lifecycle/evidence as built-ins. NN-PLATFORM-007
 * requires MCP servers to be lazy/optional so a missing/incompatible/
 * disconnected server produces a SCOPED UNAVAILABLE state and never crashes an
 * unrelated platform function. NN-SEC-016 requires third-party MCP servers to
 * declare versioned manifests/capabilities and run under a selected sandbox with
 * limits, failing independently.
 *
 * This module is the current single in-process / optional MCP baseline
 * (`mcp-in-process-adapter`; the two-executable topology stays future per
 * `dual-mcp-boundary.ts`). It is DISABLED BY DEFAULT and enabled per
 * manifest/capability. It performs the risky effects it evaluates through
 * INJECTED PORTS only, so it is exercised deterministically without a real
 * server:
 *
 *   - {@link McpTransportPort} — opens/closes a declared transport. The adapter
 *     never opens a transport itself; a rollback that removes the port simply
 *     makes every connect scoped-UNAVAILABLE.
 *   - {@link McpSupplyChainPort} — the plugin/MCP supply-chain gate (3.8). A
 *     server whose manifest is blocked/quarantined is never connected.
 *   - {@link McpCredentialPort} — OAuth token minting through the Credential
 *     Service. A token is resolved lazily at connect and NEVER stored on the
 *     record or leaked in a result.
 *
 * Load-bearing guarantees (V-INTEGRATION-001/mcp-contract-lifecycle):
 *   1. LAZY lifecycle — a declared server is `declared` and NOT connected until
 *      {@link McpServerAdapter.ensureConnected} is called for a use. No
 *      transport opens at declaration.
 *   2. present / absent / incompatible / disconnected — a present, compatible
 *      server connects and is governed; an absent (undeclared), version-
 *      incompatible, or disconnected server yields a typed scoped-UNAVAILABLE /
 *      INCOMPATIBLE result, never a crash and never a false connected status.
 *   3. HEALTH / bounded RECONNECT — reconnect attempts are bounded; once the
 *      bound is exhausted the server stays scoped-UNAVAILABLE (no unbounded
 *      thrash), and a successful reconnect resets the budget.
 *   4. NO authority bypass — an MCP tool call is a governed tool path: the
 *      adapter exposes the tool contract but the ACTUAL call routes through the
 *      real tool pipeline (see `integration-adapters.ts`), never a private path.
 *   5. NO runtime loading of analyzed source frameworks — this adapter loads no
 *      analyzed-only framework; it only speaks a declared transport to an
 *      external MCP server.
 *
 * Everything here is deterministic given its injected ports and injected clock.
 *
 * Design anchors: D-02, D-03, D-05, D-11, D-16, D-17. Requirements:
 * NN-INTEGRATION-002/003, NN-EXEC-011, NN-SEC-016, NN-PLATFORM-007, NN-INV-014.
 */

import {
  CONTRACT_WRITE_VERSION,
  isOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
} from '../shared/contract-primitives.js';

const MCP_OWNER = 'authority-mcp-adapter';

/** The single advertised current MCP baseline capability id (never dual). */
export const MCP_BASELINE_CAPABILITY_ID = 'mcp-in-process-adapter';

// ════════════════════════════════════════════════════════════════════════════
// 1. Typed transports and manifest (NN-INTEGRATION-003, NN-SEC-016)
// ════════════════════════════════════════════════════════════════════════════

/** The declared MCP transports (NN-INTEGRATION-003). Closed set. */
export const MCP_TRANSPORTS = Object.freeze(['stdio', 'sse', 'websocket'] as const);
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/** Whether a value names a declared MCP transport. */
export function isMcpTransport(value: unknown): value is McpTransport {
  return (
    typeof value === 'string' && (MCP_TRANSPORTS as readonly string[]).includes(value)
  );
}

/** A typed contract a tool advertises: named input/output schema refs. */
export interface McpToolContract {
  readonly toolName: string;
  /** Opaque ref to the input schema owned by the Contract Registry. */
  readonly inputSchemaRef: string;
  /** Opaque ref to the output schema owned by the Contract Registry. */
  readonly outputSchemaRef: string;
  /** The side-effect class the built-in tool lifecycle governs identically. */
  readonly sideEffect: 'read' | 'write' | 'network' | 'process';
}

/**
 * A typed MCP server manifest (NN-INTEGRATION-003, NN-SEC-016). A server MUST
 * declare a versioned manifest, its transport, an OAuth requirement, the
 * protocol version it speaks, the sandbox profile it runs under, and the tools
 * it advertises. Provenance (publisher/source/integrity) is a required
 * secret-free string so evidence can cite it.
 */
export interface McpServerManifest {
  readonly serverId: string;
  /** Monotonic manifest schema version (NN-INTEGRATION-002 versioned contract). */
  readonly manifestVersion: number;
  readonly transport: McpTransport;
  /** The MCP protocol version this server speaks (semantic major). */
  readonly protocolVersion: number;
  /** Whether the server requires an OAuth token (resolved via Credential Svc). */
  readonly requiresOAuth: boolean;
  /** The sandbox profile id the server runs under (NN-SEC-016). */
  readonly sandboxProfile: string;
  /** Advertised tool contracts; governed identically to built-ins. */
  readonly tools: readonly McpToolContract[];
  /** Safe, secret-free provenance citation (publisher/source/integrity). */
  readonly provenance: string;
  /** Maximum bounded reconnect attempts before staying scoped-UNAVAILABLE. */
  readonly maxReconnectAttempts?: number;
}

/**
 * The protocol version range this baseline adapter can speak. A manifest whose
 * `protocolVersion` is outside this window is INCOMPATIBLE (no false connect).
 */
export const MCP_MIN_PROTOCOL_VERSION = 1 as const;
export const MCP_MAX_PROTOCOL_VERSION = 1 as const;

/** Whether a protocol version is within the adapter's readable window. */
export function isCompatibleProtocol(protocolVersion: number): boolean {
  return (
    Number.isInteger(protocolVersion) &&
    protocolVersion >= MCP_MIN_PROTOCOL_VERSION &&
    protocolVersion <= MCP_MAX_PROTOCOL_VERSION
  );
}

/** Default bounded reconnect budget when the manifest omits one. */
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3 as const;

// ════════════════════════════════════════════════════════════════════════════
// 2. Injected ports (all risky effects flow through these)
// ════════════════════════════════════════════════════════════════════════════

/** A live transport handle owned by the adapter (never a raw process/socket). */
export interface McpTransportHandle {
  /** Opaque owned-connection id (used for process-isolation ownership). */
  readonly connectionId: string;
  /** Whether the underlying transport is still alive (truthful probe). */
  isAlive(): boolean;
  /** Cooperatively close the transport; returns whether it is fully closed. */
  close(): boolean;
}

/** Opens/closes a declared MCP transport. The ONLY place a transport is opened. */
export interface McpTransportPort {
  /**
   * Open the declared transport for a manifest. Returns a handle on success or
   * a typed failure (e.g. the external server did not answer). MUST NOT throw;
   * a thrown/absent handle is treated as a disconnected scoped-UNAVAILABLE.
   */
  open(input: {
    readonly serverId: string;
    readonly transport: McpTransport;
    readonly oauthTokenRef?: string;
    readonly correlationId: string;
  }): { readonly ok: true; readonly handle: McpTransportHandle } | { readonly ok: false; readonly reason: string };
}

/** The plugin/MCP supply-chain gate (3.8). A blocked manifest never connects. */
export interface McpSupplyChainPort {
  /** Returns `ok` when the server is qualified to activate, else a typed error. */
  gate(input: {
    readonly serverId: string;
    readonly manifestVersion: number;
    readonly correlationId: string;
  }): { readonly ok: true } | { readonly ok: false; readonly error: ErrorEnvelope };
}

/** Mints an OAuth token ref through the Credential Service (never a raw value). */
export interface McpCredentialPort {
  /** Resolve an OAuth token REF for the server at the use boundary. */
  resolveOAuthRef(input: {
    readonly serverId: string;
    readonly correlationId: string;
  }): { readonly ok: true; readonly tokenRef: string } | { readonly ok: false; readonly error: ErrorEnvelope };
}

/** The adapter's collaborators. */
export interface McpAdapterPorts {
  readonly transport: McpTransportPort;
  readonly supplyChain: McpSupplyChainPort;
  readonly credential: McpCredentialPort;
  /** Monotonic clock (ms); injectable for deterministic tests. */
  readonly now?: () => number;
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Lifecycle states and results
// ════════════════════════════════════════════════════════════════════════════

/**
 * The MCP server lifecycle (NN-INTEGRATION-002/003).
 *   - `declared`   — manifest registered, NOT connected (lazy; no transport).
 *   - `connecting` — transiently opening a transport.
 *   - `connected`  — governed and usable.
 *   - `unavailable`— scoped-unavailable (absent/blocked/incompatible/exhausted).
 *   - `disposed`   — drained and disposed; transport owned-connection released.
 */
export const MCP_LIFECYCLE_STATES = Object.freeze([
  'declared',
  'connecting',
  'connected',
  'unavailable',
  'disposed',
] as const);
export type McpLifecycleState = (typeof MCP_LIFECYCLE_STATES)[number];

/** A typed MCP result: a value or a typed scoped error (never a false success). */
export type McpResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ErrorEnvelope };

/** A public, secret-free snapshot of a server's governed state. */
export interface McpServerSnapshot {
  readonly serverId: string;
  readonly state: McpLifecycleState;
  readonly transport: McpTransport;
  readonly protocolVersion: number;
  /** Whether a live owned transport connection exists (process isolation). */
  readonly connectionId: string | null;
  /** Reconnect attempts spent since the last successful connect. */
  readonly reconnectAttempts: number;
  readonly maxReconnectAttempts: number;
  /** Safe, secret-free reason for the current state. */
  readonly reason: string;
}

function mcpError(
  code: ErrorCode,
  message: string,
  operation: string,
  correlationId?: string,
  retryable = false,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: MCP_OWNER,
    operation,
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable,
    remediation:
      'MCP servers are lazy/optional and disabled by default; a missing, ' +
      'incompatible, or disconnected server is scoped-unavailable and never a ' +
      'crash, false connect, or authority bypass. Enable per manifest/capability.',
    redaction: 'internal',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 4. The governed MCP server adapter
// ════════════════════════════════════════════════════════════════════════════

/**
 * A single governed, lazily-connected MCP server. Disabled by default: a
 * declared server owns NO transport until {@link ensureConnected}. Every risky
 * effect (transport open, supply-chain gate, OAuth) flows through injected
 * ports so the lifecycle is deterministic. On {@link dispose} the owned
 * transport connection is released so no orphan process/socket remains.
 */
export class McpServerAdapter {
  private readonly ports: McpAdapterPorts;
  private readonly now: () => number;
  private readonly manifest: McpServerManifest;
  private readonly maxReconnect: number;

  private state: McpLifecycleState = 'declared';
  private handle: McpTransportHandle | null = null;
  private reconnectAttempts = 0;
  private reason = 'declared; not connected (lazy lifecycle)';

  constructor(manifest: McpServerManifest, ports: McpAdapterPorts) {
    this.manifest = manifest;
    this.ports = ports;
    this.now = ports.now ?? Date.now;
    this.maxReconnect = Math.max(
      0,
      manifest.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
    );
  }

  /** The server id this adapter governs. */
  get serverId(): string {
    return this.manifest.serverId;
  }

  /** The current lifecycle state (declared until first use — lazy). */
  get lifecycleState(): McpLifecycleState {
    return this.state;
  }

  /** Whether the server currently owns a live transport connection. */
  get isConnected(): boolean {
    return this.state === 'connected' && this.handle !== null && this.handle.isAlive();
  }

  /** A secret-free public snapshot for health/inspection (NN-INTEGRATION-002). */
  snapshot(): McpServerSnapshot {
    return {
      serverId: this.manifest.serverId,
      state: this.state,
      transport: this.manifest.transport,
      protocolVersion: this.manifest.protocolVersion,
      connectionId: this.handle?.connectionId ?? null,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnect,
      reason: this.reason,
    };
  }

  /** The advertised tool contracts (governed identically to built-ins). */
  toolContracts(): readonly McpToolContract[] {
    return this.manifest.tools;
  }

  /** Look up a tool contract by name, or `undefined` if not advertised. */
  toolContract(toolName: string): McpToolContract | undefined {
    return this.manifest.tools.find((t) => t.toolName === toolName);
  }

  /**
   * Ensure the server is connected, connecting LAZILY on first use. This is the
   * present / absent / incompatible / disconnected decision point:
   *
   *   - INCOMPATIBLE protocol → typed `INCOMPATIBLE`, no transport opened.
   *   - supply-chain blocked → typed error from the gate, no transport opened.
   *   - OAuth required but unresolved → typed `UNAUTHORIZED`, no transport.
   *   - transport open fails / handle dies → scoped `UNAVAILABLE` (disconnected).
   *   - reconnect budget exhausted → stays scoped `UNAVAILABLE` (no thrash).
   *
   * A disposed server is never re-connected. Idempotent when already connected.
   */
  ensureConnected(correlationId: string): McpResult<McpServerSnapshot> {
    if (this.state === 'disposed') {
      return this.fail('UNAVAILABLE', 'server is disposed and cannot reconnect', 'mcp.connect', correlationId);
    }
    if (this.isConnected) {
      return { ok: true, value: this.snapshot() };
    }
    // A dead handle from a prior connect is a disconnection: drop it first.
    if (this.handle && !this.handle.isAlive()) {
      this.releaseHandle();
    }

    // (1) Protocol compatibility — INCOMPATIBLE never opens a transport.
    if (!isCompatibleProtocol(this.manifest.protocolVersion)) {
      return this.fail(
        'INCOMPATIBLE',
        `MCP protocol version ${this.manifest.protocolVersion} is outside the readable window [${MCP_MIN_PROTOCOL_VERSION},${MCP_MAX_PROTOCOL_VERSION}]`,
        'mcp.connect',
        correlationId,
      );
    }

    // (2) Bounded reconnect budget — exhausted stays scoped-UNAVAILABLE.
    if (this.reconnectAttempts >= this.maxReconnect) {
      return this.fail(
        'UNAVAILABLE',
        `reconnect budget of ${this.maxReconnect} attempt(s) exhausted; server stays scoped-unavailable`,
        'mcp.connect',
        correlationId,
      );
    }

    // Count this attempt against the bounded budget.
    this.reconnectAttempts += 1;
    this.state = 'connecting';

    // (3) Supply-chain gate — a blocked manifest never connects.
    const gate = this.ports.supplyChain.gate({
      serverId: this.manifest.serverId,
      manifestVersion: this.manifest.manifestVersion,
      correlationId,
    });
    if (!gate.ok) {
      this.state = 'unavailable';
      this.reason = 'supply-chain gate blocked activation';
      return { ok: false, error: gate.error };
    }

    // (4) OAuth token ref resolved lazily at the use boundary (never stored).
    let oauthTokenRef: string | undefined;
    if (this.manifest.requiresOAuth) {
      const cred = this.ports.credential.resolveOAuthRef({
        serverId: this.manifest.serverId,
        correlationId,
      });
      if (!cred.ok) {
        this.state = 'unavailable';
        this.reason = 'OAuth token could not be resolved through Credential Service';
        return { ok: false, error: cred.error };
      }
      oauthTokenRef = cred.tokenRef;
    }

    // (5) Open the declared transport through the injected port only.
    let opened: ReturnType<McpTransportPort['open']>;
    try {
      opened = this.ports.transport.open({
        serverId: this.manifest.serverId,
        transport: this.manifest.transport,
        oauthTokenRef,
        correlationId,
      });
    } catch {
      // A throwing port is treated as a disconnected external server.
      this.state = 'unavailable';
      this.reason = 'transport open failed (external server unreachable)';
      return this.scopedDisconnected(correlationId);
    }

    if (!opened.ok || !opened.handle.isAlive()) {
      this.state = 'unavailable';
      this.reason = opened.ok
        ? 'transport handle was not alive after open'
        : `transport open rejected: ${opened.ok === false ? opened.reason : 'unknown'}`;
      // If a handle was returned but dead, ensure it is released (no orphan).
      if (opened.ok) opened.handle.close();
      return this.scopedDisconnected(correlationId);
    }

    // Connected. Reset the reconnect budget on a successful connect.
    this.handle = opened.handle;
    this.state = 'connected';
    this.reconnectAttempts = 0;
    this.reason = 'connected and governed';
    return { ok: true, value: this.snapshot() };
  }

  /**
   * Truthful health probe. If the state claims `connected` but the underlying
   * handle is no longer alive, the server is reclassified `unavailable`
   * (disconnected) so health never reports a false connected status.
   */
  health(): McpServerSnapshot {
    if (this.state === 'connected' && (this.handle === null || !this.handle.isAlive())) {
      this.releaseHandle();
      this.state = 'unavailable';
      this.reason = 'health probe observed a dead transport (disconnected)';
    }
    return this.snapshot();
  }

  /**
   * Report a disconnection observed by a caller (e.g. a failed use). Drops the
   * owned handle and marks the server scoped-unavailable so the next use will
   * attempt a bounded reconnect. Never claims success.
   */
  reportDisconnected(correlationId: string): McpResult<McpServerSnapshot> {
    this.releaseHandle();
    if (this.state !== 'disposed') {
      this.state = 'unavailable';
      this.reason = 'caller reported a disconnection';
    }
    return this.scopedDisconnected(correlationId);
  }

  /**
   * Drain and dispose the server (rollback path). Closes the owned transport
   * connection so NO orphan process/socket remains, and moves to a terminal
   * `disposed` state that never reconnects. Idempotent: disposing an already
   * disposed server is a no-op that still reports no live connection. Returns
   * whether the owned connection (if any) was confirmed fully closed.
   */
  dispose(): { readonly disposed: true; readonly orphanReleased: boolean } {
    let orphanReleased = true;
    if (this.handle) {
      try {
        orphanReleased = this.handle.close() === true;
      } catch {
        orphanReleased = false;
      }
      this.handle = null;
    }
    this.state = 'disposed';
    this.reason = 'drained and disposed; transport released';
    return { disposed: true, orphanReleased };
  }

  private releaseHandle(): void {
    if (this.handle) {
      try {
        this.handle.close();
      } catch {
        // best-effort; dispose reports the truthful orphan status
      }
      this.handle = null;
    }
  }

  private scopedDisconnected(correlationId: string): McpResult<McpServerSnapshot> {
    return {
      ok: false,
      error: mcpError(
        'UNAVAILABLE',
        `MCP server '${this.manifest.serverId}' is disconnected/unreachable (scoped-unavailable)`,
        'mcp.connect',
        correlationId,
        this.reconnectAttempts < this.maxReconnect,
      ),
    };
  }

  private fail(
    code: ErrorCode,
    message: string,
    operation: string,
    correlationId: string,
  ): McpResult<McpServerSnapshot> {
    this.state = code === 'INCOMPATIBLE' ? 'unavailable' : this.state;
    if (code === 'INCOMPATIBLE') this.reason = message;
    return { ok: false, error: mcpError(code, message, operation, correlationId) };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 5. The MCP registry (managed config; disabled by default)
// ════════════════════════════════════════════════════════════════════════════

/**
 * A managed registry of declared MCP servers. Servers are DISABLED BY DEFAULT
 * and enabled per manifest/capability: declaring a server registers a lazy
 * adapter (no transport). An UNDECLARED (absent) server id resolves to a typed
 * scoped-UNAVAILABLE — absence never infers a connection (NN-INV-014). The
 * registry owns disposal: {@link disposeAll} drains every adapter so no orphan
 * connection survives a rollback.
 */
export class McpServerRegistry {
  private readonly ports: McpAdapterPorts;
  private readonly servers = new Map<string, McpServerAdapter>();

  constructor(ports: McpAdapterPorts) {
    this.ports = ports;
  }

  /**
   * Declare a server from its typed manifest (lazy; no transport). Re-declaring
   * an existing, non-disposed server id is a CONFLICT (managed config is
   * explicit). Returns the lazy adapter on success.
   */
  declare(manifest: McpServerManifest, correlationId?: string): McpResult<McpServerAdapter> {
    const existing = this.servers.get(manifest.serverId);
    if (existing && existing.lifecycleState !== 'disposed') {
      return {
        ok: false,
        error: mcpError(
          'CONFLICT',
          `MCP server '${manifest.serverId}' is already declared`,
          'mcp.declare',
          correlationId,
        ),
      };
    }
    const adapter = new McpServerAdapter(manifest, this.ports);
    this.servers.set(manifest.serverId, adapter);
    return { ok: true, value: adapter };
  }

  /** Get a declared adapter, or `undefined` for an absent (undeclared) id. */
  get(serverId: string): McpServerAdapter | undefined {
    return this.servers.get(serverId);
  }

  /**
   * Resolve a server for use, connecting lazily. An ABSENT (undeclared) id is a
   * typed scoped-UNAVAILABLE (never a false connect); a declared server is
   * connected on demand with the present/incompatible/disconnected semantics of
   * {@link McpServerAdapter.ensureConnected}.
   */
  resolveForUse(serverId: string, correlationId: string): McpResult<McpServerAdapter> {
    const adapter = this.servers.get(serverId);
    if (!adapter || adapter.lifecycleState === 'disposed') {
      return {
        ok: false,
        error: mcpError(
          'UNAVAILABLE',
          `MCP server '${serverId}' is not declared/available (scoped-unavailable)`,
          'mcp.resolve',
          correlationId,
        ),
      };
    }
    const connected = adapter.ensureConnected(correlationId);
    if (!connected.ok) return { ok: false, error: connected.error };
    return { ok: true, value: adapter };
  }

  /** Health snapshots for every declared server, sorted by id for determinism. */
  healthAll(): readonly McpServerSnapshot[] {
    return [...this.servers.values()]
      .map((a) => a.health())
      .sort((x, y) => (x.serverId < y.serverId ? -1 : x.serverId > y.serverId ? 1 : 0));
  }

  /**
   * Drain and dispose every declared server (rollback). Returns the number of
   * servers whose owned connection was NOT confirmed closed (orphans); zero
   * means no orphan process/socket survived the disposal.
   */
  disposeAll(): { readonly disposed: number; readonly orphans: number } {
    let disposed = 0;
    let orphans = 0;
    for (const adapter of this.servers.values()) {
      const r = adapter.dispose();
      disposed += 1;
      if (!r.orphanReleased) orphans += 1;
    }
    return { disposed, orphans };
  }

  /** Number of declared (including disposed) servers. */
  get size(): number {
    return this.servers.size;
  }
}
