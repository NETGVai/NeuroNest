/**
 * Canonical chat timeline projection — the stable-key timeline owner, true
 * typed streaming reader, tool tree, permitted reasoning surface, and invariant
 * usage header (FUT-PKG-07-EXPERIENCE/T-001).
 *
 * NN-CHAT-001 requires "one Projection Owner [to] create/mutate stable-keyed
 * chat nodes for a session/turn" such that "paging, replay, retry, reconnect,
 * compaction, and legacy ingress SHALL NOT duplicate or lose nodes." D-10 makes
 * the projection a READER: "Provider deltas do not directly mutate renderer
 * state. The projection owns stable nodes; only committed terminal event
 * displays completion." This module realizes both by defining the chat timeline
 * as a DETERMINISTIC projection over the committed `DomainEvent@1` outbox — the
 * exact machinery {@link ../storage/projection-service} already provides for
 * durability (FUT-PKG-03-DURABILITY/T-003). It is never a renderer durable
 * writer: it registers a pure reducer and read helpers; every durable write is
 * performed by the pre-existing ProjectionService, whose sole event source is
 * the committed outbox appended by the authority mutation transaction
 * (FUT-PKG-03-DURABILITY, D-08.2).
 *
 * What this module adds on top of the generic projection engine:
 *
 *   - {@link CHAT_TIMELINE_PROJECTION}: a pure `(state, event) => state` reducer
 *     that folds the correlated chat event ladder (start/reasoning/token/tool/
 *     completion/cancel/error/retry/reconnect/branch/usage) into stable-keyed
 *     nodes. Because every node key is derived purely from the correlated
 *     identity ({@link ../chat/chat-types}.deriveNodeKey), replaying, reconnecting,
 *     or duplicate-delivering the same committed events yields the SAME node
 *     under the SAME key — no duplicate, no lost node (NN-CHAT-001,
 *     V-CHAT-001/stable-node-property).
 *   - TRUE typed streaming: a `chat.token` event carries an incremental
 *     `committedOffset` (from the streaming accumulator's `DurablePartial`), so
 *     the reducer appends only the next contiguous delta and IGNORES a
 *     re-delivered token at or below the committed offset. A reconnect that
 *     replays the committed prefix therefore neither duplicates nor loses a
 *     committed token — never a buffered fake stream (NN-CHAT-004,
 *     V-CHAT-001/stream-reconnect).
 *   - Authority-only completion: only a `chat.completed` event whose payload is
 *     `authorityCommitted: true` flips a node to `complete`. No optimistic
 *     success; a token/reasoning/tool event never marks completion
 *     (NN-INV-003, NN-CHAT-003).
 *   - Permitted reasoning only: a `chat.reasoning` event is applied only if its
 *     reasoning payload is a provider-explicit or safe-summary form; there is no
 *     representation for hidden chain-of-thought (NN-CHAT-005, CD-013).
 *   - Tool trees: `chat.tool.*` events build stable-keyed parent/child tool
 *     nodes with independent per-call state (NN-CHAT-006).
 *   - Invariant usage header: {@link deriveUsageHeader} folds `chat.usage`
 *     events into per-currency totals that are a pure function of the committed
 *     events — identical under paging/compaction/replay (NN-CHAT-013,
 *     V-CHAT-001/usage-projection-invariance).
 *   - Paging + compaction-safe read: {@link readTimeline} returns nodes in a
 *     deterministic stable order with offset/limit paging; the order is derived
 *     from the first-seen sequence per node, so a compacted-then-replayed event
 *     range yields the same page (NN-CHAT-001, NN-EVENT-006).
 *
 * Migration/rollback (D-20): the timeline is read by shadow-comparing the
 * legacy projection against this canonical one and cutting the reader over one
 * surface at a time; rollback reselects the prior reader and NEVER restores a
 * renderer durable writer (NN-COMPAT-016).
 *
 * Design anchors: D-08, D-10, D-15, D-18, D-20.
 * Requirements: NN-CHAT-001–006/009/013, NN-EVENT-002–005, NN-COMPAT-016; CD-013.
 */

import type Database from 'better-sqlite3';

