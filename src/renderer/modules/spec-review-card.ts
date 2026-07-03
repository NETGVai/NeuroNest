/**
 * SpecReviewCard — Renderer UI component for reviewing a synthesized spec.
 *
 * After spec synthesis (interview completed or skipped), this card presents
 * the user with a summary of the synthesized spec and action buttons.
 *
 * Displays:
 *   - Title
 *   - Overview summary (truncated to 200 chars)
 *   - File count
 *   - Suggested execution mode
 *   - Cost estimate
 *
 * Action buttons:
 *   - "Start build": validates spec completeness, sends `spec:action { specId, action: 'build' }`
 *   - "Edit spec": sends `spec:action { specId, action: 'edit' }`
 *   - "Cancel": sends `spec:action { specId, action: 'cancel' }`
 *
 * 30-minute stale timeout:
 *   - Marks the spec as stale and notifies user
 *   - Does NOT auto-execute or auto-cancel
 *
 * Receives spec data via `spec:review` IPC channel (Main → Renderer).
 * Sends actions via `spec:action` IPC channel (Renderer → Main).
 *
 * Gated behind `spec_review_card` feature flag.
 *
 * Requirements: 10.2, 10.3, 10.4, 10.5, 10.7
 */

import type { SynthesizedSpec } from '../../pipeline/spec-interview-engine.js';
import { validateSynthesizedSpec } from '../../pipeline/spec-synthesizer.js';
import { showToast } from '../components/toast.js';
import { createButton, setButtonDisabled } from '../components/button.js';

// ─── Types ──────────────────────────────────────────────────────

export interface SpecReviewCardOptions {
  /** Whether the card is enabled (feature-gated via spec_review_card) */
  enabled: boolean;
  /** Callback fired after "Start build" action succeeds */
  onBuild?: (specId: string) => void;
  /** Callback fired after "Edit spec" action */
  onEdit?: (specId: string) => void;
  /** Callback fired after "Cancel" action */
  onCancel?: (specId: string) => void;
  /** Callback fired when spec goes stale (30-min timeout) */
  onStale?: (specId: string) => void;
}

interface ElectronAPI {
  send(channel: string, ...args: unknown[]): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, callback: (...args: unknown[]) => void): void;
  removeListener(channel: string, callback: (...args: unknown[]) => void): void;
}

// ─── Constants ──────────────────────────────────────────────────

/** IPC channel for receiving a synthesized spec from main process. */
export const SPEC_REVIEW_CHANNEL = 'spec:review' as const;

/** IPC channel for sending spec actions to main process. */
export const SPEC_ACTION_CHANNEL = 'spec:action' as const;

/** Maximum characters to display from the overview before truncating. */
export const OVERVIEW_MAX_LENGTH = 200;

/** Stale timeout in milliseconds (30 minutes). */
export const STALE_TIMEOUT_MS = 30 * 60 * 1000;

// ─── Helpers ────────────────────────────────────────────────────

function getElectronAPI(): ElectronAPI | null {
  return (window as any).electronAPI ?? null;
}

/**
 * Truncates text to maxLength, appending "…" if truncated.
 */
export function truncateOverview(text: string, maxLength: number = OVERVIEW_MAX_LENGTH): string {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '…';
}

/**
 * Formats a cost estimate for display.
 */
export function formatCostEstimate(cost: { tokens: number; estimatedCostUsd: number; tier: string }): string {
  return `~${cost.tokens.toLocaleString()} tokens · $${cost.estimatedCostUsd.toFixed(2)} · ${cost.tier}`;
}

/**
 * Formats the suggested execution mode for display.
 */
export function formatExecutionMode(mode: string): string {
  const modeLabels: Record<string, string> = {
    flash: '⚡ Flash',
    standard: '🔧 Standard',
    pro: '🚀 Pro',
    ultra: '💎 Ultra',
  };
  return modeLabels[mode] ?? mode;
}

// ─── SpecReviewCard Component ───────────────────────────────────

