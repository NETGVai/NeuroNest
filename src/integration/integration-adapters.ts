/**
 * Governed integration authority — authority routing, process isolation, and
 * the analyzed-only non-loading boundary (FUT-PKG-08-OPTIONAL/T-002).
 *
 * This module is the Integration Authority that ties the three integration
 * surfaces to the REAL system authorities so no integration ever gets a private
 * path:
 *
 *   - MCP tool calls are a GOVERNED TOOL PATH. An MCP tool advertised by
 *     {@link McpServerAdapter} (`mcp-adapter.ts`) is invoked ONLY by routing the
 *     call through the injected core tool port — the SAME authority a built-in
 *     tool uses (NN-INTEGRATION-003 "same tool lifecycle/evidence as built-ins";
 *     no authority bypass). The adapter contributes the transport/lifecycle; it
 *     never executes the effect itself.
 *   - Shared safe browser / web retrieval reuses the 5.8
 *     {@link SafeBrowserSubsystem} verbatim (one SSRF/DNS-rebinding destination
 *     policy; NN-EXEC-009). This module adds no second browser path.
 *   - Versioned IDE/CLI/external-agent bridge actions route through the ONE core
 *     operation port after the message is validated by `protocol-messages.ts`
 *     (NN-INTEGRATION-005, NN-EXEC-011). The surface only carries the envelope;
 *     the DECISION is the core's.
 *
 * Process ISOLATION and ownership (NN-SEC-016, NN-INTEGRATION-002,
 * NN-INV-012). Every integration process/connection an adapter spawns is OWNED
 * by an {@link IntegrationProcessRegistry}. Drain/dispose force-closes every
 * owned process through the injected kill port and reports survivors
 * TRUTHFULLY: `allReleased` is true ONLY when there are no survivors, so on
 * drain/dispose NO orphan process is hidden or fabricated. Rollback drains and
 * disposes the adapter and leaves core state readable (the registry only owns
 * connections, never durable business state).
 *
 * NO runtime loading of analyzed source frameworks (NN-INTEGRATION-001). An
 * adopted pattern from an analyzed framework enters ONLY through a NeuroNest-
 * owned extension point; an analyzed-only framework id is NEVER dynamically
 * loaded/executed. {@link assertNotAnalyzedOnly} refuses any attempt to admit
 * an analyzed-only framework as an executable integration, with a typed error.
 *
 * Everything is deterministic given its injected ports.
 *
 * Design anchors: D-02, D-03, D-05, D-11, D-16, D-17, D-18. Requirements:
 * NN-INTEGRATION-001/002/003/005, NN-EXEC-009/011, NN-SEC-016, NN-PLATFORM-007,
 * NN-INV-012/014.
 */

import {
  CONTRACT_WRITE_VERSION,
  isOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
} from '../shared/contract-primitives.js';
import {
  McpServerRegistry,
  type McpToolContract,
} from './mcp-adapter.js';
import {
  validateBridgeMessage,
  type Bridge,
  type BridgeMessage,
  type ProtocolResult,
} from './protocol-messages.js';

const INTEGRATION_OWNER = 'authority-integration';

/** A typed integration result: a value or a typed error (never false success). */
export type IntegrationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ErrorEnvelope };

