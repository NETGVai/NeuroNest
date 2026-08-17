/**
 * MCP Structured Errors with Alternatives
 *
 * Defines typed error codes, structured error responses, and alternative
 * suggestions per Requirement 32.5. Errors include the supported alternatives
 * so clients can recover predictably.
 *
 * Requirements: 30.10, 32.5
 */

import { z } from 'zod';

// ─── Error Codes ────────────────────────────────────────────────

/**
 * Standard JSON-RPC error codes plus MCP-specific extensions.
 */
export const McpErrorCode = {
  // Standard JSON-RPC
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,

  // MCP protocol extensions
  Cancelled: -32800,
  ContentTooLarge: -32801,

  // NeuroNest harness-specific
  UnsupportedVersion: -32900,
  UnsupportedCapability: -32901,
  DatabaseUnavailable: -32902,
  SchemaIncompatible: -32903,
  AuthorizationDenied: -32904,
  ResourceExhausted: -32905,
  Draining: -32906,
  NotReady: -32907,
} as const;

export type McpErrorCodeValue = (typeof McpErrorCode)[keyof typeof McpErrorCode];

// ─── Structured Error with Alternatives ─────────────────────────

export const McpAlternativeSchema = z.object({
  method: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
});

export const McpStructuredErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.object({
    errorClass: z.string().optional(),
    correlationId: z.string().optional(),
    alternatives: z.array(McpAlternativeSchema).optional(),
    supportedVersions: z.array(z.string()).optional(),
    supportedMethods: z.array(z.string()).optional(),
    retryable: z.boolean().optional(),
  }).passthrough().optional(),
});

export type McpAlternative = z.infer<typeof McpAlternativeSchema>;
export type McpStructuredError = z.infer<typeof McpStructuredErrorSchema>;

// ─── Error Builders ─────────────────────────────────────────────

export function createMethodNotFoundError(
  method: string,
  alternatives: McpAlternative[],
): McpStructuredError {
  return {
    code: McpErrorCode.MethodNotFound,
    message: `Method not found: ${method}`,
    data: {
      errorClass: 'method_not_found',
      alternatives,
    },
  };
}

export function createUnsupportedVersionError(
  method: string,
  requestedVersion: string,
  supportedVersions: string[],
): McpStructuredError {
  return {
    code: McpErrorCode.UnsupportedVersion,
    message: `Unsupported version '${requestedVersion}' for method '${method}'`,
    data: {
      errorClass: 'unsupported_version',
      supportedVersions,
      alternatives: supportedVersions.map((v) => ({
        method,
        version: v,
        description: `Use version ${v}`,
      })),
    },
  };
}

export function createDatabaseUnavailableError(
  correlationId?: string,
): McpStructuredError {
  return {
    code: McpErrorCode.DatabaseUnavailable,
    message: 'Shared database is unavailable',
    data: {
      errorClass: 'database_unavailable',
      correlationId,
      retryable: true,
    },
  };
}

export function createSchemaIncompatibleError(
  observedVersion: string,
  compatibleRange: string[],
): McpStructuredError {
  return {
    code: McpErrorCode.SchemaIncompatible,
    message: `Schema version '${observedVersion}' is outside compatible range`,
    data: {
      errorClass: 'schema_incompatible',
      supportedVersions: compatibleRange,
      retryable: false,
    },
  };
}

export function createDrainingError(correlationId?: string): McpStructuredError {
  return {
    code: McpErrorCode.Draining,
    message: 'Server is draining and not accepting new work',
    data: {
      errorClass: 'draining',
      correlationId,
      retryable: true,
    },
  };
}

export function createNotReadyError(reason: string): McpStructuredError {
  return {
    code: McpErrorCode.NotReady,
    message: `Server is not ready: ${reason}`,
    data: {
      errorClass: 'not_ready',
      retryable: true,
    },
  };
}
