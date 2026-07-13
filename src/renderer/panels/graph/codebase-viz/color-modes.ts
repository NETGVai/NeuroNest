/**
 * Color modes module for codebase visualization.
 *
 * Provides coloring strategies that take graph data and return
 * Cytoscape.js style overrides (selector + style pairs) for nodes.
 *
 * Strategies:
 * - folder: Color by top-level directory (first path segment after src/)
 * - architecture-layer: Color by assigned architectural layer
 * - activity-heatmap: Gradient from commit frequency heatmap data
 * - blast-radius: Opacity-based styling from blast radius depth
 * - community: Color by community detection ID
 */

import type { ColorMode, CodebaseGraphData, CytoscapeNode } from './types';

// --- Types ---

/** A Cytoscape style override: a selector string paired with style properties. */
export interface CytoscapeStyleOverride {
  selector: string;
  style: Record<string, string | number>;
}

/** A color strategy function signature. */
export type ColorStrategy = (graphData: CodebaseGraphData) => CytoscapeStyleOverride[];

// --- Color palettes ---

/** Distinct colors for folder grouping (up to 12 distinct folders). */
const FOLDER_COLORS: string[] = [
  '#3b82f6', // blue
  '#ef4444', // red
  '#10b981', // emerald
  '#f59e0b', // amber
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#84cc16', // lime
  '#f97316', // orange
  '#6366f1', // indigo
  '#14b8a6', // teal
  '#a855f7', // purple
];

/** Predefined colors per architecture layer. */
const LAYER_COLORS: Record<string, string> = {
  UI: '#3b82f6',       // blue
  Services: '#10b981', // green
  Utils: '#6b7280',    // gray
  Data: '#8b5cf6',     // purple
  Config: '#f97316',   // orange
  Tests: '#eab308',    // yellow
};

/** Default/fallback color when no category can be determined. */
const DEFAULT_COLOR = '#6b7280';

// --- Strategy implementations ---

/**
 * Color nodes by their top-level directory (first path segment after src/).
 * Groups nodes by the first meaningful directory in their file path.
 */
export function folderStrategy(graphData: CodebaseGraphData): CytoscapeStyleOverride[] {
  const folderMap = new Map<string, string[]>();

  for (const node of graphData.nodes) {
    const folder = extractTopLevelFolder(node.data.filePath);
    if (!folderMap.has(folder)) {
      folderMap.set(folder, []);
    }
    folderMap.get(folder)!.push(node.data.id);
  }

  const overrides: CytoscapeStyleOverride[] = [];
  const folders = Array.from(folderMap.keys());

  for (let i = 0; i < folders.length; i++) {
    const folder = folders[i];
    const nodeIds = folderMap.get(folder)!;
    const color = FOLDER_COLORS[i % FOLDER_COLORS.length];

    for (const nodeId of nodeIds) {
      overrides.push({
        selector: `node[id="${nodeId}"]`,
        style: { 'background-color': color },
      });
    }
  }

  return overrides;
}

/**
 * Color nodes by their assigned architecture layer.
 * Uses the `layer` property on each node's data.
 */
export function architectureLayerStrategy(graphData: CodebaseGraphData): CytoscapeStyleOverride[] {
  const overrides: CytoscapeStyleOverride[] = [];

  for (const node of graphData.nodes) {
    const layer = node.data.layer;
    const color = layer ? (LAYER_COLORS[layer] ?? DEFAULT_COLOR) : DEFAULT_COLOR;

    overrides.push({
      selector: `node[id="${node.data.id}"]`,
      style: { 'background-color': color },
    });
  }

  return overrides;
}

/**
 * Color nodes by activity heatmap data (commit frequency).
 * Uses the `commitCount` and `percentile` properties from heatmap analysis,
 * or falls back to a neutral color for zero-commit files.
 */
export function activityHeatmapStrategy(graphData: CodebaseGraphData): CytoscapeStyleOverride[] {
  const overrides: CytoscapeStyleOverride[] = [];

  for (const node of graphData.nodes) {
    const color = getHeatmapColor(node);

    overrides.push({
      selector: `node[id="${node.data.id}"]`,
      style: { 'background-color': color },
    });
  }

  return overrides;
}

/**
 * Apply opacity-based styling from blast radius depth data.
 * Nodes with blastRadiusDepth = 1 get full opacity,
 * deeper nodes get proportionally reduced opacity, minimum 0.3.
 * Nodes not in the blast radius are dimmed to 0.15 opacity.
 */
export function blastRadiusStrategy(graphData: CodebaseGraphData): CytoscapeStyleOverride[] {
  const overrides: CytoscapeStyleOverride[] = [];

  for (const node of graphData.nodes) {
    const depth = node.data.blastRadiusDepth;

    if (depth != null && depth >= 0) {
      // Source node (depth 0) or direct dependents (depth 1) at full opacity
      const opacity = depth === 0 ? 1.0 : node.data.opacity ?? computeBlastOpacity(depth);
      overrides.push({
        selector: `node[id="${node.data.id}"]`,
        style: { opacity },
      });
    } else {
      // Not part of blast radius — dim significantly
      overrides.push({
        selector: `node[id="${node.data.id}"]`,
        style: { opacity: 0.15 },
      });
    }
  }

  return overrides;
}

