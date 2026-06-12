/**
 * IPC Router — Barrel Export
 *
 * Centralized, Zod-validated IPC handler registry for the Electron main process.
 */

export { IPCRegistry } from './registry.js';
export type {
  IPCHandlerDef,
  IPCResponse,
  IPCValidationError,
  ValidationResult,
} from './types.js';

// ─── Domain Handler Registration ────────────────────────────────
export { registerVoiceHandlers } from './handlers/voice-handlers.js';
export { registerProjectHandlers } from './handlers/project-handlers.js';
export { registerChatHandlers } from './handlers/chat-handlers.js';
export { registerAgentHandlers } from './handlers/agent-handlers.js';
export { registerSettingsHandlers } from './handlers/settings-handlers.js';
export { registerAuthHandlers } from './handlers/auth-handlers.js';
export { registerSwarmHandlers } from './handlers/swarm-handlers.js';
export { registerToolsHandlers } from './handlers/tools-handlers.js';
export { registerFileHandlers } from './handlers/file-handlers.js';
