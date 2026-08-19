/**
 * Preflight-driven response lifecycle start.
 *
 * Composes credential, entitlement, and route preflight through
 * `InferenceRouteCoordinator`, then atomically appends either:
 *
 *   1. The user turn (`message.user`) + a canonical `response.started`
 *      event with mandatory route metadata, on success; or
 *   2. The user turn + one canonical `response.failed` event with a
 *      typed error class, on preflight failure.
 *
 * Both branches commit in a single `SessionLog.appendBatch` transaction so
 * that a partial state (user turn without a companion started/failed event)
 * can never be observed by projections. When the resolved outcome is a
 * failure, no `response.started` event is emitted and no cloud transport is
 * touched — the preflight failure yields a self-contained failed response
 * group.
 *
 * Requirements: 8.4, 8.5, 8.6, 9.4, 10.1
 *
 * Behavior contract:
 *  - Route/credential/entitlement preflight runs BEFORE any `response.started`
 *    is appended. Every `response.started` therefore carries fully populated
 *    mandatory route metadata (`routeId`, `transportClass`, `provider`,
 *    `model`, `edition`). This makes each started event truthful by
 *    construction — the alternative (append started, then check credentials)
 *    is rejected because the projection would briefly show a routed response
 *    that was never actually authorized.
 *  - Failure paths never emit `response.started`. Instead a `response.failed`
 *    event is produced with an error class derived from the failure code, so
 *    projections receive exactly one terminal state for the attempt.
 *  - Idempotency keys are derived from `(sessionId, branchId, requestId,
 *    attempt, event kind)`. Duplicate invocations with the same input return
 *    the original receipts without re-appending. This mirrors the durability
 *    boundary in `appendAcceptedChatLifecycleEvents`.
 *  - Even the user turn is idempotent per turn identity. A retry that keeps
 *    the same `turnId`/`messageId` but changes `requestId`/`attempt` will
 *    only append a fresh started/failed pair (the durable user turn is
 *    reused).
 *
 * Non-goals:
 *  - This module does not run any network I/O. It only prepares canonical
 *    lifecycle events and delegates persistence to `SessionLog`.
 *  - It never resolves a Proxy Credential value. The coordinator observes
 *    non-secret status through a callback.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { ActorRef } from '../../harness/contracts/actor.js';
import {
  ChatEventPayloadV1Schema,
  RetryMetadataV1Schema,
  type ChatEventPayloadV1,
  type ChatStreamErrorClassV1,
  type ResponseFailedV1,
  type ResponseStartedV1,
  type RetryMetadataV1,
} from '../../harness/contracts/chat-stream-event.js';
import type { SessionEventV1 } from '../../harness/contracts/event.js';
import type { ScopeDescriptorV1 } from '../../harness/contracts/scope.js';
import type { SessionLog } from '../../harness/session-log/session-log.js';
import type { AppendReceipt } from '../../harness/session-log/types.js';
import type {
  InferenceRouteCoordinator,
  InferenceRouteFailedClosed,
  InferenceRouteFailureCode,
  InferenceRouteRequest,
  InferenceRouteResolved,
} from '../../provider-routing/inference-route-coordinator.js';
import type { InferenceRoute } from '../../provider-routing/types.js';

// ─── Input contract ────────────────────────────────────────────

/**
 * Identity for the response group created by this preflight call.
 *
 * Session/branch/turn/entity linkage is repeated deliberately so that the
 * user turn event and the response start/failed event can be written under
 * exactly the same durable identity — no drift between them is possible.
 */
export interface PreflightResponseIdentity {
  readonly sessionId: string;
  readonly branchId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly responseId: string;
  readonly requestId: string;
  readonly attempt: number;
}

/** User-authored input that opens the turn. */
export interface PreflightUserTurn {
  readonly messageId: string;
  readonly text: string;
  readonly agent?: string;
  readonly provider?: string;
  readonly model?: string;
}

/** Stable presentation identity for the assistant response group. */
export interface PreflightResponseKeys {
  readonly responseStableKey: string;
  readonly agentId?: string;
}