/**
 * Color nodes by their community detection ID.
 * Uses the `community` property on each node's data to assign distinct colors.
 */
export function communityStrategy(graphData: CodebaseGraphData): CytoscapeStyleOverride[] {
  // Collect unique community IDs to assign colors
  const communityIds = new Set<number>();
  for (const node of graphData.nodes) {
    if (node.data.community != null) {
      communityIds.add(node.data.community);
    }
  }

  const sortedIds = Array.from(communityIds).sort((a, b) => a - b);
  const communityColorMap = new Map<number, string>();
  for (let i = 0; i < sortedIds.length; i++) {
    communityColorMap.set(sortedIds[i], FOLDER_COLORS[i % FOLDER_COLORS.length]);
  }

  const overrides: CytoscapeStyleOverride[] = [];

  for (const node of graphData.nodes) {
    const communityId = node.data.community;
    const color = communityId != null
      ? (communityColorMap.get(communityId) ?? DEFAULT_COLOR)
      : DEFAULT_COLOR;

    overrides.push({
      selector: `node[id="${node.data.id}"]`,
      style: { 'background-color': color },
    });
  }

  return overrides;
}

// --- Strategy registry ---

/** Map of color mode to its strategy function. */
const STRATEGY_MAP: Record<ColorMode, ColorStrategy> = {
  folder: folderStrategy,
  'architecture-layer': architectureLayerStrategy,
  'activity-heatmap': activityHeatmapStrategy,
  'blast-radius': blastRadiusStrategy,
  community: communityStrategy,
};

/**
 * Get the coloring strategy function for a given color mode.
 * @param mode - The color mode to retrieve a strategy for.
 * @returns The color strategy function for the given mode.
 */
export function getColorModeStrategy(mode: ColorMode): ColorStrategy {
  const strategy = STRATEGY_MAP[mode];
  if (!strategy) {
    throw new Error(`Unknown color mode: ${mode}`);
  }
  return strategy;
}

// --- Helper functions ---

/**
 * Extract the top-level folder from a file path.
 * Finds the first meaningful directory segment after common root markers (src/, lib/, app/).
 */
function extractTopLevelFolder(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);

  // Find the index of src/, lib/, or app/ and return the next segment
  const rootMarkers = ['src', 'lib', 'app', 'packages'];
  for (let i = 0; i < segments.length; i++) {
    if (rootMarkers.includes(segments[i].toLowerCase()) && i + 1 < segments.length) {
      return segments[i + 1];
    }
  }

  // Fallback: use the first segment that isn't a common root marker
  for (const segment of segments) {
    if (!rootMarkers.includes(segment.toLowerCase()) && segment !== '.' && segment !== '..') {
      return segment;
    }
  }

  return 'root';
}

/**
 * Determine heatmap color for a node based on its commit activity data.
 * - Zero commits or no data → neutral gray
 * - Uses percentile from node data to map to gradient
 */
function getHeatmapColor(node: CytoscapeNode): string {
  const { commitCount, percentile } = node.data;

  // Zero commits or missing data → neutral gray
  if (commitCount == null || commitCount === 0 || percentile == null) {
    return '#6b7280';
  }

  return percentileToColor(percentile);
}

/**
 * Map a percentile value (0-100) to a heatmap color.
 * - Top 20% (80-100): warm colors (red → orange)
 * - Middle 60% (20-80): intermediate (yellow → green)
 * - Bottom 20% (0-20): cool colors (teal → blue)
 */
function percentileToColor(percentile: number): string {
  if (percentile >= 80) {
    // Warm: interpolate from orange (#f97316) to red (#ef4444)
    const t = (percentile - 80) / 20;
    return interpolateColor('#f97316', '#ef4444', t);
  } else if (percentile >= 20) {
    // Intermediate: interpolate from green (#10b981) to yellow (#eab308)
    const t = (percentile - 20) / 60;
    return interpolateColor('#10b981', '#eab308', t);
  } else {
    // Cool: interpolate from blue (#3b82f6) to teal (#14b8a6)
    const t = percentile / 20;
    return interpolateColor('#3b82f6', '#14b8a6', t);
  }
}

/**
 * Compute blast radius opacity from depth.
 * depth 1 = 1.0, deeper = linear decay to 0.3, minimum 0.3.
 */
function computeBlastOpacity(depth: number): number {
  if (depth <= 1) return 1.0;
  // Linear decay from 1.0 at depth 1 to 0.3 at depth 20
  const maxDepth = 20;
  const clampedDepth = Math.min(depth, maxDepth);
  return Math.max(0.3, 1.0 - ((clampedDepth - 1) * 0.7) / (maxDepth - 1));
}

/**
 * Linearly interpolate between two hex colors.
 */
function interpolateColor(colorA: string, colorB: string, t: number): string {
  const a = hexToRgb(colorA);
  const b = hexToRgb(colorB);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return rgbToHex(r, g, bl);
}

/** Parse a hex color string to RGB components. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.replace('#', '');
  return {
    r: parseInt(cleaned.slice(0, 2), 16),
    g: parseInt(cleaned.slice(2, 4), 16),
    b: parseInt(cleaned.slice(4, 6), 16),
  };
}

/** Convert RGB components to a hex color string. */
function rgbToHex(r: number, g: number, b: number): string {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}
