/**
 * Built_In_MCP_Registry — a curated list of recommended built-in MCP server
 * configurations that the app can auto-discover and register at boot.
 *
 * Unlike {@link MCPServerConfig} (the remote/OAuth-style config consumed by
 * {@link MCPServerManager}), built-in servers are launched locally over stdio
 * via a `command` array (e.g. `npx -y @playwright/mcp@latest`). The optional
 * `installHint` powers the graceful-skip path: when the underlying package is
 * not present in the npx cache, boot logs the hint instead of failing.
 *
 * Requirements: 48 (Built_In_MCP_Registry)
 */

/**
 * Configuration entry for a recommended, locally-launched MCP server.
 *
 * @property id          Stable identifier used for status tracking / dedup.
 * @property name        Human-readable label shown in the MCP settings panel.
 * @property command     Argv array used to spawn the server over stdio.
 * @property description Short summary of the server's capabilities.
 * @property installHint Command users can run to populate the npx cache when
 *                       the package is missing (used by the graceful-skip path).
 */
export interface BuiltInMCPServerConfig {
  id: string;
  name: string;
  command: string[];
  description: string;
  installHint: string;
}

/**
 * Browser_MCP_Server — the Playwright-backed browser MCP server.
 * Runs `npx -y @playwright/mcp@latest` over stdio.
 */
export const BROWSER_MCP_SERVER: BuiltInMCPServerConfig = {
  id: 'playwright-browser',
  name: 'Browser (Playwright)',
  command: ['npx', '-y', '@playwright/mcp@latest'],
  description: 'Page navigation, screenshots, and vision via Playwright.',
  installHint: 'npx -y @playwright/mcp@latest --version',
};

/** The full set of recommended built-in MCP servers. */
export const BUILT_IN_MCP_SERVERS: BuiltInMCPServerConfig[] = [
  BROWSER_MCP_SERVER,
];

export default BUILT_IN_MCP_SERVERS;
