/**
 * MCP_Server_Manager — manages Model Context Protocol server connections,
 * tool discovery, invocation routing, and OAuth token flows.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import type { MCPServerConfig, MCPTool, MCPToolResult } from './types/mcp-types.js';
import {
  BUILT_IN_MCP_SERVERS,
  type BuiltInMCPServerConfig,
} from './built-in-mcp-servers.js';
import { encodeGeneric, encodeGraph, type GraphPayload } from '../serializers/gcf-encoder.js';
import { PERF_FLAGS } from '../main/performance/feature-flags.js';
import { logger } from '../utils/logger.js';

// ─── Dependency Interfaces (for DI / testing) ───────────────────

export interface FirewallEngineLike {
  evaluate(input: string): { passed: boolean; blocked: boolean; sanitized: string };
}

export interface MCPConnectionLike {
  /** Discover tools from the server. */
  listTools(): Promise<MCPTool[]>;
  /** Invoke a tool on the server. */
  callTool(toolName: string, args: Record<string, unknown>): Promise<unknown>;
  /** Close the connection. */
  close(): void;
}

// ─── Default connection factory (simulated) ─────────────────────

function defaultConnectionFactory(
  _config: MCPServerConfig,
): Promise<MCPConnectionLike> {
  // In production this would open a real MCP transport.
  // For now, return a stub that discovers no tools.
  return Promise.resolve({
    listTools: async () => [],
    callTool: async () => ({}),
    close: () => {},
  });
}

// ─── npx cache detection (F9 boot-time registration support) ────

/**
 * Check whether an npx-distributed package is already present in the local
 * npm npx cache at `~/.npm/_npx/`.
 *
 * npx stores each package set under a hashed subdirectory, e.g.
 * `~/.npm/_npx/<hash>/node_modules/<packageName>`. This scans every hashed
 * subdirectory and returns true if any of them contains the requested
 * package under `node_modules`. Scoped names like `@playwright/mcp` are
 * resolved as nested `node_modules/@playwright/mcp` directories.
 *
 * Never throws — returns false on any error (missing cache dir, permission
 * issues, etc.) so it is safe to call on the app boot path.
 *
 * Used by F9 (MCP_Browser_Server) to gracefully skip registration when the
 * package is not cached, avoiding a multi-minute npm download at boot.
 *
 * Requirements: 49 (F9 boot-time registration support)
 */
export function isPackageCached(packageName: string): boolean {
  try {
    if (!packageName) return false;

    const npxCacheDir = join(homedir(), '.npm', '_npx');
    if (!existsSync(npxCacheDir)) return false;

    // npx package directories are hashed subfolders of `_npx`.
    const entries = readdirSync(npxCacheDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Path layout: _npx/<hash>/node_modules/<packageName>
      // For scoped names (`@scope/name`) join() resolves the nested segments.
      const packagePath = join(npxCacheDir, entry.name, 'node_modules', packageName);
      if (existsSync(packagePath)) return true;
    }

    return false;
  } catch {
    // Any failure (missing dir, permission, etc.) is treated as "not cached".
    return false;
  }
}

/** Promisified `execFile` — always invoked with an argv array (never a shell
 * string) so a built-in server's command can never be interpreted as shell
 * syntax (command-injection safety). */
const execFileAsync = promisify(execFile);

/**
 * Derive the cache-warming install invocation for a built-in MCP server as a
 * `{ file, args }` pair suitable for {@link execFile} (an argv array, NEVER a
 * shell string — command-injection safe).
 *
 * The server's launch `command` (e.g. `['npx', '-y', '@playwright/mcp@latest']`)
 * is reused verbatim with a trailing `--version` appended so the package is
 * fetched into the npx cache and the process exits immediately instead of
 * booting the long-lived server. This matches the `installHint`
 * (`npx -y @playwright/mcp@latest --version`) without ever parsing the hint
 * string. The first command element is the executable; the rest are arguments.
 *
 * Returns `null` when no executable can be determined (empty command array).
 *
 * Requirements: 50.2 (one-click install warms the npx cache)
 */