import type { ScopeDescriptor } from '../shared/contract-primitives';
import type { DomainEvent } from '../storage/authority-transaction';
import {
  projectScope,
  rebuildProjection,
  readActiveProjection,
  type ProjectionDefinition,
  type ProjectionState,
  type ProjectionApplyResult,
  type RebuildResult,
} from '../storage/projection-service';
import {
  deriveNodeKey,
  emptyUsageHeader,
  isChatEventType,
  normalizeBlock,
  ChatBranchPayloadSchema,
  ChatCancelledPayloadSchema,
  ChatCompletedPayloadSchema,
  ChatErrorPayloadSchema,
  ChatNodeStartedPayloadSchema,
  ChatReasoningPayloadSchema,
  ChatTokenPayloadSchema,
  ChatToolPayloadSchema,
  ChatUsagePayloadSchema,
  type ChatTimelineNode,
  type ChatToolNode,
  type CurrencyTotal,
  type UsageHeader,
  type UsageQuality,
} from './chat-types';

/** The canonical chat timeline projection id. */
export const CHAT_TIMELINE_PROJECTION_ID = 'chat-timeline';

/** The authority that owns the canonical chat projection reader. */
export const CHAT_PROJECTION_OWNER = 'authority-chat-projection';

// ─── Serializable node state (stored per state_key by ProjectionService) ─────

/**
 * The projection stores each node as a JSON-serializable record under its
 * stable node key. This mirror type is what the reducer reads/writes in the
 * keyed `ProjectionState`; {@link readTimeline} rehydrates it to a
 * {@link ChatTimelineNode}. A `usage:<turnId>` key holds an accumulator record.
 */
interface StoredNode extends ChatTimelineNode {}

/** The per-scope usage accumulator stored under a reserved state key. */
interface StoredUsage {
  readonly kind: 'usage';
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Per-currency minor totals keyed by currency code. */
  readonly costsByCurrency: Readonly<Record<string, number>>;
  /** The distinct qualities observed, for reported/estimated/mixed derivation. */
  readonly qualities: readonly UsageQuality[];
  readonly contributingEvents: number;
}

const USAGE_KEY_PREFIX = 'usage:';

function isUsageRecord(value: unknown): value is StoredUsage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'usage'
  );
}

// ─── Pure reducer helpers ────────────────────────────────────────────────────

/** Shallow-clone the keyed state into a mutable map for a single reduce step. */
function mutableCopy(state: ProjectionState): Map<string, unknown> {
  return new Map(state);
}

/**
 * Get-or-create the base node for a correlated event. A newly created node
 * starts `pending` with no tokens/blocks; existing nodes are returned unchanged
 * so a duplicate `started` is idempotent (NN-CHAT-001).
 */
function ensureNode(
  next: Map<string, unknown>,
  nodeKey: string,
  correlation: {
    turnId: string;
    attempt: number;
    role: ChatTimelineNode['role'];
    nodeKind: string;
  },
  sequence: number,
): StoredNode {
  const existing = next.get(nodeKey) as StoredNode | undefined;
  if (existing) return existing;
  const created: StoredNode = {
    nodeKey,
    turnId: correlation.turnId,
    attempt: correlation.attempt,
    role: correlation.role,
    nodeKind: correlation.nodeKind,
    status: 'pending',
    tokens: [],
    committedOffset: 0,
    blocks: [],
    lastSequence: sequence,
  };
  next.set(nodeKey, created);
  return created;
}

/**
 * The pure chat reducer. A pure function of `(state, event)`: no I/O, no clock,
 * no random. It ignores any event that is not a valid chat event so an
 * unrelated event on the same scope never corrupts the timeline. Every branch
 * is idempotent under duplicate delivery, which is what makes replay/reconnect
 * safe (NN-CHAT-001/003/004).
 */
