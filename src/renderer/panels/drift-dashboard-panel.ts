/**
 * DriftDashboardPanel — Real-time dashboard for AuthR drift management monitoring.
 *
 * Features:
 * - Confidence gauge with color coding (green > 0.7, yellow 0.4–0.7, red < 0.4)
 * - Drift timeline showing signals plotted against iteration/time
 * - Scope utilization display (tools used vs allowed, paths modified vs allowed)
 * - Stale-after countdown timer
 * - Disabled state when drift management is not configured
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7
 */

import type { DriftDashboardState, DriftSignal } from '../../shared/feature-integration-types.js';

// ─── Electron API accessor ──────────────────────────────────────

function eapi(): {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (...args: unknown[]) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
} {
  return (window as any).electronAPI;
}

// ─── Renderable types ───────────────────────────────────────────

export interface DriftDashboardRenderable {
  confidenceGauge: {
    value: number;
    color: 'green' | 'yellow' | 'red';
  };
  timeline: {
    signals: Array<{
      iteration: number;
      timestamp: string;
      category: string;
      severity: string;
      message: string;
    }>;
  };
  scopeUtilization: {
    toolsUsed: number;
    toolsAllowed: number;
    pathsModified: number;
    pathsAllowed: number;
  };
  staleCountdown: {
    remainingMs: number;
    isStale: boolean;
  };
  anchor: {
    purpose: string;
    statement: string;
    createdAt: string;
  } | null;
  disabled: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Determine the confidence gauge color based on value.
 * Green: confidence > 0.7
 * Yellow: confidence between 0.4 and 0.7 (inclusive)
 * Red: confidence < 0.4
 */
function getConfidenceColor(confidence: number): 'green' | 'yellow' | 'red' {
  if (confidence > 0.7) return 'green';
  if (confidence < 0.4) return 'red';
  return 'yellow';
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'Stale';
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSec = seconds % 60;
  return `${minutes}m ${remainingSec}s`;
}

const SEVERITY_ICONS: Record<string, string> = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🚨',
};

const COLOR_VALUES: Record<'green' | 'yellow' | 'red', string> = {
  green: 'var(--green,#22c55e)',
  yellow: 'var(--yellow,#eab308)',
  red: 'var(--red,#ef4444)',
};

// ─── DriftDashboardPanel ────────────────────────────────────────

export class DriftDashboardPanel {
  private container: HTMLElement;
  private state: DriftDashboardState | null = null;
  private signalListener: ((...args: unknown[]) => void) | null = null;
  private stateUpdateListener: ((...args: unknown[]) => void) | null = null;
  private countdownInterval: ReturnType<typeof setInterval> | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /** Initialize the panel, subscribe to IPC events, and request initial state. */
  render(): void {
    this.container.innerHTML = '';
    this.container.style.cssText =
      'display:flex;flex-direction:column;height:100%;font-family:var(--font-family,system-ui);';
    this.subscribeToEvents();
    this.requestState();
  }

  /**
   * Convert the current DriftDashboardState into a DriftDashboardRenderable.
   * Useful for external consumers that need structured UI state.
   */
  toRenderable(): DriftDashboardRenderable {
    if (!this.state || !this.state.active) {
      return {
        confidenceGauge: { value: 0, color: 'red' },
        timeline: { signals: [] },
        scopeUtilization: { toolsUsed: 0, toolsAllowed: 0, pathsModified: 0, pathsAllowed: 0 },
        staleCountdown: { remainingMs: 0, isStale: true },
        anchor: null,
        disabled: true,
      };
    }

    const color = getConfidenceColor(this.state.confidence);
    const isStale = this.state.staleCountdownMs <= 0;

    return {
      confidenceGauge: {
        value: this.state.confidence,
        color,
      },
      timeline: {
        signals: this.state.signals.map((s) => ({
          iteration: s.iteration,
          timestamp: s.timestamp,
          category: s.category,
          severity: s.severity,
          message: s.message,
        })),
      },
      scopeUtilization: {
        toolsUsed: this.state.scope.toolsUsed,
        toolsAllowed: this.state.scope.toolsAllowed,
        pathsModified: this.state.scope.pathsModified,
        pathsAllowed: this.state.scope.pathsAllowed,
      },
      staleCountdown: {
        remainingMs: this.state.staleCountdownMs,
        isStale,
      },
      anchor: this.state.anchor,
      disabled: false,
    };
  }

