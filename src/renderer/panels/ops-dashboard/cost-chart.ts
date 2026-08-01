/**
 * Cost Chart sub-panel for the Operations Dashboard.
 * Renders a cost progression chart (canvas-based) showing per-model spend
 * over the current day with the daily stop-loss threshold marked as a horizontal line.
 *
 * Requirements: 15.3
 */

/** Data point for model cost over time. */
export interface CostDataPoint {
  timestamp: number;
  costUSD: number;
  modelId: string;
}

/** Cost status summary from budget manager. */
export interface CostStatus {
  dailyTotalUSD: number;
  dailyStopLossUSD: number;
  perModelSpend: Array<{ modelId: string; costUSD: number; color?: string }>;
  dataPoints: CostDataPoint[];
}

/** CSS class names scoped to cost-chart. */
const CSS = {
  container: 'nn-ops-cost-chart',
  header: 'nn-ops-cost-chart__header',
  headerText: 'nn-ops-cost-chart__header-text',
  headerTotal: 'nn-ops-cost-chart__header-total',
  canvasWrapper: 'nn-ops-cost-chart__canvas-wrapper',
  canvas: 'nn-ops-cost-chart__canvas',
  legend: 'nn-ops-cost-chart__legend',
  legendItem: 'nn-ops-cost-chart__legend-item',
  legendDot: 'nn-ops-cost-chart__legend-dot',
  legendLabel: 'nn-ops-cost-chart__legend-label',
  empty: 'nn-ops-cost-chart__empty',
} as const;

/** Default color palette for models. */
const MODEL_COLORS = [
  '#6495ed', // Cornflower Blue
  '#49c791', // Emerald
  '#ffb347', // Pastel Orange
  '#dc5050', // Soft Red
  '#b39ddb', // Lavender
  '#4dd0e1', // Cyan
  '#f48fb1', // Pink
  '#aed581', // Light Green
];

