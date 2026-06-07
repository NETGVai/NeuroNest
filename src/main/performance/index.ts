/**
 * Performance module barrel export.
 * Re-exports all performance-related components, configuration, and types.
 *
 * This module provides a centralized entry point for the performance subsystem:
 * - AsyncCommandRunner: Non-blocking shell command execution with streaming
 * - FileTreeCache: Singleton in-memory directory structure cache
 * - LazyModuleLoader: Deferred module initialization for fast startup
 * - AsyncSystemMonitor: Parallel async system stats collection
 * - PERF_FLAGS: Feature flags for independent component toggling
 * - Shared TypeScript interfaces used across all components
 *
 * Requirements: 8.2, 8.4
 */

import { AsyncCommandRunner } from './async-command-runner';
import { FileTreeCache } from './file-tree-cache';
import { LazyModuleLoader } from './lazy-module-loader';
import { AsyncSystemMonitor } from './async-system-monitor';
import { PERF_FLAGS } from './feature-flags';

// ─── Feature Flags ───────────────────────────────────────────────────────────
export { PERF_FLAGS } from './feature-flags';

// ─── Shared Types ────────────────────────────────────────────────────────────
export type {
  CommandOptions,
  CommandResult,
  CommandProgress,
  FileTreeNode,
  FileTreeCacheOptions,
  ModulePriority,
  ModuleDefinition,
  StoredMessage,
  MessagePage,
} from './types';

// ─── AsyncCommandRunner ──────────────────────────────────────────────────────
export { AsyncCommandRunner } from './async-command-runner';

// ─── FileTreeCache ───────────────────────────────────────────────────────────
export { FileTreeCache } from './file-tree-cache';

// ─── LazyModuleLoader ────────────────────────────────────────────────────────
export { LazyModuleLoader } from './lazy-module-loader';
export type { ModuleState } from './lazy-module-loader';

// ─── AsyncSystemMonitor ──────────────────────────────────────────────────────
export { AsyncSystemMonitor } from './async-system-monitor';
export type {
  CpuCoreInfo,
  CpuStats,
  MemoryStats,
  DiskStats,
  NetworkStats,
  GpuStats,
  FastSystemStats,
  SystemStats,
} from './async-system-monitor';

// ─── Performance Subsystem Initialization ────────────────────────────────────

/**
 * Options for initializing the performance subsystem.
 */
export interface PerformanceInitOptions {
  /** FileEventEmitter instance for FileTreeCache auto-invalidation */
  fileEventEmitter?: any;
  /** Project ID for initial FileTreeCache population */
  projectId?: string;
}

/**
 * Holds references to initialized performance component instances.
 * Each component is independently gated by its feature flag.
 */
export interface PerformanceComponents {
  asyncCommandRunner: AsyncCommandRunner | null;
  fileTreeCache: FileTreeCache | null;
  lazyModuleLoader: LazyModuleLoader | null;
  asyncSystemMonitor: AsyncSystemMonitor | null;
}

/**
 * Initialize all performance components gated by their respective feature flags.
 *
 * This function provides a centralized initialization point for the performance
 * subsystem. Each component is independently controlled by PERF_FLAGS:
 * - PERF_FLAGS.ASYNC_COMMANDS → AsyncCommandRunner + AsyncSystemMonitor
 * - PERF_FLAGS.FILE_TREE_CACHE → FileTreeCache
 * - PERF_FLAGS.LAZY_MODULES → LazyModuleLoader
 *
 * Components that are disabled by their feature flag will be null in the returned object.
 * Existing IPC contracts remain unchanged — all handlers preserve their request/response formats.
 *
 * @param options - Optional configuration for initialization
 * @returns Object containing initialized component instances (or null if disabled)
 */
export function initializePerformanceSubsystem(
  options: PerformanceInitOptions = {}
): PerformanceComponents {
  const components: PerformanceComponents = {
    asyncCommandRunner: null,
    fileTreeCache: null,
    lazyModuleLoader: null,
    asyncSystemMonitor: null,
  };

  // Initialize AsyncCommandRunner (gated by ASYNC_COMMANDS flag)
  if (PERF_FLAGS.ASYNC_COMMANDS) {
    components.asyncCommandRunner = new AsyncCommandRunner();
    components.asyncSystemMonitor = new AsyncSystemMonitor();
  }

  // Initialize FileTreeCache (gated by FILE_TREE_CACHE flag)
  if (PERF_FLAGS.FILE_TREE_CACHE) {
    components.fileTreeCache = FileTreeCache.getInstance();

    // Connect to FileEventEmitter for auto-invalidation if provided
    if (options.fileEventEmitter) {
      components.fileTreeCache.connectToFileEvents(options.fileEventEmitter);
    }

    // Pre-populate cache for the given project if specified
    if (options.projectId && components.fileTreeCache) {
      components.fileTreeCache.getTree(options.projectId).catch((err: Error) => {
        console.error('[Performance] Failed to pre-populate FileTreeCache:', err.message);
      });
    }
  }

  // Initialize LazyModuleLoader (gated by LAZY_MODULES flag)
  if (PERF_FLAGS.LAZY_MODULES) {
    components.lazyModuleLoader = new LazyModuleLoader();
  }

  return components;
}
