/**
 * True incremental provider streaming with abort, reconnect-resume, and bounded
 * retries (FUT-PKG-06-EXECUTION/T-007).
 *
 * NN-PROXY-011 / NN-CHAT-004 require the provider→renderer transport to stay
 * end-to-end incremental (no full-response buffering), to abort upstream work
 * on client disconnect/cancellation, and to preserve partial output and usage.
 * This module implements a stream accumulator that:
 *
 *   - appends provider deltas in order to a durable partial buffer, tracking a
 *     monotonic committed offset (the number of chunks durably accepted);
 *   - on client disconnect, aborts the upstream source and preserves the
 *     partial buffer and the usage observed so far;
 *   - on reconnect, RESUMES from the committed offset — replaying only the
 *     already-committed prefix so the consumer never loses committed content
 *     and never sees a committed chunk twice (the reconnect-resume invariant);
 *   - retries a *retryable* upstream failure a bounded number of times, always
 *     resuming from the committed offset so a retry never duplicates or drops
 *     committed content (D-18 bounded recovery).
 *
 * The upstream provider is an injected {@link StreamSource} port so tests can
 * observe incrementality, aborts, and reconnects without a real socket. Deltas
 * are visual-coalesced only for presentation; the durable content/order is the
 * ordered concatenation of accepted chunks.
 *
 * Design anchors: D-10, D-11, D-18.
 * Requirements: NN-PROXY-011, NN-CHAT-004, NN-ORCH-010, NN-INV-003.
 */

import {
  providerError,
  type ProviderFailureClass,
  isRetryableFailure,
  DEFAULT_MAX_RETRIES,
} from './provider-types';
import type { ErrorEnvelope } from '../shared/contract-primitives';

/** A single incremental chunk from a provider. */
export interface StreamChunk {
  /** Zero-based ordinal in the overall stream (monotonic, gap-free). */
  readonly index: number;
  /** The incremental text delta. */
  readonly delta: string;
  /** Tokens observed so far (running counts), if the provider reports them. */
  readonly promptTokens?: number;
  readonly completionTokens?: number;
}

/** A terminal usage/result marker at the end of a successful stream. */
export interface StreamTerminal {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly reported: boolean;
  readonly upstreamStatus: number;
}

/** What a provider stream emits: an ordered chunk, a terminal, or a failure. */
export type StreamEvent =
  | { readonly kind: 'chunk'; readonly chunk: StreamChunk }
  | { readonly kind: 'terminal'; readonly terminal: StreamTerminal }
  | { readonly kind: 'failure'; readonly failureClass: ProviderFailureClass };

/**
 * An abortable upstream stream source. `open(fromOffset)` begins (or resumes)
 * the upstream from a committed offset and returns an async iterator of events;
 * `abort()` tears the upstream down (client disconnect / cancellation). A
 * well-behaved source, when resumed from `fromOffset`, emits only chunks at
 * index >= `fromOffset` so the accumulator never re-commits a prefix.
 */
export interface StreamSource {
  open(fromOffset: number, signal: AbortHandle): AsyncIterator<StreamEvent>;
  /** Whether this source supports resuming from a non-zero offset. */
  readonly resumable: boolean;
}

/** A cooperative abort handle shared with the source. */
export class AbortHandle {
  #aborted = false;
  /** Whether abort has been signalled. */
  get aborted(): boolean {
    return this.#aborted;
  }
  /** Signal abort; the source should stop producing and release resources. */
  abort(): void {
    this.#aborted = true;
  }
}

/** The durable partial state preserved across disconnect/reconnect. */
export interface DurablePartial {
  /** Ordered committed chunks (the durable content). */
  readonly chunks: readonly StreamChunk[];
  /** The committed offset = number of durably accepted chunks. */
  readonly committedOffset: number;
  /** Running token counts from the last committed chunk/terminal. */
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Whether the stream reached a verified terminal. */
  readonly complete: boolean;
  readonly reported: boolean;
  readonly upstreamStatus: number;
}

/** A fresh, empty durable partial. */
export function emptyPartial(): DurablePartial {
  return {
    chunks: [],
    committedOffset: 0,
    promptTokens: 0,
    completionTokens: 0,
    complete: false,
    reported: false,
    upstreamStatus: 0,
  };
}

/** The concatenated durable content of a partial (ordered, gap-free). */
export function partialContent(partial: DurablePartial): string {
  return partial.chunks.map((c) => c.delta).join('');
}

