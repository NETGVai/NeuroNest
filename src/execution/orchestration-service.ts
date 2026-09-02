/**
 * OrchestrationService — the sole write authority for bounded `AgentRun@1`
 * trees, delegation, workflow transitions, blind completion review, and stuck
 * detection (FUT-PKG-06-EXECUTION/T-006).
 *
 * D-04/D-05 name the Orchestration Authority as the canonical owner of the
 * bounded-run concept (identity `runId`, tree by `parentRunId`/`rootRunId`);
 * Kanban, taskbar, and dashboards are read-model projections only. This module
 * implements that authority over a real SQLite database through the
 * single-writer, idempotent-receipt transaction from
 * {@link ../storage/authority-transaction} (D-08.2). Every mutation reconciles
 * its idempotency key first, so a duplicated start/delegate click replays the
 * prior receipt with NO second run (NN-INV-007).
 *
 * The authority enforces the T-006 correctness rules over the D-13 sequence:
 *
 *   - **Topology selection/validation** (NN-ORCH-001/002): the planner picks one
 *     typed topology + agent shape and persists rationale/semantics; the graph
 *     is validated BEFORE any run is created and a CYCLIC topology is REJECTED
 *     (reusing the T-003 DAG cycle detector). An unavailable required primitive
 *     blocks.
 *   - **Delegation** (NN-ORCH-003): a child run records lineage (parent/root,
 *     scope, budget, nesting, permissions never broader than parent, completion
 *     anchor). A child's scope/budget/permissions can NEVER exceed the parent's
 *     — no scope expansion. Only validated final/selected evidence returns to a
 *     parent.
 *   - **Bounded parallelism/retries/nesting** (NN-ORCH-004): hard ceilings on
 *     concurrency, retries, nesting depth, and total spawns; exceeding any bound
 *     BLOCKS admission and is never unbounded.
 *   - **Conflict isolation** (NN-ORCH-005): worktree/symbol locks (see
 *     {@link ./run-locks}) serialize parallel mutations; a lock conflict blocks
 *     WITHOUT discarding another run's Change Set, and one failed/cancelled run
 *     does not terminate unrelated runs.
 *   - **Workflow transitions / runBatch** (NN-ORCH-006/007): typed step
 *     transitions with idempotency; a partial rerun recomputes only affected
 *     downstream dependents; `runBatch` validates 1..50 descriptors
 *     independently, runs safe entries in bounded parallel, preserves order, and
 *     returns per-entry success/error without aborting unaffected descriptors.
 *   - **Completion council** (NN-ORCH-008): a run reaches `succeeded` ONLY when
 *     the council's aggregated BLIND evidence passes; a missing reviewer
 *     capability blocks completion and self-assessment alone cannot succeed.
 *   - **Stuck detection** (NN-ORCH-009): repeated no-progress observations
 *     terminate the run — it never spins forever; thresholds/action are durable.
 *   - **Bounded trusted fallback** (NN-ORCH-010): an ordered, bounded,
 *     health/capability/trust-aware chain; exhaustion is a typed failure and
 *     context never silently moves to a less trusted provider.
 *   - **External-pattern adapters** (NN-ORCH-011): DeerFlow/Kilo/Roo/Hermes/
 *     MindStudio EXTEND this authority (see {@link ./orchestration-types}); no
 *     parallel orchestration truth is created.
 *
 * Cancellation is hierarchical (NN-INV-012): cancelling a run terminates its
 * whole subtree while sibling subtrees and their evidence are preserved (D-18).
 *
 * Design anchors: D-05, D-07 (`AgentRun@1`), D-08 (mutation transaction),
 * D-13 (parallel orchestration + bounded runs), D-18 (failure isolation),
 * D-19 (correlation). Requirements: NN-ORCH-001–012, NN-AGENT-003,
 * NN-WORKSPACE-007, NN-TASK-004/008, NN-INV-003/007/008/012.
 */

import type Database from 'better-sqlite3';

import {
  computeDigest,
  isChildScopeOf,
  makeOpaqueId,
  serializeContract,
  type ErrorCode,
  type ScopeDescriptor,
} from '../shared/contract-primitives';
import {
  applyAuthorityMutation,
  ensureAuthorityTables,
  type AuthorityMutationResult,
} from '../storage/authority-transaction';
import { validateDag } from './dag-validation';
import {
  aggregateCouncil,
  concurrencyAdmits,
  decideStuck,
  isChildBudgetOf,
  isLegalRunTransition,
  isTerminalRunState,
  progressHash,
  retryAdmits,
  selectFallback,
  validateDelegation,
  validateTopology,
  BATCH_MAX,
  BATCH_MIN,
  DEFAULT_EXECUTION_BOUNDS,
  type AgentRun,
  type AgentShape,
  type BatchEntryResult,
  type CouncilSubmission,
  type ExecutionBounds,
  type FallbackCandidate,
  type OrchestrationTopology,
  type RunBudget,
  type RunState,
  type StuckAction,
} from './orchestration-types';
import { ensureRunLockTables } from './run-locks';
import type { PlanEdge } from './task-types';