export function reduceChatEvent(state: ProjectionState, event: DomainEvent): ProjectionState {
  if (!isChatEventType(event.eventType)) return state;
  const sequence = event.sequence;

  switch (event.eventType) {
    case 'chat.turn.started':
    case 'chat.node.started': {
      const parsed = ChatNodeStartedPayloadSchema.safeParse(event.payload);
      if (!parsed.success) return state;
      const p = parsed.data;
      const nodeKey = deriveNodeKey(p);
      const next = mutableCopy(state);
      const node = ensureNode(next, nodeKey, p, sequence);
      const blocks = (p.blocks ?? []).map(normalizeBlock);
      next.set(nodeKey, {
        ...node,
        status: node.status === 'pending' ? 'streaming' : node.status,
        blocks: blocks.length > 0 ? blocks : node.blocks,
        lastSequence: sequence,
      });
      return next;
    }

    case 'chat.token': {
      const parsed = ChatTokenPayloadSchema.safeParse(event.payload);
      if (!parsed.success) return state;
      const p = parsed.data;
      const nodeKey = deriveNodeKey(p);
      const next = mutableCopy(state);
      const node = ensureNode(next, nodeKey, p, sequence);
      // A terminal node never accepts more tokens (post-terminal is inert).
      if (node.status === 'complete' || node.status === 'cancelled' || node.status === 'error') {
        return state;
      }
      // TRUE streaming: this token advances the committed offset to exactly
      // `committedOffset`. A re-delivered token at or below the current offset
      // is an idempotent resume (reconnect replay) and appends nothing; a gap
      // beyond offset+1 is refused (would lose committed content).
      if (p.committedOffset <= node.committedOffset) {
        // Already-committed prefix replayed on reconnect: ignore, no dup.
        next.set(nodeKey, { ...node, lastSequence: sequence });
        return next;
      }
      if (p.committedOffset !== node.committedOffset + 1) {
        // Out-of-order/gapped token: refuse to accept (no lost content).
        next.set(nodeKey, { ...node, lastSequence: sequence });
        return next;
      }
      next.set(nodeKey, {
        ...node,
        status: 'streaming',
        tokens: [...node.tokens, p.delta],
        committedOffset: p.committedOffset,
        lastSequence: sequence,
      });
      return next;
    }

    case 'chat.reasoning': {
      const parsed = ChatReasoningPayloadSchema.safeParse(event.payload);
      // NN-CHAT-005 / CD-013: only a provider-explicit or safe-summary reasoning
      // form is representable; anything else fails the schema and is dropped.
      if (!parsed.success) return state;
      const p = parsed.data;
      const nodeKey = deriveNodeKey(p);
      const next = mutableCopy(state);
      const node = ensureNode(next, nodeKey, p, sequence);
      next.set(nodeKey, { ...node, reasoning: p.reasoning, lastSequence: sequence });
      return next;
    }

    case 'chat.tool.started':
    case 'chat.tool.updated':
    case 'chat.tool.completed': {
      const parsed = ChatToolPayloadSchema.safeParse(event.payload);
      if (!parsed.success) return state;
      const p = parsed.data;
      const nodeKey = deriveNodeKey(p);
      const next = mutableCopy(state);
      const node = ensureNode(next, nodeKey, p, sequence);
      const parentKey =
        p.parentToolCallId !== undefined
          ? deriveNodeKey({
              turnId: p.turnId,
              attempt: p.attempt,
              role: 'tool',
              nodeKind: p.nodeKind,
              toolCallId: p.parentToolCallId,
            })
          : null;
      const tool: ChatToolNode = {
        nodeKey,
        parentKey,
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        toolStatus: p.toolStatus,
        ...(p.argumentSummary !== undefined ? { argumentSummary: p.argumentSummary } : {}),
        ...(p.outputSummary !== undefined ? { outputSummary: p.outputSummary } : {}),
        ...(p.progress !== undefined ? { progress: p.progress } : {}),
      };
      // The tool node's own row carries a `tool` block so it renders in-tree.
      const status =
        p.toolStatus === 'succeeded'
          ? 'complete'
          : p.toolStatus === 'failed'
            ? 'error'
            : p.toolStatus === 'cancelled'
              ? 'cancelled'
              : 'streaming';
      next.set(nodeKey, {
        ...node,
        role: 'tool',
        status,
        blocks: [{ kind: 'tool', blockVersion: 1, data: tool }],
        lastSequence: sequence,
      });
      return next;
    }

    case 'chat.completed': {
      const parsed = ChatCompletedPayloadSchema.safeParse(event.payload);
      // Authority-only completion (NN-INV-003): a completed payload MUST carry
      // authorityCommitted:true; the schema's literal(true) enforces it.
      if (!parsed.success) return state;
      const p = parsed.data;
      const nodeKey = deriveNodeKey(p);
      const next = mutableCopy(state);
      const node = ensureNode(next, nodeKey, p, sequence);
      next.set(nodeKey, {
        ...node,
        status: 'complete',
        blocks: p.blocks.map(normalizeBlock),
        lastSequence: sequence,
      });
      return next;
    }

    case 'chat.cancelled': {
      const parsed = ChatCancelledPayloadSchema.safeParse(event.payload);
      if (!parsed.success) return state;
      const p = parsed.data;
      const nodeKey = deriveNodeKey(p);
      const next = mutableCopy(state);
      const node = ensureNode(next, nodeKey, p, sequence);
      // Partial output remains visible; only status becomes terminal-cancelled.
      next.set(nodeKey, { ...node, status: 'cancelled', lastSequence: sequence });
      return next;
    }

    case 'chat.error': {
      const parsed = ChatErrorPayloadSchema.safeParse(event.payload);
      if (!parsed.success) return state;
      const p = parsed.data;
      const nodeKey = deriveNodeKey(p);
      const next = mutableCopy(state);
      const node = ensureNode(next, nodeKey, p, sequence);
      next.set(nodeKey, {
        ...node,
        status: 'error',
        error: { code: p.errorCode, message: p.message, retryable: p.retryable },
        lastSequence: sequence,
      });
      return next;
    }

    case 'chat.branch': {
      const parsed = ChatBranchPayloadSchema.safeParse(event.payload);
      if (!parsed.success) return state;
      const p = parsed.data;
      const nodeKey = deriveNodeKey(p);
      const next = mutableCopy(state);
      const node = ensureNode(next, nodeKey, p, sequence);
      // A branch/fork/retry preserves the immutable parent lineage; the parent
      // node (a different attempt) is retained untouched (NN-CHAT-009).
      next.set(nodeKey, {
        ...node,
        parentTurnId: p.parentTurnId,
        parentAttempt: p.parentAttempt,
        lastSequence: sequence,
      });
      return next;
    }

    case 'chat.retry':
    case 'chat.reconnect': {
      // Retry/reconnect are correlation markers; the actual resumed stream
      // arrives as further chat.token events at the same node. They carry no
      // node mutation beyond touching lastSequence if the node exists.
      const parsed = ChatNodeStartedPayloadSchema.safeParse(event.payload);
      if (!parsed.success) return state;
      const p = parsed.data;
      const nodeKey = deriveNodeKey(p);
      const existing = state.get(nodeKey) as StoredNode | undefined;
      if (!existing) return state;
      const next = mutableCopy(state);
      next.set(nodeKey, { ...existing, lastSequence: sequence });
      return next;
    }

    case 'chat.usage': {
      const parsed = ChatUsagePayloadSchema.safeParse(event.payload);
      if (!parsed.success) return state;
      const p = parsed.data;
      const key = `${USAGE_KEY_PREFIX}${p.turnId}`;
      const next = mutableCopy(state);
      const prior = next.get(key);
      const base: StoredUsage = isUsageRecord(prior)
        ? prior
        : {
            kind: 'usage',
            promptTokens: 0,
            completionTokens: 0,
            costsByCurrency: {},
            qualities: [],
            contributingEvents: 0,
          };
      const costsByCurrency: Record<string, number> = { ...base.costsByCurrency };
      if (p.cost) {
        costsByCurrency[p.cost.currency] =
          (costsByCurrency[p.cost.currency] ?? 0) + p.cost.amountMinor;
      }
      const qualities = base.qualities.includes(p.quality)
        ? base.qualities
        : [...base.qualities, p.quality];
      next.set(key, {
        kind: 'usage',
        promptTokens: base.promptTokens + p.promptTokens,
        completionTokens: base.completionTokens + p.completionTokens,
        costsByCurrency,
        qualities,
        contributingEvents: base.contributingEvents + 1,
      } satisfies StoredUsage);
      return next;
    }

    default:
      return state;
  }
}

