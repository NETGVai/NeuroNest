/**
 * Rewind Operation — Orchestrates full rewind-with-confirmation flow.
 *
 * Combines the Hunk Tracker and Rewind Service to provide rewind operations
 * that check for external-edit conflicts before restoring files.
 *
 * If external edits overlap with hunks being reverted, the operation requires
 * explicit confirmation before proceeding. Produces before/after diff info
 * for UI display.
 *
 * Validates: Requirements 14.6, 14.7, 14.8
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { HunkTracker, HunkRecord } from './hunk-tracker.js';
import { RewindService, RewindResult, SnapshotEntry } from './rewind-service.js';

// ─── Types ──────────────────────────────────────────────────────

/** Diff information for a single file affected by a rewind. */
export interface FileDiff {
  /** Absolute file path. */
  file: string;
  /** Line range affected (start, end — 1-indexed). */
  linesAffected: { startLine: number; endLine: number };
  /** Current content of the file (before rewind). */
  beforeContent: string;
  /** Content that will be restored (from blob snapshot). */
  afterContent: string;
  /** Whether external edits would be lost if this file is rewound. */
  hasConflict: boolean;
}

/** Preview of a rewind operation without applying changes. */
export interface RewindPreview {
  /** Tool call ID being previewed. */
  callId: string;
  /** File diffs showing what would change. */
  diffs: FileDiff[];
  /** Whether any files have external-edit conflicts. */
  hasConflicts: boolean;
  /** Files with external-edit conflicts. */
  conflictingFiles: string[];
}

/** Confirmation payload for proceeding with a conflicting rewind. */
export interface RewindConfirmation {
  /** Tool call ID to rewind. */
  callId: string;
  /** Whether the user explicitly confirmed overwriting external edits. */
  confirmed: boolean;
}

/** Result of a rewind operation. */
export interface RewindOperationResult {
  /** Whether the rewind was applied. */
  applied: boolean;
  /**
   * If applied is false and there are conflicts, this indicates
   * confirmation is required before proceeding.
   */
  confirmationRequired: boolean;
  /** Preview with diff information (always populated). */
  preview: RewindPreview;
  /** Underlying rewind result (only populated when applied). */
  rewindResult?: RewindResult;
}

/** Options for the rewindCall operation. */
export interface RewindCallOptions {
  /** If true, skip confirmation even when external conflicts exist. */
  force?: boolean;
  /** Pre-supplied confirmation (from a prior confirmation-required response). */
  confirmation?: RewindConfirmation;
}

/**
 * Function that reads blob content given a SHA-256 hash.
 * The RewindService stores blobs at `<blobDir>/<first-2-chars>/<rest>`.
 */
export type BlobReaderFn = (blobHash: string) => Promise<string>;

/** Options for the RewindOperation constructor. */
export interface RewindOperationOptions {
  /** The hunk tracker instance for attribution queries. */
  hunkTracker: HunkTracker;
  /** The rewind service instance for snapshot/restore operations. */
  rewindService: RewindService;
  /** Function to read blob content by hash (resolves blob path internally). */
  blobReader: BlobReaderFn;
  /** Optional file reader for testing (defaults to fs.readFile). */
  readFileFn?: (path: string) => Promise<string>;
}

// ─── Helper ─────────────────────────────────────────────────────

/**
 * Create a BlobReaderFn for a given blob directory.
 * Matches the RewindService blob path layout: `<blobDir>/<first-2-chars>/<rest>`.
 */
export function createBlobReader(blobDir: string): BlobReaderFn {
  return async (blobHash: string): Promise<string> => {
    const prefix = blobHash.substring(0, 2);
    const rest = blobHash.substring(2);
    const blobPath = join(blobDir, prefix, rest);
    return readFile(blobPath, 'utf-8');
  };
}

// ─── RewindOperation Implementation ─────────────────────────────

/**
 * Orchestrates full rewind-with-confirmation flow combining Hunk Tracker
 * and Rewind Service.
 */
export class RewindOperation {
  private readonly hunkTracker: HunkTracker;
  private readonly rewindService: RewindService;
  private readonly blobReader: BlobReaderFn;
  private readonly readFileFn: (path: string) => Promise<string>;

  constructor(options: RewindOperationOptions) {
    this.hunkTracker = options.hunkTracker;
    this.rewindService = options.rewindService;
    this.blobReader = options.blobReader;
    this.readFileFn = options.readFileFn ?? ((path: string) => readFile(path, 'utf-8'));
  }

