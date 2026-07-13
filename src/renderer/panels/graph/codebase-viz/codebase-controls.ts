/**
 * Codebase visualization controls — state management module.
 *
 * Manages all toolbar and control state for the codebase visualization panel.
 * This is a pure state management module (no DOM rendering) providing:
 * - Color mode selection (folder, architecture-layer, activity-heatmap, blast-radius, community)
 * - Edge filter controls (confidence level, relationship type)
 * - Query search bar state for subgraph view
 * - Trace Path mode activation
 * - Blast Radius mode activation
 * - Force Re-analyze trigger state
 * - Architecture layer legend with click-to-filter
 * - Community legend with click-to-filter
 *
 * All state updates are immutable — functions return new state objects.
 */

import type { ColorMode, ArchitectureLayer, EdgeConfidence, RelationshipType } from './types';

// --- Types ---

/** Edge confidence filter options. */
export type EdgeConfidenceFilter = 'EXTRACTED' | 'INFERRED' | 'both';

/** Architecture layer legend entry displayed in the toolbar. */
export interface LayerLegendEntry {
  layer: ArchitectureLayer;
  color: string;
  nodeCount: number;
}

/** Community legend entry displayed in the toolbar. */
export interface CommunityLegendEntry {
  communityId: number;
  label: string;
  color: string;
  nodeCount: number;
}

/**
 * Complete controls state for the codebase visualization toolbar.
 * All fields are immutable; use the provided update functions.
 */
export interface ControlsState {
  /** Currently active node coloring scheme. */
  colorMode: ColorMode;

  /** Edge confidence filter: show EXTRACTED only, INFERRED only, or both. */
  edgeConfidenceFilter: EdgeConfidenceFilter;

  /** Active relationship type filter set. Empty set means show all types. */
  relationshipTypeFilter: Set<RelationshipType>;

  /** Current query string for the subgraph search bar. */
  query: string;

  /** Whether "Trace Path" mode is active (user selecting two nodes). */
  tracePathModeActive: boolean;

  /** Whether "Blast Radius" mode is active (user selecting a node for impact analysis). */
  blastRadiusModeActive: boolean;

  /** Whether a "Force Re-analyze" has been requested (resets after analysis starts). */
  forceReanalyzeRequested: boolean;

  /** Currently selected architecture layer filter (null = show all layers). */
  selectedLayerFilter: ArchitectureLayer | null;

  /** Currently selected community filter (null = show all communities). */
  selectedCommunityFilter: number | null;

  /** Architecture layer legend entries (populated after layer analysis). */
  layerLegend: LayerLegendEntry[];

  /** Community legend entries (populated after community detection). */
  communityLegend: CommunityLegendEntry[];
}

// --- All valid relationship types for reference ---

/** Complete set of valid relationship types. */
export const ALL_RELATIONSHIP_TYPES: readonly RelationshipType[] = [
  'imports',
  'calls',
  'inherits',
  'implements',
  'mixes_in',
  're_exports',
  'references',
] as const;

// --- Default state ---

/**
 * Returns the initial/default controls state.
 * - Color mode: folder (safest default, works without additional analysis)
 * - Edge confidence: both (show all edges)
 * - Relationship type filter: empty set (show all types)
 * - Query: empty string
 * - All modes inactive
 * - No legend filter active
 */
export function getDefaultState(): ControlsState {
  return {
    colorMode: 'folder',
    edgeConfidenceFilter: 'both',
    relationshipTypeFilter: new Set<RelationshipType>(),
    query: '',
    tracePathModeActive: false,
    blastRadiusModeActive: false,
    forceReanalyzeRequested: false,
    selectedLayerFilter: null,
    selectedCommunityFilter: null,
    layerLegend: [],
    communityLegend: [],
  };
}

// --- State update functions (immutable) ---

/**
 * Update the active color mode.
 * When switching to a non-layer mode, clears the layer filter.
 * When switching to a non-community mode, clears the community filter.
 */
export function setColorMode(state: ControlsState, mode: ColorMode): ControlsState {
  return {
    ...state,
    colorMode: mode,
    // Clear layer filter if switching away from architecture-layer mode
    selectedLayerFilter: mode === 'architecture-layer' ? state.selectedLayerFilter : null,
    // Clear community filter if switching away from community mode
    selectedCommunityFilter: mode === 'community' ? state.selectedCommunityFilter : null,
  };
}

