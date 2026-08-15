/**
 * ManualEditTracker — Attributes reviewer edits to the user and includes them
 * in canonical final diff Evidence.
 *
 * When a reviewer manually edits proposed content before acceptance, those edits
 * are attributed to the user (not the agent) and tracked as part of the canonical
 * final diff. This ensures:
 * - Clear provenance: user edits are distinguishable from agent proposals
 * - Evidence completeness: the final diff reflects all modifications
 * - Audit trail: every change in the accepted result has an identified actor
 *
 * Requirements: 8.7
 */

import { createHash, randomUUID } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────

/**
 * A single edit made by the reviewer to the proposed content.
 */
export interface ManualEdit {
  /** Unique identifier for this edit. */
  readonly id: string;
  /** The Change_Set this edit is associated with. */
  readonly changeSetId: string;
  /** The file URI being edited. */
  readonly fileUri: string;
  /** The hunk ID the edit falls within (if applicable). */
  readonly hunkId: string | null;
  /** Start line of the edit in the proposed content. */
  readonly startLine: number;
  /** End line of the edit in the proposed content (exclusive). */
  readonly endLine: number;
  /** The original content before the edit. */
  readonly originalContent: string;
  /** The new content after the edit. */
  readonly editedContent: string;
  /** The actor who made the edit — always the reviewer/user. */
  readonly actor: ManualEditActor;
  /** Timestamp of the edit. */
  readonly timestamp: string;
}

/**
 * Actor information for a manual edit (always a user/reviewer).
 */
export interface ManualEditActor {
  /** Actor kind — always 'user' for manual edits. */
  readonly kind: 'user';
  /** User/reviewer identifier. */
  readonly userId: string;
  /** Display name for attribution. */
  readonly displayName: string;
}

/**
 * Evidence record for manual edits in the canonical final diff.
 */
export interface ManualEditEvidence {
  /** Evidence ID for this collection of manual edits. */
  readonly id: string;
  /** The Change_Set these edits relate to. */
  readonly changeSetId: string;
  /** All manual edits applied to this Change_Set. */
  readonly edits: readonly ManualEdit[];
  /** The final content fingerprint after manual edits. */
  readonly finalContentFingerprint: string;
  /** Summary of what changed. */
  readonly summary: ManualEditSummary;
  /** Timestamp when evidence was finalized. */
  readonly finalizedAt: string;
}

/**
 * Summary statistics for manual edits.
 */
export interface ManualEditSummary {
  /** Total number of manual edits. */
  readonly totalEdits: number;
  /** Number of files with manual edits. */
  readonly filesEdited: number;
  /** Total lines added by the reviewer. */
  readonly linesAdded: number;
  /** Total lines removed by the reviewer. */
  readonly linesRemoved: number;
  /** Reviewer user IDs involved. */
  readonly reviewerIds: readonly string[];
}

/**
 * Parameters for recording a manual edit.
 */
export interface RecordManualEditParams {
  /** The Change_Set being edited. */
  changeSetId: string;
  /** The file being edited. */
  fileUri: string;
  /** The hunk ID the edit falls within (if applicable). */
  hunkId?: string | null;
  /** Start line in proposed content. */
  startLine: number;
  /** End line in proposed content (exclusive). */
  endLine: number;
  /** Original content being replaced. */
  originalContent: string;
  /** New content from the reviewer. */
  editedContent: string;
  /** The user/reviewer identity. */
  userId: string;
  /** The user/reviewer display name. */
  displayName: string;
}

// ─── Service ────────────────────────────────────────────────────

/**
 * ManualEditTracker tracks and attributes reviewer edits to the user,
 * producing Evidence records suitable for inclusion in the canonical final diff.
 */
export class ManualEditTracker {
  /** Stored manual edits by Change_Set ID. */
  private readonly editsByChangeSet = new Map<string, ManualEdit[]>();

