/**
 * SkillMigration — legacy skill state/root migration ledger
 * (FUT-PKG-06-EXECUTION/T-005).
 *
 * D-20 (Skill source/state/roots stream) requires that legacy Markdown bodies,
 * SQLite state, and bundled/project/global paths be migrated ONCE through a
 * ledger:
 *
 *   content-hash inventory → additive state migration → read aliases →
 *   one writer → zero-use retirement.
 *
 * with these fail-safe rules:
 *
 *   - Markdown remains the body authority; install/enable/assignment/provenance
 *     STATE is migrated ADDITIVELY (new canonical rows, no destructive edit of
 *     a legacy table).
 *   - Global skills/packs are copied into the DataRoot with CONTENT-HASH
 *     reconciliation (never last-writer-wins); project skills stay explicit.
 *   - A CONFLICT (the same skill id present with a different content hash in two
 *     legacy roots) PRESERVES BOTH versions and BLOCKS activation of the
 *     conflicted id; it is never silently merged.
 *   - Old roots remain READ-ONLY aliases with telemetry until verified
 *     retirement; ROLLBACK restores a read alias and the prior state revision,
 *     never a second writer.
 *   - The migrated state SURVIVES a restart (V-SKILL-001/root-migration-restart):
 *     the canonical rows and the migration ledger live in durable SQLite, so
 *     re-opening the database re-reads the same migrated state.
 *
 * Migration writes go through the single-writer, idempotent-receipt authority
 * transaction ({@link ../storage/authority-transaction}), so re-running the
 * migration under the same idempotency key REPLAYS — it never double-migrates
 * (NN-INV-007). This module NEVER becomes a second writer for a legacy table;
 * it only READS the legacy inventory and WRITES the canonical additive rows.
 *
 * Design anchors: D-04, D-07 (`SkillManifest@1`), D-20.
 * Requirements: NN-SKILL-001/002, NN-DATA-001/003/011, NN-COMPAT-001/002,
 * NN-INV-006/007/008, CD-008.
 */

import type Database from 'better-sqlite3';

import {
  computeDigest,
  makeOpaqueId,
  serializeContract,
  type ErrorCode,
  type ScopeDescriptor,
} from '../shared/contract-primitives';
import {
  applyAuthorityMutation,
  ensureAuthorityTables,
  type AuthorityMutationResult,
} from '../storage/authority-transaction';
import { compareSemver, formatSemver, type Semver } from './skill-types';

/** The authority id that owns skill STATE and the migration ledger. */
export const SKILL_AUTHORITY_ID = 'authority-skill-catalog';

// ─── Canonical additive tables (NN-COMPAT-001/002) ──────────────────────────

/**
 * The canonical skill STATE + migration ledger tables. All are additive
 * (`IF NOT EXISTS`); none replaces a legacy table. `skill_state` is the
 * migrated install/enable/version/provenance projection; `skill_migration_ledger`
 * records each migrated legacy source with its content hash and read-alias
 * status; `skill_migration_conflict` preserves BOTH sides of a conflicted id.
 */
const SKILL_STATE_DDL = `
  CREATE TABLE IF NOT EXISTS skill_state (
    skill_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    source TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    version_major INTEGER NOT NULL,
    version_minor INTEGER NOT NULL,
    version_patch INTEGER NOT NULL,
    status TEXT NOT NULL,
    record_json TEXT NOT NULL,
    catalog_revision INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS skill_migration_ledger (
    ledger_id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    legacy_root TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    version_major INTEGER NOT NULL,
    version_minor INTEGER NOT NULL,
    version_patch INTEGER NOT NULL,
    read_alias_active INTEGER NOT NULL,
    retired INTEGER NOT NULL,
    migrated_at TEXT NOT NULL,
    UNIQUE (skill_id, legacy_root)
  );

  CREATE TABLE IF NOT EXISTS skill_migration_conflict (
    conflict_id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    legacy_root TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    detail TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_skill_state_scope ON skill_state (scope);
  CREATE INDEX IF NOT EXISTS idx_skill_state_status ON skill_state (status);
  CREATE INDEX IF NOT EXISTS idx_skill_migration_ledger_skill
    ON skill_migration_ledger (skill_id);
  CREATE INDEX IF NOT EXISTS idx_skill_migration_conflict_skill
    ON skill_migration_conflict (skill_id);
`;

