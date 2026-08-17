/**
 * Tool Tree Projector — Projects verified call lineage into a structured tree.
 *
 * Responsibilities:
 * - Project verified call lineage once in model order
 * - Flatten malformed edges safely (cycles, missing parents, incompatible lineage)
 * - Verified calls remain once in a flat model-ordered fallback
 * - Unverified parent edges are removed; verified calls are never duplicated
 * - Each immutable call identity appears exactly once
 *
 * Requirements: 37.1, 37.2, 37.14, 37.15
 */

import type {
  ProjectedToolCall,
  ToolTreeProjectionV1,
  ToolTreeQuery,
  LineageStatus,
} from './tool-tree-schemas';

// ─── Input Types ────────────────────────────────────────────────

/**
 * Raw call record from the projection data source (e.g., session events).
 * This is the minimal data needed to build the tree.
 */
export interface RawToolCallRecord {
  callId: string;
  parentCallId: string | null;
  modelOrderIndex: number;
  toolDisplayName: string;
  status: 'planned' | 'executing' | 'completed' | 'failed' | 'cancelled' | 'retrying';
  riskClass: 'read-only' | 'idempotent-write' | 'write' | 'execute' | 'destructive';
  durationMs: number | null;
  attempt: number;
  owner: string;
  hasChildren: boolean;
  renderIntent?: unknown;
  failure?: {
    errorClass: string;
    message: string;
    redacted: boolean;
    retryEligible: boolean;
    nextAction?: string;
  };
}

// ─── Projector Configuration ────────────────────────────────────

export interface ToolTreeProjectorConfig {
  /** Maximum tree depth to project. Default: 10. */
  maxDepth: number;
}

const DEFAULT_CONFIG: ToolTreeProjectorConfig = {
  maxDepth: 10,
};

// ─── Tool Tree Projector ────────────────────────────────────────

/**
 * Projects raw tool call records into a verified, deduplicated tree structure.
 *
 * Algorithm:
 * 1. Sort all calls by modelOrderIndex
 * 2. Build a candidate parent→child map
 * 3. Verify lineage (detect cycles, missing parents, depth violations)
 * 4. Remove unverified parent edges (keep calls at root level in model order)
 * 5. Produce final tree with exactly one occurrence per call identity
 */
export class ToolTreeProjector {
  private readonly config: ToolTreeProjectorConfig;

