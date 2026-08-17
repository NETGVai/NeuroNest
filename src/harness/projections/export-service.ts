/**
 * ExportService — Ordered JSON-lines export with manifest hashes and omission declarations.
 *
 * Provides:
 * - exportJsonLines: Ordered JSON-lines export of events within a sequence range.
 * - generateManifest: Compute manifest with content hash and omission declarations.
 * - Cancellable via AbortSignal.
 * - Bounded selection criteria (event count, byte limits).
 *
 * Requirements: 28.7–28.9
 */

import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────

export interface ExportRange {
  fromSequence?: number;
  toSequence?: number;
  maxEvents?: number;
  maxBytes?: number;
}

export interface ExportResult {
  exportId: string;
  sessionId: string;
  branchId: string;
  lines: string[];
  eventCount: number;
  totalBytes: number;
  fromSequence: number;
  toSequence: number;
  omittedSequences: number[];
  truncated: boolean;
}

export interface ExportManifest {
  exportId: string;
  sessionId: string;
  branchId: string;
  formatVersion: string;
  eventCount: number;
  fromSequence: number;
  toSequence: number;
  contentHash: string;
  integrityHashes: string[];
  lineageMetadata: Record<string, unknown>;
  omittedFields: OmissionDeclaration[];
  generatedAt: string;
}

export interface OmissionDeclaration {
  sequence: number;
  reason: string;
  omittedFields: string[];
}

export interface ExportServiceConfig {
  /** Default max events in an export */
  defaultMaxEvents: number;
  /** Absolute maximum events allowed */
  maxEventsLimit: number;
  /** Default max bytes for an export */
  defaultMaxBytes: number;
  /** Format version for the export */
  formatVersion: string;
}

// ─── ExportService ──────────────────────────────────────────────

export class ExportService {
  private readonly db: Database.Database;
  private readonly config: ExportServiceConfig;

  constructor(db: Database.Database, config: ExportServiceConfig) {
    this.db = db;
    this.config = config;
  }

  /**
   * Export events as ordered JSON-lines within a sequence range.
   * One versioned event record per line in session-sequence order.
   *
   * Requirements: 28.7–28.8
   */
  exportJsonLines(
    sessionId: string,
    branchId: string,
    range: ExportRange,
    signal?: AbortSignal
  ): ExportResult {
    if (signal?.aborted) {
      throw new ExportCancelledError('Export cancelled before start');
    }

    const exportId = crypto.randomUUID();
    const maxEvents = Math.min(
      range.maxEvents ?? this.config.defaultMaxEvents,
      this.config.maxEventsLimit
    );
    const maxBytes = range.maxBytes ?? this.config.defaultMaxBytes;

    // Build query with range filters
    let sql = `
      SELECT eventId, sessionId, branchId, sequence, schemaVersion, eventType, payload, integrityHash, occurredAt, actor, scope
      FROM harness_events
      WHERE sessionId = ? AND branchId = ?
    `;
    const bindings: unknown[] = [sessionId, branchId];

    if (range.fromSequence !== undefined) {
      sql += ` AND sequence >= ?`;
      bindings.push(range.fromSequence);
    }
    if (range.toSequence !== undefined) {
      sql += ` AND sequence <= ?`;
      bindings.push(range.toSequence);
    }

    sql += ` ORDER BY sequence ASC LIMIT ?`;
    bindings.push(maxEvents);

    if (signal?.aborted) {
      throw new ExportCancelledError('Export cancelled during preparation');
    }

    const events = this.db.prepare(sql).all(...bindings) as Array<{
      eventId: string;
      sessionId: string;
      branchId: string;
      sequence: number;
      schemaVersion: number;
      eventType: string;
      payload: string;
      integrityHash: string;
      occurredAt: string;
      actor: string;
      scope: string;
    }>;

    const lines: string[] = [];
    const omittedSequences: number[] = [];
    let totalBytes = 0;
    let truncated = false;
    let actualFromSeq = range.fromSequence ?? 0;
    let actualToSeq = 0;

    for (let i = 0; i < events.length; i++) {
      if (signal?.aborted) {
        throw new ExportCancelledError(`Export cancelled at sequence ${events[i].sequence}`);
      }

      const event = events[i];
      const line = JSON.stringify({
        eventId: event.eventId,
        sessionId: event.sessionId,
        branchId: event.branchId,
        sequence: event.sequence,
        schemaVersion: event.schemaVersion,
        eventType: event.eventType,
        payload: JSON.parse(event.payload),
        integrityHash: event.integrityHash,
        occurredAt: event.occurredAt,
      });

      const lineBytes = Buffer.byteLength(line, 'utf-8') + 1; // +1 for newline

      if (totalBytes + lineBytes > maxBytes) {
        truncated = true;
        // Record remaining events as omitted
        for (let j = i; j < events.length; j++) {
          omittedSequences.push(events[j].sequence);
        }
        break;
      }

      lines.push(line);
      totalBytes += lineBytes;

      if (i === 0) actualFromSeq = event.sequence;
      actualToSeq = event.sequence;
    }

    return {
      exportId,
      sessionId,
      branchId,
      lines,
      eventCount: lines.length,
      totalBytes,
      fromSequence: actualFromSeq,
      toSequence: actualToSeq,
      omittedSequences,
      truncated,
    };
  }

  /**
   * Generate a manifest with content hash, integrity hashes, and omission declarations.
   *
   * Requirements: 28.9
   */
  generateManifest(
    exportResult: ExportResult,
    lineageMetadata?: Record<string, unknown>
  ): ExportManifest {
    // Compute content hash over all exported lines
    const contentHash = this.computeContentHash(exportResult.lines);

    // Collect integrity hashes from the export data
    const integrityHashes = exportResult.lines.map(line => {
      const parsed = JSON.parse(line);
      return parsed.integrityHash as string;
    });

    // Build omission declarations
    const omittedFields: OmissionDeclaration[] = exportResult.omittedSequences.map(seq => ({
      sequence: seq,
      reason: exportResult.truncated ? 'byte_limit_exceeded' : 'retention_policy',
      omittedFields: ['payload', 'integrityHash', 'occurredAt'],
    }));

    return {
      exportId: exportResult.exportId,
      sessionId: exportResult.sessionId,
      branchId: exportResult.branchId,
      formatVersion: this.config.formatVersion,
      eventCount: exportResult.eventCount,
      fromSequence: exportResult.fromSequence,
      toSequence: exportResult.toSequence,
      contentHash,
      integrityHashes,
      lineageMetadata: lineageMetadata ?? {},
      omittedFields,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Verify an export's integrity by comparing manifest hash to actual content hash.
   */
  verifyManifest(manifest: ExportManifest, lines: string[]): boolean {
    const actualHash = this.computeContentHash(lines);
    return actualHash === manifest.contentHash;
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private computeContentHash(lines: string[]): string {
    const hasher = crypto.createHash('sha256');
    for (const line of lines) {
      hasher.update(line);
      hasher.update('\n');
    }
    return hasher.digest('hex');
  }
}

// ─── Errors ─────────────────────────────────────────────────────

export class ExportCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportCancelledError';
  }
}
