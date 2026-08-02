/**
 * Dependency Parser — Parses source files and resolves import/export relationships.
 *
 * Builds a file-level dependency graph by extracting import, require, and export-from
 * statements from JavaScript/TypeScript source files. Uses regex-based parsing with
 * optional tree-sitter acceleration when available.
 *
 * Requirements: 1.1 (parse all source files and produce dependency graph),
 *               1.8 (partial parse resilience),
 *               10.1 (edge confidence tagging: EXTRACTED vs INFERRED),
 *               10.3 (relationship type assignment)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  DependencyGraph,
  DependencyNode,
  DependencyEdge,
  EdgeConfidence,
  RelationshipType,
  AnalysisMetadata,
} from './types.js';
import { SUPPORTED_EXTENSIONS } from './types.js';

// ─── Directories to skip during file discovery ───────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '.output', '.cache', '.neuronest',
]);

/**
 * Normalize a file path to always use forward slashes.
 * On Windows, path.relative/join produce backslashes which breaks
 * cross-platform graph node lookups.
 */
function toForwardSlash(p: string): string {
  return p.split(path.sep).join('/');
}

// ─── Import Pattern Regexes ──────────────────────────────────────────────────

/**
 * Matches static ES module imports:
 *   import X from 'source'
 *   import { X } from 'source'
 *   import * as X from 'source'
 *   import 'source' (side-effect)
 */
const ES_IMPORT_RE = /import\s+(?:(?:[\w*{}\s,]+)\s+from\s+)?['"]([^'"]+)['"]/g;

/**
 * Matches CommonJS require statements:
 *   const x = require('source')
 *   require('source')
 */
const REQUIRE_RE = /(?:^|[^.\w])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Matches export-from (re-export) statements:
 *   export { X } from 'source'
 *   export * from 'source'
 *   export { default as X } from 'source'
 */
const EXPORT_FROM_RE = /export\s+(?:(?:\{[^}]*\}|\*)\s+from\s+)['"]([^'"]+)['"]/g;

/**
 * Matches dynamic import() expressions:
 *   import('source')
 *   await import('source')
 */
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Matches extends keyword for inheritance detection:
 *   class X extends Y
 */
const EXTENDS_RE = /class\s+\w+\s+extends\s+(\w+)/g;

/**
 * Matches export statements for counting exported symbols:
 *   export const/let/var/function/class/interface/type/enum/default
 *   export { ... }
 */
