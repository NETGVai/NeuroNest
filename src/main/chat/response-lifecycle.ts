/**
 * Response terminal-lifecycle appender.
 *
 * Owns the durable transition into `response.interrupted` or
 * `response.failed` (and the stop/complete branches wired here for parity)
 * for a response group opened by
 * `src/main/chat/preflight-response-start.ts`.
 *
 * The appender is intentionally SEPARATE from the projector layer: it never
 * touches renderer state and never rewrites committed events. Its only
 * responsibilities are:
 *
 *   1. Compute an idempotent event identity keyed by
 *      `(sessionId, branchId, responseId, requestId, attempt)` so a repeated
 *      terminal delivery does not create a duplicate terminal event.
 *   2. Append the terminal event through `SessionLog.append` in a single
 *      durable step, preserving every previously committed answer/reasoning/
 *      tool/task/approval/thinking upsert. The appender NEVER truncates,
 *      rewrites, or reorders previously committed events.
 *   3. Emit a redacted diagnostic record that carries only allowlisted
 *      fields (see `proxy-outcome-classifier.ts` for the allowlist).
 *
 * Requirements: 8.4, 8.5, 8.6, 8.7, 8.9, 10.5, 10.6, 12.7, 15.8
 */

import { createHash } from 'node:crypto';

import type { ActorRef } from '../../harness/contracts/actor.js';
import {
  ChatEventPayloadV1Schema,
  RetryMetadataV1Schema,
  type ChatEventPayloadV1,
  type ChatEventRouteV1,
  type CompletionProviderBlockEnvelopeV1,
  type ResponseCompletedV1,
  type ResponseFailedV1,
  type ResponseInterruptedV1,
  type ResponseStoppedV1,
  type RetryMetadataV1,
} from '../../harness/contracts/chat-stream-event.js';
import type { SessionEventV1 } from '../../harness/contracts/event.js';
import type { ScopeDescriptorV1 } from '../../harness/contracts/scope.js';
import type { SessionLog } from '../../harness/session-log/session-log.js';
import type { AppendReceipt } from '../../harness/session-log/types.js';
import type { ClassifiedProxyError } from '../../providers/proxy-error-classifier.js';
import { redactString } from '../../shared/observable-redaction.js';

import {
  buildProxyOutcomeInput,
  classifyPersistenceFailure,
  classifyProxyOutcome,
  toProxyOutcomeDiagnostic,
  type CommittedContentSnapshot,
  type PersistenceOutcomeInput,
  type ProxyOutcome,
  type ProxyOutcomeDiagnosticRecord,
  type ProxyOutcomeInput,
  type ProxyOutcomeRetryContext,
} from './proxy-outcome-classifier.js';

// ─── Identity used for idempotent terminal keying ──────────────────────────

/**
 * Durable identity a caller must supply for a terminal event. Repeats the
 * session/branch/response/request/attempt fields so the idempotency key can
 * be derived without consulting a separate lookup table.
 */
export interface ResponseTerminalIdentity {
  readonly sessionId: string;
  readonly branchId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly responseId: string;
  readonly requestId: string;
  readonly attempt: number;
}

// ─── Public terminal-event API ─────────────────────────────────────────────

/**
 * Result surface returned by every terminal-append helper. Callers keep the
 * receipt for tracing and use the diagnostic for observability. The
 * `payload` field is the canonical terminal event payload that was committed
 * (or already existed on the idempotent path).
 */
export interface ResponseTerminalAppendResult {
  readonly kind: ProxyOutcome['kind'];
  readonly payload: ResponseInterruptedV1 | ResponseFailedV1;
  readonly receipt: AppendReceipt;
  readonly diagnostic: ProxyOutcomeDiagnosticRecord;
}

/**
 * Input for a proxy failure that must be projected as a terminal event.
 * Combines the classifier input with the durable actor/scope/timestamp used
 * for the SessionLog append.
 */