export function builtInInstallCommand(
  config: BuiltInMCPServerConfig,
): { file: string; args: string[] } | null {
  const [file, ...rest] = config.command;
  if (!file) return null;
  return { file, args: [...rest, '--version'] };
}

/**
 * Extract the bare npm package name from a built-in server's launch `command`
 * (e.g. `['npx', '-y', '@playwright/mcp@latest']` → `@playwright/mcp`).
 *
 * The npx package spec is the final argument of the command array. Any version
 * suffix (`@latest`, `@1.2.3`) is stripped so the result matches the directory
 * name npx writes into `~/.npm/_npx/<hash>/node_modules/`. Scoped names keep
 * their leading `@scope/` segment — only a trailing `@version` is removed.
 *
 * Returns an empty string when no package spec can be determined, which makes
 * {@link isPackageCached} return false (and therefore triggers the graceful
 * skip path).
 *
 * Requirements: 49.2 (graceful-skip cache lookup)
 */
export function builtInPackageName(config: BuiltInMCPServerConfig): string {
  const spec = config.command[config.command.length - 1];
  if (!spec || spec.startsWith('-')) return '';
  // A version separator is an `@` that is NOT the leading scope marker
  // (index 0). For `@scope/name@version` this is the second `@`; for
  // `name@version` it is the only `@`.
  const versionAt = spec.lastIndexOf('@');
  if (versionAt > 0) return spec.slice(0, versionAt);
  return spec;
}

// ─── F10 GCF_Wire_Format: MCP boundary surface ──────────────────
//
// One of the four F10_Encoded_Surfaces (design.md "Encoded Surface Wiring").
// This is the MCP tool-call response path — the structured payload an MCP
// server returns that is then handed back to the LLM as context (the
// `dispatchToolCall` response handler in the design, realized here as the
// `invokeTool` response). Per Requirement 54.1 and 55 it is gated by the
// paired `GCF_WIRE_FORMAT` / `GCF_WIRE_FORMAT_SHADOW` flags:
//
//   - GCF_WIRE_FORMAT=true                  → return the GCF encoding to the LLM.
//   - GCF_WIRE_FORMAT=false + SHADOW=true    → compute the encoding for
//                                              telemetry only, keep the JSON.
//   - both flags false                       → skip GCF computation entirely.
//   - encode returns null (Req 51.4)         → fall back to JSON.
//
// All telemetry emission is fail-soft: a metrics-sink or encoder regression
// must never break MCP tool dispatch.
//

/** Metrics_Sink key for the MCP-boundary GCF size savings (Requirement 54.1 / 55). */
export const MCP_BOUNDARY_SAVINGS_METRIC_KEY = 'gcf.mcp_boundary.savings_ratio';

/**
 * Structural Metrics_Sink type — kept local so this module does not import
 * `SessionTelemetryService` directly (mirrors `MetricsSink` in
 * `src/pipeline/swarm-coordinator.ts` / `src/pipeline/tool-executor.ts`). Any
 * object exposing `recordMetric(sessionId, key, value)` satisfies it.
 */
export interface MetricsSink {
  recordMetric(sessionId: string | null, key: string, value: number): void;
}

/**
 * Optional wiring for {@link encodeMcpResponseForLLM}. The sink and sessionId
 * are injected by the caller (the MCP tool-dispatch site). When no sink is
 * reachable, savings telemetry falls back to the debug logger so the Phase 0
 * size-savings signal is never silently dropped.
 */
export interface McpResponseEncodeContext {
  /** Metrics_Sink for `gcf.mcp_boundary.savings_ratio`. Optional. */
  metricsSink?: MetricsSink | null;
  /** Session id for the metric sample. Null/omitted records a global metric. */
  sessionId?: string | null;
}

/** Result of {@link encodeMcpResponseForLLM}: the payload plus how it was encoded. */
export interface McpResponseEncodeResult {
  /** Which encoding the returned `payload` is in. */
  encoding: 'json' | 'gcf';
  /** The body to hand back to the LLM as the MCP tool-call response. */
  payload: string;
}

