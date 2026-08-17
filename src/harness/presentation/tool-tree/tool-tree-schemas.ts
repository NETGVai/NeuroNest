/**
 * Tool Tree Schemas — Structured tool tree projection and inspection contracts.
 *
 * Defines the schemas for:
 * - ToolTreeProjectionV1: The projected call tree with verified lineage
 * - ToolInspectionV1: Bounded redacted inspector data
 * - ToolTreeQuery: Query parameters for call tree projection
 * - ToolInspectionQuery: Query parameters for call inspection
 * - AuthorizedRangeQuery: Authorized spill range retrieval parameters
 * - BoundedRangeV1: Bounded range response from spill retrieval
 *
 * Requirements: 37.1–37.17
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema, SequenceSchema } from '../../contracts/primitives';
import { RenderIntentV1Schema } from '../../contracts/render-intent';

// ─── Lineage Verification Status ────────────────────────────────

/**
 * Whether a call's parent-child relationship has been verified as valid.
 * - 'verified': call lineage is confirmed valid
 * - 'unverified': parent edge could not be confirmed (cycles, missing parents, incompatible)
 * - 'root': call has no parent (top-level)
 */
export const LineageStatusSchema = z.enum(['verified', 'unverified', 'root']);
export type LineageStatus = z.infer<typeof LineageStatusSchema>;

// ─── Call Status ────────────────────────────────────────────────

export const CallStatusSchema = z.enum([
  'planned',
  'executing',
  'completed',
  'failed',
  'cancelled',
  'retrying',
]);
export type CallStatus = z.infer<typeof CallStatusSchema>;

// ─── Risk Class (display only) ──────────────────────────────────

export const DisplayRiskClassSchema = z.enum([
  'read-only',
  'idempotent-write',
  'write',
  'execute',
  'destructive',
]);
export type DisplayRiskClass = z.infer<typeof DisplayRiskClassSchema>;

// ─── Typed Failure ──────────────────────────────────────────────

export const TypedFailureSchema = z.object({
  errorClass: z.string().min(1),
  message: z.string(),
  redacted: z.boolean(),
  retryEligible: z.boolean(),
  nextAction: z.string().optional(),
}).passthrough();
export type TypedFailure = z.infer<typeof TypedFailureSchema>;

// ─── Spill Range Reference ──────────────────────────────────────

export const SpillRangeRefSchema = z.object({
  spillId: IdentifierSchema,
  totalBytes: z.number().int().nonnegative().finite(),
  previewBytes: z.number().int().nonnegative().finite(),
  available: z.boolean(),
}).passthrough();
export type SpillRangeRef = z.infer<typeof SpillRangeRefSchema>;

// ─── Authorized Action ──────────────────────────────────────────

/**
 * An action the inspector can expose, routed through its owning authority.
 * Actions that become unavailable carry a redacted reason.
 */
export const AuthorizedActionSchema = z.object({
  actionId: IdentifierSchema,
  kind: z.enum(['open_file', 'citation', 'spill_retrieve', 'retry', 'cancel']),
  label: z.string(),
  authority: IdentifierSchema,
  available: z.boolean(),
  unavailableReason: z.string().optional(),
}).passthrough();
export type AuthorizedAction = z.infer<typeof AuthorizedActionSchema>;

// ─── Projected Tool Call Node ───────────────────────────────────

/**
 * A single projected tool call in the tree. Immutable callId serves as identity.
 * Model-order index determines render order.
 *
 * Requirements: 37.1, 37.2, 37.14, 37.15
 */
export const ProjectedToolCallSchema = z.object({
  /** Immutable call identity. */
  callId: IdentifierSchema,
  /** Optional parent call identity. Null for root calls. */
  parentCallId: z.string().nullable(),
  /** Position in model order. */
  modelOrderIndex: z.number().int().nonnegative(),
  /** Tool display name (metadata only, never used for rendering dispatch). */
  toolDisplayName: z.string(),
  /** Current call status. */
  status: CallStatusSchema,
  /** Risk classification for display. */
  riskClass: DisplayRiskClassSchema,
  /** Duration in milliseconds (null if not yet completed). */
  durationMs: z.number().nonnegative().finite().nullable(),
  /** Current attempt number (1-based). */
  attempt: z.number().int().positive(),
  /** Owner identity. */
  owner: IdentifierSchema,
  /** Lineage verification status. */
  lineageStatus: LineageStatusSchema,
  /** Render intent for structured view selection. */
  renderIntent: RenderIntentV1Schema.optional(),
  /** Whether there are child calls. */
  hasChildren: z.boolean(),
  /** Typed failure info if status is 'failed'. */
  failure: TypedFailureSchema.optional(),
}).passthrough();