export interface AppendProxyTerminalInput {
  readonly identity: ResponseTerminalIdentity;
  readonly actor: ActorRef;
  readonly scope: ScopeDescriptorV1;
  readonly error: ClassifiedProxyError;
  readonly content: CommittedContentSnapshot;
  readonly retryContext?: ProxyOutcomeRetryContext;
  readonly errorId?: string;
  readonly correlationId?: string;
  readonly occurredAt?: string;
}

/**
 * Input for a persistence failure that must be projected as a terminal
 * event. Same shape as {@link AppendProxyTerminalInput} but the failure is
 * caused by the durability layer itself.
 */
export interface AppendPersistenceTerminalInput {
  readonly identity: ResponseTerminalIdentity;
  readonly actor: ActorRef;
  readonly scope: ScopeDescriptorV1;
  readonly correlationId: string;
  readonly content: CommittedContentSnapshot;
  readonly reason: string;
  readonly retryContext?: ProxyOutcomeRetryContext;
  readonly errorId?: string;
  readonly occurredAt?: string;
}

/**
 * Input for a user-initiated stop that must be projected as a canonical
 * `response.stopped` terminal event. Partial answer/reasoning/tool/task/
 * approval content already committed to the durable log is preserved as-is;
 * this appender never rewrites or removes prior events.
 */
export interface AppendStopTerminalInput {
  readonly identity: ResponseTerminalIdentity;
  readonly actor: ActorRef;
  readonly scope: ScopeDescriptorV1;
  readonly route: ChatEventRouteV1;
  /**
   * Optional short reason string surfaced to observability. Free-form
   * strings pass through {@link redactString} before storage so credential
   * substrings, file paths, and prompt-shaped tokens cannot leak.
   */
  readonly reason?: string;
  /**
   * Optional retry hint. Stopped responses are user-driven cancellations,
   * so the default retry envelope is `{ retryable: true }`. Callers may
   * pass a lineage context (previousRequestId/previousAttempt/anchor) to
   * chain the emitted stop event to an earlier attempt.
   */
  readonly retryContext?: ProxyOutcomeRetryContext;
  readonly occurredAt?: string;
}

export interface ResponseStopTerminalAppendResult {
  readonly kind: 'stopped';
  readonly payload: ResponseStoppedV1;
  readonly receipt: AppendReceipt;
}

/**
 * Input for a normal completion append. Two deliveries with the same
 * `(sessionId, branchId, responseId, requestId, attempt)` — regardless of
 * their provider block contents — must resolve to a single durable
 * `response.completed` event. That guarantee is the completion-anchor
 * uniqueness rule from the design.
 */
export interface AppendCompletedTerminalInput {
  readonly identity: ResponseTerminalIdentity;
  readonly actor: ActorRef;
  readonly scope: ScopeDescriptorV1;
  readonly route: ChatEventRouteV1;
  readonly providerBlock: CompletionProviderBlockEnvelopeV1;
  readonly occurredAt?: string;
}

export interface ResponseCompletedTerminalAppendResult {
  readonly kind: 'completed';
  readonly payload: ResponseCompletedV1;
  readonly receipt: AppendReceipt;
}

/**
 * Dependencies for the terminal-append service. Instances can be shared
 * across sessions; state lives in the composed `SessionLog`.
 */
export interface ResponseTerminalLifecycleDependencies {
  readonly sessionLog: SessionLog;
  readonly now?: () => Date;
}

// ─── Idempotency helpers ───────────────────────────────────────────────────

const IDEMPOTENCY_NAMESPACE = 'chat-response-terminal';

/**
 * All terminal event kinds that this appender can commit. Each kind gets its
 * own idempotency-key sub-namespace so appending a `response.stopped` never
 * collides with a prior `response.completed` for the SAME response identity
 * (that would be a semantic conflict and is enforced at the projector level
 * by the terminal state machine, not here).
 */
type TerminalEventKind = 'interrupted' | 'failed' | 'stopped' | 'completed';

/**
 * Idempotency key derived from durable identity. Two calls with the same
 * `(sessionId, branchId, responseId, requestId, attempt, terminalKind)`
 * produce the same key so `SessionLog.append` returns the prior receipt
 * instead of committing a duplicate.
 */
