// File: packages/neuronest-cli/src/transport/headless-transport.ts
//
// Headless_Protocol IPC fallback orchestrator (Item 5, task 9.2).
//
// Probe-then-spawn ordering (Req 5.8, 5.9, 5.10, 5.11):
//   Step 1: probe the running-app local socket (unix-domain on
//           macOS/Linux, named pipe on Windows) at the deterministic
//           path under the desktop app's user-data dir. On connect →
//           return that transport with `via: 'running-app'`.
//   Step 2: on socket-not-found OR socket-connect-failure, spawn a
//           headless instance and connect via stdio. On connect →
//           return with `via: 'spawned-headless'`.
//   Step 3: on both failing, return
//           `{ ok: false; failure: { kind, detail } }`.
//
// The `sync` subcommand does NOT use this transport — it operates
// entirely against the local filesystem (Req 5.8 carve-out).
//
// The probe and spawn hooks are injectable via
// `createHeadlessTransport({ probe, spawn })` so task 9.7's property
// test can spy on call ordering and outcomes (Property 11).
//
// Validates: Requirements 5.8, 5.9, 5.10, 5.11

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn as childSpawn, type ChildProcess } from 'node:child_process';

// ─── Phase 3 Headless_Protocol forward-declarations ─────────────
//
// `HeadlessAction` (5 inbound types) and `HeadlessEvent` (10
// outbound types) are owned by Phase 3's `src/cli/headless-server.ts`
// / `headless-adapter.ts`. To keep the standalone CLI package free
// of Electron-side imports, these are forward-declared here as the
// minimal shape the transport needs at compile time. The wire shape
// is locked at `protocol_version: 1` (Phase 3) and is newline-
// delimited JSON in both directions.

/** A single action sent from the CLI/MCP server into the desktop or
 *  spawned-headless agent. The `type` field discriminates among the
 *  five Phase 3 inbound types (e.g. `'message'`, `'cancel'`, …);
 *  additional fields vary by type. */
export interface HeadlessAction {
  type: string;
  [key: string]: unknown;
}

/** A single event emitted by the desktop or spawned-headless agent
 *  back to the CLI. `type` discriminates among the ten Phase 3
 *  outbound types (`'text'`, `'tool_start'`, `'tool_input_delta'`,
 *  `'tool_done'`, `'error'`, `'completed'`, …). */
export interface HeadlessEvent {
  type: string;
  [key: string]: unknown;
}

// ─── Public open-result shape ───────────────────────────────────

/** A live transport handle returned by a successful `open()`. */
export interface OpenedTransport {
  /** Send a `HeadlessAction` to the agent. The default
   *  implementation serializes the action as one JSON line followed
   *  by `\n` and writes it to the underlying byte stream. */
  send: (action: HeadlessAction) => void;
  /** Async-iterable stream of events parsed from inbound NDJSON.
   *  Iteration completes when the underlying stream closes. */
  events: AsyncIterable<HeadlessEvent>;
  /** Close the transport. Resolves once the underlying socket or
   *  child process has been torn down. */
  close: () => Promise<void>;
}

/** Failure variants returned by `HeadlessTransport.open` (Req 5.11).
 *  `auth_failure` is reserved for the Outbound_MCP_Server flow
 *  (task 11.x) — `open()` itself only ever returns `connect_failure`
 *  or `spawn_failure`, but the wider type union remains stable so
 *  callers can pattern-match exhaustively. */
export type HeadlessTransportFailure =
  | { kind: 'connect_failure'; detail: string }
  | { kind: 'spawn_failure'; detail: string }
  | { kind: 'auth_failure'; detail: string };

/** Discriminated union returned by `HeadlessTransport.open`. */
export type HeadlessTransportOpenResult =
  | {
      ok: true;
      transport: OpenedTransport;
      via: 'running-app' | 'spawned-headless';
    }
  | { ok: false; failure: HeadlessTransportFailure };

/** Public surface — the orchestrator's only operation. */
export interface HeadlessTransport {
  open(): Promise<HeadlessTransportOpenResult>;
}

// ─── Injectable hooks (used by task 9.7's property test) ───────

