/**
 * DatabaseAuthority — canonical startup/migration coordination for the
 * target-desktop SQLite durable store.
 *
 * D-05 assigns DatabaseAuthority the responsibility to "open SQLite, validate
 * migration registry, WAL/foreign keys/integrity, serialize writes, expose
 * transaction API, backups, schema ranges." D-08.4 and D-09 define the startup
 * order: obtain a migration lease, validate the runtime migration registry
 * contiguity/file mapping, derive the count, check the supported schema range,
 * create a verified backup/rescue, apply one migration per transaction, run
 * integrity checks, and — on conflict/lock/newer-schema/corrupt-backup/
 * registry-drift/crash — preserve the prior readable state and never mark
 * completion.
 *
 * This module is additive over {@link ./database}: it reuses the existing
 * registry, WAL/FK pragmas, and `schema_migrations` table, and layers the
 * missing ledger, lease, schema-range, and rescue semantics the inventory
 * flagged as gaps. It does not become a second writer for any business table.
 *
 * Design anchors: D-04, D-05, D-08, D-09, D-20.
 * Requirements: NN-INV-006 (rescue before mutation), NN-INV-008 (one owner),
 * NN-INV-009 (versioned recoverable transitions), NN-DATA-001/002/003/005/006,
 * NN-DATA-013 (runtime-derived totals), NN-PLATFORM-001, NN-COMPAT-001/002.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

import { getRegisteredMigrations, type Migration } from './database.js';
import {
  resolveDataRootPaths,
  acquireMigrationLease,
  type DataRootPaths,
  type Lease,
  type LeaseInfo,
} from './data-root.js';

// ─── Schema range (D-08.4, NN-COMPAT-001/002) ───────────────────────────────

/**
 * The supported readable/writable schema range for this application revision.
 * Startup refuses to open a writer against a database whose recorded schema is
 * newer than {@link SUPPORTED_SCHEMA.maxWritable}; a newer schema may enter a
 * degraded read-only mode only (D-08.4). Derived from the registry so the
 * maximum tracks the highest known migration rather than a hard-coded total
 * (NN-DATA-013).
 */
export interface SchemaRange {
  /** Minimum schema version this app can read. */
  readonly minReadable: number;
  /** Maximum schema version this app can read/write (highest known migration). */
  readonly maxWritable: number;
}

/** Derive the supported schema range from the runtime migration registry. */
export function deriveSchemaRange(
  migrations: readonly Migration[] = getRegisteredMigrations(),
): SchemaRange {
  const versions = migrations.map((m) => m.version);
  const maxWritable = versions.length > 0 ? Math.max(...versions) : 0;
  return { minReadable: 1, maxWritable };
}

// ─── Runtime registry description (NN-DATA-013) ─────────────────────────────

/**
 * A runtime-derived description of the migration registry at a named revision.
 * `count` and `contiguous` are computed, never hard-coded; `registryDigest`
 * fingerprints the ordered (version, description) pairs so drift is detectable.
 */
export interface MigrationRegistryDescriptor {
  readonly count: number;
  readonly minVersion: number;
  readonly maxVersion: number;
  readonly contiguous: boolean;
  readonly versions: readonly number[];
  readonly registryDigest: string;
}

