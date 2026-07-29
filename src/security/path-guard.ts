/**
 * PathGuard — stateless path validation utility for traversal attack prevention.
 *
 * Validates file paths against a project root directory, ensuring that no path
 * can escape the root via:
 * - `..` traversal sequences
 * - Absolute paths not prefixed by the root
 * - Symbolic links resolving outside the root
 *
 * Used by all file-access IPC handlers to prevent the renderer from reading or
 * writing arbitrary files on the host filesystem.
 *
 * Design Decision: Symlink resolution uses `fs.realpathSync` wrapped in try/catch.
 * If the target doesn't exist yet (write operations), the parent directory's realpath
 * is validated instead.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4
 */

import * as path from 'path';
import * as fs from 'fs';

// ─── Result Types ───────────────────────────────────────────────

export type PathGuardResult =
  | { safe: true; resolved: string }
  | { safe: false; reason: string };

// ─── Options ────────────────────────────────────────────────────

export interface PathGuardOptions {
  /**
   * When true, resolves symbolic links and validates the real path.
   * Defaults to true.
   */
  followSymlinks?: boolean;
}

// ─── Main Validation Function ───────────────────────────────────

/**
 * Validates that `inputPath` resolves to a location within `projectRoot`.
 *
 * @param inputPath - The path to validate (relative or absolute).
 * @param projectRoot - The trusted project root directory (absolute path).
 * @param options - Optional configuration for symlink handling.
 * @returns A discriminated union: `{ safe: true, resolved }` or `{ safe: false, reason }`.
 */
export function validatePath(
  inputPath: string,
  projectRoot: string,
  options?: PathGuardOptions,
): PathGuardResult {
  const followSymlinks = options?.followSymlinks ?? true;

  // Resolve the project root to its canonical real path
  // This handles platform symlinks (e.g., /var -> /private/var on macOS)
  const resolvedRoot = resolveRealRoot(projectRoot);
  const normalizedRoot = resolvedRoot + path.sep;

  // Resolve the input path relative to the project root (logical resolution, no symlink following)
  let logicalResolved: string;
  if (path.isAbsolute(inputPath)) {
    logicalResolved = path.normalize(inputPath);
  } else {
    logicalResolved = path.resolve(projectRoot, inputPath);
  }

  // Check 1: Logical path must be within root after normalization
  // This catches `..` traversal that escapes the root BEFORE any filesystem access.
  // Use the logical root (not realpath) for this check to handle relative path arithmetic.
  const logicalRoot = path.resolve(projectRoot);
  const logicalRootPrefix = logicalRoot + path.sep;
  if (logicalResolved !== logicalRoot && !logicalResolved.startsWith(logicalRootPrefix)) {
    return {
      safe: false,
      reason: `Path "${inputPath}" resolves to "${logicalResolved}" which is outside the project root "${logicalRoot}"`,
    };
  }

  // If symlink following is disabled, return the logical resolved path without filesystem checks
  if (!followSymlinks) {
    return { safe: true, resolved: logicalResolved };
  }

  // Check 2: Resolve the real path (following symlinks) and verify containment
  const realResult = resolveAndValidateReal(logicalResolved, resolvedRoot, normalizedRoot, inputPath);
  return realResult;
}

// ─── Internal Helpers ───────────────────────────────────────────

/**
 * Resolves the project root to its real (canonical) path.
 */
function resolveRealRoot(projectRoot: string): string {
  try {
    return fs.realpathSync(path.resolve(projectRoot));
  } catch {
    return path.resolve(projectRoot);
  }
}

/**
 * Resolves the full real path of the target and validates containment within root.
 * If target doesn't exist, validates the parent directory instead (for write operations).
 */
function resolveAndValidateReal(
  logicalResolved: string,
  resolvedRoot: string,
  normalizedRoot: string,
  inputPath: string,
): PathGuardResult {
  // Try to resolve the full target path
  try {
    const realPath = fs.realpathSync(logicalResolved);
    if (realPath !== resolvedRoot && !realPath.startsWith(normalizedRoot)) {
      return {
        safe: false,
        reason: `Path "${inputPath}" resolves via symlink to "${realPath}" which is outside the project root`,
      };
    }
    return { safe: true, resolved: realPath };
  } catch {
    // Target doesn't exist — validate the parent directory (write operation scenario)
    return validateParentForWrite(logicalResolved, resolvedRoot, normalizedRoot, inputPath);
  }
}

/**
 * For write operations where the target doesn't exist yet:
 * validates the parent directory's realpath is within the project root.
 */
function validateParentForWrite(
  logicalResolved: string,
  resolvedRoot: string,
  normalizedRoot: string,
  inputPath: string,
): PathGuardResult {
  const parentDir = path.dirname(logicalResolved);

  try {
    const parentRealPath = fs.realpathSync(parentDir);
    if (parentRealPath !== resolvedRoot && !parentRealPath.startsWith(normalizedRoot)) {
      return {
        safe: false,
        reason: `Parent directory of "${inputPath}" resolves via symlink to "${parentRealPath}" which is outside the project root`,
      };
    }
    // Parent is valid — construct the resolved path using the real parent + basename
    const resolvedPath = path.join(parentRealPath, path.basename(logicalResolved));
    return { safe: true, resolved: resolvedPath };
  } catch {
    // Parent directory doesn't exist either — reject
    return {
      safe: false,
      reason: `Path "${inputPath}" has a non-existent parent directory that cannot be validated`,
    };
  }
}
