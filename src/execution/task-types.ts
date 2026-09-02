/**
 * Task / Plan contracts — `Task@1` and `PlanRevision@1` schemas, the canonical
 * task state machine, readiness inputs, and the evidence-completion gate
 * (FUT-PKG-06-EXECUTION/T-003).
 *
 * D-04 names `TaskPlanService` as the sole write authority for the Task/Plan
 * concept with canonical identity `taskId` / `planId + planRevision`; Kanban,
 * taskbar, and scheduler are read-model projections only. D-07 pins the two
 * versioned records:
 *
 *   - {@link Task} — `Task@1`: stable id/version, project/workspace scope,
 *     source requirement/criterion links, description, inputs, dependencies,
 *     owner, agent/skill/tool needs, risk, readiness, state, artifacts,
 *     evidence ids, approval ids, attempts, budget, and terminal result. The
 *     `succeeded` state REQUIRES all applicable criterion evidence at the same
 *     implementation revision (NN-TASK-001/006).
 *   - {@link PlanRevision} — `PlanRevision@1`: an IMMUTABLE plan revision with
 *     goal, task ids, edges, topology, authority snapshots, budget, risk
 *     digest, validation gates, and a `digest`. Approval binds the exact
 *     digest/revision; an edit creates a NEW revision and invalidates a stale
 *     approval and stale evidence (NN-TASK-003, D-07 `PlanRevision@1`).
 *
 * This module is deliberately additive over
 * {@link ../shared/contract-primitives} and reuses its canonical serializer,
 * `computeDigest`, opaque IDs, revisions, and the redaction ladder so that the
 * plan digest and evidence binding share the same key-order-independent,
 * structurally-stable definition as every other contract digest (D-07). It
 * reuses {@link ../approval/approval-types} `computeApprovalDigest` for exact
 * approval binding — a stale approval never authorizes dispatch
 * (NN-APPROVAL-002).
 *
 * Design anchors: D-04 (authority ownership), D-07 (`Task@1` / `PlanRevision@1`),
 * D-13 (parallel orchestration + boomerang aggregation), D-22 (verification),
 * D-26 (traceability).
 * Requirements: NN-TASK-001–009, NN-WORKSPACE-002, NN-OPS-001, NN-COMPAT-006.
 */

import { z } from 'zod';

import {
  CONTRACT_WRITE_VERSION,
  DigestSchema,
  OpaqueIdSchema,
  RevisionSchema,
  TimestampSchema,
  computeDigest,
  ScopeDescriptorSchema,
  type ScopeDescriptor,
} from '../shared/contract-primitives';

// ─── Canonical task state ladder (NN-TASK-004) ──────────────────────────────

/**
 * Canonical task states (NN-TASK-004). Kanban/taskbar views are projections of
 * these states, never independent owners. The terminal states are
 * `succeeded`, `failed`, `cancelled`, and `forced-terminated`; the rest are
 * transient.
 *
 *   - `queued`            — created, not yet evaluated for readiness.
 *   - `ready`             — all readiness inputs satisfied; dispatchable.
 *   - `in-progress`       — dispatched to a project/agent; work executing.
 *   - `waiting-approval`  — blocked on a typed approval decision.
 *   - `blocked`           — a dependency, environment, or gate is missing.
 *   - `review`            — awaiting evidence/gate review before success.
 *   - `succeeded`         — TERMINAL. Requires same-revision evidence for every
 *     applicable acceptance criterion and passing gates (NN-TASK-006).
 *   - `failed`            — TERMINAL. A failed tool or missing gate lands here,
 *     never in `succeeded` (NN-TASK-006).
 *   - `cancelled`         — TERMINAL. A converged cooperative cancellation.
 *   - `forced-terminated` — TERMINAL. A forced stop with named survivors.
 */
export const TASK_STATES = Object.freeze([
  'queued',
  'ready',
  'in-progress',
  'waiting-approval',
  'blocked',
  'review',
  'succeeded',
  'failed',
  'cancelled',
  'forced-terminated',
] as const);
export type TaskState = (typeof TASK_STATES)[number];
export const TaskStateSchema = z.enum(TASK_STATES);

/** The terminal task states. A terminal state is immutable (D-07.1). */
export const TERMINAL_TASK_STATES: readonly TaskState[] = Object.freeze([
  'succeeded',
  'failed',
  'cancelled',
  'forced-terminated',
]);

/** Whether a task state is terminal. */
export function isTerminalTaskState(state: TaskState): boolean {
  return (TERMINAL_TASK_STATES as readonly string[]).includes(state);
}

