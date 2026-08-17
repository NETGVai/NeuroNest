/**
 * FencedMigrationCoordinator — Lease-based migration fencing and compatibility checks.
 *
 * Provides:
 * - Renewable lease acquisition with monotonic fencing tokens
 * - Lease renewal and release bound to owner + token
 * - Startup schema compatibility verification
 * - Mutation refusal for processes with incompatible schema or invalid fencing token
 * - Per-step migration tracking with checksums, status, and rollback metadata
 *
 * Requirements: 30.8, 30.12, 31.6–31.10, 32.4, 45.5
 */

import type Database from 'better-sqlite3';

// ─── Types ──────────────────────────────────────────────────────

export interface LeaseResult {
  ok: true;
  owner: string;
  fencingToken: number;
  expiresAt: string;
}

export interface LeaseError {
  ok: false;
  reason: 'held_by_other' | 'token_mismatch' | 'not_held' | 'expired' | 'error';
  message: string;
  currentOwner?: string;
  currentExpiresAt?: string;
}

export type LeaseOutcome = LeaseResult | LeaseError;

export interface CompatibilityDeclaration {
  processName: string;
  readMinVersion: number;
  readMaxVersion: number;
  writeMinVersion: number;
  writeMaxVersion: number;
  observedVersion: number;
}

export interface CompatibilityCheckResult {
  compatible: boolean;
  reason?: string;
  processName: string;
  observedVersion: number;
  readRange: [number, number];
  writeRange: [number, number];
}

export interface MutationCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface MigrationStepRecord {
  stepId: string;
  migrationId: string;
  version: number;
  stepIndex: number;
  status: 'pending' | 'running' | 'applied' | 'rolled_back' | 'failed';
  checksum: string;
  owner: string;
  startedAt?: string;
  completedAt?: string;
  rollbackSql?: string;
  rollbackChecksum?: string;
  failureReason?: string;
}

export interface FencedCoordinatorOptions {
  /** Current schema version of the database */
  currentSchemaVersion?: number;
}

// ─── FencedMigrationCoordinator ─────────────────────────────────

export class FencedMigrationCoordinator {
  private readonly db: Database.Database;
  private readonly currentSchemaVersion: number;

  constructor(db: Database.Database, options: FencedCoordinatorOptions = {}) {
    this.db = db;
    this.currentSchemaVersion = options.currentSchemaVersion ?? 1;
    this.ensureTables();
  }

  // ─── Lease Management ───────────────────────────────────────

  /**
   * Acquire the migration lease with a new fencing token.
   * Fails if already held by another owner and not expired.
   * If the lease is expired or absent, grants it to the new owner.
   */
  acquireLease(owner: string, durationMs: number): LeaseOutcome {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationMs).toISOString();

