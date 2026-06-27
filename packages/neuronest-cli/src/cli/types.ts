// File: packages/neuronest-cli/src/cli/types.ts
//
// CLI argv types for the @neuronest/cli package. The shapes here MUST
// match design § Item 5 exactly — the subcommand handlers in
// `subcommands.ts` and the strict-mode yargs configuration in
// `main.ts` rely on this discriminated union. CliExitCode is locked to
// the three-value set { 0 success, 1 error, 2 unknown subcommand }
// per Req 5.12 / 5.13.

/** Top-level subcommand identifier — all subcommands the
 *  `neuronest` binary exposes (Req 5.3, 5.4, 5.5, 5.6, 5.7, 4.1–4.6). */
export type Subcommand = 'sync' | 'run' | 'skills' | 'agent' | 'mcp' | 'race' | 'fork' | 'snapshot';

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

/** `neuronest task <description>` — runs a task through the agent loop
 *  directly (without headless transport), using the same ToolSystem
 *  and AgentLoopController as the GUI (Req 14.1, 14.2, 14.3, 14.4). */
export interface TaskArgv      {
  _: ['task', string /* task description */];
  mode: 'auto' | 'plan';
  projectDir: string;
  args?: string;
}

/** `neuronest race <prompt>` — initiates an Agent Racing Engine execution
 *  with the provided prompt and configured providers (Req 4.1, 4.2). */
export interface RaceArgv      {
  _: ['race', string /* prompt */];
  providers?: string;
}

/** `neuronest fork <sessionId>` — creates a forked session from the
 *  specified source session (Req 4.3). */
export interface ForkArgv      {
  _: ['fork', string /* sessionId */];
}

/** `neuronest snapshot <action>` — manages worktree snapshots (Req 4.4, 4.5, 4.6).
 *  Sub-actions: create [--label], restore <id>, list */
export interface SnapshotCreateArgv {
  _: ['snapshot', 'create'];
  label?: string;
}

export interface SnapshotRestoreArgv {
  _: ['snapshot', 'restore', string /* snapshot id */];
}

export interface SnapshotListArgv {
  _: ['snapshot', 'list'];
}

export type SnapshotArgv = SnapshotCreateArgv | SnapshotRestoreArgv | SnapshotListArgv;

/** Discriminated union over all CLI subcommand argv shapes. Drives
 *  the strict-mode yargs configuration in `main.ts`. */
export type CliArgv = SyncArgv | RunArgv | SkillsArgv | AgentArgv | McpArgv | TaskArgv | RaceArgv | ForkArgv | SnapshotArgv;

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