/** Narrow an MCP response record to the GCF graph profile when graph-shaped. */
function isGraphShapedMcpResponse(record: unknown): record is GraphPayload {
  return (
    typeof record === 'object' &&
    record !== null &&
    typeof (record as { tool?: unknown }).tool === 'string' &&
    Array.isArray((record as { symbols?: unknown }).symbols)
  );
}

/**
 * Emit `gcf.mcp_boundary.savings_ratio` to the Metrics_Sink. `savingsRatio` is
 * the fraction of bytes saved by GCF relative to JSON (0..1; can be negative if
 * GCF is larger). Telemetry must never break a tool call, so failures fall
 * through to the logger hook. When no Metrics_Sink is wired (legacy call
 * sites), the logger is the sink.
 */
function recordMcpBoundarySavings(
  ctx: McpResponseEncodeContext,
  savingsRatio: number,
): void {
  if (!Number.isFinite(savingsRatio)) return;
  const sessionId = ctx.sessionId ?? null;
  try {
    if (ctx.metricsSink) {
      ctx.metricsSink.recordMetric(sessionId, MCP_BOUNDARY_SAVINGS_METRIC_KEY, savingsRatio);
      return;
    }
    logger.debug(`[MCP] ${MCP_BOUNDARY_SAVINGS_METRIC_KEY}=${savingsRatio.toFixed(4)}`);
  } catch {
    // A telemetry regression must never break MCP tool dispatch.
    logger.warn(`[MCP] failed to record ${MCP_BOUNDARY_SAVINGS_METRIC_KEY}`);
  }
}

/**
 * Apply the GCF wire-format to an MCP tool-call response record
 * (F10_Encoded_Surface: MCP boundary). Returns the body to hand back to the
 * LLM plus which encoding it is in.
 *
 * Paired-flag behaviour (Requirements 54.1, 55):
 *  - GCF_WIRE_FORMAT=true            → return the GCF-encoded payload (falls
 *                                      back to JSON on encode failure) and emit
 *                                      savings telemetry.
 *  - GCF_WIRE_FORMAT=false + SHADOW  → compute the encoding for telemetry only;
 *                                      the response payload (`jsonBody`) is
 *                                      returned UNCHANGED.
 *  - both flags false                → skip GCF computation entirely; payload
 *                                      returned unchanged (Requirement 55.4).
 *
 * An encode failure (`null`) deterministically falls back to the existing JSON
 * path (Requirement 51.4 / 54.5). Telemetry is fail-soft — a throwing sink
 * never breaks the response.
 *
 * Backward-compatible: with default flags (GCF_WIRE_FORMAT=false) and no
 * context, the response body is returned unchanged.
 */
export function encodeMcpResponseForLLM(
  record: unknown,
  jsonBody: string,
  ctx: McpResponseEncodeContext = {},
): McpResponseEncodeResult {
  const active = PERF_FLAGS.GCF_WIRE_FORMAT;
  const shadow = PERF_FLAGS.GCF_WIRE_FORMAT_SHADOW;

  // Requirement 55.4: with both flags false, skip GCF computation entirely.
  if (!active && !shadow) {
    return { encoding: 'json', payload: jsonBody };
  }

  // Encode the response record through GCF — the graph profile when the record
  // is graph-shaped, else the generic tabular profile (design F10 table).
  const encoded = isGraphShapedMcpResponse(record)
    ? encodeGraph(record)
    : encodeGeneric(record);

  // Encode failure → fall back to the existing JSON path; emit no telemetry.
  if (encoded === null) {
    return { encoding: 'json', payload: jsonBody };
  }

  // Savings ratio = fraction of bytes GCF saves vs the JSON encoding of the
  // same response. 0.30 means GCF is 30% smaller.
  const jsonBytes = Buffer.byteLength(jsonBody, 'utf8');
  const gcfBytes = Buffer.byteLength(encoded, 'utf8');
  const savingsRatio = jsonBytes > 0 ? 1 - gcfBytes / jsonBytes : 0;
  recordMcpBoundarySavings(ctx, savingsRatio);

  // Active mode returns the GCF payload to the LLM; shadow mode leaves the
  // response payload unchanged (only the telemetry above is emitted).
  return active
    ? { encoding: 'gcf', payload: encoded }
    : { encoding: 'json', payload: jsonBody };
}