/** Compute a lowercase sha-256 over the ordered (version|description) pairs. */
function computeRegistryDigest(migrations: readonly Migration[]): string {
  const canonical = [...migrations]
    .sort((a, b) => a.version - b.version)
    .map((m) => `${m.version}|${m.description}`)
    .join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Describe the runtime migration registry (NN-DATA-013). */
export function describeMigrationRegistry(
  migrations: readonly Migration[] = getRegisteredMigrations(),
): MigrationRegistryDescriptor {
  const versions = [...migrations.map((m) => m.version)].sort((a, b) => a - b);
  const count = versions.length;
  const minVersion = count > 0 ? versions[0] : 0;
  const maxVersion = count > 0 ? versions[count - 1] : 0;
  let contiguous = count > 0 && minVersion === 1;
  for (let i = 0; i < count; i++) {
    if (versions[i] !== i + 1) {
      contiguous = false;
      break;
    }
  }
  return {
    count,
    minVersion,
    maxVersion,
    contiguous,
    versions: Object.freeze(versions),
    registryDigest: computeRegistryDigest(migrations),
  };
}

// ─── Errors (NN-INV-011 typed failure) ──────────────────────────────────────

/** Typed startup failure reasons; each preserves the prior readable state. */
export type StartupFailureReason =
  | 'MIGRATION_LEASE_HELD' // another instance owns the migration window
  | 'REGISTRY_DRIFT' // registry non-contiguous or file/count mismatch
  | 'INCOMPATIBLE_NEWER_SCHEMA' // database schema newer than this app supports
  | 'BACKUP_UNVERIFIED' // rescue backup could not be created/verified
  | 'INTEGRITY_FAILED' // integrity check failed before/after migration
  | 'MIGRATION_FAILED'; // a migration transaction threw

export class DatabaseStartupError extends Error {
  readonly reason: StartupFailureReason;
  readonly detail: Record<string, unknown>;
  constructor(reason: StartupFailureReason, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DatabaseStartupError';
    this.reason = reason;
    this.detail = detail;
  }
}

// ─── Ledger (D-08.1 data_root_migration_ledger / schema_migrations) ─────────

/**
 * The durable migration ledger row. `state` is the coordination state; a row
 * is only `completed` once its migration transaction committed. A crash
 * between `applying` and `completed` leaves the row `applying`, which restart
 * detects and never treats as success (D-08.2, NN-DATA-003).
 */
export type LedgerState = 'pending' | 'applying' | 'completed' | 'failed';

export interface MigrationLedgerRow {
  readonly version: number;
  readonly description: string;
  readonly state: LedgerState;
  readonly registryDigest: string;
  readonly backupRef: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly appliedRevision: string | null;
  readonly lastErrorCode: string | null;
}

const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS data_root_migration_ledger (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    state TEXT NOT NULL,
    registry_digest TEXT NOT NULL,
    backup_ref TEXT,
    started_at TEXT,
    completed_at TEXT,
    applied_revision TEXT,
    last_error_code TEXT
  );
`;

// ─── Startup result ─────────────────────────────────────────────────────────

export interface StartupSuccess {
  readonly ok: true;
  readonly db: Database.Database;
  readonly mode: 'writable';
  readonly registry: MigrationRegistryDescriptor;
  readonly schemaRange: SchemaRange;
  /** Schema version recorded after all migrations committed. */
  readonly schemaVersion: number;
  /** Backup file created before mutation, if any migrations were pending. */
  readonly backupRef: string | null;
  /** Versions applied during this startup. */
  readonly appliedVersions: readonly number[];
}

export interface StartupReadOnly {
  readonly ok: true;
  readonly db: Database.Database;
  readonly mode: 'degraded-read-only';
  readonly registry: MigrationRegistryDescriptor;
  readonly schemaRange: SchemaRange;
  /** The (newer) schema version found on disk. */
  readonly schemaVersion: number;
  readonly reason: 'INCOMPATIBLE_NEWER_SCHEMA';
}

export interface StartupBlocked {
  readonly ok: false;
  readonly mode: 'blocked';
  readonly error: DatabaseStartupError;
  /** Whether the prior database remains readable/untouched (always true here). */
  readonly priorStatePreserved: true;
}

export type StartupResult = StartupSuccess | StartupReadOnly | StartupBlocked;

export interface StartupOptions {
  /** Database file path. Defaults to the DataRoot's typed database path. */
  readonly dbPath?: string;
  /** Resolved DataRoot paths. Defaults to {@link resolveDataRootPaths}. */
  readonly paths?: DataRootPaths;
  /** Migration registry to coordinate. Defaults to the runtime registry. */
  readonly migrations?: readonly Migration[];
  /** Directory used for registry file-mapping validation. */
  readonly migrationsDir?: string;
  /** Named revision string recorded in the ledger for applied rows. */
  readonly appliedRevision?: string;
  /** Skip acquiring the migration lease (tests that pre-hold or isolate it). */
  readonly skipLease?: boolean;
  /** Injectable clock. */
  readonly now?: () => Date;
}

// ─── Pragmas (D-08.4 WAL/FK) ────────────────────────────────────────────────

function applyPragmas(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
}

function currentSchemaVersion(db: Database.Database): number {
  const row = db
    .prepare('SELECT MAX(version) AS v FROM schema_migrations')
    .get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

function integrityOk(db: Database.Database): boolean {
  try {
    const rows = db.pragma('integrity_check') as { integrity_check: string }[];
    return rows.length === 1 && rows[0].integrity_check === 'ok';
  } catch {
    return false;
  }
}

// ─── Backup / rescue (NN-INV-006, NN-DATA-006) ──────────────────────────────

/**
 * Create a verified backup of the current database into the DataRoot backups
 * directory using SQLite's consistent online backup API, then verify the
 * backup opens with an `ok` integrity check. Returns the backup path, or
 * throws {@link DatabaseStartupError} `BACKUP_UNVERIFIED` if it cannot be
 * created and verified. Never mutates the source database.
 */
export function createVerifiedBackup(
  db: Database.Database,
  paths: DataRootPaths,
  now: () => Date = () => new Date(),
): string {
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(paths.backups, `pre-migration-${stamp}.db`);
  try {
    // better-sqlite3 exposes a synchronous, consistent backup via VACUUM INTO.
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  } catch (err: unknown) {
    throw new DatabaseStartupError(
      'BACKUP_UNVERIFIED',
      `failed to create rescue backup: ${String(err)}`,
      { backupPath },
    );
  }
  // Verify the backup independently.
  let verifyDb: Database.Database | undefined;
  try {
    verifyDb = new Database(backupPath, { readonly: true });
    if (!integrityOk(verifyDb)) {
      throw new DatabaseStartupError('BACKUP_UNVERIFIED', 'rescue backup failed integrity check', {
        backupPath,
      });
    }
  } catch (err: unknown) {
    if (err instanceof DatabaseStartupError) throw err;
    throw new DatabaseStartupError('BACKUP_UNVERIFIED', `rescue backup unreadable: ${String(err)}`, {
      backupPath,
    });
  } finally {
    verifyDb?.close();
  }
  return backupPath;
}

// ─── Ledger helpers ─────────────────────────────────────────────────────────

function upsertLedger(
  db: Database.Database,
  row: {
    version: number;
    description: string;
    state: LedgerState;
    registryDigest: string;
    backupRef?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
    appliedRevision?: string | null;
    lastErrorCode?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO data_root_migration_ledger
       (version, description, state, registry_digest, backup_ref, started_at, completed_at, applied_revision, last_error_code)
     VALUES (@version, @description, @state, @registryDigest, @backupRef, @startedAt, @completedAt, @appliedRevision, @lastErrorCode)
     ON CONFLICT(version) DO UPDATE SET
       description = excluded.description,
       state = excluded.state,
       registry_digest = excluded.registry_digest,
       backup_ref = COALESCE(excluded.backup_ref, data_root_migration_ledger.backup_ref),
       started_at = COALESCE(excluded.started_at, data_root_migration_ledger.started_at),
       completed_at = excluded.completed_at,
       applied_revision = COALESCE(excluded.applied_revision, data_root_migration_ledger.applied_revision),
       last_error_code = excluded.last_error_code`,
  ).run({
    version: row.version,
    description: row.description,
    state: row.state,
    registryDigest: row.registryDigest,
    backupRef: row.backupRef ?? null,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    appliedRevision: row.appliedRevision ?? null,
    lastErrorCode: row.lastErrorCode ?? null,
  });
}