/** Options for a streaming run. */
export interface StreamRunOptions {
  readonly correlationId: string;
  /** Bounded retry budget for retryable upstream failures (D-18). */
  readonly maxRetries?: number;
  /** Injected clock for deadline math (ms epoch). */
  readonly nowMs?: () => number;
  /** Stream deadline in ms (NN-PROXY-011: 300s). */
  readonly deadlineMs?: number;
  /**
   * A disconnect controller: when it signals, the run aborts the upstream and
   * returns a preserved partial (client disconnect / cancellation).
   */
  readonly disconnect?: AbortHandle;
}

/** The outcome of a streaming run. */
export type StreamOutcome =
  | { readonly kind: 'completed'; readonly partial: DurablePartial }
  | {
      readonly kind: 'interrupted';
      readonly partial: DurablePartial;
      readonly reason: 'disconnect' | 'cancelled';
    }
  | {
      readonly kind: 'failed';
      readonly partial: DurablePartial;
      readonly failureClass: ProviderFailureClass;
      readonly error: ErrorEnvelope;
    };

/**
 * Accept the next event into a durable partial, enforcing the incremental and
 * no-duplicate invariants. A chunk whose index is below the committed offset is
 * a resume-replay of an already-committed chunk and is IGNORED (never
 * double-committed). A chunk exactly at the committed offset advances the
 * offset by one. A chunk beyond `committedOffset` (a gap) is rejected as a
 * protocol violation. Returns the next partial (unchanged for an ignored
 * replay).
 */
export function acceptChunk(partial: DurablePartial, chunk: StreamChunk): DurablePartial {
  if (chunk.index < partial.committedOffset) {
    // Already committed (resume replay): ignore, no duplication.
    return partial;
  }
  if (chunk.index > partial.committedOffset) {
    // A gap: the source skipped a committed chunk. Refuse to accept out of
    // order (would lose content); keep the partial unchanged.
    return partial;
  }
  return {
    ...partial,
    chunks: [...partial.chunks, chunk],
    committedOffset: partial.committedOffset + 1,
    promptTokens: chunk.promptTokens ?? partial.promptTokens,
    completionTokens: chunk.completionTokens ?? partial.completionTokens,
  };
}

/**
 * Run an incremental stream to completion, aborting on disconnect and retrying
 * bounded retryable failures with reconnect-resume from the committed offset.
 *
 * Invariants enforced (V-PROXY-001/provider-stream-contract):
 *   - the durable content is the ordered concatenation of accepted chunks;
 *   - a disconnect aborts the upstream and preserves the partial + usage;
 *   - a reconnect/retry resumes from `committedOffset` and never double-commits
 *     an already-committed chunk nor loses one;
 *   - retries are bounded; exhaustion returns a typed failure with the
 *     preserved partial (no forward beyond the boundary, no fallback).
 */
export async function runStream(
  source: StreamSource,
  options: StreamRunOptions,
): Promise<StreamOutcome> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const nowMs = options.nowMs ?? (() => Date.now());
  const deadlineMs = options.deadlineMs;
  const startedAt = nowMs();
  const disconnect = options.disconnect ?? new AbortHandle();

  let partial = emptyPartial();
  let attempt = 0;
  let lastFailure: ProviderFailureClass = 'upstream-error';

  while (attempt <= maxRetries) {
    if (disconnect.aborted) {
      return { kind: 'interrupted', partial, reason: 'disconnect' };
    }
    if (deadlineMs !== undefined && nowMs() - startedAt >= deadlineMs) {
      return {
        kind: 'failed',
        partial,
        failureClass: 'timeout',
        error: providerError('timeout', 'stream deadline exceeded', options.correlationId, {
          operation: 'stream',
          effectKnown: true,
        }),
      };
    }

    // A retry that cannot resume from a non-zero offset would risk duplicating
    // or losing committed content: refuse rather than double-forward.
    if (attempt > 0 && partial.committedOffset > 0 && !source.resumable) {
      return {
        kind: 'failed',
        partial,
        failureClass: lastFailure,
        error: providerError(
          lastFailure,
          'upstream is not resumable; refusing to retry after committed content',
          options.correlationId,
          { operation: 'stream', effectKnown: true },
        ),
      };
    }

    const iterator = source.open(partial.committedOffset, disconnect);
    const result = await consume(iterator, partial, disconnect, options, nowMs, startedAt, deadlineMs);
    partial = result.partial;

    if (result.status === 'completed') {
      return { kind: 'completed', partial };
    }
    if (result.status === 'interrupted') {
      return { kind: 'interrupted', partial, reason: result.reason };
    }
    // failure
    lastFailure = result.failureClass;
    if (result.status === 'failed' && result.terminal) {
      // A terminal, non-retryable failure: stop immediately.
      return {
        kind: 'failed',
        partial,
        failureClass: result.failureClass,
        error: providerError(result.failureClass, result.message, options.correlationId, {
          operation: 'stream',
          effectKnown: true,
        }),
      };
    }
    if (!isRetryableFailure(result.failureClass)) {
      return {
        kind: 'failed',
        partial,
        failureClass: result.failureClass,
        error: providerError(result.failureClass, result.message, options.correlationId, {
          operation: 'stream',
          effectKnown: true,
        }),
      };
    }
    attempt += 1;
  }

  return {
    kind: 'failed',
    partial,
    failureClass: lastFailure,
    error: providerError(lastFailure, 'bounded retries exhausted', options.correlationId, {
      operation: 'stream',
      effectKnown: true,
    }),
  };
}

