/**
 * Audit Chain — tamper-evident event log with SHA-256 hash linking.
 *
 * Records every tool invocation event with secret redaction, links events
 * via a SHA-256 hash chain for structural integrity verification, and
 * supports filtered queries and JSON round-trip serialization.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6
 */

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AuditEvent, ChainIntegrityResult } from './types';

// ─── Constants ──────────────────────────────────────────────────

/** Genesis hash used as the previousHash for the first event in the chain. */
const GENESIS_HASH = '0'.repeat(64);

// ─── Redaction Patterns ─────────────────────────────────────────

/**
 * Patterns that identify secret values to redact before storage.
 * Each pattern matches a known credential format or high-entropy token.
 */
const SECRET_PATTERNS: RegExp[] = [
  // API key prefixes (OpenAI, Slack, GitHub, etc.)
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bxoxb-[A-Za-z0-9-]{20,}\b/g,
  /\bxoxp-[A-Za-z0-9-]{20,}\b/g,
  /\bxoxa-[A-Za-z0-9-]{20,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bghs_[A-Za-z0-9]{20,}\b/g,
  /\bgho_[A-Za-z0-9]{20,}\b/g,
  /\bghu_[A-Za-z0-9]{20,}\b/g,
  /\bghr_[A-Za-z0-9]{20,}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  // JWTs (three base64-encoded segments separated by dots)
  /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  // {{secret:NAME}} template patterns
  /\{\{secret:[^}]+\}\}/g,
  // High-entropy base64 strings (>20 chars of base64 alphabet)
  /\b[A-Za-z0-9+/=]{21,}\b/g,
];

/** Placeholder text used to replace redacted values. */
const REDACTED = '[REDACTED]';

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Compute SHA-256 hash of the given content string.
 */
function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Compute the currentHash for an event given its previousHash and content.
 * Content is the JSON serialization of the event fields that form the
 * chain payload (everything except id, sequenceNumber, previousHash, currentHash).
 */
function computeEventHash(previousHash: string, eventContent: string): string {
  return sha256(previousHash + eventContent);
}

/**
 * Serialize the hashable content of an event (the fields that contribute
 * to the hash chain computation).
 */
function serializeEventContent(event: {
  timestamp: number;
  agentId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  resultSummary: string;
  duration: number;
  cost: number;
}): string {
  return JSON.stringify({
    timestamp: event.timestamp,
    agentId: event.agentId,
    toolName: event.toolName,
    arguments: event.arguments,
    resultSummary: event.resultSummary,
    duration: event.duration,
    cost: event.cost,
  });
}

/**
 * Determine whether a string is high-entropy by checking if its character
 * distribution is sufficiently uniform. This helps avoid false positives on
 * common English words that happen to match the base64 regex length threshold.
 */
function isHighEntropy(value: string): boolean {
  if (value.length < 21) return false;
  const charFreq = new Map<string, number>();
  for (const ch of value) {
    charFreq.set(ch, (charFreq.get(ch) ?? 0) + 1);
  }
  const uniqueRatio = charFreq.size / value.length;
  // High-entropy strings tend to have many distinct characters relative to length
  return uniqueRatio > 0.4;
}

// ─── Database Row Shape ─────────────────────────────────────────

interface AuditEventRow {
  id: string;
  sequence_number: number;
  timestamp: number;
  agent_id: string;
  tool_name: string;
  arguments_json: string;
  result_summary: string;
  duration_ms: number;
  cost_usd: number;
  previous_hash: string;
  current_hash: string;
}

/** Convert a database row into an AuditEvent object. */
function rowToEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    sequenceNumber: row.sequence_number,
    timestamp: row.timestamp,
    agentId: row.agent_id,
    toolName: row.tool_name,
    arguments: JSON.parse(row.arguments_json) as Record<string, unknown>,
    resultSummary: row.result_summary,
    duration: row.duration_ms,
    cost: row.cost_usd,
    previousHash: row.previous_hash,
    currentHash: row.current_hash,
  };
}

// ─── AuditChain Implementation ──────────────────────────────────

export interface AuditChainInterface {
  /** Append an event to the chain. Arguments are automatically redacted. */
  append(event: Omit<AuditEvent, 'id' | 'sequenceNumber' | 'previousHash' | 'currentHash'>): AuditEvent;

  /** Verify structural integrity of the hash chain. */
  verify(): ChainIntegrityResult;

  /** Query events with optional filters. */
  query(filters: { agentId?: string; toolName?: string; since?: number; limit?: number }): AuditEvent[];

  /** Redact sensitive data from a key-value record. */
  redact(data: Record<string, unknown>): Record<string, unknown>;
}

/**
 * Creates an AuditChain instance backed by the provided SQLite database.
 * The `audit_events` table must already exist (created by migration 063).
 */
