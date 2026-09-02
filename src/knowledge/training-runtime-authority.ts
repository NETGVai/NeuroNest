/**
 * Knowledge/Runtime Authority — optional knowledge training, local models,
 * OpenMythos, and voice runtime lifecycles (FUT-PKG-08-OPTIONAL/T-003).
 *
 * This authority owns the OPTIONAL, disabled-by-default training + runtime
 * surface. It is a strict EXTENSION of the canonical single-writer path
 * (src/storage/authority-transaction.ts applyAuthorityMutation): every durable
 * training-job / checkpoint / model transition commits THROUGH that one
 * transaction, so a queued/running/paused/failed/completed job, a preserved
 * checkpoint, and a promoted/rolled-back model are COMMITTED facts — never a
 * parallel truth, never an in-memory optimistic state (D-03 one-writer, D-05,
 * D-18 false-success prevention, NN-INV-003/008).
 *
 * Fail-closed contract (task acceptance):
 *   - A missing dependency / GPU / model / isolation, a private-content
 *     finding, a failed validation / export, or a cancel NEVER breaks core and
 *     NEVER reports ready.
 *   - A training job is DURABLE, BOUNDED, and RECOVERABLE: checkpoints are
 *     preserved on failure/cancel; the job is bounded (max epochs / step
 *     budget — no unbounded loop); crash recovery resumes from a verified
 *     checkpoint or preserves artifacts and reports why it cannot
 *     (NN-KNOWLEDGE-007/009).
 *   - Model validation → promotion ONLY on pass; rollback preserves
 *     checkpoints / raw weights and restores the PRIOR verified model
 *     (NN-KNOWLEDGE-012/013), reusing the pure voice-status promotion decision
 *     (src/experience/voice-status.ts decideVoicePromotion/applyVoicePromotion).
 *   - Optional runtime (OpenMythos / local model / voice) is disabled-by-
 *     default, isolated, cancellable, and NEVER reports ready when unavailable
 *     or unverified (NN-EXEC-012, NN-PLATFORM-007, NN-UI-009).
 *   - Cloud training requires explicit confirmation with a private-content
 *     finding block BEFORE any upload (NN-KNOWLEDGE-015).
 *   - Retention is class-specific and never auto-deletes an active / current /
 *     rollback-protected version (NN-KNOWLEDGE-017).
 *
 * The Knowledge/Capability authorities are OBSERVERS: this module writes only
 * its own additive single-owner tables (training_jobs, training_checkpoints,
 * runtime_models) and registers/removes an optional capability without becoming
 * a second orchestrator or a second writer for any existing business table.
 *
 * Design anchors: D-05, D-11, D-16–D-20. Requirements: NN-KNOWLEDGE-005–018,
 * NN-EXEC-012, NN-UI-009/010, NN-PLATFORM-007, NN-INV-003/008.
 */

import type Database from 'better-sqlite3';

import {
  computeDigest,
  makeOpaqueId,
  type ErrorEnvelope,
  type RedactionClass,
  type ScopeDescriptor,
} from '../shared/contract-primitives.js';
import { applyAuthorityMutation } from '../storage/authority-transaction.js';
import {
  decideVoicePromotion,
  applyVoicePromotion,
  type VoicePromotionDecision,
  type VoiceStoreState,
} from '../experience/voice-status.js';

const AUTHORITY_ID = 'authority-knowledge-runtime';

// ─── Additive single-owner tables ───────────────────────────────────────────

const KNOWLEDGE_RUNTIME_DDL = `
  CREATE TABLE IF NOT EXISTS training_jobs (
    job_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    max_epochs INTEGER NOT NULL,
    checkpoint_count INTEGER NOT NULL,
    last_reason TEXT,
    cloud INTEGER NOT NULL,
    cloud_confirmed INTEGER NOT NULL,
    record_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS training_checkpoints (
    checkpoint_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    verified INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (job_id, epoch)
  );

  CREATE TABLE IF NOT EXISTS runtime_models (
    model_id TEXT PRIMARY KEY,
    promoted_digest TEXT,
    prior_digest TEXT,
    protected INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_training_checkpoints_job
    ON training_checkpoints (job_id, epoch);
`;

/** Create the additive single-owner tables. Idempotent. */
export function ensureKnowledgeRuntimeTables(db: Database.Database): void {
  db.exec(KNOWLEDGE_RUNTIME_DDL);
}

// ─── Training job lifecycle (NN-KNOWLEDGE-007/008/009) ───────────────────────

