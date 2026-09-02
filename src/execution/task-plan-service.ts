/**
 * TaskPlanService — the sole write authority for `Task@1` / `PlanRevision@1`
 * (FUT-PKG-06-EXECUTION/T-003).
 *
 * D-04 names `TaskPlanService` as the canonical owner of the Task/Plan concept
 * (identity `taskId`, `planId + planRevision`); Kanban, taskbar, and scheduler
 * are read-model projections only. This module implements that authority over a
 * real SQLite database through the single-writer, idempotent-receipt
 * transaction from {@link ../storage/authority-transaction} (D-08.2). Every
 * mutation runs inside one serialized transaction that reconciles the
 * idempotency key first, so a duplicated dispatch click replays the prior
 * receipt with NO second dispatch (NN-TASK-005).
 *
 * The authority enforces the T-003 correctness rules:
 *
 *   - **State machine** (NN-TASK-004): transitions are validated against the
 *     canonical ladder; a terminal state is immutable.
 *   - **DAG validation** (NN-TASK-003): a plan whose graph has a cycle (without
 *     an explicit bounded-loop topology) is REJECTED at commit — a cycle can
 *     never be created and thus can never become success.
 *   - **Readiness / dispatch** (NN-TASK-002): only tasks whose dependencies are
 *     all `succeeded`, whose readiness inputs are satisfied, and whose approval
 *     binding is current become dispatchable. Dispatch retains the selected
 *     project, agent/orchestrator, source surface, session, and correlation
 *     (NN-WORKSPACE-002, NN-COMPAT-006, NN-TASK-005).
 *   - **Exact approval binding** (NN-APPROVAL-002, NN-TASK-003): the approval
 *     digest is recomputed via `computeApprovalDigest` over the CURRENT plan
 *     revision. A plan edit creates a new revision, so a decision bound to the
 *     prior revision no longer matches — a stale approval never authorizes
 *     dispatch, and prior evidence (bound to the prior revision) no longer
 *     completes the task.
 *   - **Evidence-gated success** (NN-TASK-006, NN-OPS-001): a task reaches
 *     `succeeded` ONLY when {@link evaluateEvidenceCompletion} passes — every
 *     criterion has same-plan-revision, same-implementation-revision passing
 *     evidence and every required gate passes, and no prohibited-outcome class
 *     (cycle, stale approval, missing dependency/environment/gate, failed tool,
 *     incomplete cancellation) is present.
 *   - **Boomerang aggregation** (NN-TASK-008): a parent task's state is derived
 *     deterministically from its children — independent child failures are
 *     preserved, and the parent cannot succeed while any child is unfinished or
 *     failed.
 *   - **Schedules** (NN-TASK-007): durable, project-scoped, validated,
 *     pauseable/resumable; a high-risk unattended action routes to approval and
 *     cannot inherit stale authority.
 *
 * Additive migration (NN-COMPAT-006): tables are created with `IF NOT EXISTS`
 * and legacy tasks import with a `legacyProvenance` marker. Rollback = stop
 * calling {@link dispatchTask}; existing state and evidence rows are preserved.
 *
 * Design anchors: D-04, D-07 (`Task@1`, `PlanRevision@1`), D-08 (mutation
 * transaction), D-13 (parallel orchestration + boomerang), D-22, D-26.
 * Requirements: NN-TASK-001–009, NN-WORKSPACE-002, NN-OPS-001, NN-COMPAT-006,
 * NN-APPROVAL-002, NN-INV-003/007/008.
 */

import type Database from 'better-sqlite3';

import {
  computeApprovalDigest,
  type ApprovalDecision,
  type ApprovalRisk,
} from '../approval/approval-types';
import {
  computeDigest,
  makeOpaqueId,
  serializeContract,
  type ErrorCode,
  type ScopeDescriptor,
} from '../shared/contract-primitives';
import {
  applyAuthorityMutation,
  computeScopeKey as computeScopeKeyForContract,
  ensureAuthorityTables,
  readCommandReceipt,
  type AuthorityMutationResult,
} from '../storage/authority-transaction';
import {
  dependenciesSatisfied,
  validateDag,
} from './dag-validation';
import {
  computePlanDigest,
  evaluateEvidenceCompletion,
  isLegalTaskTransition,
  isReady,
  isTerminalTaskState,
  taskScopeComplete,
  type EvidenceView,
  type PlanEdge,
  type PlanRevision,
  type PlanTopology,
  type Task,
  type TaskFailureClass,
  type TaskReadiness,
  type TaskState,
  type ValidationGate,
} from './task-types';

const AUTHORITY_ID = 'authority-task-plan';

// ─── Canonical durable tables (additive; NN-COMPAT-006) ─────────────────────

const TASK_PLAN_DDL = `
  CREATE TABLE IF NOT EXISTS plan_revisions (
    plan_id TEXT NOT NULL,
    plan_revision INTEGER NOT NULL,
    digest TEXT NOT NULL,
    superseded INTEGER NOT NULL DEFAULT 0,
    record_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (plan_id, plan_revision)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    plan_revision INTEGER NOT NULL,
    project_id TEXT,
    parent_task_id TEXT,
    state TEXT NOT NULL,
    revision INTEGER NOT NULL,
    record_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_evidence (
    evidence_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    criterion_alias TEXT NOT NULL,
    implementation_revision TEXT NOT NULL,
    bound_plan_revision INTEGER NOT NULL,
    result TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_approvals (
    approval_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    bound_action_digest TEXT NOT NULL,
    bound_plan_revision INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    decision_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_dispatches (
    dispatch_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    agent_id TEXT,
    orchestrator INTEGER NOT NULL DEFAULT 0,
    source_surface TEXT NOT NULL,
    session_id TEXT,
    correlation_id TEXT NOT NULL,
    dispatched_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_schedules (
    schedule_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    cron TEXT NOT NULL,
    risk TEXT NOT NULL,
    state TEXT NOT NULL,
    authority_snapshot_json TEXT NOT NULL,
    record_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks (plan_id, plan_revision);
  CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks (parent_task_id);
  CREATE INDEX IF NOT EXISTS idx_task_evidence_task ON task_evidence (task_id);
  CREATE INDEX IF NOT EXISTS idx_task_dispatches_task ON task_dispatches (task_id);
`;

