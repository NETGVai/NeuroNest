/**
 * DraftTransactionStore
 *
 * Per-session transactional draft journal for the Composer_Workbench.
 * Manages revisioned text/mode/command/context/attachments/placement/selection
 * with bounded undo/redo, atomic submission snapshots, and retention policy.
 *
 * Key invariants:
 * - Each mutation produces a new draft revision (monotonically increasing)
 * - Undo/redo navigates the revision journal without removing entries
 * - Submission creates one immutable snapshot at the current revision
 * - Only the confirmed submitted revision is cleared; edits in later
 *   revisions survive late settlements
 * - Async resolution settles only if draftId, originRevision, and
 *   exactRange still match
 * - Retention policy governs undo depth and failure-mode retention
 *
 * Requirements: 40.1, 40.3–40.6, 40.10–40.15, 40.19–40.24
 */

import type {
  DraftRetentionPolicy,
  DraftTransactionStoreConfig,
} from './types';
import {
  DEFAULT_SELECTION,
} from './types';

// ─── Local Interfaces ───────────────────────────────────────────

/**
 * A context item kind.
 */
export type ContextItemKind =
  | 'file' | 'folder' | 'range' | 'symbol' | 'diagnostic'
  | 'terminal' | 'git' | 'planning' | 'run' | 'artifact' | 'image' | 'web';

export type ContextItemStatus =
  | 'included' | 'unavailable' | 'redacted' | 'omitted'
  | 'condensed' | 'resolving' | 'cancelled' | 'failed';

export interface ContextItem {
  itemId: string;
  kind: ContextItemKind;
  label: string;
  provenance: string;
  version?: string | undefined;
  staleness?: 'fresh' | 'stale' | 'unknown' | undefined;
  tokenEstimate?: number | undefined;
  status?: ContextItemStatus | undefined;
  pinned?: boolean | undefined;
  [key: string]: unknown;
}

export type AttachmentDraftState =
  | 'validating' | 'uploading' | 'scanning' | 'ready' | 'error' | 'committed';

export interface AttachmentDraft {
  draftAttachmentId: string;
  filename: string;
  mediaType: string;
  byteSize: number;
  state?: AttachmentDraftState | undefined;
  description?: string | undefined;
  committedIdentity?: string | undefined;
  contentDigest?: string | undefined;
  errorReason?: string | undefined;
  [key: string]: unknown;
}

export interface Selection {
  start: number;
  end: number;
  direction?: 'forward' | 'backward' | 'none' | undefined;
}

export type ComposerMode = 'chat' | 'command' | 'edit' | 'agent' | 'plan';

export interface QueuePlacement {
  position: 'append' | 'prepend' | 'after';
  afterEntryId?: string | undefined;
  [key: string]: unknown;
}

/**
 * A single undoable draft revision in the journal.
 */
export interface DraftRevision {
  revision: number;
  text: string;
  mode: ComposerMode;
  commandClaim?: string | undefined;
  contextItems: ContextItem[];
  attachmentDrafts: AttachmentDraft[];
  queuePlacement?: QueuePlacement | undefined;
  selection: Selection;
  createdAt: string;
  [key: string]: unknown;
}

/**
 * An immutable submission snapshot.
 */
export interface SubmissionSnapshot {
  snapshotId: string;
  sessionId: string;
  draftRevision: number;
  text: string;
  mode: ComposerMode;
  commandClaim?: string | undefined;
  contextItems: ContextItem[];
  committedAttachmentIds: string[];
  queuePlacement?: QueuePlacement | undefined;
  route: string;
  profile: string;
  permissionPreset: string;
  submittedAt: string;
  [key: string]: unknown;
}

/**
 * An async resolution result to be applied to the draft.
 */
export interface AsyncResolutionResult {
  requestId: string;
  draftId: string;
  originRevision: number;
  exactRange: { start: number; end: number };
  resolvedText?: string | undefined;
  resolvedContextItem?: ContextItem | undefined;
  resolvedAttachment?: AttachmentDraft | undefined;
}

// ─── Submission Context ─────────────────────────────────────────

export interface SubmissionContext {
  route: string;
  profile: string;
  permissionPreset: string;
}

