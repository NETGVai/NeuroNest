/**
 * HarnessProcessSupervisor — extends MCP_Server_Manager with independent
 * process supervision for the two named harness MCP processes.
 *
 * Provides:
 * - Typed configuration for each process (neuronest-session-mcp, neuronest-runtime-mcp)
 * - Independent start/stop/restart/upgrade lifecycle per process
 * - stdio connection routing per process
 * - Capability discovery per process
 * - Firewall checks per process
 * - Health monitoring per process
 * - Enablement flags (a process can be disabled without affecting the other)
 *
 * Either process can be absent (not configured/started) while the other is running.
 * Restarting one process does not affect the other.
 *
 * Requirements: 1.1, 30.5–30.6
 */

import type { FirewallEngineLike } from '../../mcp/mcp-server-manager.js';
import type {
  HarnessProcessName,
  HarnessProcessConfig,
  ProcessLifecycleState,
  ProcessHealthStatus,
  ProcessCapabilities,
  DiscoveredTool,
  LifecycleResult,
  StartOptions,
  StopOptions,
  RestartOptions,
  UpgradeOptions,
  RestartPolicy,
} from './types.js';

/**
 * Abstraction for the stdio connection to an MCP process.
 * Allows injection for testing without spawning real processes.
 */
export interface StdioConnection {
  /** Negotiate protocol and discover capabilities. */
  initialize(): Promise<{ protocolVersion: string; capabilities: string[] }>;
  /** List tools available from the process. */
  listTools(): Promise<DiscoveredTool[]>;
  /** Invoke a tool on the process. */
  callTool(toolName: string, args: Record<string, unknown>): Promise<unknown>;
  /** Query health from the process. */
  queryHealth(): Promise<{
    processVersion: string;
    protocolVersion: string;
    uptimeMs: number;
    draining: boolean;
    databaseConnectivity: 'connected' | 'unavailable' | 'incompatible';
  }>;
  /** Send graceful shutdown signal. */
  shutdown(timeoutMs: number): Promise<void>;
  /** Force kill the connection/process. */
  kill(): void;
  /** Whether the connection is alive. */
  isAlive(): boolean;
}

/**
 * Factory for creating stdio connections to harness processes.
 */
export type StdioConnectionFactory = (
  config: HarnessProcessConfig,
) => Promise<StdioConnection>;

/**
 * Options for constructing the HarnessProcessSupervisor.
 */
export interface HarnessProcessSupervisorOptions {
  /** Factory to create stdio connections. Injectable for testing. */
  connectionFactory?: StdioConnectionFactory;
  /** Firewall engine for input/output checks. */
  firewallEngine: FirewallEngineLike;
  /** Default readiness timeout in milliseconds. */
  defaultReadyTimeoutMs?: number;
  /** Default graceful shutdown timeout in milliseconds. */
  defaultGracefulTimeoutMs?: number;
}

/** Default restart policy for harness processes. */
const DEFAULT_RESTART_POLICY: RestartPolicy = {
  autoRestart: true,
  maxRestarts: 3,
  backoffMs: 1000,
  maxBackoffMs: 30_000,
};

/**
 * Internal state tracked per harness process.
 */
interface ProcessEntry {
  config: HarnessProcessConfig;
  state: ProcessLifecycleState;
  connection: StdioConnection | null;
  capabilities: ProcessCapabilities;
  health: ProcessHealthStatus;
  startedAt: number | null;
  restartAttempts: number;
  lastError: string | undefined;
}

/**
 * HarnessProcessSupervisor wraps MCP_Server_Manager's process supervision
 * capabilities for the two named harness MCP processes. Each process has
 * independent configuration, lifecycle, stdio routing, capability discovery,
 * firewall checks, and health monitoring.
 *
 * Requirements: 1.1, 30.5–30.6
 */
export class HarnessProcessSupervisor {
  private readonly processes: Map<HarnessProcessName, ProcessEntry> = new Map();
  private readonly connectionFactory: StdioConnectionFactory;
  private readonly firewallEngine: FirewallEngineLike;
  private readonly defaultReadyTimeoutMs: number;
  private readonly defaultGracefulTimeoutMs: number;

  constructor(options: HarnessProcessSupervisorOptions) {
    this.connectionFactory = options.connectionFactory ?? defaultConnectionFactory;
    this.firewallEngine = options.firewallEngine;
    this.defaultReadyTimeoutMs = options.defaultReadyTimeoutMs ?? 10_000;
    this.defaultGracefulTimeoutMs = options.defaultGracefulTimeoutMs ?? 5_000;
  }

