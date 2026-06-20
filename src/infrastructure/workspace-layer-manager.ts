/**
 * WorkspaceLayerManager — Organizes workspace files into logical layers.
 *
 * Layers map named groups (source, tests, config, generated, assets) to sets of
 * glob patterns. This enables agents, pipelines, and tools to scope file operations
 * to specific workspace layers, and provides visual grouping in the file tree UI.
 *
 * Persists layer definitions in `.neuronest/layers.json`.
 * Provides default layers on first access when no config file exists.
 *
 * Requirements: 19.1, 19.2, 19.3, 19.4, 19.5
 */

import * as fs from 'fs';
import * as path from 'path';
import type { WorkspaceLayer, ValidationResult, ValidationError } from '../shared/feature-integration-types';
import { FeatureError } from '../shared/feature-integration-errors';

// ─── Glob Matching (inline, consistent with trigger-system.ts) ──

/**
 * Match a file path against a glob pattern.
 *
 * Supports:
 * - `*` matches any sequence of non-separator characters
 * - `**` matches any sequence of characters including separators (recursive)
 * - `?` matches exactly one non-separator character
 * - `{a,b}` matches either 'a' or 'b' (brace expansion, single level)
 * - `[abc]` matches any character in the set
 * - `[!abc]` or `[^abc]` matches any character NOT in the set
 *
 * Path separators are normalized to `/` before matching.
 */
export function matchGlob(pattern: string, filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');

  // Handle brace expansion (simple single-level)
  if (normalizedPattern.includes('{') && normalizedPattern.includes('}')) {
    const braceMatch = normalizedPattern.match(/^(.*)\{([^}]+)\}(.*)$/);
    if (braceMatch) {
      const [, prefix, alternatives, suffix] = braceMatch;
      return alternatives.split(',').some((alt) =>
        matchGlob(`${prefix}${alt.trim()}${suffix}`, normalizedPath),
      );
    }
  }

  const regex = globToRegex(normalizedPattern);
  return regex.test(normalizedPath);
}

/**
 * Convert a glob pattern to a RegExp.
 */
function globToRegex(pattern: string): RegExp {
  let regexStr = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === '*') {
      if (i + 1 < pattern.length && pattern[i + 1] === '*') {
        // `**` — matches anything including path separators
        if (i + 2 < pattern.length && pattern[i + 2] === '/') {
          regexStr += '(?:.*/)?';
          i += 3;
        } else {
          regexStr += '.*';
          i += 2;
        }
      } else {
        // `*` — matches anything except path separator
        regexStr += '[^/]*';
        i++;
      }
    } else if (char === '?') {
      regexStr += '[^/]';
      i++;
    } else if (char === '[') {
      // Character class
      let classStr = '[';
      i++;
      if (i < pattern.length && (pattern[i] === '!' || pattern[i] === '^')) {
        classStr += '^';
        i++;
      }
      while (i < pattern.length && pattern[i] !== ']') {
        classStr += escapeRegexChar(pattern[i]);
        i++;
      }
      classStr += ']';
      regexStr += classStr;
      i++; // skip ']'
    } else {
      regexStr += escapeRegexChar(char);
      i++;
    }
  }

  return new RegExp(`^${regexStr}$`);
}

/**
 * Escape a character for use in a RegExp.
 */
function escapeRegexChar(char: string): string {
  if ('.+^${}()|\\'.includes(char)) {
    return `\\${char}`;
  }
  return char;
}

// ─── Glob Validation ────────────────────────────────────────────

/**
 * Validate that a glob pattern is syntactically correct.
 *
 * A pattern is invalid if:
 * - It's empty or whitespace-only
 * - It contains an unclosed bracket `[` without matching `]`
 * - It contains an unclosed brace `{` without matching `}`
 * - It contains invalid escape sequences (trailing backslash)
 * - It converts to an invalid RegExp
 */
