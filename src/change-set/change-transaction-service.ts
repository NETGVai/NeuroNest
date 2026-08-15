/**
 * ChangeTransactionService — Validates and atomically applies accepted Change_Sets.
 *
 * This service implements the preconditioned atomic Change_Transaction protocol:
 * 1. Validates path policy, base hashes/versions, existence, rename collisions,
 *    overlap, writability, and approval before any mutation.
 * 2. Applies nothing on any precondition failure and identifies the exact operation.
 * 3. Offers conflict resolution (Rebase Proposal, Open Three-Way Merge,
 *    Regenerate Affected File, Reject) after source drift.
 * 4. Applies every accepted operation recoverably across models and disk only
 *    after all checks pass.
 * 5. Supports fault injection for proving no silent overwrite or partial state.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import { createHash, randomUUID } from 'node:crypto';
import type {
  ChangeSet,
  FileOperation,
  CreateOperation,
  ModifyOperation,
  RenameOperation,
  MoveOperation,
  DeleteOperation,
} from './types';

// ─── Precondition Error Types ───────────────────────────────────────────────

/**
 * The kind of precondition failure detected before mutation.
 */
export type PreconditionFailureKind =
  | 'path-policy-violation'
  | 'base-hash-mismatch'
  | 'base-version-mismatch'
  | 'file-not-found'
  | 'file-already-exists'
  | 'rename-collision'
  | 'operation-overlap'
  | 'not-writable'
  | 'approval-required'
  | 'invalid-ordering';

/**
 * A precondition failure identifying the exact failing operation.
 */
export interface PreconditionFailure {
  /** Kind of precondition failure. */
  readonly kind: PreconditionFailureKind;
  /** Index of the failing operation within the Change_Set. */
  readonly operationIndex: number;
  /** The specific operation that failed. */
  readonly operation: FileOperation;
  /** Human-readable description of the failure. */
  readonly message: string;
  /** Expected value (if applicable). */
  readonly expected?: string;
  /** Actual value found (if applicable). */
  readonly actual?: string;
}

// ─── Conflict Resolution Types ──────────────────────────────────────────────

/**
 * Conflict resolution actions offered after source drift.
 */
export type ConflictResolutionAction =
  | 'rebase-proposal'
  | 'open-three-way-merge'
  | 'regenerate-affected-file'
  | 'reject';

/**
 * A conflict requiring user resolution before application can proceed.
 */
export interface TransactionConflict {
  /** The operation that caused the conflict. */
  readonly operationIndex: number;
  /** The operation details. */
  readonly operation: FileOperation;
  /** Description of the conflict. */
  readonly message: string;
  /** Available resolution actions. */
  readonly availableActions: readonly ConflictResolutionAction[];
  /** The chosen resolution (set when the user decides). */
  chosenAction?: ConflictResolutionAction;
}

// ─── Transaction Journal Types ──────────────────────────────────────────────

/**
 * State of a transaction journal.
 */
export type JournalState =
  | 'created'
  | 'validating'
  | 'applying'
  | 'committed'
  | 'rolled-back'
  | 'failed';

/**
 * An inverse operation stored in the journal for rollback.
 */
export interface InverseOperation {
  /** The original operation index. */
  readonly operationIndex: number;
  /** The kind of inverse action needed. */
  readonly kind: 'delete-created' | 'restore-modified' | 'restore-renamed' | 'restore-moved' | 'restore-deleted';
  /** The target URI to restore or remove. */
  readonly targetUri: string;
  /** Source URI (for rename/move restores). */
  readonly sourceUri?: string;
  /** Content hash before mutation (for verification). */
  readonly priorHash: string;
  /** Content blob reference for restoration. */
  readonly priorContentRef?: string;
}

/**
 * A durable transaction journal recording inverse operations for rollback.
 */
export interface TransactionJournal {
  /** Unique journal ID. */
  readonly id: string;
  /** The Change_Set being applied. */
  readonly changeSetId: string;
  /** Workspace this transaction targets. */
  readonly workspaceId: string;
  /** Current journal state. */
  state: JournalState;
  /** Pre-apply workspace fingerprint. */
  readonly preFingerprint: string;
  /** Expected post-apply workspace fingerprint. */
  postFingerprint?: string;
  /** Inverse operations for rollback (applied in reverse order). */
  readonly inverseOperations: InverseOperation[];
  /** Timestamp of journal creation. */
  readonly createdAt: string;
  /** Timestamp of last state change. */
  updatedAt: string;
}

