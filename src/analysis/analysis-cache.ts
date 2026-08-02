/**
 * Disk-based analysis cache with file-level change detection.
 *
 * Stores analysis results at `.neuronest/analysis-cache/{projectId}/analysis.json`
 * and uses content hashing to determine if cached data is still valid.
 *
 * Requirements: 8.2 (cache results to disk, reuse when unchanged),
 *               8.3 (incremental analysis for changed files)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  CacheEntry,
  CacheFileSchema,
  DependencyGraph,
  DependencyNode,
  DependencyEdge,
  AnalysisMetadata,
} from './types.js';
import { SUPPORTED_EXTENSIONS } from './types.js';

/** Current cache schema version for forward compatibility */
const CACHE_VERSION = 1;

export class AnalysisCache {
  private readonly CACHE_DIR = '.neuronest/analysis-cache';

  /**
   * Check if cached data is still valid (no files have changed since last cache).
   * Returns true only if a cache exists and all file hashes still match.
   */
  async isValid(projectId: string, projectPath: string): Promise<boolean> {
    const entry = await this.get(projectId);
    if (!entry) return false;

    const changedFiles = await this.getChangedFiles(projectId, projectPath);
    return changedFiles.length === 0;
  }

  /**
   * Get cached analysis result. Returns null if no cache exists or if the
   * cache file is corrupted/unreadable.
   */
  async get(projectId: string): Promise<CacheEntry | null> {
    const cachePath = this.getCachePath(projectId);

    try {
      const raw = await fs.promises.readFile(cachePath, 'utf-8');
      const schema: CacheFileSchema = JSON.parse(raw);

      if (schema.version !== CACHE_VERSION) return null;

      return this.deserialize(schema);
    } catch {
      return null;
    }
  }

  /**
   * Store analysis result with file hashes for future change detection.
   */
  async set(projectId: string, entry: CacheEntry): Promise<void> {
    const cachePath = this.getCachePath(projectId);
    const cacheDir = path.dirname(cachePath);

    await fs.promises.mkdir(cacheDir, { recursive: true });

    const schema = this.serialize(entry);
    const json = JSON.stringify(schema, null, 2);

    await fs.promises.writeFile(cachePath, json, 'utf-8');
  }

  /**
   * Get list of files that have changed since the last cache.
   * Compares stored hashes with current file content hashes.
   * Returns file paths relative to project root.
   */
  async getChangedFiles(projectId: string, projectPath: string): Promise<string[]> {
    const entry = await this.get(projectId);
    if (!entry) return [];

    const changed: string[] = [];
    const currentFiles = await this.discoverSourceFiles(projectPath);
    const cachedHashes = entry.fileHashes;

    // Check for modified or new files
    for (const filePath of currentFiles) {
      const relativePath = path.relative(projectPath, filePath).replace(/\\/g, '/');
      const cachedHash = cachedHashes.get(relativePath);

      if (!cachedHash) {
        // New file not in cache
        changed.push(relativePath);
        continue;
      }

      try {
        const currentHash = await this.hashFile(filePath);
        if (currentHash !== cachedHash) {
          changed.push(relativePath);
        }
      } catch {
        // File can't be read — treat as changed
        changed.push(relativePath);
      }
    }

    // Check for deleted files (in cache but not on disk)
    const currentRelativePaths = new Set(
      currentFiles.map((f) => path.relative(projectPath, f).replace(/\\/g, '/'))
    );
    for (const cachedPath of cachedHashes.keys()) {
      if (!currentRelativePaths.has(cachedPath)) {
        changed.push(cachedPath);
      }
    }

    return changed;
  }

  /**
   * Invalidate cache for a project by deleting the cache file.
   */
  async invalidate(projectId: string): Promise<void> {
    const cachePath = this.getCachePath(projectId);

    try {
      await fs.promises.unlink(cachePath);
    } catch {
      // File doesn't exist or can't be deleted — that's fine
    }
  }