/**
 * The legal task state transitions (NN-TASK-004, D-07.1 "durable state machines
 * reject unknown transitions with CONFLICT"). A terminal state has no outgoing
 * transition. `succeeded` is reachable ONLY from `review` and never directly
 * from a failure/blocked path — the evidence gate guards that edge.
 */
const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> =
  Object.freeze({
    queued: ['ready', 'blocked', 'cancelled', 'forced-terminated'],
    ready: ['in-progress', 'blocked', 'cancelled', 'forced-terminated'],
    'in-progress': [
      'waiting-approval',
      'blocked',
      'review',
      'failed',
      'cancelled',
      'forced-terminated',
    ],
    'waiting-approval': [
      'in-progress',
      'blocked',
      'failed',
      'cancelled',
      'forced-terminated',
    ],
    blocked: ['ready', 'queued', 'cancelled', 'forced-terminated', 'failed'],
    review: ['succeeded', 'failed', 'blocked', 'cancelled', 'forced-terminated'],
    succeeded: [],
    failed: [],
    cancelled: [],
    'forced-terminated': [],
  });

/** Whether `from -> to` is a legal task transition (NN-TASK-004). */
export function isLegalTaskTransition(from: TaskState, to: TaskState): boolean {
  if (from === to) return false;
  return (TASK_TRANSITIONS[from] as readonly string[]).includes(to);
}

// ─── Failure classes that can NEVER become success (NN-TASK-006) ────────────

/**
 * The prohibited-outcome classes that can NEVER be represented as a successful
 * task (NN-TASK-006, NN-INV-003). Each is a reason a task is blocked/failed and
 * a reason {@link canReachSuccess} returns `false`. A failed tool or incomplete
 * cancellation cannot be represented as successful prose.
 */
export const TASK_FAILURE_CLASSES = Object.freeze([
  'dependency-cycle',
  'stale-approval',
  'missing-dependency',
  'missing-environment',
  'missing-gate',
  'failed-tool',
  'incomplete-cancellation',
  'missing-evidence',
  'stale-evidence',
] as const);
export type TaskFailureClass = (typeof TASK_FAILURE_CLASSES)[number];
export const TaskFailureClassSchema = z.enum(TASK_FAILURE_CLASSES);

// ─── Readiness inputs (NN-TASK-002) ─────────────────────────────────────────

/**
 * The readiness inputs a task must satisfy before it becomes dispatchable
 * (NN-TASK-002). Templates prefill these but never bypass them. Every flag
 * defaults to a conservative value; a missing input keeps the task un-ready.
 */
export const TaskReadinessSchema = z.strictObject({
  /** All required inputs are present. */
  inputsPresent: z.boolean(),
  /** Every declared dependency has reached `succeeded`. */
  dependenciesSatisfied: z.boolean(),
  /** The authority revisions the task pins are current (not stale). */
  authorityRevisionsCurrent: z.boolean(),
  /** The execution environment (worktree, tools, sandbox) is available. */
  environmentReady: z.boolean(),
  /** The required permissions/approval are granted for the exact action. */
  permissionsGranted: z.boolean(),
  /** Acceptance criteria are present and linked. */
  acceptanceCriteriaPresent: z.boolean(),
  /** A validation plan (gates) exists. */
  validationPlanPresent: z.boolean(),
});
export type TaskReadiness = z.infer<typeof TaskReadinessSchema>;

/** A fully-unready readiness value (safe default). */
export const UNREADY: TaskReadiness = Object.freeze({
  inputsPresent: false,
  dependenciesSatisfied: false,
  authorityRevisionsCurrent: false,
  environmentReady: false,
  permissionsGranted: false,
  acceptanceCriteriaPresent: false,
  validationPlanPresent: false,
});

/**
 * Whether every readiness input is satisfied (NN-TASK-002). A task becomes
 * dispatchable ONLY when this holds AND its dependencies are satisfied AND its
 * approval binding is current.
 */
export function isReady(readiness: TaskReadiness): boolean {
  return (
    readiness.inputsPresent &&
    readiness.dependenciesSatisfied &&
    readiness.authorityRevisionsCurrent &&
    readiness.environmentReady &&
    readiness.permissionsGranted &&
    readiness.acceptanceCriteriaPresent &&
    readiness.validationPlanPresent
  );
}

/** Report which readiness inputs are missing (empty means ready). */
export function missingReadiness(
  readiness: TaskReadiness,
): (keyof TaskReadiness)[] {
  return (Object.keys(readiness) as (keyof TaskReadiness)[]).filter(
    (key) => readiness[key] !== true,
  );
}

// ─── Task@1 (NN-TASK-001) ───────────────────────────────────────────────────