const AUTHORITY_ID = 'authority-orchestration';

// ─── Canonical durable tables (additive) ──────────────────────────────────────

const ORCHESTRATION_DDL = `
  CREATE TABLE IF NOT EXISTS agent_runs (
    run_id TEXT PRIMARY KEY,
    root_run_id TEXT NOT NULL,
    parent_run_id TEXT,
    plan_id TEXT NOT NULL,
    plan_revision INTEGER NOT NULL,
    topology TEXT NOT NULL,
    shape TEXT NOT NULL,
    state TEXT NOT NULL,
    revision INTEGER NOT NULL,
    nesting_depth INTEGER NOT NULL,
    record_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS run_progress (
    progress_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    progress_hash TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    UNIQUE (run_id, sequence)
  );

  CREATE TABLE IF NOT EXISTS run_evidence (
    evidence_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    criterion_alias TEXT NOT NULL,
    reviewer_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    UNIQUE (run_id, criterion_alias, reviewer_id)
  );

  CREATE INDEX IF NOT EXISTS idx_agent_runs_root ON agent_runs (root_run_id);
  CREATE INDEX IF NOT EXISTS idx_agent_runs_parent ON agent_runs (parent_run_id);
  CREATE INDEX IF NOT EXISTS idx_run_progress_run ON run_progress (run_id);
  CREATE INDEX IF NOT EXISTS idx_run_evidence_run ON run_evidence (run_id);
`;

/**
 * Create the canonical orchestration tables (idempotent, additive). Also
 * ensures the shared authority-transaction and run-lock tables exist so every
 * receipt/outbox/lock commits in the same discipline (D-08.2).
 */
export function ensureOrchestrationTables(db: Database.Database): void {
  ensureAuthorityTables(db);
  ensureRunLockTables(db);
  db.exec(ORCHESTRATION_DDL);
}

// ─── Typed outcomes ───────────────────────────────────────────────────────────

/** Why an orchestration operation was blocked/rejected (secret-free). */
export type OrchestrationBlockReason =
  | 'cycle'
  | 'dangling-edge'
  | 'edges-forbidden'
  | 'batch-bounds'
  | 'unknown-topology'
  | 'scope-expansion'
  | 'budget-expansion'
  | 'permission-expansion'
  | 'nesting-exceeded'
  | 'spawns-exhausted'
  | 'concurrency-exceeded'
  | 'retries-exhausted'
  | 'illegal-transition'
  | 'unknown-run'
  | 'terminal-run'
  | 'council-blocked'
  | 'no-progress'
  | 'fallback-exhausted'
  | 'scope-incomplete';

export interface OrchestrationError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly reason?: OrchestrationBlockReason;
}

export type OrchestrationOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly replayed: boolean }
  | { readonly ok: false; readonly error: OrchestrationError };

function fail<T>(
  code: ErrorCode,
  message: string,
  reason?: OrchestrationBlockReason,
): OrchestrationOutcome<T> {
  return { ok: false, error: { code, message, ...(reason ? { reason } : {}) } };
}

function mapResult<T>(result: AuthorityMutationResult, value: T): OrchestrationOutcome<T> {
  if (result.kind === 'conflict') {
    return { ok: false, error: { code: result.error.code, message: result.error.message } };
  }
  return { ok: true, value, replayed: result.kind === 'replayed' };
}

// ─── Read helpers ─────────────────────────────────────────────────────────────

/** Read one run record, or `undefined` when absent. */
export function readRun(db: Database.Database, runId: string): AgentRun | undefined {
  const row = db
    .prepare('SELECT record_json FROM agent_runs WHERE run_id = ?')
    .get(runId) as { record_json: string } | undefined;
  return row ? (JSON.parse(row.record_json) as AgentRun) : undefined;
}

/** Read every run in a tree (root + descendants), ordered by id. */
export function readRunTree(db: Database.Database, rootRunId: string): AgentRun[] {
  const rows = db
    .prepare('SELECT record_json FROM agent_runs WHERE root_run_id = ? ORDER BY run_id')
    .all(rootRunId) as { record_json: string }[];
  return rows.map((r) => JSON.parse(r.record_json) as AgentRun);
}

/** Read the direct children of a run. */
export function readChildRuns(db: Database.Database, parentRunId: string): AgentRun[] {
  const rows = db
    .prepare('SELECT record_json FROM agent_runs WHERE parent_run_id = ? ORDER BY run_id')
    .all(parentRunId) as { record_json: string }[];
  return rows.map((r) => JSON.parse(r.record_json) as AgentRun);
}

