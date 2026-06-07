import type Database from 'better-sqlite3';

/**
 * Call Graph Engine
 *
 * Builds and queries a directed call graph where nodes are functions/methods
 * and edges represent caller-to-callee relationships. Supports incremental
 * updates, BFS traversal for transitive caller/callee lookup, and blast
 * radius analysis.
 */

export interface CallGraphNode {
  id: string;
  filePath: string;
  name: string;
  signature: string;
  startLine: number;
  endLine: number;
}

export interface CallGraphEdge {
  callerId: string;
  calleeId: string;
  callSiteLine: number;
  confidence: 'RESOLVED' | 'INFERRED' | 'AMBIGUOUS';
}

export interface BlastRadius {
  upstream: CallGraphNode[];
  downstream: CallGraphNode[];
  affectedFiles: string[];
}

export interface CallEdge {
  callerId: string;
  calleeName: string;
  callSiteLine: number;
  callSiteFile: string;
}

export class CallGraphEngine {
  private insertNodeStmt: Database.Statement;
  private insertEdgeStmt: Database.Statement;
  private deleteNodesByFileStmt: Database.Statement;
  private deleteEdgesByFileStmt: Database.Statement;
  private getNodeByIdStmt: Database.Statement;
  private getCallerEdgesStmt: Database.Statement;
  private getCalleeEdgesStmt: Database.Statement;
  private getNodesByNameStmt: Database.Statement;
  private getUnresolvedEdgesStmt: Database.Statement;

  constructor(
    private db: Database.Database,
    private maxDepth: number = 5
  ) {
    this.insertNodeStmt = this.db.prepare(`
      INSERT OR REPLACE INTO call_graph_nodes (id, file_path, project_id, name, signature, start_line, end_line, chunk_id)
      VALUES (@id, @filePath, @projectId, @name, @signature, @startLine, @endLine, @chunkId)
    `);

    this.insertEdgeStmt = this.db.prepare(`
      INSERT INTO call_graph_edges (caller_id, callee_id, call_site_line, confidence, project_id)
      VALUES (@callerId, @calleeId, @callSiteLine, @confidence, @projectId)
    `);

    this.deleteNodesByFileStmt = this.db.prepare(`
      DELETE FROM call_graph_nodes WHERE file_path = ?
    `);

    this.deleteEdgesByFileStmt = this.db.prepare(`
      DELETE FROM call_graph_edges WHERE caller_id IN (
        SELECT id FROM call_graph_nodes WHERE file_path = ?
      ) OR callee_id IN (
        SELECT id FROM call_graph_nodes WHERE file_path = ?
      )
    `);

    this.getNodeByIdStmt = this.db.prepare(`
      SELECT id, file_path AS filePath, name, signature, start_line AS startLine, end_line AS endLine
      FROM call_graph_nodes WHERE id = ?
    `);

    this.getCallerEdgesStmt = this.db.prepare(`
      SELECT caller_id AS callerId, callee_id AS calleeId, call_site_line AS callSiteLine, confidence
      FROM call_graph_edges WHERE callee_id = ?
    `);

    this.getCalleeEdgesStmt = this.db.prepare(`
      SELECT caller_id AS callerId, callee_id AS calleeId, call_site_line AS callSiteLine, confidence
      FROM call_graph_edges WHERE caller_id = ?
    `);

    this.getNodesByNameStmt = this.db.prepare(`
      SELECT id, file_path AS filePath, name, signature, start_line AS startLine, end_line AS endLine
      FROM call_graph_nodes WHERE name = ?
    `);

    this.getUnresolvedEdgesStmt = this.db.prepare(`
      SELECT id, caller_id AS callerId, callee_id AS calleeId, call_site_line AS callSiteLine, confidence
      FROM call_graph_edges WHERE confidence = 'AMBIGUOUS'
    `);
  }

  /**
   * Update call graph for a single file (incremental).
   * Removes old edges for the file, then inserts new nodes and edges.
   * Unresolvable callee references are marked with confidence = 'AMBIGUOUS'.
   */
  updateFile(filePath: string, nodes: CallGraphNode[], edges: CallEdge[]): void {
    const updateTransaction = this.db.transaction(() => {
      // Remove old edges associated with nodes in this file
      this.deleteEdgesByFileStmt.run(filePath, filePath);

      // Remove old nodes for this file
      this.deleteNodesByFileStmt.run(filePath);

      // Insert new nodes
      for (const node of nodes) {
        this.insertNodeStmt.run({
          id: node.id,
          filePath: node.filePath,
          projectId: this.extractProjectId(node.filePath),
          name: node.name,
          signature: node.signature,
          startLine: node.startLine,
          endLine: node.endLine,
          chunkId: null,
        });
      }

      // Insert new edges, resolving callee names to node IDs
      for (const edge of edges) {
        const resolved = this.resolveCallee(edge.calleeName);

        if (resolved) {
          this.insertEdgeStmt.run({
            callerId: edge.callerId,
            calleeId: resolved.id,
            callSiteLine: edge.callSiteLine,
            confidence: 'RESOLVED',
            projectId: this.extractProjectId(edge.callSiteFile),
          });
        } else {
          // Create a placeholder edge with AMBIGUOUS confidence
          // Use a synthetic ID for the unresolved callee
          const ambiguousCalleeId = `unresolved:${edge.calleeName}`;

          // Check if a placeholder node exists for this unresolved name
          const existingPlaceholder = this.getNodeByIdStmt.get(ambiguousCalleeId) as CallGraphNode | undefined;
          if (!existingPlaceholder) {
            this.insertNodeStmt.run({
              id: ambiguousCalleeId,
              filePath: edge.callSiteFile,
              projectId: this.extractProjectId(edge.callSiteFile),
              name: edge.calleeName,
              signature: `unresolved:${edge.calleeName}`,
              startLine: 0,
              endLine: 0,
              chunkId: null,
            });
          }

          this.insertEdgeStmt.run({
            callerId: edge.callerId,
            calleeId: ambiguousCalleeId,
            callSiteLine: edge.callSiteLine,
            confidence: 'AMBIGUOUS',
            projectId: this.extractProjectId(edge.callSiteFile),
          });
        }
      }
    });

    updateTransaction();
  }