/** The risk tier of a task. High-risk work routes to approval (NN-TASK-007). */
export const TASK_RISKS = Object.freeze(['low', 'medium', 'high'] as const);
export type TaskRisk = (typeof TASK_RISKS)[number];
export const TaskRiskSchema = z.enum(TASK_RISKS);

/**
 * The terminal result of a task (NN-TASK-001). A `succeeded` result MUST carry
 * the failure class `undefined`; any other terminal state names the class that
 * prevented success so the outcome can never be laundered into success prose.
 */
export const TaskTerminalResultSchema = z.strictObject({
  state: z.enum(['succeeded', 'failed', 'cancelled', 'forced-terminated']),
  failureClass: TaskFailureClassSchema.optional(),
  /** A safe, secret-free summary of the outcome. */
  summary: z.string().min(1).max(2048),
  decidedAt: TimestampSchema,
});
export type TaskTerminalResult = z.infer<typeof TaskTerminalResultSchema>;

/**
 * `Task@1` (NN-TASK-001, D-07). `TaskPlanService` owns the state machine.
 * Dependency cycles are invalid (enforced by {@link ../execution/dag-validation}).
 * `succeeded` requires all applicable criterion evidence at the same
 * implementation revision.
 */
export const TaskSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_WRITE_VERSION),
  taskId: OpaqueIdSchema,
  /** Monotonic revision of THIS task record. */
  revision: RevisionSchema,
  scope: ScopeDescriptorSchema,
  /** The plan revision this task belongs to (evidence binds to it). */
  planId: OpaqueIdSchema,
  planRevision: RevisionSchema,
  /** Canonical requirement links (NN-*), for bidirectional traceability. */
  requirementLinks: z.array(z.string().min(1).max(64)),
  /** Criterion aliases (NN-*.ACnn) the task must satisfy with evidence. */
  criterionAliases: z.array(z.string().min(1).max(96)),
  description: z.string().min(1).max(4096),
  inputs: z.array(OpaqueIdSchema),
  /** Task ids this task depends on; each must be `succeeded` for readiness. */
  dependencies: z.array(OpaqueIdSchema),
  owner: OpaqueIdSchema,
  agentNeeds: z.array(z.string().min(1).max(128)),
  skillNeeds: z.array(z.string().min(1).max(128)),
  toolNeeds: z.array(z.string().min(1).max(128)),
  risk: TaskRiskSchema,
  readiness: TaskReadinessSchema,
  state: TaskStateSchema,
  artifacts: z.array(OpaqueIdSchema),
  evidenceIds: z.array(OpaqueIdSchema),
  approvalIds: z.array(OpaqueIdSchema),
  attempts: z.number().int().nonnegative().finite(),
  budgetId: OpaqueIdSchema.optional(),
  /** For boomerang aggregation: the parent task id, if this is a child. */
  parentTaskId: OpaqueIdSchema.optional(),
  terminalResult: TaskTerminalResultSchema.optional(),
  /** Provenance for a legacy import (NN-COMPAT-006 additive migration). */
  legacyProvenance: z.string().max(512).optional(),
  redaction: z.enum(['public', 'internal', 'sensitive', 'secret']),
});
export type Task = z.infer<typeof TaskSchema>;

// ─── PlanRevision@1 (NN-TASK-003) ───────────────────────────────────────────

/** A dependency edge in the plan graph (`from` runs before `to`). */
export const PlanEdgeSchema = z.strictObject({
  from: OpaqueIdSchema,
  to: OpaqueIdSchema,
});
export type PlanEdge = z.infer<typeof PlanEdgeSchema>;

/**
 * The plan topology. `acyclic` is the default; `bounded-loop` explicitly
 * declares a bounded loop (D-07 `PlanRevision@1`: "acyclic unless the selected
 * topology explicitly defines a bounded loop"). A cycle without an explicit
 * bounded-loop topology is invalid.
 */
export const PLAN_TOPOLOGIES = Object.freeze([
  'acyclic',
  'bounded-loop',
] as const);
export type PlanTopology = (typeof PLAN_TOPOLOGIES)[number];
export const PlanTopologySchema = z.enum(PLAN_TOPOLOGIES);

/** A validation gate the plan declares (must pass before task success). */
export const ValidationGateSchema = z.strictObject({
  gateId: z.string().min(1).max(128),
  /** The gate kind (e.g. `build`, `test`, `lint`, `review`). */
  kind: z.string().min(1).max(64),
  /** Whether the gate is required for success. */
  required: z.boolean(),
});
export type ValidationGate = z.infer<typeof ValidationGateSchema>;

