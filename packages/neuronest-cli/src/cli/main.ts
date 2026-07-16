// File: packages/neuronest-cli/src/cli/main.ts
//
// Single entrypoint for the `neuronest` binary (task 9.5).
//
// Configuration (Req 5.1, 5.7, 5.8, 5.9, 5.10, 5.11, 5.12, 5.13):
//   - `yargs(argv).strict()` with five subcommands wired to
//     `CliSubcommands.{sync, run, skills, agent, mcp}`.
//   - Non-`sync` subcommands open the `HeadlessTransport` first via
//     `createHeadlessTransport().open()` (the probe-then-spawn helper
//     from task 9.2). On `{ ok: false }` the failure detail is
//     written to stderr and the process exits 1 (Req 5.11).
//   - `--help` / `-h` / no subcommand → usage summary to stdout,
//     exit 0 (Req 5.12).
//   - Unknown subcommand → error naming the subcommand + usage to
//     stderr, exit 2 (Req 5.13). yargs's strict mode is the trigger;
//     this layer translates the raw error into the documented exit
//     code.
//
// `main` returns `Promise<CliExitCode>` resolving to exactly `0`,
// `1`, or `2`. The bin script (task 9.6) calls `process.exit(code)`
// with the resolved value.
//
// yargs's `.exitProcess(false)` + `.fail(false)` keeps argument
// parsing test-friendly: instead of calling `process.exit` itself,
// yargs throws on failure and we translate the throw into the
// documented exit code.
//
// Validates: Requirements 5.1, 5.7, 5.8, 5.9, 5.10, 5.11, 5.12, 5.13.

import yargs from 'yargs';

import {
  createHeadlessTransport,
  type HeadlessTransport,
  type HeadlessTransportFailure,
  type OpenedTransport,
} from '../transport/headless-transport.js';
import { CliSubcommands } from './subcommands.js';
import { runAgentTask, type AgentRunnerMode } from './agent-runner.js';
import {
  handleRaceCommand,
  handleForkCommand,
  handleSnapshotCreateCommand,
  handleSnapshotRestoreCommand,
  handleSnapshotListCommand,
  type OrchestrationCommandDeps,
} from './orchestration-commands.js';
import {
  parseAndBuildPermissionConfig,
  type CliPermissionFlags,
} from './cli-pattern-injection.js';
import { startACPStdioServer } from './acp-stdio-server.js';
import type {
  AgentArgv,
  CliExitCode,
  McpArgv,
  NeuronestCli,
  RunArgv,
  SkillsArgv,
  SyncArgv,
} from './types.js';

// ─── Usage / help text ──────────────────────────────────────────

/** One-line description per subcommand (Req 5.12, 4.1–4.6). */
const SUBCOMMAND_DESCRIPTIONS = Object.freeze({
  sync: 'Emit typed-skill bindings for installed skills',
  run: 'Run the named spec via the headless agent',
  skills: 'Inspect installed skills',
  agent: 'Agent invocation or ACP stdio server',
  mcp: 'Start the outbound MCP server',
  task: 'Run a task through the agent loop (standalone, no headless)',
  race: 'Race multiple providers on a prompt and select the best result',
  fork: 'Fork an existing session into an independent branch',
  snapshot: 'Manage worktree snapshots (create, restore, list)',
} as const);

const USAGE_HEADER = 'Usage: neuronest <subcommand> [args...]';

/** Build the usage summary printed for `--help` and unknown
 *  subcommands. Stable formatting so tests can assert on the exact
 *  text. */