  constructor(config: Partial<ToolTreeProjectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Project a set of raw call records into a ToolTreeProjectionV1.
   */
  project(
    records: readonly RawToolCallRecord[],
    query: ToolTreeQuery,
    projectionRevision: number,
  ): ToolTreeProjectionV1 {
    if (records.length === 0) {
      return {
        sessionId: query.sessionId,
        turnId: query.turnId,
        calls: [],
        rootCallIds: [],
        childMap: {},
        projectionRevision,
        usedFallbackOrdering: false,
        schemaVersion: 1,
      };
    }

    // 1. Deduplicate by callId (first occurrence wins)
    const deduped = this.deduplicateCalls(records);

    // 2. Sort by modelOrderIndex for stable ordering
    const sorted = [...deduped].sort((a, b) => a.modelOrderIndex - b.modelOrderIndex);

    // 3. Build call lookup
    const callMap = new Map<string, RawToolCallRecord>();
    for (const call of sorted) {
      callMap.set(call.callId, call);
    }

    // 4. Verify lineage and detect malformed edges
    const { verifiedEdges, unverifiedCallIds, usedFallback } = this.verifyLineage(
      sorted,
      callMap,
      query.maxDepth ?? this.config.maxDepth,
    );

    // 5. Build child map from verified edges
    const childMap: Record<string, string[]> = {};
    for (const [parentId, children] of verifiedEdges.entries()) {
      // Sort children by model order
      const sortedChildren = children
        .map((id) => callMap.get(id)!)
        .sort((a, b) => a.modelOrderIndex - b.modelOrderIndex)
        .map((c) => c.callId);
      childMap[parentId] = sortedChildren;
    }

    // 6. Determine root calls (no verified parent)
    const hasVerifiedParent = new Set<string>();
    for (const children of verifiedEdges.values()) {
      for (const childId of children) {
        hasVerifiedParent.add(childId);
      }
    }

    const rootCallIds = sorted
      .filter((c) => !hasVerifiedParent.has(c.callId))
      .map((c) => c.callId);

    // 7. Optionally filter by parentCallId query
    let filteredCalls = sorted;
    if (query.parentCallId) {
      const descendantIds = this.collectDescendants(query.parentCallId, childMap);
      descendantIds.add(query.parentCallId);
      filteredCalls = sorted.filter((c) => descendantIds.has(c.callId));
    }

    // 8. Build projected calls with lineage status
    const calls: ProjectedToolCall[] = filteredCalls.map((record) => {
      let lineageStatus: LineageStatus;
      if (record.parentCallId === null) {
        lineageStatus = 'root';
      } else if (unverifiedCallIds.has(record.callId)) {
        lineageStatus = 'unverified';
      } else {
        lineageStatus = 'verified';
      }

      return {
        callId: record.callId,
        parentCallId: unverifiedCallIds.has(record.callId) ? null : record.parentCallId,
        modelOrderIndex: record.modelOrderIndex,
        toolDisplayName: record.toolDisplayName,
        status: record.status,
        riskClass: record.riskClass,
        durationMs: record.durationMs,
        attempt: record.attempt,
        owner: record.owner,
        lineageStatus,
        renderIntent: record.renderIntent as ProjectedToolCall['renderIntent'],
        hasChildren: (childMap[record.callId]?.length ?? 0) > 0,
        failure: record.failure,
      };
    });

    return {
      sessionId: query.sessionId,
      turnId: query.turnId,
      calls,
      rootCallIds: query.parentCallId
        ? filteredCalls.filter((c) => !hasVerifiedParent.has(c.callId) || c.callId === query.parentCallId).map((c) => c.callId)
        : rootCallIds,
      childMap,
      projectionRevision,
      usedFallbackOrdering: usedFallback,
      schemaVersion: 1,
    };
  }

  /**
   * Deduplicate calls by callId. First occurrence (lowest modelOrderIndex) wins.
   */
  private deduplicateCalls(records: readonly RawToolCallRecord[]): RawToolCallRecord[] {
    const seen = new Set<string>();
    const result: RawToolCallRecord[] = [];
    // Process in model order to keep first occurrence
    const sorted = [...records].sort((a, b) => a.modelOrderIndex - b.modelOrderIndex);
    for (const record of sorted) {
      if (!seen.has(record.callId)) {
        seen.add(record.callId);
        result.push(record);
      }
    }
    return result;
  }

  /**
   * Verify lineage edges. Detects:
   * - Cycles (call is its own ancestor)
   * - Missing parents (parentCallId not in the call set)
   * - Depth exceeding maxDepth
   *
   * Returns verified edges and the set of calls whose parent edges were removed.
   */
  private verifyLineage(
    sorted: RawToolCallRecord[],
    callMap: Map<string, RawToolCallRecord>,
    maxDepth: number,
  ): {
    verifiedEdges: Map<string, string[]>;
    unverifiedCallIds: Set<string>;
    usedFallback: boolean;
  } {
    const verifiedEdges = new Map<string, string[]>();
    const unverifiedCallIds = new Set<string>();
    let usedFallback = false;

    for (const call of sorted) {
      if (call.parentCallId === null) {
        // Root call — no edge to verify
        continue;
      }

      // Check 1: Parent exists in the call set
      if (!callMap.has(call.parentCallId)) {
        unverifiedCallIds.add(call.callId);
        usedFallback = true;
        continue;
      }

      // Check 2: Detect cycles (walk up the parent chain)
      if (this.detectCycle(call.callId, call.parentCallId, callMap)) {
        unverifiedCallIds.add(call.callId);
        usedFallback = true;
        continue;
      }

      // Check 3: Depth check
      const depth = this.computeDepth(call.callId, call.parentCallId, callMap);
      if (depth > maxDepth) {
        unverifiedCallIds.add(call.callId);
        usedFallback = true;
        continue;
      }

      // Edge is verified — add to child map
      const children = verifiedEdges.get(call.parentCallId) ?? [];
      children.push(call.callId);
      verifiedEdges.set(call.parentCallId, children);
    }

    return { verifiedEdges, unverifiedCallIds, usedFallback };
  }

  /**
   * Detect if adding an edge from childId to parentId would create a cycle.
   */
  private detectCycle(
    childId: string,
    parentId: string,
    callMap: Map<string, RawToolCallRecord>,
  ): boolean {
    const visited = new Set<string>();
    let current: string | null = parentId;

    while (current !== null) {
      if (current === childId) {
        return true; // Cycle detected
      }
      if (visited.has(current)) {
        return true; // Already visited — cycle in ancestry
      }
      visited.add(current);
      const parent = callMap.get(current);
      current = parent?.parentCallId ?? null;
    }

    return false;
  }

  /**
   * Compute depth of a call in the tree (counting from root = 1).
   */
  private computeDepth(
    _callId: string,
    parentId: string,
    callMap: Map<string, RawToolCallRecord>,
  ): number {
    let depth = 1;
    let current: string | null = parentId;
    const visited = new Set<string>();

    while (current !== null) {
      if (visited.has(current)) break; // Safety: stop on cycles
      visited.add(current);
      depth++;
      const parent = callMap.get(current);
      current = parent?.parentCallId ?? null;
    }

    return depth;
  }

  /**
   * Collect all descendant call IDs from a given parent through the child map.
   */
  private collectDescendants(parentId: string, childMap: Record<string, string[]>): Set<string> {
    const result = new Set<string>();
    const queue = [parentId];

    while (queue.length > 0) {
      const current = queue.pop()!;
      const children = childMap[current] ?? [];
      for (const child of children) {
        if (!result.has(child)) {
          result.add(child);
          queue.push(child);
        }
      }
    }

    return result;
  }
}