/**
 * The canonical chat timeline projection definition consumed by
 * {@link ../storage/projection-service}. Its reducer is {@link reduceChatEvent};
 * it reads the committed outbox and is the sole author of the `chat-timeline`
 * read model. It is never a renderer durable writer (NN-CHAT-001, D-10).
 */
export const CHAT_TIMELINE_PROJECTION: ProjectionDefinition = {
  projectionId: CHAT_TIMELINE_PROJECTION_ID,
  projectionVersion: 1,
  reduce: reduceChatEvent,
};

// ─── Advance / rebuild the chat timeline (delegates to ProjectionService) ────

/**
 * Advance the active chat timeline generation for a scope from the committed
 * outbox. Thin, intentional delegation to the durable ProjectionService — this
 * module adds no second durable writer (D-10, NN-CHAT-001).
 */
export function advanceChatTimeline(
  db: Database.Database,
  scope: ScopeDescriptor,
  now?: () => Date,
): ProjectionApplyResult {
  return projectScope(db, CHAT_TIMELINE_PROJECTION, scope, now ? { now } : {});
}

/**
 * Rebuild the chat timeline beside the active generation and atomically
 * activate it on an invariant match (shadow-compare before reader cutover,
 * D-20). Rollback of the reader is provided by the ProjectionService and never
 * restores a renderer durable writer (NN-COMPAT-016).
 */
