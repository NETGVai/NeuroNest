/**
 * TranscriptRewindService — the SEPARATE, digest-bound, lineage-preserving chat
 * transcript rewind (FUT-PKG-05-RECOVERY/T-004).
 *
 * NN-CHECKPOINT-008 fixes the separation exactly: "Workspace restore and
 * transcript rewind are separate operations. Rewinding chat requires a second
 * explicit confirmation bound to the target turn, a separate idempotent
 * transaction, and preserved audit/branch lineage; workspace restore alone
 * SHALL NOT silently delete messages." NN-CHAT-009/010 add: edit/retry/branch/
 * fork/regenerate SHALL preserve immutable parent/provenance and retain prior
 * output; typed recovery preserves semantic anchor and never shows false
 * success.
 *
 * This module is that separate operation. It is NOT called by
 * {@link ./restore-service}; a workspace restore performed there never touches
 * the transcript. A rewind here:
 *
 *   1. is SEPARATELY AUTHORIZED by a SECOND explicit confirmation whose digest
 *      is bound to the exact target turn (turn id + turn digest + branch). A
 *      missing, stale, or mismatched confirmation digest is refused with a typed
 *      error and produces NO effect (no blind retry, NN-CHECKPOINT-008);
 *   2. is a SEPARATE idempotent transaction routed through the FUT-PKG-03-
 *      DURABILITY/T-001 authority transaction (business row + `CommandReceipt@1`
 *      + one `OutboxRecord@1` committed atomically). A retry with the same
 *      idempotency key returns the identical rewind without creating a second
 *      branch (NN-INV-007);
 *   3. PRESERVES LINEAGE: it NEVER deletes a message. The prior head is retained
 *      as an immutable branch parent; the rewind creates a NEW branch that
 *      descends from the target turn, so every prior turn (including the ones
 *      "after" the target) remains readable on its original branch
 *      (NN-CHAT-009). The transcript is thus append-only.
 *
 * Additive: this module owns ONE new ledger table it solely owns
 * (`transcript_rewinds`) behind the authority transaction; it never becomes a
 * second writer for the chat/message business table (the chat authority owns
 * that, NN-INV-008 / NN-COMPAT-001/002). The transcript itself is modeled here
 * as an ordered list of immutable turns supplied by the caller; the rewind
 * records a branch decision over it without mutating any turn.
 *
 * Design anchors: D-14 (transcript rewind is a separate digest-bound command),
 * D-18 (idempotency, false-success prevention), D-20 (branch lineage).
 * Requirements: NN-CHECKPOINT-008, NN-CHAT-009/010, NN-INV-007/011.
 */

import type Database from 'better-sqlite3';

import {
  CONTRACT_WRITE_VERSION,
  computeDigest,
  makeOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
  type ScopeDescriptor,
} from '../shared/contract-primitives.js';
import {
  applyAuthorityMutation,
  ensureAuthorityTables,
  type EventIntent,
} from '../storage/authority-transaction.js';

// ─── Authority owner / errors ────────────────────────────────────────────────

/** The Transcript Rewind authority owner id stamped on receipts/events/errors. */
export const TRANSCRIPT_REWIND_AUTHORITY = 'authority-transcript-rewind';

/** A typed failure surfaced by the Transcript Rewind Service. */
export class TranscriptRewindError extends Error {
  readonly error: ErrorEnvelope;
  constructor(error: ErrorEnvelope) {
    super(error.message);
    this.name = 'TranscriptRewindError';
    this.error = error;
  }
}

function rewindError(
  code: ErrorCode,
  message: string,
  operation: string,
  correlationId: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: TRANSCRIPT_REWIND_AUTHORITY,
    operation,
    correlationId,
    retryable: false,
    redaction: 'internal',
  };
}

// ─── Transcript turn (immutable, append-only) ────────────────────────────────

/**
 * One immutable transcript turn. The transcript is an ordered, append-only list
 * of turns; a rewind never mutates or deletes a turn — it records a branch
 * decision over the list (NN-CHAT-009). `branchId` identifies which branch the
 * turn belongs to; `parentTurnId` preserves immutable provenance.
 */