export type ProjectedToolCall = z.infer<typeof ProjectedToolCallSchema>;

// ─── Tool Tree Projection V1 ────────────────────────────────────

/**
 * The complete projected call tree for a turn or scope.
 * Calls are ordered by modelOrderIndex. Verified children are nested
 * under their parent; unverified calls appear at root level in model order.
 *
 * Requirements: 37.1, 37.14, 37.15
 */
export const ToolTreeProjectionV1Schema = z.object({
  /** Session the tree belongs to. */
  sessionId: IdentifierSchema,
  /** Turn the tree belongs to (optional for cross-turn queries). */
  turnId: IdentifierSchema.optional(),
  /** All projected calls in model order. */
  calls: z.array(ProjectedToolCallSchema),
  /** Root calls (no verified parent). */
  rootCallIds: z.array(IdentifierSchema),
  /** Map of parentCallId → ordered childCallIds for verified lineage. */
  childMap: z.record(z.string(), z.array(IdentifierSchema)),
  /** Projection revision for incremental updates. */
  projectionRevision: z.number().int().nonnegative(),
  /** Whether any calls had malformed/incompatible lineage (model-ordered fallback used). */
  usedFallbackOrdering: z.boolean(),
  schemaVersion: z.literal(1),
}).passthrough();

export type ToolTreeProjectionV1 = z.infer<typeof ToolTreeProjectionV1Schema>;

// ─── Tool Tree Query ────────────────────────────────────────────

export const ToolTreeQuerySchema = z.object({
  sessionId: IdentifierSchema,
  turnId: IdentifierSchema.optional(),
  /** Optional: filter to calls under a specific parent. */
  parentCallId: IdentifierSchema.optional(),
  /** Maximum depth to project. */
  maxDepth: z.number().int().positive().finite().optional(),
}).passthrough();

export type ToolTreeQuery = z.infer<typeof ToolTreeQuerySchema>;

// ─── Inspector Selection ────────────────────────────────────────

/**
 * Selection state for the tool inspector.
 * Combines call identity, result identity, and source sequence.
 *
 * Requirements: 37.7
 */
export const InspectorSelectionSchema = z.object({
  callId: IdentifierSchema,
  resultId: IdentifierSchema.optional(),
  sourceSequence: SequenceSchema,
}).passthrough();

export type InspectorSelection = z.infer<typeof InspectorSelectionSchema>;

// ─── Tool Inspection V1 ─────────────────────────────────────────

/**
 * Bounded redacted inspection data for a selected tool call.
 * Exposes arguments, output, attempts, risk, owner, duration, spill ranges,
 * authorized source/citation actions, and typed failures.
 *
 * All content respects configured byte and line bounds.
 * Secrets, protected content, private paths, and unauthorized locators are omitted.
 *
 * Requirements: 37.3, 37.4, 37.7–37.13, 37.16, 37.17
 */