/**
 * SpecReviewCard renders a review/confirmation interface for a synthesized spec.
 *
 * Lifecycle:
 *   1. Listens on `spec:review` IPC channel for incoming SynthesizedSpec
 *   2. Renders card with title, overview, file count, mode, cost
 *   3. "Start build": validates → sends `spec:action { specId, action: 'build' }`
 *   4. "Edit spec": sends `spec:action { specId, action: 'edit' }`
 *   5. "Cancel": sends `spec:action { specId, action: 'cancel' }`
 *   6. 30-min stale timer: marks spec stale, notifies user
 *
 * Requirements: 10.2, 10.3, 10.4, 10.5, 10.7
 */
export class SpecReviewCard {
  private container: HTMLElement;
  private options: SpecReviewCardOptions;
  private currentSpec: SynthesizedSpec | null = null;
  private cardEl: HTMLElement | null = null;
  private staleTimerId: ReturnType<typeof setTimeout> | null = null;
  private isStale = false;
  private isActionTaken = false;
  private ipcListener: ((spec: SynthesizedSpec) => void) | null = null;

  constructor(container: HTMLElement, options: SpecReviewCardOptions) {
    this.container = container;
    this.options = options;

    if (options.enabled) {
      this.setupIpcListener();
    }
  }

  /**
   * Render the review card for a given SynthesizedSpec.
   *
   * Requirement 10.2: Display title, overview summary, file count,
   * suggested execution mode, and cost estimate.
   */
  render(spec: SynthesizedSpec): void {
    if (!this.options.enabled) {
      this.container.innerHTML = '';
      return;
    }

    this.currentSpec = spec;
    this.isStale = false;
    this.isActionTaken = false;
    this.clearStaleTimer();
    this.container.innerHTML = '';

    // ── Card wrapper ──────────────────────────────────────────
    this.cardEl = document.createElement('div');
    this.cardEl.className = 'spec-review-card';
    this.cardEl.setAttribute('role', 'region');
    this.cardEl.setAttribute('aria-label', 'Spec review');
    this.cardEl.style.cssText = [
      'display:flex',
      'flex-direction:column',
      'gap:12px',
      'padding:16px',
      'border-radius:8px',
      'border:1px solid var(--border-color, #333)',
      'background:var(--bg-elevated, #1e1e1e)',
      'max-width:540px',
      'animation:fadeIn 0.15s ease',
    ].join(';');

    // ── Header ────────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'spec-review-card-header';
    header.style.cssText = 'display:flex;align-items:center;gap:8px';

    const icon = document.createElement('span');
    icon.textContent = '📋';
    icon.style.fontSize = '16px';
    icon.setAttribute('aria-hidden', 'true');
    header.appendChild(icon);

    const title = document.createElement('span');
    title.className = 'spec-review-card-title';
    title.textContent = spec.title;
    title.style.cssText = 'font-size:14px;font-weight:600;color:var(--text-primary, #e0e0e0)';
    header.appendChild(title);

    this.cardEl.appendChild(header);

    // ── Overview ──────────────────────────────────────────────
    const overview = document.createElement('p');
    overview.className = 'spec-review-card-overview';
    overview.textContent = truncateOverview(spec.overview);
    overview.style.cssText = [
      'margin:0',
      'font-size:12px',
      'line-height:1.5',
      'color:var(--text-secondary, #aaa)',
      'word-break:break-word',
    ].join(';');
    this.cardEl.appendChild(overview);

    // ── Metadata row ──────────────────────────────────────────
    const meta = document.createElement('div');
    meta.className = 'spec-review-card-meta';
    meta.style.cssText = [
      'display:flex',
      'flex-wrap:wrap',
      'gap:12px',
      'font-size:11px',
      'color:var(--text-secondary, #aaa)',
    ].join(';');

    const fileCount = document.createElement('span');
    fileCount.className = 'spec-review-card-file-count';
    fileCount.textContent = `📁 ${spec.filesToChange.length} file${spec.filesToChange.length !== 1 ? 's' : ''}`;
    meta.appendChild(fileCount);

    const mode = document.createElement('span');
    mode.className = 'spec-review-card-mode';
    mode.textContent = formatExecutionMode(spec.suggestedMode);
    meta.appendChild(mode);

    const cost = document.createElement('span');
    cost.className = 'spec-review-card-cost';
    cost.textContent = formatCostEstimate(spec.costEstimate);
    meta.appendChild(cost);

    this.cardEl.appendChild(meta);

    // ── Action buttons ────────────────────────────────────────
    const actions = document.createElement('div');
    actions.className = 'spec-review-card-actions';
    actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:4px';

    // "Start build" button (primary)
    const buildBtn = createButton({
      label: 'Start build',
      icon: '▶',
      variant: 'primary',
      size: 'medium',
      ariaLabel: 'Start build — validate and begin execution',
      className: 'spec-review-card-build-btn',
      onClick: () => this.handleStartBuild(),
    });
    actions.appendChild(buildBtn);

    // "Edit spec" button (secondary)
    const editBtn = createButton({
      label: 'Edit spec',
      icon: '✏️',
      variant: 'secondary',
      size: 'medium',
      ariaLabel: 'Edit spec — open in editable view',
      className: 'spec-review-card-edit-btn',
      onClick: () => this.handleEditSpec(),
    });
    actions.appendChild(editBtn);

    // "Cancel" button (ghost)
    const cancelBtn = createButton({
      label: 'Cancel',
      variant: 'ghost',
      size: 'medium',
      ariaLabel: 'Cancel — discard this spec',
      className: 'spec-review-card-cancel-btn',
      onClick: () => this.handleCancel(),
    });
    actions.appendChild(cancelBtn);

    this.cardEl.appendChild(actions);
    this.container.appendChild(this.cardEl);

    // ── Start stale timer (Requirement 10.7) ──────────────────
    this.startStaleTimer();
  }

