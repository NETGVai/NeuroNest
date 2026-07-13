/**
 * Blast Radius Engine
 *
 * Computes file-level impact analysis using BFS over the dependency graph's
 * reverse-adjacency edges. Given a source file, determines all files that
 * directly or transitively depend on it.
 *
 * Algorithm:
 * 1. Initialize BFS queue with source file at depth 0 (source not in results)
 * 2. For each node, find all files that import it (reverse adjacency)
 * 3. Add unvisited importers at depth+1
 * 4. Track visited set to handle circular dependencies
 * 5. Stop when queue empty or depth exceeds MAX_DEPTH
 *
 * Requirements: 2.1, 2.2, 2.4, 2.6
 */

import type { DependencyGraph, BlastRadiusResult, BlastRadiusNode } from './types.js';
import type { CallGraphEngine } from '../indexing/call-graph-engine.js';

export class BlastRadiusEngine {
  private readonly MAX_DEPTH = 20;
  private readonly _callGraphEngine: CallGraphEngine | undefined;

  constructor(callGraphEngine?: CallGraphEngine) {
    this._callGraphEngine = callGraphEngine;
  }

  /** Access the optional CallGraphEngine for future function-level augmentation */
  get callGraphEngine(): CallGraphEngine | undefined {
    return this._callGraphEngine;
  }

  /**
   * BFS from sourceFileId following reverse-dependency edges.
   * Terminates on: visited node (cycle), MAX_DEPTH, or exhaustion.
   *
   * @param graph - The dependency graph with reverse adjacency data
   * @param sourceFileId - The file node ID to compute blast radius for
   * @param maxDepth - Optional max depth override (default: MAX_DEPTH = 20)
   * @returns BlastRadiusResult with direct and transitive dependents
   */
  computeBlastRadius(
    graph: DependencyGraph,
    sourceFileId: string,
    maxDepth?: number
  ): BlastRadiusResult {
    const effectiveMaxDepth = maxDepth ?? this.MAX_DEPTH;
    const visited = new Set<string>();
    const directDependents: BlastRadiusNode[] = [];
    const transitiveDependents: BlastRadiusNode[] = [];
    let maxDepthReached = 0;

    // BFS queue: [nodeId, depth]
    const queue: Array<[string, number]> = [[sourceFileId, 0]];
    visited.add(sourceFileId);

    while (queue.length > 0) {
      const [currentId, currentDepth] = queue.shift()!;

      // Don't explore beyond max depth
      if (currentDepth >= effectiveMaxDepth) {
        continue;
      }

      // Get all files that depend on the current file (reverse edges)
      const dependents = graph.reverseAdjacency.get(currentId) ?? [];

      for (const dependentId of dependents) {
        if (visited.has(dependentId)) {
          continue; // Skip already-visited nodes (handles cycles)
        }

        visited.add(dependentId);
        const neighborDepth = currentDepth + 1;

        if (neighborDepth > maxDepthReached) {
          maxDepthReached = neighborDepth;
        }

        const node = graph.nodes.get(dependentId);
        const blastNode: BlastRadiusNode = {
          fileId: dependentId,
          filePath: node?.filePath ?? dependentId,
          depth: neighborDepth,
          opacity: this.computeOpacity(neighborDepth, effectiveMaxDepth),
        };

        if (neighborDepth === 1) {
          directDependents.push(blastNode);
        } else {
          transitiveDependents.push(blastNode);
        }

        // Continue BFS from this node
        queue.push([dependentId, neighborDepth]);
      }
    }

    return {
      sourceFile: sourceFileId,
      directDependents,
      transitiveDependents,
      totalAffected: directDependents.length + transitiveDependents.length,
      maxDepthReached,
    };
  }

  /**
   * Compute opacity for a node based on its BFS depth.
   * depth 1 = 1.0 (fully opaque), deeper = linear decay to minimum 0.3.
   *
   * Formula: opacity = max(0.3, 1.0 - (depth - 1) * (0.7 / maxDepth))
   */
  private computeOpacity(depth: number, maxDepth: number): number {
    if (depth <= 1) {
      return 1.0;
    }
    return Math.max(0.3, 1.0 - ((depth - 1) * 0.7) / maxDepth);
  }
}
