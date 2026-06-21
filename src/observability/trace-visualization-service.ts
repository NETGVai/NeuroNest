/**
 * TraceVisualizationService — Distributed Trace Visualization and Session Replay.
 *
 * Builds hierarchical trace trees from flat SQLite trace entries, supports session
 * replay with context window snapshots, full-text search across trace nodes, and
 * configurable retention-based pruning.
 *
 * The service reads from the existing `execution_traces` and `trace_entries` tables
 * managed by ExecutionTraceService, and extends with additional visualization columns
 * (`node_type`, `cost_usd`, `outcome`) when the trace_visualization Feature Gate is
 * enabled.
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7
 */

import type Database from 'better-sqlite3';
import type { ExecutionTraceService } from '../infrastructure/execution-trace-service.js';

// ─── Interfaces ─────────────────────────────────────────────────

/**
 * A node in the hierarchical trace tree representing a single agent action.
 *
 * Requirement 12.1: structured trace tree including LLM calls, tool executions,
 * and sub-agent lifecycle events.
 * Requirement 12.2: annotated with latency, token count, cost, and outcome.
 */
export interface TraceTreeNode {
  id: string;
  parentId: string | null;
  type: 'llm_call' | 'tool_execution' | 'sub_agent_spawn' | 'decision' | 'error';
  label: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  tokenCount: number | null;
  costUsd: number | null;
  outcome: 'success' | 'failure' | 'pending';
  metadata: Record<string, unknown>;
  children: TraceTreeNode[];
}

/**
 * A single frame in session replay, capturing the agent decision state at each step.
 *
 * Requirement 12.3: reconstruct the agent decision state at each step
 * including the context window contents visible to the agent.
 */
export interface SessionReplayFrame {
  frameIndex: number;
  traceNodeId: string;
  contextWindowSnapshot: string[];
  agentState: Record<string, unknown>;
}

// ─── Internal Row Types ─────────────────────────────────────────

interface TraceEntryVisualizationRow {
  id: string;
  trace_id: string;
  sequence: number;
  timestamp: string;
  type: string;
  tool_name: string | null;
  parameters: string | null;
  token_count: number | null;
  duration_ms: number | null;
  result: string | null;
  error: string | null;
  correlation_id: string | null;
  parent_entry_id: string | null;
  intent_purpose: string | null;
  confidence_at_decision: number | null;
  node_type: string | null;
  cost_usd: number | null;
  outcome: string | null;
}

interface TraceSessionRow {
  id: string;
  session_id: string;
  started_at: string;
  completed_at: string | null;
  total_duration_ms: number | null;
  total_tokens: number | null;
}

interface StorageSizeRow {
  total_size: number;
}

// ─── TraceVisualizationService ──────────────────────────────────