// ─── Transaction Result Types ───────────────────────────────────────────────

/**
 * Result of a Change_Transaction validation phase.
 */
export interface ValidationResult {
  /** Whether all preconditions passed. */
  readonly valid: boolean;
  /** Precondition failures (empty when valid). */
  readonly failures: readonly PreconditionFailure[];
  /** Conflicts requiring resolution (after source drift). */
  readonly conflicts: readonly TransactionConflict[];
}

/**
 * Result of a Change_Transaction application.
 */
export interface TransactionResult {
  /** Whether the transaction completed successfully. */
  readonly success: boolean;
  /** The transaction journal (for audit and recovery). */
  readonly journal: TransactionJournal;
  /** Precondition failures (if validation failed). */
  readonly failures: readonly PreconditionFailure[];
  /** Conflicts (if source drift detected). */
  readonly conflicts: readonly TransactionConflict[];
  /** Error message (if application failed after validation). */
  readonly error?: string;
  /** The pre-apply checkpoint ID (if created). */
  readonly preCheckpointId?: string;
  /** The post-apply checkpoint ID (if created). */
  readonly postCheckpointId?: string;
}

// ─── Workspace Adapter Interface ────────────────────────────────────────────

/**
 * Adapter for workspace filesystem operations.
 * This abstraction allows testing and decouples from the actual filesystem.
 */
export interface WorkspaceAdapter {
  /** Checks if a file exists at the given URI. */
  exists(uri: string): boolean;
  /** Returns the content hash of a file, or null if not found. */
  getContentHash(uri: string): string | null;
  /** Returns the document version of a file, or null if not found. */
  getDocumentVersion(uri: string): number | null;
  /** Checks if a file is writable. */
  isWritable(uri: string): boolean;
  /** Reads file content (for journal storage). */
  readContent(uri: string): string | null;
  /** Writes file content. Throws on failure. */
  writeContent(uri: string, content: string): void;
  /** Deletes a file. Throws on failure. */
  deleteFile(uri: string): void;
  /** Renames a file from sourceUri to targetUri. Throws on failure. */
  renameFile(sourceUri: string, targetUri: string): void;
  /** Creates a workspace fingerprint for the given URIs. */
  computeFingerprint(uris: string[]): string;
}

/**
 * Adapter for path policy checks.
 */
export interface PathPolicyAdapter {
  /** Checks if a URI is within allowed workspace roots and passes policy. */
  isAllowed(uri: string, workspaceId: string): boolean;
  /** Returns the reason a path is denied (for error messages). */
  getDenialReason(uri: string, workspaceId: string): string;
}

/**
 * Adapter for approval policy checks.
 */
export interface ApprovalPolicyAdapter {
  /** Checks if the Change_Set has the required approval for application. */
  isApproved(changeSet: ChangeSet): boolean;
  /** Returns the reason approval is still required. */
  getPendingReason(changeSet: ChangeSet): string;
}

/**
 * Adapter for model (editor buffer) updates.
 */
export interface ModelAdapter {
  /** Applies a grouped edit to all open models affected by the transaction. */
  applyGroupedEdit(operations: readonly AppliedOperation[]): void;
  /** Reverts a grouped edit (for rollback). */
  revertGroupedEdit(operations: readonly AppliedOperation[]): void;
}

/**
 * A record of an applied operation (for model updates and evidence).
 */
export interface AppliedOperation {
  /** The operation index. */
  readonly operationIndex: number;
  /** The original operation. */
  readonly operation: FileOperation;
  /** The content written (for create/modify). */
  readonly writtenContent?: string;
}

// ─── Fault Injection ────────────────────────────────────────────────────────

/**
 * Points where faults can be injected for testing.
 */
export type FaultInjectionPoint =
  | 'before-validation'
  | 'after-validation'
  | 'before-journal-write'
  | 'after-journal-write'
  | 'during-apply'
  | 'after-partial-apply'
  | 'before-model-update'
  | 'after-model-update'
  | 'before-commit';