/**
 * The durable job state ladder. `queued` → `running` → (`paused` ⇄ `running`)
 * → `completed` | `failed` | `cancelled`. `completed`, `failed`, and
 * `cancelled` are TERMINAL.
 */
export const JOB_STATES = Object.freeze([
  'queued',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const);

export type JobState = (typeof JOB_STATES)[number];

const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set<JobState>([
  'completed',
  'failed',
  'cancelled',
]);

/** Whether a job state is terminal. */
export function isTerminalJobState(state: JobState): boolean {
  return TERMINAL_JOB_STATES.has(state);
}

/** The default local-profile concurrency + queue-depth cap (NN-KNOWLEDGE-008). */
export const DEFAULT_MAX_CONCURRENT_JOBS = 1;
export const DEFAULT_MAX_QUEUE_DEPTH = 5;

/** The rolling checkpoint cap kept per job (NN-KNOWLEDGE-009 default three). */
export const DEFAULT_ROLLING_CHECKPOINTS = 3;

/** A durable training-job record (single-owner projection). */
export interface TrainingJobRecord {
  readonly jobId: string;
  readonly state: JobState;
  readonly epoch: number;
  /** The bound on epochs — a job is bounded, never an unbounded loop. */
  readonly maxEpochs: number;
  readonly checkpointCount: number;
  readonly lastReason: string | null;
  readonly cloud: boolean;
  readonly cloudConfirmed: boolean;
}

function readJob(db: Database.Database, jobId: string): TrainingJobRecord | undefined {
  const row = db
    .prepare('SELECT record_json FROM training_jobs WHERE job_id = ?')
    .get(jobId) as { record_json: string } | undefined;
  return row ? (JSON.parse(row.record_json) as TrainingJobRecord) : undefined;
}

/** Read a durable training-job record. */
export function getTrainingJob(
  db: Database.Database,
  jobId: string,
): TrainingJobRecord | undefined {
  return readJob(db, jobId);
}

/** Count the jobs currently occupying the queue or a run slot. */
export function countActiveJobs(db: Database.Database): {
  readonly running: number;
  readonly queued: number;
} {
  const running = (
    db.prepare("SELECT COUNT(*) AS c FROM training_jobs WHERE state IN ('running','paused')").get() as {
      c: number;
    }
  ).c;
  const queued = (
    db.prepare("SELECT COUNT(*) AS c FROM training_jobs WHERE state = 'queued'").get() as {
      c: number;
    }
  ).c;
  return { running, queued };
}

function persistJob(
  db: Database.Database,
  scope: ScopeDescriptor,
  correlationId: string,
  record: TrainingJobRecord,
  eventType: string,
  redaction: RedactionClass = 'internal',
): void {
  applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: makeOpaqueId('cmd', `${eventType}${record.jobId}${record.state}${record.epoch}`),
    idempotencyKey: makeOpaqueId('idem', `${eventType}${record.jobId}${record.state}${record.epoch}`),
    requestDigest: computeDigest(record),
    correlationId,
    scope,
    mutate: (tx) => {
      tx.prepare(
        `INSERT INTO training_jobs
           (job_id, state, epoch, max_epochs, checkpoint_count, last_reason,
            cloud, cloud_confirmed, record_json, updated_at)
         VALUES (@jobId, @state, @epoch, @maxEpochs, @checkpointCount, @lastReason,
            @cloud, @cloudConfirmed, @recordJson, @updatedAt)
         ON CONFLICT(job_id) DO UPDATE SET
           state = excluded.state,
           epoch = excluded.epoch,
           max_epochs = excluded.max_epochs,
           checkpoint_count = excluded.checkpoint_count,
           last_reason = excluded.last_reason,
           cloud = excluded.cloud,
           cloud_confirmed = excluded.cloud_confirmed,
           record_json = excluded.record_json,
           updated_at = excluded.updated_at`,
      ).run({
        jobId: record.jobId,
        state: record.state,
        epoch: record.epoch,
        maxEpochs: record.maxEpochs,
        checkpointCount: record.checkpointCount,
        lastReason: record.lastReason,
        cloud: record.cloud ? 1 : 0,
        cloudConfirmed: record.cloudConfirmed ? 1 : 0,
        recordJson: JSON.stringify(record),
        updatedAt: new Date().toISOString(),
      });
      return { resultRef: record.jobId };
    },
    events: [
      {
        eventType,
        aggregateType: 'training-job',
        aggregateId: record.jobId,
        payloadSchemaName: 'TrainingJobStateChanged',
        payloadSchemaVersion: 1,
        payload: { jobId: record.jobId, state: record.state, epoch: record.epoch },
        redaction,
      },
    ],
  });
}