/** Create the canonical skill state + migration ledger tables (idempotent). */
export function ensureSkillStateTables(db: Database.Database): void {
  ensureAuthorityTables(db);
  db.exec(SKILL_STATE_DDL);
}

// ─── Typed outcomes ──────────────────────────────────────────────────────────

/** A typed migration failure (secret-free). */
export interface SkillMigrationError {
  readonly code: ErrorCode;
  readonly message: string;
}

export type SkillMigrationOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly replayed: boolean }
  | { readonly ok: false; readonly error: SkillMigrationError };

function mapResult<T>(result: AuthorityMutationResult, value: T): SkillMigrationOutcome<T> {
  if (result.kind === 'conflict') {
    return { ok: false, error: { code: result.error.code, message: result.error.message } };
  }
  return { ok: true, value, replayed: result.kind === 'replayed' };
}

// ─── Legacy inventory (content-hash inventory step) ─────────────────────────

/**
 * One discovered legacy skill record: its id, the legacy root it lives under,
 * its Markdown content hash, its semver, and whether it was enabled in the
 * legacy store. Content hash + semver are the reconciliation keys (never
 * last-writer-wins). `legacyRoot` is a read-only alias path.
 */
export interface LegacyInventoryEntry {
  readonly skillId: string;
  readonly legacyRoot: string;
  readonly scope: 'global' | 'project';
  readonly source: string;
  readonly contentHash: string;
  readonly version: Semver;
  readonly enabled: boolean;
}

/** A migrated canonical state row (the additive projection). */
export interface MigratedSkillState {
  readonly skillId: string;
  readonly scope: 'global' | 'project';
  readonly source: string;
  readonly contentHash: string;
  readonly version: Semver;
  /** `enabled`, `installed`, or `blocked` (a conflicted id is blocked). */
  readonly status: 'installed' | 'enabled' | 'blocked';
}

/** A recorded conflict: both sides preserved, activation blocked. */
export interface MigrationConflict {
  readonly skillId: string;
  readonly legacyRoot: string;
  readonly contentHash: string;
  readonly detail: string;
}

/** The result of a migration pass. */
export interface MigrationResult {
  /** The canonical state rows written (one per unique, non-conflicted id). */
  readonly migrated: readonly MigratedSkillState[];
  /** The conflicted ids (both legacy versions preserved, activation blocked). */
  readonly conflicts: readonly MigrationConflict[];
  /** The legacy roots recorded as read-only aliases. */
  readonly readAliases: readonly string[];
}

/** Input to {@link migrateLegacySkills}. */
export interface MigrationInput {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly scope: ScopeDescriptor;
  /** The dynamically discovered legacy inventory (read-only). */
  readonly inventory: readonly LegacyInventoryEntry[];
  readonly now?: () => Date;
}

// ─── Migration pass (content-hash inventory → additive state → aliases) ─────

/**
 * Migrate the legacy skill inventory ONCE, additively (D-20). The pass:
 *
 *   1. groups the inventory by `skillId` (the content-hash inventory step);
 *   2. detects a CONFLICT — the same id present in more than one legacy root
 *      with DIFFERENT content hashes — and PRESERVES BOTH versions in the
 *      conflict table while marking that id `blocked` (never a silent merge,
 *      never last-writer-wins);
 *   3. for a non-conflicted id, reconciles duplicate roots that share the SAME
 *      content hash by choosing the highest semver deterministically and writes
 *      ONE additive `skill_state` row (`enabled` iff any legacy copy was
 *      enabled);
 *   4. records EVERY legacy root as a READ-ONLY alias in the ledger with
 *      telemetry (`read_alias_active = 1`, `retired = 0`);
 *   5. commits atomically through the single-writer authority transaction,
 *      bumping the catalog revision.
 *
 * Re-running under the same idempotency key REPLAYS the prior receipt — the
 * migration runs ONCE (NN-INV-007). The migrated rows and ledger are durable
 * SQLite, so the state SURVIVES a restart (close/reopen), which is the
 * V-SKILL-001/root-migration-restart property. This function never writes to a
 * legacy table and never mutates the input.
 */
