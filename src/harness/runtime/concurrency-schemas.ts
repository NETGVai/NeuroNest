/**
 * Concurrency Schemas — Bounded tool concurrency and model-order commitment.
 *
 * Defines schemas for immutable call identities, concurrency classification,
 * tool call dispatch records, and ordered result commitment. All structures
 * support model-ordered effect commitment regardless of physical execution order.
 *
 * Requirements: 14.1–14.6, 34.3
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema } from '../contracts/primitives';

// ─── Runtime Concurrency Classification ─────────────────────────

/**
 * Runtime concurrency classification that determines dispatch grouping
 * (Requirement 14.3, 14.6).
 *
 * This is the *resolved* runtime classification, distinct from the tool-registry
 * declared class. It includes `unknown` for tools with absent/incompatible classification.
 *
 * - safe: May run in parallel with other safe calls in the same group.
 * - exclusive: Must run alone as an ordering barrier (Requirement 14.3).
 * - unknown: Treated identically to exclusive — safe fallback (Requirement 14.6).
 */
export const RuntimeConcurrencyClassSchema = z.enum([
  'safe',
  'exclusive',
  'unknown',
]);

export type RuntimeConcurrencyClass = z.infer<typeof RuntimeConcurrencyClassSchema>;

/**
 * Classes that act as barriers — exclusive or unknown (Requirement 14.3, 14.6).
 */
export const BARRIER_CLASSES: ReadonlySet<RuntimeConcurrencyClass> = new Set([
  'exclusive',
  'unknown',
]);

// ─── Tool Call Identity ─────────────────────────────────────────

/**
 * Immutable tool call identity assigned before dispatch (Requirement 14.1).
 *
 * The `modelOrderIndex` preserves the provider-returned tool call order
 * (Requirement 34.3) and determines the commit position for results.
 */
export const ToolCallIdentityV1Schema = z.object({
  /** Unique immutable call identity, assigned monotonically before dispatch. */
  callId: IdentifierSchema,
  /** Turn that owns this call. */
  turnId: IdentifierSchema,
  /** Step within the turn. */
  stepId: IdentifierSchema,
  /** Optional parent call ID for nested tool calls. */
  parentCallId: IdentifierSchema.optional(),
  /** Zero-based model-order index preserving provider-returned order. */
  modelOrderIndex: z.number().int().nonnegative(),
  /** Tool name from the model response. */
  toolName: z.string().min(1),
  /** Tool contract version. */
  toolVersion: IdentifierSchema,
  /** Concurrency class — determines grouping and barrier behavior. */
  concurrencyClass: RuntimeConcurrencyClassSchema,
  /** Assigned at identity creation time. */
  assignedAt: TimestampSchema,
  /** Schema version for forward compatibility. */
  schemaVersion: z.literal(1),
}).passthrough();

export type ToolCallIdentityV1 = z.infer<typeof ToolCallIdentityV1Schema>;

// ─── Call Result State ──────────────────────────────────────────

/**
 * Terminal state of a tool call result (Requirement 14.5).
 */
export const CallResultKindSchema = z.enum([
  /** Call executed successfully and produced a real result. */
  'real',
  /** Call was denied by policy — synthetic result committed. */
  'synthetic_denied',
  /** Call was cancelled before dispatch or during execution. */
  'synthetic_cancelled',
  /** Call was skipped due to a barrier failure (Requirement 14.6). */
  'synthetic_barrier_failure',
  /** Call input validation failed — synthetic structured result. */
  'synthetic_validation_failure',
]);

export type CallResultKind = z.infer<typeof CallResultKindSchema>;

// ─── Committed Result Record ────────────────────────────────────

/**
 * A committed result at a model-order position (Requirement 14.5, 34.3).
 *
 * Exactly one result is committed at each `modelOrderIndex`. Results are
 * committed in model order regardless of physical completion order.
 */
export const CommittedResultV1Schema = z.object({
  /** The call identity this result belongs to. */
  callId: IdentifierSchema,
  /** Model-order position where this result is committed. */
  modelOrderIndex: z.number().int().nonnegative(),
  /** Kind of result — real execution or synthetic. */
  resultKind: CallResultKindSchema,
  /** Optional canonical value ID for real results. */
  canonicalValueId: IdentifierSchema.optional(),
  /** Synthetic reason message (for non-real results). */
  syntheticReason: z.string().optional(),
  /** When this result was committed. */
  committedAt: TimestampSchema,
  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type CommittedResultV1 = z.infer<typeof CommittedResultV1Schema>;

// ─── Dispatch Group ─────────────────────────────────────────────

/**
 * A contiguous group of calls dispatched together (Requirement 14.2, 14.3).
 *
 * - A safe group contains only `safe`-classified calls and executes up to
 *   the configured parallel limit.
 * - A barrier group contains exactly one exclusive/unknown call.
 */
export const DispatchGroupKindSchema = z.enum([
  'parallel_safe',
  'barrier',
]);

export type DispatchGroupKind = z.infer<typeof DispatchGroupKindSchema>;

export const DispatchGroupV1Schema = z.object({
  /** Unique group identity. */
  groupId: IdentifierSchema,
  /** The kind of dispatch group. */
  kind: DispatchGroupKindSchema,
  /** Call IDs in this group (ordered by modelOrderIndex). */
  callIds: z.array(IdentifierSchema).min(1),
  /** Model-order range [start, end] inclusive. */
  modelOrderRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  /** Maximum parallel execution allowed in this group. */
  parallelLimit: z.number().int().positive(),
  /** Schema version. */
  schemaVersion: z.literal(1),
}).passthrough();

export type DispatchGroupV1 = z.infer<typeof DispatchGroupV1Schema>;

// ─── Concurrency Controller Configuration ───────────────────────

/**
 * Configuration for the concurrency controller.
 * The parallel limit comes from Settings_Service (Requirement 14.2).
 */
export const ConcurrencyConfigSchema = z.object({
  /** Maximum number of safe calls executing in parallel. */
  parallelToolLimit: z.number().int().positive().finite(),
});

export type ConcurrencyConfig = z.infer<typeof ConcurrencyConfigSchema>;

// ─── Call Dispatch Request ──────────────────────────────────────

/**
 * Input for scheduling a set of model-emitted tool calls.
 * The calls array preserves the provider-returned order (Requirement 34.3).
 */
export const CallDispatchRequestV1Schema = z.object({
  /** Turn owning these calls. */
  turnId: IdentifierSchema,
  /** Step within the turn. */
  stepId: IdentifierSchema,
  /** Tool calls in provider-returned order. */
  calls: z.array(z.object({
    toolName: z.string().min(1),
    toolVersion: IdentifierSchema,
    concurrencyClass: RuntimeConcurrencyClassSchema,
    parentCallId: IdentifierSchema.optional(),
    arguments: z.unknown(),
  })).min(1),
}).passthrough();

export type CallDispatchRequestV1 = z.infer<typeof CallDispatchRequestV1Schema>;