export interface TranscriptTurn {
  readonly turnId: string;
  readonly branchId: string;
  readonly parentTurnId: string | null;
  /** A stable content digest of the turn (role + content + tool calls). */
  readonly contentDigest: string;
  /** Monotonic ordinal within the transcript (never reused). */
  readonly ordinal: number;
}

/**
 * Compute the confirmation digest that a rewind MUST be bound to. It
 * canonicalizes the target turn's identity and content plus the branch being
 * rewound so ANY change to the target turn (content, branch, or ordinal)
 * invalidates a previously-issued confirmation (NN-CHECKPOINT-008 "bound to the
 * target turn"). The UI computes and displays this; the second explicit
 * confirmation must echo it back exactly.
 */
export function computeRewindConfirmationDigest(input: {
  readonly sessionId: string;
  readonly targetTurnId: string;
  readonly targetTurnDigest: string;
  readonly targetBranchId: string;
  readonly targetOrdinal: number;
}): string {
  return computeDigest({
    kind: 'transcript-rewind-confirmation',
    sessionId: input.sessionId,
    targetTurnId: input.targetTurnId,
    targetTurnDigest: input.targetTurnDigest,
    targetBranchId: input.targetBranchId,
    targetOrdinal: input.targetOrdinal,
  });
}

// ─── Rewind record (the branch decision; owned solely by this module) ────────

/** `TranscriptRewind@1` — the durable branch decision this module solely owns. */
export interface TranscriptRewindRecord {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  readonly rewindId: string;
  readonly sessionId: string;
  readonly projectId: string;
  /** The turn the new branch descends from (the target of the rewind). */
  readonly targetTurnId: string;
  /** The branch that was active before the rewind (retained, never deleted). */
  readonly priorBranchId: string;
  /** The new branch created by the rewind (descends from the target turn). */
  readonly newBranchId: string;
  /** The confirmation digest this rewind was authorized by (audit lineage). */
  readonly confirmationDigest: string;
  /** The head turn of the prior branch, preserved as immutable lineage. */
  readonly priorHeadTurnId: string | null;
  readonly rewoundBy: string;
  readonly createdAt: string;
}

// ─── Business ledger (additive, behind the authority) ────────────────────────

const TRANSCRIPT_REWIND_DDL = `
  CREATE TABLE IF NOT EXISTS transcript_rewinds (
    rewind_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    target_turn_id TEXT NOT NULL,
    prior_branch_id TEXT NOT NULL,
    new_branch_id TEXT NOT NULL,
    confirmation_digest TEXT NOT NULL,
    prior_head_turn_id TEXT,
    rewound_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    record_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_transcript_rewinds_session
    ON transcript_rewinds (session_id, created_at DESC);
`;

/**
 * Create the durability primitives and the `transcript_rewinds` table if
 * absent. Additive and idempotent; safe at startup and in tests.
 */
export function ensureTranscriptRewindTables(db: Database.Database): void {
  ensureAuthorityTables(db);
  db.exec(TRANSCRIPT_REWIND_DDL);
}

// ─── Command / result ─────────────────────────────────────────────────────────

/** A transcript rewind command (a SEPARATE, digest-bound authorization). */
export interface RewindCommand {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly scope: ScopeDescriptor;
  readonly sessionId: string;
  readonly projectId: string;
  /** The ordered, append-only transcript turns (immutable). */
  readonly transcript: readonly TranscriptTurn[];
  /** The turn the new branch will descend from. */
  readonly targetTurnId: string;
  /** The branch currently active (the one being rewound away from). */
  readonly activeBranchId: string;
  /**
   * The second explicit confirmation digest bound to the target turn
   * (NN-CHECKPOINT-008). It MUST equal {@link computeRewindConfirmationDigest}
   * over the current target turn; a stale/mismatched digest is refused with no
   * effect.
   */
  readonly confirmationDigest: string;
  readonly rewoundBy: string;
  readonly now?: () => Date;
}

/** The outcome of a rewind: the committed branch decision and its receipt id. */
export interface RewindResult {
  readonly record: TranscriptRewindRecord;
  readonly receiptId: string;
  readonly authorityRevision: number;
  /**
   * The full transcript AFTER the rewind. It is a SUPERSET of the input (every
   * prior turn is retained); the rewind only records a new branch head — it
   * never removes a turn (NN-CHAT-009, append-only lineage).
   */
  readonly transcript: readonly TranscriptTurn[];
}