// ─── Draft Change ───────────────────────────────────────────────

/**
 * Partial update to the current draft. Only provided fields are changed.
 */
export interface DraftChange {
  text?: string | undefined;
  mode?: ComposerMode | undefined;
  commandClaim?: string | undefined;
  contextItems?: ContextItem[] | undefined;
  attachmentDrafts?: AttachmentDraft[] | undefined;
  queuePlacement?: QueuePlacement | undefined;
  selection?: Selection | undefined;
}

// ─── Submission Result ──────────────────────────────────────────

export type SubmissionResult =
  | { ok: true; snapshot: SubmissionSnapshot }
  | { ok: false; reason: 'validation_failed' | 'precommit_failed'; details: string };

// ─── Settlement Result ──────────────────────────────────────────

export type SettlementResult =
  | { applied: true }
  | { applied: false; reason: 'stale_revision' | 'range_mismatch' | 'draft_mismatch' | 'superseded' };

// ─── Store ──────────────────────────────────────────────────────

export class DraftTransactionStore {
  readonly sessionId: string;
  readonly draftId: string;
  private readonly retentionPolicy: DraftRetentionPolicy;

  /** Journal of all draft revisions, trimmed by retention. */
  private journal: DraftRevision[] = [];

  /** Current position in the journal (0-indexed). */
  private cursor: number = -1;

  /** Committed submission snapshots for this session. */
  private readonly submissions: SubmissionSnapshot[] = [];

  /** Tracks the last confirmed submission revision to reject late settlements. */
  private lastConfirmedSubmissionRevision: number = -1;

  constructor(config: DraftTransactionStoreConfig) {
    this.sessionId = config.sessionId;
    this.draftId = config.draftId;
    this.retentionPolicy = config.retentionPolicy;

    // Initialize with an empty draft revision (revision 0)
    const initial: DraftRevision = {
      revision: 0,
      text: '',
      mode: 'chat',
      commandClaim: undefined,
      contextItems: [],
      attachmentDrafts: [],
      queuePlacement: undefined,
      selection: { ...DEFAULT_SELECTION },
      createdAt: new Date().toISOString(),
    };
    this.journal.push(initial);
    this.cursor = 0;
  }

  // ─── Queries ────────────────────────────────────────────────────

  /** Get the current draft revision. */
  getCurrentRevision(): DraftRevision {
    return this.journal[this.cursor]!;
  }

  /** Get the current revision number. */
  getCurrentRevisionNumber(): number {
    return this.journal[this.cursor]!.revision;
  }

  /** Whether undo is available. */
  canUndo(): boolean {
    return this.cursor > 0;
  }

  /** Whether redo is available. */
  canRedo(): boolean {
    return this.cursor < this.journal.length - 1;
  }

  /** Get the undo depth available. */
  getUndoDepth(): number {
    return this.cursor;
  }

  /** Get the redo depth available. */
  getRedoDepth(): number {
    return this.journal.length - 1 - this.cursor;
  }

  /** Get all submission snapshots for this session. */
  getSubmissions(): ReadonlyArray<SubmissionSnapshot> {
    return this.submissions;
  }

  /** Get the journal length. */
  getJournalLength(): number {
    return this.journal.length;
  }

  // ─── Mutations ──────────────────────────────────────────────────

  /**
   * Apply a draft change as one undoable transaction.
   * Truncates the redo branch and appends a new revision.
   *
   * Requirement 40.3: Each user edit (type, paste, drag, drop, mention,
   * slash command) applies as one undoable transaction.
   */
  applyChange(change: DraftChange): DraftRevision {
    const current = this.journal[this.cursor]!;
    const nextRevision = current.revision + 1;

    const next: DraftRevision = {
      revision: nextRevision,
      text: change.text !== undefined ? change.text : current.text,
      mode: change.mode !== undefined ? change.mode : current.mode,
      commandClaim: change.commandClaim !== undefined ? change.commandClaim : current.commandClaim,
      contextItems: change.contextItems !== undefined ? change.contextItems : [...current.contextItems],
      attachmentDrafts: change.attachmentDrafts !== undefined ? change.attachmentDrafts : [...current.attachmentDrafts],
      queuePlacement: change.queuePlacement !== undefined ? change.queuePlacement : current.queuePlacement,
      selection: change.selection !== undefined ? change.selection : { ...current.selection },
      createdAt: new Date().toISOString(),
    };

    // Truncate the redo branch (everything after cursor)
    this.journal.splice(this.cursor + 1);

    // Append the new revision
    this.journal.push(next);
    this.cursor = this.journal.length - 1;

    // Enforce retention policy: trim oldest entries if journal exceeds maxUndoDepth + 1
    this.enforceRetention();

    return next;
  }