/** An authority-revision snapshot the plan pins (stale => invalid readiness). */
export const AuthoritySnapshotSchema = z.strictObject({
  authority: OpaqueIdSchema,
  revision: RevisionSchema,
});
export type AuthoritySnapshot = z.infer<typeof AuthoritySnapshotSchema>;

/**
 * `PlanRevision@1` (NN-TASK-003, D-07). Each revision is IMMUTABLE. Approval
 * binds its exact digest/revision; edits create a new revision and invalidate a
 * stale approval. The graph is acyclic unless `topology` is `bounded-loop`.
 */
export const PlanRevisionSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_WRITE_VERSION),
  planId: OpaqueIdSchema,
  /** Monotonic revision of the plan; a new revision supersedes the prior. */
  planRevision: RevisionSchema,
  scope: ScopeDescriptorSchema,
  goal: z.string().min(1).max(4096),
  taskIds: z.array(OpaqueIdSchema),
  edges: z.array(PlanEdgeSchema),
  topology: PlanTopologySchema,
  authoritySnapshots: z.array(AuthoritySnapshotSchema),
  budgetId: OpaqueIdSchema.optional(),
  riskDigest: DigestSchema,
  validationGates: z.array(ValidationGateSchema),
  createdBy: OpaqueIdSchema,
  createdAt: TimestampSchema,
  /** The prior plan revision this one supersedes, if any. */
  supersedesRevision: RevisionSchema.optional(),
  /** The exact content digest that approval binds to (NN-TASK-003). */
  digest: DigestSchema,
  redaction: z.enum(['public', 'internal', 'sensitive', 'secret']),
});
export type PlanRevision = z.infer<typeof PlanRevisionSchema>;

/**
 * Compute the exact, immutable content digest of a plan revision. Approval
 * binds to this digest; any edit (goal, tasks, edges, topology, gates, budget,
 * snapshots) yields a different digest and invalidates a prior approval and
 * prior evidence (NN-TASK-003, CD-010). The digest never depends on volatile
 * presentation fields (`createdAt`, `createdBy`) — only the plan's meaning.
 */
export function computePlanDigest(input: {
  readonly planId: string;
  readonly planRevision: number;
  readonly goal: string;
  readonly taskIds: readonly string[];
  readonly edges: readonly PlanEdge[];
  readonly topology: PlanTopology;
  readonly authoritySnapshots: readonly AuthoritySnapshot[];
  readonly budgetId?: string;
  readonly riskDigest: string;
  readonly validationGates: readonly ValidationGate[];
}): string {
  return computeDigest({
    planId: input.planId,
    planRevision: input.planRevision,
    goal: input.goal,
    // Order matters for tasks/edges/gates; sort snapshots by authority so the
    // digest is stable regardless of caller ordering of the pinned set.
    taskIds: [...input.taskIds],
    edges: input.edges.map((e) => ({ from: e.from, to: e.to })),
    topology: input.topology,
    authoritySnapshots: [...input.authoritySnapshots]
      .map((s) => ({ authority: s.authority, revision: s.revision }))
      .sort((a, b) => a.authority.localeCompare(b.authority)),
    budgetId: input.budgetId ?? null,
    riskDigest: input.riskDigest,
    validationGates: input.validationGates.map((g) => ({
      gateId: g.gateId,
      kind: g.kind,
      required: g.required,
    })),
  });
}

// ─── Evidence-completion gate (NN-TASK-006) ─────────────────────────────────

/**
 * A minimal view of an `EvidenceRecord@1` the completion gate consumes. The
 * gate only needs the criterion it proves, the implementation revision it was
 * captured at, the plan revision it is bound to, and its result. This avoids a
 * hard dependency on the full EvidenceService contract while enforcing the
 * same-revision rule (NN-TASK-006).
 */
export interface EvidenceView {
  readonly evidenceId: string;
  /** The criterion alias this evidence proves (NN-*.ACnn or a gate id). */
  readonly criterionAlias: string;
  /** The implementation revision the evidence was captured at. */
  readonly implementationRevision: string;
  /** The plan revision the evidence is bound to. */
  readonly boundPlanRevision: number;
  readonly result: 'pass' | 'fail';
}