interface ConsumeResult {
  readonly partial: DurablePartial;
  readonly status: 'completed' | 'interrupted' | 'failed';
  readonly reason: 'disconnect' | 'cancelled';
  readonly failureClass: ProviderFailureClass;
  readonly message: string;
  readonly terminal: boolean;
}

/** Drain one upstream attempt, applying chunks and honoring disconnect/deadline. */
async function consume(
  iterator: AsyncIterator<StreamEvent>,
  startPartial: DurablePartial,
  disconnect: AbortHandle,
  options: StreamRunOptions,
  nowMs: () => number,
  startedAt: number,
  deadlineMs: number | undefined,
): Promise<ConsumeResult> {
  let partial = startPartial;
  for (;;) {
    if (disconnect.aborted) {
      await safeReturn(iterator);
      return {
        partial,
        status: 'interrupted',
        reason: 'disconnect',
        failureClass: 'cancelled',
        message: 'client disconnected',
        terminal: true,
      };
    }
    if (deadlineMs !== undefined && nowMs() - startedAt >= deadlineMs) {
      disconnect.abort();
      await safeReturn(iterator);
      return {
        partial,
        status: 'failed',
        reason: 'cancelled',
        failureClass: 'timeout',
        message: 'stream deadline exceeded',
        terminal: true,
      };
    }

    let next: IteratorResult<StreamEvent>;
    try {
      next = await iterator.next();
    } catch {
      return {
        partial,
        status: 'failed',
        reason: 'cancelled',
        failureClass: 'upstream-error',
        message: 'upstream iterator threw',
        terminal: false,
      };
    }
    if (next.done) {
      // Stream ended without a terminal marker: treat as a retryable upstream
      // interruption so the run can resume from the committed offset.
      return {
        partial,
        status: 'failed',
        reason: 'cancelled',
        failureClass: 'upstream-error',
        message: 'upstream ended without a terminal marker',
        terminal: false,
      };
    }

    // If the client disconnected while this chunk was in flight, abort before
    // committing it so the preserved partial reflects only pre-disconnect
    // content (the upstream is torn down without accepting the racing chunk).
    if (disconnect.aborted) {
      await safeReturn(iterator);
      return {
        partial,
        status: 'interrupted',
        reason: 'disconnect',
        failureClass: 'cancelled',
        message: 'client disconnected',
        terminal: true,
      };
    }

    const event = next.value;
    if (event.kind === 'chunk') {
      partial = acceptChunk(partial, event.chunk);
      continue;
    }
    if (event.kind === 'terminal') {
      partial = {
        ...partial,
        promptTokens: event.terminal.promptTokens,
        completionTokens: event.terminal.completionTokens,
        complete: true,
        reported: event.terminal.reported,
        upstreamStatus: event.terminal.upstreamStatus,
      };
      return {
        partial,
        status: 'completed',
        reason: 'cancelled',
        failureClass: 'upstream-error',
        message: '',
        terminal: true,
      };
    }
    // failure event
    return {
      partial,
      status: 'failed',
      reason: 'cancelled',
      failureClass: event.failureClass,
      message: `upstream failure: ${event.failureClass}`,
      terminal: !isRetryableFailure(event.failureClass),
    };
  }
}

async function safeReturn(iterator: AsyncIterator<StreamEvent>): Promise<void> {
  if (typeof iterator.return === 'function') {
    try {
      await iterator.return(undefined);
    } catch {
      /* best-effort teardown */
    }
  }
}
