//
// Renderer-side accumulation of `tool_start` / `tool_input_delta` /
// `tool_done` (and cancellation) events emitted by the chat-message
// event stream into per-tool-call `DiffStreamFrame` snapshots.
//
// Architectural invariants (Req 3.7):
//   - Subscribes to events the renderer already receives. Adds NO new
//     IPC channel, makes NO `ipcRenderer.invoke` / `send` / `sendSync`
//     calls, issues NO `fetch`, opens NO `WebSocket`, instantiates NO
//     `XMLHttpRequest`. Diff math is a pure function of
//     `(preImage, accumulatedPostImage)`.
//   - The pre-image is read from the cached payload the agent loop
//     attaches to `tool_start` (writeFile / writeSpec) or from the
//     `input.heading`-resolved section bytes attached to `tool_start`
//     (editSpec). No fresh disk read, no IPC round-trip.
//
// Stability (Req 3.9): on `tool_done`, the accumulated post-image is
// compared to the agent-loop-reported disk-bound bytes. On equality,
// `frame.stable` flips to `true` exactly once and any subsequent
// `tool_input_delta` events for the same `toolCallId` are silently
// dropped — preventing the late-arriving-chunk flicker described in
// the wire-shape design (§ Data Models D).
//
// Cancellation (Req 3.10): on cancellation, `frame.cancelled` is set
// to `true` and the frame is frozen — the partial diff already shown
// is retained and no further events mutate it.
//
// Validates: Requirements 3.1, 3.2, 3.4, 3.6, 3.7, 3.9, 3.10, 3.11

import { diffLines } from './myers-diff';
import {
  DIFF_STREAM_TOOL_IDS,
  type DiffStreamFrame,
  type DiffLine,
} from './types';

// ---------------------------------------------------------------------------
// Local event-stream interface
// ---------------------------------------------------------------------------

/** A discriminated union of the four chat-message event kinds the
 *  diff-stream listens on. The Phase 3 chat-message stream substrate
 *  may not yet be present in the codebase, so this file declares the
 *  minimal `on(event, handler)` shape it needs and lets concrete call
 *  sites adapt their stream object to it. */
export interface ToolStartEvent {
  type:        'tool_start';
  toolCallId:  string;
  toolName:    string;
  /** Initial input payload. For diff-stream tools the agent loop
   *  attaches the cached pre-image and (for `editSpec`) a resolved
   *  `heading` section reference. Other fields (e.g. `path`,
   *  `partial`) are passed through but not interpreted here. */
  input?:      ToolStartInput;
  /** Pre-image bytes attached by the agent loop. For `writeFile` /
   *  `writeSpec` this is the existing on-disk content. For `editSpec`
   *  it is the resolved section body. Empty string if the file is
   *  being created and there is no pre-image. */
  preImage?:   string;
}

export interface ToolStartInput {
  /** For `editSpec`. Used to populate `frame.headingPath` (Req 3.11). */
  heading?:    string;
  /** Caller-provided pre-image — the agent loop may attach the
   *  resolved section bytes here as an alternative to the top-level
   *  `preImage` field. Both locations are inspected at `tool_start`. */
  preImage?:   string;
  /** For `writeFile` / `writeSpec` partial events: the prefix of the
   *  content available at the time of `tool_start`. Treated as the
   *  initial post-image accumulator value when present. */
  content?:    string;
  /** Allow other fields to pass through without forcing this interface
   *  to enumerate the full agent-loop input shape. */
  [key: string]: unknown;
}

export interface ToolInputDeltaEvent {
  type:        'tool_input_delta';
  toolCallId:  string;
  /** The new bytes appended to the streamed `content` arg. */
  delta:       string;
}

export interface ToolDoneEvent {
  type:           'tool_done';
  toolCallId:     string;
  /** The bytes the agent loop is about to write to disk for this call.
   *  When equal to the accumulated post-image, the frame transitions
   *  to `stable` (Req 3.9). When undefined, no stability transition is
   *  attempted on this `tool_done` (the frame remains unstable). */
  diskBoundBytes?: string;
}

export interface ToolCancelledEvent {
  type:        'tool_cancelled';
  toolCallId:  string;
}

export type ChatMessageEvent =
  | ToolStartEvent
  | ToolInputDeltaEvent
  | ToolDoneEvent
  | ToolCancelledEvent;

/** Map from event-name string to the matching event payload type — the
 *  on() overloads below dispatch on this map. */
export interface ChatMessageEventMap {
  tool_start:        ToolStartEvent;
  tool_input_delta:  ToolInputDeltaEvent;
  tool_done:         ToolDoneEvent;
  tool_cancelled:    ToolCancelledEvent;
}

