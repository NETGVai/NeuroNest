/**
 * Community Detector
 *
 * Partitions the dependency graph into subsystems (communities) using a
 * simplified Leiden algorithm. Assigns each community a distinct color and
 * an auto-generated label derived from the most common directory prefix
 * among community members.
 *
 * Also identifies "God Nodes" — nodes with connectivity in the top 5th
 * percentile of the degree distribution.
 *
 * Algorithm:
 * 1. Initialize: each node is its own community
 * 2. Local Moving Phase: for each node, try moving to a neighbor's community
 *    if it improves modularity
 * 3. Refinement Phase: within each community, find sub-communities
 * 4. Aggregation Phase: create super-graph of communities
 * 5. Repeat until modularity converges (Δ < 0.001) or max 100 iterations
 *
 * Requirements: 9.1, 9.2, 9.5, 9.7
 */

import type { DependencyGraph, Community, GodNodeInfo, CommunityResult } from './types.js';

/**
 * 12-color perceptually distinct palette for community coloring.
 * Colors are chosen to be distinguishable for most forms of color vision.
 */
const COMMUNITY_PALETTE: readonly string[] = [
  '#4e79a7', // steel blue
  '#f28e2b', // orange
  '#e15759', // red
  '#76b7b2', // teal
  '#59a14f', // green
  '#edc948', // yellow
  '#b07aa1', // purple
  '#ff9da7', // pink
  '#9c755f', // brown
  '#bab0ac', // gray
  '#d37295', // rose
  '#fabfd2', // light pink
] as const;

export class CommunityDetector {
  private readonly MAX_ITERATIONS = 100;
  private readonly CONVERGENCE_THRESHOLD = 0.001;
  private readonly RESOLUTION = 1.0;

  /**
   * Detect communities in the dependency graph using the Leiden algorithm.
   *
   * @param graph - The dependency graph to partition
   * @returns CommunityResult with communities, god nodes, and modularity score
   */
  detectCommunities(graph: DependencyGraph): CommunityResult {
    const nodeIds = Array.from(graph.nodes.keys());
    const nodeCount = nodeIds.length;

    // Handle empty graph
    if (nodeCount === 0) {
      return { communities: [], godNodes: [], modularity: 0 };
    }

    // Handle single node
    if (nodeCount === 1) {
      const singleId = nodeIds[0];
      const node = graph.nodes.get(singleId)!;
      const label = this.generateLabel([singleId], graph);
      const colors = this.assignColors(1);
      return {
        communities: [
          {
            id: 0,
            label,
            color: colors[0],
            nodeIds: [singleId],
            nodeCount: 1,
          },
        ],
        godNodes: this.findGodNodes(graph, [
          { id: 0, label, color: colors[0], nodeIds: [singleId], nodeCount: 1 },
        ]),
        modularity: 0,
      };
    }

    // Build undirected adjacency for modularity computation
    const { neighbors, degrees, totalEdges } = this.buildUndirectedGraph(graph, nodeIds);

    // Initialize: each node in its own community
    const communityOf = new Map<string, number>();
    for (let i = 0; i < nodeIds.length; i++) {
      communityOf.set(nodeIds[i], i);
    }

    let previousModularity = -1;
    let currentModularity = this.computeModularity(
      nodeIds,
      communityOf,
      neighbors,
      degrees,
      totalEdges
    );

    for (let iteration = 0; iteration < this.MAX_ITERATIONS; iteration++) {
      // Local moving phase
      let moved = this.localMovingPhase(
        nodeIds,
        communityOf,
        neighbors,
        degrees,
        totalEdges
      );

      // Refinement phase: within each community, try to split
      moved = this.refinementPhase(
        nodeIds,
        communityOf,
        neighbors,
        degrees,
        totalEdges
      ) || moved;

      // Compute new modularity
      currentModularity = this.computeModularity(
        nodeIds,
        communityOf,
        neighbors,
        degrees,
        totalEdges
      );

      // Check convergence
      if (
        Math.abs(currentModularity - previousModularity) < this.CONVERGENCE_THRESHOLD &&
        !moved
      ) {
        break;
      }

      previousModularity = currentModularity;
    }

    // Build community structures
    const communityMap = new Map<number, string[]>();
    for (const nodeId of nodeIds) {
      const cId = communityOf.get(nodeId)!;
      if (!communityMap.has(cId)) {
        communityMap.set(cId, []);
      }
      communityMap.get(cId)!.push(nodeId);
    }

    // Renumber communities sequentially
    const communityEntries = Array.from(communityMap.entries());
    const colors = this.assignColors(communityEntries.length);

    const communities: Community[] = communityEntries.map(([, members], index) => ({
      id: index,
      label: this.generateLabel(members, graph),
      color: colors[index],
      nodeIds: members,
      nodeCount: members.length,
    }));

    // Update communityOf with renumbered IDs for god node detection
    const renumberedCommunityOf = new Map<string, number>();
    for (let i = 0; i < communities.length; i++) {
      for (const nodeId of communities[i].nodeIds) {
        renumberedCommunityOf.set(nodeId, i);
      }
    }

    const godNodes = this.findGodNodes(graph, communities);

    return {
      communities,
      godNodes,
      modularity: currentModularity,
    };
  }

