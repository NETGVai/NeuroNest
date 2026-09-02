/**
 * MigrationRunner — Expand/Contract pattern migration coordinator for the harness Shared_Database.
 *
 * Reads .sql migration files in numbered order, applies them inside transactions,
 * records migration status (applied, rolled_back, failed), enforces foreign keys,
 * and supports the expand/contract migration lifecycle.
 *
 * Requirements: 3.1–3.7, 28.4, 31.3–31.12
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────

export type MigrationPhase = 'expand' | 'contract';
export type MigrationState = 'pending' | 'applied' | 'rolled_back' | 'failed';

export interface MigrationRecord {
  migrationId: string;
  version: number;
  name: string;
  phase: MigrationPhase;
  state: MigrationState;
  checksum: string;
  appliedBy: string | null;
  appliedAt: string | null;
  rolledBackAt: string | null;
  failureReason: string | null;
}

export interface MigrationFile {
  version: number;
  name: string;
  phase: MigrationPhase;
  filename: string;
  sql: string;
  checksum: string;
}

export interface MigrationRunnerOptions {
  /** Path to the directory containing .sql migration files */
  migrationsDir?: string;
  /** Process owner identity for tracking who applied the migration */
  owner?: string;
}

// ─── MigrationRunner ────────────────────────────────────────────

export class MigrationRunner {
  private readonly db: Database.Database;
  private readonly migrationsDir: string;
  private readonly owner: string;

  constructor(db: Database.Database, options: MigrationRunnerOptions = {}) {
    this.db = db;
    this.migrationsDir = options.migrationsDir ?? path.join(__dirname, 'migrations');
    this.owner = options.owner ?? 'unknown';

    // Enforce foreign keys
    this.db.pragma('foreign_keys = ON');
  }

  /**
   * Bootstrap the migration tracking table. This is the first thing that must run.
   */
  ensureMigrationTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS harness_migration_history (
        migrationId TEXT NOT NULL PRIMARY KEY,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT 'expand',
        state TEXT NOT NULL DEFAULT 'pending',
        checksum TEXT NOT NULL,
        appliedBy TEXT,
        appliedAt TEXT,
        rolledBackAt TEXT,
        failureReason TEXT,
        schemaVersion INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_harness_migration_version_phase
        ON harness_migration_history(version, phase);

      CREATE INDEX IF NOT EXISTS idx_harness_migration_state
        ON harness_migration_history(state);
    `);
  }

  /**
   * Discover all .sql migration files from the migrations directory.
   * Files must be named NNN_description.sql (e.g. 001_create_events.sql).
   */
  discoverMigrations(): MigrationFile[] {
    if (!fs.existsSync(this.migrationsDir)) {
      return [];
    }

    const files = fs.readdirSync(this.migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    return files.map(filename => {
      const match = filename.match(/^(\d{3})_(.+)\.sql$/);
      if (!match) {
        throw new Error(`Invalid migration filename: ${filename}. Expected NNN_description.sql`);
      }

      const version = parseInt(match[1], 10);
      const name = match[2];
      const sql = fs.readFileSync(path.join(this.migrationsDir, filename), 'utf-8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');

      return {
        version,
        name,
        phase: 'expand' as MigrationPhase,
        filename,
        sql,
        checksum,
      };
    });
  }

  /**
   * Get the history of applied migrations from the database.
   */
  getAppliedMigrations(): MigrationRecord[] {
    const stmt = this.db.prepare(
      `SELECT migrationId, version, name, phase, state, checksum, appliedBy, appliedAt, rolledBackAt, failureReason
       FROM harness_migration_history
       ORDER BY version ASC`
    );
    return stmt.all() as MigrationRecord[];
  }

  /**
   * Apply all pending migrations in version order.
   * Returns the list of applied migration versions.
   */
  applyAll(): number[] {
    const discovered = this.discoverMigrations();
    if (discovered.length === 0) {
      throw new Error(`No harness SQL migrations found in required directory: ${this.migrationsDir}`);
    }

    this.ensureMigrationTable();

    const applied = new Set(
      this.getAppliedMigrations()
        .filter(m => m.state === 'applied')
        .map(m => m.version)
    );

    const pending = discovered.filter(m => !applied.has(m.version));
    const appliedVersions: number[] = [];

    for (const migration of pending) {
      this.applyOne(migration);
      appliedVersions.push(migration.version);
    }

    return appliedVersions;
  }

  /**
   * Apply a single migration file inside a transaction.
   * Records success or failure in the migration history table.
   */
  applyOne(migration: MigrationFile): void {
    const migrationId = `${String(migration.version).padStart(3, '0')}_${migration.name}_${migration.phase}`;
    const now = new Date().toISOString();

    try {
      this.db.transaction(() => {
        // Execute migration SQL
        this.db.exec(migration.sql);

        // Record success
        this.db.prepare(
          `INSERT OR REPLACE INTO harness_migration_history
           (migrationId, version, name, phase, state, checksum, appliedBy, appliedAt)
           VALUES (?, ?, ?, ?, 'applied', ?, ?, ?)`
        ).run(
          migrationId,
          migration.version,
          migration.name,
          migration.phase,
          migration.checksum,
          this.owner,
          now
        );
      })();
    } catch (error: unknown) {
      // Record failure
      const reason = error instanceof Error ? error.message : String(error);
      this.db.prepare(
        `INSERT OR REPLACE INTO harness_migration_history
         (migrationId, version, name, phase, state, checksum, appliedBy, appliedAt, failureReason)
         VALUES (?, ?, ?, ?, 'failed', ?, ?, ?, ?)`
      ).run(
        migrationId,
        migration.version,
        migration.name,
        migration.phase,
        migration.checksum,
        this.owner,
        now,
        reason
      );
      throw error;
    }
  }

  /**
   * Get the current migration status for reporting.
   */
  getStatus(): { applied: number; failed: number; pending: number; total: number } {
    this.ensureMigrationTable();

    const discovered = this.discoverMigrations();
    const history = this.getAppliedMigrations();

    const appliedCount = history.filter(m => m.state === 'applied').length;
    const failedCount = history.filter(m => m.state === 'failed').length;

    return {
      applied: appliedCount,
      failed: failedCount,
      pending: discovered.length - appliedCount,
      total: discovered.length,
    };
  }

  /**
   * Verify that a specific migration's checksum matches what was applied.
   * Returns true if consistent, false if checksums differ.
   */
  verifyChecksum(version: number): boolean {
    const discovered = this.discoverMigrations().find(m => m.version === version);
    if (!discovered) return false;

    const applied = this.getAppliedMigrations().find(m => m.version === version && m.state === 'applied');
    if (!applied) return false;

    return discovered.checksum === applied.checksum;
  }
}
