//
// Concrete `McpToolHandler` implementations for the seven entries of
// `NEURONEST_MCP_TOOLS`. Each handler is the paper-thin translation
// layer the design § Item 6 mandates:
//
//   1. Validate args against the handler's `argsSchema`; on failure
//      → `{ code: 'invalid_args' }`.
//   2. Call `licenseCheck`; on `{ ok: false }` → `{ code: 'license_invalid' }`.
//      No Headless_Protocol action emitted on this branch (Req 6.7).
//   3. For mutating tools (`runSpec`, `runSkill`, `runWorkflow`):
//      call `gate.isWorkspaceMutationAllowed`; on `false`
//      → `{ code: 'onboarding_incomplete' }`. No Headless_Protocol
//      action emitted on this branch (Req 6.8, 6.9).
//   4. Emit exactly one Headless_Protocol action per the Item 6
//      table — `message` for `runSpec`/`runWorkflow`/`askWorkspace`,
//      read-only `skills.list` / `workflows.list` for the listing
//      tools, agent-loop tool dispatch for `runSkill` (Req 6.3, 6.4,
//      6.5, 6.6, 6.11).
//   5. Await the `completed` event keyed by the same `requestId`,
//      accumulating the `text` / `tool_done` / `error` events that
//      arrive with that requestId.
//   6. Synthesize the MCP response — success on
//      `completed: { success: true }`, otherwise
//      `{ code: 'headless_failed' }` (Req 6.10).
//
// Translation-layer invariant: each handler emits zero or exactly
// one Headless_Protocol action. There is no internal Spec runner,
// Skill runner, Workflow runner, or LLM client (Req 6.11).
//
// Validates: Requirements 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11

import { randomUUID } from 'node:crypto';

import type {
  AskWorkspaceArgs,
  HeadlessAction,
  HeadlessEvent,
  ListSkillsArgs,
  ListSpecsArgs,
  ListWorkflowsArgs,
  McpError,
  McpToolHandler,
  NeuronestMcpTool,
  OnboardingGate,
  OpenedTransport,
  RunSkillArgs,
  RunSpecArgs,
  RunWorkflowArgs,
  SkillListEntry,
  SpecListEntry,
  WorkflowListEntry,
} from './types.js';
import { NEURONEST_MCP_TOOLS } from './types.js';

// ─── License-check contract ─────────────────────────────────────

/**
 * The licence-check thunk shape. Same as
 * `OutboundMcpServerOptions.licenseCheck` so call sites stay
 * drop-in-compatible.
 */
export type LicenseCheck = () => Promise<
  { ok: true } | { ok: false; detail: string }
>;

// ─── Result shapes ──────────────────────────────────────────────
//
// Per-tool result envelopes the handlers return on the `{ ok: true }`
// branch. The OutboundMcpServer wrapper (task 11.5) is responsible for
// translating these into the JSON-RPC `result` shape documented in
// design § G; the handlers themselves stay agnostic of the SDK.

export interface ListSpecsResult {
  specs: ReadonlyArray<SpecListEntry>;
}

export interface RunSpecResult {
  /** Concatenated assistant text emitted during the headless run. */
  text: string;
}

export interface ListSkillsResult {
  skills: ReadonlyArray<SkillListEntry>;
}

export interface RunSkillResult {
  /** The skill's output payload as reported by the agent loop's
   *  `tool_done` event, or the completed event's payload as a
   *  fallback. */
  output: unknown;
}

export interface AskWorkspaceResult {
  /** The accumulated assistant text — the sub-agent's answer. */
  answer: string;
}

export interface ListWorkflowsResult {
  workflows: ReadonlyArray<WorkflowListEntry>;
}

export interface RunWorkflowResult {
  /** Concatenated assistant text emitted during the workflow run. */
  text: string;
}

// ─── Args schemas (JSON Schema fragments) ───────────────────────

const EMPTY_OBJECT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {},
  additionalProperties: false,
}) as object;