/** Probe the running-app local IPC at `socketPath`. Returns a live
 *  transport on success, a structured detail on failure. */
export type RunningAppProbe = (
  socketPath: string,
) => Promise<
  | { ok: true; transport: OpenedTransport }
  | { ok: false; detail: string }
>;

/** Spawn a headless instance and connect to its stdio NDJSON stream. */
export type HeadlessSpawner = () => Promise<
  | { ok: true; transport: OpenedTransport }
  | { ok: false; detail: string }
>;

/** Construction-time options for `createHeadlessTransport`. */
export interface HeadlessTransportDeps {
  /** Override the running-app probe (used by tests / task 9.7). */
  probe?: RunningAppProbe;
  /** Override the headless spawn helper (used by tests / task 9.7). */
  spawn?: HeadlessSpawner;
  /** Override the deterministic socket path (used by tests). */
  socketPath?: string;
  /** Override the platform discriminator (used by tests). */
  platform?: NodeJS.Platform;
  /** Override the home-directory resolver (used by tests). */
  homedir?: () => string;
}

// ─── Deterministic socket path ──────────────────────────────────

/**
 * The deterministic local-IPC path for the running desktop app.
 * Matches Phase 3's user-data convention — see design § Item 5.
 *
 *   macOS:  ~/Library/Application Support/NeuroNest/headless.sock
 *   Linux:  $XDG_CONFIG_HOME/NeuroNest/headless.sock  (or
 *           ~/.config/NeuroNest/headless.sock)
 *   Win32:  \\.\pipe\neuronest-headless    (named pipe — no fs path)
 */
export function defaultSocketPath(
  platform: NodeJS.Platform = process.platform,
  homedir: () => string = os.homedir,
): string {
  if (platform === 'win32') {
    return '\\\\.\\pipe\\neuronest-headless';
  }
  if (platform === 'darwin') {
    return path.join(
      homedir(),
      'Library',
      'Application Support',
      'NeuroNest',
      'headless.sock',
    );
  }
  // Linux / other unix — honor $XDG_CONFIG_HOME if present.
  const xdg = process.env['XDG_CONFIG_HOME'];
  const base = xdg && xdg.length > 0 ? xdg : path.join(homedir(), '.config');
  return path.join(base, 'NeuroNest', 'headless.sock');
}

// ─── NDJSON transport adapter ───────────────────────────────────

/**
 * Wrap a writable + readable byte stream pair in the NDJSON-shaped
 * `OpenedTransport` contract.
 *
 * Inbound: bytes are buffered until a `\n` boundary; each line is
 * parsed as JSON and pushed to the async iterator. Malformed JSON
 * lines surface as a synthetic `{ type: 'error', detail }` event so
 * the CLI can react without crashing the iterator.
 *
 * Outbound: each `send(action)` call writes
 * `JSON.stringify(action) + '\n'` to the writable stream.
 */
