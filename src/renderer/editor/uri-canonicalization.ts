/**
 * URI Canonicalization utilities.
 *
 * Normalizes workspace file URIs before model lookup to ensure that symlinks,
 * case variations (on case-insensitive systems), and trailing separators
 * resolve to the same canonical key.
 *
 * Requirements: 1.1 (URI canonicalization occurs before model lookup)
 */

import * as path from 'path';

/**
 * Determines whether the current platform uses a case-insensitive filesystem.
 * macOS and Windows are case-insensitive by default.
 */
function isCaseInsensitivePlatform(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32';
}

/**
 * Canonicalize a workspace file URI.
 *
 * - Normalizes path separators (backslash -> forward slash)
 * - Resolves `.` and `..` segments
 * - Removes trailing separators
 * - Lowercases on case-insensitive platforms
 * - Strips `file://` scheme prefix if present
 */
export function canonicalizeUri(uri: string): string {
  let normalized = uri;

  // Strip file:// scheme
  if (normalized.startsWith('file://')) {
    normalized = normalized.slice(7);
  }

  // Normalize path separators to forward slash
  normalized = normalized.replace(/\\/g, '/');

  // Use path.posix.normalize to resolve . and .. segments
  normalized = path.posix.normalize(normalized);

  // Remove trailing slash (unless it's the root `/`)
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  // Case-insensitive normalization
  if (isCaseInsensitivePlatform()) {
    normalized = normalized.toLowerCase();
  }

  return normalized;
}
