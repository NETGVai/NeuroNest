/**
 * LegacySessionAdapter — Reads legacy sessions through upcasters to provide
 * canonical SessionEventV1 views for projection and export.
 *
 * This adapter enables prior sessions (stored in legacy format) to be read,
 * projected, and exported through the canonical pipeline without migration.
 * It never modifies or overwrites the original stored data.
 *
 * Key behaviors:
 * - Reads legacy timeline records, messages, and branch events from the database
 * - Upcasts them to canonical SessionEventV1 format on-the-fly
 * - Supports downcast views for backward-compatible export
 * - Preserves branch readability (child branches maintain lineage)
 * - Ensures export integrity (old data exported correctly)
 *
 * Requirements: 3.3, 28.4–28.9, 31.9, 32.4, 44.13
 */

import type Database from 'better-sqlite3';
import type { SessionEventV1 } from '../../contracts/event.js';
import type {
  LegacyTimelineRecord,
  LegacyMessage,
  LegacyBranchEvent,
  LegacyBranchRecord,
  UpcastResult,
  DowncastView,
  LegacyDataUpcasterRegistry,
} from './types.js';
import { upcastTimelineRecord } from './timeline-record-upcaster.js';
import { upcastMessage } from './message-upcaster.js';
import { upcastBranchEvent } from './branch-event-upcaster.js';
import {
  downcastToTimelineRecord,
  downcastToMessage,
  downcastToBranchEvent,
} from './downcast-views.js';

// ─── Adapter Configuration ──────────────────────────────────────

export interface LegacySessionAdapterConfig {
  /** Maximum number of events to read per query (bounded retrieval) */
  maxEventsPerQuery: number;
  /** The target canonical schema version for upcast events */
  targetSchemaVersion: number;
  /** Whether to include provenance metadata (_legacy* fields) in upcast events */
  includeProvenance: boolean;
}

const DEFAULT_CONFIG: LegacySessionAdapterConfig = {
  maxEventsPerQuery: 1000,
  targetSchemaVersion: 1,
  includeProvenance: true,
};

// ─── Adapter Result Types ───────────────────────────────────────

export interface LegacyReadResult {
  /** Upcast canonical events derived from legacy data */
  events: SessionEventV1[];
  /** Provenance records for each upcast operation */
  provenance: UpcastResult[];
  /** Total legacy records found */
  totalLegacyRecords: number;
  /** Whether the result was truncated by maxEventsPerQuery */
  truncated: boolean;
}

export interface LegacyExportResult {
  /** JSON-lines export of legacy data in canonical format */
  lines: string[];
  /** Manifest of what was exported and what was omitted */
  exportedCount: number;
  /** Source records that could not be upcast (corrupt, etc.) */
  failedRecords: Array<{ id: string; reason: string }>;
}

// ─── LegacySessionAdapter ───────────────────────────────────────

/**
 * Adapter that reads legacy session data and presents it through
 * canonical SessionEventV1 views via pure upcasters.
 *
 * This adapter:
 * - NEVER writes to or modifies the legacy tables
 * - ALWAYS produces new derived objects
 * - Provides both upcast (legacy → canonical) and downcast (canonical → legacy) views
 * - Preserves complete branch lineage for readability
 */
export class LegacySessionAdapter implements LegacyDataUpcasterRegistry {
  private readonly db: Database.Database;
  private readonly config: LegacySessionAdapterConfig;

  constructor(db: Database.Database, config?: Partial<LegacySessionAdapterConfig>) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Upcast Operations ──────────────────────────────────────────

  /**
   * Read and upcast legacy timeline records for a session.
   * Returns canonical events without modifying the source data.
   */
  readLegacyTimeline(
    sessionId: string,
    options?: { fromSequence?: number; toSequence?: number; branchId?: string },
  ): LegacyReadResult {
    const branchId = options?.branchId ?? 'main';
    const records = this.queryTimelineRecords(sessionId, options?.fromSequence, options?.toSequence);

    const events: SessionEventV1[] = [];
    const provenance: UpcastResult[] = [];
    const truncated = records.length >= this.config.maxEventsPerQuery;

    for (const record of records) {
      const result = upcastTimelineRecord(record, { sessionId, branchId });
      events.push(result.event);
      provenance.push(result);
    }

    return {
      events,
      provenance,
      totalLegacyRecords: records.length,
      truncated,
    };
  }

