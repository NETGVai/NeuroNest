/**
 * Protocol Adapter Types — Canonical type definitions for edge protocol translation.
 *
 * Protocol_Adapter sits at the boundary between external client protocols
 * (Agent_Client_Protocol) and NeuroNest's canonical internal event and tool contracts.
 * External protocol-specific representations never penetrate the canonical domain layer.
 *
 * Every operation entering through an adapter is routed through:
 * - Schema validation (Zod)
 * - Scope_Descriptor resolution
 * - Security policy (Security_Authority)
 * - Approval checks (Collaboration_Service)
 * - Audit recording
 * - Tool controls (Tool_Registry)
 *
 * Requirements: 25.2–25.6
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema } from '../contracts/primitives.js';
import { ScopeDescriptorV1Schema } from '../contracts/scope.js';
import { ActorRefSchema } from '../contracts/actor.js';

// ─── Adapter Identity ───────────────────────────────────────────

/**
 * Each adapter has a stable identity and version for pinning and replay.
 */
export const AdapterIdentitySchema = z.object({
  adapterId: IdentifierSchema,
  adapterName: IdentifierSchema,
  version: z.string().min(1),
  protocolName: IdentifierSchema,
  protocolVersion: z.string().min(1),
  enabledAt: TimestampSchema,
});

export type AdapterIdentity = z.infer<typeof AdapterIdentitySchema>;

// ─── External Protocol Representation ───────────────────────────

/**
 * The raw external protocol message as received from an Agent_Client_Protocol client.
 * This representation is confined to adapter boundaries.
 */
export const ExternalProtocolMessageSchema = z.object({
  /** Protocol-level message identifier */
  protocolMessageId: z.string().min(1),
  /** Protocol method or operation type */
  method: z.string().min(1),
  /** Raw protocol payload (opaque until validated) */
  payload: z.record(z.string(), z.unknown()),
  /** Protocol-level correlation identifier */
  correlationId: z.string().min(1).optional(),
  /** Protocol-level timestamp */
  timestamp: z.string().optional(),
  /** Protocol metadata (headers, transport info) */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ExternalProtocolMessage = z.infer<typeof ExternalProtocolMessageSchema>;

// ─── Canonical Operation ────────────────────────────────────────

/**
 * The canonical internal operation produced by translating an external message.
 * This is what flows into the domain layer after adapter boundary translation.
 */
export const CanonicalOperationSchema = z.object({
  /** Stable operation identifier assigned by the adapter */
  operationId: IdentifierSchema,
  /** The canonical operation type (event, command, tool, prompt, cancellation, progress) */
  operationType: z.enum(['event', 'command', 'tool_call', 'prompt', 'cancellation', 'progress']),
  /** Actor performing the operation */
  actor: ActorRefSchema,
  /** Resolved scope for this operation */
  scope: ScopeDescriptorV1Schema,
  /** Idempotency key for replay safety */
  idempotencyKey: z.string().min(1),
  /** Correlation ID chain for distributed tracing */
  correlationId: IdentifierSchema,
  /** The translated canonical payload */
  canonicalPayload: z.record(z.string(), z.unknown()),
  /** Source adapter identity for provenance */
  sourceAdapterId: IdentifierSchema,
  /** Source adapter version for pinning */
  sourceAdapterVersion: z.string().min(1),
  /** Timestamp of canonical translation */
  translatedAt: TimestampSchema,
  /** Original protocol message ID for audit trail */
  sourceProtocolMessageId: z.string().min(1),
});

export type CanonicalOperation = z.infer<typeof CanonicalOperationSchema>;

// ─── Required Safety Fields ─────────────────────────────────────

/**
 * Fields that MUST be present after translation. If the external protocol
 * cannot represent any of these, the adapter MUST reject the operation or
 * use a documented lossless extension.
 */
export const REQUIRED_SAFETY_FIELDS = [
  'operationId',
  'operationType',
  'actor',
  'scope',
  'idempotencyKey',
  'correlationId',
  'sourceAdapterId',
  'sourceAdapterVersion',
] as const;

export type RequiredSafetyField = (typeof REQUIRED_SAFETY_FIELDS)[number];

// ─── Pipeline Stage Results ─────────────────────────────────────

export type PipelineStage =
  | 'schema_validation'
  | 'scope_resolution'
  | 'security_policy'
  | 'approval_check'
  | 'audit_recording'
  | 'tool_control';

export const PipelineStageResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('passed'),
    stage: z.string(),
    durationMs: z.number().nonnegative(),
  }),
  z.object({
    outcome: z.literal('rejected'),
    stage: z.string(),
    reason: z.string(),
    durationMs: z.number().nonnegative(),
  }),
]);

export type PipelineStageResult = z.infer<typeof PipelineStageResultSchema>;

// ─── Adapter Operation Result ───────────────────────────────────

