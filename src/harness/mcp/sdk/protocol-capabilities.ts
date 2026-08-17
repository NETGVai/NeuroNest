/**
 * MCP Protocol Capability Declarations
 *
 * Declares what each MCP server supports during initialization handshake.
 * Clients negotiate capabilities before calling methods.
 *
 * Requirements: 30.8–30.9, 32.1
 */

import { z } from 'zod';

// ─── Capability Schemas ─────────────────────────────────────────

export const McpCapabilitySchema = z.object({
  tools: z.boolean().optional(),
  resources: z.boolean().optional(),
  prompts: z.boolean().optional(),
  cancellation: z.boolean().optional(),
  progress: z.boolean().optional(),
  logging: z.boolean().optional(),
});

export const ServerInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  protocolVersion: z.string().min(1),
});

export const ServerHealthSchema = z.object({
  processVersion: z.string().min(1),
  protocolVersion: z.string().min(1),
  uptime: z.number().nonnegative(),
  draining: z.boolean(),
  databaseConnected: z.boolean(),
  databaseCompatible: z.boolean(),
  observedSchemaVersion: z.string().optional(),
  compatibleReadRange: z.array(z.string()).optional(),
  compatibleWriteRange: z.array(z.string()).optional(),
  migrationState: z.enum(['idle', 'in_progress', 'failed']).optional(),
  requiredAuthoritiesAvailable: z.boolean(),
});

export const InitializeParamsSchema = z.object({
  protocolVersion: z.string().min(1),
  clientInfo: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
  }),
  capabilities: McpCapabilitySchema.optional(),
});

export const InitializeResultSchema = z.object({
  protocolVersion: z.string().min(1),
  serverInfo: ServerInfoSchema,
  capabilities: McpCapabilitySchema,
  health: ServerHealthSchema,
});

// ─── Types ──────────────────────────────────────────────────────

export type McpCapability = z.infer<typeof McpCapabilitySchema>;
export type ServerInfo = z.infer<typeof ServerInfoSchema>;
export type ServerHealth = z.infer<typeof ServerHealthSchema>;
export type InitializeParams = z.infer<typeof InitializeParamsSchema>;
export type InitializeResult = z.infer<typeof InitializeResultSchema>;

// ─── Session Server Capabilities ────────────────────────────────

export const SESSION_SERVER_INFO: ServerInfo = {
  name: 'neuronest-session-mcp',
  version: '1.0.0',
  protocolVersion: '2024-11-05',
};

export const SESSION_SERVER_CAPABILITIES: McpCapability = {
  tools: true,
  resources: true,
  prompts: true,
  cancellation: true,
  progress: true,
  logging: true,
};

// ─── Runtime Server Capabilities ────────────────────────────────

export const RUNTIME_SERVER_INFO: ServerInfo = {
  name: 'neuronest-runtime-mcp',
  version: '1.0.0',
  protocolVersion: '2024-11-05',
};

export const RUNTIME_SERVER_CAPABILITIES: McpCapability = {
  tools: true,
  resources: true,
  prompts: true,
  cancellation: true,
  progress: true,
  logging: true,
};
