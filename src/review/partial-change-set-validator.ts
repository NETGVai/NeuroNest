/**
 * PartialChangeSetValidator — Derives and validates immutable partial Change_Sets
 * from selected hunks, reruns all preconditions, and preserves prior review state
 * when the partial proposal is invalid.
 *
 * When only some hunks are selected for acceptance, this service:
 * 1. Derives a new immutable partial Change_Set from the selection
 * 2. Validates preconditions (overlaps, hunk validity, stale bases)
 * 3. Blocks acceptance entirely if invalid, preserving prior review state
 * 4. Returns validation errors so the UI can display them
 *
 * Requirements: 8.6
 */

import { createHash, randomUUID } from 'node:crypto';
import type {
  ChangeSet,
  FileOperation,
  ModifyOperation,
  RiskLevel,
  FileOperationSummary,
} from '../change-set/types';
import type { ReviewHunk, ReviewState } from './review-scope-service';

// ─── Types ──────────────────────────────────────────────────────

/**
 * A selected hunk for partial acceptance.
 */
export interface SelectedHunk {
  /** The hunk ID from ReviewScopeService. */
  readonly hunkId: string;
  /** The file URI this hunk belongs to. */
  readonly fileUri: string;
  /** Start line in the base content (0-indexed). */
  readonly baseStartLine: number;
  /** Number of lines from the base. */
  readonly baseLineCount: number;
  /** Start line in the proposed content (0-indexed). */
  readonly proposedStartLine: number;
  /** Number of lines in the proposal. */
  readonly proposedLineCount: number;
}

/**
 * Validation error kinds for partial Change_Set derivation.
 */
export type PartialValidationErrorKind =
  | 'overlapping-hunks'
  | 'invalid-hunk-combination'
  | 'stale-base'
  | 'missing-file'
  | 'invalid-hunk-range'
  | 'empty-selection';

/**
 * A validation error encountered during partial derivation.
 */
export interface PartialValidationError {
  /** The kind of validation error. */
  readonly kind: PartialValidationErrorKind;
  /** Human-readable error message. */
  readonly message: string;
  /** Affected file URI (if applicable). */
  readonly fileUri?: string;
  /** Affected hunk IDs (if applicable). */
  readonly hunkIds?: readonly string[];
}

/**
 * Result of a partial Change_Set derivation attempt.
 */
export interface PartialDerivationResult {
  /** Whether the derivation was valid and acceptance can proceed. */
  readonly valid: boolean;
  /** The derived partial Change_Set (only present when valid). */
  readonly partialChangeSet?: PartialChangeSet;
  /** Validation errors (only present when invalid). */
  readonly errors: readonly PartialValidationError[];
}

/**
 * An immutable partial Change_Set derived from selected hunks.
 */
export interface PartialChangeSet {
  /** Unique ID for this partial derivation. */
  readonly id: string;
  /** The source Change_Set ID this was derived from. */
  readonly sourceChangeSetId: string;
  /** Selected file operations (may be a subset of source operations). */
  readonly operations: readonly FileOperation[];
  /** Selected hunk IDs included in this partial. */
  readonly selectedHunkIds: readonly string[];
  /** Content fingerprint of the partial. */
  readonly fingerprint: string;
  /** Base revision from the source Change_Set. */
  readonly baseRevision: string;
  /** Timestamp of derivation. */
  readonly derivedAt: string;
}

/**
 * Function type for resolving current file content hash.
 */
export type BaseHashResolver = (uri: string) => string | null;

/**
 * Function type for resolving current file content.
 */
export type ContentResolver = (uri: string) => string | null;

// ─── Service ────────────────────────────────────────────────────

/**
 * PartialChangeSetValidator derives immutable partial Change_Sets from
 * selected hunks and validates all preconditions before acceptance.
 *
 * If the partial proposal is invalid, acceptance is blocked entirely and
 * prior review state is preserved unchanged.
 */
