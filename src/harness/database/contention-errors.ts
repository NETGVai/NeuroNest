/**
 * Contention Error Classification for Shared_Database
 *
 * Classifies SQLite error codes into retriable (contention) and non-retriable categories.
 * SQLITE_BUSY and SQLITE_LOCKED are contention errors eligible for retry.
 * All other errors are non-retriable.
 *
 * Requirements: 31.1, 31.11, 31.12
 */

/**
 * Error classification for database contention.
 */
export type ContentionClass = 'retriable' | 'non-retriable';

/**
 * A structured contention error returned when database operations fail.
 */
export interface ContentionError {
  /** The classification of this error */
  class: ContentionClass;
  /** The original SQLite error code (e.g., 'SQLITE_BUSY') */
  code: string;
  /** Human-readable message */
  message: string;
  /** The original error */
  cause?: Error;
}

/**
 * SQLite error codes that represent retriable contention.
 */
const RETRIABLE_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED']);

/**
 * Classifies a database error as retriable contention or non-retriable.
 *
 * SQLITE_BUSY → retriable (another connection holds a write lock)
 * SQLITE_LOCKED → retriable (table-level lock within same connection or shared cache)
 * All others → non-retriable
 */
export function classifyContentionError(error: unknown): ContentionError {
  const sqliteCode = extractSqliteCode(error);
  const isRetriable = RETRIABLE_CODES.has(sqliteCode);

  return {
    class: isRetriable ? 'retriable' : 'non-retriable',
    code: sqliteCode,
    message: error instanceof Error ? error.message : String(error),
    cause: error instanceof Error ? error : undefined,
  };
}

/**
 * Type guard: returns true if the error represents retriable database contention.
 */
export function isRetriableContention(error: unknown): boolean {
  const sqliteCode = extractSqliteCode(error);
  return RETRIABLE_CODES.has(sqliteCode);
}

/**
 * Extracts the SQLite error code from an error object.
 * better-sqlite3 errors have a `code` property like 'SQLITE_BUSY'.
 */
function extractSqliteCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  // Fall back to message parsing for errors that use message-embedded codes
  if (error instanceof Error) {
    if (error.message.includes('SQLITE_BUSY') || error.message.includes('database is locked')) {
      return 'SQLITE_BUSY';
    }
    if (error.message.includes('SQLITE_LOCKED')) {
      return 'SQLITE_LOCKED';
    }
  }
  return 'UNKNOWN';
}
