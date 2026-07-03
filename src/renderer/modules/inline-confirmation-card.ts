/**
 * InlineConfirmationCard — Renderer UI component for trivial-depth build confirmation.
 *
 * When the SpecInterviewEngine classifies a build as 'trivial' (0 questions),
 * this card renders an inline confirmation with:
 *   - Synthesized task summary (from the originalMessage of the InterviewState)
 *   - A prominent one-tap "Build" button
 *
 * On "Build" tap, sends `spec:action` IPC message with `{ specId, action: 'build' }`
 * to hand off to orchestration immediately.
 *
 * Gated behind the `spec_interview_engine` feature flag.
 *
 * Requirements: 5.1, 5.2, 5.3
 */

import type { InterviewState } from '../../pipeline/spec-interview-engine.js';

// ─── Types ──────────────────────────────────────────────────────

export interface InlineConfirmationCardOptions {
  /** Whether the card is enabled (feature-gated via spec_interview_engine) */
  enabled: boolean;
  /** Callback fired after the "Build" IPC message is sent */
  onBuild?: (interviewId: string) => void;
}

interface ElectronAPI {
  send(channel: string, ...args: unknown[]): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, callback: (...args: unknown[]) => void): void;
  removeListener(channel: string, callback: (...args: unknown[]) => void): void;
}

// ─── Constants ──────────────────────────────────────────────────

/**
 * IPC channel for spec actions (build, edit, cancel).
 * Renderer → Main: user acts on a spec/confirmation card.
 */
export const SPEC_ACTION_CHANNEL = 'spec:action' as const;

/**
 * The action payload value for triggering a build handoff.
 */
export const BUILD_ACTION = 'build' as const;

// ─── Helpers ────────────────────────────────────────────────────

function getElectronAPI(): ElectronAPI | null {
  return (window as any).electronAPI ?? null;
}

// ─── InlineConfirmationCard Component ───────────────────────────

/**
 * InlineConfirmationCard renders a confirmation for trivial-depth build tasks.
 *
 * Lifecycle:
 *   1. `render(interviewState)` → draws the card with task summary and "Build" button
 *   2. On "Build" click → sends `spec:action` IPC with { specId: interviewState.id, action: 'build' }
 *   3. Fires optional `onBuild` callback
 *
 * Requirements: 5.1, 5.2, 5.3
 */
export class InlineConfirmationCard {
  private container: HTMLElement;
  private options: InlineConfirmationCardOptions;
  private currentState: InterviewState | null = null;
  private cardEl: HTMLElement | null = null;
  private buildButtonEl: HTMLButtonElement | null = null;
  private isBuildTriggered = false;

  constructor(container: HTMLElement, options: InlineConfirmationCardOptions) {
    this.container = container;
    this.options = options;
  }

  /**
   * Render the inline confirmation card for a trivial InterviewState.
   *
   * Requirement 5.2: Display the synthesized task summary and a one-tap "Build" button.
   */
  render(state: InterviewState): void {
    if (!this.options.enabled) {
      this.container.innerHTML = '';
      return;
    }

    this.currentState = state;
    this.isBuildTriggered = false;
    this.container.innerHTML = '';

    // ── Card wrapper ──────────────────────────────────────────────
    this.cardEl = document.createElement('div');
    this.cardEl.className = 'inline-confirmation-card';
    this.cardEl.setAttribute('role', 'region');
    this.cardEl.setAttribute('aria-label', 'Build confirmation');
    this.cardEl.style.cssText = [
      'display:flex',
      'flex-direction:column',
      'gap:12px',
      'padding:16px',
      'border-radius:8px',
      'border:1px solid var(--border-color, #333)',
      'background:var(--bg-elevated, #1e1e1e)',
      'max-width:480px',
      'animation:fadeIn 0.15s ease',
    ].join(';');

    // ── Header ────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'inline-confirmation-card-header';
    header.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:8px',
    ].join(';');

    const icon = document.createElement('span');
    icon.textContent = '🔨';
    icon.style.fontSize = '16px';
    icon.setAttribute('aria-hidden', 'true');
    header.appendChild(icon);

