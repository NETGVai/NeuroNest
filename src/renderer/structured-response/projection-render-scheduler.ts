/**
 * Projection Render Scheduler — Coalesces ordinary reconciliation work
 * driven by canonical projection revisions to at most one flush per
 * `windowMs` (default 50 ms), while allowing terminal states to bypass
 * the coalescing window and flush synchronously.
 *
 * Task 11.5 (enhanced-chat-ui) — this module owns the render-frequency
 * gate at the canonical projection subscription entry point. Projection
 * deltas may arrive at token frequency; the scheduler batches ordinary
 * reconciliations to preserve prompt-bar, scroll, stop-control, and
 * card-control responsiveness (Requirement 15.6). Terminal deltas
 * (`response.completed`, `response.failed`, `response.stopped`,
 * `response.interrupted`, `turn_tail` nodes, `turn_status` blocks whose
 * state is terminal) flush immediately so the user sees final state
 * without waiting for the coalescing window.
 *
 * The scheduler is intentionally callback-shaped rather than delta-shaped:
 * callers already own the projection state; the scheduler decides *when*
 * the reconciliation callback runs, not *what* it renders. A separate
 * revision counter is passed alongside each callback so callers can
 * discard stale in-flight work when a newer revision arrives before the
 * flush fires.
 *
 * The scheduler uses `requestAnimationFrame` when available so ordinary
 * reconciliations align to display frames. When rAF is not available (or
 * an rAF callback fires sooner than `windowMs`), a monotonic-clock timeout
 * enforces the 50 ms lower bound so the scheduler never emits more than
 * one ordinary reconciliation per configured window. Terminal flushes are
 * synchronous.
 *
 * Requirements: 15.6, 15.7
 *
 * @module src/renderer/structured-response/projection-render-scheduler
 */

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Callback executed by the scheduler when it flushes coalesced work. The
 * scheduler passes the maximum revision it has seen since the previous
 * flush; consumers use this to skip stale downstream work.
 */
export type RenderWork = (revision: number) => void;

/**
 * Timer abstraction the scheduler uses for its coalescing window. The
 * default implementation is `Date.now()`+`setTimeout`; tests can supply a
 * mock clock without touching the DOM.
 */
export interface SchedulerClock {
  /** Monotonic timestamp source. */
  now(): number;
  /**
   * Schedule a callback to fire after `delayMs`. Return an opaque handle
   * that {@link SchedulerClock.clearTimer} accepts.
   */
  setTimer(cb: () => void, delayMs: number): unknown;
  /** Cancel a previously scheduled timer by handle. */
  clearTimer(handle: unknown): void;
}

/**
 * Optional `requestAnimationFrame` hook. Supplying `null` disables rAF
 * alignment; the scheduler then relies exclusively on the clock timer.
 */
export interface AnimationFrameSource {
  /** Request an animation frame; return an opaque handle. */
  request(cb: (timestamp: number) => void): unknown;
  /** Cancel a previously requested frame by handle. */
  cancel(handle: unknown): void;
}

export interface ProjectionRenderSchedulerOptions {
  /**
   * Coalescing window in milliseconds. Ordinary reconciliations fire at
   * most once per window. Terminal reconciliations bypass the window.
   * Default: 50 ms (Requirement 15.6 — "no more than one DOM
   * reconciliation per 50 ms during ordinary streaming").
   */
  readonly windowMs?: number;
  /**
   * Clock used for the coalescing budget. Defaults to `Date.now` +
   * `setTimeout`.
   */
  readonly clock?: SchedulerClock;
  /**
   * `requestAnimationFrame` hook. When present the scheduler waits for
   * the next animation frame before flushing, aligning DOM writes to the
   * display cadence. When `null` (or when rAF is unavailable in the host
   * environment) the scheduler relies solely on `clock.setTimer`.
   *
   * Defaults to the global `requestAnimationFrame` if available.
   */
  readonly animationFrame?: AnimationFrameSource | null;
}

/**
 * Public handle returned by {@link createProjectionRenderScheduler}. All
 * operations are safe to call after dispose — they no-op quietly.
 */
export interface ProjectionRenderScheduler {
  /**
   * Schedule an ordinary reconciliation for `revision`. If a schedule
   * call arrives within `windowMs` of the previous flush, the callback
   * replaces any pending work (last-write-wins) and the flush stays on
   * the same deadline. Only the latest scheduled `work` runs at flush
   * time, and it receives the maximum revision seen since the last
   * flush.
   */
  schedule(revision: number, work: RenderWork): void;

