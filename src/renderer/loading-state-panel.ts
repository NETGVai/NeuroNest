/**
 * LoadingStatePanel — Renderer component for displaying loading indicators
 * during long-running operations.
 *
 * Uses the pure state machine from `loading-state.ts` and renders DOM elements
 * to show loading spinners, elapsed times, and timeout warnings.
 *
 * Key behaviors:
 * - Shows loading indicator when operation exceeds 2 seconds
 * - Shows elapsed time when operation exceeds 5 seconds
 * - Shows timeout warning with cancel option at 30 seconds
 * - Does NOT block unrelated UI elements (non-modal, positioned inline)
 * - Feature-gated via `production_ux_loading_states`
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5
 */

import {
  INITIAL_LOADING_STATE,
  loadingStateReducer,
  getVisibleOperations,
  computeDisplayProps,
  type LoadingStateModel,
  type LoadingEvent,
  type OperationType,
  type LoadingOperation,
} from './loading-state.js';

// ─── Types ──────────────────────────────────────────────────────

interface LoadingStatePanelOptions {
  /** Whether the feature gate is enabled */
  enabled: boolean;
  /** Callback invoked when user clicks cancel on a timed-out operation */
  onCancel?: (operationId: string) => void;
}

// ─── LoadingStatePanel ──────────────────────────────────────────

export class LoadingStatePanel {
  private container: HTMLElement;
  private state: LoadingStateModel = INITIAL_LOADING_STATE;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private enabled: boolean;
  private onCancel: ((operationId: string) => void) | null;
  private operationElements: Map<string, HTMLElement> = new Map();

  constructor(container: HTMLElement, options: LoadingStatePanelOptions) {
    this.container = container;
    this.enabled = options.enabled;
    this.onCancel = options.onCancel ?? null;
  }

  /**
   * Start tracking a new loading operation.
   */
  startOperation(id: string, type: OperationType, label?: string): void {
    if (!this.enabled) return;

    this.dispatch({
      type: 'start',
      id,
      operationType: type,
      label: label ?? '',
      timestamp: Date.now(),
    });

    // Start tick timer if not already running
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => this.tick(), 500);
    }
  }

  /**
   * Mark an operation as complete and remove its loading indicator.
   */
  completeOperation(id: string): void {
    if (!this.enabled) return;
    this.dispatch({ type: 'complete', id });
  }

  /**
   * Cancel a loading operation (user-initiated).
   */
  cancelOperation(id: string): void {
    if (!this.enabled) return;
    this.dispatch({ type: 'cancel', id });
    this.onCancel?.(id);
  }

  /**
   * Reset all loading state.
   */
  reset(): void {
    this.dispatch({ type: 'reset' });
  }

  /**
   * Clean up timers and DOM when panel is destroyed.
   */
  destroy(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.container.innerHTML = '';
    this.operationElements.clear();
  }

  // ─── Internal ─────────────────────────────────────────────

  private dispatch(event: LoadingEvent): void {
    this.state = loadingStateReducer(this.state, event);
    this.render();
    this.maybeStopTimer();
  }

  private tick(): void {
    this.dispatch({ type: 'tick', timestamp: Date.now() });
  }

  private maybeStopTimer(): void {
    if (this.state.operations.size === 0 && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private render(): void {
    const visible = getVisibleOperations(this.state);

    // Remove elements for operations that are no longer visible
    for (const [id, el] of this.operationElements) {
      if (!visible.find((op) => op.id === id)) {
        el.remove();
        this.operationElements.delete(id);
      }
    }

    // Update or create elements for visible operations
    for (const op of visible) {
      let el = this.operationElements.get(op.id);
      if (!el) {
        el = this.createOperationElement(op);
        this.container.appendChild(el);
        this.operationElements.set(op.id, el);
      }
      this.updateOperationElement(el, op);
    }
  }

  private createOperationElement(op: LoadingOperation): HTMLElement {
    const el = document.createElement('div');
    el.className = 'loading-state-item';
    el.dataset.operationId = op.id;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:8px',
      'padding:8px 12px',
      'border-radius:6px',
      'background:var(--bg-input, #1e1e2e)',
      'border:1px solid var(--border-color, #333)',
      'margin-bottom:6px',
      'font-size:12px',
      'color:var(--text-secondary, #aaa)',
      'animation:fadeIn 0.2s ease-in',
    ].join(';');

    return el;
  }

  private updateOperationElement(el: HTMLElement, op: LoadingOperation): void {
    const props = computeDisplayProps(op);

    const parts: string[] = [];

    // Spinner
    if (props.showSpinner) {
      parts.push('<span class="loading-spinner" style="width:14px;height:14px;border:2px solid var(--text-dim,#666);border-top-color:var(--accent,#3b82f6);border-radius:50%;animation:spin 0.8s linear infinite;flex-shrink:0;"></span>');
    }

    // Label
    parts.push(`<span class="loading-label" style="flex:1;">${this.escHtml(props.label)}</span>`);

    // Elapsed time
    if (props.showElapsedTime) {
      parts.push(`<span class="loading-elapsed" style="color:var(--text-dim,#888);font-size:11px;">${props.elapsedText}</span>`);
    }

    // Timeout warning
    if (props.showTimeoutWarning) {
      parts.push('<span class="loading-timeout-warning" style="color:var(--yellow,#f59e0b);font-size:11px;margin-left:4px;">⚠ Timeout</span>');
    }

    // Cancel button (shown at timeout)
    if (props.showCancelButton) {
      parts.push(`<button class="loading-cancel-btn" data-cancel-id="${op.id}" style="padding:2px 8px;border:1px solid var(--border-color,#555);border-radius:4px;background:var(--bg-input,#2a2a3e);color:var(--text-primary,#eee);font-size:11px;cursor:pointer;" aria-label="Cancel operation">Cancel</button>`);
    }

    el.innerHTML = parts.join('');

    // Attach cancel handler
    if (props.showCancelButton) {
      const cancelBtn = el.querySelector('.loading-cancel-btn') as HTMLButtonElement | null;
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
          this.cancelOperation(op.id);
        });
      }
    }

    // Update aria attributes for accessibility
    el.setAttribute('aria-label',
      props.showTimeoutWarning
        ? `${props.label} — timeout warning after ${props.elapsedText}`
        : props.showElapsedTime
          ? `${props.label} — elapsed ${props.elapsedText}`
          : props.label
    );
  }

  private escHtml(s: string): string {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
}

// ─── CSS Keyframes injection ────────────────────────────────────

/**
 * Injects the required CSS keyframes for the loading spinner animation.
 * Call once during application initialization.
 */
export function injectLoadingStateStyles(): void {
  if (document.getElementById('loading-state-styles')) return;

  const style = document.createElement('style');
  style.id = 'loading-state-styles';
  style.textContent = `
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .loading-state-item {
      pointer-events: auto;
    }
    .loading-cancel-btn:hover {
      background: var(--bg-hover, #333) !important;
    }
  `;
  document.head.appendChild(style);
}

// ─── Convenience export ─────────────────────────────────────────

export function createLoadingStatePanel(
  container: HTMLElement,
  options: LoadingStatePanelOptions,
): LoadingStatePanel {
  injectLoadingStateStyles();
  return new LoadingStatePanel(container, options);
}