/** Count spawns (direct children) a run has already produced. */
export function countSpawns(db: Database.Database, parentRunId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE parent_run_id = ?')
    .get(parentRunId) as { n: number };
  return row.n;
}

/** Count currently-running direct children of a run (for concurrency bound). */
export function countRunningChildren(db: Database.Database, parentRunId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM agent_runs WHERE parent_run_id = ? AND state = 'running'`,
    )
    .get(parentRunId) as { n: number };
  return row.n;
}

// ─── Command context ───────────────────────────────────────────────────────────

export interface OrchestrationCommandContext {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly scope: ScopeDescriptor;
  readonly now?: () => Date;
}

function requestDigest(payload: unknown): string {
  return computeDigest(payload);
}

// ─── Start a root run (NN-ORCH-001/002) ──────────────────────────────────────

export interface StartRunInput extends OrchestrationCommandContext {
  readonly planId: string;
  readonly planRevision: number;
  readonly topology: OrchestrationTopology;
  readonly shape: AgentShape;
  readonly taskIds: readonly string[];
  readonly edges: readonly PlanEdge[];
  readonly budget: RunBudget;
  readonly bounds?: ExecutionBounds;
  readonly permissions: readonly string[];
  readonly completionAnchor: readonly string[];
  readonly rationale: string;
  readonly agentId?: string;
  readonly runId?: string;
  /** Availability of the required primitives (agents/skills/tools/reviewers). */
  readonly requiredPrimitivesAvailable?: boolean;
}

/**
 * Start a ROOT run for an approved plan revision (NN-ORCH-001/002). Topology
 * validation runs BEFORE any row is written: a cyclic graph (or a bad batch /
 * forbidden edge) is REJECTED with `VALIDATION` and NO run is created — a cyclic
 * topology is invalid. If a required primitive is unavailable the start is
 * BLOCKED with `UNAVAILABLE`. The run is created `planned` at nesting depth 0
 * with its rationale/semantics persisted.
 */
export function startRun(
  db: Database.Database,
  input: StartRunInput,
): OrchestrationOutcome<AgentRun> {
  const topology = validateTopology(input.topology, input.taskIds, input.edges, {
    maxBatch: BATCH_MAX,
  });
  if (!topology.ok) {
    return fail('VALIDATION', topology.detail, topology.reason);
  }
  if (input.requiredPrimitivesAvailable === false) {
    return fail(
      'UNAVAILABLE',
      'a required orchestration primitive (agent/skill/tool/reviewer) is unavailable; start blocked',
    );
  }

  const bounds = input.bounds ?? DEFAULT_EXECUTION_BOUNDS;
  const runId = input.runId ?? makeOpaqueId('run', `${input.planId}${input.planRevision}${input.commandId}`);
  const nowIso = (input.now ?? (() => new Date()))().toISOString();

  const record: AgentRun = {
    schemaVersion: 1,
    runId,
    rootRunId: runId,
    planId: input.planId,
    planRevision: input.planRevision,
    topology: input.topology,
    shape: input.shape,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    scope: input.scope,
    budget: input.budget,
    bounds,
    nestingDepth: 0,
    permissions: [...input.permissions],
    completionAnchor: [...input.completionAnchor],
    rationale: input.rationale,
    state: 'planned',
    revision: 1,
    attempts: 0,
    createdAt: nowIso,
    redaction: 'internal',
  };

  return commitRun(db, input, record, 'run.started', {
    planId: input.planId,
    planRevision: input.planRevision,
    topology: input.topology,
  });
}

// ─── Delegate a child run (NN-ORCH-003/004) ──────────────────────────────────

export interface DelegateRunInput extends OrchestrationCommandContext {
  readonly parentRunId: string;
  readonly childScope: ScopeDescriptor;
  readonly childBudget: RunBudget;
  readonly childPermissions: readonly string[];
  readonly completionAnchor: readonly string[];
  readonly rationale: string;
  readonly topology: OrchestrationTopology;
  readonly shape: AgentShape;
  readonly agentId?: string;
  readonly childRunId?: string;
  readonly taskIds?: readonly string[];
  readonly edges?: readonly PlanEdge[];
}

/**
 * Delegate a CHILD run beneath `parentRunId` (NN-ORCH-003/004). Fails closed on
 * every expansion or bound violation with NO row written:
 *
 *   - the parent must exist and NOT be terminal (a terminal parent admits no
 *     new child — NN-INV-012);
 *   - the child scope must be a subset of the parent (no scope expansion),
 *     budget bounded by the parent (no budget expansion), permissions a subset
 *     (never broader than parent — NN-AGENT-003);
 *   - nesting depth (parent+1) must not exceed the bound, and the parent must
 *     have remaining spawn allotment AND concurrency headroom (bounded
 *     parallelism/nesting — never unbounded).
 *
 * The child inherits the root and the parent's bounds and is created `planned`.
 */
export function delegateRun(
  db: Database.Database,
  input: DelegateRunInput,
): OrchestrationOutcome<AgentRun> {
  const parent = readRun(db, input.parentRunId);
  if (!parent) {
    return fail('VALIDATION', `unknown parent run '${input.parentRunId}'`, 'unknown-run');
  }
  if (isTerminalRunState(parent.state)) {
    return fail(
      'CANCELLED',
      `parent run '${input.parentRunId}' is '${parent.state}'; no new child admitted`,
      'terminal-run',
    );
  }

  const childNestingDepth = parent.nestingDepth + 1;
  const spawnsUsed = countSpawns(db, parent.runId);
  const delegation = validateDelegation({
    parentScope: parent.scope,
    childScope: input.childScope,
    parentBudget: parent.budget,
    childBudget: input.childBudget,
    parentPermissions: parent.permissions,
    childPermissions: input.childPermissions,
    childNestingDepth,
    bounds: parent.bounds,
    parentSpawnsUsed: spawnsUsed,
  });
  if (!delegation.ok) {
    const code: ErrorCode =
      delegation.reason === 'spawns-exhausted' ? 'BUDGET_EXCEEDED' : 'FORBIDDEN';
    return fail(code, delegation.detail, delegation.reason);
  }

  // Bounded parallelism: the parent may only have maxConcurrency running kids.
  const running = countRunningChildren(db, parent.runId);
  if (!concurrencyAdmits(running, parent.bounds)) {
    return fail(
      'CONFLICT',
      `parent run '${parent.runId}' already has ${running} running children (bound ${parent.bounds.maxConcurrency})`,
      'concurrency-exceeded',
    );
  }

  // Validate the child's own task graph if one is declared.
  if (input.taskIds && input.taskIds.length > 0) {
    const topo = validateTopology(input.topology, input.taskIds, input.edges ?? [], {
      maxBatch: BATCH_MAX,
    });
    if (!topo.ok) return fail('VALIDATION', topo.detail, topo.reason);
  }

  const childRunId =
    input.childRunId ?? makeOpaqueId('run', `${parent.runId}child${input.commandId}`);
  const nowIso = (input.now ?? (() => new Date()))().toISOString();

  const record: AgentRun = {
    schemaVersion: 1,
    runId: childRunId,
    rootRunId: parent.rootRunId,
    parentRunId: parent.runId,
    planId: parent.planId,
    planRevision: parent.planRevision,
    topology: input.topology,
    shape: input.shape,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    scope: input.childScope,
    budget: input.childBudget,
    bounds: parent.bounds,
    nestingDepth: childNestingDepth,
    permissions: [...input.childPermissions],
    completionAnchor: [...input.completionAnchor],
    rationale: input.rationale,
    state: 'planned',
    revision: 1,
    attempts: 0,
    createdAt: nowIso,
    redaction: 'internal',
  };

  return commitRun(db, input, record, 'run.delegated', {
    parentRunId: parent.runId,
    rootRunId: parent.rootRunId,
    nestingDepth: childNestingDepth,
  });
}

/** Shared run-insert mutation used by {@link startRun} and {@link delegateRun}. */
function commitRun(
  db: Database.Database,
  ctx: OrchestrationCommandContext,
  record: AgentRun,
  eventType: string,
  eventPayload: Record<string, unknown>,
): OrchestrationOutcome<AgentRun> {
  const nowIso = record.createdAt;
  const result = applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: ctx.commandId,
    idempotencyKey: ctx.idempotencyKey,
    requestDigest: requestDigest({ op: eventType, runId: record.runId, digest: serializeContract(record) }),
    correlationId: ctx.correlationId,
    scope: ctx.scope,
    ...(ctx.now ? { now: ctx.now } : {}),
    mutate: (tx) => {
      tx.prepare(
        `INSERT INTO agent_runs
           (run_id, root_run_id, parent_run_id, plan_id, plan_revision, topology, shape,
            state, revision, nesting_depth, record_json, created_at)
         VALUES (@runId, @rootRunId, @parentRunId, @planId, @planRevision, @topology, @shape,
            @state, @revision, @nestingDepth, @recordJson, @createdAt)`,
      ).run({
        runId: record.runId,
        rootRunId: record.rootRunId,
        parentRunId: record.parentRunId ?? null,
        planId: record.planId,
        planRevision: record.planRevision,
        topology: record.topology,
        shape: record.shape,
        state: record.state,
        revision: record.revision,
        nestingDepth: record.nestingDepth,
        recordJson: serializeContract(record),
        createdAt: nowIso,
      });
      return { resultRef: record.runId };
    },
    events: [
      {
        eventType,
        aggregateType: 'agent-run',
        aggregateId: record.runId,
        payloadSchemaName: 'AgentRun',
        payloadSchemaVersion: 1,
        payload: eventPayload,
        redaction: 'internal',
      },
    ],
  });
  return mapResult(result, record);
}

// ─── Transition a run (NN-TASK-004 ladder; bounded retries) ──────────────────

export interface TransitionRunInput extends OrchestrationCommandContext {
  readonly runId: string;
  readonly toState: RunState;
  /** When transitioning back to `running` as a retry, whether it is a retry. */
  readonly isRetry?: boolean;
}

/**
 * Transition a run through the canonical ladder (D-07.1). An unknown/illegal
 * transition is a `CONFLICT` with no effect. A retry back to `running` is
 * bounded: once `attempts` reaches `bounds.maxRetries` a further retry is
 * REJECTED with `retries-exhausted` (bounded retries, never unbounded). The
 * run's `revision` bumps on every accepted transition.
 */
export function transitionRun(
  db: Database.Database,
  input: TransitionRunInput,
): OrchestrationOutcome<AgentRun> {
  const run = readRun(db, input.runId);
  if (!run) return fail('VALIDATION', `unknown run '${input.runId}'`, 'unknown-run');
  if (isTerminalRunState(run.state)) {
    return fail('CONFLICT', `run '${input.runId}' is terminal (${run.state})`, 'terminal-run');
  }
  if (!isLegalRunTransition(run.state, input.toState)) {
    return fail(
      'CONFLICT',
      `illegal run transition ${run.state} -> ${input.toState}`,
      'illegal-transition',
    );
  }

  let attempts = run.attempts;
  if (input.isRetry && input.toState === 'running') {
    if (!retryAdmits(run.attempts, run.bounds)) {
      return fail(
        'BUDGET_EXCEEDED',
        `retry budget of ${run.bounds.maxRetries} exhausted for run '${input.runId}'`,
        'retries-exhausted',
      );
    }
    attempts = run.attempts + 1;
  }

  const updated: AgentRun = {
    ...run,
    state: input.toState,
    revision: run.revision + 1,
    attempts,
  };
  return persistRunUpdate(db, input, updated, 'run.transitioned', {
    from: run.state,
    to: input.toState,
    attempts,
  });
}

// ─── Record progress + stuck detection (NN-ORCH-009) ─────────────────────────

export interface RecordProgressInput extends OrchestrationCommandContext {
  readonly runId: string;
  /** The observation to hash (tool calls, findings, open ids). */
  readonly observation: unknown;
}

/** The outcome of {@link recordProgress}: the stuck action taken this tick. */
export interface ProgressOutcome {
  readonly action: StuckAction;
  readonly run: AgentRun;
}

/**
 * Record one progress observation and evaluate stuck detection (NN-ORCH-009).
 * The observation is hashed (key-order-independent) and appended to the run's
 * durable progress log. When the last `maxNoProgressIterations` hashes are all
 * equal, the run is NO-PROGRESS: it is transitioned to `failed` (terminated,
 * never spins forever) and the action is `stop`. A short repeat streak yields an
 * `advisory` without terminating. The threshold and resulting action are the
 * durable evidence.
 */
export function recordProgress(
  db: Database.Database,
  input: RecordProgressInput,
): OrchestrationOutcome<ProgressOutcome> {
  const run = readRun(db, input.runId);
  if (!run) return fail('VALIDATION', `unknown run '${input.runId}'`, 'unknown-run');
  if (isTerminalRunState(run.state)) {
    return fail('CONFLICT', `run '${input.runId}' is terminal`, 'terminal-run');
  }

  const hash = progressHash(input.observation);
  const priorHashes = readProgressHashes(db, input.runId);
  const hashes = [...priorHashes, hash];
  const action = decideStuck(hashes, run.bounds);
  const nowIso = (input.now ?? (() => new Date()))().toISOString();
  const nextSeq = priorHashes.length + 1;

  const stop = action === 'stop';
  const updated: AgentRun = stop
    ? { ...run, state: 'failed', revision: run.revision + 1 }
    : run;

  const result = applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({ op: 'record-progress', runId: input.runId, hash, seq: nextSeq }),
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      tx.prepare(
        `INSERT INTO run_progress (progress_id, run_id, sequence, progress_hash, recorded_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        makeOpaqueId('prog', `${input.runId}${nextSeq}`),
        input.runId,
        nextSeq,
        hash,
        nowIso,
      );
      if (stop) {
        tx.prepare('UPDATE agent_runs SET state = ?, revision = ?, record_json = ? WHERE run_id = ?').run(
          updated.state,
          updated.revision,
          serializeContract(updated),
          input.runId,
        );
      }
      return { resultRef: input.runId };
    },
    events: [
      {
        eventType: stop ? 'run.no-progress-terminated' : 'run.progress',
        aggregateType: 'agent-run',
        aggregateId: input.runId,
        payloadSchemaName: 'AgentRun',
        payloadSchemaVersion: 1,
        payload: { runId: input.runId, action, sequence: nextSeq },
        redaction: 'internal',
      },
    ],
  });

  if (result.kind === 'conflict') {
    return { ok: false, error: { code: result.error.code, message: result.error.message } };
  }
  return { ok: true, value: { action, run: updated }, replayed: result.kind === 'replayed' };
}

