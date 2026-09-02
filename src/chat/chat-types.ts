/**
 * Canonical chat timeline contracts: stable-keyed nodes, versioned typed
 * content blocks with a safe generic fallback, the correlated streaming event
 * ladder, permitted reasoning summaries, tool trees, and the usage header
 * (FUT-PKG-07-EXPERIENCE/T-001).
 *
 * This module owns the SHAPE of the chat timeline that the chat projection
 * reduces the committed outbox into. It is deliberately additive over
 * {@link ../storage/authority-transaction} (the committed `DomainEvent@1`
 * outbox is the projection's ONLY event source) and {@link ../provider/streaming}
 * (which produces the durable partial that a `chat.token`/`chat.completed`
 * event carries). Nothing here is a durable writer: the renderer never mutates
 * a node, and completion is only ever set by an authority-committed terminal
 * event (NN-CHAT-001/003, NN-COMPAT-016, D-10).
 *
 * The design invariants encoded here:
 *
 *   - **Stable keys (NN-CHAT-001).** Every node key is derived deterministically
 *     from the correlated turn/attempt/role/nodeKind identity carried on the
 *     event — never from arrival order, wall-clock, or a random id. So the same
 *     committed events replayed/reconnected/duplicated always project the SAME
 *     node under the SAME key: no duplicate node, no lost node.
 *   - **Typed blocks + fallback (NN-CHAT-002).** A closed set of versioned block
 *     kinds; an unknown/invalid block deterministically degrades to a
 *     `fallback` block that preserves the raw content safely rather than being
 *     dropped or executed.
 *   - **Correlated lifecycle (NN-CHAT-003).** Start, permitted reasoning, token,
 *     tool, completion, cancellation, error, retry, reconnect, and duplicate
 *     delivery are all typed event kinds sharing the turn/attempt correlation.
 *     Partial output stays visible; only an authority terminal event flips a
 *     node to `complete`.
 *   - **True streaming (NN-CHAT-004).** A `chat.token` event carries an
 *     incremental committed offset (from the streaming accumulator's
 *     `DurablePartial`), never a full buffered response; reconnect resumes from
 *     the committed offset without duplicating or losing committed tokens.
 *   - **Reasoning privacy (NN-CHAT-005, CD-013).** Only a provider-explicit or
 *     safe-summary reasoning payload is representable; there is no field for
 *     hidden chain-of-thought, protected prompts, secrets, or private locators.
 *   - **Tool presentation (NN-CHAT-006).** Tool nodes form a stable-keyed tree
 *     (parent/child) with independent per-call state; a text pattern is never a
 *     tool node.
 *   - **Usage header (NN-CHAT-013).** Usage totals are derived deterministically
 *     from committed usage events and are invariant under paging/compaction/
 *     replay; currencies are kept separate absent a versioned conversion.
 *
 * Design anchors: D-08, D-10, D-15, D-18, D-20.
 * Requirements: NN-CHAT-001–006/009/013, NN-EVENT-002–005, NN-COMPAT-016; CD-013.
 */

import { z } from 'zod';

import {
  CONTRACT_WRITE_VERSION,
  computeDigest,
} from '../shared/contract-primitives';

// ─── Node role + kind (stable-key identity anchors) ─────────────────────────

/**
 * The author role a timeline node belongs to. Part of the stable node key so a
 * user node and an agent node for the same turn never collide.
 */
export const CHAT_NODE_ROLES = Object.freeze([
  'user',
  'agent',
  'tool',
  'system',
  'recovery',
] as const);
export type ChatNodeRole = (typeof CHAT_NODE_ROLES)[number];

/**
 * The lifecycle status of a node. `streaming` shows partial output; only an
 * authority-committed terminal event may set `complete` (NN-CHAT-003/004,
 * NN-INV-003). `cancelled`/`error` are terminal-but-not-successful states that
 * still preserve the partial output.
 */
export const CHAT_NODE_STATUSES = Object.freeze([
  'pending',
  'streaming',
  'complete',
  'cancelled',
  'error',
] as const);
export type ChatNodeStatus = (typeof CHAT_NODE_STATUSES)[number];

// ─── Typed content blocks (NN-CHAT-002) + safe fallback ─────────────────────

/**
 * The closed set of versioned content-block kinds the renderer supports
 * (NN-CHAT-002). An unknown or invalid block is normalized to `fallback`
 * rather than dropped or executed.
 */