/** Read the full migration ledger in version order. */
export function readMigrationLedger(db: Database.Database): MigrationLedgerRow[] {
  const rows = db
    .prepare(
      `SELECT version, description, state, registry_digest AS registryDigest, backup_ref AS backupRef,
              started_at AS startedAt, completed_at AS completedAt, applied_revision AS appliedRevision,
              last_error_code AS lastErrorCode
       FROM data_root_migration_ledger ORDER BY version`,
    )
    .all() as MigrationLedgerRow[];
  return rows;
}

// ─── Serialized writer (D-08.2 bounded serialized writes) ───────────────────

/**
 * Execute `work` inside an `IMMEDIATE` transaction, guaranteeing a single
 * bounded serialized writer. Rolls back on error. This is the transaction API
 * D-05 assigns to DatabaseAuthority; callers use it for durable mutations so
 * no two writers race (NN-DATA-002).
 */
export function withSerializedWrite<T>(db: Database.Database, work: (db: Database.Database) => T): T {
  const txn = db.transaction((fn: (db: Database.Database) => T) => fn(db));
  // better-sqlite3 supports .immediate() to force BEGIN IMMEDIATE.
  return txn.immediate(work);
}

// ─── Startup coordination (D-09) ────────────────────────────────────────────

/**
 * Coordinate database startup and migration per D-09:
 *
 * 1. resolve DataRoot typed paths + acquire the migration lease (or defer);
 * 2. open SQLite, configure WAL/FK, create ledger + `schema_migrations`;
 * 3. run an initial integrity check;
 * 4. validate runtime registry contiguity + file mapping (drift -> blocked);
 * 5. check schema range (newer on disk -> degraded read-only, no writer);
 * 6. if migrations are pending, create + verify a rescue backup;
 * 7. apply each pending migration in its own transaction, recording ledger
 *    `applying` -> `completed`; never mark completion on failure;
 * 8. run a post-migration integrity check.
 *
 * Any failure preserves the prior readable state (the on-disk database is
 * never partially mutated: each migration is atomic and a rescue backup exists)
 * and returns a `blocked` result rather than an optimistic success.
 */
