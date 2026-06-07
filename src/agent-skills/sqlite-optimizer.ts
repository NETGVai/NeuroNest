import Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

/**
 * SQLite optimization configuration for Agent Skills workload.
 */
export interface SQLiteOptimizerConfig {
  /** WAL mode cache size in pages (negative = KiB). Default: -8000 (~8MB) */
  cacheSize: number;
  /** Max size of the WAL file in pages before auto-checkpoint. Default: 1000 */
  walAutoCheckpointPages: number;
  /** Memory-mapped I/O size in bytes. 0 = disabled. Default: 268435456 (256MB) */
  mmapSize: number;
  /** Max connections in the read pool. Default: 4 */
  maxReadConnections: number;
  /** Busy timeout in milliseconds. Default: 5000 */
  busyTimeout: number;
}

const DEFAULT_CONFIG: SQLiteOptimizerConfig = {
  cacheSize: -8000,
  walAutoCheckpointPages: 1000,
  mmapSize: 268435456,
  maxReadConnections: 4,
  busyTimeout: 5000,
};

/**
 * Result of applying WAL mode configuration.
 */
export interface WalConfigResult {
  journalMode: string;
  synchronous: string;
  cacheSize: number;
  walAutoCheckpoint: number;
}

/**
 * Applies WAL-mode pragmas optimised for the Agent Skills mixed read/write workload.
 *
 * Call once after opening the database (before any queries).
 */
export function configureWalMode(
  db: Database.Database,
  config: Partial<SQLiteOptimizerConfig> = {},
): WalConfigResult {
  const opts = { ...DEFAULT_CONFIG, ...config };

  // WAL mode allows concurrent readers while a single writer is active
  const journalModeResult = db.pragma('journal_mode = WAL') as Array<{ journal_mode: string }>;
  const journalMode = journalModeResult[0]?.journal_mode ?? 'unknown';

  // NORMAL synchronous is safe with WAL and much faster than FULL
  db.pragma('synchronous = NORMAL');

  // Negative value = KiB; positive = pages
  db.pragma(`cache_size = ${opts.cacheSize}`);

  // Keep temp tables in memory
  db.pragma('temp_store = MEMORY');

  // Memory-mapped I/O for faster reads
  db.pragma(`mmap_size = ${opts.mmapSize}`);

  // Auto-checkpoint threshold
  db.pragma(`wal_autocheckpoint = ${opts.walAutoCheckpointPages}`);

  // Busy timeout so writers wait instead of failing immediately
  db.pragma(`busy_timeout = ${opts.busyTimeout}`);

  // Foreign keys (safety)
  db.pragma('foreign_keys = ON');

  const synchronous = String(db.pragma('synchronous', { simple: true }));
  const cacheSize = Number(db.pragma('cache_size', { simple: true }));
  const walAutoCheckpoint = Number(db.pragma('wal_autocheckpoint', { simple: true }));

  logger.info('SQLite WAL mode configured', {
    journalMode,
    synchronous,
    cacheSize,
    walAutoCheckpoint,
  });

  return { journalMode, synchronous, cacheSize, walAutoCheckpoint };
}

/**
 * Creates indexes tailored to Agent Skills query patterns.
 *
 * Safe to call multiple times — uses IF NOT EXISTS.
 */