    const title = document.createElement('span');
    title.className = 'inline-confirmation-card-title';
    title.textContent = 'Ready to build';
    title.style.cssText = [
      'font-size:13px',
      'font-weight:600',
      'color:var(--text-primary, #e0e0e0)',
    ].join(';');
    header.appendChild(title);

    this.cardEl.appendChild(header);

    // ── Task summary ──────────────────────────────────────────────
    // Requirement 5.2: Display synthesized task summary (from originalMessage)
    const summary = document.createElement('p');
    summary.className = 'inline-confirmation-card-summary';
    summary.textContent = state.originalMessage;
    summary.style.cssText = [
      'margin:0',
      'font-size:12px',
      'line-height:1.5',
      'color:var(--text-secondary, #aaa)',
      'word-break:break-word',
    ].join(';');
    this.cardEl.appendChild(summary);

    // ── Build button ──────────────────────────────────────────────
    // Requirement 5.2, 5.3: one-tap "Build" button → handoff to orchestration
    this.buildButtonEl = document.createElement('button');
    this.buildButtonEl.type = 'button';
    this.buildButtonEl.className = 'inline-confirmation-card-build-btn';
    this.buildButtonEl.setAttribute('aria-label', 'Build — start orchestration');
    this.buildButtonEl.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'justify-content:center',
      'gap:6px',
      'padding:8px 20px',
      'border-radius:6px',
      'border:none',
      'background:var(--button-primary-bg, #0078d4)',
      'color:var(--button-primary-fg, #ffffff)',
      'font-size:13px',
      'font-weight:600',
      'cursor:pointer',
      'transition:opacity 0.15s',
      'align-self:flex-start',
    ].join(';');

    const btnIcon = document.createElement('span');
    btnIcon.textContent = '▶';
    btnIcon.style.fontSize = '11px';
    btnIcon.setAttribute('aria-hidden', 'true');
    this.buildButtonEl.appendChild(btnIcon);

    const btnText = document.createElement('span');
    btnText.textContent = 'Build';
    this.buildButtonEl.appendChild(btnText);

    // Requirement 5.3: On "Build" tap, hand off to orchestration immediately
    this.buildButtonEl.addEventListener('click', () => {
      this.handleBuild();
    });

    this.cardEl.appendChild(this.buildButtonEl);
    this.container.appendChild(this.cardEl);
  }

  /**
   * Get the current InterviewState being displayed.
   */
  getState(): InterviewState | null {
    return this.currentState;
  }

  /**
   * Check if the "Build" action has been triggered.
   */
  isBuildSent(): boolean {
    return this.isBuildTriggered;
  }

  /**
   * Dispose of the component and clean up.
   */
  dispose(): void {
    this.container.innerHTML = '';
    this.cardEl = null;
    this.buildButtonEl = null;
    this.currentState = null;
    this.isBuildTriggered = false;
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Handle "Build" button click.
   *
   * Requirement 5.3: On "Build" tap, hand off to orchestration immediately.
   * Sends IPC `spec:action` with { specId: interviewState.id, action: 'build' }.
   */
  private handleBuild(): void {
    if (!this.currentState || this.isBuildTriggered) return;

    this.isBuildTriggered = true;

    // Disable button to prevent double-tap
    if (this.buildButtonEl) {
      this.buildButtonEl.disabled = true;
      this.buildButtonEl.style.opacity = '0.5';
      this.buildButtonEl.style.cursor = 'not-allowed';
    }

    // Send IPC to main process for orchestration handoff
    const api = getElectronAPI();
    if (api) {
      api.send(SPEC_ACTION_CHANNEL, {
        specId: this.currentState.id,
        action: BUILD_ACTION,
      });
    }

    // Fire callback
    this.options.onBuild?.(this.currentState.id);
  }
}

// ─── Factory Function ───────────────────────────────────────────

/**
 * Create an InlineConfirmationCard component.
 *
 * @param container - The DOM element to mount the card into
 * @param options - Configuration including feature gate and callbacks
 */
export function createInlineConfirmationCard(
  container: HTMLElement,
  options: InlineConfirmationCardOptions,
): InlineConfirmationCard {
  return new InlineConfirmationCard(container, options);
}