  /**
   * Build an undirected neighbor map and degree counts from the directed graph.
   * For modularity computation, we treat directed edges as undirected.
   */
  private buildUndirectedGraph(
    graph: DependencyGraph,
    nodeIds: string[]
  ): {
    neighbors: Map<string, Set<string>>;
    degrees: Map<string, number>;
    totalEdges: number;
  } {
    const neighbors = new Map<string, Set<string>>();
    const nodeSet = new Set(nodeIds);

    // Initialize neighbor sets
    for (const nodeId of nodeIds) {
      neighbors.set(nodeId, new Set());
    }

    // Build undirected edges from directed graph
    for (const edge of graph.edges) {
      if (nodeSet.has(edge.source) && nodeSet.has(edge.target) && edge.source !== edge.target) {
        neighbors.get(edge.source)!.add(edge.target);
        neighbors.get(edge.target)!.add(edge.source);
      }
    }

    // Compute degrees
    const degrees = new Map<string, number>();
    let totalEdges = 0;

    for (const nodeId of nodeIds) {
      const degree = neighbors.get(nodeId)!.size;
      degrees.set(nodeId, degree);
      totalEdges += degree;
    }

    // Each undirected edge is counted twice (once from each endpoint)
    totalEdges = totalEdges / 2;

    return { neighbors, degrees, totalEdges };
  }

  /**
   * Compute modularity Q for the current partition.
   * Q = (1/2m) × Σ[A_ij - (k_i × k_j)/(2m)] × δ(c_i, c_j)
   *
   * Simplified: Q = Σ_c [e_c/m - (a_c/2m)²]
   * where e_c = edges within community c, a_c = sum of degrees in community c
   */
  private computeModularity(
    nodeIds: string[],
    communityOf: Map<string, number>,
    neighbors: Map<string, Set<string>>,
    degrees: Map<string, number>,
    totalEdges: number
  ): number {
    if (totalEdges === 0) {
      return 0;
    }

    const m = totalEdges;
    const twoM = 2 * m;

    // Gather community stats
    const communityInternalEdges = new Map<number, number>();
    const communityTotalDegree = new Map<number, number>();

    for (const nodeId of nodeIds) {
      const cId = communityOf.get(nodeId)!;
      const degree = degrees.get(nodeId) ?? 0;

      communityTotalDegree.set(cId, (communityTotalDegree.get(cId) ?? 0) + degree);

      // Count internal edges (edges where both endpoints are in same community)
      const nodeNeighbors = neighbors.get(nodeId) ?? new Set();
      let internalEdges = 0;
      for (const neighbor of nodeNeighbors) {
        if (communityOf.get(neighbor) === cId) {
          internalEdges++;
        }
      }
      // Each internal edge is counted from both endpoints, so divide by 2 later
      communityInternalEdges.set(
        cId,
        (communityInternalEdges.get(cId) ?? 0) + internalEdges
      );
    }

    let modularity = 0;
    for (const cId of communityInternalEdges.keys()) {
      const ec = (communityInternalEdges.get(cId) ?? 0) / 2; // Divide by 2 since each edge counted twice
      const ac = communityTotalDegree.get(cId) ?? 0;
      modularity += ec / m - this.RESOLUTION * (ac / twoM) * (ac / twoM);
    }

    return modularity;
  }