export function optimizeAgentSkillsIndexes(db: Database.Database): number {
  const indexStatements = [
    // --- skills table ---
    'CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category)',
    'CREATE INDEX IF NOT EXISTS idx_skills_source ON skills(source)',
    'CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled)',

    // --- agent_skill_assignments table ---
    'CREATE INDEX IF NOT EXISTS idx_asa_proficiency ON agent_skill_assignments(proficiency_level)',
    'CREATE INDEX IF NOT EXISTS idx_asa_success_rate ON agent_skill_assignments(success_rate)',
    'CREATE INDEX IF NOT EXISTS idx_asa_agent ON agent_skill_assignments(agent_id)',

    // --- skill_events table (time-series) ---
    'CREATE INDEX IF NOT EXISTS idx_se_entity_ts ON skill_events(entity_type, entity_id, timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_se_type_ts ON skill_events(event_type, timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_se_partition_ts ON skill_events(partition_date, timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_se_correlation ON skill_events(correlation_id)',

    // --- cache_entries table ---
    'CREATE INDEX IF NOT EXISTS idx_ce_expires ON cache_entries(expires_at)',
  ];

  let created = 0;
  for (const stmt of indexStatements) {
    try {
      db.exec(stmt);
      created++;
    } catch (err) {
      logger.warn('Index creation skipped', {
        statement: stmt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Ask SQLite to refresh query planner statistics
  try {
    db.exec('ANALYZE');
  } catch {
    // non-critical
  }

  logger.info('Agent Skills indexes optimized', { created, total: indexStatements.length });
  return created;
}

/**
 * Lightweight connection pool for SQLite.
 *
 * SQLite in WAL mode supports one writer and many concurrent readers.
 * This pool maintains a set of read-only connections and a single
 * write connection (the primary database handle).
 */
export class SQLiteConnectionPool {
  private readonly writeDb: Database.Database;
  private readonly readConnections: Database.Database[] = [];
  private readonly availableReads: Database.Database[] = [];
  private readonly dbPath: string;
  private readonly maxReaders: number;
  private closed = false;

  constructor(writeDb: Database.Database, config: Partial<SQLiteOptimizerConfig> = {}) {
    const opts = { ...DEFAULT_CONFIG, ...config };
    this.writeDb = writeDb;
    this.maxReaders = opts.maxReadConnections;

    // Derive the file path from the write connection.
    // better-sqlite3 exposes `name` which is the file path (or ':memory:').
    this.dbPath = (writeDb as unknown as { name: string }).name ?? ':memory:';
  }

  /** Get the single write connection. */
  getWriteConnection(): Database.Database {
    if (this.closed) {
      throw new Error('Connection pool is closed');
    }
    return this.writeDb;
  }

  /** Borrow a read connection from the pool. */
  acquireReadConnection(): Database.Database {
    if (this.closed) {
      throw new Error('Connection pool is closed');
    }

    // For in-memory databases, just return the write connection
    if (this.dbPath === ':memory:' || this.dbPath === '') {
      return this.writeDb;
    }

    // Return an available connection if one exists
    const existing = this.availableReads.pop();
    if (existing) {
      return existing;
    }

    // Create a new read connection if under the limit
    if (this.readConnections.length < this.maxReaders) {
      const reader = new Database(this.dbPath, { readonly: true });
      reader.pragma('journal_mode = WAL');
      reader.pragma(`cache_size = ${DEFAULT_CONFIG.cacheSize}`);
      reader.pragma(`busy_timeout = ${DEFAULT_CONFIG.busyTimeout}`);
      reader.pragma(`mmap_size = ${DEFAULT_CONFIG.mmapSize}`);
      this.readConnections.push(reader);
      return reader;
    }

    // All readers busy — fall back to the write connection
    return this.writeDb;
  }

  /** Return a read connection to the pool. */
  releaseReadConnection(conn: Database.Database): void {
    if (conn === this.writeDb) {
      return; // nothing to release
    }
    if (!this.closed && this.readConnections.includes(conn)) {
      this.availableReads.push(conn);
    }
  }

  /** Number of read connections currently created. */
  get size(): number {
    return this.readConnections.length;
  }

  /** Number of read connections currently available (idle). */
  get available(): number {
    return this.availableReads.length;
  }

  /** Close all pooled read connections. The write connection is NOT closed. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const conn of this.readConnections) {
      try {
        conn.close();
      } catch {
        // best-effort
      }
    }
    this.readConnections.length = 0;
    this.availableReads.length = 0;
    logger.info('SQLite connection pool closed');
  }
}

/**
 * Convenience: apply all optimizations in one call.
 *
 * Returns the connection pool so callers can use pooled reads.
 */
export function optimizeSQLiteForAgentSkills(
  db: Database.Database,
  config: Partial<SQLiteOptimizerConfig> = {},
): { walConfig: WalConfigResult; indexCount: number; pool: SQLiteConnectionPool } {
  const walConfig = configureWalMode(db, config);
  const indexCount = optimizeAgentSkillsIndexes(db);
  const pool = new SQLiteConnectionPool(db, config);

  logger.info('SQLite fully optimized for Agent Skills workload');
  return { walConfig, indexCount, pool };
}