// ─── The Transcript Rewind Service ─────────────────────────────────────────────

/**
 * The single write owner for `TranscriptRewind@1` (NN-INV-008). A rewind is a
 * SEPARATE operation from a workspace restore, is authorized by a SECOND
 * digest-bound confirmation, runs as one idempotent authority transaction, and
 * PRESERVES lineage — it never deletes a transcript turn.
 */
export class TranscriptRewindService {
  constructor(private readonly db: Database.Database) {
    ensureTranscriptRewindTables(db);
  }

  /**
   * Perform a digest-bound, lineage-preserving transcript rewind
   * (NN-CHECKPOINT-008, NN-CHAT-009). The confirmation digest MUST match the
   * current target turn; otherwise the rewind is refused with a typed error and
   * NO effect (no implicit rewind, no blind retry). On success a NEW branch is
   * created descending from the target turn; the prior branch and every prior
   * turn are retained (the returned transcript is a superset of the input).
   * Routed through the T-001 authority transaction so the branch decision,
   * receipt, and outbox event commit atomically and idempotently.
   */
  rewind(cmd: RewindCommand): RewindResult {
    const now = (cmd.now ?? (() => new Date()))().toISOString();

    if (!cmd.projectId || cmd.scope.projectId !== cmd.projectId) {
      throw new TranscriptRewindError(
        rewindError(
          'VALIDATION',
          'rewind scope must name an explicit project matching the command projectId',
          'transcript-rewind',
          cmd.correlationId,
        ),
      );
    }

    // The target turn must exist in the immutable transcript.
    const target = cmd.transcript.find((t) => t.turnId === cmd.targetTurnId);
    if (!target) {
      throw new TranscriptRewindError(
        rewindError(
          'VALIDATION',
          `rewind target turn ${cmd.targetTurnId} is not present in the transcript`,
          'transcript-rewind',
          cmd.correlationId,
        ),
      );
    }

    // SEPARATE AUTHORIZATION: the second explicit confirmation digest must be
    // bound to the CURRENT target turn. A stale/mismatched digest is refused
    // with no effect (NN-CHECKPOINT-008 — never an implicit/blind rewind).
    const expected = computeRewindConfirmationDigest({
      sessionId: cmd.sessionId,
      targetTurnId: target.turnId,
      targetTurnDigest: target.contentDigest,
      targetBranchId: target.branchId,
      targetOrdinal: target.ordinal,
    });
    if (cmd.confirmationDigest !== expected) {
      throw new TranscriptRewindError(
        rewindError(
          'CONFLICT',
          'rewind confirmation digest does not match the target turn; refusing to rewind (stale or unbound confirmation)',
          'transcript-rewind',
          cmd.correlationId,
        ),
      );
    }

    // The new branch descends from the target turn; the prior branch head is
    // retained as immutable lineage (never deleted, NN-CHAT-009).
    const newBranchId = makeOpaqueId(
      'branch',
      `${cmd.sessionId}${cmd.targetTurnId}${cmd.commandId}${expected}`,
    );
    const priorHead = this.headOfBranch(cmd.transcript, cmd.activeBranchId);

    const rewindId = makeOpaqueId('rwd', `${cmd.sessionId}${cmd.targetTurnId}${expected}`);
    const record: TranscriptRewindRecord = {
      schemaVersion: CONTRACT_WRITE_VERSION,
      rewindId,
      sessionId: cmd.sessionId,
      projectId: cmd.projectId,
      targetTurnId: cmd.targetTurnId,
      priorBranchId: cmd.activeBranchId,
      newBranchId,
      confirmationDigest: expected,
      priorHeadTurnId: priorHead?.turnId ?? null,
      rewoundBy: cmd.rewoundBy,
      createdAt: now,
    };

    const outcome = applyAuthorityMutation(this.db, {
      authority: TRANSCRIPT_REWIND_AUTHORITY,
      commandId: cmd.commandId,
      idempotencyKey: cmd.idempotencyKey,
      requestDigest: computeDigest({ op: 'transcript-rewind', rewindId, confirmationDigest: expected }),
      correlationId: cmd.correlationId,
      scope: cmd.scope,
      mutate: (tx) => {
        this.persist(tx, record);
        return { resultRef: makeOpaqueId('res', rewindId) };
      },
      events: [
        this.event('transcript.rewound', 'transcript', cmd.sessionId, {
          rewindId,
          sessionId: cmd.sessionId,
          targetTurnId: cmd.targetTurnId,
          priorBranchId: cmd.activeBranchId,
          newBranchId,
        }),
      ],
      ...(cmd.now ? { now: cmd.now } : {}),
    });

    if (outcome.kind === 'conflict') throw new TranscriptRewindError(outcome.error);

    const committed = this.read(rewindId)!;
    // Build the post-rewind transcript: the input transcript UNCHANGED plus a
    // NEW branch head turn that descends from the target turn. No prior turn is
    // removed (append-only lineage, NN-CHAT-009).
    const newHead: TranscriptTurn = {
      turnId: makeOpaqueId('turn', `${newBranchId}head`),
      branchId: newBranchId,
      parentTurnId: cmd.targetTurnId,
      contentDigest: computeDigest({ branch: newBranchId, parent: cmd.targetTurnId }),
      ordinal: this.nextOrdinal(cmd.transcript),
    };
    const transcript = [...cmd.transcript, newHead];

    if (outcome.kind === 'replayed') {
      return {
        record: committed,
        receiptId: outcome.receipt.receiptId,
        authorityRevision: outcome.receipt.authorityRevision,
        transcript,
      };
    }
    return {
      record: committed,
      receiptId: outcome.receipt.receiptId,
      authorityRevision: outcome.authorityRevision,
      transcript,
    };
  }