function ndjsonTransport(opts: {
  write: (data: string) => void;
  readable: NodeJS.ReadableStream;
  close: () => Promise<void>;
}): OpenedTransport {
  let buffer = '';
  type PendingWaiter = {
    resolve: (v: IteratorResult<HeadlessEvent>) => void;
    reject: (e: unknown) => void;
  };
  const queue: HeadlessEvent[] = [];
  const waiters: PendingWaiter[] = [];
  let closed = false;
  let endError: Error | null = null;

  const pushEvent = (ev: HeadlessEvent): void => {
    const w = waiters.shift();
    if (w) {
      w.resolve({ value: ev, done: false });
    } else {
      queue.push(ev);
    }
  };

  const handleData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) {
        try {
          pushEvent(JSON.parse(line) as HeadlessEvent);
        } catch (err) {
          pushEvent({
            type: 'error',
            detail: `malformed NDJSON line: ${(err as Error).message}`,
          });
        }
      }
      nl = buffer.indexOf('\n');
    }
  };

  const handleEnd = (): void => {
    if (closed) return;
    closed = true;
    while (waiters.length > 0) {
      const w = waiters.shift()!;
      w.resolve({ value: undefined, done: true });
    }
  };

  const handleError = (err: Error): void => {
    endError = err;
    closed = true;
    while (waiters.length > 0) {
      const w = waiters.shift()!;
      w.reject(err);
    }
  };

  opts.readable.setEncoding('utf8');
  opts.readable.on('data', handleData);
  opts.readable.on('end', handleEnd);
  opts.readable.on('close', handleEnd);
  opts.readable.on('error', handleError);

  const events: AsyncIterable<HeadlessEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<HeadlessEvent> {
      return {
        next(): Promise<IteratorResult<HeadlessEvent>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (endError) return Promise.reject(endError);
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise<IteratorResult<HeadlessEvent>>(
            (resolve, reject) => {
              waiters.push({ resolve, reject });
            },
          );
        },
        return(): Promise<IteratorResult<HeadlessEvent>> {
          handleEnd();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  return {
    send(action: HeadlessAction): void {
      if (closed) {
        throw new Error('headless transport already closed');
      }
      opts.write(JSON.stringify(action) + '\n');
    },
    events,
    async close(): Promise<void> {
      handleEnd();
      await opts.close();
    },
  };
}

// ─── Default running-app probe ──────────────────────────────────

/**
 * Default running-app probe. Connects via
 * `net.createConnection({ path })` — works for both unix-domain
 * sockets (macOS/Linux) and Windows named pipes.
 *
 * On non-win32 platforms the socket file's existence is checked
 * with `fs.stat` first so a clean "socket not found" detail is
 * emitted rather than a less-informative ENOENT from `net`. On
 * Windows the named-pipe path doesn't have a stat-able file, so the
 * connect attempt is the only check.
 *
 * This default is exported (rather than created lazily) so a single
 * shared spy in task 9.7's property test can observe the running-app
 * probe call ordering.
 */
export const defaultRunningAppProbe: RunningAppProbe = async (
  socketPath: string,
) => {
  if (process.platform !== 'win32') {
    try {
      await fs.promises.stat(socketPath);
    } catch {
      return {
        ok: false,
        detail: `running-app socket not found at ${socketPath}`,
      };
    }
  }

  return await new Promise<
    | { ok: true; transport: OpenedTransport }
    | { ok: false; detail: string }
  >((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;

    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        ok: false,
        detail: `running-app socket connect failed: ${err.message}`,
      });
    };

    socket.once('error', onError);
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      socket.off('error', onError);
      resolve({
        ok: true,
        transport: ndjsonTransport({
          write: (data) => {
            socket.write(data);
          },
          readable: socket,
          close: async () => {
            await new Promise<void>((res) => {
              if (socket.destroyed) {
                res();
                return;
              }
              socket.end(() => res());
            });
          },
        }),
      });
    });
  });
};

// ─── Default headless spawner ───────────────────────────────────

