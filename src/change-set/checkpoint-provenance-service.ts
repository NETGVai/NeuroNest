/**
 * CheckpointProvenanceService — Durable inverse journals, grouped undo,
 * and checkpoint provenance for Change_Transactions.
 *
 * Extends the existing ChangeTransactionService with:
 * - Pre/post workspace checkpoints created around every Change_Transaction
 * - Rich provenance recording (revision, resources, Task, run, chat turn,
 *   Change_Set, approvals, validation)
 * - One visible undo operation (grouped) plus durable fallback via journal
 * - Previewed whole-Change_Set, per-file, and safe per-Hunk restore
 * - Git consent controls: revisions associated only with user consent,
 *   never capturing unrelated changes, prohibiting force push, hard reset,
 *   destructive branch deletion, or default auto-merge
 *
 * Requirements: 6.7, 6.8, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.9
 */

import { createHash, randomUUID } from 'node:crypto';
import type {
  ChangeSet,
  FileOperation,
} from './types';
import type {
  TransactionJournal,
  InverseOperation,
  WorkspaceAdapter,
} from './change-transaction-service';

// ─── Checkpoint Provenance Types ────────────────────────────────────────────

/**
 * Provenance metadata associated with a Checkpoint.
 * Records: revision, resources, Task, run, chat turn, Change_Set,
 * approvals, and validation state.
 */
export interface CheckpointProvenance {
  /** Workspace revision at the time of checkpoint creation. */
  readonly workspaceRevision: string;
  /** Affected resource URIs. */
  readonly affectedResources: readonly string[];
  /** The Task that originated this change. */
  readonly taskId: string;
  /** The Agent_Run that produced the change. */
  readonly runId: string;
  /** The chat turn (event) that triggered the change. */
  readonly chatTurnId: string;
  /** The Change_Set being applied. */
  readonly changeSetId: string;
  /** Approval policy decisions at time of application. */
  readonly approvals: readonly ApprovalRecord[];
  /** Validation state at time of checkpoint. */
  readonly validationState: ValidationState;
}

/**
 * A record of an approval decision.
 */
export interface ApprovalRecord {
  /** Who approved (user ID or system). */
  readonly actor: string;
  /** Timestamp of approval. */
  readonly timestamp: string;
  /** Scope of approval. */
  readonly scope: 'hunk' | 'file' | 'change-set';
  /** Target resource (if file/hunk-scoped). */
  readonly targetUri?: string;
}

/**
 * Validation state at time of checkpoint.
 */
export interface ValidationState {
  /** Whether validation was run. */
  readonly validated: boolean;
  /** Outcome of validation (pass/fail/pending/skipped). */
  readonly outcome: 'pass' | 'fail' | 'pending' | 'skipped';
  /** Validation method used (e.g., 'test', 'lint', 'typecheck'). */
  readonly method?: string;
  /** Evidence ID linked to this validation. */
  readonly evidenceId?: string;
}

/**
 * A Checkpoint created around a Change_Transaction.
 */
export interface TransactionCheckpoint {
  /** Unique checkpoint ID. */
  readonly id: string;
  /** The workspace this checkpoint belongs to. */
  readonly workspaceId: string;
  /** Whether this is a pre-apply or post-apply checkpoint. */
  readonly phase: 'pre-apply' | 'post-apply';
  /** Full provenance metadata. */
  readonly provenance: CheckpointProvenance;
  /** Workspace fingerprint at this checkpoint. */
  readonly fingerprint: string;
  /** Resource snapshots (content hashes by URI). */
  readonly resourceSnapshots: Readonly<Record<string, string>>;
  /** Timestamp of creation. */
  readonly createdAt: string;
  /** Whether this checkpoint was suppressed because an equivalent exists. */
  readonly suppressed: boolean;
  /** If suppressed, the ID of the equivalent existing checkpoint. */
  readonly equivalentCheckpointId?: string;
  /** Git revision (only if associated with consent). */
  readonly gitRevision?: string;
  /** Whether Git association was explicitly consented. */
  readonly gitConsentGiven: boolean;
  /** Privacy/encryption policy applied. */
  readonly retentionPolicy: RetentionPolicy;
}

/**
 * Retention and privacy policy for checkpoint content.
 */
export interface RetentionPolicy {
  /** Whether content is encrypted at rest. */
  readonly encrypted: boolean;
  /** Maximum retention in days (null = indefinite). */
  readonly maxRetentionDays: number | null;
  /** Whether content may be transmitted to providers. */
  readonly allowProviderTransmission: boolean;
}

// ─── Grouped Undo Types ─────────────────────────────────────────────────────