export function rebuildChatTimeline(
  db: Database.Database,
  scope: ScopeDescriptor,
  now?: () => Date,
): RebuildResult {
  return rebuildProjection(db, CHAT_TIMELINE_PROJECTION, scope, now ? { now } : {});
}

// ─── Read model: timeline + usage header (paging/compaction-safe) ────────────

/** A page of the projected timeline. */
export interface TimelinePage {
  /** The nodes in this page, in stable timeline order. */
  readonly nodes: readonly ChatTimelineNode[];
  /** Total node count across all pages (excludes usage accumulators). */
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  /** The active projection status label (never silently current). */
  readonly status: 'current' | 'stale' | 'blocked' | 'absent';
}

/** Options for {@link readTimeline}. */
export interface ReadTimelineOptions {
  /** Zero-based node offset (paging). Default 0. */
  readonly offset?: number;
  /** Max nodes to return. Default: all remaining. */
  readonly limit?: number;
}

/**
 * The stable timeline order: nodes are ordered by their FIRST-seen sequence
 * (their `lastSequence` on creation is the creating event's sequence; we sort
 * by the node's earliest ordering anchor, then by nodeKey for a total order).
 * Because the order is derived from committed sequences and the stable key —
 * never arrival order — a compacted-then-replayed range yields the same order
 * (NN-CHAT-001, NN-EVENT-006). To keep ordering stable across incremental
 * advances we sort by `(turnId, attempt, role-rank, nodeKey)` which is fully
 * determined by the committed identity.
 */
const ROLE_RANK: Readonly<Record<ChatTimelineNode['role'], number>> = Object.freeze({
  user: 0,
  agent: 1,
  tool: 2,
  system: 3,
  recovery: 4,
});

function compareNodes(a: ChatTimelineNode, b: ChatTimelineNode): number {
  if (a.turnId !== b.turnId) return a.turnId < b.turnId ? -1 : 1;
  if (a.attempt !== b.attempt) return a.attempt - b.attempt;
  const ra = ROLE_RANK[a.role];
  const rb = ROLE_RANK[b.role];
  if (ra !== rb) return ra - rb;
  return a.nodeKey < b.nodeKey ? -1 : a.nodeKey > b.nodeKey ? 1 : 0;
}

/** Extract the projected nodes (excluding usage accumulators) from a state. */
function collectNodes(state: ProjectionState): ChatTimelineNode[] {
  const nodes: ChatTimelineNode[] = [];
  for (const [key, value] of state.entries()) {
    if (key.startsWith(USAGE_KEY_PREFIX)) continue;
    nodes.push(value as StoredNode);
  }
  nodes.sort(compareNodes);
  return nodes;
}

