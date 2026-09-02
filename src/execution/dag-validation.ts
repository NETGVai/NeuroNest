/**
 * DAG validation and readiness computation for plan graphs
 * (FUT-PKG-06-EXECUTION/T-003).
 *
 * D-07 `PlanRevision@1` requires that the dependency graph is acyclic unless
 * the selected topology explicitly defines a bounded loop; a cycle is
 * otherwise INVALID and the plan is rejected (NN-TASK-003). D-13 places DAG
 * validation ahead of any dispatch: only tasks whose dependencies have all
 * reached `succeeded` are dispatchable (NN-TASK-002).
 *
 * This module is pure: it operates on task ids and edges only, has no side
 * effect, and never touches storage. {@link TaskPlanService} calls it before
 * committing a plan revision (reject a cycle) and before every dispatch
 * (compute ready set). The same input always yields the same result.
 *
 * Design anchors: D-07 (`PlanRevision@1` acyclic invariant), D-13 (readiness
 * before dispatch). Requirements: NN-TASK-002, NN-TASK-003.
 */

import type { PlanEdge, PlanTopology, TaskState } from './task-types';

// ─── Cycle detection ─────────────────────────────────────────────────────────

/** The result of {@link validateDag}. */
export type DagValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'cycle' | 'dangling-edge';
      /** The task ids that form the detected cycle, in order, if any. */
      readonly cycle?: readonly string[];
      /** The offending edge for a dangling-edge failure. */
      readonly edge?: PlanEdge;
    };

/**
 * Validate that a plan graph over `taskIds` with `edges` is acyclic (unless
 * `topology` is `bounded-loop`) and that every edge references a declared task.
 *
 *   - A `dangling-edge` failure occurs when an edge names a task id not in
 *     `taskIds` (the graph is not self-contained).
 *   - A `cycle` failure occurs when a directed cycle exists AND the topology is
 *     `acyclic`. When `topology` is `bounded-loop` a cycle is permitted (the
 *     caller has explicitly declared a bounded loop) and does not fail.
 *
 * Detection uses iterative DFS three-colouring (white/grey/black) so it is safe
 * for large graphs without deep recursion, and reconstructs the cycle path for
 * a helpful, secret-free diagnostic.
 */
export function validateDag(
  taskIds: readonly string[],
  edges: readonly PlanEdge[],
  topology: PlanTopology,
): DagValidation {
  const nodes = new Set(taskIds);
  const adjacency = new Map<string, string[]>();
  for (const id of taskIds) adjacency.set(id, []);

  for (const edge of edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      return { ok: false, reason: 'dangling-edge', edge };
    }
    adjacency.get(edge.from)!.push(edge.to);
  }

  if (topology === 'bounded-loop') {
    // A bounded loop is explicitly permitted; only edge containment is checked.
    return { ok: true };
  }

  const cycle = findCycle(taskIds, adjacency);
  if (cycle) {
    return { ok: false, reason: 'cycle', cycle };
  }
  return { ok: true };
}

/** Whether the graph over `taskIds`/`edges` contains a directed cycle. */
export function hasCycle(
  taskIds: readonly string[],
  edges: readonly PlanEdge[],
): boolean {
  const nodes = new Set(taskIds);
  const adjacency = new Map<string, string[]>();
  for (const id of taskIds) adjacency.set(id, []);
  for (const edge of edges) {
    if (nodes.has(edge.from) && nodes.has(edge.to)) {
      adjacency.get(edge.from)!.push(edge.to);
    }
  }
  return findCycle(taskIds, adjacency) !== undefined;
}

type Colour = 'white' | 'grey' | 'black';

/**
 * Iterative DFS three-colouring cycle finder. Returns the ordered cycle path
 * (e.g. `[a, b, c, a]`) when a back edge into a grey node is found, else
 * `undefined`.
 */
