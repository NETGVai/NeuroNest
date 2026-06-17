/**
 * Callback Engine — Lifecycle hooks for pipeline extensibility.
 *
 * Supports registering hooks at key lifecycle points in the agent pipeline:
 * before-tool-call, after-tool-call, before-llm-call, after-llm-call,
 * on-error, on-task-complete.
 *
 * Hooks execute in registration order. A throwing hook is caught and logged
 * without interrupting subsequent hooks or the pipeline itself.
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4
 */

// ─── Types ──────────────────────────────────────────────────────

/** Supported lifecycle events for hook registration. */
export type LifecycleEvent =
  | 'before-tool-call'
  | 'after-tool-call'
  | 'before-llm-call'
  | 'after-llm-call'
  | 'on-error'
  | 'on-task-complete';

/** Context passed to each hook callback when a lifecycle event fires. */
export interface HookContext {
  /** The lifecycle event that triggered this hook. */
  event: LifecycleEvent;
  /** Tool name (relevant for tool-call events). */
  toolName?: string;
  /** Input data (e.g., tool arguments or LLM messages). */
  input?: unknown;
  /** Output data (e.g., tool result or LLM response). */
  output?: unknown;
  /** Error object (relevant for on-error events). */
  error?: Error;
  /** Session identifier for the current agent session. */
  sessionId: string;
  /** Current iteration number within the agent loop. */
  iteration: number;
}

/** A hook callback function — may be sync or async. */
export type HookCallback = (context: HookContext) => void | Promise<void>;

// ─── All supported lifecycle events (for validation) ────────────

const LIFECYCLE_EVENTS: ReadonlySet<LifecycleEvent> = new Set([
  'before-tool-call',
  'after-tool-call',
  'before-llm-call',
  'after-llm-call',
  'on-error',
  'on-task-complete',
]);

// ─── CallbackEngine ─────────────────────────────────────────────

/**
 * Manages lifecycle hook registration and emission for the agent pipeline.
 *
 * Hooks are stored per event type and executed in registration order when
 * the corresponding event fires. Exceptions thrown by individual hooks are
 * caught and logged — they never interrupt other hooks or the pipeline.
 */
export class CallbackEngine {
  /** Internal registry: event → ordered list of callbacks. */
  private hooks: Map<LifecycleEvent, HookCallback[]> = new Map();

  /**
   * Register a hook callback for a specific lifecycle event.
   *
   * Hooks are invoked in the order they are registered. Registering the
   * same callback function multiple times for the same event results in
   * it being called multiple times.
   *
   * @param event - The lifecycle event to listen for.
   * @param callback - The function to invoke when the event fires.
   */
  register(event: LifecycleEvent, callback: HookCallback): void {
    if (!LIFECYCLE_EVENTS.has(event)) {
      console.warn(`[CallbackEngine] Unknown event: "${event}". Hook not registered.`);
      return;
    }

    let callbacks = this.hooks.get(event);
    if (!callbacks) {
      callbacks = [];
      this.hooks.set(event, callbacks);
    }
    callbacks.push(callback);
  }

  /**
   * Remove a previously registered hook callback for a specific event.
   *
   * Removes the first occurrence of the callback from the event's hook list.
   * If the callback is not registered for the event, this is a no-op.
   *
   * @param event - The lifecycle event to unregister from.
   * @param callback - The callback function to remove.
   */
  unregister(event: LifecycleEvent, callback: HookCallback): void {
    const callbacks = this.hooks.get(event);
    if (!callbacks) return;

    const index = callbacks.indexOf(callback);
    if (index !== -1) {
      callbacks.splice(index, 1);
    }
  }

  /**
   * Emit a lifecycle event, invoking all registered hooks in order.
   *
   * Each hook receives the provided HookContext. If a hook throws (sync
   * or async), the error is logged and execution continues with the next
   * hook. The pipeline is never interrupted by hook failures.
   *
   * @param context - The hook context containing event details.
   */
  async emit(context: HookContext): Promise<void> {
    const callbacks = this.hooks.get(context.event);
    if (!callbacks || callbacks.length === 0) return;

    for (const callback of callbacks) {
      try {
        const result = callback(context);
        // Await if the hook returns a promise
        if (result && typeof (result as Promise<void>).then === 'function') {
          await result;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[CallbackEngine] Hook for "${context.event}" threw: ${message}`,
        );
      }
    }
  }

  /**
   * Get the count of registered hooks for a specific event.
   * Useful for testing and diagnostics.
   *
   * @param event - The lifecycle event to query.
   * @returns Number of hooks registered for the event.
   */
  hookCount(event: LifecycleEvent): number {
    return this.hooks.get(event)?.length ?? 0;
  }

  /**
   * Remove all registered hooks across all events.
   * Useful for teardown in tests or session cleanup.
   */
  clear(): void {
    this.hooks.clear();
  }
}
