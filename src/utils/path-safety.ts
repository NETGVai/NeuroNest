/**
 * Standalone path-safety utility for validating that file paths
 * remain within a given project directory boundary.
 *
 * Extracted from SimpleResponder.isPathSafe() for reuse across
 * pipeline components (e.g., Overwrite Gate).
 */

import * as path from 'path';
import * as fs from 'fs';

/**
 * Validates that a target path is safe — i.e., it resolves to a location
 * strictly within the given project directory.
 *
 * Security rules:
 * 1. Reject null bytes and control characters
 * 2. Resolve the path to its absolute canonical form
 * 3. The resolved path MUST start with the project directory + path separator
 *    (or be the project directory itself)
 * 4. If the file exists, follow symlinks and re-check containment
 *
 * @param targetPath - The file path to validate (relative or absolute)
 * @param projectDir - The project root directory boundary
 * @returns true if the path is safely within the project directory
 */
export function isPathSafe(targetPath: string, projectDir: string): boolean {
  try {
    // Reject null bytes and control characters
    if (/[\x00-\x1f]/.test(targetPath)) return false;

    // Resolve to absolute path
    const resolved = path.resolve(projectDir, targetPath);

    // The resolved path must be the project dir itself or a child of it
    const projectDirWithSep = projectDir.endsWith(path.sep)
      ? projectDir
      : projectDir + path.sep;

    if (resolved !== projectDir && !resolved.startsWith(projectDirWithSep)) {
      return false;
    }

    // If the file/dir already exists, resolve through symlinks and re-check
    if (fs.existsSync(resolved)) {
      const realPath = fs.realpathSync(resolved);
      const realProjectDir = fs.realpathSync(projectDir);
      const realProjectDirWithSep = realProjectDir.endsWith(path.sep)
        ? realProjectDir
        : realProjectDir + path.sep;

      if (realPath !== realProjectDir && !realPath.startsWith(realProjectDirWithSep)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}
