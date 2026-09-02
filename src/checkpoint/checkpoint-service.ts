/**
 * CheckpointService — the single write owner for `Checkpoint@1`
 * (FUT-PKG-05-RECOVERY/T-003).
 *
 * D-04 assigns the sole write authority for `Checkpoint@1`/`CheckpointRecord`
 * (canonical identity `checkpointId` + artifact digest + revision) to this
 * service; a raw Git ref or snapshot WITHOUT a record is explicitly NOT a valid
 * owner (NN-INV-008). This module is that single writer:
 *
 *   - EXACTLY ONE verified immutable backend artifact per record
 *     (NN-CHECKPOINT-001/002). A backend adapter (file-delta / private Git ref /
 *     full-workspace snapshot) captures the pre-state into one content-addressed
 *     immutable artifact; the service records it, verifies it, and binds the
 *     record identity to it via `integrityDigest`.
 *   - Creation captures the pre-state as one atomic checkpoint BEFORE a covered
 *     mutation; new files are marked absent and a batch is grouped
 *     (NN-CHECKPOINT-003). A missing scope, a missing/invalid hash, an
 *     unverifiable artifact, or a missing rescue BLOCKS the mutation and
 *     produces an actionable typed error (fail-closed, NN-INV-002).
 *   - list / compare / pin / delete are project-scoped, newest-first management
 *     operations (NN-CHECKPOINT-004); a delete never removes a pinned/rescue/
 *     legal-hold record (NN-DATA-007 / NN-CHECKPOINT-010).
 *   - Retention reconciles by checkpoint class, preserves pinned/rescue/
 *     legal-hold, and exposes disk usage (NN-CHECKPOINT-010).
 *   - Legacy artifacts are WRAPPED as verified read adapters, never removed
 *     (removal is P9). An unverified legacy item is quarantined and blocks
 *     activation; the source is preserved (D-20, CD-003).
 *
 * All record mutations route through the FUT-PKG-03-DURABILITY/T-001 authority
 * transaction (business row + `CommandReceipt@1` + one `OutboxRecord@1` commit
 * atomically); the create effect writes its immutable artifact to disk BEFORE
 * the record commits, and the committed record binds to the verified artifact.
 *
 * Additive: this module owns ONE new business table (`checkpoints`) behind the
 * authority and never becomes a second writer for any existing table
 * (NN-COMPAT-001/002).
 *
 * Design anchors: D-04 (Checkpoint ownership row), D-07 (`Checkpoint@1`),
 * D-08 (persistence/retention/integrity), D-12/D-14 (rescue/restore), D-20
 * (legacy backend migration row), CD-003. Requirements: NN-CHECKPOINT-001–010,
 * NN-DATA-005–007/010, NN-INV-002/006/008.
 */

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
  defaultBackendRegistry,
  sha256,
} from './backends/index.js';
import {
  CheckpointRecordSchema,
  DEFAULT_RETENTION_POLICY,
  isProtectedFromPruning,
  parseCheckpointRecord,
  type CaptureTarget,
  type CheckpointBackend,
  type CheckpointBackendType,
  type CheckpointRecord,
  type CheckpointSource,
  type LineEnding,
  type RetentionClass,
  type RetentionPolicy,
} from './checkpoint-types.js';

// ─── Authority owner / errors ────────────────────────────────────────────────

/** The Checkpoint Service authority owner id stamped on receipts/events/errors. */
export const CHECKPOINT_SERVICE_AUTHORITY = 'authority-checkpoint-service';

/** A typed failure surfaced by the Checkpoint Service. */
export class CheckpointServiceError extends Error {
  readonly error: ErrorEnvelope;
  constructor(error: ErrorEnvelope) {
    super(error.message);
    this.name = 'CheckpointServiceError';
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
    owner: CHECKPOINT_SERVICE_AUTHORITY,
    operation,
    correlationId,
    retryable: code === 'STALE_REVISION',
    redaction: 'internal',
    ...extra,
  };
}

// ─── Business table (additive, behind the authority) ─────────────────────────

