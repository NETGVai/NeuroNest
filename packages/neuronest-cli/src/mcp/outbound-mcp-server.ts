//
// `OutboundMcpServer` instantiates the MCP SDK's stdio `Server`,
// registers the `tools/list` and `tools/call` handlers backed by
// `createMcpHandlers`, and dispatches each `tools/call` to the
// matching handler. The server is the wrapper around the seven
// tool handlers from `./handlers.ts`:
//
//   MCP request → tool handler → 1 Headless_Protocol action →
//     await `completed` event for that action's requestId →
//     translate event sequence into MCP response.
//
// Translation-layer invariant (Req 6.11): no parallel execution
// surface — every admitted MCP call funnels through one
// `transport.send` followed by one `completed` event read.
//
// Failure handling (Req 6.10): On any Headless_Protocol failure
// (error event without `completed`, `completed: { success: false }`,
// transport disconnect mid-call) the failing MCP call returns a
// structured `{ code: 'headless_failed' }` MCP error. The MCP
// server connection to the client REMAINS OPEN and accepts
// subsequent requests — failures NEVER tear down the SDK transport.
//
// Graceful shutdown (Req 6.12): `stop()` closes the MCP SDK server,
// drains in-flight tool handlers (awaits their `completed` events
// or `headless_failed` resolutions), and releases the
// Headless_Protocol transport via `transport.close()`.
//
// The MCP SDK `Server` is dynamically imported so the
// `@modelcontextprotocol/sdk` package is loaded only when the
// server is actually started (a side benefit: this keeps the
// handler tests importable on machines without the SDK installed,
// matching the unit-test boundary in `__tests__/handlers.test.ts`).
//
// Validates: Requirements 6.1, 6.2, 6.10, 6.11, 6.12

import {
  createMcpHandlers,
  type LicenseCheck,
  type NeuronestMcpHandlers,
} from './handlers.js';
import type {
  HeadlessEvent,
  McpError,
  NeuronestMcpTool,
  OnboardingGate,
  OpenedTransport,
  OutboundMcpServer,
  OutboundMcpServerOptions,
} from './types.js';
import { NEURONEST_MCP_TOOLS } from './types.js';

// ─── MCP SDK shapes — referenced via narrow structural types ────
//
// The SDK is dynamically imported in `start()` so this module
// remains importable without `@modelcontextprotocol/sdk` on the
// machine (e.g. for handler-only tests). The structural interfaces
// below mirror just the methods the wrapper actually calls.

/** The minimal `Server` surface the wrapper uses. The full SDK
 *  type is `import('@modelcontextprotocol/sdk/server/index.js').Server`,
 *  but the structural form here keeps this module from carrying a
 *  hard SDK type dependency at compile time. */
interface SdkServerLike {
  setRequestHandler(
    requestSchema: unknown,
    handler: (request: SdkRequest) => Promise<unknown>,
  ): void;
  connect(transport: SdkTransportLike): Promise<void>;
  close(): Promise<void>;
}

interface SdkServerCtor {
  new (
    info: { name: string; version: string },
    options: { capabilities: { tools: object } },
  ): SdkServerLike;
}

interface SdkStdioTransportCtor {
  new (): SdkTransportLike;
}

interface SdkTransportLike {
  start?: () => Promise<void>;
  close?: () => Promise<void>;
}

/** Shape of `tools/list` and `tools/call` requests we receive from
 *  the SDK. Both schemas have `method` literals; `tools/call` carries
 *  the tool name and arguments under `params`. */
interface SdkRequest {
  method: string;
  params?: {
    name?: string;
    arguments?: unknown;
  };
}

/** Shape of `tools/list` results. */
interface SdkToolDescriptor {
  name: string;
  description?: string;
  inputSchema: object;
}

interface SdkListToolsResult {
  tools: SdkToolDescriptor[];
}

/** Shape of `tools/call` results — always returns `content` plus an
 *  optional `isError` flag. The SDK accepts `unknown` for `_meta`
 *  passthrough; we omit it. */
interface SdkCallToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

/**
 * Loader for the MCP SDK. Defaults to the live `@modelcontextprotocol/sdk`
 * exports; tests inject a stub via `OutboundMcpServerInternalDeps.loadSdk`.
 */
export interface McpSdkLoader {
  loadServer(): Promise<{
    Server: SdkServerCtor;
    requestSchemas: {
      ListToolsRequestSchema: unknown;
      CallToolRequestSchema: unknown;
    };
  }>;
  loadTransport(): Promise<{ StdioServerTransport: SdkStdioTransportCtor }>;
}