  /**
   * Get the current SynthesizedSpec being displayed.
   */
  getSpec(): SynthesizedSpec | null {
    return this.currentSpec;
  }

  /**
   * Check if the spec has been marked as stale.
   */
  getIsStale(): boolean {
    return this.isStale;
  }

  /**
   * Check if any action has been taken on the card.
   */
  getIsActionTaken(): boolean {
    return this.isActionTaken;
  }

  /**
   * Dispose of the component, clean up DOM and timers.
   */
  dispose(): void {
    this.clearStaleTimer();
    this.removeIpcListener();
    this.container.innerHTML = '';
    this.cardEl = null;
    this.currentSpec = null;
    this.isStale = false;
    this.isActionTaken = false;
  }

  // ─── Private: IPC ─────────────────────────────────────────────

  /**
   * Set up IPC listener for `spec:review` channel (Main → Renderer).
   */
  private setupIpcListener(): void {
    const api = getElectronAPI();
    if (!api) return;

    this.ipcListener = (spec: SynthesizedSpec) => {
      this.render(spec);
    };

    api.on(SPEC_REVIEW_CHANNEL, this.ipcListener as (...args: unknown[]) => void);
  }

  /**
   * Remove IPC listener.
   */
  private removeIpcListener(): void {
    if (!this.ipcListener) return;

    const api = getElectronAPI();
    if (api) {
      api.removeListener(SPEC_REVIEW_CHANNEL, this.ipcListener as (...args: unknown[]) => void);
    }
    this.ipcListener = null;
  }

  // ─── Private: Actions ─────────────────────────────────────────

  /**
   * Handle "Start build" button click.
   *
   * Requirement 10.4: Validate spec completeness before transition.
   * If invalid, show error toast and prevent transition.
   * If valid, send `spec:action { specId, action: 'build' }`.
   */
  private handleStartBuild(): void {
    if (!this.currentSpec || this.isActionTaken) return;

    // Validate spec completeness
    const errors = validateSynthesizedSpec(this.currentSpec);
    if (errors.length > 0) {
      const errorMessages = errors.map(e => `${e.field}: ${e.message}`).join('; ');
      showToast({
        message: `Spec validation failed: ${errorMessages}`,
        level: 'error',
        duration: 6000,
      });
      return;
    }

    this.isActionTaken = true;
    this.clearStaleTimer();
    this.disableAllButtons();

    const api = getElectronAPI();
    if (api) {
      api.send(SPEC_ACTION_CHANNEL, {
        specId: this.currentSpec.id,
        action: 'build',
      });
    }

    this.options.onBuild?.(this.currentSpec.id);
  }

