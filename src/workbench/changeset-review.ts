/**
 * ChangeSetReviewModel — the streamed/completed multi-file ChangeSet review
 * surface (FUT-PKG-07-EXPERIENCE/T-003, NN-UI-004).
 *
 * Streaming and completed multi-file Change Sets show versioned diffs with
 * per-file/per-hunk accept/reject, stale-conflict options, provenance, and one
 * coherent undo plus checkpoint fallback (NN-UI-004). This module owns the
 * REVIEW STATE — the user's per-hunk accept/reject decisions — and drives the
 * actual mutation through the canonical ChangeService (D-04/D-12): it NEVER
 * writes a file itself, and it NEVER mutates before the user approves
 * (pre-approval mutation is PROHIBITED).
 *
 * Key invariants:
 *
 *   - Hunk state is NOT lost across the streamed→completed transition
 *     (lost-hunk-state is PROHIBITED). {@link ingestStreamHunks} appends newly
 *     streamed hunks with a STABLE per-hunk key and {@link markCompleted} flips
 *     the review to completed WITHOUT discarding any decision the user already
 *     made on an earlier-streamed hunk.
 *   - Every decision is keyed by a stable `(relativePath, hunkIndex)` identity,
 *     so re-ingesting the same hunk (reconnect/re-render) preserves the prior
 *     decision rather than resetting it.
 *   - {@link promote} refuses to promote a review that is not completed, or one
 *     that has undecided hunks, or one with zero accepted operations — no
 *     pre-approval mutation. Accepted operations are handed to ChangeService's
 *     create→review→promote so all mutation routes through the single writer,
 *     and a stale base is surfaced verbatim (STALE_REVISION) with the review
 *     retained.
 *
 * Design anchors: D-07 (ChangeSet@1), D-12 (apply sequence), D-14 (checkpoint
 * fallback). Requirements: NN-UI-004, NN-OPS-002, NN-INV-006/008.
 */

import { ChangeServiceError, type ChangeService, type FileOperation } from '../change-set/change-service.js';
import {
  CONTRACT_WRITE_VERSION,
  type ErrorCode,
  type ErrorEnvelope,
  type ScopeDescriptor,
} from '../shared/contract-primitives.js';

/** The review authority owner id stamped on review errors. */
export const REVIEW_OWNER = 'authority-changeset-review';

/** A per-hunk review decision (NN-UI-004 accept/reject by file/hunk). */
export type HunkDecision = 'undecided' | 'accepted' | 'rejected';

/** The lifecycle of a review as diffs stream in and then complete. */
export type ReviewPhase = 'streaming' | 'completed' | 'promoted' | 'stale' | 'failed';

/**
 * A single reviewable hunk within a file. `hunkKey` is a STABLE identity so a
 * re-streamed/re-rendered hunk preserves its decision (no lost hunk state).
 */
export interface ReviewHunk {
  readonly hunkKey: string;
  readonly relativePath: string;
  readonly hunkIndex: number;
  readonly additions: number;
  readonly removals: number;
  /** The proposed content for the file this hunk belongs to (create/modify). */
  readonly proposedContent?: string;
  /** For a delete, the operation is file-level; content is absent. */
  readonly operationKind: 'create' | 'modify' | 'delete';
  readonly expectedHash?: string;
  decision: HunkDecision;
}

/** Provenance surfaced with the review (NN-UI-004 provenance). */
export interface ReviewProvenance {
  readonly actor: string;
  readonly taskId?: string;
  readonly turnId?: string;
  readonly toolCallId?: string;
}

/** A typed review failure. */
export class ReviewError extends Error {
  readonly error: ErrorEnvelope;
  constructor(error: ErrorEnvelope) {
    super(error.message);
    this.name = 'ReviewError';
    this.error = error;
  }
}

function reviewError(code: ErrorCode, message: string, correlationId: string): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: REVIEW_OWNER,
    operation: 'changeset-review',
    correlationId,
    retryable: code === 'STALE_REVISION',
    redaction: 'internal',
  };
}

/** The render-ready review snapshot (deterministic order by path, then hunk). */
export interface ReviewSnapshot {
  readonly phase: ReviewPhase;
  readonly baseWorkspaceRevision: number;
  readonly provenance: ReviewProvenance;
  readonly hunks: readonly ReviewHunk[];
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly undecidedCount: number;
}

