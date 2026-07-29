// NeuroNest Dynamic Import Validator
// Validates that dynamic import specifiers resolve to allowed directories
// before performing the actual import. Replaces unsafe `new Function('s', 'return import(s)')` patterns.

import * as path from 'path';

// ── Error type ──────────────────────────────────────────────────────

/**
 * Thrown when a dynamic import specifier resolves to a path outside the allowed directories.
 */
export class ImportPathViolationError extends Error {
  public readonly specifier: string;
  public readonly resolvedPath: string;

  constructor(specifier: string, resolvedPath: string) {
    super(
      `Import path violation: "${specifier}" resolves to "${resolvedPath}" which is outside allowed import directories.`,
    );
    this.name = 'ImportPathViolationError';
    this.specifier = specifier;
    this.resolvedPath = resolvedPath;
  }
}

// ── Allowed directories ─────────────────────────────────────────────

/**
 * Set of permitted import directory prefixes (relative to project root).
 * Only modules whose resolved path falls within one of these directories are allowed.
 */
export const ALLOWED_IMPORT_DIRS = new Set([
  'node_modules/grammy',
  'node_modules/discord.js',
  'node_modules/@slack/bolt',
  'node_modules/nodemailer',
]);

// ── Implementation ──────────────────────────────────────────────────

/**
 * Resolves the given specifier to an absolute path and checks it against
 * the allowed import directories. If valid, performs the dynamic import
 * and returns the module. Otherwise throws ImportPathViolationError.
 *
 * @param specifier - The module specifier string (e.g. 'grammy', 'discord.js')
 * @returns The imported module
 * @throws ImportPathViolationError if the resolved path is outside allowed directories
 */
export async function safeImport(specifier: string): Promise<unknown> {
  const resolvedPath = resolveSpecifier(specifier);

  if (!isPathAllowed(resolvedPath)) {
    throw new ImportPathViolationError(specifier, resolvedPath);
  }

  // Perform the actual dynamic import
  return import(specifier);
}

/**
 * Resolves a module specifier to an absolute path using Node.js require.resolve.
 * This gives us the actual filesystem path the module would load from.
 */
function resolveSpecifier(specifier: string): string {
  try {
    return require.resolve(specifier);
  } catch {
    // If we can't resolve it, construct a path from the specifier.
    // This handles cases where the module isn't installed yet but we still
    // want to validate the path pattern.
    return path.resolve('node_modules', specifier);
  }
}

/**
 * Checks whether the resolved absolute path falls within one of the allowed
 * import directories.
 */
function isPathAllowed(resolvedPath: string): boolean {
  const normalized = path.normalize(resolvedPath);

  for (const allowedDir of ALLOWED_IMPORT_DIRS) {
    // Build the absolute allowed directory path
    const absoluteAllowedDir = path.resolve(allowedDir);

    // Check if the resolved path starts with the allowed directory
    // (with a trailing separator to prevent prefix attacks like 'node_modules/grammyevil')
    if (
      normalized === absoluteAllowedDir ||
      normalized.startsWith(absoluteAllowedDir + path.sep)
    ) {
      return true;
    }
  }

  return false;
}