export class TraceVisualizationService {
  private readonly stmtGetEntriesBySession: Database.Statement;
  private readonly stmtGetTracesBySession: Database.Statement;
  private readonly stmtSearchEntries: Database.Statement;
  private readonly stmtDeleteOldTraces: Database.Statement;
  private readonly stmtDeleteOldEntries: Database.Statement;
  private readonly stmtGetOldestSessions: Database.Statement;
  private readonly stmtEstimateStorage: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    // Kept as a dependency for future use and to match the design spec interface.
    // The service currently reads directly from SQLite for performance.
    _traceService: ExecutionTraceService,
    private readonly ipcSend?: (channel: string, data: unknown) => void,
  ) {
    // Ensure extended columns exist
    this.ensureVisualizationColumns();

    this.stmtGetEntriesBySession = db.prepare(`
      SELECT te.id, te.trace_id, te.sequence, te.timestamp, te.type, te.tool_name,
             te.parameters, te.token_count, te.duration_ms, te.result, te.error,
             te.correlation_id, te.parent_entry_id, te.intent_purpose,
             te.confidence_at_decision, te.node_type, te.cost_usd, te.outcome
      FROM trace_entries te
      INNER JOIN execution_traces et ON te.trace_id = et.id
      WHERE et.session_id = ?
      ORDER BY te.sequence ASC
    `);

    this.stmtGetTracesBySession = db.prepare(`
      SELECT id, session_id, started_at, completed_at, total_duration_ms, total_tokens
      FROM execution_traces
      WHERE session_id = ?
      ORDER BY started_at ASC
    `);

    this.stmtSearchEntries = db.prepare(`
      SELECT te.id, te.trace_id, te.sequence, te.timestamp, te.type, te.tool_name,
             te.parameters, te.token_count, te.duration_ms, te.result, te.error,
             te.correlation_id, te.parent_entry_id, te.intent_purpose,
             te.confidence_at_decision, te.node_type, te.cost_usd, te.outcome
      FROM trace_entries te
      INNER JOIN execution_traces et ON te.trace_id = et.id
      WHERE et.session_id = ?
        AND (
          te.tool_name LIKE ? OR
          te.type LIKE ? OR
          te.error LIKE ? OR
          te.intent_purpose LIKE ? OR
          te.result LIKE ?
        )
      ORDER BY te.sequence ASC
    `);

    this.stmtDeleteOldTraces = db.prepare(`
      DELETE FROM execution_traces
      WHERE started_at < ?
    `);

    this.stmtDeleteOldEntries = db.prepare(`
      DELETE FROM trace_entries
      WHERE trace_id NOT IN (SELECT id FROM execution_traces)
    `);

    this.stmtGetOldestSessions = db.prepare(`
      SELECT id, session_id, started_at, completed_at, total_duration_ms, total_tokens
      FROM execution_traces
      ORDER BY started_at ASC
      LIMIT ?
    `);

    this.stmtEstimateStorage = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM trace_entries) * 512 +
        (SELECT COUNT(*) FROM execution_traces) * 256
        AS total_size
    `);
  }

  /**
   * Build a hierarchical trace tree for a session.
   *
   * Reconstructs the parent-child relationships between trace entries to form
   * a collapsible tree view. Root nodes have parentId = null.
   *
   * Requirement 12.1: structured trace tree for every agent session.
   * Requirement 12.4: expose trace data via IPC for renderer tree view.
   */
  buildTraceTree(sessionId: string): TraceTreeNode {
    const entries = this.stmtGetEntriesBySession.all(sessionId) as TraceEntryVisualizationRow[];
    const traces = this.stmtGetTracesBySession.all(sessionId) as TraceSessionRow[];

    // Build flat nodes map
    const nodeMap = new Map<string, TraceTreeNode>();
    for (const entry of entries) {
      const node = this.entryToTreeNode(entry);
      nodeMap.set(node.id, node);
    }

    // Collect root-level nodes (no parent or parent not in this session)
    const rootChildren: TraceTreeNode[] = [];
    for (const entry of entries) {
      const node = nodeMap.get(entry.id)!;
      if (entry.parent_entry_id && nodeMap.has(entry.parent_entry_id)) {
        nodeMap.get(entry.parent_entry_id)!.children.push(node);
      } else {
        rootChildren.push(node);
      }
    }

    // Build session root node
    const sessionTrace = traces[0];
    const root: TraceTreeNode = {
      id: `session:${sessionId}`,
      parentId: null,
      type: 'decision',
      label: `Session ${sessionId}`,
      startedAt: sessionTrace?.started_at ?? new Date().toISOString(),
      completedAt: sessionTrace?.completed_at ?? null,
      durationMs: sessionTrace?.total_duration_ms ?? null,
      tokenCount: sessionTrace?.total_tokens ?? null,
      costUsd: this.computeTotalCost(entries),
      outcome: this.determineSessionOutcome(entries),
      metadata: {
        traceCount: traces.length,
        entryCount: entries.length,
      },
      children: rootChildren,
    };

    // Send to renderer via IPC if available
    if (this.ipcSend) {
      this.ipcSend('trace-visualization:tree', { sessionId, tree: root });
    }

    return root;
  }

  /**
   * Reconstruct replay frames for step-by-step debugging.
   *
   * Each frame represents the agent's decision state at a particular point,
   * including which messages were visible in the context window.
   *
   * Requirement 12.3: reconstruct the agent decision state at each step
   * including the context window contents visible to the agent.
   */
  buildReplayFrames(sessionId: string): SessionReplayFrame[] {
    const entries = this.stmtGetEntriesBySession.all(sessionId) as TraceEntryVisualizationRow[];
    const frames: SessionReplayFrame[] = [];

    // Track context window state as we step through entries
    const contextWindow: string[] = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;

      // LLM requests add to context window
      if (entry.type === 'llm-request') {
        const params = this.parseJson(entry.parameters);
        if (params && typeof params === 'object' && 'messageId' in (params as Record<string, unknown>)) {
          contextWindow.push((params as Record<string, unknown>)['messageId'] as string);
        } else {
          contextWindow.push(`msg_${entry.sequence}`);
        }
      }

      // Tool results add to context window
      if (entry.type === 'result' || entry.type === 'tool-call') {
        contextWindow.push(`${entry.type}_${entry.id}`);
      }

      const frame: SessionReplayFrame = {
        frameIndex: i,
        traceNodeId: entry.id,
        contextWindowSnapshot: [...contextWindow],
        agentState: this.buildAgentState(entry, entries.slice(0, i + 1)),
      };

      frames.push(frame);
    }

    // Send to renderer via IPC if available
    if (this.ipcSend) {
      this.ipcSend('trace-visualization:replay', { sessionId, frames });
    }

    return frames;
  }

  /**
   * Full-text search across trace nodes within a session.
   *
   * Searches tool names, entry types, errors, intent purposes, and results.
   *
   * Requirement 12.5: full-text search across trace nodes within a session.
   */
  searchTraces(sessionId: string, query: string): TraceTreeNode[] {
    if (!query || query.trim().length === 0) {
      return [];
    }

    const searchPattern = `%${query}%`;
    const entries = this.stmtSearchEntries.all(
      sessionId,
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
    ) as TraceEntryVisualizationRow[];

    return entries.map((entry) => this.entryToTreeNode(entry));
  }

  /**
   * Prune traces older than retention period and enforce storage limits.
   *
   * Requirement 12.6: configurable maximum trace retention period (default 30 days)
   * and maximum trace storage size (default 1GB), automatically pruning oldest
   * sessions when limits are reached.
   */
  pruneOldTraces(retentionDays: number = 30, maxStorageBytes: number = 1_073_741_824): void {
    // Phase 1: prune by age
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    const cutoffIso = cutoffDate.toISOString();

    this.stmtDeleteOldTraces.run(cutoffIso);
    this.stmtDeleteOldEntries.run();

    // Phase 2: prune by size if still over limit
    let storageEstimate = this.estimateStorageBytes();
    while (storageEstimate > maxStorageBytes) {
      // Remove oldest batch of traces
      const oldest = this.stmtGetOldestSessions.all(10) as TraceSessionRow[];
      if (oldest.length === 0) break;

      for (const trace of oldest) {
        this.db.prepare('DELETE FROM trace_entries WHERE trace_id = ?').run(trace.id);
        this.db.prepare('DELETE FROM execution_traces WHERE id = ?').run(trace.id);
      }

      storageEstimate = this.estimateStorageBytes();
    }
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Ensure the extended visualization columns exist on trace_entries.
   * Uses ALTER TABLE with IF NOT EXISTS semantics (catches errors on existing columns).
   */
  private ensureVisualizationColumns(): void {
    const columnsToAdd = [
      { name: 'node_type', type: 'TEXT' },
      { name: 'cost_usd', type: 'REAL' },
      { name: 'outcome', type: 'TEXT' },
    ];

    for (const col of columnsToAdd) {
      try {
        this.db.exec(`ALTER TABLE trace_entries ADD COLUMN ${col.name} ${col.type}`);
      } catch {
        // Column already exists — expected for subsequent initializations
      }
    }

    // Add indexes for visualization queries
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_entries_node_type ON trace_entries(node_type)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_entries_outcome ON trace_entries(outcome)`);
    } catch {
      // Indexes already exist
    }
  }

  /**
   * Map a trace entry type to a visualization node type.
   */
  private mapEntryTypeToNodeType(
    entryType: string,
    nodeType: string | null,
  ): TraceTreeNode['type'] {
    // Prefer the explicit node_type if set
    if (nodeType) {
      const validTypes: TraceTreeNode['type'][] = [
        'llm_call', 'tool_execution', 'sub_agent_spawn', 'decision', 'error',
      ];
      if (validTypes.includes(nodeType as TraceTreeNode['type'])) {
        return nodeType as TraceTreeNode['type'];
      }
    }

    // Map from trace entry types to visualization node types
    switch (entryType) {
      case 'llm-request':
        return 'llm_call';
      case 'tool-call':
        return 'tool_execution';
      case 'decision':
        return 'decision';
      case 'error':
        return 'error';
      case 'result':
        return 'tool_execution';
      default:
        return 'decision';
    }
  }

  /**
   * Determine the outcome of an entry based on its error field and explicit outcome column.
   */
  private determineOutcome(entry: TraceEntryVisualizationRow): TraceTreeNode['outcome'] {
    if (entry.outcome) {
      const validOutcomes: TraceTreeNode['outcome'][] = ['success', 'failure', 'pending'];
      if (validOutcomes.includes(entry.outcome as TraceTreeNode['outcome'])) {
        return entry.outcome as TraceTreeNode['outcome'];
      }
    }

    if (entry.error) return 'failure';
    if (entry.result !== null) return 'success';
    return 'pending';
  }

  /**
   * Build a label for a trace tree node.
   */
  private buildLabel(entry: TraceEntryVisualizationRow): string {
    if (entry.tool_name) {
      return `${entry.type}: ${entry.tool_name}`;
    }
    if (entry.intent_purpose) {
      return entry.intent_purpose;
    }
    return entry.type;
  }

  /**
   * Convert a raw database row to a TraceTreeNode.
   */
  private entryToTreeNode(entry: TraceEntryVisualizationRow): TraceTreeNode {
    return {
      id: entry.id,
      parentId: entry.parent_entry_id ?? null,
      type: this.mapEntryTypeToNodeType(entry.type, entry.node_type),
      label: this.buildLabel(entry),
      startedAt: entry.timestamp,
      completedAt: entry.duration_ms
        ? new Date(new Date(entry.timestamp).getTime() + entry.duration_ms).toISOString()
        : null,
      durationMs: entry.duration_ms ?? null,
      tokenCount: entry.token_count ?? null,
      costUsd: entry.cost_usd ?? null,
      outcome: this.determineOutcome(entry),
      metadata: this.buildMetadata(entry),
      children: [],
    };
  }

  /**
   * Build metadata from an entry row.
   */
  private buildMetadata(entry: TraceEntryVisualizationRow): Record<string, unknown> {
    const metadata: Record<string, unknown> = {};

    if (entry.parameters) {
      const parsed = this.parseJson(entry.parameters);
      if (parsed) metadata['parameters'] = parsed;
    }
    if (entry.correlation_id) {
      metadata['correlationId'] = entry.correlation_id;
    }
    if (entry.confidence_at_decision !== null) {
      metadata['confidenceAtDecision'] = entry.confidence_at_decision;
    }
    if (entry.intent_purpose) {
      metadata['intentPurpose'] = entry.intent_purpose;
    }

    return metadata;
  }

  /**
   * Build agent state snapshot for a replay frame.
   */
  private buildAgentState(
    current: TraceEntryVisualizationRow,
    entriesUpToNow: TraceEntryVisualizationRow[],
  ): Record<string, unknown> {
    const toolCalls = entriesUpToNow.filter((e) => e.type === 'tool-call').length;
    const llmCalls = entriesUpToNow.filter((e) => e.type === 'llm-request').length;
    const errors = entriesUpToNow.filter((e) => e.error !== null).length;
    const totalTokens = entriesUpToNow.reduce((sum, e) => sum + (e.token_count ?? 0), 0);
    const totalCost = entriesUpToNow.reduce((sum, e) => sum + (e.cost_usd ?? 0), 0);

    return {
      currentStep: current.sequence,
      currentType: current.type,
      currentTool: current.tool_name ?? null,
      toolCallCount: toolCalls,
      llmCallCount: llmCalls,
      errorCount: errors,
      totalTokens,
      totalCostUsd: totalCost,
      confidence: current.confidence_at_decision ?? null,
      intentPurpose: current.intent_purpose ?? null,
    };
  }

  /**
   * Compute total cost for all entries in a session.
   */
  private computeTotalCost(entries: TraceEntryVisualizationRow[]): number | null {
    const costsPresent = entries.some((e) => e.cost_usd !== null);
    if (!costsPresent) return null;
    return entries.reduce((sum, e) => sum + (e.cost_usd ?? 0), 0);
  }

  /**
   * Determine overall session outcome from entries.
   */
  private determineSessionOutcome(entries: TraceEntryVisualizationRow[]): TraceTreeNode['outcome'] {
    if (entries.length === 0) return 'pending';
    const hasErrors = entries.some((e) => e.error !== null);
    const allCompleted = entries.every((e) => e.result !== null || e.error !== null);
    if (hasErrors) return 'failure';
    if (allCompleted) return 'success';
    return 'pending';
  }

  /**
   * Estimate total storage used by trace data in bytes.
   */
  private estimateStorageBytes(): number {
    const row = this.stmtEstimateStorage.get() as StorageSizeRow | undefined;
    return row?.total_size ?? 0;
  }

  /**
   * Defensive JSON parser. Returns null for invalid JSON rather than throwing.
   */
  private parseJson(json: string | null): unknown {
    if (!json) return null;
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
}

