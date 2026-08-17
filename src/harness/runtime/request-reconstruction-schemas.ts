/**
 * Request Reconstruction Schemas
 *
 * Zod schemas and TypeScript types for rebuilding provider-neutral prompts,
 * ordered tools, route/adapter versions, and attachments from durable records.
 * These schemas define the contracts for exact-retry preflight verification.
 *
 * Requirements: 34.1–34.2, 44.4–44.6, 44.8, 44.12, 44.14
 */

import { z } from 'zod';
import { IdentifierSchema, IntegrityHashSchema, TimestampSchema } from '../contracts/primitives.js';

// ─── Prompt Section ─────────────────────────────────────────────

/**
 * A named prompt section as persisted in durable records.
 * Sections are assembled in stable order by Prompt_Assembler.
 */
export const PromptSectionV1Schema = z.object({
  sectionName: IdentifierSchema,
  ordinal: z.number().int().nonnegative(),
  content: z.string(),
  variables: z.record(z.string(), z.string()).default({}),
  scopeOverrides: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

export type PromptSectionV1 = z.infer<typeof PromptSectionV1Schema>;

// ─── Ordered Tool Schema ────────────────────────────────────────

/**
 * A normalized tool schema reference as included in the original request.
 */
export const OrderedToolSchemaV1Schema = z.object({
  toolName: IdentifierSchema,
  toolVersion: IdentifierSchema,
  schemaHash: IntegrityHashSchema,
  ordinal: z.number().int().nonnegative(),
  concurrencyClass: z.string().optional(),
  policyMetadata: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

export type OrderedToolSchemaV1 = z.infer<typeof OrderedToolSchemaV1Schema>;

// ─── Route Decision ─────────────────────────────────────────────

/**
 * The pinned route/adapter version decision from the original request.
 */
export const RouteDecisionV1Schema = z.object({
  routeId: IdentifierSchema,
  modelId: IdentifierSchema,
  adapterId: IdentifierSchema,
  adapterVersion: IdentifierSchema,
  providerName: IdentifierSchema,
  capacityTokens: z.number().int().positive(),
  pinnedAt: TimestampSchema,
}).passthrough();

export type RouteDecisionV1 = z.infer<typeof RouteDecisionV1Schema>;

// ─── Attachment Reference ───────────────────────────────────────

/**
 * An immutable attachment reference as included in the original request.
 */
export const AttachmentReferenceV1Schema = z.object({
  attachmentId: IdentifierSchema,
  contentHash: IntegrityHashSchema,
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
}).passthrough();

export type AttachmentReferenceV1 = z.infer<typeof AttachmentReferenceV1Schema>;

// ─── Reconstructed Request ──────────────────────────────────────

/**
 * The complete reconstructed request rebuilt from durable Session_Log records.
 * This is the provider-neutral prompt with all original inputs needed for
 * exact retry.
 */
export const ReconstructedRequestV1Schema = z.object({
  /** The Completion_Anchor identity this reconstruction targets */
  anchorId: IdentifierSchema,
  /** The session and branch context */
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  /** Prompt sections in stable assembly order */
  sections: z.array(PromptSectionV1Schema).min(1),
  /** Ordered tool schemas as normalized at assembly time */
  tools: z.array(OrderedToolSchemaV1Schema),
  /** The pinned route decision from the original dispatch */
  routeDecision: RouteDecisionV1Schema,
  /** Attachment references included in the original request */
  attachments: z.array(AttachmentReferenceV1Schema),
  /** The Prompt_Fingerprint computed before original provider dispatch */
  promptFingerprint: IntegrityHashSchema,
  /** Assembly version used for deterministic reconstruction */
  assemblyVersion: IdentifierSchema,
  /** Source sequence in the Session_Log where the original request was recorded */
  sourceSequence: z.number().int().nonnegative(),
  /** Timestamp of reconstruction */
  reconstructedAt: TimestampSchema,
}).passthrough();

export type ReconstructedRequestV1 = z.infer<typeof ReconstructedRequestV1Schema>;

// ─── Preflight Check Categories ─────────────────────────────────

/**
 * The categories of preflight verification performed before exact retry dispatch.
 */
export const PreflightCheckKindSchema = z.enum([
  'fingerprint',
  'route_availability',
  'adapter_compatibility',
  'tool_compatibility',
  'attachment_availability',
  'policy_compliance',
  'budget_eligibility',
  'capacity_fit',
]);

export type PreflightCheckKind = z.infer<typeof PreflightCheckKindSchema>;

// ─── Preflight Check Result ─────────────────────────────────────

/**
 * The result of a single preflight verification check.
 */
export const PreflightCheckResultV1Schema = z.object({
  kind: PreflightCheckKindSchema,
  passed: z.boolean(),
  reason: z.string().optional(),
  details: z.record(z.string(), z.unknown()).default({}),
  checkedAt: TimestampSchema,
}).passthrough();

export type PreflightCheckResultV1 = z.infer<typeof PreflightCheckResultV1Schema>;

// ─── Retry Block Reason ─────────────────────────────────────────

/**
 * A structured reason describing why exact retry is blocked.
 * Surfaced in the Chat_Interface when the action is unavailable.
 */
export const RetryBlockReasonV1Schema = z.object({
  /** Which check failed */
  checkKind: PreflightCheckKindSchema,
  /** Human-readable reason for the block */
  message: z.string().min(1),
  /** Machine-readable code for the block */
  code: z.enum([
    'FINGERPRINT_MISMATCH',
    'ROUTE_UNAVAILABLE',
    'ADAPTER_INCOMPATIBLE',
    'TOOL_SCHEMA_CHANGED',
    'TOOL_REMOVED',
    'ATTACHMENT_UNRESOLVABLE',
    'POLICY_DENIED',
    'BUDGET_EXHAUSTED',
    'CAPACITY_EXCEEDED',
    'RECONSTRUCTION_FAILED',
  ]),
  /** Additional details for diagnostics */
  details: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

export type RetryBlockReasonV1 = z.infer<typeof RetryBlockReasonV1Schema>;

// ─── Exact Retry Preflight Result ───────────────────────────────

/**
 * The aggregate result of all preflight checks for an exact retry.
 * If any check fails, the retry is blocked.
 */
export const ExactRetryPreflightResultV1Schema = z.object({
  /** The anchor being retried */
  anchorId: IdentifierSchema,
  /** The prompt fingerprint being verified */
  promptFingerprint: IntegrityHashSchema,
  /** All checks performed */
  checks: z.array(PreflightCheckResultV1Schema),
  /** Whether all checks passed and dispatch is allowed */
  canDispatch: z.boolean(),
  /** Block reasons if dispatch is not allowed */
  blockReasons: z.array(RetryBlockReasonV1Schema),
  /** Timestamp of the preflight evaluation */
  evaluatedAt: TimestampSchema,
}).passthrough();

export type ExactRetryPreflightResultV1 = z.infer<typeof ExactRetryPreflightResultV1Schema>;

// ─── Reconstruction Input ───────────────────────────────────────

/**
 * Input needed to initiate request reconstruction from durable records.
 */
export const ReconstructionInputV1Schema = z.object({
  /** The Completion_Anchor identity to reconstruct */
  anchorId: IdentifierSchema,
  /** Session context */
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
}).passthrough();

export type ReconstructionInputV1 = z.infer<typeof ReconstructionInputV1Schema>;