/**
 * Create the canonical Task/Plan tables (idempotent, additive). Also ensures
 * the shared authority-transaction tables exist so receipts/outbox commit in
 * the same transaction as the business rows (D-08.2).
 */
export function ensureTaskPlanTables(db: Database.Database): void {
  ensureAuthorityTables(db);
  db.exec(TASK_PLAN_DDL);
}

// ─── Typed outcomes ──────────────────────────────────────────────────────────

/** A typed failure surfaced by the authority (secret-free). */
export interface TaskPlanError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly failureClass?: TaskFailureClass;
}

export type TaskPlanOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly replayed: boolean }
  | { readonly ok: false; readonly error: TaskPlanError };

function fail<T>(
  code: ErrorCode,
  message: string,
  failureClass?: TaskFailureClass,
): TaskPlanOutcome<T> {
  return {
    ok: false,
    error: { code, message, ...(failureClass ? { failureClass } : {}) },
  };
}

// ─── Row read helpers ─────────────────────────────────────────────────────────

/** Read a task record by id, or `undefined` when absent. */
export function readTask(db: Database.Database, taskId: string): Task | undefined {
  const row = db
    .prepare('SELECT record_json FROM tasks WHERE task_id = ?')
    .get(taskId) as { record_json: string } | undefined;
  return row ? (JSON.parse(row.record_json) as Task) : undefined;
}

/** Read a plan revision record, or `undefined` when absent. */
export function readPlanRevision(
  db: Database.Database,
  planId: string,
  planRevision: number,
): PlanRevision | undefined {
  const row = db
    .prepare(
      'SELECT record_json FROM plan_revisions WHERE plan_id = ? AND plan_revision = ?',
    )
    .get(planId, planRevision) as { record_json: string } | undefined;
  return row ? (JSON.parse(row.record_json) as PlanRevision) : undefined;
}

/** Read the latest (highest) plan revision for a plan id. */
export function readLatestPlanRevision(
  db: Database.Database,
  planId: string,
): PlanRevision | undefined {
  const row = db
    .prepare(
      `SELECT record_json FROM plan_revisions WHERE plan_id = ?
       ORDER BY plan_revision DESC LIMIT 1`,
    )
    .get(planId) as { record_json: string } | undefined;
  return row ? (JSON.parse(row.record_json) as PlanRevision) : undefined;
}

function readTasksForPlan(db: Database.Database, planId: string): Task[] {
  const rows = db
    .prepare('SELECT record_json FROM tasks WHERE plan_id = ? ORDER BY task_id')
    .all(planId) as { record_json: string }[];
  return rows.map((r) => JSON.parse(r.record_json) as Task);
}

function readChildTasks(db: Database.Database, parentTaskId: string): Task[] {
  const rows = db
    .prepare('SELECT record_json FROM tasks WHERE parent_task_id = ? ORDER BY task_id')
    .all(parentTaskId) as { record_json: string }[];
  return rows.map((r) => JSON.parse(r.record_json) as Task);
}

function readEvidenceViews(db: Database.Database, taskId: string): EvidenceView[] {
  const rows = db
    .prepare(
      `SELECT evidence_id, criterion_alias, implementation_revision,
              bound_plan_revision, result
       FROM task_evidence WHERE task_id = ?`,
    )
    .all(taskId) as {
    evidence_id: string;
    criterion_alias: string;
    implementation_revision: string;
    bound_plan_revision: number;
    result: string;
  }[];
  return rows.map((r) => ({
    evidenceId: r.evidence_id,
    criterionAlias: r.criterion_alias,
    implementationRevision: r.implementation_revision,
    boundPlanRevision: r.bound_plan_revision,
    result: r.result === 'pass' ? 'pass' : 'fail',
  }));
}

// ─── Command envelope common fields ─────────────────────────────────────────

/** Common identity carried by every command (D-06.1). */
export interface CommandContext {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly scope: ScopeDescriptor;
  readonly now?: () => Date;
}

function requestDigest(payload: unknown): string {
  return computeDigest(payload);
}

function mapResult<T>(
  result: AuthorityMutationResult,
  value: T,
): TaskPlanOutcome<T> {
  if (result.kind === 'conflict') {
    return { ok: false, error: { code: result.error.code, message: result.error.message } };
  }
  if (result.kind === 'replayed') {
    return { ok: true, value, replayed: true };
  }
  return { ok: true, value, replayed: false };
}

// ─── Plan create / edit (NN-TASK-003) ───────────────────────────────────────

/** Input to {@link createPlanRevision}. */
export interface CreatePlanInput extends CommandContext {
  readonly planId: string;
  readonly goal: string;
  readonly taskIds: readonly string[];
  readonly edges: readonly PlanEdge[];
  readonly topology: PlanTopology;
  readonly validationGates: readonly ValidationGate[];
  readonly budgetId?: string;
  readonly createdBy: string;
  readonly riskDigest?: string;
  /** For an edit: the prior plan revision being superseded. */
  readonly supersedesRevision?: number;
}

/**
 * Create a plan revision (initial or an edit). DAG validation runs BEFORE the
 * commit: a cycle (without a `bounded-loop` topology) or a dangling edge is
 * rejected with `VALIDATION` and NO row is written (NN-TASK-003). An edit
 * allocates the next `planRevision` and marks the prior revision superseded, so
 * any approval or evidence bound to the prior revision becomes stale
 * automatically (exact-binding invalidation).
 */
