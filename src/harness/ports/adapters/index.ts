/**
 * Adapter barrel — re-exports all extension port adapters.
 */

export { McpProcessPort, MCP_PROCESS_PORT_ID } from './mcp-process-port.js';
export type { McpProcessInput, McpProcessOutput } from './mcp-process-port.js';

export { ProviderPort, PROVIDER_PORT_ID } from './provider-port.js';
export type { ProviderPortInput, ProviderPortOutput } from './provider-port.js';

export { SessionPort, SESSION_PORT_ID } from './session-port.js';
export type { SessionPortInput, SessionPortOutput } from './session-port.js';

export { PluginPort, PLUGIN_PORT_ID } from './plugin-port.js';
export type { PluginPortInput, PluginPortOutput } from './plugin-port.js';

export { OrchestrationPort, ORCHESTRATION_PORT_ID } from './orchestration-port.js';
export type { OrchestrationPortInput, OrchestrationPortOutput } from './orchestration-port.js';

export { SkillPort, SKILL_PORT_ID } from './skill-port.js';
export type { SkillPortInput, SkillPortOutput } from './skill-port.js';

export { SecurityPort, SECURITY_PORT_ID } from './security-port.js';
export type { SecurityPortInput, SecurityPortOutput } from './security-port.js';

export { FilesystemPort, FILESYSTEM_PORT_ID } from './filesystem-port.js';
export type { FilesystemPortInput, FilesystemPortOutput } from './filesystem-port.js';

export { ProcessPort, PROCESS_PORT_ID } from './process-port.js';
export type { ProcessPortInput, ProcessPortOutput } from './process-port.js';

export { TerminalPort, TERMINAL_PORT_ID } from './terminal-port.js';
export type { TerminalPortInput, TerminalPortOutput } from './terminal-port.js';

export { LanguageServicePort, LANGUAGE_SERVICE_PORT_ID } from './language-service-port.js';
export type { LanguageServicePortInput, LanguageServicePortOutput } from './language-service-port.js';

export { ToolPort, TOOL_PORT_ID } from './tool-port.js';
export type { ToolPortInput, ToolPortOutput } from './tool-port.js';