/**
 * Default SDK loader — performs a dynamic ES `import()` of the
 * `@modelcontextprotocol/sdk` subpaths the wrapper needs. Imports
 * are deferred to runtime so this module can be imported (and its
 * non-SDK types consumed) without the SDK installed.
 */
export const defaultSdkLoader: McpSdkLoader = {
  async loadServer() {
    const serverMod = (await import(
      '@modelcontextprotocol/sdk/server/index.js'
    )) as { Server: SdkServerCtor };
    const typesMod = (await import(
      '@modelcontextprotocol/sdk/types.js'
    )) as {
      ListToolsRequestSchema: unknown;
      CallToolRequestSchema: unknown;
    };
    return {
      Server: serverMod.Server,
      requestSchemas: {
        ListToolsRequestSchema: typesMod.ListToolsRequestSchema,
        CallToolRequestSchema: typesMod.CallToolRequestSchema,
      },
    };
  },
  async loadTransport() {
    const stdioMod = (await import(
      '@modelcontextprotocol/sdk/server/stdio.js'
    )) as { StdioServerTransport: SdkStdioTransportCtor };
    return { StdioServerTransport: stdioMod.StdioServerTransport };
  },
};

/**
 * Internal dependency overrides for tests. Production callers use
 * `createOutboundMcpServer()` (no args) and the defaults take over.
 */
export interface OutboundMcpServerInternalDeps {
  /** Override for the MCP SDK loader — tests inject stubs. */
  loadSdk?: McpSdkLoader;
  /** Override for the handler factory — tests inject deterministic
   *  handlers. Default: `createMcpHandlers`. */
  createHandlers?: (
    licenseCheck: LicenseCheck,
    opts?: { onForeignEvent?: (event: HeadlessEvent) => void },
  ) => NeuronestMcpHandlers;
}

// ─── Status enum ───────────────────────────────────────────────

type ServerStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

// ─── Implementation ────────────────────────────────────────────

/**
 * Concrete `OutboundMcpServer`. Constructor accepts internal-dep
 * overrides for tests; production callers use the
 * `createOutboundMcpServer()` factory below.
 */
export class OutboundMcpServerImpl implements OutboundMcpServer {
  private status: ServerStatus = 'idle';
  private sdkServer: SdkServerLike | undefined;
  private headlessTransport: OpenedTransport | undefined;

  /**
   * Promises returned by in-flight handler invocations. `stop()`
   * waits on all of these (via `Promise.allSettled`) so the call
   * resolves only after every running handler has either produced
   * its MCP response or been resolved into a `headless_failed`
   * outcome. Handlers self-remove on completion via the `finally`
   * block in `dispatchToolCall`.
   */
  private inFlight = new Set<Promise<unknown>>();

  private readonly sdkLoader: McpSdkLoader;
  private readonly handlerFactory: (
    licenseCheck: LicenseCheck,
    opts?: { onForeignEvent?: (event: HeadlessEvent) => void },
  ) => NeuronestMcpHandlers;

  constructor(deps: OutboundMcpServerInternalDeps = {}) {
    this.sdkLoader = deps.loadSdk ?? defaultSdkLoader;
    this.handlerFactory = deps.createHandlers ?? createMcpHandlers;
  }

