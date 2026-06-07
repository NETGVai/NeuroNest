import { TaskGraphSchema } from '../shared/schemas.js';
import type { TaskGraph } from '../shared/types.js';

/**
 * Serializes a TaskGraph to a JSON string.
 * Validates: Requirement 6.15
 */
export function serializeTaskGraph(graph: TaskGraph): string {
  return JSON.stringify(graph);
}

/**
 * Parses a JSON string into a validated TaskGraph.
 * Throws on invalid input.
 * Validates: Requirement 6.15, 6.16
 */
export function parseTaskGraph(json: string): TaskGraph {
  const raw = JSON.parse(json);
  return TaskGraphSchema.parse(raw);
}
