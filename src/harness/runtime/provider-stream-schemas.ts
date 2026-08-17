/**
 * Provider Stream Schemas — Route resolution, adapter pinning, stream semantics,
 * and Completion_Anchor contracts for provider-neutral streaming.
 *
 * Defines the canonical Zod schemas for:
 * - Resolved route with pinned adapter version, model, capabilities, and capacity
 * - Required stream block semantics declaration
 * - Lossy route rejection reasons
 * - Empty response classification
 * - Completion_Anchor binding
 * - Hot swap version records
 *
 * Requirements: 16.1–16.8
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema, IntegrityHashSchema } from '../contracts/primitives';

// ─── Route Capabilities ─────────────────────────────────────────

/**
 * The set of stream block semantics a route can support.
 * A route is lossy if it cannot faithfully represent all required semantics.
 */
export const StreamBlockSemanticSchema = z.enum([
  'text_content',
  'code_content',
  'markdown_content',
  'reasoning',
  'tool_call_delta',
  'tool_call_completion',
  'usage_reporting',
  'finish_reason',
  'refusal',
  'error',
]);

export type StreamBlockSemantic = z.infer<typeof StreamBlockSemanticSchema>;

/**
 * Adapter capabilities: what block semantics the adapter can translate.
 */
export const AdapterCapabilitiesSchema = z.object({
  adapterId: IdentifierSchema,
  adapterVersion: IdentifierSchema,
  supportedSemantics: z.array(StreamBlockSemanticSchema),
  supportsStreaming: z.boolean(),
  supportsReasoning: z.boolean(),
  supportsToolCalls: z.boolean(),
  supportsUsageReporting: z.boolean(),
}).passthrough();

export type AdapterCapabilities = z.infer<typeof AdapterCapabilitiesSchema>;

// ─── Resolved Route ─────────────────────────────────────────────

/**
 * A fully resolved and validated route ready for request dispatch.
 * Contains all pinning information needed to durably lock a request.
 */
export const ResolvedRouteSchema = z.object({
  /** Unique route resolution identity */
  routeId: IdentifierSchema,
  /** Provider identity */
  providerId: IdentifierSchema,
  /** Model identity at the provider */
  modelId: IdentifierSchema,
  /** Adapter identity and version */
  adapterId: IdentifierSchema,
  adapterVersion: IdentifierSchema,
  /** Model capabilities */
  capabilities: z.object({
    toolCalling: z.boolean(),
    structuredOutput: z.boolean(),
    reasoning: z.boolean(),
    imageInput: z.boolean(),
    streaming: z.boolean(),
  }).passthrough(),
  /** Context capacity in tokens */
  contextCapacity: z.number().int().positive().finite(),
  /** Route defaults (temperature, top_p, etc.) */
  routeDefaults: z.record(z.string(), z.unknown()).optional(),
  /** Timestamp when this route was resolved */
  resolvedAt: TimestampSchema,
}).passthrough();

export type ResolvedRoute = z.infer<typeof ResolvedRouteSchema>;

// ─── Pinned Route Record ────────────────────────────────────────

/**
 * A durable record that pins a resolved route to a specific request.
 * Once pinned, the route/adapter version cannot change for that request.
 */
export const PinnedRouteRecordSchema = z.object({
  /** Request identity this route is pinned to */
  requestId: IdentifierSchema,
  /** The pinned route */
  route: ResolvedRouteSchema,
  /** Timestamp when pinning occurred */
  pinnedAt: TimestampSchema,
  /** Whether this pin was active when the request completed */
  completed: z.boolean().default(false),
  /** Completion timestamp if completed */
  completedAt: TimestampSchema.optional(),
}).passthrough();

export type PinnedRouteRecord = z.infer<typeof PinnedRouteRecordSchema>;

// ─── Required Semantics Declaration ─────────────────────────────

/**
 * Declares the required stream block semantics for a request.
 * Used to validate that a route can faithfully represent all needed blocks.
 */
export const RequiredSemanticsSchema = z.object({
  /** The set of semantics the request requires */
  required: z.array(StreamBlockSemanticSchema).min(1),
  /** Optional preferred (non-required) semantics */
  preferred: z.array(StreamBlockSemanticSchema).optional(),
}).passthrough();

export type RequiredSemantics = z.infer<typeof RequiredSemanticsSchema>;

// ─── Lossy Route Rejection ──────────────────────────────────────

/**
 * Describes why a route was rejected as lossy.
 */
export const LossyRouteRejectionSchema = z.object({
  /** The route that was rejected */
  routeId: IdentifierSchema,
  providerId: IdentifierSchema,
  modelId: IdentifierSchema,
  adapterId: IdentifierSchema,
  /** The semantics that cannot be faithfully represented */
  missingSemantics: z.array(StreamBlockSemanticSchema).min(1),
  /** Human-readable reason */
  reason: z.string(),
  /** Timestamp of rejection */
  rejectedAt: TimestampSchema,
}).passthrough();