// ─── SQL for Extended Visualization Columns ─────────────────────

/**
 * SQL to add visualization-specific columns to the trace_entries table.
 * Called when the trace_visualization Feature Gate is enabled.
 *
 * Requirements: 12.1, 12.2
 */
export const TRACE_VISUALIZATION_COLUMNS_SQL = `
ALTER TABLE trace_entries ADD COLUMN node_type TEXT;
ALTER TABLE trace_entries ADD COLUMN cost_usd REAL;
ALTER TABLE trace_entries ADD COLUMN outcome TEXT;
CREATE INDEX IF NOT EXISTS idx_trace_entries_node_type ON trace_entries(node_type);
CREATE INDEX IF NOT EXISTS idx_trace_entries_outcome ON trace_entries(outcome);
`.trim();

/**
 * Initialize the trace visualization columns if they don't exist.
 * Safe to call multiple times (uses ALTER TABLE which will error on duplicate).
 *
 * @param db - A better-sqlite3 Database instance
 */
export function initTraceVisualizationColumns(db: Database.Database): void {
  const columns = [
    { name: 'node_type', type: 'TEXT' },
    { name: 'cost_usd', type: 'REAL' },
    { name: 'outcome', type: 'TEXT' },
  ];

  for (const col of columns) {
    try {
      db.exec(`ALTER TABLE trace_entries ADD COLUMN ${col.name} ${col.type}`);
    } catch {
      // Column already exists
    }
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_entries_node_type ON trace_entries(node_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_entries_outcome ON trace_entries(outcome)`);
}