  /**
   * Flush a terminal-state reconciliation synchronously, bypassing the
   * 50 ms budget. Any pending ordinary work is discarded — the terminal
   * work supersedes it, and its revision is treated as the new "last
   * flushed" revision. Terminal callbacks always receive the max of
   * (their own revision, any pending revision they replace).
   */
  flushTerminal(revision: number, work: RenderWork): void;

  /**
   * Force any pending ordinary work to flush now. Useful for
   * teardown/deterministic-test paths. If no work is pending this is a
   * no-op.
   */
  flushNow(): void;

  /**
   * Cancel any pending ordinary work without running it. Terminal
   * flushes are synchronous so nothing terminal is ever pending.
   * Callers use this when they are about to run a synchronous
   * reconciliation (e.g. `refresh`, `scope-switch`) that supersedes any
   * coalesced work — running the pending flush would waste a
   * reconcile.
   */
  cancelPending(): void;

  /** Whether the scheduler has no pending work. */
  isSettled(): boolean;

  /** The highest revision the scheduler has ever seen (ordinary or terminal). */
  latestRevision(): number;

  /** Total ordinary flushes emitted so far. Terminal flushes are not counted. */
  ordinaryFlushCount(): number;

  /** Total terminal flushes emitted so far. */
  terminalFlushCount(): number;