const RUN_SPEC_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    specId: { type: 'string', minLength: 1 },
  },
  required: ['specId'],
  additionalProperties: false,
}) as object;

const RUN_SKILL_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    skillId: { type: 'string', minLength: 1 },
    params: {},
  },
  required: ['skillId', 'params'],
  additionalProperties: false,
}) as object;

const ASK_WORKSPACE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    question: { type: 'string', minLength: 1 },
  },
  required: ['question'],
  additionalProperties: false,
}) as object;

const RUN_WORKFLOW_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    workflowId: { type: 'string', minLength: 1 },
    params: {},
  },
  required: ['workflowId', 'params'],
  additionalProperties: false,
}) as object;

// ─── Lightweight runtime arg validators ─────────────────────────
//
// The advertised `argsSchema` is the source of truth for MCP clients
// and the SDK's request-validation layer. The handlers also re-check
// at runtime so the {invalid_args} error branch is observable inside
// this package's tests, independently of any SDK glue.

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; detail: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateEmpty(args: unknown): ValidationResult<Record<string, never>> {
  if (args === undefined || args === null) {
    return { ok: true, value: {} as Record<string, never> };
  }
  if (!isPlainObject(args)) {
    return { ok: false, detail: 'args must be an object or omitted' };
  }
  if (Object.keys(args).length > 0) {
    return {
      ok: false,
      detail: `unexpected properties: ${Object.keys(args).join(', ')}`,
    };
  }
  return { ok: true, value: {} as Record<string, never> };
}

function validateRunSpec(args: unknown): ValidationResult<RunSpecArgs> {
  if (!isPlainObject(args)) {
    return { ok: false, detail: 'args must be an object' };
  }
  const specId = args['specId'];
  if (typeof specId !== 'string' || specId.length === 0) {
    return { ok: false, detail: 'specId must be a non-empty string' };
  }
  return { ok: true, value: { specId } };
}

function validateRunSkill(args: unknown): ValidationResult<RunSkillArgs> {
  if (!isPlainObject(args)) {
    return { ok: false, detail: 'args must be an object' };
  }
  const skillId = args['skillId'];
  if (typeof skillId !== 'string' || skillId.length === 0) {
    return { ok: false, detail: 'skillId must be a non-empty string' };
  }
  if (!('params' in args)) {
    return { ok: false, detail: 'params is required' };
  }
  return { ok: true, value: { skillId, params: args['params'] } };
}

function validateAskWorkspace(
  args: unknown,
): ValidationResult<AskWorkspaceArgs> {
  if (!isPlainObject(args)) {
    return { ok: false, detail: 'args must be an object' };
  }
  const question = args['question'];
  if (typeof question !== 'string' || question.length === 0) {
    return { ok: false, detail: 'question must be a non-empty string' };
  }
  return { ok: true, value: { question } };
}

function validateRunWorkflow(
  args: unknown,
): ValidationResult<RunWorkflowArgs> {
  if (!isPlainObject(args)) {
    return { ok: false, detail: 'args must be an object' };
  }
  const workflowId = args['workflowId'];
  if (typeof workflowId !== 'string' || workflowId.length === 0) {
    return { ok: false, detail: 'workflowId must be a non-empty string' };
  }
  if (!('params' in args)) {
    return { ok: false, detail: 'params is required' };
  }
  return { ok: true, value: { workflowId, params: args['params'] } };
}

// ─── Headless_Protocol "send and await completed" helper ────────

/**
 * The discriminated outcome of a single send/await cycle against the
 * Headless_Protocol transport. The MCP handlers translate this into
 * the per-tool `Result` envelope on success and a `headless_failed`
 * MCP error on every failure variant.
 */