function readProgressHashes(db: Database.Database, runId: string): string[] {
  const rows = db
    .prepare('SELECT progress_hash FROM run_progress WHERE run_id = ? ORDER BY sequence')
    .all(runId) as { progress_hash: string }[];
  return rows.map((r) => r.progress_hash);
}

// ─── Blind completion review (NN-ORCH-008) ───────────────────────────────────

export interface RecordVerdictInput extends OrchestrationCommandContext {
  readonly runId: string;
  readonly reviewerId: string;
  readonly criterionAlias: string;
  readonly outcome: 'pass' | 'fail';
}

/**
 * Record ONE blind reviewer verdict for a run (NN-ORCH-008). The verdict is
 * stored keyed by `(run, criterion, reviewer)` so a duplicate is idempotent.
 * The stored evidence never carries the author identity — the reviewer never
 * sees who authored the work (blind review). This does not itself complete the
 * run; {@link tryComplete} aggregates the verdicts against the exact anchor.
 */
export function recordVerdict(
  db: Database.Database,
  input: RecordVerdictInput,
): OrchestrationOutcome<{ readonly runId: string }> {
  const run = readRun(db, input.runId);
  if (!run) return fail('VALIDATION', `unknown run '${input.runId}'`, 'unknown-run');
  const nowIso = (input.now ?? (() => new Date()))().toISOString();

  const result = applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({
      op: 'record-verdict',
      runId: input.runId,
      reviewerId: input.reviewerId,
      criterionAlias: input.criterionAlias,
      outcome: input.outcome,
    }),
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      tx.prepare(
        `INSERT INTO run_evidence (evidence_id, run_id, criterion_alias, reviewer_id, outcome, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, criterion_alias, reviewer_id) DO UPDATE SET
           outcome = excluded.outcome, recorded_at = excluded.recorded_at`,
      ).run(
        makeOpaqueId('rev', `${input.runId}${input.reviewerId}${input.criterionAlias}`),
        input.runId,
        input.criterionAlias,
        input.reviewerId,
        input.outcome,
        nowIso,
      );
      return { resultRef: input.runId };
    },
    events: [
      {
        eventType: 'run.verdict.recorded',
        aggregateType: 'agent-run',
        aggregateId: input.runId,
        payloadSchemaName: 'AgentRun',
        payloadSchemaVersion: 1,
        payload: { runId: input.runId, criterionAlias: input.criterionAlias },
        redaction: 'internal',
      },
    ],
  });

  return mapResult(result, { runId: input.runId });
}