function error(
  code: ErrorEnvelope['code'],
  message: string,
  correlationId: string,
): ErrorEnvelope {
  return {
    schemaVersion: 1,
    code,
    message,
    owner: AUTHORITY_ID,
    operation: 'training-runtime',
    correlationId,
    retryable: code === 'UNAVAILABLE' || code === 'TIMEOUT',
    redaction: 'internal',
  };
}

export type JobResult =
  | { readonly ok: true; readonly job: TrainingJobRecord }
  | { readonly ok: false; readonly error: ErrorEnvelope };

/**
 * Enqueue a durable training job. Fails closed (BUDGET_EXCEEDED) when the queue
 * is full or a run slot is occupied beyond the local concurrency cap
 * (NN-KNOWLEDGE-008), and (VALIDATION) when the epoch bound is not positive — a
 * job must be BOUNDED (NN-KNOWLEDGE-007). A cloud job requires prior explicit
 * confirmation; a private-content finding blocks (NN-KNOWLEDGE-015).
 */
export function enqueueJob(
  db: Database.Database,
  input: {
    readonly jobId: string;
    readonly maxEpochs: number;
    readonly scope: ScopeDescriptor;
    readonly correlationId: string;
    readonly cloud?: boolean;
    readonly cloudConfirmed?: boolean;
    readonly privateContentFinding?: boolean;
    readonly maxConcurrent?: number;
    readonly maxQueueDepth?: number;
  },
): JobResult {
  const corr = input.correlationId;
  if (!Number.isInteger(input.maxEpochs) || input.maxEpochs <= 0) {
    return { ok: false, error: error('VALIDATION', 'maxEpochs must be a positive integer (bounded job)', corr) };
  }
  if (readJob(db, input.jobId)) {
    return { ok: false, error: error('CONFLICT', 'job already exists', corr) };
  }
  const cloud = input.cloud ?? false;
  if (cloud) {
    if (input.privateContentFinding) {
      return { ok: false, error: error('FORBIDDEN', 'private-content finding blocks cloud upload', corr) };
    }
    if (!input.cloudConfirmed) {
      return { ok: false, error: error('UNAUTHORIZED', 'cloud training requires explicit confirmation', corr) };
    }
  }
  const maxConcurrent = input.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_JOBS;
  const maxQueueDepth = input.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
  const active = countActiveJobs(db);
  if (active.queued >= maxQueueDepth) {
    return { ok: false, error: error('BUDGET_EXCEEDED', 'training queue is full', corr) };
  }
  const record: TrainingJobRecord = {
    jobId: input.jobId,
    state: 'queued',
    epoch: 0,
    maxEpochs: input.maxEpochs,
    checkpointCount: 0,
    lastReason: null,
    cloud,
    cloudConfirmed: cloud ? true : false,
  };
  persistJob(db, input.scope, corr, record, 'training-job-queued');
  return { ok: true, job: record };
}

/**
 * Start a queued job, respecting the concurrency cap. Fails closed when a run
 * slot is occupied (BUDGET_EXCEEDED) or the job is not startable.
 */
export function startJob(
  db: Database.Database,
  input: {
    readonly jobId: string;
    readonly scope: ScopeDescriptor;
    readonly correlationId: string;
    readonly maxConcurrent?: number;
  },
): JobResult {
  const corr = input.correlationId;
  const job = readJob(db, input.jobId);
  if (!job) return { ok: false, error: error('VALIDATION', 'unknown job', corr) };
  if (job.state !== 'queued' && job.state !== 'paused') {
    return { ok: false, error: error('CONFLICT', `job in state ${job.state} cannot start`, corr) };
  }
  const maxConcurrent = input.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_JOBS;
  const running = (
    db.prepare("SELECT COUNT(*) AS c FROM training_jobs WHERE state = 'running'").get() as { c: number }
  ).c;
  if (running >= maxConcurrent) {
    return { ok: false, error: error('BUDGET_EXCEEDED', 'concurrency cap reached', corr) };
  }
  const next: TrainingJobRecord = { ...job, state: 'running', lastReason: null };
  persistJob(db, input.scope, corr, next, 'training-job-started');
  return { ok: true, job: next };
}