  /**
   * Read and upcast legacy messages for a session.
   * Returns canonical message events without modifying source data.
   */
  readLegacyMessages(
    sessionId: string,
    branchId: string = 'main',
  ): LegacyReadResult {
    const messages = this.queryMessages(sessionId);

    const events: SessionEventV1[] = [];
    const provenance: UpcastResult[] = [];

    for (let i = 0; i < messages.length; i++) {
      const result = upcastMessage(messages[i], {
        sessionId,
        branchId,
        sequence: i + 1,
      });
      events.push(result.event);
      provenance.push(result);
    }

    return {
      events,
      provenance,
      totalLegacyRecords: messages.length,
      truncated: messages.length >= this.config.maxEventsPerQuery,
    };
  }

  /**
   * Read and upcast a legacy branch with all its events.
   * Preserves lineage metadata for branch readability.
   */
  readLegacyBranch(
    sessionId: string,
    branchId: string,
  ): LegacyReadResult {
    const branch = this.queryBranch(sessionId, branchId);
    if (!branch) {
      return { events: [], provenance: [], totalLegacyRecords: 0, truncated: false };
    }

    const events: SessionEventV1[] = [];
    const provenance: UpcastResult[] = [];

    for (const branchEvent of branch.events) {
      const result = upcastBranchEvent(branchEvent, {
        sessionId,
        branchId,
        parentBranchId: branch.parentBranchId,
      });
      events.push(result.event);
      provenance.push(result);
    }

    return {
      events,
      provenance,
      totalLegacyRecords: branch.events.length,
      truncated: branch.events.length >= this.config.maxEventsPerQuery,
    };
  }

  /**
   * Export legacy session data as canonical JSON-lines.
   * Preserves export integrity by including provenance and omission declarations.
   */
  exportLegacySession(sessionId: string): LegacyExportResult {
    const { events, provenance } = this.readLegacyTimeline(sessionId);
    const lines: string[] = [];
    const failedRecords: Array<{ id: string; reason: string }> = [];

    for (let i = 0; i < events.length; i++) {
      try {
        const line = JSON.stringify({
          ...events[i],
          _exportProvenance: {
            sourceVersion: provenance[i].sourceVersion,
            sourceId: provenance[i].sourceId,
            lossy: provenance[i].lossy,
            lossNotes: provenance[i].lossNotes,
          },
        });
        lines.push(line);
      } catch (err) {
        failedRecords.push({
          id: provenance[i].sourceId,
          reason: err instanceof Error ? err.message : 'Unknown serialization error',
        });
      }
    }

    return {
      lines,
      exportedCount: lines.length,
      failedRecords,
    };
  }

  // ─── LegacyDataUpcasterRegistry Implementation ─────────────────

  upcastTimelineRecord(
    record: LegacyTimelineRecord,
    sessionMetadata: { sessionId: string; branchId?: string },
  ): UpcastResult {
    return upcastTimelineRecord(record, sessionMetadata);
  }

  upcastMessage(
    message: LegacyMessage,
    context: { sessionId: string; branchId: string; sequence: number },
  ): UpcastResult {
    return upcastMessage(message, context);
  }

  upcastBranchEvent(
    event: LegacyBranchEvent,
    context: { sessionId: string; branchId: string; parentBranchId?: string },
  ): UpcastResult {
    return upcastBranchEvent(event, context);
  }

  downcastToTimelineRecord(event: SessionEventV1): DowncastView<LegacyTimelineRecord> {
    return downcastToTimelineRecord(event);
  }

  downcastToMessage(event: SessionEventV1): DowncastView<LegacyMessage> | null {
    return downcastToMessage(event);
  }

