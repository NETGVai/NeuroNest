/**
 * Orchestration contracts — `AgentRun@1`, the typed topology contract, bounded
 * execution profiles, workflow steps, the completion council, stuck detection,
 * bounded provider fallback, and external-pattern adapter descriptors
 * (FUT-PKG-06-EXECUTION/T-006).
 *
 * D-04/D-05 name the Orchestration Service as the sole write authority for the
 * bounded-run concept (canonical identity `runId`, run tree by
 * `parentRunId`/`rootRunId`); Kanban, taskbar, and dashboards are read-model
 * projections only. D-13 places DAG/topology validation ahead of any dispatch
 * and requires that one child failure never erases another result. D-07 pins
 * the versioned records; D-18/D-19 require typed errors and durable
 * correlation.
 *
 * This module is deliberately PURE and additive over
 * {@link ../shared/contract-primitives} and {@link ./task-types}: it declares
 * the versioned shapes and the deterministic, side-effect-free helpers
 * (topology validation, scope/budget bounding, bound checks, council
 * aggregation, no-progress hashing) that {@link ./orchestration-service} and
 * {@link ./run-locks} consume. The same input always yields the same result;
 * nothing here touches storage.
 *
 * Design anchors: D-05 (Orchestration Authority), D-07 (`AgentRun@1`), D-13
 * (parallel orchestration + bounded runs), D-18 (isolation of failures),
 * D-19 (correlation).
 * Requirements: NN-ORCH-001–012, NN-AGENT-003, NN-WORKSPACE-007,
 * NN-TASK-004/008, NN-INV-003/007/008/012.
 */

import { z } from 'zod';

import {
  CONTRACT_WRITE_VERSION,
  DigestSchema,
  OpaqueIdSchema,
  RevisionSchema,
  TimestampSchema,
  canonicalSerialize,
  computeDigest,
  isChildScopeOf,
  type ScopeDescriptor,
} from '../shared/contract-primitives';
import { hasCycle, validateDag } from './dag-validation';
import type { PlanEdge } from './task-types';

// ─── Typed topology contract (NN-ORCH-001) ──────────────────────────────────

/**
 * The typed orchestration topologies the planner may explicitly choose
 * (NN-ORCH-001). Every run declares exactly one. A topology is either
 * `acyclic` (its dependency graph must have no directed cycle) or one that
 * permits a bounded loop (`boomerang` is decomposition-and-aggregation and its
 * inter-task graph is still acyclic; only `bounded-batch`/`race` fan out
 * without inter-dependencies). A cyclic topology graph is always REJECTED.
 */
export const ORCHESTRATION_TOPOLOGIES = Object.freeze([
  'pipeline',
  'fan-out-fan-in',
  'expert-pool',
  'producer-reviewer',
  'supervisor',
  'hierarchical-delegation',
  'boomerang',
  'race',
  'bounded-batch',
] as const);
export type OrchestrationTopology = (typeof ORCHESTRATION_TOPOLOGIES)[number];
export const OrchestrationTopologySchema = z.enum(ORCHESTRATION_TOPOLOGIES);

/** The agent shape the planner explicitly selects alongside a topology. */
export const AGENT_SHAPES = Object.freeze([
  'single-agent',
  'subagent',
  'team',
  'hybrid',
] as const);
export type AgentShape = (typeof AGENT_SHAPES)[number];
export const AgentShapeSchema = z.enum(AGENT_SHAPES);

// ─── Bounded execution profile (NN-ORCH-004) ────────────────────────────────

/**
 * The hard bounds a run enforces (NN-ORCH-004). Every field is a finite,
 * positive integer ceiling; exceeding any bound BLOCKS admission and is never
 * unbounded. The legacy quantitative profiles (boomerang 2–15 subtasks,
 * concurrency 5, retries 3, Kilo nesting depth 3 / 10 spawns/session, Hermes
 * ≤3 concurrent, swarm 2–4 workers) are all expressible as these ceilings.
 */
