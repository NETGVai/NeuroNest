//
// Type definitions for the seven-tool MCP_Tool_Surface that
// `npx @neuronest/cli mcp` exposes (Req 6.1, 6.2). Every tool is a
// pure translation layer over Phase 3's Headless_Protocol — there is
// no parallel execution path (Req 6.11). The server inherits the
// desktop app's license auth (Req 6.7) and Onboarding_State_Machine
// gating (Req 6.8, 6.9), and all transport-layer failures surface as
// structured MCP errors that leave the server connection open
// (Req 6.10).
//
// Validates: Requirements 6.1, 6.2, 6.7, 6.8, 6.9, 6.10

import type {
  HeadlessAction,
  HeadlessEvent,
  HeadlessTransport,
  OpenedTransport,
} from '../transport/headless-transport.js';

// Re-export the transport types so consumers of this module (the seven
// MCP tool handlers, the OutboundMcpServer wrapper) can import the
// runtime contract from one place.
export type {
  HeadlessAction,
  HeadlessEvent,
  HeadlessTransport,
  OpenedTransport,
};

// ─── Phase 3 forward-declarations (read-only references) ────────
//
// `OnboardingState` and `OnboardingGate` remain forward-declared
// locally because their authoritative source (Phase 3's
// `src/main/onboarding/`) is on the desktop side and the standalone
// CLI package must not import from there. The Headless_Protocol
// transport types, by contrast, live inside this package
// (`../transport/headless-transport.ts`) and are imported above.

/**
 * Phase 3 onboarding state — the set of states tracked by the
 * Onboarding_State_Machine. The two states `taskExecuting` and
 * `complete` are the ones that allow workspace-mutating tool
 * invocation (Req 6.9); any other state forbids the three mutating
 * MCP tools (`runSpec`, `runSkill`, `runWorkflow`) and yields an
 * `onboarding_incomplete` MCP error.
 *
 * Mirrors the brand declared in `src/agent-skills/run-batch/types.ts`
 * so the two declarations remain structurally compatible.
 */
export type OnboardingState =
  | 'taskExecuting'
  | 'complete'
  | (string & { readonly __onboardingStateBrand?: unique symbol });

/**
 * Cached snapshot of the desktop app's current Onboarding_State for
 * the active workspace, refreshed via Headless_Protocol on each MCP
 * request that needs it. Forward-declared here as the minimal
 * contract the seven MCP tool handlers consult; the full
 * implementation lands in `./onboarding-gate.ts` in a later task.
 */
export interface OnboardingGate {
  /** Returns true when state ∈ {taskExecuting, complete}. Used to
   *  decide whether `runSpec` / `runSkill` / `runWorkflow` may
   *  proceed (Req 6.9). */
  isWorkspaceMutationAllowed(): Promise<boolean>;
  /** Returns the current state for diagnostic messages. */
  currentState(): Promise<OnboardingState>;
}

/**
 * Forward-declaration alias kept for compatibility with prior call
 * sites that imported `HeadlessTransport` from this module before
 * task 11.4 wired the real transport import. The alias is now a
 * straight re-export of `../transport/headless-transport.ts` (see the
 * `import type` block at the top of this file). Future cleanup may
 * delete this paragraph, but the export name itself is part of the
 * locked Item 6 surface.
 */

// ─── MCP_Tool_Surface ───────────────────────────────────────────

/**
 * The fixed MCP_Tool_Surface — exactly seven entries (Req 6.2). The
 * array is `Object.freeze`d so accidental mutation at runtime
 * surfaces as a TypeError on strict-mode hosts; the `as const`
 * narrows each entry to its literal type for `NeuronestMcpTool`
 * derivation.
 */
export const NEURONEST_MCP_TOOLS = Object.freeze([
  'neuronest:listSpecs',
  'neuronest:runSpec',
  'neuronest:listSkills',
  'neuronest:runSkill',
  'neuronest:askWorkspace',
  'neuronest:listWorkflows',
  'neuronest:runWorkflow',
] as const);

/** Union of the seven MCP tool names in `NEURONEST_MCP_TOOLS`. */
export type NeuronestMcpTool = (typeof NEURONEST_MCP_TOOLS)[number];

// ─── Per-tool argument shapes ───────────────────────────────────
//
// `ListSpecsArgs`, `ListSkillsArgs`, and `ListWorkflowsArgs` are
// declared as empty object types (no required parameters). The
// dispatcher still validates at runtime against the JSON Schema each
// handler advertises via `McpToolHandler.argsSchema`.

/** Args for `neuronest:listSpecs` — no parameters. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ListSpecsArgs {
  /* none */
}

/** Args for `neuronest:runSpec` (Req 6.3). */
export interface RunSpecArgs {
  specId: string;
}

/** Args for `neuronest:listSkills` — no parameters. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ListSkillsArgs {
  /* none */
}

/** Args for `neuronest:runSkill` (Req 6.4). */
export interface RunSkillArgs {
  skillId: string;
  params: unknown;
}

/** Args for `neuronest:askWorkspace` (Req 6.5). */
export interface AskWorkspaceArgs {
  question: string;
}

/** Args for `neuronest:listWorkflows` — no parameters. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ListWorkflowsArgs {
  /* none */
}