export interface HeadlessActionOutcome {
  /** All `text` events received with the matching requestId, in
   *  arrival order. The handlers concatenate these for `runSpec` /
   *  `askWorkspace` / `runWorkflow` results. */
  texts: ReadonlyArray<string>;
  /** All `tool_done` events received with the matching requestId.
   *  Handlers use the most recent entry's `output` for `runSkill`. */
  toolDones: ReadonlyArray<HeadlessEvent>;
  /** All `error` events received with the matching requestId. */
  errors: ReadonlyArray<HeadlessEvent>;
  /** The terminal `completed` event. Absent when the stream ended
   *  without one (treated as headless failure). */
  completed?: HeadlessEvent;
  /** Whether the cycle reached a terminal `completed: { success: true }`
   *  event. */
  succeeded: boolean;
  /** Human-readable summary of the failure mode when `succeeded`
   *  is false. */
  failureDetail?: string;
}

/**
 * Generate the requestId stamped onto an outbound action and onto the
 * events the desktop side echoes back. Defaults to `crypto.randomUUID()`;
 * pinned by tests via `createMcpHandlers({ ..., requestIdGenerator })`.
 */
export type RequestIdGenerator = () => string;

const defaultRequestIdGenerator: RequestIdGenerator = () => randomUUID();

/**
 * Send `action` (with a freshly minted `requestId`) onto the transport
 * and read back the matching `completed` event, accumulating the
 * `text`/`tool_done`/`error` events that share the same requestId.
 *
 * Hard invariants:
 *   - Exactly one `transport.send` call per invocation (translation-
 *     layer invariant — Req 6.11).
 *   - Events with a different requestId are forwarded back into the
 *     event sink (when one is supplied) so concurrent in-flight
 *     handlers can each receive their own events. When no sink is
 *     supplied the helper just iterates linearly — adequate for the
 *     unit tests that drive one handler at a time.
 *   - Stream end without a `completed` event resolves with
 *     `succeeded: false` and a structured `failureDetail`.
 *
 * The helper does NOT return Promise rejection on Headless_Protocol
 * failure — the structured outcome is the single resolution path so
 * the handler can synthesise a `headless_failed` MCP error without a
 * try/catch tower.
 */
export async function sendAndAwaitCompleted(
  transport: OpenedTransport,
  action: HeadlessAction,
  opts: {
    requestIdGenerator?: RequestIdGenerator;
    /** Optional callback invoked for events that do NOT match the
     *  request's `requestId` — used by the OutboundMcpServer (task
     *  11.5) to multiplex a single shared events iterator across
     *  concurrent in-flight handlers. */
    onForeignEvent?: (event: HeadlessEvent) => void;
  } = {},
): Promise<HeadlessActionOutcome> {
  const generate = opts.requestIdGenerator ?? defaultRequestIdGenerator;
  const requestId = generate();

  const texts: string[] = [];
  const toolDones: HeadlessEvent[] = [];
  const errors: HeadlessEvent[] = [];

  // Emit the single Headless_Protocol action — exactly one send per
  // handler invocation (Req 6.11).
  try {
    transport.send({ ...action, requestId });
  } catch (err) {
    return {
      texts,
      toolDones,
      errors,
      succeeded: false,
      failureDetail: `transport.send threw: ${(err as Error).message}`,
    };
  }

  // Iterate the events stream. The first `completed` event with a
  // matching requestId terminates the loop; events for other
  // requestIds are forwarded to `onForeignEvent` (or simply ignored
  // when the caller hasn't registered one).
  try {
    for await (const event of transport.events) {
      const eventRequestId = (event as { requestId?: unknown }).requestId;

      if (eventRequestId !== requestId) {
        opts.onForeignEvent?.(event);
        continue;
      }

      switch (event.type) {
        case 'text': {
          const text = (event as { text?: unknown }).text;
          if (typeof text === 'string') {
            texts.push(text);
          }
          break;
        }
        case 'tool_done': {
          toolDones.push(event);
          break;
        }
        case 'error': {
          errors.push(event);
          break;
        }
        case 'completed': {
          const success = Boolean(
            (event as { success?: unknown }).success,
          );
          const outcome: HeadlessActionOutcome = {
            texts,
            toolDones,
            errors,
            completed: event,
            succeeded: success,
          };
          if (!success) {
            outcome.failureDetail = describeCompletedFailure(event, errors);
          }
          return outcome;
        }
        default:
          // Unknown event types for the active requestId are ignored
          // — the protocol may grow new event kinds, and the handler
          // only cares about the four listed above.
          break;
      }
    }
  } catch (err) {
    return {
      texts,
      toolDones,
      errors,
      succeeded: false,
      failureDetail: `transport disconnect mid-call: ${
        (err as Error).message
      }`,
    };
  }

  // Stream ended without a `completed` event — treat as headless
  // failure (Req 6.10).
  return {
    texts,
    toolDones,
    errors,
    succeeded: false,
    failureDetail:
      errors.length > 0
        ? `headless emitted error without completed: ${describeError(errors[0]!)}`
        : 'headless stream ended without completed event',
  };
}

