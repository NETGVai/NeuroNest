/**
 * Insight Surface — attributable metric cards with conditional chart rendering.
 *
 * Charts are permitted ONLY when ALL prerequisites are present:
 * - values (non-empty metrics array)
 * - units (every metric has a unit)
 * - time range (timeRange field is present and non-empty)
 * - accessible summary (accessibleSummary is present and non-empty)
 * - nonvisual alternative (derived text description of the data)
 *
 * When ANY prerequisite is absent → fall back to non-chart text/card view.
 * Underlying values are ALWAYS accessible regardless of chart rendering.
 * Source revision and provenance are exposed per DeepSeek Harness Requirement 48.
 * Data representation uses text/shape beyond color (Requirement 18.11).
 *
 * Requirements: 11.5–11.7, 18.11–18.12
 */

import type { RenderIntentV1 } from '../../../harness/contracts/render-intent';
import type { InsightBlockV1 } from '../../../harness/contracts/response-composition';

// ─── Public types ───────────────────────────────────────────────

/**
 * Chart prerequisite check result — all must be true for chart rendering.
 */
export interface ChartPrerequisites {
  readonly hasValues: boolean;
  readonly hasUnits: boolean;
  readonly hasTimeRange: boolean;
  readonly hasAccessibleSummary: boolean;
  readonly hasNonvisualAlternative: boolean;
  readonly allMet: boolean;
}

export interface InsightMetricDisplay {
  readonly metricId: string;
  readonly label: string;
  readonly value: number;
  readonly unit: string;
  readonly formattedValue: string;
  /** Shape indicator for non-color representation. */
  readonly shapeIndicator: string;
}

export interface InsightSurfaceHandle {
  readonly element: HTMLElement;
  readonly chartEnabled: boolean;
  readonly prerequisites: ChartPrerequisites;
  readonly sourceRevision: number;
  readonly metricCount: number;
  dispose(): void;
}

export interface InsightSurfaceOptions {
  /** Optional theme hint for styling. */
  readonly theme?: 'light' | 'dark';
  /** Optional scale factor for metric values display. */
  readonly scaleFactor?: number;
}

// ─── Constants ──────────────────────────────────────────────────

/**
 * Shape indicators used alongside color to represent metric magnitude.
 * Requirement 18.11: status, risk, confidence, diff meaning, selection,
 * progress, and errors SHALL use text or shape in addition to color.
 */
const METRIC_SHAPE_INDICATORS: readonly string[] = [
  '\u25CF', // ● filled circle
  '\u25A0', // ■ filled square
  '\u25B2', // ▲ filled triangle
  '\u25C6', // ◆ filled diamond
  '\u2605', // ★ star
  '\u2B22', // ⬢ hexagon
  '\u25CE', // ◎ bullseye
  '\u25AC', // ▬ bar
];

const MAX_METRIC_LABEL_LENGTH = 256;
const MAX_UNIT_LENGTH = 128;

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Validates all chart prerequisites for the given insight block content.
 */
export function evaluateChartPrerequisites(
  content: InsightBlockV1['content'],
): ChartPrerequisites {
  const hasValues = content.metrics.length > 0 &&
    content.metrics.every((m) => typeof m.value === 'number' && isFinite(m.value));

  const hasUnits = content.metrics.length > 0 &&
    content.metrics.every(
      (m) => typeof m.unit === 'string' && m.unit.trim().length > 0,
    );

  const hasTimeRange =
    typeof content.timeRange === 'string' && content.timeRange.trim().length > 0;

  const hasAccessibleSummary =
    typeof content.accessibleSummary === 'string' &&
    content.accessibleSummary.trim().length > 0;

  // Nonvisual alternative is derived from having all values labeled with units
  // and a comprehensive accessible summary that describes the data.
  const hasNonvisualAlternative = hasValues && hasUnits && hasAccessibleSummary;

  const allMet =
    hasValues && hasUnits && hasTimeRange && hasAccessibleSummary && hasNonvisualAlternative;

  return {
    hasValues,
    hasUnits,
    hasTimeRange,
    hasAccessibleSummary,
    hasNonvisualAlternative,
    allMet,
  };
}

/**
 * Bound text to a maximum length with ellipsis.
 */
function boundText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '\u2026';
}

/**
 * Format a numeric value with appropriate precision.
 */
