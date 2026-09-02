/**
 * DurabilityVerification — integrity cadence, backup/restore, artifact-reference
 * cleanup, and the P2 durability exit-gate evaluator
 * (FUT-PKG-03-DURABILITY/T-006).
 *
 * This module implements the runtime durability protections D-08.4 assigns and
 * the composite exit gate the P2 package rolls up on:
 *
 *   - **Integrity cadence** ({@link runIntegrityCheck}, {@link isIntegrityDue}):
 *     D-08.4 "Integrity checks run after backup and migration and on scheduled
 *     cadence. Failure closes writers, preserves database." A failed check is a
 *     hard fail that must close writers and block a durable cutover.
 *   - **Backup / restore** ({@link createDatabaseBackup}, {@link restoreDatabaseBackup}):
 *     D-08.4 / NN-DATA-006 "Backups are ... atomically created,
 *     restoration-tested by release evidence." A backup is created with
 *     SQLite's consistent `VACUUM INTO`, verified to open with an `ok`
 *     integrity check, and a restore is proven to reproduce the exact business
 *     effect present at backup time (round-trip integrity, NN-DATA-010).
 *   - **Artifact-reference cleanup** ({@link scanArtifactReferences},
 *     {@link planArtifactCleanup}): D-08.4 "Deletion ... does not orphan
 *     artifact references." Cleanup NEVER deletes an artifact that a live
 *     durable reference still points at, and it surfaces dangling references
 *     (a durable row pointing at a missing artifact) as a data-loss signal.
 *   - **Exit-gate evaluator** ({@link evaluateDurabilityGate}): rolls the P2
 *     invariants into one verdict — no duplicate/lost business effect, no
 *     protected-event collapse, no orphan artifact, no false-current
 *     projection, no unbounded replay lag — and BLOCKS on any data-loss /
 *     integrity / restore failure (NN-VERIFY-005, the P3+ durable-cutover gate).
 *
 * This module is additive: it owns no business table and is a reader/verifier
 * over the committed `outbox` ({@link ./authority-transaction}), the projection
 * checkpoints ({@link ./projection-service}), the reconciler
 * ({@link ./operation-journal}), and the compaction/retention planner
 * ({@link ./retention-compaction}). It never becomes a second writer for a
 * business table (NN-INV-008).
 *
 * Design anchors: D-08 (D-08.3 reconciliation, D-08.4 backup/retention/
 * integrity), D-18 (fail-closed integrity), D-19 (lag/health), D-22 (durability
 * exit-gate verification). Requirements: NN-DATA-006 (backup/rescue),
 * NN-DATA-007 (retention/protected classes), NN-DATA-010 (round-trip),
 * NN-EVENT-003/004/005/006 (ordering/projection/reconciliation/compaction),
 * NN-OBS-005 (truthful readiness/lag), NN-VERIFY-002/003/004/005 (taxonomy /
 * property / no-weakened-tests / release blockers).
 */

import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { ScopeDescriptor } from '../shared/contract-primitives.js';
import { computeScopeKey } from './authority-transaction.js';
import { reconcile } from './operation-journal.js';
import { computeOutboxHealth } from './outbox-publisher.js';
import {
  auditRetentionProtection,
  planRetention,
  verifyCompactionReplay,
  type RetentionClassPolicy,
} from './retention-compaction.js';

// ─── Integrity cadence (D-08.4 fail-closed integrity) ────────────────────────

/** The outcome of a database integrity check. */
export interface IntegrityResult {
  /** True iff SQLite's `integrity_check` and `foreign_key_check` both pass. */
  readonly ok: boolean;
  /** The raw integrity_check rows (empty when the DB is closed/unreadable). */
  readonly integrityMessages: readonly string[];
  /** Any foreign-key violations found (empty when clean). */
  readonly foreignKeyViolations: number;
  readonly checkedAt: string;
}

/**
 * Run SQLite's `integrity_check` and `foreign_key_check`. A clean database
 * returns `ok: true` with a single `ok` integrity message and zero FK
 * violations. A corrupt database returns `ok: false` with the messages. This is
 * the scheduled-cadence check D-08.4 requires; a `false` result MUST close
 * writers and block a durable cutover (fail-closed, D-18).
 */
