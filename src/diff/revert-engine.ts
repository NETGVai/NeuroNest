/**
 * Revert Engine — Granular revert operations for the DiffViewer.
 *
 * Supports turn-level revert (undo all changes from a specific turn) and
 * file-level revert (undo a single file's changes within a turn).
 * Uses three-way merge logic to ensure reverts don't break subsequent turns.
 * Creates a checkpoint before every revert operation for safety.
 *
 * Requirements: 15.3, 15.4, 15.7
 */

import type { TurnTrackerStore, DiffTurn, DiffTurnFile } from './turn-tracker';

// ─── Types ──────────────────────────────────────────────────────

export interface RevertResult {
  success: boolean;
  checkpointId: string;
  revertedFiles: RevertedFile[];
  conflicts: MergeConflict[];
}

export interface RevertedFile {
  filePath: string;
  previousContent: string | null;
  newContent: string | null;
}

export interface MergeConflict {
  filePath: string;
  reason: string;
  baseContent: string | null;
  oursContent: string | null;
  theirsContent: string | null;
}

/**
 * Abstraction for reading and writing files on disk.
 * Allows dependency injection for testing without actual filesystem access.
 */
export interface FileSystem {
  readFile(filePath: string): string | null;
  writeFile(filePath: string, content: string): void;
  deleteFile(filePath: string): void;
  fileExists(filePath: string): boolean;
}

/**
 * Abstraction for checkpoint creation.
 * The revert engine creates a checkpoint before every revert operation.
 */
export interface CheckpointCreator {
  createCheckpoint(description: string, sessionId: string, turnId?: string): string;
}

// ─── Three-Way Merge ────────────────────────────────────────────

/**
 * Perform a line-based three-way merge.
 *
 * - base: the original content before the reverted change
 * - ours: what we want to revert to (the state before the turn's change)
 * - theirs: the current file content (which may include later modifications)
 *
 * Returns the merged content or null if conflicts are detected.
 */
export function threeWayMerge(
  base: string,
  ours: string,
  theirs: string,
): { merged: string; hasConflicts: boolean } {
  const baseLines = base.split('\n');
  const oursLines = ours.split('\n');
  const theirsLines = theirs.split('\n');

  // If ours and theirs are the same, no merge needed
  if (ours === theirs) {
    return { merged: ours, hasConflicts: false };
  }

  // If base equals theirs, no subsequent changes were made — just apply ours
  if (base === theirs) {
    return { merged: ours, hasConflicts: false };
  }

  // If base equals ours, the revert target is the same as original — nothing to revert
  if (base === ours) {
    return { merged: theirs, hasConflicts: false };
  }

  // Compute diff between base and ours (the revert changes)
  const oursEdits = computeLineEdits(baseLines, oursLines);
  // Compute diff between base and theirs (subsequent changes)
  const theirsEdits = computeLineEdits(baseLines, theirsLines);

  // Check if edits overlap (conflict)
  const oursRanges = getEditedRanges(oursEdits, baseLines.length);
  const theirsRanges = getEditedRanges(theirsEdits, baseLines.length);

  if (rangesOverlap(oursRanges, theirsRanges)) {
    return { merged: '', hasConflicts: true };
  }

  // No overlapping edits — apply both sets of changes
  // Strategy: apply theirs edits to the ours result (since ours is the base we want)
  // But actually, the correct approach is to build the merged result from base
  // applying both sets of non-conflicting edits.
  const merged = applyNonConflictingEdits(baseLines, oursEdits, theirsEdits);
  return { merged: merged.join('\n'), hasConflicts: false };
}

interface LineEdit {
  /** Index in the base array where this edit starts */
  baseStart: number;
  /** Number of lines removed from base */
  baseCount: number;
  /** Lines to insert in place of the removed ones */
  newLines: string[];
}

/**
 * Compute the set of edits that transform baseLines into targetLines.
 * Returns a list of contiguous edit regions.
 */
