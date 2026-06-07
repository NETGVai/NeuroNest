// File: packages/neuronest-cli/src/cli/subcommands.ts
//
// Subcommand wrappers for the `neuronest` binary. Each member of
// `CliSubcommands` is a thin adapter from a typed argv shape (see
// ./types.ts) to a `Promise<CliExitCode>`. The adapters are kept
// dispatch-shaped (no yargs imports here) so `main.ts` can wire them
// up under `yargs(...).strict()` without coupling the wrappers to the
// argument parser.
//
// Hard invariants:
//
//   `sync` (task 9.3):
//     - Operates entirely against the local filesystem (Req 5.3, 5.8
//       carve-out). Does NOT receive an OpenedTransport.
//     - Resolves the workspace root by walking up from `process.cwd()`
//       looking for a `.kiro/` directory; if none is found up to the
//       filesystem root, treats `process.cwd()` as the workspace root.
//     - Delegates to `SyncCli.run`; on `{ ok: true }` returns 0, on
//       `{ ok: false }` prints the structured error to stderr and
//       returns 1.
//
//   `run` / `skills` / `agent` (task 9.4):
//     - Each receives an already-opened `OpenedTransport`. The
//       probe-then-spawn open-call sequencing is performed by
//       `NeuronestCli.main` (task 9.5) BEFORE delegating to these
//       wrappers; this matches the carve-out documented on the
//       `simulateMainDispatch` helper of the Property 11 fallback test.
//     - Each issues exactly one Headless_Protocol action stamped with
//       a fresh requestId, then iterates the transport's events
//       stream until a terminal `completed` event arrives whose
//       requestId matches.
//     - `text` events with the matching requestId stream to stdout
//       (Req 5.4, 5.6); `error` events stream to stderr (Req 5.4).
//       `tool_done` payloads are accumulated for the listing tools.
//     - Exit codes: 0 on `completed: { success: true }`, 1 otherwise
//       (transport disconnect, headless error without completed,
//       `completed: { success: false }`, send threw, …).
//
//   `mcp` (task 11.6):
//     - Receives an already-opened `OpenedTransport`. Hands the
//       transport off to `OutboundMcpServer` and starts the server.
//     - Builds an `OnboardingGate` and a license-check thunk against
//       stub banner readers — Phase 3's banner-refresh action is the
//       hook these stubs will swap for once it lands.
//     - Blocks until `SIGINT` or `SIGTERM` arrives; on signal calls
//       `server.stop()` (drains in-flight handlers, releases the
//       Headless_Protocol transport — Req 6.12) and resolves with
//       exit code 0.
//     - The CLI itself does NOT round-trip through the
//       Headless_Protocol — only `OutboundMcpServer` drives the
//       transport per request (Req 6.11).
//
// Validates: Requirements 5.3, 5.4, 5.5, 5.6, 5.7, 6.1, 6.12.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { SyncCli } from '../sync/sync-cli.js';
import type { SyncError } from '../sync/types.js';
import type {
  HeadlessAction,
  HeadlessEvent,
  OpenedTransport,
} from '../transport/headless-transport.js';
import {
  createOnboardingGate,
  type BannerReader as OnboardingBannerReader,
} from '../mcp/onboarding-gate.js';
import {
  createLicenseCheck,
  type BannerReader as LicenseBannerReader,
} from '../mcp/license-check.js';
import { createOutboundMcpServer } from '../mcp/outbound-mcp-server.js';

import type {
  AgentArgv,
  CliExitCode,
  McpArgv,
  RunArgv,
  SkillsArgv,
  SyncArgv,
} from './types.js';

// --------------------------------------------------------------------------
// Workspace-root resolution (used by `sync`)
// --------------------------------------------------------------------------

