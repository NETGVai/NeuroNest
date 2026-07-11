/**
 * Overwrite Gate — compares proposed file content against existing content
 * using structural identifiers (imports, exports, class/function names) to
 * determine relatedness and gate unrelated overwrites.
 *
 * Requirements: 2.1, 2.2, 2.6, 2.7, 2.8
 */

import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { isPathSafe } from '../../utils/path-safety';
import type {
  OverwriteGateConfig,
  RelatednessResult,
  OverwriteDecision,
} from './types';

// ─── Binary File Detection ──────────────────────────────────────

/** File extensions that are known binary formats — yield 0 identifiers */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.svg',
  '.webp',
  '.tiff',
  '.tif',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.7z',
  '.rar',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.mp3',
  '.mp4',
  '.wav',
  '.ogg',
  '.webm',
  '.avi',
  '.mov',
  '.flv',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
  '.db',
  '.sqlite',
  '.lock',
]);

// ─── Regex Patterns ─────────────────────────────────────────────

/**
 * Matches ES module import paths:
 * - `import ... from 'path'`
 * - `import ... from "path"`
 * - `import 'path'`
 * - `import "path"`
 */
const IMPORT_PATH_REGEX = /^\s*import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/gm;

/**
 * Matches named imports within braces:
 * `import { A, B, C } from ...`
 * Also handles multi-line imports and `type` imports.
 */
const NAMED_IMPORT_REGEX = /^\s*import\s+(?:type\s+)?\{([^}]+)\}/gm;

/**
 * Matches exported symbol declarations:
 * - `export function X`
 * - `export async function X`
 * - `export class Y`
 * - `export abstract class Y`
 * - `export const Z`
 * - `export let Z`
 * - `export var Z`
 * - `export interface W`
 * - `export type T`
 * - `export enum E`
 * - `export default class X`
 * - `export default function X`
 */
const EXPORT_SYMBOL_REGEX =
  /^\s*export\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?\s+|class\s+|const\s+|let\s+|var\s+|interface\s+|type\s+|enum\s+)([a-zA-Z_$][a-zA-Z0-9_$]*)/gm;

/**
 * Matches top-level function declarations (not exported, not nested):
 * - `function myFunc(`
 * - `async function myFunc(`
 */
const TOP_LEVEL_FUNCTION_REGEX = /^(?:async\s+)?function\*?\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/gm;

/**
 * Matches top-level class declarations (not exported):
 * - `class MyClass`
 * - `abstract class MyClass`
 */
const TOP_LEVEL_CLASS_REGEX = /^(?:abstract\s+)?class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/gm;

/**
 * Matches top-level interface declarations (not exported):
 * - `interface MyInterface`
 */
const TOP_LEVEL_INTERFACE_REGEX = /^interface\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/gm;

/**
 * Matches top-level type alias declarations (not exported):
 * - `type MyType =`
 */
const TOP_LEVEL_TYPE_REGEX = /^type\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/gm;

// ─── Public API ─────────────────────────────────────────────────

/**
 * Extracts structural identifiers from source file content:
 * - Import paths and named imports
 * - Exported symbol names
 * - Top-level class/function/interface/type names
 *
 * Returns an empty array for binary files (detected by extension).
 * Uses regex-based parsing for simplicity and speed.
 *
 * @param content - The file content to analyze
 * @param filePath - The file path (used for binary detection via extension)
 * @returns Deduplicated array of identifier strings
 */
export function extractStructuralIdentifiers(content: string, filePath: string): string[] {
  // Check for binary file extension
  const ext = getFileExtension(filePath);
  if (BINARY_EXTENSIONS.has(ext)) {
    return [];
  }

  const identifiers = new Set<string>();

  // Extract import paths
  collectMatches(IMPORT_PATH_REGEX, content, 1, identifiers);

  // Extract named imports
  collectNamedImports(content, identifiers);

  // Extract exported symbols
  collectMatches(EXPORT_SYMBOL_REGEX, content, 1, identifiers);

  // Extract top-level function names (non-exported)
  collectMatches(TOP_LEVEL_FUNCTION_REGEX, content, 1, identifiers);

  // Extract top-level class names (non-exported)
  collectMatches(TOP_LEVEL_CLASS_REGEX, content, 1, identifiers);

  // Extract top-level interface names (non-exported)
  collectMatches(TOP_LEVEL_INTERFACE_REGEX, content, 1, identifiers);

  // Extract top-level type aliases (non-exported)
  collectMatches(TOP_LEVEL_TYPE_REGEX, content, 1, identifiers);

  return Array.from(identifiers);
}

/** Default relatedness threshold used by the standalone computeRelatedness function */
const DEFAULT_RELATEDNESS_THRESHOLD = 0.2;

/**
 * Computes the relatedness score between proposed and existing content.
 * Returns score = |intersection(proposed_ids, existing_ids)| / |existing_ids|
 *
 * If the existing content has zero structural identifiers, the write is
 * treated as vacuously related (score 1.0, isRelated: true).
 *
 * The standalone function uses 0.2 as the default threshold for `isRelated`.
 * When called from `evaluateOverwrite`, the caller uses the config threshold.
 */
