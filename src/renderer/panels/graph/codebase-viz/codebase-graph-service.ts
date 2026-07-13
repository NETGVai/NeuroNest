/**
 * Codebase graph service — IPC wrappers for codebase analysis operations.
 * Provides a typed interface between the codebase visualization panel and
 * the main process CodebaseAnalyzer.
 *
 * Follows the same pattern as ../graph-service.ts.
 */

import type {
  AnalysisResult,
  BlastRadiusResult,
  HealthScoreResult,
  PatternDetectionResult,
  LayerAssignment,
  CommunityResult,
  PathResult,
  SubgraphResult,
  HeatmapResult,
} from '../../../../analysis/types';

/** IPC channel constants for codebase analysis. */
const CHANNELS = {
  ANALYZE: 'codebase-analyze',
  BLAST_RADIUS: 'codebase-blast-radius',
  HEALTH_SCORE: 'codebase-health-score',
  PATTERNS: 'codebase-patterns',
  LAYERS: 'codebase-layers',
  COMMUNITIES: 'codebase-communities',
  PATH_TRACE: 'codebase-path-trace',
  QUERY: 'codebase-query',
  HEATMAP: 'codebase-heatmap',
  PROGRESS: 'codebase-progress',
} as const;

/** Electron API accessor (available via preload bridge). */
function eapi(): {
  invoke: (channel: string, arg?: unknown) => Promise<unknown>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
} {
  return (window as unknown as {
    electronAPI: {
      invoke: (channel: string, arg?: unknown) => Promise<unknown>;
      on: (channel: string, callback: (...args: unknown[]) => void) => void;
      removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
    };
  }).electronAPI;
}

/**
 * Trigger a full codebase analysis for the given project.
 * Returns the dependency graph and analysis metadata.
 */
export async function analyzeCodebase(projectId: string): Promise<AnalysisResult> {
  const result = await eapi().invoke(CHANNELS.ANALYZE, { projectId });
  return result as AnalysisResult;
}

/**
 * Compute the blast radius for a specific file — all files that would be
 * affected if this file changes, traversed via reverse-dependency edges.
 */
export async function getBlastRadius(projectId: string, fileId: string): Promise<BlastRadiusResult> {
  const result = await eapi().invoke(CHANNELS.BLAST_RADIUS, { projectId, fileId });
  return result as BlastRadiusResult;
}

/**
 * Get the composite health score and per-metric breakdown for the project.
 */
export async function getHealthScore(projectId: string): Promise<HealthScoreResult> {
  const result = await eapi().invoke(CHANNELS.HEALTH_SCORE, { projectId });
  return result as HealthScoreResult;
}

/**
 * Detect design patterns and anti-patterns across the project's source files.
 */
export async function detectPatterns(projectId: string): Promise<PatternDetectionResult> {
  const result = await eapi().invoke(CHANNELS.PATTERNS, { projectId });
  return result as PatternDetectionResult;
}

/**
 * Classify all files into architectural layers (UI, Services, Utils, Data, Config, Tests).
 */
export async function getArchitectureLayers(projectId: string): Promise<LayerAssignment[]> {
  const result = await eapi().invoke(CHANNELS.LAYERS, { projectId });
  return result as LayerAssignment[];
}

/**
 * Detect communities (clusters of tightly-related files) using the Leiden algorithm.
 */
export async function detectCommunities(projectId: string): Promise<CommunityResult> {
  const result = await eapi().invoke(CHANNELS.COMMUNITIES, { projectId });
  return result as CommunityResult;
}

/**
 * Trace the shortest dependency path between two files.
 */
export async function tracePath(
  projectId: string,
  sourceId: string,
  targetId: string
): Promise<PathResult> {
  const result = await eapi().invoke(CHANNELS.PATH_TRACE, { projectId, sourceId, targetId });
  return result as PathResult;
}

/**
 * Query the dependency graph with search terms and return matching nodes
 * expanded by 2 hops.
 */
export async function querySubgraph(projectId: string, query: string): Promise<SubgraphResult> {
  const result = await eapi().invoke(CHANNELS.QUERY, { projectId, query });
  return result as SubgraphResult;
}

/**
 * Get commit-frequency heatmap data for all files in the project.
 * @param days - Number of days to look back in Git history (default: 90)
 */
export async function getActivityHeatmap(projectId: string, days?: number): Promise<HeatmapResult> {
  const result = await eapi().invoke(CHANNELS.HEATMAP, { projectId, days });
  return result as HeatmapResult;
}

/**
 * Subscribe to analysis progress updates. Returns an unsubscribe function.
 *
 * Progress events are streamed from the main process during long-running
 * analysis operations (parsing, resolving, analyzing).
 *
 * @param callback - Called with the completion percentage (0–100) on each update
 * @returns A function that removes the listener when called
 */
export function onProgress(callback: (percent: number) => void): () => void {
  const handler = (...args: unknown[]) => {
    const data = args[0] as { percent: number } | undefined;
    if (data && typeof data.percent === 'number') {
      callback(data.percent);
    }
  };

  eapi().on(CHANNELS.PROGRESS, handler);

  return () => {
    eapi().removeListener(CHANNELS.PROGRESS, handler);
  };
}
