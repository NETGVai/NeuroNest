/**
 * Tool Execution Pipeline Schemas
 *
 * Defines the ordered pipeline stages, policy decisions, execution context,
 * result policy, and completion event schemas for the canonical tool
 * execution pipeline.
 *
 * Pipeline ordering:
 *   1. Input validation (against tool schema)
 *   2. Monotonic policy (deny/ask can never be relaxed)
 *   3. Execution (with Abort_Signal, deadline, retry, metrics, correlation)
 *   4. Output validation (against tool output schema)
 *   5. Commit immutable Canonical_Tool_Value
 *   6. Result policy (redaction, spill, retention, model presentation)
 *   7. Observe-only completion event
 *
 * Requirements: 13.2–13.7, 13.9
 */

import { z } from 'zod';
import {
  IdentifierSchema,
  TimestampSchema,
  IntegrityHashSchema,
  ContractRefSchema,
  RetentionDescriptorSchema,
} from '../contracts/primitives';
import { ScopeDescriptorV1Schema } from '../contracts/scope';
import { CanonicalToolValueV1Schema } from '../contracts/tool-value';

// ─── Policy Decision ────────────────────────────────────────────

/**
 * Policy decision outcomes per Requirement 13.3.
 * - allow: execution may proceed
 * - deny: execution is blocked (monotonic — cannot be relaxed)
 * - ask: requires user approval (monotonic — cannot be relaxed)
 */
export const PolicyDecisionSchema = z.enum(['allow', 'deny', 'ask']);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

/**
 * A single policy guard evaluation result.
 * Once a guard returns 'deny' or 'ask', no later middleware may relax it.
 */
export const PolicyGuardResultSchema = z.object({
  guardId: IdentifierSchema,
  decision: PolicyDecisionSchema,
  reason: z.string().optional(),
  evaluatedAt: TimestampSchema,
}).passthrough();

export type PolicyGuardResult = z.infer<typeof PolicyGuardResultSchema>;

/**
 * Aggregated monotonic policy outcome.
 * The final decision is the most restrictive across all guards:
 * deny > ask > allow (monotonic lattice).
 */
export const MonotonicPolicyOutcomeSchema = z.object({
  finalDecision: PolicyDecisionSchema,
  guards: z.array(PolicyGuardResultSchema),
  /** True if any guard escalated the decision (deny or ask was applied). */
  escalated: z.boolean(),
}).passthrough();

export type MonotonicPolicyOutcome = z.infer<typeof MonotonicPolicyOutcomeSchema>;

// ─── Pipeline Stage Results ─────────────────────────────────────

/**
 * Input validation result (Requirement 13.2).
 */
export const InputValidationResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.object({
    path: z.string(),
    message: z.string(),
    code: z.string().optional(),
  })).optional(),
  validatedAt: TimestampSchema,
}).passthrough();

export type InputValidationResult = z.infer<typeof InputValidationResultSchema>;

/**
 * Output validation result (Requirement 13.5).
 */
export const OutputValidationResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.object({
    path: z.string(),
    message: z.string(),
    code: z.string().optional(),
  })).optional(),
  validatedAt: TimestampSchema,
}).passthrough();

export type OutputValidationResult = z.infer<typeof OutputValidationResultSchema>;

// ─── Execution Context ──────────────────────────────────────────

/**
 * Execution context for a tool call (Requirement 13.4).
 * Carries correlation, cancellation, deadline, and metrics.
 */
