/**
 * Extension Ports Module — Public API for NeuroNest authority extension ports.
 *
 * All new harness operations route through these ports, which delegate to their
 * owning NeuroNest authority. No bypass is permitted.
 *
 * Requirements: 1.1–1.6, 25.4, 35.12, 39.13, 43.3
 */

// Core types
export type {
  AuthorityKind,
  ExtensionPortId,
  ExtensionPortRegistration,
  ExtensionPortResult,
  AuthorityDenial,
  DenialCode,
  ExtensionPort,
  ExtensionPortFactory,
} from './types.js';
export { AUTHORITY_LABELS } from './types.js';

// Authority registry
export { AuthorityRegistry } from './authority-registry.js';
export type { BypassAttemptRecord } from './authority-registry.js';

// Base adapter
export { BaseExtensionPortAdapter } from './extension-port-adapter.js';

// Concrete adapters
export {
  McpProcessPort,
  MCP_PROCESS_PORT_ID,
  ProviderPort,
  PROVIDER_PORT_ID,
  SessionPort,
  SESSION_PORT_ID,
  PluginPort,
  PLUGIN_PORT_ID,
  OrchestrationPort,
  ORCHESTRATION_PORT_ID,
  SkillPort,
  SKILL_PORT_ID,
  SecurityPort,
  SECURITY_PORT_ID,
  FilesystemPort,
  FILESYSTEM_PORT_ID,
  ProcessPort,
  PROCESS_PORT_ID,
  TerminalPort,
  TERMINAL_PORT_ID,
  LanguageServicePort,
  LANGUAGE_SERVICE_PORT_ID,
  ToolPort,
  TOOL_PORT_ID,
} from './adapters/index.js';

// Architecture conformance
export {
  checkArchitectureConformance,
  assertArchitectureConformance,
  verifyNoParallelAuthority,
} from './architecture-conformance.js';
export type {
  ConformanceViolation,
  ConformanceRule,
  ConformanceResult,
} from './architecture-conformance.js';
