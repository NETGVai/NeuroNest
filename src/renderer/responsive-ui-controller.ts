/**
 * ResponsiveUIController — DOM integration layer for the responsive UI state machine.
 *
 * Wires the pure state machine (responsive-ui-state.ts) to the actual DOM:
 * - Manages cancel button rendering and click handling
 * - Batches progress events via requestAnimationFrame for 60fps
 * - Handles message queuing notification display
 * - Ensures chat scroll, file tree, and file open remain functional during execution
 * - Processes queued messages FIFO when agent goes idle
 *
 * Feature-gated via `production_ux_responsive_ui`
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5
 */

import type { EnhancedLoopProgress, ToolLifecycleEvent } from '../shared/production-ux-types.js';
import {
  type ResponsiveUIState,
  type ResponsiveUIEvent,
  type QueuedMessage,
  type EventBatcher,
  INITIAL_RESPONSIVE_UI_STATE,
  responsiveUIReducer,
  peekNextMessage,
  hasQueuedMessages,
  getQueuedMessageCount,
  createEventBatcher,
  shouldAutoScroll,
} from './responsive-ui-state.js';

// ─── Types ──────────────────────────────────────────────────────

interface ElectronAPI {
  send(channel: string, ...args: unknown[]): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, callback: (...args: unknown[]) => void): void;
  removeListener(channel: string, callback: (...args: unknown[]) => void): void;
}

export interface ResponsiveUIControllerOptions {
  /** Container for the cancel button */
  cancelButtonContainer: HTMLElement;
  /** Container for the message queue notification badge */
  queueNotificationContainer: HTMLElement;
  /** The scrollable chat container (for auto-scroll management) */
  chatScrollContainer: HTMLElement;
  /** Whether the feature is enabled */
  enabled?: boolean;
  /** Callback when a queued message should be sent to the agent */
  onProcessQueuedMessage?: (message: QueuedMessage) => void;
  /** Callback when cancel is triggered */
  onCancelTask?: () => void;
}

// ─── Controller ─────────────────────────────────────────────────

export class ResponsiveUIController {
  private state: ResponsiveUIState;
  private enabled: boolean;
  private options: ResponsiveUIControllerOptions;
  private cancelButtonEl: HTMLButtonElement | null = null;
  private queueBadgeEl: HTMLElement | null = null;
  private progressBatcher: EventBatcher<EnhancedLoopProgress>;
  private toolEventBatcher: EventBatcher<ToolLifecycleEvent>;
  private rafId: number | null = null;
  private ipcListeners: Array<{ channel: string; handler: (...args: unknown[]) => void }> = [];
  private destroyed = false;

  constructor(options: ResponsiveUIControllerOptions) {
    this.state = { ...INITIAL_RESPONSIVE_UI_STATE };
    this.enabled = options.enabled ?? true;
    this.options = options;
    this.progressBatcher = createEventBatcher<EnhancedLoopProgress>();
    this.toolEventBatcher = createEventBatcher<ToolLifecycleEvent>();
  }

  /**
   * Initialize the controller — render UI elements and set up IPC listeners.
   */
  init(): void {
    if (!this.enabled) return;

    this.renderCancelButton();
    this.renderQueueBadge();
    this.setupIPCListeners();
    this.startRAFLoop();
  }

  /**
   * Get the current state (for testing or external consumers).
   */
  getState(): ResponsiveUIState {
    return { ...this.state };
  }

  /**
   * Dispatch an event to the state machine and update the DOM.
   */
  dispatch(event: ResponsiveUIEvent): void {
    this.state = responsiveUIReducer(this.state, event);
    this.syncDOM();

    // When agent goes idle, process queued messages
    if (event.type === 'agent_idle' || event.type === 'cancel_acknowledged') {
      this.processMessageQueue();
    }
  }

  /**
   * Submit a message while the agent may be busy.
   * If busy, the message is queued. If idle, it's processed immediately.
   */
  submitMessage(content: string): void {
    if (!this.state.agentBusy) {
      // Process immediately — agent is idle
      const message: QueuedMessage = {
        id: generateId(),
        content,
        timestamp: Date.now(),
      };
      this.options.onProcessQueuedMessage?.(message);
      return;
    }

    // Queue the message
    const message: QueuedMessage = {
      id: generateId(),
      content,
      timestamp: Date.now(),
    };
    this.dispatch({ type: 'message_submitted', message });
  }

  /**
   * Handle an incoming progress event — batched via RAF.
   */
  handleProgressEvent(progress: EnhancedLoopProgress): void {
    this.progressBatcher.push(progress);
    this.dispatch({ type: 'events_batched', count: 1 });
  }

  /**
   * Handle an incoming tool lifecycle event — batched via RAF.
   */
  handleToolEvent(toolEvent: ToolLifecycleEvent): void {
    this.toolEventBatcher.push(toolEvent);
    this.dispatch({ type: 'events_batched', count: 1 });
  }

  /**
   * Clean up all DOM elements, listeners, and RAF loop.
   */
  destroy(): void {
    this.destroyed = true;

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    this.cleanupIPCListeners();

    if (this.cancelButtonEl) {
      this.cancelButtonEl.remove();
      this.cancelButtonEl = null;
    }

    if (this.queueBadgeEl) {
      this.queueBadgeEl.remove();
      this.queueBadgeEl = null;
    }

    this.progressBatcher.clear();
    this.toolEventBatcher.clear();
  }

  // ─── Private: DOM Rendering ───────────────────────────────────