export function migrateLegacySkills(
  db: Database.Database,
  input: MigrationInput,
): SkillMigrationOutcome<MigrationResult> {
  const now = (input.now ?? (() => new Date()))().toISOString();

  // Step 1: group by skill id.
  const byId = new Map<string, LegacyInventoryEntry[]>();
  for (const entry of input.inventory) {
    const list = byId.get(entry.skillId) ?? [];
    list.push(entry);
    byId.set(entry.skillId, list);
  }

  const migrated: MigratedSkillState[] = [];
  const conflicts: MigrationConflict[] = [];
  const readAliases = new Set<string>();

  for (const [skillId, entries] of byId) {
    for (const e of entries) readAliases.add(e.legacyRoot);

    const distinctHashes = new Set(entries.map((e) => e.contentHash));
    if (distinctHashes.size > 1) {
      // Step 2: CONFLICT — preserve BOTH sides, block activation of this id.
      for (const e of entries) {
        conflicts.push({
          skillId,
          legacyRoot: e.legacyRoot,
          contentHash: e.contentHash,
          detail: `skill ${skillId} has divergent content across legacy roots; both preserved`,
        });
      }
      // A single blocked state row records the id as unloadable pending review.
      const highest = pickHighestVersion(entries);
      migrated.push({
        skillId,
        scope: highest.scope,
        source: highest.source,
        contentHash: highest.contentHash,
        version: highest.version,
        status: 'blocked',
      });
      continue;
    }

    // Step 3: reconcile same-hash duplicates by highest semver; enabled iff any.
    const chosen = pickHighestVersion(entries);
    const anyEnabled = entries.some((e) => e.enabled);
    migrated.push({
      skillId,
      scope: chosen.scope,
      source: chosen.source,
      contentHash: chosen.contentHash,
      version: chosen.version,
      status: anyEnabled ? 'enabled' : 'installed',
    });
  }

  const requestDigest = computeDigest({
    op: 'migrate-legacy-skills',
    migrated: migrated.map((m) => `${m.skillId}:${m.contentHash}:${m.status}`).sort(),
    conflicts: conflicts.map((c) => `${c.skillId}:${c.contentHash}`).sort(),
  });

  const result = applyAuthorityMutation(db, {
    authority: SKILL_AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest,
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      const revisionRow = tx
        .prepare('SELECT revision FROM authority_revisions WHERE authority = ?')
        .get(SKILL_AUTHORITY_ID) as { revision: number } | undefined;
      const nextRevision = (revisionRow?.revision ?? 0) + 1;

      for (const state of migrated) {
        const record = {
          skillId: state.skillId,
          scope: state.scope,
          source: state.source,
          contentHash: state.contentHash,
          version: state.version,
          status: state.status,
          catalogRevision: nextRevision,
        };
        tx.prepare(
          `INSERT INTO skill_state
             (skill_id, scope, source, content_hash, version_major, version_minor,
              version_patch, status, record_json, catalog_revision)
           VALUES (@skillId, @scope, @source, @contentHash, @vMajor, @vMinor, @vPatch,
              @status, @recordJson, @catalogRevision)
           ON CONFLICT(skill_id) DO UPDATE SET
             scope = excluded.scope, source = excluded.source,
             content_hash = excluded.content_hash,
             version_major = excluded.version_major,
             version_minor = excluded.version_minor,
             version_patch = excluded.version_patch,
             status = excluded.status, record_json = excluded.record_json,
             catalog_revision = excluded.catalog_revision`,
        ).run({
          skillId: state.skillId,
          scope: state.scope,
          source: state.source,
          contentHash: state.contentHash,
          vMajor: state.version.major,
          vMinor: state.version.minor,
          vPatch: state.version.patch,
          status: state.status,
          recordJson: serializeContract(record),
          catalogRevision: nextRevision,
        });
      }

      // Step 4: record read-only aliases with telemetry.
      for (const entry of input.inventory) {
        const ledgerId = makeOpaqueId('sklg', `${entry.skillId}${entry.legacyRoot}`);
        tx.prepare(
          `INSERT INTO skill_migration_ledger
             (ledger_id, skill_id, legacy_root, content_hash, version_major,
              version_minor, version_patch, read_alias_active, retired, migrated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?)
           ON CONFLICT(skill_id, legacy_root) DO NOTHING`,
        ).run(
          ledgerId,
          entry.skillId,
          entry.legacyRoot,
          entry.contentHash,
          entry.version.major,
          entry.version.minor,
          entry.version.patch,
          now,
        );
      }

      for (const c of conflicts) {
        const conflictId = makeOpaqueId('skcf', `${c.skillId}${c.legacyRoot}`);
        tx.prepare(
          `INSERT INTO skill_migration_conflict
             (conflict_id, skill_id, legacy_root, content_hash, detail, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(conflictId, c.skillId, c.legacyRoot, c.contentHash, c.detail, now);
      }

      return { resultRef: makeOpaqueId('skmg', input.commandId) };
    },
    events: [
      {
        eventType: 'skill-catalog.migrated',
        aggregateType: 'skill-catalog',
        aggregateId: 'skill-catalog',
        payloadSchemaName: 'SkillMigration',
        payloadSchemaVersion: 1,
        payload: {
          migratedCount: migrated.length,
          conflictCount: conflicts.length,
          aliasCount: readAliases.size,
        },
        redaction: 'internal',
      },
    ],
  });

  return mapResult(result, {
    migrated,
    conflicts,
    readAliases: [...readAliases].sort(),
  });
}

/** Deterministically pick the highest-semver entry (ties: first by root). */
function pickHighestVersion(
  entries: readonly LegacyInventoryEntry[],
): LegacyInventoryEntry {
  return [...entries].sort((a, b) => {
    const v = compareSemver(b.version, a.version);
    if (v !== 0) return v;
    return a.legacyRoot < b.legacyRoot ? -1 : a.legacyRoot > b.legacyRoot ? 1 : 0;
  })[0];
}

// ─── Read models (survive restart) ──────────────────────────────────────────

/** Read every migrated canonical state row, ordered by skill id. */
export function readMigratedState(db: Database.Database): MigratedSkillState[] {
  const rows = db
    .prepare('SELECT record_json FROM skill_state ORDER BY skill_id')
    .all() as { record_json: string }[];
  return rows.map((r) => {
    const rec = JSON.parse(r.record_json) as MigratedSkillState & {
      catalogRevision: number;
    };
    return {
      skillId: rec.skillId,
      scope: rec.scope,
      source: rec.source,
      contentHash: rec.contentHash,
      version: rec.version,
      status: rec.status,
    };
  });
}

/** Read the migrated state for one skill id (or `undefined`). */
export function readMigratedSkill(
  db: Database.Database,
  skillId: string,
): MigratedSkillState | undefined {
  return readMigratedState(db).find((s) => s.skillId === skillId);
}

/** A ledger read-alias entry. */
export interface LedgerAlias {
  readonly skillId: string;
  readonly legacyRoot: string;
  readonly contentHash: string;
  readonly readAliasActive: boolean;
  readonly retired: boolean;
}

/** Read the migration ledger (read-alias telemetry). */
export function readMigrationLedger(db: Database.Database): LedgerAlias[] {
  const rows = db
    .prepare(
      `SELECT skill_id AS skillId, legacy_root AS legacyRoot, content_hash AS contentHash,
              read_alias_active AS readAliasActive, retired AS retired
       FROM skill_migration_ledger ORDER BY ledger_id`,
    )
    .all() as {
    skillId: string;
    legacyRoot: string;
    contentHash: string;
    readAliasActive: number;
    retired: number;
  }[];
  return rows.map((r) => ({
    skillId: r.skillId,
    legacyRoot: r.legacyRoot,
    contentHash: r.contentHash,
    readAliasActive: r.readAliasActive === 1,
    retired: r.retired === 1,
  }));
}

/** Read the preserved conflicts (both sides). */
export function readMigrationConflicts(db: Database.Database): MigrationConflict[] {
  const rows = db
    .prepare(
      `SELECT skill_id AS skillId, legacy_root AS legacyRoot, content_hash AS contentHash,
              detail
       FROM skill_migration_conflict ORDER BY conflict_id`,
    )
    .all() as {
    skillId: string;
    legacyRoot: string;
    contentHash: string;
    detail: string;
  }[];
  return rows.map((r) => ({
    skillId: r.skillId,
    legacyRoot: r.legacyRoot,
    contentHash: r.contentHash,
    detail: r.detail,
  }));
}

/** Whether a skill id is under an unresolved migration conflict (blocked). */
export function isConflicted(db: Database.Database, skillId: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM skill_migration_conflict WHERE skill_id = ? LIMIT 1')
    .get(skillId);
  return row !== undefined;
}

// ─── Rollback (restore read alias / prior state revision) ───────────────────

/** Input to {@link rollbackMigratedSkill}. */
export interface RollbackInput {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly scope: ScopeDescriptor;
  readonly skillId: string;
  readonly now?: () => Date;
}

/**
 * Roll back a migrated skill: remove its canonical state row and REACTIVATE its
 * read aliases in the ledger (D-20 "rollback restores a read alias and prior
 * state revision, not a second writer"). The legacy body is never mutated; the
 * read alias simply becomes the active reader again. Idempotent through the
 * authority transaction. This never deletes a legacy body and never introduces
 * a second writer.
 */
export function rollbackMigratedSkill(
  db: Database.Database,
  input: RollbackInput,
): SkillMigrationOutcome<{ readonly restoredAliases: number }> {
  const result = applyAuthorityMutation(db, {
    authority: SKILL_AUTHORITY_ID,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    requestDigest: computeDigest({ op: 'rollback-skill', skillId: input.skillId }),
    correlationId: input.correlationId,
    scope: input.scope,
    ...(input.now ? { now: input.now } : {}),
    mutate: (tx) => {
      tx.prepare('DELETE FROM skill_state WHERE skill_id = ?').run(input.skillId);
      const info = tx
        .prepare(
          `UPDATE skill_migration_ledger SET read_alias_active = 1, retired = 0
           WHERE skill_id = ?`,
        )
        .run(input.skillId);
      return { resultRef: makeOpaqueId('skrb', input.commandId), restored: info.changes };
    },
    events: [
      {
        eventType: 'skill-catalog.rolled-back',
        aggregateType: 'skill-catalog',
        aggregateId: input.skillId,
        payloadSchemaName: 'SkillRollback',
        payloadSchemaVersion: 1,
        payload: { skillId: input.skillId },
        redaction: 'internal',
      },
    ],
  });

  if (result.kind === 'conflict') {
    return { ok: false, error: { code: result.error.code, message: result.error.message } };
  }
  const restoredAliases = readMigrationLedger(db).filter(
    (a) => a.skillId === input.skillId && a.readAliasActive,
  ).length;
  return { ok: true, value: { restoredAliases }, replayed: result.kind === 'replayed' };
}

/** A human-safe summary of a conflict for audit (no private paths beyond root refs). */
export function summarizeConflict(conflict: MigrationConflict, version: Semver): string {
  return `${conflict.skillId}@${formatSemver(version)} conflicted at ${conflict.legacyRoot}`;
}