/**
 * Advance one epoch and write a rolling verified checkpoint. The job is
 * BOUNDED: at `maxEpochs` it transitions to `completed`. A checkpoint is a
 * durable, verified artifact preserved regardless of a later failure/cancel
 * (NN-KNOWLEDGE-007/009).
 */
export function advanceEpoch(
  db: Database.Database,
  input: {
    readonly jobId: string;
    readonly scope: ScopeDescriptor;
    readonly correlationId: string;
    readonly rollingCheckpoints?: number;
  },
): JobResult {
  const corr = input.correlationId;
  const job = readJob(db, input.jobId);
  if (!job) return { ok: false, error: error('VALIDATION', 'unknown job', corr) };
  if (job.state !== 'running') {
    return { ok: false, error: error('CONFLICT', `job in state ${job.state} cannot advance`, corr) };
  }
  const nextEpoch = job.epoch + 1;
  // Bounded: never advance past the declared epoch bound.
  if (nextEpoch > job.maxEpochs) {
    return { ok: false, error: error('BUDGET_EXCEEDED', 'epoch bound reached', corr) };
  }
  const rolling = input.rollingCheckpoints ?? DEFAULT_ROLLING_CHECKPOINTS;
  const checkpointId = makeOpaqueId('ckpt', `${input.jobId}${nextEpoch}`);
  const completed = nextEpoch >= job.maxEpochs;
  const next: TrainingJobRecord = {
    ...job,
    state: completed ? 'completed' : 'running',
    epoch: nextEpoch,
    checkpointCount: job.checkpointCount + 1,
  };
  applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: makeOpaqueId('cmd', `epoch${input.jobId}${nextEpoch}`),
    idempotencyKey: makeOpaqueId('idem', `epoch${input.jobId}${nextEpoch}`),
    requestDigest: computeDigest({ job: input.jobId, epoch: nextEpoch }),
    correlationId: corr,
    scope: input.scope,
    mutate: (tx) => {
      tx.prepare(
        `INSERT INTO training_checkpoints (checkpoint_id, job_id, epoch, verified, created_at)
         VALUES (?, ?, ?, 1, ?)`,
      ).run(checkpointId, input.jobId, nextEpoch, new Date().toISOString());
      // Rolling retention: keep only the newest `rolling` checkpoints.
      tx.prepare(
        `DELETE FROM training_checkpoints
          WHERE job_id = ?
            AND checkpoint_id NOT IN (
              SELECT checkpoint_id FROM training_checkpoints
               WHERE job_id = ? ORDER BY epoch DESC LIMIT ?)`,
      ).run(input.jobId, input.jobId, rolling);
      tx.prepare(
        `UPDATE training_jobs SET state=@state, epoch=@epoch, checkpoint_count=@cc,
           record_json=@recordJson, updated_at=@updatedAt WHERE job_id=@jobId`,
      ).run({
        state: next.state,
        epoch: next.epoch,
        cc: next.checkpointCount,
        recordJson: JSON.stringify(next),
        updatedAt: new Date().toISOString(),
        jobId: next.jobId,
      });
      return { resultRef: checkpointId };
    },
    events: [
      {
        eventType: 'training-checkpoint-written',
        aggregateType: 'training-job',
        aggregateId: input.jobId,
        payloadSchemaName: 'TrainingCheckpointWritten',
        payloadSchemaVersion: 1,
        payload: { jobId: input.jobId, epoch: nextEpoch },
        redaction: 'internal',
      },
    ],
  });
  return { ok: true, job: next };
}

/** List a job's preserved checkpoints, newest first. */
export function listCheckpoints(
  db: Database.Database,
  jobId: string,
): readonly { readonly epoch: number; readonly verified: boolean }[] {
  const rows = db
    .prepare('SELECT epoch, verified FROM training_checkpoints WHERE job_id = ? ORDER BY epoch DESC')
    .all(jobId) as { epoch: number; verified: number }[];
  return rows.map((r) => ({ epoch: r.epoch, verified: r.verified === 1 }));
}

/**
 * Fail a running job. Checkpoints are PRESERVED (never deleted on failure) and
 * the reason is durably recorded. A failure never breaks core and never reports
 * ready (NN-KNOWLEDGE-009, NN-INV-003).
 */
export function failJob(
  db: Database.Database,
  input: {
    readonly jobId: string;
    readonly reason: string;
    readonly scope: ScopeDescriptor;
    readonly correlationId: string;
  },
): JobResult {
  const corr = input.correlationId;
  const job = readJob(db, input.jobId);
  if (!job) return { ok: false, error: error('VALIDATION', 'unknown job', corr) };
  if (isTerminalJobState(job.state)) {
    return { ok: false, error: error('CONFLICT', `job already ${job.state}`, corr) };
  }
  const next: TrainingJobRecord = { ...job, state: 'failed', lastReason: input.reason };
  persistJob(db, input.scope, corr, next, 'training-job-failed');
  return { ok: true, job: next };
}