  // ─── IPC Communication ────────────────────────────────────

  /** Subscribe to IPC events from the main process. */
  private subscribeToEvents(): void {
    // Listen for individual drift signals (pushed on critical signals)
    this.signalListener = (...args: unknown[]) => {
      const signal = args[1] as DriftSignal | undefined;
      if (signal) {
        this.handleSignal(signal);
      }
    };
    eapi().on('drift:signal', this.signalListener);

    // Listen for full state updates
    this.stateUpdateListener = (...args: unknown[]) => {
      const newState = args[1] as DriftDashboardState | undefined;
      if (newState) {
        this.handleStateUpdate(newState);
      }
    };
    eapi().on('drift:state-update', this.stateUpdateListener);
  }

  /** Unsubscribe from IPC events. */
  private unsubscribeFromEvents(): void {
    if (this.signalListener) {
      eapi().removeListener('drift:signal', this.signalListener);
      this.signalListener = null;
    }
    if (this.stateUpdateListener) {
      eapi().removeListener('drift:state-update', this.stateUpdateListener);
      this.stateUpdateListener = null;
    }
  }

  /** Request the current drift state from the main process. */
  private async requestState(): Promise<void> {
    this.container.innerHTML =
      '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px;">Loading drift status…</div>';

    try {
      const result = await eapi().invoke('drift:get-state');

      if (result && typeof result === 'object' && 'error' in (result as any)) {
        this.renderDisabled();
        return;
      }

      const dashboardState = result as DriftDashboardState | null;
      if (!dashboardState || !dashboardState.active) {
        this.state = dashboardState;
        this.renderDisabled();
      } else {
        this.state = dashboardState;
        this.renderActive();
      }
    } catch {
      // If IPC fails, show disabled state
      this.renderDisabled();
    }
  }

  // ─── Event Handlers ───────────────────────────────────────

  /** Handle a new drift signal pushed from the main process. */
  private handleSignal(signal: DriftSignal): void {
    if (!this.state) return;

    // Append signal to local state
    this.state = {
      ...this.state,
      signals: [...this.state.signals, signal],
      confidence: signal.currentConfidence,
    };

    this.renderActive();
  }

  /** Handle a full state update pushed from the main process. */
  private handleStateUpdate(newState: DriftDashboardState): void {
    this.state = newState;

    if (!newState.active) {
      this.renderDisabled();
    } else {
      this.renderActive();
    }
  }

  // ─── Disabled State Rendering ─────────────────────────────

  /**
   * Render the disabled state when drift management is not configured.
   * Requirement 8.6
   */
  private renderDisabled(): void {
    this.stopCountdown();
    this.container.innerHTML = '';

    const header = this.createHeader('🛡️ Drift Monitor');
    this.container.appendChild(header);

    const disabledEl = document.createElement('div');
    disabledEl.style.cssText =
      'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 16px;text-align:center;';

    const iconEl = document.createElement('div');
    iconEl.style.cssText = 'font-size:32px;margin-bottom:12px;opacity:0.4;';
    iconEl.textContent = '🛡️';
    disabledEl.appendChild(iconEl);

    const msgEl = document.createElement('div');
    msgEl.style.cssText = 'font-size:12px;color:var(--text-dim);max-width:200px;line-height:1.5;';
    msgEl.textContent = 'Drift monitoring is inactive. Enable driftConfig in your agent loop configuration to track execution alignment.';
    disabledEl.appendChild(msgEl);

    this.container.appendChild(disabledEl);
  }

  // ─── Active State Rendering ───────────────────────────────

