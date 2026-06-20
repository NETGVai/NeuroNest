/**
 * Mermaid Generator — Converts diagram graph structures (nodes + edges) into
 * syntactically valid Mermaid diagram source code.
 *
 * Used by the Vision Analyzer to produce Mermaid representations of
 * recognized architecture diagrams and flowcharts.
 *
 * Requirements: 22.3
 */

export interface GraphNode {
  id: string;
  label: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}

export interface GraphStructure {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Sanitize a label for safe inclusion in Mermaid source.
 * Replaces characters that break Mermaid syntax.
 */
function sanitizeLabel(label: string): string {
  return label
    .replace(/"/g, "'")
    .replace(/[\[\](){}]/g, '')
    .replace(/-->/g, '->')
    .replace(/---/g, '--')
    .replace(/\n/g, ' ')
    .trim();
}

/**
 * Sanitize a node ID for valid Mermaid identifiers.
 * Mermaid node IDs should be alphanumeric with underscores.
 */
function sanitizeId(id: string): string {
  // Replace non-alphanumeric characters (except underscore) with underscore
  const sanitized = id.replace(/[^a-zA-Z0-9_]/g, '_');
  // Ensure it starts with a letter or underscore
  if (/^[0-9]/.test(sanitized)) {
    return `node_${sanitized}`;
  }
  return sanitized || 'node';
}

/**
 * Generate a Mermaid flowchart from a graph structure.
 *
 * @param graph - The graph with nodes and edges to convert
 * @param direction - Flow direction: TB (top-bottom), LR (left-right), etc.
 * @returns Syntactically valid Mermaid source string
 */
export function generateMermaidSource(
  graph: GraphStructure,
  direction: 'TB' | 'LR' | 'BT' | 'RL' = 'TB',
): string {
  const lines: string[] = [];

  lines.push(`graph ${direction}`);

  // Emit node declarations with labels
  for (const node of graph.nodes) {
    const safeId = sanitizeId(node.id);
    const safeLabel = sanitizeLabel(node.label);
    if (safeLabel && safeLabel !== safeId) {
      lines.push(`    ${safeId}["${safeLabel}"]`);
    } else {
      lines.push(`    ${safeId}`);
    }
  }

  // Emit edges
  for (const edge of graph.edges) {
    const fromId = sanitizeId(edge.from);
    const toId = sanitizeId(edge.to);

    if (edge.label) {
      const safeLabel = sanitizeLabel(edge.label);
      lines.push(`    ${fromId} -->|"${safeLabel}"| ${toId}`);
    } else {
      lines.push(`    ${fromId} --> ${toId}`);
    }
  }

  return lines.join('\n');
}

/**
 * Validate that a graph structure has the minimum requirements for Mermaid generation.
 * Returns true if the graph can produce valid output.
 */
export function isValidGraphStructure(graph: GraphStructure): boolean {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return false;
  }

  // Must have at least one node
  if (graph.nodes.length === 0) {
    return false;
  }

  // All nodes must have id and label
  for (const node of graph.nodes) {
    if (!node.id || typeof node.id !== 'string') return false;
    if (!node.label || typeof node.label !== 'string') return false;
  }

  // All edges must reference valid node IDs
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  for (const edge of graph.edges) {
    if (!edge.from || typeof edge.from !== 'string') return false;
    if (!edge.to || typeof edge.to !== 'string') return false;
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) return false;
  }

  return true;
}
