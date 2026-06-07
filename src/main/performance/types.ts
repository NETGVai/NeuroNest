/**
 * Shared TypeScript interfaces and types for the performance subsystem.
 * These types are used across AsyncCommandRunner, FileTreeCache,
 * LazyModuleLoader, and BoundedMessageStore components.
 */

// ─── AsyncCommandRunner Types ────────────────────────────────────────────────

export interface CommandOptions {
  cwd: string;
  timeout: number;        // ms, default varies by type
  env?: Record<string, string>;
  shell?: boolean;        // default: true
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface CommandProgress {
  commandId: string;
  stream: 'stdout' | 'stderr';
  chunk: string;
}

// ─── FileTreeCache Types ─────────────────────────────────────────────────────

export interface FileTreeNode {
  name: string;
  path: string;           // relative path from project root
  type: 'file' | 'dir';
  size?: number;          // files only
  children?: FileTreeNode[]; // directories only
}

export interface FileTreeCacheOptions {
  ignorePatterns: string[];  // e.g., ['node_modules', '.git', '.*']
  maxDepth?: number;         // default: unlimited
}

// ─── LazyModuleLoader Types ──────────────────────────────────────────────────

export type ModulePriority = 'critical' | 'deferred';

export interface ModuleDefinition {
  name: string;
  priority: ModulePriority;
  factory: () => any;       // initialization function
  dependencies?: string[];  // other module names this depends on
}

// ─── BoundedMessageStore Types ───────────────────────────────────────────────

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  agent?: string;
  isCmd?: boolean;
  timestamp: number;
  sessionId: string;
}

export interface MessagePage {
  messages: StoredMessage[];
  hasMore: boolean;
  oldestTimestamp: number;
}