/** Read the blind verdicts recorded for a run (no author identity is stored). */
export function readVerdicts(
  db: Database.Database,
  runId: string,
): { readonly reviewerId: string; readonly criterionAlias: string; readonly outcome: 'pass' | 'fail' }[] {
  const rows = db
    .prepare('SELECT reviewer_id, criterion_alias, outcome FROM run_evidence WHERE run_id = ?')
    .all(runId) as { reviewer_id: string; criterion_alias: string; outcome: string }[];
  return rows.map((r) => ({
    reviewerId: r.reviewer_id,
    criterionAlias: r.criterion_alias,
    outcome: r.outcome === 'pass' ? 'pass' : 'fail',
  }));
}

// ─── Completion council gate (NN-ORCH-008) ───────────────────────────────────

export interface TryCompleteInput extends OrchestrationCommandContext {
  readonly runId: string;
  /** The reviewers that MUST render a verdict (missing => blocked). */
  readonly requiredReviewers: readonly string[];
}

/**
 * Attempt to complete a run through the completion council (NN-ORCH-008). The
 * run must be in `reviewing`. The council aggregates the run's BLIND verdicts
 * against its exact completion anchor:
 *
 *   - a run completes ONLY when every required reviewer rendered a verdict AND
 *     every anchor criterion has a passing verdict from a required reviewer;
 *   - a MISSING reviewer (unavailable) BLOCKS completion — never auto-passes;
 *   - self-assessment over zero criteria cannot succeed.
 *
 * On acceptance the run transitions to `succeeded`; otherwise it is BLOCKED with
 * a typed reason and NO success is recorded (NN-INV-003).
 */