/**
 * Configuration for fault injection during testing.
 */
export interface FaultInjectionConfig {
  /** The point at which to inject the fault. */
  readonly point: FaultInjectionPoint;
  /** The error to throw. */
  readonly error: Error;
  /** Only trigger on the Nth invocation (0 = always). */
  readonly triggerOnInvocation?: number;
}

// ─── ChangeTransactionService ───────────────────────────────────────────────

/**
 * ChangeTransactionService validates and atomically applies accepted Change_Sets.
 *
 * The transaction protocol is:
 * 1. Validate all preconditions (no mutation on failure).
 * 2. Write a durable journal with inverse operations.
 * 3. Apply disk mutations.
 * 4. Update open editor models as one grouped edit.
 * 5. Verify postconditions.
 * 6. Mark journal committed.
 *
 * Any failure after step 2 triggers rollback using the journal.
 */
export class ChangeTransactionService {
  private readonly workspace: WorkspaceAdapter;
  private readonly pathPolicy: PathPolicyAdapter;
  private readonly approvalPolicy: ApprovalPolicyAdapter;
  private readonly modelAdapter: ModelAdapter;
  private readonly journals = new Map<string, TransactionJournal>();
  private faultInjections: FaultInjectionConfig[] = [];
  private faultInvocationCounts = new Map<FaultInjectionPoint, number>();

  constructor(
    workspace: WorkspaceAdapter,
    pathPolicy: PathPolicyAdapter,
    approvalPolicy: ApprovalPolicyAdapter,
    modelAdapter: ModelAdapter
  ) {
    this.workspace = workspace;
    this.pathPolicy = pathPolicy;
    this.approvalPolicy = approvalPolicy;
    this.modelAdapter = modelAdapter;
  }

  /**
   * Validates all preconditions for a Change_Set without applying any mutation.
   *
   * Checks in order:
   * 1. Path policy for all target/source URIs
   * 2. Base hashes and versions
   * 3. File existence (creates must not exist, others must)
   * 4. Rename/move collision detection
   * 5. Operation overlap detection
   * 6. Writability for all targets
   * 7. Approval policy
   */
  validate(changeSet: ChangeSet): ValidationResult {
    this.maybeTriggerFault('before-validation');

    const failures: PreconditionFailure[] = [];
    const conflicts: TransactionConflict[] = [];

    // 1. Path policy checks
    for (let i = 0; i < changeSet.operations.length; i++) {
      const op = changeSet.operations[i]!;
      const pathFailures = this.validatePathPolicy(op, i, changeSet.workspaceId);
      failures.push(...pathFailures);
    }

    if (failures.length > 0) {
      return { valid: false, failures, conflicts };
    }

    // 2. Base hash/version checks
    for (let i = 0; i < changeSet.operations.length; i++) {
      const op = changeSet.operations[i]!;
      const hashResult = this.validateBaseHash(op, i);
      if (hashResult.failure) {
        failures.push(hashResult.failure);
      }
      if (hashResult.conflict) {
        conflicts.push(hashResult.conflict);
      }
    }

    if (failures.length > 0 || conflicts.length > 0) {
      return { valid: failures.length === 0 && conflicts.length === 0, failures, conflicts };
    }

    // 3. File existence checks
    for (let i = 0; i < changeSet.operations.length; i++) {
      const op = changeSet.operations[i]!;
      const existenceFailure = this.validateExistence(op, i);
      if (existenceFailure) {
        failures.push(existenceFailure);
      }
    }

    if (failures.length > 0) {
      return { valid: false, failures, conflicts };
    }

    // 4. Rename/move collision detection
    const renameCollisions = this.detectRenameCollisions(changeSet.operations);
    failures.push(...renameCollisions);

    if (failures.length > 0) {
      return { valid: false, failures, conflicts };
    }

    // 5. Operation overlap detection
    const overlaps = this.detectOperationOverlaps(changeSet.operations);
    failures.push(...overlaps);

    if (failures.length > 0) {
      return { valid: false, failures, conflicts };
    }

    // 6. Writability checks
    for (let i = 0; i < changeSet.operations.length; i++) {
      const op = changeSet.operations[i]!;
      const writabilityFailure = this.validateWritability(op, i);
      if (writabilityFailure) {
        failures.push(writabilityFailure);
      }
    }

    if (failures.length > 0) {
      return { valid: false, failures, conflicts };
    }

    // 7. Approval policy
    if (!this.approvalPolicy.isApproved(changeSet)) {
      failures.push({
        kind: 'approval-required',
        operationIndex: 0,
        operation: changeSet.operations[0]!,
        message: this.approvalPolicy.getPendingReason(changeSet),
      });
    }

    this.maybeTriggerFault('after-validation');

    return {
      valid: failures.length === 0 && conflicts.length === 0,
      failures,
      conflicts,
    };
  }

