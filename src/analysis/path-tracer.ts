/**
 * Path Tracer module — computes shortest paths between nodes in the dependency graph.
 *
 * Uses BFS treating the graph as undirected (traverses both import and reverse-import edges)
 * to find the minimum-hop path between any two file nodes.
 *
 * Requirements: 11.1 (shortest path via BFS), 11.5 (complete within 2 seconds for <1500 files)
 */
import type { DependencyGraph, PathResult, PathNode } from './types.js';

export class PathTracer {
  /**
   * BFS Shortest Path Algorithm:
   *
   * 1. If source === target, return trivial 0-hop path
   * 2. Initialize BFS queue from source node
   * 3. Track parent map for path reconstruction
   * 4. Treat graph as undirected (traverse both adjacency and reverseAdjacency edges)
   * 5. On reaching target, reconstruct path via parent chain
   * 6. If queue exhausted without reaching target, return not-found
   *
   * Time complexity: O(V + E) where V = nodes, E = edges
   * Space complexity: O(V) for visited set and parent map
   */
  findShortestPath(
    graph: DependencyGraph,
    sourceId: string,
    targetId: string
  ): PathResult {
    // Trivial case: source === target
    if (sourceId === targetId) {
      const node = graph.nodes.get(sourceId);
      return {
        found: true,
        hops: 0,
        path: [
          {
            fileId: sourceId,
            filePath: node?.filePath ?? sourceId,
            isIntermediate: false,
          },
        ],
      };
    }

    // BFS initialization
    const visited = new Set<string>();
    const parentMap = new Map<string, string>();
    const queue: string[] = [sourceId];
    visited.add(sourceId);

    while (queue.length > 0) {
      const current = queue.shift()!;

      // Get neighbors from both adjacency (files this node imports)
      // and reverseAdjacency (files that import this node) — treating graph as undirected
      const forwardNeighbors = graph.adjacency.get(current) ?? [];
      const reverseNeighbors = graph.reverseAdjacency.get(current) ?? [];
      const allNeighbors = [...forwardNeighbors, ...reverseNeighbors];

      for (const neighbor of allNeighbors) {
        if (visited.has(neighbor)) {
          continue;
        }

        visited.add(neighbor);
        parentMap.set(neighbor, current);

        // Found target — reconstruct path
        if (neighbor === targetId) {
          return this.reconstructPath(graph, sourceId, targetId, parentMap);
        }

        queue.push(neighbor);
      }
    }

    // Queue exhausted without reaching target — disconnected
    return {
      found: false,
      hops: 0,
      path: [],
    };
  }

  /**
   * Reconstruct the path from source to target by walking back through the parent map,
   * then reversing to get source-to-target order.
   */
  private reconstructPath(
    graph: DependencyGraph,
    sourceId: string,
    targetId: string,
    parentMap: Map<string, string>
  ): PathResult {
    const pathIds: string[] = [];
    let current = targetId;

    // Walk back from target to source
    while (current !== sourceId) {
      pathIds.push(current);
      current = parentMap.get(current)!;
    }
    pathIds.push(sourceId);

    // Reverse to get source → target order
    pathIds.reverse();

    // Build PathNode array with isIntermediate markers
    const path: PathNode[] = pathIds.map((fileId, index) => {
      const node = graph.nodes.get(fileId);
      const isIntermediate = index !== 0 && index !== pathIds.length - 1;
      return {
        fileId,
        filePath: node?.filePath ?? fileId,
        isIntermediate,
      };
    });

    return {
      found: true,
      hops: pathIds.length - 1,
      path,
    };
  }
}