  /**
   * Rewind all hunks for a tool call with external-hunk conflict checking.
   *
   * Flow:
   * 1. Gets all hunks for the tool call from HunkTracker
   * 2. Checks if any external hunks overlap with the affected files/regions
   * 3. If overlapping external hunks exist and no confirmation: returns confirmation-required
   * 4. If no conflicts (or confirmation/force provided): calls RewindService.rewind(callId)
   * 5. Returns the result with before/after diff summaries
   *
   * Validates: Requirements 14.6, 14.7
   */
  async rewindCall(callId: string, options?: RewindCallOptions): Promise<RewindOperationResult> {
    const preview = await this.previewRewind(callId);

    // If there are conflicts and no confirmation/force, require confirmation
    if (preview.hasConflicts && !options?.force && !options?.confirmation?.confirmed) {
      return {
        applied: false,
        confirmationRequired: true,
        preview,
      };
    }

    // Proceed with the rewind
    const rewindResult = await this.rewindService.rewind(callId);

    return {
      applied: true,
      confirmationRequired: false,
      preview,
      rewindResult,
    };
  }

  /**
   * Generate a preview of what rewinding a tool call would do, without applying.
   * Produces before/after diffs and identifies external-edit conflicts.
   *
   * Validates: Requirement 14.8
   */
  async previewRewind(callId: string): Promise<RewindPreview> {
    const snapshots = this.rewindService.getSnapshotsForCall(callId);
    const agentHunks = this.hunkTracker.getHunksForCall(callId);

    const diffs: FileDiff[] = [];
    const conflictingFiles: string[] = [];

    // Build set of affected files from snapshots
    const affectedFiles = new Set(snapshots.map((s) => s.file));

    for (const file of affectedFiles) {
      const diff = await this.buildFileDiff(file, callId, snapshots, agentHunks);
      if (diff) {
        diffs.push(diff);
        if (diff.hasConflict) {
          conflictingFiles.push(file);
        }
      }
    }

    return {
      callId,
      diffs,
      hasConflicts: conflictingFiles.length > 0,
      conflictingFiles,
    };
  }

  // ─── Private ────────────────────────────────────────────────────

  /**
   * Build a FileDiff for a given file, checking for external-hunk conflicts.
   */
  private async buildFileDiff(
    file: string,
    callId: string,
    snapshots: SnapshotEntry[],
    agentHunks: HunkRecord[],
  ): Promise<FileDiff | null> {
    const snapshot = snapshots.find((s) => s.file === file);
    if (!snapshot) return null;

    // Read current file content (before rewind)
    let beforeContent: string;
    try {
      beforeContent = await this.readFileFn(file);
    } catch {
      // File might have been deleted — use empty string
      beforeContent = '';
    }

    // Read blob content (after rewind = the pre-image)
    let afterContent: string;
    try {
      afterContent = await this.blobReader(snapshot.blobHash);
    } catch {
      // Blob missing or unreadable — use empty string
      afterContent = '';
    }

    // Check for external hunks that overlap with the file regions modified by this call
    const hasConflict = this.hasExternalConflict(file, agentHunks);

    // Determine affected line range from agent hunks for this file
    const fileHunks = agentHunks.filter((h) => h.file === file);
    const linesAffected = this.computeAffectedLines(fileHunks);

    return {
      file,
      linesAffected,
      beforeContent,
      afterContent,
      hasConflict,
    };
  }

  /**
   * Check if there are external hunks that overlap with the regions
   * being reverted for a specific file and tool call.
   *
   * Validates: Requirement 14.7 — external hunks that would be destroyed
   * trigger the confirmation requirement.
   */
  private hasExternalConflict(file: string, agentHunks: HunkRecord[]): boolean {
    // Get all hunks for this file (including external)
    const allFileHunks = this.hunkTracker.getHunksForFile(file);

    // Find external hunks for this file
    const externalHunks = allFileHunks.filter((h) => h.kind === 'external');

    if (externalHunks.length === 0) {
      return false;
    }

    // Get the agent hunks for this specific tool call on this file
    const callFileHunks = agentHunks.filter((h) => h.file === file);

    if (callFileHunks.length === 0) {
      // No agent hunks recorded for this file but there are external hunks —
      // the file has been externally modified since it was snapshotted.
      // Rewinding would overwrite external edits.
      return true;
    }

    // Check if any external hunks overlap with the agent-modified regions
    for (const external of externalHunks) {
      for (const agent of callFileHunks) {
        if (external.startLine <= agent.endLine && external.endLine >= agent.startLine) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Compute the overall affected line range from a set of hunks.
   */
  private computeAffectedLines(hunks: HunkRecord[]): { startLine: number; endLine: number } {
    if (hunks.length === 0) {
      return { startLine: 1, endLine: 1 };
    }

    let startLine = Infinity;
    let endLine = -Infinity;

    for (const hunk of hunks) {
      if (hunk.startLine < startLine) startLine = hunk.startLine;
      if (hunk.endLine > endLine) endLine = hunk.endLine;
    }

    return { startLine, endLine };
  }
}