function integrationError(
  code: ErrorCode,
  message: string,
  operation: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: INTEGRATION_OWNER,
    operation,
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: false,
    remediation:
      'Every integration routes through the real system authorities; no ' +
      'private path, no analyzed-source-framework runtime load, and every ' +
      'owned process is drained on dispose with survivors named.',
    redaction: 'internal',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. The core tool port (authority routing — no bypass)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The governed core tool port — the SAME authority a built-in tool call uses
 * (the 5.2 tool execution pipeline in production). An MCP tool call and a
 * bridge action both flow through this port; there is no other way to execute
 * an effect from an integration. Production wires this to the real pipeline;
 * tests inject a recording port that proves the call was routed (no bypass).
 */
export interface CoreToolPort {
  /**
   * Route a governed tool/action call. The port owns manifest → validate →
   * policy → approval → budget → sandbox → execute → output policy → persist.
   * It returns a typed success ref or a typed error; it NEVER trusts the caller.
   */
  routeToolCall(input: {
    readonly toolName: string;
    readonly sideEffect: McpToolContract['sideEffect'];
    readonly args: unknown;
    readonly principal: string;
    readonly cancellationTokenId: string;
    readonly correlationId: string;
    /** Provenance of the integration that surfaced this call (e.g. mcp:serverId). */
    readonly source: string;
  }): { readonly ok: true; readonly resultRef: string } | { readonly ok: false; readonly error: ErrorEnvelope };
}

/** Predicate telling the authority whether a token is cancelled (shared tree). */
export type IsCancelled = (cancellationTokenId: string) => boolean;

// ════════════════════════════════════════════════════════════════════════════
// 2. Analyzed-only framework non-loading boundary (NN-INTEGRATION-001)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Framework provenance classes (NN-INTEGRATION-001):
 *   - `analyzed-only`   — indexed for provenance/discovery ONLY; NEVER loaded or
 *     executed at runtime (catalog-only truth).
 *   - `owned-extension` — an adopted pattern reimplemented behind a
 *     NeuroNest-owned extension point; this is the ONLY executable class.
 */
export const FRAMEWORK_CLASSES = Object.freeze([
  'analyzed-only',
  'owned-extension',
] as const);
export type FrameworkClass = (typeof FRAMEWORK_CLASSES)[number];

/**
 * Refuse to admit an analyzed-only framework as an executable integration. An
 * `analyzed-only` framework id returns a typed `FORBIDDEN` and is NEVER loaded
 * (NN-INTEGRATION-001). An `owned-extension` passes. Pure and side-effect free —
 * it authorizes nothing, it only classifies.
 */
export function assertNotAnalyzedOnly(
  frameworkId: string,
  frameworkClass: FrameworkClass,
  correlationId?: string,
): IntegrationResult<{ readonly frameworkId: string }> {
  if (frameworkClass === 'analyzed-only') {
    return {
      ok: false,
      error: integrationError(
        'FORBIDDEN',
        `framework '${frameworkId}' is analyzed-only and must not be loaded or executed at runtime`,
        'integration.framework-admit',
        correlationId,
      ),
    };
  }
  return { ok: true, value: { frameworkId } };
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Owned integration process registry (process isolation, NN-SEC-016)
// ════════════════════════════════════════════════════════════════════════════

/** The kinds of owned integration processes/connections. */
export const OWNED_PROCESS_KINDS = Object.freeze([
  'mcp-transport',
  'browser',
  'bridge',
] as const);
export type OwnedProcessKind = (typeof OWNED_PROCESS_KINDS)[number];

/**
 * An owned integration process/connection. `isAlive` is a truthful probe and
 * `kill` force-terminates it, returning whether it is confirmed stopped
 * afterwards. The registry NEVER assumes a process stopped; it observes.
 */
export interface OwnedIntegrationProcess {
  readonly processId: string;
  readonly kind: OwnedProcessKind;
  /** Safe, secret-free owner label (e.g. the server/bridge id). */
  readonly owner: string;
  isAlive(): boolean;
  /** Force-terminate; returns true only when confirmed stopped afterwards. */
  kill(): boolean;
}

/** The truthful outcome of draining the registry. */
export interface DrainResult {
  /** Process ids confirmed stopped. */
  readonly released: readonly string[];
  /** Process ids still observed alive after the forced kill (survivors, named). */
  readonly survivors: readonly string[];
  /** True ONLY when there are no survivors (no orphan hidden). */
  readonly allReleased: boolean;
}

/**
 * Owns every process/connection an integration spawns so drain/dispose can
 * force-close them and TRUTHFULLY report survivors (NN-INV-012, NN-SEC-016). A
 * process registered here is the adapter's to clean; on {@link drainAll} nothing
 * is left orphaned unless the injected kill fails to confirm a stop, in which
 * case it is NAMED as a survivor (never hidden).
 */
export class IntegrationProcessRegistry {
  private readonly processes = new Map<string, OwnedIntegrationProcess>();

  /** Register an owned process. Re-registering the same id is a no-op replace. */
  register(process: OwnedIntegrationProcess): void {
    this.processes.set(process.processId, process);
  }

  /** Whether a process id is currently owned and alive. */
  isAlive(processId: string): boolean {
    const p = this.processes.get(processId);
    return p !== undefined && p.isAlive();
  }

  /** The number of owned processes still observed alive. */
  liveCount(): number {
    let n = 0;
    for (const p of this.processes.values()) if (p.isAlive()) n += 1;
    return n;
  }

  /**
   * Drain and force-close every owned process. Each live process is killed
   * through its injected `kill`; a process confirmed stopped is `released`, one
   * still alive afterwards is a named `survivor`. `allReleased` is true only
   * when the survivor set is empty — so on dispose no orphan process is hidden.
   * Drained processes are removed from the registry.
   */
  drainAll(): DrainResult {
    const released: string[] = [];
    const survivors: string[] = [];
    for (const p of this.processes.values()) {
      if (!p.isAlive()) {
        released.push(p.processId);
        continue;
      }
      let stopped = false;
      try {
        stopped = p.kill() === true && !p.isAlive();
      } catch {
        stopped = false;
      }
      if (stopped) released.push(p.processId);
      else survivors.push(p.processId);
    }
    this.processes.clear();
    released.sort();
    survivors.sort();
    return { released, survivors, allReleased: survivors.length === 0 };
  }

  /** Number of owned (alive or not) processes currently registered. */
  get size(): number {
    return this.processes.size;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 4. The Integration Authority
// ════════════════════════════════════════════════════════════════════════════

/** Collaborators for the {@link IntegrationAuthority}. */
export interface IntegrationAuthorityPorts {
  readonly mcp: McpServerRegistry;
  readonly core: CoreToolPort;
  readonly isCancelled: IsCancelled;
  readonly processes: IntegrationProcessRegistry;
}

/**
 * The Integration Authority. Every integration action flows through it so the
 * real authorities decide, integration processes stay owned, and analyzed-only
 * frameworks are never loaded. It holds no durable business state; a rollback
 * disposes it and leaves core state readable.
 */
export class IntegrationAuthority {
  private readonly ports: IntegrationAuthorityPorts;
  private disposed = false;

  constructor(ports: IntegrationAuthorityPorts) {
    this.ports = ports;
  }

  /** Whether the authority has been drained/disposed. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Invoke an MCP-advertised tool. This is the GOVERNED TOOL PATH: it lazily
   * connects the server (present/absent/incompatible/disconnected semantics),
   * confirms the tool is advertised, checks cancellation on the shared token
   * tree, and then routes the ACTUAL call through the core tool port — the same
   * authority a built-in uses. It NEVER executes the effect directly and NEVER
   * bypasses the core (NN-INTEGRATION-003, no authority bypass).
   */
  callMcpTool(input: {
    readonly serverId: string;
    readonly toolName: string;
    readonly args: unknown;
    readonly principal: string;
    readonly cancellationTokenId: string;
    readonly correlationId: string;
  }): IntegrationResult<{ readonly resultRef: string }> {
    if (this.disposed) {
      return this.fail('UNAVAILABLE', 'integration authority is disposed', 'integration.mcp-call', input.correlationId);
    }
    // Cancellation is checked identically to every other governed path.
    if (this.ports.isCancelled(input.cancellationTokenId)) {
      return this.fail('CANCELLED', 'cancelled before dispatch', 'integration.mcp-call', input.correlationId);
    }

    // Lazily resolve + connect the server (scoped-unavailable on failure).
    const resolved = this.ports.mcp.resolveForUse(input.serverId, input.correlationId);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }
    const adapter = resolved.value;
    const contract = adapter.toolContract(input.toolName);
    if (!contract) {
      return this.fail(
        'UNAVAILABLE',
        `MCP server '${input.serverId}' does not advertise tool '${input.toolName}'`,
        'integration.mcp-call',
        input.correlationId,
      );
    }

    // ROUTE THROUGH THE CORE — no private execution path.
    const routed = this.ports.core.routeToolCall({
      toolName: contract.toolName,
      sideEffect: contract.sideEffect,
      args: input.args,
      principal: input.principal,
      cancellationTokenId: input.cancellationTokenId,
      correlationId: input.correlationId,
      source: `mcp:${input.serverId}`,
    });
    if (!routed.ok) {
      // A transport-level failure is reported to the adapter so the next use
      // triggers a bounded reconnect; the typed error is returned unchanged.
      if (routed.error.code === 'UNAVAILABLE') {
        adapter.reportDisconnected(input.correlationId);
      }
      return { ok: false, error: routed.error };
    }
    return { ok: true, value: { resultRef: routed.resultRef } };
  }

  /**
   * Route a versioned bridge (IDE/CLI/external-agent) action. The untrusted
   * message is validated FIRST (versioned, workspace identity, no cross-bridge
   * type leakage); an incompatible/invalid message is a typed error and no
   * action runs. A cancelled token short-circuits. A valid message's action is
   * then routed through the core — the surface never decides (NN-INTEGRATION-005,
   * NN-EXEC-011).
   */
  routeBridgeAction(
    rawMessage: unknown,
    principal: string,
    options: { readonly expectedBridge?: Bridge; readonly correlationId?: string } = {},
  ): IntegrationResult<{ readonly resultRef: string; readonly message: BridgeMessage }> {
    if (this.disposed) {
      return this.fail('UNAVAILABLE', 'integration authority is disposed', 'integration.bridge-action', options.correlationId);
    }
    const validated: ProtocolResult<BridgeMessage> = validateBridgeMessage(rawMessage, options);
    if (!validated.ok) {
      return { ok: false, error: validated.error };
    }
    const message = validated.value;
    if (this.ports.isCancelled(message.cancellationTokenId)) {
      return this.fail('CANCELLED', 'cancelled before dispatch', 'integration.bridge-action', message.correlationId);
    }

    const routed = this.ports.core.routeToolCall({
      toolName: message.action,
      // A bridge action's side effect is unknown to the surface; the core
      // classifies and governs it. `write` is the conservative default so the
      // core applies the strictest gate unless it overrides.
      sideEffect: 'write',
      args: message.payload,
      principal,
      cancellationTokenId: message.cancellationTokenId,
      correlationId: message.correlationId,
      source: `bridge:${message.bridge}:ws=${message.workspace.workspaceId}`,
    });
    if (!routed.ok) {
      return { ok: false, error: routed.error };
    }
    return { ok: true, value: { resultRef: routed.resultRef, message } };
  }

  /**
   * Drain and dispose the whole integration surface (rollback). Disposes every
   * MCP server (releasing owned transports) and drains the owned process
   * registry, returning the TRUTHFUL survivor report. After dispose the
   * authority admits no further action; core (durable business) state is
   * untouched and remains readable.
   */
  dispose(): {
    readonly disposed: true;
    readonly mcp: { readonly disposed: number; readonly orphans: number };
    readonly processes: DrainResult;
  } {
    this.disposed = true;
    const mcp = this.ports.mcp.disposeAll();
    const processes = this.ports.processes.drainAll();
    return { disposed: true, mcp, processes };
  }

  private fail(
    code: ErrorCode,
    message: string,
    operation: string,
    correlationId?: string,
  ): IntegrationResult<never> {
    return { ok: false, error: integrationError(code, message, operation, correlationId) };
  }
}
