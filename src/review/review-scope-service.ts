/**
 * ReviewScopeService — Provides file-level, hunk-level, and line-level review scopes.
 *
 * Review scopes are built on top of the immutable shadow models from ShadowModelService.
 * Each scope tracks review state (reviewed/pending/accepted/rejected) without modifying
 * the workspace. The service never mutates authoritative workspace content.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.5, 8.1, 8.2, 8.3, 8.4
 */

import { ShadowModelService, ShadowModel } from '../change-set/shadow-model-service';
import { ChangeSet, FileOperation } from '../change-set/types';

// ─── Types ──────────────────────────────────────────────────────

/** The level at which a review scope operates. */
export type ReviewScopeLevel = 'file' | 'hunk' | 'line';

/** Review decision for a scope item. */
export type ReviewState = 'pending' | 'reviewed' | 'accepted' | 'rejected';

/** Represents a contiguous range of changed lines within a file. */
export interface ReviewHunk {
  /** Unique hunk identifier within the change set. */
  readonly id: string;
  /** File URI this hunk belongs to. */
  readonly fileUri: string;
  /** Start line in the base content (0-indexed). */
  readonly baseStartLine: number;
  /** Number of lines from the base. */
  readonly baseLineCount: number;
  /** Start line in the proposed content (0-indexed). */
  readonly proposedStartLine: number;
  /** Number of lines in the proposal. */
  readonly proposedLineCount: number;
  /** Lines added in this hunk. */
  readonly additions: number;
  /** Lines removed in this hunk. */
  readonly removals: number;
  /** The hunk content (unified diff fragment). */
  readonly content: string;
}

/** Represents a single changed line within a hunk. */
export interface ReviewLine {
  /** Unique line identifier within the hunk. */
  readonly id: string;
  /** The hunk this line belongs to. */
  readonly hunkId: string;
  /** File URI. */
  readonly fileUri: string;
  /** Line number in the proposed content. */
  readonly lineNumber: number;
  /** The type of change: added, removed, or context. */
  readonly changeType: 'added' | 'removed' | 'context';
  /** The line content. */
  readonly content: string;
}

/** A file-level review scope entry. */
export interface FileScopeEntry {
  readonly fileUri: string;
  readonly operation: FileOperation;
  readonly shadowModel: ShadowModel | null;
  readonly hunks: readonly ReviewHunk[];
  readonly state: ReviewState;
}

/** A hunk-level review scope entry. */
export interface HunkScopeEntry {
  readonly hunk: ReviewHunk;
  readonly fileUri: string;
  readonly lines: readonly ReviewLine[];
  readonly state: ReviewState;
}

/** A line-level review scope entry. */
export interface LineScopeEntry {
  readonly line: ReviewLine;
  readonly state: ReviewState;
}

// ─── Service ────────────────────────────────────────────────────

/**
 * ReviewScopeService manages granular review views using immutable shadow models.
 * Provides file-level, hunk-level, and line-level review scopes with state tracking.
 */
export class ReviewScopeService {
  /** State tracked per scope item. Key format: `<changeSetId>:<level>:<itemId>` */
  private readonly stateMap = new Map<string, ReviewState>();

  constructor(private readonly shadowModelService: ShadowModelService) {}

  /**
   * Returns the file-level review scope for a Change_Set.
   * Shows all changes grouped by file with their shadow models.
   */
  getFileLevelScope(changeSet: ChangeSet): FileScopeEntry[] {
    return changeSet.operations.map((op) => {
      const fileUri = this.getOperationUri(op);
      const shadowModel = this.findShadowModel(changeSet.id, fileUri);
      const hunks = this.deriveHunks(changeSet.id, fileUri, shadowModel);
      const stateKey = this.buildStateKey(changeSet.id, 'file', fileUri);

      return {
        fileUri,
        operation: op,
        shadowModel,
        hunks,
        state: this.stateMap.get(stateKey) ?? 'pending',
      };
    });
  }