export const ExecutionBoundsSchema = z.strictObject({
  /** Max concurrently-running children under one parent (e.g. 5). */
  maxConcurrency: z.number().int().positive().finite(),
  /** Max retry attempts per child before it is a hard failure (e.g. 3). */
  maxRetries: z.number().int().nonnegative().finite(),
  /** Max delegation/nesting depth below the root (e.g. 3). */
  maxNestingDepth: z.number().int().positive().finite(),
  /** Max total child spawns across the whole run tree (e.g. 10/session). */
  maxSpawns: z.number().int().positive().finite(),
  /** Max no-progress iterations before stuck detection terminates (e.g. 3). */
  maxNoProgressIterations: z.number().int().positive().finite(),
  /** Max provider fallback hops in a chain (legacy Hermes maximum 3). */
  maxFallbackHops: z.number().int().positive().finite(),
});
export type ExecutionBounds = z.infer<typeof ExecutionBoundsSchema>;

/** A conservative default bound profile matching the legacy quantitative caps. */
export const DEFAULT_EXECUTION_BOUNDS: ExecutionBounds = Object.freeze({
  maxConcurrency: 5,
  maxRetries: 3,
  maxNestingDepth: 3,
  maxSpawns: 10,
  maxNoProgressIterations: 3,
  maxFallbackHops: 3,
});

// ─── Parent-child resource budget (NN-ORCH-003) ─────────────────────────────

/**
 * The bounded resource budget a run carries. A child budget can NEVER exceed
 * its parent's on any axis (NN-ORCH-003/004); {@link isChildBudgetOf} enforces
 * the subset. All amounts are non-negative integers in abstract units (tokens,
 * milliseconds, and cost in minor currency units) so bounding is exact.
 */
export const RunBudgetSchema = z.strictObject({
  tokens: z.number().int().nonnegative().finite(),
  timeMs: z.number().int().nonnegative().finite(),
  costMinor: z.number().int().nonnegative().finite(),
  /** Max children this run may spawn from its own allotment. */
  spawns: z.number().int().nonnegative().finite(),
});
export type RunBudget = z.infer<typeof RunBudgetSchema>;

/**
 * Whether `child` is bounded by `parent` on every axis — no scope expansion:
 * a child can never request more of any resource than its parent has
 * (NN-ORCH-003, NN-ORCH-004). Equal is allowed; strictly greater on any axis
 * fails.
 */
export function isChildBudgetOf(child: RunBudget, parent: RunBudget): boolean {
  return (
    child.tokens <= parent.tokens &&
    child.timeMs <= parent.timeMs &&
    child.costMinor <= parent.costMinor &&
    child.spawns <= parent.spawns
  );
}

// ─── AgentRun@1 (D-07) ───────────────────────────────────────────────────────

/**
 * The lifecycle state ladder of an `AgentRun@1`. Terminal states are
 * `succeeded`, `failed`, `cancelled`, and `forced-terminated`; the rest are
 * transient. `succeeded` is reachable ONLY from `reviewing` through the
 * completion council (blind review + aggregated evidence) — never directly.
 */
export const RUN_STATES = Object.freeze([
  'planned',
  'running',
  'blocked',
  'reviewing',
  'succeeded',
  'failed',
  'cancelled',
  'forced-terminated',
] as const);
export type RunState = (typeof RUN_STATES)[number];
export const RunStateSchema = z.enum(RUN_STATES);

export const TERMINAL_RUN_STATES: readonly RunState[] = Object.freeze([
  'succeeded',
  'failed',
  'cancelled',
  'forced-terminated',
]);

/** Whether a run state is terminal (immutable, D-07.1). */
export function isTerminalRunState(state: RunState): boolean {
  return (TERMINAL_RUN_STATES as readonly string[]).includes(state);
}

/**
 * The legal run-state transitions (D-07.1 durable state machine; an unknown
 * transition is a `CONFLICT`). A terminal state has no outgoing edge.
 */
