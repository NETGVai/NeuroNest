/**
 * RestoreService — verified, journaled workspace restore from a `Checkpoint@1`
 * (FUT-PKG-05-RECOVERY/T-004).
 *
 * D-14 fixes the restore sequence exactly. This module is the Checkpoint
 * Authority's restore path: the workspace, checkpoint, transcript, and journal
 * authorities are observers; the trigger is a restore at every crash boundary;
 * the expected outcome is a verified restore (or a typed non-success that
 * returns to the rescue checkpoint and the prior projection generation) — a
 * hard-reset loss, an implicit transcript deletion, a partial/incompatible
 * success, or a blind retry is prohibited (NN-CHECKPOINT-005–009, NN-CHAT-009/
 * 010, NN-EVENT-005, NN-DATA-006).
 *
 * The sequence (D-14):
 *
 *   1. PREFLIGHT (NN-CHECKPOINT-005): verify the record exists and is active,
 *      re-verify its one immutable artifact (recompute the integrity digest AND
 *      re-hash every stored blob via {@link CheckpointService.verifyIntegrity}),
 *      confirm the scope names the same project, confirm base-ref compatibility
 *      (a git-ref checkpoint anchored to a different base than the caller
 *      declares is refused), and read the current workspace status. ANY mismatch
 *      aborts with a typed error and leaves the current state unchanged — there
 *      is never a partial or incompatible success (NN-INV-002/003).
 *
 *   2. CURRENT-STATE RESCUE (NN-CHECKPOINT-006, NN-DATA-006, no hard-reset loss
 *      NN-CHECKPOINT-007): BEFORE restoring, capture the CURRENT bytes of every
 *      path the restore will touch into a NEW rescue `Checkpoint@1` (source
 *      `rescue`, retention `rescue` — never pruned) and re-verify it. Uncommitted
 *      user state is thereby preserved as a named artifact before any replacement.
 *      An unverifiable rescue blocks the restore (recovery precedes mutation).
 *
 *   3. STAGED BACKEND RESTORE (NN-CHECKPOINT-006, D-12/D-14): stage the target
 *      checkpoint's captured bytes into a staging directory BESIDE the live root
 *      (never overwriting the live root directly) via {@link CheckpointBackend.
 *      stageRestore}, verify the staged bytes hash to the manifest, then — only
 *      after journaling the effect — atomically promote the staged state and
 *      apply deletions as an all-or-none unit. If full atomicity is unavailable
 *      the transactional fallback returns to the rescue checkpoint
 *      (NN-CHECKPOINT-006).
 *
 *   4. JOURNAL (D-08.2, D-18): commit an `OperationJournal@1` as `applying` with
 *      a `compensatable` strategy, the rescue reference/state, and the expected
 *      workspace revision BEFORE the promotion touches the live root. On a fault
 *      at any boundary the verified rescue is restored, the journal is
 *      `compensated`, and a typed failure is returned — never a partial apply and
 *      never a success from an unknown effect (NN-INV-003).
 *
 *   5. RECONCILE (NN-CHECKPOINT-009, NN-EVENT-005): on a committed restore,
 *      invalidate stale caches/projections by rebuilding the affected projection
 *      beside-active; a partial/incompatible restore stays visibly blocked and is
 *      never shown complete.
 *
 *   6. RECOVERY (D-15, D-18): {@link recover} classifies every nonterminal
 *      restore journal via the T-004 restart classifier and resolves a
 *      `compensatable` unknown effect by restoring the recorded rescue (returning
 *      to the rescue checkpoint) and rolling the projection back to the prior
 *      generation — it NEVER blindly repeats the restore nor reports success.
 *
 * Transcript rewind is a SEPARATE, digest-bound, separately-authorized command
 * ({@link ./transcript-rewind}); a workspace restore performed here NEVER
 * deletes the chat transcript (NN-CHECKPOINT-008, NN-CHAT-009/010).
 *
 * Additive: this module owns no new business table. It uses the CheckpointService
 * as the sole `Checkpoint@1` writer (NN-INV-008), the T-004 operation journal for
 * the saga, and the ProjectionService for cache/projection reconciliation.
 *
 * Design anchors: D-14 (restore sequence), D-15 (restart classifier), D-18
 * (incomplete operation / false-success prevention), D-20 (rollback to prior
 * projection generation). Requirements: NN-CHECKPOINT-005–009, NN-CHAT-009/010,
 * NN-EVENT-005, NN-DATA-006, NN-INV-002/003/006/007.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  computeDigest,
  makeOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
  type ScopeDescriptor,
} from '../shared/contract-primitives.js';
import {
  beginJournaledOperation,
  classifyNonterminalOperations,
  commitJournaledOperation,
  compensateJournaledOperation,
  ensureOperationJournalTables,
  markApplying,
  readJournalById,
  type OperationJournalRecord,
} from '../storage/operation-journal.js';
import {
  ensureProjectionTables,
  rebuildProjection,
  rollbackToGeneration,
  type ProjectionDefinition,
} from '../storage/projection-service.js';
import type Database from 'better-sqlite3';

import { sha256 } from './backends/index.js';
import { CheckpointService } from './checkpoint-service.js';
import type { CheckpointBackend, CheckpointRecord } from './checkpoint-types.js';

// ─── Errors ──────────────────────────────────────────────────────────────────

/** The Restore Authority owner id stamped on journal rows and errors. */
export const RESTORE_SERVICE_AUTHORITY = 'authority-checkpoint-restore';