/**
 * Walk up from `startDir` looking for a `.kiro/` directory. Returns
 * the first ancestor (including `startDir` itself) that contains a
 * `.kiro/` directory. If the filesystem root is reached without finding
 * one, returns `startDir` itself — `SyncCli.run` then validates that
 * `startDir` is a directory and emits a structured error if not.
 *
 * Pure synchronous filesystem reads — `.kiro/` lookup is cheap and the
 * loop bounded by directory depth. Uses `node:path` + `node:fs` only.
 *
 * Exported for tests; the production call site below uses
 * `process.cwd()` as `startDir`.
 */
export function resolveWorkspaceRoot(startDir: string): string {
  const start = path.resolve(startDir);
  let current = start;

  // Bound the walk by directory depth — `path.dirname` of the
  // filesystem root returns the root itself, so the loop terminates
  // when `parent === current`.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const kiroPath = path.join(current, '.kiro');
    try {
      const st = fs.statSync(kiroPath);
      if (st.isDirectory()) {
        return current;
      }
    } catch {
      // `.kiro/` not present at `current`; continue walking up.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      // Reached the filesystem root without finding a `.kiro/` dir.
      return start;
    }
    current = parent;
  }
}

// --------------------------------------------------------------------------
// Headless_Protocol streaming helper (used by `run` / `skills` / `agent`)
// --------------------------------------------------------------------------

/** Generator for the `requestId` stamped onto outbound actions. */
export type RequestIdGenerator = () => string;

const defaultRequestIdGenerator: RequestIdGenerator = () => randomUUID();

/** Outcome shape returned by `streamHeadlessAction`. */
interface StreamOutcome {
  /** True iff a terminal `completed` event with `success === true`
   *  arrived for the matching requestId. */
  succeeded: boolean;
  /** The terminal `completed` event, when one arrived. */
  completed?: HeadlessEvent;
  /** Human-readable failure detail when `succeeded === false`. */
  failureDetail?: string;
  /** All `text` events received with the matching requestId, in
   *  arrival order. */
  texts: ReadonlyArray<string>;
  /** All `tool_done` events received with the matching requestId. */
  toolDones: ReadonlyArray<HeadlessEvent>;
  /** All `error` events received with the matching requestId. */
  errors: ReadonlyArray<HeadlessEvent>;
}

/**
 * Send `action` (with a fresh `requestId`) onto the transport and
 * iterate the events stream until a `completed` event with the same
 * requestId arrives. Per-event callbacks let callers stream text and
 * error output progressively (used by `run` and `agent`); the listing
 * subcommands omit the callbacks and just inspect the accumulated
 * arrays at the end.
 *
 * Hard invariants:
 *   - Exactly one `transport.send` call per invocation. There is no
 *     retry path — a `transport.send` exception resolves the outcome
 *     to `succeeded: false` immediately.
 *   - Events whose `requestId` does not match the dispatched action
 *     are ignored. Tools that need to multiplex foreign events route
 *     them via the MCP server's `onForeignEvent` hook (handlers.ts);
 *     the CLI subcommands hold the transport exclusively for the
 *     duration of the call, so foreign events would only appear if
 *     the desktop side is replaying a previous session — at which
 *     point dropping them is the correct stance.
 *   - Stream end without a `completed` event resolves with
 *     `succeeded: false` and a structured `failureDetail`.
 */
