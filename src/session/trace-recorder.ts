/**
 * Trace Recorder — Structured audit trail extending PipelineTraceService.
 *
 * Records all agent actions, LLM calls, tool invocations, file modifications,
 * and errors during a session. Supports querying, replay with timing offsets,
 * and export with secrets redaction.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 7.1, 7.2, 7.3, 7.4, 7.5
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { EventBus } from '../events/event-bus.js';
import { FirewallEngine } from '../firewall/firewall-engine.js';
import { PipelineTraceService } from './pipeline-trace.js';
import { logger } from '../utils/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type TraceEntryType = 'prompt' | 'plan' | 'tool_call' | 'llm_call' | 'file_change' | 'error';

export type TraceStructuredData =
  | { type: 'prompt'; text: string }
  | { type: 'plan'; text: string; agentId: string; stepSequence: number }
  | { type: 'tool_call'; toolName: string; input: unknown; output: string; durationMs: number; success: boolean }
  | { type: 'llm_call'; model: string; promptTokens: number; completionTokens: number; latencyMs: number; responseSummary: string; measurementError?: boolean }
  | { type: 'file_change'; filePath: string; diff: string; toolCallId: string }
  | { type: 'error'; message: string; stackTrace: string; recoveryAction: string; causingStepId: string };

export interface TraceEntry {
  id: string;
  traceId: string;
  sessionId: string;
  sequenceNumber: number;
  entryType: TraceEntryType;
  timestamp: string; // ISO-8601 UTC
  structuredData: TraceStructuredData;
}

export interface TraceEntryInput {
  entryType: TraceEntryType;
  data: TraceStructuredData;
}

export interface TraceQueryFilters {
  sessionId?: string;
  startTime?: string;
  endTime?: string;
  entryType?: TraceEntryType;
  contentSubstring?: string;
}

export interface TraceReplayPage {
  entries: (TraceEntry & { offsetMs: number })[];
  totalEntries: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface TraceExportDocument {
  sessionId: string;
  startTimestamp: string;
  endTimestamp: string;
  totalEntryCount: number;
  agentId: string;
  entries: TraceEntry[];
}

// ─── Truncation Limits ───────────────────────────────────────────────────────

export const TRUNCATION_LIMITS = {
  prompt: 10_000,
  plan: 50_000,
  toolOutput: 100_000,
  fileDiff: 200_000,
  stackTrace: 10_000,
  llmSummary: 500,
} as const;

// ─── Options ─────────────────────────────────────────────────────────────────

export interface TraceRecorderOptions {
  db: Database.Database;
  eventBus?: EventBus;
  pipelineTraceService?: PipelineTraceService;
}

// ─── TraceRecorder Implementation ────────────────────────────────────────────

/**
 * Records structured audit trail entries for agent sessions.
 * Extends the existing PipelineTraceService by persisting entries
 * to the pipeline_spans table with entry_type, sequence_number,
 * and structured_data columns.
 */
export class TraceRecorder {
  private db: Database.Database;
  private eventBus?: EventBus;
  private pipelineTraceService?: PipelineTraceService;

  // Track sequence numbers per trace (monotonically increasing from 1)
  private sequenceCounters: Map<string, number> = new Map();
  // Track trace-to-session mapping
  private traceSessionMap: Map<string, string> = new Map();
  // Track session start times for replay offset calculation
  private sessionStartTimes: Map<string, number> = new Map();

  // Prepared statements
  private stmtInsertEntry!: Database.Statement;
  private stmtInsertTrace!: Database.Statement;
  private stmtQueryBySession!: Database.Statement;
  private stmtQueryByTraceId!: Database.Statement;
  private stmtCountBySession!: Database.Statement;

  constructor(options: TraceRecorderOptions) {
    this.db = options.db;
    this.eventBus = options.eventBus;
    this.pipelineTraceService = options.pipelineTraceService;

    this.initializePreparedStatements();
  }