  /** Render the full active dashboard with all sections. */
  private renderActive(): void {
    this.container.innerHTML = '';

    const header = this.createHeader('🛡️ Drift Monitor', [
      { label: '↻', title: 'Refresh', onClick: () => this.requestState() },
    ]);
    this.container.appendChild(header);

    const content = document.createElement('div');
    content.style.cssText = 'flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:8px;';

    // Anchor info (if available)
    if (this.state?.anchor) {
      content.appendChild(this.renderAnchorSection());
    }

    // Confidence gauge
    content.appendChild(this.renderConfidenceGauge());

    // Stale countdown
    content.appendChild(this.renderStaleCountdown());

    // Scope utilization
    content.appendChild(this.renderScopeUtilization());

    // Drift timeline
    content.appendChild(this.renderTimeline());

    this.container.appendChild(content);

    // Start countdown timer
    this.startCountdown();
  }

  // ─── Section Renderers ────────────────────────────────────

  /** Render the anchor info section showing purpose and statement. */
  private renderAnchorSection(): HTMLElement {
    const section = this.createSection('🎯 Intent Anchor');

    const anchor = this.state!.anchor!;

    const purposeEl = document.createElement('div');
    purposeEl.style.cssText = 'font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim);font-weight:600;margin-bottom:4px;';
    purposeEl.textContent = anchor.purpose;
    section.appendChild(purposeEl);

    const statementEl = document.createElement('div');
    statementEl.style.cssText = 'font-size:11px;color:var(--text-primary);line-height:1.4;word-break:break-word;';
    statementEl.textContent = anchor.statement.length > 120
      ? anchor.statement.slice(0, 120) + '…'
      : anchor.statement;
    section.appendChild(statementEl);

    const dateEl = document.createElement('div');
    dateEl.style.cssText = 'font-size:9px;color:var(--text-dim);margin-top:4px;';
    dateEl.textContent = `Created: ${formatTimestamp(anchor.createdAt)}`;
    section.appendChild(dateEl);

    return section;
  }

  /**
   * Render the confidence gauge with color coding.
   * Requirement 8.1: Green > 0.7, Yellow 0.4–0.7, Red < 0.4
   */
  private renderConfidenceGauge(): HTMLElement {
    const section = this.createSection('📊 Confidence');

    const confidence = this.state?.confidence ?? 0;
    const color = getConfidenceColor(confidence);
    const colorValue = COLOR_VALUES[color];
    const percentage = Math.round(confidence * 100);

    // Gauge bar container
    const gaugeContainer = document.createElement('div');
    gaugeContainer.style.cssText =
      'position:relative;height:24px;background:var(--bg-code,#1e1e1e);border-radius:12px;overflow:hidden;margin-bottom:4px;';

    // Filled portion
    const gaugeFill = document.createElement('div');
    gaugeFill.style.cssText =
      `height:100%;width:${percentage}%;background:${colorValue};border-radius:12px;transition:width 0.3s ease,background 0.3s ease;`;
    gaugeContainer.appendChild(gaugeFill);

    // Label overlay
    const gaugeLabel = document.createElement('div');
    gaugeLabel.style.cssText =
      'position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:white;text-shadow:0 1px 2px rgba(0,0,0,0.5);';
    gaugeLabel.textContent = `${percentage}%`;
    gaugeContainer.appendChild(gaugeLabel);

    section.appendChild(gaugeContainer);

    // Score text
    const scoreEl = document.createElement('div');
    scoreEl.style.cssText = `font-size:10px;color:${colorValue};font-weight:600;`;
    scoreEl.textContent = `Score: ${confidence.toFixed(3)} — ${color === 'green' ? 'Aligned' : color === 'yellow' ? 'Drifting' : 'Critical'}`;
    section.appendChild(scoreEl);

    return section;
  }