export const ToolExecutionContextSchema = z.object({
  /** Immutable call identity assigned before pipeline entry. */
  callId: IdentifierSchema,
  /** Session correlation. */
  sessionId: IdentifierSchema,
  /** Turn correlation. */
  turnId: IdentifierSchema,
  /** Optional parent call (for nested tool calls). */
  parentCallId: IdentifierSchema.optional(),
  /** Model-order index for this call within the turn. */
  modelOrderIndex: z.number().int().nonnegative(),
  /** Tool contract reference. */
  toolContract: ContractRefSchema,
  /** Scope for this execution. */
  scope: ScopeDescriptorV1Schema,
  /** Deadline timestamp; execution must complete before this. */
  deadlineAt: TimestampSchema.optional(),
  /** Whether the abort signal has fired. */
  aborted: z.boolean().default(false),
  /** Correlation ID for metrics and tracing. */
  correlationId: IdentifierSchema,
  /** Idempotency key for replay safety. */
  idempotencyKey: IdentifierSchema.optional(),
}).passthrough();

export type ToolExecutionContext = z.infer<typeof ToolExecutionContextSchema>;

// ─── Tool Execution Metrics ─────────────────────────────────────

/**
 * Metrics collected during tool execution (Requirement 13.4).
 */
export const ToolExecutionMetricsSchema = z.object({
  callId: IdentifierSchema,
  startedAt: TimestampSchema,
  completedAt: TimestampSchema.optional(),
  durationMs: z.number().nonnegative().finite().optional(),
  retryCount: z.number().int().nonnegative(),
  aborted: z.boolean(),
  timedOut: z.boolean(),
  policyDecision: PolicyDecisionSchema,
}).passthrough();

export type ToolExecutionMetrics = z.infer<typeof ToolExecutionMetricsSchema>;

// ─── Result Policy ──────────────────────────────────────────────

/**
 * Redaction descriptor — fields or paths to redact from model-facing output.
 */
export const RedactionRuleSchema = z.object({
  /** JSONPath or field name to redact. */
  path: z.string(),
  /** Replacement value (defaults to "[REDACTED]"). */
  replacement: z.string().default('[REDACTED]'),
}).passthrough();

export type RedactionRule = z.infer<typeof RedactionRuleSchema>;

/**
 * Spill configuration — when output exceeds thresholds, spill to storage.
 */
export const SpillConfigSchema = z.object({
  /** Maximum size in bytes before spill is triggered. */
  maxSizeBytes: z.number().int().positive().finite(),
  /** Maximum lines before spill is triggered. */
  maxLines: z.number().int().positive().finite().optional(),
  /** Preview size to retain inline (bytes). */
  previewSizeBytes: z.number().int().positive().finite(),
}).passthrough();

export type SpillConfig = z.infer<typeof SpillConfigSchema>;

/**
 * Result policy applied after canonical value commit (Requirement 13.6).
 * This CANNOT mutate the committed Canonical_Tool_Value.
 */
export const ResultPolicySchema = z.object({
  /** Redaction rules for model-facing presentation. */
  redactionRules: z.array(RedactionRuleSchema).default([]),
  /** Spill configuration for oversized results. */
  spillConfig: SpillConfigSchema.optional(),
  /** Retention policy for the canonical value. */
  retention: RetentionDescriptorSchema,
  /** Model-facing presentation format. */
  modelPresentation: z.enum(['full', 'summary', 'preview', 'reference']).default('full'),
}).passthrough();

export type ResultPolicy = z.infer<typeof ResultPolicySchema>;

// ─── Model-Facing Presentation ──────────────────────────────────

/**
 * The model-facing view produced by result policy (Requirement 13.6).
 * This is a derivative of the canonical value — the canonical value remains immutable.
 */
export const ModelFacingResultSchema = z.object({
  callId: IdentifierSchema,
  /** Whether the result was redacted. */
  redacted: z.boolean(),
  /** Whether the result was spilled. */
  spilled: z.boolean(),
  /** The presentation content after redaction/spill/formatting. */
  content: z.unknown(),
  /** Spill reference for retrieval if spilled. */
  spillRef: IdentifierSchema.optional(),
  /** Presentation mode applied. */
  presentationMode: z.enum(['full', 'summary', 'preview', 'reference']),
  /** Digest of the canonical value (for integrity verification). */
  canonicalDigest: IntegrityHashSchema,
}).passthrough();