  /**
   * Records a manual edit made by the reviewer.
   * The edit is attributed to the user and stored for Evidence generation.
   */
  recordEdit(params: RecordManualEditParams): ManualEdit {
    const edit: ManualEdit = {
      id: randomUUID(),
      changeSetId: params.changeSetId,
      fileUri: params.fileUri,
      hunkId: params.hunkId ?? null,
      startLine: params.startLine,
      endLine: params.endLine,
      originalContent: params.originalContent,
      editedContent: params.editedContent,
      actor: {
        kind: 'user',
        userId: params.userId,
        displayName: params.displayName,
      },
      timestamp: new Date().toISOString(),
    };

    const existing = this.editsByChangeSet.get(params.changeSetId) ?? [];
    existing.push(edit);
    this.editsByChangeSet.set(params.changeSetId, existing);

    return edit;
  }

  /**
   * Gets all manual edits for a Change_Set.
   */
  getEdits(changeSetId: string): readonly ManualEdit[] {
    return this.editsByChangeSet.get(changeSetId) ?? [];
  }

  /**
   * Gets manual edits for a specific file within a Change_Set.
   */
  getFileEdits(changeSetId: string, fileUri: string): readonly ManualEdit[] {
    const allEdits = this.editsByChangeSet.get(changeSetId) ?? [];
    return allEdits.filter((e) => e.fileUri === fileUri);
  }

  /**
   * Checks whether a Change_Set has any manual edits.
   */
  hasEdits(changeSetId: string): boolean {
    const edits = this.editsByChangeSet.get(changeSetId);
    return edits !== undefined && edits.length > 0;
  }

  /**
   * Applies tracked manual edits to proposed content and returns
   * the resulting content. Edits are applied in reverse order
   * (bottom to top) to preserve line numbers.
   */
  applyEditsToContent(
    changeSetId: string,
    fileUri: string,
    proposedContent: string
  ): string {
    const edits = this.getFileEdits(changeSetId, fileUri);
    if (edits.length === 0) return proposedContent;

    const lines = proposedContent.split('\n');

    // Sort edits by startLine descending so bottom edits don't shift top lines
    const sortedEdits = [...edits].sort((a, b) => b.startLine - a.startLine);

    for (const edit of sortedEdits) {
      const editedLines = edit.editedContent.split('\n');
      const removeCount = edit.endLine - edit.startLine;
      lines.splice(edit.startLine, removeCount, ...editedLines);
    }

    return lines.join('\n');
  }

  /**
   * Finalizes and produces Evidence for all manual edits on a Change_Set.
   * Call this when the Change_Set is being accepted/applied.
   */
  finalizeEvidence(changeSetId: string): ManualEditEvidence | null {
    const edits = this.editsByChangeSet.get(changeSetId);
    if (!edits || edits.length === 0) return null;

    const summary = this.computeSummary(edits);
    const contentHash = this.computeContentFingerprint(edits);

    return {
      id: randomUUID(),
      changeSetId,
      edits: Object.freeze([...edits]),
      finalContentFingerprint: contentHash,
      summary,
      finalizedAt: new Date().toISOString(),
    };
  }

  /**
   * Clears tracked edits for a Change_Set (e.g., on rejection or discard).
   */
  clearEdits(changeSetId: string): void {
    this.editsByChangeSet.delete(changeSetId);
  }

  // ─── Private Methods ───────────────────────────────────────────

  private computeSummary(edits: ManualEdit[]): ManualEditSummary {
    const filesEdited = new Set(edits.map((e) => e.fileUri)).size;
    const reviewerIds = [...new Set(edits.map((e) => e.actor.userId))];

    let linesAdded = 0;
    let linesRemoved = 0;

    for (const edit of edits) {
      const originalLines = edit.originalContent.split('\n').length;
      const editedLines = edit.editedContent.split('\n').length;
      linesAdded += Math.max(0, editedLines - originalLines);
      linesRemoved += Math.max(0, originalLines - editedLines);
    }

    return {
      totalEdits: edits.length,
      filesEdited,
      linesAdded,
      linesRemoved,
      reviewerIds: Object.freeze(reviewerIds),
    };
  }

  private computeContentFingerprint(edits: ManualEdit[]): string {
    const hash = createHash('sha256');
    for (const edit of edits) {
      hash.update(edit.id);
      hash.update(edit.editedContent);
    }
    return hash.digest('hex');
  }
}