function computeLineEdits(baseLines: string[], targetLines: string[]): LineEdit[] {
  const lcs = computeLCS(baseLines, targetLines);
  const edits: LineEdit[] = [];

  let baseIdx = 0;
  let targetIdx = 0;
  let lcsIdx = 0;

  while (baseIdx < baseLines.length || targetIdx < targetLines.length) {
    if (lcsIdx < lcs.length) {
      const lcsPair = lcs[lcsIdx]!;
      const lcsBaseIdx = lcsPair[0];
      const lcsTargetIdx = lcsPair[1];

      // Collect deletions/insertions before the next LCS match
      if (baseIdx < lcsBaseIdx || targetIdx < lcsTargetIdx) {
        const edit: LineEdit = {
          baseStart: baseIdx,
          baseCount: lcsBaseIdx - baseIdx,
          newLines: targetLines.slice(targetIdx, lcsTargetIdx),
        };
        if (edit.baseCount > 0 || edit.newLines.length > 0) {
          edits.push(edit);
        }
        baseIdx = lcsBaseIdx;
        targetIdx = lcsTargetIdx;
      }

      // Skip the matching line
      baseIdx++;
      targetIdx++;
      lcsIdx++;
    } else {
      // Remaining lines after the last LCS match
      const edit: LineEdit = {
        baseStart: baseIdx,
        baseCount: baseLines.length - baseIdx,
        newLines: targetLines.slice(targetIdx),
      };
      if (edit.baseCount > 0 || edit.newLines.length > 0) {
        edits.push(edit);
      }
      break;
    }
  }

  return edits;
}

/**
 * Compute LCS (Longest Common Subsequence) of two line arrays.
 * Returns pairs of [baseIndex, targetIndex] for matching lines.
 */
function computeLCS(a: string[], b: string[]): Array<[number, number]> {
  const m = a.length;
  const n = b.length;

  // DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrack to find the actual LCS indices
  const result: Array<[number, number]> = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}

interface EditRange {
  start: number;
  end: number; // exclusive
}

/**
 * Get the base-line ranges affected by a set of edits.
 */
function getEditedRanges(edits: LineEdit[], _baseLength: number): EditRange[] {
  return edits
    .filter((e) => e.baseCount > 0 || e.newLines.length > 0)
    .map((e) => ({
      start: e.baseStart,
      end: e.baseStart + Math.max(e.baseCount, 1),
    }));
}

/**
 * Check if any ranges from set A overlap with any ranges from set B.
 */
