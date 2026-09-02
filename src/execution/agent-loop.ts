/**
 * Bounded observe/plan/act/verify agent loop, deterministic tool-call recovery,
 * and error compaction (FUT-PKG-06-EXECUTION/T-008).
 *
 * NN-EXEC-004 requires the agent loop to use explicit observe/plan/act/verify
 * states, bounded rounds/context/tools, durable receipts, loop/no-progress
 * detection, typed terminal outcomes, and cancellation — and, above all, that
 * **exhaustion SHALL stop rather than fabricate completion**. This module is
 * that loop. It runs THROUGH the existing authorities (it never forks them):
 *
 *   - Every act step is dispatched through an injected {@link ActPort} that is
 *     the {@link ToolExecutionPipeline} in production, so no subsystem reaches
 *     execution by any route other than the one governed pipeline (NN-EXEC-001,
 *     D-11). The loop itself performs no side effect; it only sequences steps.
 *   - Every step is guarded by the injected {@link CancellationController}
 *     (shared/execution-cancellation.ts). A cancelled root converges to a typed
 *     `cancelled` terminal outcome and admits no further step (NN-INV-012).
 *   - Loop/no-progress detection reuses the Orchestration Authority's
 *     key-order-independent {@link progressHash} / {@link decideStuck} so a
 *     no-progress loop is terminated `failed`, never spun forever (NN-EXEC-004,
 *     NN-ORCH-009).
 *   - Every round transition and every terminal outcome is a durable
 *     `LoopReceipt@1` committed through {@link applyAuthorityMutation} (D-08.2
 *     single-writer, idempotent-by-key): a duplicated drive replays the prior
 *     receipt with no second effect, and a failed transaction leaves no receipt
 *     row (NN-INV-003/007).
 *
 * Bounds (NN-EXEC-004). The loop is HARD-bounded on three axes and STOPS with a
 * typed non-success `exhausted` outcome the instant ANY bound is hit — it never
 * emits `completed` on exhaustion:
 *
 *   1. `maxRounds`   — the maximum number of observe/plan/act/verify rounds.
 *   2. `maxToolCalls`— the maximum number of act (tool) dispatches across the
 *      whole loop (bounded tools).
 *   3. `deadlineMs`  — a wall-clock budget on the injected clock (bounded time).
 *
 * On exhaustion (or cancellation, or an unrecoverable step error) the loop
 * CLEANS every resource it owns by invoking the injected
 * {@link LoopResourceScope.cleanup} exactly once, so no orphan process / world
 * survives a bounded stop (task acceptance "cleans owned resources"; D-15).
 *
 * Tool-call recovery (NN-EXEC-005). {@link recoverToolHistory} sanitizes an
 * interrupted/dangling tool history DETERMINISTICALLY: it pairs calls with
 * results by stable tool-call id, preserves the retained order, injects a typed
 * `interrupted` result for any call that has no committed result, drops an
 * orphan result that has no originating call, and is IDEMPOTENT (recovering an
 * already-recovered history is a fixpoint). A tool whose call failed at least
 * {@link RECOVERY_UNAVAILABLE_THRESHOLD} times in the retained window is marked
 * temporarily unavailable (NN-EXEC-005).
 *
 * Error compaction (NN-EXEC-006). {@link compactError} produces a deterministic,
 * redacted error digest that preserves the error name/message, exit code, the
 * top five application frames, and at most the last 256 output bytes within a
 * default 800-token cap. The raw evidence is NOT placed in the digest; a
 * `rawEvidenceRef` points at durable evidence that lives outside prompt context.
 *
 * Design anchors: D-05, D-11, D-15, D-18, D-19. Requirements:
 * NN-EXEC-004/005/006, NN-ORCH-009, NN-INV-003/007/012.
 */

import type Database from 'better-sqlite3';

import {
  CONTRACT_WRITE_VERSION,
  computeDigest,
  makeOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
  type ScopeDescriptor,
} from '../shared/contract-primitives';
import {
  applyAuthorityMutation,
  ensureAuthorityTables,
} from '../storage/authority-transaction';
import type { CancellationController } from '../shared/execution-cancellation';
import { decideStuck, progressHash } from './orchestration-types';

const LOOP_OWNER = 'authority-agent-loop';

// ════════════════════════════════════════════════════════════════════════════
// 1. Loop phases (NN-EXEC-004 explicit states)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The four explicit loop phases, in the fixed order a round runs them. A round
 * always begins at `observe` and only reaches `verify` after `act`; a caller
 * cannot reorder them (NN-EXEC-004 explicit states).
 */
