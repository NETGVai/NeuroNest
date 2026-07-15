// ─── Progress Hash ─────────────────────────────────────────────
// Computes a composite SHA-256 hash from PLAN.md step statuses,
// verifier verdict JSON, and a tree-hash of touched file contents.
// Used for Ralph Wiggum loop detection — identical hashes across
// consecutive passes indicate no measurable progress.
// Requirements: 26.1, 26.3, 26.4

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { ProgressHasherLike } from '../index';

/**
 * Input structure for progress hash computation.
 * All fields are derived from on-disk state only (REQ-26.3).
 */
export interface ProgressHashInput {
  /** Extracted step statuses from PLAN.md */
  planMdStepStatuses: string;
  /** JSON of verifier passes/failures */
  verifierVerdict: string;
  /** Tree-hash of all touched file contents */
  touchedFilesHash: string;
}

/** Separator used to join the three hash input fields */
const FIELD_SEPARATOR = '\n---\n';

/**
 * ProgressHasher computes SHA-256 hashes from on-disk loop state.
 *
 * The hash is a composite of three sources:
 * 1. PLAN.md step statuses (the status value of each step)
 * 2. Verifier subagent's passes/failures verdict
 * 3. Tree-hash of all files in paths touched during the pass
 *
 * Implements ProgressHasherLike from the Loop Engine interface.
 */
export class ProgressHasher implements ProgressHasherLike {
  /**
   * Compute a SHA-256 hash from the composite of plan step statuses,
   * verifier verdict, and touched files hash, joined by '\n---\n'.
   *
   * @param input - The three on-disk state components
   * @returns Hex-encoded SHA-256 hash string
   */
  compute(input: ProgressHashInput): string {
    const composite = [
      input.planMdStepStatuses,
      input.verifierVerdict,
      input.touchedFilesHash,
    ].join(FIELD_SEPARATOR);

    return createHash('sha256').update(composite, 'utf-8').digest('hex');
  }

  /**
   * Compute a tree-hash of file contents at the given paths.
   *
   * Reads each file from disk (REQ-26.3: on-disk state only),
   * sorts paths lexicographically for determinism, concatenates
   * their content, and returns the SHA-256 hash.
   *
   * Missing files are skipped gracefully — only existing files
   * contribute to the hash.
   *
   * @param paths - Array of absolute or relative file paths to hash
   * @returns Hex-encoded SHA-256 hash of the concatenated file contents
   */
  async computeTreeHash(paths: string[]): Promise<string> {
    const sortedPaths = [...paths].sort();
    const hash = createHash('sha256');
    let hasContent = false;

    for (const filePath of sortedPaths) {
      try {
        const content = await readFile(filePath, 'utf-8');
        // Include the path as a separator to distinguish files with identical content
        hash.update(filePath, 'utf-8');
        hash.update('\0', 'utf-8');
        hash.update(content, 'utf-8');
        hash.update('\0', 'utf-8');
        hasContent = true;
      } catch {
        // File does not exist or is unreadable — skip gracefully
        continue;
      }
    }

    if (!hasContent) {
      // No files found — return hash of empty string for consistency
      return createHash('sha256').update('', 'utf-8').digest('hex');
    }

    return hash.digest('hex');
  }
}
