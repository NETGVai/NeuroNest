/**
 * Health Scorer module.
 * Computes a composite A–F health grade for a project based on four metrics:
 * dead code percentage, circular dependency count, coupling score, and security issues.
 *
 * Requirements: 3.1, 3.2, 3.3
 */

import type {
  DependencyGraph,
  HealthGrade,
  HealthScoreResult,
  MetricScore,
  PatternDetectionResult,
} from './types.js';

export class HealthScorer {
  /**
   * Compute the composite health score for a project.
   *
   * Composite = 0.25 × deadCode + 0.25 × circularDeps + 0.25 × coupling + 0.25 × security
   * Each metric is normalized to 0–100 where 100 = perfect health.
   */
  computeHealthScore(graph: DependencyGraph, patterns: PatternDetectionResult): HealthScoreResult {
    const deadCode = this.scoreDeadCode(graph);
    const circularDependencies = this.scoreCircularDependencies(graph);
    const coupling = this.scoreCoupling(graph);
    const securityIssues = this.scoreSecurityIssues(patterns);

    const compositeScore =
      0.25 * deadCode.normalizedScore +
      0.25 * circularDependencies.normalizedScore +
      0.25 * coupling.normalizedScore +
      0.25 * securityIssues.normalizedScore;

    const grade = this.gradeFromScore(compositeScore);

    return {
      grade,
      compositeScore,
      metrics: {
        deadCode,
        circularDependencies,
        coupling,
        securityIssues,
      },
    };
  }

  /**
   * Dead code metric: files with zero reverse-adjacency (nothing imports them)
   * that are not entry points (index files or main files).
   *
   * Score = 100 - deadCodePercentage
   */
  private scoreDeadCode(graph: DependencyGraph): MetricScore {
    const totalFiles = graph.nodes.size;
    if (totalFiles === 0) {
      return { rawValue: 0, normalizedScore: 100, details: [] };
    }

    const deadFiles: string[] = [];

    for (const [nodeId, node] of graph.nodes) {
      const importers = graph.reverseAdjacency.get(nodeId) ?? [];
      if (importers.length === 0 && !this.isEntryPoint(node.filePath)) {
        deadFiles.push(nodeId);
      }
    }

    const deadCodePercentage = (deadFiles.length / totalFiles) * 100;
    const normalizedScore = Math.max(0, Math.min(100, 100 - deadCodePercentage));

    return {
      rawValue: deadFiles.length,
      normalizedScore,
      details: deadFiles,
    };
  }

  /**
   * Circular dependency metric: detect cycles using DFS.
   *
   * Score = 100 - min(100, cycleCount × 10)
   */
  private scoreCircularDependencies(graph: DependencyGraph): MetricScore {
    const cycles = this.detectCycles(graph);
    const cycleCount = cycles.length;
    const normalizedScore = Math.max(0, 100 - Math.min(100, cycleCount * 10));

    return {
      rawValue: cycleCount,
      normalizedScore,
      details: cycles.map((cycle) => cycle.join(' → ')),
    };
  }

  /**
   * Coupling metric: average of (fan-in × fan-out) per file.
   *
   * Score = 100 - min(100, avgCoupling × 5)
   */
  private scoreCoupling(graph: DependencyGraph): MetricScore {
    const totalFiles = graph.nodes.size;
    if (totalFiles === 0) {
      return { rawValue: 0, normalizedScore: 100, details: [] };
    }

    let totalCoupling = 0;
    const highCouplingFiles: string[] = [];

    for (const [nodeId] of graph.nodes) {
      const fanOut = (graph.adjacency.get(nodeId) ?? []).length;
      const fanIn = (graph.reverseAdjacency.get(nodeId) ?? []).length;
      const coupling = fanIn * fanOut;
      totalCoupling += coupling;

      if (coupling > 20) {
        highCouplingFiles.push(nodeId);
      }
    }

    const avgCoupling = totalCoupling / totalFiles;
    const normalizedScore = Math.max(0, 100 - Math.min(100, avgCoupling * 5));

    return {
      rawValue: avgCoupling,
      normalizedScore,
      details: highCouplingFiles,
    };
  }