/**
 * The streamed/completed ChangeSet review model. Holds the user's per-hunk
 * decisions and drives the canonical ChangeService for the actual mutation.
 */
export class ChangeSetReviewModel {
  private phase: ReviewPhase = 'streaming';
  private readonly hunks = new Map<string, ReviewHunk>();

  constructor(
    private readonly baseWorkspaceRevision: number,
    private readonly provenance: ReviewProvenance,
  ) {}

  /**
   * Ingest a batch of streamed hunks. A hunk with a NEW stable key is appended
   * as `undecided`; a hunk whose key already exists KEEPS its prior decision and
   * refreshes its diff stats (no lost hunk state across restream/reconnect).
   */
  ingestStreamHunks(incoming: readonly Omit<ReviewHunk, 'hunkKey' | 'decision'>[]): void {
    if (this.phase !== 'streaming' && this.phase !== 'completed') {
      throw new ReviewError(
        reviewError('CONFLICT', `cannot ingest hunks in phase "${this.phase}"`, 'corr-review'),
      );
    }
    for (const raw of incoming) {
      const hunkKey = `${raw.relativePath}::${raw.hunkIndex}`;
      const prior = this.hunks.get(hunkKey);
      this.hunks.set(hunkKey, {
        ...raw,
        hunkKey,
        decision: prior ? prior.decision : 'undecided',
      });
    }
  }

  /**
   * Flip the review to `completed` once the ChangeSet has fully streamed. This
   * NEVER clears decisions already made on earlier-streamed hunks
   * (NN-UI-004 lost-hunk-state prohibited).
   */
  markCompleted(): void {
    if (this.phase === 'streaming' || this.phase === 'completed') this.phase = 'completed';
  }

  /** Record a per-hunk decision (accept/reject). Pre-approval only — no write. */
  decide(hunkKey: string, decision: Exclude<HunkDecision, 'undecided'>): void {
    const hunk = this.hunks.get(hunkKey);
    if (!hunk) {
      throw new ReviewError(reviewError('VALIDATION', `no hunk "${hunkKey}"`, 'corr-review'));
    }
    hunk.decision = decision;
  }

  /** Accept or reject every hunk in a file at once (NN-UI-004 by-file). */
  decideFile(relativePath: string, decision: Exclude<HunkDecision, 'undecided'>): void {
    for (const hunk of this.hunks.values()) {
      if (hunk.relativePath === relativePath) hunk.decision = decision;
    }
  }

  /** A deterministic snapshot for rendering (stable order by path, then hunk). */
  snapshot(): ReviewSnapshot {
    const hunks = [...this.hunks.values()].sort(
      (a, b) => a.relativePath.localeCompare(b.relativePath) || a.hunkIndex - b.hunkIndex,
    );
    let accepted = 0;
    let rejected = 0;
    let undecided = 0;
    for (const h of hunks) {
      if (h.decision === 'accepted') accepted += 1;
      else if (h.decision === 'rejected') rejected += 1;
      else undecided += 1;
    }
    return {
      phase: this.phase,
      baseWorkspaceRevision: this.baseWorkspaceRevision,
      provenance: this.provenance,
      hunks,
      acceptedCount: accepted,
      rejectedCount: rejected,
      undecidedCount: undecided,
    };
  }