export const CHAT_BLOCK_KINDS = Object.freeze([
  'narrative',
  'code',
  'diff',
  'tool',
  'task',
  'plan',
  'approval',
  'citation',
  'source',
  'table',
  'metric',
  'diagram',
  'image',
  'attachment',
  'recommendation',
  'recovery',
  'error',
  'fallback',
] as const);
export type ChatBlockKind = (typeof CHAT_BLOCK_KINDS)[number];

/** Whether a value is a recognized typed block kind. */
export function isChatBlockKind(value: unknown): value is ChatBlockKind {
  return (
    typeof value === 'string' &&
    (CHAT_BLOCK_KINDS as readonly string[]).includes(value)
  );
}

/**
 * A single typed content block. `blockVersion` lets a block schema evolve; a
 * block whose kind is unknown OR whose version is unreadable is normalized to a
 * `fallback` block by {@link normalizeBlock} so unknown content is preserved
 * safely (NN-CHAT-002 "safe generic fallback for unknown/invalid content").
 */
export const ChatContentBlockSchema = z.object({
  kind: z.string().min(1),
  blockVersion: z.number().int().positive().finite(),
  /** The block's typed data; validated per-kind by the renderer island. */
  data: z.unknown(),
});
export type ChatContentBlock = {
  readonly kind: ChatBlockKind;
  readonly blockVersion: number;
  readonly data: unknown;
};

/** The highest block version this projection revision can read for any kind. */
export const MAX_READABLE_BLOCK_VERSION = 1 as const;

/**
 * Normalize an untrusted block into a typed block, degrading anything unknown
 * or unreadable to a `fallback` block that preserves the original kind/version
 * and raw data (never dropped, never executed). Deterministic and pure: the
 * same input always yields the same normalized block.
 */
export function normalizeBlock(raw: unknown): ChatContentBlock {
  const parsed = ChatContentBlockSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: 'fallback', blockVersion: 1, data: { reason: 'invalid-block', raw } };
  }
  const { kind, blockVersion, data } = parsed.data;
  if (!isChatBlockKind(kind) || kind === 'fallback') {
    return {
      kind: 'fallback',
      blockVersion: 1,
      data: { reason: 'unknown-kind', originalKind: kind, originalVersion: blockVersion, data },
    };
  }
  if (blockVersion > MAX_READABLE_BLOCK_VERSION) {
    return {
      kind: 'fallback',
      blockVersion: 1,
      data: { reason: 'unreadable-version', originalKind: kind, originalVersion: blockVersion, data },
    };
  }
  return { kind, blockVersion, data };
}

// ─── Permitted reasoning summary (NN-CHAT-005, CD-013) ──────────────────────

/**
 * A permitted reasoning payload. Only two forms are representable: a
 * `provider-explicit` reasoning surface the provider itself exposed, or a safe,
 * concise decision/evidence `summary`. There is deliberately NO field for
 * hidden chain-of-thought, protected prompts, secrets, or private locators —
 * an event whose reasoning is not one of these permitted forms is dropped by
 * the reducer (NN-CHAT-005, CD-013).
 */
export const ReasoningSummarySchema = z.object({
  visibility: z.enum(['provider-explicit', 'summary']),
  /** The safe, redaction-cleared reasoning text. */
  text: z.string().max(8192),
});
export type ReasoningSummary = z.infer<typeof ReasoningSummarySchema>;

// ─── Usage header (NN-CHAT-013) ─────────────────────────────────────────────

/**
 * How a usage figure was obtained. Kept explicit so the header can distinguish
 * reported/estimated/mixed/partial/unavailable rather than presenting an
 * estimate as an authoritative total (NN-CHAT-013).
 */
export const USAGE_QUALITIES = Object.freeze([
  'reported',
  'estimated',
  'mixed',
  'partial',
  'unavailable',
] as const);
export type UsageQuality = (typeof USAGE_QUALITIES)[number];

/**
 * A per-currency cost total. Currencies are preserved SEPARATELY absent a
 * versioned conversion (NN-CHAT-013): the header never sums two currencies into
 * one number without an explicit pricing/conversion revision.
 */
export interface CurrencyTotal {
  readonly currency: string;
  readonly amountMinor: number;
}

/**
 * The derived usage header for a session/turn scope. Every field is a pure
 * function of the committed usage events, so paging/compaction/replay of the
 * same events always yields the same header (the invariance anchor,
 * NN-CHAT-013 / V-CHAT-001/usage-projection-invariance).
 */
export interface UsageHeader {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  /** Per-currency cost totals, sorted by currency for a stable shape. */
  readonly costs: readonly CurrencyTotal[];
  readonly quality: UsageQuality;
  /** How many committed usage events contributed to these totals. */
  readonly contributingEvents: number;
}

