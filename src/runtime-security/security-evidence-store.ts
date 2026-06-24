/**
 * Security Evidence Store — Persists CISO-ready audit records to SQLite.
 *
 * Captures and persists evidence of all security decisions, vulnerability
 * detections, and remediations with full traceability. Integrates with
 * ComplianceGateRunner by providing security evidence as supporting
 * documentation for compliance audit results.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import type { CallbackEngine } from '../pipeline/callback-engine.js';
import type {
  ThreatSeverity,
  SecurityDecision,
  SecurityEventType,
} from './types.js';

// ─── Interfaces ─────────────────────────────────────────────────

/**
 * A single immutable, timestamped entry capturing a security decision,
 * finding, or remediation action.
 */
export interface SecurityEvidenceRecord {
  /** Unique identifier (uuidv7). */
  id: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Source subsystem (e.g., 'hackability_scoring', 'threat_modeler'). */
  sourceSubsystem: string;
  /** Type of security event. */
  eventType: SecurityEventType;
  /** Severity of the finding. */
  severity: ThreatSeverity;
  /** Files affected by this finding. */
  affectedFiles: string[];
  /** JSON-encoded finding payload. */
  findingDetails: string;
  /** Decision taken (blocked/warned/allowed). */
  decision: SecurityDecision;
  /** Session identifier. */
  sessionId: string;
  /** Links to original finding if this is a remediation. */
  remediationLinkId?: string;
}

/**
 * Filter criteria for querying evidence records.
 */
export interface EvidenceQuery {
  /** Filter by time range (ISO 8601 strings). */
  timeRange?: { from: string; to: string };
  /** Filter by severity levels. */
  severity?: ThreatSeverity[];
  /** Filter by source subsystems. */
  subsystem?: string[];
  /** Filter by session ID. */
  sessionId?: string;
  /** Filter by event types. */
  eventType?: SecurityEventType[];
}

// ─── Database interface ─────────────────────────────────────────

/**
 * Minimal database interface compatible with better-sqlite3.
 * Allows dependency injection for testing.
 */
export interface DatabaseLike {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
  };
  exec(sql: string): void;
}

// ─── UUID v7 Generator ──────────────────────────────────────────

/**
 * Generates a UUID v7 identifier.
 *
 * UUID v7 encodes a Unix timestamp in milliseconds in the first 48 bits,
 * followed by version (4 bits), random (12 bits), variant (2 bits),
 * and more random (62 bits).
 */
function generateUuidV7(): string {
  const timestamp = Date.now();

  // 48-bit timestamp
  const timestampHex = timestamp.toString(16).padStart(12, '0');

  // Random bytes for the remaining bits
  const randomBytes = new Uint8Array(10);
  // Use crypto.getRandomValues if available, otherwise Math.random fallback
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(randomBytes);
  } else {
    for (let i = 0; i < randomBytes.length; i++) {
      randomBytes[i] = Math.floor(Math.random() * 256);
    }
  }

  // Build UUID v7 string:
  // xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
  // Where: first 12 hex = timestamp, 7 = version, y = variant (8, 9, a, b)
  const timeLow = timestampHex.slice(0, 8);
  const timeMid = timestampHex.slice(8, 12);

  // Version 7: set top 4 bits of next segment to 0111
  const randA = ((randomBytes[0]! & 0x0f) | 0x70).toString(16).padStart(2, '0') +
    randomBytes[1]!.toString(16).padStart(2, '0');

  // Variant 10xx: set top 2 bits of next byte to 10
  const variantByte = ((randomBytes[2]! & 0x3f) | 0x80).toString(16).padStart(2, '0');
  const randB = variantByte +
    randomBytes[3]!.toString(16).padStart(2, '0') +
    '-' +
    randomBytes[4]!.toString(16).padStart(2, '0') +
    randomBytes[5]!.toString(16).padStart(2, '0') +
    randomBytes[6]!.toString(16).padStart(2, '0') +
    randomBytes[7]!.toString(16).padStart(2, '0') +
    randomBytes[8]!.toString(16).padStart(2, '0') +
    randomBytes[9]!.toString(16).padStart(2, '0');

  return `${timeLow}-${timeMid}-${randA}-${randB}`;
}

// ─── Database Row Type ──────────────────────────────────────────

interface SecurityEvidenceRow {
  id: string;
  timestamp: string;
  source_subsystem: string;
  event_type: string;
  severity: string;
  affected_files: string;
  finding_details: string;
  decision: string;
  session_id: string;
  remediation_link_id: string | null;
}

// ─── SecurityEvidenceStore ──────────────────────────────────────

/**
 * Persists security evidence records to SQLite and supports
 * querying for audit, compliance, and traceability purposes.
 */
export class SecurityEvidenceStore {
  private readonly db: DatabaseLike;
  private readonly callbackEngine: CallbackEngine;

  constructor(db: DatabaseLike, callbackEngine: CallbackEngine) {
    this.db = db;
    this.callbackEngine = callbackEngine;

    // Subscribe to security-relevant lifecycle events for automatic recording
    this.callbackEngine.register('after-tool-call', (context) => {
      // The store is event-driven; other subsystems persist via direct record() calls
      // This hook exists for future integration — subsystems call record() directly
      void context;
    });
  }