  /**
   * Security issues metric: count files with known security anti-patterns
   * from PatternDetectionResult.
   *
   * Score = 100 - min(100, issueCount × 20)
   */
  private scoreSecurityIssues(patterns: PatternDetectionResult): MetricScore {
    // Count anti-patterns that indicate security concerns
    const securityAntiPatterns = patterns.antiPatterns.filter(
      (p) => p.patternType === 'god-object' || p.patternType === 'high-coupling'
    );

    const issueCount = securityAntiPatterns.length;
    const normalizedScore = Math.max(0, 100 - Math.min(100, issueCount * 20));

    return {
      rawValue: issueCount,
      normalizedScore,
      details: securityAntiPatterns.map((p) => `${p.fileId}: ${p.patternType}`),
    };
  }

  /**
   * Convert a composite numeric score to a letter grade.
   *
   * Grade boundaries:
   *   ≥ 90 → A
   *   ≥ 75 → B
   *   ≥ 60 → C
   *   ≥ 45 → D
   *   ≥ 30 → E
   *   < 30 → F
   */
  private gradeFromScore(score: number): HealthGrade {
    if (score >= 90) return 'A';
    if (score >= 75) return 'B';
    if (score >= 60) return 'C';
    if (score >= 45) return 'D';
    if (score >= 30) return 'E';
    return 'F';
  }

  /**
   * Determine if a file is an entry point (should not be considered dead code).
   * Entry points include: index files, main files, and config files.
   */
  private isEntryPoint(filePath: string): boolean {
    const basename = filePath.split('/').pop() ?? '';
    const nameWithoutExt = basename.replace(/\.[^.]+$/, '');
    const entryPatterns = ['index', 'main', 'app', 'server', 'entry'];
    return entryPatterns.some((pattern) => nameWithoutExt.toLowerCase() === pattern);
  }

  /**
   * Detect cycles in the dependency graph using iterative DFS with
   * coloring (WHITE=unvisited, GRAY=in-progress, BLACK=done).
   * Returns an array of cycle paths.
   */
  private detectCycles(graph: DependencyGraph): string[][] {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;

    const color = new Map<string, number>();
    const parent = new Map<string, string | null>();
    const cycles: string[][] = [];

    for (const nodeId of graph.nodes.keys()) {
      color.set(nodeId, WHITE);
    }

    for (const startNode of graph.nodes.keys()) {
      if (color.get(startNode) !== WHITE) continue;

      // Iterative DFS using an explicit stack
      const stack: Array<{ node: string; neighborIndex: number }> = [];
      color.set(startNode, GRAY);
      parent.set(startNode, null);
      stack.push({ node: startNode, neighborIndex: 0 });

      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        const neighbors = graph.adjacency.get(frame.node) ?? [];

        if (frame.neighborIndex >= neighbors.length) {
          // All neighbors processed, mark as done
          color.set(frame.node, BLACK);
          stack.pop();
          continue;
        }

        const neighbor = neighbors[frame.neighborIndex];
        frame.neighborIndex++;

        if (!graph.nodes.has(neighbor)) continue;

        const neighborColor = color.get(neighbor);

        if (neighborColor === GRAY) {
          // Found a back edge → cycle detected
          const cycle: string[] = [neighbor];
          // Walk back through the stack to reconstruct the cycle
          for (let i = stack.length - 1; i >= 0; i--) {
            cycle.push(stack[i].node);
            if (stack[i].node === neighbor) break;
          }
          cycle.reverse();
          cycles.push(cycle);
        } else if (neighborColor === WHITE) {
          color.set(neighbor, GRAY);
          parent.set(neighbor, frame.node);
          stack.push({ node: neighbor, neighborIndex: 0 });
        }
      }
    }

    return cycles;
  }
}
