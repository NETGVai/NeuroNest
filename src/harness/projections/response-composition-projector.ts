import type { SessionEventV1 } from '../contracts/event.js';
import {
  AnswerDeltaV1Schema,
  ApprovalUpsertV1Schema,
  BlockScopedErrorV1Schema,
  ReasoningDeltaV1Schema,
  ResponseCompletedV1Schema,
  ResponseFailedV1Schema,
  ResponseInterruptedV1Schema,
  ResponseStartedV1Schema,
  ResponseStoppedV1Schema,
  TaskUpsertV1Schema,
  ThinkingStepUpsertV1Schema,
  ToolUpsertV1Schema,
  UsageReportedV1Schema,
  type ApprovalUpsertStatusV1,
  type ChatStreamErrorClassV1,
  type ResponseFailedV1,
  type ResponseInterruptedV1,
  type ResponseStoppedV1,
  type TaskUpsertStatusV1,
  type ThinkingStepKindV1,
  type ThinkingStepStateV1,
  type ToolUpsertStatusV1,
} from '../contracts/chat-stream-event.js';
import {
  ActionDescriptorV1Schema,
  type ActionDescriptorV1,
} from '../contracts/response-support.js';
import {
  ResponseBlockV1Schema,
  type DecisionBlockV1,
  type ErrorBlockV1,
  type FollowUpActionsBlockV1,
  type NarrativeBlockV1,
  type ReasoningBlockV1,
  type ResponseBlockKind,
  type ResponseBlockRole,
  type ResponseBlockV1,
  type ResponseCompositionV1,
  type TaskProgressBlockV1,
  type ToolActivityBlockV1,
  type TurnStatusBlockV1,
} from '../contracts/response-composition.js';
import { computeStableKey } from './canonical-timeline.js';
import { computeResponseBlockStableKey } from './response-block-identity.js';

/** Explicit durable fact types consumed by the composition projector. */
export const RESPONSE_COMPOSITION_EVENT_TYPES = {
  block: 'response.block',
  actions: 'response.actions',
  // Canonical chat stream event types consumed as SessionEventV1 payloads.
  responseStarted: 'response.started',
  answerDelta: 'answer.delta',
  reasoningDelta: 'reasoning.delta',
  thinkingStepUpserted: 'thinking.step.upserted',
  toolUpserted: 'tool.upserted',
  taskUpserted: 'task.upserted',
  approvalUpserted: 'approval.upserted',
  usageReported: 'usage.reported',
  blockError: 'block.error',
  responseCompleted: 'response.completed',
  responseStopped: 'response.stopped',
  responseInterrupted: 'response.interrupted',
  responseFailed: 'response.failed',
} as const;

/** Terminal canonical response event types (compare-and-set). */
const CANONICAL_TERMINAL_EVENT_TYPES = new Set<string>([
  RESPONSE_COMPOSITION_EVENT_TYPES.responseCompleted,
  RESPONSE_COMPOSITION_EVENT_TYPES.responseStopped,
  RESPONSE_COMPOSITION_EVENT_TYPES.responseInterrupted,
  RESPONSE_COMPOSITION_EVENT_TYPES.responseFailed,
]);

export type ResponseCompositionProjectionDiagnosticCode =
  | 'incompatible_scope'
  | 'duplicate_event_id'
  | 'orphan_event'
  | 'invalid_block'
  | 'invalid_actions'
  | 'invalid_payload'
  | 'reserved_block_kind'
  | 'source_identity_mismatch'
  | 'stale_revision'
  | 'duplicate_terminal'
  | 'invalid_state_transition';

/** Metadata-only rejection diagnostic. No event payload or presentation content is retained. */
export interface ResponseCompositionProjectionDiagnosticV1 {
  readonly code: ResponseCompositionProjectionDiagnosticCode;
  readonly eventId: string;
  readonly eventType: string;
  readonly sourceSequence: number;
}

export interface ResponseCompositionDeltaV1 {
  readonly added: readonly ResponseCompositionV1[];
  readonly updated: readonly ResponseCompositionV1[];
  readonly removed: readonly string[];
  readonly projectionRevision: number;
  readonly sourceSequence: number;
  readonly diagnostics: readonly ResponseCompositionProjectionDiagnosticV1[];
}

interface MessageSeed {
  readonly messageId: string;
  readonly turnId: string;
  readonly firstSequence: number;
  readonly firstOccurredAt: string;
}

interface OrderedTextFact {
  readonly eventId: string;
  readonly sequence: number;
  readonly attempt: number;
  readonly ordinal: number;
  readonly text: string;
  readonly finalized: boolean;
  readonly format?: 'plain_stream' | 'markdown';
  readonly snapshot: boolean;
}

interface StatusFact {
  readonly sequence: number;
  readonly state: TurnStatusBlockV1['content']['state'];
  readonly occurredAt: string;
  readonly terminal: boolean;
  readonly cancellationAvailable?: boolean;
  readonly cancellationUnavailableReason?: string;
}

interface StructuredEntry {
  readonly block: ResponseBlockV1;
  readonly declaredOrder: number;
  readonly firstSequence: number;
  readonly latestSequence: number;
}

/** Per-response state derived from a `response.started` event. */
interface CanonicalResponseStartedState {
  readonly responseId: string;
  readonly requestId: string;
  readonly attempt: number;
  readonly agentId: string | undefined;
  readonly transportClass: string;
  readonly provider: string;
  readonly model: string;
  readonly edition: string;
  readonly sequence: number;
}

/** Ordered answer/reasoning delta accepted from canonical stream events. */
interface OrderedCanonicalDelta {
  readonly eventId: string;
  readonly sequence: number;
  readonly attempt: number;
  readonly text: string;
}

/** Ordered reasoning delta with an explicit provider-supplied label. */
interface OrderedCanonicalReasoningDelta extends OrderedCanonicalDelta {
  readonly label: 'model-provided-reasoning' | 'model-provided-reasoning-summary';
}

/** Terminal canonical response event. */
interface CanonicalTerminalState {
  readonly terminalState: 'completed' | 'stopped' | 'interrupted' | 'failed';
  readonly sequence: number;
  readonly occurredAt: string;
  readonly partialContentRetained: boolean;
  readonly errorClass?: ChatStreamErrorClassV1;
  readonly errorId?: string;
  readonly summary?: string;
  readonly correlationId?: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly reason?: string;
}

/** Revisioned entity state for a canonical thinking step upsert. */
interface ThinkingStepState {
  readonly stepId: string;
  readonly revision: number;
  readonly orderIndex: number;
  readonly kind: ThinkingStepKindV1;
  readonly state: ThinkingStepStateV1;
  readonly label: string;
  readonly startedAt?: string;
  readonly terminalAt?: string;
  readonly firstSequence: number;
  readonly latestSequence: number;
}

/** Revisioned entity state for a canonical tool upsert. */
interface ToolState {
  readonly callId: string;
  readonly revision: number;
  readonly modelOrderIndex: number;
  readonly toolName: string;
  readonly status: ToolUpsertStatusV1;
  readonly inputSummary?: string;
  readonly outputSummary?: string;
  readonly errorSummary?: string;
  readonly firstSequence: number;
  readonly latestSequence: number;
}

/** Revisioned entity state for a canonical task upsert. */
interface TaskState {
  readonly taskId: string;
  readonly revision: number;
  readonly orderIndex: number;
  readonly description: string;
  readonly status: TaskUpsertStatusV1;
  readonly progress?: number;
  readonly outcome?: string;
  readonly errorSummary?: string;
  readonly firstSequence: number;
  readonly latestSequence: number;
}

/** Revisioned entity state for a canonical approval upsert. */
interface ApprovalState {
  readonly collaborationId: string;
  readonly revision: number;
  readonly orderIndex: number;
  readonly actionSummary: string;
  readonly scopeSummary?: string;
  readonly riskSummary?: string;
  readonly status: ApprovalUpsertStatusV1;
  readonly contractRevision: number;
  readonly contractDigest: string;
  readonly expiresAt?: string;
  readonly firstSequence: number;
  readonly latestSequence: number;
}

