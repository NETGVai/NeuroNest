/**
 * Zod validation schemas for MCP_Server_Manager types.
 *
 * Requirements: 10.1
 */

import { z } from 'zod';

// ─── MCP_Server_Manager ─────────────────────────────────────────

export const MCPServerConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().min(1),
  authType: z.enum(['none', 'oauth2', 'api_key']),
  authConfig: z.record(z.string(), z.string()).optional(),
});

export const MCPToolSchema = z.object({
  serverId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});