const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> =
  Object.freeze({
    planned: ['running', 'blocked', 'cancelled', 'forced-terminated'],
    running: ['blocked', 'reviewing', 'failed', 'cancelled', 'forced-terminated'],
    blocked: ['running', 'failed', 'cancelled', 'forced-terminated'],
    reviewing: ['succeeded', 'failed', 'blocked', 'cancelled', 'forced-terminated'],
    succeeded: [],
    failed: [],
    cancelled: [],
    'forced-terminated': [],
  });

/** Whether `from -> to` is a legal run-state transition. */
export function isLegalRunTransition(from: RunState, to: RunState): boolean {
  if (from === to) return false;
  return (RUN_TRANSITIONS[from] as readonly string[]).includes(to);
}

/**
 * `AgentRun@1`. A single bounded run node in the orchestration run tree. The
 * run carries its topology/shape, its child scope (a subset of the parent's),
 * its bounded budget (bounded by the parent's), its nesting depth, permissions
 * (never broader than parent), the completion anchor it must satisfy, and its
 * terminal result. `rootRunId` groups a whole tree; `parentRunId` is the run's
 * delegator (absent at the root).
 */
export const AgentRunSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_WRITE_VERSION),
  runId: OpaqueIdSchema,
  rootRunId: OpaqueIdSchema,
  parentRunId: OpaqueIdSchema.optional(),
  planId: OpaqueIdSchema,
  planRevision: RevisionSchema,
  topology: OrchestrationTopologySchema,
  shape: AgentShapeSchema,
  /** The agent this run delegates work to (a validated registry target). */
  agentId: OpaqueIdSchema.optional(),
  scope: z.custom<ScopeDescriptor>(),
  budget: RunBudgetSchema,
  bounds: ExecutionBoundsSchema,
  /** Delegation depth below the root; the root is 0 (NN-ORCH-004 nesting). */
  nestingDepth: z.number().int().nonnegative().finite(),
  /** Effective permissions; never broader than the parent (NN-ORCH-003). */
  permissions: z.array(z.string().min(1)),
  /** The completion anchor: the criterion aliases this run must satisfy. */
  completionAnchor: z.array(z.string().min(1)),
  /** Rationale/semantics persisted for the topology choice (NN-ORCH-001). */
  rationale: z.string().max(4096),
  state: RunStateSchema,
  revision: RevisionSchema,
  /** Retry attempts consumed by THIS run (bounded by `bounds.maxRetries`). */
  attempts: z.number().int().nonnegative().finite(),
  createdAt: TimestampSchema,
  redaction: z.literal('internal'),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

// ─── Topology validation (NN-ORCH-001/002, reuse DAG cycle detection) ────────

/** The typed outcome of {@link validateTopology}. */
export type TopologyValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | 'cycle'
        | 'dangling-edge'
        | 'edges-forbidden'
        | 'batch-bounds'
        | 'unknown-topology';
      readonly detail: string;
      readonly cycle?: readonly string[];
    };

/**
 * Validate a topology's task graph BEFORE any execution (NN-ORCH-002). All
 * topologies REUSE the T-003 DAG cycle detector: a cyclic graph is rejected,
 * period (a cyclic topology is invalid). Additional per-topology structural
 * rules:
 *
 *   - `bounded-batch` and `race` are pure fan-outs: they must declare NO
 *     inter-task edges (each candidate is independent). A batch must have
 *     1..maxBatch descriptors.
 *   - every other topology validates as an acyclic dependency graph with
 *     self-contained edges.
 *
 * The check is pure and deterministic — the same graph always yields the same
 * verdict — and never mutates storage.
 */