/**
 * Optional retry metadata carried on both started and failed outcomes.
 *
 * When absent for a failed outcome, the module defaults to `{ retryable:
 * true }` so the renderer can offer a retry action for a preflight
 * failure that is not intrinsically permanent (see mapping table below).
 *
 * `retryAfterMs` is the caller-bounded delay honored for this attempt. It
 * is surfaced on `response.started` (and on `response.failed` when set) so
 * downstream projections and diagnostics see the same bounded value the
 * retry service applied. Callers are responsible for pre-clamping this
 * value; see {@link RESPONSE_RETRY_DELAY_MAX_MS} in
 * `response-retry-service.ts`.
 */
export interface PreflightRetryContext {
  readonly previousRequestId?: string;
  readonly previousAttempt?: number;
  readonly completionAnchorId?: string;
  readonly retryAfterMs?: number;
}

/** Everything the preflight service needs to attempt a response start. */
export interface PreflightResponseStartInput {
  readonly identity: PreflightResponseIdentity;
  readonly turn: PreflightUserTurn;
  readonly keys: PreflightResponseKeys;
  readonly routing: Omit<InferenceRouteRequest, 'context'> & {
    readonly context?: InferenceRouteRequest['context'];
  };
  /** Actor authority for both durable events. */
  readonly actor: ActorRef;
  /** Scope descriptor for both durable events. */
  readonly scope: ScopeDescriptorV1;
  readonly retry?: PreflightRetryContext;
}

// ─── Output contract ───────────────────────────────────────────

export interface PreflightResponseStartedOutcome {
  readonly kind: 'started';
  readonly route: InferenceRoute;
  readonly decision: InferenceRouteResolved['decision'];
  readonly selectedLocality: InferenceRouteResolved['selectedLocality'];
  /** Payload of the durable `response.started` event. */
  readonly startedEvent: ResponseStartedV1;
  /** Payload of the durable user turn event. */
  readonly userTurnEvent: SessionEventV1['payload'];
  readonly receipts: {
    readonly userTurn: AppendReceipt;
    readonly responseStarted: AppendReceipt;
  };
}

export interface PreflightResponseFailedOutcome {
  readonly kind: 'failed-closed';
  readonly failureCode: InferenceRouteFailureCode;
  readonly errorClass: ChatStreamErrorClassV1;
  readonly summary: string;
  readonly correlationId: string;
  readonly errorId: string;
  readonly retry: RetryMetadataV1;
  readonly failure: InferenceRouteFailedClosed;
  /** Payload of the durable `response.failed` event. */
  readonly failedEvent: ResponseFailedV1;
  /** Payload of the durable user turn event. */
  readonly userTurnEvent: SessionEventV1['payload'];
  readonly receipts: {
    readonly userTurn: AppendReceipt;
    readonly responseFailed: AppendReceipt;
  };
}

export type PreflightResponseStartOutcome =
  | PreflightResponseStartedOutcome
  | PreflightResponseFailedOutcome;

// ─── Dependencies ──────────────────────────────────────────────

export interface PreflightResponseStartDependencies {
  readonly sessionLog: SessionLog;
  readonly coordinator: InferenceRouteCoordinator;
  /** Timestamp source. Enables deterministic tests. */
  readonly now?: () => Date;
  /**
   * Correlation identifier factory used for failure diagnostics. Callers
   * normally leave this unset. Deterministic factories are useful in tests.
   */
  readonly createCorrelationId?: () => string;
  /**
   * Error identifier factory used for failed lifecycle events. Callers
   * normally leave this unset. Deterministic factories are useful in tests.
   */
  readonly createErrorId?: () => string;
}

// ─── Failure classification ────────────────────────────────────

