/**
 * Renderer-side type definitions for the codebase visualization module.
 * These types define Cytoscape element structures, color modes, and view modes
 * used by the dependency graph visualization.
 *
 * Note: ArchitectureLayer, EdgeConfidence, and RelationshipType are defined here
 * until the shared analysis types module (src/analysis/types.ts) is implemented,
 * at which point they should be imported from there.
 */

// --- Shared type aliases (to be imported from src/analysis/types.ts once task 1.1 lands) ---

/** Architectural layer classification for files. */
export type ArchitectureLayer = 'UI' | 'Services' | 'Utils' | 'Data' | 'Config' | 'Tests';

/** Confidence level for dependency edges. */
export type EdgeConfidence = 'EXTRACTED' | 'INFERRED';

/** Relationship type between two files in the dependency graph. */
export type RelationshipType =
  | 'imports'
  | 'calls'
  | 'inherits'
  | 'implements'
  | 'mixes_in'
  | 're_exports'
  | 'references';

// --- Cytoscape element types ---

/** A node element formatted for Cytoscape.js rendering. */
export interface CytoscapeNode {
  data: {
    id: string;
    label: string;
    filePath: string;
    layer?: ArchitectureLayer;
    community?: number;
    commitCount?: number;
    percentile?: number;
    degree?: number;
    isGodNode?: boolean;
    patternBadges?: string[];
    blastRadiusDepth?: number;
    opacity?: number;
  };
  classes?: string;
}

/** An edge element formatted for Cytoscape.js rendering. */
export interface CytoscapeEdge {
  data: {
    id: string;
    source: string;
    target: string;
    confidence: EdgeConfidence;
    relationshipType: RelationshipType;
    label?: string;
  };
  classes?: string; // 'extracted' | 'inferred'
}

/** Complete graph data ready for Cytoscape.js consumption. */
export interface CodebaseGraphData {
  nodes: CytoscapeNode[];
  edges: CytoscapeEdge[];
}

/** Available node coloring schemes for the dependency graph view. */
export type ColorMode =
  | 'folder'
  | 'architecture-layer'
  | 'activity-heatmap'
  | 'blast-radius'
  | 'community';

/** Top-level view modes available in the graph panel. */
export type ViewMode = 'knowledge-graph' | 'codebase-visualization';