  // ─── Configuration ────────────────────────────────────────────

  /**
   * Configure a harness process. If the process was not previously configured,
   * it enters the 'stopped' state (or 'disabled' if enabled=false).
   * If already configured, the config is updated without affecting a running process.
   */
  configure(config: HarnessProcessConfig): void {
    const existing = this.processes.get(config.name);
    if (existing) {
      // Update config without affecting running state
      existing.config = { ...config };
      // If disabling a running process, it stays running until explicitly stopped
      return;
    }

    const initialState: ProcessLifecycleState = config.enabled ? 'stopped' : 'disabled';
    this.processes.set(config.name, {
      config: { ...config },
      state: initialState,
      connection: null,
      capabilities: { tools: [], resources: [], prompts: [], protocolCapabilities: [] },
      health: makeDefaultHealth(config.name, initialState),
      startedAt: null,
      restartAttempts: 0,
      lastError: undefined,
    });
  }

  /**
   * Remove a process configuration. The process must be stopped first.
   * After removal, the process is considered 'absent'.
   */
  unconfigure(name: HarnessProcessName): LifecycleResult {
    const entry = this.processes.get(name);
    if (!entry) {
      return {
        success: true,
        processName: name,
        previousState: 'absent',
        currentState: 'absent',
      };
    }

    if (entry.state === 'running' || entry.state === 'starting') {
      return {
        success: false,
        processName: name,
        previousState: entry.state,
        currentState: entry.state,
        error: 'Process must be stopped before unconfiguring',
      };
    }

    const previousState = entry.state;
    this.processes.delete(name);
    return {
      success: true,
      processName: name,
      previousState,
      currentState: 'absent',
    };
  }

  /**
   * Get the current configuration for a process, or undefined if not configured.
   */
  getConfig(name: HarnessProcessName): HarnessProcessConfig | undefined {
    return this.processes.get(name)?.config;
  }

  // ─── Enablement ───────────────────────────────────────────────

  /**
   * Enable a process. Does not start it automatically.
   * A disabled process transitions to 'stopped' (ready to be started).
   */
  enable(name: HarnessProcessName): LifecycleResult {
    const entry = this.processes.get(name);
    if (!entry) {
      return {
        success: false,
        processName: name,
        previousState: 'absent',
        currentState: 'absent',
        error: 'Process not configured',
      };
    }

    const previousState = entry.state;
    if (entry.state === 'disabled') {
      entry.state = 'stopped';
      entry.config.enabled = true;
      entry.health = makeDefaultHealth(name, 'stopped');
    } else {
      entry.config.enabled = true;
    }

    return {
      success: true,
      processName: name,
      previousState,
      currentState: entry.state,
    };
  }

