/**
 * Dependency Graph component for the Spec Viewer Panel.
 *
 * Renders the task dependency graph as an interactive node graph visualization.
 * Nodes represent tasks, edges represent dependencies, and execution waves are
 * visually grouped.
 *
 * Requirements: 23.16
 */

// ─── Types ──────────────────────────────────────────────────────

/** A single wave in the dependency graph containing tasks that can run in parallel. */
export interface WaveData {
  id: number;
  tasks: string[];
}

/** Parsed dependency graph structure from tasks.md. */
export interface DependencyGraphData {
  waves: WaveData[];
}

/** Node position in the rendered graph. */
interface NodePosition {
  x: number;
  y: number;
  taskId: string;
  wave: number;
}

/** Edge between two nodes. */
interface Edge {
  from: string;
  to: string;
}

// ─── CSS Classes ────────────────────────────────────────────────

const CSS = {
  graph: 'nn-dep-graph',
  graphHeader: 'nn-dep-graph__header',
  graphTitle: 'nn-dep-graph__title',
  graphCanvas: 'nn-dep-graph__canvas',
  graphSvg: 'nn-dep-graph__svg',
  waveGroup: 'nn-dep-graph__wave',
  waveLabel: 'nn-dep-graph__wave-label',
  node: 'nn-dep-graph__node',
  nodeCircle: 'nn-dep-graph__node-circle',
  nodeLabel: 'nn-dep-graph__node-label',
  edge: 'nn-dep-graph__edge',
  legend: 'nn-dep-graph__legend',
  legendItem: 'nn-dep-graph__legend-item',
  legendDot: 'nn-dep-graph__legend-dot',
} as const;

// ─── Styles ─────────────────────────────────────────────────────