/** Recorded usage report metadata (no visible block; feeds composition metadata). */
interface UsageState {
  readonly reportedAtSequence: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

/** Recorded block-scoped error, projected as an inert error block. */
interface BlockErrorState {
  readonly errorId: string;
  readonly errorClass: ChatStreamErrorClassV1;
  readonly summary: string;
  readonly correlationId: string;
  readonly recoverable: boolean;
  readonly affectedStableKey: string;
  readonly affectedEntityId: string;
  readonly affectedEventType?: string;
  readonly firstSequence: number;
  readonly latestSequence: number;
}

interface MessageProjectionState extends MessageSeed {
  readonly messageFacts: OrderedTextFact[];
  readonly deltas: OrderedTextFact[];
  readonly reasoning: OrderedTextFact[];
  readonly reasoningCategories: Set<ReasoningBlockV1['content']['categories'][number]>;
  readonly statuses: StatusFact[];
  readonly structured: Map<string, StructuredEntry>;
  readonly canonicalAnswerDeltas: OrderedCanonicalDelta[];
  readonly canonicalReasoningDeltas: OrderedCanonicalReasoningDelta[];
  readonly thinkingSteps: Map<string, ThinkingStepState>;
  readonly tools: Map<string, ToolState>;
  readonly tasks: Map<string, TaskState>;
  readonly approvals: Map<string, ApprovalState>;
  readonly blockErrors: Map<string, BlockErrorState>;
  canonicalStarted?: CanonicalResponseStartedState;
  canonicalTerminal?: CanonicalTerminalState;
  usage?: UsageState;
  sourceRevision: number;
}

interface BuildResult {
  readonly compositions: ResponseCompositionV1[];
  readonly order: ReadonlyMap<string, number>;
  readonly diagnostics: ResponseCompositionProjectionDiagnosticV1[];
}

const RESERVED_PROJECTED_BLOCK_KINDS = new Set<ResponseBlockKind>([
  'narrative',
  'reasoning',
  'turn_status',
]);

const REASONING_CATEGORIES = new Set<ReasoningBlockV1['content']['categories'][number]>([
  'summary',
  'search',
  'coding',
  'tool',
  'verification',
]);

const TERMINAL_STATES = new Set<TurnStatusBlockV1['content']['state']>([
  'cancelled',
  'interrupted',
  'completed',
  'failed',
]);

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function nonnegativeInteger(record: Record<string, unknown>, key: string, fallback = 0): number {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}

function finiteOrder(record: Record<string, unknown>, fallback: number): number {
  const value = record['declaredOrder'];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function boundedSummary(value: string | undefined, fallback: string): string {
  return (value ?? fallback).slice(0, 4_096);
}

function diagnostic(
  event: SessionEventV1,
  code: ResponseCompositionProjectionDiagnosticCode,
): ResponseCompositionProjectionDiagnosticV1 {
  return {
    code,
    eventId: event.eventId,
    eventType: event.eventType,
    sourceSequence: event.sequence,
  };
}

function responseBlockKey(
  sessionId: string,
  branchId: string,
  compositionId: string,
  kind: ResponseBlockKind,
  entityId: string,
  role: ResponseBlockRole,
): string {
  return computeResponseBlockStableKey({
    sessionId,
    branchId,
    compositionId,
    entityKind: kind,
    entityId,
    role,
  });
}

function semanticAnchor(chatNodeStableKey: string, kind: ResponseBlockKind, entityId: string): string {
  return `response:${chatNodeStableKey}:${kind}:${entityId}`;
}

function mapStatusState(value: unknown): TurnStatusBlockV1['content']['state'] | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replaceAll('-', '_');
  switch (normalized) {
    case 'queued':
    case 'reasoning':
    case 'streaming':
    case 'retrying':
    case 'cancelling':
    case 'cancelled':
    case 'interrupted':
    case 'completed':
    case 'failed':
    case 'reconnecting':
      return normalized;
    case 'tool_running':
    case 'tool':
      return 'tool_running';
    case 'waiting':
    case 'waiting_for_user':
      return 'waiting_for_user';
    default:
      return undefined;
  }
}

function stateFromTail(value: unknown): TurnStatusBlockV1['content']['state'] | undefined {
  switch (value) {
    case 'completed':
    case 'failed':
    case 'interrupted':
    case 'cancelled':
      return value;
    default:
      return undefined;
  }
}

function compareEvents(left: SessionEventV1, right: SessionEventV1): number {
  return left.sequence - right.sequence || left.eventId.localeCompare(right.eventId);
}

function compareTextFacts(left: OrderedTextFact, right: OrderedTextFact): number {
  return left.attempt - right.attempt
    || left.ordinal - right.ordinal
    || left.sequence - right.sequence
    || left.eventId.localeCompare(right.eventId);
}

function compareCanonicalDeltas(
  left: OrderedCanonicalDelta,
  right: OrderedCanonicalDelta,
): number {
  return left.attempt - right.attempt
    || left.sequence - right.sequence
    || left.eventId.localeCompare(right.eventId);
}

/** Extract the strict typed identity from a canonical stream payload record. */
function canonicalMessageId(payload: Record<string, unknown>): string | undefined {
  const identity = payload['identity'];
  if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) return undefined;
  const responseId = (identity as Record<string, unknown>)['responseId'];
  return typeof responseId === 'string' && responseId.length > 0 ? responseId : undefined;
}

/** Extract the strict typed turn id from a canonical stream payload record. */
function canonicalTurnId(payload: Record<string, unknown>): string | undefined {
  const identity = payload['identity'];
  if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) return undefined;
  const turnId = (identity as Record<string, unknown>)['turnId'];
  return typeof turnId === 'string' && turnId.length > 0 ? turnId : undefined;
}

/**
 * Monotonic thinking-step state machine.
 * Allowed transitions:
 *   pending → running → (completed | failed | cancelled)
 *   pending → (completed | failed | cancelled)   // direct terminal
 * Terminal (completed | failed | cancelled) is absorbing.
 */
function isThinkingStepTransitionAllowed(
  previous: ThinkingStepStateV1,
  next: ThinkingStepStateV1,
): boolean {
  if (previous === next) return true;
  switch (previous) {
    case 'pending':
      return next === 'running'
        || next === 'completed'
        || next === 'failed'
        || next === 'cancelled';
    case 'running':
      return next === 'completed' || next === 'failed' || next === 'cancelled';
    default:
      return false;
  }
}

/**
 * Monotonic tool state machine.
 * Allowed transitions:
 *   requested → (awaiting_approval | running | cancelled | failed | succeeded)
 *   awaiting_approval → (running | cancelled | failed)
 *   running → (succeeded | failed | cancelled)
 * Terminal (succeeded | failed | cancelled) is absorbing.
 */
function isToolTransitionAllowed(
  previous: ToolUpsertStatusV1,
  next: ToolUpsertStatusV1,
): boolean {
  if (previous === next) return true;
  switch (previous) {
    case 'requested':
      return next === 'awaiting_approval'
        || next === 'running'
        || next === 'cancelled'
        || next === 'failed'
        || next === 'succeeded';
    case 'awaiting_approval':
      return next === 'running'
        || next === 'cancelled'
        || next === 'failed';
    case 'running':
      return next === 'succeeded' || next === 'failed' || next === 'cancelled';
    default:
      return false;
  }
}

/**
 * Monotonic task state machine.
 * Allowed transitions:
 *   queued ↔ waiting/blocked
 *   queued → running → (completed | failed | cancelled | blocked | waiting)
 *   waiting/blocked → running → terminal
 * Terminal (completed | failed | cancelled) is absorbing.
 */
function isTaskTransitionAllowed(
  previous: TaskUpsertStatusV1,
  next: TaskUpsertStatusV1,
): boolean {
  if (previous === next) return true;
  switch (previous) {
    case 'queued':
    case 'waiting':
    case 'blocked':
      return next !== previous; // any non-terminal-restricted transition
    case 'running':
      return next === 'completed'
        || next === 'failed'
        || next === 'cancelled'
        || next === 'blocked'
        || next === 'waiting';
    default:
      return false;
  }
}

/**
 * Monotonic approval state machine.
 * Allowed transitions:
 *   pending → (approved | rejected | expired | superseded)
 * Terminal states are absorbing.
 */
function isApprovalTransitionAllowed(
  previous: ApprovalUpsertStatusV1,
  next: ApprovalUpsertStatusV1,
): boolean {
  if (previous === next) return true;
  return previous === 'pending'
    && (next === 'approved' || next === 'rejected' || next === 'expired' || next === 'superseded');
}

/** Map a terminal chat event type to a turn-status terminal state. */
function terminalEventToStatus(
  eventType: string,
): TurnStatusBlockV1['content']['state'] | undefined {
  switch (eventType) {
    case RESPONSE_COMPOSITION_EVENT_TYPES.responseCompleted: return 'completed';
    case RESPONSE_COMPOSITION_EVENT_TYPES.responseStopped: return 'cancelled';
    case RESPONSE_COMPOSITION_EVENT_TYPES.responseInterrupted: return 'interrupted';
    case RESPONSE_COMPOSITION_EVENT_TYPES.responseFailed: return 'failed';
    default: return undefined;
  }
}

/** Map a canonical error class to the ErrorBlockV1 recoveryState enum. */
function recoveryStateFromErrorClass(
  errorClass: ChatStreamErrorClassV1,
): ErrorBlockV1['content']['recoveryState'] {
  switch (errorClass) {
    case 'network':
    case 'stream_gap':
      return 'interrupted';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'failed';
  }
}



