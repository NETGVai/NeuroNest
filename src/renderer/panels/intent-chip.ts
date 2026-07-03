/**
 * IntentChip — Renderer component for displaying and overriding intent classification.
 *
 * Renders a small chip on every user message showing the classified intent label
 * with an appropriate emoji icon (💬, ⚡, 🔨). Supports:
 * - Optimistic rendering using Stage A result within 200ms of submission
 * - Smooth update when Stage B revises the classification (no flicker)
 * - Tooltip with classification signals on hover
 * - Tap/click to trigger intent override during pre-execution, interview, and orchestration
 * - Listening to `intent:decision` IPC channel for IntentDecision updates
 *
 * Feature-gated via `intent_chip_ux`.
 *
 * Requirements: 4.1, 4.2, 4.4, 4.6
 */

import type { IntentDecision, IntentLabel } from '../../pipeline/intent-gate.js';

// ─── Electron API accessor ──────────────────────────────────────

function eapi(): {
  send(channel: string, ...args: unknown[]): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (...args: unknown[]) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
} {
  return (window as any).electronAPI;
}

// ─── Types ──────────────────────────────────────────────────────

export type IntentChipPhase = 'pre-execution' | 'interview' | 'orchestration' | 'completed';

export interface IntentChipState {
  decision: IntentDecision | null;
  phase: IntentChipPhase;
  overrideMenuOpen: boolean;
  enabled: boolean;
}

// ─── Intent display configuration ──────────────────────────────

export interface IntentDisplayConfig {
  emoji: string;
  label: string;
  color: string;
  bgColor: string;
}

const INTENT_DISPLAY: Record<IntentLabel, IntentDisplayConfig> = {
  conversation: {
    emoji: '💬',
    label: 'Chat',
    color: 'var(--blue, #3b82f6)',
    bgColor: 'rgba(59, 130, 246, 0.1)',
  },
  quick_action: {
    emoji: '⚡',
    label: 'Quick',
    color: 'var(--amber, #f59e0b)',
    bgColor: 'rgba(245, 158, 11, 0.1)',
  },
  build: {
    emoji: '🔨',
    label: 'Build',
    color: 'var(--green, #22c55e)',
    bgColor: 'rgba(34, 197, 94, 0.1)',
  },
  ambiguous: {
    emoji: '❓',
    label: 'Unclear',
    color: 'var(--text-dim, #888)',
    bgColor: 'rgba(136, 136, 136, 0.1)',
  },
};

// ─── Pure Logic Functions (exported for testing) ────────────────

/**
 * Returns the display configuration for a given intent label.
 */
export function getIntentDisplay(intent: IntentLabel): IntentDisplayConfig {
  return INTENT_DISPLAY[intent] ?? INTENT_DISPLAY['ambiguous'];
}

/**
 * Determines if the chip should be tappable/clickable for override.
 * Chip is tappable during pre-execution, interview, and orchestration phases.
 *
 * Requirement 4.4
 */
export function isChipTappable(phase: IntentChipPhase): boolean {
  return phase === 'pre-execution' || phase === 'interview' || phase === 'orchestration';
}

/**
 * Determines if the chip should update when a new decision arrives.
 * Only updates if the decision is for the same message (by messageHash).
 */
export function shouldUpdateChip(
  currentDecision: IntentDecision | null,
  newDecision: IntentDecision,
): boolean {
  if (!currentDecision) return true;
  return currentDecision.messageHash === newDecision.messageHash;
}

/**
 * Formats classification signals into a tooltip-friendly string.
 *
 * Requirement 4.6
 */
export function formatSignalsTooltip(decision: IntentDecision): string {
  const lines: string[] = [];
  lines.push(`Intent: ${decision.intent} (${Math.round(decision.confidence * 100)}%)`);
  lines.push(`Stage: ${decision.stage}`);
  if (decision.complexity) {
    lines.push(`Complexity: ${decision.complexity}`);
  }
  lines.push(`Latency: ${decision.latencyMs}ms`);
  if (decision.signals.length > 0) {
    lines.push('');
    lines.push('Signals:');
    for (const signal of decision.signals) {
      lines.push(`• ${signal}`);
    }
  }
  return lines.join('\n');
}

/**
 * Returns the list of override options (the other intents excluding the current one).
 */
export function getOverrideOptions(currentIntent: IntentLabel): IntentLabel[] {
  const allIntents: IntentLabel[] = ['conversation', 'quick_action', 'build'];
  return allIntents.filter((i) => i !== currentIntent);
}

// ─── IntentChip Component ───────────────────────────────────────

export class IntentChip {
  private container: HTMLElement;
  private state: IntentChipState;
  private decisionListener: ((...args: unknown[]) => void) | null = null;
  private messageHash: string;
  private onOverride: ((messageHash: string, newIntent: IntentLabel) => void) | null = null;

