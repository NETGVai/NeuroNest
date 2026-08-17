/**
 * Shared_Database — Configurable SQLite connection for the harness.
 *
 * Wraps better-sqlite3 with:
 * - WAL mode enabled on open
 * - Foreign keys PRAGMA enabled
 * - Configured busy timeout from OperationalBoundsV1
 * - Configurable journal_mode and synchronous settings
 * - PreparedStatementCache for efficient statement reuse
 * - BoundedTransaction for enforcing transaction limits
 * - Session sequence allocation inside append transactions (SQL-side MAX+1)
 *
 * Requirements: 30.8, 30.12, 31.1–31.3, 31.11–31.12
 */

import Database from 'better-sqlite3';
import { PreparedStatementCache } from './prepared-statement-cache.js';
import { BoundedTransaction, type TransactionBounds, type TransactionResult } from './bounded-transaction.js';
import { classifyContentionError, isRetriableContention, type ContentionError } from './contention-errors.js';

/**
 * Configuration for SharedDatabase open.
 */
export interface SharedDatabaseConfig {
  /** Path to the SQLite database file, or ':memory:' for in-memory databases */
  path: string;
  /** Busy timeout in milliseconds (from OperationalBoundsV1.database.busyTimeoutMs) */
  busyTimeoutMs: number;
  /** Transaction bounds (from OperationalBoundsV1.transactions) */
  transactions: TransactionBounds;
  /** Synchronous mode: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA'. Default 'NORMAL' */
  synchronous?: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA';
}

/**
 * SharedDatabase provides a configured better-sqlite3 connection with
 * WAL mode, foreign keys, configured busy timeout, prepared statement
 * caching, and bounded transactions.
 */
export class SharedDatabase {
  private readonly db: Database.Database;
  private readonly stmtCache: PreparedStatementCache;
  private readonly txBounds: TransactionBounds;
  private closed = false;

  private constructor(db: Database.Database, txBounds: TransactionBounds) {
    this.db = db;
    this.stmtCache = new PreparedStatementCache(db);
    this.txBounds = txBounds;
  }

  /**
   * Open a SharedDatabase with all required PRAGMAs configured.
   *
   * Enables WAL mode, foreign keys, busy timeout, and synchronous mode
   * based on the provided configuration.
   */
  static open(config: SharedDatabaseConfig): SharedDatabase {
    const db = new Database(config.path);

    // Enable WAL mode for concurrent read/write access
    db.pragma('journal_mode = WAL');

    // Enable foreign key enforcement
    db.pragma('foreign_keys = ON');

    // Set configured busy timeout
    db.pragma(`busy_timeout = ${Math.round(config.busyTimeoutMs)}`);

    // Set synchronous mode (safe with WAL)
    const synchronous = config.synchronous ?? 'NORMAL';
    db.pragma(`synchronous = ${synchronous}`);

    return new SharedDatabase(db, config.transactions);
  }

  /**
   * Returns the underlying better-sqlite3 database instance.
   * Use for direct queries when bounded transactions aren't needed.
   */
  get raw(): Database.Database {
    this.ensureOpen();
    return this.db;
  }

  /**
   * Returns the prepared statement cache.
   */
  get statements(): PreparedStatementCache {
    this.ensureOpen();
    return this.stmtCache;
  }

  /**
   * Create a BoundedTransaction using the configured transaction bounds.
   */
  transaction(): BoundedTransaction {
    this.ensureOpen();
    return new BoundedTransaction(this.db, this.txBounds);
  }

  /**
   * Create a BoundedTransaction with custom bounds (for special cases).
   */
  transactionWithBounds(bounds: TransactionBounds): BoundedTransaction {
    this.ensureOpen();
    return new BoundedTransaction(this.db, bounds);
  }

  /**
   * Execute a bounded transaction using the configured bounds.
   * Convenience method that creates and runs a transaction in one call.
   */
  runTransaction<T>(fn: Parameters<BoundedTransaction['run']>[0]): TransactionResult<T> {
    return this.transaction().run(fn) as TransactionResult<T>;
  }

