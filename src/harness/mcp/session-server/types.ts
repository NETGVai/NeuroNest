/**
 * Types for the neuronest-session-mcp server.
 *
 * Defines the surface namespace, compatibility declarations, readiness states,
 * and the JSON-RPC envelope used over stdio transport.
 *
 * Requirements: 30.1, 30.3, 30.8–30.12, 32.1–32.2, 32.4–32.7
 */

// ─── Namespace ──────────────────────────────────────────────────

/** The session server exposes ONLY surfaces under this prefix. */
export const SESSION_NAMESPACE_PREFIX = 'neuronest.session.v1' as const;

/** All valid surface categories for the session server. */
export const SESSION_SURFACE_CATEGORIES = [
  'session',
  'replay',
  'projection',
  'query',
  'export',
  'compaction',
  'spill',
  'plan',
  'accounting',
  'goal',
  'attachment',
  'feedback',
  'diagnostic',
] as const;

export type SessionSurfaceCategory = (typeof SESSION_SURFACE_CATEGORIES)[number];

// ─── Compatibility ──────────────────────────────────────────────

export interface SchemaCompatibilityRange {
  readMin: number;
  readMax: number;
  writeMin: number;
  writeMax: number;
}

export interface ProcessCompatibilityInfo {
  processName: string;
  processVersion: string;
  protocolVersion: string;
  schemaRange: SchemaCompatibilityRange;
  observedSchemaVersion: number;
}

// ─── Readiness ──────────────────────────────────────────────────

export type ReadinessState =
  | 'initializing'
  | 'checking_compatibility'
  | 'running_migrations'
  | 'ready'
  | 'incompatible'
  | 'unavailable'
  | 'draining'
  | 'stopped';

export interface ReadinessReport {
  state: ReadinessState;
  processVersion: string;
  protocolVersion: string;
  uptime: number;
  draining: boolean;
  databaseConnected: boolean;
  databaseCompatible: boolean;
  migrationState: 'current' | 'pending' | 'running' | 'failed' | 'unknown';
  requiredAuthoritiesAvailable: boolean;
  reason?: string;
}

// ─── JSON-RPC Envelope ──────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

// ─── MCP Protocol Constants ─────────────────────────────────────

export const MCP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Custom MCP error codes
  INCOMPATIBLE_SCHEMA: -32001,
  DATABASE_UNAVAILABLE: -32002,
  NOT_READY: -32003,
  UNSUPPORTED_VERSION: -32004,
  DRAINING: -32005,
} as const;

// ─── Server Configuration ───────────────────────────────────────

export interface SessionServerConfig {
  /** Path to the SharedDatabase file */
  databasePath: string;
  /** Busy timeout in milliseconds */
  busyTimeoutMs: number;
  /** Synchronous mode for the database */
  synchronous?: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA';
  /** Maximum transaction duration in milliseconds */
  maxTransactionDurationMs: number;
  /** Maximum statements per transaction */
  maxStatementsPerTransaction: number;
  /** Process version */
  processVersion?: string;
  /** Protocol version */
  protocolVersion?: string;
  /** Schema compatibility range for this process */
  schemaRange?: SchemaCompatibilityRange;
}