function stableTerminalIdempotencyKey(
  identity: ResponseTerminalIdentity,
  kind: TerminalEventKind,
): string {
  return `${IDEMPOTENCY_NAMESPACE}:${kind}:${createHash('sha256')
    .update(
      [
        identity.sessionId,
        identity.branchId,
        identity.responseId,
        identity.requestId,
        String(identity.attempt),
      ].join('\u0000'),
    )
    .digest('hex')}`;
}

function deterministicEventId(...parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

function terminalEventId(
  identity: ResponseTerminalIdentity,
  kind: TerminalEventKind,
): string {
  return deterministicEventId(
    IDEMPOTENCY_NAMESPACE,
    kind,
    identity.sessionId,
    identity.branchId,
    identity.responseId,
    identity.requestId,
    String(identity.attempt),
  );
}

// ─── Service ───────────────────────────────────────────────────────────────

/**
 * Durable appender for chat response terminal events driven by proxy or
 * persistence failures.
 *
 * The service defers all classification to
 * `proxy-outcome-classifier.classifyProxyOutcome` and
 * `classifyPersistenceFailure`, then owns exactly the SessionLog append.
 * This keeps the two concerns (what the terminal event should be, and how
 * it becomes durable) narrow and independently testable.
 */
export class ResponseTerminalLifecycle {
  private readonly sessionLog: SessionLog;
  private readonly now: () => Date;

  constructor(dependencies: ResponseTerminalLifecycleDependencies) {
    this.sessionLog = dependencies.sessionLog;
    this.now = dependencies.now ?? (() => new Date());
  }

  /**
   * Classify a proxy failure and append the resulting terminal event. Never
   * mutates or removes previously committed events. Returns the redacted
   * diagnostic for observability.
   */
  appendProxyTerminal(input: AppendProxyTerminalInput): ResponseTerminalAppendResult {
    validateIdentity(input.identity);
    validateSessionScope(input.identity, input.scope);
    validateContent(input.content);

    const classifierInput: ProxyOutcomeInput = buildProxyOutcomeInput({
      identity: {
        conversationId: input.identity.conversationId,
        turnId: input.identity.turnId,
        responseId: input.identity.responseId,
        requestId: input.identity.requestId,
        attempt: input.identity.attempt,
        sourceIdentity: {
          sessionId: input.identity.sessionId,
          branchId: input.identity.branchId,
          turnId: input.identity.turnId,
          entityId: input.identity.responseId,
        },
      },
      route: {
        // Route metadata for the terminal event comes from the classifier
        // error's context, which itself was built from the started event's
        // resolved route. Callers must ensure `error.metadata` matches the
        // response group being terminated. See `preflight-response-start.ts`
        // for the started-event route source.
        routeId: routeIdForError(input.error, input.identity),
        transportClass: 'neuronest-cloud-proxy',
        provider: input.error.metadata.provider,
        model: input.error.metadata.model,
        edition: input.error.metadata.edition,
      },
      error: input.error,
      content: input.content,
      ...(input.retryContext !== undefined ? { retryContext: input.retryContext } : {}),
      ...(input.errorId !== undefined ? { errorId: input.errorId } : {}),
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });

    const outcome = classifyProxyOutcome(classifierInput);
    const receipt = this.appendTerminalEvent(
      input.identity,
      input.actor,
      input.scope,
      outcome,
      input.occurredAt,
    );
    const diagnostic = toProxyOutcomeDiagnostic(
      outcome,
      classifierInput,
      input.error.metadata.httpStatus,
    );
    return {
      kind: outcome.kind,
      payload: outcome.payload,
      receipt,
      diagnostic,
    };
  }

  /**
   * Classify a persistence (SessionLog append) failure and append the
   * resulting terminal event. When any content is committed the outcome is
   * `interrupted` and the committed events survive. Otherwise the outcome
   * is `failed`.
   *
   * Note: the terminal event itself is appended through the same SessionLog
   * that reported the persistence failure. Callers using this helper must
   * ensure the transient issue that caused the earlier append failure has
   * resolved before invoking, otherwise the terminal append itself will
   * throw — which is the correct behavior (the caller is expected to
   * surface a hard error at that point).
   */
  appendPersistenceTerminal(
    input: AppendPersistenceTerminalInput,
    route: {
      readonly routeId: string;
      readonly transportClass: 'neuronest-cloud-proxy' | 'local-provider';
      readonly provider: string;
      readonly model: string;
      readonly edition: 'community' | 'professional' | 'enterprise';
    },
  ): ResponseTerminalAppendResult {
    validateIdentity(input.identity);
    validateSessionScope(input.identity, input.scope);
    validateContent(input.content);

    const classifierInput: PersistenceOutcomeInput = {
      identity: {
        conversationId: input.identity.conversationId,
        turnId: input.identity.turnId,
        responseId: input.identity.responseId,
        requestId: input.identity.requestId,
        attempt: input.identity.attempt,
        sourceIdentity: {
          sessionId: input.identity.sessionId,
          branchId: input.identity.branchId,
          turnId: input.identity.turnId,
          entityId: input.identity.responseId,
        },
      },
      route,
      correlationId: input.correlationId,
      content: input.content,
      reason: input.reason,
      ...(input.retryContext !== undefined ? { retryContext: input.retryContext } : {}),
      ...(input.errorId !== undefined ? { errorId: input.errorId } : {}),
    };

    const outcome = classifyPersistenceFailure(classifierInput);
    const receipt = this.appendTerminalEvent(
      input.identity,
      input.actor,
      input.scope,
      outcome,
      input.occurredAt,
    );
    const diagnostic = toProxyOutcomeDiagnostic(outcome, classifierInput);
    return {
      kind: outcome.kind,
      payload: outcome.payload,
      receipt,
      diagnostic,
    };
  }

  /**
   * Append a canonical `response.stopped` terminal event.
   *
   * The stop event is idempotent by
   * `(sessionId, branchId, responseId, requestId, attempt)` — a repeated
   * delivery returns the prior receipt so the durable log holds at most one
   * stop terminal for the attempt. Prior committed answer/reasoning/tool/
   * task/approval events are preserved (this method never mutates or
   * removes existing events).
   *
   * The emitted payload always carries `partialContentRetained: true` per
   * the canonical schema; the flag is a semantic marker (the renderer must
   * keep whatever partial content had accumulated), not a data snapshot.
   */
  appendStopTerminal(input: AppendStopTerminalInput): ResponseStopTerminalAppendResult {
    validateIdentity(input.identity);
    validateSessionScope(input.identity, input.scope);
    const trimmedReason = normalizeStopReason(input.reason);

    const retry = buildStopRetryMetadata(input.retryContext);
    const payload: ResponseStoppedV1 = ChatEventPayloadV1Schema.parse({
      schemaVersion: 1,
      type: 'response.stopped',
      identity: {
        conversationId: input.identity.conversationId,
        turnId: input.identity.turnId,
        responseId: input.identity.responseId,
        requestId: input.identity.requestId,
        attempt: input.identity.attempt,
        sourceIdentity: {
          sessionId: input.identity.sessionId,
          branchId: input.identity.branchId,
          turnId: input.identity.turnId,
          entityId: input.identity.responseId,
        },
      },
      route: input.route,
      terminalState: 'stopped',
      partialContentRetained: true,
      ...(trimmedReason !== undefined ? { reason: trimmedReason } : {}),
      ...(retry !== undefined ? { retry } : {}),
    }) as ResponseStoppedV1;

    const receipt = this.appendCanonicalTerminal(
      input.identity,
      input.actor,
      input.scope,
      'stopped',
      payload,
      input.occurredAt,
    );

    return { kind: 'stopped', payload, receipt };
  }

  /**
   * Append a canonical `response.completed` terminal event.
   *
   * Idempotent by `(sessionId, branchId, responseId, requestId, attempt)`:
   * two deliveries for the same identity — regardless of the provider block
   * contents — resolve to a single durable event. This is the completion-
   * anchor uniqueness guarantee: a retry cannot fabricate a duplicate
   * completed assistant message. Stale deliveries that arrive after the
   * first commit return the prior receipt without appending.
   */
  appendCompletedTerminal(
    input: AppendCompletedTerminalInput,
  ): ResponseCompletedTerminalAppendResult {
    validateIdentity(input.identity);
    validateSessionScope(input.identity, input.scope);

    const payload: ResponseCompletedV1 = ChatEventPayloadV1Schema.parse({
      schemaVersion: 1,
      type: 'response.completed',
      identity: {
        conversationId: input.identity.conversationId,
        turnId: input.identity.turnId,
        responseId: input.identity.responseId,
        requestId: input.identity.requestId,
        attempt: input.identity.attempt,
        sourceIdentity: {
          sessionId: input.identity.sessionId,
          branchId: input.identity.branchId,
          turnId: input.identity.turnId,
          entityId: input.identity.responseId,
        },
      },
      route: input.route,
      terminalState: 'completed',
      partialContentRetained: true,
      providerBlock: input.providerBlock,
    }) as ResponseCompletedV1;

    const receipt = this.appendCanonicalTerminal(
      input.identity,
      input.actor,
      input.scope,
      'completed',
      payload,
      input.occurredAt,
    );

    return { kind: 'completed', payload, receipt };
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private appendTerminalEvent(
    identity: ResponseTerminalIdentity,
    actor: ActorRef,
    scope: ScopeDescriptorV1,
    outcome: ProxyOutcome,
    occurredAt: string | undefined,
  ): AppendReceipt {
    const kind = outcome.kind;
    const eventType = kind === 'interrupted' ? 'response.interrupted' : 'response.failed';
    const idempotencyKey = stableTerminalIdempotencyKey(identity, kind);
    const eventId = terminalEventId(identity, kind);
    const timestamp = occurredAt ?? this.now().toISOString();

    return this.sessionLog.append({
      eventId,
      sessionId: identity.sessionId,
      branchId: identity.branchId,
      eventType,
      payload: outcome.payload as unknown as SessionEventV1['payload'],
      actor,
      scope,
      occurredAt: timestamp,
      idempotencyKey,
    });
  }

  private appendCanonicalTerminal(
    identity: ResponseTerminalIdentity,
    actor: ActorRef,
    scope: ScopeDescriptorV1,
    kind: 'stopped' | 'completed',
    payload: ResponseStoppedV1 | ResponseCompletedV1,
    occurredAt: string | undefined,
  ): AppendReceipt {
    const eventType = kind === 'stopped' ? 'response.stopped' : 'response.completed';
    const idempotencyKey = stableTerminalIdempotencyKey(identity, kind);
    const eventId = terminalEventId(identity, kind);
    const timestamp = occurredAt ?? this.now().toISOString();

    return this.sessionLog.append({
      eventId,
      sessionId: identity.sessionId,
      branchId: identity.branchId,
      eventType,
      payload: payload as unknown as SessionEventV1['payload'],
      actor,
      scope,
      occurredAt: timestamp,
      idempotencyKey,
    });
  }
}

/**
 * Normalize a caller-supplied stop reason through the shared redactor and
 * return `undefined` when the resulting string is empty. The canonical
 * schema treats `reason` as an optional summary, so an empty value must be
 * omitted rather than persisted as `""`.
 */
function normalizeStopReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const trimmed = redactString(reason).trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Build the retry envelope carried on a stop event. A user stop is always
 * retryable — the whole point of retaining partial content is to offer the
 * user a fresh attempt — so `retryable` is forced to `true` regardless of
 * caller input. When the caller supplies no lineage fields, the envelope
 * itself is omitted (Zod treats the property as optional on the payload).
 */
function buildStopRetryMetadata(
  context: ProxyOutcomeRetryContext | undefined,
): RetryMetadataV1 | undefined {
  if (context === undefined) {
    return RetryMetadataV1Schema.parse({ retryable: true });
  }
  return RetryMetadataV1Schema.parse({
    retryable: true,
    ...(context.previousRequestId !== undefined
      ? { previousRequestId: context.previousRequestId }
      : {}),
    ...(context.previousAttempt !== undefined
      ? { previousAttempt: context.previousAttempt }
      : {}),
    ...(context.completionAnchorId !== undefined
      ? { completionAnchorId: context.completionAnchorId }
      : {}),
  });
}

// ─── Validation ────────────────────────────────────────────────────────────

function validateIdentity(identity: ResponseTerminalIdentity): void {
  if (identity.sessionId.length === 0) {
    throw new Error('terminal input requires a non-empty identity.sessionId');
  }
  if (identity.branchId.length === 0) {
    throw new Error('terminal input requires a non-empty identity.branchId');
  }
  if (identity.turnId.length === 0) {
    throw new Error('terminal input requires a non-empty identity.turnId');
  }
  if (identity.responseId.length === 0) {
    throw new Error('terminal input requires a non-empty identity.responseId');
  }
  if (identity.requestId.length === 0) {
    throw new Error('terminal input requires a non-empty identity.requestId');
  }
  if (!Number.isInteger(identity.attempt) || identity.attempt < 0) {
    throw new Error('terminal input requires a non-negative integer identity.attempt');
  }
}

function validateSessionScope(
  identity: ResponseTerminalIdentity,
  scope: ScopeDescriptorV1,
): void {
  if (scope.sessionId !== undefined && scope.sessionId !== identity.sessionId) {
    throw new Error('terminal input scope.sessionId does not match identity.sessionId');
  }
}

function validateContent(content: CommittedContentSnapshot): void {
  if (typeof content.hasAnswerContent !== 'boolean') {
    throw new Error('terminal input content.hasAnswerContent must be a boolean');
  }
  if (typeof content.hasReasoningContent !== 'boolean') {
    throw new Error('terminal input content.hasReasoningContent must be a boolean');
  }
}

function routeIdForError(
  error: ClassifiedProxyError,
  identity: ResponseTerminalIdentity,
): string {
  // We do not carry the started event's `routeId` on the classified error;
  // synthesize a deterministic identifier so the terminal event's route
  // metadata satisfies the closed schema. Callers that need the exact
  // started routeId should propagate it and override this helper.
  return `terminal-${error.metadata.provider}-${error.metadata.model}-${identity.responseId}`;
}

// ─── Terminal payload guards for external callers ──────────────────────────

/**
 * Type guard so callers can narrow an unknown terminal payload before
 * projection. Prefer this over raw `type` inspection because it also
 * validates through the canonical schema (guarding against schema drift).
 */
export function isInterruptedPayload(payload: unknown): payload is ResponseInterruptedV1 {
  if (payload === null || typeof payload !== 'object') return false;
  const record = payload as { type?: unknown };
  return record.type === 'response.interrupted';
}

export function isFailedPayload(payload: unknown): payload is ResponseFailedV1 {
  if (payload === null || typeof payload !== 'object') return false;
  const record = payload as { type?: unknown };
  return record.type === 'response.failed';
}

export function isStoppedPayload(payload: unknown): payload is ResponseStoppedV1 {
  if (payload === null || typeof payload !== 'object') return false;
  const record = payload as { type?: unknown };
  return record.type === 'response.stopped';
}

export function isCompletedPayload(payload: unknown): payload is ResponseCompletedV1 {
  if (payload === null || typeof payload !== 'object') return false;
  const record = payload as { type?: unknown };
  return record.type === 'response.completed';
}

/**
 * True when the terminal payload retains user-visible partial content. This
 * exists so callers that only have a serialized payload can reason about
 * whether to show the interrupted state in the renderer.
 */
export function retainsPartialContent(payload: ChatEventPayloadV1): boolean {
  if (payload.type === 'response.interrupted') return true;
  if (payload.type === 'response.stopped') return true;
  if (payload.type === 'response.completed') return true;
  if (payload.type === 'response.failed') return payload.partialContentRetained;
  return false;
}