    return this.db.transaction(() => {
      const existing = this.db.prepare(
        `SELECT owner, fencingToken, expiresAt FROM harness_fenced_lease WHERE leaseId = 'migration_lease'`
      ).get() as { owner: string; fencingToken: number; expiresAt: string } | undefined;

      if (existing) {
        const isExpired = new Date(existing.expiresAt).getTime() <= now.getTime();
        const isSameOwner = existing.owner === owner;

        if (!isExpired && !isSameOwner) {
          return {
            ok: false as const,
            reason: 'held_by_other' as const,
            message: `Lease held by '${existing.owner}' until ${existing.expiresAt}`,
            currentOwner: existing.owner,
            currentExpiresAt: existing.expiresAt,
          };
        }

        // Expired or same owner: bump fencing token and grant
        const newToken = existing.fencingToken + 1;
        this.db.prepare(
          `UPDATE harness_fenced_lease
           SET owner = ?, fencingToken = ?, acquiredAt = ?, expiresAt = ?, renewedAt = NULL
           WHERE leaseId = 'migration_lease'`
        ).run(owner, newToken, now.toISOString(), expiresAt);

        return {
          ok: true as const,
          owner,
          fencingToken: newToken,
          expiresAt,
        };
      }

      // No lease exists: create one with fencingToken = 1
      this.db.prepare(
        `INSERT INTO harness_fenced_lease (leaseId, owner, fencingToken, acquiredAt, expiresAt)
         VALUES ('migration_lease', ?, 1, ?, ?)`
      ).run(owner, now.toISOString(), expiresAt);

      return {
        ok: true as const,
        owner,
        fencingToken: 1,
        expiresAt,
      };
    })();
  }

  /**
   * Renew an existing lease only if the fencing token matches.
   */
  renewLease(owner: string, token: number, durationMs: number): LeaseOutcome {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationMs).toISOString();

    return this.db.transaction(() => {
      const existing = this.db.prepare(
        `SELECT owner, fencingToken, expiresAt FROM harness_fenced_lease WHERE leaseId = 'migration_lease'`
      ).get() as { owner: string; fencingToken: number; expiresAt: string } | undefined;

      if (!existing) {
        return {
          ok: false as const,
          reason: 'not_held' as const,
          message: 'No lease exists to renew',
        };
      }

      if (existing.owner !== owner) {
        return {
          ok: false as const,
          reason: 'held_by_other' as const,
          message: `Lease held by '${existing.owner}', cannot renew for '${owner}'`,
          currentOwner: existing.owner,
          currentExpiresAt: existing.expiresAt,
        };
      }

      if (existing.fencingToken !== token) {
        return {
          ok: false as const,
          reason: 'token_mismatch' as const,
          message: `Fencing token mismatch: expected ${existing.fencingToken}, got ${token}`,
        };
      }

      this.db.prepare(
        `UPDATE harness_fenced_lease SET expiresAt = ?, renewedAt = ? WHERE leaseId = 'migration_lease'`
      ).run(expiresAt, now.toISOString());

      return {
        ok: true as const,
        owner,
        fencingToken: token,
        expiresAt,
      };
    })();
  }

  /**
   * Release the lease. Only succeeds if owner and token match.
   */
  releaseLease(owner: string, token: number): LeaseOutcome {
    return this.db.transaction(() => {
      const existing = this.db.prepare(
        `SELECT owner, fencingToken, expiresAt FROM harness_fenced_lease WHERE leaseId = 'migration_lease'`
      ).get() as { owner: string; fencingToken: number; expiresAt: string } | undefined;

      if (!existing) {
        return {
          ok: false as const,
          reason: 'not_held' as const,
          message: 'No lease exists to release',
        };
      }

      if (existing.owner !== owner) {
        return {
          ok: false as const,
          reason: 'held_by_other' as const,
          message: `Lease held by '${existing.owner}', cannot release for '${owner}'`,
          currentOwner: existing.owner,
          currentExpiresAt: existing.expiresAt,
        };
      }

      if (existing.fencingToken !== token) {
        return {
          ok: false as const,
          reason: 'token_mismatch' as const,
          message: `Fencing token mismatch: expected ${existing.fencingToken}, got ${token}`,
        };
      }

      // Mark as expired (set expiresAt to now) rather than deleting,
      // to preserve the fencing token for monotonicity.
      const nowIso = new Date().toISOString();
      this.db.prepare(
        `UPDATE harness_fenced_lease SET expiresAt = ?, owner = ? WHERE leaseId = 'migration_lease'`
      ).run(nowIso, '__released__');

      return {
        ok: true as const,
        owner,
        fencingToken: token,
        expiresAt: existing.expiresAt,
      };
    })();
  }

  /**
   * Check if the current process holds a valid (non-expired) lease.
   */
  isLeaseHeld(owner: string): boolean {
    const now = new Date();
    const existing = this.db.prepare(
      `SELECT owner, expiresAt FROM harness_fenced_lease WHERE leaseId = 'migration_lease'`
    ).get() as { owner: string; expiresAt: string } | undefined;

    if (!existing) return false;
    if (existing.owner !== owner) return false;
    if (existing.owner === '__released__') return false;
    return new Date(existing.expiresAt).getTime() > now.getTime();
  }

  /**
   * Get the current fencing token (monotonically increasing).
   * Returns 0 if no lease has ever been created.
   */
  getFencingToken(): number {
    const row = this.db.prepare(
      `SELECT fencingToken FROM harness_fenced_lease WHERE leaseId = 'migration_lease'`
    ).get() as { fencingToken: number } | undefined;

    return row?.fencingToken ?? 0;
  }

  // ─── Compatibility Checks ──────────────────────────────────

  /**
   * Register the process's compatibility declaration.
   */
  registerCompatibility(
    processName: string,
    readRange: [number, number],
    writeRange: [number, number],
    observedVersion: number
  ): void {
    const contractId = `contract_${processName}`;
    const compatible = this.isVersionCompatible(readRange, writeRange, observedVersion) ? 1 : 0;

    this.db.prepare(
      `INSERT OR REPLACE INTO harness_schema_contracts
       (contractId, processName, readMinVersion, readMaxVersion, writeMinVersion, writeMaxVersion, observedVersion, compatible)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(contractId, processName, readRange[0], readRange[1], writeRange[0], writeRange[1], observedVersion, compatible);
  }

  /**
   * Verify that the process's declared ranges are compatible with the current schema.
   * A process is compatible if:
   * - Its read range includes the current schema version
   * - Its write range includes the current schema version
   */
  checkStartupCompatibility(processName: string): CompatibilityCheckResult {
    const row = this.db.prepare(
      `SELECT processName, readMinVersion, readMaxVersion, writeMinVersion, writeMaxVersion, observedVersion
       FROM harness_schema_contracts WHERE processName = ?`
    ).get(processName) as {
      processName: string;
      readMinVersion: number;
      readMaxVersion: number;
      writeMinVersion: number;
      writeMaxVersion: number;
      observedVersion: number;
    } | undefined;

    if (!row) {
      return {
        compatible: false,
        reason: `No compatibility declaration found for process '${processName}'`,
        processName,
        observedVersion: 0,
        readRange: [0, 0],
        writeRange: [0, 0],
      };
    }

    const readRange: [number, number] = [row.readMinVersion, row.readMaxVersion];
    const writeRange: [number, number] = [row.writeMinVersion, row.writeMaxVersion];
    const schemaVersion = this.currentSchemaVersion;

    // Check read compatibility: the current schema version must be within the read range
    const readCompatible = schemaVersion >= row.readMinVersion && schemaVersion <= row.readMaxVersion;
    // Check write compatibility: the current schema version must be within the write range
    const writeCompatible = schemaVersion >= row.writeMinVersion && schemaVersion <= row.writeMaxVersion;

    if (!readCompatible) {
      return {
        compatible: false,
        reason: `Current schema version ${schemaVersion} is outside read range [${row.readMinVersion}, ${row.readMaxVersion}]`,
        processName,
        observedVersion: row.observedVersion,
        readRange,
        writeRange,
      };
    }

    if (!writeCompatible) {
      return {
        compatible: false,
        reason: `Current schema version ${schemaVersion} is outside write range [${row.writeMinVersion}, ${row.writeMaxVersion}]`,
        processName,
        observedVersion: row.observedVersion,
        readRange,
        writeRange,
      };
    }

    // Update the compatible flag in the database
    this.db.prepare(
      `UPDATE harness_schema_contracts SET compatible = 1 WHERE processName = ?`
    ).run(processName);

    return {
      compatible: true,
      processName,
      observedVersion: row.observedVersion,
      readRange,
      writeRange,
    };
  }

  /**
   * Check if a process can perform mutations.
   * A process can mutate if:
   * 1. It holds the lease with a matching fencing token, OR
   * 2. The lease is expired/absent (no active migration)
   * AND the process has compatible schema declarations.
   */
  canMutate(processName: string, fencingToken: number): MutationCheckResult {
    // First check compatibility
    const contract = this.db.prepare(
      `SELECT compatible FROM harness_schema_contracts WHERE processName = ?`
    ).get(processName) as { compatible: number } | undefined;

    if (!contract) {
      return {
        allowed: false,
        reason: `No compatibility declaration found for process '${processName}'`,
      };
    }

    if (contract.compatible !== 1) {
      return {
        allowed: false,
        reason: `Process '${processName}' has incompatible schema declaration`,
      };
    }

    // Check the lease state
    const lease = this.db.prepare(
      `SELECT owner, fencingToken, expiresAt FROM harness_fenced_lease WHERE leaseId = 'migration_lease'`
    ).get() as { owner: string; fencingToken: number; expiresAt: string } | undefined;

    // No lease exists — free to mutate
    if (!lease) {
      return { allowed: true };
    }

    const now = new Date();
    const isExpired = new Date(lease.expiresAt).getTime() <= now.getTime();

    // Lease expired — free to mutate
    if (isExpired) {
      return { allowed: true };
    }

    // Lease active — only the holder with matching token can mutate
    if (lease.owner === processName && lease.fencingToken === fencingToken) {
      return { allowed: true };
    }

    // Active lease held by another process or mismatched token — refuse mutation
    return {
      allowed: false,
      reason: `Migration lease active: held by '${lease.owner}' with token ${lease.fencingToken}. Process '${processName}' with token ${fencingToken} is fenced.`,
    };
  }

  // ─── Per-Step Migration Tracking ──────────────────────────

  /**
   * Record a migration step's status, checksum, and rollback metadata.
   */
  recordMigrationStep(step: MigrationStepRecord): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO harness_migration_steps
       (stepId, migrationId, version, stepIndex, status, checksum, owner, startedAt, completedAt, rollbackSql, rollbackChecksum, failureReason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      step.stepId,
      step.migrationId,
      step.version,
      step.stepIndex,
      step.status,
      step.checksum,
      step.owner,
      step.startedAt ?? null,
      step.completedAt ?? null,
      step.rollbackSql ?? null,
      step.rollbackChecksum ?? null,
      step.failureReason ?? null,
    );
  }

  /**
   * Get all recorded migration steps for a given migration.
   */
  getMigrationSteps(migrationId: string): MigrationStepRecord[] {
    return this.db.prepare(
      `SELECT stepId, migrationId, version, stepIndex, status, checksum, owner, startedAt, completedAt, rollbackSql, rollbackChecksum, failureReason
       FROM harness_migration_steps WHERE migrationId = ? ORDER BY stepIndex ASC`
    ).all(migrationId) as MigrationStepRecord[];
  }

  /**
   * Update a migration step's status.
   */
  updateStepStatus(stepId: string, status: MigrationStepRecord['status'], failureReason?: string): void {
    const now = new Date().toISOString();
    if (status === 'applied' || status === 'rolled_back' || status === 'failed') {
      this.db.prepare(
        `UPDATE harness_migration_steps SET status = ?, completedAt = ?, failureReason = ? WHERE stepId = ?`
      ).run(status, now, failureReason ?? null, stepId);
    } else {
      this.db.prepare(
        `UPDATE harness_migration_steps SET status = ?, startedAt = ? WHERE stepId = ?`
      ).run(status, now, stepId);
    }
  }

  // ─── Private Helpers ───────────────────────────────────────

  private isVersionCompatible(
    readRange: [number, number],
    writeRange: [number, number],
    observedVersion: number
  ): boolean {
    const schemaVersion = this.currentSchemaVersion;
    const readOk = schemaVersion >= readRange[0] && schemaVersion <= readRange[1];
    const writeOk = schemaVersion >= writeRange[0] && schemaVersion <= writeRange[1];
    return readOk && writeOk && observedVersion <= schemaVersion;
  }

  private ensureTables(): void {
    // Ensure the migration steps tracking table exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS harness_migration_steps (
        stepId TEXT NOT NULL PRIMARY KEY,
        migrationId TEXT NOT NULL,
        version INTEGER NOT NULL,
        stepIndex INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        checksum TEXT NOT NULL,
        owner TEXT NOT NULL,
        startedAt TEXT,
        completedAt TEXT,
        rollbackSql TEXT,
        rollbackChecksum TEXT,
        failureReason TEXT,
        createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_harness_migration_steps_migration
        ON harness_migration_steps(migrationId, stepIndex);
    `);

    // Ensure the fenced lease table exists (may already exist from migrations)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS harness_fenced_lease (
        leaseId TEXT NOT NULL PRIMARY KEY DEFAULT 'migration_lease',
        owner TEXT NOT NULL,
        fencingToken INTEGER NOT NULL DEFAULT 1,
        acquiredAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        expiresAt TEXT NOT NULL,
        renewedAt TEXT,
        schemaVersion INTEGER NOT NULL DEFAULT 1
      );
    `);

    // Ensure the schema contracts table exists (may already exist from migrations)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS harness_schema_contracts (
        contractId TEXT NOT NULL PRIMARY KEY,
        processName TEXT NOT NULL,
        readMinVersion INTEGER NOT NULL,
        readMaxVersion INTEGER NOT NULL,
        writeMinVersion INTEGER NOT NULL,
        writeMaxVersion INTEGER NOT NULL,
        observedVersion INTEGER NOT NULL,
        compatible INTEGER NOT NULL DEFAULT 1,
        registeredAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        schemaVersion INTEGER NOT NULL DEFAULT 1
      );
    `);
  }
}