export function validateTopology(
  topology: OrchestrationTopology,
  taskIds: readonly string[],
  edges: readonly PlanEdge[],
  options: { readonly maxBatch?: number } = {},
): TopologyValidation {
  if (!(ORCHESTRATION_TOPOLOGIES as readonly string[]).includes(topology)) {
    return { ok: false, reason: 'unknown-topology', detail: `unknown topology '${topology}'` };
  }

  if (topology === 'bounded-batch' || topology === 'race') {
    if (edges.length > 0) {
      return {
        ok: false,
        reason: 'edges-forbidden',
        detail: `topology '${topology}' is a pure fan-out and must declare no inter-task edges`,
      };
    }
    if (topology === 'bounded-batch') {
      const maxBatch = options.maxBatch ?? 50;
      if (taskIds.length < 1 || taskIds.length > maxBatch) {
        return {
          ok: false,
          reason: 'batch-bounds',
          detail: `bounded-batch accepts 1..${maxBatch} descriptors, got ${taskIds.length}`,
        };
      }
    }
    return { ok: true };
  }

  // Every remaining topology is validated as an acyclic dependency graph.
  const dag = validateDag(taskIds, edges, 'acyclic');
  if (dag.ok) return { ok: true };
  if (dag.reason === 'cycle') {
    return {
      ok: false,
      reason: 'cycle',
      detail: `topology graph contains a cycle: ${(dag.cycle ?? []).join(' -> ')}`,
      ...(dag.cycle ? { cycle: dag.cycle } : {}),
    };
  }
  return { ok: false, reason: 'dangling-edge', detail: 'topology edge references an undeclared task' };
}

/** Convenience: whether a topology graph is acyclic-valid (reuses detector). */
export function isAcyclicTopologyGraph(
  taskIds: readonly string[],
  edges: readonly PlanEdge[],
): boolean {
  return !hasCycle(taskIds, edges);
}

// ─── Delegation bounding (NN-ORCH-003) ───────────────────────────────────────

/** Why a delegation was rejected (fail-closed; no scope/budget expansion). */
export type DelegationRejection =
  | 'scope-expansion'
  | 'budget-expansion'
  | 'permission-expansion'
  | 'nesting-exceeded'
  | 'spawns-exhausted';

/** The typed outcome of {@link validateDelegation}. */
export type DelegationValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: DelegationRejection; readonly detail: string };

/**
 * Validate a proposed child delegation against its parent (NN-ORCH-003/004).
 * A child may NEVER exceed the parent on ANY axis:
 *
 *   - child scope must be a subset of the parent scope (no scope expansion);
 *   - child budget must be bounded by the parent budget (no budget expansion);
 *   - child permissions must be a subset of the parent permissions (never
 *     broader than parent — NN-AGENT-003 read/edit/command/MCP scopes);
 *   - the child's nesting depth must not exceed `bounds.maxNestingDepth`;
 *   - the parent must have remaining spawn allotment.
 *
 * Any violation is a typed rejection with NO effect — the caller blocks the
 * subtree without touching unrelated runs.
 */
export function validateDelegation(input: {
  readonly parentScope: ScopeDescriptor;
  readonly childScope: ScopeDescriptor;
  readonly parentBudget: RunBudget;
  readonly childBudget: RunBudget;
  readonly parentPermissions: readonly string[];
  readonly childPermissions: readonly string[];
  readonly childNestingDepth: number;
  readonly bounds: ExecutionBounds;
  readonly parentSpawnsUsed: number;
}): DelegationValidation {
  if (!isChildScopeOf(input.childScope, input.parentScope)) {
    return { ok: false, reason: 'scope-expansion', detail: 'child scope is not a subset of the parent scope' };
  }
  if (!isChildBudgetOf(input.childBudget, input.parentBudget)) {
    return { ok: false, reason: 'budget-expansion', detail: 'child budget exceeds the parent budget on some axis' };
  }
  const parentPerms = new Set(input.parentPermissions);
  for (const perm of input.childPermissions) {
    if (!parentPerms.has(perm)) {
      return {
        ok: false,
        reason: 'permission-expansion',
        detail: `child permission '${perm}' is broader than the parent`,
      };
    }
  }
  if (input.childNestingDepth > input.bounds.maxNestingDepth) {
    return {
      ok: false,
      reason: 'nesting-exceeded',
      detail: `nesting depth ${input.childNestingDepth} exceeds bound ${input.bounds.maxNestingDepth}`,
    };
  }
  if (input.parentSpawnsUsed >= input.bounds.maxSpawns) {
    return {
      ok: false,
      reason: 'spawns-exhausted',
      detail: `spawn budget of ${input.bounds.maxSpawns} is exhausted`,
    };
  }
  return { ok: true };
}