// ─── MCPServerManager ───────────────────────────────────────────

export class MCPServerManager {
  private connections: Map<string, MCPConnectionLike> = new Map();
  private toolRegistry: Map<string, MCPTool> = new Map();
  private serverConfigs: Map<string, MCPServerConfig> = new Map();
  private serverStatuses: Map<string, 'connected' | 'disconnected' | 'error'> = new Map();
  private failureCounts: Map<string, number> = new Map();
  /**
   * Outcome of the F9 boot-time auto-registration for each built-in server,
   * keyed by `BuiltInMCPServerConfig.id`. Surfaces the registered / skipped /
   * error state to the MCP settings panel (Requirement 50.1).
   */
  private builtInStatuses: Map<string, 'registered' | 'skipped' | 'error'> = new Map();

  private db: Database.Database | null;
  private firewallEngine: FirewallEngineLike;
  private connectionFactory: (config: MCPServerConfig) => Promise<MCPConnectionLike>;
  private configDir: string;
  private metricsSink: MetricsSink | null;
  /**
   * Runner for the built-in install command (Requirement 50.2). Defaults to a
   * promisified {@link execFile} invoked with an argv array (never a shell
   * string) for command-injection safety. Injectable so tests can warm the
   * cache without spawning a real `npx` subprocess.
   */
  private installRunner: (file: string, args: string[]) => Promise<void>;

  constructor(
    db: Database.Database | null,
    firewallEngine: FirewallEngineLike,
    options?: {
      connectionFactory?: (config: MCPServerConfig) => Promise<MCPConnectionLike>;
      configDir?: string;
      metricsSink?: MetricsSink | null;
      installRunner?: (file: string, args: string[]) => Promise<void>;
    },
  ) {
    this.db = db;
    this.firewallEngine = firewallEngine;
    this.connectionFactory = options?.connectionFactory ?? defaultConnectionFactory;
    this.configDir = options?.configDir ?? process.cwd();
    this.metricsSink = options?.metricsSink ?? null;
    this.installRunner =
      options?.installRunner ??
      (async (file: string, args: string[]) => {
        // execFile with an argv array — never a shell string. A cold npx fetch
        // can take minutes, hence the generous timeout.
        await execFileAsync(file, args, { timeout: 300_000, windowsHide: true });
      });
  }

  // ─── Config loading ─────────────────────────────────────────

  /** Load server configs from mcp-servers.json. */
  loadConfig(): MCPServerConfig[] {
    const configPath = join(this.configDir, 'mcp-servers.json');
    if (!existsSync(configPath)) return [];

    try {
      const raw = readFileSync(configPath, 'utf-8');
      const configs: MCPServerConfig[] = JSON.parse(raw);
      for (const cfg of configs) {
        this.serverConfigs.set(cfg.id, cfg);
        if (!this.serverStatuses.has(cfg.id)) {
          this.serverStatuses.set(cfg.id, 'disconnected');
        }
      }
      return configs;
    } catch {
      return [];
    }
  }

  // ─── F9 Built-in MCP auto-start (boot-time registration) ────