  /**
   * Compute content hash for change detection.
   * Uses SHA-1 via Node's crypto module for speed (hardware-accelerated on
   * most platforms). SHA-1 is not used for security here, only for detecting
   * content changes.
   */
  async hashFile(filePath: string): Promise<string> {
    const content = await fs.promises.readFile(filePath);
    return crypto.createHash('sha1').update(content).digest('hex');
  }

  /**
   * Get the filesystem path for a project's cache file.
   */
  private getCachePath(projectId: string): string {
    return path.join(this.CACHE_DIR, projectId, 'analysis.json');
  }

  /**
   * Discover all source files in a project directory that match supported extensions.
   */
  private async discoverSourceFiles(projectPath: string): Promise<string[]> {
    const files: string[] = [];
    await this.walkDirectory(projectPath, files);
    return files;
  }

  /**
   * Recursively walk a directory collecting source files.
   * Skips node_modules, .git, and other common non-source directories.
   */
  private async walkDirectory(dir: string, results: string[]): Promise<void> {
    const SKIP_DIRS = new Set([
      'node_modules', '.git', 'dist', 'build', 'coverage',
      '.next', '.nuxt', '.output', '.cache', '.neuronest',
    ]);

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          await this.walkDirectory(path.join(dir, entry.name), results);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (SUPPORTED_EXTENSIONS.includes(ext)) {
          results.push(path.join(dir, entry.name));
        }
      }
    }
  }

  /**
   * Serialize a CacheEntry to the JSON-compatible CacheFileSchema format.
   * Converts Map structures to plain objects/arrays for JSON storage.
   */
  private serialize(entry: CacheEntry): CacheFileSchema {
    const nodes: DependencyNode[] = Array.from(entry.graph.nodes.values());
    const edges: DependencyEdge[] = entry.graph.edges;
    const fileHashes: Record<string, string> = Object.fromEntries(entry.fileHashes);

    return {
      version: CACHE_VERSION,
      projectId: entry.projectId,
      analyzedAt: entry.metadata.analyzedAt,
      fileHashes,
      graph: { nodes, edges },
    };
  }

  /**
   * Deserialize a CacheFileSchema from disk into a CacheEntry with
   * proper Map structures and computed adjacency lists.
   */
  private deserialize(schema: CacheFileSchema): CacheEntry {
    const fileHashes = new Map<string, string>(Object.entries(schema.fileHashes));

    const nodes = new Map<string, DependencyNode>();
    for (const node of schema.graph.nodes) {
      nodes.set(node.id, node);
    }

    const edges = schema.graph.edges;

    // Rebuild adjacency maps from edges
    const adjacency = new Map<string, string[]>();
    const reverseAdjacency = new Map<string, string[]>();

    // Initialize all nodes with empty arrays
    for (const nodeId of nodes.keys()) {
      adjacency.set(nodeId, []);
      reverseAdjacency.set(nodeId, []);
    }

    for (const edge of edges) {
      const adj = adjacency.get(edge.source);
      if (adj) {
        adj.push(edge.target);
      } else {
        adjacency.set(edge.source, [edge.target]);
      }

      const revAdj = reverseAdjacency.get(edge.target);
      if (revAdj) {
        revAdj.push(edge.source);
      } else {
        reverseAdjacency.set(edge.target, [edge.source]);
      }
    }

    const metadata: AnalysisMetadata = {
      projectId: schema.projectId,
      projectPath: '',
      analyzedAt: schema.analyzedAt,
      fileCount: nodes.size,
      edgeCount: edges.length,
      parseErrors: 0,
      analysisTimeMs: 0,
    };

    const graph: DependencyGraph = {
      nodes,
      edges,
      adjacency,
      reverseAdjacency,
      metadata,
    };

    return {
      projectId: schema.projectId,
      timestamp: new Date(schema.analyzedAt).getTime(),
      fileHashes,
      graph,
      metadata,
    };
  }
}
