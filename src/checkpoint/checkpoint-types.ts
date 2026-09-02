/**
 * `Checkpoint@1` / `CheckpointRecord` contract shapes and backend interface
 * (FUT-PKG-05-RECOVERY/T-003).
 *
 * D-04 assigns the sole write authority for `Checkpoint@1` to the
 * `CheckpointService` (canonical identity `checkpointId` + artifact digest +
 * revision); a raw Git ref or snapshot WITHOUT a record is explicitly NOT a
 * valid owner. D-07 gives the logical record shape:
 *
 *   Checkpoint@1 = { schemaVersion, checkpointId, revision, scope, projectId,
 *     sessionId?, worktreeId?, repositoryId?, baseRef?, source, backendType,
 *     backendVersion, artifactRef, description,
 *     fileManifest[]{pathRef, existedBefore, priorSha256?, capturedSha256,
 *                    mode?, lineEnding?},
 *     lineage[], integrityDigest, retentionClass, pinned, state, createdBy,
 *     createdAt }
 *
 * `CheckpointRecord` is the domain name for `Checkpoint@1`; they are not
 * separate contracts (D-07). CheckpointService maps EXACTLY ONE record to one
 * immutable verified backend artifact (NN-CHECKPOINT-001/002).
 *
 * A backend adapter (file-delta / private Git ref / full-workspace snapshot)
 * captures the pre-state into one content-addressed immutable artifact and can
 * verify + stage-restore it; it MUST NOT create a competing checkpoint
 * authority (NN-CHECKPOINT-002). Every backend produces a hashed
 * prior-existence file manifest so restore can distinguish "was absent" from
 * "was present with these bytes" (NN-CHECKPOINT-001/003).
 *
 * Design anchors: D-04 (Checkpoint ownership row), D-07 (`Checkpoint@1`),
 * D-08 (persistence/retention/integrity), D-12/D-14 (rescue/restore), D-20
 * (legacy backend migration row), CD-003. Requirements:
 * NN-CHECKPOINT-001–010, NN-DATA-005–007/010, NN-INV-006/008.
 */

import { z } from 'zod';

import {
  CONTRACT_WRITE_VERSION,
  DigestSchema,
  OpaqueIdSchema,
  RevisionSchema,
  ScopeDescriptorSchema,
  TimestampSchema,
  type ScopeDescriptor,
} from '../shared/contract-primitives.js';

// ─── Checkpoint source and backend taxonomy ─────────────────────────────────

/**
 * How a checkpoint came to exist (NN-CHECKPOINT-001). `migration` is the source
 * for a record that wraps a verified legacy artifact (D-20). `rescue` is the
 * source for a pre-mutation/pre-restore rescue (NN-INV-006).
 */
export const CHECKPOINT_SOURCES = Object.freeze([
  'auto',
  'manual',
  'turn',
  'migration',
  'rescue',
] as const);

export type CheckpointSource = (typeof CHECKPOINT_SOURCES)[number];

export const CheckpointSourceSchema = z.enum(CHECKPOINT_SOURCES);

/**
 * The backend adapters behind the one service (NN-CHECKPOINT-002). All three
 * capture the pre-state into exactly one content-addressed immutable artifact.
 *
 *   - `file-delta`    — a per-file snapshot of every touched target's bytes.
 *   - `git-ref`       — a private ref/pack anchored to an optional `baseRef`,
 *     capturing uncommitted state as a named ref/artifact so no unrecoverable
 *     hard reset is ever required (NN-CHECKPOINT-007).
 *   - `full-snapshot` — a full-workspace snapshot of the scoped root.
 */
export const CHECKPOINT_BACKENDS = Object.freeze([
  'file-delta',
  'git-ref',
  'full-snapshot',
] as const);

export type CheckpointBackendType = (typeof CHECKPOINT_BACKENDS)[number];

export const CheckpointBackendTypeSchema = z.enum(CHECKPOINT_BACKENDS);

/** `Checkpoint@1` lifecycle state. */
export const CHECKPOINT_STATES = Object.freeze([
  'active', // a verified, restorable checkpoint
  'quarantined', // an unverified/orphan legacy artifact; readable only for diagnostics
  'deleted', // tombstoned by a retention/delete command (never a pinned/rescue)
] as const);

export type CheckpointState = (typeof CHECKPOINT_STATES)[number];

export const CheckpointStateSchema = z.enum(CHECKPOINT_STATES);

