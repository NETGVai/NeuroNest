/**
 * Tree-Sitter Chunker — AST-based code splitting for SemanticIndex
 *
 * Parses source files using web-tree-sitter with language-specific grammars,
 * splitting code into semantic units (functions, classes, methods, top-level blocks).
 * Extracts chunk metadata: name, type, start/end lines, language.
 * Respects `.gitignore` and `.neuronestignore` exclusion files.
 *
 * Follows NeuroNest's lazy-initialized singleton pattern.
 *
 * Requirements: 2.1, 2.6
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────

/** Chunk type for semantic indexing */
export type ChunkType = 'function' | 'class' | 'method' | 'block';

/** A semantic code chunk extracted from a source file */
export interface SemanticChunk {
  /** Unique identifier (hash of file_path + start_line + end_line + content) */
  id: string;
  /** Absolute path to the source file */
  filePath: string;
  /** SHA-256 hash of the file content */
  fileHash: string;
  /** Type of semantic unit */
  chunkType: ChunkType;
  /** Name of the semantic unit (function name, class name, etc.) */
  chunkName: string;
  /** 1-indexed start line */
  startLine: number;
  /** 1-indexed end line */
  endLine: number;
  /** The source code content of this chunk */
  content: string;
  /** Programming language */
  language: string;
}

/** Options for the tree-sitter chunker */
export interface TreeSitterChunkerOptions {
  /** Root directory of the project (for resolving ignore files) */
  projectRoot: string;
  /** Minimum number of lines for a chunk (smaller are promoted to 'block') */
  minChunkLines?: number;
  /** Additional ignore patterns beyond .gitignore and .neuronestignore */
  extraIgnorePatterns?: string[];
}

// ─── Language Configuration ─────────────────────────────────────

/** Supported file extensions and their language mappings */
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
};

/** WASM grammar file names for each language */
const LANGUAGE_WASM_MAP: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
};

/**
 * Node types that correspond to semantic chunk boundaries, per language.
 * Maps tree-sitter node type strings to our ChunkType classification.
 */
const CHUNK_NODE_TYPES: Record<string, Record<string, ChunkType>> = {
  typescript: {
    function_declaration: 'function',
    generator_function_declaration: 'function',
    class_declaration: 'class',
    abstract_class_declaration: 'class',
    method_definition: 'method',
    interface_declaration: 'block',
    type_alias_declaration: 'block',
    enum_declaration: 'block',
  },
  javascript: {
    function_declaration: 'function',
    generator_function_declaration: 'function',
    class_declaration: 'class',
    method_definition: 'method',
  },
  python: {
    function_definition: 'function',
    class_definition: 'class',
  },
  go: {
    function_declaration: 'function',
    method_declaration: 'method',
    type_declaration: 'block',
  },
  rust: {
    function_item: 'function',
    impl_item: 'class',
    trait_item: 'class',
    struct_item: 'block',
    enum_item: 'block',
  },
  java: {
    method_declaration: 'method',
    constructor_declaration: 'method',
    class_declaration: 'class',
    interface_declaration: 'class',
    enum_declaration: 'block',
  },
};

/**
 * Node types for arrow/variable-assigned functions that need special extraction.
 * These require checking the parent (variable_declarator) for the name.
 */
const ARROW_FUNCTION_PARENTS: Record<string, string[]> = {
  typescript: ['lexical_declaration', 'variable_declaration'],
  javascript: ['lexical_declaration', 'variable_declaration'],
};

// ─── Exclusion Pattern Handling ─────────────────────────────────

/**
 * Parse a gitignore-style file into an array of patterns.
 * Skips comments and empty lines.
 */
