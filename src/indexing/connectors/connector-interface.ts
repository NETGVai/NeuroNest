/**
 * Connector Interface
 *
 * Defines the standard contract for multi-source connectors that ingest
 * non-source-code data (Git history, Markdown, PDF) into the Knowledge Graph.
 *
 * All connectors implement this interface with methods for initialization,
 * ingestion, and node retrieval.
 */

/**
 * Represents a node produced by a connector for inclusion in the Knowledge Graph.
 */
export interface ConnectorNode {
  id: string;
  label: string;
  type: 'commit' | 'author' | 'section' | 'heading';
  content: string;
  metadata: Record<string, string>;
}

/**
 * Represents an edge (relationship) between two connector nodes.
 */
export interface ConnectorEdge {
  source: string;
  target: string;
  relation: string;
}

/**
 * Standard contract that all connectors must implement.
 *
 * Connectors are pluggable modules that ingest non-source-code data
 * into the Knowledge Graph. Each connector handles a specific data source
 * (e.g., Git history, Markdown documentation).
 */
export interface Connector {
  /** Human-readable name identifying this connector */
  name: string;

  /** Initialize the connector with a project path and configuration */
  initialize(projectPath: string, config: Record<string, any>): Promise<void>;

  /** Ingest data from the source and return nodes and edges */
  ingest(): Promise<{ nodes: ConnectorNode[]; edges: ConnectorEdge[] }>;

  /** Return all nodes currently held by this connector */
  getNodes(): ConnectorNode[];
}