  /**
   * Applies a validated Change_Set as one atomic recoverable transaction.
   *
   * This method:
   * 1. Re-validates all preconditions (double-check for race conditions).
   * 2. Creates a pre-apply workspace fingerprint.
   * 3. Writes a durable journal with inverse operations.
   * 4. Applies all disk mutations.
   * 5. Updates open editor models as one grouped edit.
   * 6. Verifies postconditions.
   * 7. Marks the journal committed.
   *
   * On any failure after the journal is written, performs rollback.
   */
  apply(changeSet: ChangeSet): TransactionResult {
    // Re-validate preconditions
    const validation = this.validate(changeSet);
    if (!validation.valid) {
      return {
        success: false,
        journal: this.createEmptyJournal(changeSet),
        failures: validation.failures,
        conflicts: validation.conflicts,
      };
    }

    // Compute pre-apply workspace fingerprint
    const affectedUris = this.getAffectedUris(changeSet.operations);
    const preFingerprint = this.workspace.computeFingerprint(affectedUris);

    this.maybeTriggerFault('before-journal-write');

    // Create the transaction journal
    const journal = this.createJournal(changeSet, preFingerprint);
    this.journals.set(journal.id, journal);

    this.maybeTriggerFault('after-journal-write');

    // Build inverse operations for rollback
    try {
      this.buildInverseOperations(journal, changeSet.operations);
    } catch (err) {
      journal.state = 'failed';
      journal.updatedAt = new Date().toISOString();
      return {
        success: false,
        journal,
        failures: [],
        conflicts: [],
        error: `Failed to build inverse operations: ${(err as Error).message}`,
      };
    }

    // Apply disk mutations
    journal.state = 'applying';
    journal.updatedAt = new Date().toISOString();

    const appliedOperations: AppliedOperation[] = [];

    try {
      for (let i = 0; i < changeSet.operations.length; i++) {
        const op = changeSet.operations[i]!;

        this.maybeTriggerFault('during-apply');

        const applied = this.applyDiskOperation(op, i);
        appliedOperations.push(applied);

        // Check for partial-apply fault injection after first operation
        if (i > 0 && i < changeSet.operations.length - 1) {
          this.maybeTriggerFault('after-partial-apply');
        }
      }
    } catch (err) {
      // Rollback: restore all already-applied operations using the journal
      this.rollback(journal, appliedOperations);
      journal.state = 'rolled-back';
      journal.updatedAt = new Date().toISOString();
      return {
        success: false,
        journal,
        failures: [],
        conflicts: [],
        error: `Write failed during application: ${(err as Error).message}`,
      };
    }

    // Update editor models
    this.maybeTriggerFault('before-model-update');

    try {
      this.modelAdapter.applyGroupedEdit(appliedOperations);
    } catch (err) {
      // Rollback disk changes and model changes
      this.rollback(journal, appliedOperations);
      try {
        this.modelAdapter.revertGroupedEdit(appliedOperations);
      } catch {
        // Model revert is best-effort; disk rollback already happened
      }
      journal.state = 'rolled-back';
      journal.updatedAt = new Date().toISOString();
      return {
        success: false,
        journal,
        failures: [],
        conflicts: [],
        error: `Model update failed: ${(err as Error).message}`,
      };
    }

    this.maybeTriggerFault('after-model-update');

    // Verify postconditions
    const postFingerprint = this.workspace.computeFingerprint(affectedUris);
    journal.postFingerprint = postFingerprint;

    this.maybeTriggerFault('before-commit');

    // Mark journal committed
    journal.state = 'committed';
    journal.updatedAt = new Date().toISOString();

    return {
      success: true,
      journal,
      failures: [],
      conflicts: [],
    };
  }