export function createPlanRevision(
  db: Database.Database,
  input: CreatePlanInput,
): TaskPlanOutcome<PlanRevision> {
  if (!taskScopeComplete(input.scope)) {
    return fail('VALIDATION', 'plan scope must carry projectId and workspaceId');
  }

  const dag = validateDag(input.taskIds, input.edges, input.topology);
  if (!dag.ok) {
    const message =
      dag.reason === 'cycle'
        ? `plan graph contains a dependency cycle: ${(dag.cycle ?? []).join(' -> ')}`
        : `plan edge references an undeclared task`;
    return fail<PlanRevision>('VALIDATION', message, dag.reason === 'cycle' ? 'dependency-cycle' : undefined);
  }

  const prior = readLatestPlanRevision(db, input.planId);
  const planRevision = prior ? prior.planRevision + 1 : 1;
  const now = (input.now ?? (() => new Date()))().toISOString();
  const riskDigest = input.riskDigest ?? computeDigest({ planId: input.planId, taskIds: input.taskIds });

  const digest = computePlanDigest({
    planId: input.planId,
    planRevision,
    goal: input.goal,
    taskIds: input.taskIds,
    edges: input.edges,
    topology: input.topology,
    authoritySnapshots: [],
    ...(input.budgetId ? { budgetId: input.budgetId } : {}),
    riskDigest,
    validationGates: input.validationGates,
  });

  const record: PlanRevision = {
    schemaVersion: 1,
    planId: input.planId,
    planRevision,
    scope: input.scope,
    goal: input.goal,
    taskIds: [...input.taskIds],
    edges: input.edges.map((e) => ({ from: e.from, to: e.to })),
    topology: input.topology,
    authoritySnapshots: [],
    ...(input.budgetId ? { budgetId: input.budgetId } : {}),
    riskDigest,
    validationGates: input.validationGates.map((g) => ({ ...g })),
    createdBy: input.createdBy,
    createdAt: now,
    ...(prior ? { supersedesRevision: prior.planRevision } : {}),
    digest,
    redaction: 'internal',
  };

  const result = applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({ op: 'create-plan', digest }),
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      if (prior) {
        tx.prepare(
          'UPDATE plan_revisions SET superseded = 1 WHERE plan_id = ? AND plan_revision = ?',
        ).run(input.planId, prior.planRevision);
      }
      tx.prepare(
        `INSERT INTO plan_revisions
           (plan_id, plan_revision, digest, superseded, record_json, created_at)
         VALUES (?, ?, ?, 0, ?, ?)`,
      ).run(input.planId, planRevision, digest, serializeContract(record), now);
      return { resultRef: makeOpaqueId('plan', `${input.planId}${planRevision}`) };
    },
    events: [
      {
        eventType: prior ? 'plan.revised' : 'plan.created',
        aggregateType: 'plan',
        aggregateId: input.planId,
        payloadSchemaName: 'PlanRevision',
        payloadSchemaVersion: 1,
        payload: { planId: input.planId, planRevision, digest },
        redaction: 'internal',
      },
    ],
  });

  return mapResult(result, record);
}

// ─── Task upsert (NN-TASK-001) ──────────────────────────────────────────────

/** Input to {@link upsertTask}. */
export interface UpsertTaskInput extends CommandContext {
  readonly task: Task;
}

/**
 * Create or replace a task record. The task must belong to an existing plan
 * revision. This is the additive migration entry point too: a legacy task
 * imports by supplying `legacyProvenance` on the record (NN-COMPAT-006).
 */
export function upsertTask(
  db: Database.Database,
  input: UpsertTaskInput,
): TaskPlanOutcome<Task> {
  const task = input.task;
  if (!taskScopeComplete(task.scope)) {
    return fail('VALIDATION', 'task scope must carry projectId and workspaceId');
  }
  const plan = readPlanRevision(db, task.planId, task.planRevision);
  if (!plan) {
    return fail('CONFLICT', 'task references an unknown plan revision');
  }

  const result = applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({ op: 'upsert-task', task }),
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      tx.prepare(
        `INSERT INTO tasks
           (task_id, plan_id, plan_revision, project_id, parent_task_id, state, revision, record_json)
         VALUES (@taskId, @planId, @planRevision, @projectId, @parentTaskId, @state, @revision, @recordJson)
         ON CONFLICT(task_id) DO UPDATE SET
           plan_id = excluded.plan_id,
           plan_revision = excluded.plan_revision,
           project_id = excluded.project_id,
           parent_task_id = excluded.parent_task_id,
           state = excluded.state,
           revision = excluded.revision,
           record_json = excluded.record_json`,
      ).run({
        taskId: task.taskId,
        planId: task.planId,
        planRevision: task.planRevision,
        projectId: task.scope.projectId ?? null,
        parentTaskId: task.parentTaskId ?? null,
        state: task.state,
        revision: task.revision,
        recordJson: serializeContract(task),
      });
      return { resultRef: task.taskId };
    },
    events: [
      {
        eventType: 'task.upserted',
        aggregateType: 'task',
        aggregateId: task.taskId,
        payloadSchemaName: 'Task',
        payloadSchemaVersion: 1,
        payload: { taskId: task.taskId, state: task.state, planRevision: task.planRevision },
        redaction: 'internal',
      },
    ],
  });

  return mapResult(result, task);
}

// ─── State transition (NN-TASK-004) ─────────────────────────────────────────

function writeTaskState(
  tx: Database.Database,
  task: Task,
  nextState: TaskState,
  patch: Partial<Task>,
): Task {
  const updated: Task = {
    ...task,
    ...patch,
    state: nextState,
    revision: task.revision + 1,
  };
  tx.prepare(
    `UPDATE tasks SET state = ?, revision = ?, record_json = ? WHERE task_id = ?`,
  ).run(nextState, updated.revision, serializeContract(updated), task.taskId);
  return updated;
}

/** Input to {@link transitionTask}. */
export interface TransitionInput extends CommandContext {
  readonly taskId: string;
  readonly toState: TaskState;
  readonly patch?: Partial<Task>;
}

/**
 * Apply a task state transition, rejecting an illegal or post-terminal edge
 * with `CONFLICT` (NN-TASK-004, D-07.1). This is the general transition entry
 * point used by the higher-level operations; a direct move to `succeeded` is
 * NOT permitted here — {@link completeTask} owns the evidence gate.
 */
