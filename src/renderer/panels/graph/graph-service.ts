/**
 * Graph service — IPC wrappers for graph data operations.
 * Provides a typed interface between the graph panel and the main process.
 */

import type { GraphData, GraphStats, GraphQueryResult } from './types';

/** Electron API accessor (available via preload bridge). */
function eapi(): { invoke: (channel: string, arg?: unknown) => Promise<unknown> } {
  return (window as unknown as { electronAPI: { invoke: (channel: string, arg?: unknown) => Promise<unknown> } }).electronAPI;
}

/**
 * Check whether a project already has a generated knowledge graph.
 */
export async function hasGraph(projectId: string): Promise<boolean> {
  const result = await eapi().invoke('graph-has-graph', { projectId });
  return Boolean(result);
}

/**
 * Generate a new knowledge graph for the given project.
 * This may take some time depending on project size.
 */
export async function generateGraph(projectId: string): Promise<GraphData> {
  const result = await eapi().invoke('graph-generate', { projectId });
  return result as GraphData;
}

/**
 * Load an existing knowledge graph for the given project.
 */
export async function loadGraph(projectId: string): Promise<GraphData | null> {
  const result = await eapi().invoke('graph-load', { projectId });
  if (!result) return null;
  return result as GraphData;
}

/**
 * Query the knowledge graph with a natural language question.
 */
export async function queryGraph(
  projectId: string,
  question: string,
  maxTokens?: number
): Promise<GraphQueryResult> {
  const result = await eapi().invoke('graph-query', {
    projectId,
    question,
    maxTokens: maxTokens ?? 2000,
  });
  return result as GraphQueryResult;
}

/**
 * Get statistics for a project's knowledge graph.
 */
export async function getGraphStats(projectId: string): Promise<GraphStats> {
  const result = await eapi().invoke('graph-stats', { projectId });
  return result as GraphStats;
}

/**
 * Clear cached graph data for a project.
 */
export function clearGraphCache(projectId: string): void {
  eapi().invoke('graph-clear-cache', { projectId });
}