export function tryComplete(
  db: Database.Database,
  input: TryCompleteInput,
): OrchestrationOutcome<AgentRun> {
  const run = readRun(db, input.runId);
  if (!run) return fail('VALIDATION', `unknown run '${input.runId}'`, 'unknown-run');
  if (run.state !== 'reviewing') {
    return fail(
      'CONFLICT',
      `run '${input.runId}' must be 'reviewing' to complete (is '${run.state}')`,
      'illegal-transition',
    );
  }

  const submission: CouncilSubmission = {
    runId: run.runId,
    requiredCriteria: run.completionAnchor,
    requiredReviewers: input.requiredReviewers,
    verdicts: readVerdicts(db, run.runId),
  };
  const decision = aggregateCouncil(submission);
  if (decision.kind === 'blocked') {
    // Council blocked: the run does NOT succeed; leave it in `reviewing`.
    return fail('FORBIDDEN', decision.detail, 'council-blocked');
  }

  const updated: AgentRun = { ...run, state: 'succeeded', revision: run.revision + 1 };
  return persistRunUpdate(db, input, updated, 'run.completed', { runId: run.runId });
}

// ─── Hierarchical cancel (NN-INV-012, D-18 isolation) ────────────────────────

export interface CancelSubtreeInput extends OrchestrationCommandContext {
  readonly runId: string;
  readonly reason?: string;
  readonly forced?: boolean;
}

