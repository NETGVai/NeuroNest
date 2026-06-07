/**
 * Pipeline Trace Service — records timing spans for each pipeline step.
 * Provides OpenTelemetry-style waterfall data for the Session Inspector.
 *
 * Each chat message creates a "trace" with multiple "spans":
 *   - prompt_received
 *   - memory_recall
 *   - zera_optimization
 *   - context_loading
 *   - orchestrator_planning
 *   - agent_execution (one per agent)
 *   - memory_capture
 *   - lint_test (optional)
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface TraceSpan {
  id: string;
  traceId: string;
  sessionId: string;
  name: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  status: 'ok' | 'error' | 'running';
  metadata?: Record<string, unknown>;
  parentSpanId?: string;
}

export interface PipelineTrace {
  id: string;
  sessionId: string;
  prompt: string;
  startTime: number;
  endTime?: number;
  totalDurationMs?: number;
  spans: TraceSpan[];
}

export class PipelineTraceService {
  private db: Database.Database;
  private activeTraces: Map<string, { traceId: string; startTime: number; prompt: string }> = new Map();

  constructor(db: Database.Database) {
    this.db = db;
    this.ensureTable();
  }

  private ensureTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pipeline_traces (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          prompt TEXT NOT NULL,
          start_time INTEGER NOT NULL,
          end_time INTEGER,
          total_duration_ms INTEGER
        )
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pipeline_spans (
          id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          name TEXT NOT NULL,
          start_time INTEGER NOT NULL,
          end_time INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'ok',
          metadata TEXT,
          parent_span_id TEXT,
          FOREIGN KEY (trace_id) REFERENCES pipeline_traces(id)
        )
      `);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_pt_session ON pipeline_traces(session_id)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ps_trace ON pipeline_spans(trace_id)`);
    } catch (e: any) {
      console.warn('[PipelineTrace] Table creation failed:', e?.message);
    }
  }

  /**
   * Start a new trace for a pipeline execution.
   */
  startTrace(sessionId: string, prompt: string): string {
    const traceId = randomUUID();
    const startTime = Date.now();
    try {
      this.db.prepare(
        'INSERT INTO pipeline_traces (id, session_id, prompt, start_time) VALUES (?, ?, ?, ?)'
      ).run(traceId, sessionId, prompt.slice(0, 500), startTime);
      this.activeTraces.set(sessionId, { traceId, startTime, prompt: prompt.slice(0, 200) });
    } catch (e: any) {
      console.warn('[PipelineTrace] startTrace failed:', e?.message);
    }
    return traceId;
  }

  /**
   * Record a completed span within a trace.
   */
  recordSpan(traceId: string, sessionId: string, name: string, startTime: number, endTime: number, opts?: {
    status?: 'ok' | 'error';
    metadata?: Record<string, unknown>;
    parentSpanId?: string;
  }): string {
    const spanId = randomUUID();
    const durationMs = endTime - startTime;
    try {
      this.db.prepare(
        'INSERT INTO pipeline_spans (id, trace_id, session_id, name, start_time, end_time, duration_ms, status, metadata, parent_span_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(spanId, traceId, sessionId, name, startTime, endTime, durationMs, opts?.status || 'ok', opts?.metadata ? JSON.stringify(opts.metadata) : null, opts?.parentSpanId || null);
    } catch (e: any) {
      console.warn('[PipelineTrace] recordSpan failed:', e?.message);
    }
    return spanId;
  }

  /**
   * End a trace (mark total duration).
   */
  endTrace(sessionId: string): void {
    const active = this.activeTraces.get(sessionId);
    if (!active) return;
    const endTime = Date.now();
    const totalDurationMs = endTime - active.startTime;
    try {
      this.db.prepare(
        'UPDATE pipeline_traces SET end_time = ?, total_duration_ms = ? WHERE id = ?'
      ).run(endTime, totalDurationMs, active.traceId);
    } catch (e: any) {
      console.warn('[PipelineTrace] endTrace failed:', e?.message);
    }
    this.activeTraces.delete(sessionId);
  }

  /**
   * Get the active trace ID for a session.
   */
  getActiveTraceId(sessionId: string): string | null {
    const active = this.activeTraces.get(sessionId);
    return active ? active.traceId : null;
  }

  /**
   * Get recent traces for a session.
   */
  getTraces(sessionId: string, limit: number = 20): PipelineTrace[] {
    try {
      const rows = this.db.prepare(
        'SELECT * FROM pipeline_traces WHERE session_id = ? ORDER BY start_time DESC LIMIT ?'
      ).all(sessionId, limit) as any[];

      return rows.map(r => {
        const spans = this.db.prepare(
          'SELECT * FROM pipeline_spans WHERE trace_id = ? ORDER BY start_time ASC'
        ).all(r.id) as any[];

        return {
          id: r.id,
          sessionId: r.session_id,
          prompt: r.prompt,
          startTime: r.start_time,
          endTime: r.end_time || undefined,
          totalDurationMs: r.total_duration_ms || undefined,
          spans: spans.map(s => ({
            id: s.id,
            traceId: s.trace_id,
            sessionId: s.session_id,
            name: s.name,
            startTime: s.start_time,
            endTime: s.end_time,
            durationMs: s.duration_ms,
            status: s.status,
            metadata: s.metadata ? JSON.parse(s.metadata) : undefined,
            parentSpanId: s.parent_span_id || undefined,
          })),
        };
      });
    } catch (e: any) {
      console.warn('[PipelineTrace] getTraces failed:', e?.message);
      return [];
    }
  }

  /**
   * Get a single trace by ID.
   */
  getTrace(traceId: string): PipelineTrace | null {
    try {
      const row = this.db.prepare('SELECT * FROM pipeline_traces WHERE id = ?').get(traceId) as any;
      if (!row) return null;

      const spans = this.db.prepare(
        'SELECT * FROM pipeline_spans WHERE trace_id = ? ORDER BY start_time ASC'
      ).all(traceId) as any[];

      return {
        id: row.id,
        sessionId: row.session_id,
        prompt: row.prompt,
        startTime: row.start_time,
        endTime: row.end_time || undefined,
        totalDurationMs: row.total_duration_ms || undefined,
        spans: spans.map(s => ({
          id: s.id,
          traceId: s.trace_id,
          sessionId: s.session_id,
          name: s.name,
          startTime: s.start_time,
          endTime: s.end_time,
          durationMs: s.duration_ms,
          status: s.status,
          metadata: s.metadata ? JSON.parse(s.metadata) : undefined,
          parentSpanId: s.parent_span_id || undefined,
        })),
      };
    } catch {
      return null;
    }
  }
}