/** The empty usage header (no committed usage events yet). */
export function emptyUsageHeader(): UsageHeader {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costs: [],
    quality: 'unavailable',
    contributingEvents: 0,
  };
}

// ─── Correlated streaming event ladder (NN-CHAT-003) ────────────────────────

/**
 * The chat event kinds a `DomainEvent@1` carries as its `eventType`. This is
 * the full correlated lifecycle (NN-CHAT-003): start, permitted reasoning,
 * token, tool lifecycle, completion, cancellation, error, retry, reconnect, and
 * duplicate delivery. A duplicate-delivered event is idempotent under the
 * reducer (it produces the same node), which is what lets replay/reconnect be
 * safe.
 */
export const CHAT_EVENT_TYPES = Object.freeze([
  'chat.turn.started',
  'chat.node.started',
  'chat.reasoning',
  'chat.token',
  'chat.tool.started',
  'chat.tool.updated',
  'chat.tool.completed',
  'chat.completed',
  'chat.cancelled',
  'chat.error',
  'chat.retry',
  'chat.reconnect',
  'chat.usage',
  'chat.branch',
] as const);
export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number];

/** Whether a value is a recognized chat event type. */
export function isChatEventType(value: unknown): value is ChatEventType {
  return (
    typeof value === 'string' &&
    (CHAT_EVENT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * The correlation identity every chat event payload carries. `turnId` +
 * `attempt` + `role` + `nodeKind` + optional `toolCallId`/`parentToolCallId`
 * are the STABLE anchors from which a node key is derived (NN-CHAT-001). A
 * retry/branch bumps `attempt` (a NEW attempt, distinct from an idempotent
 * resume, NN-CHAT-009); a reconnect keeps the same `attempt` and resumes the
 * same node (NN-CHAT-003/004).
 */
export const ChatCorrelationSchema = z.object({
  turnId: z.string().min(1),
  /** The attempt ordinal; a retry/branch increments it, a resume does not. */
  attempt: z.number().int().nonnegative().finite(),
  role: z.enum(CHAT_NODE_ROLES),
  /** A per-role discriminator so multiple nodes of a role stay distinct. */
  nodeKind: z.string().min(1),
  /** For tool nodes: the stable tool-call id (part of the tool-tree key). */
  toolCallId: z.string().min(1).optional(),
  /** For nested tools: the parent tool-call id (tool tree edge). */
  parentToolCallId: z.string().min(1).optional(),
});
export type ChatCorrelation = z.infer<typeof ChatCorrelationSchema>;

// ─── Chat event payloads (validated shapes for each event type) ─────────────

export const ChatTokenPayloadSchema = ChatCorrelationSchema.extend({
  /** The incremental token delta (true streaming — never a full buffer). */
  delta: z.string(),
  /**
   * The committed offset AFTER this delta, from the streaming accumulator's
   * DurablePartial. Monotonic and gap-free; a re-delivered token at or below
   * the current committed offset is an idempotent resume and appends nothing
   * (NN-CHAT-004).
   */
  committedOffset: z.number().int().positive().finite(),
  promptTokens: z.number().int().nonnegative().finite().optional(),
  completionTokens: z.number().int().nonnegative().finite().optional(),
});
export type ChatTokenPayload = z.infer<typeof ChatTokenPayloadSchema>;

export const ChatNodeStartedPayloadSchema = ChatCorrelationSchema.extend({
  /** Optional initial typed blocks for a non-streaming node. */
  blocks: z.array(ChatContentBlockSchema).optional(),
});
export type ChatNodeStartedPayload = z.infer<typeof ChatNodeStartedPayloadSchema>;

export const ChatReasoningPayloadSchema = ChatCorrelationSchema.extend({
  reasoning: ReasoningSummarySchema,
});
export type ChatReasoningPayload = z.infer<typeof ChatReasoningPayloadSchema>;

export const ChatToolPayloadSchema = ChatCorrelationSchema.extend({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  /** Redacted argument/output summaries only (NN-CHAT-006, NN-INV-004). */
  argumentSummary: z.string().max(4096).optional(),
  outputSummary: z.string().max(4096).optional(),
  toolStatus: z.enum(['started', 'running', 'succeeded', 'failed', 'cancelled']),
  progress: z.number().min(0).max(1).optional(),
});
export type ChatToolPayload = z.infer<typeof ChatToolPayloadSchema>;

export const ChatCompletedPayloadSchema = ChatCorrelationSchema.extend({
  /** The authority-committed final blocks for the node. */
  blocks: z.array(ChatContentBlockSchema),
  /** True only from an authority terminal event (NN-INV-003). */
  authorityCommitted: z.literal(true),
});
export type ChatCompletedPayload = z.infer<typeof ChatCompletedPayloadSchema>;

export const ChatCancelledPayloadSchema = ChatCorrelationSchema.extend({
  reason: z.string().max(1024).optional(),
});
export type ChatCancelledPayload = z.infer<typeof ChatCancelledPayloadSchema>;

export const ChatErrorPayloadSchema = ChatCorrelationSchema.extend({
  errorCode: z.string().min(1),
  message: z.string().max(4096),
  retryable: z.boolean(),
});
export type ChatErrorPayload = z.infer<typeof ChatErrorPayloadSchema>;

export const ChatUsagePayloadSchema = z.object({
  turnId: z.string().min(1),
  promptTokens: z.number().int().nonnegative().finite(),
  completionTokens: z.number().int().nonnegative().finite(),
  quality: z.enum(USAGE_QUALITIES),
  cost: z
    .object({
      currency: z.string().min(1).max(16),
      amountMinor: z.number().int().nonnegative().finite(),
    })
    .optional(),
});
export type ChatUsagePayload = z.infer<typeof ChatUsagePayloadSchema>;

export const ChatBranchPayloadSchema = ChatCorrelationSchema.extend({
  /** The immutable parent turn/attempt this branch forks from (NN-CHAT-009). */
  parentTurnId: z.string().min(1),
  parentAttempt: z.number().int().nonnegative().finite(),
});
export type ChatBranchPayload = z.infer<typeof ChatBranchPayloadSchema>;

// ─── Stable node key derivation (NN-CHAT-001) ───────────────────────────────

/**
 * Derive the STABLE key for a timeline node from its correlated identity. The
 * key is a pure function of `(turnId, attempt, role, nodeKind, toolCallId)` —
 * it depends on NOTHING about arrival order, wall-clock, event id, or sequence.
 * This is the property that guarantees replay/reconnect/duplicate delivery
 * project the same node under the same key (no duplicate, no lost node;
 * NN-CHAT-001 / V-CHAT-001/stable-node-property).
 */
export function deriveNodeKey(correlation: {
  turnId: string;
  attempt: number;
  role: ChatNodeRole;
  nodeKind: string;
  toolCallId?: string;
}): string {
  const anchors = {
    turnId: correlation.turnId,
    attempt: correlation.attempt,
    role: correlation.role,
    nodeKind: correlation.nodeKind,
    toolCallId: correlation.toolCallId ?? null,
  };
  return `node:${computeDigest(anchors)}`;
}

// ─── Projected node + timeline shapes (the read model) ──────────────────────

/**
 * A tool node inside the tool tree. `parentKey` is null for a top-level tool
 * and the parent tool node's stable key for a nested tool (NN-CHAT-006). Each
 * tool call keeps its own independent state.
 */
export interface ChatToolNode {
  readonly nodeKey: string;
  readonly parentKey: string | null;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolStatus: ChatToolPayload['toolStatus'];
  readonly argumentSummary?: string;
  readonly outputSummary?: string;
  readonly progress?: number;
}

/**
 * One projected timeline node. The reducer is the sole author of this shape;
 * the renderer only reads it. `status` is `complete` ONLY when an
 * authority-committed terminal event set it (NN-INV-003).
 */
export interface ChatTimelineNode {
  readonly nodeKey: string;
  readonly turnId: string;
  readonly attempt: number;
  readonly role: ChatNodeRole;
  readonly nodeKind: string;
  readonly status: ChatNodeStatus;
  /** Ordered committed streaming deltas (true streaming, never a buffer). */
  readonly tokens: readonly string[];
  /** The committed streaming offset (number of accepted deltas). */
  readonly committedOffset: number;
  /** Authority-committed typed blocks (set by a terminal event). */
  readonly blocks: readonly ChatContentBlock[];
  /** Permitted reasoning summary, if any (NN-CHAT-005). */
  readonly reasoning?: ReasoningSummary;
  /** For a branch node: the immutable parent lineage (NN-CHAT-009). */
  readonly parentTurnId?: string;
  readonly parentAttempt?: number;
  /** Terminal error info, if the node ended in error. */
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
  /** The scope sequence of the last event applied to this node (ordering). */
  readonly lastSequence: number;
}

/** The concatenated streamed text of a node (ordered, gap-free). */
export function nodeText(node: ChatTimelineNode): string {
  return node.tokens.join('');
}
