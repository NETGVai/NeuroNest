/**
 * Provider Block V1
 *
 * Typed provider-neutral stream blocks representing content, reasoning,
 * tool calls, usage, completion anchors, and errors from a model provider.
 *
 * Requirements: 16.1, 34.6
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema, IntegrityHashSchema } from './primitives';

/** Content block from the model. */
export const ContentBlockV1Schema = z.object({
  kind: z.literal('content'),
  blockId: IdentifierSchema,
  contentType: z.enum(['text', 'code', 'markdown']),
  text: z.string(),
  isFinal: z.boolean(),
}).passthrough();

/** Reasoning/thinking reference block. */
export const ReasoningBlockV1Schema = z.object({
  kind: z.literal('reasoning'),
  blockId: IdentifierSchema,
  summary: z.string().optional(),
  redacted: z.boolean().default(true),
}).passthrough();

/** Tool call block from the model. */
export const ToolCallBlockV1Schema = z.object({
  kind: z.literal('tool_call'),
  blockId: IdentifierSchema,
  callId: IdentifierSchema,
  toolName: IdentifierSchema,
  arguments: z.string(),
  modelOrderIndex: z.number().int().nonnegative(),
}).passthrough();

/** Usage accounting block. */
export const UsageBlockV1Schema = z.object({
  kind: z.literal('usage'),
  blockId: IdentifierSchema,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative(),
}).passthrough();

/** Completion anchor block marking a complete assistant response. */
export const CompletionAnchorBlockV1Schema = z.object({
  kind: z.literal('completion_anchor'),
  blockId: IdentifierSchema,
  anchorId: IdentifierSchema,
  promptFingerprint: IntegrityHashSchema,
  finishReason: z.enum(['stop', 'tool_use', 'length', 'content_filter', 'error']),
}).passthrough();

/** Error block from the provider. */
export const ProviderErrorBlockV1Schema = z.object({
  kind: z.literal('error'),
  blockId: IdentifierSchema,
  errorCode: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  routeId: IdentifierSchema.optional(),
}).passthrough();

/** Discriminated union of all provider stream block types. */
export const ProviderBlockV1Schema = z.discriminatedUnion('kind', [
  ContentBlockV1Schema,
  ReasoningBlockV1Schema,
  ToolCallBlockV1Schema,
  UsageBlockV1Schema,
  CompletionAnchorBlockV1Schema,
  ProviderErrorBlockV1Schema,
]);

/** A complete provider block envelope for persistence. */
export const ProviderBlockEnvelopeV1Schema = z.object({
  turnId: IdentifierSchema,
  stepId: IdentifierSchema.optional(),
  routeId: IdentifierSchema,
  blockIndex: z.number().int().nonnegative(),
  block: ProviderBlockV1Schema,
  receivedAt: TimestampSchema,
  schemaVersion: z.literal(1),
}).passthrough();

export type ProviderBlockV1 = z.infer<typeof ProviderBlockV1Schema>;
export type ProviderBlockEnvelopeV1 = z.infer<typeof ProviderBlockEnvelopeV1Schema>;
export type ContentBlockV1 = z.infer<typeof ContentBlockV1Schema>;
export type ReasoningBlockV1 = z.infer<typeof ReasoningBlockV1Schema>;
export type ToolCallBlockV1 = z.infer<typeof ToolCallBlockV1Schema>;
export type UsageBlockV1 = z.infer<typeof UsageBlockV1Schema>;
export type CompletionAnchorBlockV1 = z.infer<typeof CompletionAnchorBlockV1Schema>;
export type ProviderErrorBlockV1 = z.infer<typeof ProviderErrorBlockV1Schema>;
