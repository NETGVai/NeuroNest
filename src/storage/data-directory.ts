/**
 * Data_Directory_Accessor — Single source of truth for NeuroNest's local data directory.
 *
 * Every data-persisting consumer (database, window-state, backups, etc.) MUST
 * obtain its data directory from `getDataDirectory()` instead of joining
 * `os.homedir()` directly. This module is the ONLY place allowed to compute
 * a data-directory path from `os.homedir()`.
 *
 * @see Requirements 21.5, 21.6, 21.7
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/**
 * The canonical data directory name under the user's home directory.
 * This is a stable identifier tied to user data and is NOT affected by branding changes.
 */
const CANONICAL_DIR_NAME = '.neuronest';

/**
 * The legacy data directory used before the rebranding from ai-superagent to neuronest.
 * Contents are migrated once to the canonical directory at startup.
 */
export const LEGACY_DATA_DIRECTORY: string = path.join(os.homedir(), '.ai-superagent');

/**
 * Marker file written inside the canonical data directory after all legacy
 * contents have been successfully migrated. Its presence signals that the
 * one-time migration is complete and must not be repeated.
 */
export const MIGRATION_MARKER = '.migration-complete';

/**
 * Lock file used to prevent concurrent migration attempts across multiple
 * application instances.
 */
const MIGRATION_LOCK_FILE = '.migration-lock';

/**
 * Returns the canonical data directory path (`~/.neuronest`), creating it if
 * it does not already exist.
 *
 * This is the single accessor every data-persisting consumer must use.
 * No other module should join `os.homedir()` to compute a data path.
 */
