//
// Wiring stub that demonstrates how the existing tool-call rendering
// site (today shown as a "Writing…" spinner) is replaced with the
// Tool_Diff_Stream pipeline.
//
// In a fully Phase-3-substrate codebase, this wiring would live inline
// at the site in `src/renderer/index.ts` that today renders the
// "Writing…" placeholder for `writeFile` / `writeSpec` / `editSpec`
// tool calls. That substrate (chat-message event stream with
// `tool_start` / `tool_input_delta` / `tool_done` / `tool_cancelled`
// events) is not yet present in this branch, so the integration is
// captured here as a small, self-contained module that:
//
//   1. Switches on `event.toolName ∈ DIFF_STREAM_TOOL_IDS`. When the
//      tool is one of the three write tools, it instantiates a
//      `ToolDiffStream`, attaches it to the chat-message event stream,
//      and pipes every emitted `DiffStreamFrame` through
//      `DiffRenderer.render` into the host element supplied by the
//      caller (Req 3.1, 3.2, 3.8).
//   2. Falls through to the existing tool-call placeholder unchanged
//      for any other tool ID (Req 3.1).
//   3. Wires the cancellation channel: when the user cancels the chat
//      turn (e.g. clicks Stop / closes the headless connection), the
//      `AbortSignal` propagates a `tool_cancelled` event to the
//      diff-stream for any in-flight tool calls so the partial diff is
//      frozen and the cancellation indicator is rendered (Req 3.6,
//      3.10).
//
// Renderer-only (Req 3.7): the integration adds NO new IPC channel,
// makes NO `ipcRenderer.invoke` / `send` / `sendSync` calls, issues
// NO `fetch`, opens NO `WebSocket`. Every byte it touches is already
// on the chat-message event stream the renderer subscribes to.
//
// Validates: Requirements 3.1, 3.2, 3.5, 3.6, 3.8

import { DiffRenderer } from './diff-renderer';
import {
  createToolDiffStream,
  type ChatMessageEventMap,
  type ChatMessageEventStream,
  type ToolDiffStream,
  type ToolStartEvent,
} from './tool-diff-stream';
import { DIFF_STREAM_TOOL_IDS, type DiffStreamFrame } from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A pluggable factory for the existing tool-call placeholder UI. The
 *  default chat-message component already builds a "Writing…" spinner
 *  for every non-diff-stream tool call; this integration accepts that
 *  factory as an injectable hook so the existing placeholder code path
 *  is preserved unchanged for tools that are not in `DIFF_STREAM_TOOL_IDS`
 *  (Req 3.1 fall-through). */
export type DefaultPlaceholderFactory = (event: ToolStartEvent) => HTMLElement;

/** Inputs the integration needs to wire a tool-call rendering site to
 *  the diff-stream pipeline. */
export interface DiffStreamIntegrationOptions {
  /** The chat-message event stream the renderer already subscribes to.
   *  The integration listens for `tool_start` events on this stream
   *  and, for diff-stream-eligible tool calls, dispatches their
   *  subsequent `tool_input_delta` / `tool_done` / `tool_cancelled`
   *  events through a `ToolDiffStream`. */
  stream: ChatMessageEventStream;

  /** A function the integration calls each time it needs to mount the
   *  rendered output (placeholder OR diff frame) into the chat
   *  message. The chat-message component is responsible for slotting
   *  the returned element under the correct message body (mirrors
   *  Phase 2's media renderer placement; Req 3.8). */
  mountToolCall: (event: ToolStartEvent, element: HTMLElement) => void;

  /** Factory for the existing tool-call placeholder UI. Used as the
   *  fall-through path for any tool whose name is NOT in
   *  `DIFF_STREAM_TOOL_IDS` (Req 3.1). */
  defaultPlaceholder: DefaultPlaceholderFactory;

  /** AbortSignal that fires when the user cancels the chat turn. The
   *  integration listens for `abort` and emits a `tool_cancelled`
   *  event for every in-flight diff-stream tool call (Req 3.6, 3.10). */
  cancelSignal: AbortSignal;