/**
 * Cancel a run and its whole subtree (NN-INV-012, D-18). Every non-terminal run
 * in the subtree rooted at `runId` transitions to `cancelled` (or
 * `forced-terminated` when `forced`). Runs OUTSIDE the subtree — sibling
 * subtrees and their evidence — are left completely untouched: one
 * failed/cancelled run never terminates unrelated runs or discards their work.
 * The whole subtree cancellation commits atomically.
 */
export function cancelSubtree(
  db: Database.Database,
  input: CancelSubtreeInput,
): OrchestrationOutcome<{ readonly cancelled: readonly string[] }> {
  const root = readRun(db, input.runId);
  if (!root) return fail('VALIDATION', `unknown run '${input.runId}'`, 'unknown-run');

  const tree = readRunTree(db, root.rootRunId);
  const byParent = new Map<string, AgentRun[]>();
  for (const r of tree) {
    if (r.parentRunId) {
      const list = byParent.get(r.parentRunId) ?? [];
      list.push(r);
      byParent.set(r.parentRunId, list);
    }
  }
  // BFS the subtree rooted at input.runId.
  const subtree: AgentRun[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    subtree.push(node);
    for (const child of byParent.get(node.runId) ?? []) stack.push(child);
  }

  const toState: RunState = input.forced ? 'forced-terminated' : 'cancelled';
  const affected = subtree.filter((r) => !isTerminalRunState(r.state));
  const nowIso = (input.now ?? (() => new Date()))().toISOString();

  const result = applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({ op: 'cancel-subtree', runId: input.runId, toState }),
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      const stmt = tx.prepare(
        'UPDATE agent_runs SET state = ?, revision = revision + 1, record_json = ? WHERE run_id = ?',
      );
      for (const r of affected) {
        const updated: AgentRun = { ...r, state: toState, revision: r.revision + 1 };
        stmt.run(toState, serializeContract(updated), r.runId);
      }
      return { resultRef: input.runId };
    },
    events: [
      {
        eventType: input.forced ? 'run.forced-terminated' : 'run.cancelled',
        aggregateType: 'agent-run',
        aggregateId: input.runId,
        payloadSchemaName: 'AgentRun',
        payloadSchemaVersion: 1,
        payload: { runId: input.runId, count: affected.length, reason: input.reason ?? 'cancelled' },
        redaction: 'internal',
      },
    ],
  });

  return mapResult(result, { cancelled: affected.map((r) => r.runId) });
}

// ─── Deterministic child aggregation (NN-TASK-008 boomerang) ─────────────────

/** The deterministic aggregate of a run's direct children (NN-TASK-008). */
export interface RunAggregate {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly pending: number;
  /** Whether the parent may itself succeed (all children succeeded). */
  readonly allSucceeded: boolean;
  /** Failed child run ids, preserved independently (no cross-child masking). */
  readonly failedRunIds: readonly string[];
}

/**
 * Deterministically aggregate a parent run's direct children (NN-TASK-008).
 * Independent child failures are PRESERVED (a sibling failure never masks a
 * sibling success), and the parent may succeed only when every child succeeded.
 * Pure over the persisted child states; the same tree always aggregates
 * identically.
 */
export function aggregateChildRuns(db: Database.Database, parentRunId: string): RunAggregate {
  const children = readChildRuns(db, parentRunId);
  let succeeded = 0;
  let failed = 0;
  let cancelled = 0;
  let pending = 0;
  const failedRunIds: string[] = [];
  for (const child of children) {
    switch (child.state) {
      case 'succeeded':
        succeeded += 1;
        break;
      case 'failed':
        failed += 1;
        failedRunIds.push(child.runId);
        break;
      case 'cancelled':
      case 'forced-terminated':
        cancelled += 1;
        break;
      default:
        pending += 1;
    }
  }
  return {
    total: children.length,
    succeeded,
    failed,
    cancelled,
    pending,
    allSucceeded: children.length > 0 && succeeded === children.length,
    failedRunIds: failedRunIds.sort((a, b) => a.localeCompare(b)),
  };
}