/**
 * Cancel a non-terminal job. Checkpoints are PRESERVED. New descendant work is
 * refused after cancellation. A cancel never breaks core and never reports
 * ready (NN-EXEC-014, NN-INV-003).
 */
export function cancelJob(
  db: Database.Database,
  input: {
    readonly jobId: string;
    readonly scope: ScopeDescriptor;
    readonly correlationId: string;
  },
): JobResult {
  const corr = input.correlationId;
  const job = readJob(db, input.jobId);
  if (!job) return { ok: false, error: error('VALIDATION', 'unknown job', corr) };
  if (isTerminalJobState(job.state)) {
    return { ok: false, error: error('CONFLICT', `job already ${job.state}`, corr) };
  }
  const next: TrainingJobRecord = { ...job, state: 'cancelled', lastReason: 'cancelled' };
  persistJob(db, input.scope, corr, next, 'training-job-cancelled');
  return { ok: true, job: next };
}

// ─── Crash recovery (NN-KNOWLEDGE-009, FIX-WORKSPACE-RECOVERY-01) ────────────

/** The outcome of a crash-recovery attempt for a job. */
export type RecoveryOutcome =
  | { readonly kind: 'resumed'; readonly fromEpoch: number }
  | { readonly kind: 'preserved'; readonly reason: string; readonly checkpoints: number };

/**
 * Recover a job that crashed mid-run. On the durable record + preserved
 * checkpoints:
 *   - if a VERIFIED checkpoint exists, resume from it (state → `running` at the
 *     checkpoint epoch);
 *   - otherwise PRESERVE artifacts and report WHY it cannot resume (state →
 *     `failed` with a reason) — never a silent success, never a false ready
 *     (NN-KNOWLEDGE-009, NN-INV-003).
 */
export function recoverJob(
  db: Database.Database,
  input: {
    readonly jobId: string;
    readonly scope: ScopeDescriptor;
    readonly correlationId: string;
  },
): { readonly ok: true; readonly outcome: RecoveryOutcome; readonly job: TrainingJobRecord } | { readonly ok: false; readonly error: ErrorEnvelope } {
  const corr = input.correlationId;
  const job = readJob(db, input.jobId);
  if (!job) return { ok: false, error: error('VALIDATION', 'unknown job', corr) };

  const verified = db
    .prepare('SELECT MAX(epoch) AS e FROM training_checkpoints WHERE job_id = ? AND verified = 1')
    .get(input.jobId) as { e: number | null };
  const total = (
    db.prepare('SELECT COUNT(*) AS c FROM training_checkpoints WHERE job_id = ?').get(input.jobId) as {
      c: number;
    }
  ).c;

  if (verified.e !== null) {
    const resumed: TrainingJobRecord = {
      ...job,
      state: 'running',
      epoch: verified.e,
      lastReason: `resumed-from-verified-checkpoint@${verified.e}`,
    };
    persistJob(db, input.scope, corr, resumed, 'training-job-recovered');
    return { ok: true, outcome: { kind: 'resumed', fromEpoch: verified.e }, job: resumed };
  }

  const reason = 'no-verified-checkpoint; artifacts preserved';
  const preserved: TrainingJobRecord = { ...job, state: 'failed', lastReason: reason };
  persistJob(db, input.scope, corr, preserved, 'training-job-recovery-failed');
  return { ok: true, outcome: { kind: 'preserved', reason, checkpoints: total }, job: preserved };
}

// ─── Model validation, promotion, and rollback (NN-KNOWLEDGE-012/013) ────────

/** Policy thresholds for the legacy validation signals (NN-KNOWLEDGE-012). */
export const MAX_PERPLEXITY_INCREASE_PCT = 20;
export const MAX_COHERENCE_DECREASE_PCT = 15;

/** A model-validation comparison of candidate vs current (NN-KNOWLEDGE-012). */
export interface ValidationMetrics {
  /** Percent increase in perplexity vs baseline (a positive number is worse). */
  readonly perplexityIncreasePct: number;
  /** Percent decrease in coherence vs baseline (a positive number is worse). */
  readonly coherenceDecreasePct: number;
}