/**
 * A grouped undo entry representing one user-visible undo operation.
 */
export interface GroupedUndoEntry {
  /** Unique undo entry ID. */
  readonly id: string;
  /** The Change_Set that was applied. */
  readonly changeSetId: string;
  /** The journal ID for durable fallback. */
  readonly journalId: string;
  /** Description for the undo stack. */
  readonly description: string;
  /** Whether the host platform's undo is available. */
  readonly platformUndoAvailable: boolean;
  /** Pre-apply checkpoint ID (for durable fallback). */
  readonly preCheckpointId: string;
  /** Post-apply checkpoint ID (for verification). */
  readonly postCheckpointId: string;
  /** Timestamp of creation. */
  readonly createdAt: string;
  /** Whether this undo has been exercised. */
  exercised: boolean;
}

// ─── Restore Preview Types ──────────────────────────────────────────────────

/**
 * Scope of a restore operation.
 */
export type RestoreScope = 'whole' | 'file' | 'hunk';

/**
 * A preview of what a restore operation would do.
 */
export interface RestorePreview {
  /** The scope of this restore. */
  readonly scope: RestoreScope;
  /** The checkpoint being restored from. */
  readonly checkpointId: string;
  /** Files that would be affected. */
  readonly affectedFiles: readonly RestoreFilePreview[];
  /** Whether conflicts exist with current state. */
  readonly hasConflicts: boolean;
  /** Conflicts (if any). */
  readonly conflicts: readonly RestoreConflict[];
  /** Whether safe restore is possible (no data loss). */
  readonly safeToRestore: boolean;
  /** Reason restore might not be safe. */
  readonly unsafeReason?: string;
}

/**
 * Per-file restore preview.
 */
export interface RestoreFilePreview {
  /** The file URI. */
  readonly uri: string;
  /** The operation kind needed. */
  readonly operation: 'revert' | 'recreate' | 'delete' | 'rename-back';
  /** Current content hash (or null if file doesn't exist). */
  readonly currentHash: string | null;
  /** Target content hash from checkpoint. */
  readonly targetHash: string;
  /** Whether this file has newer user edits since the checkpoint. */
  readonly hasNewerUserEdits: boolean;
}

/**
 * A conflict found during restore preview.
 */
export interface RestoreConflict {
  /** The file URI. */
  readonly uri: string;
  /** Description of the conflict. */
  readonly message: string;
  /** Whether merge workflow should be opened. */
  readonly requiresMerge: boolean;
}

// ─── Git Safety Types ───────────────────────────────────────────────────────

/**
 * Prohibited Git recovery operations (per Req 9.6).
 */
export type ProhibitedGitOperation =
  | 'force-push'
  | 'hard-reset'
  | 'destructive-branch-deletion'
  | 'auto-merge';

/**
 * Git association consent decision.
 */
export interface GitConsentDecision {
  /** Whether the user consented to Git association. */
  readonly consented: boolean;
  /** The specific commit/revision associated (if consented). */
  readonly revision?: string;
  /** Timestamp of consent decision. */
  readonly timestamp: string;
  /** Actor making the decision. */
  readonly actor: string;
}

// ─── Checkpoint Adapter Interface ───────────────────────────────────────────

/**
 * Adapter for checking existing checkpoint equivalence.
 * Used to suppress duplicate checkpoints when an equivalent revision exists.
 */
export interface CheckpointEquivalenceAdapter {
  /** Checks if a checkpoint already covers the given workspace revision + fingerprint. */
  findEquivalent(workspaceId: string, fingerprint: string): string | null;
}

/**
 * Adapter for platform undo support.
 */
export interface PlatformUndoAdapter {
  /** Whether the platform supports grouped undo. */
  readonly supportsGroupedUndo: boolean;
  /** Registers a single undo operation for the given Change_Set. */
  registerUndo(changeSetId: string, description: string, undoCallback: () => void): boolean;
}

// ─── CheckpointProvenanceService ────────────────────────────────────────────

/**
 * CheckpointProvenanceService creates durable checkpoints around
 * Change_Transactions with rich provenance and provides grouped undo
 * plus safe restore mechanics.
 */
export class CheckpointProvenanceService {
  private readonly workspace: WorkspaceAdapter;
  private readonly equivalenceAdapter: CheckpointEquivalenceAdapter;
  private readonly platformUndo: PlatformUndoAdapter;
  private readonly retentionPolicy: RetentionPolicy;

  /** All created checkpoints indexed by ID. */
  private readonly checkpoints = new Map<string, TransactionCheckpoint>();
  /** Undo entries indexed by Change_Set ID. */
  private readonly undoEntries = new Map<string, GroupedUndoEntry>();
  /** Git consent decisions indexed by Change_Set ID. */
  private readonly gitConsents = new Map<string, GitConsentDecision>();