  /**
   * Returns the SQL statements to create the security_evidence table and indexes.
   * Should be executed once during database initialization.
   */
  static getTableCreationSQL(): string {
    return `CREATE TABLE IF NOT EXISTS security_evidence (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  source_subsystem TEXT NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  affected_files TEXT NOT NULL,
  finding_details TEXT NOT NULL,
  decision TEXT NOT NULL,
  session_id TEXT NOT NULL,
  remediation_link_id TEXT,
  FOREIGN KEY (remediation_link_id) REFERENCES security_evidence(id)
);
CREATE INDEX IF NOT EXISTS idx_security_evidence_session ON security_evidence(session_id);
CREATE INDEX IF NOT EXISTS idx_security_evidence_timestamp ON security_evidence(timestamp);
CREATE INDEX IF NOT EXISTS idx_security_evidence_severity ON security_evidence(severity);
CREATE INDEX IF NOT EXISTS idx_security_evidence_subsystem ON security_evidence(source_subsystem);`;
  }

  /**
   * Persist a security evidence record.
   *
   * Generates a uuidv7 ID and ISO 8601 timestamp, then inserts
   * the record into the security_evidence table.
   *
   * @param evidence - Record data (without id and timestamp, which are generated).
   * @returns The complete persisted SecurityEvidenceRecord.
   */
  record(
    evidence: Omit<SecurityEvidenceRecord, 'id' | 'timestamp'>,
  ): SecurityEvidenceRecord {
    const id = generateUuidV7();
    const timestamp = new Date().toISOString();

    const record: SecurityEvidenceRecord = {
      id,
      timestamp,
      ...evidence,
    };

    const stmt = this.db.prepare(
      `INSERT INTO security_evidence (id, timestamp, source_subsystem, event_type, severity, affected_files, finding_details, decision, session_id, remediation_link_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    stmt.run(
      record.id,
      record.timestamp,
      record.sourceSubsystem,
      record.eventType,
      record.severity,
      JSON.stringify(record.affectedFiles),
      record.findingDetails,
      record.decision,
      record.sessionId,
      record.remediationLinkId ?? null,
    );

    return record;
  }

  /**
   * Link a remediation record to an original finding (finding-to-fix chain).
   *
   * Updates the remediation record's remediation_link_id to point to the
   * original finding record.
   *
   * @param findingId - The ID of the original finding record.
   * @param remediationId - The ID of the remediation record to link.
   */
  linkRemediation(findingId: string, remediationId: string): void {
    const stmt = this.db.prepare(
      `UPDATE security_evidence SET remediation_link_id = ? WHERE id = ?`,
    );
    stmt.run(findingId, remediationId);
  }

  /**
   * Query evidence records with dynamic filters.
   *
   * Supports filtering by time range, severity, subsystem, sessionId,
   * and eventType. All filters are combined with AND logic.
   *
   * @param filter - The query filters to apply.
   * @returns Array of matching SecurityEvidenceRecord entries.
   */
  query(filter: EvidenceQuery): SecurityEvidenceRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.timeRange) {
      conditions.push('timestamp >= ? AND timestamp <= ?');
      params.push(filter.timeRange.from, filter.timeRange.to);
    }

    if (filter.severity && filter.severity.length > 0) {
      const placeholders = filter.severity.map(() => '?').join(', ');
      conditions.push(`severity IN (${placeholders})`);
      params.push(...filter.severity);
    }

    if (filter.subsystem && filter.subsystem.length > 0) {
      const placeholders = filter.subsystem.map(() => '?').join(', ');
      conditions.push(`source_subsystem IN (${placeholders})`);
      params.push(...filter.subsystem);
    }

    if (filter.sessionId) {
      conditions.push('session_id = ?');
      params.push(filter.sessionId);
    }

    if (filter.eventType && filter.eventType.length > 0) {
      const placeholders = filter.eventType.map(() => '?').join(', ');
      conditions.push(`event_type IN (${placeholders})`);
      params.push(...filter.eventType);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `SELECT * FROM security_evidence ${whereClause} ORDER BY timestamp ASC`;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as SecurityEvidenceRow[];

    return rows.map((row) => this.rowToRecord(row));
  }

  /**
   * Get evidence for ComplianceGateRunner integration.
   *
   * Returns all records for a given session, formatted as supporting
   * documentation for compliance audit results.
   *
   * @param sessionId - The session to retrieve evidence for.
   * @returns Array of SecurityEvidenceRecord entries for the session.
   */
  getComplianceEvidence(sessionId: string): SecurityEvidenceRecord[] {
    const stmt = this.db.prepare(
      `SELECT * FROM security_evidence WHERE session_id = ? ORDER BY timestamp ASC`,
    );
    const rows = stmt.all(sessionId) as SecurityEvidenceRow[];

    return rows.map((row) => this.rowToRecord(row));
  }

  /**
   * Convert a database row to a SecurityEvidenceRecord.
   */
  private rowToRecord(row: SecurityEvidenceRow): SecurityEvidenceRecord {
    return {
      id: row.id,
      timestamp: row.timestamp,
      sourceSubsystem: row.source_subsystem,
      eventType: row.event_type as SecurityEventType,
      severity: row.severity as ThreatSeverity,
      affectedFiles: JSON.parse(row.affected_files) as string[],
      findingDetails: row.finding_details,
      decision: row.decision as SecurityDecision,
      sessionId: row.session_id,
      remediationLinkId: row.remediation_link_id ?? undefined,
    };
  }
}