function describeCompletedFailure(
  event: HeadlessEvent,
  errors: ReadonlyArray<HeadlessEvent>,
): string {
  const detail = (event as { detail?: unknown }).detail;
  if (typeof detail === 'string' && detail.length > 0) {
    return `completed: success=false (${detail})`;
  }
  if (errors.length > 0) {
    return `completed: success=false (${describeError(errors[0]!)})`;
  }
  return 'completed: success=false';
}

function describeError(event: HeadlessEvent): string {
  const detail = (event as { detail?: unknown }).detail;
  if (typeof detail === 'string' && detail.length > 0) return detail;
  const message = (event as { message?: unknown }).message;
  if (typeof message === 'string' && message.length > 0) return message;
  return 'unknown headless error';
}

// ─── Shared gate / license boilerplate ──────────────────────────

async function ensureLicensed(
  licenseCheck: LicenseCheck,
): Promise<{ ok: true } | { ok: false; error: McpError }> {
  const result = await licenseCheck();
  if (result.ok) return { ok: true };
  return {
    ok: false,
    error: {
      code: 'license_invalid',
      message: result.detail,
    },
  };
}

async function ensureMutationAllowed(
  gate: OnboardingGate,
): Promise<{ ok: true } | { ok: false; error: McpError }> {
  const allowed = await gate.isWorkspaceMutationAllowed();
  if (allowed) return { ok: true };
  const state = await gate.currentState();
  return {
    ok: false,
    error: {
      code: 'onboarding_incomplete',
      message:
        `workspace mutation forbidden in onboarding state '${String(state)}'`,
    },
  };
}

function headlessFailed(detail: string | undefined): McpError {
  return {
    code: 'headless_failed',
    message: detail ?? 'headless action failed',
  };
}

function invalidArgs(detail: string): McpError {
  return { code: 'invalid_args', message: detail };
}

// ─── Result extraction helpers ──────────────────────────────────

/**
 * Pull a structured payload off the completed event. The Phase 3
 * Headless_Protocol envelope is locked to `protocol_version: 1`; the
 * concrete payload key is documented as `payload` in design § Item 6
 * but other shapes (e.g. `result`, `data`) are tolerated to keep the
 * handler resilient against minor wire changes.
 */
function extractPayload(event: HeadlessEvent | undefined): unknown {
  if (event === undefined) return undefined;
  const e = event as Record<string, unknown>;
  if ('payload' in e) return e['payload'];
  if ('result' in e) return e['result'];
  if ('data' in e) return e['data'];
  return undefined;
}

function extractListEntries<T>(
  outcome: HeadlessActionOutcome,
  key: string,
): ReadonlyArray<T> | undefined {
  // Preferred: completed event's payload.
  const payload = extractPayload(outcome.completed);
  if (isPlainObject(payload) && Array.isArray(payload[key])) {
    return payload[key] as ReadonlyArray<T>;
  }
  // Fallback: the most recent tool_done event's output.
  for (let i = outcome.toolDones.length - 1; i >= 0; i--) {
    const td = outcome.toolDones[i] as Record<string, unknown>;
    const output = td['output'];
    if (isPlainObject(output) && Array.isArray(output[key])) {
      return output[key] as ReadonlyArray<T>;
    }
    if (Array.isArray(output)) {
      return output as ReadonlyArray<T>;
    }
  }
  return undefined;
}