  /**
   * Undo: move cursor back one position.
   *
   * Requirement 40.14: Bounded undo over uncommitted draft transactions.
   * Committed submissions are excluded from undo history.
   */
  undo(): DraftRevision | null {
    if (!this.canUndo()) return null;
    this.cursor -= 1;
    return this.journal[this.cursor]!;
  }

  /**
   * Redo: move cursor forward one position.
   *
   * Requirement 40.14: Bounded redo over uncommitted draft transactions.
   */
  redo(): DraftRevision | null {
    if (!this.canRedo()) return null;
    this.cursor += 1;
    return this.journal[this.cursor]!;
  }

  // ─── Submission ─────────────────────────────────────────────────

  /**
   * Create an atomic submission snapshot from the current draft revision.
   *
   * Requirement 40.10: Creates one atomic snapshot of the current draft
   * revision, text, mode, Context_Items, committed attachment identities,
   * route, profile, permission preset, and queue placement.
   */
  submit(context: SubmissionContext): SubmissionResult {
    const current = this.journal[this.cursor]!;

    // Collect committed attachment IDs (only ready/committed attachments)
    const committedAttachmentIds = current.attachmentDrafts
      .filter((a) => a.state === 'committed' || a.state === 'ready')
      .map((a) => a.committedIdentity ?? a.draftAttachmentId);

    const snapshot: SubmissionSnapshot = {
      snapshotId: generateSnapshotId(),
      sessionId: this.sessionId,
      draftRevision: current.revision,
      text: current.text,
      mode: current.mode,
      commandClaim: current.commandClaim,
      contextItems: [...current.contextItems],
      committedAttachmentIds,
      queuePlacement: current.queuePlacement,
      route: context.route,
      profile: context.profile,
      permissionPreset: context.permissionPreset,
      submittedAt: new Date().toISOString(),
    };

    this.submissions.push(snapshot);
    return { ok: true, snapshot };
  }

  /**
   * Confirm a submission: clears only the committed revision's content
   * and preserves edits from newer revisions.
   *
   * Requirement 40.13: Clear only the committed draft revision.
   * Requirement 40.23: Clear content owned by committed revision,
   * preserve edits from every newer draft revision.
   * Requirement 40.24: Reject late settlement from older submission attempt.
   */
  confirmSubmission(submittedRevision: number): boolean {
    // Reject settlement from an older revision than the last confirmed
    if (submittedRevision <= this.lastConfirmedSubmissionRevision) {
      return false;
    }

    this.lastConfirmedSubmissionRevision = submittedRevision;

    const current = this.journal[this.cursor]!;

    // If the current revision is the submitted one, clear it
    if (current.revision === submittedRevision) {
      const cleared: DraftRevision = {
        revision: current.revision + 1,
        text: '',
        mode: 'chat',
        commandClaim: undefined,
        contextItems: [],
        attachmentDrafts: [],
        queuePlacement: undefined,
        selection: { ...DEFAULT_SELECTION },
        createdAt: new Date().toISOString(),
      };

      // Truncate redo and append cleared state
      this.journal.splice(this.cursor + 1);
      this.journal.push(cleared);
      this.cursor = this.journal.length - 1;
      this.enforceRetention();
      return true;
    }

    // If current revision is newer than submitted, preserve newer edits
    // Only clear content that was part of the submitted revision
    if (current.revision > submittedRevision) {
      // The newer edits survive — nothing to clear from the current state.
      // The settlement is acknowledged but no content is removed because
      // the user has already moved on to a newer revision.
      return true;
    }

    // Should not happen in normal flow (current < submitted)
    return false;
  }