export function formatMetricValue(value: number, unit: string, scaleFactor?: number): string {
  const scaled = scaleFactor ? value * scaleFactor : value;

  if (unit === 'ratio' || unit === 'percent' || unit === '%') {
    return `${(scaled * 100).toFixed(1)}%`;
  }
  if (unit === 'ms') {
    if (scaled >= 1000) return `${(scaled / 1000).toFixed(2)}s`;
    return `${scaled.toFixed(0)}ms`;
  }
  if (unit === 'tokens' || unit === 'count') {
    if (scaled >= 1_000_000) return `${(scaled / 1_000_000).toFixed(1)}M`;
    if (scaled >= 1_000) return `${(scaled / 1_000).toFixed(1)}K`;
    return `${Math.round(scaled)}`;
  }
  if (unit === 'tokens/s') {
    return `${scaled.toFixed(1)} tok/s`;
  }
  if (Number.isInteger(scaled)) return `${scaled}`;
  return `${scaled.toFixed(2)}`;
}

/**
 * Get the shape indicator for a metric at a given index.
 */
function getShapeIndicator(index: number): string {
  return METRIC_SHAPE_INDICATORS[index % METRIC_SHAPE_INDICATORS.length];
}

/**
 * Build display models for all metrics.
 */
export function buildMetricDisplays(
  metrics: InsightBlockV1['content']['metrics'],
  scaleFactor?: number,
): InsightMetricDisplay[] {
  return metrics.map((m, i) => ({
    metricId: m.metricId,
    label: boundText(m.label, MAX_METRIC_LABEL_LENGTH),
    value: m.value,
    unit: boundText(m.unit, MAX_UNIT_LENGTH),
    formattedValue: formatMetricValue(m.value, m.unit, scaleFactor),
    shapeIndicator: getShapeIndicator(i),
  }));
}

/**
 * Generate a text-based nonvisual alternative describing all metrics.
 */
function generateNonvisualAlternative(
  metrics: InsightMetricDisplay[],
  timeRange: string | undefined,
): string {
  const lines: string[] = [];
  for (const m of metrics) {
    lines.push(`${m.label}: ${m.formattedValue} (${m.unit})`);
  }
  if (timeRange) {
    lines.push(`Time range: ${timeRange}`);
  }
  return lines.join('. ');
}

// ─── DOM creation ───────────────────────────────────────────────

function createInsightHeader(title: string): HTMLElement {
  const header = document.createElement('div');
  header.className = 'nn-insight__header';
  header.setAttribute('role', 'heading');
  header.setAttribute('aria-level', '3');

  const icon = document.createElement('span');
  icon.className = 'nn-insight__icon';
  icon.textContent = '\u{1F4CA}'; // 📊
  icon.setAttribute('aria-hidden', 'true');
  header.appendChild(icon);

  const titleEl = document.createElement('span');
  titleEl.className = 'nn-insight__title';
  titleEl.textContent = boundText(title, 512);
  header.appendChild(titleEl);

  return header;
}

function createSourceRevisionBadge(sourceRevision: number): HTMLElement {
  const badge = document.createElement('span');
  badge.className = 'nn-insight__source-revision';
  badge.textContent = `rev ${sourceRevision}`;
  badge.setAttribute('aria-label', `Source revision: ${sourceRevision}`);
  badge.dataset.sourceRevision = String(sourceRevision);
  return badge;
}

function createMetricCard(metric: InsightMetricDisplay): HTMLElement {
  const card = document.createElement('div');
  card.className = 'nn-insight__metric-card';
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', `${metric.label}: ${metric.formattedValue} ${metric.unit}`);
  card.dataset.metricId = metric.metricId;

  // Shape indicator — visible non-color indicator
  const shape = document.createElement('span');
  shape.className = 'nn-insight__metric-shape';
  shape.textContent = metric.shapeIndicator;
  shape.setAttribute('aria-hidden', 'true');
  card.appendChild(shape);

  // Label
  const label = document.createElement('span');
  label.className = 'nn-insight__metric-label';
  label.textContent = metric.label;
  card.appendChild(label);

  // Value
  const value = document.createElement('span');
  value.className = 'nn-insight__metric-value';
  value.textContent = metric.formattedValue;
  card.appendChild(value);

  // Unit
  const unit = document.createElement('span');
  unit.className = 'nn-insight__metric-unit';
  unit.textContent = metric.unit;
  card.appendChild(unit);

  return card;
}

