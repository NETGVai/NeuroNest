/**
 * Readiness_Service — F6 readiness probe.
 *
 * Confirms the instance is "whole and at home":
 *   - database: SQLite handle answers a `SELECT 1` roundtrip
 *   - dataDir:  the data directory is writable (probe file write/read/remove)
 *   - localFirst: informational flag confirming local-first storage
 *
 * `checkReadiness` never throws — every failure is captured into the report.
 *
 * Requirements: 35
 */

import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ReadinessReport {
  ready: boolean;
  checks: {
    database: { ok: boolean; error?: string };
    dataDir: { ok: boolean; path: string; error?: string };
    localFirst: { ok: true; local: boolean };
  };
  timestamp: number;
}

/**
 * Run a `SELECT 1` roundtrip against the SQLite handle.
 * Returns `{ ok: false, error }` on any failure instead of throwing.
 */
function checkDatabase(db: Database.Database): { ok: boolean; error?: string } {
  try {
    const row = db.prepare('SELECT 1 AS ok').get() as { ok?: number } | undefined;
    if (!row || row.ok !== 1) {
      return { ok: false, error: 'SELECT 1 returned an unexpected result' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Probe data-directory writability by creating, reading back, and removing a
 * temporary file under `dataDir`. Returns `{ ok: false, error, path }` on any
 * failure instead of throwing.
 */
function checkDataDir(dataDir: string): { ok: boolean; path: string; error?: string } {
  const probePath = path.join(dataDir, `.readiness-probe-${randomUUID()}`);
  const payload = `readiness-${Date.now()}`;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(probePath, payload, 'utf8');
    const readBack = fs.readFileSync(probePath, 'utf8');
    if (readBack !== payload) {
      return { ok: false, path: dataDir, error: 'probe file read-back mismatch' };
    }
    return { ok: true, path: dataDir };
  } catch (err) {
    return { ok: false, path: dataDir, error: err instanceof Error ? err.message : String(err) };
  } finally {
    // Best-effort cleanup; ignore errors (e.g. file never created).
    try {
      fs.rmSync(probePath, { force: true });
    } catch {
      /* ignore cleanup failure */
    }
  }
}

/**
 * Build a readiness report covering the database roundtrip, data-directory
 * writability, and the local-first informational flag.
 *
 * `ready` is `true` iff every critical check (`database`, `dataDir`) passes.
 * This function never throws — errors are captured into the returned report.
 */
export async function checkReadiness(db: Database.Database, dataDir: string): Promise<ReadinessReport> {
  const database = checkDatabase(db);
  const dataDirCheck = checkDataDir(dataDir);
  const localFirst = { ok: true as const, local: true };

  return {
    ready: database.ok && dataDirCheck.ok,
    checks: {
      database,
      dataDir: dataDirCheck,
      localFirst,
    },
    timestamp: Date.now(),
  };
}