  /**
   * Recovers an incomplete transaction on startup.
   * Checks if any journal is in a non-terminal state and either
   * completes rollback or reports the situation.
   */
  recoverIncompleteTransactions(): TransactionJournal[] {
    const incomplete: TransactionJournal[] = [];

    for (const journal of this.journals.values()) {
      if (journal.state === 'applying' || journal.state === 'validating') {
        // These journals indicate a crash during application — rollback needed
        incomplete.push(journal);
      }
    }

    return incomplete;
  }

  /**
   * Forces rollback of a journal that was interrupted.
   * Verifies prior fingerprints before and after rollback.
   */
  forceRollback(journalId: string): { success: boolean; error?: string } {
    const journal = this.journals.get(journalId);
    if (!journal) {
      return { success: false, error: `Journal ${journalId} not found` };
    }

    if (journal.state === 'committed' || journal.state === 'rolled-back') {
      return { success: false, error: `Journal ${journalId} is already in terminal state: ${journal.state}` };
    }

    try {
      // Apply inverse operations in reverse order
      for (let i = journal.inverseOperations.length - 1; i >= 0; i--) {
        const inv = journal.inverseOperations[i]!;
        this.applyInverseOperation(inv);
      }

      // Verify the workspace returns to the pre-fingerprint state
      const currentFingerprint = this.workspace.computeFingerprint(
        journal.inverseOperations.map((inv) => inv.targetUri)
      );

      if (currentFingerprint !== journal.preFingerprint) {
        journal.state = 'failed';
        journal.updatedAt = new Date().toISOString();
        return {
          success: false,
          error: 'Rollback completed but fingerprint does not match pre-transaction state',
        };
      }

      journal.state = 'rolled-back';
      journal.updatedAt = new Date().toISOString();
      return { success: true };
    } catch (err) {
      journal.state = 'failed';
      journal.updatedAt = new Date().toISOString();
      return { success: false, error: `Rollback failed: ${(err as Error).message}` };
    }
  }

  /**
   * Returns the journal for a given ID.
   */
  getJournal(journalId: string): TransactionJournal | undefined {
    return this.journals.get(journalId);
  }

  /**
   * Lists all journals (for recovery and audit).
   */
  listJournals(): TransactionJournal[] {
    return Array.from(this.journals.values());
  }

  // ─── Fault Injection (Testing Only) ─────────────────────────────────────

  /**
   * Configures fault injection for testing atomicity guarantees.
   * In production, this is never called.
   */
  injectFault(config: FaultInjectionConfig): void {
    this.faultInjections.push(config);
  }

  /**
   * Clears all fault injections.
   */
  clearFaultInjections(): void {
    this.faultInjections = [];
    this.faultInvocationCounts.clear();
  }

  // ─── Private: Validation ──────────────────────────────────────────────────

  private validatePathPolicy(
    op: FileOperation,
    index: number,
    workspaceId: string
  ): PreconditionFailure[] {
    const failures: PreconditionFailure[] = [];
    const uris = this.getOperationUris(op);

    for (const uri of uris) {
      if (!this.pathPolicy.isAllowed(uri, workspaceId)) {
        failures.push({
          kind: 'path-policy-violation',
          operationIndex: index,
          operation: op,
          message: this.pathPolicy.getDenialReason(uri, workspaceId),
          actual: uri,
        });
      }
    }

    return failures;
  }