function extractToolOutput(outcome: HeadlessActionOutcome): unknown {
  // Preferred: most recent tool_done event's output.
  if (outcome.toolDones.length > 0) {
    const td = outcome.toolDones[outcome.toolDones.length - 1] as Record<
      string,
      unknown
    >;
    if ('output' in td) return td['output'];
  }
  // Fallback: completed event's payload.
  return extractPayload(outcome.completed);
}

// ─── Handler factory ────────────────────────────────────────────

/**
 * The full set of seven `McpToolHandler` instances, keyed by their
 * `NeuronestMcpTool` name. The keyed shape lets the OutboundMcpServer
 * wire `tools/list` and `tools/call` dispatch directly off this
 * record without a second lookup table.
 *
 * The `licenseCheck` is bound at construction time (per the task
 * hint) — it isn't part of the runtime `ctx` because the gate and
 * transport are per-request while the licence check is an
 * options-level dependency on the OutboundMcpServer.
 */
export type NeuronestMcpHandlers = {
  readonly [Tool in NeuronestMcpTool]: McpToolHandler<unknown, unknown>;
};

/** Construction-time options for `createMcpHandlers`. */
export interface CreateMcpHandlersOptions {
  /** Optional override for the requestId generator (used by tests so
   *  the wire shape is deterministic). Defaults to
   *  `crypto.randomUUID`. */
  requestIdGenerator?: RequestIdGenerator;
  /** Optional foreign-event sink — wired by the OutboundMcpServer
   *  (task 11.5) to multiplex a single shared events iterator across
   *  concurrent in-flight handlers. */
  onForeignEvent?: (event: HeadlessEvent) => void;
}

/**
 * Build the seven MCP tool handlers with `licenseCheck` bound. The
 * returned record is `Object.freeze`d so the server can't accidentally
 * swap a handler at runtime.
 */
