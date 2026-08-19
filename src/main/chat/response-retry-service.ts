/**
 * User-initiated retry semantics for chat responses.
 *
 * Task 7.7 (Requirements 8.6, 8.7, 8.8, 10.6, 10.10, 15.5):
 *
 *  - Route retries from scratch through the same preflight authority the
 *    original attempt used. A retry always produces a fresh network
 *    request; content is never salvaged across attempts.
 *  - New identity: the retry inherits `sessionId`, `branchId`,
 *    `conversationId`, and `turnId` from the previous attempt so the durable
 *    turn lineage remains stable. `responseId`, `requestId` are freshly
 *    generated, and `attempt` increments by exactly one.
 *  - Bounded delay: caller-supplied `retryDelayMs` is clamped to the closed
 *    interval `[0, RESPONSE_RETRY_DELAY_MAX_MS]` (10 minutes). Non-finite
 *    values collapse to `0`.
 *  - Started event retry envelope: the emitted `response.started` event
 *    carries `retry: { retryable: true, retryAfterMs, previousRequestId,
 *    previousAttempt, completionAnchorId? }` so projections and diagnostics
 *    can render the lineage without inspecting hidden state.
 *  - Completion-anchor uniqueness: {@link ResponseRetryService.completeResponse}
 *    forwards to {@link ResponseTerminalLifecycle.appendCompletedTerminal}
 *    whose idempotency key covers `(sessionId, branchId, responseId,
 *    requestId, attempt)`. A duplicate delivery for the same identity
 *    returns the prior receipt without appending a second event, so at most
 *    one `response.completed` exists per attempt. Because a retry uses a
 *    fresh `(responseId, requestId, attempt)` triple, a stale completion
 *    delivery from a superseded attempt cannot masquerade as the retry's
 *    completion; likewise a stale retry-attempt completion cannot duplicate
 *    the previous attempt's terminal.
 *
 * The retry service is a thin orchestrator over
 * {@link PreflightResponseStartService} and
 * {@link ResponseTerminalLifecycle}. It never runs network I/O and never
 * touches renderer state. Callers integrate the returned outcome with
 * `CoordinatedInferenceClient` (or an equivalent transport facade) to
 * issue the actual proxied request.
 */

import { randomUUID } from 'node:crypto';

import type { ActorRef } from '../../harness/contracts/actor.js';
import type { ScopeDescriptorV1 } from '../../harness/contracts/scope.js';

import type {
  PreflightResponseKeys,
  PreflightResponseStartInput,
  PreflightResponseStartOutcome,
  PreflightResponseStartService,
  PreflightUserTurn,
} from './preflight-response-start.js';
import type {
  AppendCompletedTerminalInput,
  ResponseCompletedTerminalAppendResult,
  ResponseTerminalLifecycle,
} from './response-lifecycle.js';

// ─── Bounds ────────────────────────────────────────────────────────────────

/**
 * Upper bound on the caller-supplied retry delay honored by the retry
 * service. Matches the interrupted-retry ceiling in
 * `proxy-outcome-classifier.ts` so the renderer never observes a stall
 * beyond 10 minutes attributable to either error handling or user retries.
 */
export const RESPONSE_RETRY_DELAY_MAX_MS = 600_000;

// ─── Input contract ────────────────────────────────────────────────────────

/**
 * Durable identity of the previous attempt. The retry service uses these to
 * (a) preserve the turn lineage on the new attempt and (b) populate the
 * started event's retry envelope with truthful `previousRequestId`/
 * `previousAttempt`.
 *
 * `previousResponseId` and `completionAnchorId` are optional because a
 * preflight-failed attempt may not have reached a completion anchor.
 */
export interface RetryPreviousIdentity {
  readonly sessionId: string;
  readonly branchId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly previousResponseId?: string;
  readonly previousRequestId: string;
  readonly previousAttempt: number;
  /**
   * Anchor identifier of the completion event that finalized the previous
   * attempt (if any). Used purely for lineage — the completion-anchor
   * uniqueness rule is enforced by the terminal lifecycle idempotency key,
   * not by this identifier.
   */
  readonly completionAnchorId?: string;
}

/**
 * Everything the retry service needs to route a retry through preflight. The
 * caller supplies the original turn (`turn.text`, `turn.messageId`) so the
 * service can reuse the durable user-turn append when the underlying
 * `PreflightResponseStartService` re-runs.
 */
