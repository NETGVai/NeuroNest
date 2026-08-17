/**
 * Orchestration Schemas — Bounded subagent delegation and durable workflow state machines.
 *
 * Defines schemas for subagent contracts, delegation modes, lineage records,
 * resource budgets, workflow DAGs, step transitions, competitive evaluation,
 * and result injection. All bounds come from Settings_Service and are finite/positive.
 *
 * Requirements: 5.1–5.7, 6.1–6.6
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema, SequenceSchema } from '../contracts/primitives';
import { ScopeDescriptorV1Schema } from '../contracts/scope';

// ─── Delegation Mode ────────────────────────────────────────────

/**
 * Canonical delegation modes under one subagent contract (Requirement 5.1).
 *
 * - in_process: Runs in the same process, sharing event loop.
 * - fork_from_history: Forks a session from a given sequence and runs independently.
 * - isolated_worker: Runs in an isolated worker/process with no shared memory.
 */
export const DelegationModeSchema = z.enum([
  'in_process',
  'fork_from_history',
  'isolated_worker',
]);

export type DelegationMode = z.infer<typeof DelegationModeSchema>;

// ─── Resource Budgets ───────────────────────────────────────────

/**
 * Resource budgets for a subagent or workflow step (Requirement 5.5).
 * All values are positive and finite; enforcement is on exceed, not on approach.
 */
