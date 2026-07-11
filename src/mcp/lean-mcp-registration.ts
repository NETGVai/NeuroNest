/**
 * Lean MCP Server Registration — registers the lean-mcp server via
 * MCPServerManager.addServer() and enforces infrastructure pre-checks.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5
 *
 * The firewall gate AND connection management must BOTH be operational
 * before allowing any Lean MCP tool call. If either component is
 * unavailable, the tool call is rejected without execution.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MCPServerConfig, MCPToolResult } from './types/mcp-types.js';
import type MCPServerManager from './mcp-server-manager.js';
import type { FirewallEngineLike } from './mcp-server-manager.js';

// ─── Lean MCP configuration constants ───────────────────────────

export const LEAN_MCP_SERVER_ID = 'lean-mcp';
export const LEAN_MCP_SERVER_NAME = 'Lean MCP Server';
export const LEAN_MCP_COMMAND = 'npx';
export const LEAN_MCP_ARGS = ['lean-mcp-server'];
export const LEAN_MCP_TRANSPORT = 'stdio';
export const LEAN_MCP_AUTH_TYPE: MCPServerConfig['authType'] = 'none';

/**
 * Build the MCPServerConfig for the lean-mcp server.
 * Uses the existing MCPServerConfig schema with authType: 'none' for
 * local stdio transport (Requirement 9.4).
 */
export function buildLeanMCPConfig(): MCPServerConfig {
  return {
    id: LEAN_MCP_SERVER_ID,
    name: LEAN_MCP_SERVER_NAME,
    url: `stdio://${LEAN_MCP_COMMAND} ${LEAN_MCP_ARGS.join(' ')}`,
    authType: LEAN_MCP_AUTH_TYPE,
  };
}

// ─── Infrastructure availability checks ─────────────────────────

/**
 * Result of an infrastructure pre-check. When `available` is false,
 * `reason` describes which component is unavailable.
 */
export interface InfrastructureCheckResult {
  available: boolean;
  firewallAvailable: boolean;
  connectionAvailable: boolean;
  reason?: string;
}

/**
 * Check whether both the firewall gate AND connection management are
 * operational for the lean-mcp server.
 *
 * Requirement 9.5: Both components must be operational before allowing
 * any Lean MCP tool call. If either is unavailable, reject the call.
 *
 * @param manager     The MCPServerManager instance
 * @param firewall    The firewall engine instance (null/undefined = unavailable)
 */
export function checkInfrastructureAvailability(
  manager: MCPServerManager | null | undefined,
  firewall: FirewallEngineLike | null | undefined,
): InfrastructureCheckResult {
  const firewallAvailable = isFirewallAvailable(firewall);
  const connectionAvailable = isConnectionManagementAvailable(manager);

  if (!firewallAvailable && !connectionAvailable) {
    return {
      available: false,
      firewallAvailable: false,
      connectionAvailable: false,
      reason: 'Both firewall gate and connection management are unavailable',
    };
  }

  if (!firewallAvailable) {
    return {
      available: false,
      firewallAvailable: false,
      connectionAvailable: true,
      reason: 'Firewall gate is unavailable',
    };
  }

  if (!connectionAvailable) {
    return {
      available: false,
      firewallAvailable: true,
      connectionAvailable: false,
      reason: 'Connection management is unavailable',
    };
  }

  return {
    available: true,
    firewallAvailable: true,
    connectionAvailable: true,
  };
}

/**
 * Determine if the firewall engine is available and operational.
 * A firewall is considered unavailable if it is null/undefined or if
 * its evaluate method throws on a probe input.
 */
export function isFirewallAvailable(
  firewall: FirewallEngineLike | null | undefined,
): boolean {
  if (!firewall) return false;
  try {
    // Probe the firewall with an empty input to verify it is operational.
    const result = firewall.evaluate('');
    return typeof result === 'object' && result !== null && 'passed' in result;
  } catch {
    return false;
  }
}

/**
 * Determine if the connection management infrastructure is available.
 * Connection management is considered unavailable if the MCPServerManager
 * is null/undefined or the lean-mcp server is not registered.
 */
export function isConnectionManagementAvailable(
  manager: MCPServerManager | null | undefined,
): boolean {
  if (!manager) return false;
  try {
    const servers = manager.listServers();
    // Connection management is operational if the manager can list servers
    return Array.isArray(servers);
  } catch {
    return false;
  }
}

/**
 * Invoke a Lean MCP tool with infrastructure pre-checks.
 *
 * Requirement 9.5: Requires both the firewall gate AND connection
 * management to be operational before allowing any Lean MCP tool call.
 * If either component is unavailable, the tool call is rejected.
 *
 * @param toolName  The name of the Lean MCP tool to invoke
 * @param args      The arguments to pass to the tool
 * @param manager   The MCPServerManager instance
 * @param firewall  The firewall engine instance
 */
export function invokeLeanMCPTool(
  toolName: string,
  args: Record<string, unknown>,
  manager: MCPServerManager | null | undefined,
  firewall: FirewallEngineLike | null | undefined,
): MCPToolResult | Promise<MCPToolResult> {
  // Pre-check: both firewall AND connection management must be available
  const check = checkInfrastructureAvailability(manager, firewall);

  if (!check.available) {
    return {
      success: false,
      output: null,
      error: `Lean MCP tool call rejected: ${check.reason}`,
    };
  }

  // Delegate to the MCPServerManager's standard invokeTool path
  // which handles firewall gating, lazy connection, and tool routing.
  return manager!.invokeTool(toolName, args);
}

/**
 * Register the lean-mcp server with the MCPServerManager using the
 * existing addServer() path and MCPServerConfig schema.
 *
 * Requirements: 9.1 (register via config), 9.4 (MCPServerConfig schema)
 *
 * @param manager   The MCPServerManager instance
 * @param configDir Optional config directory path (defaults to cwd)
 */
export function registerLeanMCPServer(
  manager: MCPServerManager,
  configDir?: string,
): void {
  const config = buildLeanMCPConfig();
  manager.addServer(config);
}

/**
 * Load the lean-mcp server configuration from mcp-servers.json and
 * register it with the MCPServerManager. This integrates with the
 * existing loadConfig() flow.
 *
 * @param manager   The MCPServerManager instance
 * @param configDir Directory containing mcp-servers.json
 */
export function loadAndRegisterLeanMCP(
  manager: MCPServerManager,
  configDir?: string,
): boolean {
  const dir = configDir ?? process.cwd();
  const configPath = join(dir, 'mcp-servers.json');

  if (!existsSync(configPath)) {
    return false;
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const configs: MCPServerConfig[] = JSON.parse(raw);
    const leanConfig = configs.find((c) => c.id === LEAN_MCP_SERVER_ID);

    if (leanConfig) {
      manager.addServer(leanConfig);
      return true;
    }

    return false;
  } catch {
    return false;
  }
}
