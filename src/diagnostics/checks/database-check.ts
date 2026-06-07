import type Database from 'better-sqlite3';
import type { HealthCheck, HealthCheckResult } from '../types.js';

/**
 * DatabaseHealthCheck — verifies SQLite database integrity via PRAGMA integrity_check.
 *
 * Requirements: 1.5
 */

export class DatabaseHealthCheck implements HealthCheck {
  name = 'Database Integrity';

  constructor(private db: Database.Database) {}

  async run(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const row = this.db.prepare('PRAGMA integrity_check').get() as
        | { integrity_check: string }
        | undefined;

      const result = row?.integrity_check ?? 'unknown';

      if (result === 'ok') {
        return {
          name: this.name,
          status: 'pass',
          message: 'Database integrity check passed',
          durationMs: Date.now() - start,
        };
      }

      return {
        name: this.name,
        status: 'fail',
        message: `Integrity check failed: ${result}`,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        name: this.name,
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }
}