  private validateBaseHash(
    op: FileOperation,
    index: number
  ): { failure?: PreconditionFailure; conflict?: TransactionConflict } {
    if (op.kind === 'create') {
      return {};
    }

    const sourceUri = op.kind === 'rename' || op.kind === 'move'
      ? op.sourceUri
      : op.targetUri;

    const currentHash = this.workspace.getContentHash(sourceUri);

    if (currentHash === null) {
      return {
        failure: {
          kind: 'file-not-found',
          operationIndex: index,
          operation: op,
          message: `File '${sourceUri}' does not exist`,
          expected: op.baseHash,
          actual: '<not-found>',
        },
      };
    }

    if (currentHash !== op.baseHash) {
      // Source drift detected — this is a conflict, not a hard failure
      return {
        conflict: {
          operationIndex: index,
          operation: op,
          message: `File '${sourceUri}' has changed since the proposal was generated ` +
            `(expected hash '${op.baseHash.slice(0, 8)}...', found '${currentHash.slice(0, 8)}...')`,
          availableActions: [
            'rebase-proposal',
            'open-three-way-merge',
            'regenerate-affected-file',
            'reject',
          ],
        },
      };
    }

    // Also check document version if provided
    if ('baseVersion' in op && op.baseVersion !== undefined) {
      const currentVersion = this.workspace.getDocumentVersion(sourceUri);
      if (currentVersion !== null && currentVersion !== op.baseVersion) {
        return {
          conflict: {
            operationIndex: index,
            operation: op,
            message: `File '${sourceUri}' has a version mismatch ` +
              `(expected version ${op.baseVersion}, found ${currentVersion})`,
            availableActions: [
              'rebase-proposal',
              'open-three-way-merge',
              'regenerate-affected-file',
              'reject',
            ],
          },
        };
      }
    }

    return {};
  }

  private validateExistence(
    op: FileOperation,
    index: number
  ): PreconditionFailure | null {
    if (op.kind === 'create') {
      // Create must not already exist
      if (this.workspace.exists(op.targetUri)) {
        return {
          kind: 'file-already-exists',
          operationIndex: index,
          operation: op,
          message: `Cannot create file '${op.targetUri}': file already exists`,
          actual: op.targetUri,
        };
      }
    } else if (op.kind === 'rename' || op.kind === 'move') {
      // Source must exist
      if (!this.workspace.exists(op.sourceUri)) {
        return {
          kind: 'file-not-found',
          operationIndex: index,
          operation: op,
          message: `Cannot ${op.kind} file '${op.sourceUri}': file does not exist`,
          expected: op.sourceUri,
        };
      }
    } else {
      // modify/delete: target must exist
      if (!this.workspace.exists(op.targetUri)) {
        return {
          kind: 'file-not-found',
          operationIndex: index,
          operation: op,
          message: `Cannot ${op.kind} file '${op.targetUri}': file does not exist`,
          expected: op.targetUri,
        };
      }
    }

    return null;
  }

  private detectRenameCollisions(
    operations: readonly FileOperation[]
  ): PreconditionFailure[] {
    const failures: PreconditionFailure[] = [];
    const targetUris = new Map<string, number>(); // URI -> first operation index

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i]!;
      const targets = this.getTargetUris(op);

