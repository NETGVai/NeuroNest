/**
 * Session MCP Server Module
 *
 * The `neuronest-session-mcp` process owns session-log, replay, projection,
 * query, export, compaction, spill, plan, accounting, goal, attachment,
 * feedback, and diagnostic surfaces.
 *
 * Requirements: 30.1, 30.3, 30.8–30.12, 32.1–32.2, 32.4–32.7
 */

export { SessionMcpServer, SESSION_PROCESS_NAME } from './session-server.js';
export { NamespaceAdapter, type SurfaceDescriptor, type NamespaceValidationResult } from './namespace-adapter.js';
export {
  SESSION_NAMESPACE_PREFIX,
  SESSION_SURFACE_CATEGORIES,
  MCP_ERROR_CODES,
  type SessionSurfaceCategory,
  type SchemaCompatibilityRange,
  type ProcessCompatibilityInfo,
  type ReadinessState,
  type ReadinessReport,
  type SessionServerConfig,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcError,
  type JsonRpcNotification,
} from './types.js';