  /**
   * Start a new trace for a session. Returns the trace ID.
   * Assigns sequence numbers starting at 1 for entries within this trace.
   */
  startSessionTrace(sessionId: string): string {
    const traceId = randomUUID();
    this.sequenceCounters.set(traceId, 0);
    this.traceSessionMap.set(traceId, sessionId);
    this.sessionStartTimes.set(sessionId, Date.now());

    // Insert a pipeline_traces record so foreign key constraints are satisfied
    try {
      this.stmtInsertTrace.run(traceId, sessionId, `session-trace:${traceId}`, Date.now());
    } catch (err) {
      logger.warn('[TraceRecorder] Failed to insert pipeline_traces record', {
        traceId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // If PipelineTraceService is available, start a trace there too
    if (this.pipelineTraceService) {
      this.pipelineTraceService.startTrace(sessionId, `session-trace:${traceId}`);
    }

    logger.info('[TraceRecorder] Started session trace', { sessionId, traceId });
    return traceId;
  }

  /**
   * Record a typed trace entry. Returns the entry ID.
   * Applies type-specific truncation and assigns a monotonically increasing sequence number.
   */
  recordEntry(traceId: string, entry: TraceEntryInput): string {
    const sessionId = this.traceSessionMap.get(traceId);
    if (!sessionId) {
      logger.warn('[TraceRecorder] Unknown traceId, cannot record entry', { traceId });
      return '';
    }

    // Increment sequence number
    const currentSeq = this.sequenceCounters.get(traceId) ?? 0;
    const sequenceNumber = currentSeq + 1;
    this.sequenceCounters.set(traceId, sequenceNumber);

    // Apply truncation to structured data
    const truncatedData = this.applyTruncation(entry.data);

    // Flag measurement errors for LLM entries
    const finalData = this.flagMeasurementErrors(truncatedData);

    const entryId = randomUUID();
    const timestamp = new Date().toISOString();

    const traceEntry: TraceEntry = {
      id: entryId,
      traceId,
      sessionId,
      sequenceNumber,
      entryType: entry.entryType,
      timestamp,
      structuredData: finalData,
    };

    // Persist to SQLite
    this.persistEntry(traceEntry);

    // Also record as a span in PipelineTraceService for integration
    if (this.pipelineTraceService) {
      const now = Date.now();
      this.pipelineTraceService.recordSpan(
        traceId,
        sessionId,
        `trace:${entry.entryType}`,
        now,
        now,
        {
          status: entry.entryType === 'error' ? 'error' : 'ok',
          metadata: {
            entryId,
            entryType: entry.entryType,
            sequenceNumber,
            structuredData: finalData,
          },
        }
      );
    }

    return entryId;
  }

  /**
   * Query entries by filters. Returns entries matching ALL specified criteria.
   */
  queryEntries(filters: TraceQueryFilters): TraceEntry[] {
    try {
      let sql = `
        SELECT id, trace_id, session_id, sequence_number, entry_type, start_time, structured_data
        FROM pipeline_spans
        WHERE entry_type IS NOT NULL
      `;
      const params: unknown[] = [];

      if (filters.sessionId) {
        sql += ' AND session_id = ?';
        params.push(filters.sessionId);
      }

      if (filters.startTime) {
        sql += ' AND start_time >= ?';
        params.push(new Date(filters.startTime).getTime());
      }

      if (filters.endTime) {
        sql += ' AND start_time <= ?';
        params.push(new Date(filters.endTime).getTime());
      }

      if (filters.entryType) {
        sql += ' AND entry_type = ?';
        params.push(filters.entryType);
      }

      if (filters.contentSubstring) {
        sql += ' AND structured_data LIKE ?';
        params.push(`%${filters.contentSubstring}%`);
      }

      sql += ' ORDER BY sequence_number ASC';

      const rows = this.db.prepare(sql).all(...params) as any[];
      return rows.map(row => this.rowToTraceEntry(row));
    } catch (err) {
      logger.error('[TraceRecorder] queryEntries failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Get replay data with timing offsets from session start.
   * Supports pagination with default page size of 100, max 500.
   */
  getReplay(sessionId: string, page: number, pageSize?: number): TraceReplayPage {
    // Enforce pagination constraints
    const effectivePageSize = Math.min(Math.max(pageSize ?? 100, 1), 500);
    const effectivePage = Math.max(page, 1);
    const offset = (effectivePage - 1) * effectivePageSize;

    try {
      // Get total count
      const countRow = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM pipeline_spans
        WHERE session_id = ? AND entry_type IS NOT NULL
      `).get(sessionId) as any;
      const totalEntries = countRow?.count ?? 0;

      if (totalEntries === 0) {
        return {
          entries: [],
          totalEntries: 0,
          page: effectivePage,
          pageSize: effectivePageSize,
          hasMore: false,
        };
      }

      // Get the session start time (first entry's timestamp)
      const firstRow = this.db.prepare(`
        SELECT start_time
        FROM pipeline_spans
        WHERE session_id = ? AND entry_type IS NOT NULL
        ORDER BY sequence_number ASC
        LIMIT 1
      `).get(sessionId) as any;
      const sessionStartTime = firstRow?.start_time ?? 0;

      // Get paginated entries
      const rows = this.db.prepare(`
        SELECT id, trace_id, session_id, sequence_number, entry_type, start_time, structured_data
        FROM pipeline_spans
        WHERE session_id = ? AND entry_type IS NOT NULL
        ORDER BY sequence_number ASC
        LIMIT ? OFFSET ?
      `).all(sessionId, effectivePageSize, offset) as any[];

      const entries = rows.map(row => {
        const entry = this.rowToTraceEntry(row);
        const offsetMs = row.start_time - sessionStartTime;
        return { ...entry, offsetMs };
      });

      return {
        entries,
        totalEntries,
        page: effectivePage,
        pageSize: effectivePageSize,
        hasMore: offset + entries.length < totalEntries,
      };
    } catch (err) {
      logger.error('[TraceRecorder] getReplay failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        entries: [],
        totalEntries: 0,
        page: effectivePage,
        pageSize: effectivePageSize,
        hasMore: false,
      };
    }
  }

  /**
   * Export a complete session trace as a JSON document with secrets redaction.
   * Aborts entirely if redaction fails (no partial output).
   */
  exportTrace(sessionId: string, firewallEngine: FirewallEngine): TraceExportDocument {
    // Get all entries for the session
    const rows = this.db.prepare(`
      SELECT id, trace_id, session_id, sequence_number, entry_type, start_time, structured_data
      FROM pipeline_spans
      WHERE session_id = ? AND entry_type IS NOT NULL
      ORDER BY sequence_number ASC
    `).all(sessionId) as any[];

    if (rows.length === 0) {
      return {
        sessionId,
        startTimestamp: '',
        endTimestamp: '',
        totalEntryCount: 0,
        agentId: '',
        entries: [],
      };
    }

    // Convert rows to entries
    const entries = rows.map(row => this.rowToTraceEntry(row));

    // Apply secrets redaction to all entries
    const redactedEntries: TraceEntry[] = [];
    for (const entry of entries) {
      try {
        const redacted = this.redactEntry(entry, firewallEngine);
        redactedEntries.push(redacted);
      } catch (err) {
        // Abort export entirely on redaction failure
        logger.error('[TraceRecorder] Export aborted: redaction failed', {
          sessionId,
          entryId: entry.id,
          error: err instanceof Error ? err.message : String(err),
        });
        throw new Error(`Export aborted: redaction could not be completed for entry ${entry.id}`);
      }
    }

    // Extract agent ID from plan entries if available
    let agentId = '';
    for (const entry of entries) {
      if (entry.structuredData.type === 'plan') {
        agentId = entry.structuredData.agentId;
        break;
      }
    }

    const startTimestamp = entries[0].timestamp;
    const endTimestamp = entries[entries.length - 1].timestamp;

    return {
      sessionId,
      startTimestamp,
      endTimestamp,
      totalEntryCount: redactedEntries.length,
      agentId,
      entries: redactedEntries,
    };
  }

  // ─── Private Methods ─────────────────────────────────────────────────────────

  private initializePreparedStatements(): void {
    this.stmtInsertTrace = this.db.prepare(`
      INSERT INTO pipeline_traces (id, session_id, prompt, start_time)
      VALUES (?, ?, ?, ?)
    `);

    this.stmtInsertEntry = this.db.prepare(`
      INSERT INTO pipeline_spans (id, trace_id, session_id, name, start_time, end_time, duration_ms, status, metadata, parent_span_id, entry_type, sequence_number, structured_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtQueryBySession = this.db.prepare(`
      SELECT id, trace_id, session_id, sequence_number, entry_type, start_time, structured_data
      FROM pipeline_spans
      WHERE session_id = ? AND entry_type IS NOT NULL
      ORDER BY sequence_number ASC
    `);

    this.stmtQueryByTraceId = this.db.prepare(`
      SELECT id, trace_id, session_id, sequence_number, entry_type, start_time, structured_data
      FROM pipeline_spans
      WHERE trace_id = ? AND entry_type IS NOT NULL
      ORDER BY sequence_number ASC
    `);

    this.stmtCountBySession = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM pipeline_spans
      WHERE session_id = ? AND entry_type IS NOT NULL
    `);
  }

  /**
   * Persist a trace entry to the pipeline_spans table.
   */
  private persistEntry(entry: TraceEntry): void {
    try {
      const now = Date.now();
      this.stmtInsertEntry.run(
        entry.id,
        entry.traceId,
        entry.sessionId,
        `trace:${entry.entryType}`, // name column
        now,                         // start_time
        now,                         // end_time
        0,                           // duration_ms
        entry.entryType === 'error' ? 'error' : 'ok', // status
        null,                        // metadata (structured_data used instead)
        null,                        // parent_span_id
        entry.entryType,             // entry_type
        entry.sequenceNumber,        // sequence_number
        JSON.stringify(entry.structuredData), // structured_data
      );
    } catch (err) {
      logger.error('[TraceRecorder] Failed to persist entry', {
        entryId: entry.id,
        traceId: entry.traceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Apply type-specific truncation limits to structured data.
   */
  private applyTruncation(data: TraceStructuredData): TraceStructuredData {
    switch (data.type) {
      case 'prompt':
        return {
          ...data,
          text: truncate(data.text, TRUNCATION_LIMITS.prompt),
        };
      case 'plan':
        return {
          ...data,
          text: truncate(data.text, TRUNCATION_LIMITS.plan),
        };
      case 'tool_call':
        return {
          ...data,
          output: truncate(data.output, TRUNCATION_LIMITS.toolOutput),
        };
      case 'llm_call':
        return {
          ...data,
          responseSummary: truncate(data.responseSummary, TRUNCATION_LIMITS.llmSummary),
        };
      case 'file_change':
        return {
          ...data,
          diff: truncate(data.diff, TRUNCATION_LIMITS.fileDiff),
        };
      case 'error':
        return {
          ...data,
          stackTrace: truncate(data.stackTrace, TRUNCATION_LIMITS.stackTrace),
        };
      default:
        return data;
    }
  }

  /**
   * Flag zero-token/zero-latency LLM entries as measurement errors.
   * Skips recording zero-value fields by marking them.
   */
  private flagMeasurementErrors(data: TraceStructuredData): TraceStructuredData {
    if (data.type !== 'llm_call') return data;

    const hasZeroTokens = data.promptTokens === 0 && data.completionTokens === 0;
    const hasZeroLatency = data.latencyMs === 0;

    if (hasZeroTokens || hasZeroLatency) {
      return {
        ...data,
        measurementError: true,
      };
    }

    return data;
  }

  /**
   * Convert a database row to a TraceEntry.
   */
  private rowToTraceEntry(row: any): TraceEntry {
    const structuredData = row.structured_data ? JSON.parse(row.structured_data) : {};
    const timestamp = row.start_time
      ? new Date(row.start_time).toISOString()
      : new Date().toISOString();

    return {
      id: row.id,
      traceId: row.trace_id,
      sessionId: row.session_id,
      sequenceNumber: row.sequence_number ?? 0,
      entryType: row.entry_type as TraceEntryType,
      timestamp,
      structuredData,
    };
  }

  /**
   * Redact secrets from a trace entry using the FirewallEngine.
   */
  private redactEntry(entry: TraceEntry, firewallEngine: FirewallEngine): TraceEntry {
    const redactedData = this.redactStructuredData(entry.structuredData, firewallEngine);
    return {
      ...entry,
      structuredData: redactedData,
    };
  }

  /**
   * Redact secrets from structured data fields.
   */
  private redactStructuredData(data: TraceStructuredData, firewallEngine: FirewallEngine): TraceStructuredData {
    switch (data.type) {
      case 'prompt':
        return {
          ...data,
          text: this.redactString(data.text, firewallEngine),
        };
      case 'plan':
        return {
          ...data,
          text: this.redactString(data.text, firewallEngine),
        };
      case 'tool_call':
        return {
          ...data,
          input: this.redactUnknown(data.input, firewallEngine),
          output: this.redactString(data.output, firewallEngine),
        };
      case 'llm_call':
        return {
          ...data,
          responseSummary: this.redactString(data.responseSummary, firewallEngine),
        };
      case 'file_change':
        return {
          ...data,
          diff: this.redactString(data.diff, firewallEngine),
        };
      case 'error':
        return {
          ...data,
          message: this.redactString(data.message, firewallEngine),
          stackTrace: this.redactString(data.stackTrace, firewallEngine),
        };
      default:
        return data;
    }
  }

  /**
   * Redact secrets from a string using the FirewallEngine's secrets detection.
   */
  private redactString(text: string, firewallEngine: FirewallEngine): string {
    if (!text) return text;

    const result = firewallEngine.evaluate(text);
    // The firewall engine's sanitized output has secrets removed/blocked
    // We use the events to identify and redact secret patterns
    let redacted = text;
    for (const event of result.events) {
      if (event.category === 'secrets' && event.match) {
        redacted = redacted.replace(event.match, '[REDACTED]');
      }
    }
    return redacted;
  }

  /**
   * Redact secrets from an unknown value (serialize to string, redact, parse back).
   */
  private redactUnknown(value: unknown, firewallEngine: FirewallEngine): unknown {
    if (value === null || value === undefined) return value;
    const serialized = JSON.stringify(value);
    const redacted = this.redactString(serialized, firewallEngine);
    try {
      return JSON.parse(redacted);
    } catch {
      return redacted;
    }
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Truncate a string to the specified maximum length.
 */
function truncate(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}