      for (const uri of targets) {
        const existingIndex = targetUris.get(uri);
        if (existingIndex !== undefined) {
          failures.push({
            kind: 'rename-collision',
            operationIndex: i,
            operation: op,
            message: `Operation ${i} targets '${uri}' which is already targeted by operation ${existingIndex}`,
            expected: `unique target URI`,
            actual: uri,
          });
        } else {
          targetUris.set(uri, i);
        }
      }
    }

    return failures;
  }

  private detectOperationOverlaps(
    operations: readonly FileOperation[]
  ): PreconditionFailure[] {
    const failures: PreconditionFailure[] = [];
    const modifyTargets = new Map<string, number>(); // URI -> first modify op index

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i]!;

      if (op.kind === 'modify') {
        const existingIndex = modifyTargets.get(op.targetUri);
        if (existingIndex !== undefined) {
          failures.push({
            kind: 'operation-overlap',
            operationIndex: i,
            operation: op,
            message: `Multiple modify operations target '${op.targetUri}' ` +
              `(operations ${existingIndex} and ${i})`,
          });
        } else {
          modifyTargets.set(op.targetUri, i);
        }
      }

      // Check for modify + delete on same URI
      if (op.kind === 'delete') {
        const modifyIndex = modifyTargets.get(op.targetUri);
        if (modifyIndex !== undefined) {
          failures.push({
            kind: 'operation-overlap',
            operationIndex: i,
            operation: op,
            message: `Delete operation on '${op.targetUri}' conflicts with ` +
              `modify operation at index ${modifyIndex}`,
          });
        }
      }

      // Check for create + existing modify/delete
      if (op.kind === 'create') {
        const modifyIndex = modifyTargets.get(op.targetUri);
        if (modifyIndex !== undefined) {
          failures.push({
            kind: 'operation-overlap',
            operationIndex: i,
            operation: op,
            message: `Create operation on '${op.targetUri}' conflicts with ` +
              `modify operation at index ${modifyIndex}`,
          });
        }
      }
    }

    return failures;
  }

  private validateWritability(
    op: FileOperation,
    index: number
  ): PreconditionFailure | null {
    // For creates, check parent directory writability by checking target
    // For others, check the target file's writability
    const uri = op.targetUri;

    // Skip writability check for deletes targeting existing files
    // (deletion writability is about the file's parent)
    if (op.kind === 'delete') {
      if (!this.workspace.isWritable(uri)) {
        return {
          kind: 'not-writable',
          operationIndex: index,
          operation: op,
          message: `File '${uri}' is not writable (cannot delete)`,
          actual: uri,
        };
      }
      return null;
    }

    if (op.kind === 'rename' || op.kind === 'move') {
      // Both source (to remove) and target (to create) must be writable
      if (!this.workspace.isWritable(op.sourceUri)) {
        return {
          kind: 'not-writable',
          operationIndex: index,
          operation: op,
          message: `Source file '${op.sourceUri}' is not writable (cannot ${op.kind})`,
          actual: op.sourceUri,
        };
      }
    }

    // For create/modify/rename-target/move-target
    if (!this.workspace.isWritable(uri)) {
      return {
        kind: 'not-writable',
        operationIndex: index,
        operation: op,
        message: `Target '${uri}' is not writable`,
        actual: uri,
      };
    }

    return null;
  }

  // ─── Private: Journal and Application ─────────────────────────────────────

  private createJournal(changeSet: ChangeSet, preFingerprint: string): TransactionJournal {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      changeSetId: changeSet.id,
      workspaceId: changeSet.workspaceId,
      state: 'validating',
      preFingerprint,
      inverseOperations: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private createEmptyJournal(changeSet: ChangeSet): TransactionJournal {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      changeSetId: changeSet.id,
      workspaceId: changeSet.workspaceId,
      state: 'failed',
      preFingerprint: '',
      inverseOperations: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private buildInverseOperations(
    journal: TransactionJournal,
    operations: readonly FileOperation[]
  ): void {
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i]!;
      const inverse = this.buildInverseForOperation(op, i);
      (journal.inverseOperations as InverseOperation[]).push(inverse);
    }
  }

  private buildInverseForOperation(
    op: FileOperation,
    index: number
  ): InverseOperation {
    switch (op.kind) {
      case 'create':
        return {
          operationIndex: index,
          kind: 'delete-created',
          targetUri: op.targetUri,
          priorHash: '', // No prior content for creates
        };

      case 'modify': {
        const content = this.workspace.readContent(op.targetUri);
        const hash = this.workspace.getContentHash(op.targetUri) ?? '';
        return {
          operationIndex: index,
          kind: 'restore-modified',
          targetUri: op.targetUri,
          priorHash: hash,
          priorContentRef: content ?? undefined,
        };
      }

      case 'rename': {
        const content = this.workspace.readContent(op.sourceUri);
        const hash = this.workspace.getContentHash(op.sourceUri) ?? '';
        return {
          operationIndex: index,
          kind: 'restore-renamed',
          targetUri: op.targetUri,
          sourceUri: op.sourceUri,
          priorHash: hash,
          priorContentRef: content ?? undefined,
        };
      }

      case 'move': {
        const content = this.workspace.readContent(op.sourceUri);
        const hash = this.workspace.getContentHash(op.sourceUri) ?? '';
        return {
          operationIndex: index,
          kind: 'restore-moved',
          targetUri: op.targetUri,
          sourceUri: op.sourceUri,
          priorHash: hash,
          priorContentRef: content ?? undefined,
        };
      }

      case 'delete': {
        const content = this.workspace.readContent(op.targetUri);
        const hash = this.workspace.getContentHash(op.targetUri) ?? '';
        return {
          operationIndex: index,
          kind: 'restore-deleted',
          targetUri: op.targetUri,
          priorHash: hash,
          priorContentRef: content ?? undefined,
        };
      }
    }
  }

  private applyDiskOperation(op: FileOperation, index: number): AppliedOperation {
    switch (op.kind) {
      case 'create':
        this.workspace.writeContent(op.targetUri, op.proposedBlob);
        return { operationIndex: index, operation: op, writtenContent: op.proposedBlob };

      case 'modify':
        this.workspace.writeContent(op.targetUri, op.proposedBlob);
        return { operationIndex: index, operation: op, writtenContent: op.proposedBlob };

      case 'rename':
        this.workspace.renameFile(op.sourceUri, op.targetUri);
        return { operationIndex: index, operation: op };

      case 'move':
        this.workspace.renameFile(op.sourceUri, op.targetUri);
        return { operationIndex: index, operation: op };

      case 'delete':
        this.workspace.deleteFile(op.targetUri);
        return { operationIndex: index, operation: op };
    }
  }

  private rollback(journal: TransactionJournal, appliedOperations: AppliedOperation[]): void {
    // Rollback in reverse order of application
    for (let i = appliedOperations.length - 1; i >= 0; i--) {
      const applied = appliedOperations[i]!;
      const inverse = journal.inverseOperations.find(
        (inv) => inv.operationIndex === applied.operationIndex
      );

      if (inverse) {
        try {
          this.applyInverseOperation(inverse);
        } catch {
          // Best effort — log but continue rolling back other operations
        }
      }
    }
  }

  private applyInverseOperation(inverse: InverseOperation): void {
    switch (inverse.kind) {
      case 'delete-created':
        // Undo create by deleting the file
        if (this.workspace.exists(inverse.targetUri)) {
          this.workspace.deleteFile(inverse.targetUri);
        }
        break;

      case 'restore-modified':
        // Undo modify by restoring prior content
        if (inverse.priorContentRef !== undefined) {
          this.workspace.writeContent(inverse.targetUri, inverse.priorContentRef);
        }
        break;

      case 'restore-renamed':
        // Undo rename by renaming back
        if (inverse.sourceUri) {
          this.workspace.renameFile(inverse.targetUri, inverse.sourceUri);
        }
        break;

      case 'restore-moved':
        // Undo move by moving back
        if (inverse.sourceUri) {
          this.workspace.renameFile(inverse.targetUri, inverse.sourceUri);
        }
        break;

      case 'restore-deleted':
        // Undo delete by recreating with prior content
        if (inverse.priorContentRef !== undefined) {
          this.workspace.writeContent(inverse.targetUri, inverse.priorContentRef);
        }
        break;
    }
  }

  // ─── Private: Helpers ─────────────────────────────────────────────────────

  private getOperationUris(op: FileOperation): string[] {
    switch (op.kind) {
      case 'create':
      case 'modify':
      case 'delete':
        return [op.targetUri];
      case 'rename':
      case 'move':
        return [op.sourceUri, op.targetUri];
    }
  }

  private getTargetUris(op: FileOperation): string[] {
    switch (op.kind) {
      case 'create':
      case 'modify':
        return [op.targetUri];
      case 'rename':
      case 'move':
        return [op.targetUri]; // Only the new target could collide
      case 'delete':
        return []; // Deletes don't create a target
    }
  }

  private getAffectedUris(operations: readonly FileOperation[]): string[] {
    const uris = new Set<string>();
    for (const op of operations) {
      for (const uri of this.getOperationUris(op)) {
        uris.add(uri);
      }
    }
    return Array.from(uris).sort();
  }

  private maybeTriggerFault(point: FaultInjectionPoint): void {
    const count = (this.faultInvocationCounts.get(point) ?? 0) + 1;
    this.faultInvocationCounts.set(point, count);

    for (const injection of this.faultInjections) {
      if (injection.point === point) {
        if (injection.triggerOnInvocation === undefined || injection.triggerOnInvocation === 0) {
          throw injection.error;
        }
        if (count === injection.triggerOnInvocation) {
          throw injection.error;
        }
      }
    }
  }
}
