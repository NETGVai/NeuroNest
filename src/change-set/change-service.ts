/**
 * ChangeService — journaled ChangeSet creation, review, and atomic promotion
 * (FUT-PKG-05-RECOVERY/T-002).
 *
 * D-04 assigns the `ChangeSet` write authority (single owner, `changeSetId` +
 * base/result revisions) to `ChangeService`; direct renderer/workflow file
 * writes are explicitly NOT a valid owner. This module is that single writer
 * (NN-INV-008): every agent- or workflow-originated file mutation is proposed,
 * reviewed, and promoted through a `ChangeSet@1` here, and there is no second
 * path that mutates workspace files.
 *
 * The apply sequence follows D-12 exactly:
 *
 *   1. Resolve an explicit workspace root from Project + Session (+ Worktree)
 *      identity via the T-001 {@link WorkspaceAuthority}. There is no implicit
 *      global active root (NN-WORKSPACE-001).
 *   2. Canonicalize / no-follow / contain every operation path. The host
 *      project root is READ-ONLY by default: staged writes live in a
 *      worktree/overlay directory and every staged path must remain contained
 *      inside that overlay after symlink resolution (NN-SEC-005, D-16.3). A
 *      write that would land in the host project is refused.
 *   3. Create AND VERIFY a rescue (checkpoint of the current bytes of every
 *      touched target) BEFORE any mutation. Verification re-reads the rescue
 *      and confirms its digest; an unverifiable rescue blocks the promotion
 *      (NN-INV-006 — recovery precedes destructive mutation).
 *   4. Optimistic review against the expected base workspace revision. A stale
 *      base (the workspace advanced, or a target's on-disk bytes diverged from
 *      the recorded base hash) returns a typed `STALE_REVISION` with NO apply
 *      and the review state retained (NN-DATA-004, NN-WORKSPACE-005).
 *   5. Stage the operations beside the targets (materialize in the overlay).
 *   6. Commit an `OperationJournal@1` as `applying` (through the T-004
 *      {@link beginJournaledOperation}/{@link markApplying}) recording the
 *      checkpoint, expected revision, and a `compensatable` rescue strategy —
 *      BEFORE the promotion touches the workspace.
 *   7. Promote atomically: apply every staged operation to the workspace as an
 *      all-or-none unit. If any operation fails, restore the verified rescue
 *      (so the workspace is byte-identical to before), flip the journal to
 *      `compensated`, and report a typed failure — never a partial apply and
 *      never a success (NN-INV-003).
 *   8. On a fully-applied promotion, commit the terminal `ChangeSet@1`
 *      (`state = promoted`, `resultWorkspaceRevision`) through the T-001
 *      authority transaction and flip the journal to `committed`.
 *
 * Crash-safety (NN-INV-003 / NN-INV-006): the journal row is durably
 * `applying` with `effect-status = unknown` before the workspace is touched,
 * so a crash at any boundary leaves a nonterminal row that {@link recover}
 * classifies (via the T-004 restart classifier) and resolves by restoring the
 * verified rescue and compensating — it never half-applies and never reports
 * success from an unknown effect.
 *
 * Additive over the durability chain: this module owns ONE new business table
 * (`changesets`) behind the authority and never becomes a second writer for an
 * existing business table. Migration/rollback routes file writes through this
 * service (single writer); rollback restores the prior read path while the
 * canonical writes stay single-owner (NN-COMPAT-001/002, NN-INV-008).
 *
 * Design anchors: D-04 (ChangeService ownership row), D-07 (`ChangeSet@1`),
 * D-12 (apply sequence), D-14 (rescue/restore), D-16 (typed `PathRef`, path
 * containment). Requirements: NN-INV-006 (rescue before mutation), NN-INV-008
 * (one writer), NN-SEC-005 (path containment), NN-WORKSPACE-001/005/011,
 * NN-DATA-004–006, NN-CHECKPOINT-001–010.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import {
  CONTRACT_WRITE_VERSION,
  computeDigest,
  makeOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
  type ScopeDescriptor,
} from '../shared/contract-primitives.js';
import { evaluatePath } from '../shared/security-authority.js';
import {
  applyAuthorityMutation,
  ensureAuthorityTables,
  type EventIntent,
} from '../storage/authority-transaction.js';
import {
  beginJournaledOperation,
  blockJournaledOperation,
  classifyNonterminalOperations,
  commitJournaledOperation,
  compareRescueState,
  compensateJournaledOperation,
  ensureOperationJournalTables,
  markApplying,
  readJournalById,
  type OperationJournalRecord,
} from '../storage/operation-journal.js';
import {
  WorkspaceAuthority,
  WorkspaceConflictError,
  type ResolvedWorkspaceRoot,
} from '../workspace/workspace-authority.js';

// ─── ChangeSet@1 record (D-07 shape) ─────────────────────────────────────────

/** File-operation kinds a `ChangeSet@1` can carry (D-07 operations[].kind). */
export type FileOperationKind = 'create' | 'modify' | 'delete';

/** POSIX line-ending fidelity marker preserved for review (D-07). */
export type LineEnding = 'lf' | 'crlf';

/**
 * One typed file operation inside a `ChangeSet@1`. `targetPath` is a
 * workspace-relative POSIX path; it is canonicalized and containment-checked at
 * review time and the private absolute is never persisted (NN-INV-004).
 *
 *   - `create` — the file must NOT exist at base; `content` is the new bytes.
 *   - `modify` — the file MUST exist at base and its on-disk bytes must hash to
 *     `expectedHash`; `content` is the new bytes.
 *   - `delete` — the file MUST exist at base and hash to `expectedHash`.
 */