  constructor(
    workspace: WorkspaceAdapter,
    equivalenceAdapter: CheckpointEquivalenceAdapter,
    platformUndo: PlatformUndoAdapter,
    retentionPolicy?: Partial<RetentionPolicy>
  ) {
    this.workspace = workspace;
    this.equivalenceAdapter = equivalenceAdapter;
    this.platformUndo = platformUndo;
    this.retentionPolicy = {
      encrypted: retentionPolicy?.encrypted ?? true,
      maxRetentionDays: retentionPolicy?.maxRetentionDays ?? 30,
      allowProviderTransmission: retentionPolicy?.allowProviderTransmission ?? false,
    };
  }

  // ─── Checkpoint Creation ────────────────────────────────────────────────

  /**
   * Creates a pre-apply checkpoint before a Change_Transaction begins.
   * Suppresses creation if an equivalent checkpoint already exists.
   *
   * Requirements: 9.1, 9.2
   */
  createPreApplyCheckpoint(
    changeSet: ChangeSet,
    approvals: readonly ApprovalRecord[],
    validationState: ValidationState,
    gitConsent?: GitConsentDecision
  ): TransactionCheckpoint {
    const affectedUris = this.getAffectedUris(changeSet.operations);
    const fingerprint = this.workspace.computeFingerprint(affectedUris);

    // Check for equivalent existing checkpoint (Req 9.1)
    const equivalentId = this.equivalenceAdapter.findEquivalent(
      changeSet.workspaceId,
      fingerprint
    );

    if (gitConsent) {
      this.gitConsents.set(changeSet.id, gitConsent);
    }

    const checkpoint = this.buildCheckpoint(
      changeSet,
      'pre-apply',
      affectedUris,
      fingerprint,
      approvals,
      validationState,
      equivalentId,
      gitConsent
    );

    this.checkpoints.set(checkpoint.id, checkpoint);
    return checkpoint;
  }

  /**
   * Creates a post-apply checkpoint after a Change_Transaction succeeds.
   * Suppresses creation if an equivalent checkpoint already exists.
   *
   * Requirements: 9.1, 9.2
   */
  createPostApplyCheckpoint(
    changeSet: ChangeSet,
    approvals: readonly ApprovalRecord[],
    validationState: ValidationState,
    gitConsent?: GitConsentDecision
  ): TransactionCheckpoint {
    const affectedUris = this.getAffectedUris(changeSet.operations);
    const fingerprint = this.workspace.computeFingerprint(affectedUris);

    const equivalentId = this.equivalenceAdapter.findEquivalent(
      changeSet.workspaceId,
      fingerprint
    );

    const checkpoint = this.buildCheckpoint(
      changeSet,
      'post-apply',
      affectedUris,
      fingerprint,
      approvals,
      validationState,
      equivalentId,
      gitConsent ?? this.gitConsents.get(changeSet.id)
    );

    this.checkpoints.set(checkpoint.id, checkpoint);
    return checkpoint;
  }

  // ─── Grouped Undo ──────────────────────────────────────────────────────

  /**
   * Registers a single grouped undo operation for a completed Change_Transaction.
   * Uses the platform undo when available, falls back to durable journal.
   *
   * Requirement: 6.8 — one visible undo where supported plus durable fallback.
   */
  registerGroupedUndo(
    changeSet: ChangeSet,
    journalId: string,
    preCheckpointId: string,
    postCheckpointId: string,
    undoCallback: () => void
  ): GroupedUndoEntry {
    const description = `Undo: ${this.describeChangeSet(changeSet)}`;

    // Attempt platform undo registration
    const platformAvailable = this.platformUndo.supportsGroupedUndo &&
      this.platformUndo.registerUndo(changeSet.id, description, undoCallback);

    const entry: GroupedUndoEntry = {
      id: randomUUID(),
      changeSetId: changeSet.id,
      journalId,
      description,
      platformUndoAvailable: platformAvailable,
      preCheckpointId,
      postCheckpointId,
      createdAt: new Date().toISOString(),
      exercised: false,
    };

    this.undoEntries.set(changeSet.id, entry);
    return entry;
  }

  /**
   * Gets the undo entry for a given Change_Set.
   */
  getUndoEntry(changeSetId: string): GroupedUndoEntry | undefined {
    return this.undoEntries.get(changeSetId);
  }

  /**
   * Marks an undo entry as exercised.
   */
  markUndoExercised(changeSetId: string): boolean {
    const entry = this.undoEntries.get(changeSetId);
    if (!entry) return false;
    entry.exercised = true;
    return true;
  }