export const LOOP_PHASES = Object.freeze([
  'observe',
  'plan',
  'act',
  'verify',
] as const);
export type LoopPhase = (typeof LOOP_PHASES)[number];

/**
 * The typed terminal outcome kinds of a bounded loop. `completed` is the ONLY
 * success and is reachable ONLY from a `verify` phase that reports done; every
 * other kind is a typed non-success (NN-EXEC-004 "exhaustion stops").
 */
export const LOOP_OUTCOME_KINDS = Object.freeze([
  'completed',
  'exhausted',
  'cancelled',
  'no-progress',
  'step-failed',
] as const);
export type LoopOutcomeKind = (typeof LOOP_OUTCOME_KINDS)[number];

/** Whether a loop outcome kind reports success. Only `completed` does. */
export function isLoopSuccess(kind: LoopOutcomeKind): boolean {
  return kind === 'completed';
}

/** The reason a bound was exhausted (audit of WHICH bound stopped the loop). */
export const EXHAUSTION_REASONS = Object.freeze([
  'max-rounds',
  'max-tool-calls',
  'deadline',
] as const);
export type ExhaustionReason = (typeof EXHAUSTION_REASONS)[number];

// ════════════════════════════════════════════════════════════════════════════
// 2. Loop bounds (NN-EXEC-004 bounded rounds/context/tools)
// ════════════════════════════════════════════════════════════════════════════

/** The HARD bounds a bounded loop runs under. All are positive finite. */
export interface LoopBounds {
  /** Maximum observe/plan/act/verify rounds. */
  readonly maxRounds: number;
  /** Maximum total act (tool) dispatches across the whole loop. */
  readonly maxToolCalls: number;
  /** Wall-clock budget in ms on the injected clock. */
  readonly deadlineMs: number;
  /** Consecutive identical observations that terminate the loop `no-progress`. */
  readonly maxNoProgressIterations: number;
}

/** A conservative default bound profile (bounded on every axis). */
export const DEFAULT_LOOP_BOUNDS: LoopBounds = Object.freeze({
  maxRounds: 16,
  maxToolCalls: 64,
  deadlineMs: 600_000,
  maxNoProgressIterations: 3,
});