  /**
   * Render the stale-after countdown timer.
   * Requirement 8.4
   */
  private renderStaleCountdown(): HTMLElement {
    const section = this.createSection('⏱️ Staleness');

    const remainingMs = this.state?.staleCountdownMs ?? 0;
    const isStale = remainingMs <= 0;

    const countdownEl = document.createElement('div');
    countdownEl.id = 'drift-stale-countdown';
    countdownEl.style.cssText = `font-size:14px;font-weight:700;color:${isStale ? 'var(--red,#ef4444)' : 'var(--text-primary)'};`;
    countdownEl.textContent = formatCountdown(remainingMs);
    section.appendChild(countdownEl);

    const statusEl = document.createElement('div');
    statusEl.style.cssText = `font-size:10px;color:${isStale ? 'var(--red,#ef4444)' : 'var(--text-dim)'};margin-top:2px;`;
    statusEl.textContent = isStale
      ? 'Intent anchor is stale — consider re-confirming'
      : 'Time until intent anchor is considered stale';
    section.appendChild(statusEl);

    return section;
  }

  /**
   * Render scope utilization showing tools used vs allowed, paths modified vs allowed.
   * Requirement 8.3
   */
  private renderScopeUtilization(): HTMLElement {
    const section = this.createSection('🔒 Scope Utilization');

    const scope = this.state?.scope ?? { toolsUsed: 0, toolsAllowed: 0, pathsModified: 0, pathsAllowed: 0 };

    // Tools row
    const toolsRow = this.createUtilizationRow(
      'Tools',
      scope.toolsUsed,
      scope.toolsAllowed,
    );
    section.appendChild(toolsRow);

    // Paths row
    const pathsRow = this.createUtilizationRow(
      'Paths',
      scope.pathsModified,
      scope.pathsAllowed,
    );
    section.appendChild(pathsRow);

    return section;
  }

  /** Create a single utilization row with a bar indicator. */
  private createUtilizationRow(label: string, used: number, allowed: number): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = 'margin-bottom:6px;';

    const labelRow = document.createElement('div');
    labelRow.style.cssText = 'display:flex;justify-content:space-between;font-size:10px;color:var(--text-dim);margin-bottom:2px;';

    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    labelRow.appendChild(labelEl);

    const countEl = document.createElement('span');
    countEl.textContent = `${used} / ${allowed}`;
    labelRow.appendChild(countEl);

    row.appendChild(labelRow);

    // Bar
    const barContainer = document.createElement('div');
    barContainer.style.cssText = 'height:6px;background:var(--bg-code,#1e1e1e);border-radius:3px;overflow:hidden;';

    const percentage = allowed > 0 ? Math.min((used / allowed) * 100, 100) : 0;
    const isOverLimit = used > allowed;

    const barFill = document.createElement('div');
    barFill.style.cssText =
      `height:100%;width:${percentage}%;background:${isOverLimit ? 'var(--red,#ef4444)' : 'var(--accent,#3b82f6)'};border-radius:3px;transition:width 0.3s ease;`;
    barContainer.appendChild(barFill);

