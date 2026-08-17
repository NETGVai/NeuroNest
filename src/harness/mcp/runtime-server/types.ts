/**
 * Types for the neuronest-runtime-mcp server.
 *
 * Defines the surface namespace, compatibility declarations, readiness states,
 * and the JSON-RPC envelope used over stdio transport.
 *
 * This process owns capability, prompt, turn, queue, tool, provider,
 * collaboration, orchestration, profile, execution, credential, adapter,
 * introspection, and diagnostic surfaces.
 *
 * It does NOT own canonical session projection — that belongs to the session server.
 *
 * Requirements: 25.1, 30.2, 30.4, 30.8–30.12, 32.1, 32.3–32.7
 */

// ─── Namespace ──────────────────────────────────────────────────

/** The runtime server exposes ONLY surfaces under this prefix. */
export const RUNTIME_NAMESPACE_PREFIX = 'neuronest.runtime.v1' as const;

/** All valid surface categories for the runtime server. */
export const RUNTIME_SURFACE_CATEGORIES = [
  'capability',
  'prompt',
  'turn',
  'queue',
  'tool',
  'provider',
  'collaboration',
  'orchestration',
  'profile',
  'execution',
  'credential',
  'adapter',
  'introspection',
  'diagnostic',
] as const;

export type RuntimeSurfaceCategory = (typeof RUNTIME_SURFACE_CATEGORIES)[number];

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

export interface RuntimeServerConfig {
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