/**
 * Retention class per checkpoint (NN-DATA-007 / NN-CHECKPOINT-010). `default`
 * file checkpoints are pruned by the latest-50 policy; `turn` refs age out;
 * `rescue`, `legal-hold`, and pinned records are never pruned contrary to
 * policy.
 */
export const RETENTION_CLASSES = Object.freeze([
  'default',
  'turn',
  'rescue',
  'legal-hold',
] as const);

export type RetentionClass = (typeof RETENTION_CLASSES)[number];

export const RetentionClassSchema = z.enum(RETENTION_CLASSES);

/** POSIX line-ending fidelity marker (mirrors ChangeSet@1). */
export type LineEnding = 'lf' | 'crlf';

export const LineEndingSchema = z.enum(['lf', 'crlf']);

// ─── Hashed prior-existence file manifest (NN-CHECKPOINT-001/003) ────────────

/**
 * One manifest entry: the prior-existence marker and SHA-256 hashes for one
 * captured target. `existedBefore=false` marks a new file (absent at capture);
 * `capturedSha256` is the hash of the captured bytes (equal to `priorSha256`
 * when the file existed). A new/absent file has `priorSha256=undefined` and a
 * `capturedSha256` of the empty content marker so restore can delete it.
 */
export const CheckpointManifestEntrySchema = z.strictObject({
  /** Workspace-relative POSIX path (never an absolute host path, NN-INV-004). */
  pathRef: z.string().min(1).max(4096),
  /** Whether the file existed at capture (prior-existence marker). */
  existedBefore: z.boolean(),
  /** SHA-256 of the prior bytes when it existed; absent for a new file. */
  priorSha256: DigestSchema.optional(),
  /** SHA-256 of the captured bytes (the artifact stores these bytes). */
  capturedSha256: DigestSchema,
  /** File mode bits to preserve, when relevant. */
  mode: z.number().int().nonnegative().optional(),
  /** Line-ending fidelity marker. */
  lineEnding: LineEndingSchema.optional(),
});

export type CheckpointManifestEntry = z.infer<typeof CheckpointManifestEntrySchema>;

// ─── Checkpoint@1 / CheckpointRecord (D-07) ──────────────────────────────────

/**
 * `Checkpoint@1` (domain name `CheckpointRecord`). Owned solely by the
 * CheckpointService (NN-INV-008). Exactly one verified immutable artifact per
 * record (`artifactRef` + `integrityDigest`, NN-CHECKPOINT-001/002).
 */
export const CheckpointRecordSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_WRITE_VERSION),
  checkpointId: OpaqueIdSchema,
  revision: RevisionSchema,
  scope: ScopeDescriptorSchema,
  projectId: OpaqueIdSchema,
  sessionId: OpaqueIdSchema.optional(),
  worktreeId: OpaqueIdSchema.optional(),
  repositoryId: OpaqueIdSchema.optional(),
  /** Optional Git base ref this checkpoint is anchored to (git-ref backend). */
  baseRef: z.string().min(1).max(512).optional(),
  source: CheckpointSourceSchema,
  backendType: CheckpointBackendTypeSchema,
  backendVersion: z.number().int().positive().finite(),
  /** Opaque reference to the one immutable backend artifact for this record. */
  artifactRef: OpaqueIdSchema,
  description: z.string().max(4096),
  fileManifest: z.array(CheckpointManifestEntrySchema),
  /** Prior checkpoint ids this record descends from (rescue/restore lineage). */
  lineage: z.array(OpaqueIdSchema),
  /** Digest binding the record identity to its artifact + manifest. */
  integrityDigest: DigestSchema,
  retentionClass: RetentionClassSchema,
  pinned: z.boolean(),
  state: CheckpointStateSchema,
  createdBy: OpaqueIdSchema,
  createdAt: TimestampSchema,
});

export type CheckpointRecord = z.infer<typeof CheckpointRecordSchema>;

/**
 * Validate an untrusted value as a `Checkpoint@1` record. Deterministic typed
 * rejection with no side effect (NN-INV-011). Returns the parsed record or a
 * summarized error message.
 */
export function parseCheckpointRecord(
  value: unknown,
): { readonly ok: true; readonly value: CheckpointRecord } | { readonly ok: false; readonly message: string } {
  const result = CheckpointRecordSchema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  const message = result.error.issues
    .slice(0, 8)
    .map((i) => `${i.path.length ? i.path.join('.') : '<root>'}: ${i.message}`)
    .join('; ');
  return { ok: false, message };
}

// ─── Backend artifact + capture request ──────────────────────────────────────