  /**
   * Boot-time auto-registration of the built-in MCP servers
   * (F9 MCP_Browser_Server), gated by `PERF_FLAGS.MCP_BROWSER_AUTOSTART`.
   *
   * For each entry in {@link BUILT_IN_MCP_SERVERS}:
   *  - If the underlying npx package is present in the local npx cache
   *    ({@link isPackageCached}), register it so it is available without manual
   *    configuration (Requirement 49.1).
   *  - Otherwise gracefully SKIP and log a structured skip message naming the
   *    missing package and the install command (`installHint`) — a fresh boot
   *    is never blocked by a multi-minute npm download (Requirements 49.2,
   *    49.3).
   *
   * When the flag is OFF, no auto-registration is attempted. Never throws: a
   * registration failure for one server is recorded as an `error` status and
   * does not block the remaining servers or the boot path.
   *
   * Requirements: 49.1, 49.2, 49.3
   */
  registerBuiltInServers(): void {
    if (!PERF_FLAGS.MCP_BROWSER_AUTOSTART) return;

    for (const config of BUILT_IN_MCP_SERVERS) {
      const packageName = builtInPackageName(config);

      if (!isPackageCached(packageName)) {
        // Requirements 49.2 / 49.3: structured skip message that identifies the
        // missing package and the command users should run to install it.
        this.builtInStatuses.set(config.id, 'skipped');
        logger.info('[MCP] Skipping built-in server — package not in npx cache', {
          serverId: config.id,
          serverName: config.name,
          package: packageName,
          installHint: config.installHint,
        });
        continue;
      }

      try {
        this.registerBuiltInServer(config);
        this.builtInStatuses.set(config.id, 'registered');
      } catch (err) {
        this.builtInStatuses.set(config.id, 'error');
        logger.warn(`[MCP] Failed to register built-in server ${config.id}:`, err);
      }
    }
  }

  /**
   * Register a single built-in (stdio-launched) MCP server config into the
   * manager's server registry so it participates in lazy connect / tool
   * discovery like any other server. The built-in `command` argv is preserved
   * as a `stdio://`-scheme URL so the connection factory can reconstruct the
   * launch invocation.
   */
  private registerBuiltInServer(config: BuiltInMCPServerConfig): void {
    const serverConfig: MCPServerConfig = {
      id: config.id,
      name: config.name,
      url: `stdio://${config.command.join(' ')}`,
      authType: 'none',
    };
    this.serverConfigs.set(serverConfig.id, serverConfig);
    if (!this.serverStatuses.has(serverConfig.id)) {
      this.serverStatuses.set(serverConfig.id, 'disconnected');
    }
  }

  /**
   * Status of a built-in MCP server's boot-time auto-registration, or
   * `undefined` if auto-registration has not run for it. Powers the MCP
   * settings panel's built-in servers section (Requirement 50.1).
   */
  getBuiltInStatus(serverId: string): 'registered' | 'skipped' | 'error' | undefined {
    return this.builtInStatuses.get(serverId);
  }

  /**
   * Snapshot of every recommended built-in MCP server paired with the outcome
   * of its boot-time auto-registration. Powers the MCP settings panel's
   * "Built-in servers" section (Requirement 50.1): each entry carries the
   * config metadata (name, description, installHint) plus a `status` badge of
   * `registered` / `skipped` / `error`. When auto-registration has not run for
   * an entry (e.g. `MCP_BROWSER_AUTOSTART` is off) the status defaults to
   * `skipped` so the panel can still offer the one-click install path.
   */
  listBuiltInServers(): Array<BuiltInMCPServerConfig & { status: 'registered' | 'skipped' | 'error' }> {
    return BUILT_IN_MCP_SERVERS.map((config) => ({
      ...config,
      status: this.builtInStatuses.get(config.id) ?? 'skipped',
    }));
  }

  /**
   * One-click install for a built-in MCP server (Requirement 50.2). Runs the
   * server's cache-warming install command (e.g.
   * `npx -y @playwright/mcp@latest --version`) via {@link execFileAsync} — an
   * argv array, NEVER a shell string, so the command can never be interpreted
   * as shell syntax (command-injection safe) — to populate the npx cache, then
   * re-checks {@link isPackageCached} and re-runs registration so the panel can
   * refresh to the new status.
   *
   * Resolves with the post-install built-in status (`registered` / `skipped` /
   * `error`). The install subprocess is given a generous timeout because a cold
   * `npx` fetch can take minutes; a timeout or non-zero exit leaves the package
   * uncached and yields a `skipped`/`error` status rather than throwing.
   *
   * Requirements: 50.2
   */
  async installBuiltInServer(
    serverId: string,
  ): Promise<{ id: string; status: 'registered' | 'skipped' | 'error' }> {
    const config = BUILT_IN_MCP_SERVERS.find((c) => c.id === serverId);
    if (!config) {
      throw new Error(`Unknown built-in MCP server: ${serverId}`);
    }

    const invocation = builtInInstallCommand(config);
    if (!invocation) {
      this.builtInStatuses.set(config.id, 'error');
      return { id: config.id, status: 'error' };
    }

    // Warm the npx cache. execFile with an argv array — never a shell string.
    try {
      await this.installRunner(invocation.file, invocation.args);
    } catch (err) {
      // The package fetch failed (network, timeout, bad exit). Reflect reality
      // by re-deriving status from the cache below rather than failing hard.
      logger.warn(`[MCP] Install command failed for built-in server ${config.id}:`, err);
    }

    // Re-check the cache and re-run registration so the status reflects the
    // post-install reality (Requirement 50.2 "refreshes status").
    const packageName = builtInPackageName(config);
    if (!isPackageCached(packageName)) {
      this.builtInStatuses.set(config.id, 'skipped');
      return { id: config.id, status: 'skipped' };
    }

    try {
      this.registerBuiltInServer(config);
      this.builtInStatuses.set(config.id, 'registered');
      return { id: config.id, status: 'registered' };
    } catch (err) {
      this.builtInStatuses.set(config.id, 'error');
      logger.warn(`[MCP] Failed to register built-in server ${config.id} after install:`, err);
      return { id: config.id, status: 'error' };
    }
  }

