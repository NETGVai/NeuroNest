/**
 * User-initiated stop semantics for chat responses.
 *
 * Task 7.7 (Requirements 8.6, 8.7, 10.6, 10.10, 15.5):
 *
 *  - Abort the active transport for the response identity.
 *  - Idempotently append EXACTLY ONE `response.stopped` terminal event
 *    through `ResponseTerminalLifecycle`.
 *  - Preserve every previously committed answer/reasoning/tool/task/
 *    approval/thinking upsert — the appender never mutates or reorders
 *    prior events, and the stop terminal is appended after them.
 *  - Do NOT emit a `response.stopped` for a response that has already
 *    reached a terminal state; the caller receives the prior receipt when
 *    a stop is repeated so downstream projections see a single terminal
 *    per attempt.
 *
 * ─── Transport abort registry ──────────────────────────────────────────────
 *
 * The stop service does not own the active `AbortController` for a request
 * — that controller is created and held by whichever component initiated
 * the transport (proxy adapter, coordinated client, or a local adapter).
 * A caller-supplied {@link TransportAbortRegistry} is the abstract handle
 * this service uses to signal cancellation without pulling any transport-
 * specific code into the chat layer.
 *
 * The registry is intentionally minimal:
 *
 *   - `abort(requestId, reason?)` — signals the AbortController for the
 *     supplied request identifier. Returns `true` when a controller was
 *     registered and signaled, `false` when none was registered. Both
 *     outcomes are non-fatal because the durable stop terminal is
 *     independent of whether an in-flight controller existed (a stop
 *     arriving after the transport already finished is still valid).
 *
 * Callers integrate the registry with their transport lifecycle — typically
 * `register(requestId, controller)` on request start and `unregister` on
 * settle. This module does not enforce that shape; it only consumes the
 * `abort` capability.
 */

import type { ActorRef } from '../../harness/contracts/actor.js';
import type {
  ChatEventRouteV1,
  ResponseStoppedV1,
} from '../../harness/contracts/chat-stream-event.js';
import type { ScopeDescriptorV1 } from '../../harness/contracts/scope.js';
import type { AppendReceipt } from '../../harness/session-log/types.js';

import type {
  AppendStopTerminalInput,
  ResponseStopTerminalAppendResult,
  ResponseTerminalIdentity,
  ResponseTerminalLifecycle,
} from './response-lifecycle.js';

// ─── Public types ──────────────────────────────────────────────────────────

/**
 * Abstract handle over the transport-side AbortController registry. The
 * production wiring is expected to compose the registry with the LLM proxy
 * transport and any local adapters. In tests a plain in-memory map is
 * sufficient.
 */
export interface TransportAbortRegistry {
  /**
   * Signal cancellation on the controller registered against
   * {@link requestId}. Returns `true` when a controller was found and
   * aborted, `false` otherwise. Implementations MUST NOT throw for an
   * unknown request identifier — the service treats a miss as a benign
   * "already settled" condition.
   *
   * `reason` is an optional short identifier the transport can attach to
   * the AbortError. It is NEVER a place to encode prompt or response
   * content. The chat layer never inspects it.
   */
  abort(requestId: string, reason?: string): boolean;
}

/**
 * Everything the stop service needs to abort the active transport and
 * append a canonical `response.stopped` event.
 *
 * `route` mirrors the started event's route metadata. Callers propagate it
 * from `PreflightResponseStartService.startResponse().startedEvent.route`.
 */
export interface StopActiveResponseInput {
  readonly identity: ResponseTerminalIdentity;
  readonly actor: ActorRef;
  readonly scope: ScopeDescriptorV1;
  readonly route: ChatEventRouteV1;
  /**
   * Optional user-visible reason string. Passed through the shared
   * redactor before persistence — see {@link ResponseTerminalLifecycle.appendStopTerminal}.
   */
  readonly reason?: string;
  /**
   * Optional retry lineage hint. Stops emitted on retries link back to the
   * previous attempt via `previousRequestId`/`previousAttempt`.
   */
  readonly retryContext?: AppendStopTerminalInput['retryContext'];
  readonly occurredAt?: string;
}

/**
 * Result of a stop operation.
 *
 *  - `terminal`     : receipt + payload for the durable stop terminal.
 *  - `abortSignaled`: `true` when the transport registry acknowledged the
 *    abort. `false` when no controller was registered (already settled).
 *  - `wasAlreadyStopped`: `true` when the identity's stop terminal had
 *    already been committed prior to this call. The receipt is returned
 *    unchanged so callers can detect duplicate deliveries.
 */