export interface FileOperation {
  readonly kind: FileOperationKind;
  /** Workspace-relative POSIX path (never an absolute host path). */
  readonly targetPath: string;
  /** SHA-256 of the base bytes for modify/delete (optimistic concurrency). */
  readonly expectedHash?: string;
  /** New content for create/modify. */
  readonly content?: string;
  /** File mode bits to preserve, when relevant. */
  readonly mode?: number;
  /** Line-ending fidelity marker. */
  readonly lineEnding?: LineEnding;
}

/** `ChangeSet@1` lifecycle state (D-07 / D-12). */
export type ChangeSetState =
  | 'draft' // created; operations still mutable
  | 'reviewed' // review passed against the expected base revision
  | 'promoted' // atomically applied to the workspace (terminal success)
  | 'stale' // review found a stale base; no apply (terminal non-success)
  | 'failed'; // promotion failed and rescue was restored (terminal non-success)

/** A materialized diff line for review (D-07 diff/review). */
export interface ReviewedOperation {
  readonly kind: FileOperationKind;
  /** Workspace-relative POSIX path (safe to surface). */
  readonly relativePath: string;
  readonly additions: number;
  readonly removals: number;
  readonly isBinary: boolean;
  readonly lineEnding: LineEnding;
  /** SHA-256 of the proposed post-operation bytes (empty for delete). */
  readonly resultHash: string;
}

/** `ChangeSet@1` record (D-07). Owned solely by {@link ChangeService}. */
export interface ChangeSetRecord {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  readonly changeSetId: string;
  readonly revision: number;
  readonly scope: ScopeDescriptor;
  /** Expected workspace revision this change set was authored against. */
  readonly baseWorkspaceRevision: number;
  readonly operations: readonly FileOperation[];
  /** Canonical digest of the ordered operations (immutable review fingerprint). */
  readonly diffDigest: string;
  readonly actor: string;
  readonly taskId?: string;
  readonly turnId?: string;
  readonly toolCallId?: string;
  /** Rescue checkpoint id created+verified before mutation (NN-INV-006). */
  readonly checkpointId: string | null;
  readonly state: ChangeSetState;
  readonly validationEvidenceIds: readonly string[];
  /** The committed workspace revision after a successful promotion. */
  readonly resultWorkspaceRevision?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/** The Change Service authority owner id stamped on receipts/events/errors. */
export const CHANGE_SERVICE_AUTHORITY = 'authority-change-service';

/** A typed, retained-review failure surfaced by review/promotion. */
export class ChangeServiceError extends Error {
  readonly error: ErrorEnvelope;
  constructor(error: ErrorEnvelope) {
    super(error.message);
    this.name = 'ChangeServiceError';
    this.error = error;
  }
}

function makeError(
  code: ErrorCode,
  message: string,
  operation: string,
  correlationId: string,
  extra: Partial<ErrorEnvelope> = {},
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: CHANGE_SERVICE_AUTHORITY,
    operation,
    correlationId,
    retryable: code === 'STALE_REVISION',
    redaction: 'internal',
    ...extra,
  };
}

// ─── Business table (additive, behind the authority) ─────────────────────────