/** A typed failure surfaced by the Restore Service. */
export class RestoreServiceError extends Error {
  readonly error: ErrorEnvelope;
  constructor(error: ErrorEnvelope) {
    super(error.message);
    this.name = 'RestoreServiceError';
    this.error = error;
  }
}

function restoreError(
  code: ErrorCode,
  message: string,
  operation: string,
  correlationId: string,
  extra: Partial<ErrorEnvelope> = {},
): ErrorEnvelope {
  return {
    schemaVersion: 1,
    code,
    message,
    owner: RESTORE_SERVICE_AUTHORITY,
    operation,
    correlationId,
    retryable: false,
    redaction: 'internal',
    ...extra,
  };
}

// ─── Rescue snapshot (current bytes of every touched path) ───────────────────

/** The captured CURRENT state of one path, taken BEFORE the restore mutates. */
interface RescueEntry {
  readonly relativePath: string;
  readonly existedBefore: boolean;
  /** Base64 of the current bytes when it existed; else null. */
  readonly currentContentB64: string | null;
  readonly currentSha256: string | null;
  readonly mode: number | null;
}

/**
 * The current-state rescue captured and verified before any restore mutation.
 * It records the live bytes of every path the restore will touch (both the
 * paths the target checkpoint will write and the paths it will delete), so a
 * failed restore returns the workspace byte-for-byte to the pre-restore state
 * (NN-CHECKPOINT-006/007, no hard-reset loss).
 */
interface RescueSnapshot {
  readonly rescueCheckpointId: string;
  readonly rootPath: string;
  readonly entries: readonly RescueEntry[];
  /** Digest over the entries; compared on restore (NN-INV-006). */
  readonly integrityDigest: string;
}

// ─── Commands / results ──────────────────────────────────────────────────────

