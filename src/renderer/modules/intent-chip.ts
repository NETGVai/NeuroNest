/**
 * IntentChip — Renderer UI component showing classified intent on each user message.
 *
 * Displays the current intent classification with an override popover
 * allowing the user to select a different intent. On override, sends
 * `intent:override-request` IPC and receives the updated `intent:decision`.
 *
 * Gated behind the `intent_chip_ux` feature flag.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import type { IntentDecision, IntentLabel } from '../../pipeline/intent-gate.js';

// ─── Types ──────────────────────────────────────────────────────

export interface IntentChipOptions {
  /** Whether the chip is enabled (feature-gated via intent_chip_ux) */
  enabled: boolean;
  /** Callback fired when an override decision is received */
  onOverrideDecision?: (decision: IntentDecision) => void;
}

export interface OverrideOption {
  intent: IntentLabel;
  label: string;
  emoji: string;
}

interface ElectronAPI {
  send(channel: string, ...args: unknown[]): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, callback: (...args: unknown[]) => void): void;
  removeListener(channel: string, callback: (...args: unknown[]) => void): void;
}

// ─── Constants ──────────────────────────────────────────────────

/**
 * Override options displayed when the user taps the IntentChip.
 * Requirement 4.3: display override options allowing user to select a different intent.
 */
export const OVERRIDE_OPTIONS: readonly OverrideOption[] = Object.freeze([
  { intent: 'conversation', label: 'Conversation', emoji: '💬' },
  { intent: 'quick_action', label: 'Quick Action', emoji: '⚡' },
  { intent: 'build', label: 'Build', emoji: '🔨' },
]);

/**
 * IPC channel names for the intent override flow.
 */
export const INTENT_IPC_CHANNELS = {
  /** Renderer → Main: user requests an intent override */
  OVERRIDE_REQUEST: 'intent:override-request',
  /** Main → Renderer: updated IntentDecision after classification/override */
  DECISION: 'intent:decision',
} as const;

// ─── Helpers ────────────────────────────────────────────────────

function getElectronAPI(): ElectronAPI | null {
  return (window as any).electronAPI ?? null;
}

function getIntentDisplayInfo(intent: IntentLabel): { emoji: string; label: string; color: string } {
  switch (intent) {
    case 'conversation':
      return { emoji: '💬', label: 'Conversation', color: 'var(--blue, #3b82f6)' };
    case 'quick_action':
      return { emoji: '⚡', label: 'Quick Action', color: 'var(--yellow, #f59e0b)' };
    case 'build':
      return { emoji: '🔨', label: 'Build', color: 'var(--green, #22c55e)' };
    case 'ambiguous':
      return { emoji: '❓', label: 'Ambiguous', color: 'var(--text-secondary, #888)' };
    default:
      return { emoji: '❓', label: 'Unknown', color: 'var(--text-secondary, #888)' };
  }
}

// ─── IntentChip Component ───────────────────────────────────────

/**
 * IntentChip renders the current classification and allows override via popover.
 *
 * Lifecycle:
 *   1. `render(decision)` → draws the chip showing the classified intent
 *   2. On tap → `showOverridePopover()` with the three override options
 *   3. On selection → sends `intent:override-request` IPC with { messageHash, newIntent }
 *   4. Listens for `intent:decision` IPC → updates chip and fires callback
 *
 * Requirements: 4.3, 4.5
 */
export class IntentChip {
  private container: HTMLElement;
  private options: IntentChipOptions;
  private currentDecision: IntentDecision | null = null;
  private chipEl: HTMLButtonElement | null = null;
  private popoverEl: HTMLElement | null = null;
  private isPopoverOpen = false;
  private decisionListener: ((...args: unknown[]) => void) | null = null;
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null;

  constructor(container: HTMLElement, options: IntentChipOptions) {
    this.container = container;
    this.options = options;

    if (this.options.enabled) {
      this.registerIPCListeners();
    }
  }