/** Inject scoped styles for the dependency graph. */
export function injectDependencyGraphStyles(): void {
  if (document.getElementById('nn-dep-graph-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-dep-graph-styles';
  style.textContent = `
    .${CSS.graph} {
      border: 1px solid var(--border, #334155);
      border-radius: 8px;
      background: var(--bg-secondary, #1e293b);
      overflow: hidden;
    }
    .${CSS.graphHeader} {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border, #334155);
    }
    .${CSS.graphTitle} {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary, #e2e8f0);
    }
    .${CSS.graphCanvas} {
      padding: 16px;
      overflow-x: auto;
      overflow-y: auto;
      max-height: 500px;
    }
    .${CSS.graphSvg} {
      display: block;
    }
    .${CSS.waveGroup} {
      opacity: 1;
    }
    .${CSS.waveLabel} {
      font-size: 11px;
      font-weight: 600;
      fill: var(--text-secondary, #94a3b8);
      text-anchor: middle;
    }
    .${CSS.node} {
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .${CSS.node}:hover {
      opacity: 0.8;
    }
    .${CSS.nodeCircle} {
      stroke-width: 2;
      transition: fill 0.15s, stroke 0.15s;
    }
    .${CSS.nodeLabel} {
      font-size: 10px;
      fill: var(--text-primary, #e2e8f0);
      text-anchor: middle;
      dominant-baseline: central;
      pointer-events: none;
    }
    .${CSS.edge} {
      fill: none;
      stroke: var(--border, #475569);
      stroke-width: 1.5;
      opacity: 0.6;
      marker-end: url(#arrowhead);
    }
    .${CSS.legend} {
      display: flex;
      gap: 16px;
      padding: 8px 16px;
      border-top: 1px solid var(--border, #334155);
      background: var(--bg-tertiary, #0f172a);
    }
    .${CSS.legendItem} {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--text-secondary, #94a3b8);
    }
    .${CSS.legendDot} {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
  `;
  document.head.appendChild(style);
}

// ─── Helpers ────────────────────────────────────────────────────

/** Wave-based color palette for distinguishing execution waves. */
const WAVE_COLORS = [
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
  '#84cc16', // lime
  '#a855f7', // purple
];

/** Get color for a wave index. */
function getWaveColor(waveIndex: number): string {
  return WAVE_COLORS[waveIndex % WAVE_COLORS.length];
}

// ─── Layout Calculations ────────────────────────────────────────

/** Node dimensions and spacing constants. */
const NODE_RADIUS = 18;
const NODE_SPACING_X = 70;
const NODE_SPACING_Y = 55;
const WAVE_LABEL_HEIGHT = 25;
const PADDING_TOP = 40;
const PADDING_LEFT = 50;

/**
 * Calculate node positions for the dependency graph layout.
 * Nodes are arranged in columns by wave, with tasks stacked vertically within each wave.
 */
function calculateLayout(graphData: DependencyGraphData): {
  positions: NodePosition[];
  width: number;
  height: number;
} {
  const positions: NodePosition[] = [];

  let maxY = 0;

  for (let waveIndex = 0; waveIndex < graphData.waves.length; waveIndex++) {
    const wave = graphData.waves[waveIndex];
    const x = PADDING_LEFT + waveIndex * NODE_SPACING_X;

    for (let taskIndex = 0; taskIndex < wave.tasks.length; taskIndex++) {
      const y = PADDING_TOP + WAVE_LABEL_HEIGHT + taskIndex * NODE_SPACING_Y;
      positions.push({
        x,
        y,
        taskId: wave.tasks[taskIndex],
        wave: waveIndex,
      });
      maxY = Math.max(maxY, y);
    }
  }

  const width = PADDING_LEFT + graphData.waves.length * NODE_SPACING_X + PADDING_LEFT;
  const height = maxY + NODE_RADIUS + 40;

  return { positions, width, height };
}

/**
 * Compute edges between consecutive waves.
 * Each task in wave N connects to all tasks in wave N+1 (simplified fan-out).
 */
function calculateEdges(graphData: DependencyGraphData): Edge[] {
  const edges: Edge[] = [];

  for (let waveIndex = 0; waveIndex < graphData.waves.length - 1; waveIndex++) {
    const currentWave = graphData.waves[waveIndex];
    const nextWave = graphData.waves[waveIndex + 1];

    // Connect each task in current wave to each task in next wave
    // For a simplified view, connect only one representative edge per wave transition
    if (currentWave.tasks.length > 0 && nextWave.tasks.length > 0) {
      // Connect last task of current wave to first task of next wave for clarity
      edges.push({
        from: currentWave.tasks[currentWave.tasks.length - 1],
        to: nextWave.tasks[0],
      });
      // Also connect first of current to first of next if more than one task
      if (currentWave.tasks.length > 1) {
        edges.push({
          from: currentWave.tasks[0],
          to: nextWave.tasks[0],
        });
      }
    }
  }

  return edges;
}

// ─── SVG Rendering ──────────────────────────────────────────────

/** Create an SVG element with namespace. */
function createSvgElement(tag: string): SVGElement {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

/**
 * Render the dependency graph as an SVG element.
 */
function renderSvgGraph(graphData: DependencyGraphData): SVGElement {
  const { positions, width, height } = calculateLayout(graphData);
  const edges = calculateEdges(graphData);

  const svg = createSvgElement('svg') as SVGSVGElement;
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.classList.add(CSS.graphSvg);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Task dependency graph showing execution waves');

  // Defs: arrowhead marker
  const defs = createSvgElement('defs');
  const marker = createSvgElement('marker');
  marker.setAttribute('id', 'arrowhead');
  marker.setAttribute('markerWidth', '8');
  marker.setAttribute('markerHeight', '6');
  marker.setAttribute('refX', '8');
  marker.setAttribute('refY', '3');
  marker.setAttribute('orient', 'auto');
  const arrowPath = createSvgElement('path');
  arrowPath.setAttribute('d', 'M 0 0 L 8 3 L 0 6 Z');
  arrowPath.setAttribute('fill', '#475569');
  marker.appendChild(arrowPath);
  defs.appendChild(marker);
  svg.appendChild(defs);

  // Build position lookup
  const posMap = new Map<string, NodePosition>();
  for (const pos of positions) {
    posMap.set(pos.taskId, pos);
  }

  // Render edges
  for (const edge of edges) {
    const from = posMap.get(edge.from);
    const to = posMap.get(edge.to);
    if (from && to) {
      const line = createSvgElement('line');
      line.setAttribute('x1', String(from.x + NODE_RADIUS));
      line.setAttribute('y1', String(from.y));
      line.setAttribute('x2', String(to.x - NODE_RADIUS));
      line.setAttribute('y2', String(to.y));
      line.classList.add(CSS.edge);
      svg.appendChild(line);
    }
  }

  // Render wave labels
  for (let waveIndex = 0; waveIndex < graphData.waves.length; waveIndex++) {
    const x = PADDING_LEFT + waveIndex * NODE_SPACING_X;
    const label = createSvgElement('text');
    label.setAttribute('x', String(x));
    label.setAttribute('y', String(PADDING_TOP - 10));
    label.classList.add(CSS.waveLabel);
    label.textContent = `Wave ${waveIndex}`;
    svg.appendChild(label);
  }

  // Render nodes
  for (const pos of positions) {
    const group = createSvgElement('g');
    group.classList.add(CSS.node);
    group.setAttribute('data-task-id', pos.taskId);

    const circle = createSvgElement('circle');
    circle.setAttribute('cx', String(pos.x));
    circle.setAttribute('cy', String(pos.y));
    circle.setAttribute('r', String(NODE_RADIUS));
    circle.classList.add(CSS.nodeCircle);
    circle.setAttribute('fill', getWaveColor(pos.wave));
    circle.setAttribute('stroke', getWaveColor(pos.wave));
    circle.setAttribute('fill-opacity', '0.2');
    group.appendChild(circle);

    const text = createSvgElement('text');
    text.setAttribute('x', String(pos.x));
    text.setAttribute('y', String(pos.y));
    text.classList.add(CSS.nodeLabel);
    text.textContent = pos.taskId;
    group.appendChild(text);

    // Tooltip title
    const titleEl = createSvgElement('title');
    titleEl.textContent = `Task ${pos.taskId} (Wave ${pos.wave})`;
    group.appendChild(titleEl);

    svg.appendChild(group);
  }

  return svg;
}

// ─── Component ──────────────────────────────────────────────────

/**
 * Render the complete dependency graph visualization.
 */
export function renderDependencyGraph(graphData: DependencyGraphData): HTMLElement {
  injectDependencyGraphStyles();

  const container = document.createElement('div');
  container.className = CSS.graph;
  container.setAttribute('role', 'figure');
  container.setAttribute('aria-label', 'Task dependency graph');

  // Header
  const header = document.createElement('div');
  header.className = CSS.graphHeader;

  const title = document.createElement('h3');
  title.className = CSS.graphTitle;
  title.textContent = 'Task Dependency Graph';
  header.appendChild(title);

  container.appendChild(header);

  // Graph canvas with SVG
  const canvas = document.createElement('div');
  canvas.className = CSS.graphCanvas;

  if (graphData.waves.length > 0) {
    const svg = renderSvgGraph(graphData);
    canvas.appendChild(svg);
  } else {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding: 32px; text-align: center; color: var(--text-secondary, #94a3b8); font-size: 12px;';
    empty.textContent = 'No dependency graph data available.';
    canvas.appendChild(empty);
  }

  container.appendChild(canvas);

  // Legend
  const legend = document.createElement('div');
  legend.className = CSS.legend;
  legend.setAttribute('role', 'legend');
  legend.setAttribute('aria-label', 'Graph legend');

  const maxLegendWaves = Math.min(graphData.waves.length, 5);
  for (let i = 0; i < maxLegendWaves; i++) {
    const item = document.createElement('div');
    item.className = CSS.legendItem;

    const dot = document.createElement('span');
    dot.className = CSS.legendDot;
    dot.style.backgroundColor = getWaveColor(i);
    item.appendChild(dot);

    const label = document.createElement('span');
    label.textContent = `Wave ${i}`;
    item.appendChild(label);

    legend.appendChild(item);
  }

  if (graphData.waves.length > 5) {
    const moreItem = document.createElement('div');
    moreItem.className = CSS.legendItem;
    moreItem.textContent = `+${graphData.waves.length - 5} more`;
    legend.appendChild(moreItem);
  }

  container.appendChild(legend);

  return container;
}

/**
 * Parse the dependency graph JSON from a tasks.md file.
 * Looks for the ```json block under "## Task Dependency Graph" heading.
 */
export function parseDependencyGraph(markdown: string): DependencyGraphData {
  const graphSection = markdown.match(
    /## Task Dependency Graph\s*```json\s*([\s\S]*?)```/
  );

  if (!graphSection) {
    return { waves: [] };
  }

  try {
    const parsed = JSON.parse(graphSection[1].trim());
    if (parsed && Array.isArray(parsed.waves)) {
      return {
        waves: parsed.waves.map((wave: { id?: number; tasks?: string[] }, index: number) => ({
          id: wave.id ?? index,
          tasks: Array.isArray(wave.tasks) ? wave.tasks : [],
        })),
      };
    }
    return { waves: [] };
  } catch {
    return { waves: [] };
  }
}
