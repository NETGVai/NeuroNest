/**
 * ExecutionTraceService — Structured trace capture for agent execution.
 *
 * Records every action taken during an agent task: tool calls, LLM requests,
 * decisions, results, and errors. Persists to SQLite execution_traces and
 * trace_entries tables. Emits real-time updates via CallbackEngine for UI
 * rendering.
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5
 */

import type Database from 'better-sqlite3';
import { uuidv7 } from 'uuidv7';
import type { ExecutionTrace, TraceEntry } from '../shared/feature-integration-types.js';
import { FeatureError } from '../shared/feature-integration-errors.js';
import type { CallbackEngine } from '../pipeline/callback-engine.js';

// ─── Database Row Types ─────────────────────────────────────────

interface TraceRow {
  id: string;
  session_id: string;
  message_id: string;
  started_at: string;
  completed_at: string | null;
  total_duration_ms: number | null;
  total_tokens: number | null;
}

interface TraceEntryRow {
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
}

// ─── In-Memory Trace State ──────────────────────────────────────

interface ActiveTrace {
  id: string;
  sessionId: string;
  messageId: string;
  startedAt: string;
  entries: TraceEntry[];
  sequenceCounter: number;
}

// ─── ExecutionTraceService ──────────────────────────────────────

export class ExecutionTraceService {
  private readonly callbackEngine: CallbackEngine | null;

  /** In-memory active traces keyed by traceId for fast addEntry access. */
  private readonly activeTraces: Map<string, ActiveTrace> = new Map();

  // Prepared statements
  private readonly stmtInsertTrace: Database.Statement;
  private readonly stmtCompleteTrace: Database.Statement;
  private readonly stmtGetTrace: Database.Statement;
  private readonly stmtGetTracesBySession: Database.Statement;
  private readonly stmtInsertEntry: Database.Statement;
  private readonly stmtGetEntriesByTrace: Database.Statement;