  /**
   * Returns the hunk-level review scope for a specific file in a Change_Set.
   * Shows individual hunks within the file with their lines.
   */
  getHunkLevelScope(changeSet: ChangeSet, fileUri: string): HunkScopeEntry[] {
    const shadowModel = this.findShadowModel(changeSet.id, fileUri);
    const hunks = this.deriveHunks(changeSet.id, fileUri, shadowModel);

    return hunks.map((hunk) => {
      const lines = this.deriveLines(hunk);
      const stateKey = this.buildStateKey(changeSet.id, 'hunk', hunk.id);

      return {
        hunk,
        fileUri,
        lines,
        state: this.stateMap.get(stateKey) ?? 'pending',
      };
    });
  }

  /**
   * Returns the line-level review scope for a specific hunk.
   * Shows individual line changes within the hunk.
   */
  getLineLevelScope(changeSet: ChangeSet, hunkId: string): LineScopeEntry[] {
    // Find the hunk across all files
    for (const op of changeSet.operations) {
      const fileUri = this.getOperationUri(op);
      const shadowModel = this.findShadowModel(changeSet.id, fileUri);
      const hunks = this.deriveHunks(changeSet.id, fileUri, shadowModel);
      const hunk = hunks.find((h) => h.id === hunkId);

      if (hunk) {
        const lines = this.deriveLines(hunk);
        return lines.map((line) => {
          const stateKey = this.buildStateKey(changeSet.id, 'line', line.id);
          return {
            line,
            state: this.stateMap.get(stateKey) ?? 'pending',
          };
        });
      }
    }

    return [];
  }

  /**
   * Updates the review state for a specific scope item.
   */
  setReviewState(
    changeSetId: string,
    level: ReviewScopeLevel,
    itemId: string,
    state: ReviewState
  ): void {
    const stateKey = this.buildStateKey(changeSetId, level, itemId);
    this.stateMap.set(stateKey, state);
  }

  /**
   * Gets the current review state for a scope item.
   */
  getReviewState(
    changeSetId: string,
    level: ReviewScopeLevel,
    itemId: string
  ): ReviewState {
    const stateKey = this.buildStateKey(changeSetId, level, itemId);
    return this.stateMap.get(stateKey) ?? 'pending';
  }

  /**
   * Gets pending items count at any level for a Change_Set.
   */
  getPendingCount(changeSet: ChangeSet, level: ReviewScopeLevel): number {
    if (level === 'file') {
      const fileScope = this.getFileLevelScope(changeSet);
      return fileScope.filter((f) => f.state === 'pending').length;
    }

    let count = 0;
    for (const op of changeSet.operations) {
      const fileUri = this.getOperationUri(op);
      if (level === 'hunk') {
        const hunkScope = this.getHunkLevelScope(changeSet, fileUri);
        count += hunkScope.filter((h) => h.state === 'pending').length;
      } else {
        const hunkScope = this.getHunkLevelScope(changeSet, fileUri);
        for (const hEntry of hunkScope) {
          const lineScope = this.getLineLevelScope(changeSet, hEntry.hunk.id);
          count += lineScope.filter((l) => l.state === 'pending').length;
        }
      }
    }
    return count;
  }

  /**
   * Clears all review states for a Change_Set.
   */
  clearStates(changeSetId: string): void {
    for (const key of this.stateMap.keys()) {
      if (key.startsWith(`${changeSetId}:`)) {
        this.stateMap.delete(key);
      }
    }
  }

  // ─── Private helpers ────────────────────────────────────────────

  private getOperationUri(op: FileOperation): string {
    return op.kind === 'rename' || op.kind === 'move'
      ? op.targetUri
      : op.targetUri;
  }

  private findShadowModel(changeSetId: string, fileUri: string): ShadowModel | null {
    const models = this.shadowModelService.listByChangeSet(changeSetId);
    return models.find((m) => m.originalUri === fileUri) ?? null;
  }