export function createMcpHandlers(
  licenseCheck: LicenseCheck,
  opts: CreateMcpHandlersOptions = {},
): NeuronestMcpHandlers {
  // Helper that wraps `sendAndAwaitCompleted` with the construction-
  // time generator and foreign-event sink. Each handler builds its
  // action, then funnels through this single function so the
  // translation-layer invariant (one send per handler) is enforced
  // structurally.
  const dispatchOpts: {
    requestIdGenerator?: RequestIdGenerator;
    onForeignEvent?: (event: HeadlessEvent) => void;
  } = {};
  if (opts.requestIdGenerator !== undefined) {
    dispatchOpts.requestIdGenerator = opts.requestIdGenerator;
  }
  if (opts.onForeignEvent !== undefined) {
    dispatchOpts.onForeignEvent = opts.onForeignEvent;
  }
  const dispatch = (
    transport: OpenedTransport,
    action: HeadlessAction,
  ): Promise<HeadlessActionOutcome> =>
    sendAndAwaitCompleted(transport, action, dispatchOpts);

  // ── Non-mutating handlers ─────────────────────────────────────

  const listSpecs: McpToolHandler<ListSpecsArgs, ListSpecsResult> = {
    name: 'neuronest:listSpecs',
    argsSchema: EMPTY_OBJECT_SCHEMA,
    async execute(args, ctx) {
      const argsCheck = validateEmpty(args);
      if (!argsCheck.ok) {
        return { ok: false, error: invalidArgs(argsCheck.detail) };
      }
      const lic = await ensureLicensed(licenseCheck);
      if (!lic.ok) return { ok: false, error: lic.error };

      const outcome = await dispatch(ctx.transport, {
        type: 'message',
        text: 'list specs',
      });
      if (!outcome.succeeded) {
        return { ok: false, error: headlessFailed(outcome.failureDetail) };
      }
      const specs = extractListEntries<SpecListEntry>(outcome, 'specs') ?? [];
      return { ok: true, result: { specs } };
    },
  };

  const listSkills: McpToolHandler<ListSkillsArgs, ListSkillsResult> = {
    name: 'neuronest:listSkills',
    argsSchema: EMPTY_OBJECT_SCHEMA,
    async execute(args, ctx) {
      const argsCheck = validateEmpty(args);
      if (!argsCheck.ok) {
        return { ok: false, error: invalidArgs(argsCheck.detail) };
      }
      const lic = await ensureLicensed(licenseCheck);
      if (!lic.ok) return { ok: false, error: lic.error };

      // Read-only `skills.list` action — Phase 3 protocol extension
      // for the listing endpoint (design § Item 6 table).
      const outcome = await dispatch(ctx.transport, {
        type: 'skills.list',
      });
      if (!outcome.succeeded) {
        return { ok: false, error: headlessFailed(outcome.failureDetail) };
      }
      const skills =
        extractListEntries<SkillListEntry>(outcome, 'skills') ?? [];
      return { ok: true, result: { skills } };
    },
  };

  const askWorkspace: McpToolHandler<AskWorkspaceArgs, AskWorkspaceResult> = {
    name: 'neuronest:askWorkspace',
    argsSchema: ASK_WORKSPACE_SCHEMA,
    async execute(args, ctx) {
      const argsCheck = validateAskWorkspace(args);
      if (!argsCheck.ok) {
        return { ok: false, error: invalidArgs(argsCheck.detail) };
      }
      const lic = await ensureLicensed(licenseCheck);
      if (!lic.ok) return { ok: false, error: lic.error };

      // Reuses Item 2 — the desktop side dispatches /ask through the
      // chat-message handler, which short-circuits into the
      // AskSubAgent.
      const outcome = await dispatch(ctx.transport, {
        type: 'message',
        text: `/ask ${argsCheck.value.question}`,
      });
      if (!outcome.succeeded) {
        return { ok: false, error: headlessFailed(outcome.failureDetail) };
      }
      return { ok: true, result: { answer: outcome.texts.join('') } };
    },
  };

  const listWorkflows: McpToolHandler<
    ListWorkflowsArgs,
    ListWorkflowsResult
  > = {
    name: 'neuronest:listWorkflows',
    argsSchema: EMPTY_OBJECT_SCHEMA,
    async execute(args, ctx) {
      const argsCheck = validateEmpty(args);
      if (!argsCheck.ok) {
        return { ok: false, error: invalidArgs(argsCheck.detail) };
      }
      const lic = await ensureLicensed(licenseCheck);
      if (!lic.ok) return { ok: false, error: lic.error };

      const outcome = await dispatch(ctx.transport, {
        type: 'workflows.list',
      });
      if (!outcome.succeeded) {
        return { ok: false, error: headlessFailed(outcome.failureDetail) };
      }
      const workflows =
        extractListEntries<WorkflowListEntry>(outcome, 'workflows') ?? [];
      return { ok: true, result: { workflows } };
    },
  };

  // ── Mutating handlers (consult the onboarding gate) ──────────

  const runSpec: McpToolHandler<RunSpecArgs, RunSpecResult> = {
    name: 'neuronest:runSpec',
    argsSchema: RUN_SPEC_SCHEMA,
    async execute(args, ctx) {
      const argsCheck = validateRunSpec(args);
      if (!argsCheck.ok) {
        return { ok: false, error: invalidArgs(argsCheck.detail) };
      }
      const lic = await ensureLicensed(licenseCheck);
      if (!lic.ok) return { ok: false, error: lic.error };
      const gate = await ensureMutationAllowed(ctx.gate);
      if (!gate.ok) return { ok: false, error: gate.error };

      const outcome = await dispatch(ctx.transport, {
        type: 'message',
        text: `Run spec ${argsCheck.value.specId}`,
      });
      if (!outcome.succeeded) {
        return { ok: false, error: headlessFailed(outcome.failureDetail) };
      }
      return { ok: true, result: { text: outcome.texts.join('') } };
    },
  };

  const runSkill: McpToolHandler<RunSkillArgs, RunSkillResult> = {
    name: 'neuronest:runSkill',
    argsSchema: RUN_SKILL_SCHEMA,
    async execute(args, ctx) {
      const argsCheck = validateRunSkill(args);
      if (!argsCheck.ok) {
        return { ok: false, error: invalidArgs(argsCheck.detail) };
      }
      const lic = await ensureLicensed(licenseCheck);
      if (!lic.ok) return { ok: false, error: lic.error };
      const gate = await ensureMutationAllowed(ctx.gate);
      if (!gate.ok) return { ok: false, error: gate.error };

      // Tool-execution dispatch via the agent loop — design § Item 6
      // table. The desktop side resolves `skillId` against its
      // Skill_Registry and runs the skill with the supplied params.
      const outcome = await dispatch(ctx.transport, {
        type: 'tool_call',
        tool: argsCheck.value.skillId,
        params: argsCheck.value.params,
      });
      if (!outcome.succeeded) {
        return { ok: false, error: headlessFailed(outcome.failureDetail) };
      }
      return { ok: true, result: { output: extractToolOutput(outcome) } };
    },
  };

  const runWorkflow: McpToolHandler<RunWorkflowArgs, RunWorkflowResult> = {
    name: 'neuronest:runWorkflow',
    argsSchema: RUN_WORKFLOW_SCHEMA,
    async execute(args, ctx) {
      const argsCheck = validateRunWorkflow(args);
      if (!argsCheck.ok) {
        return { ok: false, error: invalidArgs(argsCheck.detail) };
      }
      const lic = await ensureLicensed(licenseCheck);
      if (!lic.ok) return { ok: false, error: lic.error };
      const gate = await ensureMutationAllowed(ctx.gate);
      if (!gate.ok) return { ok: false, error: gate.error };

      // The desktop-side message handler routes "Run workflow ..."
      // through the agent loop, which invokes the
      // `runPackagedWorkflow` tool against the Workflow_Registry.
      const params = argsCheck.value.params;
      const paramsJson = JSON.stringify(params ?? {});
      const outcome = await dispatch(ctx.transport, {
        type: 'message',
        text: `Run workflow ${argsCheck.value.workflowId} with params ${paramsJson}`,
      });
      if (!outcome.succeeded) {
        return { ok: false, error: headlessFailed(outcome.failureDetail) };
      }
      return { ok: true, result: { text: outcome.texts.join('') } };
    },
  };

  // ── Frozen record keyed by NeuronestMcpTool ──────────────────

  const handlers: NeuronestMcpHandlers = {
    'neuronest:listSpecs': listSpecs as McpToolHandler<unknown, unknown>,
    'neuronest:runSpec': runSpec as McpToolHandler<unknown, unknown>,
    'neuronest:listSkills': listSkills as McpToolHandler<unknown, unknown>,
    'neuronest:runSkill': runSkill as McpToolHandler<unknown, unknown>,
    'neuronest:askWorkspace': askWorkspace as McpToolHandler<
      unknown,
      unknown
    >,
    'neuronest:listWorkflows': listWorkflows as McpToolHandler<
      unknown,
      unknown
    >,
    'neuronest:runWorkflow': runWorkflow as McpToolHandler<unknown, unknown>,
  };

  // Sanity check — every NEURONEST_MCP_TOOLS entry has a registered
  // handler. The cast above is the single point where the per-tool
  // typed handlers are widened to the heterogeneous `unknown,unknown`
  // record shape.
  for (const tool of NEURONEST_MCP_TOOLS) {
    if (!(tool in handlers)) {
      throw new Error(`createMcpHandlers: missing handler for ${tool}`);
    }
  }

  return Object.freeze(handlers);
}