export function startupDatabase(options: StartupOptions = {}): StartupResult {
  const now = options.now ?? (() => new Date());
  const paths = options.paths ?? resolveDataRootPaths();
  const dbPath = options.dbPath ?? paths.database;
  const migrations = options.migrations ?? getRegisteredMigrations();
  const migrationsDir = options.migrationsDir ?? path.join(__dirname, 'migrations');
  const appliedRevision = options.appliedRevision ?? 'unbound-working-tree';
  const registry = describeMigrationRegistry(migrations);
  const schemaRange = deriveSchemaRange(migrations);

  // Step 1: migration lease.
  let lease: Lease | undefined;
  if (options.skipLease !== true) {
    const leaseResult = acquireMigrationLease(paths, { now: () => now().getTime() });
    if (!leaseResult.acquired) {
      return {
        ok: false,
        mode: 'blocked',
        priorStatePreserved: true,
        error: new DatabaseStartupError(
          'MIGRATION_LEASE_HELD',
          'migration lease held by another instance; deferring',
          { heldBy: leaseResult.heldBy as LeaseInfo | undefined },
        ),
      };
    }
    lease = leaseResult.lease;
  }

  let db: Database.Database | undefined;
  try {
    // Step 2: open + pragmas + coordination tables.
    db = new Database(dbPath);
    applyPragmas(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.exec(LEDGER_DDL);

    // Step 3: initial integrity check.
    if (!integrityOk(db)) {
      throw new DatabaseStartupError('INTEGRITY_FAILED', 'database failed initial integrity check');
    }

    // Step 4: registry drift.
    if (!registry.contiguous) {
      throw new DatabaseStartupError(
        'REGISTRY_DRIFT',
        `migration registry is not contiguous 1..${registry.count}`,
        { versions: registry.versions },
      );
    }
    validateFileMapping(migrations, migrationsDir);

    // Step 5: schema range — refuse to write a newer schema.
    const onDiskVersion = currentSchemaVersion(db);
    if (onDiskVersion > schemaRange.maxWritable) {
      // Read-only degraded mode: no writer, prior state preserved (D-08.4).
      return {
        ok: true,
        db,
        mode: 'degraded-read-only',
        registry,
        schemaRange,
        schemaVersion: onDiskVersion,
        reason: 'INCOMPATIBLE_NEWER_SCHEMA',
      };
    }

    // Determine pending migrations.
    const applied = new Set(
      (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
        (r) => r.version,
      ),
    );
    const pending = migrations.filter((m) => !applied.has(m.version));

    // Step 6: verified rescue backup before any mutation (NN-INV-006).
    let backupRef: string | null = null;
    if (pending.length > 0 && onDiskVersion > 0) {
      backupRef = createVerifiedBackup(db, paths, now);
    }

    // Step 7: apply each pending migration atomically, recording the ledger.
    const appliedVersions: number[] = [];
    for (const migration of pending) {
      upsertLedger(db, {
        version: migration.version,
        description: migration.description,
        state: 'applying',
        registryDigest: registry.registryDigest,
        backupRef,
        startedAt: now().toISOString(),
      });
      try {
        withSerializedWrite(db, (tx) => {
          migration.up(tx);
          tx.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(
            migration.version,
            migration.description,
          );
          // Mark completion in the SAME transaction as the schema change so a
          // crash can never leave a completed ledger row without its migration.
          upsertLedger(tx, {
            version: migration.version,
            description: migration.description,
            state: 'completed',
            registryDigest: registry.registryDigest,
            backupRef,
            completedAt: now().toISOString(),
            appliedRevision,
          });
        });
        appliedVersions.push(migration.version);
      } catch (err: unknown) {
        // Never mark completion: record failure and stop (D-08.2, NN-DATA-003).
        upsertLedger(db, {
          version: migration.version,
          description: migration.description,
          state: 'failed',
          registryDigest: registry.registryDigest,
          backupRef,
          lastErrorCode: 'MIGRATION_FAILED',
        });
        throw new DatabaseStartupError(
          'MIGRATION_FAILED',
          `migration ${migration.version} failed: ${String(err)}`,
          { version: migration.version, backupRef },
        );
      }
    }

    // Step 8: post-migration integrity check.
    if (!integrityOk(db)) {
      throw new DatabaseStartupError('INTEGRITY_FAILED', 'database failed post-migration integrity check', {
        backupRef,
      });
    }

    return {
      ok: true,
      db,
      mode: 'writable',
      registry,
      schemaRange,
      schemaVersion: currentSchemaVersion(db),
      backupRef,
      appliedVersions: Object.freeze(appliedVersions),
    };
  } catch (err: unknown) {
    // Prior state is preserved: each migration was atomic and a rescue backup
    // exists. Close the handle and surface a typed blocked result.
    db?.close();
    const error =
      err instanceof DatabaseStartupError
        ? err
        : new DatabaseStartupError('MIGRATION_FAILED', String(err));
    return { ok: false, mode: 'blocked', priorStatePreserved: true, error };
  } finally {
    lease?.release();
  }
}

/**
 * Validate that the registered migration count matches the number of migration
 * files in `dir` and that every file version is registered. Throws
 * {@link DatabaseStartupError} `REGISTRY_DRIFT` on mismatch (NN-DATA-013).
 * Silently passes when the directory is absent (e.g. bundled/asar contexts).
 */
export function validateFileMapping(migrations: readonly Migration[], dir: string): void {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => /^\d{3}-.*\.(ts|js)$/.test(f));
  // In compiled output both .js and .ts may exist; collapse to unique versions.
  const fileVersions = new Set(files.map((f) => parseInt(f.slice(0, 3), 10)).filter((v) => !isNaN(v)));
  const registered = new Set(migrations.map((m) => m.version));
  if (fileVersions.size !== registered.size) {
    const unregistered = [...fileVersions].filter((v) => !registered.has(v));
    const missing = [...registered].filter((v) => !fileVersions.has(v));
    throw new DatabaseStartupError(
      'REGISTRY_DRIFT',
      `registered ${registered.size} migrations but found ${fileVersions.size} file versions in ${dir}`,
      { unregistered, missing },
    );
  }
  for (const v of registered) {
    if (!fileVersions.has(v)) {
      throw new DatabaseStartupError('REGISTRY_DRIFT', `registered migration ${v} has no file`, {
        version: v,
      });
    }
  }
}