  /**
   * Handle "Edit spec" button click.
   *
   * Requirement 10.5: Open the synthesized spec in an editable view.
   * Sends `spec:action { specId, action: 'edit' }`.
   */
  private handleEditSpec(): void {
    if (!this.currentSpec || this.isActionTaken) return;

    this.isActionTaken = true;
    this.clearStaleTimer();
    this.disableAllButtons();

    const api = getElectronAPI();
    if (api) {
      api.send(SPEC_ACTION_CHANNEL, {
        specId: this.currentSpec.id,
        action: 'edit',
      });
    }

    this.options.onEdit?.(this.currentSpec.id);
  }

  /**
   * Handle "Cancel" button click.
   *
   * Sends `spec:action { specId, action: 'cancel' }`.
   */
  private handleCancel(): void {
    if (!this.currentSpec || this.isActionTaken) return;

    this.isActionTaken = true;
    this.clearStaleTimer();
    this.disableAllButtons();

    const api = getElectronAPI();
    if (api) {
      api.send(SPEC_ACTION_CHANNEL, {
        specId: this.currentSpec.id,
        action: 'cancel',
      });
    }

    this.options.onCancel?.(this.currentSpec.id);
  }

  // ─── Private: Stale Timeout ───────────────────────────────────

  /**
   * Start the 30-minute stale timer.
   *
   * Requirement 10.7: If no action taken for 30 minutes, mark spec
   * as stale and notify user (no auto-execute or auto-cancel).
   */
  private startStaleTimer(): void {
    this.clearStaleTimer();
    this.staleTimerId = setTimeout(() => this.markStale(), STALE_TIMEOUT_MS);
  }

  /**
   * Clear the stale timer.
   */
  private clearStaleTimer(): void {
    if (this.staleTimerId !== null) {
      clearTimeout(this.staleTimerId);
      this.staleTimerId = null;
    }
  }

  /**
   * Mark the spec as stale and notify the user.
   *
   * Requirement 10.7: Mark spec stale, notify user, but do NOT
   * auto-execute or auto-cancel.
   */
  private markStale(): void {
    if (!this.currentSpec || this.isActionTaken) return;

    this.isStale = true;

    // Update spec status locally
    this.currentSpec.status = 'stale';

    // Show stale indicator on card
    if (this.cardEl) {
      const staleIndicator = document.createElement('div');
      staleIndicator.className = 'spec-review-card-stale';
      staleIndicator.textContent = '⏰ This spec has been idle for 30 minutes and is now stale.';
      staleIndicator.style.cssText = [
        'font-size:11px',
        'color:var(--text-warning, #ff9800)',
        'padding:8px',
        'border-radius:4px',
        'background:var(--bg-warning, rgba(255,152,0,0.1))',
      ].join(';');
      this.cardEl.appendChild(staleIndicator);
    }

    // Notify user via toast
    showToast({
      message: 'Your spec review has been idle for 30 minutes and is now stale.',
      level: 'warning',
      duration: 0, // persistent until dismissed
    });

    this.options.onStale?.(this.currentSpec.id);
  }

  // ─── Private: UI Helpers ──────────────────────────────────────

  /**
   * Disable all action buttons after an action is taken.
   */
  private disableAllButtons(): void {
    if (!this.cardEl) return;
    const buttons = this.cardEl.querySelectorAll('button');
    buttons.forEach(btn => setButtonDisabled(btn as HTMLButtonElement, true));
  }
}

// ─── Factory Function ───────────────────────────────────────────

/**
 * Create a SpecReviewCard component and mount it.
 *
 * @param container - The DOM element to mount the card into
 * @param options - Configuration including feature gate and callbacks
 */
export function createSpecReviewCard(
  container: HTMLElement,
  options: SpecReviewCardOptions,
): SpecReviewCard {
  return new SpecReviewCard(container, options);
}
