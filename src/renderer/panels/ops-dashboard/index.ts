/**
 * Operations Dashboard panel.
 * Registers with panel-registry, sets up a grid layout with 4 sub-panels:
 * - Active Runs (top-left)
 * - Approval Queue (top-right)
 * - Cost Chart (bottom-left)
 * - Policy Log (bottom-right)
 *
 * Uses IPC channels:
 * - `ops:get-active-runs`
 * - `ops:get-pending-approvals`
 * - `ops:get-cost-status`
 * - `ops:get-policy-decisions`
 * - `ops:subscribe-updates`
 *
 * Updates displayed data within 3 seconds of state changes (Requirement 15.6).
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6
 */

import type { PanelModule } from '../../types';
import { ActiveRunsPanel, type ActiveRun } from './active-runs';
import { ApprovalQueuePanel, type PendingApproval } from './approval-queue';
import { CostChartPanel, type CostStatus } from './cost-chart';
import { PolicyLogPanel, type PolicyDecisionEntry } from './policy-log';

export type { ActiveRun } from './active-runs';
export type { PendingApproval } from './approval-queue';
export type { CostStatus, CostDataPoint } from './cost-chart';
export type { PolicyDecisionEntry } from './policy-log';

/** CSS class names scoped to the ops-dashboard. */
const CSS = {
  container: 'nn-ops-dashboard',
  grid: 'nn-ops-dashboard__grid',
  cell: 'nn-ops-dashboard__cell',
} as const;

/** IPC event types pushed by the main process. */
interface OpsUpdateEvent {
  type: 'active-runs' | 'pending-approvals' | 'cost-status' | 'policy-decisions';
  data: unknown;
}

/**
 * Typed wrapper for accessing the preload-exposed IPC bridge.
 * Falls back to no-op if the bridge is unavailable (e.g. in unit tests).
 */
function getIpcBridge(): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
} {
  const bridge = (window as unknown as Record<string, unknown>).electronAPI as {
    invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on?: (channel: string, callback: (...args: unknown[]) => void) => void;
    removeListener?: (channel: string, callback: (...args: unknown[]) => void) => void;
  } | undefined;

  return {
    invoke: bridge?.invoke ?? (async () => undefined),
    on: bridge?.on ?? (() => {}),
    removeListener: bridge?.removeListener ?? (() => {}),
  };
}