  private renderCancelButton(): void {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'responsive-ui-cancel-btn';
    btn.setAttribute('aria-label', 'Cancel current task');
    btn.style.cssText = [
      'display:none',
      'align-items:center',
      'gap:4px',
      'padding:6px 12px',
      'border-radius:6px',
      'border:1px solid var(--red,#ef4444)',
      'background:var(--red,#ef4444)15',
      'color:var(--red,#ef4444)',
      'font-size:12px',
      'font-weight:600',
      'cursor:pointer',
      'transition:opacity 0.15s',
    ].join(';');
    btn.innerHTML = '<span>⏹</span><span>Cancel</span>';

    btn.addEventListener('click', () => this.handleCancel());
    this.options.cancelButtonContainer.appendChild(btn);
    this.cancelButtonEl = btn;
  }

  private renderQueueBadge(): void {
    const badge = document.createElement('div');
    badge.className = 'responsive-ui-queue-badge';
    badge.setAttribute('aria-live', 'polite');
    badge.style.cssText = [
      'display:none',
      'align-items:center',
      'gap:4px',
      'padding:4px 8px',
      'border-radius:4px',
      'background:var(--accent,#3b82f6)15',
      'color:var(--accent,#3b82f6)',
      'font-size:11px',
      'font-weight:500',
    ].join(';');
    this.options.queueNotificationContainer.appendChild(badge);
    this.queueBadgeEl = badge;
  }

  private syncDOM(): void {
    // Cancel button visibility
    if (this.cancelButtonEl) {
      const shouldShow = this.state.cancelButtonVisible && !this.state.cancelRequested;
      this.cancelButtonEl.style.display = shouldShow ? 'flex' : 'none';
    }

    // Queue badge visibility and count
    if (this.queueBadgeEl) {
      const count = getQueuedMessageCount(this.state);
      if (count > 0) {
        this.queueBadgeEl.style.display = 'flex';
        this.queueBadgeEl.textContent = `${count} message${count > 1 ? 's' : ''} queued`;
      } else {
        this.queueBadgeEl.style.display = 'none';
      }
    }
  }

  // ─── Private: RAF Loop for Event Batching ─────────────────────

  private startRAFLoop(): void {
    const tick = (): void => {
      if (this.destroyed) return;

      // Flush batched progress events
      const progressEvents = this.progressBatcher.flush();
      const toolEvents = this.toolEventBatcher.flush();
      const totalFlushed = progressEvents.length + toolEvents.length;

      if (totalFlushed > 0) {
        this.dispatch({ type: 'events_flushed', count: totalFlushed });
      }

      // Apply the last progress event for status update (skip intermediate ones)
      if (progressEvents.length > 0) {
        const latest = progressEvents[progressEvents.length - 1];
        this.dispatch({ type: 'progress_update', payload: latest });
      }

      // Handle auto-scroll for chat area
      this.handleAutoScroll();

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  private handleAutoScroll(): void {
    const container = this.options.chatScrollContainer;
    if (!container) return;

    if (shouldAutoScroll(container.scrollTop, container.scrollHeight, container.clientHeight)) {
      container.scrollTop = container.scrollHeight;
    }
  }

  // ─── Private: Message Queue Processing ────────────────────────

  private processMessageQueue(): void {
    if (!hasQueuedMessages(this.state)) return;

    // Process messages FIFO until queue is empty
    while (hasQueuedMessages(this.state)) {
      const msg = peekNextMessage(this.state);
      if (!msg) break;

      this.dispatch({ type: 'message_dequeued' });
      this.options.onProcessQueuedMessage?.(msg);
    }
  }

  // ─── Private: Cancel Handling ─────────────────────────────────

  private handleCancel(): void {
    this.dispatch({ type: 'cancel_requested' });

    // Send cancel to main process via IPC
    try {
      getElectronAPI().send('agent:cancel-task');
    } catch {
      // IPC may not be available in tests
    }

    this.options.onCancelTask?.();
  }

  // ─── Private: IPC Integration ─────────────────────────────────

  private setupIPCListeners(): void {
    try {
      const api = getElectronAPI();

      const progressHandler = (...args: unknown[]): void => {
        const payload = args[0] as EnhancedLoopProgress;
        if (payload) this.handleProgressEvent(payload);
      };

      const toolEventHandler = (...args: unknown[]): void => {
        const payload = args[0] as ToolLifecycleEvent;
        if (payload) this.handleToolEvent(payload);
      };

      const taskCompleteHandler = (): void => {
        this.dispatch({ type: 'agent_idle' });
      };

      api.on('agent:progress', progressHandler);
      api.on('agent:tool-event', toolEventHandler);
      api.on('agent:task-complete', taskCompleteHandler);

      this.ipcListeners.push(
        { channel: 'agent:progress', handler: progressHandler },
        { channel: 'agent:tool-event', handler: toolEventHandler },
        { channel: 'agent:task-complete', handler: taskCompleteHandler },
      );
    } catch {
      // IPC not available (testing environment)
    }
  }

  private cleanupIPCListeners(): void {
    try {
      const api = getElectronAPI();
      for (const { channel, handler } of this.ipcListeners) {
        api.removeListener(channel, handler);
      }
    } catch {
      // Ignore cleanup errors
    }
    this.ipcListeners = [];
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function getElectronAPI(): ElectronAPI {
  return (window as any).electronAPI;
}

let idCounter = 0;
function generateId(): string {
  return `msg_${Date.now()}_${++idCounter}`;
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Create and initialize a ResponsiveUIController.
 * Feature-gated via `production_ux_responsive_ui`.
 */
export function createResponsiveUIController(
  options: ResponsiveUIControllerOptions,
): ResponsiveUIController {
  const controller = new ResponsiveUIController(options);
  controller.init();
  return controller;
}