export interface StopActiveResponseResult {
  readonly terminal: ResponseStopTerminalAppendResult;
  readonly abortSignaled: boolean;
  readonly wasAlreadyStopped: boolean;
}

/**
 * Dependencies for the stop service. The transport abort registry is
 * optional so early-boot callers that have not yet wired transport
 * lifecycle can still commit a durable stop terminal (for example, when a
 * renderer stop arrives after the transport already finished but before
 * the terminal was persisted).
 */
export interface ResponseStopServiceDependencies {
  readonly lifecycle: ResponseTerminalLifecycle;
  readonly transportAbort?: TransportAbortRegistry;
}

// ─── Service ───────────────────────────────────────────────────────────────

/**
 * User-driven cancellation entry point.
 *
 * A single instance can serve every session — the service holds no
 * per-request state. Idempotency, ordering, and content preservation are
 * all delegated to the composed {@link ResponseTerminalLifecycle}.
 */
export class ResponseStopService {
  private readonly lifecycle: ResponseTerminalLifecycle;
  private readonly transportAbort: TransportAbortRegistry | undefined;

  constructor(dependencies: ResponseStopServiceDependencies) {
    this.lifecycle = dependencies.lifecycle;
    this.transportAbort = dependencies.transportAbort;
  }

  /**
   * Stop an active response.
   *
   *   1. Abort the transport for `identity.requestId` if a controller is
   *      registered. This is fire-and-forget from the stop service's
   *      perspective — the transport handles its own cleanup.
   *   2. Append exactly one canonical `response.stopped` terminal event.
   *      A repeated stop for the same `(sessionId, branchId, responseId,
   *      requestId, attempt)` returns the prior receipt (idempotent).
   *
   * Ordering: the abort signal is dispatched BEFORE the terminal append so
   * any in-flight decoder that races the stop cannot commit new content
   * after the terminal is durable. If the transport does not respond to
   * abort synchronously that is acceptable — the terminal event, once
   * committed, is the authoritative signal to projectors and the renderer.
   */
  stopActiveResponse(input: StopActiveResponseInput): StopActiveResponseResult {
    const abortSignaled = this.transportAbort
      ? this.transportAbort.abort(input.identity.requestId, input.reason)
      : false;

    const terminal = this.lifecycle.appendStopTerminal({
      identity: input.identity,
      actor: input.actor,
      scope: input.scope,
      route: input.route,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.retryContext !== undefined ? { retryContext: input.retryContext } : {}),
      ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {}),
    });

    return {
      terminal,
      abortSignaled,
      wasAlreadyStopped: terminal.receipt.alreadyExists,
    };
  }
}

// ─── Minimal in-memory transport-abort registry (for wiring convenience) ──

/**
 * Trivial in-memory implementation of {@link TransportAbortRegistry}. A
 * production wiring typically holds a single instance in the main-process
 * chat singleton and registers controllers as the transport starts each
 * request.
 *
 * Usage:
 *   const registry = new InMemoryTransportAbortRegistry();
 *   registry.register(requestId, controller);   // when transport starts
 *   registry.unregister(requestId);             // when transport settles
 *   registry.abort(requestId, 'user-stop');     // when stop is requested
 */
export class InMemoryTransportAbortRegistry implements TransportAbortRegistry {
  private readonly controllers = new Map<string, AbortController>();

  register(requestId: string, controller: AbortController): void {
    if (requestId.length === 0) {
      throw new Error('transport abort registry requires a non-empty requestId');
    }
    // Registration is idempotent per requestId. If a caller re-registers
    // with a new controller, previous holders lose their reference — this
    // is intentional because a fresh transport start implicitly retires
    // the prior controller.
    this.controllers.set(requestId, controller);
  }

  unregister(requestId: string): void {
    this.controllers.delete(requestId);
  }

  abort(requestId: string, reason?: string): boolean {
    const controller = this.controllers.get(requestId);
    if (!controller) return false;
    // The abort call itself is synchronous; the transport observes it via
    // its AbortSignal listeners. Remove the controller so a subsequent
    // stop delivery does not double-signal.
    if (reason !== undefined) {
      controller.abort(new DOMException(reason, 'AbortError'));
    } else {
      controller.abort();
    }
    this.controllers.delete(requestId);
    return true;
  }

  /** Test helper. Non-production surface. */
  size(): number {
    return this.controllers.size;
  }
}

// ─── Convenience re-exports ────────────────────────────────────────────────

export type { AppendReceipt, ResponseStoppedV1 };