export const ResourceBudgetV1Schema = z.object({
  /** Maximum execution time in milliseconds. */
  maxTimeMs: z.number().positive().finite(),
  /** Maximum tokens consumed (input + output). */
  maxTokens: z.number().int().positive().finite(),
  /** Maximum cost in smallest currency unit. */
  maxCost: z.number().positive().finite(),
  /** Maximum output bytes produced. */
  maxOutputBytes: z.number().int().positive().finite(),
  /** Maximum continuation rounds. */
  maxContinuations: z.number().int().positive().finite(),
  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type ResourceBudgetV1 = z.infer<typeof ResourceBudgetV1Schema>;

// ─── Subagent Lineage Record ────────────────────────────────────

/**
 * Lineage record appended to Session_Log when delegation occurs (Requirement 5.2).
 *
 * Records parent-child relationship, source sequence, goal, scope, budgets,
 * and continuation limits.
 */
export const SubagentLineageRecordV1Schema = z.object({
  /** Unique lineage record identity. */
  lineageId: IdentifierSchema,
  /** Parent session/agent identity. */
  parentId: IdentifierSchema,
  /** Child identity assigned to the subagent. */
  childId: IdentifierSchema,
  /** Source sequence at delegation time. */
  sourceSequence: SequenceSchema,
  /** Human-readable goal description. */
  goal: z.string().min(1),
  /** Scope constraints for the child. */
  scope: ScopeDescriptorV1Schema,
  /** Resource budgets applied to the child. */
  budget: ResourceBudgetV1Schema,
  /** Delegation mode. */
  delegationMode: DelegationModeSchema,
  /** Completion anchor binding from the parent context. */
  completionAnchorId: IdentifierSchema.optional(),
  /** Whether this child is explicitly durable (transferred to Job_Service on parent end). */
  durable: z.boolean().default(false),
  /** When this lineage record was created. */
  createdAt: TimestampSchema,
  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type SubagentLineageRecordV1 = z.infer<typeof SubagentLineageRecordV1Schema>;

// ─── Subagent State ─────────────────────────────────────────────

/**
 * Lifecycle states for a subagent (Requirement 5.3, 5.5, 5.7).
 */
export const SubagentStateSchema = z.enum([
  'pending',
  'running',
  'completed',
  'cancelled_budget_exceeded',
  'cancelled_parent_ended',
  'failed',
  'transferred_to_job_service',
]);

export type SubagentState = z.infer<typeof SubagentStateSchema>;

/** Terminal subagent states. */
export const TERMINAL_SUBAGENT_STATES: ReadonlySet<SubagentState> = new Set([
  'completed',
  'cancelled_budget_exceeded',
  'cancelled_parent_ended',
  'failed',
  'transferred_to_job_service',
]);

// ─── Progress Event ─────────────────────────────────────────────

/**
 * Observe-only progress event from a child (Requirement 5.3).
 * Does not mutate parent model context unless injection policy selects it.
 */
export const SubagentProgressEventV1Schema = z.object({
  /** Progress event identity. */
  progressId: IdentifierSchema,
  /** Child identity reporting progress. */
  childId: IdentifierSchema,
  /** Parent identity observing progress. */
  parentId: IdentifierSchema,
  /** Kind of progress: status update, partial result, metric. */
  kind: z.enum(['status', 'partial_result', 'metric']),
  /** Progress payload (type depends on kind). */
  payload: z.record(z.string(), z.unknown()),
  /** Current resource consumption at this point. */
  currentConsumption: z.object({
    elapsedMs: z.number().nonnegative().finite(),
    tokensUsed: z.number().int().nonnegative(),
    costIncurred: z.number().nonnegative().finite(),
    outputBytes: z.number().int().nonnegative(),
    continuationsUsed: z.number().int().nonnegative(),
  }).passthrough(),
  /** When this progress was reported. */
  reportedAt: TimestampSchema,
  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type SubagentProgressEventV1 = z.infer<typeof SubagentProgressEventV1Schema>;

// ─── Result Injection ───────────────────────────────────────────

/**
 * Injection policy for subagent results into parent context (Requirement 5.3, 5.4).
 */
export const InjectionPolicySchema = z.enum([
  /** Never inject — parent must explicitly query. */
  'never',
  /** Inject only on completion with validated result. */
  'on_completion',
  /** Inject selected progress events matching criteria. */
  'on_selected_progress',
]);

export type InjectionPolicy = z.infer<typeof InjectionPolicySchema>;

/**
 * Validated result from a completed subagent (Requirement 5.4).
 */
export const SubagentResultV1Schema = z.object({
  /** Result identity. */
  resultId: IdentifierSchema,
  /** Child that produced this result. */
  childId: IdentifierSchema,
  /** Terminal state of the child. */
  terminalState: SubagentStateSchema,
  /** Whether result was validated before publishing. */
  validated: z.boolean(),
  /** Validation errors if any. */
  validationErrors: z.array(z.string()).optional(),
  /** The result payload (validated against expected output schema). */
  payload: z.unknown(),
  /** Final resource consumption. */
  finalConsumption: z.object({
    elapsedMs: z.number().nonnegative().finite(),
    tokensUsed: z.number().int().nonnegative(),
    costIncurred: z.number().nonnegative().finite(),
    outputBytes: z.number().int().nonnegative(),
    continuationsUsed: z.number().int().nonnegative(),
  }).passthrough(),
  /** Whether this result was injected into parent inbox. */
  injectedToParent: z.boolean(),
  /** When the result was recorded. */
  recordedAt: TimestampSchema,
  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type SubagentResultV1 = z.infer<typeof SubagentResultV1Schema>;

// ─── Budget Exceeded Partial Result ─────────────────────────────

/**
 * Structured partial result published when a budget is exceeded (Requirement 5.5).
 */
export const BudgetExceededResultV1Schema = z.object({
  childId: IdentifierSchema,
  exceededBudget: z.enum(['time', 'tokens', 'cost', 'output', 'continuations']),
  budgetLimit: z.number().positive().finite(),
  actualValue: z.number().nonnegative().finite(),
  partialPayload: z.unknown().optional(),
  recordedAt: TimestampSchema,
  schemaVersion: z.literal(1),
}).passthrough();

export type BudgetExceededResultV1 = z.infer<typeof BudgetExceededResultV1Schema>;

// ─── Competitive Evaluation ─────────────────────────────────────

/**
 * Configuration for bounded competitive evaluation (Requirement 5.6).
 */
export const CompetitiveEvaluationConfigV1Schema = z.object({
  /** Whether competitive evaluation is enabled. */
  enabled: z.boolean(),
  /** Maximum parallel candidates (positive finite). */
  maxCandidates: z.number().int().positive().finite(),
  /** Evaluation criteria for selecting winner. */
  selectionCriteria: z.enum(['first_complete', 'best_quality', 'lowest_cost']),
  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type CompetitiveEvaluationConfigV1 = z.infer<typeof CompetitiveEvaluationConfigV1Schema>;

// ─── Delegation Command ─────────────────────────────────────────

/**
 * Full delegation command submitted to the Orchestration_Engine (Requirements 5.1–5.6).
 */
export const DelegationCommandV1Schema = z.object({
  /** Command identity. */
  commandId: IdentifierSchema,
  /** Parent issuing the delegation. */
  parentId: IdentifierSchema,
  /** Goal for the child. */
  goal: z.string().min(1),
  /** Delegation mode. */
  delegationMode: DelegationModeSchema,
  /** Scope constraints. */
  scope: ScopeDescriptorV1Schema,
  /** Resource budgets. */
  budget: ResourceBudgetV1Schema,
  /** Injection policy for results. */
  injectionPolicy: InjectionPolicySchema,
  /** Source sequence at delegation time. */
  sourceSequence: SequenceSchema,
  /** Completion anchor binding. */
  completionAnchorId: IdentifierSchema.optional(),
  /** Whether child is explicitly durable. */
  durable: z.boolean().default(false),
  /** Competitive evaluation config if multiple candidates. */
  competitiveEvaluation: CompetitiveEvaluationConfigV1Schema.optional(),
  /** When this command was issued. */
  issuedAt: TimestampSchema,
  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type DelegationCommandV1 = z.infer<typeof DelegationCommandV1Schema>;

// ─── Workflow Step Definition ────────────────────────────────────

/**
 * Workflow step type (Requirement 6.2).
 */
export const WorkflowStepTypeSchema = z.enum([
  'sequential',
  'bounded_parallel',
  'conditional',
]);

export type WorkflowStepType = z.infer<typeof WorkflowStepTypeSchema>;

/**
 * A single workflow step definition (Requirements 6.1–6.2).
 */
export const WorkflowStepDefinitionV1Schema = z.object({
  /** Unique step identity within the workflow. */
  stepId: IdentifierSchema,
  /** Step name for diagnostics. */
  name: z.string().min(1),
  /** Step type (sequential, bounded_parallel, conditional). */
  stepType: WorkflowStepTypeSchema,
  /** IDs of steps that must complete before this step (DAG edges). */
  dependsOn: z.array(IdentifierSchema).default([]),
  /** Resource budget for this step. */
  budget: ResourceBudgetV1Schema,
  /** Scope constraints for this step. */
  scope: ScopeDescriptorV1Schema,
  /** Maximum retry attempts for this step (finite positive). */
  maxRetries: z.number().int().nonnegative().finite(),
  /** Owner identity for this step. */
  ownerId: IdentifierSchema,
  /** Condition expression (for conditional steps). */
  condition: z.string().optional(),
  /** Maximum parallel sub-steps (for bounded_parallel). */
  parallelLimit: z.number().int().positive().finite().optional(),
  /** Goal/action description. */
  goal: z.string().min(1),
  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type WorkflowStepDefinitionV1 = z.infer<typeof WorkflowStepDefinitionV1Schema>;

// ─── Workflow Definition ────────────────────────────────────────

/**
 * Complete workflow definition submitted for validation and execution (Requirement 6.1).
 */
export const WorkflowDefinitionV1Schema = z.object({
  /** Unique workflow identity. */
  workflowId: IdentifierSchema,
  /** Workflow name. */
  name: z.string().min(1),
  /** Ordered step definitions forming the DAG. */
  steps: z.array(WorkflowStepDefinitionV1Schema).min(1),
  /** Overall scope constraints. */
  scope: ScopeDescriptorV1Schema,
  /** Overall resource budget. */
  budget: ResourceBudgetV1Schema,
  /** Owner identity. */
  ownerId: IdentifierSchema,
  /** Maximum finite continuation bounds for the whole workflow. */
  maxContinuations: z.number().int().positive().finite(),
  /** When this workflow was submitted. */
  submittedAt: TimestampSchema,
  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type WorkflowDefinitionV1 = z.infer<typeof WorkflowDefinitionV1Schema>;

// ─── Workflow Step State ─────────────────────────────────────────

/**
 * Lifecycle states for a workflow step (Requirement 6.3).
 */
export const WorkflowStepStateSchema = z.enum([
  'pending',
  'ready',
  'running',
  'completed',
  'failed',
  'retrying',
  'skipped',
  'cancelled',
]);

export type WorkflowStepState = z.infer<typeof WorkflowStepStateSchema>;

/** Terminal workflow step states. */
export const TERMINAL_STEP_STATES: ReadonlySet<WorkflowStepState> = new Set([
  'completed',
  'failed',
  'skipped',
  'cancelled',
]);

// ─── Workflow Step Transition ────────────────────────────────────

/**
 * Versioned transition event for workflow step state changes (Requirement 6.3).
 * Appended to Session_Log.
 */
export const WorkflowStepTransitionV1Schema = z.object({
  /** Transition identity. */
  transitionId: IdentifierSchema,
  /** Workflow this transition belongs to. */
  workflowId: IdentifierSchema,
  /** Step that transitioned. */
  stepId: IdentifierSchema,
  /** Current attempt number (1-based). */
  attempt: z.number().int().positive(),
  /** Owner of this step. */
  ownerId: IdentifierSchema,
  /** Previous state. */
  fromState: WorkflowStepStateSchema,
  /** New state. */
  toState: WorkflowStepStateSchema,
  /** Reason or cause for the transition. */
  reason: z.string().optional(),
  /** Error details if transitioning to failed. */
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  }).optional(),
  /** Idempotency key for this transition. */
  idempotencyKey: IdentifierSchema,
  /** When this transition occurred. */
  occurredAt: TimestampSchema,
  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type WorkflowStepTransitionV1 = z.infer<typeof WorkflowStepTransitionV1Schema>;

// ─── Workflow State ─────────────────────────────────────────────

/**
 * Overall workflow lifecycle state.
 */
export const WorkflowStateSchema = z.enum([
  'validating',
  'running',
  'completed',
  'failed',
  'cancelled',
  'suspended',
]);

export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

/** Terminal workflow states. */
export const TERMINAL_WORKFLOW_STATES: ReadonlySet<WorkflowState> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

// ─── DAG Validation Result ──────────────────────────────────────

/**
 * Result of validating a workflow DAG (Requirement 6.1).
 */
export const DAGValidationResultSchema = z.discriminatedUnion('valid', [
  z.object({
    valid: z.literal(true),
    topologicalOrder: z.array(IdentifierSchema),
  }),
  z.object({
    valid: z.literal(false),
    errors: z.array(z.object({
      kind: z.enum([
        'cycle_detected',
        'missing_dependency',
        'duplicate_step_id',
        'invalid_schema',
        'empty_steps',
        'self_dependency',
      ]),
      stepId: IdentifierSchema.optional(),
      detail: z.string(),
    })),
  }),
]);

export type DAGValidationResult = z.infer<typeof DAGValidationResultSchema>;

// ─── Orchestration Engine Configuration ─────────────────────────

/**
 * Configuration for the Orchestration_Engine (from Settings_Service).
 */
export const OrchestrationConfigSchema = z.object({
  /** Default resource budgets for delegations without explicit budgets. */
  defaultBudget: ResourceBudgetV1Schema,
  /** Maximum concurrent subagents per parent. */
  maxConcurrentSubagents: z.number().int().positive().finite(),
  /** Maximum competitive evaluation candidates. */
  maxCompetitiveCandidates: z.number().int().positive().finite(),
  /** Default retry policy for workflow steps. */
  defaultStepMaxRetries: z.number().int().nonnegative().finite(),
  /** Default injection policy. */
  defaultInjectionPolicy: InjectionPolicySchema,
});

export type OrchestrationConfig = z.infer<typeof OrchestrationConfigSchema>;