  /** Optional override for the diff stream factory. Tests pass a stub
   *  here; production callers omit this and get the default
   *  implementation. */
  toolDiffStreamFactory?: () => ToolDiffStream;
}

/** Handle returned by `wireDiffStreamIntegration`. Mostly opaque — the
 *  caller's only need is to drop the reference when the chat-message
 *  unmounts. */
export interface DiffStreamIntegrationHandle {
  /** Direct accessor for the underlying `ToolDiffStream`, exposed so
   *  tests can assert on `getFrame` / `subscribe` behaviour. */
  readonly toolDiffStream: ToolDiffStream;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Wire the tool-call rendering site to the Tool_Diff_Stream pipeline.
 *
 * For each `tool_start` event observed on the chat-message stream:
 *   - When `event.toolName ∈ DIFF_STREAM_TOOL_IDS`, the integration
 *     subscribes to the `ToolDiffStream` for that `toolCallId` and
 *     mounts a freshly rendered `DiffStreamFrame` element on every
 *     frame change (Req 3.1, 3.2, 3.8).
 *   - Otherwise, the integration calls `defaultPlaceholder(event)`
 *     and mounts the resulting element unchanged — preserving the
 *     existing "Writing…" placeholder for non-diff-stream tools
 *     (Req 3.1 fall-through).
 *
 * Cancellation (Req 3.6, 3.10): when `cancelSignal.aborted` flips to
 * `true`, the integration synthesises a `tool_cancelled` event for
 * every in-flight diff-stream tool call. The diff-stream then freezes
 * the partial diff and the renderer appends a cancellation indicator
 * via `DiffRenderer.render`.
 */
export function wireDiffStreamIntegration(
  opts: DiffStreamIntegrationOptions,
): DiffStreamIntegrationHandle {
  const {
    stream,
    mountToolCall,
    defaultPlaceholder,
    cancelSignal,
    toolDiffStreamFactory = createToolDiffStream,
  } = opts;

  // The diff-stream attaches to a forwarding wrapper around the
  // upstream chat-message stream. The wrapper forwards every upstream
  // event verbatim and additionally exposes an internal hook the
  // integration uses to inject synthetic `tool_cancelled` events when
  // the user cancels the chat turn — without requiring the upstream
  // stream to expose a public `emit` surface.
  const forwarder = new ForwardingStream(stream);

  const toolDiffStream = toolDiffStreamFactory();
  toolDiffStream.attach(forwarder);

  // Track in-flight diff-stream tool calls so that on chat-turn
  // cancellation we can route a `tool_cancelled` event for each one
  // through the diff-stream. Entries are removed on stability or on
  // cancellation transition (whichever happens first).
  const inFlight = new Set<string>();

  stream.on('tool_start', (event) => {
    if (!isDiffStreamTool(event.toolName)) {
      // Fall-through path (Req 3.1): hand off to the existing tool-call
      // placeholder unchanged.
      mountToolCall(event, defaultPlaceholder(event));
      return;
    }

    inFlight.add(event.toolCallId);

    // Subscribe to the diff-stream and mount a freshly rendered
    // element on every frame change. The `subscribe` contract fires
    // synchronously with the current frame on first call so the
    // initial mount is observed without an extra event round-trip
    // (covers Req 3.5: partial structured rendering on `tool_start`).
    let mounted = false;
    toolDiffStream.subscribe(event.toolCallId, (frame: DiffStreamFrame) => {
      const element = DiffRenderer.render(frame);
      mountToolCall(event, element);
      mounted = true;

      if (frame.stable || frame.cancelled) {
        inFlight.delete(frame.toolCallId);
      }
    });

    // Defensive: if no frame was emitted synchronously (a stream that
    // does not surface a current frame on `subscribe` until the next
    // event), mount the placeholder so the chat message has visible
    // chrome between `tool_start` and the first delta.
    if (!mounted) {
      mountToolCall(event, defaultPlaceholder(event));
    }
  });

  // Cancellation channel (Req 3.6, 3.10).
  const onCancel = (): void => {
    // Synthesise a `tool_cancelled` event for every in-flight
    // diff-stream call and route it through the forwarder so the
    // diff-stream's `tool_cancelled` handler runs and the partial
    // diff is frozen with `frame.cancelled = true`.
    for (const toolCallId of Array.from(inFlight)) {
      forwarder.injectCancellation(toolCallId);
    }
    inFlight.clear();
  };

  if (cancelSignal.aborted) {
    // Already aborted — fire once on the next microtask so the
    // diff-stream has a chance to register `tool_start` listeners
    // before the cancellation lands.
    queueMicrotask(onCancel);
  } else {
    cancelSignal.addEventListener('abort', onCancel, { once: true });
  }

  return { toolDiffStream };
}

// ---------------------------------------------------------------------------
// Re-exports — convenience surface for the renderer site
// ---------------------------------------------------------------------------

export { DiffRenderer } from './diff-renderer';
export {
  createToolDiffStream,
  type ChatMessageEventStream,
  type ToolDiffStream,
  type ToolStartEvent,
  type ToolInputDeltaEvent,
  type ToolDoneEvent,
  type ToolCancelledEvent,
} from './tool-diff-stream';
export { DIFF_STREAM_TOOL_IDS, type DiffStreamFrame } from './types';

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isDiffStreamTool(
  name: string,
): name is typeof DIFF_STREAM_TOOL_IDS[number] {
  return (DIFF_STREAM_TOOL_IDS as ReadonlyArray<string>).includes(name);
}

/**
 * Stream wrapper that forwards every upstream chat-message event to
 * any handler registered on it AND exposes `injectCancellation` so the
 * integration can synthesise `tool_cancelled` events when the user
 * cancels the chat turn.
 *
 * Implements the same `ChatMessageEventStream` contract the diff-stream
 * expects, so the diff-stream is unaware that it is attached to a
 * wrapper rather than the upstream source.
 */
class ForwardingStream implements ChatMessageEventStream {
  private readonly handlers: {
    tool_start:        Set<(p: ChatMessageEventMap['tool_start']) => void>;
    tool_input_delta:  Set<(p: ChatMessageEventMap['tool_input_delta']) => void>;
    tool_done:         Set<(p: ChatMessageEventMap['tool_done']) => void>;
    tool_cancelled:    Set<(p: ChatMessageEventMap['tool_cancelled']) => void>;
  } = {
    tool_start:        new Set(),
    tool_input_delta:  new Set(),
    tool_done:         new Set(),
    tool_cancelled:    new Set(),
  };