/** The minimal contract the diff-stream needs from whatever event
 *  source the chat-message component already exposes. The Phase 3
 *  substrate may surface this as a Node `EventEmitter`, a custom
 *  `EventTarget`, or a plain object with `on`/`off`. The shape below
 *  is the lowest common denominator. */
export interface ChatMessageEventStream {
  on<K extends keyof ChatMessageEventMap>(
    event:    K,
    handler:  (payload: ChatMessageEventMap[K]) => void,
  ): void;
  off?<K extends keyof ChatMessageEventMap>(
    event:    K,
    handler:  (payload: ChatMessageEventMap[K]) => void,
  ): void;
}

// ---------------------------------------------------------------------------
// ToolDiffStream interface
// ---------------------------------------------------------------------------

/** Subscriber callback. Receives a frozen `DiffStreamFrame` every time
 *  the stream's frame for a given `toolCallId` changes — including the
 *  initial frame on `tool_start`, every diff recomputation, the
 *  stability transition, and the cancellation transition. */
export type DiffStreamFrameHandler = (frame: DiffStreamFrame) => void;

export interface ToolDiffStream {
  /** Attach to a chat-message event stream. May be called once per
   *  stream; subsequent calls register additional listeners on the
   *  same source. The diff-stream stays attached for the lifetime of
   *  the stream (the chat-message component owns teardown). */
  attach(stream: ChatMessageEventStream): void;

  /** Returns the current frame for a tool call, or `undefined` if no
   *  matching `tool_start` has been observed for this id. The returned
   *  frame is frozen and safe to share. */
  getFrame(toolCallId: string): DiffStreamFrame | undefined;

  /** Subscribe to frame changes for one tool call. Fires synchronously
   *  with the current frame on subscription if one already exists.
   *  Returns an unsubscribe function. */
  subscribe(toolCallId: string, handler: DiffStreamFrameHandler): () => void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Above this post-image line count, recompute is deferred to
 *  `requestIdleCallback` per task spec (chunked recompute). */
const LARGE_POSTIMAGE_LINE_THRESHOLD = 5000;

interface RequestIdleCallbackHandle {
  cancel(): void;
}

/** Cross-environment requestIdleCallback shim. Falls back to
 *  `setTimeout(0)` in environments (Node / jsdom) that do not expose
 *  the browser API. Pure local timing — no I/O. */
function scheduleIdle(cb: () => void): RequestIdleCallbackHandle {
  type IdleRequest = (callback: () => void) => number;
  type IdleCancel  = (handle: number) => void;
  const g = (globalThis as unknown) as {
    requestIdleCallback?: IdleRequest;
    cancelIdleCallback?:  IdleCancel;
  };
  if (typeof g.requestIdleCallback === 'function') {
    const handle = g.requestIdleCallback(cb);
    return {
      cancel: () => {
        if (typeof g.cancelIdleCallback === 'function') {
          g.cancelIdleCallback(handle);
        }
      },
    };
  }
  const t = setTimeout(cb, 0);
  return { cancel: () => clearTimeout(t) };
}

/** The per-tool-call mutable bookkeeping the stream maintains. The
 *  immutable `DiffStreamFrame` exposed to consumers is rebuilt from
 *  this state on every change. */
interface CallState {
  toolCallId:     string;
  toolName:       typeof DIFF_STREAM_TOOL_IDS[number];
  headingPath?:   string;
  preImage:       string;
  postImage:      string;
  /** The most recently emitted frame. Always frozen. */
  frame:          DiffStreamFrame;
  /** Once true, all subsequent `tool_input_delta` events for this id
   *  are dropped (Req 3.9). */
  stable:         boolean;
  /** Once true, no further mutations are applied to this state — the
   *  frame is held at its cancellation snapshot (Req 3.10). */
  cancelled:      boolean;
  /** Outstanding deferred recompute (only set when post-image exceeds
   *  the chunked-recompute threshold). Cancelled when superseded by a
   *  newer delta or when the call transitions to stable / cancelled. */
  pendingRecompute: RequestIdleCallbackHandle | null;
  /** Subscribers registered for this `toolCallId`. */
  handlers:       Set<DiffStreamFrameHandler>;
}

function isDiffStreamToolName(
  name: string,
): name is typeof DIFF_STREAM_TOOL_IDS[number] {
  return (DIFF_STREAM_TOOL_IDS as ReadonlyArray<string>).includes(name);
}

function countChanged(lines: ReadonlyArray<DiffLine>): number {
  let n = 0;
  for (const l of lines) {
    if (l.kind === 'added' || l.kind === 'removed') n++;
  }
  return n;
}

/** Default `ToolDiffStream` implementation. Stateless apart from the
 *  per-tool-call accumulators it owns. */
export class DefaultToolDiffStream implements ToolDiffStream {
  private readonly calls = new Map<string, CallState>();
  /** Subscribers registered for tool-call IDs that have not yet seen a
   *  `tool_start`. Drained into the per-call state on `tool_start`. */
  private readonly pendingSubscribers =
    new Map<string, Set<DiffStreamFrameHandler>>();

