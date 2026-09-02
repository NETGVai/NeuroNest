/**
 * DataRoot — canonical, typed data-root paths and instance/migration leases.
 *
 * D-04 assigns DataRoot the responsibility to "resolve/create canonical root;
 * acquire instance/migration leases; expose typed paths; own data-root
 * migration ledger." D-05 anchors this on `src/storage/data-directory.ts`.
 *
 * This module is additive over {@link ./data-directory}: it does NOT introduce
 * a second writable root and it does NOT change the legacy `.ai-superagent`
 * marker migration. It layers typed path accessors and cooperative file
 * leases (instance + migration) so that the DatabaseAuthority and the
 * data-root MigrationCoordinator can serialize privileged startup work.
 *
 * Design anchors: D-04, D-05, D-08, D-09, D-20.
 * Requirements: NN-DATA-001 (one canonical root), NN-DATA-005 (atomic files),
 * NN-DATA-006/NN-INV-006 (rescue before mutation), NN-INV-008 (one owner per
 * data class), NN-COMPAT-001/002 (additive-first, single-writer cutover),
 * NN-PLATFORM-001 (main process owns privileged filesystem operations).
 */

import path from 'node:path';
import fs from 'node:fs';

import { getDataDirectory } from './data-directory.js';

/**
 * The typed sub-paths a DataRoot exposes. Every data-persisting consumer
 * obtains a concrete path from a typed accessor rather than joining strings
 * against the root directly, so the set of writable locations is enumerable
 * and owned (NN-DATA-001, NN-INV-008).
 */
export interface DataRootPaths {
  /** The canonical root directory, `~/.neuronest`. */
  readonly root: string;
  /** Primary durable SQLite database file. */
  readonly database: string;
  /** Directory holding verified pre-migration backups / rescue artifacts. */
  readonly backups: string;
  /** Directory holding content-addressed artifacts (checkpoints, exports). */
  readonly artifacts: string;
  /** Directory holding emitted evidence records. */
  readonly evidence: string;
  /** Directory holding transient temp files promoted atomically (NN-DATA-005). */
  readonly tmp: string;
  /** Directory holding cooperative lock/lease files. */
  readonly locks: string;
}

/** The canonical relative layout under the DataRoot. */
const LAYOUT = Object.freeze({
  database: 'data.db',
  backups: 'backups',
  artifacts: 'artifacts',
  evidence: 'evidence',
  tmp: 'tmp',
  locks: 'locks',
});

/**
 * Resolve the typed DataRoot paths, creating the root and its owned
 * subdirectories if absent. The root itself comes from the single
 * Data_Directory_Accessor so no other module computes a home-relative path.
 */
export function resolveDataRootPaths(root: string = getDataDirectory()): DataRootPaths {
  const paths: DataRootPaths = {
    root,
    database: path.join(root, LAYOUT.database),
    backups: path.join(root, LAYOUT.backups),
    artifacts: path.join(root, LAYOUT.artifacts),
    evidence: path.join(root, LAYOUT.evidence),
    tmp: path.join(root, LAYOUT.tmp),
    locks: path.join(root, LAYOUT.locks),
  };
  fs.mkdirSync(paths.root, { recursive: true });
  for (const dir of [paths.backups, paths.artifacts, paths.evidence, paths.tmp, paths.locks]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}

/**
 * A held cooperative lease. Releasing is idempotent. A lease is backed by an
 * exclusively-created file whose contents identify the holder (pid + token +
 * acquisition time), so stale leases from crashed instances can be reclaimed.
 */
export interface Lease {
  /** The lease kind (e.g. `instance`, `migration`). */
  readonly kind: string;
  /** Absolute path to the backing lock file. */
  readonly lockPath: string;
  /** The opaque owner token written into the lock file. */
  readonly token: string;
  /** Release the lease. Idempotent; safe to call in a `finally`. */
  release(): void;
}

/** Outcome of attempting to acquire a lease. */
export type LeaseResult =
  | { readonly acquired: true; readonly lease: Lease }
  | { readonly acquired: false; readonly reason: 'held'; readonly heldBy: LeaseInfo | undefined };

/** Parsed contents of a lease file. */
export interface LeaseInfo {
  readonly pid: number;
  readonly token: string;
  readonly acquiredAtMs: number;
}

export interface AcquireLeaseOptions {
  /**
   * Milliseconds after which a lease whose owner did not refresh it is
   * considered stale and may be reclaimed. Defaults to 5 minutes. A stale
   * lease is only reclaimed when the recorded pid is not a live process, or
   * the lease is older than `staleAfterMs` — whichever the caller opts into.
   */
  readonly staleAfterMs?: number;
  /**
   * When true, reclaim a stale lease purely on age even if the recorded pid
   * still appears live. Defaults to false so a long-running healthy holder is
   * never evicted mid-flight.
   */
  readonly reclaimStaleOnAge?: boolean;
  /** Injectable clock for tests. */
  readonly now?: () => number;
  /** Injectable liveness probe for tests. Returns true if pid is alive. */
  readonly isProcessAlive?: (pid: number) => boolean;
}

const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs error checking without sending a signal.
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // ESRCH = no such process (dead). EPERM = exists but not ours (alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLeaseInfo(lockPath: string): LeaseInfo | undefined {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LeaseInfo>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.token === 'string' &&
      typeof parsed.acquiredAtMs === 'number'
    ) {
      return { pid: parsed.pid, token: parsed.token, acquiredAtMs: parsed.acquiredAtMs };
    }
  } catch {
    // Unreadable / malformed lock — treat as absent info.
  }
  return undefined;
}