  // ─── Connection management ──────────────────────────────────

  /** Connect to an MCP server and discover tools. Lazy — called on first tool use. */
  async connect(serverId: string): Promise<MCPTool[]> {
    const config = this.serverConfigs.get(serverId);
    if (!config) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }

    try {
      const connection = await this.connectionFactory(config);
      this.connections.set(serverId, connection);

      const tools = await connection.listTools();
      for (const tool of tools) {
        this.toolRegistry.set(tool.name, { ...tool, serverId });
      }

      this.serverStatuses.set(serverId, 'connected');
      this.failureCounts.set(serverId, 0);
      return tools;
    } catch (err) {
      const failures = (this.failureCounts.get(serverId) ?? 0) + 1;
      this.failureCounts.set(serverId, failures);
      this.serverStatuses.set(serverId, 'error');
      throw err;
    }
  }

  // ─── Tool invocation ────────────────────────────────────────

  /** Invoke a tool on an MCP server. Routes to the server that registered the tool. */
  async invokeTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const tool = this.toolRegistry.get(toolName);
    if (!tool) {
      return { success: false, output: null, error: `Unknown tool: ${toolName}` };
    }

    // Lazy connect if not yet connected
    const serverId = tool.serverId;
    if (!this.connections.has(serverId)) {
      try {
        await this.connect(serverId);
      } catch (err) {
        return {
          success: false,
          output: null,
          error: `Failed to connect to server ${serverId}: ${String(err)}`,
        };
      }
    }

    const connection = this.connections.get(serverId);
    if (!connection) {
      return { success: false, output: null, error: `No connection for server ${serverId}` };
    }

    // Firewall gate on input
    const inputStr = JSON.stringify(args);
    const inputEval = this.firewallEngine.evaluate(inputStr);
    if (inputEval.blocked) {
      return { success: false, output: null, error: 'Tool input blocked by firewall' };
    }

    // Call the tool
    let rawOutput: unknown;
    try {
      rawOutput = await connection.callTool(toolName, args);
    } catch (err) {
      const failures = (this.failureCounts.get(serverId) ?? 0) + 1;
      this.failureCounts.set(serverId, failures);
      return { success: false, output: null, error: `Tool call failed: ${String(err)}` };
    }

    // Firewall gate on output
    const outputStr = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
    const outputEval = this.firewallEngine.evaluate(outputStr);
    if (outputEval.blocked) {
      return { success: false, output: null, error: 'Tool output blocked by firewall' };
    }

    this.failureCounts.set(serverId, 0);

    // F10_Encoded_Surface (MCP boundary): apply the GCF wire-format to the
    // tool-call response handed back to the LLM. The pre-existing path returns
    // the raw structured `output`; GCF is applied via the paired-flag pattern
    // (Req 54.1 / 55). With default flags (GCF_WIRE_FORMAT=false) the response
    // is returned UNCHANGED — only shadow telemetry may be emitted — so this is
    // fully backward-compatible. Active mode swaps `output` for the GCF text.
    // `outputStr` is the JSON body already computed for the firewall gate.
    const encodedResponse = encodeMcpResponseForLLM(rawOutput, outputStr, {
      metricsSink: this.metricsSink,
    });
    if (encodedResponse.encoding === 'gcf') {
      return { success: true, output: encodedResponse.payload };
    }

    return { success: true, output: rawOutput };
  }

  // ─── Server management ──────────────────────────────────────

  /** Add a new MCP server config. */
  addServer(config: MCPServerConfig): void {
    this.serverConfigs.set(config.id, config);
    this.serverStatuses.set(config.id, 'disconnected');

    if (this.db) {
      try {
        const stmt = this.db.prepare(
          `INSERT OR REPLACE INTO mcp_servers (id, name, url, auth_type, auth_config, status)
           VALUES (?, ?, ?, ?, ?, 'disconnected')`,
        );
        stmt.run(
          config.id,
          config.name,
          config.url,
          config.authType,
          config.authConfig ? JSON.stringify(config.authConfig) : null,
        );
      } catch {
        // DB write failure is non-fatal
      }
    }
  }

  /** Remove an MCP server config. */
  removeServer(serverId: string): void {
    // Close connection if active
    const conn = this.connections.get(serverId);
    if (conn) {
      conn.close();
      this.connections.delete(serverId);
    }

    // Remove tools registered by this server
    for (const [toolName, tool] of this.toolRegistry) {
      if (tool.serverId === serverId) {
        this.toolRegistry.delete(toolName);
      }
    }

    this.serverConfigs.delete(serverId);
    this.serverStatuses.delete(serverId);
    this.failureCounts.delete(serverId);

    if (this.db) {
      try {
        this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(serverId);
      } catch {
        // DB write failure is non-fatal
      }
    }
  }

  /** List all known servers and their status. */
  listServers(): Array<MCPServerConfig & { status: 'connected' | 'disconnected' | 'error' }> {
    const result: Array<MCPServerConfig & { status: 'connected' | 'disconnected' | 'error' }> = [];
    for (const [id, config] of this.serverConfigs) {
      result.push({
        ...config,
        status: this.serverStatuses.get(id) ?? 'disconnected',
      });
    }
    return result;
  }

  // ─── OAuth token management ─────────────────────────────────

  /** Refresh OAuth token for a server. */
  async refreshToken(serverId: string): Promise<void> {
    const config = this.serverConfigs.get(serverId);
    if (!config) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }
    if (config.authType !== 'oauth2') {
      throw new Error(`Server ${serverId} does not use OAuth 2.0`);
    }

    if (!this.db) {
      throw new Error('Database required for OAuth token management');
    }

    const tokenRow = this.db
      .prepare('SELECT refresh_token FROM mcp_oauth_tokens WHERE server_id = ?')
      .get(serverId) as { refresh_token: string } | undefined;

    if (!tokenRow) {
      throw new Error(`No OAuth token found for server ${serverId}`);
    }

    // Simulate token refresh — in production this would call the OAuth endpoint
    const newAccessToken = randomUUID();
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

    this.db
      .prepare(
        `UPDATE mcp_oauth_tokens
         SET access_token = ?, expires_at = ?
         WHERE server_id = ?`,
      )
      .run(newAccessToken, expiresAt, serverId);
  }

  // ─── Exponential backoff ────────────────────────────────────

  /**
   * Calculate backoff delay for a given number of failures.
   * Formula: min(2000 * 2^(N-1), 120000)
   */
  getBackoffDelay(failures: number): number {
    if (failures <= 0) return 0;
    return Math.min(2000 * Math.pow(2, failures - 1), 120000);
  }

  // ─── Accessors for testing ──────────────────────────────────

  /** Get the tool registry (for testing / inspection). */
  getToolRegistry(): Map<string, MCPTool> {
    return this.toolRegistry;
  }

  /** Get failure count for a server. */
  getFailureCount(serverId: string): number {
    return this.failureCounts.get(serverId) ?? 0;
  }
}

export default MCPServerManager;