  /**
   * Promote the accepted hunks through the canonical ChangeService (D-12). This
   * REFUSES:
   *   - a review that is not `completed` (no pre-approval mutation);
   *   - a review with any undecided hunk (the user must decide first);
   *   - a review with zero accepted operations (nothing to route).
   * The accepted, file-level operations are handed to ChangeService's
   * create→review→promote so ALL mutation routes through the single writer; a
   * stale base is surfaced verbatim (STALE_REVISION) with the review retained.
   */
  promote(input: {
    readonly changeService: ChangeService;
    readonly scope: ScopeDescriptor;
    readonly projectId: string;
    readonly sessionId: string;
    readonly worktreeId?: string;
    readonly currentWorkspaceRevision: number;
    readonly resultWorkspaceRevision: number;
    readonly commandId: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly now?: () => Date;
  }): { readonly kind: 'promoted'; readonly changeSetId: string; readonly resultWorkspaceRevision: number } {
    if (this.phase !== 'completed') {
      throw new ReviewError(
        reviewError(
          'CONFLICT',
          `review must be completed before promotion (phase "${this.phase}"); pre-approval mutation is prohibited`,
          input.correlationId,
        ),
      );
    }
    const snapshot = this.snapshot();
    if (snapshot.undecidedCount > 0) {
      throw new ReviewError(
        reviewError(
          'VALIDATION',
          `${snapshot.undecidedCount} hunk(s) undecided; decide every hunk before promotion`,
          input.correlationId,
        ),
      );
    }
    const operations = this.acceptedOperations();
    if (operations.length === 0) {
      throw new ReviewError(
        reviewError('VALIDATION', 'no accepted operations to promote', input.correlationId),
      );
    }

    try {
      // Route the mutation through the canonical ChangeService (single writer).
      const created = input.changeService.create({
        commandId: input.commandId,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
        scope: input.scope,
        actor: this.provenance.actor,
        baseWorkspaceRevision: this.baseWorkspaceRevision,
        operations,
        ...(this.provenance.taskId ? { taskId: this.provenance.taskId } : {}),
        ...(this.provenance.turnId ? { turnId: this.provenance.turnId } : {}),
        ...(this.provenance.toolCallId ? { toolCallId: this.provenance.toolCallId } : {}),
        ...(input.now ? { now: input.now } : {}),
      });

      const result = input.changeService.promote({
        changeSetId: created.record.changeSetId,
        currentWorkspaceRevision: input.currentWorkspaceRevision,
        resultWorkspaceRevision: input.resultWorkspaceRevision,
        commandId: `${input.commandId}-promote`,
        idempotencyKey: `${input.idempotencyKey}-promote`,
        correlationId: input.correlationId,
        ...(input.now ? { now: input.now } : {}),
      });

      if (result.kind === 'failed') {
        this.phase = 'failed';
        throw new ReviewError(result.error);
      }
      this.phase = 'promoted';
      return {
        kind: 'promoted',
        changeSetId: created.record.changeSetId,
        resultWorkspaceRevision: result.record.resultWorkspaceRevision ?? input.resultWorkspaceRevision,
      };
    } catch (e) {
      // A typed ChangeService failure (e.g. a STALE_REVISION when the workspace
      // advanced past the review's base) is surfaced VERBATIM as a ReviewError
      // with the review retained — a stale review flips to `stale` so the user
      // can rebase/retry (NN-UI-004 stale-conflict options, D-12). The mutation
      // stays entirely inside ChangeService; nothing was written here.
      if (e instanceof ChangeServiceError) {
        this.phase = e.error.code === 'STALE_REVISION' ? 'stale' : 'failed';
        throw new ReviewError(e.error);
      }
      throw e;
    }
  }

  /** Mark the review stale (a ChangeService STALE_REVISION was surfaced). */
  markStale(): void {
    this.phase = 'stale';
  }

  /**
   * Fold the accepted hunks into ONE file-level operation per path. A file with
   * any accepted hunk contributes its proposed content (create/modify) or a
   * delete; a rejected-only file contributes nothing (NN-UI-004 accept/reject by
   * file/hunk resolves to a per-file operation set for the ChangeSet).
   */
  private acceptedOperations(): FileOperation[] {
    const byPath = new Map<string, ReviewHunk>();
    for (const hunk of this.hunks.values()) {
      if (hunk.decision !== 'accepted') continue;
      // The last accepted hunk for a path carries the coherent proposed content.
      byPath.set(hunk.relativePath, hunk);
    }
    const ops: FileOperation[] = [];
    for (const hunk of byPath.values()) {
      if (hunk.operationKind === 'delete') {
        ops.push({
          kind: 'delete',
          targetPath: hunk.relativePath,
          ...(hunk.expectedHash ? { expectedHash: hunk.expectedHash } : {}),
        });
      } else {
        ops.push({
          kind: hunk.operationKind,
          targetPath: hunk.relativePath,
          content: hunk.proposedContent ?? '',
          ...(hunk.expectedHash ? { expectedHash: hunk.expectedHash } : {}),
        });
      }
    }
    return ops.sort((a, b) => a.targetPath.localeCompare(b.targetPath));
  }
}
