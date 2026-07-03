/**
 * IntentDecision Serialization & Telemetry Logging
 *
 * Provides:
 * 1. `serializeIntentDecision` — JSON serialization for `intent_decisions` table and IPC transport
 * 2. `deserializeIntentDecision` — Deserialization with descriptive ParseError (never crash)
 * 3. `IntentDecisionTelemetry` — Logs decisions, updates on override, logs outcome
 *
 * Requirements: 16.1, 16.2, 16.3, 13.1, 13.2, 13.3
 */

import type Database from 'better-sqlite3';
import type {
  IntentDecision,
  IntentLabel,
  ClassificationStage,
  ComplexityTier,
} from '../intent-gate.js';

// ─── ParseError ─────────────────────────────────────────────────

export interface ParseError {
  kind: 'ParseError';
  message: string;
  input: string;
}

// ─── Validation Constants ───────────────────────────────────────

const VALID_INTENTS: IntentLabel[] = ['conversation', 'quick_action', 'build', 'ambiguous'];
const VALID_STAGES: ClassificationStage[] = ['pattern', 'llm', 'context_prior', 'user_override'];
const VALID_COMPLEXITIES: ComplexityTier[] = ['trivial', 'medium', 'complex'];

// ─── Serialization ──────────────────────────────────────────────

/**
 * Serialize an IntentDecision to JSON for storage in the `intent_decisions`
 * table and for IPC transport to the renderer process.
 *
 * Requirements: 16.1
 */
export function serializeIntentDecision(decision: IntentDecision): string {
  return JSON.stringify({
    intent: decision.intent,
    confidence: decision.confidence,
    stage: decision.stage,
    complexity: decision.complexity,
    signals: decision.signals,
    latencyMs: decision.latencyMs,
    messageHash: decision.messageHash,
    timestamp: decision.timestamp,
  });
}

/**
 * Deserialize a JSON string back into an IntentDecision.
 * Returns a descriptive ParseError rather than throwing on malformed input.
 *
 * Requirements: 16.2, 16.3
 */
export function deserializeIntentDecision(json: string): IntentDecision | ParseError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return {
      kind: 'ParseError',
      message: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      input: json,
    };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      kind: 'ParseError',
      message: 'Expected a JSON object, received: ' + typeof parsed,
      input: json,
    };
  }

  const obj = parsed as Record<string, unknown>;

  // Validate intent
  if (!VALID_INTENTS.includes(obj.intent as IntentLabel)) {
    return {
      kind: 'ParseError',
      message: `Invalid intent: "${String(obj.intent)}". Must be one of: ${VALID_INTENTS.join(', ')}`,
      input: json,
    };
  }

  // Validate confidence
  if (typeof obj.confidence !== 'number' || isNaN(obj.confidence) || obj.confidence < 0 || obj.confidence > 1) {
    return {
      kind: 'ParseError',
      message: `Invalid confidence: "${String(obj.confidence)}". Must be a number in [0, 1]`,
      input: json,
    };
  }

  // Validate stage
  if (!VALID_STAGES.includes(obj.stage as ClassificationStage)) {
    return {
      kind: 'ParseError',
      message: `Invalid stage: "${String(obj.stage)}". Must be one of: ${VALID_STAGES.join(', ')}`,
      input: json,
    };
  }

  // Validate complexity
  if (obj.complexity !== null && !VALID_COMPLEXITIES.includes(obj.complexity as ComplexityTier)) {
    return {
      kind: 'ParseError',
      message: `Invalid complexity: "${String(obj.complexity)}". Must be null or one of: ${VALID_COMPLEXITIES.join(', ')}`,
      input: json,
    };
  }

  // Validate signals
  if (!Array.isArray(obj.signals)) {
    return {
      kind: 'ParseError',
      message: `Invalid signals: expected an array, received: ${typeof obj.signals}`,
      input: json,
    };
  }
  for (let i = 0; i < obj.signals.length; i++) {
    if (typeof obj.signals[i] !== 'string') {
      return {
        kind: 'ParseError',
        message: `Invalid signal at index ${i}: expected string, received: ${typeof obj.signals[i]}`,
        input: json,
      };
    }
  }

  // Validate latencyMs
  if (typeof obj.latencyMs !== 'number' || isNaN(obj.latencyMs)) {
    return {
      kind: 'ParseError',
      message: `Invalid latencyMs: "${String(obj.latencyMs)}". Must be a number`,
      input: json,
    };
  }

  // Validate messageHash
  if (typeof obj.messageHash !== 'string') {
    return {
      kind: 'ParseError',
      message: `Invalid messageHash: expected string, received: ${typeof obj.messageHash}`,
      input: json,
    };
  }

  // Validate timestamp
  if (typeof obj.timestamp !== 'number' || isNaN(obj.timestamp)) {
    return {
      kind: 'ParseError',
      message: `Invalid timestamp: "${String(obj.timestamp)}". Must be a number`,
      input: json,
    };
  }

  return {
    intent: obj.intent as IntentLabel,
    confidence: obj.confidence as number,
    stage: obj.stage as ClassificationStage,
    complexity: (obj.complexity as ComplexityTier) ?? null,
    signals: obj.signals as string[],
    latencyMs: obj.latencyMs as number,
    messageHash: obj.messageHash as string,
    timestamp: obj.timestamp as number,
  };
}