  /**
   * Remove all nodes and edges for a file.
   */
  removeFile(filePath: string): void {
    const removeTransaction = this.db.transaction(() => {
      this.deleteEdgesByFileStmt.run(filePath, filePath);
      this.deleteNodesByFileStmt.run(filePath);
    });

    removeTransaction();
  }

  /**
   * Get blast radius for a function: all transitive callers (upstream)
   * and callees (downstream), plus the set of affected files.
   */
  getBlastRadius(functionId: string, depth?: number): BlastRadius {
    const effectiveDepth = depth ?? this.maxDepth;

    const upstream = this.getCallers(functionId, effectiveDepth);
    const downstream = this.getCallees(functionId, effectiveDepth);

    const fileSet = new Set<string>();
    for (const node of upstream) {
      fileSet.add(node.filePath);
    }
    for (const node of downstream) {
      fileSet.add(node.filePath);
    }

    // Include the target function's own file
    const targetNode = this.getNodeByIdStmt.get(functionId) as CallGraphNode | undefined;
    if (targetNode) {
      fileSet.add(targetNode.filePath);
    }

    return {
      upstream,
      downstream,
      affectedFiles: Array.from(fileSet),
    };
  }

  /**
   * Get all transitive callers of a function (upstream) using BFS.
   */
  getCallers(functionId: string, depth?: number): CallGraphNode[] {
    const effectiveDepth = depth ?? this.maxDepth;
    return this.bfsTraversal(functionId, 'upstream', effectiveDepth);
  }

  /**
   * Get all transitive callees of a function (downstream) using BFS.
   */
  getCallees(functionId: string, depth?: number): CallGraphNode[] {
    const effectiveDepth = depth ?? this.maxDepth;
    return this.bfsTraversal(functionId, 'downstream', effectiveDepth);
  }

  /**
   * Resolve unresolved (AMBIGUOUS) edges by matching callee names to known nodes.
   * Returns the number of edges that were resolved.
   */
  resolveEdges(): number {
    let resolvedCount = 0;

    const resolveTransaction = this.db.transaction(() => {
      const ambiguousEdges = this.getUnresolvedEdgesStmt.all() as Array<{
        id: number;
        callerId: string;
        calleeId: string;
        callSiteLine: number;
        confidence: string;
      }>;

      const updateEdgeStmt = this.db.prepare(`
        UPDATE call_graph_edges SET callee_id = ?, confidence = 'RESOLVED' WHERE id = ?
      `);

      const deleteNodeStmt = this.db.prepare(`
        DELETE FROM call_graph_nodes WHERE id = ? AND id LIKE 'unresolved:%'
      `);

      for (const edge of ambiguousEdges) {
        // Extract the callee name from the synthetic ID
        const calleeName = edge.calleeId.startsWith('unresolved:')
          ? edge.calleeId.slice('unresolved:'.length)
          : null;

        if (!calleeName) continue;

        const resolved = this.resolveCallee(calleeName);
        if (resolved) {
          updateEdgeStmt.run(resolved.id, edge.id);
          // Clean up the placeholder node if no other edges reference it
          deleteNodeStmt.run(edge.calleeId);
          resolvedCount++;
        }
      }
    });

    resolveTransaction();
    return resolvedCount;
  }

  /**
   * BFS traversal to find transitive callers or callees up to a given depth.
   */
  private bfsTraversal(
    startId: string,
    direction: 'upstream' | 'downstream',
    maxDepth: number
  ): CallGraphNode[] {
    const visited = new Set<string>();
    const result: CallGraphNode[] = [];
    const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: startId, depth: 0 }];

    visited.add(startId);

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.depth >= maxDepth) continue;

      const edges =
        direction === 'upstream'
          ? (this.getCallerEdgesStmt.all(current.nodeId) as CallGraphEdge[])
          : (this.getCalleeEdgesStmt.all(current.nodeId) as CallGraphEdge[]);

      for (const edge of edges) {
        const nextId = direction === 'upstream' ? edge.callerId : edge.calleeId;

        if (visited.has(nextId)) continue;
        visited.add(nextId);

        const node = this.getNodeByIdStmt.get(nextId) as CallGraphNode | undefined;
        if (node) {
          result.push(node);
          queue.push({ nodeId: nextId, depth: current.depth + 1 });
        }
      }
    }

    return result;
  }

  /**
   * Resolve a callee name to a known node in the graph.
   * Returns the first matching node, or null if unresolvable.
   */
  private resolveCallee(calleeName: string): CallGraphNode | null {
    const matches = this.getNodesByNameStmt.all(calleeName) as CallGraphNode[];

    // Filter out placeholder/unresolved nodes
    const realMatches = matches.filter((m) => !m.id.startsWith('unresolved:'));

    if (realMatches.length === 1) {
      return realMatches[0];
    }

    // Multiple matches or no matches — cannot resolve unambiguously
    return null;
  }

  /**
   * Extract a project ID from a file path.
   * Uses the top-level directory as a simple project identifier.
   */
  private extractProjectId(filePath: string): string {
    const parts = filePath.split('/');
    // Use the first meaningful directory as project ID
    return parts.length > 1 ? parts[0] : 'default';
  }
}