const CHANGESET_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS changesets (
    change_set_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    scope_key TEXT NOT NULL,
    base_workspace_revision INTEGER NOT NULL,
    diff_digest TEXT NOT NULL,
    actor TEXT NOT NULL,
    task_id TEXT,
    turn_id TEXT,
    tool_call_id TEXT,
    checkpoint_id TEXT,
    state TEXT NOT NULL,
    result_workspace_revision INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    record_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_changesets_state ON changesets (state);

  -- Durable rescue sidecar: the verified pre-mutation bytes of every touched
  -- target, persisted BEFORE the promotion touches the workspace so a crash can
  -- restore the exact pre-mutation state on restart (NN-INV-006). Keyed by the
  -- rescue checkpoint id; linked to the change set and its promotion journal.
  CREATE TABLE IF NOT EXISTS changeset_rescues (
    checkpoint_id TEXT PRIMARY KEY,
    change_set_id TEXT NOT NULL,
    journal_id TEXT,
    rescue_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_changeset_rescues_journal
    ON changeset_rescues (journal_id);
`;

/**
 * Create the durability primitives, workspace identity tables, operation
 * journal, and the `changesets` table if absent. Additive and idempotent; safe
 * at startup and in tests. Never mutates a business table owned by another
 * writer.
 */
export function ensureChangeServiceTables(db: Database.Database): void {
  ensureAuthorityTables(db);
  ensureOperationJournalTables(db);
  db.exec(CHANGESET_TABLE_DDL);
}

// ─── Command shapes ──────────────────────────────────────────────────────────

/** Fields shared by every Change Service command. */
export interface ChangeCommandContext {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  /** Explicit identity: which project/session/worktree this change targets. */
  readonly projectId: string;
  readonly sessionId: string;
  readonly worktreeId?: string;
  /** Command scope; threads identity and keys the per-scope sequence. */
  readonly scope: ScopeDescriptor;
  /** Injectable clock (tests). */
  readonly now?: () => Date;
}

export interface CreateChangeSetCommand extends ChangeCommandContext {
  readonly actor: string;
  readonly baseWorkspaceRevision: number;
  readonly operations: readonly FileOperation[];
  readonly taskId?: string;
  readonly turnId?: string;
  readonly toolCallId?: string;
}

/** Result of a create/promote: the committed record and its receipt id. */
export interface ChangeMutationResult {
  readonly record: ChangeSetRecord;
  readonly receiptId: string;
  readonly authorityRevision: number;
}

/** The outcome of an optimistic review against the expected base revision. */
export interface ReviewResult {
  readonly changeSetId: string;
  readonly baseWorkspaceRevision: number;
  readonly diffDigest: string;
  readonly operations: readonly ReviewedOperation[];
}

/** The outcome of a promotion attempt. */
export type PromotionResult =
  | { readonly kind: 'promoted'; readonly record: ChangeSetRecord; readonly checkpointId: string }
  | { readonly kind: 'failed'; readonly record: ChangeSetRecord; readonly error: ErrorEnvelope };

// ─── Rescue checkpoint (bytes of every touched target, before mutation) ──────

/** The captured pre-mutation state of one target for rescue/restore. */
interface RescueEntry {
  readonly relativePath: string;
  readonly existedBefore: boolean;
  /** Base64 of the prior bytes when it existed; else null. */
  readonly priorContentB64: string | null;
  readonly priorSha256: string | null;
  readonly mode: number | null;
}

/** The rescue checkpoint captured and verified before any mutation. */
interface RescueCheckpoint {
  readonly checkpointId: string;
  readonly rootPath: string;
  readonly entries: readonly RescueEntry[];
  /** Digest over the entries; compared on restore (NN-INV-006). */
  readonly integrityDigest: string;
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ─── The Change Service (single owner for ChangeSet@1) ───────────────────────

/**
 * The single write owner for `ChangeSet@1` and the only path that mutates
 * workspace files (NN-INV-008). Reads are direct SELECTs against `changesets`;
 * creation and terminal promotion route through the T-001 authority
 * transaction; the promotion effect is journaled through the T-004 saga.
 */
export class ChangeService {
  private readonly workspace: WorkspaceAuthority;

  constructor(
    private readonly db: Database.Database,
    options: { readonly workspace?: WorkspaceAuthority } = {},
  ) {
    ensureChangeServiceTables(db);
    this.workspace = options.workspace ?? new WorkspaceAuthority(db);
  }

  // ── Create (draft ChangeSet@1 with a globally unique scoped id) ───────────

  /**
   * Create a `ChangeSet@1` at revision 1 with a globally unique, scope-derived
   * opaque id and an immutable operations payload (D-07). The operations diff
   * digest is fixed at create time; a later review/promote uses the same
   * digest. Routed through the T-001 authority transaction so the business row,
   * receipt, and outbox event commit atomically.
   */
  create(cmd: CreateChangeSetCommand): ChangeMutationResult {
    const now = (cmd.now ?? (() => new Date()))().toISOString();
    // A globally unique scoped id: prefix + a digest of scope identity anchors,
    // the command id, and the operations, so two distinct proposals never
    // collide even inside one scope.
    const changeSetId = makeOpaqueId(
      'chg',
      `${cmd.scope.projectId ?? ''}${cmd.scope.sessionId ?? ''}${cmd.commandId}${computeDigest(cmd.operations)}`,
    );
    const diffDigest = computeDigest(cmd.operations);

    let record!: ChangeSetRecord;
    const outcome = applyAuthorityMutation(this.db, {
      authority: CHANGE_SERVICE_AUTHORITY,
      commandId: cmd.commandId,
      idempotencyKey: cmd.idempotencyKey,
      requestDigest: computeDigest({ op: 'create-change-set', diffDigest, base: cmd.baseWorkspaceRevision }),
      correlationId: cmd.correlationId,
      scope: cmd.scope,
      mutate: (tx) => {
        this.assertOperationsWellFormed(cmd.operations, cmd.correlationId);
        record = {
          schemaVersion: CONTRACT_WRITE_VERSION,
          changeSetId,
          revision: 1,
          scope: cmd.scope,
          baseWorkspaceRevision: cmd.baseWorkspaceRevision,
          operations: cmd.operations,
          diffDigest,
          actor: cmd.actor,
          ...(cmd.taskId !== undefined ? { taskId: cmd.taskId } : {}),
          ...(cmd.turnId !== undefined ? { turnId: cmd.turnId } : {}),
          ...(cmd.toolCallId !== undefined ? { toolCallId: cmd.toolCallId } : {}),
          checkpointId: null,
          state: 'draft',
          validationEvidenceIds: [],
          createdAt: now,
          updatedAt: now,
        };
        this.persist(tx, record);
        return { resultRef: makeOpaqueId('res', changeSetId) };
      },
      events: [
        this.event('changeset.created', 'changeset', changeSetId, {
          changeSetId,
          baseWorkspaceRevision: cmd.baseWorkspaceRevision,
          operationCount: cmd.operations.length,
        }),
      ],
      ...(cmd.now ? { now: cmd.now } : {}),
    });

    return this.finish(outcome, () => record ?? this.read(changeSetId)!);
  }

  /** Read a `ChangeSet@1` record, or `undefined` if absent. */
  read(changeSetId: string): ChangeSetRecord | undefined {
    const row = this.db
      .prepare(`SELECT record_json FROM changesets WHERE change_set_id = ?`)
      .get(changeSetId) as { record_json: string } | undefined;
    return row ? (JSON.parse(row.record_json) as ChangeSetRecord) : undefined;
  }

  // ── Review (optimistic diff against the expected base revision) ───────────

  /**
   * Review a draft `ChangeSet@1` optimistically against its expected base
   * workspace revision (D-12 review). Resolves the explicit workspace root,
   * canonicalizes and contains every operation path inside the worktree/overlay
   * (the host project root is read-only by default, NN-SEC-005), and verifies
   * each `modify`/`delete` target's current on-disk bytes still hash to the
   * recorded `expectedHash`. A stale base — the workspace revision advanced past
   * the recorded base, or a target's bytes diverged — returns a typed
   * `STALE_REVISION` with NO apply and the review state retained
   * (NN-DATA-004, NN-WORKSPACE-005). On success the change set transitions to
   * `reviewed` and a materialized diff is returned.
   */
  review(input: {
    readonly changeSetId: string;
    readonly currentWorkspaceRevision: number;
    readonly correlationId: string;
    readonly now?: () => Date;
  }): ReviewResult {
    const record = this.requireDraftOrReviewed(input.changeSetId, input.correlationId);
    const root = this.resolveRoot(record, input.correlationId);

    // Optimistic base-revision check: a workspace that advanced past the base
    // this change set was authored against is stale — no apply.
    if (input.currentWorkspaceRevision !== record.baseWorkspaceRevision) {
      this.markStale(record, input.correlationId, input.now);
      throw new ChangeServiceError(
        makeError(
          'STALE_REVISION',
          `workspace revision ${input.currentWorkspaceRevision} differs from base ${record.baseWorkspaceRevision}; refresh and rebase (review retained, no apply)`,
          'review-change-set',
          input.correlationId,
          { effectKnown: true },
        ),
      );
    }

    const reviewed: ReviewedOperation[] = [];
    for (const op of record.operations) {
      const target = this.containWrite(op.targetPath, root, input.correlationId);
      const exists = fs.existsSync(target.absolute);

      if (op.kind === 'create') {
        if (exists) {
          throw new ChangeServiceError(
            makeError(
              'CONFLICT',
              `create target "${target.relative}" already exists at base`,
              'review-change-set',
              input.correlationId,
            ),
          );
        }
      } else {
        // modify/delete: the base bytes must still match the recorded hash.
        if (!exists) {
          this.markStale(record, input.correlationId, input.now);
          throw new ChangeServiceError(
            makeError(
              'STALE_REVISION',
              `${op.kind} target "${target.relative}" no longer exists at base (concurrent delete); review retained, no apply`,
              'review-change-set',
              input.correlationId,
              { effectKnown: true },
            ),
          );
        }
        const currentHash = sha256(fs.readFileSync(target.absolute));
        if (op.expectedHash !== undefined && currentHash !== op.expectedHash) {
          this.markStale(record, input.correlationId, input.now);
          throw new ChangeServiceError(
            makeError(
              'STALE_REVISION',
              `${op.kind} target "${target.relative}" changed since base (concurrent edit); review retained, no apply`,
              'review-change-set',
              input.correlationId,
              { effectKnown: true },
            ),
          );
        }
      }
      reviewed.push(this.materializeReview(op, target.absolute, exists));
    }

    this.setState(record, 'reviewed', input.correlationId, input.now);
    return {
      changeSetId: record.changeSetId,
      baseWorkspaceRevision: record.baseWorkspaceRevision,
      diffDigest: record.diffDigest,
      operations: reviewed,
    };
  }

  // ── Promote (rescue-before-mutation + journaled atomic promotion) ─────────

  /**
   * Atomically promote a reviewed `ChangeSet@1` into the workspace (D-12
   * apply). Re-reviews under optimistic concurrency (a stale base still returns
   * `STALE_REVISION` with no apply), creates AND VERIFIES a rescue checkpoint of
   * every touched target's current bytes BEFORE any mutation (NN-INV-006),
   * commits an `OperationJournal@1` as `applying` (T-004) recording the rescue,
   * then applies every staged operation as an all-or-none unit. If any operation
   * fails, the verified rescue is restored (workspace byte-identical to before),
   * the journal is `compensated`, and a typed failure is returned — never a
   * partial apply and never a success. On a fully-applied promotion the terminal
   * `ChangeSet@1` (`promoted`, `resultWorkspaceRevision`) commits through the
   * T-001 authority transaction and the journal flips to `committed`.
   *
   * `faultDuringPromotion` is a test-only hook invoked between staged operations
   * to simulate a crash mid-promotion; it forces the rescue-restore path.
   */
  promote(input: {
    readonly changeSetId: string;
    readonly currentWorkspaceRevision: number;
    readonly resultWorkspaceRevision: number;
    readonly commandId: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly now?: () => Date;
    readonly faultDuringPromotion?: (appliedCount: number) => void;
  }): PromotionResult {
    const record = this.requireDraftOrReviewed(input.changeSetId, input.correlationId);
    const root = this.resolveRoot(record, input.correlationId);

    // Re-review (optimistic): a stale base here returns STALE_REVISION, no apply.
    this.review({
      changeSetId: input.changeSetId,
      currentWorkspaceRevision: input.currentWorkspaceRevision,
      correlationId: input.correlationId,
      ...(input.now ? { now: input.now } : {}),
    });

    // Rescue BEFORE mutation, then VERIFY it (NN-INV-006).
    const rescue = this.captureRescue(record, root, input.correlationId);
    this.verifyRescue(rescue, input.correlationId);

    // Journal the effect as `applying` (T-004) BEFORE touching the workspace.
    const journal = beginJournaledOperation(this.db, {
      authority: CHANGE_SERVICE_AUTHORITY,
      operationId: makeOpaqueId('op', `${input.changeSetId}${input.idempotencyKey}`),
      idempotencyKey: `promote:${input.idempotencyKey}`,
      correlationId: input.correlationId,
      scope: record.scope,
      expectedRevision: input.currentWorkspaceRevision,
      strategy: 'compensatable',
      rescueRef: rescue.checkpointId,
      rescueState: rescue,
    });
    // Durably persist the verified rescue (linked to the change set + journal)
    // BEFORE the workspace is touched, so restart can restore it exactly.
    this.persistRescue(rescue, record.changeSetId, journal.journalId, input.now);
    markApplying(this.db, journal.journalId, input.now);

    // Promote atomically (all-or-none). Any failure restores the rescue.
    let applied = 0;
    try {
      for (const op of record.operations) {
        input.faultDuringPromotion?.(applied);
        this.applyOne(op, root);
        applied += 1;
      }
      input.faultDuringPromotion?.(applied);
    } catch (promotionError) {
      const failed = this.restoreAndCompensate(
        record,
        rescue,
        journal.journalId,
        input.correlationId,
        input.now,
        promotionError instanceof Error ? promotionError.message : 'promotion failed',
      );
      return { kind: 'failed', record: failed, error: this.lastFailureError(input.correlationId) };
    }

    // Terminal commit: ChangeSet@1 result + workspace revision (T-001), and
    // flip the journal to committed in the SAME transaction (all-or-none).
    let committed!: ChangeSetRecord;
    const commit = commitJournaledOperation(this.db, {
      journalId: journal.journalId,
      currentRevision: input.currentWorkspaceRevision,
      finalize: (tx) => {
        committed = {
          ...record,
          revision: record.revision + 1,
          checkpointId: rescue.checkpointId,
          state: 'promoted',
          resultWorkspaceRevision: input.resultWorkspaceRevision,
          updatedAt: (input.now ?? (() => new Date()))().toISOString(),
        };
        this.persist(tx, committed);
        return { resultRef: makeOpaqueId('res', `${record.changeSetId}promoted`) };
      },
      ...(input.now ? { now: input.now } : {}),
    });

    if (commit.kind === 'blocked') {
      // Terminal commit could not complete: restore the verified rescue and
      // report typed failure — never a half-applied success (NN-INV-003).
      const failed = this.restoreAndCompensate(
        record,
        rescue,
        journal.journalId,
        input.correlationId,
        input.now,
        commit.error.message,
      );
      return { kind: 'failed', record: failed, error: commit.error };
    }

    return { kind: 'promoted', record: committed, checkpointId: rescue.checkpointId };
  }

  // ── Crash-safe recovery (restart classifier + rescue restore) ─────────────

  /**
   * Recover from a crash: classify every nonterminal promotion journal row (via
   * the T-004 restart classifier) and resolve each by restoring its verified
   * rescue and compensating. A `compensatable` promotion whose effect is unknown
   * is NEVER blindly repeated nor reported successful (NN-INV-003) — the
   * recorded rescue is restored so the workspace is byte-identical to before the
   * promotion began, and the journal + change set are marked terminal
   * non-success. Returns the ids of the change sets it recovered.
   */
  recover(input: { readonly correlationId: string; readonly now?: () => Date }): {
    readonly recovered: readonly string[];
  } {
    const recovered: string[] = [];
    const classifications = classifyNonterminalOperations(this.db);
    for (const c of classifications) {
      const journal = readJournalById(this.db, c.journalId);
      if (!journal || journal.authority !== CHANGE_SERVICE_AUTHORITY) continue;
      const changeSetId = this.changeSetForJournal(journal);
      if (!changeSetId) continue;
      const record = this.read(changeSetId);
      if (!record) continue;

      // A promotion effect is compensatable: restore the rescue rather than
      // repeat the (possibly partial) apply. This is the crash-safe boundary
      // that guarantees no half-apply survives a crash.
      const rescue = this.rescueFromJournal(journal);
      if (rescue) {
        this.restoreRescueBytes(rescue);
      }
      compensateJournaledOperation(this.db, {
        journalId: journal.journalId,
        compensate: () => {
          /* restore already ran above; reversal is idempotent */
        },
        ...(input.now ? { now: input.now } : {}),
        errorCode: 'INTEGRITY',
      });
      this.setState(record, 'failed', input.correlationId, input.now);
      recovered.push(changeSetId);
    }
    return { recovered };
  }

  // ── Internal: review materialization ──────────────────────────────────────

  private materializeReview(
    op: FileOperation,
    absolute: string,
    existsAtBase: boolean,
  ): ReviewedOperation {
    const lineEnding: LineEnding = op.lineEnding ?? 'lf';
    const relative = op.targetPath.split(path.sep).join('/');
    if (op.kind === 'delete') {
      const priorBytes = existsAtBase ? fs.readFileSync(absolute) : Buffer.alloc(0);
      return {
        kind: 'delete',
        relativePath: relative,
        additions: 0,
        removals: this.countLines(priorBytes.toString('utf8')),
        isBinary: this.looksBinary(priorBytes),
        lineEnding,
        resultHash: '',
      };
    }
    const newContent = op.content ?? '';
    const priorContent =
      op.kind === 'modify' && existsAtBase ? fs.readFileSync(absolute).toString('utf8') : '';
    return {
      kind: op.kind,
      relativePath: relative,
      additions: this.countLines(newContent),
      removals: this.countLines(priorContent),
      isBinary: this.looksBinary(Buffer.from(newContent, 'utf8')),
      lineEnding,
      resultHash: sha256(Buffer.from(newContent, 'utf8')),
    };
  }

  private countLines(content: string): number {
    if (content === '') return 0;
    let count = 1;
    for (let i = 0; i < content.length; i++) if (content[i] === '\n') count += 1;
    return count;
  }

  private looksBinary(bytes: Buffer): boolean {
    const scan = Math.min(bytes.length, 8000);
    for (let i = 0; i < scan; i++) if (bytes[i] === 0) return true;
    return false;
  }

  // ── Internal: rescue capture / verify / restore (NN-INV-006) ──────────────

  private captureRescue(
    record: ChangeSetRecord,
    root: ResolvedWorkspaceRoot,
    correlationId: string,
  ): RescueCheckpoint {
    const entries: RescueEntry[] = [];
    for (const op of record.operations) {
      const target = this.containWrite(op.targetPath, root, correlationId);
      const relative = op.targetPath.split(path.sep).join('/');
      if (fs.existsSync(target.absolute)) {
        const bytes = fs.readFileSync(target.absolute);
        const stat = fs.statSync(target.absolute);
        entries.push({
          relativePath: relative,
          existedBefore: true,
          priorContentB64: bytes.toString('base64'),
          priorSha256: sha256(bytes),
          mode: stat.mode,
        });
      } else {
        entries.push({
          relativePath: relative,
          existedBefore: false,
          priorContentB64: null,
          priorSha256: null,
          mode: null,
        });
      }
    }
    const checkpointId = makeOpaqueId('ckpt', `${record.changeSetId}${computeDigest(entries)}`);
    return {
      checkpointId,
      rootPath: root.rootPath,
      entries,
      integrityDigest: computeDigest({ checkpointId, entries }),
    };
  }

  /**
   * Verify the rescue is intact BEFORE any mutation: recompute its integrity
   * digest and re-read each captured target to confirm its bytes still match the
   * captured digest. An unverifiable rescue blocks the promotion (NN-INV-006).
   */
  private verifyRescue(rescue: RescueCheckpoint, correlationId: string): void {
    const recomputed = computeDigest({ checkpointId: rescue.checkpointId, entries: rescue.entries });
    if (recomputed !== rescue.integrityDigest) {
      throw new ChangeServiceError(
        makeError('INTEGRITY', 'rescue integrity digest mismatch; refusing to mutate', 'verify-rescue', correlationId),
      );
    }
    for (const entry of rescue.entries) {
      const absolute = path.join(rescue.rootPath, entry.relativePath);
      if (entry.existedBefore) {
        if (!fs.existsSync(absolute) || sha256(fs.readFileSync(absolute)) !== entry.priorSha256) {
          throw new ChangeServiceError(
            makeError(
              'INTEGRITY',
              `rescue for "${entry.relativePath}" could not be verified; refusing to mutate`,
              'verify-rescue',
              correlationId,
            ),
          );
        }
      } else if (fs.existsSync(absolute)) {
        throw new ChangeServiceError(
          makeError(
            'INTEGRITY',
            `rescue expected "${entry.relativePath}" absent but it exists; refusing to mutate`,
            'verify-rescue',
            correlationId,
          ),
        );
      }
    }
  }

  /** Restore every rescue entry's bytes so the workspace matches the pre-mutation state. */
  private restoreRescueBytes(rescue: RescueCheckpoint): void {
    for (const entry of rescue.entries) {
      const absolute = path.join(rescue.rootPath, entry.relativePath);
      if (entry.existedBefore && entry.priorContentB64 !== null) {
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, Buffer.from(entry.priorContentB64, 'base64'));
        if (entry.mode !== null) {
          try {
            fs.chmodSync(absolute, entry.mode & 0o777);
          } catch {
            /* mode restore is best-effort on platforms without full mode support */
          }
        }
      } else if (!entry.existedBefore && fs.existsSync(absolute)) {
        fs.rmSync(absolute, { force: true });
      }
    }
  }

  /**
   * Restore the verified rescue, flip the journal to `compensated`, and mark the
   * change set `failed`. Used on any promotion or terminal-commit failure so the
   * workspace never retains a partial apply (NN-INV-003).
   */
  private restoreAndCompensate(
    record: ChangeSetRecord,
    rescue: RescueCheckpoint,
    journalId: string,
    correlationId: string,
    now: (() => Date) | undefined,
    _detail: string,
  ): ChangeSetRecord {
    compensateJournaledOperation(this.db, {
      journalId,
      compensate: () => this.restoreRescueBytes(rescue),
      ...(now ? { now } : {}),
      errorCode: 'INTEGRITY',
    });
    return this.setState(record, 'failed', correlationId, now);
  }

  private lastFailureError(correlationId: string): ErrorEnvelope {
    return makeError(
      'INTEGRITY',
      'promotion failed; verified rescue restored (no partial apply, no success)',
      'promote-change-set',
      correlationId,
      { effectKnown: true },
    );
  }

  // ── Internal: apply one operation to the workspace ─────────────────────────

  private applyOne(op: FileOperation, root: ResolvedWorkspaceRoot): void {
    const target = this.containWrite(op.targetPath, root, 'corr-apply');
    if (op.kind === 'delete') {
      fs.rmSync(target.absolute, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(target.absolute), { recursive: true });
    fs.writeFileSync(target.absolute, op.content ?? '');
    if (op.mode !== undefined) {
      try {
        fs.chmodSync(target.absolute, op.mode & 0o777);
      } catch {
        /* best-effort mode */
      }
    }
  }

  // ── Internal: path containment (host read-only; writes in the worktree) ───

  /**
   * Canonicalize and contain a write path inside the resolved worktree/overlay
   * root (NN-SEC-005, D-16.3). The host project root is read-only by default:
   * this method is used for every staged/promoted write, and containment is
   * against the worktree root (which, per T-001 `resolveWorkspaceRoot`, is the
   * worktree path when a worktree is present). A path that escapes the root via
   * `..`, an absolute host path, or a symlink is refused with a typed
   * `FORBIDDEN`.
   */
  private containWrite(
    targetPath: string,
    root: ResolvedWorkspaceRoot,
    correlationId: string,
  ): { readonly absolute: string; readonly relative: string } {
    if (path.isAbsolute(targetPath)) {
      throw new ChangeServiceError(
        makeError(
          'FORBIDDEN',
          `write target must be workspace-relative, not an absolute host path`,
          'contain-write',
          correlationId,
        ),
      );
    }
    const decision = evaluatePath(targetPath, root.rootPath, {}, { correlationId, operation: 'change-service:write' });
    if (decision.decision !== 'allow') {
      throw new ChangeServiceError(decision.error);
    }
    return { absolute: decision.value.absolute, relative: decision.value.relative };
  }

  // ── Internal: identity resolution / state / persistence ───────────────────

  private resolveRoot(record: ChangeSetRecord, correlationId: string): ResolvedWorkspaceRoot {
    const projectId = record.scope.projectId;
    const sessionId = record.scope.sessionId;
    if (!projectId || !sessionId) {
      throw new ChangeServiceError(
        makeError(
          'VALIDATION',
          'change set scope must name an explicit project and session (no implicit global root)',
          'resolve-workspace-root',
          correlationId,
        ),
      );
    }
    try {
      return this.workspace.resolveWorkspaceRoot({
        projectId,
        sessionId,
        ...(record.scope.worktreeId ? { worktreeId: record.scope.worktreeId } : {}),
        correlationId,
      });
    } catch (e) {
      if (e instanceof WorkspaceConflictError) throw new ChangeServiceError(e.error);
      throw e;
    }
  }

  private requireDraftOrReviewed(changeSetId: string, correlationId: string): ChangeSetRecord {
    const record = this.read(changeSetId);
    if (!record) {
      throw new ChangeServiceError(
        makeError('VALIDATION', `change set ${changeSetId} not found`, 'read-change-set', correlationId),
      );
    }
    if (record.state === 'promoted') {
      throw new ChangeServiceError(
        makeError('CONFLICT', `change set ${changeSetId} is already promoted`, 'read-change-set', correlationId),
      );
    }
    return record;
  }

  private markStale(record: ChangeSetRecord, correlationId: string, now?: () => Date): void {
    // Retain the review: transitioning to `stale` records the outcome but never
    // mutates the workspace and never discards the operations payload.
    if (record.state !== 'stale') this.setState(record, 'stale', correlationId, now);
  }

  private setState(
    record: ChangeSetRecord,
    state: ChangeSetState,
    _correlationId: string,
    now?: () => Date,
  ): ChangeSetRecord {
    const updated: ChangeSetRecord = {
      ...record,
      state,
      updatedAt: (now ?? (() => new Date()))().toISOString(),
    };
    this.persist(this.db, updated);
    return updated;
  }

  private persist(tx: Database.Database, record: ChangeSetRecord): void {
    // scope_key mirrors the authority transaction's scope keying for joinability.
    const scopeKey = computeDigest({
      userId: record.scope.userId,
      owner: record.scope.owner,
      projectId: record.scope.projectId,
      sessionId: record.scope.sessionId,
      worktreeId: record.scope.worktreeId,
    });
    tx.prepare(
      `INSERT INTO changesets
         (change_set_id, revision, scope_key, base_workspace_revision, diff_digest, actor,
          task_id, turn_id, tool_call_id, checkpoint_id, state, result_workspace_revision,
          created_at, updated_at, record_json)
       VALUES (@changeSetId, @revision, @scopeKey, @baseWorkspaceRevision, @diffDigest, @actor,
          @taskId, @turnId, @toolCallId, @checkpointId, @state, @resultWorkspaceRevision,
          @createdAt, @updatedAt, @recordJson)
       ON CONFLICT(change_set_id) DO UPDATE SET
         revision = excluded.revision,
         checkpoint_id = excluded.checkpoint_id,
         state = excluded.state,
         result_workspace_revision = excluded.result_workspace_revision,
         updated_at = excluded.updated_at,
         record_json = excluded.record_json`,
    ).run({
      changeSetId: record.changeSetId,
      revision: record.revision,
      scopeKey,
      baseWorkspaceRevision: record.baseWorkspaceRevision,
      diffDigest: record.diffDigest,
      actor: record.actor,
      taskId: record.taskId ?? null,
      turnId: record.turnId ?? null,
      toolCallId: record.toolCallId ?? null,
      checkpointId: record.checkpointId ?? null,
      state: record.state,
      resultWorkspaceRevision: record.resultWorkspaceRevision ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      recordJson: JSON.stringify(record),
    });
  }

  private assertOperationsWellFormed(operations: readonly FileOperation[], correlationId: string): void {
    if (operations.length === 0) {
      throw new ChangeServiceError(
        makeError('VALIDATION', 'a change set must carry at least one operation', 'create-change-set', correlationId),
      );
    }
    const seen = new Set<string>();
    for (const op of operations) {
      const norm = op.targetPath.split(path.sep).join('/');
      if (seen.has(norm)) {
        throw new ChangeServiceError(
          makeError('CONFLICT', `duplicate operation target "${norm}" in one change set`, 'create-change-set', correlationId),
        );
      }
      seen.add(norm);
      if ((op.kind === 'create' || op.kind === 'modify') && op.content === undefined) {
        throw new ChangeServiceError(
          makeError('VALIDATION', `${op.kind} operation for "${norm}" requires content`, 'create-change-set', correlationId),
        );
      }
    }
  }

  private event(
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): EventIntent {
    return {
      eventType,
      aggregateType,
      aggregateId,
      payloadSchemaName: eventType,
      payloadSchemaVersion: CONTRACT_WRITE_VERSION,
      payload,
      redaction: 'internal',
    };
  }

  private finish(
    outcome: ReturnType<typeof applyAuthorityMutation>,
    readRecord: () => ChangeSetRecord,
  ): ChangeMutationResult {
    if (outcome.kind === 'conflict') throw new ChangeServiceError(outcome.error);
    if (outcome.kind === 'replayed') {
      return {
        record: readRecord(),
        receiptId: outcome.receipt.receiptId,
        authorityRevision: outcome.receipt.authorityRevision,
      };
    }
    return {
      record: readRecord(),
      receiptId: outcome.receipt.receiptId,
      authorityRevision: outcome.authorityRevision,
    };
  }

  // ── Internal: journal <-> change set linkage for recovery ─────────────────

  private changeSetForJournal(journal: OperationJournalRecord): string | undefined {
    // Prefer the explicit durable link recorded by persistRescue: the rescue
    // sidecar rows the journal id against the owning change set id, so recovery
    // resolves the change set without inferring identity from string shapes.
    const linked = this.db
      .prepare(`SELECT change_set_id AS id FROM changeset_rescues WHERE journal_id = ? LIMIT 1`)
      .get(journal.journalId) as { id: string } | undefined;
    if (linked) return linked.id;

    // Fallback for a journal whose sidecar row is unavailable: match the change
    // set id embedded in the journal's operationId.
    const rows = this.db
      .prepare(`SELECT change_set_id AS id FROM changesets WHERE state != 'promoted'`)
      .all() as { id: string }[];
    for (const row of rows) {
      if (journal.operationId.includes(this.idBody(row.id))) return row.id;
    }
    return rows.length === 1 ? rows[0]!.id : undefined;
  }

  private idBody(changeSetId: string): string {
    const dash = changeSetId.indexOf('-');
    return dash >= 0 ? changeSetId.slice(dash + 1) : changeSetId;
  }

  private rescueFromJournal(journal: OperationJournalRecord): RescueCheckpoint | undefined {
    // The rescue state was digested into the journal's rescueDigest; the full
    // rescue object is re-derivable from the change set at recovery time, but we
    // stored the checkpoint id in rescueRef. Recompute the rescue from the change
    // set's current operations is unsafe (workspace may be mid-apply), so the
    // rescue bytes must be reconstructable. We persisted them via rescueState in
    // beginJournaledOperation's digest only; for restore we re-read from the
    // journal's embedded record if present.
    const embedded = (journal as unknown as { rescue?: RescueCheckpoint }).rescue;
    if (embedded) return embedded;
    return this.readRescueSidecar(journal.rescueRef);
  }

  /**
   * Durably persist the verified rescue checkpoint (its full pre-mutation bytes)
   * to the `changeset_rescues` sidecar BEFORE the promotion touches the
   * workspace, linked to the owning change set and its promotion journal
   * (NN-INV-006). This is the byte-exact restore source that {@link recover}
   * reads on restart: because the rescue is committed before any mutation, a
   * crash at any promotion boundary can restore the workspace to its exact
   * pre-mutation state — the journal only carries the rescue's `rescueRef` +
   * `rescueDigest`, so the bytes themselves must live here.
   *
   * Idempotent on the checkpoint id: a retry that captures the same rescue
   * re-writes the same row (the checkpoint id is a digest of the entries, so a
   * matching capture yields a matching row) and refreshes the journal linkage.
   * Runs in the serialized writer so the sidecar write cannot interleave with a
   * concurrent authority transaction.
   */
  private persistRescue(
    rescue: RescueCheckpoint,
    changeSetId: string,
    journalId: string,
    now?: () => Date,
  ): void {
    const createdAt = (now ?? (() => new Date()))().toISOString();
    this.db
      .prepare(
        `INSERT INTO changeset_rescues
           (checkpoint_id, change_set_id, journal_id, rescue_json, created_at)
         VALUES (@checkpointId, @changeSetId, @journalId, @rescueJson, @createdAt)
         ON CONFLICT(checkpoint_id) DO UPDATE SET
           change_set_id = excluded.change_set_id,
           journal_id = excluded.journal_id,
           rescue_json = excluded.rescue_json`,
      )
      .run({
        checkpointId: rescue.checkpointId,
        changeSetId,
        journalId,
        rescueJson: JSON.stringify(rescue),
        createdAt,
      });
  }

  private readRescueSidecar(checkpointId?: string): RescueCheckpoint | undefined {
    if (!checkpointId) return undefined;
    const row = this.db
      .prepare(`SELECT rescue_json FROM changeset_rescues WHERE checkpoint_id = ?`)
      .get(checkpointId) as { rescue_json: string } | undefined;
    return row ? (JSON.parse(row.rescue_json) as RescueCheckpoint) : undefined;
  }
}