  /**
   * Local moving phase: for each node, try moving to the community of one of its
   * neighbors if doing so improves modularity.
   *
   * @returns true if at least one node was moved
   */
  private localMovingPhase(
    nodeIds: string[],
    communityOf: Map<string, number>,
    neighbors: Map<string, Set<string>>,
    degrees: Map<string, number>,
    totalEdges: number
  ): boolean {
    let moved = false;
    const m = totalEdges;

    if (m === 0) {
      return false;
    }

    const twoM = 2 * m;

    // Shuffle node order for randomness (use deterministic shuffle for reproducibility)
    const shuffled = [...nodeIds];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = (i * 7 + 3) % (i + 1); // Deterministic pseudo-shuffle
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    for (const nodeId of shuffled) {
      const currentCommunity = communityOf.get(nodeId)!;
      const nodeDegree = degrees.get(nodeId) ?? 0;
      const nodeNeighbors = neighbors.get(nodeId) ?? new Set();

      // Find neighbor communities
      const neighborCommunities = new Set<number>();
      for (const neighbor of nodeNeighbors) {
        neighborCommunities.add(communityOf.get(neighbor)!);
      }

      let bestCommunity = currentCommunity;
      let bestDeltaQ = 0;

      for (const targetCommunity of neighborCommunities) {
        if (targetCommunity === currentCommunity) continue;

        // Compute modularity gain from moving nodeId to targetCommunity
        const deltaQ = this.computeModularityGain(
          nodeId,
          currentCommunity,
          targetCommunity,
          communityOf,
          neighbors,
          degrees,
          twoM
        );

        if (deltaQ > bestDeltaQ) {
          bestDeltaQ = deltaQ;
          bestCommunity = targetCommunity;
        }
      }

      if (bestCommunity !== currentCommunity) {
        communityOf.set(nodeId, bestCommunity);
        moved = true;
      }
    }

    return moved;
  }

  /**
   * Compute the modularity gain from moving a node from its current community
   * to a target community.
   *
   * ΔQ = [k_i,in_target / m - γ × (Σ_target × k_i) / (2m²)]
   *     - [k_i,in_current / m - γ × ((Σ_current - k_i) × k_i) / (2m²)]
   */
  private computeModularityGain(
    nodeId: string,
    currentCommunity: number,
    targetCommunity: number,
    communityOf: Map<string, number>,
    neighbors: Map<string, Set<string>>,
    degrees: Map<string, number>,
    twoM: number
  ): number {
    const nodeNeighbors = neighbors.get(nodeId) ?? new Set();
    const ki = degrees.get(nodeId) ?? 0;

    // Count edges from nodeId to target community
    let kiInTarget = 0;
    // Count edges from nodeId to current community (excluding self)
    let kiInCurrent = 0;
    // Sum of degrees in target community
    let sigmaTarget = 0;
    // Sum of degrees in current community (excluding the node being moved)
    let sigmaCurrent = 0;

    for (const neighbor of nodeNeighbors) {
      const neighborCommunity = communityOf.get(neighbor)!;
      if (neighborCommunity === targetCommunity) {
        kiInTarget++;
      }
      if (neighborCommunity === currentCommunity) {
        kiInCurrent++;
      }
    }

    // Compute sum of degrees for target and current communities
    for (const [nId, cId] of communityOf) {
      if (cId === targetCommunity) {
        sigmaTarget += degrees.get(nId) ?? 0;
      }
      if (cId === currentCommunity && nId !== nodeId) {
        sigmaCurrent += degrees.get(nId) ?? 0;
      }
    }

    // ΔQ formula (simplified Leiden gain)
    const gain =
      (kiInTarget - kiInCurrent) / (twoM / 2) -
      this.RESOLUTION *
        ki *
        (sigmaTarget - sigmaCurrent) /
        (twoM * twoM / 4);

    return gain;
  }