  constructor(upstream: ChatMessageEventStream) {
    upstream.on('tool_start',       (p) => this.dispatch('tool_start', p));
    upstream.on('tool_input_delta', (p) => this.dispatch('tool_input_delta', p));
    upstream.on('tool_done',        (p) => this.dispatch('tool_done', p));
    upstream.on('tool_cancelled',   (p) => this.dispatch('tool_cancelled', p));
  }

  on<K extends keyof ChatMessageEventMap>(
    event:    K,
    handler:  (payload: ChatMessageEventMap[K]) => void,
  ): void {
    // The handler types are dispatched by event key, so a dynamic
    // index is sound and TypeScript's narrowing-through-string-keys
    // limitation is the only reason we need the cast.
    (this.handlers[event] as Set<(p: ChatMessageEventMap[K]) => void>).add(handler);
  }

  off<K extends keyof ChatMessageEventMap>(
    event:    K,
    handler:  (payload: ChatMessageEventMap[K]) => void,
  ): void {
    (this.handlers[event] as Set<(p: ChatMessageEventMap[K]) => void>).delete(handler);
  }

  injectCancellation(toolCallId: string): void {
    this.dispatch('tool_cancelled', { type: 'tool_cancelled', toolCallId });
  }

  private dispatch<K extends keyof ChatMessageEventMap>(
    event:   K,
    payload: ChatMessageEventMap[K],
  ): void {
    // Snapshot before iteration so handlers that unsubscribe themselves
    // do not skip siblings.
    const snapshot = Array.from(
      this.handlers[event] as Set<(p: ChatMessageEventMap[K]) => void>,
    );
    for (const h of snapshot) {
      try {
        h(payload);
      } catch {
        // A misbehaving subscriber must not break others. Swallow —
        // the chat-message component owns end-user error reporting.
      }
    }
  }
}