// ─── Bound checks (NN-ORCH-004) ──────────────────────────────────────────────

/** Whether admitting one more concurrent child would stay within the bound. */
export function concurrencyAdmits(running: number, bounds: ExecutionBounds): boolean {
  return running < bounds.maxConcurrency;
}

/** Whether another retry attempt is permitted (bounded, never unbounded). */
export function retryAdmits(attempts: number, bounds: ExecutionBounds): boolean {
  return attempts < bounds.maxRetries;
}

// ─── Workflow steps (NN-ORCH-006/007) ────────────────────────────────────────

/** The workflow step kinds (NN-ORCH-006). */
export const WORKFLOW_STEP_KINDS = Object.freeze([
  'sequential',
  'parallel',
  'conditional',
  'batch',
  'packaged',
] as const);
export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];

/** The workflow step state ladder (NN-ORCH-006). */
export const WORKFLOW_STEP_STATES = Object.freeze([
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
] as const);
export type WorkflowStepState = (typeof WORKFLOW_STEP_STATES)[number];

/**
 * A workflow step with typed inputs/outputs, owner, attempt, idempotency key,
 * state, retry class, and a durable transition (NN-ORCH-006). `dependsOn`
 * names upstream step ids; a partial rerun recomputes only affected downstream
 * dependents.
 */
export const WorkflowStepSchema = z.strictObject({
  stepId: OpaqueIdSchema,
  kind: z.enum(WORKFLOW_STEP_KINDS),
  owner: OpaqueIdSchema,
  dependsOn: z.array(OpaqueIdSchema),
  inputDigest: DigestSchema,
  idempotencyKey: z.string().min(1).max(512),
  state: z.enum(WORKFLOW_STEP_STATES),
  attempt: z.number().int().nonnegative().finite(),
  retryClass: z.enum(['none', 'transient', 'idempotent']),
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

/**
 * The set of downstream step ids affected by rerunning `changed` — `changed`
 * itself plus every transitive dependent. A partial rerun recomputes ONLY this
 * set (NN-ORCH-006); unaffected steps are preserved. Pure and deterministic.
 */
export function affectedDownstream(
  steps: readonly WorkflowStep[],
  changed: readonly string[],
): readonly string[] {
  const dependents = new Map<string, string[]>();
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(step.stepId);
      dependents.set(dep, list);
    }
  }
  const affected = new Set<string>();
  const stack = [...changed];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (affected.has(id)) continue;
    affected.add(id);
    for (const child of dependents.get(id) ?? []) {
      if (!affected.has(child)) stack.push(child);
    }
  }
  return [...affected].sort((a, b) => a.localeCompare(b));
}

// ─── runBatch descriptor bounds (NN-ORCH-007) ────────────────────────────────

/** Min/max descriptors a single `runBatch` accepts (NN-ORCH-007). */
export const BATCH_MIN = 1;
export const BATCH_MAX = 50;

