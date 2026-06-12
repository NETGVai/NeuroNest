/**
 * WAL Checkpoint Scheduler
 *
 * Manages SQLite WAL (Write-Ahead Log) checkpoints to prevent unbounded WAL growth.
 * Uses idle detection to trigger checkpoints only when the system is not actively
 * processing IPC messages or database writes.
 *
 * - PASSIVE checkpoint: triggered after 30 seconds of idle (no IPC or DB writes)
 * - TRUNCATE checkpoint: triggered when WAL exceeds 50MB on next idle window
 * - Retry: on failure, retries after 60 seconds
 */
import type Database from 'better-sqlite3';
import { getLogger } from '../utils/structured-logger';

export interface CheckpointResult {
  success: boolean;
  pagesCheckpointed: number;
  walSizeAfter: number;
  mode: 'PASSIVE' | 'TRUNCATE';
  error?: string;
}

export interface CheckpointScheduler {
  start(db: Database.Database): void;
  stop(): void;
  forceCheckpoint(mode: 'PASSIVE' | 'TRUNCATE'): CheckpointResult;
  /** Signal that activity occurred (IPC message or DB write). Resets idle timer. */
  recordActivity(): void;
}

export interface CheckpointLogger {
  info(source: string, message: string, context?: Record<string, unknown>): void;
  warn(source: string, message: string, context?: Record<string, unknown>): void;
  error(source: string, message: string, error?: Error, context?: Record<string, unknown>): void;
}

