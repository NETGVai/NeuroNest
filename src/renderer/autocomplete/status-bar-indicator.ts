/**
 * Status bar indicator for autocomplete state.
 *
 * Shows the current autocomplete status in the application status bar:
 * - ✓ Enabled — autocomplete is active and ready
 * - ✗ Disabled — autocomplete is turned off
 * - ⟳ Loading — a completion request is in progress
 * - ⚠ Backoff — paused due to consecutive errors
 *
 * Clicking the indicator toggles autocomplete enabled/disabled.
 *
 * Requirements: 1.7
 */

import type { AutocompleteStatus } from './autocomplete-ipc-client';

// ─── Types ──────────────────────────────────────────────────────

/** Status display configuration */
interface StatusDisplay {
  icon: string;
  label: string;
  className: string;
  tooltip: string;
}

/** Callback for when the indicator is clicked */
export type StatusBarClickHandler = () => void;

// ─── Constants ──────────────────────────────────────────────────

/** Display configuration for each status */
const STATUS_DISPLAYS: Record<AutocompleteStatus, StatusDisplay> = {
  enabled: {
    icon: '✓',
    label: 'Autocomplete',
    className: 'nn-autocomplete-status--enabled',
    tooltip: 'Autocomplete: Enabled (click to disable)',
  },
  disabled: {
    icon: '✗',
    label: 'Autocomplete',
    className: 'nn-autocomplete-status--disabled',
    tooltip: 'Autocomplete: Disabled (click to enable)',
  },
  loading: {
    icon: '⟳',
    label: 'Autocomplete',
    className: 'nn-autocomplete-status--loading',
    tooltip: 'Autocomplete: Loading completion...',
  },
  backoff: {
    icon: '⚠',
    label: 'Autocomplete',
    className: 'nn-autocomplete-status--backoff',
    tooltip: 'Autocomplete: Paused (errors detected, will retry)',
  },
};

// ─── StatusBarIndicator ─────────────────────────────────────────

/**
 * StatusBarIndicator — Renders autocomplete status in the status bar.
 *
 * Creates a clickable DOM element showing the current status with an icon
 * and label. Click toggles the enabled/disabled state via the provided handler.
 */
export class StatusBarIndicator {
  private element: HTMLElement | null = null;
  private currentStatus: AutocompleteStatus = 'disabled';
  private clickHandler: StatusBarClickHandler | null = null;
  private container: HTMLElement | null = null;

  /**
   * Mount the indicator into the given container element.
   *
   * @param container - The status bar container to append the indicator to
   */
  mount(container: HTMLElement): void {
    this.container = container;
    this.element = document.createElement('button');
    this.element.className = 'nn-autocomplete-status';
    this.element.setAttribute('type', 'button');
    this.element.setAttribute('aria-label', 'Autocomplete status');
    this.element.addEventListener('click', this.handleClick);
    this.render();
    container.appendChild(this.element);
  }

  /**
   * Unmount the indicator and clean up resources.
   */
  unmount(): void {
    if (this.element) {
      this.element.removeEventListener('click', this.handleClick);
      if (this.container && this.container.contains(this.element)) {
        this.container.removeChild(this.element);
      }
      this.element = null;
    }
    this.container = null;
    this.clickHandler = null;
  }

  /**
   * Update the displayed status.
   *
   * @param status - The new autocomplete status to display
   */
  setStatus(status: AutocompleteStatus): void {
    this.currentStatus = status;
    this.render();
  }

  /**
   * Get the current displayed status.
   */
  getStatus(): AutocompleteStatus {
    return this.currentStatus;
  }

  /**
   * Register a click handler for toggling autocomplete.
   *
   * @param handler - Called when the status indicator is clicked
   */
  onClick(handler: StatusBarClickHandler): void {
    this.clickHandler = handler;
  }

  /**
   * Get the DOM element (for testing or direct manipulation).
   */
  getElement(): HTMLElement | null {
    return this.element;
  }

  // ─── Internal ─────────────────────────────────────────────────

  private render(): void {
    if (!this.element) return;

    const display = STATUS_DISPLAYS[this.currentStatus];

    // Update class
    this.element.className = `nn-autocomplete-status ${display.className}`;

    // Update content
    this.element.innerHTML = `<span class="nn-autocomplete-status__icon">${display.icon}</span><span class="nn-autocomplete-status__label">${display.label}</span>`;

    // Update tooltip
    this.element.title = display.tooltip;
    this.element.setAttribute('aria-label', display.tooltip);
  }

  private handleClick = (): void => {
    if (this.clickHandler) {
      this.clickHandler();
    }
  };
}

// ─── Styles ─────────────────────────────────────────────────────

/**
 * CSS styles for the status bar indicator.
 * Should be injected into the document or defined in a stylesheet.
 */
export const STATUS_BAR_STYLES = `
.nn-autocomplete-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--text-dim, #6b7280);
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.nn-autocomplete-status:hover {
  background-color: var(--bg-hover, rgba(255, 255, 255, 0.05));
}

.nn-autocomplete-status--enabled {
  color: var(--text-success, #10b981);
}

.nn-autocomplete-status--disabled {
  color: var(--text-dim, #6b7280);
}

.nn-autocomplete-status--loading {
  color: var(--text-info, #3b82f6);
}

.nn-autocomplete-status--loading .nn-autocomplete-status__icon {
  animation: nn-spin 1s linear infinite;
}

.nn-autocomplete-status--backoff {
  color: var(--text-warning, #f59e0b);
}

.nn-autocomplete-status__icon {
  font-size: 14px;
}

.nn-autocomplete-status__label {
  font-size: 12px;
}

@keyframes nn-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
`;
