/**
 * FileWatcher — Monitors referenced files for changes using OS-native
 * file system notifications via chokidar (FSEvents on macOS, inotify on Linux,
 * ReadDirectoryChanges on Windows).
 *
 * Features:
 * - Debouncing for rapid saves (500ms window)
 * - Source validation (existence + readability checks)
 * - Max sources limit enforcement (default 50)
 * - File deletion detection with 'delete' event emission
 *
 * OWNERSHIP NOTE (FUT-PKG-07-EXPERIENCE/T-004, NN-INDEX-001 / NN-INV-008):
 * this is the LEGACY per-file watch surface. The single owner of filesystem
 * watching for a workspace root is now `IndexCoordinator`
 * (`src/index/index-coordinator.ts`), which produces one ordered, debounced,
 * monotonic change sequence and a deterministic file-tree projection. New and
 * migrating callers SHOULD route through the coordinator as consumers via
 * `FileWatchConsumer` (`src/index/file-watch-consumer.ts`) rather than starting
 * an independent watcher here — an independent watcher must never swap the tree
 * store (NN-INDEX-012). This class is retained unchanged for callers that have
 * not yet migrated (bounded read compatibility).
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 8.6
 */

import { accessSync, constants, existsSync } from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import type { FileChangeEvent } from './types';

// ─── Constants ──────────────────────────────────────────────────

/** Default maximum number of file sources that can be watched concurrently */
export const DEFAULT_MAX_SOURCES = 50;

/** Debounce window in milliseconds for rapid file saves */
export const DEBOUNCE_MS = 500;

// ─── Types ──────────────────────────────────────────────────────

export interface FileWatcherOptions {
  /** Maximum number of concurrent file sources (default: 50) */
  maxSources: number;
}

export interface ValidationResult {
  exists: boolean;
  readable: boolean;
}

// ─── FileWatcher ────────────────────────────────────────────────

/**
 * FileWatcher uses chokidar to watch files for changes and deletions,
 * debouncing rapid save events within a 500ms window.
 */
export class FileWatcher {
  private readonly maxSources: number;
  private readonly watchers: Map<string, FSWatcher> = new Map();
  private readonly debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private readonly callbacks: Map<string, (event: FileChangeEvent) => void> = new Map();

  constructor(options: FileWatcherOptions) {
    this.maxSources = options.maxSources;
  }

  /**
   * Start watching a file for changes and deletions.
   *
   * @param filePath - Absolute path to the file to watch
   * @param callback - Function invoked with a FileChangeEvent on change or deletion
   * @throws Error if the max sources limit would be exceeded
   */
  watch(filePath: string, callback: (event: FileChangeEvent) => void): void {
    // If already watching this file, unwatch first to reset
    if (this.watchers.has(filePath)) {
      this.unwatch(filePath);
    }

    // Enforce max sources limit (Req 2.5)
    if (this.watchers.size >= this.maxSources) {
      throw new Error(
        `MAX_SOURCES_EXCEEDED: Cannot watch more than ${this.maxSources} files. ` +
          `Currently watching ${this.watchers.size} files.`,
      );
    }

    this.callbacks.set(filePath, callback);

    // Create a chokidar watcher for this file (Req 8.6 — OS-native notifications)
    const watcher = chokidar.watch(filePath, {
      persistent: true,
      // Use native events, disable polling
      usePolling: false,
      // Don't emit 'add' on initial watch setup
      ignoreInitial: true,
      // Atomic writes threshold (helps with editors doing save-tmp-rename)
      awaitWriteFinish: false,
    });

    // Handle file changes with debouncing (Req 2.2 — detect within 2s)
    watcher.on('change', () => {
      this.debouncedEmit(filePath, 'change');
    });

    // Handle file deletion (Req 2.4 — detect deletion, emit 'delete' event)
    watcher.on('unlink', () => {
      // Clear any pending debounce timer for this file
      this.clearDebounceTimer(filePath);

      // Emit delete event immediately (no debounce for deletions)
      const event: FileChangeEvent = {
        filePath,
        type: 'delete',
        timestamp: Date.now(),
      };
      const cb = this.callbacks.get(filePath);
      if (cb) {
        cb(event);
      }
    });

    this.watchers.set(filePath, watcher);
  }

  /**
   * Stop watching a specific file.
   *
   * @param filePath - Absolute path to the file to stop watching
   */
  unwatch(filePath: string): void {
    this.clearDebounceTimer(filePath);

    const watcher = this.watchers.get(filePath);
    if (watcher) {
      watcher.close();
      this.watchers.delete(filePath);
    }

    this.callbacks.delete(filePath);
  }

  /**
   * Stop watching all files and clean up all resources.
   */
  unwatchAll(): void {
    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Close all watchers
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();

    this.callbacks.clear();
  }

  /**
   * Validate that a file exists and is readable.
   *
   * @param filePath - Absolute path to the file to validate
   * @returns Object with exists and readable boolean properties
   */
  validateSource(filePath: string): ValidationResult {
    const exists = existsSync(filePath);

    if (!exists) {
      return { exists: false, readable: false };
    }

    let readable = false;
    try {
      accessSync(filePath, constants.R_OK);
      readable = true;
    } catch {
      readable = false;
    }

    return { exists, readable };
  }

  /**
   * Get the number of currently watched files.
   */
  get watchCount(): number {
    return this.watchers.size;
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Emit a change event with debouncing.
   * Rapid saves within the debounce window (500ms) are collapsed into
   * a single event fired at the end of the window.
   */
  private debouncedEmit(filePath: string, type: 'change'): void {
    // Clear any existing debounce timer for this file
    this.clearDebounceTimer(filePath);

    // Set a new debounce timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);

      const event: FileChangeEvent = {
        filePath,
        type,
        timestamp: Date.now(),
      };

      const cb = this.callbacks.get(filePath);
      if (cb) {
        cb(event);
      }
    }, DEBOUNCE_MS);

    this.debounceTimers.set(filePath, timer);
  }

  /**
   * Clear the debounce timer for a specific file path.
   */
  private clearDebounceTimer(filePath: string): void {
    const existing = this.debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
      this.debounceTimers.delete(filePath);
    }
  }
}