function isValidGlob(pattern: string): { valid: boolean; reason?: string } {
  if (!pattern || pattern.trim().length === 0) {
    return { valid: false, reason: 'Pattern must not be empty' };
  }

  // Check for unclosed brackets
  let inBracket = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') {
      // Skip escaped character
      if (i === pattern.length - 1) {
        return { valid: false, reason: 'Trailing backslash in pattern' };
      }
      i++;
      continue;
    }
    if (char === '[') {
      if (inBracket) {
        return { valid: false, reason: 'Nested brackets are not supported' };
      }
      inBracket = true;
    } else if (char === ']') {
      inBracket = false;
    }
  }
  if (inBracket) {
    return { valid: false, reason: 'Unclosed bracket in pattern' };
  }

  // Check for unclosed braces
  let braceDepth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') {
      i++;
      continue;
    }
    if (char === '{') braceDepth++;
    if (char === '}') braceDepth--;
    if (braceDepth < 0) {
      return { valid: false, reason: 'Unmatched closing brace in pattern' };
    }
  }
  if (braceDepth > 0) {
    return { valid: false, reason: 'Unclosed brace in pattern' };
  }

  // Attempt to compile to regex — catches any remaining issues
  try {
    globToRegex(pattern.replace(/\\/g, '/'));
    return { valid: true };
  } catch {
    return { valid: false, reason: 'Pattern produces an invalid regular expression' };
  }
}

// ─── Default Layers ─────────────────────────────────────────────

/**
 * Returns the default workspace layer definitions.
 * These are created on first load if `.neuronest/layers.json` doesn't exist.
 */
function createDefaultLayers(): WorkspaceLayer[] {
  return [
    {
      name: 'source',
      patterns: ['src/**'],
    },
    {
      name: 'tests',
      patterns: ['test*/**', '**/test*/**', '**/*.test.*', '**/*.spec.*'],
    },
    {
      name: 'config',
      patterns: ['*.config.*', '.*rc*', '*.json', '*.yml', '*.yaml', '*.toml'],
    },
    {
      name: 'generated',
      patterns: ['.neuronest/generated/**'],
    },
    {
      name: 'assets',
      patterns: ['assets/**', 'public/**'],
    },
  ];
}

// ─── WorkspaceLayerManager ──────────────────────────────────────

export interface WorkspaceLayerManagerOptions {
  /** Root project directory for resolving `.neuronest/layers.json` and file operations. */
  projectDir: string;
}

export class WorkspaceLayerManager {
  private readonly projectDir: string;
  private readonly filePath: string;

  /** In-memory cache of layers. Loaded from disk on first access. */
  private layers: WorkspaceLayer[] | null = null;

