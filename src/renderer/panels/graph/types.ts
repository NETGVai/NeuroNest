/**
 * Graph panel types for the Cytoscape-based knowledge graph visualization.
 * These types define the data structures used by the graph core, controls, and service layers.
 */

/** Node type categories in the knowledge graph. */
export type GraphNodeType =
  | 'file'
  | 'function'
  | 'class'
  | 'variable'
  | 'import'
  | 'export'
  | 'component'
  | 'api-endpoint'
  | 'database-table'
  | 'test'
  | 'config';

/** Relationship types between graph nodes. */
export type GraphEdgeType =
  | 'calls'
  | 'imports'
  | 'extends'
  | 'implements'
  | 'uses'
  | 'defines'
  | 'tests'
  | 'configures';

/** A node in the knowledge graph. */
export interface GraphNode {
  id: string;
  label: string;
  type: GraphNodeType;
  filePath?: string;
  lineNumber?: number;
  metadata?: Record<string, unknown>;
}

/** An edge connecting two nodes in the knowledge graph. */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
  label?: string;
  weight?: number;
}

/** Complete graph data structure received from the main process. */
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata?: {
    projectId?: string;
    generatedAt?: string;
    nodeCount?: number;
    edgeCount?: number;
  };
}

/** Supported layout algorithms for the graph. */
export type GraphLayoutName =
  | 'cose'
  | 'cose-bilkent'
  | 'cola'
  | 'dagre'
  | 'euler'
  | 'fcose'
  | 'breadthfirst'
  | 'circle'
  | 'grid'
  | 'concentric'
  | 'random';

/** Configuration for a graph layout algorithm. */
export interface GraphLayout {
  name: GraphLayoutName;
  label: string;
  options?: Record<string, unknown>;
}

/** Filter types for showing/hiding graph nodes. */
export type GraphFilterType =
  | 'all'
  | 'god-nodes'
  | 'functions'
  | 'classes'
  | 'files'
  | 'components';

/** Graph panel state. */
export interface GraphPanelState {
  initialized: boolean;
  loading: boolean;
  graphData: GraphData | null;
  activeLayout: GraphLayoutName;
  activeFilter: GraphFilterType;
  searchTerm: string;
  error: string | null;
}

/** Graph statistics summary. */
export interface GraphStats {
  totalNodes: number;
  totalEdges: number;
  nodesByType: Record<string, number>;
  communities?: number;
  avgDegree?: number;
}

/** Result from a graph query operation. */
export interface GraphQueryResult {
  answer: string;
  relevantNodes: string[];
  tokensUsed?: number;
}

/** Export format for saving graph as image. */
export type GraphExportFormat = 'png' | 'svg' | 'jpeg';

/** Options for exporting the graph visualization. */
export interface GraphExportOptions {
  format: GraphExportFormat;
  scale?: number;
  background?: string;
  fullGraph?: boolean;
}
