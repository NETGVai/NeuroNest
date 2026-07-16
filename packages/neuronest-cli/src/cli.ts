// File: packages/neuronest-cli/src/cli.ts
//
// CLI entry point and command parsing for headless mode (task 21.1).
//
// Implements `neuronest run "<task>"` as the primary command with
// support for flags: --auto, --mode, --json, --max-cost, --provider, --model.
//
// Exit codes:
//   0 — success
//   1 — agent failure
//   2 — config error
//
// When `--json` is set, output is structured JSON events on stdout.
//
// Validates: Requirements 21.1

import yargs from 'yargs';
import { HeadlessRunner, type HeadlessRunnerOptions } from './headless-runner.js';
import {
  parseAndBuildPermissionConfig,
  type CliPermissionFlags,
} from './cli/cli-pattern-injection.js';

// ─── Exit Codes ─────────────────────────────────────────────────

/** Documented exit codes for the headless CLI. */
export const EXIT_SUCCESS = 0 as const;
export const EXIT_AGENT_FAILURE = 1 as const;
export const EXIT_CONFIG_ERROR = 2 as const;

export type HeadlessExitCode = typeof EXIT_SUCCESS | typeof EXIT_AGENT_FAILURE | typeof EXIT_CONFIG_ERROR;

// ─── JSON Event Types ───────────────────────────────────────────

/** Structured JSON event types emitted when --json is active. */
export type JsonEventType =
  | 'start'
  | 'progress'
  | 'tool_call'
  | 'tool_result'
  | 'cost_update'
  | 'complete'
  | 'error';