export function runIntegrityCheck(
  db: Database.Database,
  now: () => Date = () => new Date(),
): IntegrityResult {
  const checkedAt = now().toISOString();
  try {
    const integrityRows = db.pragma('integrity_check') as {
      integrity_check: string;
    }[];
    const messages = integrityRows.map((r) => r.integrity_check);
    const fkRows = db.pragma('foreign_key_check') as unknown[];
    const ok = messages.length === 1 && messages[0] === 'ok' && fkRows.length === 0;
    return {
      ok,
      integrityMessages: messages,
      foreignKeyViolations: fkRows.length,
      checkedAt,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      integrityMessages: [`integrity check threw: ${String(err)}`],
      foreignKeyViolations: 0,
      checkedAt,
    };
  }
}

/**
 * Whether an integrity check is due given the last-checked timestamp and the
 * cadence interval. `undefined` last-checked means never checked -> due. Ages
 * come from wall clock only for scheduling, never for ordering (D-19.1).
 */
export function isIntegrityDue(
  lastCheckedAtIso: string | undefined,
  cadenceMs: number,
  now: () => Date = () => new Date(),
): boolean {
  if (!lastCheckedAtIso) return true;
  const lastMs = Date.parse(lastCheckedAtIso);
  if (!Number.isFinite(lastMs)) return true;
  return now().getTime() - lastMs >= cadenceMs;
}

// ─── Backup / restore (D-08.4, NN-DATA-006, NN-DATA-010) ─────────────────────

/** The outcome of a backup attempt. */
export interface BackupResult {
  /** True iff the backup was created and independently verified `ok`. */
  readonly verified: boolean;
  readonly backupPath: string;
  readonly detail?: string;
}

/**
 * Create a verified backup of `db` at `backupPath` using SQLite's consistent
 * `VACUUM INTO`, then open the backup read-only and confirm it passes an
 * integrity check. Never mutates the source database. The path's parent
 * directory is created if absent. Returns `verified: false` with a detail on
 * any failure rather than throwing, so a caller can classify and block.
 */
export function createDatabaseBackup(
  db: Database.Database,
  backupPath: string,
): BackupResult {
  try {
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    // Remove a stale target so VACUUM INTO (which requires a fresh file) works.
    if (fs.existsSync(backupPath)) fs.rmSync(backupPath);
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  } catch (err: unknown) {
    return { verified: false, backupPath, detail: `backup create failed: ${String(err)}` };
  }

  let verifyDb: Database.Database | undefined;
  try {
    verifyDb = new Database(backupPath, { readonly: true });
    const check = runIntegrityCheck(verifyDb);
    if (!check.ok) {
      return { verified: false, backupPath, detail: 'backup failed integrity check' };
    }
    return { verified: true, backupPath };
  } catch (err: unknown) {
    return { verified: false, backupPath, detail: `backup unreadable: ${String(err)}` };
  } finally {
    verifyDb?.close();
  }
}

/** The outcome of a restore attempt. */
export interface RestoreResult {
  readonly ok: boolean;
  readonly restoredPath: string;
  readonly detail?: string;
}

/**
 * Restore a verified backup to `targetPath` atomically: the backup is copied to
 * a sibling temp file, integrity-checked, then renamed into place (an atomic
 * promotion, NN-DATA-005). The source backup is never mutated. Returns
 * `ok: false` with a detail on any failure. The caller reopens the database at
 * `targetPath` after a successful restore.
 */
