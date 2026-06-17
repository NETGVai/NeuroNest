/**
 * Code Explorer - Background indexing for project structure discovery
 *
 * Provides fast regex-based indexing of files, exports, imports, and symbols.
 * Designed for lightweight project understanding without tree-sitter dependency.
 * Supports incremental updates via file watcher events.
 *
 * Requirements: 19.1, 19.2, 19.3, 19.4
 */

import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';

// ─── Types ──────────────────────────────────────────────────────

export type IndexResultType = 'file' | 'export' | 'import' | 'symbol';

export interface IndexResult {
  filePath: string;
  type: IndexResultType;
  name: string;
  line: number;
}

export interface IndexStats {
  totalFiles: number;
  totalExports: number;
  totalImports: number;
  totalSymbols: number;
  indexingTimeMs: number;
  isComplete: boolean;
}

// ─── Regex Patterns ─────────────────────────────────────────────

/**
 * Match export statements:
 *   export default ...
 *   export const NAME
 *   export function NAME
 *   export class NAME
 *   export interface NAME
 *   export type NAME
 *   export enum NAME
 *   export { NAME, ... }
 */
const EXPORT_PATTERNS = [
  /export\s+(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  /export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/,
  /export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  /export\s+(?:default\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  /export\s+(?:default\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  /export\s+(?:default\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
];

/**
 * Match import statements:
 *   import ... from 'path'
 *   import 'path'
 */
const IMPORT_PATTERN = /import\s+.*?from\s+['"]([^'"]+)['"]/;
const BARE_IMPORT_PATTERN = /^import\s+['"]([^'"]+)['"]/;

/**
 * Match symbol definitions (functions, classes, variables at top level):
 *   function NAME
 *   class NAME
 *   const NAME =
 *   interface NAME
 *   type NAME =
 */
const SYMBOL_PATTERNS = [
  /^(?:export\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[=:]/,
  /^(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  /^(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[=<]/,
  /^(?:export\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
];

// ─── File Extensions ────────────────────────────────────────────

const INDEXABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs',
  '.vue', '.svelte', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.cs', '.cpp', '.c', '.h', '.hpp',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'coverage', '__pycache__', '.venv', 'venv', 'target',
  '.cache', '.turbo', '.output', 'out',
]);

// ─── Code Explorer ──────────────────────────────────────────────

export class CodeExplorer {
  /** File path → list of index entries for that file */
  private fileIndex: Map<string, IndexResult[]> = new Map();
  /** All indexed file paths (relative to project root) */
  private indexedFiles: Set<string> = new Set();
  /** Root project directory */
  private projectDir: string = '';
  /** Indexing stats */
  private stats: IndexStats = {
    totalFiles: 0,
    totalExports: 0,
    totalImports: 0,
    totalSymbols: 0,
    indexingTimeMs: 0,
    isComplete: false,
  };

  /**
   * Start full background indexing of the project directory.
   * Walks the file tree, parses each indexable file, and builds the index.
   * Target: complete within 30s for projects under 10,000 files.
   */
  async startIndexing(projectDir: string): Promise<void> {
    this.projectDir = path.resolve(projectDir);
    this.fileIndex.clear();
    this.indexedFiles.clear();
    this.stats = {
      totalFiles: 0,
      totalExports: 0,
      totalImports: 0,
      totalSymbols: 0,
      indexingTimeMs: 0,
      isComplete: false,
    };

    const startTime = Date.now();
    const files = await this.collectFiles(this.projectDir);

    for (const filePath of files) {
      await this.indexFile(filePath);
    }

    this.stats.indexingTimeMs = Date.now() - startTime;
    this.stats.isComplete = true;
  }

  /**
   * Incrementally update the index for a single file.
   * Called when a file watcher detects a change or creation.
   */
  updateFile(filePath: string): void {
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.projectDir, filePath);

    const relPath = path.relative(this.projectDir, absPath);

    // Remove old entries for this file
    this.removeFileFromIndex(relPath);

    // Re-index the file synchronously (for watcher compatibility)
    // Use a non-blocking approach: schedule indexing
    this.indexFileSync(absPath, relPath);
  }

  /**
   * Remove a file from the index.
   * Called when a file watcher detects a deletion.
   */
  removeFile(filePath: string): void {
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.projectDir, filePath);

    const relPath = path.relative(this.projectDir, absPath);
    this.removeFileFromIndex(relPath);
  }

  /**
   * Query the index by keyword matching against file paths, symbol names,
   * export names, and import paths.
   * Returns matching entries sorted by relevance (exact matches first).
   */
  queryIndex(query: string): IndexResult[] {
    if (!query || query.trim().length === 0) {
      return [];
    }

    const normalizedQuery = query.toLowerCase().trim();
    const results: IndexResult[] = [];
    const scored: Array<{ result: IndexResult; score: number }> = [];

    for (const entries of this.fileIndex.values()) {
      for (const entry of entries) {
        const score = this.computeRelevance(entry, normalizedQuery);
        if (score > 0) {
          scored.push({ result: entry, score });
        }
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Return top results (limit to 50 for performance)
    for (const { result } of scored.slice(0, 50)) {
      results.push(result);
    }

    return results;
  }

  /**
   * Get current indexing statistics.
   */
  getStats(): IndexStats {
    return { ...this.stats };
  }

  /**
   * Get all indexed file paths (relative to project root).
   */
  getIndexedFiles(): string[] {
    return Array.from(this.indexedFiles);
  }

  // ─── Private Methods ────────────────────────────────────────

  /**
   * Walk the directory tree and collect indexable file paths.
   */
  private async collectFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    const walk = async (currentDir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            await walk(path.join(currentDir, entry.name));
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (INDEXABLE_EXTENSIONS.has(ext)) {
            files.push(path.join(currentDir, entry.name));
          }
        }
      }
    };

    await walk(dir);
    return files;
  }

  /**
   * Index a single file: read content, parse exports/imports/symbols.
   */
  private async indexFile(absPath: string): Promise<void> {
    const relPath = path.relative(this.projectDir, absPath);

    let content: string;
    try {
      content = await readFile(absPath, 'utf-8');
    } catch {
      return; // Skip unreadable files
    }

    this.parseAndStore(relPath, content);
  }

  /**
   * Synchronous version of indexFile for incremental updates.
   * Reads and parses the file, storing entries in the index.
   */
  private indexFileSync(absPath: string, relPath: string): void {
    // We use require('fs') for sync read since this is called from watcher
    const fs = require('node:fs');
    let content: string;
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch {
      return; // Skip unreadable files
    }

    this.parseAndStore(relPath, content);
  }

  /**
   * Parse file content and store index entries.
   */
  private parseAndStore(relPath: string, content: string): void {
    const entries: IndexResult[] = [];

    // Add the file itself as an entry
    entries.push({
      filePath: relPath,
      type: 'file',
      name: path.basename(relPath),
      line: 1,
    });
    this.indexedFiles.add(relPath);
    this.stats.totalFiles++;

    // Parse line by line for exports, imports, symbols
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Check exports
      for (const pattern of EXPORT_PATTERNS) {
        const match = line.match(pattern);
        if (match && match[1]) {
          entries.push({
            filePath: relPath,
            type: 'export',
            name: match[1],
            line: lineNum,
          });
          this.stats.totalExports++;
          break; // Only one export per line
        }
      }

      // Check imports
      const importMatch = line.match(IMPORT_PATTERN) || line.match(BARE_IMPORT_PATTERN);
      if (importMatch && importMatch[1]) {
        entries.push({
          filePath: relPath,
          type: 'import',
          name: importMatch[1],
          line: lineNum,
        });
        this.stats.totalImports++;
      }

      // Check symbols (top-level definitions)
      const trimmedLine = line.trimStart();
      if (trimmedLine.length > 0 && line.length - trimmedLine.length <= 2) {
        // Only consider lines with 0-2 leading spaces (top-level)
        for (const pattern of SYMBOL_PATTERNS) {
          const match = trimmedLine.match(pattern);
          if (match && match[1]) {
            // Avoid duplicating entries already captured as exports
            const alreadyExport = entries.some(
              e => e.type === 'export' && e.name === match[1] && e.line === lineNum
            );
            if (!alreadyExport) {
              entries.push({
                filePath: relPath,
                type: 'symbol',
                name: match[1],
                line: lineNum,
              });
              this.stats.totalSymbols++;
            }
            break;
          }
        }
      }
    }

    this.fileIndex.set(relPath, entries);
  }

  /**
   * Remove all index entries for a given file path.
   */
  private removeFileFromIndex(relPath: string): void {
    const existing = this.fileIndex.get(relPath);
    if (existing) {
      // Decrement stats
      for (const entry of existing) {
        switch (entry.type) {
          case 'file':
            this.stats.totalFiles--;
            break;
          case 'export':
            this.stats.totalExports--;
            break;
          case 'import':
            this.stats.totalImports--;
            break;
          case 'symbol':
            this.stats.totalSymbols--;
            break;
        }
      }
      this.fileIndex.delete(relPath);
      this.indexedFiles.delete(relPath);
    }
  }

  /**
   * Compute relevance score for an index entry against a query.
   * Higher score = more relevant.
   */
  private computeRelevance(entry: IndexResult, query: string): number {
    const nameLower = entry.name.toLowerCase();
    const pathLower = entry.filePath.toLowerCase();

    // Exact name match
    if (nameLower === query) {
      return 100;
    }

    // Name starts with query
    if (nameLower.startsWith(query)) {
      return 80;
    }

    // Name contains query
    if (nameLower.includes(query)) {
      return 60;
    }

    // File path contains query
    if (pathLower.includes(query)) {
      return 40;
    }

    // Fuzzy: query chars appear in order in name
    if (this.fuzzyMatch(nameLower, query)) {
      return 20;
    }

    return 0;
  }

  /**
   * Simple fuzzy match: all query characters appear in order in target.
   */
  private fuzzyMatch(target: string, query: string): boolean {
    let qi = 0;
    for (let ti = 0; ti < target.length && qi < query.length; ti++) {
      if (target[ti] === query[qi]) {
        qi++;
      }
    }
    return qi === query.length;
  }
}
