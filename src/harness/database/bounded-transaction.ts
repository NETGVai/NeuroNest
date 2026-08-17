/**
 * Bounded Transaction for Shared_Database
 *
 * Enforces configurable max duration and max statements per transaction.
 * Returns retry-classified contention errors on SQLITE_BUSY/SQLITE_LOCKED.
 * Commits or rolls back atomically.
 *
 * Requirements: 31.1–31.3, 31.11–31.12
 */

import type Database from 'better-sqlite3';
import { classifyContentionError, type ContentionError } from './contention-errors.js';

/**
 * Configuration for bounded transaction limits.
 */
export interface TransactionBounds {
  /** Maximum duration in milliseconds before forced abort */
  maxDurationMs: number;
  /** Maximum number of SQL statements permitted in the transaction */
  maxStatements: number;
}

/**
 * Result of a bounded transaction execution.
 */
export type TransactionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: TransactionError };

/**
 * Error from a bounded transaction.
 */
export interface TransactionError {
  /** The kind of transaction failure */
  kind: 'duration_exceeded' | 'statements_exceeded' | 'contention' | 'error';
  /** Structured contention details if applicable */
  contention?: ContentionError;
  /** Human-readable message */
  message: string;
  /** Original error if present */
  cause?: Error;
}

/**
 * A bounded transaction that enforces max duration and max statement count.
 *
 * Usage:
 * ```
 * const tx = new BoundedTransaction(db, { maxDurationMs: 5000, maxStatements: 100 });
 * const result = tx.run((exec) => {
 *   exec('INSERT INTO foo (bar) VALUES (?)', 42);
 *   exec('UPDATE baz SET x = 1');
 *   return exec('SELECT * FROM foo').all();
 * });
 * ```
 */
export class BoundedTransaction {
  private readonly db: Database.Database;
  private readonly bounds: TransactionBounds;

  constructor(db: Database.Database, bounds: TransactionBounds) {
    this.db = db;
    this.bounds = bounds;
  }

  /**
   * Execute a function within a bounded transaction.
   *
   * The transaction is committed if the function completes within bounds.
   * It is rolled back if:
   * - The function throws
   * - Statement count exceeds maxStatements
   * - Duration exceeds maxDurationMs
   * - A contention error (SQLITE_BUSY/SQLITE_LOCKED) occurs
   *
   * Returns a discriminated result with either the value or a classified error.
   */
  run<T>(fn: (exec: BoundedExec) => T): TransactionResult<T> {
    const startTime = Date.now();
    let statementCount = 0;

    const exec: BoundedExec = (sql: string, ...params: unknown[]) => {
      // Check statement bound
      statementCount++;
      if (statementCount > this.bounds.maxStatements) {
        throw new BoundedTransactionLimitError(
          'statements_exceeded',
          `Transaction exceeded max statements (${this.bounds.maxStatements})`
        );
      }

      // Check duration bound
      const elapsed = Date.now() - startTime;
      if (elapsed > this.bounds.maxDurationMs) {
        throw new BoundedTransactionLimitError(
          'duration_exceeded',
          `Transaction exceeded max duration (${this.bounds.maxDurationMs}ms)`
        );
      }

      const stmt = this.db.prepare(sql);
      return new BoundedStatementProxy(stmt, params);
    };

    try {
      // Use better-sqlite3's transaction helper for atomic commit/rollback
      const transactionFn = this.db.transaction(() => {
        return fn(exec);
      });
      const value = transactionFn();
      return { ok: true, value };
    } catch (error: unknown) {
      if (error instanceof BoundedTransactionLimitError) {
        return {
          ok: false,
          error: {
            kind: error.kind,
            message: error.message,
          },
        };
      }

      // Classify contention errors
      const contention = classifyContentionError(error);
      if (contention.class === 'retriable') {
        return {
          ok: false,
          error: {
            kind: 'contention',
            contention,
            message: contention.message,
            cause: error instanceof Error ? error : undefined,
          },
        };
      }

      // Non-retriable error
      return {
        ok: false,
        error: {
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
          cause: error instanceof Error ? error : undefined,
        },
      };
    }
  }

  /**
   * Execute a function within a bounded IMMEDIATE transaction.
   * IMMEDIATE transactions acquire a write lock immediately,
   * preventing write starvation.
   */
  immediate<T>(fn: (exec: BoundedExec) => T): TransactionResult<T> {
    const startTime = Date.now();
    let statementCount = 0;

    const exec: BoundedExec = (sql: string, ...params: unknown[]) => {
      statementCount++;
      if (statementCount > this.bounds.maxStatements) {
        throw new BoundedTransactionLimitError(
          'statements_exceeded',
          `Transaction exceeded max statements (${this.bounds.maxStatements})`
        );
      }

      const elapsed = Date.now() - startTime;
      if (elapsed > this.bounds.maxDurationMs) {
        throw new BoundedTransactionLimitError(
          'duration_exceeded',
          `Transaction exceeded max duration (${this.bounds.maxDurationMs}ms)`
        );
      }

      const stmt = this.db.prepare(sql);
      return new BoundedStatementProxy(stmt, params);
    };

    try {
      const transactionFn = this.db.transaction(() => {
        return fn(exec);
      });
      const value = transactionFn.immediate() as T;
      return { ok: true, value };
    } catch (error: unknown) {
      if (error instanceof BoundedTransactionLimitError) {
        return {
          ok: false,
          error: {
            kind: error.kind,
            message: error.message,
          },
        };
      }

      const contention = classifyContentionError(error);
      if (contention.class === 'retriable') {
        return {
          ok: false,
          error: {
            kind: 'contention',
            contention,
            message: contention.message,
            cause: error instanceof Error ? error : undefined,
          },
        };
      }

      return {
        ok: false,
        error: {
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
          cause: error instanceof Error ? error : undefined,
        },
      };
    }
  }
}

/**
 * Function signature for executing SQL within a bounded transaction.
 * Returns a proxy that allows .run(), .get(), .all() on the prepared statement.
 */
export type BoundedExec = (sql: string, ...params: unknown[]) => BoundedStatementProxy;

/**
 * Proxy for a prepared statement bound with parameters.
 * Provides .run(), .get(), .all() methods matching better-sqlite3 API.
 */
export class BoundedStatementProxy {
  private readonly stmt: Database.Statement;
  private readonly params: unknown[];

  constructor(stmt: Database.Statement, params: unknown[]) {
    this.stmt = stmt;
    this.params = params;
  }

  run(): Database.RunResult {
    return this.stmt.run(...this.params);
  }

  get(): unknown {
    return this.stmt.get(...this.params);
  }

  all(): unknown[] {
    return this.stmt.all(...this.params);
  }
}

/**
 * Internal error used to signal that a transaction bound was exceeded.
 */
class BoundedTransactionLimitError extends Error {
  readonly kind: 'duration_exceeded' | 'statements_exceeded';

  constructor(kind: 'duration_exceeded' | 'statements_exceeded', message: string) {
    super(message);
    this.kind = kind;
    this.name = 'BoundedTransactionLimitError';
  }
}
