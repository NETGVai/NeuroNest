/**
 * Error_Size_Tap — observation-only telemetry for error sizes at Tool_Retry_Sites.
 *
 * Task 0 of the 12-factor-agent-improvements spec. This is the prior-task
 * observation tap mandated by Requirement 5.5: it records
 * `estimateTokens(JSON.stringify(error))` from every catch block at the two
 * Tool_Retry_Sites (`tool-call-recovery.ts` and `fallback-chain.ts`) for
 * ≥ 7 days, then exports median / p95 / max via the one-off CLI script
 * `scripts/error-size-stats.mjs`.
 *
 * Behaviour notes:
 *  - Ships behind no flag — observation is always on, with no behaviour change
 *    (we never modify the error object the LLM sees).
 *  - Writes through `SessionTelemetryService.recordMetric` into the
 *    `metric_samples` table (migration 030) under key
 *    `errors.raw_estimated_tokens`. The original placeholder table
 *    `error_size_samples` was dropped by migration 031 (task 4); existing
 *    observations were backfilled there before the table was removed.
 *  - The recorder is best-effort and fully fail-soft: any storage failure is
 *    swallowed (logged once at warn level) so the tap can never break the
 *    error path it is observing.
 *  - The DB handle is lazily resolved. In renderer/test/CLI processes that
 *    cannot open the persistent DB, the recorder no-ops cleanly.
 *
 * Requirements: 5.5
 */

import type Database from 'better-sqlite3';
import { estimateTokens } from '../session/context-compressor.js';
import { SessionTelemetryService } from '../session/session-telemetry.js';

/** Metrics_Sink key under which raw error sizes are recorded. */
const METRIC_KEY = 'errors.raw_estimated_tokens';

// ─── Lazy DB / Metrics_Sink handle ─────────────────────────────

let cachedDb: Database.Database | null | undefined;
let cachedSink: SessionTelemetryService | null = null;
let warnedOnce = false;

/**
 * Resolve a DB handle on first use. Returns null if the handle cannot be
 * obtained (e.g. running in renderer / test without an explicit setup).
 *
 * Importing `initDatabase` lazily inside the function keeps the module load
 * cheap and avoids cyclic imports during test bootstrap.
 */
function getDb(): Database.Database | null {
  if (cachedDb !== undefined) return cachedDb;

  try {
    // Lazy require so this module remains importable in environments without
    // better-sqlite3 (e.g. renderer-side bundles) — the require fails gracefully.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dbModule = require('../storage/database.js');
    if (typeof dbModule.initDatabase !== 'function') {
      cachedDb = null;
      return cachedDb;
    }
    cachedDb = dbModule.initDatabase();
    return cachedDb ?? null;
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn('[error-size-tap] DB unavailable; tap is no-op:', (err as Error)?.message);
    }
    cachedDb = null;
    return cachedDb;
  }
}

function getSink(): SessionTelemetryService | null {
  if (cachedSink) return cachedSink;
  const db = getDb();
  if (!db) return null;
  try {
    cachedSink = new SessionTelemetryService(db);
    return cachedSink;
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn('[error-size-tap] could not construct Metrics_Sink; tap is no-op:', (err as Error)?.message);
    }
    return null;
  }
}

// ─── Test / DI hook ────────────────────────────────────────────

/**
 * Replace the cached DB handle. Used by tests; not exported through the
 * pipeline barrel.
 */
export function __setDbForTests(db: Database.Database | null): void {
  cachedDb = db;
  cachedSink = null;
  warnedOnce = false;
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Estimate the JSON-serialised token size of an error. Matches the formula
 * mandated by the spec: `estimateTokens(JSON.stringify(error))`.
 *
 * Resilient to circular references (some errors carry node-internal refs).
 */
export function estimateErrorTokens(error: unknown): number {
  let serialised: string;
  try {
    serialised = JSON.stringify(serialiseError(error));
  } catch {
    // Fall back to a string coercion if JSON.stringify fails (e.g. BigInt).
    serialised = String(error);
  }
  return estimateTokens(serialised);
}

/**
 * Record one error-size observation. Always fail-soft.
 *
 * @param error      The raw error object (any shape).
 * @param sessionId  Optional session id (nullable — some retry sites lack one).
 */
export function recordErrorSize(error: unknown, sessionId: string | null = null): void {
  let value: number;
  try {
    value = estimateErrorTokens(error);
  } catch {
    return; // Token estimation should never throw, but be defensive.
  }

  const sink = getSink();
  if (!sink) return;

  try {
    sink.recordMetric(sessionId, METRIC_KEY, value);
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn('[error-size-tap] insert failed; tap is no-op:', (err as Error)?.message);
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Convert an Error (or any thrown value) into a JSON-friendly shape that
 * preserves the fields the LLM would see at a Tool_Retry_Site (name, message,
 * stack, code, output) plus any enumerable own properties.
 *
 * `Error` instances do not stringify usefully via `JSON.stringify` because
 * `name`, `message`, and `stack` are non-enumerable. Without this normalisation
 * the tap would underestimate raw error sizes for the most common case.
 */
function serialiseError(error: unknown): unknown {
  if (error instanceof Error) {
    const out: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    // Common extra fields surfaced at Tool_Retry_Sites.
    const anyErr = error as any;
    if (anyErr['code'] !== undefined) out['code'] = anyErr['code'];
    if (anyErr['output'] !== undefined) out['output'] = anyErr['output'];
    if (anyErr['cause'] !== undefined) {
      try {
        out['cause'] = serialiseError(anyErr['cause']);
      } catch {
        out['cause'] = String(anyErr['cause']);
      }
    }
    // Pick up any other enumerable own properties.
    for (const key of Object.keys(error)) {
      if (key in out) continue;
      out[key] = (error as any)[key];
    }
    return out;
  }
  return error;
}