/** A per-entry batch result: success or a typed error, preserving order. */
export interface BatchEntryResult<T> {
  readonly index: number;
  readonly ok: boolean;
  readonly value?: T;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

// ─── Completion council (NN-ORCH-008) ────────────────────────────────────────

/**
 * One reviewer's blind verdict on an implementer's output. The reviewer never
 * sees the author identity — a blind {@link CouncilSubmission} carries only the
 * criterion evidence, not the author (NN-ORCH-008). A reviewer that is
 * unavailable produces no verdict, which BLOCKS completion (never auto-passes).
 */
export interface CouncilVerdict {
  readonly reviewerId: string;
  readonly criterionAlias: string;
  readonly outcome: 'pass' | 'fail';
}

/**
 * A blind submission to the council: the criterion aliases the run must
 * satisfy and the evidence outcomes, WITHOUT the author identity. The council
 * compares this to the exact completion anchor; it can never learn who authored
 * the work.
 */
export interface CouncilSubmission {
  readonly runId: string;
  /** The exact acceptance criteria the run must satisfy (completion anchor). */
  readonly requiredCriteria: readonly string[];
  /** The reviewers that MUST each render a verdict for a required review. */
  readonly requiredReviewers: readonly string[];
  /** The verdicts collected so far (blind; no author identity). */
  readonly verdicts: readonly CouncilVerdict[];
}

/** The typed council decision (NN-ORCH-008). */
export type CouncilDecision =
  | { readonly kind: 'accepted' }
  | {
      readonly kind: 'blocked';
      readonly reason:
        | 'missing-reviewer'
        | 'missing-criterion-verdict'
        | 'failing-verdict'
        | 'no-criteria';
      readonly detail: string;
    };

/**
 * Aggregate the council's blind verdicts against the exact acceptance criteria
 * (NN-ORCH-008). A run is ACCEPTED only when:
 *
 *   - there is at least one required criterion (self-assessment over zero
 *     criteria cannot mark completion);
 *   - every REQUIRED reviewer has rendered at least one verdict (a missing
 *     reviewer capability BLOCKS the required review — never auto-passes);
 *   - every required criterion has a `pass` verdict from a required reviewer;
 *   - no required reviewer rendered a `fail` on a required criterion.
 *
 * Otherwise the decision is `blocked` with a typed reason. Pure and
 * deterministic; the author identity is never an input.
 */
export function aggregateCouncil(submission: CouncilSubmission): CouncilDecision {
  if (submission.requiredCriteria.length === 0) {
    return { kind: 'blocked', reason: 'no-criteria', detail: 'no acceptance criteria to review' };
  }

  const requiredReviewers = new Set(submission.requiredReviewers);
  const reviewersSeen = new Set(submission.verdicts.map((v) => v.reviewerId));
  for (const reviewer of requiredReviewers) {
    if (!reviewersSeen.has(reviewer)) {
      return {
        kind: 'blocked',
        reason: 'missing-reviewer',
        detail: `required reviewer '${reviewer}' rendered no verdict; completion blocked`,
      };
    }
  }

  // A verdict only counts when it comes from a REQUIRED reviewer.
  const passByCriterion = new Set<string>();
  for (const verdict of submission.verdicts) {
    if (!requiredReviewers.has(verdict.reviewerId)) continue;
    if (verdict.outcome === 'fail') {
      return {
        kind: 'blocked',
        reason: 'failing-verdict',
        detail: `criterion '${verdict.criterionAlias}' failed blind review`,
      };
    }
    passByCriterion.add(verdict.criterionAlias);
  }

  for (const criterion of submission.requiredCriteria) {
    if (!passByCriterion.has(criterion)) {
      return {
        kind: 'blocked',
        reason: 'missing-criterion-verdict',
        detail: `criterion '${criterion}' has no passing verdict from a required reviewer`,
      };
    }
  }

  return { kind: 'accepted' };
}

// ─── Stuck / no-progress detection (NN-ORCH-009) ─────────────────────────────

/**
 * Compute a stable, key-order-independent progress hash from an observation
 * (e.g. the set of tool calls, findings, and open task ids). Two structurally
 * equal observations always produce the same hash, so a run that keeps
 * emitting the SAME observation is detected as making no progress
 * (NN-ORCH-009).
 */
export function progressHash(observation: unknown): string {
  return computeDigest(observation);
}

/** The stuck-detection policy action (NN-ORCH-009). */
export type StuckAction = 'continue' | 'advisory' | 'replan' | 'stop';

/**
 * Decide the stuck action from a bounded history of progress hashes
 * (NN-ORCH-009). When the last `maxNoProgressIterations` hashes are all equal
 * (repeated equivalent findings / no-progress), the run is stuck and the action
 * escalates to `stop` — a no-progress run is detected and terminated, never
 * spins forever. Below the threshold it may emit an `advisory`. Finite
 * thresholds and the resulting action are the durable evidence.
 */
export function decideStuck(
  progressHashes: readonly string[],
  bounds: ExecutionBounds,
): StuckAction {
  const window = bounds.maxNoProgressIterations;
  if (progressHashes.length < window) {
    // Emit an early advisory when we already see a short repeat streak.
    if (progressHashes.length >= 2) {
      const last = progressHashes[progressHashes.length - 1];
      const prev = progressHashes[progressHashes.length - 2];
      if (last === prev) return 'advisory';
    }
    return 'continue';
  }
  const tail = progressHashes.slice(progressHashes.length - window);
  const first = tail[0];
  const allEqual = tail.every((h) => h === first);
  return allEqual ? 'stop' : 'continue';
}

// ─── Bounded provider fallback (NN-ORCH-010) ─────────────────────────────────

/** One candidate in an ordered, bounded fallback chain (NN-ORCH-010). */
export interface FallbackCandidate {
  readonly providerId: string;
  readonly healthy: boolean;
  readonly hasCapability: boolean;
  /** Trust rank; a higher number is MORE trusted. Fallback never raises trust. */
  readonly trust: number;
}

/** The typed fallback selection outcome (NN-ORCH-010). */
export type FallbackSelection =
  | { readonly kind: 'selected'; readonly providerId: string; readonly hop: number }
  | {
      readonly kind: 'exhausted';
      readonly reason: 'no-healthy-capable' | 'hops-exceeded' | 'empty-chain';
      readonly detail: string;
    };

/**
 * Select from an ORDERED, BOUNDED fallback chain (NN-ORCH-010). Walks the chain
 * in order up to `bounds.maxFallbackHops` hops, choosing the first candidate
 * that is healthy AND capable AND whose trust is NOT below the source trust
 * (source context never moves silently to a LESS trusted provider). Exhaustion
 * returns a typed failure; there is no unbounded retry and no silent trust
 * downgrade.
 */
export function selectFallback(
  chain: readonly FallbackCandidate[],
  sourceTrust: number,
  bounds: ExecutionBounds,
): FallbackSelection {
  if (chain.length === 0) {
    return { kind: 'exhausted', reason: 'empty-chain', detail: 'fallback chain is empty' };
  }
  const maxHops = Math.min(chain.length, bounds.maxFallbackHops);
  for (let hop = 0; hop < maxHops; hop += 1) {
    const candidate = chain[hop]!;
    if (candidate.healthy && candidate.hasCapability && candidate.trust >= sourceTrust) {
      return { kind: 'selected', providerId: candidate.providerId, hop };
    }
  }
  if (chain.length > bounds.maxFallbackHops) {
    return {
      kind: 'exhausted',
      reason: 'hops-exceeded',
      detail: `no healthy/capable/trusted provider within ${bounds.maxFallbackHops} hops`,
    };
  }
  return {
    kind: 'exhausted',
    reason: 'no-healthy-capable',
    detail: 'no healthy, capable, non-downgrading provider in the chain',
  };
}

// ─── External orchestration pattern adapters (NN-ORCH-011) ───────────────────

/**
 * The external orchestration patterns that EXTEND NeuroNest authorities rather
 * than create parallel orchestration truth (NN-ORCH-011). Each adapter maps its
 * external concept onto the canonical topology/shape; it never introduces a
 * second run authority. ORCA (NN-ORCH-012) invents no behavior and is absent.
 */
export const EXTERNAL_PATTERNS = Object.freeze([
  'deerflow',
  'kilo',
  'roo',
  'hermes',
  'mindstudio',
] as const);
export type ExternalPattern = (typeof EXTERNAL_PATTERNS)[number];

/**
 * How an external pattern maps onto the canonical contract. `authority` is
 * always the one Orchestration Authority — the adapter extends it, never
 * replacing it (NN-ORCH-011). `maxConcurrency`/`maxFallbackHops` capture the
 * legacy quantitative caps (e.g. Hermes ≤3 concurrent, ≤3 fallback hops).
 */
export interface ExternalPatternAdapter {
  readonly pattern: ExternalPattern;
  readonly canonicalTopology: OrchestrationTopology;
  readonly canonicalShape: AgentShape;
  readonly authority: 'authority-orchestration';
  readonly overrides: Partial<ExecutionBounds>;
}

/** The fixed adapter table. Each pattern maps to one canonical topology/shape. */
export const EXTERNAL_PATTERN_ADAPTERS: Readonly<
  Record<ExternalPattern, ExternalPatternAdapter>
> = Object.freeze({
  deerflow: {
    pattern: 'deerflow',
    canonicalTopology: 'supervisor',
    canonicalShape: 'team',
    authority: 'authority-orchestration',
    overrides: {},
  },
  kilo: {
    pattern: 'kilo',
    canonicalTopology: 'hierarchical-delegation',
    canonicalShape: 'subagent',
    authority: 'authority-orchestration',
    overrides: { maxNestingDepth: 3, maxSpawns: 10 },
  },
  roo: {
    pattern: 'roo',
    canonicalTopology: 'expert-pool',
    canonicalShape: 'team',
    authority: 'authority-orchestration',
    overrides: {},
  },
  hermes: {
    pattern: 'hermes',
    canonicalTopology: 'fan-out-fan-in',
    canonicalShape: 'subagent',
    authority: 'authority-orchestration',
    overrides: { maxConcurrency: 3, maxFallbackHops: 3 },
  },
  mindstudio: {
    pattern: 'mindstudio',
    canonicalTopology: 'pipeline',
    canonicalShape: 'hybrid',
    authority: 'authority-orchestration',
    overrides: {},
  },
});

/**
 * Resolve an external pattern to a bounded canonical run configuration. The
 * adapter's `overrides` narrow the base bounds (never widen — an override is
 * clamped to the min of base and override so an adapter can only TIGHTEN a
 * bound, preserving "extend, not replace"). Returns the canonical topology,
 * shape, and effective bounds.
 */
export function resolveExternalPattern(
  pattern: ExternalPattern,
  baseBounds: ExecutionBounds,
): {
  readonly topology: OrchestrationTopology;
  readonly shape: AgentShape;
  readonly bounds: ExecutionBounds;
} {
  const adapter = EXTERNAL_PATTERN_ADAPTERS[pattern];
  const o = adapter.overrides;
  const bounds: ExecutionBounds = {
    maxConcurrency: Math.min(baseBounds.maxConcurrency, o.maxConcurrency ?? baseBounds.maxConcurrency),
    maxRetries: Math.min(baseBounds.maxRetries, o.maxRetries ?? baseBounds.maxRetries),
    maxNestingDepth: Math.min(baseBounds.maxNestingDepth, o.maxNestingDepth ?? baseBounds.maxNestingDepth),
    maxSpawns: Math.min(baseBounds.maxSpawns, o.maxSpawns ?? baseBounds.maxSpawns),
    maxNoProgressIterations: Math.min(
      baseBounds.maxNoProgressIterations,
      o.maxNoProgressIterations ?? baseBounds.maxNoProgressIterations,
    ),
    maxFallbackHops: Math.min(baseBounds.maxFallbackHops, o.maxFallbackHops ?? baseBounds.maxFallbackHops),
  };
  return { topology: adapter.canonicalTopology, shape: adapter.canonicalShape, bounds };
}

// ─── Canonical serialization helper ───────────────────────────────────────────

/** Serialize an `AgentRun@1` to canonical bytes (key-order independent). */
export function serializeAgentRun(run: AgentRun): string {
  return canonicalSerialize(run);
}
