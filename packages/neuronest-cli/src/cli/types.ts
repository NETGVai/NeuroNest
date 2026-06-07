// File: packages/neuronest-cli/src/cli/types.ts
//
// CLI argv types for the @neuronest/cli package. The shapes here MUST
// match design § Item 5 exactly — the subcommand handlers in
// `subcommands.ts` and the strict-mode yargs configuration in
// `main.ts` rely on this discriminated union. CliExitCode is locked to
// the three-value set { 0 success, 1 error, 2 unknown subcommand }
// per Req 5.12 / 5.13.

/** Top-level subcommand identifier — one of the five subcommands the
 *  `neuronest` binary exposes (Req 5.3, 5.4, 5.5, 5.6, 5.7). */
export type Subcommand = 'sync' | 'run' | 'skills' | 'agent' | 'mcp';

/** `neuronest sync` — typed-skill-client emission (Req 5.3). Operates
 *  entirely against the local filesystem; never opens the
 *  HeadlessTransport. */
export interface SyncArgv      { _: ['sync'] }

/** `neuronest run <spec-id>` — runs the named spec's tasks via the
 *  Headless_Protocol (Req 5.4). The positional after `'run'` is the
 *  specId. */
export interface RunArgv       { _: ['run', string /* specId */] }

/** `neuronest skills list` — prints the identifiers and one-line
 *  descriptions of all installed skills (Req 5.5). */
export interface SkillsArgv    { _: ['skills', 'list'] }

/** `neuronest agent <prompt>` — one-shot agent invocation against a
 *  headless NeuroNest instance (Req 5.6). The positional after
 *  `'agent'` is the prompt string (yargs joins variadic positionals
 *  with a single space at the main.ts layer). */
export interface AgentArgv     { _: ['agent', string /* prompt */] }

/** `neuronest mcp` — starts the Outbound_MCP_Server (Req 5.7). */
export interface McpArgv       { _: ['mcp'] }

/** Discriminated union over all CLI subcommand argv shapes. Drives
 *  the strict-mode yargs configuration in `main.ts`. */
export type CliArgv = SyncArgv | RunArgv | SkillsArgv | AgentArgv | McpArgv;

/** Process exit code returned by `NeuronestCli.main`. The three-value
 *  set is locked: 0 success, 1 error, 2 unknown subcommand
 *  (Req 5.12, 5.13). */
export type CliExitCode = 0 | 1 | 2;
//                       success    error  unknown subcommand

/** Single entrypoint exposed by the `bin/neuronest.js` script. */
export interface NeuronestCli {
  /** Single entrypoint exposed by the bin script. Returns a Promise
   *  resolving to the process exit code. */
  main(argv: ReadonlyArray<string>): Promise<CliExitCode>;
}
