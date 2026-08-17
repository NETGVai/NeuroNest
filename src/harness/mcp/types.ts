/**
 * Types for Harness MCP Process Supervision.
 *
 * Defines configuration, health, and lifecycle types for the two
 * independently managed harness MCP processes:
 * - neuronest-session-mcp
 * - neuronest-runtime-mcp
 *
 * Requirements: 1.1, 30.5–30.6
 */

/**
 * The two named harness processes. Exactly two are permitted; no third
 * harness MCP process or merged session/runtime process is allowed.
 */
export type HarnessProcessName = 'neuronest-session-mcp' | 'neuronest-runtime-mcp';

/**
 * Lifecycle state for a supervised harness process.
 */
export type ProcessLifecycleState =
  | 'absent'      // Not configured or explicitly removed
  | 'disabled'    // Configured but not enabled
  | 'stopped'     // Enabled but not currently running
  | 'starting'    // In the process of starting
  | 'running'     // Actively running and healthy
  | 'stopping'    // Graceful shutdown in progress
  | 'restarting'  // Stop-then-start cycle in progress
  | 'upgrading'   // Replacement in progress (new version)
  | 'error';      // Failed to start or crashed

/**
 * Configuration for a single harness MCP process. Each process has independent
 * executable, arguments, environment, working directory, enablement, and restart
 * settings. (Requirement 30.5)
 */
export interface HarnessProcessConfig {
  /** The process name identifier. */
  readonly name: HarnessProcessName;
  /** Path to the executable. */
  executable: string;
  /** Command-line arguments. */
  args: string[];
  /** Environment variable reference (key to resolve from credential/settings). */
  environmentRef?: string;
  /** Working directory for the process. */
  workingDirectory?: string;
  /** Whether this process is enabled. A disabled process won't be started. */
  enabled: boolean;
  /** Restart policy configuration. */
  restart: RestartPolicy;
}

/**
 * Restart policy for a harness process.
 */
export interface RestartPolicy {
  /** Whether automatic restart on crash is enabled. */
  autoRestart: boolean;
  /** Maximum number of restart attempts before giving up. */
  maxRestarts: number;
  /** Backoff delay in milliseconds between restarts. */
  backoffMs: number;
  /** Maximum backoff delay in milliseconds. */
  maxBackoffMs: number;
}

/**
 * Health status of a single harness process.
 */
export interface ProcessHealthStatus {
  /** The process name. */
  name: HarnessProcessName;
  /** Current lifecycle state. */
  state: ProcessLifecycleState;
  /** Process version if running/reported. */
  processVersion?: string;
  /** Protocol version if negotiated. */
  protocolVersion?: string;
  /** Uptime in milliseconds since last start. */
  uptimeMs?: number;
  /** Whether the process is draining (graceful shutdown in progress). */
  draining: boolean;
  /** Database connectivity status. */
  databaseConnectivity: 'connected' | 'unavailable' | 'incompatible' | 'unknown';
  /** Number of restart attempts since last successful start. */
  restartAttempts: number;
  /** Last error message if in error state. */
  lastError?: string;
  /** Timestamp of last health check. */
  lastHealthCheckAt?: string;
}

/**
 * Capabilities discovered from a harness process.
 */
export interface ProcessCapabilities {
  /** Tools registered by this process. */
  tools: DiscoveredTool[];
  /** Resources exposed by this process. */
  resources: string[];
  /** Prompts exposed by this process. */
  prompts: string[];
  /** Protocol capabilities negotiated. */
  protocolCapabilities: string[];
}

/**
 * A tool discovered from a harness process.
 */
export interface DiscoveredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Result of a lifecycle operation on a harness process.
 */
export interface LifecycleResult {
  success: boolean;
  processName: HarnessProcessName;
  previousState: ProcessLifecycleState;
  currentState: ProcessLifecycleState;
  error?: string;
}

/**
 * Options for starting a harness process.
 */
export interface StartOptions {
  /** Wait for process readiness before returning. */
  waitForReady?: boolean;
  /** Timeout for readiness wait in milliseconds. */
  readyTimeoutMs?: number;
}

/**
 * Options for stopping a harness process.
 */
export interface StopOptions {
  /** Graceful shutdown timeout in milliseconds. */
  gracefulTimeoutMs?: number;
  /** Force kill after graceful timeout expires. */
  forceAfterTimeout?: boolean;
}

/**
 * Options for restarting a harness process.
 */
export interface RestartOptions extends StartOptions, StopOptions {}

/**
 * Options for upgrading a harness process to a new version.
 */
export interface UpgradeOptions extends RestartOptions {
  /** New executable path (if changed). */
  newExecutable?: string;
  /** New arguments (if changed). */
  newArgs?: string[];
  /** New environment reference (if changed). */
  newEnvironmentRef?: string;
}