  /**
   * Release timers/rAF handles. Any pending work is dropped without
   * running — callers that need the last work to fire should call
   * {@link flushNow} before disposing.
   */
  dispose(): void;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

/** Default coalescing window from Requirement 15.6. */
export const DEFAULT_RENDER_WINDOW_MS = 50;

const defaultClock: SchedulerClock = {
  now: () => Date.now(),
  setTimer: (cb, delay) => setTimeout(cb, delay),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Resolve a default `AnimationFrameSource` from the current environment.
 * Returns `null` when `requestAnimationFrame` is not available — the
 * scheduler then falls back to the clock timer alone.
 */
function resolveDefaultAnimationFrame(): AnimationFrameSource | null {
  const g = globalThis as unknown as {
    requestAnimationFrame?: (cb: (t: number) => void) => number;
    cancelAnimationFrame?: (handle: number) => void;
  };
  if (typeof g.requestAnimationFrame !== 'function') return null;
  if (typeof g.cancelAnimationFrame !== 'function') return null;
  const raf = g.requestAnimationFrame;
  const caf = g.cancelAnimationFrame;
  return {
    request: (cb) => raf(cb),
    cancel: (handle) => caf(handle as number),
  };
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Build a fresh {@link ProjectionRenderScheduler}. Each subscription
 * (structured chat shell, projection-driven controller, etc.) owns its
 * own scheduler so revisions and coalescing budgets don't cross scopes.
 */
export function createProjectionRenderScheduler(
  options: ProjectionRenderSchedulerOptions = {},
): ProjectionRenderScheduler {
  const windowMs = Math.max(0, options.windowMs ?? DEFAULT_RENDER_WINDOW_MS);
  const clock = options.clock ?? defaultClock;
  const animationFrame =
    options.animationFrame === undefined
      ? resolveDefaultAnimationFrame()
      : options.animationFrame;

  let pendingWork: RenderWork | null = null;
  let pendingRevision: number = -1;
  let latestSeenRevision: number = -1;
  // Initialize `lastFlushAt` to the current clock time so the first
  // schedule call respects the full window budget. Without this, the
  // very first flush could fire immediately (elapsed = ∞) and defeat the
  // "at most one reconciliation per 50 ms" bound during the initial
  // burst of stream deltas.
  let lastFlushAt: number = clock.now();
  let timerHandle: unknown = null;
  let rafHandle: unknown = null;
  let disposed = false;
  let ordinaryFlushes = 0;
  let terminalFlushes = 0;

  function cancelPending(): void {
    if (timerHandle !== null) {
      clock.clearTimer(timerHandle);
      timerHandle = null;
    }
    if (rafHandle !== null && animationFrame) {
      animationFrame.cancel(rafHandle);
      rafHandle = null;
    }
  }

  function scheduleFlush(): void {
    if (disposed) return;
    // Never schedule twice — the same work slot receives updates until
    // the scheduled flush fires.
    if (timerHandle !== null || rafHandle !== null) return;

    // Synchronous-flush path: when the caller opts out of both the
    // coalescing window and the animation-frame hop, we run the work
    // immediately after the current stack frame. This is the shell's
    // default mode when no `renderSchedulerOptions` is supplied — it
    // preserves the historical "delta arrives → DOM reconciles now"
    // contract that unit tests rely on. Callers that want coalescing
    // pass `windowMs > 0` (or leave rAF enabled).
    if (windowMs === 0 && animationFrame === null) {
      performFlush('ordinary');
      return;
    }

    const elapsed = clock.now() - lastFlushAt;
    const remaining = Math.max(0, windowMs - elapsed);

    if (remaining === 0 && animationFrame) {
      // Budget already satisfied — align to the next animation frame so
      // DOM writes happen at frame boundaries.
      rafHandle = animationFrame.request(() => {
        rafHandle = null;
        performFlush('ordinary');
      });
      return;
    }

    // Wait out the remaining budget with the monotonic clock. Once the
    // budget is satisfied, align to an animation frame if available.
    timerHandle = clock.setTimer(() => {
      timerHandle = null;
      if (disposed) return;
      if (animationFrame) {
        rafHandle = animationFrame.request(() => {
          rafHandle = null;
          performFlush('ordinary');
        });
      } else {
        performFlush('ordinary');
      }
    }, remaining);
  }

  function performFlush(kind: 'ordinary' | 'terminal'): void {
    if (disposed) return;
    const work = pendingWork;
    const revision = pendingRevision;
    pendingWork = null;
    pendingRevision = -1;
    lastFlushAt = clock.now();

    if (work === null) return;

    if (kind === 'ordinary') ordinaryFlushes += 1;
    else terminalFlushes += 1;

    try {
      work(revision);
    } catch (error) {
      // Never let a caller error abort the scheduler. Surface via
      // console so integration tests can spot regressions without
      // blocking subsequent flushes.
      try {
        // eslint-disable-next-line no-console
        console.error('[ProjectionRenderScheduler] flush callback threw:', error);
      } catch {
        // console may be unavailable — fall through.
      }
    }
  }

  return {
    schedule(revision: number, work: RenderWork): void {
      if (disposed) return;
      pendingWork = work;
      pendingRevision = Math.max(pendingRevision, revision);
      latestSeenRevision = Math.max(latestSeenRevision, revision);
      scheduleFlush();
    },

    flushTerminal(revision: number, work: RenderWork): void {
      if (disposed) return;
      // Terminal work supersedes any pending ordinary work.
      cancelPending();
      pendingWork = work;
      pendingRevision = Math.max(pendingRevision, revision);
      latestSeenRevision = Math.max(latestSeenRevision, revision);
      performFlush('terminal');
    },

    flushNow(): void {
      if (disposed) return;
      if (pendingWork === null) return;
      cancelPending();
      performFlush('ordinary');
    },

    cancelPending(): void {
      if (disposed) return;
      cancelPending();
      pendingWork = null;
      pendingRevision = -1;
    },

    isSettled(): boolean {
      return pendingWork === null && timerHandle === null && rafHandle === null;
    },

    latestRevision(): number {
      return latestSeenRevision;
    },

    ordinaryFlushCount(): number {
      return ordinaryFlushes;
    },

    terminalFlushCount(): number {
      return terminalFlushes;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelPending();
      pendingWork = null;
      pendingRevision = -1;
    },
  };
}

// ─── Terminal-state detection ───────────────────────────────────────────────

/**
 * Names of turn/response states that must bypass the coalescing window.
 * Kept as a plain readonly set so callers can extend it in tests without
 * having to import from `turn-status-surface`.
 */
export const TERMINAL_TURN_STATES: ReadonlySet<string> = Object.freeze(
  new Set([
    'completed',
    'failed',
    'cancelled',
    'interrupted',
    'error_recovered',
  ]),
);

/**
 * Minimal shape needed by {@link deltaHasTerminalTransition} — one
 * chat-node projection descriptor. Real deltas carry richer shapes; the
 * scheduler only reads the two fields it needs.
 */
export interface TerminalDetectionNode {
  readonly nodeKind?: string;
  readonly stableKey?: string;
}

/**
 * Minimal shape needed by {@link deltaHasTerminalTransition} — one
 * response-composition block. The scheduler looks at:
 *   - `kind === 'turn_status'` with a terminal `state`
 *   - `kind === 'error'` (unrecoverable block-scoped error)
 *   - `kind === 'response_recovery'` with a terminal `recoveryState`
 *
 * The interface is structural and intentionally loose: it works with
 * both raw response blocks (canonical projection output) and simplified
 * test doubles that only set the fields the detector cares about.
 */
export interface TerminalDetectionBlock {
  readonly kind?: string;
  readonly content?: {
    readonly state?: string;
    readonly recoveryState?: string;
    readonly terminalAt?: string;
    readonly outcome?: string;
  } | unknown;
}

/**
 * Minimal shape needed by {@link deltaHasTerminalTransition} — one
 * projection delta envelope. Only `nodesAdded`, `nodesUpdated`,
 * `compositionsAdded`, and `compositionsUpdated` are inspected; removed
 * items never mark a terminal transition (they represent tombstones).
 */
export interface TerminalDetectionDelta {
  readonly nodesAdded?: ReadonlyArray<TerminalDetectionNode>;
  readonly nodesUpdated?: ReadonlyArray<TerminalDetectionNode>;
  readonly compositionsAdded?: ReadonlyArray<{
    readonly blocks?: ReadonlyArray<TerminalDetectionBlock>;
  }>;
  readonly compositionsUpdated?: ReadonlyArray<{
    readonly blocks?: ReadonlyArray<TerminalDetectionBlock>;
  }>;
}

/**
 * Return true when the delta represents a terminal state transition
 * (response completion, response failure, stop, interruption, or a
 * `turn_tail` node). Terminal transitions bypass the 50 ms coalescing
 * budget so users see final state without waiting for the next window.
 *
 * The detector is deliberately structural — it never looks at revision
 * numbers, transport metadata, or clock time. Any composition block
 * whose type/state indicates completion counts, and any newly indexed
 * `turn_tail` node counts. Callers that already know a terminal event
 * occurred (e.g. legacy `response.error` bridge) may call
 * {@link ProjectionRenderScheduler.flushTerminal} directly.
 */
export function deltaHasTerminalTransition(
  delta: TerminalDetectionDelta,
): boolean {
  const nodesAdded = delta.nodesAdded ?? [];
  for (const node of nodesAdded) {
    if (node.nodeKind === 'turn_tail') return true;
  }
  const nodesUpdated = delta.nodesUpdated ?? [];
  for (const node of nodesUpdated) {
    if (node.nodeKind === 'turn_tail') return true;
  }

  const compositionsAdded = delta.compositionsAdded ?? [];
  for (const composition of compositionsAdded) {
    if (compositionBlocksAreTerminal(composition.blocks)) return true;
  }
  const compositionsUpdated = delta.compositionsUpdated ?? [];
  for (const composition of compositionsUpdated) {
    if (compositionBlocksAreTerminal(composition.blocks)) return true;
  }

  return false;
}

function compositionBlocksAreTerminal(
  blocks: ReadonlyArray<TerminalDetectionBlock> | undefined,
): boolean {
  if (!blocks || blocks.length === 0) return false;
  for (const block of blocks) {
    if (blockIsTerminal(block)) return true;
  }
  return false;
}

function blockIsTerminal(block: TerminalDetectionBlock): boolean {
  const kind = block.kind;
  // Content is intentionally typed as `unknown` in the loose surface so
  // that both real response blocks and test doubles fit. Narrow via
  // duck-typed reads.
  const content = block.content as
    | {
        readonly state?: unknown;
        readonly recoveryState?: unknown;
        readonly terminalAt?: unknown;
      }
    | undefined;
  if (kind === 'turn_status') {
    // Turn status is terminal when its state is one of the terminal
    // enum values OR when a terminal timestamp has been set.
    if (
      content !== undefined &&
      typeof content.state === 'string' &&
      TERMINAL_TURN_STATES.has(content.state)
    ) {
      return true;
    }
    if (
      content !== undefined &&
      typeof content.terminalAt === 'string' &&
      content.terminalAt.length > 0
    ) {
      return true;
    }
  }
  if (kind === 'error') {
    // Block-scoped errors are terminal for the affected block.
    return true;
  }
  if (kind === 'response_recovery') {
    if (
      content !== undefined &&
      typeof content.recoveryState === 'string' &&
      TERMINAL_TURN_STATES.has(content.recoveryState)
    ) {
      return true;
    }
  }
  return false;
}