export const ToolInspectionV1Schema = z.object({
  /** The selection this inspection responds to. */
  selection: InspectorSelectionSchema,
  /** Tool display name (metadata only). */
  toolDisplayName: z.string(),
  /** Redacted normalized arguments within byte/line bounds. */
  redactedArguments: z.string().nullable(),
  /** Whether arguments were truncated to bounds. */
  argumentsTruncated: z.boolean(),
  /** Byte size of the bounded argument preview. */
  argumentsPreviewBytes: z.number().int().nonnegative(),
  /** Redacted output preview within bounds. */
  redactedOutput: z.string().nullable(),
  /** Whether output was truncated. */
  outputTruncated: z.boolean(),
  /** Byte size of the bounded output preview. */
  outputPreviewBytes: z.number().int().nonnegative(),
  /** Output retained status. */
  outputRetainedStatus: z.enum(['retained', 'spilled', 'discarded', 'pending']),
  /** Spill range reference if output was spilled. */
  spillRange: SpillRangeRefSchema.optional(),
  /** Current attempt number. */
  attempt: z.number().int().positive(),
  /** Full attempt history (bounded). */
  attemptHistory: z.array(z.object({
    attempt: z.number().int().positive(),
    status: CallStatusSchema,
    durationMs: z.number().nonnegative().finite().nullable(),
    failure: TypedFailureSchema.optional(),
    timestamp: TimestampSchema,
  }).passthrough()),
  /** Risk classification. */
  riskClass: DisplayRiskClassSchema,
  /** Owner identity. */
  owner: IdentifierSchema,
  /** Duration in milliseconds. */
  durationMs: z.number().nonnegative().finite().nullable(),
  /** Redaction reason if content was redacted. */
  redactionReason: z.string().optional(),
  /** Authorized actions (open file, citations, spill retrieval, etc.). */
  authorizedActions: z.array(AuthorizedActionSchema),
  /** Typed failure if the call failed. */
  failure: TypedFailureSchema.optional(),
  /** Render intent for structured view. */
  renderIntent: RenderIntentV1Schema.optional(),
  schemaVersion: z.literal(1),
}).passthrough();

export type ToolInspectionV1 = z.infer<typeof ToolInspectionV1Schema>;

// ─── Tool Inspection Query ──────────────────────────────────────

export const ToolInspectionQuerySchema = z.object({
  /** The call to inspect. */
  callId: IdentifierSchema,
  /** Optional specific result identity. */
  resultId: IdentifierSchema.optional(),
  /** Source sequence for correlation. */
  sourceSequence: SequenceSchema,
  /** Maximum bytes for argument preview. */
  maxArgumentBytes: z.number().int().positive().finite().optional(),
  /** Maximum lines for argument preview. */
  maxArgumentLines: z.number().int().positive().finite().optional(),
  /** Maximum bytes for output preview. */
  maxOutputBytes: z.number().int().positive().finite().optional(),
  /** Maximum lines for output preview. */
  maxOutputLines: z.number().int().positive().finite().optional(),
}).passthrough();

export type ToolInspectionQuery = z.infer<typeof ToolInspectionQuerySchema>;

// ─── Authorized Range Query ─────────────────────────────────────

/**
 * Query for authorized spill range retrieval.
 *
 * Requirements: 37.8
 */
export const AuthorizedRangeQuerySchema = z.object({
  /** Spill identity. */
  spillId: IdentifierSchema,
  /** Start byte offset. */
  startByte: z.number().int().nonnegative().finite(),
  /** End byte offset (exclusive). */
  endByte: z.number().int().positive().finite(),
  /** Authorization token from the owning authority. */
  authorizationToken: IdentifierSchema,
}).passthrough();

export type AuthorizedRangeQuery = z.infer<typeof AuthorizedRangeQuerySchema>;

// ─── Bounded Range V1 ───────────────────────────────────────────

/**
 * Response from spill range retrieval.
 * Labels retrieved vs unavailable ranges.
 *
 * Requirements: 37.8
 */
export const BoundedRangeV1Schema = z.object({
  spillId: IdentifierSchema,
  /** Retrieved content (may be partial). */
  content: z.string(),
  /** Start byte of retrieved range. */
  startByte: z.number().int().nonnegative().finite(),
  /** End byte of retrieved range (exclusive). */
  endByte: z.number().int().nonnegative().finite(),
  /** Total available bytes. */
  totalBytes: z.number().int().nonnegative().finite(),
  /** Whether the full requested range was available. */
  complete: z.boolean(),
  /** Unavailable ranges within the request. */
  unavailableRanges: z.array(z.object({
    startByte: z.number().int().nonnegative().finite(),
    endByte: z.number().int().nonnegative().finite(),
    reason: z.string(),
  })).default([]),
  schemaVersion: z.literal(1),
}).passthrough();

export type BoundedRangeV1 = z.infer<typeof BoundedRangeV1Schema>;