/** Inject styles for cost-chart sub-panel. */
function injectStyles(): void {
  if (document.getElementById('nn-ops-cost-chart-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-ops-cost-chart-styles';
  style.textContent = `
    .${CSS.container} {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }
    .${CSS.header} {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-bottom: 1px solid var(--ops-border, #333333);
      background: var(--ops-header-bg, #252526);
    }
    .${CSS.headerText} {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--ops-header-text, #cccccc);
    }
    .${CSS.headerTotal} {
      font-size: 13px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: var(--ops-text-primary, #e0e0e0);
    }
    .${CSS.canvasWrapper} {
      flex: 1;
      position: relative;
      min-height: 120px;
      padding: 12px;
    }
    .${CSS.canvas} {
      width: 100%;
      height: 100%;
      display: block;
    }
    .${CSS.legend} {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      padding: 8px 12px;
      border-top: 1px solid var(--ops-border, #333333);
    }
    .${CSS.legendItem} {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .${CSS.legendDot} {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .${CSS.legendLabel} {
      font-size: 11px;
      color: var(--ops-text-secondary, #999999);
    }
    .${CSS.empty} {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      font-size: 13px;
      color: var(--ops-text-muted, #666666);
      padding: 24px;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Cost Chart panel component.
 * Renders a canvas-based line chart of cost progression with threshold marker.
 */
export class CostChartPanel {
  private container: HTMLElement | null = null;
  private canvasEl: HTMLCanvasElement | null = null;
  private legendEl: HTMLElement | null = null;
  private headerTotalEl: HTMLElement | null = null;
  private costStatus: CostStatus | null = null;
  private resizeObserver: ResizeObserver | null = null;

  /** Mount the cost chart panel into a container. */
  mount(container: HTMLElement): void {
    injectStyles();
    this.container = container;
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = CSS.container;

    // Header
    const header = document.createElement('div');
    header.className = CSS.header;

    const headerText = document.createElement('span');
    headerText.className = CSS.headerText;
    headerText.textContent = 'Cost Today';
    header.appendChild(headerText);

    this.headerTotalEl = document.createElement('span');
    this.headerTotalEl.className = CSS.headerTotal;
    this.headerTotalEl.textContent = '$0.0000';
    header.appendChild(this.headerTotalEl);

    wrapper.appendChild(header);

    // Canvas wrapper
    const canvasWrapper = document.createElement('div');
    canvasWrapper.className = CSS.canvasWrapper;

    this.canvasEl = document.createElement('canvas');
    this.canvasEl.className = CSS.canvas;
    this.canvasEl.setAttribute('role', 'img');
    this.canvasEl.setAttribute('aria-label', 'Cost progression chart showing per-model spend over current day');
    canvasWrapper.appendChild(this.canvasEl);

    wrapper.appendChild(canvasWrapper);

    // Legend
    this.legendEl = document.createElement('div');
    this.legendEl.className = CSS.legend;
    wrapper.appendChild(this.legendEl);

    container.appendChild(wrapper);

    // Observe resize to redraw canvas
    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(canvasWrapper);
  }

  /** Unmount and clean up resources. */
  unmount(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.container) {
      this.container.innerHTML = '';
    }
    this.container = null;
    this.canvasEl = null;
    this.legendEl = null;
    this.headerTotalEl = null;
    this.costStatus = null;
  }

  /** Update the chart with new cost data. */
  update(costStatus: CostStatus): void {
    this.costStatus = costStatus;
    if (this.headerTotalEl) {
      this.headerTotalEl.textContent = `$${costStatus.dailyTotalUSD.toFixed(4)}`;
    }
    this.renderLegend();
    this.draw();
  }

  /** Render the legend showing model colors and names. */
  private renderLegend(): void {
    if (!this.legendEl || !this.costStatus) return;
    this.legendEl.innerHTML = '';

    // Stop-loss legend item
    const stopLossItem = document.createElement('div');
    stopLossItem.className = CSS.legendItem;
    const stopLossDot = document.createElement('span');
    stopLossDot.className = CSS.legendDot;
    stopLossDot.style.background = '#dc5050';
    stopLossDot.style.borderRadius = '0';
    stopLossDot.style.height = '2px';
    stopLossDot.style.width = '12px';
    stopLossItem.appendChild(stopLossDot);
    const stopLossLabel = document.createElement('span');
    stopLossLabel.className = CSS.legendLabel;
    stopLossLabel.textContent = `Stop-loss ($${this.costStatus.dailyStopLossUSD.toFixed(2)})`;
    stopLossItem.appendChild(stopLossLabel);
    this.legendEl.appendChild(stopLossItem);

    // Model legend items
    for (let i = 0; i < this.costStatus.perModelSpend.length; i++) {
      const model = this.costStatus.perModelSpend[i];
      const color = model.color || MODEL_COLORS[i % MODEL_COLORS.length];

      const item = document.createElement('div');
      item.className = CSS.legendItem;

      const dot = document.createElement('span');
      dot.className = CSS.legendDot;
      dot.style.background = color;
      item.appendChild(dot);

      const label = document.createElement('span');
      label.className = CSS.legendLabel;
      label.textContent = `${model.modelId} ($${model.costUSD.toFixed(4)})`;
      item.appendChild(label);

      this.legendEl.appendChild(item);
    }
  }

  /** Draw the cost progression chart on canvas. */
  private draw(): void {
    if (!this.canvasEl || !this.costStatus) return;

    const canvas = this.canvasEl;
    const wrapper = canvas.parentElement;
    if (!wrapper) return;

    // Set canvas size to match container (account for pixel ratio)
    const dpr = window.devicePixelRatio || 1;
    const rect = wrapper.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const padding = { top: 16, right: 12, bottom: 24, left: 48 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    // Clear canvas
    ctx.clearRect(0, 0, w, h);

    const { dataPoints, dailyStopLossUSD } = this.costStatus;

    if (dataPoints.length === 0) {
      // Empty state: just draw the stop-loss line
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillStyle = '#666666';
      ctx.textAlign = 'center';
      ctx.fillText('No cost data yet', w / 2, h / 2);
      return;
    }

    // Determine time range (start of day UTC to now)
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const timeMin = todayStart.getTime();
    const timeMax = now;
    const timeRange = Math.max(timeMax - timeMin, 1);

    // Determine cost range (0 to max of stop-loss or highest data point)
    const maxCost = Math.max(
      dailyStopLossUSD,
      ...dataPoints.map((dp) => dp.costUSD)
    );
    const costMax = maxCost * 1.1; // Add 10% headroom

    // Helper to map data to pixel coordinates
    const toX = (timestamp: number): number =>
      padding.left + ((timestamp - timeMin) / timeRange) * chartW;
    const toY = (cost: number): number =>
      padding.top + chartH - (cost / costMax) * chartH;

    // Draw grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    const gridLines = 4;
    for (let i = 0; i <= gridLines; i++) {
      const y = padding.top + (chartH / gridLines) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + chartW, y);
      ctx.stroke();

      // Cost labels on Y axis
      const costLabel = ((costMax / gridLines) * (gridLines - i)).toFixed(3);
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillStyle = '#666666';
      ctx.textAlign = 'right';
      ctx.fillText(`$${costLabel}`, padding.left - 6, y + 3);
    }

    // Draw stop-loss threshold line (dashed red)
    const stopLossY = toY(dailyStopLossUSD);
    ctx.strokeStyle = '#dc5050';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(padding.left, stopLossY);
    ctx.lineTo(padding.left + chartW, stopLossY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Group data points by model
    const modelGroups = new Map<string, CostDataPoint[]>();
    for (const dp of dataPoints) {
      const existing = modelGroups.get(dp.modelId) || [];
      existing.push(dp);
      modelGroups.set(dp.modelId, existing);
    }

    // Draw lines for each model
    const modelIds = Array.from(modelGroups.keys());
    for (let i = 0; i < modelIds.length; i++) {
      const modelId = modelIds[i];
      const points = modelGroups.get(modelId)!;
      const color = this.costStatus.perModelSpend.find((m) => m.modelId === modelId)?.color
        || MODEL_COLORS[i % MODEL_COLORS.length];

      if (points.length < 2) continue;

      // Sort by timestamp
      points.sort((a, b) => a.timestamp - b.timestamp);

      // Draw cumulative line for this model
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();

      let cumulativeCost = 0;
      for (let j = 0; j < points.length; j++) {
        cumulativeCost += points[j].costUSD;
        const x = toX(points[j].timestamp);
        const y = toY(cumulativeCost);
        if (j === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();

      // Draw fill area under line
      ctx.fillStyle = color.replace(')', ', 0.08)').replace('rgb', 'rgba').replace('#', '');
      // Use a semi-transparent fill from the hex color
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = color;
      ctx.lineTo(toX(points[points.length - 1].timestamp), padding.top + chartH);
      ctx.lineTo(toX(points[0].timestamp), padding.top + chartH);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Draw time axis labels
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = '#666666';
    ctx.textAlign = 'center';
    const timeLabels = 4;
    for (let i = 0; i <= timeLabels; i++) {
      const t = timeMin + (timeRange / timeLabels) * i;
      const date = new Date(t);
      const label = `${date.getUTCHours().toString().padStart(2, '0')}:${date.getUTCMinutes().toString().padStart(2, '0')}`;
      const x = toX(t);
      ctx.fillText(label, x, h - 4);
    }
  }
}