/**
 * Deterministic mapping from route-coordinator failure codes to canonical
 * `ChatStreamErrorClassV1` values.
 *
 * Rationale (per Requirement 8.4 and Requirement 15.8):
 *  - Missing/invalid/expired Proxy Credential is an authentication failure
 *    from the renderer's perspective. It maps to `proxy_authentication`.
 *  - Entitlement rejection covers both "provider/model not entitled" and
 *    "catalog stale/unavailable/edition-changed". These are all entitlement
 *    conditions and map to `proxy_entitlement`.
 *  - No provider available for the requested role/constraints is a
 *    validation failure — the caller supplied constraints the registry
 *    could not satisfy. Retry is not appropriate without user action.
 *  - Unregistered provider / cloud-fallback transport mismatch indicate a
 *    misconfiguration or a hostile route service. These are internal
 *    invariants and map to `internal` with `retryable=false`.
 *
 * The mapping is exhaustive over the closed `InferenceRouteFailureCode`
 * union. Adding a new failure code without updating this table will fail
 * compilation.
 */
type FailureClassification = {
  readonly errorClass: ChatStreamErrorClassV1;
  readonly retryable: boolean;
};

const FAILURE_CLASSIFICATION: Readonly<Record<InferenceRouteFailureCode, FailureClassification>> = {
  'proxy-credential-unavailable': {
    errorClass: 'proxy_authentication',
    retryable: true,
  },
  'entitlement-rejected': {
    errorClass: 'proxy_entitlement',
    retryable: true,
  },
  'no-provider-available': {
    errorClass: 'validation',
    retryable: false,
  },
  'unregistered-provider': {
    errorClass: 'internal',
    retryable: false,
  },
  'cloud-fallback-transport-mismatch': {
    errorClass: 'internal',
    retryable: false,
  },
};

// ─── Idempotency helpers ────────────────────────────────────────

const IDEMPOTENCY_NAMESPACE = 'preflight-response-start';

function stableTurnIdempotencyKey(identity: PreflightResponseIdentity, messageId: string): string {
  return `${IDEMPOTENCY_NAMESPACE}:turn:${createHash('sha256')
    .update(
      [
        identity.sessionId,
        identity.branchId,
        identity.conversationId,
        identity.turnId,
        messageId,
      ].join('\u0000'),
    )
    .digest('hex')}`;
}

