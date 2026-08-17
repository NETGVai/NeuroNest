/**
 * Harness MCP Process Supervision module.
 *
 * Provides independent process supervision for the two named harness
 * MCP processes: neuronest-session-mcp and neuronest-runtime-mcp.
 *
 * Requirements: 1.1, 30.5–30.6
 */

export { HarnessProcessSupervisor } from './process-supervisor.js';
export type {
  StdioConnection,
  StdioConnectionFactory,
  HarnessProcessSupervisorOptions,
} from './process-supervisor.js';
export type {
  HarnessProcessName,
  HarnessProcessConfig,
  ProcessLifecycleState,
  ProcessHealthStatus,
  ProcessCapabilities,
  DiscoveredTool,
  LifecycleResult,
  RestartPolicy,
  StartOptions,
  StopOptions,
  RestartOptions,
  UpgradeOptions,
} from './types.js';
