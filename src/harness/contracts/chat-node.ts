/**
 * Chat Node V1
 *
 * Stable-keyed projected business nodes representing the canonical timeline.
 * Each node carries a stable key derived from immutable business identity
 * and node role.
 *
 * Requirements: 35.3–35.6
 */

import { z } from 'zod';
import { IdentifierSchema, SequenceSchema } from './primitives';

// ─── Base Schema ────────────────────────────────────────────────

export const ChatNodeBaseV1Schema = z.object({
  stableKey: IdentifierSchema,
  nodeKind: IdentifierSchema,
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  sourceSequenceStart: SequenceSchema,
  sourceSequenceEnd: SequenceSchema,
  contentRevision: z.number().int().nonnegative(),
  turnId: IdentifierSchema.optional(),
  accessibilityLabel: z.string(),
}).passthrough();

export type ChatNodeBaseV1 = z.infer<typeof ChatNodeBaseV1Schema>;

// ─── Node Kind Schemas ──────────────────────────────────────────

export const MessageNodeV1Schema = ChatNodeBaseV1Schema.extend({
  nodeKind: z.literal('message'),
  role: z.enum(['user', 'assistant', 'system']),
  text: z.string(),
  attachmentIds: z.array(IdentifierSchema).optional(),
}).passthrough();

export const AssistantStateNodeV1Schema = ChatNodeBaseV1Schema.extend({
  nodeKind: z.literal('assistant_state'),
  activityState: IdentifierSchema,
  streamingText: z.string().optional(),
}).passthrough();

export const ToolTreeNodeV1Schema = ChatNodeBaseV1Schema.extend({
  nodeKind: z.literal('tool_tree'),
  callId: IdentifierSchema,
  parentCallId: IdentifierSchema.optional(),
  toolName: IdentifierSchema,
  modelOrderIndex: z.number().int().nonnegative(),
  state: z.enum(['planned', 'executing', 'completed', 'failed', 'cancelled']),
}).passthrough();

export const RetryNodeV1Schema = ChatNodeBaseV1Schema.extend({
  nodeKind: z.literal('retry'),
  originalAnchorId: IdentifierSchema,
  attempt: z.number().int().positive(),
  reason: z.string().optional(),
}).passthrough();

export const ErrorNodeV1Schema = ChatNodeBaseV1Schema.extend({
  nodeKind: z.literal('error'),
  errorClass: z.string(),
  message: z.string(),
  redacted: z.boolean(),
}).passthrough();

export const CompactionNodeV1Schema = ChatNodeBaseV1Schema.extend({
  nodeKind: z.literal('compaction'),
  sourceRangeStart: SequenceSchema,
  sourceRangeEnd: SequenceSchema,
  strategy: z.string(),
}).passthrough();

export const ContextInjectionNodeV1Schema = ChatNodeBaseV1Schema.extend({
  nodeKind: z.literal('context_injection'),
  injectionKind: z.string(),
  label: z.string().optional(),
}).passthrough();

export const QueueNodeV1Schema = ChatNodeBaseV1Schema.extend({
  nodeKind: z.literal('queue'),
  entryId: IdentifierSchema,
  queueKind: z.enum(['follow_up', 'steer', 'inject']),
}).passthrough();

export const CollaborationNodeV1Schema = ChatNodeBaseV1Schema.extend({
  nodeKind: z.literal('collaboration'),
  collaborationKind: z.enum(['question', 'approval', 'plan_review']),
  status: z.enum(['pending', 'decided', 'expired']),
}).passthrough();

export const TrajectorySummaryNodeV1Schema = ChatNodeBaseV1Schema.extend({
  nodeKind: z.literal('trajectory_summary'),
  trajectoryId: IdentifierSchema,
  kind: z.string(),
  status: z.string(),
}).passthrough();

export const TurnTailNodeV1Schema = ChatNodeBaseV1Schema.extend({
  nodeKind: z.literal('turn_tail'),
  outcome: z.enum(['completed', 'failed', 'interrupted', 'cancelled']),
}).passthrough();

// ─── Chat Node V1 Discriminated Union ───────────────────────────

export const ChatNodeV1Schema = z.discriminatedUnion('nodeKind', [
  MessageNodeV1Schema,
  AssistantStateNodeV1Schema,
  ToolTreeNodeV1Schema,
  RetryNodeV1Schema,
  ErrorNodeV1Schema,
  CompactionNodeV1Schema,
  ContextInjectionNodeV1Schema,
  QueueNodeV1Schema,
  CollaborationNodeV1Schema,
  TrajectorySummaryNodeV1Schema,
  TurnTailNodeV1Schema,
]);

export type ChatNodeV1 = z.infer<typeof ChatNodeV1Schema>;
export type MessageNodeV1 = z.infer<typeof MessageNodeV1Schema>;
export type AssistantStateNodeV1 = z.infer<typeof AssistantStateNodeV1Schema>;
export type ToolTreeNodeV1 = z.infer<typeof ToolTreeNodeV1Schema>;
export type RetryNodeV1 = z.infer<typeof RetryNodeV1Schema>;
export type ErrorNodeV1 = z.infer<typeof ErrorNodeV1Schema>;
export type CompactionNodeV1 = z.infer<typeof CompactionNodeV1Schema>;
export type ContextInjectionNodeV1 = z.infer<typeof ContextInjectionNodeV1Schema>;
export type QueueNodeV1 = z.infer<typeof QueueNodeV1Schema>;
export type CollaborationNodeV1 = z.infer<typeof CollaborationNodeV1Schema>;
export type TrajectorySummaryNodeV1 = z.infer<typeof TrajectorySummaryNodeV1Schema>;
export type TurnTailNodeV1 = z.infer<typeof TurnTailNodeV1Schema>;

// ─── Boundary Parser ────────────────────────────────────────────

export type ChatNodeParseResult =
  | { ok: true; node: ChatNodeV1 }
  | { ok: false; fallback: true; reason: string; rawNodeKind?: string };

/**
 * Parse a chat node at a boundary. Unknown or incompatible nodeKind
 * discriminators return a typed fallback outcome rather than throwing.
 */
export function parseChatNode(raw: unknown): ChatNodeParseResult {
  const result = ChatNodeV1Schema.safeParse(raw);
  if (result.success) {
    return { ok: true, node: result.data };
  }

  const rawKind = typeof raw === 'object' && raw !== null && 'nodeKind' in raw
    ? String((raw as Record<string, unknown>)['nodeKind'])
    : undefined;

  return {
    ok: false,
    fallback: true,
    reason: result.error.message,
    rawNodeKind: rawKind,
  };
}