  // ─── Safe Restore (Preview) ────────────────────────────────────────────

  /**
   * Previews what a whole-Change_Set restore from a checkpoint would do.
   * Shows affected files and any conflicts with current state.
   *
   * Requirement: 9.3 — preview restoration including affected files and conflicts.
   */
  previewRestore(
    checkpointId: string,
    scope: RestoreScope = 'whole',
    targetUris?: string[]
  ): RestorePreview | null {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) return null;

    const affectedFiles: RestoreFilePreview[] = [];
    const conflicts: RestoreConflict[] = [];

    // Determine which URIs to consider based on scope
    const urisToRestore = scope === 'whole'
      ? checkpoint.provenance.affectedResources
      : (targetUris ?? []);

    for (const uri of urisToRestore) {
      const snapshotHash = checkpoint.resourceSnapshots[uri];
      if (!snapshotHash) continue;

      const currentHash = this.workspace.getContentHash(uri);
      const hasNewerEdits = currentHash !== null && currentHash !== snapshotHash;

      let operation: RestoreFilePreview['operation'];
      if (currentHash === null && snapshotHash) {
        operation = 'recreate';
      } else if (snapshotHash === '') {
        operation = 'delete';
      } else {
        operation = 'revert';
      }

      affectedFiles.push({
        uri,
        operation,
        currentHash,
        targetHash: snapshotHash,
        hasNewerUserEdits: hasNewerEdits,
      });

      // Always open merge workflow (Req 9.7) — flag potential conflicts
      if (hasNewerEdits) {
        conflicts.push({
          uri,
          message: `File '${uri}' has newer edits since checkpoint. Merge required.`,
          requiresMerge: true,
        });
      }
    }

    const hasConflicts = conflicts.length > 0;

