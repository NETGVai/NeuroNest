/**
 * FileTreeCache - Singleton in-memory cache of project directory structures.
 * Eliminates redundant synchronous directory walks by caching the file tree
 * and invalidating on file system events from FileEventEmitter.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileTreeNode, FileTreeCacheOptions } from './types';

/** Default patterns to ignore during directory walk */
const DEFAULT_IGNORE_PATTERNS: string[] = ['node_modules', '.git'];

/**
 * Checks if a directory name should be ignored based on ignore patterns.
 * Hidden directories (starting with '.') are always ignored.
 */
function shouldIgnore(name: string, ignorePatterns: string[]): boolean {
  // Ignore hidden directories (starting with '.')
  if (name.startsWith('.')) {
    return true;
  }
  // Ignore directories matching explicit patterns
  return ignorePatterns.includes(name);
}

/**
 * Resolves a projectId to its absolute directory path.
 */
function resolveProjectDir(projectId: string): string {
  return path.join(os.homedir(), '.neuronest', 'projects', projectId);
}

export class FileTreeCache {
  private static instance: FileTreeCache;

  /** projectId -> cached tree */
  private cache: Map<string, FileTreeNode[]> = new Map();

  /** projectId -> in-flight build promise (prevents duplicate concurrent builds) */
  private building: Map<string, Promise<FileTreeNode[]>> = new Map();

  /** Configuration options */
  private options: FileTreeCacheOptions;

  private constructor(options?: Partial<FileTreeCacheOptions>) {
    this.options = {
      ignorePatterns: options?.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS,
      maxDepth: options?.maxDepth,
    };
  }

  /**
   * Get the singleton instance of FileTreeCache.
   */
  static getInstance(options?: Partial<FileTreeCacheOptions>): FileTreeCache {
    if (!FileTreeCache.instance) {
      FileTreeCache.instance = new FileTreeCache(options);
    }
    return FileTreeCache.instance;
  }

  /**
   * Build or retrieve cached tree for a project.
   * If the cache is populated, returns the cached result immediately.
   * If a build is already in-flight, returns the same promise (dedup).
   * Otherwise, triggers a new async directory walk.
   */
  async getTree(projectId: string): Promise<FileTreeNode[]> {
    // Return cached result if available
    const cached = this.cache.get(projectId);
    if (cached) {
      return cached;
    }

    // If a build is already in-flight for this project, return the same promise
    const inFlight = this.building.get(projectId);
    if (inFlight) {
      return inFlight;
    }

    // Start a new build
    const buildPromise = this.buildTree(projectId);
    this.building.set(projectId, buildPromise);

    try {
      const tree = await buildPromise;
      this.cache.set(projectId, tree);
      return tree;
    } finally {
      this.building.delete(projectId);
    }
  }

  /**
   * Invalidate cache for a project (full rebuild on next access).
   */
  invalidate(projectId: string): void {
    this.cache.delete(projectId);
  }

  /**
   * Partial invalidation: clear the cache and trigger a rebuild of the affected subtree.
   * Since the tree is stored as a flat structure per project, this invalidates
   * the entire project cache and triggers a fresh build.
   */
  invalidateSubtree(projectId: string, dirPath: string): void {
    // Clear the full cache for this project
    this.cache.delete(projectId);

    // Trigger an async rebuild in the background (fire-and-forget)
    const buildPromise = this.buildSubtree(projectId, dirPath);
    this.building.set(projectId, buildPromise);

    buildPromise
      .then((tree) => {
        this.cache.set(projectId, tree);
      })
      .catch((err) => {
        console.error(`[FileTreeCache] Error rebuilding subtree for ${projectId}:`, err);
      })
      .finally(() => {
        this.building.delete(projectId);
      });
  }

  /**
   * Check if cache is populated for a project.
   */
  isPopulated(projectId: string): boolean {
    return this.cache.has(projectId);
  }

  /**
   * Subscribe to FileEventEmitter for auto-invalidation.
   * Listens for file change events and triggers cache invalidation.
   */
  connectToFileEvents(emitter: any): void {
    // Listen for file creation events via the onFileCreated handler
    emitter.onFileCreated('file-tree-cache', (event: any) => {
      if (event && event.projectId) {
        const filePath = event.filePath || '';
        const dirPath = path.dirname(filePath);
        this.invalidateSubtree(event.projectId, dirPath);
      }
    });

    // Listen for batched events if available (covers modify/delete)
    if (typeof emitter.onBatchReady === 'function') {
      emitter.onBatchReady('file-tree-cache-batch', (batchedEvent: any) => {
        if (batchedEvent && batchedEvent.projectId) {
          this.invalidate(batchedEvent.projectId);
        }
      });
    }
  }

  /**
   * Perform an async recursive directory walk for a project.
   */
  private async buildTree(projectId: string): Promise<FileTreeNode[]> {
    const projectDir = resolveProjectDir(projectId);

    try {
      await fs.access(projectDir);
    } catch {
      // Directory doesn't exist — return empty array
      return [];
    }

    return this.walkDirectory(projectDir, '', 0);
  }

  /**
   * Rebuild the tree starting from a specific subtree path.
   * Falls back to a full rebuild since the tree is stored as a complete structure.
   */
  private async buildSubtree(projectId: string, _dirPath: string): Promise<FileTreeNode[]> {
    // For simplicity and correctness, rebuild the full tree.
    // The subtree path is used for targeted invalidation signaling,
    // but the cache stores the complete tree per project.
    return this.buildTree(projectId);
  }

  /**
   * Recursively walk a directory, building FileTreeNode[] structure.
   * Applies ignore patterns and respects maxDepth.
   */
  private async walkDirectory(
    dir: string,
    prefix: string,
    depth: number
  ): Promise<FileTreeNode[]> {
    // Respect maxDepth if configured
    if (this.options.maxDepth !== undefined && depth > this.options.maxDepth) {
      return [];
    }

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // Permission denied or directory doesn't exist — skip
      return [];
    }

    const results: FileTreeNode[] = [];

    for (const entry of entries) {
      const name = entry.name;

      // Apply ignore patterns for directories
      if (entry.isDirectory() && shouldIgnore(name, this.options.ignorePatterns)) {
        continue;
      }

      // Skip hidden files as well (starting with '.')
      if (name.startsWith('.') && !entry.isDirectory()) {
        continue;
      }

      const relPath = prefix ? `${prefix}/${name}` : name;
      const fullPath = path.join(dir, name);

      if (entry.isDirectory()) {
        const children = await this.walkDirectory(fullPath, relPath, depth + 1);
        results.push({
          name,
          path: relPath,
          type: 'dir',
          children,
        });
      } else {
        let size: number | undefined;
        try {
          const stat = await fs.stat(fullPath);
          size = stat.size;
        } catch {
          size = 0;
        }
        results.push({
          name,
          path: relPath,
          type: 'file',
          size,
        });
      }
    }

    return results;
  }
}