function createMetricsGrid(metrics: InsightMetricDisplay[]): HTMLElement {
  const grid = document.createElement('div');
  grid.className = 'nn-insight__metrics-grid';
  grid.setAttribute('role', 'list');
  grid.setAttribute('aria-label', 'Metrics');

  for (const metric of metrics) {
    const item = document.createElement('div');
    item.setAttribute('role', 'listitem');
    item.appendChild(createMetricCard(metric));
    grid.appendChild(item);
  }

  return grid;
}

function createTimeRangeBadge(timeRange: string): HTMLElement {
  const badge = document.createElement('span');
  badge.className = 'nn-insight__time-range';
  badge.textContent = timeRange;
  badge.setAttribute('aria-label', `Time range: ${timeRange}`);
  return badge;
}

function createChartContainer(
  metrics: InsightMetricDisplay[],
  accessibleSummary: string,
  nonvisualAlt: string,
): HTMLElement {
  const container = document.createElement('div');
  container.className = 'nn-insight__chart-container';
  container.setAttribute('role', 'img');
  container.setAttribute('aria-label', accessibleSummary);

  // Simple bar chart using shapes (no canvas/svg needed for headless)
  // Uses proportional bar widths with shape-based visual
  const maxValue = Math.max(...metrics.map((m) => Math.abs(m.value)), 1);

  const chart = document.createElement('div');
  chart.className = 'nn-insight__chart-bars';

  for (const metric of metrics) {
    const bar = document.createElement('div');
    bar.className = 'nn-insight__chart-bar';
    const ratio = Math.abs(metric.value) / maxValue;
    bar.style.setProperty('--bar-ratio', String(ratio));
    bar.dataset.metricId = metric.metricId;

    // Shape marker for non-color differentiation
    const shape = document.createElement('span');
    shape.className = 'nn-insight__chart-bar-shape';
    shape.textContent = metric.shapeIndicator;
    shape.setAttribute('aria-hidden', 'true');
    bar.appendChild(shape);

    // Visual bar fill with pattern indicator
    const fill = document.createElement('span');
    fill.className = 'nn-insight__chart-bar-fill';
    fill.style.width = `${Math.round(ratio * 100)}%`;
    bar.appendChild(fill);

    // Inline value label
    const label = document.createElement('span');
    label.className = 'nn-insight__chart-bar-label';
    label.textContent = `${metric.label}: ${metric.formattedValue}`;
    bar.appendChild(label);

    chart.appendChild(bar);
  }

  container.appendChild(chart);

  // Hidden nonvisual alternative for screen readers
  const altText = document.createElement('div');
  altText.className = 'nn-insight__nonvisual-alt';
  altText.textContent = nonvisualAlt;
  altText.setAttribute('aria-hidden', 'false');
  // visually hidden but accessible to screen readers
  altText.style.position = 'absolute';
  altText.style.width = '1px';
  altText.style.height = '1px';
  altText.style.overflow = 'hidden';
  altText.style.clip = 'rect(0, 0, 0, 0)';
  container.appendChild(altText);

  return container;
}

function createFallbackNotice(prerequisites: ChartPrerequisites): HTMLElement {
  const notice = document.createElement('div');
  notice.className = 'nn-insight__fallback-notice';
  notice.setAttribute('role', 'note');

  const missing: string[] = [];
  if (!prerequisites.hasValues) missing.push('values');
  if (!prerequisites.hasUnits) missing.push('units');
  if (!prerequisites.hasTimeRange) missing.push('time range');
  if (!prerequisites.hasAccessibleSummary) missing.push('accessible summary');
  if (!prerequisites.hasNonvisualAlternative) missing.push('nonvisual alternative');

  notice.textContent = `Chart unavailable: missing ${missing.join(', ')}`;
  notice.setAttribute('aria-label', `Chart not displayed because: ${missing.join(', ')} not available`);

  return notice;
}

function createAccessibleSummary(summary: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'nn-insight__accessible-summary';
  el.setAttribute('role', 'note');
  el.textContent = summary;
  return el;
}

// ─── Main render function ───────────────────────────────────────