export function transitionTask(
  db: Database.Database,
  input: TransitionInput,
): TaskPlanOutcome<Task> {
  const task = readTask(db, input.taskId);
  if (!task) return fail('CONFLICT', 'unknown task');
  if (isTerminalTaskState(task.state)) {
    return fail('CONFLICT', `task is terminal (${task.state}); no transition allowed`);
  }
  if (input.toState === 'succeeded') {
    return fail('CONFLICT', 'use completeTask to reach succeeded (evidence gate)');
  }
  if (!isLegalTaskTransition(task.state, input.toState)) {
    return fail('CONFLICT', `illegal transition ${task.state} -> ${input.toState}`);
  }

  const result = applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({ op: 'transition', taskId: input.taskId, to: input.toState }),
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      writeTaskState(tx, task, input.toState, input.patch ?? {});
      return { resultRef: input.taskId };
    },
    events: [
      {
        eventType: 'task.transitioned',
        aggregateType: 'task',
        aggregateId: input.taskId,
        payloadSchemaName: 'Task',
        payloadSchemaVersion: 1,
        payload: { taskId: input.taskId, from: task.state, to: input.toState },
        redaction: 'internal',
      },
    ],
  });

  const updated = readTask(db, input.taskId) ?? task;
  return mapResult(result, updated);
}

// ─── Readiness recomputation (NN-TASK-002) ──────────────────────────────────

/** Input to {@link evaluateReadiness}. Environment/inputs come from callers. */
export interface ReadinessInput extends CommandContext {
  readonly taskId: string;
  /** Non-dependency readiness signals the caller has verified. */
  readonly signals: Omit<TaskReadiness, 'dependenciesSatisfied'>;
}

/**
 * Recompute a task's readiness and move it to `ready` or `blocked` accordingly
 * (NN-TASK-002). `dependenciesSatisfied` is computed here from the live states
 * of the task's declared dependencies — a dependency not yet `succeeded` keeps
 * the task un-ready. Templates supply the other signals but cannot bypass the
 * dependency check.
 */
export function evaluateReadiness(
  db: Database.Database,
  input: ReadinessInput,
): TaskPlanOutcome<Task> {
  const task = readTask(db, input.taskId);
  if (!task) return fail('CONFLICT', 'unknown task');
  if (isTerminalTaskState(task.state)) {
    return fail('CONFLICT', 'task is terminal');
  }

  const depsOk = dependenciesSatisfied(task.dependencies, (id) => readTask(db, id)?.state);
  const readiness: TaskReadiness = { ...input.signals, dependenciesSatisfied: depsOk };
  const ready = isReady(readiness);
  const nextState: TaskState = ready ? 'ready' : 'blocked';

  // From queued/ready/blocked we may move to ready or blocked. If the current
  // state is not one of those, only update the readiness snapshot.
  const movable = task.state === 'queued' || task.state === 'ready' || task.state === 'blocked';
  const targetState = movable ? nextState : task.state;

  const result = applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({ op: 'readiness', taskId: input.taskId, readiness }),
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      const updated: Task = {
        ...task,
        readiness,
        state: targetState,
        revision: task.revision + 1,
      };
      tx.prepare(
        `UPDATE tasks SET state = ?, revision = ?, record_json = ? WHERE task_id = ?`,
      ).run(targetState, updated.revision, serializeContract(updated), task.taskId);
      return { resultRef: input.taskId };
    },
    events: [
      {
        eventType: 'task.readiness-evaluated',
        aggregateType: 'task',
        aggregateId: input.taskId,
        payloadSchemaName: 'Task',
        payloadSchemaVersion: 1,
        payload: { taskId: input.taskId, ready, state: targetState },
        redaction: 'internal',
      },
    ],
  });

  return mapResult(result, readTask(db, input.taskId) ?? task);
}

// ─── Approval recording + exact binding (NN-APPROVAL-002) ───────────────────

/** Input to {@link recordApproval}. */
export interface RecordApprovalInput extends CommandContext {
  readonly taskId: string;
  readonly decision: ApprovalDecision;
}

/**
 * Record a typed approval decision against a task. The decision carries the
 * exact action digest and plan revision it authorizes; the authority stores
 * both so {@link isApprovalCurrent} can later confirm the binding matches the
 * task's CURRENT plan revision. Recording does not itself authorize — dispatch
 * re-checks the binding (NN-APPROVAL-002).
 */
export function recordApproval(
  db: Database.Database,
  input: RecordApprovalInput,
): TaskPlanOutcome<ApprovalDecision> {
  const task = readTask(db, input.taskId);
  if (!task) return fail('CONFLICT', 'unknown task');

  const result = applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({ op: 'approval', decisionId: input.decision.decisionId }),
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      tx.prepare(
        `INSERT INTO task_approvals
           (approval_id, task_id, bound_action_digest, bound_plan_revision, outcome, decision_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(approval_id) DO UPDATE SET
           bound_action_digest = excluded.bound_action_digest,
           bound_plan_revision = excluded.bound_plan_revision,
           outcome = excluded.outcome,
           decision_json = excluded.decision_json`,
      ).run(
        input.decision.decisionId,
        input.taskId,
        input.decision.boundActionDigest,
        input.decision.boundPlanRevision,
        input.decision.outcome,
        serializeContract(input.decision),
      );
      const updated: Task = {
        ...task,
        approvalIds: Array.from(new Set([...task.approvalIds, input.decision.decisionId])),
        revision: task.revision + 1,
      };
      tx.prepare(
        `UPDATE tasks SET revision = ?, record_json = ? WHERE task_id = ?`,
      ).run(updated.revision, serializeContract(updated), task.taskId);
      return { resultRef: input.decision.decisionId };
    },
  });

  return mapResult(result, input.decision);
}

/**
 * The exact-binding check (NN-APPROVAL-002, NN-TASK-003). Recompute the
 * approval digest for the task's CURRENT plan revision and required action, and
 * confirm a stored `approved` decision binds to exactly that digest and plan
 * revision. A plan edit bumps the revision, so a decision bound to the prior
 * revision no longer matches — the approval is stale and never authorizes.
 *
 * @param action the canonical action verb (e.g. `task.dispatch`).
 * @param actionArguments structured, key-order-independent arguments shown.
 * @param scopeKey stable scope digest the decision was shown for.
 * @param risk the risk tier shown to the user.
 * @param owner the owning authority/run id.
 * @param expiresAt the request expiry that was part of the bound identity.
 */
