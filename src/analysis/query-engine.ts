/**
 * Query engine for natural-language subgraph extraction.
 *
 * Matches query terms against node labels (file paths, function names, class names)
 * using case-insensitive substring matching, then expands matched nodes by 2 hops
 * via BFS to produce a focused subgraph result.
 *
 * Requirements: 12.1 (query-based subgraph rendering),
 *               12.2 (relevance by term matching + 2-hop expansion),
 *               12.6 (results within 3 seconds for <1500 files)
 */

import type {
  DependencyGraph,
  DependencyEdge,
  QueryMatchNode,
  SubgraphResult,
} from './types.js';

/** Stop words removed during tokenization */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'is', 'are', 'in', 'of', 'to', 'for', 'and', 'or', 'with', 'that',
]);

export class QueryEngine {
  /**
   * Given a dependency graph and a natural-language query, identify matching nodes,
   * expand by 2 hops, collect edges between included nodes, and return the subgraph.
   */
  querySubgraph(graph: DependencyGraph, query: string): SubgraphResult {
    const terms = this.tokenize(query);

    // If no valid terms after tokenization, return empty result
    if (terms.length === 0) {
      return {
        matchedNodes: [],
        expandedNodes: [],
        edges: [],
        totalNodes: graph.nodes.size,
        totalEdges: graph.edges.length,
        matchCount: 0,
      };
    }

    // Step 1: Find nodes that match query terms
    const matchedNodes = this.matchNodes(graph, terms);
    const matchedIds = [...new Set(matchedNodes.map((m) => m.fileId))];

    // Step 2: Expand matched nodes by 2 hops (BFS)
    const expandedNodes = this.expandHops(graph, matchedIds, 2);

    // Step 3: Build the full included set (matched + expanded)
    const includedSet = new Set<string>([...matchedIds, ...expandedNodes]);

    // Step 4: Collect all edges where both source and target are in included set
    const edges = graph.edges.filter(
      (edge) => includedSet.has(edge.source) && includedSet.has(edge.target)
    );

    return {
      matchedNodes,
      expandedNodes,
      edges,
      totalNodes: graph.nodes.size,
      totalEdges: graph.edges.length,
      matchCount: matchedNodes.length,
    };
  }

  /**
   * Tokenize a query string: split on whitespace, lowercase, remove stop words,
   * and filter empty strings.
   */
  private tokenize(query: string): string[] {
    return query
      .split(/\s+/)
      .map((token) => token.toLowerCase())
      .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
  }

  /**
   * Match query terms against node labels using case-insensitive substring matching.
   * Checks node.id (file path) and node.label (file basename).
   */
  private matchNodes(graph: DependencyGraph, terms: string[]): QueryMatchNode[] {
    const matches: QueryMatchNode[] = [];

    for (const [nodeId, node] of graph.nodes) {
      const idLower = nodeId.toLowerCase();
      const labelLower = node.label.toLowerCase();

      for (const term of terms) {
        // Match against file path (node.id)
        if (idLower.includes(term)) {
          matches.push({
            fileId: nodeId,
            matchReason: 'file-name',
            matchedTerm: term,
          });
          break; // One match per node is sufficient
        }

        // Match against display label (basename)
        if (labelLower.includes(term)) {
          matches.push({
            fileId: nodeId,
            matchReason: 'file-name',
            matchedTerm: term,
          });
          break; // One match per node is sufficient
        }
      }
    }

    return matches;
  }

  /**
   * BFS expansion from matched node IDs up to the specified number of hops.
   * Treats the graph as undirected (uses both adjacency and reverseAdjacency).
   * Returns only the newly expanded node IDs (not the originally matched ones).
   */
  private expandHops(graph: DependencyGraph, matchedIds: string[], hops: number): string[] {
    const visited = new Set<string>(matchedIds);
    let frontier = [...matchedIds];

    for (let depth = 0; depth < hops; depth++) {
      const nextFrontier: string[] = [];

      for (const nodeId of frontier) {
        // Forward edges: nodes this file imports
        const forward = graph.adjacency.get(nodeId) ?? [];
        for (const neighbor of forward) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            nextFrontier.push(neighbor);
          }
        }

        // Reverse edges: nodes that import this file
        const reverse = graph.reverseAdjacency.get(nodeId) ?? [];
        for (const neighbor of reverse) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            nextFrontier.push(neighbor);
          }
        }
      }

      frontier = nextFrontier;
    }

    // Return only expanded nodes (exclude originally matched)
    const matchedSet = new Set(matchedIds);
    return [...visited].filter((id) => !matchedSet.has(id));
  }
}