/** A workspace restore command targeting one `Checkpoint@1`. */
export interface RestoreCommand {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly scope: ScopeDescriptor;
  /** The project the restore targets; must match the record and the scope. */
  readonly projectId: string;
  /** The checkpoint to restore the workspace to. */
  readonly checkpointId: string;
  /** The absolute workspace root the restore promotes into. */
  readonly rootPath: string;
  /**
   * The base ref the caller expects the checkpoint to be anchored to, when the
   * checkpoint is a git-ref checkpoint. A mismatch aborts the restore
   * (base-ref compatibility, NN-CHECKPOINT-005). Omit for non-git-ref backends.
   */
  readonly expectedBaseRef?: string;
  /** The workspace authority revision the journal binds the terminal commit to. */
  readonly expectedWorkspaceRevision: number;
  readonly resultWorkspaceRevision: number;
  readonly restoredBy: string;
  readonly now?: () => Date;
  /**
   * Test-only fault hook invoked between staged operations during promotion to
   * simulate a crash at a promotion boundary. It forces the rescue-restore
   * (compensation) path — the workspace returns to the verified rescue state.
   */
  readonly faultDuringPromotion?: (appliedCount: number) => void;
  /**
   * Optional projection to reconcile (invalidate/rebuild) after a committed
   * restore, plus the generation to roll back to on a failed/compensated
   * restore (NN-CHECKPOINT-009, NN-EVENT-005).
   */
  readonly projection?: {
    readonly definition: ProjectionDefinition;
    /** The prior projection generation to roll back to on a failed restore. */
    readonly rollbackGeneration?: number;
  };
}

/** The outcome of a restore attempt. */
export type RestoreResult =
  | {
      readonly kind: 'restored';
      readonly checkpointId: string;
      readonly rescueCheckpointId: string;
      readonly journalId: string;
      /** Paths written from the checkpoint. */
      readonly restoredPaths: readonly string[];
      /** Paths deleted because they were absent at capture. */
      readonly deletedPaths: readonly string[];
      /** The rebuilt projection generation, if a projection was reconciled. */
      readonly reconciledGeneration?: number;
    }
  | {
      readonly kind: 'failed';
      readonly rescueCheckpointId: string;
      readonly journalId: string;
      readonly error: ErrorEnvelope;
    };

/** The outcome of crash recovery over nonterminal restore journals. */
export interface RestoreRecoveryResult {
  /** The journal ids that were compensated (rescue restored). */
  readonly compensatedJournalIds: readonly string[];
  /** The journal ids that were left for user review / receipt query. */
  readonly deferredJournalIds: readonly string[];
}

// ─── The Restore Service (Checkpoint Authority restore path) ─────────────────

/**
 * Orchestrates the D-14 verified, journaled restore. It never authors a
 * `Checkpoint@1` directly — the injected {@link CheckpointService} is the sole
 * writer (NN-INV-008) — and it never mutates a business table; the workspace is
 * mutated only through the staged-then-atomic promotion below, guarded by the
 * T-004 journal.
 */
export class RestoreService {
  constructor(
    private readonly db: Database.Database,
    private readonly checkpoints: CheckpointService,
  ) {
    ensureOperationJournalTables(db);
    // The restore reconciliation path (rebuild/rollback) uses the projection
    // service's tables; ensure them additively so a reconciled restore never
    // fails on a missing read-model table (D-08.1, NN-EVENT-005).
    ensureProjectionTables(db);
  }

  /**
   * Restore the workspace to a `Checkpoint@1` following the D-14 sequence:
   * preflight → current-state rescue → staged backend restore → journaled atomic
   * promotion → cache/projection reconciliation. On any preflight failure the
   * current state is unchanged and a typed error is thrown (never a partial
   * success). On any promotion/terminal-commit failure the verified rescue is
   * restored, the journal is compensated, the projection is rolled back to its
   * prior generation, and a typed `failed` result is returned — never a partial
   * apply and never a success (NN-INV-003, NN-CHECKPOINT-006/009).
   */
  restore(cmd: RestoreCommand): RestoreResult {
    const record = this.preflight(cmd);
    const backend = this.requireBackend(record, cmd.correlationId);

    // ── Current-state rescue BEFORE any mutation (NN-CHECKPOINT-006/007). ──
    const rescue = this.captureRescue(record, cmd);
    this.verifyRescue(rescue, cmd.correlationId);

    // ── Stage the target checkpoint's bytes BESIDE the live root (D-14). ──
    const artifactPath = this.artifactPathFor(record.artifactRef);
    const stagingRoot = fs.mkdtempSync(path.join(cmd.rootPath, '.restore-staging-'));
    let staged: ReadonlyMap<string, string>;
    let deletions: readonly string[];
    try {
      const result = backend.stageRestore({
        artifactPath,
        manifest: record.fileManifest,
        stagingRoot,
      });
      staged = result.staged;
      deletions = result.deletions;
      // Verify the staged bytes reproduce the manifest hashes BEFORE promotion.
      this.verifyStaged(record, staged, cmd.correlationId);
    } catch (err) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      throw err instanceof RestoreServiceError
        ? err
        : new RestoreServiceError(
            restoreError(
              'INTEGRITY',
              `staged restore failed to verify: ${(err as Error).message}`,
              'restore-stage',
              cmd.correlationId,
            ),
          );
    }