/**
 * Render an InsightSurface from an InsightBlockV1.
 *
 * Evaluates chart prerequisites and renders chart only when ALL are met.
 * Always exposes underlying values in accessible metric cards.
 */
export function renderInsightSurface(
  block: InsightBlockV1,
  options: InsightSurfaceOptions = {},
): InsightSurfaceHandle {
  let disposed = false;
  const { content } = block;
  const prerequisites = evaluateChartPrerequisites(content);
  const metricDisplays = buildMetricDisplays(content.metrics, options.scaleFactor);

  const root = document.createElement('article');
  root.className = 'nn-insight';
  root.setAttribute('role', 'article');
  root.setAttribute(
    'aria-label',
    `Insight: ${boundText(content.title, 256)}`,
  );
  root.dataset.stableKey = block.stableKey;
  root.dataset.insightId = content.insightId;

  if (options.theme) {
    root.dataset.theme = options.theme;
  }

  // Header with title
  root.appendChild(createInsightHeader(content.title));

  // Source revision badge (provenance)
  root.appendChild(createSourceRevisionBadge(content.sourceRevision));

  // Time range if present
  if (content.timeRange && content.timeRange.trim().length > 0) {
    root.appendChild(createTimeRangeBadge(content.timeRange));
  }

  // Accessible summary
  if (content.accessibleSummary && content.accessibleSummary.trim().length > 0) {
    root.appendChild(createAccessibleSummary(content.accessibleSummary));
  }

  // Metric cards — ALWAYS rendered regardless of chart state
  if (metricDisplays.length > 0) {
    root.appendChild(createMetricsGrid(metricDisplays));
  }

  // Chart section — only when ALL prerequisites are met
  if (prerequisites.allMet) {
    const nonvisualAlt = generateNonvisualAlternative(
      metricDisplays,
      content.timeRange ?? undefined,
    );
    root.appendChild(
      createChartContainer(metricDisplays, content.accessibleSummary, nonvisualAlt),
    );
  } else {
    // Fall back to non-chart notice explaining why chart isn't shown
    root.appendChild(createFallbackNotice(prerequisites));
  }

  return {
    element: root,
    chartEnabled: prerequisites.allMet,
    prerequisites,
    sourceRevision: content.sourceRevision,
    metricCount: metricDisplays.length,
    dispose() {
      if (disposed) return;
      disposed = true;
      root.remove();
    },
  };
}

// ─── Update function ────────────────────────────────────────────

/**
 * Update an InsightSurface with new block data.
 * Disposes the previous handle and re-renders.
 */
export function updateInsightSurface(
  handle: InsightSurfaceHandle,
  block: InsightBlockV1,
  options: InsightSurfaceOptions = {},
): InsightSurfaceHandle {
  const parent = handle.element.parentNode;
  const existingElement = handle.element;

  handle.dispose();
  const newHandle = renderInsightSurface(block, options);

  if (parent && parent.contains(existingElement)) {
    parent.replaceChild(newHandle.element, existingElement);
  } else if (parent) {
    parent.appendChild(newHandle.element);
  }

  return newHandle;
}

// ─── Surface Adapter ────────────────────────────────────────────

/**
 * Closed surface adapter conforming to ResponseSurfaceAdapter interface.
 */
export const InsightSurface = Object.freeze({
  kind: 'insight' as const,

  render(
    block: InsightBlockV1,
    context: Record<string, unknown>,
    _options: { refinement?: RenderIntentV1 },
  ): InsightSurfaceHandle {
    return renderInsightSurface(block, {
      theme: context['theme'] as InsightSurfaceOptions['theme'],
      scaleFactor: context['scaleFactor'] as InsightSurfaceOptions['scaleFactor'],
    });
  },

  update(
    handle: object,
    _previous: InsightBlockV1,
    next: InsightBlockV1,
    context: Record<string, unknown>,
    _options: { refinement?: RenderIntentV1 },
  ): void {
    const surfaceHandle = handle as InsightSurfaceHandle;
    updateInsightSurface(surfaceHandle, next, {
      theme: context['theme'] as InsightSurfaceOptions['theme'],
      scaleFactor: context['scaleFactor'] as InsightSurfaceOptions['scaleFactor'],
    });
  },

  dispose(handle: object): void {
    const surfaceHandle = handle as InsightSurfaceHandle;
    surfaceHandle.dispose();
  },
});