  constructor(options: WorkspaceLayerManagerOptions) {
    this.projectDir = options.projectDir;
    this.filePath = path.join(this.projectDir, '.neuronest', 'layers.json');
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Get all workspace layer definitions.
   *
   * On first call, loads from disk. If no file exists, creates default layers.
   */
  getLayers(): WorkspaceLayer[] {
    this.ensureLoaded();
    return [...this.layers!];
  }

  /**
   * Set the workspace layer definitions, replacing all existing layers.
   *
   * Validates all patterns before persisting. Throws if any pattern is invalid.
   *
   * @param layers - New layer definitions to set.
   */
  setLayers(layers: WorkspaceLayer[]): void {
    // Validate all patterns in the new layers
    const allPatterns = layers.flatMap((l) => l.patterns);
    const validation = this.validatePatterns(allPatterns);
    if (!validation.valid) {
      throw new FeatureError({
        message: `Invalid layer patterns: ${validation.errors.map((e) => e.message).join('; ')}`,
        category: 'infrastructure',
        code: 'INVALID_LAYER_PATTERNS',
        details: { errors: validation.errors },
      });
    }

    this.layers = [...layers];
    this.persist();
  }

  /**
   * Resolve a layer by name, returning all file paths in the project
   * directory that match the layer's glob patterns.
   *
   * Walks the project directory tree and tests each file path against
   * the layer's patterns.
   *
   * @param layerName - Name of the layer to resolve.
   * @returns Array of relative file paths matching the layer's patterns.
   */
  resolveLayer(layerName: string): string[] {
    this.ensureLoaded();

    const layer = this.layers!.find((l) => l.name === layerName);
    if (!layer) {
      throw new FeatureError({
        message: `Layer not found: ${layerName}`,
        category: 'infrastructure',
        code: 'LAYER_NOT_FOUND',
        details: { layerName, availableLayers: this.layers!.map((l) => l.name) },
      });
    }

    // Walk the project directory and match files
    const matchedFiles: string[] = [];
    this.walkDirectory(this.projectDir, '', (relativePath) => {
      if (layer.patterns.some((pattern) => matchGlob(pattern, relativePath))) {
        matchedFiles.push(relativePath);
      }
    });

    return matchedFiles.sort();
  }

  /**
   * Validate an array of glob patterns for syntactic correctness.
   *
   * Each pattern is checked individually. Returns a ValidationResult
   * with errors for each invalid pattern.
   *
   * @param patterns - Array of glob pattern strings to validate.
   * @returns ValidationResult indicating validity and any errors.
   */
  validatePatterns(patterns: string[]): ValidationResult {
    const errors: ValidationError[] = [];

    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i];
      const check = isValidGlob(pattern);
      if (!check.valid) {
        errors.push({
          field: `patterns[${i}]`,
          message: `Invalid glob pattern "${pattern}": ${check.reason}`,
          code: 'INVALID_GLOB_PATTERN',
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Determine which layer a file belongs to.
   *
   * Tests the file path against all layer patterns in order.
   * Returns the name of the first matching layer, or null if no layer matches.
   *
   * @param filePath - Relative file path to classify.
   * @returns Layer name or null if no layer matches.
   */
  getFileLayer(filePath: string): string | null {
    this.ensureLoaded();

    const normalizedPath = filePath.replace(/\\/g, '/');

    for (const layer of this.layers!) {
      if (layer.patterns.some((pattern) => matchGlob(pattern, normalizedPath))) {
        return layer.name;
      }
    }

    return null;
  }

  /**
   * Get layer information for the file tree UI.
   *
   * Returns a map of layer name → list of matched file paths,
   * suitable for visual grouping indicators in the project file tree.
   */
  getLayerMap(): Record<string, string[]> {
    this.ensureLoaded();
    const result: Record<string, string[]> = {};

    for (const layer of this.layers!) {
      result[layer.name] = [];
    }

    this.walkDirectory(this.projectDir, '', (relativePath) => {
      for (const layer of this.layers!) {
        if (layer.patterns.some((pattern) => matchGlob(pattern, relativePath))) {
          result[layer.name].push(relativePath);
          break; // A file belongs to the first matching layer only
        }
      }
    });

    return result;
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Ensure layers are loaded into memory.
   * On first access:
   * - If the file exists on disk, load and validate it.
   * - If the file doesn't exist, create default layers and persist.
   */
  private ensureLoaded(): void {
    if (this.layers !== null) return;

    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(content) as WorkspaceLayer[];

      // Basic validation: ensure it's an array of layers with name and patterns
      if (!Array.isArray(parsed) || !parsed.every(isWorkspaceLayer)) {
        throw new Error('Invalid layers.json format');
      }

      this.layers = parsed;
    } catch {
      // File doesn't exist or is malformed — create defaults
      this.layers = createDefaultLayers();
      this.persist();
    }
  }

  /**
   * Persist the current layers array to disk as JSON.
   */
  private persist(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.layers, null, 2), 'utf-8');
  }

  /**
   * Recursively walk a directory, calling the callback with each file's
   * relative path. Skips hidden directories (except .neuronest), node_modules,
   * and other common non-essential directories.
   */
  private walkDirectory(
    baseDir: string,
    relativePath: string,
    callback: (relativePath: string) => void,
  ): void {
    const fullPath = relativePath
      ? path.join(baseDir, relativePath)
      : baseDir;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(fullPath, { withFileTypes: true });
    } catch {
      return; // Directory not accessible
    }

    for (const entry of entries) {
      const entryRelative = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name;

      if (entry.isDirectory()) {
        // Skip common non-essential directories
        if (shouldSkipDirectory(entry.name)) {
          continue;
        }
        this.walkDirectory(baseDir, entryRelative, callback);
      } else if (entry.isFile()) {
        callback(entryRelative);
      }
    }
  }
}

// ─── Utility Functions ──────────────────────────────────────────

/**
 * Type guard for WorkspaceLayer shape.
 */
function isWorkspaceLayer(value: unknown): value is WorkspaceLayer {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.name === 'string' &&
    obj.name.length > 0 &&
    Array.isArray(obj.patterns) &&
    obj.patterns.every((p: unknown) => typeof p === 'string')
  );
}

/**
 * Directories to skip when walking the project tree.
 */
function shouldSkipDirectory(name: string): boolean {
  const skipDirs = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'coverage',
    '.next',
    '.nuxt',
    '.cache',
    '__pycache__',
    '.tox',
    'target',
    'vendor',
  ]);
  return skipDirs.has(name);
}
