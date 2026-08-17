/**
 * Prepared Statement Cache for Shared_Database
 *
 * Caches compiled prepared statements for reuse across transactions,
 * avoiding repeated SQL compilation overhead. Statements are keyed by
 * their SQL text and lazily prepared on first use.
 *
 * Requirements: 30.8, 31.1
 */

import type Database from 'better-sqlite3';

/**
 * A cache that stores and reuses prepared statements for a given database connection.
 * Statements are prepared lazily on first access and reused on subsequent calls.
 */
export class PreparedStatementCache {
  private readonly cache = new Map<string, Database.Statement>();
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Get or prepare a statement for the given SQL.
   * If the statement has already been prepared, the cached version is returned.
   */
  get(sql: string): Database.Statement {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.cache.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * Returns the number of cached statements.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Returns true if the cache contains a prepared statement for the given SQL.
   */
  has(sql: string): boolean {
    return this.cache.has(sql);
  }

  /**
   * Clears all cached statements. Use when closing the database.
   */
  clear(): void {
    this.cache.clear();
  }
}