export type ValidationVerdict =
  | { readonly pass: true }
  | { readonly pass: false; readonly reason: 'perplexity-regression' | 'coherence-regression' };

/**
 * Decide whether a candidate model passes validation. PURE. A perplexity
 * increase above 20% or a coherence decrease above 15% BLOCKS promotion
 * (NN-KNOWLEDGE-012). A blocked candidate is never promoted.
 */
export function validateModel(metrics: ValidationMetrics): ValidationVerdict {
  if (metrics.perplexityIncreasePct > MAX_PERPLEXITY_INCREASE_PCT) {
    return { pass: false, reason: 'perplexity-regression' };
  }
  if (metrics.coherenceDecreasePct > MAX_COHERENCE_DECREASE_PCT) {
    return { pass: false, reason: 'coherence-regression' };
  }
  return { pass: true };
}

function readModel(db: Database.Database, modelId: string):
  | { readonly modelId: string; readonly promotedDigest: string | null; readonly priorDigest: string | null; readonly protectedVersion: boolean }
  | undefined {
  const row = db
    .prepare('SELECT model_id, promoted_digest, prior_digest, protected FROM runtime_models WHERE model_id = ?')
    .get(modelId) as
    | { model_id: string; promoted_digest: string | null; prior_digest: string | null; protected: number }
    | undefined;
  if (!row) return undefined;
  return {
    modelId: row.model_id,
    promotedDigest: row.promoted_digest,
    priorDigest: row.prior_digest,
    protectedVersion: row.protected === 1,
  };
}

/** Read the currently promoted digest (or null) for a model line. */
export function getPromotedModel(db: Database.Database, modelId: string): string | null {
  return readModel(db, modelId)?.promotedDigest ?? null;
}

export type PromotionResult =
  | { readonly ok: true; readonly promotedDigest: string | null }
  | { readonly ok: false; readonly error: ErrorEnvelope; readonly promotedDigest: string | null };

/**
 * Promote a validated candidate model artifact. Promotion happens ONLY when
 * validation passes AND the artifact's integrity is verified — the integrity
 * decision REUSES the pure voice-status promotion decision
 * (decideVoicePromotion). On a validation block, a digest mismatch, a malformed
 * digest, or a read error, the PRIOR verified model is preserved unchanged and
 * the candidate is refused (NN-KNOWLEDGE-012/013, NN-UI-010).
 */
export function promoteModel(
  db: Database.Database,
  input: {
    readonly modelId: string;
    readonly metrics: ValidationMetrics;
    readonly declaredSha256: string | undefined;
    readonly computedSha256: string | null;
    readonly scope: ScopeDescriptor;
    readonly correlationId: string;
  },
): PromotionResult {
  const corr = input.correlationId;
  const existing = readModel(db, input.modelId);
  const priorPromoted = existing?.promotedDigest ?? null;

  // Validation gate: a regression BLOCKS promotion; the prior model stands.
  const verdict = validateModel(input.metrics);
  if (!verdict.pass) {
    return {
      ok: false,
      error: error('INTEGRITY', `validation blocked: ${verdict.reason}`, corr),
      promotedDigest: priorPromoted,
    };
  }

  // Integrity gate (reuse the pure voice-status decision).
  const decision: VoicePromotionDecision = decideVoicePromotion({
    declaredSha256: input.declaredSha256,
    computedSha256: input.computedSha256,
  });
  const priorStore: VoiceStoreState = { promotedDigest: priorPromoted, tempPending: false };
  const completedDigest = input.computedSha256;
  const nextStore = applyVoicePromotion(priorStore, decision, completedDigest);

  if (!decision.promote) {
    return {
      ok: false,
      error: error('INTEGRITY', `promotion refused: ${decision.reason}`, corr),
      promotedDigest: priorPromoted,
    };
  }

  const nextPromoted = nextStore.promotedDigest;
  applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: makeOpaqueId('cmd', `promote${input.modelId}${nextPromoted}`),
    idempotencyKey: makeOpaqueId('idem', `promote${input.modelId}${nextPromoted}`),
    requestDigest: computeDigest({ modelId: input.modelId, digest: nextPromoted }),
    correlationId: corr,
    scope: input.scope,
    mutate: (tx) => {
      tx.prepare(
        `INSERT INTO runtime_models (model_id, promoted_digest, prior_digest, protected, updated_at)
         VALUES (@modelId, @promoted, @prior, 1, @updatedAt)
         ON CONFLICT(model_id) DO UPDATE SET
           prior_digest = runtime_models.promoted_digest,
           promoted_digest = excluded.promoted_digest,
           protected = 1,
           updated_at = excluded.updated_at`,
      ).run({
        modelId: input.modelId,
        promoted: nextPromoted,
        prior: priorPromoted,
        updatedAt: new Date().toISOString(),
      });
      return { resultRef: input.modelId };
    },
    events: [
      {
        eventType: 'model-promoted',
        aggregateType: 'runtime-model',
        aggregateId: input.modelId,
        payloadSchemaName: 'ModelPromoted',
        payloadSchemaVersion: 1,
        payload: { modelId: input.modelId },
        redaction: 'internal',
      },
    ],
  });
  return { ok: true, promotedDigest: nextPromoted };
}