  /**
   * Execute a bounded IMMEDIATE transaction using the configured bounds.
   */
  runImmediate<T>(fn: Parameters<BoundedTransaction['immediate']>[0]): TransactionResult<T> {
    return this.transaction().immediate(fn) as TransactionResult<T>;
  }

  /**
   * Allocate the next session sequence number inside a transaction.
   *
   * Uses SQL-side MAX+1 via:
   *   SELECT COALESCE(MAX(sequence), -1) + 1 FROM harness_events WHERE sessionId = ?
   *
   * This avoids application-side MAX+1 race conditions by letting SQLite
   * compute the next sequence atomically within the write transaction.
   *
   * @param sessionId - The session to allocate a sequence for
   * @param branchId - The branch to allocate a sequence for (defaults to 'main')
   * @returns The allocated sequence number, or a contention error
   */
  allocateSessionSequence(sessionId: string, branchId = 'main'): { ok: true; sequence: number } | { ok: false; error: ContentionError } {
    this.ensureOpen();

    try {
      const stmt = this.stmtCache.get(
        `SELECT COALESCE(MAX(sequence), -1) + 1 AS next_seq
         FROM harness_events
         WHERE sessionId = ? AND branchId = ?`
      );
      const row = stmt.get(sessionId, branchId) as { next_seq: number } | undefined;
      return { ok: true, sequence: row?.next_seq ?? 0 };
    } catch (error: unknown) {
      if (isRetriableContention(error)) {
        return { ok: false, error: classifyContentionError(error) };
      }
      throw error;
    }
  }

  /**
   * Allocate and insert an event with the next session sequence in one atomic operation.
   * This is the preferred method for appending events — it computes the sequence
   * inside the INSERT statement itself.
   *
   * @param params - Event parameters
   * @returns The allocated sequence number
   */
  appendEventWithSequence(params: {
    sessionId: string;
    branchId?: string;
    eventId: string;
    schemaVersion: number;
    eventType: string;
    payload: string;
    integrityHash: string;
    actor: string;
    scope: string;
    occurredAt?: string;
    idempotencyKey?: string;
    previousIntegrityHash?: string;
  }): TransactionResult<number> {
    this.ensureOpen();

    const {
      sessionId,
      branchId = 'main',
      eventId,
      schemaVersion,
      eventType,
      payload,
      integrityHash,
      actor,
      scope,
      occurredAt = new Date().toISOString(),
      idempotencyKey = null,
      previousIntegrityHash = null,
    } = params;

    const tx = this.transaction();
    return tx.immediate((exec) => {
      const result = exec(
        `INSERT INTO harness_events (eventId, sessionId, branchId, sequence, schemaVersion, eventType, payload, idempotencyKey, occurredAt, actor, scope, previousIntegrityHash, integrityHash)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(sequence), -1) + 1 FROM harness_events WHERE sessionId = ? AND branchId = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING sequence`,
        eventId, sessionId, branchId, sessionId, branchId, schemaVersion, eventType, payload, idempotencyKey, occurredAt, actor, scope, previousIntegrityHash, integrityHash
      ).get() as { sequence: number } | undefined;

      if (!result) {
        throw new Error('Failed to allocate session sequence');
      }
      return result.sequence;
    });
  }

  /**
   * Check if the database is in WAL mode.
   */
  isWalMode(): boolean {
    this.ensureOpen();
    const result = this.db.pragma('journal_mode', { simple: true }) as string;
    return result.toLowerCase() === 'wal';
  }

  /**
   * Check if foreign keys are enabled.
   */
  isForeignKeysEnabled(): boolean {
    this.ensureOpen();
    const result = this.db.pragma('foreign_keys', { simple: true });
    return result === 1;
  }

  /**
   * Get the configured busy timeout.
   */
  getBusyTimeout(): number {
    this.ensureOpen();
    return this.db.pragma('busy_timeout', { simple: true }) as number;
  }

  /**
   * Close the database connection and clear statement cache.
   */
  close(): void {
    if (!this.closed) {
      this.stmtCache.clear();
      this.db.close();
      this.closed = true;
    }
  }

  /**
   * Returns true if the database has been closed.
   */
  get isClosed(): boolean {
    return this.closed;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('SharedDatabase is closed');
    }
  }
}