async function streamHeadlessAction(
  transport: OpenedTransport,
  action: HeadlessAction,
  opts: {
    onText?: (text: string) => void;
    onError?: (detail: string) => void;
    requestIdGenerator?: RequestIdGenerator;
  } = {},
): Promise<StreamOutcome> {
  const generate = opts.requestIdGenerator ?? defaultRequestIdGenerator;
  const requestId = generate();

  const texts: string[] = [];
  const toolDones: HeadlessEvent[] = [];
  const errors: HeadlessEvent[] = [];

  // Stamp the action with the requestId. Spread is used so a caller
  // that already supplied a `requestId` field has theirs overwritten;
  // every dispatched action's requestId is owned by this helper.
  try {
    transport.send({ ...action, requestId });
  } catch (err) {
    return {
      succeeded: false,
      failureDetail: `transport.send threw: ${(err as Error).message}`,
      texts,
      toolDones,
      errors,
    };
  }

  try {
    for await (const event of transport.events) {
      const eventRequestId = (event as { requestId?: unknown }).requestId;
      if (eventRequestId !== requestId) {
        // Foreign event — drop. (See helper-doc invariant 2.)
        continue;
      }

      switch (event.type) {
        case 'text': {
          const text = (event as { text?: unknown }).text;
          if (typeof text === 'string') {
            texts.push(text);
            opts.onText?.(text);
          }
          break;
        }
        case 'tool_done': {
          toolDones.push(event);
          break;
        }
        case 'error': {
          errors.push(event);
          opts.onError?.(describeErrorDetail(event));
          break;
        }
        case 'completed': {
          const success = Boolean((event as { success?: unknown }).success);
          const outcome: StreamOutcome = {
            succeeded: success,
            completed: event,
            texts,
            toolDones,
            errors,
          };
          if (!success) {
            outcome.failureDetail = describeCompletedFailure(event, errors);
          }
          return outcome;
        }
        default:
          // Unknown event types for the active requestId are ignored —
          // the protocol may grow new event kinds and the CLI only
          // cares about the four documented above.
          break;
      }
    }
  } catch (err) {
    return {
      succeeded: false,
      failureDetail: `transport disconnect mid-call: ${
        (err as Error).message
      }`,
      texts,
      toolDones,
      errors,
    };
  }

  // Stream ended without a `completed` event — treat as failure.
  return {
    succeeded: false,
    failureDetail:
      errors.length > 0
        ? `headless emitted error without completed: ${describeErrorDetail(
            errors[0]!,
          )}`
        : 'headless stream ended without completed event',
    texts,
    toolDones,
    errors,
  };
}

function describeErrorDetail(event: HeadlessEvent): string {
  const detail = (event as { detail?: unknown }).detail;
  if (typeof detail === 'string' && detail.length > 0) return detail;
  const message = (event as { message?: unknown }).message;
  if (typeof message === 'string' && message.length > 0) return message;
  return 'unknown headless error';
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
    return `completed: success=false (${describeErrorDetail(errors[0]!)})`;
  }
  return 'completed: success=false';
}

// --------------------------------------------------------------------------
// `skills.list` payload extraction
// --------------------------------------------------------------------------

/** Minimal shape of one skills.list entry. The wire format may use
 *  `id` or `skillId` — we accept either to stay resilient against
 *  small protocol variations between the desktop side and a spawned
 *  headless instance. */