export const AdapterOperationResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('dispatched'),
    operationId: IdentifierSchema,
    correlationId: IdentifierSchema,
    pipelineResults: z.array(PipelineStageResultSchema),
  }),
  z.object({
    status: z.literal('rejected'),
    operationId: IdentifierSchema.optional(),
    correlationId: IdentifierSchema.optional(),
    stage: z.string(),
    reason: z.string(),
    pipelineResults: z.array(PipelineStageResultSchema),
  }),
  z.object({
    status: z.literal('lossless_extension_required'),
    operationId: IdentifierSchema.optional(),
    missingFields: z.array(z.string()),
    documentedExtension: z.string().optional(),
  }),
]);

export type AdapterOperationResult = z.infer<typeof AdapterOperationResultSchema>;

// ─── Lifecycle Hook Types ───────────────────────────────────────

/**
 * Lifecycle hook phases for external integration points.
 */
export type LifecycleHookPhase =
  | 'pre_request'
  | 'post_response'
  | 'error'
  | 'cancellation';

export const LifecycleHookRegistrationSchema = z.object({
  hookId: IdentifierSchema,
  phase: z.enum(['pre_request', 'post_response', 'error', 'cancellation']),
  adapterId: IdentifierSchema,
  /** Whether this hook is currently enabled */
  enabled: z.boolean(),
  /** Priority for execution ordering (lower = earlier) */
  priority: z.number().int().nonnegative(),
  /** Description of what this hook does */
  description: z.string().optional(),
  /** Schema version of the hook contract */
  schemaVersion: z.literal(1),
});

export type LifecycleHookRegistration = z.infer<typeof LifecycleHookRegistrationSchema>;

/**
 * The context provided to lifecycle hooks. Translated into canonical observe
 * or command events — never raw protocol data.
 */
export const LifecycleHookContextSchema = z.object({
  hookId: IdentifierSchema,
  phase: z.enum(['pre_request', 'post_response', 'error', 'cancellation']),
  operationId: IdentifierSchema,
  correlationId: IdentifierSchema,
  actor: ActorRefSchema,
  scope: ScopeDescriptorV1Schema,
  timestamp: TimestampSchema,
  /** Canonical event or command data (never raw protocol) */
  canonicalData: z.record(z.string(), z.unknown()),
});

export type LifecycleHookContext = z.infer<typeof LifecycleHookContextSchema>;

/**
 * Result from a lifecycle hook execution.
 */
export const LifecycleHookResultSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('continue'),
    hookId: IdentifierSchema,
    phase: z.enum(['pre_request', 'post_response', 'error', 'cancellation']),
    emittedEvents: z.array(z.record(z.string(), z.unknown())).optional(),
  }),
  z.object({
    action: z.literal('reject'),
    hookId: IdentifierSchema,
    phase: z.enum(['pre_request', 'post_response', 'error', 'cancellation']),
    reason: z.string(),
  }),
  z.object({
    action: z.literal('observe'),
    hookId: IdentifierSchema,
    phase: z.enum(['pre_request', 'post_response', 'error', 'cancellation']),
    observationEvent: z.record(z.string(), z.unknown()),
  }),
]);

export type LifecycleHookResult = z.infer<typeof LifecycleHookResultSchema>;

// ─── Lossless Extension ─────────────────────────────────────────

/**
 * When an external protocol cannot represent a required field, the adapter
 * may use a documented lossless extension rather than rejecting outright.
 */
export const LosslessExtensionSchema = z.object({
  extensionName: IdentifierSchema,
  /** Which required fields this extension provides */
  providedFields: z.array(z.string()).min(1),
  /** Documentation reference for the extension format */
  documentationRef: z.string().min(1),
  /** Schema version of the extension */
  schemaVersion: z.literal(1),
});

export type LosslessExtension = z.infer<typeof LosslessExtensionSchema>;

// ─── Audit Record ───────────────────────────────────────────────

export const AdapterAuditRecordSchema = z.object({
  auditId: IdentifierSchema,
  adapterId: IdentifierSchema,
  operationId: IdentifierSchema,
  correlationId: IdentifierSchema,
  actor: ActorRefSchema,
  scope: ScopeDescriptorV1Schema,
  operationType: z.string(),
  stage: z.string(),
  outcome: z.enum(['passed', 'rejected', 'error']),
  reason: z.string().optional(),
  timestamp: TimestampSchema,
});

export type AdapterAuditRecord = z.infer<typeof AdapterAuditRecordSchema>;

// ─── Protocol Adapter Configuration ─────────────────────────────

export const ProtocolAdapterConfigSchema = z.object({
  /** Adapter identity */
  identity: AdapterIdentitySchema,
  /** Whether the adapter is enabled */
  enabled: z.boolean(),
  /** Registered lossless extensions for this adapter */
  losslessExtensions: z.array(LosslessExtensionSchema).default([]),
  /** Maximum operations per second (rate limiting) */
  maxOperationsPerSecond: z.number().positive().optional(),
});

export type ProtocolAdapterConfig = z.infer<typeof ProtocolAdapterConfigSchema>;