/** Args for `neuronest:runWorkflow` (Req 6.6). */
export interface RunWorkflowArgs {
  workflowId: string;
  params: unknown;
}

// ─── Per-list-tool result entries ───────────────────────────────

/** One entry in the `neuronest:listSpecs` result. */
export interface SpecListEntry {
  specId: string;
  title: string;
  currentState: OnboardingState;
}

/** One entry in the `neuronest:listSkills` result. */
export interface SkillListEntry {
  skillId: string;
  description: string;
  version: string;
  deprecated?: string;
}

/** One entry in the `neuronest:listWorkflows` result. */
export interface WorkflowListEntry {
  workflowId: string;
  description?: string;
  version: string;
  versionHash: string;
}

// ─── Server / handler / error contracts ─────────────────────────

/**
 * One MCP tool handler. Each handler is a paper-thin translation
 * layer: it builds a single `HeadlessAction` from its args, awaits
 * the `completed` event keyed by that action's requestId, and
 * synthesises an MCP-shaped result. On Headless_Protocol failure the
 * handler returns a structured `McpError` (Req 6.10) rather than
 * throwing — the MCP connection stays open for subsequent requests.
 *
 * Handlers MUST consult the embedded `OnboardingGate` to short-
 * circuit workspace-mutating tools when onboarding is incomplete
 * (Req 6.8, 6.9).
 */
export interface McpToolHandler<Args, Result> {
  /** MCP tool name — one of `NEURONEST_MCP_TOOLS`. */
  readonly name: NeuronestMcpTool;
  /** JSON Schema for `Args`, used by the SDK to validate inputs. */
  readonly argsSchema: object;
  /**
   * Translate a single MCP tool call into a Headless_Protocol action,
   * await the action's `completed` event (collecting `text`,
   * `tool_done`, and `error` events keyed by the same requestId),
   * and synthesise an MCP-shaped result. Returns a structured MCP
   * error response on Headless_Protocol failure (Req 6.10) without
   * tearing down the MCP connection.
   */
  execute(
    args: Args,
    ctx: { transport: OpenedTransport; gate: OnboardingGate },
  ): Promise<{ ok: true; result: Result } | { ok: false; error: McpError }>;
}

/**
 * The four MCP error codes the seven handlers ever emit. `code` is a
 * machine-readable discriminant; `message` is the human-readable
 * detail surfaced to the MCP client (and on stderr by the CLI).
 */
export type McpError =
  | { code: 'license_invalid'; message: string } // Req 6.7
  | { code: 'onboarding_incomplete'; message: string } // Req 6.8, 6.9
  | { code: 'headless_failed'; message: string } // Req 6.10
  | { code: 'invalid_args'; message: string };

/**
 * The MCP server itself. `start` brings up the MCP SDK over stdio
 * and registers the seven `McpToolHandler`s; `stop` is the graceful
 * shutdown sequence (Req 6.12) that drains in-flight handlers and
 * releases the Headless_Protocol transport acquired at startup.
 */
export interface OutboundMcpServer {
  /**
   * Start the MCP server using the standard MCP SDK over stdio.
   * Connection lifecycle is owned by the SDK; this class is the
   * Translation layer (Req 6.11):
   *
   *   MCP request → tool handler → 1 Headless_Protocol action →
   *     await `completed` event for that action's requestId →
   *     translate event sequence into MCP response.
   *
   * No tool is implemented in terms of any other path. There is no
   * "fast path" that bypasses the agent loop.
   */
  start(opts: OutboundMcpServerOptions): Promise<void>;

  /**
   * Graceful shutdown (Req 6.12). Closes the MCP server, drains
   * in-flight tool handlers, and releases the Headless_Protocol
   * transport acquired at startup.
   */
  stop(): Promise<void>;
}

/** Construction-time options for `OutboundMcpServer.start`. */
export interface OutboundMcpServerOptions {
  /**
   * The pre-opened Headless_Protocol transport (the
   * `OpenedTransport` returned by `HeadlessTransport.open`) — the
   * MCP server does not open its own. Lifecycle remains owned by
   * `NeuronestCli.main`, which decides whether the transport is
   * shared with other subcommands. The MCP server takes ownership
   * for the duration of `start()` … `stop()`: each MCP tool call
   * funnels through this transport via `createMcpHandlers`, and
   * `stop()` releases it via `transport.close()` (Req 6.12).
   */
  transport: OpenedTransport;
  /**
   * The Onboarding_State_Machine gate consulted by the three
   * mutating handlers (`runSpec`, `runSkill`, `runWorkflow`). The
   * MCP server is agnostic about how the gate refreshes its cached
   * state — it just consults it per request via the handler's
   * `ctx.gate` (Req 6.8, 6.9). Tests inject a deterministic gate;
   * production wires up `createOnboardingGate` from
   * `./onboarding-gate.ts`.
   */
  gate: OnboardingGate;
  /**
   * Optional override for the license auth check (used by tests).
   * Default: a deny-by-default check that always returns
   * `{ ok: false }`. Production wires up `createLicenseCheck` from
   * `./license-check.ts` (Req 6.7).
   */
  licenseCheck?: () => Promise<{ ok: true } | { ok: false; detail: string }>;
}