interface SkillsListEntry {
  readonly id?: unknown;
  readonly skillId?: unknown;
  readonly description?: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function extractSkillsList(
  outcome: StreamOutcome,
): ReadonlyArray<SkillsListEntry> {
  // Preferred: completed event's payload.
  const completed = outcome.completed;
  if (completed !== undefined) {
    const e = completed as Record<string, unknown>;
    for (const key of ['payload', 'result', 'data'] as const) {
      const candidate = e[key];
      if (
        isPlainObject(candidate) &&
        Array.isArray((candidate as Record<string, unknown>)['skills'])
      ) {
        return (candidate as Record<string, unknown>)[
          'skills'
        ] as ReadonlyArray<SkillsListEntry>;
      }
    }
  }
  // Fallback: most recent tool_done event's output.
  for (let i = outcome.toolDones.length - 1; i >= 0; i--) {
    const td = outcome.toolDones[i] as Record<string, unknown>;
    const output = td['output'];
    if (
      isPlainObject(output) &&
      Array.isArray(output['skills'])
    ) {
      return output['skills'] as ReadonlyArray<SkillsListEntry>;
    }
    if (Array.isArray(output)) {
      return output as ReadonlyArray<SkillsListEntry>;
    }
  }
  return [];
}

function entryDisplayId(entry: SkillsListEntry): string {
  if (typeof entry.skillId === 'string' && entry.skillId.length > 0) {
    return entry.skillId;
  }
  if (typeof entry.id === 'string' && entry.id.length > 0) {
    return entry.id;
  }
  return '';
}

function entryDescription(entry: SkillsListEntry): string {
  if (typeof entry.description === 'string') return entry.description;
  return '';
}

// --------------------------------------------------------------------------
// `sync` error formatting
// --------------------------------------------------------------------------

/**
 * Format a `SyncError` envelope as a single human-readable line for
 * stderr. Stable formatting so two consecutive runs against the same
 * filesystem state produce identical stderr output.
 */
function formatSyncError(error: SyncError): string {
  switch (error.kind) {
    case 'workspace_root_invalid':
      return `error: workspace_root_invalid: ${error.detail}`;
    case 'fs_write_failed':
      return `error: fs_write_failed at ${error.path}: ${error.detail}`;
    case 'no_skills_found':
      return 'error: no_skills_found';
  }
}

// --------------------------------------------------------------------------
// Public surface
// --------------------------------------------------------------------------

/**
 * Subcommand wrappers consumed by `NeuronestCli.main`. Each member
 * accepts a typed argv shape (defined in `./types.ts`) and resolves to
 * a `CliExitCode`. The non-`sync` wrappers also accept a pre-opened
 * `OpenedTransport` — the probe-then-spawn open-call sequencing is
 * performed at the `NeuronestCli.main` layer (task 9.5).
 *
 * `mcp` is the long-lived subcommand: it does not return until a
 * `SIGINT` or `SIGTERM` arrives (task 11.6). Every other subcommand
 * resolves once its single Headless_Protocol round-trip completes.
 */
export interface CliSubcommandsApi {
  /**
   * Implements `neuronest sync`. Resolves the workspace root by
   * walking up from `process.cwd()` looking for a `.kiro/` directory,
   * delegates to `SyncCli.run`, and translates the result envelope
   * into a process exit code.
   *
   * Does NOT receive an `OpenedTransport` — sync is the sole
   * subcommand that operates entirely against the local filesystem
   * (Req 5.8 carve-out). The `argv` parameter is accepted for shape-
   * parity with the other subcommand handlers but carries no payload
   * (the `SyncArgv` discriminator is the literal `{ _: ['sync'] }`).
   */
  sync(argv: SyncArgv): Promise<CliExitCode>;

  /**
   * Implements `neuronest run <specId>`. Sends a single `message`
   * action `'Run spec ${specId}'` onto the transport, streams `text`
   * events to stdout, `error` events to stderr, and exits 0 on
   * `completed: { success: true }`, 1 otherwise (Req 5.4).
   */
  run(argv: RunArgv, transport: OpenedTransport): Promise<CliExitCode>;

  /**
   * Implements `neuronest skills list`. Sends a single `skills.list`
   * action onto the transport, awaits the terminal `completed` event,
   * extracts the skills array from either the completed event's
   * payload or the trailing `tool_done` event, and prints
   * `${id}\t${description}` per skill to stdout. Exits 0 on success,
   * 1 on Headless_Protocol failure (Req 5.5).
   */
  skills(argv: SkillsArgv, transport: OpenedTransport): Promise<CliExitCode>;

  /**
   * Implements `neuronest agent <prompt>`. Sends a single `message`
   * action with the prompt (already joined by `main.ts` with single
   * spaces between positionals — Req 5.6) and streams `text` events
   * to stdout. Exits 0 on `completed: { success: true }`, 1 otherwise.
   */
  agent(argv: AgentArgv, transport: OpenedTransport): Promise<CliExitCode>;

