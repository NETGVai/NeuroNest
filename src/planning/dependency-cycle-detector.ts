/**
 * DependencyCycleDetector — Validates task dependency graphs are DAGs.
 *
 * - Detects cycles in task dependency graphs
 * - Reports exact cycle paths for diagnostics
 * - Provides remediation suggestions (which edges to remove)
 *
 * Requirements: 12.2, 12.3
 */

/** A node in the dependency graph */
export interface DependencyNode {
  taskId: string;
  dependsOn: string[];
}

/** Result of cycle detection */
export interface CycleDetectionResult {
  isAcyclic: boolean;
  cycles: DetectedCycle[];
  topologicalOrder: string[] | null;
}

/** A detected cycle in the graph */
export interface DetectedCycle {
  path: string[];
  remediationSuggestions: CycleRemediation[];
}

/** A suggested edge to remove to break a cycle */
export interface CycleRemediation {
  fromTaskId: string;
  toTaskId: string;
  reason: string;
}

/**
 * DependencyCycleDetector validates that a set of task dependencies form a DAG.
 *
 * Uses DFS-based cycle detection with path tracking to report exact cycles
 * and suggest which edges to remove.
 */
export class DependencyCycleDetector {
  /**
   * Validates the dependency graph and detects any cycles.
   *
   * @param nodes - The dependency graph nodes (each with taskId and dependsOn list)
   * @returns A CycleDetectionResult with cycles and optional topological order
   */
  detect(nodes: DependencyNode[]): CycleDetectionResult {
    const adjacency = new Map<string, string[]>();
    const allIds = new Set<string>();

    // Build adjacency list: edge from A -> B means A depends on B
    for (const node of nodes) {
      allIds.add(node.taskId);
      adjacency.set(node.taskId, [...node.dependsOn]);
      for (const dep of node.dependsOn) {
        allIds.add(dep);
        if (!adjacency.has(dep)) {
          adjacency.set(dep, []);
        }
      }
    }

    const cycles: DetectedCycle[] = [];
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const path: string[] = [];

    const dfs = (nodeId: string): void => {
      if (inStack.has(nodeId)) {
        // Found a cycle — extract the cycle path
        const cycleStartIdx = path.indexOf(nodeId);
        if (cycleStartIdx !== -1) {
          const cyclePath = [...path.slice(cycleStartIdx), nodeId];
          const remediations = this.suggestRemediations(cyclePath);
          cycles.push({ path: cyclePath, remediationSuggestions: remediations });
        }
        return;
      }

      if (visited.has(nodeId)) {
        return;
      }

      visited.add(nodeId);
      inStack.add(nodeId);
      path.push(nodeId);

      const neighbors = adjacency.get(nodeId) ?? [];
      for (const neighbor of neighbors) {
        dfs(neighbor);
      }

      path.pop();
      inStack.delete(nodeId);
    };

    for (const nodeId of allIds) {
      if (!visited.has(nodeId)) {
        dfs(nodeId);
      }
    }

    const isAcyclic = cycles.length === 0;
    const topologicalOrder = isAcyclic ? this.topologicalSort(allIds, adjacency) : null;

    return { isAcyclic, cycles, topologicalOrder };
  }

  /**
   * Performs topological sort on an acyclic graph.
   */
  private topologicalSort(
    allIds: Set<string>,
    adjacency: Map<string, string[]>
  ): string[] {
    // Kahn's algorithm
    const inDegree = new Map<string, number>();
    for (const id of allIds) {
      inDegree.set(id, 0);
    }

    for (const [, deps] of adjacency) {
      for (const dep of deps) {
        inDegree.set(dep, (inDegree.get(dep) ?? 0) + 1);
      }
    }

    // Wait — the edges go from task -> dependency.
    // In topological sort we want dependencies resolved before dependents.
    // Reverse the graph for toposort: edge from A depends_on B means B must come before A.
    const reverseAdj = new Map<string, string[]>();
    for (const id of allIds) {
      reverseAdj.set(id, []);
    }
    for (const [taskId, deps] of adjacency) {
      for (const dep of deps) {
        reverseAdj.get(dep)!.push(taskId);
      }
    }

    // Recompute inDegree for the original adjacency (a depends_on b means a has an inbound conceptually)
    const taskInDegree = new Map<string, number>();
    for (const id of allIds) {
      taskInDegree.set(id, adjacency.get(id)?.length ?? 0);
    }

    // Tasks with 0 dependencies are ready first
    const queue: string[] = [];
    for (const [id, degree] of taskInDegree) {
      if (degree === 0) {
        queue.push(id);
      }
    }

    // Sort the initial queue for determinism
    queue.sort();

    const result: string[] = [];
    while (queue.length > 0) {
      // Sort for deterministic order among equally-ready tasks
      queue.sort();
      const current = queue.shift()!;
      result.push(current);

      // "current" is resolved; reduce inDegree of tasks that depend on it
      const dependents = reverseAdj.get(current) ?? [];
      for (const dependent of dependents) {
        const newDegree = taskInDegree.get(dependent)! - 1;
        taskInDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          queue.push(dependent);
        }
      }
    }

    return result;
  }

  /**
   * Suggests which edges to remove to break a cycle.
   * Heuristic: suggest removing the edge that creates a back-edge (last edge in cycle).
   */
  private suggestRemediations(cyclePath: string[]): CycleRemediation[] {
    const suggestions: CycleRemediation[] = [];

    if (cyclePath.length < 2) return suggestions;

    // Suggest removing the last edge (back-edge that closes the cycle)
    const lastIdx = cyclePath.length - 1;
    const fromTask = cyclePath[lastIdx - 1];
    const toTask = cyclePath[lastIdx];

    suggestions.push({
      fromTaskId: fromTask,
      toTaskId: toTask,
      reason: `Remove dependency from "${fromTask}" to "${toTask}" to break the cycle: ${cyclePath.join(' → ')}`,
    });

    // If cycle has more than 2 unique nodes, also suggest removing the first edge
    if (cyclePath.length > 3) {
      suggestions.push({
        fromTaskId: cyclePath[0],
        toTaskId: cyclePath[1],
        reason: `Alternatively, remove dependency from "${cyclePath[0]}" to "${cyclePath[1]}" to break the cycle`,
      });
    }

    return suggestions;
  }
}