function messageTarget(
  event: SessionEventV1,
  messages: ReadonlyMap<string, MessageProjectionState>,
  turnOwner: ReadonlyMap<string, string>,
): MessageProjectionState | undefined {
  const payload = asRecord(event.payload);
  const explicitMessageId = stringField(payload, 'messageId');
  if (explicitMessageId !== undefined) return messages.get(explicitMessageId);
  const canonicalId = canonicalMessageId(payload);
  if (canonicalId !== undefined && messages.has(canonicalId)) return messages.get(canonicalId);
  const turnId = stringField(payload, 'turnId') ?? canonicalTurnId(payload);
  return turnId === undefined ? undefined : messages.get(turnOwner.get(turnId) ?? '');
}

function canonicalizeTypedBlock(
  block: ResponseBlockV1,
  state: MessageProjectionState,
  sessionId: string,
  branchId: string,
  chatNodeStableKey: string,
): ResponseBlockV1 {
  const stableKey = responseBlockKey(
    sessionId,
    branchId,
    state.messageId,
    block.kind,
    block.sourceIdentity.entityId,
    block.role,
  );
  return {
    ...block,
    stableKey,
    semanticAnchor: semanticAnchor(chatNodeStableKey, block.kind, block.sourceIdentity.entityId),
  } as ResponseBlockV1;
}

function addStructuredEntry(
  state: MessageProjectionState,
  block: ResponseBlockV1,
  declaredOrder: number,
  sequence: number,
): void {
  const existing = state.structured.get(block.stableKey);
  state.structured.set(block.stableKey, {
    block,
    declaredOrder: existing?.declaredOrder ?? declaredOrder,
    firstSequence: existing?.firstSequence ?? sequence,
    latestSequence: sequence,
  });
  state.sourceRevision = Math.max(state.sourceRevision, sequence);
}

function assembleStreamingText(facts: readonly OrderedTextFact[]): string {
  const ordered = [...facts].sort(compareTextFacts);
  let text = '';
  for (const fact of ordered) {
    if (fact.snapshot) {
      if (fact.text.startsWith(text)) text = fact.text;
      else if (!text.includes(fact.text)) text += fact.text;
      continue;
    }
    text += fact.text;
  }
  return text;
}

function latestFinalFact(facts: readonly OrderedTextFact[]): OrderedTextFact | undefined {
  return [...facts]
    .filter((fact) => fact.finalized)
    .sort((left, right) =>
      left.attempt - right.attempt
      || left.sequence - right.sequence
      || left.eventId.localeCompare(right.eventId),
    )
    .at(-1);
}