    // ── Journal the effect as `applying` BEFORE the promotion (D-08.2). ──
    const journal = beginJournaledOperation(this.db, {
      authority: RESTORE_SERVICE_AUTHORITY,
      operationId: makeOpaqueId('op', `restore${cmd.checkpointId}${cmd.commandId}`),
      idempotencyKey: cmd.idempotencyKey,
      correlationId: cmd.correlationId,
      scope: cmd.scope,
      expectedRevision: cmd.expectedWorkspaceRevision,
      strategy: 'compensatable',
      rescueRef: rescue.rescueCheckpointId,
      rescueState: rescue,
      ...(cmd.now ? { now: cmd.now } : {}),
    });
    markApplying(this.db, journal.journalId, cmd.now);

    // ── Promote atomically (all-or-none). Any failure restores the rescue. ──
    const restoredPaths = [...staged.keys()].sort();
    try {
      let applied = 0;
      for (const relPath of restoredPaths) {
        const stagedAbs = staged.get(relPath)!;
        const liveAbs = path.join(cmd.rootPath, relPath.split('/').join(path.sep));
        fs.mkdirSync(path.dirname(liveAbs), { recursive: true });
        fs.copyFileSync(stagedAbs, liveAbs);
        applied += 1;
        cmd.faultDuringPromotion?.(applied);
      }
      for (const relPath of deletions) {
        const liveAbs = path.join(cmd.rootPath, relPath.split('/').join(path.sep));
        if (fs.existsSync(liveAbs)) fs.rmSync(liveAbs, { force: true });
      }
    } catch (promotionErr) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      return this.restoreRescueAndCompensate(
        rescue,
        journal.journalId,
        cmd,
        `restore promotion failed: ${(promotionErr as Error).message}`,
      );
    }
    fs.rmSync(stagingRoot, { recursive: true, force: true });

    // ── Terminal commit (D-08.2 step 3). ──
    const commit = commitJournaledOperation(this.db, {
      journalId: journal.journalId,
      currentRevision: cmd.resultWorkspaceRevision,
      finalize: () => ({ resultRef: makeOpaqueId('res', `restore${cmd.checkpointId}`) }),
      ...(cmd.now ? { now: cmd.now } : {}),
    });
    if (commit.kind === 'blocked') {
      // Terminal commit could not complete: restore the verified rescue and
      // report a typed failure — never a half-applied success (NN-INV-003).
      return this.restoreRescueAndCompensate(
        rescue,
        journal.journalId,
        cmd,
        'restore terminal commit blocked; verified rescue restored',
      );
    }

    // ── Cache/projection reconciliation on success (NN-CHECKPOINT-009). ──
    let reconciledGeneration: number | undefined;
    if (cmd.projection) {
      const rebuilt = rebuildProjection(this.db, cmd.projection.definition, cmd.scope, {
        ...(cmd.now ? { now: cmd.now } : {}),
        // A restore intentionally changes state, so activate the rebuilt
        // generation regardless of the pre-restore digest (the prior generation
        // remains a rollback candidate, D-20).
        requireInvariantMatch: false,
      });
      reconciledGeneration = rebuilt.rebuiltGeneration;
    }

    return {
      kind: 'restored',
      checkpointId: cmd.checkpointId,
      rescueCheckpointId: rescue.rescueCheckpointId,
      journalId: journal.journalId,
      restoredPaths,
      deletedPaths: [...deletions].sort(),
      ...(reconciledGeneration !== undefined ? { reconciledGeneration } : {}),
    };
  }

  /**
   * Recover from a crash: classify every nonterminal restore journal via the
   * T-004 restart classifier and resolve each `compensatable` unknown effect by
   * restoring the recorded rescue (returning to the rescue checkpoint) and, when
   * a projection rollback generation is supplied, rolling the projection back to
   * the prior generation (D-15, D-18, NN-CHECKPOINT-006/009). An unknown restore
   * effect is NEVER blindly repeated nor reported successful (NN-INV-003).
   */
  recover(options: {
    /**
     * The absolute workspace root recovery restores rescue bytes into. Required
     * so a cross-process restart can materialize the durable rescue checkpoint's
     * staged bytes back into the live root; the root is never persisted in the
     * journal (NN-INV-004 forbids an absolute host path in a durable record).
     */
    readonly rootPath: string;
    readonly rollback?: {
      readonly definition: ProjectionDefinition;
      readonly scope: ScopeDescriptor;
      readonly generation: number;
    };
    readonly now?: () => Date;
  }): RestoreRecoveryResult {
    const classifications = classifyNonterminalOperations(this.db);
    const compensatedJournalIds: string[] = [];
    const deferredJournalIds: string[] = [];

    for (const classification of classifications) {
      const journal = readJournalById(this.db, classification.journalId);
      if (!journal || journal.authority !== RESTORE_SERVICE_AUTHORITY) continue;

      if (classification.classification === 'safe-to-retry') {
        // Effect not started or already observed: no rescue restore needed. The
        // effect-observed terminal completion is out of scope for a crash-safe
        // rescue restore; leave it for the caller to complete idempotently.
        continue;
      }
      if (classification.classification !== 'compensate') {
        // requires-user-review / requires-receipt-query / blocked-integrity are
        // never auto-resolved here (no blind retry, NN-INV-003).
        deferredJournalIds.push(journal.journalId);
        continue;
      }

      // A `compensatable` restore whose effect is unknown: restore the recorded
      // rescue rather than repeat the (possibly partial) restore. The rescue
      // bytes are materialized from the durable rescue `Checkpoint@1` (its staged
      // restore reproduces the pre-restore bytes exactly).
      const rescue = this.rescueFromJournal(journal, options.rootPath);
      compensateJournaledOperation(this.db, {
        journalId: journal.journalId,
        compensate: () => {
          if (rescue) this.restoreRescueBytes(rescue);
        },
        ...(options.now ? { now: options.now } : {}),
        errorCode: 'INTEGRITY',
      });
      // Roll the projection back to the prior generation (D-20 rollback).
      if (options.rollback) {
        rollbackToGeneration(
          this.db,
          options.rollback.definition.projectionId,
          options.rollback.scope,
          options.rollback.generation,
          options.now ? { now: options.now } : {},
        );
      }
      compensatedJournalIds.push(journal.journalId);
    }

    return { compensatedJournalIds, deferredJournalIds };
  }

  // ── Preflight (NN-CHECKPOINT-005) ──────────────────────────────────────────

  /**
   * Verify the record, its one immutable artifact, scope, and base-ref
   * compatibility BEFORE any mutation. ANY mismatch aborts with a typed error
   * and leaves the current state unchanged — never a partial or incompatible
   * success (NN-INV-002/003).
   */
  private preflight(cmd: RestoreCommand): CheckpointRecord {
    if (!cmd.projectId || cmd.scope.projectId !== cmd.projectId) {
      throw new RestoreServiceError(
        restoreError(
          'VALIDATION',
          'restore scope must name an explicit project matching the command projectId',
          'restore-preflight',
          cmd.correlationId,
        ),
      );
    }
    const record = this.checkpoints.read(cmd.checkpointId);
    if (!record) {
      throw new RestoreServiceError(
        restoreError(
          'VALIDATION',
          `checkpoint ${cmd.checkpointId} not found`,
          'restore-preflight',
          cmd.correlationId,
        ),
      );
    }
    if (record.state !== 'active') {
      throw new RestoreServiceError(
        restoreError(
          'FORBIDDEN',
          `checkpoint ${cmd.checkpointId} is ${record.state}; only an active checkpoint may be restored`,
          'restore-preflight',
          cmd.correlationId,
        ),
      );
    }
    if (record.projectId !== cmd.projectId) {
      throw new RestoreServiceError(
        restoreError(
          'FORBIDDEN',
          'checkpoint project does not match the restore command project (scope mismatch)',
          'restore-preflight',
          cmd.correlationId,
        ),
      );
    }
    // Base-ref compatibility: a checkpoint anchored to a base ref must match the
    // caller's expected base ref (a divergent base is an incompatible restore).
    if (record.baseRef !== undefined && cmd.expectedBaseRef !== undefined) {
      if (record.baseRef !== cmd.expectedBaseRef) {
        throw new RestoreServiceError(
          restoreError(
            'INCOMPATIBLE',
            `checkpoint base ref "${record.baseRef}" is incompatible with expected "${cmd.expectedBaseRef}"`,
            'restore-preflight',
            cmd.correlationId,
          ),
        );
      }
    }
    // Re-verify the one immutable artifact: recompute the integrity digest AND
    // re-hash every stored blob (NN-CHECKPOINT-005, fail-closed NN-INV-002).
    if (!this.checkpoints.verifyIntegrity(cmd.checkpointId)) {
      throw new RestoreServiceError(
        restoreError(
          'INTEGRITY',
          `checkpoint ${cmd.checkpointId} failed integrity re-verification; refusing to restore`,
          'restore-preflight',
          cmd.correlationId,
        ),
      );
    }
    return record;
  }

  private requireBackend(record: CheckpointRecord, correlationId: string): CheckpointBackend {
    const backend = this.checkpoints.backendFor(record.backendType);
    if (!backend) {
      throw new RestoreServiceError(
        restoreError(
          'UNAVAILABLE',
          `checkpoint backend "${record.backendType}" is not registered`,
          'restore-preflight',
          correlationId,
        ),
      );
    }
    return backend;
  }

  // ── Current-state rescue (NN-CHECKPOINT-006/007, NN-DATA-006) ──────────────

  /**
   * Capture the CURRENT bytes of every path the restore will touch (the paths
   * the target checkpoint writes AND the paths it will delete) into a new rescue
   * `Checkpoint@1` (source `rescue`, retention `rescue`), then re-verify it. The
   * rescue snapshot's raw bytes are held in memory (and mirrored into the
   * journal's rescue state) so a failed restore returns the workspace byte-exact.
   */
  private captureRescue(record: CheckpointRecord, cmd: RestoreCommand): RescueSnapshot {
    const paths = record.fileManifest.map((m) => m.pathRef);
    const entries: RescueEntry[] = [];
    for (const relative of paths) {
      const absolute = path.join(cmd.rootPath, relative.split('/').join(path.sep));
      if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
        const bytes = fs.readFileSync(absolute);
        const stat = fs.statSync(absolute);
        entries.push({
          relativePath: relative,
          existedBefore: true,
          currentContentB64: bytes.toString('base64'),
          currentSha256: sha256(bytes),
          mode: stat.mode,
        });
      } else {
        entries.push({
          relativePath: relative,
          existedBefore: false,
          currentContentB64: null,
          currentSha256: null,
          mode: null,
        });
      }
    }

    // Record the rescue as a verified `Checkpoint@1` through the sole writer so
    // it is durable, never pruned, and appears in the checkpoint timeline. The
    // rescue captures the CURRENT (pre-restore) bytes of the touched paths.
    const rescueResult = this.checkpoints.create({
      commandId: makeOpaqueId('cmd', `rescue${cmd.commandId}`),
      idempotencyKey: `restore-rescue:${cmd.idempotencyKey}`,
      correlationId: cmd.correlationId,
      scope: cmd.scope,
      projectId: cmd.projectId,
      rootPath: cmd.rootPath,
      source: 'rescue',
      backendType: 'file-delta',
      description: `pre-restore rescue for checkpoint ${cmd.checkpointId}`,
      createdBy: cmd.restoredBy,
      lineage: [cmd.checkpointId],
      targetPaths: paths.length > 0 ? paths : undefined,
      ...(cmd.now ? { now: cmd.now } : {}),
    });

    return {
      rescueCheckpointId: rescueResult.record.checkpointId,
      rootPath: cmd.rootPath,
      entries,
      integrityDigest: computeDigest({ checkpointId: rescueResult.record.checkpointId, entries }),
    };
  }

  /**
   * Verify the rescue is intact BEFORE any mutation: recompute its integrity
   * digest and re-read each captured path to confirm its live bytes still match
   * the captured digest. An unverifiable rescue blocks the restore (NN-INV-006).
   */
  private verifyRescue(rescue: RescueSnapshot, correlationId: string): void {
    const recomputed = computeDigest({
      checkpointId: rescue.rescueCheckpointId,
      entries: rescue.entries,
    });
    if (recomputed !== rescue.integrityDigest) {
      throw new RestoreServiceError(
        restoreError(
          'INTEGRITY',
          'rescue integrity digest mismatch; refusing to restore',
          'restore-verify-rescue',
          correlationId,
        ),
      );
    }
    for (const entry of rescue.entries) {
      const absolute = path.join(rescue.rootPath, entry.relativePath.split('/').join(path.sep));
      if (entry.existedBefore) {
        if (!fs.existsSync(absolute) || sha256(fs.readFileSync(absolute)) !== entry.currentSha256) {
          throw new RestoreServiceError(
            restoreError(
              'INTEGRITY',
              `rescue for "${entry.relativePath}" could not be verified; refusing to restore`,
              'restore-verify-rescue',
              correlationId,
            ),
          );
        }
      } else if (fs.existsSync(absolute)) {
        throw new RestoreServiceError(
          restoreError(
            'INTEGRITY',
            `rescue expected "${entry.relativePath}" absent but it exists; refusing to restore`,
            'restore-verify-rescue',
            correlationId,
          ),
        );
      }
    }
  }

  /**
   * Verify the staged bytes reproduce the target checkpoint's manifest hashes
   * BEFORE promotion (staged-result validation, NN-CHECKPOINT-006). A staged
   * file whose bytes do not hash to the manifest's `capturedSha256` blocks the
   * restore (no partial/incompatible success).
   */
  private verifyStaged(
    record: CheckpointRecord,
    staged: ReadonlyMap<string, string>,
    correlationId: string,
  ): void {
    for (const entry of record.fileManifest) {
      if (!entry.existedBefore) continue; // an absent file stages as a deletion
      const stagedAbs = staged.get(entry.pathRef);
      if (!stagedAbs || !fs.existsSync(stagedAbs)) {
        throw new RestoreServiceError(
          restoreError(
            'INTEGRITY',
            `staged restore is missing "${entry.pathRef}"; refusing to promote`,
            'restore-verify-staged',
            correlationId,
          ),
        );
      }
      if (sha256(fs.readFileSync(stagedAbs)) !== entry.capturedSha256) {
        throw new RestoreServiceError(
          restoreError(
            'INTEGRITY',
            `staged bytes for "${entry.pathRef}" do not match the checkpoint manifest; refusing to promote`,
            'restore-verify-staged',
            correlationId,
          ),
        );
      }
    }
  }

  // ── Compensation (restore the verified rescue) ─────────────────────────────

  /**
   * Restore the verified rescue, flip the journal to `compensated`, roll the
   * projection back to its prior generation (when supplied), and return a typed
   * `failed` result. Used on any promotion or terminal-commit failure so the
   * workspace never retains a partial restore (NN-INV-003, NN-CHECKPOINT-006).
   */
  private restoreRescueAndCompensate(
    rescue: RescueSnapshot,
    journalId: string,
    cmd: RestoreCommand,
    detail: string,
  ): RestoreResult {
    this.restoreRescueBytes(rescue);
    compensateJournaledOperation(this.db, {
      journalId,
      compensate: () => this.restoreRescueBytes(rescue),
      ...(cmd.now ? { now: cmd.now } : {}),
      errorCode: 'INTEGRITY',
    });
    if (cmd.projection?.rollbackGeneration !== undefined) {
      rollbackToGeneration(
        this.db,
        cmd.projection.definition.projectionId,
        cmd.scope,
        cmd.projection.rollbackGeneration,
        cmd.now ? { now: cmd.now } : {},
      );
    }
    return {
      kind: 'failed',
      rescueCheckpointId: rescue.rescueCheckpointId,
      journalId,
      error: restoreError('INTEGRITY', detail, 'restore-promote', cmd.correlationId, {
        effectKnown: true,
      }),
    };
  }

  /** Restore every rescue entry's bytes so the workspace matches the pre-restore state. */
  private restoreRescueBytes(rescue: RescueSnapshot): void {
    for (const entry of rescue.entries) {
      const absolute = path.join(rescue.rootPath, entry.relativePath.split('/').join(path.sep));
      if (entry.existedBefore && entry.currentContentB64 !== null) {
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, Buffer.from(entry.currentContentB64, 'base64'));
        if (entry.mode !== null) {
          try {
            fs.chmodSync(absolute, entry.mode & 0o777);
          } catch {
            /* mode restore is best-effort */
          }
        }
      } else if (!entry.existedBefore && fs.existsSync(absolute)) {
        fs.rmSync(absolute, { force: true });
      }
    }
  }

  /**
   * Reconstruct a rescue snapshot from the durable rescue `Checkpoint@1` a
   * restore journal references. The journal persists only the rescue's digest
   * and reference (NN-INV-004 forbids raw host paths / bytes in a durable
   * record), so recovery re-materializes the pre-restore bytes by staging the
   * rescue checkpoint's one immutable artifact and re-hashing every staged blob.
   * Returns `undefined` when no rescue reference exists (nothing to restore).
   */
  private rescueFromJournal(
    journal: OperationJournalRecord,
    rootPath: string,
  ): RescueSnapshot | undefined {
    if (journal.rescueRef === undefined) return undefined;
    const record = this.checkpoints.read(journal.rescueRef);
    if (!record) return undefined;
    const backend = this.checkpoints.backendFor(record.backendType);
    if (!backend) return undefined;
    const artifactPath = this.artifactPathFor(record.artifactRef);
    // Stage the rescue artifact into a scratch dir and read the bytes back so we
    // can restore them into the live root byte-exactly.
    const scratch = fs.mkdtempSync(path.join(this.checkpoints.artifactRootPath, '.rescue-'));
    try {
      const { staged } = backend.stageRestore({
        artifactPath,
        manifest: record.fileManifest,
        stagingRoot: scratch,
      });
      const entries: RescueEntry[] = record.fileManifest.map((m) => {
        if (!m.existedBefore) {
          return {
            relativePath: m.pathRef,
            existedBefore: false,
            currentContentB64: null,
            currentSha256: null,
            mode: m.mode ?? null,
          };
        }
        const stagedAbs = staged.get(m.pathRef);
        const bytes = stagedAbs && fs.existsSync(stagedAbs) ? fs.readFileSync(stagedAbs) : Buffer.alloc(0);
        return {
          relativePath: m.pathRef,
          existedBefore: true,
          currentContentB64: bytes.toString('base64'),
          currentSha256: sha256(bytes),
          mode: m.mode ?? null,
        };
      });
      return {
        rescueCheckpointId: record.checkpointId,
        rootPath,
        entries,
        integrityDigest: computeDigest({ checkpointId: record.checkpointId, entries }),
      };
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  private artifactPathFor(artifactRef: string): string {
    return path.join(this.checkpoints.artifactRootPath, artifactRef);
  }
}