  constructor(container: HTMLElement, messageHash: string) {
    this.container = container;
    this.messageHash = messageHash;
    this.state = {
      decision: null,
      phase: 'pre-execution',
      overrideMenuOpen: false,
      enabled: false,
    };
  }

  /**
   * Initialize the chip: check feature gate, set up IPC listeners, render.
   */
  async init(): Promise<void> {
    this.state.enabled = await this.checkFeatureGate();
    if (!this.state.enabled) return;

    this.setupIPCListeners();
    this.render();
  }

  /**
   * Get the current state (for testing/external consumers).
   */
  getState(): IntentChipState {
    return { ...this.state };
  }

  /**
   * Set the current phase of the message lifecycle.
   * Controls whether the chip is tappable for override.
   */
  setPhase(phase: IntentChipPhase): void {
    this.state.phase = phase;
    this.render();
  }

  /**
   * Register a callback for when the user performs an override.
   * The callback receives the messageHash and the newly selected intent.
   */
  setOverrideHandler(handler: (messageHash: string, newIntent: IntentLabel) => void): void {
    this.onOverride = handler;
  }

  /**
   * Handle an incoming IntentDecision.
   * Updates the chip if the decision matches this message's hash.
   *
   * Requirement 4.2: Update when Stage B revises classification (smooth, no flicker)
   */
  handleDecision(decision: IntentDecision): void {
    if (decision.messageHash !== this.messageHash) return;

    const shouldUpdate = shouldUpdateChip(this.state.decision, decision);
    if (!shouldUpdate) return;

    this.state.decision = decision;
    this.render();
  }

  /**
   * Clean up IPC listeners.
   */
  destroy(): void {
    if (this.decisionListener) {
      eapi().removeListener('intent:decision', this.decisionListener);
      this.decisionListener = null;
    }
  }

  // ─── Rendering ──────────────────────────────────────────────────

  private render(): void {
    this.container.innerHTML = '';

    if (!this.state.enabled) {
      this.container.style.display = 'none';
      return;
    }

    this.container.style.display = 'inline-block';
    this.container.className = 'intent-chip-container';

    if (!this.state.decision) {
      // Render a loading/placeholder state
      this.container.appendChild(this.renderPlaceholder());
      return;
    }

    const chipEl = this.renderChip(this.state.decision);
    this.container.appendChild(chipEl);

    // Render override menu if open
    if (this.state.overrideMenuOpen) {
      const menu = this.renderOverrideMenu(this.state.decision.intent);
      this.container.appendChild(menu);
    }
  }