  /**
   * Render the chip for a given IntentDecision.
   * Called when the initial decision arrives (Stage A optimistic) and
   * again when Stage B revises it.
   *
   * Requirement 4.1, 4.2: appear on message, update on revision.
   */
  render(decision: IntentDecision): void {
    if (!this.options.enabled) {
      this.container.innerHTML = '';
      return;
    }

    this.currentDecision = decision;
    this.container.innerHTML = '';
    this.closePopover();

    const { emoji, label, color } = getIntentDisplayInfo(decision.intent);

    this.chipEl = document.createElement('button');
    this.chipEl.className = 'intent-chip';
    this.chipEl.type = 'button';
    this.chipEl.setAttribute('role', 'button');
    this.chipEl.setAttribute('aria-label', `Intent: ${label}. Tap to override.`);
    this.chipEl.setAttribute('aria-haspopup', 'true');
    this.chipEl.setAttribute('aria-expanded', 'false');
    this.chipEl.title = this.buildTooltip(decision);
    this.chipEl.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'gap:4px',
      'padding:2px 8px',
      'border-radius:12px',
      'border:1px solid var(--border-color, #333)',
      `background:${color}15`,
      `color:${color}`,
      'font-size:11px',
      'font-weight:600',
      'cursor:pointer',
      'transition:all 0.15s ease',
      'position:relative',
      'outline:none',
    ].join(';');

    this.chipEl.innerHTML = `<span style="font-size:13px;">${emoji}</span><span>${label}</span>`;

