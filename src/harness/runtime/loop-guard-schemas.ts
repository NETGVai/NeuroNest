/**
 * Loop Guard Schemas — Configuration, evidence, and outcome contracts.
 *
 * Defines Zod schemas for Loop_Guard:
 * - Equivalent call detection thresholds (per-tool and per-route)
 * - Progress/token/cost/time/continuation budget limits
 * - Advisory and escalation evidence
 * - Terminal outcome records
 * - Session_Log evidence records
 *
 * Requirements: 7.1–7.5
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema, ContractRefSchema } from '../contracts/primitives';
import { ScopeDescriptorV1Schema } from '../contracts/scope';

// ─── Budget Types ───────────────────────────────────────────────

/**
 * Budget kind discriminator for Loop_Guard monitoring.
 * Requirement 7.3: progress/token/cost/time/continuation limits.
 */
export const BudgetKindSchema = z.enum([
  'progress',
  'token',
  'cost',
  'time',
  'continuation',
]);

export type BudgetKind = z.infer<typeof BudgetKindSchema>;

/**
 * Individual budget limit configuration.
 * All values must be positive and finite per Settings_Service contract.
 */
export const BudgetLimitSchema = z.object({
  kind: BudgetKindSchema,
  /** Maximum allowed value. Must be positive and finite. */
  limit: z.number().positive().finite(),
  /** Unit label for display and diagnostics (e.g., 'tokens', 'ms', 'USD'). */
  unit: z.string().min(1),
});

export type BudgetLimit = z.infer<typeof BudgetLimitSchema>;

// ─── Escalation Policy ──────────────────────────────────────────

/**
 * Escalation action when Loop_Guard triggers.
 * Requirement 7.2: request user intervention, enter Plan_Mode, or stop.
 */
export const EscalationActionSchema = z.enum([
  'request_user_intervention',
  'enter_plan_mode',
  'stop',
]);

export type EscalationAction = z.infer<typeof EscalationActionSchema>;

// ─── Per-Tool Thresholds ────────────────────────────────────────

/**
 * Per-tool threshold configuration.
 * Requirement 7.4: per-tool and per-route thresholds from validated settings.
 */
export const PerToolThresholdSchema = z.object({
  /** Tool contract reference. If omitted, this is the default threshold. */
  toolContract: ContractRefSchema.optional(),
  /** Route identifier. If omitted, applies to all routes. */
  routeId: IdentifierSchema.optional(),
  /** Consecutive equivalent call count before advisory. Must be positive. */
  consecutiveCallThreshold: z.number().int().positive().finite(),
  /** Additional equivalent calls after advisory before escalation. Must be non-negative. */
  advisoryGraceCount: z.number().int().nonnegative().finite(),
  /** Escalation action when grace count is exhausted. */
  escalationAction: EscalationActionSchema,
});

export type PerToolThreshold = z.infer<typeof PerToolThresholdSchema>;

// ─── Loop Guard Configuration ───────────────────────────────────

/**
 * Complete Loop_Guard configuration resolved from Settings_Service.
 * Requirement 7.4: per-tool and per-route thresholds resolved through validated settings.
 */
export const LoopGuardConfigSchema = z.object({
  /** Default consecutive-call threshold. */
  defaultConsecutiveCallThreshold: z.number().int().positive().finite().default(3),
  /** Default advisory grace count. */
  defaultAdvisoryGraceCount: z.number().int().nonnegative().finite().default(2),
  /** Default escalation action. */
  defaultEscalationAction: EscalationActionSchema.default('stop'),
  /** Per-tool/route threshold overrides. */
  perToolThresholds: z.array(PerToolThresholdSchema).default([]),
  /** Budget limits for this session/turn. */
  budgets: z.array(BudgetLimitSchema).default([]),
  /** Schema version for settings evolution. */
  schemaVersion: z.literal(1),
}).passthrough();

export type LoopGuardConfig = z.infer<typeof LoopGuardConfigSchema>;

// ─── Tool Call Identity (for equivalence detection) ─────────────

/**
 * Normalized identity of a tool call for equivalence comparison.
 * Requirement 7.1: detect equivalent tool calls.
 */
export const ToolCallIdentitySchema = z.object({
  /** Tool contract reference. */
  toolContract: ContractRefSchema,
  /** Normalized argument digest for equivalence comparison. */
  argumentDigest: z.string().min(1),
  /** Route identifier for route-scoped thresholds. */
  routeId: IdentifierSchema.optional(),
});

export type ToolCallIdentity = z.infer<typeof ToolCallIdentitySchema>;

// ─── Advisory Record ────────────────────────────────────────────

/**
 * Advisory appended when equivalent calls reach the threshold.
 * Requirement 7.1: append advisory containing repeated call identities and remaining budgets.
 */