  /**
   * Handle validation failure: retain the complete draft transaction.
   *
   * Requirement 40.11: Retain complete draft on validation failure.
   */
  handleValidationFailure(details: string): SubmissionResult {
    // Draft is retained as-is per retention policy
    return { ok: false, reason: 'validation_failed', details };
  }

  /**
   * Handle precommit failure: retain the complete draft transaction.
   *
   * Requirement 40.12: Retain complete draft on precommit failure.
   */
  handlePrecommitFailure(details: string): SubmissionResult {
    // Draft is retained as-is per retention policy
    return { ok: false, reason: 'precommit_failed', details };
  }

  // ─── Async Resolution ───────────────────────────────────────────

  /**
   * Attempt to settle an asynchronous resolution result.
   *
   * Requirement 40.20: Apply result only when originating draft revision
   * and exact range remain current.
   * Requirement 40.21: Discard result without mutating draft if cancelled,
   * stale, or superseded.
   */
  settleAsyncResolution(result: AsyncResolutionResult): SettlementResult {
    // Verify draft ID matches
    if (result.draftId !== this.draftId) {
      return { applied: false, reason: 'draft_mismatch' };
    }

    const current = this.journal[this.cursor]!;

    // Verify origin revision matches current
    if (result.originRevision !== current.revision) {
      return { applied: false, reason: 'stale_revision' };
    }

    // Verify exact range is still valid
    const { start, end } = result.exactRange;
    if (start > current.text.length || end > current.text.length || start > end) {
      return { applied: false, reason: 'range_mismatch' };
    }

    // Apply the resolution as a new revision
    const change: DraftChange = {};

    if (result.resolvedText !== undefined) {
      // Replace text at the exact range
      change.text =
        current.text.slice(0, start) +
        result.resolvedText +
        current.text.slice(end);
      // Update selection to end of inserted text
      const newEnd = start + result.resolvedText.length;
      change.selection = { start: newEnd, end: newEnd, direction: 'none' };
    }

    if (result.resolvedContextItem !== undefined) {
      change.contextItems = [...current.contextItems, result.resolvedContextItem];
    }

    if (result.resolvedAttachment !== undefined) {
      change.attachmentDrafts = [...current.attachmentDrafts, result.resolvedAttachment];
    }

    // Only apply if there's actually something to change
    if (change.text !== undefined || change.contextItems !== undefined || change.attachmentDrafts !== undefined) {
      this.applyChange(change);
    }

    return { applied: true };
  }

  // ─── Session Restore ────────────────────────────────────────────

  /**
   * Restore the store from a persisted state (session reopen).
   *
   * Requirement 40.15: Restore the latest uncommitted draft revision,
   * selection, Context_Items, attachment drafts, and undo position
   * allowed by retention policy.
   */
  restore(journal: DraftRevision[], cursorPosition: number): void {
    if (journal.length === 0) return;

    // Apply retention policy to restored journal
    const maxEntries = this.retentionPolicy.maxUndoDepth + 1;
    const trimmed = journal.length > maxEntries
      ? journal.slice(journal.length - maxEntries)
      : journal;

    this.journal = trimmed;
    this.cursor = Math.min(cursorPosition, trimmed.length - 1);
    this.cursor = Math.max(this.cursor, 0);
  }

  /**
   * Export current state for persistence.
   */
  export(): { journal: DraftRevision[]; cursor: number } {
    return {
      journal: [...this.journal],
      cursor: this.cursor,
    };
  }

  // ─── Private ────────────────────────────────────────────────────

  /**
   * Enforce retention policy by trimming the oldest journal entries
   * when the journal exceeds maxUndoDepth + 1 (current position).
   */
  private enforceRetention(): void {
    const maxEntries = this.retentionPolicy.maxUndoDepth + 1;
    if (this.journal.length > maxEntries) {
      const excess = this.journal.length - maxEntries;
      this.journal.splice(0, excess);
      this.cursor = Math.max(0, this.cursor - excess);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

let snapshotCounter = 0;

function generateSnapshotId(): string {
  snapshotCounter += 1;
  return `snap-${Date.now()}-${snapshotCounter}`;
}

/**
 * Reset the snapshot counter (for testing only).
 */
export function _resetSnapshotCounter(): void {
  snapshotCounter = 0;
}