  private renderPlaceholder(): HTMLElement {
    const placeholder = document.createElement('span');
    placeholder.className = 'intent-chip intent-chip--loading';
    placeholder.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'gap:4px',
      'padding:2px 8px',
      'border-radius:12px',
      'font-size:11px',
      'background:var(--bg-input, #f3f4f6)',
      'color:var(--text-dim, #888)',
      'opacity:0.6',
      'transition:opacity 0.2s',
    ].join(';');
    placeholder.textContent = '…';
    placeholder.setAttribute('aria-label', 'Classifying intent...');
    return placeholder;
  }

  private renderChip(decision: IntentDecision): HTMLElement {
    const display = getIntentDisplay(decision.intent);
    const tappable = isChipTappable(this.state.phase);
    const tooltip = formatSignalsTooltip(decision);

    const chip = document.createElement('button');
    chip.className = `intent-chip intent-chip--${decision.intent}`;
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-label', `Intent: ${display.label}. ${tappable ? 'Click to override.' : ''}`);
    chip.setAttribute('title', tooltip);
    chip.setAttribute('data-message-hash', decision.messageHash);
    chip.setAttribute('data-intent', decision.intent);
    chip.setAttribute('data-stage', decision.stage);

    chip.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'gap:4px',
      'padding:2px 8px',
      'border-radius:12px',
      'font-size:11px',
      'font-weight:500',
      'border:1px solid transparent',
      `background:${display.bgColor}`,
      `color:${display.color}`,
      `cursor:${tappable ? 'pointer' : 'default'}`,
      'transition:all 0.2s ease',
      'outline:none',
      'user-select:none',
      'white-space:nowrap',
    ].join(';');

    // Hover effects for tappable chips
    if (tappable) {
      chip.addEventListener('mouseenter', () => {
        chip.style.borderColor = display.color;
        chip.style.transform = 'scale(1.02)';
      });
      chip.addEventListener('mouseleave', () => {
        chip.style.borderColor = 'transparent';
        chip.style.transform = 'scale(1)';
      });
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleOverrideMenu();
      });
    }

    // Emoji icon
    const emojiSpan = document.createElement('span');
    emojiSpan.className = 'intent-chip__icon';
    emojiSpan.style.cssText = 'font-size:12px;line-height:1;';
    emojiSpan.textContent = display.emoji;
    chip.appendChild(emojiSpan);

    // Label
    const labelSpan = document.createElement('span');
    labelSpan.className = 'intent-chip__label';
    labelSpan.textContent = display.label;
    chip.appendChild(labelSpan);

    // Confidence badge (subtle)
    const confSpan = document.createElement('span');
    confSpan.className = 'intent-chip__confidence';
    confSpan.style.cssText = 'font-size:9px;opacity:0.7;';
    confSpan.textContent = `${Math.round(decision.confidence * 100)}%`;
    chip.appendChild(confSpan);

    return chip;
  }

  private renderOverrideMenu(currentIntent: IntentLabel): HTMLElement {
    const menu = document.createElement('div');
    menu.className = 'intent-chip-override-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Override intent classification');
    menu.style.cssText = [
      'position:absolute',
      'top:calc(100% + 4px)',
      'left:0',
      'z-index:1000',
      'background:var(--bg-panel, #fff)',
      'border:1px solid var(--border-color, #e5e7eb)',
      'border-radius:8px',
      'box-shadow:0 4px 12px rgba(0,0,0,0.15)',
      'padding:4px',
      'min-width:120px',
      'animation:fadeIn 0.15s ease',
    ].join(';');

    const options = getOverrideOptions(currentIntent);

    for (const intent of options) {
      const display = getIntentDisplay(intent);
      const option = document.createElement('button');
      option.className = 'intent-chip-override-option';
      option.setAttribute('role', 'menuitem');
      option.setAttribute('data-intent', intent);
      option.style.cssText = [
        'display:flex',
        'align-items:center',
        'gap:8px',
        'width:100%',
        'padding:6px 10px',
        'border:none',
        'border-radius:4px',
        'background:transparent',
        'cursor:pointer',
        'font-size:12px',
        'color:var(--text-primary, #1f2937)',
        'text-align:left',
        'transition:background 0.1s',
      ].join(';');

      option.addEventListener('mouseenter', () => {
        option.style.background = display.bgColor;
      });
      option.addEventListener('mouseleave', () => {
        option.style.background = 'transparent';
      });
      option.addEventListener('click', (e) => {
        e.stopPropagation();
        this.performOverride(intent);
      });

      const emoji = document.createElement('span');
      emoji.textContent = display.emoji;
      option.appendChild(emoji);

      const label = document.createElement('span');
      label.textContent = display.label;
      option.appendChild(label);

      menu.appendChild(option);
    }

    // Close menu on outside click
    const closeHandler = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node) && !this.container.contains(e.target as Node)) {
        this.state.overrideMenuOpen = false;
        this.render();
        document.removeEventListener('click', closeHandler);
      }
    };
    // Defer to avoid immediate close from the click that opened the menu
    setTimeout(() => document.addEventListener('click', closeHandler), 0);

    return menu;
  }

  // ─── Actions ──────────────────────────────────────────────────

  private toggleOverrideMenu(): void {
    this.state.overrideMenuOpen = !this.state.overrideMenuOpen;
    this.render();
  }

  /**
   * Perform an intent override: sends the override request via IPC
   * and calls the registered override handler.
   *
   * Requirement 4.5: Override → reclassify → reroute
   */
  private performOverride(newIntent: IntentLabel): void {
    this.state.overrideMenuOpen = false;

    // Send override request to main process
    eapi().send('intent:override-request', {
      messageHash: this.messageHash,
      newIntent,
    });

    // Notify the handler
    if (this.onOverride) {
      this.onOverride(this.messageHash, newIntent);
    }

    this.render();
  }

  // ─── IPC Listeners ──────────────────────────────────────────────

  private setupIPCListeners(): void {
    this.decisionListener = (...args: unknown[]) => {
      const decision = args[0] as IntentDecision;
      if (decision && decision.intent && decision.messageHash) {
        this.handleDecision(decision);
      }
    };
    eapi().on('intent:decision', this.decisionListener);
  }

  private async checkFeatureGate(): Promise<boolean> {
    try {
      const config = await eapi().invoke('get-config') as Record<string, unknown>;
      if (config && typeof config === 'object') {
        return (config as any).intent_chip_ux === true;
      }
    } catch {
      // Feature not available — disabled
    }
    return false;
  }
}

// ─── Convenience Export ─────────────────────────────────────────

/**
 * Create and initialize an IntentChip in the given container for a specific message.
 * Feature-gated: returns the chip but it may be disabled if the gate is off.
 *
 * Requirement 4.1: Chip appears within 200ms of message submission.
 * The caller is responsible for creating this component immediately after message submission.
 */
export async function createIntentChip(
  container: HTMLElement,
  messageHash: string,
): Promise<IntentChip> {
  const chip = new IntentChip(container, messageHash);
  await chip.init();
  return chip;
}