export type LossyRouteRejection = z.infer<typeof LossyRouteRejectionSchema>;

// ─── Empty Response Classification ──────────────────────────────

/**
 * Classification of an empty response (no content, tool calls, refusal, or terminal reason).
 */
export const EmptyResponseClassificationSchema = z.object({
  /** Request identity */
  requestId: IdentifierSchema,
  /** Route that produced the empty response */
  routeId: IdentifierSchema,
  /** Whether the provider reported a finish reason */
  hasFinishReason: z.boolean(),
  /** The finish reason if reported */
  finishReason: z.string().optional(),
  /** Whether any content blocks were received */
  hasContentBlocks: z.boolean(),
  /** Whether any tool calls were received */
  hasToolCalls: z.boolean(),
  /** Whether a refusal was received */
  hasRefusal: z.boolean(),
  /** Classified error code */
  errorCode: z.literal('empty_response'),
  /** Timestamp of classification */
  classifiedAt: TimestampSchema,
}).passthrough();

export type EmptyResponseClassification = z.infer<typeof EmptyResponseClassificationSchema>;

// ─── Completion Anchor ──────────────────────────────────────────

/**
 * Immutable identity appended at stream end linking a response to its request.
 * Binds Prompt_Fingerprint, route identity, request identity, and final block sequence.
 */
export const CompletionAnchorSchema = z.object({
  /** Unique anchor identity */
  anchorId: IdentifierSchema,
  /** Request that produced this completion */
  requestId: IdentifierSchema,
  /** Prompt fingerprint that produced this request */
  promptFingerprint: IntegrityHashSchema,
  /** Route identity used for this completion */
  routeId: IdentifierSchema,
  /** Provider identity */
  providerId: IdentifierSchema,
  /** Model identity */
  modelId: IdentifierSchema,
  /** Final content-block sequence number */
  finalBlockSequence: z.number().int().nonnegative(),
  /** Finish reason from provider */
  finishReason: z.enum(['stop', 'tool_use', 'length', 'content_filter', 'error']),
  /** Timestamp of anchor creation */
  anchoredAt: TimestampSchema,
}).passthrough();

export type CompletionAnchor = z.infer<typeof CompletionAnchorSchema>;

// ─── Hot Swap Record ────────────────────────────────────────────

/**
 * Records a hot swap event. Hot swaps affect only requests created AFTER the swap.
 * In-flight requests retain their pinned route/adapter.
 */
export const HotSwapRecordSchema = z.object({
  /** Unique swap identity */
  swapId: IdentifierSchema,
  /** Previous adapter version */
  previousAdapterVersion: IdentifierSchema,
  /** New adapter version */
  newAdapterVersion: IdentifierSchema,
  /** Previous route configuration (if route changed) */
  previousRouteId: IdentifierSchema.optional(),
  /** New route configuration (if route changed) */
  newRouteId: IdentifierSchema.optional(),
  /** Timestamp when the swap was applied */
  swappedAt: TimestampSchema,
  /** Active request IDs at time of swap (these retain old pinning) */
  activeRequestIds: z.array(IdentifierSchema),
}).passthrough();

export type HotSwapRecord = z.infer<typeof HotSwapRecordSchema>;

// ─── Provider Stream Request ────────────────────────────────────

/**
 * Complete provider stream request encompassing route, semantics, and correlation.
 */
export const ProviderStreamRequestSchema = z.object({
  /** Unique request identity */
  requestId: IdentifierSchema,
  /** Session context */
  sessionId: IdentifierSchema,
  /** Turn context */
  turnId: IdentifierSchema,
  /** Prompt fingerprint for reconstruction */
  promptFingerprint: IntegrityHashSchema,
  /** Required stream block semantics */
  requiredSemantics: RequiredSemanticsSchema,
  /** Timestamp of request creation */
  createdAt: TimestampSchema,
}).passthrough();

export type ProviderStreamRequest = z.infer<typeof ProviderStreamRequestSchema>;

// ─── Stream Completion Result ───────────────────────────────────

export const StreamCompletionResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('completed'),
    requestId: IdentifierSchema,
    anchor: CompletionAnchorSchema,
    blockCount: z.number().int().nonnegative(),
    completedAt: TimestampSchema,
  }).passthrough(),
  z.object({
    status: z.literal('empty_response'),
    requestId: IdentifierSchema,
    classification: EmptyResponseClassificationSchema,
  }).passthrough(),
  z.object({
    status: z.literal('error'),
    requestId: IdentifierSchema,
    errorCode: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    occurredAt: TimestampSchema,
  }).passthrough(),
  z.object({
    status: z.literal('rejected'),
    requestId: IdentifierSchema,
    rejection: LossyRouteRejectionSchema,
  }).passthrough(),
]);

export type StreamCompletionResult = z.infer<typeof StreamCompletionResultSchema>;