export function getDataDirectory(): string {
  const dir = path.join(os.homedir(), CANONICAL_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Result of the legacy data migration attempt.
 */
export interface MigrationResult {
  /** Whether the migration completed successfully (all items moved). */
  status: 'completed' | 'skipped' | 'deferred' | 'failed';
  /** Human-readable description of what happened. */
  message: string;
  /** Items that were successfully moved. */
  movedItems?: string[];
  /** Items that were skipped due to conflicts (already exist in canonical). */
  skippedConflicts?: string[];
  /** Error details if the migration failed. */
  error?: string;
}

/**
 * Performs the one-time legacy data migration from `~/.ai-superagent` to `~/.neuronest`.
 *
 * State machine:
 * 1. If MIGRATION_MARKER exists in canonical dir → skip (already complete, R21.9)
 * 2. If legacy directory does not exist or is empty → skip (nothing to do)
 * 3. Acquire file lock → if held by another instance, defer (R21.12)
 * 4. Move each item from legacy to canonical:
 *    - If canonical already has the item at the same relative path → skip (R21.11)
 *    - Otherwise → move (rename) the item
 * 5. If ALL items moved without error → write MIGRATION_MARKER (R21.8)
 * 6. On partial failure → no marker, preserve unmoved legacy content, surface error (R21.10)
 * 7. Release lock in finally block
 *
 * @see Requirements 21.8, 21.9, 21.10, 21.11, 21.12
 */
export function migrateLegacyData(): MigrationResult {
  const canonicalDir = getDataDirectory();
  const markerPath = path.join(canonicalDir, MIGRATION_MARKER);
  const lockPath = path.join(canonicalDir, MIGRATION_LOCK_FILE);

  // R21.9: If marker already exists, migration is complete — return immediately.
  if (fs.existsSync(markerPath)) {
    return {
      status: 'skipped',
      message: 'Migration already completed (marker present).',
    };
  }

  // Check if legacy directory exists and has contents.
  if (!fs.existsSync(LEGACY_DATA_DIRECTORY)) {
    return {
      status: 'skipped',
      message: 'No legacy directory found; nothing to migrate.',
    };
  }

  let legacyContents: string[];
  try {
    legacyContents = fs.readdirSync(LEGACY_DATA_DIRECTORY);
  } catch {
    return {
      status: 'skipped',
      message: 'Cannot read legacy directory; nothing to migrate.',
    };
  }

  if (legacyContents.length === 0) {
    return {
      status: 'skipped',
      message: 'Legacy directory is empty; nothing to migrate.',
    };
  }

  // R21.12: Acquire a lock so concurrent instances defer.
  let lockFd: number | undefined;
  try {
    lockFd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.writeSync(lockFd, `${process.pid}\n`);
  } catch (err: unknown) {
    // Lock file already exists — another instance holds it.
    // Check if the lock is stale (older than 5 minutes) and remove if so.
    try {
      const lockStat = fs.statSync(lockPath);
      const ageMs = Date.now() - lockStat.mtimeMs;
      if (ageMs > 5 * 60 * 1000) {
        // Stale lock — remove and retry acquisition
        fs.unlinkSync(lockPath);
        try {
          lockFd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
          fs.writeSync(lockFd, `${process.pid}\n`);
        } catch {
          return {
            status: 'deferred',
            message: 'Migration lock held by another instance; deferring.',
          };
        }
      } else {
        return {
          status: 'deferred',
          message: 'Migration lock held by another instance; deferring.',
        };
      }
    } catch {
      return {
        status: 'deferred',
        message: 'Migration lock held by another instance; deferring.',
      };
    }
  }

  // Perform the migration inside a try/finally to guarantee lock release.
  try {
    const movedItems: string[] = [];
    const skippedConflicts: string[] = [];

    for (const item of legacyContents) {
      const legacyItemPath = path.join(LEGACY_DATA_DIRECTORY, item);
      const canonicalItemPath = path.join(canonicalDir, item);

      // R21.11: Never overwrite existing canonical items.
      if (fs.existsSync(canonicalItemPath)) {
        skippedConflicts.push(item);
        continue;
      }

      // Move (rename) the item from legacy to canonical.
      // Use fs.renameSync for atomic moves on the same filesystem.
      // If cross-device, fall back to copy + delete.
      try {
        fs.renameSync(legacyItemPath, canonicalItemPath);
        movedItems.push(item);
      } catch (renameErr: unknown) {
        // EXDEV: cross-device link — fall back to recursive copy + delete
        if ((renameErr as NodeJS.ErrnoException).code === 'EXDEV') {
          try {
            copyRecursiveSync(legacyItemPath, canonicalItemPath);
            removeRecursiveSync(legacyItemPath);
            movedItems.push(item);
          } catch (copyErr: unknown) {
            // R21.10: Partial failure — do NOT write marker, preserve unmoved legacy content.
            // Clean up the partially-copied canonical item if it exists.
            try {
              if (fs.existsSync(canonicalItemPath)) {
                removeRecursiveSync(canonicalItemPath);
              }
            } catch {
              // Best-effort cleanup
            }
            const errorMsg = `Migration failed while moving "${item}": ${String(copyErr)}`;
            return {
              status: 'failed',
              message: errorMsg,
              movedItems,
              skippedConflicts,
              error: errorMsg,
            };
          }
        } else {
          // R21.10: Any other move error — partial failure.
          const errorMsg = `Migration failed while moving "${item}": ${String(renameErr)}`;
          return {
            status: 'failed',
            message: errorMsg,
            movedItems,
            skippedConflicts,
            error: errorMsg,
          };
        }
      }
    }

    // R21.8: ALL contents moved without error — write the completion marker.
    fs.writeFileSync(markerPath, `Migration completed at ${new Date().toISOString()}\n`);

    return {
      status: 'completed',
      message: `Migration complete. Moved ${movedItems.length} item(s), skipped ${skippedConflicts.length} conflict(s).`,
      movedItems,
      skippedConflicts,
    };
  } finally {
    // Always release the lock.
    if (lockFd !== undefined) {
      try {
        fs.closeSync(lockFd);
      } catch {
        // Ignore close errors
      }
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Lock may have been cleaned up by another process; ignore.
    }
  }
}

/**
 * Recursively copies a file or directory from src to dest.
 * Used as a fallback when fs.renameSync fails with EXDEV (cross-device).
 */
function copyRecursiveSync(src: string, dest: string): void {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src);
    for (const entry of entries) {
      copyRecursiveSync(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

/**
 * Recursively removes a file or directory.
 */
function removeRecursiveSync(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}