  /**
   * Refinement phase: within each community, check if splitting into
   * sub-communities would improve modularity.
   *
   * This is a simplified version that re-runs local moving within each
   * community to detect sub-structure.
   *
   * @returns true if any refinement occurred
   */
  private refinementPhase(
    nodeIds: string[],
    communityOf: Map<string, number>,
    neighbors: Map<string, Set<string>>,
    degrees: Map<string, number>,
    totalEdges: number
  ): boolean {
    let refined = false;

    if (totalEdges === 0) {
      return false;
    }

    // Group nodes by community
    const communityMembers = new Map<number, string[]>();
    for (const nodeId of nodeIds) {
      const cId = communityOf.get(nodeId)!;
      if (!communityMembers.has(cId)) {
        communityMembers.set(cId, []);
      }
      communityMembers.get(cId)!.push(nodeId);
    }

    // Find next available community ID
    let nextCommunityId = 0;
    for (const cId of communityMembers.keys()) {
      if (cId >= nextCommunityId) {
        nextCommunityId = cId + 1;
      }
    }

    // For each community with more than 2 members, try to split
    for (const [cId, members] of communityMembers) {
      if (members.length <= 2) continue;

      // Try one iteration of local moving within this community
      const twoM = 2 * totalEdges;
      for (const nodeId of members) {
        const nodeNeighbors = neighbors.get(nodeId) ?? new Set();

        // Check if node has more connections outside the community than inside
        let internalConnections = 0;
        let externalConnections = 0;

        for (const neighbor of nodeNeighbors) {
          if (communityOf.get(neighbor) === cId) {
            internalConnections++;
          } else {
            externalConnections++;
          }
        }

        // If node has more external than internal connections, try to move it
        if (externalConnections > internalConnections && internalConnections === 0) {
          // Find best neighbor community
          let bestTarget = cId;
          let bestCount = 0;
          const neighborCommunityCount = new Map<number, number>();

          for (const neighbor of nodeNeighbors) {
            const nCid = communityOf.get(neighbor)!;
            if (nCid !== cId) {
              neighborCommunityCount.set(nCid, (neighborCommunityCount.get(nCid) ?? 0) + 1);
            }
          }

          for (const [targetCId, count] of neighborCommunityCount) {
            if (count > bestCount) {
              bestCount = count;
              bestTarget = targetCId;
            }
          }

          if (bestTarget !== cId) {
            communityOf.set(nodeId, bestTarget);
            refined = true;
          }
        }
      }
    }

    return refined;
  }

  /**
   * Generate a human-readable label from community member paths.
   * Uses the most common directory prefix among community members.
   */
  generateLabel(nodeIds: string[], graph: DependencyGraph): string {
    if (nodeIds.length === 0) {
      return 'unknown';
    }

    if (nodeIds.length === 1) {
      const node = graph.nodes.get(nodeIds[0]);
      if (node) {
        // Use the deepest meaningful directory segment
        const parts = node.id.split('/').filter(Boolean);
        if (parts.length > 1) {
          return parts[parts.length - 2]; // Parent directory
        }
        return parts[0] || node.label;
      }
      return nodeIds[0];
    }

    // Count directory prefixes among members
    const dirCounts = new Map<string, number>();

    for (const nodeId of nodeIds) {
      const node = graph.nodes.get(nodeId);
      const pathStr = node?.id ?? nodeId;
      const parts = pathStr.split('/').filter(Boolean);

      // Consider all meaningful directory segments (exclude filename)
      for (let i = 0; i < parts.length - 1; i++) {
        const segment = parts[i];
        // Skip very generic segments
        if (segment === 'src' || segment === 'lib' || segment === 'index') {
          continue;
        }
        dirCounts.set(segment, (dirCounts.get(segment) ?? 0) + 1);
      }
    }

    // Find most common directory segment
    let bestDir = '';
    let bestCount = 0;

    for (const [dir, count] of dirCounts) {
      if (count > bestCount) {
        bestCount = count;
        bestDir = dir;
      }
    }

    if (bestDir) {
      return bestDir;
    }

    // Fallback: use first node's parent directory
    const firstNode = graph.nodes.get(nodeIds[0]);
    if (firstNode) {
      const parts = firstNode.id.split('/').filter(Boolean);
      if (parts.length > 1) {
        return parts[0];
      }
      return firstNode.label;
    }

    return `community`;
  }