  /** Read a `TranscriptRewind@1` record, or `undefined` if absent. */
  read(rewindId: string): TranscriptRewindRecord | undefined {
    const row = this.db
      .prepare(`SELECT record_json FROM transcript_rewinds WHERE rewind_id = ?`)
      .get(rewindId) as { record_json: string } | undefined;
    return row ? (JSON.parse(row.record_json) as TranscriptRewindRecord) : undefined;
  }

  /** List rewinds for a session, newest first (audit/branch lineage view). */
  list(sessionId: string): TranscriptRewindRecord[] {
    const rows = this.db
      .prepare(
        `SELECT record_json FROM transcript_rewinds WHERE session_id = ? ORDER BY created_at DESC, rewind_id DESC`,
      )
      .all(sessionId) as { record_json: string }[];
    return rows.map((r) => JSON.parse(r.record_json) as TranscriptRewindRecord);
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private headOfBranch(
    transcript: readonly TranscriptTurn[],
    branchId: string,
  ): TranscriptTurn | undefined {
    let head: TranscriptTurn | undefined;
    for (const turn of transcript) {
      if (turn.branchId !== branchId) continue;
      if (!head || turn.ordinal > head.ordinal) head = turn;
    }
    return head;
  }

  private nextOrdinal(transcript: readonly TranscriptTurn[]): number {
    let max = 0;
    for (const turn of transcript) if (turn.ordinal > max) max = turn.ordinal;
    return max + 1;
  }

  private persist(tx: Database.Database, record: TranscriptRewindRecord): void {
    tx.prepare(
      `INSERT INTO transcript_rewinds
         (rewind_id, session_id, project_id, target_turn_id, prior_branch_id, new_branch_id,
          confirmation_digest, prior_head_turn_id, rewound_by, created_at, record_json)
       VALUES (@rewindId, @sessionId, @projectId, @targetTurnId, @priorBranchId, @newBranchId,
          @confirmationDigest, @priorHeadTurnId, @rewoundBy, @createdAt, @recordJson)
       ON CONFLICT(rewind_id) DO NOTHING`,
    ).run({
      rewindId: record.rewindId,
      sessionId: record.sessionId,
      projectId: record.projectId,
      targetTurnId: record.targetTurnId,
      priorBranchId: record.priorBranchId,
      newBranchId: record.newBranchId,
      confirmationDigest: record.confirmationDigest,
      priorHeadTurnId: record.priorHeadTurnId ?? null,
      rewoundBy: record.rewoundBy,
      createdAt: record.createdAt,
      recordJson: JSON.stringify(record),
    });
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
}