function findCycle(
  taskIds: readonly string[],
  adjacency: Map<string, string[]>,
): readonly string[] | undefined {
  const colour = new Map<string, Colour>();
  for (const id of taskIds) colour.set(id, 'white');
  const parent = new Map<string, string | undefined>();

  for (const start of taskIds) {
    if (colour.get(start) !== 'white') continue;
    // Stack frames carry the node and an index into its neighbour list.
    const stack: { node: string; index: number }[] = [{ node: start, index: 0 }];
    colour.set(start, 'grey');
    parent.set(start, undefined);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const neighbours = adjacency.get(frame.node) ?? [];
      if (frame.index < neighbours.length) {
        const next = neighbours[frame.index]!;
        frame.index += 1;
        const nextColour = colour.get(next);
        if (nextColour === 'grey') {
          // Back edge => cycle. Reconstruct from `frame.node` back to `next`.
          return reconstructCycle(parent, frame.node, next);
        }
        if (nextColour === 'white') {
          colour.set(next, 'grey');
          parent.set(next, frame.node);
          stack.push({ node: next, index: 0 });
        }
      } else {
        colour.set(frame.node, 'black');
        stack.pop();
      }
    }
  }
  return undefined;
}

function reconstructCycle(
  parent: Map<string, string | undefined>,
  from: string,
  target: string,
): readonly string[] {
  const path: string[] = [from];
  let cursor: string | undefined = from;
  while (cursor !== undefined && cursor !== target) {
    cursor = parent.get(cursor);
    if (cursor !== undefined) path.push(cursor);
  }
  path.push(target); // close the loop back onto the target
  return path.reverse();
}

// ─── Topological order (for deterministic aggregation / display) ────────────

/**
 * A deterministic topological order of an acyclic graph. Ties are broken by
 * lexicographic task id so the order is stable across runs. Returns
 * `undefined` when the graph has a cycle.
 */
export function topologicalOrder(
  taskIds: readonly string[],
  edges: readonly PlanEdge[],
): readonly string[] | undefined {
  const nodes = new Set(taskIds);
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of taskIds) {
    adjacency.set(id, []);
    indegree.set(id, 0);
  }
  for (const edge of edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    adjacency.get(edge.from)!.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  // Kahn's algorithm with a lexicographically sorted ready frontier.
  const frontier = taskIds
    .filter((id) => (indegree.get(id) ?? 0) === 0)
    .sort((a, b) => a.localeCompare(b));
  const order: string[] = [];
  while (frontier.length > 0) {
    const node = frontier.shift()!;
    order.push(node);
    const neighbours = [...(adjacency.get(node) ?? [])].sort((a, b) => a.localeCompare(b));
    for (const next of neighbours) {
      const deg = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, deg);
      if (deg === 0) {
        // Insert to keep the frontier sorted.
        insertSorted(frontier, next);
      }
    }
  }
  return order.length === taskIds.length ? order : undefined;
}

function insertSorted(list: string[], value: string): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((list[mid] ?? '').localeCompare(value) < 0) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, value);
}

// ─── Readiness / dispatchability from dependency states (NN-TASK-002) ───────

/**
 * Whether a task is dispatchable purely from its dependency states: every
 * declared dependency must have reached `succeeded` (NN-TASK-002). A dependency
 * in any non-`succeeded` state (including `failed`/`cancelled`) leaves the task
 * NOT dispatchable — a failed dependency does not silently unblock a dependent.
 */
export function dependenciesSatisfied(
  dependencies: readonly string[],
  stateOf: (taskId: string) => TaskState | undefined,
): boolean {
  for (const dep of dependencies) {
    if (stateOf(dep) !== 'succeeded') return false;
  }
  return true;
}

/**
 * Compute the set of task ids whose dependencies are all satisfied, given a map
 * of task id -> its declared dependencies and a state lookup. Used to derive
 * the "ready" frontier for dispatch (NN-TASK-002, D-13).
 */
export function readyFrontier(
  dependenciesByTask: ReadonlyMap<string, readonly string[]>,
  stateOf: (taskId: string) => TaskState | undefined,
): readonly string[] {
  const ready: string[] = [];
  for (const [taskId, deps] of dependenciesByTask) {
    const state = stateOf(taskId);
    // Only tasks not yet terminal or in-progress are candidates to become ready.
    if (state === 'queued' || state === 'ready' || state === 'blocked') {
      if (dependenciesSatisfied(deps, stateOf)) ready.push(taskId);
    }
  }
  return ready.sort((a, b) => a.localeCompare(b));
}