export function isApprovalCurrent(
  db: Database.Database,
  taskId: string,
  binding: {
    readonly action: string;
    readonly actionArguments: Record<string, unknown>;
    readonly scopeKey: string;
    readonly risk: ApprovalRisk;
    readonly owner: string;
    readonly expiresAt: string;
  },
): boolean {
  const task = readTask(db, taskId);
  if (!task) return false;
  const expectedDigest = computeApprovalDigest({
    action: binding.action,
    arguments: binding.actionArguments,
    scopeKey: binding.scopeKey,
    risk: binding.risk,
    owner: binding.owner,
    planRevision: task.planRevision,
    expiresAt: binding.expiresAt,
  });
  const rows = db
    .prepare(
      `SELECT bound_action_digest, bound_plan_revision, outcome
       FROM task_approvals WHERE task_id = ?`,
    )
    .all(taskId) as {
    bound_action_digest: string;
    bound_plan_revision: number;
    outcome: string;
  }[];
  return rows.some(
    (r) =>
      r.outcome === 'approved' &&
      r.bound_plan_revision === task.planRevision &&
      r.bound_action_digest === expectedDigest,
  );
}

// ─── Dispatch (NN-TASK-005, NN-WORKSPACE-002, NN-COMPAT-006) ────────────────

/** A committed dispatch record retained for correlation (NN-TASK-005). */
export interface DispatchRecord {
  readonly dispatchId: string;
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly projectId: string;
  readonly agentId?: string;
  readonly orchestrator: boolean;
  readonly sourceSurface: string;
  readonly sessionId?: string;
  readonly correlationId: string;
  readonly dispatchedAt: string;
}

/** Input to {@link dispatchTask}. */
export interface DispatchInput extends CommandContext {
  readonly taskId: string;
  /** The selected project from the dashboard selector (NN-WORKSPACE-002). */
  readonly projectId: string;
  /** The selected agent, or omit when routing to the orchestrator. */
  readonly agentId?: string;
  readonly orchestrator: boolean;
  readonly sourceSurface: string;
  readonly sessionId?: string;
  /**
   * Optional approval binding to verify at dispatch. When the task's risk
   * requires approval, dispatch is refused unless the binding is CURRENT for
   * the task's plan revision (NN-APPROVAL-002).
   */
  readonly approvalBinding?: {
    readonly action: string;
    readonly actionArguments: Record<string, unknown>;
    readonly scopeKey: string;
    readonly risk: ApprovalRisk;
    readonly owner: string;
    readonly expiresAt: string;
  };
}

/**
 * Dispatch a READY task to a project/agent or the orchestrator (NN-TASK-005).
 *
 * Guards, in order:
 *   1. the task exists and is in `ready` (only ready tasks dispatch, NN-TASK-002);
 *   2. its dependencies are all `succeeded` (re-checked live, NN-TASK-002);
 *   3. if an approval binding is supplied it MUST be current for the task's plan
 *      revision — a stale approval (bound to a superseded revision) is refused
 *      with `FORBIDDEN` (NN-APPROVAL-002).
 *
 * The dispatch retains the selected project, agent/orchestrator, source
 * surface, session, and correlation. Duplicate clicks are IDEMPOTENT: the same
 * idempotency key replays the prior receipt and the unique dispatch row is
 * inserted once, so no second dispatch occurs (NN-TASK-005). On success the
 * task moves to `in-progress` and its attempt count increments.
 */
export function dispatchTask(
  db: Database.Database,
  input: DispatchInput,
): TaskPlanOutcome<DispatchRecord> {
  const task = readTask(db, input.taskId);
  if (!task) return fail('CONFLICT', 'unknown task');

  // Idempotent clicks (NN-TASK-005): a prior committed dispatch under the same
  // idempotency key replays the prior receipt with NO second dispatch — even
  // though the task has since moved to `in-progress`. The state guards below
  // only apply to a genuinely NEW dispatch. A reused key with a divergent
  // request digest is a CONFLICT (reconciled inside applyAuthorityMutation).
  const priorReceipt = readCommandReceipt(db, input.idempotencyKey);
  if (priorReceipt) {
    const priorRow = db
      .prepare('SELECT dispatch_id FROM task_dispatches WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as { dispatch_id: string } | undefined;
    if (priorRow) {
      const row = db
        .prepare(
          `SELECT dispatch_id, task_id, idempotency_key, project_id, agent_id, orchestrator,
                  source_surface, session_id, correlation_id, dispatched_at
           FROM task_dispatches WHERE idempotency_key = ?`,
        )
        .get(input.idempotencyKey) as {
        dispatch_id: string;
        task_id: string;
        idempotency_key: string;
        project_id: string;
        agent_id: string | null;
        orchestrator: number;
        source_surface: string;
        session_id: string | null;
        correlation_id: string;
        dispatched_at: string;
      };
      const replayed: DispatchRecord = {
        dispatchId: row.dispatch_id,
        taskId: row.task_id,
        idempotencyKey: row.idempotency_key,
        projectId: row.project_id,
        ...(row.agent_id ? { agentId: row.agent_id } : {}),
        orchestrator: row.orchestrator === 1,
        sourceSurface: row.source_surface,
        ...(row.session_id ? { sessionId: row.session_id } : {}),
        correlationId: row.correlation_id,
        dispatchedAt: row.dispatched_at,
      };
      // Route through applyAuthorityMutation so a divergent digest still
      // conflicts; a matching digest returns replayed with no effect.
      const replayResult = applyAuthorityMutation(db, {
        authority: AUTHORITY_ID,
        commandId: input.commandId,
        idempotencyKey: input.idempotencyKey,
        requestDigest: requestDigest({
          op: 'dispatch',
          taskId: input.taskId,
          projectId: input.projectId,
          agentId: input.agentId ?? null,
          orchestrator: input.orchestrator,
        }),
        correlationId: input.correlationId,
        scope: input.scope,
        ...(input.now ? { now: input.now } : {}),
        mutate: () => ({}),
      });
      return mapResult(replayResult, replayed);
    }
  }

  if (isTerminalTaskState(task.state)) {
    return fail('CONFLICT', 'task is terminal; cannot dispatch');
  }
  if (task.state !== 'ready') {
    return fail<DispatchRecord>(
      'CONFLICT',
      `only ready tasks dispatch; task is ${task.state}`,
      task.state === 'blocked' ? 'missing-dependency' : undefined,
    );
  }
  const depsOk = dependenciesSatisfied(task.dependencies, (id) => readTask(db, id)?.state);
  if (!depsOk) {
    return fail('CONFLICT', 'dependencies not all succeeded', 'missing-dependency');
  }
  if (input.approvalBinding && !isApprovalCurrent(db, input.taskId, input.approvalBinding)) {
    return fail('FORBIDDEN', 'no current approval binds this action to the plan revision', 'stale-approval');
  }

  const now = (input.now ?? (() => new Date()))().toISOString();
  const dispatchId = makeOpaqueId('disp', input.idempotencyKey);
  const dispatch: DispatchRecord = {
    dispatchId,
    taskId: input.taskId,
    idempotencyKey: input.idempotencyKey,
    projectId: input.projectId,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    orchestrator: input.orchestrator,
    sourceSurface: input.sourceSurface,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    correlationId: input.correlationId,
    dispatchedAt: now,
  };

  const result = applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({
      op: 'dispatch',
      taskId: input.taskId,
      projectId: input.projectId,
      agentId: input.agentId ?? null,
      orchestrator: input.orchestrator,
    }),
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      tx.prepare(
        `INSERT INTO task_dispatches
           (dispatch_id, task_id, idempotency_key, project_id, agent_id, orchestrator,
            source_surface, session_id, correlation_id, dispatched_at)
         VALUES (@dispatchId, @taskId, @idempotencyKey, @projectId, @agentId, @orchestrator,
            @sourceSurface, @sessionId, @correlationId, @dispatchedAt)`,
      ).run({
        dispatchId,
        taskId: input.taskId,
        idempotencyKey: input.idempotencyKey,
        projectId: input.projectId,
        agentId: input.agentId ?? null,
        orchestrator: input.orchestrator ? 1 : 0,
        sourceSurface: input.sourceSurface,
        sessionId: input.sessionId ?? null,
        correlationId: input.correlationId,
        dispatchedAt: now,
      });
      writeTaskState(tx, task, 'in-progress', { attempts: task.attempts + 1 });
      return { resultRef: dispatchId };
    },
    events: [
      {
        eventType: 'task.dispatched',
        aggregateType: 'task',
        aggregateId: input.taskId,
        payloadSchemaName: 'Task',
        payloadSchemaVersion: 1,
        payload: { taskId: input.taskId, projectId: input.projectId, orchestrator: input.orchestrator },
        redaction: 'internal',
      },
    ],
  });

  return mapResult(result, dispatch);
}

