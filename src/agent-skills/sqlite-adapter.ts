import Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';
import { agentSkillsErrorHandler, ErrorContext } from './error-handler.js';

/**
 * SQLite Adapter for Agent Skills Integration
 * 
 * Translates PostgreSQL/TimescaleDB queries from the Agent Skills microservice
 * to SQLite equivalents that work with the existing NeuroNest database schema.
 * 
 * Key Features:
 * - Query translation from PostgreSQL to SQLite
 * - JSON operations translation (JSONB -> JSON)
 * - Array operations using SQLite JSON functions
 * - Connection pooling using existing NeuroNest database
 * - Time-series query optimization for SQLite
 */
export class SQLiteAdapter {
  private db: Database.Database;
  private connectionPool: Database.Database[] = [];
  private maxConnections = 10;
  private currentConnections = 0;

  constructor(database: Database.Database) {
    this.db = database;
    this.initializeConnectionPool();
  }

  /**
   * Initialize connection pool for concurrent operations
   */
  private initializeConnectionPool(): void {
    // SQLite doesn't need traditional connection pooling like PostgreSQL
    // Instead, we use WAL mode for concurrent reads and serialize writes
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = 10000');
    this.db.pragma('temp_store = MEMORY');
  }

  /**
   * Get a database connection (in SQLite, this is the same instance)
   */
  async getConnection(): Promise<Database.Database> {
    return this.db;
  }

  /**
   * Release a database connection (no-op for SQLite)
   */
  releaseConnection(connection: Database.Database): void {
    // No-op for SQLite as we use the same instance
  }

  /**
   * Translate PostgreSQL queries to SQLite equivalents
   */
  translateQuery(postgresQuery: string, params: any[] = []): { query: string; params: any[] } {
    let translatedQuery = postgresQuery;
    let translatedParams = [...params];

    // Replace PostgreSQL-specific syntax with SQLite equivalents
    translatedQuery = this.translatePostgreSQLSyntax(translatedQuery);
    translatedQuery = this.translateJSONOperations(translatedQuery);
    translatedQuery = this.translateArrayOperations(translatedQuery);
    translatedQuery = this.translateTimeSeriesOperations(translatedQuery);
    translatedQuery = this.translateParameterPlaceholders(translatedQuery);

    return { query: translatedQuery, params: translatedParams };
  }

  /**
   * Translate PostgreSQL-specific syntax to SQLite
   */
  private translatePostgreSQLSyntax(query: string): string {
    return query
      // Replace ILIKE with LIKE (case-insensitive)
      .replace(/\bILIKE\b/gi, 'LIKE')
      // Replace NOW() with CURRENT_TIMESTAMP
      .replace(/\bNOW\(\)/gi, 'CURRENT_TIMESTAMP')
      // Replace SERIAL with AUTOINCREMENT
      .replace(/\bSERIAL\b/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT')
      // Replace UUID with TEXT
      .replace(/\bUUID\b/gi, 'TEXT')
      // Replace BOOLEAN with INTEGER (0/1)
      .replace(/\bBOOLEAN\b/gi, 'INTEGER')
      // Replace TEXT[] with TEXT (JSON array)
      .replace(/\bTEXT\[\]/gi, 'TEXT')
      // Replace JSONB with JSON
      .replace(/\bJSONB\b/gi, 'JSON')
      // Replace PostgreSQL date functions
      .replace(/\bEXTRACT\s*\(\s*(\w+)\s+FROM\s+([^)]+)\)/gi, "strftime('%$1', $2)")
      // Replace LIMIT/OFFSET parameter syntax
      .replace(/LIMIT\s+\$(\d+)/gi, 'LIMIT ?')
      .replace(/OFFSET\s+\$(\d+)/gi, 'OFFSET ?');
  }