/** Construction-time options for the default headless spawner. */
export interface DefaultHeadlessSpawnerOptions {
  /** Executable to spawn. Default: `'neuronest-headless'`. */
  command?: string;
  /** Argv to pass. Default: `['--protocol-version', '1']`. */
  args?: ReadonlyArray<string>;
  /** Optional cwd override (default: `process.cwd()`). */
  cwd?: string;
  /** Optional env override (default: `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Build a default headless spawner using `child_process.spawn`. The
 * resulting child speaks NDJSON over stdin/stdout — Phase 3's
 * Headless_Protocol wire shape for spawned instances. The returned
 * `OpenedTransport` reads from `child.stdout` and writes to
 * `child.stdin`; closing the transport drains stdin and sends
 * `SIGTERM`.
 */
export function createDefaultHeadlessSpawner(
  opts: DefaultHeadlessSpawnerOptions = {},
): HeadlessSpawner {
  const command = opts.command ?? 'neuronest-headless';
  const args = opts.args ?? ['--protocol-version', '1'];

  return async () => {
    return await new Promise<
      | { ok: true; transport: OpenedTransport }
      | { ok: false; detail: string }
    >((resolve) => {
      let child: ChildProcess;
      try {
        child = childSpawn(command, [...args], {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: opts.cwd,
          env: opts.env,
        });
      } catch (err) {
        resolve({
          ok: false,
          detail: `spawn() threw: ${(err as Error).message}`,
        });
        return;
      }

      let settled = false;

      const onSpawnError = (err: Error): void => {
        if (settled) return;
        settled = true;
        resolve({
          ok: false,
          detail: `headless spawn failed: ${err.message}`,
        });
      };

      const onExitBeforeReady = (
        code: number | null,
        signal: NodeJS.Signals | null,
      ): void => {
        if (settled) return;
        settled = true;
        resolve({
          ok: false,
          detail:
            'headless instance exited before ready ' +
            `(code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        });
      };

      child.once('error', onSpawnError);
      child.once('exit', onExitBeforeReady);
      child.once('spawn', () => {
        if (settled) return;
        settled = true;
        child.off('error', onSpawnError);
        child.off('exit', onExitBeforeReady);

        const stdin = child.stdin;
        const stdout = child.stdout;
        if (!stdin || !stdout) {
          resolve({
            ok: false,
            detail: 'headless child has no stdio pipes',
          });
          return;
        }

        resolve({
          ok: true,
          transport: ndjsonTransport({
            write: (data) => {
              stdin.write(data);
            },
            readable: stdout,
            close: async () => {
              await new Promise<void>((res) => {
                if (
                  child.exitCode !== null ||
                  child.signalCode !== null
                ) {
                  res();
                  return;
                }
                child.once('exit', () => res());
                try {
                  stdin.end();
                } catch {
                  /* stream may already be closed; nothing to do */
                }
                try {
                  child.kill();
                } catch {
                  /* child may already be dead; ignore */
                }
              });
            },
          }),
        });
      });
    });
  };
}

/** Convenience: a default spawner instance with default command/args. */
export const defaultHeadlessSpawner: HeadlessSpawner =
  createDefaultHeadlessSpawner();

// ─── Orchestrator factory ───────────────────────────────────────

/**
 * Construct a `HeadlessTransport` whose `open()` runs the documented
 * probe-then-spawn ordering:
 *
 *   1. probe the running-app socket; on success return
 *      `{ via: 'running-app' }` (Req 5.8);
 *   2. on probe failure (socket-not-found OR connect-failure) spawn
 *      a headless instance; on success return
 *      `{ via: 'spawned-headless' }` (Req 5.9, 5.10);
 *   3. on both failing, return
 *      `{ ok: false; failure: { kind: 'spawn_failure', detail } }`
 *      with a detail string carrying both upstream failure messages
 *      so the CLI can stderr the full chain (Req 5.11).
 *
 * The hooks `probe` and `spawn` are injectable so task 9.7's
 * property test can spy on call ordering — Property 11 asserts the
 * probe's first-call timestamp precedes the spawn's, that the
 * spawner is never called when the probe succeeds, and that exactly
 * one spawn call follows a probe failure.
 */
export function createHeadlessTransport(
  deps: HeadlessTransportDeps = {},
): HeadlessTransport {
  const platform = deps.platform ?? process.platform;
  const homedir = deps.homedir ?? os.homedir;
  const socketPath =
    deps.socketPath ?? defaultSocketPath(platform, homedir);
  const probe = deps.probe ?? defaultRunningAppProbe;
  const spawnHelper = deps.spawn ?? defaultHeadlessSpawner;

  return {
    async open(): Promise<HeadlessTransportOpenResult> {
      // Step 1 — probe the running-app socket.
      const probeResult = await probe(socketPath);
      if (probeResult.ok) {
        return {
          ok: true,
          transport: probeResult.transport,
          via: 'running-app',
        };
      }

      // Step 2 — fall back to spawning a headless instance.
      const spawnResult = await spawnHelper();
      if (spawnResult.ok) {
        return {
          ok: true,
          transport: spawnResult.transport,
          via: 'spawned-headless',
        };
      }

      // Step 3 — both failed. The kind is `spawn_failure` because the
      // spawn attempt was the last-line option whose failure decides
      // the open() outcome; the probe failure detail is preserved in
      // the message so callers (Req 5.11 stderr line, CLI exit 1)
      // see the full chain.
      return {
        ok: false,
        failure: {
          kind: 'spawn_failure',
          detail:
            `running-app probe: ${probeResult.detail}; ` +
            `headless spawn: ${spawnResult.detail}`,
        },
      };
    },
  };
}