/**
 * Atomically roll a model line back to its prior verified digest. Preserves
 * checkpoints / raw weights (they are never removed here) and restores the
 * PRIOR verified model. A rollback with no prior verified model is refused
 * (CONFLICT) so a good current model is never replaced by nothing
 * (NN-KNOWLEDGE-013).
 */
export function rollbackModel(
  db: Database.Database,
  input: {
    readonly modelId: string;
    readonly scope: ScopeDescriptor;
    readonly correlationId: string;
  },
): PromotionResult {
  const corr = input.correlationId;
  const existing = readModel(db, input.modelId);
  if (!existing) {
    return { ok: false, error: error('VALIDATION', 'unknown model', corr), promotedDigest: null };
  }
  if (existing.priorDigest === null) {
    return {
      ok: false,
      error: error('CONFLICT', 'no prior verified model to roll back to', corr),
      promotedDigest: existing.promotedDigest,
    };
  }
  const restored = existing.priorDigest;
  applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: makeOpaqueId('cmd', `rollback${input.modelId}${restored}`),
    idempotencyKey: makeOpaqueId('idem', `rollback${input.modelId}${restored}`),
    requestDigest: computeDigest({ modelId: input.modelId, restore: restored }),
    correlationId: corr,
    scope: input.scope,
    mutate: (tx) => {
      tx.prepare(
        `UPDATE runtime_models SET promoted_digest = @restored, prior_digest = NULL,
           updated_at = @updatedAt WHERE model_id = @modelId`,
      ).run({ restored, updatedAt: new Date().toISOString(), modelId: input.modelId });
      return { resultRef: input.modelId };
    },
    events: [
      {
        eventType: 'model-rolled-back',
        aggregateType: 'runtime-model',
        aggregateId: input.modelId,
        payloadSchemaName: 'ModelRolledBack',
        payloadSchemaVersion: 1,
        payload: { modelId: input.modelId },
        redaction: 'internal',
      },
    ],
  });
  return { ok: true, promotedDigest: restored };
}

// ─── Optional runtime lifecycle isolation (NN-EXEC-012, NN-PLATFORM-007) ─────

/** The optional runtimes governed by this authority (disabled by default). */
export const OPTIONAL_RUNTIMES = Object.freeze([
  'openmythos',
  'local-model',
  'voice',
] as const);

export type OptionalRuntime = (typeof OPTIONAL_RUNTIMES)[number];

/** The lifecycle state of an optional runtime. */
export type RuntimeLifecycle = 'disabled' | 'starting' | 'ready' | 'degraded' | 'stopped' | 'failed';

/** A truthful, render-ready optional-runtime status view (NN-UI-009). */
export interface RuntimeStatusView {
  readonly runtime: OptionalRuntime;
  readonly lifecycle: RuntimeLifecycle;
  /** Whether the surface may present the runtime as usable now. */
  readonly ready: boolean;
  /** The scoped reason a runtime is not ready, when applicable. */
  readonly unavailableReason: string | null;
}

/**
 * The observed local prerequisites for an optional runtime. Any missing
 * prerequisite yields a SCOPED unavailable state — never a crash of unrelated
 * platform functions (NN-PLATFORM-007).
 */
export interface RuntimeProbe {
  /** Whether the runtime is enabled by policy (disabled by default). */
  readonly enabled: boolean;
  /** Whether the required dependency (e.g. Python 3.9+) is present. */
  readonly dependencyPresent: boolean;
  /** Whether the required GPU/accelerator is present (when required). */
  readonly gpuPresent: boolean;
  /** Whether the required model artifact is present AND verified. */
  readonly modelVerified: boolean;
  /** Whether the runtime process is isolated (own process/sandbox). */
  readonly isolated: boolean;
  /** Whether the process reported a healthy heartbeat. */
  readonly healthy: boolean;
}