export interface RetryResponseInput {
  readonly previousIdentity: RetryPreviousIdentity;
  readonly turn: PreflightUserTurn;
  readonly keys: PreflightResponseKeys;
  readonly routing: PreflightResponseStartInput['routing'];
  readonly actor: ActorRef;
  readonly scope: ScopeDescriptorV1;
  /**
   * Optional retry delay hint. Non-finite values, negative values, and
   * values above {@link RESPONSE_RETRY_DELAY_MAX_MS} are clamped. When
   * omitted the started event carries `retry` without `retryAfterMs`.
   */
  readonly retryDelayMs?: number;
}

// ─── Output contract ───────────────────────────────────────────────────────

/**
 * Freshly minted identity for the retry attempt. Session/branch/
 * conversation/turn are inherited from {@link RetryPreviousIdentity};
 * `responseId`, `requestId`, and `attempt` are new.
 */
export interface RetryResolvedIdentity {
  readonly sessionId: string;
  readonly branchId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly responseId: string;
  readonly requestId: string;
  readonly attempt: number;
}

/**
 * Result of a retry orchestration. The `outcome` mirrors the same discriminated
 * union `PreflightResponseStartService.startResponse` returns, so callers can
 * distinguish `started` (issue the transport request) from `failed-closed`
 * (surface a typed retry-preflight failure without a request).
 *
 * `retryDelayMs` reports the clamped value that was applied to the started
 * event's retry envelope. `identity` is the freshly minted attempt identity
 * a caller must use when appending answer/reasoning/tool events and when
 * committing the terminal event.
 */
export interface RetryResponseResult {
  readonly identity: RetryResolvedIdentity;
  readonly retryDelayMs: number | undefined;
  readonly outcome: PreflightResponseStartOutcome;
}

// ─── Dependencies ──────────────────────────────────────────────────────────

export interface ResponseRetryServiceDependencies {
  readonly preflight: PreflightResponseStartService;
  readonly lifecycle: ResponseTerminalLifecycle;
  /**
   * Optional factory for generating the retry attempt's `responseId`.
   * Defaults to `randomUUID` from `node:crypto`. Tests supply a
   * deterministic factory to reproduce identity assignment.
   */
  readonly createResponseId?: () => string;
  /**
   * Optional factory for generating the retry attempt's `requestId`.
   * Defaults to `randomUUID` from `node:crypto`.
   */
  readonly createRequestId?: () => string;
}

// ─── Service ───────────────────────────────────────────────────────────────

/**
 * Retry orchestration entry point.
 *
 * A single instance can serve every session — the service holds no per-
 * request state. Idempotency, ordering, and content preservation are all
 * delegated to the composed {@link PreflightResponseStartService} and
 * {@link ResponseTerminalLifecycle}.
 */
export class ResponseRetryService {
  private readonly preflight: PreflightResponseStartService;
  private readonly lifecycle: ResponseTerminalLifecycle;
  private readonly createResponseId: () => string;
  private readonly createRequestId: () => string;

  constructor(dependencies: ResponseRetryServiceDependencies) {
    this.preflight = dependencies.preflight;
    this.lifecycle = dependencies.lifecycle;
    this.createResponseId = dependencies.createResponseId ?? randomUUID;
    this.createRequestId = dependencies.createRequestId ?? randomUUID;
  }