let leaseCounter = 0;

function mintToken(kind: string, now: () => number): string {
  leaseCounter += 1;
  return `${kind}-${process.pid}-${now()}-${leaseCounter}`;
}

/**
 * Acquire a cooperative file lease of the given `kind` under the DataRoot's
 * `locks` directory. Returns `{acquired:false, reason:'held'}` when another
 * live holder owns it. A lease left behind by a dead process (or, when
 * `reclaimStaleOnAge`, one older than `staleAfterMs`) is reclaimed atomically.
 *
 * This is cooperative advisory locking layered on `O_CREAT|O_EXCL`, matching
 * the existing migration-lock discipline in {@link ./data-directory}. It never
 * blocks; callers decide whether a `held` result defers or fails.
 */
export function acquireLease(
  paths: DataRootPaths,
  kind: string,
  options: AcquireLeaseOptions = {},
): LeaseResult {
  const now = options.now ?? (() => Date.now());
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const lockPath = path.join(paths.locks, `${kind}.lock`);
  const token = mintToken(kind, now);

  const tryCreate = (): Lease | undefined => {
    let fd: number | undefined;
    try {
      fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      const info: LeaseInfo = { pid: process.pid, token, acquiredAtMs: now() };
      fs.writeSync(fd, JSON.stringify(info));
      return makeLease(kind, lockPath, token);
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  };

  const created = tryCreate();
  if (created) return { acquired: true, lease: created };

  // Lock exists — decide whether it is reclaimable.
  const info = readLeaseInfo(lockPath);
  if (info) {
    const ageMs = now() - info.acquiredAtMs;
    const ownerDead = !isAlive(info.pid);
    const staleByAge = options.reclaimStaleOnAge === true && ageMs > staleAfterMs;
    if (ownerDead || staleByAge) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Someone else may have reclaimed it first; fall through to held.
      }
      const reclaimed = tryCreate();
      if (reclaimed) return { acquired: true, lease: reclaimed };
    }
  }
  return { acquired: false, reason: 'held', heldBy: info };
}

function makeLease(kind: string, lockPath: string, token: string): Lease {
  let released = false;
  return {
    kind,
    lockPath,
    token,
    release(): void {
      if (released) return;
      released = true;
      // Only remove the lock if we still own it (token matches), so we never
      // delete a lease reclaimed by another instance after ours went stale.
      const info = readLeaseInfo(lockPath);
      if (info === undefined || info.token === token) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      }
    },
  };
}

/**
 * Acquire the single-instance lease. Held for the lifetime of a running
 * application instance; a `held` result means another instance is running.
 */
export function acquireInstanceLease(
  paths: DataRootPaths,
  options?: AcquireLeaseOptions,
): LeaseResult {
  return acquireLease(paths, 'instance', options);
}

/**
 * Acquire the migration lease. Only the holder may run migrations or the
 * data-root MigrationCoordinator. A `held` result means another instance owns
 * the migration window and this instance must defer (D-08.4, D-09).
 */
export function acquireMigrationLease(
  paths: DataRootPaths,
  options?: AcquireLeaseOptions,
): LeaseResult {
  return acquireLease(paths, 'migration', options);
}