/** The input to {@link evaluateEvidenceCompletion}. */
export interface EvidenceCompletionInput {
  /** The acceptance criteria the task must satisfy. */
  readonly criterionAliases: readonly string[];
  /** The plan revision the task currently belongs to. */
  readonly planRevision: number;
  /** The implementation revision success is being claimed at. */
  readonly implementationRevision: string;
  /** All evidence records associated with the task. */
  readonly evidence: readonly EvidenceView[];
  /** The required validation gates (each needs a passing record too). */
  readonly requiredGateIds: readonly string[];
  /** Whether any active cancellation has NOT converged (incomplete). */
  readonly cancellationIncomplete: boolean;
  /** Whether any tool the task ran ended in failure. */
  readonly toolFailed: boolean;
  /** Whether the current approval binding is stale (digest/plan mismatch). */
  readonly approvalStale: boolean;
  /** Whether the dependency graph contains a cycle. */
  readonly dependencyCycle: boolean;
  /** Whether any declared dependency is unsatisfied. */
  readonly missingDependency: boolean;
  /** Whether the environment is unavailable. */
  readonly missingEnvironment: boolean;
}

/** The result of {@link evaluateEvidenceCompletion}. */
export interface EvidenceCompletionResult {
  /** Whether the task MAY transition to `succeeded`. */
  readonly canSucceed: boolean;
  /** The failure class that blocks success, if any. */
  readonly failureClass?: TaskFailureClass;
  /** A safe, secret-free explanation. */
  readonly reason: string;
}

/**
 * The evidence-gated success decision (NN-TASK-006, NN-INV-003). A task MAY
 * reach `succeeded` ONLY when:
 *
 *   1. no prohibited-outcome class is present — a dependency cycle, stale
 *      approval, missing dependency/environment, a failed tool, or an
 *      incomplete cancellation each blocks success outright; and
 *   2. every acceptance criterion has a PASSING evidence record bound to the
 *      SAME plan revision AND captured at the SAME implementation revision
 *      (same-revision evidence, NN-TASK-006); and
 *   3. every required validation gate has a passing record.
 *
 * A criterion whose only evidence is from a prior plan revision (invalidated by
 * an edit) or a different implementation revision is treated as missing/stale —
 * success is refused. This function has NO side effect: the same input always
 * yields the same decision.
 */
export function evaluateEvidenceCompletion(
  input: EvidenceCompletionInput,
): EvidenceCompletionResult {
  // Prohibited-outcome classes short-circuit; each can NEVER become success.
  if (input.dependencyCycle) {
    return blocked('dependency-cycle', 'plan contains a dependency cycle');
  }
  if (input.approvalStale) {
    return blocked('stale-approval', 'approval is stale for the current plan revision');
  }
  if (input.missingDependency) {
    return blocked('missing-dependency', 'a required dependency is unsatisfied');
  }
  if (input.missingEnvironment) {
    return blocked('missing-environment', 'the execution environment is unavailable');
  }
  if (input.toolFailed) {
    return blocked('failed-tool', 'a required tool ended in failure');
  }
  if (input.cancellationIncomplete) {
    return blocked(
      'incomplete-cancellation',
      'a cancellation has not converged; survivors remain',
    );
  }

  // Index only PASSING, same-revision, same-plan evidence per criterion.
  const satisfied = new Set<string>();
  for (const ev of input.evidence) {
    if (ev.result !== 'pass') continue;
    if (ev.boundPlanRevision !== input.planRevision) continue;
    if (ev.implementationRevision !== input.implementationRevision) continue;
    satisfied.add(ev.criterionAlias);
  }

  // Every acceptance criterion needs same-revision passing evidence.
  for (const criterion of input.criterionAliases) {
    if (!satisfied.has(criterion)) {
      // Distinguish "there is evidence but it is stale" from "none at all".
      const hasStale = input.evidence.some(
        (ev) =>
          ev.criterionAlias === criterion &&
          (ev.boundPlanRevision !== input.planRevision ||
            ev.implementationRevision !== input.implementationRevision),
      );
      return hasStale
        ? blocked(
            'stale-evidence',
            `criterion ${criterion} has only stale-revision evidence`,
          )
        : blocked('missing-evidence', `criterion ${criterion} has no passing evidence`);
    }
  }

  // Every required gate needs a passing, same-revision record too.
  for (const gateId of input.requiredGateIds) {
    if (!satisfied.has(gateId)) {
      return blocked('missing-gate', `required gate ${gateId} has no passing evidence`);
    }
  }

  return { canSucceed: true, reason: 'all criteria and gates satisfied at the current revision' };
}

function blocked(
  failureClass: TaskFailureClass,
  reason: string,
): EvidenceCompletionResult {
  return { canSucceed: false, failureClass, reason };
}

// ─── Scope helper ───────────────────────────────────────────────────────────

/** Whether a scope carries the workspace/project anchors a task requires. */
export function taskScopeComplete(scope: ScopeDescriptor): boolean {
  return (
    typeof scope.projectId === 'string' &&
    scope.projectId.length > 0 &&
    typeof scope.workspaceId === 'string' &&
    scope.workspaceId.length > 0
  );
}