export interface JsonEvent {
  type: JsonEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

// ─── CLI Parsed Args ────────────────────────────────────────────

/** Parsed arguments for `neuronest run "<task>"`. */
export interface HeadlessCliArgs {
  task: string;
  auto: boolean;
  mode: 'auto' | 'plan' | 'headless';
  json: boolean;
  maxCost: number | undefined;
  provider: string | undefined;
  model: string | undefined;
}

// ─── JSON event emitter ─────────────────────────────────────────

/**
 * Emit a structured JSON event to the provided writable stream.
 * Each event is a single line of JSON (NDJSON format).
 */
export function emitJsonEvent(
  stream: NodeJS.WritableStream,
  type: JsonEventType,
  data: Record<string, unknown>,
): void {
  const event: JsonEvent = {
    type,
    timestamp: new Date().toISOString(),
    data,
  };
  stream.write(JSON.stringify(event) + '\n');
}

// ─── CLI Dependencies (test seam) ──────────────────────────────

export interface HeadlessCliDeps {
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly runner?: HeadlessRunner;
  /** Feature gate check — returns false if headless_cli flag is disabled. */
  readonly isFeatureEnabled?: (flag: string) => boolean;
}

// ─── Argument Validation ────────────────────────────────────────

/**
 * Validate that a cost value is a positive number.
 * Returns the parsed number or undefined if not provided.
 * Throws on invalid values (triggers exit 2).
 */
function validateMaxCost(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const num = Number(value);
  if (isNaN(num) || num <= 0) {
    throw new Error(`--max-cost must be a positive number, got: ${value}`);
  }
  return num;
}

/**
 * Validate that the mode is one of the accepted values.
 */
function validateMode(value: unknown): 'auto' | 'plan' | 'headless' {
  const valid = ['auto', 'plan', 'headless'];
  const mode = String(value || 'headless');
  if (!valid.includes(mode)) {
    throw new Error(`--mode must be one of: ${valid.join(', ')}; got: ${mode}`);
  }
  return mode as 'auto' | 'plan' | 'headless';
}

// ─── Public entrypoint ──────────────────────────────────────────

/**
 * Create the headless CLI main function with injectable dependencies.
 *
 * Usage:
 *   neuronest run "implement feature X" --auto --json --max-cost 5.00
 *   neuronest run "fix the bug" --provider openai --model gpt-4o
 */
export function createHeadlessCli(deps: HeadlessCliDeps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const isFeatureEnabled = deps.isFeatureEnabled ?? (() => true);

  return {
    async main(argv: ReadonlyArray<string>): Promise<HeadlessExitCode> {
      // ─── Feature gate check ─────────────────────────────
      if (!isFeatureEnabled('headless_cli')) {
        stderr.write('error: headless_cli feature flag is not enabled\n');
        return EXIT_CONFIG_ERROR;
      }

      // ─── Pre-parse: --help / -h / empty argv ─────────────
      const args = [...argv];
      if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        stdout.write(buildHeadlessUsage() + '\n');
        return EXIT_SUCCESS;
      }

      // ─── yargs configuration ──────────────────────────────
      let exitCode: HeadlessExitCode = EXIT_SUCCESS;
      let dispatched = false;

      const parser = yargs(args as string[])
        .scriptName('neuronest')
        .usage('Usage: neuronest run "<task>" [options]')
        .strict()
        .exitProcess(false)
        .fail(false)
        .help(false)
        .version(false)
        .command(
          'run <task>',
          'Run a task in headless mode',
          (y) =>
            y
              .positional('task', {
                describe: 'Task description for the agent to execute',
                type: 'string',
                demandOption: true,
              })
              .option('auto', {
                describe: 'Enable fully autonomous mode (no permission prompts)',
                type: 'boolean',
                default: false,
              })
              .option('mode', {
                describe: 'Execution mode: auto, plan, or headless',
                type: 'string',
                choices: ['auto', 'plan', 'headless'] as const,
                default: 'headless',
              })
              .option('json', {
                describe: 'Output structured JSON events (NDJSON format)',
                type: 'boolean',
                default: false,
              })
              .option('max-cost', {
                describe: 'Maximum cost in USD before aborting',
                type: 'number',
              })
              .option('provider', {
                describe: 'LLM provider to use (e.g., openai, anthropic)',
                type: 'string',
              })
              .option('model', {
                describe: 'Model identifier (e.g., gpt-4o, claude-sonnet-4-20250514)',
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
            let jsonOutput = false;

            try {
              const task = String(parsed.task);
              const auto = Boolean(parsed.auto);
              jsonOutput = Boolean(parsed.json);
              const maxCost = validateMaxCost(parsed['max-cost'] ?? parsed.maxCost);
              const mode = validateMode(parsed.mode);
              const provider = parsed.provider ? String(parsed.provider) : undefined;
              const model = parsed.model ? String(parsed.model) : undefined;

              // ── Validate --allow/--deny/--ask patterns (Req 10.12) ──
              const permFlags: CliPermissionFlags = {
                allow: parsed.allow,
                deny: parsed.deny,
                ask: parsed.ask,
              };
              const permResult = parseAndBuildPermissionConfig(permFlags);
              if (!permResult.ok) {
                for (const err of permResult.errors) {
                  if (jsonOutput) {
                    emitJsonEvent(stdout, 'error', { message: err, type: 'config_error' });
                  } else {
                    stderr.write(`error: ${err}\n`);
                  }
                }
                exitCode = EXIT_CONFIG_ERROR;
                return;
              }

              const cliArgs: HeadlessCliArgs = {
                task,
                auto,
                mode,
                json: jsonOutput,
                maxCost,
                provider,
                model,
              };

              // Emit start event in JSON mode
              if (jsonOutput) {
                emitJsonEvent(stdout, 'start', {
                  task,
                  auto,
                  mode,
                  maxCost: maxCost ?? null,
                  provider: provider ?? null,
                  model: model ?? null,
                  allowPatterns: permResult.config.allow,
                  denyPatterns: permResult.config.deny,
                  askPatterns: permResult.askPatterns,
                });
              }

              // Run the headless pipeline
              const runner = deps.runner ?? new HeadlessRunner();
              const runnerOptions: HeadlessRunnerOptions = {
                task: cliArgs.task,
                auto: cliArgs.auto,
                mode: cliArgs.mode,
                json: cliArgs.json,
                maxCost: cliArgs.maxCost,
                provider: cliArgs.provider,
                model: cliArgs.model,
                stdout,
                stderr,
                permissionPatterns: permResult.config,
                askPatterns: permResult.askPatterns,
              };

              const result = await runner.run(runnerOptions);

              if (jsonOutput) {
                emitJsonEvent(stdout, 'complete', {
                  success: result.success,
                  response: result.response,
                  costUsd: result.costUsd,
                  toolCalls: result.toolCallsExecuted,
                  iterations: result.iterations,
                });
              }

              exitCode = result.success ? EXIT_SUCCESS : EXIT_AGENT_FAILURE;
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);

              if (jsonOutput) {
                emitJsonEvent(stdout, 'error', { message });
              } else {
                stderr.write(`error: ${message}\n`);
              }

              // Determine if this is a config error or an agent failure
              exitCode = isConfigError(err) ? EXIT_CONFIG_ERROR : EXIT_AGENT_FAILURE;
            }
          },
        );

      try {
        await parser.parseAsync();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        if (isConfigError(err)) {
          stderr.write(`config error: ${message}\n`);
          return EXIT_CONFIG_ERROR;
        }

        stderr.write(`error: ${message}\n`);
        return EXIT_CONFIG_ERROR;
      }

      if (!dispatched) {
        stdout.write(buildHeadlessUsage() + '\n');
        return EXIT_SUCCESS;
      }

      return exitCode;
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Determine whether an error is a configuration error (exit 2)
 * vs an agent failure (exit 1).
 */
function isConfigError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('--max-cost') ||
      msg.includes('--mode') ||
      msg.includes('provider') ||
      msg.includes('config') ||
      msg.includes('feature') ||
      msg.includes('flag')
    );
  }
  return false;
}

/** Build the usage text for the headless CLI. */
function buildHeadlessUsage(): string {
  return [
    'Usage: neuronest run "<task>" [options]',
    '',
    'Options:',
    '  --auto         Enable fully autonomous mode (no permission prompts)',
    '  --mode         Execution mode: auto | plan | headless (default: headless)',
    '  --json         Output structured JSON events (NDJSON format)',
    '  --max-cost     Maximum cost in USD before aborting',
    '  --provider     LLM provider (openai, anthropic, deepseek, etc.)',
    '  --model        Model identifier (e.g., gpt-4o, claude-sonnet-4-20250514)',
    '  --allow        Allow pattern(s) as user-tier rules, e.g. "file_read(*)"',
    '  --deny         Deny pattern(s) as user-tier rules, e.g. "bash(rm *)"',
    '  --ask          Ask pattern(s) — prompt before allowing, e.g. "file_write(**)"',
    '  --help, -h     Show this help message',
    '',
    'Exit codes:',
    '  0  Success',
    '  1  Agent failure',
    '  2  Configuration error',
    '',
    'Examples:',
    '  neuronest run "implement user auth" --auto --json',
    '  neuronest run "fix the login bug" --provider openai --model gpt-4o --max-cost 2.00',
    '  neuronest run "fix the bug" --allow "file_read(*)" --deny "bash(rm *)" --ask "file_write(**)"',
  ].join('\n');
}

// ─── Default export ─────────────────────────────────────────────

/** Default headless CLI instance. */
export const headlessCli = createHeadlessCli();

export default headlessCli;