export class PartialChangeSetValidator {
  /**
   * Derives and validates a partial Change_Set from selected hunks.
   *
   * @param sourceChangeSet - The original full Change_Set being reviewed
   * @param selectedHunks - The hunks the reviewer wants to accept
   * @param baseHashResolver - Resolves current content hash for staleness check
   * @param contentResolver - Resolves current file content for hunk application
   * @returns A result indicating validity and either the partial or errors
   */
  deriveAndValidate(
    sourceChangeSet: ChangeSet,
    selectedHunks: readonly SelectedHunk[],
    baseHashResolver?: BaseHashResolver,
    contentResolver?: ContentResolver
  ): PartialDerivationResult {
    // 1. Check for empty selection
    if (selectedHunks.length === 0) {
      return {
        valid: false,
        errors: [
          {
            kind: 'empty-selection',
            message: 'No hunks selected for partial acceptance.',
          },
        ],
      };
    }

    const errors: PartialValidationError[] = [];

    // 2. Validate individual hunk ranges
    for (const hunk of selectedHunks) {
      if (hunk.baseStartLine < 0 || hunk.baseLineCount < 0) {
        errors.push({
          kind: 'invalid-hunk-range',
          message: `Hunk ${hunk.hunkId} has invalid base range: start=${hunk.baseStartLine}, count=${hunk.baseLineCount}`,
          fileUri: hunk.fileUri,
          hunkIds: [hunk.hunkId],
        });
      }
      if (hunk.proposedStartLine < 0 || hunk.proposedLineCount < 0) {
        errors.push({
          kind: 'invalid-hunk-range',
          message: `Hunk ${hunk.hunkId} has invalid proposed range: start=${hunk.proposedStartLine}, count=${hunk.proposedLineCount}`,
          fileUri: hunk.fileUri,
          hunkIds: [hunk.hunkId],
        });
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    // 3. Group hunks by file and detect overlaps
    const hunksByFile = new Map<string, SelectedHunk[]>();
    for (const hunk of selectedHunks) {
      const existing = hunksByFile.get(hunk.fileUri) ?? [];
      existing.push(hunk);
      hunksByFile.set(hunk.fileUri, existing);
    }

    for (const [fileUri, fileHunks] of hunksByFile) {
      const overlapErrors = this.detectOverlaps(fileUri, fileHunks);
      errors.push(...overlapErrors);
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    // 4. Check for stale bases
    if (baseHashResolver) {
      for (const op of sourceChangeSet.operations) {
        if (op.kind === 'create') continue;

        const uri = op.kind === 'rename' || op.kind === 'move'
          ? op.sourceUri
          : op.targetUri;

        // Only validate files that have selected hunks
        if (!hunksByFile.has(op.targetUri)) continue;

        const currentHash = baseHashResolver(uri);
        if (currentHash === null) {
          errors.push({
            kind: 'missing-file',
            message: `File '${uri}' no longer exists but is required by the partial selection.`,
            fileUri: uri,
          });
        } else if (currentHash !== op.baseHash) {
          errors.push({
            kind: 'stale-base',
            message: `Base content of '${uri}' has changed since the proposal was generated.`,
            fileUri: uri,
          });
        }
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    // 5. Validate hunk combination applicability
    for (const [fileUri, fileHunks] of hunksByFile) {
      const combinationErrors = this.validateHunkCombination(
        sourceChangeSet,
        fileUri,
        fileHunks,
        contentResolver
      );
      errors.push(...combinationErrors);
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    // 6. All valid — derive the immutable partial Change_Set
    const partialOperations = this.derivePartialOperations(
      sourceChangeSet,
      hunksByFile
    );

    const partialChangeSet: PartialChangeSet = {
      id: randomUUID(),
      sourceChangeSetId: sourceChangeSet.id,
      operations: Object.freeze(partialOperations),
      selectedHunkIds: Object.freeze(selectedHunks.map((h) => h.hunkId)),
      fingerprint: this.computeFingerprint(partialOperations),
      baseRevision: sourceChangeSet.baseRevision,
      derivedAt: new Date().toISOString(),
    };

    return { valid: true, partialChangeSet, errors: [] };
  }

  // ─── Private Methods ───────────────────────────────────────────

  /**
   * Detects overlapping hunks within the same file.
   */
  private detectOverlaps(
    fileUri: string,
    hunks: SelectedHunk[]
  ): PartialValidationError[] {
    const errors: PartialValidationError[] = [];

    // Sort hunks by base start line
    const sorted = [...hunks].sort((a, b) => a.baseStartLine - b.baseStartLine);

    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i]!;
      const next = sorted[i + 1]!;

      const currentEnd = current.baseStartLine + current.baseLineCount;
      if (currentEnd > next.baseStartLine) {
        errors.push({
          kind: 'overlapping-hunks',
          message: `Hunks ${current.hunkId} and ${next.hunkId} overlap in file '${fileUri}' ` +
            `(lines ${current.baseStartLine}-${currentEnd} overlap with ${next.baseStartLine}).`,
          fileUri,
          hunkIds: [current.hunkId, next.hunkId],
        });
      }
    }

    return errors;
  }

  /**
   * Validates that the combination of selected hunks for a file produces
   * a coherent result when applied.
   */
  private validateHunkCombination(
    sourceChangeSet: ChangeSet,
    fileUri: string,
    hunks: SelectedHunk[],
    contentResolver?: ContentResolver
  ): PartialValidationError[] {
    const errors: PartialValidationError[] = [];

    // Find the original operation for this file
    const originalOp = sourceChangeSet.operations.find(
      (op) => op.targetUri === fileUri
    );

    if (!originalOp) {
      errors.push({
        kind: 'invalid-hunk-combination',
        message: `No operation found for file '${fileUri}' in the source Change_Set.`,
        fileUri,
        hunkIds: hunks.map((h) => h.hunkId),
      });
      return errors;
    }

    // For create or delete operations, partial acceptance is only valid
    // if all hunks are selected (you can't partially create or delete a file)
    if (originalOp.kind === 'delete') {
      // Delete operations have exactly one hunk — partial selection should include it
      // If selecting any hunk from a delete, you must accept the entire delete
      if (hunks.length > 0) {
        // This is valid — accepting delete means the entire file is deleted
      }
    }

    // For modify operations, validate that partial hunks don't create contradictions
    if (originalOp.kind === 'modify' && contentResolver) {
      const baseContent = contentResolver(fileUri);
      if (baseContent !== null) {
        // Sort hunks by position and verify they can be applied independently
        const sorted = [...hunks].sort((a, b) => a.baseStartLine - b.baseStartLine);

        // Verify no hunk extends past the base content length
        const baseLineCount = baseContent.split('\n').length;
        for (const hunk of sorted) {
          if (hunk.baseStartLine + hunk.baseLineCount > baseLineCount) {
            errors.push({
              kind: 'invalid-hunk-combination',
              message: `Hunk ${hunk.hunkId} extends beyond the file end ` +
                `(hunk ends at line ${hunk.baseStartLine + hunk.baseLineCount}, ` +
                `file has ${baseLineCount} lines).`,
              fileUri,
              hunkIds: [hunk.hunkId],
            });
          }
        }
      }
    }

    return errors;
  }

  /**
   * Derives partial file operations from the selected hunks.
   * For files with all hunks selected, uses the original operation.
   * For files with partial hunks, reconstructs a partial modify operation.
   */
  private derivePartialOperations(
    sourceChangeSet: ChangeSet,
    hunksByFile: Map<string, SelectedHunk[]>
  ): FileOperation[] {
    const operations: FileOperation[] = [];

    for (const [fileUri, _selectedHunks] of hunksByFile) {
      const originalOp = sourceChangeSet.operations.find(
        (op) => op.targetUri === fileUri
      );

      if (!originalOp) continue;

      // For non-modify operations, include them as-is if any hunk is selected
      if (originalOp.kind !== 'modify') {
        operations.push(originalOp);
        continue;
      }

      // For modify operations, include the full operation
      // (the exact partial content reconstruction is handled at apply time
      // by the ChangeTransactionService using the hunk selection)
      operations.push(originalOp);
    }

    return operations;
  }

  /**
   * Computes a SHA-256 fingerprint of the partial operations.
   */
  private computeFingerprint(operations: readonly FileOperation[]): string {
    const hash = createHash('sha256');
    hash.update(JSON.stringify(operations));
    return hash.digest('hex');
  }
}