const EXPORT_COUNT_RE = /export\s+(?:default\s+)?(?:const|let|var|function|class|interface|type|enum|abstract)\s+|export\s+\{/g;

// ─── Types ───────────────────────────────────────────────────────────────────

interface ParsedImport {
  /** The raw import specifier string */
  specifier: string;
  /** Line number (1-based) where the import appears */
  line: number;
  /** Column number (0-based) */
  column: number;
  /** Whether this is a static import (EXTRACTED) or dynamic (INFERRED) */
  confidence: EdgeConfidence;
  /** The type of relationship this import represents */
  relationshipType: RelationshipType;
}

// ─── DependencyParser Class ──────────────────────────────────────────────────

export class DependencyParser {
  /**
   * Parse all source files in a project and build the dependency graph.
   *
   * @param projectPath - Absolute path to the project root
   * @param extensions - File extensions to include (e.g. ['.ts', '.js'])
   * @returns Complete dependency graph with nodes, edges, and adjacency maps
   */
  async parseProject(projectPath: string, extensions: string[]): Promise<DependencyGraph> {
    const startTime = Date.now();

    // Discover all source files
    const filePaths = await this.discoverSourceFiles(projectPath, extensions);

    // Build a lookup map: relative path → absolute path
    const projectFiles = new Map<string, string>();
    for (const absPath of filePaths) {
      const relPath = toForwardSlash(path.relative(projectPath, absPath));
      projectFiles.set(relPath, absPath);
    }

    // Parse each file to create nodes
    const nodes = new Map<string, DependencyNode>();
    const edges: DependencyEdge[] = [];
    let parseErrors = 0;

    for (const [relPath, absPath] of projectFiles) {
      try {
        const content = await fs.promises.readFile(absPath, 'utf-8');
        const node = this.buildNode(relPath, absPath, content);
        nodes.set(relPath, node);

        // Extract imports and resolve to target nodes
        const fileEdges = this.resolveImports(relPath, absPath, content, projectFiles, projectPath);
        edges.push(...fileEdges);
      } catch {
        // File could not be parsed — count it but continue
        parseErrors++;
      }
    }

    // Build adjacency and reverse-adjacency maps
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
      projectId: path.basename(projectPath),
      projectPath,
      analyzedAt: new Date().toISOString(),
      fileCount: nodes.size,
      edgeCount: edges.length,
      parseErrors,
      analysisTimeMs: Date.now() - startTime,
    };

    return { nodes, edges, adjacency, reverseAdjacency, metadata };
  }

  /**
   * Incremental parsing: reparse only changed files and update the existing graph.
   *
   * @param projectPath - Absolute path to the project root
   * @param changedFiles - Array of relative file paths that have changed
   * @param existingGraph - The previously computed graph to update
   * @returns Updated dependency graph
   */
  async parseIncremental(
    projectPath: string,
    changedFiles: string[],
    existingGraph: DependencyGraph
  ): Promise<DependencyGraph> {
    const startTime = Date.now();
    const extensions = SUPPORTED_EXTENSIONS as unknown as string[];

    // Discover current files on disk
    const filePaths = await this.discoverSourceFiles(projectPath, extensions);
    const projectFiles = new Map<string, string>();
    for (const absPath of filePaths) {
      const relPath = toForwardSlash(path.relative(projectPath, absPath));
      projectFiles.set(relPath, absPath);
    }

    const nodes = new Map(existingGraph.nodes);
    let parseErrors = existingGraph.metadata.parseErrors;

    // Remove edges originating from changed files
    const changedSet = new Set(changedFiles);
    const edges = existingGraph.edges.filter((e) => !changedSet.has(e.source));

    // Remove nodes for deleted files (in changedFiles but not on disk)
    for (const changedFile of changedFiles) {
      if (!projectFiles.has(changedFile)) {
        nodes.delete(changedFile);
        // Also remove edges targeting deleted files
        const idx = edges.length;
        for (let i = idx - 1; i >= 0; i--) {
          if (edges[i].target === changedFile) {
            edges.splice(i, 1);
          }
        }
      }
    }

    // Reparse changed files that still exist
    for (const changedFile of changedFiles) {
      const absPath = projectFiles.get(changedFile);
      if (!absPath) continue; // File was deleted

      try {
        const content = await fs.promises.readFile(absPath, 'utf-8');
        const node = this.buildNode(changedFile, absPath, content);
        nodes.set(changedFile, node);

        const fileEdges = this.resolveImports(changedFile, absPath, content, projectFiles, projectPath);
        edges.push(...fileEdges);
      } catch {
        parseErrors++;
      }
    }

    // Rebuild adjacency maps
    const adjacency = new Map<string, string[]>();
    const reverseAdjacency = new Map<string, string[]>();

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
      projectId: existingGraph.metadata.projectId,
      projectPath,
      analyzedAt: new Date().toISOString(),
      fileCount: nodes.size,
      edgeCount: edges.length,
      parseErrors,
      analysisTimeMs: Date.now() - startTime,
    };

    return { nodes, edges, adjacency, reverseAdjacency, metadata };
  }

  /**
   * Resolve a single file's imports to target node IDs and produce edges.
   *
   * Extracts import/require/export-from statements using regex patterns,
   * resolves relative paths to project files, and tags each edge with
   * confidence and relationship type.
   */
  private resolveImports(
    relPath: string,
    absPath: string,
    content: string,
    projectFiles: Map<string, string>,
    projectPath: string
  ): DependencyEdge[] {
    const edges: DependencyEdge[] = [];
    const seenTargets = new Set<string>();

    const parsedImports = this.extractImports(content, absPath);

    for (const imp of parsedImports) {
      const resolvedTarget = this.resolveSpecifier(imp.specifier, relPath, projectFiles, projectPath);
      if (!resolvedTarget) continue; // External module or unresolvable

      // Avoid duplicate edges to the same target with same relationship
      const edgeKey = `${relPath}->${resolvedTarget}:${imp.relationshipType}`;
      if (seenTargets.has(edgeKey)) continue;
      seenTargets.add(edgeKey);

      const edgeId = this.computeEdgeId(relPath, resolvedTarget, imp.relationshipType);

      edges.push({
        id: edgeId,
        source: relPath,
        target: resolvedTarget,
        confidence: imp.confidence,
        relationshipType: imp.relationshipType,
        sourceLocation: { line: imp.line, column: imp.column },
      });
    }

    return edges;
  }

  /**
   * Extract all imports from file content using regex patterns.
   * Returns parsed imports with specifier, location, confidence, and relationship type.
   */
  private extractImports(content: string, filePath: string): ParsedImport[] {
    const imports: ParsedImport[] = [];
    const lines = content.split('\n');

    // Track which imported names come from which specifier (for extends resolution)
    const importedNames = new Map<string, string>();

    // Static ES imports → EXTRACTED, 'imports'
    let match: RegExpExecArray | null;

    const esImportRe = new RegExp(ES_IMPORT_RE.source, 'gm');
    while ((match = esImportRe.exec(content)) !== null) {
      const specifier = match[1];
      const line = this.getLineNumber(content, match.index);
      imports.push({
        specifier,
        line,
        column: 0,
        confidence: 'EXTRACTED',
        relationshipType: 'imports',
      });

      // Track named imports for extends resolution
      const importLine = match[0];
      const nameMatch = importLine.match(/import\s+(\w+)/);
      if (nameMatch) {
        importedNames.set(nameMatch[1], specifier);
      }
      // Track destructured imports
      const braceMatch = importLine.match(/\{([^}]+)\}/);
      if (braceMatch) {
        const names = braceMatch[1].split(',').map((n) => {
          const parts = n.trim().split(/\s+as\s+/);
          return parts[parts.length - 1].trim();
        });
        for (const name of names) {
          if (name) importedNames.set(name, specifier);
        }
      }
    }

    // CommonJS require → EXTRACTED, 'imports'
    const requireRe = new RegExp(REQUIRE_RE.source, 'gm');
    while ((match = requireRe.exec(content)) !== null) {
      const specifier = match[1];
      const line = this.getLineNumber(content, match.index);
      imports.push({
        specifier,
        line,
        column: 0,
        confidence: 'EXTRACTED',
        relationshipType: 'imports',
      });
    }

    // Export-from (re-export) → EXTRACTED, 're_exports'
    const exportFromRe = new RegExp(EXPORT_FROM_RE.source, 'gm');
    while ((match = exportFromRe.exec(content)) !== null) {
      const specifier = match[1];
      const line = this.getLineNumber(content, match.index);
      imports.push({
        specifier,
        line,
        column: 0,
        confidence: 'EXTRACTED',
        relationshipType: 're_exports',
      });
    }

    // Dynamic import() → INFERRED, 'references'
    const dynamicImportRe = new RegExp(DYNAMIC_IMPORT_RE.source, 'gm');
    while ((match = dynamicImportRe.exec(content)) !== null) {
      const specifier = match[1];
      const line = this.getLineNumber(content, match.index);
      imports.push({
        specifier,
        line,
        column: 0,
        confidence: 'INFERRED',
        relationshipType: 'references',
      });
    }

    // Extends keyword → detect inheritance, link to the import source
    const extendsRe = new RegExp(EXTENDS_RE.source, 'gm');
    while ((match = extendsRe.exec(content)) !== null) {
      const parentName = match[1];
      const specifier = importedNames.get(parentName);
      if (specifier) {
        const line = this.getLineNumber(content, match.index);
        imports.push({
          specifier,
          line,
          column: 0,
          confidence: 'EXTRACTED',
          relationshipType: 'inherits',
        });
      }
    }

    return imports;
  }

  /**
   * Resolve an import specifier to a project-relative file path.
   *
   * Handles:
   * - Relative paths (./foo, ../bar) with extension resolution
   * - Index file resolution (./dir → ./dir/index.ts)
   * - Skips bare/external imports (node_modules packages)
   *
   * @returns The resolved relative path, or null if external/unresolvable
   */
  private resolveSpecifier(
    specifier: string,
    sourceRelPath: string,
    projectFiles: Map<string, string>,
    projectPath: string
  ): string | null {
    // Skip bare imports (external packages) - not starting with . or /
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
      return null;
    }

    // Resolve relative to the source file's directory
    const sourceDir = path.dirname(sourceRelPath);
    const resolvedRel = toForwardSlash(path.normalize(path.join(sourceDir, specifier)));

    // Try exact match first
    if (projectFiles.has(resolvedRel)) {
      return resolvedRel;
    }

    // Try with various extensions
    for (const ext of SUPPORTED_EXTENSIONS) {
      const withExt = resolvedRel + ext;
      if (projectFiles.has(withExt)) {
        return withExt;
      }
    }

    // Try index files (./dir → ./dir/index.ext)
    for (const ext of SUPPORTED_EXTENSIONS) {
      const indexPath = toForwardSlash(path.join(resolvedRel, 'index' + ext));
      if (projectFiles.has(indexPath)) {
        return indexPath;
      }
    }

    // Try removing .js extension and replacing with .ts (common in TS projects)
    if (specifier.endsWith('.js')) {
      const withoutJs = resolvedRel.slice(0, -3);
      for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
        const candidate = withoutJs + ext;
        if (projectFiles.has(candidate)) {
          return candidate;
        }
      }
    }

    return null;
  }

  /**
   * Build a DependencyNode from file content.
   */
  private buildNode(relPath: string, absPath: string, content: string): DependencyNode {
    const lineCount = content.split('\n').length;
    const exportCount = (content.match(EXPORT_COUNT_RE) || []).length;

    // Count import statements
    const esImports = (content.match(new RegExp(ES_IMPORT_RE.source, 'gm')) || []).length;
    const requires = (content.match(new RegExp(REQUIRE_RE.source, 'gm')) || []).length;
    const importCount = esImports + requires;

    return {
      id: relPath,
      filePath: absPath,
      label: path.basename(absPath),
      extension: path.extname(absPath),
      lineCount,
      exportCount,
      importCount,
    };
  }

  /**
   * Discover all source files in a project directory matching given extensions.
   * Skips common non-source directories (node_modules, .git, dist, etc.).
   */
  private async discoverSourceFiles(projectPath: string, extensions: string[]): Promise<string[]> {
    const files: string[] = [];
    await this.walkDirectory(projectPath, files, new Set(extensions));
    return files;
  }

  /**
   * Recursively walk a directory collecting source files.
   */
  private async walkDirectory(
    dir: string,
    results: string[],
    extensions: Set<string>
  ): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          await this.walkDirectory(path.join(dir, entry.name), results, extensions);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (extensions.has(ext)) {
          results.push(path.join(dir, entry.name));
        }
      }
    }
  }

  /**
   * Get the 1-based line number for a character offset in content.
   */
  private getLineNumber(content: string, offset: number): number {
    let line = 1;
    for (let i = 0; i < offset && i < content.length; i++) {
      if (content[i] === '\n') line++;
    }
    return line;
  }

  /**
   * Compute a deterministic edge ID from source, target, and relationship type.
   */
  private computeEdgeId(source: string, target: string, relationshipType: RelationshipType): string {
    const raw = `${source}->${target}:${relationshipType}`;
    return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
  }
}