  private deriveHunks(
    changeSetId: string,
    fileUri: string,
    shadowModel: ShadowModel | null
  ): ReviewHunk[] {
    if (!shadowModel) return [];

    // Handle create operations (null base) — everything is additions
    if (shadowModel.baseContent === null && shadowModel.proposedContent) {
      const proposedLines = shadowModel.proposedContent.split('\n');
      return [
        {
          id: `${changeSetId}:${fileUri}:hunk-0`,
          fileUri,
          baseStartLine: 0,
          baseLineCount: 0,
          proposedStartLine: 0,
          proposedLineCount: proposedLines.length,
          additions: proposedLines.length,
          removals: 0,
          content: shadowModel.proposedContent,
        },
      ];
    }

    // Handle delete operations (null proposed) — everything is removals
    if (shadowModel.proposedContent === null && shadowModel.baseContent) {
      const baseLines = shadowModel.baseContent.split('\n');
      return [
        {
          id: `${changeSetId}:${fileUri}:hunk-0`,
          fileUri,
          baseStartLine: 0,
          baseLineCount: baseLines.length,
          proposedStartLine: 0,
          proposedLineCount: 0,
          additions: 0,
          removals: baseLines.length,
          content: '',
        },
      ];
    }

    // Both base and proposed exist — compute line-level diff
    const baseLines = (shadowModel.baseContent ?? '').split('\n');
    const proposedLines = (shadowModel.proposedContent ?? '').split('\n');

    const hunks: ReviewHunk[] = [];
    let hunkIndex = 0;
    let i = 0;
    const maxLen = Math.max(baseLines.length, proposedLines.length);

    while (i < maxLen) {
      // Find start of a differing region
      if (i < baseLines.length && i < proposedLines.length && baseLines[i] === proposedLines[i]) {
        i++;
        continue;
      }

      // Found a difference — expand to the full hunk
      const hunkStart = i;
      while (
        i < maxLen &&
        (i >= baseLines.length || i >= proposedLines.length || baseLines[i] !== proposedLines[i])
      ) {
        i++;
      }

      const baseCount = Math.min(i, baseLines.length) - Math.min(hunkStart, baseLines.length);
      const proposedCount = Math.min(i, proposedLines.length) - Math.min(hunkStart, proposedLines.length);

      const hunkContent = proposedLines.slice(hunkStart, Math.min(i, proposedLines.length)).join('\n');

      hunks.push({
        id: `${changeSetId}:${fileUri}:hunk-${hunkIndex}`,
        fileUri,
        baseStartLine: hunkStart,
        baseLineCount: Math.max(0, baseCount),
        proposedStartLine: hunkStart,
        proposedLineCount: Math.max(0, proposedCount),
        additions: Math.max(0, proposedCount - Math.min(baseCount, proposedCount)),
        removals: Math.max(0, baseCount - Math.min(baseCount, proposedCount)),
        content: hunkContent,
      });

      hunkIndex++;
    }

    return hunks;
  }

  private deriveLines(hunk: ReviewHunk): ReviewLine[] {
    const lines: ReviewLine[] = [];
    const contentLines = hunk.content.split('\n');

    for (let i = 0; i < contentLines.length; i++) {
      const changeType: 'added' | 'removed' | 'context' =
        i < hunk.additions ? 'added' : 'context';

      lines.push({
        id: `${hunk.id}:line-${i}`,
        hunkId: hunk.id,
        fileUri: hunk.fileUri,
        lineNumber: hunk.proposedStartLine + i,
        changeType,
        content: contentLines[i],
      });
    }

    return lines;
  }

  private buildStateKey(
    changeSetId: string,
    level: ReviewScopeLevel,
    itemId: string
  ): string {
    return `${changeSetId}:${level}:${itemId}`;
  }
}