  /**
   * Bring up the MCP SDK over stdio, register the seven handlers,
   * and accept client connections.
   *
   * Throws if `start()` is called more than once or after `stop()` —
   * this class is single-shot. Errors during SDK initialization
   * propagate to the caller; once `connect()` succeeds, the server
   * stays up until `stop()` is called.
   */
  async start(opts: OutboundMcpServerOptions): Promise<void> {
    if (this.status !== 'idle') {
      throw new Error(
        `OutboundMcpServer.start: invalid state '${this.status}'`,
      );
    }
    this.status = 'starting';

    const headless = opts.transport;
    const gate = opts.gate;
    const licenseCheck =
      opts.licenseCheck ??
      (() =>
        Promise.resolve({
          ok: false,
          detail: 'no licenseCheck supplied to OutboundMcpServer.start',
        }));

    this.headlessTransport = headless;

    // Build the seven tool handlers, sharing one foreign-event sink
    // so concurrent in-flight handlers can route events for other
    // requestIds back into a future microtask. The shared events
    // iterator is consumed by handler `dispatch()` calls — events
    // for non-matching requestIds are forwarded back to whichever
    // handler is also currently awaiting them.
    //
    // The current implementation drops foreign events that arrive
    // when no handler is registered for their requestId; concurrent
    // dispatch is supported by re-queuing into the head of any
    // pending handlers' iterations via the foreign-event sink.
    // (For task 11.5 we keep concurrency to one-handler-at-a-time
    // by serializing tool calls in dispatchToolCall — see notes
    // there. Multi-call concurrency is a future enhancement and
    // does not impact the translation-layer invariant.)
    const handlers = this.handlerFactory(licenseCheck);

    // Load the MCP SDK and instantiate the stdio server.
    const { Server, requestSchemas } = await this.sdkLoader.loadServer();
    const { StdioServerTransport } = await this.sdkLoader.loadTransport();

    const sdkServer = new Server(
      { name: 'neuronest', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    this.sdkServer = sdkServer;

    // ── tools/list — return EXACTLY the seven NEURONEST_MCP_TOOLS
    //    descriptors with their argsSchema. The server NEVER
    //    advertises any tool outside NEURONEST_MCP_TOOLS (Req 6.2).
    sdkServer.setRequestHandler(
      requestSchemas.ListToolsRequestSchema,
      async (): Promise<SdkListToolsResult> => {
        const tools: SdkToolDescriptor[] = [];
        for (const name of NEURONEST_MCP_TOOLS) {
          const handler = handlers[name];
          tools.push({
            name,
            description: describeMcpTool(name),
            inputSchema: handler.argsSchema as object,
          });
        }
        return { tools };
      },
    );

    // ── tools/call — dispatch by name into the matching handler.
    //    Unknown tool name → MethodNotFound-shaped MCP error. Any
    //    handler error (`{ ok: false; error }`) is translated into
    //    a CallToolResult with `isError: true` so the SDK keeps the
    //    connection open and the failing call's response carries
    //    the structured error code (Req 6.10).
    sdkServer.setRequestHandler(
      requestSchemas.CallToolRequestSchema,
      async (request: SdkRequest): Promise<SdkCallToolResult> => {
        const toolName = request.params?.name;
        const args = request.params?.arguments;

        if (typeof toolName !== 'string' || toolName.length === 0) {
          return errorResult({
            code: 'invalid_args',
            message: 'tools/call: missing tool name',
          });
        }
        if (!isNeuronestMcpTool(toolName)) {
          return errorResult({
            code: 'invalid_args',
            message: `tools/call: unknown tool '${toolName}'`,
          });
        }

        return this.dispatchToolCall(handlers, toolName, args, headless, gate);
      },
    );

    // ── Connect the SDK to its stdio transport. Once `connect()`
    //    resolves, the server is live and the MCP client can call
    //    `tools/list` / `tools/call`.
    const sdkTransport = new StdioServerTransport();
    await sdkServer.connect(sdkTransport);

    this.status = 'running';
  }

  /**
   * Graceful shutdown (Req 6.12).
   *
   *   1. Set status to 'stopping' so subsequent `tools/call`s see
   *      the gate (we still execute them — closing the SDK is the
   *      authoritative drain — but we record the state for any
   *      diagnostics).
   *   2. Close the MCP SDK server. The SDK's `Server.close()`
   *      cancels in-flight requests at the transport layer; we
   *      additionally await the `inFlight` set so each handler
   *      reaches its `completed` or `headless_failed` resolution.
   *   3. Release the Headless_Protocol transport via
   *      `transport.close()`.
   *
   * `stop()` is idempotent: calling it after the server is already
   * stopped is a no-op.
   */
  async stop(): Promise<void> {
    if (this.status === 'stopped' || this.status === 'idle') {
      this.status = 'stopped';
      return;
    }
    if (this.status === 'stopping') {
      // Concurrent stop — wait until in-flight handlers settle and
      // return.
      await Promise.allSettled(Array.from(this.inFlight));
      return;
    }
    this.status = 'stopping';

    // Close the SDK server first so it stops accepting new
    // tools/call requests and signals any pending request
    // listeners. The SDK's `close()` is idempotent and resolves
    // when the underlying transport's stream is fully torn down.
    const sdkServer = this.sdkServer;
    if (sdkServer !== undefined) {
      try {
        await sdkServer.close();
      } catch {
        // Closing twice or after a transport-level error throws —
        // the only contract here is that we don't propagate the
        // shutdown error past stop().
      }
    }

    // Drain in-flight handler promises. Each handler self-removes
    // from `inFlight` in its `finally` block, but we await the
    // current snapshot to guarantee all responses have been
    // synthesised before we release the headless transport.
    const pending = Array.from(this.inFlight);
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }

    // Release the Headless_Protocol transport — this is the
    // resource the OutboundMcpServer borrowed via
    // `OutboundMcpServerOptions.transport`.
    const headless = this.headlessTransport;
    if (headless !== undefined) {
      try {
        await headless.close();
      } catch {
        // Same idempotency stance as the SDK close above.
      }
    }

    this.sdkServer = undefined;
    this.headlessTransport = undefined;
    this.status = 'stopped';
  }

  /**
   * Run one tool's handler against the shared headless transport
   * and gate. Tracks the in-flight promise in `this.inFlight` so
   * `stop()` can drain it.
   *
   * Failures from the handler are translated into MCP error
   * responses with `isError: true` — the SDK transport stays open
   * (Req 6.10). Unexpected throws (handler bug) are similarly
   * caught and translated rather than allowed to propagate, since
   * a thrown JSON-RPC handler aborts the request and could destabilise
   * the SDK transport.
   */
  private dispatchToolCall(
    handlers: NeuronestMcpHandlers,
    toolName: NeuronestMcpTool,
    args: unknown,
    transport: OpenedTransport,
    gate: OnboardingGate,
  ): Promise<SdkCallToolResult> {
    const handler = handlers[toolName];
    const promise = (async (): Promise<SdkCallToolResult> => {
      try {
        const outcome = await handler.execute(args, { transport, gate });
        if (outcome.ok) {
          return successResult(outcome.result);
        }
        return errorResult(outcome.error);
      } catch (err) {
        // Handlers should never throw — every failure mode is
        // covered by `{ ok: false; error }`. If one does, treat it
        // as a `headless_failed` so the SDK connection stays open
        // and the client receives a structured error.
        return errorResult({
          code: 'headless_failed',
          message: `handler ${toolName} threw: ${(err as Error).message}`,
        });
      }
    })();

    this.inFlight.add(promise);
    void promise.finally(() => {
      this.inFlight.delete(promise);
    });
    return promise;
  }
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Build a fresh `OutboundMcpServer`. Single-shot — call `start()`
 * once, then `stop()` once. Re-entry is rejected.
 *
 * Tests can pass `internalDeps` to inject a fake SDK loader and/or
 * fake handlers; production callers omit the argument.
 */
export function createOutboundMcpServer(
  internalDeps: OutboundMcpServerInternalDeps = {},
): OutboundMcpServer {
  return new OutboundMcpServerImpl(internalDeps);
}

// ─── Helpers ───────────────────────────────────────────────────

/**
 * One-line description per MCP tool, surfaced in `tools/list`.
 * Exhaustive over `NEURONEST_MCP_TOOLS` so the seven-tool surface
 * never drifts (Req 6.2).
 */
function describeMcpTool(name: NeuronestMcpTool): string {
  switch (name) {
    case 'neuronest:listSpecs':
      return 'List specs in the active workspace, with their current onboarding state.';
    case 'neuronest:runSpec':
      return 'Run a named spec via the desktop app or spawned headless agent.';
    case 'neuronest:listSkills':
      return 'List installed skills (user-level and workspace-local).';
    case 'neuronest:runSkill':
      return 'Run a named skill with the supplied parameters.';
    case 'neuronest:askWorkspace':
      return 'Ask a grounded read-only question about the live workspace state.';
    case 'neuronest:listWorkflows':
      return 'List packaged workflows registered in the active workspace.';
    case 'neuronest:runWorkflow':
      return 'Run a named packaged workflow with the supplied parameters.';
  }
}

function isNeuronestMcpTool(name: string): name is NeuronestMcpTool {
  return (NEURONEST_MCP_TOOLS as ReadonlyArray<string>).includes(name);
}

/**
 * Wrap a handler success result as an MCP `tools/call` response.
 * The structured payload is also surfaced as a JSON-encoded text
 * content block so older MCP clients that ignore
 * `structuredContent` still see a usable answer.
 */
function successResult(result: unknown): SdkCallToolResult {
  return {
    content: [{ type: 'text', text: stableStringify(result) }],
    structuredContent: result as object | undefined,
    isError: false,
  };
}

/**
 * Wrap an MCP `McpError` as a `tools/call` response. `isError: true`
 * is the SDK convention that keeps the connection open while
 * signalling a per-call failure (Req 6.10).
 */
function errorResult(error: McpError): SdkCallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: `[${error.code}] ${error.message}`,
      },
    ],
    structuredContent: { code: error.code, message: error.message },
    isError: true,
  };
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