/** Count committed dispatch rows for a task (idempotency observability). */
export function countDispatches(db: Database.Database, taskId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM task_dispatches WHERE task_id = ?')
    .get(taskId) as { n: number };
  return row.n;
}

// ─── Evidence recording + evidence-gated completion (NN-TASK-006) ───────────

/** Input to {@link recordEvidence}. */
export interface RecordEvidenceInput extends CommandContext {
  readonly evidence: EvidenceView & { readonly taskId: string };
}

/**
 * Record an evidence record bound to a task, a criterion, a plan revision, and
 * an implementation revision. Evidence is bound to the plan revision so a later
 * plan edit (new revision) leaves prior evidence bound to the OLD revision —
 * which {@link completeTask} treats as stale (NN-TASK-006).
 */
export function recordEvidence(
  db: Database.Database,
  input: RecordEvidenceInput,
): TaskPlanOutcome<EvidenceView> {
  const task = readTask(db, input.evidence.taskId);
  if (!task) return fail('CONFLICT', 'unknown task');
  const ev = input.evidence;

  const result = applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({ op: 'evidence', evidenceId: ev.evidenceId }),
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      tx.prepare(
        `INSERT INTO task_evidence
           (evidence_id, task_id, criterion_alias, implementation_revision, bound_plan_revision, result)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(evidence_id) DO UPDATE SET
           criterion_alias = excluded.criterion_alias,
           implementation_revision = excluded.implementation_revision,
           bound_plan_revision = excluded.bound_plan_revision,
           result = excluded.result`,
      ).run(
        ev.evidenceId,
        ev.taskId,
        ev.criterionAlias,
        ev.implementationRevision,
        ev.boundPlanRevision,
        ev.result,
      );
      const updated: Task = {
        ...task,
        evidenceIds: Array.from(new Set([...task.evidenceIds, ev.evidenceId])),
        revision: task.revision + 1,
      };
      tx.prepare(
        `UPDATE tasks SET revision = ?, record_json = ? WHERE task_id = ?`,
      ).run(updated.revision, serializeContract(updated), task.taskId);
      return { resultRef: ev.evidenceId };
    },
  });

  return mapResult(result, {
    evidenceId: ev.evidenceId,
    criterionAlias: ev.criterionAlias,
    implementationRevision: ev.implementationRevision,
    boundPlanRevision: ev.boundPlanRevision,
    result: ev.result,
  });
}

/** Non-storage signals the completion gate needs from the caller. */
export interface CompletionSignals {
  readonly implementationRevision: string;
  readonly cancellationIncomplete: boolean;
  readonly toolFailed: boolean;
  readonly missingEnvironment: boolean;
  /** Optional approval binding; a stale binding blocks success. */
  readonly approvalBinding?: {
    readonly action: string;
    readonly actionArguments: Record<string, unknown>;
    readonly scopeKey: string;
    readonly risk: ApprovalRisk;
    readonly owner: string;
    readonly expiresAt: string;
  };
}

/** Input to {@link completeTask}. */
export interface CompleteTaskInput extends CommandContext {
  readonly taskId: string;
  readonly signals: CompletionSignals;
}

/**
 * Attempt to complete a task as `succeeded` through the evidence gate
 * (NN-TASK-006, NN-INV-003). The task must be in `review` (the only legal
 * predecessor of `succeeded`). The gate evaluates:
 *
 *   - prohibited-outcome classes (cycle, stale approval, missing
 *     dependency/environment, failed tool, incomplete cancellation) — any one
 *     blocks success and the task is moved to `failed` with the named class;
 *   - same-plan-revision, same-implementation-revision passing evidence for
 *     every acceptance criterion and every required gate.
 *
 * When the gate passes the task transitions to `succeeded` with a terminal
 * result carrying NO failure class; otherwise it transitions to `failed` with
 * the exact failure class, so a failed tool or incomplete cancellation can
 * never be laundered into success prose.
 */
