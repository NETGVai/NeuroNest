// ─── MCP_Server_Manager Types ───────────────────────────────────
// Type definitions for Model Context Protocol server management.

export interface MCPServerConfig {
  id: string;
  name: string;
  url: string;
  authType: 'none' | 'oauth2' | 'api_key';
  authConfig?: Record<string, string>;
}

export interface MCPTool {
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPToolResult {
  success: boolean;
  output: unknown;
  error?: string;
}