/**
 * Update the edge confidence filter.
 * @param filter - 'EXTRACTED' to show only extracted edges, 'INFERRED' for inferred,
 *                 or 'both' to show all edges.
 */
export function setEdgeConfidenceFilter(
  state: ControlsState,
  filter: EdgeConfidenceFilter
): ControlsState {
  return {
    ...state,
    edgeConfidenceFilter: filter,
  };
}

/**
 * Update the relationship type filter set.
 * Pass an empty set to show all relationship types (no filter).
 * Pass a set of specific types to show only those.
 */
export function setRelationshipTypeFilter(
  state: ControlsState,
  types: Set<RelationshipType>
): ControlsState {
  return {
    ...state,
    relationshipTypeFilter: new Set(types),
  };
}

/**
 * Update the query search bar text.
 * An empty string clears the subgraph query and restores the full graph.
 */
export function setQuery(state: ControlsState, query: string): ControlsState {
  return {
    ...state,
    query,
  };
}

/**
 * Toggle "Trace Path" mode on/off.
 * Activating trace path mode deactivates blast radius mode (mutually exclusive).
 */
export function toggleTracePathMode(state: ControlsState): ControlsState {
  const newActive = !state.tracePathModeActive;
  return {
    ...state,
    tracePathModeActive: newActive,
    // Deactivate blast radius if enabling trace path
    blastRadiusModeActive: newActive ? false : state.blastRadiusModeActive,
  };
}

/**
 * Toggle "Blast Radius" mode on/off.
 * Activating blast radius mode deactivates trace path mode (mutually exclusive).
 */
export function toggleBlastRadiusMode(state: ControlsState): ControlsState {
  const newActive = !state.blastRadiusModeActive;
  return {
    ...state,
    blastRadiusModeActive: newActive,
    // Deactivate trace path if enabling blast radius
    tracePathModeActive: newActive ? false : state.tracePathModeActive,
  };
}

/**
 * Set or clear the "Force Re-analyze" request flag.
 * Typically set to true by a button click, then cleared by the analysis pipeline
 * once the analysis begins.
 */
export function setForceReanalyze(state: ControlsState, requested: boolean): ControlsState {
  return {
    ...state,
    forceReanalyzeRequested: requested,
  };
}

/**
 * Set or clear the selected architecture layer filter.
 * Clicking a layer in the legend sets the filter; clicking again (same layer) clears it.
 * Only meaningful when colorMode is 'architecture-layer'.
 *
 * @param layer - The layer to filter to, or null to clear the filter.
 */
export function setSelectedLayerFilter(
  state: ControlsState,
  layer: ArchitectureLayer | null
): ControlsState {
  // Toggle behavior: if the same layer is already selected, clear it
  const newFilter = state.selectedLayerFilter === layer ? null : layer;
  return {
    ...state,
    selectedLayerFilter: newFilter,
  };
}

/**
 * Set or clear the selected community filter.
 * Clicking a community in the legend sets the filter; clicking again clears it.
 * Only meaningful when colorMode is 'community'.
 *
 * @param communityId - The community ID to filter to, or null to clear.
 */
export function setSelectedCommunityFilter(
  state: ControlsState,
  communityId: number | null
): ControlsState {
  // Toggle behavior: if the same community is already selected, clear it
  const newFilter = state.selectedCommunityFilter === communityId ? null : communityId;
  return {
    ...state,
    selectedCommunityFilter: newFilter,
  };
}

/**
 * Update the architecture layer legend entries.
 * Called after layer classification completes.
 */
export function setLayerLegend(
  state: ControlsState,
  legend: LayerLegendEntry[]
): ControlsState {
  return {
    ...state,
    layerLegend: [...legend],
  };
}

/**
 * Update the community legend entries.
 * Called after community detection completes.
 */
export function setCommunityLegend(
  state: ControlsState,
  legend: CommunityLegendEntry[]
): ControlsState {
  return {
    ...state,
    communityLegend: [...legend],
  };
}