  downcastToBranchEvent(event: SessionEventV1): DowncastView<LegacyBranchEvent> {
    return downcastToBranchEvent(event);
  }

  // ─── Private Database Queries (Read-Only) ─────────────────────

  private queryTimelineRecords(
    sessionId: string,
    fromSequence?: number,
    toSequence?: number,
  ): LegacyTimelineRecord[] {
    let sql = `SELECT id, session_id, sequence_number, event_type, payload, linked_change_set_ids, linked_tool_event_ids, created_at
               FROM session_timeline_records
               WHERE session_id = ?`;
    const params: unknown[] = [sessionId];

    if (fromSequence !== undefined) {
      sql += ' AND sequence_number >= ?';
      params.push(fromSequence);
    }
    if (toSequence !== undefined) {
      sql += ' AND sequence_number <= ?';
      params.push(toSequence);
    }

    sql += ` ORDER BY sequence_number ASC LIMIT ?`;
    params.push(this.config.maxEventsPerQuery);

    try {
      const rows = this.db.prepare(sql).all(...params) as Array<{
        id: string;
        session_id: string;
        sequence_number: number;
        event_type: string;
        payload: string;
        linked_change_set_ids: string;
        linked_tool_event_ids: string;
        created_at: string;
      }>;

      return rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        sequenceNumber: row.sequence_number,
        eventType: row.event_type,
        payload: JSON.parse(row.payload),
        linkedChangeSetIds: JSON.parse(row.linked_change_set_ids || '[]'),
        linkedToolEventIds: JSON.parse(row.linked_tool_event_ids || '[]'),
        createdAt: row.created_at,
      }));
    } catch {
      // Table may not exist in new databases — return empty gracefully
      return [];
    }
  }

  private queryMessages(sessionId: string): LegacyMessage[] {
    try {
      const rows = this.db.prepare(
        `SELECT id, role, content, agent, tool_calls, created_at
         FROM session_messages
         WHERE session_id = ?
         ORDER BY created_at ASC
         LIMIT ?`
      ).all(sessionId, this.config.maxEventsPerQuery) as Array<{
        id: string;
        role: string;
        content: string;
        agent: string | null;
        tool_calls: string | null;
        created_at: string;
      }>;

      return rows.map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        agent: row.agent ?? undefined,
        toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
        createdAt: row.created_at,
      }));
    } catch {
      // Table may not exist — return empty gracefully
      return [];
    }
  }

  private queryBranch(sessionId: string, branchId: string): LegacyBranchRecord | null {
    try {
      const branchRow = this.db.prepare(
        `SELECT id, session_id, parent_branch_id, parent_sequence, name, created_at
         FROM session_branches
         WHERE session_id = ? AND id = ?`
      ).get(sessionId, branchId) as {
        id: string;
        session_id: string;
        parent_branch_id: string | null;
        parent_sequence: number | null;
        name: string | null;
        created_at: string;
      } | undefined;

      if (!branchRow) return null;

      const eventRows = this.db.prepare(
        `SELECT id, sequence_number, event_type, payload, created_at
         FROM session_branch_events
         WHERE branch_id = ?
         ORDER BY sequence_number ASC
         LIMIT ?`
      ).all(branchId, this.config.maxEventsPerQuery) as Array<{
        id: string;
        sequence_number: number;
        event_type: string;
        payload: string;
        created_at: string;
      }>;

      return {
        id: branchRow.id,
        sessionId: branchRow.session_id,
        parentBranchId: branchRow.parent_branch_id ?? undefined,
        parentSequence: branchRow.parent_sequence ?? undefined,
        name: branchRow.name ?? undefined,
        createdAt: branchRow.created_at,
        events: eventRows.map((row) => ({
          id: row.id,
          sequenceNumber: row.sequence_number,
          type: row.event_type,
          payload: JSON.parse(row.payload),
          createdAt: row.created_at,
        })),
      };
    } catch {
      // Table may not exist — return null gracefully
      return null;
    }
  }
}
