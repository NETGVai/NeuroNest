/**
 * Awareness Module — Git and terminal state scoped to workspace/worktree.
 *
 * Exposes GitAwarenessService, TerminalAwarenessService, and the
 * GitTerminalIntegrationService which projects authoritative state into
 * editor/chat, provides workspace-scoped agent tools, and enforces
 * commit/destructive-op confirmation flows.
 *
 * Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8
 */

export { GitAwarenessService } from './git-awareness-service.js';
export type {
  CommitStatus,
  FileStatus,
  DirtyFile,
  ConflictEntry,
  RemoteTracking,
  BlameLine,
  GitState,
  GitCommandRunner,
} from './git-awareness-service.js';

export { TerminalAwarenessService } from './terminal-awareness-service.js';
export type {
  TerminalProcessStatus,
  TerminalProcess,
  CommandRecord,
  TerminalAwarenessConfig,
  TerminalState,
} from './terminal-awareness-service.js';

export { GitTerminalIntegrationService } from './git-terminal-integration.js';
export type {
  GitOperationRisk,
  GitOperationType,
  PermissionLevel,
  CommitFileSelection,
  ProposedCommit,
  DestructiveConfirmation,
  TerminalEvidence,
  GitContextItem,
  TerminalContextItem,
  GitStateProjection,
  GitTerminalIntegrationConfig,
} from './git-terminal-integration.js';