function compositionEqual(left: ResponseCompositionV1, right: ResponseCompositionV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Projects the same ordered SessionEventV1 prefix consumed by CanonicalTimelineReducer
 * into stable assistant response compositions. It owns no durable event storage beyond
 * the accepted prefix needed for deterministic replay and emits no renderer-local state.
 */
export class ResponseCompositionProjector {
  private readonly events = new Map<string, SessionEventV1>();
  private compositions = new Map<string, ResponseCompositionV1>();
  private compositionOrder = new Map<string, number>();
  private projectionRevision = 0;
  private sourceSequence = -1;

  constructor(
    private readonly sessionId: string,
    private readonly branchId: string,
  ) {}

  reduce(events: readonly SessionEventV1[]): ResponseCompositionDeltaV1 {
    const immediateDiagnostics: ResponseCompositionProjectionDiagnosticV1[] = [];
    const acceptedEventIds = new Set<string>();

    for (const event of events) {
      if (event.sessionId !== this.sessionId || event.branchId !== this.branchId) {
        immediateDiagnostics.push(diagnostic(event, 'incompatible_scope'));
        continue;
      }
      const existing = this.events.get(event.eventId);
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(event)) {
          immediateDiagnostics.push(diagnostic(event, 'duplicate_event_id'));
        }
        continue;
      }
      this.events.set(event.eventId, event);
      acceptedEventIds.add(event.eventId);
      this.sourceSequence = Math.max(this.sourceSequence, event.sequence);
    }

    const previous = this.compositions;
    const built = this.build([...this.events.values()].sort(compareEvents));
    const next = new Map(built.compositions.map((composition) => [composition.chatNodeStableKey, composition]));
    const added: ResponseCompositionV1[] = [];
    const updated: ResponseCompositionV1[] = [];
    const removed: string[] = [];

    for (const composition of built.compositions) {
      const prior = previous.get(composition.chatNodeStableKey);
      if (prior === undefined) added.push(composition);
      else if (!compositionEqual(prior, composition)) updated.push(composition);
    }
    for (const stableKey of previous.keys()) {
      if (!next.has(stableKey)) removed.push(stableKey);
    }

    if (added.length > 0 || updated.length > 0 || removed.length > 0) {
      this.projectionRevision++;
    }
    this.compositions = next;
    this.compositionOrder = new Map(built.order);

    return {
      added,
      updated,
      removed,
      projectionRevision: this.projectionRevision,
      sourceSequence: this.sourceSequence,
      diagnostics: [
        ...immediateDiagnostics,
        ...built.diagnostics.filter((entry) => acceptedEventIds.has(entry.eventId)),
      ],
    };
  }

  getComposition(chatNodeStableKey: string): ResponseCompositionV1 | undefined {
    return this.compositions.get(chatNodeStableKey);
  }

  getCompositions(): readonly ResponseCompositionV1[] {
    return [...this.compositions.values()].sort((left, right) =>
      (this.compositionOrder.get(left.chatNodeStableKey) ?? 0)
      - (this.compositionOrder.get(right.chatNodeStableKey) ?? 0)
      || left.chatNodeStableKey.localeCompare(right.chatNodeStableKey),
    );
  }

  getProjectionRevision(): number {
    return this.projectionRevision;
  }

  getSourceSequence(): number {
    return this.sourceSequence;
  }

  reset(): void {
    this.events.clear();
    this.compositions.clear();
    this.compositionOrder.clear();
    this.projectionRevision = 0;
    this.sourceSequence = -1;
  }

  private build(events: readonly SessionEventV1[]): BuildResult {
    const diagnostics: ResponseCompositionProjectionDiagnosticV1[] = [];
    const seeds = new Map<string, MessageSeed>();
    const turnOwner = new Map<string, string>();

    for (const event of events) {
      // Legacy `message.assistant` seed path.
      if (event.eventType === 'message.assistant') {
        const payload = asRecord(event.payload);
        const messageId = stringField(payload, 'messageId') ?? event.eventId;
        const turnId = stringField(payload, 'turnId');
        if (turnId === undefined) {
          diagnostics.push(diagnostic(event, 'orphan_event'));
          continue;
        }
        if (!seeds.has(messageId)) {
          seeds.set(messageId, {
            messageId,
            turnId,
            firstSequence: event.sequence,
            firstOccurredAt: event.occurredAt,
          });
        }
        if (!turnOwner.has(turnId)) turnOwner.set(turnId, messageId);
        continue;
      }

      // Canonical `response.started` seed path.
      if (event.eventType === RESPONSE_COMPOSITION_EVENT_TYPES.responseStarted) {
        const payload = asRecord(event.payload);
        const parsed = ResponseStartedV1Schema.safeParse(payload);
        if (!parsed.success) continue; // handled below with an invalid_payload diagnostic
        const messageId = parsed.data.identity.responseId;
        const turnId = parsed.data.identity.turnId;
        if (!seeds.has(messageId)) {
          seeds.set(messageId, {
            messageId,
            turnId,
            firstSequence: event.sequence,
            firstOccurredAt: event.occurredAt,
          });
        }
        if (!turnOwner.has(turnId)) turnOwner.set(turnId, messageId);
        continue;
      }
    }

    const messages = new Map<string, MessageProjectionState>();
    for (const seed of seeds.values()) {
      messages.set(seed.messageId, {
        ...seed,
        messageFacts: [],
        deltas: [],
        reasoning: [],
        reasoningCategories: new Set(),
        statuses: [],
        structured: new Map(),
        canonicalAnswerDeltas: [],
        canonicalReasoningDeltas: [],
        thinkingSteps: new Map(),
        tools: new Map(),
        tasks: new Map(),
        approvals: new Map(),
        blockErrors: new Map(),
        sourceRevision: seed.firstSequence,
      });
    }

    const compactedStableKeys = new Set<string>();

    for (const event of events) {
      const payload = asRecord(event.payload);
      if (event.eventType === 'compaction') {
        const removed = payload['removedStableKeys'];
        if (Array.isArray(removed)) {
          for (const key of removed) if (typeof key === 'string') compactedStableKeys.add(key);
        }
        continue;
      }

      const state = messageTarget(event, messages, turnOwner);
      if (event.eventType === 'message.assistant') {
        if (state === undefined) continue;
        const text = stringField(payload, 'content', 'text') ?? '';
        const explicitlyFinalized = payload['finalized'];
        state.messageFacts.push({
          eventId: event.eventId,
          sequence: event.sequence,
          attempt: nonnegativeInteger(payload, 'attempt'),
          ordinal: nonnegativeInteger(payload, 'ordinal'),
          text,
          finalized: explicitlyFinalized === true
            || (explicitlyFinalized === undefined && text.length > 0),
          format: payload['format'] === 'plain_stream' ? 'plain_stream' : 'markdown',
          snapshot: true,
        });
        state.sourceRevision = Math.max(state.sourceRevision, event.sequence);
        continue;
      }

      if (event.eventType === 'assistant.delta') {
        if (state === undefined) {
          diagnostics.push(diagnostic(event, 'orphan_event'));
          continue;
        }
        state.deltas.push({
          eventId: event.eventId,
          sequence: event.sequence,
          attempt: nonnegativeInteger(payload, 'attempt'),
          ordinal: nonnegativeInteger(payload, 'ordinal'),
          text: stringField(payload, 'text', 'content') ?? '',
          finalized: false,
          snapshot: payload['mode'] === 'snapshot' || payload['source'] === 'terminal',
        });
        state.sourceRevision = Math.max(state.sourceRevision, event.sequence);
        continue;
      }

      if (event.eventType === 'assistant.reasoning') {
        if (state === undefined) {
          diagnostics.push(diagnostic(event, 'orphan_event'));
          continue;
        }
        const category = payload['category'];
        const typedCategory = REASONING_CATEGORIES.has(category as never)
          ? category as ReasoningBlockV1['content']['categories'][number]
          : 'summary';
        state.reasoningCategories.add(typedCategory);
        state.reasoning.push({
          eventId: event.eventId,
          sequence: event.sequence,
          attempt: nonnegativeInteger(payload, 'attempt'),
          ordinal: nonnegativeInteger(payload, 'ordinal'),
          text: stringField(payload, 'text', 'content') ?? '',
          finalized: false,
          snapshot: false,
        });
        state.sourceRevision = Math.max(state.sourceRevision, event.sequence);
        continue;
      }

      if (event.eventType === 'assistant.state') {
        if (state === undefined) {
          diagnostics.push(diagnostic(event, 'orphan_event'));
          continue;
        }
        const status = mapStatusState(payload['state'] ?? payload['activityState']);
        if (status !== undefined) {
          state.statuses.push({
            sequence: event.sequence,
            state: status,
            occurredAt: event.occurredAt,
            terminal: TERMINAL_STATES.has(status),
            cancellationAvailable: typeof payload['cancellationAvailable'] === 'boolean'
              ? payload['cancellationAvailable']
              : undefined,
            cancellationUnavailableReason: stringField(payload, 'cancellationUnavailableReason'),
          });
          state.sourceRevision = Math.max(state.sourceRevision, event.sequence);
        }
        continue;
      }

      if (event.eventType === 'connection.state') {
        if (state === undefined) {
          diagnostics.push(diagnostic(event, 'orphan_event'));
          continue;
        }
        if (payload['state'] === 'reconnecting') {
          state.statuses.push({
            sequence: event.sequence,
            state: 'reconnecting',
            occurredAt: event.occurredAt,
            terminal: false,
            cancellationAvailable: typeof payload['cancellationAvailable'] === 'boolean'
              ? payload['cancellationAvailable']
              : undefined,
          });
          state.sourceRevision = Math.max(state.sourceRevision, event.sequence);
        }
        continue;
      }

      if (event.eventType === 'retry') {
        if (state === undefined) {
          diagnostics.push(diagnostic(event, 'orphan_event'));
          continue;
        }
        state.statuses.push({
          sequence: event.sequence,
          state: 'retrying',
          occurredAt: event.occurredAt,
          terminal: false,
        });
        state.sourceRevision = Math.max(state.sourceRevision, event.sequence);
        continue;
      }

      if (event.eventType === 'turn.tail') {
        if (state === undefined) {
          diagnostics.push(diagnostic(event, 'orphan_event'));
          continue;
        }
        const status = stateFromTail(payload['outcome']);
        if (status !== undefined) {
          state.statuses.push({
            sequence: event.sequence,
            state: status,
            occurredAt: event.occurredAt,
            terminal: true,
          });
          state.sourceRevision = Math.max(state.sourceRevision, event.sequence);
        }
        continue;
      }

      if (event.eventType === 'error') {
        if (state === undefined) {
          diagnostics.push(diagnostic(event, 'orphan_event'));
          continue;
        }
        const chatNodeStableKey = computeStableKey(
          this.sessionId,
          this.branchId,
          'message',
          state.messageId,
          'assistant',
        );
        const errorId = stringField(payload, 'errorId') ?? event.eventId;
        const block: ErrorBlockV1 = {
          schemaVersion: 1,
          stableKey: responseBlockKey(
            this.sessionId,
            this.branchId,
            state.messageId,
            'error',
            errorId,
            'detail',
          ),
          kind: 'error',
          role: 'detail',
          semanticAnchor: semanticAnchor(chatNodeStableKey, 'error', errorId),
          sourceIdentity: {
            sessionId: this.sessionId,
            branchId: this.branchId,
            turnId: state.turnId,
            entityId: errorId,
          },
          contentRevision: 0,
          status: 'terminal',
          permittedSummary: boundedSummary(stringField(payload, 'summary', 'message'), 'Assistant response failed'),
          content: {
            errorId,
            errorClass: stringField(payload, 'errorClass') ?? 'unknown',
            summary: boundedSummary(stringField(payload, 'summary', 'message'), 'Assistant response failed'),
            affectedIdentity: stringField(payload, 'affectedIdentity') ?? state.messageId,
            lastVerifiedState: boundedSummary(stringField(payload, 'lastVerifiedState'), 'partial response retained'),
            correlationId: stringField(payload, 'correlationId') ?? event.eventId,
            recoveryState: 'failed',
            ...(stringField(payload, 'partialContent') !== undefined
              ? { partialContent: stringField(payload, 'partialContent') }
              : {}),
          },
        };
        addStructuredEntry(state, block, finiteOrder(payload, event.sequence), event.sequence);
        state.statuses.push({
          sequence: event.sequence,
          state: 'failed',
          occurredAt: event.occurredAt,
          terminal: true,
        });
        continue;
      }

      if (event.eventType === RESPONSE_COMPOSITION_EVENT_TYPES.block) {
        if (state === undefined) {
          diagnostics.push(diagnostic(event, 'orphan_event'));
          continue;
        }
        const parsed = ResponseBlockV1Schema.safeParse(payload['block']);
        if (!parsed.success) {
          diagnostics.push(diagnostic(event, 'invalid_block'));
          continue;
        }
        if (RESERVED_PROJECTED_BLOCK_KINDS.has(parsed.data.kind)) {
          diagnostics.push(diagnostic(event, 'reserved_block_kind'));
          continue;
        }
        if (
          parsed.data.sourceIdentity.sessionId !== this.sessionId
          || parsed.data.sourceIdentity.branchId !== this.branchId
          || parsed.data.sourceIdentity.turnId !== state.turnId
        ) {
          diagnostics.push(diagnostic(event, 'source_identity_mismatch'));
          continue;
        }
        const chatNodeStableKey = computeStableKey(
          this.sessionId,
          this.branchId,
          'message',
          state.messageId,
          'assistant',
        );
        addStructuredEntry(
          state,
          canonicalizeTypedBlock(
            parsed.data,
            state,
            this.sessionId,
            this.branchId,
            chatNodeStableKey,
          ),
          finiteOrder(payload, event.sequence),
          event.sequence,
        );
        continue;
      }

      if (event.eventType === RESPONSE_COMPOSITION_EVENT_TYPES.actions) {
        if (state === undefined) {
          diagnostics.push(diagnostic(event, 'orphan_event'));
          continue;
        }
        const parsedActions = ActionDescriptorV1Schema.array().min(2).max(4).safeParse(payload['actions']);
        const entityId = stringField(payload, 'actionGroupId', 'entityId');
        if (!parsedActions.success || entityId === undefined) {
          diagnostics.push(diagnostic(event, 'invalid_actions'));
          continue;
        }
        const chatNodeStableKey = computeStableKey(
          this.sessionId,
          this.branchId,
          'message',
          state.messageId,
          'assistant',
        );
        const block: FollowUpActionsBlockV1 = {
          schemaVersion: 1,
          stableKey: responseBlockKey(
            this.sessionId,
            this.branchId,
            state.messageId,
            'follow_up_actions',
            entityId,
            'actions',
          ),
          kind: 'follow_up_actions',
          role: 'actions',
          semanticAnchor: semanticAnchor(chatNodeStableKey, 'follow_up_actions', entityId),
          sourceIdentity: {
            sessionId: this.sessionId,
            branchId: this.branchId,
            turnId: state.turnId,
            entityId,
          },
          contentRevision: nonnegativeInteger(payload, 'contentRevision'),
          status: 'ready',
          content: {
            sourceRevision: nonnegativeInteger(payload, 'sourceRevision', event.sequence),
            actions: parsedActions.data as ActionDescriptorV1[],
          },
        };
        addStructuredEntry(state, block, finiteOrder(payload, event.sequence), event.sequence);
        continue;
      }

      // ─── Canonical chat stream events (Task 7.1 payloads) ────────────

      if (event.eventType === RESPONSE_COMPOSITION_EVENT_TYPES.responseStarted) {
        const parsed = ResponseStartedV1Schema.safeParse(payload);
        if (!parsed.success) {
          diagnostics.push(diagnostic(event, 'invalid_payload'));
          continue;
        }
        if (state === undefined) {
          diagnostics.push(diagnostic(event, 'orphan_event'));
          continue;
        }
        // Multiple started events for the same response are diagnosed but do
        // not overwrite the first accepted metadata. Duplicate event IDs are
        // already rejected at the top level; a second started with a different
        // event ID indicates a retry lineage error.
        if (state.canonicalStarted !== undefined) {
          diagnostics.push(diagnostic(event, 'duplicate_terminal'));
          continue;
        }
        state.canonicalStarted = {
          responseId: parsed.data.identity.responseId,
          requestId: parsed.data.identity.requestId,
          attempt: parsed.data.identity.attempt,
          agentId: parsed.data.agentId,
          transportClass: parsed.data.route.transportClass,
          provider: parsed.data.route.provider,
          model: parsed.data.route.model,
          edition: parsed.data.route.edition,
          sequence: event.sequence,
        };
        state.sourceRevision = Math.max(state.sourceRevision, event.sequence);
        continue;
      }

      if (event.eventType === RESPONSE_COMPOSITION_EVENT_TYPES.answerDelta) {
        const parsed = AnswerDeltaV1Schema.safeParse(payload);
        if (!parsed.success) {
          diagnostics.push(diagnostic(event, 'invalid_payload'));
          continue;
        }
        if (state === undefined) {
          diagnostics.push(diagnostic(event, 'orphan_event'));
          continue;
        }
        // Cross-scope checks: block identity must match the correlated response.
        if (
          parsed.data.blockIdentity.sourceIdentity.sessionId !== this.sessionId
          || parsed.data.blockIdentity.sourceIdentity.branchId !== this.branchId
          || parsed.data.blockIdentity.sourceIdentity.turnId !== state.turnId
        ) {
          diagnostics.push(diagnostic(event, 'source_identity_mismatch'));
          continue;
        }
        state.canonicalAnswerDeltas.push({
          eventId: event.eventId,
          sequence: event.sequence,
          attempt: parsed.data.identity.attempt,
          text: parsed.data.delta,
        });
        state.sourceRevision = Math.max(state.sourceRevision, event.sequence);
        continue;
      }

      if (event.eventType === RESPONSE_COMPOSITION_EVENT_TYPES.reasoningDelta) {
        const parsed = ReasoningDeltaV1Schema.safeParse(payload);
        if (!parsed.success) {
          diagnostics.push(diagnostic(event, 'invalid_payload'));
          continue;
        }
        if (state === undefined) {
          diagnostics.push(diagnostic(event, 'orphan_event'));
          continue;
        }
        if (
          parsed.data.blockIdentity.sourceIdentity.sessionId !== this.sessionId
          || parsed.data.blockIdentity.sourceIdentity.branchId !== this.branchId
          || parsed.data.blockIdentity.sourceIdentity.turnId !== state.turnId
        ) {
          diagnostics.push(diagnostic(event, 'source_identity_mismatch'));
          continue;
        }
        state.canonicalReasoningDeltas.push({
          eventId: event.eventId,
          sequence: event.sequence,
          attempt: parsed.data.identity.attempt,
          text: parsed.data.delta,
          label: parsed.data.label,
        });
        state.sourceRevision = Math.max(state.sourceRevision, event.sequence);
        continue;
      }

      if (event.eventType === RESPONSE_COMPOSITION_EVENT_TYPES.thinkingStepUpserted) {
        const parsed = ThinkingStepUpsertV1Schema.safeParse(payload);
        if (!parsed.success) {
          diagnostics.push(diagnostic(event, 'invalid_payload'));
          continue;
        }
        if (state === undefined) {
          diagnostics.push(diagnostic(event, 'orphan_event'));
          continue;
        }
        const stepId = parsed.data.stepId;
        const previous = state.thinkingSteps.get(stepId);
        if (previous !== undefined && parsed.data.revision <= previous.revision) {
          diagnostics.push(diagnostic(event, 'stale_revision'));
          continue;
        }
        if (previous !== undefined
          && !isThinkingStepTransitionAllowed(previous.state, parsed.data.state)) {
          diagnostics.push(diagnostic(event, 'invalid_state_transition'));
          continue;
        }
        state.thinkingSteps.set(stepId, {
          stepId,
          revision: parsed.data.revision,
          orderIndex: parsed.data.orderIndex,
          kind: parsed.data.kind,
          state: parsed.data.state,
          label: parsed.data.label,
          startedAt: parsed.data.startedAt ?? previous?.startedAt,
          terminalAt: parsed.data.terminalAt ?? previous?.terminalAt,
          firstSequence: previous?.firstSequence ?? event.sequence,
          latestSequence: event.sequence,
        });
        state.sourceRevision = Math.max(state.sourceRevision, event.sequence);
        continue;
      }

      if (event.eventType === RESPONSE_COMPOSITION_EVENT_TYPES.toolUpserted) {
        const parsed = ToolUpsertV1Schema.safeParse(payload);
        if (!parsed.success) {
          diagnostics.push(diagnostic(event, 'invalid_payload'));
          continue;
        }
        if (state === undefined) {
          diagnostics.push(diagnostic(event, 'orphan_event'));
          continue;
        }
        const callId = parsed.data.callId;
        const previous = state.tools.get(callId);
        if (previous !== undefined && parsed.data.revision <= previous.revision) {
          diagnostics.push(diagnostic(event, 'stale_revision'));
          continue;
        }
        if (previous !== undefined
          && !isToolTransitionAllowed(previous.status, parsed.data.status)) {
          diagnostics.push(diagnostic(event, 'invalid_state_transition'));
          continue;
        }
        const details = parsed.data.details;
        state.tools.set(callId, {
          callId,
          revision: parsed.data.revision,
          modelOrderIndex: parsed.data.modelOrderIndex,
          toolName: parsed.data.toolName,
          status: parsed.data.status,
          inputSummary: details?.inputSummary ?? previous?.inputSummary,
          outputSummary: details?.outputSummary ?? previous?.outputSummary,
          errorSummary: details?.errorSummary ?? previous?.errorSummary,
          firstSequence: previous?.firstSequence ?? event.sequence,
          latestSequence: event.sequence,
        });
        state.sourceRevision = Math.max(state.sourceRevision, event.sequence);
        continue;
      }

      if (event.eventType === RESPONSE_COMPOSITION_EVENT_TYPES.taskUpserted) {
        const parsed = TaskUpsertV1Schema.safeParse(payload);
        if (!parsed.success) {
          diagnostics.push(diagnostic(event, 'invalid_payload'));
          continue;
        }
        if (state === undefined) {
          diagnostics.push(diagnostic(event, 'orphan_event'));
          continue;
        }
        const taskId = parsed.data.taskId;
        const previous = state.tasks.get(taskId);
        if (previous !== undefined && parsed.data.revision <= previous.revision) {
          diagnostics.push(diagnostic(event, 'stale_revision'));
          continue;
        }
        if (previous !== undefined
          && !isTaskTransitionAllowed(previous.status, parsed.data.status)) {
          diagnostics.push(diagnostic(event, 'invalid_state_transition'));
          continue;
        }
        state.tasks.set(taskId, {
          taskId,
          revision: parsed.data.revision,
          orderIndex: parsed.data.orderIndex,
          description: parsed.data.description,
          status: parsed.data.status,
          progress: parsed.data.progress ?? previous?.progress,
          outcome: parsed.data.outcome ?? previous?.outcome,
          errorSummary: parsed.data.errorSummary ?? previous?.errorSummary,
          firstSequence: previous?.firstSequence ?? event.sequence,
          latestSequence: event.sequence,
        });
        state.sourceRevision = Math.max(state.sourceRevision, event.sequence);
        continue;
      }

      if (event.eventType === RESPONSE_COMPOSITION_EVENT_TYPES.approvalUpserted) {
        const parsed = ApprovalUpsertV1Schema.safeParse(payload);
        if (!parsed.success) {
          diagnostics.push(diagnostic(event, 'invalid_payload'));
          continue;
        }
        if (state === undefined) {
          diagnostics.push(diagnostic(event, 'orphan_event'));
          continue;
        }
        const collaborationId = parsed.data.collaborationId;
        const previous = state.approvals.get(collaborationId);
        if (previous !== undefined && parsed.data.revision <= previous.revision) {
          diagnostics.push(diagnostic(event, 'stale_revision'));
          continue;
        }
        if (previous !== undefined
          && !isApprovalTransitionAllowed(previous.status, parsed.data.status)) {
          diagnostics.push(diagnostic(event, 'invalid_state_transition'));
          continue;
        }
        state.approvals.set(collaborationId, {
          collaborationId,
          revision: parsed.data.revision,
          orderIndex: parsed.data.orderIndex,
          actionSummary: parsed.data.actionSummary,
          scopeSummary: parsed.data.scopeSummary ?? previous?.scopeSummary,
          riskSummary: parsed.data.riskSummary ?? previous?.riskSummary,
          status: parsed.data.status,
          contractRevision: parsed.data.contractRevision,
          contractDigest: parsed.data.contractDigest,
          expiresAt: parsed.data.expiresAt ?? previous?.expiresAt,
          firstSequence: previous?.firstSequence ?? event.sequence,
          latestSequence: event.sequence,
        });
        state.sourceRevision = Math.max(state.sourceRevision, event.sequence);
        continue;
      }

      if (event.eventType === RESPONSE_COMPOSITION_EVENT_TYPES.usageReported) {
        const parsed = UsageReportedV1Schema.safeParse(payload);
        if (!parsed.success) {
          diagnostics.push(diagnostic(event, 'invalid_payload'));
          continue;
        }
        if (state === undefined) {
          diagnostics.push(diagnostic(event, 'orphan_event'));
          continue;
        }
        const usageBlock = parsed.data.providerBlock.block;
        // Later usage reports supersede earlier ones (monotonic wall-clock).
        if (state.usage === undefined || state.usage.reportedAtSequence <= event.sequence) {
          state.usage = {
            reportedAtSequence: event.sequence,
            inputTokens: usageBlock.inputTokens,
            outputTokens: usageBlock.outputTokens,
            totalTokens: usageBlock.totalTokens,
            cacheReadTokens: usageBlock.cacheReadTokens,
            cacheWriteTokens: usageBlock.cacheWriteTokens,
          };
        }
        state.sourceRevision = Math.max(state.sourceRevision, event.sequence);
        continue;
      }

      if (event.eventType === RESPONSE_COMPOSITION_EVENT_TYPES.blockError) {
        const parsed = BlockScopedErrorV1Schema.safeParse(payload);
        if (!parsed.success) {
          diagnostics.push(diagnostic(event, 'invalid_payload'));
          continue;
        }
        if (state === undefined) {
          diagnostics.push(diagnostic(event, 'orphan_event'));
          continue;
        }
        const errorId = parsed.data.errorId;
        const previous = state.blockErrors.get(errorId);
        state.blockErrors.set(errorId, {
          errorId,
          errorClass: parsed.data.errorClass,
          summary: parsed.data.summary,
          correlationId: parsed.data.correlationId,
          recoverable: parsed.data.recoverable,
          affectedStableKey: parsed.data.blockIdentity.stableKey,
          affectedEntityId: parsed.data.blockIdentity.sourceIdentity.entityId,
          affectedEventType: parsed.data.affectedEventType,
          firstSequence: previous?.firstSequence ?? event.sequence,
          latestSequence: event.sequence,
        });
        state.sourceRevision = Math.max(state.sourceRevision, event.sequence);
        continue;
      }

      if (CANONICAL_TERMINAL_EVENT_TYPES.has(event.eventType)) {
        const schema = event.eventType === RESPONSE_COMPOSITION_EVENT_TYPES.responseCompleted
          ? ResponseCompletedV1Schema
          : event.eventType === RESPONSE_COMPOSITION_EVENT_TYPES.responseStopped
            ? ResponseStoppedV1Schema
            : event.eventType === RESPONSE_COMPOSITION_EVENT_TYPES.responseInterrupted
              ? ResponseInterruptedV1Schema
              : ResponseFailedV1Schema;
        const parsed = schema.safeParse(payload);
        if (!parsed.success) {
          diagnostics.push(diagnostic(event, 'invalid_payload'));
          continue;
        }
        if (state === undefined) {
          diagnostics.push(diagnostic(event, 'orphan_event'));
          continue;
        }
        // Terminal compare-and-set: first accepted terminal wins.
        if (state.canonicalTerminal !== undefined) {
          diagnostics.push(diagnostic(event, 'duplicate_terminal'));
          continue;
        }
        const terminalState = parsed.data.terminalState as
          | 'completed'
          | 'stopped'
          | 'interrupted'
          | 'failed';
        const failureFields = terminalState === 'interrupted' || terminalState === 'failed'
          ? {
              errorClass: (parsed.data as ResponseInterruptedV1 | ResponseFailedV1).errorClass,
              errorId: (parsed.data as ResponseInterruptedV1 | ResponseFailedV1).errorId,
              summary: (parsed.data as ResponseInterruptedV1 | ResponseFailedV1).summary,
              correlationId: (parsed.data as ResponseInterruptedV1 | ResponseFailedV1).correlationId,
            }
          : {};
        const retryFields = terminalState === 'stopped'
          || terminalState === 'interrupted'
          || terminalState === 'failed'
          ? {
              retryable: (parsed.data as ResponseStoppedV1 | ResponseInterruptedV1 | ResponseFailedV1)
                .retry?.retryable,
              retryAfterMs: (parsed.data as ResponseStoppedV1 | ResponseInterruptedV1 | ResponseFailedV1)
                .retry?.retryAfterMs,
            }
          : {};
        const reasonField = terminalState === 'stopped'
          ? { reason: (parsed.data as ResponseStoppedV1).reason }
          : {};
        state.canonicalTerminal = {
          terminalState,
          sequence: event.sequence,
          occurredAt: event.occurredAt,
          partialContentRetained: parsed.data.partialContentRetained,
          ...failureFields,
          ...retryFields,
          ...reasonField,
        };
        state.statuses.push({
          sequence: event.sequence,
          state: terminalState === 'stopped' ? 'cancelled' : terminalState,
          occurredAt: event.occurredAt,
          terminal: true,
        });
        state.sourceRevision = Math.max(state.sourceRevision, event.sequence);
        continue;
      }
    }

    const compositions: ResponseCompositionV1[] = [];
    const order = new Map<string, number>();

    for (const state of messages.values()) {
      const chatNodeStableKey = computeStableKey(
        this.sessionId,
        this.branchId,
        'message',
        state.messageId,
        'assistant',
      );
      if (compactedStableKeys.has(chatNodeStableKey)) continue;

      const compositionAnchor = `response:${chatNodeStableKey}`;
      const blocks: ResponseBlockV1[] = [];
      const ownsTurnStatus = turnOwner.get(state.turnId) === state.messageId;
      const sortedStatuses = [...state.statuses].sort((left, right) => left.sequence - right.sequence);
      const currentStatus = sortedStatuses.at(-1);

      if (ownsTurnStatus) {
        const statusState = currentStatus?.state ?? (
          state.deltas.length > 0 || state.canonicalAnswerDeltas.length > 0 ? 'streaming' : 'reasoning'
        );
        const statusEntityId = state.turnId;
        const statusBlock: TurnStatusBlockV1 = {
          schemaVersion: 1,
          stableKey: responseBlockKey(
            this.sessionId,
            this.branchId,
            state.messageId,
            'turn_status',
            statusEntityId,
            'status',
          ),
          kind: 'turn_status',
          role: 'status',
          semanticAnchor: semanticAnchor(chatNodeStableKey, 'turn_status', statusEntityId),
          sourceIdentity: {
            sessionId: this.sessionId,
            branchId: this.branchId,
            turnId: state.turnId,
            entityId: statusEntityId,
          },
          contentRevision: Math.max(0, sortedStatuses.length - 1),
          status: TERMINAL_STATES.has(statusState) ? 'terminal' : 'streaming',
          permittedSummary: statusState.replaceAll('_', ' '),
          content: {
            state: statusState,
            label: statusState.replaceAll('_', ' '),
            startedAt: state.firstOccurredAt,
            ...(currentStatus?.terminal ? { terminalAt: currentStatus.occurredAt } : {}),
            ...(currentStatus?.cancellationAvailable !== undefined
              ? {
                  cancellation: {
                    available: currentStatus.cancellationAvailable,
                    ...(currentStatus.cancellationUnavailableReason !== undefined
                      ? { unavailableReason: currentStatus.cancellationUnavailableReason }
                      : {}),
                  },
                }
              : {}),
          },
        };
        blocks.push(statusBlock);
      }

      const canonicalTerminal = state.canonicalTerminal !== undefined;
      // Canonical reasoning deltas take precedence over the legacy
      // `assistant.reasoning` fallback because they retain the provider label
      // and separately correlated ordering.
      if (state.canonicalReasoningDeltas.length > 0) {
        const orderedDeltas = [...state.canonicalReasoningDeltas].sort(compareCanonicalDeltas);
        const reasoningText = orderedDeltas.map((delta) => delta.text).join('').slice(0, 4_096);
        const reasoningEntityId = `${state.messageId}:reasoning`;
        const hasSummaryLabel = orderedDeltas.some(
          (delta) => delta.label === 'model-provided-reasoning-summary',
        );
        const categories: ReasoningBlockV1['content']['categories'][number][] = hasSummaryLabel
          ? ['summary']
          : [];
        // Preserve any legacy categories that were also observed for the same
        // response so a mixed migration path still surfaces them.
        for (const category of state.reasoningCategories) {
          if (!categories.includes(category)) categories.push(category);
        }
        const reasoningBlock: ReasoningBlockV1 = {
          schemaVersion: 1,
          stableKey: responseBlockKey(
            this.sessionId,
            this.branchId,
            state.messageId,
            'reasoning',
            reasoningEntityId,
            'detail',
          ),
          kind: 'reasoning',
          role: 'detail',
          semanticAnchor: semanticAnchor(chatNodeStableKey, 'reasoning', reasoningEntityId),
          sourceIdentity: {
            sessionId: this.sessionId,
            branchId: this.branchId,
            turnId: state.turnId,
            entityId: reasoningEntityId,
          },
          contentRevision: Math.max(0, orderedDeltas.length - 1),
          status: canonicalTerminal ? 'terminal' : 'streaming',
          permittedSummary: reasoningText,
          content: {
            categories,
            summary: reasoningText,
            disclosure: 'permitted',
            finalized: canonicalTerminal,
          },
        };
        blocks.push(reasoningBlock);
      } else if (state.reasoning.length > 0) {
        const reasoningText = assembleStreamingText(state.reasoning);
        const reasoningEntityId = `${state.messageId}:reasoning`;
        const terminal = currentStatus !== undefined && currentStatus.terminal;
        const reasoningBlock: ReasoningBlockV1 = {
          schemaVersion: 1,
          stableKey: responseBlockKey(
            this.sessionId,
            this.branchId,
            state.messageId,
            'reasoning',
            reasoningEntityId,
            'detail',
          ),
          kind: 'reasoning',
          role: 'detail',
          semanticAnchor: semanticAnchor(chatNodeStableKey, 'reasoning', reasoningEntityId),
          sourceIdentity: {
            sessionId: this.sessionId,
            branchId: this.branchId,
            turnId: state.turnId,
            entityId: reasoningEntityId,
          },
          contentRevision: Math.max(0, state.reasoning.length - 1),
          status: terminal ? 'terminal' : 'streaming',
          permittedSummary: reasoningText.slice(0, 4_096),
          content: {
            categories: [...state.reasoningCategories],
            summary: reasoningText.slice(0, 4_096),
            disclosure: 'permitted',
            finalized: terminal,
          },
        };
        blocks.push(reasoningBlock);
      }

      // Narrative: canonical answer deltas are appended in ordered form; a
      // legacy `message.assistant` finalization or `assistant.delta` prefix
      // remains authoritative when the canonical path is empty.
      const finalFact = latestFinalFact(state.messageFacts);
      const canonicalAnswerText = state.canonicalAnswerDeltas.length > 0
        ? [...state.canonicalAnswerDeltas].sort(compareCanonicalDeltas)
          .map((delta) => delta.text).join('').slice(0, 100_000)
        : undefined;
      const narrativeText = finalFact?.text
        ?? canonicalAnswerText
        ?? assembleStreamingText([...state.messageFacts.filter((fact) => !fact.finalized), ...state.deltas]);
      const narrativeEntityId = state.messageId;
      const canonicalStreamingRevisions = state.canonicalAnswerDeltas.length;
      const narrativeContentRevision = Math.max(
        0,
        state.messageFacts.length + state.deltas.length + canonicalStreamingRevisions - 1,
      );
      const narrativeFinalized = finalFact !== undefined
        || (canonicalTerminal && state.canonicalTerminal!.terminalState === 'completed');
      const narrativeBlock: NarrativeBlockV1 = {
        schemaVersion: 1,
        stableKey: responseBlockKey(
          this.sessionId,
          this.branchId,
          state.messageId,
          'narrative',
          narrativeEntityId,
          'primary',
        ),
        kind: 'narrative',
        role: 'primary',
        semanticAnchor: semanticAnchor(chatNodeStableKey, 'narrative', narrativeEntityId),
        sourceIdentity: {
          sessionId: this.sessionId,
          branchId: this.branchId,
          turnId: state.turnId,
          entityId: narrativeEntityId,
        },
        contentRevision: narrativeContentRevision,
        status: narrativeFinalized
          ? 'terminal'
          : state.deltas.length > 0 || canonicalAnswerText !== undefined
            ? 'streaming'
            : 'pending',
        content: {
          format: finalFact?.format ?? (canonicalAnswerText !== undefined ? 'markdown' : 'plain_stream'),
          text: narrativeText,
          finalized: narrativeFinalized,
        },
      };
      blocks.push(narrativeBlock);

      // ─── Canonical structured blocks ─────────────────────────────
      // Thinking steps become a dedicated task_progress block keyed by
      // "thinking:<responseId>" to avoid identity collision with the user
      // task block. Renderers may present them together as the "Thinking Card"
      // per the design; the projector keeps their identity independent so
      // stale user-task upserts cannot regress progress rendering.
      if (state.thinkingSteps.size > 0) {
        const thinkingEntityId = `thinking:${state.messageId}`;
        const items = [...state.thinkingSteps.values()]
          .sort((left, right) =>
            left.orderIndex - right.orderIndex
            || left.firstSequence - right.firstSequence
            || left.stepId.localeCompare(right.stepId),
          )
          .slice(0, 1_000)
          .map<TaskProgressBlockV1['content']['items'][number]>((step) => ({
            taskId: step.stepId,
            taskKind: 'plan',
            title: step.label.slice(0, 4_096),
            owner: 'orchestration_engine',
            state: step.state === 'pending' ? 'queued' : step.state,
            ...(step.state === 'completed' ? { progress: 1 } : {}),
          }));
        const maxRevision = Math.max(
          0,
          ...[...state.thinkingSteps.values()].map((step) => step.revision),
        );
        const anyRunning = [...state.thinkingSteps.values()].some(
          (step) => step.state === 'running' || step.state === 'pending',
        );
        const thinkingBlock: TaskProgressBlockV1 = {
          schemaVersion: 1,
          stableKey: responseBlockKey(
            this.sessionId,
            this.branchId,
            state.messageId,
            'task_progress',
            thinkingEntityId,
            'evidence',
          ),
          kind: 'task_progress',
          role: 'evidence',
          semanticAnchor: semanticAnchor(chatNodeStableKey, 'task_progress', thinkingEntityId),
          sourceIdentity: {
            sessionId: this.sessionId,
            branchId: this.branchId,
            turnId: state.turnId,
            entityId: thinkingEntityId,
          },
          contentRevision: maxRevision,
          status: anyRunning && !canonicalTerminal ? 'streaming' : 'ready',
          content: {
            groupLabel: 'Thinking',
            items,
          },
        };
        blocks.push(thinkingBlock);
      }

      // Tools: one tool_activity block per callId.
      if (state.tools.size > 0) {
        const orderedTools = [...state.tools.values()].sort((left, right) =>
          left.modelOrderIndex - right.modelOrderIndex
          || left.firstSequence - right.firstSequence
          || left.callId.localeCompare(right.callId),
        );
        for (const tool of orderedTools) {
          const toolState: ToolActivityBlockV1['content']['state'] = tool.status === 'requested'
            ? 'planned'
            : tool.status === 'awaiting_approval'
              ? 'awaiting_approval'
              : tool.status === 'running'
                ? 'executing'
                : tool.status === 'succeeded'
                  ? 'completed'
                  : tool.status;
          const toolBlock: ToolActivityBlockV1 = {
            schemaVersion: 1,
            stableKey: responseBlockKey(
              this.sessionId,
              this.branchId,
              state.messageId,
              'tool_activity',
              tool.callId,
              'evidence',
            ),
            kind: 'tool_activity',
            role: 'evidence',
            semanticAnchor: semanticAnchor(chatNodeStableKey, 'tool_activity', tool.callId),
            sourceIdentity: {
              sessionId: this.sessionId,
              branchId: this.branchId,
              turnId: state.turnId,
              entityId: tool.callId,
            },
            contentRevision: tool.revision,
            status: toolState === 'completed'
              || toolState === 'failed'
              || toolState === 'cancelled'
              ? 'terminal'
              : toolState === 'awaiting_approval'
                ? 'pending'
                : 'streaming',
            ...(tool.outputSummary !== undefined
              ? { permittedSummary: tool.outputSummary.slice(0, 4_096) }
              : tool.errorSummary !== undefined
                ? { permittedSummary: tool.errorSummary.slice(0, 4_096) }
                : {}),
            content: {
              callId: tool.callId,
              modelOrderIndex: tool.modelOrderIndex,
              state: toolState,
              riskClass: 'unknown',
              owner: tool.toolName,
              retainedOutput: tool.outputSummary !== undefined ? 'inline' : 'unavailable',
            },
          };
          blocks.push(toolBlock);
        }
      }

      // Tasks: one aggregate task_progress block per response.
      if (state.tasks.size > 0) {
        const taskEntityId = `tasks:${state.messageId}`;
        const items = [...state.tasks.values()]
          .sort((left, right) =>
            left.orderIndex - right.orderIndex
            || left.firstSequence - right.firstSequence
            || left.taskId.localeCompare(right.taskId),
          )
          .slice(0, 1_000)
          .map<TaskProgressBlockV1['content']['items'][number]>((task) => ({
            taskId: task.taskId,
            taskKind: 'task',
            title: task.description.slice(0, 4_096),
            owner: 'orchestration_engine',
            state: task.status,
            ...(task.progress !== undefined ? { progress: task.progress } : {}),
            ...(task.outcome !== undefined
              ? { outcome: task.outcome.slice(0, 4_096) }
              : {}),
          }));
        const maxRevision = Math.max(
          0,
          ...[...state.tasks.values()].map((task) => task.revision),
        );
        const anyRunning = [...state.tasks.values()].some(
          (task) => task.status === 'running' || task.status === 'queued',
        );
        const tasksBlock: TaskProgressBlockV1 = {
          schemaVersion: 1,
          stableKey: responseBlockKey(
            this.sessionId,
            this.branchId,
            state.messageId,
            'task_progress',
            taskEntityId,
            'evidence',
          ),
          kind: 'task_progress',
          role: 'evidence',
          semanticAnchor: semanticAnchor(chatNodeStableKey, 'task_progress', taskEntityId),
          sourceIdentity: {
            sessionId: this.sessionId,
            branchId: this.branchId,
            turnId: state.turnId,
            entityId: taskEntityId,
          },
          contentRevision: maxRevision,
          status: anyRunning && !canonicalTerminal ? 'streaming' : 'ready',
          content: {
            groupLabel: 'Tasks',
            items,
          },
        };
        blocks.push(tasksBlock);
      }

      // Approvals: one decision block per collaborationId.
      if (state.approvals.size > 0) {
        const orderedApprovals = [...state.approvals.values()].sort((left, right) =>
          left.orderIndex - right.orderIndex
          || left.firstSequence - right.firstSequence
          || left.collaborationId.localeCompare(right.collaborationId),
        );
        for (const approval of orderedApprovals) {
          const decisionBlock: DecisionBlockV1 = {
            schemaVersion: 1,
            stableKey: responseBlockKey(
              this.sessionId,
              this.branchId,
              state.messageId,
              'decision',
              approval.collaborationId,
              'decision',
            ),
            kind: 'decision',
            role: 'decision',
            semanticAnchor: semanticAnchor(chatNodeStableKey, 'decision', approval.collaborationId),
            sourceIdentity: {
              sessionId: this.sessionId,
              branchId: this.branchId,
              turnId: state.turnId,
              entityId: approval.collaborationId,
            },
            contentRevision: approval.revision,
            status: approval.status === 'pending' ? 'pending' : 'terminal',
            permittedSummary: approval.actionSummary.slice(0, 4_096),
            content: {
              collaborationId: approval.collaborationId,
              canonicalStableKey: responseBlockKey(
                this.sessionId,
                this.branchId,
                state.messageId,
                'decision',
                approval.collaborationId,
                'decision',
              ),
              decisionType: 'approval',
              owner: 'collaboration_authority',
              prompt: approval.actionSummary.slice(0, 4_096),
              ...(approval.scopeSummary !== undefined
                ? { scopeSummary: approval.scopeSummary.slice(0, 4_096) }
                : {}),
              ...(approval.riskSummary !== undefined
                ? { riskSummary: approval.riskSummary.slice(0, 4_096) }
                : {}),
              ...(approval.expiresAt !== undefined ? { expiresAt: approval.expiresAt } : {}),
              state: approval.status === 'approved'
                ? 'approved'
                : approval.status === 'rejected'
                  ? 'denied'
                  : approval.status === 'expired'
                    ? 'expired'
                    : approval.status === 'superseded'
                      ? 'superseded'
                      : 'pending',
              contractRevision: approval.contractRevision,
              contractDigest: approval.contractDigest,
            },
          };
          blocks.push(decisionBlock);
        }
      }

      // Block-scoped errors: one inert error block per errorId.
      if (state.blockErrors.size > 0) {
        const orderedErrors = [...state.blockErrors.values()].sort((left, right) =>
          left.firstSequence - right.firstSequence
          || left.errorId.localeCompare(right.errorId),
        );
        for (const error of orderedErrors) {
          const errorBlock: ErrorBlockV1 = {
            schemaVersion: 1,
            stableKey: responseBlockKey(
              this.sessionId,
              this.branchId,
              state.messageId,
              'error',
              error.errorId,
              'detail',
            ),
            kind: 'error',
            role: 'detail',
            semanticAnchor: semanticAnchor(chatNodeStableKey, 'error', error.errorId),
            sourceIdentity: {
              sessionId: this.sessionId,
              branchId: this.branchId,
              turnId: state.turnId,
              entityId: error.errorId,
            },
            contentRevision: 0,
            status: 'terminal',
            permittedSummary: boundedSummary(error.summary, 'Response block error'),
            content: {
              errorId: error.errorId,
              errorClass: error.errorClass,
              summary: boundedSummary(error.summary, 'Response block error'),
              affectedIdentity: error.affectedEntityId,
              lastVerifiedState: 'partial response retained',
              correlationId: error.correlationId,
              recoveryState: recoveryStateFromErrorClass(error.errorClass),
            },
          };
          blocks.push(errorBlock);
        }
      }

      // Canonical terminal failure/interruption also surfaces a scoped error
      // block per response for supportability parity with legacy `error`
      // events. Duplicate identifiers are deduplicated by the projector's
      // structured entry map (below).
      if (canonicalTerminal
        && (state.canonicalTerminal!.terminalState === 'interrupted'
          || state.canonicalTerminal!.terminalState === 'failed')
        && state.canonicalTerminal!.errorId !== undefined) {
        const terminal = state.canonicalTerminal!;
        const errorId = terminal.errorId!;
        // Skip if an equivalent block.error already produced this block.
        if (!state.blockErrors.has(errorId)) {
          const errorBlock: ErrorBlockV1 = {
            schemaVersion: 1,
            stableKey: responseBlockKey(
              this.sessionId,
              this.branchId,
              state.messageId,
              'error',
              errorId,
              'detail',
            ),
            kind: 'error',
            role: 'detail',
            semanticAnchor: semanticAnchor(chatNodeStableKey, 'error', errorId),
            sourceIdentity: {
              sessionId: this.sessionId,
              branchId: this.branchId,
              turnId: state.turnId,
              entityId: errorId,
            },
            contentRevision: 0,
            status: 'terminal',
            permittedSummary: boundedSummary(terminal.summary, 'Assistant response ended abnormally'),
            content: {
              errorId,
              errorClass: terminal.errorClass ?? 'internal',
              summary: boundedSummary(terminal.summary, 'Assistant response ended abnormally'),
              affectedIdentity: state.messageId,
              lastVerifiedState: terminal.partialContentRetained
                ? 'partial response retained'
                : 'no partial response retained',
              correlationId: terminal.correlationId ?? errorId,
              recoveryState: terminal.terminalState === 'interrupted' ? 'interrupted' : 'failed',
            },
          };
          blocks.push(errorBlock);
        }
      }

      const structured = [...state.structured.values()].sort((left, right) =>
        left.declaredOrder - right.declaredOrder
        || left.firstSequence - right.firstSequence
        || left.block.stableKey.localeCompare(right.block.stableKey),
      );
      blocks.push(...structured.map((entry) => entry.block));

      const parsedComposition = {
        schemaVersion: 1,
        compositionId: state.messageId,
        chatNodeStableKey,
        semanticAnchor: compositionAnchor,
        sourceRevision: state.sourceRevision,
        blocks,
      } satisfies ResponseCompositionV1;
      compositions.push(parsedComposition);
      order.set(chatNodeStableKey, state.firstSequence);
    }

    compositions.sort((left, right) =>
      (order.get(left.chatNodeStableKey) ?? 0) - (order.get(right.chatNodeStableKey) ?? 0)
      || left.chatNodeStableKey.localeCompare(right.chatNodeStableKey),
    );

    return { compositions, order, diagnostics };
  }
}
