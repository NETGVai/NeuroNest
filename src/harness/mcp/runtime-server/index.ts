/**
 * Runtime MCP Server Module
 *
 * The `neuronest-runtime-mcp` executable — an independent stdio MCP server
 * that exposes ONLY neuronest.runtime.v1.* namespaced surfaces for
 * capabilities, prompts, turns, queues, tools, providers, collaboration,
 * orchestration, profiles, execution, credentials, adapters, introspection,
 * and diagnostics.
 *
 * This server does NOT own canonical session projection.
 *
 * Requirements: 25.1, 30.2, 30.4, 30.8–30.12, 32.1, 32.3–32.7
 */

export { RuntimeMcpServer, RUNTIME_PROCESS_NAME } from './runtime-mcp-server.js';
export { RuntimeNamespaceAdapter, type SurfaceDescriptor, type NamespaceValidationResult } from './namespace-adapter.js';
export {
  RUNTIME_NAMESPACE_PREFIX,
  RUNTIME_SURFACE_CATEGORIES,
  MCP_ERROR_CODES,
  type RuntimeServerConfig,
  type RuntimeSurfaceCategory,
  type ReadinessState,
  type ReadinessReport,
  type SchemaCompatibilityRange,
  type ProcessCompatibilityInfo,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcError,
  type JsonRpcNotification,
} from './types.js';