export interface CheckpointSchedulerOptions {
  /** Idle timeout in milliseconds before triggering PASSIVE checkpoint. Default: 30000 */
  idleTimeoutMs?: number;
  /** WAL size threshold in bytes for TRUNCATE checkpoint. Default: 50 * 1024 * 1024 (50MB) */
  walSizeThresholdBytes?: number;
  /** Retry delay in milliseconds after a failed checkpoint. Default: 60000 */
  retryDelayMs?: number;
  /** Optional logger. Falls back to structured logger if not provided. */
  logger?: CheckpointLogger;
  /** Optional function to get WAL file size. Allows injection for testing. */
  getWalSize?: (db: Database.Database) => number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_WAL_SIZE_THRESHOLD = 50 * 1024 * 1024; // 50MB
const DEFAULT_RETRY_DELAY_MS = 60_000;

const LOG_SOURCE = 'WALCheckpoint';

/**
 * Default structured logger used when no custom logger is provided.
 * Delegates to the singleton structured logger instance.
 */
const defaultLogger: CheckpointLogger = {
  info(source: string, message: string, context?: Record<string, unknown>) {
    getLogger().info(source, message, context);
  },
  warn(source: string, message: string, context?: Record<string, unknown>) {
    getLogger().warn(source, message, context);
  },
  error(source: string, message: string, error?: Error, context?: Record<string, unknown>) {
    getLogger().error(source, message, error, context);
  },
};

/**
 * Creates and returns a CheckpointScheduler instance.
 */
export function createCheckpointScheduler(options: CheckpointSchedulerOptions = {}): CheckpointScheduler {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const walSizeThresholdBytes = options.walSizeThresholdBytes ?? DEFAULT_WAL_SIZE_THRESHOLD;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const logger = options.logger ?? defaultLogger;
  const getWalSize = options.getWalSize ?? defaultGetWalSize;

  let db: Database.Database | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let lastActivityTime = Date.now();

  function resetIdleTimer(): void {
    if (!running) return;
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    idleTimer = setTimeout(onIdle, idleTimeoutMs);
  }

  function onIdle(): void {
    if (!running || !db) return;
    idleTimer = null;

    const walSize = getWalSize(db);
    const mode: 'PASSIVE' | 'TRUNCATE' = walSize > walSizeThresholdBytes ? 'TRUNCATE' : 'PASSIVE';

    logger.info(LOG_SOURCE, `Idle detected, initiating ${mode} checkpoint`, {
      walSizeBytes: walSize,
      thresholdBytes: walSizeThresholdBytes,
      idleDurationMs: Date.now() - lastActivityTime,
    });

    const result = executeCheckpoint(mode);

    if (result.success) {
      logger.info(LOG_SOURCE, `Checkpoint completed successfully`, {
        mode: result.mode,
        pagesCheckpointed: result.pagesCheckpointed,
        walSizeAfter: result.walSizeAfter,
      });
    } else {
      logger.warn(LOG_SOURCE, `Checkpoint failed, scheduling retry in ${retryDelayMs}ms`, {
        mode: result.mode,
        error: result.error,
      });
      scheduleRetry(mode);
    }
  }

  function scheduleRetry(mode: 'PASSIVE' | 'TRUNCATE'): void {
    if (!running) return;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!running || !db) return;

      logger.info(LOG_SOURCE, `Retrying ${mode} checkpoint`);
      const result = executeCheckpoint(mode);

      if (result.success) {
        logger.info(LOG_SOURCE, `Retry checkpoint completed successfully`, {
          mode: result.mode,
          pagesCheckpointed: result.pagesCheckpointed,
          walSizeAfter: result.walSizeAfter,
        });
      } else {
        logger.error(LOG_SOURCE, `Retry checkpoint also failed`, undefined, {
          mode: result.mode,
          error: result.error,
        });
      }

      // After retry (success or fail), resume normal idle monitoring
      resetIdleTimer();
    }, retryDelayMs);
  }

  function executeCheckpoint(mode: 'PASSIVE' | 'TRUNCATE'): CheckpointResult {
    if (!db) {
      return {
        success: false,
        pagesCheckpointed: 0,
        walSizeAfter: 0,
        mode,
        error: 'Database not initialized',
      };
    }

    try {
      const result = db.pragma(`wal_checkpoint(${mode})`) as Array<{
        busy: number;
        checkpointed: number;
        log: number;
      }>;

      // better-sqlite3 returns an array with one row for pragma results
      const row = result[0];
      // checkpointed can be -1 for in-memory databases; normalize to 0
      const pagesCheckpointed = Math.max(0, row?.checkpointed ?? 0);
      const walSizeAfter = Math.max(0, getWalSize(db));

      return {
        success: true,
        pagesCheckpointed,
        walSizeAfter,
        mode,
      };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        pagesCheckpointed: 0,
        walSizeAfter: 0,
        mode,
        error: errorMessage,
      };
    }
  }

  const scheduler: CheckpointScheduler = {
    start(database: Database.Database): void {
      if (running) return;
      db = database;
      running = true;
      lastActivityTime = Date.now();
      resetIdleTimer();
      logger.info(LOG_SOURCE, 'Checkpoint scheduler started', {
        idleTimeoutMs,
        walSizeThresholdBytes,
        retryDelayMs,
      });
    },

    stop(): void {
      running = false;
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      db = null;
      logger.info(LOG_SOURCE, 'Checkpoint scheduler stopped');
    },

    forceCheckpoint(mode: 'PASSIVE' | 'TRUNCATE'): CheckpointResult {
      if (!db) {
        return {
          success: false,
          pagesCheckpointed: 0,
          walSizeAfter: 0,
          mode,
          error: 'Database not initialized',
        };
      }

      logger.info(LOG_SOURCE, `Force checkpoint requested`, { mode });
      const result = executeCheckpoint(mode);

      if (result.success) {
        logger.info(LOG_SOURCE, `Force checkpoint completed`, {
          mode: result.mode,
          pagesCheckpointed: result.pagesCheckpointed,
          walSizeAfter: result.walSizeAfter,
        });
      } else {
        logger.warn(LOG_SOURCE, `Force checkpoint failed`, {
          mode: result.mode,
          error: result.error,
        });
      }

      return result;
    },

    recordActivity(): void {
      lastActivityTime = Date.now();
      resetIdleTimer();
    },
  };

  return scheduler;
}

/**
 * Default implementation to get WAL file size.
 * Uses PRAGMA wal_checkpoint to get page count info, since in-memory DBs
 * don't have a WAL file on disk. For file-based DBs, this approximates
 * WAL size from page count * page_size.
 */
function defaultGetWalSize(db: Database.Database): number {
  try {
    // Get page size
    const pageSizeResult = db.pragma('page_size') as Array<{ page_size: number }>;
    const pageSize = pageSizeResult[0]?.page_size ?? 4096;

    // Get WAL page count via wal_checkpoint(PASSIVE) without actually truncating
    // The 'log' field tells us how many pages are in the WAL
    // Note: in-memory databases may return -1; normalize to 0
    const result = db.pragma('wal_checkpoint(PASSIVE)') as Array<{
      busy: number;
      checkpointed: number;
      log: number;
    }>;
    const walPages = Math.max(0, result[0]?.log ?? 0);

    return walPages * pageSize;
  } catch {
    return 0;
  }
}