function rangesOverlap(a: EditRange[], b: EditRange[]): boolean {
  for (const ra of a) {
    for (const rb of b) {
      if (ra.start < rb.end && rb.start < ra.end) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Apply both sets of non-conflicting edits to produce the merged result.
 * Since we know the edits don't overlap, we can apply them in order.
 */
function applyNonConflictingEdits(
  baseLines: string[],
  oursEdits: LineEdit[],
  theirsEdits: LineEdit[],
): string[] {
  // Merge both edit lists, sorted by baseStart
  const allEdits = [...oursEdits, ...theirsEdits].sort((a, b) => a.baseStart - b.baseStart);

  const result: string[] = [];
  let baseIdx = 0;

  for (const edit of allEdits) {
    // Copy unchanged lines before this edit
    while (baseIdx < edit.baseStart) {
      result.push(baseLines[baseIdx] ?? '');
      baseIdx++;
    }
    // Apply the edit: skip baseCount lines, insert newLines
    result.push(...edit.newLines);
    baseIdx += edit.baseCount;
  }

  // Copy remaining unchanged lines
  while (baseIdx < baseLines.length) {
    result.push(baseLines[baseIdx] ?? '');
    baseIdx++;
  }

  return result;
}

// ─── Revert Engine ──────────────────────────────────────────────

/**
 * RevertEngine — Provides granular revert operations for the DiffViewer.
 *
 * Usage:
 *   const engine = new RevertEngine(store, fs, checkpointCreator);
 *   const result = engine.revertTurn(sessionId, turnId);
 *   const result = engine.revertFile(sessionId, turnId, filePath);
 *
 * Design:
 * - Before every revert, creates a checkpoint for safety
 * - For turn-level revert: undoes all file changes from that turn
 * - For file-level revert: undoes a single file's changes within a turn
 * - Uses three-way merge to preserve subsequent turns' changes
 */
export class RevertEngine {
  constructor(
    private store: TurnTrackerStore,
    private fs: FileSystem,
    private checkpointCreator: CheckpointCreator,
  ) {}

  /**
   * Revert all changes from a specific turn.
   * Undoes every file modification made in that turn while preserving
   * changes from subsequent turns via three-way merge.
   *
   * Requirements: 15.3, 15.7
   */
  revertTurn(sessionId: string, turnId: string): RevertResult {
    const turn = this.store.getTurn(turnId);
    if (!turn) {
      return {
        success: false,
        checkpointId: '',
        revertedFiles: [],
        conflicts: [{ filePath: '', reason: `Turn ${turnId} not found`, baseContent: null, oursContent: null, theirsContent: null }],
      };
    }

    if (turn.sessionId !== sessionId) {
      return {
        success: false,
        checkpointId: '',
        revertedFiles: [],
        conflicts: [{ filePath: '', reason: `Turn ${turnId} does not belong to session ${sessionId}`, baseContent: null, oursContent: null, theirsContent: null }],
      };
    }

    // Create checkpoint before revert
    const checkpointId = this.checkpointCreator.createCheckpoint(
      `Before revert: turn ${turn.turnIndex} (${turnId})`,
      sessionId,
      turnId,
    );

    const files = this.store.getFilesForTurn(turnId);
    const revertedFiles: RevertedFile[] = [];
    const conflicts: MergeConflict[] = [];

    // Get all subsequent turns for this session to check for conflicts
    const allTurns = this.store.getTurnsForSession(sessionId);
    const subsequentTurns = allTurns.filter((t) => t.turnIndex > turn.turnIndex);

    for (const file of files) {
      const result = this.revertSingleFile(file, subsequentTurns);
      if (result.conflict) {
        conflicts.push(result.conflict);
      } else if (result.reverted) {
        revertedFiles.push(result.reverted);
      }
    }

    return {
      success: conflicts.length === 0,
      checkpointId,
      revertedFiles,
      conflicts,
    };
  }

  /**
   * Revert a single file's changes within a specific turn.
   * Undoes that file's modifications while preserving other files in the turn
   * and subsequent turns' changes.
   *
   * Requirements: 15.4, 15.7
   */
  revertFile(sessionId: string, turnId: string, filePath: string): RevertResult {
    const turn = this.store.getTurn(turnId);
    if (!turn) {
      return {
        success: false,
        checkpointId: '',
        revertedFiles: [],
        conflicts: [{ filePath, reason: `Turn ${turnId} not found`, baseContent: null, oursContent: null, theirsContent: null }],
      };
    }

    if (turn.sessionId !== sessionId) {
      return {
        success: false,
        checkpointId: '',
        revertedFiles: [],
        conflicts: [{ filePath, reason: `Turn ${turnId} does not belong to session ${sessionId}`, baseContent: null, oursContent: null, theirsContent: null }],
      };
    }

    const files = this.store.getFilesForTurn(turnId);
    const targetFile = files.find((f) => f.filePath === filePath);

    if (!targetFile) {
      return {
        success: false,
        checkpointId: '',
        revertedFiles: [],
        conflicts: [{ filePath, reason: `File ${filePath} not found in turn ${turnId}`, baseContent: null, oursContent: null, theirsContent: null }],
      };
    }

    // Create checkpoint before revert
    const checkpointId = this.checkpointCreator.createCheckpoint(
      `Before revert: ${filePath} in turn ${turn.turnIndex}`,
      sessionId,
      turnId,
    );

    // Get subsequent turns for conflict checking
    const allTurns = this.store.getTurnsForSession(sessionId);
    const subsequentTurns = allTurns.filter((t) => t.turnIndex > turn.turnIndex);

    const result = this.revertSingleFile(targetFile, subsequentTurns);

    if (result.conflict) {
      return {
        success: false,
        checkpointId,
        revertedFiles: [],
        conflicts: [result.conflict],
      };
    }

    return {
      success: true,
      checkpointId,
      revertedFiles: result.reverted ? [result.reverted] : [],
      conflicts: [],
    };
  }

  /**
   * Revert a single file change, applying three-way merge if subsequent
   * turns also modified the same file.
   */
  private revertSingleFile(
    file: DiffTurnFile,
    subsequentTurns: DiffTurn[],
  ): { reverted?: RevertedFile; conflict?: MergeConflict } {
    // Determine what the file should revert to
    const revertTarget = file.beforeContent; // What the file was before this turn's change

    // Check if subsequent turns modified the same file
    const subsequentChanges = this.getSubsequentChangesForFile(file.filePath, subsequentTurns);

    if (file.changeType === 'added') {
      // File was created in this turn — reverting means deleting it
      if (subsequentChanges.length > 0) {
        // Subsequent turns modified this file — conflict
        // We can't simply delete it; the file has been changed since
        const currentContent = this.fs.readFile(file.filePath);
        return {
          conflict: {
            filePath: file.filePath,
            reason: 'File was added in this turn but modified in subsequent turns',
            baseContent: file.afterContent,
            oursContent: null, // revert wants to delete
            theirsContent: currentContent,
          },
        };
      }

      // No subsequent changes — safe to delete
      const previousContent = this.fs.readFile(file.filePath);
      this.fs.deleteFile(file.filePath);
      return {
        reverted: {
          filePath: file.filePath,
          previousContent,
          newContent: null,
        },
      };
    }

    if (file.changeType === 'deleted') {
      // File was deleted in this turn — reverting means restoring it
      if (subsequentChanges.length > 0) {
        // This is unusual: file was deleted but also modified later?
        // The later modification must have re-created it.
        // Use three-way merge between the restored content and current
        const currentContent = this.fs.readFile(file.filePath);
        if (currentContent !== null) {
          // File exists again (re-created later) — use three-way merge
          const base = file.beforeContent || '';
          const ours = file.beforeContent || ''; // revert target
          const theirs = currentContent;
          const mergeResult = threeWayMerge(base, ours, theirs);

          if (mergeResult.hasConflicts) {
            return {
              conflict: {
                filePath: file.filePath,
                reason: 'File was deleted in this turn but re-created and modified in subsequent turns',
                baseContent: file.beforeContent,
                oursContent: file.beforeContent,
                theirsContent: currentContent,
              },
            };
          }

          const previousContent = currentContent;
          this.fs.writeFile(file.filePath, mergeResult.merged);
          return {
            reverted: {
              filePath: file.filePath,
              previousContent,
              newContent: mergeResult.merged,
            },
          };
        }
      }

      // No subsequent changes — restore the file
      const content = file.beforeContent || '';
      this.fs.writeFile(file.filePath, content);
      return {
        reverted: {
          filePath: file.filePath,
          previousContent: null,
          newContent: content,
        },
      };
    }

    // File was modified — reverting means restoring to beforeContent
    if (subsequentChanges.length === 0) {
      // No subsequent changes — safe to revert directly
      const currentContent = this.fs.readFile(file.filePath);
      const content = revertTarget || '';
      this.fs.writeFile(file.filePath, content);
      return {
        reverted: {
          filePath: file.filePath,
          previousContent: currentContent,
          newContent: content,
        },
      };
    }

    // Subsequent turns also modified this file — use three-way merge
    const currentContent = this.fs.readFile(file.filePath);
    if (currentContent === null) {
      // File was deleted in a subsequent turn — conflict
      return {
        conflict: {
          filePath: file.filePath,
          reason: 'File was modified in this turn but deleted in a subsequent turn',
          baseContent: file.afterContent,
          oursContent: file.beforeContent,
          theirsContent: null,
        },
      };
    }

    // Three-way merge:
    // base = afterContent (what the file was after this turn's change — the shared ancestor)
    // ours = beforeContent (what we want to revert to)
    // theirs = currentContent (what it is now after subsequent changes)
    const base = file.afterContent || '';
    const ours = revertTarget || '';
    const theirs = currentContent;

    const mergeResult = threeWayMerge(base, ours, theirs);

    if (mergeResult.hasConflicts) {
      return {
        conflict: {
          filePath: file.filePath,
          reason: 'Conflicting changes between revert target and subsequent modifications',
          baseContent: base,
          oursContent: ours,
          theirsContent: theirs,
        },
      };
    }

    const previousContent = currentContent;
    this.fs.writeFile(file.filePath, mergeResult.merged);
    return {
      reverted: {
        filePath: file.filePath,
        previousContent,
        newContent: mergeResult.merged,
      },
    };
  }

  /**
   * Find all subsequent file changes that affect the same file path.
   */
  private getSubsequentChangesForFile(filePath: string, subsequentTurns: DiffTurn[]): DiffTurnFile[] {
    const changes: DiffTurnFile[] = [];
    for (const turn of subsequentTurns) {
      const files = this.store.getFilesForTurn(turn.id);
      for (const file of files) {
        if (file.filePath === filePath) {
          changes.push(file);
        }
      }
    }
    return changes;
  }
}