function stableResponseEventIdempotencyKey(
  identity: PreflightResponseIdentity,
  eventKind: 'started' | 'failed',
): string {
  return `${IDEMPOTENCY_NAMESPACE}:${eventKind}:${createHash('sha256')
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

// ─── Payload builders ──────────────────────────────────────────

function buildUserTurnPayload(
  identity: PreflightResponseIdentity,
  turn: PreflightUserTurn,
): SessionEventV1['payload'] {
  const payload: Record<string, unknown> = {
    type: 'message.user',
    role: 'user',
    text: turn.text,
    messageId: turn.messageId,
    turnId: identity.turnId,
    conversationId: identity.conversationId,
  };
  if (turn.agent !== undefined) payload.agent = turn.agent;
  if (turn.provider !== undefined) payload.provider = turn.provider;
  if (turn.model !== undefined) payload.model = turn.model;
  return payload as SessionEventV1['payload'];
}

function buildStartedPayload(
  input: PreflightResponseStartInput,
  route: InferenceRoute,
): ResponseStartedV1 {
  const payload: ResponseStartedV1 = {
    schemaVersion: 1,
    type: 'response.started',
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
      routeId: route.routeId,
      transportClass: route.transportClass,
      provider: route.selectedProvider,
      model: route.selectedModel,
      edition: route.edition,
    },
    responseStableKey: input.keys.responseStableKey,
    ...(input.keys.agentId !== undefined ? { agentId: input.keys.agentId } : {}),
    ...(input.retry !== undefined
      ? {
          retry: buildRetryMetadata({ retryable: true, ...input.retry }),
        }
      : {}),
  };
  // Zod validation guarantees mandatory metadata is present and no unknown
  // fields have crept in. safeParse would swallow the diagnostic, so we
  // deliberately parse in strict mode to catch any programmer error.
  return ChatEventPayloadV1Schema.parse(payload) as ResponseStartedV1;
}

function buildFailedPayload(
  input: PreflightResponseStartInput,
  failure: InferenceRouteFailedClosed,
  classification: FailureClassification,
  errorId: string,
  correlationId: string,
): ResponseFailedV1 {
  // A logical decision is available only when the route service selected a
  // concrete (provider, model). A `paused` decision carries empty provider/
  // model strings and must be treated as "no selection made" for the failed
  // event route metadata. This preserves truthfulness: we do not fabricate a
  // provider/model attribution for a request the router refused to route.
  const hasSelection =
    failure.decision !== undefined &&
    failure.decision.paused === false &&
    failure.decision.providerId.length > 0 &&
    failure.decision.modelId.length > 0;

  const routeMetadata: ResponseFailedV1['route'] = hasSelection && failure.decision !== undefined
    ? {
        // Preflight failure metadata reflects the LOGICAL choice the route
        // service made. The transport class is always the NeuroNest cloud
        // proxy because a preflight failure at this point can only happen
        // on cloud requests (local providers do not need credentials or
        // entitlements). This matches Requirement 5.7: a failure never
        // switches away from proxy transport.
        routeId: `preflight-${failure.decision.providerId}-${failure.decision.modelId}`,
        transportClass: 'neuronest-cloud-proxy',
        provider: failure.decision.providerId,
        model: failure.decision.modelId,
        edition: failure.edition,
      }
    : {
        // No usable logical selection. Emit a truthful placeholder that still
        // satisfies the closed schema; the failure class alone tells the
        // renderer why. `unavailable` is a canonical non-empty value that
        // cannot be confused with a real provider/model identifier.
        routeId: 'preflight-no-provider',
        transportClass: 'neuronest-cloud-proxy',
        provider: 'unavailable',
        model: 'unavailable',
        edition: failure.edition,
      };

  const retry = buildRetryMetadata({
    retryable: classification.retryable,
    previousRequestId: input.retry?.previousRequestId,
    previousAttempt: input.retry?.previousAttempt,
    completionAnchorId: input.retry?.completionAnchorId,
    ...(classification.retryable && input.retry?.retryAfterMs !== undefined
      ? { retryAfterMs: input.retry.retryAfterMs }
      : {}),
  });

  const payload: ResponseFailedV1 = {
    schemaVersion: 1,
    type: 'response.failed',
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
    route: routeMetadata,
    terminalState: 'failed',
    partialContentRetained: false,
    errorId,
    errorClass: classification.errorClass,
    summary: failure.explanation,
    correlationId,
    retry,
  };
  return ChatEventPayloadV1Schema.parse(payload) as ResponseFailedV1;
}

function buildRetryMetadata(input: {
  retryable: boolean;
  previousRequestId?: string;
  previousAttempt?: number;
  completionAnchorId?: string;
  retryAfterMs?: number;
}): RetryMetadataV1 {
  const retry: RetryMetadataV1 = {
    retryable: input.retryable,
    // The canonical schema rejects retryAfterMs on a non-retryable envelope,
    // so this branch also enforces the pair rule at the classifier boundary.
    ...(input.retryable && input.retryAfterMs !== undefined
      ? { retryAfterMs: input.retryAfterMs }
      : {}),
    ...(input.previousRequestId !== undefined
      ? { previousRequestId: input.previousRequestId }
      : {}),
    ...(input.previousAttempt !== undefined
      ? { previousAttempt: input.previousAttempt }
      : {}),
    ...(input.completionAnchorId !== undefined
      ? { completionAnchorId: input.completionAnchorId }
      : {}),
  };
  return RetryMetadataV1Schema.parse(retry);
}

// ─── Service ────────────────────────────────────────────────────

/**
 * Coordinates preflight resolution and durable lifecycle appending.
 *
 * A single instance can serve every session; state is intentionally
 * confined to the composed authorities.
 */
export class PreflightResponseStartService {
  private readonly sessionLog: SessionLog;
  private readonly coordinator: InferenceRouteCoordinator;
  private readonly now: () => Date;
  private readonly createCorrelationId: () => string;
  private readonly createErrorId: () => string;

  constructor(dependencies: PreflightResponseStartDependencies) {
    this.sessionLog = dependencies.sessionLog;
    this.coordinator = dependencies.coordinator;
    this.now = dependencies.now ?? (() => new Date());
    this.createCorrelationId = dependencies.createCorrelationId ?? randomUUID;
    this.createErrorId = dependencies.createErrorId ?? randomUUID;
  }

  /**
   * Attempt to open a response group. Preflights the route, then atomically
   * commits either a routed `response.started` or a typed `response.failed`
   * event alongside the user turn.
   *
   * The user turn is always committed. When the preflight fails, no cloud
   * request has been initiated — the failed response group is authoritative
   * by itself.
   */
  startResponse(input: PreflightResponseStartInput): PreflightResponseStartOutcome {
    validateInput(input);

    const resolution = this.coordinator.resolveRoute(input.routing);
    const userTurnPayload = buildUserTurnPayload(input.identity, input.turn);
    const userTurnEventId = deterministicEventId(
      IDEMPOTENCY_NAMESPACE,
      'turn',
      input.identity.sessionId,
      input.identity.branchId,
      input.identity.turnId,
      input.turn.messageId,
    );
    const userTurnIdempotencyKey = stableTurnIdempotencyKey(input.identity, input.turn.messageId);
    const occurredAt = this.now().toISOString();

    if (resolution.kind === 'resolved') {
      return this.commitStartedOutcome({
        input,
        resolution,
        userTurnPayload,
        userTurnEventId,
        userTurnIdempotencyKey,
        occurredAt,
      });
    }

    return this.commitFailedOutcome({
      input,
      failure: resolution,
      userTurnPayload,
      userTurnEventId,
      userTurnIdempotencyKey,
      occurredAt,
    });
  }

  private commitStartedOutcome(context: {
    input: PreflightResponseStartInput;
    resolution: InferenceRouteResolved;
    userTurnPayload: SessionEventV1['payload'];
    userTurnEventId: string;
    userTurnIdempotencyKey: string;
    occurredAt: string;
  }): PreflightResponseStartedOutcome {
    const startedPayload = buildStartedPayload(context.input, context.resolution.route);
    const startedIdempotencyKey = stableResponseEventIdempotencyKey(
      context.input.identity,
      'started',
    );
    const startedEventId = deterministicEventId(
      IDEMPOTENCY_NAMESPACE,
      'started',
      context.input.identity.sessionId,
      context.input.identity.branchId,
      context.input.identity.responseId,
      context.input.identity.requestId,
      String(context.input.identity.attempt),
    );

    const receipts = this.sessionLog.appendBatch({
      sessionId: context.input.identity.sessionId,
      branchId: context.input.identity.branchId,
      events: [
        {
          eventId: context.userTurnEventId,
          eventType: 'message.user',
          payload: context.userTurnPayload,
          actor: context.input.actor,
          scope: context.input.scope,
          occurredAt: context.occurredAt,
          idempotencyKey: context.userTurnIdempotencyKey,
        },
        {
          eventId: startedEventId,
          eventType: 'response.started',
          payload: startedPayload as unknown as SessionEventV1['payload'],
          actor: context.input.actor,
          scope: context.input.scope,
          occurredAt: context.occurredAt,
          idempotencyKey: startedIdempotencyKey,
        },
      ],
    });

    return {
      kind: 'started',
      route: context.resolution.route,
      decision: context.resolution.decision,
      selectedLocality: context.resolution.selectedLocality,
      startedEvent: startedPayload,
      userTurnEvent: context.userTurnPayload,
      receipts: {
        userTurn: receipts[0],
        responseStarted: receipts[1],
      },
    };
  }

  private commitFailedOutcome(context: {
    input: PreflightResponseStartInput;
    failure: InferenceRouteFailedClosed;
    userTurnPayload: SessionEventV1['payload'];
    userTurnEventId: string;
    userTurnIdempotencyKey: string;
    occurredAt: string;
  }): PreflightResponseFailedOutcome {
    const classification = FAILURE_CLASSIFICATION[context.failure.failureCode];
    const correlationId = this.createCorrelationId();
    const errorId = this.createErrorId();
    const failedPayload = buildFailedPayload(
      context.input,
      context.failure,
      classification,
      errorId,
      correlationId,
    );
    const failedIdempotencyKey = stableResponseEventIdempotencyKey(
      context.input.identity,
      'failed',
    );
    const failedEventId = deterministicEventId(
      IDEMPOTENCY_NAMESPACE,
      'failed',
      context.input.identity.sessionId,
      context.input.identity.branchId,
      context.input.identity.responseId,
      context.input.identity.requestId,
      String(context.input.identity.attempt),
    );

    const receipts = this.sessionLog.appendBatch({
      sessionId: context.input.identity.sessionId,
      branchId: context.input.identity.branchId,
      events: [
        {
          eventId: context.userTurnEventId,
          eventType: 'message.user',
          payload: context.userTurnPayload,
          actor: context.input.actor,
          scope: context.input.scope,
          occurredAt: context.occurredAt,
          idempotencyKey: context.userTurnIdempotencyKey,
        },
        {
          eventId: failedEventId,
          eventType: 'response.failed',
          payload: failedPayload as unknown as SessionEventV1['payload'],
          actor: context.input.actor,
          scope: context.input.scope,
          occurredAt: context.occurredAt,
          idempotencyKey: failedIdempotencyKey,
        },
      ],
    });

    return {
      kind: 'failed-closed',
      failureCode: context.failure.failureCode,
      errorClass: classification.errorClass,
      summary: context.failure.explanation,
      correlationId,
      errorId,
      retry: failedPayload.retry,
      failure: context.failure,
      failedEvent: failedPayload,
      userTurnEvent: context.userTurnPayload,
      receipts: {
        userTurn: receipts[0],
        responseFailed: receipts[1],
      },
    };
  }
}

// ─── Validation ────────────────────────────────────────────────

/**
 * Guard the shape of caller input so downstream Zod parsing surfaces the
 * failure at a clear location. This is deliberately lightweight — the
 * canonical schemas own the deep validation.
 */
function validateInput(input: PreflightResponseStartInput): void {
  if (input.identity.sessionId.length === 0) {
    throw new Error('preflight input requires a non-empty identity.sessionId');
  }
  if (input.identity.branchId.length === 0) {
    throw new Error('preflight input requires a non-empty identity.branchId');
  }
  if (input.identity.turnId.length === 0) {
    throw new Error('preflight input requires a non-empty identity.turnId');
  }
  if (input.identity.responseId.length === 0) {
    throw new Error('preflight input requires a non-empty identity.responseId');
  }
  if (input.identity.requestId.length === 0) {
    throw new Error('preflight input requires a non-empty identity.requestId');
  }
  if (!Number.isInteger(input.identity.attempt) || input.identity.attempt < 0) {
    throw new Error('preflight input requires a non-negative integer identity.attempt');
  }
  if (input.turn.messageId.length === 0) {
    throw new Error('preflight input requires a non-empty turn.messageId');
  }
  if (input.keys.responseStableKey.length === 0) {
    throw new Error('preflight input requires a non-empty keys.responseStableKey');
  }
  if (input.scope.sessionId !== undefined && input.scope.sessionId !== input.identity.sessionId) {
    throw new Error(
      'preflight input scope.sessionId does not match identity.sessionId',
    );
  }
}

function deterministicEventId(...parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

// ─── Compile-time exhaustiveness check ─────────────────────────

/**
 * If a new `InferenceRouteFailureCode` value is added without updating
 * `FAILURE_CLASSIFICATION`, this assertion fails to type-check. It is
 * intentionally never executed.
 */
function _assertExhaustiveFailureClassification(): void {
  const codes: readonly InferenceRouteFailureCode[] = [
    'no-provider-available',
    'proxy-credential-unavailable',
    'entitlement-rejected',
    'unregistered-provider',
    'cloud-fallback-transport-mismatch',
  ];
  for (const code of codes) {
    // Accessing the map forces the compiler to verify totality.
    void FAILURE_CLASSIFICATION[code];
  }
}
void _assertExhaustiveFailureClassification;