const CHECKPOINT_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS checkpoints (
    checkpoint_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    scope_key TEXT NOT NULL,
    project_id TEXT NOT NULL,
    session_id TEXT,
    worktree_id TEXT,
    repository_id TEXT,
    source TEXT NOT NULL,
    backend_type TEXT NOT NULL,
    backend_version INTEGER NOT NULL,
    artifact_ref TEXT NOT NULL,
    integrity_digest TEXT NOT NULL,
    retention_class TEXT NOT NULL,
    pinned INTEGER NOT NULL,
    state TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    -- Bytes on disk for the one immutable artifact, for disk-usage reporting.
    artifact_bytes INTEGER NOT NULL DEFAULT 0,
    -- Whether this record wraps a verified legacy artifact (D-20). A wrapped
    -- legacy artifact is read-only through this record; its source is preserved.
    is_legacy_wrap INTEGER NOT NULL DEFAULT 0,
    record_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_checkpoints_project
    ON checkpoints (project_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_checkpoints_state ON checkpoints (state);
`;

/**
 * Create the durability primitives and the `checkpoints` table if absent.
 * Additive and idempotent; safe at startup and in tests. Never mutates a
 * business table owned by another writer.
 */
export function ensureCheckpointServiceTables(db: Database.Database): void {
  ensureAuthorityTables(db);
  db.exec(CHECKPOINT_TABLE_DDL);
}

// ─── Command shapes ──────────────────────────────────────────────────────────

/** Fields shared by every Checkpoint create command. */
export interface CheckpointCreateCommand {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly scope: ScopeDescriptor;
  /** Explicit identity: which project/session/worktree this checkpoint covers. */
  readonly projectId: string;
  readonly sessionId?: string;
  readonly worktreeId?: string;
  readonly repositoryId?: string;
  /** The absolute workspace root the targets are relative to. */
  readonly rootPath: string;
  readonly source: CheckpointSource;
  readonly backendType: CheckpointBackendType;
  readonly description: string;
  readonly createdBy: string;
  readonly retentionClass?: RetentionClass;
  /** Optional Git base ref (git-ref backend). */
  readonly baseRef?: string;
  /** Prior checkpoint ids this record descends from (rescue/restore lineage). */
  readonly lineage?: readonly string[];
  /**
   * The workspace-relative POSIX paths this checkpoint covers. For a file-delta
   * or git-ref checkpoint these are the touched targets; for a full-snapshot the
   * service enumerates the entire root when this is omitted.
   */
  readonly targetPaths?: readonly string[];
  readonly now?: () => Date;
}

/** Result of a create/mutation: the committed record and its receipt id. */
export interface CheckpointMutationResult {
  readonly record: CheckpointRecord;
  readonly receiptId: string;
  readonly authorityRevision: number;
}

/** A project-scoped list row (newest first) for the timeline/panel. */
export interface CheckpointListItem {
  readonly checkpointId: string;
  readonly source: CheckpointSource;
  readonly actor: string;
  readonly createdAt: string;
  readonly description: string;
  readonly changedFiles: readonly string[];
  readonly backendType: CheckpointBackendType;
  readonly pinned: boolean;
  readonly state: CheckpointRecord['state'];
  readonly retentionClass: RetentionClass;
}

/** The outcome of comparing two checkpoints' manifests. */
export interface CheckpointComparison {
  readonly fromCheckpointId: string;
  readonly toCheckpointId: string;
  /** Paths present only in the target (added since the base). */
  readonly added: readonly string[];
  /** Paths present only in the base (removed since the base). */
  readonly removed: readonly string[];
  /** Paths whose captured hash differs between base and target. */
  readonly changed: readonly string[];
  /** Paths whose captured hash is identical. */
  readonly unchanged: readonly string[];
}

/** The outcome of a retention reconciliation pass. */
export interface RetentionResult {
  readonly prunedCheckpointIds: readonly string[];
  readonly preservedCheckpointIds: readonly string[];
  readonly diskUsageBytes: number;
}

// ─── The Checkpoint Service (single owner for Checkpoint@1) ──────────────────

/**
 * The single write owner for `Checkpoint@1` (NN-INV-008). Reads are direct
 * SELECTs against `checkpoints`; creation routes through the T-001 authority
 * transaction. Backends are accessed through the registry; they never author
 * records.
 */
export class CheckpointService {
  private readonly backends: ReadonlyMap<CheckpointBackendType, CheckpointBackend>;
  private readonly artifactRoot: string;
  private readonly retention: RetentionPolicy;

  constructor(
    private readonly db: Database.Database,
    options: {
      /** Directory under which immutable checkpoint artifacts are written. */
      readonly artifactRoot: string;
      readonly backends?: ReadonlyMap<CheckpointBackendType, CheckpointBackend>;
      readonly retention?: RetentionPolicy;
    },
  ) {
    ensureCheckpointServiceTables(db);
    this.backends = options.backends ?? defaultBackendRegistry();
    this.artifactRoot = options.artifactRoot;
    this.retention = options.retention ?? DEFAULT_RETENTION_POLICY;
  }

  // ── Create (capture pre-state -> one verified immutable artifact) ─────────

  /**
   * Create a `Checkpoint@1` at revision 1: capture the covered pre-state into
   * exactly one immutable backend artifact, VERIFY it, then commit the record
   * bound to it through the T-001 authority transaction (NN-CHECKPOINT-001/002/
   * 003). Fail-closed (NN-INV-002): a missing scope identity, a missing/invalid
   * captured hash, or an unverifiable artifact BLOCKS the checkpoint and returns
   * an actionable typed error — no partial/success-shaped record. The artifact
   * is content-addressed, so a retried create with the same idempotency key
   * returns the prior receipt and reuses the same artifact (NN-INV-007).
   */
  create(cmd: CheckpointCreateCommand): CheckpointMutationResult {
    const now = (cmd.now ?? (() => new Date()))().toISOString();

    // Fail-closed scope check (NN-CHECKPOINT-001, NN-IDENT-001).
    if (!cmd.projectId || cmd.scope.projectId !== cmd.projectId) {
      throw new CheckpointServiceError(
        makeError(
          'VALIDATION',
          'checkpoint scope must name an explicit project matching the command projectId',
          'create-checkpoint',
          cmd.correlationId,
        ),
      );
    }
    const backend = this.requireBackend(cmd.backendType, cmd.correlationId);

    // Enumerate the covered targets and capture their pre-state facts.
    const targets = this.collectTargets(cmd);

    // Capture the pre-state into ONE immutable artifact, then VERIFY it BEFORE
    // committing the record (recovery precedes mutation; fail-closed integrity).
    const artifact = backend.capture({
      rootPath: cmd.rootPath,
      targets,
      artifactRoot: this.artifactRoot,
      ...(cmd.baseRef !== undefined ? { baseRef: cmd.baseRef } : {}),
      ...(cmd.now ? { now: cmd.now } : {}),
    });
    const verified = backend.verify({
      artifactPath: artifact.artifactPath,
      manifest: artifact.manifest,
      artifactDigest: artifact.artifactDigest,
    });
    if (!verified) {
      throw new CheckpointServiceError(
        makeError(
          'INTEGRITY',
          'checkpoint artifact could not be verified after capture; refusing to create a record (fail-closed)',
          'create-checkpoint',
          cmd.correlationId,
        ),
      );
    }

    const checkpointId = makeOpaqueId(
      'ckpt',
      `${cmd.projectId}${cmd.commandId}${artifact.artifactDigest}`,
    );
    // The integrity digest binds the record identity to the one artifact +
    // manifest (NN-CHECKPOINT-001): exactly one verified artifact per record.
    const integrityDigest = computeDigest({
      checkpointId,
      backendType: artifact.backendType,
      backendVersion: artifact.backendVersion,
      artifactRef: artifact.artifactRef,
      artifactDigest: artifact.artifactDigest,
      manifest: artifact.manifest,
    });

    const record: CheckpointRecord = {
      schemaVersion: CONTRACT_WRITE_VERSION,
      checkpointId,
      revision: 1,
      scope: cmd.scope,
      projectId: cmd.projectId,
      ...(cmd.sessionId !== undefined ? { sessionId: cmd.sessionId } : {}),
      ...(cmd.worktreeId !== undefined ? { worktreeId: cmd.worktreeId } : {}),
      ...(cmd.repositoryId !== undefined ? { repositoryId: cmd.repositoryId } : {}),
      ...(artifact.baseRef !== undefined ? { baseRef: artifact.baseRef } : {}),
      source: cmd.source,
      backendType: artifact.backendType,
      backendVersion: artifact.backendVersion,
      artifactRef: artifact.artifactRef,
      description: cmd.description,
      fileManifest: [...artifact.manifest],
      lineage: cmd.lineage ? [...cmd.lineage] : [],
      integrityDigest,
      retentionClass: cmd.retentionClass ?? this.defaultRetentionFor(cmd.source),
      pinned: false,
      state: 'active',
      createdBy: cmd.createdBy,
      createdAt: now,
    };

    // Validate the record against its own contract before persisting.
    const parsed = CheckpointRecordSchema.safeParse(record);
    if (!parsed.success) {
      throw new CheckpointServiceError(
        makeError(
          'VALIDATION',
          `checkpoint record failed contract validation: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
          'create-checkpoint',
          cmd.correlationId,
        ),
      );
    }

    const artifactBytes = this.measureArtifactBytes(artifact.artifactPath);

    const outcome = applyAuthorityMutation(this.db, {
      authority: CHECKPOINT_SERVICE_AUTHORITY,
      commandId: cmd.commandId,
      idempotencyKey: cmd.idempotencyKey,
      requestDigest: computeDigest({ op: 'create-checkpoint', integrityDigest }),
      correlationId: cmd.correlationId,
      scope: cmd.scope,
      mutate: (tx) => {
        this.persist(tx, record, { artifactBytes, isLegacyWrap: false });
        return { resultRef: makeOpaqueId('res', checkpointId) };
      },
      events: [
        this.event('checkpoint.created', 'checkpoint', checkpointId, {
          checkpointId,
          projectId: cmd.projectId,
          backendType: artifact.backendType,
          source: cmd.source,
          fileCount: artifact.manifest.length,
        }),
      ],
      ...(cmd.now ? { now: cmd.now } : {}),
    });

    return this.finish(outcome, () => this.read(checkpointId)!);
  }

  /** Read a `Checkpoint@1` record, or `undefined` if absent. */
  read(checkpointId: string): CheckpointRecord | undefined {
    const row = this.db
      .prepare(`SELECT record_json FROM checkpoints WHERE checkpoint_id = ?`)
      .get(checkpointId) as { record_json: string } | undefined;
    return row ? (JSON.parse(row.record_json) as CheckpointRecord) : undefined;
  }

  // ── List (project-scoped, newest first) ───────────────────────────────────

  /**
   * List checkpoints for a project, newest first, with source/actor/time/
   * description/changed-files for the panel (NN-CHECKPOINT-004). Quarantined
   * legacy items are excluded by default (they are visible only through the
   * diagnostic recovery reader).
   */
  list(input: {
    readonly projectId: string;
    readonly includeQuarantined?: boolean;
    readonly includeDeleted?: boolean;
  }): CheckpointListItem[] {
    const rows = this.db
      .prepare(
        `SELECT record_json FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC, checkpoint_id DESC`,
      )
      .all(input.projectId) as { record_json: string }[];
    const items: CheckpointListItem[] = [];
    for (const row of rows) {
      const record = JSON.parse(row.record_json) as CheckpointRecord;
      if (record.state === 'deleted' && !input.includeDeleted) continue;
      if (record.state === 'quarantined' && !input.includeQuarantined) continue;
      items.push({
        checkpointId: record.checkpointId,
        source: record.source,
        actor: record.createdBy,
        createdAt: record.createdAt,
        description: record.description,
        changedFiles: record.fileManifest.map((m) => m.pathRef),
        backendType: record.backendType,
        pinned: record.pinned,
        state: record.state,
        retentionClass: record.retentionClass,
      });
    }
    return items;
  }

  // ── Compare (manifest diff between two checkpoints) ───────────────────────

  /**
   * Compare two checkpoints' manifests: which paths were added, removed,
   * changed, or unchanged between the base and target captures
   * (NN-CHECKPOINT-004). Both records must exist and be in the same project.
   */
  compare(input: {
    readonly fromCheckpointId: string;
    readonly toCheckpointId: string;
    readonly correlationId: string;
  }): CheckpointComparison {
    const from = this.requireRecord(input.fromCheckpointId, input.correlationId);
    const to = this.requireRecord(input.toCheckpointId, input.correlationId);
    if (from.projectId !== to.projectId) {
      throw new CheckpointServiceError(
        makeError(
          'CONFLICT',
          'cannot compare checkpoints from different projects',
          'compare-checkpoints',
          input.correlationId,
        ),
      );
    }
    const fromMap = new Map(from.fileManifest.map((m) => [m.pathRef, m.capturedSha256] as const));
    const toMap = new Map(to.fileManifest.map((m) => [m.pathRef, m.capturedSha256] as const));
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    const unchanged: string[] = [];
    for (const [pathRef, toHash] of toMap) {
      const fromHash = fromMap.get(pathRef);
      if (fromHash === undefined) added.push(pathRef);
      else if (fromHash !== toHash) changed.push(pathRef);
      else unchanged.push(pathRef);
    }
    for (const pathRef of fromMap.keys()) {
      if (!toMap.has(pathRef)) removed.push(pathRef);
    }
    return {
      fromCheckpointId: from.checkpointId,
      toCheckpointId: to.checkpointId,
      added: added.sort(),
      removed: removed.sort(),
      changed: changed.sort(),
      unchanged: unchanged.sort(),
    };
  }

  // ── Pin / unpin (retention protection) ────────────────────────────────────

  /**
   * Pin or unpin a checkpoint (NN-CHECKPOINT-004). A pinned record is protected
   * from retention pruning (NN-DATA-007). Routes through the authority
   * transaction and bumps the record revision.
   */
  setPinned(input: {
    readonly checkpointId: string;
    readonly pinned: boolean;
    readonly commandId: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly now?: () => Date;
  }): CheckpointMutationResult {
    const record = this.requireRecord(input.checkpointId, input.correlationId);
    if (record.state === 'quarantined') {
      throw new CheckpointServiceError(
        makeError(
          'FORBIDDEN',
          'a quarantined legacy checkpoint cannot be pinned until verified',
          'pin-checkpoint',
          input.correlationId,
        ),
      );
    }
    const updated: CheckpointRecord = { ...record, revision: record.revision + 1, pinned: input.pinned };
    const outcome = applyAuthorityMutation(this.db, {
      authority: CHECKPOINT_SERVICE_AUTHORITY,
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      requestDigest: computeDigest({ op: 'pin', checkpointId: input.checkpointId, pinned: input.pinned }),
      correlationId: input.correlationId,
      scope: record.scope,
      mutate: (tx) => {
        this.persist(tx, updated, {});
        return { resultRef: makeOpaqueId('res', `${input.checkpointId}pin`) };
      },
      events: [
        this.event('checkpoint.pinned', 'checkpoint', input.checkpointId, {
          checkpointId: input.checkpointId,
          pinned: input.pinned,
        }),
      ],
      ...(input.now ? { now: input.now } : {}),
    });
    return this.finish(outcome, () => this.read(input.checkpointId)!);
  }

  // ── Delete (tombstone; never a pinned/rescue/legal-hold) ──────────────────

  /**
   * Delete (tombstone) a checkpoint (NN-CHECKPOINT-004). A pinned, `rescue`, or
   * `legal-hold` record is protected and returns `FORBIDDEN` (NN-DATA-007 /
   * NN-CHECKPOINT-010). The record transitions to `deleted` and its immutable
   * artifact is removed from disk; the record row is retained as a tombstone so
   * a dangling reference is never orphaned (D-08.4).
   */
  delete(input: {
    readonly checkpointId: string;
    readonly commandId: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly now?: () => Date;
  }): CheckpointMutationResult {
    const record = this.requireRecord(input.checkpointId, input.correlationId);
    if (isProtectedFromPruning(record)) {
      throw new CheckpointServiceError(
        makeError(
          'FORBIDDEN',
          `checkpoint ${input.checkpointId} is protected (pinned/rescue/legal-hold) and cannot be deleted`,
          'delete-checkpoint',
          input.correlationId,
        ),
      );
    }
    const updated: CheckpointRecord = { ...record, revision: record.revision + 1, state: 'deleted' };
    const outcome = applyAuthorityMutation(this.db, {
      authority: CHECKPOINT_SERVICE_AUTHORITY,
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      requestDigest: computeDigest({ op: 'delete', checkpointId: input.checkpointId }),
      correlationId: input.correlationId,
      scope: record.scope,
      mutate: (tx) => {
        this.persist(tx, updated, { artifactBytes: 0 });
        return { resultRef: makeOpaqueId('res', `${input.checkpointId}del`) };
      },
      events: [
        this.event('checkpoint.deleted', 'checkpoint', input.checkpointId, {
          checkpointId: input.checkpointId,
        }),
      ],
      ...(input.now ? { now: input.now } : {}),
    });
    // Remove the immutable artifact only after the tombstone committed.
    if (outcome.kind === 'committed') {
      this.removeArtifact(record.artifactRef);
    }
    return this.finish(outcome, () => this.read(input.checkpointId)!);
  }

  // ── Retention (reconcile by class; preserve protected; report disk usage) ──

  /**
   * Reconcile retention for a project by checkpoint class (NN-CHECKPOINT-010):
   * `default` file checkpoints keep the latest N (newest first); `turn` refs
   * age out after the policy window. Pinned, `rescue`, and `legal-hold` records
   * are NEVER pruned (NN-DATA-007). Pruned records are tombstoned and their
   * artifacts removed; disk usage across live artifacts is reported.
   */
  reconcileRetention(input: {
    readonly projectId: string;
    readonly correlationId: string;
    readonly now?: () => Date;
  }): RetentionResult {
    const nowMs = (input.now ?? (() => new Date()))().getTime();
    const rows = this.db
      .prepare(
        `SELECT record_json FROM checkpoints WHERE project_id = ? AND state = 'active' ORDER BY created_at DESC, checkpoint_id DESC`,
      )
      .all(input.projectId) as { record_json: string }[];
    const records = rows.map((r) => JSON.parse(r.record_json) as CheckpointRecord);

    const preserved: string[] = [];
    const toPrune: CheckpointRecord[] = [];

    let defaultKept = 0;
    for (const record of records) {
      if (isProtectedFromPruning(record)) {
        preserved.push(record.checkpointId);
        continue;
      }
      if (record.retentionClass === 'default') {
        if (defaultKept < this.retention.defaultMaxCount) {
          defaultKept += 1;
          preserved.push(record.checkpointId);
        } else {
          toPrune.push(record);
        }
      } else if (record.retentionClass === 'turn') {
        const ageMs = nowMs - Date.parse(record.createdAt);
        if (ageMs > this.retention.turnMaxAgeMs) toPrune.push(record);
        else preserved.push(record.checkpointId);
      } else {
        preserved.push(record.checkpointId);
      }
    }

    for (const record of toPrune) {
      this.delete({
        checkpointId: record.checkpointId,
        commandId: makeOpaqueId('cmd', `retention${record.checkpointId}`),
        idempotencyKey: `retention:${record.checkpointId}`,
        correlationId: input.correlationId,
        ...(input.now ? { now: input.now } : {}),
      });
    }

    return {
      prunedCheckpointIds: toPrune.map((r) => r.checkpointId),
      preservedCheckpointIds: preserved,
      diskUsageBytes: this.diskUsage(input.projectId),
    };
  }

  /** Sum of on-disk artifact bytes for a project's live (non-deleted) records. */
  diskUsage(projectId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(artifact_bytes), 0) AS bytes FROM checkpoints WHERE project_id = ? AND state != 'deleted'`,
      )
      .get(projectId) as { bytes: number };
    return row.bytes;
  }

  // ── Integrity re-verification ──────────────────────────────────────────────

  /**
   * Re-verify a record against its one immutable artifact: recompute the
   * integrity digest binding, then re-verify the artifact's stored blobs
   * (NN-CHECKPOINT-005). Returns `true` when the record and its artifact are
   * intact. A tampered artifact returns `false` without mutating anything.
   */
  verifyIntegrity(checkpointId: string): boolean {
    const record = this.read(checkpointId);
    if (!record) return false;
    const backend = this.backends.get(record.backendType);
    if (!backend) return false;
    const expected = computeDigest({
      checkpointId: record.checkpointId,
      backendType: record.backendType,
      backendVersion: record.backendVersion,
      artifactRef: record.artifactRef,
      artifactDigest: this.artifactDigestFor(record),
      manifest: record.fileManifest,
    });
    if (expected !== record.integrityDigest) return false;
    const artifactPath = this.artifactPathFor(record.artifactRef);
    return backend.verify({
      artifactPath,
      manifest: record.fileManifest,
      artifactDigest: this.artifactDigestFor(record),
    });
  }

  // ── Legacy wrap (persist a verified legacy artifact as a read adapter) ────

  /**
   * Commit a `Checkpoint@1` record that WRAPS a verified legacy artifact as a
   * read adapter (D-20, CD-003). The artifact is NOT re-created — the caller
   * (the legacy-artifact-wrapper) has already inventoried and verified it into
   * the artifact store; this method only records it. A verified item is `active`
   * (source `migration`); an unverified item is `quarantined` and blocks
   * activation while its source is preserved. Routes through the authority
   * transaction (single writer).
   */
  wrapLegacyArtifact(input: {
    readonly commandId: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly scope: ScopeDescriptor;
    readonly projectId: string;
    readonly backendType: CheckpointBackendType;
    readonly backendVersion: number;
    readonly artifactRef: string;
    readonly artifactDigest: string;
    readonly manifest: CheckpointRecord['fileManifest'];
    readonly description: string;
    readonly createdBy: string;
    readonly createdAt: string;
    readonly verified: boolean;
    readonly baseRef?: string;
    readonly sessionId?: string;
    readonly worktreeId?: string;
    readonly repositoryId?: string;
    readonly now?: () => Date;
  }): CheckpointMutationResult {
    if (!input.projectId || input.scope.projectId !== input.projectId) {
      throw new CheckpointServiceError(
        makeError('VALIDATION', 'legacy wrap scope must name an explicit matching project', 'wrap-legacy', input.correlationId),
      );
    }
    const checkpointId = makeOpaqueId('ckpt', `legacy${input.projectId}${input.artifactRef}${input.artifactDigest}`);
    const integrityDigest = computeDigest({
      checkpointId,
      backendType: input.backendType,
      backendVersion: input.backendVersion,
      artifactRef: input.artifactRef,
      artifactDigest: input.artifactDigest,
      manifest: input.manifest,
    });
    const record: CheckpointRecord = {
      schemaVersion: CONTRACT_WRITE_VERSION,
      checkpointId,
      revision: 1,
      scope: input.scope,
      projectId: input.projectId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.worktreeId !== undefined ? { worktreeId: input.worktreeId } : {}),
      ...(input.repositoryId !== undefined ? { repositoryId: input.repositoryId } : {}),
      ...(input.baseRef !== undefined ? { baseRef: input.baseRef } : {}),
      source: 'migration',
      backendType: input.backendType,
      backendVersion: input.backendVersion,
      artifactRef: input.artifactRef,
      description: input.description,
      fileManifest: [...input.manifest],
      lineage: [],
      integrityDigest,
      retentionClass: 'legal-hold', // preserve wrapped legacy sources by default
      pinned: false,
      // Unverified legacy items are quarantined (block activation, preserve source).
      state: input.verified ? 'active' : 'quarantined',
      createdBy: input.createdBy,
      createdAt: input.createdAt,
    };
    const artifactBytes = this.measureArtifactBytes(this.artifactPathFor(input.artifactRef));
    const outcome = applyAuthorityMutation(this.db, {
      authority: CHECKPOINT_SERVICE_AUTHORITY,
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      requestDigest: computeDigest({ op: 'wrap-legacy', integrityDigest, verified: input.verified }),
      correlationId: input.correlationId,
      scope: input.scope,
      mutate: (tx) => {
        this.persist(tx, record, { artifactBytes, isLegacyWrap: true });
        return { resultRef: makeOpaqueId('res', checkpointId) };
      },
      events: [
        this.event('checkpoint.legacy-wrapped', 'checkpoint', checkpointId, {
          checkpointId,
          projectId: input.projectId,
          verified: input.verified,
          state: record.state,
        }),
      ],
      ...(input.now ? { now: input.now } : {}),
    });
    return this.finish(outcome, () => this.read(checkpointId)!);
  }

  // ── Internal: target collection ────────────────────────────────────────────

  /**
   * Enumerate the covered targets and read their current on-disk facts. For a
   * full-snapshot the entire root is enumerated when no explicit paths are
   * given; otherwise the named targets are captured (new files marked absent,
   * NN-CHECKPOINT-003). Every path is canonicalized and contained inside the
   * root (NN-SEC-005) before it is read.
   */
  private collectTargets(cmd: CheckpointCreateCommand): CaptureTarget[] {
    const explicit =
      cmd.targetPaths ??
      (cmd.backendType === 'full-snapshot' ? this.enumerateRoot(cmd.rootPath) : undefined);
    if (!explicit || explicit.length === 0) {
      throw new CheckpointServiceError(
        makeError(
          'VALIDATION',
          'checkpoint must cover at least one target path (or a non-empty full-snapshot root)',
          'create-checkpoint',
          cmd.correlationId,
        ),
      );
    }
    const seen = new Set<string>();
    const targets: CaptureTarget[] = [];
    for (const raw of explicit) {
      const rel = raw.split(path.sep).join('/');
      if (seen.has(rel)) continue;
      seen.add(rel);
      const contained = this.contain(rel, cmd.rootPath, cmd.correlationId);
      const exists = fs.existsSync(contained.absolute) && fs.statSync(contained.absolute).isFile();
      if (exists) {
        const bytes = fs.readFileSync(contained.absolute);
        const stat = fs.statSync(contained.absolute);
        targets.push({
          pathRef: contained.relative,
          existedBefore: true,
          priorContent: bytes,
          priorSha256: sha256(bytes),
          mode: stat.mode,
          ...(this.detectLineEnding(bytes) ? { lineEnding: this.detectLineEnding(bytes)! } : {}),
        });
      } else {
        targets.push({
          pathRef: contained.relative,
          existedBefore: false,
          priorContent: null,
          priorSha256: null,
          mode: null,
        });
      }
    }
    return targets;
  }

  private enumerateRoot(rootPath: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue; // skip dotfiles/dot-dirs
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.isFile()) out.push(path.relative(rootPath, abs).split(path.sep).join('/'));
      }
    };
    if (fs.existsSync(rootPath)) walk(rootPath);
    return out;
  }

  private detectLineEnding(bytes: Buffer): LineEnding | undefined {
    const scan = bytes.subarray(0, Math.min(bytes.length, 8000)).toString('utf8');
    if (scan.includes('\r\n')) return 'crlf';
    if (scan.includes('\n')) return 'lf';
    return undefined;
  }

  private contain(
    relPath: string,
    rootPath: string,
    correlationId: string,
  ): { readonly absolute: string; readonly relative: string } {
    if (path.isAbsolute(relPath)) {
      throw new CheckpointServiceError(
        makeError('FORBIDDEN', 'checkpoint target must be workspace-relative, not an absolute host path', 'contain-target', correlationId),
      );
    }
    const decision = evaluatePath(relPath, rootPath, {}, { correlationId, operation: 'checkpoint:capture' });
    if (decision.decision !== 'allow') {
      throw new CheckpointServiceError(decision.error);
    }
    return { absolute: decision.value.absolute, relative: decision.value.relative };
  }

  // ── Internal: artifact digest / paths / measurement ───────────────────────

  /**
   * Recompute the backend artifact digest from a persisted record's manifest.
   * The service persists the manifest inside the record; the artifact digest is
   * re-derivable from the on-disk manifest.json during verify, and the record's
   * integrity digest binds to it. We re-read the stored manifest.json digest to
   * avoid recomputing with the wrong anchor (git-ref baseRef).
   */
  private artifactDigestFor(record: CheckpointRecord): string {
    const manifestPath = path.join(this.artifactPathFor(record.artifactRef), 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const stored = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { artifactDigest?: string };
        if (typeof stored.artifactDigest === 'string') return stored.artifactDigest;
      } catch {
        /* fall through to recompute */
      }
    }
    // Fallback: recompute without an anchor (file-delta / full-snapshot).
    return computeDigest({
      backendType: record.backendType,
      backendVersion: record.backendVersion,
      manifest: record.fileManifest,
      anchor: record.baseRef !== undefined ? { baseRef: record.baseRef } : null,
    });
  }

  private artifactPathFor(artifactRef: string): string {
    return path.join(this.artifactRoot, artifactRef);
  }

  private measureArtifactBytes(artifactPath: string): number {
    if (!fs.existsSync(artifactPath)) return 0;
    let total = 0;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.isFile()) total += fs.statSync(abs).size;
      }
    };
    walk(artifactPath);
    return total;
  }

  private removeArtifact(artifactRef: string): void {
    // A content-addressed artifact may be shared by dedupe; only remove it when
    // no other live record references it (never orphan/never over-delete).
    const others = this.db
      .prepare(`SELECT COUNT(*) AS n FROM checkpoints WHERE artifact_ref = ? AND state != 'deleted'`)
      .get(artifactRef) as { n: number };
    if (others.n > 0) return;
    const artifactPath = this.artifactPathFor(artifactRef);
    if (fs.existsSync(artifactPath)) fs.rmSync(artifactPath, { recursive: true, force: true });
  }

  // ── Internal: records / persistence / events ──────────────────────────────

  private requireRecord(checkpointId: string, correlationId: string): CheckpointRecord {
    const record = this.read(checkpointId);
    if (!record) {
      throw new CheckpointServiceError(
        makeError('VALIDATION', `checkpoint ${checkpointId} not found`, 'read-checkpoint', correlationId),
      );
    }
    return record;
  }

  private requireBackend(backendType: CheckpointBackendType, correlationId: string): CheckpointBackend {
    const backend = this.backends.get(backendType);
    if (!backend) {
      throw new CheckpointServiceError(
        makeError('UNAVAILABLE', `checkpoint backend "${backendType}" is not registered`, 'create-checkpoint', correlationId),
      );
    }
    return backend;
  }

  private defaultRetentionFor(source: CheckpointSource): RetentionClass {
    if (source === 'rescue') return 'rescue';
    if (source === 'turn') return 'turn';
    return 'default';
  }

  private persist(
    tx: Database.Database,
    record: CheckpointRecord,
    extra: { readonly artifactBytes?: number; readonly isLegacyWrap?: boolean },
  ): void {
    const scopeKey = computeDigest({
      userId: record.scope.userId,
      owner: record.scope.owner,
      projectId: record.scope.projectId,
      sessionId: record.scope.sessionId,
      worktreeId: record.scope.worktreeId,
    });
    tx.prepare(
      `INSERT INTO checkpoints
         (checkpoint_id, revision, scope_key, project_id, session_id, worktree_id, repository_id,
          source, backend_type, backend_version, artifact_ref, integrity_digest, retention_class,
          pinned, state, created_by, created_at, artifact_bytes, is_legacy_wrap, record_json)
       VALUES (@checkpointId, @revision, @scopeKey, @projectId, @sessionId, @worktreeId, @repositoryId,
          @source, @backendType, @backendVersion, @artifactRef, @integrityDigest, @retentionClass,
          @pinned, @state, @createdBy, @createdAt, @artifactBytes, @isLegacyWrap, @recordJson)
       ON CONFLICT(checkpoint_id) DO UPDATE SET
         revision = excluded.revision,
         pinned = excluded.pinned,
         state = excluded.state,
         retention_class = excluded.retention_class,
         artifact_bytes = excluded.artifact_bytes,
         record_json = excluded.record_json`,
    ).run({
      checkpointId: record.checkpointId,
      revision: record.revision,
      scopeKey,
      projectId: record.projectId,
      sessionId: record.sessionId ?? null,
      worktreeId: record.worktreeId ?? null,
      repositoryId: record.repositoryId ?? null,
      source: record.source,
      backendType: record.backendType,
      backendVersion: record.backendVersion,
      artifactRef: record.artifactRef,
      integrityDigest: record.integrityDigest,
      retentionClass: record.retentionClass,
      pinned: record.pinned ? 1 : 0,
      state: record.state,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
      artifactBytes: extra.artifactBytes ?? this.currentArtifactBytes(record.checkpointId),
      isLegacyWrap: extra.isLegacyWrap ? 1 : 0,
      recordJson: JSON.stringify(record),
    });
  }

  private currentArtifactBytes(checkpointId: string): number {
    const row = this.db
      .prepare(`SELECT artifact_bytes AS b FROM checkpoints WHERE checkpoint_id = ?`)
      .get(checkpointId) as { b: number } | undefined;
    return row?.b ?? 0;
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
    readRecord: () => CheckpointRecord,
  ): CheckpointMutationResult {
    if (outcome.kind === 'conflict') throw new CheckpointServiceError(outcome.error);
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

  /** Expose the artifact root for the legacy wrapper (shared store). */
  get artifactRootPath(): string {
    return this.artifactRoot;
  }

  /** Expose the backend registry for the legacy wrapper. */
  backendFor(backendType: CheckpointBackendType): CheckpointBackend | undefined {
    return this.backends.get(backendType);
  }
}