export function completeTask(
  db: Database.Database,
  input: CompleteTaskInput,
): TaskPlanOutcome<Task> {
  const task = readTask(db, input.taskId);
  if (!task) return fail('CONFLICT', 'unknown task');
  if (isTerminalTaskState(task.state)) {
    return fail('CONFLICT', 'task is terminal');
  }
  if (task.state !== 'review') {
    return fail('CONFLICT', `completeTask requires review state; task is ${task.state}`);
  }

  const plan = readPlanRevision(db, task.planId, task.planRevision);
  const dag = plan ? validateDag(plan.taskIds, plan.edges, plan.topology) : { ok: true as const };
  const dependencyCycle = dag.ok === false && dag.reason === 'cycle';
  const missingDependency = !dependenciesSatisfied(
    task.dependencies,
    (id) => readTask(db, id)?.state,
  );
  const approvalStale = input.signals.approvalBinding
    ? !isApprovalCurrent(db, input.taskId, input.signals.approvalBinding)
    : false;

  const requiredGateIds = (plan?.validationGates ?? [])
    .filter((g) => g.required)
    .map((g) => g.gateId);

  const decision = evaluateEvidenceCompletion({
    criterionAliases: task.criterionAliases,
    planRevision: task.planRevision,
    implementationRevision: input.signals.implementationRevision,
    evidence: readEvidenceViews(db, input.taskId),
    requiredGateIds,
    cancellationIncomplete: input.signals.cancellationIncomplete,
    toolFailed: input.signals.toolFailed,
    approvalStale,
    dependencyCycle,
    missingDependency,
    missingEnvironment: input.signals.missingEnvironment,
  });

  const now = (input.now ?? (() => new Date()))().toISOString();
  const nextState: TaskState = decision.canSucceed ? 'succeeded' : 'failed';

  const result = applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({
      op: 'complete',
      taskId: input.taskId,
      implementationRevision: input.signals.implementationRevision,
    }),
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      writeTaskState(tx, task, nextState, {
        terminalResult: {
          state: nextState,
          ...(decision.failureClass ? { failureClass: decision.failureClass } : {}),
          summary: decision.reason,
          decidedAt: now,
        },
      });
      return { resultRef: input.taskId };
    },
    events: [
      {
        eventType: decision.canSucceed ? 'task.succeeded' : 'task.failed',
        aggregateType: 'task',
        aggregateId: input.taskId,
        payloadSchemaName: 'Task',
        payloadSchemaVersion: 1,
        payload: {
          taskId: input.taskId,
          state: nextState,
          failureClass: decision.failureClass ?? null,
        },
        redaction: 'internal',
      },
    ],
  });

  return mapResult(result, readTask(db, input.taskId) ?? task);
}

// ─── Boomerang aggregation (NN-TASK-008) ────────────────────────────────────

/** The deterministic aggregate of a parent task's children. */
export interface BoomerangAggregate {
  readonly parentTaskId: string;
  readonly childCount: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly pending: number;
  /** Child task ids that failed, preserved independently (NN-TASK-008). */
  readonly failedChildren: readonly string[];
  /** The aggregate outcome the parent may adopt. */
  readonly aggregateState: TaskState;
  /** Collected artifact ids from all children, order-stable. */
  readonly artifacts: readonly string[];
}

/**
 * Deterministically aggregate a parent's children (NN-TASK-008). Rules:
 *
 *   - the parent's aggregate is `succeeded` ONLY when every child is
 *     `succeeded` — one unfinished or failed child prevents parent success;
 *   - if any child is a terminal failure (`failed`/`forced-terminated`) and no
 *     child is still pending, the aggregate is `failed` with the failing child
 *     ids preserved independently;
 *   - otherwise the aggregate is `in-progress` (work remains).
 *
 * Aggregation is a pure read of the children's committed states; it never
 * mutates. {@link applyBoomerang} commits the derived parent state.
 */
export function aggregateChildren(
  db: Database.Database,
  parentTaskId: string,
): BoomerangAggregate {
  const children = readChildTasks(db, parentTaskId);
  let succeeded = 0;
  let failed = 0;
  let pending = 0;
  const failedChildren: string[] = [];
  const artifacts: string[] = [];

  for (const child of children) {
    for (const art of child.artifacts) artifacts.push(art);
    if (child.state === 'succeeded') {
      succeeded += 1;
    } else if (child.state === 'failed' || child.state === 'forced-terminated') {
      failed += 1;
      failedChildren.push(child.taskId);
    } else if (child.state === 'cancelled') {
      // A cancelled child is a terminal non-success; it prevents parent success
      // but is not a hard failure for retry purposes.
      failed += 1;
      failedChildren.push(child.taskId);
    } else {
      pending += 1;
    }
  }

  let aggregateState: TaskState;
  if (children.length > 0 && succeeded === children.length) {
    aggregateState = 'succeeded';
  } else if (pending === 0 && failed > 0) {
    aggregateState = 'failed';
  } else {
    aggregateState = 'in-progress';
  }

  return {
    parentTaskId,
    childCount: children.length,
    succeeded,
    failed,
    pending,
    failedChildren: failedChildren.sort((a, b) => a.localeCompare(b)),
    aggregateState,
    artifacts,
  };
}

// ─── Kanban / taskbar projections (NN-TASK-004) ─────────────────────────────

/** A taskbar row: the projection surface for a single task (NN-TASK-004). */
export interface TaskbarRow {
  readonly taskId: string;
  readonly state: TaskState;
  readonly owner: string;
  readonly attempts: number;
  readonly risk: string;
  readonly blockers: readonly string[];
  /** The next action a human can take from this state. */
  readonly nextAction: string;
  readonly failureClass?: TaskFailureClass;
}

/** A Kanban board: tasks grouped by canonical state (NN-TASK-004). */
export interface KanbanBoard {
  readonly columns: Readonly<Record<TaskState, readonly string[]>>;
}