export function computeRelatedness(
  existingContent: string,
  proposedContent: string,
  filePath: string
): RelatednessResult {
  const existingIds = extractStructuralIdentifiers(existingContent, filePath);
  const proposedIds = extractStructuralIdentifiers(proposedContent, filePath);

  // Vacuously related: nothing to conflict with
  if (existingIds.length === 0) {
    return {
      score: 1.0,
      sharedIdentifiers: [],
      totalExistingIdentifiers: 0,
      isRelated: true,
    };
  }

  const proposedSet = new Set(proposedIds);
  const shared = existingIds.filter((id) => proposedSet.has(id));
  const score = shared.length / existingIds.length;

  return {
    score,
    sharedIdentifiers: shared,
    totalExistingIdentifiers: existingIds.length,
    isRelated: score >= DEFAULT_RELATEDNESS_THRESHOLD,
  };
}

/**
 * Main gate decision function.
 * Checks: config enabled → path safety → file existence → excluded paths → relatedness → decision
 *
 * Check order:
 * 1. If protection is disabled via config, allow immediately
 * 2. Path safety check (blocks unsafe paths)
 * 3. File existence check (new files always allowed)
 * 4. Excluded paths check (matching globs bypass gate)
 * 5. Relatedness check (related content allowed, unrelated needs confirmation)
 */
export function evaluateOverwrite(
  filePath: string,
  proposedContent: string,
  projectDir: string,
  config: OverwriteGateConfig
): OverwriteDecision {
  // 1. If protection is disabled, allow everything immediately
  if (config.enabled === false) {
    return {
      allowed: true,
      requiresConfirmation: false,
      relatedness: {
        score: 1.0,
        sharedIdentifiers: [],
        totalExistingIdentifiers: 0,
        isRelated: true,
      },
      filePath,
    };
  }

  // 2. Check path safety — unsafe paths are blocked immediately
  if (!isPathSafe(filePath, projectDir)) {
    return {
      allowed: false,
      requiresConfirmation: false,
      relatedness: {
        score: 0,
        sharedIdentifiers: [],
        totalExistingIdentifiers: 0,
        isRelated: false,
      },
      filePath,
    };
  }

  // 3. Resolve path and check file existence — new files always pass
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(projectDir, filePath);

  if (!fs.existsSync(absolutePath)) {
    return {
      allowed: true,
      requiresConfirmation: false,
      relatedness: {
        score: 1.0,
        sharedIdentifiers: [],
        totalExistingIdentifiers: 0,
        isRelated: true,
      },
      filePath,
    };
  }

  // 4. Check excluded paths — matching globs bypass the gate
  for (const pattern of config.excludedPaths) {
    try {
      if (minimatch(filePath, pattern, { dot: true })) {
        return {
          allowed: true,
          requiresConfirmation: false,
          relatedness: {
            score: 1.0,
            sharedIdentifiers: [],
            totalExistingIdentifiers: 0,
            isRelated: true,
          },
          filePath,
        };
      }
    } catch {
      // Malformed glob pattern — ignore it, log warning, continue with remaining patterns
      console.warn(`[OverwriteGate] Ignoring malformed glob pattern: ${pattern}`);
    }
  }

  // 5. Read existing file content and compute relatedness
  let existingContent: string;
  try {
    existingContent = fs.readFileSync(absolutePath, 'utf-8');
  } catch {
    // If we can't read the existing file, fail open (allow write)
    return {
      allowed: true,
      requiresConfirmation: false,
      relatedness: {
        score: 1.0,
        sharedIdentifiers: [],
        totalExistingIdentifiers: 0,
        isRelated: true,
      },
      filePath,
    };
  }

  const relatedness = computeRelatedness(existingContent, proposedContent, filePath);

  // 6. Apply config threshold for the decision
  const isRelatedByConfig = relatedness.score >= config.relatednesThreshold;

  if (isRelatedByConfig) {
    return {
      allowed: true,
      requiresConfirmation: false,
      relatedness: {
        ...relatedness,
        isRelated: true,
      },
      filePath,
    };
  }

  // Unrelated content — block and require confirmation
  return {
    allowed: false,
    requiresConfirmation: true,
    relatedness: {
      ...relatedness,
      isRelated: false,
    },
    filePath,
  };
}

// ─── Helper Functions ───────────────────────────────────────────

/**
 * Extracts the file extension (lowercased) from a file path.
 */
function getFileExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1 || lastDot === filePath.length - 1) {
    return '';
  }
  // Handle cases like `.gitignore` (hidden files without an extension)
  const afterSlash = filePath.lastIndexOf('/');
  if (lastDot <= afterSlash + 1) {
    return '';
  }
  return filePath.slice(lastDot).toLowerCase();
}

/**
 * Collects regex matches from content into an identifier set.
 * The regex must have the 'g' flag. We reset lastIndex before each use.
 */
function collectMatches(regex: RegExp, content: string, groupIndex: number, identifiers: Set<string>): void {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const value = match[groupIndex]?.trim();
    if (value) {
      identifiers.add(value);
    }
  }
}

/**
 * Parses named imports from `import { A, B, C } from ...` statements.
 * Handles aliases (`A as B` → extracts `A`), type imports, and multi-line.
 */
function collectNamedImports(content: string, identifiers: Set<string>): void {
  NAMED_IMPORT_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NAMED_IMPORT_REGEX.exec(content)) !== null) {
    const inner = match[1];
    if (!inner) continue;
    // Split by commas and extract identifier names
    const names = inner.split(',');
    for (const name of names) {
      const trimmed = name.trim();
      if (!trimmed) continue;

      // Handle `type X` prefix in individual imports
      const withoutType = trimmed.replace(/^type\s+/, '');

      // Handle `X as Y` aliasing — extract the original name X
      const asMatch = withoutType.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)/);
      if (asMatch && asMatch[1]) {
        identifiers.add(asMatch[1]);
      }
    }
  }
}