function parseIgnoreFile(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Check if a file path matches any of the exclusion patterns.
 * Supports basic gitignore-style glob matching:
 * - `dir/` matches directories
 * - `*.ext` matches file extensions
 * - `path/to/file` matches exact relative paths
 * - Leading `/` anchors to project root
 * - `**` matches any number of path segments
 */
function isExcluded(relativePath: string, patterns: string[]): boolean {
  const normalizedPath = relativePath.replace(/\\/g, '/');
  const pathSegments = normalizedPath.split('/');

  for (const pattern of patterns) {
    if (matchesPattern(normalizedPath, pathSegments, pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Match a single gitignore-style pattern against a normalized path.
 */
function matchesPattern(normalizedPath: string, pathSegments: string[], pattern: string): boolean {
  let p = pattern;

  // Negation patterns (starting with !) are not supported in exclusion matching
  if (p.startsWith('!')) return false;

  // Remove trailing slash (directory marker) — we treat dirs and files the same here
  const isDirectoryPattern = p.endsWith('/');
  if (isDirectoryPattern) {
    p = p.slice(0, -1);
  }

  // Anchored pattern (starts with /)
  const isAnchored = p.startsWith('/');
  if (isAnchored) {
    p = p.slice(1);
  }

  // Convert glob pattern to regex
  const regex = globToRegex(p);

  if (isAnchored) {
    // Must match from the start — the path must start with this pattern
    // For directory-like anchored patterns, also match as prefix
    if (regex.test(normalizedPath)) return true;
    // Match as a path prefix (e.g., /dist matches dist/index.js)
    const prefixRegex = new RegExp(`^${globToRegex(p).source.slice(1, -1)}(/|$)`);
    return prefixRegex.test(normalizedPath);
  }

  // Unanchored: match against any suffix of path segments
  // e.g., `node_modules` matches `src/node_modules` and `node_modules`
  if (p.includes('/')) {
    return regex.test(normalizedPath);
  }

  // Simple pattern without slashes: match against any path segment
  for (const segment of pathSegments) {
    if (regex.test(segment)) return true;
  }

  // Also try matching the full path for patterns like *.ext
  return regex.test(normalizedPath);
}

/**
 * Convert a gitignore-style glob pattern to a RegExp.
 */
function globToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches any number of path segments
        if (pattern[i + 2] === '/') {
          regex += '(?:.*/)?';
          i += 3;
        } else {
          regex += '.*';
          i += 2;
        }
      } else {
        // * matches anything except /
        regex += '[^/]*';
        i++;
      }
    } else if (char === '?') {
      regex += '[^/]';
      i++;
    } else if (char === '[') {
      // Character class — pass through
      const close = pattern.indexOf(']', i + 1);
      if (close !== -1) {
        regex += pattern.slice(i, close + 1);
        i = close + 1;
      } else {
        regex += '\\[';
        i++;
      }
    } else if ('.+^${}()|\\'.includes(char!)) {
      regex += '\\' + char;
      i++;
    } else {
      regex += char;
      i++;
    }
  }

  return new RegExp(`^${regex}$`);
}

// ─── Utility Functions ──────────────────────────────────────────

/**
 * Detect language from file extension.
 */
export function detectLanguage(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] || null;
}

/**
 * Generate a stable chunk ID from its identifying attributes.
 */