  /**
   * Implements `neuronest mcp`. Instantiates the `OutboundMcpServer`
   * with the pre-opened Headless_Protocol transport and starts it,
   * then blocks until a `SIGINT` or `SIGTERM` is delivered to the
   * process (Req 5.7, 6.1, 6.12). On shutdown signal the server's
   * graceful `stop()` runs (drains in-flight handlers, closes the
   * MCP SDK transport, releases the headless transport), and the
   * subcommand resolves with exit code 0.
   *
   * The CLI itself does NOT round-trip through Headless_Protocol —
   * only the `OutboundMcpServer` drives the transport per request.
   * This wrapper just owns the pre-opened transport's handoff and
   * the lifetime of the server.
   */
  mcp(argv: McpArgv, transport: OpenedTransport): Promise<CliExitCode>;
}

/**
 * Frozen instance implementing `CliSubcommandsApi`. Freezing prevents
 * downstream callers from monkey-patching individual subcommand
 * dispatchers — each entry is locked to its task-9.3 / 9.4 / 11.6
 * implementation.
 */
export const CliSubcommands: CliSubcommandsApi = Object.freeze({
  async sync(_argv: SyncArgv): Promise<CliExitCode> {
    const workspaceRoot = resolveWorkspaceRoot(process.cwd());

    const result = await SyncCli.run({ workspaceRoot });
    if (result.ok) {
      return 0;
    }

    process.stderr.write(`${formatSyncError(result.error)}\n`);
    return 1;
  },

  async run(
    argv: RunArgv,
    transport: OpenedTransport,
  ): Promise<CliExitCode> {
    // `argv._` is the literal tuple `['run', specId]`; `main.ts` is
    // responsible for asserting the positional shape under yargs's
    // strict mode. We re-validate here so a rogue caller that
    // bypasses main can't NaN out the wrapper.
    const specId = argv._[1];
    if (typeof specId !== 'string' || specId.length === 0) {
      process.stderr.write('error: run: missing specId\n');
      return 1;
    }

    const outcome = await streamHeadlessAction(
      transport,
      { type: 'message', text: `Run spec ${specId}` },
      {
        onText: (text) => {
          process.stdout.write(text);
        },
        onError: (detail) => {
          process.stderr.write(`${detail}\n`);
        },
      },
    );

    if (!outcome.succeeded) {
      if (outcome.failureDetail !== undefined) {
        process.stderr.write(`error: ${outcome.failureDetail}\n`);
      }
      return 1;
    }
    return 0;
  },

  async skills(
    argv: SkillsArgv,
    transport: OpenedTransport,
  ): Promise<CliExitCode> {
    // `argv._` is the literal tuple `['skills', 'list']`. `main.ts`
    // asserts the second positional is exactly `'list'` under yargs;
    // we re-check for defense-in-depth.
    const sub = argv._[1];
    if (sub !== 'list') {
      process.stderr.write(
        `error: skills: unknown subcommand '${String(sub)}'\n`,
      );
      return 1;
    }

    const outcome = await streamHeadlessAction(
      transport,
      { type: 'skills.list' },
      {
        // `skills list` is a structured-output subcommand — we don't
        // tee streamed text into stdout because the tab-separated
        // output is the contract. Errors still surface via stderr
        // below, after the outcome resolves.
        onError: (detail) => {
          process.stderr.write(`${detail}\n`);
        },
      },
    );

    if (!outcome.succeeded) {
      if (outcome.failureDetail !== undefined) {
        process.stderr.write(`error: ${outcome.failureDetail}\n`);
      }
      return 1;
    }

    const skills = extractSkillsList(outcome);
    for (const skill of skills) {
      const id = entryDisplayId(skill);
      const description = entryDescription(skill);
      process.stdout.write(`${id}\t${description}\n`);
    }
    return 0;
  },

  async agent(
    argv: AgentArgv,
    transport: OpenedTransport,
  ): Promise<CliExitCode> {
    // `argv._` is `['agent', prompt]`; `main.ts` joins variadic
    // positionals with single spaces before delegating here.
    const prompt = argv._[1];
    if (typeof prompt !== 'string' || prompt.length === 0) {
      process.stderr.write('error: agent: missing prompt\n');
      return 1;
    }

    const outcome = await streamHeadlessAction(
      transport,
      { type: 'message', text: prompt },
      {
        onText: (text) => {
          process.stdout.write(text);
        },
        onError: (detail) => {
          process.stderr.write(`${detail}\n`);
        },
      },
    );

    if (!outcome.succeeded) {
      if (outcome.failureDetail !== undefined) {
        process.stderr.write(`error: ${outcome.failureDetail}\n`);
      }
      return 1;
    }
    return 0;
  },

  async mcp(
    _argv: McpArgv,
    transport: OpenedTransport,
  ): Promise<CliExitCode> {
    // ── Onboarding-state gate ─────────────────────────────────
    //
    // TODO(phase-3-banner): once Phase 3's banner-refresh action
    // lands, replace the stub below with a reader that issues a
    // `banner.refresh` Headless_Protocol action and returns the
    // resulting snapshot's `onboardingState`. The gate is consulted
    // per request that needs it, so swapping in the real reader is
    // a one-line change that requires no rewiring on this side.
    const onboardingBannerReader: OnboardingBannerReader = () =>
      Promise.resolve({ onboardingState: 'taskExecuting' });
    const gate = createOnboardingGate(onboardingBannerReader);

    // ── License check ────────────────────────────────────────
    //
    // TODO(phase-3-banner): once Phase 3's startup banner carries
    // the desktop-side `LicenseManager.getStoredLicense()` summary,
    // replace this stub with a reader that returns the live banner.
    // For now we report a present, valid, non-expiring license so
    // the MCP server is exercisable end-to-end while Phase 3 lands;
    // production deploys gain real license enforcement automatically
    // once the reader is wired through.
    const licenseBannerReader: LicenseBannerReader = () =>
      Promise.resolve({ license: { valid: true } });
    const licenseCheck = createLicenseCheck(licenseBannerReader);

    // ── Build the server and start it ────────────────────────
    //
    // The pre-opened transport's lifetime is now owned by the MCP
    // server: `server.stop()` releases it via `transport.close()`,
    // matching the `OutboundMcpServerOptions.transport` contract
    // (Req 6.12).
    const server = createOutboundMcpServer();
    try {
      await server.start({ transport, gate, licenseCheck });
    } catch (err) {
      process.stderr.write(
        `error: mcp: failed to start outbound MCP server: ${
          (err as Error).message
        }\n`,
      );
      // Best-effort transport release on startup failure — `stop()`
      // is idempotent and safe to call even if `start()` threw
      // before fully wiring up.
      try {
        await server.stop();
      } catch {
        /* swallow — startup error is the authoritative one. */
      }
      return 1;
    }

    // ── Wait for shutdown signal ─────────────────────────────
    //
    // The function returned to the caller does not resolve until
    // SIGINT or SIGTERM is delivered. Each signal handler triggers
    // graceful shutdown exactly once; the Promise resolves with
    // exit code 0 once `server.stop()` settles.
    return await new Promise<CliExitCode>((resolve) => {
      let shuttingDown = false;

      const shutdown = (signal: NodeJS.Signals): void => {
        if (shuttingDown) return;
        shuttingDown = true;

        // Detach the other signal listener so a second signal
        // delivered during shutdown doesn't attempt to drain
        // twice. The handlers are registered with `once`, so the
        // signal that just fired is already detached; we strip
        // the partner here.
        process.removeListener('SIGINT', onSigint);
        process.removeListener('SIGTERM', onSigterm);

        void (async () => {
          try {
            await server.stop();
          } catch (err) {
            process.stderr.write(
              `warning: mcp: server.stop() threw on ${signal}: ${
                (err as Error).message
              }\n`,
            );
          }
          resolve(0);
        })();
      };

      const onSigint = (): void => shutdown('SIGINT');
      const onSigterm = (): void => shutdown('SIGTERM');

      process.once('SIGINT', onSigint);
      process.once('SIGTERM', onSigterm);
    });
  },
});