function nextActionFor(state: TaskState): string {
  switch (state) {
    case 'queued':
      return 'evaluate-readiness';
    case 'ready':
      return 'dispatch';
    case 'in-progress':
      return 'await-result';
    case 'waiting-approval':
      return 'decide-approval';
    case 'blocked':
      return 'resolve-blocker';
    case 'review':
      return 'review-evidence';
    default:
      return 'none';
  }
}

/**
 * Project the taskbar view for a plan (NN-TASK-004). This is a READ projection
 * derived from committed task rows; it never owns or mutates state. Blockers
 * are the unsatisfied dependencies and the terminal failure class, if any.
 */
export function projectTaskbar(db: Database.Database, planId: string): TaskbarRow[] {
  const tasks = readTasksForPlan(db, planId);
  return tasks.map((task) => {
    const blockers = task.dependencies.filter(
      (dep) => readTask(db, dep)?.state !== 'succeeded',
    );
    return {
      taskId: task.taskId,
      state: task.state,
      owner: task.owner,
      attempts: task.attempts,
      risk: task.risk,
      blockers,
      nextAction: nextActionFor(task.state),
      ...(task.terminalResult?.failureClass
        ? { failureClass: task.terminalResult.failureClass }
        : {}),
    };
  });
}

/** Project the Kanban board for a plan: task ids grouped by state. */
export function projectKanban(db: Database.Database, planId: string): KanbanBoard {
  const columns: Record<TaskState, string[]> = {
    queued: [],
    ready: [],
    'in-progress': [],
    'waiting-approval': [],
    blocked: [],
    review: [],
    succeeded: [],
    failed: [],
    cancelled: [],
    'forced-terminated': [],
  };
  for (const task of readTasksForPlan(db, planId)) {
    columns[task.state].push(task.taskId);
  }
  for (const key of Object.keys(columns) as TaskState[]) {
    columns[key].sort((a, b) => a.localeCompare(b));
  }
  return { columns };
}

// ─── Schedules (NN-TASK-007) ────────────────────────────────────────────────

/** A durable, project-scoped schedule (NN-TASK-007). */
export interface TaskSchedule {
  readonly scheduleId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly cron: string;
  readonly risk: ApprovalRisk;
  readonly state: 'active' | 'paused';
  /** The authority snapshot pinned at creation; a fire cannot inherit stale. */
  readonly authoritySnapshot: { readonly authority: string; readonly revision: number };
}

/** Input to {@link createSchedule}. */
export interface CreateScheduleInput extends CommandContext {
  readonly schedule: TaskSchedule;
}

/**
 * Create a durable, project-scoped schedule (NN-TASK-007). A high-risk schedule
 * must carry an authority snapshot; when it fires (see {@link scheduleCanFire})
 * an unattended high-risk action cannot inherit stale authority — it routes to
 * approval instead.
 */
export function createSchedule(
  db: Database.Database,
  input: CreateScheduleInput,
): TaskPlanOutcome<TaskSchedule> {
  const s = input.schedule;
  if (!s.projectId) return fail('VALIDATION', 'schedule must be project-scoped');

  const result = applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({ op: 'schedule', scheduleId: s.scheduleId }),
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      tx.prepare(
        `INSERT INTO task_schedules
           (schedule_id, task_id, project_id, cron, risk, state, authority_snapshot_json, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(schedule_id) DO UPDATE SET
           cron = excluded.cron, risk = excluded.risk, state = excluded.state,
           authority_snapshot_json = excluded.authority_snapshot_json,
           record_json = excluded.record_json`,
      ).run(
        s.scheduleId,
        s.taskId,
        s.projectId,
        s.cron,
        s.risk,
        s.state,
        serializeContract(s.authoritySnapshot),
        serializeContract(s),
      );
      return { resultRef: s.scheduleId };
    },
  });

  return mapResult(result, s);
}

/** Pause or resume a schedule (NN-TASK-007). */
export function setScheduleState(
  db: Database.Database,
  input: CommandContext & { readonly scheduleId: string; readonly state: 'active' | 'paused' },
): TaskPlanOutcome<TaskSchedule> {
  const row = db
    .prepare('SELECT record_json FROM task_schedules WHERE schedule_id = ?')
    .get(input.scheduleId) as { record_json: string } | undefined;
  if (!row) return fail('CONFLICT', 'unknown schedule');
  const schedule = JSON.parse(row.record_json) as TaskSchedule;
  const updated: TaskSchedule = { ...schedule, state: input.state };

  const result = applyAuthorityMutation(db, {
    authority: AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({ op: 'schedule-state', scheduleId: input.scheduleId, state: input.state }),
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      tx.prepare(
        'UPDATE task_schedules SET state = ?, record_json = ? WHERE schedule_id = ?',
      ).run(input.state, serializeContract(updated), input.scheduleId);
      return { resultRef: input.scheduleId };
    },
  });

  return mapResult(result, updated);
}

/**
 * Decide whether a schedule may fire an UNATTENDED action directly, or must
 * route to approval (NN-TASK-007). A paused schedule never fires. A high-risk
 * schedule NEVER fires unattended: it always routes to approval so it cannot
 * inherit stale authority. A low/medium schedule fires only when its pinned
 * authority snapshot still matches the current authority revision.
 */
export function scheduleCanFire(
  schedule: TaskSchedule,
  currentAuthorityRevision: number,
): { readonly fire: boolean; readonly routeToApproval: boolean; readonly reason: string } {
  if (schedule.state !== 'active') {
    return { fire: false, routeToApproval: false, reason: 'schedule is paused' };
  }
  if (schedule.risk === 'high') {
    return { fire: false, routeToApproval: true, reason: 'high-risk unattended action routes to approval' };
  }
  if (schedule.authoritySnapshot.revision !== currentAuthorityRevision) {
    return {
      fire: false,
      routeToApproval: true,
      reason: 'authority revision changed; cannot inherit stale authority',
    };
  }
  return { fire: true, routeToApproval: false, reason: 'authority current; may fire' };
}

// re-export scope key helper for callers building approval bindings.
export { computeScopeKeyForContract as computeScopeKey };