/** Inject styles for the ops-dashboard layout. */
function injectStyles(): void {
  if (document.getElementById('nn-ops-dashboard-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-ops-dashboard-styles';
  style.textContent = `
    .${CSS.container} {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--ops-bg, #1e1e1e);
    }
    .${CSS.grid} {
      flex: 1;
      display: grid;
      grid-template-columns: 1fr 1fr;
      grid-template-rows: 1fr 1fr;
      gap: 1px;
      background: var(--ops-border, #333333);
      min-height: 0;
    }
    .${CSS.cell} {
      background: var(--ops-cell-bg, #1e1e1e);
      overflow: hidden;
      min-height: 0;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Operations Dashboard panel implementing the PanelModule lifecycle.
 * Coordinates four sub-panels and manages IPC communication for real-time updates.
 */
class OpsDashboardPanel implements PanelModule {
  private container: HTMLElement | null = null;
  private activeRunsPanel: ActiveRunsPanel;
  private approvalQueuePanel: ApprovalQueuePanel;
  private costChartPanel: CostChartPanel;
  private policyLogPanel: PolicyLogPanel;
  private updateHandler: ((...args: unknown[]) => void) | null = null;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.activeRunsPanel = new ActiveRunsPanel();
    this.approvalQueuePanel = new ApprovalQueuePanel();
    this.costChartPanel = new CostChartPanel();
    this.policyLogPanel = new PolicyLogPanel();
  }

  /** Mount the operations dashboard into the given container element. */
  mount(container: HTMLElement): void {
    injectStyles();
    this.container = container;
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = CSS.container;

    const grid = document.createElement('div');
    grid.className = CSS.grid;

    // Top-left: Active Runs
    const activeRunsCell = document.createElement('div');
    activeRunsCell.className = CSS.cell;
    this.activeRunsPanel.mount(activeRunsCell);
    grid.appendChild(activeRunsCell);

    // Top-right: Approval Queue
    const approvalCell = document.createElement('div');
    approvalCell.className = CSS.cell;
    this.approvalQueuePanel.mount(approvalCell);
    grid.appendChild(approvalCell);

    // Bottom-left: Cost Chart
    const costCell = document.createElement('div');
    costCell.className = CSS.cell;
    this.costChartPanel.mount(costCell);
    grid.appendChild(costCell);

    // Bottom-right: Policy Log
    const policyCell = document.createElement('div');
    policyCell.className = CSS.cell;
    this.policyLogPanel.mount(policyCell);
    grid.appendChild(policyCell);

    wrapper.appendChild(grid);
    container.appendChild(wrapper);

    // Subscribe to real-time updates via IPC
    this.subscribeToUpdates();

    // Load initial data
    this.loadAllData();

    // Periodic refresh as a fallback to ensure data stays current (within 3s requirement)
    this.refreshInterval = setInterval(() => this.loadAllData(), 3000);
  }

  /** Unmount the dashboard and clean up all resources. */
  unmount(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }

    this.unsubscribeFromUpdates();

    this.activeRunsPanel.unmount();
    this.approvalQueuePanel.unmount();
    this.costChartPanel.unmount();
    this.policyLogPanel.unmount();

    if (this.container) {
      this.container.innerHTML = '';
    }
    this.container = null;
  }

  /** Called when the panel receives focus. */
  onFocus(): void {
    // Refresh data immediately on focus to ensure freshness
    this.loadAllData();
  }

  /** Subscribe to push-based real-time updates from the main process. */
  private subscribeToUpdates(): void {
    const bridge = getIpcBridge();

    this.updateHandler = (...args: unknown[]) => {
      const event = args[0] as OpsUpdateEvent | undefined;
      if (!event) return;
      this.handleUpdate(event);
    };

    bridge.on('ops:subscribe-updates', this.updateHandler);

    // Tell the main process we want updates
    bridge.invoke('ops:subscribe-updates');
  }

  /** Unsubscribe from real-time updates. */
  private unsubscribeFromUpdates(): void {
    if (this.updateHandler) {
      const bridge = getIpcBridge();
      bridge.removeListener('ops:subscribe-updates', this.updateHandler);
      this.updateHandler = null;
    }
  }

  /** Handle an incoming real-time update event. */
  private handleUpdate(event: OpsUpdateEvent): void {
    switch (event.type) {
      case 'active-runs':
        this.activeRunsPanel.update(event.data as ActiveRun[]);
        break;
      case 'pending-approvals':
        this.approvalQueuePanel.update(event.data as PendingApproval[]);
        break;
      case 'cost-status':
        this.costChartPanel.update(event.data as CostStatus);
        break;
      case 'policy-decisions':
        this.policyLogPanel.update(event.data as PolicyDecisionEntry[]);
        break;
    }
  }

  /** Load all data from the main process via IPC. */
  private async loadAllData(): Promise<void> {
    const bridge = getIpcBridge();

    // Fire all requests in parallel for responsiveness
    const [runs, approvals, costStatus, decisions] = await Promise.all([
      bridge.invoke('ops:get-active-runs'),
      bridge.invoke('ops:get-pending-approvals'),
      bridge.invoke('ops:get-cost-status'),
      bridge.invoke('ops:get-policy-decisions'),
    ]);

    if (runs) {
      this.activeRunsPanel.update(runs as ActiveRun[]);
    }
    if (approvals) {
      this.approvalQueuePanel.update(approvals as PendingApproval[]);
    }
    if (costStatus) {
      this.costChartPanel.update(costStatus as CostStatus);
    }
    if (decisions) {
      this.policyLogPanel.update(decisions as PolicyDecisionEntry[]);
    }
  }
}

/** Create and export the operations dashboard panel module. */
export function createOpsDashboardPanel(): PanelModule {
  return new OpsDashboardPanel();
}

/** Default export: a ready-to-use operations dashboard panel instance. */
export const opsDashboardPanel: PanelModule = createOpsDashboardPanel();