export function createAuditChain(db: Database.Database): AuditChainInterface {
  // ─── Prepared Statements ────────────────────────────────────

  const insertStmt = db.prepare(`
    INSERT INTO audit_events (
      id, sequence_number, timestamp, agent_id, tool_name,
      arguments_json, result_summary, duration_ms, cost_usd,
      previous_hash, current_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getLastEventStmt = db.prepare(`
    SELECT * FROM audit_events ORDER BY sequence_number DESC LIMIT 1
  `);

  const getAllEventsStmt = db.prepare(`
    SELECT * FROM audit_events ORDER BY sequence_number ASC
  `);

  // ─── Redaction ──────────────────────────────────────────────

  function redactString(value: string): string {
    let result = value;
    for (const pattern of SECRET_PATTERNS) {
      // Reset lastIndex since patterns use global flag
      pattern.lastIndex = 0;
      result = result.replace(pattern, (match) => {
        // For the generic high-entropy base64 pattern, apply entropy check
        // to avoid redacting common words/identifiers
        if (pattern === SECRET_PATTERNS[SECRET_PATTERNS.length - 1]) {
          return isHighEntropy(match) ? REDACTED : match;
        }
        return REDACTED;
      });
    }
    return result;
  }

  function redactValue(value: unknown): unknown {
    if (typeof value === 'string') {
      return redactString(value);
    }
    if (Array.isArray(value)) {
      return value.map(redactValue);
    }
    if (value !== null && typeof value === 'object') {
      return redact(value as Record<string, unknown>);
    }
    return value;
  }

  function redact(data: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = redactValue(value);
    }
    return result;
  }

  // ─── Core Methods ───────────────────────────────────────────

  function append(
    event: Omit<AuditEvent, 'id' | 'sequenceNumber' | 'previousHash' | 'currentHash'>
  ): AuditEvent {
    // Redact sensitive data from arguments before storage
    const redactedArguments = redact(event.arguments);

    // Get the last event in the chain to determine previous hash and sequence
    const lastRow = getLastEventStmt.get() as AuditEventRow | undefined;
    const previousHash = lastRow?.current_hash ?? GENESIS_HASH;
    const sequenceNumber = lastRow ? lastRow.sequence_number + 1 : 0;

    // Build the event content for hashing
    const eventContent = serializeEventContent({
      timestamp: event.timestamp,
      agentId: event.agentId,
      toolName: event.toolName,
      arguments: redactedArguments,
      resultSummary: event.resultSummary,
      duration: event.duration,
      cost: event.cost,
    });

    // Compute the hash chain link
    const currentHash = computeEventHash(previousHash, eventContent);

    // Generate unique ID
    const id = randomUUID();

    // Persist to database
    insertStmt.run(
      id,
      sequenceNumber,
      event.timestamp,
      event.agentId,
      event.toolName,
      JSON.stringify(redactedArguments),
      event.resultSummary,
      event.duration,
      event.cost,
      previousHash,
      currentHash
    );

    return {
      id,
      sequenceNumber,
      timestamp: event.timestamp,
      agentId: event.agentId,
      toolName: event.toolName,
      arguments: redactedArguments,
      resultSummary: event.resultSummary,
      duration: event.duration,
      cost: event.cost,
      previousHash,
      currentHash,
    };
  }

  function verify(): ChainIntegrityResult {
    const rows = getAllEventsStmt.all() as AuditEventRow[];
    const totalEvents = rows.length;

    if (totalEvents === 0) {
      return { valid: true, totalEvents: 0, verifiedEvents: 0 };
    }

    let expectedPreviousHash = GENESIS_HASH;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const event = rowToEvent(row);

      // Check previousHash matches expected
      if (event.previousHash !== expectedPreviousHash) {
        return {
          valid: false,
          brokenAt: event.sequenceNumber,
          nature: `Event at sequence ${event.sequenceNumber} has previousHash mismatch: expected ${expectedPreviousHash.slice(0, 16)}..., got ${event.previousHash.slice(0, 16)}...`,
          totalEvents,
          verifiedEvents: i,
        };
      }

      // Recompute the currentHash and verify
      const eventContent = serializeEventContent({
        timestamp: event.timestamp,
        agentId: event.agentId,
        toolName: event.toolName,
        arguments: event.arguments,
        resultSummary: event.resultSummary,
        duration: event.duration,
        cost: event.cost,
      });

      const recomputedHash = computeEventHash(event.previousHash, eventContent);

      if (event.currentHash !== recomputedHash) {
        return {
          valid: false,
          brokenAt: event.sequenceNumber,
          nature: `Event at sequence ${event.sequenceNumber} has currentHash mismatch: stored ${event.currentHash.slice(0, 16)}..., recomputed ${recomputedHash.slice(0, 16)}...`,
          totalEvents,
          verifiedEvents: i,
        };
      }

      // This event's currentHash becomes the next event's expected previousHash
      expectedPreviousHash = event.currentHash;
    }

    return { valid: true, totalEvents, verifiedEvents: totalEvents };
  }

  function query(filters: {
    agentId?: string;
    toolName?: string;
    since?: number;
    limit?: number;
  }): AuditEvent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.agentId) {
      conditions.push('agent_id = ?');
      params.push(filters.agentId);
    }
    if (filters.toolName) {
      conditions.push('tool_name = ?');
      params.push(filters.toolName);
    }
    if (filters.since != null) {
      conditions.push('timestamp >= ?');
      params.push(filters.since);
    }

    let sql = 'SELECT * FROM audit_events';
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY sequence_number ASC';

    if (filters.limit != null && filters.limit > 0) {
      sql += ' LIMIT ?';
      params.push(filters.limit);
    }

    const rows = db.prepare(sql).all(...params) as AuditEventRow[];
    return rows.map(rowToEvent);
  }

  return { append, verify, query, redact };
}

// ─── Exported Utilities ─────────────────────────────────────────

/**
 * Exported for testing — compute SHA-256 of content.
 */
export { sha256, computeEventHash, serializeEventContent, GENESIS_HASH };