    row.appendChild(barContainer);
    return row;
  }

  /**
   * Render the drift timeline showing signals plotted against iteration/time.
   * Requirement 8.2
   */
  private renderTimeline(): HTMLElement {
    const section = this.createSection('📈 Drift Timeline');

    const signals = this.state?.signals ?? [];

    if (signals.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.style.cssText = 'font-size:11px;color:var(--text-dim);text-align:center;padding:8px;';
      emptyEl.textContent = 'No drift signals emitted yet.';
      section.appendChild(emptyEl);
      return section;
    }

    const listContainer = document.createElement('div');
    listContainer.style.cssText = 'max-height:200px;overflow-y:auto;';

    // Show signals in reverse chronological order (newest first)
    const reversed = [...signals].reverse();
    for (const signal of reversed) {
      listContainer.appendChild(this.createSignalRow(signal));
    }

    section.appendChild(listContainer);
    return section;
  }

  /** Create a single signal row in the timeline. */
  private createSignalRow(signal: DriftSignal): HTMLElement {
    const row = document.createElement('div');

    const severityColor = signal.severity === 'critical'
      ? 'var(--red,#ef4444)'
      : signal.severity === 'warning'
        ? 'var(--yellow,#eab308)'
        : 'var(--text-dim)';

    row.style.cssText =
      `display:flex;align-items:flex-start;gap:6px;padding:4px 6px;border-left:2px solid ${severityColor};margin-bottom:4px;font-size:10px;`;

    // Icon
    const iconEl = document.createElement('span');
    iconEl.style.cssText = 'flex-shrink:0;font-size:11px;';
    iconEl.textContent = SEVERITY_ICONS[signal.severity] ?? '•';
    row.appendChild(iconEl);

    // Content
    const contentEl = document.createElement('div');
    contentEl.style.cssText = 'flex:1;min-width:0;';

    const msgEl = document.createElement('div');
    msgEl.style.cssText = `color:${severityColor};font-weight:500;word-break:break-word;`;
    msgEl.textContent = signal.message;
    contentEl.appendChild(msgEl);

    const metaEl = document.createElement('div');
    metaEl.style.cssText = 'color:var(--text-dim);margin-top:1px;';
    metaEl.textContent = `Iter #${signal.iteration} · ${formatTimestamp(signal.timestamp)} · ${signal.category}`;
    contentEl.appendChild(metaEl);

    row.appendChild(contentEl);
    return row;
  }

  // ─── Countdown Timer ──────────────────────────────────────

  /** Start the countdown timer for stale-after display. */
  private startCountdown(): void {
    this.stopCountdown();

    this.countdownInterval = setInterval(() => {
      if (!this.state || !this.state.active || this.state.staleCountdownMs <= 0) {
        this.stopCountdown();
        return;
      }

      // Decrement by 1 second
      this.state = {
        ...this.state,
        staleCountdownMs: Math.max(0, this.state.staleCountdownMs - 1000),
      };

      // Update only the countdown element to avoid full re-render
      const countdownEl = this.container.querySelector('#drift-stale-countdown');
      if (countdownEl) {
        const isStale = this.state.staleCountdownMs <= 0;
        (countdownEl as HTMLElement).style.color = isStale ? 'var(--red,#ef4444)' : 'var(--text-primary)';
        countdownEl.textContent = formatCountdown(this.state.staleCountdownMs);
      }
    }, 1000);
  }

  /** Stop the countdown timer. */
  private stopCountdown(): void {
    if (this.countdownInterval !== null) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  // ─── UI Helpers ───────────────────────────────────────────

  private createHeader(
    title: string,
    buttons?: Array<{ label: string; title: string; onClick: () => void }>,
  ): HTMLElement {
    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-input);border-bottom:1px solid var(--border-color);min-height:36px;';

    const titleEl = document.createElement('span');
    titleEl.style.cssText =
      'font-size:12px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    titleEl.textContent = title;
    header.appendChild(titleEl);

    if (buttons && buttons.length > 0) {
      const btnGroup = document.createElement('div');
      btnGroup.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';

      for (const btn of buttons) {
        const el = document.createElement('button');
        el.textContent = btn.label;
        el.title = btn.title;
        el.setAttribute('aria-label', btn.title);
        el.style.cssText =
          'font-size:13px;width:28px;height:28px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;';
        el.addEventListener('click', btn.onClick);
        btnGroup.appendChild(el);
      }

      header.appendChild(btnGroup);
    }

    return header;
  }

  private createSection(title: string): HTMLElement {
    const section = document.createElement('div');
    section.style.cssText =
      'padding:8px 10px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-input);';

    const titleEl = document.createElement('div');
    titleEl.style.cssText =
      'font-size:10px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:6px;';
    titleEl.textContent = title;
    section.appendChild(titleEl);

    return section;
  }

  /** Clean up resources and unsubscribe from events. */
  destroy(): void {
    this.stopCountdown();
    this.unsubscribeFromEvents();
    this.container.innerHTML = '';
  }
}

// ─── Convenience export ─────────────────────────────────────────

/**
 * Render the drift dashboard panel into the given container element.
 * Returns the panel instance for lifecycle management.
 */
export function renderDriftDashboardPanel(
  container: HTMLElement,
): DriftDashboardPanel {
  const panel = new DriftDashboardPanel(container);
  panel.render();
  return panel;
}