  /**
   * Disable a process. If running, it must be stopped first.
   * A disabled process cannot be started.
   */
  disable(name: HarnessProcessName): LifecycleResult {
    const entry = this.processes.get(name);
    if (!entry) {
      return {
        success: false,
        processName: name,
        previousState: 'absent',
        currentState: 'absent',
        error: 'Process not configured',
      };
    }

    if (entry.state === 'running' || entry.state === 'starting') {
      return {
        success: false,
        processName: name,
        previousState: entry.state,
        currentState: entry.state,
        error: 'Process must be stopped before disabling',
      };
    }

    const previousState = entry.state;
    entry.state = 'disabled';
    entry.config.enabled = false;
    entry.health = makeDefaultHealth(name, 'disabled');

    return {
      success: true,
      processName: name,
      previousState,
      currentState: 'disabled',
    };
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  /**
   * Start a harness process. The process must be configured and enabled.
   * Does not affect the other process. (Requirement 30.6)
   */
  async start(name: HarnessProcessName, options?: StartOptions): Promise<LifecycleResult> {
    const entry = this.processes.get(name);
    if (!entry) {
      return {
        success: false,
        processName: name,
        previousState: 'absent',
        currentState: 'absent',
        error: 'Process not configured',
      };
    }

    if (!entry.config.enabled) {
      return {
        success: false,
        processName: name,
        previousState: entry.state,
        currentState: entry.state,
        error: 'Process is disabled',
      };
    }

    if (entry.state === 'running') {
      return {
        success: true,
        processName: name,
        previousState: 'running',
        currentState: 'running',
      };
    }

    if (entry.state !== 'stopped' && entry.state !== 'error') {
      return {
        success: false,
        processName: name,
        previousState: entry.state,
        currentState: entry.state,
        error: `Cannot start process in state: ${entry.state}`,
      };
    }

    const previousState = entry.state;
    entry.state = 'starting';
    entry.health.state = 'starting';

    try {
      const connection = await this.connectionFactory(entry.config);
      const initResult = await connection.initialize();

      entry.connection = connection;
      entry.state = 'running';
      entry.startedAt = Date.now();
      entry.restartAttempts = 0;
      entry.lastError = undefined;
      entry.health = {
        name,
        state: 'running',
        processVersion: undefined,
        protocolVersion: initResult.protocolVersion,
        uptimeMs: 0,
        draining: false,
        databaseConnectivity: 'unknown',
        restartAttempts: 0,
        lastHealthCheckAt: new Date().toISOString(),
      };
      entry.capabilities.protocolCapabilities = initResult.capabilities;

      // Discover tools
      const tools = await connection.listTools();
      entry.capabilities.tools = tools;

      if (options?.waitForReady) {
        // Check health to confirm readiness
        const timeoutMs = options.readyTimeoutMs ?? this.defaultReadyTimeoutMs;
        await this.waitForReady(entry, timeoutMs);
      }

      return {
        success: true,
        processName: name,
        previousState,
        currentState: 'running',
      };
    } catch (err) {
      entry.state = 'error';
      entry.connection = null;
      entry.lastError = err instanceof Error ? err.message : String(err);
      entry.health = {
        ...entry.health,
        state: 'error',
        lastError: entry.lastError,
        lastHealthCheckAt: new Date().toISOString(),
      };

      return {
        success: false,
        processName: name,
        previousState,
        currentState: 'error',
        error: entry.lastError,
      };
    }
  }

  /**
   * Stop a harness process gracefully. Does not affect the other process.
   * (Requirement 30.6)
   */
  async stop(name: HarnessProcessName, options?: StopOptions): Promise<LifecycleResult> {
    const entry = this.processes.get(name);
    if (!entry) {
      return {
        success: false,
        processName: name,
        previousState: 'absent',
        currentState: 'absent',
        error: 'Process not configured',
      };
    }

    if (entry.state === 'stopped' || entry.state === 'disabled') {
      return {
        success: true,
        processName: name,
        previousState: entry.state,
        currentState: entry.state,
      };
    }

    if (entry.state !== 'running' && entry.state !== 'error') {
      return {
        success: false,
        processName: name,
        previousState: entry.state,
        currentState: entry.state,
        error: `Cannot stop process in state: ${entry.state}`,
      };
    }

    const previousState = entry.state;
    entry.state = 'stopping';
    entry.health.state = 'stopping';
    entry.health.draining = true;

    try {
      if (entry.connection && entry.connection.isAlive()) {
        const timeoutMs = options?.gracefulTimeoutMs ?? this.defaultGracefulTimeoutMs;
        await entry.connection.shutdown(timeoutMs);
      }
    } catch {
      // If graceful shutdown fails and force is enabled, kill it
      if (options?.forceAfterTimeout !== false && entry.connection) {
        entry.connection.kill();
      }
    }

    entry.connection = null;
    entry.state = 'stopped';
    entry.startedAt = null;
    entry.capabilities = { tools: [], resources: [], prompts: [], protocolCapabilities: [] };
    entry.health = makeDefaultHealth(name, 'stopped');

    return {
      success: true,
      processName: name,
      previousState,
      currentState: 'stopped',
    };
  }

  /**
   * Restart a harness process. Stops then starts it.
   * Does not affect the other process. (Requirement 30.6)
   */
  async restart(name: HarnessProcessName, options?: RestartOptions): Promise<LifecycleResult> {
    const entry = this.processes.get(name);
    if (!entry) {
      return {
        success: false,
        processName: name,
        previousState: 'absent',
        currentState: 'absent',
        error: 'Process not configured',
      };
    }

    const previousState = entry.state;
    entry.state = 'restarting';
    entry.health.state = 'restarting';

    // Stop if running
    if (entry.connection && entry.connection.isAlive()) {
      try {
        const timeoutMs = options?.gracefulTimeoutMs ?? this.defaultGracefulTimeoutMs;
        await entry.connection.shutdown(timeoutMs);
      } catch {
        if (options?.forceAfterTimeout !== false && entry.connection) {
          entry.connection.kill();
        }
      }
      entry.connection = null;
    }

    // Reset to stopped for start
    entry.state = 'stopped';
    entry.startedAt = null;
    entry.capabilities = { tools: [], resources: [], prompts: [], protocolCapabilities: [] };

    // Start
    const startResult = await this.start(name, {
      waitForReady: options?.waitForReady,
      readyTimeoutMs: options?.readyTimeoutMs,
    });

    return {
      ...startResult,
      previousState,
    };
  }

  /**
   * Upgrade a harness process to a new version. Optionally updates the
   * executable, arguments, or environment before restart.
   * Does not affect the other process.
   */
  async upgrade(name: HarnessProcessName, options?: UpgradeOptions): Promise<LifecycleResult> {
    const entry = this.processes.get(name);
    if (!entry) {
      return {
        success: false,
        processName: name,
        previousState: 'absent',
        currentState: 'absent',
        error: 'Process not configured',
      };
    }

    const previousState = entry.state;
    entry.state = 'upgrading';
    entry.health.state = 'upgrading';

    // Stop if running
    if (entry.connection && entry.connection.isAlive()) {
      try {
        const timeoutMs = options?.gracefulTimeoutMs ?? this.defaultGracefulTimeoutMs;
        await entry.connection.shutdown(timeoutMs);
      } catch {
        if (options?.forceAfterTimeout !== false && entry.connection) {
          entry.connection.kill();
        }
      }
      entry.connection = null;
    }

    // Update config with new values
    if (options?.newExecutable !== undefined) {
      entry.config.executable = options.newExecutable;
    }
    if (options?.newArgs !== undefined) {
      entry.config.args = [...options.newArgs];
    }
    if (options?.newEnvironmentRef !== undefined) {
      entry.config.environmentRef = options.newEnvironmentRef;
    }

    // Reset and start
    entry.state = 'stopped';
    entry.startedAt = null;
    entry.capabilities = { tools: [], resources: [], prompts: [], protocolCapabilities: [] };

    const startResult = await this.start(name, {
      waitForReady: options?.waitForReady,
      readyTimeoutMs: options?.readyTimeoutMs,
    });

    return {
      ...startResult,
      previousState,
    };
  }

  // ─── Capability Discovery ─────────────────────────────────────

  /**
   * Discover capabilities from a specific process.
   * The other process is not queried or affected.
   */
  async discoverCapabilities(name: HarnessProcessName): Promise<ProcessCapabilities | null> {
    const entry = this.processes.get(name);
    if (!entry || entry.state !== 'running' || !entry.connection) {
      return null;
    }

    try {
      const tools = await entry.connection.listTools();
      entry.capabilities.tools = tools;
      return { ...entry.capabilities };
    } catch {
      return null;
    }
  }

  /**
   * Get cached capabilities for a process without re-querying.
   */
  getCapabilities(name: HarnessProcessName): ProcessCapabilities | null {
    const entry = this.processes.get(name);
    if (!entry) return null;
    return { ...entry.capabilities };
  }

  // ─── Stdio Connection Routing ─────────────────────────────────

  /**
   * Invoke a tool on a specific process. The invocation is routed only to
   * the named process; the other process is not involved.
   * Applies firewall checks on input and output.
   */
  async invokeTool(
    name: HarnessProcessName,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; output: unknown; error?: string }> {
    const entry = this.processes.get(name);
    if (!entry) {
      return { success: false, output: null, error: 'Process not configured' };
    }
    if (entry.state !== 'running' || !entry.connection) {
      return { success: false, output: null, error: `Process not running (state: ${entry.state})` };
    }

    // Firewall check on input
    const inputStr = JSON.stringify(args);
    const inputEval = this.firewallEngine.evaluate(inputStr);
    if (inputEval.blocked) {
      return { success: false, output: null, error: 'Tool input blocked by firewall' };
    }

    try {
      const result = await entry.connection.callTool(toolName, args);

      // Firewall check on output
      const outputStr = typeof result === 'string' ? result : JSON.stringify(result);
      const outputEval = this.firewallEngine.evaluate(outputStr);
      if (outputEval.blocked) {
        return { success: false, output: null, error: 'Tool output blocked by firewall' };
      }

      return { success: true, output: result };
    } catch (err) {
      return {
        success: false,
        output: null,
        error: `Tool call failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ─── Health Monitoring ────────────────────────────────────────

  /**
   * Check the health of a specific process. Does not affect the other process.
   */
  async checkHealth(name: HarnessProcessName): Promise<ProcessHealthStatus> {
    const entry = this.processes.get(name);
    if (!entry) {
      return makeDefaultHealth(name, 'absent');
    }

    if (entry.state !== 'running' || !entry.connection) {
      return { ...entry.health };
    }

    try {
      // Check if connection is still alive
      if (!entry.connection.isAlive()) {
        entry.state = 'error';
        entry.lastError = 'Connection lost';
        entry.health = {
          ...entry.health,
          state: 'error',
          lastError: 'Connection lost',
          lastHealthCheckAt: new Date().toISOString(),
        };
        return { ...entry.health };
      }

      const healthData = await entry.connection.queryHealth();
      const uptimeMs = entry.startedAt ? Date.now() - entry.startedAt : 0;

      entry.health = {
        name,
        state: 'running',
        processVersion: healthData.processVersion,
        protocolVersion: healthData.protocolVersion,
        uptimeMs,
        draining: healthData.draining,
        databaseConnectivity: healthData.databaseConnectivity,
        restartAttempts: entry.restartAttempts,
        lastHealthCheckAt: new Date().toISOString(),
      };

      return { ...entry.health };
    } catch (err) {
      entry.health = {
        ...entry.health,
        lastError: err instanceof Error ? err.message : String(err),
        lastHealthCheckAt: new Date().toISOString(),
      };
      return { ...entry.health };
    }
  }

  /**
   * Get the last known health of a process without querying it.
   */
  getHealth(name: HarnessProcessName): ProcessHealthStatus {
    const entry = this.processes.get(name);
    if (!entry) {
      return makeDefaultHealth(name, 'absent');
    }
    return { ...entry.health };
  }

  // ─── State Queries ────────────────────────────────────────────

  /**
   * Get the current lifecycle state of a process.
   */
  getState(name: HarnessProcessName): ProcessLifecycleState {
    const entry = this.processes.get(name);
    if (!entry) return 'absent';
    return entry.state;
  }

  /**
   * Check if a process is currently running.
   */
  isRunning(name: HarnessProcessName): boolean {
    return this.getState(name) === 'running';
  }

  /**
   * Check if a process is configured (regardless of state).
   */
  isConfigured(name: HarnessProcessName): boolean {
    return this.processes.has(name);
  }

  /**
   * List all configured processes with their current states.
   */
  listProcesses(): Array<{ name: HarnessProcessName; state: ProcessLifecycleState; enabled: boolean }> {
    const result: Array<{ name: HarnessProcessName; state: ProcessLifecycleState; enabled: boolean }> = [];
    for (const [name, entry] of this.processes) {
      result.push({ name, state: entry.state, enabled: entry.config.enabled });
    }
    return result;
  }

  // ─── Private Helpers ──────────────────────────────────────────

  private async waitForReady(entry: ProcessEntry, timeoutMs: number): Promise<void> {
    if (!entry.connection) return;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const health = await entry.connection.queryHealth();
        if (health.databaseConnectivity === 'connected') {
          entry.health.databaseConnectivity = 'connected';
          return;
        }
      } catch {
        // Keep polling until timeout
      }
      await sleep(100);
    }
    // Timed out waiting for readiness — not a fatal error, process may still become ready
  }
}

// ─── Utility Functions ──────────────────────────────────────────

function makeDefaultHealth(name: HarnessProcessName, state: ProcessLifecycleState): ProcessHealthStatus {
  return {
    name,
    state,
    draining: false,
    databaseConnectivity: 'unknown',
    restartAttempts: 0,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default connection factory — returns a no-op stub for testing. */
function defaultConnectionFactory(
  _config: HarnessProcessConfig,
): Promise<StdioConnection> {
  return Promise.resolve({
    async initialize() {
      return { protocolVersion: '1.0', capabilities: [] };
    },
    async listTools() {
      return [];
    },
    async callTool() {
      return {};
    },
    async queryHealth() {
      return {
        processVersion: '1.0.0',
        protocolVersion: '1.0',
        uptimeMs: 0,
        draining: false,
        databaseConnectivity: 'connected' as const,
      };
    },
    async shutdown() {},
    kill() {},
    isAlive() {
      return true;
    },
  });
}
