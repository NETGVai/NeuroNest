import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { RecoveryResult } from './error-handler.js';

/**
 * SQLite Database Recovery Manager
 *
 * Provides corruption detection, backup/restore, and automatic recovery
 * mechanisms for the Agent Skills SQLite database.
 *
 * Requirements: 12.5
 */

export interface BackupResult {
  success: boolean;
  backupPath?: string;
  message: string;
  timestamp: Date;
}

export interface CorruptionReport {
  isCorrupted: boolean;
  issues: string[];
  severity: 'none' | 'minor' | 'major' | 'critical';
  timestamp: Date;
}

export class DatabaseRecoveryManager {
  private db!: Database.Database;
  private backupDir!: string;
  private recoveryTimer?: ReturnType<typeof setInterval>;

  constructor(database: Database.Database, backupDir: string) {
    this.db = database;
    this.backupDir = backupDir;
    fs.mkdirSync(this.backupDir, { recursive: true });
  }

  /**
   * Detect corruption by running integrity and foreign key checks
   */
  detectCorruption(): CorruptionReport {
    const issues: string[] = [];
    let severity: CorruptionReport['severity'] = 'none';

    try {
      // Quick check: can we query at all?
      if (!this.db.open) {
        return {
          isCorrupted: true,
          issues: ['Database connection is closed'],
          severity: 'critical',
          timestamp: new Date()
        };
      }

      // Run integrity check
      const integrityResult = this.db.pragma('integrity_check') as Array<{ integrity_check: string }>;
      const integrityOk = integrityResult.length === 1 && integrityResult[0]?.integrity_check === 'ok';

      if (!integrityOk) {
        for (const row of integrityResult) {
          if (row?.integrity_check && row.integrity_check !== 'ok') {
            issues.push(row.integrity_check);
          }
        }
        severity = issues.length > 3 ? 'critical' : 'major';
      }

      // Run foreign key check
      const fkResult = this.db.pragma('foreign_key_check') as Array<{ table: string; rowid: number; parent: string; fkid: number }>;
      if (fkResult.length > 0) {
        for (const violation of fkResult) {
          issues.push(`FK violation: ${violation.table} row ${violation.rowid} -> ${violation.parent}`);
        }
        if (severity === 'none') {
          severity = 'minor';
        }
      }
    } catch (error) {
      issues.push(`Detection failed: ${error instanceof Error ? error.message : String(error)}`);
      severity = 'critical';
    }

    return {
      isCorrupted: issues.length > 0,
      issues,
      severity,
      timestamp: new Date()
    };
  }