  /**
   * Assign distinct colors using a perceptually uniform palette.
   * Cycles through the 12-color palette if more communities exist.
   */
  assignColors(communityCount: number): string[] {
    const colors: string[] = [];
    for (let i = 0; i < communityCount; i++) {
      colors.push(COMMUNITY_PALETTE[i % COMMUNITY_PALETTE.length]);
    }
    return colors;
  }

  /**
   * Identify god nodes — nodes with degree in the top 5th percentile
   * of the total degree distribution (in-degree + out-degree).
   */
  findGodNodes(graph: DependencyGraph, communities: Community[]): GodNodeInfo[] {
    const nodeIds = Array.from(graph.nodes.keys());
    if (nodeIds.length === 0) {
      return [];
    }

    // Compute total degree (in + out) for each node
    const degreeMap = new Map<string, number>();
    for (const nodeId of nodeIds) {
      const outDegree = graph.adjacency.get(nodeId)?.length ?? 0;
      const inDegree = graph.reverseAdjacency.get(nodeId)?.length ?? 0;
      degreeMap.set(nodeId, outDegree + inDegree);
    }

    // Compute 95th percentile threshold
    const allDegrees = Array.from(degreeMap.values()).sort((a, b) => a - b);
    const percentileIndex = Math.ceil(allDegrees.length * 0.95) - 1;
    const threshold = allDegrees[Math.max(0, percentileIndex)];

    // A node must have degree > 0 and >= threshold to be a God Node
    if (threshold <= 0) {
      return [];
    }

    // Build community lookup for nodes
    const communityOfNode = new Map<string, number>();
    for (const community of communities) {
      for (const nId of community.nodeIds) {
        communityOfNode.set(nId, community.id);
      }
    }

    const godNodes: GodNodeInfo[] = [];

    for (const [nodeId, degree] of degreeMap) {
      if (degree >= threshold) {
        const node = graph.nodes.get(nodeId)!;
        const communityId = communityOfNode.get(nodeId) ?? 0;

        // Get top 5 connected nodes by combining adjacency and reverse adjacency
        const allConnections = new Set<string>();
        for (const target of graph.adjacency.get(nodeId) ?? []) {
          allConnections.add(target);
        }
        for (const source of graph.reverseAdjacency.get(nodeId) ?? []) {
          allConnections.add(source);
        }

        // Sort connections by their degree (most connected first)
        const sortedConnections = Array.from(allConnections)
          .map((connId) => ({
            id: connId,
            path: graph.nodes.get(connId)?.filePath ?? connId,
            degree: degreeMap.get(connId) ?? 0,
          }))
          .sort((a, b) => b.degree - a.degree)
          .slice(0, 5)
          .map((c) => c.path);

        godNodes.push({
          fileId: nodeId,
          filePath: node.filePath,
          totalDegree: degree,
          communityId,
          topConnections: sortedConnections,
        });
      }
    }

    // Sort god nodes by degree descending
    godNodes.sort((a, b) => b.totalDegree - a.totalDegree);

    return godNodes;
  }
}