    // Requirement 4.3: On tap, display override options
    this.chipEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePopover();
    });

    this.container.appendChild(this.chipEl);
  }

  /**
   * Update the chip with a revised decision (e.g., Stage B revision or override result).
   *
   * Requirement 4.2: update on Stage B revision without user action.
   */
  updateDecision(decision: IntentDecision): void {
    this.render(decision);
  }

  /**
   * Show the override popover with intent options.
   *
   * Requirement 4.3: display override options allowing user to select a different intent.
   * Requirement 4.4: remain tappable during pre-execution, interview, and orchestration.
   */
  showOverridePopover(): void {
    if (!this.chipEl || !this.currentDecision) return;
    if (this.isPopoverOpen) return;

    this.isPopoverOpen = true;
    this.chipEl.setAttribute('aria-expanded', 'true');

    this.popoverEl = document.createElement('div');
    this.popoverEl.className = 'intent-chip-popover';
    this.popoverEl.setAttribute('role', 'menu');
    this.popoverEl.setAttribute('aria-label', 'Override intent');
    this.popoverEl.style.cssText = [
      'position:absolute',
      'top:calc(100% + 4px)',
      'left:0',
      'z-index:1000',
      'min-width:160px',
      'background:var(--bg-elevated, #1e1e1e)',
      'border:1px solid var(--border-color, #333)',
      'border-radius:8px',
      'box-shadow:0 4px 12px rgba(0,0,0,0.3)',
      'padding:4px 0',
      'animation:fadeIn 0.1s ease',
    ].join(';');

    // Build override option items, excluding the current intent
    for (const option of OVERRIDE_OPTIONS) {
      if (option.intent === this.currentDecision.intent) continue;

      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'intent-chip-popover-item';
      item.setAttribute('role', 'menuitem');
      item.setAttribute('aria-label', `Override to ${option.label}`);
      item.setAttribute('data-intent', option.intent);
      item.style.cssText = [
        'display:flex',
        'align-items:center',
        'gap:8px',
        'width:100%',
        'padding:8px 12px',
        'border:none',
        'background:transparent',
        'color:var(--text-primary, #e0e0e0)',
        'font-size:12px',
        'cursor:pointer',
        'transition:background 0.1s ease',
        'text-align:left',
      ].join(';');

      item.innerHTML = `<span style="font-size:14px;">${option.emoji}</span><span>${option.label}</span>`;

      item.addEventListener('mouseenter', () => {
        item.style.background = 'var(--bg-hover, #2a2a2a)';
      });
      item.addEventListener('mouseleave', () => {
        item.style.background = 'transparent';
      });
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handleOverrideSelection(option.intent);
      });

      this.popoverEl.appendChild(item);
    }

    this.chipEl.appendChild(this.popoverEl);

    // Close on outside click
    this.outsideClickHandler = (e: MouseEvent) => {
      if (this.chipEl && !this.chipEl.contains(e.target as Node)) {
        this.closePopover();
      }
    };
    setTimeout(() => {
      document.addEventListener('click', this.outsideClickHandler!);
    }, 0);
  }

  /**
   * Close the override popover.
   */
  closePopover(): void {
    if (!this.isPopoverOpen) return;
    this.isPopoverOpen = false;

    if (this.chipEl) {
      this.chipEl.setAttribute('aria-expanded', 'false');
    }
    if (this.popoverEl) {
      this.popoverEl.remove();
      this.popoverEl = null;
    }
    if (this.outsideClickHandler) {
      document.removeEventListener('click', this.outsideClickHandler);
      this.outsideClickHandler = null;
    }
  }

  /**
   * Check if the popover is currently open.
   */
  isOpen(): boolean {
    return this.isPopoverOpen;
  }

  /**
   * Get the current decision displayed by the chip.
   */
  getDecision(): IntentDecision | null {
    return this.currentDecision;
  }

  /**
   * Dispose of the component and remove IPC listeners.
   */
  dispose(): void {
    this.closePopover();
    this.removeIPCListeners();
    this.container.innerHTML = '';
    this.chipEl = null;
    this.currentDecision = null;
  }

  // ─── Private Helpers ──────────────────────────────────────────

  private togglePopover(): void {
    if (this.isPopoverOpen) {
      this.closePopover();
    } else {
      this.showOverridePopover();
    }
  }

  /**
   * Handle the user selecting an override option.
   *
   * Requirement 4.5: reclassify with overridden intent THEN reroute.
   * Sends `intent:override-request` IPC; the main process calls
   * IntentGate.applyOverride() and responds with updated `intent:decision`.
   * Rerouting never occurs without a preceding reclassification step.
   */
  private handleOverrideSelection(newIntent: IntentLabel): void {
    if (!this.currentDecision) return;

    const api = getElectronAPI();
    if (!api) return;

    // Close popover immediately for responsive UX
    this.closePopover();

    // Send override request to main process
    // Main process will: 1) reclassify (applyOverride) → 2) reroute
    api.send(INTENT_IPC_CHANNELS.OVERRIDE_REQUEST, {
      messageHash: this.currentDecision.messageHash,
      newIntent,
    });
  }

  /**
   * Register IPC listener for `intent:decision` updates.
   * When the main process sends an updated decision (after override or Stage B revision),
   * update the chip and fire the callback.
   */
  private registerIPCListeners(): void {
    const api = getElectronAPI();
    if (!api) return;

    this.decisionListener = (...args: unknown[]) => {
      const decision = args[0] as IntentDecision;
      if (decision && decision.messageHash && decision.intent) {
        // Only update if this decision matches our current message
        if (this.currentDecision && decision.messageHash === this.currentDecision.messageHash) {
          this.updateDecision(decision);
          this.options.onOverrideDecision?.(decision);
        }
      }
    };

    api.on(INTENT_IPC_CHANNELS.DECISION, this.decisionListener);
  }

  /**
   * Remove IPC listeners.
   */
  private removeIPCListeners(): void {
    const api = getElectronAPI();
    if (!api || !this.decisionListener) return;

    api.removeListener(INTENT_IPC_CHANNELS.DECISION, this.decisionListener);
    this.decisionListener = null;
  }

  /**
   * Build tooltip text from classification signals.
   *
   * Requirement 4.6: display tooltip showing classification signals on hover.
   */
  private buildTooltip(decision: IntentDecision): string {
    const parts = [
      `Intent: ${decision.intent}`,
      `Confidence: ${(decision.confidence * 100).toFixed(0)}%`,
      `Stage: ${decision.stage}`,
    ];

    if (decision.complexity) {
      parts.push(`Complexity: ${decision.complexity}`);
    }

    if (decision.signals.length > 0) {
      parts.push('', 'Signals:');
      for (const signal of decision.signals.slice(0, 5)) {
        parts.push(`  • ${signal}`);
      }
    }

    return parts.join('\n');
  }
}

// ─── Factory Function ───────────────────────────────────────────

/**
 * Create an IntentChip component.
 *
 * @param container - The DOM element to mount the chip into
 * @param options - Configuration including feature gate and callbacks
 */
export function createIntentChip(container: HTMLElement, options: IntentChipOptions): IntentChip {
  return new IntentChip(container, options);
}