  /**
   * Route a retry through preflight.
   *
   *   1. Compute a fresh `(responseId, requestId, attempt = previousAttempt
   *      + 1)` identity while preserving `sessionId`, `branchId`,
   *      `conversationId`, and `turnId` from the previous attempt.
   *   2. Bound `retryDelayMs` to `[0, RESPONSE_RETRY_DELAY_MAX_MS]`.
   *   3. Invoke {@link PreflightResponseStartService.startResponse} with the
   *      new identity and a retry context describing the lineage. The
   *      started event's retry envelope will carry
   *      `{ retryable: true, retryAfterMs?, previousRequestId,
   *        previousAttempt, completionAnchorId? }`.
   *
   * The service never issues the network request itself; the caller
   * integrates the returned outcome with the transport of their choice
   * (`CoordinatedInferenceClient` in production).
   */
  retryResponse(input: RetryResponseInput): RetryResponseResult {
    validateRetryInput(input);

    const identity: RetryResolvedIdentity = {
      sessionId: input.previousIdentity.sessionId,
      branchId: input.previousIdentity.branchId,
      conversationId: input.previousIdentity.conversationId,
      turnId: input.previousIdentity.turnId,
      responseId: this.createResponseId(),
      requestId: this.createRequestId(),
      attempt: input.previousIdentity.previousAttempt + 1,
    };
    if (identity.responseId.length === 0) {
      throw new Error('createResponseId must return a non-empty identifier');
    }
    if (identity.requestId.length === 0) {
      throw new Error('createRequestId must return a non-empty identifier');
    }

    const clampedDelay =
      input.retryDelayMs === undefined
        ? undefined
        : clampRetryDelayMs(input.retryDelayMs);

    // The started event should surface a retry envelope with truthful
    // lineage even for the failed-closed branch, so build the same context
    // regardless of preflight outcome.
    const retryContext = {
      previousRequestId: input.previousIdentity.previousRequestId,
      previousAttempt: input.previousIdentity.previousAttempt,
      ...(input.previousIdentity.completionAnchorId !== undefined
        ? { completionAnchorId: input.previousIdentity.completionAnchorId }
        : {}),
      ...(clampedDelay !== undefined ? { retryAfterMs: clampedDelay } : {}),
    };

    const outcome = this.preflight.startResponse({
      identity: {
        sessionId: identity.sessionId,
        branchId: identity.branchId,
        conversationId: identity.conversationId,
        turnId: identity.turnId,
        responseId: identity.responseId,
        requestId: identity.requestId,
        attempt: identity.attempt,
      },
      turn: input.turn,
      keys: input.keys,
      routing: input.routing,
      actor: input.actor,
      scope: input.scope,
      retry: retryContext,
    });

    return { identity, retryDelayMs: clampedDelay, outcome };
  }

  /**
   * Commit a `response.completed` terminal for the supplied identity.
   *
   * The forward is a direct delegation to
   * {@link ResponseTerminalLifecycle.appendCompletedTerminal}. That method
   * is idempotent by `(sessionId, branchId, responseId, requestId,
   * attempt)`. Two deliveries for the same identity — regardless of the
   * provider block contents — resolve to a single durable event, and the
   * caller receives the prior receipt on the second call.
   *
   * A retry attempt has a fresh identity, so a stale completion from a
   * previous attempt cannot collide with the retry's completion, and vice
   * versa. The renderer's completion-anchor uniqueness therefore holds by
   * construction.
   */
  completeResponse(
    input: AppendCompletedTerminalInput,
  ): ResponseCompletedTerminalAppendResult {
    return this.lifecycle.appendCompletedTerminal(input);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Clamp a caller-supplied retry delay to `[0, RESPONSE_RETRY_DELAY_MAX_MS]`.
 * Non-finite values collapse to `0`. The result is a non-negative integer;
 * fractional inputs are floored so the value can be serialized by the
 * canonical retry schema.
 */
export function clampRetryDelayMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const floored = Math.max(0, Math.floor(value));
  return Math.min(floored, RESPONSE_RETRY_DELAY_MAX_MS);
}

function validateRetryInput(input: RetryResponseInput): void {
  const previous = input.previousIdentity;
  if (previous.sessionId.length === 0) {
    throw new Error('retry input requires a non-empty previousIdentity.sessionId');
  }
  if (previous.branchId.length === 0) {
    throw new Error('retry input requires a non-empty previousIdentity.branchId');
  }
  if (previous.conversationId.length === 0) {
    throw new Error('retry input requires a non-empty previousIdentity.conversationId');
  }
  if (previous.turnId.length === 0) {
    throw new Error('retry input requires a non-empty previousIdentity.turnId');
  }
  if (previous.previousRequestId.length === 0) {
    throw new Error('retry input requires a non-empty previousIdentity.previousRequestId');
  }
  if (!Number.isInteger(previous.previousAttempt) || previous.previousAttempt < 0) {
    throw new Error(
      'retry input requires a non-negative integer previousIdentity.previousAttempt',
    );
  }
  if (input.scope.sessionId !== undefined && input.scope.sessionId !== previous.sessionId) {
    throw new Error('retry input scope.sessionId does not match previousIdentity.sessionId');
  }
}