/**
 * A single target to capture: a workspace-relative path plus its current
 * on-disk facts. The service captures the pre-state (NN-CHECKPOINT-003); a
 * batch of files is grouped into one checkpoint.
 */
export interface CaptureTarget {
  /** Workspace-relative POSIX path. */
  readonly pathRef: string;
  readonly existedBefore: boolean;
  /** Prior bytes when it existed (null for an absent/new file). */
  readonly priorContent: Buffer | null;
  readonly priorSha256: string | null;
  readonly mode: number | null;
  readonly lineEnding?: LineEnding;
}

/** A request to capture a pre-state into one immutable backend artifact. */
export interface BackendCaptureRequest {
  /** The resolved absolute workspace root (never persisted; NN-INV-004). */
  readonly rootPath: string;
  /** The scoped, workspace-relative targets to capture. */
  readonly targets: readonly CaptureTarget[];
  /** Optional Git base ref (git-ref backend anchors to it). */
  readonly baseRef?: string;
  /** Directory under which the immutable artifact is written (content-addressed). */
  readonly artifactRoot: string;
  /** Injectable clock (tests). */
  readonly now?: () => Date;
}

/** The result of a backend capture: one immutable, verifiable artifact. */
export interface BackendArtifact {
  readonly backendType: CheckpointBackendType;
  readonly backendVersion: number;
  /** Opaque content-addressed reference (a directory name under artifactRoot). */
  readonly artifactRef: string;
  /** Absolute path to the artifact directory (never persisted in the record). */
  readonly artifactPath: string;
  /** The hashed prior-existence manifest for the captured targets. */
  readonly manifest: readonly CheckpointManifestEntry[];
  /** Digest over the artifact contents + manifest; the immutability anchor. */
  readonly artifactDigest: string;
  /** Optional base ref echoed back for the record (git-ref backend). */
  readonly baseRef?: string;
}

/**
 * A checkpoint backend adapter. Every adapter captures the pre-state into
 * exactly one content-addressed immutable artifact, can verify that artifact's
 * integrity, and can stage-restore it beside the target BEFORE any destructive
 * promotion (D-12/D-14). Adapters never author checkpoint records
 * (NN-CHECKPOINT-002) — the CheckpointService is the sole writer.
 */
export interface CheckpointBackend {
  readonly backendType: CheckpointBackendType;
  readonly backendVersion: number;

  /** Capture the pre-state into one immutable artifact and its manifest. */
  capture(request: BackendCaptureRequest): BackendArtifact;

  /**
   * Verify an artifact's integrity: recompute its content digest and confirm it
   * equals the recorded `artifactDigest` and that the stored bytes hash to the
   * manifest's `capturedSha256` values. Returns `true` when intact.
   */
  verify(input: {
    readonly artifactPath: string;
    readonly manifest: readonly CheckpointManifestEntry[];
    readonly artifactDigest: string;
  }): boolean;

  /**
   * Materialize the captured bytes into a staging directory beside the target
   * (never overwriting the live root directly; D-12/D-14). Returns the map of
   * relative path -> staged absolute path plus deletions (files that were
   * absent at capture and must be removed on promotion).
   */
  stageRestore(input: {
    readonly artifactPath: string;
    readonly manifest: readonly CheckpointManifestEntry[];
    readonly stagingRoot: string;
  }): {
    readonly staged: ReadonlyMap<string, string>;
    readonly deletions: readonly string[];
  };
}

// ─── Retention policy (NN-CHECKPOINT-010 / NN-DATA-007) ──────────────────────

/**
 * Per-class retention policy. `default` file checkpoints keep the latest N
 * (default 50); `turn` refs age out after `turnMaxAgeMs` (default 30 days).
 * Pinned, `rescue`, and `legal-hold` records are NEVER pruned contrary to
 * policy (NN-DATA-007 / NN-CHECKPOINT-010).
 */
export interface RetentionPolicy {
  readonly defaultMaxCount: number;
  readonly turnMaxAgeMs: number;
}

/** The canonical defaults from NN-CHECKPOINT-010. */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = Object.freeze({
  defaultMaxCount: 50,
  turnMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
});

/** Whether a checkpoint class is protected from pruning (NN-DATA-007). */
export function isProtectedFromPruning(record: {
  readonly pinned: boolean;
  readonly retentionClass: RetentionClass;
  readonly source: CheckpointSource;
}): boolean {
  return (
    record.pinned ||
    record.retentionClass === 'rescue' ||
    record.retentionClass === 'legal-hold' ||
    record.source === 'rescue'
  );
}

/** Re-exported for adapters that build scoped identity. */
export type { ScopeDescriptor };