  constructor(db: Database.Database, callbackEngine?: CallbackEngine | null) {
    this.callbackEngine = callbackEngine ?? null;

    this.stmtInsertTrace = db.prepare(
      `INSERT INTO execution_traces (id, session_id, message_id, started_at, completed_at, total_duration_ms, total_tokens)
       VALUES (?, ?, ?, ?, NULL, NULL, 0)`,
    );

    this.stmtCompleteTrace = db.prepare(
      `UPDATE execution_traces
       SET completed_at = ?, total_duration_ms = ?, total_tokens = ?
       WHERE id = ?`,
    );

    this.stmtGetTrace = db.prepare(
      `SELECT id, session_id, message_id, started_at, completed_at, total_duration_ms, total_tokens
       FROM execution_traces WHERE id = ?`,
    );

    this.stmtGetTracesBySession = db.prepare(
      `SELECT id, session_id, message_id, started_at, completed_at, total_duration_ms, total_tokens
       FROM execution_traces WHERE session_id = ? ORDER BY started_at DESC`,
    );

    this.stmtInsertEntry = db.prepare(
      `INSERT INTO trace_entries (id, trace_id, sequence, timestamp, type, tool_name, parameters, token_count, duration_ms, result, error, correlation_id, parent_entry_id, intent_purpose, confidence_at_decision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.stmtGetEntriesByTrace = db.prepare(
      `SELECT id, trace_id, sequence, timestamp, type, tool_name, parameters, token_count, duration_ms, result, error, correlation_id, parent_entry_id, intent_purpose, confidence_at_decision
       FROM trace_entries WHERE trace_id = ? ORDER BY sequence ASC`,
    );
  }

  /**
   * Start a new execution trace for a given session and message.
   * Returns the new traceId (uuidv7).
   */
  startTrace(sessionId: string, messageId: string): string {
    const traceId = uuidv7();
    const startedAt = new Date().toISOString();

    // Persist the trace header immediately
    this.stmtInsertTrace.run(traceId, sessionId, messageId, startedAt);

    // Keep an in-memory representation for fast entry additions
    const activeTrace: ActiveTrace = {
      id: traceId,
      sessionId,
      messageId,
      startedAt,
      entries: [],
      sequenceCounter: 0,
    };
    this.activeTraces.set(traceId, activeTrace);

    // Emit real-time update
    this.emitTraceUpdate(traceId, 'trace-started', {
      traceId,
      sessionId,
      messageId,
      startedAt,
    });

    return traceId;
  }

  /**
   * Add an entry to an active trace. Assigns a unique ID, traceId, and
   * auto-incrementing sequence number.
   *
   * Persists the entry to SQLite immediately and emits a real-time update.
   */
  addEntry(
    traceId: string,
    entry: Omit<TraceEntry, 'id' | 'traceId' | 'sequence'>,
  ): void {
    const activeTrace = this.activeTraces.get(traceId);
    if (!activeTrace) {
      throw new FeatureError({
        message: `Trace not found or already completed: ${traceId}`,
        category: 'infrastructure',
        code: 'TRACE_NOT_FOUND',
        details: { traceId },
      });
    }

    const entryId = uuidv7();
    activeTrace.sequenceCounter++;
    const sequence = activeTrace.sequenceCounter;

    const fullEntry: TraceEntry = {
      id: entryId,
      traceId,
      sequence,
      timestamp: entry.timestamp,
      type: entry.type,
      ...(entry.toolName !== undefined && { toolName: entry.toolName }),
      ...(entry.parameters !== undefined && { parameters: entry.parameters }),
      ...(entry.tokenCount !== undefined && { tokenCount: entry.tokenCount }),
      ...(entry.durationMs !== undefined && { durationMs: entry.durationMs }),
      ...(entry.result !== undefined && { result: entry.result }),
      ...(entry.error !== undefined && { error: entry.error }),
      correlationId: entry.correlationId ?? null,
      parentEntryId: entry.parentEntryId ?? null,
      intentPurpose: entry.intentPurpose ?? null,
      confidenceAtDecision: entry.confidenceAtDecision ?? null,
    };

    // Persist to SQLite
    this.stmtInsertEntry.run(
      entryId,
      traceId,
      sequence,
      entry.timestamp,
      entry.type,
      entry.toolName ?? null,
      entry.parameters ? JSON.stringify(entry.parameters) : null,
      entry.tokenCount ?? null,
      entry.durationMs ?? null,
      entry.result !== undefined ? JSON.stringify(entry.result) : null,
      entry.error ?? null,
      entry.correlationId ?? null,
      entry.parentEntryId ?? null,
      entry.intentPurpose ?? null,
      entry.confidenceAtDecision ?? null,
    );

    // Track in memory
    activeTrace.entries.push(fullEntry);

    // Emit real-time update
    this.emitTraceUpdate(traceId, 'entry-added', {
      traceId,
      entry: fullEntry,
    });
  }

  /**
   * Complete a trace: compute total duration and token counts, persist
   * the final state, remove from active traces, and return the full trace.
   */
  async completeTrace(traceId: string): Promise<ExecutionTrace> {
    const activeTrace = this.activeTraces.get(traceId);
    if (!activeTrace) {
      // Attempt to load from DB (trace might have been restarted)
      const existing = await this.getTrace(traceId);
      if (!existing) {
        throw new FeatureError({
          message: `Trace not found: ${traceId}`,
          category: 'infrastructure',
          code: 'TRACE_NOT_FOUND',
          details: { traceId },
        });
      }
      return existing;
    }

    const completedAt = new Date().toISOString();

    // Compute total duration from startedAt to now
    const startMs = new Date(activeTrace.startedAt).getTime();
    const endMs = new Date(completedAt).getTime();
    const totalDurationMs = endMs - startMs;

    // Compute total tokens from all entries
    const totalTokens = activeTrace.entries.reduce(
      (sum, e) => sum + (e.tokenCount ?? 0),
      0,
    );

    // Persist completion
    this.stmtCompleteTrace.run(completedAt, totalDurationMs, totalTokens, traceId);

    // Build the final trace object
    const trace: ExecutionTrace = {
      id: traceId,
      sessionId: activeTrace.sessionId,
      messageId: activeTrace.messageId,
      entries: activeTrace.entries,
      startedAt: activeTrace.startedAt,
      completedAt,
      totalDurationMs,
      totalTokens,
    };

    // Remove from active traces
    this.activeTraces.delete(traceId);

    // Emit real-time update
    this.emitTraceUpdate(traceId, 'trace-completed', {
      traceId,
      completedAt,
      totalDurationMs,
      totalTokens,
    });

    return trace;
  }

  /**
   * Retrieve a trace by ID, including all entries. Returns null if not found.
   */
  async getTrace(traceId: string): Promise<ExecutionTrace | null> {
    // Check active traces first (not yet completed)
    const active = this.activeTraces.get(traceId);
    if (active) {
      const startMs = new Date(active.startedAt).getTime();
      const totalDurationMs = Date.now() - startMs;
      const totalTokens = active.entries.reduce(
        (sum, e) => sum + (e.tokenCount ?? 0),
        0,
      );
      return {
        id: active.id,
        sessionId: active.sessionId,
        messageId: active.messageId,
        entries: [...active.entries],
        startedAt: active.startedAt,
        totalDurationMs,
        totalTokens,
      };
    }

    // Load from database
    const traceRow = this.stmtGetTrace.get(traceId) as TraceRow | undefined;
    if (!traceRow) return null;

    const entryRows = this.stmtGetEntriesByTrace.all(traceId) as TraceEntryRow[];
    const entries = entryRows.map(rowToTraceEntry);

    return buildTraceFromRow(traceRow, entries);
  }

  /**
   * Get all traces for a session, ordered by start time descending.
   * Each trace includes its entries.
   */
  async getTracesBySession(sessionId: string): Promise<ExecutionTrace[]> {
    const traceRows = this.stmtGetTracesBySession.all(sessionId) as TraceRow[];
    const traces: ExecutionTrace[] = [];

    for (const row of traceRows) {
      const entryRows = this.stmtGetEntriesByTrace.all(row.id) as TraceEntryRow[];
      const entries = entryRows.map(rowToTraceEntry);
      traces.push(buildTraceFromRow(row, entries));
    }

    return traces;
  }

  // ─── Diagnostics ──────────────────────────────────────────────

  /** Number of currently active (incomplete) traces. */
  getActiveTraceCount(): number {
    return this.activeTraces.size;
  }

  /** Check if a trace is currently active (started but not completed). */
  isTraceActive(traceId: string): boolean {
    return this.activeTraces.has(traceId);
  }

  // ─── Internal Helpers ─────────────────────────────────────────

  /**
   * Emit a real-time trace update through the CallbackEngine.
   * Uses 'after-tool-call' event as a generic notification channel
   * with trace-specific payload.
   */
  private emitTraceUpdate(
    traceId: string,
    updateType: 'trace-started' | 'entry-added' | 'trace-completed',
    data: Record<string, unknown>,
  ): void {
    if (!this.callbackEngine) return;

    const sessionId = 'sessionId' in data ? String(data['sessionId'] ?? '') : '';

    // Fire-and-forget; errors in hooks should not affect trace operations
    this.callbackEngine
      .emit({
        event: 'after-tool-call',
        toolName: `trace:${updateType}`,
        sessionId,
        iteration: 0,
        output: data,
      })
      .catch((err) => {
        console.warn(
          `[ExecutionTraceService] Failed to emit ${updateType} for trace ${traceId}:`,
          (err as Error)?.message,
        );
      });
  }
}

// ─── Row Mapping Helpers ────────────────────────────────────────

function buildTraceFromRow(row: TraceRow, entries: TraceEntry[]): ExecutionTrace {
  const trace: ExecutionTrace = {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id,
    entries,
    startedAt: row.started_at,
    totalDurationMs: row.total_duration_ms ?? 0,
    totalTokens: row.total_tokens ?? 0,
  };
  if (row.completed_at !== null) {
    trace.completedAt = row.completed_at;
  }
  return trace;
}

function rowToTraceEntry(row: TraceEntryRow): TraceEntry {
  const entry: TraceEntry = {
    id: row.id,
    traceId: row.trace_id,
    sequence: row.sequence,
    timestamp: row.timestamp,
    type: row.type as TraceEntry['type'],
  };

  if (row.tool_name !== null) {
    entry.toolName = row.tool_name;
  }
  if (row.parameters !== null) {
    const parsed = parseJson(row.parameters);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      entry.parameters = parsed as Record<string, unknown>;
    }
  }
  if (row.token_count !== null) {
    entry.tokenCount = row.token_count;
  }
  if (row.duration_ms !== null) {
    entry.durationMs = row.duration_ms;
  }
  if (row.result !== null) {
    entry.result = parseJson(row.result);
  }
  if (row.error !== null) {
    entry.error = row.error;
  }

  // Provenance fields (null when drift inactive)
  entry.correlationId = row.correlation_id;
  entry.parentEntryId = row.parent_entry_id;
  entry.intentPurpose = row.intent_purpose;
  entry.confidenceAtDecision = row.confidence_at_decision;

  return entry;
}

/**
 * Defensive JSON parser. Returns null for invalid JSON rather than throwing.
 */
function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