export function restoreDatabaseBackup(
  backupPath: string,
  targetPath: string,
): RestoreResult {
  if (!fs.existsSync(backupPath)) {
    return { ok: false, restoredPath: targetPath, detail: 'backup file is missing' };
  }
  const tmpPath = `${targetPath}.restore-${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(backupPath, tmpPath);
  } catch (err: unknown) {
    return { ok: false, restoredPath: targetPath, detail: `restore copy failed: ${String(err)}` };
  }

  // Verify the staged copy before promoting it.
  let stagedDb: Database.Database | undefined;
  try {
    stagedDb = new Database(tmpPath, { readonly: true });
    const check = runIntegrityCheck(stagedDb);
    stagedDb.close();
    stagedDb = undefined;
    if (!check.ok) {
      fs.rmSync(tmpPath, { force: true });
      return { ok: false, restoredPath: targetPath, detail: 'staged restore failed integrity check' };
    }
    // Atomic promotion.
    fs.renameSync(tmpPath, targetPath);
    return { ok: true, restoredPath: targetPath };
  } catch (err: unknown) {
    stagedDb?.close();
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    return { ok: false, restoredPath: targetPath, detail: `restore verify failed: ${String(err)}` };
  }
}

// ─── Artifact-reference cleanup (D-08.4 "does not orphan artifact refs") ─────

/**
 * A scan of the relationship between durable artifact REFERENCES (rows in a
 * durable table that point at a content-addressed artifact file) and the
 * artifact FILES on disk. The scan is the input to a cleanup plan and to the
 * orphan/dangling durability assertions.
 */
export interface ArtifactReferenceScan {
  /** Every artifact ref name a live durable row currently points at. */
  readonly referencedArtifacts: readonly string[];
  /** Every artifact file present in the artifact directory. */
  readonly presentArtifacts: readonly string[];
  /**
   * Orphan artifacts: files present on disk that NO durable row references.
   * These are safe to delete (they hold no live business effect).
   */
  readonly orphanArtifacts: readonly string[];
  /**
   * Dangling references: durable rows pointing at an artifact file that is
   * MISSING from disk. A non-empty list is a data-loss signal (a live business
   * effect lost its backing artifact) that MUST block a durable cutover.
   */
  readonly danglingReferences: readonly string[];
}

/**
 * Scan a durable artifact-reference table against an artifact directory. The
 * reference table is read via the caller-provided `readReferences` (which
 * returns the set of artifact names currently referenced by live durable rows)
 * so this module does not assume a specific business schema. `presentArtifacts`
 * is the set of file names in `artifactDir` (non-recursive). Read-only.
 *
 *   - orphan = present on disk but not referenced (safe to prune);
 *   - dangling = referenced but not present on disk (data-loss; blocks cutover).
 */
export function scanArtifactReferences(input: {
  readonly referencedArtifacts: readonly string[];
  readonly artifactDir: string;
}): ArtifactReferenceScan {
  const referenced = new Set(input.referencedArtifacts);
  const present = fs.existsSync(input.artifactDir)
    ? fs
        .readdirSync(input.artifactDir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
    : [];
  const presentSet = new Set(present);

  const orphanArtifacts = present.filter((name) => !referenced.has(name)).sort();
  const danglingReferences = [...referenced]
    .filter((name) => !presentSet.has(name))
    .sort();

  return {
    referencedArtifacts: [...referenced].sort(),
    presentArtifacts: [...present].sort(),
    orphanArtifacts,
    danglingReferences,
  };
}

/** A cleanup plan derived from an artifact scan. */
export interface ArtifactCleanupPlan {
  /** Orphan artifact files that may be safely deleted (no live reference). */
  readonly deletable: readonly string[];
  /** Dangling references that MUST NOT be cleaned and block a cutover. */
  readonly danglingReferences: readonly string[];
  /** True iff cleanup is safe (no dangling references). */
  readonly safe: boolean;
}

/**
 * Plan artifact cleanup from a scan. ONLY orphan artifacts (present but
 * unreferenced) are deletable; a referenced artifact is NEVER proposed for
 * deletion (D-08.4 "does not orphan artifact references"). If any dangling
 * reference exists the plan is `safe: false` and cleanup must not proceed — the
 * missing backing artifact is a data-loss signal for the durability gate.
 */
export function planArtifactCleanup(scan: ArtifactReferenceScan): ArtifactCleanupPlan {
  return {
    deletable: scan.orphanArtifacts,
    danglingReferences: scan.danglingReferences,
    safe: scan.danglingReferences.length === 0,
  };
}

/**
 * Execute an artifact cleanup plan by deleting only the orphan artifact files
 * from `artifactDir`. Refuses to run when the plan is unsafe (dangling
 * references present) so a data-loss condition can never be "cleaned" away.
 * Returns the names actually deleted. Best-effort per file; secure deletion is
 * honestly reported as best-effort per D-08.4.
 */
export function executeArtifactCleanup(
  plan: ArtifactCleanupPlan,
  artifactDir: string,
): { readonly deleted: readonly string[]; readonly refused: boolean } {
  if (!plan.safe) {
    return { deleted: [], refused: true };
  }
  const deleted: string[] = [];
  for (const name of plan.deletable) {
    try {
      fs.rmSync(path.join(artifactDir, name), { force: true });
      deleted.push(name);
    } catch {
      /* best-effort; a failed unlink leaves an orphan, never loses a reference */
    }
  }
  return { deleted, refused: false };
}

// ─── Duplicate / lost business-effect audit (NN-EVENT-003) ───────────────────

/** The outcome of auditing a scope's committed outbox for duplicate/lost effect. */
export interface BusinessEffectAudit {
  readonly scopeKey: string;
  /** The count of committed outbox rows for the scope. */
  readonly eventCount: number;
  /** True iff sequences are strictly 1..N contiguous with no duplicate. */
  readonly contiguous: boolean;
  /** Any sequence numbers that appear more than once (duplicate effect). */
  readonly duplicateSequences: readonly number[];
  /** Any sequence numbers missing from the 1..maxSequence run (lost effect). */
  readonly missingSequences: readonly number[];
}

/**
 * Audit a scope's committed outbox for duplicate or lost business effect. The
 * outbox is the durable authority; its per-scope sequence MUST be a strict
 * 1..N run with no duplicate and no hole (NN-EVENT-003, NN-INV-008). A
 * duplicate or missing sequence is a data-loss/integrity signal for the gate.
 * Read-only.
 */
export function auditBusinessEffect(
  db: Database.Database,
  scope: ScopeDescriptor,
): BusinessEffectAudit {
  const scopeKey = computeScopeKey(scope);
  const rows = db
    .prepare('SELECT sequence FROM outbox WHERE scope_key = ? ORDER BY sequence ASC')
    .all(scopeKey) as { sequence: number }[];
  const sequences = rows.map((r) => r.sequence);
  const seen = new Set<number>();
  const duplicateSequences: number[] = [];
  for (const s of sequences) {
    if (seen.has(s)) duplicateSequences.push(s);
    seen.add(s);
  }
  const maxSequence = sequences.length > 0 ? Math.max(...sequences) : 0;
  const missingSequences: number[] = [];
  for (let s = 1; s <= maxSequence; s++) {
    if (!seen.has(s)) missingSequences.push(s);
  }
  const contiguous =
    duplicateSequences.length === 0 &&
    missingSequences.length === 0 &&
    maxSequence === sequences.length;
  return {
    scopeKey,
    eventCount: sequences.length,
    contiguous,
    duplicateSequences,
    missingSequences,
  };
}

// ─── Durability exit-gate evaluator (the P2 rollup) ──────────────────────────

/** One category of the durability exit gate and its verdict. */
export interface GateFinding {
  readonly invariant:
    | 'no-duplicate-or-lost-business-effect'
    | 'no-protected-event-collapse'
    | 'no-orphan-artifact'
    | 'no-false-current-projection'
    | 'no-unbounded-replay-lag'
    | 'database-integrity'
    | 'backup-restore';
  readonly pass: boolean;
  readonly detail: string;
}

/** The composite durability exit-gate verdict. */
export interface DurabilityGateVerdict {
  /** `pass` iff every invariant holds; `block` on any data-loss/integrity/restore failure. */
  readonly verdict: 'pass' | 'block';
  readonly findings: readonly GateFinding[];
  readonly evaluatedAt: string;
}

/** Inputs the durability gate evaluates for a scope. */
export interface DurabilityGateInput {
  readonly db: Database.Database;
  readonly scope: ScopeDescriptor;
  /** Artifact-reference scan for the orphan/dangling invariant. */
  readonly artifactScan?: ArtifactReferenceScan;
  /** Integrity result to fold into the gate (from {@link runIntegrityCheck}). */
  readonly integrity?: IntegrityResult;
  /** Backup/restore round-trip result to fold in (from a restore rehearsal). */
  readonly restore?: RestoreResult;
  /** Retention policy + pinned set for the protected-collapse audit. */
  readonly retentionPolicyByClass?: Readonly<Record<string, RetentionClassPolicy>>;
  readonly pinnedSequences?: readonly number[];
  /** The maximum tolerated oldest-pending outbox lag in seconds (default 3600). */
  readonly maxLagSeconds?: number;
  readonly now?: () => Date;
}

/**
 * Evaluate the P2 durability exit gate for a scope. Every invariant is checked;
 * the verdict is `block` if ANY of them fails, so a single data-loss / integrity
 * / restore failure blocks P3+ durable cutovers (NN-VERIFY-005). The invariants:
 *
 *   1. no duplicate/lost business effect — the committed outbox is a strict
 *      1..N run ({@link auditBusinessEffect});
 *   2. no protected-event collapse — a retention plan proposes pruning no
 *      protected/pinned event, and every recorded compaction range is still
 *      deterministically replayable from retained source
 *      ({@link auditRetentionProtection}, {@link verifyCompactionReplay});
 *   3. no orphan artifact / no dangling reference — the artifact scan has no
 *      dangling reference (a referenced artifact missing from disk is a
 *      data-loss signal; orphan files are merely deletable, not a failure);
 *   4. no false-current projection — reconciliation surfaces no unreconstructible
 *      gap ({@link reconcile} `releaseBlocked`);
 *   5. no unbounded replay lag — the oldest pending outbox age is within the
 *      configured bound ({@link computeOutboxHealth});
 *   plus database integrity and (when a rehearsal was run) backup/restore.
 */
export function evaluateDurabilityGate(
  input: DurabilityGateInput,
): DurabilityGateVerdict {
  const now = input.now ?? (() => new Date());
  const findings: GateFinding[] = [];

  // 1. No duplicate / lost business effect.
  const effect = auditBusinessEffect(input.db, input.scope);
  findings.push({
    invariant: 'no-duplicate-or-lost-business-effect',
    pass: effect.contiguous,
    detail: effect.contiguous
      ? `outbox is a strict 1..${effect.eventCount} run`
      : `duplicates=[${effect.duplicateSequences.join(',')}] missing=[${effect.missingSequences.join(',')}]`,
  });

  // 2. No protected-event collapse.
  const retentionPlan = planRetention(
    input.db,
    input.scope,
    input.retentionPolicyByClass ?? {},
    { pinnedSequences: input.pinnedSequences, now },
  );
  const protectionViolations = auditRetentionProtection(
    retentionPlan,
    input.pinnedSequences ?? [],
  );
  const replayChecks = verifyCompactionReplay(input.db, input.scope);
  const nonReplayable = replayChecks.filter((c) => !c.replayable);
  const collapseSafe = protectionViolations.length === 0 && nonReplayable.length === 0;
  findings.push({
    invariant: 'no-protected-event-collapse',
    pass: collapseSafe,
    detail: collapseSafe
      ? `no protected/pinned event proposed for prune; ${replayChecks.length} compacted range(s) replayable`
      : `protected-prune=[${protectionViolations.join(',')}] non-replayable-ranges=${nonReplayable.length}`,
  });

  // 3. No orphan artifact (dangling reference is the data-loss condition).
  if (input.artifactScan) {
    const dangling = input.artifactScan.danglingReferences;
    findings.push({
      invariant: 'no-orphan-artifact',
      pass: dangling.length === 0,
      detail:
        dangling.length === 0
          ? `no dangling reference; ${input.artifactScan.orphanArtifacts.length} orphan file(s) deletable`
          : `dangling references (data loss): [${dangling.join(',')}]`,
    });
  }

  // 4. No false-current projection (unreconstructible gap blocks release).
  const reconciliation = reconcile(input.db, { now });
  findings.push({
    invariant: 'no-false-current-projection',
    pass: !reconciliation.releaseBlocked,
    detail: reconciliation.releaseBlocked
      ? `reconciliation found unreconstructible gap(s) in ${reconciliation.findings.filter((f) => f.kind === 'unreconstructible-gap').length} scope(s)`
      : `reconciliation clean across ${reconciliation.scopesChecked} scope(s)`,
  });

  // 5. No unbounded replay lag.
  const maxLagSeconds = input.maxLagSeconds ?? 3600;
  const health = computeOutboxHealth(input.db, now);
  const lagOk = health.oldestPendingAgeSeconds <= maxLagSeconds;
  findings.push({
    invariant: 'no-unbounded-replay-lag',
    pass: lagOk,
    detail: `oldest pending age=${health.oldestPendingAgeSeconds}s (bound ${maxLagSeconds}s); pending=${health.pendingRecords}`,
  });

  // Database integrity (fail-closed).
  if (input.integrity) {
    findings.push({
      invariant: 'database-integrity',
      pass: input.integrity.ok,
      detail: input.integrity.ok
        ? 'integrity_check ok, no fk violations'
        : `integrity failure: ${input.integrity.integrityMessages.join('; ')}`,
    });
  }

  // Backup/restore rehearsal (restoration-tested).
  if (input.restore) {
    findings.push({
      invariant: 'backup-restore',
      pass: input.restore.ok,
      detail: input.restore.ok
        ? 'verified backup restored and integrity-checked'
        : `restore failed: ${input.restore.detail ?? 'unknown'}`,
    });
  }

  const verdict = findings.every((f) => f.pass) ? 'pass' : 'block';
  return { verdict, findings, evaluatedAt: now().toISOString() };
}