function generateChunkId(
  filePath: string,
  startLine: number,
  endLine: number,
  content: string
): string {
  const input = `${filePath}:${startLine}:${endLine}:${content}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

/**
 * Compute SHA-256 hash of file content.
 */
function computeFileHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Extract the name from a tree-sitter AST node.
 */
function extractName(node: any, language: string): string {
  // Try the 'name' field first (common across most languages)
  const nameChild = node.childForFieldName?.('name');
  if (nameChild) return nameChild.text;

  // For export statements, look at the declaration inside
  if (node.type === 'export_statement') {
    const decl = node.childForFieldName?.('declaration');
    if (decl) return extractName(decl, language);
  }

  // For variable declarations containing arrow functions
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'variable_declarator') {
        const nameNode = child.childForFieldName?.('name');
        if (nameNode) return nameNode.text;
      }
    }
  }

  // Fallback: find first identifier child
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'identifier' || child.type === 'type_identifier') {
      return child.text;
    }
  }

  return '<anonymous>';
}

// ─── TreeSitterChunker Class ────────────────────────────────────

/**
 * AST-based code splitter using web-tree-sitter.
 *
 * Parses source files into semantic units (functions, classes, methods,
 * top-level blocks) with metadata extraction. Respects .gitignore and
 * .neuronestignore exclusion patterns.
 *
 * Uses lazy initialization for the tree-sitter WASM runtime and
 * per-language grammar loading.
 */
export class TreeSitterChunker {
  private projectRoot: string;
  private minChunkLines: number;
  private exclusionPatterns: string[] | null = null;
  private extraIgnorePatterns: string[];

  // Lazy-initialized tree-sitter state
  private parserModule: any = null;
  private loadedLanguages: Map<string, any> = new Map();
  private initPromise: Promise<void> | null = null;

  constructor(options: TreeSitterChunkerOptions) {
    this.projectRoot = options.projectRoot;
    this.minChunkLines = options.minChunkLines ?? 2;
    this.extraIgnorePatterns = options.extraIgnorePatterns ?? [];
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Parse a single file and return its semantic chunks.
   * Returns an empty array if the file is excluded or the language is unsupported.
   */
  async chunkFile(filePath: string, content: string): Promise<SemanticChunk[]> {
    const language = detectLanguage(filePath);
    if (!language) return [];

    // Check exclusions
    const relativePath = path.relative(this.projectRoot, filePath);
    const patterns = await this.getExclusionPatterns();
    if (isExcluded(relativePath, patterns)) return [];

    // Ensure tree-sitter is initialized
    await this.ensureInitialized();

    // Get language grammar
    const lang = await this.getLanguage(language);
    if (!lang) {
      // Grammar not available, return file as a single block
      return [this.createFileBlock(filePath, content, language)];
    }

    try {
      return this.parseWithTreeSitter(filePath, content, language, lang);
    } catch (error) {
      console.warn(`[TreeSitterChunker] Parse error for ${filePath}:`, error);
      return [this.createFileBlock(filePath, content, language)];
    }
  }

  /**
   * Check if a file should be excluded based on .gitignore and .neuronestignore.
   */
  async isFileExcluded(filePath: string): Promise<boolean> {
    const relativePath = path.relative(this.projectRoot, filePath);
    const patterns = await this.getExclusionPatterns();
    return isExcluded(relativePath, patterns);
  }

  /**
   * Get the list of supported languages.
   */
  getSupportedLanguages(): string[] {
    return Object.keys(CHUNK_NODE_TYPES);
  }

  /**
   * Check if a file's language is supported.
   */
  isLanguageSupported(filePath: string): boolean {
    const language = detectLanguage(filePath);
    return language !== null && language in CHUNK_NODE_TYPES;
  }

  /**
   * Reload exclusion patterns from disk.
   * Call this when .gitignore or .neuronestignore changes.
   */
  invalidateExclusionCache(): void {
    this.exclusionPatterns = null;
  }

  // ─── Private: Tree-sitter Initialization ────────────────────

  /**
   * Lazily initialize the web-tree-sitter module.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.parserModule) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = (async () => {
      try {
        const TreeSitter = await import('web-tree-sitter');
        await TreeSitter.default.init();
        this.parserModule = TreeSitter.default;
      } catch (error) {
        console.warn('[TreeSitterChunker] web-tree-sitter initialization failed:', error);
        this.parserModule = null;
      }
    })();

    await this.initPromise;
  }

  /**
   * Load a language grammar (WASM) for the given language.
   * Caches loaded grammars for reuse.
   */
  private async getLanguage(language: string): Promise<any | null> {
    if (this.loadedLanguages.has(language)) {
      return this.loadedLanguages.get(language) ?? null;
    }

    if (!this.parserModule) return null;

    const wasmFile = LANGUAGE_WASM_MAP[language];
    if (!wasmFile) {
      this.loadedLanguages.set(language, null);
      return null;
    }

    try {
      // Try to resolve WASM from node_modules
      const wasmPath = this.resolveWasmPath(wasmFile);
      if (!wasmPath) {
        this.loadedLanguages.set(language, null);
        return null;
      }
      const lang = await this.parserModule.Language.load(wasmPath);
      this.loadedLanguages.set(language, lang);
      return lang;
    } catch (error) {
      console.warn(`[TreeSitterChunker] Failed to load grammar for ${language}:`, error);
      this.loadedLanguages.set(language, null);
      return null;
    }
  }

  /**
   * Resolve the path to a WASM grammar file.
   * Looks in node_modules and common bundled locations.
   */
  private resolveWasmPath(wasmFile: string): string | null {
    // Potential locations for WASM grammars
    const candidates = [
      path.join(this.projectRoot, 'node_modules', 'web-tree-sitter', wasmFile),
      path.join(this.projectRoot, 'node_modules', `tree-sitter-wasms`, 'out', wasmFile),
      path.join(this.projectRoot, 'assets', 'tree-sitter', wasmFile),
      path.join(__dirname, '..', '..', 'assets', 'tree-sitter', wasmFile),
      path.join(__dirname, '..', '..', 'node_modules', 'web-tree-sitter', wasmFile),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  // ─── Private: Exclusion Pattern Loading ─────────────────────

  /**
   * Load and cache exclusion patterns from .gitignore and .neuronestignore.
   */
  private async getExclusionPatterns(): Promise<string[]> {
    if (this.exclusionPatterns !== null) return this.exclusionPatterns;

    const patterns: string[] = [...this.extraIgnorePatterns];

    // Load .gitignore
    const gitignorePath = path.join(this.projectRoot, '.gitignore');
    try {
      const content = await readFile(gitignorePath, 'utf-8');
      patterns.push(...parseIgnoreFile(content));
    } catch {
      // .gitignore doesn't exist — that's fine
    }

    // Load .neuronestignore
    const neuronestIgnorePath = path.join(this.projectRoot, '.neuronestignore');
    try {
      const content = await readFile(neuronestIgnorePath, 'utf-8');
      patterns.push(...parseIgnoreFile(content));
    } catch {
      // .neuronestignore doesn't exist — that's fine
    }

    this.exclusionPatterns = patterns;
    return patterns;
  }

  // ─── Private: AST Parsing ───────────────────────────────────

  /**
   * Parse file content using tree-sitter and extract semantic chunks.
   */
  private parseWithTreeSitter(
    filePath: string,
    content: string,
    language: string,
    lang: any
  ): SemanticChunk[] {
    const parser = new this.parserModule.Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(content);

    if (!tree || !tree.rootNode) {
      parser.delete();
      return [this.createFileBlock(filePath, content, language)];
    }

    const fileHash = computeFileHash(content);
    const chunks: SemanticChunk[] = [];
    const chunkNodeTypes = CHUNK_NODE_TYPES[language] || {};

    this.visitNode(tree.rootNode, filePath, fileHash, language, chunkNodeTypes, chunks);

    // If no semantic chunks were found, return the whole file as a block
    if (chunks.length === 0) {
      parser.delete();
      return [this.createFileBlock(filePath, content, language)];
    }

    // Also extract top-level arrow functions assigned to variables
    // (TypeScript/JavaScript specific)
    if (language === 'typescript' || language === 'javascript') {
      this.extractArrowFunctions(tree.rootNode, filePath, fileHash, language, chunks);
    }

    parser.delete();
    return chunks;
  }

  /**
   * Recursively visit AST nodes and extract semantic chunks.
   */
  private visitNode(
    node: any,
    filePath: string,
    fileHash: string,
    language: string,
    chunkNodeTypes: Record<string, ChunkType>,
    chunks: SemanticChunk[]
  ): void {
    const chunkType = chunkNodeTypes[node.type];

    if (chunkType) {
      const startLine = node.startPosition.row + 1; // 0-indexed → 1-indexed
      const endLine = node.endPosition.row + 1;
      const lineCount = endLine - startLine + 1;

      // Only chunk if it meets minimum line count
      if (lineCount >= this.minChunkLines) {
        const name = extractName(node, language);
        const content = node.text;
        const id = generateChunkId(filePath, startLine, endLine, content);

        chunks.push({
          id,
          filePath,
          fileHash,
          chunkType,
          chunkName: name,
          startLine,
          endLine,
          content,
          language,
        });
      }
    }

    // Recurse into children
    for (let i = 0; i < node.childCount; i++) {
      this.visitNode(node.child(i), filePath, fileHash, language, chunkNodeTypes, chunks);
    }
  }

  /**
   * Extract arrow functions assigned to top-level variables.
   * e.g., `const myFn = () => { ... }` or `export const myFn = async () => { ... }`
   */
  private extractArrowFunctions(
    rootNode: any,
    filePath: string,
    fileHash: string,
    language: string,
    chunks: SemanticChunk[]
  ): void {
    const existingRanges = new Set(
      chunks.map((c) => `${c.startLine}:${c.endLine}`)
    );

    const parentTypes = ARROW_FUNCTION_PARENTS[language] || [];

    for (let i = 0; i < rootNode.childCount; i++) {
      const child = rootNode.child(i);
      let targetNode = child;

      // Handle export statements wrapping variable declarations
      if (child.type === 'export_statement') {
        const decl = child.childForFieldName?.('declaration');
        if (decl) targetNode = decl;
        else continue;
      }

      if (!parentTypes.includes(targetNode.type)) continue;

      // Look for variable_declarator children with arrow_function values
      for (let j = 0; j < targetNode.childCount; j++) {
        const declarator = targetNode.child(j);
        if (declarator.type !== 'variable_declarator') continue;

        const value = declarator.childForFieldName?.('value');
        if (!value) continue;
        if (value.type !== 'arrow_function' && value.type !== 'function') continue;

        const startLine = child.startPosition.row + 1;
        const endLine = child.endPosition.row + 1;
        const rangeKey = `${startLine}:${endLine}`;

        // Skip if already captured
        if (existingRanges.has(rangeKey)) continue;

        const lineCount = endLine - startLine + 1;
        if (lineCount < this.minChunkLines) continue;

        const nameNode = declarator.childForFieldName?.('name');
        const name = nameNode ? nameNode.text : '<anonymous>';
        const content = child.text;
        const id = generateChunkId(filePath, startLine, endLine, content);

        chunks.push({
          id,
          filePath,
          fileHash,
          chunkType: 'function',
          chunkName: name,
          startLine,
          endLine,
          content,
          language,
        });

        existingRanges.add(rangeKey);
      }
    }
  }

  /**
   * Create a fallback block chunk for the entire file.
   * Used when tree-sitter is unavailable or the file has no extractable semantic units.
   */
  private createFileBlock(filePath: string, content: string, language: string): SemanticChunk {
    const lines = content.split('\n');
    const startLine = 1;
    const endLine = lines.length;
    const fileHash = computeFileHash(content);
    const id = generateChunkId(filePath, startLine, endLine, content);

    return {
      id,
      filePath,
      fileHash,
      chunkType: 'block',
      chunkName: path.basename(filePath),
      startLine,
      endLine,
      content,
      language,
    };
  }
}

// ─── Singleton Instance ─────────────────────────────────────────

let instance: TreeSitterChunker | null = null;

/**
 * Get or create the singleton TreeSitterChunker instance.
 * Follows NeuroNest's lazy-initialized singleton pattern.
 */
export function getTreeSitterChunker(options: TreeSitterChunkerOptions): TreeSitterChunker {
  if (!instance || instance['projectRoot'] !== options.projectRoot) {
    instance = new TreeSitterChunker(options);
  }
  return instance;
}

/**
 * Reset the singleton (for testing purposes).
 */
export function resetTreeSitterChunker(): void {
  instance = null;
}

// Re-export utility functions used by tests
export { parseIgnoreFile, isExcluded, globToRegex };