export const LoopAdvisorySchema = z.object({
  type: z.literal('loop_advisory'),
  /** Unique advisory identity. */
  advisoryId: IdentifierSchema,
  /** Session identity. */
  sessionId: IdentifierSchema,
  /** Turn identity. */
  turnId: IdentifierSchema,
  /** Tool contract that triggered the advisory. */
  toolContract: ContractRefSchema,
  /** The repeated call identities (argument digests). */
  repeatedCallIdentities: z.array(ToolCallIdentitySchema).min(1),
  /** Current consecutive call count. */
  consecutiveCount: z.number().int().positive(),
  /** Configured threshold for this tool/route. */
  configuredThreshold: z.number().int().positive(),
  /** Remaining budget snapshots at advisory time. */
  remainingBudgets: z.array(z.object({
    kind: BudgetKindSchema,
    remaining: z.number().finite(),
    limit: z.number().positive().finite(),
    unit: z.string().min(1),
  })),
  /** Timestamp of advisory. */
  occurredAt: TimestampSchema,
  schemaVersion: z.literal(1),
}).passthrough();

export type LoopAdvisory = z.infer<typeof LoopAdvisorySchema>;

// ─── Escalation Evidence ────────────────────────────────────────

/**
 * Escalation trigger reason discriminator.
 */
export const EscalationReasonSchema = z.enum([
  'equivalent_calls_exhausted_grace',
  'budget_exhausted',
]);

export type EscalationReason = z.infer<typeof EscalationReasonSchema>;

/**
 * Evidence record when Loop_Guard escalates.
 * Requirement 7.5: record triggering evidence, selected policy, and resulting action.
 */
export const LoopEscalationEvidenceSchema = z.object({
  type: z.literal('loop_escalation'),
  /** Unique escalation identity. */
  escalationId: IdentifierSchema,
  /** Session identity. */
  sessionId: IdentifierSchema,
  /** Turn identity. */
  turnId: IdentifierSchema,
  /** Reason for escalation. */
  reason: EscalationReasonSchema,
  /** Tool contract involved (for equivalent-call escalation). */
  toolContract: ContractRefSchema.optional(),
  /** Budget kind involved (for budget-exhausted escalation). */
  exhaustedBudget: BudgetKindSchema.optional(),
  /** Current usage at escalation time. */
  currentUsage: z.number().finite().optional(),
  /** Configured limit. */
  configuredLimit: z.number().positive().finite().optional(),
  /** Selected policy (from settings). */
  selectedPolicy: EscalationActionSchema,
  /** Resulting action taken. */
  resultingAction: EscalationActionSchema,
  /** Scope at escalation time. */
  scope: ScopeDescriptorV1Schema.optional(),
  /** Timestamp. */
  occurredAt: TimestampSchema,
  schemaVersion: z.literal(1),
}).passthrough();

export type LoopEscalationEvidence = z.infer<typeof LoopEscalationEvidenceSchema>;

// ─── Terminal Outcome ───────────────────────────────────────────

/**
 * Terminal outcome reason for Loop_Guard-driven turn termination.
 * Requirement 7.3: emit structured terminal outcome.
 */
export const LoopGuardTerminalOutcomeSchema = z.object({
  type: z.literal('loop_guard_terminal'),
  /** Unique outcome identity. */
  outcomeId: IdentifierSchema,
  /** Session identity. */
  sessionId: IdentifierSchema,
  /** Turn identity. */
  turnId: IdentifierSchema,
  /** Reason for termination. */
  reason: EscalationReasonSchema,
  /** Escalation evidence leading to termination. */
  evidence: LoopEscalationEvidenceSchema,
  /** Whether additional model steps are blocked. */
  modelStepsBlocked: z.literal(true),
  /** Timestamp. */
  occurredAt: TimestampSchema,
  schemaVersion: z.literal(1),
}).passthrough();

export type LoopGuardTerminalOutcome = z.infer<typeof LoopGuardTerminalOutcomeSchema>;

// ─── Budget Usage Tracking ──────────────────────────────────────

/**
 * Current budget usage snapshot.
 */
export const BudgetUsageSchema = z.object({
  kind: BudgetKindSchema,
  currentUsage: z.number().nonnegative().finite(),
  limit: z.number().positive().finite(),
  unit: z.string().min(1),
  exhausted: z.boolean(),
});

export type BudgetUsage = z.infer<typeof BudgetUsageSchema>;

// ─── Loop Guard Check Result ────────────────────────────────────

/**
 * Result from a Loop_Guard check after a tool call.
 */
export const LoopGuardCheckResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    /** Budgets are not exhausted, no advisory needed. */
  }),
  z.object({
    status: z.literal('advisory'),
    /** Advisory was appended. */
    advisory: LoopAdvisorySchema,
  }),
  z.object({
    status: z.literal('escalation'),
    /** Escalation was triggered. */
    evidence: LoopEscalationEvidenceSchema,
    action: EscalationActionSchema,
  }),
  z.object({
    status: z.literal('terminal'),
    /** Turn must stop — budget exhausted or equivalent calls exhausted grace. */
    outcome: LoopGuardTerminalOutcomeSchema,
  }),
]);

export type LoopGuardCheckResult = z.infer<typeof LoopGuardCheckResultSchema>;