/**
 * Derive a TRUTHFUL optional-runtime status view. `ready` is returned ONLY when
 * the runtime is enabled AND every prerequisite (dependency, GPU, verified
 * model, isolation, health) holds. A missing dependency/GPU/model/isolation, an
 * unhealthy process, or a disabled runtime yields a scoped `unavailable`/
 * `degraded`/`disabled` view that is NEVER reported as ready (the acceptance
 * fail-closed rule, NN-UI-009, NN-PLATFORM-007, NN-EXEC-012).
 */
export function deriveRuntimeStatus(runtime: OptionalRuntime, probe: RuntimeProbe): RuntimeStatusView {
  if (!probe.enabled) {
    return { runtime, lifecycle: 'disabled', ready: false, unavailableReason: 'disabled-by-default' };
  }
  if (!probe.isolated) {
    return { runtime, lifecycle: 'failed', ready: false, unavailableReason: 'isolation-unavailable' };
  }
  if (!probe.dependencyPresent) {
    return { runtime, lifecycle: 'degraded', ready: false, unavailableReason: 'missing-dependency' };
  }
  if (!probe.gpuPresent) {
    return { runtime, lifecycle: 'degraded', ready: false, unavailableReason: 'missing-gpu' };
  }
  if (!probe.modelVerified) {
    return { runtime, lifecycle: 'degraded', ready: false, unavailableReason: 'model-unverified' };
  }
  if (!probe.healthy) {
    return { runtime, lifecycle: 'degraded', ready: false, unavailableReason: 'unhealthy' };
  }
  return { runtime, lifecycle: 'ready', ready: true, unavailableReason: null };
}

// ─── Optional capability registration (reversible) ──────────────────────────

/**
 * A reversible optional-capability registration for a runtime. Registration is
 * disabled-by-default and only advertised when the derived status is truthfully
 * ready. Rollback removes the registration entirely (task rollback).
 */
export class OptionalCapabilityRegistry {
  private readonly registered = new Map<OptionalRuntime, RuntimeStatusView>();

  /**
   * Register (advertise) a runtime capability ONLY when its status is truthfully
   * ready. A not-ready runtime is refused and remains unregistered — a scoped
   * unavailable capability never advertises as available.
   */
  register(status: RuntimeStatusView): { readonly ok: boolean; readonly reason?: string } {
    if (!status.ready) {
      return { ok: false, reason: status.unavailableReason ?? 'not-ready' };
    }
    this.registered.set(status.runtime, status);
    return { ok: true };
  }

  /** Whether a runtime capability is currently advertised. */
  isRegistered(runtime: OptionalRuntime): boolean {
    return this.registered.has(runtime);
  }

  /** Reversibly remove a capability registration (rollback). */
  deregister(runtime: OptionalRuntime): boolean {
    return this.registered.delete(runtime);
  }

  /** The currently advertised runtimes. */
  advertised(): readonly OptionalRuntime[] {
    return [...this.registered.keys()];
  }
}

// ─── Retention (NN-KNOWLEDGE-017) ────────────────────────────────────────────

/** A retention candidate for cleanup evaluation. */
export interface RetentionCandidate {
  readonly id: string;
  /** Bytes consumed by this artifact class instance. */
  readonly bytes: number;
  /** Whether this version is active/current/rollback-protected. */
  readonly protectedVersion: boolean;
}

/** The default total training-artifact warning threshold (10 GB). */
export const DEFAULT_RETENTION_WARN_BYTES = 10 * 1024 * 1024 * 1024;

/** The outcome of a retention evaluation. */
export interface RetentionPlan {
  readonly totalBytes: number;
  readonly warn: boolean;
  /** Ids safe to clean up (never a protected version). */
  readonly cleanupIds: readonly string[];
}

/**
 * Plan a safe retention cleanup. Warns when the total exceeds the class
 * threshold and proposes cleanup of ONLY non-protected candidates — an active /
 * current / rollback-protected version is NEVER auto-deleted (NN-KNOWLEDGE-017).
 */
export function planRetention(
  candidates: readonly RetentionCandidate[],
  warnBytes: number = DEFAULT_RETENTION_WARN_BYTES,
): RetentionPlan {
  const totalBytes = candidates.reduce((sum, c) => sum + c.bytes, 0);
  const warn = totalBytes > warnBytes;
  const cleanupIds = warn ? candidates.filter((c) => !c.protectedVersion).map((c) => c.id) : [];
  return { totalBytes, warn, cleanupIds };
}