  attach(stream: ChatMessageEventStream): void {
    stream.on('tool_start',       (e) => { this.onToolStart(e); });
    stream.on('tool_input_delta', (e) => { this.onToolInputDelta(e); });
    stream.on('tool_done',        (e) => { this.onToolDone(e); });
    stream.on('tool_cancelled',   (e) => { this.onToolCancelled(e); });
  }

  getFrame(toolCallId: string): DiffStreamFrame | undefined {
    return this.calls.get(toolCallId)?.frame;
  }

  subscribe(
    toolCallId: string,
    handler:    DiffStreamFrameHandler,
  ): () => void {
    const existing = this.calls.get(toolCallId);
    if (existing) {
      existing.handlers.add(handler);
      // Synchronous fire-on-subscribe with the current frame so callers
      // never observe a missed initial frame.
      handler(existing.frame);
      return () => existing.handlers.delete(handler);
    }
    let pending = this.pendingSubscribers.get(toolCallId);
    if (!pending) {
      pending = new Set();
      this.pendingSubscribers.set(toolCallId, pending);
    }
    pending.add(handler);
    return () => {
      const cur = this.calls.get(toolCallId);
      if (cur) {
        cur.handlers.delete(handler);
        return;
      }
      const p = this.pendingSubscribers.get(toolCallId);
      if (p) {
        p.delete(handler);
        if (p.size === 0) this.pendingSubscribers.delete(toolCallId);
      }
    };
  }

  // -----------------------------------------------------------------------
  // Event handlers
  // -----------------------------------------------------------------------

  private onToolStart(event: ToolStartEvent): void {
    if (!isDiffStreamToolName(event.toolName)) {
      return; // Req 3.1: non-diff-stream tools are ignored.
    }
    if (this.calls.has(event.toolCallId)) {
      // Re-entry on the same id is unexpected; first-write-wins.
      return;
    }

    // Pre-image source resolution (Req 3.7 — no fresh IPC):
    //   - top-level `preImage` field on the event (preferred path);
    //   - `input.preImage` fallback for callers that nest the cached
    //     pre-image inside the input payload.
    const preImage =
      event.preImage !== undefined
        ? event.preImage
        : event.input?.preImage !== undefined
        ? event.input.preImage
        : '';

    // Initial post-image accumulator. If the agent loop already
    // streamed a `content` prefix in the start event (partial: true
    // semantics, Req 3.5), seed the accumulator with it.
    const initialContent =
      typeof event.input?.content === 'string' ? event.input.content : '';

    const headingPath: string | undefined =
      event.toolName === 'editSpec' && typeof event.input?.heading === 'string'
        ? event.input.heading
        : undefined;

    const lines = diffLines(preImage, initialContent);
    const frame = freezeFrame({
      toolCallId:   event.toolCallId,
      toolName:     event.toolName,
      ...(headingPath !== undefined ? { headingPath } : {}),
      lines,
      linesChanged: countChanged(lines),
      stable:       false,
      cancelled:    false,
    });

    const state: CallState = {
      toolCallId:       event.toolCallId,
      toolName:         event.toolName,
      preImage,
      postImage:        initialContent,
      frame,
      stable:           false,
      cancelled:        false,
      pendingRecompute: null,
      handlers:         new Set(),
    };
    if (headingPath !== undefined) state.headingPath = headingPath;

    // Drain any subscribers registered before `tool_start` arrived.
    const pending = this.pendingSubscribers.get(event.toolCallId);
    if (pending) {
      for (const h of pending) state.handlers.add(h);
      this.pendingSubscribers.delete(event.toolCallId);
    }

    this.calls.set(event.toolCallId, state);
    this.emitFrame(state);
  }