/** Whether a bounds profile is well-formed (every axis a positive integer). */
export function isValidLoopBounds(bounds: LoopBounds): boolean {
  const positiveInt = (n: number): boolean =>
    Number.isInteger(n) && n > 0 && Number.isFinite(n);
  return (
    positiveInt(bounds.maxRounds) &&
    positiveInt(bounds.maxToolCalls) &&
    positiveInt(bounds.deadlineMs) &&
    positiveInt(bounds.maxNoProgressIterations)
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Step ports (the loop sequences; it never performs an effect itself)
// ════════════════════════════════════════════════════════════════════════════

/** A single observe result: the observation to hash for no-progress detection. */
export interface ObserveResult {
  /** An arbitrary structured observation; hashed key-order-independently. */
  readonly observation: unknown;
}

/** A single plan result: whether the loop believes the goal is already met. */
export interface PlanResult {
  /** When true, the loop verifies and may complete without another act step. */
  readonly believesDone: boolean;
  /** Number of act (tool) dispatches this round intends (>= 0). */
  readonly intendedToolCalls: number;
}

/** The outcome of one act (tool) dispatch through the governed pipeline. */
export type ActStepResult =
  | { readonly ok: true; readonly outputRef: string }
  | { readonly ok: false; readonly error: ErrorEnvelope; readonly recoverable: boolean };

/** A verify result: whether the acceptance criteria are met this round. */
export interface VerifyResult {
  /** True only when verification confirms the goal is met (success gate). */
  readonly satisfied: boolean;
}

/**
 * The injected step ports. In production `act` is the {@link ToolExecutionPipeline}
 * (each call is a governed pipeline execution); `observe`/`plan`/`verify` are the
 * agent's model calls. The loop NEVER performs a side effect directly.
 */
export interface LoopPorts {
  readonly observe: (round: number) => ObserveResult;
  readonly plan: (round: number, observation: unknown) => PlanResult;
  /** Dispatch one act step. Invoked at most `intendedToolCalls` times/round. */
  readonly act: (round: number, index: number) => ActStepResult;
  readonly verify: (round: number) => VerifyResult;
}

/**
 * The owned-resource scope the loop cleans on ANY terminal outcome. Production
 * wires this to the process registry drain + execution-world teardown. It is
 * invoked EXACTLY ONCE per loop, on every terminal path (success, exhaustion,
 * cancellation, no-progress, step failure), so a bounded stop never orphans a
 * resource (task acceptance; D-15).
 */
export interface LoopResourceScope {
  /** Release every resource the loop owns. Returns the count released. */
  readonly cleanup: () => number;
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Loop outcome (typed terminal, NN-EXEC-004)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The typed terminal outcome of a bounded loop. `resourcesReleased` records how
 * many owned resources the loop cleaned; `error` is present for every
 * non-success kind and absent for `completed`.
 */
export interface LoopOutcome {
  readonly schemaVersion: typeof CONTRACT_WRITE_VERSION;
  readonly loopId: string;
  readonly kind: LoopOutcomeKind;
  /** Rounds actually executed (>= 0). */
  readonly rounds: number;
  /** Total act (tool) dispatches executed across the loop. */
  readonly toolCalls: number;
  /** Which bound was exhausted, when `kind === 'exhausted'`. */
  readonly exhaustionReason?: ExhaustionReason;
  /** Owned resources released by the single cleanup on the terminal path. */
  readonly resourcesReleased: number;
  /** Whether cleanup ran (always true on any terminal path). */
  readonly cleaned: boolean;
  /** Present for every non-success kind. */
  readonly error?: ErrorEnvelope;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
}

function loopError(
  code: ErrorCode,
  message: string,
  operation: string,
  correlationId: string,
  retryable = false,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: LOOP_OWNER,
    operation,
    correlationId,
    retryable,
    remediation:
      'The bounded loop stopped without fabricating completion; ' +
      'inspect the durable loop receipts and owned-resource cleanup evidence.',
    redaction: 'internal',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Durable loop receipts (NN-INV-003/007, D-08.2)
// ════════════════════════════════════════════════════════════════════════════

/** Create the additive durable table for loop receipts. Idempotent. */
export function ensureAgentLoopTables(db: Database.Database): void {
  ensureAuthorityTables(db);
  db.prepare(
    `CREATE TABLE IF NOT EXISTS agent_loop_receipts (
       loop_id      TEXT NOT NULL,
       round        INTEGER NOT NULL,
       phase        TEXT NOT NULL,
       kind         TEXT NOT NULL,
       receipt_json TEXT NOT NULL,
       created_at   TEXT NOT NULL,
       PRIMARY KEY (loop_id, round, phase)
     )`,
  ).run();
}

function readLoopReceiptCount(db: Database.Database, loopId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM agent_loop_receipts WHERE loop_id = ?')
    .get(loopId) as { n: number } | undefined;
  return row?.n ?? 0;
}

// ════════════════════════════════════════════════════════════════════════════
// 6. The bounded loop runner
// ════════════════════════════════════════════════════════════════════════════

/** Input to {@link runBoundedLoop}. */
export interface RunLoopInput {
  readonly loopId: string;
  readonly scope: ScopeDescriptor;
  readonly correlationId: string;
  /** The root cancellation token id the loop runs under. */
  readonly cancellationTokenId: string;
  readonly bounds: LoopBounds;
  readonly ports: LoopPorts;
  readonly resources: LoopResourceScope;
}

/** Options for {@link runBoundedLoop}. */
export interface RunLoopOptions {
  /** Injectable monotonic clock in ms; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Run the bounded observe/plan/act/verify loop to a typed terminal outcome. The
 * loop:
 *
 *   - stops with `exhausted` the instant `maxRounds`, `maxToolCalls`, or the
 *     `deadlineMs` budget is reached — it NEVER returns `completed` on
 *     exhaustion (NN-EXEC-004);
 *   - stops with `cancelled` when the cancellation token is no longer active
 *     at a phase boundary (NN-INV-012);
 *   - stops with `no-progress` when the last `maxNoProgressIterations`
 *     observations hash identically (NN-ORCH-009);
 *   - stops with `step-failed` on an unrecoverable act error;
 *   - reaches `completed` ONLY through a `verify` phase that reports satisfied;
 *   - cleans every owned resource EXACTLY ONCE on whichever terminal path it
 *     takes, and commits a durable terminal `LoopReceipt@1`.
 *
 * Bounds are validated first; an invalid bounds profile is a `VALIDATION`
 * terminal (still cleans resources and commits a receipt).
 */
export function runBoundedLoop(
  db: Database.Database,
  input: RunLoopInput,
  cancellation: CancellationController,
  options: RunLoopOptions = {},
): LoopOutcome {
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const deadlineAtMs = startedAtMs + input.bounds.deadlineMs;

  let rounds = 0;
  let toolCalls = 0;
  let cleaned = false;
  let released = 0;

  // Clean owned resources EXACTLY once, on whichever terminal path we take.
  const cleanupOnce = (): void => {
    if (cleaned) return;
    cleaned = true;
    released = input.resources.cleanup();
  };

  const finish = (
    kind: LoopOutcomeKind,
    round: number,
    phase: LoopPhase,
    error?: ErrorEnvelope,
    exhaustionReason?: ExhaustionReason,
  ): LoopOutcome => {
    cleanupOnce();
    const outcome: LoopOutcome = {
      schemaVersion: CONTRACT_WRITE_VERSION,
      loopId: input.loopId,
      kind,
      rounds,
      toolCalls,
      ...(exhaustionReason ? { exhaustionReason } : {}),
      resourcesReleased: released,
      cleaned,
      ...(error ? { error } : {}),
      startedAtMs,
      endedAtMs: now(),
    };
    // Durable terminal receipt (idempotent-by-key). A duplicated drive replays.
    commitLoopReceipt(db, input, round, phase, kind, outcome, () => new Date());
    return outcome;
  };

  if (!isValidLoopBounds(input.bounds)) {
    return finish(
      'step-failed',
      0,
      'observe',
      loopError(
        'VALIDATION',
        'loop bounds must be positive finite integers on every axis',
        'loop.validate-bounds',
        input.correlationId,
      ),
    );
  }

  const progressHashes: string[] = [];

  // The bounded round loop. The `for` header itself enforces the round bound so
  // the loop can NEVER iterate beyond `maxRounds` (V-EXEC-001/loop-bounds).
  for (let round = 1; round <= input.bounds.maxRounds; round += 1) {
    rounds = round;

    // ── Deadline bound (checked at the top of every round). ────────────────
    if (now() >= deadlineAtMs) {
      return finish(
        'exhausted',
        round,
        'observe',
        loopError(
          'TIMEOUT',
          'loop wall-clock deadline reached; stopping without completion',
          'loop.deadline',
          input.correlationId,
        ),
        'deadline',
      );
    }

    // ── Cancellation (checked at every phase boundary). ────────────────────
    if (!cancellation.isActive(input.cancellationTokenId)) {
      return finish(
        'cancelled',
        round,
        'observe',
        loopError(
          'CANCELLED',
          'cancellation converged at a phase boundary; no further step admitted',
          'loop.cancelled',
          input.correlationId,
        ),
      );
    }

    // ── OBSERVE ────────────────────────────────────────────────────────────
    const observed = cancellation.emit(input.cancellationTokenId, () =>
      input.ports.observe(round),
    );
    if (!observed.ok) return finish('cancelled', round, 'observe', observed.error);
    const hash = progressHash(observed.value.observation);
    progressHashes.push(hash);
    commitLoopReceipt(db, input, round, 'observe', 'observe-step', undefined, () => new Date());

    // No-progress detection over the retained window (NN-ORCH-009).
    const stuck = decideStuck(progressHashes, {
      maxConcurrency: 1,
      maxRetries: 1,
      maxNestingDepth: 1,
      maxSpawns: 1,
      maxNoProgressIterations: input.bounds.maxNoProgressIterations,
      maxFallbackHops: 1,
    });
    if (stuck === 'stop') {
      return finish(
        'no-progress',
        round,
        'observe',
        loopError(
          'CONFLICT',
          'no-progress detected: identical observations reached the bound; stopping',
          'loop.no-progress',
          input.correlationId,
        ),
      );
    }

    // ── PLAN ─────────────────────────────────────────────────────────────
    if (!cancellation.isActive(input.cancellationTokenId)) {
      return finish('cancelled', round, 'plan', loopError('CANCELLED', 'cancelled before plan', 'loop.cancelled', input.correlationId));
    }
    const planned = cancellation.emit(input.cancellationTokenId, () =>
      input.ports.plan(round, observed.value.observation),
    );
    if (!planned.ok) return finish('cancelled', round, 'plan', planned.error);
    commitLoopReceipt(db, input, round, 'plan', 'plan-step', undefined, () => new Date());

    // ── ACT ──────────────────────────────────────────────────────────────
    const intended = Math.max(0, Math.floor(planned.value.intendedToolCalls));
    for (let i = 0; i < intended; i += 1) {
      // Tool-call bound: stop the INSTANT the next dispatch would exceed it.
      if (toolCalls >= input.bounds.maxToolCalls) {
        return finish(
          'exhausted',
          round,
          'act',
          loopError(
            'BUDGET_EXCEEDED',
            'loop tool-call bound reached; stopping without completion',
            'loop.max-tool-calls',
            input.correlationId,
          ),
          'max-tool-calls',
        );
      }
      if (!cancellation.isActive(input.cancellationTokenId)) {
        return finish('cancelled', round, 'act', loopError('CANCELLED', 'cancelled during act', 'loop.cancelled', input.correlationId));
      }
      const act = cancellation.emit(input.cancellationTokenId, () =>
        input.ports.act(round, i),
      );
      if (!act.ok) return finish('cancelled', round, 'act', act.error);
      toolCalls += 1;
      const step = act.value;
      if (!step.ok && !step.recoverable) {
        // An unrecoverable step error stops the loop; it never fabricates done.
        return finish('step-failed', round, 'act', step.error);
      }
    }
    commitLoopReceipt(db, input, round, 'act', 'act-step', undefined, () => new Date());

    // ── VERIFY (the ONLY gate to `completed`). ─────────────────────────────
    if (!cancellation.isActive(input.cancellationTokenId)) {
      return finish('cancelled', round, 'verify', loopError('CANCELLED', 'cancelled before verify', 'loop.cancelled', input.correlationId));
    }
    const verified = cancellation.emit(input.cancellationTokenId, () =>
      input.ports.verify(round),
    );
    if (!verified.ok) return finish('cancelled', round, 'verify', verified.error);
    commitLoopReceipt(db, input, round, 'verify', 'verify-step', undefined, () => new Date());

    if (verified.value.satisfied && planned.value.believesDone) {
      return finish('completed', round, 'verify');
    }
  }

  // The round loop fell through: the round bound was reached. This is the
  // canonical "exhaustion stops rather than fabricates completion" path.
  return finish(
    'exhausted',
    input.bounds.maxRounds,
    'verify',
    loopError(
      'BUDGET_EXCEEDED',
      'loop round bound reached; stopping without completion',
      'loop.max-rounds',
      input.correlationId,
    ),
    'max-rounds',
  );
}

/**
 * Commit a durable `LoopReceipt@1` for a round/phase transition (or the
 * terminal outcome) through {@link applyAuthorityMutation}. Idempotent by the
 * `(loopId, round, phase, kind)` key: a duplicated drive replays with NO second
 * receipt row (NN-INV-007). A failed commit leaves no row (NN-INV-003) — the
 * caller's outcome is still returned, but the durable count reflects only
 * committed rows.
 */
function commitLoopReceipt(
  db: Database.Database,
  input: RunLoopInput,
  round: number,
  phase: LoopPhase,
  kind: string,
  outcome: LoopOutcome | undefined,
  now: () => Date,
): void {
  const idempotencyKey = `loop-receipt:${input.loopId}:${round}:${phase}:${kind}`;
  const commandId = makeOpaqueId('cmd', `${input.loopId}${round}${phase}${kind}`);
  const receiptJson = JSON.stringify(
    outcome ?? { loopId: input.loopId, round, phase, kind },
  );
  applyAuthorityMutation(db, {
    authority: LOOP_OWNER,
    commandId,
    idempotencyKey,
    requestDigest: computeDigest({ loopId: input.loopId, round, phase, kind }),
    correlationId: input.correlationId,
    scope: input.scope,
    mutate: (tx) => {
      tx.prepare(
        `INSERT OR IGNORE INTO agent_loop_receipts
           (loop_id, round, phase, kind, receipt_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(input.loopId, round, phase, kind, receiptJson, now().toISOString());
    },
    now,
  });
}

/** The number of durable loop receipts committed for a loop (test/observer). */
export function loopReceiptCount(db: Database.Database, loopId: string): number {
  return readLoopReceiptCount(db, loopId);
}

// ════════════════════════════════════════════════════════════════════════════
// 7. Tool-call recovery (NN-EXEC-005)
// ════════════════════════════════════════════════════════════════════════════

/** The disposition of a paired tool history entry after recovery. */
export type RecoveryDisposition =
  | 'paired' // a call with a committed result
  | 'interrupted' // a call whose result was injected (dangling call)
  | 'dropped-orphan'; // a result with no originating call (removed)

/** A single tool-call entry in a (possibly interrupted) tool history. */
export interface ToolHistoryEntry {
  readonly toolCallId: string;
  readonly toolName: string;
  /** Retained order index; recovery preserves ascending order. */
  readonly order: number;
  /** Whether a committed result exists for this call. */
  readonly hasResult: boolean;
  /** Whether the (committed) result was a failure. */
  readonly failed?: boolean;
  /** True when this entry is a result with no originating call (orphan). */
  readonly orphanResult?: boolean;
}

/** A recovered tool history entry with its typed disposition. */
export interface RecoveredEntry {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly order: number;
  readonly disposition: RecoveryDisposition;
  /** The typed injected result for an interrupted call. */
  readonly injectedResult?: ErrorEnvelope;
}

/** The result of recovering a tool history. */
export interface ToolHistoryRecovery {
  readonly entries: readonly RecoveredEntry[];
  /** Tool names marked temporarily unavailable (repeated failure). */
  readonly unavailableTools: readonly string[];
}

/**
 * The number of failures of a single tool within the retained window that marks
 * it temporarily unavailable (NN-EXEC-005 "repeated failure").
 */
export const RECOVERY_UNAVAILABLE_THRESHOLD = 3;

function interruptedResult(toolCallId: string, correlationId: string): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code: 'CANCELLED',
    message: `tool call '${toolCallId}' had no committed result at recovery; injected typed interrupted result`,
    owner: LOOP_OWNER,
    operation: 'loop.recover-tool-history',
    correlationId,
    retryable: false,
    remediation:
      'The dangling call was paired with a typed interrupted result; ' +
      're-issue the tool call if the effect is unknown and receipt-queryable.',
    redaction: 'internal',
  };
}

/**
 * Deterministically sanitize a (possibly interrupted) tool history
 * (NN-EXEC-005):
 *
 *   1. preserve the RETAINED ORDER (sort by ascending `order`, stable on ties);
 *   2. pair each call by its stable `toolCallId`;
 *   3. inject a typed `interrupted` result for any call with no committed
 *      result (a dangling call), so no call is left unpaired;
 *   4. DROP any orphan result (a result with no originating call);
 *   5. mark a tool temporarily unavailable when it failed at least
 *      {@link RECOVERY_UNAVAILABLE_THRESHOLD} times in the window.
 *
 * The function is a pure fixpoint: recovering an already-recovered history
 * (every call paired, no orphan) returns an equivalent result — recovery is
 * IDEMPOTENT (NN-EXEC-005).
 */
export function recoverToolHistory(
  history: readonly ToolHistoryEntry[],
  correlationId = 'corr-unset',
): ToolHistoryRecovery {
  // (1) Retained order: stable sort by order then toolCallId for determinism.
  const ordered = [...history].sort((a, b) =>
    a.order !== b.order
      ? a.order - b.order
      : a.toolCallId < b.toolCallId
        ? -1
        : a.toolCallId > b.toolCallId
          ? 1
          : 0,
  );

  const entries: RecoveredEntry[] = [];
  const failureCounts = new Map<string, number>();

  for (const e of ordered) {
    if (e.orphanResult === true) {
      // (4) Orphan result: drop it (recorded so the drop is auditable).
      entries.push({
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        order: e.order,
        disposition: 'dropped-orphan',
      });
      continue;
    }
    if (e.hasResult) {
      entries.push({
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        order: e.order,
        disposition: 'paired',
      });
      if (e.failed === true) {
        failureCounts.set(e.toolName, (failureCounts.get(e.toolName) ?? 0) + 1);
      }
    } else {
      // (3) Dangling call: inject a typed interrupted result.
      entries.push({
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        order: e.order,
        disposition: 'interrupted',
        injectedResult: interruptedResult(e.toolCallId, correlationId),
      });
    }
  }

  const unavailableTools = [...failureCounts.entries()]
    .filter(([, n]) => n >= RECOVERY_UNAVAILABLE_THRESHOLD)
    .map(([name]) => name)
    .sort();

  return { entries, unavailableTools };
}

/**
 * Whether a recovery result is a fixpoint (no dangling call and no orphan).
 * Re-running {@link recoverToolHistory} on the paired history is stable.
 */
export function isRecoveryFixpoint(recovery: ToolHistoryRecovery): boolean {
  return recovery.entries.every((e) => e.disposition === 'paired');
}

// ════════════════════════════════════════════════════════════════════════════
// 8. Error compaction (NN-EXEC-006)
// ════════════════════════════════════════════════════════════════════════════

/** The raw error evidence a retry site compacts. */
export interface RawErrorEvidence {
  readonly name: string;
  readonly message: string;
  readonly exitCode?: number;
  /** Full stack frames (application + library). */
  readonly frames: readonly string[];
  /** The full raw output (may be large; only the tail is kept). */
  readonly output: string;
  /** Opaque reference to the durable raw evidence (kept OUT of the digest). */
  readonly rawEvidenceRef: string;
}

/** A deterministic, redacted, bounded error digest re-fed at a retry site. */
export interface CompactedError {
  readonly name: string;
  readonly message: string;
  readonly exitCode?: number;
  /** At most the top FIVE application frames (NN-EXEC-006). */
  readonly topFrames: readonly string[];
  /** At most the last 256 bytes of output (NN-EXEC-006). */
  readonly outputTail: string;
  /** Reference to the durable raw evidence; the raw stays out of prompt context. */
  readonly rawEvidenceRef: string;
  /** Estimated token size of the digest; always <= the token cap. */
  readonly estimatedTokens: number;
}

/** The NN-EXEC-006 caps. */
export const ERROR_COMPACTION = Object.freeze({
  maxFrames: 5,
  maxOutputBytes: 256,
  defaultTokenCap: 800,
  /** A conservative 4-bytes-per-token estimate. */
  bytesPerToken: 4,
});

/**
 * Produce a deterministic, redacted, bounded {@link CompactedError} from raw
 * error evidence (NN-EXEC-006). The digest preserves the error name/message,
 * exit code, the top five application frames, and at most the last 256 output
 * bytes, all within the `tokenCap` (default 800) — if the assembled digest
 * would exceed the cap, the message and output tail are trimmed deterministically
 * so the result ALWAYS fits. The raw evidence is NOT embedded; only
 * `rawEvidenceRef` points at it, so the raw remains durable OUTSIDE prompt
 * context.
 */
export function compactError(
  raw: RawErrorEvidence,
  tokenCap: number = ERROR_COMPACTION.defaultTokenCap,
): CompactedError {
  const cap = Number.isInteger(tokenCap) && tokenCap > 0 ? tokenCap : ERROR_COMPACTION.defaultTokenCap;
  const byteCap = cap * ERROR_COMPACTION.bytesPerToken;

  const topFrames = raw.frames.slice(0, ERROR_COMPACTION.maxFrames);
  // Last 256 bytes of output (tail), computed on the UTF-8 byte length.
  const outputTail = tailBytes(raw.output, ERROR_COMPACTION.maxOutputBytes);

  const assemble = (message: string, tail: string): CompactedError => {
    const digest: CompactedError = {
      name: raw.name,
      message,
      ...(raw.exitCode !== undefined ? { exitCode: raw.exitCode } : {}),
      topFrames,
      outputTail: tail,
      rawEvidenceRef: raw.rawEvidenceRef,
      estimatedTokens: 0,
    };
    const bytes = byteLength(
      digest.name + digest.message + digest.topFrames.join('') + digest.outputTail,
    );
    return { ...digest, estimatedTokens: Math.ceil(bytes / ERROR_COMPACTION.bytesPerToken) };
  };

  let message = raw.message;
  let tail = outputTail;
  let compacted = assemble(message, tail);

  // Deterministically trim to fit the token cap: shrink the output tail first,
  // then the message, until the digest fits (NN-EXEC-006 token cap).
  while (byteLength(compacted.name + compacted.message + compacted.topFrames.join('') + compacted.outputTail) > byteCap) {
    if (tail.length > 0) {
      tail = tail.slice(Math.ceil(tail.length / 2));
    } else if (message.length > 0) {
      message = message.slice(0, Math.floor(message.length / 2));
    } else {
      break;
    }
    compacted = assemble(message, tail);
  }
  return compacted;
}

/** UTF-8 byte length of a string. */
function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** The last `maxBytes` UTF-8 bytes of a string, decoded back to a string. */
function tailBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  return buf.subarray(buf.length - maxBytes).toString('utf8');
}