export type ModelFacingResult = z.infer<typeof ModelFacingResultSchema>;

// ─── Completion Event ───────────────────────────────────────────

/**
 * Observe-only completion event (Requirement 13.7).
 * This event CANNOT alter the committed outcome. It is purely observational.
 */
export const ToolCompletionEventSchema = z.object({
  eventId: IdentifierSchema,
  callId: IdentifierSchema,
  sessionId: IdentifierSchema,
  turnId: IdentifierSchema,
  correlationId: IdentifierSchema,
  toolContract: ContractRefSchema,
  /** Final status of the call. */
  status: z.enum(['success', 'validation_failure', 'policy_denied', 'policy_ask', 'aborted', 'timed_out', 'execution_error']),
  /** Duration from pipeline entry to completion. */
  pipelineDurationMs: z.number().nonnegative().finite(),
  /** Whether a synthetic result was committed (validation failure or policy deny). */
  synthetic: z.boolean(),
  /** Model-order index for ordering observability. */
  modelOrderIndex: z.number().int().nonnegative(),
  /** Metrics snapshot at completion. */
  metrics: ToolExecutionMetricsSchema,
  /** Timestamp of completion event emission. */
  emittedAt: TimestampSchema,
  schemaVersion: z.literal(1),
}).passthrough();

export type ToolCompletionEvent = z.infer<typeof ToolCompletionEventSchema>;

// ─── Synthetic Result ───────────────────────────────────────────

/**
 * Synthetic structured result returned when input/output validation fails
 * or policy denies execution (Requirement 13.9).
 * Paired with the immutable call identity.
 */
export const SyntheticToolResultSchema = z.object({
  callId: IdentifierSchema,
  toolContract: ContractRefSchema,
  reason: z.enum(['input_validation_failed', 'output_validation_failed', 'policy_denied', 'policy_ask_pending', 'aborted', 'timed_out', 'execution_error']),
  /** Structured error details. */
  errors: z.array(z.object({
    path: z.string().optional(),
    message: z.string(),
    code: z.string().optional(),
  })).default([]),
  /** The immutable call identity this result is paired with. */
  correlationId: IdentifierSchema,
  createdAt: TimestampSchema,
  schemaVersion: z.literal(1),
}).passthrough();

export type SyntheticToolResult = z.infer<typeof SyntheticToolResultSchema>;

// ─── Pipeline Input ─────────────────────────────────────────────

/**
 * Complete input to the Tool_Execution_Pipeline.
 */
export const PipelineInputSchema = z.object({
  /** Immutable call identity. */
  callId: IdentifierSchema,
  /** Tool contract reference (name + version). */
  toolContract: ContractRefSchema,
  /** Model-supplied arguments to validate. */
  arguments: z.record(z.string(), z.unknown()),
  /** Execution context with correlation, deadline, scope. */
  context: ToolExecutionContextSchema,
  /** Result policy to apply after canonical commit. */
  resultPolicy: ResultPolicySchema,
}).passthrough();

export type PipelineInput = z.infer<typeof PipelineInputSchema>;

// ─── Pipeline Output ────────────────────────────────────────────

/**
 * Pipeline execution result — either a successful canonical value
 * with model-facing presentation, or a synthetic result.
 */
export const PipelineOutputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('success'),
    callId: IdentifierSchema,
    canonicalValue: CanonicalToolValueV1Schema,
    modelFacing: ModelFacingResultSchema,
    completionEvent: ToolCompletionEventSchema,
    metrics: ToolExecutionMetricsSchema,
  }).passthrough(),
  z.object({
    kind: z.literal('synthetic'),
    callId: IdentifierSchema,
    syntheticResult: SyntheticToolResultSchema,
    completionEvent: ToolCompletionEventSchema,
    metrics: ToolExecutionMetricsSchema,
  }).passthrough(),
]);

export type PipelineOutput = z.infer<typeof PipelineOutputSchema>;