  private onToolInputDelta(event: ToolInputDeltaEvent): void {
    const state = this.calls.get(event.toolCallId);
    if (!state) return;             // No matching `tool_start` — drop.
    if (state.stable) return;       // Req 3.9: post-stability, ignore.
    if (state.cancelled) return;    // Req 3.10: post-cancellation, ignore.

    state.postImage += event.delta;

    // Chunked recompute path for very large post-images: defer to
    // `requestIdleCallback`. Coalesce repeated deltas while a
    // recompute is already pending — only the latest post-image is
    // diffed once the idle callback fires.
    const lineCount = countLines(state.postImage);
    if (lineCount > LARGE_POSTIMAGE_LINE_THRESHOLD) {
      if (state.pendingRecompute === null) {
        state.pendingRecompute = scheduleIdle(() => {
          state.pendingRecompute = null;
          if (state.stable || state.cancelled) return;
          this.recomputeFrame(state);
        });
      }
      return;
    }

    this.recomputeFrame(state);
  }

  private onToolDone(event: ToolDoneEvent): void {
    const state = this.calls.get(event.toolCallId);
    if (!state) return;
    if (state.cancelled) return;    // Cancelled frames freeze (Req 3.10).
    if (state.stable) return;       // Already stable — drop (Req 3.9).

    // Cancel any deferred large-payload recompute — we are about to
    // settle the frame synchronously below.
    if (state.pendingRecompute !== null) {
      state.pendingRecompute.cancel();
      state.pendingRecompute = null;
    }

    // Stability transition (Req 3.9): only when the agent loop
    // reports the disk-bound bytes AND those bytes equal the
    // accumulated post-image. Otherwise leave the frame unstable —
    // the consumer keeps showing the latest delta-derived diff.
    if (
      typeof event.diskBoundBytes === 'string'
      && event.diskBoundBytes === state.postImage
    ) {
      state.stable = true;
      const lines = diffLines(state.preImage, state.postImage);
      this.commitFrame(state, lines, /* stable */ true, /* cancelled */ false);
    }
  }

  private onToolCancelled(event: ToolCancelledEvent): void {
    const state = this.calls.get(event.toolCallId);
    if (!state) return;
    if (state.cancelled) return;    // Already cancelled — drop.
    // Per Req 3.10, cancellation freezes the partial diff. If the
    // call already transitioned to stable, leave the stable frame
    // intact and add the cancellation marker without recomputing.
    if (state.pendingRecompute !== null) {
      state.pendingRecompute.cancel();
      state.pendingRecompute = null;
    }
    state.cancelled = true;
    // Reuse the existing `lines` from the last emitted frame so the
    // partial diff is retained byte-for-byte (Req 3.10).
    this.commitFrame(state, state.frame.lines, state.stable, true);
  }

  // -----------------------------------------------------------------------
  // Frame mutation helpers
  // -----------------------------------------------------------------------

  private recomputeFrame(state: CallState): void {
    const lines = diffLines(state.preImage, state.postImage);
    this.commitFrame(state, lines, state.stable, state.cancelled);
  }

  private commitFrame(
    state:     CallState,
    lines:     ReadonlyArray<DiffLine>,
    stable:    boolean,
    cancelled: boolean,
  ): void {
    const next: DiffStreamFrame = freezeFrame({
      toolCallId:   state.toolCallId,
      toolName:     state.toolName,
      ...(state.headingPath !== undefined
        ? { headingPath: state.headingPath }
        : {}),
      lines,
      linesChanged: countChanged(lines),
      stable,
      cancelled,
    });
    state.frame = next;
    state.stable = stable;
    state.cancelled = cancelled;
    this.emitFrame(state);
  }

  private emitFrame(state: CallState): void {
    if (state.handlers.size === 0) return;
    // Snapshot the handler set before iterating so unsubscribes from
    // within a handler do not perturb the in-flight emission.
    const snapshot = Array.from(state.handlers);
    for (const h of snapshot) {
      try {
        h(state.frame);
      } catch {
        // A misbehaving subscriber must not break others. Swallow —
        // the chat-message component owns end-user error reporting.
      }
    }
  }
}

/** Default factory — exported as a convenience for the renderer
 *  integration site (`src/renderer/index.ts`) that wires the diff
 *  stream against the existing chat-message event source. */
export function createToolDiffStream(): ToolDiffStream {
  return new DefaultToolDiffStream();
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Counts `'\n'` separators + 1 to estimate line count without the
 *  cost of allocating the full split array. Pure, local, no I/O. */
function countLines(s: string): number {
  if (s.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10 /* '\n' */) n++;
  }
  return n;
}

/** Deep-freezes a `DiffStreamFrame` so consumers cannot mutate the
 *  shared snapshot. Frozen frames are safe to retain and compare by
 *  reference across renders. */
function freezeFrame(frame: DiffStreamFrame): DiffStreamFrame {
  Object.freeze(frame.lines);
  for (const l of frame.lines) Object.freeze(l);
  return Object.freeze(frame);
}