/**
 * Type guard to check if a deserialization result is a ParseError.
 */
export function isParseError(result: IntentDecision | ParseError): result is ParseError {
  return (result as ParseError).kind === 'ParseError';
}

// ─── Telemetry Logging ──────────────────────────────────────────

/**
 * Stored row shape from the `intent_decisions` table.
 */
export interface IntentDecisionRow {
  id: number;
  session_id: string;
  message_hash: string;
  intent: string;
  confidence: number;
  stage: string;
  complexity: string | null;
  signals: string;
  latency_ms: number;
  override_intent: string | null;
  outcome_success: number | null;
  created_at: number;
}

/**
 * IntentDecisionTelemetry — logs intent decisions to the `intent_decisions`
 * SQLite table, supports updating on override, and logging outcomes.
 *
 * Requirements: 13.1, 13.2, 13.3
 */
export class IntentDecisionTelemetry {
  private readonly db: Database.Database;

  private readonly stmtInsert: Database.Statement;
  private readonly stmtUpdateOverride: Database.Statement;
  private readonly stmtUpdateOutcome: Database.Statement;
  private readonly stmtGetByHash: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    this.stmtInsert = db.prepare(
      `INSERT OR REPLACE INTO intent_decisions
        (session_id, message_hash, intent, confidence, stage, complexity, signals, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.stmtUpdateOverride = db.prepare(
      `UPDATE intent_decisions
       SET override_intent = ?, stage = 'user_override'
       WHERE session_id = ? AND message_hash = ?`,
    );

    this.stmtUpdateOutcome = db.prepare(
      `UPDATE intent_decisions
       SET outcome_success = ?
       WHERE session_id = ? AND message_hash = ?`,
    );

    this.stmtGetByHash = db.prepare(
      `SELECT id, session_id, message_hash, intent, confidence, stage, complexity, signals, latency_ms, override_intent, outcome_success, created_at
       FROM intent_decisions
       WHERE session_id = ? AND message_hash = ?`,
    );
  }

  /**
   * Log an IntentDecision to the `intent_decisions` table.
   * Uses INSERT OR REPLACE to handle the UNIQUE(session_id, message_hash) constraint.
   *
   * Requirements: 13.1
   */
  logDecision(sessionId: string, decision: IntentDecision): void {
    this.stmtInsert.run(
      sessionId,
      decision.messageHash,
      decision.intent,
      decision.confidence,
      decision.stage,
      decision.complexity,
      JSON.stringify(decision.signals),
      decision.latencyMs,
    );
  }

  /**
   * Update the record when a user override occurs.
   * Sets override_intent and stage='user_override'.
   *
   * Requirements: 13.2
   */
  logOverride(sessionId: string, messageHash: string, overrideIntent: IntentLabel): void {
    this.stmtUpdateOverride.run(overrideIntent, sessionId, messageHash);
  }

  /**
   * Log the outcome of a task (success/failure) linked to the original decision.
   *
   * Requirements: 13.3
   */
  logOutcome(sessionId: string, messageHash: string, success: boolean): void {
    this.stmtUpdateOutcome.run(success ? 1 : 0, sessionId, messageHash);
  }

  /**
   * Retrieve the stored decision record for a session/message hash pair.
   * Returns null if no record exists.
   */
  getDecisionRecord(sessionId: string, messageHash: string): IntentDecisionRow | null {
    const row = this.stmtGetByHash.get(sessionId, messageHash) as IntentDecisionRow | undefined;
    return row ?? null;
  }
}