  /**
   * Translate PostgreSQL JSONB operations to SQLite JSON
   */
  private translateJSONOperations(query: string): string {
    return query
      // Replace JSONB -> operator with JSON_EXTRACT
      .replace(/(\w+)\s*->\s*'([^']+)'/g, "JSON_EXTRACT($1, '$.$2')")
      // Replace JSONB ->> operator with JSON_EXTRACT (unquoted) - SQLite JSON_EXTRACT returns unquoted values by default
      .replace(/(\w+)\s*->>\s*'([^']+)'/g, "JSON_EXTRACT($1, '$.$2')")
      // Replace JSONB ? operator with JSON_EXTRACT IS NOT NULL
      .replace(/(\w+)\s*\?\s*'([^']+)'/g, "JSON_EXTRACT($1, '$.$2') IS NOT NULL")
      // Replace JSONB ?| operator (any key exists) with custom function
      .replace(/(\w+)\s*\?\|\s*(\w+)/g, "json_array_contains_any($1, $2)")
      // Replace JSONB ?& operator (all keys exists) with custom function
      .replace(/(\w+)\s*\?&\s*(\w+)/g, "json_array_contains_all($1, $2)")
      // Replace @> operator (contains) with custom function
      .replace(/(\w+)\s*@>\s*'([^']+)'/g, "json_contains($1, '$2')")
      // Replace <@ operator (contained by) with custom function
      .replace(/(\w+)\s*<@\s*'([^']+)'/g, "json_contained_by($1, '$2')");
  }

  /**
   * Translate PostgreSQL array operations to SQLite JSON arrays
   */
  private translateArrayOperations(query: string): string {
    return query
      // Replace array contains operator (must come before ARRAY[] replacement)
      .replace(/(\w+)\s*@>\s*ARRAY\[([^\]]+)\]/g, "json_array_contains($1, JSON_ARRAY($2))")
      // Replace array overlap operator (must come before ARRAY[] replacement)
      .replace(/(\w+)\s*&&\s*ARRAY\[([^\]]+)\]/g, "json_array_overlaps($1, JSON_ARRAY($2))")
      // Replace array literal syntax (comes after operators)
      .replace(/ARRAY\[([^\]]+)\]/g, 'JSON_ARRAY($1)')
      // Replace array length function
      .replace(/array_length\(([^,]+),\s*1\)/g, 'JSON_ARRAY_LENGTH($1)')
      // Replace unnest function with JSON_EACH
      .replace(/unnest\(([^)]+)\)/g, 'JSON_EACH($1)');
  }

  /**
   * Translate TimescaleDB time-series operations to SQLite
   */
  private translateTimeSeriesOperations(query: string): string {
    return query
      // Replace time_bucket function with strftime grouping
      .replace(/time_bucket\s*\(\s*'(\d+)\s*(\w+)'\s*,\s*([^)]+)\)/g, (match, interval, unit, column) => {
        const format = this.getTimeFormat(unit, interval);
        return `strftime('${format}', ${column})`;
      })
      // Replace TimescaleDB-specific functions
      .replace(/\bfirst\s*\(/g, 'MIN(')
      .replace(/\blast\s*\(/g, 'MAX(')
      // Replace interval arithmetic - more precise regex to avoid capturing too much
      .replace(/(\w+|\w+\(\))\s*\+\s*INTERVAL\s*'(\d+)\s*(\w+)'/g, "datetime($1, '+$2 $3')")
      .replace(/(\w+|\w+\(\))\s*-\s*INTERVAL\s*'(\d+)\s*(\w+)'/g, "datetime($1, '-$2 $3')");
  }

  /**
   * Get SQLite time format string for time bucketing
   */
  private getTimeFormat(unit: string, interval: string): string {
    switch (unit.toLowerCase()) {
      case 'minute':
      case 'minutes':
        return '%Y-%m-%d %H:%M:00';
      case 'hour':
      case 'hours':
        return '%Y-%m-%d %H:00:00';
      case 'day':
      case 'days':
        return '%Y-%m-%d';
      case 'week':
      case 'weeks':
        return '%Y-%W';
      case 'month':
      case 'months':
        return '%Y-%m';
      case 'year':
      case 'years':
        return '%Y';
      default:
        return '%Y-%m-%d %H:%M:%S';
    }
  }

  /**
   * Translate PostgreSQL parameter placeholders ($1, $2) to SQLite (?)
   */
  private translateParameterPlaceholders(query: string): string {
    // Replace $1, $2, etc. with ? placeholders
    return query.replace(/\$\d+/g, '?');
  }

  /**
   * Execute a translated query with comprehensive error handling and retry logic
   */
  async executeQuery(postgresQuery: string, params: any[] = []): Promise<any[]> {
    const context: ErrorContext = {
      component: 'sqlite-adapter',
      operation: 'executeQuery',
      metadata: { queryType: 'SELECT', paramCount: params.length },
      timestamp: new Date()
    };

    return agentSkillsErrorHandler.executeWithRetry(async () => {
      const { query, params: translatedParams } = this.translateQuery(postgresQuery, params);
      
      logger.debug('Executing translated query:', { 
        original: postgresQuery, 
        translated: query, 
        params: translatedParams 
      });

      // Check database connection health
      if (!this.db.open) {
        throw new Error('Database connection is closed');
      }

      const stmt = this.db.prepare(query);
      const result = stmt.all(...translatedParams);
      
      return result;
    }, context, {
      maxRetries: 3,
      baseDelay: 500,
      retryableErrors: ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR']
    });
  }

  /**
   * Execute a single row query with comprehensive error handling
   */
  async executeQuerySingle(postgresQuery: string, params: any[] = []): Promise<any | null> {
    const context: ErrorContext = {
      component: 'sqlite-adapter',
      operation: 'executeQuerySingle',
      metadata: { queryType: 'SELECT_SINGLE', paramCount: params.length },
      timestamp: new Date()
    };

    return agentSkillsErrorHandler.executeWithRetry(async () => {
      const { query, params: translatedParams } = this.translateQuery(postgresQuery, params);
      
      // Check database connection health
      if (!this.db.open) {
        throw new Error('Database connection is closed');
      }
      
      const stmt = this.db.prepare(query);
      const result = stmt.get(...translatedParams);
      
      return result || null;
    }, context, {
      maxRetries: 3,
      baseDelay: 500,
      retryableErrors: ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR']
    });
  }

  /**
   * Execute a query that modifies data with comprehensive error handling and retry logic
   */
  async executeModifyQuery(postgresQuery: string, params: any[] = []): Promise<{ changes: number; lastInsertRowid?: number }> {
    const context: ErrorContext = {
      component: 'sqlite-adapter',
      operation: 'executeModifyQuery',
      metadata: { queryType: 'MODIFY', paramCount: params.length },
      timestamp: new Date()
    };

    return agentSkillsErrorHandler.executeWithRetry(async () => {
      const { query, params: translatedParams } = this.translateQuery(postgresQuery, params);
      
      // Check database connection health
      if (!this.db.open) {
        throw new Error('Database connection is closed');
      }
      
      const stmt = this.db.prepare(query);
      const result = stmt.run(...translatedParams);
      
      return {
        changes: result.changes,
        lastInsertRowid: typeof result.lastInsertRowid === 'bigint' ? Number(result.lastInsertRowid) : result.lastInsertRowid
      };
    }, context, {
      maxRetries: 5, // More retries for write operations
      baseDelay: 1000,
      maxDelay: 10000,
      retryableErrors: ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR', 'SQLITE_FULL']
    });
  }

  /**
   * Begin a transaction
   */
  beginTransaction(): Database.Transaction {
    return this.db.transaction((callback: () => void) => {
      callback();
    });
  }

  /**
   * Execute multiple queries in a transaction with comprehensive error handling
   */
  async executeTransaction(queries: Array<{ query: string; params?: any[] }>): Promise<any[]> {
    const context: ErrorContext = {
      component: 'sqlite-adapter',
      operation: 'executeTransaction',
      metadata: { queryCount: queries.length },
      timestamp: new Date()
    };

    return agentSkillsErrorHandler.executeWithRetry(async () => {
      // Check database connection health
      if (!this.db.open) {
        throw new Error('Database connection is closed');
      }

      const transaction = this.db.transaction(() => {
        const results: any[] = [];
        
        for (const { query, params = [] } of queries) {
          const { query: translatedQuery, params: translatedParams } = this.translateQuery(query, params);
          const stmt = this.db.prepare(translatedQuery);
          
          if (translatedQuery.trim().toUpperCase().startsWith('SELECT')) {
            results.push(stmt.all(...translatedParams));
          } else {
            results.push(stmt.run(...translatedParams));
          }
        }
        
        return results;
      });

      return transaction();
    }, context, {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 15000,
      retryableErrors: ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR']
    });
  }

  /**
   * Register custom SQLite functions for JSON operations
   */
  registerCustomFunctions(): void {
    // Function to check if JSON array contains any of the specified values
    this.db.function('json_array_contains_any', (jsonArray: string, values: string) => {
      try {
        const array = JSON.parse(jsonArray);
        const checkValues = JSON.parse(values);
        return checkValues.some((value: any) => array.includes(value)) ? 1 : 0;
      } catch {
        return 0;
      }
    });

    // Function to check if JSON array contains all of the specified values
    this.db.function('json_array_contains_all', (jsonArray: string, values: string) => {
      try {
        const array = JSON.parse(jsonArray);
        const checkValues = JSON.parse(values);
        return checkValues.every((value: any) => array.includes(value)) ? 1 : 0;
      } catch {
        return 0;
      }
    });

    // Function to check if JSON contains another JSON
    this.db.function('json_contains', (container: string, contained: string) => {
      try {
        const containerObj = JSON.parse(container);
        const containedObj = JSON.parse(contained);
        return this.jsonContains(containerObj, containedObj) ? 1 : 0;
      } catch {
        return 0;
      }
    });

    // Function to check if JSON is contained by another JSON
    this.db.function('json_contained_by', (contained: string, container: string) => {
      try {
        const containerObj = JSON.parse(container);
        const containedObj = JSON.parse(contained);
        return this.jsonContains(containerObj, containedObj) ? 1 : 0;
      } catch {
        return 0;
      }
    });

    // Function to check if JSON arrays overlap
    this.db.function('json_array_overlaps', (array1: string, array2: string) => {
      try {
        const arr1 = JSON.parse(array1);
        const arr2 = JSON.parse(array2);
        return arr1.some((item: any) => arr2.includes(item)) ? 1 : 0;
      } catch {
        return 0;
      }
    });

    // Function to check if JSON array contains a value
    this.db.function('json_array_contains', (jsonArray: string, value: string) => {
      try {
        const array = JSON.parse(jsonArray);
        const checkValue = JSON.parse(value);
        return array.includes(checkValue) ? 1 : 0;
      } catch {
        return 0;
      }
    });
  }

  /**
   * Helper function to check if one JSON object contains another
   */
  private jsonContains(container: any, contained: any): boolean {
    if (typeof contained !== 'object' || contained === null) {
      return container === contained;
    }

    if (Array.isArray(contained)) {
      if (!Array.isArray(container)) return false;
      return contained.every(item => container.some(containerItem => this.jsonContains(containerItem, item)));
    }

    if (typeof container !== 'object' || container === null) {
      return false;
    }

    for (const key in contained) {
      if (!(key in container) || !this.jsonContains(container[key], contained[key])) {
        return false;
      }
    }

    return true;
  }

  /**
   * Optimize indexes for Agent Skills queries
   */
  optimizeIndexes(): void {
    const indexes = [
      // Skills table indexes (already exist from migration)
      `CREATE INDEX IF NOT EXISTS idx_skills_metadata_json ON skills(json_extract(metadata, '$.agent_skills_metadata'))`,
      
      // Agent skill assignments indexes (already exist)
      'CREATE INDEX IF NOT EXISTS idx_agent_skill_assignments_proficiency ON agent_skill_assignments(proficiency_level)',
      'CREATE INDEX IF NOT EXISTS idx_agent_skill_assignments_success_rate ON agent_skill_assignments(success_rate)',
      
      // Skill events indexes for time-series queries
      'CREATE INDEX IF NOT EXISTS idx_skill_events_entity_timestamp ON skill_events(entity_type, entity_id, timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_skill_events_event_type_timestamp ON skill_events(event_type, timestamp)',
      
      // Cache entries indexes
      'CREATE INDEX IF NOT EXISTS idx_cache_entries_key_expires ON cache_entries(key, expires_at)',
    ];

    for (const indexQuery of indexes) {
      try {
        this.db.exec(indexQuery);
      } catch (error) {
        logger.warn('Failed to create index:', { query: indexQuery, error });
      }
    }
  }

  /**
   * Check database health and attempt recovery if needed
   */
  async checkDatabaseHealth(): Promise<{ healthy: boolean; message: string }> {
    const context: ErrorContext = {
      component: 'sqlite-adapter',
      operation: 'checkDatabaseHealth',
      timestamp: new Date()
    };

    try {
      // Check if database is open
      if (!this.db.open) {
        return { healthy: false, message: 'Database connection is closed' };
      }

      // Run a simple query to test connectivity
      await this.executeQuery('SELECT 1 as test');
      
      // Run integrity check
      const integrityResult = this.db.pragma('integrity_check') as Array<{ integrity_check: string }>;
      const isHealthy = integrityResult.length === 1 && integrityResult[0].integrity_check === 'ok';
      
      if (!isHealthy) {
        logger.warn('Database integrity check failed', { integrityResult });
        
        // Attempt automatic recovery
        const recoveryResult = await agentSkillsErrorHandler.recoverSQLiteDatabase(this.db);
        
        return {
          healthy: recoveryResult.success,
          message: recoveryResult.message
        };
      }
      
      return { healthy: true, message: 'Database is healthy' };
      
    } catch (error) {
      logger.error('Database health check failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      
      return {
        healthy: false,
        message: `Health check failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Perform database maintenance operations
   */
  async performMaintenance(): Promise<void> {
    const context: ErrorContext = {
      component: 'sqlite-adapter',
      operation: 'performMaintenance',
      timestamp: new Date()
    };

    await agentSkillsErrorHandler.executeWithRetry(async () => {
      logger.info('Starting database maintenance');
      
      // Vacuum database to reclaim space
      this.db.exec('VACUUM');
      
      // Analyze tables for query optimization
      this.db.exec('ANALYZE');
      
      // Update statistics
      this.db.pragma('optimize');
      
      logger.info('Database maintenance completed');
    }, context, {
      maxRetries: 2,
      baseDelay: 5000,
      retryableErrors: ['SQLITE_BUSY', 'SQLITE_LOCKED']
    });
  }

  /**
   * Get database statistics for monitoring
   */
  getStats(): {
    totalQueries: number;
    avgQueryTime: number;
    cacheHitRate: number;
    connectionPoolSize: number;
    databaseSize: number;
    pageCount: number;
    freePages: number;
  } {
    try {
      const pageCount = this.db.pragma('page_count', { simple: true }) as number;
      const freePages = this.db.pragma('freelist_count', { simple: true }) as number;
      const pageSize = this.db.pragma('page_size', { simple: true }) as number;
      
      return {
        totalQueries: 0, // Would need to be tracked separately
        avgQueryTime: 0, // Would need to be tracked separately
        cacheHitRate: 0, // Would need to be tracked separately
        connectionPoolSize: 1, // SQLite uses single connection
        databaseSize: pageCount * pageSize,
        pageCount,
        freePages
      };
    } catch (error) {
      logger.error('Failed to get database stats', {
        error: error instanceof Error ? error.message : String(error)
      });
      
      return {
        totalQueries: 0,
        avgQueryTime: 0,
        cacheHitRate: 0,
        connectionPoolSize: 1,
        databaseSize: 0,
        pageCount: 0,
        freePages: 0
      };
    }
  }

  /**
   * Close the adapter and clean up resources
   */
  close(): void {
    // SQLite database will be closed by the main database manager
    logger.info('SQLite Adapter closed');
  }
}