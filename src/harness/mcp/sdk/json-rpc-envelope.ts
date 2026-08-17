/**
 * JSON-RPC 2.0 Envelope Types — Internal Protocol Layer
 *
 * These types are INTERNAL to the MCP SDK adapter boundary. They MUST NOT
 * leak into canonical service types (SessionEventV1, ProjectionEnvelopeV1, etc.).
 *
 * Requirements: 30.9–30.10, 32.1–32.5
 */

import { z } from 'zod';

// ─── JSON-RPC 2.0 Base Schemas ──────────────────────────────────

export const JsonRpcVersionSchema = z.literal('2.0');

export const JsonRpcIdSchema = z.union([z.string(), z.number().int()]);

export const JsonRpcRequestSchema = z.object({
  jsonrpc: JsonRpcVersionSchema,
  id: JsonRpcIdSchema,
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

export const JsonRpcNotificationSchema = z.object({
  jsonrpc: JsonRpcVersionSchema,
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

export const JsonRpcErrorDataSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});

export const JsonRpcResponseSchema = z.object({
  jsonrpc: JsonRpcVersionSchema,
  id: JsonRpcIdSchema,
  result: z.unknown().optional(),
  error: JsonRpcErrorDataSchema.optional(),
});

// ─── Types ──────────────────────────────────────────────────────

export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;
export type JsonRpcErrorData = z.infer<typeof JsonRpcErrorDataSchema>;
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;