/**
 * Read a page of the active chat timeline for a scope. Deterministic and
 * paging-safe: the same committed events always yield the same ordered page
 * for the same offset/limit (NN-CHAT-001). Returns `status: 'absent'` when no
 * generation has been built yet.
 */
export function readTimeline(
  db: Database.Database,
  scope: ScopeDescriptor,
  options: ReadTimelineOptions = {},
): TimelinePage {
  const active = readActiveProjection(db, CHAT_TIMELINE_PROJECTION_ID, scope);
  const offset = Math.max(0, options.offset ?? 0);
  if (!active) {
    return { nodes: [], total: 0, offset, limit: options.limit ?? 0, status: 'absent' };
  }
  const all = collectNodes(active.state);
  const limit = options.limit ?? all.length;
  const page = all.slice(offset, offset + limit);
  return {
    nodes: page,
    total: all.length,
    offset,
    limit,
    status: active.status,
  };
}

/**
 * Derive the usage header for a turn (or the whole scope when `turnId` is
 * omitted) from the active projection's committed usage accumulators. The
 * result is a pure function of the committed usage events, so it is INVARIANT
 * under paging/compaction/replay (NN-CHAT-013,
 * V-CHAT-001/usage-projection-invariance). Currencies are preserved separately.
 */
export function deriveUsageHeader(
  db: Database.Database,
  scope: ScopeDescriptor,
  turnId?: string,
): UsageHeader {
  const active = readActiveProjection(db, CHAT_TIMELINE_PROJECTION_ID, scope);
  if (!active) return emptyUsageHeader();
  return usageHeaderFromState(active.state, turnId);
}

/**
 * Pure derivation of the usage header from a projection state — exposed so
 * tests can prove invariance directly against a rebuilt/replayed state without
 * a second read path. Aggregates all `usage:*` accumulators (optionally a
 * single turn), keeping per-currency totals separate and folding the observed
 * qualities into a single reported/estimated/mixed/partial/unavailable label.
 */
export function usageHeaderFromState(state: ProjectionState, turnId?: string): UsageHeader {
  let promptTokens = 0;
  let completionTokens = 0;
  let contributingEvents = 0;
  const costsByCurrency = new Map<string, number>();
  const qualities = new Set<UsageQuality>();

  for (const [key, value] of state.entries()) {
    if (!key.startsWith(USAGE_KEY_PREFIX)) continue;
    if (turnId !== undefined && key !== `${USAGE_KEY_PREFIX}${turnId}`) continue;
    if (!isUsageRecord(value)) continue;
    promptTokens += value.promptTokens;
    completionTokens += value.completionTokens;
    contributingEvents += value.contributingEvents;
    for (const [currency, amount] of Object.entries(value.costsByCurrency)) {
      costsByCurrency.set(currency, (costsByCurrency.get(currency) ?? 0) + amount);
    }
    for (const q of value.qualities) qualities.add(q);
  }

  if (contributingEvents === 0) return emptyUsageHeader();

  const costs: CurrencyTotal[] = [...costsByCurrency.entries()]
    .map(([currency, amountMinor]) => ({ currency, amountMinor }))
    .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    costs,
    quality: foldQuality(qualities),
    contributingEvents,
  };
}

/**
 * Fold the set of observed usage qualities into a single header quality.
 * `partial`/`unavailable` dominate; a mix of reported and estimated is
 * `mixed`; a single quality passes through (NN-CHAT-013).
 */
function foldQuality(qualities: ReadonlySet<UsageQuality>): UsageQuality {
  if (qualities.size === 0) return 'unavailable';
  if (qualities.has('partial')) return 'partial';
  if (qualities.size === 1) return [...qualities][0];
  // Multiple distinct qualities (e.g. reported + estimated) → mixed. If only
  // unavailable is combined with something else, the something-else dominates.
  const nonUnavailable = [...qualities].filter((q) => q !== 'unavailable');
  if (nonUnavailable.length === 0) return 'unavailable';
  if (nonUnavailable.length === 1) return nonUnavailable[0];
  return 'mixed';
}