function buildUsageSummary(): string {
  const lines: string[] = [USAGE_HEADER, '', 'Subcommands:'];
  for (const [name, description] of Object.entries(SUBCOMMAND_DESCRIPTIONS)) {
    // Two-space indent, six-character padded name, then description.
    lines.push(`  ${name.padEnd(8)}${description}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ─── HeadlessTransport injection (test seam) ────────────────────

/** Construction-time options for `createMain`. The default factory is
 *  `createHeadlessTransport` from `../transport/headless-transport.js`;
 *  tests override it to inject deterministic probe/spawn outcomes. */
export interface MainDeps {
  readonly headlessTransportFactory?: () => HeadlessTransport;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  /** Dependencies for orchestration commands (race, fork, snapshot). */
  readonly orchestrationDeps?: OrchestrationCommandDeps;
}

/** Format a `HeadlessTransportFailure` for stderr (Req 5.11). */
function formatTransportFailure(failure: HeadlessTransportFailure): string {
  return `error: headless transport ${failure.kind}: ${failure.detail}`;
}

// ─── Subcommand dispatch ────────────────────────────────────────

/**
 * Open the headless transport and run `dispatch` against it. The
 * caller's resulting exit code is returned; on transport-open failure
 * the dispatch is skipped and exit 1 is returned (Req 5.11).
 *
 * The transport is closed in a `finally` block — the subcommand
 * wrappers don't own its lifetime (they only consume events for one
 * round-trip), except for `mcp` which holds it for the lifetime of
 * the MCP server. The close-after-dispatch contract is correct for
 * the short-lived subcommands; for `mcp` the server's `stop()` already
 * released the transport before returning, so the redundant `close()`
 * is safe.
 */
async function withTransport(
  factory: () => HeadlessTransport,
  stderr: NodeJS.WritableStream,
  dispatch: (transport: OpenedTransport) => Promise<CliExitCode>,
): Promise<CliExitCode> {
  const orchestrator = factory();
  const result = await orchestrator.open();
  if (!result.ok) {
    stderr.write(`${formatTransportFailure(result.failure)}\n`);
    return 1;
  }
  try {
    return await dispatch(result.transport);
  } finally {
    try {
      await result.transport.close();
    } catch {
      // Close errors are non-fatal — the dispatch already completed.
    }
  }
}

// ─── Default orchestration deps factory ─────────────────────────

/**
 * Creates a default OrchestrationCommandDeps that reports features
 * as disabled. In production, the caller provides fully wired deps
 * with real subsystem instances. This fallback ensures the CLI
 * gracefully displays feature-disabled messages when launched without
 * subsystem initialization.
 */
function createDefaultOrchestrationDeps(
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): OrchestrationCommandDeps {
  return {
    featureGate: {
      isEnabled: () => false,
    },
    stdout,
    stderr,
  };
}

// ─── Public entrypoint ──────────────────────────────────────────

/**
 * Build a `NeuronestCli.main` with injected dependencies. The default
 * export below is the production wiring; tests construct a custom
 * instance via `createMain({ headlessTransportFactory })`.
 */
export function createMain(deps: MainDeps = {}): NeuronestCli {
  const factory =
    deps.headlessTransportFactory ?? (() => createHeadlessTransport());
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  return {
    async main(argv: ReadonlyArray<string>): Promise<CliExitCode> {
      // ─── Pre-parse: --help / -h / empty argv ──────────────
      //
      // Req 5.12 — `neuronest --help` and `neuronest` (no subcommand)
      // print the usage summary to stdout and exit 0. We handle this
      // ahead of yargs so the help branch is always exit 0 regardless
      // of yargs's internal exit-code conventions.
      const args = [...argv];
      if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        stdout.write(`${buildUsageSummary()}\n`);
        return 0;
      }

      // ─── yargs configuration ──────────────────────────────
      //
      // `.strict()` rejects unknown subcommands and unknown flags.
      // `.exitProcess(false)` keeps the parser from calling
      // `process.exit` itself; combined with `.fail(false)`, parsing
      // errors are surfaced as thrown errors from `.parseAsync()`.
      //
      // Each subcommand's handler captures the resolved CliExitCode
      // into the `exitCode` closure below. The handler's `Promise`
      // is awaited by yargs, so any subcommand error inside the
      // handler also rejects `parseAsync()`.

      let exitCode: CliExitCode = 0;
      let dispatched = false;

      const parser = yargs(args as string[])
        .scriptName('neuronest')
        .usage(USAGE_HEADER)
        .strict()
        .exitProcess(false)
        .fail(false)
        .help(false)
        .version(false)
        // ─ sync ─────────────────────────────────────────────
        .command(
          'sync',
          SUBCOMMAND_DESCRIPTIONS.sync,
          (y) => y,
          async () => {
            dispatched = true;
            const argvShape: SyncArgv = { _: ['sync'] };
            exitCode = await CliSubcommands.sync(argvShape);
          },
        )
        // ─ run <specId> ─────────────────────────────────────
        .command(
          'run <specId>',
          SUBCOMMAND_DESCRIPTIONS.run,
          (y) =>
            y.positional('specId', {
              describe: 'Spec identifier under .kiro/specs/',
              type: 'string',
              demandOption: true,
            }),
          async (parsed) => {
            dispatched = true;
            const specId = String(parsed.specId);
            const argvShape: RunArgv = { _: ['run', specId] };
            exitCode = await withTransport(factory, stderr, (transport) =>
              CliSubcommands.run(argvShape, transport),
            );
          },
        )
        // ─ skills <action> ──────────────────────────────────
        //
        // The `skills` subcommand demands a sub-builder limited to
        // `'list'`. yargs's nested `.command()` + `.demandCommand(1)`
        // gives us exactly that: any other action (e.g. `skills foo`)
        // triggers strict-mode rejection with an "unknown command"
        // error, which our `.fail(false)` translates into exit 2 in
        // the catch below.
        .command(
          'skills <action>',
          SUBCOMMAND_DESCRIPTIONS.skills,
          (y) =>
            y
              .command(
                'list',
                'List installed skills',
                (yy) => yy,
                async () => {
                  dispatched = true;
                  const argvShape: SkillsArgv = { _: ['skills', 'list'] };
                  exitCode = await withTransport(
                    factory,
                    stderr,
                    (transport) =>
                      CliSubcommands.skills(argvShape, transport),
                  );
                },
              )
              .demandCommand(1, 'skills: action is required (use `list`)')
              .strict(),
          () => {
            // Top-level handler is unreachable when a sub-command
            // matches; included for type completeness.
          },
        )
        // ─ agent ────────────────────────────────────────────
        //
        // The `agent` subcommand has two modes:
        //   - `agent stdio` — starts the ACP JSON-RPC server (Req 20.1)
        //   - `agent <prompt..>` — one-shot agent invocation (Req 5.6)
        .command(
          'agent',
          SUBCOMMAND_DESCRIPTIONS.agent,
          (y) =>
            y
              .command(
                'stdio',
                'Start the ACP JSON-RPC server over stdin/stdout',
                (yy) => yy,
                async () => {
                  dispatched = true;
                  exitCode = await startACPStdioServer();
                },
              )
              .command(
                '$0 <prompt..>',
                'One-shot agent invocation against the headless instance',
                (yy) =>
                  yy.positional('prompt', {
                    describe: 'Prompt to send to the agent',
                    type: 'string',
                    array: true,
                    demandOption: true,
                  }),
                async (parsed) => {
                  dispatched = true;
                  const promptParts = parsed.prompt;
                  const prompt = Array.isArray(promptParts)
                    ? promptParts.map(String).join(' ')
                    : String(promptParts ?? '');
                  const argvShape: AgentArgv = { _: ['agent', prompt] };
                  exitCode = await withTransport(factory, stderr, (transport) =>
                    CliSubcommands.agent(argvShape, transport),
                  );
                },
              ),
          () => {
            // Top-level handler — sub-commands handle dispatch.
          },
        )
        // ─ mcp ──────────────────────────────────────────────
        .command(
          'mcp',
          SUBCOMMAND_DESCRIPTIONS.mcp,
          (y) => y,
          async () => {
            dispatched = true;
            const argvShape: McpArgv = { _: ['mcp'] };
            exitCode = await withTransport(factory, stderr, (transport) =>
              CliSubcommands.mcp(argvShape, transport),
            );
          },
        )
        // ─ task <description..> ─────────────────────────────
        //
        // Runs a task through the agent loop directly (Req 14.1-14.4).
        // Does NOT use headless transport — it initializes the same
        // ToolSystem and AgentLoopController as the GUI, running the
        // loop in-process and streaming output to stdout.
        //
        // Supports --allow, --deny, --ask pattern injection (Req 10.12).
        .command(
          'task <description..>',
          SUBCOMMAND_DESCRIPTIONS.task,
          (y) =>
            y
              .positional('description', {
                describe: 'Task description for the agent to execute',
                type: 'string',
                array: true,
                demandOption: true,
              })
              .option('mode', {
                describe: 'Execution mode: auto (default) or plan',
                type: 'string',
                choices: ['auto', 'plan'] as const,
                default: 'auto',
              })
              .option('project-dir', {
                describe: 'Working directory for the project',
                type: 'string',
                default: process.cwd(),
              })
              .option('args', {
                describe: 'Additional arguments to pass to the agent',
                type: 'string',
              })
              .option('allow', {
                describe: 'Allow pattern(s) injected as user-tier rules, e.g. "file_read(*)"',
                type: 'string',
                array: true,
              })
              .option('deny', {
                describe: 'Deny pattern(s) injected as user-tier rules, e.g. "bash(rm *)"',
                type: 'string',
                array: true,
              })
              .option('ask', {
                describe: 'Ask pattern(s) — prompt before allowing, e.g. "file_write(**)"',
                type: 'string',
                array: true,
              }),
          async (parsed) => {
            dispatched = true;
            const descParts = parsed.description;
            const description = Array.isArray(descParts)
              ? descParts.map(String).join(' ')
              : String(descParts ?? '');
            const mode = (parsed.mode || 'auto') as AgentRunnerMode;
            const projectDir = parsed['project-dir'] || parsed.projectDir || process.cwd();

            // ── Validate and build permission patterns (Req 10.12) ──
            const permFlags: CliPermissionFlags = {
              allow: parsed.allow,
              deny: parsed.deny,
              ask: parsed.ask,
            };

            const permResult = parseAndBuildPermissionConfig(permFlags);
            if (!permResult.ok) {
              for (const err of permResult.errors) {
                stderr.write(`error: ${err}\n`);
              }
              exitCode = 1;
              return;
            }

            exitCode = await runAgentTask({
              task: description,
              mode,
              projectDir: String(projectDir),
              args: parsed.args ? String(parsed.args) : undefined,
              permissionPatterns: permResult.config,
              askPatterns: permResult.askPatterns,
            });
          },
        )
        // ─ race <prompt..> ──────────────────────────────────
        //
        // Initiates an Agent Racing Engine execution with the provided
        // prompt and configured providers (Req 4.1, 4.2).
        // Standalone — does NOT use headless transport.
        .command(
          'race <prompt..>',
          SUBCOMMAND_DESCRIPTIONS.race,
          (y) =>
            y
              .positional('prompt', {
                describe: 'Prompt to send to all race participants',
                type: 'string',
                array: true,
                demandOption: true,
              })
              .option('providers', {
                describe: 'Comma-separated list of provider IDs',
                type: 'string',
              }),
          async (parsed) => {
            dispatched = true;
            const promptParts = parsed.prompt;
            const prompt = Array.isArray(promptParts)
              ? promptParts.map(String).join(' ')
              : String(promptParts ?? '');

            const orchDeps = deps.orchestrationDeps ?? createDefaultOrchestrationDeps(stdout, stderr);
            exitCode = await handleRaceCommand(
              { prompt, providers: parsed.providers },
              { ...orchDeps, stdout, stderr },
            );
          },
        )
        // ─ fork <sessionId> ─────────────────────────────────
        //
        // Creates a forked session from the specified source session
        // and displays the new session ID (Req 4.3).
        // Standalone — does NOT use headless transport.
        .command(
          'fork <sessionId>',
          SUBCOMMAND_DESCRIPTIONS.fork,
          (y) =>
            y.positional('sessionId', {
              describe: 'Session ID to fork from',
              type: 'string',
              demandOption: true,
            }),
          async (parsed) => {
            dispatched = true;
            const sessionId = String(parsed.sessionId);

            const orchDeps = deps.orchestrationDeps ?? createDefaultOrchestrationDeps(stdout, stderr);
            exitCode = await handleForkCommand(
              { sessionId },
              { ...orchDeps, stdout, stderr },
            );
          },
        )
        // ─ snapshot <action> ────────────────────────────────
        //
        // Manages worktree snapshots: create, restore, list (Req 4.4–4.6).
        // Uses nested subcommands via yargs .command() + .demandCommand().
        .command(
          'snapshot',
          SUBCOMMAND_DESCRIPTIONS.snapshot,
          (y) =>
            y
              .command(
                'create',
                'Create a worktree snapshot',
                (yy) =>
                  yy.option('label', {
                    describe: 'Optional label for the snapshot',
                    type: 'string',
                  }),
                async (parsed) => {
                  dispatched = true;
                  const orchDeps = deps.orchestrationDeps ?? createDefaultOrchestrationDeps(stdout, stderr);
                  exitCode = await handleSnapshotCreateCommand(
                    { label: parsed.label },
                    { ...orchDeps, stdout, stderr },
                  );
                },
              )
              .command(
                'restore <id>',
                'Restore a worktree snapshot',
                (yy) =>
                  yy.positional('id', {
                    describe: 'Snapshot ID to restore',
                    type: 'string',
                    demandOption: true,
                  }),
                async (parsed) => {
                  dispatched = true;
                  const snapshotId = String(parsed.id);
                  const orchDeps = deps.orchestrationDeps ?? createDefaultOrchestrationDeps(stdout, stderr);
                  exitCode = await handleSnapshotRestoreCommand(
                    { id: snapshotId },
                    { ...orchDeps, stdout, stderr },
                  );
                },
              )
              .command(
                'list',
                'List all worktree snapshots',
                (yy) => yy,
                async () => {
                  dispatched = true;
                  const orchDeps = deps.orchestrationDeps ?? createDefaultOrchestrationDeps(stdout, stderr);
                  exitCode = await handleSnapshotListCommand(
                    { ...orchDeps, stdout, stderr },
                  );
                },
              )
              .demandCommand(1, 'snapshot: action is required (use `create`, `restore`, or `list`)')
              .strict(),
          () => {
            // Top-level handler unreachable when sub-command matches.
          },
        );

      try {
        await parser.parseAsync();
      } catch (err) {
        // ─── Parser rejection ────────────────────────────
        //
        // `.fail(false)` causes yargs to throw on validation errors
        // (unknown command, missing positional, unknown flag under
        // `.strict()`). We translate the throw into the documented
        // exit code:
        //
        //   - Unknown subcommand or unknown command at any nesting
        //     level → exit 2 (Req 5.13). The error message is
        //     written to stderr along with the usage summary.
        //   - Anything else (validation failure on a known
        //     subcommand, e.g. missing `specId`) → exit 1.
        const message =
          err instanceof Error
            ? err.message
            : typeof err === 'string'
              ? err
              : 'unknown parse error';

        if (isUnknownCommandError(message)) {
          stderr.write(`error: ${message}\n`);
          stderr.write(`${buildUsageSummary()}\n`);
          return 2;
        }

        stderr.write(`error: ${message}\n`);
        return 1;
      }

      // ─── No-handler fallthrough ───────────────────────────
      //
      // Defensive: if yargs accepted the parse without dispatching
      // any handler (e.g. an internal mode change), treat it as the
      // "no subcommand" branch — print usage and exit 0 (Req 5.12).
      if (!dispatched) {
        stdout.write(`${buildUsageSummary()}\n`);
        return 0;
      }
      return exitCode;
    },
  };
}

/**
 * Returns true when a yargs error message indicates an unknown
 * subcommand or unknown argument under `.strict()`. yargs uses a
 * stable phrase set for these errors ("Unknown command", "Unknown
 * arguments") which we match case-insensitively to stay resilient
 * across patch versions.
 */
function isUnknownCommandError(message: string): boolean {
  return /unknown (?:command|argument)/i.test(message);
}

/**
 * Default `NeuronestCli.main` instance — the bin script (task 9.6)
 * imports this and calls `main(process.argv.slice(2))`.
 */
export const main: NeuronestCli['main'] = createMain().main;

/** Default export: the bound `main` function. */
export default main;

/** Ergonomic re-export so consumers can `import { neuronestCli }
 *  from './main.js'` and use the bound default. The lower-case name
 *  avoids merging with the `NeuronestCli` interface re-exported from
 *  `./types.js`. */
export const neuronestCli: NeuronestCli = { main };