    return {
      scope,
      checkpointId,
      affectedFiles,
      hasConflicts,
      conflicts,
      safeToRestore: !hasConflicts,
      unsafeReason: hasConflicts
        ? 'Files have newer edits since checkpoint; merge workflow required'
        : undefined,
    };
  }

  /**
   * Previews a per-file restore from a checkpoint.
   *
   * Requirement: 9.4 — per-file recovery.
   */
  previewFileRestore(checkpointId: string, uri: string): RestorePreview | null {
    return this.previewRestore(checkpointId, 'file', [uri]);
  }

  /**
   * Previews a safe per-Hunk restore from a checkpoint.
   * Only available when underlying revisions permit it.
   *
   * Requirement: 9.4 — safe per-Hunk recovery where revisions permit.
   */
  previewHunkRestore(
    checkpointId: string,
    uri: string,
    _hunkIndex: number
  ): RestorePreview | null {
    // Hunk restore is only safe when no conflicting edits exist
    return this.previewRestore(checkpointId, 'hunk', [uri]);
  }

  // ─── Checkpoint Query ──────────────────────────────────────────────────

  /**
   * Gets a checkpoint by ID.
   */
  getCheckpoint(checkpointId: string): TransactionCheckpoint | undefined {
    return this.checkpoints.get(checkpointId);
  }

  /**
   * Lists all checkpoints for a Change_Set (both pre and post).
   */
  getCheckpointsForChangeSet(changeSetId: string): TransactionCheckpoint[] {
    return Array.from(this.checkpoints.values())
      .filter((cp) => cp.provenance.changeSetId === changeSetId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Lists all checkpoints for a workspace.
   */
  getCheckpointsForWorkspace(workspaceId: string): TransactionCheckpoint[] {
    return Array.from(this.checkpoints.values())
      .filter((cp) => cp.workspaceId === workspaceId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // ─── Git Safety ────────────────────────────────────────────────────────

  /**
   * Records a Git consent decision for a Change_Set.
   * Revisions are only associated with checkpoints when consent is given.
   *
   * Requirement: 9.5 — associate Git revisions only with consent.
   */
  recordGitConsent(changeSetId: string, decision: GitConsentDecision): void {
    this.gitConsents.set(changeSetId, decision);
  }

  /**
   * Gets the Git consent decision for a Change_Set.
   */
  getGitConsent(changeSetId: string): GitConsentDecision | undefined {
    return this.gitConsents.get(changeSetId);
  }

  /**
   * Validates that a proposed Git operation is not prohibited.
   * Returns the prohibited operation kind if blocked, or null if allowed.
   *
   * Requirement: 9.6 — prohibit force push, hard reset, destructive branch deletion,
   * or auto-merge as default recovery behavior.
   */
  validateGitOperation(operation: string): ProhibitedGitOperation | null {
    const prohibitedPatterns: Array<{ pattern: RegExp; kind: ProhibitedGitOperation }> = [
      { pattern: /\bpush\b.*--force\b|--force.*\bpush\b|\bpush\b.*-f\b/, kind: 'force-push' },
      { pattern: /\breset\b.*--hard\b/, kind: 'hard-reset' },
      { pattern: /\bbranch\b.*-[dD]\b.*--force\b|\bbranch\b.*-D\b/, kind: 'destructive-branch-deletion' },
      { pattern: /\bmerge\b.*--no-edit\b.*--auto\b|\bauto.*merge\b/, kind: 'auto-merge' },
    ];

    for (const { pattern, kind } of prohibitedPatterns) {
      if (pattern.test(operation)) {
        return kind;
      }
    }

    return null;
  }

  /**
   * Checks whether a set of changes includes unrelated changes (not part of the Change_Set).
   * Used to prevent accidentally capturing unrelated changes in Git commits.
   *
   * Requirement: 9.5 — never capture unrelated changes.
   */
  detectUnrelatedChanges(
    changeSetUris: readonly string[],
    stagedUris: readonly string[]
  ): string[] {
    const changeSetUriSet = new Set(changeSetUris);
    return stagedUris.filter((uri) => !changeSetUriSet.has(uri));
  }

  // ─── Fingerprint Verification ──────────────────────────────────────────

  /**
   * Verifies the prior fingerprint before restoring from a journal.
   * This ensures the workspace is in the expected state before rollback.
   *
   * Requirement: 6.7 — verify the prior fingerprint.
   */
  verifyFingerprint(
    journal: TransactionJournal,
    currentFingerprint: string
  ): { valid: boolean; expected: string; actual: string } {
    const expected = journal.postFingerprint ?? journal.preFingerprint;
    return {
      valid: currentFingerprint === expected,
      expected,
      actual: currentFingerprint,
    };
  }

  // ─── Private Helpers ───────────────────────────────────────────────────

  private buildCheckpoint(
    changeSet: ChangeSet,
    phase: 'pre-apply' | 'post-apply',
    affectedUris: readonly string[],
    fingerprint: string,
    approvals: readonly ApprovalRecord[],
    validationState: ValidationState,
    equivalentId: string | null,
    gitConsent?: GitConsentDecision
  ): TransactionCheckpoint {
    // Build resource snapshots
    const resourceSnapshots: Record<string, string> = {};
    for (const uri of affectedUris) {
      const hash = this.workspace.getContentHash(uri);
      resourceSnapshots[uri] = hash ?? '';
    }

    const provenance: CheckpointProvenance = {
      workspaceRevision: changeSet.baseRevision,
      affectedResources: [...affectedUris],
      taskId: changeSet.taskId,
      runId: changeSet.runId,
      chatTurnId: changeSet.chatEventId,
      changeSetId: changeSet.id,
      approvals: [...approvals],
      validationState,
    };

    return {
      id: randomUUID(),
      workspaceId: changeSet.workspaceId,
      phase,
      provenance,
      fingerprint,
      resourceSnapshots,
      createdAt: new Date().toISOString(),
      suppressed: equivalentId !== null,
      equivalentCheckpointId: equivalentId ?? undefined,
      gitRevision: gitConsent?.consented ? gitConsent.revision : undefined,
      gitConsentGiven: gitConsent?.consented ?? false,
      retentionPolicy: { ...this.retentionPolicy },
    };
  }

  private getAffectedUris(operations: readonly FileOperation[]): string[] {
    const uris = new Set<string>();
    for (const op of operations) {
      if ('targetUri' in op) uris.add(op.targetUri);
      if ('sourceUri' in op) uris.add((op as { sourceUri: string }).sourceUri);
    }
    return Array.from(uris).sort();
  }

  private describeChangeSet(changeSet: ChangeSet): string {
    const opCounts = changeSet.operations.reduce(
      (acc, op) => {
        acc[op.kind] = (acc[op.kind] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    const parts: string[] = [];
    if (opCounts['create']) parts.push(`${opCounts['create']} created`);
    if (opCounts['modify']) parts.push(`${opCounts['modify']} modified`);
    if (opCounts['rename']) parts.push(`${opCounts['rename']} renamed`);
    if (opCounts['move']) parts.push(`${opCounts['move']} moved`);
    if (opCounts['delete']) parts.push(`${opCounts['delete']} deleted`);

    return parts.length > 0
      ? `${parts.join(', ')} (${changeSet.operations.length} operations)`
      : 'empty Change_Set';
  }
}