// ─── runBatch (NN-ORCH-007) ──────────────────────────────────────────────────

/**
 * Execute a batch of independent descriptors (NN-ORCH-007). Accepts 1..50
 * descriptors, validates each INDEPENDENTLY, runs each `execute` in declaration
 * order (bounded — no descriptor is unbounded), preserves RESULT ORDER, and
 * returns a per-entry success/error. An error in one descriptor never aborts an
 * unaffected descriptor: a throwing/invalid entry is captured as a typed error
 * while the others still run. This is a pure control helper (the caller's
 * `execute`/`validate` perform any durable effect through this authority).
 */
export function runBatch<D, R>(
  descriptors: readonly D[],
  handlers: {
    readonly validate: (descriptor: D, index: number) => { readonly ok: true } | { readonly ok: false; readonly code: ErrorCode; readonly message: string };
    readonly execute: (descriptor: D, index: number) => R;
  },
):
  | { readonly ok: false; readonly error: OrchestrationError }
  | { readonly ok: true; readonly results: readonly BatchEntryResult<R>[] } {
  if (descriptors.length < BATCH_MIN || descriptors.length > BATCH_MAX) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: `runBatch accepts ${BATCH_MIN}..${BATCH_MAX} descriptors, got ${descriptors.length}`,
        reason: 'batch-bounds',
      },
    };
  }

  const results: BatchEntryResult<R>[] = [];
  for (let index = 0; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index]!;
    const validation = handlers.validate(descriptor, index);
    if (!validation.ok) {
      results.push({ index, ok: false, errorCode: validation.code, errorMessage: validation.message });
      continue;
    }
    try {
      const value = handlers.execute(descriptor, index);
      results.push({ index, ok: true, value });
    } catch (err) {
      // One entry's failure never aborts unaffected descriptors.
      results.push({
        index,
        ok: false,
        errorCode: 'INTERNAL',
        errorMessage: err instanceof Error ? err.message : 'batch entry failed',
      });
    }
  }
  return { ok: true, results };
}

// ─── Bounded trusted fallback (NN-ORCH-010) ──────────────────────────────────

/**
 * Select a provider from an ordered, bounded fallback chain (NN-ORCH-010).
 * Delegates to the pure {@link selectFallback}: walks the chain up to
 * `bounds.maxFallbackHops` hops choosing the first healthy, capable,
 * non-downgrading provider. Exhaustion returns a typed `UNAVAILABLE` failure and
 * context never silently moves to a LESS trusted provider.
 */
export function chooseFallbackProvider(
  chain: readonly FallbackCandidate[],
  sourceTrust: number,
  bounds: ExecutionBounds = DEFAULT_EXECUTION_BOUNDS,
): OrchestrationOutcome<{ readonly providerId: string; readonly hop: number }> {
  const selection = selectFallback(chain, sourceTrust, bounds);
  if (selection.kind === 'exhausted') {
    return fail('UNAVAILABLE', selection.detail, 'fallback-exhausted');
  }
  return { ok: true, value: { providerId: selection.providerId, hop: selection.hop }, replayed: false };
}

// ─── Shared persist-update mutation ───────────────────────────────────────────

function persistRunUpdate(
  db: Database.Database,
  ctx: OrchestrationCommandContext,
  updated: AgentRun,
  eventType: string,
  eventPayload: Record<string, unknown>,
): OrchestrationOutcome<AgentRun> {
  const result = applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: ctx.commandId,
    idempotencyKey: ctx.idempotencyKey,
    requestDigest: requestDigest({ op: eventType, runId: updated.runId, revision: updated.revision }),
    correlationId: ctx.correlationId,
    scope: ctx.scope,
    ...(ctx.now ? { now: ctx.now } : {}),
    mutate: (tx) => {
      tx.prepare(
        'UPDATE agent_runs SET state = ?, revision = ?, record_json = ? WHERE run_id = ?',
      ).run(updated.state, updated.revision, serializeContract(updated), updated.runId);
      return { resultRef: updated.runId };
    },
    events: [
      {
        eventType,
        aggregateType: 'agent-run',
        aggregateId: updated.runId,
        payloadSchemaName: 'AgentRun',
        payloadSchemaVersion: 1,
        payload: eventPayload,
        redaction: 'internal',
      },
    ],
  });
  return mapResult(result, updated);
}

// ─── Scope subset re-export (delegation guard convenience) ────────────────────

/** Whether `child` scope is a subset of `parent` (no scope expansion). */
export function isChildScope(child: ScopeDescriptor, parent: ScopeDescriptor): boolean {
  return isChildScopeOf(child, parent);
}

/** Whether `child` budget is bounded by `parent` (no budget expansion). */
export function isChildBudget(child: RunBudget, parent: RunBudget): boolean {
  return isChildBudgetOf(child, parent);
}