  /**
   * Create a backup of the database using SQLite's backup API
   */
  async createBackup(label?: string): Promise<BackupResult> {
    const timestamp = new Date();
    const fileName = `backup-${label ?? 'auto'}-${timestamp.getTime()}.db`;
    const backupPath = path.join(this.backupDir, fileName);

    try {
      await this.db.backup(backupPath);

      logger.info('Database backup created', { backupPath });

      // Prune old backups, keep last 5
      this.pruneOldBackups(5);

      return {
        success: true,
        backupPath,
        message: 'Backup created successfully',
        timestamp
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Database backup failed', { error: msg });
      return {
        success: false,
        message: `Backup failed: ${msg}`,
        timestamp
      };
    }
  }

  /**
   * Restore database from a backup file.
   * Returns a new Database instance pointing to the restored data.
   */
  restoreFromBackup(backupPath: string): RecoveryResult {
    try {
      if (!fs.existsSync(backupPath)) {
        return {
          success: false,
          message: `Backup file not found: ${backupPath}`
        };
      }

      // Validate the backup is a valid SQLite database
      const testDb = new Database(backupPath, { readonly: true });
      const check = testDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
      const backupOk = check.length === 1 && check[0]?.integrity_check === 'ok';
      testDb.close();

      if (!backupOk) {
        return {
          success: false,
          message: 'Backup file is corrupted and cannot be used for restore'
        };
      }

      // Copy backup over the current database file
      const dbPath = this.db.name;
      if (!dbPath || dbPath === ':memory:' || dbPath === '') {
        return {
          success: false,
          message: 'Cannot restore in-memory databases from backup'
        };
      }

      // Close current connection, copy backup, reopen
      this.db.close();
      fs.copyFileSync(backupPath, dbPath);
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');

      logger.info('Database restored from backup', { backupPath });

      return {
        success: true,
        message: 'Database restored successfully from backup'
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Database restore failed', { error: msg });
      return {
        success: false,
        message: `Restore failed: ${msg}`,
        requiresManualIntervention: true
      };
    }
  }

  /**
   * Attempt automatic recovery: reindex, then integrity check.
   * If that fails and a backup exists, restore from the latest backup.
   */
  attemptRecovery(): RecoveryResult {
    logger.info('Starting automatic database recovery');

    try {
      // Step 1: Try reindex recovery
      const reindexResult = this.reindexRecovery();
      if (reindexResult.success) {
        return reindexResult;
      }

      // Step 2: Try restoring from latest backup
      const latestBackup = this.getLatestBackupPath();
      if (latestBackup) {
        logger.info('Attempting restore from latest backup', { backupPath: latestBackup });
        return this.restoreFromBackup(latestBackup);
      }

      return {
        success: false,
        message: 'Recovery failed: no backup available for restore',
        requiresManualIntervention: true
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Automatic recovery failed', { error: msg });
      return {
        success: false,
        message: `Recovery failed: ${msg}`,
        requiresManualIntervention: true
      };
    }
  }

  /**
   * Try to recover by enabling writable_schema and reindexing all tables
   */
  private reindexRecovery(): RecoveryResult {
    try {
      this.db.pragma('writable_schema = ON');

      const tables = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      ).all() as Array<{ name: string }>;

      for (const table of tables) {
        try {
          this.db.exec(`REINDEX "${table.name}"`);
        } catch (_reindexErr) {
          // Continue with other tables
        }
      }

      this.db.pragma('writable_schema = OFF');

      // Verify recovery worked
      const check = this.db.pragma('integrity_check') as Array<{ integrity_check: string }>;
      if (check.length === 1 && check[0]?.integrity_check === 'ok') {
        logger.info('Reindex recovery successful');
        return { success: true, message: 'Database recovered via reindex' };
      }

      return { success: false, message: 'Reindex did not resolve corruption' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, message: `Reindex recovery failed: ${msg}` };
    }
  }

  /**
   * Get the path to the most recent backup file
   */
  getLatestBackupPath(): string | null {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('backup-') && f.endsWith('.db'))
        .sort()
        .reverse();

      if (files.length === 0) return null;
      const first = files[0];
      if (!first) return null;
      return path.join(this.backupDir, first);
    } catch {
      return null;
    }
  }

  /**
   * Remove old backups, keeping the most recent `keep` files
   */
  private pruneOldBackups(keep: number): void {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('backup-') && f.endsWith('.db'))
        .sort()
        .reverse();

      for (let i = keep; i < files.length; i++) {
        const file = files[i];
        if (file) {
          fs.unlinkSync(path.join(this.backupDir, file));
        }
      }
    } catch (error) {
      logger.warn('Failed to prune old backups', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Schedule periodic corruption checks and backups
   */
  startScheduledRecovery(intervalMs: number = 3600000): void {
    this.stopScheduledRecovery();

    this.recoveryTimer = setInterval(() => {
      try {
        const report = this.detectCorruption();
        if (report.isCorrupted) {
          logger.warn('Scheduled check detected corruption', { severity: report.severity, issues: report.issues });
          this.attemptRecovery();
        } else {
          // Create periodic backup when healthy
          void this.createBackup('scheduled');
        }
      } catch (error) {
        logger.error('Scheduled recovery check failed', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }, intervalMs);

    logger.info('Scheduled recovery started', { intervalMs });
  }

  /**
   * Stop scheduled recovery checks
   */
  stopScheduledRecovery(): void {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
  }

  /**
   * Get the current database instance (may change after restore)
   */
  getDatabase(): Database.Database {
    return this.db;
  }

  /**
   * Shutdown and clean up
   */
  shutdown(): void {
    this.stopScheduledRecovery();
    logger.info('DatabaseRecoveryManager shut down');
  }
}
